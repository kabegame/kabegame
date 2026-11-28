//! 插件模式（Linux）的鼠标回传：Plasma 壁纸插件把落在桌面上的鼠标事件经一个只收不回的 Unix 数据报 socket 发过来，
//! 这里换成离屏壁纸窗口的视图坐标，推给 `tauri-plugin-cursor` 的外部来源（窗口按消息里的 slot 找）。之后的 frame 登记、
//! 点击规则（光标下是桌面）、按下抬起配对、经 CEF 补丁 11 注入 frame，都与 Windows / macOS 的壁纸窗口相同。
//!
//! - 位置：`$XDG_RUNTIME_DIR/kabegame[-dev]/wallpaper-input.sock`（dev 与已安装版各一个，同 CEF profile 的区分），
//!   经 PipeWire 节点属性 `kabegame.wallpaper.input` 告诉插件。`XDG_RUNTIME_DIR` 只有本用户能进，别的用户发不进来。
//! - `SOCK_DGRAM`：一条消息一个包，不用分帧；插件只管 `sendto`（不阻塞），没有连接，Kabegame 重启后不用重连，发不出去就丢。
//! - 消息见 [`Message::parse`]。只收不回；一条线程阻塞读，进程退出时随之结束（socket 文件在下次启动时先删再建）。
//! - 插件只在事件到达 plasmashell 的桌面窗口时才发，事件到了就说明光标下是桌面（图标上也算，同 Windows）。
//! - 主窗口（图库预览里的网页 / 场景壁纸）也跟桌面上的光标，同 Windows 的全局光标：消息带光标的全局逻辑坐标，主窗口在哪由
//!   KWin 给（`kwin_window`，Wayland 下应用自己不知道），扣掉窗口装饰换成主窗口的视图坐标，推给主窗口的外部来源。主窗口的
//!   点击规则是「光标下是本窗口」，桌面上的光标只带移动、不点击。
//! - 光标在主窗口里时，主窗口的页面把自己收到的鼠标经命令 `push_window_pointer` 交给应用，应用也发到这个 socket（[`Kind::Window`]
//!   / [`Kind::WindowLeave`]，与插件的消息在同一条线程里依次处理）：主窗口的外部来源收「窗口」来源的样本（移动与点击，同 Windows 的
//!   预览），桌面壁纸经 KWin 的主窗口几何换回全局坐标、只收移动。桌面与窗口两种来源交接时晚到的离开由 `tauri-plugin-cursor` 忽略。
//! - GNOME：壁纸窗口是普通窗口，鼠标直接进窗口，壁纸页面同主窗口经 `push_window_pointer` 交给应用、发到这个 socket（[`Kind::Wallpaper`]
//!   / [`Kind::WallpaperLeave`]）：壁纸窗口收自己的样本，主窗口经壁纸窗口的位置换成全局坐标后跟着走。窗口位置问 Kabegame 的
//!   GNOME Shell 扩展（`manager::gnome::window_locator`），不问 KWin；主窗口里的光标换到壁纸窗口上也按壁纸窗口的位置换。

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixDatagram;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{Manager, Runtime};
use tauri_plugin_cursor::{PointerOrigin, Sample};

use super::gnome::window_locator::GnomeWindowLocator;
use super::plasma::kwin_window::KwinWindowLocator;

/// 输入消息的版本：就是约定版本（节点属性 `kabegame.wallpaper.protocol`、插件的 `PROTOCOL`）。
pub const PROTOCOL_VERSION: u16 = super::plasma::pipewire::PROTOCOL_VERSION as u16;
/// 每条消息的字节数。
const MESSAGE_LEN: usize = 32;
/// `buttons` 里左键的位。
const LEFT_BUTTON_BIT: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Move,
    Button,
    /// 光标离开了桌面（进了别的窗口、面板、别的屏）。
    Leave,
    /// 滚轮（预留，收下丢弃）。
    Axis,
    /// 光标在主窗口里（应用自己发）：x, y 是主窗口视图坐标，dx, dy 是视口宽高。
    Window,
    /// 光标离开了主窗口（应用自己发）：dx, dy 是视口宽高。
    WindowLeave,
    /// 光标在普通壁纸窗口里（GNOME，应用自己发）：x, y 是壁纸窗口视图坐标，dx, dy 是视口宽高，slot 是窗口在池里的序号。
    Wallpaper,
    /// 光标离开了普通壁纸窗口（GNOME，应用自己发）。
    WallpaperLeave,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Message {
    kind: Kind,
    slot: u32,
    x: f32,
    y: f32,
    /// 事件之后按着的键：bit0 左、bit1 右、bit2 中。
    buttons: u32,
    /// kind = 1 / 2：光标的全局逻辑坐标；kind = 4：滚轮；kind = 5–8：窗口视口的宽高。
    dx: f32,
    dy: f32,
}

