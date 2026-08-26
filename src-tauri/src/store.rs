use rusqlite::{params, Connection};
use serde::Serialize;
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
}
