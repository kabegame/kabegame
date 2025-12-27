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

// 获取应用数据目录的辅助函数
fn get_app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join("Kabegami Crawler")
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
    #[serde(default)]
    pub hash: String,
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
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn new(app: AppHandle) -> Self {
        let db_path = Self::get_db_path(&app);
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
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("Failed to create albums table");

        // 创建画册-图片映射表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS album_images (
                album_id TEXT NOT NULL,
                image_id TEXT NOT NULL,
                PRIMARY KEY (album_id, image_id)
            )",
            [],
        )
        .expect("Failed to create album_images table");

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id)",
            [],
        )
        .expect("Failed to create album_images index");

        Self {
            app,
            db: Arc::new(Mutex::new(conn)),
        }
    }

    fn get_db_path(_app: &AppHandle) -> PathBuf {
        let app_data_dir = get_app_data_dir();
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
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("images_metadata.json")
    }

    pub fn get_images_dir(&self) -> PathBuf {
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("images")
    }

    pub fn get_thumbnails_dir(&self) -> PathBuf {
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("thumbnails")
    }

    pub fn get_images_paginated(
        &self,
        page: usize,
        page_size: usize,
        plugin_id: Option<&str>,
    ) -> Result<PaginatedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 构建查询条件
        let where_clause = if let Some(pid) = plugin_id {
            format!("WHERE plugin_id = '{}'", pid.replace("'", "''"))
        } else {
            String::new()
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
        let query = format!(
            "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash 
             FROM images {} 
             ORDER BY crawled_at DESC 
             LIMIT ? OFFSET ?",
            where_clause
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
                    favorite: row.get::<_, i64>(8)? != 0,
                    hash: row.get(9)?,
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
        let result = self.get_images_paginated(0, 10000, None)?;
        Ok(result.images)
    }

    pub fn find_image_by_path(&self, local_path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let result = conn
            .query_row(
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash 
                 FROM images WHERE local_path = ?1",
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
                        favorite: row.get::<_, i64>(8)? != 0,
                        hash: row.get(9)?,
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
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash 
                 FROM images WHERE hash = ?1",
                params![hash],
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
        conn.execute(
            "INSERT INTO albums (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![id, name, created_at as i64],
        )
        .map_err(|e| format!("Failed to insert album: {}", e))?;

        Ok(Album {
            id,
            name: name.to_string(),
            created_at,
        })
    }

    pub fn get_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, name, created_at FROM albums ORDER BY created_at DESC")
            .map_err(|e| format!("Failed to prepare albums query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Album {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get::<_, i64>(2)? as u64,
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

    pub fn get_album_images(&self, album_id: &str) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.favorite, images.hash
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 WHERE album_images.album_id = ?1
                 ORDER BY images.crawled_at DESC",
            )
            .map_err(|e| format!("Failed to prepare album images query: {}", e))?;

        let rows = stmt
            .query_map(params![album_id], |row| {
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

        let mut stmt = conn
            .prepare(
                "SELECT images.id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata, COALESCE(images.thumbnail_path, ''), images.favorite, images.hash
                 FROM images
                 INNER JOIN album_images ON images.id = album_images.image_id
                 WHERE album_images.album_id = ?1
                 ORDER BY images.crawled_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare album preview query: {}", e))?;

        let rows = stmt
            .query_map(params![album_id, limit as i64], |row| {
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

        conn.execute(
            "INSERT OR REPLACE INTO images (id, url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, favorite, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash 
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
            "INSERT OR REPLACE INTO tasks (id, plugin_id, url, output_dir, user_config, status, progress, total_images, downloaded_images, start_time, end_time, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                task.id,
                task.plugin_id,
                task.url,
                task.output_dir,
                user_config_json,
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
                "SELECT id, plugin_id, url, output_dir, user_config, status, progress, total_images, downloaded_images, start_time, end_time, error
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
                        status: row.get(5)?,
                        progress: row.get(6)?,
                        total_images: row.get(7)?,
                        downloaded_images: row.get(8)?,
                        start_time: row.get::<_, Option<i64>>(9)?.map(|t| t as u64),
                        end_time: row.get::<_, Option<i64>>(10)?.map(|t| t as u64),
                        error: row.get(11)?,
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
                "SELECT id, plugin_id, url, output_dir, user_config, status, progress, total_images, downloaded_images, start_time, end_time, error
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
                    status: row.get(5)?,
                    progress: row.get(6)?,
                    total_images: row.get(7)?,
                    downloaded_images: row.get(8)?,
                    start_time: row.get::<_, Option<i64>>(9)?.map(|t| t as u64),
                    end_time: row.get::<_, Option<i64>>(10)?.map(|t| t as u64),
                    error: row.get(11)?,
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
        let user_config_json = config
            .user_config
            .as_ref()
            .and_then(|c| serde_json::to_string(c).ok());
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
                    user_config: user_config
                        .as_ref()
                        .and_then(|s| serde_json::from_str(s).ok()),
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

    pub fn get_run_config(&self, config_id: &str) -> Result<Option<RunConfig>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT id, name, description, plugin_id, url, output_dir, user_config, created_at
             FROM run_configs WHERE id = ?1",
            params![config_id],
            |row| {
                let user_config: Option<String> = row.get(6)?;
                Ok(RunConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    plugin_id: row.get(3)?,
                    url: row.get(4)?,
                    output_dir: row.get(5)?,
                    user_config: user_config
                        .as_ref()
                        .and_then(|s| serde_json::from_str(s).ok()),
                    created_at: row.get::<_, i64>(7)? as u64,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to get run_config: {}", e))
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 删除任务
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete task from database: {}", e))?;

        // 同时删除该任务关联的所有图片
        // 先查询图片信息，以便删除文件
        let query = "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash FROM images WHERE task_id = ?1";
        let mut stmt = conn
            .prepare(query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let images: Vec<ImageInfo> = stmt
            .query_map(params![task_id], |row| {
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
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read rows: {}", e))?;

        // 删除图片文件
        for image in &images {
            let path = PathBuf::from(&image.local_path);
            if path.exists() {
                let _ = fs::remove_file(&path);
            }
            if !image.thumbnail_path.is_empty() {
                let thumb = PathBuf::from(&image.thumbnail_path);
                if thumb.exists() {
                    let _ = fs::remove_file(&thumb);
                }
            }
        }

        // 从数据库删除图片记录
        for image in images.iter() {
            conn.execute(
                "DELETE FROM album_images WHERE image_id = ?1",
                params![&image.id],
            )
            .map_err(|e| format!("Failed to delete album mapping: {}", e))?;
        }
        conn.execute("DELETE FROM images WHERE task_id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete images from database: {}", e))?;

        Ok(())
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
                "SELECT id, url, local_path, plugin_id, task_id, crawled_at, metadata, COALESCE(thumbnail_path, ''), favorite, hash
                 FROM images WHERE task_id = ?1 ORDER BY crawled_at DESC
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

        conn.execute(
            "UPDATE images SET favorite = ?1 WHERE id = ?2",
            params![if favorite { 1 } else { 0 }, image_id],
        )
        .map_err(|e| format!("Failed to update image favorite: {}", e))?;

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
