//! Fixed-site Collab client. Credentials and conversation bodies never enter Harness storage/logs.
use reqwest::{redirect::Policy, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

const SERVER: &str = "https://collab.shopee.io";
const WORKSPACE: &str = "33b7cc93-d26a-4a40-9fa9-3508f379e732";
const AGENT: &str = "281fd131-9fe9-4a14-bdd7-36ec840e5e15";
const LOGIN: &str = "请先执行 multica --server-url https://collab.shopee.io login";
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    List {
        archived: bool,
    },
    Catalog {},
    Create {},
    Read {
        id: String,
        before_created_at: Option<String>,
        before_id: Option<String>,
    },
    Send {
        id: String,
        content: String,
        run_config: RunConfig,
    },
    Stop {
        id: String,
        task_id: String,
    },
    Rename {
        id: String,
        title: String,
    },
    Archive {
        id: String,
        archived: bool,
    },
}

pub struct SuperbotClient {
    http: Client,
    #[cfg(test)]
    endpoint: Option<String>,
}

fn read_token(path: &Path, supplied: Option<String>) -> Result<String, String> {
    let token = if let Some(token) = supplied.filter(|s| !s.trim().is_empty()) {
        token
    } else {
        let raw = fs::read(path).map_err(|_| LOGIN.to_string())?;
        let config: Value = serde_json::from_slice(&raw).map_err(|_| LOGIN.to_string())?;
        config["token"].as_str().unwrap_or_default().to_string()
    };
    let token = token.trim();
    if token.is_empty() || token.contains(['\r', '\n']) {
        return Err(LOGIN.into());
    }
    Ok(token.into())
}

fn uuid(value: &str) -> Result<&str, String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err("无效的 Superbot 标识".into());
    }
    Ok(value)
}

