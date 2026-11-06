//! Application-owned copies of the Git-maintained Skill. No prompt injection or global
//! extraRoots replacement: providers discover these files and load them natively.
use crate::store::HarnessStore;
use serde_json::{json, Value};
use std::{
    fs,
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
        let stamp = format!("{version}:{}", binding.as_ref().map(|b|b.project_id.as_str()).unwrap_or("unbound"));
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

fn bundle_version() -> String {
    // Stable content fingerprint, not a security digest. Include both provider layouts.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in SKILL
        .bytes()
        .chain(CLI.bytes())
        .chain(COMMAND.bytes())
        .chain(PLUGIN.bytes())
        .chain(CODEX_NAME.bytes())
    {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn write_skill(dir: &Path, text: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir.join("bin"))?;
    fs::write(dir.join("SKILL.md"), text)?;
    fs::write(dir.join("project_doc.py"), CLI)?;
    fs::write(dir.join("bin/project-doc"), COMMAND)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            dir.join("bin/project-doc"),
            fs::Permissions::from_mode(0o755),
        )?;
    }
    Ok(())
}

fn materialize(root: &Path, version: &str) -> Result<PathBuf, String> {
    let run = || -> std::io::Result<PathBuf> {
        fs::create_dir_all(root)?;
        let target = root.join(version);
        if !target.exists() {
            let staging = tempfile::tempdir_in(root)?;
            // A native alias avoids colliding with the old user-installed project-doc.
            // The instructions and command come from the same authoritative source.
            write_skill(
                &staging.path().join("codex").join(CODEX_NAME),
                &SKILL.replacen("name: project-doc\n", "name: harness-project-doc\n", 1),
            )?;
            let plugin = staging.path().join("claude-plugin");
            write_skill(&plugin.join("skills/project-doc"), SKILL)?;
            fs::create_dir_all(plugin.join(".claude-plugin"))?;
            fs::write(plugin.join(".claude-plugin/plugin.json"), PLUGIN)?;
            // Atomic publication; another Harness process can publish the same bundle.
            if let Err(error) = fs::rename(staging.path(), &target) {
                if !target.is_dir() {
                    return Err(error);
                }
            }
        }
        fs::canonicalize(target)
    };
    run().map_err(|e| format!("无法准备项目文档 Skill: {e}"))
}

impl SkillLoad {
    pub fn claude_params(&self) -> Value {
        json!({ "pluginRoot": self.bundle.join("claude-plugin"), "invoke": self.needed, "sourceThreadId": if self.refresh { Some(&self.thread) } else { None } })
    }

    /// Register only our own native user-Skill link, leaving every other Skill and
    /// daemon search root alone. Keep immutable old bundles for resumed sessions.
    #[cfg(unix)]
    pub fn register_codex(&self, codex_home: &Path) -> Result<PathBuf, String> {
        let run = || -> std::io::Result<PathBuf> {
            let skills = codex_home.join("skills");
            fs::create_dir_all(&skills)?;
            let link = skills.join(CODEX_NAME);
            let target = self.bundle.join("codex").join(CODEX_NAME);
            match fs::symlink_metadata(&link) {
                Ok(meta) => {
                    let old = fs::canonicalize(&link)?;
                    if old == target {
                        return fs::canonicalize(target.join("SKILL.md"));
                    }
                    let cache = self.bundle.parent().expect("versioned bundle has parent");
                    if !meta.file_type().is_symlink()
                        || !old.starts_with(cache)
                        || !old.ends_with(Path::new("codex").join(CODEX_NAME))
                    {
                        return Err(std::io::Error::other(
                            "harness-project-doc 已被其他 Skill 占用",
                        ));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            let staging = tempfile::tempdir_in(&skills)?;
            let next = staging.path().join("skill");
            std::os::unix::fs::symlink(&target, &next)?;
            fs::rename(next, link)?;
            fs::canonicalize(target.join("SKILL.md"))
        };
        run().map_err(|e| format!("无法注册项目文档原生 Skill: {e}"))
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

    #[test]
    fn binding_success_and_version_control_native_loading_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(dir.path().join("state")).unwrap());
        let root = dir.path().join("bundles with spaces");
        let service = ProjectDocSkill::new(store.clone(), root.clone());
        let discovery = service.prepare("codex", "unbound").unwrap().unwrap();
        assert!(!discovery.needed); assert!(discovery.refresh);
        service.accepted(&discovery).unwrap();
        assert!(!service.prepare("codex", "unbound").unwrap().unwrap().refresh);
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
        let link = home.join("skills").join(CODEX_NAME);
        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        fs::write(link.join("mine"), "keep").unwrap();
        assert!(load.register_codex(&home).is_err());
        assert_eq!(fs::read_to_string(link.join("mine")).unwrap(), "keep");
    }
}
