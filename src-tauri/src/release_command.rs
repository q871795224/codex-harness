use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    pub run_id: String,
    pub workspace_root: String,
    pub version: String,
    pub status: String,
    pub phase: String,
    pub error: Option<String>,
    pub pid: u32,
    pub started_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCommandInfo {
    pub supported: bool,
    pub current_version: Option<String>,
    pub versions: Vec<String>,
    pub status: Option<ReleaseStatus>,
}

pub fn info(path: &str, refresh: bool) -> Result<ReleaseCommandInfo, String> {
    let Some(workspace) = harness_workspace(path)? else {
        return Ok(ReleaseCommandInfo {
            supported: false,
            current_version: None,
            versions: Vec::new(),
            status: None,
        });
    };
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
    let current_version = origin_main_version(&workspace.checkout_root)?;
    let versions = next_versions(&current_version)?;
    Ok(ReleaseCommandInfo {
        supported: true,
        current_version: Some(current_version),
        versions,
        status,
    })
}

pub fn status(path: &str) -> Result<Option<ReleaseStatus>, String> {
    let Some(workspace) = harness_workspace(path)? else {
        return Ok(None);
    };
    read_status(&workspace.root)
}

pub fn start(path: &str, version: &str) -> Result<ReleaseStatus, String> {
    let Some(workspace) = harness_workspace(path)? else {
        return Err("发布命令只适用于 Codex Harness 工作区".to_string());
    };
    if let Some(current) = read_status(&workspace.root)? {
        if current.status == "running" {
            return Err(format!("Codex Harness {} 正在发布", current.version));
        }
    }

    git(
        &workspace.checkout_root,
        ["fetch", "origin", "--prune", "--tags"],
    )?;
    let current_version = origin_main_version(&workspace.checkout_root)?;
    if !next_versions(&current_version)?
        .iter()
        .any(|item| item == version)
    {
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
    write_atomic(&runner_path, RUNNER_SOURCE.as_bytes())?;

    let initial = ReleaseStatus {
        run_id: run_id.clone(),
        workspace_root: workspace.root.clone(),
        version: version.to_string(),
        status: "running".to_string(),
        phase: "starting".to_string(),
        error: None,
        pid: 0,
        started_at: now_ms(),
        updated_at: now_ms(),
        completed_at: None,
        dismissed: false,
        log_path: Some(log_path.to_string_lossy().into_owned()),
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
        .args(["--run-id", &run_id, "--version", version])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
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
    let Some(workspace) = harness_workspace(path)? else {
        return Ok(None);
    };
    let state_path = release_data_dir(&workspace.root)?.join("current.json");
    let Some(mut current) = read_status(&workspace.root)? else {
        return Ok(None);
    };
    current.dismissed = true;
    current.updated_at = now_ms();
    write_status(&state_path, &current)?;
    Ok(Some(current))
}

pub fn open_log(path: &str) -> Result<(), String> {
    let Some(workspace) = harness_workspace(path)? else {
        return Err("发布命令只适用于 Codex Harness 工作区".to_string());
    };
    let status = read_status(&workspace.root)?.ok_or_else(|| "没有发布记录".to_string())?;
    let log_path = status
        .log_path
        .ok_or_else(|| "发布日志不存在".to_string())?;
    let log_path = PathBuf::from(log_path);
    let expected = release_data_dir(&workspace.root)?;
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

fn harness_workspace(path: &str) -> Result<Option<store::Workspace>, String> {
    let workspace = match git_workspace::resolve_workspace(path) {
        Ok(workspace) => workspace,
        Err(_) => return Ok(None),
    };
    let remote = match git(&workspace.checkout_root, ["remote", "get-url", "origin"]) {
        Ok(remote) => remote,
        Err(_) => return Ok(None),
    };
    Ok((normalized_remote(&remote) == EXPECTED_REMOTE).then_some(workspace))
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

fn origin_main_version(cwd: &str) -> Result<String, String> {
    let raw = git(cwd, ["show", "origin/main:package.json"])?;
    let package: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("origin/main package.json 无效: {error}"))?;
    package
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "origin/main package.json 缺少 version".to_string())
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
}
