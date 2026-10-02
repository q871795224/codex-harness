use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{git_workspace, store};

const EXPECTED_REMOTE: &str = "github.com/q871795224/codex-harness";
const RUNNER_SOURCE: &str =
    include_str!("../../.agents/skills/harness-release/scripts/release_runner.py");
const JEWELL_RUNNER_SOURCE: &str =
    include_str!("../../.agents/skills/harness-release/scripts/jewell_release_runner.py");
const JEWELL_REMOTE: &str = "github.com/q871795224/jewell";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReleaseProject {
    CodexHarness,
    Jewell,
}

impl ReleaseProject {
    fn remote(self) -> &'static str {
        match self {
            Self::CodexHarness => EXPECTED_REMOTE,
            Self::Jewell => JEWELL_REMOTE,
        }
    }

    fn branch(self) -> &'static str {
        match self {
            Self::CodexHarness => "main",
            Self::Jewell => "master",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::CodexHarness => "codex-harness",
            Self::Jewell => "jewell",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::CodexHarness => "Codex Harness",
            Self::Jewell => "Jewell",
        }
    }

    fn runner_source(self) -> &'static str {
        match self {
            Self::CodexHarness => RUNNER_SOURCE,
            Self::Jewell => JEWELL_RUNNER_SOURCE,
        }
    }
}

