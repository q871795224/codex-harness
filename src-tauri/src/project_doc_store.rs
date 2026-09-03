//! 项目文档（活文档 / 共享白板）的存储与 seq 写入语义。
//!
//! 存储边界（沿用 handover / state.sqlite 约定）：
//! - 正文 → 文件：`~/.codex-harness/projects/<project-id>/current.md`，每版快照 `history/<seq>.md`。
//! - 簿记 → 本模块独立的 `project_docs.sqlite`（projects / project_workspaces / project_versions）。
//!
//! seq 语义（见 .harness/agent-interaction.md 第七节）在 Rust 单连接事务里强制：
//! - 受控区（status）写入必须 base_seq == current_seq（CAS），不等则冲突；
//! - 追加区（log / decisions / open_questions）不校验 base_seq，由本层按 seq 落序；
//! - 每次成功写入：seq+1、写 current.md、存 history/<seq>.md 快照、记一条 project_versions。
//!
//! 协议外修改防护：写入时记录内容 hash，读取/注入前可校验漂移（hash 不一致即文件被绕过协议改过）。

use crate::store;
use rusqlite::{params, Connection};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const PROJECTS_DIR: &str = "projects";
const DB_FILE: &str = "project_docs.sqlite";
const CURRENT_FILE: &str = "current.md";
const HISTORY_DIR: &str = "history";

