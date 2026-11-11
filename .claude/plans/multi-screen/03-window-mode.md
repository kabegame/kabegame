# 03 · 窗口模式：每屏一窗

## 总体设计思路

**窗口模型只有一种：每块在线屏一个壁纸窗口，窗口矩形就是那块屏，完整渲染一幅画面。** 窗口模式支持两种显示器模式，区别只是每个窗口显示哪个目标：

| 显示器模式 | 每个窗口显示的目标 |
|---|---|
| multiple | `multiple`（同一个，各窗口各自完整渲染） |
| single | `screen:<本屏>` |
| span | **暂不支持**：能力表里标为不可用，原因「窗口模式暂不支持跨屏拼接」 |

span 在窗口模式下需要每个窗口只露出并集画面的一块，并让视频、场景跨窗口对齐，工作量与已知限制都偏大，暂缓；设计留在 [90-window-span-deferred.md](90-window-span-deferred.md)。原生模式的 span 只在系统自带跨屏铺放的平台提供（Windows、GNOME，见 [04-native-mode.md](04-native-mode.md)），所以 macOS 上 span 两种壁纸模式都不可用。从原生模式的 span 切到窗口模式时，控制器先把显示器模式回落到 `multiple`（02 点 4 的 `set_wallpaper_mode`）。

不开「一个大窗口跨所有屏」：每屏一窗让每个窗口用本屏自己的 DPI 与刷新率，两种模式共用一套建窗 / 挂载 / 就绪 / ping / 转发代码，热插拔只是增删窗口。

窗口集合由 `WindowWallpaperManager::reconcile(&Layout)` 对齐：按在线屏算出期望的窗口表，与现有窗口按屏幕 id 比对——同一块屏保留原窗口，矩形变了重挂，目标变了推一条新的布置，多出的销毁，缺的新建。窗口仍是自驱动的观察方：后端只给每个窗口一条布置 `{ targetId, audible }`（显示哪个目标、出不出声），样式、过渡、当前壁纸它自己从 `setting-change` 里的 `wallpaperTargets[targetId]` 读。`WallpaperStage` 不改。

multiple 下同一个视频在几个窗口里各播一份：只有主屏窗口出声；各窗口的播放位置不做对齐（各屏是各自完整的一幅，不存在接缝，错开几十毫秒看不出来）。若真机上觉得需要对齐，按 90 文档里「系统时钟对位」那一小段单独加，不依赖切片。

## 现状锚点

**a. 壁纸窗口读扁平设置**（`apps/kabegame/src/views/WallpaperWindow.vue` `init`）
```ts
if ("wallpaperStyle" in changes) state.styleMode = changes.wallpaperStyle as Mode;
if ("wallpaperRotationTransition" in changes) state.transition = …;
if ("currentWallpaperImageId" in changes) acceptTarget(await invoke("get_current_wallpaper_target"));
// 启动：get_wallpaper_rotation_style / get_wallpaper_rotation_transition / get_current_wallpaper_target …
```

**b. 唯一窗口、全屏到所在屏**（`src-tauri/kabegame/src/wallpaper/manager/window.rs`）
```rust
pub const WALLPAPER_LABEL: &str = "wallpaper";
pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>,   // 现状：Option，单个
}
// create_window(): allow_file_documents / allow_app_local_resources / disable_wheel_zoom(WALLPAPER_LABEL)
//                  WebviewWindowBuilder::new(.., WALLPAPER_LABEL, "index.html?window=wallpaper").fullscreen(true)
```

**c. 就绪握手是进程级单值**（`wallpaper/window.rs`）
```rust
static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();   // 现状：一个 bool + Condvar
```

**d. Windows 挂载按「屏序号或所在屏」取矩形**（`tauri-plugin-wemt/src/models.rs`、`platform/windows.rs:282`）
```rust
pub struct AttachOptions { pub monitor: Option<u32>, pub show_host: bool }   // 现状：None = 窗口所在屏
pub fn monitor_for(hwnd: isize, index: Option<u32>) -> Result<(MonitorInfo, Rect)>;  // wemt 自己枚举的序号
```

**e. macOS 挂载铺满窗口所在屏**（`wallpaper/window_mount_macos.rs`）
```rust
let screen_frame = ns_window.screen().as_ref().map(|s| s.frame())
    .or_else(|| NSScreen::mainScreen(mtm).as_ref().map(|s| s.frame()))?;   // 现状：所在屏 / 主屏
```

