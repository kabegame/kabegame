# Phase 5 — 运行时垫片与宿主协议

> 状态：方案（2026-10-27）；已实施（2026-10-28），真机回归待做。实施偏差见文末「实施记录」。
>
> 2026-10-28 第一次修订：Phase 4 的 `wpe_web_host`（全局 `STATE` + 监听 `setting-change`）已删除，导航收回
> `WindowWallpaperManager::set_wallpaper_path`，网页壁纸状态随 `WallpaperWindow` 对象走。本方案随之去掉对它的依赖：
> 桌面拉取按调用方 label 找 manager 里的 `WallpaperWindow` 取当前网页目录（点 6）。
>
> 2026-10-28 第二次修订（用户指定）：
> - 两种宿主的传输统一成两个原语：`pull` 和 `listen`。
>   - 壁纸窗口：直接 `invoke`、直接 `listen`。
>   - 预览 iframe：`pull` 和 `listen` 都 `postMessage` 给宿主页代办。宿主用 `useTauriProxy()` 代为 listen，登记过的事件经 `kbEvent$` 合并成一条管道转发给 iframe。
>   - 宿主不再主动推送。
> - 更新的触发：
>   - 界面语言变化，来自 `setting-change`；
>   - 属性变化，来自图片 metadata 改变。metadata 按 id 不可变，改了就换 `metadataId`。垫片订阅 `metadataId` 补丁后手动重拉。
> - 重拉后用户属性仍按键做差异，只推值变化的键。WPE 页面没有「整份替换」的接口。
> - 去掉 Rust 侧的 `rev`，乱序由垫片自己的拉取序号丢弃。
> - 新增点 7：Tauri 在导航后不清理旧文档注册的 JS 事件监听，壁纸窗口导航时要手动清掉。
>
> 范围：
> - WPE 全局接口垫片 `wpe_shim.js`，以 all-frames 初始化脚本注入；
> - 桌面壁纸窗口 `file://` 页面放开 Tauri IPC，但只给一组受限权限；
> - 运行时修正 `file:` frame 的 IPC 来源判定；
> - 作者默认值（`applyUserProperties`）与界面语言（`applyGeneralProperties`）的拉取与更新投递；
> - 预览 iframe 经宿主页代办拉取与监听。
>
> **不做**：
> - 暂停冻结与 `setPaused`、FPS（Phase 6）；
> - 用户改属性的存储与面板（Phase 7）。Phase 7 保存时写新 metadata 行并发 `metadataId` 补丁，本 Phase 的垫片已订阅并重拉；
> - `file` / `directory` 属性与 `wallpaperRequestRandomFileForProperty`（Phase 7 再定）；
> - 音频与媒体数据（Phase 8，注册函数先收下回调、不回调）；
> - zcompat 兼容补丁（本机没有受影响的壁纸）；
> - Web 发布版（没有初始化脚本能力，预览仍是无属性状态）。

## 总体设计思路

WPE 网页壁纸要靠宿主提供的一组全局接口才能完成初始化。最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：宿主把作者默认值推给它之后，多数壁纸才开始画。Phase 5 用一份 JS 垫片 `wpe_shim.js` 在壁纸页面里定义这组接口，并负责把属性投递给页面。

我们不照搬 WPE 的做法（宿主拼 JS 字符串，加载完成前在宿主侧排队，见 [API.md §4.8](API.md)），改成由垫片驱动：
- 垫片向宿主**拉取**一份完整状态；
- 垫片**订阅**应用事件，看到相关变化就重拉；
- 宿主只回答「当前完整状态」和「转发事件」，不推状态、不排队，也不记录页面收到过什么；
- 什么时候回调页面、回调哪些键，全部由垫片决定。

**传输只有两个原语**，两种宿主各实现一份：
- `pull()` 返回当前完整状态；
- `listen(names, onEvent)` 把若干应用事件合并到同一个 `onEvent({ name, payload })`。

垫片在它们之上实现相同的投递逻辑：

| | `pull` | `listen` |
|---|---|---|
| 桌面壁纸窗口（主 frame 是 `file://` 入口） | `invoke("wpe_web_pull_state")`。命令不接收 id：按调用方 webview 的 label 找到 manager 里的 `WallpaperWindow`，取它当前的网页目录，再用 `Storage::find_image_by_path` 找到那一行 | 直接 `plugin:event|listen` |
| 图库预览（主窗口里的跨源 HTTP iframe，碰不到 IPC） | `postMessage({ type: "pull", id })` 给宿主页。宿主页用主窗口权限调 `get_wpe_web_state(imageId)`，回 `{ type: "state", id, state }` | `postMessage({ type: "listen", events })` 登记。宿主页的 `useTauriProxy()` 代为 listen：同名只订阅一次，所有登记过的事件经 `kbEvent$` 合并成一条管道，逐条回 `{ type: "event", name, payload }` |

**什么时候重拉**：
- `setting-change` 带 `language`：界面语言变了。
- `image-changed` / `images-change` 里有本张图片的 `metadataId` 补丁：属性变了。图片 metadata 按 id 不可变，Phase 7 的设置面板保存时会写一行新 metadata，让图片改指它。

