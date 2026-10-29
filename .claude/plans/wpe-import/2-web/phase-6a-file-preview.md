# Phase 6a — 预览 iframe 改走 `file://`

> 状态：已实现（2026-10-28），真机回归待做（`versions/latest/regression.md`「Phase 6a」一节）。上级：[PLAN.md](PLAN.md)。
>
> 起因：Phase 7 要让 `file` / `directory` 属性在预览里也能用（调试 Slideshow）。预览 iframe 现在是 HTTP 源
> （`http://127.0.0.1:<port>/wpe/<id>/`），HTTP 页面引用 `file:///…` 时 Blink 在渲染进程的 `SecurityOrigin::CanDisplay`
> 就拦下（`Not allowed to load local resource`），请求从不发出，CEF 浏览器进程的任何钩子都看不到；
> `add_cross_origin_whitelist_entry` 管的是脚本跨源访问，不查本地 scheme 这条分支。所以 HTTP 源下要么改页面文本，
> 要么没有 Rust 侧拦截点。用户选择：预览 iframe 也改成 `file://`，让它和桌面壁纸窗口走同一条 Rust 拦截路。
>
> 依赖：Phase 4（补丁 0004、`file_access.rs`）、Phase 5（垫片、宿主桥）。Phase 7 依赖本 Phase。
>
> 范围：
> - 主窗口登记文件文档策略；预览挂载 / 卸载时设置 / 清空根目录；
> - 预览 iframe `src` 改成入口 `file://`；CSP `frame-src` 放行 `file:`；
> - 垫片的预览判定、宿主桥的 `postMessage` 目标源随之调整；
> - **撤掉 `/wpe` HTTP 目录服务**（用户指定，2026-10-28）：Web 发布版不提供网页壁纸，应用 Web 服务器也不需要，桌面预览改走 `file://` 后它没有使用方；
> - **WPE 目前只提供 Windows 桌面**（用户指定，2026-10-28）：发现 / 导入、桌面 `file://` 宿主、预览 `file:` iframe 都按 `target_os = "windows"` 门控，
>   其它平台 `x-wpe/*` 行只显示预览图（PLAN 已确认决策 11）。
>
> **不做**：
> - 不动桌面壁纸窗口的任何逻辑；
> - 不实现 Phase 7 的追加放行（本 Phase 根目录仍只有壁纸目录），只保证 Phase 7 加 grants 时两种宿主用同一份机制；
> - Web 发布版 / Android 不渲染网页壁纸：`x-wpe/web` 行只显示作者预览图，走现有错误回退。

## 总体设计思路

桌面壁纸窗口在 Phase 4 已经证明了一套模型：`file://` 文档 + 补丁 0004 按浏览器打开 `allow_file_access_from_file_urls`
+ 运行时 `FileDocumentGuardHandler` 按当前根目录拦截每个 `file:` 请求。本 Phase 把图库预览也搬到这套模型上：
主窗口建窗前登记为「允许 `file:` 文档」的 webview，预览 iframe 直接加载壁纸入口的 `file://`，根目录在预览挂载时设为该壁纸目录、
卸载时清空。于是两种宿主的本地文件边界完全一样，Phase 7 的「根目录 + 用户选的文件 / 目录」追加放行只需写一份。

安全边界不变、只是换了位置。主窗口多了一项 `allow_file_access_from_file_urls` 偏好，它只影响 `file:` 源的文档（应用页是
`http://localhost:1420` / `tauri`，不受影响），而且所有 `file:` 请求都经 `on_before_resource_load`：根目录为 `None` 时一律拒绝，
所以不打开预览时主窗口对本地文件的态度与现在相同。`allow_universal_access_from_file_urls` 仍然关闭，`file:` iframe 碰不到父页面
的 DOM。IPC 方面三道闸门都与 iframe 的 scheme 无关：Tauri 自身脚本与 invoke key 只注入主 frame（`subprocess.rs` 的
`for_main_frame_only`）；`cef-ipc` 拒收与初始 URL 不同源的子 frame；即便到了 ACL，`file:` 来源只匹配绑定在 `wallpaper` 窗口的
`wpe-web-capability`，在 `main` 里零授权。iframe 能做的仍只有向宿主页 `postMessage` 发 `pull` / `listen`。

