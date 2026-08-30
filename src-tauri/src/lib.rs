mod app_server;
mod codex_radar;
mod diagnostics;
mod git_workspace;
mod harness_files;
mod local_connector;
mod quick_command;
mod store;
mod system_notification;

use app_server::AppServerManager;
use codex_radar::{CodexRadarClient, RadarModelTable};
use diagnostics::DiagnosticLog;
use local_connector::{
    ConnectorHealth, ConnectorMessage, LocalConnector, SendMessageInput, SendMessageResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
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
    diagnostics: Arc<DiagnosticLog>,
    local_connector: LocalConnector,
    codex_radar: CodexRadarClient,
    store: HarnessStore,
    workspace_cache: Arc<Mutex<HashMap<String, Option<Workspace>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientDiagnostic {
    level: String,
    area: String,
    event: String,
    method: Option<String>,
    thread_id: Option<String>,
    error_code: Option<String>,
    duration_ms: Option<u64>,
    attempt_id: Option<String>,
    stage: Option<String>,
    generator_thread_id: Option<String>,
    trigger: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    reason: Option<String>,
    source_chars: Option<u64>,
    generated_chars: Option<u64>,
    accepted: Option<bool>,
    status: Option<String>,
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
async fn codex_radar_model_table(state: State<'_, AppState>) -> Result<RadarModelTable, String> {
    state.codex_radar.model_table().await
}

#[tauri::command]
async fn run_quick_command(
    command_id: String,
) -> Result<quick_command::QuickCommandResult, String> {
    quick_command::run(&command_id).await
}

#[tauri::command]
async fn request_system_notification_permission(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let result = system_notification::request_permission().await;
    match &result {
        Ok(granted) => state.diagnostics.record(
            if *granted { "info" } else { "warn" },
            "system-notification",
            if *granted {
                "permission.granted"
            } else {
                "permission.denied"
            },
            json!({}),
        ),
        Err(error) => state.diagnostics.record(
            "error",
            "system-notification",
            "permission.failed",
            json!({
                "errorCode": diagnostics::error_code(error),
                "reason": error,
            }),
        ),
    }
    result
}

#[tauri::command]
async fn send_system_notification(
    state: State<'_, AppState>,
    input: system_notification::SystemNotificationInput,
) -> Result<(), String> {
    let thread_id = input.thread_id().to_string();
    let turn_id = input.turn_id().to_string();
    let result = system_notification::send(input).await;
    match &result {
        Ok(()) => state.diagnostics.record(
            "info",
            "system-notification",
            "delivery.scheduled",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        ),
        Err(error) => state.diagnostics.record(
            "error",
            "system-notification",
            "delivery.failed",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "errorCode": diagnostics::error_code(error),
                "reason": error,
            }),
        ),
    }
    result
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
fn record_client_diagnostic(state: State<'_, AppState>, diagnostic: ClientDiagnostic) {
    let error_code = diagnostic.error_code.filter(|value| {
        matches!(
            value.as_str(),
            "no_rollout_found"
                | "timeout"
                | "connection_failed"
                | "permission_denied"
                | "request_failed"
                | "unhandled_error"
        )
    });
    state.diagnostics.record(
        &diagnostic.level,
        &diagnostic.area,
        &diagnostic.event,
        json!({
            "method": diagnostic.method,
            "threadId": diagnostic.thread_id,
            "errorCode": error_code,
            "durationMs": diagnostic.duration_ms,
            "attemptId": diagnostic.attempt_id,
            "stage": diagnostic.stage,
            "generatorThreadId": diagnostic.generator_thread_id,
            "trigger": diagnostic.trigger,
            "model": diagnostic.model,
            "effort": diagnostic.effort,
            "reason": diagnostic.reason,
            "sourceChars": diagnostic.source_chars,
            "generatedChars": diagnostic.generated_chars,
            "accepted": diagnostic.accepted,
            "status": diagnostic.status,
        }),
    );
}

#[tauri::command]
fn open_diagnostics_directory(state: State<'_, AppState>) -> Result<(), String> {
    state.diagnostics.reveal()
}

#[tauri::command]
fn runtime_versions() -> app_server::RuntimeVersions {
    app_server::runtime_versions()
}

#[tauri::command]
fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    state.store.list_workspaces()
}

#[tauri::command]
fn register_workspace(state: State<'_, AppState>, path: String) -> Result<Workspace, String> {
    let mut workspace = git_workspace::resolve_workspace(&path)?;
    let stored = state
        .store
        .upsert_workspace(&workspace.root, &workspace.name)?;
    workspace.created_at = stored.created_at;
    workspace.last_opened_at = stored.last_opened_at;
    Ok(workspace)
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
                .or_insert_with(|| git_workspace::resolve_workspace(&path).ok())
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
fn list_harness_files(
    cwd: String,
    fallback_filenames: Vec<String>,
    max_bytes: usize,
) -> Result<harness_files::HarnessFileTree, String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::list(&cwd, &codex_home, &fallback_filenames, max_bytes)
}

#[tauri::command]
fn read_harness_file(
    cwd: String,
    path: String,
    fallback_filenames: Vec<String>,
) -> Result<String, String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::read(&cwd, &codex_home, &path, &fallback_filenames)
}

#[tauri::command]
fn write_harness_file(
    cwd: String,
    path: String,
    content: String,
    fallback_filenames: Vec<String>,
) -> Result<(), String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::write(&cwd, &codex_home, &path, &content, &fallback_filenames)
}

#[tauri::command]
fn create_harness_directory(
    cwd: String,
    path: String,
    fallback_filenames: Vec<String>,
) -> Result<(), String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::create_directory(&cwd, &codex_home, &path, &fallback_filenames)
}

#[tauri::command]
fn rename_harness_path(
    cwd: String,
    path: String,
    next_path: String,
    fallback_filenames: Vec<String>,
) -> Result<(), String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::rename(&cwd, &codex_home, &path, &next_path, &fallback_filenames)
}

#[tauri::command]
fn remove_harness_path(
    cwd: String,
    path: String,
    fallback_filenames: Vec<String>,
) -> Result<(), String> {
    let codex_home = app_server::resolved_codex_home()?;
    harness_files::remove(&cwd, &codex_home, &path, &fallback_filenames)
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
    let diagnostics = Arc::new(DiagnosticLog::open().expect("无法初始化 Codex Harness 诊断日志"));
    diagnostics.record(
        "info",
        "runtime",
        "application.started",
        json!({ "harnessVersion": env!("CARGO_PKG_VERSION") }),
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            system_notification::install(app.handle());
            let manager = Arc::new(AppServerManager::new(
                app.handle().clone(),
                diagnostics.clone(),
            ));
            app.manage(AppState {
                app_server: manager,
                diagnostics,
                local_connector: LocalConnector::new(),
                codex_radar: CodexRadarClient::new(),
                store,
                workspace_cache: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_server_request,
            app_server_respond,
            record_client_diagnostic,
            open_diagnostics_directory,
            runtime_versions,
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
            list_harness_files,
            read_harness_file,
            write_harness_file,
            create_harness_directory,
            rename_harness_path,
            remove_harness_path,
            list_plugin_runs,
            upsert_plugin_run,
            local_connector_health,
            local_connector_list_messages,
            local_connector_send_message,
            codex_radar_model_table,
            run_quick_command,
            request_system_notification_permission,
            send_system_notification,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Codex Harness 时出错");
}
