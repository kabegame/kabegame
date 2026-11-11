# 90 · 暂缓：窗口模式的 span（多窗口切片）

> **状态：暂缓，不在当前分期内。** 窗口模式下 `span` 在能力表里标为不可用（原因「窗口模式暂不支持跨屏拼接」），
> 原生模式的 span 只用系统自带的跨屏铺放（Windows、GNOME，见 [04-native-mode.md](04-native-mode.md)），不生成派生图片。
> 这里留着当时的设计，重启时以此为起点；重启前要先重新核对 `WallpaperStage` / 场景宿主的现状。
>
> 暂缓的原因：图片的切片很便宜，但视频要跨窗口对位、场景要视口感知 + 共享时钟、粒子 / 脚本 / 网页的状态各窗口独立无法对齐，
> 整体工作量与已知限制都偏大。
>
> 重启时要补回主计划的东西：`WindowAssignment` 加 `viewport`、`plan_windows` 给 span 算视口、
> 窗口后端的 `unavailable_reason(Span)` 改回 `None` 且 span 的过渡限 none / fade、
> 轮播在 P4b 之前对 span 目标跳过场景、验证表的 P4a / P4b 两行。

---

## 总体设计思路

**窗口模型只有一种：每块在线屏一个壁纸窗口，窗口矩形就是那块屏。** 三种显示器模式只是「每个窗口显示哪个目标、显示目标画面的哪一块」不同：

| 显示器模式 | 每个窗口显示的目标 | 视口 |
|---|---|---|
| multiple | `multiple`（同一个） | 无：画布 = 本屏 |
| single | `screen:<本屏>` | 无：画布 = 本屏 |
| span | `span`（同一个） | 有：画布 = 所有屏的并集，本窗口只露出并集里属于本屏的那一块 |

不用「一个大窗口跨所有屏」：macOS 默认开着「显示器具有单独的空间」时一个窗口不能跨屏；Windows 上一个 HWND 跨混合 DPI / 不同刷新率的屏时只能按其中一块屏的 DPI 与刷新率渲染，性能与兼容性都不如每屏一窗。每屏一窗让每个窗口用本屏自己的 DPI 与刷新率，三种模式共用一套建窗 / 挂载 / 就绪 / ping / 转发代码，热插拔只是增删窗口。

**切片怎么做。** 后端给每个窗口一条 assignment：`{ targetId, audible, synced, viewport }`。`viewport = { canvasWidth, canvasHeight, offsetX, offsetY }`，单位是**该窗口的 CSS 像素**（后端按该屏缩放换算好；Windows 物理像素 ÷ 本屏 scale，macOS 点原样）。前端分两种手法：

1. **容器平移**（图片 / 平铺 / 视频 / 网页）：`WallpaperStage` 的根是 `w-full h-full`、各层相对父容器铺放（现状 a），所以在 `WallpaperWindow.vue` 里把 Stage 放进一个 `canvasWidth × canvasHeight`、`transform: translate(-offsetX, -offsetY)` 的容器，窗口根 `overflow: hidden`。Stage 以为自己在一块并集大小的屏上，fill / fit / center / tile 全部照常，窗口只露出自己那一块。**Stage 一行不改。**
2. **视口感知**（场景）：场景若也放进并集大小的容器，画布就是并集 × DPR，每个窗口都要分配并 present 一整张并集画布。改成场景层保持窗口大小，把视口随壁纸样式一起经已有的 `kabegame:wpe-scene-style` 消息交给宿主，`render/layout.ts` 按并集画布算铺放矩形后减去偏移，指针反算加回偏移。场景本身仍按场景分辨率离屏渲染一次，上屏那一步只画本窗口这一块。

**同步怎么做：共享系统时钟，没有主从、没有后端状态。** 同一台机器上各窗口的 `Date.now()` 是同一个钟。`synced` 为 true（同一个目标显示在两个以上窗口：多屏下的 multiple 与 span）时：
- 视频：期望位置 `= (Date.now() / 1000 × 倍速) mod 时长`；起播时 seek 到它，之后每 2 s 比一次，偏差超过 0.3 s 直接 seek，0.03–0.3 s 之间把 `playbackRate` 临时调 ±5% 追上，更小不动。暂停恢复、改倍速后位置会跳到公式值——只在 `synced` 时如此，单窗口目标保持现在的行为。
- 场景：`g_Time` 改由系统时钟给（`Date.now()/1000` 对现有回绕周期取模），纯由 `g_Time` 驱动的效果（水波、摇摆、滚动、shake）在各窗口逐帧一致。粒子与场景脚本是有状态的模拟，各窗口各跑一份、相位不同——记为已知限制（图像层对得上，粒子在接缝处不连续）。
- 网页：N 个独立页面实例，各自排版成并集大小；页面自己的随机与计时不同步，同样记为已知限制。音频数据来自同一份采集，频谱类页面基本一致。
- 声音：只有 `audible` 的窗口出声（multiple / span 取主屏那个），其余音量传 0。