顺带的收益：预览与桌面变成同一个 `file:` 源，`localStorage` 跨重启稳定（API.md 难点二就此解决，不再需要 `kb-wpe` 自定义协议）。
> 2026-10-29 更正：真机证实两边**不互通**——Chromium 按顶层站点分区存储，预览 iframe 的顶层是 `localhost:1420`、桌面是 `file://`，两个方向都读不到对方写的键；「同源且稳定」成立，「互通」不成立。
`/wpe/<id>/` 目录服务因此没有了使用方：Web 发布版本来就不提供网页壁纸，应用 Web 服务器（MCP / 外部集成）也不需要把壁纸目录暴露出去，
整条路由连同它的 MIME 表、HTML 产出点、CSP 放行一起删除。本地 HTTP 服务本身（`/file`、`/thumbnail`、`/compatible`、插件文件）照旧。

关键决策：
- **根目录由前端预览组件经命令设置**，而不是 Rust 猜「主窗口正在预览谁」。`WallpaperStage` 知道自己何时挂上、何时撤下 iframe，
  在设 `src` 之前 `await` 命令、`teardownWeb` 时清空。命令按调用方 webview 的 label 生效，拒绝壁纸窗口（那里的根由
  `WallpaperWindow` 管）。
- **入口 `file://` 由后端给**：`WallpaperTarget` 新增 `webEntry`，用 `WindowWallpaperManager` 已有的 `web_entry()` 算，前端不自己拼
  `file:///` + 路径。
- **垫片的预览判定改成「非顶层的 `file:` 文档」**，不再认 `/wpe/<id>/`。Web 版没有垫片，HTTP 分支没有存在的必要。
- **宿主桥 `postMessage` 的目标源用 `"*"`**：`file:` 源在 `postMessage` 的目标匹配上不可靠，改靠 `event.source === frame.contentWindow`
  认人（本来就有）。桥发出的只有拉取结果（本张壁纸的属性与语言）和转发的事件。

## 现状锚点

**a. 预览 iframe 加载 HTTP 入口**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue:175`、`utils/fileUrl.ts:84`）
```ts
async function getWebUrl(target: WallpaperTarget): Promise<string> {
  await initHttpServerBaseUrl();
  const url = wpeEntryUrl(target.id);              // 现状：http://127.0.0.1:<port>/wpe/<id>/，307 到入口
  if (!url) throw new Error(`无法获取网页壁纸 URL: ${target.path}`);
  return url;
}
// createWebFrame：先挂桥、插入 DOM、再设 src；没有任何 Rust 侧前置步骤
webBridge = attachWpeWebBridge(frame, url, imageId);
layer.appendChild(frame);
frame.src = url;
```

**b. 壁纸目标没有入口 URL**（`src-tauri/kabegame/src/commands/wallpaper.rs:36`）
```rust
pub struct WallpaperTarget {
    pub id: String,
    pub path: String,
    pub media_type: Option<String>,
    /// …WPE 网页为空（页面经 `/wpe/<id>/` 加载）。      // 现状：前端按 id 拼 HTTP 地址
    pub compatible_path: Option<String>,
    pub wpe_video: Option<WpeVideoProps>,
}
```
入口 `file://` 的算法已在 `wallpaper/manager/window.rs:17`：`fn web_entry(path) -> Result<Option<(PathBuf, Url)>>`（私有）。