impl Message {
    /// 小端、定长 32 字节：
    ///
    /// ```text
    /// u16 version = 1
    /// u16 kind      // 插件发：1 move, 2 button, 3 leave, 4 axis（预留）；应用自己发：5 window, 6 window-leave,
    ///               // 7 wallpaper, 8 wallpaper-leave（GNOME 的普通壁纸窗口）
    /// u32 slot      // 节点属性 kabegame.wallpaper.slot；7 / 8 是壁纸窗口在池里的序号；5 / 6 不用
    /// f32 x, y      // 1 / 2：在插件壁纸 item 里的归一化坐标 0..1（可越界）；5 / 7：窗口视图坐标（CSS 像素）；3 / 6 / 8 不用
    /// u32 button    // kind = 2：变化的那个键（Linux BTN_*），这边只看 buttons
    /// u32 buttons   // 事件之后按着的键：bit0 左、bit1 右、bit2 中
    /// f32 dx, dy    // 1 / 2：光标的全局逻辑坐标（屏的左上角 + 桌面窗口里的位置，与 KWin 的窗口几何同一套）；4：滚轮；
    ///               // 5 / 6 / 7 / 8：窗口视口的宽高（页面在光标不在窗口里时也以离开报视口）
    /// ```
    ///
    /// 每条消息都带按键全集（而不是只在按键消息里带变化），丢一条按键消息也不会让左键一直按着。
    fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != MESSAGE_LEN {
            return None;
        }
        let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let f32_at = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        if u16_at(0) != PROTOCOL_VERSION {
            return None;
        }
        let kind = match u16_at(2) {
            1 => Kind::Move,
            2 => Kind::Button,
            3 => Kind::Leave,
            4 => Kind::Axis,
            5 => Kind::Window,
            6 => Kind::WindowLeave,
            7 => Kind::Wallpaper,
            8 => Kind::WallpaperLeave,
            _ => return None,
        };
        Some(Self {
            kind,
            slot: u32_at(4),
            x: f32_at(8),
            y: f32_at(12),
            buttons: u32_at(20),
            dx: f32_at(24),
            dy: f32_at(28),
        })
    }

    /// 光标的全局逻辑坐标（移动与按键消息）。
    fn global(&self) -> Option<(f64, f64)> {
        let (x, y) = (f64::from(self.dx), f64::from(self.dy));
        (matches!(self.kind, Kind::Move | Kind::Button) && x.is_finite() && y.is_finite()).then_some((x, y))
    }
}

/// 一路（一个 slot）的状态：离开时用最后的位置。
#[derive(Debug, Default)]
struct SlotState {
    last: (f64, f64),
}

/// 消息 → 视图坐标的样本（`size` 是离屏视图的逻辑尺寸）。滚轮、坐标不是有限数时 `None`。
fn to_sample(state: &mut SlotState, message: &Message, size: (f64, f64)) -> Option<Sample> {
    let left_down = message.buttons & LEFT_BUTTON_BIT != 0;
    match message.kind {
        Kind::Axis | Kind::Window | Kind::WindowLeave | Kind::Wallpaper | Kind::WallpaperLeave => None,
        Kind::Leave => Some(Sample {
            view: state.last,
            inside: false,
            left_down,
            present: false,
        }),
        Kind::Move | Kind::Button => {
            let (x, y) = (f64::from(message.x), f64::from(message.y));
            if !(x.is_finite() && y.is_finite()) {
                return None;
            }
            let view = (x * size.0, y * size.1);
            state.last = view;
            Some(Sample {
                view,
                inside: (0.0..1.0).contains(&x) && (0.0..1.0).contains(&y),
                left_down,
                present: true,
            })
        }
    }
}

/// 窗口装饰最多多大（逻辑像素）：框架比主窗口视图大出这么多以内才对得上。宽多出的是两侧边框，高多出的是标题栏加上下边框。
const MAX_DECORATION: (f64, f64) = (40.0, 80.0);
/// 尺寸取整的误差（CEF 的视图尺寸与 KWin 的几何各自取整）。
const SIZE_SLACK: f64 = 2.0;

/// 全局坐标 `global` 换到主窗口视图里：`frame` 是 KWin 给的框架几何（含装饰），`view_size` 是主窗口视图的逻辑尺寸。两侧边框
/// 各占宽度差的一半，下边框同侧边框，其余是标题栏。尺寸对不上（差得比装饰还多）时 `None`。
fn window_view_point(global: (f64, f64), frame: FrameGeometry, view_size: (f64, f64)) -> Option<(f64, f64)> {
    let (extra_w, extra_h) = (frame.width - view_size.0, frame.height - view_size.1);
    let fits = |extra: f64, max: f64| (-SIZE_SLACK..=max).contains(&extra);
    if !(fits(extra_w, MAX_DECORATION.0) && fits(extra_h, MAX_DECORATION.1)) {
        return None;
    }
    let side = (extra_w / 2.0).max(0.0);
    let top = (extra_h - side).max(0.0);
    Some((global.0 - frame.x - side, global.1 - frame.y - top))
}

