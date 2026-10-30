# Phase 6b — 图库媒体改走 `file://`（CEF 补丁 0006 + 按 frame 分档的运行时闸门）

> 状态：已实现（2026-10-29，补丁 0006 + 点 2–7；check 0 error、单测通过），真机待用户重编 CEF 后按 `versions/latest/regression.md` 6b 小节验证。上级：[PLAN.md](PLAN.md)。依赖 Phase 6a（补丁 0005、`set_wpe_web_preview` 返回入口、前端赋 `src`）。
>
> 起因：0005 落地后实测（2026-10-29），应用页 `<img src="file:…">` 已过渲染侧 `CanDisplay`、请求真的发出，但报
> `ERR_UNKNOWN_URL_SCHEME`——非 `file:` 文档没有 `file:` 的子资源 URLLoaderFactory。用户希望的形态（2026-10-29）：
> **主 frame 完全放开，子 frame 按根目录限制**，运行时用一张按 frame 分档的 handler 表决定挂不挂闸门；图库图片、缩略图、
> 兼容副本直接走 `file://`。三个桌面平台一起开（用户确认）。
>
> 同时收紧插件详情 EJS iframe：去掉 `allow-same-origin`、加内层 CSP 禁止脚本动态请求（`connect-src 'none'`），
> 元素级的远程图片照常显示；本地 HTTP 服务的 `/proxy` 开放代理端点删除（用户确认：伪代码只是示意，目的是限制脚本 fetch，
> 不需要 fetch 代理端点）。
>
> **不做**：
> - 不退役本地 HTTP 媒体服务：`/plugin_file`（kgpg 包内条目、`fetch` 读文本）、Android loopback、应用 Web 服务器 / MCP 的
>   `file_routes_media()`、Web 版下载与桌面复制兜底的 `fetch(url)`、Windows 拖出的 `DownloadURL` 仍走 HTTP；
> - 不改 Android / Web 版的媒体 URL；
> - 不给 CEF 的 `file:` 工厂加 CORS 白名单：应用页 `fetch` / XHR `file:` 继续失败（`kCorsDisabledScheme`），这是有意的；
> - 不改 `on_render_process_terminated` 的无条件 reload；
> - 不把 Windows 拖出改成真实文件拖出。

## 总体设计思路

6a 之后主窗口对 `file:` 的态度是「只有一个根目录，所有 `file:` 请求都按它裁决」。这套规则是为 WPE 网页壁纸设计的：
`file:` 文档只能碰自己目录里的东西。图库媒体要走 `file://` 后，主窗口里会同时出现两类发起方——应用页自己（`<img>` /
`<video>` / CSS `url()`，文件散落在下载目录、同步目录、WPE 创意工坊目录、缩略图与兼容副本目录）和 `file:` 子 frame
（WPE 预览及其嵌套页）。两类的边界完全不同，所以闸门从「按 label 一个根」改成「按发起 frame 分档」：

| 发起方 | 判定依据（`resource_request_handler` 的参数） | 处理 |
| --- | --- | --- |
| 应用页主 frame 的子资源 | `!is_navigation && frame.is_main()`，发起方 origin 与 frame 文档都不是 `file:`，label 登记了 0005 | **不挂闸门**，放行 |
| 子 frame 导航到 `file:`（iframe 赋 `src`） | `is_navigation && !frame.is_main()` | 目标必须在该 label 的根目录内 |
| `file:` 文档自己的子资源（WPE 页 fetch 同目录、嵌套 `keyframes.html`，壁纸窗口整窗 `file:` 时的主 frame） | frame 文档 / 发起方 origin 是 `file:` | 只许根目录内，和现在一样 |
| 主 frame 导航到 `file:` | `is_navigation && frame.is_main()` | 按根目录（壁纸窗口由 Rust 导航，主窗口不会发生） |

关键决策：**不按 frame id 建表**。WPE iframe 从 `about:blank` 导航到 `file:` 时换进程、换 RenderFrameHost，CEF 的 frame
identifier 随之变化；而 frame 自己的文档 origin 天然说明了它属于哪一档。`GetResourceRequestHandler` 的 `request_initiator`
是建工厂时钉死的文档 origin（主 frame 子资源 = 应用页 origin；`file:` 文档 = `file://`；子 frame 导航 = `null`），比
`CefFrame::GetURL()` 的缓存更可靠，两者一起判、任一是 `file:` 就走闸门。

**主 frame 完全放开**是用户决策：应用页是我们自己的代码，CSP 的 `script-src 'self'` / `style-src 'self'` 已经挡住
`<script src=file:>` 与 `<link href=file:>`，剩下的只是显示型元素；0005 / 0006 都不放开 `CanRequest` 与 CORS，`fetch(file:)`
失败、画到 canvas 会被污染，所以放开的是「能显示」而不是「能读到字节」。同源别名（不带 sandbox 或带 `allow-same-origin`
的 `about:blank` / `srcdoc` 子 frame）会继承这项能力，因此本 Phase 顺手把唯一的一个——插件详情 EJS iframe——改成 opaque origin
并加内层 CSP，让它既不继承 `file:` 显示权，也不能发脚本请求。

