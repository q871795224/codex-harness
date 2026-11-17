use std::{fs, path::Path};

// Drafts and temporary classification/summary calls use a neutral directory.
pub(crate) fn directory_at(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("workspaces").join("general");
    fs::create_dir_all(&path).map_err(|error| format!("无法创建通用会话目录：{error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法解析通用会话目录：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// General user tasks start at the common project parent; never create a missing parent.
pub(crate) fn general_directory_at(home: &Path) -> Result<String, String> {
    let path = home.join("sgw");
    if !path.is_dir() {
        return Err("通用工作目录 ~/sgw 不存在或不是目录，请手动选择工作区".into());
    }
    let path = path.canonicalize().map_err(|_| "无法解析通用工作目录 ~/sgw")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn general_tasks_use_the_project_parent_and_leave_neutral_calls_separate() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("sgw");
        std::fs::create_dir(&projects).unwrap();
        std::fs::write(projects.join("keep.txt"), "keep").unwrap();
        let general = super::general_directory_at(home.path()).unwrap();
        let neutral = super::directory_at(&home.path().join(".codex-harness")).unwrap();
        assert_eq!(std::path::Path::new(&general), projects.canonicalize().unwrap());
        assert_ne!(general, neutral);
        assert_eq!(std::fs::read_to_string(projects.join("keep.txt")).unwrap(), "keep");
    }

    #[test]
    fn missing_or_non_directory_project_parent_is_not_created_or_replaced() {
        let home = tempfile::tempdir().unwrap();
        assert!(super::general_directory_at(home.path()).is_err());
        let projects = home.path().join("sgw");
        assert!(!projects.exists());
        std::fs::write(&projects, "keep").unwrap();
        assert!(super::general_directory_at(home.path()).is_err());
        assert_eq!(std::fs::read_to_string(projects).unwrap(), "keep");
    }

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
