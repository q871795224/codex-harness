//! Read-only compatibility adapter until App Server exposes archived_at.
//! Thread membership and contents still come exclusively from thread/list.
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn database_path(
    config: &Value,
    codex_home: &Path,
    sqlite_home_env: Option<&str>,
) -> Result<PathBuf, String> {
    let home = config
        .pointer("/config/sqlite_home")
        .and_then(Value::as_str)
        .or_else(|| {
            sqlite_home_env
                .map(str::trim)
                .filter(|home| !home.is_empty())
        })
        .map(Path::new)
        .unwrap_or(codex_home);
    if !home.is_absolute() {
        return Err("Codex SQLite 目录不是绝对路径".into());
    }
    // Codex 0.172.0's state schema. Never scan for or open an older leftover DB.
    Ok(home.join("state_5.sqlite"))
}

pub(super) fn read_archive_times(
    path: &Path,
    ids: &[String],
) -> Result<HashMap<String, i64>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|error| error.to_string())?;
    let mut query = connection
        .prepare("SELECT archived_at FROM threads WHERE id = ?1 AND archived = 1")
        .map_err(|error| error.to_string())?;
    let mut times = HashMap::new();
    for id in ids {
        let mut rows = query.query([id]).map_err(|error| error.to_string())?;
        if let Some(row) = rows.next().map_err(|error| error.to_string())? {
            if let Some(at) = row
                .get::<_, Option<i64>>(0)
                .map_err(|error| error.to_string())?
            {
                times.insert(id.clone(), at);
            }
        }
    }
    Ok(times)
}

pub(super) fn annotate(response: &mut Value, times: &HashMap<String, i64>) {
    if let Some(threads) = response.get_mut("data").and_then(Value::as_array_mut) {
        for thread in threads {
            let at = thread["id"].as_str().and_then(|id| times.get(id)).copied();
            thread["archivedAt"] = at.map(Value::from).unwrap_or(Value::Null);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uses_configured_sqlite_home_before_env_and_default() {
        let home = Path::new("/codex");
        assert_eq!(
            database_path(
                &json!({"config":{"sqlite_home":"/configured"}}),
                home,
                Some("/env")
            )
            .unwrap(),
            Path::new("/configured/state_5.sqlite")
        );
        assert_eq!(
            database_path(&json!({}), home, Some(" /env ")).unwrap(),
            Path::new("/env/state_5.sqlite")
        );
        assert_eq!(
            database_path(&json!({}), home, Some(" ")).unwrap(),
            Path::new("/codex/state_5.sqlite")
        );
        assert!(database_path(&json!({}), home, Some("relative")).is_err());
    }

    #[test]
    fn reads_existing_archive_transitions_without_changing_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state_5.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, archived_at INTEGER, updated_at INTEGER);
            INSERT INTO threads VALUES ('old',1,10,999), ('new',1,20,1), ('active',0,NULL,1000), ('unknown',1,NULL,500);").unwrap();
        let before = std::fs::read(&path).unwrap();
        let ids = ["old", "new", "active", "unknown", "missing"].map(str::to_owned);
        let times = read_archive_times(&path, &ids).unwrap();
        assert_eq!(
            times,
            HashMap::from([("old".into(), 10), ("new".into(), 20)])
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut response = json!({"data":[{"id":"old","updatedAt":999},{"id":"new","updatedAt":1},{"id":"unknown"}],"nextCursor":"next"});
        annotate(&mut response, &times);
        assert_eq!(response["data"][0]["archivedAt"], 10);
        assert_eq!(response["data"][1]["archivedAt"], 20);
        assert_eq!(response["data"][2]["archivedAt"], Value::Null);
        assert_eq!(response["nextCursor"], "next");
        // A restore and later rearchive must use the latest persisted transition.
        writer
            .execute(
                "UPDATE threads SET archived=0, archived_at=NULL WHERE id='old'",
                [],
            )
            .unwrap();
        assert!(!read_archive_times(&path, &ids).unwrap().contains_key("old"));
        writer
            .execute(
                "UPDATE threads SET archived=1, archived_at=30 WHERE id='old'",
                [],
            )
            .unwrap();
        assert_eq!(read_archive_times(&path, &ids).unwrap()["old"], 30);
    }

    #[test]
    fn never_creates_a_missing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.sqlite");
        assert!(read_archive_times(&path, &["thread".into()]).is_err());
        assert!(!path.exists());
    }
}
