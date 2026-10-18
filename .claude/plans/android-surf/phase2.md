# 安卓畅游 Phase 2：内容页改为 Tauri webview + 原生导航栏 + 注入脚本与下载

> 前置：Phase 1 已落地（`SurfActivity`、`SurfPlugin`、`surf_android.rs`，见 `cocs/surf/ANDROID_SURF.md`）。
> 决策依据：[child-webview-eval.md](child-webview-eval.md)。本文件取代此前的「普通 WebView + `__TAURI_INTERNALS__` 垫片」版本。
> 范围：内容页成为 Tauri webview 并注入与桌面相同的脚本；一键下载、`blob:` / `data:` / MSE 捕获、页面自发下载在安卓跑通；
> 导航栏改成 Kotlin 原生控件。
> **不含**：OAuth 真实弹窗（`on_new_window` 在 wry 安卓不存在）、「桌面版网站」UA 开关、POST 触发的下载、
> 页面下载的压缩包解压（解压交给各插件自己做，畅游只收图片 / 视频）。

### 总体设计思路

`SurfActivity` 的主角对调。Phase 1 里，Tauri 管的是上方导航栏，外部站点跑在一个 Tauri 不知道的普通
WebView 里。Phase 2 把外部站点交给 Tauri：`surf_start_session` 用
`WebviewWindowBuilder::new(label, WebviewUrl::External(url)).activity_name("SurfActivity")`
直接创建内容页，并像桌面一样挂上 `initialization_script`、`on_page_load`。导航栏退化成 `SurfActivity`
在 `setContentView` 里插在 `RustWebView` 上方的一排原生按钮和地址栏。于是桌面那套「按 webview label
认会话」的命令（`surf_collect_*`、`surf_download_image`、`surf_import_media`、`crawl_fs_*` /
`crawl_ffmpeg_*`）在安卓上用真实 Tauri `invoke` 原样工作。Rust 侧的主要改动只是把
这些命令从桌面专属模块里拆出来，在安卓上也注册。

数据流分三条，各走最直接的通道。**脚本 ↔ Rust** 一律走 Tauri `invoke` / Channel，权限由 capability
`surf-capability` 管，安卓与桌面同一份。**原生导航栏 ↔ 内容页** 在 Kotlin 内部直接完成：后退、前进、
刷新、地址栏跳转直接操作 `RustWebView`，地址显示来自包装后的 `WebViewClient`，不经 Rust 往返。
**原生导航栏 / 下载拦截 ↔ Rust** 继续用 Phase 1 的 `events` Channel 与 `SurfPlugin` 命令：工具栏的
一键下载按钮发 `collectToggle`，`setDownloadListener` 拦到的页面下载发 `pageDownload`，Cookie
保存和关闭仍是 `pageFinished` / `closed`；Rust 回推一键下载运行态时调 `SurfPlugin.setCollectRunning`。

下载分两类，都在 Rust 侧补齐登录态。桌面的畅游下载交给 CEF 原生下载，浏览器自己带 Cookie；安卓没有这条路。
**脚本发起的下载**（一键下载、长按菜单、`surf_bootstrap.js` 的 `triggerDownload`）照旧
`invoke("surf_download_image")`，安卓版在入队前往 `DownloadRequest.http_headers` 里塞入三个头：
`Cookie`（`webview.cookies_for_url(媒体 URL)`）、`User-Agent`（Phase 1 登记的系统 WebView UA）、
`Referer`（`webview.url()`），然后由队列用 reqwest 下载、直接入图库。**页面自发下载**（WebView 判定为附件的
导航）由 Kotlin 的 `setDownloadListener` 拦截，交给 Rust。Rust 先按文件名和 MIME 判断是不是支持的图片或视频，
不是就直接 toast 拒绝，不下载；是就和脚本下载走同一个入队函数，带上同样三个头，进图库。压缩包不解压：
解压属于各爬虫插件自己的事（`Kabegame.archive`），畅游只收媒体。`data:` / `blob:` 的页面下载，
Rust 在页面外取不到字节，转回页面里 `media_download.js` 已有的 `__kb_media_download__` 处理。

关键决策：

1. **内容页做 Tauri 主 webview，不打第三方补丁。** 理由见评估文档：child webview 要改 Tauri + wry
   （+ tao），且波及整个安卓应用；对调主次后不碰第三方仓库就能拿到同样的复用。
2. **在 `SurfActivity` 里把 wry 的 IPC 通道换掉，只收主框架消息。** wry 的
   `addJavascriptInterface("ipc")` 对所有框架开放，上报的来源 URL 却是主框架的，外部页面里的第三方
   iframe 会冒用主页面身份。替换为 `addWebMessageListener("ipc")`：JS 侧仍是
   `window.ipc.postMessage(string)`，Tauri 无感；Kotlin 丢弃非主框架消息，并以当前主框架 URL 调用
   wry 生成的 `Rust.ipc`。设备不支持该特性时**关闭 IPC**（只能浏览，不能一键下载），不回退到不安全的
   通道。
3. **注入脚本在安卓上只在顶层文档生效。** 桌面 Tauri 的 `initialization_script` 只进主框架；wry
   安卓用 `addDocumentStartJavaScript(…, setOf("*"))`，会进 iframe。Rust 给每段脚本包一层顶层守卫，
   与桌面行为一致。