垫片先订阅再拉取。之后每次重拉都拿到完整状态，与上次投递的状态比较后再回调页面。

**投递语义**（我们自己的规则，不跟 WPE）：
- **首次投递**：在 `window` 的 `load` 事件之后，用户属性和通用属性各推一份完整的。为 WPE 写的页面默认回调时 DOM 已就绪，WPE 自己也晚于 `load` 投递。`load` 之前的赋值只记下来，不提前回调。
- **之后的投递**：
  - 用户属性只推值变化的键。WPE 的 `applyUserProperties` 本来就是「只含变化的键」（API.md §3.1），页面没有接收整份替换的接口。作者删掉的键不推，页面没有撤销接口。
  - 通用属性有变化就推一整份，与 WPE 的命令 7 一致。
- **换 listener**：首次投递之后，页面若给 `wallpaperPropertyListener` 换了新对象，垫片在下一个微任务把当前完整状态补投给它。这依靠在 `window` 上安装这个属性的访问器，页面无论写成 `window.x = …` 还是顶层 `var x = …` 都会走到 setter。
- **乱序**：多次拉取可能乱序返回。垫片给每次拉取编号，某次结果落地后丢弃编号更早、返回更晚的结果，做法同 pathql 的 pending 窗口。Rust 不维护版本号。

**状态只在 Rust 侧计算，只有一份来源**：
- 用户属性取自图片 metadata（导入时存的 `project.json` 原文）里 `general.properties` 中带 `value` 的条目；
- 通用属性第一版只有 `language`，用 WPE 码表的连字符形式（`zh-chs` 等，见 API.md §3.1）；
- `fps` 等 Phase 6 有了设置再推。推 0 会让按 `1000 / fps` 算间隔的页面停住。

**桌面放开 IPC 的前提**是：`file://` 页面的请求被 Tauri 判成远程来源 `file:///…`，只有专门的 `wpe-web-capability` 对它生效。这个前提**目前不成立**：
- `file://` 文档的 `Origin` 请求头是 `null`。Tauri 的 `ipc://` 主通道解析失败后，前端脚本会自动改走 `cef-ipc` 回退通道。
- 运行时在回退通道里拿不到合法 `Origin` 时，退回用 webview 的初始 URL，也就是应用页。于是请求被当成 `Origin::Local`，拿到 `main-capability` 的全部命令。
- Phase 4 文档里「`cef-ipc` 入口本来也拒绝」的说法不成立。Phase 4 只是没注入 invoke key，这个缺口才没暴露出来。

所以：
- 第一步在运行时的协议层统一修正：请求来自 `file:` frame 时，把 `Origin` 改写成该 frame 的真实 URL。两条 IPC 通道都经过协议层，一处修好。
- 然后删掉 Phase 4「`file:` 文档不注入任何初始化脚本」的规则，安全边界改由 ACL 承担：
  - Tauri 自身的脚本都只进主 frame，子 frame 拿不到 invoke key；
  - 垫片自己按地址判断是否启用。

**导航不会清理 JS 事件监听**（点 7）：
- Tauri 按 webview label 记录 JS 注册的监听，只在 webview 销毁时清理（现状锚点 j）。
- 壁纸窗口在应用页和 `file://` 入口之间反复导航，旧文档注册的监听会一直留在 Rust 侧。之后每个这类事件仍在当前文档里 eval 一段投递脚本：
  - 网页、图片轮换多少次，就积累多少组；
  - 垫片订阅的 `image-changed` / `images-change` 在下载时很频繁；
  - 现在 Phase 4 的 `file://` 页面就会收到应用页留下的 `setting-change` 投递脚本。页面只要自己定义 `window.__internal_unstable_listeners_function_id__`，就能读到这些设置变化。
- 处理方式：加一个 Tauri 补丁提供 `clear_js_listeners()`，`WallpaperWindow` 每次导航成功后清掉。

**接受的取舍**：
- `core:event:allow-listen` 没有按事件名的作用域，壁纸页面因此能订阅应用的全部全局事件。
- 预览的宿主代办同样不限事件名，与桌面一致。
- 用户确认这是可接受的取舍，也算开放给壁纸的一项能力。命令层仍然只开一个拉取命令。

## 现状锚点

**a. 协议层只记 frame 是否为主 frame**（`tauri-runtime-kbcef/src/protocol.rs`）
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

**b. `cef-ipc` 回退通道的来源判定**（`tauri-runtime-kbcef/src/ipc.rs`）
```rust
let uri = request
    .headers()
    .get(http::header::ORIGIN)
    .and_then(|value| value.to_str().ok())
    .filter(|value| url::Url::parse(value).is_ok())   // "null" 被过滤
    .unwrap_or(fallback_url)                          // 现状：退回 webview 初始 URL（应用页）→ Tauri 判成 Origin::Local
    .to_string();
```
Tauri 的 `ipc://` 主通道（`tauri/src/ipc/protocol.rs` 的 `parse_invoke_request`）同样读 `Origin`。值是 `null` 时报「Origin header is not a valid URL」，前端随即改走上面的回退通道。