**c. 只有壁纸窗口登记了文件文档策略**（`src-tauri/kabegame/src/wallpaper/manager/window.rs:93`、`startup.rs:163`）
```rust
// 壁纸窗口：建窗前登记
tauri_runtime_cef::allow_file_documents(WALLPAPER_LABEL);
// 主窗口：没有登记。它的 browser 没有 0004 的偏好，file: 请求也不经 FileDocumentGuardHandler
let builder = WebviewWindowBuilder::new(app_handle, "main", WebviewUrl::App("index.html".into()))
    // …
    .initialization_script_for_all_frames(crate::commands::wpe_web::WPE_SHIM_JS);
```

**d. 运行时按 label 分发闸门**（`src-tauri/tauri-runtime-cef/src/webview.rs:802`）
```rust
if is_file_request && crate::file_access::is_file_document_webview(&self.label) {
    return Some(FileDocumentGuardHandler::new(self.label.clone()));   // 现状：机制已通用，只缺主窗口登记
}
```

**e. 垫片按 HTTP 地址判定预览**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:8`）
```js
var desktop = isTop && location.protocol === "file:";
var preview =
  !isTop && window.parent === window.top &&
  (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
  /^\/wpe\/[^/]+\//.test(location.pathname);                       // 现状：只认本地 HTTP 源
```

**f. 宿主桥按 iframe 的 HTTP 源发消息**（`apps/kabegame/src/components/wallpaper/wpeWebBridge.ts:17`）
```ts
export function attachWpeWebBridge(frame: HTMLIFrameElement, frameUrl: string, imageId: string) {
  const origin = new URL(frameUrl, location.href).origin;         // 现状：http://127.0.0.1:<port>
  const post = (message) => { if (!disposed) frame.contentWindow?.postMessage({ kbWpe: 1, ...message }, origin); };
```

**g. CSP 只放行本地 HTTP 源的 frame**（`src-tauri/kabegame/tauri.conf.json.handlebars:41`）
```
frame-src 'self' blob: data: about: http://127.0.0.1:*      // 现状：没有 file:
```

---

## 点 1 — 壁纸目标带入口 `file://`（`commands/wallpaper.rs`、`wallpaper/manager/window.rs`、前端 `types.ts`）

- **修改**
  - `web_entry` 从 `manager/window.rs` 移到 `commands/wallpaper.rs` 旁（或 `wallpaper/mod.rs`）设为 `pub(crate)`，两处共用。
  - `build_wallpaper_target`：`x-wpe/web` 行时算 `web_entry`，失败只记日志、字段为 `None`（预览会报「无法获取网页壁纸 URL」）。
  - 前端 `WallpaperTarget` 加 `webEntry?: string | null`。
```rust
pub struct WallpaperTarget {
    // …
    /// 新增：`x-wpe/web` 行的入口 `file://` URL；预览 iframe 直接加载它。其它类型为 None。
    pub web_entry: Option<String>,
}
```

## 点 2 — 主窗口登记文件文档策略 + 预览根目录命令（`startup.rs`、`commands/wpe_web.rs`、`permissions/main.toml`）

- **修改**（`startup.rs` `create_main_window`）
  - 建窗前 `tauri_runtime_cef::allow_file_documents("main")`。注释写明：只给图库预览的 `file:` iframe 用，根目录由 `set_wpe_web_preview` 管，
    不预览时为空、拒绝全部 `file:`。
  - 垫片那条注释改成「只在预览的 `file:` 直接子 iframe 里启用」。
- **新增**（`commands/wpe_web.rs`）
  - `set_wpe_web_preview(webview, image_id: Option<String>)`：
    - `webview.label() == WALLPAPER_LABEL` 时报错（壁纸窗口的根由 `WallpaperWindow` 管）；
    - `Some(id)`：`find_image_by_id` → 必须是 `x-wpe/web` 且目录存在 → `set_file_document_root(label, Some(dir))`；
    - `None`：`set_file_document_root(label, None)`；
    - 目录取 `read_project(dir).dir`（与 `web_entry` 同源的规范化目录），放 blocking 线程。
  - `permissions/main.toml` 放行；**不**进 `wpe-web.toml`。
```rust
/// 图库预览：把调用方窗口的 `file:` 根目录设成这张网页壁纸的目录（None 清空）。
/// 预览 iframe 的每个 `file:` 请求都经运行时按这个根目录拦截；壁纸窗口不走这里。
#[tauri::command]
pub async fn set_wpe_web_preview<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    image_id: Option<String>,
) -> Result<(), String>;
```
- Phase 7 的钩子：追加放行时 `get_wpe_web_state` 也拿 `webview.label()` 调 `grant_file_documents(label, &dir, &grants)`，与桌面同一个函数。

## 点 3 — 预览组件改加载 `file://`（`WallpaperStage.vue`）

