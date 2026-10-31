# CEF 补丁 07：文档 URL 随子资源工厂下发 + IPC 链路拉直 + 合完 feat/wpe-import ← origin/main

2026-10-31。只读调查后的实施方案，未改任何代码。Chromium 路径相对 `D:\Codes\cefbuild\chromium_git\chromium\src`
（149.0.7827.201，`src/cef` 与仓库 `third/cef` 工作区逐字节一致，已带 01–06）。冲突背景见
[ipc-caller-identity-merge-conflict.md](ipc-caller-identity-merge-conflict.md)；本方案取代其中的方案 1（已被否决）与「建议」。
需要拍板的决策集中在文末「需要用户拍板的决策」，正文按推荐项写。

## 总体设计思路

三处运行时逻辑都要回答同一个问题：「这个请求是哪个文档发出的」。IPC 的 ACL 来源要它，`CallerOrigin` 认出是哪张网页壁纸要它，
`file:` 闸门判发起方也要它。B 段从 CEF 的 `frame.url()` 读，这是 UI 线程上的缓存，`DidFinishNavigation` 才刷新，
IO 线程上新文档最早的请求读到的是空串或旧地址。24ee52ce 改用 factory 级 `request_initiator`，没有竞态，但只有 origin，
所有 `file:` 文档都是 `file://`。浏览器其实在**建子资源 URLLoaderFactory 的那一刻**就确切知道它属于哪个文档：
`NavigationRequest::CommitNavigation` 先 `ReadyToCommitNavigation` 把导航交给要提交的 RFH，然后在同一个 UI 线程调用栈里
调 `RenderFrameHostImpl::CommitNavigation` 为新文档建默认工厂和 `file:` / `data:` 等非网络工厂，每个工厂都经
`WillCreateURLLoaderFactory` 进 CEF 的 `CreateInterceptedRequestHandler`。补丁 07 就在这里，用公开接口
`GetPendingCommitCrossDocumentNavigations()` 取正在提交的导航的 URL，存进 CEF wrapper 的 `InitState`。
它和 `request_initiator` 同一时机定下，之后不再变，页面改不了。

补丁只提供事实，不带 Kabegame 的策略。每个代理工厂带两个值：
- **文档 URL**：子资源工厂是所属文档；导航工厂是被导航 frame 当前的文档。
- **父文档 URL**：所属 frame 的父文档；主 frame 为空。

wrapper 在 `OnBeforeRequest` 里先删掉请求自带的 `Sec-Kabegame-*` 头，再给每个非 http(s) 请求写入
`Sec-Kabegame-Document-Url` 和 `Sec-Kabegame-Parent-Document-Url`。值为空表示 CEF 认不出所属文档，例如 worker、出错页，
或同一 RFH 上同时挂着多条待提交导航。头不存在表示 CEF 没带 07。写入点在 `GetResourceRequestHandler` 之前，写的是
`network::ResourceRequest::headers` 本体。CEF 交给嵌入方的每个 `CefRequest` 都由它生成：`GetResourceRequestHandler` /
`OnBeforeResourceLoad` / `GetResourceHandler` / scheme factory `Create` 用同一个 `pending_request_`，`CefResourceHandler::Open`
用 `OpenInputStream` 现建的副本。所以三个读取点都能看到这两个头，不改公开 API，不重生成 capi，也不碰 `third/cef-rs` 的 bindings。
http(s) 请求只删不写，本地路径不会外泄。

运行时只在一个地方读这两个头：`TauriCefRequestHandler::resource_request_handler`，即 `GetResourceRequestHandler`。
IPC 请求的 `Origin` 在这里算一次：
- **来源**仍以 `request_initiator` 为准。它是浏览器按提交时的文档算的，计入了 sandbox 标志；只看文档 URL，会把
  不带 `allow-same-origin` 的沙箱文档当成非 opaque。
- 只有 initiator 说明是 `file:` 文档时，才用 07 的文档 URL（去掉 query 和 fragment）作为完整 `Origin`。Tauri 拿它同时判
  远程来源，并作为 `CallerOrigin` 交给 `wpe_web_pull_state`。
- 认不出文档就写 `null`，失败关闭。

IPC 链路同时拉直。`resource_request_handler` 给 IPC 请求返回 `IpcResourceRequestHandler { scheme, origin }`，CEF wrapper
在 `ContinueShouldInterceptRequest` 里先问它的 `GetResourceHandler`，它直接交出 Tauri 协议的 `CefResourceHandler`，并带上算好的
`Origin`。`CefResourceHandler::open` 剥掉私有头，赋一次 `Origin`。`IpcInitiatorHandler`、运行时自写的 `Sec-Kabegame-Initiator-Origin`
头和 `apply_initiator_origin` 都删除。全局 scheme factory 保留，承接 `tauri://` 等应用协议，也给没被归属的 IPC 请求兜底：
下载或导航到 `ipc:`、没有 browser 的请求会落到这里，`Origin` 一律写成 `null`。之后 Tauri 主通道回 500，回退通道交给 ACL 拒绝。

`file:` 闸门同样只看这两个头：
- 文档是 `file:`：`Document(文档)`。
- 子 frame 导航：父文档是 `file:` 就是 `Document(父)`；父文档已知但不是 `file:`，就是应用页发起，判 `Target`；父文档未知判拒绝。
- `about:blank` / `about:srcdoc` 子文档的子资源，继承父文档的范围。
- 其余都拒绝。

B 段里「认不出文档但 initiator 是 `file:` 就按目标路径」的临时规则删除。整个运行时不再读 `frame.url()` / `parent.url()` 做请求归属。
仍保留的 `frame.url()` 只用于页面加载事件、下载 Referer 和 `execute_java_script` 的脚本来源，都不涉及权限。

失败关闭的代价要说清楚：在没重编 CEF 的机器上（Windows 未带 07），网页壁纸 iframe 的导航因父文档未知被拒，`WallpaperStage`
超时后退回作者预览图，日志里有一次 `CEF patch 07 missing` 的 warn 和 `deny file:`。主窗口、畅游、爬虫的 IPC 照常工作，
因为它们的来源不依赖文档 URL。macOS / Linux 不提供网页壁纸，不重编也没有功能变化。Android 不经过 CEF，不受影响。

应用侧几乎不动：`wpe_web_pull_state` 收到的 `CallerOrigin` 仍是完整文档 URL，只是不再有竞态。垫片的 `retrying` 退避删除，
首批请求就带正确来源，再失败就是真失败，记日志后等下一次相关事件再拉取。

合并按这个终态直接解决冲突：
- B 段的结构全部保留：`SubframeId`、子 frame 桥、`EvalInSubframe`、目录索引、`classify_file_requester` 的分档表。
- 24ee52ce 的「不合法 `Origin` 就拒，不退到初始 URL」保留。
- 两边依赖 frame URL 或私有头的部分，都换成 07 的文档头。

**现状链路（合并工作区，24ee52ce 的 IPC + B 段的 frame）**
```text
渲染进程 fetch("ipc://localhost/<cmd>")
└ CEF IO：InterceptedRequestHandlerWrapper::OnBeforeRequest           (resource_request_handler_wrapper.cc:518)
   ├ GetHandler → TauriCefRequestHandler::resource_request_handler     (webview.rs:804)
   │   └ 返回 IpcInitiatorHandler { origin = origin_from_initiator(request_initiator) }
   ├ ShouldInterceptRequest → IpcInitiatorHandler::on_before_resource_load
   │   └ set_header_by_name("Sec-Kabegame-Initiator-Origin", origin)   ← 暗道 1：运行时自写私有头
   ├ ContinueShouldInterceptRequest                                    (:760)
   │   ├ handler.GetResourceHandler → None（未实现）                    (:812)
   │   └ GlobalSchemeHandlerFactory::create(browser, frame)            (:818，protocol.rs:134) ← 暗道 2：另起对象
   │       ├ registry[browser.id] → label + protocol
   │       └ RequestFrame { is_main, id }（B 段还读 frame.url()）
   └ ResourceResponseWrapper::OpenInputStream → CefResourceHandler::open (protocol.rs:175)
       ├ request_to_http（抄全部头）
       ├ apply_initiator_origin：私有头 → Origin                       ← 第二次赋值
       └ attach_request_frame → Tauri ipc handler / cef-ipc post_message_request
```

**拉直后**
```text
UI：NavigationRequest::CommitNavigation
  ├ ReadyToCommitNavigation → TransferNavigationRequestOwnership(rfh)
  └ RenderFrameHostImpl::CommitNavigation
      └ 默认工厂 / file: / data: / 06 工厂 → WillCreateURLLoaderFactory(kDocumentSubResource, rfh)
          └ [07] document = 唯一待提交导航的 URL，parent = 父 RFH 已提交 URL → InitState

渲染进程 fetch("ipc://localhost/<cmd>")
└ CEF IO：OnBeforeRequest
   ├ [07] 删 Sec-Kabegame-*；非 http(s) 写 Document-Url / Parent-Document-Url
   ├ GetHandler → resource_request_handler(request, request_initiator)
   │   ├ DocumentAttribution::of_request(request)        ← 私有头只在这里读一次
   │   ├ origin = ipc_origin(initiator, &doc)            ← Origin 只在这里算
   │   └ 返回 IpcResourceRequestHandler { scheme, origin }
   ├ ShouldInterceptRequest：OnBeforeResourceLoad 显式返回 CONTINUE
   │   （更正：原写「默认实现 RV_CONTINUE」，但 cef-rs 默认返回 RV_CANCEL，见回归 D12）
   ├ ContinueShouldInterceptRequest
   │   └ IpcResourceRequestHandler::resource_handler(browser, frame)
   │       ├ lookup_protocol(browser.id, scheme) → label + protocol（与 scheme factory 共用）
   │       └ CefResourceHandler { request_frame: {is_main, id}, ipc_origin: Some(origin) }
   └ OpenInputStream → CefResourceHandler::open
       ├ request_to_http → strip_private_headers
       ├ set_origin(ipc_origin)                          ← 唯一一次赋值
       └ attach_request_frame → Tauri
（GlobalSchemeHandlerFactory 只承接 tauri:// 等；IPC 落到这里 = 未归属 → ipc_origin = "null"）
```

## 现状锚点

**a. CEF wrapper：`InitState` 只存 frame 与 initiator**（`cef/libcef/browser/net_service/resource_request_handler_wrapper.cc:252-290`）
```cpp
    void Initialize(content::BrowserContext* browser_context,
                    CefRefPtr<CefBrowserHostBase> browser,
                    CefRefPtr<CefFrame> frame,
                    const content::GlobalRenderFrameHostId& global_id,
                    bool is_navigation,
                    bool is_download,
                    const url::Origin& request_initiator,
                    const base::RepeatingClosure& unhandled_request_callback) {
      ...
      request_initiator_ = request_initiator.Serialize();   // 现状：只有 origin，file: 文档恒为 "file://"
```

**b. CEF wrapper：`OnBeforeRequest` 的顺序**（同文件 `:571-593`）
```cpp
    // 现状：先补标准头……
    if (!request->headers.HasHeader(net::HttpRequestHeaders::kAcceptLanguage)) { ... }
    request->headers.SetHeaderIfMissing(net::HttpRequestHeaders::kUserAgent,
                                        init_state_->user_agent_);
    const bool is_external = IsExternalRequest(request);
    bool intercept_only = is_external;
    CefRefPtr<CefRequestImpl> requestPtr;
    // ……再由 request 生成 requestPtr 交给客户端 GetResourceRequestHandler（a 点）
    CefRefPtr<CefResourceRequestHandler> handler =
        GetHandler(request_id, request, &intercept_only, requestPtr);
    CefRefPtr<CefSchemeHandlerFactory> scheme_factory =
        init_state_->iothread_state_->GetSchemeHandlerFactory(request->url);
```

