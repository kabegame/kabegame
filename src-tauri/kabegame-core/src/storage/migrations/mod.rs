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
//!
//! # 回填作业（v048 起）
//!
//! 需要按现有列补算数据的长作业不要写进 `up` 的循环里，而是写一个 [`backfill::Backfill`]
//! 登记进 [`backfill`] 的注册表，`introduced_at` 指向登记它的迁移版本：
//!
//! - 只加作业、不改 schema 时，写一个 `up` 为空的迁移专门用来登记。
//! - 回填只读写它引入时就已存在的列。之后任何要改动这些列的迁移必须声明
//!   `min_backfill_version: Some(作业的 introduced_at)`：`run_pending` 会在执行它之前同步排干
//!   所有 `introduced_at ≤ min_backfill_version` 的未完成作业（启动页显示进度），排干后作业不再运行。
//! - 没有被显式依赖的作业在进入界面后由 `BackfillService` 后台按序跑完。
//! - 全新安装走 [`init::create_all_tables`]，不登记任何作业。
//!
//! 调试时可设 `KABEGAME_BACKFILL_SYNC_THROUGH=<version>`，把阻塞集扩大到 `introduced_at ≤ version`。
//! 详见 `cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`。

pub mod backfill;
mod backfills;
pub mod init;
mod v008_flatten_favorite_album;
mod v009_seed_hidden_album;
mod v010_plugin_data;
mod v011_consolidate_image_metadata_and_failed_display_name;
mod v012_backfill_video_dimensions;
mod v013_album_type_and_sync;
mod v014_album_images_image_index;
mod v015_unique_local_path_and_sync_folder;
mod v016_image_metadata_version_plugin;
mod v017_image_compatible_path;
mod v018_drop_image_metadata_content_hash_unique;
mod v019_image_post_url;
mod v020_nullable_image_plugin_id;
mod v021_image_metadata_plugin_version;
mod v022_image_wallpaper_compatible_path;
mod v023_media_type_format_keys;
mod v024_metadata_rename_and_image_metadata;
mod v025_drop_surf_record_deleted_count;
mod v026_drop_surf_record_download_count;
mod v027_metadata_search_text;
mod v028_album_ancestor_path;
mod v029_local_folder_rechain;
mod v030_album_sync_mode;
mod v031_label_albums;
mod v032_album_parent_index;
mod v033_album_ancestor_path_index;
mod v034_run_config_output_album;
mod v035_task_max_concurrent_downloads;
mod v036_image_aspect_ratio;
mod v037_metadata_search_terms;
mod v038_native_metadata_search_values;
mod v039_metadata_id_indexes;
mod v040_album_images_order_index;
mod v041_plugin_var_null;
mod v042_surf_record_desktop_mode;
mod v043_task_dry_run;
mod v044_tasks_run_config_index;
mod v045_schedule_spec_v2;
mod v046_album_images_foreign_keys;
mod v047_metadata_template;
mod v048_backfill_jobs;
pub(crate) mod v049_images_type_normalized;

use backfill::{Backfill, BackfillCtx};
use rusqlite::Connection;

type MigrationFn = fn(&Connection) -> Result<(), String>;

struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
    /// 执行本迁移前，`introduced_at ≤ 该值` 的全部回填必须已完成（见模块文档）。
    min_backfill_version: Option<u32>,
}

/// `backfill_jobs` 建表 DDL，v048 迁移与 [`init::create_all_tables`] 共用。
pub(crate) const BACKFILL_JOBS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS backfill_jobs (
    id            TEXT    PRIMARY KEY,
    introduced_at INTEGER NOT NULL,
    cursor        INTEGER NOT NULL DEFAULT 0,
    processed     INTEGER NOT NULL DEFAULT 0,
    total         INTEGER,
    done          INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    updated_at    INTEGER NOT NULL
);
"#;

/// `run_pending` 上报的启动进度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupProgress {
    /// 即将执行某个 schema 迁移。
    Schema { version: u32, name: &'static str },
    /// 正在同步排干某个回填作业。
    Backfill {
        id: &'static str,
        processed: usize,
        total: Option<usize>,
    },
}

