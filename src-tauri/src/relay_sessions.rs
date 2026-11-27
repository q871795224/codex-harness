//! 路由会话（relay session）。
//!
//! 只有在专用目录创建的 Codex 会话会注册派活工具并写入固定指令；子会话是普通会话，
//! 只记录父子关系。父会话派出的轮次结束后，经异步等待的 `Target::Session` 自动回调父会话。
//! 身份只来自 App Server 回调信封，工具参数不接受父会话 ID。
use crate::{
    app_server::{AppServerManager, WaitThreadState},
    async_waits::{AsyncWaits, CreateWait, Target},
    store::HarnessStore,
    turn_ownership::TurnOwnership,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const SPAWN: &str = "harness_session_spawn";
pub const SEND: &str = "harness_session_send";
pub const READ: &str = "harness_session_read";
pub const LIST: &str = "harness_session_list";
/// 每个路由会话同时等待回调的子会话上限。
pub const MAX_RUNNING: usize = 6;
pub const DISPATCH_TRIGGER: &str = "relay-dispatch";
const CALLBACK_REPLY_CHARS: usize = 1500;
const READ_REPLY_CHARS: usize = 6000;
const READ_REQUEST_CHARS: usize = 1200;
const READ_TOTAL_CHARS: usize = 40_000;
const READ_RECENT_TURNS: u32 = 30;

const DISPATCH_HEADER: &str = "【路由会话派发】这条任务由路由会话转交给你。你是执行任务的普通会话：直接完成任务，需要用户决定或授权时停下来说明，不要自行扩大授权。";
/// 子会话汇报格式提示。效果待观察，后续调整见 `.harness/memory.md` 待办。
pub const REPORT_FORMAT: &str = "完成后用 3–5 行汇报：结论；需要用户决定或处理的事（没有就写“无”）；关键产物的链接或路径。不要复述过程。";

pub const DEVELOPER_INSTRUCTIONS: &str = "你是 Codex Harness 的路由会话。用户在这里说的事，默认是希望你交给子会话去完成，由你负责转达和整理。

- 你只负责理解需求、拆分派活、转达用户决定、整理子会话结果。不要自己读代码、改文件、跑命令或操作外部系统；用户只问进度或已有结论时，用 harness_session_list / harness_session_read 回答。
- 每件独立的事用 harness_session_spawn 开一个子会话，cwd 填这件事对应的仓库或目录（harness_session_list 会列出已知工作区）。同一件事的追问、补充和用户决定，用 harness_session_send 发给原来的子会话。
- 派完活就结束本轮。不要轮询、sleep 或等待，不要读子会话的会话文件，也不要用 CLI 查子会话状态。子会话完成你派出的那一轮后，Harness 会自动把它的汇报作为新消息送回本会话。
- 子会话需要用户决定或授权时，把问题简短地转给用户，不替用户决定，不扩大用户给出的授权。用户可能直接在子会话里对话，需要时用 harness_session_read 查看。
- 回复用户时第一句给结论。涉及多个子会话时每个一行：子会话名、状态、下一步；需要用户做的事单独一行。不复述子会话的过程。";

pub fn is_tool(name: &str) -> bool {
    matches!(name, SPAWN | SEND | READ | LIST)
}

pub fn workspace_path(data_dir: &Path) -> PathBuf {
    data_dir.join("workspaces").join("relay")
}

pub fn directory_at(data_dir: &Path) -> Result<String, String> {
    let path = workspace_path(data_dir);
    std::fs::create_dir_all(&path).map_err(|error| format!("无法创建路由会话目录：{error}"))?;
    path.canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("无法解析路由会话目录：{error}"))
}

