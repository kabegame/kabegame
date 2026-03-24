use rusqlite::{params, Connection};
use serde_json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
// Storage 不再依赖 Tauri AppHandle

pub mod albums;
pub mod gallery;
pub mod gallery_time;
pub mod images;
pub mod organize;
pub mod plugin_sources;
pub mod run_configs;
pub mod surf_records;
pub mod tasks;
pub mod temp_files;

pub use gallery_time::{
    gallery_month_groups_from_days, GalleryTimeFilterPayload, GalleryTimeGroupIndex,
};
pub use gallery::GalleryMediaTypeCounts;
pub use albums::Album;
pub use images::ImageInfo;
pub use run_configs::RunConfig;
pub use surf_records::{RangedSurfRecords, SurfRecord};
pub use tasks::TaskInfo;

// 收藏画册的固定ID
pub const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

// 全局 Storage 单例
static STORAGE: OnceLock<Storage> = OnceLock::new();

#[derive(Clone)]
pub struct Storage {
    pub(crate) db: Arc<Mutex<Connection>>,
    /// `SELECT COUNT(*) FROM images` 的缓存。
    pub(crate) cached_images_total: Arc<Mutex<Option<usize>>>,
}

impl Storage {
    pub fn new() -> Self {
        let db_path = Self::get_db_path();
        // 确保应用数据目录存在
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).expect("Failed to create app data directory");
        }
        let mut conn = Connection::open(&db_path).expect("Failed to open database");

        // 启动性能优化
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

        // 初始化数据库表
        // 创建任务表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                plugin_id TEXT NOT NULL,
                output_dir TEXT,
                user_config TEXT,
                http_headers TEXT,
                output_album_id TEXT,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                start_time INTEGER,
                end_time INTEGER,
                error TEXT
            )",
            [],
        )
        .expect("Failed to create tasks table");

        // 数据库迁移
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN output_album_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN deleted_count INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = migrate_rebuild_tasks_table(&mut conn);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN http_headers TEXT", []);

        // 迁移：本地导入 plugin_id 从 "本地导入" 改为 "local-import"（i18n 适配）
        let _ = conn.execute("UPDATE tasks SET plugin_id = 'local-import' WHERE plugin_id = '本地导入'", []);
        let _ = conn.execute("UPDATE images SET plugin_id = 'local-import' WHERE plugin_id = '本地导入'", []);
        let _ = conn.execute("UPDATE task_failed_images SET plugin_id = 'local-import' WHERE plugin_id = '本地导入'", []);
        let _ = conn.execute("UPDATE run_configs SET plugin_id = 'local-import' WHERE plugin_id = '本地导入'", []);

        // 创建运行配置表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS run_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                plugin_id TEXT NOT NULL,
                url TEXT NOT NULL,
                output_dir TEXT,
                user_config TEXT,
                http_headers TEXT,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create run_configs table");
        let _ = conn.execute("ALTER TABLE run_configs ADD COLUMN http_headers TEXT", []);

        // 创建图片表（url 可选，本地导入时无 URL）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT,
                local_path TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                task_id TEXT,
                surf_record_id TEXT,
                crawled_at INTEGER NOT NULL,
                metadata TEXT,
                thumbnail_path TEXT NOT NULL DEFAULT '',
                hash TEXT NOT NULL DEFAULT '',
                mime_type TEXT,
                type TEXT DEFAULT 'image',
                width INTEGER,
                height INTEGER
            )",
            [],
        )
        .expect("Failed to create images table");

        let _ = conn.execute("ALTER TABLE images ADD COLUMN task_id TEXT", []);
        let _ = conn.execute("ALTER TABLE images ADD COLUMN surf_record_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE images ADD COLUMN hash TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute("ALTER TABLE images ADD COLUMN width INTEGER", []);
        let _ = conn.execute("ALTER TABLE images ADD COLUMN height INTEGER", []);
        if !table_has_column(&conn, "images", "display_name") {
            conn.execute(
                "ALTER TABLE images ADD COLUMN display_name TEXT NOT NULL DEFAULT ''",
                [],
            )
            .expect("Failed to add images.display_name column");
        }
        if !table_has_column(&conn, "images", "mime_type") {
            conn.execute("ALTER TABLE images ADD COLUMN mime_type TEXT", [])
                .expect("Failed to add images.mime_type column");
        }
        if !table_has_column(&conn, "images", "type") {
            conn.execute("ALTER TABLE images ADD COLUMN type TEXT DEFAULT 'image'", [])
                .expect("Failed to add images.type column");
        }
        if !table_has_column(&conn, "images", "last_set_wallpaper_at") {
            conn.execute("ALTER TABLE images ADD COLUMN last_set_wallpaper_at INTEGER", [])
                .expect("Failed to add images.last_set_wallpaper_at column");
        }

        // 创建索引（新库的 CREATE 已含 width/height，上述 ALTER 用于旧库升级）
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crawled_at ON images(crawled_at DESC)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_plugin_id ON images(plugin_id)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_id ON images(task_id)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_surf_record_id ON images(surf_record_id)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time DESC)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_local_path ON images(local_path)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_thumbnail_path ON images(thumbnail_path)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_last_set_wallpaper_at ON images(last_set_wallpaper_at DESC)",
            [],
        );

        // 创建画册表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS albums (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create albums table");
        let _ = conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name_ci ON albums(LOWER(name))",
            [],
        );
        // 旧版本曾有 albums.\"order\"：由 perform_complex_migrations 负责重建迁移并移除该列。

        // 创建画册-图片映射表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS album_images (
                album_id TEXT NOT NULL,
                image_id INTEGER NOT NULL,
                \"order\" INTEGER,
                PRIMARY KEY (album_id, image_id)
            )",
            [],
        )
        .expect("Failed to create album_images table");
        let _ = conn.execute("ALTER TABLE album_images ADD COLUMN \"order\" INTEGER", []);
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id)",
            [],
        );

        // 创建任务-图片关联表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS task_images (
                task_id TEXT NOT NULL,
                image_id INTEGER NOT NULL,
                added_at INTEGER NOT NULL,
                \"order\" INTEGER,
                PRIMARY KEY (task_id, image_id)
            )",
            [],
        )
        .expect("Failed to create task_images table");
        let _ = conn.execute("ALTER TABLE task_images ADD COLUMN \"order\" INTEGER", []);

        // 任务下载失败图片表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS task_failed_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                url TEXT NOT NULL,
                \"order\" INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_error TEXT,
                last_attempted_at INTEGER
            )",
            [],
        )
        .expect("Failed to create task_failed_images table");
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_failed_images_task ON task_failed_images(task_id)",
            [],
        );

        // 执行复杂的结构性迁移
        perform_complex_migrations(&mut conn);
        // 复杂迁移可能重建 images 表，迁移后再次确保 mime_type 列存在。
        if !table_has_column(&conn, "images", "mime_type") {
            conn.execute("ALTER TABLE images ADD COLUMN mime_type TEXT", [])
                .expect("Failed to add images.mime_type column after migrations");
        }
        if !table_has_column(&conn, "images", "type") {
            conn.execute("ALTER TABLE images ADD COLUMN type TEXT DEFAULT 'image'", [])
                .expect("Failed to add images.type column after migrations");
        }
        // 复杂迁移可能重建 images 表，迁移后再次确保 surf_record_id 列存在。
        let _ = conn.execute("ALTER TABLE images ADD COLUMN surf_record_id TEXT", []);
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_surf_record_id ON images(surf_record_id)",
            [],
        );
        if !table_has_column(&conn, "images", "last_set_wallpaper_at") {
            conn.execute("ALTER TABLE images ADD COLUMN last_set_wallpaper_at INTEGER", [])
                .expect("Failed to add images.last_set_wallpaper_at column after migrations");
        }
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_last_set_wallpaper_at ON images(last_set_wallpaper_at DESC)",
            [],
        );

        // 创建畅游记录表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS surf_records (
                id TEXT PRIMARY KEY,
                host TEXT NOT NULL UNIQUE,
                root_url TEXT NOT NULL,
                icon BLOB,
                last_visit_at INTEGER NOT NULL,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create surf_records table");
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_surf_records_host ON surf_records(host)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_surf_records_last_visit ON surf_records(last_visit_at DESC)",
            [],
        );

        // 检测 plugin_sources 表是否已存在（用于判断是否首次迁移）
        let plugin_sources_is_new = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='plugin_sources'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) == 0;

        // 创建插件源表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS plugin_sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                index_url TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )",
            [],
        )
        .expect("Failed to create plugin_sources table");

        // 创建插件源缓存表（存储 index.json 原始内容）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS plugin_source_cache (
                source_id TEXT PRIMARY KEY,
                json_content TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                FOREIGN KEY (source_id) REFERENCES plugin_sources(id) ON DELETE CASCADE
            )",
            [],
        )
        .expect("Failed to create plugin_source_cache table");

        // 仅首次建表时执行初始数据迁移（避免用户删空源后被重新填充）
        if plugin_sources_is_new {
            let _ = migrate_plugin_sources_initial_data(&mut conn);
        }

        // 创建临时文件表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS temp_files (
                path TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create temp_files table");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS task_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                level TEXT NOT NULL,
                content TEXT NOT NULL,
                time INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create task_logs table");
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id)",
            [],
        );

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
        self.plugin_sources()
            .ensure_official_github_release()
            .map_err(|e| format!("Failed to ensure official plugin source: {}", e))?;
        // 新增字段后回填旧数据 MIME（仅本地文件路径，content:// 跳过）
        self.backfill_missing_mime_types()?;

        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    pub fn backfill_display_names(&self) -> Result<(), String> {
        use std::path::Path;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, local_path FROM images WHERE display_name = ''")
            .map_err(|e| format!("Failed to prepare: {}", e))?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("Failed to query images: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read rows: {}", e))?;
        drop(stmt);
        drop(conn);

        for (id, local_path) in rows {
            let path = Path::new(&local_path);
            let display_name = if path.exists() {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("image")
                    .to_string()
            } else {
                "（丢失文件）".to_string()
            };

            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            conn.execute(
                "UPDATE images SET display_name = ?1 WHERE id = ?2",
                params![display_name, id],
            )
            .map_err(|e| format!("Failed to update display_name: {}", e))?;
            drop(conn);
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

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let pragma = format!("PRAGMA table_info({})", table);
    let mut stmt = match conn.prepare(&pragma) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let rows = match stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        Ok(name)
    }) {
        Ok(r) => r,
        Err(_) => return false,
    };
    for r in rows.flatten() {
        if r == column {
            return true;
        }
    }
    false
}

