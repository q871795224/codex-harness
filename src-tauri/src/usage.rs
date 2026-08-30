use crate::app_server::{read_rate_limits_for_home, AppServerManager};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{process::Command, time::timeout};

const AIS_USAGE_URL: &str = "https://compass.llm.shopee.io/api/v1/cqp/ccswitch/monthly_usage";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub fetched_at: u64,
    pub since: String,
    pub until: String,
    pub providers: Vec<UsageProvider>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProvider {
    pub id: String,
    pub label: String,
    pub source_kind: String,
    pub status: String,
    pub message: Option<String>,
    pub totals: UsageTotals,
    pub periods: Vec<UsagePeriod>,
    pub models: Vec<ModelUsage>,
    pub quota: Vec<RateWindow>,
    pub budget: Option<UsageBudget>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePeriod {
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBudget {
    pub used_usd: f64,
    pub total_usd: f64,
}

pub async fn collect(
    app_server: &AppServerManager,
    real_codex_home: PathBuf,
    since: String,
    until: String,
) -> Result<UsageSnapshot, String> {
    validate_date(&since)?;
    validate_date(&until)?;
    let real_home = real_codex_home
        .parent()
        .ok_or_else(|| "无法确定真实用户目录。".to_string())?
        .to_path_buf();
    let personal_codex_home = real_home.join(".codex-personal");

    let business_history = collect_ccusage(
        "codex-business",
        "Codex Business",
        "codex",
        Some(&real_codex_home),
        &real_home,
        &since,
        &until,
    );
    let personal_history = collect_ccusage(
        "codex-personal",
        "Codex Personal",
        "codex",
        Some(&personal_codex_home),
        &real_home,
        &since,
        &until,
    );
    let claude = collect_ccusage(
        "claude",
        "Claude Code",
        "claude",
        None,
        &real_home,
        &since,
        &until,
    );
    let opencode = collect_ccusage(
        "opencode", "OpenCode", "opencode", None, &real_home, &since, &until,
    );
    let business_limits = app_server.request("account/rateLimits/read".to_string(), json!({}));
    let personal_limits = async {
        if personal_codex_home.is_dir() {
            read_rate_limits_for_home(&personal_codex_home).await
        } else {
            Err("未找到账号目录".to_string())
        }
    };
    let ais = collect_ais(&real_home, &until);

    let (mut business, mut personal, claude, opencode, business_limits, personal_limits, ais) = futures_util::join!(
        business_history,
        personal_history,
        claude,
        opencode,
        business_limits,
        personal_limits,
        ais,
    );
    attach_rate_limits(&mut business, business_limits);
    attach_rate_limits(&mut personal, personal_limits);

    Ok(UsageSnapshot {
        fetched_at: now_millis(),
        since,
        until,
        providers: vec![business, personal, ais, claude, opencode],
    })
}

async fn collect_ccusage(
    id: &str,
    label: &str,
    agent: &str,
    codex_home: Option<&Path>,
    real_home: &Path,
    since: &str,
    until: &str,
) -> UsageProvider {
    let mut provider = empty_provider(id, label, agent);
    if codex_home.is_some_and(|path| !path.exists()) {
        provider.status = "unavailable".to_string();
        provider.message = Some("未找到账号目录".to_string());
        return provider;
    }
    let Some(executable) = find_executable("ccusage", real_home) else {
        provider.status = "unavailable".to_string();
        provider.message = Some("未找到 ccusage".to_string());
        return provider;
    };
    let mut command = Command::new(executable);
    command
        .args([
            agent,
            "daily",
            "--since",
            since,
            "--until",
            until,
            "--offline",
            "--json",
        ])
        .env("HOME", real_home)
        .env("PATH", executable_path(real_home))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(codex_home) = codex_home {
        command.env("CODEX_HOME", codex_home);
    }
    let output = match timeout(Duration::from_secs(120), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            provider.status = "error".to_string();
            provider.message = Some(format!("无法运行 ccusage: {error}"));
            return provider;
        }
        Err(_) => {
            provider.status = "error".to_string();
            provider.message = Some("ccusage 请求超时".to_string());
            return provider;
        }
    };
    if !output.status.success() {
        provider.status = "error".to_string();
        provider.message = Some("ccusage 返回失败".to_string());
        return provider;
    }
    match serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| format!("ccusage JSON 无效: {error}"))
        .and_then(|value| parse_ccusage_provider(id, label, agent, &value))
    {
        Ok(parsed) => parsed,
        Err(error) => {
            provider.status = "error".to_string();
            provider.message = Some(error);
            provider
        }
    }
}

