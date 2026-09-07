//! Execution-time accounting. Only confirmed Harness turns enter the ledger.
//! Content is transient; SQLite contains identities, labels and numeric counts only.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        mpsc::{self, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod counter;
mod query;
use counter::*;
pub use query::{AnalyticsQuery, AnalyticsSnapshot};
const LOCAL_ESTIMATOR_VERSION: &str = "tiktoken-rs/0.12.0:o200k_base";
const OFFICIAL_TIMEOUT: Duration = Duration::from_secs(5);
const OFFICIAL_MIN_INTERVAL: Duration = Duration::from_millis(250);
const OFFICIAL_ENDPOINT: &str = "https://api.openai.com/v1/responses/input_tokens";
const MAX_COUNTED_TEXT_BYTES: usize = 65_536;
const EVENT_QUEUE_CAPACITY: usize = 256;

#[derive(Clone, Copy)]
enum CounterMode {
    Local = 0,
    Official = 1,
}
#[derive(Default)]
struct OfficialStats {
    requests: AtomicU64,
    successes: AtomicU64,
    failures: AtomicU64,
    fallbacks: AtomicU64,
}
#[derive(Debug)]
struct OfficialTarget {
    event_id: String,
    column: &'static str,
}
struct OfficialCountRequest {
    target: OfficialTarget,
    model: String,
    text: String,
}
struct OfficialCountResult {
    target: OfficialTarget,
    tokens: u64,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCounterStatus {
    mode: &'static str,
    api_key_configured: bool,
    local_estimator: &'static str,
}
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Tokens {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}
#[derive(Default)]
struct Settings {
    model: Option<String>,
    effort: Option<String>,
    cwd: Option<String>,
}
pub(crate) struct PendingTurnObservation {
    append: bool,
    input_group: String,
    thread_id: String,
    at: i64,
    settings: Settings,
    source: String,
    inputs: Vec<Input>,
}
struct Input {
    kind: &'static str,
    name: String,
    path: Option<PathBuf>,
    text: Option<String>,
}
struct Observation {
    thread_id: String,
    turn_id: String,
    at: i64,
    body: Body,
}
enum Body {
    Usage {
        last: Tokens,
        total: Tokens,
    },
    Mcp {
        id: String,
        name: String,
        status: String,
        arguments: Option<String>,
        result: Option<String>,
    },
    Read {
        id: String,
        cwd: String,
        paths: Vec<String>,
        output: Option<String>,
        success: bool,
    },
    Reroute,
    Complete(String),
    Child {
        ids: Vec<String>,
        model: Option<String>,
    },
    Started,
}
enum AnalyticsEvent {
    Begin(String),
    Cancel(String),
    Start(PendingTurnObservation, String),
    Settings(String, Settings),
    Catalog(Vec<(PathBuf, String)>),
    Observation(Observation),
    OfficialCount(OfficialCountResult),
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn bounded(text: &str) -> Option<String> {
    (text.len() <= MAX_COUNTED_TEXT_BYTES).then(|| text.to_owned())
}
fn json_text(value: Option<&Value>) -> Option<String> {
    let v = value.filter(|v| !v.is_null())?;
    if json_chars(v) > MAX_COUNTED_TEXT_BYTES as u64 {
        return None;
    }
    bounded(&serde_json::to_string(v).ok()?)
}
fn settings(params: &Value) -> Settings {
    let collaboration = params.pointer("/collaborationMode/settings");
    Settings {
        model: collaboration
            .and_then(|s| string_field(s, "model"))
            .or_else(|| string_field(params, "model")),
        effort: collaboration
            .and_then(|s| string_field(s, "reasoning_effort"))
            .or_else(|| string_field(params, "effort"))
            .or_else(|| string_field(params, "reasoningEffort")),
        cwd: string_field(params, "cwd"),
    }
}
impl CodexAnalytics {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let path = root.join("state.sqlite");
        let db = open_connection(&path)?;
        initialize_schema(&db).map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let (official_tx, official_rx) = mpsc::sync_channel(32);
        let mut result = Self::disabled(path.clone());
        result.events = Some(tx.clone());
        result.write_errors.store(0, Ordering::Relaxed);
        let errors = result.write_errors.clone();
        let dropped = result.dropped_events.clone();
        let mode = result.counter_mode.clone();
        let stats = result.official_stats.clone();
        thread::Builder::new()
            .name("codex-analytics-writer".into())
            .spawn(move || {
                let Ok(db) = open_connection(&path) else {
                    errors.fetch_add(1, Ordering::Relaxed);
                    return;
                };
                let mut writer = Writer::default();
                while let Ok(event) = rx.recv() {
                    if writer
                        .handle(&db, event, &mode, &official_tx, &stats, &dropped)
                        .is_err()
                    {
                        errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        result.api_key_configured = api_key.is_some();
        let mode = result.counter_mode.clone();
        let stats = result.official_stats.clone();
        thread::Builder::new()
            .name("codex-analytics-counter".into())
            .spawn(move || {
                run_official_counter(official_rx, tx, mode, api_key, stats, OFFICIAL_ENDPOINT)
            })
            .map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub fn disabled(database_path: PathBuf) -> Self {
        Self {
            database_path,
            events: None,
            dropped_events: Arc::new(AtomicU64::new(0)),
            write_errors: Arc::new(AtomicU64::new(1)),
            counter_mode: Arc::new(AtomicU8::new(0)),
            api_key_configured: false,
            official_stats: Arc::new(OfficialStats::default()),
        }
    }
    pub fn configure(&self, mode: &str) -> Result<AnalyticsCounterStatus, String> {
        let value = match mode {
            "local" => CounterMode::Local,
            "official" => CounterMode::Official,
            _ => return Err("不支持的计数方式".into()),
        };
        self.counter_mode.store(value as u8, Ordering::Relaxed);
        Ok(self.counter_status())
    }
    fn counter_status(&self) -> AnalyticsCounterStatus {
        AnalyticsCounterStatus {
            mode: if self.counter_mode.load(Ordering::Relaxed) == 1 {
                "official"
            } else {
                "local"
            },
            api_key_configured: self.api_key_configured,
            local_estimator: LOCAL_ESTIMATOR_VERSION,
        }
    }
    fn enqueue(&self, event: AnalyticsEvent) {
        if self
            .events
            .as_ref()
            .is_some_and(|tx| tx.try_send(event).is_err())
        {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub(crate) fn prepare_turn(&self, params: &Value) -> Option<PendingTurnObservation> {
        self.events.as_ref()?;
        let thread_id = string_field(params, "threadId")?;
        let mut inputs = Vec::new();
        let mut remaining = MAX_COUNTED_TEXT_BYTES;
        for input in params
            .get("input")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(128)
        {
            match input.get("type").and_then(Value::as_str) {
                Some("text") => inputs.push(Input {
                    kind: "input",
                    name: "用户输入".into(),
                    path: None,
                    text: input.get("text").and_then(Value::as_str).and_then(|text| {
                        if text.len() > remaining {
                            None
                        } else {
                            remaining -= text.len();
                            Some(text.to_owned())
                        }
                    }),
                }),
                Some("skill") => {
                    if let (Some(name), Some(path)) =
                        (string_field(input, "name"), string_field(input, "path"))
                    {
                        inputs.push(Input {
                            kind: "skill",
                            name,
                            path: Some(PathBuf::from(path)),
                            text: None,
                        });
                    }
                }
                _ => {}
            }
        }
        self.enqueue(AnalyticsEvent::Begin(thread_id.clone()));
        Some(PendingTurnObservation {
            append: false,
            input_group: format!(
                "{:x}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            thread_id,
            at: now_ms(),
            settings: settings(params),
            source: string_field(params, "turnTrigger").unwrap_or_else(|| "conversation".into()),
            inputs,
        })
    }
    pub(crate) fn prepare_steer(&self, params: &Value) -> Option<PendingTurnObservation> {
        let mut pending = self.prepare_turn(params)?;
        pending.append = true;
        Some(pending)
    }
    pub(crate) fn record_turn_start(&self, pending: PendingTurnObservation, response: &Value) {
        if let Some(id) = response
            .pointer("/turn/id")
            .or_else(|| response.get("turnId"))
            .and_then(Value::as_str)
        {
            self.enqueue(AnalyticsEvent::Start(pending, id.into()));
        } else {
            self.cancel_turn_start(pending);
        }
    }
    pub(crate) fn cancel_turn_start(&self, pending: PendingTurnObservation) {
        self.enqueue(AnalyticsEvent::Cancel(pending.thread_id));
    }
    pub fn record_response(&self, method: &str, params: &Value, response: &Value) {
        if method == "skills/list" {
            let catalog = response
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|x| {
                    x.get("skills")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|s| {
                    Some((
                        PathBuf::from(s.get("path")?.as_str()?),
                        s.get("name")?.as_str()?.to_owned(),
                    ))
                })
                .take(10_000)
                .collect();
            self.enqueue(AnalyticsEvent::Catalog(catalog));
        }
        if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
            if let Some(id) = response.pointer("/thread/id").and_then(Value::as_str) {
                let mut s = settings(response);
                let requested = settings(params);
                if s.model.is_none() {
                    s.model = requested.model;
                }
                if s.cwd.is_none() {
                    s.cwd = string_field(response.get("thread").unwrap_or(&Value::Null), "cwd")
                        .or(requested.cwd);
                }
                self.enqueue(AnalyticsEvent::Settings(id.into(), s));
            }
        }
    }
    pub fn record_notification(&self, method: Option<&str>, params: &Value) {
        if self.events.is_none() {
            return;
        }
        let Some(thread_id) = string_field(params, "threadId") else {
            return;
        };
        let Some(turn_id) = string_field(params, "turnId").or_else(|| {
            params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }) else {
            return;
        };
        let body = match method {
            Some("thread/tokenUsage/updated") => {
                let (Some(last), Some(total)) = (
                    params.pointer("/tokenUsage/last"),
                    params.pointer("/tokenUsage/total"),
                ) else {
                    return;
                };
                let (Ok(last), Ok(total)) = (
                    serde_json::from_value(last.clone()),
                    serde_json::from_value(total.clone()),
                ) else {
                    return;
                };
                Body::Usage { last, total }
            }
            Some("model/rerouted") => Body::Reroute,
            Some("turn/completed") => Body::Complete(
                params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .into(),
            ),
            Some("turn/started") => Body::Started,
            Some("item/completed") => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let Some(id) = string_field(item, "id") else {
                    return;
                };
                match item.get("type").and_then(Value::as_str) {
                    Some("mcpToolCall") => {
                        let (Some(server), Some(tool)) =
                            (string_field(item, "server"), string_field(item, "tool"))
                        else {
                            return;
                        };
                        Body::Mcp {
                            id,
                            name: format!("{server} / {tool}"),
                            status: string_field(item, "status")
                                .unwrap_or_else(|| "unknown".into()),
                            arguments: json_text(item.get("arguments")),
                            result: json_text(
                                item.get("result")
                                    .filter(|v| !v.is_null())
                                    .or_else(|| item.get("error")),
                            ),
                        }
                    }
                    Some("commandExecution") => {
                        // App Server supplies parsed reads; never execute or parse arbitrary shell here.
                        let paths = item
                            .get("commandActions")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter(|a| a.get("type").and_then(Value::as_str) == Some("read"))
                            .filter_map(|a| string_field(a, "path"))
                            .take(128)
                            .collect();
                        Body::Read {
                            id,
                            cwd: string_field(item, "cwd").unwrap_or_default(),
                            paths,
                            output: item
                                .get("aggregatedOutput")
                                .and_then(Value::as_str)
                                .and_then(bounded),
                            success: item.get("exitCode").and_then(Value::as_i64) == Some(0),
                        }
                    }
                    Some("collabAgentToolCall" | "collabToolCall")
                        if item.get("tool").and_then(Value::as_str) == Some("spawnAgent")
                            && item.get("status").and_then(Value::as_str) == Some("completed") =>
                    {
                        Body::Child {
                            ids: item
                                .get("receiverThreadIds")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .take(32)
                                .map(str::to_owned)
                                .collect(),
                            model: string_field(item, "model"),
                        }
                    }
                    _ => return,
                }
            }
            _ => return,
        };
        self.enqueue(AnalyticsEvent::Observation(Observation {
            thread_id,
            turn_id,
            at: now_ms(),
            body,
        }));
    }
    pub fn snapshot(&self, query: &AnalyticsQuery) -> Result<AnalyticsSnapshot, String> {
        if self.events.is_none() {
            return Err("分析采集器不可用".into());
        }
        query::snapshot(&open_connection(&self.database_path)?, query, self)
    }
}
fn open_connection(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn initialize_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS analysis_meta (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_turns (turn_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,started_at INTEGER NOT NULL,model TEXT,effort TEXT,source TEXT NOT NULL,project TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'inProgress',uncertain INTEGER NOT NULL DEFAULT 0,rerouted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS analysis_turns_thread ON analysis_turns(thread_id,started_at);
    CREATE TABLE IF NOT EXISTS analysis_children (thread_id TEXT PRIMARY KEY,parent_turn_id TEXT NOT NULL,model TEXT);
    CREATE TABLE IF NOT EXISTS analysis_usage (thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,signature TEXT NOT NULL,at INTEGER NOT NULL,total_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,cache_write_input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,reasoning_output_tokens INTEGER NOT NULL,cumulative INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_id,signature));
    CREATE INDEX IF NOT EXISTS analysis_usage_time ON analysis_usage(at);
    CREATE TABLE IF NOT EXISTS analysis_content (id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,selected INTEGER NOT NULL DEFAULT 0,reads INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,tokens INTEGER,argument_tokens INTEGER,result_tokens INTEGER,estimator TEXT NOT NULL DEFAULT 'local');
    CREATE INDEX IF NOT EXISTS analysis_content_time ON analysis_content(at);
    CREATE INDEX IF NOT EXISTS analysis_content_turn ON analysis_content(turn_id);")?;
    db.execute(
        "INSERT OR IGNORE INTO analysis_meta VALUES(1,?1)",
        [now_ms()],
    )?;
    Ok(())
}
#[derive(Default)]
struct Writer {
    pending: HashMap<String, usize>,
    buffer: VecDeque<Observation>,
    orphans: VecDeque<Observation>,
    settings: HashMap<String, Settings>,
    catalog: HashMap<PathBuf, String>,
}
impl Writer {
    fn handle(
        &mut self,
        db: &Connection,
        event: AnalyticsEvent,
        mode: &AtomicU8,
        official: &SyncSender<OfficialCountRequest>,
        stats: &OfficialStats,
        dropped: &AtomicU64,
    ) -> rusqlite::Result<()> {
        match event {
            AnalyticsEvent::Begin(id) => {
                if self.pending.len() < 128 {
                    *self.pending.entry(id).or_default() += 1;
                } else {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
            AnalyticsEvent::Cancel(id) => self.finish_pending(&id),
            AnalyticsEvent::Settings(id, s) => {
                if self.settings.len() >= 4096 {
                    self.settings.clear();
                }
                self.settings.insert(id, s);
            }
            AnalyticsEvent::Catalog(items) => {
                for (p, n) in items {
                    if self.catalog.len() >= 10_000 {
                        self.catalog.clear();
                    }
                    self.catalog.insert(normalize(&p), n);
                }
            }
            AnalyticsEvent::OfficialCount(result) => {
                let col = result.target.column;
                if matches!(col, "tokens" | "argument_tokens" | "result_tokens") {
                    db.execute(
                        &format!(
                            "UPDATE analysis_content SET {col}=?1,estimator=CASE WHEN kind='mcp' THEN 'official-assisted' ELSE 'official' END WHERE id=?2"
                        ),
                        params![result.tokens, result.target.event_id],
                    )?;
                }
            }
            AnalyticsEvent::Start(mut p, turn_id) => {
                if p.append && !owned(db, &p.thread_id, &turn_id)? {
                    self.finish_pending(&p.thread_id);
                    return Ok(());
                }
                if let Some(s) = self.settings.get(&p.thread_id) {
                    p.settings.model = p.settings.model.or_else(|| s.model.clone());
                    p.settings.cwd = p.settings.cwd.or_else(|| s.cwd.clone());
                    p.settings.effort = p.settings.effort.or_else(|| s.effort.clone());
                }
                let project = p
                    .settings
                    .cwd
                    .as_deref()
                    .and_then(|s| Path::new(s).file_name())
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                db.execute("INSERT OR IGNORE INTO analysis_turns(turn_id,thread_id,started_at,model,effort,source,project) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![turn_id,p.thread_id,p.at,p.settings.model,p.settings.effort,p.source,project])?;
                for (index, input) in p.inputs.into_iter().enumerate() {
                    let text = if let Some(path) = input.path {
                        self.catalog.insert(normalize(&path), input.name.clone());
                        // Count only bounded regular local files; never block on a pipe/device.
                        read_bounded_file(&path)
                    } else {
                        input.text
                    };
                    insert_content(
                        db,
                        &format!("{turn_id}:input:{}:{index}", p.input_group),
                        &turn_id,
                        p.at,
                        input.kind,
                        &input.name,
                        if input.kind == "skill" { 1 } else { 0 },
                        0,
                        "selected",
                        text.as_deref(),
                        None,
                        None,
                        p.settings.model.as_deref(),
                        mode,
                        official,
                        stats,
                    )?;
                }
                self.settings.insert(p.thread_id.clone(), p.settings);
                let mut keep = VecDeque::new();
                while let Some(obs) = self.buffer.pop_front() {
                    if obs.thread_id == p.thread_id && obs.turn_id == turn_id {
                        self.persist_observation(db, obs, mode, official, stats)?;
                    } else {
                        keep.push_back(obs);
                    }
                }
                self.buffer = keep;
                self.finish_pending(&p.thread_id);
            }
            AnalyticsEvent::Observation(obs) => {
                if !owned(db, &obs.thread_id, &obs.turn_id)? {
                    // Server-created descendants are included only with a confirmed parent link.
                    if let Some((parent, model)) = db
                        .query_row(
                            "SELECT parent_turn_id,model FROM analysis_children WHERE thread_id=?1",
                            [&obs.thread_id],
                            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                        )
                        .optional()?
                    {
                        db.execute("INSERT OR IGNORE INTO analysis_turns(turn_id,thread_id,started_at,model,source,project) SELECT ?1,?2,?3,?4,'sub-agent',project FROM analysis_turns WHERE turn_id=?5",params![obs.turn_id,obs.thread_id,obs.at,model,parent])?;
                    } else if self.pending.contains_key(&obs.thread_id) {
                        if self.buffer.len() < 128 {
                            self.buffer.push_back(obs);
                        } else {
                            dropped.fetch_add(1, Ordering::Relaxed);
                        }
                        return Ok(());
                    } else {
                        // A spawned child may emit before the parent's completed spawn item.
                        // Keep only a bounded transient window; unlinked observations never persist.
                        self.orphans
                            .retain(|o| obs.at.saturating_sub(o.at) < 30_000);
                        if self.orphans.len() >= 128 {
                            self.orphans.pop_front();
                        }
                        self.orphans.push_back(obs);
                        return Ok(());
                    }
                }
                self.persist_observation(db, obs, mode, official, stats)?;
            }
        }
        Ok(())
    }
    fn finish_pending(&mut self, id: &str) {
        if let Some(n) = self.pending.get_mut(id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.pending.remove(id);
                self.buffer.retain(|o| o.thread_id != id);
            }
        }
    }
    fn persist_observation(
        &mut self,
        db: &Connection,
        obs: Observation,
        mode: &AtomicU8,
        official: &SyncSender<OfficialCountRequest>,
        stats: &OfficialStats,
    ) -> rusqlite::Result<()> {
        let model: Option<String> = db.query_row(
            "SELECT model FROM analysis_turns WHERE turn_id=?1",
            [&obs.turn_id],
            |r| r.get(0),
        )?;
        match obs.body {
            Body::Usage { last, total } => {
                // Persist the cumulative signature solely as an idempotency key. Never sum it.
                let signature = serde_json::to_string(&total).unwrap_or_default();
                let seen:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM analysis_usage WHERE thread_id=?1 AND turn_id=?2 AND signature=?3)",params![obs.thread_id,obs.turn_id,signature],|r|r.get(0))?;
                if seen {
                    return Ok(());
                }
                let high:i64=db.query_row("SELECT COALESCE(MAX(cumulative),0) FROM analysis_usage WHERE thread_id=?1 AND turn_id=?2",params![obs.thread_id,obs.turn_id],|r|r.get(0))?;
                // A rewind/reset/late notification is ambiguous without a response ID. Do not guess.
                if high > 0 && total.total_tokens <= high as u64 {
                    db.execute(
                        "UPDATE analysis_turns SET uncertain=1 WHERE turn_id=?1",
                        [&obs.turn_id],
                    )?;
                    return Ok(());
                }
                if high > 0 && total.total_tokens.saturating_sub(high as u64) != last.total_tokens {
                    db.execute(
                        "UPDATE analysis_turns SET uncertain=1 WHERE turn_id=?1",
                        [&obs.turn_id],
                    )?;
                }
                db.execute("INSERT OR IGNORE INTO analysis_usage VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![obs.thread_id,obs.turn_id,signature,obs.at,last.total_tokens,last.input_tokens,last.cached_input_tokens,last.cache_write_input_tokens,last.output_tokens,last.reasoning_output_tokens,total.total_tokens])?;
            }
            Body::Mcp {
                id,
                name,
                status,
                arguments,
                result,
            } => {
                insert_content(
                    db,
                    &format!("{}:mcp:{id}", obs.turn_id),
                    &obs.turn_id,
                    obs.at,
                    "mcp",
                    &name,
                    0,
                    0,
                    &status,
                    None,
                    arguments.as_deref(),
                    result.as_deref(),
                    model.as_deref(),
                    mode,
                    official,
                    stats,
                )?;
            }
            Body::Read {
                id,
                cwd,
                paths,
                output,
                success,
            } => {
                if !success {
                    return Ok(());
                }
                let single = paths.len() == 1;
                for path in paths {
                    let path = normalize(&Path::new(&cwd).join(path));
                    let (kind, name) = match path.file_name().and_then(|s| s.to_str()) {
                        Some("SKILL.md") => match self.catalog.get(&path) {
                            Some(name) => ("skill", name.clone()),
                            None => (
                                "skill",
                                format!(
                                    "{} / SKILL.md",
                                    path.parent()
                                        .and_then(Path::file_name)
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                ),
                            ),
                        },
                        Some("AGENTS.md" | "AGENTS.override.md") => (
                            "agents",
                            format!(
                                "{} / {}",
                                path.parent()
                                    .and_then(Path::file_name)
                                    .unwrap_or_default()
                                    .to_string_lossy(),
                                path.file_name().unwrap_or_default().to_string_lossy()
                            ),
                        ),
                        _ => continue,
                    };
                    let key = format!("{}:read:{id}:{}", obs.turn_id, path.display());
                    // The persisted id hashes the path; full Skill paths are never stored.
                    let event_id =
                        format!("{}:read:{id}:{:016x}", obs.turn_id, identity_hash(&key));
                    insert_content(
                        db,
                        &event_id,
                        &obs.turn_id,
                        obs.at,
                        kind,
                        &name,
                        0,
                        1,
                        "completed",
                        if single { output.as_deref() } else { None },
                        None,
                        None,
                        model.as_deref(),
                        mode,
                        official,
                        stats,
                    )?;
                }
            }
            Body::Reroute => {
                db.execute(
                    "UPDATE analysis_turns SET rerouted=1 WHERE turn_id=?1",
                    [obs.turn_id],
                )?;
            }
            Body::Complete(status) => {
                db.execute(
                    "UPDATE analysis_turns SET status=?1 WHERE turn_id=?2",
                    params![status, obs.turn_id],
                )?;
            }
            Body::Child { ids, model } => {
                for id in ids {
                    if id != obs.thread_id {
                        db.execute(
                            "INSERT OR IGNORE INTO analysis_children VALUES(?1,?2,?3)",
                            params![id, obs.turn_id, model],
                        )?;
                        let mut matching = Vec::new();
                        let mut remaining = VecDeque::new();
                        while let Some(early) = self.orphans.pop_front() {
                            if early.thread_id == id {
                                matching.push(early);
                            } else {
                                remaining.push_back(early);
                            }
                        }
                        self.orphans = remaining;
                        for early in matching {
                            db.execute("INSERT OR IGNORE INTO analysis_turns(turn_id,thread_id,started_at,model,source,project) SELECT ?1,?2,?3,?4,'sub-agent',project FROM analysis_turns WHERE turn_id=?5",params![early.turn_id,id,early.at,model,obs.turn_id])?;
                            self.persist_observation(db, early, mode, official, stats)?;
                        }
                    }
                }
            }
            Body::Started => {}
        }
        Ok(())
    }
}
fn identity_hash(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(c.as_os_str()),
        }
    }
    out
}
fn read_bounded_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_COUNTED_TEXT_BYTES as u64 {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_COUNTED_TEXT_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .ok()?;
    bounded(&text)
}
fn owned(db: &Connection, thread: &str, turn: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM analysis_turns WHERE thread_id=?1 AND turn_id=?2)",
        params![thread, turn],
        |r| r.get(0),
    )
}
#[allow(clippy::too_many_arguments)]
fn insert_content(
    db: &Connection,
    id: &str,
    turn: &str,
    at: i64,
    kind: &str,
    name: &str,
    selected: u64,
    reads: u64,
    status: &str,
    text: Option<&str>,
    arguments: Option<&str>,
    result: Option<&str>,
    model: Option<&str>,
    mode: &AtomicU8,
    official: &SyncSender<OfficialCountRequest>,
    stats: &OfficialStats,
) -> rusqlite::Result<()> {
    let added=db.execute("INSERT OR IGNORE INTO analysis_content(id,turn_id,at,kind,name,selected,reads,status,tokens,argument_tokens,result_tokens) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,turn,at,kind,name,selected,reads,status,text.map(count_local_tokens),arguments.map(count_local_tokens),result.map(count_local_tokens)])?;
    if added > 0 {
        if let Some(model) = model {
            for (column, text) in [
                ("tokens", text),
                ("argument_tokens", arguments),
                ("result_tokens", result),
            ] {
                if let Some(text) = text {
                    enqueue_official_if_enabled(
                        mode,
                        official,
                        stats,
                        OfficialCountRequest {
                            target: OfficialTarget {
                                event_id: id.into(),
                                column,
                            },
                            model: model.into(),
                            text: text.into(),
                        },
                    );
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests;
