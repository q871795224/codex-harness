use serde_json::{json, Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FIELD_STRING_LEN: usize = 512;

/// A small, local, privacy-preserving diagnostic trail. It deliberately keeps
/// operational metadata only: never request payloads, responses, or message
/// bodies. The current and previous files are retained for troubleshooting.
pub struct DiagnosticLog {
    directory: PathBuf,
    write_lock: Mutex<()>,
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
            write_lock: Mutex::new(()),
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
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "日志写入锁不可用".to_string())?;
        let path = self.directory.join("harness.jsonl");
        self.rotate_if_needed(&path)?;

        let entry = json!({
            "timestampMs": now_ms(),
            "level": truncate(level, 24),
            "area": truncate(area, 48),
            "event": truncate(event, 96),
            "fields": sanitize_fields(fields),
        });
        let line =
            serde_json::to_string(&entry).map_err(|error| format!("无法编码诊断日志: {error}"))?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&path)
            .map_err(|error| format!("无法写入诊断日志 {}: {error}", path.display()))?;
        writeln!(file, "{line}")
            .map_err(|error| format!("无法写入诊断日志 {}: {error}", path.display()))
    }

    fn rotate_if_needed(&self, path: &Path) -> Result<(), String> {
        let Ok(metadata) = fs::metadata(path) else {
            return Ok(());
        };
        if metadata.len() < MAX_LOG_BYTES {
            return Ok(());
        }

        let previous = self.directory.join("harness.previous.jsonl");
        if previous.exists() {
            fs::remove_file(&previous)
                .map_err(|error| format!("无法轮转旧诊断日志 {}: {error}", previous.display()))?;
        }
        fs::rename(path, &previous)
            .map_err(|error| format!("无法轮转诊断日志 {}: {error}", path.display()))
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

        let contents =
            fs::read_to_string(directory.0.join("harness.jsonl")).expect("reads diagnostic log");
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

        let contents =
            fs::read_to_string(directory.0.join("harness.jsonl")).expect("reads diagnostic log");
        assert!(contents.contains("totalTokens"));
        assert!(contents.contains("1200"));
        assert!(contents.contains("turn-1"));
        assert!(contents.contains("quick-agent"));
        assert!(!contents.contains("secret-value"));
    }
}
