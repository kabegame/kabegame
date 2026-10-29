//! 建 `backfill_jobs`：可恢复回填作业的进度表（见 [`super::backfill`]）。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(super::BACKFILL_JOBS_DDL)
        .map_err(|e| format!("v048 create backfill_jobs: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_creates_table_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        super::up(&conn).unwrap();
        super::up(&conn).unwrap();
        conn.execute(
            "INSERT INTO backfill_jobs (id, introduced_at, updated_at) VALUES ('x', 48, 0)",
            [],
        )
        .unwrap();
        let (cursor, processed, done, attempts): (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT cursor, processed, done, attempts FROM backfill_jobs WHERE id = 'x'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((cursor, processed, done, attempts), (0, 0, 0, 0));
    }
}
