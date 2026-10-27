# Phase 4 — 桌面 `file://` 宿主 + 鼠标转发

> 状态：方案（2026-10-27）。上级：[PLAN.md](PLAN.md)（已确认决策 8、9）。前置：Phase 3 已完成；CEF 补丁
> [0004](../../../../third-patches/cef/0004-per-browser-file-access.patch) 已写入并由用户编译完成。
>
> 范围：桌面壁纸窗口以 `file://` 承载 `x-wpe/web`；运行时按窗口开文件访问并按壁纸目录拦截；Windows 桌面鼠标移动 / 左键转发；
> 删除 `DEBUG-WPE-FILE` / `DEBUG-WPE-INPUT` 临时代码。**不做**：WPE 垫片与作者默认值推送（Phase 5）、暂停冻结 / FPS（Phase 6）、
> 用户属性与 `file` / `directory` 属性白名单（Phase 7）、音频 / 媒体（Phase 8）、键盘与滚轮转发、跨源 `http(s)` 放开。
> 图库预览不动，仍是 Phase 3 的 HTTP 跨源 iframe。

## 总体设计思路

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，并靠关掉同源策略读取同目录文件。Kabegame
在桌面上照这个模型做：壁纸窗口要显示 `x-wpe/web` 时，**整个主 frame 导航到壁纸入口的 `file://` URL**，不再经过 Vue 应用和 iframe；
切到别的壁纸时再导航回应用页 `index.html?window=wallpaper`，由 Vue 应用照旧渲染图片和视频。导航的决定权只在 Rust 一侧：
新的 `WpeWebHost` 订阅当前壁纸变化与壁纸窗口的 ready 握手，按当前壁纸的 `type` 决定壁纸窗口该停在哪个 URL。这样
`WallpaperWindow.vue` 只需在拿到网页壁纸时什么都不做，不会和 Rust 抢导航；页面卸载、Vue 应用重启和 ready 握手都是现有链路。

`file://` 文档读同目录文件需要 Chromium 的 `allow_file_access_from_file_urls` 偏好。先导实验证明只开这一项就足以让 kaguya
这类依赖 `fetch` 的壁纸完整运行，但它同时允许读任意本地文件。所以安全边界分两层，都只作用于壁纸窗口：CEF 补丁 0004 让偏好按
浏览器开启（建窗时 `extra_info` 带 `kabegame.allow_file_access_from_file_urls`），运行时在 `OnBeforeResourceLoad` 里对
这类浏览器的 `file:` 请求做目录约束——只放行当前壁纸目录内的普通文件，拒绝越界、符号链接和目录，当前没有网页壁纸时一律拒绝。
这与 WPE 自己的资源拦截器（API.md §4.1）是同一套规则。`file://` 文档的 Origin 是 `null`，`cef-ipc` 入口本来就拒绝它；运行时再让
这类浏览器的 `file:` 文档**不注入任何初始化脚本**，页面看不到 `__TAURI_INTERNALS__`。

运行时对应用暴露两组按 label 的接口：一组是文件文档策略（建窗前登记 label 以在 `extra_info` 里打标记；运行中设置 / 清空允许的根目录），
一组是鼠标注入（把 `DEBUG-WPE-INPUT` 实验里的 `send_mouse_move_event` / `send_mouse_click_event` 整理成正式 API）。
运行时只做机制，「哪个窗口、哪个目录、何时转发」都由应用决定。

桌面鼠标转发照 WPE 的做法（REA 结论）：不装鼠标钩子，而是由一个后台线程每帧轮询光标位置与左键状态。光标在壁纸窗口范围内
移动就把客户区坐标换算成 CEF 的视图坐标（除以缩放比）注入移动事件；左键状态变化时用 `WindowFromPoint` 看光标下的窗口，只有
它是桌面图标列表（类名 `SysListView32`）或其父窗口是 `SHELLDLL_DefView` / `Progman` 时才注入按下 / 抬起——也就是用户点在桌面空白处或
图标上，而不是点在别的应用窗口上。点击同时照常传给 Explorer，不拦截。转发线程只在「窗口模式 + 当前是网页壁纸」时运行，
第一版只在 Windows 上实现。

关键决策与理由：
- **Rust 是壁纸窗口导航的唯一属主**：页面跑在 `file://` 时 Vue 应用已经卸载，「切回」只能由 Rust 发起；把「切去」也放在 Rust，
  就不会出现两边各自导航的竞态。
