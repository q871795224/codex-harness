use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        mpsc::{self, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LOCAL_ESTIMATOR_VERSION: &str = "tiktoken-rs/0.12.0:o200k_base";
const HEURISTIC_ESTIMATOR_VERSION: &str = "unicode-heuristic-v1:fallback";
const OFFICIAL_ESTIMATOR_VERSION: &str = "openai:responses/input_tokens-v1";
const EVENT_QUEUE_CAPACITY: usize = 2_048;
const OFFICIAL_QUEUE_CAPACITY: usize = 64;
const MAX_COUNTED_TEXT_BYTES: usize = 1_048_576;
const OFFICIAL_MIN_INTERVAL: Duration = Duration::from_millis(250);
const OFFICIAL_TIMEOUT: Duration = Duration::from_secs(5);
const OFFICIAL_ENDPOINT: &str = "https://api.openai.com/v1/responses/input_tokens";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CounterMode {
    Local = 0,
    Official = 1,
}

impl CounterMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "official" => Ok(Self::Official),
            _ => Err(format!("不支持的 Token 计数模式: {value}")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Official => "official",
        }
    }
}

#[derive(Debug, Default)]
struct OfficialStats {
    requests: AtomicU64,
    successes: AtomicU64,
    failures: AtomicU64,
    fallbacks: AtomicU64,
}

#[derive(Clone)]
pub struct CodexAnalytics {
    database_path: PathBuf,
    events: Option<SyncSender<AnalyticsEvent>>,
    dropped_events: Arc<AtomicU64>,
    write_errors: Arc<AtomicU64>,
    counter_mode: Arc<AtomicU8>,
    api_key_configured: bool,
    official_stats: Arc<OfficialStats>,
}

#[derive(Debug)]
enum AnalyticsEvent {
    Turn(TurnObservation),
    Usage(UsageObservation),
    Mcp(McpObservation),
    OfficialCount(OfficialCountResult),
}

#[derive(Debug)]
struct TurnObservation {
    thread_id: String,
    turn_id: String,
    trigger: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    user_chars: u64,
    user_bytes: u64,
    user_estimated_tokens: u64,
    user_text: Option<String>,
    mention_count: u64,
    image_count: u64,
    audio_count: u64,
    skills: Vec<SkillObservation>,
}

#[derive(Debug)]
pub(crate) struct PendingTurnObservation {
    thread_id: String,
    trigger: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    user_chars: u64,
    user_bytes: u64,
    user_estimated_tokens: u64,
    user_text: Option<String>,
    mention_count: u64,
    image_count: u64,
    audio_count: u64,
    skills: Vec<SkillObservation>,
}

#[derive(Debug)]
struct SkillObservation {
    name: String,
    path: PathBuf,
}

#[derive(Debug)]
struct UsageObservation {
    thread_id: String,
    turn_id: String,
    usage: TokenBreakdown,
}

#[derive(Debug, Default)]
struct TokenBreakdown {
    total: u64,
    input: u64,
    cached_input: u64,
    cache_write_input: u64,
    output: u64,
    reasoning_output: u64,
}

#[derive(Debug)]
struct McpObservation {
    call_id: String,
    thread_id: String,
    turn_id: String,
    server: String,
    tool: String,
    status: Option<String>,
    argument_chars: u64,
    result_chars: u64,
    estimated_tokens: u64,
    text: Option<String>,
}

#[derive(Debug)]
enum OfficialTarget {
    Turn { turn_id: String },
    Skill { turn_id: String, skill_name: String },
    Mcp { call_id: String },
}

#[derive(Debug)]
struct OfficialCountRequest {
    target: OfficialTarget,
    model: String,
    text: String,
}

