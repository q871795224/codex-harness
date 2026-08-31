use crate::{
    app_server::{self, AppServerManager, RuntimeVersions},
    diagnostics::{error_code, DiagnosticLog},
    store::HarnessStore,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const UPDATE_STATE_KEY: &str = "codexUpdateState";
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/openai/codex/releases/latest";
const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedUpdateState {
    latest_version: Option<String>,
    last_checked_at: Option<i64>,
    skipped_version: Option<String>,
    last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUpdateStatus {
    pub current_version: Option<String>,
    pub app_server_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub skipped: bool,
    pub last_checked_at: Option<i64>,
    pub check_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

pub async fn status(
    store: &HarnessStore,
    diagnostics: &DiagnosticLog,
    force: bool,
) -> CodexUpdateStatus {
    let mut persisted = read_state(store, diagnostics);
    let versions = app_server::runtime_versions();
    let now = now_ms();
    let due = check_due(persisted.last_checked_at, now, force);
    let mut check_error = None;

    if due {
        let started = Instant::now();
        let (selected_path, resolved_path) = app_server::codex_binary_paths();
        diagnostics.record(
            "info",
            "codex-update",
            "check.started",
            json!({
                "force": force,
                "currentVersion": versions.codex_cli,
                "selectedCodexPath": selected_path,
                "resolvedCodexPath": resolved_path,
            }),
        );
        persisted.last_checked_at = Some(now);
        match fetch_latest_version().await {
            Ok(latest) => {
                apply_latest_version(&mut persisted, &latest);
                diagnostics.record(
                    "info",
                    "codex-update",
                    "check.completed",
                    json!({
                        "currentVersion": versions.codex_cli,
                        "latestVersion": latest,
                        "updateAvailable": update_available(versions.codex_cli.as_deref(), persisted.latest_version.as_deref()),
                        "durationMs": started.elapsed().as_millis() as u64,
                    }),
                );
            }
            Err(error) => {
                let code = error_code(&error).to_string();
                persisted.last_error_code = Some(code.clone());
                check_error = Some(error);
                diagnostics.record(
                    "error",
                    "codex-update",
                    "check.failed",
                    json!({
                        "currentVersion": versions.codex_cli,
                        "errorCode": code,
                        "durationMs": started.elapsed().as_millis() as u64,
                    }),
                );
            }
        }
        write_state(store, diagnostics, &persisted);
    } else {
        diagnostics.record(
            "info",
            "codex-update",
            "check.deferred",
            json!({
                "reason": "daily-interval",
                "lastCheckedAt": persisted.last_checked_at,
                "currentVersion": versions.codex_cli,
            }),
        );
    }

    make_status(&versions, &persisted, check_error)
}

pub fn skip_version(
    store: &HarnessStore,
    diagnostics: &DiagnosticLog,
    version: &str,
) -> Result<CodexUpdateStatus, String> {
    Version::parse(version).map_err(|_| "无法跳过无效的 Codex 版本号。".to_string())?;
    let mut persisted = read_state(store, diagnostics);
    if persisted.latest_version.as_deref() != Some(version) {
        return Err("Codex 最新版本已变化，请重新检查更新。".to_string());
    }
    persisted.skipped_version = Some(version.to_string());
    persisted.last_error_code = None;
    store.set_app_state(UPDATE_STATE_KEY, &serialize_state(&persisted)?)?;
    diagnostics.record(
        "info",
        "codex-update",
        "decision.skipped_version",
        json!({ "version": version }),
    );
    Ok(make_status(
        &app_server::runtime_versions(),
        &persisted,
        None,
    ))
}

pub async fn install(
    store: &HarnessStore,
    diagnostics: Arc<DiagnosticLog>,
    app_server: Arc<AppServerManager>,
) -> Result<CodexUpdateStatus, String> {
    let mut persisted = read_state(store, &diagnostics);
    let before = app_server::runtime_versions();
    let target = persisted
        .latest_version
        .clone()
        .filter(|latest| update_available(before.codex_cli.as_deref(), Some(latest)))
        .ok_or_else(|| "当前没有可安装的 Codex 更新。".to_string())?;
    let (selected_path, resolved_path) = app_server::codex_binary_paths();
    let operation_started = Instant::now();
    diagnostics.record(
        "info",
        "codex-update",
        "install.started",
        json!({
            "currentVersion": before.codex_cli,
            "targetVersion": target,
            "selectedCodexPath": selected_path,
            "resolvedCodexPath": resolved_path,
        }),
    );

    let update_started = Instant::now();
    diagnostics.record(
        "info",
        "codex-update",
        "install.cli.started",
        json!({ "targetVersion": target }),
    );
    let summary = tauri::async_runtime::spawn_blocking(app_server::update_codex_cli)
        .await
        .map_err(|error| {
            install_error(
                &diagnostics,
                "cli-update-task",
                &target,
                format!("等待 Codex CLI 更新任务失败: {error}"),
            )
        })?
        .map_err(|error| install_error(&diagnostics, "cli-update", &target, error))?;
    diagnostics.record(
        "info",
        "codex-update",
        "install.cli.completed",
        json!({
            "targetVersion": target,
            "durationMs": update_started.elapsed().as_millis() as u64,
            "exitCode": summary.exit_code,
            "stdoutBytes": summary.stdout_bytes,
            "stderrBytes": summary.stderr_bytes,
        }),
    );

    let installed = app_server::runtime_versions().codex_cli;
    if !version_at_least(installed.as_deref(), &target) {
        return Err(install_error(
            &diagnostics,
            "cli-verify",
            &target,
            format!(
                "Codex CLI 更新后版本校验失败（实际版本：{}）。",
                installed.as_deref().unwrap_or("未知")
            ),
        ));
    }
    diagnostics.record(
        "info",
        "codex-update",
        "install.daemon_restart.started",
        json!({ "installedVersion": installed, "targetVersion": target }),
    );
    let restart_started = Instant::now();
    app_server
        .restart_after_update()
        .await
        .map_err(|error| install_error(&diagnostics, "daemon-restart", &target, error))?;
    let after = app_server::runtime_versions();
    if !version_at_least(after.app_server.as_deref(), &target) {
        return Err(install_error(
            &diagnostics,
            "daemon-verify",
            &target,
            format!(
                "App Server 重启后版本校验失败（实际版本：{}）。",
                after.app_server.as_deref().unwrap_or("未知")
            ),
        ));
    }
    diagnostics.record(
        "info",
        "codex-update",
        "install.daemon_restart.completed",
        json!({
            "targetVersion": target,
            "cliVersion": after.codex_cli,
            "appServerVersion": after.app_server,
            "durationMs": restart_started.elapsed().as_millis() as u64,
        }),
    );

    persisted.latest_version = after.codex_cli.clone();
    persisted.last_checked_at = Some(now_ms());
    persisted.skipped_version = None;
    persisted.last_error_code = None;
    let serialized = serialize_state(&persisted)
        .map_err(|error| install_error(&diagnostics, "state-serialize", &target, error))?;
    store
        .set_app_state(UPDATE_STATE_KEY, &serialized)
        .map_err(|error| install_error(&diagnostics, "state-persist", &target, error))?;
    diagnostics.record(
        "info",
        "codex-update",
        "install.completed",
        json!({
            "targetVersion": target,
            "cliVersion": after.codex_cli,
            "appServerVersion": after.app_server,
            "durationMs": operation_started.elapsed().as_millis() as u64,
        }),
    );
    Ok(make_status(&after, &persisted, None))
}

async fn fetch_latest_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("codex-harness/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法创建 Codex 更新检查客户端: {error}"))?;
    let response = client
        .get(LATEST_RELEASE_URL)
        .send()
        .await
        .map_err(|error| format!("无法检查 Codex 更新: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Codex 更新服务返回异常状态: {error}"))?;
    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|error| format!("无法解析 Codex 最新版本: {error}"))?;
    release_version(&release)
}

