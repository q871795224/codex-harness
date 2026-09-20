//! On-demand Jev evaluation via Vercel. Never log state, answers, or credentials.
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::ErrorKind, path::Path, time::Duration};

const ENDPOINT: &str = "https://ai-gateway.vercel.sh/v1/evaluate";
const MODEL: &str = "typesafe-ai/jev";
const MAX_BODY: usize = 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub struct JevRequest {
    pub state: Value,
    pub questions: BTreeMap<String, JevQuestion>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum JevQuestion {
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
    Boolean {
        instructions: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum JevAnswer {
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
    },
    Score {
        score: f64,
        probabilities: BTreeMap<String, f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
    },
    Boolean {
        probability: f64,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevUsage {
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevCosts {
    // Preserve decimal strings; missing cost must not be presented as free.
    cost: Option<String>,
    market_cost: Option<String>,
    gateway_cost: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponse {
    model: String,
    answers: BTreeMap<String, JevAnswer>,
    usage: JevUsage,
    #[serde(default)]
    provider_metadata: Metadata,
}

#[derive(Default, Deserialize)]
struct Metadata {
    #[serde(default)]
    gateway: JevCosts,
}

#[derive(Serialize)]
pub struct JevResponse {
    model: String,
    answers: BTreeMap<String, JevAnswer>,
    usage: JevUsage,
    costs: JevCosts,
}

#[derive(Serialize)]
pub struct JevStatus {
    pub configured: bool,
    model: &'static str,
}

pub struct JevClient {
    client: Client,
}

impl JevClient {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(10))
                .redirect(Policy::none())
                .build()
                .map_err(|_| "无法初始化 Jev HTTP 客户端")?,
        })
    }

    pub fn status(&self, secrets: &Path) -> Result<JevStatus, String> {
        Ok(JevStatus {
            configured: read_key(secrets)?.is_some(),
            model: MODEL,
        })
    }

    pub async fn evaluate(&self, secrets: &Path, input: JevRequest) -> Result<JevResponse, String> {
        let body = request_body(&input)?;
        let key = read_key(secrets)?
            .ok_or("Jev 未配置：请在 ~/.codex-harness/secrets 设置 VERCEL_API_KEY")?;
        self.send(ENDPOINT, &key, body, &input).await
    }

    async fn send(
        &self,
        endpoint: &str,
        key: &str,
        body: Vec<u8>,
        input: &JevRequest,
    ) -> Result<JevResponse, String> {
        let mut response = self
            .client
            .post(endpoint)
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            // Upstream errors may echo input or credentials: never relay their body.
            return Err(http_error(response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err("Jev 响应超过 1 MiB 限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let wire: WireResponse =
            serde_json::from_slice(&bytes).map_err(|_| "Jev 返回了无效响应")?;
        validate_answers(input, &wire.answers)?;
        Ok(JevResponse {
            model: wire.model,
            answers: wire.answers,
            usage: wire.usage,
            costs: wire.provider_metadata.gateway,
        })
    }
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Jev 请求超时"
    } else {
        "Jev 网络请求失败"
    }
    .into()
}

fn http_error(status: u16) -> String {
    let reason = match status {
        401 => "密钥无效或已过期",
        402 => "额度不足",
        403 => "账户验证或访问权限未满足",
        429 => "请求被限流，请稍后重试",
        500..=599 => "服务暂时不可用",
        _ => "请求被拒绝",
    };
    format!("Jev HTTP {status}：{reason}")
}

fn read_key(path: &Path) -> Result<Option<String>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 Jev 密钥文件".into()),
    };
    parse_key(&content)
}

fn parse_key(content: &str) -> Result<Option<String>, String> {
    let mut result = None;
    for line in content.lines() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != "VERCEL_API_KEY" {
            continue;
        }
        let value = value.trim();
        let value = if value.starts_with(['\'', '"']) {
            let quote = value.chars().next().unwrap();
            let Some(end) = value[1..].find(quote).map(|index| index + 1) else {
                return Err("VERCEL_API_KEY 引号不完整".into());
            };
            let tail = value[end + 1..].trim();
            if !tail.is_empty() && !tail.starts_with('#') {
                return Err("VERCEL_API_KEY 格式无效".into());
            }
            &value[1..end]
        } else {
            value
                .split_once(" #")
                .map_or(value, |(value, _)| value)
                .trim()
        };
        if value.is_empty() {
            result = None;
            continue;
        }
        if !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("VERCEL_API_KEY 格式无效".into());
        }
        result = Some(value.to_owned());
    }
    Ok(result)
}

fn request_body(input: &JevRequest) -> Result<Vec<u8>, String> {
    if !matches!(
        input.state,
        Value::String(_) | Value::Object(_) | Value::Array(_)
    ) || input.questions.is_empty()
    {
        return Err("Jev 需要文本、对象或数组 state，以及至少一个问题".into());
    }
    for (id, question) in &input.questions {
        if id.trim().is_empty() {
            return Err("Jev 问题名称不能为空".into());
        }
        let (instructions, valid) = match question {
            JevQuestion::Boolean { instructions } => (instructions, true),
            JevQuestion::Choice {
                instructions,
                criteria,
            } => (
                instructions,
                (2..=255).contains(&criteria.len())
                    && criteria.keys().all(|key| !key.trim().is_empty()),
            ),
            JevQuestion::Score {
                instructions,
                criteria,
            } => (
                instructions,
                (2..=10).contains(&criteria.len())
                    && criteria.iter().all(|level| !level.trim().is_empty()),
            ),
        };
        if instructions.trim().is_empty() || !valid {
            return Err("Jev 问题或评分标准无效".into());
        }
    }
    let body = serde_json::to_vec(
        &json!({"model": MODEL, "state": input.state, "questions": input.questions}),
    )
    .map_err(|_| "无法编码 Jev 请求")?;
    if body.len() > MAX_BODY {
        return Err("Jev 请求超过 1 MiB 限制".into());
    }
    Ok(body)
}

fn probability(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn distribution(values: &BTreeMap<String, f64>, confidence: &Option<f64>) -> bool {
    values.values().all(|value| probability(*value))
        && (values.values().sum::<f64>() - 1.0).abs() <= 0.02
        && confidence.is_none_or(probability)
}

fn validate_answers(
    input: &JevRequest,
    answers: &BTreeMap<String, JevAnswer>,
) -> Result<(), String> {
    let valid = input.questions.len() == answers.len()
        && input
            .questions
            .iter()
            .all(|(id, question)| match (question, answers.get(id)) {
                (JevQuestion::Boolean { .. }, Some(JevAnswer::Boolean { probability: value })) => {
                    probability(*value)
                }
                (
                    JevQuestion::Choice { criteria, .. },
                    Some(JevAnswer::Choice {
                        choice,
                        probabilities,
                        confidence,
                    }),
                ) => {
                    criteria.contains_key(choice)
                        && criteria.keys().eq(probabilities.keys())
                        && distribution(probabilities, confidence)
                }
                (
                    JevQuestion::Score { criteria, .. },
                    Some(JevAnswer::Score {
                        score,
                        probabilities,
                        confidence,
                    }),
                ) => {
                    score.is_finite()
                        && (0.0..=(criteria.len() - 1) as f64).contains(score)
                        && probabilities.len() == criteria.len()
                        && (0..criteria.len())
                            .all(|index| probabilities.contains_key(&index.to_string()))
                        && distribution(probabilities, confidence)
                }
                _ => false,
            });
    if valid {
        Ok(())
    } else {
        Err("Jev 响应与问题不匹配或概率无效".into())
    }
}

#[cfg(test)]
mod tests;
