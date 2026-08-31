use std::{path::Path, process::Command};

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
}