- **偏好开在整个壁纸窗口浏览器上，约束靠目录拦截**：偏好在建窗时固定，而壁纸窗口在应用页和 `file://` 之间来回导航；偏好只影响
  `file://` 文档，对应用页（http / tauri 源）没有作用，因此一直开着无害。真正的边界是运行时的目录拦截。
- **鼠标注入走 CEF 而不是 Win32 消息**：壁纸窗口是 CEF Views 窗口，渲染在子进程里；`CefBrowserHost::SendMouse*Event` 直接进
  Chromium 的输入管线，不依赖窗口焦点和 Z 序，WPE 也是这么做的。

## 现状锚点

**a. dev 下的临时全局文件访问开关**（`src-tauri/tauri-runtime-cef/src/runtime.rs`，`on_before_command_line_processing`）
```rust
                apply_windowed_gpu_mode(cl);
                // DEBUG-WPE-FILE 临时先导实验（仅 dev）：全局打开 file:// 页面读同源 file:// 的偏好，……验证完删除
                #[cfg(debug_assertions)]
                cl.append_switch(Some(&CefString::from("allow-file-access-from-files")));   // 现状：对 dev 所有窗口生效
```

**b. 建 browser 时 `extra_info` 只装初始化脚本**（`src-tauri/tauri-runtime-cef/src/webview.rs:1445`、`:1498`）
```rust
        let mut initialization_scripts_extra_info =
            crate::subprocess::initialization_scripts_extra_info(&initialization_scripts_payload)
                .map_err(|error| Error::CreateWebview(Box::new(io::Error::other(error))))?;   // 现状：字典里只有脚本这一个键
        // ...
        let browser_view = browser_view_create(
            Some(&mut client),
            Some(&CefString::from(url.as_str())),
            Some(&BrowserSettings::default()),
            Some(&mut initialization_scripts_extra_info),
            None,
            Some(&mut delegate),
        )
```

**c. 资源请求处理器只管下载 Referer**（`src-tauri/tauri-runtime-cef/src/webview.rs:770`、`:958`）
```rust
            ) -> Option<ResourceRequestHandler> {
                if is_download != 1 {
                    return None;                          // 现状：非下载请求不挂任何处理器，file: 请求不受约束
                }
                // ...
                Some(DownloadReferrerHandler::new(referrer))
            }
    // ...
        pub(crate) struct DownloadReferrerHandler { referrer: Option<String> }
        impl ResourceRequestHandler {
            fn on_before_resource_load(...) -> ReturnValue {
                // 只补 Referer
                ReturnValue::CONTINUE
            }
        }
```

**d. 渲染进程按 browser 注入初始化脚本，不看文档 scheme**（`src-tauri/tauri-runtime-cef/src/subprocess.rs:88`）
```rust
            let is_main_frame = frame.is_main() == 1;
            let source_url = CefString::from(&frame.url()).to_string();
            // ...
            for (index, script) in scripts.iter().enumerate() {
                if script.for_main_frame_only && !is_main_frame {
                    continue;                              // 现状：file:// 主 frame 也会拿到 Tauri 脚本（实测 __TAURI_INTERNALS__ 存在）
                }
                // context.eval(...)
            }
```

**e. 鼠标注入只是调试实验**（`src-tauri/tauri-runtime-cef/src/webview.rs:111`、`src-tauri/kabegame/src/commands/window.rs`）
```rust
    // DEBUG-WPE-INPUT 临时实验：经 CefBrowserHost 直接向某个 webview 注入鼠标事件，……验证完删除。
    pub(crate) fn debug_inject_mouse(webview_label: &str, kind: &str, x: i32, y: i32) -> std::result::Result<(), String> {
        // post_task(UI) → host.send_mouse_move_event / send_mouse_click_event(LEFT)
    }
```
```rust
// DEBUG-WPE-INPUT 临时实验：向壁纸窗口注入鼠标事件，验证完删除（连同 lib.rs 注册与 main.toml 白名单）。
#[tauri::command]
#[cfg(all(target_os = "windows", feature = "standard"))]
pub fn debug_wpe_inject_mouse(kind: String, x: i32, y: i32) -> Result<(), String> { ... }

// DEBUG-WPE-FILE 临时实验：用 file:// 直接开一个 CEF 窗口……
pub async fn debug_wpe_open_file_window<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<String, String> { ... }
```

