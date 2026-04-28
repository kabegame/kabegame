use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

pub mod albums;
pub mod gallery;
pub mod gallery_time;
pub mod image_events;
pub mod images;
pub mod migrations;
pub mod organize;
pub mod plugin_sources;
pub mod run_configs;
pub mod surf_records;
pub mod tasks;
pub(crate) mod template_bridge;

pub use albums::Album;
pub use gallery::GalleryMediaTypeCounts;
pub use gallery_time::{
    gallery_month_groups_from_days, GalleryTimeFilterPayload, GalleryTimeGroupIndex,
};
pub use images::ImageInfo;
pub use run_configs::{RunConfig, ScheduleSpec};
pub use surf_records::{RangedSurfRecords, SurfRecord};
pub use tasks::TaskInfo;

// 收藏画册的固定ID
pub const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

// 隐藏画册的固定ID（软隐藏：默认从画廊视图过滤）
pub const HIDDEN_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000000";

// 全局 Storage 单例
static STORAGE: OnceLock<Storage> = OnceLock::new();

#[derive(Clone)]
pub struct Storage {
    pub(crate) db: Arc<Mutex<Connection>>,
    /// `SELECT COUNT(*) FROM images` 的缓存。
    pub(crate) cached_images_total: Arc<Mutex<Option<usize>>>,
}

impl Storage {
    /// 打开数据库并完成 schema 初始化或迁移。
    ///
    /// # 历史说明（v4.0）
    ///
    /// v4.0 之前，此函数内联了约 450 行的建表 / ALTER TABLE / 复杂结构性迁移
    /// 代码（`perform_complex_migrations`、`migrate_rebuild_tasks_table` 等），
    /// 用于从任意历史状态收敛到当前 schema，维护困难且状态不可预测。
    ///
    /// v4.0 将这些逻辑统一整理：
    /// - 全新安装 → [`migrations::init::create_all_tables`] 一次性建出完整 schema，
    ///   随后 `mark_as_latest(7)`。
    /// - 已有数据库 → [`migrations::run_pending`]；仅支持从 v7（3.5.x）升级，
    ///   更旧版本返回错误，提示用户先升级或删除数据重新导入。
    pub fn new() -> Self {
        let db_path = Self::get_db_path();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).expect("Failed to create app data directory");
        }
        let conn = Connection::open(&db_path).expect("Failed to open database");

        let _ = conn.execute_batch(
            r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -20000;
PRAGMA mmap_size = 268435456;
"#,
        );

        let is_new_db = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='images'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            == 0;

        if is_new_db {
            migrations::init::create_all_tables(&conn);
            migrations::mark_as_latest(&conn).expect("Failed to mark new DB as latest version");
        } else {
            migrations::run_pending(&conn).expect("Failed to run pending DB migrations");
        }

        Self {
            db: Arc::new(Mutex::new(conn)),
            cached_images_total: Arc::new(Mutex::new(None)),
        }
    }

    pub fn init(&self) -> Result<(), String> {
        let images_dir = self.get_images_dir();
        fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images directory: {}", e))?;
        let thumbnails_dir = self.get_thumbnails_dir();
        fs::create_dir_all(&thumbnails_dir)
            .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;

        self.ensure_favorite_album()?;
        self.ensure_hidden_album()?;
        self.plugin_sources()
            .ensure_official_github_release()
            .map_err(|e| format!("Failed to ensure official plugin source: {}", e))?;

        Ok(())
    }

    pub(crate) fn invalidate_images_total_cache(&self) {
        if let Ok(mut g) = self.cached_images_total.lock() {
            *g = None;
        }
    }

    pub(crate) fn get_images_total_cached(&self, conn: &Connection) -> Result<usize, String> {
        if let Ok(g) = self.cached_images_total.lock() {
            if let Some(v) = *g {
                return Ok(v);
            }
        }
        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query total count: {}", e))?;
        if let Ok(mut g) = self.cached_images_total.lock() {
            *g = Some(total);
        }
        Ok(total)
    }

    fn get_db_path() -> PathBuf {
        crate::app_paths::AppPaths::global().images_db()
    }

    pub fn get_images_dir(&self) -> PathBuf {
        crate::app_paths::AppPaths::global().images_dir()
    }

    pub fn get_thumbnails_dir(&self) -> PathBuf {
        crate::app_paths::AppPaths::global().thumbnails_dir()
    }

    /// 获取插件源存储接口
    pub fn plugin_sources(&self) -> plugin_sources::PluginSourcesStorage {
        plugin_sources::PluginSourcesStorage::new(Arc::clone(&self.db))
    }

    /// 初始化全局 Storage（必须在首次使用前调用）
    pub fn init_global() -> Result<(), String> {
        let storage = Storage::new();
        storage.init()?;
        STORAGE
            .set(storage)
            .map_err(|_| "Storage already initialized".to_string())?;
        Ok(())
    }

    /// 获取全局 Storage 引用
    pub fn global() -> &'static Storage {
        STORAGE
            .get()
            .expect("Storage not initialized. Call Storage::init_global() first.")
    }
}

// 内部使用的 PRNG
#[derive(Debug, Clone)]
pub(crate) struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    pub(crate) fn new(seed: u64) -> Self {
        let state = if seed == 0 { 0x9E3779B97F4A7C15 } else { seed };
        Self { state }
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    pub(crate) fn gen_usize(&mut self, upper_exclusive: usize) -> usize {
        if upper_exclusive == 0 {
            return 0;
        }
        (self.next_u64() as usize) % upper_exclusive
    }
}

pub(crate) fn default_true() -> bool {
    true
}

// v4.0 删除说明：以下函数已在 v4.0 一并移除，不再需要。
// 均针对早于 3.5.x 的历史数据库，v4.0 不再支持从那些版本直接升级。
//
//   fn table_has_column(conn, table, column) -> bool
//     运行时列检测，配合容错式 ALTER TABLE 使用。
//
//   fn migrate_rebuild_tasks_table(conn: &mut Connection) -> Result<(), String>
//     将含 url/total_images/downloaded_images 等历史列的旧版 tasks 表重建为
//     现代 schema（tasks_new → rename）。
//
//   fn compute_file_hash(path: &PathBuf) -> Result<String, String>
//     仅被 perform_complex_migrations 使用。
//
//   fn perform_complex_migrations(conn: &mut Connection)
//     ~450 行。检测并处理：images 主键 TEXT→INTEGER 转换、favorite/order 列移除、
//     albums.order 移除、pixiv metadata 裁剪（_kabegame_migrations 表）、
//     task_images 表合并到 images.task_id 等历史遗留问题。
//
//   fn migrate_plugin_sources_initial_data(conn: &mut Connection)
//     从旧 data/plugin_sources.json 和 data/store-cache/*.json 迁移插件源数据。
//     官方源由 Storage::init() 的 ensure_official_github_release() 负责确保存在。
