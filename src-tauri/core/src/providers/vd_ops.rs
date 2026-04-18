//! 虚拟盘（virtual-driver feature）专用：可写操作的辅助函数。
//!
//! 约束：
//! - 仅用于 core/providers 的 VD 方法实现（mkdir/delete/说明文件等）。
//! - Dokan/挂载/Windows 句柄等实现细节在 app-main。

use std::hash::{Hash, Hasher};
use std::path::PathBuf;

// === 说明文件（VD 专用）===

#[cfg(not(target_os = "android"))]
fn note_dir() -> PathBuf {
    crate::app_paths::AppPaths::global().virtual_driver_notes()
}

fn note_id_for_name(name: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    let mut h = DefaultHasher::new();
    name.hash(&mut h);
    format!("{}", h.finish())
}

pub(crate) fn ensure_note_file(
    display_name: &str,
    content: &str,
) -> Result<(String, PathBuf), String> {
    let dir = note_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建虚拟盘说明文件目录失败: {}", e))?;

    let id = note_id_for_name(display_name);
    let path = dir.join(format!("{}.txt", &id));
    if !path.exists() {
        // Windows/Explorer 对 CRLF 更友好
        let mut text = content.replace('\n', "\r\n");
        if !text.ends_with("\r\n") {
            text.push_str("\r\n");
        }
        std::fs::write(&path, text).map_err(|e| format!("写入虚拟盘说明文件失败: {}", e))?;
    }
    Ok((id, path))
}
