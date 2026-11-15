# 预览覆盖层：鼠标转发与桌面光标插件（步骤 1、2）

2026-11-15，用户：「我想在预览层里加一个透明覆盖，由它转发鼠标事件（先不支持键盘），最终目的是为了能够放大 frame、网页这些目标，
以及鼠标不在 iframe 内也能让预览里的景物跟随」「放大的意思是和图片一样能放大，之后我想给视频也接入这种放大」「可以加用一个 tauri
插件，订阅获取桌面鼠标位置状态，预览和壁纸都能用。点击判断则需要分开一下，桌面上用鼠标指针是否点击桌面判断，预览则是在应用内自动能
收到，在应用外点击收不到也没关系」。批准方案后：「一次做步骤 1、步骤 2」。步骤 3（壁纸放大）另起一轮，见文末。

## 第二版（2026-11-15 改定，取代下面的第一版设计）

第一版实现完、验收后，用户：「js 转发还是有点不原生……frame 里自己通过 tauri 插件来注册，之后 rust 会自己转发事件（包括钳制）到对应的
frame。蒙层不转发，只拦截鼠标」。实验证实：经 iframe（OOPIF）自己的输入通道注入的鼠标事件不受父页面遮挡层影响、`isTrusted` 为真；
整窗注入（CEF 现有的 `SendMouse*Event`）会被遮挡层挡住。调查（CEF 插入点）后用户定：
1. 走 CEF 补丁（`third-patches/cef/11-frame-mouse-injection.patch`），不走进程内 DevTools；
2. 预览里的点击不加闸门，允许和浮在壁纸上的 UI 重叠；
3. 桌面也走同一条路；
4. 钳制：光标在 frame 外时取「frame 中心到光标的连线」与 frame 边界的交点。
另同意：注入的点击会把键盘焦点切进 iframe，预览里发现 iframe 拿到焦点就还给父页面（还不支持键盘）。

### 总体设计思路（第二版）

**事件是 Rust 直接注入进 frame 的原生事件，页面里没有任何合成。** CEF 补丁 11 在 `CefFrame` 末尾加三个实验版方法：
`ConvertPointFromView`（只能在 UI 线程调，把浏览器视图 DIP 坐标换算到这个 frame 自己的坐标并给出 frame 视口尺寸，换算用合成器的命中测试
变换，已含父页面的 CSS 缩放、滚动与以后的放大平移，框外的点照样换算）与 `SendMouseMoveEventToFrame` / `SendMouseClickEventToFrame`
（frame 坐标，直接交给 frame 自己 widget 的 `ForwardMouseEvent`，绕过根视图的命中测试、原生捕获、焦点窗口与光标管理）。只改 `//cef`，
不碰 Chromium。cef-rs 绑定补丁 09 补四套目标的字段与包装，`_cef_frame_t` 248 → 272 字节；调用前按 `base.size` 判断，旧 libcef 当作不支持。

**frame 自己登记，Rust 按窗口轮询并注入。** 垫片在 iframe 里（网页壁纸与场景宿主都加载它）调 `plugin:cursor|attach_frame`；插件从调用方
（`tauri::ipc::CallerFrame::Sub`）认出 webview label 与子 frame 标识，给这个窗口挂一个 watch。每次采样（16 ms）把窗口坐标交给注入器：
运行时在一个 UI 任务里 `frame_by_identifier` → 检查 `base.size` → `ConvertPointFromView` → 钳制 → 注入。登记由父页面控制：
`WallpaperStage` / `WpeSceneView` 已经在用音量消息（`kabegame:wpe-volume`，带 `paused`）跟垫片说话，消息加 `interactive`，垫片在
`interactive && !paused` 时登记、否则解除；应用背景不交互，所以不登记。frame 销毁（`SubframeDestroyed`）或主文档重载时插件清掉它。

**点击规则按窗口分，插件按 label 配置。** 壁纸窗口（label 池 `WALLPAPER_LABELS`）沿用「按下沿时光标在窗口内、且光标下是桌面」；
其它窗口（主窗口的预览）是「光标下的顶层窗口就是本窗口」，再由运行时判断按下点（钳制前）是否落在 frame 里，允许和 UI 重叠。是否按下由运行时
按 frame 记着：按下没注入就不发抬起；解除登记时补抬起与一次离开。

**钳制在 Rust 里做，是纯函数。** frame 坐标系里，点在 `[0, w) × [0, h)` 外时，取中心 `(w/2, h/2)` 到该点的连线与边界的交点
（略向内收，保证落在框内）。视差、跟随鼠标的粒子因此停在边缘，不再外推。

**蒙层只拦截。** 预览的 `WallpaperPointerOverlay` 不订阅、不转发，只占住鼠标（右键照旧冒泡到预览菜单，滚轮留给以后放大）；两个 iframe
一律 `pointer-events: none`，真实鼠标永远进不了 frame，只有注入的事件。桌面壁纸窗口本来就收不到真实鼠标。

**删掉的东西**：第一版的 `kabegame:wpe-pointer` 协议、`wpePointer.ts` 的转发与总线、垫片 `installPointer`、`utils/desktopCursor.ts`、
插件的 `subscribe` / `unsubscribe`；桌面的 `wallpaper/input_forward.rs`（`ForwardState`）、`WallpaperWindow::set_mouse_forwarding`
与运行时的整窗注入 `inject_mouse` / `MouseInjection`。翻页热区仍删（覆盖层还在）。

**已知副作用**：注入的点击会把焦点切进 iframe（预览里由 Stage / WpeSceneView 发现 iframe 获焦就 `blur()` 还给父页面）；页面里的光标形状与
tooltip 显示不出来；网页壁纸里再嵌的跨源 iframe 收不到事件；同进程 iframe 不支持（我们的 `file:` iframe 跨站，都是 OOPIF）。

### 现状锚点（第二版新增）

**a. 整窗注入**（`src-tauri/tauri-runtime-kbcef/src/webview.rs:260-310`，第二版删除）
```rust
pub fn inject_mouse(webview_label: &str, input: MouseInjection) -> Result<(), String>
// Move → host.send_mouse_move_event；LeftDown → send_mouse_click_event 后 release_own_mouse_capture()
```

**b. 子 frame 查找**（`src-tauri/tauri-runtime-kbcef/src/runtime.rs:3307-3326`，`EvalInSubframe` 的写法）
```rust
browser.frame_by_identifier(Some(&CefString::from(id.as_str()))) // 再过滤 is_valid() == 1
```

**c. 垫片的父页面消息**（`wpe_shim.js` 的音量消息：`{ type: "kabegame:wpe-volume", volume, paused }`）

### 点（第二版）

- **点 A — CEF 补丁 11 与 cef-rs 补丁 09**：已写（见 `third-patches/cef/README.md` 11、`third-patches/cef-rs/README.md` 09）。
  CEF 要用户在 MSYS2 + VS 环境里 `deno task build:chromium` 重编；cef-rs 绑定在新 libcef 下编译验证。
