use crate::diagnostics::{error_code, DiagnosticLog};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{
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

#[derive(Clone)]
struct Connection {
    outgoing: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    alive: Arc<AtomicBool>,
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
                                reader_diagnostics.record(
                                    "info",
                                    "app-server",
                                    "notification.received",
                                    json!({ "method": method, "threadId": thread_id }),
                                );
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
                        let _ = app.emit(
                            "app-server:transport",
                            json!({
                                "kind": "disconnected",
                                "message": format!("Codex App Server 连接已断开: {error}")
                            }),
                        );
                        break;
                    }
                }
            }

            reader_alive.store(false, Ordering::Relaxed);
            reader_diagnostics.record(
                "info",
                "app-server",
                "connection.closed",
                json!({}),
            );
            let mut waiters = reader_pending.lock().await;
            for (_, sender) in waiters.drain() {
                let _ = sender.send(Err("Codex App Server 连接已关闭。请重试。".to_string()));
            }
            let _ = app.emit(
                "app-server:transport",
                json!({
                    "kind": "disconnected",
                    "message": "Codex App Server 连接已关闭。"
                }),
            );
        });

        Connection {
            outgoing,
            pending,
            alive,
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

    let output = Command::new(&codex)
        .args(["app-server", "daemon", "start"])
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

fn daemon_info(codex: &Path) -> Result<DaemonInfo, String> {
    let output = Command::new(codex)
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
    let output = Command::new(codex)
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

fn find_codex_binary() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HARNESS_CODEX_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_app_server_version_from_daemon_status() {
        let info: DaemonInfo = serde_json::from_str(r#"{
          "status": "running",
          "socketPath": "/tmp/codex.sock",
          "managedCodexVersion": "0.149.0",
          "appServerVersion": "0.150.1"
        }"#).expect("parses daemon response");

        assert_eq!(info.status, "running");
        assert_eq!(info.socket_path.as_deref(), Some("/tmp/codex.sock"));
        assert_eq!(info.app_server_version.as_deref(), Some("0.150.1"));
        assert_eq!(info.managed_codex_version.as_deref(), Some("0.149.0"));
    }

    #[test]
    fn extracts_the_cli_version_from_its_standard_output() {
        assert_eq!(parse_cli_version("codex-cli 0.150.1\n"), Some("0.150.1".to_string()));
        assert_eq!(parse_cli_version("\n"), None);
    }
}
