use serde_json::{json, Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FIELD_STRING_LEN: usize = 512;

/// A small, local, privacy-preserving diagnostic trail. It deliberately keeps
/// operational metadata only: never request payloads, responses, or message
/// bodies. Versioned segments are retained indefinitely for troubleshooting.
pub struct DiagnosticLog {
    directory: PathBuf,
    version: String,
    write_lock: Mutex<LogWriter>,
}

#[derive(Default)]
struct LogWriter {
    file: Option<File>,
    next_segment: u64,
}

impl DiagnosticLog {
    pub fn open() -> Result<Self, String> {
        Self::open_at(crate::store::harness_data_dir()?.join("logs"))
    }

    fn open_at(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "无法创建 Codex Harness 日志目录 {}: {error}",
                directory.display()
            )
        })?;
        Ok(Self {
            directory,
            version: env!("CARGO_PKG_VERSION").to_string(),
            write_lock: Mutex::new(LogWriter::default()),
        })
    }

    pub fn record(&self, level: &str, area: &str, event: &str, fields: Value) {
        let _ = self.record_inner(level, area, event, fields);
    }

    pub fn reveal(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("无法准备日志目录 {}: {error}", self.directory.display()))?;

        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer");
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = std::process::Command::new("xdg-open");

        command
            .arg(&self.directory)
            .spawn()
            .map_err(|error| format!("无法打开日志目录 {}: {error}", self.directory.display()))?;
        Ok(())
    }

    fn record_inner(
        &self,
        level: &str,
        area: &str,
        event: &str,
        fields: Value,
    ) -> Result<(), String> {
        let mut writer = self
            .write_lock
            .lock()
            .map_err(|_| "日志写入锁不可用".to_string())?;
        let entry = json!({
            "timestampMs": now_ms(),
            "harnessVersion": self.version,
            "level": truncate(level, 24),
            "area": truncate(area, 48),
            "event": truncate(event, 96),
            "fields": sanitize_fields(fields),
        });
        let line =
            serde_json::to_string(&entry).map_err(|error| format!("无法编码诊断日志: {error}"))?;
        let rotate = match writer.file.as_ref() {
            Some(file) => {
                file.metadata()
                    .map_err(|error| format!("无法读取诊断日志大小: {error}"))?
                    .len()
                    + line.len() as u64
                    + 1
                    > MAX_LOG_BYTES
            }
            None => true,
        };
        if rotate {
            // create_new prevents collisions across restarts and concurrent app instances.
            // Never rename or remove old segments (including legacy harness*.jsonl files).
            loop {
                let path = self.directory.join(format!(
                    "harness-{}-{}-{}-{}.jsonl",
                    self.version,
                    now_ms(),
                    std::process::id(),
                    writer.next_segment
                ));
                writer.next_segment += 1;
                let mut options = OpenOptions::new();
                options.create_new(true).append(true);
                #[cfg(unix)]
                options.mode(0o600);
                match options.open(&path) {
                    Ok(file) => {
                        writer.file = Some(file);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(format!("无法创建诊断日志 {}: {error}", path.display()))
                    }
                }
            }
        }
        let file = writer.file.as_mut().expect("diagnostic segment opened");
        writeln!(file, "{line}").map_err(|error| format!("无法写入诊断日志: {error}"))
    }
}

pub fn error_code(error: &str) -> &'static str {
    let message = error.to_ascii_lowercase();
    if message.contains("no rollout found") {
        "no_rollout_found"
    } else if message.contains("timeout") || message.contains("超时") {
        "timeout"
    } else if message.contains("connection")
        || message.contains("连接")
        || message.contains("socket")
    {
        "connection_failed"
    } else if message.contains("permission") || message.contains("权限") {
        "permission_denied"
    } else {
        "request_failed"
    }
}