CEF 补丁 0006 只补缺的那一层：`ChromeContentBrowserClientCef` 覆写 `RegisterNonNetworkSubresourceURLLoaderFactories`，对
「非弹窗、带 `kabegame.allow_local_resources`、最外层主 frame」的文档塞一个 `file:` 工厂。键沿用 0005，语义正好是「应用页可加载本地
资源」；`file:` 文档 content 自己已经塞过，`emplace` 不覆盖。这个工厂会被 Chromium 用 `WillCreateURLLoaderFactory` 包装，也就是
CEF 的 `ProxyURLLoaderFactory`，所以上面那张表在 `OnBeforeResourceLoad` 真能看到主 frame 的 `file:` 子资源（0006 之前它们走默认网络工厂的代理，
放行后才在网络服务里报错）。

前端只换 URL 形态：桌面 CEF 下 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 直接产出 `file:///` URL；Android、Web 不变。
仍需 HTTP 的四条路（下载 / 复制兜底的 `fetch`、Windows 拖出的 `DownloadURL`、`/plugin_file`、Web 服务器）改用显式的
`*ToHttpUrl`，不再复用显示 URL。壁纸窗口的 Vue 页同样显示图片 / 视频，所以也登记 0005（0004 仍只 Windows 且只为 WPE）。

数据流变化：桌面图库每张图从 `http://127.0.0.1:P/thumbnail/<编码路径>`（axum 读文件、整块进内存、手写 Range）变成
`file:///<路径>`（Chromium `FileURLLoader`，原生 Range、不经 TCP）。本地 HTTP 服务保留但只剩非显示用途。

## 现状锚点

**a. CEF 没有覆写子资源工厂注册**（`third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.h:71-86`）
```cpp
  void WillCreateURLLoaderFactory(          // 现状：CEF 只覆写了这个（把每个工厂包成 ProxyURLLoaderFactory）
      content::BrowserContext* browser_context,
      content::RenderFrameHost* frame,
      int render_process_id,
      URLLoaderFactoryType type,
      ...
      override;
  bool HandleExternalProtocol(               // 现状：没有 RegisterNonNetworkSubresourceURLLoaderFactories
```
Chromium 侧只给 `file:` 前驱文档加 `file:` 工厂（`content/browser/renderer_host/render_frame_host_impl.cc:12743`）：
```cpp
    // Only documents from a file precursor scheme can load file subresoruces.
    if (effective_scheme == url::kFileScheme) {
      non_network_factories.emplace(url::kFileScheme, FileURLLoaderFactory::Create(...));
    }
    ...
    GetContentClient()->browser()->RegisterNonNetworkSubresourceURLLoaderFactories(
        GetProcess()->GetDeprecatedID(), routing_id_,
        subresource_loader_factories_config.origin(), &non_network_factories);   // 现状：embedder 挂点
    for (auto& factory : non_network_factories) { /* 逐个经 WillCreateURLLoaderFactory 包装 */ }
```
Chrome 层已覆写（`chrome/browser/chrome_content_browser_client.cc:6549`），加 IWA / `chrome-extension:` / `chrome:` 工厂，CEF 覆写**必须先调父类**。

**b. 0005 的键读法**（`third-patches/cef/0005-app-page-local-resources.patch`，落在 `browser_info.cc` 匿名命名空间）
```cpp
bool AllowsLocalResources(const CefRefPtr<CefDictionaryValue>& extra_info) {   // 现状：只有 browser_info.cc 能用
  if (!extra_info) { return false; }
  const CefString key("kabegame.allow_local_resources");
  return extra_info->HasKey(key) && extra_info->GetType(key) == VTYPE_BOOL && extra_info->GetBool(key);
}
```

**c. 运行时闸门不看 frame**（`src-tauri/tauri-runtime-cef/src/webview.rs:788-818`）
```rust
            fn resource_request_handler(
                &self,
                browser: Option<&mut Browser>,
                _frame: Option<&mut Frame>,            // 现状：丢掉
                request: Option<&mut Request>,
                _is_navigation: ::std::os::raw::c_int, // 现状：丢掉
                is_download: ::std::os::raw::c_int,
                _request_initiator: Option<&CefString>, // 现状：丢掉
                _disable_default_handling: Option<&mut ::std::os::raw::c_int>,
            ) -> Option<ResourceRequestHandler> {
                if is_download != 1 {
                    let is_file_request = request.map(|r| CefString::from(&r.url()).to_string())
                        .is_some_and(|url| crate::file_access::is_file_url(&url));
                    if is_file_request && crate::file_access::is_file_document_webview(&self.label) {
                        return Some(FileDocumentGuardHandler::new(self.label.clone())); // 现状：登记过就一律按根目录
                    }
                    return None;
                }
```
`file_access.rs` 的 `FilePolicy { file_documents, app_local_resources, root }`，`root` 注释是「当前允许的根目录（None = 拒绝所有 file: 请求）」。

