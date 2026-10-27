# Phase 5 — 运行时垫片与宿主协议

> 状态：方案（2026-10-27），待实施。
> 范围：
> - WPE 全局接口垫片 `wpe_shim.js`，以 all-frames 初始化脚本注入；
> - 桌面壁纸窗口 `file://` 页面放开 Tauri IPC，但只给一组受限权限；
> - 运行时修正 `file:` frame 的 IPC 来源判定；
> - 作者默认值（`applyUserProperties`）与界面语言（`applyGeneralProperties`）的拉取和推送；
> - 预览 iframe 经父页面中转。
>
> **不做**：
> - 暂停冻结与 `setPaused`、FPS（Phase 6）；
> - 用户改属性与增量推送的触发源（Phase 7，本 Phase 的 diff 投递已能承接）；
> - `file` / `directory` 属性与 `wallpaperRequestRandomFileForProperty`（Phase 7 再定）；
> - 音频与媒体数据（Phase 8，注册函数先收下回调、不回调）；
> - zcompat 兼容补丁（本机没有受影响的壁纸）；
> - Web 发布版（没有初始化脚本能力，预览仍是无属性状态）。

## 总体设计思路

WPE 网页壁纸要靠宿主提供的一组全局接口才能完成初始化。最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：宿主把作者默认值推给它之后，多数壁纸才开始画。Phase 5 用一份 JS 垫片 `wpe_shim.js` 在壁纸页面里定义这组接口，并负责把属性投递给页面。
我们不照搬 WPE 的「宿主拼 JS 字符串、加载完成前在宿主侧排队」（[API.md §4.8](API.md)），改成**拉取 + 订阅**：
- 垫片在文档开始时向宿主拉一份完整状态快照，再订阅之后的状态更新；
- 什么时候回调页面、回调哪些键，全部由垫片决定。宿主只负责给出「当前完整状态」，不排队，也不记页面收到过什么。

两种宿主共用这一份垫片，只是传输通道不同：

**桌面壁纸窗口**：主 frame 就是壁纸目录里的 `file://` 入口（Phase 4）。Phase 5 让 Tauri 的初始化脚本照常注入这个页面，垫片直接用 `__TAURI_INTERNALS__`：
- 拉取：调用 `wpe_web_pull_state`。这个命令不接收 id，由 `wpe_web_host` 记下的当前壁纸决定返回谁的状态。
- 推送：`wpe_web_host` 在状态变化时向壁纸窗口发 `wpe-web-state` 事件，垫片用 `plugin:event|listen` 接收。

**图库预览**：页面是主窗口里的跨源 HTTP iframe，外部页面始终碰不到 IPC。
- 拉取：垫片 `postMessage` 给父页面（应用页），父页面的预览桥用主窗口权限调用 `get_wpe_web_state(imageId)`，再 `postMessage` 回 iframe。
- 推送：界面语言变化时，父页面重新拉一次，再把新状态发过去。

**桌面放开 IPC 的前提**是 `file://` 页面的请求被 Tauri 判成远程来源 `file:///…`，只有专门的 `wpe-web-capability` 对它生效。这个前提**目前不成立**：
- `file://` 文档的 `Origin` 请求头是 `null`。Tauri 的 `ipc://` 主通道解析失败后，前端脚本会自动改走 `cef-ipc` 回退通道。
- 运行时在回退通道里拿不到合法 `Origin` 时，退回用 webview 的初始 URL，也就是应用页。于是请求被当成 `Origin::Local`，拿到 `main-capability` 的全部命令。
- Phase 4 文档写的「`cef-ipc` 入口本来也拒绝」并不成立，只是 Phase 4 没注入 invoke key，这个缺口才没暴露出来。

所以第一步是在运行时的协议层统一修正：请求来自 `file:` frame 时，把 `Origin` 改写成该 frame 的真实 URL。两条 IPC 通道都经过协议层，一处修好。之后再删掉 Phase 4「`file:` 文档不注入任何初始化脚本」的规则，安全边界改由 ACL 承担：
- Tauri 自身的脚本都只进主 frame，子 frame 拿不到 invoke key；
- 垫片自己按地址判断是否启用。

