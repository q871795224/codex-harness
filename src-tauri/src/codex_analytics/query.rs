use super::*;
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsQuery {
    pub since: i64,
    pub until: i64,
    pub model: Option<String>,
    pub workspace: Option<String>,
    pub thread_id: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub sort: Option<String>,
    pub offset: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSnapshot {
    pub captured_since: i64,
    pub generated_at: i64,
    pub counter: AnalyticsCounterStatus,
    pub dropped_events: u64,
    pub write_errors: u64,
    pub official_fallbacks: u64,
    pub summary: Summary,
    pub daily: Vec<Daily>,
    pub models: Vec<Model>,
    pub workspaces: Vec<Workspace>,
    pub available_models: Vec<String>,
    pub hotspots: Vec<Hotspot>,
    pub sessions: Vec<Session>,
    pub turns: Vec<Turn>,
    pub total_sessions: u64,
    pub total_turns: u64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub sessions: u64,
    pub turns: u64,
    pub actual: Tokens,
    pub input_content_tokens: u64,
    pub input_content_incomplete: bool,
    pub incomplete_turns: u64,
    pub rerouted_turns: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Daily {
    date: String,
    turns: u64,
    actual: Tokens,
    models: Vec<DailyModel>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyModel {
    model: Option<String>,
    actual: Tokens,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    workspace: String,
    sessions: u64,
    turns: u64,
    actual: Tokens,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    model: Option<String>,
    turns: u64,
    sessions: u64,
    actual: Tokens,
    rerouted_turns: u64,
    input_content_tokens: u64,
    input_content_incomplete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    kind: String,
    name: String,
    calls: u64,
    selected: u64,
    reads: u64,
    sessions: u64,
    failed: u64,
    tokens: u64,
    argument_tokens: u64,
    result_tokens: u64,
    missing_counts: u64,
    workspaces: Vec<HotspotWorkspace>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotWorkspace {
    workspace: String,
    calls: u64,
    selected: u64,
    reads: u64,
    sessions: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    thread_id: String,
    workspace: String,
    title: Option<String>,
    started_at: i64,
    turns: u64,
    actual: Tokens,
    incomplete: bool,
    rerouted: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    turn_id: String,
    started_at: i64,
    model: Option<String>,
    source: String,
    status: String,
    actual: Tokens,
    incomplete: bool,
    rerouted: bool,
    content: Vec<Content>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    kind: String,
    name: String,
    at: i64,
    selected: u64,
    reads: u64,
    status: String,
    tokens: Option<u64>,
    argument_tokens: Option<u64>,
    result_tokens: Option<u64>,
    estimator: String,
}
const SUM_TOKENS:&str="COALESCE(SUM(total_tokens),0),COALESCE(SUM(input_tokens),0),COALESCE(SUM(cached_input_tokens),0),COALESCE(SUM(cache_write_input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(reasoning_output_tokens),0)";
fn tokens(r: &rusqlite::Row, i: usize) -> rusqlite::Result<Tokens> {
    Ok(Tokens {
        total_tokens: r.get(i)?,
        input_tokens: r.get(i + 1)?,
        cached_input_tokens: r.get(i + 2)?,
        cache_write_input_tokens: r.get(i + 3)?,
        output_tokens: r.get(i + 4)?,
        reasoning_output_tokens: r.get(i + 5)?,
    })
}
const CTE:&str="WITH selected AS (
 SELECT t.*,COALESCE(w.cwd,'') workspace FROM analysis_turns t LEFT JOIN analysis_workspaces w USING(thread_id) WHERE (?7 IS NULL OR COALESCE(w.cwd,'')=?7) AND (?3 IS NULL OR COALESCE(t.model,'')=?3) AND (?4 IS NULL OR t.thread_id=?4)
 AND (?5 IS NULL OR EXISTS(SELECT 1 FROM analysis_content h WHERE h.turn_id=t.turn_id AND h.kind=?5 AND (?6 IS NULL OR h.name=?6) AND h.at>=?1 AND h.at<?2))
), u AS (SELECT turn_id,SUM(total_tokens) total_tokens,SUM(input_tokens) input_tokens,SUM(cached_input_tokens) cached_input_tokens,SUM(cache_write_input_tokens) cache_write_input_tokens,SUM(output_tokens) output_tokens,SUM(reasoning_output_tokens) reasoning_output_tokens FROM analysis_usage WHERE at>=?1 AND at<?2 GROUP BY turn_id),
 activity AS (SELECT t.*,COALESCE(u.total_tokens,0) total_tokens,COALESCE(u.input_tokens,0) input_tokens,COALESCE(u.cached_input_tokens,0) cached_input_tokens,COALESCE(u.cache_write_input_tokens,0) cache_write_input_tokens,COALESCE(u.output_tokens,0) output_tokens,COALESCE(u.reasoning_output_tokens,0) reasoning_output_tokens FROM selected t LEFT JOIN u USING(turn_id) WHERE (t.started_at>=?1 AND t.started_at<?2) OR u.turn_id IS NOT NULL OR EXISTS(SELECT 1 FROM analysis_content c WHERE c.turn_id=t.turn_id AND c.at>=?1 AND c.at<?2)) ";
pub(super) fn snapshot(
    db: &Connection,
    q: &AnalyticsQuery,
    collector: &CodexAnalytics,
) -> Result<AnalyticsSnapshot, String> {
    if q.since < 0 || q.until <= q.since || q.until > now_ms() + 3 * 86_400_000 {
        return Err("无效的分析时间范围".into());
    }
    if q.kind
        .as_deref()
        .is_some_and(|s| !matches!(s, "skill" | "mcp" | "agents"))
    {
        return Err("无效的热点类型".into());
    }
    read_snapshot(db, q, collector).map_err(|e| format!("读取分析数据失败: {e}"))
}
fn read_snapshot(
    db: &Connection,
    q: &AnalyticsQuery,
    collector: &CodexAnalytics,
) -> rusqlite::Result<AnalyticsSnapshot> {
    // One read transaction keeps metrics, pagination and detail consistent while collection continues.
    let tx = db.unchecked_transaction()?;
    let args = params![
        q.since,
        q.until,
        q.model,
        q.thread_id,
        q.kind,
        q.name,
        q.workspace
    ];
    let summary=tx.query_row(&format!("{CTE} SELECT COUNT(DISTINCT thread_id),COUNT(*),{SUM_TOKENS},COALESCE(SUM(uncertain),0),COALESCE(SUM(rerouted),0) FROM activity"),args,|r|Ok(Summary{sessions:r.get(0)?,turns:r.get(1)?,actual:tokens(r,2)?,incomplete_turns:r.get(8)?,rerouted_turns:r.get(9)?,input_content_tokens:0,input_content_incomplete:false}))?;
    let mut summary = summary;
    summary.input_content_tokens=tx.query_row(&format!("{CTE} SELECT COALESCE(SUM(c.tokens),0) FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.kind='input' AND c.at>=?1 AND c.at<?2"),args,|r|r.get(0))?;
    summary.input_content_incomplete=tx.query_row(&format!("{CTE} SELECT EXISTS(SELECT 1 FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.kind='input' AND c.tokens IS NULL AND c.at>=?1 AND c.at<?2)"),args,|r|r.get(0))?;
    let mut models=tx.prepare(&format!("{CTE} SELECT model,COUNT(*),COUNT(DISTINCT thread_id),{SUM_TOKENS},SUM(rerouted) FROM activity GROUP BY model ORDER BY SUM(total_tokens) DESC,model"))?.query_map(args,|r|Ok(Model{model:r.get(0)?,turns:r.get(1)?,sessions:r.get(2)?,actual:tokens(r,3)?,rerouted_turns:r.get(9)?,input_content_tokens:0,input_content_incomplete:false}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let available_models = tx
        .prepare(
            "SELECT DISTINCT model FROM analysis_turns WHERE model IS NOT NULL ORDER BY model",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut daily=tx.prepare(&format!("{CTE}, days AS (
      SELECT u.at,u.turn_id,u.total_tokens,u.input_tokens,u.cached_input_tokens,u.cache_write_input_tokens,u.output_tokens,u.reasoning_output_tokens FROM analysis_usage u JOIN selected t USING(turn_id) WHERE u.at>=?1 AND u.at<?2
      UNION ALL SELECT t.started_at,t.turn_id,0,0,0,0,0,0 FROM selected t WHERE t.started_at>=?1 AND t.started_at<?2
      UNION ALL SELECT c.at,c.turn_id,0,0,0,0,0,0 FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.at>=?1 AND c.at<?2)
      SELECT strftime('%Y-%m-%d',at/1000,'unixepoch','localtime') date,COUNT(DISTINCT turn_id),{SUM_TOKENS} FROM days GROUP BY date ORDER BY date"))?.query_map(args,|r|Ok(Daily{date:r.get(0)?,turns:r.get(1)?,actual:tokens(r,2)?,models:Vec::new()}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut hotspots=tx.prepare(&format!("{CTE} SELECT c.kind,c.name,COUNT(*),SUM(c.selected),SUM(c.reads),COUNT(DISTINCT t.thread_id),SUM(CASE WHEN c.status IN ('failed','declined','cancelled') THEN 1 ELSE 0 END),COALESCE(SUM(c.tokens),0),COALESCE(SUM(c.argument_tokens),0),COALESCE(SUM(c.result_tokens),0),SUM(CASE WHEN (c.kind='mcp' AND (c.argument_tokens IS NULL OR c.result_tokens IS NULL)) OR (c.kind!='mcp' AND c.tokens IS NULL) THEN 1 ELSE 0 END) FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.at>=?1 AND c.at<?2 AND c.kind!='input' GROUP BY c.kind,c.name ORDER BY COUNT(*) DESC,c.name"))?.query_map(args,|r|Ok(Hotspot{kind:r.get(0)?,name:r.get(1)?,calls:r.get(2)?,selected:r.get(3)?,reads:r.get(4)?,sessions:r.get(5)?,failed:r.get(6)?,tokens:r.get(7)?,argument_tokens:r.get(8)?,result_tokens:r.get(9)?,missing_counts:r.get(10)?,workspaces:Vec::new()}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for model in &mut models {
        let (count, missing) = tx.query_row(&format!("{CTE} SELECT COALESCE(SUM(c.tokens),0),COALESCE(SUM(c.tokens IS NULL),0)>0 FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.kind='input' AND c.at>=?1 AND c.at<?2 AND t.model IS ?8"), params![q.since,q.until,q.model,q.thread_id,q.kind,q.name,q.workspace,model.model], |r| Ok((r.get(0)?,r.get(1)?)))?;
        model.input_content_tokens = count;
        model.input_content_incomplete = missing;
    }
    for day in &mut daily {
        day.models=tx.prepare(&format!("{CTE} SELECT t.model,SUM(u.total_tokens),SUM(u.input_tokens),SUM(u.cached_input_tokens),SUM(u.cache_write_input_tokens),SUM(u.output_tokens),SUM(u.reasoning_output_tokens) FROM analysis_usage u JOIN selected t USING(turn_id) WHERE u.at>=?1 AND u.at<?2 AND strftime('%Y-%m-%d',u.at/1000,'unixepoch','localtime')=?8 GROUP BY t.model ORDER BY t.model"))?.query_map(params![q.since,q.until,q.model,q.thread_id,q.kind,q.name,q.workspace,day.date],|r|Ok(DailyModel{model:r.get(0)?,actual:tokens(r,1)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    for hotspot in &mut hotspots {
        hotspot.workspaces=tx.prepare(&format!("{CTE} SELECT t.workspace,COUNT(*),SUM(c.selected),SUM(c.reads),COUNT(DISTINCT t.thread_id) FROM analysis_content c JOIN selected t USING(turn_id) WHERE c.at>=?1 AND c.at<?2 AND c.kind=?8 AND c.name=?9 GROUP BY t.workspace ORDER BY COUNT(*) DESC,t.workspace"))?.query_map(params![q.since,q.until,q.model,q.thread_id,q.kind,q.name,q.workspace,hotspot.kind,hotspot.name],|r|Ok(HotspotWorkspace{workspace:r.get(0)?,calls:r.get(1)?,selected:r.get(2)?,reads:r.get(3)?,sessions:r.get(4)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    let workspaces=tx.prepare(&format!("{CTE} SELECT workspace,COUNT(DISTINCT thread_id),COUNT(*),{SUM_TOKENS} FROM activity GROUP BY workspace ORDER BY SUM(total_tokens) DESC,workspace"))?.query_map(args,|r|Ok(Workspace{workspace:r.get(0)?,sessions:r.get(1)?,turns:r.get(2)?,actual:tokens(r,3)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let offset = q.offset.unwrap_or(0).min(1_000_000);
    let ordering = match q.sort.as_deref() {
        Some("tokensAsc") => "SUM(total_tokens) ASC",
        Some("recent") => "MAX(started_at) DESC",
        _ => "SUM(total_tokens) DESC",
    };
    let sessions=tx.prepare(&format!("{CTE} SELECT thread_id,MAX(workspace),MIN(started_at),COUNT(*),{SUM_TOKENS},MAX(uncertain),MAX(rerouted) FROM activity GROUP BY thread_id ORDER BY {ordering},thread_id LIMIT 50 OFFSET {offset}"))?.query_map(args,|r|Ok(Session{thread_id:r.get(0)?,workspace:r.get(1)?,title:collector.metadata.lock().ok().and_then(|m|m.get(&r.get::<_,String>(0).ok()?).and_then(|x|x.1.clone())),started_at:r.get(2)?,turns:r.get(3)?,actual:tokens(r,4)?,incomplete:r.get(10)?,rerouted:r.get(11)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut turns = if q.thread_id.is_some() {
        tx.prepare(&format!("{CTE} SELECT turn_id,started_at,model,source,status,{SUM_TOKENS},uncertain,rerouted FROM activity GROUP BY turn_id ORDER BY started_at DESC,turn_id LIMIT 50 OFFSET {offset}"))?.query_map(args,|r|Ok(Turn{turn_id:r.get(0)?,started_at:r.get(1)?,model:r.get(2)?,source:r.get(3)?,status:r.get(4)?,actual:tokens(r,5)?,incomplete:r.get(11)?,rerouted:r.get(12)?,content:Vec::new()}))?.collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    for turn in &mut turns {
        // Aggregate repeated reads within a turn instead of truncating evidence silently.
        turn.content=tx.prepare("SELECT kind,name,MIN(at),SUM(selected),SUM(reads),status,SUM(tokens),SUM(argument_tokens),SUM(result_tokens),CASE WHEN MIN(estimator)=MAX(estimator) THEN MIN(estimator) ELSE 'mixed' END FROM analysis_content WHERE turn_id=?1 AND at>=?2 AND at<?3 GROUP BY kind,name,status ORDER BY MIN(at),name")?.query_map(params![turn.turn_id,q.since,q.until],|r|Ok(Content{kind:r.get(0)?,name:r.get(1)?,at:r.get(2)?,selected:r.get(3)?,reads:r.get(4)?,status:r.get(5)?,tokens:r.get(6)?,argument_tokens:r.get(7)?,result_tokens:r.get(8)?,estimator:r.get(9)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    let captured_since =
        tx.query_row("SELECT started_at FROM analysis_meta WHERE id=1", [], |r| {
            r.get(0)
        })?;
    tx.commit()?;
    Ok(AnalyticsSnapshot {
        captured_since,
        generated_at: now_ms(),
        counter: collector.counter_status(),
        dropped_events: collector.dropped_events.load(Ordering::Relaxed),
        write_errors: collector.write_errors.load(Ordering::Relaxed),
        official_fallbacks: collector.official_stats.fallbacks.load(Ordering::Relaxed),
        total_sessions: summary.sessions,
        total_turns: summary.turns,
        summary,
        daily,
        models,
        workspaces,
        available_models,
        hotspots,
        sessions,
        turns,
    })
}

pub(super) fn cost_candidates(
    db: &Connection,
    q: &AnalyticsQuery,
) -> Result<Vec<(String, Vec<(Option<String>, u64)>)>, String> {
    let mut result: std::collections::BTreeMap<String, Vec<(Option<String>, u64)>> =
        Default::default();
    let mut stmt = db
        .prepare(&format!(
            "{CTE} SELECT thread_id,model,SUM(total_tokens) FROM activity GROUP BY thread_id,model"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                q.since,
                q.until,
                q.model,
                q.thread_id,
                q.kind,
                q.name,
                q.workspace
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, u64>(2)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, model, tokens) = row.map_err(|e| e.to_string())?;
        result.entry(id).or_default().push((model, tokens));
    }
    Ok(result.into_iter().collect())
}
