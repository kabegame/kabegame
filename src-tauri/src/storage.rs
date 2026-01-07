use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// 收藏画册的固定ID
pub const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    pub url: String,
    pub local_path: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    pub crawled_at: u64,
    pub metadata: Option<HashMap<String, String>>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    pub favorite: bool,
    /// 本地文件是否存在（用于前端标记缺失文件：仍展示条目，但提示用户源文件已丢失/移动）
    #[serde(default = "default_true")]
    pub local_exists: bool,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct DedupeRemoveResult {
    pub removed: usize,
    pub removed_ids: Vec<String>,
    #[serde(default)]
    pub removed_ids_truncated: bool,
}

/// 分批去重游标：用于稳定分页（避免删除导致 OFFSET 跳页/漏页）。
#[derive(Debug, Clone)]
pub struct DedupeCursor {
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
    pub id: String,
}

/// 分批去重扫描行（内部使用）
#[derive(Debug, Clone)]
pub struct DedupeScanRow {
    pub id: String,
    pub hash: String,
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
}

impl DedupeScanRow {
    pub fn cursor(&self) -> DedupeCursor {
        DedupeCursor {
            is_favorite: self.is_favorite,
            sort_key: self.sort_key,
            crawled_at: self.crawled_at,
            id: self.id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToAlbumResult {
    pub added: usize,         // 实际添加的数量
    pub attempted: usize,     // 尝试添加的数量
    pub can_add: usize,       // 最多可添加的数量
    pub current_count: usize, // 当前画册的图片数量
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaginatedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    pub url: String,
    #[serde(rename = "outputDir")]
    pub output_dir: Option<String>,
    #[serde(rename = "userConfig")]
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "outputAlbumId")]
    pub output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
    pub status: String,
    pub progress: f64,
    #[serde(rename = "totalImages")]
    pub total_images: i64,
    #[serde(rename = "downloadedImages")]
    pub downloaded_images: i64,
    #[serde(rename = "deletedCount")]
    pub deleted_count: i64,
    #[serde(rename = "startTime")]
    pub start_time: Option<u64>,
    #[serde(rename = "endTime")]
    pub end_time: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    pub url: String,
    #[serde(rename = "outputDir")]
    pub output_dir: Option<String>,
    #[serde(rename = "userConfig")]
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    pub created_at: u64,
}

#[derive(Clone)]
pub struct Storage {
    db: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesResult {
    pub inserted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesProgress {
    pub inserted: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
struct BaseImageRow {
    url: String,
    local_path: String,
    plugin_id: String,
    task_id: Option<String>,
    crawled_at: i64,
    metadata_json: Option<String>,
    thumbnail_path: String,
    hash: String,
    order: Option<i64>,
}

/// 一个简单、可复现的 PRNG（避免为了 debug 功能引入 rand 依赖）。
#[derive(Debug, Clone)]
struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        // xorshift 的 seed 不能为 0，否则会一直输出 0
        let state = if seed == 0 { 0x9E3779B97F4A7C15 } else { seed };
        Self { state }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    fn gen_usize(&mut self, upper_exclusive: usize) -> usize {
        if upper_exclusive == 0 {
            return 0;
        }
        (self.next_u64() as usize) % upper_exclusive
    }
}

impl Storage {
    /// 分批去重：统计 hash != '' 的记录总数（进度用）。
    pub fn get_dedupe_total_hash_images_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM images WHERE hash != ''", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to query dedupe total: {}", e))?;
        Ok(total as usize)
    }

