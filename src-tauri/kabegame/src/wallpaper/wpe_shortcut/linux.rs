//! Linux 上取文件 / 文件夹 / 命令的图标，以及启动（和 macOS 共用的 Unix 部分在 `unix.rs`）。
//!
//! 图标和 Windows / macOS 同一个顺序，用应用已经链接的 GIO 与 GTK 3（图标主题跟随桌面，系统的 gdk-pixbuf 带 SVG 加载器）：
//! - 路径不存在、又不带 `/` 时按用户登录 shell 的 `PATH` 找同名的可执行文件（[`unix::resolve_path`]）；命令取命令行的程序；
//! - 内容缩略图（对应 Windows 的 Shell 缩略图缓存、macOS 的 QuickLook）：先查 freedesktop 缩略图缓存（文件管理器生成过的，
//!   GIO 的 `thumbnail::path-*` 与 `thumbnail::is-valid-*`），没有时图片用 `image` 解、视频解第一帧，最长边 256；
//! - 系统图标：`.desktop` 取它声明的图标（Linux 上「应用」就是它）；可执行文件按程序名在已安装的应用里找 `Exec` 同名的那个、
//!   取它的图标，找不到用 GIO 给的可执行文件图标；其余文件与文件夹取 GIO 的 `standard::icon`（`~/Pictures` 得到
//!   `folder-pictures`）；路径不存在时按扩展名猜类型取通用图标，没有扩展名就没有图标（同 macOS）。
//!
//! GIO 的查询在调用方的阻塞线程里做，图标序列化成字符串（`g_icon_to_string`）；按主题渲染（`gtk::IconTheme`）只能在 GTK 主线程，
//! 经默认主上下文的空闲源交给主线程（CEF runtime 每轮都转它），通道等结果，最多 [`RENDER_TIMEOUT`]。不用
//! `MainContext::invoke`：调用线程拿得到上下文的所有权时它会就地执行，GTK 就在工作线程上被调用了。
//!
//! 启动（请求发出去了返回 `Ok`，失败返回给用户看的原因，同 macOS；文件与文件夹先查在不在）：
//! - 网址、文件夹、普通文件交给 `tauri-plugin-opener`（xdg-open / 门户）；普通文件带参数时参数忽略；
//! - `.desktop`：不带参数用 GIO 启动（`Terminal`、D-Bus 激活等由 GIO 处理）；带参数时把 `Exec` 去掉字段码后拼上参数、经
//!   `/bin/sh -c` 跑。xdg-open 一个 `.desktop` 会用文本编辑器打开它，所以单独处理；
//! - 可执行的普通文件（ELF、脚本、AppImage）：直接起进程，参数照 POSIX shell 规则拆（对应 Windows 的 `ShellExecute` 跑 exe）；
//!   xdg-open 不会执行它们；
//! - 命令整条交给用户的登录 + 交互 shell（`unix.rs`）。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use gtk::prelude::*;
use gtk::{gio, glib};
use kabegame_core::wpe::user_props::{ShortcutKind, UserShortcut};

use super::unix::{
    self, command_line, ensure_exists, login_shell_command, new_session, open_path, open_url,
    resolve_path, run_shell, spawn_checked,
};
use super::Icon;

/// 图标边长：同 Windows 的 Shell 缩略图与 JUMBO 系统图标。
const ICON_SIDE: u32 = 256;
/// 主线程渲染图标最多等这么久（主线程卡住或没有在转 GLib 时放弃）。
const RENDER_TIMEOUT: Duration = Duration::from_secs(2);
/// 缩略图缓存按尺寸的属性后缀，先取刚好 256 的 `large`，再取更大的往下缩，最后是不分尺寸的旧属性。
const THUMBNAIL_SIZES: [&str; 4] = ["-large", "-xlarge", "-xxlarge", ""];