**f. label 写死的地方**
```text
kabegame/src/lib.rs:611                       .acl_exempt_webview("wallpaper")
kabegame/capabilities/main.json:5             "windows": ["wallpaper", "main"]
kabegame/capabilities/wpe-web.json:5          "windows": ["main", "wallpaper"]
kabegame/src/wallpaper/wpe_scene_host.rs:196  .windows(["main", "wallpaper"])
kabegame/src/commands/window.rs:26            app.get_webview_window("wallpaper")   // macOS fix_wallpaper_zorder
```

---

## 点 1 — 窗口池与 label（`manager/window.rs`、`lib.rs`、capabilities）

- **新增**
```rust
/// 壁纸窗口 label 池：slot 0 沿用 "wallpaper"，其余 "wallpaper-1".."wallpaper-7"。
/// ACL 特赦在 Builder 期登记，固定池免改 tauri 补丁 17；超过 8 块屏只开前 8 个并告警。
pub const WALLPAPER_LABELS: [&str; 8] = ["wallpaper", "wallpaper-1", /* … */ "wallpaper-7"];
pub fn is_wallpaper_label(label: &str) -> bool { WALLPAPER_LABELS.contains(&label) }
```
- **修改** `lib.rs` 对池里每个 label 调 `acl_exempt_webview`；`capabilities/main.json(.handlebars)`、`wpe-web.json` 的 `windows` 列出整个池；`wpe_scene_host.rs:196` 的运行时 capability 同；`fix_wallpaper_zorder`（macOS）对所有在册窗口重挂。

## 点 2 — manager 持有窗口表并 reconcile（`manager/window.rs`）

- **修改**
```rust
/// 后端发给窗口的布置。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowAssignment {
    pub target_id: String,
    pub audible: bool,   // multiple：只有主屏窗口为 true；single：全为 true
}

struct Slot<R: Runtime> { window: WallpaperWindow<R>, screen: ScreenInfo, assignment: WindowAssignment }

pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    slots: Arc<Mutex<BTreeMap<String /* label */, Slot<R>>>>,   // 修改：Option → 表
}

/// 每块在线屏一条：multiple → 目标 "multiple"；single → 目标 "screen:<id>"。
fn plan_windows(layout: &Layout) -> Vec<(ScreenInfo, WindowAssignment)>;

impl<R: Runtime> WallpaperManager for WindowWallpaperManager<R> {
    fn reconcile(&self, layout: &Layout) -> Result<(), String> {
        // 1. 按 screen.id 与现有 slot 匹配（同一块屏保留 label，不重建）
        // 2. 屏矩形变了：window.remount(rect)
        // 3. assignment 变了：记下并 emit_to(label, "wallpaper-assignment", &assignment)
        // 4. 多余的 slot：detach + destroy（现有 cleanup 的单窗口拆除逻辑）
        // 5. 缺的：取空闲 label → create_window(label, rect) → mount(rect) → 记 assignment（窗口 init 时自己来取）
    }
    fn init(&self) -> Result<(), String> { self.reconcile(&WallpaperController::global().layout()) }
    fn cleanup(&self) -> Result<(), String> { /* 对每个 slot 执行拆除 */ }

    async fn set_wallpaper(&self, file_path: &str, _style: &str, _transition: &str,
                           placement: &Placement) -> Result<(), String> {
        // 内容由窗口自驱动；这里只按壁纸类型给「显示该目标的窗口」开关鼠标转发（判定同现状）
    }
    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
        (display == DisplayMode::Span).then_some("settings.displayModeSpanWindow")   // 暂不支持
    }
}
```
- **修改** `create_window(label, rect)`：去掉 `.fullscreen(true)`，无边框，建窗时位置 / 大小设成目标屏矩形（避免挂载前跳到主屏）；CEF 三个登记按传入 label。
- **修改** `warn_if_window_missing`：改成「layout 里有在线屏但没有对应 slot」时告警。
- **新增** 命令 `get_wallpaper_window_assignment()`：按调用方 label 查 slot（只有壁纸窗口会调，免 ACL，注册进 `generate_handler!`）。

## 点 3 — 挂载到指定屏（wemt / macOS）