struct ReleaseWorkspace {
    workspace: store::Workspace,
    project: ReleaseProject,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    pub run_id: String,
    pub workspace_root: String,
    pub version: String,
    pub status: String,
    pub phase: String,
    pub error: Option<String>,
    #[serde(default)]
    pub warning: bool,
    pub pid: u32,
    pub started_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub phase_durations: HashMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_duration_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCommandInfo {
    pub supported: bool,
    pub project: Option<String>,
    pub current_version: Option<String>,
    pub installed_version: Option<String>,
    pub versions: Vec<String>,
    pub origin_main_sha: Option<String>,
    pub status: Option<ReleaseStatus>,
}

pub fn info(path: &str, refresh: bool) -> Result<ReleaseCommandInfo, String> {
    let Some(release_workspace) = release_workspace(path)? else {
        return Ok(ReleaseCommandInfo {
            supported: false,
            project: None,
            current_version: None,
            installed_version: None,
            versions: Vec::new(),
            origin_main_sha: None,
            status: None,
        });
    };
    let workspace = &release_workspace.workspace;
    let project = release_workspace.project;
    let status = read_status(&workspace.root)?;
    if refresh
        && status
            .as_ref()
            .map_or(true, |item| item.status != "running")
    {
        git(
            &workspace.checkout_root,
            ["fetch", "origin", "--prune", "--tags"],
        )?;
    }
    let current_version = origin_branch_version(&workspace.checkout_root, project.branch())?;
    let origin_main_sha = origin_branch_sha(&workspace.checkout_root, project.branch())?;
    let installed_version = (project == ReleaseProject::CodexHarness)
        .then(installed_app_version)
        .flatten();
    let version_base = if project == ReleaseProject::CodexHarness {
        release_base_version(&current_version)
    } else {
        current_version.clone()
    };
    let mut versions = next_versions(&version_base)?;
    if project == ReleaseProject::Jewell
        && can_resume_jewell_release(status.as_ref(), &current_version)
        && remote_tag_exists(&workspace.checkout_root, &current_version)?
    {
        versions.insert(0, current_version.clone());
    }
    Ok(ReleaseCommandInfo {
        supported: true,
        project: Some(project.key().to_string()),
        current_version: Some(current_version),
        installed_version,
        versions,
        origin_main_sha: Some(origin_main_sha),
        status,
    })
}

pub fn status(workspace_root: &str) -> Result<Option<ReleaseStatus>, String> {
    // The frontend polls with the canonical root returned by `info`. Avoid
    // re-running Git workspace and remote validation once per second.
    read_status(workspace_root)
}

pub fn start(path: &str, version: &str, base_sha: Option<&str>) -> Result<ReleaseStatus, String> {
    let Some(release_workspace) = release_workspace(path)? else {
        return Err("发布命令只适用于 Codex Harness 或 Jewell 工作区".to_string());
    };
    let workspace = release_workspace.workspace;
    let project = release_workspace.project;
    let previous_status = read_status(&workspace.root)?;
    if let Some(current) = previous_status.as_ref() {
        if current.status == "running" {
            return Err(format!("{} {} 正在发布", project.label(), current.version));
        }
    }

    let current_version = origin_branch_version(&workspace.checkout_root, project.branch())?;
    let current_sha = origin_branch_sha(&workspace.checkout_root, project.branch())?;
    if let Some(expected_sha) = base_sha {
        if expected_sha != current_sha {
            return Err(format!(
                "版本列表对应的 origin/{} 已更新，请重新打开发布菜单",
                project.branch()
            ));
        }
    }
    let release_base_sha = base_sha.unwrap_or(current_sha.as_str());
    let version_base = if project == ReleaseProject::CodexHarness {
        release_base_version(&current_version)
    } else {
        current_version.clone()
    };
    let resume = project == ReleaseProject::Jewell
        && can_resume_jewell_release(previous_status.as_ref(), &current_version)
        && version == current_version
        && remote_tag_exists(&workspace.checkout_root, version)?;
    let version_is_allowed = next_versions(&version_base)?
        .iter()
        .any(|item| item == version);
    if !resume && !version_is_allowed {
        return Err(format!("{version} 不是 {current_version} 的可选发布版本"));
    }

    let data_dir = release_data_dir(&workspace.root)?;
    fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建发布任务目录: {error}"))?;
    let run_id = format!("{}-{}", now_ms(), std::process::id());
    let worktree = data_dir.join("worktrees").join(&run_id);
    fs::create_dir_all(worktree.parent().expect("worktree parent"))
        .map_err(|error| format!("无法创建发布 worktree 目录: {error}"))?;
    let state_path = data_dir.join("current.json");
    let log_path = data_dir.join(format!("{run_id}.log"));
    let runner_path = data_dir.join("release_runner.py");
    write_atomic(&runner_path, project.runner_source().as_bytes())?;

    let initial = ReleaseStatus {
        run_id: run_id.clone(),
        workspace_root: workspace.root.clone(),
        version: version.to_string(),
        status: "running".to_string(),
        phase: "starting".to_string(),
        error: None,
        warning: false,
        pid: 0,
        started_at: now_ms(),
        updated_at: now_ms(),
        completed_at: None,
        dismissed: false,
        log_path: Some(log_path.to_string_lossy().into_owned()),
        base_sha: Some(release_base_sha.to_owned()),
        phase_started_at: None,
        phase_duration_ms: None,
        phase_durations: HashMap::new(),
        step: None,
        step_started_at: None,
        step_duration_ms: None,
    };
    write_status(&state_path, &initial)?;

    let stdout = File::create(&log_path).map_err(|error| format!("无法创建发布日志: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("无法打开发布错误日志: {error}"))?;
    let mut command = Command::new("python3");
    command
        .arg(&runner_path)
        .args(["--workspace", &workspace.checkout_root])
        .arg("--worktree")
        .arg(&worktree)
        .arg("--state")
        .arg(&state_path)
        .args([
            "--run-id",
            &run_id,
            "--version",
            version,
            "--base-sha",
            release_base_sha,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if resume {
        command.arg("--resume");
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut failed = initial.clone();
            failed.status = "failed".to_string();
            failed.error = Some(format!("无法启动发布任务: {error}"));
            failed.completed_at = Some(now_ms());
            failed.updated_at = now_ms();
            write_status(&state_path, &failed)?;
            return Err(failed.error.unwrap_or_default());
        }
    };
    let workspace_root = workspace.root.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        // Reap the detached runner while Harness is still alive. If it exited
        // before writing a terminal state, the next read converts it to failed.
        let _ = read_status(&workspace_root);
    });
    Ok(initial)
}

pub fn dismiss(path: &str) -> Result<Option<ReleaseStatus>, String> {
    let Some(release_workspace) = release_workspace(path)? else {
        return Ok(None);
    };
    let workspace = release_workspace.workspace;
    let state_path = release_data_dir(&workspace.root)?.join("current.json");
    let Some(mut current) = read_status(&workspace.root)? else {
        return Ok(None);
    };
    current.dismissed = true;
    current.updated_at = now_ms();
    write_status(&state_path, &current)?;
    Ok(Some(current))
}

fn historical_log_path(directory: &Path, run_id: &str) -> Result<PathBuf, String> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        return Err("发布任务编号无效".to_string());
    }
    Ok(directory.join(format!("{run_id}.log")))
}

