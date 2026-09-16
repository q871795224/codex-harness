use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn open(app_id: &str, cwd: &str) -> Result<(), String> {
    let bundle_id = bundle_id(app_id)?;
    validate_cwd(cwd)?;
    let status = Command::new("/usr/bin/open")
        .args(["-b", bundle_id])
        .arg(cwd)
        .status()
        .map_err(|error| format!("无法启动 GoLand: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("GoLand 未安装或无法打开".to_string())
    }
}

pub fn open_path(app_id: &str, cwd: &str, path: &str, line: Option<u32>) -> Result<(), String> {
    bundle_id(app_id)?;
    validate_cwd(cwd)?;
    let path = resolve_file(cwd, path)?;
    let executable = goland_executable().ok_or_else(|| "找不到 GoLand 命令行入口".to_string())?;
    open_path_with(&executable, cwd, &path, line)
}

fn open_path_with(
    executable: &Path,
    cwd: &str,
    path: &Path,
    line: Option<u32>,
) -> Result<(), String> {
    let mut command = Command::new(executable);
    if let Some(project) = project_dir_for(cwd, path) {
        command.arg(project);
    }
    if let Some(line) = line.filter(|line| *line > 0) {
        command.args(["--line", &line.to_string()]);
    }
    let mut child = command
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("无法在 GoLand 中打开文件: {error}"))?;
    // GoLand 是长驻 GUI 进程，不能同步等待它退出（该命令运行在主线程上，
    // 等待会把整个应用卡死）；后台线程只负责回收子进程。
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn project_dir_for(cwd: &str, path: &Path) -> Option<PathBuf> {
    let cwd_path = Path::new(cwd);
    let cwd_canonical = cwd_path
        .canonicalize()
        .unwrap_or_else(|_| cwd_path.to_path_buf());
    let canonical = |root: PathBuf| root.canonicalize().unwrap_or(root);
    let file_root = path.parent().and_then(git_toplevel).map(canonical);
    let cwd_root = git_toplevel(&cwd_canonical).map(canonical);
    match (file_root, cwd_root) {
        (Some(file_root), Some(cwd_root)) if file_root == cwd_root => Some(cwd_path.to_path_buf()),
        (Some(file_root), _) => Some(file_root),
        (None, _) if path.starts_with(&cwd_canonical) => Some(cwd_path.to_path_buf()),
        (None, _) => None,
    }
}

fn git_toplevel(dir: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let toplevel = String::from_utf8(output.stdout).ok()?;
    let toplevel = toplevel.trim();
    if toplevel.is_empty() {
        return None;
    }
    Some(PathBuf::from(toplevel))
}

fn bundle_id(app_id: &str) -> Result<&'static str, String> {
    match app_id {
        "goland" => Ok("com.jetbrains.goland"),
        _ => Err("不支持的 App".to_string()),
    }
}

fn validate_cwd(cwd: &str) -> Result<(), String> {
    if cwd.trim().is_empty() || !Path::new(cwd).is_dir() {
        return Err("当前 worktree 目录不存在".to_string());
    }
    Ok(())
}

fn resolve_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let candidate = Path::new(path);
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(cwd).join(candidate)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "文件不存在".to_string())?;
    if !resolved.is_file() {
        return Err("目标不是文件".to_string());
    }
    Ok(resolved)
}

