use crate::store::Workspace;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

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
}