**d. 能力只在 Windows 登记，壁纸窗口没有 0005**
```rust
// src-tauri/kabegame/src/startup.rs:170-174
    #[cfg(target_os = "windows")]
    {
        tauri_runtime_cef::allow_file_documents("main");       // 0004
        tauri_runtime_cef::allow_app_local_resources("main");  // 0005   现状：只有 Windows
    }
// src-tauri/kabegame/src/wallpaper/manager/window.rs:64-68
        #[cfg(target_os = "windows")]
        tauri_runtime_cef::allow_file_documents(WALLPAPER_LABEL);   // 现状：壁纸窗口只有 0004
```

**e. 前端媒体 URL 一律走本地 HTTP**（`apps/kabegame/src/utils/fileUrl.ts:30-34, 55-80`）
```ts
function localMediaUrl(endpoint: "file" | "thumbnail" | "compatible", path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${httpServerBaseUrl}/${endpoint}/${encoded.replace(/^\/+/, "")}`;   // 现状：桌面与 Android 都是这个
}
export function fileToUrl(localPath: string): string { /* 绝对 http(s) 透传；否则 localMediaUrl("file", path) */ }
export function thumbnailToUrl(thumbnailPath: string): string { /* localMediaUrl("thumbnail", …) */ }
export function compatibleToUrl(compatiblePath: string): string { /* localMediaUrl("compatible", …) */ }
```
消费方：`ImageContent.vue:336-340`（`sourceOf`）、`ImagePreviewDialog.vue:619-641`、`WallpaperStage.vue:187-213`、`useImageOperations.ts:59-60`（`getImageDownloadUrl`，之后 `fetch(url)`）、`ImageContent.vue:262-269`（拖出 `DownloadURL` 用 `currentSrc`）。

**f. CSP**（`src-tauri/kabegame/tauri.conf.json.handlebars:41`）
```
img-src * data: blob:; media-src * data: blob: ;   // 现状：没有 file:（`*` 不匹配 file:，待实测）
frame-src 'self' blob: data: about: file:;
```

**g. 插件详情 iframe 与应用页同源**（`apps/kabegame/src/components/common/ImagePluginDescriptionPanel.vue:48-54, 382-400`）
```vue
      <iframe
        ref="descriptionIframeRef"
        class="description-iframe"
        :srcdoc="descriptionSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"  <!-- 现状：同源，可碰 parent、继承 CanDisplay(file:) -->
        referrerpolicy="no-referrer"
      />
```
```ts
    body = body.replace(/<script(?![^>]*\bnonce[=\s])/gi, `<script nonce="${EJS_BRIDGE_NONCE}"`);
    const theme = buildDescriptionIframeThemeStyles();
    return `${theme}<script nonce="${EJS_BRIDGE_NONCE}">${DESCRIPTION_BRIDGE_INJECT_SCRIPT}<\/script>${body}`;  // 现状：没有内层 CSP
```
父页只校验 `event.source === iframeWin`，两侧 `postMessage` 的 `targetOrigin` 都是 `"*"`；桥的 `getLocale` / `getPluginData` / `getCache` / `setCache` / `openUrl` / `fetch`（经 `proxy_fetch` 返回 `{ base64, contentType }`）全部走 `postMessage`。28 个模板里 14 个直接写远程 `<img src="https://…">`，zerochan 的 CSS 用远程背景图，没有模板裸用 `fetch` / XHR / `<link>` / `@font-face` / 嵌套 iframe。

**h. `/proxy` 开放代理**（`src-tauri/kabegame/src/http_server.rs:51-53, 325-399, 409, 448, 455`；`apps/kabegame/vite.config.ts:18`）
```rust
struct ProxyQuery { url: String }
/// 代理 GET 请求：/proxy?url=xxx，用 reqwest 拉取目标 URL 后流式返回（初步实现，无任务上下文）
async fn handle_proxy_query(Query(query): Query<ProxyQuery>) -> Response { /* 任意 http/https GET */ }
        .route("/proxy", get(handle_proxy_query))   // 现状：file_routes / file_routes_web（debug 与 release）三处挂载；前端无任何引用
```

## 点 1 — CEF 补丁 0006：应用页的 `file:` 子资源工厂（`third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.{h,cc}`）

- **新增**
  - `.h`：在 `WillCreateURLLoaderFactory` 声明前加覆写声明。
  - `.cc`：include、匿名命名空间里的键判断（与 0005 同一字面量，复制一份，不改 `browser_info.cc`，两个补丁互不依赖）、覆写实现。
  > 判断条件与 0005 浏览器侧对齐：`RenderFrameHost::FromID` 取不到（worker / service worker 传 `kRoutingIdNone`）直接返回；
  > `GetParentOrOuterDocument() != nullptr`（子 frame、fenced frame）返回；`CefBrowserHostBase::GetBrowserForHost(rfh)` 取 browser，
  > 弹窗或无键返回。不判断文档 scheme：`file:` 文档 content 已经 `emplace` 过 `file` 键，再 `emplace` 是 no-op。
  > 不用 `IsInPrimaryMainFrame`：提交中的 RFH 可能还是 speculative。

```cpp
// chrome_content_browser_client_cef.h —— 新增，放在 WillCreateURLLoaderFactory 之前
  // Kabegame: adds a file: URLLoaderFactory for subresources of the app page
  // (outermost main frame, non-popup browser created with the bool extra_info
  // key "kabegame.allow_local_resources"). See the .cc for details.
  void RegisterNonNetworkSubresourceURLLoaderFactories(
      int render_process_id,
      int render_frame_id,
      const std::optional<url::Origin>& request_initiator_origin,
      NonNetworkURLLoaderFactoryMap* factories) override;
