//! 色桶写命令。Tauri 薄包装：实现在 `commands::color_bucket`，与 Web 模式 RPC 共享。
//! 只有主窗口调用（主窗口免 ACL，登记进 `generate_handler!` 即可）。

use kabegame_core::commands;
use kabegame_core::storage::color_buckets::ColorBucket;

/// 把颜色（`0xRRGGBB` 整数）保存成色桶；返回 `{ rgb, key, position }`。
#[tauri::command]
pub async fn add_color_bucket(rgb: u32) -> Result<ColorBucket, String> {
    commands::color_bucket::add_color_bucket(rgb).await
}

/// 删一个用户保存的色桶。
#[tauri::command]
pub async fn delete_color_bucket(rgb: u32) -> Result<(), String> {
    commands::color_bucket::delete_color_bucket(rgb).await
}