过渡：span 只有 none / fade（slide / zoom 是按窗口做的位移缩放，跨窗口不连续）。各窗口在收到同一条 `setting-change` 后各自预加载再淡入，起点相差在图片解码时间以内，隔着屏幕边框可以接受；若真机上明显，再加「约定时刻切换」（assignment 不变，`wallpaperTargets` 事件旁带一个 `applyAtMs`）。

## 现状锚点

**a. Stage 相对父容器铺放**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue:1751`）
```vue
<div ref="rootRef" class="relative w-full h-full overflow-hidden">           <!-- 现状：铺满父元素 -->
  <div ref="stageRef" class="absolute inset-0 w-full h-full overflow-hidden">
    <img ref="baseImgRef" class="wallpaper-img base" /> …                      <!-- object-fit 按 styleMode -->
  </div>
  <div ref="webLayerRef" class="wallpaper-web-layer" style="display: none"></div>
  <div ref="sceneLayerRef" class="wallpaper-scene-layer" style="display: none"> … </div>
</div>
```

**b. 壁纸窗口根铺满窗口**（`apps/kabegame/src/views/WallpaperWindow.vue` 模板）
```vue
<div class="wallpaper-root relative w-screen h-screen overflow-hidden bg-transparent">
  <WallpaperStage ref="stage" :target="state.target" :style-mode="state.styleMode" … interactive />
</div>
```

**c. 壁纸窗口读扁平设置**（同文件 `init`）
```ts
if ("wallpaperStyle" in changes) state.styleMode = changes.wallpaperStyle as Mode;
if ("wallpaperRotationTransition" in changes) state.transition = …;
if ("currentWallpaperImageId" in changes) acceptTarget(await invoke("get_current_wallpaper_target"));
// 启动：get_wallpaper_rotation_style / get_wallpaper_rotation_transition / get_current_wallpaper_target …
```

**d. 唯一窗口、全屏到所在屏**（`src-tauri/kabegame/src/wallpaper/manager/window.rs`）
```rust
pub const WALLPAPER_LABEL: &str = "wallpaper";
pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>,   // 现状：Option，单个
}
// create_window(): allow_file_documents / allow_app_local_resources / disable_wheel_zoom(WALLPAPER_LABEL)
//                  WebviewWindowBuilder::new(.., WALLPAPER_LABEL, "index.html?window=wallpaper").fullscreen(true)
```

**e. 就绪握手是进程级单值**（`wallpaper/window.rs`）
```rust
static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();   // 现状：一个 bool + Condvar
```

**f. Windows 挂载按「屏序号或所在屏」取矩形**（`tauri-plugin-wemt/src/models.rs`、`platform/windows.rs:282`）
```rust
pub struct AttachOptions { pub monitor: Option<u32>, pub show_host: bool }   // 现状：None = 窗口所在屏
pub fn monitor_for(hwnd: isize, index: Option<u32>) -> Result<(MonitorInfo, Rect)>;  // wemt 自己枚举的序号
```

**g. macOS 挂载铺满窗口所在屏**（`wallpaper/window_mount_macos.rs`）
```rust
let screen_frame = ns_window.screen().as_ref().map(|s| s.frame())
    .or_else(|| NSScreen::mainScreen(mtm).as_ref().map(|s| s.frame()))?;   // 现状：所在屏 / 主屏