4. **页面自发下载直接入队，不落 VFS、不解压。** 两类下载收敛到同一个入队函数和同一套头，安卓不需要页面下载的
   VFS 收尾，`notify_page_download` / `finish_page_download` / `crawl_archive_*` 都留在桌面。下载前按文件名 / MIME
   过滤非媒体，避免把大压缩包下完才在后处理里报类型错误。
5. **二进制 invoke 在命令侧兼容 JSON 数组。** Tauri 在安卓上没有自定义协议 IPC，raw body
   （`Uint8Array`）经 postMessage 时会被 `JSON.stringify` 成数字数组，到 Rust 变成
   `InvokeBody::Json`。`crawl_fs_*` 的 raw 读取 helper 增加这一分支，MSE / `blob:` 分块写就能直接复用。
   代价是体积约膨胀 3–4 倍，可接受。
6. **label 带会话序号 `surf-<host>:<n>`。** 沿用 Phase 1「每次会话换 label」的理由（旧 Activity 迟到的
   事件、Tauri 窗口表清理时机未验证）；`host_from_surf_label` 统一剥掉 `:<n>`，桌面 label 不含 `:`，
   不受影响。

```
                         SurfActivity
┌──────────────────────────────────────────────────────────┐
│ 原生工具栏  ← ⟳ [地址]  ⤓(collect)  ↗  ✕                    │  Kotlin 直接操作 RustWebView
├──────────────────────────────────────────────────────────┤
│ RustWebView（Tauri webview，label = surf-<host>:<n>）       │
│   注入：i18n / media_capture / media_download /             │
│         surf_bootstrap / 一键下载 IIFE / toast / 右键菜单     │
│   window.ipc  = addWebMessageListener（仅主框架）            │
└──────────────────────────────────────────────────────────┘
   │ invoke: surf_collect_* / surf_download_image / surf_import_media / crawl_fs_* / crawl_ffmpeg_*
   ▼
 Rust（与桌面共用的命令；安卓 surf_download_image 补 Cookie/UA/Referer → DownloadRequest.http_headers）

 events Channel（Kotlin → Rust）：pageFinished{cookie} / closed{cookie} / collectToggle / pageDownload{url,name,mime}
 SurfPlugin（Rust → Kotlin）：attach / close / setCollectRunning / getDefaultUserAgent

 pageDownload ─┬ http(s)，媒体 ─► enqueue_surf_download(三个头) ─► DownloadRequest ─► 图库
               ├ http(s)，非媒体（含压缩包）─► toast 不支持，不下载
               └ data: / blob: ─► eval 页面 __kb_media_download__ ─► crawl_fs 分块写 ─► surf_import_media
```

### 现状锚点

**a. 安卓内容页是普通 WebView，Tauri webview 是导航栏**（`gen/android/.../SurfActivity.kt`）
```kotlin
override fun setContentView(view: View?) {
    val navbar = view as? RustWebView          // 现状：wry 交来的 Tauri webview 是导航栏
    ...
    content = createContentWebView()            // 现状：外部站点跑在自建的普通 WebView
    val root = LinearLayout(this).apply {
        addView(navbar, LinearLayout.LayoutParams(MATCH_PARENT, dp(48)))
        addView(content, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    }
```
`surf_start_session`（`surf_android.rs`）创建的是 `surf-navbar.html` 窗口，label 为
`surf-<host>-<n>-navbar`；导航命令 `surf_go_back` 等经 `SurfPlugin` 转发到普通 WebView。

**b. 桌面内容页的注入与回调**（`commands/surf.rs`，`surf_start_session`）
```rust
let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
    .initialization_script(include_str!("../webview_js/webview_i18n.js"))
    .initialization_script(media_capture)
    .initialization_script(media_download)
    .initialization_script(concat!(/* surf_download_name.js + surf_bootstrap.js */))
    .initialization_script([/* 一键下载 IIFE */].concat())
    .initialization_script(include_str!("../webview_js/surf_toast.js"))
    .initialization_script(include_str!("../webview_js/surf_context_menu.js"))
    .initialization_script(include_str!("../webview_js/surf_url_report.js"))
    .on_page_load(...)      // Started → surf_collect::on_content_page_started；地址发给 navbar；Finished → 存 Cookie
    .on_new_window(...)     // 现状：wry 安卓没有该回调
    .on_download(...);      // 现状：wry 安卓没有该回调（见评估文档）
```

**c. 页面相关命令全部桌面专属**（`commands/mod.rs`、`lib.rs`）
```rust
#[cfg(not(target_os = "android"))]
pub mod crawler;        // 现状：surf_download_image、crawl_fs_* / archive / ffmpeg、页面下载 helper 都在这里
#[cfg(not(target_os = "android"))]
pub mod surf_collect;
#[cfg(not(target_os = "android"))]
pub mod surf_session;   // 现状：会话 VFS 与 surf_import_media
```
`lib.rs` 注册表里对应条目均带 `#[cfg(not(target_os = "android"))]`；`clear_stale_sessions()` 的 cfg 是
`not(any(feature = "web", target_os = "android"))`。`deno_fs` / `deno_permissions` 只在 app 的桌面依赖段
（core 的 `plugin-runtime` 在安卓上已编译它们）。

