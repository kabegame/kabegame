use r2d2::ManageConnection;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub mod albums;
pub mod dsl_funcs;
pub mod gallery;
pub mod gallery_time;
pub mod hidden_cleanup;
pub mod image_events;
pub mod images;
pub mod labels;
pub(crate) mod metadata_search_text;
pub mod migrations;
pub mod organize;
pub mod page_snapshot;
pub mod plugin_data;
pub mod plugin_sources;
pub mod run_configs;
pub mod search_terms;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod safe_delete;
pub mod source_purge;
mod sql_debug;
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
pub use tasks::{TaskInfo, TaskStatus};

// 收藏画册的固定ID
pub const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

// 隐藏画册的固定ID（软隐藏：默认从画廊视图过滤）
pub const HIDDEN_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000000";

// 全局 Storage 单例
static STORAGE: OnceLock<Storage> = OnceLock::new();

pub(crate) type ReaderPool = r2d2::Pool<SqliteConnectionManager>;

const READER_POOL_SIZE: u32 = 4;
const SHARED_PRAGMAS: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -20000;
PRAGMA mmap_size = 268435456;
"#;

#[derive(Clone)]
pub struct Storage {
    pub(crate) db: Arc<Mutex<Connection>>,
    pub(crate) readers: ReaderPool,
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
        let conn = Self::open_connection(&db_path).expect("Failed to open database");

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

        // 7a: schema 就绪后注册 DSL 主机 SQL 函数 (get_plugin 等)。
        // 函数是 connection-scoped：写连接在此注册，读池的每条连接在初始化时注册。
        dsl_funcs::register_dsl_functions(&conn).expect("Failed to register DSL scalar functions");
        let readers = open_reader_pool(&db_path).expect("Failed to open reader pool");

        Self {
            db: Arc::new(Mutex::new(conn)),
            readers,
            cached_images_total: Arc::new(Mutex::new(None)),
        }
    }

    fn open_connection(db_path: &Path) -> Result<Connection, String> {
        disable_sqlite_memstatus();
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open database {}: {e}", db_path.display()))?;
        configure_connection(&conn);
        Ok(conn)
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
        {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
            search_terms::gc_orphan_search_terms(&conn)?;
        }

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
            .query_row("SELECT COUNT(*) FROM images", [], |row| {
                row.get::<_, i64>(0).map(|count| count as usize)
            })
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

    /// 获取插件私有 JSON 数据存储接口
    pub fn plugin_data(&self) -> plugin_data::PluginDataStorage {
        plugin_data::PluginDataStorage::new(Arc::clone(&self.db))
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

    /// 初始化只读全局 Storage：不建表、不迁移、不写库。
    ///
    /// 数据库版本低于当前 CLI 所需版本时直接报错；更高版本保持兼容并放行。
    pub fn init_global_read_only() -> Result<(), String> {
        let db_path = Self::get_db_path();
        if !db_path.is_file() {
            return Err(format!(
                "数据库不存在：{}（请先启动一次 Kabegame）",
                db_path.display()
            ));
        }
        let conn = Self::open_connection(&db_path)?;
        conn.execute_batch("PRAGMA query_only = ON;")
            .map_err(|e| format!("设置数据库只读模式失败：{e}"))?;

        let version = migrations::current_version(&conn);
        if version < migrations::LATEST_VERSION {
            return Err(format!(
                "数据库 schema 版本 v{version} 低于本 CLI 需要的 v{}，请先用新版 Kabegame 启动一次完成迁移",
                migrations::LATEST_VERSION
            ));
        }

        dsl_funcs::register_dsl_functions(&conn)
            .map_err(|e| format!("注册 DSL SQL 函数失败：{e}"))?;
        let readers = open_reader_pool(&db_path)?;
        STORAGE
            .set(Storage {
                db: Arc::new(Mutex::new(conn)),
                readers,
                cached_images_total: Arc::new(Mutex::new(None)),
            })
            .map_err(|_| "Storage already initialized".to_string())
    }

    /// 测试夹具：包装一条已建好表的连接（通常是内存库）。
    /// 读池懒加载、不预建连接；内存库无法跨连接共享，这类 Storage 不走 PathQL。
    #[cfg(test)]
    pub(crate) fn from_test_connection(conn: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            readers: r2d2::Pool::builder()
                .max_size(1)
                .min_idle(Some(0))
                .build_unchecked(SqliteConnectionManager::memory()),
            cached_images_total: Arc::new(Mutex::new(None)),
        }
    }

    /// 获取全局 Storage 引用
    pub fn global() -> &'static Storage {
        STORAGE
            .get()
            .expect("Storage not initialized. Call Storage::init_global() first.")
    }
}