**接受的取舍**：`core:event:allow-listen` 没有按事件名的作用域，壁纸页面因此能订阅应用的全部全局事件。用户确认这是可接受的取舍，也算是开放给壁纸的一项能力。命令层仍然只开一个拉取命令。

**投递语义**（我们自己的规则，不跟 WPE）：
- 第一次完整投递在 `window` 的 `load` 事件之后。为 WPE 写的页面默认回调时 DOM 已就绪，WPE 自己也晚于 `load` 投递。
- 之后到达的状态与上次投递的状态做差：用户属性只推值变化的键，通用属性有变化就整份推。
- 第一次投递之后，页面若给 `wallpaperPropertyListener` 换了新对象，垫片在下一个微任务把当前完整状态补投给它。这依靠在 `window` 上安装这个属性的访问器，页面无论写成 `window.x = …` 还是顶层 `var x = …` 都会走到 setter。
- `load` 之前的赋值只记下来，不提前回调。

**状态只在 Rust 侧计算，只有一份来源**：
- 用户属性取自图片 metadata（导入时存的 `project.json` 原文）里 `general.properties` 中带 `value` 的条目。
- 通用属性第一版只有 `language`，用 WPE 码表的连字符形式（`zh-chs` 等，见 API.md §3.1）。
- `fps` 等 Phase 6 有了设置再推。推 0 会让按 `1000 / fps` 算间隔的页面停住。
- 每份状态带一个单调递增的 `rev`，垫片丢弃比已收到的更旧的状态，避免拉取结果和推送事件交错时旧的覆盖新的。

## 现状锚点

**a. 协议层只记 frame 是否为主 frame**（`tauri-runtime-cef/src/protocol.rs`）
```rust
#[derive(Debug, Clone, Copy)]
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,          // 现状：只有这一项，不知道 frame 的 URL
}

// SchemeHandlerFactory::create
let main_frame = frame.map(|frame| frame.is_main() == 1);

// CefResourceHandler::open
if let Some(is_main) = self.main_frame {
    request.extensions_mut().insert(RequestFrame { is_main });   // 现状：Origin 头原样交给协议 handler
}
```

**b. `cef-ipc` 回退通道的来源判定**（`tauri-runtime-cef/src/ipc.rs`）
```rust
let uri = request
    .headers()
    .get(http::header::ORIGIN)
    .and_then(|value| value.to_str().ok())
    .filter(|value| url::Url::parse(value).is_ok())   // "null" 被过滤
    .unwrap_or(fallback_url)                          // 现状：退回 webview 初始 URL（应用页）→ Tauri 判成 Origin::Local
    .to_string();
```
Tauri 的 `ipc://` 主通道（`tauri/src/ipc/protocol.rs` 的 `parse_invoke_request`）同样读 `Origin`；值是 `null` 时报「Origin header is not a valid URL」，前端随即改走上面的回退通道。

**c. `file:` 文档跳过所有初始化脚本**（`tauri-runtime-cef/src/subprocess.rs`，Phase 4）
```rust
// 开了文件访问的 browser 承载的是外部本地页面（WPE 网页壁纸）：`file:` 文档
// 不注入任何初始化脚本，页面看不到 `__TAURI_INTERNALS__`。
if self.file_document_browsers.borrow().contains(&browser.identifier()) {
    // …
    if crate::file_access::is_file_url(&source_url) || (!is_main_frame && main_is_file()) {
        return;                                        // 现状：Tauri 脚本和用户脚本一概不注入
    }
}
```

**d. 壁纸窗口只有本地来源的 `main-capability`**（`kabegame/capabilities/main.json.handlebars`）
```json
{
  "identifier": "main-capability",
  "local": true,
  "windows": ["wallpaper", "main"],
  "permissions": ["core:default", "…", "main"]
}
```
`main` 权限集包含应用的全部命令（`permissions/main.toml`）。

**e. `wpe_web_host` 只管导航，不对页面说话**（`kabegame/src/wallpaper/wpe_web_host.rs`）
```rust
enum HostMode {
    App,
    File { image_id: String, entry_url: Url },   // 现状：记了当前网页壁纸 id，但没有对外读取入口
}

pub fn start_listener<R: Runtime>(app: AppHandle<R>) {
    // …
    if changes.get("currentWallpaperImageId").is_some() {
        sync(&app).await;                          // 现状：只响应当前壁纸变化
    }
}
```