- **修改**
  - `getWebUrl`：只用 `target.webEntry`，没有就抛错（Web 版 / Android 的目标没有这个字段，自然落到现有的 `setLastError` → `error` 回退，
    `ImageContent` 退回作者预览图）。不再 `initHttpServerBaseUrl` / `wpeEntryUrl`。
  - `createWebFrame` 在插入 DOM、设 `src` **之前** `await invoke("set_wpe_web_preview", { imageId })`；失败则 `setLastError` 并不创建 iframe。
  - `teardownWeb`：移除 iframe 后 `void invoke("set_wpe_web_preview", { imageId: null })`（不等待；在途请求被拒绝是预期）。
  - 组件卸载走 `teardownWeb`，已覆盖。
  - 头注释「跨源 iframe」改成「`file:` iframe（不透明源，与应用页隔离）」。
```ts
async function getWebUrl(target: WallpaperTarget): Promise<string> {
  const url = target.webEntry;                                   // 修改：后端给的 file:// 入口；原 wpeEntryUrl 删除
  if (!url) throw new Error(`无法获取网页壁纸入口: ${target.path}`);
  return url;
}
async function createWebFrame(url: string, imageId: string): Promise<void> {
  settleWebLoad();
  await invoke("set_wpe_web_preview", { imageId });              // 新增：先开根目录，再让页面发请求
  // …原有：建 iframe、挂桥、插入、设 src
}
function teardownWeb() {
  // …原有
  void invoke("set_wpe_web_preview", { imageId: null });         // 新增
}
```
- 并发：`enterWeb` 已串行（`webToken`）；web → web 时先 `teardownWeb`（清根）再 `createWebFrame`（设新根），顺序正确。

## 点 4 — 垫片与宿主桥（`wpe_shim.js`、`wpeWebBridge.ts`）

- **修改**（`wpe_shim.js`）
```js
var desktop = isTop && location.protocol === "file:";
var preview = !isTop && window.parent === window.top && location.protocol === "file:";   // 修改：不再认 /wpe/<id>/
```
  - 嵌套更深的 `file:` iframe（壁纸自己的子页面，如 Slideshow 的 `keyframes.html`）仍不启用，与现状一致。
- **修改**（`wpeWebBridge.ts`）
  - 去掉 `origin` 计算，`postMessage(…, "*")`；注释改为「只认 `event.source`；`file:` 源的目标匹配不可靠，消息内容只有本张壁纸的状态与转发事件」。
  - 签名去掉 `frameUrl`（调用方同步改）。

## 点 5 — CSP（`tauri.conf.json.handlebars`）

- **修改**：`frame-src` 增加 `file:`，去掉 Phase 3 为 `/wpe` 加的 `http://127.0.0.1:*`（已 grep：前端没有别的 iframe 指向本地 HTTP 源，只有 MCP 设置面板显示的端点文本）；
  生成的 `tauri.conf.json`（gitignored）手动同步。
```
frame-src 'self' blob: data: about: file:          // 新增 file:；删除 http://127.0.0.1:*
```

## 点 5b — 删除 `/wpe` 目录服务（`http_server.rs`、`utils/fileUrl.ts`）