pub fn open_log(path: &str, run_id: Option<&str>) -> Result<(), String> {
    let Some(release_workspace) = release_workspace(path)? else {
        return Err("发布命令只适用于 Codex Harness 或 Jewell 工作区".to_string());
    };
    let workspace = release_workspace.workspace;
    let expected = release_data_dir(&workspace.root)?;
    let log_path = if let Some(run_id) = run_id {
        historical_log_path(&expected, run_id)?
    } else {
        let status = read_status(&workspace.root)?.ok_or_else(|| "没有发布记录".to_string())?;
        PathBuf::from(
            status
                .log_path
                .ok_or_else(|| "发布日志不存在".to_string())?,
        )
    };
    if !log_path.starts_with(&expected) || !log_path.is_file() {
        return Err("发布日志路径无效".to_string());
    }
    let output = Command::new("open")
        .arg(&log_path)
        .output()
        .map_err(|error| format!("无法打开发布日志: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn release_workspace(path: &str) -> Result<Option<ReleaseWorkspace>, String> {
    let workspace = match git_workspace::resolve_workspace(path) {
        Ok(workspace) => workspace,
        Err(_) => return Ok(None),
    };
    let remote = match git(&workspace.checkout_root, ["remote", "get-url", "origin"]) {
        Ok(remote) => remote,
        Err(_) => return Ok(None),
    };
    let remote = normalized_remote(&remote);
    let project = [ReleaseProject::CodexHarness, ReleaseProject::Jewell]
        .into_iter()
        .find(|project| remote == project.remote());
    Ok(project.map(|project| ReleaseWorkspace { workspace, project }))
}

fn normalized_remote(remote: &str) -> String {
    let value = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let value = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .or_else(|| value.strip_prefix("ssh://git@"))
        .or_else(|| value.strip_prefix("git@"))
        .unwrap_or(value);
    value.replacen(':', "/", 1)
}

fn origin_branch_version(cwd: &str, branch: &str) -> Result<String, String> {
    let reference = format!("origin/{branch}:package.json");
    let raw = git(cwd, ["show", reference.as_str()])?;
    let package: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("origin/{branch} package.json 无效: {error}"))?;
    package
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("origin/{branch} package.json 缺少 version"))
}

fn origin_branch_sha(cwd: &str, branch: &str) -> Result<String, String> {
    let reference = format!("origin/{branch}");
    git(cwd, ["rev-parse", reference.as_str()])
}

fn remote_tag_exists(cwd: &str, version: &str) -> Result<bool, String> {
    let tag = format!("refs/tags/v{version}");
    Ok(!git(cwd, ["ls-remote", "--tags", "origin", tag.as_str()])?.is_empty())
}

fn can_resume_jewell_release(status: Option<&ReleaseStatus>, current_version: &str) -> bool {
    status.is_some_and(|status| {
        status.status == "failed"
            && status.version == current_version
            && matches!(status.phase.as_str(), "submitting" | "publishing")
    })
}

fn installed_app_version() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let plist = home.join("Applications/Codex Harness.app/Contents/Info.plist");
    if !plist.is_file() {
        return None;
    }
    let output = Command::new("defaults")
        .arg("read")
        .arg(&plist)
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Version::parse(&version).ok().map(|_| version)
}

fn release_base_version(current_version: &str) -> String {
    installed_app_version()
        .filter(|installed| installed_version_is_older(installed, current_version))
        .unwrap_or_else(|| current_version.to_string())
}

