//! Release-owned native Skill and CLI. Real immutable copies, no global symlinks.
use crate::store::HarnessStore;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
const SKILL: &str = include_str!("../../.agents/skills/harness-runtime/SKILL.md");
const CLI: &str = include_str!("../../.agents/skills/harness-runtime/harnessctl.py");
const FILES: &[(&str, &str)] = &[
    ("SKILL.md", SKILL),
    ("harnessctl.py", CLI),
    (
        "references/management.md",
        include_str!("../../.agents/skills/harness-runtime/references/management.md"),
    ),
    (
        "references/async-waits.md",
        include_str!("../../.agents/skills/harness-runtime/references/async-waits.md"),
    ),
];
pub const NAME: &str = "harness-runtime";

/// Pure background model requests must not receive Harness management instructions.
pub fn should_load(method: &str, trigger: Option<&str>) -> bool {
    method == "turn/start"
        && !matches!(
            trigger,
            Some(
                "thread-title"
                    | "recap"
                    | "memory-save"
                    | "workspace-router"
                    | "workspace-router-summary"
            )
        )
}

pub struct RuntimeSkill {
    store: Arc<HarnessStore>,
}
pub struct SkillLoad {
    pub path: PathBuf,
    key: String,
    stamp: String,
}
fn version() -> String {
    crate::bundled_skill::version(FILES)
}
impl RuntimeSkill {
    pub fn new(store: Arc<HarnessStore>) -> Self {
        Self { store }
    }
    pub fn prepare(&self, home: &Path, thread: &str) -> Result<Option<SkillLoad>, String> {
        let stamp = version();
        let key = format!("runtimeSkillLoaded:codex:{thread}");
        if self.store.get_app_state(&key)?.as_deref() == Some(stamp.as_str()) {
            return Ok(None);
        }
        let path = materialize(home, &stamp)?;
        Ok(Some(SkillLoad { path, key, stamp }))
    }
    pub fn accepted(&self, load: &SkillLoad) -> Result<(), String> {
        self.store.set_app_state(&load.key, &load.stamp)
    }
}
fn materialize(home: &Path, version: &str) -> Result<PathBuf, String> {
    let target = home
        .join("skills")
        .join(format!("harness-runtime-{version}"));
    crate::bundled_skill::materialize(&target, FILES, &[])
        .map(|root| root.join("SKILL.md"))
        .map_err(|error| format!("无法准备 Harness 原生 Skill: {error}"))
}
pub fn add_input(params: &mut Value, listing: &Value, path: &Path) -> Result<(), String> {
    let found = listing["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|d| d["skills"].as_array().into_iter().flatten())
        .find(|s| {
            s["name"] == NAME
                && s["path"].as_str() == path.to_str()
                && s["enabled"].as_bool() != Some(false)
        })
        .ok_or("Codex 未发现 Harness 原生 Skill，请检查 Skills 配置")?;
    let input = params["input"]
        .as_array_mut()
        .ok_or("turn/start 缺少 input")?;
    if !input
        .iter()
        .any(|i| i["type"] == "skill" && i["path"] == found["path"])
    {
        input.push(json!({"type":"skill", "name":NAME, "path":found["path"]}));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn loads_management_for_conversations_but_not_background_model_requests() {
        for trigger in [
            None,
            Some("conversation"),
            Some("async-wait"),
            Some("quick-agent"),
        ] {
            assert!(should_load("turn/start", trigger));
        }
        for trigger in [
            "thread-title",
            "recap",
            "memory-save",
            "workspace-router",
            "workspace-router-summary",
        ] {
            assert!(
                !should_load("turn/start", Some(trigger)),
                "background {trigger} must stay independent of management Skills"
            );
        }
        assert!(!should_load("turn/steer", None));
    }
    #[test]
    fn ships_real_self_contained_files_and_marks_only_accepted_turns() {
        let d = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(d.path().join("state")).unwrap());
        let service = RuntimeSkill::new(store.clone());
        let load = service.prepare(d.path(), "thread-a").unwrap().unwrap();
        assert!(!fs::symlink_metadata(&load.path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(load.path.with_file_name("harnessctl.py")).unwrap(),
            CLI
        );
        assert!(service.prepare(d.path(), "thread-a").unwrap().is_some());
        service.accepted(&load).unwrap();
        assert!(RuntimeSkill::new(store)
            .prepare(d.path(), "thread-a")
            .unwrap()
            .is_none());
        assert!(service.prepare(d.path(), "thread-b").unwrap().is_some());
    }
    #[test]
    fn requires_provider_discovery_and_preserves_user_input() {
        let mut p = json!({"input":[{"type":"text","text":"hello"}]});
        let path = Path::new("/real path/SKILL.md");
        assert!(add_input(&mut p, &json!({"data":[]}), path).is_err());
        let listing = json!({"data":[{"skills":[{"name":NAME,"path":path,"enabled":true}]}]});
        add_input(&mut p, &listing, path).unwrap();
        add_input(&mut p, &listing, path).unwrap();
        assert_eq!(p["input"].as_array().unwrap().len(), 2);
        assert_eq!(p["input"][0]["text"], "hello");
    }
    #[test]
    fn ships_references_and_refuses_substituted_reference_directories() {
        let dir = tempfile::tempdir().unwrap();
        let skill = materialize(dir.path(), &version()).unwrap();
        let root = skill.parent().unwrap();
        for (name, content) in FILES {
            assert_eq!(fs::read_to_string(root.join(name)).unwrap(), *content);
        }
        fs::write(root.join("references/management.md"), "modified").unwrap();
        assert!(materialize(dir.path(), &version()).is_err());
        fs::remove_dir_all(root.join("references")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        for (name, content) in FILES
            .iter()
            .filter(|(name, _)| name.starts_with("references/"))
        {
            fs::write(
                outside.path().join(Path::new(name).file_name().unwrap()),
                content,
            )
            .unwrap();
        }
        std::os::unix::fs::symlink(outside.path(), root.join("references")).unwrap();
        assert!(materialize(dir.path(), &version()).is_err());
    }
}
