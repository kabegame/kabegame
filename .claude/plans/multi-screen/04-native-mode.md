# 04 · 原生模式：逐屏设置与系统自带的 span

## 总体设计思路

原生后端的 `set_wallpaper(file, style, transition, placement)` 按 `Placement` 分三路：

- `All`：现有路径不变（Windows `SPI` / `SetWallpaper(NULL)`、macOS 所有屏、GNOME / Plasma 所有桌面）。
- `One { screen }`：逐屏 API——Windows `IDesktopWallpaper::SetWallpaper(screen.id)`，macOS `NSWorkspace.setDesktopImageURL(_:for:options:)`，Plasma 按 containment 的屏（P6）。
- `Span`：**只用系统自带的跨屏铺放，不生成派生图片**。Windows 是壁纸位置 `DWPOS_SPAN`（注册表 `WallpaperStyle = 22`），GNOME 是 `picture-options = spanned`；两者都是在 `All` 路径上换一个位置值，图片仍是原文件。macOS 与 Plasma 没有系统级的跨屏铺放，span 在这两处标为不可用。

span 的铺放方式由系统决定（Windows 与 GNOME 都是按比例盖满整个桌面），所以 span 目标**没有样式可选**：能力表只给一个 `fill`，设置页样式行只读。过渡与 `multiple` 相同（Windows 的 `none` / `fade`，其余跟随系统），满足「span 最多只有淡入淡出」。

离开 span 时不需要专门还原：`All` / `One` 每次输出都会按目标的样式重写系统位置。

Windows 的 `IDesktopWallpaper` 是 COM，必须在初始化过 STA 的固定线程上调用；新增一个常驻的壁纸 COM 线程，原生后端经 channel 把操作投给它（旧调研 `wallpaper-multi-monitor.md` §2.1 Q2）。它只为 `One`（single）服务，span 用不到。

## 现状锚点

**a. Windows COM 总是所有显示器**（`manager/native.rs` `set_wallpaper_via_com`）
```rust
let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);          // 现状：在调用方线程上临时初始化
let desktop_wallpaper: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)?;
desktop_wallpaper.SetWallpaper(None, wallpaper_path)?;           // 现状：monitorID = None
```

**b. Windows 样式写注册表（全局），没有 span 这一档**（同文件 `set_style`，`:632`）
```rust
// center: WallpaperStyle = 0, TileWallpaper = 0
// tile: WallpaperStyle = 0, TileWallpaper = 1
// stretch: WallpaperStyle = 2, TileWallpaper = 0
// fit: WallpaperStyle = 6, TileWallpaper = 0
// fill: WallpaperStyle = 10, TileWallpaper = 0
// 现状：没有 22（跨区）
desktop_key.set_value("WallpaperStyle", …); desktop_key.set_value("TileWallpaper", …);
// 然后广播 WM_SETTINGCHANGE 并重设一次当前壁纸
```

**c. Windows 过渡：fade 走 COM、none 走 SPI(fuWinIni=1)**（同文件 `set_wallpaper_path`）
```rust
if transition == "fade" { self.ensure_fade_enabled(); if self.set_wallpaper_via_com(&wide_path).is_ok() { return Ok(()) } … }
let fu_win_ini = if transition == "none" { 1 } else { 3 };   // 现状：none 只能靠 SPI，SPI 不能逐屏
```

**d. macOS 用 osascript 设所有桌面，样式只有 fill**（同文件）
```rust
let script = format!(r#"tell application "System Events"
    tell every desktop
        set picture to "{}"
    end tell
end tell"#, escaped_path);
// supported_styles() => style_options(&["fill"])
```

**e. GNOME 的 spanned 未暴露**（同文件 `style_to_gnome_picture_options`，`:136`）
```rust
// spanned: 多显示器横向拼接（暂不暴露）
match style { "fill" => "zoom", "fit" => "scaled", "center" => "centered", "stretch" => "stretched", "tile" => "wallpaper", _ => "zoom" }
```

**f. 兼容副本入口**（`set_wallpaper_path` 开头）
```rust
let file_path_owned = kabegame_core::wallpaper_compat::ensure_native_wallpaper_path(file_path).await;  // Windows / Linux
```

---

## 点 1 — 原生后端按 `Placement` 分派（`manager/native.rs`）

- **修改**
```rust
async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str,
                       placement: &Placement) -> Result<(), String> {
    let file_path = ensure_native_wallpaper_path(file_path).await;      // 现状逻辑保留
    match placement {
        Placement::All { .. } => self.set_all(&file_path, style, transition).await,   // = 现有 set_style + set_wallpaper_path 合并
        Placement::One { screen } => self.set_one(&file_path, style, screen).await,
        // 新增：系统位置换成跨屏，其余与 All 相同；style 参数忽略
        Placement::Span => self.set_all(&file_path, SYSTEM_SPAN, transition).await,
    }
}
```
  - `SYSTEM_SPAN` 是后端内部的位置值，不进设置、不进能力表：Windows 的位置映射加一行 `(22, 0)`，GNOME 的映射加一行 `"spanned"`。
