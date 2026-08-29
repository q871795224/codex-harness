use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const INSIGHTS_URL: &str = "https://codexradar.com/api/radar-insights";
const EFFICIENCY_URL: &str = "https://codexradar.com/data/intelligence-efficiency.json";
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_STALE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarModelRow {
    pub group: String,
    pub model: String,
    pub effort: String,
    pub iq: f64,
    pub price: f64,
    pub minutes: f64,
    pub best_iq: bool,
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

#[derive(Clone)]
pub struct CodexRadarClient {
    client: Client,
    cache: Arc<Mutex<Option<RadarModelTable>>>,
}

impl CodexRadarClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(12))
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

        let insights_request = self.client.get(INSIGHTS_URL).send();
        let efficiency_request = self.client.get(EFFICIENCY_URL).send();
        let fetched = async {
            let (insights_response, efficiency_response) =
                futures_util::future::try_join(insights_request, efficiency_request)
                    .await
                    .map_err(|error| format!("无法获取 Codex Radar 数据: {error}"))?;
            let insights = insights_response
                .error_for_status()
                .map_err(|error| format!("Codex Radar 推荐接口异常: {error}"))?
                .json::<Value>()
                .await
                .map_err(|error| format!("无法解析 Codex Radar 推荐数据: {error}"))?;
            let efficiency = efficiency_response
                .error_for_status()
                .map_err(|error| format!("Codex Radar 效率接口异常: {error}"))?
                .json::<Value>()
                .await
                .map_err(|error| format!("无法解析 Codex Radar 效率数据: {error}"))?;
            build_model_table(&insights, &efficiency, now)
        }
        .await;

        match fetched {
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
}

#[derive(Clone)]
struct Candidate {
    group: &'static str,
    model: String,
    effort: String,
    iq: f64,
    price: f64,
    minutes: f64,
}

fn build_model_table(
    insights: &Value,
    efficiency: &Value,
    fetched_at: u64,
) -> Result<RadarModelTable, String> {
    let hard_items = insights
        .get("recommendations")
        .and_then(Value::as_array)
        .and_then(|recommendations| {
            recommendations
                .iter()
                .find(|entry| entry.get("key").and_then(Value::as_str) == Some("hard_problems"))
        })
        .and_then(|entry| entry.get("items"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex Radar 缺少 hard_problems 推荐".to_string())?;

    let mut candidates = hard_items
        .iter()
        .take(2)
        .map(|entry| {
            candidate(
                entry,
                "hard",
                "average_cost_usd",
                "average_duration_minutes",
            )
        })
        .collect::<Result<Vec<_>, _>>()?;

    let points = efficiency
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex Radar 缺少效率数据".to_string())?;
    let simple = points
        .iter()
        .find(|entry| {
            entry.get("model").and_then(Value::as_str) == Some("gpt-5.6-luna")
                && entry.get("effort").and_then(Value::as_str) == Some("max")
        })
        .ok_or_else(|| "Codex Radar 缺少简单任务模型".to_string())?;
    let simple = candidate(simple, "simple", "average_price_usd", "average_minutes")?;
    let mut references = points
        .iter()
        .filter(|entry| supported_reference(entry))
        .map(|entry| candidate(entry, "reference", "average_price_usd", "average_minutes"))
        .collect::<Result<Vec<_>, _>>()?;
    references.sort_by(|left, right| right.iq.partial_cmp(&left.iq).unwrap_or(Ordering::Equal));
    candidates.extend(references.into_iter().take(3));
    candidates.push(simple);
    if candidates.len() != 6 {
        return Err("Codex Radar 模型指标不完整".to_string());
    }

    let ranked = candidates.iter().filter(|row| row.group != "simple");
    let best_iq = ranked
        .clone()
        .map(|row| row.iq)
        .fold(f64::NEG_INFINITY, f64::max);
    let best_price = ranked
        .clone()
        .map(|row| row.price)
        .fold(f64::INFINITY, f64::min);
    let best_minutes = ranked.map(|row| row.minutes).fold(f64::INFINITY, f64::min);
    let automatic = candidates
        .iter()
        .enumerate()
        .filter(|(_, row)| row.group == "hard")
        .min_by(|(_, left), (_, right)| {
            left.price
                .partial_cmp(&right.price)
                .unwrap_or(Ordering::Equal)
        })
        .map(|(index, _)| index)
        .ok_or_else(|| "Codex Radar 缺少自动推荐".to_string())?;
    let default_cursor = candidates
        .iter()
        .enumerate()
        .filter(|(_, row)| row.group == "reference")
        .max_by(|(_, left), (_, right)| left.iq.partial_cmp(&right.iq).unwrap_or(Ordering::Equal))
        .map(|(index, _)| index)
        .ok_or_else(|| "Codex Radar 缺少参考模型".to_string())?;

    let rows = candidates
        .into_iter()
        .enumerate()
        .map(|(index, row)| RadarModelRow {
            group: row.group.to_string(),
            model: row.model,
            effort: row.effort,
            iq: row.iq,
            price: row.price,
            minutes: row.minutes,
            best_iq: row.group != "simple" && row.iq == best_iq,
            best_price: row.group != "simple" && row.price == best_price,
            best_minutes: row.group != "simple" && row.minutes == best_minutes,
            automatic: index == automatic,
            default_cursor: index == default_cursor,
        })
        .collect();
    Ok(RadarModelTable { rows, fetched_at })
}

fn candidate(
    entry: &Value,
    group: &'static str,
    price_key: &str,
    minutes_key: &str,
) -> Result<Candidate, String> {
    let text = |key| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("Codex Radar 缺少 {key}"))
    };
    let number = |key| {
        entry
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("Codex Radar 缺少 {key}"))
    };
    Ok(Candidate {
        group,
        model: text("model")?,
        effort: text("effort")?,
        iq: number("iq")?,
        price: number(price_key)?,
        minutes: number(minutes_key)?,
    })
}