fn release_version(release: &GithubRelease) -> Result<String, String> {
    if release.draft || release.prerelease {
        return Err("Codex 最新 release 不是稳定版本。".to_string());
    }
    let version = release
        .tag_name
        .strip_prefix("rust-v")
        .unwrap_or(&release.tag_name);
    Version::parse(version)
        .map(|version| version.to_string())
        .map_err(|_| format!("Codex release tag 不是有效版本号: {}", release.tag_name))
}

fn make_status(
    versions: &RuntimeVersions,
    persisted: &PersistedUpdateState,
    check_error: Option<String>,
) -> CodexUpdateStatus {
    let available = update_available(
        versions.codex_cli.as_deref(),
        persisted.latest_version.as_deref(),
    );
    CodexUpdateStatus {
        current_version: versions.codex_cli.clone(),
        app_server_version: versions.app_server.clone(),
        latest_version: persisted.latest_version.clone(),
        update_available: available,
        skipped: available && persisted.skipped_version == persisted.latest_version,
        last_checked_at: persisted.last_checked_at,
        check_error,
    }
}

fn update_available(current: Option<&str>, latest: Option<&str>) -> bool {
    let (Some(current), Some(latest)) = (current, latest) else {
        return false;
    };
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => false,
    }
}

fn check_due(last_checked_at: Option<i64>, now: i64, force: bool) -> bool {
    force
        || last_checked_at
            .map(|checked| now.saturating_sub(checked) >= CHECK_INTERVAL_MS)
            .unwrap_or(true)
}

