//! 空迁移：只为登记回填作业 `wpe_dir_hash`（见 [`super::backfills::wpe_dir_hash`]）。
//!
//! WPE 壁纸行的 `hash` / `size` 从「入口文件」改为「整个目录」（目录哈希与总字节数），
//! 存量行由回填作业在后台重算；schema 不变。

use rusqlite::Connection;

pub fn up(_conn: &Connection) -> Result<(), String> {
    Ok(())
}
