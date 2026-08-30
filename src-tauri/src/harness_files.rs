use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const AGENT_FILENAMES: [&str; 2] = ["AGENTS.override.md", "AGENTS.md"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessFileTree {
    pub cwd: String,
    pub project_root: String,
    pub roots: Vec<HarnessFileNode>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessFileNode {
    pub path: String,
    pub name: String,
    pub kind: NodeKind,
    pub source: NodeSource,
    pub exists: bool,
    pub children: Vec<HarnessFileNode>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeSource {
    Global,
    Project,
    Harness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedPathKind {
    AgentFile,
    Harness,
}

pub fn list(cwd: &str, codex_home: &Path) -> Result<HarnessFileTree, String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    Ok(scope.tree())
}

pub fn read(cwd: &str, codex_home: &Path, path: &str) -> Result<String, String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    let target = scope.validate_existing(path, false)?;
    fs::read_to_string(&target).map_err(|error| format!("无法读取 {}: {error}", target.display()))
}

pub fn write(cwd: &str, codex_home: &Path, path: &str, content: &str) -> Result<(), String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    let target = scope.validate_target(path, false)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    fs::write(&target, content).map_err(|error| format!("无法写入 {}: {error}", target.display()))
}

pub fn create_directory(cwd: &str, codex_home: &Path, path: &str) -> Result<(), String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    let target = scope.validate_target(path, true)?;
    fs::create_dir_all(&target)
        .map_err(|error| format!("无法创建目录 {}: {error}", target.display()))
}

pub fn rename(cwd: &str, codex_home: &Path, path: &str, next_path: &str) -> Result<(), String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    let source = scope.validate_existing(path, true)?;
    let target = scope.validate_target(next_path, source.is_dir())?;
    if scope.classify(&source)? != scope.classify(&target)? {
        return Err("不能在不同的 Harness 管理区域之间移动文件。".to_string());
    }
    if target.exists() {
        return Err("目标名称已经存在。".to_string());
    }
    fs::rename(&source, &target).map_err(|error| {
        format!(
            "无法将 {} 重命名为 {}: {error}",
            source.display(),
            target.display()
        )
    })
}

pub fn remove(cwd: &str, codex_home: &Path, path: &str) -> Result<(), String> {
    let scope = ManagedScope::resolve(cwd, codex_home)?;
    let target = scope.validate_existing(path, true)?;
    if target == scope.harness_root {
        return Err("不能删除 .harness 根目录。".to_string());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("无法删除目录 {}: {error}", target.display()))
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("无法删除文件 {}: {error}", target.display()))
    }
}

struct ManagedScope {
    cwd: PathBuf,
    project_root: PathBuf,
    codex_home: PathBuf,
    project_directories: Vec<PathBuf>,
    harness_root: PathBuf,
}

impl ManagedScope {
    fn resolve(cwd: &str, codex_home: &Path) -> Result<Self, String> {
        let cwd = fs::canonicalize(cwd)
            .map_err(|error| format!("无法访问线程工作目录 {cwd}: {error}"))?;
        if !cwd.is_dir() {
            return Err("线程工作目录不是有效目录。".to_string());
        }
        let project_root = git_project_root(&cwd)?;
        if !cwd.starts_with(&project_root) {
            return Err("线程工作目录不在 Git 项目根目录内。".to_string());
        }
        let codex_home = absolute_path(codex_home)?;
        let mut project_directories = vec![project_root.clone()];
        let relative = cwd
            .strip_prefix(&project_root)
            .map_err(|_| "无法解析项目指令目录。".to_string())?;
        let mut cursor = project_root.clone();
        for component in relative.components() {
            cursor.push(component.as_os_str());
            project_directories.push(cursor.clone());
        }
        Ok(Self {
            harness_root: cwd.join(".harness"),
            cwd,
            project_root,
            codex_home,
            project_directories,
        })
    }

