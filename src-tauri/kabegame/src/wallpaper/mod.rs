pub mod manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod ping;
pub mod rotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod window;
#[cfg(target_os = "macos")]
pub mod window_mount_macos;
// 桌面网页壁纸（x-wpe/web）的 Windows 桌面鼠标转发
#[cfg(target_os = "windows")]
pub mod input_forward;

// 轮播器
pub use rotator::WallpaperRotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use window::WallpaperWindow;

// 蟇ｼ蜃ｺ邂｡逅・勣邀ｻ蝙・
pub use manager::WallpaperController;

use kabegame_core::wpe::{read_project, WpeKind};
use std::path::{Path, PathBuf};
use url::Url;

/// `path` 若是网页壁纸（`x-wpe/web`）目录，解析出规范化目录与入口的 `file://` URL；其它路径返回 `None`。
///
/// 桌面壁纸窗口（`WindowWallpaperManager::set_wallpaper_path` 据此整窗导航）与图库预览
/// （`set_wpe_web_preview` 据此设根目录并返回入口，前端给 `file:` iframe 赋 `src`）共用这一份算法。
/// WPE 网页壁纸暂只支持 Windows：其它平台恒为 `Ok(None)`，壁纸窗口停在应用页、预览退回作者预览图。
///
/// 只读一个小的 `project.json`，不 await，调用方可在锁内同步执行。
// 调用方是窗口模式壁纸管理器（Windows / macOS 才编译）与预览命令（Windows），其它平台没有调用方。
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub(crate) fn web_entry(path: &Path) -> Result<Option<(PathBuf, Url)>, String> {
    web_entry_on_platform(cfg!(target_os = "windows"), path)
}

/// [`web_entry`] 的本体：平台是否支持作参数传入，单测在任一平台都能覆盖两个分支。
fn web_entry_on_platform(supported: bool, path: &Path) -> Result<Option<(PathBuf, Url)>, String> {
    if !supported || !path.is_dir() {
        return Ok(None);
    }
    // read_project 校验 `file` 是目录内相对路径（拒绝越界）且入口存在。
    let project = read_project(path).map_err(|skip| {
        format!(
            "无法加载 Wallpaper Engine 壁纸 {}: {}",
            path.display(),
            skip.message()
        )
    })?;
    if project.kind != WpeKind::Web {
        return Ok(None);
    }
    let entry = project
        .entry_path()
        .ok_or_else(|| format!("网页壁纸没有入口文件: {}", path.display()))?;
    let entry = Url::from_file_path(&entry)
        .map_err(|()| format!("网页壁纸入口不是绝对路径: {}", entry.display()))?;
    Ok(Some((project.dir, entry)))
}

#[cfg(test)]
mod tests {
    use super::web_entry_on_platform;
    use std::fs;
    use std::path::PathBuf;

    /// 临时目录：`<tmp>/kabegame-web-entry-<name>-<pid>/`，写入 `project.json` 与入口文件。
    fn fixture(name: &str, kind: &str, file: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kabegame-web-entry-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("project.json"),
            format!(r#"{{ "type": "{kind}", "file": "{file}", "title": "t" }}"#),
        )
        .unwrap();
        fs::write(dir.join(file), "x").unwrap();
        dir
    }

    #[test]
    fn web_entry_resolves_file_url_when_supported() {
        let dir = fixture("web", "Web", "index.html");
        let (root, entry) = web_entry_on_platform(true, &dir)
            .unwrap()
            .expect("网页壁纸应有入口");
        assert_eq!(entry.scheme(), "file");
        assert!(entry.path().ends_with("/index.html"), "{entry}");
        assert_eq!(entry.to_file_path().unwrap(), root.join("index.html"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn web_entry_is_none_on_unsupported_platform() {
        // 非 Windows 分支：同一个网页壁纸目录也不给入口（不读 project.json）
        let dir = fixture("unsupported", "web", "index.html");
        assert_eq!(web_entry_on_platform(false, &dir), Ok(None));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn web_entry_ignores_files_and_other_kinds() {
        let dir = fixture("video", "video", "a.mp4");
        assert_eq!(web_entry_on_platform(true, &dir), Ok(None));
        // 普通文件路径（图片 / 视频壁纸）不是目录
        assert_eq!(web_entry_on_platform(true, &dir.join("a.mp4")), Ok(None));
        let _ = fs::remove_dir_all(dir);
    }
}
