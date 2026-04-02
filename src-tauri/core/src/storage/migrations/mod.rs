//! 基于 `PRAGMA user_version` 的顺序迁移。新库在 [`crate::storage::Storage::new`] 中直接标记为最新版本，跳过全部迁移。

mod v001_drop_mime_type;
mod v002_image_metadata_table;
mod v003_failed_image_metadata_id;

use rusqlite::Connection;

type MigrationFn = fn(&Connection) -> Result<(), String>;

struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
}

/// 所有版本化迁移，按 `version` 递增排列。
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "drop_mime_type_column",
        up: v001_drop_mime_type::up,
    },
    Migration {
        version: 2,
        name: "image_metadata_table",
        up: v002_image_metadata_table::up,
    },
    Migration {
        version: 3,
        name: "failed_image_metadata_id",
        up: v003_failed_image_metadata_id::up,
    },
];

/// 最新 schema 版本号（须与 `MIGRATIONS` 最后一项的 `version` 一致）。
pub const LATEST_VERSION: u32 = 3;

fn current_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as u32
}

/// 对已有数据库执行所有待定迁移。
pub fn run_pending(conn: &Connection) -> Result<(), String> {
    let mut current = current_version(conn);
    if current >= LATEST_VERSION {
        return Ok(());
    }
    for m in MIGRATIONS {
        if m.version > current {
            println!("[db-migration] v{:03}: {}", m.version, m.name);
            (m.up)(conn)?;
            conn
                .pragma_update(None, "user_version", m.version)
                .map_err(|e| format!("Failed to set user_version={}: {}", m.version, e))?;
            current = m.version;
        }
    }
    Ok(())
}

/// 新建数据库直接标记为最新版本（跳过全部迁移）。
pub fn mark_as_latest(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "user_version", LATEST_VERSION)
        .map_err(|e| format!("Failed to set user_version: {}", e))
}
