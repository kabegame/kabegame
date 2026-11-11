//! macOS 原生壁纸：`NSWorkspace` 逐屏设桌面图片。
//!
//! - 入口是 `NSWorkspace.setDesktopImageURL(_:for:options:)`，一次只设一块屏；「所有屏同一张」就是对每块屏各调一次。
//! - 屏按持久标识（display UUID，即 `ScreenInfo::id`）在主线程上现查 `NSScreen`
//!   （`screens::find_ns_screen`，与枚举是同一条对应路径；`NSScreen` 对象热插拔后会失效，不缓存）。
//! - 设图本身在**调用线程**上做，不在主线程：这个调用要等系统的壁纸服务，实测一次 0.6 s 上下、偶尔过 1 s，
//!   放在主线程会把整个应用界面卡住这么久（每块屏一次）。主线程只负责查屏与最后释放屏对象，见 [`ScreenRef`]。
//! - 样式是这次调用带的选项，**逐屏**生效，系统按屏记住；见 [`options_for_style`]。
//! - 只改该屏**当前 Space** 的桌面图片：别的 Space 仍是它们各自原来的图（系统 API 的限制）。
//! - 系统对文件类型不挑：视频、目录也会被接受且不报错（桌面图片被指到一个它画不出来的东西上），
//!   所以交给系统之前先过 [`can_display`]。

use std::path::{Path, PathBuf};

use dispatch2::run_on_main;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2_app_kit::{
    NSColor, NSScreen, NSWorkspace, NSWorkspaceDesktopImageAllowClippingKey,
    NSWorkspaceDesktopImageFillColorKey, NSWorkspaceDesktopImageScalingKey,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::wallpaper::screens;

/// 原生模式在 macOS 上提供的样式，顺序即能力表里的顺序（第一项是归一化的兜底）。
/// 没有平铺：`NSWorkspace` 的缩放选项里没有对应项。
pub(super) const STYLES: [&str; 4] = ["fill", "fit", "stretch", "center"];

/// `NSImageScaling` 的取值（AppKit `NSCell.h`）：`NSImageScaleAxesIndependently`。
const SCALE_AXES_INDEPENDENTLY: usize = 1;
/// `NSImageScaleNone`。
const SCALE_NONE: usize = 2;
/// `NSImageScaleProportionallyUpOrDown`。
const SCALE_PROPORTIONALLY_UP_OR_DOWN: usize = 3;

/// 一次设桌面图片带的缩放选项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DesktopImageOptions {
    /// `NSWorkspaceDesktopImageScalingKey` 的值（`NSImageScaling`）
    pub scaling: usize,
    /// `NSWorkspaceDesktopImageAllowClippingKey` 的值；只对等比缩放有意义，其它缩放方式不带这个键
    /// （带了系统也不记，读回时没有）
    pub allow_clipping: Option<bool>,
}

/// 样式 → 桌面图片选项（纯函数）。macOS 26 实测四种读回的选项各不相同：
///
/// | 样式 | 缩放 | 允许裁剪 |
/// | --- | --- | --- |
/// | `fill` | 等比（3） | 是：盖满屏幕，多出的裁掉 |
/// | `fit` | 等比（3） | 否：完整显示，留边用填充色 |
/// | `stretch` | 两轴各自缩放（1） | — |
/// | `center` | 不缩放（2） | — |
///
/// 不认识的样式（如窗口模式才有的 `tile`）按 `fill`。`NSImageScaleProportionallyDown`（0）不用：
/// 系统把它记成等比 + 允许裁剪，与 `fill` 没有区别。
pub(super) fn options_for_style(style: &str) -> DesktopImageOptions {
    match style {
        "fit" => DesktopImageOptions {
            scaling: SCALE_PROPORTIONALLY_UP_OR_DOWN,
            allow_clipping: Some(false),
        },
        "stretch" => DesktopImageOptions {
            scaling: SCALE_AXES_INDEPENDENTLY,
            allow_clipping: None,
        },
        "center" => DesktopImageOptions {
            scaling: SCALE_NONE,
            allow_clipping: None,
        },
        _ => DesktopImageOptions {
            scaling: SCALE_PROPORTIONALLY_UP_OR_DOWN,
            allow_clipping: Some(true),
        },
    }
}