**c. CEF wrapper：`GetResourceHandler` 先于 scheme factory**（同文件 `:808-822`）
```cpp
    if (state->handler_) {
      // 现状：先问 GetResourceRequestHandler 返回的 handler
      resource_handler = state->handler_->GetResourceHandler(
          init_state_->browser_, init_state_->GetFrame(), state->pending_request_.get());
    }
    if (!resource_handler && state->scheme_factory_) {
      // 返回空才走全局 scheme factory
      resource_handler = state->scheme_factory_->Create(
          init_state_->browser_, init_state_->GetFrame(),
          std::string(state->request_->url.scheme()), state->pending_request_.get());
    }
```

**d. CEF：`Open` 拿到的是 `request_` 本体的新副本**（`cef/libcef/browser/net_service/resource_handler_wrapper.cc:415-425`）
```cpp
    // 现状：每次 OpenInputStream 从 network::ResourceRequest（= InterceptedRequest::request_）现建 CefRequestImpl
    request_ = new CefRequestImpl();
    request_->Set(&request, request_id);
    request_->SetReadOnly(true);
    ...
    bool result = handler->Open(request_.get(), handle_request, callbackWrapper.get());
```

**e. CEF client：工厂创建处只传 frame 与 initiator**（`cef/libcef/browser/chrome/chrome_content_browser_client_cef.cc:610-613`）
```cpp
  auto request_handler = net_service::CreateInterceptedRequestHandler(
      browser_context, frame, render_process_id,
      type == URLLoaderFactoryType::kNavigation,
      type == URLLoaderFactoryType::kDownload, request_initiator);   // 现状：type 只折算成两个 bool，不传 URL
```

**f. Chromium：提交时为新文档建的所有工厂都经 `WillCreateURLLoaderFactory`**（`content/browser/renderer_host/render_frame_host_impl.cc`）
```cpp
  // :12654 —— 配置取自正在提交的这条导航
  auto subresource_loader_factories_config =
      SubresourceLoaderFactoriesConfig::ForPendingNavigation(*navigation_request);
  // :12729 —— 默认（网络）工厂，ipc:// / cef-ipc:// 走它 → :13965 ContentClientParams(GetBrowserContext(), this, ...)
  bool bypass_redirect_checks = CreateNetworkServiceDefaultFactoryAndObserve(...);
  // :12744-12756 —— file: 文档的 FileURLLoaderFactory 先进 non_network_factories
  if (effective_scheme == url::kFileScheme) {
    non_network_factories.emplace(url::kFileScheme, FileURLLoaderFactory::Create(...));
  }
  // :12786-12810 —— 每个非网络工厂（含 file: 与 06 加的）同样带 this 包一层
  url_loader_factory::CreateAndConnectToPendingReceiver(
      pending_factory_proxy.InitWithNewPipeAndPassReceiver(),
      ContentBrowserClient::URLLoaderFactoryType::kDocumentSubResource,
      url_loader_factory::TerminalParams::ForNonNetwork(...),
      url_loader_factory::ContentClientParams(GetBrowserContext(), this, ...), ...);
```
`content/browser/loader/url_loader_factory_utils.cc:169-181` 的 `ContentClientParams::Run` 就是 `WillCreateURLLoaderFactory(... frame_.get() ...)`。

**g. Chromium：worker 的 `file:` 工厂不经过代理**（`content/browser/worker_host/worker_script_fetcher.cc:626-633、668-675`）
```cpp
  if (file_support) {   // 现状：创建者是 file: 文档时为 true（dedicated_worker_host.cc:356）
    non_network_factories.emplace(url::kFileScheme, FileURLLoaderFactory::Create(...));
  }
  ...
  for (auto& pair : non_network_factories) {
    // 现状：直接放进 bundle，没有 WillCreateURLLoaderFactory → CEF 代理与 OnBeforeResourceLoad 看不到
    factory_bundle->pending_scheme_specific_factories().emplace(scheme, std::move(pending_remote));
  }
```

**h. 运行时：`resource_request_handler`**（工作区 `src-tauri/tauri-runtime-kbcef/src/webview.rs:804-877`，冲突块在 843-853）
```rust
                if is_download != 1 {
                    let url = request.map(|request| CefString::from(&request.url()).to_string()).unwrap_or_default();
                    let initiator = request_initiator.map(|i| i.to_string()).unwrap_or_default();
                    if crate::protocol::is_ipc_url(&url) {
                        // 现状（24ee52ce）：只按 initiator 写私有头
                        return Some(IpcInitiatorHandler::new(crate::protocol::origin_from_initiator(Some(&initiator))));
                    }
                    ...
                    let frame_url = frame.as_ref().map(|frame| CefString::from(&frame.url()).to_string()).unwrap_or_default();
                    // 现状（B 段，冲突块）：再读父 frame 的 URL 缓存，并重复声明 initiator
                    let parent_url = frame.as_ref().and_then(|frame| frame.parent())
                        .map(|parent| CefString::from(&parent.url()).to_string()).unwrap_or_default();
                    let app_page_subresource = is_navigation == 0 && frame_is_main && !initiator.is_empty()
                        && initiator != "null" && !is_file_url(&initiator) && !is_file_url(&frame_url);
                    ...
                    let requester = classify_file_requester(frame_is_main, is_navigation != 0,
                        &frame_url, &parent_url, &initiator);
```

**i. 运行时：`IpcInitiatorHandler` 写私有头，`open` 再改名成 `Origin`**（工作区 `webview.rs:1074-1098`、`protocol.rs:195、416-421`）
```rust
    pub(crate) struct IpcInitiatorHandler { origin: String }   // 现状：只为写一个头存在
    fn on_before_resource_load(...) -> ReturnValue {
        request.set_header_by_name(Some(&CefString::from(INITIATOR_ORIGIN_HEADER)),
                                   Some(&CefString::from(self.origin.as_str())), 1);
        ReturnValue::CONTINUE
    }
    // protocol.rs open()：
    apply_initiator_origin(&mut request);   // 现状：私有头 → Origin
    fn apply_initiator_origin(request: &mut HttpRequest<Vec<u8>>) {
        if let Some(origin) = request.headers_mut().remove(INITIATOR_ORIGIN_HEADER) {
            request.headers_mut().insert(http::header::ORIGIN, origin);
        }
    }
```

**j. 运行时：回退通道两边各一套取值顺序**（`ipc.rs`，`git show HEAD:` 与 `git show origin/main:` 的 `post_message_request`）
```rust
// HEAD（24ee52ce）：子 frame 只收同源；Origin 不合法即拒
if !frame.is_main && !is_same_origin_as(&request, initial_url) { return Err(...); }
let uri = ...headers ORIGIN...filter(Url::parse ok).ok_or_else(|| "requires a valid Origin header")?;
// origin/main（B 段）：Origin → frame.url → 子 frame 占位来源 / 主 frame 退到 webview 初始 URL
let uri = match origin.or(frame_url) {
    Some(uri) => uri,
    None if is_subframe => UNATTRIBUTED_SUBFRAME_ORIGIN.to_string(),
    None => fallback_url.to_string(),
};
```

**k. 运行时：闸门分类**（`file_access.rs:235-258`，与 origin/main 相同）
```rust
pub(crate) fn classify_file_requester(frame_is_main: bool, is_navigation: bool,
    frame_url: &str, parent_url: &str, initiator: &str) -> FileRequester {
    if let Some(doc) = file_url_path(frame_url) { return FileRequester::Document(doc); }  // 现状：frame URL 缓存
    if is_navigation {
        if frame_is_main { return FileRequester::Deny; }
        if let Some(parent) = file_url_path(parent_url) { return FileRequester::Document(parent); }
        return FileRequester::Target;
    }
    if is_file_url(initiator) { return FileRequester::Target; }   // 现状：临时规则，认不出文档就按目标
    FileRequester::Deny
}
```

**l. 应用：按调用方文档认壁纸**（`src-tauri/kabegame/src/commands/wpe_web.rs:283-303`）
```rust
pub async fn wpe_web_pull_state(caller: tauri::ipc::CallerOrigin) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;   // 现状：依赖完整文档 URL
    let id = WpeWebDirIndex::global().image_id_of(&doc).ok_or("not inside a web wallpaper")?;
```

**m. 垫片：首批请求退避重试**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:157-170、185-188、214`）
```js
  // 现状：为 frame URL 竞态兜底，最多 5 次、250ms 起翻倍
  function retrying(task, label) { ... setTimeout(run, 250 * Math.pow(2, attempt - 1)); ... }
  return retrying(function () { return internals.invoke("plugin:event|listen", ...); }, "listen " + name);
  var request = latest ? transport.pull() : retrying(transport.pull, "pull");
```

## 点 1 — CEF 补丁 07（`third-patches/cef/07-document-url-headers.patch`）

只改 `//cef` 的三个文件：`libcef/browser/net_service/resource_request_handler_wrapper.{h,cc}` 与
`libcef/browser/chrome/chrome_content_browser_client_cef.cc`。不改 `include/`（无 API hash、capi、`libcef_dll` 胶水变化），
不碰 Chromium 本体。估计约 +130 / −8 行，与 06 同量级。

### 捕获点与各类工厂给什么

| 调用方 | `type` | `frame` | 文档头 | 父文档头 |
| --- | --- | --- | --- | --- |
| `RFHI::CommitNavigation` 的默认 / `file:` / `data:` / `filesystem:` / 06 工厂 | `kDocumentSubResource` | 提交中的 RFH | 唯一待提交导航的 `GetURL()`；`GetNetErrorCode() != OK` 为空；多于一条为空 | 父 RFH 已提交 URL |
| `RFHI::FailedNavigation`（:13030） | 同上 | 同上 | 空（有 net error） | 同上 |
| `UpdateSubresourceLoaderFactories`（网络服务崩溃、DevTools 注入） | 同上 | RFH | 有待提交导航用它，否则已提交 URL（同 Chromium 的 `ForPendingOrLastCommittedNavigation`） | 同上 |
| `CreateNetworkServiceDefaultFactory`（keepalive、FLEDGE、shared storage） | 同上 | RFH | 同上规则；Kabegame 不用这些功能 | 同上 |
| 主 frame 初始空文档 | 同上 | 主 RFH | 空（未提交） | 空 |
| 子 frame 初始空文档 | 渲染进程 clone 父工厂（`render_frame_impl.cc:3743`） | — | 继承父文档的值 | 继承 |
| `NavigationURLLoaderImpl`（`file:` 等非网络、网络、WebUI） | `kNavigation` | 被导航 FTN 的 `current_frame_host()`（`navigation_url_loader_impl.cc:1286、2292`） | 该 frame 当前已提交文档 | 父 RFH 已提交 URL |
| `HandleExternalProtocol` → 第二个重载（`tauri://` 等自定义 scheme 导航） | — | — | 空 | 空 |
| dedicated / shared worker 的网络工厂 | `kWorkerSubResource` / `kWorkerMainResource` | ancestor RFH / null | 空：worker 不是文档 | 空 |
| worker 的 `file:` 工厂 | 不经 `WillCreateURLLoaderFactory` | — | 不经代理，见下「新增：worker 的 `file:` 工厂」（决策 D5） | — |
| service worker | `kServiceWorker*` | null | 空 | 空 |
| 下载 / prefetch / early hints / DevTools | 对应 type | 视情况 | 空 | 空 |

