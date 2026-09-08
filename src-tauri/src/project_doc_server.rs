//! 项目文档本地回传 HTTP 服务（Agent → Harness）。
//!
//! Agent 不直接写文档文件，也不 emit 文本标记块；它运行 skill 提供的 `project-doc`
//! 命令，命令把写意图 POST 到本服务。本服务：
//! - 只绑 `127.0.0.1:0`（随机端口，仅 loopback），端口写到 `<harness_dir>/project-doc-server.json`
//!   供 skill 命令读取；
//! - `POST /propose` `{thread_id, project_id, section, content}` → 校验绑定 → 读当前 seq 补
//!   `base_seq` → 追加区直接落盘、受控区（status）入待审批队列 → 立即返回（不阻塞 Agent）；
//! - `GET /read?project_id=` → 返回当前正文 + seq（Agent 改 Status 前先读）。
//!
//! 写入权与 seq CAS 仍在 `project_doc_store`（本服务不直接落盘受控区）。传输是极简手写
//! HTTP/1.1（与代码库「不引 Web 框架」一致），请求体上限 256 KiB。

use crate::project_doc_proposals::{self, ProposalQueue};
use crate::project_doc_store::{ProjectDocStore, WriteOutcome};
use crate::store;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const MAX_BODY_BYTES: usize = 256 * 1024;
const ENDPOINT_STATE_FILE: &str = "project-doc-server.json";

/// 线程绑定信息（供 /propose 校验 project 是否真绑在该 thread 上）。
/// 绑定存在 state.sqlite 的 appState 里，这里注入一个查询闭包，避免本模块直接依赖 store 细节。
pub type ThreadProjectLookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposeRequest {
    thread_id: String,
    project_id: String,
    section: String,
    content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeResponse {
    pub queued: bool,
    /// 追加区=true（已直接落盘）；受控区=false（待审批）。
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 处理一次 propose 的核心逻辑（与传输解耦，便于单测）。
/// 返回 (HTTP 状态码, body)。
pub fn handle_propose(
    store: &ProjectDocStore,
    proposals: &ProposalQueue,
    lookup: &ThreadProjectLookup,
    req: &ProposeRequest,
) -> (u16, Value) {
    // 校验：project 必须真绑在该 thread（防 Agent 传错/越权写别的项目）。
    match lookup(&req.thread_id) {
        Some(bound) if bound == req.project_id => {}
        Some(_) => {
            return (403, json!({ "error": format!("项目 {} 未绑定在会话 {}", req.project_id, req.thread_id) }))
        }
        None => {
            return (404, json!({ "error": format!("会话 {} 未绑定任何项目", req.thread_id) }))
        }
    }
    let section = req.section.trim().to_string();
    let content = req.content.trim().to_string();
    if content.is_empty() {
        return (400, json!({ "error": "内容为空" }));
    }

    let is_append = matches!(section.as_str(), "log" | "decisions" | "openQuestions");
    let is_controlled = section == "status";
    if !is_append && !is_controlled {
        return (400, json!({ "error": format!("未知分区 `{section}`") }));
    }

    let current_seq = match store.get_project(&req.project_id) {
        Ok(meta) => meta.current_seq,
        Err(e) => return (404, json!({ "error": e })),
    };

    if is_append {
        // 追加区：免审批直落盘（seq CAS 在 store 内兜底）。
        match store.write_section(&req.project_id, &section, None, &content, &req.thread_id, "Agent 追加（经 HTTP 回传）") {
            Ok(WriteOutcome::Applied { new_seq, .. }) => {
                (200, json!(ProposeResponse { queued: true, applied: true, new_seq: Some(new_seq), reason: None }))
            }
            Ok(WriteOutcome::Conflict { .. }) => (409, json!({ "error": "追加写入冲突" })),
            Err(e) => (500, json!({ "error": e })),
        }
    } else {
        // 受控区：入待审批队列，base_seq 用入队时的当前 seq。
        let proposal = project_doc_proposals::new_proposal(
            &req.project_id,
            &req.thread_id,
            &section,
            &content,
            current_seq,
        );
        let id = proposal.id.clone();
        match proposals.enqueue(&proposal) {
            Ok(()) => (202, json!({ "queued": true, "applied": false, "proposalId": id, "baseSeq": current_seq })),
            Err(e) => (500, json!({ "error": e })),
        }
    }
}

/// 处理 GET /read：返回当前正文 + seq。
pub fn handle_read(store: &ProjectDocStore, project_id: &str) -> (u16, Value) {
    match store.read_doc(project_id) {
        Ok(snapshot) => (200, json!({
            "projectId": snapshot.project_id,
            "currentSeq": snapshot.current_seq,
            "content": snapshot.content,
        })),
        Err(e) => (404, json!({ "error": e })),
    }
}

/// 启动本地 HTTP 服务（绑定随机 loopback 端口），把端口写入 endpoint 状态文件。
/// 返回绑定的端口。服务在后台 tokio 任务里跑，随 Harness 进程退出。
pub async fn serve(
    store: ProjectDocStore,
    proposals: ProposalQueue,
    lookup: ThreadProjectLookup,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法绑定本地项目文档服务: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取项目文档服务地址: {e}"))?
        .port();

    write_endpoint_state(port)?;

    let store = Arc::new(store);
    let proposals = Arc::new(proposals);
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let store = store.clone();
                    let proposals = proposals.clone();
                    let lookup = lookup.clone();
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, store, proposals, lookup).await;
                    });
                }
                Err(_) => break,
            }
        }
    });
    Ok(port)
}