**d. VFS 按 label 解析，已支持 surf**（`commands/crawler.rs:427`）
```rust
fn vfs_of_label(label: &str) -> Result<Arc<PluginVfs>, String> {
    if label.starts_with("crawler-") { return run_of_label(label).map(|(_, run)| Arc::clone(&run.vfs)); }
    if let Some(host) = surf_host_from_label(label) {   // 现状：surf-<host> → 会话 VFS
        return crate::commands::surf_session::get_or_create_session(&host).map(|s| Arc::clone(&s.vfs));
    }
    Err(format!("Invalid fs window label: {label}"))
}
```
`surf_host_from_label`（`crawler.rs:316`）与 `host_from_surf_label`（`surf.rs:84`）是两份重复实现，
都只认 `surf-<host>`。

**e. raw body 只认 `InvokeBody::Raw`**（`commands/crawler.rs:498`）
```rust
let data = match request.body() {
    tauri::ipc::InvokeBody::Raw(data) => data.clone(),
    _ => return Err("Expected raw IPC body for file handle write".to_string()),  // 现状：安卓 postMessage 送来的是 Json 数组
};
```
Tauri JS 侧在安卓上固定走 postMessage（`third/tauri/crates/tauri/scripts/ipc-protocol.js:20`：
`canUseCustomProtocol = osName !== 'android'`），`Uint8Array` 经 `JSON.stringify` 变成 `Array.from(val)`。

**f. wry 安卓 IPC 对所有框架开放、来源取主框架**（`generated/Ipc.kt`、`RustWebViewClient.kt`）
```kotlin
@JavascriptInterface
fun postMessage(message: String?) {
    message?.let { m -> Rust.ipc(webView.id, webViewClient.currentUrl, m) }  // 现状：iframe 调用也报主框架 URL
}
// RustWebViewClient：override fun onPageStarted(...) { currentUrl = url }
```
`RustWebView` 的初始化脚本：`WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))`，进所有框架。

**g. 畅游下载在桌面一律 native**（`kabegame-core/src/crawler/downloader/queue.rs:944`）
```rust
fn is_native_job(job: &DownloadRequest) -> bool {
    matches!(job.url.scheme(), "http" | "https")
        && (job.surf_record_id.is_some()               // 现状：安卓没有 native handler，这里会失败
            || TaskScheduler::global().get_run(&job.task_id).is_some_and(|run| run.params.uses_webview_transport()))
}
```
`surf_download_image`（`crawler.rs:1324`）只透传页面给的 headers，最后 `dq.download(..., http_headers, ...)` 入队，
`DownloadRequest.http_headers` 会原样用于 reqwest 请求。

**h. 桌面页面下载出口与脚本下载入口**（`commands/crawler.rs:163–244`、`webview_js/surf_bootstrap.js`）
```rust
pub(crate) fn assign_page_download_destination(vfs, handle, url, suggested_name, destination) -> Result<(), String>
pub(crate) fn finish_page_download<R: Runtime>(webview, vfs, handle, url, path, success)
    // 现状：CEF 把页面下载落到 /<handle>/tmp/Downloads，校验后 eval window.__kb_native_download_finished__
```
```js
// surf_bootstrap.js
function triggerDownload(url, opts) {
  if (/^(data|blob):/i.test(String(url || ""))) {
    return window.__kb_media_download__(url, options).catch(reportErr);   // 现状：data/blob 由页面内取字节
  }
  return invoke("surf_download_image", { url: String(url), name: ..., sourceUrl: ... })
```
桌面的 `__kb_native_download_finished__` 会对压缩包调 `crawl_archive_*` 解压后逐项导入；安卓不接这条。

**i. 终态 toast 与 capability 只在桌面**
```rust
// startup.rs:484
#[cfg(all(not(target_os = "android"), not(feature = "web")))]
AppEvent::DownloadState { .. } => crate::commands::surf::eval_surf_toast_for_host(...)
```
```
// tauri.conf.json.handlebars:40
{{#if isAndroid}}, "android-capability", "surf-navbar-capability"{{else}}, "crawler-capability", "surf-capability", "surf-navbar-capability"{{/if}}
```
`capabilities/surf.json`：`"windows": ["surf-*"]`、`"webviews": ["surf-*"]`、
`remote.urls = ["https://*.*:*", "http://*.*:*"]`、permission `surf`。

---

### 点 1 — 会话 label 与 host 解析统一（`surf_common.rs`）

- **新增** `surf_common::host_from_surf_label`：剥 `surf-` 前缀，拒绝 `-navbar` 后缀，再剥 `:<n>` 会话序号。
- **修改** `surf.rs` 的 `host_from_surf_label`、`crawler.rs` 的 `surf_host_from_label` 删除，改用上面这一份。
- **修改** `surf_android::next_label(host)`：从 `surf-<host>-<n>-navbar` 改为 `surf-<host>:<n>`。

