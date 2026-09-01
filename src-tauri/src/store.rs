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
    pub checkout_root: String,
    pub name: String,
    pub branch: Option<String>,
    pub sha: Option<String>,
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
pub struct ClaudeSessionInput {
    pub id: String,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub id: String,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunInput {
    pub run_id: String,
    pub instance_id: String,
    pub mode: String,
    pub workspace_access: String,
    pub status: String,
    pub title: String,
    pub workspace_root: String,
    pub parent_thread_id: Option<String>,
    pub child_thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub error_summary: Option<String>,
    pub completed_at: Option<i64>,
    pub returned_at: Option<i64>,
    pub workspace_removed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRun {
    pub run_id: String,
    pub instance_id: String,
    pub mode: String,
    pub workspace_access: String,
    pub status: String,
    pub title: String,
    pub workspace_root: String,
    pub parent_thread_id: Option<String>,
    pub child_thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub error_summary: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub returned_at: Option<i64>,
    pub workspace_removed_at: Option<i64>,
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
        let mut connection = Connection::open(root.join("state.sqlite"))
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
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS plugin_state (
              instance_id TEXT NOT NULL,
              state_key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(instance_id, state_key),
              FOREIGN KEY(instance_id) REFERENCES plugin_instances(instance_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS plugin_runs (
              run_id TEXT PRIMARY KEY NOT NULL,
              instance_id TEXT NOT NULL,
              mode TEXT NOT NULL CHECK(mode IN ('detached', 'delegated')),
              workspace_access TEXT NOT NULL DEFAULT 'shared-write' CHECK(workspace_access IN ('read-only', 'shared-write', 'isolated-delivery')),
              status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'waitingApproval', 'completed', 'failed', 'cancelled')),
              title TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              parent_thread_id TEXT,
              child_thread_id TEXT,
              turn_id TEXT,
              error_summary TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              completed_at INTEGER,
              returned_at INTEGER,
              workspace_removed_at INTEGER,
              FOREIGN KEY(instance_id) REFERENCES plugin_instances(instance_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS plugin_runs_instance_updated
              ON plugin_runs(instance_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS usage_snapshots (
              range_key TEXT PRIMARY KEY NOT NULL,
              snapshot_json TEXT NOT NULL,
              fetched_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claude_sessions (
              session_id TEXT PRIMARY KEY NOT NULL,
              provider_session_id TEXT,
              cwd TEXT NOT NULL,
              title TEXT NOT NULL,
              archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS claude_sessions_archived_updated
              ON claude_sessions(archived, updated_at DESC);
            "#,
            )
            .map_err(|error| format!("无法初始化 Codex Harness 本地状态库: {error}"))?;
        migrate_plugin_instances_allow_multiple_per_scope(&mut connection)?;
        migrate_plugin_runs_workspace_access(&connection)?;
        migrate_plugin_runs_workspace_removed_at(&connection)?;

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
            checkout_root: root.to_owned(),
            name: name.to_owned(),
            branch: None,
            sha: None,
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
                    root: row.get::<_, String>(0)?,
                    checkout_root: row.get(0)?,
                    name: row.get(1)?,
                    branch: None,
                    sha: None,
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

    pub fn list_claude_sessions(&self, archived: bool) -> Result<Vec<ClaudeSession>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT session_id, provider_session_id, cwd, title, archived, created_at, updated_at FROM claude_sessions WHERE archived = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|error| format!("无法读取 Claude 会话索引: {error}"))?;
        let rows = statement
            .query_map([archived], claude_session_from_row)
            .map_err(|error| format!("无法读取 Claude 会话索引: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取 Claude 会话索引: {error}"))
    }

    pub fn upsert_claude_session(
        &self,
        input: &ClaudeSessionInput,
    ) -> Result<ClaudeSession, String> {
        if input.id.trim().is_empty() || input.cwd.trim().is_empty() {
            return Err("Claude session id 和 cwd 不能为空".to_string());
        }
        let now = now_ms();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO claude_sessions (
                  session_id, provider_session_id, cwd, title, archived, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
                ON CONFLICT(session_id) DO UPDATE SET
                  provider_session_id = COALESCE(excluded.provider_session_id, claude_sessions.provider_session_id),
                  cwd = excluded.cwd,
                  title = excluded.title,
                  archived = 0,
                  updated_at = excluded.updated_at
                "#,
                params![
                    input.id,
                    input.provider_session_id,
                    input.cwd,
                    input.title.trim(),
                    now,
                ],
            )
            .map_err(|error| format!("无法保存 Claude 会话索引: {error}"))?;
        connection
            .query_row(
                "SELECT session_id, provider_session_id, cwd, title, archived, created_at, updated_at FROM claude_sessions WHERE session_id = ?1",
                [&input.id],
                claude_session_from_row,
            )
            .map_err(|error| format!("无法读取已保存的 Claude 会话索引: {error}"))
    }

    pub fn set_claude_session_archived(&self, id: &str, archived: bool) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let changed = connection
            .execute(
                "UPDATE claude_sessions SET archived = ?2, updated_at = ?3 WHERE session_id = ?1",
                params![id, archived, now_ms()],
            )
            .map_err(|error| format!("无法更新 Claude 会话归档状态: {error}"))?;
        if changed == 0 {
            return Err("Claude 会话不存在".to_string());
        }
        Ok(())
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

    pub fn get_usage_snapshot(&self, range_key: &str) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        match connection.query_row(
            "SELECT snapshot_json FROM usage_snapshots WHERE range_key = ?1",
            [range_key],
            |row| row.get(0),
        ) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("无法读取用量快照: {error}")),
        }
    }

    pub fn set_usage_snapshot(
        &self,
        range_key: &str,
        snapshot_json: &str,
        fetched_at: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO usage_snapshots (range_key, snapshot_json, fetched_at)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(range_key) DO UPDATE SET
                  snapshot_json = excluded.snapshot_json,
                  fetched_at = excluded.fetched_at
                "#,
                params![range_key, snapshot_json, fetched_at],
            )
            .map_err(|error| format!("无法保存用量快照: {error}"))?;
        connection
            .execute(
                r#"
                DELETE FROM usage_snapshots
                WHERE range_key NOT IN (
                    SELECT range_key
                    FROM usage_snapshots
                    ORDER BY fetched_at DESC
                    LIMIT 24
                )
                "#,
                [],
            )
            .map_err(|error| format!("无法清理用量快照: {error}"))?;
        Ok(())
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

    pub fn list_plugin_runs(&self) -> Result<Vec<PluginRun>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT run_id, instance_id, mode, workspace_access, status, title, workspace_root, parent_thread_id, child_thread_id, turn_id, error_summary, created_at, updated_at, completed_at, returned_at, workspace_removed_at FROM plugin_runs ORDER BY updated_at DESC, run_id",
            )
            .map_err(|error| format!("无法读取插件任务: {error}"))?;
        let rows = statement
            .query_map([], plugin_run_from_row)
            .map_err(|error| format!("无法读取插件任务: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取插件任务: {error}"))
    }

    pub fn upsert_plugin_run(&self, input: &PluginRunInput) -> Result<PluginRun, String> {
        validate_plugin_run(input)?;
        let now = now_ms();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "本地状态库锁不可用".to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO plugin_runs (
                  run_id, instance_id, mode, workspace_access, status, title, workspace_root,
                  parent_thread_id, child_thread_id, turn_id, error_summary,
                  created_at, updated_at, completed_at, returned_at, workspace_removed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15)
                ON CONFLICT(run_id) DO UPDATE SET
                  status = excluded.status,
                  title = excluded.title,
                  parent_thread_id = excluded.parent_thread_id,
                  child_thread_id = excluded.child_thread_id,
                  turn_id = excluded.turn_id,
                  error_summary = excluded.error_summary,
                  updated_at = excluded.updated_at,
                  completed_at = excluded.completed_at,
                  returned_at = excluded.returned_at,
                  workspace_removed_at = excluded.workspace_removed_at
                "#,
                params![
                    input.run_id,
                    input.instance_id,
                    input.mode,
                    input.workspace_access,
                    input.status,
                    input.title,
                    input.workspace_root,
                    input.parent_thread_id,
                    input.child_thread_id,
                    input.turn_id,
                    input.error_summary,
                    now,
                    input.completed_at,
                    input.returned_at,
                    input.workspace_removed_at,
                ],
            )
            .map_err(|error| format!("无法保存插件任务: {error}"))?;
        connection
            .query_row(
                "SELECT run_id, instance_id, mode, workspace_access, status, title, workspace_root, parent_thread_id, child_thread_id, turn_id, error_summary, created_at, updated_at, completed_at, returned_at, workspace_removed_at FROM plugin_runs WHERE run_id = ?1",
                [&input.run_id],
                plugin_run_from_row,
            )
            .map_err(|error| format!("无法读取已保存的插件任务: {error}"))
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

