use super::*;
use serde_json::json;
struct Fixture {
    db: Connection,
    writer: Writer,
    mode: AtomicU8,
    tx: SyncSender<OfficialCountRequest>,
    stats: OfficialStats,
    dropped: AtomicU64,
}
impl Fixture {
    fn new() -> Self {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let (tx, _) = mpsc::sync_channel(1);
        Self {
            db,
            writer: Writer::default(),
            mode: AtomicU8::new(0),
            tx,
            stats: OfficialStats::default(),
            dropped: AtomicU64::new(0),
        }
    }
    fn event(&mut self, e: AnalyticsEvent) {
        self.writer
            .handle(
                &self.db,
                e,
                &self.mode,
                &self.tx,
                &self.stats,
                &self.dropped,
            )
            .unwrap();
    }
    fn start(&mut self, inputs: Vec<Input>) {
        self.event(AnalyticsEvent::Start(
            PendingTurnObservation {
                append: false,
                input_group: "initial".into(),
                thread_id: "thread".into(),
                at: 1000,
                settings: Settings {
                    model: Some("test-model".into()),
                    ..Default::default()
                },
                source: "conversation".into(),
                inputs,
            },
            "turn".into(),
        ));
    }
    fn observe(&mut self, body: Body) {
        self.event(AnalyticsEvent::Observation(Observation {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            at: 2000,
            body,
        }));
    }
    fn usage(&mut self, total: u64, last: u64) {
        self.observe(Body::Usage {
            last: Tokens {
                total_tokens: last,
                input_tokens: last - 2,
                output_tokens: 2,
                ..Default::default()
            },
            total: Tokens {
                total_tokens: total,
                input_tokens: total - 2,
                output_tokens: 2,
                ..Default::default()
            },
        })
    }
    fn count(&self, sql: &str) -> u64 {
        self.db.query_row(sql, [], |r| r.get(0)).unwrap()
    }
    fn snapshot(&self, query: AnalyticsQuery) -> AnalyticsSnapshot {
        let c = CodexAnalytics::disabled(PathBuf::new());
        query::snapshot(&self.db, &query, &c).unwrap()
    }
}
fn all() -> AnalyticsQuery {
    AnalyticsQuery {
        since: 0,
        until: 10_000,
        ..Default::default()
    }
}
#[test]
fn usage_replay_is_idempotent_across_writer_restart() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.writer = Writer::default();
    f.usage(12, 12);
    assert_eq!(f.count("SELECT SUM(total_tokens) FROM analysis_usage"), 12);
}
#[test]
fn equal_last_distinct_totals_count_twice() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.usage(24, 12);
    assert_eq!(f.snapshot(all()).summary.actual.total_tokens, 24);
}
#[test]
fn unowned_notifications_do_not_enter_database() {
    let mut f = Fixture::new();
    f.usage(12, 12);
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_usage"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_turns"), 0);
}
#[test]
fn notifications_before_start_response_are_buffered() {
    let mut f = Fixture::new();
    f.event(AnalyticsEvent::Begin("thread".into()));
    f.usage(12, 12);
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_usage"), 0);
    f.start(vec![]);
    assert_eq!(f.count("SELECT SUM(total_tokens) FROM analysis_usage"), 12);
    assert!(f.writer.buffer.is_empty());
}
#[test]
fn rejected_start_discards_buffer() {
    let mut f = Fixture::new();
    f.event(AnalyticsEvent::Begin("thread".into()));
    f.usage(12, 12);
    f.event(AnalyticsEvent::Cancel("thread".into()));
    f.start(vec![]);
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_usage"), 0);
}
#[test]
fn regressions_and_gaps_mark_incomplete() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(100, 12);
    f.usage(90, 10);
    assert_eq!(f.count("SELECT SUM(total_tokens) FROM analysis_usage"), 12);
    assert_eq!(f.count("SELECT uncertain FROM analysis_turns"), 1);
    f.usage(130, 10);
    assert_eq!(f.snapshot(all()).summary.incomplete_turns, 1);
}
#[test]
fn mcp_ids_deduplicate_and_preserve_split_counts() {
    let mut f = Fixture::new();
    f.start(vec![]);
    for _ in 0..2 {
        f.observe(Body::Mcp {
            id: "call".into(),
            name: "fixture / lookup".into(),
            status: "failed".into(),
            arguments: Some("hello world".into()),
            result: Some("error".into()),
        });
    }
    let snap = f.snapshot(all());
    assert_eq!(snap.hotspots.len(), 1);
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_content"), 1);
    let value = serde_json::to_value(snap).unwrap();
    assert_eq!(value["hotspots"][0]["failed"], 1);
    assert_eq!(value["hotspots"][0]["argumentTokens"], 2);
}
#[test]
fn missing_skill_still_records_selection() {
    let root = tempfile::tempdir().unwrap();
    let mut f = Fixture::new();
    f.start(vec![Input {
        kind: "skill",
        name: "missing".into(),
        path: Some(root.path().join("SKILL.md")),
        text: None,
    }]);
    assert_eq!(f.count("SELECT selected FROM analysis_content"), 1);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM analysis_content WHERE tokens IS NULL"),
        1
    );
}
#[test]
fn catalog_read_matches_normalized_path_and_deduplicates() {
    let mut f = Fixture::new();
    f.event(AnalyticsEvent::Catalog(vec![(
        PathBuf::from("/fixture/中文 skill/SKILL.md"),
        "my-skill".into(),
    )]));
    f.start(vec![]);
    for _ in 0..2 {
        f.observe(Body::Read {
            id: "read".into(),
            cwd: "/fixture".into(),
            paths: vec!["./中文 skill/SKILL.md".into()],
            output: Some("hello world".into()),
            success: true,
        });
    }
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM analysis_content WHERE name='my-skill' AND reads=1 AND tokens=2"
        ),
        1
    );
}
#[test]
fn multi_file_output_is_not_assigned_to_each_file() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.observe(Body::Read {
        id: "read".into(),
        cwd: "/fixture".into(),
        paths: vec!["AGENTS.md".into(), "s/SKILL.md".into()],
        output: Some("both files".into()),
        success: true,
    });
    assert_eq!(
        f.count("SELECT COUNT(*) FROM analysis_content WHERE tokens IS NULL"),
        2
    );
}
#[test]
fn failed_read_is_not_successful_use() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.observe(Body::Read {
        id: "read".into(),
        cwd: "/fixture".into(),
        paths: vec!["AGENTS.md".into()],
        output: Some("no file".into()),
        success: false,
    });
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_content"), 0);
}
#[test]
fn settings_use_collaboration_override() {
    let s = settings(
        &json!({"model":"outer","collaborationMode":{"settings":{"model":"effective","reasoning_effort":"high"}}}),
    );
    assert_eq!(s.model.as_deref(), Some("effective"));
    assert_eq!(s.effort.as_deref(), Some("high"));
}
#[test]
fn reroute_does_not_reassign_whole_turn() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.observe(Body::Reroute);
    let snap = serde_json::to_value(f.snapshot(all())).unwrap();
    assert_eq!(snap["models"][0]["model"], "test-model");
    assert_eq!(snap["summary"]["reroutedTurns"], 1);
}
#[test]
fn query_filters_by_event_time_and_hotspot() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.observe(Body::Read {
        id: "read".into(),
        cwd: "/fixture".into(),
        paths: vec!["AGENTS.md".into()],
        output: None,
        success: true,
    });
    let q = AnalyticsQuery {
        since: 1500,
        until: 2500,
        kind: Some("agents".into()),
        name: Some("fixture / AGENTS.md".into()),
        ..Default::default()
    };
    let snap = f.snapshot(q);
    assert_eq!(snap.summary.actual.total_tokens, 12);
    assert_eq!(snap.total_sessions, 1);
    assert_eq!(
        f.snapshot(AnalyticsQuery {
            model: Some("absent".into()),
            ..all()
        })
        .total_sessions,
        0
    );
}
#[test]
fn session_detail_is_scoped_and_contains_counts() {
    let mut f = Fixture::new();
    f.start(vec![Input {
        kind: "input",
        name: "用户输入".into(),
        text: Some("hello world".into()),
        path: None,
    }]);
    f.usage(12, 12);
    let snap = serde_json::to_value(f.snapshot(AnalyticsQuery {
        thread_id: Some("thread".into()),
        ..all()
    }))
    .unwrap();
    assert_eq!(snap["turns"][0]["content"][0]["tokens"], 2);
    assert_eq!(snap["turns"][0]["actual"]["totalTokens"], 12);
    assert_eq!(snap["totalTurns"], 1);
}
#[test]
fn database_and_json_do_not_contain_content_or_full_paths() {
    let mut f = Fixture::new();
    f.start(vec![Input {
        kind: "input",
        name: "用户输入".into(),
        text: Some("PRIVATE_PROMPT_FIXTURE".into()),
        path: None,
    }]);
    f.observe(Body::Read {
        id: "read".into(),
        cwd: "/private/fixture".into(),
        paths: vec!["AGENTS.md".into()],
        output: Some("PRIVATE_FILE_FIXTURE".into()),
        success: true,
    });
    let dump =
        f.db.prepare("SELECT id,name FROM analysis_content")
            .unwrap()
            .query_map([], |r| {
                Ok(format!(
                    "{} {}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join(" ");
    assert!(!dump.contains("PRIVATE_"));
    assert!(!dump.contains("/private/fixture"));
    let snap = serde_json::to_string(&f.snapshot(all())).unwrap();
    assert!(!snap.contains("PRIVATE_"));
}
#[test]
fn snapshot_paginates_without_truncating_totals() {
    let mut f = Fixture::new();
    for i in 0..55 {
        f.event(AnalyticsEvent::Start(
            PendingTurnObservation {
                append: false,
                input_group: "initial".into(),
                thread_id: format!("t{i}"),
                at: 1000,
                settings: Settings::default(),
                source: "conversation".into(),
                inputs: vec![],
            },
            format!("u{i}"),
        ));
    }
    let snap = f.snapshot(all());
    assert_eq!(snap.total_sessions, 55);
    assert_eq!(snap.sessions.len(), 50);
    assert_eq!(
        f.snapshot(AnalyticsQuery {
            offset: Some(50),
            ..all()
        })
        .sessions
        .len(),
        5
    );
}
#[test]
fn only_linked_children_are_counted() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.observe(Body::Child {
        ids: vec!["child".into()],
        model: Some("small".into()),
    });
    f.event(AnalyticsEvent::Observation(Observation {
        thread_id: "child".into(),
        turn_id: "child-turn".into(),
        at: 2000,
        body: Body::Usage {
            last: Tokens {
                total_tokens: 12,
                ..Default::default()
            },
            total: Tokens {
                total_tokens: 12,
                ..Default::default()
            },
        },
    }));
    assert_eq!(f.snapshot(all()).summary.actual.total_tokens, 12);
    assert_eq!(f.snapshot(all()).total_sessions, 2);
}

use std::{
    io::{Read, Write},
    net::TcpListener,
};
#[test]
fn official_counter_returns_count_without_blocking_the_caller() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("binds mock server");
    let endpoint = format!(
        "http://{}/v1/responses/input_tokens",
        listener.local_addr().expect("has address")
    );
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accepts request");
        let mut request = [0_u8; 8_192];
        let read = stream.read(&mut request).expect("reads request");
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.contains("fixture text"));
        let body = r#"{"object":"response.input_tokens","input_tokens":37}"#;
        write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("writes response");
    });
    let (request_sender, request_receiver) = mpsc::sync_channel(1);
    let (result_sender, result_receiver) = mpsc::sync_channel(1);
    let mode = Arc::new(AtomicU8::new(CounterMode::Official as u8));
    let stats = Arc::new(OfficialStats::default());
    let worker_mode = mode.clone();
    let worker_stats = stats.clone();
    let worker = thread::spawn(move || {
        run_official_counter(
            request_receiver,
            result_sender,
            worker_mode,
            Some("test-key".to_string()),
            worker_stats,
            &endpoint,
        )
    });
    request_sender
        .try_send(OfficialCountRequest {
            target: OfficialTarget {
                event_id: "fixture".into(),
                column: "tokens",
            },
            model: "gpt-test".to_string(),
            text: "fixture text".to_string(),
        })
        .expect("queues without waiting");
    drop(request_sender);
    let event = result_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("receives official result");
    assert!(matches!(
        event,
        AnalyticsEvent::OfficialCount(OfficialCountResult { tokens: 37, .. })
    ));
    assert_eq!(stats.requests.load(Ordering::Relaxed), 1);
    assert_eq!(stats.successes.load(Ordering::Relaxed), 1);
    server.join().expect("mock server exits");
    worker.join().expect("counter exits");
}

