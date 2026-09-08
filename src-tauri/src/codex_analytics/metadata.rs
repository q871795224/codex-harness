use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: String,
    pub title: Option<String>,
    pub cwd: String,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsage {
    pub estimated_usage_credits_micros: i64,
    pub estimated_usage_usd_micros: Option<i64>,
    pub groups: Vec<UsageGroup>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub model: Option<String>,
    pub total_tokens: Option<u64>,
    pub estimated_usage_credits_micros: i64,
}
impl CodexAnalytics {
    pub fn metadata_candidates(&self) -> Result<Vec<String>, String> {
        let db = open_connection(&self.database_path)?;
        let cache = self.metadata.lock().map_err(|e| e.to_string())?;
        let mut stmt = db
            .prepare("SELECT DISTINCT thread_id FROM analysis_turns")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(ids
            .into_iter()
            .filter(|id| cache.get(id).is_none_or(|x| now_ms() - x.0 > 300_000))
            .collect())
    }
    pub fn save_metadata(&self, values: Vec<(String, Option<ThreadInfo>)>) -> Result<u64, String> {
        let mut db = open_connection(&self.database_path)?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let mut cache = self.metadata.lock().map_err(|e| e.to_string())?;
        let mut missing = 0;
        for (id, info) in values {
            if let Some(info) = info {
                if !info.cwd.is_empty() {
                    tx.execute("INSERT INTO analysis_workspaces(thread_id,cwd) VALUES(?1,?2) ON CONFLICT(thread_id) DO UPDATE SET cwd=excluded.cwd",params![id,info.cwd]).map_err(|e|e.to_string())?;
                }
                cache.insert(id, (now_ms(), info.title));
            } else {
                missing += 1;
                let title = cache.get(&id).and_then(|x| x.1.clone());
                cache.insert(id, (0, title));
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(missing)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub model: Option<String>,
    pub credits: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCosts {
    pub models: Vec<ModelCost>,
    pub message: Option<String>,
}
impl AnalyticsCosts {
    pub fn unavailable(message: &str) -> Self {
        Self {
            models: vec![],
            message: Some(message.into()),
        }
    }
}
impl CodexAnalytics {
    pub fn cost_candidates(
        &self,
        q: &AnalyticsQuery,
    ) -> Result<Vec<(String, Vec<(Option<String>, u64)>)>, String> {
        if q.since < 0 || q.until <= q.since {
            return Err("无效的分析时间范围".into());
        }
        query::cost_candidates(&open_connection(&self.database_path)?, q)
    }
}
// A cumulative official estimate is usable only when the entire thread is in range
// and its per-model token totals reconcile with our selected execution ledger.
pub fn matching_costs(
    expected: &[(Option<String>, u64)],
    info: &ThreadInfo,
    usage: ThreadUsage,
    since: i64,
    until: i64,
    now: i64,
) -> Option<Vec<ModelCost>> {
    if info.created_at < since || info.created_at <= 0 || until < now {
        return None;
    }
    let mut totals: std::collections::BTreeMap<Option<String>, (u64, i64)> = Default::default();
    for group in usage.groups {
        let tokens = group.total_tokens?;
        if group.estimated_usage_credits_micros < 0 {
            return None;
        }
        let entry = totals.entry(group.model).or_default();
        entry.0 = entry.0.checked_add(tokens)?;
        entry.1 = entry.1.checked_add(group.estimated_usage_credits_micros)?;
    }
    if totals.len() != expected.len()
        || expected
            .iter()
            .any(|(model, n)| totals.get(model).is_none_or(|v| v.0 != *n))
    {
        return None;
    }
    Some(
        totals
            .into_iter()
            .map(|(model, (_, credits))| ModelCost {
                model,
                credits: credits as f64 / 1e6,
            })
            .collect(),
    )
}
