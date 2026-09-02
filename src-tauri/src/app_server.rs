use crate::diagnostics::{error_code, DiagnosticLog};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::{mpsc, oneshot, Mutex},
    time::timeout,
};
use tokio_tungstenite::{client_async, tungstenite::Message};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInfo {
    status: String,
    socket_path: Option<String>,
    #[serde(default)]
    app_server_version: Option<String>,
    #[serde(default)]
    managed_codex_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersions {
    pub harness: String,
    pub app_server: Option<String>,
    pub codex_cli: Option<String>,
}

#[derive(Debug)]
pub(crate) struct CodexCommandSummary {
    pub exit_code: Option<i32>,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
}

#[derive(Clone)]
struct Connection {
    outgoing: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    alive: Arc<AtomicBool>,
    intentional_disconnect: Arc<AtomicBool>,
}

pub struct AppServerManager {
    app: AppHandle,
    diagnostics: Arc<DiagnosticLog>,
    connection: Mutex<Option<Connection>>,
    next_request_id: AtomicU64,
}

impl AppServerManager {
    pub fn new(app: AppHandle, diagnostics: Arc<DiagnosticLog>) -> Self {
        Self {
            app,
            diagnostics,
            connection: Mutex::new(None),
            next_request_id: AtomicU64::new(1),
        }
    }

    pub async fn request(&self, method: String, params: Value) -> Result<Value, String> {
        let started = Instant::now();
        let request_context = request_context(&params);
        self.diagnostics.record(
            "info",
            "app-server",
            "request.started",
            json!({ "method": &method, "requestMeta": request_context.clone() }),
        );
        let result = match self.connection().await {
            Ok(connection) => self.send_request(&connection, method.clone(), params).await,
            Err(error) => Err(error),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(response) => self.diagnostics.record(
                "info",
                "app-server",
                "request.completed",
                json!({
                    "method": method,
                    "durationMs": duration_ms,
                    "requestMeta": request_context,
                    // Keep the safe, low-cardinality result metadata under a
                    // non-sensitive key so the sanitizer does not redact it
                    // wholesale along with arbitrary response bodies.
                    "resultMeta": result_context(response),
                }),
            ),
            Err(error) => self.diagnostics.record(
                "error",
                "app-server",
                "request.failed",
                json!({
                    "method": method,
                    "durationMs": duration_ms,
                    "requestMeta": request_context,
                    "errorCode": error_code(error),
                }),
            ),
        }
        result
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let connection = self.connection().await?;
        self.send_frame(&connection, json!({ "id": id, "result": result }))
            .await
    }

    pub(crate) async fn restart_after_update(&self) -> Result<(), String> {
        let previous = self.connection.lock().await.take();
        if let Some(connection) = previous {
            connection.alive.store(false, Ordering::Relaxed);
            connection
                .intentional_disconnect
                .store(true, Ordering::Relaxed);
        }

        tauri::async_runtime::spawn_blocking(restart_daemon)
            .await
            .map_err(|error| format!("等待 Codex App Server 重启任务失败: {error}"))??;

        self.emit_update_stage("reconnect");
        self.connection().await.map(|_| ())
    }

    pub(crate) fn emit_update_stage(&self, stage: &str) {
        let _ = self.app.emit("codex-update:progress", stage);
    }

    async fn connection(&self) -> Result<Connection, String> {
        let mut guard = self.connection.lock().await;
        if let Some(connection) = guard.as_ref() {
            if connection.alive.load(Ordering::Relaxed) {
                return Ok(connection.clone());
            }
        }

        self.diagnostics
            .record("info", "app-server", "connection.opening", json!({}));
        let socket_path = match ensure_daemon() {
            Ok(socket_path) => socket_path,
            Err(error) => {
                self.diagnostics.record(
                    "error",
                    "app-server",
                    "connection.failed",
                    json!({ "errorCode": error_code(&error) }),
                );
                return Err(error);
            }
        };
        let stream = match UnixStream::connect(&socket_path).await {
            Ok(stream) => stream,
            Err(error) => {
                let error = format!("无法连接 Codex App Server ({socket_path}): {error}");
                self.diagnostics.record(
                    "error",
                    "app-server",
                    "connection.failed",
                    json!({ "errorCode": error_code(&error) }),
                );
                return Err(error);
            }
        };
        let (socket, _) = match client_async("ws://localhost/", stream).await {
            Ok(socket) => socket,
            Err(error) => {
                let error = format!("无法建立 Codex App Server WebSocket 连接: {error}");
                self.diagnostics.record(
                    "error",
                    "app-server",
                    "connection.failed",
                    json!({ "errorCode": error_code(&error) }),
                );
                return Err(error);
            }
        };
        let connection = self.attach(socket);

        let initialize = json!({
            "clientInfo": {
                "name": "codex-harness",
                "title": "Codex Harness",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false
            }
        });
        self.send_request(&connection, "initialize".to_string(), initialize)
            .await?;
        self.send_frame(&connection, json!({ "method": "initialized" }))
            .await?;
        *guard = Some(connection.clone());
        self.diagnostics
            .record("info", "app-server", "connection.opened", json!({}));
        Ok(connection)
    }

    fn attach(&self, socket: tokio_tungstenite::WebSocketStream<UnixStream>) -> Connection {
        let (mut writer, mut reader) = socket.split();
        let (outgoing, mut outbound) = mpsc::channel::<String>(128);
        let pending = Arc::new(Mutex::new(HashMap::<
            u64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));
        let reader_pending = pending.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let writer_alive = alive.clone();
        let reader_alive = alive.clone();
        let intentional_disconnect = Arc::new(AtomicBool::new(false));
        let reader_intentional_disconnect = intentional_disconnect.clone();
        let app = self.app.clone();
        let writer_diagnostics = self.diagnostics.clone();
        let reader_diagnostics = self.diagnostics.clone();

        tauri::async_runtime::spawn(async move {
            while let Some(frame) = outbound.recv().await {
                if writer.send(Message::Text(frame.into())).await.is_err() {
                    writer_alive.store(false, Ordering::Relaxed);
                    writer_diagnostics.record(
                        "error",
                        "app-server",
                        "connection.writer_closed",
                        json!({ "errorCode": "connection_failed" }),
                    );
                    break;
                }
            }
        });

        tauri::async_runtime::spawn(async move {
            let mut disconnect_message: Option<String> = None;
            while let Some(next) = reader.next().await {
                match next {
                    Ok(Message::Text(text)) => match serde_json::from_str::<Value>(&text) {
                        Ok(payload) => {
                            let is_response = payload.get("method").is_none()
                                && payload.get("id").and_then(Value::as_u64).is_some();
                            if is_response {
                                let id = payload
                                    .get("id")
                                    .and_then(Value::as_u64)
                                    .unwrap_or_default();
                                let sender = reader_pending.lock().await.remove(&id);
                                if let Some(sender) = sender {
                                    let response = if let Some(error) = payload.get("error") {
                                        Err(describe_error(error))
                                    } else {
                                        Ok(payload.get("result").cloned().unwrap_or(Value::Null))
                                    };
                                    let _ = sender.send(response);
                                }
                            } else {
                                let method = payload.get("method").and_then(Value::as_str);
                                let params = payload.get("params").unwrap_or(&Value::Null);
                                let thread_id = params
                                    .as_object()
                                    .and_then(|params| params.get("threadId"))
                                    .and_then(Value::as_str);
                                if method == Some("thread/tokenUsage/updated") {
                                    if let Some(usage) =
                                        token_usage_context(params.get("tokenUsage"))
                                    {
                                        reader_diagnostics.record(
                                            "info",
                                            "codex-usage",
                                            "usage.updated",
                                            json!({
                                                "threadId": thread_id,
                                                "turnId": params.get("turnId"),
                                                "usage": usage,
                                            }),
                                        );
                                    }
                                } else if should_persist_notification(method) {
                                    reader_diagnostics.record(
                                        "info",
                                        "app-server",
                                        "notification.received",
                                        json!({
                                            "method": method,
                                            "threadId": thread_id,
                                            "requestMeta": request_context(params),
                                        }),
                                    );
                                }
                                let _ = app.emit("app-server:event", payload);
                            }
                        }
                        Err(error) => {
                            reader_diagnostics.record(
                                "error",
                                "app-server",
                                "notification.invalid",
                                json!({ "errorCode": error_code(&error.to_string()) }),
                            );
                            let _ = app.emit(
                                "app-server:transport",
                                json!({
                                    "kind": "invalid-message",
                                    "message": format!("无法解析 App Server 消息: {error}")
                                }),
                            );
                        }
                    },
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(error) => {
                        reader_diagnostics.record(
                            "error",
                            "app-server",
                            "connection.disconnected",
                            json!({ "errorCode": error_code(&error.to_string()) }),
                        );
                        disconnect_message = Some(format!("Codex App Server 连接已断开: {error}"));
                        break;
                    }
                }
            }

            reader_alive.store(false, Ordering::Relaxed);
            reader_diagnostics.record("info", "app-server", "connection.closed", json!({}));
            let mut waiters = reader_pending.lock().await;
            for (_, sender) in waiters.drain() {
                let _ = sender.send(Err("Codex App Server 连接已关闭。请重试。".to_string()));
            }
            if !reader_intentional_disconnect.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "app-server:transport",
                    json!({
                        "kind": "disconnected",
                        "message": disconnect_message.unwrap_or_else(|| "Codex App Server 连接已关闭。".to_string())
                    }),
                );
            }
        });

        Connection {
            outgoing,
            pending,
            alive,
            intentional_disconnect,
        }
    }

    async fn send_request(
        &self,
        connection: &Connection,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        connection.pending.lock().await.insert(id, sender);
        let frame = json!({ "id": id, "method": method, "params": params });
        if let Err(error) = self.send_frame(connection, frame).await {
            connection.pending.lock().await.remove(&id);
            return Err(error);
        }
        match timeout(Duration::from_secs(90), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex App Server 在返回结果前断开连接。".to_string()),
            Err(_) => {
                connection.pending.lock().await.remove(&id);
                Err("Codex App Server 请求超时。".to_string())
            }
        }
    }

    async fn send_frame(&self, connection: &Connection, frame: Value) -> Result<(), String> {
        connection
            .outgoing
            .send(frame.to_string())
            .await
            .map_err(|_| "Codex App Server 连接已关闭。请重试。".to_string())
    }
}

