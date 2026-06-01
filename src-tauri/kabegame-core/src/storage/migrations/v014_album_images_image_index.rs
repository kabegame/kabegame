use rusqlite::Connection;

/// 为 `album_images.image_id` 建立单列索引。
///
/// 此前仅有复合主键 `(album_id, image_id)` 与 `idx_album_images_album(album_id)`，
/// 二者均以 `album_id` 为前导列。Gallery 的 “未加入画册” 过滤需要按 `image_id`
/// 反查（`album_id <> hidden`，非固定值），无可用索引会导致每行全表扫描，查询
/// 耗时数秒。补上 `image_id` 索引后该反连接（LEFT JOIN + IS NULL）可走索引。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_album_images_image ON album_images(image_id);",
    )
    .map_err(|e| format!("v014 create idx_album_images_image: {e}"))
}
