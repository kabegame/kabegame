//! 拖拽导出授权:image id → 已授权的本地路径。
//!
//! 调用点位于 CEF UI 线程的 dragstart 同步栈,没有 tokio runtime,因此这里必须
//! 全程同步。前端只能提议 id;这里通过图库记录与磁盘状态作最终授权。

use std::path::PathBuf;

pub(crate) fn authorize_drag_image(image_id: &str) -> Option<PathBuf> {
    let info = kabegame_core::storage::Storage::find_image_by_id(image_id).ok()??;
    authorized_file_path(PathBuf::from(&info.local_path))
}

/// 只放行磁盘上存在的普通文件。
///
/// `x-wpe/*` 行的 `local_path` 是 Wallpaper Engine 壁纸**目录**,不得拖出:前端对这类行
/// `draggable=false` 只是第一道闸,伪造 id 的拖拽仍会走到这里。`metadata` 跟随符号链接,
/// 指向普通文件的链接照常放行。
fn authorized_file_path(path: PathBuf) -> Option<PathBuf> {
    std::fs::metadata(&path).ok()?.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::authorized_file_path;

    /// 每个用例一个独立临时目录,结束时清掉。
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "kabegame-drag-export-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn directory_is_rejected() {
        let dir = scratch_dir("dir");
        assert_eq!(authorized_file_path(dir.clone()), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regular_file_is_allowed() {
        let dir = scratch_dir("file");
        let file = dir.join("image.jpg");
        std::fs::write(&file, b"not really a jpeg").expect("write file");
        assert_eq!(authorized_file_path(file.clone()), Some(file));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_path_is_rejected() {
        let dir = scratch_dir("missing");
        assert_eq!(authorized_file_path(dir.join("gone.jpg")), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