fn apply_latest_version(state: &mut PersistedUpdateState, latest: &str) {
    if state
        .skipped_version
        .as_deref()
        .is_some_and(|version| version != latest)
    {
        state.skipped_version = None;
    }
    state.latest_version = Some(latest.to_string());
    state.last_error_code = None;
}

fn version_at_least(actual: Option<&str>, target: &str) -> bool {
    match (
        actual.and_then(|value| Version::parse(value).ok()),
        Version::parse(target),
    ) {
        (Some(actual), Ok(target)) => actual >= target,
        _ => false,
    }
}

fn read_state(store: &HarnessStore, diagnostics: &DiagnosticLog) -> PersistedUpdateState {
    let raw = match store.get_app_state(UPDATE_STATE_KEY) {
        Ok(value) => value,
        Err(error) => {
            diagnostics.record(
                "error",
                "codex-update",
                "state.read_failed",
                json!({ "errorCode": error_code(&error) }),
            );
            return PersistedUpdateState::default();
        }
    };
    match raw {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
            diagnostics.record(
                "error",
                "codex-update",
                "state.invalid",
                json!({ "errorCode": error_code(&error.to_string()) }),
            );
            PersistedUpdateState::default()
        }),
        None => PersistedUpdateState::default(),
    }
}

fn write_state(store: &HarnessStore, diagnostics: &DiagnosticLog, state: &PersistedUpdateState) {
    let result =
        serialize_state(state).and_then(|value| store.set_app_state(UPDATE_STATE_KEY, &value));
    if let Err(error) = result {
        diagnostics.record(
            "error",
            "codex-update",
            "state.write_failed",
            json!({ "errorCode": error_code(&error) }),
        );
    }
}

fn serialize_state(state: &PersistedUpdateState) -> Result<String, String> {
    serde_json::to_string(state).map_err(|error| format!("无法序列化 Codex 更新状态: {error}"))
}

fn install_error(diagnostics: &DiagnosticLog, stage: &str, target: &str, error: String) -> String {
    diagnostics.record(
        "error",
        "codex-update",
        "install.failed",
        json!({ "stage": stage, "targetVersion": target, "errorCode": error_code(&error) }),
    );
    error
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

    #[test]
    fn compares_semantic_versions_without_treating_equal_as_update() {
        assert!(update_available(Some("0.150.1"), Some("0.151.0")));
        assert!(!update_available(Some("0.151.0"), Some("0.151.0")));
        assert!(!update_available(Some("0.152.0"), Some("0.151.0")));
        assert!(!update_available(None, Some("0.151.0")));
    }

    #[test]
    fn checks_at_most_once_per_day_unless_forced() {
        assert!(check_due(None, 100, false));
        assert!(!check_due(Some(100), 100 + CHECK_INTERVAL_MS - 1, false));
        assert!(check_due(Some(100), 100 + CHECK_INTERVAL_MS, false));
        assert!(check_due(Some(100), 101, true));
    }

    #[test]
    fn skipped_version_becomes_visible_when_a_new_release_arrives() {
        let mut state = PersistedUpdateState {
            latest_version: Some("0.151.0".to_string()),
            skipped_version: Some("0.151.0".to_string()),
            ..PersistedUpdateState::default()
        };
        apply_latest_version(&mut state, "0.152.0");
        assert_eq!(state.latest_version.as_deref(), Some("0.152.0"));
        assert_eq!(state.skipped_version, None);
    }

    #[test]
    fn parses_stable_codex_release_tags() {
        let release = GithubRelease {
            tag_name: "rust-v0.151.0".to_string(),
            draft: false,
            prerelease: false,
        };
        assert_eq!(release_version(&release).unwrap(), "0.151.0");
    }

    #[test]
    fn rejects_prerelease_from_stable_channel() {
        let release = GithubRelease {
            tag_name: "rust-v0.152.0-alpha.1".to_string(),
            draft: false,
            prerelease: true,
        };
        assert!(release_version(&release).is_err());
    }
}