fn migrate_rebuild_tasks_table(conn: &mut Connection) -> Result<(), String> {
    let has_legacy = table_has_column(conn, "tasks", "url")
        || table_has_column(conn, "tasks", "total_images")
        || table_has_column(conn, "tasks", "downloaded_images");
    if !has_legacy {
        return Ok(());
    }

    conn.execute_batch(
        r#"
PRAGMA foreign_keys=OFF;
BEGIN;
DROP TABLE IF EXISTS tasks_new;
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  output_dir TEXT,
  user_config TEXT,
  http_headers TEXT,
  output_album_id TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER,
  end_time INTEGER,
  error TEXT
);
INSERT INTO tasks_new (
  id, plugin_id, output_dir, user_config, http_headers, output_album_id,
  status, progress, deleted_count, start_time, end_time, error
)
SELECT
  id, plugin_id, output_dir, user_config, NULL, output_album_id,
  status, progress, COALESCE(deleted_count, 0), start_time, end_time, error
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
COMMIT;
PRAGMA foreign_keys=ON;
"#,
    )
    .map_err(|e| format!("migrate_rebuild_tasks_table failed: {}", e))?;

    Ok(())
}

fn compute_file_hash(path: &PathBuf) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn perform_complex_migrations(conn: &mut Connection) {
    let (
        images_id_is_text,
        images_has_favorite_col,
        images_thumb_notnull,
        images_url_notnull,
        images_has_order_col,
    ) = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(images)")
            .expect("Failed to prepare table_info(images)");
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let col_type: String = row.get(2)?;
                let notnull: i64 = row.get(3)?;
                Ok((name, col_type, notnull))
            })
            .expect("Failed to query table_info(images)");

        let mut id_type: Option<String> = None;
        let mut has_favorite = false;
        let mut thumb_notnull: Option<i64> = None;
        let mut url_notnull: Option<i64> = None;
        let mut has_order = false;
        for r in rows {
            if let Ok((name, col_type, notnull)) = r {
                if name == "id" {
                    id_type = Some(col_type);
                }
                if name == "favorite" {
                    has_favorite = true;
                }
                if name == "thumbnail_path" {
                    thumb_notnull = Some(notnull);
                }
                if name == "url" {
                    url_notnull = Some(notnull);
                }
                if name == "order" {
                    has_order = true;
                }
            }
        }
        let id_is_text = id_type.unwrap_or_default().to_uppercase().contains("TEXT");
        (
            id_is_text,
            has_favorite,
            thumb_notnull.unwrap_or(0) == 1,
            url_notnull.unwrap_or(0) == 1,
            has_order,
        )
    };

    let (album_image_id_is_text, task_image_id_is_text) = {
        fn is_image_id_text(conn: &Connection, table: &str) -> bool {
            let pragma = format!("PRAGMA table_info({})", table);
            let mut stmt = match conn.prepare(&pragma) {
                Ok(s) => s,
                Err(_) => return false,
            };
            let rows = match stmt.query_map([], |row| {
                let name: String = row.get(1)?;
                let col_type: String = row.get(2)?;
                Ok((name, col_type))
            }) {
                Ok(r) => r,
                Err(_) => return false,
            };
            for r in rows.flatten() {
                if r.0 == "image_id" {
                    return r.1.to_uppercase().contains("TEXT");
                }
            }
            false
        }
        (
            is_image_id_text(conn, "album_images"),
            is_image_id_text(conn, "task_images"),
        )
    };

    let needs_rebuild_images = images_id_is_text
        || images_has_favorite_col
        || !images_thumb_notnull
        || images_url_notnull
        || images_has_order_col;
    let needs_rebuild_relations =
        images_id_is_text || album_image_id_is_text || task_image_id_is_text;

    let albums_has_order = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(albums)")
            .expect("Failed to prepare table_info(albums)");
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                Ok(name)
            })
            .expect("Failed to query table_info(albums)");
        let has = rows.flatten().any(|name| name == "order");
        has
    };

    let settings_path = crate::app_paths::AppPaths::global().settings_json();
    let mut settings_json: Option<serde_json::Value> = None;
    let mut old_current_wallpaper_id: Option<String> = None;
    if settings_path.exists() {
        if let Ok(s) = fs::read_to_string(&settings_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                old_current_wallpaper_id = v
                    .get("currentWallpaperImageId")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                settings_json = Some(v);
            }
        }
    }

    let mut mapped_current_wallpaper_id: Option<i64> = None;
    let has_display_name = table_has_column(conn, "images", "display_name");
    let has_type_col = table_has_column(conn, "images", "type");
    let has_mime_type = table_has_column(conn, "images", "mime_type");
    let has_surf_record_id = table_has_column(conn, "images", "surf_record_id");
    let has_last_set_wallpaper_at = table_has_column(conn, "images", "last_set_wallpaper_at");
    if needs_rebuild_images || needs_rebuild_relations {
        let tx = conn
            .transaction()
            .expect("Failed to start transaction for images pk migration");

        tx.execute("DROP TABLE IF EXISTS images_ordered", []).ok();
        let type_col = if has_type_col { "COALESCE(type, 'image') AS type," } else { "" };
        let mime_col = if has_mime_type { "mime_type," } else { "" };
        let surf_col = if has_surf_record_id { "surf_record_id," } else { "" };
        let display_col = if has_display_name { "COALESCE(display_name, '') AS display_name," } else { "" };
        let last_wall_col = if has_last_set_wallpaper_at {
            "last_set_wallpaper_at,"
        } else {
            "NULL AS last_set_wallpaper_at,"
        };

        let id_expr = if images_id_is_text {
            "id AS old_id"
        } else {
            "CAST(id AS TEXT) AS old_id"
        };
        let new_id_expr = if images_id_is_text {
            "ROW_NUMBER() OVER (ORDER BY crawled_at ASC, id ASC) AS new_id"
        } else {
            "CAST(id AS INTEGER) AS new_id"
        };
        tx.execute(
            &format!(
                "CREATE TEMP TABLE images_ordered AS
                 SELECT
                   {id_expr},
                   url,
                   local_path,
                   plugin_id,
                   task_id,
                   crawled_at,
                   metadata,
                   COALESCE(NULLIF(thumbnail_path, ''), local_path) AS thumbnail_path,
                   COALESCE(hash, '') AS hash,
                   width,
                   height,
                   {type_col} {mime_col} {surf_col} {display_col} {last_wall_col} {new_id_expr}
                 FROM images"
            ),
            [],
        )
        .expect("Failed to create images_ordered");

        if images_id_is_text {
            if let Some(ref old_id) = old_current_wallpaper_id {
                mapped_current_wallpaper_id = tx
                    .query_row(
                        "SELECT new_id FROM images_ordered WHERE old_id = ?1 LIMIT 1",
                        params![old_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .ok();
            }
        }

        if needs_rebuild_images {
            tx.execute("DROP TABLE IF EXISTS images_new", []).ok();
            tx.execute(
                "CREATE TABLE images_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT,
                    local_path TEXT NOT NULL,
                    plugin_id TEXT NOT NULL,
                    task_id TEXT,
                    surf_record_id TEXT,
                    crawled_at INTEGER NOT NULL,
                    metadata TEXT,
                    thumbnail_path TEXT NOT NULL DEFAULT '',
                    hash TEXT NOT NULL DEFAULT '',
                    mime_type TEXT,
                    type TEXT DEFAULT 'image',
                    width INTEGER,
                    height INTEGER,
                    display_name TEXT NOT NULL DEFAULT '',
                    last_set_wallpaper_at INTEGER
                )",
                [],
            )
            .expect("Failed to create images_new (INTEGER pk)");

            let type_s = if has_type_col { "COALESCE(type, 'image')" } else { "'image'" };
            let mime_s = if has_mime_type { "mime_type," } else { "" };
            let surf_s = if has_surf_record_id { "surf_record_id," } else { "" };
            let (display_ins, display_sel) = if has_display_name {
                ("display_name", "COALESCE(display_name, '')")
            } else {
                ("display_name", "''")
            };
            let insert_cols = format!(
                "id, url, local_path, plugin_id, task_id, {surf_s} crawled_at, metadata, thumbnail_path, hash, {mime_s} type, width, height, {display_ins}, last_set_wallpaper_at"
            );
            let select_cols = format!(
                "new_id, url, local_path, plugin_id, task_id, {surf_s} crawled_at, metadata, COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, ''), {mime_s} {type_s}, width, height, {display_sel}, last_set_wallpaper_at"
            );
            tx.execute(
                &format!(
                    "INSERT INTO images_new ({})
                 SELECT {}
                 FROM images_ordered",
                    insert_cols, select_cols
                ),
                [],
            )
            .expect("Failed to migrate data to images_new");

            tx.execute("DROP TABLE images", [])
                .expect("Failed to drop old images");
            tx.execute("ALTER TABLE images_new RENAME TO images", [])
                .expect("Failed to rename images_new");
        }

        if needs_rebuild_relations {
            tx.execute("DROP TABLE IF EXISTS album_images_new", []).ok();
            tx.execute(
                "CREATE TABLE album_images_new (
                    album_id TEXT NOT NULL,
                    image_id INTEGER NOT NULL,
                    \"order\" INTEGER,
                    PRIMARY KEY (album_id, image_id)
                )",
                [],
            )
            .expect("Failed to create album_images_new");
            let _ = tx.execute(
                "INSERT OR IGNORE INTO album_images_new (album_id, image_id, \"order\")
                 SELECT
                   a.album_id,
                   o.new_id,
                   a.\"order\"
                 FROM album_images a
                 INNER JOIN images_ordered o
                   ON CAST(a.image_id AS TEXT) = o.old_id",
                [],
            );
            let _ = tx.execute("DROP TABLE album_images", []);
            let _ = tx.execute("ALTER TABLE album_images_new RENAME TO album_images", []);

            tx.execute("DROP TABLE IF EXISTS task_images_new", []).ok();
            tx.execute(
                "CREATE TABLE task_images_new (
                    task_id TEXT NOT NULL,
                    image_id INTEGER NOT NULL,
                    added_at INTEGER NOT NULL,
                    \"order\" INTEGER,
                    PRIMARY KEY (task_id, image_id)
                )",
                [],
            )
            .expect("Failed to create task_images_new");
            let _ = tx.execute(
                "INSERT OR REPLACE INTO task_images_new (task_id, image_id, added_at, \"order\")
                 SELECT
                   t.task_id,
                   o.new_id,
                   t.added_at,
                   t.\"order\"
                 FROM task_images t
                 INNER JOIN images_ordered o
                   ON CAST(t.image_id AS TEXT) = o.old_id",
                [],
            );
            let _ = tx.execute("DROP TABLE task_images", []);
            let _ = tx.execute("ALTER TABLE task_images_new RENAME TO task_images", []);
        }

        tx.execute("DROP TABLE IF EXISTS images_ordered", []).ok();
        tx.commit().expect("Failed to commit images pk migration");
    }

    // 若未重建 images 表但仍有 order 列（旧版），则删除该列
    if images_has_order_col && !needs_rebuild_images {
        let _ = conn.execute("ALTER TABLE images DROP COLUMN \"order\"", []);
    }

    // 移除 images.order 后清空 Provider 缓存，避免旧 ImageQuery（含 ORDER BY images."order"）被反序列化导致查询报错
    if images_has_order_col {
        let cache_dir = crate::app_paths::AppPaths::global().provider_cache_dir();
        if cache_dir.exists() {
            let _ = fs::remove_dir_all(&cache_dir);
        }
    }

    // albums: 移除历史遗留的 "order" 列，并把 created_at 统一改成「迁移时间 + order」。
    if albums_has_order {
        let base_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let tx = conn
            .transaction()
            .expect("Failed to start transaction for albums migration");

        tx.execute("DROP TABLE IF EXISTS albums_new", []).ok();
        tx.execute(
            "CREATE TABLE albums_new (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create albums_new");

        // created_at = base_time + order
        // 注：如果 order 为 NULL，则按 0 处理（与旧行为保持兼容）。
        tx.execute(
            "INSERT INTO albums_new (id, name, created_at)
             SELECT id, name, (?1 + COALESCE(\"order\", 0)) as created_at
             FROM albums",
            params![base_time],
        )
        .expect("Failed to migrate albums to albums_new");

        // 重新创建大小写不敏感唯一索引
        tx.execute("DROP INDEX IF EXISTS idx_albums_name_ci", [])
            .ok();

        tx.execute("DROP TABLE albums", [])
            .expect("Failed to drop old albums");
        tx.execute("ALTER TABLE albums_new RENAME TO albums", [])
            .expect("Failed to rename albums_new");

        tx.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name_ci ON albums(LOWER(name))",
            [],
        )
        .ok();

        tx.commit().expect("Failed to commit albums migration");
    }

    if images_id_is_text {
        if let (Some(mut v), Some(new_id)) = (settings_json, mapped_current_wallpaper_id) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "currentWallpaperImageId".to_string(),
                    serde_json::Value::String(new_id.to_string()),
                );
                if let Ok(s) = serde_json::to_string_pretty(&v) {
                    let _ = fs::write(&settings_path, s);
                }
            }
        }
    }

    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_crawled_at ON images(crawled_at DESC)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_plugin_id ON images(plugin_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_id ON images(task_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_images_task ON task_images(task_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_images_image ON task_images(image_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_last_set_wallpaper_at ON images(last_set_wallpaper_at DESC)",
        [],
    );
}

/// 迁移插件源初始数据（仅在首次建表时执行）
fn migrate_plugin_sources_initial_data(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    // 1. 插入默认官方源
    let index_url = plugin_sources::default_official_index_url();

    conn.execute(
        "INSERT INTO plugin_sources (id, name, index_url) VALUES (?, ?, ?)",
        params![
            plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID,
            "官方 GitHub Releases 源",
            index_url
        ],
    )?;

    // 2. 尝试迁移旧的 plugin_sources.json（用户自定义源）
    let old_sources_file = std::path::Path::new("data/plugin_sources.json");
    if old_sources_file.exists() {
        if let Ok(content) = std::fs::read_to_string(old_sources_file) {
            if let Ok(old_sources) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                for old_source in old_sources {
                    if let (Some(id), Some(name), Some(index_url)) = (
                        old_source.get("id").and_then(|v| v.as_str()),
                        old_source.get("name").and_then(|v| v.as_str()),
                        old_source.get("indexUrl").and_then(|v| v.as_str()),
                    ) {
                        // 跳过官方源（避免重复）
                        if id != plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID {
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO plugin_sources (id, name, index_url) VALUES (?, ?, ?)",
                                params![id, name, index_url],
                            );
                        }
                    }
                }
            }
        }
        // 迁移完成后删除旧文件
        let _ = std::fs::remove_file(old_sources_file);
    }

    // 3. 尝试迁移旧的 store-cache/*.json
    let store_cache_dir = std::path::Path::new("data/store-cache");
    if store_cache_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(store_cache_dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        if let Some(file_name) = entry.file_name().to_str() {
                            if file_name.ends_with(".json") {
                                let source_id = file_name.trim_end_matches(".json");
                                if let Ok(json_content) = std::fs::read_to_string(entry.path()) {
                                    let _ = conn.execute(
                                        "INSERT OR IGNORE INTO plugin_source_cache (source_id, json_content, updated_at) VALUES (?, ?, strftime('%s','now'))",
                                        params![source_id, json_content],
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        // 迁移完成后删除旧目录
        let _ = std::fs::remove_dir_all(store_cache_dir);
    }

    Ok(())
}