```

```cpp
// chrome_content_browser_client_cef.cc —— include 按字母序插入
#include "content/public/browser/browser_context.h"          // 新增
#include "content/public/browser/file_url_loader.h"          // 新增
#include "content/public/browser/render_frame_host.h"        // 新增
#include "url/url_constants.h"                               // 新增

namespace {                                                  // 文件里若已有匿名命名空间就并入
// Kabegame: same key as CefBrowserInfo::MaybeCreateFrame (patch 0005) and
// CefRenderManager::MaybeCreateBrowser; the name must match.
bool AllowsLocalResources(const CefRefPtr<CefDictionaryValue>& extra_info) {
  if (!extra_info) {
    return false;
  }
  const CefString key("kabegame.allow_local_resources");
  return extra_info->HasKey(key) && extra_info->GetType(key) == VTYPE_BOOL &&
         extra_info->GetBool(key);
}
}  // namespace

// 新增：放在 WillCreateURLLoaderFactory 定义之前
void ChromeContentBrowserClientCef::
    RegisterNonNetworkSubresourceURLLoaderFactories(
        int render_process_id,
        int render_frame_id,
        const std::optional<url::Origin>& request_initiator_origin,
        NonNetworkURLLoaderFactoryMap* factories) {
  // Chrome registers IWA / chrome-extension: / chrome: factories here.
  ChromeContentBrowserClient::RegisterNonNetworkSubresourceURLLoaderFactories(
      render_process_id, render_frame_id, request_initiator_origin, factories);

  // Kabegame: patch 0005 lets the app page pass SecurityOrigin::CanDisplay()
  // and FilterURL for file: URLs, but content only hands a file: subresource
  // factory to documents with a file: precursor scheme
  // (RenderFrameHostImpl::CommitNavigation), so <img src="file:..."> in an
  // http(s) / custom-scheme page still fails with ERR_UNKNOWN_URL_SCHEME. Add
  // the factory for the outermost main frame of a non-popup browser created
  // with "kabegame.allow_local_resources". emplace() is a no-op for file:
  // documents, which already have one. The factory is wrapped by
  // WillCreateURLLoaderFactory like every other non-network factory, so the
  // client's OnBeforeResourceLoad still sees (and may cancel) each request.
  // CORS-mode requests (fetch / XHR, crossorigin elements, fonts) are still
  // rejected by FileURLLoaderFactory for non-file initiators; that is intended.
  content::RenderFrameHost* rfh =
      content::RenderFrameHost::FromID(render_process_id, render_frame_id);
  if (!rfh || rfh->GetParentOrOuterDocument() != nullptr) {
    return;  // workers / service workers (no frame), subframes, fenced frames
  }
  auto browser = CefBrowserHostBase::GetBrowserForHost(rfh);
  if (!browser || browser->browser_info()->is_popup() ||
      !AllowsLocalResources(browser->browser_info()->extra_info())) {
    return;
  }
  content::BrowserContext* browser_context = rfh->GetBrowserContext();
  factories->emplace(
      url::kFileScheme,
      content::CreateFileURLLoaderFactory(
          browser_context->GetPath(),
          browser_context->GetSharedCorsOriginAccessList()));
}
```

- **新增** `third-patches/cef/0006-app-page-file-subresources.patch`，生成步骤与 0005 相同：`deno task patch cef`（确认 0001–0005 干净）→ `git -C third/cef add -A` → 改两个文件 → `git -C third/cef diff --full-index` 写成补丁 → `git -C third/cef reset` → `deno task patch cef --check` → `deno task patch cef`。只改 `//cef`，无 C API / 胶水 / `patch.cfg` 变化。0004 也改 `chrome_content_browser_client_cef.cc`，hunk 不重叠。
- **修改** `third-patches/cef/README.md`，0005 条目后追加：

