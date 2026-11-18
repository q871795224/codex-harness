use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const ENDPOINT: &str = "https://compass.llm.shopee.io/compass-api/v1/chat/completions";
const MAX_BODY: usize = 1024 * 1024;

#[derive(Serialize)]
pub struct Status {
    supported: bool,
    model: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Config {
    model: String,
    api_key: String,
}

impl Config {
    fn status(&self) -> Status {
        Status {
            supported: true,
            model: Some(self.model.clone()),
        }
    }
}

#[cfg(target_os = "macos")]
mod credentials {
    use super::Config;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    const SERVICE: &str = "codex-harness.compass";
    const ACCOUNT: &str = "gateway";
    const ITEM_NOT_FOUND: i32 = -25300;

    pub fn read() -> Result<Option<Config>, String> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "钥匙串中的 Compass 配置无效，请重新保存密钥".into()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err("无法读取 macOS 钥匙串中的 Compass 配置".into()),
        }
    }

    pub fn write(config: &Config) -> Result<(), String> {
        let bytes = serde_json::to_vec(config).map_err(|_| "无法编码 Compass 配置")?;
        set_generic_password(SERVICE, ACCOUNT, &bytes)
            .map_err(|_| "无法保存 Compass 配置到 macOS 钥匙串".into())
    }

    pub fn remove() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err("无法从 macOS 钥匙串清除 Compass 配置".into()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod credentials {
    use super::Config;

    const UNSUPPORTED: &str = "Compass 配置需要 macOS 钥匙串";

    pub fn read() -> Result<Option<Config>, String> {
        Ok(None)
    }

    pub fn write(_: &Config) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn remove() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

pub fn status() -> Result<Status, String> {
    Ok(credentials::read()?.map_or(
        Status {
            supported: cfg!(target_os = "macos"),
            model: None,
        },
        |config| config.status(),
    ))
}

pub fn save(model: &str, api_key: Option<String>) -> Result<Status, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err("请输入有效的 Compass 模型名".into());
    }
    let api_key = match api_key {
        Some(key) => key.trim().to_owned(),
        None => {
            credentials::read()?
                .ok_or("请输入 Compass API Key")?
                .api_key
        }
    };
    if api_key.is_empty()
        || api_key.len() > 4096
        || !api_key.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("请输入有效的 Compass API Key".into());
    }
    let config = Config {
        model: model.to_owned(),
        api_key,
    };
    credentials::write(&config)?;
    Ok(config.status())
}

pub fn remove() -> Result<(), String> {
    credentials::remove()
}

pub async fn complete(prompt: &str) -> Result<String, String> {
    let config = tauri::async_runtime::spawn_blocking(credentials::read)
        .await
        .map_err(|_| "无法读取 Compass 设置")??
        .ok_or("请先在设置中配置 Compass")?;
    request(ENDPOINT, &config, prompt).await
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Compass 请求超时"
    } else {
        "无法连接 Compass 网关"
    }
    .into()
}

async fn request(endpoint: &str, config: &Config, prompt: &str) -> Result<String, String> {
    let body = serde_json::to_vec(&json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
    }))
    .map_err(|_| "无法编码 Compass 请求")?;
    if body.len() > MAX_BODY {
        return Err("Compass 请求超过 1 MiB 限制".into());
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "无法初始化 Compass HTTP 客户端")?;
    let mut response = client
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(network_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => format!("Compass 鉴权失败（HTTP {status}），请检查密钥和模型权限"),
            429 => "Compass 请求受到限流（HTTP 429）".into(),
            code => format!("Compass 请求失败（HTTP {code}）"),
        });
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("Compass 响应超过 1 MiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }

    let data: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Compass 返回了无效 JSON")?;
    data.pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Compass 响应缺少文本结果".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn config() -> Config {
        Config {
            model: "test-model".into(),
            api_key: "fake-compass-key".into(),
        }
    }

    fn fake_gateway(
        status: u16,
        headers: &'static str,
        response: &'static str,
    ) -> (String, thread::JoinHandle<(String, serde_json::Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/compass-api/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{response}",
                response.len()
            ).unwrap();
            (head, serde_json::from_slice(&body).unwrap())
        });
        (endpoint, server)
    }

    #[tokio::test]
    async fn completes_a_plain_text_request_with_bearer_auth() {
        let (endpoint, server) =
            fake_gateway(200, "", r#"{"choices":[{"message":{"content":"OK"}}]}"#);
        assert_eq!(
            request(&endpoint, &config(), "fixed probe").await.unwrap(),
            "OK"
        );
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("POST /compass-api/v1/chat/completions HTTP/1.1"));
        assert!(head
            .to_ascii_lowercase()
            .contains("authorization: bearer fake-compass-key\r\n"));
        assert_eq!(
            body,
            json!({
                "model": "test-model",
                "messages": [{ "role": "user", "content": "fixed probe" }],
                "stream": false
            })
        );
    }

    #[tokio::test]
    async fn returns_safe_errors_for_gateway_failures_and_invalid_completions() {
        for (status, headers, body, expected) in [
            (401, "", "upstream echoed fake-compass-key", "鉴权失败"),
            (
                302,
                "Location: http://127.0.0.1:1/redirect\r\n",
                "",
                "HTTP 302",
            ),
            (
                200,
                "",
                r#"{"choices":[{"message":{"content":null}}]}"#,
                "缺少文本结果",
            ),
        ] {
            let (endpoint, server) = fake_gateway(status, headers, body);
            let error = request(&endpoint, &config(), "fixed probe")
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("fake-compass-key"));
        }
    }
}
