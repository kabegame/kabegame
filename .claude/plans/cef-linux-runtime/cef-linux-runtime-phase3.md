# Phase 3 — 接入 Tauri:前端在 CEF(软件 OSR)里跑起来

> 父计划:[cef-linux-runtime.md](cef-linux-runtime.md)。背景/调研见 `src-tauri/tauri-runtime-cef/README.md`。
>
> **渲染层(2026-06-20 决策)**:用**软件 OSR**(`examples/minimal.rs` 那条:CEF windowless → `on_paint` BGRA → blit 到 tao 窗口)。GPU(修 cef-rs dmabuf 导入器或转路线 A)**推迟**,见 README §9.2.2。
>
> **目标**:Linux 上 `bun dev -c kabegame` 用 CEF 渲染出 kabegame 前端(可有功能缺口);其余平台不受影响。
>
> **不可跳过的硬约束**:实现 `tauri_runtime::Runtime` 让 `tauri::Builder::<Cef<EventLoopMessage>>` 能 `.build()` 并 `.run()`。窗口那半边尽量**照抄 `tauri-runtime-wry`**(都是 tao);webview 那半边接我们的 OSR CEF。

---

## 现状锚点

**a. 骨架类型**(`src/lib.rs`)
```rust
pub struct Cef<T: UserEvent> { _marker: PhantomData<T> }          // 现状:空壳,未实现 Runtime
pub struct CefHandle<T: UserEvent> { _marker: PhantomData<T> }    // 未实现 RuntimeHandle
pub struct CefEventLoopProxy<T: UserEvent> { _marker: PhantomData<T> } // 未实现 EventLoopProxy
// runtime.rs / webview.rs / window.rs 仅类型脚手架与方法清单注释
```

**b. 已验证可用的渲染闭环**(`examples/minimal.rs`)
```text
execute_process → initialize(windowless+external pump) → tao 窗口
→ browser_host_create_browser(windowless, client=RenderHandler)
→ on_paint(BGRA) 存帧 → run_return 每 tick: do_message_loop_work + blit
```
这套要从 example“产品化”进 runtime.rs/webview.rs/window.rs。

**c. `Runtime` trait 表面**(`tauri-runtime/src/lib.rs`,实测)
```rust
pub trait Runtime<T: UserEvent>: Sized + 'static {
  type WindowDispatcher: WindowDispatch<T, Runtime = Self>;
  type WebviewDispatcher: WebviewDispatch<T, Runtime = Self>;
  type Handle: RuntimeHandle<T, Runtime = Self>;
  type EventLoopProxy: EventLoopProxy<T>;
  fn new(args: RuntimeInitArgs) -> Result<Self>;
  fn handle(&self) -> Self::Handle;
  fn create_proxy(&self) -> Self::EventLoopProxy;
  fn create_window<F>(&self, pending: PendingWindow<T, Self>, after: F) -> Result<DetachedWindow<T, Self>>;
  fn create_webview(...) -> Result<DetachedWebview<T, Self>>;       // ← OSR CEF 接这里
  fn run<F: FnMut(RunEvent<T>)>(self, callback: F);                 // ← tao run + 泵 CEF
  fn run_return(...); fn run_iteration(...);
  // monitors / cursor / theme / show / hide / set_* …(可先抄 wry / 部分 stub)
}
```

---

## 拆解(每步 = 可编译的提交单元)

### 点 1 — tao 事件循环骨架 + `Runtime::new` / `run`
- **新增** `runtime.rs`:`Cef<T>` 持有 tao `EventLoop`(参照 wry `tauri-runtime-wry/src/lib.rs` 的 `Wry::new`)。
  - `EventLoopProxy`:包 tao `EventLoopProxy<Message<T>>`,实现 `send_event`。
  - `RuntimeHandle`:线程安全句柄(`create_window`/`create_webview`/`request_exit` 转发到主线程,用 channel)。
  - `run` / `run_return` / `run_iteration`:跑 tao `run_return`,**每轮 `do_message_loop_work()` 驱动 CEF 外部泵**(把 minimal.rs 的循环搬进来),并把 tao 事件翻译成 `RunEvent<T>` 回调。
