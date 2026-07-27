//! 删除 `surf_records.deleted_count`。
//!
//! 该列是「累计删除张数」的只增计数器：唯一写入点是删图流程，且 `batch_remove_images`
//! （只删库记录、保留磁盘文件）也会 +1，UI 上却写「已删除」，语义本身就偏；自增失败被
//! 静默吞掉、又没有任何重算路径，漂移后不可自愈。产品上已决定下线该统计。
//!
//! 该列无索引 / 无 UNIQUE / 无 CHECK / 无触发器引用，可直接 DROP COLUMN
//! （bundled SQLite 3.45，≥3.35；先例见 v011）。
//!
//! 注：`download_count` 的下线在 v026 —— 那是本迁移已经跑过之后才追加的需求，
//! 已执行过的迁移不能改，只能往后追加。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("ALTER TABLE surf_records DROP COLUMN deleted_count;")
        .map_err(|e| format!("v025 drop surf_records.deleted_count: {e}"))?;
    Ok(())
}
