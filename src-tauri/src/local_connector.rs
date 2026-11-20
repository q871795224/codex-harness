use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{net::IpAddr, time::Duration};

#[derive(Clone)]
pub struct LocalConnector {
    client: Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub account: String,
    pub target_type: String,
    pub target_id: String,
    pub text: String,
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorHealth {
    pub ok: bool,
    #[serde(default)]
    pub accounts: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResult {
    pub ok: bool,
    pub message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageResponse {
    ok: bool,
    message_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorMessage {
    pub id: String,
    pub account_id: String,
    pub direction: String,
    pub platform: String,
    pub conversation_type: Option<String>,
    pub conversation_id: Option<String>,
    pub thread_id: Option<String>,
    pub reply_target_type: Option<String>,
    pub reply_target_id: Option<String>,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub message_type: String,
    pub text: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub received_at: Option<String>,
    pub sent_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageListResponse {
    messages: Vec<ConnectorMessageDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTitlePage {
    thread_id: String,
    anchor_message_id: String,
    messages: Vec<ConversationTitleMessage>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTitleMessage {
    message_id: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorMessageDto {
    id: String,
    account_id: String,
    direction: String,
    platform: String,
    conversation_type: Option<String>,
    conversation_id: Option<String>,
    thread_id: Option<String>,
    sender_id: Option<String>,
    sender_name: Option<String>,
    message_type: String,
    text: Option<String>,
    status: String,
    error: Option<String>,
    created_at: String,
    received_at: Option<String>,
    sent_at: Option<String>,
    raw: Option<Value>,
}

impl From<ConnectorMessageDto> for ConnectorMessage {
    fn from(value: ConnectorMessageDto) -> Self {
        let (reply_target_type, reply_target_id) = reply_target(&value);
        Self {
            id: value.id,
            account_id: value.account_id,
            direction: value.direction,
            platform: value.platform,
            conversation_type: value.conversation_type,
            conversation_id: value.conversation_id,
            thread_id: value.thread_id,
            reply_target_type,
            reply_target_id,
            sender_id: value.sender_id,
            sender_name: value.sender_name,
            message_type: value.message_type,
            text: value.text,
            status: value.status,
            error: value.error,
            created_at: value.created_at,
            received_at: value.received_at,
            sent_at: value.sent_at,
        }
    }
}

fn reply_target(message: &ConnectorMessageDto) -> (Option<String>, Option<String>) {
    if message.direction != "inbound" {
        return (None, None);
    }
    if message.conversation_type.as_deref() == Some("dm") {
        return (Some("user".to_string()), message.conversation_id.clone());
    }
    let group_id = message
        .raw
        .as_ref()
        .and_then(|raw| raw.pointer("/event/group_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if group_id.is_some() {
        (Some("group".to_string()), group_id)
    } else {
        (None, None)
    }
}

impl LocalConnector {
    pub fn new() -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .redirect(Policy::none())
            .build()
            .expect("无法初始化 localhost connector HTTP client");
        Self { client }
    }

    pub async fn health(&self, base_url: &str) -> Result<ConnectorHealth, String> {
        self.get_json(endpoint(base_url, "healthz")?).await
    }

    pub async fn list_messages(
        &self,
        base_url: &str,
        limit: u16,
    ) -> Result<Vec<ConnectorMessage>, String> {
        let mut url = endpoint(base_url, "v1/messages")?;
        url.query_pairs_mut()
            .append_pair("limit", &limit.clamp(1, 100).to_string());
        let response: MessageListResponse = self.get_json(url).await?;
        Ok(response.messages.into_iter().map(Into::into).collect())
    }

    pub async fn send_message(
        &self,
        base_url: &str,
        input: SendMessageInput,
    ) -> Result<SendMessageResult, String> {
        validate_send(&input)?;
        let payload = serde_json::json!({
            "account": input.account,
            "target": { "type": input.target_type, "id": input.target_id },
            "message": { "type": "text", "text": input.text },
            "threadId": input.thread_id,
        });
        let response = self
            .client
            .post(endpoint(base_url, "v1/messages")?)
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("无法连接本机 bridge: {error}"))?;
        let response: SendMessageResponse = parse_json_response(response).await?;
        Ok(SendMessageResult {
            ok: response.ok,
            message_id: response.message_id,
        })
    }

    pub async fn harness_remote(&self, action: &str, input: Value) -> Result<Value, String> {
        self.harness_remote_at("http://127.0.0.1:8787", action, input).await
    }

    pub async fn seatalk_title_context(&self, reference: &str) -> Result<String, String> {
        self.seatalk_title_context_at("http://127.0.0.1:8787", reference).await
    }

    async fn seatalk_title_context_at(&self, base_url: &str, reference: &str) -> Result<String, String> {
        if reference.len() > 4096 || !reference.starts_with("seatalk://conversation?")
            || reference.chars().any(char::is_control) {
            return Err("SeaTalk 消息引用无效".into());
        }
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut page = self.title_conversation_page(base_url, reference, None, None, 100).await?;
            let anchor = page.anchor_message_id.clone();
            // A clicked reply can fall outside the first page. Locate its actual
            // predecessor, then read from that cursor without inventing message IDs.
            if !page.messages.iter().any(|message| message.message_id == anchor) {
                let preceding = self.title_conversation_page(base_url, reference, Some(&anchor), None, 1).await?;
                let cursor = preceding.cursor.ok_or("未取得 SeaTalk 引用消息")?;
                let selected = self.title_conversation_page(base_url, reference, None, Some(&cursor), 1).await?;
                page.messages.extend(selected.messages);
            }
            if !page.messages.iter().any(|message| message.message_id == anchor) {
                return Err("未取得 SeaTalk 引用消息".into());
            }
            let mut selected = Vec::new();
            for id in [&page.thread_id, &anchor] {
                if let Some(message) = page.messages.iter().find(|message| &message.message_id == id) {
                    if !selected.iter().any(|m: &&ConversationTitleMessage| m.message_id == message.message_id) {
                        selected.push(message);
                    }
                }
            }
            for message in &page.messages {
                if selected.len() >= 6 { break; }
                if !selected.iter().any(|m| m.message_id == message.message_id) { selected.push(message); }
            }
            let budget = 4000 / selected.len().max(1);
            let text = selected.into_iter().filter(|message| !message.text.trim().is_empty()).map(|message| {
                let label = if message.message_id == anchor { "选中消息" }
                    else if message.message_id == page.thread_id { "主消息" } else { "分支消息" };
                format!("{label}：{}", truncate(message.text.trim(), budget.saturating_sub(10)))
            }).collect::<Vec<_>>().join("\n");
            if text.is_empty() { return Err("SeaTalk 消息没有可用文字正文".into()); }
            Ok(truncate(&text, 4000))
        }).await.map_err(|_| "读取 SeaTalk 标题上下文超时".to_string())?
    }

    async fn title_conversation_page(&self, base_url: &str, reference: &str, before: Option<&str>, after: Option<&str>, limit: u16) -> Result<ConversationTitlePage, String> {
        let mut url = endpoint(base_url, "local/conversations/messages")?;
        url.query_pairs_mut().append_pair("ref", reference).append_pair("limit", &limit.to_string());
        if let Some(cursor) = before { url.query_pairs_mut().append_pair("before", cursor); }
        if let Some(cursor) = after { url.query_pairs_mut().append_pair("after", cursor); }
        let mut response = self.client.get(url).send().await.map_err(|_| "无法读取 SeaTalk 引用".to_string())?;
        // Do not surface upstream errors, which can echo message bodies or credentials.
        if !response.status().is_success() { return Err("SeaTalk 引用读取失败".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "SeaTalk 引用回包无效".to_string())? {
            if bytes.len() + chunk.len() > 1024 * 1024 { return Err("SeaTalk 引用回包过大".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "SeaTalk 引用回包无效".to_string())?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) { return Err("SeaTalk 引用读取失败".into()); }
        serde_json::from_value(value.get("data").cloned().unwrap_or(Value::Null)).map_err(|_| "SeaTalk 引用缺少消息正文".to_string())
    }

    async fn harness_remote_at(&self, base_url: &str, action: &str, input: Value) -> Result<Value, String> {
        if !matches!(action, "status" | "bindings" | "messages" | "send" | "claim" | "finish") {
            return Err("不支持的 SeaTalk 会话操作".into());
        }
        let mut url = endpoint(base_url, &format!("local/harness/{action}"))?;
        let request = if matches!(action, "status" | "bindings" | "messages") {
            if let Some(fields) = input.as_object() {
                for (key, value) in fields {
                    let value = value.as_str().map(ToString::to_string).unwrap_or_else(|| value.to_string());
                    url.query_pairs_mut().append_pair(key, &value);
                }
            }
            self.client.get(url)
        } else { self.client.post(url).json(&input) };
        let response = request.send().await.map_err(|_| "无法连接 SeaTalk Bridge".to_string())?;
        if !response.status().is_success() { return Err("SeaTalk 会话通道请求失败，请检查 Bridge".into()); }
        let value: Value = response.json().await.map_err(|_| "SeaTalk Bridge 回包无效".to_string())?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) { return Err("SeaTalk Bridge 未确认操作".into()); }
        value.get("data").cloned().ok_or_else(|| "SeaTalk Bridge 缺少返回数据".to_string())
    }

    pub async fn send_question(&self, base_url: &str, payload: Value) -> Result<(), String> {
        let response = self.client.post(endpoint(base_url, "v1/messages")?).json(&payload).send().await
            .map_err(|_| "无法连接本机 Bridge，提问仍可在 Harness 内回答。".to_string())?;
        // Upstream errors can echo private card text. Do not return their body.
        if !response.status().is_success() { return Err("Bridge 未能发送提问通知。".into()); }
        let response: SendMessageResponse = response.json().await.map_err(|_| "Bridge 通知回执无效".to_string())?;
        if !response.ok { return Err("Bridge 未能发送提问通知。".into()); }
        Ok(())
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: Url) -> Result<T, String> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("无法连接本机 bridge: {error}"))?;
        parse_json_response(response).await
    }
}

async fn parse_json_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "本机 bridge 返回 HTTP {status}: {}",
            truncate(&detail, 300)
        ));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| format!("本机 bridge 返回了无效 JSON: {error}"))
}

