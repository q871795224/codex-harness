use super::*;

pub(super) fn enqueue_official_if_enabled(
    mode: &AtomicU8,
    sender: &SyncSender<OfficialCountRequest>,
    stats: &OfficialStats,
    request: OfficialCountRequest,
) {
    if mode.load(Ordering::Relaxed) != CounterMode::Official as u8 {
        return;
    }
    if sender.try_send(request).is_err() {
        stats.fallbacks.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
struct OfficialTokenResponse {
    input_tokens: u64,
}

pub(super) fn run_official_counter(
    receiver: mpsc::Receiver<OfficialCountRequest>,
    result_sender: SyncSender<AnalyticsEvent>,
    mode: Arc<AtomicU8>,
    api_key: Option<String>,
    stats: Arc<OfficialStats>,
    endpoint: &str,
) {
    let client = reqwest::blocking::Client::builder()
        .timeout(OFFICIAL_TIMEOUT)
        .build()
        .ok();
    let mut last_request: Option<Instant> = None;
    while let Ok(request) = receiver.recv() {
        if mode.load(Ordering::Relaxed) != CounterMode::Official as u8 {
            continue;
        }
        let (Some(client), Some(api_key)) = (client.as_ref(), api_key.as_deref()) else {
            stats.fallbacks.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        if let Some(remaining) =
            last_request.and_then(|last| OFFICIAL_MIN_INTERVAL.checked_sub(last.elapsed()))
        {
            thread::sleep(remaining);
        }
        last_request = Some(Instant::now());
        stats.requests.fetch_add(1, Ordering::Relaxed);
        let response = client
            .post(endpoint)
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "model": request.model, "input": request.text }))
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(|response| response.json::<OfficialTokenResponse>());
        match response {
            Ok(response) => {
                stats.successes.fetch_add(1, Ordering::Relaxed);
                if result_sender
                    .try_send(AnalyticsEvent::OfficialCount(OfficialCountResult {
                        target: request.target,
                        tokens: response.input_tokens,
                    }))
                    .is_err()
                {
                    stats.fallbacks.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(_) => {
                stats.failures.fetch_add(1, Ordering::Relaxed);
                stats.fallbacks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

pub(super) fn count_local_tokens(text: &str) -> u64 {
    tiktoken_rs::o200k_base_singleton()
        .encode_ordinary(text)
        .len() as u64
}

pub(super) fn json_chars(value: &Value) -> u64 {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(number) => number.to_string().chars().count() as u64,
        Value::String(value) => json_string_chars(value),
        Value::Array(values) => {
            2 + values.iter().map(json_chars).sum::<u64>() + values.len().saturating_sub(1) as u64
        }
        Value::Object(values) => {
            2 + values
                .iter()
                .map(|(key, value)| json_string_chars(key) + 1 + json_chars(value))
                .sum::<u64>()
                + values.len().saturating_sub(1) as u64
        }
    }
}

fn json_string_chars(value: &str) -> u64 {
    2 + value
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{0008}' | '\u{000C}' | '\n' | '\r' | '\t' => 2,
            '\u{0000}'..='\u{001F}' => 6,
            _ => 1,
        })
        .sum::<u64>()
}

pub(super) fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}