```md
- `0006-app-page-file-subresources.patch` — completes 0005 for subresources. Patch 0005 lets the app page pass `CanDisplay` and `FilterURL`, but `RenderFrameHostImpl::CommitNavigation` only hands a `file:` subresource URLLoaderFactory to documents with a `file:` precursor scheme, so `<img src="file:...">` in an `http(s)` / custom-scheme page still ends in `ERR_UNKNOWN_URL_SCHEME`. `ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories` (new override, parent called first so Chrome's IWA / extension factories stay) adds `content::CreateFileURLLoaderFactory` for the outermost main frame of a non-popup browser created with the same bool `extra_info` key `kabegame.allow_local_resources`; `emplace` is a no-op for `file:` documents. The factory is wrapped by `WillCreateURLLoaderFactory` like any other, so the client's `OnBeforeResourceLoad` still sees every request — Kabegame lets the app page's own subresources through and confines `file:` frames to their directory there. CORS-mode `file:` requests from a non-`file:` initiator (`fetch` / XHR, `crossorigin` elements, `@font-face`) are still rejected by `FileURLLoaderFactory` (`kCorsDisabledScheme`); the shared CORS origin access list is left empty on purpose. Known side effect: a main-frame-initiated `file:` download also gets this factory. `//cef` only; no public API, C API or `libcef_dll` glue changes.
```

## 点 2 — 运行时：按 frame 分档的闸门（`src-tauri/tauri-runtime-cef/src/`）

- **修改** `file_access.rs`
  - `FilePolicy.root` 注释改为「子 frame 与 `file:` 文档的根目录（`None` = 这类请求全拒）」。
  - 新增 `app_page_open(label) -> bool`：label 登记了 0005（`app_local_resources`）。
  - 模块注释改成三档表（主 frame 应用页放行 / 子 frame 导航按根 / `file:` 文档按根）。
  - 新增单测 `app_page_open_follows_registration`。
- **修改** `webview.rs` 的 `resource_request_handler`：用上 `frame`、`is_navigation`、`request_initiator`。
- **修改** `lib.rs` 分节注释：`allow_app_local_resources` 的文档补「同时表示该 label 的应用页子资源不过目录闸门（0006）」。

```rust
// file_access.rs —— 新增
/// label 的应用页（最外层主 frame 的非 `file:` 文档）发起的 `file:` 子资源是否免检：登记了 0005 即免检。
/// 子 frame 导航与 `file:` 文档的请求不受此影响，仍按根目录裁决。
pub(crate) fn app_page_open(webview_label: &str) -> bool {
    policies()
        .lock()
        .map(|map| map.get(webview_label).is_some_and(|policy| policy.app_local_resources))
        .unwrap_or(false)
}
```

```rust
// webview.rs —— 替换 resource_request_handler 的非下载分支
            fn resource_request_handler(
                &self,
                browser: Option<&mut Browser>,
                frame: Option<&mut Frame>,                         // 修改：用上
                request: Option<&mut Request>,
                is_navigation: ::std::os::raw::c_int,              // 修改：用上
                is_download: ::std::os::raw::c_int,
                request_initiator: Option<&CefString>,             // 修改：用上
                _disable_default_handling: Option<&mut ::std::os::raw::c_int>,
            ) -> Option<ResourceRequestHandler> {
                if is_download != 1 {
                    let is_file_request = request
                        .map(|request| CefString::from(&request.url()).to_string())
                        .is_some_and(|url| crate::file_access::is_file_url(&url));
                    if !is_file_request || !crate::file_access::is_file_document_webview(&self.label) {
                        return None;
                    }
                    // 按发起 frame 分档（见 file_access 模块注释）：
                    // - 应用页主 frame 的子资源：登记了 0005 的 label 免检（图库媒体走 file://）；
                    // - 子 frame 的导航、file: 文档（含壁纸窗口整窗 file: 时的主 frame）的子资源：按根目录。
                    // 发起方 origin 是建工厂时钉死的文档 origin（子 frame 导航为 "null"），比 frame.url() 的
                    // 缓存可靠；两者任一是 file: 就走闸门。
                    let frame_is_main = frame.as_ref().is_some_and(|f| f.is_main() == 1);
                    let frame_url = frame.map(|f| CefString::from(&f.url()).to_string()).unwrap_or_default();
                    let initiator = request_initiator.map(|s| s.to_string()).unwrap_or_default();
                    let app_page_subresource = is_navigation == 0
                        && frame_is_main
                        && !initiator.is_empty()
                        && initiator != "null"
                        && !crate::file_access::is_file_url(&initiator)
                        && !crate::file_access::is_file_url(&frame_url);
                    if app_page_subresource && crate::file_access::app_page_open(&self.label) {
                        return None;                               // 新增：主 frame 完全放开
                    }
                    return Some(FileDocumentGuardHandler::new(self.label.clone()));
                }
                // …下载分支不变
```
> `FileDocumentGuardHandler` 不改。`is_main()` / `url()` 的 cef-rs 签名以绑定为准（`ImplFrame`，`is_main` 返回 `c_int`）。

## 点 3 — 应用后端：三个桌面平台都登记 0005，壁纸窗口也登记（`src-tauri/kabegame/src/`）

- **修改** `startup.rs:163-174`：0004 仍 `cfg(target_os = "windows")`（WPE 预览只有 Windows）；0005 改为所有桌面平台（沿用文件里其它 `tauri_runtime_cef::` 调用的 cfg 写法，实施时 `grep -n tauri_runtime_cef startup.rs` 对齐）。注释改成「图库媒体与 WPE 预览」两个用途。
- **修改** `wallpaper/manager/window.rs:64-68`：壁纸窗口追加 `allow_app_local_resources(WALLPAPER_LABEL)`（所有桌面平台；壁纸窗口的 Vue 页同样用 `<img>` / `<video>` 显示图库媒体）。0004 不变。
- `commands/wpe_web.rs`、`wallpaper/window.rs` 不改：根目录语义（子 frame / `file:` 文档）与现在一致。

```rust
// startup.rs
    // 主窗口的两类本地文件用途，都由 CEF 补丁按 browser 开启、运行时按发起 frame 分档拦截：
    // - 图库媒体走 file://（补丁 0005 + 0006）：应用页主 frame 的 <img> / <video> 子资源免检，三个桌面平台都开；
    // - WPE 网页壁纸预览（补丁 0004 + 0005，只有 Windows）：file: iframe 及其子资源按 set_wpe_web_preview 设的根目录拦截。
    #[cfg(not(target_os = "android"))]                   // 修改：所有桌面平台（以文件既有 cfg 写法为准）
    tauri_runtime_cef::allow_app_local_resources("main");
    #[cfg(target_os = "windows")]
    tauri_runtime_cef::allow_file_documents("main");
```

## 点 4 — 前端：桌面媒体 URL 改 `file://`，保留 HTTP 的路径显式化（`apps/kabegame/src/`）

- **新增** `utils/fileUrl.ts`
  - `pathToFileUrl(path)`：`\\?\` 前缀去掉（已有 `normalizeDesktopPath` 的调用方负责，这里再兜一次）；Windows `C:\a\b` → `file:///C:/a/b`，UNC `\\server\share\x` → `file://server/share/x`；POSIX `/a/b` → `file:///a/b`；按段 `encodeURIComponent`、`/` 保留；已是 `file:` 原样返回。
  - `fileToHttpUrl` / `thumbnailToHttpUrl` / `compatibleToHttpUrl`：原来的 `localMediaUrl` 三个出口，供必须 `fetch` 或要交给外部的场景。
  - `const DESKTOP_FILE_MEDIA = !IS_WEB && !IS_ANDROID`。
- **修改** `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl`：`DESKTOP_FILE_MEDIA` 时返回 `pathToFileUrl(path)`，否则沿用 HTTP。`initHttpServerBaseUrl` 仍要在启动时调（`/plugin_file` 与 HTTP 出口）。
- **修改** `utils/fileUrl.test.ts`：桌面用例改成 `file:///` 断言（含 `C:\`、UNC、百分号、中文），HTTP 断言迁到 `*ToHttpUrl`；按现有 mock `IS_WEB` / `IS_ANDROID` 的方式补桌面 / Android 两套。
- **修改** `composables/useImageOperations.ts:59-60, 199`：`getImageDownloadUrl` 与复制兜底改用 `*ToHttpUrl`（这两处之后 `fetch(url)`，应用页 `fetch(file:)` 必失败）。
- **修改** `components/image/ImageContent.vue:262-269`（Windows 拖出）：不再用 `currentSrc`；按当前显示的源（`sourceOf` 的 tag：`local` / `comp` / `thumb`）用对应的 `*ToHttpUrl` 生成 `DownloadURL` / `text/uri-list` / `text/plain`。`PrepareDragForDownload` 是否接受 `file:` 未核实，保持 HTTP 不冒险。文件名仍取 `fileNameFromUrlOrPath`。
- **修改** `tauri.conf.json.handlebars:41` CSP：`img-src * data: blob: file:`、`media-src * data: blob: file:`（`*` 不匹配 `file:`，显式加）。
- 不改：`ImageContent.vue` 的 `sourceOf` / 回退链、`ImagePreviewDialog.vue`、`WallpaperStage.vue` 的 `getImageUrl` / `getVideoUrl`（它们经三个 `*ToUrl` 自动变成 `file:`）、`PluginDocRenderer` / `assetPath.ts` / `pluginFiles.ts`（`/plugin_file`）。

```ts
// utils/fileUrl.ts —— 新增
const DESKTOP_FILE_MEDIA = !IS_WEB && !IS_ANDROID;

/** 本地绝对路径 → `file://` URL：Windows 盘符与 UNC、POSIX 都处理；逐段编码、`/` 保留；已是 `file:` 原样返回。 */
export function pathToFileUrl(localPath: string): string {
  let path = (localPath || "").trim().replace(/^\\\\\?\\/, "");
  if (!path) return "";
  if (/^file:/i.test(path)) return path;
  const encode = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const unc = path.match(/^\\\\([^\\]+)\\(.*)$/);           // \\server\share\x
  if (unc) return `file://${unc[1]}/${encode(unc[2].replace(/\\/g, "/"))}`;
  path = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(path)) return `file:///${path[0]}:${encode(path.slice(2))}`;   // C:/a/b
  return `file://${encode(path)}`;                            // POSIX：/a/b → file:///a/b
}