fn ensure_daemon() -> Result<String, String> {
    let codex = find_codex_binary()?;
    if let Ok(info) = daemon_info(&codex) {
        if info.status == "running" {
            if let Some(socket_path) = info.socket_path {
                return Ok(socket_path);
            }
        }
    }

    let mut command = codex_command(&codex);
    command.args(["app-server", "daemon", "start"]);
    raise_open_file_limit(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("无法启动 Codex App Server: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法启动 Codex App Server: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    for _ in 0..16 {
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(info) = daemon_info(&codex) {
            if info.status == "running" {
                if let Some(socket_path) = info.socket_path {
                    return Ok(socket_path);
                }
            }
        }
    }
    Err("Codex App Server 启动后没有暴露可用的本地 socket。".to_string())
}

pub fn runtime_versions() -> RuntimeVersions {
    let codex = find_codex_binary().ok();
    let app_server = codex.as_ref().and_then(|path| {
        daemon_info(path)
            .ok()
            .and_then(|info| info.app_server_version.or(info.managed_codex_version))
    });
    let codex_cli = codex.as_ref().and_then(|path| cli_version(path).ok());

    RuntimeVersions {
        harness: env!("CARGO_PKG_VERSION").to_owned(),
        app_server,
        codex_cli,
    }
}

pub(crate) fn codex_binary_paths() -> (Option<String>, Option<String>) {
    let selected = find_codex_binary().ok();
    let resolved = selected
        .as_ref()
        .and_then(|path| fs::canonicalize(path).ok());
    (
        selected.map(|path| path.display().to_string()),
        resolved.map(|path| path.display().to_string()),
    )
}

pub(crate) fn update_codex_cli() -> Result<CodexCommandSummary, String> {
    let codex = find_codex_binary()?;
    let output = codex_command(&codex)
        .arg("update")
        .output()
        .map_err(|error| format!("无法运行 Codex CLI 更新: {error}"))?;
    let summary = CodexCommandSummary {
        exit_code: output.status.code(),
        stdout_bytes: output.stdout.len(),
        stderr_bytes: output.stderr.len(),
    };
    if !output.status.success() {
        return Err(format!(
            "Codex CLI 更新失败: {}",
            command_error_detail(&output.stderr, &output.stdout)
        ));
    }
    Ok(summary)
}

fn restart_daemon() -> Result<(), String> {
    let codex = find_codex_binary()?;
    let first_error = match run_daemon_restart(&codex) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if !is_unmanaged_daemon_error(&first_error) {
        return Err(first_error);
    }

    let pid =
        unmanaged_app_server_pid(&codex).map_err(|error| format!("{first_error}。{error}"))?;
    terminate_unmanaged_app_server(pid)?;
    run_daemon_restart(&codex)
}

fn run_daemon_restart(codex: &Path) -> Result<(), String> {
    let mut command = codex_command(&codex);
    command.args(["app-server", "daemon", "restart"]);
    raise_open_file_limit(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("无法重启 Codex App Server: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法重启 Codex App Server: {}",
            command_error_detail(&output.stderr, &output.stdout)
        ));
    }
    Ok(())
}

