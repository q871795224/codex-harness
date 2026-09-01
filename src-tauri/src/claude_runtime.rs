use crate::diagnostics::DiagnosticLog;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

const PROTOCOL_VERSION: u64 = 1;

type PendingResponse = oneshot::Sender<Result<Value, String>>;

struct ClaudeConnection {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, PendingResponse>>>,
    _child: Arc<Mutex<Child>>,
}

pub struct ClaudeRuntime {
    app: AppHandle,
    diagnostics: Arc<DiagnosticLog>,
    connection: Mutex<Option<Arc<ClaudeConnection>>>,
    next_id: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRuntimeStatus {
    pub available: bool,
    pub node_path: Option<String>,
    pub claude_path: Option<String>,
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
        }
    }

    pub fn status(&self) -> ClaudeRuntimeStatus {
        let node = find_node_binary();
        let claude = find_claude_binary();
        let adapter = find_adapter(&self.app);
        let error = node
            .as_ref()
            .err()
            .or_else(|| claude.as_ref().err())
            .or_else(|| adapter.as_ref().err())
            .cloned();
        ClaudeRuntimeStatus {
            available: error.is_none(),
            node_path: node.ok().map(|path| path.display().to_string()),
            claude_path: claude.ok().map(|path| path.display().to_string()),
            adapter_path: adapter.ok().map(|path| path.display().to_string()),
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
            if connection
                ._child
                .lock()
                .await
                .try_wait()
                .ok()
                .flatten()
                .is_none()
            {
                return Ok(connection.clone());
            }
            *guard = None;
        }
        let connection = self.spawn().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let result = send_request(
            &connection,
            id,
            "initialize",
            json!({
                "claudePath": find_claude_binary()?.display().to_string(),
            }),
        )
        .await?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Claude adapter initialize 缺少 protocolVersion。".to_string())?;
        if version != PROTOCOL_VERSION {
            return Err(format!(
                "Claude adapter 协议版本不兼容：Harness={PROTOCOL_VERSION}, adapter={version}"
            ));
        }
        self.diagnostics.record(
            "info",
            "claude-runtime",
            "adapter.connected",
            json!({ "protocolVersion": version }),
        );
        *guard = Some(connection.clone());
        Ok(connection)
    }

    async fn spawn(&self) -> Result<Arc<ClaudeConnection>, String> {
        let node = find_node_binary()?;
        let claude = find_claude_binary()?;
        let adapter = find_adapter(&self.app)?;
        let root = adapter
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        let mut command = Command::new(&node);
        command
            .arg(&adapter)
            .current_dir(root)
            .env_clear()
            .env("CODEX_HARNESS_CLAUDE_PATH", &claude)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
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
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 Claude adapter: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Claude adapter 没有 stdin。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Claude adapter 没有 stdout。".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Claude adapter 没有 stderr。".to_string())?;
        let pending = Arc::new(Mutex::new(HashMap::<u64, PendingResponse>::new()));

        let app = self.app.clone();
        let response_map = pending.clone();
        let diagnostics = self.diagnostics.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    diagnostics.record(
                        "error",
                        "claude-runtime",
                        "adapter.invalid-json",
                        json!({ "length": line.len() }),
                    );
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = response_map.lock().await.remove(&id) {
                        let response = if let Some(error) = message.get("error") {
                            Err(adapter_error(error))
                        } else {
                            message
                                .get("result")
                                .cloned()
                                .ok_or_else(|| "Claude adapter 响应缺少 result。".to_string())
                        };
                        let _ = sender.send(response);
                    }
                } else if message.get("method").and_then(Value::as_str).is_some() {
                    let _ = app.emit("claude:event", &message);
                }
            }
            let mut pending = response_map.lock().await;
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Claude adapter 已断开。".to_string()));
            }
            let _ = app.emit("claude:transport", json!({ "kind": "disconnected" }));
        });

        let diagnostics = self.diagnostics.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                diagnostics.record(
                    "error",
                    "claude-runtime",
                    "adapter.stderr",
                    json!({ "length": line.len() }),
                );
            }
        });

        Ok(Arc::new(ClaudeConnection {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            _child: Arc::new(Mutex::new(child)),
        }))
    }
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
        let mut stdin = connection.stdin.lock().await;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|error| format!("无法写入 Claude adapter: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("无法刷新 Claude adapter 请求: {error}"))
    }
    .await;
    if let Err(error) = write_result {
        connection.pending.lock().await.remove(&id);
        return Err(error);
    }
    match timeout(Duration::from_secs(20), receiver).await {
        Ok(response) => response.map_err(|_| format!("Claude adapter 请求已取消: {method}"))?,
        Err(_) => {
            connection.pending.lock().await.remove(&id);
            Err(format!("Claude adapter 请求超时: {method}"))
        }
    }
}

fn adapter_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Claude adapter 请求失败")
        .chars()
        .take(1200)
        .collect()
}

fn find_adapter(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CLAUDE_ADAPTER_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("claude-adapter/adapter.mjs");
    if development.is_file() {
        return Ok(development);
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("claude-adapter/adapter.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    Err("找不到 Claude adapter。".to_string())
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
        return Err("Claude adapter 需要 Node.js 18+。".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bounded_adapter_error() {
        assert_eq!(
            adapter_error(&json!({ "message": "model_not_found" })),
            "model_not_found"
        );
    }
}