**f. 壁纸窗口只在创建时决定 URL**（`src-tauri/kabegame/src/wallpaper/manager/window.rs`）
```rust
        let builder = WebviewWindowBuilder::new(
            &self.app,
            WALLPAPER_LABEL,
            WebviewUrl::App("index.html?window=wallpaper".into()),   // 现状：之后再不导航
        )
```
```rust
    async fn set_wallpaper_path(&self, _file_path: &str) -> Result<(), String> {
        // 窗口模式：内容由壁纸页面监听 setting-change 自驱动……此处无需做任何事。
        self.warn_if_window_missing("set_wallpaper_path");
        Ok(())
    }
```

**g. Vue 壁纸窗口把任何目标都交给 `WallpaperStage`**（`apps/kabegame/src/views/WallpaperWindow.vue`）
```ts
    if ("currentWallpaperImageId" in changes) {
      const target = await invoke<WallpaperTarget | null>("get_current_wallpaper_target");
      if (target?.path) {
        state.target = target;          // 现状：x-wpe/web 也会进 Stage 的 HTTP iframe 分支
      }
    }
```

---

## 点 1 — 运行时：按 label 的文件文档策略（`tauri-runtime-cef/src/lib.rs`、`webview.rs`、`subprocess.rs`）
- **新增**
  - 进程级登记表 `FILE_DOCUMENT_POLICIES: Mutex<HashMap<String, Option<PathBuf>>>`（label → 当前允许根目录）。
  - 公开 API：
```rust
/// 新增：建窗前登记。该 label 的 browser 在 extra_info 里带 `kabegame.allow_file_access_from_file_urls = true`
/// （CEF 补丁 0004 据此打开文件访问偏好），并启用 file: 目录约束；初始根目录为空（拒绝所有 file: 请求）。
pub fn allow_file_documents(webview_label: &str);
/// 新增：设置 / 清空允许的根目录。Some(dir) 只放行 dir 内的普通文件；None 拒绝所有 file: 请求。未登记的 label 返回 Err。
pub fn set_file_document_root(webview_label: &str, root: Option<PathBuf>) -> Result<(), String>;
```
- **修改**（`webview.rs` 建 browser 处）
  - label 已登记时，在 `initialization_scripts_extra_info` 字典里追加 bool 键 `kabegame.allow_file_access_from_file_urls`
    （同一个字典；弹窗路径 `on_before_popup` 不追加——壁纸窗口不开弹窗，偏好不随弹窗扩散）。
  - `get_resource_request_handler`：label 已登记且请求 URL scheme 为 `file` 时返回新的 `FileDocumentGuardHandler`；
    下载请求维持 `DownloadReferrerHandler`。
```rust
        impl ResourceRequestHandler {
            fn on_before_resource_load(&self, ..., request: Option<&mut Request>, ...) -> ReturnValue {
                // 新增：URL → 本地路径（url::Url::to_file_path，百分号解码）；
                // symlink_metadata 必须是普通文件（拒绝符号链接 / 目录 / 不存在）；
                // canonicalize 后 starts_with(canonicalize(root))（Windows 去 \\?\ 前缀后比较，大小写按现有 path_key 口径）；
                // 任一不满足或 root 为 None → ReturnValue::CANCEL，并 eprintln!("[cef-runtime] deny file: {url} (outside {root})")
            }
        }
```
  - `subprocess.rs`：`on_browser_created` 同时记录该 browser 的 extra_info 是否带上述键；`on_context_created` 对带键的 browser，
    `frame.url()` 的 scheme 为 `file` 时跳过全部初始化脚本。
- **删除**
  - 现状锚点 a 的 `DEBUG-WPE-FILE` 全局开关。

## 点 2 — 运行时：正式的鼠标注入 API（`tauri-runtime-cef/src/lib.rs`、`webview.rs`）
- **修改**
  - `debug_inject_mouse` 改名为 `inject_mouse`，去掉 `DEBUG-WPE-INPUT` 注释，参数改成类型化：