fn parse_ccusage_provider(
    id: &str,
    label: &str,
    agent: &str,
    value: &Value,
) -> Result<UsageProvider, String> {
    let daily = value
        .get("daily")
        .and_then(Value::as_array)
        .ok_or_else(|| "ccusage 响应缺少 daily".to_string())?;
    let mut periods = Vec::with_capacity(daily.len());
    let mut models = BTreeMap::<String, ModelUsage>::new();
    for row in daily {
        let date = row
            .get("date")
            .or_else(|| row.get("period"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if date.is_empty() {
            continue;
        }
        periods.push(UsagePeriod {
            date,
            input_tokens: integer(row, "inputTokens"),
            output_tokens: integer(row, "outputTokens"),
            cache_read_tokens: integer(row, "cacheReadTokens"),
            cache_creation_tokens: integer(row, "cacheCreationTokens"),
            reasoning_output_tokens: integer(row, "reasoningOutputTokens"),
            total_tokens: integer(row, "totalTokens"),
            cost_usd: number(row, "costUSD")
                .or_else(|| number(row, "totalCost"))
                .unwrap_or(0.0),
        });
        if let Some(entries) = row.get("models").and_then(Value::as_object) {
            for (name, data) in entries {
                merge_model(&mut models, name, data);
            }
        }
        if let Some(entries) = row.get("modelBreakdowns").and_then(Value::as_array) {
            for data in entries {
                let Some(name) = data.get("modelName").and_then(Value::as_str) else {
                    continue;
                };
                merge_model(&mut models, name, data);
            }
        }
    }
    periods.sort_by(|left, right| left.date.cmp(&right.date));
    let totals = sum_periods(&periods);
    Ok(UsageProvider {
        id: id.to_string(),
        label: label.to_string(),
        source_kind: agent.to_string(),
        status: "ready".to_string(),
        message: None,
        totals,
        periods,
        models: models.into_values().collect(),
        quota: Vec::new(),
        budget: None,
    })
}

fn merge_model(models: &mut BTreeMap<String, ModelUsage>, name: &str, data: &Value) {
    let entry = models
        .entry(name.to_string())
        .or_insert_with(|| ModelUsage {
            model: name.to_string(),
            ..ModelUsage::default()
        });
    let input_tokens = integer(data, "inputTokens");
    let output_tokens = integer(data, "outputTokens");
    let cache_read_tokens = integer(data, "cacheReadTokens");
    let cache_creation_tokens = integer(data, "cacheCreationTokens");
    entry.input_tokens += input_tokens;
    entry.output_tokens += output_tokens;
    entry.cache_read_tokens += cache_read_tokens;
    entry.cache_creation_tokens += cache_creation_tokens;
    entry.reasoning_output_tokens += integer(data, "reasoningOutputTokens");
    entry.total_tokens += integer_option(data, "totalTokens")
        .unwrap_or(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens);
    entry.cost_usd += number(data, "costUSD")
        .or_else(|| number(data, "cost"))
        .unwrap_or(0.0);
}

fn sum_periods(periods: &[UsagePeriod]) -> UsageTotals {
    periods
        .iter()
        .fold(UsageTotals::default(), |mut total, period| {
            total.input_tokens += period.input_tokens;
            total.output_tokens += period.output_tokens;
            total.cache_read_tokens += period.cache_read_tokens;
            total.cache_creation_tokens += period.cache_creation_tokens;
            total.reasoning_output_tokens += period.reasoning_output_tokens;
            total.total_tokens += period.total_tokens;
            total.cost_usd += period.cost_usd;
            total
        })
}

fn attach_rate_limits(provider: &mut UsageProvider, result: Result<Value, String>) {
    match result {
        Ok(value) => {
            let quota = parse_rate_limits(&value);
            if quota.is_empty() {
                provider.message = Some(match provider.message.take() {
                    Some(history) => format!("{history}；额度接口未返回窗口"),
                    None => "额度接口未返回窗口".to_string(),
                });
                return;
            }
            provider.quota = quota;
            if provider.status != "ready" {
                provider.status = "ready".to_string();
                provider.message = provider
                    .message
                    .take()
                    .map(|message| format!("Token 历史不可用：{message}"));
            }
        }
        Err(error) if provider.status == "ready" => {
            provider.message = Some(format!("额度不可用：{error}"));
        }
        Err(error) => {
            provider.message = Some(match provider.message.take() {
                Some(history) => format!("{history}；额度不可用：{error}"),
                None => format!("额度不可用：{error}"),
            });
        }
    }
}

fn parse_rate_limits(value: &Value) -> Vec<RateWindow> {
    let snapshot = value
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get("codex").or_else(|| limits.values().next()))
        .or_else(|| value.get("rateLimits"))
        .unwrap_or(value);
    let mut windows = Vec::new();
    for (key, fallback_label) in [
        ("primary", "5 小时"),
        ("secondary", "每周"),
        ("individualLimit", "月度额度"),
    ] {
        let Some(window) = snapshot.get(key) else {
            continue;
        };
        let duration = integer_option(window, "windowDurationMins");
        let used = number(window, "usedPercent")
            .or_else(|| number(window, "remainingPercent").map(|remaining| 100.0 - remaining))
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        let label = match duration {
            Some(300) => "5 小时",
            Some(minutes) if minutes >= 7 * 24 * 60 => "每周",
            _ => fallback_label,
        };
        windows.push(RateWindow {
            label: label.to_string(),
            used_percent: used,
            remaining_percent: (100.0 - used).clamp(0.0, 100.0),
            window_duration_mins: duration,
            resets_at: integer_option(window, "resetsAt"),
        });
    }
    windows
}

async fn collect_ais(real_home: &Path, until: &str) -> UsageProvider {
    let mut provider = empty_provider("ais", "AIS", "ais");
    let auth_path = real_home.join(".ais-switch/google_oauth_auth.json");
    let auth = match fs::read_to_string(auth_path)
        .map_err(|_| "未找到 AIS Switch 登录信息".to_string())
        .and_then(|text| {
            serde_json::from_str::<Value>(&text).map_err(|_| "AIS Switch 登录信息无效".to_string())
        }) {
        Ok(auth) => auth,
        Err(error) => {
            provider.status = "unavailable".to_string();
            provider.message = Some(error);
            return provider;
        }
    };
    let Some(cookie) = auth.get("sso_session_cookie").and_then(Value::as_str) else {
        provider.status = "unavailable".to_string();
        provider.message = Some("AIS Switch 登录信息缺少 cookie".to_string());
        return provider;
    };
    let Some(project_id) = auth.get("project_id").and_then(Value::as_str) else {
        provider.status = "unavailable".to_string();
        provider.message = Some("AIS Switch 登录信息缺少 project id".to_string());
        return provider;
    };
    if auth
        .get("sso_session_cookie_exp")
        .and_then(Value::as_u64)
        .is_some_and(|expires_at| expires_at <= now_seconds())
    {
        provider.status = "unavailable".to_string();
        provider.message = Some("AIS Switch 登录已过期".to_string());
        return provider;
    }
    let (year, month) = date_year_month(until).unwrap_or((1970, 1));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            provider.status = "error".to_string();
            provider.message = Some(format!("无法初始化 AIS 客户端：{error}"));
            return provider;
        }
    };
    let response = client
        .post(AIS_USAGE_URL)
        .header("Cookie", cookie)
        .json(&json!({ "project_id": project_id, "selected_year": year, "selected_month": month }))
        .send()
        .await;
    let data = match response {
        Ok(response) => response.json::<Value>().await,
        Err(error) => {
            provider.status = "error".to_string();
            provider.message = Some(format!("AIS 请求失败：{error}"));
            return provider;
        }
    };
    match data {
        Ok(data) if data.get("retcode").and_then(Value::as_i64) == Some(0) => {
            let info = data.get("data").unwrap_or(&Value::Null);
            provider.status = "ready".to_string();
            provider.budget = Some(UsageBudget {
                used_usd: number(info, "usage").unwrap_or(0.0),
                total_usd: number(info, "total_amount").unwrap_or(0.0),
            });
        }
        Ok(_) => {
            provider.status = "error".to_string();
            provider.message = Some("AIS 返回失败状态".to_string());
        }
        Err(error) => {
            provider.status = "error".to_string();
            provider.message = Some(format!("AIS 响应无效：{error}"));
        }
    }
    provider
}

