//! 色桶写命令的共享实现层：把颜色保存成色桶、删除用户保存的色桶。
//!
//! 读不走命令（前端观察 `color_buckets://`）。写入提交后发 `color-buckets-change`，观察方重读整张表。

use crate::emitter::GlobalEmitter;
use crate::storage::color_buckets::ColorBucket;
use crate::storage::Storage;

/// 把颜色保存成色桶。全库距离补算在阻塞线程里做，提交后才返回并发事件。
/// 失败时错误文本以 `color-bucket:<code>` 开头（`invalid` / `exists` / `limit`）。
pub async fn add_color_bucket(rgb: u32) -> Result<ColorBucket, String> {
    let bucket = tokio::task::spawn_blocking(move || Storage::global().add_color_bucket(rgb))
        .await
        .map_err(|e| format!("add_color_bucket join error: {e}"))??;
    GlobalEmitter::global().emit_color_buckets_change();
    Ok(bucket)
}

/// 删一个用户保存的色桶及其关系行，提交后发事件。
/// 失败时错误文本以 `color-bucket:<code>` 开头（`builtin` / `not-found`）。
pub async fn delete_color_bucket(rgb: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || Storage::global().delete_color_bucket(rgb))
        .await
        .map_err(|e| format!("delete_color_bucket join error: {e}"))??;
    GlobalEmitter::global().emit_color_buckets_change();
    Ok(())
}