- **点 B — 运行时**（`tauri-runtime-kbcef`）：
  - **新增** `pub fn frame_mouse(webview_label: &str, frame_id: &str, input: FrameMouse) -> Result<(), String>`：post 到 UI 线程，
    按 label 找 browser、按标识找 frame，检查 `base.size`，`ConvertPointFromView`，钳制，注入；按 (label, frame) 记是否按下。
    `FrameMouse::{Move { x, y }, Down { x, y, require_inside }, Up { x, y }, Release}`（坐标是浏览器视图 DIP；`Release` = 补抬起 + 离开，解除登记时用）。
    不支持（旧 libcef、同进程 frame、换算失败）时只记一次 warn。
  - **新增** 纯函数 `clamp_to_frame(point, size) -> (point, inside)`（中心连线与边界交点），带单测。
  - **删除** `inject_mouse`、`MouseInjection`、`release_own_mouse_capture` 的这条调用路径。
- **点 C — 插件**（`tauri-plugin-cursor`）：
  - **修改** `DesktopHit` → 同时给 `over_desktop()` 与 `over_window()`（Windows：`WindowFromPoint` 的根是本窗口；macOS：`windowNumberAtPoint`
    是本窗口，`TODO:[WPE_SCENE] macOS 未实测`）。
  - **新增** 命令 `attach_frame` / `detach_frame`（调用方必须是子 frame），注入器由应用在 setup 时设（`set_frame_injector`，插件不依赖运行时
    crate），点击规则按 label 设（`set_click_rule(label, ClickRule::OverDesktop | ClickRule::OverWindow)`，缺省 `OverWindow`）。
  - **新增** 每个登记的 frame 一个 watch：位置变了发 `Move`；左键按下沿按规则发 `Down`（`OverWindow` 带 `require_inside`），抬起沿发 `Up`；
    解除登记 / frame 销毁 / 主文档重载 / 窗口销毁时发 `Release` 并移除。`RunEvent::WebviewEvent` 的 `SubframeDestroyed` 清 frame。
  - **删除** `subscribe` / `unsubscribe`（JS 订阅）。`watch` / `position_in_window`（`wpe_scene_cursor` 用）保留。
- **点 D — 应用**（`src-tauri/kabegame`）：`lib.rs` setup 里设注入器（调 `tauri_runtime_kbcef::frame_mouse`）与壁纸窗口 label 池的
  `OverDesktop`；删除 `wallpaper/input_forward.rs`、`WallpaperWindow::set_mouse_forwarding` 及 manager 里的调用；`wpe-web.json` /
  场景宿主 capability 给子 frame 放行 `cursor:allow-attach-frame` / `cursor:allow-detach-frame`。
- **点 E — 前端与垫片**：
  - `wpeWebVolume.ts` 的消息加 `interactive`；`WallpaperStage` / `WpeSceneView` 发送时带上；
  - `wpe_shim.js`：删 `installPointer`；收到音量消息时按 `interactive && !paused` 调 `plugin:cursor|attach_frame` / `detach_frame`
    （经子 frame 的 IPC 桥，失败只 warn）；
  - 两个 iframe 一律 `pointer-events: none`；预览里 iframe 获焦就 `blur()`；
  - `WallpaperPointerOverlay` 只剩一个透明 div；删 `wpePointer.ts` 的总线与转发、`utils/desktopCursor.ts` 及其测试；
  - `ImagePreviewDialog` 翻页热区仍删。
- **点 F — 文档**：插件 README、`WPE_IMPORT.md`「预览的鼠标」「桌面鼠标转发」改写、`WPE_SCENE.md` 已知差别（钳制、窗口外停在边缘）、
  `cocs/README.md`、`tauri-runtime-kbcef/README.md`、回归与 changelog 改写。

### 验收（第二版）
1. **编译与单测**（dev 停着时做：cef-dll-sys 的构建脚本每次都要把 CEF 运行文件复制进 `target/debug`，dev 应用占着 libcef.dll 时会失败）：
   `check-kabegame`、插件 `cargo test`、运行时钳制单测、前端相关 vitest、Prettier、`cargo fmt`。
2. **变异**：钳制取最近边而不是连线交点；`base.size` 不判断；`OverWindow` 不要求在框内；解除登记不补抬起。
3. **真机**（新 CEF 下）：桌面网页 / 场景壁纸跟随与点击（点击只在桌面上），光标到另一块屏 / 窗口外时停在边缘；屏外宿主或预览里
   `isTrusted`、`:hover` 生效；预览蒙层下 iframe 收到移动与点击、Esc 仍可关预览；旧 libcef 下只 warn 不崩。

## 第一版（已被第二版取代，保留作记录）

### 总体设计思路

**位置和点击分两路走。**

光标位置由新插件 `tauri-plugin-cursor` 提供。插件有一个进程级的轮询中心：有订阅时，一条后台线程每 16 ms 读一次全局光标与左键，按每个订阅
自己的窗口换成该窗口客户区里的 CSS 像素（视图坐标）。平台代码就是现在桌面鼠标转发的两个探针（`wallpaper/input_forward/{win,mac}.rs`），
整段搬进插件，连同「光标下是不是桌面」。插件对两种使用方开两个口子：
- Rust 的 `watch(窗口, 回调)`：桌面鼠标转发改用它，转发规则 `ForwardState` 留在应用里一字不改，行为不变；
- JS 的 `subscribe(Channel)`：调用方窗口，位置变了才推 `{x, y}`。图库预览用它。

Linux 拿不到全局光标（Wayland），插件在 Linux 上订阅返回 `null`，预览退回覆盖层自己的 `pointermove`（只在应用窗口里有）。

点击按使用方分开：
- 桌面照旧：Rust 在左键按下沿判断光标下是不是桌面，用 CEF 注入，iframe 收到的是可信事件。
- 预览只收覆盖层上的左键：应用外的点击收不到，用户说可以。

**预览怎么把事件交给壁纸。** 覆盖层盖在 iframe 上，CEF 原生注入按坐标命中，会落到覆盖层上，所以预览只能把事件交给 iframe 里的页面
自己派发。新增父页面 → iframe 的消息 `kabegame:wpe-pointer {kind: "move" | "down" | "up", x, y}`，坐标是 iframe 视口里的 CSS 像素，
可以越界。垫片 `wpe_shim.js` 收到后派发合成的 pointer / mouse 事件：
- 目标：坐标在视口里用 `elementFromPoint`，取不到或越界时用 `document.documentElement`；
- 目标换了就补边界事件（over / out 冒泡，enter / leave 按祖先链）；
- 抬起时目标和按下时相同才补 `click`。

场景宿主也加载这份垫片，`apps/wpe-scene/src/main.ts` 挂在 `document` 上的 `pointermove` / `pointerdown` / `pointerup` 原样接住，
宿主不用改。越界坐标让场景照 WPE 在窗口外继续跟踪，视差在宿主里本来就钳制。移动事件的 `buttons` 照桌面（WPE 的 `modifiers=0`）
一律为 0。