fn empty_provider(id: &str, label: &str, source_kind: &str) -> UsageProvider {
    UsageProvider {
        id: id.to_string(),
        label: label.to_string(),
        source_kind: source_kind.to_string(),
        status: "unavailable".to_string(),
        message: None,
        totals: UsageTotals::default(),
        periods: Vec::new(),
        models: Vec::new(),
        quota: Vec::new(),
        budget: None,
    }
}

fn find_executable(name: &str, real_home: &Path) -> Option<PathBuf> {
    let mut directories = executable_dirs(real_home);
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    directories
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn executable_path(real_home: &Path) -> String {
    let mut directories = executable_dirs(real_home);
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    env::join_paths(directories)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn executable_dirs(real_home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        real_home.join(".local/bin"),
    ];
    if let Ok(entries) = fs::read_dir(real_home.join(".nvm/versions/node")) {
        let mut node_bins = entries
            .flatten()
            .map(|entry| entry.path().join("bin"))
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        node_bins.sort();
        node_bins.reverse();
        directories.extend(node_bins);
    }
    directories
}

fn validate_date(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        let month = value[5..7].parse::<u8>().unwrap_or(0);
        let day = value[8..10].parse::<u8>().unwrap_or(0);
        if (1..=12).contains(&month) && (1..=31).contains(&day) {
            return Ok(());
        }
    }
    Err("用量日期格式无效。".to_string())
}

