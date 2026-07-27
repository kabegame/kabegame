//! 删除 `surf_records.download_count`。
//!
//! 「累计成功下载次数」与 `deleted_count`（v025 已删）一样属于只增计数器，前端没有任何
//! 展示入口（`surf.downloadCount` 这个 i18n key 早已无使用点），DSL / MCP 侧也不再输出，
//! 因此一并从持久化 schema 移除。下载成功后不再需要写库、也不再发 `SurfRecordChanged`。
//!
//! 单独占一个版本号而不是并进 v025：v025 发布后才追加这个需求，而已经执行过 v025 的库
//! （`user_version` 已是 25）不会再跑它一遍，改 v025 会让那些库永远残留本列。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("ALTER TABLE surf_records DROP COLUMN download_count;")
        .map_err(|e| format!("v026 drop surf_records.download_count: {e}"))?;
    Ok(())
}
