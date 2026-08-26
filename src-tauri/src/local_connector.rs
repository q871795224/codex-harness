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

fn validate_base_url(base_url: &str) -> Result<Url, String> {
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
