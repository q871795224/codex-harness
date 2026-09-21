//! Harness-owned memory: SQLite stores identities/links, Markdown stores content.
use super::HarnessStore;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, BTreeMap},
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCatalog {
    current_workspace: String,
    workspaces: Vec<String>,
    domains: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCandidate {
    title: String,
    kind: String,
    scope: String,
    content: String,
    applicability: String,
    evidence: String,
    source_turn_ids: Vec<String>,
    related_workspaces: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySaveInput {
    thread_id: String,
    cwd: String,
    source_turn_ids: Vec<String>,
    memories: Vec<MemoryCandidate>,
}
#[derive(Debug, Serialize)]
pub struct SavedMemory {
    id: String,
    title: String,
    scope: String,
    path: String,
}

pub(super) fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS memory_workspaces(name TEXT PRIMARY KEY NOT NULL, git_root TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS memory_domains(name TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_domain_workspaces(domain_name TEXT NOT NULL REFERENCES memory_domains(name), workspace_name TEXT NOT NULL REFERENCES memory_workspaces(name), PRIMARY KEY(domain_name, workspace_name));").map_err(err)
}

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 100
        || name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || "-_.".contains(c))
    {
        return Err("记忆名称只能包含文字、数字、连字符、下划线和点，且不能以点开头".into());
    }
    Ok(())
}
fn scope_parts(scope: &str) -> Result<Vec<&str>, String> {
    if scope == "global" {
        return Ok(vec!["global"]);
    }
    let (kind, name) = scope.split_once('/').ok_or("记忆范围无效")?;
    if kind != "workspace" && kind != "domain" {
        return Err("记忆范围无效".into());
    }
    valid_name(name)?;
    Ok(vec![kind, name])
}
fn register_workspace(
    connection: &Connection,
    name: &str,
    root: Option<&str>,
) -> Result<String, String> {
    valid_name(name)?;
    if let Some(root) = root {
        if let Some(existing) = connection
            .query_row(
                "SELECT name FROM memory_workspaces WHERE git_root=?1",
                [root],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
        {
            return Ok(existing);
        }
        if name == "other" {
            return Err("other 是非 Git 记忆的保留名称，请先重命名该工作区".into());
        }
    }
    let occupied: Option<Option<String>> = connection
        .query_row(
            "SELECT git_root FROM memory_workspaces WHERE name=?1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(existing) = occupied {
        if existing.as_deref() != root {
            return Err(format!(
                "记忆工作区名称 {name} 已被其他仓库使用，请为不同仓库使用不同的目录名称"
            ));
        }
    } else {
        connection
            .execute(
                "INSERT INTO memory_workspaces(name,git_root) VALUES (?1,?2)",
                params![name, root],
            )
            .map_err(err)?;
    }
    Ok(name.into())
}

impl HarnessStore {
    pub fn memory_catalog(&self, cwd: &str) -> Result<MemoryCatalog, String> {
        let cwd = fs::canonicalize(cwd).map_err(err)?;
        if !cwd.is_dir() {
            return Err("记忆来源目录不存在".into());
        }
        let current = match crate::git_workspace::resolve_workspace(&cwd.to_string_lossy()) {
            Ok(workspace) => Some(workspace),
            Err(error) if error.contains("not a git repository") => None,
            Err(error) => return Err(error),
        };
        let known = self.list_workspaces()?;
        let mut connection = self.connection.lock().map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        recover(&self.root)?;
        for workspace in &known {
            register_workspace(&transaction, &workspace.name, Some(&workspace.root))?;
        }
        let current_workspace = match current {
            Some(workspace) => {
                register_workspace(&transaction, &workspace.name, Some(&workspace.root))?
            }
            None => register_workspace(&transaction, "other", None)?,
        };
        let workspaces = names(
            &transaction,
            "SELECT name FROM memory_workspaces ORDER BY name",
        )?;
        let domains = names(
            &transaction,
            "SELECT name FROM memory_domains ORDER BY name",
        )?;
        transaction.commit().map_err(err)?;
        Ok(MemoryCatalog {
            current_workspace,
            workspaces,
            domains,
        })
    }

    pub fn memory_save(&self, input: MemorySaveInput) -> Result<Vec<SavedMemory>, String> {
        if input.memories.len() > 12 {
            return Err("一次最多保存 12 条记忆".into());
        }
        if input.memories.is_empty() {
            return Ok(vec![]);
        }
        if input.thread_id.trim().is_empty()
            || input.thread_id.len() > 200
            || input.cwd.len() > 4096
        {
            return Err("记忆来源无效".into());
        }
        let mut connection = self.connection.lock().map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        recover(&self.root)?;
        let known = names(&transaction, "SELECT name FROM memory_workspaces")?;
        // Validate the entire batch before modifying either files or metadata.
        for item in &input.memories {
            let parts = scope_parts(&item.scope)?;
            if parts[0] == "workspace" && !known.iter().any(|name| name == parts[1]) {
                return Err("未知记忆工作区".into());
            }
            if !["preference", "fact", "experience", "reference"].contains(&item.kind.as_str()) {
                return Err("记忆类型无效".into());
            }
            for text in [
                &item.title,
                &item.content,
                &item.applicability,
                &item.evidence,
            ] {
                if text.trim().is_empty() || text.len() > 16000 || text.contains('\0') {
                    return Err("记忆内容为空或过长".into());
                }
            }
            if item.title.len() > 240
                || item.source_turn_ids.is_empty()
                || item
                    .source_turn_ids
                    .iter()
                    .any(|id| !input.source_turn_ids.contains(id))
            {
                return Err("记忆标题或来源 turn 无效".into());
            }
            if item
                .related_workspaces
                .iter()
                .any(|name| !known.contains(name))
                || (parts[0] != "domain" && !item.related_workspaces.is_empty())
            {
                return Err("记忆领域关联无效".into());
            }
        }
        for item in &input.memories {
            let parts = scope_parts(&item.scope)?;
            if parts[0] == "domain" {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO memory_domains(name) VALUES (?1)",
                        [parts[1]],
                    )
                    .map_err(err)?;
                for name in &item.related_workspaces {
                    transaction.execute("INSERT OR IGNORE INTO memory_domain_workspaces(domain_name,workspace_name) VALUES (?1,?2)", params![parts[1],name]).map_err(err)?;
                }
            }
        }
        transaction.commit().map_err(err)?;
        // Reacquire the cross-process writer lock before reading Markdown.
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        recover(&self.root)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(err)?
            .as_secs();
        let mut files: BTreeMap<String, String> = BTreeMap::new();
        let mut saved = Vec::new();
        for item in &input.memories {
            let mut hash = DefaultHasher::new();
            (&item.scope, &item.kind, &item.content, &item.applicability).hash(&mut hash);
            let id = format!("mem-{:016x}", hash.finish());
            let body_key = format!("{}/MEMORY.md", item.scope);
            let summary_key = format!("{}/memory_summary.md", item.scope);
            for (key, title) in [(&body_key, "记忆正文"), (&summary_key, "记忆索引")] {
                if !files.contains_key(key) {
                    let path = checked_path(&self.root, key)?;
                    let content = match fs::read_to_string(&path) {
                        Ok(text) => text,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => format!(
                            "---\nscope: {}\n---\n\n# {} · {title}\n",
                            serde_json::to_string(&item.scope).map_err(err)?,
                            item.scope
                        ),
                        Err(error) => return Err(err(error)),
                    };
                    let expected = format!("scope: {}", item.scope);
                    let quoted = format!(
                        "scope: {}",
                        serde_json::to_string(&item.scope).map_err(err)?
                    );
                    let header = content
                        .strip_prefix("---\n")
                        .and_then(|rest| rest.split_once("\n---").map(|(header, _)| header));
                    if !header.is_some_and(|header| {
                        header
                            .lines()
                            .any(|line| line.trim() == expected || line.trim() == quoted)
                    }) {
                        return Err("已有记忆文件的 scope 与目录不一致，请检查后重试".into());
                    }
                    files.insert(key.clone(), content);
                }
            }
            let body = files.get_mut(&body_key).unwrap();
            let anchor = format!("<a id=\"{id}\"></a>");
            if !body.contains(&anchor) {
                body.push_str(&format!("\n{anchor}\n\n### {}\n\n- ID：{id}\n- 类型：{}\n- 写入时间：{now}（Unix 秒，UTC）\n- 来源：会话 {}；turn {}\n- 来源目录：{}\n- 适用条件：{}\n- 验证情况：{}\n\n#### 内容\n\n{}\n", line(&item.title), item.kind, line(&input.thread_id), item.source_turn_ids.iter().map(|id| line(id)).collect::<Vec<_>>().join(", "), line(&input.cwd), line(&item.applicability), line(&item.evidence), item.content.trim()));
            }
            let summary = files.get_mut(&summary_key).unwrap();
            if !summary.contains(&format!("MEMORY.md#{id}")) {
                summary.push_str(&format!(
                    "\n- [{}](MEMORY.md#{id})：{}\n",
                    link_label(&item.title),
                    line(&item.applicability)
                ));
            }
            saved.push(SavedMemory {
                id,
                title: item.title.clone(),
                scope: item.scope.clone(),
                path: self
                    .root
                    .join("memory")
                    .join(body_key)
                    .to_string_lossy()
                    .into_owned(),
            });
        }
        // The journal recovers interrupted updates of the body and index together.
        write_batch(&self.root, &files)?;
        transaction.commit().map_err(err)?;
        Ok(saved)
    }
}

fn names(connection: &Connection, sql: &str) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare(sql).map_err(err)?;
    let rows = statement.query_map([], |row| row.get(0)).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn line(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
}
fn link_label(text: &str) -> String {
    line(text)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in std::iter::once("memory").chain(relative.split('/')) {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
            return Err("记忆路径无效".into());
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("记忆路径不能是软链接".into()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(err(error)),
        }
    }
    Ok(path)
}
fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("记忆文件缺少父目录")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temp.write_all(text.as_bytes()).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    Ok(())
}
fn write_batch(root: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    for key in files.keys() {
        checked_path(root, key)?;
    }
    let journal = checked_path(root, ".pending.json")?;
    atomic_write(&journal, &serde_json::to_string(files).map_err(err)?)?;
    recover(root)
}
fn recover(root: &Path) -> Result<(), String> {
    let journal = checked_path(root, ".pending.json")?;
    let text = match fs::read_to_string(&journal) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(error)),
    };
    let files: BTreeMap<String, String> = serde_json::from_str(&text).map_err(err)?;
    for (key, text) in &files {
        let (scope, file) = key.rsplit_once('/').ok_or("恢复记忆路径无效")?;
        scope_parts(scope)?;
        if !["MEMORY.md", "memory_summary.md"].contains(&file) {
            return Err("恢复记忆文件名无效".into());
        }
        atomic_write(&checked_path(root, key)?, text)?;
    }
    fs::remove_file(journal).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, HarnessStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().join("data")).unwrap();
        let connection = store.connection.lock().unwrap();
        register_workspace(&connection, "harness", Some("/test/harness")).unwrap();
        drop(connection);
        (dir, store)
    }
    fn input() -> MemorySaveInput {
        serde_json::from_value(serde_json::json!({
            "threadId":"t1", "cwd":"/test/harness", "sourceTurnIds":["turn-1"],
            "memories":[{"title":"保留来源", "kind":"experience", "scope":"workspace/harness", "content":"保存记忆时保留原会话来源。", "applicability":"Harness 记忆设计", "evidence":"用户明确要求", "sourceTurnIds":["turn-1"], "relatedWorkspaces":[]}]
        })).unwrap()
    }
    #[test]
    fn saves_frontmatter_body_index_and_deduplicates_exact_retries() {
        let (_dir, store) = setup();
        let first = store.memory_save(input()).unwrap();
        let second = store.memory_save(input()).unwrap();
        assert_eq!(first[0].id, second[0].id);
        let body = fs::read_to_string(&first[0].path).unwrap();
        assert!(body.starts_with("---\nscope: \"workspace/harness\"\n---"));
        assert_eq!(body.matches("### 保留来源").count(), 1);
        assert!(body.contains("turn-1"));
        let index = fs::read_to_string(
            store
                .root
                .join("memory/workspace/harness/memory_summary.md"),
        )
        .unwrap();
        assert_eq!(index.matches(&first[0].id).count(), 1);
        assert!(!store.root.join("memory/.pending.json").exists());
    }
    #[test]
    fn empty_and_invalid_batches_do_not_write_memory() {
        let (_dir, store) = setup();
        let mut empty = input();
        empty.memories.clear();
        assert!(store.memory_save(empty).unwrap().is_empty());
        for scope in [
            "workspace/../../escape",
            "workspace/missing",
            "domain/../bad",
            "global/other",
        ] {
            let mut invalid = input();
            let mut bad = invalid.memories[0].clone();
            bad.scope = scope.into();
            invalid.memories.push(bad);
            assert!(store.memory_save(invalid).is_err());
        }
        let mut invalid = input();
        invalid.memories[0].source_turn_ids = vec!["invented".into()];
        assert!(store.memory_save(invalid).is_err());
        assert!(!store.root.join("memory").exists());
    }
    #[test]
    fn domain_links_and_content_have_separate_storage() {
        let (_dir, store) = setup();
        let mut data = input();
        data.memories[0].scope = "domain/工程经验".into();
        data.memories[0].related_workspaces = vec!["harness".into()];
        store.memory_save(data).unwrap();
        let conn = store.connection.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_domain_workspaces", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
        assert!(store.root.join("state.sqlite").exists());
        assert!(!store.root.join("memory/metadata.sqlite").exists());
    }
    #[test]
    fn name_collision_does_not_merge_distinct_repositories() {
        let (_dir, store) = setup();
        let conn = store.connection.lock().unwrap();
        assert!(register_workspace(&conn, "harness", Some("/other/harness")).is_err());
        assert_eq!(
            register_workspace(&conn, "worktree", Some("/test/harness")).unwrap(),
            "harness"
        );
    }
    #[test]
    fn interrupted_batch_is_recovered_before_next_append() {
        let (_dir, store) = setup();
        let files: BTreeMap<String, String> = BTreeMap::from([
            (
                "workspace/harness/MEMORY.md".into(),
                "---\nscope: workspace/harness\n---\n\nexisting body\n".into(),
            ),
            (
                "workspace/harness/memory_summary.md".into(),
                "---\nscope: workspace/harness\n---\n\nexisting index\n".into(),
            ),
        ]);
        atomic_write(
            &store.root.join("memory/.pending.json"),
            &serde_json::to_string(&files).unwrap(),
        )
        .unwrap();
        let saved = store.memory_save(input()).unwrap();
        assert!(fs::read_to_string(&saved[0].path)
            .unwrap()
            .contains("existing body"));
        assert!(fs::read_to_string(
            store
                .root
                .join("memory/workspace/harness/memory_summary.md")
        )
        .unwrap()
        .contains("existing index"));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_destinations() {
        let (dir, store) = setup();
        fs::create_dir_all(store.root.join("memory/workspace")).unwrap();
        std::os::unix::fs::symlink(dir.path(), store.root.join("memory/workspace/harness"))
            .unwrap();
        assert!(store.memory_save(input()).unwrap_err().contains("软链接"));
        assert!(!dir.path().join("MEMORY.md").exists());
    }
    #[test]
    fn non_git_directories_share_other() {
        let (dir, store) = setup();
        let a = dir.path().join("plain-a");
        let b = dir.path().join("plain-b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        assert_eq!(
            store
                .memory_catalog(a.to_str().unwrap())
                .unwrap()
                .current_workspace,
            "other"
        );
        assert_eq!(
            store
                .memory_catalog(b.to_str().unwrap())
                .unwrap()
                .current_workspace,
            "other"
        );
    }
    #[test]
    fn concurrent_stores_preserve_both_appends() {
        let (dir, store) = setup();
        let second = HarnessStore::open_at(dir.path().join("data")).unwrap();
        let one = std::thread::spawn(move || store.memory_save(input()).unwrap());
        let two = std::thread::spawn(move || {
            let mut data = input();
            data.memories[0].content = "另一条独立知识".into();
            second.memory_save(data).unwrap()
        });
        let a = one.join().unwrap();
        let b = two.join().unwrap();
        let body = fs::read_to_string(&a[0].path).unwrap();
        assert!(body.contains(&a[0].id));
        assert!(body.contains(&b[0].id));
    }
}
