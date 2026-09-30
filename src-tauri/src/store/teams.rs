//! Team definitions and task documents live in files. SQLite only coordinates writers.
use super::HarnessStore;
use rusqlite::TransactionBehavior;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};

// Internal run owner: team execution must survive disabling/removing its plugin view.
pub(super) const RUN_OWNER: &str = "core.teams";
pub(super) fn initialize(connection: &mut rusqlite::Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute(
        "INSERT OR IGNORE INTO plugin_instances (instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at) VALUES (?1, ?1, 'global', '', 1, '{}', 0, 0)",
        [RUN_OWNER],
    ).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE plugin_runs SET instance_id = ?1 WHERE instance_id = 'builtin.teams:default'",
            [RUN_OWNER],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamDocument {
    pub revision: u64,
    pub content: String,
}

impl HarnessStore {
    fn team_document_path(&self, key: &str) -> Result<PathBuf, String> {
        let name = if key == "state" {
            "state.json".to_owned()
        } else if let Some(scope) = key.strip_prefix("memory:") {
            let (id, workspace) = scope.split_once('@').unwrap_or((scope, ""));
            if workspace.len() > 4096 || workspace.contains('\0') {
                return Err("记忆工作区无效".into());
            }
            if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                return Err("成员记忆标识无效".into());
            }
            if workspace.is_empty() {
                format!("{id}.md")
            } else {
                // Stable path key; verify the full key in the header as well (collision fails closed).
                let hash = workspace
                    .as_bytes()
                    .iter()
                    .fold(0xcbf29ce484222325u64, |h, b| {
                        (h ^ *b as u64).wrapping_mul(0x100000001b3)
                    });
                format!("{id}-{hash:016x}.md")
            }
        } else {
            return Err("团队文档标识无效".into());
        };
        let directory = self.root.join("teams");
        if directory
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("团队目录不能是符号链接".into());
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(name);
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("团队文档不能是符号链接".into());
        }
        Ok(path)
    }

    pub fn team_read_document(&self, key: &str) -> Result<TeamDocument, String> {
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let _lock = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        read(&self.team_document_path(key)?, key)
    }

    pub fn team_write_document(
        &self,
        key: &str,
        expected_revision: u64,
        content: &str,
    ) -> Result<TeamDocument, String> {
        let limit = if key == "state" {
            8 * 1024 * 1024
        } else {
            64 * 1024
        };
        if content.len() > limit {
            return Err("团队文档超过大小限制".into());
        }
        if key == "state" {
            let value: serde_json::Value =
                serde_json::from_str(content).map_err(|e| format!("团队状态 JSON 无效: {e}"))?;
            if value.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1)
                || !["members", "teams", "tasks"]
                    .iter()
                    .all(|k| value.get(k).is_some_and(|v| v.is_array()))
            {
                return Err("团队状态版本或结构无效".into());
            }
        }
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let _lock = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let path = self.team_document_path(key)?;
        let current = read(&path, key)?;
        if current.revision != expected_revision {
            return Err("文档已被其他窗口修改，请刷新后重试".into());
        }
        let next = TeamDocument {
            revision: current.revision.checked_add(1).ok_or("文档版本溢出")?,
            content: content.to_owned(),
        };
        // Memory remains readable Markdown; the version is a Harness-owned first line.
        let rendered = if key == "state" {
            serde_json::to_string(&next).map_err(|e| e.to_string())?
        } else {
            let header = serde_json::json!({ "revision": next.revision, "key": key });
            format!("<!-- harness-team:{header} -->\n{content}")
        };
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("目录无效")?)
            .map_err(|e| e.to_string())?;
        file.write_all(rendered.as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&path).map_err(|e| e.to_string())?;
        fs::File::open(path.parent().ok_or("目录无效")?)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(next)
    }
}