/// [`window_view_point`] 的反方向：主窗口视图坐标换回全局坐标。
fn window_global_point(view: (f64, f64), frame: FrameGeometry, view_size: (f64, f64)) -> (f64, f64) {
    let (extra_w, extra_h) = (frame.width - view_size.0, frame.height - view_size.1);
    let side = (extra_w / 2.0).max(0.0);
    let top = (extra_h - side).max(0.0);
    (view.0 + frame.x + side, view.1 + frame.y + top)
}

/// 窗口的框架几何（全局逻辑坐标，含装饰；KWin 与 GNOME Shell 扩展给的都是它）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 主窗口的 label。
const MAIN_LABEL: &str = "main";

/// 挂载着的普通壁纸窗口（GNOME）的 slot：只给这些窗口查位置（KWin 的定位器只缓存一个窗口，换着标题查会冲掉主窗口的）。
static WINDOWED_WALLPAPERS: std::sync::Mutex<std::collections::BTreeSet<u32>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// 普通壁纸窗口 `label` 挂载（`true`）或丢弃（`false`）。
pub fn set_windowed_wallpaper(label: &str, mounted: bool) {
    let Some(slot) = crate::wallpaper::WALLPAPER_LABELS.iter().position(|pooled| *pooled == label) else {
        return;
    };
    let mut slots = WINDOWED_WALLPAPERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if mounted {
        slots.insert(slot as u32);
    } else {
        slots.remove(&(slot as u32));
    }
}

fn is_windowed_wallpaper(slot: u32) -> bool {
    WINDOWED_WALLPAPERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&slot)
}
/// 主窗口的标题与视图尺寸隔多久重新取一次（取它们要经 runtime，不能每个鼠标事件都取）。
const MAIN_INFO_TTL: Duration = Duration::from_millis(500);
/// 窗口几何（KWin / Shell 扩展给的）隔多久重新取一次（光标在桌面上时主窗口很少同时在动）。
const MAIN_FRAME_TTL: Duration = Duration::from_millis(250);

/// 查窗口在全局坐标里的位置：Plasma 问 KWin，GNOME 问 Kabegame 的 Shell 扩展，其它桌面不查。
enum Locator {
    Kwin(KwinWindowLocator),
    Gnome(GnomeWindowLocator),
    None,
}

impl Locator {
    fn new() -> Self {
        use crate::linux_desktop::{linux_desktop, LinuxDesktop};
        match linux_desktop() {
            LinuxDesktop::Plasma => Self::Kwin(KwinWindowLocator::new()),
            LinuxDesktop::Gnome => Self::Gnome(GnomeWindowLocator::new()),
            LinuxDesktop::Unknown => Self::None,
        }
    }

    fn locate(&mut self, title: &str) -> Option<FrameGeometry> {
        match self {
            Self::Kwin(locator) => locator.locate(title),
            Self::Gnome(locator) => locator.locate(title),
            Self::None => None,
        }
    }
}

/// 主窗口的标题（在 KWin 里认窗口）与视图逻辑尺寸的候选（取尺寸的接口单位不确定时给几种读法，取第一个对得上的）。
#[derive(Debug, Clone, PartialEq)]
pub struct MainWindowInfo {
    pub title: String,
    pub view_sizes: Vec<(f64, f64)>,
}

/// 取主窗口的信息；主窗口不在时 `None`。
pub type MainWindowProbe = Box<dyn Fn() -> Option<MainWindowInfo> + Send>;

static SOCKET_PATH: OnceLock<Option<String>> = OnceLock::new();

/// 起输入 socket（进程内只起一次），返回它的路径（填进节点属性）；起不来返回 `None`（插件就不发鼠标）。
/// `main_window` 造取主窗口信息的函数，只在第一次起的时候用。主窗口同时登记成外部光标来源。
pub fn ensure_started(main_window: impl FnOnce() -> MainWindowProbe) -> Option<String> {
    SOCKET_PATH
        .get_or_init(|| match bind() {
            Ok((socket, path)) => {
                let path = path.display().to_string();
                let main_window = main_window();
                tauri_plugin_cursor::register_external_pointer(MAIN_LABEL);
                if let Err(error) = std::thread::Builder::new()
                    .name("wallpaper-input".into())
                    .spawn(move || receive(socket, main_window))
                {
                    tracing::warn!("壁纸鼠标回传线程起不来，插件模式的壁纸收不到鼠标: {error}");
                    return None;
                }
                tracing::info!("壁纸鼠标回传 socket: {path}");
                Some(path)
            }
            Err(error) => {
                tracing::warn!("壁纸鼠标回传 socket 起不来，插件模式的壁纸收不到鼠标: {error}");
                None
            }
        })
        .clone()
}