/// Retain protocol diagnostics without persisting arbitrary server text/data,
/// which can echo user input, paths, configuration values or credentials.
pub fn rpc_error_metadata(error: &Value) -> Value {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized = message.to_ascii_lowercase();
    let reason = [
        ("no rollout found", "rollout_missing"),
        ("is archived", "thread_archived"),
        ("thread not found", "thread_not_found"),
        ("thread is not loaded", "thread_not_loaded"),
        ("thread not loaded", "thread_not_loaded"),
        ("unknown thread", "thread_not_found"),
        ("invalid params", "invalid_params"),
        ("invalid model", "invalid_model"),
        ("unknown model", "unknown_model"),
        ("unsupported", "unsupported_operation_or_setting"),
        ("active turn", "active_turn_conflict"),
        ("not initialized", "not_initialized"),
        ("rate limit", "rate_limited"),
    ]
    .into_iter()
    .find_map(|(pattern, reason)| normalized.contains(pattern).then_some(reason))
    .unwrap_or_else(|| error_code(message));
    json!({
        "rpcCode": error.get("code").and_then(Value::as_i64),
        "reason": reason,
        "descriptionChars": message.chars().count(),
        "hasData": error.get("data").is_some_and(|value| !value.is_null()),
    })
}

fn sanitize_fields(value: Value) -> Value {
    match value {
        Value::Object(values) => {
            let mut sanitized = Map::new();
            for (key, value) in values.into_iter().take(24) {
                sanitized.insert(
                    key.clone(),
                    if is_sensitive_key(&key) && !is_safe_usage_field(&key, &value) {
                        Value::String("[redacted]".to_string())
                    } else {
                        sanitize_fields(value)
                    },
                );
            }
            Value::Object(sanitized)
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().take(16).map(sanitize_fields).collect())
        }
        Value::String(value) => Value::String(truncate(&value, MAX_FIELD_STRING_LEN)),
        value => value,
    }
}

