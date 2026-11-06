//! Release-owned native Skill and CLI. Real immutable copies, no global symlinks.
use crate::store::HarnessStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
const SKILL: &str = include_str!("../../.agents/skills/harness-runtime/SKILL.md");
const CLI: &str = include_str!("../../.agents/skills/harness-runtime/harnessctl.py");
pub const NAME: &str = "harness-runtime";

pub struct RuntimeSkill {
    store: Arc<HarnessStore>,
}
pub struct SkillLoad {
    pub path: PathBuf,
    key: String,
    stamp: String,
}
fn version() -> String {
    let hash = SKILL
        .bytes()
        .chain(CLI.bytes())
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
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
    let run = || -> std::io::Result<PathBuf> {
        let skills = home.join("skills");
        fs::create_dir_all(&skills)?;
        let target = skills.join(format!("harness-runtime-{version}"));
        if !target.exists() {
            let stage = tempfile::tempdir_in(&skills)?;
            fs::write(stage.path().join("SKILL.md"), SKILL)?;
            fs::write(stage.path().join("harnessctl.py"), CLI)?;
            if let Err(error) = fs::rename(stage.path(), &target) {
                if !target.is_dir() {
                    return Err(error);
                }
            }
        }
        // Refuse substituted bundles, including symlinks; do not overwrite user content.
        if fs::symlink_metadata(&target)?.file_type().is_symlink()
            || fs::symlink_metadata(target.join("SKILL.md"))?
                .file_type()
                .is_symlink()
            || fs::symlink_metadata(target.join("harnessctl.py"))?
                .file_type()
                .is_symlink()
            || fs::read_to_string(target.join("SKILL.md"))? != SKILL
            || fs::read_to_string(target.join("harnessctl.py"))? != CLI
        {
            return Err(std::io::Error::other("应用 Skill 副本已被修改，请核对"));
        }
        fs::canonicalize(target.join("SKILL.md"))
    };
    run().map_err(|e| format!("无法准备 Harness 原生 Skill: {e}"))
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
}