fn goland_executable() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from(
        "/Applications/GoLand.app/Contents/MacOS/goland",
    )];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join("Applications/GoLand.app/Contents/MacOS/goland"));
        candidates
            .push(home.join("Applications/JetBrains Toolbox/GoLand.app/Contents/MacOS/goland"));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_known_apps() {
        assert_eq!(bundle_id("goland"), Ok("com.jetbrains.goland"));
        assert_eq!(bundle_id("shell"), Err("不支持的 App".to_string()));
    }

    #[test]
    fn validates_the_worktree_directory() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        assert_eq!(validate_cwd(directory.path().to_str().unwrap()), Ok(()));
        assert!(validate_cwd(directory.path().join("missing").to_str().unwrap()).is_err());
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .expect("runs git");
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn keeps_the_conversation_directory_when_the_file_shares_its_repository() {
        let repo = tempfile::tempdir().expect("creates repo");
        git(repo.path(), &["init"]);
        let sub = repo.path().join("sub");
        std::fs::create_dir_all(&sub).expect("creates subdirectory");
        let file = sub.join("main.go");
        std::fs::write(&file, "package main").expect("writes fixture");

        let project = project_dir_for(sub.to_str().unwrap(), &file.canonicalize().unwrap());
        assert_eq!(project, Some(sub));
    }

    #[test]
    fn uses_the_worktree_root_when_the_file_belongs_to_another_worktree() {
        let repo = tempfile::tempdir().expect("creates repo");
        git(repo.path(), &["init"]);
        std::fs::write(repo.path().join("README.md"), "demo").expect("writes fixture");
        git(repo.path(), &["add", "README.md"]);
        git(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "init",
            ],
        );
        let worktree = repo.path().join(".worktrees").join("feature");
        std::fs::create_dir_all(worktree.parent().unwrap()).expect("creates worktree parent");
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "-b",
                "feature-branch",
            ],
        );
        let file = worktree.join("main.go");
        std::fs::write(&file, "package main").expect("writes fixture");

        let project = project_dir_for(repo.path().to_str().unwrap(), &file.canonicalize().unwrap());
        assert_eq!(project, Some(worktree.canonicalize().unwrap()));
    }

    #[test]
    fn falls_back_to_the_conversation_directory_for_non_repo_files_inside_it() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        let file = directory.path().join("notes.txt");
        std::fs::write(&file, "notes").expect("writes fixture");

        let project = project_dir_for(
            directory.path().to_str().unwrap(),
            &file.canonicalize().unwrap(),
        );
        assert_eq!(project, Some(directory.path().to_path_buf()));
    }

    #[test]
    fn returns_no_project_for_non_repo_files_outside_the_conversation_directory() {
        let cwd = tempfile::tempdir().expect("creates cwd");
        let other = tempfile::tempdir().expect("creates other directory");
        let file = other.path().join("notes.txt");
        std::fs::write(&file, "notes").expect("writes fixture");

        let project = project_dir_for(cwd.path().to_str().unwrap(), &file.canonicalize().unwrap());
        assert_eq!(project, None);
    }

    #[cfg(unix)]
    fn write_fake_goland(dir: &Path, args_file: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-goland");
        let content = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nsleep 6\n",
            args_file.display()
        );
        std::fs::write(&script, content).expect("writes fake goland");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("marks fake goland executable");
        script
    }

    #[test]
    #[cfg(unix)]
    fn does_not_wait_for_the_editor_process_to_exit() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        let file = directory.path().join("main.go");
        std::fs::write(&file, "package main").expect("writes fixture");
        let canonical_file = file.canonicalize().expect("canonicalizes fixture");
        let args_file = directory.path().join("args.txt");
        let executable = write_fake_goland(directory.path(), &args_file);

        let started = std::time::Instant::now();
        open_path_with(
            &executable,
            directory.path().to_str().unwrap(),
            &canonical_file,
            Some(147),
        )
        .expect("opens the file");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "open_path_with must return without waiting for the editor process"
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let args = loop {
            match std::fs::read_to_string(&args_file) {
                Ok(args) => break args,
                Err(error) if std::time::Instant::now() < deadline => {
                    let _ = error;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => panic!("reads captured args: {error}"),
            }
        };
        let lines: Vec<&str> = args.lines().collect();
        assert_eq!(
            lines,
            vec![
                directory.path().to_str().unwrap(),
                "--line",
                "147",
                canonical_file.to_str().unwrap(),
            ]
        );
    }

    #[test]
    fn resolves_absolute_and_relative_files() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        let file = directory.path().join("main.go");
        std::fs::write(&file, "package main").expect("writes fixture");
        let canonical_file = file.canonicalize().expect("canonicalizes fixture");

        assert_eq!(
            resolve_file(directory.path().to_str().unwrap(), "main.go").unwrap(),
            canonical_file
        );
        assert_eq!(
            resolve_file(directory.path().to_str().unwrap(), file.to_str().unwrap()).unwrap(),
            canonical_file
        );
        assert!(resolve_file(directory.path().to_str().unwrap(), "missing.go").is_err());
        assert!(resolve_file(directory.path().to_str().unwrap(), ".").is_err());
    }
}
