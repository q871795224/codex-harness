mod app_server;
mod git_workspace;
mod local_connector;
mod store;

use app_server::AppServerManager;
use local_connector::{
    ConnectorHealth, ConnectorMessage, LocalConnector, SendMessageInput, SendMessageResult,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use store::{
    HarnessStore, PluginInstance, PluginInstanceInput, PluginRun, PluginRunInput, ThreadUiState,
    Workspace,
};
use tauri::{Manager, State};

struct AppState {
    app_server: Arc<AppServerManager>,
    local_connector: LocalConnector,
    store: HarnessStore,
    workspace_cache: Arc<Mutex<HashMap<String, Option<Workspace>>>>,
}

#[tauri::command]
async fn local_connector_health(
    state: State<'_, AppState>,
    base_url: String,
) -> Result<ConnectorHealth, String> {
    state.local_connector.health(&base_url).await
}

#[tauri::command]
async fn local_connector_list_messages(
    state: State<'_, AppState>,
    base_url: String,
    limit: u16,
) -> Result<Vec<ConnectorMessage>, String> {
    state.local_connector.list_messages(&base_url, limit).await
}

#[tauri::command]
async fn local_connector_send_message(
    state: State<'_, AppState>,
    base_url: String,
    input: SendMessageInput,
) -> Result<SendMessageResult, String> {
    state.local_connector.send_message(&base_url, input).await
}

#[tauri::command]
async fn app_server_request(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    state.app_server.request(method, params).await
}

#[tauri::command]
async fn app_server_respond(
    state: State<'_, AppState>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    state.app_server.respond(id, result).await
}

#[tauri::command]
fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    state.store.list_workspaces()
}

#[tauri::command]
fn register_workspace(state: State<'_, AppState>, path: String) -> Result<Workspace, String> {
    let workspace = git_workspace::resolve_main_workspace(&path)?;
    state
        .store
        .upsert_workspace(&workspace.root, &workspace.name)
}

#[tauri::command]
async fn map_thread_workspaces(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<HashMap<String, Option<Workspace>>, String> {
    let cache = state.workspace_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut mapped = HashMap::new();
        for path in paths {
            let workspace = cache
                .entry(path.clone())
                .or_insert_with(|| git_workspace::resolve_main_workspace(&path).ok())
                .clone();
            mapped.insert(path, workspace);
        }
        mapped
    })
    .await
    .map_err(|error| format!("工作区映射任务异常结束: {error}"))
}

#[tauri::command]
fn list_thread_states(state: State<'_, AppState>) -> Result<Vec<ThreadUiState>, String> {
    state.store.list_thread_states()
}

#[tauri::command]
fn set_thread_state(
    state: State<'_, AppState>,
    thread_id: String,
    last_read_at: Option<i64>,
    badge: Option<String>,
) -> Result<(), String> {
    state
        .store
        .set_thread_state(&thread_id, last_read_at, badge.as_deref())
}

#[tauri::command]
fn get_app_state(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    state.store.get_app_state(&key)
}

#[tauri::command]
fn set_app_state(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.store.set_app_state(&key, &value)
}

#[tauri::command]
fn list_plugin_instances(state: State<'_, AppState>) -> Result<Vec<PluginInstance>, String> {
    state.store.list_plugin_instances()
}

#[tauri::command]
fn upsert_plugin_instance(
    state: State<'_, AppState>,
    input: PluginInstanceInput,
) -> Result<PluginInstance, String> {
    state.store.upsert_plugin_instance(&input)
}

#[tauri::command]
fn delete_plugin_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    state.store.delete_plugin_instance(&instance_id)
}

#[tauri::command]
fn get_plugin_state(
    state: State<'_, AppState>,
    instance_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    state.store.get_plugin_state(&instance_id, &key)
}

#[tauri::command]
fn set_plugin_state(
    state: State<'_, AppState>,
    instance_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    state.store.set_plugin_state(&instance_id, &key, &value)
}

#[tauri::command]
fn list_plugin_runs(state: State<'_, AppState>) -> Result<Vec<PluginRun>, String> {
    state.store.list_plugin_runs()
}

#[tauri::command]
fn upsert_plugin_run(
    state: State<'_, AppState>,
    input: PluginRunInput,
) -> Result<PluginRun, String> {
    state.store.upsert_plugin_run(&input)
}

pub fn run() {
    let store = HarnessStore::open().expect("无法初始化 Codex Harness 本地状态库");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let manager = Arc::new(AppServerManager::new(app.handle().clone()));
            app.manage(AppState {
                app_server: manager,
                local_connector: LocalConnector::new(),
                store,
                workspace_cache: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_server_request,
            app_server_respond,
            list_workspaces,
            register_workspace,
            map_thread_workspaces,
            list_thread_states,
            set_thread_state,
            get_app_state,
            set_app_state,
            list_plugin_instances,
            upsert_plugin_instance,
            delete_plugin_instance,
            get_plugin_state,
            set_plugin_state,
            list_plugin_runs,
            upsert_plugin_run,
            local_connector_health,
            local_connector_list_messages,
            local_connector_send_message,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Codex Harness 时出错");
}