「已提交 URL」统一经 `CommittedDocumentURL`：
- 空 URL 先返回。从未提交的 speculative / pending-commit host 一定是空 URL，这样 `IsErrorDocument()` 的 CHECK 不会命中。
- 出错页返回空。
- 不调 `GetLifecycleState()`：它对 speculative host 是 `NOTREACHED`（`render_frame_host_impl.cc:13601`）。

### 注入时机核对（三处读取都能看到）

| 阶段 | 位置 | 线程 | 嵌入方拿到的 `CefRequest` | 看得到 07 头 |
| --- | --- | --- | --- | --- |
| 写入 | `OnBeforeRequest`，补完 UA 之后、`GetHandler` 之前 | IO | — | 写在 `InterceptedRequest::request_` 本体 |
| (a) `GetResourceRequestHandler` | `GetHandler` → `MakeRequest(request)` | IO | `requestPtr`（写入之后生成） | ✓ |
| (b) `OnBeforeResourceLoad` | `ShouldInterceptRequest`，`pending_request_ = requestPtr` | IO | 同上 | ✓ |
| `GetResourceHandler` / scheme `Create` | `ContinueShouldInterceptRequest` | IO | 同上 | ✓ |
| (c) `CefResourceHandler::Open` | `OpenInputStream` 从 `request_` 现建 | IO | 新副本，`GetHeaderMap` 保留空值（`request_impl.cc:122-137`，只滤 Referer） | ✓ |
| 重定向 / 重启 | 都经 `Restart()` → 再进 `OnBeforeRequest`（`proxy_url_loader_factory.cc:484-578、787`） | IO | — | 先删后写，幂等；跳到 http(s) 只删不写 |

`TryCreateURLLoaderNetworkObserver` 的 UI 跳转和初始化前的排队（`:531-555`）都在写入点之前返回，重跑时照常写入。

### 子 frame 与 `file:` 文档的工厂
- **子 frame 的 IPC**：`fetch(ipc://…)` 在 iframe 的 JS 上下文发出，走这个 iframe RFH 的默认工厂（锚点 f `:12729`）。
  该工厂经 `CreateNetworkServiceDefaultFactoryInternal` 带 `this` 调 `WillCreateURLLoaderFactory`，进 `CreateInterceptedRequestHandler`。
  OOPIF 与同进程子 frame 都一样，因为 `CommitNavigation` 是浏览器侧按 RFH 调用的。
- **`file:` 文档自己的 `file:` 子资源**：`FileURLLoaderFactory` 先放进 `non_network_factories`，再在 `:12786-12810` 的循环里
  同样带 `this` 包一层。所以它也经 `CreateInterceptedRequestHandler`，06 加给应用页的 `file:` 工厂也一样。不需要另外的取 URL 办法。
- **唯一的例外是 worker**（锚点 g）。见下面的新增项，以及决策 D5。

### 为什么用请求头，不加 `CefRequest` getter
- **getter 要动公开 API**：改 `include/cef_request.h`，经 `version_manager.py` 重生成 capi 与 API hash，改 `libcef_dll` 的
  cpptoc / ctocpp。`third/cef-rs` 也要像 `third-patches/cef-rs/03`–`08` 那样，给 Windows x86_64、Linux x86_64、
  macOS aarch64 / x86_64 四份 bindings 各补一个 patch。
- **getter 还要另找存放位置**：`CefRequest` 也用在 `CefURLRequest` 等「文档 URL」无意义的场合。`Open` 拿到的是
  `OpenInputStream` 从 `network::ResourceRequest` 现建的副本，getter 的值得另存进 `network::ResourceRequest`，或经
  `ResourceResponseWrapper` 往下传，改动面更大。
- **请求头本来就会被复制**：头搭在 `network::ResourceRequest::headers` 上，CEF 本来就逐字复制进它交出的每个 `CefRequest`，
  cef-rs 也已有 `header_by_name` / `header_map`。
- **请求头的代价**：DevTools Network 面板能看到非 http(s) 请求带着本地路径；`file:` / `data:` loader 收到头后忽略。
  两者都可以接受。

### 修改 `resource_request_handler_wrapper.h`
```cpp
#include "url/gurl.h"   // 新增

namespace net_service {

// 新增：Kabegame（07）。代理在 OnBeforeRequest 里先删掉请求自带的、名字以 kKabegameHeaderPrefix
// 开头的全部头，再对非 http(s) 请求写入下面两个头。值为空：认不出所属文档；头不存在：CEF 没带 07。
inline constexpr char kKabegameHeaderPrefix[] = "Sec-Kabegame-";
inline constexpr char kKabegameDocumentUrlHeader[] = "Sec-Kabegame-Document-Url";
inline constexpr char kKabegameParentDocumentUrlHeader[] =
    "Sec-Kabegame-Parent-Document-Url";

std::unique_ptr<InterceptedRequestHandler> CreateInterceptedRequestHandler(
    content::BrowserContext* browser_context,
    content::RenderFrameHost* frame,
    int render_process_id,
    bool is_navigation,
    bool is_download,
    const url::Origin& request_initiator,
    const GURL& document_url,          // 新增：子资源 = 所属文档；导航 = 被导航 frame 当前文档
    const GURL& parent_document_url);  // 新增：所属 frame 的父文档，主 frame 为空
```

### 修改 `resource_request_handler_wrapper.cc`
```cpp
#include "base/strings/string_util.h"   // 新增

namespace {

// 新增：渲染进程（含被攻破的）可能自带同前缀的头；页面脚本本来写不了 Sec-*。
void StripKabegameHeaders(net::HttpRequestHeaders& headers) {
  std::vector<std::string> names;
  for (const auto& header : headers.GetHeaderVector()) {
    if (base::StartsWith(header.key, kKabegameHeaderPrefix,
                         base::CompareCase::INSENSITIVE_ASCII)) {
      names.push_back(header.key);
    }
  }
  for (const auto& name : names) {
    headers.RemoveHeader(name);
  }
}

    // InitState::Initialize：修改，在 request_initiator 后新增两个参数
    void Initialize(content::BrowserContext* browser_context,
                    CefRefPtr<CefBrowserHostBase> browser,
                    CefRefPtr<CefFrame> frame,
                    const content::GlobalRenderFrameHostId& global_id,
                    bool is_navigation,
                    bool is_download,
                    const url::Origin& request_initiator,
                    const GURL& document_url,          // 新增
                    const GURL& parent_document_url,   // 新增
                    const base::RepeatingClosure& unhandled_request_callback) {
      ...
      request_initiator_ = request_initiator.Serialize();
      // 新增：建工厂时在 UI 线程定下，之后只在 IO 线程读
      document_url_ = document_url.is_valid() ? document_url.spec() : std::string();
      parent_document_url_ =
          parent_document_url.is_valid() ? parent_document_url.spec() : std::string();
      ...
    }
    CefString request_initiator_;
    std::string document_url_;         // 新增
    std::string parent_document_url_;  // 新增

  // OnBeforeRequest：补完 User-Agent 之后、IsExternalRequest / GetHandler 之前
    request->headers.SetHeaderIfMissing(net::HttpRequestHeaders::kUserAgent,
                                        init_state_->user_agent_);

    // 新增：Kabegame（07）。值在建工厂时捕获，不读 CefFrame::GetURL()（那是 DidFinishNavigation
    // 才刷新的 UI 线程缓存）。http(s) 交给网络，只删不写，本地路径不出进程。
    StripKabegameHeaders(request->headers);
    if (!request->url.SchemeIsHTTPOrHTTPS()) {
      request->headers.SetHeader(kKabegameDocumentUrlHeader,
                                 init_state_->document_url_);
      request->headers.SetHeader(kKabegameParentDocumentUrlHeader,
                                 init_state_->parent_document_url_);
    }

    const bool is_external = IsExternalRequest(request);

// 第一个 CreateInterceptedRequestHandler：修改，透传两个新参数
  init_state->Initialize(browser_context, browserPtr, framePtr, global_id,
                         is_navigation, is_download, request_initiator,
                         document_url, parent_document_url,   // 新增
                         base::RepeatingClosure());

// 第二个（HandleExternalProtocol / CreateProxyForWebContents）：修改，自定义 scheme 导航不归属
  init_state->Initialize(browser_context, browserPtr, framePtr, global_id,
                         is_navigation, is_download, request_initiator,
                         GURL(), GURL(),                      // 新增
                         unhandled_request_callback);
```

### 修改 `chrome_content_browser_client_cef.cc`
```cpp
#include "content/public/browser/navigation_handle.h"   // 新增
#include "net/base/net_errors.h"                         // 新增

namespace {
// 新增：已提交文档的 URL；没提交过或是出错页为空。先判空 URL：从未提交的 speculative / pending-commit
// host 一定是空 URL，这样 IsErrorDocument() 的 CHECK 碰不到它们（也不调对 speculative host NOTREACHED
// 的 GetLifecycleState()）。
GURL CommittedDocumentURL(content::RenderFrameHost* rfh) {
  if (!rfh) {
    return GURL();
  }
  const GURL& url = rfh->GetLastCommittedURL();
  if (url.is_empty() || rfh->IsErrorDocument()) {
    return GURL();
  }
  return url;
}

// 新增：子资源工厂所属的文档。CommitNavigation / FailedNavigation 在 ReadyToCommitNavigation 把
// NavigationRequest 移进 rfh 之后、同一个 UI 线程调用栈里建工厂，这时它就是唯一的待提交导航；
// 网络服务崩溃或 DevTools 重建工厂时没有待提交导航，取已提交文档。与 Chromium 的
// ForPendingOrLastCommittedNavigation 一致，区别是多于一条待提交导航时不猜「最新」，留空。
GURL SubresourceDocumentURL(content::RenderFrameHost* rfh) {
  const auto pending = rfh->GetPendingCommitCrossDocumentNavigations();
  if (pending.size() > 1) {
    return GURL();
  }
  if (pending.size() == 1) {
    content::NavigationHandle& navigation = *pending.front();
    return navigation.GetNetErrorCode() == net::OK ? navigation.GetURL() : GURL();
  }
  return CommittedDocumentURL(rfh);
}
}  // namespace

// WillCreateURLLoaderFactory：修改
  // 新增：Kabegame（07）
  GURL document_url;
  GURL parent_document_url;
  if (frame) {
    switch (type) {
      case URLLoaderFactoryType::kDocumentSubResource:
        document_url = SubresourceDocumentURL(frame);
        parent_document_url = CommittedDocumentURL(frame->GetParent());
        break;
      case URLLoaderFactoryType::kNavigation:
        // 这里的 frame 是被导航 frame 的 current_frame_host()：取它当前的文档
        document_url = CommittedDocumentURL(frame);
        parent_document_url = CommittedDocumentURL(frame->GetParent());
        break;
      default:
        // worker / service worker / 下载 / prefetch / DevTools：不是文档，留空
        break;
    }
  }

  auto request_handler = net_service::CreateInterceptedRequestHandler(
      browser_context, frame, render_process_id,
      type == URLLoaderFactoryType::kNavigation,
      type == URLLoaderFactoryType::kDownload, request_initiator,
      document_url, parent_document_url);   // 修改：新增两个参数
```

