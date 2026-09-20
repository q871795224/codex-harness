use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn input() -> JevRequest {
    serde_json::from_value(json!({
        "state": "Checkout is unavailable without a workaround.",
        "questions": {
            "team": {"type":"choice", "instructions":"Who owns this?", "criteria":{"engineering":"Failures", "billing":"Charges"}},
            "severity": {"type":"score", "instructions":"Rate impact", "criteria":["Cosmetic", "Blocked"]},
            "blocked": {"type":"boolean", "instructions":"Are purchases blocked?"}
        }
    })).unwrap()
}

fn response() -> Value {
    json!({"model":MODEL,"answers":{
        "team":{"type":"choice","choice":"engineering","probabilities":{"engineering":1.0,"billing":0.0},"confidence":1.0},
        "severity":{"type":"score","score":1.0,"probabilities":{"0":0.0,"1":1.0},"confidence":1.0},
        "blocked":{"type":"boolean","probability":0.98}
    },"usage":{"inputTokens":421,"outputTokens":68},"providerMetadata":{
        "gateway":{"cost":"0","marketCost":"0.000017682","gatewayCost":"0","ignored":"not forwarded"}
    }})
}

async fn server(
    status: u16,
    body: String,
    extra_headers: &str,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/evaluate", listener.local_addr().unwrap());
    let headers = extra_headers.to_owned();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let size = stream.read(&mut chunk).await.unwrap();
            assert!(size > 0);
            bytes.extend_from_slice(&chunk[..size]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).as_bytes()).await.unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (url, task)
}

#[test]
fn reads_only_target_key_without_shell_evaluation() {
    assert_eq!(
        parse_key("OTHER=hidden\nexport VERCEL_API_KEY = 'fixture-key' # comment\n")
            .unwrap()
            .as_deref(),
        Some("fixture-key")
    );
    assert_eq!(
        parse_key("VERCEL_API_KEY=first\nVERCEL_API_KEY=last # note")
            .unwrap()
            .as_deref(),
        Some("last")
    );
    assert!(parse_key("VERCEL_API_KEY=\"unterminated").is_err());
    assert!(parse_key("VERCEL_API_KEY=\"fixture\" junk").is_err());
    assert!(parse_key("OTHER=value\n# VERCEL_API_KEY=ignored")
        .unwrap()
        .is_none());
    assert!(parse_key("VERCEL_API_KEY=\"\"").unwrap().is_none());
}

#[tokio::test]
async fn status_and_missing_credentials_use_only_injected_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets");
    let client = JevClient::new().unwrap();
    assert!(!client.status(&path).unwrap().configured);
    assert!(client
        .evaluate(&path, input())
        .await
        .err()
        .unwrap()
        .contains("未配置"));
    fs::write(&path, "VERCEL_API_KEY=fixture-key").unwrap();
    let value = serde_json::to_value(client.status(&path).unwrap()).unwrap();
    assert_eq!(value, json!({"configured":true,"model":MODEL}));
    fs::write(&path, "VERCEL_API_KEY=").unwrap();
    assert!(!client.status(&path).unwrap().configured);
}

#[test]
fn validates_request_before_any_network_call() {
    let mut request = input();
    let wire: Value = serde_json::from_slice(&request_body(&request).unwrap()).unwrap();
    assert_eq!(wire["model"], MODEL);
    assert_eq!(wire["questions"]["blocked"]["type"], "boolean");
    request.state = Value::Null;
    assert!(request_body(&request).is_err());
    request = input();
    request.questions.clear();
    assert!(request_body(&request).is_err());
    request = input();
    request.questions.insert(
        "bad".into(),
        JevQuestion::Score {
            instructions: "rate".into(),
            criteria: vec!["only".into()],
        },
    );
    assert!(request_body(&request).is_err());
    request = input();
    request.state = Value::String("x".repeat(MAX_BODY));
    assert!(request_body(&request).is_err());
}

#[tokio::test]
async fn sends_real_http_contract_and_preserves_zero_cost() {
    let (url, task) = server(200, response().to_string(), "").await;
    let request = input();
    let result = JevClient::new()
        .unwrap()
        .send(
            &url,
            "fixture-key",
            request_body(&request).unwrap(),
            &request,
        )
        .await
        .unwrap();
    let received = task.await.unwrap();
    assert!(received
        .to_lowercase()
        .contains("authorization: bearer fixture-key\r\n"));
    let payload: Value = serde_json::from_str(received.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(payload["state"], request.state);
    assert_eq!(payload["model"], MODEL);
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["answers"]["blocked"]["probability"], 0.98);
    assert_eq!(value["usage"]["inputTokens"], 421);
    assert_eq!(value["costs"]["cost"], "0");
    assert_eq!(value["costs"]["marketCost"], "0.000017682");
    assert!(value.get("providerMetadata").is_none());
}

#[tokio::test]
async fn rejects_http_failures_without_echoing_sensitive_bodies_or_following_redirects() {
    for status in [401, 402, 403, 429, 503, 302] {
        let (url, task) = server(
            status,
            "fixture-key private-state".into(),
            "Location: http://127.0.0.1:1/credential-trap\r\n",
        )
        .await;
        let request = input();
        let error = JevClient::new()
            .unwrap()
            .send(
                &url,
                "fixture-key",
                request_body(&request).unwrap(),
                &request,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error, http_error(status));
        assert!(!error.contains("fixture-key") && !error.contains("private-state"));
        task.await.unwrap();
    }
}

#[test]
fn rejects_wrong_answer_types_keys_and_probability_ranges() {
    let request = input();
    let mut value = response();
    value["answers"]["blocked"]["probability"] = json!(1.2);
    let wire: WireResponse = serde_json::from_value(value).unwrap();
    assert!(validate_answers(&request, &wire.answers).is_err());
    let mut value = response();
    value["answers"].as_object_mut().unwrap().remove("team");
    let wire: WireResponse = serde_json::from_value(value).unwrap();
    assert!(validate_answers(&request, &wire.answers).is_err());
    let mut value = response();
    value["answers"]["team"]["choice"] = json!("invented");
    let wire: WireResponse = serde_json::from_value(value).unwrap();
    assert!(validate_answers(&request, &wire.answers).is_err());
    let mut value = response();
    value["answers"]["blocked"] = value["answers"]["severity"].clone();
    let wire: WireResponse = serde_json::from_value(value).unwrap();
    assert!(validate_answers(&request, &wire.answers).is_err());
    let mut value = response();
    value.as_object_mut().unwrap().remove("providerMetadata");
    let wire: WireResponse = serde_json::from_value(value).unwrap();
    assert!(wire.provider_metadata.gateway.cost.is_none());
}

#[tokio::test]
async fn malformed_success_body_has_sanitized_error() {
    let (url, task) = server(200, "fixture-key invalid json".into(), "").await;
    let request = input();
    let error = JevClient::new()
        .unwrap()
        .send(
            &url,
            "fixture-key",
            request_body(&request).unwrap(),
            &request,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error, "Jev 返回了无效响应");
    task.await.unwrap();
}
