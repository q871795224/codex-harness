use super::Target;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWait {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub continuation: String,
    #[serde(default)]
    pub condition: String,
    #[serde(default)]
    pub checker_path: String,
    #[serde(default)]
    pub target: Target,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitTask {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub continuation: String,
    #[serde(default)]
    pub condition: String,
    pub cwd: String,
    pub status: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub deadline: u64,
    pub next_check_at: u64,
    pub last_checked_at: Option<u64>,
    pub failures: u32,
    pub summary: String,
    #[serde(default)]
    pub last_observation: Option<String>,
    #[serde(default)]
    pub delivery_failures: u32,
    #[serde(default)]
    pub next_delivery_at: u64,
    pub turn_id: Option<String>,
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub target: Target,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub checker_source: Option<String>,
    #[serde(default)]
    pub draft_staged: bool,
}
impl WaitTask {
    pub fn active(&self) -> bool {
        matches!(self.status.as_str(), "waiting" | "ready")
    }
}
#[derive(Clone)]
pub struct WaitStore {
    root: PathBuf,
}
pub struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn lock(path: &Path, nonblocking: bool) -> Result<Option<Lock>, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    if unsafe {
        libc::flock(
            file.as_raw_fd(),
            libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 },
        )
    } == 0
    {
        return Ok(Some(Lock(file)));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(error.to_string())
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("目录无效")?)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
impl WaitStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        if root
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("异步任务目录不能是符号链接".into());
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }
    // Writers never hold this lock across an await. Brief contention must not lose a stop/pause.
    fn writer(&self) -> Result<Lock, String> {
        lock(&self.root.join("writer.lock"), false)?.ok_or("异步任务正在更新，请重试".into())
    }
    pub fn leader(&self) -> Result<Option<Lock>, String> {
        lock(&self.root.join("scheduler.lock"), true)
    }
    pub fn checker(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.py"))
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("异步任务 ID 只能包含字母、数字、横线和下划线，最长96字符".into());
        }
        let path = self.root.join(format!("{id}.json"));
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("异步任务文件不能是符号链接".into());
        }
        Ok(path)
    }
    fn read(&self, id: &str) -> Result<WaitTask, String> {
        serde_json::from_slice(&fs::read(self.path(id)?).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    fn write(&self, task: &WaitTask) -> Result<(), String> {
        atomic(
            &self.path(&task.id)?,
            &serde_json::to_vec_pretty(task).map_err(|e| e.to_string())?,
        )
    }
    pub fn list(&self) -> Result<Vec<WaitTask>, String> {
        let _guard = self.writer()?;
        self.list_unlocked()
    }
    fn list_unlocked(&self) -> Result<Vec<WaitTask>, String> {
        let mut tasks = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                tasks.push(
                    self.read(
                        path.file_stem()
                            .and_then(|s| s.to_str())
                            .ok_or("任务文件名无效")?,
                    )?,
                );
            }
        }
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        Ok(tasks)
    }
    pub fn create(&self, input: CreateWait, cwd: String, now: u64) -> Result<WaitTask, String> {
        let _guard = self.writer()?;
        let path = self.path(&input.id)?;
        if input.thread_id.is_empty()
            || input.thread_id.starts_with("claude:")
            || input.title.trim().is_empty()
            || input.title.len() > 200
            || input.continuation.trim().is_empty()
            || input.continuation.len() > 8000
        {
            return Err("需要 Codex 来源会话、标题和后续动作".into());
        }
        if !path.exists() {
            input.target.validate(now)?;
        }
        if input.target == Target::Custom
            && (input.condition.trim().is_empty() || input.condition.len() > 4000)
        {
            return Err("自定义任务须说明就绪条件（最多4000字节）".into());
        }
        let script = if input.target == Target::Custom {
            let source = Path::new(&input.checker_path);
            if !source.is_absolute() || !source.is_file() {
                return Err("checkerPath 必须是现有 Python 检查脚本的绝对路径".into());
            }
            if fs::metadata(source).map_err(|e| e.to_string())?.len() > 65536 {
                return Err("检查脚本超过64KiB".into());
            }
            let bytes = fs::read(source).map_err(|e| e.to_string())?;
            if bytes.is_empty() || bytes.len() > 65536 {
                return Err("检查脚本须为1–65536字节".into());
            }
            std::str::from_utf8(&bytes).map_err(|_| "检查脚本须为 UTF-8")?;
            bytes
        } else {
            if !input.checker_path.is_empty() {
                return Err("受控工具不接受 checkerPath".into());
            }
            input.target.script()?
        };
        if path.exists() {
            let old = self.read(&input.id)?;
            if old.thread_id == input.thread_id
                && old.title == input.title
                && old.continuation == input.continuation
                && old.condition == input.condition
                && old.cwd == cwd
                && old.target == input.target
                && (old.target != Target::Custom
                    || fs::read(self.checker(&old.id)).map_err(|e| e.to_string())? == script)
            {
                return Ok(old);
            }
            return Err("任务 ID 已用于不同任务".into());
        }
        if self
            .list_unlocked()?
            .iter()
            .filter(|t| {
                t.active() || matches!(t.status.as_str(), "dispatching" | "awaitingApproval")
            })
            .count()
            >= 64
        {
            return Err("最多同时等待64个任务".into());
        }
        atomic(&self.checker(&input.id), &script)?;
        let task = WaitTask {
            id: input.id,
            thread_id: input.thread_id,
            title: input.title,
            continuation: input.continuation,
            condition: input.condition,
            cwd,
            status: if input.target == Target::Custom {
                "awaitingApproval"
            } else {
                "waiting"
            }
            .into(),
            revision: 1,
            created_at: now,
            updated_at: now,
            deadline: match input.target {
                Target::Sleep { wake_at } => wake_at + 7 * 86400,
                _ => now + 7 * 86400,
            },
            next_check_at: now,
            last_checked_at: None,
            failures: 0,
            summary: if input.target == Target::Custom {
                "自定义检查器等待用户确认"
            } else {
                "等待首次检查"
            }
            .into(),
            last_observation: None,
            delivery_failures: 0,
            next_delivery_at: now,
            turn_id: None,
            delivery_id: None,
            approved: input.target != Target::Custom,
            checker_source: (input.target == Target::Custom)
                .then(|| String::from_utf8(script).unwrap()),
            target: input.target,
            draft_staged: false,
        };
        self.write(&task)?;
        Ok(task)
    }
    pub fn update(&self, task: &WaitTask) -> Result<bool, String> {
        let _guard = self.writer()?;
        if self.read(&task.id)?.revision != task.revision {
            return Ok(false);
        }
        let mut next = task.clone();
        next.revision += 1;
        self.write(&next)?;
        Ok(true)
    }
    pub fn action(&self, id: &str, action: &str, now: u64) -> Result<WaitTask, String> {
        let _guard = self.writer()?;
        let mut task = self.read(id)?;
        if task.status == "dispatching" && action != "acknowledge" {
            return Err("结果正在提交或提交结果未知，请先核对会话；不会自动重发".into());
        }
        match action {
            "acknowledge" if matches!(task.status.as_str(), "dispatching" | "uncertain") => {
                task.status = "closed".into();
                task.summary = "用户已核对会话，结束此记录".into();
            }
            "check" if task.active() => {
                task.next_check_at = now;
                task.summary = "收到检查信号，等待核对外部状态".into();
            }
            "pause" if task.active() => {
                task.status = "paused".into();
                task.summary = "用户已暂停".into();
            }
            "cancel" if !matches!(task.status.as_str(), "delivered" | "notified" | "closed") => {
                task.status = "cancelled".into();
                task.summary = "用户已取消".into();
            }
            "resume" if matches!(task.status.as_str(), "paused" | "expired") && !task.approved => {
                task.status = "awaitingApproval".into();
                task.checker_source =
                    Some(fs::read_to_string(self.checker(id)).map_err(|e| e.to_string())?);
                task.summary = "自定义检查器等待用户确认".into();
            }
            "resume" if matches!(task.status.as_str(), "paused" | "expired") && task.approved => {
                task.status = "waiting".into();
                task.next_check_at = now;
                task.deadline = match task.target {
                    Target::Sleep { wake_at } => wake_at.max(now) + 7 * 86400,
                    _ => now + 7 * 86400,
                };
                task.failures = 0;
                task.delivery_failures = 0;
                task.next_delivery_at = now;
                task.summary = "等待重新检查".into();
            }
            _ => return Err("当前状态不支持此操作".into()),
        }
        task.revision += 1;
        task.updated_at = now;
        self.write(&task)?;
        Ok(task)
    }
    // UI-only command: never exported through the Agent management API.
    pub fn review(
        &self,
        id: &str,
        revision: u64,
        approve: bool,
        now: u64,
    ) -> Result<WaitTask, String> {
        let _guard = self.writer()?;
        let mut task = self.read(id)?;
        if task.revision != revision || task.status != "awaitingApproval" {
            return Err("任务已变化，请重新读取后确认".into());
        }
        // Bind approval to the exact snapshot presented to the user.
        if approve {
            let bytes = fs::read(self.checker(id)).map_err(|e| e.to_string())?;
            if task.checker_source.as_deref().map(str::as_bytes) != Some(bytes.as_slice()) {
                return Err("检查脚本已变化，不能批准".into());
            }
        }
        task.approved = approve;
        task.status = if approve { "waiting" } else { "cancelled" }.into();
        task.summary = if approve {
            "用户已同意，等待首次检查"
        } else {
            "用户已拒绝创建"
        }
        .into();
        task.next_check_at = now;
        task.deadline = now + 7 * 86400;
        task.updated_at = now;
        task.revision += 1;
        self.write(&task)?;
        Ok(task)
    }
    pub fn stage_draft(&self, id: &str) -> Result<WaitTask, String> {
        let _guard = self.writer()?;
        let mut task = self.read(id)?;
        if task.status != "notified" {
            return Err("任务尚未通知".into());
        }
        task.draft_staged = true;
        task.revision += 1;
        self.write(&task)?;
        Ok(task)
    }
    pub fn pause_thread(&self, thread: &str, now: u64) -> Result<(), String> {
        let _guard = self.writer()?;
        for mut task in self.list_unlocked()? {
            if task.thread_id == thread && task.active() {
                task.status = "paused".into();
                task.summary = "会话已停止、归档或删除；自动继续已暂停".into();
                task.updated_at = now;
                task.revision += 1;
                self.write(&task)?;
            }
        }
        Ok(())
    }
}
