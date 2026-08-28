use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationInput {
    thread_id: String,
    turn_id: String,
    title: String,
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
#[allow(deprecated)]
mod macos {
    use super::{
        notification_identifier, parse_notification_identifier, SystemNotificationClick,
        SystemNotificationInput,
    };
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{
        NSObject, NSObjectProtocol, NSString, NSUserNotification, NSUserNotificationCenter,
        NSUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and this delegate has no Drop implementation.
        #[unsafe(super = NSObject)]
        #[name = "CodexHarnessNotificationDelegate"]
        struct NotificationDelegate;

        // SAFETY: NSObjectProtocol has no additional safety requirements.
        unsafe impl NSObjectProtocol for NotificationDelegate {}

        // SAFETY: The method signatures match NSUserNotificationCenterDelegate.
        unsafe impl NSUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                _center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                let identifier = notification.identifier().map(|value| value.to_string());
                if let (Some(target), Some(app)) = (
                    identifier
                        .as_deref()
                        .and_then(parse_notification_identifier),
                    APP_HANDLE.get(),
                ) {
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
            }

            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
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
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        let delegate = NotificationDelegate::new();
        // SAFETY: The delegate is leaked below and therefore outlives the notification center.
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        std::mem::forget(delegate);
    }

    pub async fn request_permission() -> Result<bool, String> {
        if tauri::is_dev() {
            return Err("macOS 系统通知只能在打包后的 App 中启用".to_string());
        }
        Ok(true)
    }

    pub async fn send(input: SystemNotificationInput) -> Result<(), String> {
        if tauri::is_dev() {
            return Err("macOS 系统通知只能在打包后的 App 中启用".to_string());
        }
        let notification = NSUserNotification::init(NSUserNotification::alloc());
        notification.setTitle(Some(&NSString::from_str(&input.title)));
        notification.setIdentifier(Some(&NSString::from_str(&notification_identifier(&input)?)));
        NSUserNotificationCenter::defaultUserNotificationCenter()
            .deliverNotification(&notification);
        Ok(())
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
