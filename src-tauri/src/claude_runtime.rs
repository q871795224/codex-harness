//! Claude Provider client.
//!
//! Harness connects to a local Node.js daemon over a Unix socket. The daemon owns
//! Agent SDK queries and therefore survives Harness window and process exits.

use crate::diagnostics::DiagnosticLog;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedWriteHalf, UnixStream},
    sync::{oneshot, Mutex},
    time::{sleep, timeout, Duration},
};

const PROTOCOL_VERSION: u64 = 2;
const CONNECT_ATTEMPTS: usize = 50;

type PendingResponse = oneshot::Sender<Result<Value, String>>;

struct ClaudeConnection {
    writer: Mutex<OwnedWriteHalf>,
    pending: Arc<Mutex<HashMap<u64, PendingResponse>>>,
    alive: Arc<AtomicBool>,
}

pub struct ClaudeRuntime {
    app: AppHandle,
    diagnostics: Arc<DiagnosticLog>,
    connection: Mutex<Option<Arc<ClaudeConnection>>>,
    next_id: AtomicU64,
    latest_event_seq: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRuntimeStatus {
    pub available: bool,
    pub node_path: Option<String>,
    pub claude_path: Option<String>,
    // Kept as adapterPath for frontend compatibility; it now points to daemon.mjs.
    pub adapter_path: Option<String>,
    pub error: Option<String>,
}

impl ClaudeRuntime {
    pub fn new(app: AppHandle, diagnostics: Arc<DiagnosticLog>) -> Self {
        Self {
            app,
            diagnostics,
            connection: Mutex::new(None),
            next_id: AtomicU64::new(1),
            latest_event_seq: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn status(&self) -> ClaudeRuntimeStatus {
        let node = find_node_binary();
        let claude = find_claude_binary();
        let daemon = find_daemon(&self.app);
        let error = node
            .as_ref()
            .err()
            .or_else(|| claude.as_ref().err())
            .or_else(|| daemon.as_ref().err())
            .cloned();
        ClaudeRuntimeStatus {
            available: error.is_none(),
            node_path: node.ok().map(|path| path.display().to_string()),
            claude_path: claude.ok().map(|path| path.display().to_string()),
            adapter_path: daemon.ok().map(|path| path.display().to_string()),
            error,
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let connection = self.connection().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        send_request(&connection, id, method, params).await
    }

    async fn connection(&self) -> Result<Arc<ClaudeConnection>, String> {
        let mut guard = self.connection.lock().await;
        if let Some(connection) = guard.as_ref() {
            if connection.alive.load(Ordering::Acquire) {
                return Ok(connection.clone());
            }
            *guard = None;
        }

        let socket_path = provider_socket_path()?;
        let stream = match UnixStream::connect(&socket_path).await {
            Ok(stream) => stream,
            Err(_) => {
                self.spawn_daemon(&socket_path)?;
                connect_with_retry(&socket_path).await?
            }
        };
        let connection = self.attach(stream);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let result = send_request(
            &connection,
            id,
            "initialize",
            json!({ "lastEventSeq": self.latest_event_seq.load(Ordering::Acquire) }),
        )
        .await?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Claude Provider initialize 缺少 protocolVersion。".to_string())?;
        if version != PROTOCOL_VERSION {
            connection.alive.store(false, Ordering::Release);
            return Err(format!(
                "Claude Provider 协议版本不兼容：Harness={PROTOCOL_VERSION}, daemon={version}"
            ));
        }
        self.diagnostics.record(
            "info",
            "claude-runtime",
            "daemon.connected",
            json!({
                "protocolVersion": version,
                "daemonPid": result.get("daemonPid"),
            }),
        );
        *guard = Some(connection.clone());
        Ok(connection)
    }

    fn attach(&self, stream: UnixStream) -> Arc<ClaudeConnection> {
        let (reader, writer) = stream.into_split();
        let pending = Arc::new(Mutex::new(HashMap::<u64, PendingResponse>::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let connection = Arc::new(ClaudeConnection {
            writer: Mutex::new(writer),
            pending: pending.clone(),
            alive: alive.clone(),
        });
        let app = self.app.clone();
        let diagnostics = self.diagnostics.clone();
        let latest_event_seq = self.latest_event_seq.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    diagnostics.record(
                        "error",
                        "claude-runtime",
                        "daemon.invalid-json",
                        json!({ "length": line.len() }),
                    );
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let response = if let Some(error) = message.get("error") {
                            Err(provider_error(error))
                        } else {
                            message
                                .get("result")
                                .cloned()
                                .ok_or_else(|| "Claude Provider 响应缺少 result。".to_string())
                        };
                        let _ = sender.send(response);
                    }
                } else if message.get("method").and_then(Value::as_str).is_some() {
                    if let Some(sequence) = message.get("seq").and_then(Value::as_u64) {
                        latest_event_seq.fetch_max(sequence, Ordering::AcqRel);
                    }
                    let _ = app.emit("claude:event", &message);
                }
            }
            alive.store(false, Ordering::Release);
            for (_, sender) in pending.lock().await.drain() {
                let _ = sender.send(Err("Claude Provider 已断开。".to_string()));
            }
            let _ = app.emit("claude:transport", json!({ "kind": "disconnected" }));
        });
        connection
    }

