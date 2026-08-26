mod app_server;
mod git_workspace;
mod store;

use app_server::AppServerManager;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use store::{HarnessStore, ThreadUiState, Workspace};
use tauri::{Manager, State};

struct AppState {
    app_server: Arc<AppServerManager>,
    store: HarnessStore,
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
fn map_thread_workspaces(paths: Vec<String>) -> HashMap<String, Option<Workspace>> {
    let mut mapped = HashMap::new();
    for path in paths {
        mapped
            .entry(path.clone())
            .or_insert_with(|| git_workspace::resolve_main_workspace(&path).ok());
    }
    mapped
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

pub fn run() {
    let store = HarnessStore::open().expect("无法初始化 Codex Harness 本地状态库");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let manager = Arc::new(AppServerManager::new(app.handle().clone()));
            app.manage(AppState {
                app_server: manager,
                store,
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
        ])
        .run(tauri::generate_context!())
        .expect("运行 Codex Harness 时出错");
}
