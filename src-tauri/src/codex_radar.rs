use futures_util::{stream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const ORIGIN: &str = "https://codexradar.com";
const MIN_RANKING_COVERAGE: u64 = 40;
const SCORE_VERSION: &str = "radar-bench-v2-150";
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
}

#[derive(Clone, Debug, Deserialize)]
struct Selection {
    model: String,
    effort: String,
}

#[derive(Deserialize)]
struct Binding {
    score_version: String,
    score_max: u64,
    total_tasks: u64,
    benchmark: String,
    catalog_version: String,
    task_set_sha256: String,
    model_efforts: Vec<Selection>,
}

#[derive(Clone)]
pub struct CodexRadarClient {
    client: Client,
    cache: Arc<Mutex<Option<RadarModelTable>>>,
}

impl CodexRadarClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .gzip(true)
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(15))
                .build()
                .expect("无法初始化 Codex Radar HTTP 客户端"),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn model_table(&self) -> Result<RadarModelTable, String> {
        let mut cache = self.cache.lock().await;
        let now = unix_seconds();
        if let Some(current) = cache.as_ref() {
            if now.saturating_sub(current.fetched_at) < CACHE_TTL.as_secs() {
                return Ok(current.clone());
            }
        }
        match self.fetch_table(ORIGIN, now).await {
            Ok(table) => {
                *cache = Some(table.clone());
                Ok(table)
            }
            Err(error) => cache
                .as_ref()
                .filter(|current| now.saturating_sub(current.fetched_at) < MAX_STALE.as_secs())
                .cloned()
                .ok_or(error),
        }
    }

    async fn fetch_table(&self, origin: &str, now: u64) -> Result<RadarModelTable, String> {
        let binding: Binding = self
            .client
            .get(format!("{origin}/data/radar-bench-binding.json"))
            .send()
            .await
            .map_err(|e| format!("无法获取 Radar Bench 模型列表: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Radar Bench 模型列表接口异常: {e}"))?
            .json()
            .await
            .map_err(|e| format!("无法解析 Radar Bench 模型列表: {e}"))?;
        if binding.score_version != SCORE_VERSION
            || binding.score_max != 150
            || binding.total_tasks != 64
            || binding.model_efforts.is_empty()
            || binding.model_efforts.len() > 64
        {
            return Err("Radar Bench 基准版本或模型列表不兼容".into());
        }
        // Each model/effort has an independent summary. One failed read must not
        // discard successful reads, and concurrency stays bounded like the site.
        let binding_ref = &binding;
        let client = &self.client;
        let results = stream::iter(binding.model_efforts.clone())
            .map(|selection| async move {
                let mut url = reqwest::Url::parse(&format!("{origin}/api/radar-bench-score"))
                    .map_err(|e| e.to_string())?;
                url.query_pairs_mut().extend_pairs([
                    ("model", selection.model.as_str()),
                    ("effort", selection.effort.as_str()),
                    ("view", "summary"),
                    ("selection", "user-selected-v1"),
                ]);
                let response = client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .error_for_status()
                    .map_err(|e| e.to_string())?
                    .json::<Value>()
                    .await
                    .map_err(|e| e.to_string())?;
                parse_summary(&response, binding_ref, &selection)
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        let mut rows = Vec::new();
        let mut last_error = "暂无有效雷达分".to_string();
        for result in results {
            match result {
                Ok(row) => rows.push(row),
                Err(error) => last_error = error,
            }
        }
        build_model_table(rows, now).map_err(|e| format!("{e}: {last_error}"))
    }
}

fn parse_summary(
    value: &Value,
    binding: &Binding,
    selection: &Selection,
) -> Result<RadarModelRow, String> {
    let invalid = || {
        format!(
            "Radar Bench 数据不兼容: {} {}",
            selection.model, selection.effort
        )
    };
    if value["schema"] != "radar-bench-public-summary-v5-150-daily-graded-count"
        || value["score_version"] != SCORE_VERSION
        || value["score_max"] != 150
        || value["required_tasks"] != 64
        || value["benchmark"] != binding.benchmark
        || value["catalog_version"] != binding.catalog_version
        || value["task_set_sha256"] != binding.task_set_sha256
        || value["model"] != selection.model
        || value["effort"] != selection.effort
    {
        return Err(invalid());
    }
    let coverage = value["coverage"]
        .as_u64()
        .filter(|v| *v <= 64)
        .ok_or_else(invalid)?;
    let score = nonnegative_number(&value["score"]);
    let expected_status = if coverage == 0 {
        "missing_current_result"
    } else if coverage == 64 {
        "complete"
    } else {
        "provisional"
    };
    if value["score_status"] != expected_status
        || (coverage == 0 && !value["score"].is_null())
        || (coverage > 0 && !score.is_some_and(|v| v <= 150.0))
    {
        return Err(invalid());
    }
    let metric = |key: &str| {
        if value["statistics_state"] != "available" {
            return None;
        }
        let metric = &value["statistics"]["metrics"][key];
        if metric["known_samples"].as_u64().unwrap_or(0) == 0 {
            return None;
        }
        nonnegative_number(&metric["mean"])
    };
    Ok(RadarModelRow {
        group: "reference".into(),
        model: selection.model.clone(),
        effort: selection.effort.clone(),
        score,
        coverage,
        price: metric("api_equivalent_usd"),
        minutes: metric("elapsed_ms").map(|ms| ms / 60_000.0),
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
        return Err("Radar Bench 暂无有效雷达分".into());
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
    // station recommendations. Like the site overview, ranking needs >40 tasks;
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
        return Err("Radar Bench 暂无足够覆盖的模型数据".into());
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

    fn binding() -> Binding {
        serde_json::from_value(json!({"score_version":SCORE_VERSION,"score_max":150,"total_tasks":64,
            "benchmark":"radar-bench-final64-20261004","catalog_version":"catalog","task_set_sha256":"digest",
            "model_efforts":[{"model":"gpt-6.1-sol","effort":"high"}]})).unwrap()
    }

    fn summary(model: &str, effort: &str, score: Value) -> Value {
        json!({"schema":"radar-bench-public-summary-v5-150-daily-graded-count",
            "score_version":SCORE_VERSION,"score_max":150,"required_tasks":64,
            "benchmark":"radar-bench-final64-20261004","catalog_version":"catalog","task_set_sha256":"digest",
            "model":model,"effort":effort,"score":score,"coverage":50,"score_status":"provisional",
            "statistics_state":"available","statistics":{"metrics":{
                "api_equivalent_usd":{"mean":0.48260188,"known_samples":50},
                "elapsed_ms":{"mean":1050708.24,"known_samples":50}}}})
    }

    fn row(model: &str, effort: &str, score: f64) -> RadarModelRow {
        parse_summary(
            &summary(model, effort, json!(score)),
            &binding(),
            &Selection {
                model: model.into(),
                effort: effort.into(),
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn reads_the_new_routes_and_keeps_successes_when_one_selection_fails() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                let request = String::from_utf8(request).unwrap();
                let (status, body) = if request.starts_with("GET /data/radar-bench-binding.json ") {
                    ("200 OK", json!({"score_version":SCORE_VERSION,"score_max":150,"total_tasks":64,
                        "benchmark":"radar-bench-final64-20261004","catalog_version":"catalog","task_set_sha256":"digest",
                        "model_efforts":[{"model":"gpt-6.1-sol","effort":"high"},{"model":"gpt-6-astra","effort":"medium"}]}).to_string())
                } else {
                    assert!(request.starts_with("GET /api/radar-bench-score?"));
                    assert!(request.contains("view=summary"));
                    assert!(request.contains("selection=user-selected-v1"));
                    if request.contains("model=gpt-6.1-sol&effort=high") {
                        (
                            "200 OK",
                            summary("gpt-6.1-sol", "high", json!(104.6)).to_string(),
                        )
                    } else {
                        ("502 Bad Gateway", "temporarily unavailable".into())
                    }
                };
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let radar = CodexRadarClient {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            cache: Arc::new(Mutex::new(None)),
        };
        let table = radar.fetch_table(&origin, 42).await.unwrap();
        server.join().unwrap();
        assert_eq!(table.rows.len(), 1);
        assert_eq!(table.rows[0].model, "gpt-6.1-sol");
        assert_eq!(table.rows[0].score, Some(104.6));
        assert_eq!(table.fetched_at, 42);
    }

    #[test]
    fn parses_bench_score_and_evidenced_metrics_in_minutes() {
        let row = row("gpt-6.1-sol", "high", 104.5646953046953);
        assert_eq!(row.score, Some(104.5646953046953));
        assert_eq!(row.coverage, 50);
        assert_eq!(row.price, Some(0.48260188));
        assert_eq!(row.minutes, Some(17.511804));
        let wire = serde_json::to_value(row).unwrap();
        assert!(wire.get("bestScore").is_some());
        assert!(wire.get("iq").is_none());
    }

    #[test]
    fn distinguishes_missing_results_and_zero_scores_or_costs() {
        let binding = binding();
        let selection = &binding.model_efforts[0];
        let mut value = summary(&selection.model, &selection.effort, json!(0));
        value["statistics"]["metrics"]["api_equivalent_usd"]["mean"] = json!(0);
        let row = parse_summary(&value, &binding, selection).unwrap();
        assert_eq!((row.score, row.price), (Some(0.0), Some(0.0)));
        value["coverage"] = json!(0);
        value["score"] = Value::Null;
        value["score_status"] = json!("missing_current_result");
        value["statistics_state"] = json!("not_provided");
        let row = parse_summary(&value, &binding, selection).unwrap();
        assert_eq!((row.score, row.price, row.minutes), (None, None, None));
        assert!(build_model_table(vec![row], 42).is_err());
    }

    #[test]
    fn rejects_other_benchmarks_selections_and_invalid_scores() {
        let binding = binding();
        let selection = &binding.model_efforts[0];
        for (key, bad) in [
            ("score_version", json!("legacy")),
            ("model", json!("other")),
            ("task_set_sha256", json!("other")),
            ("coverage", json!(65)),
            ("score", json!(151)),
            ("score", json!(-1)),
            ("score", Value::Null),
        ] {
            let mut value = summary(&selection.model, &selection.effort, json!(100));
            value[key] = bad;
            assert!(parse_summary(&value, &binding, selection).is_err(), "{key}");
        }
    }

    #[test]
    fn missing_metric_evidence_does_not_become_zero_or_win() {
        let binding = binding();
        let selection = &binding.model_efforts[0];
        let mut value = summary(&selection.model, &selection.effort, json!(100));
        value["statistics"]["metrics"]["api_equivalent_usd"]["known_samples"] = json!(0);
        value["statistics"]["metrics"]["elapsed_ms"]["mean"] = Value::Null;
        let row = parse_summary(&value, &binding, selection).unwrap();
        assert_eq!((row.price, row.minutes), (None, None));
        let table = build_model_table(vec![row], 42).unwrap();
        assert!(!table.rows[0].best_price);
        assert!(!table.rows[0].best_minutes);
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