**覆盖层和壁纸之间用 provide / inject 连接，不逐层传 props。** 只有预览用 `WallpaperPreviewCanvas`。它 `provide` 一个输入总线
`WallpaperPreviewInput`，里面挂覆盖层；`WallpaperStage` 的网页 iframe 和 `WpeSceneView` 的场景 iframe 各自 `inject` 后登记一个接收方。
接收方把父页面视口坐标换成自己 iframe 的视口坐标（`wpeContextMenuPoint` 的反函数：按显示矩形 ÷ 布局尺寸），再 `postMessage`。
适应缩放、以后的放大与平移都包含在显示矩形里，不用另算。桌面壁纸窗口和应用背景没有提供方，`inject` 拿到 `null`，什么都不变。

覆盖层在父文档里，预览容器的 `mousemove` 恢复正常，所以只为「iframe 吞掉 mousemove」设的翻页热区 `.preview-nav-hotzone` 删掉；它现在
还挡住了壁纸两侧中段的点击。右键落在覆盖层上，照旧冒泡到预览容器的 `@contextmenu` 弹菜单。

关键决策：
- **合成事件**：`isTrusted` 为假，没有 `:hover`，原生表单控件（`<input type=range>`）拖不动；`click` 与链接、复选框的激活行为照常。
  这是覆盖层方案本身带来的，桌面不受影响。
- **在留白处按下不转发**（相当于桌面上点在别的窗口上），抬起和按下成对：覆盖层 `setPointerCapture`，松开在哪里都收得到。
- **位置只用一个来源**：有插件时只用插件，覆盖层的 `pointermove` 不再送；没有插件时用 `pointermove`。两个来源一起送，顺序会乱。
  按下前先用按下事件自己的坐标补一次 `move`，保证页面在按下位置有过一次移动。
- **暂停**：预览里壁纸暂停时不转发，同桌面：进入暂停时补一次缺的 `up`，并退订插件。

## 现状锚点

**a. 桌面鼠标转发：线程、探针与规则**（`src-tauri/kabegame/src/wallpaper/input_forward.rs:30-175`）
```rust
const POLL_INTERVAL: Duration = Duration::from_millis(16);
pub(crate) struct Sample { pub view: (i32, i32), pub inside: bool, pub left_down: bool }   // 现状：视图坐标已取整
pub(crate) trait DesktopProbe: Send + 'static {
    fn alive(&mut self) -> bool;
    fn sample(&mut self) -> Option<Sample>;
    fn over_desktop(&mut self) -> bool;   // 只在左键按下沿调用
}
pub struct InputForwarder { stop: Arc<AtomicBool>, _handle: JoinHandle<()> }   // 现状：每个壁纸窗口一条线程
impl InputForwarder {
    pub(crate) fn start(webview_label: &str, probe: impl DesktopProbe) -> Self { /* spawn run() */ }
}
struct ForwardState { /* … */ }   // step(sample, paused, over_desktop, emit) / finish(emit)，5 个单测
fn run(label: String, mut probe: impl DesktopProbe, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) && probe.alive() {
        if let Some(sample) = probe.sample() {
            let paused = Settings::global().get_wallpaper_paused();
            state.step(sample, paused, || probe.over_desktop(), &mut emit);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    state.finish(&mut emit);   // 现状：停止时在转发线程上补抬起
}
```

**b. Windows 探针**（`input_forward/win.rs:48-116`）
```rust
pub(crate) struct WindowsProbe { hwnd: isize, cursor: (i32, i32) }
fn sample(&mut self) -> Option<Sample> {
    // GetCursorPos → GetAsyncKeyState(VK_LBUTTON) → ScreenToClient + GetClientRect 定 inside
    // → 除以 GetDpiForWindow/96 后 round 成 i32（现状：取整在探针里）
}
fn over_desktop(&mut self) -> bool { cursor_over_desktop(...) }   // WindowFromPoint → GA_ROOT 类名是 Progman / WorkerW
```

**c. macOS 探针**（`input_forward/mac.rs:84-156`）
```rust
pub(crate) struct MacProbe { window: CGWindowID, bounds: Option<CGRect>, main_height: f64, polls: u32, cursor: (f64, f64) }
// alive()：每 60 轮（没查到窗口时每 6 轮）向窗口服务重读边界与主显示器高度
// sample()：NSEvent::mouseLocation，locate() 后 round 成 i32
// over_desktop()：run_on_main + windowNumberAtPoint，层级不高于桌面图标层
```

**d. 谁启停转发**（`src-tauri/kabegame/src/wallpaper/window.rs:163-182`）
```rust
pub fn set_mouse_forwarding(&mut self, enabled: bool) {
    // …
    #[cfg(target_os = "windows")]
    let probe = super::input_forward::win::WindowsProbe::new(native_id);
    #[cfg(target_os = "macos")]
    let probe = super::input_forward::mac::MacProbe::new(native_id);
    self.forwarder = Some(super::input_forward::InputForwarder::start(self.window.label(), probe));
}
```

**e. 开场光标命令**（`src-tauri/kabegame/src/commands/wpe_scene.rs:68-123`）
```rust
pub(crate) fn client_to_css(x: i32, y: i32, dpi: u32) -> WpeSceneCursor { /* 除以 dpi/96 */ }
#[tauri::command]
pub async fn wpe_scene_cursor<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Option<WpeSceneCursor> {
    // 现状：Windows 自己写一遍 GetCursorPos + ScreenToClient + GetDpiForWindow；其它平台 None
}
```

**f. 预览里壁纸的层级**（`apps/kabegame/src/components/common/ImagePreviewDialog.vue:190-195, 255-270`）
```vue
<!-- 网页壁纸是跨源 iframe，指针在它上面时容器收不到 mousemove；…在箭头所在的竖向中段各放一条常驻热区唤出箭头 -->
<template v-if="isPreviewWallpaper">
  <div v-if="props.canPrev" class="preview-nav-hotzone left" @mouseenter="previewHoverSide = 'left'" />
  <div v-if="props.canNext" class="preview-nav-hotzone right" @mouseenter="previewHoverSide = 'right'" />
</template>
<!-- 箭头区上各有 @mouseleave="handleNavZoneLeave" -->
…
<div v-if="previewImage && isPreviewWallpaper" class="preview-wallpaper-wrapper absolute inset-0">
  <WallpaperPreviewCanvas ref="wallpaperCanvasRef" :content-size="previewWallpaperSize">
    <ImageContent … :video-playing="!wallpaperPaused" interactive @wallpaper-contextmenu="openPreviewContextMenuAt" />
  </WallpaperPreviewCanvas>
</div>
```
```ts
// :1276-1279
// 从箭头区移进网页壁纸 iframe 后容器再也收不到 mousemove，只能在离开时收起
const handleNavZoneLeave = (event: MouseEvent) => {
  if ((event.relatedTarget as Element | null)?.tagName === "IFRAME") previewHoverSide.value = null;
};
```

**g. 预览画布**（`apps/kabegame/src/components/wallpaper/WallpaperPreviewCanvas.vue:163-169`）
```vue
<div ref="containerRef" class="relative w-full h-full overflow-hidden">
  <div ref="canvasRef" class="absolute origin-top-left overflow-hidden" :style="canvasStyle"><slot /></div>
</div>
```