- **删除**（`src-tauri/kabegame/src/http_server.rs`）
  - 路由 `/wpe/{id}/`、`/wpe/{id}/{*rel}`，`file_routes()` 与 `file_routes_media()` 两处；
  - `handle_wpe_entry`、`handle_wpe_file`、`authorize_wpe_row`、`encode_relative_path`（确认没有别的调用方）、
    `WPE_WEB_MIME`、`wpe_mime_from_path`、`wpe_needs_revalidate`、`serve_wpe_html`；
  - 测试 `wpe_web_mime_table_covers_page_resources`。
- **删除**（`apps/kabegame/src/utils/fileUrl.ts`）：`wpeEntryUrl` 及其在 `WallpaperStage.vue` 的 import。
- **检查**：`cocs/mcp/MCP_SERVER.md` 若提到 `/wpe` 媒体路由，一并删掉；`kabegame-core` 的 `wpe` 模块不动（入库、`read_project`、属性解析都在用）。

## 点 5c — 平台限定：WPE 只提供 Windows 桌面（`discover.rs`、`manager/window.rs`、`startup.rs`、`commands/wpe_web.rs`）

现状：`kabegame_core::wpe::discover::platform_supported()` 是 `cfg!(any(windows, linux))`；桌面 `file://` 宿主（`show_web`）、
`web_entry`、预览命令都没有平台门控，只有鼠标转发是 `cfg(target_os = "windows")`。macOS / Linux 上这套 `file:` 文档 + 补丁 0004 的路径从未真机验证。

- **修改**
  - `platform_supported()` 改为 `cfg!(target_os = "windows")`；Linux 的 Steam 路径探测代码保留但不再进入（注释写明「暂只支持 Windows」）。
    导入入口（`WallpaperImportDialog` / `wpe-import` 任务）在其它平台沿用现有的「不支持」分支。
  - `web_entry()`（点 1 移动后的那份）整个函数 `#[cfg(target_os = "windows")]`，其它平台提供同签名的 `Ok(None)` 版本：
    `set_wallpaper_path` 对网页壁纸自然走 `show_app`（只显示应用页，Vue 对 `x-wpe/web` 目标按预览图处理），`WallpaperTarget.web_entry` 为 `None`。
  - `allow_file_documents(WALLPAPER_LABEL)`、`allow_file_documents("main")` 两处登记都 `#[cfg(target_os = "windows")]`：
    非 Windows 的 browser 不带 0004 的偏好，`file:` 请求也不经闸门（本来就不会有 `file:` 文档）。
  - `set_wpe_web_preview` 非 Windows 直接 `Err("WPE web wallpapers are Windows-only for now")`；前端 `getWebUrl` 已因 `webEntry` 缺失先报错，命令只是兜底。
  - 不动 `WpeWallpaperContent` / `ImageContent`：`webEntry` 缺失时 `WallpaperStage` 报错 → `error` 事件 → 预览图回退，这条链 Phase 3 已有。
- **不改**：`kabegame-core::wpe` 的入库模型、`read_project`、属性解析保持跨平台编译（CLI / 测试用）。

## 点 6 — 文档

- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：「预览内嵌」一节改为 `file:` iframe + 主窗口文件文档策略 + `set_wpe_web_preview`；
    「两种宿主」对照表的页面加载 / 文件访问 / `localStorage` 行；删掉「`/wpe/<id>/<rel>` 目录服务」「`/wpe` 专属网页 MIME 表」「`serve_wpe_html`」「CSP `frame-src`」相关段落。
  - `cocs/README.md`、`AGENTS.md`：WPE 条目里「图库预览经本地媒体服务 `/wpe/<imageId>/` 跨源 iframe 加载（307 到入口、相对资源同前缀，网页 MIME 用 `/wpe` 专属表…）」改为
    「图库预览在主窗口里以 `file:` iframe 加载入口，主窗口同样登记文件文档策略、按预览中的壁纸目录拦截；Web 版 / Android 只显示预览图」。
  - `cocs/mcp/MCP_SERVER.md`：媒体路由里若列了 `/wpe`，删掉。
  - `AGENTS.md`、`cocs/wpe/WPE_IMPORT.md`、`apps/docs`（若已有 WPE 页面）：写明「WPE 壁纸目前只提供 Windows 桌面；macOS / Linux / Android / Web 不发现、不导入、不渲染」。
  - `src-tauri/tauri-runtime-cef/README.md`：文件文档策略一节补「主窗口也登记」。
  - `API.md`：§5.3 对照表预览列；难点一改为「两种宿主同一机制」；难点二标记已解决（同源）；第八节不变。
  - `PLAN.md`：路线表插入 Phase 6a；Phase 7 依赖改为 6a；待定决策 4（`kb-wpe`）标记不再需要；已确认决策 7、8 里「预览仍用 HTTP iframe」加注。
  - `versions/latest/regression.md`：新增 Phase 6a 一节；`versions/latest/changelog.md` 加一行开发向说明（用户不可见的变化）。

## 验证

- `check-kabegame` 通过；runtime 无改动，不需要重启 helper（`file_access.rs` 不动）。改了 `wpe_shim.js` 要完全重启 dev。
- 真机（Windows，dev 由用户跑）：
  1. 预览 kaguya：`targets` 看主窗口下的子 frame URL 是 `file:///…/3679122549/index.html`；页面完整（背景、封面、歌词、播放器），
     `fetch("data.json")` 成功，stderr 没有它的 `deny file:`。
  2. 属性仍到达：预览里 `wallpaperPropertyListener` 收到首推（Phase 5 的回归项在 `file:` 下重跑一遍：首推、换 listener 补投、语言切换重拉）。
  3. 越界：CDP 在预览 iframe 里 `fetch('file:///C:/Windows/win.ini')` 与 `fetch('../796697921/project.json')` 都失败，stderr 各有一条
     `deny file: … webview 'main'`。
  4. 关闭预览后再在主窗口应用页里（CDP 顶层）`fetch('file:///C:/Windows/win.ini')`：失败，`deny file: … (outside <none>; NoRoot)`。
  5. 预览切图 web → 图片 → web、web → 另一张 web：根目录随之换；旧壁纸目录的请求在新预览里被拒。
  6. 隔离：预览 iframe 里 `window.__TAURI_INTERNALS__` 为 `undefined`；`window.parent.document` 抛 `SecurityError`；
     伪造 `fetch("cef-ipc://localhost/", POST)` 不触发任何命令。
  7. `localStorage`：预览里写一个键，切到桌面壁纸（同一张）能读到。（2026-10-29 实测：读不到，按顶层站点分区；见 regression 0005 小节用例 12）
  8. Slideshow 在预览里能跑（无属性状态，与 Phase 3 相同）；`keyframes.html` 子页面照常加载。
  9. 应用背景层（`App.vue`）对网页壁纸仍只用缩略图，不受影响。
  10. 壁纸窗口（`wallpaper` label）调 `set_wpe_web_preview` 被拒（单测或 CDP 在壁纸窗口 invoke）。
  11. `curl http://127.0.0.1:<port>/wpe/<id>/` 返回 404（路由已删）；`/file`、`/thumbnail` 照常；`grep -rn "wpeEntryUrl\|/wpe/" apps src-tauri cocs` 只剩历史文档。
  12. 平台门控只能 `cargo check` 验证（本机无 macOS / Linux）：`deno task check -c kabegame` 在 Windows 通过；
      `platform_supported` 与 `web_entry` 的非 Windows 分支有单测（返回 `false` / `Ok(None)`）。

## 实施记录

**2026-10-28 真机偏差：预览 iframe 赋 `file:` 的 `src` 被拦，改由浏览器进程导航。**

