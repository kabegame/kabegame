# Phase 6c — 桌面完全摆脱本地 HTTP 服务：`fetch(file:)` 放开、插件文件走 Tauri 命令

> 状态：代码与文档已实施（2026-10-30），待 CEF 补丁管理器重放与真机验证。上级：[PLAN.md](PLAN.md)。**依赖 Phase 6b 落地**（补丁 06、按 frame 分档的闸门、
> `*ToHttpUrl` 出口、插件 iframe 收紧、`/proxy` 删除）——本 Phase 以 6b 之后的代码为基线，并修订 6b 的两处产物（06 的
> CORS 列表参数、前端 `*ToHttpUrl` 出口）。
>
> 起因（用户，2026-10-29）：桌面 standard 版（Windows / macOS / Linux，CEF）**完全不再启动本地 HTTP 服务**，应用页允许
> `fetch(file://…)` 动态读本地文件。调研结论（见「现状锚点」）：放开 `fetch(file:)` 不需要第三个 CEF 补丁，只需修订 06 的
> CORS 列表并在运行时登记一条 CEF 跨源白名单；本地 HTTP 剩余的三个用途（`/plugin_file`、复制兜底的 `fetch`、Windows 拖出的
> `DownloadURL`）分别改走 Tauri 命令（IPC 原始字节 + 前端 blob URL，不加新 scheme）、`fetch(file:)`、`file://` URL。
>
> **不动**：Android（Kotlin loopback + Rust `/plugin_file` 转发）、Web 版（`file_routes_web`、CDN）、桌面应用 Web 服务器
> （`web_server_service.rs` 的 `file_routes_media()`，供 MCP / 外部客户端）。
>
> **不做**：Windows 真实文件拖出（把补丁 03 的 aura 段扩到 Windows）——先验证 `DownloadURL` 直接带 `file://` 能否成立，不行再
> 单独立项（本文末「备选」）。顺带关闭无人使用、却对所有 webview 开放 `**` 的 Tauri asset 协议（点 4b）。

## 总体设计思路

6b 之后桌面图库的显示型加载已经走 `file://`，本地 HTTP 只剩三样东西还在用：插件包内文件（`/plugin_file`）、复制到剪贴板的
兜底 `fetch`、Windows 拖出写进 `DownloadURL` 的地址。本 Phase 把这三样各自换掉，然后把 `start_http_server` 整个删掉。

**`fetch(file:)` 怎么放开。** 渲染进程这一侧其实已经通了：CEF Chrome runtime 的 extensions `Dispatcher` 无条件把 `file` 注册为
支持 Fetch API 的 scheme，`fetch()` 走 `PerformHTTPFetch`、mode 保持 `cors`；05 又放开了 `CanDisplay`。真机报的
`Cross origin requests are only supported for protocol schemes` 来自浏览器侧。06 之后请求会先后过两道门：
1. CEF `ProxyURLLoaderFactory` 在 `Restart` 里对跨源、非 no-cors、非 CORS-enabled scheme 的请求查 CEF 自己的跨源白名单，
   没有就直接报 `kCorsDisabledScheme`——连 `OnBeforeResourceLoad` 都到不了。运行时在建主窗口时登记
   `CefAddCrossOriginWhitelistEntry(<应用 origin>, "file", "", allow_subdomains=true)`（空 host + 允许子域 = 任意 host，`file:///`
   与 UNC 都匹配）。
2. `FileURLLoaderFactory` 自己判 CORS：initiator 不是 `file` 同源时查它持有的 `SharedCorsOriginAccessList`；传 `nullptr` 不放行
   （且 debug 构建 DCHECK），profile 的共享列表 CEF 从不写入、也不放行。所以 06 改为给这个工厂实例 `Create()` 一份**私有**
   列表，只登记「该 frame 的 origin → `file` scheme 任意 host」，不碰 profile 共享列表、不扩散到网络服务。
两道都过后 `response_type = kBasic`，`Response.type` 为 `"basic"`，body 可读；XHR 同理。副作用只有一个：跨源白名单按 origin
全局生效，应用 origin 在任何渲染进程里的 `CanDisplay(file:)` 都为真——但只有带 05 / 06 的 browser 有 `file` 工厂与请求权，
别处拿不到字节；应用 origin 只属于我们自己的页面。生产 CSP 的 `connect-src` 必须显式加 `file:`（`*` 不匹配 `file:`；dev 桌面
没有 Tauri 注入的 CSP，容易漏测）。

**插件文件走 Tauri 命令，不加新 scheme**（用户指定，2026-10-30）。新增命令 `read_plugin_file` 返回 `tauri::ipc::Response`
原始字节（CEF runtime 的主 IPC 通道是 `fetch(ipc://localhost/<cmd>)`，raw 二进制响应原生支持，`invoke` 在前端拿到
`ArrayBuffer`，不经 base64）；MIME 由前端按扩展名推（后端 `mime_for_plugin_file` 本来也只看扩展名）。前端把字节包成 `blob:` URL
给 `<img>`，解成文本给文档 / 模板；缓存按（插件 id、版本、来源、路径）键，插件版本变化或删除时一并 `revokeObjectURL`。
好处：不碰运行时 scheme 列表与 CSP（`img-src` 已有 `blob:`），label 门禁由 Tauri ACL 现成提供（命令只在 `main` capability 里，
surf / crawler 窗口根本调不到），不需要 CORS 头。代价：`pluginFileUrl` 从同步变成异步，文档渲染与 banner 走马灯的三个消费点要
改成先取 URL 再渲染。读取逻辑从 axum handler 抽成核心层纯函数，axum（Android / Web）与命令共用。