#[derive(Debug)]
struct OfficialCountResult {
    target: OfficialTarget,
    tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCounterStatus {
    mode: &'static str,
    api_key_configured: bool,
    local_estimator: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSnapshot {
    range: String,
    generated_at: i64,
    retention: &'static str,
    estimator_version: String,
    counter: AnalyticsCounterSnapshot,
    summary: AnalyticsSummary,
    daily: Vec<DailyUsage>,
    sources: Vec<SourceUsage>,
    models: Vec<ModelUsage>,
    skills: Vec<SkillUsage>,
    mcp_tools: Vec<McpUsage>,
    recent_turns: Vec<RecentTurn>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyticsCounterSnapshot {
    mode: &'static str,
    api_key_configured: bool,
    local_estimator: &'static str,
    official_requests: u64,
    official_successes: u64,
    official_failures: u64,
    official_fallbacks: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyticsSummary {
    sessions: u64,
    turns: u64,
    usage_updates: u64,
    actual: SerializableTokens,
    user_chars: u64,
    estimated_user_tokens: u64,
    estimated_skill_tokens: u64,
    estimated_mcp_tokens: u64,
    dropped_events: u64,
    write_errors: u64,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableTokens {
    total_tokens: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_write_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyUsage {
    date: String,
    turns: u64,
    actual_total_tokens: u64,
    estimated_user_tokens: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceUsage {
    id: String,
    label: String,
    turns: u64,
    actual_total_tokens: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    model: String,
    turns: u64,
    actual_total_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillUsage {
    name: String,
    calls: u64,
    chars: u64,
    estimated_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpUsage {
    server: String,
    tool: String,
    calls: u64,
    argument_chars: u64,
    result_chars: u64,
    estimated_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentTurn {
    thread_id: String,
    turn_id: String,
    started_at: i64,
    trigger: Option<String>,
    model: Option<String>,
    source: String,
    user_chars: u64,
    estimated_user_tokens: u64,
    actual_total_tokens: u64,
}

#[derive(Debug)]
struct TurnRow {
    thread_id: String,
    turn_id: String,
    started_at: i64,
    day: String,
    trigger: Option<String>,
    model: Option<String>,
    user_chars: u64,
    estimated_user_tokens: u64,
    usage_updates: u64,
    actual: SerializableTokens,
}

impl CodexAnalytics {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| {
            format!(
                "无法创建 Codex Harness 数据目录 {}: {error}",
                root.display()
            )
        })?;
        let database_path = root.join("state.sqlite");
        let connection = open_connection(&database_path)?;
        initialize_schema(&connection)?;
        drop(connection);

        let (events, receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let (official_requests, official_receiver) = mpsc::sync_channel(OFFICIAL_QUEUE_CAPACITY);
        let writer_path = database_path.clone();
        let dropped_events = Arc::new(AtomicU64::new(0));
        let write_errors = Arc::new(AtomicU64::new(0));
        let counter_mode = Arc::new(AtomicU8::new(CounterMode::Local as u8));
        let api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let api_key_configured = api_key.is_some();
        let official_stats = Arc::new(OfficialStats::default());
        let writer_errors = write_errors.clone();
        let writer_mode = counter_mode.clone();
        let writer_stats = official_stats.clone();
        thread::Builder::new()
            .name("codex-analytics-writer".to_string())
            .spawn(move || {
                let Ok(connection) = open_connection(&writer_path) else {
                    return;
                };
                while let Ok(event) = receiver.recv() {
                    if persist_event(
                        &connection,
                        event,
                        &writer_mode,
                        &official_requests,
                        &writer_stats,
                    )
                    .is_err()
                    {
                        writer_errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
            .map_err(|error| format!("无法启动 Codex 分析写入线程: {error}"))?;

        let result_sender = events.clone();
        let official_mode = counter_mode.clone();
        let worker_stats = official_stats.clone();
        thread::Builder::new()
            .name("codex-analytics-openai-counter".to_string())
            .spawn(move || {
                run_official_counter(
                    official_receiver,
                    result_sender,
                    official_mode,
                    api_key,
                    worker_stats,
                    OFFICIAL_ENDPOINT,
                )
            })
            .map_err(|error| format!("无法启动 OpenAI Token 计数线程: {error}"))?;

        Ok(Self {
            database_path,
            events: Some(events),
            dropped_events,
            write_errors,
            counter_mode,
            api_key_configured,
            official_stats,
        })
    }

    pub fn disabled(database_path: PathBuf) -> Self {
        Self {
            database_path,
            events: None,
            dropped_events: Arc::new(AtomicU64::new(0)),
            write_errors: Arc::new(AtomicU64::new(1)),
            counter_mode: Arc::new(AtomicU8::new(CounterMode::Local as u8)),
            api_key_configured: false,
            official_stats: Arc::new(OfficialStats::default()),
        }
    }

    pub fn configure(&self, mode: &str) -> Result<AnalyticsCounterStatus, String> {
        let mode = CounterMode::parse(mode)?;
        self.counter_mode.store(mode as u8, Ordering::Relaxed);
        Ok(AnalyticsCounterStatus {
            mode: mode.label(),
            api_key_configured: self.api_key_configured,
            local_estimator: LOCAL_ESTIMATOR_VERSION,
        })
    }

    pub fn prepare_turn(&self, params: &Value) -> Option<PendingTurnObservation> {
        self.events.as_ref()?;
        let thread_id = params.get("threadId").and_then(Value::as_str)?;

        let mut user_chars = 0_u64;
        let mut user_bytes = 0_u64;
        let mut user_estimated_tokens = 0_u64;
        let mut user_text = String::new();
        let mut text_overflow = false;
        let mut mention_count = 0_u64;
        let mut image_count = 0_u64;
        let mut audio_count = 0_u64;
        let mut skills = Vec::new();
        if let Some(inputs) = params.get("input").and_then(Value::as_array) {
            for input in inputs {
                match input.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = input.get("text").and_then(Value::as_str) {
                            user_chars = user_chars.saturating_add(text.chars().count() as u64);
                            user_bytes = user_bytes.saturating_add(text.len() as u64);
                            user_estimated_tokens = user_estimated_tokens
                                .saturating_add(estimate_tokens_heuristic(text));
                            if !text_overflow {
                                let separator = usize::from(!user_text.is_empty());
                                if user_text
                                    .len()
                                    .saturating_add(text.len())
                                    .saturating_add(separator)
                                    <= MAX_COUNTED_TEXT_BYTES
                                {
                                    if separator == 1 {
                                        user_text.push('\n');
                                    }
                                    user_text.push_str(text);
                                } else {
                                    user_text.clear();
                                    text_overflow = true;
                                }
                            }
                        }
                    }
                    Some("skill") => {
                        if let (Some(name), Some(path)) = (
                            input.get("name").and_then(Value::as_str),
                            input.get("path").and_then(Value::as_str),
                        ) {
                            skills.push(SkillObservation {
                                name: name.to_string(),
                                path: PathBuf::from(path),
                            });
                        }
                    }
                    Some("mention") => mention_count += 1,
                    Some("image" | "localImage") => image_count += 1,
                    Some("audio" | "localAudio") => audio_count += 1,
                    _ => {}
                }
            }
        }
        Some(PendingTurnObservation {
            thread_id: thread_id.to_string(),
            trigger: string_field(params, "turnTrigger"),
            model: string_field(params, "model"),
            effort: string_field(params, "effort")
                .or_else(|| string_field(params, "reasoningEffort")),
            user_chars,
            user_bytes,
            user_estimated_tokens,
            user_text: (!text_overflow && !user_text.is_empty()).then_some(user_text),
            mention_count,
            image_count,
            audio_count,
            skills,
        })
    }

    pub fn record_turn_start(&self, pending: PendingTurnObservation, response: &Value) {
        let Some(turn_id) = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .or_else(|| response.get("turnId"))
            .and_then(Value::as_str)
        else {
            return;
        };
        let observation = TurnObservation {
            thread_id: pending.thread_id,
            turn_id: turn_id.to_string(),
            trigger: pending.trigger,
            model: pending.model,
            effort: pending.effort,
            user_chars: pending.user_chars,
            user_bytes: pending.user_bytes,
            user_estimated_tokens: pending.user_estimated_tokens,
            user_text: pending.user_text,
            mention_count: pending.mention_count,
            image_count: pending.image_count,
            audio_count: pending.audio_count,
            skills: pending.skills,
        };
        self.enqueue(AnalyticsEvent::Turn(observation));
    }

    pub fn record_notification(&self, method: Option<&str>, params: &Value) {
        if self.events.is_none() {
            return;
        }
        match method {
            Some("thread/tokenUsage/updated") => self.record_usage(params),
            Some("item/completed") => self.record_completed_item(params),
            _ => {}
        }
    }

    pub fn snapshot(&self, range: &str) -> Result<AnalyticsSnapshot, String> {
        if self.events.is_none() {
            return Err("Codex 分析采集器不可用；Codex 主流程仍可正常使用。".to_string());
        }
        let range = normalize_range(range);
        let since = range_since_ms(range);
        let connection = open_connection(&self.database_path)?;
        let turns = read_turns(&connection, since)?;
        let source_by_turn = read_plugin_sources(&connection)?;
        let skills = read_skills(&connection, since)?;
        let mcp_tools = read_mcp(&connection, since)?;

        let mut summary = AnalyticsSummary::default();
        let mut thread_ids = HashSet::new();
        let mut daily = BTreeMap::<String, DailyUsage>::new();
        let mut sources = HashMap::<String, SourceUsage>::new();
        let mut models = HashMap::<String, ModelUsage>::new();
        let mut recent_turns = Vec::new();
        for turn in turns {
            thread_ids.insert(turn.thread_id.clone());
            summary.turns += 1;
            summary.usage_updates += turn.usage_updates;
            summary.user_chars += turn.user_chars;
            summary.estimated_user_tokens += turn.estimated_user_tokens;
            add_tokens(&mut summary.actual, &turn.actual);

            let day = daily.entry(turn.day.clone()).or_insert_with(|| DailyUsage {
                date: turn.day.clone(),
                ..Default::default()
            });
            day.turns += 1;
            day.actual_total_tokens += turn.actual.total_tokens;
            day.estimated_user_tokens += turn.estimated_user_tokens;

            let (source_id, source_label) = source_for(&turn, &source_by_turn);
            let source = sources
                .entry(source_id.clone())
                .or_insert_with(|| SourceUsage {
                    id: source_id,
                    label: source_label,
                    ..Default::default()
                });
            source.turns += 1;
            source.actual_total_tokens += turn.actual.total_tokens;

            let model_name = turn
                .model
                .clone()
                .unwrap_or_else(|| "未记录模型".to_string());
            let model = models
                .entry(model_name.clone())
                .or_insert_with(|| ModelUsage {
                    model: model_name,
                    ..Default::default()
                });
            model.turns += 1;
            model.actual_total_tokens += turn.actual.total_tokens;

            if recent_turns.len() < 50 {
                recent_turns.push(RecentTurn {
                    thread_id: turn.thread_id,
                    turn_id: turn.turn_id,
                    started_at: turn.started_at,
                    trigger: turn.trigger,
                    model: turn.model,
                    source: source.label.clone(),
                    user_chars: turn.user_chars,
                    estimated_user_tokens: turn.estimated_user_tokens,
                    actual_total_tokens: turn.actual.total_tokens,
                });
            }
        }
        summary.sessions = thread_ids.len() as u64;
        summary.estimated_skill_tokens = skills.iter().map(|item| item.estimated_tokens).sum();
        summary.estimated_mcp_tokens = mcp_tools.iter().map(|item| item.estimated_tokens).sum();
        summary.dropped_events = self.dropped_events.load(Ordering::Relaxed);
        summary.write_errors = self.write_errors.load(Ordering::Relaxed);

        let mut sources = sources.into_values().collect::<Vec<_>>();
        sources.sort_by_key(|item| std::cmp::Reverse(item.actual_total_tokens));
        let mut models = models.into_values().collect::<Vec<_>>();
        models.sort_by_key(|item| std::cmp::Reverse(item.actual_total_tokens));

        Ok(AnalyticsSnapshot {
            range: range.to_string(),
            generated_at: now_ms(),
            retention: "permanent",
            estimator_version: match self.current_mode() {
                CounterMode::Local => LOCAL_ESTIMATOR_VERSION.to_string(),
                CounterMode::Official => {
                    format!("{OFFICIAL_ESTIMATOR_VERSION}（失败时回退 {LOCAL_ESTIMATOR_VERSION}）")
                }
            },
            counter: AnalyticsCounterSnapshot {
                mode: self.current_mode().label(),
                api_key_configured: self.api_key_configured,
                local_estimator: LOCAL_ESTIMATOR_VERSION,
                official_requests: self.official_stats.requests.load(Ordering::Relaxed),
                official_successes: self.official_stats.successes.load(Ordering::Relaxed),
                official_failures: self.official_stats.failures.load(Ordering::Relaxed),
                official_fallbacks: self.official_stats.fallbacks.load(Ordering::Relaxed),
            },
            summary,
            daily: daily.into_values().collect(),
            sources,
            models,
            skills,
            mcp_tools,
            recent_turns,
        })
    }

    fn record_usage(&self, params: &Value) {
        let (Some(thread_id), Some(turn_id), Some(last)) = (
            params.get("threadId").and_then(Value::as_str),
            params.get("turnId").and_then(Value::as_str),
            params.get("tokenUsage").and_then(|usage| usage.get("last")),
        ) else {
            return;
        };
        let observation = UsageObservation {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            usage: TokenBreakdown {
                total: u64_field(last, "totalTokens"),
                input: u64_field(last, "inputTokens"),
                cached_input: u64_field(last, "cachedInputTokens"),
                cache_write_input: u64_field(last, "cacheWriteInputTokens"),
                output: u64_field(last, "outputTokens"),
                reasoning_output: u64_field(last, "reasoningOutputTokens"),
            },
        };
        self.enqueue(AnalyticsEvent::Usage(observation));
    }

    fn record_completed_item(&self, params: &Value) {
        let (Some(thread_id), Some(turn_id), Some(item)) = (
            params.get("threadId").and_then(Value::as_str),
            params.get("turnId").and_then(Value::as_str),
            params.get("item"),
        ) else {
            return;
        };
        if item.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
            return;
        }
        let (Some(call_id), Some(server), Some(tool)) = (
            item.get("id").and_then(Value::as_str),
            item.get("server").and_then(Value::as_str),
            item.get("tool").and_then(Value::as_str),
        ) else {
            return;
        };
        let arguments = item.get("arguments").map(json_chars).unwrap_or_default();
        let result = item.get("result").map(json_chars).unwrap_or_default();
        let estimated_tokens = estimate_token_count_from_chars(arguments + result);
        let text = if arguments.saturating_add(result) <= MAX_COUNTED_TEXT_BYTES as u64 {
            let arguments = item
                .get("arguments")
                .and_then(|value| serde_json::to_string(value).ok());
            let result = item
                .get("result")
                .and_then(|value| serde_json::to_string(value).ok());
            match (arguments, result) {
                (Some(arguments), Some(result)) => Some(format!("{arguments}\n{result}")),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            }
        } else {
            None
        };
        let observation = McpObservation {
            call_id: call_id.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            server: server.to_string(),
            tool: tool.to_string(),
            status: string_field(item, "status"),
            argument_chars: arguments,
            result_chars: result,
            estimated_tokens,
            text,
        };
        self.enqueue(AnalyticsEvent::Mcp(observation));
    }

    fn enqueue(&self, event: AnalyticsEvent) {
        if self
            .events
            .as_ref()
            .is_none_or(|events| events.try_send(event).is_err())
        {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn current_mode(&self) -> CounterMode {
        if self.counter_mode.load(Ordering::Relaxed) == CounterMode::Official as u8 {
            CounterMode::Official
        } else {
            CounterMode::Local
        }
    }
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开 Codex 分析数据库: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| format!("无法配置 Codex 分析数据库: {error}"))?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS codex_analytics_turns (
              turn_id TEXT PRIMARY KEY NOT NULL,
              thread_id TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              trigger TEXT,
              model TEXT,
              effort TEXT,
              user_chars INTEGER NOT NULL DEFAULT 0,
              user_bytes INTEGER NOT NULL DEFAULT 0,
              user_estimated_tokens INTEGER NOT NULL DEFAULT 0,
              mention_count INTEGER NOT NULL DEFAULT 0,
              image_count INTEGER NOT NULL DEFAULT 0,
              audio_count INTEGER NOT NULL DEFAULT 0,
              estimator_version TEXT NOT NULL,
              usage_updates INTEGER NOT NULL DEFAULT 0,
              actual_total_tokens INTEGER NOT NULL DEFAULT 0,
              actual_input_tokens INTEGER NOT NULL DEFAULT 0,
              actual_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
              actual_cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
              actual_output_tokens INTEGER NOT NULL DEFAULT 0,
              actual_reasoning_output_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS codex_analytics_turns_started
              ON codex_analytics_turns(started_at DESC);
            CREATE INDEX IF NOT EXISTS codex_analytics_turns_thread
              ON codex_analytics_turns(thread_id, started_at DESC);
            CREATE TABLE IF NOT EXISTS codex_analytics_skills (
              turn_id TEXT NOT NULL,
              skill_name TEXT NOT NULL,
              chars INTEGER NOT NULL,
              bytes INTEGER NOT NULL,
              estimated_tokens INTEGER NOT NULL,
              estimator_version TEXT NOT NULL,
              PRIMARY KEY(turn_id, skill_name)
            );
            CREATE TABLE IF NOT EXISTS codex_analytics_mcp_calls (
              call_id TEXT PRIMARY KEY NOT NULL,
              thread_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              server TEXT NOT NULL,
              tool TEXT NOT NULL,
              status TEXT,
              argument_chars INTEGER NOT NULL,
              result_chars INTEGER NOT NULL,
              estimated_tokens INTEGER NOT NULL,
              estimator_version TEXT NOT NULL,
              completed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS codex_analytics_mcp_completed
              ON codex_analytics_mcp_calls(completed_at DESC);
            "#,
        )
        .map_err(|error| format!("无法初始化 Codex 分析数据库: {error}"))
}

fn persist_event(
    connection: &Connection,
    event: AnalyticsEvent,
    mode: &AtomicU8,
    official_requests: &SyncSender<OfficialCountRequest>,
    official_stats: &OfficialStats,
) -> rusqlite::Result<()> {
    match event {
        AnalyticsEvent::Turn(turn) => {
            persist_turn(connection, turn, mode, official_requests, official_stats)
        }
        AnalyticsEvent::Usage(usage) => persist_usage(connection, usage),
        AnalyticsEvent::Mcp(call) => {
            persist_mcp(connection, call, mode, official_requests, official_stats)
        }
        AnalyticsEvent::OfficialCount(result) => persist_official_count(connection, result),
    }
}

fn persist_turn(
    connection: &Connection,
    mut turn: TurnObservation,
    mode: &AtomicU8,
    official_requests: &SyncSender<OfficialCountRequest>,
    official_stats: &OfficialStats,
) -> rusqlite::Result<()> {
    let now = now_ms();
    let user_estimator = if let Some(text) = turn.user_text.as_deref() {
        turn.user_estimated_tokens = count_local_tokens(text);
        LOCAL_ESTIMATOR_VERSION
    } else {
        HEURISTIC_ESTIMATOR_VERSION
    };
    connection.execute(
        r#"
        INSERT INTO codex_analytics_turns (
          turn_id, thread_id, started_at, updated_at, trigger, model, effort,
          user_chars, user_bytes, user_estimated_tokens, mention_count,
          image_count, audio_count, estimator_version
        ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at,
          trigger = excluded.trigger,
          model = excluded.model,
          effort = excluded.effort,
          user_chars = excluded.user_chars,
          user_bytes = excluded.user_bytes,
          user_estimated_tokens = excluded.user_estimated_tokens,
          mention_count = excluded.mention_count,
          image_count = excluded.image_count,
          audio_count = excluded.audio_count,
          estimator_version = excluded.estimator_version
        "#,
        params![
            turn.turn_id,
            turn.thread_id,
            now,
            turn.trigger,
            turn.model,
            turn.effort,
            turn.user_chars,
            turn.user_bytes,
            turn.user_estimated_tokens,
            turn.mention_count,
            turn.image_count,
            turn.audio_count,
            user_estimator,
        ],
    )?;

    if let (Some(model), Some(text)) = (turn.model.as_deref(), turn.user_text.take()) {
        enqueue_official_if_enabled(
            mode,
            official_requests,
            official_stats,
            OfficialCountRequest {
                target: OfficialTarget::Turn {
                    turn_id: turn.turn_id.clone(),
                },
                model: model.to_string(),
                text,
            },
        );
    }

    for skill in turn.skills {
        let Ok(content) = fs::read_to_string(&skill.path) else {
            continue;
        };
        let within_limit = content.len() <= MAX_COUNTED_TEXT_BYTES;
        let estimated_tokens = if within_limit {
            count_local_tokens(&content)
        } else {
            estimate_tokens_heuristic(&content)
        };
        let estimator_version = if within_limit {
            LOCAL_ESTIMATOR_VERSION
        } else {
            HEURISTIC_ESTIMATOR_VERSION
        };
        connection.execute(
            r#"
            INSERT INTO codex_analytics_skills (
              turn_id, skill_name, chars, bytes, estimated_tokens, estimator_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(turn_id, skill_name) DO UPDATE SET
              chars = excluded.chars,
              bytes = excluded.bytes,
              estimated_tokens = excluded.estimated_tokens,
              estimator_version = excluded.estimator_version
            "#,
            params![
                turn.turn_id,
                skill.name,
                content.chars().count() as u64,
                content.len() as u64,
                estimated_tokens,
                estimator_version,
            ],
        )?;
        if within_limit {
            if let Some(model) = turn.model.as_deref() {
                enqueue_official_if_enabled(
                    mode,
                    official_requests,
                    official_stats,
                    OfficialCountRequest {
                        target: OfficialTarget::Skill {
                            turn_id: turn.turn_id.clone(),
                            skill_name: skill.name,
                        },
                        model: model.to_string(),
                        text: content,
                    },
                );
            }
        }
    }
    Ok(())
}

fn persist_usage(connection: &Connection, usage: UsageObservation) -> rusqlite::Result<()> {
    let now = now_ms();
    connection.execute(
        r#"
        INSERT INTO codex_analytics_turns (
          turn_id, thread_id, started_at, updated_at, estimator_version,
          usage_updates, actual_total_tokens, actual_input_tokens,
          actual_cached_input_tokens, actual_cache_write_input_tokens,
          actual_output_tokens, actual_reasoning_output_tokens
        ) VALUES (?1, ?2, ?3, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at,
          usage_updates = usage_updates + 1,
          actual_total_tokens = actual_total_tokens + excluded.actual_total_tokens,
          actual_input_tokens = actual_input_tokens + excluded.actual_input_tokens,
          actual_cached_input_tokens = actual_cached_input_tokens + excluded.actual_cached_input_tokens,
          actual_cache_write_input_tokens = actual_cache_write_input_tokens + excluded.actual_cache_write_input_tokens,
          actual_output_tokens = actual_output_tokens + excluded.actual_output_tokens,
          actual_reasoning_output_tokens = actual_reasoning_output_tokens + excluded.actual_reasoning_output_tokens
        "#,
        params![
            usage.turn_id,
            usage.thread_id,
            now,
            LOCAL_ESTIMATOR_VERSION,
            usage.usage.total,
            usage.usage.input,
            usage.usage.cached_input,
            usage.usage.cache_write_input,
            usage.usage.output,
            usage.usage.reasoning_output,
        ],
    )?;
    Ok(())
}

fn persist_mcp(
    connection: &Connection,
    mut call: McpObservation,
    mode: &AtomicU8,
    official_requests: &SyncSender<OfficialCountRequest>,
    official_stats: &OfficialStats,
) -> rusqlite::Result<()> {
    let estimator_version = if let Some(text) = call.text.as_deref() {
        call.estimated_tokens = count_local_tokens(text);
        LOCAL_ESTIMATOR_VERSION
    } else {
        HEURISTIC_ESTIMATOR_VERSION
    };
    connection.execute(
        r#"
        INSERT INTO codex_analytics_mcp_calls (
          call_id, thread_id, turn_id, server, tool, status, argument_chars,
          result_chars, estimated_tokens, estimator_version, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(call_id) DO UPDATE SET
          status = excluded.status,
          argument_chars = excluded.argument_chars,
          result_chars = excluded.result_chars,
          estimated_tokens = excluded.estimated_tokens,
          completed_at = excluded.completed_at
        "#,
        params![
            call.call_id,
            call.thread_id,
            call.turn_id,
            call.server,
            call.tool,
            call.status,
            call.argument_chars,
            call.result_chars,
            call.estimated_tokens,
            estimator_version,
            now_ms(),
        ],
    )?;
    if let Some(text) = call.text.take() {
        let model = connection
            .query_row(
                "SELECT model FROM codex_analytics_turns WHERE turn_id = ?1",
                [&call.turn_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if let Some(model) = model {
            enqueue_official_if_enabled(
                mode,
                official_requests,
                official_stats,
                OfficialCountRequest {
                    target: OfficialTarget::Mcp {
                        call_id: call.call_id,
                    },
                    model,
                    text,
                },
            );
        }
    }
    Ok(())
}

fn persist_official_count(
    connection: &Connection,
    result: OfficialCountResult,
) -> rusqlite::Result<()> {
    match result.target {
        OfficialTarget::Turn { turn_id } => {
            connection.execute(
                "UPDATE codex_analytics_turns SET user_estimated_tokens = ?1, estimator_version = ?2 WHERE turn_id = ?3",
                params![result.tokens, OFFICIAL_ESTIMATOR_VERSION, turn_id],
            )?;
        }
        OfficialTarget::Skill {
            turn_id,
            skill_name,
        } => {
            connection.execute(
                "UPDATE codex_analytics_skills SET estimated_tokens = ?1, estimator_version = ?2 WHERE turn_id = ?3 AND skill_name = ?4",
                params![result.tokens, OFFICIAL_ESTIMATOR_VERSION, turn_id, skill_name],
            )?;
        }
        OfficialTarget::Mcp { call_id } => {
            connection.execute(
                "UPDATE codex_analytics_mcp_calls SET estimated_tokens = ?1, estimator_version = ?2 WHERE call_id = ?3",
                params![result.tokens, OFFICIAL_ESTIMATOR_VERSION, call_id],
            )?;
        }
    }
    Ok(())
}

fn read_turns(connection: &Connection, since: i64) -> Result<Vec<TurnRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT thread_id, turn_id, started_at,
              strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime'),
              trigger, model, user_chars, user_estimated_tokens, usage_updates,
              actual_total_tokens, actual_input_tokens, actual_cached_input_tokens,
              actual_cache_write_input_tokens, actual_output_tokens,
              actual_reasoning_output_tokens
            FROM codex_analytics_turns
            WHERE started_at >= ?1
            ORDER BY started_at DESC
            "#,
        )
        .map_err(|error| format!("无法读取 Codex turn 分析: {error}"))?;
    let rows = statement
        .query_map([since], |row| {
            Ok(TurnRow {
                thread_id: row.get(0)?,
                turn_id: row.get(1)?,
                started_at: row.get(2)?,
                day: row.get(3)?,
                trigger: row.get(4)?,
                model: row.get(5)?,
                user_chars: row.get(6)?,
                estimated_user_tokens: row.get(7)?,
                usage_updates: row.get(8)?,
                actual: SerializableTokens {
                    total_tokens: row.get(9)?,
                    input_tokens: row.get(10)?,
                    cached_input_tokens: row.get(11)?,
                    cache_write_input_tokens: row.get(12)?,
                    output_tokens: row.get(13)?,
                    reasoning_output_tokens: row.get(14)?,
                },
            })
        })
        .map_err(|error| format!("无法读取 Codex turn 分析: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 Codex turn 分析: {error}"))
}

fn read_plugin_sources(
    connection: &Connection,
) -> Result<HashMap<String, (String, String)>, String> {
    let has_plugin_runs = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'plugin_runs'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| format!("无法检查插件归因表: {error}"))?
        > 0;
    if !has_plugin_runs {
        return Ok(HashMap::new());
    }
    let mut statement = connection
        .prepare(
            r#"
            SELECT r.turn_id, r.child_thread_id, i.plugin_id, i.instance_id
            FROM plugin_runs r
            JOIN plugin_instances i ON i.instance_id = r.instance_id
            WHERE r.turn_id IS NOT NULL OR r.child_thread_id IS NOT NULL
            "#,
        )
        .map_err(|error| format!("无法读取插件归因: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("无法读取插件归因: {error}"))?;
    let mut result = HashMap::new();
    for row in rows {
        let (turn_id, thread_id, plugin_id, instance_id) =
            row.map_err(|error| format!("无法读取插件归因: {error}"))?;
        let label = plugin_label(&plugin_id).to_string();
        if let Some(turn_id) = turn_id {
            result.insert(
                format!("turn:{turn_id}"),
                (instance_id.clone(), label.clone()),
            );
        }
        if let Some(thread_id) = thread_id {
            result.insert(format!("thread:{thread_id}"), (instance_id, label));
        }
    }
    let mut luna_statement = connection
        .prepare("SELECT turn_id FROM codex_analytics_skills WHERE skill_name = 'plan-delegate'")
        .map_err(|error| format!("无法读取 Luna 归因: {error}"))?;
    let luna_turns = luna_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("无法读取 Luna 归因: {error}"))?;
    for turn_id in luna_turns {
        result
            .entry(format!(
                "turn:{}",
                turn_id.map_err(|error| format!("无法读取 Luna 归因: {error}"))?
            ))
            .or_insert_with(|| ("builtin.temporary-agent".to_string(), "Luna".to_string()));
    }
    Ok(result)
}

fn read_skills(connection: &Connection, since: i64) -> Result<Vec<SkillUsage>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT s.skill_name, COUNT(*), SUM(s.chars), SUM(s.estimated_tokens)
            FROM codex_analytics_skills s
            JOIN codex_analytics_turns t ON t.turn_id = s.turn_id
            WHERE t.started_at >= ?1
            GROUP BY s.skill_name
            ORDER BY SUM(s.estimated_tokens) DESC, COUNT(*) DESC
            LIMIT 100
            "#,
        )
        .map_err(|error| format!("无法读取 Skill 分析: {error}"))?;
    let rows = statement
        .query_map([since], |row| {
            Ok(SkillUsage {
                name: row.get(0)?,
                calls: row.get(1)?,
                chars: row.get(2)?,
                estimated_tokens: row.get(3)?,
            })
        })
        .map_err(|error| format!("无法读取 Skill 分析: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 Skill 分析: {error}"))
}

fn read_mcp(connection: &Connection, since: i64) -> Result<Vec<McpUsage>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT server, tool, COUNT(*), SUM(argument_chars), SUM(result_chars),
              SUM(estimated_tokens)
            FROM codex_analytics_mcp_calls
            WHERE completed_at >= ?1
            GROUP BY server, tool
            ORDER BY SUM(estimated_tokens) DESC, COUNT(*) DESC
            LIMIT 100
            "#,
        )
        .map_err(|error| format!("无法读取 MCP 分析: {error}"))?;
    let rows = statement
        .query_map([since], |row| {
            Ok(McpUsage {
                server: row.get(0)?,
                tool: row.get(1)?,
                calls: row.get(2)?,
                argument_chars: row.get(3)?,
                result_chars: row.get(4)?,
                estimated_tokens: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取 MCP 分析: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 MCP 分析: {error}"))
}

fn source_for(
    turn: &TurnRow,
    plugin_sources: &HashMap<String, (String, String)>,
) -> (String, String) {
    if let Some(source) = plugin_sources.get(&format!("turn:{}", turn.turn_id)) {
        return source.clone();
    }
    if let Some(source) = plugin_sources.get(&format!("thread:{}", turn.thread_id)) {
        return source.clone();
    }
    if turn.trigger.as_deref() == Some("quick-agent") {
        return ("builtin.quick-agent".to_string(), "快捷 Agent".to_string());
    }
    ("codex-harness".to_string(), "Codex Harness".to_string())
}

fn plugin_label(plugin_id: &str) -> &str {
    match plugin_id {
        "builtin.quick-agent" => "快捷 Agent",
        "builtin.temporary-agent" => "Luna",
        "builtin.seatalk" => "SeaTalk",
        _ => plugin_id,
    }
}

fn add_tokens(target: &mut SerializableTokens, value: &SerializableTokens) {
    target.total_tokens += value.total_tokens;
    target.input_tokens += value.input_tokens;
    target.cached_input_tokens += value.cached_input_tokens;
    target.cache_write_input_tokens += value.cache_write_input_tokens;
    target.output_tokens += value.output_tokens;
    target.reasoning_output_tokens += value.reasoning_output_tokens;
}

fn enqueue_official_if_enabled(
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

fn run_official_counter(
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

fn count_local_tokens(text: &str) -> u64 {
    tiktoken_rs::o200k_base_singleton()
        .encode_ordinary(text)
        .len() as u64
}

fn estimate_tokens_heuristic(text: &str) -> u64 {
    let mut cjk = 0_u64;
    let mut ascii_word_chars = 0_u64;
    let mut punctuation = 0_u64;
    for character in text.chars() {
        if is_cjk(character) {
            cjk += 1;
        } else if character.is_ascii_alphanumeric() || character == '_' {
            ascii_word_chars += 1;
        } else if !character.is_whitespace() {
            punctuation += 1;
        }
    }
    cjk + ascii_word_chars.div_ceil(4) + punctuation.div_ceil(2)
}

fn estimate_token_count_from_chars(chars: u64) -> u64 {
    chars.div_ceil(4)
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x30FF | 0xAC00..=0xD7AF)
}

fn json_chars(value: &Value) -> u64 {
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

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}

fn u64_field(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or_default()
}

fn normalize_range(range: &str) -> &'static str {
    match range {
        "7d" => "7d",
        "30d" => "30d",
        _ => "all",
    }
}

fn range_since_ms(range: &str) -> i64 {
    let days = match range {
        "7d" => 7,
        "30d" => 30,
        _ => return 0,
    };
    now_ms().saturating_sub(days * 24 * 60 * 60 * 1_000)
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
        env,
        io::{Read, Write},
        net::TcpListener,
        process,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    fn test_dir() -> PathBuf {
        env::temp_dir().join(format!(
            "codex-harness-analytics-test-{}-{}",
            process::id(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn local_counter_handles_chinese_and_ascii_without_network_access() {
        assert_eq!(count_local_tokens("hello world"), 2);
        assert!(count_local_tokens("你好 world") > 0);
        assert_eq!(estimate_tokens_heuristic("你好 world"), 4);
        let payload = serde_json::json!({ "中文": "line\n\"quoted\"", "items": [1, true] });
        assert_eq!(
            json_chars(&payload),
            serde_json::to_string(&payload)
                .expect("serializes fixture")
                .chars()
                .count() as u64
        );
    }

    #[test]
    fn disabled_collector_fails_open_without_collecting_turns() {
        let analytics = CodexAnalytics::disabled(test_dir().join("state.sqlite"));
        assert!(analytics
            .prepare_turn(&serde_json::json!({ "threadId": "thread-1" }))
            .is_none());
        assert!(analytics.snapshot("all").is_err());
    }

    #[test]
    fn official_counter_returns_count_without_blocking_the_caller() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("binds mock server");
        let endpoint = format!(
            "http://{}/v1/responses/input_tokens",
            listener.local_addr().expect("has address")
        );
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accepts request");
            let mut request = [0_u8; 8_192];
            let read = stream.read(&mut request).expect("reads request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("fixture text"));
            let body = r#"{"object":"response.input_tokens","input_tokens":37}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("writes response");
        });
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let mode = Arc::new(AtomicU8::new(CounterMode::Official as u8));
        let stats = Arc::new(OfficialStats::default());
        let worker_mode = mode.clone();
        let worker_stats = stats.clone();
        let worker = thread::spawn(move || {
            run_official_counter(
                request_receiver,
                result_sender,
                worker_mode,
                Some("test-key".to_string()),
                worker_stats,
                &endpoint,
            )
        });
        request_sender
            .try_send(OfficialCountRequest {
                target: OfficialTarget::Turn {
                    turn_id: "turn-1".to_string(),
                },
                model: "gpt-test".to_string(),
                text: "fixture text".to_string(),
            })
            .expect("queues without waiting");
        drop(request_sender);
        let event = result_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("receives official result");
        assert!(matches!(
            event,
            AnalyticsEvent::OfficialCount(OfficialCountResult { tokens: 37, .. })
        ));
        assert_eq!(stats.requests.load(Ordering::Relaxed), 1);
        assert_eq!(stats.successes.load(Ordering::Relaxed), 1);
        server.join().expect("mock server exits");
        worker.join().expect("counter exits");
    }

    #[test]
    fn stores_only_counts_and_accumulates_last_usage() {
        let root = test_dir();
        let analytics = CodexAnalytics::open(&root).expect("opens analytics");
        let pending = analytics
            .prepare_turn(&serde_json::json!({
                "threadId": "thread-1",
                "input": [{ "type": "text", "text": "private prompt" }]
            }))
            .expect("prepares turn");
        analytics.record_turn_start(pending, &serde_json::json!({ "turn": { "id": "turn-1" } }));
        for total in [12, 8] {
            analytics.record_notification(
                Some("thread/tokenUsage/updated"),
                &serde_json::json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "tokenUsage": {
                        "total": { "totalTokens": 999_999 },
                        "last": { "totalTokens": total, "inputTokens": total - 2, "outputTokens": 2 }
                    }
                }),
            );
        }
        for status in ["inProgress", "completed"] {
            analytics.record_notification(
                Some("item/completed"),
                &serde_json::json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "mcpToolCall",
                        "id": "call-1",
                        "server": "test-server",
                        "tool": "lookup",
                        "status": status,
                        "arguments": { "private": "mcp-secret-a" },
                        "result": { "private": "mcp-secret-b" }
                    }
                }),
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let snapshot = loop {
            let snapshot = analytics.snapshot("all").expect("reads snapshot");
            if snapshot.summary.turns == 1 && snapshot.summary.usage_updates == 2 {
                break snapshot;
            }
            assert!(Instant::now() < deadline, "analytics writer did not drain");
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(snapshot.summary.turns, 1);
        assert_eq!(snapshot.summary.usage_updates, 2);
        assert_eq!(snapshot.summary.actual.total_tokens, 20);
        assert_eq!(snapshot.mcp_tools.len(), 1);
        assert_eq!(snapshot.mcp_tools[0].calls, 1);
        let bytes = fs::read(root.join("state.sqlite")).expect("reads test database");
        assert!(!String::from_utf8_lossy(&bytes).contains("private prompt"));
        assert!(!String::from_utf8_lossy(&bytes).contains("mcp-secret-a"));
        assert!(!String::from_utf8_lossy(&bytes).contains("mcp-secret-b"));
        let _ = fs::remove_dir_all(root);
    }
}