fn is_unmanaged_daemon_error(error: &str) -> bool {
    error.contains("app server is running but is not managed by codex app-server daemon")
}

#[cfg(target_os = "macos")]
fn unmanaged_app_server_pid(codex: &Path) -> Result<u32, String> {
    use std::os::fd::AsRawFd;

    let socket_path = daemon_info(codex)?
        .socket_path
        .ok_or_else(|| "无法确认现有 App Server 的 socket。".to_string())?;
    let stream = std::os::unix::net::UnixStream::connect(&socket_path)
        .map_err(|error| format!("无法连接现有 App Server ({socket_path}): {error}"))?;
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    };
    if result != 0 || pid <= 1 {
        return Err("无法确认现有 App Server 进程，未执行自动接管。".to_string());
    }
    Ok(pid as u32)
}

#[cfg(not(target_os = "macos"))]
fn unmanaged_app_server_pid(_codex: &Path) -> Result<u32, String> {
    Err("当前平台不支持自动接管非 daemon 管理的 App Server。".to_string())
}

#[cfg(unix)]
fn terminate_unmanaged_app_server(pid: u32) -> Result<(), String> {
    let pid = pid as libc::pid_t;
    if pid <= 1 || pid == std::process::id() as libc::pid_t {
        return Err("拒绝终止无法确认的 App Server 进程。".to_string());
    }
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(format!(
            "无法停止非 daemon 管理的 App Server (PID {pid}): {}",
            std::io::Error::last_os_error()
        ));
    }
    for _ in 0..50 {
        if !process_is_running(pid) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 && process_is_running(pid) {
        return Err(format!(
            "非 daemon 管理的 App Server (PID {pid}) 未能退出: {}",
            std::io::Error::last_os_error()
        ));
    }
    for _ in 0..20 {
        if !process_is_running(pid) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "非 daemon 管理的 App Server (PID {pid}) 未能退出。"
    ))
}