- **修改** `tauri-plugin-wemt/src/models.rs`
```rust
pub struct AttachOptions {
    pub monitor: Option<u32>,
    /// 新增：直接给桌面坐标矩形（物理像素），优先于 monitor。
    /// 我们的屏枚举（01）与 wemt 自己的枚举序号不保证一致，按矩形传最稳。
    pub rect: Option<Rect>,
    pub show_host: bool,
}
```
  - `platform/windows.rs`：`rect` 有值就直接用（上报用的 `MonitorInfo` 取与之相交面积最大的屏）。`mount` 本身不改（已用 `MapWindowPoints` 换到宿主客户区坐标）。
- **修改** `wallpaper/window.rs`：`WallpaperWindow::mount(rect)`；新增 `remount(rect)`（Windows 再调一次 `SetWindowPos`，macOS 重设 frame）。
- **修改** `window_mount_macos.rs`
```rust
/// 修改：传入目标屏矩形（左上原点的点坐标），内部翻回 Cocoa 坐标后 setFrame。
pub fn mount_to_desktop<R: Runtime>(window: &WebviewWindow<R>, rect: Rect) -> Result<isize, String>;
```
  每个窗口同样的层级与 `CanJoinAllSpaces | Stationary`，各自 frame 到各自屏，不受「显示器具有单独的空间」设置影响。

## 点 4 — 就绪、ping、鼠标转发、媒体订阅按 label

- **修改** 就绪：`WALLPAPER_WINDOW_READY` 改成 `Mutex<HashSet<String>> + Condvar`；`wallpaper_window_ready` 命令按调用方 label 标记；`wait_ready(label, timeout)`；销毁窗口时移除该 label。
- **ping**：`Pinger::start(label, …)` 已按 label，每个 slot 一个，逻辑不改。
- **鼠标转发**：每个窗口一个 `InputForwarder`（N ≤ 8，各自 60 Hz 读光标，开销可忽略），只为当前显示网页 / 场景的窗口开。`Sample.inside` 已按各自窗口矩形判断，光标在哪块屏就只有那个窗口收到 Move，其它窗口收到一次 Leave。
- **WPE 媒体订阅**：已按 `(label, SubframeId, 类型)` 归属、窗口销毁释放整个 label，多窗口无需改；确认 `WpeMediaHub` 多订阅共用一路 WASAPI 采集（现状如此）。

## 点 5 — 壁纸窗口前端（`views/WallpaperWindow.vue`）

- **修改**
```ts
const assignment = ref<WindowAssignment | null>(null);

// init：先拿 assignment，再读目标配置与当前壁纸
assignment.value = await invoke<WindowAssignment>("get_wallpaper_window_assignment");
listen<WindowAssignment>("wallpaper-assignment", (e) => { assignment.value = e.payload; void refreshFromTarget(); });

// setting-change：只看 wallpaperTargets[assignment.targetId] 与全局的音量 / 倍速 / 暂停 / wallpaperMode
if ("wallpaperTargets" in changes) {
  const cfg = changes.wallpaperTargets[assignment.value.targetId];
  state.styleMode = effectiveStyle(cfg);        // 用能力表归一化（get_wallpaper_capabilities），与后端同一规则
  state.transition = effectiveTransition(cfg);
  if (cfg.currentImageId !== lastImageId) acceptTarget(await invoke("get_current_wallpaper_target"));
}
```
```vue
<!-- 修改：只有音量按 audible 取 0；其余 props 不变 -->
<WallpaperStage … :volume="assignment?.audible === false ? 0 : state.volume" interactive />
<!-- 调试面板加显示 label / targetId -->
```
- **删除** 对 `get_wallpaper_rotation_style` / `get_wallpaper_rotation_transition` 的调用（命令本身在 02 点 4 删除）。
- `WallpaperStage.vue` 与场景宿主**不改**。

## 点 6 — 成本与已知限制

- multiple / single 下网页与场景每块屏各渲染一份（N 个页面实例 / N 次场景渲染），与 WPE 多屏各开一份相同。
- multiple 下各窗口的视频、场景动画、网页状态互不同步；声音只由主屏窗口发出。
- 网页壁纸的 `localStorage` 各窗口共用同一分区（现状：预览与桌面也共用），多实例同时写由页面自己负责。
