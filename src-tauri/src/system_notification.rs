use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationInput {
    thread_id: String,
    turn_id: String,
    title: String,
}

impl SystemNotificationInput {
    pub(crate) fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub(crate) fn turn_id(&self) -> &str {
        &self.turn_id
    }
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationTarget {
    thread_id: String,
    turn_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemNotificationClick {
    thread_id: String,
}

fn notification_identifier(input: &SystemNotificationInput) -> Result<String, String> {
    serde_json::to_string(&NotificationTarget {
        thread_id: input.thread_id.clone(),
        turn_id: input.turn_id.clone(),
    })
    .map_err(|error| format!("无法编码通知目标: {error}"))
}

fn parse_notification_identifier(identifier: &str) -> Option<NotificationTarget> {
    serde_json::from_str(identifier).ok()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        notification_identifier, parse_notification_identifier, SystemNotificationClick,
        SystemNotificationInput,
    };
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::{Emitter, Manager};

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and this delegate has no Drop implementation.
        #[unsafe(super = NSObject)]
        #[name = "CodexHarnessNotificationDelegate"]
        struct NotificationDelegate;

        // SAFETY: NSObjectProtocol has no additional safety requirements.
        unsafe impl NSObjectProtocol for NotificationDelegate {}

        // SAFETY: The method signatures match UNUserNotificationCenterDelegate.
        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                #[allow(deprecated)]
                completion_handler.call((UNNotificationPresentationOptions::Alert
                    | UNNotificationPresentationOptions::List,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let identifier = response.notification().request().identifier().to_string();
                if let (Some(target), Some(app)) =
                    (parse_notification_identifier(&identifier), APP_HANDLE.get())
                {
                    let _ = app.show();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit(
                        "system-notification:clicked",
                        SystemNotificationClick {
                            thread_id: target.thread_id,
                        },
                    );
                }
                completion_handler.call(());
            }
        }
    );

    impl NotificationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: The signature of NSObject's init method is correct.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn install(app: &tauri::AppHandle) {
        if tauri::is_dev() {
            return;
        }
        let _ = APP_HANDLE.set(app.clone());
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = NotificationDelegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // UNUserNotificationCenter.delegate is weak. The delegate must live for the process lifetime.
        std::mem::forget(delegate);
    }

    pub async fn request_permission() -> Result<bool, String> {
        if tauri::is_dev() {
            return Err("macOS 系统通知只能在打包后的 App 中启用".to_string());
        }
        let receiver = {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let block: RcBlock<dyn Fn(Bool, *mut NSError)> =
                RcBlock::new(move |granted: Bool, error: *mut NSError| {
                    let result = if error.is_null() {
                        Ok(granted.as_bool())
                    } else {
                        // SAFETY: NSError is valid for the duration of this completion callback.
                        let message = unsafe { error.as_ref() }
                            .map(|error| error.localizedDescription().to_string())
                            .unwrap_or_else(|| "未知错误".to_string());
                        Err(format!("无法申请 macOS 通知权限: {message}"))
                    };
                    if let Some(sender) = sender
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take()
                    {
                        let _ = sender.send(result);
                    }
                });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &block,
            );
            receiver
        };
        receiver
            .await
            .map_err(|_| "macOS 通知权限请求未返回结果".to_string())?
    }

    pub async fn send(input: SystemNotificationInput) -> Result<(), String> {
        if tauri::is_dev() {
            return Err("macOS 系统通知只能在打包后的 App 中启用".to_string());
        }
        let receiver = {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&input.title));
            content.setThreadIdentifier(&NSString::from_str(&input.thread_id));
            let identifier = NSString::from_str(&notification_identifier(&input)?);
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &identifier,
                &content,
                None,
            );

            let (sender, receiver) = tokio::sync::oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let block: RcBlock<dyn Fn(*mut NSError)> = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    // SAFETY: NSError is valid for the duration of this completion callback.
                    let message = unsafe { error.as_ref() }
                        .map(|error| error.localizedDescription().to_string())
                        .unwrap_or_else(|| "未知错误".to_string());
                    Err(format!("无法发送 macOS 通知: {message}"))
                };
                if let Some(sender) = sender
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    let _ = sender.send(result);
                }
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
            receiver
        };
        receiver
            .await
            .map_err(|_| "macOS 通知发送请求未返回结果".to_string())?
    }
}

#[cfg(target_os = "macos")]
pub use macos::{install, request_permission, send};

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub async fn request_permission() -> Result<bool, String> {
    Err("系统通知插件目前只支持 macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn send(_input: SystemNotificationInput) -> Result<(), String> {
    Err("系统通知插件目前只支持 macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_identifier_preserves_the_thread_target() {
        let input = SystemNotificationInput {
            thread_id: "thread:with/slashes".to_string(),
            turn_id: "turn-1".to_string(),
            title: "完成通知".to_string(),
        };

        let identifier = notification_identifier(&input).expect("encodes notification target");

        assert_eq!(
            parse_notification_identifier(&identifier),
            Some(NotificationTarget {
                thread_id: input.thread_id,
                turn_id: input.turn_id,
            })
        );
    }
}