fn session(value: &Value) -> Result<Value, String> {
    uuid(value["id"].as_str().ok_or("Superbot 返回无效会话")?)?;
    if value["workspace_id"] != WORKSPACE || value["agent_id"] != AGENT {
        return Err("会话不属于 naming 工作区的 Superbot".into());
    }
    let kind = value["seatalk_kind"]
        .as_str()
        .filter(|kind| ["root", "thread"].contains(kind));
    let archived = kind == Some("thread")
        && value["seatalk_archived_at"]
            .as_str()
            .is_some_and(|at| !at.is_empty());
    let status = if kind == Some("thread") {
        if archived {
            "archived"
        } else {
            "active"
        }
    } else {
        value["status"].as_str().unwrap_or("active")
    };
    let title = value["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("新对话");
    Ok(json!({
        "seatalk_kind": kind, "parent_session_id": value["parent_session_id"], "seatalk_following": value["seatalk_following"].as_bool(),
        "id": value["id"], "title": title, "status": status,
        "read_only": value["read_only"].as_bool().unwrap_or(true) || value["closed_at"].as_str().is_some(),
        "run_config": {"model": value["run_config"]["model"].as_str(), "thinking_level": value["run_config"]["thinking_level"].as_str()}, "runtime_id": value["runtime_id"],
        "created_at": value["created_at"], "updated_at": value["updated_at"],
    }))
}

// Collab deliberately lists browser chats and SeaTalk chats in separate endpoints.
// SeaTalk thread archives belong to the current user, not the global chat status.
fn merge_sessions(normal: &Value, seatalk: &Value, archived: bool) -> Result<Value, String> {
    let normal = normal.as_array().ok_or("无法解析 Superbot 会话列表")?;
    let seatalk = seatalk["sessions"]
        .as_array()
        .ok_or("无法解析 SeaTalk 会话列表")?;
    let mut merged = BTreeMap::new();
    for raw in normal.iter().chain(seatalk) {
        if raw["agent_id"] != AGENT {
            continue;
        }
        let value = session(raw)?;
        merged.insert(value["id"].as_str().unwrap().to_string(), value);
    }
    Ok(Value::Array(
        merged
            .into_values()
            .filter(|value| (value["status"] == "archived") == archived)
            .filter(|value| {
                archived || value["seatalk_kind"] != "thread" || value["seatalk_following"] != false
            })
            .collect(),
    ))
}

// Collab creates sessions against the catalog's original system runtime, then
// resolves DEMS Cloud at dispatch. Accept that legacy system binding, never a
// user-owned runtime, even when it is marked public.
fn validate_public_runtime(runtimes: &Value, selected: Option<&str>) -> Result<(), String> {
    let rows = runtimes.as_array().ok_or("无法读取 Superbot 运行环境")?;
    let cloud = rows
        .iter()
        .find(|r| {
            r["name"] == "DEMS Cloud"
                && r["provider"] == "dems"
                && r["visibility"] == "public"
                && r["status"] == "online"
        })
        .ok_or("公司公共 DEMS Cloud 当前不在线")?;
    let bound = rows
        .iter()
        .find(|r| r["id"].as_str() == selected && selected.is_some())
        .ok_or("无法核对会话的公共云环境，请在 Collab 确认")?;
    if bound["provider"] != "dems"
        || bound["visibility"] != "public"
        || cloud["owner_id"].as_str().is_none()
        || bound["owner_id"] != cloud["owner_id"]
    {
        return Err("此会话绑定了个人运行环境，请在 Collab 切换到公司公共云".into());
    }
    Ok(())
}

impl SuperbotClient {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            #[cfg(test)]
            endpoint: None,
            http: Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| "无法初始化 Superbot 客户端")?,
        })
    }

    async fn api(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        #[cfg(test)]
        let endpoint = self.endpoint.as_deref().unwrap_or(SERVER);
        #[cfg(not(test))]
        let endpoint = SERVER;
        self.send_at(endpoint, token, method, path, body).await
    }

    async fn send_at(
        &self,
        server: &str,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let writing = method != Method::GET;
        let mut req = self
            .http
            .request(method, format!("{server}{path}"))
            .bearer_auth(token)
            .header("X-Workspace-ID", WORKSPACE);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let mut response = req.send().await.map_err(|_| {
            if writing {
                "Superbot 请求中断，结果未知；请刷新会话核对后再操作，勿直接重发"
            } else {
                "无法连接公司 Collab，请检查公司网络"
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 => format!("Superbot 登录已失效；{LOGIN}"),
                403 => "没有此 Superbot 会话或操作的权限".into(),
                404 => "Superbot 会话或接口不存在，请刷新".into(),
                409 => "Superbot 状态已变化，请刷新后操作".into(),
                _ => format!("Collab 返回 HTTP {}，请刷新会话核对状态", status.as_u16()),
            });
        }
        if status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Superbot 响应中断，请刷新核对状态")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("Superbot 响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| "无法解析 Superbot 响应，请刷新核对状态".into())
    }

    async fn cloud(&self, token: &str) -> Result<String, String> {
        let runtimes = self.api(token, Method::GET, "/api/runtimes", None).await?;
        runtimes
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| {
                r["name"] == "DEMS Cloud"
                    && r["provider"] == "dems"
                    && r["visibility"] == "public"
                    && r["status"] == "online"
            })
            .and_then(|r| r["id"].as_str())
            .map(String::from)
            .ok_or("公司公共 DEMS Cloud 当前不在线".into())
    }

    async fn load(&self, token: &str, id: &str, writing: bool) -> Result<Value, String> {
        let id = uuid(id)?;
        let raw = self
            .api(
                token,
                Method::GET,
                &format!("/api/chat/sessions/{id}"),
                None,
            )
            .await?;
        let value = session(&raw)?;
        if writing && (value["read_only"] == true || value["status"] == "archived") {
            return Err("Superbot 会话只读或已归档".into());
        }
        Ok(value)
    }

    pub async fn request(&self, path: &Path, request: Request) -> Result<Value, String> {
        let token = read_token(path, std::env::var("MULTICA_TOKEN").ok())?;
        self.execute(&token, request).await
    }

    async fn execute(&self, token: &str, request: Request) -> Result<Value, String> {
        match request {
            Request::List { archived } => {
                let path = if archived {
                    "/api/chat/sessions?status=archived"
                } else {
                    "/api/chat/sessions"
                };
                let raw = self.api(token, Method::GET, path, None).await?;
                let seatalk = self
                    .api(
                        token,
                        Method::GET,
                        &format!("/api/workspaces/{WORKSPACE}/seatalk/private/sessions"),
                        None,
                    )
                    .await?;
                merge_sessions(&raw, &seatalk, archived)
            }
            Request::Catalog {} => {
                let config = self.api(token, Method::GET, "/api/config", None).await?;
                if config["run_config_overrides_supported"] != true {
                    return Err("Collab 暂不支持切换模型".into());
                }
                let runtime = self.cloud(token).await?;
                let models = self.api(token, Method::POST, &format!("/api/runtimes/{runtime}/models?agent_id={AGENT}&workspace_id={WORKSPACE}"), None).await?;
                if models["status"] != "completed" {
                    return Err("模型目录正在生成，请稍后刷新".into());
                }
                if !models["models"].is_array() {
                    return Err("Superbot 模型目录格式无效".into());
                }
                Ok(json!({"models": models["models"], "runtime_id": runtime}))
            }
            Request::Create {} => {
                self.cloud(token).await?;
                let raw = self
                    .api(
                        token,
                        Method::POST,
                        "/api/chat/sessions",
                        Some(json!({
                            "agent_id": AGENT, "title": "Superbot 会话"
                        })),
                    )
                    .await?;
                session(&raw)
            }
            Request::Read {
                id,
                before_created_at,
                before_id,
            } => {
                let selected = self.load(token, &id, false).await?;
                let mut url =
                    reqwest::Url::parse(&format!("{SERVER}/api/chat/sessions/{id}/messages/page"))
                        .unwrap();
                url.query_pairs_mut().append_pair("limit", "50");
                if let (Some(at), Some(before)) = (before_created_at, before_id) {
                    uuid(&before)?;
                    url.query_pairs_mut()
                        .append_pair("before_created_at", &at)
                        .append_pair("before_id", &before);
                }
                let path = format!("{}?{}", url.path(), url.query().unwrap());
                let pending_path = format!("/api/chat/sessions/{id}/pending-task");
                let (messages, pending) = tokio::try_join!(
                    self.api(token, Method::GET, &path, None),
                    self.api(token, Method::GET, &pending_path, None)
                )?;
                let events = if let Some(task) = pending["task_id"].as_str() {
                    uuid(task)?;
                    self.api(
                        token,
                        Method::GET,
                        &format!("/api/tasks/{task}/messages"),
                        None,
                    )
                    .await?
                } else {
                    json!([])
                };
                if !messages["messages"].is_array() || !pending.is_object() || !events.is_array() {
                    return Err("Superbot 历史或任务响应格式无效".into());
                }
                Ok(
                    json!({"session": selected, "page": messages, "pending": pending, "events": events}),
                )
            }
            Request::Send {
                id,
                content,
                run_config,
            } => {
                if content.trim().is_empty() || content.len() > 256 * 1024 {
                    return Err("请输入 256 KiB 以内的消息".into());
                }
                let selected = self.load(token, &id, true).await?;
                let runtimes = self.api(token, Method::GET, "/api/runtimes", None).await?;
                validate_public_runtime(&runtimes, selected["runtime_id"].as_str())?;
                let accepted = self
                    .api(
                        token,
                        Method::POST,
                        &format!("/api/chat/sessions/{id}/messages"),
                        Some(json!({"content":content,"run_config":run_config})),
                    )
                    .await?;
                if accepted["message_id"].as_str().is_none_or(str::is_empty)
                    || accepted["task_id"].as_str().is_none_or(str::is_empty)
                {
                    return Err(
                        "Superbot 未返回有效发送回执，结果未知；请刷新历史核对，勿直接重发".into(),
                    );
                }
                Ok(accepted)
            }
            Request::Stop { id, task_id } => {
                self.load(token, &id, true).await?;
                uuid(&task_id)?;
                let pending = self
                    .api(
                        token,
                        Method::GET,
                        &format!("/api/chat/sessions/{id}/pending-task"),
                        None,
                    )
                    .await?;
                if pending["task_id"] != task_id {
                    return Err("任务已变化，请刷新后再停止".into());
                }
                self.api(
                    token,
                    Method::POST,
                    &format!("/api/tasks/{task_id}/cancel"),
                    None,
                )
                .await?;
                Ok(Value::Null)
            }
            Request::Rename { id, title } => {
                self.load(token, &id, true).await?;
                let title = title.trim();
                if title.is_empty() || title.chars().count() > 200 {
                    return Err("标题需为 1–200 字".into());
                }
                let raw = self
                    .api(
                        token,
                        Method::PATCH,
                        &format!("/api/chat/sessions/{id}"),
                        Some(json!({"title":title})),
                    )
                    .await?;
                session(&raw)
            }
            Request::Archive { id, archived } => {
                let selected = self.load(token, &id, false).await?;
                if selected["read_only"] == true {
                    return Err("Superbot 会话只读".into());
                }
                let pending = self
                    .api(
                        token,
                        Method::GET,
                        &format!("/api/chat/sessions/{id}/pending-task"),
                        None,
                    )
                    .await?;
                if pending["task_id"].as_str().is_some() {
                    return Err("请先停止运行中的任务再归档".into());
                }
                let path = if selected["seatalk_kind"].as_str().is_some() {
                    format!("/api/workspaces/{WORKSPACE}/seatalk/private/sessions/{id}/archived")
                } else {
                    format!("/api/chat/sessions/{id}/archive")
                };
                self.api(
                    token,
                    Method::PATCH,
                    &path,
                    Some(json!({"archived":archived})),
                )
                .await?;
                Ok(Value::Null)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_read_only_from_injected_file_or_environment() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        assert!(read_token(&path, None).unwrap_err().contains("login"));
        fs::write(
            &path,
            r#"{"token":"test-token","server_url":"http://other.invalid"}"#,
        )
        .unwrap();
        assert_eq!(read_token(&path, None).unwrap(), "test-token");
        assert_eq!(
            read_token(&path, Some("override".into())).unwrap(),
            "override"
        );
        assert!(read_token(&path, Some("secret\nheader".into())).is_err());
    }
    #[test]
    fn prevents_path_injection_and_cross_agent_sessions() {
        for bad in [
            "../config",
            "x?token=secret",
            "00000000-0000-0000-0000-00000000000/",
        ] {
            assert!(uuid(bad).is_err());
        }
        assert!(uuid(AGENT).is_ok());
        assert!(session(&json!({"agent_id":"other","workspace_id":WORKSPACE})).is_err());
        let clean = session(&json!({"agent_id":AGENT,"workspace_id":WORKSPACE,"id":AGENT,"session_metadata":{"secret":"body"},"run_config":{"model":"opus","debug":{"worker_ref":"other"}},"title":"test"})).unwrap();
        assert!(clean.get("session_metadata").is_none());
        assert_eq!(clean["run_config"]["model"], "opus");
        assert!(clean["run_config"].get("debug").is_none());
    }
    fn fixture(
        rows: Vec<(&'static str, String, Option<Value>, u16, Value)>,
    ) -> (SuperbotClient, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for (method, path, expected, status, response) in rows {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert_eq!(first.trim(), format!("{method} {path} HTTP/1.1"));
                let mut size = 0;
                let mut auth = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        size = v.trim().parse().unwrap();
                    }
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        auth = line.contains("fixture-key");
                    }
                }
                assert!(auth);
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                if let Some(expected) = expected {
                    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), expected);
                }
                let response = response.to_string();
                let redirect = if status == 302 {
                    "Location: /must-not-follow\r\n"
                } else {
                    ""
                };
                write!(stream, "HTTP/1.1 {status} Fixture\r\n{redirect}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            }
        });
        let mut client = SuperbotClient::new().unwrap();
        client.endpoint = Some(url);
        (client, worker)
    }
    fn session_fixture() -> Value {
        json!({"id": AGENT, "agent_id":AGENT, "workspace_id":WORKSPACE, "runtime_id":AGENT, "status":"active", "read_only":false})
    }
    fn runtimes_fixture() -> Value {
        json!([{"id":AGENT,"name":"DEMS Cloud","provider":"dems","visibility":"public","status":"online","owner_id":"system"}])
    }
    #[tokio::test]
    async fn sends_once_with_per_turn_model_and_no_local_context() {
        let (client, worker) = fixture(vec![
            (
                "GET",
                format!("/api/chat/sessions/{AGENT}"),
                None,
                200,
                session_fixture(),
            ),
            ("GET", "/api/runtimes".into(), None, 200, runtimes_fixture()),
            (
                "POST",
                format!("/api/chat/sessions/{AGENT}/messages"),
                Some(
                    json!({"content":"hello", "run_config":{"model":"opus", "thinking_level":"high"}}),
                ),
                200,
                json!({"message_id":"message","task_id":"task"}),
            ),
        ]);
        let result = client
            .execute(
                "fixture-key",
                Request::Send {
                    id: AGENT.into(),
                    content: "hello".into(),
                    run_config: RunConfig {
                        reset: None,
                        model: Some("opus".into()),
                        thinking_level: Some("high".into()),
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(result["task_id"], "task");
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn rejects_stale_stop_without_cancelling_another_task() {
        let (client, worker) = fixture(vec![
            (
                "GET",
                format!("/api/chat/sessions/{AGENT}"),
                None,
                200,
                session_fixture(),
            ),
            (
                "GET",
                format!("/api/chat/sessions/{AGENT}/pending-task"),
                None,
                200,
                json!({"task_id":"new-task"}),
            ),
        ]);
        assert!(client
            .execute(
                "fixture-key",
                Request::Stop {
                    id: AGENT.into(),
                    task_id: AGENT.into()
                }
            )
            .await
            .unwrap_err()
            .contains("任务已变化"));
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn rejects_auth_failure_without_echoing_server_or_credentials() {
        let (client, worker) = fixture(vec![(
            "GET",
            "/api/chat/sessions".into(),
            None,
            401,
            json!({"error":"fixture-key private body"}),
        )]);
        let error = client
            .execute("fixture-key", Request::List { archived: false })
            .await
            .unwrap_err();
        assert!(error.contains("login"));
        assert!(!error.contains("fixture-key"));
        assert!(!error.contains("private body"));
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn refuses_redirects_instead_of_forwarding_credentials() {
        let (client, worker) = fixture(vec![(
            "GET",
            "/api/chat/sessions".into(),
            None,
            302,
            json!({}),
        )]);
        let error = client
            .execute("fixture-key", Request::List { archived: false })
            .await
            .unwrap_err();
        assert!(error.contains("302"));
        worker.join().unwrap();
    }
    #[test]
    fn accepts_legacy_system_dems_but_rejects_personal_or_offline_clouds() {
        let mut rows = runtimes_fixture();
        rows.as_array_mut().unwrap().push(json!({"id":"legacy", "owner_id":"system", "provider":"dems", "visibility":"public", "status":"offline"}));
        assert!(validate_public_runtime(&rows, Some("legacy")).is_ok());
        rows[1]["owner_id"] = json!("person");
        assert!(validate_public_runtime(&rows, Some("legacy")).is_err());
        rows[0]["status"] = json!("offline");
        assert!(validate_public_runtime(&rows, Some(AGENT)).is_err());
    }
    #[test]
    fn ipc_rejects_arbitrary_urls_and_omits_unset_run_config() {
        assert!(
            serde_json::from_value::<Request>(json!({"type":"get","url":"http://other"})).is_err()
        );
        assert!(
            serde_json::from_value::<Request>(json!({"type":"create","url":"http://other"}))
                .is_err()
        );
        assert_eq!(
            serde_json::to_value(RunConfig::default()).unwrap(),
            json!({})
        );
    }
    fn seatalk_fixture(id: &str) -> Value {
        let mut row = session_fixture();
        row["id"] = json!(id);
        row["seatalk_kind"] = json!("thread");
        row["seatalk_following"] = json!(true);
        row["parent_session_id"] = json!(AGENT);
        row["title"] = json!("");
        row
    }
    #[tokio::test]
    async fn lists_both_chat_sources_like_the_company_chat_sidebar() {
        let normal = json!([session_fixture(), {"id":WORKSPACE, "agent_id":AGENT, "workspace_id":WORKSPACE, "status":"active", "read_only":false}]);
        let channel: Vec<_> = (1..=6)
            .map(|n| seatalk_fixture(&format!("00000000-0000-4000-8000-{n:012}")))
            .collect();
        let (client, worker) = fixture(vec![
            ("GET", "/api/chat/sessions".into(), None, 200, normal),
            (
                "GET",
                format!("/api/workspaces/{WORKSPACE}/seatalk/private/sessions"),
                None,
                200,
                json!({"sessions":channel}),
            ),
        ]);
        let result = client
            .execute("fixture-key", Request::List { archived: false })
            .await
            .unwrap();
        let rows = result.as_array().unwrap();
        assert_eq!(rows.len(), 8);
        assert_eq!(
            rows.iter()
                .filter(|r| r["seatalk_kind"] == "thread")
                .count(),
            6
        );
        assert_eq!(rows.iter().filter(|r| r["title"] == "新对话").count(), 8);
        worker.join().unwrap();
    }
    #[test]
    fn deduplicates_before_applying_seatalk_user_archive_and_following_state() {
        let mut archived = seatalk_fixture(AGENT);
        archived["seatalk_archived_at"] = json!("2026-11-17T08:00:00Z");
        let mut unfollowed = seatalk_fixture(WORKSPACE);
        unfollowed["seatalk_following"] = json!(false);
        let normal = json!([session_fixture()]);
        let channels = json!({"sessions":[archived,unfollowed]});
        assert_eq!(
            merge_sessions(&normal, &channels, false).unwrap(),
            json!([])
        );
        let result = merge_sessions(&normal, &channels, true).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);
        assert_eq!(result[0]["id"], AGENT);
        assert_eq!(result[0]["status"], "archived");
        assert_eq!(result[0]["parent_session_id"], AGENT);
        assert!(merge_sessions(&normal, &json!({}), false).is_err());
        let mut user_active = seatalk_fixture(AGENT);
        user_active["status"] = json!("archived");
        assert_eq!(
            merge_sessions(&json!([]), &json!({"sessions":[user_active]}), false)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn archives_seatalk_threads_using_the_user_scoped_endpoint() {
        let (client, worker) = fixture(vec![
            (
                "GET",
                format!("/api/chat/sessions/{AGENT}"),
                None,
                200,
                seatalk_fixture(AGENT),
            ),
            (
                "GET",
                format!("/api/chat/sessions/{AGENT}/pending-task"),
                None,
                200,
                json!({}),
            ),
            (
                "PATCH",
                format!("/api/workspaces/{WORKSPACE}/seatalk/private/sessions/{AGENT}/archived"),
                Some(json!({"archived":true})),
                200,
                json!({}),
            ),
        ]);
        client
            .execute(
                "fixture-key",
                Request::Archive {
                    id: AGENT.into(),
                    archived: true,
                },
            )
            .await
            .unwrap();
        worker.join().unwrap();
    }
}