**拖出与复制。** 6b 为了保 HTTP 做的 `*ToHttpUrl` 出口在本 Phase 撤回：复制兜底直接 `fetch(fileToUrl(...))`（现在能读字节）；
Windows 拖出回到用媒体元素的 `currentSrc`（已是 `file://`）写 `DownloadURL`——`PrepareDragForDownload` → `DragDownloadFile` →
`DownloadManager::DownloadUrl` 会按发起 frame 调 `RegisterNonNetworkSubresourceURLLoaderFactories`，06 的工厂对主 frame 同样
生效，下载是 no-cors、不受 CORS 列表影响。这一条只有真机能证实，失败的备选是把补丁 03 扩到 Windows（文末）。

**删 HTTP 服务。** `start_http_server` 只在 `lib.rs` 一处启动、挂的是 `file_routes()`；`file_routes_media()`（Web 服务器）与
`file_routes_web()`（Web 版）都不依赖它。删掉 `start_http_server` / `HTTP_SERVER_PORT` / `file_routes` / 桌面版
`get_http_server_base_url`（Android 版保留），`plugin_file_routes` 收窄到 `web` / Android 编译。前端 `initHttpServerBaseUrl`
桌面不再 invoke。

数据流变化：桌面进程不再监听任何 127.0.0.1 端口（应用 Web 服务器仍由用户手动开启）；插件文件从「HTTP + ETag/304」变成
「命令读 zip 条目 + 前端按坐标缓存 blob / 文本」；复制 / 拖出不再经过 TCP。

## 现状锚点

**a. 渲染进程里 `file` 已是 fetch-API scheme**（`extensions/renderer/dispatcher.cc:324-330`；CEF 经 `chrome_content_renderer_client_cef.cc:31-32` → `ChromeContentRendererClient::RenderThreadStarted` 到达）
```cpp
  // Register WebSecurityPolicy allowlists for the file:// scheme.
  WebString file_scheme(WebString::FromAscii(url::kFileScheme));
  WebSecurityPolicy::RegisterURLSchemeAsSupportingFetchAPI(file_scheme);   // 现状：fetch(file:) 在渲染侧不卡 scheme
```

**b. CEF proxy 的 CORS 闸**（`third/cef/libcef/browser/net_service/proxy_url_loader_factory.cc:502-524`，在 `OnBeforeResourceLoad` 之前）
```cpp
  const bool is_cross_origin = request_.request_initiator && !request_.request_initiator->IsSameOriginWith(request_.url);
  const bool is_cors_enabled_scheme = scheme::IsCorsEnabledScheme(request_.url.scheme());
  bool should_check_cors = is_cross_origin && request_.mode != kNavigate && request_.mode != kNoCors;
  if (should_check_cors && !is_cors_enabled_scheme &&
      !HasCrossOriginWhitelistEntry(*request_.request_initiator, url::Origin::Create(request_.url))) {   // 现状：file 不在 CORS-enabled 列表，没白名单就拒
    SendErrorStatusAndCompleteImmediately(... kCorsDisabledScheme ...);
```
白名单 API：`CefAddCrossOriginWhitelistEntry(source_origin, target_protocol, target_domain, allow_target_subdomains)`，任意线程可调（非 UI 线程时 post 过去），对 `target_protocol = "file"` 无限制（头文件里「不能绕过 local scheme」的注释已过时，代码无此检查）；cef-rs：`cef::add_cross_origin_whitelist_entry(Option<&CefString>, Option<&CefString>, Option<&CefString>, c_int) -> c_int`。渲染侧经 `render_manager.cc:195-212` 调 `WebSecurityPolicy::AddOriginAccessAllowListEntry`，新渲染进程启动时同步拿到已有条目。

**c. `FileURLLoaderFactory` 的 CORS 判定**（`content/browser/loader/file_url_loader_factory.cc:860-907`）
```cpp
  DCHECK(!network::cors::IsCorsEnabledRequestMode(request.mode) || shared_cors_origin_access_list_);   // 现状：nullptr + cors 模式 → DCHECK
  bool is_request_considered_same_origin = kDisableWebSecurity ||
      (request.request_initiator && (request.request_initiator->IsSameOriginWith(request.url) ||
        (shared_cors_origin_access_list_ && shared_cors_origin_access_list_->GetOriginAccessList()
             .CheckAccessState(*request.request_initiator, request.url) == kAllowed)));
  response_type = CalculateResponseType(request.mode, is_request_considered_same_origin);   // same-origin → kBasic；cors 模式否则 → kCors
  if (response_type == kCors) { OnComplete(... kCorsDisabledScheme ...); return; }                 // 现状：kCors 一律拒
```
`CreateFileURLLoaderFactory(profile_path, list)` 每次 `new` 一个实例，列表是实例成员，不影响 profile 共享列表。`file_url_loader.h:74-77` 关于「nullptr 放行所有 CORS」的注释与代码矛盾，以代码为准。

**d. 6b 的 06 传的是 profile 共享列表**（`third-patches/cef/06-app-page-file-subresources.patch`，6b 落地后的形态）
```cpp
  content::BrowserContext* browser_context = rfh->GetBrowserContext();
  factories->emplace(url::kFileScheme,
      content::CreateFileURLLoaderFactory(browser_context->GetPath(),
                                          browser_context->GetSharedCorsOriginAccessList()));   // 现状：共享列表为空 → cors 模式被拒
```

**e. `OriginAccessEntry` 对 `file:///` 的匹配**（`services/network/public/cpp/cors/origin_access_entry.cc:91-115`）：scheme 相等 → 空 host + `kAllowSubdomains` 直接 `kMatchesOrigin`（含 UNC）；`url::Origin` 对 `file:` 是非 opaque 元组 `("file", "" | UNC 主机, 0)`，序列化 `file://`。