**f. 两个窗口都没有 all-frames 初始化脚本**
```rust
// kabegame/src/startup.rs：主窗口
WebviewWindowBuilder::new(app_handle, "main", WebviewUrl::App("index.html".into()))
    .title(t!("common.appName"))
    // …                                         // 现状：无 initialization_script*
// kabegame/src/wallpaper/manager/window.rs：壁纸窗口
WebviewWindowBuilder::new(&self.app, WALLPAPER_LABEL, WebviewUrl::App("index.html?window=wallpaper".into()))
    .title(t!("window.wallpaperTitle"))
    // …                                         // 现状：同上
```

**g. 预览 iframe 只负责加载，不与页面通信**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue`）
```ts
async function enterWeb(next: WallpaperTarget, normalizedPath: string) {
  const url = await getWebUrl(next);
  // …
  await createWebFrame(url);          // 现状：创建跨源 sandbox iframe，等 load 后淡入；没有 message 监听
}
function teardownWeb() {
  // …先置 about:blank 再移除 iframe
}
```

**h. 属性模块只解析视频属性**（`kabegame-core/src/wpe/properties.rs`）
```rust
fn properties(raw: &Value) -> Option<&serde_json::Map<String, Value>> {
    raw.get("general")?.get("properties")?.as_object()
}
pub fn resolve_video_props_from_raw(raw: &Value) -> WpeVideoProps { /* … */ }   // 现状：没有网页用的属性输出
```

## 点 1 — 运行时：`file:` frame 的 IPC 来源按 frame URL 判定（`tauri-runtime-cef/src/protocol.rs`、`ipc.rs`）
- **修改**
  - `RequestFrame` 增加 `url`，scheme factory 在 `create` 里读 `frame.url()`。
  - `CefResourceHandler::open`：frame URL 是 `file:` 时，把请求的 `Origin` 头改写成 frame URL，再交给协议 handler。
    > 说明：`ipc://` 主通道（Tauri）与 `cef-ipc` 回退通道都从这里进入，一处改写，两条通道都会判成 `Origin::Remote { url: file:///… }`。
    > 只改写 `file:` frame，其它来源的 `Origin` 头不动。
  - `ipc.rs` 的回退顺序改为「`Origin` 头 → frame URL → webview 初始 URL」。`Origin` 头缺失或为 `null` 且已知 frame 时，不再退回应用页。
```rust
#[derive(Debug, Clone)]                 // 修改：去掉 Copy（含 String）
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,
    /// 新增：发起请求的 frame 当前 URL；`file:` 文档据此改写 `Origin`，IPC 来源判成远程 `file:`。
    pub(crate) url: Option<String>,
}

// SchemeHandlerFactory::create（修改）
let request_frame = frame.map(|frame| RequestFrame {
    is_main: frame.is_main() == 1,
    url: Some(CefString::from(&frame.url()).to_string()).filter(|url| !url.is_empty()),
});

// CefResourceHandler::open（修改）
if let Some(frame) = &self.request_frame {
    pin_file_frame_origin(&mut request, frame);           // 新增
    request.extensions_mut().insert(frame.clone());
}

/// 新增：`file:` 文档的 Origin 是 "null"，Tauri 解析失败后回退通道会退到应用页 URL（Origin::Local）。
/// 统一改写成 frame 自己的 URL，让 ACL 按远程 `file:` 来源匹配 capability。
fn pin_file_frame_origin(request: &mut http::Request<Vec<u8>>, frame: &RequestFrame) {
    let Some(url) = frame.url.as_deref().filter(|url| crate::file_access::is_file_url(url)) else {
        return;
    };
    if let Ok(value) = http::HeaderValue::from_str(url) {
        request.headers_mut().insert(http::header::ORIGIN, value);
    }
}
```
```rust
// ipc.rs post_message_request（修改）
let frame_url = request
    .extensions()
    .get::<RequestFrame>()
    .and_then(|frame| frame.url.clone());
let uri = request
    .headers()
    .get(http::header::ORIGIN)
    .and_then(|value| value.to_str().ok())
    .filter(|value| url::Url::parse(value).is_ok())
    .map(str::to_string)
    .or(frame_url.filter(|url| url::Url::parse(url).is_ok()))   // 新增：先用 frame URL
    .unwrap_or_else(|| fallback_url.to_string());
```
- **新增**（测试）
  - `protocol.rs`：`file:` frame 的 `null` / 缺失 `Origin` 被改写；`http:` frame 的 `Origin` 不变。
  - `ipc.rs`：缺 `Origin`、已知 frame URL 时，uri 取 frame URL 而不是 fallback。