- **修改** 能力
```rust
fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
    match display {
        DisplayMode::Multiple => None,
        DisplayMode::Span if cfg!(target_os = "windows") || is_gnome() => None,
        DisplayMode::Span => Some("settings.displayModeSpanNoSystem"),            // macOS / Plasma：系统没有跨屏铺放
        DisplayMode::Single if is_gnome() => Some("settings.displayModeSingleGnome"),
        DisplayMode::Single if is_plasma() => Some("settings.displayModeLater"),  // P6
        DisplayMode::Single => None,
    }
}
fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption> {
    // 新增：span 只给 fill（系统决定铺放）；其余同现状（macOS 见点 3）
}
fn shared_style(&self, display: DisplayMode) -> bool {
    cfg!(target_os = "windows") && display == DisplayMode::Single   // 系统只有一个全局 position
}
fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption> {
    // Windows：multiple / span 保持 none / fade；single 走逐屏 COM，只有「跟随系统」
}
```

## 点 2 — Windows 逐屏（`manager/native_win_com.rs`，新增）

- **新增** 常驻 STA 线程
```rust
enum ComOp {
    SetWallpaper { monitor: Option<Vec<u16>>, path: Vec<u16>, reply: oneshot::Sender<Result<(), String>> },
    SetPosition { pos: DESKTOP_WALLPAPER_POSITION, reply: … },
}
/// 首次使用时起线程：CoInitializeEx(APARTMENTTHREADED) 一次、CoCreateInstance 一次并复用实例。
pub async fn set_wallpaper(monitor: Option<&str>, path: &Path) -> Result<(), String>;
pub async fn set_position(style: &str) -> Result<(), String>;   // DWPOS_CENTER/TILE/STRETCH/FIT/FILL
```
  - `screen.id` 就是 `IDesktopWallpaper` 的 monitorID（01 点 1），直接传，不再枚举对照。
  - `GetMonitorRECT` 对断开的屏失败——但我们只对在线屏调用，不需要过滤。
- **修改** `set_one`（Windows）：`set_position(style)`（single 下样式共用，等价全局）→ `set_wallpaper(Some(screen.id), path)`。
- **修改** 现有 `set_wallpaper_via_com` 改走这条线程（`monitor = None`），去掉每次调用的 `CoInitializeEx`。
- 样式：single 时 `shared_style = true`，`set_wallpaper_style` 命令把同一值写进所有屏的目标（02 点 4），系统 position 只有一个，语义一致。

## 点 3 — macOS 逐屏（`manager/native_mac.rs`，新增）

- **新增**
```rust
/// 主线程：按 UUID 找 NSScreen（每次现查，防热插拔后对象失效），
/// setDesktopImageURL(url, forScreen, options)；
/// options：fill → ImageScaling=ProportionallyUpOrDown + AllowClipping=true；
///          fit → ProportionallyUpOrDown + AllowClipping=false；stretch → AxesIndependently；
///          center → ImageScaling=None；FillColor 黑。
pub fn set_desktop_image(screen_id: &str, path: &Path, style: &str) -> Result<(), String>;
```
- **修改** `Placement::All` 在 macOS 也改用它（对每块在线屏调一次），删除 osascript 路径；`supported_styles` 从 `["fill"]` 扩到 `fill fit stretch center`（tile 没有对应项，不提供）。
  > 说明：`setDesktopImageURL` 只改该屏**当前 Space**——与 osascript `every desktop` 的现状行为相同，记入已知限制。
- macOS 没有 span：`unavailable_reason(Span)` 返回原因（点 1），窗口模式也不支持，所以 macOS 上「跨屏拼接」始终置灰。

## 点 4 — span：系统位置（Windows / GNOME）

- **修改** Windows 位置映射（现状 b）加 `SYSTEM_SPAN => (22, 0)`；`set_all` 的其余步骤（写注册表、广播、按过渡走 COM 或 SPI）不变。
  > 说明：`WallpaperStyle = 22` 自 Windows 8 起提供，系统把图片按比例盖满整个虚拟桌面再分到各屏。只接一块屏时效果等同 fill。
- **修改** GNOME 映射（现状 e）加 `SYSTEM_SPAN => "spanned"`，去掉「暂不暴露」注释。
- 屏幕排布变化时系统自己重排，应用不需要重新输出。
- **不做**：把图片按并集裁成每屏一张再逐屏设置（静态拼接）。macOS / Plasma 上的 span 因此不提供；以后要做再单独立项。

## 点 5 — Linux（P6）

- GNOME single：❌。以后若要做，只能把各屏目标的当前图合成一张并集图 + `spanned`（HydraPaper 的做法），属于派生图片，同样不在本计划内。
- Plasma single（P6）：`desktops()` 的 `d.screen` 是易变序号，用 `screenGeometry(d.screen)` 与 01 的屏几何按矩形对上再分派。
- Plasma span：❌（系统没有跨屏铺放）。
- `plasma-plugin`：只有 multiple，不改。