fn installed_version_is_older(installed: &str, current: &str) -> bool {
    match (Version::parse(installed), Version::parse(current)) {
        (Ok(installed), Ok(current)) => installed < current,
        _ => false,
    }
}

fn next_versions(current: &str) -> Result<Vec<String>, String> {
    let version = Version::parse(current).map_err(|error| format!("当前版本无效: {error}"))?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("当前版本不是稳定 SemVer".to_string());
    }
    let mut patch = version.clone();
    patch.patch += 1;
    let mut minor = version;
    minor.minor += 1;
    minor.patch = 0;
    Ok(vec![patch.to_string(), minor.to_string()])
}

fn read_status(workspace_root: &str) -> Result<Option<ReleaseStatus>, String> {
    let data_dir = release_data_dir(workspace_root)?;
    let path = data_dir.join("current.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("无法读取发布状态: {error}"))?;
    let mut status: ReleaseStatus =
        serde_json::from_str(&raw).map_err(|error| format!("发布状态无效: {error}"))?;
    status.log_path = Some(
        data_dir
            .join(format!("{}.log", status.run_id))
            .to_string_lossy()
            .into_owned(),
    );
    let missing_process = status.pid != 0 && !process_alive(status.pid);
    let never_started = status.pid == 0 && now_ms().saturating_sub(status.updated_at) > 5_000;
    if status.status == "running" && (missing_process || never_started) {
        status.status = "failed".to_string();
        status.error = Some("发布进程意外退出，请查看日志".to_string());
        status.completed_at = Some(now_ms());
        status.updated_at = now_ms();
        write_status(&path, &status)?;
    }
    Ok(Some(status))
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn release_data_dir(workspace_root: &str) -> Result<PathBuf, String> {
    let hash = workspace_root
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    Ok(store::harness_data_dir()?
        .join("release-runs")
        .join(format!("{hash:016x}")))
}

fn write_status(path: &Path, status: &ReleaseStatus) -> Result<(), String> {
    let raw =
        serde_json::to_vec_pretty(status).map_err(|error| format!("无法编码发布状态: {error}"))?;
    write_atomic(path, &raw)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)
        .map_err(|error| format!("无法写入 {}: {error}", temporary.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("无法写入 {}: {error}", temporary.display()))?;
    file.sync_all()
        .map_err(|error| format!("无法同步 {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法更新 {}: {error}", path.display()))
}

fn git<const N: usize>(cwd: &str, args: [&str; N]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("无法运行 Git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("Git 输出不是有效 UTF-8: {error}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_codex_harness_remote() {
        assert_eq!(
            normalized_remote("git@github.com:q871795224/codex-harness.git"),
            EXPECTED_REMOTE
        );
        assert_eq!(
            normalized_remote("https://github.com/q871795224/codex-harness.git"),
            EXPECTED_REMOTE
        );
        assert_ne!(
            normalized_remote("https://github.com/example/another-project.git"),
            EXPECTED_REMOTE
        );
    }

    #[test]
    fn offers_patch_and_minor_versions_as_numbers() {
        assert_eq!(next_versions("0.7.6").unwrap(), ["0.7.7", "0.8.0"]);
    }

    #[test]
    fn installed_version_comparison_detects_older_builds() {
        assert!(installed_version_is_older("0.8.6", "0.8.7"));
        assert!(!installed_version_is_older("0.8.7", "0.8.7"));
        assert!(!installed_version_is_older("0.8.8", "0.8.7"));
        assert!(!installed_version_is_older("invalid", "0.8.7"));
    }
}

#[cfg(test)]
mod notification_log_tests {
    use super::*;

    #[test]
    fn historical_logs_are_bound_to_the_requested_run() {
        let directory = std::env::temp_dir().join("harness-notification-test");
        assert_eq!(
            historical_log_path(&directory, "123-456").unwrap(),
            directory.join("123-456.log")
        );
        for invalid in ["", "../123", "/tmp/123", "abc", "123/456"] {
            assert!(historical_log_path(&directory, invalid).is_err());
        }
    }
}
