//! Chinese Decision 2B routing only. Request bodies and responses are never logged.
use crate::workspace_router_context::{count, fit_input, PromptInput};
use reqwest::{redirect::Policy, Client};
use serde::{ser::SerializeMap, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

pub(crate) const ENDPOINT: &str = "http://10.251.137.89:5050/harness-router/decision2";
pub(crate) const MODEL: &str = "chinese-decision-2b";
const MAX_BODY: usize = 1024 * 1024;
const INSTRUCTIONS: &str = "请选择最适合处理当前用户需求的一个主要工作区。根据候选介绍判断；涉及多个工作区时只选主要负责的一个。没有适合工作区时选择general。只做分类，不执行用户任务。历史纠错仅作参考，不覆盖当前需求。";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionPrompt {
    pub request: String,
    pub text_tokens: usize,
    pub examples_used: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionResult {
    pub primary: Option<String>,
    pub model: String,
    pub input_tokens: u64,
}
// Choice order is model input: preserve catalog order and keep general last.
// serde_json::Value sorts object keys and would change the A/B/... assignments.
struct Criteria<'a>(&'a [crate::workspace_router_context::Candidate]);
impl Serialize for Criteria<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len() + 1))?;
        for (i, c) in self.0.iter().enumerate() {
            map.serialize_entry(&format!("w{i}"), &format!("{}：{}", c.name, c.description))?;
        }
        map.serialize_entry(
            "general",
            "通用问答：日常交流和通用知识问答，不涉及任何特定项目的代码、运行数据或文件。",
        )?;
        map.end()
    }
}
#[derive(Serialize)]
struct Choice<'a> {
    r#type: &'static str,
    instructions: &'static str,
    criteria: Criteria<'a>,
}
#[derive(Serialize)]
struct Questions<'a> {
    workspace: Choice<'a>,
}
#[derive(Serialize)]
struct Correction {
    request: String,
    wrong: String,
    correct: String,
}
#[derive(Serialize)]
struct DecisionState {
    #[serde(rename = "用户需求")]
    request: String,
    #[serde(rename = "历史纠错示例", skip_serializing_if = "Vec::is_empty")]
    corrections: Vec<Correction>,
}
#[derive(Serialize)]
struct Body<'a> {
    state: DecisionState,
    questions: Questions<'a>,
}
fn request(input: &PromptInput) -> String {
    let id_for = |root: &Option<String>| {
        root.as_ref()
            .and_then(|r| input.candidates.iter().position(|c| &c.root == r))
            .map(|i| format!("w{i}"))
            .unwrap_or_else(|| "general".into())
    };
    let state = DecisionState {
        request: input.user_texts.join("\n\n"),
        corrections: input
            .examples
            .iter()
            .map(|e| Correction {
                request: e.request.clone(),
                wrong: id_for(&e.wrong),
                correct: id_for(&e.correct),
            })
            .collect(),
    };
    serde_json::to_string(&Body {
        state,
        questions: Questions {
            workspace: Choice {
                r#type: "choice",
                instructions: INSTRUCTIONS,
                criteria: Criteria(&input.candidates),
            },
        },
    })
    .expect("Decision request is serializable")
}
pub(crate) fn build_prompt(input: PromptInput) -> Result<DecisionPrompt, String> {
    if !(1..=25).contains(&input.candidates.len())
        || input.candidates.iter().any(|c| c.root.is_empty())
        || input
            .candidates
            .iter()
            .map(|c| &c.root)
            .collect::<HashSet<_>>()
            .len()
            != input.candidates.len()
    {
        return Err("Decision 2B需要1–25个不同工作区，更多工作区请使用Codex".into());
    }
    let (input, _, text_tokens) = fit_input(input, |input| {
        let body = request(input);
        let tokens = count(&body) + 64;
        (body, tokens)
    })?;
    let request = request(&input);
    if request.len() > MAX_BODY {
        return Err("Decision请求超过1 MiB限制".into());
    }
    Ok(DecisionPrompt {
        request,
        text_tokens,
        examples_used: input.examples.len(),
    })
}
async fn post(client: &Client, endpoint: &str, path: &str, body: &str) -> Result<Value, String> {
    let mut response = client
        .post(format!("{endpoint}{path}"))
        .header("Content-Type", "application/json")
        .body(body.to_owned())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Decision 2B请求超时，请重试或切换Codex"
            } else {
                "无法连接Decision 2B，请检查公司网络或切换Codex"
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        // Never echo upstream error bodies, which may contain the user request.
        return Err(if status.as_u16() == 422 {
            "Decision 2B输入不符合要求或超过16384 Token，请缩短需求或切换Codex".into()
        } else {
            format!("Decision 2B HTTP {}，请重试或切换Codex", status.as_u16())
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取Decision响应失败")? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("Decision响应超过1 MiB限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Decision 2B返回无效响应".into())
}
pub(crate) async fn evaluate(input: PromptInput) -> Result<DecisionResult, String> {
    evaluate_at(input, ENDPOINT).await
}
async fn evaluate_at(input: PromptInput, endpoint: &str) -> Result<DecisionResult, String> {
    let roots = input
        .candidates
        .iter()
        .map(|c| c.root.clone())
        .collect::<Vec<_>>();
    let prepared = tokio::task::spawn_blocking(move || build_prompt(input))
        .await
        .map_err(|_| "Decision输入准备失败")??;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| "无法初始化Decision客户端")?;
    let compiled = post(&client, endpoint, "/v1/compile", &prepared.request).await?;
    let tokens = compiled["questions"]["workspace"]["input_tokens"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 16384)
        .ok_or("Decision输入Token校验失败")?;
    if compiled["questions"]["workspace"]["options"]
        .as_array()
        .map(|v| v.len())
        != Some(roots.len() + 1)
    {
        return Err("Decision候选数量校验失败".into());
    }
    let result = post(&client, endpoint, "/v1/systemone", &prepared.request).await?;
    if result["model"].as_str() != Some(MODEL)
        || result["usage"]["input_tokens"].as_u64() != Some(tokens)
    {
        return Err("Decision模型或输入Token校验失败".into());
    }
    let choice = result["answers"]["workspace"]["choice"]
        .as_str()
        .ok_or("Decision未返回工作区选择")?;
    let primary = if choice == "general" {
        None
    } else {
        let index = choice
            .strip_prefix('w')
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or("Decision返回未知工作区")?;
        if format!("w{index}") != choice {
            return Err("Decision返回未知工作区".into());
        }
        Some(roots.get(index).ok_or("Decision返回未知工作区")?.clone())
    };
    Ok(DecisionResult {
        primary,
        model: MODEL.into(),
        input_tokens: tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_router_context::{Candidate, Example};
    fn input() -> PromptInput {
        PromptInput {
            instructions: String::new(),
            schema: String::new(),
            user_texts: vec!["private request".into()],
            candidates: vec![Candidate {
                root: "/dns".into(),
                checkout_root: "/checkout".into(),
                name: "DNS".into(),
                description: "接口".into(),
            }],
            examples: vec![Example {
                request: "old".into(),
                wrong: None,
                correct: Some("/dns".into()),
            }],
            token_budget: 2048,
            example_limit: 2,
        }
    }
    #[test]
    fn native_prompt_preserves_request_and_maps_feedback_without_sending_paths() {
        let prepared = build_prompt(input()).unwrap();
        assert!(
            prepared.request.find("\"w0\"").unwrap()
                < prepared.request.find("\"general\":").unwrap()
        );
        let out: Value = serde_json::from_str(&prepared.request).unwrap();
        assert_eq!(out["state"]["用户需求"], "private request");
        assert_eq!(out["state"]["历史纠错示例"][0]["correct"], "w0");
        assert_eq!(out["state"]["历史纠错示例"][0]["wrong"], "general");
        assert_eq!(out["questions"]["workspace"]["criteria"]["w0"], "DNS：接口");
        assert!(!prepared.request.contains("/checkout"));
        assert!(prepared.text_tokens <= 2048);
        let mut large = input();
        large.user_texts = vec!["原始输入。".repeat(5000)];
        assert!(build_prompt(large).is_err());
    }
    #[tokio::test]
    #[ignore = "manual test: calls the authorized 89 Decision 2B server"]
    async fn live_decision_2b_smoke() {
        let mut input = input();
        input.user_texts = vec!["解释一下 TCP 三次握手。".into()];
        input.examples.clear();
        let result = evaluate(input).await.unwrap();
        assert_eq!(result.model, MODEL);
        assert!(result.primary.is_none());
        println!(
            "Decision 2B smoke passed: model={}, input_tokens={}",
            result.model, result.input_tokens
        );
    }
    #[tokio::test]
    async fn validates_compile_and_choice_and_hides_upstream_error_text() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for (status, result, accepted) in [
            (
                200,
                json!({"model":MODEL,"usage":{"input_tokens":50},"answers":{"workspace":{"choice":"w0"}}}),
                true,
            ),
            (
                200,
                json!({"model":MODEL,"usage":{"input_tokens":50},"answers":{"workspace":{"choice":"invented"}}}),
                false,
            ),
            (
                200,
                json!({"model":MODEL,"usage":{"input_tokens":49},"answers":{"workspace":{"choice":"w0"}}}),
                false,
            ),
            (422, json!({"detail":"private request echoed"}), false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                for body in [
                    json!({"questions":{"workspace":{"input_tokens":50,"options":["w0","general"]}}}),
                    result,
                ] {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut buf = [0; 8192];
                    let _ = stream.read(&mut buf).unwrap();
                    let code = if body.get("questions").is_some() {
                        200
                    } else {
                        status
                    };
                    let text = body.to_string();
                    write!(stream, "HTTP/1.1 {code} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len()).unwrap();
                }
            });
            let result = evaluate_at(input(), &endpoint).await;
            assert_eq!(result.is_ok(), accepted);
            if let Ok(result) = result {
                assert_eq!(result.primary.as_deref(), Some("/dns"));
            } else {
                assert!(!result.unwrap_err().contains("private request"));
            }
            server.join().unwrap();
        }
    }
}