- **CEF 生命周期**:`Runtime::new` 里做 `api_hash` / `execute_process`(子进程提前返回)/ `initialize`(windowless + external_message_pump + no_sandbox + resources_dir,命令行注入 `ozone-platform=x11`/`no-sandbox`/`disable-gpu`)。
  > 注意:子进程提前返回必须发生在 `tauri::Builder` 之前 —— 见点 5。
- **验收**:crate 编译;`Cef` 满足 `Runtime` 的 new/run/proxy/handle(其余关联类型可先用 `unimplemented!()` 占位但类型齐全)。

### 点 2 — 窗口半边 `WindowDispatch` + `WindowBuilder`(抄 wry)
- **新增** `window.rs`:`CefWindowDispatcher` 持有 tao `Window`,把 ~78 个 `WindowDispatch` + ~53 个 `WindowBuilder` 方法**映射到 tao**(大段照抄 `tauri-runtime-wry`,注明出处)。
- **新增** `Runtime::create_window`:建 tao 窗口、跑 window 事件转发(参照 wry 的 `WindowMessage` 派发)。
- 先实现启动必需子集(create/inner_size/scale_factor/set_title/show/close/事件),其余可 stub。
- **验收**:能 `tauri::Builder::<Cef>::default().build()` 出一个空 tao 窗口(还没 webview)。

### 点 3 — webview 半边 `WebviewDispatch` + `create_webview`(接 OSR CEF)
- **新增** `webview.rs`:`CefWebviewDispatcher`。`Runtime::create_webview`:
  - 在父 tao 窗口上建一个 **windowless CEF browser**(client = OSR `RenderHandler`,把 minimal.rs 的 RenderHandler/Client 搬进来)。
  - `on_paint(BGRA)` → 存进该窗口的共享帧;tao 重绘/每 tick → **软件 blit 到该窗口**(softbuffer)。
  - 视口尺寸跟随窗口 resize(`view_rect` + `was_resized`)。
  - `eval_script` / `url` / `navigate` 等先实现启动必需子集。
- **验收**:CEF 把一个 `data:`/本地 HTML 渲染进 Tauri 管理的窗口。

### 点 4 — 自定义协议 `protocol.rs`(serve 前端)
- **新增** `protocol.rs`:`CefSchemeHandlerFactory` + 异步 `CefResourceHandler`,处理 Tauri 的 `tauri://localhost` / `asset://`,把 `PendingWindow` 里 Tauri 提供的 `web_resource_request` handler 的响应回流(MIME、流式、Range)。
- init script 注入:render 进程 `on_context_created` 注入 Tauri 的 initialization scripts(`window.__TAURI_INTERNALS__` bootstrap)。
- **验收**:kabegame 打包前端(Vue)在 CEF 里加载并显示(IPC 还没通,留 Phase 4)。

### 点 5 — kabegame 入口双门控
- **修改** `src-tauri/kabegame/Cargo.toml`:
  ```toml
  [target.'cfg(target_os = "linux")'.dependencies]
  tauri-runtime-cef = { path = "../tauri-runtime-cef", features = ["cef-backend"] }
  ```
- **修改** kabegame 入口:Linux → `tauri::Builder::<Cef<_>>::new()`;其余 → `Builder::default()`。
  - CEF 子进程派发(`execute_process`)必须在 `main` 最早、`Builder` 之前;非浏览器进程 `exit`。
- **验收**:Linux `bun dev -c kabegame` 用 CEF 出前端;Android/Win/macOS 构建与行为不变(双门控见 README §3)。

---

## 风险 / 待解
- **scheme handler 异步流式**:大图/视频的 Range 请求、MIME;参照 wry 的 custom protocol。
- **init script 时机**:必须在每个 frame 的 JS context 创建时注入,且早于前端脚本。
- **窗口 ↔ OSR 尺寸/DPI/焦点**:OSR 下输入事件(鼠标/键盘/滚轮)要从 tao 转发给 CEF(`send_mouse_*`/`send_key_event`)——可能要并入点 3 或单列。
- **软件 blit 性能**:大窗口逐像素转换是瓶颈(README §9.3 TODO);Phase 3 先正确、后优化;GPU 仍是 §9.2.2 的后续。
- **多 webview / 多窗口**:先支持单窗口单 webview,够 kabegame 主窗口即可。

