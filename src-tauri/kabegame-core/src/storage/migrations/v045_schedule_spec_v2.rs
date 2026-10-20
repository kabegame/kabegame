use crate::storage::ScheduleSpec;
use rusqlite::{params, Connection};

pub fn up(conn: &Connection) -> Result<(), String> {
    let rows = {
        let mut stmt = conn
            .prepare("SELECT id, schedule_spec FROM run_configs WHERE schedule_spec IS NOT NULL")
            .map_err(|error| format!("v045 query schedule specs: {error}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("v045 read schedule specs: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("v045 collect schedule specs: {error}"))?;
        rows
    };

    for (id, raw) in rows {
        let spec: ScheduleSpec = serde_json::from_str(&raw)
            .map_err(|error| format!("v045 parse schedule_spec for {id}: {error}"))?;
        let canonical = serde_json::to_string(&spec)
            .map_err(|error| format!("v045 serialize schedule_spec for {id}: {error}"))?;
        if canonical != raw {
            conn.execute(
                "UPDATE run_configs SET schedule_spec = ?1 WHERE id = ?2",
                params![canonical, id],
            )
            .map_err(|error| format!("v045 update schedule_spec: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn rewrites_legacy_schedule_specs_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE run_configs (id TEXT PRIMARY KEY, schedule_spec TEXT);
            INSERT INTO run_configs VALUES
              ('hourly', '{"mode":"daily","hour":-1,"minute":30}'),
              ('weekly', '{"mode":"weekly","weekday":2,"hour":8,"minute":0}'),
              ('new', '{"mode":"weekly","weekdays":[1,4],"hour":9,"minute":15}');
            "#,
        )
        .unwrap();
        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let values = conn
            .prepare("SELECT id, schedule_spec FROM run_configs ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(values[0].1, r#"{"mode":"hourly","minute":30}"#);
        assert_eq!(
            values[1].1,
            r#"{"mode":"weekly","weekdays":[1,4],"hour":9,"minute":15}"#
        );
        assert_eq!(
            values[2].1,
            r#"{"mode":"weekly","weekdays":[2],"hour":8,"minute":0}"#
        );
    }
}