/// 关闭 SQLite 全局内存统计，进程内只做一次，必须早于任何连接打开。
///
/// 默认开启时每次 sqlite3_malloc / free 都要持有同一把全局 mutex。多条读连接并发执行
/// 分配密集的查询（搜索里的 LOWER / REPLACE / LIKE）会在这把锁上互相拖慢：实测同一条
/// COUNT 两条并发各慢 2.5×、四条 6×，关闭后为 1.15× / 1.4×。本仓库不读
/// `sqlite3_memory_used`、不设 soft / hard heap limit，关闭没有副作用。
fn disable_sqlite_memstatus() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: sqlite3_config 只能在 sqlite3_initialize 之前调用；已初始化时返回
        // SQLITE_MISUSE 且不改动任何状态。Storage 打开第一条连接时进程内还没有别的 SQLite 使用者。
        let rc = unsafe {
            rusqlite::ffi::sqlite3_config(
                rusqlite::ffi::SQLITE_CONFIG_MEMSTATUS,
                0 as std::os::raw::c_int,
            )
        };
        if rc != rusqlite::ffi::SQLITE_OK {
            eprintln!(
                "[storage] 关闭 SQLite 内存统计失败（rc={rc}，SQLite 已先行初始化），并发读会在全局分配锁上互相拖慢"
            );
        }
    });
}

/// 读写连接共用：trace 钩子 + 公共 PRAGMA（PRAGMA 失败沿用现在的忽略策略）。
fn configure_connection(conn: &Connection) {
    sql_debug::install_if_enabled(conn);
    let _ = conn.execute_batch(SHARED_PRAGMAS);
}

/// PathQL 只读连接池：每条连接 query_only，并独立注册 DSL 函数。
fn open_reader_pool(db_path: &Path) -> Result<ReaderPool, String> {
    disable_sqlite_memstatus();
    let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
        configure_connection(conn);
        conn.execute_batch("PRAGMA query_only = ON;")?;
        dsl_funcs::register_dsl_functions(conn)
    });
    // 先直连一次：r2d2 对初始化失败会重试到 connection_timeout，不能让启动卡 30s。
    manager
        .connect()
        .map_err(|e| format!("打开只读连接失败：{e}"))?;
    r2d2::Pool::builder()
        .max_size(READER_POOL_SIZE)
        .min_idle(Some(1))
        .idle_timeout(None)
        .max_lifetime(None)
        .build(manager)
        .map_err(|e| format!("创建只读连接池失败：{e}"))
}

pub(crate) fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_pool_reads_committed_data_rejects_writes_and_registers_dsl() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("reader-pool.db");
        let mut writer = Storage::open_connection(&db_path).unwrap();
        writer
            .execute_batch("CREATE TABLE reader_pool_items (value INTEGER NOT NULL);")
            .unwrap();
        let readers = open_reader_pool(&db_path).unwrap();

        let tx = writer.transaction().unwrap();
        tx.execute("INSERT INTO reader_pool_items (value) VALUES (42)", [])
            .unwrap();
        tx.commit().unwrap();

        let reader = readers.get().unwrap();
        let value: i64 = reader
            .query_row("SELECT value FROM reader_pool_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, 42);

        let insert_error = reader
            .execute("INSERT INTO reader_pool_items (value) VALUES (7)", [])
            .unwrap_err();
        assert!(
            insert_error
                .to_string()
                .contains("attempt to write a readonly database"),
            "unexpected query_only error: {insert_error}"
        );

        let random: i64 = reader
            .query_row("SELECT kb_rand(1, 2)", [], |row| row.get(0))
            .unwrap();
        assert_eq!(random, dsl_funcs::kb_rand_value(1, 2));
    }
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