```rust
// surf_common.rs
/// 内容 webview label → host。桌面为 `surf-<host>`，安卓为 `surf-<host>:<会话序号>`。
pub(crate) fn host_from_surf_label(label: &str) -> Option<String> {
    let rest = label.strip_prefix("surf-")?;
    if rest.is_empty() || rest.ends_with("-navbar") { return None; }
    let host_part = rest.split_once(':').map_or(rest, |(host, _)| host);   // 新增：剥安卓会话序号
    (!host_part.is_empty()).then(|| host_part.replace('_', "."))
}

pub(crate) fn is_surf_content_label(label: &str) -> bool {
    host_from_surf_label(label).is_some()
}
```

### 点 2 — 页面命令拆到全平台（`commands/`、`lib.rs`、`Cargo.toml`）

- **新增** `commands/page_fs.rs`（全平台）：从 `crawler.rs` 挪入 `vfs_of_label`、`crawl_fs_*` 全部命令与
  helper、`crawl_ffmpeg_*`（`media_download.js` 的 `blob:` / MSE 分块写与合流要用）。`vfs_of_label` 的 `crawler-`
  分支保留，因为 `TaskScheduler` 在 core，安卓上只是永远匹配不到。
- **新增** `commands/surf_receive.rs`（全平台）：挪入 `now_ms`、`insert_metadata`、`surf_download_name_from_url`、
  `SurfReceiveCtx` / `surf_ctx_from_label`、`surf_download_image`，并新增入队函数 `enqueue_surf_download`（点 3）。
- **不动**：`crawl_archive_*`、`notify_page_download`、`assign_page_download_destination`、`finish_page_download`、
  `claim_native_download_destination`、`finish_native_download` 留在桌面 `crawler.rs`；安卓不解压、不接 CEF 下载。
  > 说明：`surf_bootstrap.js` 在安卓上照样注入（`triggerDownload`、`__kb_media_submit__` 要用），其中
  > `__kb_native_download_finished__` 在安卓上永远不会被调用；`crawl_archive_*` 没注册，即便被调用也只会报找不到命令。
- **修改** `crawler.rs` 只留爬虫窗口命令和桌面页面下载出口，用 `pub(crate) use super::{page_fs::*, surf_receive::*}`
  重新导出，现有 `super::crawler::now_ms` 等引用不变。
- **修改** `surf_collect.rs`、`surf_session.rs`：去掉 `mod.rs` 的 cfg，变为全平台。
- **修改** `lib.rs`：上述命令和 `surf_import_media` 的注册去掉 `#[cfg(not(target_os = "android"))]`；
  `clear_stale_sessions()` 的 cfg 改为 `not(feature = "web")`。
- **修改** `src-tauri/kabegame/Cargo.toml`：`deno_fs = { version = "0.162", features = ["sync_fs"] }`、
  `deno_permissions = "0.111"`、`percent-encoding` 移到共用依赖段（版本与 core 一致，安卓上已经编译过）。
- **修改** raw body 读取：`crawl_fs_raw_handle_write_request` / `crawl_fs_raw_write_request` 及
  `crawl_fs_write_file` / `crawl_fs_write_text_file` 用到的同类 helper 接受 JSON 字节数组。

```rust
// page_fs.rs（新增 helper）
/// 安卓 Tauri 只有 postMessage IPC：Uint8Array 会被序列化成 JSON 数字数组，这里还原为字节。
fn raw_body_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.clone()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(items)) => items     // 新增
            .iter()
            .map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| "Invalid byte array in IPC body".to_string()),
        _ => Err("Expected raw IPC body".to_string()),
    }
}
```

### 点 3 — 安卓 surf 下载补头（`surf_receive.rs`、core `queue.rs` / `ops.rs`）

- **新增** core `kabegame_core::plugin::v8::android_webview_user_agent() -> Option<String>`（`cfg(android)`），
  读 Phase 1 的 `ANDROID_WEBVIEW_USER_AGENT`。
- **新增** `surf_receive::android_surf_headers(&webview, &url)`（`cfg(android)`）：`Cookie` 来自
  `webview.cookies_for_url(url)`（wry 安卓经 `CookieManager.getCookie`，含 HttpOnly；它在 MainPipe 上同步等结果，
  放进 `spawn_blocking`），`User-Agent` 来自上面的 getter，`Referer` 来自 `webview.url()`。
- **新增** `surf_receive::enqueue_surf_download(&webview, SurfDownloadRequest)`：原 `surf_download_image` 的主体
  （scheme 校验、`is_run_active`、metadata 归属、`dq.download`）。安卓上入队前把三个头并进 `http_headers`，平台补的头
  覆盖页面给的。脚本下载（`surf_download_image` 命令）和页面下载（点 7）都调它。
- **修改** `surf_download_image` 命令变成薄包装：组装 `SurfDownloadRequest` 后调 `enqueue_surf_download`。
- **修改** `is_native_job`：安卓上 `surf_record_id` 不再意味着 native。

