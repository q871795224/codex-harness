//! Handover 数据文件读写（~/.codex-harness/{templates,handover}/）。
//!
//! 与 `harness_files.rs` 分开：那套命令的作用域只放行项目指令文件（cwd/.harness、
//! codex_home 全局指令），写不进 `~/.codex-harness/`。这里用 `harness_data_dir()` 定位，
//! 只暴露 handover 需要的两个子目录，文件名做最小校验防止路径逃逸。

use crate::store;
use std::{fs, path::PathBuf};

const TEMPLATES_DIR: &str = "templates";
const DOCUMENTS_DIR: &str = "handover";

/// 校验文件名：不含路径分隔符、非空、以 .md 结尾，防止逃逸出目标子目录。
fn validate_file_name(file_name: &str) -> Result<&str, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("文件名不允许包含路径分隔符".to_string());
    }
    if !trimmed.ends_with(".md") {
        return Err("文件名必须以 .md 结尾".to_string());
    }
    Ok(trimmed)
}

fn sub_dir(kind: &str) -> Result<PathBuf, String> {
    Ok(store::harness_data_dir()?.join(kind))
}

/// 读取数据文件；不存在时返回 `default_content` 并把默认值物化到该路径（首用物化）。
pub fn read_or_seed(dir: &str, file_name: &str, default_content: &str) -> Result<String, String> {
    let name = validate_file_name(file_name)?;
    let dir_path = sub_dir(dir)?;
    let path = dir_path.join(name);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&dir_path).map_err(|e| format!("无法创建目录 {}: {e}", dir_path.display()))?;
            fs::write(&path, default_content)
                .map_err(|e| format!("无法写入默认文件 {}: {e}", path.display()))?;
            Ok(default_content.to_string())
        }
        Err(error) => Err(format!("无法读取文件 {}: {error}", path.display())),
    }
}

/// 写入数据文件（覆盖）。必要时创建子目录。
pub fn write(dir: &str, file_name: &str, content: &str) -> Result<(), String> {
    let name = validate_file_name(file_name)?;
    let dir_path = sub_dir(dir)?;
    fs::create_dir_all(&dir_path).map_err(|e| format!("无法创建目录 {}: {e}", dir_path.display()))?;
    let path = dir_path.join(name);
    fs::write(&path, content).map_err(|e| format!("无法写入文件 {}: {e}", path.display()))
}

pub fn read_template(file_name: &str, default_content: &str) -> Result<String, String> {
    read_or_seed(TEMPLATES_DIR, file_name, default_content)
}

pub fn write_document(file_name: &str, content: &str) -> Result<(), String> {
    write(DOCUMENTS_DIR, file_name, content)
}

pub fn read_document(file_name: &str) -> Result<String, String> {
    let name = validate_file_name(file_name)?;
    let path = sub_dir(DOCUMENTS_DIR)?.join(name);
    fs::read_to_string(&path).map_err(|e| format!("无法读取交接文档 {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_file_name("../evil.md").is_err());
        assert!(validate_file_name("a/b.md").is_err());
        assert!(validate_file_name("ok.md").is_ok());
        assert!(validate_file_name("not-md.txt").is_err());
        assert!(validate_file_name("").is_err());
    }
}