pub fn definitions() -> Value {
    json!([
        {"type":"function","name":SPAWN,"description":"Open a new child conversation in Codex Harness and dispatch its first task. Returns immediately; end your turn after dispatching. When the child finishes this task, Harness automatically sends its report back to this conversation. Never poll or wait. At most 6 children may be running at once.",
         "inputSchema":{"type":"object","properties":{
            "title":{"type":"string","description":"Short child conversation name shown to the user."},
            "task":{"type":"string","description":"Complete, self-contained task for the child. Include the context and constraints it needs."},
            "cwd":{"type":"string","description":"Absolute path of the repository or directory the child should work in."},
            "model":{"type":"string","description":"Optional model id; omit to use the Harness default."}},
          "required":["title","task","cwd"],"additionalProperties":false}},
        {"type":"function","name":SEND,"description":"Send a follow-up message, clarification or user decision to one of your child conversations. Returns immediately; Harness calls back with the child's report when that turn finishes. Fails while the child is still running.",
         "inputSchema":{"type":"object","properties":{
            "threadId":{"type":"string","description":"Child conversation id from harness_session_spawn or harness_session_list."},
            "message":{"type":"string"}},
          "required":["threadId","message"],"additionalProperties":false}},
        {"type":"function","name":READ,"description":"Read a child conversation's turns that you have not seen yet: each turn's request and final reply, without intermediate steps. Includes turns the user had directly in the child. Harness tracks what you have already read; pass all=true to re-read recent history.",
         "inputSchema":{"type":"object","properties":{
            "threadId":{"type":"string"},
            "all":{"type":"boolean"}},
          "required":["threadId"],"additionalProperties":false}},
        {"type":"function","name":LIST,"description":"List your child conversations with their current status, and the known workspaces you can use as cwd.",
         "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ])
}

fn relay_key(thread: &str) -> String {
    format!("relaySession:{thread}")
}
fn children_key(parent: &str) -> String {
    format!("relayChildren:{parent}")
}
fn parent_key(child: &str) -> String {
    format!("relayParent:{child}")
}
fn dispatched_key(child: &str) -> String {
    format!("relayDispatched:{child}")
}
fn seen_key(parent: &str, child: &str) -> String {
    format!("relaySeen:{parent}:{child}")
}

pub fn is_relay(store: &HarnessStore, thread: &str) -> Result<bool, String> {
    Ok(store.get_app_state(&relay_key(thread))?.as_deref() == Some("1"))
}
/// Only mark after App Server accepted the relay definitions.
pub fn mark_relay(store: &HarnessStore, thread: &str) -> Result<(), String> {
    store.set_app_state(&relay_key(thread), "1")
}
pub fn parent_of(store: &HarnessStore, child: &str) -> Result<Option<String>, String> {
    store.get_app_state(&parent_key(child))
}

/// Annotate relay roots and children so the UI can tell them apart.
pub fn annotate(store: &HarnessStore, response: &mut Value) -> Result<(), String> {
    let mark = |thread: &mut Value| -> Result<(), String> {
        let Some(id) = thread["id"].as_str().map(str::to_owned) else {
            return Ok(());
        };
        if is_relay(store, &id)? {
            thread["harnessRelay"] = json!(true);
        }
        if let Some(parent) = parent_of(store, &id)? {
            thread["harnessRelayParent"] = json!(parent);
        }
        Ok(())
    };
    if let Some(thread) = response.get_mut("thread") {
        mark(thread)?;
    }
    if let Some(threads) = response.get_mut("data").and_then(Value::as_array_mut) {
        for thread in threads {
            mark(thread)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Child {
    pub thread_id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: u64,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(
    store: &HarnessStore,
    key: &str,
) -> Result<T, String> {
    match store.get_app_state(key)? {
        Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        None => Ok(T::default()),
    }
}
fn write_json<T: Serialize>(store: &HarnessStore, key: &str, value: &T) -> Result<(), String> {
    store.set_app_state(key, &serde_json::to_string(value).map_err(|e| e.to_string())?)
}
pub fn children(store: &HarnessStore, parent: &str) -> Result<Vec<Child>, String> {
    read_json(store, &children_key(parent))
}
fn record_child(store: &HarnessStore, parent: &str, child: Child) -> Result<(), String> {
    let mut list = children(store, parent)?;
    list.retain(|c| c.thread_id != child.thread_id);
    store.set_app_state(&parent_key(&child.thread_id), parent)?;
    list.push(child);
    write_json(store, &children_key(parent), &list)
}
fn push_capped(store: &HarnessStore, key: &str, ids: &[String], cap: usize) -> Result<(), String> {
    let mut list: Vec<String> = read_json(store, key)?;
    for id in ids {
        if !list.contains(id) {
            list.push(id.clone());
        }
    }
    if list.len() > cap {
        list.drain(..list.len() - cap);
    }
    write_json(store, key, &list)
}

/// A finished child turn, reduced to what the parent needs.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnReport {
    pub thread_id: String,
    pub turn_id: String,
    pub status: String,
    pub request: String,
    pub reply: String,
}
fn status_label(status: &str) -> &'static str {
    match status {
        "completed" => "已完成",
        "failed" => "失败",
        "interrupted" => "被中断",
        "inProgress" => "执行中",
        "unavailable" => "子会话不可用",
        _ => "已结束",
    }
}
fn truncate(text: &str, max: usize) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_owned();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…（已截断，共 {total} 字）")
}
impl TurnReport {
    /// Stored as the wait observation and rendered into the callback turn.
    pub fn callback_summary(&self) -> String {
        let reply = if self.reply.trim().is_empty() {
            "（没有最终回复）".to_owned()
        } else {
            truncate(self.reply.trim(), CALLBACK_REPLY_CHARS)
        };
        format!(
            "threadId: {}\n状态：{}\n{}",
            self.thread_id,
            status_label(&self.status),
            reply
        )
    }
}

pub fn callback_message(items: &[(&str, &str)]) -> String {
    let body = items
        .iter()
        .map(|(title, summary)| format!("## {}\n{}", title.replace(['\n', '\r'], " "), summary))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("Harness 路由回调：以下子会话完成了你派出的任务。\n\n{body}\n\n汇报被截断或需要查看用户在子会话里的直接对话时，用 harness_session_read。按路由会话规则整理后回复用户；需要继续派活就用 harness_session_send。")
}

fn text_of_user(item: &Value) -> String {
    item["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn strip_dispatch(text: &str) -> String {
    text.replace(DISPATCH_HEADER, "")
        .replace(REPORT_FORMAT, "")
        .trim()
        .to_owned()
}
pub fn parse_turn(thread: &str, turn: &Value) -> TurnReport {
    let items = turn["items"].as_array().cloned().unwrap_or_default();
    let request = items
        .iter()
        .find(|item| item["type"] == "userMessage")
        .map(text_of_user)
        .unwrap_or_default();
    let agent = |final_only: bool| {
        items
            .iter()
            .rev()
            .filter(|item| item["type"] == "agentMessage")
            .find(|item| !final_only || item["phase"] == "final_answer")
            .and_then(|item| item["text"].as_str())
            .map(str::to_owned)
    };
    let mut reply = agent(true).or_else(|| agent(false)).unwrap_or_default();
    if reply.is_empty() {
        if let Some(error) = turn.pointer("/error/message").and_then(Value::as_str) {
            reply = format!("错误：{error}");
        }
    }
    TurnReport {
        thread_id: thread.to_owned(),
        turn_id: turn["id"].as_str().unwrap_or_default().to_owned(),
        status: turn["status"].as_str().unwrap_or("unknown").to_owned(),
        request: strip_dispatch(&request),
        reply,
    }
}

fn unavailable(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("no rollout found") || lower.contains("not found") || lower.contains("archived")
}

/// `None` while the turn is still running (or not yet persisted).
pub async fn finished_turn(
    server: &AppServerManager,
    thread: &str,
    turn: &str,
) -> Result<Option<TurnReport>, String> {
    let gone = |summary: &str| TurnReport {
        thread_id: thread.to_owned(),
        turn_id: turn.to_owned(),
        status: "unavailable".into(),
        request: String::new(),
        reply: summary.to_owned(),
    };
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let mut params = json!({"threadId":thread,"limit":10,"sortDirection":"desc","itemsView":"summary"});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = match server.request("thread/turns/list".into(), params).await {
            Ok(page) => page,
            Err(error) if unavailable(&error) => {
                return Ok(Some(gone("子会话已归档、删除或无法读取。")))
            }
            Err(error) => return Err(error),
        };
        for item in page["data"].as_array().into_iter().flatten() {
            if item["id"] == turn {
                if item["status"] == "inProgress" {
                    return Ok(None);
                }
                return Ok(Some(parse_turn(thread, item)));
            }
        }
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SpawnArgs {
    title: String,
    task: String,
    cwd: String,
    #[serde(default)]
    model: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SendArgs {
    thread_id: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadArgs {
    thread_id: String,
    #[serde(default)]
    all: bool,
}

fn response(success: bool, value: Value) -> Value {
    json!({"success":success,"contentItems":[{"type":"inputText","text":value.to_string()}]})
}
fn random_id() -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}
fn now() -> u64 {
    crate::async_waits::now()
}
fn permission_prefs(store: &HarnessStore, thread: &str) -> Result<Option<Value>, String> {
    let Some(raw) = store.get_app_state(&format!("threadPermissions.v1:{thread}"))? else {
        return Ok(None);
    };
    let saved: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let mut prefs = json!({});
    for key in ["approvalPolicy", "approvalsReviewer", "sandbox"] {
        if let Some(value) = saved.get(key).filter(|v| v.is_string()) {
            prefs[key] = value.clone();
        }
    }
    Ok((prefs.as_object().is_some_and(|o| !o.is_empty())).then_some(prefs))
}
pub fn validate_cwd(cwd: &str, relay_dir: Option<&Path>) -> Result<String, String> {
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("cwd 必须是绝对路径".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("cwd 不存在或无法访问：{cwd}"))?;
    if !canonical.is_dir() {
        return Err("cwd 必须是目录".into());
    }
    if relay_dir.is_some_and(|dir| canonical.starts_with(dir)) {
        return Err("子会话不能放在路由会话目录里，请使用实际仓库或目录".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

pub struct RelaySessions {
    store: Arc<HarnessStore>,
    server: Arc<AppServerManager>,
    waits: Arc<AsyncWaits>,
    ownership: Arc<TurnOwnership>,
    relay_dir: Option<PathBuf>,
    // Serialize dispatches so the running limit and call receipts stay consistent.
    dispatch: tokio::sync::Mutex<()>,
}

impl RelaySessions {
    pub fn new(
        store: Arc<HarnessStore>,
        server: Arc<AppServerManager>,
        waits: Arc<AsyncWaits>,
        ownership: Arc<TurnOwnership>,
        relay_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            store,
            server,
            waits,
            ownership,
            relay_dir,
            dispatch: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn execute(&self, params: Value) -> Value {
        match self.execute_inner(&params).await {
            Ok(value) => response(true, value),
            Err(error) => response(false, json!({"error":error})),
        }
    }

    async fn execute_inner(&self, params: &Value) -> Result<Value, String> {
        let required = |key: &str| {
            params[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("工具回调缺少 {key}"))
        };
        let thread = required("threadId")?;
        let turn = required("turnId")?;
        let call = required("callId")?;
        let tool = required("tool")?;
        if !is_relay(&self.store, thread)? {
            return Err("只有路由会话可以使用会话工具".into());
        }
        self.ownership.check(thread, turn)?;
        if params.get("namespace").is_some_and(|v| !v.is_null()) {
            return Err("未知会话工具 namespace".into());
        }
        let args = &params["arguments"];
        if args.to_string().len() > 64 * 1024 {
            return Err("会话工具参数过大".into());
        }
        match tool {
            LIST => {
                serde_json::from_value::<Empty>(args.clone()).map_err(|e| e.to_string())?;
                self.list(thread).await
            }
            READ => {
                let args: ReadArgs =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                self.read(thread, &args).await
            }
            SPAWN | SEND => {
                // Validate before reserving the call identity.
                match tool {
                    SPAWN => {
                        serde_json::from_value::<SpawnArgs>(args.clone())
                            .map_err(|e| e.to_string())?;
                    }
                    _ => {
                        serde_json::from_value::<SendArgs>(args.clone())
                            .map_err(|e| e.to_string())?;
                    }
                }
                let _guard = self.dispatch.lock().await;
                let key = format!("relayCall:{thread}:{call}");
                let argument_json = args.to_string();
                let fingerprint = crate::bundled_skill::version(&[
                    ("tool", tool),
                    ("arguments", &argument_json),
                ]);
                if let Some(receipt) = self.store.get_app_state(&key)? {
                    let receipt: Value =
                        serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
                    if receipt["turnId"] != turn
                        || receipt["tool"] != tool
                        || receipt["fingerprint"] != fingerprint
                    {
                        return Err("工具调用标识冲突".into());
                    }
                    let result = receipt.get("result").cloned().ok_or(
                        "上次派发结果未知，请用 harness_session_list 核对；不会自动重发".to_string(),
                    )?;
                    if let Some(error) = result.get("error").and_then(Value::as_str) {
                        return Err(error.to_owned());
                    }
                    return Ok(result);
                }
                self.store.set_app_state(
                    &key,
                    &json!({"turnId":turn,"tool":tool,"fingerprint":fingerprint}).to_string(),
                )?;
                let result = if tool == SPAWN {
                    let args: SpawnArgs =
                        serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                    self.spawn(thread, args).await
                } else {
                    let args: SendArgs =
                        serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                    self.send(thread, args).await
                };
                // Failures before any side effect are safe to retry under a new call.
                let stored = match &result {
                    Ok(value) => json!({"turnId":turn,"tool":tool,"fingerprint":fingerprint,"result":value}),
                    Err(error) => json!({"turnId":turn,"tool":tool,"fingerprint":fingerprint,"result":{"error":error}}),
                };
                self.store.set_app_state(&key, &stored.to_string())?;
                result
            }
            _ => Err("未知会话工具".into()),
        }
    }

    fn running(&self, parent: &str) -> Result<HashSet<String>, String> {
        Ok(self
            .waits
            .list()?
            .data
            .into_iter()
            .filter(|t| {
                t.thread_id == parent
                    && matches!(t.status.as_str(), "waiting" | "ready" | "dispatching")
            })
            .filter_map(|t| match t.target {
                Target::Session { thread_id, .. } => Some(thread_id),
                _ => None,
            })
            .collect())
    }
    fn delivered_turns(&self, parent: &str, child: &str) -> Result<HashSet<String>, String> {
        Ok(self
            .waits
            .list()?
            .data
            .into_iter()
            .filter(|t| t.thread_id == parent && t.status == "delivered")
            .filter_map(|t| match t.target {
                Target::Session { thread_id, turn_id } if thread_id == child => Some(turn_id),
                _ => None,
            })
            .collect())
    }
    fn own_child(&self, parent: &str, child: &str) -> Result<Child, String> {
        children(&self.store, parent)?
            .into_iter()
            .find(|c| c.thread_id == child)
            .ok_or_else(|| "不是本路由会话的子会话".into())
    }

    async fn spawn(&self, parent: &str, args: SpawnArgs) -> Result<Value, String> {
        let title = args.title.trim().replace(['\n', '\r'], " ");
        if title.is_empty() || title.chars().count() > 80 {
            return Err("title 须为 1–80 字".into());
        }
        if args.task.trim().is_empty() || args.task.len() > 32 * 1024 {
            return Err("task 不能为空，且不超过 32KiB".into());
        }
        let cwd = validate_cwd(&args.cwd, self.relay_dir.as_deref())?;
        if self.running(parent)?.len() >= MAX_RUNNING {
            return Err(format!(
                "已有 {MAX_RUNNING} 个子会话在执行，等回调后再派新任务"
            ));
        }
        let prefs = permission_prefs(&self.store, parent)?;
        let mut start = json!({"cwd":cwd,"runtimeWorkspaceRoots":[cwd]});
        if let Some(prefs) = &prefs {
            for (key, value) in prefs.as_object().into_iter().flatten() {
                start[key] = value.clone();
            }
        }
        if let Some(model) = args.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            start["model"] = json!(model);
        }
        let started = self.server.request("thread/start".into(), start).await?;
        let child = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("新会话未返回 ID")?
            .to_owned();
        if let Some(prefs) = &prefs {
            self.store
                .set_app_state(&format!("threadPermissions.v1:{child}"), &prefs.to_string())?;
        }
        record_child(
            &self.store,
            parent,
            Child {
                thread_id: child.clone(),
                title: title.clone(),
                cwd: cwd.clone(),
                created_at: now(),
            },
        )?;
        let _ = self
            .server
            .request(
                "thread/name/set".into(),
                json!({"threadId":child,"name":title}),
            )
            .await;
        let context = crate::app_server::thread_context(&started);
        let (turn, warning) = self
            .dispatch(parent, &child, &title, &args.task, context)
            .await?;
        Ok(json!({
            "threadId": child, "title": title, "cwd": cwd, "turnId": turn, "status": "running",
            "callbackWarning": warning,
            "next": "已派发。结束本轮即可；子会话完成后 Harness 会自动把汇报送回本会话。"
        }))
    }

    async fn send(&self, parent: &str, args: SendArgs) -> Result<Value, String> {
        let child = self.own_child(parent, &args.thread_id)?;
        if args.message.trim().is_empty() || args.message.len() > 32 * 1024 {
            return Err("message 不能为空，且不超过 32KiB".into());
        }
        let running = self.running(parent)?;
        if running.contains(&child.thread_id) {
            return Err("这个子会话还在处理上一条派发，等回调后再发".into());
        }
        if running.len() >= MAX_RUNNING {
            return Err(format!(
                "已有 {MAX_RUNNING} 个子会话在执行，等回调后再派新任务"
            ));
        }
        let prefs = permission_prefs(&self.store, &child.thread_id)?.map(|p| p.to_string());
        let context = match self
            .server
            .prepare_wait_continuation(&child.thread_id, prefs.as_deref())
            .await?
        {
            WaitThreadState::Busy => {
                return Err("子会话正在执行（可能是用户在直接对话），稍后再发".into())
            }
            WaitThreadState::Unavailable => return Err("子会话已归档或不可继续".into()),
            WaitThreadState::Ready(context) => context,
        };
        let (turn, warning) = self
            .dispatch(parent, &child.thread_id, &child.title, &args.message, context)
            .await?;
        Ok(json!({
            "threadId": child.thread_id, "title": child.title, "turnId": turn, "status": "running",
            "callbackWarning": warning,
            "next": "已发送。结束本轮即可；子会话完成后 Harness 会自动把汇报送回本会话。"
        }))
    }

    async fn dispatch(
        &self,
        parent: &str,
        child: &str,
        title: &str,
        text: &str,
        context: Value,
    ) -> Result<(String, Option<String>), String> {
        let message = format!("{DISPATCH_HEADER}\n\n{}\n\n{REPORT_FORMAT}", text.trim());
        let turn = self
            .server
            .start_continuation(child, &random_id()?, &message, context, DISPATCH_TRIGGER)
            .await?;
        push_capped(&self.store, &dispatched_key(child), &[turn.clone()], 200)?;
        let wait = CreateWait {
            id: format!("relay-{turn}"),
            thread_id: parent.to_owned(),
            title: format!("子会话「{title}」"),
            continuation: "子会话汇报已随回调消息送达；按路由会话指令整理后回复用户。".into(),
            condition: String::new(),
            checker_path: String::new(),
            target: Target::Session {
                thread_id: child.to_owned(),
                turn_id: turn.clone(),
            },
        };
        // The child is already running; a failed callback registration must not hide that.
        let warning = self
            .waits
            .create_session(wait)
            .await
            .err()
            .map(|e| format!("自动回调登记失败：{e}。完成后请用 harness_session_read 查看。"));
        Ok((turn, warning))
    }

    async fn thread_status(&self, thread: &str) -> String {
        match self
            .server
            .request(
                "thread/read".into(),
                json!({"threadId":thread,"includeTurns":false}),
            )
            .await
        {
            Ok(value) => value
                .pointer("/thread/status/type")
                .and_then(Value::as_str)
                .map(|status| match status {
                    "active" => "running",
                    "idle" | "notLoaded" => "idle",
                    other => other,
                })
                .unwrap_or("unknown")
                .to_owned(),
            Err(_) => "unavailable".into(),
        }
    }

    async fn list(&self, parent: &str) -> Result<Value, String> {
        let running = self.running(parent)?;
        let mut items = Vec::new();
        for child in children(&self.store, parent)? {
            let status = self.thread_status(&child.thread_id).await;
            items.push(json!({
                "threadId": child.thread_id, "title": child.title, "cwd": child.cwd,
                "status": status, "awaitingCallback": running.contains(&child.thread_id),
            }));
        }
        let workspaces = self
            .store
            .list_workspaces()?
            .into_iter()
            .take(40)
            .map(|w| json!({"name": w.name, "root": w.root}))
            .collect::<Vec<_>>();
        Ok(json!({
            "children": items, "running": running.len(), "maxRunning": MAX_RUNNING,
            "workspaces": workspaces,
        }))
    }

    async fn read(&self, parent: &str, args: &ReadArgs) -> Result<Value, String> {
        let child = self.own_child(parent, &args.thread_id)?;
        let page = self
            .server
            .request(
                "thread/turns/list".into(),
                json!({"threadId":child.thread_id,"limit":READ_RECENT_TURNS,"sortDirection":"desc","itemsView":"summary"}),
            )
            .await?;
        let mut turns: Vec<Value> = page["data"].as_array().cloned().unwrap_or_default();
        turns.reverse();
        let dispatched: HashSet<String> = read_json::<Vec<String>>(
            &self.store,
            &dispatched_key(&child.thread_id),
        )?
        .into_iter()
        .collect();
        let mut seen: HashSet<String> =
            read_json::<Vec<String>>(&self.store, &seen_key(parent, &child.thread_id))?
                .into_iter()
                .collect();
        seen.extend(self.delivered_turns(parent, &child.thread_id)?);
        let (entries, newly_seen) = render_turns(&child.thread_id, &turns, &dispatched, &seen, args.all);
        let (entries, omitted) = cap_entries(entries, READ_TOTAL_CHARS);
        push_capped(
            &self.store,
            &seen_key(parent, &child.thread_id),
            &newly_seen,
            500,
        )?;
        let status = self.thread_status(&child.thread_id).await;
        Ok(json!({
            "threadId": child.thread_id, "title": child.title, "status": status,
            "scope": if args.all { "recent" } else { "unread" },
            "turns": entries, "omittedOlder": omitted,
            "note": if page["nextCursor"].is_string() { "只包含最近 30 轮" } else { "" },
        }))
    }
}

/// Unread (or all recent) turns with origin, request and final reply; returns the
/// completed turn ids that become read.
fn render_turns(
    thread: &str,
    turns: &[Value],
    dispatched: &HashSet<String>,
    seen: &HashSet<String>,
    all: bool,
) -> (Vec<Value>, Vec<String>) {
    let mut entries = Vec::new();
    let mut newly_seen = Vec::new();
    for turn in turns {
        let report = parse_turn(thread, turn);
        if report.turn_id.is_empty() || (!all && seen.contains(&report.turn_id)) {
            continue;
        }
        if report.status != "inProgress" {
            newly_seen.push(report.turn_id.clone());
        }
        entries.push(json!({
            "turnId": report.turn_id,
            "origin": if dispatched.contains(&report.turn_id) { "路由会话派发" } else { "用户直接对话" },
            "status": status_label(&report.status),
            "request": truncate(&report.request, READ_REQUEST_CHARS),
            "reply": truncate(&report.reply, READ_REPLY_CHARS),
        }));
    }
    (entries, newly_seen)
}

/// Keep the newest turns within the size budget.
fn cap_entries(mut entries: Vec<Value>, budget: usize) -> (Vec<Value>, usize) {
    let mut omitted = 0;
    while entries.len() > 1 && entries.iter().map(|e| e.to_string().len()).sum::<usize>() > budget {
        entries.remove(0);
        omitted += 1;
    }
    (entries, omitted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, status: &str, request: &str, reply: &str) -> Value {
        json!({"id":id,"status":status,"items":[
            {"type":"userMessage","content":[{"type":"text","text":request}]},
            {"type":"agentMessage","phase":"commentary","text":"working"},
            {"type":"agentMessage","phase":"final_answer","text":reply}
        ]})
    }

    #[test]
    fn parse_turn_keeps_request_and_final_reply_only() {
        let message = format!("{DISPATCH_HEADER}\n\n修复登录\n\n{REPORT_FORMAT}");
        let report = parse_turn("child", &turn("t1", "completed", &message, "已修复"));
        assert_eq!(report.request, "修复登录");
        assert_eq!(report.reply, "已修复");
        assert_eq!(report.status, "completed");
        let failed = parse_turn("child", &json!({"id":"t2","status":"failed","items":[],"error":{"message":"boom"}}));
        assert_eq!(failed.reply, "错误：boom");
        let commentary_only = parse_turn("child", &json!({"id":"t3","status":"completed","items":[{"type":"agentMessage","text":"partial"}]}));
        assert_eq!(commentary_only.reply, "partial");
    }

    #[test]
    fn callback_summary_truncates_long_replies_and_names_the_child() {
        let report = TurnReport {
            thread_id: "child".into(),
            turn_id: "t1".into(),
            status: "completed".into(),
            request: String::new(),
            reply: "字".repeat(CALLBACK_REPLY_CHARS + 10),
        };
        let summary = report.callback_summary();
        assert!(summary.starts_with("threadId: child\n状态：已完成"));
        assert!(summary.contains("已截断"));
        let message = callback_message(&[("子会话「A」", &summary)]);
        assert!(message.contains("## 子会话「A」"));
        assert!(message.contains("harness_session_read"));
    }

    #[test]
    fn unread_turns_include_direct_user_turns_and_mark_only_finished_ones() {
        let turns = vec![
            turn("t1", "completed", "派发任务", "完成"),
            turn("t2", "completed", "用户直接问", "回答"),
            turn("t3", "inProgress", "继续", ""),
        ];
        let dispatched: HashSet<String> = ["t1".to_string()].into();
        let seen: HashSet<String> = ["t1".to_string()].into();
        let (entries, newly) = render_turns("child", &turns, &dispatched, &seen, false);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["origin"], "用户直接对话");
        assert_eq!(entries[1]["status"], "执行中");
        assert_eq!(newly, vec!["t2".to_string()]);
        let (all, _) = render_turns("child", &turns, &dispatched, &seen, true);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0]["origin"], "路由会话派发");
    }

    #[test]
    fn size_budget_drops_oldest_turns_first() {
        let entries = (0..5)
            .map(|i| json!({"turnId":i,"reply":"x".repeat(100)}))
            .collect::<Vec<_>>();
        let (kept, omitted) = cap_entries(entries, 300);
        assert_eq!(omitted, 3);
        assert_eq!(kept[0]["turnId"], 3);
    }

    #[test]
    fn relationships_and_markers_persist_in_the_state_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().join("state")).unwrap();
        assert!(!is_relay(&store, "root").unwrap());
        mark_relay(&store, "root").unwrap();
        record_child(&store, "root", Child { thread_id: "c1".into(), title: "A".into(), cwd: "/tmp".into(), created_at: 1 }).unwrap();
        record_child(&store, "root", Child { thread_id: "c1".into(), title: "A2".into(), cwd: "/tmp".into(), created_at: 2 }).unwrap();
        assert_eq!(children(&store, "root").unwrap().len(), 1);
        assert_eq!(parent_of(&store, "c1").unwrap().as_deref(), Some("root"));
        let mut response = json!({"data":[{"id":"root"},{"id":"c1"},{"id":"other"}]});
        annotate(&store, &mut response).unwrap();
        assert_eq!(response["data"][0]["harnessRelay"], true);
        assert_eq!(response["data"][1]["harnessRelayParent"], "root");
        assert!(response["data"][2].get("harnessRelay").is_none());
        push_capped(&store, "k", &["a".into(), "b".into(), "c".into()], 2).unwrap();
        assert_eq!(read_json::<Vec<String>>(&store, "k").unwrap(), vec!["b", "c"]);
    }

    #[test]
    fn child_cwd_must_be_a_real_directory_outside_the_relay_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let relay = dir.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let relay = relay.canonicalize().unwrap();
        assert!(validate_cwd("relative", Some(&relay)).is_err());
        assert!(validate_cwd(&relay.to_string_lossy(), Some(&relay)).is_err());
        assert!(validate_cwd(&dir.path().join("missing").to_string_lossy(), Some(&relay)).is_err());
        assert!(validate_cwd(&dir.path().to_string_lossy(), Some(&relay)).is_ok());
    }

    #[test]
    fn tool_definitions_are_unique_and_recognized() {
        let defs = definitions();
        let names: Vec<&str> = defs.as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 4);
        assert!(names.iter().all(|n| is_tool(n)));
        assert!(!is_tool("harness_project_read"));
    }
}
