//! Application-owned copies of the Git-maintained Skill. No prompt injection or global
//! extraRoots replacement: providers discover these files and load them natively.
use crate::store::HarnessStore;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

const SKILL: &str = include_str!("../../.agents/skills/project-doc/SKILL.md");
const CLI: &str = include_str!("../../.agents/skills/project-doc/project_doc.py");
const COMMAND: &str = include_str!("../../.agents/skills/project-doc/bin/project-doc");
pub(crate) const CODEX_NAME: &str = "harness-project-doc";
const PLUGIN: &str = r#"{"name":"harness-project-doc","version":"1.0.0"}"#;

pub(crate) struct ProjectDocSkill {
    store: Arc<HarnessStore>,
    root: PathBuf,
}

pub(crate) struct SkillLoad {
    pub bundle: PathBuf,
    pub needed: bool,
    pub refresh: bool,
    pub thread: String,
    key: String,
    stamp: String,
}

impl ProjectDocSkill {
    pub fn plugin_root(&self) -> Result<PathBuf, String> {
        Ok(materialize(&self.root, &bundle_version())?.join("claude-plugin"))
    }
    pub fn new(store: Arc<HarnessStore>, root: PathBuf) -> Self {
        Self { store, root }
    }

    pub fn prepare(&self, provider: &str, thread: &str) -> Result<Option<SkillLoad>, String> {
        let binding = self.store.project_thread_binding(thread)?;
        let version = bundle_version();
        let key = format!("projectDocSkillLoaded:{provider}:{thread}");
        let stamp = format!(
            "{version}:{}",
            binding
                .as_ref()
                .map(|b| b.project_id.as_str())
                .unwrap_or("unbound")
        );
        let refresh = self.store.get_app_state(&key)?.as_deref() != Some(&stamp);
        let needed = binding.is_some() && refresh;
        let bundle = materialize(&self.root, &version)?;
        Ok(Some(SkillLoad {
            bundle,
            needed,
            refresh,
            thread: thread.into(),
            key,
            stamp,
        }))
    }

    // Call only after the provider accepted the turn. Failed sends must remain retryable.
    pub fn accepted(&self, load: &SkillLoad) -> Result<(), String> {
        self.store.set_app_state(&load.key, &load.stamp)
    }
}

fn codex_skill_text() -> String {
    SKILL.replacen("name: project-doc\n", "name: harness-project-doc\n", 1)
}

fn bundle_files(codex_skill: &str) -> [(&str, &str); 7] {
    [
        ("codex/harness-project-doc/SKILL.md", codex_skill),
        ("codex/harness-project-doc/project_doc.py", CLI),
        ("codex/harness-project-doc/bin/project-doc", COMMAND),
        ("claude-plugin/skills/project-doc/SKILL.md", SKILL),
        ("claude-plugin/skills/project-doc/project_doc.py", CLI),
        ("claude-plugin/skills/project-doc/bin/project-doc", COMMAND),
        ("claude-plugin/.claude-plugin/plugin.json", PLUGIN),
    ]
}

fn bundle_version() -> String {
    // Resource paths also version the migration away from the old user-Skill link.
    crate::bundled_skill::version(&bundle_files(&codex_skill_text()))
}

fn materialize(root: &Path, version: &str) -> Result<PathBuf, String> {
    crate::bundled_skill::materialize(
        &root.join(version),
        &bundle_files(&codex_skill_text()),
        &[
            "codex/harness-project-doc/bin/project-doc",
            "claude-plugin/skills/project-doc/bin/project-doc",
        ],
    )
    .map_err(|error| format!("无法准备项目文档 Skill: {error}"))
}

impl SkillLoad {
    pub fn claude_params(&self) -> Value {
        json!({ "pluginRoot": self.bundle.join("claude-plugin"), "invoke": self.needed, "sourceThreadId": if self.refresh { Some(&self.thread) } else { None } })
    }