    fn spawn_daemon(&self, socket_path: &Path) -> Result<(), String> {
        let node = find_node_binary()?;
        let claude = find_claude_binary()?;
        let daemon = find_daemon(&self.app)?;
        let state_dir = socket_path
            .parent()
            .ok_or_else(|| "Claude Provider socket 路径无效。".to_string())?;
        fs::create_dir_all(state_dir)
            .map_err(|error| format!("无法创建 Claude Provider 状态目录: {error}"))?;
        set_owner_only_directory(state_dir)?;
        let log_dir = state_dir.join("logs");
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("无法创建 Claude Provider 日志目录: {error}"))?;
        set_owner_only_directory(&log_dir)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("claude-provider.log"))
            .map_err(|error| format!("无法打开 Claude Provider 日志: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("无法复制 Claude Provider 日志句柄: {error}"))?;
        let root = daemon
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        let mut command = std::process::Command::new(&node);
        command
            .arg(&daemon)
            .current_dir(root)
            .env_clear()
            .env("CODEX_HARNESS_CLAUDE_PATH", &claude)
            .env("CODEX_HARNESS_CLAUDE_SOCKET", socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        if let Some(home) = real_home() {
            command.env("HOME", home);
        }
        for key in [
            "PATH",
            "TMPDIR",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "LC_ALL",
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
        ] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .spawn()
            .map_err(|error| format!("无法启动 Claude Provider daemon: {error}"))?;
        self.diagnostics.record(
            "info",
            "claude-runtime",
            "daemon.spawned",
            json!({ "socketPath": socket_path }),
        );
        Ok(())
    }
}

async fn connect_with_retry(socket_path: &Path) -> Result<UnixStream, String> {
    let mut last_error = None;
    for _ in 0..CONNECT_ATTEMPTS {
        match UnixStream::connect(socket_path).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "无法连接 Claude Provider daemon: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "未知错误".to_string())
    ))
}

async fn send_request(
    connection: &ClaudeConnection,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    connection.pending.lock().await.insert(id, sender);
    let line = json!({ "id": id, "method": method, "params": params }).to_string();
    let write_result = async {
        let mut writer = connection.writer.lock().await;
        writer
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|error| format!("无法写入 Claude Provider: {error}"))?;
        writer
            .flush()
            .await
            .map_err(|error| format!("无法刷新 Claude Provider 请求: {error}"))
    }
    .await;
    if let Err(error) = write_result {
        connection.alive.store(false, Ordering::Release);
        connection.pending.lock().await.remove(&id);
        return Err(error);
    }
    match timeout(Duration::from_secs(20), receiver).await {
        Ok(response) => response.map_err(|_| format!("Claude Provider 请求已取消: {method}"))?,
        Err(_) => {
            connection.pending.lock().await.remove(&id);
            Err(format!("Claude Provider 请求超时: {method}"))
        }
    }
}

fn provider_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Claude Provider 请求失败")
        .chars()
        .take(1200)
        .collect()
}

fn provider_socket_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CLAUDE_SOCKET").map(PathBuf::from) {
        return Ok(path);
    }
    real_home()
        .map(|home| home.join(".codex-harness/claude-provider.sock"))
        .ok_or_else(|| "找不到用户 HOME，无法确定 Claude Provider socket。".to_string())
}

fn find_daemon(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CLAUDE_DAEMON_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("claude-adapter/daemon.mjs");
    if development.is_file() {
        return Ok(development);
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("claude-adapter/daemon.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    Err("找不到 Claude Provider daemon。".to_string())
}

fn find_node_binary() -> Result<PathBuf, String> {
    let path = find_binary(
        "CODEX_HARNESS_NODE_PATH",
        "node",
        &[
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ],
    )
    .map_err(|_| "找不到 Node.js 18+。请设置 CODEX_HARNESS_NODE_PATH。".to_string())?;
    let output = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|error| format!("无法检查 Node.js 版本: {error}"))?;
    let major = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if !output.status.success() || major < 18 {
        return Err("Claude Provider 需要 Node.js 18+。".to_string());
    }
    Ok(path)
}

fn find_claude_binary() -> Result<PathBuf, String> {
    let mut candidates = vec![];
    if let Some(home) = real_home() {
        candidates.push(home.join(".local/bin/claude"));
    }
    let fixed = candidates
        .iter()
        .filter_map(|path| path.to_str())
        .collect::<Vec<_>>();
    find_binary("CODEX_HARNESS_CLAUDE_PATH", "claude", &fixed)
        .map_err(|_| "找不到 Claude Code。请设置 CODEX_HARNESS_CLAUDE_PATH。".to_string())
}

fn find_binary(env_key: &str, name: &str, fixed: &[&str]) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(env_key).map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    for candidate in fixed.iter().map(PathBuf::from) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let output = std::process::Command::new("which")
        .arg(name)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!("找不到 {name}"))
}

fn real_home() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(unix)]
fn set_owner_only_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法设置 {} 的权限: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bounded_provider_error() {
        assert_eq!(
            provider_error(&json!({ "message": "model_not_found" })),
            "model_not_found"
        );
    }
}