### 新增：worker 的 `file:` 工厂（决策 D5，推荐并进 07）
```cpp
// RegisterNonNetworkSubresourceURLLoaderFactories（06 加的 override）：在 rfh 查找之前新增
  // Kabegame（07）：worker（routing id 为 none）的 file: 工厂由 WorkerScriptFetcher 直接放进 bundle，
  // 从不经过 WillCreateURLLoaderFactory，嵌入方的 OnBeforeResourceLoad 看不到它的请求。
  // 去掉它，失败关闭：file: 文档的 worker 读不了 file:。
  if (render_frame_id == IPC::mojom::kRoutingIdNone && request_initiator_origin &&
      request_initiator_origin->scheme() == url::kFileScheme) {
    factories->erase(url::kFileScheme);
  }
```
`worker_script_fetcher.cc:626-651` 先 `emplace` `file:` 工厂，再在 `kSubResource` 分支调本函数，所以这里能删掉。
worker 主脚本走 `RegisterNonNetworkWorkerMainResourceURLLoaderFactories`，不受影响。

### 新增 `third-patches/cef/README.md` 条目（英文，与既有条目同格式）
- `07-document-url-headers.patch`：
  - **捕获**：建每个代理工厂时（`WillCreateURLLoaderFactory`，UI 线程）记下它服务的文档，存进 `InitState`。
    子资源工厂取唯一待提交导航的 URL，没有待提交导航时取已提交 URL；导航工厂取被导航 frame 当前的文档；另记父文档。
  - **写入**：`OnBeforeRequest` 先删掉 `Sec-Kabegame-*`，再给每个非 http(s) 请求写 `Sec-Kabegame-Document-Url` /
    `Sec-Kabegame-Parent-Document-Url`（可为空）。
  - **worker**：`file:` 文档的 worker 的 `file:` 工厂被去掉。
  - **用途**：嵌入方据此归属请求，不必用会竞态的 `CefFrame::GetURL()`。
  - **范围**：只改 `//cef`，不涉及公开 API、C API 或胶水层。

## 点 2 — 运行时 `protocol.rs`：文档头、`Origin` 只算一次、IPC 的 `ResourceRequestHandler`

- **新增**
  - `DOCUMENT_URL_HEADER` / `PARENT_DOCUMENT_URL_HEADER` / `PRIVATE_HEADER_PREFIX`、`DocumentAttribution`、`ipc_scheme`、
    `ipc_origin`、`file_document_origin`、`lookup_protocol`、`request_frame_of`、`strip_private_headers`、`set_origin`、
    `report_missing_document_patch`（一次性 warn）。
  - `IpcResourceRequestHandler`：实现 `resource_handler`，直接交出 `CefResourceHandler`。
    > 说明：cef-rs 的 trait 方法名是 `resource_handler`（bindings `x86_64_pc_windows_msvc.rs:25718`），`wrap_resource_request_handler!` 已在用。
- **修改**
  - `CefResourceHandler` 增加 `ipc_origin: Option<String>`；`open` 先剥私有头，再赋一次 `Origin`。
  - `GlobalSchemeHandlerFactory::create` 改用 `lookup_protocol`；IPC scheme 落到这里时 `ipc_origin = Some("null")`。
  - `RequestFrame` 只剩 `is_main` 与 `id`（B 段字段）。
- **删除**：`INITIATOR_ORIGIN_HEADER`、`apply_initiator_origin`、`origin_from_initiator`、`is_ipc_url`、`RequestFrame.url`。

```rust
/// 发起请求的 frame 身份，由 `IpcResourceRequestHandler::resource_handler` / scheme factory 的 `create(browser, frame, ..)`
/// 取得，经 `http::Request` 的 extension 交给协议 handler。不记 frame 的 URL：请求归属只看 CEF 补丁 07 的文档头
/// （见 [`DocumentAttribution`]），`frame.url()` 是导航完成才刷新的 UI 线程缓存。
#[derive(Debug, Clone)]
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,
    /// CEF 的 frame 标识；子 frame 据此收回监听登记、事件、Channel 消息与回退响应。
    pub(crate) id: Option<String>,   // 保留（B 段）；url 字段删除
}

/// CEF 补丁 07 写入的私有头。CEF 先删掉请求自带的 `Sec-Kabegame-*`（`Sec-` 前缀页面脚本也写不了），
/// 再对非 http(s) 请求写入：值为空表示 CEF 认不出所属文档，头不存在表示 CEF 没带 07。
/// 只在 `resource_request_handler` 里读一次；交给 Tauri 之前剥掉。
pub(crate) const DOCUMENT_URL_HEADER: &str = "Sec-Kabegame-Document-Url";            // 新增
pub(crate) const PARENT_DOCUMENT_URL_HEADER: &str = "Sec-Kabegame-Parent-Document-Url"; // 新增
const PRIVATE_HEADER_PREFIX: &str = "sec-kabegame-";                                  // 新增

/// 请求的归属（补丁 07）。                                                          // 新增
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DocumentAttribution {
    /// 请求带着 07 的头（值可能为空）；false：CEF 没带 07。
    pub(crate) patched: bool,
    /// 子资源：所属文档；导航：被导航 frame 当前的文档。
    pub(crate) document: Option<String>,
    /// 所属 frame 的父文档；主 frame 为 None。
    pub(crate) parent: Option<String>,
}

impl DocumentAttribution {
    pub(crate) fn of_request(request: &cef::Request) -> Self {
        let mut headers = CefStringMultimap::new();
        request.header_map(Some(&mut headers));
        Self::from_headers(headers.into_iter().map(|(name, values)| {
            (name, values.into_iter().next().unwrap_or_default())
        }))
    }

    fn from_headers(headers: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut out = Self::default();
        for (name, value) in headers {
            let slot = if name.eq_ignore_ascii_case(DOCUMENT_URL_HEADER) {
                &mut out.document
            } else if name.eq_ignore_ascii_case(PARENT_DOCUMENT_URL_HEADER) {
                &mut out.parent
            } else {
                continue;
            };
            out.patched = true;
            *slot = Some(value).filter(|value| !value.is_empty());
        }
        out
    }
}

/// IPC 请求的逻辑 scheme（Tauri 主通道 `ipc`、回退通道 `cef-ipc`），即协议注册表的键。   // 修改：替代 is_ipc_url
pub(crate) fn ipc_scheme(url: &str) -> Option<&'static str> {
    let (scheme, _) = url.split_once(':')?;
    if scheme.eq_ignore_ascii_case("ipc") {
        Some("ipc")
    } else if scheme.eq_ignore_ascii_case(crate::ipc::CEF_IPC_SCHEME) {
        Some(crate::ipc::CEF_IPC_SCHEME)
    } else {
        None
    }
}

/// IPC 请求的 `Origin`，只在这里算：                                                  // 新增：替代 origin_from_initiator
/// - 来源以 factory 级 `request_initiator` 为准（浏览器按提交的文档算好，计入 sandbox 标志）；
/// - `file:` 文档（WPE 网页壁纸）还要认出是哪一张：取 07 的文档 URL（去掉 query / fragment），且必须与
///   发起方同为 `file:`、同主机；认不出写 `null`（决策 D2），两条通道都拒绝；
/// - opaque（沙箱页、错误页）或缺失写 `null`。
/// 两者不一致时来源仍取 initiator，文档 URL 只在 initiator 认定是 `file:` 时用于细化身份。
pub(crate) fn ipc_origin(initiator: &str, doc: &DocumentAttribution) -> String {
    let initiator = initiator.trim();
    if initiator.is_empty() || initiator == "null" {
        return "null".to_string();
    }
    if !crate::file_access::is_file_url(initiator) {
        return initiator.to_string();
    }
    doc.document
        .as_deref()
        .and_then(|document| file_document_origin(initiator, document))
        .unwrap_or_else(|| "null".to_string())
}

fn file_document_origin(initiator: &str, document: &str) -> Option<String> {   // 新增
    let mut url = url::Url::parse(document).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    // `url::Origin::Serialize`：本地文件为 "file://"，UNC 为 "file://<server>"
    let initiator_host = initiator.get("file://".len()..).unwrap_or_default();
    if !url.host_str().unwrap_or_default().eq_ignore_ascii_case(initiator_host) {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}

fn lookup_protocol(browser_id: i32, scheme: &str) -> Option<(String, Arc<ProtocolHandler>)> {   // 新增
    let guard = registry().lock().ok()?;
    let entry = guard.get(&browser_id)?;
    Some((entry.label.clone(), entry.schemes.get(scheme)?.clone()))
}

fn request_frame_of(frame: &Frame) -> RequestFrame {   // 新增：scheme factory 与 IPC handler 共用
    RequestFrame {
        is_main: frame.is_main() == 1,
        id: Some(CefString::from(&frame.identifier()).to_string()).filter(|id| !id.is_empty()),
    }
}

wrap_resource_request_handler! {
    /// IPC 请求（`ipc` / `cef-ipc`）的单一入口：`resource_request_handler` 算好来源后返回它，CEF wrapper 在
    /// `ContinueShouldInterceptRequest` 里先问 `GetResourceHandler`，这里直接交出 Tauri 的协议 handler，
    /// 不经私有头、不经 scheme factory。注册表里没有这个 browser（弹窗、DevTools）时返回 None，请求落到
    /// scheme factory，后者同样查不到就不处理，CEF 以 ERR_UNKNOWN_URL_SCHEME 结束：失败关闭。
    pub(crate) struct IpcResourceRequestHandler {   // 新增
        scheme: &'static str,
        origin: String,
    }
    impl ResourceRequestHandler {
        fn resource_handler(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            let (label, protocol) = lookup_protocol(browser?.identifier(), self.scheme)?;
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
                frame.map(|frame| request_frame_of(frame)),
                Some(self.origin.clone()),
            ))
        }
    }
}

// GlobalSchemeHandlerFactory::create：修改
            let (label, protocol) = lookup_protocol(browser?.identifier(), &self.logical_scheme)?;
            // IPC 正常经 IpcResourceRequestHandler 交出；走到这里说明没被归属（下载 / 导航到 ipc、没有
            // browser 的请求等）。Origin 写 null：主通道 Tauri 回 500、回退通道交给 ACL 拒绝，失败关闭。
            let ipc_origin = ipc_scheme(&format!("{}:", self.logical_scheme)).map(|scheme| {
                tracing::debug!("unattributed {scheme} request reached the scheme factory");
                "null".to_string()
            });
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
                frame.map(|frame| request_frame_of(frame)),
                ipc_origin,
            ))

// CefResourceHandler：修改
    struct CefResourceHandler {
        webview_label: String,
        protocol: Arc<ProtocolHandler>,
        state: Arc<Mutex<ResponseState>>,
        request_frame: Option<RequestFrame>,
        /// IPC 请求要交给 Tauri 的 `Origin`；其它协议（`tauri://` 等）为 None，不动 Origin。
        ipc_origin: Option<String>,   // 新增
    }
        fn open(...) -> c_int {
            ...
            let mut request = match request_to_http(request) { ... };
            strip_private_headers(&mut request);              // 新增：07 的头不交给 Tauri / 应用协议
            if let Some(origin) = self.ipc_origin.as_deref() {
                set_origin(&mut request, origin);             // 修改：替代 apply_initiator_origin，唯一一次赋值
            }
            attach_request_frame(&mut request, self.request_frame.as_ref());
            ...
        }

fn strip_private_headers(request: &mut HttpRequest<Vec<u8>>) {   // 新增
    let names: Vec<_> = request
        .headers()
        .keys()
        .filter(|name| name.as_str().starts_with(PRIVATE_HEADER_PREFIX))
        .cloned()
        .collect();
    for name in names {
        request.headers_mut().remove(name);
    }
}