## 点 2 — 运行时：删除「`file:` 文档不注入初始化脚本」（`tauri-runtime-cef/src/subprocess.rs`）
- **删除**
  - `InitializationRenderProcessHandler::file_document_browsers` 字段、`on_browser_created` 里的登记与 `on_browser_destroyed` 里的移除。
  - `on_context_created` 里的整段跳过逻辑（现状锚点 c）；`allows_file_documents` 若因此不再使用一并删除。
    > 说明：文件访问偏好（补丁 0004）与 `file:` 目录拦截不受影响，二者读的是浏览器进程侧的登记，不经过这里。
```rust
fn on_context_created(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, context: Option<&mut V8Context>) {
    // …取 scripts、is_main_frame、source_url
    // 删除：file_document_browsers 判定与 return
    for (index, script) in scripts.iter().enumerate() {
        if script.for_main_frame_only && !is_main_frame {
            continue;                     // 不变：Tauri 自身脚本只进主 frame；垫片（all-frames）进所有 frame
        }
        // …eval
    }
}
```
- **修改**
  - `tauri-runtime-cef/README.md`、`src/lib.rs` 中「`file:` 文档不注入」的描述，改为「照常注入，由 ACL 按远程 `file:` 来源限权」。

## 点 3 — 权限：`wpe-web-capability`（`kabegame/capabilities/`、`permissions/`、`tauri.conf.json.handlebars`）
- **新增** `capabilities/wpe-web.json`
```json
{
  "identifier": "wpe-web-capability",
  "description": "Desktop WPE web wallpaper page (file:// main frame): pull state and listen events only",
  "local": false,
  "windows": ["wallpaper"],
  "remote": { "urls": ["file:///*"] },
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "wpe-web"
  ]
}
```
  > 说明：
  > - `local: false`：应用页回到壁纸窗口时仍只受 `main-capability` 约束。
  > - 不给 `core:default`，页面拿不到窗口、路径、应用信息等核心命令。
  > - `allow-listen` 能订阅全部全局事件，是用户确认过的取舍（见总体设计思路）。
- **新增** `permissions/wpe-web.toml`
```toml
[[permission]]
identifier = "wpe-web"
description = "WPE web wallpaper page (file://) permissions"
commands.allow = ["wpe_web_pull_state"]
```
- **修改** `tauri.conf.json.handlebars`：桌面分支的 `security.capabilities` 追加 `"wpe-web-capability"`，Android 分支不加。
- **新增**（测试，`kabegame/src/commands/wpe_web.rs`）：`tauri::utils::acl::RemoteUrlPattern::from_str("file:///*")` 能匹配
  `file:///D:/x/y/index.html`，不匹配 `http://127.0.0.1/`。
  > 说明：`urlpattern` 对 `file:` 的匹配未实测；不匹配时改用 `file://*`，并在本点记录实际可用的写法。

## 点 4 — core：网页属性与语言码（`kabegame-core/src/wpe/properties.rs`）
- **新增**
```rust
/// 网页壁纸推给页面的用户属性：`general.properties` 中带 `value` 的条目，形如 `{ key: { type, value } }`。
/// 没有 `value` 的纯展示条目（分组、说明行）不推。作者默认值层；Phase 7 的用户值在调用方叠加。
pub fn resolve_web_user_props(raw: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(props) = properties(raw) else { return out };
    for (key, prop) in props {
        let Some(value) = prop.get("value") else { continue };
        let mut entry = serde_json::Map::new();
        if let Some(kind) = prop.get("type") {
            entry.insert("type".into(), kind.clone());
        }
        entry.insert("value".into(), value.clone());
        out.insert(key.clone(), Value::Object(entry));
    }
    out
}

/// Kabegame 界面语言（`Settings::get_resolved_language`）→ WPE 语言码（webwallpaper64 码表，连字符形式）。
pub fn wpe_language_code(locale: &str) -> &'static str {
    match locale {
        "zh" => "zh-chs",
        "zhtw" => "zh-cht",
        "ja" => "ja-jp",
        "ko" => "ko-kr",
        _ => "en-us",
    }
}
```
- **新增**（测试）：kaguya 的 `project.json` 片段 → 带 `value` 的键全部输出、`type` 保留、无 `value` 的条目被跳过；五种语言的映射。

