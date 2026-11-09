//! Immutable application-owned Skill resources shared by runtime integrations.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn version(files: &[(&str, &str)]) -> String {
    let hash = files
        .iter()
        .flat_map(|(name, content)| name.bytes().chain([0]).chain(content.bytes()).chain([0]))
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

/// Publish real files atomically, and verify every reused file and intermediate
/// directory. Never overwrite a user's file or follow a substituted symlink.
pub fn materialize(
    target: &Path,
    files: &[(&str, &str)],
    executables: &[&str],
) -> io::Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("Skill 缺少资源父目录"))?;
    fs::create_dir_all(parent)?;
    if !target.try_exists()? {
        let stage = tempfile::tempdir_in(parent)?;
        for (name, content) in files {
            let file = stage.path().join(name);
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir)?;
            }
            fs::write(&file, content)?;
            #[cfg(unix)]
            if executables.contains(name) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
            }
        }
        if let Err(error) = fs::rename(stage.path(), target) {
            if !target.is_dir() {
                return Err(error);
            }
        }
    }
    if fs::symlink_metadata(target)?.file_type().is_symlink() {
        return Err(io::Error::other("应用 Skill 副本目录被替换，请核对"));
    }
    for (name, content) in files {
        let file = target.join(name);
        for ancestor in file.ancestors().take_while(|path| *path != target) {
            if fs::symlink_metadata(ancestor)?.file_type().is_symlink() {
                return Err(io::Error::other("应用 Skill 副本包含符号链接，请核对"));
            }
        }
        if fs::read_to_string(&file)? != *content {
            return Err(io::Error::other("应用 Skill 副本已被修改，请核对"));
        }
        #[cfg(unix)]
        if executables.contains(name) {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&file)?.permissions().mode() & 0o111 == 0 {
                return Err(io::Error::other("应用 Skill 命令缺少执行权限，请核对"));
            }
        }
    }
    fs::canonicalize(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_covers_reference_paths_and_contents() {
        let first = version(&[("SKILL.md", "skill"), ("references/one.md", "one")]);
        assert_ne!(
            first,
            version(&[("SKILL.md", "skill"), ("references/two.md", "one")])
        );
        assert_ne!(
            first,
            version(&[("SKILL.md", "skill"), ("references/one.md", "two")])
        );
    }
}