#[cfg(unix)]
fn process_is_running(pid: libc::pid_t) -> bool {
    (unsafe { libc::kill(pid, 0) == 0 })
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn terminate_unmanaged_app_server(_pid: u32) -> Result<(), String> {
    Err("当前平台不支持自动接管非 daemon 管理的 App Server。".to_string())
}

fn daemon_info(codex: &Path) -> Result<DaemonInfo, String> {
    let output = codex_command(codex)
        .args(["app-server", "daemon", "version"])
        .output()
        .map_err(|error| format!("无法检查 Codex App Server: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Codex App Server 返回了无效状态: {error}"))
}

fn cli_version(codex: &Path) -> Result<String, String> {
    let output = codex_command(codex)
        .arg("--version")
        .output()
        .map_err(|error| format!("无法读取 Codex CLI 版本: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    parse_cli_version(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "Codex CLI 未返回版本号。".to_string())
}

fn parse_cli_version(output: &str) -> Option<String> {
    output.split_whitespace().last().map(ToOwned::to_owned)
}

fn command_error_detail(stderr: &[u8], stdout: &[u8]) -> String {
    let detail = if stderr.is_empty() { stdout } else { stderr };
    let detail = String::from_utf8_lossy(detail);
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        return "命令没有返回错误详情".to_string();
    }
    trimmed.chars().take(1200).collect()
}

fn codex_command(codex: &Path) -> Command {
    let mut command = Command::new(codex);
    if let Some(codex_home) = managed_codex_home(codex) {
        if let Some(home) = codex_home.parent() {
            command.env("HOME", home);
        }
        command.env("CODEX_HOME", codex_home);
    }
    command
}

fn managed_codex_home(codex: &Path) -> Option<PathBuf> {
    fs::canonicalize(codex)
        .ok()
        .and_then(|path| codex_home_ancestor(&path))
        .or_else(|| codex_home_ancestor(codex))
        .or_else(|| {
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .filter(|path| path.file_name().is_some_and(|name| name == ".codex"))
        })
        .or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".codex"))
        })
}

