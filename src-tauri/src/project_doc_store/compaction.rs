//! Harness owns archives, concurrency checks and replacement; the model only returns Markdown.
use super::*;
use std::io::Write;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeasure {
    pub seq: i64,
    pub tokens: usize,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionInput {
    pub job_id: String,
    pub base_seq: i64,
    pub content: String,
    pub archive_path: String,
    pub tokens: usize,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionResult {
    pub new_seq: i64,
    pub before_tokens: usize,
    pub after_tokens: usize,
    pub archive_path: String,
}
fn tokens(text: &str) -> usize {
    tiktoken_rs::o200k_base_singleton()
        .encode_ordinary(text)
        .len()
}
fn save_archive(path: &std::path::Path, content: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("无法归档原文: {e}"))?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("无法归档原文: {e}"))
}
fn current_checked(
    store: &ProjectDocStore,
    connection: &Connection,
    id: &str,
) -> Result<(i64, String), String> {
    let (seq, expected): (i64, Option<String>) = connection.query_row(
        "SELECT current_seq, (SELECT content_hash FROM project_versions WHERE project_id=?1 AND seq=projects.current_seq) FROM projects WHERE project_id=?1",
        [id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let file = store.read_file_full(id)?;
    if expected.as_deref() != Some(&content_hash(&file)) && !(seq == 0 && file.is_empty()) {
        return Err("项目文档被协议外修改，已停止整理".into());
    }
    Ok((seq, file))
}
impl ProjectDocStore {
    pub fn measure(&self, id: &str) -> Result<DocumentMeasure, String> {
        let snapshot = self.read_doc(id)?;
        if !snapshot.consistent {
            return Err("项目文档存在协议外修改".into());
        }
        let mut counts = self.token_counts.lock().map_err(|_| "Token 计数锁不可用")?;
        let entry = counts
            .entry(snapshot.project_id)
            .or_insert_with(|| (String::new(), 0));
        if entry.0 != snapshot.content_hash {
            *entry = (snapshot.content_hash, tokens(&snapshot.content));
        }
        Ok(DocumentMeasure {
            seq: snapshot.current_seq,
            tokens: entry.1,
        })
    }
    pub fn begin_compaction(&self, id: &str) -> Result<CompactionInput, String> {
        let id = validate_project_id(id)?;
        let guard = self.lock()?;
        let tx = Transaction::new_unchecked(&guard, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_compactions WHERE project_id=?1 AND created_at>?2)", params![id, now_ms()-900_000], |r| r.get(0)).map_err(|e| e.to_string())?;
        if busy {
            return Err("该项目正在整理，请稍后再试".into());
        }
        let (seq, file) = current_checked(self, &tx, id)?;
        let content = strip_front_matter(&file).to_string();
        if content.trim().is_empty() {
            return Err("项目文档为空，无需整理".into());
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let job_id = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = self.project_dir(id).join("archives");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let archive = dir.join(format!("{seq}-{job_id}.md"));
        save_archive(&archive, &file)?;
        let archive_path = archive.to_string_lossy().into_owned();
        tx.execute(
            "INSERT OR REPLACE INTO project_compactions VALUES (?1,?2,?3,?4,?5)",
            params![id, job_id, seq, archive_path, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(CompactionInput {
            job_id,
            base_seq: seq,
            tokens: tokens(&content),
            content,
            archive_path,
        })
    }
    pub fn cancel_compaction(&self, id: &str, job: &str) -> Result<(), String> {
        self.lock()?
            .execute(
                "DELETE FROM project_compactions WHERE project_id=?1 AND job_id=?2",
                params![id, job],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn complete_compaction(
        &self,
        id: &str,
        job: &str,
        output: &str,
    ) -> Result<CompactionResult, String> {
        let id = validate_project_id(id)?;
        let guard = self.lock()?;
        let tx = Transaction::new_unchecked(&guard, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (base, archive): (i64, String) = tx.query_row("SELECT base_seq, archive_path FROM project_compactions WHERE project_id=?1 AND job_id=?2", params![id, job], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "整理任务已结束或已过期")?;
        let original = fs::read_to_string(&archive).map_err(|e| e.to_string())?;
        let expected: String = tx
            .query_row(
                "SELECT content_hash FROM project_versions WHERE project_id=?1 AND seq=?2",
                params![id, base],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if content_hash(&original) != expected {
            return Err("归档原文校验失败，已停止整理".into());
        }
        let original_body = strip_front_matter(&original);
        let output = output.trim();
        let sections = ["Status", "Log", "Decisions", "Open Questions"];
        if output.starts_with("```")
            || !output.starts_with("## Status\n")
            || sections.iter().any(|s| {
                output
                    .lines()
                    .filter(|line| *line == format!("## {s}"))
                    .count()
                    != 1
            })
        {
            return Err("精简结果格式无效，原文未替换".into());
        }
        if tokens(output) >= tokens(original_body) {
            return Err("精简结果未缩短，原文未替换".into());
        }
        let mut next = output.to_string();
        // Always add an archive pointer even when the model omits it.
        next = apply_section_write(
            &next,
            "log",
            &format!(
                "历史原文：[整理前 v{base}]({archive})。需要追溯时查询；历史结论可能已被替代。"
            ),
        )?;
        let (current_seq, current_file) = current_checked(self, &tx, id)?;
        let mut previous = original_body.to_string();
        for seq in base + 1..=current_seq {
            let operation: String = tx
                .query_row(
                    "SELECT operation FROM project_versions WHERE project_id=?1 AND seq=?2",
                    params![id, seq],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let section = operation
                .strip_prefix("append:")
                .filter(|s| is_append_section(s))
                .ok_or("整理期间文档被修改，已停止；原文未替换")?;
            let file = fs::read_to_string(
                self.project_dir(id)
                    .join(HISTORY_DIR)
                    .join(format!("{seq}.md")),
            )
            .map_err(|e| e.to_string())?;
            let body = strip_front_matter(&file);
            let heading = section_heading(section);
            let (start, end) = find_section(body, &heading).ok_or("追加记录缺少分区")?;
            let before = find_section(&previous, &heading)
                .map(|(s, e)| &previous[s..e])
                .unwrap_or("");
            let delta = body[start..end]
                .strip_prefix(before)
                .ok_or("追加记录不一致，已停止整理")?
                .trim();
            if delta.is_empty() || apply_section_write(&previous, section, delta)? != body {
                return Err("追加记录不一致，已停止整理".into());
            }
            next = apply_section_write(&next, section, delta)?;
            previous = body.to_string();
        }
        if previous != strip_front_matter(&current_file) {
            return Err("当前正文与版本不一致，已停止整理".into());
        }
        // Preserve the exact replacement predecessor, including concurrent appends.
        let before_path = self
            .project_dir(id)
            .join("archives")
            .join(format!("{current_seq}-{job}-before.md"));
        save_archive(&before_path, &current_file)?;
        let before_tokens = tokens(strip_front_matter(&current_file));
        let after_tokens = tokens(&next);
        if after_tokens >= before_tokens {
            return Err("精简后未减少文档量，原文未替换".into());
        }
        tx.execute(
            "DELETE FROM project_compactions WHERE project_id=?1 AND job_id=?2",
            params![id, job],
        )
        .map_err(|e| e.to_string())?;
        persist_body(
            tx,
            &self.project_dir(id),
            id,
            current_seq,
            &next,
            "harness:compaction",
            &format!(
                "精简项目文档 · {before_tokens} → {after_tokens} tokens · 原文 {}",
                before_path.display()
            ),
            &format!("compaction:{current_seq}"),
        )?;
        Ok(CompactionResult {
            new_seq: current_seq + 1,
            before_tokens,
            after_tokens,
            archive_path: before_path.to_string_lossy().into_owned(),
        })
    }
    pub fn read_version(&self, id: &str, seq: i64) -> Result<String, String> {
        let id = validate_project_id(id)?;
        let expected: String = self
            .lock()?
            .query_row(
                "SELECT content_hash FROM project_versions WHERE project_id=?1 AND seq=?2",
                params![id, seq],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file = fs::read_to_string(
            self.project_dir(id)
                .join(HISTORY_DIR)
                .join(format!("{seq}.md")),
        )
        .map_err(|e| e.to_string())?;
        if content_hash(&file) != expected {
            return Err("历史版本校验失败".into());
        }
        Ok(strip_front_matter(&file).to_string())
    }
    pub fn restore_version(
        &self,
        id: &str,
        seq: i64,
        base_seq: i64,
    ) -> Result<WriteOutcome, String> {
        let content = self.read_version(id, seq)?;
        self.write_document(
            id,
            Some(base_seq),
            &content,
            "user:restore",
            &format!("恢复项目文档 v{seq}"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, ProjectDocStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(dir.path().to_path_buf()).unwrap();
        store.create_project("demo", "Demo").unwrap();
        store.write_document("demo", Some(0), &format!("## Status\n{}\n\n## Log\nold log\n\n## Decisions\nold decision\n\n## Open Questions\nold question\n", "历史说明和重复信息。".repeat(300)), "user", "init").unwrap();
        (dir, store)
    }
    const OUTPUT: &str =
        "## Status\n当前事实\n\n## Log\n\n## Decisions\n当前决定\n\n## Open Questions\n待办\n";
    #[test]
    fn archives_exact_input_then_merges_concurrent_appends_and_restores() {
        let (dir, store) = setup();
        let before = store.read_file_full("demo").unwrap();
        let job = store.begin_compaction("demo").unwrap();
        assert_eq!(fs::read_to_string(&job.archive_path).unwrap(), before);
        assert!(store.begin_compaction("demo").is_err());
        // HTTP and UI use different store connections; append through a second one.
        let other = ProjectDocStore::open_at(dir.path().to_path_buf()).unwrap();
        other
            .write_section("demo", "log", None, "追加进展一", "agent", "append")
            .unwrap();
        other
            .write_section("demo", "decisions", None, "新增有效决定", "agent", "append")
            .unwrap();
        other
            .write_section("demo", "log", None, "追加进展二", "agent", "append")
            .unwrap();
        let immediate_before = other.read_file_full("demo").unwrap();
        let result = store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .unwrap();
        assert_eq!(result.new_seq, 5);
        assert!(result.after_tokens < result.before_tokens);
        assert_eq!(
            fs::read_to_string(&result.archive_path).unwrap(),
            immediate_before
        );
        let doc = store.read_doc("demo").unwrap();
        assert!(doc.consistent);
        assert!(doc.content.contains("追加进展一\n追加进展二"));
        assert!(doc.content.contains("新增有效决定"));
        assert!(doc.content.contains(&job.archive_path));
        assert!(!doc.content.contains("重复信息"));
        assert_eq!(
            store.list_versions("demo").unwrap()[0].operation,
            "compaction:4"
        );
        assert!(matches!(
            store.restore_version("demo", 4, 5).unwrap(),
            WriteOutcome::Applied { new_seq: 6, .. }
        ));
        assert_eq!(
            store.read_doc("demo").unwrap().content,
            strip_front_matter(&immediate_before).trim()
        );
        assert!(store.read_version("demo", 5).unwrap().contains("当前事实"));
        assert!(matches!(
            store.restore_version("demo", 1, 5).unwrap(),
            WriteOutcome::Conflict { .. }
        ));
    }
    #[test]
    fn edit_even_when_reverted_stops_compaction() {
        let (_dir, store) = setup();
        let job = store.begin_compaction("demo").unwrap();
        store
            .write_section("demo", "status", Some(1), "changed", "user", "edit")
            .unwrap();
        store
            .write_document("demo", Some(2), &job.content, "user", "revert")
            .unwrap();
        let before = store.read_file_full("demo").unwrap();
        assert!(store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .unwrap_err()
            .contains("被修改"));
        assert_eq!(store.read_file_full("demo").unwrap(), before);
    }
    #[test]
    fn invalid_model_output_leaves_original_unchanged() {
        for output in [
            "",
            "````markdown\ninvalid",
            "## Status\nmissing other sections",
            &"x".repeat(10000),
        ] {
            let (_dir, store) = setup();
            let job = store.begin_compaction("demo").unwrap();
            let before = store.read_file_full("demo").unwrap();
            assert!(store
                .complete_compaction("demo", &job.job_id, output)
                .is_err());
            assert_eq!(store.read_file_full("demo").unwrap(), before);
            assert_eq!(store.get_project("demo").unwrap().current_seq, 1);
        }
    }
    #[test]
    fn archive_failure_and_persist_failure_never_replace_current() {
        let (_dir, store) = setup();
        fs::write(
            store.project_dir("demo").join("archives"),
            "blocks directory",
        )
        .unwrap();
        let before = store.read_file_full("demo").unwrap();
        assert!(store.begin_compaction("demo").is_err());
        assert_eq!(store.read_file_full("demo").unwrap(), before);
        fs::remove_file(store.project_dir("demo").join("archives")).unwrap();
        let job = store.begin_compaction("demo").unwrap();
        fs::create_dir(store.project_dir("demo").join("history/2.md")).unwrap();
        assert!(store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .is_err());
        assert_eq!(store.read_file_full("demo").unwrap(), before);
        assert_eq!(store.get_project("demo").unwrap().current_seq, 1);
    }
    #[test]
    fn cancel_only_releases_matching_job_and_drift_stops_writes() {
        let (_dir, store) = setup();
        let job = store.begin_compaction("demo").unwrap();
        store.cancel_compaction("demo", "wrong-job").unwrap();
        assert!(store.begin_compaction("demo").is_err());
        fs::write(
            store.project_dir("demo").join(CURRENT_FILE),
            "external edit",
        )
        .unwrap();
        assert!(store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .is_err());
        assert_eq!(store.read_file_full("demo").unwrap(), "external edit");
        store.cancel_compaction("demo", &job.job_id).unwrap();
        assert!(store.begin_compaction("demo").is_err());
    }
    #[test]
    fn deferred_commit_failure_restores_original_and_rolls_back_version() {
        let (_dir, store) = setup();
        let job = store.begin_compaction("demo").unwrap();
        let before = store.read_file_full("demo").unwrap();
        store.lock().unwrap().execute_batch("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON project_versions BEGIN INSERT INTO commit_child VALUES(999); END;").unwrap();
        assert!(store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .unwrap_err()
            .contains("已恢复原文"));
        assert_eq!(store.read_file_full("demo").unwrap(), before);
        assert_eq!(store.get_project("demo").unwrap().current_seq, 1);
        assert_eq!(store.list_versions("demo").unwrap().len(), 1);
        assert!(store.read_doc("demo").unwrap().consistent);
    }
    #[test]
    fn tampered_archive_is_rejected_before_replacement() {
        let (_dir, store) = setup();
        let job = store.begin_compaction("demo").unwrap();
        let before = store.read_file_full("demo").unwrap();
        fs::write(&job.archive_path, "tampered").unwrap();
        assert!(store
            .complete_compaction("demo", &job.job_id, OUTPUT)
            .unwrap_err()
            .contains("校验失败"));
        assert_eq!(store.read_file_full("demo").unwrap(), before);
    }
    #[test]
    fn local_count_matches_o200k_including_large_document() {
        let (_dir, store) = setup();
        let doc = store.read_doc("demo").unwrap();
        assert_eq!(
            store.measure("demo").unwrap().tokens,
            tiktoken_rs::o200k_base_singleton()
                .encode_ordinary(&doc.content)
                .len()
        );
    }
}
