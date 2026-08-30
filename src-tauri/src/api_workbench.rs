use reqwest::{header::HeaderName, Client, Method};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, fs, path::PathBuf, sync::Mutex, time::Instant};

const MAX_STATE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub struct ApiWorkbenchStore {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHeader {
    pub key: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSendInput {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<ApiHeader>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSendResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<ApiHeader>,
    pub body: String,
    pub elapsed_ms: u64,
    pub size_bytes: usize,
    pub truncated: bool,
}

impl ApiWorkbenchStore {
    pub fn open() -> Result<Self, String> {
        Self::open_at(harness_data_dir()?)
    }

    fn open_at(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("无法创建 API 工作台数据目录 {}：{error}", root.display()))?;
        let connection = Connection::open(root.join("api-workbench.sqlite"))
            .map_err(|error| format!("无法打开 API 工作台数据库：{error}"))?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS workbench_state (
                  state_key TEXT PRIMARY KEY NOT NULL,
                  state_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(|error| format!("无法初始化 API 工作台数据库：{error}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn load(&self) -> Result<Option<Value>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "API 工作台数据库锁当前不可用。".to_string())?;
        let raw = connection
            .query_row(
                "SELECT state_json FROM workbench_state WHERE state_key = 'global'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("无法加载 API 工作台数据：{error}"))?;
        drop(connection);
        raw.map(|raw| {
            serde_json::from_str::<Value>(&raw)
                .map_err(|error| format!("API 工作台数据无效：{error}"))
        })
        .transpose()
    }

    pub fn save(&self, state: &Value) -> Result<Value, String> {
        if !state.is_object() {
            return Err("API 工作台数据必须是 JSON 对象。".to_string());
        }
        let raw = serde_json::to_string(state)
            .map_err(|error| format!("无法序列化 API 工作台数据：{error}"))?;
        if raw.len() > MAX_STATE_BYTES {
            return Err("API 工作台数据超过 10 MB 限制。".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "API 工作台数据库锁当前不可用。".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO workbench_state (state_key, state_json, updated_at)
                VALUES ('global', ?1, unixepoch('subsec') * 1000)
                ON CONFLICT(state_key) DO UPDATE SET
                  state_json = excluded.state_json,
                  updated_at = excluded.updated_at
                "#,
                params![raw],
            )
            .map_err(|error| format!("无法保存 API 工作台数据：{error}"))?;
        Ok(state.clone())
    }
}

pub async fn send(input: ApiSendInput) -> Result<ApiSendResponse, String> {
    let method = Method::from_bytes(input.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的 HTTP 方法：{}", input.method))?;
    let timeout = input.timeout_ms.unwrap_or(30_000).clamp(100, 300_000);
    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("无法创建 HTTP 客户端：{error}"))?;
    let mut request = client.request(method, input.url.trim());
    for header in input
        .headers
        .into_iter()
        .filter(|header| header.enabled && !header.key.trim().is_empty())
    {
        let name = HeaderName::from_bytes(header.key.trim().as_bytes())
            .map_err(|_| format!("HTTP 请求头名称无效：{}", header.key))?;
        request = request.header(name, header.value);
    }
    if let Some(body) = input.body {
        request = request.body(body);
    }
    let started = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|error| format!("HTTP 请求失败：{error}"))?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| ApiHeader {
            key: key.to_string(),
            value: value.to_str().unwrap_or("<binary>").to_string(),
            enabled: true,
        })
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取 HTTP 响应：{error}"))?;
    let size_bytes = bytes.len();
    let truncated = size_bytes > MAX_RESPONSE_BYTES;
    let visible = &bytes[..size_bytes.min(MAX_RESPONSE_BYTES)];
    Ok(ApiSendResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: String::from_utf8_lossy(visible).into_owned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        size_bytes,
        truncated,
    })
}

pub fn read_import_file(path: &str) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取导入文件：{error}"))?;
    if !metadata.is_file() {
        return Err("所选导入路径不是文件。".to_string());
    }
    if metadata.len() as usize > MAX_STATE_BYTES {
        return Err("导入文件超过 10 MB 限制。".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取导入文件：{error}"))
}

fn default_true() -> bool {
    true
}

fn harness_data_dir() -> Result<PathBuf, String> {
    let home = env::var("HOME").map_err(|_| "HOME 不可用，无法初始化 API 工作台。".to_string())?;
    Ok(PathBuf::from(home).join(".codex-harness"))
}

trait OptionalRow<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalRow<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("codex-harness-api-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn persists_global_state_in_dedicated_database() {
        let directory = TempDirectory::new();
        let store = ApiWorkbenchStore::open_at(directory.0.clone()).unwrap();
        let state =
            serde_json::json!({"schemaVersion": 1, "collections": [{"id": "c1", "name": "Auth"}]});
        store.save(&state).unwrap();
        assert_eq!(store.load().unwrap(), Some(state));
        assert!(directory.0.join("api-workbench.sqlite").exists());
        assert!(!directory.0.join("state.sqlite").exists());
    }

    #[tokio::test]
    async fn sends_http_request_and_captures_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
            let size = stream.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.starts_with("POST /token HTTP/1.1"));
            assert!(request.to_ascii_lowercase().contains("x-auth: secret"));
            stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"token\":\"x\"}").await.unwrap();
        });
        let response = send(ApiSendInput {
            method: "POST".into(),
            url: format!("http://{address}/token"),
            headers: vec![ApiHeader {
                key: "X-Auth".into(),
                value: "secret".into(),
                enabled: true,
            }],
            body: Some("{}".into()),
            timeout_ms: Some(2_000),
        })
        .await
        .unwrap();
        assert_eq!(response.status, 201);
        assert_eq!(response.body, "{\"token\":\"x\"}");
        assert!(!response.truncated);
    }
}