## 点 5 — 应用：状态构建与两条命令（新增 `kabegame/src/commands/wpe_web.rs`；修改 `lib.rs`、`permissions/main.toml`）
- **新增**
```rust
/// 推给网页壁纸的完整状态。垫片按 `rev` 丢弃旧状态，按 `imageId` 丢弃别的壁纸的状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebState {
    pub image_id: String,
    pub rev: u64,
    pub user: serde_json::Map<String, serde_json::Value>,
    pub general: WpeWebGeneral,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebGeneral {
    pub language: &'static str,
}

static REV: AtomicU64 = AtomicU64::new(0);

/// 按 id 组装状态；行不存在或不是 `x-wpe/web` 返回 None。metadata 读取放 blocking 线程。
pub async fn build_wpe_web_state(image_id: &str) -> Result<Option<WpeWebState>, String> { /* … */ }

/// 预览桥（主窗口应用页，main-capability）。
#[tauri::command]
pub async fn get_wpe_web_state(image_id: String) -> Result<Option<WpeWebState>, String> {
    build_wpe_web_state(&image_id).await
}

/// 桌面网页壁纸页面（wpe-web-capability）。不接收 id：只返回 `wpe_web_host` 当前导航到的那张，
/// 页面拿不到别的图片的 metadata。
#[tauri::command]
pub async fn wpe_web_pull_state<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<WpeWebState, String> {
    if webview.label() != WALLPAPER_LABEL {
        return Err("wpe_web_pull_state: not the wallpaper window".into());
    }
    let image_id = wpe_web_host::current_image_id().ok_or("no web wallpaper")?;
    build_wpe_web_state(&image_id).await?.ok_or_else(|| "web wallpaper row missing".into())
}
```
- **修改**
  - `lib.rs`：注册 `get_wpe_web_state`、`wpe_web_pull_state`。
  - `permissions/main.toml`：加 `get_wpe_web_state`（`wpe_web_pull_state` 只在 `wpe-web` 权限集里）。

## 点 6 — `wpe_web_host`：对外读当前壁纸，语言变化时推送（`kabegame/src/wallpaper/wpe_web_host.rs`）
- **新增**
```rust
/// 垫片注入脚本（壁纸窗口与主窗口共用，all-frames）。
pub const WPE_SHIM_JS: &str = include_str!("../webview_js/wpe_shim.js");
/// 桌面推送事件名：载荷是完整的 `WpeWebState`。
pub const WPE_WEB_STATE_EVENT: &str = "wpe-web-state";

/// 当前导航到的网页壁纸 id（App 模式为 None）。
pub fn current_image_id() -> Option<String> {
    match &lock_state().mode {
        HostMode::File { image_id, .. } => Some(image_id.clone()),
        HostMode::App => None,
    }
}

/// 当前网页壁纸的状态有变化：重建并发给壁纸窗口。
async fn push_state<R: Runtime>(app: &AppHandle<R>) {
    let Some(image_id) = current_image_id() else { return };
    match crate::commands::wpe_web::build_wpe_web_state(&image_id).await {
        Ok(Some(state)) => {
            let _ = app.emit_to(EventTarget::webview_window(WALLPAPER_LABEL), WPE_WEB_STATE_EVENT, state);
        }
        Ok(None) => {}
        Err(error) => eprintln!("[wpe-web-host] 组装网页壁纸状态失败: {error}"),
    }
}
```
- **修改**
```rust
pub fn start_listener<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut rx = EventBroadcaster::global().subscribe_filtered_stream(&[AppEventKind::SettingChange]);
        while let Some((_, event)) = rx.recv().await {
            if let AppEvent::SettingChange { changes } = &*event {
                if changes.get("currentWallpaperImageId").is_some() {
                    sync(&app).await;
                }
                if changes.get("language").is_some() {
                    push_state(&app).await;            // 新增：界面语言变化 → applyGeneralProperties
                }
            }
        }
    });
}
```
  - `STATE.lock()` 的中毒处理抽成 `lock_state()`，`sync` / `reset` / `current_image_id` 共用。
  - 模块文档补一段：页面经 `wpe_web_pull_state` 拉取、经 `wpe-web-state` 接收推送。

