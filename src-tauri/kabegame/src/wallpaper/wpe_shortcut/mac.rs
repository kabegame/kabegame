//! macOS 上取文件 / 文件夹 / 命令的图标，以及启动（Windows 的对应部分在 `windows.rs`，和 Linux 共用的 Unix 部分在 `unix.rs`）。
//!
//! 图标和 Windows 同一个顺序：
//! - 路径不存在、又不带 `/` 时按用户登录 shell 的 `PATH` 找同名的可执行文件（对应 Windows 的 `SearchPathW`，见 [`unix::shell_path`]）；
//! - QuickLook 内容缩略图（最长边 256，对应 Windows 的 Shell 缩略图缓存）：图片、视频、PDF 在这里得到内容；
//! - 取不到再取系统图标（`NSWorkspace.iconForFile`，画成 256×256）：应用、文件夹、可执行文件、别名、`.webloc` 在这里；
//!   路径不存在时按扩展名取通用图标，没有扩展名就没有图标。
//!
//! 两支都画成 RGBA 再去预乘，透明区填色由调用方做（[`super::finish`]）。所有函数都在阻塞线程里调用；
//! QuickLook 的回调在它自己的队列上，这里同步等，超时退回系统图标。
//!
//! 启动：
//! - 文件夹、网址、不带参数的文件交给 `tauri-plugin-opener`（NSWorkspace 用默认程序打开，`.app` 会被启动）；
//! - 命令整条交给用户的登录 shell（`$SHELL -i -l -c`，见 `unix.rs`）：从 Finder / Dock 启动的应用自己的 `PATH` 只有
//!   `/usr/bin:/bin:/usr/sbin:/sbin`，`/bin/sh -c` 找不到 Homebrew、nvm 等装的命令；
//! - 带参数的 `.app` 经 `/bin/sh -c` 跑 `/usr/bin/open -a <路径> --args <参数>`，参数照 POSIX shell 规则拆（`open` 是绝对路径，
//!   不必等登录 shell）；其它文件带参数时参数忽略（Windows 上给文档传参数一般也没有效果）；
//! - shell 不等它结束，工作目录是用户主目录。

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use kabegame_core::wpe::user_props::{ShortcutKind, UserShortcut};
use objc2::rc::autoreleasepool;
use objc2::AnyThread;
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGInterpolationQuality,
};
use objc2_foundation::{NSError, NSString, NSURL};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
    QLThumbnailGenerator, QLThumbnailRepresentation,
};

use super::unix::{
    command_line, ensure_exists, login_shell_command, open_path, open_url, resolve_path, run_shell,
    spawn_checked,
};
use super::Icon;

/// 图标边长：同 Windows 的 Shell 缩略图与 JUMBO 系统图标。
const ICON_SIDE: usize = 256;
/// QuickLook 没回调时最多等这么久，之后退回系统图标。
const QUICK_LOOK_TIMEOUT: Duration = Duration::from_secs(3);

/// 取一个路径的图标，已去预乘、还没做透明区填色。
pub fn prefill_icon(path: &str) -> Option<Icon> {
    let path = resolve_path(path);
    // 符号链接取目标的图标：`iconForFile` 给符号链接加替身箭头（macOS 26 的 `/Applications/Safari.app` 就是指向
    // Cryptex 的链接），Windows 上应用的路径没有这一层
    let path = path.canonicalize().unwrap_or(path);
    autoreleasepool(|_| quick_look(&path).or_else(|| system_icon(&path)))
}

/// QuickLook 的内容缩略图（`Thumbnail` 表示，不要图标形态的装饰）。文件夹、应用等没有内容缩略图的返回 `None`。
fn quick_look(path: &Path) -> Option<Icon> {
    if !path.exists() {
        return None;
    }
    let url = NSURL::from_file_path(path)?;
    let (sender, receiver) = mpsc::channel::<Option<Icon>>();
    let handler = RcBlock::new(
        move |representation: *mut QLThumbnailRepresentation, _error: *mut NSError| {
            // SAFETY: 非空时是回调期间有效的表示对象
            let icon = unsafe { representation.as_ref() }.and_then(|representation| {
                let image = unsafe { representation.CGImage() };
                draw(&image, None)
            });
            let _ = sender.send(icon);
        },
    );
    // SAFETY: 请求参数都是有效值；回调只把结果送回本线程
    let (generator, request) = unsafe {
        let request =
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize::new(ICON_SIDE as f64, ICON_SIDE as f64),
                1.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            );
        let generator = QLThumbnailGenerator::sharedGenerator();
        generator.generateBestRepresentationForRequest_completionHandler(&request, &handler);
        (generator, request)
    };
    match receiver.recv_timeout(QUICK_LOOK_TIMEOUT) {
        Ok(icon) => icon,
        Err(_) => {
            tracing::debug!("QuickLook 缩略图超时，改取系统图标");
            // SAFETY: 取消同一个生成器上发出的请求
            unsafe { generator.cancelRequest(&request) };
            None
        }
    }
}

