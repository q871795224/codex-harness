//! 项目文档「待审批提议」队列（Agent 经本地 HTTP 回传的写请求）。
//!
//! 与文本协议（`<project-doc-update>`）的区别：提议不再靠 Agent 在输出里 emit 标记块，
//! 而是 Agent 运行 `project-doc propose` 命令 → 本地 HTTP 回传到本模块。
//! `base_seq` 由 Harness 在**入队时**读取当前 seq 自动补齐（Agent 不用关心版本号），
//! 人确认后仍走 `write_section` 的 seq CAS 兜底（确认期间别人改过则冲突）。
//!
//! 存储：与 project_docs.sqlite 同库的 `project_doc_proposals` 表（追加、按 id 消费）。

use rusqlite::{params, Connection};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一条待审批提议。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocProposal {
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    pub section: String,
    pub content: String,
    /// 入队时 Harness 读到的当前 seq（展示用；写入时仍以 CAS 为准）。
    pub base_seq: i64,
    pub created_at: i64,
}

pub struct ProposalQueue {
    connection: Mutex<Connection>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl ProposalQueue {
    /// 在指定数据库连接上初始化（与主 store 共用同一 project_docs.sqlite 文件）。
    /// 设 busy_timeout：与主 store / HTTP 服务并发写同一文件时等待而非立刻报「database is locked」。
    pub fn open_at(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                r#"
                PRAGMA busy_timeout = 5000;
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS project_doc_proposals (
                  id TEXT PRIMARY KEY NOT NULL,
                  project_id TEXT NOT NULL,
                  thread_id TEXT NOT NULL,
                  section TEXT NOT NULL,
                  content TEXT NOT NULL,
                  base_seq INTEGER NOT NULL,
                  created_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(|e| format!("无法初始化提议队列: {e}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// 入队一条提议（base_seq 由调用方在入队前读当前 seq 填入）。
    pub fn enqueue(&self, proposal: &DocProposal) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT INTO project_doc_proposals (id, project_id, thread_id, section, content, base_seq, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    proposal.id,
                    proposal.project_id,
                    proposal.thread_id,
                    proposal.section,
                    proposal.content,
                    proposal.base_seq,
                    proposal.created_at
                ],
            )
            .map_err(|e| format!("无法入队提议: {e}"))?;
        Ok(())
    }

    /// 列出某项目的全部待审批提议（按入队时间正序）。
    pub fn list_pending(&self, project_id: &str) -> Result<Vec<DocProposal>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT id, project_id, thread_id, section, content, base_seq, created_at
                 FROM project_doc_proposals WHERE project_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("无法查询提议: {e}"))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(DocProposal {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    section: row.get(3)?,
                    content: row.get(4)?,
                    base_seq: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| format!("无法读取提议: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("无法读取提议: {e}"))?);
        }
        Ok(result)
    }

    /// 取单条提议（审批卡确认前回读）。
    pub fn get(&self, id: &str) -> Result<Option<DocProposal>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT id, project_id, thread_id, section, content, base_seq, created_at
                 FROM project_doc_proposals WHERE id = ?1",
            )
            .map_err(|e| format!("无法查询提议: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(DocProposal {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    section: row.get(3)?,
                    content: row.get(4)?,
                    base_seq: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| format!("无法读取提议: {e}"))?;
        match rows.next() {
            Some(Ok(proposal)) => Ok(Some(proposal)),
            Some(Err(e)) => Err(format!("无法读取提议: {e}")),
            None => Ok(None),
        }
    }

    /// 删除（确认落盘后 / 人拒绝后消费）。
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute("DELETE FROM project_doc_proposals WHERE id = ?1", params![id])
            .map_err(|e| format!("无法删除提议: {e}"))?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection.lock().map_err(|_| "提议队列锁不可用".to_string())
    }
}

/// 生成一条新提议（id/时间戳由 Harness 生成）。
pub fn new_proposal(project_id: &str, thread_id: &str, section: &str, content: &str, base_seq: i64) -> DocProposal {
    DocProposal {
        id: format!("prop-{}", uuid_v4()),
        project_id: project_id.to_string(),
        thread_id: thread_id.to_string(),
        section: section.to_string(),
        content: content.to_string(),
        base_seq,
        created_at: now_ms(),
    }
}

fn uuid_v4() -> String {
    // 简单随机 id（无需密码学强度）；用时间戳 + 进程内计数器 + 随机数拼。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}{:x}", nanos, count, std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> ProposalQueue {
        ProposalQueue::open_at(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn enqueue_and_list_pending_by_project() {
        let queue = queue();
        queue.enqueue(&new_proposal("p1", "t1", "status", "内容 A", 3)).unwrap();
        queue.enqueue(&new_proposal("p1", "t1", "log", "内容 B", 3)).unwrap();
        queue.enqueue(&new_proposal("p2", "t9", "status", "别的项目", 1)).unwrap();

        let p1 = queue.list_pending("p1").unwrap();
        assert_eq!(p1.len(), 2);
        assert_eq!(p1[0].content, "内容 A");
        assert_eq!(p1[1].content, "内容 B");
        assert!(p1.iter().all(|p| p.base_seq == 3));
        // 按项目隔离。
        assert_eq!(queue.list_pending("p2").unwrap().len(), 1);
        assert_eq!(queue.list_pending("p3").unwrap().len(), 0);
    }

    #[test]
    fn get_and_remove() {
        let queue = queue();
        let proposal = new_proposal("p1", "t1", "status", "内容", 2);
        let id = proposal.id.clone();
        queue.enqueue(&proposal).unwrap();
        assert_eq!(queue.get(&id).unwrap(), Some(proposal));
        queue.remove(&id).unwrap();
        assert_eq!(queue.get(&id).unwrap(), None);
        assert_eq!(queue.list_pending("p1").unwrap().len(), 0);
    }

    #[test]
    fn proposal_ids_are_unique() {
        let a = new_proposal("p", "t", "status", "x", 0);
        let b = new_proposal("p", "t", "status", "x", 0);
        assert_ne!(a.id, b.id);
    }
}