fn endpoint(base_url: &str, path: &str) -> Result<Url, String> {
    let mut url = validate_base_url(base_url)?;
    url.set_path(path);
    Ok(url)
}

pub(crate) fn validate_base_url(base_url: &str) -> Result<Url, String> {
    let url = Url::parse(base_url.trim()).map_err(|error| format!("bridge 地址无效: {error}"))?;
    if url.scheme() != "http" {
        return Err("bridge 只允许使用 http loopback 地址".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("bridge 地址不能包含凭据、query 或 fragment".to_string());
    }
    if !matches!(url.path(), "" | "/") {
        return Err("bridge 地址不能包含路径".to_string());
    }
    let host = url
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .filter(IpAddr::is_loopback)
        .ok_or_else(|| "bridge 只允许访问 127.0.0.1 或 ::1".to_string())?;
    let _ = host;
    if url.port_or_known_default().is_none() {
        return Err("bridge 地址必须包含有效端口".to_string());
    }
    Ok(url)
}

fn validate_send(input: &SendMessageInput) -> Result<(), String> {
    if input.account.trim().is_empty() || input.account.len() > 128 {
        return Err("bridge account 无效".to_string());
    }
    if !matches!(input.target_type.as_str(), "user" | "group") {
        return Err("SeaTalk 目标类型必须是 user 或 group".to_string());
    }
    if input.target_id.trim().is_empty() || input.target_id.len() > 512 {
        return Err("SeaTalk 目标 ID 无效".to_string());
    }
    if input.text.trim().is_empty() || input.text.len() > 20_000 {
        return Err("SeaTalk 消息必须为 1 到 20000 字节".to_string());
    }
    if input
        .thread_id
        .as_ref()
        .is_some_and(|value| value.len() > 512)
    {
        return Err("SeaTalk thread ID 过长".to_string());
    }
    Ok(())
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TITLE_REFERENCE: &str = "seatalk://conversation?v=1&owner_id=11&target_type=group&target_id=123&root_message_id=0000000000000001&message_id=0000000000000004";

    #[tokio::test]
    async fn title_context_reads_only_the_reference_and_locates_a_paged_anchor() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let root = "0000000000000001";
            let anchor = "0000000000000004";
            let pages = [
                serde_json::json!({"threadId":root,"anchorMessageId":anchor,"messages":[{"messageId":root,"text":"主消息正文"},{"messageId":"0000000000000002","text":"回复"}],"cursor":"0000000000000002"}),
                serde_json::json!({"threadId":root,"anchorMessageId":anchor,"messages":[{"messageId":"0000000000000003","text":"之前的回复"}],"cursor":"0000000000000003"}),
                serde_json::json!({"threadId":root,"anchorMessageId":anchor,"messages":[{"messageId":anchor,"text":"选中问题正文"}],"cursor":anchor}),
            ];
            for (index, data) in pages.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 8192];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(request.starts_with("GET /local/conversations/messages?"));
                let url = Url::parse(&format!("http://127.0.0.1{}", request.split_whitespace().nth(1).unwrap())).unwrap();
                let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                assert_eq!(query["ref"], TITLE_REFERENCE);
                assert!(!query.contains_key("files"));
                assert!(!query.contains_key("context"));
                match index {
                    0 => assert_eq!(query["limit"], "100"),
                    1 => assert_eq!(query["before"], anchor),
                    _ => assert_eq!(query["after"], "0000000000000003"),
                }
                let body = serde_json::json!({"ok":true,"data":data}).to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let text = LocalConnector::new().seatalk_title_context_at(&base, TITLE_REFERENCE).await.unwrap();
        assert!(text.contains("主消息：主消息正文"));
        assert!(text.contains("选中消息：选中问题正文"));
        assert!(!text.contains("owner_id"));
        assert!(text.chars().count() <= 4000);
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn title_context_rejects_non_references_and_does_not_echo_upstream_bodies() {
        use std::io::{Read, Write};
        let connector = LocalConnector::new();
        assert!(connector.seatalk_title_context("https://example.com/private").await.is_err());
        assert!(connector.seatalk_title_context("seatalk://conversation?v=1\nprivate").await.is_err());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request).unwrap();
            let body = "private message / secret credential";
            write!(stream, "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let error = connector.seatalk_title_context_at(&base, TITLE_REFERENCE).await.unwrap_err();
        assert_eq!(error, "SeaTalk 引用读取失败");
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn harness_remote_restricts_actions_and_preserves_the_transport_contract() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("GET /local/harness/messages?after=123 HTTP/1.1"));
            let body = r#"{"ok":true,"data":{"messages":[],"cursor":123,"hasMore":false}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let connector = LocalConnector::new();
        assert!(connector.harness_remote_at(&base, "turn/start", serde_json::json!({})).await.is_err());
        let page = connector.harness_remote_at(&base, "messages", serde_json::json!({"after":123})).await.unwrap();
        assert_eq!(page["cursor"], 123);
        worker.join().unwrap();
    }

    #[test]
    fn accepts_only_literal_loopback_base_urls() {
        assert!(validate_base_url("http://127.0.0.1:8787").is_ok());
        assert!(validate_base_url("http://[::1]:8787/").is_ok());
        assert!(validate_base_url("http://localhost:8787").is_err());
        assert!(validate_base_url("https://127.0.0.1:8787").is_err());
        assert!(validate_base_url("http://127.0.0.1:8787/private").is_err());
        assert!(validate_base_url("http://127.0.0.1:8787?token=secret").is_err());
        assert!(validate_base_url("http://10.0.0.2:8787").is_err());
    }

    #[test]
    fn validates_outbound_message_shape() {
        let valid = SendMessageInput {
            account: "seatalk-local".to_string(),
            target_type: "group".to_string(),
            target_id: "group-1".to_string(),
            text: "发布完成".to_string(),
            thread_id: None,
        };
        assert!(validate_send(&valid).is_ok());

        let invalid = SendMessageInput {
            target_type: "email".to_string(),
            ..valid
        };
        assert!(validate_send(&invalid).is_err());
    }

    #[test]
    fn derives_reply_target_without_exposing_raw_payload() {
        let message: ConnectorMessageDto = serde_json::from_value(serde_json::json!({
            "id": "message-1",
            "accountId": "account-1",
            "direction": "inbound",
            "platform": "seatalk_openapi",
            "conversationType": "thread",
            "conversationId": "group:group-1:thread-1",
            "threadId": "thread-1",
            "senderId": "user-1",
            "senderName": "同事",
            "messageType": "text",
            "text": "hello",
            "status": "received",
            "error": null,
            "createdAt": "2026-08-27T00:00:00Z",
            "receivedAt": "2026-08-27T00:00:00Z",
            "sentAt": null,
            "raw": { "event": { "group_id": "group-1", "secret": "discarded" } }
        }))
        .expect("parses bridge message");
        let output = ConnectorMessage::from(message);
        assert_eq!(output.reply_target_type.as_deref(), Some("group"));
        assert_eq!(output.reply_target_id.as_deref(), Some("group-1"));
        assert!(!serde_json::to_string(&output)
            .expect("serializes safe connector projection")
            .contains("discarded"));
    }
}