- **现象**：按点 3 实施后真机预览 kaguya，iframe 停在 `about:blank`，控制台 `Not allowed to load local resource`。
  应用页是 `http://localhost:1420`，页面脚本给子 frame 设 `src = "file:///…"` 是**渲染进程发起**的导航，Blink 在
  `FrameLoader` 里对带发起文档的请求做 `SecurityOrigin::CanDisplay`，http 源不能显示本地资源，导航在渲染进程就被丢弃；
  主窗口登记的文件文档策略、补丁 0004 的偏好、`OnBeforeResourceLoad` 闸门都在这之后，碰不到它。本 Phase 起因里
  「HTTP 页面引用 `file:` 被 `CanDisplay` 拦下」同样适用于 iframe 导航本身——方案阶段漏判了这一点。
- **修法**（只改应用与运行时公开 API，不动 `third/`、CEF / tauri 补丁）：
  - 运行时新增 `tauri_runtime_cef::navigate_frame(label, frame_name, url)`：CEF UI 线程上按 label 取 browser →
    `frame_by_name` → `load_url`，同步等回执（同 `start_download`），找不到 webview / browser / frame 返回 Err。
  - `set_wpe_web_preview(Some(id))` 在 `set_file_document_root` 之后调 `navigate_frame(label, "kb-wpe-preview", 入口)`；
    入口与根目录同取 `wallpaper::web_entry`。`None` 分支不变。名字常量 Rust（`commands/wpe_web.rs`）与前端
    （`wpeWebBridge.ts`）各一份、注释互指。
  - `WallpaperStage`：iframe 带 `name`、**不设 `src`**，先插入 DOM 再 `await setWpeWebPreview(imageId)`；失败则销毁 iframe
    并抛「无法加载网页壁纸」。`load` 判初始文档改用 `isInitialBlank`；补发时机仍停在初始 `about:blank` 就再调一次
    `setWpeWebPreview(imageId)`。`getWebUrl` 删除，`WallpaperTarget.webEntry`（Rust / TS）随之删除——入口只由 Rust 现算。
  - 额外：`load` 时 iframe 仍与父页面同源、却不是初始 `about:blank`（例如 `about:blank#blocked`）记
    `wpe web entry blocked: <href>`，不再当作加载完成。
- **为什么能绕过、还剩什么风险**：读 `third/cef` 源码确认，CEF 对**子 frame** 的 `LoadURL` 并不走 `NavigationController`，
  而是经 mojo 交给该 frame 的渲染端（`CefFrameHostImpl::LoadURLWithExtras` → `LoadRequest` → 渲染端
  `CefFrameImpl::LoadRequest` → `blink_glue::StartNavigation`），用**不带发起文档**的 `FrameLoadRequest` 启动；Blink 只对
  带发起文档的请求做 `CanDisplay`，所以这条检查被跳过。但它仍是渲染进程发起的 `BeginNavigation`：浏览器侧会按该 frame
  当前所在渲染进程（父页面的 http 进程）做 `ChildProcessSecurityPolicy::CanRequestURL` 过滤，若不允许，URL 被改写成
  `about:blank#blocked`（本机没有 Chromium 源码，未能逐行核对）。真机若看到 `wpe web entry blocked: about:blank#blocked`，
  说明这一层生效，只能改 CEF：给子 frame 的 `LoadURL` 加一条走 `NavigationController::LoadURLWithParams`（`frame_tree_node_id`
  指向该子 frame、`is_renderer_initiated = false`）的真正浏览器发起导航，需要新补丁。

**2026-10-29 真机偏差：浏览器进程导航把渲染进程杀掉、整窗刷新循环，改为 CEF 补丁 0005 + 前端赋 `src`。**

