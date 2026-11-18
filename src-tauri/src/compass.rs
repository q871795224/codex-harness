use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const BASE_URL: &str = "https://compass.llm.shopee.io/compass-api/v1";
const MAX_BODY: usize = 1024 * 1024;

const API_KEY_NAME: &str = "COMPASS_EXTERNAL_API_KEY";
pub const MODEL_KEY: &str = "compass.model";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Api {
    ChatCompletions,
    Responses,
}

impl Api {
    fn path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat/completions",
            Self::Responses => "responses",
        }
    }

    fn payload(self, model: &str, prompt: &str) -> Value {
        match self {
            Self::ChatCompletions => json!({
                "model": model,
                "messages": [{ "role": "user", "content": prompt }],
                "stream": false,
            }),
            Self::Responses => json!({
                "model": model,
                "input": prompt,
                "stream": false,
                "store": false,
            }),
        }
    }

    fn output(self, data: &Value) -> Result<String, String> {
        let output = match self {
            Self::ChatCompletions => data
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            Self::Responses => {
                if data["status"] != "completed" {
                    return Err("Compass Responses 请求未完成".into());
                }
                data["output"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| item["type"] == "message" && item["role"] == "assistant")
                    .flat_map(|item| item["content"].as_array().into_iter().flatten())
                    .filter(|part| part["type"] == "output_text")
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>()
            }
        };
        if output.trim().is_empty() {
            return Err("Compass 响应缺少文本结果".into());
        }
        Ok(output)
    }
}

struct Config {
    model: String,
    api_key: String,
}

pub fn configured(path: &Path) -> Result<bool, String> {
    Ok(crate::secrets::read(path, API_KEY_NAME)?.is_some())
}

pub fn save_key(path: &Path, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 4096
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
    {
        return Err("请输入有效的 Compass API Key".into());
    }
    crate::secrets::write(path, API_KEY_NAME, value)
}

pub fn validate_model(model: &str) -> Result<&str, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err("请输入有效的 Compass 模型名".into());
    }
    Ok(model)
}

fn load_config(path: &Path, model: &str) -> Result<Config, String> {
    let model = validate_model(model)?.to_owned();
    let api_key =
        crate::secrets::read(path, API_KEY_NAME)?.ok_or("请先在设置中保存 Compass API Key")?;
    Ok(Config { model, api_key })
}

pub async fn complete(
    secrets: &Path,
    model: &str,
    api: Api,
    prompt: &str,
) -> Result<String, String> {
    let path = secrets.to_owned();
    let model = model.to_owned();
    let config = tauri::async_runtime::spawn_blocking(move || load_config(&path, &model))
        .await
        .map_err(|_| "无法读取 Compass 设置")??;
    request(BASE_URL, &config, api, prompt).await
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Compass 请求超时"
    } else {
        "无法连接 Compass 网关"
    }
    .into()
}

async fn request(
    base_url: &str,
    config: &Config,
    api: Api,
    prompt: &str,
) -> Result<String, String> {
    let body = serde_json::to_vec(&api.payload(&config.model, prompt))
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
        .post(format!("{}/{}", base_url, api.path()))
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

    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "Compass 返回了无效 JSON")?;
    api.output(&data)
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
        let endpoint = format!("http://{}/compass-api/v1", listener.local_addr().unwrap());
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

    #[test]
    fn reads_only_the_current_compass_key_from_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets");
        assert!(!configured(&path).unwrap());
        std::fs::write(&path, "VERCEL_API_KEY=other-key").unwrap();
        assert!(!configured(&path).unwrap());
        assert!(load_config(&path, "test-model").is_err());

        std::fs::write(
            &path,
            "VERCEL_API_KEY=other-key\nCOMPASS_EXTERNAL_API_KEY='new-key'",
        )
        .unwrap();
        assert!(configured(&path).unwrap());
        let config = load_config(&path, " test-model ").unwrap();
        assert_eq!(config.api_key, "new-key");
        assert_eq!(config.model, "test-model");

        std::fs::write(&path, "COMPASS_EXTERNAL_API_KEY=").unwrap();
        assert!(!configured(&path).unwrap());
        assert!(load_config(&path, "test-model").is_err());
    }

    #[test]
    fn saves_and_rotates_only_the_compass_key_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets");
        let other = "# Shared settings\nVERCEL_API_KEY=keep-me\n";
        std::fs::write(&path, format!("{other}export COMPASS_EXTERNAL_API_KEY='old-key'\nCOMPASS_EXTERNAL_API_KEY=older-key\n")).unwrap();

        assert!(save_key(&path, "key\nUNRELATED=bad").is_err());
        assert_eq!(load_config(&path, "m").unwrap().api_key, "older-key");
        save_key(&path, " new-key+/= ").unwrap();
        assert_eq!(load_config(&path, "m").unwrap().api_key, "new-key+/=");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{other}COMPASS_EXTERNAL_API_KEY=new-key+/=\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_file(&path).unwrap();
        save_key(&path, "first-key").unwrap();
        assert_eq!(load_config(&path, "m").unwrap().api_key, "first-key");
    }

    #[tokio::test]
    async fn completes_a_plain_text_request_with_bearer_auth() {
        let (endpoint, server) =
            fake_gateway(200, "", r#"{"choices":[{"message":{"content":"OK"}}]}"#);
        assert_eq!(
            request(&endpoint, &config(), Api::ChatCompletions, "fixed probe")
                .await
                .unwrap(),
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
    async fn uses_responses_input_and_collects_assistant_text() {
        let (endpoint, server) = fake_gateway(
            200,
            "",
            r#"{
            "status":"completed","output":[
                {"type":"reasoning","summary":[]},
                {"type":"message","role":"assistant","content":[
                    {"type":"output_text","text":"Hello "},
                    {"type":"output_text","text":"World"}
                ]}
            ]
        }"#,
        );
        assert_eq!(
            request(&endpoint, &config(), Api::Responses, "fixed probe")
                .await
                .unwrap(),
            "Hello World"
        );
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("POST /compass-api/v1/responses HTTP/1.1"));
        assert!(head
            .to_ascii_lowercase()
            .contains("authorization: bearer fake-compass-key\r\n"));
        assert_eq!(
            body,
            json!({"model":"test-model","input":"fixed probe","store":false,"stream":false})
        );
    }

    #[test]
    fn incomplete_or_nontext_responses_do_not_pass_a_text_probe() {
        assert!(Api::Responses.output(&json!({
            "status": "incomplete",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "partial"}]}]
        })).is_err());
        assert!(Api::Responses
            .output(&json!({
                "status": "completed",
                "output": [{"type": "function_call", "name": "test"}]
            }))
            .is_err());
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
            let error = request(&endpoint, &config(), Api::ChatCompletions, "fixed probe")
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("fake-compass-key"));
        }
    }
}