```rust
pub enum MouseInjection {
    Move { x: i32, y: i32 },            // 视图坐标（DIP）
    Leave { x: i32, y: i32 },           // send_mouse_move_event(mouse_leave = 1)
    LeftDown { x: i32, y: i32 },        // send_mouse_click_event(LEFT, up=0, click_count=1)
    LeftUp { x: i32, y: i32 },          // send_mouse_click_event(LEFT, up=1, click_count=1)
}
pub fn inject_mouse(webview_label: &str, input: MouseInjection) -> Result<(), String>;
```
  - 移动事件高频：`inject_mouse` 只 `post_task` 不等待回执（现状的 2s `recv_timeout` 去掉），找不到 browser 静默返回 `Ok`。
  - ~~移动时 `modifiers` 带上 `EVENTFLAG_LEFT_MOUSE_BUTTON`~~（已撤销：移动一律 `modifiers=0`，同 WE，见 `WPE_INPUT_RE.md`；带左键会启动页面图片的 OLE 拖放并挂住 UI 线程）。

## 点 3 — 应用：`WpeWebHost`，壁纸窗口导航的唯一属主（新增 `kabegame/src/wallpaper/wpe_web_host.rs`）
- **新增**
  - 状态：`mode: App | File { image_id, entry_url }`、`app_url: Option<Url>`（第一次离开应用页前从壁纸 webview 读取当前 URL 并记住，
    dev 是 `http://localhost:1420/index.html?window=wallpaper`、prod 是 tauri 资源 URL，不手拼）。
  - `sync(app)`：读当前壁纸行（复用 `get_current_wallpaper_target_from_settings` / `build_wallpaper_target`），
    - `x-wpe/web`：`read_project(dir)` 取 `file`，入口 = `dir.join(file)`（拒绝越界，复用 `wpe::project` 的相对路径校验）；
      `set_file_document_root("wallpaper", Some(dir))` → 壁纸 webview `navigate(Url::from_file_path(entry))`；同一 image_id 不重复导航。
    - 其它类型或无壁纸：若当前在 `File` 模式，先 `set_file_document_root(None)` 再 `navigate(app_url)`；在 `App` 模式什么都不做
      （Vue 应用照旧自驱动）。
  - 触发点：
    - 当前壁纸变化（`currentWallpaperImageId` 的 `setting-change`；用 Rust 侧事件订阅，挂点实现时确认，不新增事件类型）；
    - `wallpaper_window_ready`（应用页启动完成后检查一次：开机即为网页壁纸时由此切去 `file://`）；
    - 窗口销毁（`cleanup`）时把状态复位为 `App`、根目录清空。
- **修改**
  - `wallpaper/manager/window.rs::create_window`：建窗前调用 `tauri_runtime_cef::allow_file_documents(WALLPAPER_LABEL)`
    （`#[cfg(feature = "standard")]` 等现有 CEF 门控）。
  - `commands/window.rs::wallpaper_window_ready`：`mark_ready()` 之后调用 `WpeWebHost::sync`。
- **说明**
  - 网页壁纸只在窗口模式出现（Phase 3 的可用性判定已保证）；样式、过渡、音量、倍速对 `file://` 页面不生效，第一版接受。
  - 导航本身不经过 Vue，切换没有过渡动画（WPE 也是直接切换）。

## 点 4 — Vue 壁纸窗口让出网页壁纸（`apps/kabegame/src/views/WallpaperWindow.vue`）
- **修改**
  - 初始化与 `currentWallpaperImageId` 变化时，拿到 `type === "x-wpe/web"` 的目标**不赋给** `state.target`（保持现有画面，Rust 马上导航走）。
```ts
function acceptTarget(target: WallpaperTarget | null) {
  if (!target?.path) return;
  // 桌面网页壁纸由 Rust（WpeWebHost）把整个窗口导航到 file:// 入口，这里不渲染。
  if ((target.type || "").trim().toLowerCase() === "x-wpe/web") return;   // 新增
  state.target = target;
}
```
- **不做**
  - `WallpaperStage` 的 web 分支保留，图库预览继续用它。

