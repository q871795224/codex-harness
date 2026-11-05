//! Durable one-shot waits. The native scheduler owns polling; no model runs until ready.
mod store;
use crate::{
    app_server::{AppServerManager, WaitThreadState},
    store::HarnessStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use store::WaitStore;
pub use store::{CreateWait, WaitTask};
use tauri::{Emitter, Listener};
use tokio::{io::AsyncReadExt, process::Command};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    status: String,
    summary: String,
}
fn observation(bytes: &[u8]) -> Result<Observation, String> {
    if bytes.len() > 8192 {
        return Err("检查输出超过8KiB".into());
    }
    let result: Observation = serde_json::from_slice(bytes)
        .map_err(|_| "检查脚本必须输出单个 JSON 对象，包含 status 和 summary".to_string())?;
    if !matches!(
        result.status.as_str(),
        "waiting" | "ready" | "needsAttention" | "failed"
    ) || result.summary.len() > 4000
        || result.summary.trim().is_empty()
    {
        return Err("检查结果状态或摘要无效".into());
    }
    Ok(result)
}
// Kill the entire checker group on timeout/cancellation, including spawned CLI children.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
async fn check(script: &Path, cwd: &str) -> Result<Observation, String> {
    check_with_timeout(script, cwd, Duration::from_secs(30)).await
}
async fn check_with_timeout(
    script: &Path,
    cwd: &str,
    timeout: Duration,
) -> Result<Observation, String> {
    use std::os::unix::process::CommandExt;
    let python = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    .into_iter()
    .find(|p| Path::new(p).is_file())
    .ok_or("未找到 Python 3")?;
    let mut command = Command::new(python);
    command
        .arg("-I")
        .arg(script)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动检查脚本，请检查工作目录和 Python".to_string())?;
    let _group = ProcessGroup(child.id().ok_or("无法取得检查进程")?);
    let output = child.stdout.take().ok_or("无法读取检查结果")?;
    let result = tokio::time::timeout(timeout, async {
        let mut bytes = Vec::new();
        output
            .take(8193)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "无法读取检查结果")?;
        if bytes.len() > 8192 {
            return Err("检查输出超过8KiB".into());
        }
        let status = child.wait().await.map_err(|_| "无法取得检查进程结果")?;
        if !status.success() {
            return Err("检查脚本退出失败；请检查脚本或登录态".into());
        }
        observation(&bytes)
    })
    .await
    .map_err(|_| "检查超过30秒，已停止".to_string())?;
    result
}
fn apply_observation(task: &mut WaitTask, result: Result<Observation, String>, at: u64) {
    task.last_checked_at = Some(at);
    task.updated_at = at;
    match result {
        Ok(result) => {
            task.failures = 0;
            task.last_observation = Some(result.summary.clone());
            task.summary = result.summary;
            task.status = match result.status.as_str() {
                "ready" => "ready",
                "needsAttention" | "failed" => "paused",
                _ => "waiting",
            }
            .into();
            task.next_check_at = at + 300;
        }
        Err(error) => {
            task.failures = task.failures.saturating_add(1);
            task.summary = error;
            task.status = if task.failures >= 5 {
                "paused"
            } else {
                "waiting"
            }
            .into();
            task.next_check_at = at + (60 * 2u64.pow(task.failures.min(6))).min(1800);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitSnapshot {
    pub data: Vec<WaitTask>,
    pub scheduler_error: Option<String>,
}

#[derive(Deserialize)]
struct PauseEvent {
    method: String,
    params: PauseParams,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PauseParams {
    thread_id: Option<String>,
    turn: Option<PauseTurn>,
}
#[derive(Deserialize)]
struct PauseTurn {
    status: Option<String>,
}
fn pause_event_thread(payload: &str) -> Option<String> {
    let event: PauseEvent = serde_json::from_str(payload).ok()?;
    if matches!(event.method.as_str(), "thread/archived" | "thread/deleted")
        || (event.method == "turn/completed"
            && event.params.turn.and_then(|t| t.status).as_deref() == Some("interrupted"))
    {
        event.params.thread_id
    } else {
        None
    }
}

type SettingsReader = Arc<dyn Fn(&str) -> Result<Option<String>, String> + Send + Sync>;
type Changed = Arc<dyn Fn() + Send + Sync>;
trait WaitTransport: Send + Sync {
    fn cwd<'a>(
        &'a self,
        thread: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<String, String>>;
    fn prepare<'a>(
        &'a self,
        thread: &'a str,
        preferences: Option<&'a str>,
    ) -> futures_util::future::BoxFuture<'a, Result<WaitThreadState, String>>;
    fn start<'a>(
        &'a self,
        thread: &'a str,
        id: &'a str,
        message: &'a str,
        context: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<String, String>>;
}
impl WaitTransport for AppServerManager {
    fn cwd<'a>(
        &'a self,
        thread: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<String, String>> {
        Box::pin(self.wait_thread_cwd(thread))
    }
    fn prepare<'a>(
        &'a self,
        thread: &'a str,
        preferences: Option<&'a str>,
    ) -> futures_util::future::BoxFuture<'a, Result<WaitThreadState, String>> {
        Box::pin(self.prepare_wait_continuation(thread, preferences))
    }
    fn start<'a>(
        &'a self,
        thread: &'a str,
        id: &'a str,
        message: &'a str,
        context: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<String, String>> {
        Box::pin(self.start_wait_continuation(thread, id, message, context))
    }
}

pub struct AsyncWaits {
    store: WaitStore,
    settings: SettingsReader,
    server: Arc<dyn WaitTransport>,
    changed: Changed,
    error: std::sync::Mutex<Option<String>>,
    // Stop/archive and dispatch serialize within this instance, including their RPCs.
    pub gate: tokio::sync::Mutex<()>,
}
impl AsyncWaits {
    pub fn new(
        root: PathBuf,
        harness_store: Arc<HarnessStore>,
        server: Arc<AppServerManager>,
        app: tauri::AppHandle,
    ) -> Result<Arc<Self>, String> {
        let events = app.clone();
        let this = Arc::new(Self {
            store: WaitStore::open(root)?,
            settings: Arc::new(move |thread| {
                harness_store.get_app_state(&format!("threadPermissions.v1:{thread}"))
            }),
            server,
            changed: Arc::new(move || {
                let _ = app.emit("async-waits:changed", ());
            }),
            error: std::sync::Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
        });
        let weak = Arc::downgrade(&this);
        events.listen("app-server:event", move |event| {
            if let (Some(thread), Some(this)) =
                (pause_event_thread(event.payload()), weak.upgrade())
            {
                tauri::async_runtime::spawn(async move {
                    let _gate = this.gate.lock().await;
                    if this.pause_thread(&thread).is_err() {
                        if let Ok(mut error) = this.error.lock() {
                            *error = Some("会话暂停状态未能保存，请暂停异步任务后再继续".into());
                        }
                        this.changed();
                    }
                });
            }
        });
        Ok(this)
    }
    fn changed(&self) {
        (self.changed)();
    }
    pub fn list(&self) -> Result<WaitSnapshot, String> {
        Ok(WaitSnapshot {
            data: self.store.list()?,
            scheduler_error: self.error.lock().map_err(|e| e.to_string())?.clone(),
        })
    }
    pub async fn create(&self, input: CreateWait) -> Result<WaitTask, String> {
        let _gate = self.gate.lock().await;
        let cwd = self.server.cwd(&input.thread_id).await?;
        let task = self.store.create(input, cwd, now())?;
        self.changed();
        Ok(task)
    }
    pub async fn action(&self, id: &str, action: &str) -> Result<WaitTask, String> {
        let _gate = self.gate.lock().await;
        let task = self.store.action(id, action, now())?;
        self.changed();
        Ok(task)
    }
    pub fn pause_thread(&self, id: &str) -> Result<(), String> {
        self.store.pause_thread(id, now())?;
        self.changed();
        Ok(())
    }
    pub fn spawn(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let error = this
                    .tick()
                    .await
                    .err()
                    .map(|_| "异步调度暂不可用，将自动重试；任务不会重复提交".to_string());
                if let Ok(mut current) = this.error.lock() {
                    if *current != error {
                        *current = error;
                        this.changed();
                    }
                }
                // Another live Harness may be the scheduler leader and write shared files.
                // Refresh this instance's view too; UI polling never owns execution.
                this.changed();
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    async fn tick(&self) -> Result<(), String> {
        let Some(_leader) = self.store.leader()? else {
            return Ok(());
        };
        let mut due = Vec::new();
        for mut task in self.store.list()? {
            if !task.active() {
                continue;
            }
            let at = now();
            if at >= task.deadline {
                task.status = "expired".into();
                task.summary = "等待已满7天，请核对后继续".into();
                task.updated_at = at;
                if self.store.update(&task)? {
                    self.changed();
                }
            } else if task.next_check_at <= at {
                due.push(task);
            }
        }
        // Oldest due work first. A slow checker must not starve other waits or
        // age every ready observation while a large queue is being scanned.
        due.sort_by_key(|task| task.next_check_at);
        let checked =
            futures_util::future::join_all(due.into_iter().take(4).map(|mut task| async move {
                let result = check(&self.store.checker(&task.id), &task.cwd).await;
                apply_observation(&mut task, result, now());
                task
            }))
            .await;
        for task in checked {
            if self.store.update(&task)? {
                self.changed();
            }
        }
        let mut groups: BTreeMap<String, Vec<WaitTask>> = BTreeMap::new();
        for task in self.store.list()? {
            if task.status == "ready" && task.next_delivery_at <= now() {
                groups.entry(task.thread_id.clone()).or_default().push(task);
            }
        }
        for (thread, tasks) in groups {
            self.deliver(&thread, tasks).await?;
        }
        Ok(())
    }
    async fn deliver(&self, thread: &str, tasks: Vec<WaitTask>) -> Result<(), String> {
        let preferences = (self.settings)(thread)?;
        let state = match self.server.prepare(thread, preferences.as_deref()).await {
            Ok(state) => state,
            Err(_) => {
                for mut task in tasks {
                    task.delivery_failures = task.delivery_failures.saturating_add(1);
                    task.next_delivery_at =
                        now() + (60 * 2u64.pow(task.delivery_failures.min(6))).min(1800);
                    task.updated_at = now();
                    task.summary = "无法恢复来源会话，正在退避重试；连续5次失败后暂停".into();
                    if task.delivery_failures >= 5 {
                        task.status = "paused".into();
                        task.summary = "来源会话连续5次恢复失败，请核对连接和会话后继续".into();
                    }
                    if self.store.update(&task)? {
                        self.changed();
                    }
                }
                return Ok(());
            }
        };
        let context = match state {
            WaitThreadState::Busy => return Ok(()),
            WaitThreadState::Unavailable => {
                self.pause_thread(thread)?;
                return Ok(());
            }
            WaitThreadState::Ready(context) => context,
        };
        if context
            .get("cwd")
            .and_then(Value::as_str)
            .is_some_and(|cwd| tasks.iter().any(|t| t.cwd != cwd))
        {
            for mut task in tasks {
                task.status = "paused".into();
                task.summary = "来源工作目录已变化，请核对后重新创建等待任务".into();
                task.updated_at = now();
                if self.store.update(&task)? {
                    self.changed();
                }
            }
            return Ok(());
        }
        // A sleeping laptop or a busy conversation may have made the observation stale.
        let mut fresh = Vec::new();
        for mut task in tasks {
            if now().saturating_sub(task.last_checked_at.unwrap_or(0)) > 60 {
                task.status = "waiting".into();
                task.next_check_at = now();
                task.updated_at = now();
                task.summary = "观察结果已过期，等待重新核对".into();
                if self.store.update(&task)? {
                    self.changed();
                }
                continue;
            }
            fresh.push(task);
        }
        let _gate = self.gate.lock().await;
        let mut ready = Vec::new();
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
        for mut task in fresh {
            task.status = "dispatching".into();
            task.delivery_id = Some(id.clone());
            task.updated_at = now();
            if self.store.update(&task)? {
                task.revision += 1;
                ready.push(task);
            }
        }
        if ready.is_empty() {
            return Ok(());
        }
        self.changed();
        let client_id = ready[0].delivery_id.clone().unwrap();
        let message = continuation_message(&ready);
        // Write intent before turn/start. Unknown outcome is never automatically replayed.
        let result = self
            .server
            .start(thread, &client_id, &message, context)
            .await;
        for mut task in ready {
            match &result {
                Ok(turn) => {
                    task.status = "delivered".into();
                    task.turn_id = Some(turn.clone());
                    task.summary = "结果已送回原会话，已启动继续处理".into();
                }
                Err(_) => {
                    task.status = "uncertain".into();
                    task.summary = "续跑提交结果未知，请核对原会话；不会自动重发".into();
                }
            }
            task.updated_at = now();
            self.store.update(&task)?;
        }
        self.changed();
        Ok(())
    }
}
fn continuation_message(tasks: &[WaitTask]) -> String {
    let items = tasks.iter().map(|t| format!("{}（{}）", t.title.replace(['\n', '\r'], " "), t.id)).collect::<Vec<_>>().join("；");
    format!("Harness 异步任务已就绪：{items}。\n请用随附 CLI 的 async-waits get ID 读取任务观察和后续动作，核对外部状态后继续。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    struct FakeServer {
        cwd: String,
        busy: AtomicBool,
        fail: AtomicBool,
        unavailable: AtomicBool,
        prepare_fail: AtomicBool,
        calls: Mutex<Vec<(String, String)>>,
    }
    impl WaitTransport for FakeServer {
        fn cwd<'a>(
            &'a self,
            _: &'a str,
        ) -> futures_util::future::BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Ok(self.cwd.clone()) })
        }
        fn prepare<'a>(
            &'a self,
            _: &'a str,
            _: Option<&'a str>,
        ) -> futures_util::future::BoxFuture<'a, Result<WaitThreadState, String>> {
            Box::pin(async {
                if self.prepare_fail.load(Ordering::SeqCst) {
                    return Err("offline".into());
                }
                Ok(if self.unavailable.load(Ordering::SeqCst) {
                    WaitThreadState::Unavailable
                } else if self.busy.load(Ordering::SeqCst) {
                    WaitThreadState::Busy
                } else {
                    WaitThreadState::Ready(json!({"cwd":self.cwd}))
                })
            })
        }
        fn start<'a>(
            &'a self,
            _: &'a str,
            id: &'a str,
            message: &'a str,
            _: Value,
        ) -> futures_util::future::BoxFuture<'a, Result<String, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((id.into(), message.into()));
                if self.fail.load(Ordering::SeqCst) {
                    Err("disconnected".into())
                } else {
                    Ok("turn-1".into())
                }
            })
        }
    }
    fn fixture() -> (tempfile::TempDir, AsyncWaits, Arc<FakeServer>) {
        let dir = tempfile::tempdir().unwrap();
        let server = Arc::new(FakeServer {
            cwd: dir.path().to_string_lossy().into_owned(),
            busy: AtomicBool::new(false),
            fail: AtomicBool::new(false),
            unavailable: AtomicBool::new(false),
            prepare_fail: AtomicBool::new(false),
            calls: Mutex::new(Vec::new()),
        });
        let waits = AsyncWaits {
            store: WaitStore::open(dir.path().join("waits")).unwrap(),
            settings: Arc::new(|_| Ok(None)),
            server: server.clone(),
            changed: Arc::new(|| {}),
            error: Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
        };
        (dir, waits, server)
    }
    fn input(dir: &Path, id: &str, result: &str) -> CreateWait {
        let path = dir.join(format!("source-{id}.py"));
        fs::write(&path, format!("print({result:?})")).unwrap();
        CreateWait {
            id: id.into(),
            thread_id: "thread-1".into(),
            title: id.into(),
            continuation: "Review the result, do not publish".into(),
            checker_path: path.to_string_lossy().into_owned(),
        }
    }
    #[tokio::test]
    async fn ready_results_are_batched_and_delivered_once_across_restart() {
        let (dir, waits, server) = fixture();
        for id in ["certificate", "cors"] {
            waits
                .create(input(
                    dir.path(),
                    id,
                    r#"{"status":"ready","summary":"verified"}"#,
                ))
                .await
                .unwrap();
        }
        waits.tick().await.unwrap();
        assert!(waits
            .list()
            .unwrap()
            .data
            .iter()
            .all(|t| t.status == "delivered"));
        let calls = server.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.contains("certificate") && calls[0].1.contains("cors"));
        assert!(!calls[0].1.contains("Review the result"));
        assert!(!calls[0].1.contains("verified"));
        assert!(!calls[0].1.contains("nextAction"));
        assert!(calls[0].1.contains("async-waits get"));
        drop(calls);
        let reopened = AsyncWaits {
            store: WaitStore::open(dir.path().join("waits")).unwrap(),
            ..waits
        };
        reopened.tick().await.unwrap();
        assert_eq!(server.calls.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn busy_thread_retains_result_and_user_stop_prevents_future_start() {
        let (dir, waits, server) = fixture();
        server.busy.store(true, Ordering::SeqCst);
        waits
            .create(input(
                dir.path(),
                "bot",
                r#"{"status":"ready","summary":"MR !123"}"#,
            ))
            .await
            .unwrap();
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "ready");
        assert!(server.calls.lock().unwrap().is_empty());
        waits.pause_thread("thread-1").unwrap();
        server.busy.store(false, Ordering::SeqCst);
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "paused");
        assert!(server.calls.lock().unwrap().is_empty());
        waits.action("bot", "resume").await.unwrap();
        waits.tick().await.unwrap();
        assert_eq!(server.calls.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn unknown_send_outcome_and_crash_intent_are_never_replayed() {
        let (dir, waits, server) = fixture();
        server.fail.store(true, Ordering::SeqCst);
        waits
            .create(input(
                dir.path(),
                "approval",
                r#"{"status":"ready","summary":"approved"}"#,
            ))
            .await
            .unwrap();
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "uncertain");
        waits.tick().await.unwrap();
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        let mut task = waits.list().unwrap().data[0].clone();
        task.status = "dispatching".into();
        waits.store.update(&task).unwrap();
        waits.tick().await.unwrap();
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        assert!(waits.action("approval", "resume").await.is_err());
        waits.action("approval", "acknowledge").await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "closed");
    }
    #[tokio::test]
    async fn overdue_checks_run_after_recovery_but_expired_and_archived_tasks_do_not_start() {
        let (dir, waits, server) = fixture();
        waits
            .create(input(
                dir.path(),
                "recover",
                r#"{"status":"ready","summary":"done"}"#,
            ))
            .await
            .unwrap();
        let mut task = waits.list().unwrap().data[0].clone();
        task.next_check_at = 0;
        waits.store.update(&task).unwrap();
        server.unavailable.store(true, Ordering::SeqCst);
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "paused");
        waits.action("recover", "resume").await.unwrap();
        let mut task = waits.list().unwrap().data[0].clone();
        task.deadline = 0;
        waits.store.update(&task).unwrap();
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "expired");
        assert!(server.calls.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn leader_lock_prevents_two_instances_from_checking() {
        let (dir, waits, server) = fixture();
        waits
            .create(input(
                dir.path(),
                "one",
                r#"{"status":"ready","summary":"done"}"#,
            ))
            .await
            .unwrap();
        let second = WaitStore::open(dir.path().join("waits")).unwrap();
        let leader = second.leader().unwrap().unwrap();
        waits.tick().await.unwrap();
        assert!(server.calls.lock().unwrap().is_empty());
        drop(leader);
        waits.tick().await.unwrap();
        assert_eq!(server.calls.lock().unwrap().len(), 1);
    }
    #[test]
    fn transient_failures_back_off_and_auth_failure_pauses_without_a_model() {
        let (dir, waits, _) = fixture();
        let mut task = waits
            .store
            .create(
                input(
                    dir.path(),
                    "one",
                    r#"{"status":"waiting","summary":"pending"}"#,
                ),
                dir.path().to_string_lossy().into_owned(),
                10,
            )
            .unwrap();
        apply_observation(&mut task, Err("network unavailable".into()), 20);
        assert_eq!(task.status, "waiting");
        assert_eq!(task.next_check_at, 140);
        for _ in 0..4 {
            apply_observation(&mut task, Err("network unavailable".into()), 30);
        }
        assert_eq!(task.status, "paused");
        apply_observation(
            &mut task,
            observation(br#"{"status":"needsAttention","summary":"login expired"}"#),
            40,
        );
        assert_eq!(task.status, "paused");
        assert_eq!(task.summary, "login expired");
    }
    #[test]
    fn a_concurrent_writer_cannot_drop_a_pause_request() {
        use std::os::fd::AsRawFd;
        let (dir, waits, _) = fixture();
        waits
            .store
            .create(
                input(
                    dir.path(),
                    "one",
                    r#"{"status":"waiting","summary":"pending"}"#,
                ),
                dir.path().to_string_lossy().into_owned(),
                10,
            )
            .unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.path().join("waits/writer.lock"))
            .unwrap();
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        let second = WaitStore::open(dir.path().join("waits")).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(second.action("one", "pause", 20)).unwrap();
        });
        assert!(receive.recv_timeout(Duration::from_millis(30)).is_err());
        drop(file);
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()
                .status,
            "paused"
        );
        worker.join().unwrap();
    }
    #[test]
    fn creation_is_durable_idempotent_and_checker_is_snapshotted() {
        let (dir, waits, _) = fixture();
        let spec = input(
            dir.path(),
            "one",
            r#"{"status":"waiting","summary":"pending"}"#,
        );
        let cwd = dir.path().to_string_lossy().into_owned();
        let task = waits.store.create(spec.clone(), cwd.clone(), 10).unwrap();
        let reopened = WaitStore::open(dir.path().join("waits")).unwrap();
        assert_eq!(
            reopened
                .create(spec.clone(), cwd.clone(), 20)
                .unwrap()
                .created_at,
            10
        );
        fs::write(&spec.checker_path, "raise Exception()").unwrap();
        assert!(reopened.create(spec, cwd, 30).is_err());
        assert!(fs::read_to_string(reopened.checker("one"))
            .unwrap()
            .contains("pending"));
        let mut stale = task.clone();
        stale.status = "ready".into();
        reopened.action("one", "cancel", 40).unwrap();
        assert!(!reopened.update(&stale).unwrap());
        assert_eq!(reopened.list().unwrap()[0].status, "cancelled");
        let mut invalid = input(dir.path(), "two", "{}");
        invalid.id = "../escape".into();
        assert!(reopened.create(invalid, "/tmp".into(), 50).is_err());
    }
    #[tokio::test]
    async fn restoring_the_conversation_backs_off_and_preserves_observation() {
        let (dir, waits, server) = fixture();
        waits
            .create(input(
                dir.path(),
                "ready",
                r#"{"status":"ready","summary":"certificate uploaded"}"#,
            ))
            .await
            .unwrap();
        server.prepare_fail.store(true, Ordering::SeqCst);
        waits.tick().await.unwrap();
        let mut task = waits.list().unwrap().data[0].clone();
        assert_eq!(task.delivery_failures, 1);
        assert_eq!(task.status, "ready");
        assert!(task.next_delivery_at > now());
        assert_eq!(
            task.last_observation.as_deref(),
            Some("certificate uploaded")
        );
        for _ in 0..4 {
            task.next_delivery_at = 0;
            waits.store.update(&task).unwrap();
            waits.tick().await.unwrap();
            task = waits.list().unwrap().data[0].clone();
        }
        assert_eq!(task.status, "paused");
        assert!(server.calls.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn stale_ready_observation_is_rechecked_before_continuing() {
        let (dir, waits, server) = fixture();
        let external = dir.path().join("upstream.json");
        fs::write(&external, r#"{"status":"ready","summary":"ready"}"#).unwrap();
        let spec = input(dir.path(), "stale", "{}");
        fs::write(
            &spec.checker_path,
            format!(
                "from pathlib import Path; print(Path({:?}).read_text())",
                external.to_str().unwrap()
            ),
        )
        .unwrap();
        waits.create(spec).await.unwrap();
        server.busy.store(true, Ordering::SeqCst);
        waits.tick().await.unwrap();
        let mut task = waits.list().unwrap().data[0].clone();
        task.last_checked_at = Some(now() - 61);
        task.next_check_at = now() + 300;
        waits.store.update(&task).unwrap();
        fs::write(
            &external,
            r#"{"status":"waiting","summary":"result changed"}"#,
        )
        .unwrap();
        server.busy.store(false, Ordering::SeqCst);
        waits.tick().await.unwrap();
        assert_eq!(waits.list().unwrap().data[0].status, "waiting");
        waits.tick().await.unwrap();
        assert_eq!(
            waits.list().unwrap().data[0].last_observation.as_deref(),
            Some("result changed")
        );
        assert!(server.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn external_stop_and_archive_events_pause_but_normal_completions_do_not() {
        for method in ["thread/archived", "thread/deleted"] {
            assert_eq!(
                pause_event_thread(
                    &json!({"method":method,"params":{"threadId":"origin"}}).to_string()
                )
                .as_deref(),
                Some("origin")
            );
        }
        assert_eq!(pause_event_thread(r#"{"method":"turn/completed","params":{"threadId":"origin","turn":{"status":"interrupted"}}}"#).as_deref(), Some("origin"));
        assert!(pause_event_thread(r#"{"method":"turn/completed","params":{"threadId":"origin","turn":{"status":"completed"}}}"#).is_none());
        assert!(pause_event_thread(
            r#"{"method":"item/completed","params":{"threadId":"origin","item":{"text":"secret"}}}"#
        )
        .is_none());
    }
    #[tokio::test]
    async fn checker_timeout_stops_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("checker.py");
        fs::write(&script, "import time; time.sleep(60)").unwrap();
        let started = std::time::Instant::now();
        assert!(check_with_timeout(
            &script,
            dir.path().to_str().unwrap(),
            Duration::from_millis(50)
        )
        .await
        .unwrap_err()
        .contains("已停止"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
    #[tokio::test]
    async fn checker_rejects_invalid_and_excessive_output() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("checker.py");
        for body in [
            "print('not JSON')",
            "print('x' * 100000)",
            "raise Exception('secret')",
        ] {
            fs::write(&script, body).unwrap();
            let error = check(&script, dir.path().to_str().unwrap())
                .await
                .unwrap_err();
            assert!(!error.contains("secret"));
        }
    }
}