/// 调试 / CLI 用：把阻塞集扩大到 `introduced_at ≤ version`。
pub const BACKFILL_SYNC_THROUGH_ENV: &str = "KABEGAME_BACKFILL_SYNC_THROUGH";

/// 所有版本化迁移，按 `version` 递增排列。
///
/// v4.0 起从空列表开始；新增迁移请参见模块顶部注释。
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 8,
        name: "flatten_favorite_album",
        up: v008_flatten_favorite_album::up,
        min_backfill_version: None,
    },
    Migration {
        version: 9,
        name: "seed_hidden_album",
        up: v009_seed_hidden_album::up,
        min_backfill_version: None,
    },
    Migration {
        version: 10,
        name: "plugin_data",
        up: v010_plugin_data::up,
        min_backfill_version: None,
    },
    Migration {
        version: 11,
        name: "consolidate_image_metadata_and_failed_display_name",
        up: v011_consolidate_image_metadata_and_failed_display_name::up,
        min_backfill_version: None,
    },
    Migration {
        version: 12,
        name: "backfill_video_dimensions",
        up: v012_backfill_video_dimensions::up,
        min_backfill_version: None,
    },
    Migration {
        version: 13,
        name: "album_type_and_sync",
        up: v013_album_type_and_sync::up,
        min_backfill_version: None,
    },
    Migration {
        version: 14,
        name: "album_images_image_index",
        up: v014_album_images_image_index::up,
        min_backfill_version: None,
    },
    Migration {
        version: 15,
        name: "unique_local_path_and_sync_folder",
        up: v015_unique_local_path_and_sync_folder::up,
        min_backfill_version: None,
    },
    Migration {
        version: 16,
        name: "image_metadata_version_plugin",
        up: v016_image_metadata_version_plugin::up,
        min_backfill_version: None,
    },
    Migration {
        version: 17,
        name: "image_compatible_path",
        up: v017_image_compatible_path::up,
        min_backfill_version: None,
    },
    Migration {
        version: 18,
        name: "drop_image_metadata_content_hash",
        up: v018_drop_image_metadata_content_hash_unique::up,
        min_backfill_version: None,
    },
    Migration {
        version: 19,
        name: "image_post_url",
        up: v019_image_post_url::up,
        min_backfill_version: None,
    },
    Migration {
        version: 20,
        name: "nullable_image_plugin_id",
        up: v020_nullable_image_plugin_id::up,
        min_backfill_version: None,
    },
    Migration {
        version: 21,
        name: "image_metadata_plugin_version",
        up: v021_image_metadata_plugin_version::up,
        min_backfill_version: None,
    },
    Migration {
        version: 22,
        name: "image_wallpaper_compatible_path",
        up: v022_image_wallpaper_compatible_path::up,
        min_backfill_version: None,
    },
    Migration {
        version: 23,
        name: "media_type_format_keys",
        up: v023_media_type_format_keys::up,
        min_backfill_version: None,
    },
    Migration {
        version: 24,
        name: "metadata_rename_and_image_metadata",
        up: v024_metadata_rename_and_image_metadata::up,
        min_backfill_version: None,
    },
    Migration {
        version: 25,
        name: "drop_surf_record_deleted_count",
        up: v025_drop_surf_record_deleted_count::up,
        min_backfill_version: None,
    },
    Migration {
        version: 26,
        name: "drop_surf_record_download_count",
        up: v026_drop_surf_record_download_count::up,
        min_backfill_version: None,
    },
    Migration {
        version: 27,
        name: "metadata_search_text",
        up: v027_metadata_search_text::up,
        min_backfill_version: None,
    },
    Migration {
        version: 28,
        name: "album_ancestor_path",
        up: v028_album_ancestor_path::up,
        min_backfill_version: None,
    },
    Migration {
        version: 29,
        name: "local_folder_rechain",
        up: v029_local_folder_rechain::up,
        min_backfill_version: None,
    },
    Migration {
        version: 30,
        name: "album_sync_mode",
        up: v030_album_sync_mode::up,
        min_backfill_version: None,
    },
    Migration {
        version: 31,
        name: "label_albums",
        up: v031_label_albums::up,
        min_backfill_version: None,
    },
    Migration {
        version: 32,
        name: "album_parent_index",
        up: v032_album_parent_index::up,
        min_backfill_version: None,
    },
    Migration {
        version: 33,
        name: "album_ancestor_path_index",
        up: v033_album_ancestor_path_index::up,
        min_backfill_version: None,
    },
    Migration {
        version: 34,
        name: "run_config_output_album",
        up: v034_run_config_output_album::up,
        min_backfill_version: None,
    },
    Migration {
        version: 35,
        name: "task_max_concurrent_downloads",
        up: v035_task_max_concurrent_downloads::up,
        min_backfill_version: None,
    },
    Migration {
        version: 36,
        name: "image_aspect_ratio",
        up: v036_image_aspect_ratio::up,
        min_backfill_version: None,
    },
    Migration {
        version: 37,
        name: "metadata_search_terms",
        up: v037_metadata_search_terms::up,
        min_backfill_version: None,
    },
    Migration {
        version: 38,
        name: "native_metadata_search_values",
        up: v038_native_metadata_search_values::up,
        min_backfill_version: None,
    },
    Migration {
        version: 39,
        name: "metadata_id_indexes",
        up: v039_metadata_id_indexes::up,
        min_backfill_version: None,
    },
    Migration {
        version: 40,
        name: "album_images_order_index",
        up: v040_album_images_order_index::up,
        min_backfill_version: None,
    },
    Migration {
        version: 41,
        name: "plugin_var_null",
        up: v041_plugin_var_null::up,
        min_backfill_version: None,
    },
    Migration {
        version: 42,
        name: "surf_record_desktop_mode",
        up: v042_surf_record_desktop_mode::up,
        min_backfill_version: None,
    },
    Migration {
        version: 43,
        name: "task_dry_run",
        up: v043_task_dry_run::up,
        min_backfill_version: None,
    },
    Migration {
        version: 44,
        name: "tasks_run_config_index",
        up: v044_tasks_run_config_index::up,
        min_backfill_version: None,
    },
    Migration {
        version: 45,
        name: "schedule_spec_v2",
        up: v045_schedule_spec_v2::up,
        min_backfill_version: None,
    },
    Migration {
        version: 46,
        name: "album_images_foreign_keys",
        up: v046_album_images_foreign_keys::up,
        min_backfill_version: None,
    },
    Migration {
        version: 47,
        name: "metadata_template",
        up: v047_metadata_template::up,
        min_backfill_version: None,
    },
    Migration {
        version: 48,
        name: "backfill_jobs",
        up: v048_backfill_jobs::up,
        min_backfill_version: None,
    },
    Migration {
        version: 49,
        name: "images_type_normalized",
        up: v049_images_type_normalized::up,
        min_backfill_version: None,
    },
];