**h. 网页 iframe 与它的消息**（`WallpaperStage.vue:541-579, 606-651`）
```ts
function applyWebInteractive() { if (webFrameEl) webFrameEl.style.pointerEvents = props.interactive ? "auto" : "none"; }
function onWindowMessage(event: MessageEvent) {   // 音量请求、右键；只认 source === 当前 webFrameEl
  …
}
let webFrameEl: HTMLIFrameElement | null = null;   // createWebFrame 里赋，teardownWeb 里清
```

**i. 场景 iframe**（`WpeSceneView.vue`）
```vue
<iframe v-if="src" ref="frame" … :class="interactive ? 'pointer-events-auto' : 'pointer-events-none'" @load="postPointer" />
```

**j. 场景宿主接指针**（`apps/wpe-scene/src/main.ts:45-56`，本节不改）
```ts
document.addEventListener("pointermove", (event) => { pointer.move(event.clientX / innerWidth, event.clientY / innerHeight); });
document.addEventListener("pointerdown", (event) => { if (event.button === 0) host.setButton(true); });
document.addEventListener("pointerup", (event) => { if (event.button === 0) host.setButton(false); });
```

**k. 垫片读父页面消息的写法**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:439-449`）
```js
// source / data 用垫片启动时的原生 getter 读，页面改 MessageEvent.prototype 也改不了判断
var messageProto = window.MessageEvent && window.MessageEvent.prototype;
var sourceDesc = messageProto && Object.getOwnPropertyDescriptor(messageProto, "source");
var dataDesc = messageProto && Object.getOwnPropertyDescriptor(messageProto, "data");
function read(event, desc, name) { return desc && desc.get ? desc.get.call(event) : event[name]; }
window.addEventListener("message", function (event) {
  if (!event.isTrusted || read(event, sourceDesc, "source") !== host) return;
  … event.stopImmediatePropagation(); …
}, true);
```
（现状：这几个变量在 `installVolume` 内部，别的 installer 用不到。）

## 点 1 — 插件 `tauri-plugin-cursor`（新 crate）

- **新增** `src-tauri/tauri-plugin-cursor/`：
  - `Cargo.toml`：`tauri`（`default-features = false`）、`serde`、`tracing`；`[target.'cfg(windows)']` 的 `windows-sys`（`workspace = true`，
    features 同 `win.rs` 所用：`Win32_Foundation`、`Win32_Graphics_Gdi`、`Win32_UI_HiDpi`、`Win32_UI_Input_KeyboardAndMouse`、
    `Win32_UI_WindowsAndMessaging`）；`[target.'cfg(target_os = "macos")']` 的 `core-graphics 0.25`、`core-foundation 0.10`、
    `dispatch2 0.3`、`objc2 0.6`、`objc2-app-kit 0.3`（`std`、`NSEvent`、`NSWindow`、`NSResponder`、`NSGraphics`）、`objc2-foundation 0.3`
    （`std`、`NSGeometry` 等 `mac.rs` 用到的），版本照 `kabegame/Cargo.toml`。
  - `README.md`：中文，说明模型、两种使用方、坐标系、平台支持、命令与 Channel 消息。
  - `permissions/default.toml`（照 `tauri-plugin-wemt` 手写）：`allow-subscribe`、`allow-unsubscribe`。主窗口免 ACL，不改 capability。
  - `src/lib.rs`：
```rust
//! 全局光标（中文模块注释：轮询中心、坐标系、两种使用方、平台）
mod hub;
mod platform;            // windows.rs / macos.rs / 其它平台空实现
mod commands;

pub use hub::{watch, DesktopHit, Sample, Watch};
pub use platform::{native_window, position_in_window, NativeWindow};

/// 插件名（前端 `plugin:cursor|...`）。
pub const PLUGIN_NAME: &str = "cursor";

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![commands::subscribe, commands::unsubscribe])
        // 主 frame 开始加载新文档（刷新、导航）：旧文档的订阅作废（Channel 发往旧文档的回调会被静默丢掉，不能靠发送失败清理）
        .on_page_load(|webview, payload| { if payload.event() == PageLoadEvent::Started { commands::release_webview(webview.label()) } })
        // 窗口销毁：清它的订阅
        .on_event(|_app, event| { if let RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } = event { commands::release_webview(label) } })
        .build()
}
```
  - `src/platform/`：
```rust
/// 窗口的原生标识：Windows 是 HWND，macOS 是 `NSWindow.windowNumber`。
pub type NativeWindow = isize;

/// 一次采样（Windows / macOS 各一个实现，即原 `WindowsProbe` / `MacProbe`）。
pub(crate) trait Probe: Send + 'static {
    fn alive(&mut self) -> bool;
    fn sample(&mut self) -> Option<Sample>;   // 修改：view 改成 f64，不再取整
    fn over_desktop(&mut self) -> bool;
}
pub(crate) fn probe(native: NativeWindow) -> Option<Box<dyn Probe>>;   // 不支持的平台 None

/// 取窗口的原生标识（会同步等主线程：只在异步命令或不持锁处调用）。不支持的平台 None。
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow>;
/// 一次性取光标在窗口里的视图坐标（CSS 像素，可越界）。
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)>;
```
    - `windows.rs`：原 `win.rs` 原样搬来，`Sample.view` 不取整（`client / scale`），`is_desktop_root_class` 及其单测一起搬。
    - `macos.rs`：原 `mac.rs` 原样搬来，`locate` 不取整（单测相应改成 f64）；`native_window` 用 `ns_window()` + `run_on_main` 读
      `windowNumber`（同 `wallpaper/window_mount_macos.rs:74-118` 的写法）。本机测不了，新增部分标 `// TODO:[WPE_SCENE] macOS 未实测`。
    - 其它平台：`probe` / `native_window` / `position_in_window` 都返回 `None`，标 `// TODO:[WPE_SCENE] Linux（X11 可用 XQueryPointer，Wayland 拿不到全局光标）`。
  - `src/hub.rs`：
```rust
/// 一次采样：光标在窗口客户区里的视图坐标（CSS 像素 / DIP，光标在窗口外也给出，可为负或越界）、是否在窗口内、左键是否按着。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample { pub view: (f64, f64), pub inside: bool, pub left_down: bool }

/// 回调里按需问「上一次采样的光标下是不是桌面」（只在需要时求值，Windows 一次 WindowFromPoint，macOS 要上主线程）。
pub trait DesktopHit { fn over_desktop(&mut self) -> bool; }

/// 订阅句柄：丢弃即停止。只置标志，轮询线程下一轮把它移除并在那条线程上丢弃回调（回调的 Drop 可以补发收尾事件）。
pub struct Watch { /* id, Arc<AtomicBool> */ }

/// 开始观察 `native` 窗口：轮询线程每 16 ms 调一次 `on_sample`（采样失败的那轮跳过）；窗口不在了（`alive` 为假）自动移除。
/// 不支持的平台返回 None。所有回调在同一条轮询线程上依次调用。
pub fn watch(native: NativeWindow, on_sample: impl FnMut(Sample, &mut dyn DesktopHit) + Send + 'static) -> Option<Watch>;
```
    轮询线程：进程级单例（`OnceLock<Mutex<…>>`），第一个 watch 时启动，没有 watch 时停下（或 park 等新 watch），不忙等。
  - `src/commands.rs`：