## 点 5 — Windows 桌面鼠标转发（新增 `kabegame/src/wallpaper/input_forward.rs`）
- **新增**（`#[cfg(target_os = "windows")]`）
  - 后台线程，`WpeWebHost` 进入 `File` 模式时启动、离开时停止（`AtomicBool` 停止标志 + `JoinHandle`），周期 16ms：
    - `GetCursorPos` 得屏幕坐标；`GetAsyncKeyState(VK_LBUTTON) & 0x8000` 得左键状态。
    - 壁纸窗口 HWND（`window.hwnd()`）`ScreenToClient` 得客户区物理坐标；不在客户区矩形内时：上一帧在内则注入一次 `Leave`，否则跳过。
    - 物理坐标除以 `window.scale_factor()` 得视图坐标。
    - **移动**：坐标与上一帧不同就注入 `Move`（左键按住时带按键标志）。
    - **点击**：左键 按下沿 → `WindowFromPoint(cursor)`，类名为 `SysListView32`，或其父窗口类名为 `SHELLDLL_DefView` / `Progman`
      （再向上一层 `WorkerW` 也算）时注入 `LeftDown` 并记 `down_forwarded = true`；抬起沿 → 只要 `down_forwarded` 就注入 `LeftUp`，
      保证按下 / 抬起成对。
  - 不拦截、不吞掉任何输入：Explorer 照常收到点击（桌面图标选中状态会变，与 WPE 一致）。
- **不做**
  - 键盘钩子、滚轮、右键、设置开关（第一版恒开；需要开关时按 settings 架构加 descriptor）。macOS / Linux 不转发。

## 点 6 — 清理临时代码
- **删除**
  - `DEBUG-WPE-FILE`：运行时全局开关（点 1 已列）、`debug_wpe_open_file_window` 命令及其 `lib.rs` 注册与 `main.toml` 白名单。
  - `DEBUG-WPE-INPUT`：`debug_wpe_inject_mouse` 命令及其注册与白名单（运行时函数由点 2 转正）。
  - 全仓 `grep -rn "DEBUG-WPE-" src-tauri apps` 结果为空。

## 点 7 — 文档与回归
- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：新增「桌面网页壁纸：`file://` 宿主」与「桌面鼠标转发」两节（导航属主、补丁 0004、目录拦截规则、
    初始化脚本隔离、转发规则与平台范围、已知边界：跨源 http 仍受 CORS、样式 / 音量对网页壁纸不生效、无键盘 / 滚轮）。
  - `src-tauri/tauri-runtime-cef/README.md`：文件文档策略与鼠标注入两组公开 API。
  - `AGENTS.md` 文件类型段：`x-wpe/web` 行改为「桌面经 `file://` 加载（补丁 0004 + 目录拦截），图库预览经 `/wpe/<imageId>/` 跨源 iframe」。
  - `cocs/README.md` 的 WPE 条目同步主题与适用场景。
  - `versions/latest/regression.md` 新增一节，`changelog.md` 补一行。
- **新增**（运行时单元测试）
  - 目录约束判定函数抽成纯函数并测试：目录内文件放行、`..` 越界拒绝、兄弟壁纸目录拒绝、目录本身拒绝、root 为 None 全拒、百分号编码路径解码。

## 验收
- `check-kabegame` 通过；`test-kabegame` 跑 `tauri-runtime-cef` 的新单测。
- 真机（用户已在跑 dev，Rust 改动后 dev 自行重建，**不 sleep 轮询**，连不上就记为未验证）：
  1. 先确认 dev 用的是新编译的 CEF（临时全局开关已删，若 kaguya 仍能 `fetch` 即证明 0004 生效）。
  2. 把 kaguya（`3679122549`）设为壁纸：`targets` 里壁纸窗口 URL 变为其 `file:///…/index.html`；页面内 `fetch('data.json')` 200、
     `fetch('file:///C:/Windows/win.ini')` 失败、`fetch('../796697921/project.json')` 失败、`typeof __TAURI_INTERNALS__ === 'undefined'`。
  3. 主窗口（应用页）里 `fetch('file:///C:/Windows/win.ini')` 失败——偏好与约束只作用于壁纸窗口。
  4. 切到普通图片 / 视频壁纸：壁纸窗口回到 `index.html?window=wallpaper` 并正常显示；再切回 kaguya 又导航到 `file://`。
  5. 鼠标转发：在 kaguya 页面里临时挂 `mousemove` / `mousedown` 计数（经 CDP），在桌面空白处移动与点击后计数增长；点在别的应用窗口上
     时 `mousedown` 不增长。
  6. 切到原生模式再切回窗口模式，开机即网页壁纸的路径（窗口重建 → ready → 导航到 `file://`）正常。
- `git status` 只出现方案内文件；不提交。
