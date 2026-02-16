use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
// Storage 不再依赖 Tauri AppHandle

pub mod albums;
pub mod dedupe;
pub mod gallery;
pub mod images;
pub mod run_configs;
pub mod tasks;
pub mod temp_files;

pub use albums::Album;
pub use images::ImageInfo;
pub use run_configs::RunConfig;
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
                error TEXT,
                rhai_dump_json TEXT,
                rhai_dump_created_at INTEGER,
                rhai_dump_confirmed INTEGER NOT NULL DEFAULT 0
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
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN rhai_dump_json TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN rhai_dump_created_at INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN rhai_dump_confirmed INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN http_headers TEXT", []);

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
                crawled_at INTEGER NOT NULL,
                metadata TEXT,
                thumbnail_path TEXT NOT NULL DEFAULT '',
                hash TEXT NOT NULL DEFAULT '',
                \"order\" INTEGER
            )",
            [],
        )
        .expect("Failed to create images table");

        let _ = conn.execute("ALTER TABLE images ADD COLUMN task_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE images ADD COLUMN hash TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute("ALTER TABLE images ADD COLUMN \"order\" INTEGER", []);

        // 创建索引
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
            "CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time DESC)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash)",
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

        // 创建临时文件表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS temp_files (
                path TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create temp_files table");

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

        let _ = self.migrate_from_json();
        self.ensure_favorite_album()?;

        Ok(())
    }

    pub fn migrate_from_json(&self) -> Result<usize, String> {
        let metadata_file = self.get_metadata_file();
        if !metadata_file.exists() {
            return Err("未找到旧 JSON 文件".to_string());
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query count: {}", e))?;

        if count > 0 {
            return Ok(0);
        }

        let content = fs::read_to_string(&metadata_file)
            .map_err(|e| format!("Failed to read metadata file: {}", e))?;
        let images: Vec<ImageInfo> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse metadata: {}", e))?;

        drop(conn);

        let mut migrated_count = 0;
        for mut image in images {
            image.task_id = None;
            let hash = compute_file_hash(&PathBuf::from(&image.local_path))
                .unwrap_or_else(|_| String::new());
            image.hash = hash;
            if PathBuf::from(&image.local_path).exists() {
                let _ = self.add_image(image)?;
                migrated_count += 1;
            }
        }

        Ok(migrated_count)
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
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("images.db")
    }

    pub fn get_images_dir(&self) -> PathBuf {
        if let Some(pictures_dir) = dirs::picture_dir() {
            pictures_dir.join("Kabegame")
        } else {
            let app_data_dir = crate::app_paths::kabegame_data_dir();
            app_data_dir.join("images")
        }
    }

    pub fn get_thumbnails_dir(&self) -> PathBuf {
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("thumbnails")
    }

    fn get_metadata_file(&self) -> PathBuf {
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("images_metadata.json")
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
  error TEXT,
  rhai_dump_json TEXT,
  rhai_dump_created_at INTEGER,
  rhai_dump_confirmed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tasks_new (
  id, plugin_id, output_dir, user_config, http_headers, output_album_id,
  status, progress, deleted_count, start_time, end_time, error,
  rhai_dump_json, rhai_dump_created_at, rhai_dump_confirmed
)
SELECT
  id, plugin_id, output_dir, user_config, NULL, output_album_id,
  status, progress, COALESCE(deleted_count, 0), start_time, end_time, error,
  NULL, NULL, 0
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
    let (images_id_is_text, images_has_favorite_col, images_thumb_notnull, images_url_notnull) = {
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
            }
        }
        let id_is_text = id_type.unwrap_or_default().to_uppercase().contains("TEXT");
        (
            id_is_text,
            has_favorite,
            thumb_notnull.unwrap_or(0) == 1,
            url_notnull.unwrap_or(0) == 1,
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

    let needs_rebuild_images =
        images_id_is_text || images_has_favorite_col || !images_thumb_notnull || images_url_notnull;
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

    let settings_path = crate::app_paths::kabegame_data_dir().join("settings.json");
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
    if needs_rebuild_images || needs_rebuild_relations {
        let tx = conn
            .transaction()
            .expect("Failed to start transaction for images pk migration");

        tx.execute("DROP TABLE IF EXISTS images_ordered", []).ok();
        if images_id_is_text {
            tx.execute(
                "CREATE TEMP TABLE images_ordered AS
                 SELECT
                   id AS old_id,
                   url,
                   local_path,
                   plugin_id,
                   task_id,
                   crawled_at,
                   metadata,
                   COALESCE(NULLIF(thumbnail_path, ''), local_path) AS thumbnail_path,
                   COALESCE(hash, '') AS hash,
                   \"order\" AS ord,
                   ROW_NUMBER() OVER (
                     ORDER BY COALESCE(\"order\", crawled_at) ASC, crawled_at ASC, id ASC
                   ) AS new_id
                 FROM images",
                [],
            )
            .expect("Failed to create images_ordered (TEXT id)");
        } else {
            tx.execute(
                "CREATE TEMP TABLE images_ordered AS
                 SELECT
                   CAST(id AS TEXT) AS old_id,
                   url,
                   local_path,
                   plugin_id,
                   task_id,
                   crawled_at,
                   metadata,
                   COALESCE(NULLIF(thumbnail_path, ''), local_path) AS thumbnail_path,
                   COALESCE(hash, '') AS hash,
                   \"order\" AS ord,
                   CAST(id AS INTEGER) AS new_id
                 FROM images",
                [],
            )
            .expect("Failed to create images_ordered (INTEGER id)");
        }

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
                    crawled_at INTEGER NOT NULL,
                    metadata TEXT,
                    thumbnail_path TEXT NOT NULL DEFAULT '',
                    hash TEXT NOT NULL DEFAULT '',
                    \"order\" INTEGER
                )",
                [],
            )
            .expect("Failed to create images_new (INTEGER pk)");

            tx.execute(
                "INSERT INTO images_new (
                    id, url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, \"order\"
                 )
                 SELECT
                    new_id,
                    url,
                    local_path,
                    plugin_id,
                    task_id,
                    crawled_at,
                    metadata,
                    COALESCE(NULLIF(thumbnail_path, ''), local_path),
                    COALESCE(hash, ''),
                    COALESCE(ord, crawled_at)
                 FROM images_ordered",
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
}