    fn tree(&self) -> HarnessFileTree {
        let global_children = AGENT_FILENAMES
            .iter()
            .map(|name| file_node(self.codex_home.join(name), NodeSource::Global))
            .collect();
        let project_children = self
            .project_directories
            .iter()
            .map(|directory| {
                let label = if directory == &self.project_root {
                    "项目根目录".to_string()
                } else if directory == &self.cwd {
                    "当前目录".to_string()
                } else {
                    directory
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| directory.display().to_string())
                };
                directory_node(
                    directory.clone(),
                    label,
                    NodeSource::Project,
                    AGENT_FILENAMES
                        .iter()
                        .map(|name| file_node(directory.join(name), NodeSource::Project))
                        .collect(),
                )
            })
            .collect();
        let harness_children = read_directory_nodes(&self.harness_root, NodeSource::Harness);
        HarnessFileTree {
            cwd: display_path(&self.cwd),
            project_root: display_path(&self.project_root),
            roots: vec![
                directory_node(
                    self.codex_home.clone(),
                    "Codex 全局".to_string(),
                    NodeSource::Global,
                    global_children,
                ),
                directory_node(
                    self.project_root.join("."),
                    "项目指令链".to_string(),
                    NodeSource::Project,
                    project_children,
                ),
                HarnessFileNode {
                    path: display_path(&self.harness_root),
                    name: ".harness".to_string(),
                    kind: NodeKind::Directory,
                    source: NodeSource::Harness,
                    exists: self.harness_root.is_dir(),
                    children: harness_children,
                },
            ],
        }
    }

    fn validate_existing(&self, path: &str, allow_directory: bool) -> Result<PathBuf, String> {
        let target =
            fs::canonicalize(path).map_err(|error| format!("无法访问受管文件 {path}: {error}"))?;
        self.classify(&target)?;
        if !allow_directory && !target.is_file() {
            return Err("请选择一个文件。".to_string());
        }
        Ok(target)
    }

    fn validate_target(&self, path: &str, directory: bool) -> Result<PathBuf, String> {
        let target = normalized_absolute(Path::new(path))?;
        if target.exists() {
            let canonical_target = fs::canonicalize(&target)
                .map_err(|error| format!("无法访问目标 {}: {error}", target.display()))?;
            let kind = self.classify(&canonical_target)?;
            if kind == ManagedPathKind::AgentFile && directory {
                return Err("AGENTS 管理区域只能创建指令文件。".to_string());
            }
            return Ok(canonical_target);
        }
        let parent = target
            .parent()
            .ok_or_else(|| "目标路径没有父目录。".to_string())?;
        let existing_parent = nearest_existing_ancestor(parent)?;
        let canonical_parent = fs::canonicalize(&existing_parent)
            .map_err(|error| format!("无法访问父目录 {}: {error}", existing_parent.display()))?;
        let suffix = parent
            .strip_prefix(&existing_parent)
            .map_err(|_| "无法验证目标路径。".to_string())?;
        let verified_target = canonical_parent.join(suffix).join(
            target
                .file_name()
                .ok_or_else(|| "目标名称无效。".to_string())?,
        );
        let kind = self.classify(&verified_target)?;
        if kind == ManagedPathKind::AgentFile && directory {
            return Err("AGENTS 管理区域只能创建指令文件。".to_string());
        }
        Ok(verified_target)
    }

    fn classify(&self, path: &Path) -> Result<ManagedPathKind, String> {
        if path.starts_with(&self.harness_root) {
            return Ok(ManagedPathKind::Harness);
        }
        let is_agent_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| AGENT_FILENAMES.contains(&name));
        let parent = path.parent();
        if is_agent_file
            && (parent == Some(self.codex_home.as_path())
                || self
                    .project_directories
                    .iter()
                    .any(|directory| parent == Some(directory.as_path())))
        {
            return Ok(ManagedPathKind::AgentFile);
        }
        Err("路径不属于当前线程的 Harness 管理范围。".to_string())
    }
}

fn git_project_root(cwd: &Path) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| format!("无法运行 Git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let root = String::from_utf8(output.stdout)
        .map_err(|error| format!("Git 输出不是有效 UTF-8: {error}"))?;
    fs::canonicalize(root.trim()).map_err(|error| format!("无法解析 Git 项目根目录: {error}"))
}

