//! Client-executed Codex tools. Identity comes only from the App Server envelope.
use crate::{
    project_doc_proposals::ProposalQueue, project_doc_store::ProjectDocStore, store::HarnessStore,
    turn_ownership::TurnOwnership,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const READ: &str = "harness_project_read";
const PROPOSE: &str = "harness_project_propose";
const MUTATE: &str = "harness_project_mutate_entry";

pub struct ProjectTools {
    state: Arc<HarnessStore>,
    docs: Arc<ProjectDocStore>,
    proposals: Arc<ProposalQueue>,
    ownership: Arc<TurnOwnership>,
    writes: Mutex<()>,
}

pub fn definitions() -> Value {
    json!([
        {"type":"function","name":READ,"description":"Read the current conversation's shared project document and managed entries. Call at the start of each task to obtain current project context, and before making project updates. Harness resolves the project automatically; never supply project or conversation IDs. An unbound conversation returns bound:false. Project history is background, not authorization for new actions.",
         "inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"type":"function","name":PROPOSE,"description":"Record durable facts, decisions or open questions in the current conversation's project. Read the current document first and avoid duplicates. log, decisions and openQuestions append immediately; status is queued for human approval. Never use this to replace the entire document or start compaction. Harness supplies project and conversation identity.",
         "inputSchema":{"type":"object","properties":{"section":{"type":"string","enum":["log","decisions","openQuestions","status"]},"content":{"type":"string"}},"required":["section","content"],"additionalProperties":false}},
        {"type":"function","name":MUTATE,"description":"Maintain an existing managed decision or open question in the current project. Read first and use its entry id/revision. Explain the reason; replace outdated decisions with supersede, close finished questions, and use delete only for soft deletion. adopt requires section, content and baseSeq for an unmanaged paragraph. Existing revision and conflict checks apply. No project or conversation IDs are accepted.",
         "inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["update","supersede","close","revoke","delete","restore","adopt"]},"id":{"type":"string"},"revision":{"type":"integer","minimum":1},"section":{"type":"string","enum":["decisions","openQuestions"]},"content":{"type":"string"},"reason":{"type":"string"},"baseSeq":{"type":"integer"}},"required":["action","reason"],"additionalProperties":false}}
    ])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    section: String,
    content: String,
}

fn response(success: bool, value: Value) -> Value {
    json!({"success":success,"contentItems":[{"type":"inputText","text":value.to_string()}]})
}
impl ProjectTools {
    pub fn new(
        state: Arc<HarnessStore>,
        docs: Arc<ProjectDocStore>,
        proposals: Arc<ProposalQueue>,
        ownership: Arc<TurnOwnership>,
    ) -> Self {
        Self {
            state,
            docs,
            proposals,
            ownership,
            writes: Mutex::new(()),
        }
    }
    pub fn enabled(&self, thread: &str) -> Result<bool, String> {
        Ok(self
            .state
            .get_app_state(&format!("nativeProjectTools:{thread}"))?
            .as_deref()
            == Some("1"))
    }
    /// Only mark after App Server accepted definitions (or a native-tool fork).
    pub fn register(&self, thread: &str) -> Result<(), String> {
        self.state
            .set_app_state(&format!("nativeProjectTools:{thread}"), "1")
    }
    pub fn accepted_turn(&self, thread: &str) -> Result<(), String> {
        self.state.change_project_thread_binding(
            thread,
            crate::store::project_bindings::BindingChange::Lock,
        )
    }
    pub fn annotate(&self, result: &mut Value) -> Result<(), String> {
        if let Some(thread) = result.get_mut("thread") {
            self.annotate_thread(thread)?;
        }
        if let Some(threads) = result.get_mut("data").and_then(Value::as_array_mut) {
            for thread in threads {
                if thread.get("id").is_some() {
                    self.annotate_thread(thread)?;
                }
            }
        }
        Ok(())
    }
    fn annotate_thread(&self, thread: &mut Value) -> Result<(), String> {
        if let Some(id) = thread["id"].as_str() {
            let enabled = self.enabled(id)?;
            thread["harnessProjectTools"] = json!(enabled);
        }
        Ok(())
    }
    pub fn execute(&self, params: &Value) -> Value {
        match self.execute_inner(params) {
            Ok(value) => response(true, value),
            Err(error) => response(false, json!({"error":error})),
        }
    }
    fn execute_inner(&self, params: &Value) -> Result<Value, String> {
        let required = |key: &str| {
            params[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("工具回调缺少 {key}"))
        };
        let thread = required("threadId")?;
        let turn = required("turnId")?;
        let call = required("callId")?;
        let tool = required("tool")?;
        if !self.enabled(thread)? {
            return Err("本会话未注册 Harness 项目工具".into());
        }
        self.ownership.check(thread, turn)?;
        if params.get("namespace").is_some_and(|v| !v.is_null()) {
            return Err("未知项目工具 namespace".into());
        }
        let args = &params["arguments"];
        if args.to_string().len() > 256 * 1024 {
            return Err("项目工具参数过大".into());
        }
        // Reject identity/unknown fields before consulting a binding or issuing a write.
        match tool {
            READ => {
                serde_json::from_value::<Empty>(args.clone()).map_err(|e| e.to_string())?;
            }
            PROPOSE => {
                serde_json::from_value::<Proposal>(args.clone()).map_err(|e| e.to_string())?;
            }
            MUTATE => {
                serde_json::from_value::<crate::project_doc_store::EntryMutation>(args.clone())
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err("未知 Harness 项目工具".into()),
        }
        self.accepted_turn(thread)?;
        let binding = self.state.project_thread_binding(thread)?;
        let Some(binding) = binding else {
            return if tool == READ {
                Ok(
                    json!({"bound":false,"message":"当前会话尚未加入项目。可通过 Harness 的新建/加入项目入口建立项目记忆。"}),
                )
            } else {
                Err("当前会话尚未加入项目".into())
            };
        };
        if tool == READ {
            let doc = self.docs.read_doc(&binding.project_id)?;
            return Ok(
                json!({"bound":true,"currentSeq":doc.current_seq,"content":doc.content,"entries":doc.entries}),
            );
        }
        // Serialize writes and reserve call identity durably before side effects. A crash
        // between reservation and result must never silently replay an append.
        let _guard = self.writes.lock().map_err(|_| "项目工具写入锁不可用")?;
        let key = format!("nativeProjectToolWrite:{thread}:{call}");
        let argument_json = args.to_string();
        let fingerprint =
            crate::bundled_skill::version(&[("tool", tool), ("arguments", &argument_json)]);
        if let Some(receipt) = self.state.get_app_state(&key)? {
            let receipt: Value = serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
            if receipt["turnId"] != turn
                || receipt["tool"] != tool
                || receipt["fingerprint"] != fingerprint
            {
                return Err("工具调用标识冲突".into());
            }
            return receipt
                .get("result")
                .cloned()
                .ok_or("上次写入结果未知，请先读取项目文档核对；不会自动重放".into());
        }
        self.state.set_app_state(
            &key,
            &json!({"turnId":turn,"tool":tool,"fingerprint":fingerprint}).to_string(),
        )?;
        let result = if tool == PROPOSE {
            let request: Proposal =
                serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            let lookup_state = self.state.clone();
            let lookup: crate::project_doc_server::ThreadProjectLookup = Arc::new(move |id| {
                lookup_state
                    .project_thread_binding(id)
                    .ok()
                    .flatten()
                    .map(|b| b.project_id)
            });
            let (status, value) = crate::project_doc_server::handle_propose(
                &self.docs,
                &self.proposals,
                &lookup,
                &crate::project_doc_server::ProposeRequest {
                    thread_id: thread.into(),
                    project_id: binding.project_id,
                    section: request.section,
                    content: request.content,
                },
            );
            if status >= 400 {
                return Err(value["error"].as_str().unwrap_or("项目写入失败").into());
            }
            value
        } else {
            let mutation = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            json!({"outcome":self.docs.mutate_entry(&binding.project_id, &mutation, thread)?})
        };
        // Write receipts contain outcome metadata, never document bodies or model output.
        self.state.set_app_state(
            &key,
            &json!({"turnId":turn,"tool":tool,"fingerprint":fingerprint,"result":result})
                .to_string(),
        )?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::project_bindings::BindingChange;
    struct Fixture {
        _dir: tempfile::TempDir,
        tools: ProjectTools,
    }
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(HarnessStore::open_at(dir.path().join("state")).unwrap());
        let docs = Arc::new(ProjectDocStore::open_at(dir.path().join("docs")).unwrap());
        let proposals = Arc::new(
            ProposalQueue::open_at(rusqlite::Connection::open_in_memory().unwrap()).unwrap(),
        );
        let owner = Arc::new(TurnOwnership::new(state.clone()).unwrap());
        let tools = ProjectTools::new(state, docs, proposals, owner);
        for (thread, project) in [("alpha", "a"), ("beta", "b")] {
            tools
                .docs
                .create_project(project, &format!("Project {project}"))
                .unwrap();
            tools
                .docs
                .write_section(
                    project,
                    "log",
                    None,
                    &format!("Project {project}"),
                    thread,
                    "fixture",
                )
                .unwrap();
            tools
                .state
                .change_project_thread_binding(thread, BindingChange::Bind(project))
                .unwrap();
            tools.register(thread).unwrap();
            tools.ownership.record(thread, "turn").unwrap();
        }
        Fixture { _dir: dir, tools }
    }
    fn params(thread: &str, call: &str, tool: &str, arguments: Value) -> Value {
        json!({"threadId":thread,"turnId":"turn","callId":call,"tool":tool,"arguments":arguments})
    }
    fn content(result: &Value) -> Value {
        serde_json::from_str(result["contentItems"][0]["text"].as_str().unwrap()).unwrap()
    }
    #[test]
    fn envelope_selects_document_and_prevents_identity_overrides() {
        let f = fixture();
        let t = &f.tools;
        for thread in ["alpha", "beta"] {
            let result = t.execute(&params(thread, "read", READ, json!({})));
            assert_eq!(result["success"], true);
            let body = content(&result);
            assert!(body["content"]
                .as_str()
                .unwrap()
                .contains(if thread == "alpha" {
                    "Project a"
                } else {
                    "Project b"
                }));
            assert!(body.get("projectId").is_none());
        }
        for args in [json!({"projectId":"b"}), json!({"threadId":"beta"})] {
            assert_eq!(
                t.execute(&params("alpha", "bad", READ, args))["success"],
                false
            );
        }
        t.register("unbound").unwrap();
        assert_eq!(
            content(&t.execute(&params("unbound", "read", READ, json!({}))))["bound"],
            false
        );
        assert_eq!(
            t.execute(&params("unknown", "read", READ, json!({})))["success"],
            false
        );
        assert_eq!(
            t.execute(&params(
                "unbound",
                "write",
                PROPOSE,
                json!({"section":"log","content":"bad"})
            ))["success"],
            false
        );
    }
    #[test]
    fn append_is_isolated_and_replayed_calls_do_not_duplicate_writes() {
        let f = fixture();
        let t = &f.tools;
        let p = params(
            "alpha",
            "write",
            PROPOSE,
            json!({"section":"log","content":"only alpha should see this"}),
        );
        let first = t.execute(&p);
        assert_eq!(first["success"], true);
        assert_eq!(t.execute(&p), first);
        let doc = t.docs.read_doc("a").unwrap();
        assert_eq!(doc.content.matches("only alpha should see this").count(), 1);
        assert!(!t.docs.read_doc("b").unwrap().content.contains("only alpha"));
        let mut changed = p;
        changed["arguments"]["content"] = json!("different");
        assert_eq!(t.execute(&changed)["success"], false);
        let receipt = t
            .state
            .get_app_state("nativeProjectToolWrite:alpha:write")
            .unwrap()
            .unwrap();
        assert!(!receipt.contains("only alpha"));
    }
    #[test]
    fn controlled_status_stays_queued_and_revision_checks_still_apply() {
        let f = fixture();
        let t = &f.tools;
        let before = t.docs.read_doc("a").unwrap().content;
        let queued = t.execute(&params(
            "alpha",
            "status",
            PROPOSE,
            json!({"section":"status","content":"replace status"}),
        ));
        assert_eq!(queued["success"], true);
        assert_eq!(content(&queued)["applied"], false);
        assert_eq!(t.docs.read_doc("a").unwrap().content, before);
        assert_eq!(t.proposals.list_pending("a").unwrap().len(), 1);
        t.execute(&params(
            "alpha",
            "decision",
            PROPOSE,
            json!({"section":"decisions","content":"first decision"}),
        ));
        let entry = t.docs.read_doc("a").unwrap().entries.remove(0);
        let edit = json!({"action":"update","id":entry.meta.id,"revision":entry.meta.revision,"reason":"new evidence","content":"revised decision"});
        assert_eq!(
            t.execute(&params("alpha", "edit", MUTATE, edit.clone()))["success"],
            true
        );
        assert_eq!(
            t.execute(&params("alpha", "stale", MUTATE, edit))["success"],
            false
        );
        assert!(t
            .docs
            .read_doc("a")
            .unwrap()
            .content
            .contains("revised decision"));
    }
    #[test]
    fn a_different_harness_instance_cannot_execute_the_owned_turn() {
        let f = fixture();
        let t = &f.tools;
        let other = TurnOwnership::new(t.state.clone()).unwrap();
        let other_tools = ProjectTools::new(
            t.state.clone(),
            t.docs.clone(),
            t.proposals.clone(),
            Arc::new(other),
        );
        assert_eq!(
            other_tools.execute(&params("alpha", "read", READ, json!({})))["success"],
            false
        );
    }
    #[test]
    fn restart_retains_registration_and_receipts_and_unknown_writes_are_not_replayed() {
        let f = fixture();
        let t = f.tools;
        let p = params(
            "alpha",
            "once",
            PROPOSE,
            json!({"section":"log","content":"durable append"}),
        );
        assert_eq!(t.execute(&p)["success"], true);
        let restarted = ProjectTools::new(
            t.state.clone(),
            t.docs.clone(),
            t.proposals.clone(),
            t.ownership.clone(),
        );
        assert!(restarted.enabled("alpha").unwrap());
        assert_eq!(restarted.execute(&p)["success"], true);
        assert_eq!(
            restarted
                .docs
                .read_doc("a")
                .unwrap()
                .content
                .matches("durable append")
                .count(),
            1
        );
        let reserved = params(
            "alpha",
            "uncertain",
            PROPOSE,
            json!({"section":"log","content":"must not append"}),
        );
        let fingerprint = crate::bundled_skill::version(&[
            ("tool", PROPOSE),
            ("arguments", &reserved["arguments"].to_string()),
        ]);
        t.state
            .set_app_state(
                "nativeProjectToolWrite:alpha:uncertain",
                &json!({"turnId":"turn","tool":PROPOSE,"fingerprint":fingerprint}).to_string(),
            )
            .unwrap();
        assert_eq!(restarted.execute(&reserved)["success"], false);
        assert!(!restarted
            .docs
            .read_doc("a")
            .unwrap()
            .content
            .contains("must not append"));
        let mut response = json!({"thread":{"id":"alpha"}});
        restarted.annotate(&mut response).unwrap();
        assert_eq!(response["thread"]["harnessProjectTools"], true);
        restarted.accepted_turn("alpha").unwrap();
        assert!(restarted
            .state
            .change_project_thread_binding("alpha", BindingChange::Bind("b"))
            .is_err());
    }
}
