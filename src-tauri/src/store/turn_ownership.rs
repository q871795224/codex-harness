use super::HarnessStore;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

pub(super) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS active_turn_owners (
        thread_id TEXT PRIMARY KEY NOT NULL,
        turn_id TEXT NOT NULL,
        instance_id TEXT NOT NULL
    );",
        )
        .map_err(|e| e.to_string())
}

impl HarnessStore {
    pub(crate) fn instance_lock_dir(&self) -> std::path::PathBuf {
        self.root.join("instances")
    }

    pub(crate) fn record_turn_owner(
        &self,
        thread: &str,
        turn: &str,
        instance: &str,
    ) -> Result<(), String> {
        self.connection.lock().map_err(|e| e.to_string())?.execute(
            "INSERT INTO active_turn_owners VALUES (?1, ?2, ?3)
             ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id, instance_id=excluded.instance_id
             WHERE active_turn_owners.turn_id != excluded.turn_id",
            params![thread, turn, instance],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // Hold the SQLite write transaction across the liveness check and transfer.
    // Two restarting instances must never both acquire the same turn.
    pub(crate) fn recover_turn_owner(
        &self,
        thread: &str,
        turn: &str,
        instance: &str,
        force: bool,
        is_alive: impl FnOnce(&str) -> Result<bool, String>,
    ) -> Result<(bool, bool), String> {
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT instance_id FROM active_turn_owners WHERE thread_id=?1 AND turn_id=?2",
                params![thread, turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(owner) = owner else {
            if force {
                tx.execute(
                    "INSERT INTO active_turn_owners VALUES (?1, ?2, ?3)
                     ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id, instance_id=excluded.instance_id",
                    params![thread, turn, instance],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            return Ok((force, !force));
        };
        let owned = owner == instance || force || !is_alive(&owner)?;
        if owned {
            tx.execute(
                "UPDATE active_turn_owners SET instance_id=?3 WHERE thread_id=?1 AND turn_id=?2",
                params![thread, turn, instance],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((owned, !owned))
    }

    pub(crate) fn check_turn_owner(
        &self,
        thread: &str,
        turn: Option<&str>,
        instance: &str,
    ) -> Result<(), String> {
        let owner: Option<String> = self
            .connection
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT instance_id FROM active_turn_owners WHERE thread_id=?1 AND (?2 IS NULL OR turn_id=?2)",
                params![thread, turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if owner.is_some_and(|owner| owner != instance) {
            return Err("该轮次已由其他 Harness 实例持有，请重新打开会话。".into());
        }
        Ok(())
    }

    pub(crate) fn complete_turn_owner(&self, thread: &str, turn: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "DELETE FROM active_turn_owners WHERE thread_id=?1 AND turn_id=?2",
                params![thread, turn],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
