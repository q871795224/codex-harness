//! Managed Markdown entries. Markdown owns the body and metadata; no duplicate state store.
use super::*;
use std::collections::HashSet;

const START: &str = "<!-- project-entry ";
const END: &str = "<!-- /project-entry -->";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryMeta {
    pub id: String,
    pub section: String,
    pub state: String,
    pub revision: u64,
    pub reason: String,
    pub replaced_by: Option<String>,
    #[serde(default)]
    pub previous_state: Option<String>,
    pub updated_by: String,
    pub updated_at: i64,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    #[serde(flatten)]
    pub meta: EntryMeta,
    pub content: String,
}
struct Span {
    entry: ProjectEntry,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryMutation {
    pub action: String,
    pub id: Option<String>,
    pub revision: Option<u64>,
    pub section: Option<String>,
    pub content: Option<String>,
    pub reason: String,
    pub base_seq: Option<i64>,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub content: String,
    pub seq: i64,
    pub tokens: usize,
    pub omitted_entries: usize,
}

fn state_label(state: &str) -> &str {
    match state {
        "active" => "有效",
        "open" => "待办",
        "done" => "已完成",
        "superseded" => "被替代",
        "revoked" => "已撤销",
        "deleted" => "软删除",
        _ => state,
    }
}
fn note(meta: &EntryMeta) -> String {
    let reason = meta.reason.replace(['\r', '\n'], " ");
    let mut result = format!(
        "> 条目 `{}` · {} · 修订 {}\n> 原因：{}\n",
        meta.id,
        state_label(&meta.state),
        meta.revision,
        reason
    );
    if let Some(id) = &meta.replaced_by {
        result.push_str(&format!("> 替代条目：`{id}`\n"));
    }
    result
}
fn render(entry: &ProjectEntry) -> String {
    // JSON strings may contain comment terminators; escape > in metadata.
    let json = serde_json::to_string(&entry.meta)
        .unwrap()
        .replace('>', "\\u003e");
    format!(
        "{START}{json} -->\n{}\n{}\n{END}\n",
        note(&entry.meta),
        entry.content.trim()
    )
}
fn managed_section(section: &str) -> bool {
    matches!(section, "decisions" | "openQuestions")
}
fn initial_state(section: &str) -> &str {
    if section == "decisions" {
        "active"
    } else {
        "open"
    }
}
fn validate_content(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("条目正文不能为空".into());
    }
    // Keep an entry inside its parent section. Fenced code may contain headings.
    let mut fence = None;
    for line in content.lines() {
        if toggle_fence(line, &mut fence) {
            continue;
        }
        if fence.is_none() && (line.starts_with(START) || line.trim() == END) {
            return Err("条目正文不能包含系统条目标记".into());
        }
        if fence.is_none() && (line.starts_with("## ") || line.starts_with("# ")) {
            return Err("条目内请使用三级或更低标题".into());
        }
    }
    if fence.is_some() {
        return Err("条目代码围栏未闭合".into());
    }
    Ok(())
}
// Returns true for delimiter lines. Opening/closing fences must use the same
// character, and a closing fence must be at least as long as its opening fence.
pub(super) fn toggle_fence(line: &str, fence: &mut Option<(char, usize)>) -> bool {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return false;
    }
    let Some(ch) = trimmed.chars().next() else {
        return false;
    };
    if ch != '`' && ch != '~' {
        return false;
    }
    let count = trimmed.chars().take_while(|c| *c == ch).count();
    if count < 3 {
        return false;
    }
    match *fence {
        None => {
            *fence = Some((ch, count));
            true
        }
        Some((old, n)) if old == ch && count >= n && trimmed[count..].trim().is_empty() => {
            *fence = None;
            true
        }
        _ => false,
    }
}
fn parse(body: &str) -> Result<Vec<Span>, String> {
    let mut entries = Vec::new();
    let mut ids = HashSet::new();
    let mut offset = 0;
    let mut open: Option<(EntryMeta, usize, usize)> = None;
    let mut section = "";
    let mut fence = None;
    for line in body.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        let start = offset;
        offset += line.len();
        if toggle_fence(text, &mut fence) || fence.is_some() {
            continue;
        }
        if let Some(json) = text
            .strip_prefix(START)
            .and_then(|s| s.strip_suffix(" -->"))
        {
            if open.is_some() {
                return Err("条目标记不能嵌套".into());
            }
            let meta: EntryMeta =
                serde_json::from_str(json).map_err(|e| format!("条目属性无效: {e}"))?;
            let valid = if meta.section == "decisions" {
                ["active", "superseded", "revoked", "deleted"].contains(&meta.state.as_str())
            } else {
                meta.section == "openQuestions"
                    && ["open", "done", "deleted"].contains(&meta.state.as_str())
            };
            if !valid
                || meta.section != section
                || meta.revision == 0
                || meta.id.is_empty()
                || !meta
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
                || !ids.insert(meta.id.clone())
            {
                return Err("条目 ID、状态或所属分区无效/重复".into());
            }
            open = Some((meta, start, offset));
        } else if text == END {
            let (meta, begin, content_start) = open.take().ok_or("孤立的条目结束标记")?;
            let raw = &body[content_start..start];
            let content = raw
                .strip_prefix(&note(&meta))
                .ok_or("条目属性说明被修改，请通过条目工具修改属性")?
                .trim()
                .to_string();
            validate_content(&content)?;
            entries.push(Span {
                entry: ProjectEntry { meta, content },
                start: begin,
                end: offset,
            });
        } else if let Some(heading) = text.strip_prefix("## ") {
            if open.is_some() {
                return Err("条目跨越分区".into());
            }
            section = match heading.trim_end() {
                "Decisions" => "decisions",
                "Open Questions" => "openQuestions",
                _ => "",
            };
        } else if text.starts_with("# ") {
            section = "";
        }
    }
    if open.is_some() {
        return Err("条目标记未闭合".into());
    }
    for span in &entries {
        let m = &span.entry.meta;
        if m.state == "superseded" {
            let replacement = m.replaced_by.as_ref().ok_or("被替代条目缺少替代关系")?;
            if replacement == &m.id
                || !entries
                    .iter()
                    .any(|s| s.entry.meta.id == *replacement && s.entry.meta.section == "decisions")
            {
                return Err("替代条目不存在或属于其他分区".into());
            }
        } else if m.replaced_by.is_some() {
            return Err("非替代状态不能带替代关系".into());
        }
    }
    // Reject cycles, including relationships edited by hand.
    for span in &entries {
        let mut seen = HashSet::new();
        let mut current = Some(span.entry.meta.id.as_str());
        while let Some(id) = current {
            if !seen.insert(id) {
                return Err("决定替代关系存在环".into());
            }
            current = entries
                .iter()
                .find(|s| s.entry.meta.id == id)
                .and_then(|s| s.entry.meta.replaced_by.as_deref());
        }
    }
    Ok(entries)
}
pub(super) fn model_content(body: &str) -> Result<String, String> {
    let spans = parse(body)?;
    let mut text = body.to_string();
    for span in spans.iter().rev() {
        text.replace_range(span.start..span.end, "");
    }
    Ok(text)
}
pub(super) fn list(body: &str) -> Result<Vec<ProjectEntry>, String> {
    Ok(parse(body)?.into_iter().map(|s| s.entry).collect())
}
fn new_entry(section: &str, content: &str, by: &str, reason: &str) -> Result<ProjectEntry, String> {
    validate_content(content)?;
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let id = format!(
        "{}-{}",
        if section == "decisions" { "D" } else { "Q" },
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    Ok(ProjectEntry {
        meta: EntryMeta {
            id,
            section: section.into(),
            state: initial_state(section).into(),
            revision: 1,
            reason: reason.into(),
            replaced_by: None,
            previous_state: None,
            updated_by: by.into(),
            updated_at: now_ms(),
        },
        content: content.trim().into(),
    })
}
pub(super) fn append_content(
    section: &str,
    content: &str,
    by: &str,
    reason: &str,
) -> Result<String, String> {
    if managed_section(section) {
        Ok(render(&new_entry(
            section,
            content,
            by,
            if reason.trim().is_empty() {
                "新增条目"
            } else {
                reason
            },
        )?))
    } else {
        let mut fence = None;
        for line in content.lines() {
            if toggle_fence(line, &mut fence) || fence.is_some() {
                continue;
            }
            if line.starts_with(START) || line.trim() == END {
                return Err("请通过条目工具管理决定和待办".into());
            }
        }
        Ok(content.to_string())
    }
}
// Restoration changes entry revisions as well as document seq, preventing an
// older Agent from editing a restored entry with a once-valid revision (ABA).
pub(super) fn restored(body: &str, revision: i64) -> Result<String, String> {
    let spans = parse(body)?;
    let mut next = body.to_string();
    for span in spans.iter().rev() {
        let mut entry = span.entry.clone();
        entry.meta.revision = revision as u64;
        entry.meta.reason = format!("恢复历史版本；原原因：{}", entry.meta.reason);
        entry.meta.updated_by = "user:restore".into();
        entry.meta.updated_at = now_ms();
        next.replace_range(span.start..span.end, &render(&entry));
    }
    Ok(next)
}
/// Free-form human edits preserve identity and attributes; body edits get a new
/// entry revision. Dropping a managed entry must use soft delete instead.
pub(super) fn reconcile(previous: &str, next: &str, by: &str) -> Result<String, String> {
    let old = parse(previous)?;
    let new = parse(next)?;
    if old.len() != new.len()
        || old
            .iter()
            .any(|s| !new.iter().any(|n| n.entry.meta.id == s.entry.meta.id))
    {
        return Err("不能在全文编辑中增删系统条目；删除请使用软删除，新增请使用追加工具".into());
    }
    let mut result = next.to_string();
    for span in new.iter().rev() {
        let before = old
            .iter()
            .find(|s| s.entry.meta.id == span.entry.meta.id)
            .unwrap();
        if before.entry.meta != span.entry.meta {
            return Err("条目属性由 Harness 维护，请使用条目工具修改状态或原因".into());
        }
        if before.entry.content != span.entry.content {
            let mut entry = span.entry.clone();
            entry.meta.revision += 1;
            entry.meta.updated_by = by.into();
            entry.meta.updated_at = now_ms();
            entry.meta.reason = "人工全文编辑正文".into();
            result.replace_range(span.start..span.end, &render(&entry));
        }
    }
    Ok(result)
}
/// The model compacts unstructured prose; managed records are restored verbatim
/// from the snapshot, never entrusted to model-generated IDs or state changes.
pub(super) fn preserve_for_compaction(previous: &str, output: &str) -> Result<String, String> {
    let old = parse(previous)?;
    let generated = parse(output)?;
    let mut next = output.to_string();
    for span in generated.iter().rev() {
        next.replace_range(span.start..span.end, "");
    }
    for span in old {
        next = apply_section_write(&next, &span.entry.meta.section, &render(&span.entry))?;
    }
    Ok(next)
}
impl ProjectDocStore {
    pub fn mutate_entry(
        &self,
        id: &str,
        input: &EntryMutation,
        by: &str,
    ) -> Result<WriteOutcome, String> {
        let id = validate_project_id(id)?;
        if input.reason.trim().is_empty() {
            return Err("修改或软删除条目必须说明原因".into());
        }
        let guard = self.lock()?;
        let tx = Transaction::new_unchecked(&guard, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (seq, file) = super::compaction::current_checked(self, &tx, id)?;
        let body = strip_front_matter(&file);
        let spans = parse(body)?;
        let mut next = body.to_string();
        if input.action == "adopt" {
            if input.base_seq != Some(seq) {
                return Ok(WriteOutcome::Conflict {
                    current_seq: seq,
                    base_seq: input.base_seq,
                });
            }
            let section = input
                .section
                .as_deref()
                .filter(|s| managed_section(s))
                .ok_or("只能纳管 Decisions 或 Open Questions")?;
            let content = input.content.as_deref().ok_or("缺少待纳管正文")?.trim();
            validate_content(content)?;
            let (start, end) = find_section(body, &section_heading(section)).ok_or("分区不存在")?;
            let matches: Vec<_> = body[start..end].match_indices(content).collect();
            if matches.len() != 1 {
                return Err("待纳管正文必须在该分区精确且唯一匹配，请重读后重试".into());
            }
            let at = start + matches[0].0;
            if (at > 0 && !body[..at].ends_with('\n'))
                || (at + content.len() < body.len()
                    && !body[at + content.len()..].starts_with('\n'))
                || spans
                    .iter()
                    .any(|s| at < s.end && at + content.len() > s.start)
            {
                return Err("纳管必须选择完整且尚未纳管的段落".into());
            }
            next.replace_range(
                at..at + content.len(),
                render(&new_entry(section, content, by, &input.reason)?).trim_end(),
            );
        } else {
            let target = spans
                .iter()
                .find(|s| Some(s.entry.meta.id.as_str()) == input.id.as_deref())
                .ok_or("条目不存在，请先读取或纳管")?;
            if input.revision != Some(target.entry.meta.revision) {
                return Err(format!(
                    "条目修订冲突：当前为 {}，请重读后重试",
                    target.entry.meta.revision
                ));
            }
            let mut entry = target.entry.clone();
            let decision = entry.meta.section == "decisions";
            let state = entry.meta.state.as_str();
            match input.action.as_str() {
                "update" if matches!(state, "active" | "open" | "done") => {
                    let content = input.content.as_deref().ok_or("缺少新正文")?;
                    validate_content(content)?;
                    entry.content = content.trim().into();
                }
                "delete" if state != "deleted" && state != "superseded" => {
                    entry.meta.previous_state = Some(entry.meta.state.clone());
                    entry.meta.state = "deleted".into();
                    entry.meta.replaced_by = None;
                }
                "restore" if state == "deleted" => {
                    entry.meta.state = entry.meta.previous_state.take().ok_or("缺少软删除前状态")?
                }
                "revoke" if decision && state == "active" => entry.meta.state = "revoked".into(),
                "close" if !decision && state == "open" => entry.meta.state = "done".into(),
                "reopen" if !decision && state == "done" => entry.meta.state = "open".into(),
                "supersede" if decision && state == "active" => {
                    let replacement = new_entry(
                        "decisions",
                        input.content.as_deref().ok_or("缺少替代决定正文")?,
                        by,
                        &input.reason,
                    )?;
                    entry.meta.state = "superseded".into();
                    entry.meta.replaced_by = Some(replacement.meta.id.clone());
                    next = apply_section_write(&next, "decisions", &render(&replacement))?;
                }
                _ => return Err("当前分区或状态不支持该操作".into()),
            }
            entry.meta.reason = input.reason.trim().into();
            entry.meta.revision += 1;
            entry.meta.updated_by = by.into();
            entry.meta.updated_at = now_ms();
            next.replace_range(target.start..target.end, &render(&entry));
        }
        let after = parse(&next)?;
        let expected_count =
            spans.len() + usize::from(matches!(input.action.as_str(), "adopt" | "supersede"));
        if after.len() != expected_count {
            return Err("条目不能位于代码围栏内，请选择独立段落".into());
        }
        persist_body(
            tx,
            &self.project_dir(id),
            id,
            seq,
            &next,
            by,
            &input.reason,
            "entry:edit",
        )
    }
    pub fn context(&self, id: &str, threshold: usize) -> Result<ProjectContext, String> {
        if threshold == 0 {
            return Err("门限必须大于零".into());
        }
        let snapshot = self.read_doc(id)?;
        if !snapshot.consistent {
            return Err("项目正文与版本不一致，请先检查文件修改".into());
        }
        let count = super::compaction::tokens(&snapshot.content);
        let mut content = snapshot.content;
        let mut omitted = 0;
        if count > threshold {
            for span in parse(&content)?.iter().rev() {
                if matches!(
                    span.entry.meta.state.as_str(),
                    "deleted" | "superseded" | "revoked"
                ) {
                    content.replace_range(span.start..span.end, "");
                    omitted += 1;
                }
            }
        }
        if omitted > 0 {
            content.push_str(&format!("\n> 首轮背景超过 {threshold} tokens，已省略 {omitted} 条软删除/失效条目；通过 project-doc read / entries 可读取完整正文、原因与历史。其余内容完整保留。\n"));
        }
        Ok(ProjectContext {
            content,
            seq: snapshot.current_seq,
            tokens: count,
            omitted_entries: omitted,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, ProjectDocStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(dir.path().into()).unwrap();
        store.create_project("p", "P").unwrap();
        (dir, store)
    }
    fn add(store: &ProjectDocStore, section: &str, body: &str) -> ProjectEntry {
        store
            .write_section("p", section, None, body, "t", "追加")
            .unwrap();
        store.read_doc("p").unwrap().entries.last().unwrap().clone()
    }
    fn edit(entry: &ProjectEntry, action: &str, content: Option<&str>) -> EntryMutation {
        EntryMutation {
            action: action.into(),
            id: Some(entry.meta.id.clone()),
            revision: Some(entry.meta.revision),
            section: None,
            content: content.map(String::from),
            reason: "用户调整范围，保留旧经验".into(),
            base_seq: None,
        }
    }
    #[test]
    fn superseding_is_atomic_and_keeps_the_old_lesson_and_link() {
        let (_dir, store) = setup();
        let old = add(&store, "decisions", "全量同步 add/update/remove");
        store
            .mutate_entry(
                "p",
                &edit(&old, "supersede", Some("仅新增缺失项，独有数据保留")),
                "t",
            )
            .unwrap();
        let doc = store.read_doc("p").unwrap();
        assert_eq!(doc.entries.len(), 2);
        assert_eq!(doc.entries[0].meta.state, "superseded");
        assert_eq!(
            doc.entries[0].meta.replaced_by.as_deref(),
            Some(doc.entries[1].meta.id.as_str())
        );
        assert_eq!(doc.entries[1].meta.state, "active");
        assert!(doc.content.contains("全量同步"));
        assert!(doc.content.contains("用户调整范围"));
        let seq = doc.current_seq;
        assert!(store
            .mutate_entry("p", &edit(&old, "supersede", Some("另一规则")), "t")
            .unwrap_err()
            .contains("冲突"));
        assert_eq!(store.read_doc("p").unwrap().current_seq, seq);
    }
    #[test]
    fn per_entry_cas_allows_unrelated_appends_but_blocks_stale_edits_across_connections() {
        let (dir, store) = setup();
        let entry = add(&store, "decisions", "原决定");
        let other = ProjectDocStore::open_at(dir.path().into()).unwrap();
        other
            .write_section("p", "log", None, "其他会话进展", "other", "append")
            .unwrap();
        store
            .mutate_entry("p", &edit(&entry, "update", Some("修订后的决定")), "t")
            .unwrap();
        assert!(other
            .mutate_entry("p", &edit(&entry, "delete", None), "other")
            .unwrap_err()
            .contains("冲突"));
        assert!(store.read_version("p", 1).unwrap().contains("原决定"));
    }
    #[test]
    fn questions_close_reopen_delete_and_restore_preserve_content_and_prior_state() {
        let (_dir, store) = setup();
        let entry = add(&store, "openQuestions", "验收健康检查闭环");
        store
            .mutate_entry("p", &edit(&entry, "close", None), "t")
            .unwrap();
        let done = store.read_doc("p").unwrap().entries[0].clone();
        assert_eq!(done.meta.state, "done");
        store
            .mutate_entry("p", &edit(&done, "delete", None), "t")
            .unwrap();
        let deleted = store.read_doc("p").unwrap().entries[0].clone();
        assert_eq!(deleted.meta.state, "deleted");
        assert_eq!(deleted.content, "验收健康检查闭环");
        store
            .mutate_entry("p", &edit(&deleted, "restore", None), "t")
            .unwrap();
        let restored = store.read_doc("p").unwrap().entries[0].clone();
        assert_eq!(restored.meta.state, "done");
        store
            .mutate_entry("p", &edit(&restored, "reopen", None), "t")
            .unwrap();
        assert_eq!(store.read_doc("p").unwrap().entries[0].meta.state, "open");
    }
    #[test]
    fn invalid_actions_and_empty_reasons_do_not_write_or_destroy_content() {
        let (_dir, store) = setup();
        let d = add(&store, "decisions", "有效规则");
        for action in ["close", "reopen", "restore", "erase"] {
            assert!(store
                .mutate_entry("p", &edit(&d, action, None), "t")
                .is_err());
        }
        let mut input = edit(&d, "delete", None);
        input.reason.clear();
        assert!(store.mutate_entry("p", &input, "t").is_err());
        store
            .mutate_entry("p", &edit(&d, "revoke", None), "t")
            .unwrap();
        assert_eq!(
            store.read_doc("p").unwrap().entries[0].meta.state,
            "revoked"
        );
    }
    #[test]
    fn human_markdown_edits_keep_ids_increment_revisions_and_reject_hard_deletes() {
        let (_dir, store) = setup();
        let entry = add(&store, "decisions", "修改前正文");
        let doc = store.read_doc("p").unwrap();
        store
            .write_document(
                "p",
                Some(doc.current_seq),
                &doc.content.replace("修改前正文", "修改后正文"),
                "user",
                "edit",
            )
            .unwrap();
        let next = store.read_doc("p").unwrap();
        assert_eq!(next.entries[0].meta.id, entry.meta.id);
        assert_eq!(next.entries[0].meta.revision, 2);
        assert!(store
            .write_document(
                "p",
                Some(next.current_seq),
                "## Status\n清空所有条目",
                "user",
                "erase"
            )
            .is_err());
        assert!(store
            .write_document(
                "p",
                Some(next.current_seq),
                &next
                    .content
                    .replace("\"state\":\"active\"", "\"state\":\"revoked\""),
                "user",
                "forge"
            )
            .is_err());
    }
    #[test]
    fn legacy_adoption_is_explicit_unique_versioned_and_preserves_unselected_text() {
        let (_dir, store) = setup();
        store
            .write_document(
                "p",
                Some(0),
                "## Status\n背景\n## Decisions\n旧规则一\n\n旧规则二\n## Open Questions\n",
                "user",
                "init",
            )
            .unwrap();
        let mut req = EntryMutation {
            action: "adopt".into(),
            id: None,
            revision: None,
            section: Some("decisions".into()),
            content: Some("旧规则一".into()),
            reason: "纳管旧规则".into(),
            base_seq: Some(0),
        };
        assert!(matches!(
            store.mutate_entry("p", &req, "t").unwrap(),
            WriteOutcome::Conflict { .. }
        ));
        req.base_seq = Some(1);
        store.mutate_entry("p", &req, "t").unwrap();
        let doc = store.read_doc("p").unwrap();
        assert_eq!(doc.entries.len(), 1);
        assert!(doc.content.contains("旧规则二"));
        req.base_seq = Some(doc.current_seq);
        assert!(store.mutate_entry("p", &req, "t").is_err());
    }
    #[test]
    fn full_injection_below_and_at_threshold_only_explicit_inactive_entries_omitted_above_it() {
        let (_dir, store) = setup();
        let old = add(&store, "decisions", "旧错误经验");
        store
            .mutate_entry("p", &edit(&old, "supersede", Some("当前安全规则")), "t")
            .unwrap();
        let question = add(&store, "openQuestions", "完成后仍保留经验");
        store
            .mutate_entry("p", &edit(&question, "close", None), "t")
            .unwrap();
        let doc = store.read_doc("p").unwrap();
        let count = compaction::tokens(&doc.content);
        assert_eq!(store.context("p", count).unwrap().content, doc.content);
        assert_eq!(store.context("p", count + 1).unwrap().omitted_entries, 0);
        let context = store.context("p", 1).unwrap();
        assert_eq!(context.omitted_entries, 1);
        assert!(!context.content.contains("旧错误经验"));
        assert!(context.content.contains("当前安全规则"));
        assert!(context.content.contains("完成后仍保留经验"));
        assert!(context.content.contains("project-doc read"));
        assert!(store.read_doc("p").unwrap().content.contains("旧错误经验"));
    }
    #[test]
    fn markdown_fences_cannot_create_fake_entries_and_nested_headings_are_rejected() {
        assert!(list("## Decisions\n```markdown\n<!-- project-entry invalid -->\n<!-- /project-entry -->\n```\n").unwrap().is_empty());
        let (_dir, store) = setup();
        assert!(store
            .write_section("p", "decisions", None, "## Log\n越界", "t", "x")
            .is_err());
        let d = add(&store, "decisions", "示例：\n```\n## Log\n```\n保留正文");
        assert!(d.content.contains("## Log"));
        let second = add(&store, "decisions", "第二条决定");
        assert_eq!(second.content, "第二条决定");
        let doc = store.read_doc("p").unwrap();
        assert_eq!(doc.entries.len(), 2);
        assert_eq!(doc.entries[0].content, d.content);
        assert!(validate_content("```\n未闭合").is_err());
    }
    #[test]
    fn compaction_preserves_managed_records_without_trusting_model_attributes() {
        let (_dir, store) = setup();
        let old = add(&store, "decisions", "旧错误和教训");
        store
            .mutate_entry("p", &edit(&old, "delete", None), "t")
            .unwrap();
        store
            .write_section("p", "log", None, &"重复过程。".repeat(200), "t", "log")
            .unwrap();
        let before = store.read_doc("p").unwrap();
        let job = store.begin_compaction("p").unwrap();
        assert!(!job.content.contains("旧错误和教训"));
        store
            .complete_compaction(
                "p",
                &job.job_id,
                "## Status\n当前摘要\n## Log\n\n## Decisions\n\n## Open Questions\n",
            )
            .unwrap();
        let after = store.read_doc("p").unwrap();
        assert_eq!(after.entries[0].meta, before.entries[0].meta);
        assert_eq!(after.entries[0].content, "旧错误和教训");
        // Restoring an older whole-document version is explicit and retains history.
        store.restore_version("p", 1, after.current_seq).unwrap();
        let restored = store.read_doc("p").unwrap().entries[0].clone();
        assert_eq!(restored.meta.state, "active");
        assert!(restored.meta.revision > old.meta.revision);
        assert!(store
            .mutate_entry("p", &edit(&old, "update", Some("过期草稿")), "t")
            .unwrap_err()
            .contains("冲突"));
    }
}