fn set_origin(request: &mut HttpRequest<Vec<u8>>, origin: &str) {   // 新增
    let value = http::HeaderValue::from_str(origin)
        .unwrap_or_else(|_| http::HeaderValue::from_static("null"));
    request.headers_mut().insert(http::header::ORIGIN, value);
}

/// 请求涉及 `file:` 文档却没带 07 的头：CEF 没重编。只报一次。                 // 新增
pub(crate) fn report_missing_document_patch() {
    static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REPORTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!(
            "CEF patch 07 missing (no {DOCUMENT_URL_HEADER}): IPC and file: access of file: documents are denied until CEF is rebuilt"
        );
    }
}
```
> 说明：
> - **线程**：`resource_handler` 与 scheme factory 的 `create` 一样在 IO 线程，交出的是同一种 `CefResourceHandler`，
>   `Open` / `Read` / `cont()` 的线程语义不变。
> - **注册表**：`PROTOCOL_REGISTRY` 在 `on_browser_created` 写入，早于页面任何请求。弹窗 / DevTools 拿不到 `pending_protocols`，
>   查不到时现状和改后都失败。
> - **单测**（替换旧的 `initiator_*` / `non_file_frame_origin_is_untouched` / `frame(url)` 辅助函数）：
>   - `ipc_scheme_is_recognized`
>   - `ipc_origin_keeps_initiator_for_non_file_documents`：`tauri://localhost`、`https://example.com`；文档 URL 是 `file:` 也不改。
>   - `ipc_origin_identifies_file_documents`：`file:///D:/wpe/1/index.html?x#y` → 去掉 `?x#y`。
>   - `ipc_origin_fails_closed`：`null` / 空 / `file://` 配无文档 / `about:srcdoc` / `tauri://…` / UNC 主机不符，都得 `null`。
>   - `document_attribution_reads_headers`：头不存在 → `patched == false`；空值 → `patched`、`None`。
>   - `private_headers_are_stripped_and_origin_set_once`。
>   - `request_frame_is_reported_to_tauri_acl`（B 段版本，不带 url）。

## 点 3 — 运行时 `webview.rs`：一个入口读一次文档头，删 `IpcInitiatorHandler`

- **修改**：`resource_request_handler` 按下面重写。
  - IPC 不看导航，导航或下载到 `ipc:` 的请求交给兜底。
  - `app_page_subresource` 的最后一个条件由 `frame.url()` 改为文档头。
  - `classify_file_requester` 改用文档头和父文档头。
  - 缺 07 时只在「真正需要它」的请求上报一次：带 `file:` 发起方的 IPC，以及不免检的 `file:` 请求。应用页的图库媒体免检，
    不会在 macOS / Linux 上误报。
- **修改**：`ipc::install_post_message_bridge(&mut pending, detached)` 去掉 `initial_url`（`webview.rs:1611-1612`，见点 4）。
- **删除**：`IpcInitiatorHandler`、`frame_url` / `parent_url` 的读取，以及它们的注释。

```rust
            // 非下载请求只在这里归属一次（CEF 补丁 07 的文档头，见 protocol::DocumentAttribution）：
            // - IPC（`ipc` / `cef-ipc`）：按发起方 origin 与文档 URL 算出 Origin，交给 IpcResourceRequestHandler
            //   直接产出 Tauri 协议 handler（不经私有头与 scheme factory）；
            // - 登记了任一文件访问能力（04 / 05）的 webview 的 `file:` 请求按发起方分档（见 file_access）。
            fn resource_request_handler(
                &self,
                browser: Option<&mut Browser>,
                frame: Option<&mut Frame>,
                request: Option<&mut Request>,
                is_navigation: ::std::os::raw::c_int,
                is_download: ::std::os::raw::c_int,
                request_initiator: Option<&CefString>,
                _disable_default_handling: Option<&mut ::std::os::raw::c_int>,
            ) -> Option<ResourceRequestHandler> {
                if is_download != 1 {
                    let request = request?;
                    let url = CefString::from(&request.url()).to_string();
                    let ipc_scheme = crate::protocol::ipc_scheme(&url);
                    let is_file_request = crate::file_access::is_file_url(&url);
                    if ipc_scheme.is_none() && !is_file_request {
                        return None;
                    }
                    let initiator = request_initiator.map(|i| i.to_string()).unwrap_or_default();
                    let doc = crate::protocol::DocumentAttribution::of_request(request);   // 新增：只读一次
                    if let Some(scheme) = ipc_scheme {
                        // IPC 从来不是导航；导航到 ipc 的请求落到 scheme factory 的兜底（Origin 为 null）
                        if is_navigation != 0 {
                            return None;
                        }
                        if !doc.patched && crate::file_access::is_file_url(&initiator) {
                            crate::protocol::report_missing_document_patch();
                        }
                        let origin = crate::protocol::ipc_origin(&initiator, &doc);
                        return Some(crate::protocol::IpcResourceRequestHandler::new(scheme, origin));
                    }
                    if !crate::file_access::is_file_document_webview(&self.label) {
                        return None;
                    }
                    let frame_is_main = frame.as_ref().is_some_and(|frame| frame.is_main() == 1);
                    // 应用页主 frame 的子资源（图库媒体）：发起方 origin 与所属文档都不是 file: 才免检
                    let app_page_subresource = is_navigation == 0
                        && frame_is_main
                        && !initiator.is_empty()
                        && initiator != "null"
                        && !crate::file_access::is_file_url(&initiator)
                        && !doc.document.as_deref().is_some_and(crate::file_access::is_file_url);   // 修改
                    if app_page_subresource && crate::file_access::app_page_open(&self.label) {
                        return None;
                    }
                    if !doc.patched {
                        crate::protocol::report_missing_document_patch();
                    }
                    let requester = crate::file_access::classify_file_requester(   // 修改：不再传 frame / parent URL 与 initiator
                        frame_is_main,
                        is_navigation != 0,
                        doc.document.as_deref(),
                        doc.parent.as_deref(),
                    );
                    return Some(FileDocumentGuardHandler::new(self.label.clone(), requester));
                }
                let referrer = browser
                    .and_then(|b| b.main_frame())
                    .map(|f| CefString::from(&f.url()).to_string())
                    .filter(|s| !s.is_empty());
                Some(DownloadReferrerHandler::new(referrer))
            }
```
> 说明：`FileDocumentGuardHandler` 及其 `deny file:` 日志取工作区现有的 B 段版本（带 `requester`），不动。

## 点 4 — 运行时 `ipc.rs`：回退通道只认协议层写好的 `Origin`

- **修改**
  - `install_post_message_bridge` 去掉 `initial_url` 参数，`post_message_request` 去掉 `initial_url` / `fallback_url`。
    回退通道不再退到任何地址；`is_same_origin_as` 删除。
  - `Origin` 不合法（只可能是协议层写的 `null`）或装不进 `http::Uri` 时，主 frame、子 frame、未知 frame 一律用占位来源
    交给 ACL 拒绝（决策 D1）。
  - 占位常量改名为 `UNATTRIBUTED_IPC_ORIGIN = "kabegame-unattributed://ipc/"`。
  - 模块注释的「来源判定」段重写。
- **删除**：frame URL 退路、初始 URL 退路，以及 B 段的 `main_frame_at` / `missing_origin_falls_back_to_frame_url` /
  `valid_origin_wins_over_frame_url` / `unknown_main_frame_url_falls_back_to_initial_url` 与 srcdoc 的 frame URL 断言。

```rust
//! 来源判定：Tauri 按交给 `ipc_handler` 的请求 URI 区分本地 / 远程来源，这里只取 `Origin` 头。它已由协议层
//! 写好（`crate::protocol::ipc_origin`：发起方 origin，`file:` 文档为 CEF 补丁 07 捕获的完整文档 URL，
//! 认不出为 `null`），本通道不找任何替代地址：不合法时用占位来源交给 ACL 拒绝，错误回调送回发起调用的 frame，
//! 页面的 Promise 会 reject；退到 frame URL 或 webview 初始 URL（应用页）都可能把页面判成本地来源。

/// 认不出来源时交给 Tauri 的占位来源：不是已注册的自定义协议（Tauri 判成远程），不匹配任何 capability
/// 的 `remote.urls`，于是请求在 ACL 被拒。不要给任何 capability 配匹配一切的远程模式。
pub(crate) const UNATTRIBUTED_IPC_ORIGIN: &str = "kabegame-unattributed://ipc/";   // 修改：原 UNATTRIBUTED_SUBFRAME_ORIGIN

pub(crate) fn install_post_message_bridge<T: UserEvent>(
    pending: &mut PendingWebview<T, Cef<T>>,
    detached: DetachedWebview<T, Cef<T>>,          // 修改：删 initial_url
) {
    ...
        let response = match post_message_request(request) {   // 修改
    ...
}

fn post_message_request(request: HttpRequest<Vec<u8>>) -> Result<HttpRequest<String>, String> {
    if request.method() != http::Method::POST {
        return Err("CEF IPC postMessage only accepts POST".to_string());
    }
    // Tauri 的 handle_ipc_message 会对该 URI 做 `Url::parse(...).expect(...)`：不合法的（null）与装不进
    // `http::Uri` 的来源都换成占位来源，交给 ACL 拒绝，而不是回 400 让页面挂起。
    let http_uri = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| url::Url::parse(value).is_ok())
        .map(http_uri_for)
        .filter(|uri| uri.parse::<http::Uri>().is_ok())
        .unwrap_or_else(|| UNATTRIBUTED_IPC_ORIGIN.to_string());
    // 重新构造请求会丢掉全部 extension：把 Tauri 要用的 frame 位置与子 frame 标识带过去（B 段，不变）
    let ipc_frame = request.extensions().get::<IpcFrame>().copied().unwrap_or(IpcFrame::Unknown);
    let subframe_id = request.extensions().get::<SubframeId>().cloned();
    ...
}
```
> **单测**（合并后改写）：
> - `frame_and_subframe_id_survive_the_rebuilt_request`：保留 B 段版本。
> - `main_frame_is_accepted_with_any_origin`、`cross_origin_subframe_is_accepted_as_sub`：保留。
> - `invalid_origin_uses_placeholder`：主 / 子 / 未知 frame，`null` 或缺失都得到占位来源。取代 HEAD 的
>   `invalid_origin_is_rejected_without_fallback` 和 B 段的 `subframe_without_origin_or_frame_url_is_rejected`。
> - `file_document_origin_survives_http_uri`：`file:///D:/wpe/1/index.html` → Tauri 拿到同一个 URL。取代断言 `file:///` 的旧用例。
> - `file_url_survives_http_uri`：保留。

## 点 5 — 运行时 `file_access.rs`：闸门只看文档头

- **修改**
  - `classify_file_requester` 改为 `(frame_is_main, is_navigation, document_url, parent_document_url)`。
  - 父文档未知的子 frame 导航判拒绝。
  - `about:` 子文档的子资源继承父文档（决策 D4）。
  - `FileRequester::Target` 的注释改为「应用页发起的子 frame 导航（父文档已知且不是 `file:`）」。
  - 模块注释分档表改用「文档头」表述，并删掉「已知限制」段。
- **删除**：「非导航、认不出文档但发起方 origin 是 `file:` → Target」这条临时规则，以及参数 `initiator`。