fn migrate_plugin_instances_allow_multiple_per_scope(
    connection: &mut Connection,
) -> Result<(), String> {
    let schema: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_instances'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取插件实例表结构: {error}"))?;
    let normalized_schema: String = schema
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect();
    if !normalized_schema.contains("UNIQUE(PLUGIN_ID,SCOPE_KIND,SCOPE_KEY)") {
        return Ok(());
    }

    connection
        .pragma_update(None, "foreign_keys", false)
        .map_err(|error| format!("无法暂停插件实例外键检查: {error}"))?;
    let migration_result = (|| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            r#"
            CREATE TABLE plugin_instances_new (
              instance_id TEXT PRIMARY KEY NOT NULL,
              plugin_id TEXT NOT NULL,
              scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global', 'workspace', 'thread')),
              scope_key TEXT NOT NULL DEFAULT '',
              enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
              config_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO plugin_instances_new (
              instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at
            )
            SELECT instance_id, plugin_id, scope_kind, scope_key, enabled, config_json, created_at, updated_at
            FROM plugin_instances;
            DROP TABLE plugin_instances;
            ALTER TABLE plugin_instances_new RENAME TO plugin_instances;
            "#,
        )?;
        transaction.commit()
    })();
    let foreign_keys_result = connection.pragma_update(None, "foreign_keys", true);

    migration_result.map_err(|error| format!("无法迁移插件实例表: {error}"))?;
    foreign_keys_result.map_err(|error| format!("无法恢复插件实例外键检查: {error}"))?;
    Ok(())
}