/// 受控区：写入必须 base_seq 匹配（CAS）且过审批卡。
const CONTROLLED_SECTIONS: &[&str] = &["status"];
/// 追加区：append-only，免 base_seq 校验。
const APPEND_SECTIONS: &[&str] = &["log", "decisions", "openQuestions"];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub project_id: String,
    pub name: String,
    pub current_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVersion {
    pub seq: i64,
    pub updated_by: String,
    pub updated_at: i64,
    pub summary: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocSnapshot {
    pub project_id: String,
    pub current_seq: i64,
    pub content: String,
    pub content_hash: String,
    /// 文件与库内 hash 是否一致（false = 可能被绕过协议修改）。
    pub consistent: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WriteOutcome {
    Applied { new_seq: i64, content_hash: String },
    Conflict { current_seq: i64, base_seq: Option<i64> },
}

pub struct ProjectDocStore {
    connection: Mutex<Connection>,
    root: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn content_hash(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn is_append_section(section: &str) -> bool {
    APPEND_SECTIONS.contains(&section)
}

fn is_controlled_section(section: &str) -> bool {
    CONTROLLED_SECTIONS.contains(&section)
}

/// 生成落盘文件头：簿记元数据由 Harness 管理，不进注入新会话的正文（同 handover 文件头约定）。
fn render_front_matter(doc_id: &str, seq: i64, updated_by: &str, updated_at: i64) -> String {
    format!(
        "---\ndoc_id: {doc_id}\nseq: {seq}\nupdated_by: {updated_by}\nupdated_at: {updated_at}\n---\n"
    )
}

/// 从落盘文件内容中剥离 front matter，返回纯正文（`find_section` / 注入草稿都用正文）。
/// 没有 front matter（如手工新建的空文档）时原样返回。
fn strip_front_matter(file_content: &str) -> &str {
    if !file_content.starts_with("---\n") {
        return file_content;
    }
    // front matter 以独占一行的 `---` 结束。
    if let Some(close) = file_content[4..].find("\n---\n") {
        let body_start = 4 + close + "\n---\n".len();
        return file_content[body_start..].trim_start_matches('\n');
    }
    // 文件以 front matter 收尾（无正文）。
    if file_content.ends_with("\n---") {
        return "";
    }
    file_content
}

/// 校验 project_id：只允许安全字符，防止路径逃逸。
fn validate_project_id(project_id: &str) -> Result<&str, String> {
    let trimmed = project_id.trim();
    if trimmed.is_empty() {
        return Err("项目 id 不能为空".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("项目 id 只允许字母、数字、短横线和下划线".to_string());
    }
    Ok(trimmed)
}

/// 把一段内容并入文档正文：受控区是整段替换对应 `## <Title>` section，追加区是往对应 section 末尾追加。
/// 分区是推荐约定：目标 section 不存在时，追加区自动补建，受控区要求文档已有该 section。
fn apply_section_write(current: &str, section: &str, content: &str) -> Result<String, String> {
    let heading = section_heading(section);
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("写入内容不能为空".to_string());
    }

    match find_section(current, &heading) {
        Some((body_start, body_end)) => {
            let mut result = String::with_capacity(current.len() + trimmed.len() + 4);
            if is_append_section(section) {
                result.push_str(&current[..body_end]);
                if !current[..body_end].ends_with('\n') {
                    result.push('\n');
                }
                result.push_str(trimmed);
                result.push('\n');
                result.push_str(&current[body_end..]);
            } else {
                // 受控区整段替换 section 正文（保留标题行）。
                result.push_str(&current[..body_start]);
                result.push_str(trimmed);
                result.push('\n');
                result.push_str(&current[body_end..]);
            }
            Ok(result)
        }
        None => {
            if is_controlled_section(section) {
                return Err(format!("文档缺少 `## {heading}` 分区，受控区无法写入"));
            }
            // 追加区：文档没有该 section 时在文末补建。
            let mut result = String::with_capacity(current.len() + heading.len() + trimmed.len() + 8);
            result.push_str(current);
            if !current.is_empty() && !current.ends_with('\n') {
                result.push('\n');
            }
            result.push_str("\n## ");
            result.push_str(&heading);
            result.push_str("\n\n");
            result.push_str(trimmed);
            result.push('\n');
            Ok(result)
        }
    }
}

fn section_heading(section: &str) -> String {
    match section {
        "status" => "Status".to_string(),
        "log" => "Log".to_string(),
        "decisions" => "Decisions".to_string(),
        "openQuestions" => "Open Questions".to_string(),
        other => other.to_string(),
    }
}

/// 在 markdown 正文里定位 `## <heading>` section 的正文区间 [body_start, body_end)。
/// body_start 是标题行之后的内容起点；body_end 是下一个同级或更高级标题的起点（或文末）。
fn find_section(content: &str, heading: &str) -> Option<(usize, usize)> {
    let target = format!("## {heading}");
    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        let line_end = offset + line.len();
        offset = line_end;
        let text = line.trim_end_matches(['\n', '\r']);
        if text == target || text == format!("{target} ") {
            let body_start = line_end;
            // 找下一个 `## ` 或 `# ` 标题作为 section 结束。
            let mut inner = body_start;
            for sub in content[body_start..].split_inclusive('\n') {
                let t = sub.trim_end_matches(['\n', '\r']);
                if t.starts_with("## ") || (t.starts_with("# ") && !t.starts_with("## ")) {
                    return Some((body_start, inner));
                }
                inner += sub.len();
            }
            return Some((body_start, content.len()));
        }
    }
    None
}

impl ProjectDocStore {
    pub fn open() -> Result<Self, String> {
        let root = store::harness_data_dir()?;
        fs::create_dir_all(&root).map_err(|e| format!("无法创建数据目录 {}: {e}", root.display()))?;
        let connection = Connection::open(root.join(DB_FILE))
            .map_err(|e| format!("无法打开项目文档库: {e}"))?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS projects (
                  project_id TEXT PRIMARY KEY NOT NULL,
                  name TEXT NOT NULL,
                  current_seq INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_workspaces (
                  project_id TEXT NOT NULL,
                  workspace_root TEXT NOT NULL,
                  PRIMARY KEY(project_id, workspace_root),
                  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS project_versions (
                  project_id TEXT NOT NULL,
                  seq INTEGER NOT NULL,
                  updated_by TEXT NOT NULL,
                  updated_at INTEGER NOT NULL,
                  summary TEXT NOT NULL DEFAULT '',
                  content_hash TEXT NOT NULL,
                  PRIMARY KEY(project_id, seq),
                  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
                );
                "#,
            )
            .map_err(|e| format!("无法初始化项目文档库: {e}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
            root,
        })
    }

    fn project_dir(&self, project_id: &str) -> PathBuf {
        self.root.join(PROJECTS_DIR).join(project_id)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "项目文档库锁不可用".to_string())
    }

    /// 创建项目并初始化空文档（seq=0）。
    pub fn create_project(&self, project_id: &str, name: &str) -> Result<ProjectMeta, String> {
        let id = validate_project_id(project_id)?;
        let now = now_ms();
        let dir = self.project_dir(id);
        fs::create_dir_all(dir.join(HISTORY_DIR))
            .map_err(|e| format!("无法创建项目目录 {}: {e}", dir.display()))?;
        let current_path = dir.join(CURRENT_FILE);
        if !current_path.exists() {
            fs::write(&current_path, "").map_err(|e| format!("无法初始化项目文档: {e}"))?;
        }
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT INTO projects (project_id, name, current_seq, created_at, updated_at)
                 VALUES (?1, ?2, 0, ?3, ?3)
                 ON CONFLICT(project_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
                params![id, name, now],
            )
            .map_err(|e| format!("无法写入项目记录: {e}"))?;
        drop(connection);
        self.get_project(id)
    }

    pub fn get_project(&self, project_id: &str) -> Result<ProjectMeta, String> {
        let id = validate_project_id(project_id)?;
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT project_id, name, current_seq, created_at, updated_at FROM projects WHERE project_id = ?1",
                params![id],
                |row| {
                    Ok(ProjectMeta {
                        project_id: row.get(0)?,
                        name: row.get(1)?,
                        current_seq: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(|e| format!("项目不存在或读取失败: {e}"))
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectMeta>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT project_id, name, current_seq, created_at, updated_at FROM projects ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("无法查询项目列表: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectMeta {
                    project_id: row.get(0)?,
                    name: row.get(1)?,
                    current_seq: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("无法读取项目列表: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("无法读取项目: {e}"))?);
        }
        Ok(result)
    }

    /// 绑定 / 解绑工作区（多对多，支撑跨 workspace 项目）。
    pub fn bind_workspace(&self, project_id: &str, workspace_root: &str) -> Result<(), String> {
        let id = validate_project_id(project_id)?;
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT OR IGNORE INTO project_workspaces (project_id, workspace_root) VALUES (?1, ?2)",
                params![id, workspace_root],
            )
            .map_err(|e| format!("无法绑定工作区: {e}"))?;
        Ok(())
    }

    pub fn list_workspaces(&self, project_id: &str) -> Result<Vec<String>, String> {
        let id = validate_project_id(project_id)?;
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare("SELECT workspace_root FROM project_workspaces WHERE project_id = ?1")
            .map_err(|e| format!("无法查询项目工作区: {e}"))?;
        let rows = stmt
            .query_map(params![id], |row| row.get(0))
            .map_err(|e| format!("无法读取项目工作区: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("无法读取工作区: {e}"))?);
        }
        Ok(result)
    }

    /// 读取纯正文（剥离 front matter）：供 `find_section` / `apply_section_write` / 注入草稿使用。
    fn read_body(&self, project_id: &str) -> Result<String, String> {
        let path = self.project_dir(project_id).join(CURRENT_FILE);
        match fs::read_to_string(&path) {
            Ok(content) => Ok(strip_front_matter(&content).to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("无法读取项目文档 {}: {e}", path.display())),
        }
    }

    /// 读取落盘全文（含 front matter），用于 hash 校验。
    fn read_file_full(&self, project_id: &str) -> Result<String, String> {
        let path = self.project_dir(project_id).join(CURRENT_FILE);
        match fs::read_to_string(&path) {
            Ok(content) => Ok(content),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("无法读取项目文档 {}: {e}", path.display())),
        }
    }

    /// 读取当前文档 + seq + hash 一致性（注入/展示前校验漂移）。
    pub fn read_doc(&self, project_id: &str) -> Result<ProjectDocSnapshot, String> {
        let id = validate_project_id(project_id)?;
        let content = self.read_file_full(id)?;
        let hash = content_hash(&content);
        let connection = self.lock()?;
        let (current_seq, stored_hash) = connection
            .query_row(
                "SELECT current_seq,
                        (SELECT content_hash FROM project_versions
                          WHERE project_id = ?1 AND seq = projects.current_seq) AS h
                 FROM projects WHERE project_id = ?1",
                params![id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map_err(|e| format!("项目不存在或读取失败: {e}"))?;
        let consistent = match stored_hash {
            Some(h) => h == hash,
            // seq=0（还没有任何版本）时以空文档为准。
            None => current_seq == 0 && content.is_empty(),
        };
        Ok(ProjectDocSnapshot {
            project_id: id.to_string(),
            current_seq,
            // content 给前端展示/注入，用纯正文（剥离 front matter）。
            content: strip_front_matter(&content).to_string(),
            content_hash: hash,
            consistent,
        })
    }

    pub fn list_versions(&self, project_id: &str) -> Result<Vec<ProjectVersion>, String> {
        let id = validate_project_id(project_id)?;
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT seq, updated_by, updated_at, summary, content_hash FROM project_versions
                 WHERE project_id = ?1 ORDER BY seq DESC",
            )
            .map_err(|e| format!("无法查询版本历史: {e}"))?;
        let rows = stmt
            .query_map(params![id], |row| {
                Ok(ProjectVersion {
                    seq: row.get(0)?,
                    updated_by: row.get(1)?,
                    updated_at: row.get(2)?,
                    summary: row.get(3)?,
                    content_hash: row.get(4)?,
                })
            })
            .map_err(|e| format!("无法读取版本历史: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("无法读取版本: {e}"))?);
        }
        Ok(result)
    }

    /**
     * 写入一个分区。seq 校验与落盘在同一临界区内完成：
     * - 追加区：不校验 base_seq；
     * - 受控区：base_seq 必须等于 current_seq，否则返回 Conflict。
     * 成功则 seq+1、重写 current.md、存 history/<seq>.md 快照、记版本。
     */
    pub fn write_section(
        &self,
        project_id: &str,
        section: &str,
        base_seq: Option<i64>,
        content: &str,
        updated_by: &str,
        summary: &str,
    ) -> Result<WriteOutcome, String> {
        let id = validate_project_id(project_id)?;
        if !is_append_section(section) && !is_controlled_section(section) {
            return Err(format!("未知分区 `{section}`"));
        }

        // 整个 read-check-write 在锁内完成，保证 seq 语义原子。
        let connection = self.lock()?;
        let current_seq: i64 = connection
            .query_row(
                "SELECT current_seq FROM projects WHERE project_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("项目不存在: {e}"))?;

        if is_controlled_section(section) && base_seq != Some(current_seq) {
            return Ok(WriteOutcome::Conflict {
                current_seq,
                base_seq,
            });
        }

        let body = self.read_body(id)?;
        let next_body = apply_section_write(&body, section, content)?;
        let new_seq = current_seq + 1;
        let now = now_ms();
        // 落盘 = front matter（Harness 簿记）+ 正文；hash 对落盘全文算，覆盖 front matter 的漂移防护。
        let next_file = format!(
            "{}\n{}",
            render_front_matter(id, new_seq, updated_by, now),
            next_body
        );
        let hash = content_hash(&next_file);

        let dir = self.project_dir(id);
        fs::create_dir_all(dir.join(HISTORY_DIR))
            .map_err(|e| format!("无法创建快照目录: {e}"))?;
        fs::write(dir.join(CURRENT_FILE), &next_file).map_err(|e| format!("无法写入项目文档: {e}"))?;
        fs::write(dir.join(HISTORY_DIR).join(format!("{new_seq}.md")), &next_file)
            .map_err(|e| format!("无法写入版本快照: {e}"))?;

        connection
            .execute(
                "INSERT INTO project_versions (project_id, seq, updated_by, updated_at, summary, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, new_seq, updated_by, now, summary, hash],
            )
            .map_err(|e| format!("无法记录版本: {e}"))?;
        connection
            .execute(
                "UPDATE projects SET current_seq = ?2, updated_at = ?3 WHERE project_id = ?1",
                params![id, new_seq, now],
            )
            .map_err(|e| format!("无法推进项目版本: {e}"))?;

        Ok(WriteOutcome::Applied {
            new_seq,
            content_hash: hash,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_project_id() {
        assert!(validate_project_id("proj-1").is_ok());
        assert!(validate_project_id("proj_1").is_ok());
        assert!(validate_project_id("../evil").is_err());
        assert!(validate_project_id("a/b").is_err());
        assert!(validate_project_id("").is_err());
        assert!(validate_project_id("a b").is_err());
    }

    #[test]
    fn finds_section_body() {
        let doc = "# Title\n\n## Status\n\nold body\n\n## Log\n\nentry\n";
        // Status 正文到下一个 `## ` 标题起点为止（含中间的空行）。
        let (start, end) = find_section(doc, "Status").expect("finds status");
        assert_eq!(&doc[start..end], "\nold body\n\n");
        let (start, end) = find_section(doc, "Log").expect("finds log");
        assert_eq!(&doc[start..end], "\nentry\n");
        assert!(find_section(doc, "Decisions").is_none());
    }

    #[test]
    fn controlled_section_replaces_body() {
        let doc = "# T\n\n## Status\n\nold\n\n## Log\n\nkeep\n";
        let next = apply_section_write(doc, "status", "new body").unwrap();
        assert!(next.contains("## Status\nnew body\n"), "got: {next}");
        assert!(next.contains("## Log\n\nkeep\n"), "log preserved: {next}");
        assert!(!next.contains("old"), "old status removed: {next}");
    }

    #[test]
    fn append_section_appends_and_creates_when_missing() {
        let doc = "# T\n\n## Log\n\nfirst\n";
        let next = apply_section_write(doc, "log", "second").unwrap();
        assert!(next.contains("first\nsecond\n"), "appended: {next}");

        // 追加区缺 section 时自动补建。
        let bare = "# T\n\n## Status\n\ns\n";
        let next = apply_section_write(bare, "decisions", "d1").unwrap();
        assert!(next.contains("## Decisions\n\nd1\n"), "created: {next}");
        assert!(next.contains("## Status"), "status preserved: {next}");
    }

    #[test]
    fn controlled_section_missing_is_error() {
        let doc = "# T\n\n## Log\n\nx\n";
        assert!(apply_section_write(doc, "status", "s").is_err());
    }

    #[test]
    fn rejects_empty_write() {
        assert!(apply_section_write("# T\n\n## Log\n", "log", "   ").is_err());
    }

    #[test]
    fn strips_front_matter() {
        let full = "---\ndoc_id: p1\nseq: 3\nupdated_by: run-x\nupdated_at: 1\n---\n\n# Doc\n\n## Status\n\ns\n";
        assert_eq!(strip_front_matter(full), "# Doc\n\n## Status\n\ns\n");
        // 无 front matter 原样返回。
        assert_eq!(strip_front_matter("# Doc\n"), "# Doc\n");
        // 只有 front matter 时返回空正文。
        assert_eq!(strip_front_matter("---\ndoc_id: p1\nseq: 0\n---"), "");
    }

    #[test]
    fn find_section_ignores_front_matter() {
        let full = "---\ndoc_id: p1\nseq: 3\n---\n\n## Status\n\nbody\n";
        let (start, end) = find_section(strip_front_matter(full), "Status").expect("finds status");
        let body = strip_front_matter(full);
        assert_eq!(&body[start..end], "\nbody\n");
    }
}