```rust
/// 给不免检的 `file:` 请求认发起方。参数都来自 CEF 补丁 07 的文档头（浏览器建工厂时捕获，页面无法伪造）：
/// - `document_url`：子资源是所属文档；导航是被导航 frame 当前的文档；
/// - `parent_document_url`：所属 frame 的父文档（主 frame 为空）。
/// None 表示 CEF 认不出（或没带 07），一律按失败关闭处理。
///
/// 规则：文档是 `file:` → 这个文档（子资源、自身导航；应用页把它的 `src` 直接换成另一张壁纸也算它发起，会被拒，
/// `WallpaperStage` 每次切换都重建 iframe）。子 frame 导航：父文档是 `file:` → 父文档；父文档已知但不是 `file:`
/// → 应用页发起，按目标；父文档未知 → 拒绝。非导航的 `about:blank` / `about:srcdoc` 子文档 → 父文档（内容与 origin
/// 都来自它）。其余拒绝。
pub(crate) fn classify_file_requester(
    frame_is_main: bool,
    is_navigation: bool,
    document_url: Option<&str>,
    parent_document_url: Option<&str>,
) -> FileRequester {
    if let Some(doc) = document_url.and_then(file_url_path) {
        return FileRequester::Document(doc);
    }
    let parent = parent_document_url.filter(|url| !url.is_empty());
    if is_navigation {
        if frame_is_main {
            return FileRequester::Deny;
        }
        return match parent {
            Some(url) if is_file_url(url) => file_url_path(url).map_or(FileRequester::Deny, FileRequester::Document),
            Some(_) => FileRequester::Target,
            None => FileRequester::Deny,   // 新增：父文档未知即拒（原先按目标放行）
        };
    }
    if document_url.is_some_and(inherits_parent_document) {   // 新增（D4）
        if let Some(parent) = parent.and_then(file_url_path) {
            return FileRequester::Document(parent);
        }
    }
    FileRequester::Deny   // 修改：认不出文档的非导航请求一律拒（删掉「发起方是 file: 就按目标」）
}

/// `about:blank` / `about:srcdoc`：内容与 origin 继承创建它的父文档。   // 新增
fn inherits_parent_document(url: &str) -> bool {
    url.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("about:"))
}
```
> **单测** `requester_classification` 改写：
> - 文档 `file:` 的子资源与自身导航 → `Document(doc)`。
> - 壁纸里新 iframe 导航（文档空、父 `file:`）→ `Document(父)`。
> - 应用页赋 `src`（文档空或 `about:blank`、父 `http://localhost:1420/…`）→ `Target`。
> - 子 frame 导航、父文档未知 → `Deny`。
> - 主 frame 导航 → `Deny`。
> - `about:srcdoc` 子资源、父 `file:` → `Document(父)`；父是应用页 → `Deny`。
> - 文档未知的非导航请求 → `Deny`，这条取代原「CEF 还没刷新 frame URL」用例。
>
> `gate_scopes_documents_to_their_own_wallpaper` 不变。

## 点 6 — 应用侧

- **修改 `src-tauri/kabegame/src/commands/wpe_web.rs`**：只动测试与注释。`wpe_web_pull_state` / `caller_document` 不改，
  `CallerOrigin` 仍是完整文档 URL，cef-ipc 时为 `file://localhost/…` 归一后的同一 URL。测试改动：
  - `wpe_web_capability_pattern_matches_file_urls` 删掉根 `file:///` 与 `file://localhost/` 两条断言，以及引用
    `origin_from_initiator` 的注释。D2 选 `null` 后运行时不再产出它们；若 D2 选另一方案，这两条保留。
  - 保留完整入口、百分号编码、`file://localhost/D:/…` 与各否定断言。
  - `caller_origin_maps_to_a_document_path`（B 段）保留。
- **修改 `src-tauri/kabegame/src/webview_js/wpe_shim.js`**：删除 `retrying`（决策 D7）。
  ```js
  // 删除：function retrying(task, label) { … }（07 起新文档首批请求就带正确来源；再失败就是真失败）
  var transport = {
    pull: function () {
      return internals.invoke("wpe_web_pull_state");
    },
    listen: function (names, onEvent) {
      return Promise.all(
        names.map(function (name) {
          var handler = internals.transformCallback(function (event) {
            onEvent({ name: name, payload: event.payload });
          });
          return internals.invoke("plugin:event|listen", { event: name, handler: handler });   // 修改：不再重试
        }),
      );
    },
  };
  function pull() {
    var seq = ++issued;
    transport.pull().then(   // 修改：首个状态也只拉一次，失败记日志、等下一次相关事件
      function (state) { if (!state || seq <= applied) return; applied = seq; receive(state); },
      function (error) { console.warn("[kb-wpe] pull", error); },
    );
  }
  ```
- **修改 `apps/kabegame/src/components/wallpaper/WallpaperStage.vue:568`**：超时文案改为
  `"wpe web entry not navigated (CEF patch 05/07 missing? check the deny file: log)"`。头注释第 19 行同步提到 07。
  未带 07 时 iframe 导航因父文档未知被拒，表现与缺 05 相同。
- **修改 `AGENTS.md`**：`x-wpe/web` 一段「命令按调用方文档 URL（`tauri::ipc::CallerOrigin`）认出是哪张」后补
  「（文档 URL 由 CEF 补丁 07 在建子资源工厂时捕获，闸门同样据此判发起方）」。
- **不改**：`capabilities/wpe-web.json`、tauri 补丁 18 / 19。18 里 `CallerOrigin` 的文档注释「runtime rewrites the
  `Origin` of `file:` frames to the full document URL」仍然成立。

## 点 7 — 合并冲突逐文件

先在工作区按下表解决，再处理自动合并但已失效的部分，最后跑点 8 的单测与 check。提交切分见决策 D8，推荐方案 A。

| 文件 / 冲突块 | 取哪边 | 改写成 |
| --- | --- | --- |
| `tauri-runtime-kbcef/src/protocol.rs` L50-71 `RequestFrame` | B 段结构（`is_main` + `id`），不要 `url` | 用点 2 的文档注释 |
| 同上 L149-153 factory `create` | B 段的 `id` 行，删 `url` 行 | 整段换成点 2 的 `lookup_protocol` / `request_frame_of` / IPC 兜底 |
| 同上 L395-433 | 都不原样取 | 删 `is_ipc_url` / `origin_from_initiator` / `apply_initiator_origin`；新增点 2 的常量、`DocumentAttribution`、`ipc_scheme`、`ipc_origin`、剥头函数；`attach_request_frame` 的注释取 B 段 |
| 同上测试 L546-556、L574-631、L662-671 | 都不原样取 | 删 B 段的 `frame(url)`、`non_file_frame_origin_is_untouched`，以及 HEAD 的 `initiator_*`；按点 2 列表新写；`sub` 取 B 段、去掉 `url` |
| 同上自动合并区（`open()` 里的 `apply_initiator_origin`、`request_frame_does_not_touch_origin`） | — | `open()` 按点 2 改；该测试的 `RequestFrame { is_main: true }` 补 `id: None` |
| `tauri-runtime-kbcef/src/ipc.rs` L23-38 模块注释 | 都不取 | 点 4 的「来源判定」 |
| 同上 L128-178 | 都不取 | 点 4 的 `post_message_request`；不保留 HEAD 的同源子 frame 检查（B 段已放行子 frame，交给 ACL），也不保留 B 段的 frame URL / 初始 URL 退路 |
| 同上测试 L236-247、L367-377、L406-414 | B 段的 `id`，去掉 `url` | 删 `main_frame_at`、`unknown_main_frame_url_falls_back_to_initial_url` |
| 同上自动合并区（B 段测试 `subframe_without_origin_or_frame_url_is_rejected`、`missing_origin_falls_back_to_frame_url`、`valid_origin_wins_over_frame_url`、`unknown_frame_keeps_previous_behavior`；HEAD 的 `invalid_origin_is_rejected_without_fallback`、`file_document_origin_is_remote_file`） | — | 按点 4 的测试列表改写。这些区域没有冲突标记，但引用了已删除的 `RequestFrame.url`，代码里还有 `fallback_url` 变量（函数签名却是 `initial_url`），去掉标记后也编译不过 |
| `tauri-runtime-kbcef/src/webview.rs` L843-853 | 都不取 | 整个 `resource_request_handler` 换成点 3 |
| 同上 L1073-1105 | 注释取 B 段 | 删除 `IpcInitiatorHandler` |
| 同上自动合并区（`install_post_message_bridge(&mut pending, detached, initial_url)`，L1611-1612） | — | 去掉 `initial_url`；变量 `initial_url` 若无其它用处一并删 |
| `tauri-runtime-kbcef/src/subprocess.rs` L169-178 注释 | 都不取 | 「每个子 frame 都先注入 Tauri 的 IPC 桥（无条件，不看地址）：子 frame 的请求记为 `Sub`、带 `SubframeId`，能调什么完全由 ACL 决定。`file:` 文档（WPE 网页壁纸）也照常注入：IPC 来源由浏览器进程按发起方 origin 与 CEF 补丁 07 捕获的文档 URL 合成（`protocol::ipc_origin`），只得 `wpe-web-capability`；all-frames 脚本自己按地址判断是否启用。」 |
| `tauri-runtime-kbcef/src/file_access.rs`（自动合并 = B 段） | — | 按点 5 改 |
| `kabegame/src/commands/wpe_web.rs` L311-328 | B 段的文档注释（「绑定 `main` + `wallpaper`、`frames: "sub"`」） | 删 HEAD 的 `preview_root_rejects_wallpaper_window`（`check_preview_label` 已随 B 段删除）；测试体按点 6 |
| `kabegame/src/webview_js/wpe_shim.js`（自动合并 = B 段） | — | 按点 6 删 `retrying` |
| `cocs/README.md` L113-141（WPE 条目） | B 段 | 「运行时把 `file:` frame 的 IPC `Origin` 改写成 frame URL」改为「运行时按发起方 origin 与 CEF 补丁 07 的文档 URL 合成 IPC `Origin`（`file:` 文档为完整入口 URL，认不出为 `null`）」；删「首批请求有退避重试」；适用场景补「收不到属性且日志有 `CEF patch 07 missing`（未重编 CEF）」。见点 9 |
| `cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md` L295-310 | B 段骨架 | 合并 HEAD 那段「不要用 `frame.url()` 判来源」的理由，来源改述为 initiator + 07 文档 URL。见点 9 |
| `cocs/wpe/WPE_IMPORT.md` L178-279 | B 段（iframe 形态） | 「IPC」小项改写为 07 版；HEAD 关于 `pin_file_frame_origin` 竞态的历史段压缩成一句「历史」引用，放进该小项 |
| 同上 L473-494（IPC 纵深防御） | B 段 | 「来源取值收紧为 `Origin` 头 → frame URL」改为「`Origin` 由协议层写好，回退通道不合法即占位来源」 |
| 同上 L538-559（涉及文件） | B 段 | `protocol.rs` / `ipc.rs` 的括注改为「`IpcResourceRequestHandler`、`ipc_origin`、07 文档头、回退通道占位来源」，并补 `third-patches/cef/07-document-url-headers.patch` |
| `tauri-runtime-kbcef/README.md` L43-50 | B 段的三行 | 文件访问一行改「按发起方分档」的判定描述；IPC 来源一行重写；子 frame IPC 一行的「回退通道」小句重写。见点 9 |
| `versions/latest/regression.md` L3-56 | **两节都保留**，HEAD 一节在前 | 两节之上新增「CEF 补丁 07」一节，并按点 9 给两节加注 |