- **现象**：按上一段修法真机预览，主窗口的渲染进程被杀，随后整窗 reload，预览重新挂载后再次触发，循环不止。
  推断：子 frame 的 `CefFrame::LoadURL` 在渲染端走 `blink_glue::StartNavigation`，以**无发起
  文档**的请求进入 `BeginNavigation`，浏览器进程 `VerifyBeginNavigationCommonParams` 判为 bad message 并杀掉渲染进程；
  `on_render_process_terminated` 对可见窗口无条件 `reload()`，重新加载后预览再次挂载、再次导航，放大成整窗循环。
  另一层是上一段担心的浏览器侧 `FilterURL`：没有 `file` 请求权的进程发起的 `file:` 导航会被改写成 `about:blank#blocked`。
  两道关（渲染进程 `CanDisplay`、浏览器进程 `FilterURL`）互相独立，都不能靠调用方式绕开。
- **修法**（用户决定不绕过，做正规补丁）：
  - CEF 补丁 `third-patches/cef/0005-app-page-local-resources.patch`（只改 `//cef`）：建窗 `extra_info` 的 bool 键
    `kabegame.allow_local_resources`；渲染侧 `CefRenderManager::MaybeCreateBrowser` 读键存进 `CefBrowserImpl`，
    `CefRenderFrameObserver::DidCommitProvisionalLoad` 在最外层主 frame 每次提交非 `file:` 文档时调
    `blink_glue::GrantLoadLocalResources`（`SecurityOrigin::GrantLoadLocalResources`，只影响 `CanDisplay`，`CanRequest` 不变）；
    浏览器侧 `CefBrowserInfo::MaybeCreateFrame` 对最外层主 frame 的 RFH 所在进程 `GrantRequestScheme(file)`。弹窗 /
    DevTools / OOPIF / fenced frame 不授。补丁只开门，加载哪些文件仍由运行时闸门按根目录裁决。
  - 运行时：`file_access` 的表值改成 `FilePolicy { file_documents, app_local_resources, root }`（两项能力 + 一个闸门，进表即
    开闸门），新增 `allow_app_local_resources(label)` 与 `extra_info_keys(label)`，建窗时按能力循环写键；新增单测
    `extra_info_keys_follow_registration`。
  - 应用：`startup.rs` 主窗口同时 `allow_file_documents("main")` 与 `allow_app_local_resources("main")`；
    `set_wpe_web_preview` 改返回 `Result<Option<String>, String>`——`Some(id)` 设根目录后返回入口 `file://`、不导航，`None`
    清根目录后返回 `None`。
  - 前端：`setWpeWebPreview(imageId): Promise<string | null>`；`createWebFrame` 插入 DOM、挂宿主桥后
    `const entry = await setWpeWebPreview(imageId)`，token 校验、没有入口则 `teardownWeb` 并抛错，然后 `frame.src = entry`。
    8s 超时仍停在初始 `about:blank` 记 `wpe web entry not navigated (CEF patch 0005 missing?)`，否则 `load timeout`；
    `load` 时同源可读的非初始文档仍记 `wpe web entry blocked: <href>`。
- **删除**：运行时 `navigate_frame`（`webview.rs` 与 `lib.rs` 导出）、Rust / 前端两份 `WPE_PREVIEW_FRAME_NAME`
  （`kb-wpe-preview`）与 iframe 的 `name`、前端 `WEB_NAV_KICK_MS` / `webKickTimer` 3s 补发、`set_wpe_web_preview` 里的
  `spawn_blocking(navigate_frame)`。
- **本次不动**：`on_render_process_terminated` 的无条件 `reload()`（触发源已去除，熔断留后续）；`wpe_shim.js` 与 CSP
  `frame-src … file:`。图库图片 / 缩略图走 `file://`、退役本地 HTTP 媒体服务留给后续 0006（`FilePolicy` 届时扩授权集）。
- **验证**：静态检查与单测已过；真机要等用户重编 CEF（`CEFBUILD=D:/Codes/cefbuild deno task build:chromium`）并完全重启
  dev，用例见 `versions/latest/regression.md`「CEF 补丁 0005：应用页加载本地资源」。