## 点 7 — 垫片 `wpe_shim.js` 与注入（新增 `kabegame/src/webview_js/wpe_shim.js`；修改 `startup.rs`、`wallpaper/manager/window.rs`）
- **新增** `webview_js/wpe_shim.js`
```js
// WPE 网页壁纸运行时垫片：all-frames 初始化脚本，桌面壁纸窗口与主窗口共用。
// 只在两种文档里启用：桌面壁纸窗口的 file:// 主 frame；预览里主窗口的 /wpe/<id>/ 直接子 iframe。
(function () {
  "use strict";
  var isTop = window === window.top;
  var desktop = isTop && location.protocol === "file:";
  var preview =
    !isTop &&
    window.parent === window.top &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
    /^\/wpe\/[^/]+\//.test(location.pathname);
  if ((!desktop && !preview) || window.__kbWpeShim) return;
  Object.defineProperty(window, "__kbWpeShim", { value: true });

  // ---- WPE 全局接口（API.md §3.2 / §3.4）----
  window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
  var registered = {};
  [
    "wallpaperRegisterAudioListener",
    "wallpaperRegisterMediaStatusListener",
    "wallpaperRegisterMediaPropertiesListener",
    "wallpaperRegisterMediaThumbnailListener",
    "wallpaperRegisterMediaPlaybackListener",
    "wallpaperRegisterMediaTimelineListener",
  ].forEach(function (name) {
    registered[name] = [];
    // 可多次注册、全部保留；Phase 8 起才有数据回调
    window[name] = function (cb) {
      if (typeof cb === "function") registered[name].push(cb);
    };
  });
  window.wallpaperRequestRandomFileForProperty = function () {}; // file / directory 属性暂不支持
  window.wallpaperGetUtilities = function () {
    return {};
  };

  // ---- 投递：load 后首次全量；之后按差异；首次之后换 listener 补投全量 ----
  var listener;
  var latest = null; // 收到的最新状态
  var delivered = null; // 上次投递给页面的状态
  var loaded = false;
  Object.defineProperty(window, "wallpaperPropertyListener", {
    configurable: true,
    enumerable: true,
    get: function () {
      return listener;
    },
    set: function (value) {
      listener = value;
      if (delivered) {
        queueMicrotask(function () {
          if (listener === value) deliverFull(delivered);
        });
      }
    },
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function call(name, arg) {
    var target = listener;
    if (target && typeof target[name] === "function") {
      try {
        target[name](arg);
      } catch (error) {
        console.error("[kb-wpe] " + name, error);
      }
    }
  }
  function deliverFull(state) {
    call("applyUserProperties", clone(state.user));
    call("applyGeneralProperties", clone(state.general));
    delivered = state;
  }
  function changedUser(prev, next) {
    var out = null;
    Object.keys(next).forEach(function (key) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        (out || (out = {}))[key] = clone(next[key]);
      }
    });
    return out;
  }
  function receive(next) {
    if (!next || typeof next.rev !== "number") return;
    if (latest && (next.imageId !== latest.imageId || next.rev <= latest.rev)) return;
    latest = next;
    if (!loaded) return;
    if (!delivered) return deliverFull(next);
    var changed = changedUser(delivered.user, next.user);
    if (changed) call("applyUserProperties", changed);
    if (JSON.stringify(delivered.general) !== JSON.stringify(next.general)) {
      call("applyGeneralProperties", clone(next.general));
    }
    delivered = next;
  }
  window.addEventListener("load", function () {
    loaded = true;
    if (latest && !delivered) deliverFull(latest);
  });

  // ---- 传输 ----
  if (desktop) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals) return;
    internals.invoke("plugin:event|listen", {
      event: "wpe-web-state",
      target: { kind: "Any" },
      handler: internals.transformCallback(function (event) {
        receive(event.payload);
      }),
    });
    internals.invoke("wpe_web_pull_state").then(receive, function (error) {
      console.warn("[kb-wpe] pull", error);
    });
  } else {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (event.source !== window.parent || !data || data.kbWpe !== 1) return;
      if (data.type === "state") receive(data.state);
    });
    window.parent.postMessage({ kbWpe: 1, type: "pull" }, "*");
  }
})();
```
  > 说明：
  > - 先 `listen` 再 `pull`：两者之间发生的推送不会漏，交错到达靠 `rev` 去重。
  > - 首次全量里先 `applyUserProperties` 再 `applyGeneralProperties`，WPE 的实际顺序未确认。
  > - 页面自己的嵌套 iframe 不启用：预览里它们的父窗口不是 top，桌面里它们不是 top。
  > - 预览发 `pull` 用 `"*"`：消息不含任何数据，父页面按 `event.source` 认 iframe。