/// 取一个快捷方式（文件、文件夹、命令）的图标，已经是直通 alpha、还没做透明区填色。在阻塞线程里调。
pub fn prefill_icon(shortcut: &UserShortcut) -> Option<Icon> {
    let resolved = resolve_path(&unix::icon_target(shortcut));
    // 符号链接取目标（同 macOS）；找应用时两个名字都试（`/usr/bin/google-chrome` → `/opt/google/chrome/google-chrome`）
    let target = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());
    if !is_desktop_entry(&target) && !target.is_dir() {
        if let Some(icon) = content_thumbnail(&target) {
            return Some(icon);
        }
    }
    let icon = system_icon_name(&resolved, &target)?;
    render_on_main_thread(icon)
}

fn is_desktop_entry(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "desktop")
        && path.is_file()
}

// ───────────────────────── 内容缩略图 ─────────────────────────

/// freedesktop 缩略图缓存里有效的那一张，没有时图片 / 视频自己解。
fn content_thumbnail(path: &Path) -> Option<Icon> {
    if !path.is_file() {
        return None;
    }
    let info = gio::File::for_path(path)
        .query_info(
            "thumbnail::*,standard::content-type",
            gio::FileQueryInfoFlags::NONE,
            gio::Cancellable::NONE,
        )
        .ok()?;
    for size in THUMBNAIL_SIZES {
        let valid = format!("thumbnail::is-valid{size}");
        if info.has_attribute(&valid) && !info.boolean(&valid) {
            continue;
        }
        let Some(cached) = info.attribute_byte_string(&format!("thumbnail::path{size}")) else {
            continue;
        };
        if let Some(icon) = image::open(cached.as_str()).ok().map(fit_icon) {
            return Some(icon);
        }
    }
    let content_type = info.content_type().unwrap_or_default();
    if content_type.starts_with("image/") {
        return image::open(path).ok().map(fit_icon);
    }
    if content_type.starts_with("video/") {
        return kabegame_core::media::decode::decode_first_video_frame(path, ICON_SIDE)
            .ok()
            .map(|frame| fit_icon(image::DynamicImage::ImageRgb8(frame)));
    }
    None
}