```rust
// surf_receive.rs（新增）
pub(crate) struct SurfDownloadRequest {
    pub url: Url,
    pub name: Option<String>,
    pub headers: HashMap<String, String>,
    pub metadata: Option<Value>,
    pub metadata_id: Option<i64>,
    pub collect_run_id: Option<u64>,
    pub source_url: Option<String>,
}

pub(crate) async fn enqueue_surf_download<R: Runtime>(
    webview: &Webview<R>,
    req: SurfDownloadRequest,
) -> Result<(), String> {
    let ctx = surf_ctx_from_label(webview.label())?;
    // …（原 surf_download_image 主体：scheme 校验、is_run_active、metadata 归属）
    let mut http_headers = req.headers;
    #[cfg(target_os = "android")]
    http_headers.extend(android_surf_headers(webview, &req.url).await);   // 新增：Cookie / UA / Referer
    TaskScheduler::global().download_queue().download(
        req.url, ctx.images_dir, ctx.host, String::new(), now_ms(), None,
        Some(ctx.surf_record_id), http_headers, /* … 同原实现 */
    ).await
}
```

```rust
// core queue.rs
fn is_native_job(job: &DownloadRequest) -> bool {
    matches!(job.url.scheme(), "http" | "https")
        && (surf_uses_native(job)                                           // 修改
            || TaskScheduler::global().get_run(&job.task_id).is_some_and(|run| run.params.uses_webview_transport()))
}

/// 桌面畅游下载交给 CEF 原生下载；安卓没有 CEF，由 surf_download_image 补齐头后走 reqwest。
fn surf_uses_native(job: &DownloadRequest) -> bool {
    cfg!(not(target_os = "android")) && job.surf_record_id.is_some()        // 新增
}
```

### 点 4 — 注入脚本单一来源（`surf_common.rs`、`surf.rs`）

- **新增** `surf_common::surf_initialization_scripts(platform) -> Vec<String>`：把桌面 builder 链上的脚本收成列表。
  安卓变体去掉 `surf_url_report.js`（地址由原生工具栏直接读），并给每段包一层顶层守卫。
- **修改** 桌面 `surf_start_session` 改为遍历这个列表调用 `.initialization_script(...)`，行为不变。

```rust
// surf_common.rs（新增）
pub(crate) fn surf_initialization_scripts() -> Vec<String> {
    let mut scripts = vec![
        include_str!("../webview_js/webview_i18n.js").to_string(),
        include_str!("../webview_js/media_capture.js").to_string(),
        include_str!("../webview_js/media_download.js").to_string(),
        concat!("(function () {\n\"use strict\";\n",
                include_str!("../webview_js/surf_download_name.js"),
                include_str!("../webview_js/surf_bootstrap.js"),
                "\n})();\n").to_string(),
        surf_collect_script(),
        include_str!("../webview_js/surf_toast.js").to_string(),
        include_str!("../webview_js/surf_context_menu.js").to_string(),
    ];
    #[cfg(not(target_os = "android"))]
    scripts.push(include_str!("../webview_js/surf_url_report.js").to_string());
    #[cfg(target_os = "android")]
    { scripts = scripts.into_iter().map(top_frame_only).collect(); }   // 新增：wry 安卓的脚本会进 iframe
    scripts
}

#[cfg(target_os = "android")]
fn top_frame_only(script: String) -> String {
    format!("(function () {{\nif (window.top !== window) return;\n{script}\n}})();\n")
}
```

### 点 5 — 安卓会话改建内容页（`surf_android.rs`）

- **修改** `surf_start_session`：
  - 用 `WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))`，链上
    `surf_initialization_scripts()`、`.activity_name("SurfActivity")`、`.created_by_activity_name(...)`。
  - `.on_page_load`：`Started` → `surf_collect::on_content_page_started(&app, label)`。
  - `.on_navigation`：只放行 http/https，与 Phase 1 的 `shouldOverrideUrlLoading` 同口径；`intent:` 的
    fallback 处理仍在 Kotlin 包装 client 里（点 6）。
  - `.use_https_scheme(true)`：超过阈值（JSON 8 KiB、raw 1 KiB，`ipc/channel.rs:36`）的 invoke 响应和 Channel
    消息，Tauri 会让页面 `fetch` `<scheme>://ipc.localhost/…` 去取。安卓默认是 `http://`，在 https 外部页面里
    属于混合内容；改成 `https://ipc.localhost` 才能避开。`crawl_fs_fread` 的 raw 响应、较大的目录列表都会走这条路。
  - `AttachArgs` 增加 `texts`（工具栏文案，Rust 用 `t!()` 取，i18n 只维护一处）。
- **修改** `SurfContentEvent`：删除 `UrlChanged`；新增 `CollectToggle`、
  `PageDownload { url, suggested_name, mime_type }`。
- **修改** `Closed` 处理：除写 Cookie、清 `SESSION`、发 `surf-session-changed` 外，补上桌面 `Destroyed`
  分支做的 `surf_session::drop_session(host)` 与 `surf_collect::drop_slot(label)`。
- **新增** `set_collect_running(app, label, running)`，调 `SurfPlugin.setCollectRunning`。
- **删除** 安卓版 `surf_go_back` / `surf_go_forward` / `surf_reload` / `surf_navigate`，`lib.rs` 里它们的注册
  恢复为桌面专属（原生工具栏直接操作 WebView）。

