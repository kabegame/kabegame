//! macOS 上取文件 / 文件夹 / 命令的图标，以及启动（Windows 的对应部分在 `windows.rs`）。
//!
//! 图标和 Windows 同一个顺序：
//! - 路径不存在、又不带 `/` 时按用户登录 shell 的 `PATH` 找同名的可执行文件（对应 Windows 的 `SearchPathW`，见 [`shell_path`]）；
//! - QuickLook 内容缩略图（最长边 256，对应 Windows 的 Shell 缩略图缓存）：图片、视频、PDF 在这里得到内容；
//! - 取不到再取系统图标（`NSWorkspace.iconForFile`，画成 256×256）：应用、文件夹、可执行文件、别名、`.webloc` 在这里；
//!   路径不存在时按扩展名取通用图标，没有扩展名就没有图标。
//!
//! 两支都画成 RGBA 再去预乘，透明区填色由调用方做（[`super::finish`]）。所有函数都在阻塞线程里调用；
//! QuickLook 的回调在它自己的队列上，这里同步等，超时退回系统图标。
//!
//! 启动：
//! - 文件夹、网址、不带参数的文件交给 `tauri-plugin-opener`（NSWorkspace 用默认程序打开，`.app` 会被启动）；
//! - 命令整条交给用户的登录 shell（`$SHELL -i -l -c`），和在终端里敲一样：`.zprofile` / `.zshrc` 里配的 `PATH`（Homebrew、
//!   nvm、pyenv 等）、别名、函数都在，改了立即生效。从 Finder / Dock 启动的应用自己的 `PATH` 只有
//!   `/usr/bin:/bin:/usr/sbin:/sbin`，`/bin/sh -c` 找不到这些命令；代价是每次多一次 shell 启动（oh-my-zsh 加 nvm 约 0.6 s）；
//! - 带参数的 `.app` 经 `/bin/sh -c` 跑 `/usr/bin/open -a <路径> --args <参数>`，参数照 POSIX shell 规则拆（`open` 是绝对路径，
//!   不必等登录 shell）；其它文件带参数时参数忽略（Windows 上给文档传参数一般也没有效果）；
//! - shell 不等它结束，工作目录是用户主目录。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
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

use super::Icon;

/// 图标边长：同 Windows 的 Shell 缩略图与 JUMBO 系统图标。
const ICON_SIDE: usize = 256;
/// QuickLook 没回调时最多等这么久，之后退回系统图标。
const QUICK_LOOK_TIMEOUT: Duration = Duration::from_secs(3);
/// 读登录 shell 的 `PATH` 最多等这么久（`.zshrc` 里加载很多东西时会慢），之后用应用自己的 `PATH`。
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// 登录 shell 打印 `PATH` 时前后的标记：`.zshrc` 可能往标准输出打别的东西。
const PATH_BEGIN: &str = "__KABEGAME_PATH_BEGIN__";
const PATH_END: &str = "__KABEGAME_PATH_END__";

/// 取图标的路径：命令取命令行里的程序（照 shell 规则拆，取第一个词），其余取路径本身。
pub fn icon_target(shortcut: &UserShortcut) -> String {
    match shortcut.kind {
        ShortcutKind::Cmd => shlex::split(&command_line(shortcut))
            .and_then(|words| words.into_iter().next())
            .unwrap_or_else(|| shortcut.path.clone()),
        _ => shortcut.path.clone(),
    }
}

/// 取一个路径的图标，已去预乘、还没做透明区填色。
pub fn prefill_icon(path: &str) -> Option<Icon> {
    let path = resolve_path(path);
    // 符号链接取目标的图标：`iconForFile` 给符号链接加替身箭头（macOS 26 的 `/Applications/Safari.app` 就是指向
    // Cryptex 的链接），Windows 上应用的路径没有这一层
    let path = path.canonicalize().unwrap_or(path);
    autoreleasepool(|_| quick_look(&path).or_else(|| system_icon(&path)))
}

/// 路径存在就用它；不存在、又不带 `/` 时按登录 shell 的 `PATH`（取不到用应用自己的）找同名的可执行文件；都不是就原样返回。
fn resolve_path(path: &str) -> PathBuf {
    let search = shell_path().cloned().or_else(|| std::env::var_os("PATH"));
    resolve_path_in(path, search.as_deref())
}

fn resolve_path_in(path: &str, search: Option<&OsStr>) -> PathBuf {
    let given = PathBuf::from(path);
    if given.exists() || path.contains('/') {
        return given;
    }
    search
        .into_iter()
        .flat_map(|paths| std::env::split_paths(paths).collect::<Vec<_>>())
        .map(|dir| dir.join(path))
        .find(|candidate| is_executable_file(candidate))
        .unwrap_or(given)
}

