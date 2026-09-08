use super::{now_ms, HarnessStore};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Map, Value};

const KEY: &str = "projectDocThreadBindings";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjectBinding {
    pub project_id: String,
    pub phase: String,
}

pub enum BindingChange<'a> {
    Bind(&'a str),
    Lock,
    Unbind,
}

fn normalize(raw: &Value) -> Option<ThreadProjectBinding> {
    let project_id = raw.as_str().or_else(|| raw.get("projectId")?.as_str())?;
    if project_id.is_empty() {
        return None;
    }
    Some(ThreadProjectBinding {
        project_id: project_id.to_string(),
        phase: if raw.get("phase").and_then(Value::as_str) == Some("pending") {
            "pending"
        } else {
            "locked"
        }
        .to_string(),
    })
}

fn parse(raw: Option<String>) -> Result<Map<String, Value>, String> {
    match raw {
        None => Ok(Map::new()),
        Some(raw) => serde_json::from_str(&raw).map_err(|e| format!("无法解析项目绑定: {e}")),
    }
}

impl HarnessStore {
    pub fn project_thread_binding(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadProjectBinding>, String> {
        let bindings = parse(self.get_app_state(KEY)?)?;
        Ok(bindings.get(thread_id).and_then(normalize))
    }

    /// 整个读改写在 SQLite IMMEDIATE 事务内完成，覆盖多个窗口/进程的连接。
    /// 保留旧 JSON 格式；不从会话正文推导或恢复写权限。
    pub fn change_project_thread_binding(
        &self,
        thread_id: &str,
        change: BindingChange<'_>,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|_| "本地状态库锁不可用")?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("无法开始项目绑定事务: {e}"))?;
        let raw = tx
            .query_row(
                "SELECT state_value FROM app_state WHERE state_key = ?1",
                [KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("无法读取项目绑定: {e}"))?;
        let mut bindings = parse(raw)?;
        let binding = bindings.get(thread_id).and_then(normalize);
        match change {
            BindingChange::Bind(project_id) => {
                if project_id.is_empty() || thread_id.is_empty() {
                    return Err("项目和会话 ID 不能为空".to_string());
                }
                if let Some(binding) = &binding {
                    if binding.phase == "locked" {
                        return if binding.project_id == project_id {
                            Ok(())
                        } else {
                            Err("项目绑定已锁定，不能更换项目".to_string())
                        };
                    }
                }
                bindings.insert(
                    thread_id.to_string(),
                    json!({ "projectId": project_id, "phase": "pending" }),
                );
            }
            BindingChange::Lock => {
                let Some(binding) = binding else {
                    return Ok(());
                };
                if binding.phase == "locked" {
                    return Ok(());
                }
                bindings.insert(
                    thread_id.to_string(),
                    json!({ "projectId": binding.project_id, "phase": "locked" }),
                );
            }
            BindingChange::Unbind => {
                let Some(binding) = binding else {
                    return Ok(());
                };
                if binding.phase == "locked" {
                    return Err("项目绑定已锁定，不能解绑".to_string());
                }
                bindings.remove(thread_id);
            }
        }
        tx.execute(
            "INSERT INTO app_state (state_key, state_value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = excluded.updated_at",
            params![KEY, Value::Object(bindings).to_string(), now_ms()],
        ).map_err(|e| format!("无法保存项目绑定: {e}"))?;
        tx.commit().map_err(|e| format!("无法提交项目绑定: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_can_change_or_unbind_but_locked_and_legacy_cannot() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().into()).unwrap();
        store.set_app_state(KEY, r#"{"legacy":"old"}"#).unwrap();
        store
            .change_project_thread_binding("t", BindingChange::Bind("a"))
            .unwrap();
        store
            .change_project_thread_binding("t", BindingChange::Bind("b"))
            .unwrap();
        assert_eq!(
            store
                .project_thread_binding("t")
                .unwrap()
                .unwrap()
                .project_id,
            "b"
        );
        store
            .change_project_thread_binding("t", BindingChange::Unbind)
            .unwrap();
        assert!(store.project_thread_binding("t").unwrap().is_none());
        store
            .change_project_thread_binding("t", BindingChange::Bind("a"))
            .unwrap();
        store
            .change_project_thread_binding("t", BindingChange::Lock)
            .unwrap();
        for id in ["t", "legacy"] {
            assert!(store
                .change_project_thread_binding(id, BindingChange::Unbind)
                .is_err());
            assert!(store
                .change_project_thread_binding(id, BindingChange::Bind("other"))
                .is_err());
            assert_eq!(
                store.project_thread_binding(id).unwrap().unwrap().phase,
                "locked"
            );
        }
        store
            .change_project_thread_binding("t", BindingChange::Bind("a"))
            .unwrap();
        let reopened = HarnessStore::open_at(dir.path().into()).unwrap();
        assert_eq!(
            reopened.project_thread_binding("t").unwrap().unwrap().phase,
            "locked"
        );
    }

    #[test]
    fn corrupt_state_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().into()).unwrap();
        for raw in ["not json", "[]", "null"] {
            store.set_app_state(KEY, raw).unwrap();
            assert!(store
                .change_project_thread_binding("t", BindingChange::Bind("a"))
                .is_err());
            assert_eq!(store.get_app_state(KEY).unwrap().unwrap(), raw);
        }
    }

    #[test]
    fn independent_connections_do_not_lose_concurrent_updates() {
        let dir = tempfile::tempdir().unwrap();
        let stores: Vec<_> = (0..8)
            .map(|_| HarnessStore::open_at(dir.path().into()).unwrap())
            .collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(stores.len()));
        let handles: Vec<_> = stores
            .into_iter()
            .enumerate()
            .map(|(i, store)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let id = format!("t-{i}");
                    store
                        .change_project_thread_binding(&id, BindingChange::Bind("project"))
                        .unwrap();
                    store
                        .change_project_thread_binding(&id, BindingChange::Lock)
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let store = HarnessStore::open_at(dir.path().into()).unwrap();
        for i in 0..8 {
            assert_eq!(
                store
                    .project_thread_binding(&format!("t-{i}"))
                    .unwrap()
                    .unwrap()
                    .phase,
                "locked"
            );
        }
    }
}