export function fileToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (DESKTOP_FILE_MEDIA) return pathToFileUrl(path);         // 修改：桌面 CEF 直接 file://
  if (httpServerBaseUrl === null) return "";
  return localMediaUrl("file", path);
}
// thumbnailToUrl / compatibleToUrl 同样加一行；新增 fileToHttpUrl / thumbnailToHttpUrl / compatibleToHttpUrl = 原 HTTP 逻辑
```

## 点 5 — 插件详情 iframe：opaque origin + 内层 CSP（`apps/kabegame/src/components/common/ImagePluginDescriptionPanel.vue`）

- **修改** `sandbox`：去掉 `allow-same-origin`，保留 `allow-scripts allow-popups allow-popups-to-escape-sandbox`（24 个模板有 `target=_blank` / `window.open`，桥的 `openUrl` 兜底也在）。
- **修改** `descriptionSrcdoc`：最前面加内层 CSP meta（与父页策略取交集，父页的 nonce 要求仍在，所以 `<script>` 注入 nonce 的逻辑保留）：
  `default-src 'none'; script-src 'unsafe-inline' 'nonce-kabegame-ejs-bridge'; style-src 'unsafe-inline'; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src data:; connect-src 'none'; frame-src about:; form-action 'none'; base-uri 'none'`
  > 用户意图：限制脚本动态请求，不是禁止元素级远程图片。`connect-src 'none'` 关掉 `fetch` / XHR / WebSocket / beacon；
  > `frame-src about:` 只放嵌套的 `srcdoc` / `about:blank` 子 frame（`kabegame-server` 插件的模板把来源页面快照放进
  > `sandbox=""` 的 srcdoc iframe，与宿主做法一致，用户确认要保留；应用页自己的 CSP 也是用 `about:` 放这类 frame），
  > `file:` / http(s) frame 仍被拒；opaque origin 后 `window.parent.document` 为 `SecurityError`，也不再继承应用页的
  > `CanDisplay(file:)`，嵌套 srcdoc 同样是 opaque、无可继承。模板的远程 `<img>`、zerochan 的 CSS 背景图照常；
  > `__bridge.fetch` → `proxy_fetch` 走 `postMessage`，不受 CSP 影响；`blob:` 由同一文档创建，`img-src blob:` 放行。
- 页面快照 iframe（`sandbox=""` + `PAGE_SNAPSHOT_CSP`）不动。
- **修改** 文档 `cocs/plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`：展示一节改成「opaque origin + 内层 CSP」，写明模板不能裸 `fetch`、要经 `__bridge.fetch`；安全面一段更新。`apps/docs` 里若有插件模板页（`grep -rn "allow-same-origin\|__bridge" apps/docs/src`）同步一句。

```ts
// ImagePluginDescriptionPanel.vue —— 新增
/** 详情 iframe 的内层 CSP：禁止脚本动态请求与嵌套 frame，元素级远程图片照常；与父页策略取交集，脚本仍需 nonce */
const DESCRIPTION_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'nonce-kabegame-ejs-bridge'; style-src 'unsafe-inline'; " +
  "img-src https: http: data: blob:; media-src https: http: data: blob:; font-src data:; " +
  "connect-src 'none'; frame-src about:; form-action 'none'; base-uri 'none'";