pub(crate) fn resolved_codex_home() -> Result<PathBuf, String> {
    let codex = find_codex_binary()?;
    managed_codex_home(&codex).ok_or_else(|| "无法确定真实 Codex Home。".to_string())
}

pub(crate) async fn read_rate_limits_for_home(codex_home: &Path) -> Result<Value, String> {
    let codex = find_codex_binary()?;
    let real_home = codex_home
        .parent()
        .ok_or_else(|| "Codex Home 缺少用户目录。".to_string())?;
    let mut child = tokio::process::Command::new(codex)
        .args(["app-server", "--stdio"])
        .env("HOME", real_home)
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法启动 Codex Personal App Server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex Personal App Server 没有 stdin。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex Personal App Server 没有 stdout。".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    write_stdio_request(
        &mut stdin,
        1,
        "initialize",
        json!({
            "clientInfo": {
                "name": "codex-harness-usage",
                "title": "Codex Harness Usage",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false
            }
        }),
    )
    .await?;
    read_stdio_response(&mut lines, 1).await?;
    write_stdio_request(&mut stdin, 2, "account/rateLimits/read", json!({})).await?;
    let result = read_stdio_response(&mut lines, 2).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn write_stdio_request(
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let line = json!({ "id": id, "method": method, "params": params }).to_string();
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .await
        .map_err(|error| format!("无法写入 Codex Personal App Server: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("无法刷新 Codex Personal App Server 请求: {error}"))
}

async fn read_stdio_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    target_id: u64,
) -> Result<Value, String> {
    timeout(Duration::from_secs(20), async {
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| format!("无法读取 Codex Personal App Server: {error}"))?
        {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(Value::as_u64) != Some(target_id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("Codex Personal App Server 请求失败: {error}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex Personal App Server 响应缺少 result。".to_string());
        }
        Err("Codex Personal App Server 提前退出。".to_string())
    })
    .await
    .map_err(|_| "Codex Personal App Server 请求超时。".to_string())?
}

fn codex_home_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.file_name().is_some_and(|name| name == ".codex"))
        .map(Path::to_path_buf)
}