**c. `file:` 文档跳过所有初始化脚本**（`tauri-runtime-kbcef/src/subprocess.rs`，Phase 4）
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

**e. 网页壁纸状态只在 `WallpaperWindow` 里，没有对外读取入口**（`kabegame/src/wallpaper/window.rs`，2026-10-28 起）
```rust
struct WebPage {
    dir: PathBuf,                    // 壁纸目录（= images.local_path 的规范形式）
    entry: Url,
}
pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
    app_url: Option<Url>,
    web: Option<WebPage>,            // 现状：None = 应用页；没有 getter
    // …Windows：hwnd、forwarder
}
// manager/window.rs：WindowWallpaperManager { wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>, … }
// WallpaperController 只以 Arc<dyn WallpaperManager> 持有它，命令侧拿不到具体类型。
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

**i. 前端后端事件的唯一入口**（`apps/kabegame/src/services/kbEvents/eventSource.ts`）
```ts
/**
 * 后端事件的唯一入口（Tauri 事件或 Web SSE，由 `listen` 分流）。
 * 同名事件只注册一次监听、所有订阅者共享，最后一个订阅者退订后释放；核心不解析事件内容。
 */
export function kbEvent$<T = unknown>(name: string): Observable<KbEvent<T>> { /* …share() */ }
// 现状：宿主页没有替别的页面代办 listen 的封装
```

**j. Tauri 的 JS 监听按 label 记录，只在销毁 webview 时清理**（`third/tauri/crates/tauri/src/event/listener.rs`、`event/mod.rs`）
```rust
// listen_js：label → 事件名 → { (target, id) }
listeners.entry(source_webview_label.to_string()).or_default().entry(event).or_default().insert(JsHandler::new(target, id));

/// Removes all JS event listeners registered from the given webview.
fn remove_webview_js_listeners(&self, webview_label: &str) { /* … */ }   // 现状：私有，只被下面调用
/// Removes all event listeners associated with a destroyed webview.
pub(crate) fn remove_webview_listeners(&self, label: &str) { self.remove_webview_js_listeners(label); /* … */ }

// 投递：向该 webview 当前文档 eval，函数名是固定的（不随机）
"(function () {{ const fn = window['{}']; fn && fn({{event: '{}', payload: {}}}, {ids}) }})()"
// function_name = "__internal_unstable_listeners_function_id__"
```
现状：壁纸窗口导航到 `file://` 后，应用页（`WallpaperWindow.vue`）注册的 `setting-change` 监听仍在，每次设置变化都会向网页壁纸文档 eval 上面这段脚本。

**k. 属性变化的事件形态**（`AGENTS.md` 图片事件协议、`apps/kabegame/src/types/image.ts`）
```ts
// 字段变化按 id 合并成补丁：一张发 image-changed { seq, patch }，多张发 images-change { seq, patches }
export type ImageFieldPatch = { id: string } & Partial<ImageInfo>;   // ImageInfo.metadataId?: number
// setting-change 的 payload：{ changes: { <key>: <value> } }（emit_setting_change 构造），language 变化即 changes.language
```

## 点 1 — 运行时：`file:` frame 的 IPC 来源按 frame URL 判定（`tauri-runtime-kbcef/src/protocol.rs`、`ipc.rs`）
- **修改**
  - `RequestFrame` 增加 `url`，scheme factory 在 `create` 里读 `frame.url()`。
  - `CefResourceHandler::open`：frame URL 是 `file:` 时，把请求的 `Origin` 头改写成 frame URL，再交给协议 handler。
    > 说明：`ipc://` 主通道（Tauri）与 `cef-ipc` 回退通道都从这里进入，一处改写后两条通道都会判成 `Origin::Remote { url: file:///… }`。
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

## 点 2 — 运行时：删除「`file:` 文档不注入初始化脚本」（`tauri-runtime-kbcef/src/subprocess.rs`）
- **删除**
  - `InitializationRenderProcessHandler::file_document_browsers` 字段、`on_browser_created` 里的登记与 `on_browser_destroyed` 里的移除。
  - `on_context_created` 里的整段跳过逻辑（现状锚点 c）；`allows_file_documents` 若因此不再使用，一并删除。
    > 说明：文件访问偏好（补丁 04）与 `file:` 目录拦截不受影响，二者读的是浏览器进程侧的登记，不经过这里。
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
  - `tauri-runtime-kbcef/README.md`、`src/lib.rs` 中「`file:` 文档不注入」的描述，改为「照常注入，由 ACL 按远程 `file:` 来源限权」。

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
  > - 不给 `core:default`：页面拿不到窗口、路径、应用信息等核心命令。
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
  > 说明：`urlpattern` 对 `file:` 的匹配未实测。不匹配时改用 `file://*`，并在本点记录实际可用的写法。

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
- **新增**（测试）：
  - kaguya 的 `project.json` 片段：带 `value` 的键全部输出、`type` 保留、无 `value` 的条目被跳过；
  - 五种语言的映射。