    /// Publish an immutable versioned copy in the native discovery directory.
    /// Existing links and user Skills remain untouched and are never dependencies.
    pub fn register_codex(&self, codex_home: &Path) -> Result<PathBuf, String> {
        let version = self
            .bundle
            .file_name()
            .ok_or("项目文档 Skill 缺少资源版本")?
            .to_string_lossy();
        let target = codex_home
            .join("skills")
            .join(format!("{CODEX_NAME}-{version}"));
        let skill = codex_skill_text();
        crate::bundled_skill::materialize(
            &target,
            &[
                ("SKILL.md", &skill),
                ("project_doc.py", CLI),
                ("bin/project-doc", COMMAND),
            ],
            &["bin/project-doc"],
        )
        .map(|root| root.join("SKILL.md"))
        .map_err(|error| format!("无法准备项目文档原生 Skill: {error}"))
    }
}

/// Use the provider-returned path; even a filesystem alias can silently skip loading.
pub(crate) fn discovered_skill(listing: &Value, expected: &Path) -> Result<Value, String> {
    listing["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .find(|skill| {
            skill["name"] == CODEX_NAME
                && skill["path"].as_str() == expected.to_str()
                && skill.get("enabled").and_then(Value::as_bool) != Some(false)
        })
        .map(|skill| json!({"type":"skill", "name":skill["name"], "path":skill["path"]}))
        .ok_or_else(|| "Codex 未发现 Harness 项目文档 Skill，请检查原生 Skills 配置。".into())
}