fn bind() -> Result<(UnixDatagram, PathBuf), String> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .ok_or("没有 XDG_RUNTIME_DIR")?;
    let dir = PathBuf::from(runtime).join(if cfg!(debug_assertions) {
        "kabegame-dev"
    } else {
        "kabegame"
    });
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 {} 失败: {e}", dir.display()))?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("设 {} 的权限失败: {e}", dir.display()))?;
    let path = dir.join("wallpaper-input.sock");
    // 上次没删掉的（单实例：同一份构建不会有别的进程在用）
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删旧的 {} 失败: {e}", path.display())),
    }
    let socket = UnixDatagram::bind(&path).map_err(|e| format!("绑定 {} 失败: {e}", path.display()))?;
    Ok((socket, path))
}

fn receive(socket: UnixDatagram, main_window: MainWindowProbe) {
    let mut slots: HashMap<u32, SlotState> = HashMap::new();
    let mut main = MainWindow::new(main_window);
    // 多读一个字节：长度不对的包（版本更高的插件）能认出来
    let mut buffer = [0u8; MESSAGE_LEN + 1];
    let mut rejected = 0u64;
    loop {
        let len = match socket.recv(&mut buffer) {
            Ok(len) => len,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::warn!("壁纸鼠标回传 socket 读失败，停止接收: {error}");
                return;
            }
        };
        let Some(message) = Message::parse(&buffer[..len]) else {
            rejected += 1;
            if rejected == 1 || rejected % 1000 == 0 {
                tracing::warn!("壁纸鼠标回传收到认不出的消息（{len} 字节，第 {rejected} 条）：插件与应用的协议版本不一致");
            }
            continue;
        };
        match (message.kind, message.global()) {
            // 主窗口自己发的：不经下面按 slot 的桌面路径
            (Kind::Window, _) => {
                main.on_window(&message);
                continue;
            }
            (Kind::WindowLeave, _) => {
                main.on_window_leave(&message);
                continue;
            }
            (Kind::Wallpaper, _) => {
                main.on_wallpaper(&message);
                continue;
            }
            (Kind::WallpaperLeave, _) => {
                main.on_wallpaper_leave(message.slot);
                continue;
            }
            (Kind::Leave, _) => main.on_leave(),
            (_, Some(global)) => main.on_global(global, message.buttons & LEFT_BUTTON_BIT != 0),
            _ => {}
        }
        let Some(label) = crate::wallpaper::WALLPAPER_LABELS.get(message.slot as usize) else {
            continue;
        };
        let Some(geometry) = tauri_runtime_kbcef::offscreen_geometry(label) else {
            continue;
        };
        let size = (f64::from(geometry.width), f64::from(geometry.height));
        let state = slots.entry(message.slot).or_default();
        if let Some(sample) = to_sample(state, &message, size) {
            tauri_plugin_cursor::push_external_pointer(label, sample, PointerOrigin::Desktop);
        }
    }
}

/// 一个带时间戳的缓存值。
struct Cached<T> {
    value: Option<(Instant, T)>,
    ttl: Duration,
}

impl<T: Clone> Cached<T> {
    fn new(ttl: Duration) -> Self {
        Self { value: None, ttl }
    }

    fn get(&mut self, fetch: impl FnOnce() -> T) -> T {
        match &self.value {
            Some((at, value)) if at.elapsed() < self.ttl => value.clone(),
            _ => {
                let value = fetch();
                self.value = Some((Instant::now(), value.clone()));
                value
            }
        }
    }
}

/// 主窗口这一路：主窗口信息与窗口几何的缓存、最后的位置（离开时用）；GNOME 下还有普通壁纸窗口的几何与最后的位置。
struct MainWindow {
    probe: MainWindowProbe,
    info: Cached<Option<MainWindowInfo>>,
    frame: Cached<Option<FrameGeometry>>,
    locator: Locator,
    last: Option<(f64, f64)>,
    /// 主窗口页面报的视口宽高（移动与离开消息都带）。运行时给的窗口尺寸在 Wayland 下客户端自绘标题栏时（GNOME）含标题栏与
    /// 阴影、对不上框架几何，这个是准的，排在候选尺寸最前面
    viewport: Option<(f64, f64)>,
    /// slot → 普通壁纸窗口（GNOME）的几何
    wallpaper_frames: HashMap<u32, Cached<Option<FrameGeometry>>>,
    /// slot → 普通壁纸窗口里最后的位置
    wallpaper_last: HashMap<u32, (f64, f64)>,
}