## 点 5 — 应用：状态构建与两条命令（新增 `kabegame/src/commands/wpe_web.rs`；修改 `lib.rs`、`permissions/main.toml`）
- **新增**
```rust
/// 网页壁纸页面拉取的完整状态。乱序由垫片按自己的拉取序号丢弃，这里不带版本号。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebState {
    /// 垫片按它过滤 `metadataId` 补丁（只认本张）。
    pub image_id: String,
    pub user: serde_json::Map<String, serde_json::Value>,
    pub general: WpeWebGeneral,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebGeneral {
    pub language: &'static str,
}

/// 按 id 组装状态，每次都读图片当前的 metadata；行不存在或不是 `x-wpe/web` 返回 None。metadata 读取放 blocking 线程。
pub async fn build_wpe_web_state(image_id: &str) -> Result<Option<WpeWebState>, String> { /* … */ }

/// 预览宿主页（主窗口应用页，main-capability）替 iframe 拉取。
#[tauri::command]
pub async fn get_wpe_web_state(image_id: String) -> Result<Option<WpeWebState>, String> {
    build_wpe_web_state(&image_id).await
}

/// 桌面网页壁纸页面（wpe-web-capability）。不接收 id：按调用方窗口找到 manager 里的 `WallpaperWindow`，
/// 只返回它当前显示的那张，页面拿不到别的图片的 metadata。
#[tauri::command]
pub async fn wpe_web_pull_state<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<WpeWebState, String> {
    // 只有窗口模式的壁纸窗口会返回 Some：别的 label、应用页、非窗口模式都是 None。
    let dir = WallpaperController::global()
        .manager_for_mode("window")
        .web_wallpaper_dir(webview.label())
        .ok_or("no web wallpaper")?;
    // dir 来自 read_project 的规范化目录，与入库时的 local_path 同形。
    let image = Storage::find_image_by_path(&dir.to_string_lossy())?
        .ok_or("web wallpaper row missing")?;
    build_wpe_web_state(&image.id).await?.ok_or_else(|| "web wallpaper row missing".into())
}

/// 垫片注入脚本（壁纸窗口与主窗口共用，all-frames）。
pub const WPE_SHIM_JS: &str = include_str!("../webview_js/wpe_shim.js");
```
- **修改**
  - `lib.rs`：注册 `get_wpe_web_state`、`wpe_web_pull_state`。
  - `permissions/main.toml`：加 `get_wpe_web_state`。`wpe_web_pull_state` 只放在 `wpe-web` 权限集里。

## 点 6 — 窗口 manager：按 label 读当前网页目录（`kabegame/src/wallpaper/window.rs`、`manager/window.rs`、`manager/mod.rs`）
- **新增**
```rust
// wallpaper/window.rs
impl<R: Runtime> WallpaperWindow<R> {
    pub fn label(&self) -> &str {                        // 新增
        self.window.label()
    }
    /// 当前显示的网页壁纸目录；停在应用页时为 None。
    pub fn web_dir(&self) -> Option<&Path> {             // 新增
        self.web.as_ref().map(|web| web.dir.as_path())
    }
}

// manager/mod.rs：WallpaperManager trait
/// `label` 窗口当前显示的网页壁纸目录。只有窗口模式实现，其它后端恒为 None。
fn web_wallpaper_dir(&self, _label: &str) -> Option<PathBuf> {   // 新增：默认实现
    None
}

// manager/window.rs：WindowWallpaperManager
fn web_wallpaper_dir(&self, label: &str) -> Option<PathBuf> {    // 新增
    let guard = self.wallpaper_window.lock().ok()?;
    let wp = guard.as_ref().filter(|wp| wp.label() == label)?;  // 以后多显示器：在窗口列表里按 label 找
    wp.web_dir().map(Path::to_path_buf)
}
```
- **说明**
  - 状态只有 `WallpaperWindow` 一处属主：命令按 label 读它，Rust 不另记「当前网页壁纸 id」，也不推状态。
    多显示器时，每块屏的窗口各自回答自己的目录。
  - 锁内只读字段，不调会同步等主线程的窗口 getter。`label()` 是本地字段，不等主线程，与 Phase 4 收回后的锁约定一致。

