use crate::diagnostics::DiagnosticLog;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const ORIGIN: &str = "https://codexradar.com";
const MIN_RANKING_COVERAGE: u64 = 2;
const RESULTS_PATH: &str = "/data/codex-four-task-results.json";
const TASKS: [&str; 4] = ["combined", "pompeii", "pelican", "candy"];
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_STALE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarModelRow {
    pub group: String,
    pub model: String,
    pub effort: String,
    pub score: Option<f64>,
    pub coverage: u64,
    pub required_tasks: u64,
    pub price: Option<f64>,
    pub minutes: Option<f64>,
    pub best_score: bool,
    pub best_price: bool,
    pub best_minutes: bool,
    pub automatic: bool,
    pub default_cursor: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarModelTable {
    pub rows: Vec<RadarModelRow>,
    pub fetched_at: u64,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
pub struct CodexRadarClient {
    client: Client,
    cache: Arc<Mutex<Option<RadarModelTable>>>,
    diagnostics: Option<Arc<DiagnosticLog>>,
}

impl CodexRadarClient {
    pub fn new(diagnostics: Arc<DiagnosticLog>) -> Self {
        Self {
            client: Client::builder()
                .gzip(true)
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(15))
                .build()
                .expect("无法初始化 Codex Radar HTTP 客户端"),
            cache: Arc::new(Mutex::new(None)),
            diagnostics: Some(diagnostics),
        }
    }

    fn record(&self, level: &str, event: &str, fields: Value) {
        if let Some(log) = &self.diagnostics {
            log.record(level, "codex-radar", event, fields);
        }
    }

    pub async fn model_table(&self, force: bool) -> Result<RadarModelTable, String> {
        self.model_table_from(ORIGIN, force).await
    }

    async fn model_table_from(&self, origin: &str, force: bool) -> Result<RadarModelTable, String> {
        let mut cache = self.cache.lock().await;
        let now = unix_seconds();
        if !force {
            if let Some(current) = cache.as_ref() {
                if now.saturating_sub(current.fetched_at) < CACHE_TTL.as_secs() {
                    self.record("info", "cache.hit", json!({"fetchedAt":current.fetched_at,
                        "ageSeconds":now.saturating_sub(current.fetched_at), "rows":current.rows.len()}));
                    return Ok(current.clone());
                }
            }
        }
        self.record(
            "info",
            "fetch.started",
            json!({"force":force, "fetchedAt":now}),
        );
        match self.fetch_table(origin, now).await {
            Ok(table) => {
                *cache = Some(table.clone());
                Ok(table)
            }
            Err(error) => {
                self.record(
                    "error",
                    "fetch.failed",
                    json!({"force":force, "error":error}),
                );
                if !force {
                    if let Some(current) = cache.as_ref().filter(|current| {
                        now.saturating_sub(current.fetched_at) < MAX_STALE.as_secs()
                    }) {
                        self.record(
                            "warn",
                            "cache.stale",
                            json!({"fetchedAt":current.fetched_at,
                            "ageSeconds":now.saturating_sub(current.fetched_at), "error":error}),
                        );
                        let mut table = current.clone();
                        table
                            .warnings
                            .push(format!("Radar 更新失败，正在显示旧缓存：{error}"));
                        return Ok(table);
                    }
                }
                Err(error)
            }
        }
    }

    async fn fetch_table(&self, origin: &str, now: u64) -> Result<RadarModelTable, String> {
        let value: Value = self
            .client
            .get(format!("{origin}{RESULTS_PATH}"))
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .map_err(|e| format!("无法获取 Radar 四项测试: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Radar 四项测试接口异常: {e}"))?
            .json()
            .await
            .map_err(|e| format!("无法解析 Radar 四项测试: {e}"))?;
        let table = parse_results(&value, now)?;
        self.record(
            "info",
            "fetch.completed",
            json!({"fetchedAt":now,
            "source":RESULTS_PATH,"roundId":value["round_id"],"rows":table.rows.len(),
            "failedSelections":table.warnings.len()}),
        );
        Ok(table)
    }
}

fn parse_results(value: &Value, now: u64) -> Result<RadarModelTable, String> {
    if value["schema"] != "codex-four-task-results/1"
        || value["protocol"] != "codex-four-weighted-150-v2"
        || value["score_max"] != 150
        || value["task_weights"] != json!({"combined":60,"pompeii":45,"pelican":22.5,"candy":22.5})
    {
        return Err("Radar 四项测试版本或评分规则不兼容".into());
    }
    let raw_rows = value["rows"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 64)
        .ok_or("Radar 四项测试模型列表不兼容")?;
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for raw in raw_rows {
        match parse_result_row(raw) {
            Ok(row) => rows.push(row),
            Err(error) => warnings.push(format!("{} / {}: {error}", raw["model"], raw["effort"])),
        }
    }
    let mut table = build_model_table(rows, now)?;
    table.warnings = warnings;
    Ok(table)
}

fn parse_result_row(raw: &Value) -> Result<RadarModelRow, String> {
    let model = raw["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("缺少模型名")?;
    let effort = raw["effort"]
        .as_str()
        .filter(|s| matches!(*s, "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
        .ok_or("无效推理强度")?;
    let score100 = |v: &Value| nonnegative_number(v).filter(|n| *n <= 100.0);
    let scores = [
        score100(&raw["combined"]["score"]),
        score100(&raw["pompeii"]["score100"]),
        score100(&raw["pelican"]["score"]),
        raw["candy"]["correct"]
            .as_bool()
            .map(|correct| if correct { 100.0 } else { 0.0 }),
    ];
    let coverage = scores.iter().flatten().count() as u64;
    // Match the site's 60/45/22.5/22.5 weighted total. Cost and time are
    // totals for the same four tasks, never mixed with the retired 64-task mean.
    let score = scores
        .into_iter()
        .zip([0.6, 0.45, 0.225, 0.225])
        .map(|(score, weight)| score.map(|s| s * weight))
        .sum::<Option<f64>>();
    let price = TASKS
        .iter()
        .map(|task| {
            (raw[task]["cost_kind"] == "api_equivalent_estimate")
                .then(|| nonnegative_number(&raw[task]["cost_usd"]))
                .flatten()
        })
        .sum::<Option<f64>>()
        .filter(|n| n.is_finite());
    let minutes = TASKS
        .iter()
        .map(|task| nonnegative_number(&raw[task]["model_elapsed_seconds"]))
        .sum::<Option<f64>>()
        .filter(|n| n.is_finite())
        .map(|s| s / 60.0);
    Ok(RadarModelRow {
        group: "reference".into(),
        model: model.into(),
        effort: effort.into(),
        score,
        coverage,
        required_tasks: 4,
        price,
        minutes,
        best_score: false,
        best_price: false,
        best_minutes: false,
        automatic: false,
        default_cursor: false,
    })
}

fn nonnegative_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
}

fn build_model_table(
    mut rows: Vec<RadarModelRow>,
    fetched_at: u64,
) -> Result<RadarModelTable, String> {
    if !rows.iter().any(|row| row.score.is_some()) {
        return Err("Radar 四项测试暂无有效雷达分".into());
    }
    rows.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.model.cmp(&right.model))
            .then_with(|| left.effort.cmp(&right.effort))
    });
    rows.dedup_by(|left, right| left.model == right.model && left.effort == right.effort);
    // Preserve the compact launcher groups without depending on the retired
    // station recommendations. Ranking requires at least three of four tasks;
    // the fixed Astra/Luna choices can still display their measured coverage.
    let mut candidates = Vec::new();
    let mut references = 0;
    let mut hard = 0;
    for mut row in rows {
        row.group = if row.model == "gpt-6-luna" && row.effort == "max" {
            "simple"
        } else if row.model == "gpt-6-astra" && matches!(row.effort.as_str(), "low" | "medium") {
            "agi"
        } else if hard < 2 && row.score.is_some() && row.coverage > MIN_RANKING_COVERAGE {
            hard += 1;
            "hard"
        } else if references < 3
            && supported_reference(&row)
            && row.score.is_some()
            && row.coverage > MIN_RANKING_COVERAGE
        {
            references += 1;
            "reference"
        } else {
            continue;
        }
        .into();
        candidates.push(row);
    }
    if !candidates.iter().any(|row| row.score.is_some()) {
        return Err("Radar 四项测试暂无足够覆盖的模型数据".into());
    }
    let ranked = candidates.iter().filter(|row| row.group != "simple");
    let best_score = ranked.clone().filter_map(|row| row.score).reduce(f64::max);
    let best_price = ranked.clone().filter_map(|row| row.price).reduce(f64::min);
    let best_minutes = ranked.filter_map(|row| row.minutes).reduce(f64::min);
    let automatic = candidates
        .iter()
        .enumerate()
        .filter(|(_, row)| row.group == "hard" && row.price.is_some())
        .min_by(|(_, left), (_, right)| left.price.partial_cmp(&right.price).unwrap())
        .map(|(index, _)| index);
    let default_cursor = candidates
        .iter()
        .position(|row| matches!(row.group.as_str(), "reference" | "agi") && row.score.is_some())
        .or_else(|| candidates.iter().position(|row| row.score.is_some()));
    for (index, row) in candidates.iter_mut().enumerate() {
        row.best_score = row.group != "simple" && row.score.is_some() && row.score == best_score;
        row.best_price = row.group != "simple" && row.price.is_some() && row.price == best_price;
        row.best_minutes =
            row.group != "simple" && row.minutes.is_some() && row.minutes == best_minutes;
        row.automatic = Some(index) == automatic;
        row.default_cursor = Some(index) == default_cursor;
    }
    Ok(RadarModelTable {
        rows: candidates,
        fetched_at,
        warnings: Vec::new(),
    })
}