impl MainWindow {
    fn new(probe: MainWindowProbe) -> Self {
        Self {
            probe,
            info: Cached::new(MAIN_INFO_TTL),
            frame: Cached::new(MAIN_FRAME_TTL),
            locator: Locator::new(),
            last: None,
            viewport: None,
            wallpaper_frames: HashMap::new(),
            wallpaper_last: HashMap::new(),
        }
    }

    /// 普通壁纸窗口（GNOME）`slot` 的几何（Shell 扩展按标题找，见 `manager::window::WINDOWED_TITLE_PREFIX`）。
    fn wallpaper_frame(&mut self, slot: u32) -> Option<FrameGeometry> {
        let locator = &mut self.locator;
        self.wallpaper_frames
            .entry(slot)
            .or_insert_with(|| Cached::new(MAIN_FRAME_TTL))
            .get(|| locator.locate(&format!("{}{slot}", super::window::WINDOWED_TITLE_PREFIX)))
    }

    /// 光标在普通壁纸窗口里（GNOME，壁纸页面经应用发来）：壁纸窗口收移动与点击（光标下是桌面）；主窗口经壁纸窗口的位置换成全局
    /// 坐标后跟着走（同插件发来的桌面光标）。
    fn on_wallpaper(&mut self, message: &Message) {
        let view = (f64::from(message.x), f64::from(message.y));
        let size = (f64::from(message.dx), f64::from(message.dy));
        if ![view.0, view.1, size.0, size.1].iter().all(|v| v.is_finite()) {
            return;
        }
        let Some(label) = crate::wallpaper::WALLPAPER_LABELS.get(message.slot as usize) else {
            return;
        };
        let left_down = message.buttons & LEFT_BUTTON_BIT != 0;
        self.wallpaper_last.insert(message.slot, view);
        tauri_plugin_cursor::push_external_pointer(
            label,
            Sample {
                view,
                inside: (0.0..size.0).contains(&view.0) && (0.0..size.1).contains(&view.1),
                left_down,
                present: true,
            },
            PointerOrigin::Desktop,
        );
        if let Some(frame) = self.wallpaper_frame(message.slot) {
            self.on_global((frame.x + view.0, frame.y + view.1), left_down);
        }
    }

    /// 光标离开了普通壁纸窗口（GNOME）。
    fn on_wallpaper_leave(&mut self, slot: u32) {
        let Some(label) = crate::wallpaper::WALLPAPER_LABELS.get(slot as usize) else {
            return;
        };
        if let Some(view) = self.wallpaper_last.get(&slot).copied() {
            tauri_plugin_cursor::push_external_pointer(
                label,
                Sample {
                    view,
                    inside: false,
                    left_down: false,
                    present: false,
                },
                PointerOrigin::Desktop,
            );
        }
        self.on_leave();
    }

    fn on_global(&mut self, global: (f64, f64), left_down: bool) {
        let probe = &self.probe;
        let Some(info) = self.info.get(|| probe()) else {
            return;
        };
        let locator = &mut self.locator;
        let Some(frame) = self.frame.get(|| locator.locate(&info.title)) else {
            return;
        };
        let Some((view, size)) = self
            .viewport
            .into_iter()
            .chain(info.view_sizes.iter().copied())
            .find_map(|size| window_view_point(global, frame, size).map(|view| (view, size)))
        else {
            return;
        };
        self.last = Some(view);
        tauri_plugin_cursor::push_external_pointer(
            MAIN_LABEL,
            Sample {
                view,
                inside: (0.0..size.0).contains(&view.0) && (0.0..size.1).contains(&view.1),
                left_down,
                present: true,
            },
            PointerOrigin::Desktop,
        );
    }

    /// 光标离开了桌面（插件的离开）。
    fn on_leave(&mut self) {
        if let Some(view) = self.last {
            tauri_plugin_cursor::push_external_pointer(
                MAIN_LABEL,
                Sample {
                    view,
                    inside: false,
                    left_down: false,
                    present: false,
                },
                PointerOrigin::Desktop,
            );
        }
    }

