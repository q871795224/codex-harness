use super::HarnessStore;
use crate::workspace_router_context::{snapshot, truncate};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

const DAY: i64 = 24 * 60 * 60 * 1000;
const LEASE: i64 = 5 * 60 * 1000;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryState {
    pub root: String,
    pub checkout_root: String,
    pub description: String,
    pub checked_at: i64,
    pub generated_at: Option<i64>,
    pub error: bool,
    #[serde(default)]
    description_file: Option<String>,
    #[serde(default)]
    fingerprint: String,
    #[serde(default)]
    pending_fingerprint: String,
    #[serde(default)]
    lease: Option<String>,
    #[serde(default)]
    lease_until: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouterSummary {
    root: String,
    checkout_root: String,
    pub description: String,
    checked_at: i64,
    generated_at: Option<i64>,
    pub error: bool,
    updating: bool,
    next_check_at: Option<i64>,
}
impl SummaryState {
    fn view(self, now: i64) -> RouterSummary {
        RouterSummary {
            updating: self.lease.is_some() && self.lease_until > now,
            next_check_at: if self.lease.is_some() {
                Some(self.lease_until)
            } else {
                (self.checked_at > 0).then_some(self.checked_at + DAY)
            },
            root: self.root,
            checkout_root: self.checkout_root,
            description: self.description,
            checked_at: self.checked_at,
            generated_at: self.generated_at,
            error: self.error,
        }
    }
}
#[derive(Serialize)]
pub(crate) struct SummaryClaim {
    lease: String,
    source: String,
}
fn key(root: &str) -> String {
    format!("workspace-router.summary:{root}")
}
fn read(
    connection: &Connection,
    data_dir: &std::path::Path,
    root: &str,
) -> Result<SummaryState, String> {
    let text: Option<String> = connection
        .query_row(
            "SELECT state_value FROM app_state WHERE state_key=?1",
            [key(root)],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut cache: SummaryState = match text {
        Some(t) => serde_json::from_str(&t).map_err(|_| "工作区简介缓存损坏")?,
        None => SummaryState {
            root: root.into(),
            ..Default::default()
        },
    };
    if let Some(file) = &cache.description_file {
        if file.len() != 32 || !file.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("工作区简介文件标识无效".into());
        }
        cache.description = std::fs::read_to_string(data_dir.join("router-summaries").join(file))
            .map_err(|_| "无法读取简介缓存文件")?;
    }
    Ok(cache)
}
fn write(connection: &Connection, state: &SummaryState, now: i64) -> Result<(), String> {
    let mut metadata = state.clone();
    metadata.description.clear(); // Model-derived text lives in files, never in state.sqlite.
    let text = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;
    connection.execute("INSERT INTO app_state(state_key,state_value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value,updated_at=excluded.updated_at", params![key(&state.root), text, now]).map_err(|e| e.to_string())?;
    Ok(())
}
impl HarnessStore {
    pub(crate) fn router_corrections(&self) -> Result<Vec<serde_json::Value>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let mut query = connection.prepare("SELECT state_value FROM app_state WHERE state_key LIKE 'workspace-router.attempt:%' AND json_valid(state_value) AND json_extract(state_value, '$.feedback')='inaccurate' ORDER BY COALESCE(json_extract(state_value, '$.history[#-1].at'),updated_at) DESC, state_key DESC LIMIT 20").map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let value: serde_json::Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if !value["threadId"].is_string()
                || !value["sourceTurnId"].is_string()
                || !value["sourceMessageId"].is_string()
                || value["status"] != "started"
            {
                continue;
            }
            result.push(serde_json::json!({"threadId": value["threadId"], "sourceTurnId": value["sourceTurnId"], "sourceMessageId": value["sourceMessageId"], "wrong": value["choice"]["primary"], "correct": value["actualWorkspace"]}));
        }
        Ok(result)
    }
    pub(crate) fn router_feedback(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        let limit = limit.clamp(1, 100);
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let mut query = connection.prepare("SELECT state_key,state_value,updated_at FROM app_state WHERE state_key LIKE 'workspace-router.attempt:%' AND json_valid(state_value) AND json_extract(state_value,'$.feedback') IN ('accurate','inaccurate') ORDER BY COALESCE(json_extract(state_value,'$.history[#-1].at'),updated_at) DESC,state_key DESC LIMIT ?1 OFFSET ?2").map_err(|e| e.to_string())?;
        let rows = query
            .query_map(params![limit + 1, offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        for row in rows {
            let (key, text, updated) = row.map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let at = v["history"]
                .as_array()
                .and_then(|h| h.last())
                .and_then(|h| h["at"].as_i64())
                .unwrap_or(updated);
            data.push(serde_json::json!({"id":v["id"].as_str().unwrap_or(&key),"threadId":v["threadId"],"sourceTurnId":v["sourceTurnId"],"sourceMessageId":v["sourceMessageId"],"chosen":v["choice"]["primary"],"correct":if v["feedback"]=="accurate" { &v["choice"]["primary"] } else { &v["actualWorkspace"] },"feedback":v["feedback"],"at":at}));
        }
        let has_more = data.len() > limit;
        data.truncate(limit);
        Ok(serde_json::json!({"data":data,"hasMore":has_more}))
    }
    pub(crate) fn router_summaries(&self, roots: &[String]) -> Result<Vec<RouterSummary>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        roots
            .iter()
            .map(|root| {
                read(&connection, &self.root, root).map(|cache| cache.view(super::now_ms()))
            })
            .collect()
    }
    #[cfg(test)]
    fn claim_router_summary(
        &self,
        root: &str,
        checkout: &str,
        now: i64,
    ) -> Result<Option<SummaryClaim>, String> {
        self.check_router_summary(root, checkout, now, false)
    }
    pub(crate) fn check_router_summary(
        &self,
        root: &str,
        checkout: &str,
        now: i64,
        check_now: bool,
    ) -> Result<Option<SummaryClaim>, String> {
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let mut cache = read(&tx, &self.root, root)?;
        if cache.lease.is_some() && cache.lease_until > now {
            return Ok(None);
        }
        if !check_now
            && cache.lease.is_none()
            && cache.checkout_root == checkout
            && cache.checked_at > 0
            && now < cache.checked_at + DAY
        {
            return Ok(None);
        }
        let (fingerprint, source) = snapshot(checkout)?;
        cache.checkout_root = checkout.into();
        cache.checked_at = now;
        if cache.fingerprint == fingerprint || source.trim().is_empty() {
            if source.trim().is_empty() {
                cache.description.clear();
                cache.description_file = None;
                cache.generated_at = Some(now);
            }
            cache.fingerprint = fingerprint;
            cache.lease = None;
            cache.error = false;
            write(&tx, &cache, now)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(None);
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let lease: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        cache.lease = Some(lease.clone());
        cache.pending_fingerprint = fingerprint;
        cache.lease_until = now + LEASE;
        write(&tx, &cache, now)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some(SummaryClaim { lease, source }))
    }
    pub(crate) fn finish_router_summary(
        &self,
        root: &str,
        lease: &str,
        description: Option<&str>,
        now: i64,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let mut cache = read(&tx, &self.root, root)?;
        if cache.lease.as_deref() != Some(lease) || now > cache.lease_until {
            return Err("工作区简介任务已过期".into());
        }
        cache.lease = None;
        cache.error = description.is_none_or(|d| d.trim().is_empty());
        if let Some(text) = description.filter(|s| !s.trim().is_empty()) {
            if snapshot(&cache.checkout_root)?.0 != cache.pending_fingerprint {
                cache.checked_at = 0;
                cache.error = true;
                write(&tx, &cache, now)?;
                tx.commit().map_err(|e| e.to_string())?;
                return Err("工作区文档已变化，保留旧简介，下次重新检查".into());
            }
            cache.description = truncate(text.trim(), 192);
            let dir = self.root.join("router-summaries");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut file, cache.description.as_bytes())
                .map_err(|e| e.to_string())?;
            file.as_file().sync_all().map_err(|e| e.to_string())?;
            file.persist(dir.join(lease)).map_err(|e| e.to_string())?;
            cache.description_file = Some(lease.into());
            cache.fingerprint = cache.pending_fingerprint.clone();
            cache.generated_at = Some(now);
        }
        write(&tx, &cache, now)?;
        tx.commit().map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn correction_catalog_excludes_implicit_acceptance_and_never_copies_message_text() {
        let data = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(data.path().into()).unwrap();
        for (id, feedback) in [
            ("implicit", "implicit-accurate"),
            ("explicit", "accurate"),
            ("correction", "inaccurate"),
        ] {
            let value = serde_json::json!({"threadId":id,"sourceTurnId":"turn","sourceMessageId":"message","feedback":feedback,"status":"started","choice":{"primary":"/wrong"},"actualWorkspace":"/correct"});
            store
                .set_app_state(
                    &format!("workspace-router.attempt:{id}"),
                    &value.to_string(),
                )
                .unwrap();
        }
        let cases = store.router_corrections().unwrap();
        assert_eq!(
            cases,
            vec![
                serde_json::json!({"threadId":"correction","sourceTurnId":"turn","sourceMessageId":"message","wrong":"/wrong","correct":"/correct"})
            ]
        );
    }
    #[test]
    fn manual_check_bypasses_daily_wait_but_still_skips_unchanged_content_and_active_leases() {
        let data = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let path = checkout.path().to_str().unwrap();
        let file = checkout.path().join("README.md");
        std::fs::write(&file, "before").unwrap();
        let store = HarnessStore::open_at(data.path().into()).unwrap();
        let first = store
            .check_router_summary("root", path, 1, true)
            .unwrap()
            .unwrap();
        assert!(store
            .check_router_summary("root", path, 2, true)
            .unwrap()
            .is_none());
        store
            .finish_router_summary("root", &first.lease, Some("old"), 3)
            .unwrap();
        assert!(store
            .check_router_summary("root", path, 4, true)
            .unwrap()
            .is_none());
        std::fs::write(file, "after").unwrap();
        assert!(store
            .check_router_summary("root", path, 5, false)
            .unwrap()
            .is_none());
        let second = store
            .check_router_summary("root", path, 6, true)
            .unwrap()
            .unwrap();
        store
            .finish_router_summary("root", &second.lease, Some("updated"), 7)
            .unwrap();
        assert_eq!(
            store.router_summaries(&["root".into()]).unwrap()[0].description,
            "updated"
        );
    }
    #[test]
    fn summary_view_exposes_schedule_without_leaking_generation_lease() {
        let view = SummaryState {
            root: "root".into(),
            checked_at: 100,
            lease: Some("private-lease".into()),
            lease_until: 500,
            ..Default::default()
        }
        .view(200);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["updating"], true);
        assert_eq!(json["nextCheckAt"], 500);
        assert!(json.get("lease").is_none());
        let idle = SummaryState {
            checked_at: 100,
            ..Default::default()
        }
        .view(200);
        assert_eq!(idle.next_check_at, Some(100 + DAY));
    }
    #[test]
    fn feedback_pages_use_explicit_vote_time_and_return_metadata_only() {
        let data = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(data.path().into()).unwrap();
        for (id, feedback, at) in [
            ("old", "accurate", 100),
            ("new", "inaccurate", 200),
            ("implicit", "implicit-accurate", 300),
        ] {
            let value = serde_json::json!({"id":id,"threadId":"thread","sourceTurnId":"turn","sourceMessageId":"message","status":"started","feedback":feedback,"choice":{"primary":"/a"},"actualWorkspace":"/b","history":[{"at":at}],"private":"not in output"});
            store
                .set_app_state(
                    &format!("workspace-router.attempt:{id}"),
                    &value.to_string(),
                )
                .unwrap();
        }
        let first = store.router_feedback(0, 1).unwrap();
        assert_eq!(first["data"][0]["id"], "new");
        assert_eq!(first["hasMore"], true);
        assert!(!first.to_string().contains("not in output"));
        let second = store.router_feedback(1, 1).unwrap();
        assert_eq!(second["data"][0]["id"], "old");
        assert_eq!(second["hasMore"], false);
        assert_eq!(second["data"][0]["correct"], "/a");
    }
    #[test]
    fn daily_checks_only_generate_for_changed_content_and_persist_across_connections() {
        let data = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let path = checkout.path().to_str().unwrap();
        let file = checkout.path().join("README.md");
        std::fs::write(&file, "DNS API management").unwrap();
        let a = HarnessStore::open_at(data.path().into()).unwrap();
        let b = HarnessStore::open_at(data.path().into()).unwrap();
        let job = a.claim_router_summary("root", path, 1).unwrap().unwrap();
        assert!(b.claim_router_summary("root", path, 2).unwrap().is_none());
        a.finish_router_summary("root", &job.lease, Some("DNS management"), 3)
            .unwrap();
        assert_eq!(
            b.router_summaries(&["root".into()]).unwrap()[0].description,
            "DNS management"
        );
        assert!(!a
            .get_app_state(&key("root"))
            .unwrap()
            .unwrap()
            .contains("DNS management"));
        std::fs::write(&file, "DNS API changed").unwrap();
        assert!(b
            .claim_router_summary("root", path, DAY - 1)
            .unwrap()
            .is_none());
        let next = b
            .claim_router_summary("root", path, DAY + 2)
            .unwrap()
            .unwrap();
        b.finish_router_summary("root", &next.lease, Some("updated"), DAY + 3)
            .unwrap();
        assert!(a
            .claim_router_summary("root", path, 2 * DAY + 3)
            .unwrap()
            .is_none());
    }
    #[test]
    fn failed_generation_preserves_old_summary_and_checks_again_next_day() {
        let data = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let path = checkout.path().to_str().unwrap();
        let file = checkout.path().join("AGENTS.md");
        std::fs::write(&file, "initial").unwrap();
        let store = HarnessStore::open_at(data.path().into()).unwrap();
        let a = store
            .claim_router_summary("root", path, 1)
            .unwrap()
            .unwrap();
        store
            .finish_router_summary("root", &a.lease, Some("old"), 2)
            .unwrap();
        std::fs::write(file, "new").unwrap();
        let b = store
            .claim_router_summary("root", path, DAY + 2)
            .unwrap()
            .unwrap();
        store
            .finish_router_summary("root", &b.lease, None, DAY + 3)
            .unwrap();
        let cache = store.router_summaries(&["root".into()]).unwrap().remove(0);
        assert_eq!(cache.description, "old");
        assert!(cache.error);
        assert!(store
            .claim_router_summary("root", path, DAY + 4)
            .unwrap()
            .is_none());
        assert!(store
            .claim_router_summary("root", path, 2 * DAY + 3)
            .unwrap()
            .is_some());
    }
    #[test]
    fn stale_worker_and_inflight_document_changes_cannot_overwrite_cache() {
        let data = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let path = checkout.path().to_str().unwrap();
        let file = checkout.path().join("README.md");
        std::fs::write(&file, "before").unwrap();
        let store = HarnessStore::open_at(data.path().into()).unwrap();
        let a = store
            .claim_router_summary("root", path, 1)
            .unwrap()
            .unwrap();
        let b = store
            .claim_router_summary("root", path, LEASE + 2)
            .unwrap()
            .unwrap();
        assert!(store
            .finish_router_summary("root", &a.lease, Some("stale"), LEASE + 3)
            .is_err());
        std::fs::write(file, "after").unwrap();
        assert!(store
            .finish_router_summary("root", &b.lease, Some("old result"), LEASE + 4)
            .is_err());
        assert!(store.router_summaries(&["root".into()]).unwrap()[0]
            .description
            .is_empty());
        assert!(store
            .claim_router_summary("root", path, LEASE + 5)
            .unwrap()
            .is_some());
    }
}
