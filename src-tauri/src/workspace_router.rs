use std::{fs, path::Path};

// An unselected draft must not inherit an arbitrary daemon/project cwd. The
// same directory is retained for general requests with no matching workspace.
pub(crate) fn directory_at(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("workspaces").join("general");
    fs::create_dir_all(&path).map_err(|error| format!("无法创建通用会话目录：{error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法解析通用会话目录：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn prepares_a_stable_directory_without_changing_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let path = super::directory_at(root.path()).unwrap();
        let file = std::path::Path::new(&path).join("notes.txt");
        std::fs::write(&file, "keep").unwrap();
        assert_eq!(super::directory_at(root.path()).unwrap(), path);
        assert_eq!(std::fs::read_to_string(file).unwrap(), "keep");
        assert_eq!(
            std::path::Path::new(&path),
            root.path()
                .canonicalize()
                .unwrap()
                .join("workspaces/general")
        );
    }
}
