use crate::store::Workspace;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub fn resolve_main_workspace(path: &str) -> Result<Workspace, String> {
    let selected = fs::canonicalize(path).map_err(|error| format!("无法访问所选目录: {error}"))?;
    if !selected.is_dir() {
        return Err("请选择一个目录，而不是文件。".to_string());
    }

    let inside = git(&selected, ["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err("所选目录不在 Git 工作区中。请选择主工作区或其任意子目录。".to_string());
    }

    // Git returns the shared git directory for both the main checkout and every linked worktree.
    // Its parent is therefore the only navigation root we persist and expose to new threads.
    let common_dir = git(&selected, ["rev-parse", "--git-common-dir"])?;
    let common_dir = PathBuf::from(common_dir.trim());
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
        name,
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