> 其余非冲突的自动合并部分已核对：
> - `protocol.rs` 的 `open()` 已是 24ee52ce 的 `apply_initiator_origin`，`attach_request_frame` 里没有 `pin_file_frame_origin`。
> - `file_access.rs` 与 `wpe_shim.js` 等于 origin/main。
> - WPE 滑块按步长对齐（24ee52ce）照常合入。

## 点 8 — 验证

### 单测与静态检查
- **补丁序列**：
  - 在已套 01–06 的 `third/cef` 工作区里改源码，然后运行
    `deno task patch cef --gen --from 06 --out third-patches/cef/07-document-url-headers.patch`。只读工作树，不 reset。
  - 再跑 `deno task patch cef --check`。
  - 最后 `deno task patch cef`（reset + apply）确认可复现。
  - 按记忆，Windows 沙箱里跑不了 `--gen` / `--check`，要在沙箱外执行。
  - 不要在 `--gen` 之前跑 `deno task patch cef`，它会抹掉工作区里的改动。
- **runtime**：`.claude/skills/test-kabegame/driver.sh kabegame -p tauri-runtime-kbcef --lib`（沿用 S1 的 `CARGO_TARGET_DIR=target-check`）。
  覆盖点 2 / 4 / 5 列出的用例，以及 B 段既有的闸门五种情况、`SubframeId` 重建保留等。
- **应用**：`driver.sh kabegame --lib wpe_web`。
- **check**：`check-kabegame`，Windows 与 macOS 各跑一次（W12 的 Windows 分支）。改动文件逐个 `rustfmt --check`；
  `wpe_shim.js` 用 Prettier。

### 重编 CEF（Windows）
- **脚本流程**（`scripts/build-chromium.ts`）：
  - `stageCefPatchesAsCommit()` 把 `third/cef` 工作区固化成 `kabegame-build` 分支的提交。patch 变了，hash 就变。
  - `configureUpdate()` 走增量：`--no-chromium-update --force-build --force-distrib`。
  - `runBuild()` 因 hash 变化先跑阶段 A，只同步（`--no-build --no-distrib`，src/cef 整删重拷）。前后做 `(sha1, mtime)` 快照与
    mtime 保全，`build.log` / `sync.log` 的「真实变更」应只列出 07 改的 3 个文件。
  - 阶段 B 编译、`make_distrib`，再由 `exportCefRuntime()` 导出到 `bin/windows/x64/cef-build`。
- **命令**：在 MSYS2 里运行（VS x64 Native Tools 环境，`msys2_shell.cmd -use-full-path`）：
  `CEFBUILD=/d/Codes/cefbuild deno task build:chromium`。
- **耗时**：重编只涉及 3 个文件和包含 wrapper 头的少数 TU；大头是 official + PGO 构建下 libcef 的 LTO 重链接，
  以及 make_distrib 与导出。仓库没有记录这种情况的耗时，**推断为数十分钟到一两小时**，以 `build.log` 为准，结果记入回归表。
- **之后**：完全重启 dev（libcef.dll 换了）。helper 不用重编：没有 ABI 变化，改动只在浏览器进程侧代码。

### Windows 真机（新回归节 D 系列，取代 B 段 W1 / W7 / W8 / W10 / W11 与 Phase 7 用例 12 的方法）
- **D1 首批请求**（取代 W11 与用例 12 的方法）：
  - 用 kabegame-chromium 连壁纸窗口和主窗口页，`Target.setAutoAttach({ autoAttach: true, flatten: true, waitForDebuggerOnStart: true })`。
    iframe 若是 OOPIF，附着时处于暂停状态，先 `Runtime.enable` / `Log.enable` / `Network.enable`，再 `Runtime.runIfWaitingForDebugger`。
    同进程 iframe 就在页面 target 上按 `frameId` 过滤。
  - 同时临时插桩 `// DEBUG-0007`：在 `resource_request_handler` 用 `kb_debug!` 记 `{url, initiator, document, parent, patched,
    origin / requester}`，读 `.kabegame/debug/debug-<session_id>.ndjson`，按事件自带的 `ts` 排序。
  - `set_wallpaper_by_image_id` 在网页壁纸之间互切 ≥10 次，与普通图片互切 ≥10 次；预览里同样切换。
  - 预期：
    - 每个新文档的**第一个** `ipc://` 请求的 origin 就是该壁纸入口的完整 URL。
    - 第一次 pull 就成功，`imageId` 等于目标。
    - console 里没有 `[kb-wpe]` 警告，插桩里没有 `patched=false` 或空的 document。
- **D2 拉取属性与改语言**（取代 W1）：预览与桌面各显示一张带作者属性的网页壁纸，然后切换界面语言。两处都拉到属性，
  并都跟随语言变化。
- **D3 闸门与首批请求**（取代 W7）：
  - 做一个测试壁纸目录（`project.json` + `index.html`），`<head>` 里的内联脚本**立刻**依次 fetch 同目录的 `data.json`、
    另一张库内网页壁纸目录下的文件、库外的 `C:/Windows/win.ini`，把结果打到 console。
  - 用「壁纸 → 添加文件夹」导入后预览，并设为桌面。
  - 预期：同目录成功，另两类被拒，日志 `deny file: … requester Document(…)`。首个请求也一样。
- **D4 冷启动**（取代 W8）：当前桌面是 D3 的测试壁纸时重启应用。第一次加载就拉到属性，读到同目录文件和用户选的目录。
- **D5 文件 / 目录属性**（取代 W10）：
  - 选目录后，页面最早的请求就能读到其中文件。
  - 换目录后，旧目录立即被拒。
  - 另一张壁纸读不到这张的选择。
- **D6 cef-ipc 回退认壁纸**（补充 24ee52ce 项 2 的 iframe 形态）：在 iframe 里让 `fetch(ipc://…)` 失败，迫使 Tauri 改走 `cef-ipc`。
  预期 pull 成功、`imageId` 正确（Tauri 拿到 `file://localhost/…` 归一后的 URL），`get_plugins` 被 ACL 拒绝。
- **D7 opaque 来源**（改写 24ee52ce 项 5，取决于 D1）：在畅游页里放 `sandbox="allow-scripts"` 的 iframe，以及 CSP `sandbox` 页面。
  预期主通道 500、Promise reject；强制回退后 `cef-ipc` 用占位来源，ACL 拒绝，Promise 也 reject，不再挂起。
- **D8 拉直后的全窗口 IPC 冒烟**：这条链路改动影响每个窗口。
  - 主窗口：普通命令、raw body invoke（octet-stream）、大 Channel 消息（`start_app_log_stream`）、listen `images-added`。
  - 畅游：example.com 与 x.com 的地址上报、右键下载、一键下载。
  - 运行一次 WebView 插件任务。
  - 壁纸窗口应用页的握手与 ping。
  - 预期全部正常，dev 日志里没有 `unattributed … scheme factory`。
- **D9 未归属的 IPC 失败关闭**：页面里 `<a download href="ipc://localhost/get_plugins">`，以及 `iframe.src = "ipc://…"`。
  预期都不执行命令。
- **D10 未带 07 的 CEF**（可选，需保留旧 `cef-build`）：
  - 网页壁纸 iframe 导航被拒，退回作者预览图。
  - 日志里有一次 `CEF patch 07 missing` 和 `deny file: … requester Deny`。
  - 主窗口、畅游正常；壁纸窗口应用页照常应答 ping，不进入重载循环。
- **D11 worker 读 `file:`**（D5 决策）：在测试壁纸里 `new Worker("w.js")`，worker 去 fetch 库外文件和同目录文件。
  - 补丁前先测一次，确认是否真能读到（用来证实漏洞）。
  - 补丁后两者都失败。

### macOS / Linux 影响面
- **拉直后的 IPC 链路**：不需要重编 CEF，三平台立即生效。在 macOS 与 Linux 上跑 D8 的子集（主窗口、畅游、Channel、raw body）。
- **未重编时**：
  - 图库媒体照常免检：缺头时文档不是 `file:`，`app_page_open` 仍放行。
  - B7 的 `file:///etc/hosts` iframe 照样被拒。日志由 `requester Target … NoRoot` 变为 `requester Deny`，并多一次 `07 missing` warn。
    B7 的预期文案要改。
- **重编**：07 是平台无关代码。macOS / Linux 在下一次重编 CEF 时带上即可，属于一致性要求，不影响功能。
  Linux 按 `cocs/build/LINUX_BUILD_WORKFLOW.md`，chromium 构建可在 host 进行。
- **Android / Web**：不链接 CEF，不受影响。A1 仍是冒烟项。

## 点 9 — 文档、回归、changelog

- **新增 / 修改 `third-patches/cef/README.md`**：07 条目（点 1）。
- **修改 `src-tauri/tauri-runtime-kbcef/README.md`**：
  - 「文件访问」行：分档判定改述为「CEF 补丁 07 的文档头 / 父文档头」，删掉 `frame.url()` 与「暂按目标」。
  - 「`file:` 文档的 IPC 来源」行：重写为 `IpcResourceRequestHandler` + `ipc_origin`（initiator 定来源，`file:` 用文档 URL，
    认不出写 `null`），并写明 scheme factory 兜底失败关闭。
  - 「子 frame IPC」行的回退通道小句：改为「`Origin` 不合法即占位来源 `kabegame-unattributed://ipc/`」。
  - 「IPC `Origin`」要点（原 L98）：删掉 `pin_file_frame_origin`。
  - CEF 补丁依赖处补 07。
- **修改 `cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md`**：
  - 「远程 `file:` 来源」段：来源与身份由 initiator + 07 合成；保留「不要用 `frame.url()` 判来源」的理由。
  - 「调用方来源」：完整文档 URL 由 07 捕获。
  - 「来源回退」：所有 frame 都用占位来源。
  - 「已知限制」：删掉 frame URL 竞态与退避重试那句。
- **修改 `cocs/wpe/WPE_IMPORT.md`**：
  - 「网页壁纸 iframe」一节的 IPC 小项。
  - 「图库媒体」分档表：「`frame.url()` 是 `file:`」改为「文档头是 `file:`」，删「认不出文档」一行与「已知限制」。
  - 「运行时垫片」删退避重试那条。
  - 「IPC 纵深防御」。
  - 「七、已知边界」：删 frame URL 一条，新增「未带 07 的 CEF 上网页壁纸失败关闭、退回预览图」以及「worker 不能读 `file:`」（取决于 D5）。
  - 「八、涉及文件」。
- **修改 `cocs/README.md`**：
  - WPE 条目，同点 7。
  - `../src-tauri/tauri-runtime-kbcef/README.md` 条目：补「IPC 由 `GetResourceHandler` 直出、07 文档头归属请求」，
    适用场景补「IPC 来源 / 调用方身份 / `deny file:` 的 requester 不对」。
  - `../third-patches/cef/README.md` 条目：补 07 的一句主题与适用场景（「请求归属依赖 frame URL 竞态」「worker 的 `file:` 请求绕过闸门」）。