- **修改**
  - `wallpaper/manager/window.rs`：壁纸窗口 builder 加 `.initialization_script_for_all_frames(wpe_web_host::WPE_SHIM_JS)`。
  - `startup.rs`：主窗口 builder 同样加（`#[cfg(not(target_os = "android"))]`）。
    > 说明：垫片在应用页和其它 iframe 里第一行就返回，不定义任何全局。

## 点 8 — 预览桥（新增 `apps/kabegame/src/components/wallpaper/wpeWebBridge.ts`；修改 `WallpaperStage.vue`）
- **新增**
```ts
import { watch } from "vue";
import { i18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";

/** 后端 `WpeWebState`：推给网页壁纸页面的完整状态。 */
export interface WpeWebState {
  imageId: string;
  rev: number;
  user: Record<string, { type?: string; value: unknown }>;
  general: { language: string };
}

/**
 * 预览 iframe 与网页壁纸垫片之间的中转：iframe 发 `pull` → 用主窗口权限取状态 → postMessage 回去；
 * 界面语言变化时主动重发。外部页面不接触 IPC。
 */
export function attachWpeWebBridge(frame: HTMLIFrameElement, frameUrl: string, imageId: string) {
  const origin = new URL(frameUrl, location.href).origin;
  let disposed = false;
  let pulled = false;

  async function send() {
    const state = await invoke<WpeWebState | null>("get_wpe_web_state", { imageId });
    if (disposed || !state || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ kbWpe: 1, type: "state", state }, origin);
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== frame.contentWindow || event.data?.kbWpe !== 1) return;
    if (event.data.type === "pull") {
      pulled = true;
      void send();
    }
  }
  window.addEventListener("message", onMessage);
  const stopLocale = watch(
    () => String(i18n.global.locale),
    () => {
      if (pulled) void send();
    },
  );

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      stopLocale();
    },
  };
}
```
  > 说明：`i18n.global.locale` 是否为 ref 以实测为准（现有代码用 `unref(i18n.global.locale)` 读取）。是 ref 时直接 `watch` 它。
- **修改** `WallpaperStage.vue`
```ts
let webBridge: { dispose(): void } | null = null;      // 新增

async function enterWeb(next: WallpaperTarget, normalizedPath: string) {
  const url = await getWebUrl(next);
  // …
  await createWebFrame(url, next.id);                  // 修改：带上图片 id
}

function createWebFrame(url: string, imageId: string): Promise<void> {
  // …创建 frame（不变）
  webBridge = attachWpeWebBridge(frame, url, imageId); // 新增：插入 DOM、设 src 之前挂上
  layer.appendChild(frame);
  frame.src = url;
  // …
}

function teardownWeb() {
  webBridge?.dispose();                                // 新增
  webBridge = null;
  // …原有销毁逻辑
}
```

