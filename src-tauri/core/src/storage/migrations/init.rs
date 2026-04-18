//! v7 最终 schema 的全量建表定义。
//!
//! 仅用于全新安装（is_new_db = true）时直接建出完整数据库，不含任何 ALTER TABLE
//! 或条件性迁移逻辑。
//!
//! 历史说明：4.0 之前，建表逻辑散落于 `storage::mod` 的 `new()` 函数（大量
//! CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN + 条件 has_column 判断），
//! 以及 `perform_complex_migrations()`（事务性重建 images/albums 等表）。
//! 这些代码在 v4.0 中统一迁移至此处，旧代码随版本号一并删除。

use rusqlite::Connection;

/// 为全新数据库建出 v7 的完整 schema（含全部表与索引）。
///
/// **仅在 `is_new_db = true` 时调用**，已有数据库由 `migrations::run_pending` 处理。
pub fn create_all_tables(conn: &Connection) {
    conn.execute_batch(
        r#"
-- ───────────── tasks ─────────────
CREATE TABLE tasks (
    id              TEXT    PRIMARY KEY,
    plugin_id       TEXT    NOT NULL,
    output_dir      TEXT,
    user_config     TEXT,
    http_headers    TEXT,
    output_album_id TEXT,
    run_config_id   TEXT,
    trigger_source  TEXT    NOT NULL DEFAULT 'manual',
    status          TEXT    NOT NULL,
    progress        REAL    NOT NULL DEFAULT 0,
    deleted_count   INTEGER NOT NULL DEFAULT 0,
    dedup_count     INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    start_time      INTEGER,
    end_time        INTEGER,
    error           TEXT
);
CREATE INDEX idx_tasks_start_time ON tasks(start_time DESC);

-- ───────────── image_metadata ─────────────
CREATE TABLE image_metadata (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    data         TEXT    NOT NULL,
    content_hash TEXT    NOT NULL UNIQUE
);

-- ───────────── images ─────────────
CREATE TABLE images (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    url                   TEXT,
    local_path            TEXT    NOT NULL,
    plugin_id             TEXT    NOT NULL,
    task_id               TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
    surf_record_id        TEXT,
    crawled_at            INTEGER NOT NULL,
    metadata              TEXT,
    metadata_id           INTEGER REFERENCES image_metadata(id),
    thumbnail_path        TEXT    NOT NULL DEFAULT '',
    hash                  TEXT    NOT NULL DEFAULT '',
    type                  TEXT    DEFAULT 'image',
    width                 INTEGER,
    height                INTEGER,
    display_name          TEXT    NOT NULL DEFAULT '',
    last_set_wallpaper_at INTEGER,
    size                  INTEGER,
    description           TEXT
);
CREATE INDEX idx_crawled_at                    ON images(crawled_at DESC);
CREATE INDEX idx_plugin_id                     ON images(plugin_id);
CREATE INDEX idx_task_id                       ON images(task_id);
CREATE INDEX idx_images_surf_record_id         ON images(surf_record_id);
CREATE INDEX idx_images_hash                   ON images(hash);
CREATE INDEX idx_images_local_path             ON images(local_path);
CREATE INDEX idx_images_thumbnail_path         ON images(thumbnail_path);
CREATE INDEX idx_images_last_set_wallpaper_at  ON images(last_set_wallpaper_at DESC);

-- ───────────── albums ─────────────
CREATE TABLE albums (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    parent_id  TEXT    REFERENCES albums(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_albums_name_scoped
    ON albums(COALESCE(parent_id, ''), LOWER(name));

-- ───────────── album_images ─────────────
CREATE TABLE album_images (
    album_id TEXT    NOT NULL,
    image_id INTEGER NOT NULL,
    "order"  INTEGER,
    PRIMARY KEY (album_id, image_id)
);
CREATE INDEX idx_album_images_album ON album_images(album_id);

-- ───────────── task_failed_images ─────────────
CREATE TABLE task_failed_images (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT    NOT NULL,
    plugin_id         TEXT    NOT NULL,
    url               TEXT    NOT NULL,
    "order"           INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    last_error        TEXT,
    last_attempted_at INTEGER,
    metadata_id       INTEGER REFERENCES image_metadata(id),
    header_snapshot   TEXT
);
CREATE INDEX idx_task_failed_images_task ON task_failed_images(task_id);

-- ───────────── run_configs ─────────────
CREATE TABLE run_configs (
    id                   TEXT    PRIMARY KEY,
    name                 TEXT    NOT NULL,
    description          TEXT,
    plugin_id            TEXT    NOT NULL,
    url                  TEXT    NOT NULL,
    output_dir           TEXT,
    user_config          TEXT,
    http_headers         TEXT,
    created_at           INTEGER NOT NULL,
    schedule_enabled     INTEGER NOT NULL DEFAULT 0,
    schedule_spec        TEXT,
    schedule_planned_at  INTEGER,
    schedule_last_run_at INTEGER
);

-- ───────────── surf_records ─────────────
CREATE TABLE surf_records (
    id             TEXT    PRIMARY KEY,
    host           TEXT    NOT NULL UNIQUE,
    root_url       TEXT    NOT NULL,
    icon           BLOB,
    last_visit_at  INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    deleted_count  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    name           TEXT    NOT NULL DEFAULT '',
    cookie         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_surf_records_host       ON surf_records(host);
CREATE INDEX idx_surf_records_last_visit ON surf_records(last_visit_at DESC);

-- ───────────── plugin_sources ─────────────
CREATE TABLE plugin_sources (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    index_url  TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ───────────── plugin_source_cache ─────────────
CREATE TABLE plugin_source_cache (
    source_id    TEXT    PRIMARY KEY,
    json_content TEXT    NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (source_id) REFERENCES plugin_sources(id) ON DELETE CASCADE
);

-- ───────────── task_logs ─────────────
CREATE TABLE task_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT    NOT NULL,
    level   TEXT    NOT NULL,
    content TEXT    NOT NULL,
    time    INTEGER NOT NULL
);
CREATE INDEX idx_task_logs_task_id ON task_logs(task_id);
        "#,
    )
    .expect("Failed to create initial database schema");
}