/// 用户的登录 shell：`$SHELL`（从 Finder 启动的应用也有），没有或不可执行时用 macOS 的缺省 `/bin/zsh`。
fn user_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && is_executable_file(shell))
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// 用户在终端里看到的 `PATH`：让登录 + 交互 shell 打印一次（`.zshrc` 只有交互 shell 才读），进程内缓存。启动命令每次都
/// 在登录 shell 里跑、不用它；它只给命令的图标按名字找程序。超时或失败时缓存成 `None`，不再重试（否则每个图标都要等）。
fn shell_path() -> Option<&'static OsString> {
    static CACHED: OnceLock<Option<OsString>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let script = format!("printf '\\n{PATH_BEGIN}%s{PATH_END}\\n' \"$PATH\"");
            let output = shell_output(&script, SHELL_PATH_TIMEOUT);
            let path = output.as_deref().and_then(parse_marked_path);
            match &path {
                Some(_) => tracing::debug!("读到登录 shell 的 PATH"),
                None => tracing::warn!("读登录 shell 的 PATH 失败，命令图标按应用自己的 PATH 找"),
            }
            path
        })
        .as_ref()
}

/// 在登录 + 交互 shell 里跑 `script`，收标准输出；超时杀掉、返回 `None`。
fn shell_output(script: &str, timeout: Duration) -> Option<String> {
    let mut command = login_shell_command(script);
    command.stdout(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let text = receiver.recv_timeout(timeout).ok();
    if text.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    text
}

/// 取两个标记之间的 `PATH`，空串当没有。
fn parse_marked_path(text: &str) -> Option<OsString> {
    let start = text.rfind(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = start + text[start..].find(PATH_END)?;
    let path = text[start..end].trim();
    (!path.is_empty()).then(|| OsString::from(path))
}

fn is_executable_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
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

/// 启动；返回启动请求有没有发出去（命令只看 `sh` 起没起来，不等它结束）。
pub fn launch(shortcut: &UserShortcut) -> bool {
    let result = match shortcut.kind {
        ShortcutKind::Web => open_url(&shortcut.path),
        ShortcutKind::Directory => open_path(&shortcut.path),
        ShortcutKind::File if shortcut.args.is_empty() => open_path(&shortcut.path),
        ShortcutKind::File if is_app_bundle(Path::new(&shortcut.path)) => {
            app_with_args_line(&shortcut.path, &shortcut.args)
                .ok_or_else(|| "路径里有 NUL".to_owned())
                .and_then(|line| run_shell(&line))
        }
        ShortcutKind::File => {
            tracing::debug!("场景快捷方式的目标不是应用，启动参数忽略");
            open_path(&shortcut.path)
        }
        ShortcutKind::Cmd => spawn_detached(login_shell_command(&command_line(shortcut))),
    };
    result
        .map_err(|error| tracing::warn!("启动场景快捷方式失败：{error}"))
        .is_ok()
}

fn open_path(path: &str) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| error.to_string())
}

/// 网址照取图标的规则补前缀（`www.` 开头的值保存时不补 `https://`，NSWorkspace 不认没有协议的地址）。
fn open_url(input: &str) -> Result<(), String> {
    let url = super::web::page_urls(input)
        .into_iter()
        .next()
        .ok_or_else(|| "网址不合法".to_owned())?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        && path.is_dir()
}

/// 命令的整条命令行：`parse_user_shortcut` 在第一个空格处拆成程序与参数，这里拼回去。
fn command_line(shortcut: &UserShortcut) -> String {
    if shortcut.args.is_empty() {
        shortcut.path.clone()
    } else {
        format!("{} {}", shortcut.path, shortcut.args)
    }
}

/// 带参数启动应用的 `sh` 命令行：路径转义，参数原样（照 shell 规则拆）。路径里有 NUL 时返回 `None`。
fn app_with_args_line(app: &str, args: &str) -> Option<String> {
    let app = shlex::try_quote(app).ok()?;
    Some(format!("exec /usr/bin/open -a {app} --args {args}"))
}

/// `/bin/sh -c <line>`，见 [`spawn_detached`]。
fn run_shell(line: &str) -> Result<(), String> {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(line);
    new_session(&mut command);
    spawn_detached(command)
}