```rust
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum SurfContentEvent {
    PageFinished { url: String, cookie: String },
    Closed { cookie: String },
    CollectToggle,                                                  // 新增：原生工具栏按钮
    PageDownload { url: String, suggested_name: Option<String>, mime_type: Option<String> },  // 新增
}

fn on_content_event<R: Runtime>(app: &AppHandle<R>, session: &AndroidSurfSession, event: SurfContentEvent) {
    match event {
        SurfContentEvent::CollectToggle => {
            if let Err(error) = super::surf_collect::toggle(app, &session.label) {
                super::surf_common::surf_toast_for_host(app, &session.host, &error, "failed");
            }
        }
        SurfContentEvent::PageDownload { url, suggested_name, .. } => {
            let (app, session) = (app.clone(), session.clone());
            tauri::async_runtime::spawn(async move {
                on_page_download(&app, &session, &url, suggested_name.as_deref()).await;
            });
        }
        // PageFinished / Closed：见上文
        ...
    }
}
```

### 点 6 — `SurfActivity`：原生工具栏、IPC 替换、下载拦截（Kotlin）

- **修改** `setContentView(view)`：`view` 现在是**内容页** `RustWebView`。
  - 根布局：`LinearLayout(VERTICAL)` = `SurfToolbar`（48dp）+ 细进度条 + `RustWebView`（weight 1）；insets 处理沿用 Phase 1。
  - IPC 替换：`removeJavascriptInterface("ipc")` 后 `addWebMessageListener("ipc")`，见下方代码。
  - 包装 `WebViewClient`：取 `WebViewCompat.getWebViewClient(rustWebView)` 作为 delegate。
    `MainActivity.ContentUriStreamClient` 已有同样做法。全部回调先交 delegate，再更新工具栏和 Cookie 记录；
    `shouldOverrideUrlLoading` 先处理 `intent:` / 非 http(s) scheme，其余交 delegate。
    需要覆写 wry 用到的全部五个回调：`shouldInterceptRequest`、`shouldOverrideUrlLoading`、`onPageStarted`、
    `onPageFinished`、`onReceivedError`，外加 `doUpdateVisitedHistory`。
  - `setDownloadListener`：`URLUtil.guessFileName(url, contentDisposition, mimeType)` 得到文件名，发 `pageDownload`。
  - `CookieManager.setAcceptThirdPartyCookies(rustWebView, true)`；**不**改 UA。
- **删除** `createContentWebView()`、普通 WebView 相关代码；`collectCookie` / `rememberVisited` 保留，改挂在包装 client 上。
- **新增** `SurfToolbar`（同文件或 `SurfToolbar.kt`）：后退、前进、刷新、地址（单行 `EditText`，`imeOptions = actionGo`，
  失焦时显示当前 URL）、一键下载（运行中换成转圈）、在浏览器打开（`Intent.ACTION_VIEW`）、关闭（`finish()`）。
  文案来自 `SurfBinding.texts`，配色按 `Configuration.UI_MODE_NIGHT_MASK` 取明暗两套。
- **修改** `SurfPlugin`：删除 `goBack` / `goForward` / `reload` / `navigate`；新增 `setCollectRunning(label, running)`；
  `SurfAttachArgs` 增加 `texts`、`ipcAvailable` 回传位。

```kotlin
// SurfActivity.setContentView 内（新增）
private val ipcExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

private fun installMainFrameIpc(webView: RustWebView): Boolean {
  // wry 先 addJavascriptInterface("ipc") 再 setContentView；首个 loadUrl 是 post 出去的，在此之后才执行，
  // 所以这里移除能在第一个文档前生效。
  webView.removeJavascriptInterface("ipc")
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
    return false                                    // 失败即关闭：不退回所有框架可见的通道
  }
  // JS 侧仍是 window.ipc.postMessage(string)，Tauri 的 ipc-protocol.js 无需改动
  WebViewCompat.addWebMessageListener(webView, "ipc", setOf("*")) { view, message, _, isMainFrame, _ ->
    if (!isMainFrame) return@addWebMessageListener  // iframe 不得冒用主页面身份
    val data = message.data ?: return@addWebMessageListener
    val url = view.url ?: "about:blank"             // UI 线程读取，含 SPA 导航后的地址
    // 移出 UI 线程：同步命令若再经 MainPipe 等主线程会死锁；单线程保证顺序
    ipcExecutor.execute { Rust.ipc(webView.id, url, data) }
  }
  return true
}

private fun installDownloadInterceptor(webView: RustWebView) {
  webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
    emit("pageDownload") {
      put("url", url)
      put("suggestedName", URLUtil.guessFileName(url, contentDisposition, mimeType))
      put("mimeType", mimeType)
    }
  }
}
```

### 点 7 — 页面自发下载直接入队（`surf_android.rs`）

- **新增** `on_page_download(app, session, url, suggested_name, mime_type)`：
  - `http` / `https`：先判定是否支持的媒体：文件名用 `image_type::is_media_by_path`，MIME 用
    `image_type::media_format(mime)`，任一命中即可。不支持（含 zip / 7z / tar 等压缩包）就 toast
    `surf.download.unsupportedType` 后返回，**不发起下载**；支持就以 `suggested_name` 作文件名、`webview.url()`
    作 `source_url`，调 `enqueue_surf_download`，带的三个头和脚本下载相同。
  - `data:` / `blob:`：Rust 在页面外取不到字节，`eval` 页面里 `media_download.js` 已有的
    `window.__kb_media_download__(url, { name })`，与 `surf_bootstrap.js` 的 `triggerDownload` 对这两种 scheme
    的处理一致。
  - 其它 scheme：toast `surf.download.unsupportedScheme`。
  - 终态反馈：入队后由现有的 `DownloadState` 终态 toast 负责（点 8）。

