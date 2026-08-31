use crate::store::Workspace;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeliveryContext {
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    pub review_url: Option<String>,
    pub review_label: Option<String>,
}

pub fn resolve_workspace(path: &str) -> Result<Workspace, String> {
    let selected = fs::canonicalize(path).map_err(|error| format!("无法访问所选目录: {error}"))?;
    if !selected.is_dir() {
        return Err("请选择一个目录，而不是文件。".to_string());
    }

    // Query both values in one subprocess. This runs for historic sessions as
    // well, so halving the Git process count noticeably improves sidebar load.
    let git_info = git(
        &selected,
        [
            "rev-parse",
            "--is-inside-work-tree",
            "--git-common-dir",
            "--show-toplevel",
        ],
    )?;
    let mut git_info = git_info.lines();
    if git_info.next().map(str::trim) != Some("true") {
        return Err("所选目录不在 Git 工作区中。请选择主工作区或其任意子目录。".to_string());
    }

    // Git returns the shared git directory for both the main checkout and every linked worktree.
    // Its parent is therefore the only navigation root we persist and expose to new threads.
    let common_dir = git_info
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无法从 Git 元数据确定主工作区。".to_string())?;
    let checkout_root = git_info
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无法确定 Git checkout 根目录。".to_string())?;
    let sha = git_optional(&selected, ["rev-parse", "HEAD"]);
    let branch = git_optional(&selected, ["branch", "--show-current"]);
    let common_dir = PathBuf::from(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        selected.join(common_dir)
    };
    let common_dir =
        fs::canonicalize(common_dir).map_err(|error| format!("无法解析 Git 主工作区: {error}"))?;
    let root = common_dir
        .parent()
        .ok_or_else(|| "无法从 Git 元数据确定主工作区。".to_string())?
        .to_path_buf();
    let root = fs::canonicalize(root).map_err(|error| format!("无法解析 Git 主工作区: {error}"))?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("workspace")
        .to_owned();

    Ok(Workspace {
        root: root.to_string_lossy().into_owned(),
        checkout_root: fs::canonicalize(checkout_root)
            .map_err(|error| format!("无法解析 Git checkout 根目录: {error}"))?
            .to_string_lossy()
            .into_owned(),
        name,
        branch,
        sha,
        created_at: 0,
        last_opened_at: 0,
    })
}