- **修改 `AGENTS.md`**：见点 6。
- **修改 `versions/latest/regression.md`**：
  - 新增顶部一节「CEF 补丁 07：文档 URL 随子资源工厂下发 + IPC 链路拉直」。
    - 说明段：问题、做法、需重编 CEF、未重编时失败关闭的表现。
    - 表格行：P1 补丁序列、P2 重编 CEF（记耗时与「真实变更」清单）、S1–S3 单测与 check、D1–D11、M（macOS / Linux 冒烟与 B7 预期改写）。
  - HEAD 一节「CEF 运行时：IPC 来源按发起方 origin 判定」：开头加注「项 1 / 2 测的是主 frame 整窗导航，B 段已无此形态，
    iframe 形态复测见 07 节 D1 / D6；项 5 的 400 预期由 D7 取代（决策 D1）」，原有勾选保留。
  - B 段一节：
    - 「前置依赖未落地」一段改为「已由 07 节落地」。
    - W1 / W7 / W8 / W10 / W11 的备注改为「由 07 节 D2 / D3 / D4 / D5 / D1 取代」。
    - B7 的预期改为 `requester Deny`。
  - Phase 7 用例 12 的备注追加「iframe 形态见 07 节 D1」。
- **修改 `versions/latest/changelog.md`**：
  - 用户侧 Fixed 加一行：「网页壁纸刚打开时偶尔要等几秒才应用属性、读不到为它选择的文件夹的问题。」
  - 开发侧：
    - 把 24ee52ce 那行（`Sec-Kabegame-Initiator-Origin`）**改写**为终态，避免同一版本里互相矛盾：「CEF 运行时 IPC 链路拉直：`ipc` /
      `cef-ipc` 由 `GetResourceRequestHandler` 返回的 `IpcResourceRequestHandler` 经 `GetResourceHandler` 直接交出 Tauri 协议
      handler，`Origin` 在 `ipc_origin` 里只算一次（initiator 定来源，`file:` 文档取 CEF 补丁 07 的文档 URL，认不出为
      `null`）；删除 `IpcInitiatorHandler` / `Sec-Kabegame-Initiator-Origin` / `pin_file_frame_origin`；`cef-ipc` 不合法 `Origin`
      一律用占位来源交给 ACL 拒绝。」
    - 新增一行：「新增 CEF 补丁 07（需重编 CEF）：建子资源 / 导航 URLLoaderFactory 时捕获所属文档与父文档 URL，代理对非 http(s)
      请求写入 `Sec-Kabegame-Document-Url` / `Sec-Kabegame-Parent-Document-Url`；`file:` 闸门改按文档头分档，删除『认不出文档
      按目标』的临时规则；去掉 `file:` 文档 worker 的 `file:` 工厂；垫片删除首批请求退避重试。」
- **可选**：在 `ipc-caller-identity-merge-conflict.md` 顶部加一行「已按 document-url-cef-patch.md 处理」。

## 需要用户拍板的决策

1. **D1 `cef-ipc` 遇到不合法 `Origin` 怎么办**：用占位来源交给 ACL 拒绝（Promise reject），还是回 400（Promise 一直挂着）。
   - **推荐**：主 frame、子 frame、未知 frame 一律用占位来源，并把常量改名为 `kabegame-unattributed://ipc/`。
   - **理由**：
     - 主通道遇到 `null` 本来就回 500 让 Promise reject，两条通道的结局应当一致。
     - 拉直之后这里的 `null` 只来自协议层：opaque 来源，或未归属的兜底。不存在「回 400 更安全」的情形。
     - 未知 frame 的回调本来就被 Tauri 丢弃，结果和 400 一样。
   - **代价**：24ee52ce 回归项 5 的预期改为「reject」。
2. **D2 发起方是 `file:` 但认不出文档时，`Origin` 写什么**：`null`（全拒），还是 24ee52ce 的 `file:///`（能 listen 和 pong，pull 失败）。
   - **推荐**：`null`。
   - **理由**：
     - 有 07 时，只有壁纸里的 srcdoc / about:blank 子文档、worker 和同 RFH 多条待提交导航会走到这里，垫片都不在其中运行。
     - 没有 07 时，闸门已经让网页壁纸整体失败关闭，`file:///` 换不来任何可用功能。
     - 运行时从此不再产出「没有身份的 `file:` 来源」，ACL 测试也更简单。
3. **D3 导航闸门是否保留「被导航 frame 当前是 `file:` 文档就按它的范围」**：保留需要补丁给导航工厂也带文档头和父文档头。
   - **推荐**：保留。
   - **理由**：这是 B 段文档写明的不变量：「`file:` frame 不会跨壁纸目录」，应用页一直靠重建 iframe 来切换壁纸。
   - **替代方案**：按导航的发起文档判定，语义更干净，但 `NavigationRequest::GetInitiatorDocumentRenderFrameHost()` 是 private，
     需要再打 Chromium 侧补丁，不划算。
4. **D4 `about:blank` / `about:srcdoc` 子文档的 `file:` 子资源**：继承父文档的范围，还是一律拒绝。
   - **推荐**：继承。需要子资源工厂也带父文档头。
   - **理由**：这类文档的内容和 origin 都来自父文档，属于同一信任域；有些 WPE 页面会用 srcdoc / 空 iframe 拼内容。
   - **注意**：若选「拒绝」，父文档头只用于导航，这类壁纸可能缺图。
5. **D5 worker 的 `file:` 工厂**（新发现，锚点 g）：`file:` 文档的 dedicated / shared worker 拿到的 `FileURLLoaderFactory` 不经过 CEF 代理，
   闸门看不到。B 段和 24ee52ce 都已存在这个问题。
   - **推荐**：在 07 里一并去掉这个工厂（点 1 的新增项），失败关闭，用 D11 实测确认。
   - **代价**：用 worker 读文件的 WPE 壁纸会失效，这类壁纸少见。
   - **替代方案**：另出补丁 08，或暂时接受并写进已知边界。
6. **D6 同一 RFH 同时有多条待提交跨文档导航时**：留空（失败关闭），还是像 Chromium 的 `FindLatestNavigationRequestThatIsStillCommitting`
   那样取 `NavigationStart` 最新的一条。
   - **推荐**：留空。
   - **理由**：取最新的可能把 A 文档的工厂标成 B 文档的 URL，而两者可能是不同壁纸。导航排队机制下这种情况极少，留空只让那一刻的
     请求失败，不会认错。
7. **D7 垫片的 `retrying`**：
   - **推荐**：删除。
   - **理由**：07 之后首批请求就带正确来源；没重编 CEF 时重试也救不回来。保留它只会把真失败拖成 7.75 秒的重试日志，D1 验证也看不出问题。
8. **D8 合并怎么切提交**：
   - **方案 A（推荐）**：合并提交直接按终态解决冲突（点 2–7 与文档、回归节），紧接着单独提交 07 补丁文件和它的 README 条目。
     - 冲突块恰好就是要重写的代码，没必要写两遍。
     - 合并提交在未重编 CEF 的机器上只是「网页壁纸失败关闭」，不留权限漏洞。
     - 07 单独成提交，方便审阅和回滚。
   - **方案 B**：合并提交只做文本层面的并集，即对方记录里「其余冲突」那套：24ee52ce 语义加 B 段结构，身份暂时失效，闸门仍有 frame URL
     竞态。之后再提交 07 和运行时改造。合并提交更易读，但运行时代码要改两遍，中间状态同样不可用，还带着竞态。
   - git 写操作都在主会话里做。

## 推断与未证实（只读源码得出，需真机或进一步阅读确认）

1. 子 frame `file:` 文档的 factory 级 `request_initiator` 是 `"file://"`：按 `GetOriginToCommit()` 和 `ForPendingNavigation`
   推断，WallpaperStage 的 sandbox 带 `allow-same-origin`。对方只在主 frame 实测过；D1 插桩会记下它。
2. 子 frame 的初始空文档用渲染进程 clone 的父工厂，所以带父文档的头：只读到 `render_frame_impl.cc:3743` 的调用点，没有逐层跟到。
3. 同一 RFH 同时有多条待提交跨文档导航在实践中极少，依据是导航排队机制。`NavigationRequest::CommitNavigation` 的注释提到
   `ReadyToCommitNavigation` 可能弹对话框、形成嵌套消息循环。D6 的「唯一才用」能兜住，但没有实测。
4. D5 的漏洞：闸门看不到 worker 的 `file:` 请求，这一点有源码支撑；但 Blink 是否允许 `file:` 来源的 worker 发出 `file:` fetch
   （`allow_file_access_from_file_urls` 对 worker 是否生效）没有核实，所以 D11 要先在补丁前测一次。
5. 重编耗时只是推断；仓库只记录了「纯 rerun 为分钟级」。
6. 网页壁纸 iframe 是否 OOPIF 只影响 D1 的 CDP 测法，没有确认。
7. cef-rs 的 `CefStringMultimap` 迭代保留空值：CEF 侧的 `GetHeaderMap` 已确认保留，cef-rs 侧没有读源码确认。单测
   `document_attribution_reads_headers` 只覆盖到解析层。
8. `document.open()` 或 `replaceState` 改了文档 URL 时，只影响渲染侧和 `GetLastCommittedURL()`，后者只在网络服务崩溃或 DevTools 重建
   工厂时会用到，而且 `file:` 的 pushState 只能改 query / fragment，跨壁纸目录无从利用。这是推断，没有测过。
9. 拉直后，Tauri 的异步响应、raw body、Channel 行为与经 scheme factory 时完全一致。依据是两条路交出的 `CefResourceHandler` 相同，
   wrapper 之后的 `CreateResourceResponse` 路径也相同，但仍需 D8 冒烟确认。

## 与「已确认」前提不符或需要修正之处

1. **调用嵌套的方向**：`ReadyToCommitNavigation` 是 `NavigationRequest::CommitNavigation`（:6604）在 :6705 调用的，然后同一函数在
   :6984 调 `RFH::CommitNavigation`。你列的 1→2 执行顺序正确，但 1 是被 2 的外层函数调用的。中间可能因对话框形成嵌套消息循环
   （见推断 3）。
2. **「取最新那条导航的 `GetURL()`」不能照搬**：多条待提交导航时，按最新取可能认错文档，方案改为「唯一才用」（D6）。
   回退到 `GetLastCommittedURL()` 时要跳过出错页；`IsErrorDocument()` 对 speculative / pending-commit host 会 CHECK 失败，
   `GetLifecycleState()` 对 speculative host 是 `NOTREACHED`（`render_frame_host_impl.cc:3629-3630、13601`），所以要先判空 URL。
3. **不是所有 `file:` 工厂都经过 `CreateInterceptedRequestHandler`**：文档的工厂经过（含 06 的），worker 的 `file:` 工厂不经过
   （锚点 g）。这是现有的闸门缺口，不是本次引入的。
4. **B 段闸门除了 `frame.url()` 还读了父 frame 的 URL**（`frame.parent().url()`），同样是 CEF 缓存。导航工厂的 factory 级 initiator
   是 opaque（`navigation_url_loader_impl.cc:1307` 传 `url::Origin()`），所以要彻底去掉 `frame.url()`，补丁必须给导航工厂也带
   文档头和父文档头（D3）。
5. **自动合并部分不只是「采用了 24ee52ce 的语义」**：`ipc.rs` 里没有冲突标记的区域混进了 B 段测试，它们引用已删除的
   `RequestFrame.url`，代码块里还用着 `fallback_url`（函数签名却是 `initial_url`）。只去掉冲突标记编译不过，必须按点 4 重写。
6. **对方冲突记录里一条说法有误**：它说「`deny file:` 日志取 B 段版本，对方那份打印的 `root` / `grants` B 段已经没有了」。
   实际上 B 段的 `FileAccessScope` 仍有 `root` / `grants`，工作区里现在的日志就是 B 段版本（带 `requester`），这一处不用改。
