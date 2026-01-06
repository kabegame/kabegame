use crate::storage::{DebugCloneImagesResult, Storage};

/// 调试命令：批量克隆图片记录，生成大量测试数据（仅开发构建可用）。
#[tauri::command]
pub async fn debug_clone_images(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    count: usize,
    pool_size: Option<usize>,
    seed: Option<u64>,
) -> Result<DebugCloneImagesResult, String> {
    let pool_size = pool_size.unwrap_or(2000);
    let storage = storage.inner().clone();
    let app = app.clone();

    // 放到阻塞线程执行，避免卡住 Tauri 主线程
    tokio::task::spawn_blocking(move || storage.debug_clone_images(app, count, pool_size, seed))
        .await
        .map_err(|e| format!("debug_clone_images task join error: {}", e))?
}


