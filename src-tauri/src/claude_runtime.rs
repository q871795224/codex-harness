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
const LAUNCH_AGENT_LABEL: &str = "com.local.codex-harness.claude-provider";

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
        let runtime = Self {
            app,
            diagnostics: diagnostics.clone(),
            connection: Mutex::new(None),
            next_id: AtomicU64::new(1),
            latest_event_seq: Arc::new(AtomicU64::new(0)),
        };
        match runtime.ensure_launch_agent() {
            Ok(state) => diagnostics.record(
                "info",
                "claude-runtime",
                "launch-agent.ready",
                json!({ "state": state }),
            ),
            Err(error) => diagnostics.record(
                "error",
                "claude-runtime",
                "launch-agent.install-failed",
                json!({ "errorLength": error.len() }),
            ),
        }
        runtime
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
            Err(_) if launch_agent_loaded() => {
                kickstart_launch_agent()?;
                connect_with_retry(&socket_path).await?
            }
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

    fn ensure_launch_agent(&self) -> Result<&'static str, String> {
        ensure_launch_agent(&self.app)
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

#[cfg(target_os = "macos")]
fn ensure_launch_agent(app: &AppHandle) -> Result<&'static str, String> {
    let home = real_home()
        .ok_or_else(|| "找不到用户 HOME，无法安装 Claude Provider LaunchAgent。".to_string())?;
    let node = find_node_binary()?;
    let claude = find_claude_binary()?;
    let source_daemon = find_daemon(app)?;
    let source_sdk = find_sdk(app)?;
    let state_root = home.join(".codex-harness");
    let state_dir = state_root.join("claude-provider");
    let log_dir = state_root.join("logs");
    fs::create_dir_all(&state_root)
        .map_err(|error| format!("无法创建 Claude Provider 状态目录: {error}"))?;
    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("无法创建 Claude Provider runtime 目录: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("无法创建 Claude Provider 日志目录: {error}"))?;
    set_owner_only_directory(&state_root)?;
    set_owner_only_directory(&state_dir)?;
    set_owner_only_directory(&log_dir)?;
    let installed_daemon = state_dir.join("daemon.mjs");
    let installed_sdk = state_dir.join("sdk.mjs");
    install_runtime_file(&source_daemon, &installed_daemon)?;
    install_runtime_file(&source_sdk, &installed_sdk)?;

    let launch_agents_dir = home.join("Library/LaunchAgents");
    fs::create_dir_all(&launch_agents_dir)
        .map_err(|error| format!("无法创建 LaunchAgents 目录: {error}"))?;
    let plist_path = launch_agents_dir.join(format!("{LAUNCH_AGENT_LABEL}.plist"));
    let socket_path = provider_socket_path()?;
    let log_path = log_dir.join("claude-provider.log");
    let path = env::var("PATH")
        .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string());
    let plist = launch_agent_plist(
        &node,
        &installed_daemon,
        &claude,
        &socket_path,
        &home,
        &state_dir,
        &log_path,
        &path,
    );
    install_bytes(plist.as_bytes(), &plist_path, 0o644)?;

    if launch_agent_loaded() {
        kickstart_launch_agent()?;
        return Ok("loaded");
    }
    if std::os::unix::net::UnixStream::connect(&socket_path).is_ok() {
        // An older on-demand daemon may already own active turns. Keep it alive;
        // launchd will take ownership on the next user login.
        return Ok("installed-for-next-login");
    }
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &launch_agent_domain()])
        .arg(&plist_path)
        .output()
        .map_err(|error| format!("无法注册 Claude Provider LaunchAgent: {error}"))?;
    if output.status.success() || launch_agent_loaded() {
        return Ok("bootstrapped");
    }
    Err(format!(
        "无法注册 Claude Provider LaunchAgent: {}",
        String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(1200)
            .collect::<String>()
    ))
}

#[cfg(not(target_os = "macos"))]
fn ensure_launch_agent(_app: &AppHandle) -> Result<&'static str, String> {
    Ok("unsupported-platform")
}

