use super::{err, names, recover, register_workspace, valid_name};
use crate::store::HarnessStore;
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDomainBinding {
    workspace_name: String,
    workspace_root: Option<String>,
    domains: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct MemoryDomainSettings {
    domains: Vec<String>,
    bindings: Vec<MemoryDomainBinding>,
}

pub(super) fn workspace_domains(
    connection: &Connection,
    workspace: &str,
) -> Result<Vec<String>, String> {
    let mut query = connection.prepare("SELECT domain_name FROM memory_domain_workspaces WHERE workspace_name=?1 ORDER BY domain_name").map_err(err)?;
    let result = query
        .query_map([workspace], |row| row.get(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(result)
}

impl HarnessStore {
    pub fn memory_domain_settings(&self) -> Result<MemoryDomainSettings, String> {
        let mut connection = self.connection.lock().map_err(err)?;
        let tx = connection.transaction().map_err(err)?;
        let domains = names(&tx, "SELECT name FROM memory_domains ORDER BY name")?;
        let mut bindings = Vec::new();
        {
            let mut query = tx
                .prepare("SELECT name, git_root FROM memory_workspaces ORDER BY name")
                .map_err(err)?;
            let workspaces = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(err)?;
            for workspace in workspaces {
                let (workspace_name, workspace_root) = workspace.map_err(err)?;
                let domains = workspace_domains(&tx, &workspace_name)?;
                bindings.push(MemoryDomainBinding {
                    workspace_name,
                    workspace_root,
                    domains,
                });
            }
        }
        tx.commit().map_err(err)?;
        Ok(MemoryDomainSettings { domains, bindings })
    }

    pub fn memory_create_domain(&self, name: &str) -> Result<(), String> {
        let name = name.trim();
        valid_name(name)?;
        let mut connection = self.connection.lock().map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let existing = names(&tx, "SELECT name FROM memory_domains")?;
        if existing
            .iter()
            .any(|old| old.to_lowercase() == name.to_lowercase())
        {
            return Err("领域名称已存在（不区分大小写）".into());
        }
        tx.execute("INSERT INTO memory_domains(name) VALUES (?1)", [name])
            .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Removing a domain unregisters it and its bindings. Knowledge files stay intact.
    pub fn memory_delete_domain(&self, name: &str) -> Result<(), String> {
        valid_name(name)?;
        let mut connection = self.connection.lock().map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        recover(&self.root)?;
        tx.execute(
            "DELETE FROM memory_domain_workspaces WHERE domain_name=?1",
            [name],
        )
        .map_err(err)?;
        if tx
            .execute("DELETE FROM memory_domains WHERE name=?1", [name])
            .map_err(err)?
            == 0
        {
            return Err("领域已不存在，请刷新后重试".into());
        }
        tx.commit().map_err(err)
    }

    /// A delta update avoids overwriting tags changed by another window.
    pub fn memory_set_domain_binding(
        &self,
        workspace_root: Option<&str>,
        domain: &str,
        linked: bool,
    ) -> Result<(), String> {
        valid_name(domain)?;
        let workspace = match workspace_root {
            Some(root) => Some(
                self.list_workspaces()?
                    .into_iter()
                    .find(|item| item.root == root)
                    .ok_or("工作区已不存在，请刷新后重试")?,
            ),
            None => None,
        };
        let mut connection = self.connection.lock().map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        recover(&self.root)?;
        if !names(&tx, "SELECT name FROM memory_domains")?
            .iter()
            .any(|name| name == domain)
        {
            return Err("领域已不存在，请刷新后重试".into());
        }
        let name = match workspace {
            Some(workspace) => register_workspace(&tx, &workspace.name, Some(&workspace.root))?,
            None => register_workspace(&tx, "other", None)?,
        };
        if linked {
            tx.execute("INSERT OR IGNORE INTO memory_domain_workspaces(domain_name,workspace_name) VALUES (?1,?2)",params![domain,name]).map_err(err)?;
        } else {
            tx.execute(
                "DELETE FROM memory_domain_workspaces WHERE domain_name=?1 AND workspace_name=?2",
                params![domain, name],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};
    #[test]
    fn manages_unique_domains_and_many_to_many_tags_without_deleting_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().join("data")).unwrap();
        store.upsert_workspace("/test/a", "a").unwrap();
        store.upsert_workspace("/test/b", "b").unwrap();
        store.memory_create_domain(" DNS ").unwrap();
        store.memory_create_domain("ADR").unwrap();
        assert!(store.memory_create_domain("dns").is_err());
        assert!(store.memory_create_domain("../escape").is_err());
        for (root, domain) in [("/test/a", "DNS"), ("/test/a", "ADR"), ("/test/b", "DNS")] {
            store
                .memory_set_domain_binding(Some(root), domain, true)
                .unwrap();
        }
        store
            .memory_set_domain_binding(Some("/test/a"), "DNS", true)
            .unwrap();
        let snapshot = store.memory_domain_settings().unwrap();
        assert_eq!(snapshot.bindings[0].domains, vec!["ADR", "DNS"]);
        assert_eq!(snapshot.bindings[1].domains, vec!["DNS"]);
        store
            .memory_set_domain_binding(Some("/test/a"), "DNS", false)
            .unwrap();
        let snapshot = store.memory_domain_settings().unwrap();
        assert_eq!(snapshot.bindings[0].domains, vec!["ADR"]);
        assert_eq!(snapshot.bindings[1].domains, vec!["DNS"]);
        fs::create_dir_all(store.root.join("memory/domain/DNS")).unwrap();
        fs::write(
            store.root.join("memory/domain/DNS/MEMORY.md"),
            "keep knowledge",
        )
        .unwrap();
        store.memory_delete_domain("DNS").unwrap();
        let snapshot = store.memory_domain_settings().unwrap();
        assert_eq!(snapshot.domains, vec!["ADR"]);
        assert!(snapshot.bindings[1].domains.is_empty());
        assert_eq!(
            fs::read_to_string(store.root.join("memory/domain/DNS/MEMORY.md")).unwrap(),
            "keep knowledge"
        );
        assert!(store
            .memory_set_domain_binding(Some("/test/a"), "DNS", true)
            .is_err());
        assert!(store
            .memory_set_domain_binding(Some("/invented"), "ADR", true)
            .is_err());
        store.memory_set_domain_binding(None, "ADR", true).unwrap();
        assert!(store
            .memory_domain_settings()
            .unwrap()
            .bindings
            .iter()
            .any(|binding| binding.workspace_root.is_none() && binding.domains == vec!["ADR"]));
        drop(store);
        let reopened = HarnessStore::open_at(dir.path().join("data")).unwrap();
        assert_eq!(
            reopened.memory_domain_settings().unwrap().domains,
            vec!["ADR"]
        );
    }
    #[test]
    fn linked_worktrees_share_tags_and_catalog_excludes_unrelated_domains() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let linked = dir.path().join("linked");
        git(&["worktree", "add", "--detach", linked.to_str().unwrap()]);
        let store = HarnessStore::open_at(dir.path().join("data")).unwrap();
        let resolved = crate::git_workspace::resolve_workspace(repo.to_str().unwrap()).unwrap();
        store
            .upsert_workspace(&resolved.root, &resolved.name)
            .unwrap();
        store.memory_create_domain("DNS").unwrap();
        store.memory_create_domain("ADR").unwrap();
        store
            .memory_set_domain_binding(Some(&resolved.root), "DNS", true)
            .unwrap();
        let main =
            serde_json::to_value(store.memory_catalog(repo.to_str().unwrap()).unwrap()).unwrap();
        let worktree =
            serde_json::to_value(store.memory_catalog(linked.to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(main["currentWorkspace"], worktree["currentWorkspace"]);
        assert_eq!(worktree["domains"], serde_json::json!(["DNS"]));
        store
            .memory_set_domain_binding(Some(&resolved.root), "DNS", false)
            .unwrap();
        let catalog =
            serde_json::to_value(store.memory_catalog(linked.to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(catalog["domains"], serde_json::json!([]));
    }
}