    /// 光标在主窗口里（主窗口的页面经应用发来）：主窗口收移动与点击；桌面壁纸经 KWin 的主窗口几何换回全局坐标，只收移动
    /// （主窗口里的点击不是点在桌面上）。
    fn on_window(&mut self, message: &Message) {
        let view = (f64::from(message.x), f64::from(message.y));
        let size = (f64::from(message.dx), f64::from(message.dy));
        if ![view.0, view.1, size.0, size.1].iter().all(|v| v.is_finite()) {
            return;
        }
        self.last = Some(view);
        self.viewport = Some(size);
        tauri_plugin_cursor::push_external_pointer(
            MAIN_LABEL,
            Sample {
                view,
                inside: (0.0..size.0).contains(&view.0) && (0.0..size.1).contains(&view.1),
                left_down: message.buttons & LEFT_BUTTON_BIT != 0,
                present: true,
            },
            PointerOrigin::Window,
        );
        let probe = &self.probe;
        let Some(info) = self.info.get(|| probe()) else {
            return;
        };
        let locator = &mut self.locator;
        let Some(frame) = self.frame.get(|| locator.locate(&info.title)) else {
            return;
        };
        let global = window_global_point(view, frame, size);
        for (slot, label) in crate::wallpaper::WALLPAPER_LABELS.iter().enumerate() {
            // 离屏壁纸（Plasma）的视图就是它铺满的那块屏（目前只有一路、屏在全局坐标原点）；普通壁纸窗口（GNOME）按它的位置换
            let (origin, (width, height)) = if let Some(geometry) = tauri_runtime_kbcef::offscreen_geometry(label) {
                ((0.0, 0.0), (f64::from(geometry.width), f64::from(geometry.height)))
            } else if is_windowed_wallpaper(slot as u32) {
                match self.wallpaper_frame(slot as u32) {
                    Some(frame) => ((frame.x, frame.y), (frame.width, frame.height)),
                    None => continue,
                }
            } else {
                continue;
            };
            let wallpaper_view = (global.0 - origin.0, global.1 - origin.1);
            tauri_plugin_cursor::push_external_pointer(
                label,
                Sample {
                    view: wallpaper_view,
                    inside: (0.0..width).contains(&wallpaper_view.0) && (0.0..height).contains(&wallpaper_view.1),
                    left_down: false,
                    present: true,
                },
                PointerOrigin::Desktop,
            );
        }
    }

    /// 光标离开了主窗口（主窗口的页面经应用发来；页面在启动与窗口变大小时也以离开报视口）。桌面壁纸不动：光标若到了桌面上，
    /// 插件接着发。
    fn on_window_leave(&mut self, message: &Message) {
        let size = (f64::from(message.dx), f64::from(message.dy));
        if size.0.is_finite() && size.1.is_finite() && size.0 > 0.0 && size.1 > 0.0 {
            self.viewport = Some(size);
        }
        if let Some(view) = self.last {
            tauri_plugin_cursor::push_external_pointer(
                MAIN_LABEL,
                Sample {
                    view,
                    inside: false,
                    left_down: false,
                    present: false,
                },
                PointerOrigin::Window,
            );
        }
    }
}

/// 主窗口的标题与视图尺寸（[`ensure_started`] 用）。
pub fn main_window_probe<R: Runtime>(app: tauri::AppHandle<R>) -> MainWindowProbe {
    Box::new(move || {
        let main = app.get_webview_window(MAIN_LABEL)?;
        let size = main.inner_size().ok()?;
        let scale = main.scale_factor().ok()?.max(0.01);
        // kbcef 的窗口 browser 的 `inner_size` 给的是 CEF Views `GetSize()`（DIP），类型却是 `PhysicalSize`；
        // 两种读法都交出去，由匹配挑（runtime 以后改成真的物理像素也照样认得）
        let raw = (f64::from(size.width), f64::from(size.height));
        Some(MainWindowInfo {
            title: main.title().ok()?,
            view_sizes: vec![raw, (raw.0 / scale, raw.1 / scale)],
        })
    })
}

/// 应用自己往这个 socket 发的发送端（不绑地址，发完就丢）。
static SENDER: OnceLock<Option<UnixDatagram>> = OnceLock::new();

/// 主窗口的页面把自己收到的鼠标交过来：照协议拼成 [`Kind::Window`] / [`Kind::WindowLeave`] 发到 socket，和插件的消息在同一条线程
/// 里依次处理。`view` 是主窗口视图坐标（CSS 像素），`viewport` 是视口宽高。socket 没起来时丢掉。
pub fn send_window_pointer(view: (f64, f64), viewport: (f64, f64), left_down: bool, present: bool) {
    send_page_pointer(if present { 5 } else { 6 }, 0, view, viewport, left_down);
}

/// 普通壁纸窗口（GNOME）的页面把自己收到的鼠标交过来：拼成 [`Kind::Wallpaper`] / [`Kind::WallpaperLeave`] 发到 socket。`slot` 是窗口
/// 在池里的序号，其余同 [`send_window_pointer`]。
pub fn send_wallpaper_pointer(
    slot: u32,
    view: (f64, f64),
    viewport: (f64, f64),
    left_down: bool,
    present: bool,
) {
    send_page_pointer(if present { 7 } else { 8 }, slot, view, viewport, left_down);
}