## 参考
- wry 实现范文(窗口半边照抄):`/home/cm/code/tauri-tauri-v2.10.0/crates/tauri-runtime-wry/src/lib.rs`
- 本仓库已验证的 OSR 闭环:`src-tauri/tauri-runtime-cef/examples/minimal.rs`
- trait 契约:`tauri-runtime/src/{lib,window,webview}.rs`

## Phase 3 落地记录(2026-06-20)

已完成的可验证范围:

- `src-tauri/tauri-runtime-cef` 已实现 `tauri_runtime::Runtime` / `RuntimeHandle` / `EventLoopProxy` / `WindowDispatch` / `WindowBuilder` / `WebviewDispatch` 的 Linux CEF 后端。
- runtime 在 `new_any_thread` 中初始化 CEF(windowless + external pump + no_sandbox + disable-gpu),并在 `run_return` 的 tao 循环里执行 `cef::do_message_loop_work()`。
- 窗口半边使用 tao；支持 Tauri 创建窗口、基础窗口 getter/setter、窗口事件转发、Linux `gtk_window/default_vbox/raw_window_handle` 回调。
- webview 半边接入软件 OSR:windowless browser + `RenderHandler::on_paint` BGRA 缓冲 + `softbuffer` blit 到 tao 顶层窗口；支持基础 `navigate` / `reload` / `eval_script` / `set_size` / resize。
- kabegame Linux standard/light 入口已门控到 `tauri::Builder::<tauri_runtime_cef::Cef<tauri::EventLoopMessage>>::new()`；CEF 子进程派发已放到 `main` 最早位置。

当前有意保留的缺口:

- Linux CEF 入口目前是 Phase 3 最小渲染路径:加载 Tauri 配置里的前端 URL,暂不注册 kabegame 现有 IPC 命令、插件和后台服务，避免把全应用 `AppHandle<Wry>` 一次性泛型化。IPC/命令桥接继续归 Phase 4。
- 自定义协议 `tauri://localhost` / `asset://` 和 init script 的完整 CEF render-process 注入尚未完成；dev 模式主要依赖 Vite devUrl。
- OSR 输入事件(鼠标、键盘、滚轮、IME)尚未从 tao 转发到 CEF；当前目标是前端 first paint。
- `run_iteration` 仅做轻量 pump/blit,主应用路径使用 `run` / `run_return`。

验证:

- `cargo check -p tauri-runtime-cef --features cef-backend` 通过。
- `cargo check -p kabegame --features standard` 在进入 kabegame 代码前被 `rusty_ffmpeg` build script 阻断:当前 shell 未设置 `FFMPEG_PKG_CONFIG_PATH` / `FFMPEG_LIBS_DIR` / `FFMPEG_LINK_MODE`。项目的 bun 构建插件会设置这些变量；直接 cargo 检查需要同等环境。

---

## Phase 3.x — 剩余工作分段补充(2026-06-20)

骨架已落地(上节)。剩余 Phase 3 工作拆成可独立提交的子段,建议顺序 3.1 → 3.2 → 3.3,3.4 可穿插:

| 子段 | 主题 | 验收 |
|---|---|---|
| [✅ 3.1 自定义协议 + init script](cef-linux-runtime-phase3.1.md) | `tauri://localhost`/`asset://` scheme handler + 注入 `__TAURI_INTERNALS__` | `cargo check --all-targets --features cef-backend` 通过;production 实跑归 3.3 |
| [✅ 3.2 OSR 输入转发](cef-linux-runtime-phase3.2.md) | tao 鼠标/键盘/滚轮 + GTK IMMulticontext → CEF `send_*`/IME | 静态检查与 6 个单测通过;实际 UI 验收归 3.3 |
| [3.3 端到端跑起来 + 验证](cef-linux-runtime-phase3.3.md) | 解决 FFmpeg/CEF env、实际启动、平台门控回归 | `bun dev -c kabegame` Linux 出前端 |
| [3.4 方法补齐 + DPI/光标 + run_iteration](cef-linux-runtime-phase3.4.md) | 补 kabegame 用到的 window/webview 方法、DPI、光标 | 主窗口行为与换引擎前一致 |

> IPC/命令/插件桥接仍归 **Phase 4**(见根计划);本阶段只到"前端可加载 + 可交互"。