```rust
async fn on_page_download<R: Runtime>(
    app: &AppHandle<R>,
    session: &AndroidSurfSession,
    url: &str,
    name: Option<&str>,
    mime_type: Option<&str>,
) {
    let Some(webview) = app.get_webview(&session.label) else { return };
    let Ok(parsed) = Url::parse(url) else { return };
    let toast = |key: &str| super::surf_common::surf_toast_for_host(app, &session.host, &t!(key), "failed");
    match parsed.scheme() {
        "data" | "blob" => {
            // 与 surf_bootstrap.js 的 triggerDownload 同口径：字节只能在页面里取
            let url_json = serde_json::to_string(url).unwrap_or_default();
            let opts = serde_json::to_string(&json!({ "name": name })).unwrap_or_default();
            let _ = webview.eval(&format!("window.__kb_media_download__?.({url_json}, {opts});"));
        }
        "http" | "https" => {
            let by_name = name.is_some_and(|n| image_type::is_media_by_path(Path::new(n)));
            let by_mime = mime_type.and_then(image_type::media_format).is_some();
            if !(by_name || by_mime) {
                toast("surf.download.unsupportedType");   // 压缩包等不下载；解压由各插件自行处理
                return;
            }
            let req = SurfDownloadRequest {
                url: parsed,
                name: name.map(ToOwned::to_owned),
                headers: HashMap::new(),
                metadata: None,
                metadata_id: None,
                collect_run_id: None,
                source_url: webview.url().ok().map(|u| u.to_string()),
            };
            if let Err(error) = super::surf_receive::enqueue_surf_download(&webview, req).await {
                super::surf_common::surf_toast_for_host(app, &session.host, &error, "failed");
            }
        }
        _ => toast("surf.download.unsupportedScheme"),
    }
}
```
> 说明：`media_format` 能否直接吃标准 MIME（如 `image/jpeg`），还是只认格式键（如 `image/jpg`），实现时要对一下
> `MEDIA_FORMATS` 的别名表；不认的话改成先 `ext_from_mime` 再 `is_supported_media_ext`。

### 点 8 — 运行态、toast 与 capability

- **修改** `surf_collect.rs`：
  - `surf_collect_toggle(host)` 的主体抽成 `toggle(app, label)`；桌面命令传 `surf_label(host)`，安卓由 `CollectToggle` 传会话 label。
  - `emit_state` 分平台：桌面 `emit_to("<label>-navbar", "surf-collect-state")`，安卓 `surf_android::set_collect_running`。
- **新增** `surf_common::surf_toast_for_host(app, host, message, kind)`：桌面按 `surf_label(host)` 找 webview，安卓按当前会话 label 找；
  两边都 `eval("window.__kabegame_toast?.(…)")`。
- **修改** `startup.rs` 的 `DownloadState` 终态分支：cfg 改为 `not(feature = "web")`，调用 `surf_toast_for_host`。
- **修改** `tauri.conf.json.handlebars` 安卓分支：`"surf-navbar-capability"` → `"surf-capability"`。
- **删除** `surf-navbar.ts` 的 `IS_ANDROID` 分支（`surf-navbar--android` 样式、关闭按钮），回到桌面单一形态。

```
{{#if isAndroid}}, "android-capability", "surf-capability"{{else}}, "crawler-capability", "surf-capability", "surf-navbar-capability"{{/if}}
```

### 点 9 — 文案、文档、回归

- **新增** i18n（5 个语言包，`surf.json`）：`surf.toolbar.{back,forward,reload,address,collect,cancel,openInBrowser,close}`、
  `surf.download.unsupportedType`、`surf.download.unsupportedScheme`、`surf.collect.ipcUnavailable`。
  > 说明：`packages/kabegame-i18n/src/locales/*/surf.json` 目前有未提交改动，在其上追加。
- **修改** `cocs/surf/ANDROID_SURF.md`：重写「Activity 与 WebView 边界」（主次对调、原生工具栏）；新增「IPC 主框架化」
  「注入脚本顶层守卫」「下载：脚本下载与页面下载拦截共用入队函数并补头，非媒体不下载、不解压」「raw body JSON 兼容」；同步 `cocs/README.md` 条目。
- **修改** `cocs/downloader-tasks/DOWNLOADER_FLOW.md`：安卓畅游下载不走 native 的原因与三个头的来源。
- **修改** `AGENTS.md` 进程模型的安卓说明：从「顶部导航栏是有 IPC 的 Tauri webview，外部内容页是无 IPC 的普通 Android WebView」
  改为「外部内容页是 Tauri webview（IPC 仅主框架），顶部导航栏是原生控件」。
- **修改** `versions/latest/regression.md`、`versions/latest/changelog.md`。

---

### 验证