## 点 7 — 导航后清掉旧文档的 JS 事件监听（新增 `third-patches/tauri/11-tauri-webview-clear-js-listeners.patch`；修改 `wallpaper/window.rs`）
- **新增**（Tauri 补丁，`crates/tauri`）
```rust
// crates/tauri/src/event/listener.rs
/// Removes all JS event listeners registered from the given webview.
pub(crate) fn remove_webview_js_listeners(&self, webview_label: &str) {   // 修改：fn → pub(crate)
    // …不变
}

// crates/tauri/src/webview/mod.rs
impl<R: Runtime> Webview<R> {
    /// 新增：丢弃本 webview 里由 JS 注册的全部事件监听（Rust 侧 `listen` 不受影响）。
    /// 导航到新文档后旧文档的监听不会自动移除，之后的事件仍会向新文档 eval 投递脚本；
    /// 嵌入方在确认换了文档时调用。
    pub fn clear_js_listeners(&self) {
        self.manager().listeners().remove_webview_js_listeners(self.label());
    }
}

// crates/tauri/src/webview/webview_window.rs
impl<R: Runtime> WebviewWindow<R> {
    /// 新增：见 [`Webview::clear_js_listeners`]。
    pub fn clear_js_listeners(&self) {
        self.webview.clear_js_listeners()
    }
}
```
- **修改**（`wallpaper/window.rs`）
```rust
pub fn show_web(&mut self, dir: PathBuf, entry: Url) -> Result<(), String> {
    // …同入口返回、校验 app_url、设根目录
    if let Err(error) = self.window.navigate(entry.clone()) {
        // …恢复根目录、返回 Err（不变：页面没换，监听保留）
    }
    // 新增：旧文档（应用页或上一张网页壁纸）注册的监听随它作废。
    // 新文档要先加载、执行脚本才会 listen，晚于这里。
    self.window.clear_js_listeners();
    // …记 web、启动转发（不变）
}

pub fn show_app(&mut self) {
    // …取走 web、停转发、清根目录
    if let Err(error) = self.window.navigate(app_url.clone()) {
        // …记日志、返回（不变）
    }
    self.window.clear_js_listeners();   // 新增：同上，清掉网页壁纸垫片的监听
    // …
}
```
  > 说明：
  > - 放在 `navigate` 成功之后：导航失败时页面没换，不能拿走它仍在用的监听。
  > - 只处理 manager 发起的导航。页面自己 `location.reload()` 会留下一组垫片监听，量很小，不额外处理。
  > - `cleanup()` 销毁窗口时 Tauri 自己会清，不用调。
- **修改** `third-patches/tauri/README.md`：补丁列表加 11。

## 点 8 — 垫片 `wpe_shim.js` 与注入（新增 `kabegame/src/webview_js/wpe_shim.js`；修改 `startup.rs`、`wallpaper/manager/window.rs`）
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

  // ---- 投递：load 后首次全量；之后用户属性按键差异、通用属性整份；首次之后换 listener 补投全量 ----
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
    latest = next;
    if (!loaded) return;
    if (!delivered) return deliverFull(next);
    // WPE 没有整份替换的接口：只推值变化的键；作者删掉的键页面无从撤销，不推
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

  // ---- 传输：pull() → Promise<state>；listen(names, onEvent) → Promise，各事件并入同一个 onEvent ----
  var transport = desktop ? tauriTransport(window.__TAURI_INTERNALS__) : parentTransport();
  if (!transport) return;

  // 拉取编号：某次结果落地后，丢弃更早发出、更晚返回的结果
  var issued = 0;
  var applied = 0;
  function pull() {
    var seq = ++issued;
    transport.pull().then(
      function (state) {
        if (!state || seq <= applied) return;
        applied = seq;
        receive(state);
      },
      function (error) {
        console.warn("[kb-wpe] pull", error);
      },
    );
  }

  function patchesOf(event) {
    var payload = event.payload || {};
    if (event.name === "image-changed") return payload.patch ? [payload.patch] : [];
    if (event.name === "images-change") return Array.isArray(payload.patches) ? payload.patches : [];
    return [];
  }
  function shouldPull(event) {
    if (event.name === "setting-change") {
      var payload = event.payload || {};
      var changes = payload.changes && typeof payload.changes === "object" ? payload.changes : payload;
      return Object.prototype.hasOwnProperty.call(changes, "language");
    }
    // 图片 metadata 按 id 不可变：属性改了就换 metadataId。首个状态到达前不知道本张 id，任何 metadataId 补丁都重拉
    var id = latest && latest.imageId;
    return patchesOf(event).some(function (patch) {
      return patch && typeof patch === "object" && "metadataId" in patch && (!id || String(patch.id) === id);
    });
  }

  // 先订阅再拉取：订阅生效之后的变化都会触发重拉
  transport
    .listen(["setting-change", "image-changed", "images-change"], function (event) {
      if (shouldPull(event)) pull();
    })
    .catch(function (error) {
      console.warn("[kb-wpe] listen", error);
    })
    .then(pull);

  function tauriTransport(internals) {
    if (!internals) return null;
    return {
      pull: function () {
        return internals.invoke("wpe_web_pull_state");
      },
      listen: function (names, onEvent) {
        return Promise.all(
          names.map(function (name) {
            return internals.invoke("plugin:event|listen", {
              event: name,
              target: { kind: "Any" },
              handler: internals.transformCallback(function (event) {
                onEvent({ name: name, payload: event.payload });
              }),
            });
          }),
        );
      },
    };
  }

  function parentTransport() {
    var nextId = 0;
    var pending = {}; // 拉取 id → 落地回调
    var onEvent = null;
    // 发出的消息只有拉取编号与事件名，不含数据；宿主页按 event.source 认 iframe
    function post(message) {
      message.kbWpe = 1;
      window.parent.postMessage(message, "*");
    }
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (event.source !== window.parent || !data || data.kbWpe !== 1) return;
      if (data.type === "state" && pending[data.id]) {
        var settle = pending[data.id];
        delete pending[data.id];
        settle(data);
      } else if (data.type === "event" && onEvent) {
        onEvent({ name: data.name, payload: data.payload });
      }
    });
    return {
      pull: function () {
        var id = ++nextId;
        return new Promise(function (resolve, reject) {
          pending[id] = function (data) {
            if (data.error) reject(data.error);
            else resolve(data.state);
          };
          post({ type: "pull", id: id });
        });
      },
      listen: function (names, handler) {
        onEvent = handler;
        post({ type: "listen", events: names });
        // 宿主页收到消息即登记；宿主自己的 Tauri listen 何时生效不回报，预览接受这一点窗口
        return Promise.resolve();
      },
    };
  }
})();
```
  > 说明：
  > - 切换壁纸不需要通知页面：网页 → 网页时整页导航到新入口，新文档里的垫片重新订阅、重新拉取；切走时页面直接被卸载（桌面的旧监听由点 7 清掉）。
  > - 首次全量里先 `applyUserProperties` 再 `applyGeneralProperties`。WPE 的实际顺序未确认。
  > - 页面自己的嵌套 iframe 不启用：预览里它们的父窗口不是 top，桌面里它们不是 top。
  > - 下载期间 `images-change` 很频繁，每条都会投递给垫片。垫片只按 id 过滤，开销是一次 eval（桌面）或一次 `postMessage`（预览）。
- **修改**
  - `wallpaper/manager/window.rs`：壁纸窗口 builder 加 `.initialization_script_for_all_frames(crate::commands::wpe_web::WPE_SHIM_JS)`。
  - `startup.rs`：主窗口 builder 同样加（`#[cfg(not(target_os = "android"))]`）。
    > 说明：垫片在应用页和其它 iframe 里第一行就返回，不定义任何全局。

