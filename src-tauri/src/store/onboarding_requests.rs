//! Pending choices only: no transcripts or generated document content.
use super::*;
const PREFIX: &str = "projectOnboardingRequest:";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredOnboardingRequest {
    pub id: String,
    pub thread_id: String,
    pub mode: String,
    pub name: String,
    pub project_id: String,
    pub requested_by: String,
    pub phase: String,
    pub auto_confirm_at: Option<i64>,
    pub instance_id: Option<String>,
}
impl HarnessStore {
    pub fn project_onboarding_requests(&self) -> Result<Vec<StoredOnboardingRequest>, String> {
        let db = self.connection.lock().map_err(|_| "状态库锁不可用")?;
        let mut query=db.prepare("SELECT state_key,state_value FROM app_state WHERE state_key LIKE 'projectOnboardingRequest:%' AND state_value<>''").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut requests = Vec::new();
        for row in rows {
            let (key, value) = row.map_err(|e| e.to_string())?;
            let Ok(request) = serde_json::from_str::<StoredOnboardingRequest>(&value) else {
                continue;
            };
            if key != format!("{PREFIX}{}", request.id)
                || request.id.is_empty()
                || request.thread_id.is_empty()
                || !matches!(request.mode.as_str(), "create" | "join")
                || !matches!(request.phase.as_str(), "confirm" | "error" | "interrupted")
                || !matches!(request.requested_by.as_str(), "user" | "agent")
            {
                continue;
            }
            requests.push(request);
        }
        Ok(requests)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_only_valid_pending_choices_and_keeps_other_state_separate() {
        let dir = tempfile::tempdir().unwrap();
        let store = HarnessStore::open_at(dir.path().into()).unwrap();
        let value=serde_json::json!({"id":"r","threadId":"t","mode":"create","name":"项目","projectId":"","requestedBy":"agent","phase":"confirm","autoConfirmAt":123,"instanceId":"host"}).to_string();
        store
            .set_app_state("projectOnboardingRequest:r", &value)
            .unwrap();
        store.set_app_state("unrelated", &value).unwrap();
        store
            .set_app_state("projectOnboardingRequest:bad", "{}")
            .unwrap();
        assert_eq!(store.project_onboarding_requests().unwrap().len(), 1);
        store
            .set_app_state("projectOnboardingRequest:r", "")
            .unwrap();
        assert!(store.project_onboarding_requests().unwrap().is_empty());
        assert_eq!(store.get_app_state("unrelated").unwrap(), Some(value));
    }
}
