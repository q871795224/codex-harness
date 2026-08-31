use crate::diagnostics::{error_code, DiagnosticLog};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
        self.diagnostics.record(
            "info",
            "app-server",
            "request.started",
            json!({ "method": &method }),
        );
        let result = match self.connection().await {
            Ok(connection) => self.send_request(&connection, method.clone(), params).await,
            Err(error) => Err(error),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => self.diagnostics.record(
                "info",
                "app-server",
                "request.completed",
                json!({ "method": method, "durationMs": duration_ms }),
            ),
            Err(error) => self.diagnostics.record(
                "error",
                "app-server",
                "request.failed",
                json!({
                    "method": method,
                    "durationMs": duration_ms,
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
                                let thread_id = payload
                                    .get("params")
                                    .and_then(Value::as_object)
                                    .and_then(|params| params.get("threadId"))
                                    .and_then(Value::as_str);
                                if should_persist_notification(method) {
                                    reader_diagnostics.record(
                                        "info",
                                        "app-server",
                                        "notification.received",
                                        json!({ "method": method, "threadId": thread_id }),
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
                        if !reader_intentional_disconnect.load(Ordering::Relaxed) {
                            let _ = app.emit(
                                "app-server:transport",
                                json!({
                                    "kind": "disconnected",
                                    "message": format!("Codex App Server 连接已断开: {error}")
                                }),
                            );
                        }
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
                        "message": "Codex App Server 连接已关闭。"
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
}
