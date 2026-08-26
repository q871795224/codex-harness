use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub name: String,
    pub created_at: i64,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUiState {
    pub thread_id: String,
    pub last_read_at: Option<i64>,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstanceInput {
    pub instance_id: String,
    pub plugin_id: String,
    pub scope_kind: String,
    pub scope_key: Option<String>,
    pub enabled: bool,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstance {
    pub instance_id: String,
    pub plugin_id: String,
    pub scope_kind: String,
    pub scope_key: Option<String>,
    pub enabled: bool,
    pub config: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct HarnessStore {
    connection: Mutex<Connection>,
}

impl HarnessStore {
    pub fn open() -> Result<Self, String> {
        Self::open_at(harness_data_dir()?)
    }

    fn open_at(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|error| {
            format!(
                "无法创建 Codex Harness 数据目录 {}: {error}",
                root.display()
            )
        })?;
        let connection = Connection::open(root.join("state.sqlite"))
            .map_err(|error| format!("无法打开 Codex Harness 本地状态库: {error}"))?;
        connection
            .execute_batch(
                r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS workspaces (
              git_root TEXT PRIMARY KEY NOT NULL,
              display_name TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              last_opened_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS thread_ui (
              thread_id TEXT PRIMARY KEY NOT NULL,
              last_read_at INTEGER,
              badge TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_state (
              state_key TEXT PRIMARY KEY NOT NULL,
              state_value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS plugin_instances (
              instance_id TEXT PRIMARY KEY NOT NULL,
              plugin_id TEXT NOT NULL,
              scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global', 'workspace', 'thread')),
              scope_key TEXT NOT NULL DEFAULT '',
              enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
              config_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(plugin_id, scope_kind, scope_key)
            );
            CREATE TABLE IF NOT EXISTS plugin_state (
              instance_id TEXT NOT NULL,
              state_key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(instance_id, state_key),
              FOREIGN KEY(instance_id) REFERENCES plugin_instances(instance_id) ON DELETE CASCADE
            );
            "#,
            )
            .map_err(|error| format!("无法初始化 Codex Harness 本地状态库: {error}"))?;

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn upsert_workspace(&self, root: &str, name: &str) -> Result<Workspace, String> {
        let now = now_ms();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO workspaces (git_root, display_name, created_at, last_opened_at)
                VALUES (?1, ?2, ?3, ?3)
                ON CONFLICT(git_root) DO UPDATE SET
                  display_name = excluded.display_name,
                  last_opened_at = excluded.last_opened_at
                "#,
                params![root, name, now],
            )
            .map_err(|error| format!("无法保存工作区: {error}"))?;
        Ok(Workspace {
            root: root.to_owned(),
            name: name.to_owned(),
            created_at: now,
            last_opened_at: now,
        })
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let mut statement = connection
            .prepare("SELECT git_root, display_name, created_at, last_opened_at FROM workspaces ORDER BY last_opened_at DESC, display_name COLLATE NOCASE")
            .map_err(|error| format!("无法读取工作区: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Workspace {
                    root: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    last_opened_at: row.get(3)?,
                })
            })
            .map_err(|error| format!("无法读取工作区: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取工作区: {error}"))
    }

    pub fn set_thread_state(
        &self,
        thread_id: &str,
        last_read_at: Option<i64>,
        badge: Option<&str>,
    ) -> Result<(), String> {
        let now = now_ms();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO thread_ui (thread_id, last_read_at, badge, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(thread_id) DO UPDATE SET
                  last_read_at = COALESCE(excluded.last_read_at, thread_ui.last_read_at),
                  badge = excluded.badge,
                  updated_at = excluded.updated_at
                "#,
                params![thread_id, last_read_at, badge, now],
            )
            .map_err(|error| format!("无法保存会话显示状态: {error}"))?;
        Ok(())
    }

    pub fn list_thread_states(&self) -> Result<Vec<ThreadUiState>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let mut statement = connection
            .prepare("SELECT thread_id, last_read_at, badge FROM thread_ui")
            .map_err(|error| format!("无法读取会话显示状态: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(ThreadUiState {
                    thread_id: row.get(0)?,
                    last_read_at: row.get(1)?,
                    badge: row.get(2)?,
                })
            })
            .map_err(|error| format!("无法读取会话显示状态: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取会话显示状态: {error}"))
    }

    pub fn set_app_state(&self, key: &str, value: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO app_state (state_key, state_value, updated_at)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = excluded.updated_at
                "#,
                params![key, value, now_ms()],
            )
            .map_err(|error| format!("无法保存应用状态: {error}"))?;
        Ok(())
    }

    pub fn get_app_state(&self, key: &str) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        match connection.query_row(
            "SELECT state_value FROM app_state WHERE state_key = ?1",
            [key],
            |row| row.get(0),
        ) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("无法读取应用状态: {error}")),
        }
    }

    pub fn list_plugin_instances(&self) -> Result<Vec<PluginInstance>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at FROM plugin_instances ORDER BY created_at, instance_id",
            )
            .map_err(|error| format!("无法读取插件实例: {error}"))?;
        let rows = statement
            .query_map([], plugin_instance_from_row)
            .map_err(|error| format!("无法读取插件实例: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取插件实例: {error}"))
    }

    pub fn upsert_plugin_instance(
        &self,
        input: &PluginInstanceInput,
    ) -> Result<PluginInstance, String> {
        if input.instance_id.trim().is_empty() || input.plugin_id.trim().is_empty() {
            return Err("插件 instance id 和 plugin id 不能为空".to_string());
        }
        if !input.config.is_object() {
            return Err("插件配置必须是 JSON object".to_string());
        }
        let scope_key = normalized_scope_key(&input.scope_kind, input.scope_key.as_deref())?;
        let config_json = serde_json::to_string(&input.config)
            .map_err(|error| format!("无法序列化插件配置: {error}"))?;
        let now = now_ms();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO plugin_instances (
                  instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(instance_id) DO UPDATE SET
                  plugin_id = excluded.plugin_id,
                  scope_kind = excluded.scope_kind,
                  scope_key = excluded.scope_key,
                  enabled = excluded.enabled,
                  config_json = excluded.config_json,
                  updated_at = excluded.updated_at
                "#,
                params![
                    input.instance_id,
                    input.plugin_id,
                    input.scope_kind,
                    scope_key,
                    input.enabled,
                    config_json,
                    now,
                ],
            )
            .map_err(|error| format!("无法保存插件实例: {error}"))?;
        connection
            .query_row(
                "SELECT instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at FROM plugin_instances WHERE instance_id = ?1",
                [&input.instance_id],
                plugin_instance_from_row,
            )
            .map_err(|error| format!("无法读取已保存的插件实例: {error}"))
    }

    pub fn delete_plugin_instance(&self, instance_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                "DELETE FROM plugin_instances WHERE instance_id = ?1",
                [instance_id],
            )
            .map_err(|error| format!("无法删除插件实例: {error}"))?;
        Ok(())
    }

    pub fn get_plugin_state(&self, instance_id: &str, key: &str) -> Result<Option<Value>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let value: Option<String> = match connection.query_row(
            "SELECT value_json FROM plugin_state WHERE instance_id = ?1 AND state_key = ?2",
            params![instance_id, key],
            |row| row.get(0),
        ) {
            Ok(value) => Some(value),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(format!("无法读取插件状态: {error}")),
        };
        value
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|error| format!("插件状态 JSON 已损坏: {error}"))
            })
            .transpose()
    }

    pub fn set_plugin_state(
        &self,
        instance_id: &str,
        key: &str,
        value: &Value,
    ) -> Result<(), String> {
        if key.trim().is_empty() {
            return Err("插件状态 key 不能为空".to_string());
        }
        let value_json =
            serde_json::to_string(value).map_err(|error| format!("无法序列化插件状态: {error}"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO plugin_state (instance_id, state_key, value_json, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(instance_id, state_key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
                "#,
                params![instance_id, key, value_json, now_ms()],
            )
            .map_err(|error| format!("无法保存插件状态: {error}"))?;
        Ok(())
    }
}

fn normalized_scope_key(scope_kind: &str, scope_key: Option<&str>) -> Result<String, String> {
    match scope_kind {
        "global" => Ok(String::new()),
        "workspace" | "thread" => scope_key
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("{scope_kind} scope 必须指定 owner")),
        _ => Err(format!("不支持的插件 scope: {scope_kind}")),
    }
}

fn plugin_instance_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginInstance> {
    let raw_scope_key: String = row.get(3)?;
    let raw_config: String = row.get(5)?;
    let config = serde_json::from_str(&raw_config).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PluginInstance {
        instance_id: row.get(0)?,
        plugin_id: row.get(1)?,
        scope_kind: row.get(2)?,
        scope_key: (!raw_scope_key.is_empty()).then_some(raw_scope_key),
        enabled: row.get(4)?,
        config,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn harness_data_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "找不到当前用户的 HOME 目录".to_string())?;
    Ok(home.join(".codex-harness"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        path::PathBuf,
        process,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            Self(env::temp_dir().join(format!(
                "codex-harness-store-test-{}-{suffix}",
                process::id()
            )))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn persists_workspace_and_thread_ui_state() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");

        let workspace = store
            .upsert_workspace("/workspace/project", "project")
            .expect("stores workspace");
        assert_eq!(workspace.root, "/workspace/project");
        assert_eq!(workspace.name, "project");
        assert!(workspace.created_at > 0);

        store
            .set_thread_state("thread-1", Some(42), Some("working"))
            .expect("stores initial thread state");
        store
            .set_thread_state("thread-1", None, Some("success"))
            .expect("updates badge without clearing last-read timestamp");
        drop(store);

        let reloaded = HarnessStore::open_at(directory.0.clone()).expect("reopens isolated store");
        let workspaces = reloaded.list_workspaces().expect("lists workspace");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "project");

        let states = reloaded.list_thread_states().expect("lists thread state");
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].thread_id, "thread-1");
        assert_eq!(states[0].last_read_at, Some(42));
        assert_eq!(states[0].badge.as_deref(), Some("success"));
    }

    #[test]
    fn reads_and_writes_app_state() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");

        assert_eq!(
            store
                .get_app_state("selectedThreadId")
                .expect("reads missing state"),
            None
        );
        store
            .set_app_state("selectedThreadId", "thread-2")
            .expect("stores application state");
        assert_eq!(
            store
                .get_app_state("selectedThreadId")
                .expect("reads saved state"),
            Some("thread-2".to_string())
        );
    }

    #[test]
    fn persists_scoped_plugin_instances_and_private_state() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");
        let mut input = PluginInstanceInput {
            instance_id: "trajectory-global".to_string(),
            plugin_id: "builtin.trajectory".to_string(),
            scope_kind: "global".to_string(),
            scope_key: None,
            enabled: true,
            config: serde_json::json!({"compact": true}),
        };

        let created = store
            .upsert_plugin_instance(&input)
            .expect("creates plugin instance");
        assert_eq!(created.scope_key, None);
        assert_eq!(created.config, serde_json::json!({"compact": true}));

        store
            .set_plugin_state(
                &input.instance_id,
                "selection",
                &serde_json::json!({"row": 3}),
            )
            .expect("stores namespaced plugin state");
        assert_eq!(
            store
                .get_plugin_state(&input.instance_id, "selection")
                .expect("reads plugin state"),
            Some(serde_json::json!({"row": 3}))
        );

        input.scope_kind = "workspace".to_string();
        input.scope_key = Some("/workspace/project".to_string());
        input.enabled = false;
        let updated = store
            .upsert_plugin_instance(&input)
            .expect("updates plugin instance");
        assert_eq!(updated.scope_key.as_deref(), Some("/workspace/project"));
        assert!(!updated.enabled);
        assert_eq!(updated.created_at, created.created_at);

        drop(store);
        let reloaded = HarnessStore::open_at(directory.0.clone()).expect("reopens isolated store");
        assert_eq!(
            reloaded
                .list_plugin_instances()
                .expect("lists instances")
                .len(),
            1
        );
        reloaded
            .delete_plugin_instance(&input.instance_id)
            .expect("deletes instance");
        assert_eq!(
            reloaded
                .get_plugin_state(&input.instance_id, "selection")
                .expect("state was deleted with instance"),
            None
        );
    }

    #[test]
    fn rejects_scoped_plugin_without_owner() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");
        let input = PluginInstanceInput {
            instance_id: "bad".to_string(),
            plugin_id: "builtin.trajectory".to_string(),
            scope_kind: "thread".to_string(),
            scope_key: None,
            enabled: true,
            config: serde_json::json!({}),
        };
        assert!(store.upsert_plugin_instance(&input).is_err());

        let invalid_config = PluginInstanceInput {
            instance_id: "bad-config".to_string(),
            plugin_id: "builtin.trajectory".to_string(),
            scope_kind: "global".to_string(),
            scope_key: None,
            enabled: true,
            config: serde_json::Value::Null,
        };
        assert!(store.upsert_plugin_instance(&invalid_config).is_err());
    }
}