1. `deno task check -c kabegame --mode android` 与 `deno task check -c kabegame`（桌面：模块拆分、label 解析、脚本列表抽取）。
2. `deno task test`：`host_from_surf_label`（桌面 / 安卓 / navbar / 空）、`raw_body_bytes`（Raw / Json 数组 / 越界值）、`is_native_job` 平台分支。
3. 桌面回归：一键下载、冻结快照、取消、页面自发下载（含 zip 解压，桌面保持原样）、MSE 视频捕获，结果与改动前一致。
4. 安卓实机（`deno task dev` + `kabegame-chromium --android`）：
   - 工具栏：后退 / 前进 / 刷新 / 地址栏跳转；SPA 切换路由后地址更新；系统返回键先页内后退，退到头关闭。
   - pixiv 作品页一键下载：页内 toast、工具栏转圈与复位、图片入该畅游记录；i.pximg.net 不 403（Referer 生效）。
   - 页面自发下载：图片 / 视频附件直接进该畅游记录（Cookie / Referer 生效）；zip 等压缩包提示不支持且不发起下载；`data:` 链接经页面内脚本导入。
   - `blob:` 下载与 MSE 视频（如 bilibili 播放页）：分块写入成功（JSON 数组兼容路径），合流后入库。
   - `chrome://inspect`：在 iframe 内执行 `window.ipc.postMessage(...)` 无效；顶层 `__TAURI_INTERNALS__.invoke("surf_navigate", …)` 因未注册 / 无权限被拒。
   - 关闭 SurfActivity：会话 VFS 目录被清理；Cookie 已保存；主界面 `surf-session-changed` 正确。

### 风险与待验证

1. **`removeJavascriptInterface` 的生效时机。** 文档说「下次页面加载后生效」。上面依赖「wry 的首个
   `loadUrlMainThread` 是 post 出去的，晚于 `setContentView`」。要实测首个文档里 `window.ipc`
   确实是 WebMessageListener 版本（例如 `typeof window.ipc.addEventListener === "function"`）。
2. **`Rust.ipc` 从非 Binder 线程调用。** wry 原本在 JavascriptInterface 的 Binder 线程上调，这里换成
   自建单线程 executor。按 wry 实现，IPC handler 只入队到 Tauri，理论上与线程无关，但要确认没有隐含的
   线程假设。
3. **wry 的 `WebViewClient` 被包装。** wry 若在 Rust 侧再次 `setWebViewClient`（目前只在创建时设一次），
   包装会被冲掉。升级 Tauri / wry 时复查 `main_pipe.rs`。
4. **JSON 数组 raw body 的体积。** MSE 分块按 `media_download.js` 的块大小，经 JSON 后约 3–4 倍；要实测
   长视频的耗时与内存，必要时在安卓上调小块大小。
5. **`blob:` 被页面立即 revoke。** 不少站点 `a.click()` 后马上 `URL.revokeObjectURL`，等
   `onDownloadStart` → Rust → `eval` 绕一圈回来，blob 可能已失效。确认 `media_capture.js` 是否已经保留
   blob 引用；没有的话，在安卓注入包里延迟 revoke。
6. **reqwest 和浏览器指纹不同。** 个别 CDN 可能在 Cookie、UA、Referer 都正确时仍拒绝。实测出现再考虑
   Kotlin 侧下载。
7. **`cookies_for_url` 走 MainPipe 同步等待。** 必须在 `spawn_blocking` 里调，不能在 UI 线程或持锁时调。
8. **长按菜单。** `surf_context_menu.js` 依赖 `contextmenu` 事件；安卓 WebView 长按图片是否派发它要实测。
   不派发就在安卓上不注入这段，Phase 3 再做长按。
9. **Channel 泄漏会放大。** 移动端 `Channel::new_with_id` 对**所有** Channel 都 `register_channel`
   （`ipc/channel.rs:399`），JS 侧经 `from_callback_fn` 建的也不例外，而 `CHANNELS` 表只增不减。每次整页导航，
   页面里的 `surf_collect_attach` 都会留下一个闭包；每个 postMessage invoke 的响应也是临时 Channel，同样会进表。
   要实测一次长时间浏览后的表大小和内存；若增长明显，属于上游问题，记进 `cocs/surf/ANDROID_SURF.md`，
   并考虑给 `third-patches/tauri` 加一个「响应用的临时 Channel 不进表」的小补丁。
10. **大响应经 `fetch` 取数据。** 即使改成 `https://ipc.localhost`，还要确认两点：外部页面对它的 `fetch` 能通过
    CORS（Tauri 自定义协议响应要带 `Access-Control-Allow-Origin`），页面 CSP 的 `connect-src` 拦截不会导致
    Tauri 回退后卡住。可以用 `crawl_fs_read_file` 读一个大于 1 KiB 的文件来验证。
11. **页面下载的媒体判定会误伤。** 有的站点返回 `application/octet-stream`，文件名也没有扩展名，`guessFileName` 会生成
    `xxx.bin`，于是真图片被当成非媒体拒绝。若实测常见，改为「判定不出时照样入队，让后处理按字节嗅探」（`mime_type_from_bytes`），
    只对能明确认出是压缩包的扩展名 / MIME 提前拒绝。
