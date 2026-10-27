//! Wallpaper Engine（WPE）壁纸目录的发现、识别、解析与属性换算。
//!
//! 一个 WPE 壁纸是**目录**而非单个文件：`project.json` 描述类型（`video` / `web` /
//! `scene` / `application`）、入口文件、预览图、标题与标签。Kabegame 把整个目录作为
//! 一行 `images` 记录，`local_path` 存目录绝对路径，`type` 存 `x-wpe/<kind>`。
//!
//! 本模块只做只读解析与目录展开，不写库、不复制或转码用户目录里的任何文件。

pub mod discover;
pub mod project;
pub mod properties;
pub mod recognize;
pub mod scan;

pub use project::{read_project, WpeKind, WpeProject, WpeSkip, WPE_PROJECT_FILE};

/// 内建「壁纸」导入任务 / 插件 id。
pub const WPE_IMPORT_PLUGIN_ID: &str = "wpe-import";

use std::path::{Path, PathBuf};

/// 把 WPE 目录规范成入库用的 `local_path`：绝对、规范化、无 Windows `\\?\` 前缀、无尾分隔符。
pub fn normalize_local_dir(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let text = canonical.to_string_lossy();
    let trimmed = text.trim_start_matches(r"\\?\");
    let trimmed = trimmed.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// 目录内相对路径的安全校验：拒绝绝对路径、盘符、`..` 与空段。
///
/// WPE 的 `file` / `preview` 必须是目录内相对路径；媒体服务按它拼目录并再次做
/// canonicalize 边界校验，这里是第一道门。
pub fn is_safe_relative_path(rel: &str) -> bool {
    let rel = rel.trim();
    if rel.is_empty() {
        return false;
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return false;
    }
    use std::path::Component;
    path.components().all(|component| {
        matches!(
            component,
            Component::Normal(_) | Component::CurDir
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_reject_traversal_and_absolute() {
        assert!(is_safe_relative_path("Wallpaper-1.mp4"));
        assert!(is_safe_relative_path("video/entry.mp4"));
        assert!(!is_safe_relative_path("../outside.mp4"));
        assert!(!is_safe_relative_path("video/../../outside.mp4"));
        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path(r"C:\Windows\notepad.exe"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path(r"\\server\share\a.mp4"));
    }
}