#[cfg(target_os = "macos")]
fn launch_agent_loaded() -> bool {
    std::process::Command::new("/bin/launchctl")
        .args([
            "print",
            &format!("{}/{}", launch_agent_domain(), LAUNCH_AGENT_LABEL),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "macos"))]
fn launch_agent_loaded() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn kickstart_launch_agent() -> Result<(), String> {
    let service = format!("{}/{}", launch_agent_domain(), LAUNCH_AGENT_LABEL);
    let output = std::process::Command::new("/bin/launchctl")
        .args(["kickstart", &service])
        .output()
        .map_err(|error| format!("无法启动 Claude Provider LaunchAgent: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "无法启动 Claude Provider LaunchAgent: {}",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(1200)
                .collect::<String>()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn kickstart_launch_agent() -> Result<(), String> {
    Err("当前平台不支持 Claude Provider LaunchAgent。".to_string())
}

#[cfg(target_os = "macos")]
fn launch_agent_domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

#[cfg(target_os = "macos")]
fn install_runtime_file(source: &Path, destination: &Path) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|error| {
        format!(
            "无法读取 Claude Provider resource {}: {error}",
            source.display()
        )
    })?;
    install_bytes(&bytes, destination, 0o600)
}

#[cfg(target_os = "macos")]
fn install_bytes(bytes: &[u8], destination: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if fs::read(destination).is_ok_and(|current| current == bytes) {
        fs::set_permissions(destination, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("无法设置 {} 的权限: {error}", destination.display()))?;
        return Ok(());
    }
    let temporary = destination.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("无法写入 {}: {error}", temporary.display()))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("无法设置 {} 的权限: {error}", temporary.display()))?;
    fs::rename(&temporary, destination)
        .map_err(|error| format!("无法安装 {}: {error}", destination.display()))
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn launch_agent_plist(
    node: &Path,
    daemon: &Path,
    claude: &Path,
    socket: &Path,
    home: &Path,
    working_directory: &Path,
    log: &Path,
    path: &str,
) -> String {
    let value = |path: &Path| xml_escape(&path.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>-i</string>
    <string>HOME={}</string>
    <string>PATH={}</string>
    <string>CODEX_HARNESS_CLAUDE_PATH={}</string>
    <string>CODEX_HARNESS_CLAUDE_SOCKET={}</string>
    <string>{}</string>
    <string>{}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>{}</string>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        value(home),
        xml_escape(path),
        value(claude),
        value(socket),
        value(node),
        value(daemon),
        value(working_directory),
        value(log),
        value(log),
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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
    if cfg!(debug_assertions) && development.is_file() {
        return Ok(development.clone());
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("claude-adapter/daemon.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    if development.is_file() {
        return Ok(development);
    }
    Err("找不到 Claude Provider daemon。".to_string())
}

fn find_sdk(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CLAUDE_SDK_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
        if development.is_file() {
            return Ok(development);
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("claude-adapter/sdk.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    Err("找不到 Claude Agent SDK resource。".to_string())
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

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_runs_at_login_without_persisting_credentials() {
        let plist = launch_agent_plist(
            Path::new("/opt/Node & Tools/node"),
            Path::new("/Users/test/.codex-harness/claude-provider/daemon.mjs"),
            Path::new("/Users/test/.local/bin/claude"),
            Path::new("/Users/test/.codex-harness/claude-provider.sock"),
            Path::new("/Users/test"),
            Path::new("/Users/test/.codex-harness/claude-provider"),
            Path::new("/Users/test/.codex-harness/logs/claude-provider.log"),
            "/usr/local/bin:/usr/bin:/bin",
        );

        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(plist.contains("<string>/usr/bin/env</string>\n    <string>-i</string>"));
        assert!(plist.contains("/opt/Node &amp; Tools/node"));
        assert!(!plist.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(!plist.contains("ANTHROPIC_API_KEY"));
    }
}
