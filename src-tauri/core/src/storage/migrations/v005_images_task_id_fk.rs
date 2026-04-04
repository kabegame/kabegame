use rusqlite::Connection;

/// v4 → v5：为 `images.task_id` 添加外键 `REFERENCES tasks(id) ON DELETE SET NULL`（需重建表）。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys=OFF;
        BEGIN;
        CREATE TABLE images_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT,
            local_path TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            surf_record_id TEXT,
            crawled_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_id INTEGER REFERENCES image_metadata(id),
            thumbnail_path TEXT NOT NULL DEFAULT '',
            hash TEXT NOT NULL DEFAULT '',
            type TEXT DEFAULT 'image',
            width INTEGER,
            height INTEGER,
            display_name TEXT NOT NULL DEFAULT '',
            last_set_wallpaper_at INTEGER,
            size INTEGER,
            description TEXT
        );
        INSERT INTO images_new (
            id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata,
            metadata_id, thumbnail_path, hash, type, width, height, display_name,
            last_set_wallpaper_at, size, description
        )
        SELECT
            id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata,
            metadata_id, thumbnail_path, hash, type, width, height, display_name,
            last_set_wallpaper_at, size, description
        FROM images;
        DROP TABLE images;
        ALTER TABLE images_new RENAME TO images;
        CREATE INDEX IF NOT EXISTS idx_crawled_at ON images(crawled_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plugin_id ON images(plugin_id);
        CREATE INDEX IF NOT EXISTS idx_task_id ON images(task_id);
        CREATE INDEX IF NOT EXISTS idx_images_surf_record_id ON images(surf_record_id);
        CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);
        CREATE INDEX IF NOT EXISTS idx_images_local_path ON images(local_path);
        CREATE INDEX IF NOT EXISTS idx_images_thumbnail_path ON images(thumbnail_path);
        CREATE INDEX IF NOT EXISTS idx_images_last_set_wallpaper_at ON images(last_set_wallpaper_at DESC);
        COMMIT;
        PRAGMA foreign_keys=ON;
        "#,
    )
    .map_err(|e| format!("v005: images task_id FK migration failed: {}", e))?;
    Ok(())
}