/// 把当前端口写到 `<harness_dir>/project-doc-server.json`，供 skill 命令读取。
fn write_endpoint_state(port: u16) -> Result<(), String> {
    let dir = store::harness_data_dir()?;
    let path = dir.join(ENDPOINT_STATE_FILE);
    let body = json!({ "baseUrl": format!("http://127.0.0.1:{port}") });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?)
        .map_err(|e| format!("无法写入项目文档服务端点文件 {}: {e}", path.display()))
}

/// 处理单个连接：解析请求行 + 头 + 体，路由到 handler，写响应。
async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    store: Arc<ProjectDocStore>,
    proposals: Arc<ProposalQueue>,
    lookup: ThreadProjectLookup,
) -> Result<(), String> {
    let mut buffer = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    // 读到头结束（\r\n\r\n）为止。
    let header_end = loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("读取请求失败: {e}"))?;
        if n == 0 {
            return Err("连接提前关闭".to_string());
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
            break pos;
        }
        if buffer.len() > 64 * 1024 {
            return Err("请求头过大".to_string());
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let raw_path = parts.next().unwrap_or("").to_string();

    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        return write_response(&mut stream, 413, json!({ "error": "请求体过大" })).await;
    }

    // 体可能已部分随头一起到达；补齐到 content_length。
    let body_start = header_end + 4;
    while buffer.len() - body_start < content_length {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("读取请求体失败: {e}"))?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let body = &buffer[body_start..std::cmp::min(buffer.len(), body_start + content_length)];

    // 路由。
    let (path, query) = split_query(&raw_path);
    let (status, payload) = match (method.as_str(), path.as_str()) {
        ("POST", "/propose") => match serde_json::from_slice::<ProposeRequest>(body) {
            Ok(req) => handle_propose(&store, &proposals, &lookup, &req),
            Err(e) => (400, json!({ "error": format!("请求体不是合法 JSON: {e}") })),
        },
        ("GET", "/read") => {
            let project_id = query_param(&query, "project_id").unwrap_or_default();
            if project_id.is_empty() {
                (400, json!({ "error": "缺少 project_id" }))
            } else {
                handle_read(&store, &project_id)
            }
        }
        _ => (404, json!({ "error": "未知端点" })),
    };

    write_response(&mut stream, status, payload).await
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    payload: Value,
) -> Result<(), String> {
    let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("写响应失败: {e}"))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn split_query(raw: &str) -> (String, String) {
    match raw.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (raw.to_string(), String::new()),
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_doc_proposals::ProposalQueue;
    use rusqlite::Connection;

    fn lookup_binding(pairs: &[(&str, &str)]) -> ThreadProjectLookup {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(t, p)| (t.to_string(), p.to_string()))
            .collect();
        Arc::new(move |thread_id: &str| map.get(thread_id).cloned())
    }

    fn stores() -> (tempfile::TempDir, ProjectDocStore, ProposalQueue) {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectDocStore::open_at(dir.path().to_path_buf()).unwrap();
        let proposals = ProposalQueue::open_at(Connection::open_in_memory().unwrap()).unwrap();
        (dir, store, proposals)
    }

    fn req(thread: &str, project: &str, section: &str, content: &str) -> ProposeRequest {
        ProposeRequest {
            thread_id: thread.into(),
            project_id: project.into(),
            section: section.into(),
            content: content.into(),
        }
    }

    #[test]
    fn propose_append_writes_directly() {
        let (_d, store, proposals) = stores();
        store.create_project("p1", "Demo").unwrap();
        let lookup = lookup_binding(&[("t1", "p1")]);
        let (status, body) = handle_propose(&store, &proposals, &lookup, &req("t1", "p1", "log", "进展一条"));
        assert_eq!(status, 200);
        assert_eq!(body["applied"], true);
        assert!(store.read_doc("p1").unwrap().content.contains("进展一条"));
        assert_eq!(proposals.list_pending("p1").unwrap().len(), 0);
    }

    #[test]
    fn propose_status_enqueues_with_current_seq() {
        let (_d, store, proposals) = stores();
        store.create_project("p1", "Demo").unwrap();
        store.write_section("p1", "status", Some(0), "已有", "user", "init").unwrap();
        let lookup = lookup_binding(&[("t1", "p1")]);
        let (status, body) = handle_propose(&store, &proposals, &lookup, &req("t1", "p1", "status", "### run: 新状态"));
        assert_eq!(status, 202);
        assert_eq!(body["applied"], false);
        // 未落盘（待人审批），进了队列，base_seq 是当前 seq=1。
        assert!(!store.read_doc("p1").unwrap().content.contains("新状态"));
        let pending = proposals.list_pending("p1").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].base_seq, 1);
        assert_eq!(pending[0].content, "### run: 新状态");
    }

    #[test]
    fn propose_rejects_unbound_or_mismatched_project() {
        let (_d, store, proposals) = stores();
        store.create_project("p1", "Demo").unwrap();
        let lookup = lookup_binding(&[("t1", "p1")]);
        // 会话绑的是 p1，却来写 p2 → 403。
        let (status, _) = handle_propose(&store, &proposals, &lookup, &req("t1", "p2", "log", "x"));
        assert_eq!(status, 403);
        // 会话没绑项目 → 404。
        let (status, _) = handle_propose(&store, &proposals, &lookup, &req("t9", "p1", "log", "x"));
        assert_eq!(status, 404);
    }

    #[test]
    fn propose_rejects_unknown_section_and_empty_content() {
        let (_d, store, proposals) = stores();
        store.create_project("p1", "Demo").unwrap();
        let lookup = lookup_binding(&[("t1", "p1")]);
        let (status, _) = handle_propose(&store, &proposals, &lookup, &req("t1", "p1", "random", "x"));
        assert_eq!(status, 400);
        let (status, _) = handle_propose(&store, &proposals, &lookup, &req("t1", "p1", "log", "   "));
        assert_eq!(status, 400);
    }

    #[test]
    fn read_returns_body_and_seq() {
        let (_d, store, _p) = stores();
        store.create_project("p1", "Demo").unwrap();
        store.write_section("p1", "status", Some(0), "状态正文", "user", "init").unwrap();
        let (status, body) = handle_read(&store, "p1");
        assert_eq!(status, 200);
        assert_eq!(body["currentSeq"], 1);
        assert!(body["content"].as_str().unwrap().contains("状态正文"));
        // 不含 front matter。
        assert!(!body["content"].as_str().unwrap().contains("doc_id:"));
    }

    #[test]
    fn query_parsing() {
        assert_eq!(query_param("project_id=abc&x=1", "project_id"), Some("abc".into()));
        assert_eq!(query_param("a=1", "project_id"), None);
        assert_eq!(percent_decode("hello%20world"), "hello world");
    }
}