## 点 9 — 预览宿主页：`useTauriProxy` 与预览桥（新增 `apps/kabegame/src/composables/useTauriProxy.ts`、`components/wallpaper/wpeWebBridge.ts`；修改 `WallpaperStage.vue`）
- **新增** `composables/useTauriProxy.ts`
```ts
import { Subject, mergeMap } from "rxjs";
import { getCurrentScope, onScopeDispose } from "vue";
import { kbEvent$, type KbEvent } from "@/services/kbEvents";

export interface TauriProxy {
  /** 代为订阅这些后端事件；同名只订阅一次，并入同一条管道交给 `forward`。 */
  listen(names: Iterable<string>): void;
  /** 退订全部；在组件 / effectScope 里创建时随作用域自动调用。 */
  dispose(): void;
}

/**
 * 替不能直接用 IPC 的页面（预览 iframe 里的网页壁纸）代办 Tauri 能力，目前只有 `listen`。
 * 登记过的事件经 `kbEvent$` 合并成一条管道，按到达顺序交给 `forward`。
 */
export function useTauriProxy(forward: (event: KbEvent) => void): TauriProxy {
  const listened = new Set<string>();
  const names$ = new Subject<string>();
  // 新名字并入同一条管道；已有订阅不重建，不会出现退订再订阅的空档
  const subscription = names$.pipe(mergeMap((name) => kbEvent$(name))).subscribe(forward);

  const proxy: TauriProxy = {
    listen(names) {
      for (const name of names) {
        if (listened.has(name)) continue;
        listened.add(name);
        names$.next(name);
      }
    },
    dispose() {
      subscription.unsubscribe();
    },
  };
  if (getCurrentScope()) onScopeDispose(proxy.dispose);
  return proxy;
}
```
- **新增** `components/wallpaper/wpeWebBridge.ts`
```ts
import { invoke } from "@/api/rpc";
import { useTauriProxy } from "@/composables/useTauriProxy";

/** 后端 `WpeWebState`：网页壁纸页面拉取的完整状态。 */
export interface WpeWebState {
  imageId: string;
  user: Record<string, { type?: string; value: unknown }>;
  general: { language: string };
}

/**
 * 预览 iframe 的宿主端：替网页壁纸垫片拉取状态、代为 listen。
 * - `pull { id }` → 用主窗口权限调 `get_wpe_web_state`，回 `state { id, state | error }`；
 * - `listen { events }` → `tauriProxy.listen`，事件逐条回 `event { name, payload }`。
 * 只认本 iframe（`event.source`），只发往它加载时的源；外部页面不接触 IPC。
 */
export function attachWpeWebBridge(frame: HTMLIFrameElement, frameUrl: string, imageId: string) {
  const origin = new URL(frameUrl, location.href).origin;
  let disposed = false;
  const post = (message: Record<string, unknown>) => {
    if (!disposed) frame.contentWindow?.postMessage({ kbWpe: 1, ...message }, origin);
  };
  const tauriProxy = useTauriProxy((event) => post({ type: "event", name: event.name, payload: event.payload }));

  async function pull(id: number) {
    try {
      const state = await invoke<WpeWebState | null>("get_wpe_web_state", { imageId });
      post(state ? { type: "state", id, state } : { type: "state", id, error: "not a web wallpaper" });
    } catch (error) {
      post({ type: "state", id, error: String(error) });
    }
  }

  function onMessage(event: MessageEvent) {
    const data = event.data;
    if (event.source !== frame.contentWindow || data?.kbWpe !== 1) return;
    if (data.type === "pull" && typeof data.id === "number") void pull(data.id);
    else if (data.type === "listen" && Array.isArray(data.events)) {
      tauriProxy.listen(data.events.filter((name: unknown): name is string => typeof name === "string" && name !== ""));
    }
  }
  window.addEventListener("message", onMessage);

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      tauriProxy.dispose();
    },
  };
}
```
  > 说明：
  > - 桥在 `enterWeb` 的 `await` 之后创建，那时已没有活动的 effect scope，`useTauriProxy` 不会自动释放，由 `dispose()` 显式退订。
  > - 不限 iframe 能登记的事件名，与桌面 `allow-listen` 一致（总体设计思路的取舍）。
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

