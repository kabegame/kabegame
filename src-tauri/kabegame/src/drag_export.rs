//! 拖拽导出授权:image id → 已授权的本地路径。
//!
//! 调用点位于 CEF UI 线程的 dragstart 同步栈,没有 tokio runtime,因此这里必须
//! 全程同步。前端只能提议 id;这里通过图库记录与磁盘状态作最终授权。

pub(crate) fn authorize_drag_image(image_id: &str) -> Option<std::path::PathBuf> {
    let info = kabegame_core::storage::Storage::find_image_by_id(image_id).ok()??;
    let path = std::path::PathBuf::from(&info.local_path);
    std::fs::metadata(&path).ok()?;
    Some(path)
}