fn read_directory_nodes(directory: &Path, source: NodeSource) -> Vec<HarnessFileNode> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut nodes = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                Some(directory_node(
                    path.clone(),
                    name,
                    source,
                    read_directory_nodes(&path, source),
                ))
            } else if file_type.is_file() {
                Some(HarnessFileNode {
                    path: display_path(&path),
                    name,
                    kind: NodeKind::File,
                    source,
                    exists: true,
                    children: Vec::new(),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        node_rank(left)
            .cmp(&node_rank(right))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    nodes
}

fn node_rank(node: &HarnessFileNode) -> u8 {
    match node.kind {
        NodeKind::Directory => 0,
        NodeKind::File => 1,
    }
}

fn directory_node(
    path: PathBuf,
    name: String,
    source: NodeSource,
    children: Vec<HarnessFileNode>,
) -> HarnessFileNode {
    HarnessFileNode {
        exists: path.is_dir(),
        path: display_path(&path),
        name,
        kind: NodeKind::Directory,
        source,
        children,
    }
}

fn file_node(path: PathBuf, source: NodeSource) -> HarnessFileNode {
    HarnessFileNode {
        exists: path.is_file(),
        path: display_path(&path),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        kind: NodeKind::File,
        source,
        children: Vec::new(),
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        normalized_absolute(path)
    } else {
        Err("Codex Home 必须是绝对路径。".to_string())
    }
}

fn normalized_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("文件路径必须是绝对路径。".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("文件路径无效。".to_string());
                }
            }
        }
    }
    Ok(normalized)
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    path.ancestors()
        .find(|ancestor| ancestor.exists())
        .map(Path::to_path_buf)
        .ok_or_else(|| "找不到可访问的父目录。".to_string())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        process::{self, Command},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "codex-harness-files-test-{}-{suffix}",
                process::id()
            ));
            fs::create_dir_all(&path).expect("creates test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestDir, PathBuf, PathBuf, PathBuf) {
        let temp = TestDir::new();
        let repository = temp.0.join("repository");
        let cwd = repository.join("packages/app");
        let codex_home = temp.0.join("home/.codex");
        fs::create_dir_all(&cwd).expect("creates cwd");
        fs::create_dir_all(&codex_home).expect("creates codex home");
        Command::new("git")
            .arg("init")
            .arg(&repository)
            .output()
            .expect("initializes git repository");
        (temp, repository, cwd, codex_home)
    }

    #[test]
    fn lists_global_project_chain_and_current_harness_files() {
        let (_temp, repository, cwd, codex_home) = fixture();
        fs::write(codex_home.join("AGENTS.md"), "global").expect("writes global agents");
        fs::write(repository.join("AGENTS.md"), "root").expect("writes root agents");
        fs::create_dir_all(cwd.join(".harness/plans")).expect("creates harness tree");
        fs::write(cwd.join(".harness/plans/today.md"), "today").expect("writes harness file");

        let tree = list(cwd.to_str().unwrap(), &codex_home).expect("lists files");

        assert_eq!(tree.roots.len(), 3);
        assert_eq!(tree.roots[0].children[1].exists, true);
        assert_eq!(tree.roots[1].children[0].name, "项目根目录");
        assert_eq!(tree.roots[1].children.last().unwrap().name, "当前目录");
        assert_eq!(tree.roots[2].children[0].name, "plans");
        assert_eq!(tree.roots[2].children[0].children[0].name, "today.md");
    }

    #[test]
    fn reads_writes_and_creates_only_managed_paths() {
        let (temp, _repository, cwd, codex_home) = fixture();
        let harness_file = cwd.join(".harness/notes/item.md");
        write(
            cwd.to_str().unwrap(),
            &codex_home,
            harness_file.to_str().unwrap(),
            "hello",
        )
        .expect("writes managed file");
        assert_eq!(
            read(
                cwd.to_str().unwrap(),
                &codex_home,
                harness_file.to_str().unwrap()
            )
            .unwrap(),
            "hello"
        );

        let outside = temp.0.join("outside.md");
        assert!(write(
            cwd.to_str().unwrap(),
            &codex_home,
            outside.to_str().unwrap(),
            "blocked"
        )
        .is_err());
    }

    #[test]
    fn supports_renaming_and_removing_harness_entries() {
        let (_temp, _repository, cwd, codex_home) = fixture();
        let original = cwd.join(".harness/draft.md");
        let renamed = cwd.join(".harness/final.md");
        write(
            cwd.to_str().unwrap(),
            &codex_home,
            original.to_str().unwrap(),
            "content",
        )
        .unwrap();
        rename(
            cwd.to_str().unwrap(),
            &codex_home,
            original.to_str().unwrap(),
            renamed.to_str().unwrap(),
        )
        .unwrap();
        assert!(renamed.is_file());
        remove(
            cwd.to_str().unwrap(),
            &codex_home,
            renamed.to_str().unwrap(),
        )
        .unwrap();
        assert!(!renamed.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_writes_through_symlinks_that_leave_the_managed_scope() {
        use std::os::unix::fs::symlink;

        let (temp, _repository, cwd, codex_home) = fixture();
        let outside = temp.0.join("outside.md");
        fs::write(&outside, "safe").unwrap();
        fs::create_dir_all(cwd.join(".harness")).unwrap();
        let link = cwd.join(".harness/link.md");
        symlink(&outside, &link).unwrap();

        assert!(write(
            cwd.to_str().unwrap(),
            &codex_home,
            link.to_str().unwrap(),
            "changed"
        )
        .is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "safe");
    }
}