// descriptionSrcdoc 返回值改为：
    return `<meta http-equiv="Content-Security-Policy" content="${DESCRIPTION_CSP}">${theme}<script nonce="${EJS_BRIDGE_NONCE}">${DESCRIPTION_BRIDGE_INJECT_SCRIPT}<\/script>${body}`;
```
```vue
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"   <!-- 修改：去掉 allow-same-origin -->
```

## 点 6 — 删除 `/proxy` 开放代理（`src-tauri/kabegame/src/http_server.rs`、`apps/kabegame/vite.config.ts`）

- **删除** `ProxyQuery`、`handle_proxy_query`、三处 `.route("/proxy", …)`（`file_routes`、两个 `file_routes_web`）；随之不再使用的 import（`Query`、`Uri`、`reqwest` 相关）一并清掉。`file_routes_media` 的注释「不包含 `/proxy`」改掉。
- **删除** `vite.config.ts` `webDevApiProxyPaths` 里的 `"/proxy"`。
- **修改** 提到 `/proxy` 的文档：`cocs/mcp/MCP_SERVER.md`、`cocs/web/CDN_MEDIA.md`、`http_server.rs` 模块注释（`grep -rn '/proxy' cocs src-tauri apps scripts`）。
- 前端与插件模板都没有引用它；Web release 的 `file_routes_web` 删掉后只剩 `/plugin_file`。

## 点 7 — 文档 / 回归 / changelog

- `AGENTS.md`：WPE 那条括号里追加「图库媒体在桌面 CEF 直接走 `file://`（补丁 0006 + 应用页主 frame 免检），子 frame 与 `file:` 文档仍按根目录」。
- `cocs/README.md`：`third-patches/cef/README.md` 条目改「六个 patch」并加 0006 一句；WPE 条目同步；`tauri-runtime-cef/README.md` 条目加「按 frame 分档」。
- `cocs/wpe/WPE_IMPORT.md`：闸门一节改成三档表；`src-tauri/tauri-runtime-cef/README.md`：文件访问一节同上。
- `cocs/web/CDN_MEDIA.md`：桌面端一行改「桌面 CEF 走 `file://`，`/file` 等 HTTP 路由只剩非显示用途」。
- `cocs/plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`：见点 5。
- `.claude/plans/wpe-import/2-web/PLAN.md`：阶段表加 Phase 6b 行、状态行、文档列表。
- `versions/latest/regression.md`：新增小节「Phase 6b：图库媒体走 file:// / 补丁 0006 / 插件 iframe 收紧」，用例见下；Linux / macOS 行标「待测」。
- `versions/latest/changelog.md`：一条用户可见（桌面图库媒体改由浏览器直接读本地文件、不再经本地 HTTP；插件详情页更严格的隔离），一条内部（CEF 补丁 0006、`/proxy` 删除）。

