//! 基于 `PRAGMA user_version` 的顺序迁移。
//!
//! # 历史说明（v4.0）
//!
//! v4.0 之前，本模块注册了 v001–v007 七个顺序迁移文件，以及在
//! `storage::mod` 的 `new()` 函数中内联了大量 CREATE TABLE IF NOT EXISTS /
//! ALTER TABLE ADD COLUMN / `perform_complex_migrations` 等遗留代码。
//!
//! v4.0 将上述逻辑统一整理：
//! - 全新安装走 [`init::create_all_tables`]（一次性建出 v7 完整 schema）。
//! - 已有数据库仅支持从 v7（3.5.x）平滑升级；更旧版本需先升级到 3.5.x 或
//!   删除用户数据重新导入。
//! - v001–v007 迁移文件与全部内联迁移代码已随此次重构一并删除。
//!
//! # 如何新增迁移（v4.0 之后）
//!
//! 1. 在本目录新建 `vNNN_<描述>.rs`，实现 `pub fn up(conn: &Connection) -> Result<(), String>`。
//! 2. 在本文件顶部添加 `mod vNNN_<描述>;`。
//! 3. 将新 `Migration { version: NNN, name: "...", up: vNNN_<描述>::up }` 追加到 `MIGRATIONS` 数组末尾。
//! 4. 将 `LATEST_VERSION` 更新为 NNN。
//! 5. 在 [`init::create_all_tables`] 中同步更新建表 DDL，使新库与最新迁移后的 schema 保持一致。

pub mod init;
mod v008_flatten_favorite_album;
mod v009_seed_hidden_album;
mod v010_plugin_data;

use rusqlite::Connection;

type MigrationFn = fn(&Connection) -> Result<(), String>;

struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
}

/// 所有版本化迁移，按 `version` 递增排列。
///
/// v4.0 起从空列表开始；新增迁移请参见模块顶部注释。
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 8,
        name: "flatten_favorite_album",
        up: v008_flatten_favorite_album::up,
    },
    Migration {
        version: 9,
        name: "seed_hidden_album",
        up: v009_seed_hidden_album::up,
    },
    Migration {
        version: 10,
        name: "plugin_data",
        up: v010_plugin_data::up,
    },
];

/// 当前支持的最新 schema 版本。
///
/// v4.0 将 v001–v007 的历史迁移整合进 [`init::create_all_tables`]，
/// 因此基准版本为 7，后续每新增一个迁移文件递增一次。
pub const LATEST_VERSION: u32 = 10;

fn current_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as u32
}

/// 对已有数据库执行所有待定迁移。
///
/// - `user_version >= LATEST_VERSION`：已是最新，直接返回 Ok。
/// - `user_version == 7` 且 `LATEST_VERSION == 7`：无操作。
/// - `user_version < 7`：版本过旧，返回错误——v4.0 不支持从 3.5.x 以前的版本升级。
pub fn run_pending(conn: &Connection) -> Result<(), String> {
    let mut current = current_version(conn);
    if current < 7 {
        return Err(format!(
            "数据库 schema 版本过旧（当前 v{current}，最低要求 v7）。\
             请先将 Kabegame 升级到 v3.5.x，或删除用户数据目录后重新导入本地图片。"
        ));
    }
    if current >= LATEST_VERSION {
        return Ok(());
    }
    for m in MIGRATIONS {
        if m.version > current {
            println!("[db-migration] v{:03}: {}", m.version, m.name);
            (m.up)(conn)?;
            conn.pragma_update(None, "user_version", m.version)
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
