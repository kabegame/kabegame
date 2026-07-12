use rusqlite::Connection;

/// metadata 迁移单一化：`image_metadata.version`（旧的每插件迁移计数器）改为
/// `plugin_version`（图片下载时的插件版本，packed u32：每字节一段，3.4.1 → 0x00030401）。
/// 旧计数器值在新语义下无意义，统一归 0（「待迁移」），由迁移 runner 收敛到 packed 值。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE image_metadata RENAME COLUMN version TO plugin_version;
UPDATE image_metadata SET plugin_version = 0;
COMMIT;
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v021 image_metadata plugin_version: {e}")
    })
}