fn send_page_pointer(kind: u16, slot: u32, view: (f64, f64), viewport: (f64, f64), left_down: bool) {
    let Some(Some(path)) = SOCKET_PATH.get() else {
        return;
    };
    let Some(sender) = SENDER
        .get_or_init(|| {
            let socket = UnixDatagram::unbound().ok()?;
            socket.set_nonblocking(true).ok()?;
            Some(socket)
        })
        .as_ref()
    else {
        return;
    };
    let message = encode_message(
        kind,
        slot,
        (view.0 as f32, view.1 as f32),
        if left_down { LEFT_BUTTON_BIT } else { 0 },
        (viewport.0 as f32, viewport.1 as f32),
    );
    // 发不出去（缓冲满）就丢，同插件
    let _ = sender.send_to(&message, path);
}

/// 照 [`Message::parse`] 的格式拼一条消息（`button` 字段恒为 0）。
fn encode_message(kind: u16, slot: u32, (x, y): (f32, f32), buttons: u32, (dx, dy): (f32, f32)) -> [u8; MESSAGE_LEN] {
    let mut out = [0u8; MESSAGE_LEN];
    out[0..2].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    out[2..4].copy_from_slice(&kind.to_le_bytes());
    out[4..8].copy_from_slice(&slot.to_le_bytes());
    out[8..12].copy_from_slice(&x.to_le_bytes());
    out[12..16].copy_from_slice(&y.to_le_bytes());
    out[20..24].copy_from_slice(&buttons.to_le_bytes());
    out[24..28].copy_from_slice(&dx.to_le_bytes());
    out[28..32].copy_from_slice(&dy.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(kind: u16, slot: u32, x: f32, y: f32, buttons: u32, delta: (f32, f32)) -> [u8; MESSAGE_LEN] {
        encode_message(kind, slot, (x, y), buttons, delta)
    }

    #[test]
    fn window_messages_parse_and_stay_out_of_the_desktop_path() {
        let message = Message::parse(&encode(5, 0, 120.5, 80.0, 1, (1199.0, 799.0))).unwrap();
        assert_eq!(message.kind, Kind::Window);
        assert_eq!((message.x, message.y, message.dx, message.dy, message.buttons), (120.5, 80.0, 1199.0, 799.0, 1));
        assert_eq!(Message::parse(&encode(6, 0, 0.0, 0.0, 0, (0.0, 0.0))).unwrap().kind, Kind::WindowLeave);
        // 没有全局坐标、也不会被当成桌面壁纸的样本
        assert_eq!(message.global(), None);
        let mut state = SlotState::default();
        assert!(to_sample(&mut state, &message, (2648.0, 1490.0)).is_none());
    }

    #[test]
    fn global_and_view_points_round_trip_through_the_frame() {
        let frame = FrameGeometry {
            x: 187.0,
            y: 292.5,
            width: 1199.25,
            height: 827.5,
        };
        let view = (1199.0, 799.0);
        let global = window_global_point((100.0, 200.0), frame, view);
        let back = window_view_point(global, frame, view).unwrap();
        assert!((back.0 - 100.0).abs() < 1e-9 && (back.1 - 200.0).abs() < 1e-9);
        // 视图左上角在框架里扣掉标题栏（28.375）与一侧边框（0.125）的位置
        assert_eq!(window_global_point((0.0, 0.0), frame, view), (187.125, 320.875));
    }

    #[test]
    fn parses_the_fixed_layout() {
        let message = Message::parse(&encode(2, 3, 0.25, 0.5, 1, (700.0, 300.0))).unwrap();
        assert_eq!(
            message,
            Message {
                kind: Kind::Button,
                slot: 3,
                x: 0.25,
                y: 0.5,
                buttons: 1,
                dx: 700.0,
                dy: 300.0,
            }
        );
        assert_eq!(message.global(), Some((700.0, 300.0)));
        // 离开、滚轮没有全局坐标
        assert_eq!(Message::parse(&encode(3, 0, 0.0, 0.0, 0, (1.0, 2.0))).unwrap().global(), None);
        assert_eq!(Message::parse(&encode(4, 0, 0.0, 0.0, 0, (1.0, 2.0))).unwrap().global(), None);
    }

    #[test]
    fn gnome_client_side_title_bar_fits_with_the_page_viewport() {
        // 实测（GNOME 50 嵌套会话，缩放 1.45）：mutter 的框架含 Chromium 自绘的标题栏，页面视口 1122x674
        let frame = FrameGeometry {
            x: 2592.0,
            y: 147.0,
            width: 1122.0,
            height: 722.0,
        };
        assert_eq!(
            window_view_point((2600.0, 200.0), frame, (1122.0, 674.0)),
            Some((8.0, 5.0))
        );
        // 运行时给的窗口尺寸含标题栏与阴影（1200x800），比框架还大，对不上
        assert_eq!(window_view_point((2600.0, 200.0), frame, (1200.0, 800.0)), None);
    }

    #[test]
    fn rejects_wrong_length_version_and_kind() {
        let good = encode(1, 0, 0.0, 0.0, 0, (0.0, 0.0));
        assert!(Message::parse(&good[..31]).is_none());
        let mut longer = [0u8; MESSAGE_LEN + 1];
        longer[..MESSAGE_LEN].copy_from_slice(&good);
        assert!(Message::parse(&longer).is_none());
        let mut version = good;
        version[0] = 2;
        assert!(Message::parse(&version).is_none());
        assert!(Message::parse(&encode(9, 0, 0.0, 0.0, 0, (0.0, 0.0))).is_none());
    }

    #[test]
    fn wallpaper_window_messages_carry_the_slot_and_stay_out_of_the_desktop_path() {
        let message = Message::parse(&encode(7, 1, 300.5, 20.0, 1, (1280.0, 800.0))).unwrap();
        assert_eq!(message.kind, Kind::Wallpaper);
        assert_eq!((message.slot, message.x, message.dx, message.buttons), (1, 300.5, 1280.0, 1));
        // dx / dy 是视口宽高，不是全局坐标：不能被当成插件发来的桌面光标
        assert_eq!(message.global(), None);
        assert_eq!(to_sample(&mut SlotState::default(), &message, (1.0, 1.0)), None);
        let leave = Message::parse(&encode(8, 1, 0.0, 0.0, 0, (0.0, 0.0))).unwrap();
        assert_eq!((leave.kind, leave.slot), (Kind::WallpaperLeave, 1));
    }

    #[test]
    fn normalized_coordinates_scale_to_the_view_and_leave_keeps_the_last_position() {
        let mut state = SlotState::default();
        let size = (2648.0, 1490.0);
        let sample = |state: &mut SlotState, kind, x, y, buttons| {
            to_sample(state, &Message::parse(&encode(kind, 0, x, y, buttons, (0.0, 0.0))).unwrap(), size)
        };
        let moved = sample(&mut state, 1, 0.5, 0.25, 0).unwrap();
        assert_eq!(moved.view, (1324.0, 372.5));
        assert!(moved.inside && moved.present && !moved.left_down);
        let pressed = sample(&mut state, 2, 0.5, 0.25, 1).unwrap();
        assert!(pressed.left_down);
        // 只按右键不算左键
        assert!(!sample(&mut state, 2, 0.5, 0.25, 2).unwrap().left_down);
        // 拖出范围：照给位置，不在范围内
        let outside = sample(&mut state, 1, 1.2, 0.25, 1).unwrap();
        assert!(!outside.inside && outside.present);
        let left = sample(&mut state, 3, 0.0, 0.0, 0).unwrap();
        assert_eq!(left.view, outside.view);
        assert!(!left.present && !left.inside);
        assert!(sample(&mut state, 4, 0.0, 0.0, 0).is_none(), "滚轮先丢弃");
        assert!(sample(&mut state, 1, f32::NAN, 0.0, 0).is_none());
    }

    #[test]
    fn global_points_map_into_the_main_window_without_the_decoration() {
        // 实测（KWin 6.6.4，缩放 1.45）：主窗口视图 1199×799，框架 (776.38, 470.72) 1199.31×827.59（标题栏约 28.6）
        let frame = FrameGeometry {
            x: 776.375,
            y: 470.75,
            width: 1199.25,
            height: 827.5,
        };
        let view = (1199.0, 799.0);
        let (x, y) = window_view_point((876.5, 699.25), frame, view).unwrap();
        assert!((x - 99.999).abs() < 0.01 && (y - 200.125).abs() < 0.01, "{x}, {y}");
        // 光标在窗口外（桌面上）：照给，可为负
        let (x, y) = window_view_point((100.0, 300.0), frame, view).unwrap();
        assert!(x < 0.0 && y < 0.0);
        // 尺寸对不上（拿错了窗口、或尺寸读法不对）不认
        assert!(window_view_point((0.0, 0.0), frame, (826.9, 551.0)).is_none());
        assert!(window_view_point((0.0, 0.0), frame, (1300.0, 799.0)).is_none());
        // 没有装饰（无边框窗口）与取整误差
        let borderless = FrameGeometry {
            x: 10.0,
            y: 20.0,
            width: 1198.0,
            height: 799.0,
        };
        assert_eq!(window_view_point((15.0, 25.0), borderless, view), Some((5.0, 5.0)));
    }

    #[test]
    fn cached_values_refresh_after_the_ttl() {
        let mut cached = Cached::new(Duration::from_millis(30));
        let mut calls = 0;
        assert_eq!(cached.get(|| { calls += 1; calls }), 1);
        assert_eq!(cached.get(|| { calls += 1; calls }), 1);
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(cached.get(|| { calls += 1; calls }), 2);
    }
}