/// 用户的登录 + 交互 shell 跑 `line`（`-i -l -c` 分开写，fish 也认）。标准输入输出不接，交互 shell 读到的是空输入；
/// 工作目录是主目录，子进程自成一个会话（见 [`new_session`]）。
fn login_shell_command(line: &str) -> Command {
    let mut command = Command::new(user_shell());
    command
        .args(["-i", "-l", "-c"])
        .arg(line)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    new_session(&mut command);
    command
}

/// 子进程先 `setsid()`：脱离控制终端、自成会话与进程组。从终端启动的 Kabegame（dev）带着控制终端，后台进程组里的交互 shell
/// 一碰终端就被 SIGTTOU 停住（实测停在 `T` 状态）；脱离之后和从 Finder 启动时一样，终端里的 Ctrl+C 也带不走它。
/// 工作目录顺带设成主目录。
fn new_session(command: &mut Command) {
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    // SAFETY: pre_exec 在 fork 之后、exec 之前跑，只调 async-signal-safe 的 setsid
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// 不接标准输入输出，不等它结束，另起线程收尸并记退出码。`command` 已经由 [`new_session`] 处理过。
fn spawn_detached(mut command: Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let _ = std::thread::Builder::new()
        .name("wpe-shortcut-wait".into())
        .spawn(move || match child.wait() {
            Ok(status) if !status.success() => {
                tracing::warn!("场景快捷方式的命令没有正常结束：{status}");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("等待场景快捷方式的命令失败：{error}"),
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(kind: ShortcutKind, path: &str, args: &str) -> UserShortcut {
        UserShortcut {
            kind,
            path: path.into(),
            args: args.into(),
        }
    }

    #[test]
    fn command_line_and_program_follow_shell_rules() {
        // parse_user_shortcut 在第一个空格处拆，拼回去是原命令行
        let cmd = shortcut(ShortcutKind::Cmd, "open", "-a Calculator");
        assert_eq!(command_line(&cmd), "open -a Calculator");
        assert_eq!(icon_target(&cmd), "open");
        // 带引号的程序路径：第一个空格落在引号里，图标仍取完整路径
        let quoted = shortcut(
            ShortcutKind::Cmd,
            "\"/Applications/My",
            "App.app/Contents/MacOS/x\" --flag",
        );
        assert_eq!(
            icon_target(&quoted),
            "/Applications/My App.app/Contents/MacOS/x"
        );
        // 引号不配对时退回路径本身
        let broken = shortcut(ShortcutKind::Cmd, "\"oops", "");
        assert_eq!(icon_target(&broken), "\"oops");
        // 其它类型取路径
        let file = shortcut(ShortcutKind::File, "/Applications/Safari.app", "-x");
        assert_eq!(icon_target(&file), "/Applications/Safari.app");
    }

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
    fn resolve_path_searches_path_only_for_bare_names() {
        let search = OsStr::new("/nonexistent:/bin");
        // sh 必在 /bin
        assert_eq!(
            resolve_path_in("sh", Some(search)),
            PathBuf::from("/bin/sh")
        );
        // 带 `/` 的不查
        assert_eq!(
            resolve_path_in("bin/sh", Some(search)),
            PathBuf::from("bin/sh")
        );
        // 查不到、没有 PATH 都原样返回
        assert_eq!(
            resolve_path_in("kabegame-no-such-program", Some(search)),
            PathBuf::from("kabegame-no-such-program")
        );
        assert_eq!(resolve_path_in("sh", None), PathBuf::from("sh"));
    }

    #[test]
    fn marked_path_ignores_noise_from_rc_files() {
        let text = format!("Welcome!\n{PATH_BEGIN}/opt/homebrew/bin:/usr/bin{PATH_END}\nbye\n");
        assert_eq!(
            parse_marked_path(&text),
            Some(OsString::from("/opt/homebrew/bin:/usr/bin"))
        );
        // 取最后一个开始标记（rc 文件里碰巧也打印了标记时以我们的为准）
        let twice = format!("{PATH_BEGIN}x{PATH_END}{PATH_BEGIN}/bin{PATH_END}");
        assert_eq!(parse_marked_path(&twice), Some(OsString::from("/bin")));
        assert_eq!(parse_marked_path(&format!("{PATH_BEGIN}{PATH_END}")), None);
        assert_eq!(parse_marked_path("no markers"), None);
    }

    /// 真跑一次用户的登录 shell（本机核对用，`#[ignore]`）：拿到的 PATH 应比 `/bin/sh` 的长。
    #[test]
    #[ignore]
    fn reads_login_shell_path() {
        let path = shell_path().expect("读不到登录 shell 的 PATH");
        println!("{}", path.to_string_lossy());
        assert!(path.to_string_lossy().contains("/usr/bin"));
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