## 点 10 — 文档与回归
- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：
    - 「初始化脚本隔离」改为「照常注入 + 远程 `file:` 来源 + `wpe-web-capability`」，删掉「`cef-ipc` 入口本来也拒绝」这句错误描述；
    - 新增「运行时垫片与宿主协议」一节，包括：
      - `pull` / `listen` 两个原语与两种实现；
      - `useTauriProxy` 代办；
      - 重拉触发（语言、`metadataId`）；
      - 投递语义与拉取编号；
      - 导航时清 JS 监听；
      - 接受的全局事件可见性。
  - `cocs/README.md`：WPE 条目补垫片与协议。适用场景里「页面里出现 `__TAURI_INTERNALS__`」改为「页面调用应用命令被 ACL 拒绝 / 收不到属性 / 改语言后页面没反应」。
  - `AGENTS.md`：WPE 那条里的「`file:` 文档不注入初始化脚本」改为「`file:` 文档照常注入 Tauri 脚本，IPC 按远程 `file:` 来源只给 `wpe-web-capability`」。
  - `src-tauri/tauri-runtime-kbcef/README.md`：协议层 `Origin` 改写与删除注入跳过。
  - `third-patches/tauri/README.md`：补丁列表加 11 `clear_js_listeners`（与点 7 同一处，实施时一起写）。
  - `API.md` §8 落地表与 `PLAN.md` Phase 5 段：标记已完成。
    > 说明：两处的 pull / listen、重拉触发、宿主代办与 Phase 7 的触发方式已随本次修订（2026-10-28）改好，实施时只改状态。
  - `versions/latest/regression.md`：
    - Phase 4 的「初始化脚本隔离」行改成新的期望：`__TAURI_INTERNALS__` 存在，应用命令被拒；
    - 新增本 Phase 各行（见下）。
  - `versions/latest/changelog.md`：一行「网页壁纸可读取作者默认属性与界面语言」。

## 验收清单（Windows 11 dev，用 `kabegame-chromium`；Rust 改动后 dev 自行重建，不轮询）
- **单测**：
  - 点 1 的 `Origin` 改写与回退顺序；
  - 点 3 的 `file:///*` 模式匹配；
  - 点 4 的属性与语言码。
- **桌面 kaguya**（壁纸窗口在 `file://`）：
  - `typeof __TAURI_INTERNALS__ === "object"`。
  - 页面控制台 `__TAURI_INTERNALS__.invoke("get_settings", { keys: ["language"] })` 返回 `Command get_settings not allowed by ACL`。dev 构建的依赖关了 `debug-assertions`，错误文本不含来源；同页 `wpe_web_pull_state` 成功即说明被判成远程 `file:` 来源。
  - `invoke("wpe_web_pull_state")` 返回 kaguya 的状态。
  - 用 debug ingest 插桩记录 `applyUserProperties` 的调用：在 `load` 之后恰好一次，键与 `project.json` 中带 `value` 的条目一致。
  - 切换界面语言：垫片重新拉取；`applyGeneralProperties({ language })` 收到新码；`applyUserProperties` 不再被调用（属性没变）。
  - 在主窗口 `emit("image-changed", { seq: 0, patch: { id: <kaguya id>, metadataId: <原值> } })` 模拟 metadata 补丁：垫片重新拉取；属性没变，所以不回调 `applyUserProperties`。真正的差异投递等 Phase 7 有了保存再回归。
  - 主窗口里调用 `wpe_web_pull_state`（若有权限）返回 `no web wallpaper`。切回图片壁纸后，壁纸窗口同样返回它。
- **桌面安全**：
  - `fetch("ipc://localhost/get_settings")` 绕过 `invoke` 直接请求，同样被拒；
  - 嵌套 iframe 里没有 `__TAURI_INTERNALS__`；
  - 回到图片壁纸后，应用页照常（`main-capability` 生效）。
- **导航清监听**：
  - 用 debug ingest 插桩，在 `show_web` / `show_app` 前后记录本 label 的 JS 监听数；
  - 图片 → kaguya → 图片 → kaguya 循环两轮：监听数不增长，应用页的 `setting-change` 照常生效。