```rust
/// 前端收到的一点：调用方窗口客户区里的 CSS 像素（和应用页的 clientX 同一坐标系），可越界。
#[derive(Clone, Copy, serde::Serialize)]
pub struct CursorPoint { pub x: f64, pub y: f64 }

/// 订阅光标：位置变了才推（第一次采样必推）。返回订阅号；平台不支持返回 null。异步命令：取窗口句柄要等主线程。
#[tauri::command]
pub async fn subscribe<R: Runtime>(webview: Webview<R>, on_sample: Channel<CursorPoint>) -> Result<Option<u32>, String>;
/// 退订；号不存在时什么都不做。
#[tauri::command]
pub fn unsubscribe<R: Runtime>(webview: Webview<R>, id: u32);   // 只能退自己 webview 的
pub(crate) fn release_webview(label: &str);   // 清某个 webview 的全部订阅
```
  - 单测：`hub` 的增删（用假探针：`watch` 返回后回调被调、`Watch` 丢弃后不再调且回调被 drop、窗口不 alive 时移除）；`commands` 的按 label 清理；
    平台换算的原单测。轮询线程测试要能注入假探针（`watch_probe(probe, cb)` 之类的 crate 内函数），不依赖真实窗口。

## 点 2 — 应用接入插件（`Cargo.toml`、`lib.rs`、`wallpaper/`、`commands/wpe_scene.rs`）

- **修改** 根 `Cargo.toml`：`members` 在 `"src-tauri/tauri-runtime-kbcef",` 之后加 `"src-tauri/tauri-plugin-cursor",`（**不要碰** `wpesl2wgsl` 那一行，
  别的会话在改）；`[workspace.dependencies]` 加 `tauri-plugin-cursor = {path = "./src-tauri/tauri-plugin-cursor"}`（在 `tauri-plugin-pathes` 之前）。
- **修改** `src-tauri/kabegame/Cargo.toml`：三个桌面平台的依赖块（`cfg(any(windows, linux, macos))`）加
  `tauri-plugin-cursor = { workspace = true, optional = true }`，`standard` 加 `"dep:tauri-plugin-cursor"`。macOS 的 `core-graphics` /
  `core-foundation` 等依赖**不删**（`wallpaper/screens/mac.rs` 等也在用，本机编不了 macOS）。
- **修改** `lib.rs`：在 `tauri_plugin_wemt` 那个块之后另起一块
```rust
#[cfg(feature = "standard")]
{
    builder = builder.plugin(tauri_plugin_cursor::init());
}
```
- **修改** `wallpaper/input_forward.rs`：
```rust
//! 模块注释：「读光标与左键」「光标下是不是桌面」改由 tauri-plugin-cursor 提供；本模块只剩转发规则与注入。
use tauri_plugin_cursor::{DesktopHit, NativeWindow, Sample, Watch};

pub struct InputForwarder { _watch: Watch }   // 修改：不再自己开线程
impl InputForwarder {
    /// 平台不支持时返回 None。
    pub(crate) fn start(webview_label: &str, native: NativeWindow) -> Option<Self> {
        let mut forward = Forward { label: webview_label.to_string(), state: ForwardState::default() };
        tauri_plugin_cursor::watch(native, move |sample, hit| forward.step(sample, hit)).map(|watch| Self { _watch: watch })
    }
}
/// 回调持有的转发状态；随 watch 移除在轮询线程上丢弃，Drop 里补未配对的抬起（同原 `run` 末尾的 `finish`）。
struct Forward { label: String, state: ForwardState }
impl Forward {
    fn step(&mut self, sample: Sample, hit: &mut dyn DesktopHit) {
        let paused = Settings::global().get_wallpaper_paused();
        let sample = ViewSample::from(sample);   // 视图坐标在这里 round 成 i32，和原探针的取整一致
        self.state.step(sample, paused, || hit.over_desktop(), &mut |input| inject(&self.label, input));
    }
}
impl Drop for Forward { fn drop(&mut self) { self.state.finish(&mut |input| inject(&self.label, input)); } }
```
  `ForwardState` 与 5 个单测不改（单测里的 `Sample` 换成本模块内取整后的 `ViewSample`，字段同原来）。`DesktopProbe`、`run`、`POLL_INTERVAL` 删除。
- **删除** `wallpaper/input_forward/win.rs`、`input_forward/mac.rs`（代码与单测已在插件里）。
- **修改** `wallpaper/window.rs` 的 `set_mouse_forwarding`：
```rust
self.forwarder = super::input_forward::InputForwarder::start(self.window.label(), native_id);
if self.forwarder.is_none() { tracing::warn!("本平台不支持桌面鼠标转发"); }
```
  注释里「转发线程」的说法同步改成插件的轮询。
- **修改** `commands/wpe_scene.rs` 的 `wpe_scene_cursor`：
```rust
let native = tauri_plugin_cursor::native_window(&webview.window())?;
let (x, y) = tauri_plugin_cursor::position_in_window(native)?;
Some(WpeSceneCursor { x, y })
```
  `client_to_css` 与它的单测删除（换算在插件里，单测已搬）。注释改成「macOS 也有了（未实测）」。
- 其它引用 `input_forward/mac.rs`、`win.rs` 的注释（`wallpaper/screens/mac.rs:8`、`commands/settings.rs:490`、`window_mount_macos.rs:63`、
  `manager/window.rs:537`）改指插件。

## 点 3 — 协议与换算（`apps/kabegame/src/components/wallpaper/wpePointer.ts`，新增）

```ts
/**
 * 预览里覆盖层转发鼠标给壁纸 iframe（父页面 → iframe 的 `postMessage`）与输入总线。
 * （中文头注释：为什么要覆盖层、消息格式、坐标系、垫片按同样字面量另写一份并由测试核对、合成事件的局限）
 */
import type { InjectionKey } from "vue";
import type { ViewportPoint } from "./wpeContextMenu";

export const WPE_POINTER = "kabegame:wpe-pointer";
export type WpePointerKind = "move" | "down" | "up";
export interface WpePointerMessage { type: typeof WPE_POINTER; kind: WpePointerKind; x: number; y: number }

export function wpePointerMessage(kind: WpePointerKind, x: number, y: number): WpePointerMessage;

/** 父页面视口里的点 → 元素视口里的 CSS 像素（`wpeContextMenuPoint` 的反函数），不钳制；没有布局或显示矩形为空时 null。 */
export function framePointFromClient(frame: HTMLElement, point: ViewportPoint): ViewportPoint | null;

/**
 * 把一次输入发给 iframe：换算后 postMessage。`down` 只在点落在 iframe 显示范围内时发；`move` / `up` 总发（坐标可越界）。
 * 返回点是否在 iframe 显示范围内；没有 contentWindow、换算不出时返回 false 且不发。
 */
export function postWpePointer(frame: HTMLIFrameElement, kind: WpePointerKind, point: ViewportPoint): boolean;

/** 接收方：返回值同 `postWpePointer`。 */
export type WpePointerSink = (kind: WpePointerKind, point: ViewportPoint) => boolean;

/** 预览画布提供的输入总线：iframe 的持有方登记接收方，覆盖层把输入交给全部接收方。 */
export interface WallpaperPreviewInput {
  /** 登记接收方，返回注销函数。 */
  attach(sink: WpePointerSink): () => void;
  /** 交给全部接收方（每个都调，不短路），返回是否有一个落在自己的 iframe 范围内。 */
  dispatch(kind: WpePointerKind, point: ViewportPoint): boolean;
}
export function createWallpaperPreviewInput(): WallpaperPreviewInput;   // 内部一个 Set<WpePointerSink>
export const WALLPAPER_PREVIEW_INPUT: InjectionKey<WallpaperPreviewInput> = Symbol("wallpaperPreviewInput");
```

