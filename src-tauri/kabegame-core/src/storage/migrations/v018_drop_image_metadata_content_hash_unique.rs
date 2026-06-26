//! 删除 `image_metadata.content_hash` 列。
//!
//! 该列最初用于全局去重（`content_hash TEXT NOT NULL UNIQUE`），后来改为按
//! `(plugin_id, version)` 维度管理，UNIQUE 约束已无意义，列本身也不再需要。
//! 因旧库存在内联 UNIQUE 约束（SQLite 不支持直接 DROP COLUMN 带 UNIQUE），
//! 采用标准重建表流程。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE image_metadata_new (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    data      TEXT    NOT NULL,
    version   INTEGER NOT NULL DEFAULT 0,
    plugin_id TEXT    NOT NULL DEFAULT ''
);

INSERT INTO image_metadata_new (id, data, version, plugin_id)
SELECT id, data, version, plugin_id FROM image_metadata;

DROP TABLE image_metadata;
ALTER TABLE image_metadata_new RENAME TO image_metadata;

DROP INDEX IF EXISTS idx_image_metadata_dedup;
CREATE INDEX idx_image_metadata_dedup ON image_metadata(plugin_id, version);

COMMIT;

PRAGMA foreign_keys = ON;
"#,
    )
    .map_err(|e| format!("v018 drop image_metadata.content_hash: {e}"))?;
    Ok(())
}