/// 原生模式能不能显示这个路径：只有静态图片文件。视频与目录型 WPE 壁纸只在窗口模式有内容。
///
/// 设单张与轮播在更早的地方就拦掉了它们，走到后端的是切壁纸模式、启动恢复时目标里留着的旧壁纸；
/// 这时不交给系统、保持桌面图片现状（原先的 osascript 路径下系统也是默默不理）。
pub(super) fn can_display(path: &Path) -> bool {
    !path.is_dir() && !kabegame_core::media::image_type::is_video_by_path(path)
}

/// 交给系统的文件路径：必须存在；取绝对路径（取不到就用原样）。
fn resolve_file(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }
    Ok(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}

/// 给一块 `NSScreen` 设桌面图片。留边（`fit` / `center`）用黑色填充。
fn apply(screen: &NSScreen, path: &Path, options: DesktopImageOptions) -> Result<(), String> {
    let url = NSURL::from_file_path(path)
        .ok_or_else(|| format!("路径不能转成文件 URL: {}", path.display()))?;
    let scaling = NSNumber::numberWithUnsignedInteger(options.scaling);
    let fill_color = NSColor::blackColor();
    let allow_clipping = options.allow_clipping.map(NSNumber::numberWithBool);

    // SAFETY: 三个键是 AppKit 导出的常量 NSString，进程存续期间有效
    let (scaling_key, fill_color_key, allow_clipping_key) = unsafe {
        (
            NSWorkspaceDesktopImageScalingKey,
            NSWorkspaceDesktopImageFillColorKey,
            NSWorkspaceDesktopImageAllowClippingKey,
        )
    };
    let scaling_value: &AnyObject = &scaling;
    let fill_color_value: &AnyObject = &fill_color;
    let mut keys: Vec<&NSString> = vec![scaling_key, fill_color_key];
    let mut values: Vec<&AnyObject> = vec![scaling_value, fill_color_value];
    if let Some(allow_clipping) = &allow_clipping {
        let allow_clipping_value: &AnyObject = allow_clipping;
        keys.push(allow_clipping_key);
        values.push(allow_clipping_value);
    }
    let options = NSDictionary::from_slices(&keys, &values);

    // SAFETY: 选项字典的值类型与各键约定的一致（缩放 / 裁剪是 NSNumber，填充色是 NSColor）
    unsafe {
        NSWorkspace::sharedWorkspace()
            .setDesktopImageURL_forScreen_options_error(&url, screen, &options)
    }
    .map_err(|error| format!("设置桌面图片失败: {}", error.localizedDescription()))
}

/// 主线程上查到的 `NSScreen`，带到调用线程去设桌面图片。
///
/// `NSScreen` 标注为只能在主线程用，所以它只在主线程上取得（[`ScreenRef::find`] / [`ScreenRef::all`]）、
/// 也送回主线程释放（[`ScreenRef::release`]）；在调用线程上只把它原样传给
/// `-[NSWorkspace setDesktopImageURL:forScreen:options:error:]`，不读写它的任何属性。
struct ScreenRef(Retained<NSScreen>);

// SAFETY: 见类型说明——跨线程期间只做「传给 NSWorkspace 当参数」这一件事；`NSScreen` 是系统在显示器重排时
// 整个换掉、而不是就地修改的描述对象，`NSWorkspace` 本身没有主线程限制。引用计数的增减是线程安全的，
// 最后一次释放放回主线程做。
unsafe impl Send for ScreenRef {}

impl ScreenRef {
    /// 按屏的持久标识现查；屏不在线为 None。
    fn find(screen_id: &str) -> Option<Self> {
        run_on_main(|mtm| screens::find_ns_screen(mtm, screen_id).map(ScreenRef))
    }

    /// 系统当前的每一块屏。
    fn all() -> Vec<Self> {
        run_on_main(|mtm| {
            NSScreen::screens(mtm)
                .to_vec()
                .into_iter()
                .map(ScreenRef)
                .collect()
        })
    }