    /// 分批去重：按“保留优先级”顺序读取下一批。
    ///
    /// 顺序规则（与全量去重一致）：
    /// - 优先 favorite（收藏画册）=1
    /// - 其次 COALESCE(order, crawled_at) 更大
    /// - 再其次 crawled_at 更大
    /// - 最后以 id 作为稳定 tie-breaker
    ///
    /// 使用 cursor 做“< last”分页，避免边删边扫时 OFFSET 漏页/重复。
    pub fn get_dedupe_batch(
        &self,
        cursor: Option<&DedupeCursor>,
        limit: usize,
    ) -> Result<Vec<DedupeScanRow>, String> {
        if limit == 0 {
            return Ok(vec![]);
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 注意：SQLite WHERE 里不能直接引用 SELECT 的别名，这里重复表达式。
        let fav_expr = "CASE WHEN fav.image_id IS NOT NULL THEN 1 ELSE 0 END";
        let sort_expr = "COALESCE(images.\"order\", images.crawled_at)";

        let (sql, params_vec): (String, Vec<rusqlite::types::Value>) = match cursor {
            None => (
                format!(
                    "SELECT CAST(images.id AS TEXT) as id,
                            images.hash,
                            {fav_expr} AS is_favorite,
                            {sort_expr} AS sort_key,
                            images.crawled_at
                     FROM images
                     LEFT JOIN album_images AS fav
                       ON images.id = fav.image_id AND fav.album_id = ?1
                     WHERE images.hash != ''
                     ORDER BY is_favorite DESC,
                              sort_key DESC,
                              images.crawled_at DESC,
                              images.id DESC
                     LIMIT ?2"
                ),
                vec![
                    rusqlite::types::Value::from(FAVORITE_ALBUM_ID.to_string()),
                    rusqlite::types::Value::from(limit as i64),
                ],
            ),
            Some(c) => {
                // 对 DESC 排序，使用“严格小于 last tuple”的分页条件
                let sql = format!(
                    "SELECT CAST(images.id AS TEXT) as id,
                            images.hash,
                            {fav_expr} AS is_favorite,
                            {sort_expr} AS sort_key,
                            images.crawled_at
                     FROM images
                     LEFT JOIN album_images AS fav
                       ON images.id = fav.image_id AND fav.album_id = ?1
                     WHERE images.hash != ''
                       AND (
                            ({fav_expr} < ?2)
                         OR ({fav_expr} = ?2 AND {sort_expr} < ?3)
                         OR ({fav_expr} = ?2 AND {sort_expr} = ?3 AND images.crawled_at < ?4)
                         OR ({fav_expr} = ?2 AND {sort_expr} = ?3 AND images.crawled_at = ?4 AND images.id < ?5)
                       )
                     ORDER BY is_favorite DESC,
                              sort_key DESC,
                              images.crawled_at DESC,
                              images.id DESC
                     LIMIT ?6"
                );
                (
                    sql,
                    vec![
                        rusqlite::types::Value::from(FAVORITE_ALBUM_ID.to_string()),
                        rusqlite::types::Value::from(c.is_favorite),
                        rusqlite::types::Value::from(c.sort_key),
                        rusqlite::types::Value::from(c.crawled_at),
                        rusqlite::types::Value::from(c.id.clone()),
                        rusqlite::types::Value::from(limit as i64),
                    ],
                )
            }
        };

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare dedupe batch query: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(DedupeScanRow {
                    id: row.get(0)?,
                    hash: row.get(1)?,
                    is_favorite: row.get(2)?,
                    sort_key: row.get(3)?,
                    crawled_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query dedupe batch: {}", e))?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Failed to read dedupe batch row: {}", e))?);
        }
        Ok(out)
    }
    pub fn album_exists(&self, album_id: &str) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query album existence: {}", e))?;
        Ok(exists)
    }

    /// 判断图片是否属于指定画册（不加载整表，适用于启动/大数据场景）
    pub fn is_image_in_album(&self, album_id: &str, image_id: &str) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM album_images WHERE album_id = ?1 AND image_id = ?2)",
                params![album_id, image_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query album membership: {}", e))?;
        Ok(exists)
    }

    /// 从画廊里挑一张“本地文件存在”的图片 ID，用于启动时快速恢复壁纸（避免加载大量数据）。
    ///
    /// mode:
    /// - "random": 尝试基于 rowid 采样，避免 ORDER BY RANDOM 全表打乱
    /// - 其他: 取排序第一张（COALESCE(order, crawled_at) ASC）
    pub fn pick_existing_gallery_image_id(&self, mode: &str) -> Result<Option<String>, String> {
        use std::path::Path;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut candidates: Vec<(String, String)> = Vec::new();

        if mode == "random" {
            // 注意：MAX(rowid) 可能为 NULL（空表），用 COALESCE 兜底为 1
            let mut stmt = conn
                .prepare(
                    "SELECT CAST(id AS TEXT) as id, local_path
                     FROM images
                     WHERE rowid >= (abs(random()) % COALESCE((SELECT MAX(rowid) FROM images), 1))
                     ORDER BY rowid
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare random gallery pick query: {}", e))?;
            let rows = stmt
                .query_map(params![50i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query random gallery pick: {}", e))?;
            for r in rows {
                candidates
                    .push(r.map_err(|e| format!("Failed to read random gallery pick row: {}", e))?);
            }
        }

        if candidates.is_empty() {
            let mut stmt = conn
                .prepare(
                    "SELECT CAST(id AS TEXT) as id, local_path
                     FROM images
                     ORDER BY COALESCE(\"order\", crawled_at) ASC
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare gallery pick query: {}", e))?;
            let rows = stmt
                .query_map(params![50i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query gallery pick: {}", e))?;
            for r in rows {
                candidates.push(r.map_err(|e| format!("Failed to read gallery pick row: {}", e))?);
            }
        }

        for (id, local_path) in candidates {
            if Path::new(&local_path).exists() {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// 从指定画册里挑一张“本地文件存在”的图片 ID，用于启动时快速恢复壁纸（避免加载大量数据）。
    pub fn pick_existing_album_image_id(
        &self,
        album_id: &str,
        mode: &str,
    ) -> Result<Option<String>, String> {
        use std::path::Path;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut candidates: Vec<(String, String)> = Vec::new();

        if mode == "random" {
            let mut stmt = conn
                .prepare(
                    "SELECT CAST(images.id AS TEXT) as id, images.local_path
                     FROM album_images
                     INNER JOIN images ON images.id = album_images.image_id
                     WHERE album_images.album_id = ?1
                       AND album_images.rowid >= (
                           abs(random()) % COALESCE((SELECT MAX(rowid) FROM album_images WHERE album_id = ?1), 1)
                       )
                     ORDER BY album_images.rowid
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare random album pick query: {}", e))?;
            let rows = stmt
                .query_map(params![album_id, 50i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query random album pick: {}", e))?;
            for r in rows {
                candidates
                    .push(r.map_err(|e| format!("Failed to read random album pick row: {}", e))?);
            }
        }

        if candidates.is_empty() {
            let mut stmt = conn
                .prepare(
                    "SELECT CAST(images.id AS TEXT) as id, images.local_path
                     FROM images
                     INNER JOIN album_images ON images.id = album_images.image_id
                     WHERE album_images.album_id = ?1
                     ORDER BY COALESCE(album_images.\"order\", album_images.rowid) ASC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare album pick query: {}", e))?;
            let rows = stmt
                .query_map(params![album_id, 50i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query album pick: {}", e))?;
            for r in rows {
                candidates.push(r.map_err(|e| format!("Failed to read album pick row: {}", e))?);
            }
        }

        for (id, local_path) in candidates {
            if Path::new(&local_path).exists() {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    pub fn new(_app: AppHandle) -> Self {
        let db_path = Self::get_db_path();
        // 确保应用数据目录存在
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).expect("Failed to create app data directory");
        }
        let mut conn = Connection::open(&db_path).expect("Failed to open database");

        // 启动性能优化（百万级数据时非常关键）：
        // - WAL：读写并发更好，降低 UI 卡死概率
        // - synchronous=NORMAL：在 WAL 下兼顾可靠性与性能
        // - busy_timeout：避免瞬时锁导致报错
        // - temp_store/cache/mmap：减少磁盘 IO（适度设置，避免占用过高）
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
                url TEXT NOT NULL,
                output_dir TEXT,
                user_config TEXT,
                output_album_id TEXT,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                total_images INTEGER NOT NULL DEFAULT 0,
                downloaded_images INTEGER NOT NULL DEFAULT 0,
                start_time INTEGER,
                end_time INTEGER,
                error TEXT
            )",
            [],
        )
        .expect("Failed to create tasks table");

        // 数据库迁移：如果 output_album_id 列不存在，则添加
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN output_album_id TEXT", []);
        // 数据库迁移：如果 deleted_count 列不存在，则添加
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN deleted_count INTEGER NOT NULL DEFAULT 0",
            [],
        );

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
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create run_configs table");

        // 创建图片表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
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

        // 迁移：如果 images 表没有 task_id 字段，添加它
        let _ = conn.execute("ALTER TABLE images ADD COLUMN task_id TEXT", []);
        // 迁移：添加 hash 字段（如果不存在）
        let _ = conn.execute(
            "ALTER TABLE images ADD COLUMN hash TEXT NOT NULL DEFAULT ''",
            [],
        );
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE images ADD COLUMN \"order\" INTEGER", []);
        // 注意：不在启动阶段做全表 UPDATE（百万级会导致明显黑屏/无响应）。
        // 查询时已使用 COALESCE(order, crawled_at) 做兜底排序；新写入也会设置 order。

        // 说明：images 的结构性迁移（主键类型/删除列/强制 NOT NULL）统一在稍后进行：
        // 因为需要同时迁移 album_images/task_images 的 image_id 类型，并尽量保留 settings.json 的 currentWallpaperImageId。

        // 创建索引以提高查询性能
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crawled_at ON images(crawled_at DESC)",
            [],
        )
        .expect("Failed to create index");

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_plugin_id ON images(plugin_id)",
            [],
        )
        .expect("Failed to create index");

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_id ON images(task_id)",
            [],
        )
        .expect("Failed to create index");

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time DESC)",
            [],
        )
        .expect("Failed to create index");
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash)",
            [],
        )
        .expect("Failed to create index");

        // 创建画册表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS albums (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                \"order\" INTEGER
            )",
            [],
        )
        .expect("Failed to create albums table");
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE albums ADD COLUMN \"order\" INTEGER", []);
        // 注意：不在启动阶段做全表 UPDATE（百万级会导致明显黑屏/无响应）。
        // 查询时已使用 COALESCE(order, created_at) 做兜底排序；新写入也会设置 order。

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
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE album_images ADD COLUMN \"order\" INTEGER", []);
        // 注意：不在启动阶段做全表 UPDATE（百万级会导致明显黑屏/无响应）。
        // 排序时已使用 COALESCE(order, rowid) 兜底；写入画册图片时也会设置 order。

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id)",
            [],
        )
        .expect("Failed to create album_images index");

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
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE task_images ADD COLUMN \"order\" INTEGER", []);
        // 注意：不在启动阶段做全表 UPDATE（百万级会导致明显黑屏/无响应）。
        // 查询时可用 COALESCE(order, added_at) 兜底；写入 task_images 时会设置 order。

        // ============================
        // 结构性迁移：images 主键改为自增 INTEGER，并同步迁移 album_images/task_images.image_id
        // 同时顺带清理历史结构差异（favorite 列、thumbnail_path NOT NULL 等）。
        // ============================
        let (images_id_is_text, images_has_favorite_col, images_thumb_notnull) = {
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
                }
            }
            let id_is_text = id_type.unwrap_or_default().to_uppercase().contains("TEXT");
            (id_is_text, has_favorite, thumb_notnull.unwrap_or(0) == 1)
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
                is_image_id_text(&conn, "album_images"),
                is_image_id_text(&conn, "task_images"),
            )
        };

        let needs_rebuild_images =
            images_id_is_text || images_has_favorite_col || !images_thumb_notnull;
        let needs_rebuild_relations =
            images_id_is_text || album_image_id_is_text || task_image_id_is_text;

        // 读取 settings.json（用于迁移 currentWallpaperImageId）
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

            // 临时映射表：old_id(TEXT) -> new_id(INTEGER)
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

            // 1) 重建 images（需要时）
            if needs_rebuild_images {
                tx.execute("DROP TABLE IF EXISTS images_new", []).ok();
                tx.execute(
                    "CREATE TABLE images_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        url TEXT NOT NULL,
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

            // 2) 重建关联表（需要时）
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

        // 写回 settings.json（仅 TEXT -> INTEGER 时才需要映射）
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

        // 注意：images/album_images 可能在迁移中被重建，从而丢失索引；这里确保索引存在
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

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_images_task ON task_images(task_id)",
            [],
        )
        .expect("Failed to create task_images task index");
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_images_image ON task_images(image_id)",
            [],
        )
        .expect("Failed to create task_images image index");

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
        }
    }

    /// 调试：基于现有图片记录，批量克隆生成大量图片数据用于性能/分页测试。
    ///
    /// 约束：
    /// - 仅保证 `id` 不同；其余字段尽量保持与源记录一致（用于“真实数据分布”的压测）
    /// - 分批事务提交，避免一次性超大事务造成长时间锁表
    /// - 通过事件 `debug-clone-images-progress` 反馈进度
    pub fn debug_clone_images(
        &self,
        app: AppHandle,
        count: usize,
        pool_size: usize,
        seed: Option<u64>,
    ) -> Result<DebugCloneImagesResult, String> {
        if count == 0 {
            return Ok(DebugCloneImagesResult { inserted: 0 });
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let pool_size = pool_size.clamp(1, 5000);
        let pool: Vec<BaseImageRow> = {
            let mut pool_stmt = conn
                .prepare(
                    "SELECT url, local_path, plugin_id, task_id, crawled_at, metadata,
                            COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, ''), \"order\"
                     FROM images
                     ORDER BY RANDOM()
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare pool query: {}", e))?;

            let rows = pool_stmt
                .query_map(params![pool_size as i64], |row| {
                    Ok(BaseImageRow {
                        url: row.get(0)?,
                        local_path: row.get(1)?,
                        plugin_id: row.get(2)?,
                        task_id: row.get(3)?,
                        crawled_at: row.get(4)?,
                        metadata_json: row.get(5)?,
                        thumbnail_path: row.get(6)?,
                        hash: row.get(7)?,
                        order: row.get(8)?,
                    })
                })
                .map_err(|e| format!("Failed to query pool: {}", e))?;

            let mut v = Vec::new();
            for r in rows {
                v.push(r.map_err(|e| format!("Failed to read pool row: {}", e))?);
            }
            v
        };
        if pool.is_empty() {
            return Err("数据库里没有任何图片记录，无法生成测试数据".to_string());
        }

        let default_seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let mut rng = XorShift64::new(seed.unwrap_or(default_seed));

        let total = count;
        let batch_size = 5000usize.min(total).max(1);
        let mut inserted = 0usize;

        while inserted < total {
            let cur = (total - inserted).min(batch_size);
            let tx = conn
                .transaction()
                .map_err(|e| format!("Failed to begin transaction: {}", e))?;

            {
                let mut insert_img = tx
                    .prepare(
                        "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, \"order\")
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    )
                    .map_err(|e| format!("Failed to prepare insert image: {}", e))?;

                let mut insert_task_img = tx
                    .prepare(
                        "INSERT OR REPLACE INTO task_images (task_id, image_id, added_at, \"order\")
                         VALUES (?1, ?2, ?3, ?4)",
                    )
                    .map_err(|e| format!("Failed to prepare insert task_images: {}", e))?;

                for _ in 0..cur {
                    let base = &pool[rng.gen_usize(pool.len())];

                    let thumbnail_path = if base.thumbnail_path.trim().is_empty() {
                        base.local_path.clone()
                    } else {
                        base.thumbnail_path.clone()
                    };

                    // 为了“随机插入而非简单重复”，对排序关键字段做轻微扰动
                    // 说明：画廊分页排序使用 COALESCE(order, crawled_at)，因此扰动这两个字段能有效打散结果
                    let jitter = (rng.next_u64() % 1_000_000) as i64; // ~ 100 万范围内扰动
                    let crawled_at = base.crawled_at.saturating_add(jitter);

                    // 与 add_image 行为保持一致：order None 时，使用 crawled_at 作为默认值
                    let base_order = base.order.unwrap_or(base.crawled_at);
                    let order = base_order.saturating_add(jitter);

                    insert_img
                        .execute(params![
                            &base.url,
                            &base.local_path,
                            &base.plugin_id,
                            &base.task_id,
                            crawled_at,
                            &base.metadata_json,
                            thumbnail_path,
                            &base.hash,
                            order,
                        ])
                        .map_err(|e| format!("Failed to insert image (debug clone): {}", e))?;
                    let new_id = tx.last_insert_rowid();

                    // 复用任务关联（如果源记录有 task_id）
                    if let Some(task_id) = base.task_id.as_ref() {
                        let added_at = crawled_at;
                        insert_task_img
                            .execute(params![task_id, new_id, added_at, order])
                            .map_err(|e| {
                                format!("Failed to insert task-image relation (debug clone): {}", e)
                            })?;
                    }
                }
            }

            tx.commit()
                .map_err(|e| format!("Failed to commit debug clone transaction: {}", e))?;

            inserted += cur;
            let _ = app.emit(
                "debug-clone-images-progress",
                DebugCloneImagesProgress { inserted, total },
            );
        }

        Ok(DebugCloneImagesResult { inserted })
    }

    fn get_db_path() -> PathBuf {
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("images.db")
    }

    pub fn init(&self) -> Result<(), String> {
        let images_dir = self.get_images_dir();
        fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images directory: {}", e))?;
        let thumbnails_dir = self.get_thumbnails_dir();
        fs::create_dir_all(&thumbnails_dir)
            .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;

        // 迁移旧数据（如果存在）
        // 迁移失败不影响应用启动
        let _ = self.migrate_from_json();

        // 确保存在"收藏"画册
        self.ensure_favorite_album()?;

        Ok(())
    }

    /// 确保存在"收藏"画册，如果不存在则创建
    pub fn ensure_favorite_album(&self) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 检查收藏画册是否存在（使用固定ID）
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![FAVORITE_ALBUM_ID],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query favorite album existence: {}", e))?;

        if !exists {
            // 创建收藏画册，使用固定ID
            let created_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| format!("Time error: {}", e))?
                .as_secs();
            conn.execute(
                "INSERT INTO albums (id, name, created_at) VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, "收藏", created_at as i64],
            )
            .map_err(|e| format!("Failed to create default '收藏' album: {}", e))?;
            println!("已创建默认'收藏'画册");
        }

        Ok(())
    }

    pub fn migrate_from_json(&self) -> Result<usize, String> {
        let metadata_file = self.get_metadata_file();
        if !metadata_file.exists() {
            return Err("未找到旧的 JSON 文件".to_string());
        }

        // 检查数据库是否已有数据
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query count: {}", e))?;

        if count > 0 {
            // 数据库已有数据，跳过迁移（不报错）
            return Ok(0);
        }

        // 读取 JSON 文件并迁移
        let content = fs::read_to_string(&metadata_file)
            .map_err(|e| format!("Failed to read metadata file: {}", e))?;
        let images: Vec<ImageInfo> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse metadata: {}", e))?;

        drop(conn);

        // 插入到数据库（旧数据没有 task_id，设为 None）
        let mut migrated_count = 0;
        for mut image in images {
            // 确保 task_id 为 None（旧数据没有这个字段）
            image.task_id = None;
            // 兼容旧数据：计算哈希后写入
            let hash = compute_file_hash(&PathBuf::from(&image.local_path))
                .unwrap_or_else(|_| String::new());
            image.hash = hash;
            // 检查文件是否存在
            if PathBuf::from(&image.local_path).exists() {
                let _ = self.add_image(image)?;
                migrated_count += 1;
            }
            // 如果文件不存在，跳过该图片
        }

        // 迁移完成后，可以选择删除旧文件（可选）
        // let _ = fs::remove_file(&metadata_file);

        Ok(migrated_count)
    }

    fn get_metadata_file(&self) -> PathBuf {
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("images_metadata.json")
    }

    pub fn get_images_dir(&self) -> PathBuf {
        // 先尝试获取用户的Pictures目录
        if let Some(pictures_dir) = dirs::picture_dir() {
            pictures_dir.join("Kabegame")
        } else {
            // 如果获取不到Pictures目录，回落到原来的设置
            let app_data_dir = crate::app_paths::kabegame_data_dir();
            app_data_dir.join("images")
        }
    }

    pub fn get_thumbnails_dir(&self) -> PathBuf {
        let app_data_dir = crate::app_paths::kabegame_data_dir();
        app_data_dir.join("thumbnails")
    }

    pub fn get_images_range(&self, offset: usize, limit: usize) -> Result<RangedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 获取总数（不再支持按来源/收藏过滤）
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query count: {}", e))?;

        // 范围查询：使用 LEFT JOIN 来判断图片是否在收藏画册中（用于前端展示星标）
        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.\"order\"
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC 
             LIMIT ? OFFSET ?",
            FAVORITE_ALBUM_ID
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![limit as i64, offset as i64], |row| {
                let local_path: String = row.get(2)?;
                let local_exists = PathBuf::from(&local_path).exists();
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(RangedImages {
            images,
            total: total as usize,
            offset,
            limit,
        })
    }

    pub fn get_images_paginated(
        &self,
        page: usize,
        page_size: usize,
    ) -> Result<PaginatedImages, String> {
        let offset = page.saturating_mul(page_size);
        let res = self.get_images_range(offset, page_size)?;
        Ok(PaginatedImages {
            images: res.images,
            total: res.total,
            page,
            page_size,
        })
    }

    pub fn get_all_images(&self) -> Result<Vec<ImageInfo>, String> {
        // 为了兼容性，返回所有图片（但使用分页查询以避免内存问题）
        // 注意：如果图片很多，这可能仍然会有问题
        let result = self.get_images_paginated(0, 10000)?;
        Ok(result.images)
    }

    pub fn find_image_by_id(&self, image_id: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.id = ?1",
                params![image_id],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row
                            .get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
                    })
                },
            )
            .ok();

        // 如果找到了，再查询是否在收藏画册中
        if let Some(ref mut image_info) = result {
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_info.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    pub fn find_image_by_path(&self, local_path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 查询图片基本信息
        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.local_path = ?1",
                params![local_path],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false, // 稍后通过单独查询设置
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
                    })
                },
            )
            .ok();

        // 如果找到了，再查询是否在收藏画册中
        if let Some(ref mut image_info) = result {
            let image_id = image_info.id.clone();
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    pub fn find_image_by_url(&self, url: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 images.\"order\"
                 FROM images
                 LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = ?1
                 WHERE images.url = ?2
                 ORDER BY images.crawled_at DESC, images.id DESC
                 LIMIT 1",
                params![FAVORITE_ALBUM_ID, url],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: row.get::<_, i64>(9)? != 0,
                        local_exists,
                        order: row.get::<_, Option<i64>>(10)?,
                    })
                },
            )
            .ok();

        Ok(result)
    }

    pub fn find_image_by_hash(&self, hash: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 images.\"order\"
                 FROM images
                 LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = ?1
                 WHERE images.hash = ?2
                 ORDER BY images.crawled_at DESC, images.id DESC
                 LIMIT 1",
                params![FAVORITE_ALBUM_ID, hash],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: row.get::<_, i64>(9)? != 0,
                        local_exists,
                        order: row.get::<_, Option<i64>>(10)?,
                    })
                },
            )
            .ok();

        Ok(result)
    }

    // 画册相关操作
    pub fn add_album(&self, name: &str) -> Result<Album, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();
        // 获取当前最大 order 值，新画册的 order = max_order + 1000
        let max_order: Option<i64> = conn
            .query_row(
                "SELECT MAX(COALESCE(\"order\", created_at)) FROM albums",
                [],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let new_order = max_order.unwrap_or(created_at as i64) + 1000;

        conn.execute(
            "INSERT INTO albums (id, name, created_at, \"order\") VALUES (?1, ?2, ?3, ?4)",
            params![id, name, created_at as i64, new_order],
        )
        .map_err(|e| format!("Failed to insert album: {}", e))?;

        Ok(Album {
            id,
            name: name.to_string(),
            created_at,
            order: Some(new_order),
        })
    }

    pub fn get_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        // 使用 CAST 确保 order 字段被转换为 INTEGER，即使数据库中可能是 TEXT
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, CAST(\"order\" AS INTEGER) FROM albums ORDER BY COALESCE(CAST(\"order\" AS INTEGER), created_at) ASC")
            .map_err(|e| format!("Failed to prepare albums query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Album {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get::<_, i64>(2)? as u64,
                    order: row.get::<_, Option<i64>>(3)?,
                })
            })
            .map_err(|e| format!("Failed to query albums: {}", e))?;

        let mut albums = Vec::new();
        for r in rows {
            albums.push(r.map_err(|e| format!("Failed to read album row: {}", e))?);
        }
        Ok(albums)
    }

    pub fn delete_album(&self, album_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 检查是否为"收藏"画册，不允许删除（使用固定ID）
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除'收藏'画册".to_string());
        }

        // 先删除关联
        conn.execute(
            "DELETE FROM album_images WHERE album_id = ?1",
            params![album_id],
        )
        .map_err(|e| format!("Failed to delete album mappings: {}", e))?;

        // 再删除画册
        conn.execute("DELETE FROM albums WHERE id = ?1", params![album_id])
            .map_err(|e| format!("Failed to delete album: {}", e))?;

        Ok(())
    }

    pub fn rename_album(&self, album_id: &str, new_name: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 检查新名称是否为空
        if new_name.trim().is_empty() {
            return Err("画册名称不能为空".to_string());
        }

        // 更新画册名称
        conn.execute(
            "UPDATE albums SET name = ?1 WHERE id = ?2",
            params![new_name.trim(), album_id],
        )
        .map_err(|e| format!("Failed to rename album: {}", e))?;

        Ok(())
    }

    pub fn add_images_to_album(
        &self,
        album_id: &str,
        image_ids: &[String],
    ) -> Result<AddToAlbumResult, String> {
        const MAX_ALBUM_IMAGES: i64 = 10000;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 获取当前画册的图片数量
        let current_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query album image count: {}", e))?;

        // 计算将要添加的图片数量（排除已存在的）
        let mut new_count = 0;
        for img_id in image_ids {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![album_id, img_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if exists == 0 {
                new_count += 1;
            }
        }

        let current_count_usize = current_count as usize;
        let can_add = (MAX_ALBUM_IMAGES - current_count).max(0) as usize;
        let attempted = image_ids.len();

        // 检查是否超过上限
        if current_count + new_count > MAX_ALBUM_IMAGES {
            if can_add == 0 {
                return Err(format!("画册已满（{} 张），无法继续添加", MAX_ALBUM_IMAGES));
            } else {
                return Err(format!(
                    "画册空间不足：最多可放入 {} 张，尝试放入 {} 张",
                    can_add, attempted
                ));
            }
        }

        // 执行添加操作
        let mut inserted = 0;
        // 为新插入的图片分配递增 order，确保后续仅 swap 两条 order 也能稳定排序
        let max_order: i64 = conn
            .query_row(
                "SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .unwrap_or(0);
        let mut next_order: i64 = max_order + 1000;
        for img_id in image_ids {
            let rows = conn
                .execute(
                    "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                    params![album_id, img_id, next_order],
                )
                .map_err(|e| format!("Failed to insert album image: {}", e))?;
            inserted += rows;
            next_order += 1000;
        }

        Ok(AddToAlbumResult {
            added: inserted as usize,
            attempted,
            can_add,
            current_count: current_count_usize,
        })
    }

    /// 静默添加图片到画册（用于任务自动添加）
    /// 超出上限时静默失败，只添加能添加的部分
    pub fn add_images_to_album_silent(&self, album_id: &str, image_ids: &[String]) -> usize {
        const MAX_ALBUM_IMAGES: i64 = 10000;

        let conn = match self.db.lock() {
            Ok(c) => c,
            Err(_) => return 0,
        };

        // 获取当前画册的图片数量
        let current_count: i64 = match conn.query_row(
            "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
            params![album_id],
            |row| row.get(0),
        ) {
            Ok(count) => count,
            Err(_) => return 0,
        };

        // 计算剩余可添加数量
        let remaining = (MAX_ALBUM_IMAGES - current_count).max(0) as usize;
        if remaining == 0 {
            return 0;
        }

        // 执行添加操作，只添加能添加的部分
        let mut inserted = 0;
        let max_order: i64 = conn
            .query_row(
                "SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .unwrap_or(0);
        let mut next_order: i64 = max_order + 1000;
        for img_id in image_ids {
            if inserted >= remaining {
                break;
            }

            // 检查是否已存在
            let exists: i64 = match conn.query_row(
                "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                params![album_id, img_id],
                |row| row.get(0),
            ) {
                Ok(count) => count,
                Err(_) => continue,
            };

            if exists > 0 {
                continue; // 已存在，跳过
            }

            // 尝试添加
            match conn.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![album_id, img_id, next_order],
            ) {
                Ok(rows) => {
                    inserted += rows;
                }
                Err(_) => {
                    // 静默失败，继续下一个
                    continue;
                }
            }
            next_order += 1000;
        }

        inserted as usize
    }

    /// 从指定画册中移除图片（仅移除关联，不删除图片记录/文件）
    pub fn remove_images_from_album(
        &self,
        album_id: &str,
        image_ids: &[String],
    ) -> Result<usize, String> {
        if image_ids.is_empty() {
            return Ok(0);
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        let mut removed: usize = 0;
        for img_id in image_ids {
            let rows = tx
                .execute(
                    "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![album_id, img_id],
                )
                .map_err(|e| format!("Failed to remove album image: {}", e))?;
            removed += rows as usize;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(removed)
    }

    pub fn get_album_images(&self, album_id: &str) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 使用 LEFT JOIN 来判断图片是否在收藏画册中
        let mut stmt = conn
            .prepare(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 CASE WHEN favorite_check.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 COALESCE(album_images.\"order\", album_images.rowid) as album_image_order
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 LEFT JOIN album_images as favorite_check ON images.id = favorite_check.image_id AND favorite_check.album_id = ?1
                 WHERE album_images.album_id = ?2
                 ORDER BY COALESCE(album_images.\"order\", album_images.rowid) ASC",
            )
            .map_err(|e| format!("Failed to prepare album images query: {}", e))?;

        let rows = stmt
            .query_map(params![FAVORITE_ALBUM_ID, album_id], |row| {
                let local_path: String = row.get(2)?;
                let local_exists = PathBuf::from(&local_path).exists();
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query album images: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            images.push(r.map_err(|e| format!("Failed to read album image row: {}", e))?);
        }
        Ok(images)
    }

    pub fn get_album_preview(
        &self,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 使用 LEFT JOIN 来判断图片是否在收藏画册中
        let mut stmt = conn
            .prepare(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 CASE WHEN favorite_check.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 COALESCE(album_images.\"order\", album_images.rowid) as album_image_order
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 LEFT JOIN album_images as favorite_check ON images.id = favorite_check.image_id AND favorite_check.album_id = ?1
                 WHERE album_images.album_id = ?2
                 ORDER BY COALESCE(album_images.\"order\", album_images.rowid) ASC
                 LIMIT ?3",
            )
            .map_err(|e| format!("Failed to prepare album preview query: {}", e))?;

        let rows = stmt
            .query_map(params![FAVORITE_ALBUM_ID, album_id, limit as i64], |row| {
                let local_path: String = row.get(2)?;
                let local_exists = PathBuf::from(&local_path).exists();
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query album preview: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            images.push(r.map_err(|e| format!("Failed to read album preview row: {}", e))?);
        }
        Ok(images)
    }

    pub fn get_album_image_ids(&self, album_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT CAST(image_id AS TEXT) FROM album_images WHERE album_id = ?1")
            .map_err(|e| format!("Failed to prepare album image ids query: {}", e))?;

        let rows = stmt
            .query_map(params![album_id], |row| Ok(row.get::<_, String>(0)?))
            .map_err(|e| format!("Failed to query album image ids: {}", e))?;

        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| format!("Failed to read album image id row: {}", e))?);
        }
        Ok(ids)
    }

    pub fn get_album_counts(&self) -> Result<HashMap<String, usize>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT album_id, COUNT(*) as cnt FROM album_images GROUP BY album_id")
            .map_err(|e| format!("Failed to prepare album counts query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let album_id: String = row.get(0)?;
                let cnt: i64 = row.get(1)?;
                Ok((album_id, cnt as usize))
            })
            .map_err(|e| format!("Failed to query album counts: {}", e))?;

        let mut map = HashMap::new();
        for r in rows {
            let (id, cnt) = r.map_err(|e| format!("Failed to read album count row: {}", e))?;
            map.insert(id, cnt);
        }
        Ok(map)
    }

    pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let metadata_json = image
            .metadata
            .as_ref()
            .and_then(|m| serde_json::to_string(m).ok());
        let thumbnail_path = if image.thumbnail_path.trim().is_empty() {
            image.local_path.clone()
        } else {
            image.thumbnail_path.clone()
        };

        // 如果 order 为 None，使用 crawled_at 作为默认值
        let order = image.order.unwrap_or(image.crawled_at as i64);

        conn.execute(
            "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, \"order\")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.crawled_at as i64,
                metadata_json,
                thumbnail_path,
                image.hash,
                order,
            ],
        )
        .map_err(|e| format!("Failed to insert image: {}", e))?;
        let new_id = conn.last_insert_rowid();
        image.id = new_id.to_string();
        image.order = Some(order);
        image.thumbnail_path = thumbnail_path;

        // 如果图片有关联的任务，添加到任务-图片关联表
        if let Some(ref task_id) = image.task_id {
            let added_at = image.crawled_at as i64;
            let task_order = order; // 使用图片的 order 作为任务中的顺序
            conn.execute(
                "INSERT OR REPLACE INTO task_images (task_id, image_id, added_at, \"order\")
                 VALUES (?1, ?2, ?3, ?4)",
                params![task_id, new_id, added_at, task_order],
            )
            .map_err(|e| format!("Failed to insert task-image relation: {}", e))?;
        }

        Ok(image)
    }

    pub fn delete_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 先查询图片信息，以便删除文件
        let mut image: Option<ImageInfo> = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash, images.\"order\"
                 FROM images WHERE images.id = ?1",
                params![image_id],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        order: row.get::<_, Option<i64>>(9)?,
                        favorite: false, // 不再从数据库读取，将通过 JOIN 计算
                        local_exists,
                    })
                },
            )
            .ok();

        // 如果找到了，再查询是否在收藏画册中
        if let Some(ref mut image_info) = image {
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_info.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            image_info.favorite = is_favorite;
        }

        let task_id = image.as_ref().and_then(|img| img.task_id.clone());

        if let Some(image) = image {
            // 删除原文件
            let path = PathBuf::from(&image.local_path);
            if path.exists() {
                fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
            }

            // 删除缩略图（为空字符串则跳过）
            if !image.thumbnail_path.is_empty() {
                let thumb = PathBuf::from(&image.thumbnail_path);
                if thumb.exists() {
                    let _ = fs::remove_file(&thumb);
                }
            }
        }

        // 从数据库删除
        conn.execute(
            "DELETE FROM album_images WHERE image_id = ?1",
            params![image_id],
        )
        .map_err(|e| format!("Failed to delete album mapping: {}", e))?;
        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to delete image from database: {}", e))?;

        // 如果图片属于某个任务，增加任务的已删除数量
        if let Some(ref task_id) = task_id {
            drop(conn); // 释放锁，因为 increment_task_deleted_count 需要获取锁
            let _ = self.increment_task_deleted_count(task_id, 1);
        }

        Ok(())
    }

    /// 移除图片（只删除缩略图和数据库记录，不删除原图）
    pub fn remove_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 先查询图片信息，以便删除缩略图
        let mut image: Option<ImageInfo> = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash, images.\"order\"
                 FROM images WHERE images.id = ?1",
                params![image_id],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        order: row.get::<_, Option<i64>>(9)?,
                        favorite: false, // 不再从数据库读取，将通过 JOIN 计算
                        local_exists,
                    })
                },
            )
            .ok();

        // 如果找到了，再查询是否在收藏画册中
        if let Some(ref mut image_info) = image {
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_info.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            image_info.favorite = is_favorite;
        }

        let task_id = image.as_ref().and_then(|img| img.task_id.clone());

        if let Some(image) = image {
            // 只删除缩略图（为空字符串则跳过）
            if !image.thumbnail_path.is_empty() {
                let thumb = PathBuf::from(&image.thumbnail_path);
                if thumb.exists() {
                    let _ = fs::remove_file(&thumb);
                }
            }
            // 注意：不删除原图文件
        }

        // 从数据库删除
        conn.execute(
            "DELETE FROM album_images WHERE image_id = ?1",
            params![image_id],
        )
        .map_err(|e| format!("Failed to delete album mapping: {}", e))?;
        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to delete image from database: {}", e))?;

        // 如果图片属于某个任务，增加任务的已删除数量
        if let Some(ref task_id) = task_id {
            drop(conn); // 释放锁，因为 increment_task_deleted_count 需要获取锁
            let _ = self.increment_task_deleted_count(task_id, 1);
        }

        Ok(())
    }

    /// 批量删除图片（删除文件和数据库记录）
    pub fn batch_delete_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 收集所有需要删除的文件路径
        let mut file_paths = Vec::new();
        let mut thumbnail_paths = Vec::new();
        let mut task_ids = Vec::new();

        for image_id in image_ids {
            // 查询图片信息
            let image: Option<ImageInfo> = tx
                .query_row(
                    "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                     COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                     images.hash, images.\"order\"
                     FROM images WHERE images.id = ?1",
                    params![image_id],
                    |row| {
                        let local_path: String = row.get(2)?;
                        let local_exists = PathBuf::from(&local_path).exists();
                        Ok(ImageInfo {
                            id: row.get(0)?,
                            url: row.get(1)?,
                            local_path,
                            plugin_id: row.get(3)?,
                            task_id: row.get(4)?,
                            crawled_at: row.get(5)?,
                            metadata: row.get::<_, Option<String>>(6)?
                                .and_then(|s| serde_json::from_str(&s).ok()),
                            thumbnail_path: row.get(7)?,
                            hash: row.get(8)?,
                            order: row.get::<_, Option<i64>>(9)?,
                            favorite: false, // 批量操作时不需要这个字段
                            local_exists,
                        })
                    },
                )
                .ok();

            if let Some(image) = image {
                file_paths.push(image.local_path);
                if !image.thumbnail_path.is_empty() {
                    thumbnail_paths.push(image.thumbnail_path);
                }
                if let Some(task_id) = image.task_id {
                    task_ids.push((image_id.clone(), task_id));
                }
            }
        }

        // 删除数据库记录
        for image_id in image_ids {
            tx.execute(
                "DELETE FROM album_images WHERE image_id = ?1",
                params![image_id],
            )
            .map_err(|e| format!("Failed to delete album mapping for {}: {}", image_id, e))?;

            tx.execute("DELETE FROM images WHERE id = ?1", params![image_id])
                .map_err(|e| format!("Failed to delete image {} from database: {}", image_id, e))?;
        }

        // 更新任务的 deletedCount
        for (_, task_id) in task_ids {
            let _ = self.increment_task_deleted_count_in_tx(&tx, &task_id, 1);
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        // 删除文件（在事务提交后删除，以防失败）
        for path in file_paths {
            let file_path = PathBuf::from(&path);
            if file_path.exists() {
                let _ = fs::remove_file(&file_path);
            }
        }

        for path in thumbnail_paths {
            let thumb_path = PathBuf::from(&path);
            if thumb_path.exists() {
                let _ = fs::remove_file(&thumb_path);
            }
        }

        Ok(())
    }

    /// 批量移除图片（仅删除数据库记录，不删除文件）
    pub fn batch_remove_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 收集缩略图路径和任务ID
        let mut thumbnail_paths = Vec::new();
        let mut task_ids = Vec::new();

        for image_id in image_ids {
            // 查询图片信息
            let image: Option<ImageInfo> = tx
                .query_row(
                    "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                     COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                     images.hash, images.\"order\"
                     FROM images WHERE images.id = ?1",
                    params![image_id],
                    |row| {
                        let local_path: String = row.get(2)?;
                        let local_exists = PathBuf::from(&local_path).exists();
                        Ok(ImageInfo {
                            id: row.get(0)?,
                            url: row.get(1)?,
                            local_path,
                            plugin_id: row.get(3)?,
                            task_id: row.get(4)?,
                            crawled_at: row.get(5)?,
                            metadata: row.get::<_, Option<String>>(6)?
                                .and_then(|s| serde_json::from_str(&s).ok()),
                            thumbnail_path: row.get(7)?,
                            hash: row.get(8)?,
                            order: row.get::<_, Option<i64>>(9)?,
                            favorite: false, // 批量操作时不需要这个字段
                            local_exists,
                        })
                    },
                )
                .ok();

            if let Some(image) = image {
                if !image.thumbnail_path.is_empty() {
                    thumbnail_paths.push(image.thumbnail_path);
                }
                if let Some(task_id) = image.task_id {
                    task_ids.push((image_id.clone(), task_id));
                }
            }
        }

        // 删除数据库记录
        for image_id in image_ids {
            tx.execute(
                "DELETE FROM album_images WHERE image_id = ?1",
                params![image_id],
            )
            .map_err(|e| format!("Failed to delete album mapping for {}: {}", image_id, e))?;

            tx.execute("DELETE FROM images WHERE id = ?1", params![image_id])
                .map_err(|e| format!("Failed to delete image {} from database: {}", image_id, e))?;
        }

        // 更新任务的 deletedCount
        for (_, task_id) in task_ids {
            let _ = self.increment_task_deleted_count_in_tx(&tx, &task_id, 1);
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        // 删除缩略图文件
        for path in thumbnail_paths {
            let thumb_path = PathBuf::from(&path);
            if thumb_path.exists() {
                let _ = fs::remove_file(&thumb_path);
            }
        }

        Ok(())
    }

    /// 按 hash 去重：每个 hash 保留 1 条记录，其余从画廊移除。
    ///
    /// 参数：
    /// - `delete_files`: 为 true 时同时从磁盘删除原图文件；为 false 时仅从画廊和数据库移除记录。
    ///
    /// 规则：
    /// - 优先保留 `favorite=1` 的那张
    /// - 否则保留 `order`（或 `crawled_at`）更大的那张（更“新”）
    /// - 仅处理 `hash != ''` 的记录
    #[allow(dead_code)]
    pub fn dedupe_gallery_by_hash(&self, delete_files: bool) -> Result<DedupeRemoveResult, String> {
        // IPC/JSON 传输和前端解析大量字符串会严重卡顿；这里限制返回的 removed_ids 数量。
        // 对于超大规模去重（例如 100w -> 1w），前端应选择“强制刷新”而不是逐条移除。
        const MAX_RETURN_REMOVED_IDS: usize = 20_000;

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 先把重复 hash 列出来（单独作用域，避免 stmt 借用 tx 导致后续无法 commit）
        let hashes: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT hash
                     FROM images
                     WHERE hash != ''
                     GROUP BY hash
                     HAVING COUNT(*) > 1",
                )
                .map_err(|e| format!("Failed to prepare dedupe hash query: {}", e))?;

            let hashes_iter = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query duplicate hashes: {}", e))?;

            let mut hashes: Vec<String> = Vec::new();
            for h in hashes_iter {
                hashes.push(h.map_err(|e| format!("Failed to read hash row: {}", e))?);
            }
            hashes
        };

        let mut removed_count: usize = 0;
        let mut removed_ids: Vec<String> = Vec::new();
        let mut removed_ids_truncated = false;

        for hash in hashes {
            // 选一个要保留的 id（优先保留在收藏画册中的图片）
            let keep_id: Option<String> = tx
                .query_row(
                    "SELECT images.id
                     FROM images
                     LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = ?1
                     WHERE images.hash = ?2
                     ORDER BY CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END DESC,
                              COALESCE(images.\"order\", images.crawled_at) DESC,
                              images.crawled_at DESC
                     LIMIT 1",
                    params![FAVORITE_ALBUM_ID, hash],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query keep image for hash: {}", e))?;

            let Some(keep_id) = keep_id else {
                continue;
            };

            // 找出要移除的记录（并删除缩略图文件，若 delete_files 为 true 则同时删除原图）
            let mut stmt2 = tx
                .prepare(
                    "SELECT id, COALESCE(NULLIF(thumbnail_path, ''), local_path), local_path, task_id
                     FROM images
                     WHERE hash = ?1 AND id != ?2",
                )
                .map_err(|e| format!("Failed to prepare dedupe remove query: {}", e))?;

            let rows = stmt2
                .query_map(params![hash, keep_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| format!("Failed to query dedupe remove rows: {}", e))?;

            // 统计每个任务的删除数量
            let mut task_deleted_counts: HashMap<String, i64> = HashMap::new();

            for r in rows {
                let (id, thumb_path, local_path, task_id) =
                    r.map_err(|e| format!("Failed to read dedupe remove row: {}", e))?;

                // 记录任务删除数量
                if let Some(ref task_id) = task_id {
                    *task_deleted_counts.entry(task_id.clone()).or_insert(0) += 1;
                }

                // 删除缩略图（忽略错误）
                if !thumb_path.trim().is_empty() {
                    let p = PathBuf::from(thumb_path);
                    if p.exists() {
                        let _ = fs::remove_file(p);
                    }
                }

                // 如果需要，删除原图文件
                if delete_files && !local_path.trim().is_empty() {
                    let p = PathBuf::from(local_path);
                    if p.exists() {
                        let _ = fs::remove_file(p);
                    }
                }

                // 删除映射与记录
                tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id])
                    .map_err(|e| format!("Failed to delete album mapping in dedupe: {}", e))?;
                tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                    .map_err(|e| format!("Failed to delete image in dedupe: {}", e))?;

                removed_count += 1;
                if removed_ids.len() < MAX_RETURN_REMOVED_IDS {
                    removed_ids.push(id);
                } else {
                    removed_ids_truncated = true;
                }
            }

            // 在事务提交前，更新任务的 deleted_count
            for (task_id, count) in task_deleted_counts {
                tx.execute(
                    "UPDATE tasks SET deleted_count = COALESCE(deleted_count, 0) + ?1 WHERE id = ?2",
                    params![count, task_id],
                )
                .map_err(|e| format!("Failed to update task deleted_count in dedupe: {}", e))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit dedupe transaction: {}", e))?;

        Ok(DedupeRemoveResult {
            removed: removed_count,
            removed_ids,
            removed_ids_truncated,
        })
    }

    pub fn get_total_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query count: {}", e))?;

        Ok(total as usize)
    }

    // 任务相关操作
    pub fn add_task(&self, task: TaskInfo) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let user_config_json = task
            .user_config
            .as_ref()
            .and_then(|c| serde_json::to_string(c).ok());

        conn.execute(
            "INSERT OR REPLACE INTO tasks (id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, deleted_count, start_time, end_time, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                task.id,
                task.plugin_id,
                task.url,
                task.output_dir,
                user_config_json,
                task.output_album_id,
                task.status,
                task.progress,
                task.total_images,
                task.downloaded_images,
                task.deleted_count,
                task.start_time.map(|t| t as i64),
                task.end_time.map(|t| t as i64),
                task.error,
            ],
        )
        .map_err(|e| format!("Failed to insert task: {}", e))?;

        Ok(())
    }

    pub fn update_task(&self, task: TaskInfo) -> Result<(), String> {
        self.add_task(task) // INSERT OR REPLACE 可以用于更新
    }

    /// 增加任务的已删除数量
    fn increment_task_deleted_count_in_tx(
        &self,
        tx: &Transaction,
        task_id: &str,
        count: i64,
    ) -> Result<(), String> {
        if count <= 0 {
            return Ok(());
        }
        tx.execute(
            "UPDATE tasks SET deleted_count = COALESCE(deleted_count, 0) + ?1 WHERE id = ?2",
            params![count, task_id],
        )
        .map_err(|e| format!("Failed to increment task deleted_count: {}", e))?;
        Ok(())
    }

    fn increment_task_deleted_count(&self, task_id: &str, count: i64) -> Result<(), String> {
        if count <= 0 {
            return Ok(());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE tasks SET deleted_count = COALESCE(deleted_count, 0) + ?1 WHERE id = ?2",
            params![count, task_id],
        )
        .map_err(|e| format!("Failed to increment task deleted_count: {}", e))?;
        Ok(())
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let task = conn
            .query_row(
                "SELECT id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, COALESCE(deleted_count, 0), start_time, end_time, error
                 FROM tasks WHERE id = ?1",
                params![task_id],
                |row| {
                    Ok(TaskInfo {
                        id: row.get(0)?,
                        plugin_id: row.get(1)?,
                        url: row.get(2)?,
                        output_dir: row.get(3)?,
                        user_config: row.get::<_, Option<String>>(4)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        output_album_id: row.get(5)?,
                        status: row.get(6)?,
                        progress: row.get(7)?,
                        total_images: row.get(8)?,
                        downloaded_images: row.get(9)?,
                        deleted_count: row.get(10)?,
                        start_time: row.get::<_, Option<i64>>(11)?.map(|t| t as u64),
                        end_time: row.get::<_, Option<i64>>(12)?.map(|t| t as u64),
                        error: row.get(13)?,
                    })
                },
            )
            .ok();

        Ok(task)
    }

    pub fn get_all_tasks(&self) -> Result<Vec<TaskInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, COALESCE(deleted_count, 0), start_time, end_time, error
                 FROM tasks ORDER BY start_time DESC"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let task_rows = stmt
            .query_map([], |row| {
                Ok(TaskInfo {
                    id: row.get(0)?,
                    plugin_id: row.get(1)?,
                    url: row.get(2)?,
                    output_dir: row.get(3)?,
                    user_config: row
                        .get::<_, Option<String>>(4)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    output_album_id: row.get(5)?,
                    status: row.get(6)?,
                    progress: row.get(7)?,
                    total_images: row.get(8)?,
                    downloaded_images: row.get(9)?,
                    deleted_count: row.get(10)?,
                    start_time: row.get::<_, Option<i64>>(11)?.map(|t| t as u64),
                    end_time: row.get::<_, Option<i64>>(12)?.map(|t| t as u64),
                    error: row.get(13)?,
                })
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut tasks = Vec::new();
        for row_result in task_rows {
            let task = row_result.map_err(|e| format!("Failed to read row: {}", e))?;
            tasks.push(task);
        }

        Ok(tasks)
    }

    /// 将所有 pending 和 running 状态的任务标记为 failed
    /// 用于应用启动时清理未完成的任务
    pub fn mark_pending_running_tasks_as_failed(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 获取当前时间戳作为 end_time
        let end_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to get current time: {}", e))?
            .as_secs() as i64;

        // 更新所有 pending 或 running 状态的任务为 failed
        let rows_affected = conn
            .execute(
                "UPDATE tasks SET status = 'failed', end_time = ?1, error = ?2 
             WHERE status IN ('pending', 'running')",
                params![end_time, Some("应用重启，任务已中断".to_string())],
            )
            .map_err(|e| format!("Failed to mark tasks as failed: {}", e))?;

        Ok(rows_affected)
    }

    // 运行配置 CRUD
    pub fn add_run_config(&self, config: RunConfig) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        // user_config 不能为空：至少存一个 {}，避免前端/旧数据导致运行配置“看似存在但没有变量”
        let user_config_json = match config.user_config.as_ref() {
            Some(c) => Some(
                serde_json::to_string(c)
                    .map_err(|e| format!("Failed to serialize run_config.user_config: {}", e))?,
            ),
            None => Some("{}".to_string()),
        };
        conn.execute(
            "INSERT OR REPLACE INTO run_configs (id, name, description, plugin_id, url, output_dir, user_config, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                config.id,
                config.name,
                config.description,
                config.plugin_id,
                config.url,
                config.output_dir,
                user_config_json,
                config.created_at as i64
            ],
        )
        .map_err(|e| format!("Failed to insert run_config: {}", e))?;
        Ok(())
    }

    pub fn get_run_configs(&self) -> Result<Vec<RunConfig>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, plugin_id, url, output_dir, user_config, created_at
                 FROM run_configs ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare run_configs query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let user_config: Option<String> = row.get(6)?;
                Ok(RunConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    plugin_id: row.get(3)?,
                    url: row.get(4)?,
                    output_dir: row.get(5)?,
                    // 解析失败时回退为空对象，避免“预设存在但变量丢失”
                    user_config: Some(user_config.as_deref().unwrap_or("{}").to_string())
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .or_else(|| Some(std::collections::HashMap::new())),
                    created_at: row.get::<_, i64>(7)? as u64,
                })
            })
            .map_err(|e| format!("Failed to query run_configs: {}", e))?;

        let mut configs = Vec::new();
        for r in rows {
            configs.push(r.map_err(|e| format!("Failed to read run_config row: {}", e))?);
        }
        Ok(configs)
    }

    pub fn delete_run_config(&self, config_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM run_configs WHERE id = ?1", params![config_id])
            .map_err(|e| format!("Failed to delete run_config: {}", e))?;
        Ok(())
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 1. 将关联该任务的图片的 task_id 设为 NULL（解除关联，但不删除图片）
        conn.execute(
            "UPDATE images SET task_id = NULL WHERE task_id = ?1",
            params![task_id],
        )
        .map_err(|e| format!("Failed to unlink images from task: {}", e))?;

        // 2. 删除任务记录
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete task from database: {}", e))?;

        Ok(())
    }

    /// 清除所有已完成、失败或取消的任务（保留 pending 和 running 的任务）
    /// 返回被删除的任务数量
    pub fn clear_finished_tasks(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 1. 先获取要删除的任务 ID 列表
        let mut stmt = conn
            .prepare("SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'canceled')")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let task_ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query tasks: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        if task_ids.is_empty() {
            return Ok(0);
        }

        let count = task_ids.len();

        // 2. 将这些任务关联的图片的 task_id 设为 NULL
        for task_id in &task_ids {
            conn.execute(
                "UPDATE images SET task_id = NULL WHERE task_id = ?1",
                params![task_id],
            )
            .map_err(|e| format!("Failed to unlink images from task: {}", e))?;
        }

        // 3. 删除这些任务记录
        conn.execute(
            "DELETE FROM tasks WHERE status IN ('completed', 'failed', 'canceled')",
            [],
        )
        .map_err(|e| format!("Failed to delete finished tasks: {}", e))?;

        Ok(count)
    }

    pub fn get_task_image_ids(&self, task_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT CAST(image_id AS TEXT) FROM task_images WHERE task_id = ?1")
            .map_err(|e| format!("Failed to prepare task image ids query: {}", e))?;
        let rows = stmt
            .query_map(params![task_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query task image ids: {}", e))?;

        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| format!("Failed to read task image id row: {}", e))?);
        }
        Ok(ids)
    }

    pub fn get_task_images(&self, task_id: &str) -> Result<Vec<ImageInfo>, String> {
        // 为了向后兼容，保留此方法，但调用分页版本
        let result = self.get_task_images_paginated(task_id, 0, 10000)?;
        Ok(result.images)
    }

    pub fn get_task_images_paginated(
        &self,
        task_id: &str,
        page: usize,
        page_size: usize,
    ) -> Result<PaginatedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 获取总数（使用 task_images 表）
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_images WHERE task_id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query count: {}", e))?;

        // 分页查询（使用 task_images 表关联查询）
        let offset = page * page_size;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 CASE WHEN favorite_check.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite, images.hash, 
                 COALESCE(task_images.\"order\", images.crawled_at) as task_order
                 FROM images
                 INNER JOIN task_images ON images.id = task_images.image_id
                 LEFT JOIN album_images as favorite_check ON images.id = favorite_check.image_id AND favorite_check.album_id = ?2
                 WHERE task_images.task_id = ?1
                 ORDER BY COALESCE(task_images.\"order\", images.crawled_at) ASC
                 LIMIT ?3 OFFSET ?4"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(
                params![task_id, FAVORITE_ALBUM_ID, page_size as i64, offset as i64],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row
                            .get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        favorite: row.get::<_, i64>(8)? != 0,
                        local_exists,
                        hash: row.get(9)?,
                        order: row.get::<_, Option<i64>>(10)?,
                    })
                },
            )
            .map_err(|e| format!("Failed to query task images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(PaginatedImages {
            images,
            total: total as usize,
            page,
            page_size,
        })
    }

    pub fn toggle_image_favorite(&self, image_id: &str, favorite: bool) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 不再更新 favorite 字段，直接操作收藏画册
        // 确保收藏画册存在（使用固定ID）
        let favorite_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![FAVORITE_ALBUM_ID],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query favorite album existence: {}", e))?;

        if !favorite_exists {
            // 如果"收藏"画册不存在，创建它（这不应该发生，因为 init 时会创建）
            eprintln!("警告：'收藏'画册不存在，尝试创建");
            let created_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| format!("Time error: {}", e))?
                .as_secs();
            conn.execute(
                "INSERT INTO albums (id, name, created_at) VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, "收藏", created_at as i64],
            )
            .map_err(|e| format!("Failed to create favorite album: {}", e))?;
        }

        // 使用固定ID操作收藏画册
        if favorite {
            // 收藏时：将图片添加到"收藏"画册
            // 获取当前画册中最大的 order 值
            let max_order: Option<i64> = conn
                .query_row(
                    "SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?1",
                    params![FAVORITE_ALBUM_ID],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            let new_order = max_order.unwrap_or(0) + 1000;

            conn.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, image_id, new_order],
            )
            .map_err(|e| format!("Failed to add image to favorite album: {}", e))?;
        } else {
            // 取消收藏时：从"收藏"画册中移除图片
            conn.execute(
                "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                params![FAVORITE_ALBUM_ID, image_id],
            )
            .map_err(|e| format!("Failed to remove image from favorite album: {}", e))?;
        }

        Ok(())
    }

    /// 更新图片的缩略图路径
    pub fn update_image_thumbnail_path(
        &self,
        image_id: &str,
        thumbnail_path: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET thumbnail_path = ?1 WHERE id = ?2",
            params![thumbnail_path, image_id],
        )
        .map_err(|e| format!("Failed to update image thumbnail path: {}", e))?;
        Ok(())
    }

    /// 批量更新图片的 order（画廊中的顺序）
    pub fn update_images_order(&self, image_orders: &[(String, i64)]) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        for (image_id, order) in image_orders {
            conn.execute(
                "UPDATE images SET \"order\" = ?1 WHERE id = ?2",
                params![order, image_id],
            )
            .map_err(|e| format!("Failed to update image order: {}", e))?;
        }
        Ok(())
    }

    /// 批量更新画册中图片的 order
    pub fn update_album_images_order(
        &self,
        album_id: &str,
        image_orders: &[(String, i64)],
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        for (image_id, order) in image_orders {
            conn.execute(
                "UPDATE album_images SET \"order\" = ?1 WHERE album_id = ?2 AND image_id = ?3",
                params![order, album_id, image_id],
            )
            .map_err(|e| format!("Failed to update album image order: {}", e))?;
        }
        Ok(())
    }

    /// 批量更新画册的 order
    pub fn update_albums_order(&self, album_orders: &[(String, i64)]) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        for (album_id, order) in album_orders {
            conn.execute(
                "UPDATE albums SET \"order\" = ?1 WHERE id = ?2",
                params![order, album_id],
            )
            .map_err(|e| format!("Failed to update album order: {}", e))?;
        }
        Ok(())
    }

    /// 添加临时文件记录
    pub fn add_temp_file(&self, file_path: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();
        conn.execute(
            "INSERT OR REPLACE INTO temp_files (path, created_at) VALUES (?1, ?2)",
            params![file_path, created_at as i64],
        )
        .map_err(|e| format!("Failed to insert temp file: {}", e))?;
        Ok(())
    }

    /// 删除临时文件记录
    pub fn remove_temp_file(&self, file_path: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM temp_files WHERE path = ?1", params![file_path])
            .map_err(|e| format!("Failed to delete temp file record: {}", e))?;
        Ok(())
    }

    /// 获取所有临时文件路径
    pub fn get_all_temp_files(&self) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT path FROM temp_files")
            .map_err(|e| format!("Failed to prepare temp files query: {}", e))?;
        let rows = stmt
            .query_map([], |row| Ok(row.get::<_, String>(0)?))
            .map_err(|e| format!("Failed to query temp files: {}", e))?;
        let mut paths = Vec::new();
        for r in rows {
            paths.push(r.map_err(|e| format!("Failed to read temp file row: {}", e))?);
        }
        Ok(paths)
    }

    /// 清理所有临时文件（在应用启动时调用）
    pub fn cleanup_temp_files(&self) -> Result<usize, String> {
        let paths = self.get_all_temp_files()?;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut cleaned = 0;
        for path in &paths {
            // 尝试删除文件（忽略错误，因为文件可能已经被删除）
            let path_buf = PathBuf::from(path);
            if path_buf.exists() {
                if fs::remove_file(&path_buf).is_ok() {
                    cleaned += 1;
                }
            }
            // 无论文件是否存在，都从数据库中删除记录
            let _ = conn.execute("DELETE FROM temp_files WHERE path = ?1", params![path]);
        }
        Ok(cleaned)
    }
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
