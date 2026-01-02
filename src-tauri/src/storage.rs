use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

// 收藏画册的固定ID
pub const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

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
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRemoveResult {
    pub removed: usize,
    pub removed_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaginatedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
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

pub struct Storage {
    db: Arc<Mutex<Connection>>,
}

impl Storage {
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

    pub fn new(_app: AppHandle) -> Self {
        let db_path = Self::get_db_path();
        // 确保应用数据目录存在
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).expect("Failed to create app data directory");
        }
        let mut conn = Connection::open(&db_path).expect("Failed to open database");

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

        // 创建图片表（添加 task_id 和 favorite 字段）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                local_path TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                task_id TEXT,
                crawled_at INTEGER NOT NULL,
                metadata TEXT,
                thumbnail_path TEXT NOT NULL DEFAULT '',
                favorite INTEGER NOT NULL DEFAULT 0,
                hash TEXT NOT NULL DEFAULT ''
            )",
            [],
        )
        .expect("Failed to create images table");

        // 如果表已存在但没有 favorite 字段，添加该字段
        let _ = conn.execute(
            "ALTER TABLE images ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
            [],
        );

        // 迁移：如果 images 表没有 task_id 字段，添加它
        let _ = conn.execute("ALTER TABLE images ADD COLUMN task_id TEXT", []);
        // 迁移：添加 hash 字段（如果不存在）
        let _ = conn.execute(
            "ALTER TABLE images ADD COLUMN hash TEXT NOT NULL DEFAULT ''",
            [],
        );
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE images ADD COLUMN \"order\" INTEGER", []);
        // 为现有数据设置 order（基于 crawled_at，越晚越大）
        let _ = conn.execute(
            "UPDATE images SET \"order\" = crawled_at WHERE \"order\" IS NULL",
            [],
        );

        // 迁移：确保 images.thumbnail_path 为 NOT NULL（SQLite 需要重建表才能修改列约束）
        // 若当前列允许 NULL，则创建新表并搬迁数据
        let needs_thumb_not_null_migration = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(images)")
                .expect("Failed to prepare table_info");
            let rows = stmt
                .query_map([], |row| {
                    let name: String = row.get(1)?;
                    let notnull: i64 = row.get(3)?;
                    Ok((name, notnull))
                })
                .expect("Failed to query table_info");

            let mut notnull_flag: Option<i64> = None;
            for r in rows {
                if let Ok((name, notnull)) = r {
                    if name == "thumbnail_path" {
                        notnull_flag = Some(notnull);
                        break;
                    }
                }
            }
            // notnull=1 表示 NOT NULL；None 表示列不存在（旧表结构异常），也走迁移
            notnull_flag != Some(1)
        };

        if needs_thumb_not_null_migration {
            let tx = conn
                .transaction()
                .expect("Failed to start transaction for thumbnail_path migration");

            // 新表：thumbnail_path NOT NULL DEFAULT ''
            tx.execute(
                "CREATE TABLE IF NOT EXISTS images_new (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    local_path TEXT NOT NULL,
                    plugin_id TEXT NOT NULL,
                    task_id TEXT,
                    crawled_at INTEGER NOT NULL,
                    metadata TEXT,
                    thumbnail_path TEXT NOT NULL DEFAULT '',
                    favorite INTEGER NOT NULL DEFAULT 0,
                    hash TEXT NOT NULL DEFAULT ''
                )",
                [],
            )
            .expect("Failed to create images_new");

            // 搬迁数据：thumbnail_path 为空/NULL -> local_path
            // favorite/hash/task_id 等字段使用 COALESCE 兜底，兼容历史版本缺失列的情况
            let _ = tx.execute(
                "INSERT OR REPLACE INTO images_new (
                    id, url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, favorite, hash
                 )
                 SELECT
                    id,
                    url,
                    local_path,
                    plugin_id,
                    task_id,
                    crawled_at,
                    metadata,
                    CASE
                        WHEN thumbnail_path IS NULL OR thumbnail_path = '' THEN local_path
                        ELSE thumbnail_path
                    END,
                    COALESCE(favorite, 0),
                    COALESCE(hash, '')
                 FROM images",
                [],
            );

            tx.execute("DROP TABLE images", [])
                .expect("Failed to drop old images table");
            tx.execute("ALTER TABLE images_new RENAME TO images", [])
                .expect("Failed to rename images_new");

            tx.commit()
                .expect("Failed to commit thumbnail_path migration");
        }

        // 兼容旧数据：将缩略图空值补齐为原图路径，确保前端字段必填
        let _ = conn.execute(
            "UPDATE images SET thumbnail_path = local_path WHERE thumbnail_path IS NULL OR thumbnail_path = ''",
            [],
        );

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
        // 为现有数据设置 order（基于 created_at，越晚越大）
        let _ = conn.execute(
            "UPDATE albums SET \"order\" = created_at WHERE \"order\" IS NULL",
            [],
        );

        // 创建画册-图片映射表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS album_images (
                album_id TEXT NOT NULL,
                image_id TEXT NOT NULL,
                \"order\" INTEGER,
                PRIMARY KEY (album_id, image_id)
            )",
            [],
        )
        .expect("Failed to create album_images table");
        // 迁移：添加 order 字段（如果不存在）
        let _ = conn.execute("ALTER TABLE album_images ADD COLUMN \"order\" INTEGER", []);
        // 为现有数据设置 order（基于加入时间，使用 ROWID 作为近似值，越晚越大）
        let _ = conn.execute(
            "UPDATE album_images SET \"order\" = (SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = album_images.album_id) + 1000 WHERE \"order\" IS NULL",
            [],
        );

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id)",
            [],
        )
        .expect("Failed to create album_images index");

        Self {
            db: Arc::new(Mutex::new(conn)),
        }
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
                self.add_image(image)?;
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

    pub fn get_images_paginated(
        &self,
        page: usize,
        page_size: usize,
        plugin_id: Option<&str>,
        favorites_only: Option<bool>,
    ) -> Result<PaginatedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 构建查询条件
        let mut conditions = Vec::new();
        if let Some(pid) = plugin_id {
            conditions.push(format!("plugin_id = '{}'", pid.replace("'", "''")));
        }
        if favorites_only == Some(true) {
            // 只查询在收藏画册中的图片
            conditions.push(format!(
                "id IN (SELECT image_id FROM album_images WHERE album_id = '{}')",
                FAVORITE_ALBUM_ID
            ));
        }
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        // 获取总数
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM images {}", where_clause),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query count: {}", e))?;

        // 分页查询
        let offset = page * page_size;
        // 使用 LEFT JOIN 来判断图片是否在收藏画册中
        let query = format!(
            "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.\"order\"
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             {} 
             ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC 
             LIMIT ? OFFSET ?",
            FAVORITE_ALBUM_ID, where_clause
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![page_size as i64, offset as i64], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            let image = row_result.map_err(|e| format!("Failed to read row: {}", e))?;
            // 检查文件是否存在
            if PathBuf::from(&image.local_path).exists() {
                images.push(image);
            }
        }

        Ok(PaginatedImages {
            images,
            total: total as usize,
            page,
            page_size,
        })
    }

    pub fn get_all_images(&self) -> Result<Vec<ImageInfo>, String> {
        // 为了兼容性，返回所有图片（但使用分页查询以避免内存问题）
        // 注意：如果图片很多，这可能仍然会有问题
        let result = self.get_images_paginated(0, 10000, None, None)?;
        Ok(result.images)
    }

    pub fn find_image_by_id(&self, image_id: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.id = ?1",
                params![image_id],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row
                            .get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
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
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.local_path = ?1",
                params![local_path],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false, // 稍后通过单独查询设置
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

    pub fn find_image_by_hash(&self, hash: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let result = conn
            .query_row(
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 images.\"order\"
                 FROM images
                 LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = ?
                 WHERE images.hash = ?1",
                params![FAVORITE_ALBUM_ID, hash],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: row.get::<_, i64>(9)? != 0,
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
    ) -> Result<usize, String> {
        let mut inserted = 0;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        for img_id in image_ids {
            let rows = conn
                .execute(
                    "INSERT OR IGNORE INTO album_images (album_id, image_id) VALUES (?1, ?2)",
                    params![album_id, img_id],
                )
                .map_err(|e| format!("Failed to insert album image: {}", e))?;
            inserted += rows;
        }
        Ok(inserted as usize)
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
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
                 CASE WHEN favorite_check.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 COALESCE(album_images.\"order\", (SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?2) + 1000) as album_image_order
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 LEFT JOIN album_images as favorite_check ON images.id = favorite_check.image_id AND favorite_check.album_id = ?1
                 WHERE album_images.album_id = ?2
                 ORDER BY COALESCE(album_images.\"order\", (SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?2) + 1000) ASC",
            )
            .map_err(|e| format!("Failed to prepare album images query: {}", e))?;

        let rows = stmt
            .query_map(params![FAVORITE_ALBUM_ID, album_id], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query album images: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            let image = r.map_err(|e| format!("Failed to read album image row: {}", e))?;
            if PathBuf::from(&image.local_path).exists() {
                images.push(image);
            }
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
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.hash,
                 CASE WHEN favorite_check.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 COALESCE(album_images.\"order\", (SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?2) + 1000) as album_image_order
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 LEFT JOIN album_images as favorite_check ON images.id = favorite_check.image_id AND favorite_check.album_id = ?1
                 WHERE album_images.album_id = ?2
                 ORDER BY COALESCE(album_images.\"order\", (SELECT MAX(COALESCE(\"order\", 0)) FROM album_images WHERE album_id = ?2) + 1000) ASC
                 LIMIT ?3",
            )
            .map_err(|e| format!("Failed to prepare album preview query: {}", e))?;

        let rows = stmt
            .query_map(params![FAVORITE_ALBUM_ID, album_id, limit as i64], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query album preview: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            let image = r.map_err(|e| format!("Failed to read album preview row: {}", e))?;
            if PathBuf::from(&image.local_path).exists() {
                images.push(image);
            }
        }
        Ok(images)
    }

    pub fn get_album_image_ids(&self, album_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT image_id FROM album_images WHERE album_id = ?1")
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

    pub fn add_image(&self, image: ImageInfo) -> Result<(), String> {
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
            "INSERT OR REPLACE INTO images (id, url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, favorite, hash, \"order\")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                image.id,
                image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.crawled_at as i64,
                metadata_json,
                thumbnail_path,
                if image.favorite { 1 } else { 0 },
                image.hash,
                order,
            ],
        )
        .map_err(|e| format!("Failed to insert image: {}", e))?;

        Ok(())
    }

    pub fn delete_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 先查询图片信息，以便删除文件
        let image: Option<ImageInfo> = conn
            .query_row(
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash, \"order\"
                 FROM images WHERE id = ?1",
                params![image_id],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        favorite: row.get::<_, i64>(8)? != 0,
                        hash: row.get(9)?,
                        order: row.get::<_, Option<i64>>(10)?,
                    })
                },
            )
            .ok();

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

        Ok(())
    }

    /// 移除图片（只删除缩略图和数据库记录，不删除原图）
    pub fn remove_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 先查询图片信息，以便删除缩略图
        let image: Option<ImageInfo> = conn
            .query_row(
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash, \"order\"
                 FROM images WHERE id = ?1",
                params![image_id],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        favorite: row.get::<_, i64>(8)? != 0,
                        hash: row.get(9)?,
                        order: row.get::<_, Option<i64>>(10)?,
                    })
                },
            )
            .ok();

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
    pub fn dedupe_gallery_by_hash(&self, delete_files: bool) -> Result<DedupeRemoveResult, String> {
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

        let mut removed_ids: Vec<String> = Vec::new();

        for hash in hashes {
            // 选一个要保留的 id
            let keep_id: Option<String> = tx
                .query_row(
                    "SELECT id
                     FROM images
                     WHERE hash = ?1
                     ORDER BY favorite DESC,
                              COALESCE(\"order\", crawled_at) DESC,
                              crawled_at DESC
                     LIMIT 1",
                    params![hash],
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
                    "SELECT id, COALESCE(thumbnail_path, ''), local_path
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
                    ))
                })
                .map_err(|e| format!("Failed to query dedupe remove rows: {}", e))?;

            for r in rows {
                let (id, thumb_path, local_path) =
                    r.map_err(|e| format!("Failed to read dedupe remove row: {}", e))?;

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

                removed_ids.push(id);
            }
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit dedupe transaction: {}", e))?;

        Ok(DedupeRemoveResult {
            removed: removed_ids.len(),
            removed_ids,
        })
    }

    pub fn get_total_count(&self, plugin_id: Option<&str>) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let total: i64 = if let Some(pid) = plugin_id {
            conn.query_row(
                "SELECT COUNT(*) FROM images WHERE plugin_id = ?1",
                params![pid],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query count: {}", e))?
        } else {
            conn.query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
                .map_err(|e| format!("Failed to query count: {}", e))?
        };

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
            "INSERT OR REPLACE INTO tasks (id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, start_time, end_time, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let task = conn
            .query_row(
                "SELECT id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, start_time, end_time, error
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
                        start_time: row.get::<_, Option<i64>>(10)?.map(|t| t as u64),
                        end_time: row.get::<_, Option<i64>>(11)?.map(|t| t as u64),
                        error: row.get(12)?,
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
                "SELECT id, plugin_id, url, output_dir, user_config, output_album_id, status, progress, total_images, downloaded_images, start_time, end_time, error
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
                    start_time: row.get::<_, Option<i64>>(10)?.map(|t| t as u64),
                    end_time: row.get::<_, Option<i64>>(11)?.map(|t| t as u64),
                    error: row.get(12)?,
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

    pub fn get_task_image_ids(&self, task_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id FROM images WHERE task_id = ?1")
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

        // 获取总数
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE task_id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query count: {}", e))?;

        // 分页查询
        let offset = page * page_size;
        let mut stmt = conn
            .prepare(
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash, \"order\"
                 FROM images WHERE task_id = ?1 ORDER BY COALESCE(\"order\", crawled_at) ASC
                 LIMIT ?2 OFFSET ?3"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![task_id, page_size as i64, offset as i64], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    favorite: row.get::<_, i64>(8)? != 0,
                    hash: row.get(9)?,
                    order: row.get::<_, Option<i64>>(10)?,
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            let image = row_result.map_err(|e| format!("Failed to read row: {}", e))?;
            // 检查文件是否存在
            if PathBuf::from(&image.local_path).exists() {
                images.push(image);
            }
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