#[cfg(unix)]
fn raise_open_file_limit(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // The daemon inherits this limit from the short-lived `daemon start` process.
    unsafe {
        command.pre_exec(|| {
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            limit.rlim_cur = limit.rlim_max.min(4096);
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn raise_open_file_limit(_command: &mut Command) {}

fn find_codex_binary() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CODEX_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Some(codex_home) = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.file_name().is_some_and(|name| name == ".codex"))
    {
        let candidate = codex_home.join("packages/standalone/current/codex");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let home = env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = home {
        for candidate in [
            home.join(".local/bin/codex"),
            home.join(".codex/packages/standalone/current/codex"),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let output = Command::new("which")
        .arg("codex")
        .output()
        .map_err(|error| format!("找不到 Codex CLI: {error}"))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    Err("找不到 Codex CLI。请先安装 Codex，或设置 CODEX_HARNESS_CODEX_PATH。".to_string())
}

fn request_context(value: &Value) -> Option<Value> {
    let mut context = Map::new();
    copy_string(&mut context, "threadId", value.get("threadId"));
    copy_string(&mut context, "cwd", value.get("cwd"));
    copy_string(&mut context, "model", value.get("model"));
    copy_string(
        &mut context,
        "effort",
        value.get("effort").or_else(|| value.get("reasoningEffort")),
    );
    copy_string(&mut context, "turnTrigger", value.get("turnTrigger"));
    copy_string(&mut context, "threadSource", value.get("threadSource"));
    copy_string_array(
        &mut context,
        "runtimeWorkspaceRoots",
        value.get("runtimeWorkspaceRoots"),
    );
    copy_input_summary(&mut context, value.get("input"));
    if !context.contains_key("effort") {
        if let Some(config) = value.get("config") {
            copy_string(&mut context, "effort", config.get("model_reasoning_effort"));
        }
    }
    if let Some(settings) = value.get("threadSettings") {
        copy_string(&mut context, "settingsCwd", settings.get("cwd"));
        copy_string_array(
            &mut context,
            "settingsRuntimeWorkspaceRoots",
            settings.get("runtimeWorkspaceRoots"),
        );
        if !context.contains_key("effort") {
            copy_string(
                &mut context,
                "effort",
                settings
                    .get("effort")
                    .or_else(|| settings.get("reasoningEffort")),
            );
        }
    }
    (!context.is_empty()).then_some(Value::Object(context))
}

fn copy_input_summary(context: &mut Map<String, Value>, value: Option<&Value>) {
    let Some(inputs) = value.and_then(Value::as_array) else {
        return;
    };

    let mut item_types = Vec::new();
    let mut body_chars = 0_u64;
    let mut mention_count = 0_u64;
    let mut skill_count = 0_u64;
    let mut image_count = 0_u64;
    let mut audio_count = 0_u64;
    for input in inputs {
        let Some(input) = input.as_object() else {
            item_types.push(Value::String("other".to_string()));
            continue;
        };
        let kind = match input.get("type").and_then(Value::as_str) {
            Some("text") => {
                body_chars = body_chars.saturating_add(
                    input
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|text| text.chars().count() as u64)
                        .unwrap_or_default(),
                );
                "text"
            }
            Some("mention") => {
                mention_count += 1;
                "mention"
            }
            Some("skill") => {
                skill_count += 1;
                "skill"
            }
            Some("localImage" | "image") => {
                image_count += 1;
                "image"
            }
            Some("localAudio" | "audio") => {
                audio_count += 1;
                "audio"
            }
            _ => "other",
        };
        item_types.push(Value::String(kind.to_string()));
    }

    context.insert("itemTypes".to_string(), Value::Array(item_types));
    context.insert("bodyChars".to_string(), json!(body_chars));
    context.insert("mentionCount".to_string(), json!(mention_count));
    context.insert("skillCount".to_string(), json!(skill_count));
    context.insert("imageCount".to_string(), json!(image_count));
    context.insert("audioCount".to_string(), json!(audio_count));
}

fn token_usage_context(value: Option<&Value>) -> Option<Value> {
    const BREAKDOWN_FIELDS: [&str; 6] = [
        "totalTokens",
        "inputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
    ];

    let raw = value?.as_object()?;
    let mut context = Map::new();
    for section_name in ["total", "last"] {
        let Some(section) = raw.get(section_name).and_then(Value::as_object) else {
            continue;
        };
        let mut breakdown = Map::new();
        for field in BREAKDOWN_FIELDS {
            if let Some(value) = section.get(field).filter(|value| value.is_number()) {
                breakdown.insert(field.to_string(), value.clone());
            }
        }
        if !breakdown.is_empty() {
            context.insert(section_name.to_string(), Value::Object(breakdown));
        }
    }
    if let Some(value) = raw
        .get("modelContextWindow")
        .filter(|value| value.is_number())
    {
        context.insert("contextWindow".to_string(), value.clone());
    }
    (!context.is_empty()).then_some(Value::Object(context))
}

fn result_context(value: &Value) -> Option<Value> {
    let mut context = Map::new();
    if let Some(turn) = value.get("turn") {
        copy_string(&mut context, "turnId", turn.get("id"));
    }
    copy_string(&mut context, "turnId", value.get("turnId"));
    if let Some(thread) = value.get("thread") {
        copy_string(&mut context, "resultThreadId", thread.get("id"));
        copy_string(&mut context, "resultCwd", thread.get("cwd"));
    }
    copy_string(&mut context, "resultCwd", value.get("cwd"));
    copy_string_array(
        &mut context,
        "resultRuntimeWorkspaceRoots",
        value.get("runtimeWorkspaceRoots"),
    );
    (!context.is_empty()).then_some(Value::Object(context))
}

fn copy_string(context: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        context.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn copy_string_array(context: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    let Some(values) = value.and_then(Value::as_array) else {
        return;
    };
    let values = values
        .iter()
        .filter_map(Value::as_str)
        .map(|value| Value::String(value.to_string()))
        .collect::<Vec<_>>();
    if !values.is_empty() {
        context.insert(key.to_string(), Value::Array(values));
    }
}

fn describe_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| error.to_string())
}

fn should_persist_notification(method: Option<&str>) -> bool {
    !matches!(
        method,
        Some("item/agentMessage/delta" | "item/commandExecution/outputDelta")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_app_server_version_from_daemon_status() {
        let info: DaemonInfo = serde_json::from_str(
            r#"{
          "status": "running",
          "socketPath": "/tmp/codex.sock",
          "managedCodexVersion": "0.149.0",
          "appServerVersion": "0.150.1"
        }"#,
        )
        .expect("parses daemon response");

        assert_eq!(info.status, "running");
        assert_eq!(info.socket_path.as_deref(), Some("/tmp/codex.sock"));
        assert_eq!(info.app_server_version.as_deref(), Some("0.150.1"));
        assert_eq!(info.managed_codex_version.as_deref(), Some("0.149.0"));
    }

    #[test]
    fn extracts_the_cli_version_from_its_standard_output() {
        assert_eq!(
            parse_cli_version("codex-cli 0.150.1\n"),
            Some("0.150.1".to_string())
        );
        assert_eq!(parse_cli_version("\n"), None);
    }

    #[test]
    fn derives_codex_home_from_the_managed_binary_path() {
        assert_eq!(
            codex_home_ancestor(Path::new(
                "/Users/example/.codex/packages/standalone/current/bin/codex"
            )),
            Some(PathBuf::from("/Users/example/.codex"))
        );
        assert_eq!(codex_home_ancestor(Path::new("/usr/local/bin/codex")), None);
    }

    #[test]
    fn only_recovers_the_known_unmanaged_daemon_failure() {
        assert!(is_unmanaged_daemon_error(
            "无法重启 Codex App Server: Error: app server is running but is not managed by codex app-server daemon"
        ));
        assert!(!is_unmanaged_daemon_error(
            "无法重启 Codex App Server: permission denied"
        ));
    }

    #[test]
    fn omits_high_volume_output_deltas_from_diagnostics() {
        assert!(!should_persist_notification(Some(
            "item/agentMessage/delta"
        )));
        assert!(!should_persist_notification(Some(
            "item/commandExecution/outputDelta"
        )));
        assert!(should_persist_notification(Some("item/completed")));
        assert!(should_persist_notification(None));
    }

    #[test]
    fn summarizes_workspace_context_without_persisting_request_payloads() {
        let request = request_context(&json!({
            "threadId": "thread-1",
            "cwd": "/repo",
            "model": "gpt-test",
            "effort": "max",
            "turnTrigger": "quick-agent",
            "runtimeWorkspaceRoots": ["/repo"],
            "input": [
                { "type": "text", "text": "must not be logged" },
                { "type": "mention", "name": "README.md", "path": "/repo/README.md" },
                { "type": "skill", "name": "demo", "path": "/repo/SKILL.md" },
                { "type": "localImage", "path": "/tmp/image.png" },
            ],
        }))
        .expect("extracts request context");
        assert_eq!(request["threadId"], "thread-1");
        assert_eq!(request["cwd"], "/repo");
        assert_eq!(request["model"], "gpt-test");
        assert_eq!(request["effort"], "max");
        assert_eq!(request["turnTrigger"], "quick-agent");
        assert_eq!(
            request["itemTypes"],
            json!(["text", "mention", "skill", "image"])
        );
        assert_eq!(request["bodyChars"], 18);
        assert_eq!(request["mentionCount"], 1);
        assert_eq!(request["skillCount"], 1);
        assert_eq!(request["imageCount"], 1);
        assert!(!request.to_string().contains("must not be logged"));

        let response = result_context(&json!({
            "turn": { "id": "turn-1" },
            "thread": { "id": "thread-1", "cwd": "/repo/worktree" },
            "runtimeWorkspaceRoots": ["/repo/worktree"],
        }))
        .expect("extracts response context");
        assert_eq!(response["turnId"], "turn-1");
        assert_eq!(response["resultThreadId"], "thread-1");
        assert_eq!(response["resultCwd"], "/repo/worktree");
        assert_eq!(
            response["resultRuntimeWorkspaceRoots"],
            json!(["/repo/worktree"])
        );
    }

    #[test]
    fn keeps_only_numeric_token_usage_metadata_for_diagnostics() {
        let usage = token_usage_context(Some(&json!({
            "total": {
                "totalTokens": 1200,
                "inputTokens": 900,
                "outputTokens": 300,
                "text": "must not be copied",
            },
            "last": {
                "totalTokens": 400,
                "reasoningOutputTokens": 100,
            },
            "modelContextWindow": 200000,
            "secret": "must not be copied",
        })))
        .expect("extracts usage metadata");

        assert_eq!(usage["total"]["totalTokens"], 1200);
        assert_eq!(usage["last"]["reasoningOutputTokens"], 100);
        assert_eq!(usage["contextWindow"], 200000);
        assert!(!usage.to_string().contains("must not be copied"));
    }
}