/// 当前支持的最新 schema 版本。
///
/// v4.0 将 v001–v007 的历史迁移整合进 [`init::create_all_tables`]，
/// 因此基准版本为 7，后续每新增一个迁移文件递增一次。
pub const LATEST_VERSION: u32 = 49;

pub(crate) fn current_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as u32
}

/// 对已有数据库执行所有待定迁移。
///
/// - `user_version < 7`：版本过旧，返回错误——v4.0 不支持从 3.5.x 以前的版本升级。
/// - 按版本顺序执行待定迁移；遇到声明了 `min_backfill_version` 的迁移，先同步排干它要求的未完成回填，
///   每个迁移执行后登记它引入的回填。其余回填留给 `BackfillService` 在后台运行。
/// - `progress` 收到每个迁移与每批阻塞回填的进度，供启动页显示。
pub fn run_pending(
    conn: &Connection,
    progress: &mut dyn FnMut(StartupProgress),
) -> Result<(), String> {
    run_pending_with(
        conn,
        MIGRATIONS,
        backfill::registry(),
        sync_through_from_env(),
        progress,
    )
}

fn sync_through_from_env() -> Option<u32> {
    let value = std::env::var(BACKFILL_SYNC_THROUGH_ENV).ok()?;
    match value.trim().parse() {
        Ok(version) => Some(version),
        Err(_) => {
            tracing::warn!("ignore invalid {BACKFILL_SYNC_THROUGH_ENV}={value}");
            None
        }
    }
}