fn read(path: &PathBuf, key: &str) -> Result<TeamDocument, String> {
    if fs::metadata(path).is_ok_and(|m| m.len() > 16 * 1024 * 1024) {
        return Err("团队文档过大，未读取或覆盖文件".into());
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TeamDocument {
                revision: 0,
                content: String::new(),
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    if key == "state" {
        return serde_json::from_str(&text)
            .map_err(|e| format!("团队状态无法读取，未覆盖原文件: {e}"));
    }
    let (header, content) = text
        .split_once('\n')
        .ok_or("团队文档缺少版本头，未覆盖原文件")?;
    let header: serde_json::Value = serde_json::from_str(
        header
            .strip_prefix("<!-- harness-team:")
            .and_then(|s| s.strip_suffix(" -->"))
            .ok_or("团队文档版本无效")?,
    )
    .map_err(|e| e.to_string())?;
    if header.get("key").and_then(|v| v.as_str()) != Some(key) {
        return Err("记忆范围不匹配，未读取或覆盖文件".into());
    }
    let revision = header
        .get("revision")
        .and_then(|v| v.as_u64())
        .ok_or("团队文档版本无效")?;
    Ok(TeamDocument {
        revision,
        content: content.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documents_are_atomic_versioned_files_not_database_content() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        let key = "memory:12345678-1234-1234-1234-123456789abc";
        assert_eq!(store.team_read_document(key).unwrap().revision, 0);
        store
            .team_write_document(key, 0, "# 专属经验\nprivate-memory-sentinel")
            .unwrap();
        assert!(store.team_write_document(key, 0, "lost edit").is_err());
        assert!(store
            .team_read_document(key)
            .unwrap()
            .content
            .contains("private-memory-sentinel"));
        let other = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(other.team_read_document(key).unwrap().revision, 1);
        other.team_write_document(key, 1, "updated").unwrap();
        assert!(store.team_write_document(key, 1, "stale").is_err());
        assert!(store
            .team_write_document("memory:../../outside", 0, "bad")
            .is_err());
        assert!(store.team_write_document("state", 0, "{}").is_err());
        let bytes = fs::read(dir.path().join("state.sqlite")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-memory-sentinel"));
    }
    #[test]
    fn workspace_memories_are_separate_and_scopes_are_verified() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        let global = "memory:12345678-1234-1234-1234-123456789abc";
        let first = format!("{global}@/repo/中文");
        let second = format!("{global}@/repo/other");
        store
            .team_write_document(&first, 0, "project fact")
            .unwrap();
        assert_eq!(store.team_read_document(global).unwrap().content, "");
        assert_eq!(store.team_read_document(&second).unwrap().content, "");
        assert_eq!(
            store.team_read_document(&first).unwrap().content,
            "project fact"
        );
        let path = store.team_document_path(&first).unwrap();
        let other_path = store.team_document_path(&second).unwrap();
        fs::copy(path, other_path).unwrap();
        assert!(store.team_read_document(&second).is_err());
        assert!(store
            .team_write_document(&second, 1, "cannot overwrite")
            .is_err());
    }
    #[test]
    fn concurrent_instances_reject_lost_updates_and_state_is_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let content = r#"{"schemaVersion":1,"members":[],"teams":[],"tasks":[]}"#;
        // Open sequentially so schema initialization is outside the write race.
        let a = HarnessStore::open_at(root.clone()).unwrap();
        let b = HarnessStore::open_at(root.clone()).unwrap();
        let handles: Vec<_> = [a, b]
            .into_iter()
            .map(|store| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.team_write_document("state", 0, content).is_ok()
                })
            })
            .collect();
        let success = handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|v| *v)
            .count();
        assert_eq!(success, 1);
        let state: TeamDocument =
            serde_json::from_str(&fs::read_to_string(root.join("teams/state.json")).unwrap())
                .unwrap();
        assert_eq!(state.revision, 1);
    }
    #[test]
    fn legacy_team_runs_migrate_to_core_and_survive_removing_plugin_view() {
        use super::super::{PluginInstanceInput, PluginRunInput};
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        store
            .upsert_plugin_instance(&PluginInstanceInput {
                instance_id: "builtin.teams:default".into(),
                plugin_id: "builtin.teams".into(),
                scope_kind: "global".into(),
                scope_key: None,
                enabled: true,
                config: serde_json::json!({}),
            })
            .unwrap();
        let run = PluginRunInput {
            run_id: "12345678-1234-1234-1234-123456789abc".into(),
            instance_id: "builtin.teams:default".into(),
            mode: "detached".into(),
            workspace_access: "read-only".into(),
            status: "starting".into(),
            title: "协调任务".into(),
            workspace_root: "/temporary-repo".into(),
            parent_thread_id: Some("origin".into()),
            child_thread_id: None,
            turn_id: None,
            error_summary: None,
            completed_at: None,
            returned_at: None,
            workspace_removed_at: None,
        };
        store.upsert_plugin_run(&run).unwrap();
        let reloaded = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.list_plugin_runs().unwrap()[0].run_id, run.run_id);
        assert_eq!(
            reloaded.list_plugin_runs().unwrap()[0].instance_id,
            RUN_OWNER
        );
        assert!(!reloaded
            .list_plugin_instances()
            .unwrap()
            .iter()
            .any(|i| i.instance_id == RUN_OWNER));
        reloaded
            .delete_plugin_instance("builtin.teams:default")
            .unwrap();
        assert_eq!(reloaded.list_plugin_runs().unwrap().len(), 1);
        assert!(reloaded.delete_plugin_instance(RUN_OWNER).is_err());
        let mut native_run = run;
        native_run.run_id = "22345678-1234-1234-1234-123456789abc".into();
        native_run.instance_id = RUN_OWNER.into();
        reloaded.upsert_plugin_run(&native_run).unwrap();
        assert_eq!(reloaded.list_plugin_runs().unwrap().len(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_preserves_external_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("teams")).unwrap();
        assert!(store.team_read_document("state").is_err());
    }
}