fn supported_reference(entry: &Value) -> bool {
    let model = entry.get("model").and_then(Value::as_str);
    let effort = entry.get("effort").and_then(Value::as_str);
    matches!(
        (model, effort),
        (Some("gpt-5.6-sol"), Some("high" | "medium"))
            | (Some("gpt-5.6-terra"), Some("high" | "xhigh" | "max"))
            | (Some("gpt-5.6-luna"), Some("xhigh"))
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

    #[test]
    fn reproduces_the_launcher_selection_rules() {
        let insights = json!({"recommendations": [{"key": "hard_problems", "items": [
            {"model":"gpt-5.6-sol","effort":"ultra","iq":105.0,"average_cost_usd":20.0,"average_duration_minutes":44.0},
            {"model":"gpt-5.6-sol","effort":"max","iq":101.0,"average_cost_usd":6.5,"average_duration_minutes":35.0}
        ]}]});
        let efficiency = json!({"points": [
            {"model":"gpt-5.6-sol","effort":"high","iq":93.0,"average_price_usd":4.0,"average_minutes":20.0},
            {"model":"gpt-5.6-sol","effort":"medium","iq":90.0,"average_price_usd":2.9,"average_minutes":16.0},
            {"model":"gpt-5.6-terra","effort":"max","iq":95.0,"average_price_usd":2.0,"average_minutes":18.0},
            {"model":"gpt-5.6-luna","effort":"max","iq":96.0,"average_price_usd":0.48,"average_minutes":34.0},
            {"model":"gpt-5.6-luna","effort":"xhigh","iq":94.0,"average_price_usd":0.3,"average_minutes":33.0}
        ]});
        let table = build_model_table(&insights, &efficiency, 42).unwrap();
        assert_eq!(table.rows.len(), 6);
        assert_eq!(
            table
                .rows
                .iter()
                .map(|row| row.group.as_str())
                .collect::<Vec<_>>(),
            vec![
                "hard",
                "hard",
                "reference",
                "reference",
                "reference",
                "simple"
            ]
        );
        let simple = table.rows.iter().find(|row| row.group == "simple").unwrap();
        assert_eq!(
            (simple.model.as_str(), simple.effort.as_str()),
            ("gpt-5.6-luna", "max")
        );
        assert_eq!(
            (simple.iq, simple.price, simple.minutes),
            (96.0, 0.48, 34.0)
        );
        assert_eq!(
            table.rows.iter().find(|row| row.automatic).unwrap().effort,
            "max"
        );
        assert_eq!(
            table
                .rows
                .iter()
                .find(|row| row.default_cursor)
                .unwrap()
                .model,
            "gpt-5.6-terra"
        );
        assert!(table.rows[0].best_iq);
        assert!(!simple.best_iq);
        assert!(!simple.best_price);
        assert!(!simple.best_minutes);
        assert!(table
            .rows
            .iter()
            .any(|row| { row.best_price && row.model == "gpt-5.6-luna" && row.effort == "xhigh" }));
    }
}