## 验证

**A. 静态**
1. `deno task patch cef --check` → `deno task patch cef`：`git -C third/cef status` 只多出 `chrome_content_browser_client_cef.{h,cc}`。
2. `check-kabegame`（`CARGO_TARGET_DIR=D:/Codes/kabegame/target-check`）0 error。
3. 单测：`file_access`（新增 `app_page_open_follows_registration`）；前端 `deno task test`（vitest）里 `fileUrl.test.ts`。
4. `grep -rn "/proxy\|handle_proxy_query\|ProxyQuery" apps src-tauri scripts cocs` 只剩历史说明。

**B. 真机（Windows；用户重编 CEF 后完全重启 dev；Linux / macOS 待测）**
1. 画廊网格：缩略图加载，CDP `Network` 里请求是 `file:///…/thumbnails/<uuid>.jpg` 且 200；stderr 没有 `deny file:`。
2. 预览原图 / PhotoSwipe：`file:///<下载目录>/…` 200；视频原图播放并拖动进度条（Range 由 `FileURLLoader` 原生处理）；WPE 视频行 `compatible_path`（创意工坊目录内）正常播放。
3. 壁纸窗口：图片 / 视频壁纸经 `file://` 显示；平铺模式 CSS 背景图正常。
4. WPE 预览 iframe 仍受限：`fetch('../796697921/project.json')`、`<img src="file:///C:/Windows/…">` 在 iframe 内被 `deny file:`；入口与同目录子资源照常（6a / 0005 用例 1–4 复跑）。
5. 应用页主 frame 放开：顶层 `<img src="file:///D:/Codes/kabegame/docs/images/icon.png">` 能显示（预览未打开也行）；顶层 `fetch(file:)` 仍失败（CORS）；把它画到 canvas 后 `toBlob` 抛 `SecurityError`（污染）。
6. 插件详情 iframe：pixiv / bilibili 详情配图照常；在 iframe 里 `fetch("https://example.com")` 被 CSP 拒；`window.parent.document` 与 `window.parent.__TAURI_INTERNALS__` 为 `SecurityError`；插一个 `<iframe src="file:///…">` 被 CSP `frame-src` 拒（即便绕过 CSP，opaque origin 也过不了 `CanDisplay`）；`__bridge.fetch` 仍工作（pixiv 模板的 blob 图显示）；外链点击仍能打开；`kabegame-server` 插件对畅游 / 网页收集来源的快照（嵌套 `sandbox=""` srcdoc iframe）照常显示。
7. Windows 拖出到资源管理器：仍得到文件（`DownloadURL` 为 `http://127.0.0.1:P/…`）。
8. 复制图片到剪贴板（桌面走后端命令）正常；本地文件夹同步画册、WPE 创意工坊目录里的图各显示一张。
9. `/proxy`：`curl http://127.0.0.1:<port>/proxy?url=https://example.com` 404。
10. 稳定性：`probe-observe.mjs <port> 60` 期间翻页 / 开关预览，无 `[CRASH]`、无整窗 reload。
11. 可选对比：同一页 500 张缩略图在 HTTP 与 `file://` 下的首屏加载时间（CDP `Performance` 或肉眼），记进回归备注。

## 风险与备注

- **CSP `*` 是否匹配 `file:`**：推断不匹配，显式加 `file:` 后无论哪种都成立。
- **`frame.url()` 为空**：新建 OOPIF 的 `CefFrameHostImpl` 刚构造时 `url_` 为空，但那时 `is_main()` 为 false，仍走闸门；主 frame 子资源在提交后才发，`url_` 已刷新。`request_initiator` 是主判据。
- **壁纸窗口整窗 `file:` 时**：主 frame 的 initiator 是 `file://`，自动落到闸门档；切回应用页后 initiator 变回应用 origin，媒体免检。
- **0006 的工厂只被文档子资源用到**（2026-10-29 实施时核对源码更正）：`DownloadManagerImpl` 对 `file:` 先自建 content 自带的工厂（`download_manager_impl.cc:1452`）才调钩子，DevTools `NetworkHandler` 对 `file:` 跳过钩子，worker / service worker 传 `kRoutingIdNone` 取不到 RFH；原先写的「主 frame 发起的 `file:` 下载也能拿到工厂」不成立。
- **Linux / macOS**：`pathToFileUrl` 的 POSIX 分支与 `file_access` 的路径比较键在 CI 单测覆盖，真机留待下次上机；`startup.rs` 的 cfg 以文件既有写法为准。
- **插件模板**：没有模板受 `connect-src 'none'` 影响（调研：无裸 `fetch` / XHR）；`base-uri 'none'` 不影响 `document.baseURI` 继承父页（srcdoc 规则），实施时真机确认 `__bridge` 的相对 href 解析仍正常。
- **以后收紧 `img-src` 到 `data: blob:`**：要先把 14 个模板的远程 `<img>` 改经 `__bridge.fetch`，属插件仓库任务，不在本 Phase。