## 点 4 — 插件的前端封装（`apps/kabegame/src/utils/desktopCursor.ts`，新增）

```ts
/**
 * 全局光标订阅（tauri-plugin-cursor）。坐标是本窗口客户区里的 CSS 像素，可越界。
 * 不支持（Linux、Android、Web、命令失败）时返回 null，调用方退回页面自己的 pointermove。
 */
export async function subscribeDesktopCursor(onPoint: (point: { x: number; y: number }) => void): Promise<(() => void) | null>;
```
用 `@tauri-apps/api/core` 的 `Channel` 与 `invoke("plugin:cursor|subscribe", { onSample })`；`IS_WEB || IS_ANDROID` 直接返回 null。
退订函数调 `plugin:cursor|unsubscribe`（失败只记 debug 日志），并让之后到达的消息不再回调。

## 点 5 — 覆盖层（`components/wallpaper/WallpaperPointerOverlay.vue`，新增）

- 模板：`<div class="absolute inset-0" @pointerdown @pointermove @pointerup @pointercancel @lostpointercapture />`，透明，不写正的 z-index。
- props：`active: boolean`（预览未暂停）、`input: WallpaperPreviewInput`（父组件建的总线，见点 6）。
- 位置来源：`active` 且文档可见时 `subscribeDesktopCursor`；拿到 null 时置 `fallback = true`，之后用覆盖层的 `pointermove`。
  不活跃、文档隐藏、卸载时退订。插件模式下忽略 `pointermove`（除了按住期间也不用）。
- 左键（`button === 0`）：
  - `pointerdown`：`stopPropagation`；先对全部接收方送 `move`（事件坐标），再送 `down`；任一返回 true 记 `pressed = true`、
    `setPointerCapture(pointerId)`。
  - `pointerup`：`pressed` 时送 `up`（事件坐标），清 `pressed`。
  - `pointercancel` / `lostpointercapture`：`pressed` 时用最后的坐标送 `up`。
- 中键、右键不处理、不阻止冒泡（右键的 `contextmenu` 冒泡到预览容器弹菜单；中键留给步骤 3 的平移）。
- `active` 变假或卸载：`pressed` 时补一次 `up`。
- 送输入一律经 `input.dispatch(kind, point)`。

## 点 6 — 预览画布提供总线（`WallpaperPreviewCanvas.vue`）

```ts
const props = withDefaults(defineProps<{ contentSize?: …; inputActive?: boolean }>(), { inputActive: true });   // 新增 inputActive
const input = createWallpaperPreviewInput();
provide(WALLPAPER_PREVIEW_INPUT, input);
```
模板在 `canvasRef` 之后加 `<WallpaperPointerOverlay :active="inputActive" :input="input" />`。头注释「画布本身不拦指针事件」改成：
盖一层透明覆盖层接住鼠标，转给壁纸 iframe。

## 点 7 — 两个 iframe 登记接收方（`WallpaperStage.vue`、`WpeSceneView.vue`）

```ts
// WallpaperStage.vue
const previewInput = inject(WALLPAPER_PREVIEW_INPUT, null);
let detachPreviewInput: (() => void) | null = null;
// onMounted
detachPreviewInput = previewInput?.attach((kind, point) =>
  webFrameEl && props.interactive ? postWpePointer(webFrameEl, kind, point) : false) ?? null;
// onBeforeUnmount
detachPreviewInput?.();
```
```ts
// WpeSceneView.vue：同样，frame.value 与 props.interactive
```
两处的头注释补一句：预览里鼠标由覆盖层经 `wpePointer.ts` 转来，iframe 本身被覆盖层盖住。

## 点 8 — 垫片派发（`src-tauri/kabegame/src/webview_js/wpe_shim.js`）

- **修改** 把「原生 getter 读 `source` / `data`」（锚点 k）提到垫片开头（`installVolume` 之前），`installVolume` 与新代码共用。
- **新增** `installPointer()`，在 `installContextMenu()` 之后同样用 try/catch 调用：
```js
// ---- 指针：图库预览里 iframe 被覆盖层盖住，父页面把鼠标转成消息发来，这里派发合成事件 ----
// 字面量与 apps/kabegame/src/components/wallpaper/wpePointer.ts 一致（单测核对）。坐标是本视口的 CSS 像素，可越界。
// 合成事件 isTrusted 为假，没有 :hover，原生表单控件拖不动；click 的激活行为照常。场景宿主也加载本垫片，它挂在
// document 上的 pointer 监听原样接住。桌面壁纸窗口不发这条消息（那里是 CEF 原生注入）。
function installPointer() {
  var POINTER = "kabegame:wpe-pointer";
  // 构造器与 elementFromPoint 在页面脚本之前取原生的
  var PointerCtor = window.PointerEvent || window.MouseEvent;
  var MouseCtor = window.MouseEvent;
  var elementFromPoint = Document.prototype.elementFromPoint;
  var hover = null;    // 当前悬停目标
  var pressed = null;  // 按下时的目标
  …
  window.addEventListener("message", function (event) {
    if (!event.isTrusted || read(event, sourceDesc, "source") !== window.parent) return;
    var data = read(event, dataDesc, "data");
    if (!data || typeof data !== "object" || data.type !== POINTER) return;
    // 坐标不是有限数、kind 不认识：丢弃（仍 stopImmediatePropagation，不交给页面）
    event.stopImmediatePropagation();
    …
  }, true);
}
```
派发规则：
- 目标 `targetAt(x, y)`：`0 ≤ x < innerWidth && 0 ≤ y < innerHeight` 时 `elementFromPoint.call(document, x, y)`，取不到或越界时
  `document.documentElement`（再没有就 `document`）。
- 边界：`hover` 不同于新目标时，旧目标上 `pointerout`、`mouseout`（冒泡），按祖先链对「旧链有、新链没有」的元素由内向外 `pointerleave`、
  `mouseleave`（不冒泡）；新目标上 `pointerover`、`mouseover`（冒泡），对「新链有、旧链没有」的由外向内 `pointerenter`、`mouseenter`。
  旧目标已不在文档里（`isConnected` 为假）时跳过它的 out / leave。
