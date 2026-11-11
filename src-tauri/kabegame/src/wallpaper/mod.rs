pub mod manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod ping;
pub mod rotator;
// 显示器枚举与热插拔 watcher（目前只有 macOS 有平台实现，其余平台列表恒为空）
pub mod screens;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod window;
#[cfg(target_os = "macos")]
pub mod window_mount_macos;
// 桌面网页 / 场景壁纸的桌面鼠标转发
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod input_forward;
// 网页壁纸目录索引：file: 闸门与 wpe_web_pull_state 的数据源
#[cfg(feature = "wpe")]
pub mod wpe_web_dir_index;
// 场景宿主（apps/wpe-scene 的 file: iframe）：地址、file: 访问范围与运行时 capability
#[cfg(feature = "wpe")]
pub mod wpe_scene_host;

// 轮播器
pub use rotator::WallpaperRotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use window::WallpaperWindow;

// 蟇ｼ蜃ｺ邂｡逅・勣邀ｻ蝙・
pub use manager::WallpaperController;

use kabegame_core::wpe::{read_project, WpeKind};
use std::path::{Path, PathBuf};
use url::Url;

/// 壁纸窗口的 label 池：窗口模式下每块在线屏一个窗口，label 从这里取（先到先得，同一块屏在窗口存续期间不换）。
///
/// 用固定池而不是按屏动态起名：ACL 特赦（`Builder::acl_exempt_webview`）在 Builder 期登记，capability 的窗口列表
/// 也是静态的。超过 8 块屏只给前 8 块开窗口。本常量在没有窗口模式的平台上也编译：`lib.rs` 的特赦登记与
/// 场景宿主 capability 都要用它，多登记几个不存在的 label 没有影响。
///
/// 新增或改名时同步 `capabilities/main.json(.handlebars)`、`capabilities/wpe-web.json` 的 `windows`
/// （有单测比对）。
pub const WALLPAPER_LABELS: [&str; 8] = [
    "wallpaper",
    "wallpaper-1",
    "wallpaper-2",
    "wallpaper-3",
    "wallpaper-4",
    "wallpaper-5",
    "wallpaper-6",
    "wallpaper-7",
];

/// `label` 是不是壁纸窗口。凡是按 label 判断「调用方 / 这个窗口是不是壁纸窗口」的地方都用它。
pub fn is_wallpaper_label(label: &str) -> bool {
    WALLPAPER_LABELS.contains(&label)
}

/// `path` 若是网页壁纸（`x-wpe/web`）目录，解析出规范化目录与入口的 `file://` URL；其它路径返回 `None`。
///
/// 壁纸目标（`commands::wallpaper::build_wallpaper_target` 据此给出 `webEntry`，图库预览与桌面壁纸窗口的
/// `WallpaperStage` 拿同一份目标给 `file:` iframe 赋 `src`）与窗口模式壁纸管理器（据此开关鼠标转发）共用
/// 这一份算法。关闭 `wpe` feature 的构建（Android）恒为 `Ok(None)`，预览退回作者预览图。
///
/// 只读一个小的 `project.json`，不 await，调用方可在锁内同步执行。
pub(crate) fn web_entry(path: &Path) -> Result<Option<(PathBuf, Url)>, String> {
    web_entry_on_platform(cfg!(feature = "wpe"), path)
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
    use super::{is_wallpaper_label, web_entry_on_platform, WALLPAPER_LABELS};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn wallpaper_labels_are_a_fixed_pool() {
        assert_eq!(WALLPAPER_LABELS[0], "wallpaper");
        for (index, label) in WALLPAPER_LABELS.iter().enumerate().skip(1) {
            assert_eq!(*label, format!("wallpaper-{index}"));
        }
        assert!(is_wallpaper_label("wallpaper"));
        assert!(is_wallpaper_label("wallpaper-7"));
        assert!(!is_wallpaper_label("wallpaper-8"));
        assert!(!is_wallpaper_label("main"));
        assert!(!is_wallpaper_label("wallpaper-"));
    }

    /// 静态 capability 里的窗口列表必须覆盖整个池（主窗口另算）：池里的窗口少了哪个，那个窗口的插件权限
    /// 或网页壁纸 iframe 的 IPC 就会被 ACL 拒绝。
    #[test]
    fn capability_files_list_every_wallpaper_label() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        // main.json 由 main.json.handlebars 生成，两份都要查；生成物可能不在（未跑过构建），不在就跳过
        for name in ["main.json.handlebars", "main.json", "wpe-web.json"] {
            let Ok(text) = fs::read_to_string(dir.join(name)) else {
                assert_ne!(name, "main.json.handlebars", "模板必须存在");
                continue;
            };
            let line = text
                .lines()
                .find(|line| line.trim_start().starts_with("\"windows\""))
                .unwrap_or_else(|| panic!("{name} 没有 windows 列表"));
            let listed: Vec<&str> = line
                .split('"')
                .skip(3)
                .step_by(2)
                .filter(|label| *label != "main")
                .collect();
            assert_eq!(listed, WALLPAPER_LABELS, "{name}");
        }
    }

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
        // 关闭 wpe feature 的分支：同一个网页壁纸目录也不给入口（不读 project.json）
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