    /// 用完送回主线程释放。
    fn release(screens: Vec<Self>) {
        run_on_main(move |_| drop(screens));
    }
}

/// 把 `path` 设为屏 `screen_id`（display UUID）的桌面图片，样式为 `style`。只动这一块屏。
///
/// 会阻塞到系统设完为止（见模块说明），不要在主线程或异步运行时的工作线程上直接调用。屏不在线时报错。
pub(super) fn set_desktop_image(screen_id: &str, path: &Path, style: &str) -> Result<(), String> {
    let path = resolve_file(path)?;
    let options = options_for_style(style);
    let screen = ScreenRef::find(screen_id).ok_or_else(|| format!("显示器不在线: {screen_id}"))?;
    let result = autoreleasepool(|_| apply(&screen.0, &path, options));
    ScreenRef::release(vec![screen]);
    result?;
    tracing::debug!(
        "原生壁纸已设置: 屏 {screen_id} ← {}（{style}）",
        path.display()
    );
    Ok(())
}

/// 把 `path` 设为系统当前**每一块**屏的桌面图片。只在没有屏幕信息（显示器枚举还没填充或失败）时兜底用：
/// 这时没有屏 id 可按，直接走一遍 `NSScreen.screens`。阻塞约定同 [`set_desktop_image`]。
pub(super) fn set_desktop_image_on_every_screen(path: &Path, style: &str) -> Result<(), String> {
    let path = resolve_file(path)?;
    let options = options_for_style(style);
    let screens = ScreenRef::all();
    let result = autoreleasepool(|_| {
        screens
            .iter()
            .try_for_each(|screen| apply(&screen.0, &path, options))
    });
    let count = screens.len();
    ScreenRef::release(screens);
    result?;
    tracing::debug!(
        "原生壁纸已设置: 系统当前的 {count} 块屏 ← {}（{style}）",
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_style_maps_to_distinct_options() {
        assert_eq!(
            options_for_style("fill"),
            DesktopImageOptions {
                scaling: 3,
                allow_clipping: Some(true)
            }
        );
        assert_eq!(
            options_for_style("fit"),
            DesktopImageOptions {
                scaling: 3,
                allow_clipping: Some(false)
            }
        );
        assert_eq!(
            options_for_style("stretch"),
            DesktopImageOptions {
                scaling: 1,
                allow_clipping: None
            }
        );
        assert_eq!(
            options_for_style("center"),
            DesktopImageOptions {
                scaling: 2,
                allow_clipping: None
            }
        );
        // 能力表里的每种样式选项都不同，否则两种样式在系统里没有区别
        for (index, a) in STYLES.iter().enumerate() {
            for b in &STYLES[index + 1..] {
                assert_ne!(options_for_style(a), options_for_style(b), "{a} / {b}");
            }
        }
    }

    #[test]
    fn unknown_style_falls_back_to_fill() {
        // 窗口模式才有的平铺、空串、乱写的值
        for style in ["tile", "", "cover"] {
            assert_eq!(options_for_style(style), options_for_style("fill"));
        }
        assert_eq!(STYLES[0], "fill");
    }

    #[test]
    fn only_static_image_files_are_displayable() {
        // 按扩展名判断，文件不必存在
        assert!(can_display(Path::new("/pictures/a.jpg")));
        assert!(can_display(Path::new("/pictures/a.webp")));
        assert!(can_display(Path::new("/pictures/a.gif")));
        assert!(!can_display(Path::new("/pictures/a.mp4")));
        assert!(!can_display(Path::new("/pictures/a.MOV")));
        // 目录型 WPE 壁纸
        assert!(!can_display(&std::env::temp_dir()));
    }

    #[test]
    fn missing_file_is_rejected_before_reaching_the_system() {
        let missing = Path::new("/nonexistent/kabegame-native-mac-test.jpg");
        assert_eq!(
            set_desktop_image("00000000-0000-0000-0000-000000000000", missing, "fill"),
            Err("File does not exist".to_string())
        );
        assert_eq!(
            set_desktop_image_on_every_screen(missing, "fill"),
            Err("File does not exist".to_string())
        );
    }
}
