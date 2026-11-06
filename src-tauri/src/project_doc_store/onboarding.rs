//! A user-confirmed onboarding task commits one validated change set and snapshot.
use super::*;
use rusqlite::OptionalExtension;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingCommit {
    pub request_id: String,
    pub project_id: String,
    pub thread_id: String,
    pub name: Option<String>,
    pub base_seq: Option<i64>,
    pub status: Option<String>,
    pub log: Vec<String>,
    pub decisions: Vec<String>,
    pub open_questions: Vec<String>,
    pub mutations: Vec<EntryMutation>,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingReceipt {
    pub project_id: String,
    pub seq: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedOnboarding {
    pub request_id: String,
    pub thread_id: String,
    pub project_id: String,
    pub seq: i64,
    pub name: String,
}

impl ProjectDocStore {
    pub fn saved_onboardings(&self) -> Result<Vec<SavedOnboarding>, String> {
        let db = self.lock()?;
        let mut query = db.prepare("SELECT operation,updated_by,v.project_id,seq,p.name FROM project_versions v JOIN projects p ON p.project_id=v.project_id WHERE operation LIKE 'onboarding:%' AND NOT EXISTS(SELECT 1 FROM archived_projects a WHERE a.project_id=v.project_id)").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([], |r| {
                let operation: String = r.get(0)?;
                Ok(SavedOnboarding {
                    request_id: operation["onboarding:".len()..].into(),
                    thread_id: r.get(1)?,
                    project_id: r.get(2)?,
                    seq: r.get(3)?,
                    name: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn onboarding_receipt(
        &self,
        request: &str,
        thread: &str,
    ) -> Result<Option<OnboardingReceipt>, String> {
        let db = self.lock()?;
        receipt(&db, request, thread)
    }
    pub fn commit_onboarding(&self, input: &OnboardingCommit) -> Result<OnboardingReceipt, String> {
        validate_project_id(&input.project_id)?;
        validate_project_id(&input.request_id)?;
        if input.thread_id.trim().is_empty() {
            return Err("缺少来源会话".into());
        }
        let db = self.lock()?;
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(done) = receipt(&tx, &input.request_id, &input.thread_id)? {
            if done.project_id != input.project_id {
                return Err("同一任务不能更换目标项目".into());
            }
            return Ok(done);
        }
        let created = input.name.is_some();
        if created && input.status.as_deref().is_none_or(|s| s.trim().is_empty()) {
            return Err("新项目必须包含当前概况".into());
        }
        let initial = "## Status\n\n## Log\n\n## Decisions\n\n## Open Questions\n";
        let (seq, mut body) = if let Some(name) = &input.name {
            if name.trim().is_empty() {
                return Err("项目名称不能为空".into());
            }
            if self.project_dir(&input.project_id).exists() {
                return Err("目标项目目录已存在".into());
            }
            let now = now_ms();
            tx.execute("INSERT INTO projects(project_id,name,current_seq,created_at,updated_at) VALUES(?1,?2,0,?3,?3)",
                params![input.project_id, name.trim(), now]).map_err(|e| e.to_string())?;
            (0, initial.to_string())
        } else {
            let archived: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM archived_projects WHERE project_id=?1)",
                    [&input.project_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if archived {
                return Err("目标项目已归档".into());
            }
            let (seq, file) = compaction::current_checked(self, &tx, &input.project_id)?;
            if input.base_seq != Some(seq) {
                return Err("项目版本冲突，请重新读取文档后整理；已有内容未修改".into());
            }
            let body = strip_front_matter(&file);
            (
                seq,
                if body.trim().is_empty() {
                    initial.into()
                } else {
                    body.into()
                },
            )
        };
        if input.log.len()
            + input.decisions.len()
            + input.open_questions.len()
            + input.mutations.len()
            > 200
        {
            return Err("一次补记条目过多".into());
        }
        if let Some(status) = &input.status {
            entries::validate_content(status)?;
            if status.contains("project-entry") {
                return Err("Status 不能包含系统条目标记".into());
            }
            body = apply_section_write(&body, "status", status)?;
        }
        let mut adopted = std::collections::HashMap::<String, String>::new();
        for proposed in &input.mutations {
            let mut mutation = proposed.clone();
            if mutation.action != "adopt" {
                if let Some(alias) = mutation.id.as_deref().filter(|id| id.starts_with('@')) {
                    mutation.id = Some(adopted.get(alias).ok_or("旧段落临时引用尚未纳管")?.clone());
                }
            }
            if !matches!(
                mutation.action.as_str(),
                "update" | "supersede" | "revoke" | "close" | "reopen" | "adopt"
            ) {
                return Err("补记只支持修订、替代、撤销、待办状态与旧段落纳管".into());
            }
            if mutation.action == "adopt" && mutation.base_seq != Some(seq) {
                return Err("纳管版本冲突".into());
            }
            let before = entries::list(&body)?;
            body = entries::mutated(&body, &mutation, &input.thread_id)?;
            if mutation.action == "adopt" {
                if let Some(alias) = mutation.id.as_deref() {
                    if !alias.starts_with('@') || adopted.contains_key(alias) {
                        return Err("纳管临时引用必须以 @ 开头且唯一".into());
                    }
                    let added = entries::list(&body)?
                        .into_iter()
                        .find(|e| !before.iter().any(|b| b.meta.id == e.meta.id))
                        .ok_or("纳管未生成条目")?;
                    adopted.insert(alias.into(), added.meta.id);
                }
            }
        }
        for (section, values) in [
            ("log", &input.log),
            ("decisions", &input.decisions),
            ("openQuestions", &input.open_questions),
        ] {
            for value in values {
                entries::validate_content(value)?;
                let content =
                    entries::append_content(section, value, &input.thread_id, "会话加入项目补记")?;
                body = apply_section_write(&body, section, &content)?;
            }
        }
        entries::list(&body)?;
        let dir = self.project_dir(&input.project_id);
        if created {
            fs::create_dir_all(dir.join(HISTORY_DIR)).map_err(|e| e.to_string())?;
            fs::write(dir.join(CURRENT_FILE), "").map_err(|e| e.to_string())?;
        }
        let result = persist_body(
            tx,
            &dir,
            &input.project_id,
            seq,
            &body,
            &input.thread_id,
            "从会话建立项目记忆",
            &format!("onboarding:{}", input.request_id),
        );
        if let Err(error) = result {
            if created {
                let _ = fs::remove_dir_all(&dir);
            }
            return Err(error);
        }
        Ok(OnboardingReceipt {
            project_id: input.project_id.clone(),
            seq: seq + 1,
        })
    }
}
fn receipt(
    db: &Connection,
    request: &str,
    thread: &str,
) -> Result<Option<OnboardingReceipt>, String> {
    let row: Option<(String, i64, String)> = db
        .query_row(
            "SELECT project_id,seq,updated_by FROM project_versions WHERE operation=?1",
            [format!("onboarding:{request}")],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((_, _, by)) if by != thread => Err("任务不属于该会话".into()),
        Some((project_id, seq, _)) => Ok(Some(OnboardingReceipt { project_id, seq })),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> OnboardingCommit {
        serde_json::from_value(serde_json::json!({"requestId":"request-1","projectId":"project-1","threadId":"thread-1",
            "name":"新项目","baseSeq":null,"status":"当前目标","log":["完成验收"],"decisions":["只补缺失项"],"openQuestions":["跟进上线"],"mutations":[]})).unwrap()
    }
    #[test]
    fn commits_one_snapshot_and_retries_without_duplicate_entries() {
        let d = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(d.path().into()).unwrap();
        let i = input();
        let done = store.commit_onboarding(&i).unwrap();
        assert_eq!(done.seq, 1);
        let doc = store.read_doc("project-1").unwrap();
        assert_eq!(doc.entries.len(), 2);
        assert!(doc.content.contains("完成验收"));
        assert_eq!(store.commit_onboarding(&i).unwrap().seq, 1);
        assert_eq!(store.read_doc("project-1").unwrap().current_seq, 1);
        assert!(store.onboarding_receipt("request-1", "other").is_err());
    }
    #[test]
    fn adopts_and_supersedes_a_legacy_decision_and_closes_a_task_atomically() {
        let d = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(d.path().into()).unwrap();
        store.commit_onboarding(&input()).unwrap();
        let initial = store.read_doc("project-1").unwrap();
        let question = initial
            .entries
            .iter()
            .find(|e| e.meta.section == "openQuestions")
            .unwrap();
        let legacy =
            apply_section_write(&initial.content, "decisions", "旧方案：全量同步").unwrap();
        store
            .write_document("project-1", Some(1), &legacy, "user", "legacy")
            .unwrap();
        let mut next = input();
        next.request_id = "request-2".into();
        next.name = None;
        next.base_seq = Some(2);
        next.decisions.clear();
        next.open_questions.clear();
        next.log.clear();
        next.mutations=serde_json::from_value(serde_json::json!([
            {"action":"adopt","id":"@old","section":"decisions","baseSeq":2,"content":"旧方案：全量同步","reason":"纳管已有规则"},
            {"action":"supersede","id":"@old","revision":1,"content":"仅补缺失项","reason":"用户调整范围"},
            {"action":"close","id":question.meta.id,"revision":1,"reason":"验收完成，证据已确认"}
        ])).unwrap();
        assert_eq!(store.commit_onboarding(&next).unwrap().seq, 3);
        let result = store.read_doc("project-1").unwrap();
        assert_eq!(result.entries.len(), 4);
        let old = result
            .entries
            .iter()
            .find(|e| e.content == "旧方案：全量同步")
            .unwrap();
        assert_eq!(old.meta.state, "superseded");
        assert!(old.meta.replaced_by.is_some());
        assert_eq!(
            result
                .entries
                .iter()
                .find(|e| e.meta.id == question.meta.id)
                .unwrap()
                .meta
                .state,
            "done"
        );
        assert_eq!(store.saved_onboardings().unwrap().len(), 2);
    }

    #[test]
    fn rejects_a_stale_target_and_rolls_back_the_entire_change_set() {
        let d = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(d.path().into()).unwrap();
        store.commit_onboarding(&input()).unwrap();
        let mut i = input();
        i.request_id = "request-2".into();
        i.name = None;
        i.base_seq = Some(0);
        assert!(store.commit_onboarding(&i).unwrap_err().contains("冲突"));
        i.base_seq = Some(1);
        i.mutations.push(
            serde_json::from_value(
                serde_json::json!({"action":"close","id":"missing","revision":1,"reason":"完成"}),
            )
            .unwrap(),
        );
        assert!(store.commit_onboarding(&i).is_err());
        assert_eq!(store.read_doc("project-1").unwrap().current_seq, 1);
        i.project_id = "invalid-new".into();
        i.name = Some("新项目".into());
        assert!(store.commit_onboarding(&i).is_err());
        assert!(store.get_project("invalid-new").is_err());
        assert!(!store.project_dir("invalid-new").exists());
    }
}