fn supported_reference(row: &RadarModelRow) -> bool {
    matches!(
        (row.model.as_str(), row.effort.as_str()),
        ("gpt-6.1-sol" | "gpt-5.6-sol", "high" | "medium")
            | ("gpt-5.6-terra", "high" | "xhigh" | "max")
            | ("gpt-5.6-luna", "xhigh")
    )
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(model: &str, effort: &str, score: f64) -> RadarModelRow {
        RadarModelRow {
            group: "reference".into(),
            model: model.into(),
            effort: effort.into(),
            score: Some(score),
            coverage: 4,
            required_tasks: 4,
            price: Some(1.0),
            minutes: Some(2.0),
            best_score: false,
            best_price: false,
            best_minutes: false,
            automatic: false,
            default_cursor: false,
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/radar-four-task.json")).unwrap()
    }

    #[test]
    fn current_results_match_all_46_homepage_scores_costs_and_times() {
        let fixture = fixture();
        for (raw, expected) in fixture["response"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .zip(fixture["homepage"].as_array().unwrap())
        {
            let row = parse_result_row(raw).unwrap();
            assert_eq!(row.model, expected["model"].as_str().unwrap());
            assert_eq!(row.effort, expected["effort"].as_str().unwrap());
            assert!((row.score.unwrap() - expected["score150"].as_f64().unwrap()).abs() < 1e-8);
            assert!((row.price.unwrap() - expected["cost_usd"].as_f64().unwrap()).abs() < 1e-8);
            assert!(
                (row.minutes.unwrap() - expected["model_elapsed_seconds"].as_f64().unwrap() / 60.0)
                    .abs()
                    < 1e-8
            );
            assert_eq!((row.coverage, row.required_tasks), (4, 4));
        }
        let table = parse_results(&fixture["response"], 42).unwrap();
        assert!(table.warnings.is_empty());
        assert!(table.rows.iter().all(|row| row.price.is_some()));
        let terra = table
            .rows
            .iter()
            .find(|row| row.model == "gpt-6.1-terra")
            .unwrap();
        assert_eq!(terra.effort, "max");
        assert!((terra.score.unwrap() - 147.225).abs() < 1e-8);
        let wire = serde_json::to_value(terra).unwrap();
        assert_eq!(wire["requiredTasks"], 4);
    }

    #[test]
    fn missing_evidence_stays_unknown_and_zero_remains_zero() {
        let mut raw = fixture()["response"]["rows"][0].clone();
        raw["combined"]["cost_usd"] = Value::Null;
        raw["pelican"]["model_elapsed_seconds"] = Value::Null;
        let row = parse_result_row(&raw).unwrap();
        assert!(row.price.is_none());
        assert!(row.minutes.is_none());
        assert!(row.score.is_some());
        for task in TASKS {
            raw[task]["cost_usd"] = json!(0);
        }
        assert_eq!(parse_result_row(&raw).unwrap().price, Some(0.0));
        raw["candy"]["correct"] = Value::Null;
        let row = parse_result_row(&raw).unwrap();
        assert_eq!(row.coverage, 3);
        assert!(row.score.is_none());
        raw["combined"]["cost_kind"] = json!("unknown");
        assert!(parse_result_row(&raw).unwrap().price.is_none());
    }

    #[test]
    fn rejects_changed_protocol_and_preserves_valid_rows_on_partial_failure() {
        let good = fixture()["response"].clone();
        for (key, bad) in [
            ("schema", json!("other")),
            ("protocol", json!("other")),
            ("score_max", json!(100)),
            ("task_weights", json!({})),
            ("rows", json!([])),
        ] {
            let mut value = good.clone();
            value[key] = bad;
            assert!(parse_results(&value, 42).is_err(), "{key}");
        }
        let mut partial = good;
        partial["rows"][0]["effort"] = json!("invalid");
        let table = parse_results(&partial, 42).unwrap();
        assert_eq!(table.warnings.len(), 1);
        assert!(!table.rows.is_empty());
    }

    #[tokio::test]
    async fn reads_current_route_caches_and_never_masks_forced_refresh_failure() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let body = fixture()["response"].to_string();
        let server = std::thread::spawn(move || {
            for index in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|s| s == b"\r\n\r\n") {
                    let len = socket.read(&mut chunk).unwrap();
                    if len == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..len]);
                }
                assert!(String::from_utf8_lossy(&request)
                    .starts_with("GET /data/codex-four-task-results.json "));
                let (status, body) = if index < 2 {
                    ("200 OK", body.as_str())
                } else {
                    ("502 Bad Gateway", "{}")
                };
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let radar = CodexRadarClient {
            client: Client::new(),
            cache: Arc::new(Mutex::new(None)),
            diagnostics: None,
        };
        let first = radar.model_table_from(&origin, false).await.unwrap();
        assert_eq!(
            radar
                .model_table_from(&origin, false)
                .await
                .unwrap()
                .fetched_at,
            first.fetched_at
        );
        assert!(radar.model_table_from(&origin, true).await.is_ok());
        assert!(radar.model_table_from(&origin, true).await.is_err());
        radar.cache.lock().await.as_mut().unwrap().fetched_at -= CACHE_TTL.as_secs();
        let stale = radar.model_table_from(&origin, false).await.unwrap();
        assert_eq!(stale.warnings.len(), 1);
        server.join().unwrap();
    }

    #[test]
    fn does_not_rank_a_one_task_perfect_score_as_a_recommendation() {
        let mut tiny = row("gpt-5.6-luna", "high", 150.0);
        tiny.coverage = 1;
        let table = build_model_table(vec![tiny, row("gpt-6.1-sol", "max", 114.1)], 42).unwrap();
        assert_eq!(table.rows.len(), 1);
        assert_eq!(table.rows[0].model, "gpt-6.1-sol");
        assert!(table.rows[0].best_score);
    }

    #[test]
    fn ranks_new_models_without_reusing_legacy_luna_metrics() {
        let table = build_model_table(
            vec![
                row("gpt-6.1-sol", "high", 104.6),
                row("gpt-6.1-sol", "max", 114.1),
                row("gpt-6-astra", "xhigh", 121.1),
                row("gpt-6-astra", "low", 99.9),
                row("gpt-6-astra", "medium", 90.1),
                row("gpt-6-luna", "max", 52.9),
            ],
            42,
        )
        .unwrap();
        assert_eq!(
            table.rows.iter().filter(|row| row.group == "hard").count(),
            2
        );
        let luna = table.rows.iter().find(|row| row.group == "simple").unwrap();
        assert_eq!(luna.model, "gpt-6-luna");
        assert_eq!(luna.score, Some(52.9));
        assert!(!luna.best_score);
        assert_eq!(
            table
                .rows
                .iter()
                .find(|row| row.default_cursor)
                .unwrap()
                .model,
            "gpt-6.1-sol"
        );
    }

    #[test]
    fn keeps_sol_references_when_other_astra_efforts_score_higher() {
        let table = build_model_table(
            vec![
                row("gpt-6-astra", "xhigh", 121.1),
                row("gpt-6.1-sol", "max", 114.1),
                row("gpt-6-astra", "max", 113.7),
                row("gpt-6-astra", "high", 112.0),
                row("gpt-6-astra", "ultra", 111.6),
                row("gpt-6.1-sol", "high", 104.6),
                row("gpt-6-astra", "low", 99.9),
                row("gpt-6.1-sol", "medium", 96.0),
                row("gpt-5.6-sol", "high", 95.0),
                row("gpt-5.6-luna", "xhigh", 90.0),
                row("gpt-6-astra", "medium", 90.1),
                row("gpt-6-luna", "max", 56.3),
            ],
            42,
        )
        .unwrap();
        let selections = |group: &str| {
            table
                .rows
                .iter()
                .filter(|row| row.group == group)
                .map(|row| (row.model.as_str(), row.effort.as_str()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            selections("hard"),
            vec![("gpt-6-astra", "xhigh"), ("gpt-6.1-sol", "max")]
        );
        assert_eq!(
            selections("reference"),
            vec![
                ("gpt-6.1-sol", "high"),
                ("gpt-6.1-sol", "medium"),
                ("gpt-5.6-sol", "high")
            ]
        );
        assert_eq!(
            selections("agi"),
            vec![("gpt-6-astra", "low"), ("gpt-6-astra", "medium")]
        );
        let default = table.rows.iter().find(|row| row.default_cursor).unwrap();
        assert_eq!(
            (default.model.as_str(), default.effort.as_str()),
            ("gpt-6.1-sol", "high")
        );
        assert_eq!(default.score, Some(104.6));
    }

    #[test]
    fn does_not_include_sol_references_with_insufficient_coverage() {
        let mut sparse = row("gpt-6.1-sol", "high", 110.0);
        sparse.coverage = MIN_RANKING_COVERAGE;
        let table = build_model_table(
            vec![
                row("gpt-6-astra", "xhigh", 121.1),
                row("gpt-6.1-sol", "max", 114.1),
                sparse,
                row("gpt-6.1-sol", "medium", 96.0),
            ],
            42,
        )
        .unwrap();
        assert!(!table
            .rows
            .iter()
            .any(|row| row.model == "gpt-6.1-sol" && row.effort == "high"));
        assert!(table
            .rows
            .iter()
            .any(|row| row.group == "reference" && row.effort == "medium"));
    }
}
