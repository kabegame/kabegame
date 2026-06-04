//! 消除「同一 local_path 多行图片」与「同一 sync_folder 多个同步画册」的设计缺陷。
//!
//! images：
//!   1. 删除 local_path 为空的脏数据（理论上不存在，仅防御）及其 album_images 关联。
//!   2. 同一 local_path 仅保留最小 id 的图片行，其余的 album_images 关联改指到保留行
//!      （INSERT OR IGNORE 避免 (album_id,image_id) 主键冲突），再删除多余图片行。
//!   3. 将 idx_images_local_path 重建为 UNIQUE。
//!
//! albums：本地文件夹同步画册尚未上线，无存量数据，直接对 sync_folder 建唯一部分索引。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
-- 1. 清理 local_path 为空的脏数据
DELETE FROM album_images
 WHERE image_id IN (SELECT id FROM images WHERE local_path IS NULL OR local_path = '');
DELETE FROM images
 WHERE local_path IS NULL OR local_path = '';

-- 2. 去重：同一 local_path 仅保留最小 id
CREATE TEMP TABLE _img_dups AS
SELECT i.id AS dup_id,
       (SELECT MIN(j.id) FROM images j WHERE j.local_path = i.local_path) AS keep_id
  FROM images i
 WHERE i.id <> (SELECT MIN(j.id) FROM images j WHERE j.local_path = i.local_path);

-- 把多余图片的画册关联改指到保留行（冲突则忽略）
INSERT OR IGNORE INTO album_images (album_id, image_id, "order")
SELECT ai.album_id, d.keep_id, ai."order"
  FROM album_images ai
  JOIN _img_dups d ON ai.image_id = d.dup_id;

DELETE FROM album_images WHERE image_id IN (SELECT dup_id FROM _img_dups);
DELETE FROM images       WHERE id       IN (SELECT dup_id FROM _img_dups);
DROP TABLE _img_dups;

-- 3. local_path 唯一索引
DROP INDEX IF EXISTS idx_images_local_path;
CREATE UNIQUE INDEX idx_images_local_path ON images(local_path);

-- 4. sync_folder 唯一部分索引（仅约束非 NULL，即本地文件夹同步画册）
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_sync_folder
    ON albums(sync_folder) WHERE sync_folder IS NOT NULL;
"#,
    )
    .map_err(|e| format!("v015 unique local_path / sync_folder: {e}"))?;
    Ok(())
}
