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
    let mut command = Command::new(executable);
    command.arg(cwd);
    if let Some(line) = line.filter(|line| *line > 0) {
        command.args(["--line", &line.to_string()]);
    }
    let status = command
        .arg(path)
        .status()
        .map_err(|error| format!("无法在 GoLand 中打开文件: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("GoLand 无法打开该文件".to_string())
    }
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