```

**h. label 写死的地方**
```text
kabegame/src/lib.rs:611                       .acl_exempt_webview("wallpaper")
kabegame/capabilities/main.json:5             "windows": ["wallpaper", "main"]
kabegame/capabilities/wpe-web.json:5          "windows": ["main", "wallpaper"]
kabegame/src/wallpaper/wpe_scene_host.rs:196  .windows(["main", "wallpaper"])
kabegame/src/commands/window.rs:26            app.get_webview_window("wallpaper")   // macOS fix_wallpaper_zorder
```

**i. 场景时钟是累加的本地钟**（`apps/wpe-scene/src/render/clock.ts`）
```ts
// g_Time 用秒，只在渲染循环运行时前进：暂停、页面隐藏期间冻结，恢复后从冻结处接着走
constructor(private readonly now: () => number = () => performance.now()) {}
// 帧时钟：差钳到 [0.0001, 0.25]，time 累加钳后的值
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
/// 后端发给窗口的布置。viewport 的单位是该窗口的 CSS 像素。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowAssignment {
    pub target_id: String,
    pub audible: bool,                 // multiple / span：只有主屏窗口为 true；single：全为 true
    pub synced: bool,                  // 该目标显示在 ≥2 个窗口
    pub viewport: Option<Viewport>,    // 只有 span 有
}
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport { pub canvas_width: f64, pub canvas_height: f64, pub offset_x: f64, pub offset_y: f64 }

struct Slot<R: Runtime> { window: WallpaperWindow<R>, screen: ScreenInfo, assignment: WindowAssignment }

pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    slots: Arc<Mutex<BTreeMap<String /* label */, Slot<R>>>>,   // 修改：Option → 表
}

