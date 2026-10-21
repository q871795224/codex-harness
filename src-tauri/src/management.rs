//! Local management requests are executed by the mounted application services.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::oneshot;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REQUESTS: usize = 4096;
type Outcome = Result<Value, String>;
type Emitter = Arc<dyn Fn(&ManagementRequest) -> Result<(), String> + Send + Sync>;

fn is_read(method: &str) -> bool {
    matches!(method, "status" | "capabilities" | "config.read" | "workspaces.list" | "sessions.list" | "plugins.list" | "skills.list" | "mcp.list")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagementRequest {
    pub request_id: String,
    pub method: String,
    #[serde(default = "empty_object")]
    pub params: Value,
}

fn empty_object() -> Value { json!({}) }

struct Entry {
    request: ManagementRequest,
    sender: Option<oneshot::Sender<Outcome>>,
    outcome: Option<Outcome>,
}

#[derive(Default)]
struct State {
    ready: bool,
    requests: BTreeMap<String, Entry>,
}

pub struct Management {
    pub token: String,
    state: Mutex<State>,
    emit: Emitter,
}

impl Management {
    pub fn new(emit: Emitter) -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        Ok(Self { token: bytes.iter().map(|b| format!("{b:02x}")).collect(), state: Mutex::default(), emit })
    }

    pub fn set_ready(&self, ready: bool) -> Result<(), String> {
        self.state.lock().map_err(|e| e.to_string())?.ready = ready;
        Ok(())
    }

    pub fn respond(&self, id: &str, result: Option<Value>, error: Option<String>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let entry = state.requests.get_mut(id).ok_or("管理请求已不存在")?;
        if entry.outcome.is_some() { return Err("管理请求已完成".into()); }
        let outcome = match error { Some(error) => Err(error), None => Ok(result.unwrap_or(Value::Null)) };
        entry.outcome = Some(outcome.clone());
        if let Some(sender) = entry.sender.take() { let _ = sender.send(outcome); }
        Ok(())
    }

    pub async fn call(&self, request: ManagementRequest) -> (u16, Value) {
        let id = request.request_id.clone();
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            || request.method.is_empty() || !request.params.is_object() {
            return (400, json!({"error": "requestId、method 或 params 无效"}));
        }
        let receiver = {
            let mut state = self.state.lock().unwrap();
            if let Some(entry) = state.requests.get(&id) {
                if entry.request.method != request.method || entry.request.params != request.params {
                    return (409, json!({"requestId": id, "error": "requestId 已用于不同操作"}));
                }
                return match &entry.outcome {
                    Some(outcome) => response(&id, outcome.clone()),
                    None => (409, json!({"requestId": id, "error": "操作仍在执行或结果未知；请查询实际状态，不要换 ID 重试写操作"})),
                };
            }
            if !state.ready { return (503, json!({"error": "Harness 界面尚未就绪，请等待启动完成"})); }
            // Never evict an uncertain request and accidentally run it twice.
            // At capacity, require a new application lifetime for further writes.
            if !is_read(&request.method) && state.requests.values().filter(|entry| !is_read(&entry.request.method)).count() >= MAX_REQUESTS {
                return (503, json!({"error": "本实例管理请求记录已满，请重新启动应用"}));
            }
            let (sender, receiver) = oneshot::channel();
            state.requests.insert(id.clone(), Entry { request: request.clone(), sender: Some(sender), outcome: None });
            receiver
        };
        if let Err(error) = (self.emit)(&request) {
            let _ = self.respond(&id, None, Some(error));
        }
        let outcome = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => response(&id, outcome),
            _ => (504, json!({"requestId": id, "error": "操作超时，结果未知；请查询实际状态，不要换 ID 重试写操作"})),
        };
        if is_read(&request.method) {
            self.state.lock().unwrap().requests.remove(&id);
        }
        outcome
    }
}

fn response(id: &str, outcome: Outcome) -> (u16, Value) {
    match outcome {
        Ok(result) => (200, json!({"requestId": id, "result": result})),
        Err(error) => (400, json!({"requestId": id, "error": error})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str) -> ManagementRequest {
        ManagementRequest { request_id: id.into(), method: "plugins.setEnabled".into(), params: json!({"enabled": false}) }
    }

    #[tokio::test]
    async fn not_ready_does_not_emit_or_reserve_request() {
        let manager = Management::new(Arc::new(|_| panic!("must not emit"))).unwrap();
        assert_eq!(manager.call(request("one")).await.0, 503);
        assert!(manager.state.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn duplicate_inflight_and_completed_writes_are_not_executed_again() {
        let (sender, mut requests) = tokio::sync::mpsc::unbounded_channel();
        let manager = Arc::new(Management::new(Arc::new(move |request| {
            sender.send(request.clone()).map_err(|e| e.to_string())
        })).unwrap());
        manager.set_ready(true).unwrap();
        let pending = manager.clone();
        let task = tokio::spawn(async move { pending.call(request("one")).await });
        requests.recv().await.unwrap();
        assert_eq!(manager.call(request("one")).await.0, 409);
        manager.respond("one", Some(json!({"enabled": false})), None).unwrap();
        let outcome = task.await.unwrap();
        assert_eq!(outcome.0, 200);
        assert_eq!(manager.call(request("one")).await, outcome);
        let mut different = request("one");
        different.params = json!({"enabled": true});
        assert_eq!(manager.call(different).await.0, 409);
        assert!(requests.try_recv().is_err());
    }
}
