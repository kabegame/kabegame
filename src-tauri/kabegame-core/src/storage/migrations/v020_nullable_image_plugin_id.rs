//! 将 `images.plugin_id` 改为可空，并清理历史畅游 host 数据。
//!
//! 早期畅游下载会把 host 写入 `images.plugin_id`，导致详情页把畅游 URL 当成插件来源。
//! 迁移后普通插件图片继续保留 plugin_id，畅游图片依赖 surf_record_id 关联来源。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE images_new (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    url                   TEXT,
    local_path            TEXT    NOT NULL,
    plugin_id             TEXT,
    task_id               TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
    surf_record_id        TEXT,
    crawled_at            INTEGER NOT NULL,
    metadata_id           INTEGER REFERENCES image_metadata(id),
    thumbnail_path        TEXT    NOT NULL DEFAULT '',
    hash                  TEXT    NOT NULL DEFAULT '',
    type                  TEXT    DEFAULT 'image',
    width                 INTEGER,
    height                INTEGER,
    display_name          TEXT    NOT NULL DEFAULT '',
    last_set_wallpaper_at INTEGER,
    size                  INTEGER,
    description           TEXT,
    compatible_path       TEXT,
    post_url              TEXT
);

INSERT INTO images_new (
    id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id,
    thumbnail_path, hash, type, width, height, display_name, last_set_wallpaper_at,
    size, description, compatible_path, post_url
)
SELECT
    id,
    url,
    local_path,
    CASE
        WHEN plugin_id IS NULL THEN NULL
        WHEN trim(plugin_id) = '' THEN NULL
        WHEN plugin_id IN (SELECT host FROM surf_records) THEN NULL
        WHEN instr(plugin_id, '.') > 0
             AND instr(plugin_id, '/') = 0
             AND instr(plugin_id, ':') = 0
             AND instr(plugin_id, ' ') = 0
        THEN NULL
        ELSE plugin_id
    END,
    task_id,
    surf_record_id,
    crawled_at,
    metadata_id,
    thumbnail_path,
    hash,
    type,
    width,
    height,
    display_name,
    last_set_wallpaper_at,
    size,
    description,
    compatible_path,
    post_url
FROM images;

DROP TABLE images;
ALTER TABLE images_new RENAME TO images;

DROP INDEX IF EXISTS idx_crawled_at;
DROP INDEX IF EXISTS idx_plugin_id;
DROP INDEX IF EXISTS idx_task_id;
DROP INDEX IF EXISTS idx_images_surf_record_id;
DROP INDEX IF EXISTS idx_images_hash;
DROP INDEX IF EXISTS idx_images_local_path;
DROP INDEX IF EXISTS idx_images_thumbnail_path;
DROP INDEX IF EXISTS idx_images_last_set_wallpaper_at;

CREATE INDEX idx_crawled_at                    ON images(crawled_at DESC);
CREATE INDEX idx_plugin_id                     ON images(plugin_id);
CREATE INDEX idx_task_id                       ON images(task_id);
CREATE INDEX idx_images_surf_record_id         ON images(surf_record_id);
CREATE INDEX idx_images_hash                   ON images(hash);
CREATE UNIQUE INDEX idx_images_local_path      ON images(local_path);
CREATE INDEX idx_images_thumbnail_path         ON images(thumbnail_path);
CREATE INDEX idx_images_last_set_wallpaper_at  ON images(last_set_wallpaper_at DESC);

COMMIT;

PRAGMA foreign_keys = ON;
"#,
    )
    .map_err(|e| format!("v020 nullable images.plugin_id: {e}"))?;
    Ok(())
}