/// 每块在线屏一条。span 的 viewport：
///   canvas = union 宽高 ÷ k，offset = (screen.xy − union.xy) ÷ k；
///   k = Windows 上该屏的 scale（桌面坐标是物理像素），macOS 为 1（桌面坐标是点 = CSS 像素）。
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
    fn unavailable_reason(&self, _display: DisplayMode) -> Option<&'static str> { None }   // 三种都可用
    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption> {
        // span：none / fade；其余：none / fade / slide / zoom
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
  每个窗口同样的层级与 `CanJoinAllSpaces | Stationary`，各自 frame 到各自屏，不受「单独的空间」设置影响。

## 点 4 — 就绪、ping、鼠标转发、媒体订阅按 label

- **修改** 就绪：`WALLPAPER_WINDOW_READY` 改成 `Mutex<HashSet<String>> + Condvar`；`wallpaper_window_ready` 命令按调用方 label 标记；`wait_ready(label, timeout)`；销毁窗口时移除该 label。
- **ping**：`Pinger::start(label, …)` 已按 label，每个 slot 一个，逻辑不改。
- **鼠标转发**：每个窗口一个 `InputForwarder`（N ≤ 8，各自 60 Hz 读光标，开销可忽略），只为当前显示网页 / 场景的窗口开。`Sample.inside` 已按各自窗口矩形判断，光标在哪块屏就只有那个窗口收到 Move，其它窗口收到一次 Leave。
  - span 下坐标自动正确：网页 iframe 随容器平移了 `-offset`，注入到窗口视图坐标 `(x, y)` 的事件落在页面的 `(x + offsetX, y + offsetY)`；场景由宿主在指针反算时加回偏移（点 6）。
  - 已知限制：span 下光标效果只出现在光标所在屏的那个实例里，不会延续到相邻屏。
- **WPE 媒体订阅**：已按 `(label, SubframeId, 类型)` 归属、窗口销毁释放整个 label，多窗口无需改；确认 `WpeMediaHub` 多订阅共用一路 WASAPI 采集（现状如此）。

## 点 5 — 壁纸窗口前端：assignment、切片容器、视频同步

- **修改** `views/WallpaperWindow.vue`
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
<!-- 修改：切片容器。没有 viewport 时等同现状（容器 = 窗口） -->
<div class="wallpaper-root relative w-screen h-screen overflow-hidden bg-transparent">
  <div class="absolute left-0 top-0" :style="canvasStyle">   <!-- width/height = canvas，transform: translate(-offset) -->
    <WallpaperStage
      ref="stage" :target="state.target" :style-mode="state.styleMode" :transition="state.transition"
      :volume="assignment?.audible === false ? 0 : state.volume"
      :playback-rate="state.playbackRate" :paused="stagePaused"
      :synced="assignment?.synced ?? false"
      :viewport="assignment?.viewport ?? null"
      interactive
    />
  </div>
  <!-- 调试面板留在窗口坐标里，不进容器；加显示 label / targetId / viewport / 同步偏差 -->
</div>
```
- **删除** 对 `get_wallpaper_rotation_style` / `get_wallpaper_rotation_transition` 的调用（命令本身在 02 点 4 删除）。
- **修改** `WallpaperStage.vue`：只加两个 prop，铺放逻辑不动。
  - `synced?: boolean`：视频层按系统时钟对位。
```ts
/** 同一目标显示在多个窗口时的期望位置：各窗口读同一个系统钟，不需要主从。 */
function syncedPosition(duration: number, rate: number): number {
  return ((Date.now() / 1000) * rate) % duration;
}
// 起播（loadedmetadata）与 2 s 定时：d = syncedPosition − currentTime（按 duration 取最短环距）
//   |d| > 0.3            → currentTime = syncedPosition
//   0.03 < |d| ≤ 0.3     → playbackRate = rate × (d > 0 ? 1.05 : 0.95)
//   否则                  → playbackRate = rate
// 暂停期间不校正；恢复、改倍速后立即校正一次。过渡期间 base / top 两个 <video> 各自对位。
```
  - `viewport?: Viewport | null`：Stage 自己不用它铺放（外层容器已处理），只转交场景层（点 6）；web 层的 iframe 在容器里已是并集大小，不需要它。
- **修改** 网页壁纸的「按主屏尺寸排版」等凡是读 `window.innerWidth/innerHeight` 的地方（若有）改读 Stage 根元素尺寸——切片下窗口尺寸 ≠ 画布尺寸。实施时 grep 核对。

## 点 6 — 场景：视口感知与共享时间（`apps/wpe-scene`、`WpeSceneView.vue`、`wpeSceneStyle.ts`）

- **修改** 场景层不进切片容器的尺寸：`WallpaperStage` 在有 `viewport` 时给 scene 层加反向平移，使它恰好等于窗口可见区（`left: offsetX; top: offsetY; width/height = 窗口`），其余层不变。
- **修改** 样式消息带上视口与同步标志（扩展已有 `kabegame:wpe-scene-style`，不新开消息）：
```ts
// wpeSceneStyle.ts
interface SceneStyleMessage {
  type: "kabegame:wpe-scene-style";
  style: Mode;
  viewport?: { canvasWidth: number; canvasHeight: number; offsetX: number; offsetY: number };  // 新增
  synced?: boolean;                                                                            // 新增
}
```
- **修改** `apps/wpe-scene/src/render/layout.ts`：铺放矩形按「虚拟画布」算再减偏移。
```ts
// 现状：placement(style, sceneSize, canvasSize) → 场景在画布上的矩形
// 修改：有 viewport 时 canvasSize 取 viewport.canvas，结果矩形平移 (−offsetX, −offsetY)；
//       留白色（schemecolor）照旧填满本窗口画布
```
  - `sceneCursor` / `pointerScenePoint` 的反算在窗口坐标上先加 `(offsetX, offsetY)` 再走原公式。
  - `canvasSize`（画布像素 = 布局 × DPR × 显示缩放）不变：画布仍是窗口大小。
  - 脚本的 `engine.screenResolution` 在 span 下给并集尺寸（与 WPE 跨屏时一致）。
- **修改** `apps/wpe-scene/src/render/clock.ts`：`synced` 时 `g_Time` 取系统钟。
```ts
// 新增：共享时钟模式。time = (Date.now() / 1000) mod 现有回绕周期；帧时间仍取相邻两帧读数差并钳到 [0.0001, 0.25]。
// 暂停时冻结显示（不渲染），恢复后直接取当前系统钟（会跳），与视频的 synced 行为一致。
```
  - 粒子与脚本仍用各自的帧时间步进，不保证跨窗口一致（已知限制）。要一致需要固定步长 + 共同种子，另立子计划，不在本期。
- 成本：每个窗口各自完整渲染一次场景（场景分辨率的离屏目标），上屏只画本窗口一块。N 块屏 = N 次场景渲染，与 WPE 多屏各开一份相同。

## 点 7 — 各类内容在 span 下的结论

| 内容 | 手法 | 接缝处 |
|---|---|---|
| 图片、平铺 | 容器平移 | 精确 |
| 视频（含 WPE 视频的翻转 / 位移 / 缩放，写在 stage 的 transform 上） | 容器平移 + 系统钟对位 | 相差不超过约 1 帧 |
| 场景 | 视口感知 + 共享 `g_Time` | 图像层与着色器效果一致；粒子、脚本各窗口独立 |
| 网页 | 容器平移（每窗口一个并集大小的页面实例） | 静态排版一致；页面自己的动画 / 随机不同步 |
| 声音 | 只有主屏窗口出声 | — |
| 过渡 | none / fade | 各窗口起点相差在解码时间内 |