- `move`：边界 → `pointermove` → `mousemove`。
- `down`：边界 → `pointerdown` → `mousedown`，记 `pressed = 目标`。
- `up`：边界 → `pointerup` → `mouseup`；`pressed === 目标` 时再 `click`；清 `pressed`。
- 事件参数：`bubbles`（enter / leave 为假）、`cancelable`（move / down / up / over / out / click 为真）、`composed: true`、`view: window`、
  `clientX/Y = screenX/Y = x/y`、`button: 0`、`buttons`（`down` 为 1，其余 0）、`detail`（down / up / click 为 1，其余 0）；pointer 事件另有
  `pointerId: 1`、`pointerType: "mouse"`、`isPrimary: true`、`width: 1`、`height: 1`、`pressure`（`down` 为 0.5，其余 0）。
- 不派发 `dblclick`、`contextmenu`、`wheel`；不调 `focus()`。

## 点 9 — 预览弹窗（`ImagePreviewDialog.vue`）

- **删除** `.preview-nav-hotzone` 的模板（锚点 f 的 `<template v-if="isPreviewWallpaper">`）与样式块、`handleNavZoneLeave` 与两个
  `@mouseleave="handleNavZoneLeave"`：覆盖层在父文档里，容器的 `mousemove` 正常，箭头的显隐和图片一样。
- **修改** `<WallpaperPreviewCanvas>` 加 `:input-active="!wallpaperPaused"`。
- 两处注释同步：`:255-256`（「页面接收指针事件」→「覆盖层接住鼠标转给页面」）、`:309`（右键现在落在覆盖层上，由容器的 `@contextmenu` 处理）。

## 验收

1. **单测**
   - Rust：插件 `cargo test -p tauri-plugin-cursor`（轮询中心的增删与清理、平台换算原单测）；`kabegame` 的 `wallpaper::input_forward`
     5 个单测（经 `deno task test`，只跑相关过滤）。
   - 前端（vitest，只跑相关文件）：
     - `wpePointer.test.ts`：`framePointFromClient` 与 `wpeContextMenuPoint` 往返、带缩放的显示矩形、越界不钳制、没有布局为 null；
       `postWpePointer` 的 `down` 在范围外不发、`move` / `up` 越界照发；垫片源码里的字面量与 `WPE_POINTER` 一致。
     - 垫片派发（node:vm 跑 `wpe_shim.js` 原文件，照 `wpeWebVolume.test.ts` 的环境自配一份带 `elementFromPoint`、元素树、事件构造器的假 DOM）：
       move / down / up 的事件序列与参数；换目标的边界事件（祖先链）；越界落到 `documentElement`；`click` 只在同目标；不可信或来源不是父窗口的
       消息不派发；坐标非有限数丢弃；消息不传给页面自己的 `message` 监听。
     - `WallpaperPointerOverlay`（`@vue/test-utils`）：左键先 move 后 down、范围外不记按下、抬起成对、`pointercancel` 补抬起、`active` 变假补抬起；
       中键 / 右键不送、不阻止冒泡；插件模式忽略 `pointermove`，退回模式用它。
     - 已有的 `WallpaperStage.*.test.ts`、`WpeSceneView.test.ts`、`WallpaperPreviewCanvas.test.ts`、`wpeWebVolume.test.ts` 照过。
   - `deno task check -c kabegame`（vue-tsc + cargo check），Prettier，`cargo fmt`。
2. **变异**：垫片不校验来源；`down` 在范围外也发；覆盖层对中键也 `stopPropagation`；转发去掉「按下时判断桌面」；插件 `Watch` 丢弃后仍调回调。
3. **真机**（`kabegame-dev` MCP；不调 `open_image_preview`，不接管图库）：
   - 桌面网页 / 场景壁纸：跟随与点击照旧（回归里桌面鼠标转发的已有条目），`app_log` 没有新的告警；
   - 场景宿主：`host_open` 打开一个 P6c 测试工程，`host_eval` 向宿主 `postMessage` 合成指针消息，确认光标回调与 `g_PointerPosition` 跟上。
   - 预览覆盖层（窗口外跟随、点击、右键、翻页箭头）要打开预览，写进回归，由用户勾。
4. **文档**：插件 README；`AGENTS.md` 插件列表；`cocs/wpe/WPE_IMPORT.md`（预览的输入：覆盖层、合成事件、热区删除；桌面转发改用插件）；
   `cocs/wpe/WPE_SCENE.md`「已知差别」（预览里窗口外也跟踪，桌面仍不跟踪）；`cocs/README.md` 的 WPE_IMPORT 条目补一句；
   回归 `versions/latest/regression.md` 新增一节；changelog 一行。

## 风险

1. 预览里网页壁纸的合成事件：依赖 `:hover`、原生滑块拖动、`isTrusted` 的页面在预览里交互不完整（桌面不受影响）。
2. macOS 代码本机编不了、测不了：插件里 macOS 部分是原样搬运加 `native_window`，标 `TODO:[WPE_SCENE]`。
3. Linux 预览只在应用窗口里跟随（退回 `pointermove`）。

## 步骤 3（之后另起一轮，不在本节）

壁纸放大：Panzoom 包装层包住 `WallpaperPreviewCanvas`，滚轮 / Ctrl+滚轮 / 工具条缩放同图片，中键拖动平移，左键给壁纸；`WpeSceneView`
上报 `max(实测 ÷ zoom, min(实测, 1))` 的显示缩放；设封面前复位缩放。视频放大再之后。

## 实施记录

### 2026-11-15（Sonnet 子代理两路并行实现，Claude 独立验收）
- **插件**（`src-tauri/tauri-plugin-cursor/`）：照点 1。和计划不同的两处：
  - 轮询线程用 `Condvar::wait_timeout(16 ms)` 代替 `sleep`，`Watch` 丢弃时能提前醒，没有订阅时退出；
  - `Probe` trait 放在 `hub.rs`（crate 内），对外 API 不变。
  - `on_page_load` 在 CEF runtime 下只对主 frame 触发（`tauri-runtime-kbcef` 的 `emit_page_load` 先判 `is_main`），iframe 导航不会清掉预览的订阅。
- **桌面转发**：`input_forward.rs` 只剩 `ForwardState`（不改）与包一层 `Forward`（`Drop` 里补抬起）；`ViewSample` 在这里 round 成 i32，
  和原探针取整一致。`wpe_scene_cursor` 改调插件。
- **前端**：照点 3–9。补充的理解：
  - 覆盖层在 `active` 为假（暂停）时左键直接返回、不阻止冒泡；
  - 插件订阅返回 null 后置 `fallback`，不再重试；
  - 垫片另存上次的祖先链 `hoverChain` 对比，避免目标被摘走后仍连接的祖先被重复 `enter`；
  - 祖先链含 `document`（Chromium 也在 document 上派发 mouseleave）。