fn is_safe_usage_field(key: &str, value: &Value) -> bool {
    value.is_number()
        && matches!(
            key,
            "totalTokens"
                | "inputTokens"
                | "cachedInputTokens"
                | "cacheWriteInputTokens"
                | "outputTokens"
                | "reasoningOutputTokens"
        )
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    if key == "context" {
        return false;
    }
    [
        "input",
        "prompt",
        "content",
        "text",
        "message",
        "token",
        "secret",
        "authorization",
        "cookie",
        "credential",
        "password",
        "params",
        "payload",
        "response",
        "command",
        "output",
        "config",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        path::PathBuf,
        process,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "codex-harness-diagnostics-test-{}-{suffix}",
                process::id()
            ));
            fs::create_dir_all(&path).expect("creates temporary diagnostic directory");
            Self(path)
        }

        fn segments(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("harness-")
                })
                .collect()
        }

        fn contents(&self) -> String {
            self.segments()
                .iter()
                .map(|path| fs::read_to_string(path).unwrap())
                .collect()
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stores_operational_metadata_but_redacts_message_content() {
        let directory = TestDir::new();
        let log = DiagnosticLog::open_at(directory.0.clone()).expect("opens log");
        log.record(
            "error",
            "app-server",
            "request.failed",
            json!({
                "method": "thread/resume",
                "threadId": "thread-1",
                "message": "this must not be persisted",
                "nested": { "token": "secret-value" },
            }),
        );

        let contents = directory.contents();
        assert!(contents.contains("thread/resume"));
        assert!(contents.contains("thread-1"));
        assert!(!contents.contains("this must not be persisted"));
        assert!(!contents.contains("secret-value"));
        assert!(contents.contains("[redacted]"));
    }

    #[test]
    fn classifies_known_app_server_failures_without_storing_the_error_text() {
        assert_eq!(
            error_code("no rollout found for thread id thread-1"),
            "no_rollout_found"
        );
        assert_eq!(error_code("other failure"), "request_failed");
    }

    #[test]
    fn preserves_numeric_usage_but_redacts_token_like_strings() {
        let directory = TestDir::new();
        let log = DiagnosticLog::open_at(directory.0.clone()).expect("opens log");
        log.record(
            "info",
            "codex-usage",
            "usage.updated",
            json!({
                "usage": {
                    "total": { "totalTokens": 1200, "outputTokens": 300 },
                    "token": "secret-value",
                },
                "resultMeta": { "turnId": "turn-1" },
                "requestMeta": { "turnTrigger": "quick-agent", "bodyChars": 123 },
            }),
        );

        let contents = directory.contents();
        assert!(contents.contains("totalTokens"));
        assert!(contents.contains("1200"));
        assert!(contents.contains("turn-1"));
        assert!(contents.contains("quick-agent"));
        assert!(!contents.contains("secret-value"));
    }

    #[test]
    fn preserves_workspace_context_metadata_but_redacts_nested_content() {
        let sanitized = sanitize_fields(json!({
            "context": {
                "source": "sidebar",
                "previousThreadCwd": "/repo/previous",
                "selectedThreadCwd": "/repo/selected",
                "promptText": "must stay private",
                "authorizationToken": "secret-value"
            }
        }));

        assert_eq!(sanitized["context"]["source"], "sidebar");
        assert_eq!(sanitized["context"]["previousThreadCwd"], "/repo/previous");
        assert_eq!(sanitized["context"]["selectedThreadCwd"], "/repo/selected");
        assert_eq!(sanitized["context"]["promptText"], "[redacted]");
        assert_eq!(sanitized["context"]["authorizationToken"], "[redacted]");
    }

    #[test]
    fn rotation_retains_every_segment_and_legacy_logs() {
        let directory = TestDir::new();
        for name in ["harness.jsonl", "harness.previous.jsonl"] {
            fs::write(directory.0.join(name), "legacy log").unwrap();
        }
        let log = DiagnosticLog::open_at(directory.0.clone()).unwrap();
        for index in 0..4 {
            log.record_inner("error", "test", "failure", json!({"index": index}))
                .unwrap();
            assert_eq!(directory.segments().len(), index + 1);
            log.write_lock
                .lock()
                .unwrap()
                .file
                .as_ref()
                .unwrap()
                .set_len(MAX_LOG_BYTES)
                .unwrap();
        }
        for name in ["harness.jsonl", "harness.previous.jsonl"] {
            assert_eq!(
                fs::read_to_string(directory.0.join(name)).unwrap(),
                "legacy log"
            );
        }
        let contents = directory.contents();
        for index in 0..4 {
            assert!(contents.contains(&format!("\"index\":{index}")));
        }
    }

    #[test]
    fn versions_and_restarted_instances_never_overwrite_segments() {
        let directory = TestDir::new();
        for version in ["0.0.1", "0.0.1", "0.0.2"] {
            let mut log = DiagnosticLog::open_at(directory.0.clone()).unwrap();
            log.version = version.to_string();
            log.record_inner("error", "test", "failure", json!({}))
                .unwrap();
        }
        assert_eq!(directory.segments().len(), 3);
        for path in directory.segments() {
            let entry: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let version = entry["harnessVersion"].as_str().unwrap();
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!("harness-{version}-")));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn rpc_diagnostics_classify_rejections_without_echoing_server_data() {
        let metadata = rpc_error_metadata(&json!({
            "code": -32600,
            "message": "thread not found: private-user-input",
            "data": {"authorization": "secret-value"},
        }));
        assert_eq!(metadata["rpcCode"], -32600);
        assert_eq!(metadata["reason"], "thread_not_found");
        assert_eq!(metadata["hasData"], true);
        assert!(!metadata.to_string().contains("private-user-input"));
        assert!(!metadata.to_string().contains("secret-value"));
        let unknown =
            rpc_error_metadata(&json!({"message": "sensitive unknown failure", "code": "secret"}));
        assert_eq!(unknown["reason"], "request_failed");
        assert!(unknown["rpcCode"].is_null());
        assert!(!unknown.to_string().contains("sensitive"));
    }
}