pub(crate) fn add_codex_input(params: &mut Value, skill: Value) -> Result<(), String> {
    let input = params
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or("turn/start 缺少 input")?;
    if !input
        .iter()
        .any(|item| item["type"] == "skill" && item["path"] == skill["path"])
    {
        input.push(json!({"type":"text", "text":format!("${CODEX_NAME}"), "text_elements":[]}));
        input.push(skill);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::project_bindings::BindingChange;
    use std::fs;

    #[test]
    fn binding_success_and_version_control_native_loading_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(dir.path().join("state")).unwrap());
        let root = dir.path().join("bundles with spaces");
        let service = ProjectDocSkill::new(store.clone(), root.clone());
        let discovery = service.prepare("codex", "unbound").unwrap().unwrap();
        assert!(!discovery.needed);
        assert!(discovery.refresh);
        service.accepted(&discovery).unwrap();
        assert!(
            !service
                .prepare("codex", "unbound")
                .unwrap()
                .unwrap()
                .refresh
        );
        store
            .change_project_thread_binding("bound", BindingChange::Bind("p"))
            .unwrap();
        let load = service.prepare("codex", "bound").unwrap().unwrap();
        assert!(load.needed);
        assert!(
            service.prepare("codex", "bound").unwrap().unwrap().needed,
            "failed sends can retry"
        );
        service.accepted(&load).unwrap();
        let restarted = ProjectDocSkill::new(store.clone(), root);
        assert!(!restarted.prepare("codex", "bound").unwrap().unwrap().needed);
        store
            .set_app_state(&load.key, "previous-version:p")
            .unwrap();
        assert!(restarted.prepare("codex", "bound").unwrap().unwrap().needed);
        restarted.accepted(&load).unwrap();
        assert!(
            restarted
                .prepare("claude", "bound")
                .unwrap()
                .unwrap()
                .needed
        );
        store
            .change_project_thread_binding("bound", BindingChange::Bind("other"))
            .unwrap();
        assert!(restarted.prepare("codex", "bound").unwrap().unwrap().needed);
        assert!(load
            .bundle
            .join("claude-plugin/skills/project-doc/bin/project-doc")
            .is_file());
        let output = std::process::Command::new(
            load.bundle
                .join("codex")
                .join(CODEX_NAME)
                .join("bin/project-doc"),
        )
        .arg("--help")
        .env("HOME", dir.path())
        .output()
        .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("supersede"));
    }

    #[test]
    fn native_registration_preserves_existing_skills_and_uses_discovered_path() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = materialize(&dir.path().join("bundles"), &bundle_version()).unwrap();
        let load = SkillLoad {
            bundle,
            needed: true,
            refresh: true,
            thread: "fixture".into(),
            key: String::new(),
            stamp: String::new(),
        };
        let home = dir.path().join(".codex");
        fs::create_dir_all(home.join("skills/project-doc")).unwrap();
        fs::write(home.join("skills/project-doc/keep"), "user-managed").unwrap();
        let path = load.register_codex(&home).unwrap();
        assert_eq!(load.register_codex(&home).unwrap(), path);
        assert_eq!(
            fs::read_to_string(home.join("skills/project-doc/keep")).unwrap(),
            "user-managed"
        );
        let listing = json!({"data":[{"skills":[{"name":CODEX_NAME,"path":path,"enabled":true}]}]});
        let native = discovered_skill(&listing, &path).unwrap();
        let mut params = json!({"input":[{"type":"text","text":"original"}]});
        add_codex_input(&mut params, native.clone()).unwrap();
        add_codex_input(&mut params, native).unwrap();
        assert_eq!(params["input"].as_array().unwrap().len(), 3);
        assert_eq!(params["input"][0]["text"], "original");
        assert!(discovered_skill(&json!({"data":[]}), &path).is_err());
        assert!(discovered_skill(
            &json!({"data":[{"skills":[{"name":CODEX_NAME,"path":path,"enabled":false}]}]}),
            &path
        )
        .is_err());
        let newer = SkillLoad {
            bundle: materialize(load.bundle.parent().unwrap(), "next-version").unwrap(),
            needed: true,
            refresh: true,
            thread: "fixture".into(),
            key: String::new(),
            stamp: String::new(),
        };
        let updated_path = newer.register_codex(&home).unwrap();
        assert_ne!(updated_path, path);
        assert!(path.is_file(), "keep old resources for resumed sessions");
        // A legacy user-managed Skill is not overwritten or required.
        let legacy = home.join("skills").join(CODEX_NAME);
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("mine"), "keep").unwrap();
        assert_eq!(load.register_codex(&home).unwrap(), path);
        assert_eq!(fs::read_to_string(legacy.join("mine")).unwrap(), "keep");
        // Refuse tampering with the versioned app-owned resource itself.
        fs::write(&path, "modified").unwrap();
        assert!(load.register_codex(&home).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "modified");
    }
    #[test]
    fn codex_resources_are_real_versioned_copies_independent_of_legacy_link() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = materialize(&dir.path().join("bundles"), &bundle_version()).unwrap();
        let load = SkillLoad {
            bundle,
            needed: true,
            refresh: true,
            thread: "fixture".into(),
            key: String::new(),
            stamp: String::new(),
        };
        let home = dir.path().join(".codex");
        fs::create_dir_all(home.join("skills")).unwrap();
        let legacy = home.join("skills").join(CODEX_NAME);
        std::os::unix::fs::symlink(load.bundle.join("codex").join(CODEX_NAME), &legacy).unwrap();
        let path = load.register_codex(&home).unwrap();
        assert!(
            path.starts_with(fs::canonicalize(home.join("skills")).unwrap()),
            "App must publish a real copy, not return the symlink target"
        );
        assert!(!fs::symlink_metadata(path.parent().unwrap())
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_file(legacy).unwrap();
        assert!(
            path.is_file(),
            "the active Skill must work without the legacy link"
        );
        assert!(
            load.bundle
                .join("codex")
                .join(CODEX_NAME)
                .join("SKILL.md")
                .is_file(),
            "old resources remain available to resumed sessions"
        );
        let output = std::process::Command::new(path.parent().unwrap().join("bin/project-doc"))
            .arg("--help")
            .env("HOME", dir.path())
            .output()
            .unwrap();
        assert!(output.status.success());
    }
}
