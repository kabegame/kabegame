# tauri-plugin-cursor

轮询全局光标，并把它作为原生鼠标事件注入登记过的子 frame。使用方是网页壁纸与场景宿主的 iframe，图库预览（主窗口）和
桌面壁纸窗口走同一条路：

- iframe 自己登记（`plugin:cursor|attach_frame`）；
- 插件按它所在窗口轮询光标，把移动与左键交给应用设的注入器；
- 注入器（`kabegame` 的 `lib.rs`）经 CEF 补丁 11 把事件直接注入那个 frame。

## 模型

插件有一个进程级的轮询中心：有订阅时，一条后台线程（`cursor-poll`）每 16 ms 读一次全局光标与左键，
按每个订阅自己的窗口换算成视图坐标。没有订阅时线程退出，不忙等；下一个订阅再起。

- 所有回调在同一条轮询线程上依次调用。
- 订阅被丢弃（`Watch` drop）或窗口不在了，回调随之在轮询线程上 drop，回调的 `Drop` 里可以补发收尾事件。

每个登记的 frame 一个订阅（`frames.rs`），规则如下：

| 事件 | 什么时候交给注入器 |
|---|---|
| 移动 | 位置变了就发，光标在窗口外也照发。钳进 frame 由注入器做 |
| 按下 | 只在左键按下沿发，还要光标在窗口范围内、且满足这个窗口的点击规则。登记时左键已按着不算 |
| 抬起 | 只在按下发过时发，保证成对 |
| 收尾（`Release`） | 解除登记、frame 销毁（`SubframeDestroyed`）、主文档开始加载新文档、窗口销毁时发一次。注入器补未配对的抬起与一次离开 |

点击规则按窗口 label 设（`set_click_rule`）：

| 规则 | 判定 | 用在 |
|---|---|---|
| `OverWindow`（缺省） | 光标下的顶层窗口就是本窗口 | 主窗口（图库预览）。应用内的点击才算，允许和浮在 frame 上的界面重叠 |
| `OverDesktop` | 光标下是桌面（空白处或图标，不是别的应用窗口） | 壁纸窗口池 `WALLPAPER_LABELS`。壁纸窗口在桌面层，真实点击落在系统桌面上 |

插件只给「光标位置、左键是否按着、光标下是什么」，怎么注入由应用定：插件不依赖 CEF runtime。

## 坐标系

视图坐标：光标相对窗口客户区左上角，单位 CSS 像素。Windows 是客户区物理像素除以 `GetDpiForWindow / 96`，
macOS 是点，两者都等于应用页的 `clientX` / `clientY`，也等于 CEF 的浏览器视图坐标。

- 不取整。
- 光标在窗口外时也给出，可为负或越界，`Sample.inside` 标明是否在窗口范围内。

换算到 frame 坐标、钳进 frame 的是运行时（`tauri_runtime_kbcef::frame_mouse`）：

- 换算用 CEF 补丁 11 的 `CefFrame::ConvertPointFromView`，已含父页面的 CSS 变换、缩放与滚动。
- 点在 frame 外时，取「frame 中心到该点的连线」与 frame 边界的交点，再向右、下边界内收半个像素。

## Rust API

```rust
pub type NativeWindow = isize;                       // Windows: HWND；macOS: NSWindow.windowNumber
pub struct Sample { pub view: (f64, f64), pub inside: bool, pub left_down: bool }
pub trait HitTest { fn over_desktop(&mut self) -> bool; fn over_window(&mut self) -> bool; } // 只在需要时求值
pub struct Watch;                                    // 丢弃即停止

pub enum FrameInput { Move { x, y }, Down { x, y }, Up { x, y }, Release }
pub enum ClickRule { OverWindow, OverDesktop }

pub fn set_frame_injector(f: impl Fn(&str /* label */, &str /* frame */, FrameInput) + Send + Sync + 'static);
pub fn set_click_rule(label: &str, rule: ClickRule);
pub fn watch(native: NativeWindow, on_sample: impl FnMut(Sample, &mut dyn HitTest) + Send + 'static) -> Option<Watch>;
pub fn native_window<R: Runtime>(window: &Window<R>) -> Option<NativeWindow>;
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)>;
pub fn init<R: Runtime>() -> TauriPlugin<R>;
```

- 注入器在轮询线程上调用，不能阻塞。应用在 setup 时设一次，没设时登记返回 `false`。
- `native_window` 在 macOS 上要同步等主线程，只在异步命令或不持锁处调用。
- `position_in_window` 给场景开场时问一次真实光标用（`wpe_scene_cursor`）。

## JS 命令

两个命令都只能由子 frame 调用，从主 frame 调会报错。

| 命令 | 说明 |
|---|---|
| `plugin:cursor\|attach_frame` | 登记调用方 frame（`tauri::ipc::CallerFrame::Sub`）。已登记时什么都不做。返回 `true` 表示在注入；平台不支持或应用没设注入器时返回 `false` |
| `plugin:cursor\|detach_frame` | 解除登记，补抬起与离开。没登记过时什么都不做 |

权限 `cursor:allow-attach-frame` / `cursor:allow-detach-frame`（`default` 两个都含），本应用给 `wpe-web-capability`
（`file:` 子 frame，网页壁纸与场景宿主都匹配）。

登记与否由 iframe 里的垫片 `wpe_shim.js` 决定：父页面的音量消息（`kabegame:wpe-volume`）带 `interactive` 与 `paused`，
`interactive && !paused` 时登记，否则解除。调用排队，先后两次不会乱序落地。

## 平台

| 平台 | 状态 |
|---|---|
| Windows | `GetCursorPos` / `GetAsyncKeyState(VK_LBUTTON)`。桌面判定：`WindowFromPoint` 的根窗口是 `Progman` / `WorkerW`。本窗口判定：`WindowFromPoint` 的根窗口就是本窗口的根窗口 |
| macOS | `NSEvent.mouseLocation` + 窗口服务。桌面判定：`windowNumberAtPoint` 命中窗口层级不高于桌面图标层。本窗口判定：`windowNumberAtPoint` 就是本窗口。`native_window`、`position_in_window` 与本窗口判定未实测 |
| Linux | 不支持：`watch` 返回 `None`，`attach_frame` 返回 `false`。X11 可用 `XQueryPointer`，Wayland 拿不到全局光标 |