fn date_year_month(value: &str) -> Option<(u16, u8)> {
    validate_date(value).ok()?;
    Some((value[0..4].parse().ok()?, value[5..7].parse().ok()?))
}

fn integer(value: &Value, key: &str) -> u64 {
    integer_option(value, key).unwrap_or(0)
}

fn integer_option(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
    })
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_and_claude_daily_shapes() {
        let codex = json!({ "daily": [{
            "date": "2026-08-30", "inputTokens": 10, "outputTokens": 5,
            "cacheReadTokens": 20, "reasoningOutputTokens": 3, "totalTokens": 35,
            "costUSD": 1.25, "models": { "gpt-test": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 35 } }
        }] });
        let claude = json!({ "daily": [{
            "date": "2026-08-30", "inputTokens": 4, "outputTokens": 2, "totalTokens": 6,
            "totalCost": 0.5, "modelBreakdowns": [{ "modelName": "claude-test", "inputTokens": 4, "outputTokens": 2, "totalTokens": 6 }]
        }] });
        let codex = parse_ccusage_provider("business", "Business", "codex", &codex).unwrap();
        let claude = parse_ccusage_provider("claude", "Claude", "claude", &claude).unwrap();
        assert_eq!(codex.totals.total_tokens, 35);
        assert_eq!(codex.models[0].model, "gpt-test");
        assert_eq!(claude.totals.cost_usd, 0.5);
        assert_eq!(claude.models[0].model, "claude-test");
    }

    #[test]
    fn normalizes_codex_rate_limit_windows() {
        let windows = parse_rate_limits(&json!({ "rateLimitsByLimitId": { "codex": {
            "primary": { "usedPercent": 20, "windowDurationMins": 300, "resetsAt": 123 },
            "secondary": { "usedPercent": 70, "windowDurationMins": 10080 }
        }}}));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5 小时");
        assert_eq!(windows[0].remaining_percent, 80.0);
        assert_eq!(windows[1].label, "每周");
    }

    #[test]
    fn rejects_non_iso_date_arguments() {
        assert!(validate_date("2026-08-30").is_ok());
        assert!(validate_date("2026-08-30 --json").is_err());
        assert!(validate_date("2026-99-30").is_err());
    }
}