- **预览 12099**：
  - iframe 内 `window.__kbWpeShim === true`，主窗口应用页里 `__kbWpeShim` 为 `undefined`；
  - 宿主页 debug ingest：收到一次 `listen`（三个事件名）和一次 `pull`；
  - `applyUserProperties` 在 iframe `load` 后被调用一次；
  - 切语言：经 `useTauriProxy` 转发 `setting-change`，iframe 重拉，收到新的 general；
  - 关闭预览：`dispose` 后宿主页不再转发。
- **换 listener**：首次投递后在页面控制台执行 `window.wallpaperPropertyListener = { applyUserProperties: console.log }`，下一个微任务打印全量属性。

## 风险与回退
- **all-frames 脚本能否进跨源 iframe 的渲染进程**（站点隔离，未实测）：
  - CEF 应把 `extra_info` 发给承载该 browser 任一 frame 的渲染进程，但需要真机确认。
  - 不成立时，预览改为在 `serve_wpe_html` 里给 HTML 插 `<script src="/wpe-shim.js">`，同一份 `wpe_shim.js` 经 HTTP 路由提供。桌面不受影响。
- **`file:` 请求的 `Origin` 头实际值**（`null`，或者 `file://`）不影响点 1：改写只看 frame URL。用 debug ingest 记录一次，写进 API.md。
- **`urlpattern` 对 `file:` 的匹配**：见点 3 测试。实在不支持时，改用运行时 `app.add_capability`，按当前壁纸入口的精确 URL 生成 capability。
- **清监听的时序**（点 7）：
  - 清理紧跟在 `navigate` 投递成功之后。新文档的 `listen` 要等加载、执行脚本才发出，实际不会早于清理。
  - 若真机观察到新文档的监听被误清（换壁纸后语言变化页面没反应），改为在 Tauri 补丁里按「导航前已存在的 id」清理。

## 不做 / 留到后续
- **Phase 6**：`paused` 进状态，垫片实现冻结（参照 API.md §4.4）与 `setPaused`；`fps` 设置与推送。
- **Phase 7**：
  - 用户属性叠加在作者默认值之上；
  - 保存时写新 metadata 行，并发 `image-changed { metadataId }`。本 Phase 的垫片已订阅，重拉后按键差异投递，Rust 仍不推状态；
  - `file` / `directory` 属性。
- **Phase 8**：注册函数开始收到数据。数据回程沿用本 Phase 的通道：桌面走 `listen`，预览走 `useTauriProxy` 转发。

## 实施记录（2026-10-28）

点 1–10 按方案实现，静态验证与单测通过，真机回归待做（`versions/latest/regression.md` Phase 5 节）。与方案的偏差：

- **点 1 `cef-ipc` 的 `file:` URI**：方案的 `ipc.rs` 代码把 frame URL 直接交给 `HttpRequest::builder().uri(..)`，但
  `http::Uri` 不接受空 authority，`file:///D:/…` 解析失败（单测 `file_url_survives_http_uri` 已确认），回退通道会对
  `file:` 页面一律返回 400。实现里交给 `ipc_handler` 前改写成等价的 `file://localhost/…`（`http_uri_for`），Tauri 用
  `url::Url` 解析时把 `file:` 的 `localhost` 归一为空，拿到的仍是 `file:///…`。`ipc://` 主通道直接 `Url::parse(Origin)`，
  不受影响。
- **点 3 `file:///*`**：`RemoteUrlPattern::from_str("file:///*")` 实测可用——匹配入口（含百分号编码路径与
  `file://localhost/…` 归一后的形式），不匹配 `http://127.0.0.1/`、本地 HTTP 预览源与应用页。按方案原写法使用。
- **点 5**：`commands/wpe_web.rs` 与两条命令只在非 Android 编译（`#[cfg(not(target_os = "android"))]`），与 capability
  只进桌面分支一致；`get_wpe_web_state` 仍登记在 `main.toml`。
- **点 7**：补丁里的文档注释用英文（与上游及 01–10 一致）。`deno task patch tauri --check` 预检 01–11 通过；
  三个文件不被前序补丁触碰，补丁直接取自 `git -C third/tauri diff -- <三个文件>`。
- **点 9**：`createWebFrame` 挂新桥前先 `dispose()` 旧桥（防御性，正常路径 `teardownWeb` 已释放）。
- **点 10**：
  - 生成文件 `src-tauri/kabegame/tauri.conf.json`（gitignore）同步加了 `wpe-web-capability`：`deno task check` 不渲染
    handlebars 模板，不同步的话 cargo check 不会校验新 capability；dev / build 启动时会重新渲染。
  - `API.md` §6 的 `setPaused` 行 Phase 列从「5（垫片）/ 6（触发）」改为 6，与本方案「不做：暂停冻结与 `setPaused`」一致。
  - 顺带修正文档冲突：`cocs/surf/ANDROID_SURF.md` 与 `cocs/README.md` 把响应 Channel 补丁写成 11，实际文件是 10，
    新的 11 是本 Phase 的 `clear_js_listeners`；`cocs/tauri/TAURI_CLI_FORK.md` 补了 10 / 11 条目与升级复查点；
    `cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md` 补了远程 `file:` 来源一节。
  - Phase 4 回归的「初始化脚本隔离」行改为新期望并取消勾选（原结果保留在备注里）。
