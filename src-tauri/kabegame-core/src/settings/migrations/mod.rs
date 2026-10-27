//! 基于 `schemaVersion` 的设置文件顺序迁移，与 `storage::migrations`（`PRAGMA user_version`）同构。
//!
//! # 运行时机与语义
//!
//! - [`crate::settings::Settings::init_global`] 读取 `settings.json` 后、解析各 `SettingKey` 之前，
//!   在内存 JSON 上调用 [`run_pending`]；迁移发生过则立即写回文件（写回前把原文件备份为
//!   `settings.json.bak-v<旧版本>`）。
//! - 全新安装（文件不存在）不跑迁移，直接以默认值写出并标记 [`LATEST_VERSION`]，对应 SQL 的
//!   `mark_as_latest`。
//! - 任一步失败：整个迁移放弃、**不写回文件**，调用方记 WARN 后按原 JSON 解析（未知键走默认值），
//!   应用照常启动，下次启动重试。
//! - `schemaVersion > LATEST_VERSION`（降级到旧版本）：不迁移，原样解析。
//!
//! # 约束
//!
//! - 迁移只做纯 JSON 变换：设置在 Storage / provider runtime / 网络之前初始化，迁移里不得访问它们。
//! - 迁移必须幂等：对已迁移的 JSON 再跑一次结果不变（每个迁移文件带单测验证）。
//! - Android 的 WorkManager Worker 直接读 `settings.json`，迁移后的键名就是它看到的键名。
//!
//! # 如何新增迁移
//!
//! 1. 在本目录新建 `vNNN_<描述>.rs`，实现 `pub fn up(json: &mut Value) -> Result<(), String>`，并带
//!    `#[cfg(test)]`：典型旧输入 → 期望输出、重复执行幂等。
//! 2. 在本文件顶部添加 `mod vNNN_<描述>;`。
//! 3. 将新 `Migration { version: NNN, name: "...", up: vNNN_<描述>::up }` 追加到 `MIGRATIONS` 末尾。
//! 4. 将 `LATEST_VERSION` 更新为 NNN。
//! 5. 同步 `SettingKey` 的默认值与解析，使全新安装的默认设置等于最新迁移后的形态。

use serde_json::Value;

mod v001_wallpaper_drop_system;
mod v002_mcp_settings;
mod v003_wallpaper_rotation_path;

type MigrationFn = fn(&mut Value) -> Result<(), String>;

struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
}

/// 所有版本化迁移，按 `version` 递增排列。
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "wallpaper_drop_system",
        up: v001_wallpaper_drop_system::up,
    },
    Migration {
        version: 2,
        name: "mcp_settings",
        up: v002_mcp_settings::up,
    },
    Migration {
        version: 3,
        name: "wallpaper_rotation_path",
        up: v003_wallpaper_rotation_path::up,
    },
];

pub const LATEST_VERSION: u32 = 3;
pub const VERSION_KEY: &str = "schemaVersion";

pub fn current_version(json: &Value) -> u32 {
    json.get(VERSION_KEY).and_then(|v| v.as_u64()).unwrap_or(0) as u32
}

/// 对已有设置 JSON 执行所有待定迁移，返回是否发生了迁移。
///
/// 在副本上逐步推进 `schemaVersion`，全部成功才替换 `json`；失败时 `json` 保持原样。
pub fn run_pending(json: &mut Value) -> Result<bool, String> {
    run_migrations(json, MIGRATIONS)
}

fn run_migrations(json: &mut Value, migrations: &[Migration]) -> Result<bool, String> {
    let latest = migrations.last().map(|m| m.version).unwrap_or(0);
    let mut current = current_version(json);
    if current > latest {
        eprintln!(
            "[settings-migration] schemaVersion v{current} 高于当前支持的 v{latest}，跳过迁移"
        );
        return Ok(false);
    }
    if current == latest {
        return Ok(false);
    }

    let mut working = json.clone();
    for m in migrations {
        if m.version > current {
            println!("[settings-migration] v{:03}: {}", m.version, m.name);
            (m.up)(&mut working).map_err(|e| format!("v{:03} {}: {e}", m.version, m.name))?;
            set_version(&mut working, m.version);
            current = m.version;
        }
    }
    *json = working;
    Ok(true)
}

fn set_version(json: &mut Value, version: u32) {
    if let Value::Object(map) = json {
        map.insert(VERSION_KEY.into(), Value::from(version));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn add_a(json: &mut Value) -> Result<(), String> {
        json["a"] = json!(1);
        Ok(())
    }

    fn fail(_: &mut Value) -> Result<(), String> {
        Err("boom".into())
    }

    const OK_THEN_FAIL: &[Migration] = &[
        Migration {
            version: 1,
            name: "add_a",
            up: add_a,
        },
        Migration {
            version: 2,
            name: "fail",
            up: fail,
        },
    ];

    #[test]
    fn runs_from_v0_to_latest() {
        let mut v = json!({ "wallpaperStyle": "system" });
        assert!(run_pending(&mut v).unwrap());
        assert_eq!(current_version(&v), LATEST_VERSION);
        assert_eq!(v["wallpaperStyle"], "fill");
        assert!(v.get("wallpaperRotationPath").is_some());
    }

    #[test]
    fn latest_is_untouched() {
        let mut v = json!({ VERSION_KEY: LATEST_VERSION, "x": 1 });
        let before = v.clone();
        assert!(!run_pending(&mut v).unwrap());
        assert_eq!(v, before);
    }

    #[test]
    fn newer_version_is_skipped() {
        let mut v = json!({ VERSION_KEY: LATEST_VERSION + 1, "x": 1 });
        let before = v.clone();
        assert!(!run_pending(&mut v).unwrap());
        assert_eq!(v, before);
    }

    #[test]
    fn failure_leaves_json_unchanged() {
        let mut v = json!({ "x": 1 });
        let before = v.clone();
        assert!(run_migrations(&mut v, OK_THEN_FAIL).is_err());
        assert_eq!(v, before);
    }
}