pub fn delivery_context(path: &str) -> Result<WorkspaceDeliveryContext, String> {
    let cwd = fs::canonicalize(path).map_err(|error| format!("无法访问工作目录: {error}"))?;
    if !cwd.is_dir() {
        return Err("工作目录不存在".to_string());
    }
    let inside = git(&cwd, ["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err("当前目录不在 Git 工作区中".to_string());
    }
    let branch = git_optional(&cwd, ["branch", "--show-current"]);
    let remote_url = git_optional(&cwd, ["remote", "get-url", "origin"]);
    let review = branch
        .as_deref()
        .zip(remote_url.as_deref())
        .and_then(|(branch, remote)| review_url(remote, branch));
    Ok(WorkspaceDeliveryContext {
        branch,
        remote_url,
        review_url: review.as_ref().map(|(url, _)| url.clone()),
        review_label: review.map(|(_, label)| label),
    })
}

pub fn create_agent_worktree(cwd: &str, run_id: &str, data_dir: &Path) -> Result<String, String> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Agent Run ID 格式无效".to_string());
    }
    let workspace = resolve_workspace(cwd)?;
    let target = data_dir.join("agent-worktrees").join(run_id);
    if target.exists() {
        return Err("隔离 worktree 已存在".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定 worktree 目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 worktree 目录: {error}"))?;
    let short_id: String = run_id
        .chars()
        .filter(|character| *character != '-')
        .take(8)
        .collect();
    let branch = format!("codex-harness/{short_id}");
    let output = Command::new("git")
        .arg("-C")
        .arg(&workspace.checkout_root)
        .args(["worktree", "add", "-b", &branch])
        .arg(&target)
        .arg("HEAD")
        .output()
        .map_err(|error| format!("无法创建隔离 worktree: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法创建隔离 worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    fs::canonicalize(&target)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("无法解析隔离 worktree: {error}"))
}

fn review_url(remote: &str, branch: &str) -> Option<(String, String)> {
    let base = remote_web_url(remote)?;
    let encoded_branch = percent_encode(branch);
    if base.starts_with("https://github.com/") || base.starts_with("http://github.com/") {
        return Some((
            format!("{base}/compare/{encoded_branch}?expand=1"),
            "创建 PR".to_string(),
        ));
    }
    Some((
        format!("{base}/-/merge_requests/new?merge_request%5Bsource_branch%5D={encoded_branch}"),
        "创建 MR".to_string(),
    ))
}

fn remote_web_url(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    if remote.starts_with("https://") || remote.starts_with("http://") {
        return Some(remote.to_string());
    }
    if let Some(value) = remote.strip_prefix("ssh://") {
        let host_and_path = value.split_once('@').map(|(_, tail)| tail).unwrap_or(value);
        return host_and_path
            .split_once('/')
            .map(|(host, path)| format!("https://{host}/{path}"));
    }
    let (_, host_and_path) = remote.split_once('@')?;
    let (host, path) = host_and_path.split_once(':')?;
    Some(format!("https://{host}/{path}"))
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn git<const N: usize>(cwd: &Path, args: [&str; N]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("无法运行 Git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8(output.stdout).map_err(|error| format!("Git 输出不是有效 UTF-8: {error}"))
}

fn git_optional<const N: usize>(cwd: &Path, args: [&str; N]) -> Option<String> {
    git(cwd, args)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        path::PathBuf,
        process::{self, Command},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path =
                env::temp_dir().join(format!("codex-harness-git-test-{}-{suffix}", process::id()));
            fs::create_dir_all(&path).expect("creates test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn init_git(path: &Path) {
        let output = Command::new("git")
            .arg("init")
            .current_dir(path)
            .output()
            .expect("starts git init");
        assert!(
            output.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_command(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .expect("starts git command");
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn resolves_main_workspace_from_a_nested_git_directory() {
        let directory = TestDir::new();
        init_git(&directory.0);
        let nested = directory.0.join("nested");
        fs::create_dir_all(&nested).expect("creates nested directory");

        let workspace = resolve_workspace(nested.to_str().expect("UTF-8 path"))
            .expect("resolves main workspace");
        let expected_root = fs::canonicalize(&directory.0).expect("canonicalizes test root");
        assert_eq!(workspace.root, expected_root.to_string_lossy().into_owned());
        assert_eq!(
            workspace.checkout_root,
            expected_root.to_string_lossy().into_owned()
        );
        assert_eq!(
            workspace.name,
            expected_root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap()
        );
    }

    #[test]
    fn rejects_a_directory_outside_a_git_workspace() {
        let directory = TestDir::new();
        let error = resolve_workspace(directory.0.to_str().expect("UTF-8 path"))
            .expect_err("non-Git directory must be rejected");

        assert!(!error.trim().is_empty());
    }

    #[test]
    fn groups_a_linked_worktree_under_the_main_workspace_but_keeps_its_checkout() {
        let directory = TestDir::new();
        init_git(&directory.0);
        git_command(&directory.0, &["config", "user.name", "Codex Harness Test"]);
        git_command(
            &directory.0,
            &["config", "user.email", "test@example.invalid"],
        );
        git_command(&directory.0, &["commit", "--allow-empty", "-m", "initial"]);
        let worktree = directory.0.with_extension("linked");
        git_command(
            &directory.0,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                worktree.to_str().expect("UTF-8 path"),
            ],
        );

        let main =
            resolve_workspace(directory.0.to_str().expect("UTF-8 path")).expect("main workspace");
        let linked =
            resolve_workspace(worktree.to_str().expect("UTF-8 path")).expect("linked workspace");

        assert_eq!(linked.root, main.root);
        assert_ne!(linked.checkout_root, main.checkout_root);
        assert_eq!(
            linked.checkout_root,
            fs::canonicalize(&worktree).unwrap().to_string_lossy()
        );
        assert_eq!(linked.branch.as_deref(), Some("feature"));

        git_command(
            &directory.0,
            &["worktree", "remove", "--force", worktree.to_str().unwrap()],
        );
    }

    #[test]
    fn builds_review_urls_for_github_and_gitlab_remotes() {
        assert_eq!(
            review_url("git@github.com:openai/codex.git", "feature/fork"),
            Some((
                "https://github.com/openai/codex/compare/feature%2Ffork?expand=1".to_string(),
                "创建 PR".to_string(),
            ))
        );
        assert_eq!(
            review_url("ssh://git@git.example.com/group/repo.git", "fix one"),
            Some((
                "https://git.example.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%20one".to_string(),
                "创建 MR".to_string(),
            ))
        );
        assert_eq!(review_url("/tmp/repo.git", "main"), None);
    }

    #[test]
    fn creates_an_isolated_agent_worktree() {
        let repository = TestDir::new();
        let data = TestDir::new();
        init_git(&repository.0);
        git_command(
            &repository.0,
            &["config", "user.name", "Codex Harness Test"],
        );
        git_command(
            &repository.0,
            &["config", "user.email", "test@example.invalid"],
        );
        git_command(&repository.0, &["commit", "--allow-empty", "-m", "initial"]);

        let worktree = create_agent_worktree(
            repository.0.to_str().unwrap(),
            "12345678-1234-1234-1234-123456789abc",
            &data.0,
        )
        .expect("creates isolated worktree");
        assert!(Path::new(&worktree).is_dir());
        assert_eq!(
            git_optional(Path::new(&worktree), ["branch", "--show-current"]).as_deref(),
            Some("codex-harness/12345678")
        );
    }
}