fn migrate_plugin_runs_workspace_access(connection: &Connection) -> Result<(), String> {
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('plugin_runs') WHERE name = 'workspace_access'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取插件任务表结构: {error}"))?;
    if exists == 0 {
        connection
            .execute(
                "ALTER TABLE plugin_runs ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'shared-write' CHECK(workspace_access IN ('read-only', 'shared-write', 'isolated-delivery'))",
                [],
            )
            .map_err(|error| format!("无法迁移插件任务工作区模式: {error}"))?;
    }
    Ok(())
}

fn migrate_plugin_runs_workspace_removed_at(connection: &Connection) -> Result<(), String> {
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('plugin_runs') WHERE name = 'workspace_removed_at'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取插件任务表结构: {error}"))?;
    if exists == 0 {
        connection
            .execute(
                "ALTER TABLE plugin_runs ADD COLUMN workspace_removed_at INTEGER",
                [],
            )
            .map_err(|error| format!("无法迁移插件任务 worktree 状态: {error}"))?;
    }
    Ok(())
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

fn validate_plugin_run(input: &PluginRunInput) -> Result<(), String> {
    if input.run_id.trim().is_empty()
        || input.instance_id.trim().is_empty()
        || input.title.trim().is_empty()
        || input.workspace_root.trim().is_empty()
    {
        return Err("插件任务缺少必要字段".to_string());
    }
    if !matches!(input.mode.as_str(), "detached" | "delegated") {
        return Err(format!("不支持的插件任务模式: {}", input.mode));
    }
    if !matches!(
        input.workspace_access.as_str(),
        "read-only" | "shared-write" | "isolated-delivery"
    ) {
        return Err(format!(
            "不支持的插件任务工作区模式: {}",
            input.workspace_access
        ));
    }
    if !matches!(
        input.status.as_str(),
        "starting" | "running" | "waitingApproval" | "completed" | "failed" | "cancelled"
    ) {
        return Err(format!("不支持的插件任务状态: {}", input.status));
    }
    if input.mode == "delegated" && input.parent_thread_id.is_none() {
        return Err("delegated 任务必须指定 parent thread".to_string());
    }
    Ok(())
}

fn plugin_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginRun> {
    Ok(PluginRun {
        run_id: row.get(0)?,
        instance_id: row.get(1)?,
        mode: row.get(2)?,
        workspace_access: row.get(3)?,
        status: row.get(4)?,
        title: row.get(5)?,
        workspace_root: row.get(6)?,
        parent_thread_id: row.get(7)?,
        child_thread_id: row.get(8)?,
        turn_id: row.get(9)?,
        error_summary: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        completed_at: row.get(13)?,
        returned_at: row.get(14)?,
        workspace_removed_at: row.get(15)?,
    })
}

fn claude_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClaudeSession> {
    Ok(ClaudeSession {
        id: row.get(0)?,
        provider_session_id: row.get(1)?,
        cwd: row.get(2)?,
        title: row.get(3)?,
        archived: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub(crate) fn harness_data_dir() -> Result<PathBuf, String> {
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
    fn persists_claude_session_index_without_transcript() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");
        let session = store
            .upsert_claude_session(&ClaudeSessionInput {
                id: "claude-local-1".to_string(),
                provider_session_id: None,
                cwd: "/workspace/project".to_string(),
                title: "Claude 会话".to_string(),
            })
            .expect("stores Claude session");
        assert_eq!(session.provider_session_id, None);

        let updated = store
            .upsert_claude_session(&ClaudeSessionInput {
                id: session.id.clone(),
                provider_session_id: Some("provider-1".to_string()),
                cwd: session.cwd.clone(),
                title: "Claude 会话".to_string(),
            })
            .expect("updates provider session id");
        assert_eq!(updated.provider_session_id.as_deref(), Some("provider-1"));
        assert_eq!(store.list_claude_sessions(false).unwrap().len(), 1);

        store
            .set_claude_session_archived(&session.id, true)
            .expect("archives Claude session");
        assert!(store.list_claude_sessions(false).unwrap().is_empty());
        assert_eq!(store.list_claude_sessions(true).unwrap().len(), 1);
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
    fn persists_usage_snapshots_by_date_range() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");
        assert_eq!(
            store.get_usage_snapshot("2026-08-01:2026-08-30").unwrap(),
            None
        );
        store
            .set_usage_snapshot("2026-08-01:2026-08-30", r#"{"fetchedAt":42}"#, 42)
            .expect("stores usage snapshot");
        drop(store);
        let reloaded = HarnessStore::open_at(directory.0.clone()).expect("reopens isolated store");
        assert_eq!(
            reloaded
                .get_usage_snapshot("2026-08-01:2026-08-30")
                .expect("reads usage snapshot")
                .as_deref(),
            Some(r#"{"fetchedAt":42}"#),
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
    fn persists_multiple_plugin_instances_in_the_same_scope() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");

        for instance_id in ["quick-agent-1", "quick-agent-2"] {
            store
                .upsert_plugin_instance(&PluginInstanceInput {
                    instance_id: instance_id.to_string(),
                    plugin_id: "builtin.quick-agent".to_string(),
                    scope_kind: "global".to_string(),
                    scope_key: None,
                    enabled: true,
                    config: serde_json::json!({"jobs": []}),
                })
                .expect("stores another instance in the same scope");
        }

        assert_eq!(
            store
                .list_plugin_instances()
                .expect("lists instances")
                .len(),
            2
        );
    }

    #[test]
    fn migrates_legacy_plugin_scope_constraint_without_losing_state() {
        let directory = TestDir::new();
        fs::create_dir_all(&directory.0).expect("creates legacy store directory");
        let legacy =
            Connection::open(directory.0.join("state.sqlite")).expect("opens legacy store");
        legacy
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE plugin_instances (
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
                CREATE TABLE plugin_state (
                  instance_id TEXT NOT NULL,
                  state_key TEXT NOT NULL,
                  value_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY(instance_id, state_key),
                  FOREIGN KEY(instance_id) REFERENCES plugin_instances(instance_id) ON DELETE CASCADE
                );
                INSERT INTO plugin_instances VALUES (
                  'quick-agent-1', 'builtin.quick-agent', 'global', '', 1, '{"jobs":[]}', 10, 20
                );
                INSERT INTO plugin_state VALUES ('quick-agent-1', 'selection', '{"row":3}', 20);
                "#,
            )
            .expect("creates legacy schema and data");
        drop(legacy);

        let store = HarnessStore::open_at(directory.0.clone()).expect("migrates legacy store");
        assert_eq!(
            store
                .get_plugin_state("quick-agent-1", "selection")
                .expect("keeps plugin state"),
            Some(serde_json::json!({"row": 3}))
        );
        store
            .upsert_plugin_instance(&PluginInstanceInput {
                instance_id: "quick-agent-2".to_string(),
                plugin_id: "builtin.quick-agent".to_string(),
                scope_kind: "global".to_string(),
                scope_key: None,
                enabled: true,
                config: serde_json::json!({"jobs": []}),
            })
            .expect("stores another instance after migration");
        store
            .delete_plugin_instance("quick-agent-1")
            .expect("deletes migrated instance");
        assert_eq!(
            store
                .get_plugin_state("quick-agent-1", "selection")
                .expect("checks cascade after migration"),
            None
        );
    }

    #[test]
    fn migrates_legacy_plugin_runs_to_shared_write_access() {
        let directory = TestDir::new();
        fs::create_dir_all(&directory.0).expect("creates legacy store directory");
        let legacy =
            Connection::open(directory.0.join("state.sqlite")).expect("opens legacy store");
        legacy
            .execute_batch(
                r#"
                CREATE TABLE plugin_runs (
                  run_id TEXT PRIMARY KEY NOT NULL,
                  instance_id TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  status TEXT NOT NULL,
                  title TEXT NOT NULL,
                  workspace_root TEXT NOT NULL,
                  parent_thread_id TEXT,
                  child_thread_id TEXT,
                  turn_id TEXT,
                  error_summary TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  completed_at INTEGER,
                  returned_at INTEGER
                );
                INSERT INTO plugin_runs VALUES (
                  'legacy-run', 'legacy-agent', 'detached', 'completed', '旧任务', '/repo',
                  NULL, 'child-1', 'turn-1', NULL, 10, 20, 20, NULL
                );
                "#,
            )
            .expect("creates legacy plugin run");
        drop(legacy);

        let store = HarnessStore::open_at(directory.0.clone()).expect("migrates legacy store");
        let runs = store
            .list_plugin_runs()
            .expect("lists migrated plugin runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "legacy-run");
        assert_eq!(runs[0].workspace_access, "shared-write");
        assert_eq!(runs[0].workspace_removed_at, None);
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

    #[test]
    fn persists_plugin_run_without_conversation_content() {
        let directory = TestDir::new();
        let store = HarnessStore::open_at(directory.0.clone()).expect("opens isolated store");
        store
            .upsert_plugin_instance(&PluginInstanceInput {
                instance_id: "temporary-agent".to_string(),
                plugin_id: "builtin.temporary-agent".to_string(),
                scope_kind: "global".to_string(),
                scope_key: None,
                enabled: true,
                config: serde_json::json!({}),
            })
            .expect("creates owner instance");
        let mut run = PluginRunInput {
            run_id: "run-1".to_string(),
            instance_id: "temporary-agent".to_string(),
            mode: "delegated".to_string(),
            workspace_access: "shared-write".to_string(),
            status: "starting".to_string(),
            title: "检查发布状态".to_string(),
            workspace_root: "/workspace/project".to_string(),
            parent_thread_id: Some("parent-1".to_string()),
            child_thread_id: None,
            turn_id: None,
            error_summary: None,
            completed_at: None,
            returned_at: None,
            workspace_removed_at: None,
        };
        let created = store.upsert_plugin_run(&run).expect("creates plugin run");
        assert_eq!(created.status, "starting");
        assert_eq!(created.child_thread_id, None);

        run.status = "completed".to_string();
        run.child_thread_id = Some("child-1".to_string());
        run.turn_id = Some("turn-1".to_string());
        run.completed_at = Some(42);
        run.workspace_removed_at = Some(43);
        let completed = store.upsert_plugin_run(&run).expect("completes plugin run");
        assert_eq!(completed.created_at, created.created_at);
        assert_eq!(completed.completed_at, Some(42));
        assert_eq!(completed.workspace_removed_at, Some(43));
        assert_eq!(
            store.list_plugin_runs().expect("lists plugin runs").len(),
            1
        );
    }
}