/// 等比缩到最长边不超过 256（不放大），转直通 alpha 的 RGBA。
fn fit_icon(image: image::DynamicImage) -> Icon {
    let image = if image.width().max(image.height()) > ICON_SIDE {
        image.thumbnail(ICON_SIDE, ICON_SIDE)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    Icon {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    }
}

// ───────────────────────── 系统图标 ─────────────────────────

/// 系统图标（序列化的 `GIcon`）。`resolved` 是按 `PATH` 找到的路径，`target` 是解析了符号链接的。
fn system_icon_name(resolved: &Path, target: &Path) -> Option<String> {
    let icon = if is_desktop_entry(target) {
        gio::DesktopAppInfo::from_filename(target)?.icon()?
    } else if target.exists() {
        let app_icon = unix::is_executable_file(target)
            .then(|| app_icon_for_program(resolved, target))
            .flatten();
        match app_icon {
            Some(icon) => icon,
            None => gio::File::for_path(target)
                .query_info(
                    "standard::icon",
                    gio::FileQueryInfoFlags::NONE,
                    gio::Cancellable::NONE,
                )
                .ok()?
                .icon()?,
        }
    } else {
        // 不存在：按扩展名猜类型取通用图标；没有扩展名就没有图标
        target.extension()?;
        gio::content_type_get_icon(&guess_content_type_by_name(target))
    };
    IconExt::to_string(&icon).map(|text| text.to_string())
}

/// 只按文件名猜内容类型。gio-rs 的 `content_type_guess` 只收切片，空切片传下去是「有数据、长度 0」，GLib 会判成
/// `application/x-zerosize`；只按名字猜要传 NULL，所以直接调。
fn guess_content_type_by_name(path: &Path) -> String {
    use gtk::glib::translate::{from_glib_full, ToGlibPtr};
    let mut uncertain = 0;
    // SAFETY: 文件名是借出的 C 串，数据传 NULL、长度 0；返回值归调用方所有
    let content_type: glib::GString = unsafe {
        from_glib_full(gio::ffi::g_content_type_guess(
            path.to_glib_none().0,
            std::ptr::null(),
            0,
            &mut uncertain,
        ))
    };
    content_type.to_string()
}

/// 在已安装的应用里找启动这个程序的那个，取它的图标。候选是 `Exec` 的程序同名、或解析符号链接后就是这个文件的
/// （`google-chrome.desktop` 写的是 `google-chrome-stable`，和 `google-chrome` 指向同一个文件）。多个候选时依次比：
/// 应用 id 与程序名一致（`google-chrome.desktop`、`org.kde.dolphin.desktop`）、显示在菜单里、去掉字段码后的命令行更短
/// （装成应用的网页也用浏览器启动，`Exec` 都带 `--app-id`，不能挑到它们）。
fn app_icon_for_program(resolved: &Path, target: &Path) -> Option<gio::Icon> {
    let names: Vec<&OsStr> = [resolved.file_name(), target.file_name()]
        .into_iter()
        .flatten()
        .collect();
    let stems: Vec<String> = names
        .iter()
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    let search = unix::shell_path()
        .cloned()
        .or_else(|| std::env::var_os("PATH"));
    let mut best: Option<((bool, bool, usize), gio::AppInfo)> = None;
    for app in gio::AppInfo::all() {
        let Some(executable) = app_executable(&app) else {
            continue;
        };
        let same_name = executable
            .file_name()
            .is_some_and(|name| names.contains(&name));
        let same_file = || {
            unix::resolve_path_in(&executable.to_string_lossy(), search.as_deref())
                .canonicalize()
                .is_ok_and(|path| path == target)
        };
        if !same_name && !same_file() {
            continue;
        }
        let id = app.id().map(|id| id.to_string()).unwrap_or_default();
        let id = id.strip_suffix(".desktop").unwrap_or(&id);
        let id_matches = stems
            .iter()
            .any(|stem| id == stem || id.ends_with(&format!(".{stem}")));
        let command_length = app
            .commandline()
            .map(|line| strip_field_codes(&line.to_string_lossy()).len())
            .unwrap_or(usize::MAX);
        let rank = (!id_matches, !app.should_show(), command_length);
        if best.as_ref().map_or(true, |(known, _)| rank < *known) {
            best = Some((rank, app));
        }
    }
    best?.1.icon()
}

/// 应用的 `Exec` 程序。gio-rs 0.18 的 `AppInfoExt::executable` 把返回值当成非空直接转，而有的条目（只靠 D-Bus 激活的等）
/// 这里是 NULL，会对 NULL 取长度崩掉（实测 SIGSEGV），所以直接调、先判空。
fn app_executable(app: &gio::AppInfo) -> Option<PathBuf> {
    use gtk::glib::translate::{from_glib_none, ToGlibPtr};
    // SAFETY: app 在调用期间有效；返回值归 app 所有，非空时立即复制
    unsafe {
        let executable = gio::ffi::g_app_info_get_executable(app.to_glib_none().0);
        (!executable.is_null()).then(|| from_glib_none(executable))
    }
}

/// 交给 GTK 主线程按主题渲染，等结果。
fn render_on_main_thread(icon: String) -> Option<Icon> {
    let (sender, receiver) = mpsc::channel();
    glib::idle_add_once(move || {
        let _ = sender.send(render_themed(&icon));
    });
    match receiver.recv_timeout(RENDER_TIMEOUT) {
        Ok(icon) => icon,
        Err(_) => {
            tracing::debug!("GTK 主线程没有及时渲染快捷方式图标");
            None
        }
    }
}

/// 按当前图标主题把 `GIcon` 画成 256×256（SVG 由 gdk-pixbuf 的加载器画）。只能在 GTK 主线程调。
fn render_themed(icon: &str) -> Option<Icon> {
    let icon = gio::Icon::for_string(icon).ok()?;
    let theme = gtk::IconTheme::default()?;
    let info = theme.lookup_by_gicon(&icon, ICON_SIDE as i32, gtk::IconLookupFlags::FORCE_SIZE)?;
    let pixbuf = info.load_icon().ok()?;
    if pixbuf.bits_per_sample() != 8 {
        return None;
    }
    let bytes = pixbuf.read_pixel_bytes();
    let (width, height) = (pixbuf.width() as usize, pixbuf.height() as usize);
    let rgba = pixbuf_rgba(
        &bytes,
        width,
        height,
        pixbuf.rowstride() as usize,
        pixbuf.n_channels() as usize,
    )?;
    Some(Icon {
        width: width as u32,
        height: height as u32,
        rgba,
    })
}

/// gdk-pixbuf 的像素（每行 `rowstride` 字节、最后一行可能不补齐，3 或 4 通道、直通 alpha）→ 紧凑的 RGBA。
fn pixbuf_rgba(
    pixels: &[u8],
    width: usize,
    height: usize,
    rowstride: usize,
    channels: usize,
) -> Option<Vec<u8>> {
    if !(channels == 3 || channels == 4)
        || width == 0
        || height == 0
        || rowstride < width * channels
    {
        return None;
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let start = y * rowstride;
        let row = pixels.get(start..start + width * channels)?;
        for pixel in row.chunks_exact(channels) {
            rgba.extend_from_slice(&pixel[..3]);
            rgba.push(if channels == 4 { pixel[3] } else { 255 });
        }
    }
    Some(rgba)
}

// ───────────────────────── 启动 ─────────────────────────

/// 启动要做的事（[`plan_launch`] 决定，[`launch`] 执行）。
#[derive(Debug, PartialEq, Eq)]
enum LaunchPlan {
    OpenUrl(String),
    OpenPath(String),
    /// 不带参数的 `.desktop`：GIO 启动
    DesktopEntry(PathBuf),
    /// `/bin/sh -c`（带参数的 `.desktop`）
    Shell(String),
    /// 直接起进程（可执行的普通文件）
    Exec {
        program: PathBuf,
        args: Vec<String>,
    },
    /// 用户的登录 + 交互 shell（命令）
    LoginShell(String),
}

/// 启动；请求发出去了返回 `Ok`，当场能知道的失败返回给用户看的原因（目标不存在、`.desktop` 读不了、起不来）；起来后很快
/// 出错退出的由 `unix.rs` 事后经 `user-message` 通道报。
pub fn launch(shortcut: &UserShortcut) -> Result<(), String> {
    plan_launch(shortcut).and_then(|plan| match plan {
        LaunchPlan::OpenUrl(url) => open_url(&url),
        LaunchPlan::OpenPath(path) => open_path(&path),
        LaunchPlan::DesktopEntry(path) => desktop_app(&path)?
            .launch(&[], gio::AppLaunchContext::NONE)
            .map_err(|error| format!("启动应用失败：{error}")),
        LaunchPlan::Shell(line) => run_shell(&line),
        LaunchPlan::Exec { program, args } => {
            let mut command = Command::new(program);
            command.args(args);
            new_session(&mut command);
            spawn_checked(command)
        }
        LaunchPlan::LoginShell(line) => spawn_checked(login_shell_command(&line)),
    })
}

/// 读 `.desktop`。GIO 只认 `Exec`（与 `TryExec`）的程序装了的条目，读不了多半是应用没装。
fn desktop_app(path: &Path) -> Result<gio::DesktopAppInfo, String> {
    gio::DesktopAppInfo::from_filename(path)
        .ok_or_else(|| format!("读不了应用的 .desktop（应用可能没装）：{}", path.display()))
}

fn plan_launch(shortcut: &UserShortcut) -> Result<LaunchPlan, String> {
    Ok(match shortcut.kind {
        ShortcutKind::Web => LaunchPlan::OpenUrl(shortcut.path.clone()),
        ShortcutKind::Directory => {
            ensure_exists(&shortcut.path, true)?;
            LaunchPlan::OpenPath(shortcut.path.clone())
        }
        ShortcutKind::Cmd => LaunchPlan::LoginShell(command_line(shortcut)),
        ShortcutKind::File => {
            ensure_exists(&shortcut.path, false)?;
            let path = Path::new(&shortcut.path);
            if is_desktop_entry(path) {
                if shortcut.args.is_empty() {
                    LaunchPlan::DesktopEntry(path.to_path_buf())
                } else {
                    let exec = desktop_app(path)?
                        .commandline()
                        .ok_or_else(|| format!("应用的 .desktop 没有 Exec：{}", path.display()))?;
                    let exec = strip_field_codes(&exec.to_string_lossy());
                    LaunchPlan::Shell(format!("{exec} {}", shortcut.args))
                }
            } else if unix::is_executable_file(path) {
                let args = if shortcut.args.is_empty() {
                    Vec::new()
                } else {
                    shlex::split(&shortcut.args).ok_or("启动参数的引号不配对")?
                };
                LaunchPlan::Exec {
                    program: path.to_path_buf(),
                    args,
                }
            } else {
                if !shortcut.args.is_empty() {
                    tracing::debug!("场景快捷方式的目标不是应用或可执行文件，启动参数忽略");
                }
                LaunchPlan::OpenPath(shortcut.path.clone())
            }
        }
    })
}

/// `.desktop` 的 `Exec` 去掉字段码（`%f %F %u %U %i %c %k` 等，连同只剩它们的那个词），`%%` 还原成 `%`。
fn strip_field_codes(exec: &str) -> String {
    let mut words = Vec::new();
    for word in exec.split(' ').filter(|word| !word.is_empty()) {
        let mut out = String::new();
        let mut chars = word.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('%') => out.push('%'),
                // 其余字段码（含已弃用的 %d %D %n %N %v %m）一律去掉
                Some(_) | None => {}
            }
        }
        if !out.is_empty() {
            words.push(out);
        }
    }
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn shortcut(kind: ShortcutKind, path: &str, args: &str) -> UserShortcut {
        UserShortcut {
            kind,
            path: path.into(),
            args: args.into(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kabegame-shortcut-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn field_codes_are_stripped() {
        assert_eq!(strip_field_codes("firefox %u"), "firefox");
        assert_eq!(
            strip_field_codes("/usr/bin/code --unity-launch %F"),
            "/usr/bin/code --unity-launch"
        );
        assert_eq!(strip_field_codes("app --name=%c --x"), "app --name= --x");
        assert_eq!(strip_field_codes("printf 100%%"), "printf 100%");
        assert_eq!(strip_field_codes("env  A=1   app %i %k"), "env A=1 app");
    }

    #[test]
    fn launch_plans_follow_the_target() {
        let dir = temp_dir("plan");
        let desktop = dir.join("demo.desktop");
        std::fs::write(
            &desktop,
            "[Desktop Entry]\nType=Application\nName=Demo\nExec=sh --flag %U\n",
        )
        .unwrap();
        let script = dir.join("run.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let doc = dir.join("readme.txt");
        std::fs::write(&doc, "x").unwrap();
        let s = |path: &Path| path.to_string_lossy().into_owned();

        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::Web, "www.example.com", "")).unwrap(),
            LaunchPlan::OpenUrl("www.example.com".into())
        );
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::Directory, &s(&dir), "")).unwrap(),
            LaunchPlan::OpenPath(s(&dir))
        );
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::Cmd, "xdg-open", "~/Music")).unwrap(),
            LaunchPlan::LoginShell("xdg-open ~/Music".into())
        );
        // .desktop：不带参数交给 GIO，带参数拼到去掉字段码的 Exec 后面（GIO 只认 Exec 的程序在 PATH 里的条目，所以用 sh）
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::File, &s(&desktop), "")).unwrap(),
            LaunchPlan::DesktopEntry(desktop.clone())
        );
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::File, &s(&desktop), "--new 'a b'")).unwrap(),
            LaunchPlan::Shell("sh --flag --new 'a b'".into())
        );
        // 可执行文件：直接起，参数照 shell 规则拆；引号不配对报错
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::File, &s(&script), "-x 'a b'")).unwrap(),
            LaunchPlan::Exec {
                program: script.clone(),
                args: vec!["-x".into(), "a b".into()],
            }
        );
        assert!(plan_launch(&shortcut(ShortcutKind::File, &s(&script), "'oops")).is_err());
        // 普通文件：默认程序打开，参数忽略
        assert_eq!(
            plan_launch(&shortcut(ShortcutKind::File, &s(&doc), "-x")).unwrap(),
            LaunchPlan::OpenPath(s(&doc))
        );
        // 目标不存在、类型不对：给出原因，不交给系统
        let gone = dir.join("gone");
        assert!(plan_launch(&shortcut(ShortcutKind::File, &s(&gone), ""))
            .unwrap_err()
            .starts_with("文件不存在"));
        assert!(
            plan_launch(&shortcut(ShortcutKind::Directory, &s(&gone), ""))
                .unwrap_err()
                .starts_with("文件夹不存在")
        );
        assert!(
            plan_launch(&shortcut(ShortcutKind::Directory, &s(&doc), ""))
                .unwrap_err()
                .starts_with("不是文件夹")
        );
        // 应用没装（Exec 的程序不在 PATH 里）
        let broken = dir.join("broken.desktop");
        std::fs::write(
            &broken,
            "[Desktop Entry]\nType=Application\nName=Broken\nExec=kabegame-no-such-app\n",
        )
        .unwrap();
        assert!(
            plan_launch(&shortcut(ShortcutKind::File, &s(&broken), "-x"))
                .unwrap_err()
                .contains("应用可能没装")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pixbuf_rows_are_packed_to_rgba() {
        // 2×2、3 通道、行跨距 8（每行补 2 字节），最后一行不补
        let pixels = [1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 9, 10, 11, 12];
        assert_eq!(
            pixbuf_rgba(&pixels, 2, 2, 8, 3).unwrap(),
            vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]
        );
        // 4 通道照搬 alpha
        let pixels = [1, 2, 3, 0, 4, 5, 6, 128];
        assert_eq!(
            pixbuf_rgba(&pixels, 2, 1, 8, 4).unwrap(),
            vec![1, 2, 3, 0, 4, 5, 6, 128]
        );
        // 数据不够、通道数不对、尺寸为 0
        assert!(pixbuf_rgba(&pixels, 2, 2, 8, 4).is_none());
        assert!(pixbuf_rgba(&pixels, 2, 1, 8, 2).is_none());
        assert!(pixbuf_rgba(&pixels, 0, 1, 8, 4).is_none());
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let icon = fit_icon(image::DynamicImage::new_rgba8(100, 50));
        assert_eq!((icon.width, icon.height), (100, 50));
        let icon = fit_icon(image::DynamicImage::new_rgb8(512, 256));
        assert_eq!((icon.width, icon.height), (256, 128));
        assert_eq!(icon.rgba.len(), 256 * 128 * 4);
    }

    #[test]
    fn system_icons_come_from_gio() {
        let dir = temp_dir("icon");
        let desktop = dir.join("demo.desktop");
        std::fs::write(
            &desktop,
            "[Desktop Entry]\nType=Application\nName=Demo\nExec=sh\nIcon=kabegame-demo-icon\n",
        )
        .unwrap();
        // .desktop 取它声明的图标
        let icon = system_icon_name(&desktop, &desktop).unwrap();
        assert!(icon.contains("kabegame-demo-icon"), "{icon}");
        // 文件夹
        let icon = system_icon_name(&dir, &dir).unwrap();
        assert!(icon.contains("folder"), "{icon}");
        // 不存在的文件按扩展名；没有扩展名就没有
        let missing = dir.join("nope.png");
        let icon = system_icon_name(&missing, &missing).unwrap();
        assert!(icon.contains("image"), "{icon}");
        let bare = dir.join("nope");
        assert_eq!(system_icon_name(&bare, &bare), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