/// `NSWorkspace` 的系统图标，画成 256×256。路径不存在时按扩展名取通用图标。
fn system_icon(path: &Path) -> Option<Icon> {
    let workspace = NSWorkspace::sharedWorkspace();
    let image = if path.exists() {
        workspace.iconForFile(&NSString::from_str(&path.to_string_lossy()))
    } else {
        let extension = path.extension()?.to_str()?;
        // `iconForContentType` 要另引 UniformTypeIdentifiers；按扩展名取的这个只是标了弃用
        #[allow(deprecated)]
        workspace.iconForFileType(&NSString::from_str(extension))
    };
    let mut rect = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(ICON_SIDE as f64, ICON_SIDE as f64),
    );
    // SAFETY: rect 是有效指针，不给上下文与提示
    let image = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    draw(&image, Some(ICON_SIDE))
}

/// 画进 sRGB、预乘 alpha 的 RGBA 位图再去预乘。`side` 给了就画成这个边长的正方形（系统图标），
/// 没给按原尺寸、最长边不超过 256（QuickLook 缩略图本来就不超过）。
fn draw(image: &CGImage, side: Option<usize>) -> Option<Icon> {
    let (source_width, source_height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if source_width == 0 || source_height == 0 {
        return None;
    }
    let (width, height) = match side {
        Some(side) => (side, side),
        None => fit_within(source_width, source_height, ICON_SIDE),
    };
    let mut rgba = vec![0u8; width * height * 4];
    // SAFETY: kCGColorSpaceSRGB 是 Core Graphics 导出的常量
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    // SAFETY: 缓冲区正好 width·height·4 字节，活到上下文释放之后
    let context = unsafe {
        CGBitmapContextCreate(
            rgba.as_mut_ptr().cast(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    }?;
    CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
    CGContext::draw_image(
        Some(&context),
        CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width as f64, height as f64),
        ),
        Some(image),
    );
    drop(context);
    unpremultiply(&mut rgba);
    Some(Icon {
        width: width as u32,
        height: height as u32,
        rgba,
    })
}

/// 等比缩到最长边不超过 `max`，不放大。
fn fit_within(width: usize, height: usize, max: usize) -> (usize, usize) {
    let longest = width.max(height);
    if longest <= max {
        return (width, height);
    }
    let scale = |side: usize| ((side * max + longest / 2) / longest).max(1);
    (scale(width), scale(height))
}

/// 预乘 → 直通 alpha，四舍五入。
fn unpremultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
}

/// 启动；启动请求发出去了返回 `Ok`，当场能知道的失败返回给用户看的原因（目标不存在、起不来）；起来后很快出错退出的由
/// `unix.rs` 事后经 `user-message` 通道报。
pub fn launch(shortcut: &UserShortcut) -> Result<(), String> {
    match shortcut.kind {
        ShortcutKind::Web => open_url(&shortcut.path),
        ShortcutKind::Directory => {
            ensure_exists(&shortcut.path, true)?;
            open_path(&shortcut.path)
        }
        ShortcutKind::File => {
            ensure_exists(&shortcut.path, false)?;
            if shortcut.args.is_empty() {
                open_path(&shortcut.path)
            } else if is_app_bundle(Path::new(&shortcut.path)) {
                app_with_args_line(&shortcut.path, &shortcut.args)
                    .ok_or_else(|| "路径里有 NUL".to_owned())
                    .and_then(|line| run_shell(&line))
            } else {
                tracing::debug!("场景快捷方式的目标不是应用，启动参数忽略");
                open_path(&shortcut.path)
            }
        }
        ShortcutKind::Cmd => spawn_checked(login_shell_command(&command_line(shortcut))),
    }
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        && path.is_dir()
}

/// 带参数启动应用的 `sh` 命令行：路径转义，参数原样（照 shell 规则拆）。路径里有 NUL 时返回 `None`。
fn app_with_args_line(app: &str, args: &str) -> Option<String> {
    let app = shlex::try_quote(app).ok()?;
    Some(format!("exec /usr/bin/open -a {app} --args {args}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_arguments_go_through_open_with_a_quoted_path() {
        assert_eq!(
            app_with_args_line("/Applications/My App.app", "--foo 'a b'").unwrap(),
            "exec /usr/bin/open -a '/Applications/My App.app' --args --foo 'a b'"
        );
        assert_eq!(
            app_with_args_line("/Applications/Safari.app", "-x").unwrap(),
            "exec /usr/bin/open -a /Applications/Safari.app --args -x"
        );
        assert!(app_with_args_line("a\0b", "-x").is_none());
    }

    #[test]
    fn unpremultiply_rounds_and_keeps_extremes() {
        let mut rgba = vec![64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut rgba);
        assert_eq!(rgba, vec![128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn fit_within_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_within(100, 50, 256), (100, 50));
        assert_eq!(fit_within(512, 256, 256), (256, 128));
        assert_eq!(fit_within(1000, 1, 256), (256, 1));
    }
}