fn run_pending_with(
    conn: &Connection,
    migrations: &[Migration],
    registry: &'static [Backfill],
    sync_through: Option<u32>,
    progress: &mut dyn FnMut(StartupProgress),
) -> Result<(), String> {
    let current = current_version(conn);
    if current < 7 {
        return Err(format!(
            "数据库 schema 版本过旧（当前 v{current}，最低要求 v7）。\
             请先将 Kabegame 升级到 v3.5.x，或删除用户数据目录后重新导入本地图片。"
        ));
    }
    for m in migrations.iter().filter(|m| m.version > current) {
        if let Some(required) = m.min_backfill_version {
            // 当前平台跑不了的依赖作业永远不会在这里完成；依赖它的迁移即将改动它读写的列，
            // 之后它不能再运行，直接收尾。
            skip_gated_jobs_through(conn, registry, required)?;
        }
        if let Some(limit) = max_option(m.min_backfill_version, sync_through) {
            drain_backfills_through(conn, registry, limit, progress)?;
        }
        tracing::info!("v{:03}: {}", m.version, m.name);
        progress(StartupProgress::Schema {
            version: m.version,
            name: m.name,
        });
        (m.up)(conn)?;
        // 先登记再推进版本：登记失败时下次启动重跑本迁移（迁移幂等、登记 INSERT OR IGNORE）。
        backfill::enqueue_introduced_at_in(conn, registry, m.version)?;
        conn.pragma_update(None, "user_version", m.version)
            .map_err(|e| format!("Failed to set user_version={}: {}", m.version, e))?;
    }
    if let Some(limit) = sync_through {
        drain_backfills_through(conn, registry, limit, progress)?;
    }
    Ok(())
}

fn max_option(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// 同步跑完 `introduced_at ≤ limit` 的全部可运行回填。
fn drain_backfills_through(
    conn: &Connection,
    registry: &'static [Backfill],
    limit: u32,
    progress: &mut dyn FnMut(StartupProgress),
) -> Result<(), String> {
    let pending = backfill::pending_jobs_in(conn, registry)?;
    for job in pending.iter().filter(|job| job.introduced_at <= limit) {
        tracing::info!(
            "draining {} (v{:03}) before continuing",
            job.job.id,
            job.introduced_at
        );
        progress(StartupProgress::Backfill {
            id: job.job.id,
            processed: job.progress.processed,
            total: job.progress.total,
        });
        let ctx = BackfillCtx::blocking(job.job.id, conn);
        backfill::run_to_completion(&ctx, job, &mut |p, _outcome| {
            progress(StartupProgress::Backfill {
                id: p.id,
                processed: p.processed,
                total: p.total,
            })
        })?;
    }
    Ok(())
}

fn skip_gated_jobs_through(
    conn: &Connection,
    registry: &'static [Backfill],
    limit: u32,
) -> Result<(), String> {
    if !backfill::has_jobs_table(conn)? {
        return Ok(());
    }
    for job in registry
        .iter()
        .filter(|job| job.introduced_at <= limit && !(job.platforms)())
    {
        let changed = conn
            .execute(
                "UPDATE backfill_jobs
                    SET done = 1, last_error = 'skipped: not supported on this platform', updated_at = ?1
                  WHERE id = ?2 AND done = 0",
                rusqlite::params![
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_default(),
                    job.id
                ],
            )
            .map_err(|e| format!("skip gated backfill {}: {e}", job.id))?;
        if changed > 0 {
            tracing::info!("{} skipped on this platform", job.id);
        }
    }
    Ok(())
}

/// 新建数据库直接标记为最新版本（跳过全部迁移）。
pub fn mark_as_latest(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "user_version", LATEST_VERSION)
        .map_err(|e| format!("Failed to set user_version: {}", e))
}