#[test]
fn disabled_collector_fails_open() {
    let c = CodexAnalytics::disabled(PathBuf::new());
    assert!(c.prepare_turn(&json!({"threadId":"t"})).is_none());
    assert!(c.snapshot(&all()).is_err());
}
#[test]
fn early_child_usage_waits_for_confirmed_spawn() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.event(AnalyticsEvent::Observation(Observation {
        thread_id: "child".into(),
        turn_id: "child-turn".into(),
        at: 2000,
        body: Body::Usage {
            last: Tokens {
                total_tokens: 12,
                ..Default::default()
            },
            total: Tokens {
                total_tokens: 12,
                ..Default::default()
            },
        },
    }));
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_usage"), 0);
    f.observe(Body::Child {
        ids: vec!["child".into()],
        model: Some("small".into()),
    });
    assert_eq!(f.count("SELECT SUM(total_tokens) FROM analysis_usage"), 12);
}
#[test]
fn steer_counts_new_input_without_changing_turn_configuration() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.event(AnalyticsEvent::Start(
        PendingTurnObservation {
            append: true,
            input_group: "steer".into(),
            thread_id: "thread".into(),
            at: 2000,
            settings: Settings::default(),
            source: "conversation".into(),
            inputs: vec![Input {
                kind: "input",
                name: "用户输入".into(),
                text: Some("hello world".into()),
                path: None,
            }],
        },
        "turn".into(),
    ));
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_turns"), 1);
    assert_eq!(f.count("SELECT tokens FROM analysis_content"), 2);
}
#[test]
fn unknown_turn_steer_does_not_claim_previous_usage() {
    let mut f = Fixture::new();
    f.event(AnalyticsEvent::Start(
        PendingTurnObservation {
            append: true,
            input_group: "steer".into(),
            thread_id: "thread".into(),
            at: 2000,
            settings: Settings::default(),
            source: "conversation".into(),
            inputs: vec![],
        },
        "turn".into(),
    ));
    assert_eq!(f.count("SELECT COUNT(*) FROM analysis_turns"), 0);
}
#[test]
fn query_sort_is_global_and_not_page_local() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.event(AnalyticsEvent::Start(
        PendingTurnObservation {
            append: false,
            input_group: "second".into(),
            thread_id: "zero".into(),
            at: 3000,
            settings: Settings::default(),
            source: "conversation".into(),
            inputs: vec![],
        },
        "zero-turn".into(),
    ));
    let snap = serde_json::to_value(f.snapshot(AnalyticsQuery {
        sort: Some("tokensAsc".into()),
        ..all()
    }))
    .unwrap();
    assert_eq!(snap["sessions"][0]["threadId"], "zero");
}
#[test]
fn real_collector_queue_replays_synthetic_protocol_without_storing_body() {
    let root = tempfile::tempdir().unwrap();
    let c = CodexAnalytics::open(root.path()).unwrap();
    let p=c.prepare_turn(&json!({"threadId":"thread","model":"model","input":[{"type":"text","text":"PRIVATE_PROMPT_FIXTURE"}]})).unwrap();
    let usage = json!({"threadId":"thread","turnId":"turn","tokenUsage":{"last":{"totalTokens":12,"inputTokens":10,"outputTokens":2},"total":{"totalTokens":12,"inputTokens":10,"outputTokens":2}}});
    c.record_notification(Some("thread/tokenUsage/updated"), &usage);
    c.record_turn_start(p, &json!({"turn":{"id":"turn"}}));
    c.record_notification(Some("thread/tokenUsage/updated"), &usage);
    c.record_notification(Some("item/completed"),&json!({"threadId":"thread","turnId":"turn","item":{"type":"mcpToolCall","id":"mcp","server":"fixture","tool":"lookup","status":"completed","arguments":{"q":"PRIVATE_ARG_FIXTURE"},"result":{"content":[{"type":"text","text":"PRIVATE_RESULT_FIXTURE"}]}}}));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snap = c
            .snapshot(&AnalyticsQuery {
                since: 0,
                until: now_ms() + 1000,
                ..Default::default()
            })
            .unwrap();
        if snap.hotspots.len() == 1 {
            assert_eq!(snap.summary.actual.total_tokens, 12);
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    for entry in fs::read_dir(root.path()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            let bytes = fs::read(entry.path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE_"));
        }
    }
}
#[test]
fn unchanged_cumulative_with_adjusted_breakdown_is_not_new_spend() {
    let mut f = Fixture::new();
    f.start(vec![]);
    f.usage(12, 12);
    f.observe(Body::Usage {
        last: Tokens {
            total_tokens: 12,
            input_tokens: 10,
            output_tokens: 2,
            ..Default::default()
        },
        total: Tokens {
            total_tokens: 12,
            input_tokens: 10,
            output_tokens: 2,
            cached_input_tokens: 4,
            ..Default::default()
        },
    });
    assert_eq!(f.count("SELECT SUM(total_tokens) FROM analysis_usage"), 12);
    assert_eq!(f.count("SELECT uncertain FROM analysis_turns"), 1);
}