## 点 9 — 文档与回归
- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：
    - 「初始化脚本隔离」改为「照常注入 + 远程 `file:` 来源 + `wpe-web-capability`」，删掉「`cef-ipc` 入口本来也拒绝」这句错误描述；
    - 新增「运行时垫片与宿主协议」一节：两种传输、投递语义、`rev`、接受的全局事件可见性。
  - `cocs/README.md`：WPE 条目补垫片与协议；适用场景里「页面里出现 `__TAURI_INTERNALS__`」改为「页面调用应用命令被 ACL 拒绝 / 收不到属性」。
  - `AGENTS.md`：WPE 那条里的「`file:` 文档不注入初始化脚本」改为「`file:` 文档照常注入 Tauri 脚本，IPC 按远程 `file:` 来源只给 `wpe-web-capability`」。
  - `src-tauri/tauri-runtime-cef/README.md`：协议层 `Origin` 改写与删除注入跳过。
  - `API.md` §8 落地表与 `PLAN.md` Phase 5 段：标记已完成。
  - `versions/latest/regression.md`：
    - Phase 4 的「初始化脚本隔离」行改成新的期望（`__TAURI_INTERNALS__` 存在，应用命令被拒）；
    - 新增本 Phase 各行（见下）。
  - `versions/latest/changelog.md`：一行「网页壁纸可读取作者默认属性与界面语言」。

## 验收清单（Windows 11 dev，用 `kabegame-chromium`；Rust 改动后 dev 自行重建，不轮询）
- 单测：点 1 的 `Origin` 改写与回退顺序；点 3 的 `file:///*` 模式匹配；点 4 的属性与语言码。
- 桌面 kaguya（壁纸窗口 `file://`）：
  - `typeof __TAURI_INTERNALS__ === "object"`；
  - 页面控制台 `__TAURI_INTERNALS__.invoke("get_image_by_id", { imageId: "1" })` 被 ACL 拒绝，且错误里是远程 `file:` 来源；
  - `invoke("wpe_web_pull_state")` 返回 kaguya 的状态；
  - 用 debug ingest 插桩记录 `applyUserProperties` 的调用：`load` 之后恰好一次，键与 `project.json` 中带 `value` 的条目一致；
  - 切换界面语言 → `applyGeneralProperties({ language })` 收到新码，`applyUserProperties` 不再调用。
- 桌面安全：
  - `fetch("ipc://localhost/get_image_by_id")` 绕过 `invoke` 直接请求同样被拒；
  - 嵌套 iframe 里没有 `__TAURI_INTERNALS__`；
  - 回到图片壁纸后，应用页照常（`main-capability` 生效）。
- 预览 12099：
  - iframe 内 `window.__kbWpeShim === true`，主窗口应用页里 `__kbWpeShim` 为 `undefined`；
  - `applyUserProperties` 在 iframe `load` 后被调用一次；
  - 切语言后 iframe 收到新的 general。
- 换 listener：首次投递后在页面控制台执行 `window.wallpaperPropertyListener = { applyUserProperties: console.log }`，下一个微任务打印全量属性。

## 风险与回退
- **all-frames 脚本能否进跨源 iframe 的渲染进程**（站点隔离，未实测）。CEF 应把 `extra_info` 发给承载该 browser 任一 frame 的渲染进程，但需要真机确认。
  不成立时，预览改为在 `serve_wpe_html` 里给 HTML 插 `<script src="/wpe-shim.js">`，同一份 `wpe_shim.js` 经 HTTP 路由提供。桌面不受影响。
- **`file:` 请求的 `Origin` 头实际值**（`null`，或者 `file://`）不影响点 1：改写只看 frame URL。用 debug ingest 记录一次，写进 API.md。
- **`urlpattern` 对 `file:` 的匹配**：见点 3 测试。实在不支持时改用运行时 `app.add_capability`，按当前壁纸入口的精确 URL 生成 capability。

## 不做 / 留到后续
- Phase 6：`paused` 进状态，垫片实现冻结（参照 API.md §4.4）与 `setPaused`；`fps` 设置与推送。
- Phase 7：用户属性叠加在作者默认值之上；`image-changed { metadataId }` 触发 `push_state` 与预览重拉；`file` / `directory` 属性。
- Phase 8：注册函数开始收到数据。数据回程沿用本 Phase 的通道：桌面走事件，预览走父页面 `postMessage`。
