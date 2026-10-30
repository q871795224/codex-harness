use crate::store::HarnessStore;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::fd::AsRawFd,
    sync::Arc,
};

pub(crate) struct TurnOwnership {
    store: Arc<HarnessStore>,
    instance: String,
    // The OS releases this lock even after a crash or forced application update.
    _instance_lock: File,
}

fn try_lock(file: &File) -> Result<bool, String> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error.to_string())
    }
}

impl TurnOwnership {
    pub(crate) fn new(store: Arc<HarnessStore>) -> Result<Self, String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let instance: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        fs::create_dir_all(store.instance_lock_dir()).map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(store.instance_lock_dir().join(&instance))
            .map_err(|e| e.to_string())?;
        if !try_lock(&file)? {
            return Err("无法锁定 Harness 运行实例".into());
        }
        Ok(Self {
            store,
            instance,
            _instance_lock: file,
        })
    }

    fn is_alive(&self, instance: &str) -> Result<bool, String> {
        if instance.len() != 32 || !instance.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("无效的 Harness 实例标识".into());
        }
        let file = match File::open(self.store.instance_lock_dir().join(instance)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        // Never unlink lock files: another process could still hold the inode.
        Ok(!try_lock(&file)?)
    }

    pub(crate) fn record(&self, thread: &str, turn: &str) -> Result<(), String> {
        self.store.record_turn_owner(thread, turn, &self.instance)
    }

    pub(crate) fn check(&self, thread: &str, turn: &str) -> Result<(), String> {
        self.store
            .check_turn_owner(thread, Some(turn), &self.instance)
    }

    pub(crate) fn check_thread(&self, thread: &str) -> Result<(), String> {
        self.store.check_turn_owner(thread, None, &self.instance)
    }

    pub(crate) fn complete(&self, thread: &str, turn: &str) -> Result<(), String> {
        self.store.complete_turn_owner(thread, turn)
    }

    pub(crate) fn annotate_resume(
        &self,
        response: &mut Value,
        force_turn: Option<&str>,
    ) -> Result<(), String> {
        let thread = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("恢复响应缺少会话 ID")?;
        let turn = response
            .pointer("/initialTurnsPage/data")
            .or_else(|| response.pointer("/thread/turns"))
            .and_then(Value::as_array)
            .and_then(|turns| turns.iter().find(|turn| turn["status"] == "inProgress"))
            .and_then(|turn| turn["id"].as_str());
        if force_turn.is_some() && turn != force_turn {
            return Err("当前轮次已经变化，请重新打开会话。".into());
        }
        let Some(turn) = turn else {
            // Clear only terminal turns actually confirmed by this snapshot;
            // a late resume response must not delete a newer running turn.
            if let Some(turns) = response
                .pointer("/initialTurnsPage/data")
                .or_else(|| response.pointer("/thread/turns"))
                .and_then(Value::as_array)
            {
                for terminal in turns.iter().filter(|turn| {
                    matches!(
                        turn["status"].as_str(),
                        Some("completed" | "interrupted" | "failed")
                    )
                }) {
                    if let Some(id) = terminal["id"].as_str() {
                        self.complete(thread, id)?;
                    }
                }
            }
            response["harnessOwnership"] = Value::Null;
            return Ok(());
        };
        let (owned, can_take_over) = self.store.recover_turn_owner(
            thread,
            turn,
            &self.instance,
            force_turn.is_some(),
            |owner| self.is_alive(owner),
        )?;
        response["harnessOwnership"] =
            json!({ "turnId": turn, "owned": owned, "canTakeOver": can_take_over });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(turn: &str, status: &str) -> Value {
        json!({ "thread": { "id": "thread" }, "initialTurnsPage": {
            "data": [{ "id": turn, "status": status }], "nextCursor": null
        } })
    }

    #[test]
    fn restart_recovers_a_recorded_turn_but_not_a_live_other_instance() {
        let dir = tempfile::tempdir().unwrap();
        let first = TurnOwnership::new(Arc::new(HarnessStore::open_at(dir.path().into()).unwrap()))
            .unwrap();
        first.record("thread", "turn").unwrap();
        let second =
            TurnOwnership::new(Arc::new(HarnessStore::open_at(dir.path().into()).unwrap()))
                .unwrap();
        let mut resumed = response("turn", "inProgress");
        second.annotate_resume(&mut resumed, None).unwrap();
        assert_eq!(
            resumed["harnessOwnership"],
            json!({"turnId":"turn","owned":false,"canTakeOver":true})
        );
        drop(first); // Simulates process exit; OS lock is released, record remains.
        second.annotate_resume(&mut resumed, None).unwrap();
        assert_eq!(
            resumed["harnessOwnership"],
            json!({"turnId":"turn","owned":true,"canTakeOver":false})
        );
        second.check("thread", "turn").unwrap();
    }

    #[test]
    fn external_changed_and_completed_turns_are_never_automatically_owned() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(dir.path().into()).unwrap());
        let first = TurnOwnership::new(store.clone()).unwrap();
        first.record("thread", "old").unwrap();
        drop(first);
        let second = TurnOwnership::new(store.clone()).unwrap();
        let mut unknown = response("new", "inProgress");
        second.annotate_resume(&mut unknown, None).unwrap();
        assert_eq!(unknown["harnessOwnership"]["owned"], false);
        let mut completed = response("old", "completed");
        second.annotate_resume(&mut completed, None).unwrap();
        assert!(completed["harnessOwnership"].is_null());
        second.complete("thread", "old").unwrap();
        let mut stale = response("old", "inProgress");
        second.annotate_resume(&mut stale, None).unwrap();
        assert_eq!(stale["harnessOwnership"]["owned"], false);
    }

    #[test]
    fn explicit_takeover_revokes_previous_owner_and_rejects_stale_turn_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(dir.path().into()).unwrap());
        let first = TurnOwnership::new(store.clone()).unwrap();
        let second = TurnOwnership::new(store).unwrap();
        first.record("thread", "turn").unwrap();
        let mut resumed = response("turn", "inProgress");
        assert!(second
            .annotate_resume(&mut resumed, Some("old-turn"))
            .is_err());
        first.check("thread", "turn").unwrap();
        second.annotate_resume(&mut resumed, Some("turn")).unwrap();
        first.record("thread", "turn").unwrap(); // A delayed start response must not undo takeover.
        assert!(first.check("thread", "turn").is_err());
        assert!(first.check_thread("thread").is_err());
        first.annotate_resume(&mut resumed, None).unwrap();
        assert_eq!(resumed["harnessOwnership"]["owned"], false);
        second.check("thread", "turn").unwrap();
    }

    #[test]
    fn legacy_or_external_turns_require_explicit_takeover() {
        let dir = tempfile::tempdir().unwrap();
        let owner = TurnOwnership::new(Arc::new(HarnessStore::open_at(dir.path().into()).unwrap()))
            .unwrap();
        let mut resumed = response("legacy", "inProgress");
        owner.annotate_resume(&mut resumed, None).unwrap();
        assert_eq!(resumed["harnessOwnership"]["owned"], false);
        owner.annotate_resume(&mut resumed, Some("legacy")).unwrap();
        assert_eq!(resumed["harnessOwnership"]["owned"], true);
    }

    #[test]
    fn takeover_replaces_a_stale_turn_and_late_completion_does_not_delete_the_new_owner() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HarnessStore::open_at(dir.path().into()).unwrap());
        let first = TurnOwnership::new(store.clone()).unwrap();
        let second = TurnOwnership::new(store).unwrap();
        first.record("thread", "old").unwrap();
        let mut resumed = response("new", "inProgress");
        second.annotate_resume(&mut resumed, Some("new")).unwrap();
        first.complete("thread", "old").unwrap();
        second.annotate_resume(&mut resumed, None).unwrap();
        assert_eq!(resumed["harnessOwnership"]["owned"], true);
        assert!(first.check("thread", "new").is_err());
    }

    #[test]
    fn simultaneous_restarts_have_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let first = TurnOwnership::new(Arc::new(HarnessStore::open_at(dir.path().into()).unwrap()))
            .unwrap();
        first.record("thread", "turn").unwrap();
        drop(first);
        let owners: Vec<_> = (0..2)
            .map(|_| {
                Arc::new(
                    TurnOwnership::new(Arc::new(HarnessStore::open_at(dir.path().into()).unwrap()))
                        .unwrap(),
                )
            })
            .collect();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let jobs: Vec<_> = owners
            .iter()
            .cloned()
            .map(|owner| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut resumed = response("turn", "inProgress");
                    owner.annotate_resume(&mut resumed, None).unwrap();
                    resumed["harnessOwnership"]["owned"].as_bool().unwrap()
                })
            })
            .collect();
        assert_eq!(
            jobs.into_iter()
                .map(|job| job.join().unwrap())
                .filter(|owned| *owned)
                .count(),
            1
        );
    }
}