**f. IPC 原始字节响应**（`src-tauri/tauri-runtime-kbcef/src/ipc.rs:3-5`；`third/tauri/crates/tauri/src/ipc/mod.rs:190-200`）
```rust
//! Tauri 2 的命令 IPC 有两条上游通道:`fetch(ipc://localhost/<cmd>)` 自定义协议
//! (主通道,JSON 与 raw 二进制 body 都走它,…)                                  // 现状：raw 响应可用，前端 invoke 得到 ArrayBuffer
pub struct Response { body: InvokeResponseBody }                                    // tauri::ipc::Response::new(Vec<u8>)
```
现有同类用法：`proxy_fetch` 返回 `{ base64, contentType }` JSON（`commands/proxy.rs`），这是 IPC 没有 raw 通道时的老写法；本 Phase 用 raw。

**g. 插件文件 HTTP 端点**（`src-tauri/kabegame/src/plugin_file_server.rs:12-107`）
```rust
struct FileQuery { v: Option<String>, source: Option<String>, preview: Option<String> }
pub fn plugin_file_routes() -> Router {                       // 现状：被 file_routes（桌面本地）、file_routes_web、Android start_plugin_file_server 三处用
    Router::new().route("/plugin_file/{plugin_id}/{*path}", get(handle_plugin_file))
        .layer(axum::middleware::from_fn(plugin_file_cors))  // ACAO * 等四个头
}
async fn handle_plugin_file(...) -> Response {
    let Some(version) = query.v else { 404 };
    let origin = match (query.source, query.preview) { (None, None) => Installed, (Some(s), None) => Store{s}, (None, Some(t)) => Preview{t}, _ => 404 };
    let plugin = PluginManager::global_opt()?.resolve_plugin_file(&id, &origin, &version)?;   // kabegame-core plugin/package_file.rs:45-72
    let entry = allowed_entry(&plugin, &path)?;                                               // :150-172 白名单
    spawn_blocking(|| { let bytes = read_kgpg_entry(file, &entry)?; let etag = etag_for(&plugin)?;   // :183-194, :241-255；现状：先读条目再比 ETag
        if if-none-match 命中 { 304 } else { ([content-type mime_for_plugin_file(&entry)], bytes) } ... etag / cache-control: no-cache })
}
```

**h. 本地 HTTP 服务的启动与命令**（`src-tauri/kabegame/src/lib.rs:75-76, 380-382, 906`；`http_server.rs:401-411, 499-534`）
```rust
#[cfg(not(feature = "web"))]
use http_server::get_http_server_base_url;                                   // 现状：桌面与 Android 共用同名命令、两个 cfg 变体
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    tauri::async_runtime::block_on(http_server::start_http_server())        // 现状：唯一启动点，挂 file_routes()
        .map_err(|e| format!("Cannot start http server: {}", e))?;
pub fn file_routes() -> Router {                                             // 现状：只有 start_http_server 与一个测试在用
    Router::new().route("/file/{*path}", ...).route("/thumbnail/{*path}", ...).route("/compatible/{*path}", ...)
        .merge(crate::plugin_file_server::plugin_file_routes())             // 6b 已删 /proxy
}
#[cfg(all(not(target_os = "android"), not(feature = "web")))]
#[tauri::command]
pub async fn get_http_server_base_url() -> Result<String, String> { /* 轮询 HTTP_SERVER_PORT */ }   // 现状：桌面版
```
`file_routes_media()`（`web_server_service.rs:66`）与 `file_routes_web()`（`lib.rs:429`）不碰 `start_http_server` / `HTTP_SERVER_PORT`。`PluginDocImageQuery`（`http_server.rs:55-61`）无人使用。

**i. 前端 HTTP 基址与 6b 之后的出口**（`apps/kabegame/src/utils/fileUrl.ts`，6b 落地后的形态）
```ts
export async function initHttpServerBaseUrl() {           // 现状：所有平台都 invoke("get_http_server_base_url")
  if (IS_WEB) { httpServerBaseUrl = VITE_API_ROOT; return; }
  const base = await invoke<string>("get_http_server_base_url"); ...
}
export function pluginFileUrl(plugin, relPath): string {   // 现状：`${httpServerBaseUrl}/plugin_file/<id>/<path>?v=&source=&preview=`
export function fileToHttpUrl / thumbnailToHttpUrl / compatibleToHttpUrl   // 6b 新增：复制兜底、Windows 拖出用
```
`pluginFileUrl` 的消费方：`PluginDocRenderer.vue:278-283`（`<img src>` 写进 marked HTML）、`utils/assetPath.ts:89-92`（banner `<img src>`）、`services/pluginFiles.ts:8-23`（`fetch()` 读文本，缓存键为完整 URL）。`initHttpServerBaseUrl` 调用点：`App.vue:527`、`WallpaperStage.vue:188, 207`、`pluginFiles.ts:9`。

**j. CSP**（`src-tauri/kabegame/tauri.conf.json.handlebars:41`，6b 之后）
```
img-src * data: blob: file:; media-src * data: blob: file:; connect-src 'self' ipc: cef-ipc: http://ipc.localhost ws: wss:{{android…}} http://127.0.0.1:*;   // 现状：connect-src 无 file:、无插件协议；仍放行 127.0.0.1
```
`*` 只匹配 http(s) 与自身 scheme（`csp_source_list.cc:220-226`），`file:` 要显式写；`img-src` 已有 `blob:`。

**k. Windows 拖出**（`apps/kabegame/src/components/image/ImageContent.vue:258-269`，6b 之后改为按 `sourceOf` tag 取 `*ToHttpUrl`）；`PrepareDragForDownload`（`web_contents_view_aura.cc:204-248`，`#if BUILDFLAG(IS_WIN)`）只消费 `download_metadata`，经 `DragDownloadFile` 交给 `DownloadManager`，后者按发起 frame 调 `RegisterNonNetworkSubresourceURLLoaderFactories`（`download_manager_impl.cc:1481-1489`）。

## 点 1 — 修订补丁 06：工厂带私有 CORS 列表（`third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.cc`）

- **修改** 06 的覆写：`emplace` 前为本次的 `request_initiator_origin` 新建一份 `SharedCorsOriginAccessList`，登记
  「该 origin → `file` scheme，空 host，允许子域，任意端口」。`SetForOrigin` 与工厂都在 UI 线程。`request_initiator_origin`
  为空（不该发生于主 frame 提交）时退回共享列表。
- **修改** 补丁文件与 `third-patches/cef/README.md` 06 条目（去掉「shared CORS list left empty on purpose」，改成「每个工厂实例一份私有列表，只放行该文档 origin 的 CORS 模式 `file:` 请求；客户端还需 `CefAddCrossOriginWhitelistEntry` 过 proxy 的闸」）。

```cpp
#include "content/public/browser/shared_cors_origin_access_list.h"   // 新增
#include "services/network/public/mojom/cors_origin_pattern.mojom.h" // 新增

  // 替换 6b 的 emplace：
  content::BrowserContext* browser_context = rfh->GetBrowserContext();
  // Kabegame: FileURLLoaderFactory rejects CORS-mode requests (fetch / XHR)
  // whose initiator is not file-same-origin unless its access list allows
  // them; nullptr does not allow them either (and DCHECKs). Give this one
  // factory instance a private list that allows the committing document's
  // origin to read any file: URL. The profile's shared list is not touched,
  // so nothing else in the profile gains access. The CEF ProxyURLLoaderFactory
  // in front of this factory has its own cross-origin check; the client
  // satisfies it with CefAddCrossOriginWhitelistEntry(origin, "file", "", true).
  scoped_refptr<content::SharedCorsOriginAccessList> access_list =
      browser_context->GetSharedCorsOriginAccessList();
  if (request_initiator_origin && !request_initiator_origin->opaque()) {
    access_list = content::SharedCorsOriginAccessList::Create();
    std::vector<network::mojom::CorsOriginPatternPtr> allow;
    allow.push_back(network::mojom::CorsOriginPattern::New(
        url::kFileScheme, /*domain=*/std::string(), /*port=*/0,
        network::mojom::CorsDomainMatchMode::kAllowSubdomains,
        network::mojom::CorsPortMatchMode::kAllowAnyPort,
        network::mojom::CorsOriginAccessMatchPriority::kDefaultPriority));
    access_list->SetForOrigin(*request_initiator_origin, std::move(allow),
                              /*block_list=*/{}, base::DoNothing());
  }
  factories->emplace(url::kFileScheme,
                     content::CreateFileURLLoaderFactory(
                         browser_context->GetPath(), std::move(access_list)));
```
> `SharedCorsOriginAccessList::Create()` 的声明在 `content/public/browser/shared_cors_origin_access_list.h`；`SetForOrigin(origin, allow, block, closure)` 的签名以该头文件为准（实施时核对）。

## 点 2 — 运行时：跨源白名单（`src-tauri/tauri-runtime-kbcef/src/`）

- **新增** `file_access.rs`：`app_fetch_origins: Mutex<HashSet<String>>` 去重表；`grant_app_fetch_file(origin: &str) -> bool`，调 `cef::add_cross_origin_whitelist_entry(origin, "file", None, 1)`，已登记的 origin 直接返回。
- **修改** `webview.rs` `create_cef_browser_view`：label 登记了 05 时，从 `pending.url` 取 origin（`url::Url::parse` → `origin().ascii_serialization()`；dev `http://localhost:1420`，Windows 生产 `http://tauri.localhost`，Linux / macOS 生产 `tauri://localhost`），调 `grant_app_fetch_file`。主窗口与壁纸窗口同源，第二次是 no-op。
  > 不做成 app 侧 API：生产 origin 由 Tauri 的 `window_origin` 推导，运行时在建窗时拿 `pending.url` 最直接。
  > 移除不做：CEF 的 remove 会清掉该 origin 的**全部**条目；窗口销毁也不撤，进程内常驻。
- **修改** `runtime.rs:72-89` LNA 注释：本地 HTTP 媒体服务已删，保留关闭 LNA / PNA 的理由改为 dev 的 debug ingest（`POST http://localhost:1420/__kabegame_debug/ingest`）与 Windows 形态的 Tauri 协议域名（`http://tauri.localhost` / `http://ipc.localhost`）。不加新 scheme。
- **修改** `lib.rs` 分节注释：文件访问一节补「应用 origin 的跨源白名单（`fetch(file:)` 过 CEF proxy 的 CORS 闸）」。

```rust
// file_access.rs —— 新增
/// 已登记跨源白名单的应用 origin（进程内常驻，不撤销）。
static APP_FETCH_ORIGINS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 让 `origin` 的页面能以 CORS 模式读 `file:`（`fetch` / XHR 拿到字节）。CEF 的 `ProxyURLLoaderFactory` 对跨源、
/// 非 no-cors 的 `file:` 请求先查 CEF 跨源白名单，没有就报 `kCorsDisabledScheme`，到不了 `OnBeforeResourceLoad`；
/// 这里登记「origin → file，任意 host」。字节能否真的读到仍由补丁 06 给该 browser 主 frame 的 `file:` 工厂
/// （带该 origin 的私有 CORS 列表）决定，没有工厂的页面只是多了渲染侧的 `CanDisplay(file:)`，拿不到数据。
pub(crate) fn grant_app_fetch_file(origin: &str) -> bool {
    let Ok(mut set) = APP_FETCH_ORIGINS.get_or_init(|| Mutex::new(HashSet::new())).lock() else { return false };
    if !set.insert(origin.to_string()) { return true; }
    cef::add_cross_origin_whitelist_entry(
        Some(&CefString::from(origin)), Some(&CefString::from("file")), None, 1,
    ) != 0
}
```
```rust
// webview.rs —— create_cef_browser_view，写 extra_info 键之后
        // 登记了 05 的 webview：它的应用 origin 还要进 CEF 跨源白名单，`fetch(file:)` 才过得了 proxy 的 CORS 闸
        if crate::file_access::app_page_open(&webview_label) {
            if let Some(origin) = url::Url::parse(&pending_url).ok().map(|u| u.origin().ascii_serialization()) {
                if !crate::file_access::grant_app_fetch_file(&origin) {
                    eprintln!("[cef-runtime] cross-origin whitelist for {origin} → file failed (webview '{webview_label}')");
                }
            }
        }
```

## 点 3 — 插件文件：核心层纯函数 + Tauri 命令 `read_plugin_file`（`kabegame-core`、`src-tauri/kabegame/src/`）

- **新增** `kabegame-core/src/plugin/package_file.rs`
  - `PluginFileOrigin::from_query(source: Option<String>, preview: Option<String>) -> Option<Self>`（把 `handle_plugin_file` 里的 `match` 搬下来）。
  - `pub struct PluginFileBody { pub bytes: Vec<u8>, pub mime: String, pub etag: String }`
  - `pub fn read_plugin_file(id: &str, origin: &PluginFileOrigin, version: &str, path: &str, if_none_match: Option<&str>) -> Result<Option<PluginFileBody>, PluginFileError>`：阻塞函数（zip + `fs::metadata`）；`Ok(None)` 表示 ETag 命中（**先算 ETag 再读条目**，修掉现状的白读）；找不到插件 / 条目不在白名单 → `Err(NotFound)`。
- **修改** `plugin_file_server.rs`：`handle_plugin_file` 变薄（解析 query → `spawn_blocking(read_plugin_file)` → 映射 200 / 304 / 404）；`plugin_file_routes` / `handle_plugin_file` / `plugin_file_cors` / `FileQuery` 加 `#[cfg(any(feature = "web", target_os = "android"))]`。
- **新增** 命令 `read_plugin_file`（放 `src-tauri/kabegame/src/commands/plugin.rs` 或同目录新文件，`#[cfg(not(feature = "web"))]`）：
  参数 `plugin_id`、`version`、`source: Option<String>`、`preview: Option<String>`、`path`；`spawn_blocking(read_plugin_file(..., None))`，
  成功返回 `tauri::ipc::Response::new(body.bytes)`（原始字节，前端得 `ArrayBuffer`），失败返回 `Err(String)`。不做 ETag（IPC 没有缓存层，
  缓存在前端按坐标做）。MIME 不随字节返回，前端按扩展名推。
  > 门禁：命令进 `permissions/main.toml`，`main-capability` 只绑定 `main` / `wallpaper` 两个窗口，surf / crawler 调不到；
  > `allowed_entry` 白名单与 `resolve_plugin_file` 的版本校验照旧，所以只能读插件包里声明过的条目。
- **修改** `lib.rs`：`generate_handler!` 加 `read_plugin_file`；删除 `lib.rs:380-382` 的 `start_http_server`；`get_http_server_base_url` 的 import 与 `generate_handler!` 条目改为 `#[cfg(target_os = "android")]`；`lib.rs:106` 注释去掉「HTTP 服务」。
- **修改** `http_server.rs`：删 `HTTP_SERVER_PORT`、`start_http_server`、`file_routes`、桌面版 `get_http_server_base_url`、`handle_unmatched`（测试 `media_routes_only_accept_wildcard_path_form` 改用 `file_routes_media()` 自带 fallback）、死代码 `PluginDocImageQuery`；模块注释改为「应用 Web 服务器与 Web 版共用的媒体路由」。`main.toml` 的 `get_http_server_base_url` 权限保留（Android 仍用）。

```rust
// commands/plugin.rs —— 新增
/// 读插件包内一个已声明条目的原始字节（桌面：替代本地 HTTP 的 `/plugin_file`）。
/// 坐标与 `/plugin_file` 的 query 一致：`source` = 商店来源 id、`preview` = 预览 token、都不传 = 已安装；
/// 版本不符或条目不在白名单时返回错误。响应是原始字节（`tauri::ipc::Response`），MIME 由前端按扩展名推。
#[tauri::command]
pub async fn read_plugin_file(
    plugin_id: String,
    version: String,
    source: Option<String>,
    preview: Option<String>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let origin = PluginFileOrigin::from_query(source, preview).ok_or("invalid plugin file origin")?;
    let body = tauri::async_runtime::spawn_blocking(move || {
        read_plugin_file_core(&plugin_id, &origin, &version, &path, None)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?
    .ok_or("plugin file not found")?;
    Ok(tauri::ipc::Response::new(body.bytes))
}
```

## 点 4 — 前端：插件文件改命令 + blob URL，撤回 HTTP 出口（`apps/kabegame/src/`）

- **修改** `services/pluginFiles.ts`
  - 新增 `pluginFileKey(plugin, path)`：`${id}@${version}@${origin.kind}:${sourceId|token}/${path}`，三端统一的缓存键（不再是 URL）。
  - 新增 `fetchPluginBytes(plugin, path): Promise<ArrayBuffer>`：桌面 `invoke("read_plugin_file", {...})`；Web / Android `fetch(pluginFileUrl(...)).arrayBuffer()`。
  - `fetchPluginText`：改为 `fetchPluginBytes` 后 `TextDecoder("utf-8")` 解码；缓存键改用 `pluginFileKey`。
  - 新增 `pluginAssetUrl(plugin, key): Promise<string>`：桌面 `fetchPluginBytes` → `new Blob([buf], { type: mimeByExt(key) })` → `URL.createObjectURL`，按 `pluginFileKey` 缓存；Web / Android 直接 `Promise.resolve(pluginFileUrl(plugin, key))`。
  - `invalidatePluginFiles(pluginId)`：同时清文本与 blob 缓存，blob 条目 `URL.revokeObjectURL`。
  - MIME 表：复用 / 抽出已有的按扩展名推断（`useImageOperations.ts` 的 `detectImageMimeByPath` 或 `get_supported_image_types` 的 `mimeByExt`），补 svg / md / json / ejs / txt，缺省 `application/octet-stream`。
- **修改** `components/plugin/PluginDocRenderer.vue:270-290`：图片替换从同步改成两段——先收集 `assetKeys` 命中的 key，`await Promise.all(keys.map(k => pluginAssetUrl(plugin, k)))`，再替换；渲染函数改成 `async`，调用处随之改为 `watch` + 取消令牌（插件或文本变化时丢弃过期结果），失败的 key 走现有 `imageLoadFailed` 文案。
- **修改** `utils/assetPath.ts:89-92`：`bannerPreviewImages` 改为 composable `useBannerPreviewImages(pluginRef)` 返回 `Ref<{ key; src }[]>`（内部 `pluginAssetUrl`，插件变化时重算、过期结果丢弃）。三个消费点同步：`PluginDocPanel.vue:59`、`PluginPickerField.vue:215`、`views/PluginBrowser.vue:609`（`PluginQuickPreviewCarousel` 的 `images` prop 形状不变）。
- **修改** `utils/fileUrl.ts`
  - `initHttpServerBaseUrl`：`DESKTOP_FILE_MEDIA`（非 Web、非 Android）时直接 `httpServerBaseUrl = ""`，不 invoke。
  - `pluginFileUrl` 只保留 Web / Android 分支（桌面返回 `""`，JSDoc 写明桌面走 `pluginAssetUrl` / `fetchPluginBytes`）。
  - **删除** 6b 新增的 `fileToHttpUrl` / `thumbnailToHttpUrl` / `compatibleToHttpUrl`（桌面无人再用；Web / Android 本来就走 `*ToUrl`）。
  - 测试：`fileUrl.test.ts` 删 `*ToHttpUrl` 用例、桌面 `pluginFileUrl` 断言为空串；`pluginFiles.test.ts` 新增桌面分支（mock `invoke` 返回 `ArrayBuffer`，断言文本解码、blob URL 缓存命中与 `invalidatePluginFiles` 后 `revokeObjectURL` 被调）。
- **修改** `composables/useImageOperations.ts`：`getImageDownloadUrl` 与复制兜底回到 `fileToUrl(localPath) || thumbnailToUrl(thumbnailPath)`（顺带修掉对缩略图用 `fileToUrl` 的旧 bug）；桌面兜底 `fetch(file:)` 现在能读到字节。
- **修改** `components/image/ImageContent.vue` Windows 拖出：撤回 6b 的 `*ToHttpUrl` 分支，回到 `currentSrc`（已是 `file://`）写 `DownloadURL` / `text/uri-list` / `text/plain`；注释改写。`fileNameFromUrlOrPath` 对 `file:///C:/…%20…` 的解码按现有实现即可（先解码再切）。
- **修改** `tauri.conf.json.handlebars:41` CSP：`connect-src` 去掉 `http://127.0.0.1:*`，加 `file:`；`img-src` 已有 `blob:`，不动。重新生成 gitignored 的 `tauri.conf.json`。
- **修改** `vite.config.ts` `webDevApiProxyPaths`：补 `/compatible`（现状漏项，Web dev 用）。

```ts
// services/pluginFiles.ts —— 新增（节选）
const DESKTOP = !IS_WEB && !IS_ANDROID;
const blobs = new Map<string, { pluginId: string; promise: Promise<string> }>();

export function pluginFileKey(plugin: Pick<Plugin, "id" | "version" | "fileOrigin">, path: string): string {
  const o = plugin.fileOrigin;
  const origin = o?.kind === "store" ? `store:${o.sourceId}` : o?.kind === "preview" ? `preview:${o.token}` : "installed";
  return `${plugin.id}@${plugin.version}@${origin}/${path}`;
}

/** 插件包内条目的原始字节：桌面经命令（IPC raw 响应），Web / Android 经 HTTP。 */
export async function fetchPluginBytes(plugin: Plugin, path: string): Promise<ArrayBuffer> {
  if (DESKTOP) {
    const o = plugin.fileOrigin;
    return invoke<ArrayBuffer>("read_plugin_file", {
      pluginId: plugin.id, version: plugin.version, path,
      source: o?.kind === "store" ? o.sourceId : null,
      preview: o?.kind === "preview" ? o.token : null,
    });
  }
  await initHttpServerBaseUrl();
  const response = await fetch(pluginFileUrl(plugin, path));
  if (!response.ok) throw new Error(`plugin_file: ${response.status}`);
  return response.arrayBuffer();
}

/** 给 <img> 用的插件配图地址：桌面是按坐标缓存的 blob: URL，Web / Android 仍是 HTTP URL。 */
export function pluginAssetUrl(plugin: Plugin, key: string): Promise<string> {
  if (!DESKTOP) return Promise.resolve(pluginFileUrl(plugin, key));
  const cacheKey = pluginFileKey(plugin, key);
  const cached = blobs.get(cacheKey);
  if (cached) return cached.promise;
  const promise = fetchPluginBytes(plugin, key).then((buf) => URL.createObjectURL(new Blob([buf], { type: mimeByExt(key) })));
  const entry = { pluginId: plugin.id, promise };
  blobs.set(cacheKey, entry);
  void promise.catch(() => { if (blobs.get(cacheKey) === entry) blobs.delete(cacheKey); });
  return promise;
}

export function invalidatePluginFiles(pluginId: string) {
  for (const [key, entry] of texts) if (entry.pluginId === pluginId) texts.delete(key);
  for (const [key, entry] of blobs) if (entry.pluginId === pluginId) {
    blobs.delete(key);
    void entry.promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
}
```

## 点 4b — 关闭 Tauri asset 协议（用户指定，2026-10-30）

现状：`protocol-asset` feature 开着（`src-tauri/kabegame/Cargo.toml:60, 87` 两处 tauri 依赖），`tauri.conf.json.handlebars:48-51`
`assetProtocol.enable = true`、`scope ["**"]`，Tauri 会把它注册到**每个** webview（含 surf / crawler 的第三方页）且不经图库白名单；
前端没有任何 `convertFileSrc` / `asset://` 用法。图库媒体已走 `file://`，这条协议没有用途，关掉。

- **修改** `src-tauri/kabegame/Cargo.toml`：两处 tauri `features` 列表删 `"protocol-asset"`。
- **修改** `tauri.conf.json.handlebars`：删 `assetProtocol` 整块（`dangerousDisableAssetCspModification` 保留，它管的是 CSP 注入，与 asset 协议无关）；重新生成 gitignored 的 `tauri.conf.json`。
- **修改** `src-tauri/tauri-runtime-kbcef/src/runtime.rs:1009`：scheme 列表 `["tauri", "asset"]` 改为 `["tauri"]`，74 行注释同步。
- 验证：`check-kabegame` 通过；`grep -rn "protocol-asset\|assetProtocol\|asset://" src-tauri apps` 为空；真机在任意窗口顶层 `fetch("http://asset.localhost/C:/Windows/win.ini")`（Linux / macOS 为 `asset://localhost/...`）报网络错误而不是返回内容。

## 点 5 — 文档 / 回归 / changelog

- `third-patches/cef/README.md`：06 条目按点 1 改写。
- `cocs/plugins/PLUGIN_FILE_ENDPOINT.md`：标题下加「桌面走命令 `read_plugin_file`（IPC 原始字节 + 前端按坐标缓存 blob / 文本）、Android / Web 走 HTTP，共用核心层 `read_plugin_file`」；ETag / 304、CORS、`get_http_server_base_url`（仅 Android）各段分平台改写。`cocs/plugins/PLUGIN_ASSETS.md:135, 168, 231, 247`、`PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md:15, 55, 136`、`PLUGIN_STORE_CACHE.md:104` 的 `/plugin_file` 字样同步。
- `cocs/web/CDN_MEDIA.md:9`、`cocs/mcp/MCP_SERVER.md:14, 31`、`cocs/wpe/WPE_IMPORT.md:119, 274-275, 415-427`、`cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md:133`：去掉「桌面本地 HTTP 服务」的描述，`fetch(file:)` 与跨源白名单写进 WPE_IMPORT 的闸门一节。
- `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md:18-21, 112-114, 197` 与 `src-tauri/tauri-runtime-kbcef/README.md:327-334`：Windows 的 `DownloadURL` 改为 `file://`（按真机结果写）。
- `src-tauri/tauri-runtime-kbcef/README.md` 文件访问一节：加跨源白名单。
- `apps/docs/src/content/docs/guide/android.md:79, 102`：平台对照表里桌面三端的「HTTP 文件服务」改为「无（应用 Web 服务器按需开启）」。
- `cocs/README.md`：PLUGIN_FILE_ENDPOINT、拖出文档、CEF 补丁条目摘要同步。
- `.claude/plans/wpe-import/2-web/PLAN.md`：Phase 6c 行、状态、文档列表。
- `versions/latest/regression.md`：新增「Phase 6c：桌面零 HTTP / `fetch(file:)` / 插件文件命令」小节，用例见下。
- `versions/latest/changelog.md`：用户可见——桌面不再监听本地端口、插件文档 / 配图改由应用内协议读取；内部——06 修订、跨源白名单、`start_http_server` 删除。

## 验证

**A. 静态**
1. `deno task patch cef --check` → `deno task patch cef`：06 新版应用成功。
2. `check-kabegame` 0 error；`cargo check` 的 `web` feature（`deno task check -c kabegame --mode web` 或等价）与 `--mode android` 各跑一次，确认 `plugin_file_routes` 的 cfg 没把 Web / Android 编译掉。
3. 单测：`file_access`（新增 `grant_app_fetch_file_dedups`，白名单调用在非 CEF 进程里返回 0 也不 panic）；`kabegame-core` `package_file`（`from_query` 四种组合、`read_plugin_file` 的 ETag 命中不读条目、白名单外 404）；前端 vitest `fileUrl.test.ts` / `pluginFiles.test.ts`。
4. `grep -rn "start_http_server\|HTTP_SERVER_PORT\|ToHttpUrl\|/plugin_file" apps src-tauri cocs`：桌面路径只剩 Android / Web 分支与历史说明。
5. `netstat -ano | findstr <kabegame pid>`：桌面进程无 127.0.0.1 监听（应用 Web 服务器未开启时）。

**B. 真机（Windows，用户重编 CEF 并完全重启 dev；Linux / macOS 待测）**
1. `fetch(file:)`：主窗口顶层 `fetch("file:///D:/Codes/kabegame/docs/images/icon.png")` → `status 200`、`type "basic"`、`blob().size > 0`；XHR 同样；stderr 无 `deny file:`（主 frame 免检）。
2. 复制到剪贴板：对一张 `localPath` 为空、只有缩略图的行（或临时构造）走兜底 `fetch(file:)` 成功写入剪贴板；常规行仍走后端命令。
3. WPE 预览 iframe 内 `fetch("file:///C:/Windows/win.ini")` 仍被闸门拒（`deny file: … OutsideRoot`）；入口同目录 `fetch` 200（04 路径不变）。
4. 插件文件：插件详情页的文档插图、banner、`kbDoc` / `kbChangelog` 文本、EJS 模板都正常；CDP `Network` 里图片地址为 `blob:http://localhost:1420/…`、IPC 是 `ipc://localhost/read_plugin_file` 的二进制响应；商店来源与预览各试一个；错误路径（白名单外、版本不符）命令返回 `Err` 且前端走现有错误显示；切换插件版本 / 删除插件后旧 blob URL 已 revoke（再访问报错）、重开详情页重新读取。
5. 命令的门禁：在畅游窗口顶层 `invoke("read_plugin_file", …)` 被 ACL 拒（命令不在该窗口 capability 里）。
6. 插件 iframe（6b 的 opaque srcdoc）里拿不到 `__TAURI_INTERNALS__`，`fetch("ipc://localhost/read_plugin_file")` 被 `connect-src 'none'` 拒。
7. Windows 拖出：从网格拖一张图到资源管理器得到文件（`DownloadURL` 为 `file:///…`）；拖一段视频同样；拖出期间 stderr 无 `deny file:`。**若失败**：记录现象，启用文末备选。
8. 生产形态 CSP：用 `deno task b`（或 release 配置的 `tauri.conf.json`）起一次，确认 `fetch(file:)` 不被 `connect-src` 拦、blob 图片正常（dev 桌面没有 Tauri 注入的 CSP，容易漏）。
9. 应用 Web 服务器 + MCP：手动开启后 `curl http://127.0.0.1:<port>/thumbnail/…` 仍 200；关闭后桌面进程无监听端口。
10. 稳定性：`probe-observe.mjs <port> 60` 翻页 / 开关预览 / 打开插件详情，无 `[CRASH]`、无整窗 reload。
10b. asset 协议已关：主窗口与畅游窗口顶层 `fetch("http://asset.localhost/C:/Windows/win.ini")` 都失败（见点 4b）。
11. Web 版（`deno task dev:web` 或等价）：`/plugin_file` 与 `/file` 等路由照常，vite 代理 `/compatible` 生效。

## 风险与备注

- **跨源白名单是 origin 级全局的**：应用 origin 在所有渲染进程里 `CanDisplay(file:)` / `CanRequest(file:)` 为真，但没有 05 / 06 的 browser 既无 `file` 请求权也无工厂，拿不到字节；应用 origin 只有我们自己的页面在用。dev 的 `http://localhost:1420` 若被浏览器里的其它页面冒用，也只在本进程的 CEF 里有意义。
- **06 私有列表的 API 细节**（`SharedCorsOriginAccessList::Create` / `SetForOrigin` 签名、`CorsOriginPattern::New` 参数顺序）以 `D:\Codes\cefbuild` 源码为准，补丁代理实施时核对。
- **Windows `DownloadURL` + `file://`** 未经证实；备选见下。
- **blob URL 的生命周期**：按坐标缓存、`invalidatePluginFiles` 时 revoke；详情页反复开关不重复读 zip，但插件很多且都看过时 blob 会常驻到版本变化，插件文件小（单个 ≤ 2MB）可接受。`<img src=blob:>` 不再有 ETag / 304，命令每次都读 zip 条目，只在缓存未命中时发生。
- **文档渲染变异步**：`PluginDocRenderer` 先取全部配图 URL 再渲染，插图多时首帧会晚一点；失败的 key 走现有「加载失败」文案，不阻塞正文。

### 备选：Windows 真实文件拖出（仅当验证 7 失败时立项，不在本 Phase 内）
把补丁 03 的 Chromium 内层 `web_contents_view_aura.cc` 的 `#if BUILDFLAG(IS_LINUX)` 扩成 `IS_LINUX || IS_WIN`，Windows 分支额外清
`download_metadata`（否则延迟渲染的 CF_HDROP 会压过真实文件）与 `html`，并跳过 `MarkRendererTaintedFromOrigin`（Windows 上
taint 会以 `chromium/x-renderer-taint` 跨进程，接收方 `FilterDropData` 会丢掉文件）；`webview.rs:1132`、`lib.rs:287`、
`ImageContent.vue:258` 的平台门控加 Windows；cef-rs 绑定不用改。需要重编 Windows CEF。

## 实施记录

- 2026-10-30：由 codex（`codex exec --no-daemon`，workspace-write 沙箱）按本计划实施点 1–5 与 4b，Claude 在沙箱外复核。
  - 沙箱里 Git 子进程 `EPERM`、esbuild `spawn EPERM`、`cef-dll-sys` 的 cmake 卡住，codex 自报的四项验证没做成；沙箱外全部补跑：
    `deno task patch cef --check` OK、`deno task patch cef` 6 patches applied、`deno task check -c kabegame` 0 error、
    `file_access` 13 passed、`package_file` 9 passed、vitest 7 passed。结果已写进 `versions/latest/regression.md` 的 S2–S5 行。
  - codex 手工生成的 06 误以 vendor 基线为底，带进了 04 的 hunk，序列预检失败；改用 `deno task patch cef --gen --from 05 --out …`
    重新生成（该模式由 6b 期间加进 `scripts/patch-manager.ts`，`third-patches/AGENTS.md` 有说明）。
  - codex 把 23 个已跟踪文件写成了 CRLF（仓库 `.gitattributes` 为 `eol=lf`），已统一转回 LF；`git ls-files --eol -m` 无 `w/crlf`。
  - 与计划的偏差（codex 自报，已核）：`PluginDocPanel` 用 `useBannerPreviewImages`，选择器与插件浏览器保留同步取值、由 `assetPath.ts`
    在异步 URL 到达时触发响应式更新；运行时对 `tauri://localhost` 显式拼 origin（Rust `url` 库视其为 opaque）。
  - 待用户：重编 CEF（`CEFBUILD=D:/Codes/cefbuild deno task build:chromium`）、完全重启 dev、真机用例 1–10、10b、11；Windows 拖出
    `DownloadURL` 带 `file://` 失败时按「备选」立项。