- **检查**：
  - Rust：插件 10 条、`input_forward` 5 条全过，cargo check 0 error。
  - 前端：vitest 13 个文件 135 条全过，vue-tsc 只剩别的会话的 `WpeSceneShadowsSetting.vue`，Prettier 通过。
  - 我改了两处：覆盖层测试里的 `any[]` 换成真实类型，工具条注释。
- **变异** 9 / 9（`scratchpad/mutate_front.py`：前端与垫片 7 处在 `__mut__` 拷贝上做，垫片拷到临时目录，不碰会被
  `include_str!` 的原文件；`mutate_plugin.py`：插件 2 处原地改、按字节还原）。
- **真机**（回归 PP3–PP5）：
  - 桌面场景宿主 20 s 收到 14 个可信 `pointermove`；
  - 主窗口订阅首条即推、退订即停，和 `wpe_scene_cursor` 坐标相同；
  - 屏外宿主收到垫片派发的合成事件，序列符合。
  - 预览覆盖层本身（PP6–PP9）要打开预览，留给用户。
- **dev**：改 `src-tauri/kabegame` 与 `wpe_shim.js` 期间 `cargo tauri dev` 自动重编并重启了应用（预期）。重编完成前，开着的预览订阅到的是
  旧后端（`plugin cursor not found`），退回 `pointermove`，重新打开预览即可。
- **文档**：
  - 插件 README；
  - `AGENTS.md`；
  - `WPE_IMPORT.md`：新增「预览的鼠标」，「桌面鼠标转发」改写，更正 macOS 已有桌面转发；
  - `WPE_SCENE.md` 已知差别；
  - `MULTI_SCREEN.md`；
  - `cocs/README.md`；
  - 回归 PP1–PP10；
  - changelog：Added、Changed 各一行。

### 2026-11-15 第二版实施（Claude，dev 停着、用户在编新 CEF）
- **点 A**：CEF 补丁 11、cef-rs 补丁 09 照写；Rust 侧（绑定、运行时、插件、应用）`check-kabegame` 编过。libcef 侧要等新 CEF。
- **点 B（运行时）**：`frame_mouse.rs` 放纯规则（`clamp_to_frame`、`FrameMouseState`，不碰 CEF），`webview.rs` 的 `frame_mouse` 做
  查 frame、比 `base.size`、换算、注入。和计划不同：
  - `FrameMouse::Down` 去掉 `require_inside`，按下一律要求换算后的点（钳制前）在 frame 里。桌面的 iframe 铺满窗口，两种规则下
    行为一样；留白（`fit`）处按下不该钳到边上去点。
  - 删掉 `Win32_UI_Input_KeyboardAndMouse` 特性（只给 `release_own_mouse_capture` 用）。
- **点 C（插件）**：`frames.rs`（登记表、`FrameDriver` 规则、`FrameFeed` 的 `Drop` 发 `Release`）；`HitTest` 取代 `DesktopHit`，加
  `over_window`（Windows 比两边的 `GA_ROOT`，macOS 比 `windowNumberAtPoint`）；加 `build.rs` 生成权限、`links`；命令只剩
  `attach_frame` / `detach_frame`。登记时左键已按着不算按下沿（`was_down: Option<bool>`）。
- **点 D（应用）**：`lib.rs` 设注入器与壁纸窗口池的 `OverDesktop`；删 `input_forward.rs`、`WallpaperWindow` 的 `native_id` /
  `forwarder` / `set_mouse_forwarding`；窗口后端 `set_wallpaper` 没有要做的了，`placement_covers` 与它的测试一并删；`wpe-web.json`
  加两项权限。
- **点 E（前端）**：照计划，另有两处改动：
  - **焦点**：宿主 `main.ts` 把 `window` 的 `blur` 当左键抬起，按下后立刻还焦点会把拖动打断。所以焦点只在预览画布里管
    （`framePointer.ts` 的 `keepFocusOutOfFrames`）：父页面真实左键按着时不还，松开后等 100 ms（注入的抬起先到）再还。桌面壁纸窗口
    不是前台窗口，不管焦点。
  - **Linux**：插件不支持，登记返回 `false`。如果照计划一律 `pointer-events: none` 再盖覆盖层，Linux 预览里壁纸就完全收不到鼠标。
    所以加 `NATIVE_FRAME_POINTER`（Linux 为假）：退回 iframe 可交互时直接收真实鼠标、预览不盖覆盖层、不管焦点（`TODO:[WPE_SCENE]`）。
  - 覆盖层没有单独的组件，是 `WallpaperPreviewCanvas` 里的一个 div（`data-wallpaper-pointer-overlay`），放大时再抽出来。
  - 第一版的 `WallpaperStage` / `WpeSceneView` / `WallpaperPreviewCanvas` / 垫片改动整体退回 HEAD 再改；`ImagePreviewDialog` 保留删热区，
    去掉 `input-active`。
- **检查**：
  - Rust：插件 17 条、钳制 7 条（运行时 crate 的测试要现编 CEF 包装库，环境不齐，`frame_mouse.rs` 不依赖 CEF，用 rustc 单独编测试）。
  - 前端：相关 vitest 82 条全过；`check-kabegame` 0 error。
  - 格式：`cargo fmt` 对运行时与插件 crate 跑了一遍（顺带格式化了运行时 `protocol.rs` 里原有的两处）。垫片与 `wpe-web.json` 在 HEAD 里
    就不过 Prettier，差异不在本次改动里，不动。
- **变异**：Rust 9 / 9（`scratchpad/mutate_v2.py`），前端 8 / 8（`scratchpad/mutate_front_v2.py`），都按原字节还原。
- **文档**：
  - 插件 README 重写；
  - `WPE_IMPORT.md`：「预览的鼠标」「桌面鼠标转发」合成「鼠标（原生注入 iframe）」，相关的过时句子一并改；
  - `WPE_SCENE.md`：已知差别、开场指针、宿主左键；
  - 运行时 README：API 表，补丁 11 / 09；
  - `AGENTS.md`、`cocs/README.md`、`MULTI_SCREEN.md`；
  - 回归：PP 节换成 PN1–PN12；
  - changelog：Added 一行改写，Changed 换成两行。
- **待做**：新 CEF 编好、dev 重启后跑 PN4–PN10（PN7–PN9 要打开预览，由用户勾或允许接管图库界面）。
- **真机（新 CEF，用户 16:04 重启 dev）**：
  - 日志没有「libcef 不带 frame 鼠标注入」，结构体大小检查通过。
  - 桌面场景宿主 8 s 收到 218 个可信 `pointermove`。
  - 预览场景宿主收到可信 `pointermove`，钳在右边界 `2560 - 0.5`。
  - 每个新登记的 frame 第一次采样记一条「frame 坐标换算失败」：frame 还没合成，之后正常。待改成连续失败约 1 s 才 warn；这要改运行时、dev 会重启，等用户这轮手测完再改。
- **换算失败的 warn**（用户手测通过后）：`FrameMouseState` 记连续失败次数，换算成功清零，连续 30 次
  （`MAPPING_WARN_AFTER`）才记一次 warn，每个 frame 只记一次；单测 1 条，变异 3 / 3。翻页只认箭头另提交（`996012d6`）。
