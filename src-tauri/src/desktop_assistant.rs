use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

pub(crate) const LABEL: &str = "desktop-assistant";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(75);
type Reply = Result<Value, String>;

#[derive(Default)]
pub(crate) struct DesktopAssistant {
    sequence: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    State,
    Create,
    Send,
    Stop,
    RemoveQueue,
    PromoteQueue,
    StartQueue,
    Settings,
    FollowUp,
    Query,
    Mutate,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    action: Action,
    args: Value,
}

pub(crate) fn allows_command(command: &str) -> bool {
    matches!(
        command,
        "desktop_assistant_request"
            | "desktop_assistant_hide"
            | "paste_composer_image"
            | "validate_composer_image"
    )
}

pub(crate) fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

pub(crate) fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?desktop-assistant".into()),
    )
    .title("Harness 助理")
    .inner_size(560., 660.)
    .min_inner_size(400., 420.)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn desktop_assistant_hide(window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("无权隐藏桌面助理。".into());
    }
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn desktop_assistant_request(
    window: WebviewWindow,
    app: AppHandle,
    relay: State<'_, DesktopAssistant>,
    action: Action,
    args: Value,
) -> Result<Value, String> {
    if window.label() != LABEL {
        return Err("无权调用桌面助理。".into());
    }
    let id = relay.sequence.fetch_add(1, Ordering::Relaxed).to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = relay.pending.lock().map_err(|error| error.to_string())?;
        if pending.len() >= 16 {
            return Err("助理请求过多，请稍后重试。".into());
        }
        pending.insert(id.clone(), sender);
    }
    let emitted = app.emit_to(
        "main",
        "desktop-assistant:request",
        Request {
            id: id.clone(),
            action,
            args,
        },
    );
    let result = match emitted {
        Ok(()) => match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(reply)) => reply,
            _ => Err("助理未收到主窗口回应，请先核对结果。".into()),
        },
        Err(error) => Err(error.to_string()),
    };
    if let Ok(mut pending) = relay.pending.lock() {
        pending.remove(&id);
    }
    result
}

#[tauri::command]
pub(crate) fn desktop_assistant_reply(
    window: WebviewWindow,
    relay: State<'_, DesktopAssistant>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("无权回复桌面助理。".into());
    }
    let sender = relay
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(match error {
            Some(error) => Err(error),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_assistant_state(
    window: WebviewWindow,
    app: AppHandle,
    snapshot: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("无权发布桌面助理状态。".into());
    }
    if app.get_webview_window(LABEL).is_none() {
        return Ok(());
    }
    app.emit_to(LABEL, "desktop-assistant:state", snapshot)
        .map_err(|error| error.to_string())
}
