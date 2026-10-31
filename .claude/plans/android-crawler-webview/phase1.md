# 安卓 WebView 爬虫插件 Phase 1：宿主 Activity + 垫在主界面下的内容页

> 前置：安卓畅游 Phase 2 已落地（外部页面作为 Activity 的 Tauri 主 webview、主框架 IPC、`releaseContent`、
> tauri 补丁 11、raw body base64、页面下载补头），以及 2026-10-18 的三处修复（主界面 / 畅游重建释放旧 webview、
> 畅游 binding 交接、`onRenderProcessGone`）。
> 决策依据：2026-10-18 真机原型（vivo V2429A，Android 16，WebView 155），结论见文末「原型实测」。
> 范围：`crawl.js` 插件与网页收集的 `webview` 后端在安卓上能跑；插件可 `requestShowWebview()` 让用户在
> 页面里手动操作（登录、过验证）；脚本下载与页面自发下载补齐登录态。
> **不含**：x / patreon / xhs 三个 webview 插件针对移动版 DOM 的适配、安卓 WebView 任务并发上限、
> app 在后台时继续推进 WebView 任务、`Kabegame.archive` 在安卓上的支持。

### 总体设计思路

每个 WebView 爬虫任务对应一个 `CrawlerActivity` 实例，它只当 wry 的**宿主**：Rust 侧照桌面那样用
`WebviewWindowBuilder::new("crawler-<task_id>", External(url)).activity_name("CrawlerActivity")` 建窗，
初始化脚本、`on_page_load`、按 label 认任务的 `crawl_*` 命令都与桌面同一份；Activity 在 manifest 里
`documentLaunchMode="always"`，每个实例单独成栈，`onCreate` 里第一帧之前就 `moveTaskToBack`，用户看不到它。

页面真正显示的位置不在这个 Activity 里。wry 把 `RustWebView` 交给 `setContentView` 时，`CrawlerActivity`
不放进自己的窗口，而是交给 `CrawlerHost`，后者把它连同一条薄工具栏装进一个容器，挂到 `MainActivity`
内容根节点、**垫在主 webview 下面**（`z = -1`）。主界面窗口始终可见，所以 Chromium 认为页面 `visible`，
计时器不节流、页面不冻结；主 webview 不透明，用户看不到它。插件调 `Kabegame.requestShowWebview()` 或
用户在任务抽屉点「打开窗口」时，`CrawlerHost` 把容器的 `z` 提到主 webview 之上，触摸分发随 Z 序走，
输入法正常；工具栏的「收起」或返回键把它放回下面。

数据流与畅游 Phase 2 同形。**脚本 ↔ Rust** 走 Tauri `invoke`，权限仍是 `crawler-capability`，wry 的
`addJavascriptInterface("ipc")` 换成只收主框架消息的 `addWebMessageListener`（与 `SurfActivity` 抽成
同一份 Kotlin 工具）。**原生 ↔ Rust** 走 `CrawlerPlugin` 命令与每任务一个 `events` Channel：页面自发下载
（`pageDownload`）、渲染进程退出（`renderGone`）、工具栏取消（`cancel`）。app 前后台切换是**全局**事件，
走插件 setup 时注册的一条全局 Channel。下载没有 CEF 通道：脚本下载在 `crawl_download_image` 入队前补
`Cookie` / `User-Agent` / `Referer`（复用畅游的 `android_surf_headers` 口径）；页面自发下载由 Rust 带同样的头
用 reqwest 写进任务 VFS 的 `tmp/Downloads`，再沿用桌面的 `finish_page_download` 交给 `Kabegame.onNativeDownload`。

关键决策：

1. **宿主 Activity 与显示位置分离。** 原型证明「单独成栈、退到后台」的页面隐藏约 60 秒就被 Chromium 冻结
   （两轮复现，最长一次冻结 250 秒，期间 `setInterval` 一次都没跑）；只撤销 wry 的 `WebView.onPause()`
   也一样在 76 秒冻结，说明窗口不可见本身就会触发。只有挂进**可见窗口**的视图树才能持续运行。
   Activity 仍然需要：wry 一个 Activity 只认一个 webview，且负责它的创建与销毁回调。
2. **宿主栈不能 `excludeFromRecents`。** 实测不进最近任务的栈一离开前台就被 RecentTasks 当可清理项回收
   （`finish-imm:recent-task-trimmed`，182 ms）。代价是最近任务里可能多一张卡（vivo 启动器把同应用的栈合并，
   实测看不到）；用 `setTaskDescription` 标上任务名，用户划掉等同取消任务。
3. **不缩成 1×1。** 爬虫依赖真实视口（布局、懒加载、`IntersectionObserver`、滚动），缩小会让页面行为和用户
   看到的不一致。代价是垫在下面的页面仍以约 60fps 跑 rAF，占 GPU 与电量，只在任务运行期间存在。
4. **app 退后台 = 任务暂停，不是失败。** 主界面窗口不可见后，垫着的页面同样 hidden；没有前台服务时进程被
   cached freezer 冻结（实测 17 秒），有前台服务时也会在约 60 秒后被 Chromium 冻结。心跳看门狗必须在后台期间
   挂起，回到前台后重置计时，否则会把它误判成「WebView 窗口无响应」。
5. **共享渲染进程，人人都要接 `onRenderProcessGone`。** 安卓整个 app 只有一个 WebView 渲染进程；任何一个
   WebView 不返回 `true`，Chromium 就杀掉 app（原型实测 `Render process's crash wasn't handled by all associated
   webviews`）。爬虫页收到后以 `renderGone` 结束任务；主界面与畅游已在 2026-10-18 修好。
6. **`requestShowWebview` 只在前台生效。** app 在后台时安卓限制拉起界面；Phase 1 只记下「待显示」，回到前台时
   自动提到最上层，并写一条任务日志。用通知把用户拉回来留到后续。

### 现状锚点

**a. 调度器 WebView 分支只在桌面编译**（`kabegame-core/src/crawler/task_scheduler/mod.rs:31`、`:810`）
```rust
/// 首次进入 WebView 爬虫时的 page_label（Kabegame.pageLabel() 的初始值）。
#[cfg(not(target_os = "android"))]          // 现状：安卓整个 WebView 会话路径不编译
const INITIAL_PAGE_LABEL: &str = "initial";

#[cfg(not(target_os = "android"))]
const WEBVIEW_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(120);

    // WebView 后端：仅桌面 CEF。
    #[cfg(not(target_os = "android"))]
    if plugin.script.js_source().is_some() {
        // ...
        return run_webview_session(&download_queue, &run, start_url).await;
    }
    // 现状：安卓上 js 插件落到末尾，报「没有提供可执行的爬虫脚本」
```

**b. 心跳看门狗只认心跳**（`task_scheduler/mod.rs:866`）
```rust
            Some(()) = heartbeat_rx.recv() => {}
            _ = tokio::time::sleep(WEBVIEW_HEARTBEAT_TIMEOUT) => {   // 现状：没有「宿主不可见」的概念
                // ... emit taskLogWebviewHeartbeatTimeout
                break Err(TaskError::Other("WebView 窗口无响应".to_string()));
            }
```

**c. `CrawlerWebViewHandler` 只有桌面实现**（`kabegame/src/startup.rs:27`）
```rust
#[cfg(all(not(target_os = "android"), not(feature = "web")))]
use kabegame_core::crawler::webview::{crawler_window_label, set_webview_handler, CrawlerWebViewHandler};

#[cfg(all(not(target_os = "android"), not(feature = "web")))]
struct AppCrawlerWebViewHandler<R: Runtime> { app: AppHandle<R> }
// 现状：create_crawler_window 建隐藏的 1920×1080 CEF 窗口；start_native_download 调 tauri_runtime_kbcef
```

**d. 下载队列把 WebView 任务的下载交给 CEF**（`kabegame-core/src/crawler/downloader/queue.rs:944`）
```rust
fn is_native_job(job: &DownloadRequest) -> bool {
    matches!(job.url.scheme(), "http" | "https")
        && (surf_uses_native(job)                          // 畅游这一半已按平台区分
            || TaskScheduler::global()
                .get_run(&job.task_id)
                .is_some_and(|run| run.params.uses_webview_transport()))   // 现状：不分平台
}
```

**e. `crawl_download_image` 不带头入队**（`kabegame/src/commands/crawler.rs:495`）
```rust
    let download = dq.download_image(
        parsed, images_dir, run.params.plugin.id.clone(), task_id, download_start_time,
        run.params.output_album_id.clone(),
        HashMap::new(),          // 现状：桌面靠 CEF 会话带 Cookie，这里不需要头
        name, metadata_id, source_url, labels,
    );
```

**f. 爬虫命令整模块只在桌面编译**（`kabegame/src/commands/mod.rs:3`、`lib.rs:743`）
```rust
#[cfg(not(target_os = "android"))]
pub mod crawler;                 // 现状：crawl_* / show_crawler_window 都在这里
// lib.rs 的 invoke_handler 里约 20 个 crawl_* 逐个 #[cfg(not(target_os = "android"))]
```

**g. `requestShowWebview` 不带 taskId，命令却要求必传**（`webview_js/bootstrap.js:503`、`commands/crawler.rs:693`）
```js
    requestShowWebview() {
      return invoke("show_crawler_window");          // 现状：没有 taskId
    },
```
```rust
#[tauri::command]
pub fn show_crawler_window<R: Runtime>(app: AppHandle<R>, task_id: String) -> Result<(), String> {
    // 现状：缺 taskId 时参数反序列化失败，插件里的调用直接抛错（桌面同样受影响）
```

**h. 网页收集与前端都在安卓上拒绝 WebView 后端**
```rust
// kabegame-core/src/crawler/webpage.rs:58
        "webview" => {
            if cfg!(target_os = "android") {
                Err("Android 不支持网页收集的 WebView 后端".to_string())   // 现状
```
```ts
// apps/kabegame/src/composables/useCrawlTaskLauncher.ts:15
  if (IS_ANDROID) {
    // ...
    if (plugin?.scriptType === "js") {
      await ElMessageBox.alert(i18n.global.t("plugins.jsPluginAndroidNotSupported"), /* ... */);
      return false;                                  // 现状：安卓直接拒绝 JS 插件
```
```ts
// apps/kabegame/src/components/WebpageCollectDialog.vue:149
  if (!IS_ANDROID) return defs;
  // Android 无 CEF / 畅游：只保留 V8 后端，去掉依赖浏览器的注入开关     （现状：注释已过时，安卓已有畅游）
```

**i. 主框架 IPC 与释放逻辑只在 `SurfActivity` 里**（`SurfActivity.kt`）
```kotlin
  private fun installMainFrameIpc(webView: RustWebView): Boolean { /* addWebMessageListener，只收主框架 */ }
  private fun releaseContent(webView: RustWebView) { /* removeWebMessageListener → stopLoading → 摘下 → destroy */ }
  // 现状：私有方法，爬虫宿主无法复用
```

### 点 1 — 内容页 Kotlin 公共件（新增 `ContentWebView.kt`，修改 `SurfActivity.kt`）
- **新增** `ContentWebView` 对象：`installMainFrameIpc(webView, executor): Boolean`、`release(webView, ipcAvailable)`。
  > 说明：从 `SurfActivity` 原样搬出，畅游与爬虫宿主共用一份安全边界。
- **修改** `SurfActivity` 改调 `ContentWebView`，行为不变。
```kotlin
/** 外部页面作 Tauri 主 webview 时的公共处理（畅游、爬虫宿主共用）。 */
object ContentWebView {
  // 新增：原 SurfActivity.installMainFrameIpc，签名多一个 executor
  fun installMainFrameIpc(webView: RustWebView, executor: Executor): Boolean { /* ... */ }

  // 新增：原 SurfActivity.releaseContent
  fun release(webView: RustWebView, ipcAvailable: Boolean) {
    if (ipcAvailable) runCatching { WebViewCompat.removeWebMessageListener(webView, "ipc") }
    webView.stopLoading()
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.destroy()
  }
}
```

### 点 2 — 宿主 Activity 与停靠（新增 `CrawlerActivity.kt`、`CrawlerHost.kt`，修改 manifest / `MainActivity.kt`）
- **新增** `CrawlerActivity : TauriActivity`。
  - `onCreate`：第一帧前 `moveTaskToBack(true)`；`setTaskDescription(任务名)`（任务名在 `attach` 到达后补）。
  - `setContentView(RustWebView)`：装主框架 IPC、包装 client（`onRenderProcessGone` 返回 `true` 并发
    `renderGone`、`setDownloadListener` 发 `pageDownload`），然后交给 `CrawlerHost.dock(label, webview)`，
    **不**放进自己的窗口。
  - `onPause`：`super.onPause()` 后立即 `content.onResume()`，撤销 wry 对 WebView 的暂停（停靠后页面在主界面
    窗口里，暂停态会让它判成 hidden）。
  - `onDestroy`：`CrawlerHost.undock(label)`，`super.onDestroy()` 之后 `ContentWebView.release`（重建时同样释放，
    理由见 `cocs/surf/ANDROID_SURF.md`）。
  - 返回键：`moveTaskToBack(true)`，不 `finish`。
- **新增** `CrawlerHost`（单例，持有 `MainActivity` 弱引用）。
  - `dock`：建 `FrameLayout` 容器 = 工具栏（默认隐藏）+ webview，`z = -1f` 加到 `android.R.id.content` 第 0 位。
  - `show(label)` / `hide(label)`：只改容器 `z`（`10f` / `-1f`）与工具栏可见性；显示时给容器套系统栏与 IME insets。
  - `MainActivity` 重建：在新实例的 `onWebViewCreate` 之后把所有容器重新挂到新的内容根节点。
  - `MainActivity` 注册一个只在有容器处于前景时启用的 `OnBackPressedCallback`，调 `hide`。
  - 前后台：`ProcessLifecycleOwner` 的 `ON_START` / `ON_STOP` 经全局 Channel 发 `hostVisibility`；回到前台时
    执行积压的 `show`。
- **修改** manifest：
```xml
        <activity
            android:name=".CrawlerActivity"
            android:exported="false"
            android:documentLaunchMode="always"
            android:autoRemoveFromRecents="true"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode" />
            <!-- 不能 excludeFromRecents：离开前台即被 RecentTasks 回收（原型实测） -->
```
- **修改** `MainActivity`：`onWebViewCreate` 末尾调 `CrawlerHost.attachMain(this)`；`onDestroy` 调 `CrawlerHost.detachMain(this)`。
```kotlin
  override fun onWebViewCreate(webView: WebView) {
      this.webView = webView
      super.onWebViewCreate(webView)
      // ... 原有设置
      CrawlerHost.attachMain(this)          // 新增：重建后把爬虫容器挂回新的内容根节点
  }
```

### 点 3 — `CrawlerPlugin`（新增 `CrawlerPlugin.kt`，Rust `crawler_android.rs` 注册）
- **新增** 命令：`attach { label, taskName, texts, events }`（与畅游同样的会合：Activity 与 attach 先后不定）、
  `show { label }`、`hide { label }`、`close { label }`（`finishAndRemoveTask`）、`clearCookies { url }`
  （逐个把该 URL 的 Cookie 写成过期，替代 wry 安卓空实现的 `delete_cookie`）、`subscribeHost { events }`。
- **新增** 事件：每任务 `pageDownload { url, suggestedName, mimeType }`、`renderGone { crashed }`、`cancel`；
  全局 `hostVisibility { visible }`。
- Cookie 读取复用 `SurfPlugin.getCookie`（`surf_android::cookie_header_for_url`），不重复实现。

### 点 4 — 安卓 `CrawlerWebViewHandler`（新增 `kabegame/src/commands/crawler_android.rs`，修改 `startup.rs`）
- **新增** `AndroidCrawlerWebViewHandler`：
  - `create_task_window`：脚本组装与桌面 `create_crawler_window` 共用（抽出 `crawler_initialization_scripts(run)`），
    每段套畅游 Phase 2 的顶层守卫；`activity_name("CrawlerActivity")`、`created_by_activity_name(主窗口实际登记名)`、
    `use_https_scheme(true)`；随后 `attach`，10 秒超时则销毁窗口报错。
  - `destroy_task_window`：`close` + `window.destroy()`。
  - `start_native_download`：返回 `Err`（安卓不会走到，见点 5）。
- **修改** `startup.rs`：安卓注册该 handler；`create_crawler_window` 的脚本拼装抽成共享函数。
```rust
#[cfg(all(target_os = "android", not(feature = "web")))]
set_webview_handler(Arc::new(crate::commands::crawler_android::AndroidCrawlerWebViewHandler { app })) // 新增
```
- **修改** `show_crawler_window`：`task_id: Option<String>`，缺省时从调用方 webview 的 label 解析（桌面同修）；
  安卓走 `CrawlerPlugin.show`。
```rust
#[tauri::command]
pub async fn show_crawler_window<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    task_id: Option<String>,          // 修改：插件内 requestShowWebview() 不带 taskId
) -> Result<(), String> {
    let task_id = match task_id {
        Some(id) => id,
        None => task_id_from_crawler_label(webview.label()).ok_or("不是爬虫窗口")?.to_string(),
    };
    // 桌面：show + set_focus；安卓：CrawlerPlugin.show（后台时记为待显示）
}
```

### 点 5 — core：放开会话、看门狗挂起、下载走 reqwest（`task_scheduler/mod.rs`、`downloader/queue.rs`、`webpage.rs`）
- **删除** `INITIAL_PAGE_LABEL`、`WEBVIEW_HEARTBEAT_TIMEOUT`、`run_webview_session` 及 `run_task` 分支上的
  `#[cfg(not(target_os = "android"))]`。
- **新增** `crawler::webview::set_host_visible(bool)` / 全局 `watch::Sender<bool>`（默认 `true`）。
- **修改** 看门狗：宿主不可见时不计时，恢复可见后重置期限。
```rust
        let visible = host_visibility();                           // 新增：watch::Receiver<bool>
        tokio::select! {
            // ... completion
            Some(()) = heartbeat_rx.recv() => {}
            _ = visible.changed() => {}                            // 新增：前后台切换都重新进入循环、重置期限
            _ = tokio::time::sleep(WEBVIEW_HEARTBEAT_TIMEOUT), if *visible.borrow() => {   // 修改：只在可见时计时
                // ...
            }
        }
```
- **修改** `is_native_job`：爬虫这一半也按平台区分。
```rust
fn is_native_job(job: &DownloadRequest) -> bool {
    cfg!(not(target_os = "android"))                               // 新增：安卓没有 CEF 下载通道
        && matches!(job.url.scheme(), "http" | "https")
        && (job.surf_record_id.is_some()
            || TaskScheduler::global().get_run(&job.task_id)
                .is_some_and(|run| run.params.uses_webview_transport()))
}
```
  > 说明：`surf_uses_native` 的平台判断随之并入，单测改为覆盖整个函数。
- **修改** `webpage::parse_backend`：去掉安卓拒绝 `webview`。

### 点 6 — 命令全平台注册与安卓分支（`commands/mod.rs`、`commands/crawler.rs`、`lib.rs`、`surf_receive.rs`）
- **修改** `pub mod crawler` 去掉平台门控；`lib.rs` 里 `crawl_get_page_label` … `crawl_clear_site_data`、
  `show_crawler_window` 去掉 `#[cfg(not(target_os = "android"))]`。`crawl_archive_*` 保持桌面专属。
- **修改** `crawl_download_image`：安卓入队前补头（`android_surf_headers` 提到 `surf_receive` 外可复用的
  `android_identity_headers(webview, url)`）。
```rust
    #[cfg(target_os = "android")]
    let http_headers = crate::commands::surf_receive::android_identity_headers(webview.as_ref(), &parsed).await; // 新增
    #[cfg(not(target_os = "android"))]
    let http_headers = HashMap::new();
    let download = dq.download_image(/* ... */, http_headers, /* ... */);   // 修改
```
- **修改** `crawl_clear_site_data`：安卓调 `CrawlerPlugin.clearCookies`。
- **新增** 安卓页面自发下载：`pageDownload` → `assign_page_download_destination` 得到 VFS 路径 → 带
  `android_identity_headers` 用 core 下载 client 流式写入 → `finish_page_download`（成功 / 失败都经它通知
  `Kabegame.onNativeDownload`）。不做压缩包拦截：WebView 插件自己决定怎么处理（与桌面一致）。

### 点 7 — 前端放开（`useCrawlTaskLauncher.ts`、`WebpageCollectDialog.vue`、i18n）
- **删除** `guardPluginPlatform` 里安卓拒绝 JS 插件的分支，以及 `plugins.jsPluginAndroidNotSupported*` 文案。
- **修改** `WebpageCollectDialog`：安卓保留 `webview` 后端与两个注入开关；删除 `gallery.webpageWebviewDesktopOnly`
  提示与过时注释。
- **新增** i18n：工具栏「收起 / 取消任务」、`taskLogWebviewPendingShow`（后台时请求显示）、
  `taskLogWebviewRenderGone`，五种语言。

### 点 8 — 文档、回归、changelog
- **新增** `cocs/crawler/ANDROID_WEBVIEW_CRAWLER.md`：宿主 / 停靠模型、前后台语义、共享渲染进程、与畅游的复用边界；
  `cocs/README.md` 加索引；`CRAWLER_JS_FLOW.md` 去掉「WebView 后端仅桌面」。
- **修改** `versions/latest/regression.md`、`changelog.md`；`src-crawler-plugins/CHANGELOG.md` 不动（插件未改）。

### 验证
- 静态：`deno task check -c kabegame`、`--mode android`；`./gradlew :app:compileArm64DebugKotlin -x rustBuildArm64Debug`。
- 单测：`is_native_job` 平台分支；`show_crawler_window` 的 label 解析；看门狗在不可见期间不超时（tokio 暂停时钟）。
- 真机（dev，不连 CDP 时测页面下载）：
  1. 网页收集 webview 后端收一个普通图集页：任务完成，图片入库，快照有 CSS。
  2. 写一个最小测试插件：`setInterval` 计数 5 分钟 + `requestShowWebview()` + 输入框；确认计数不掉拍、显示后可点可输入、
     「收起」与返回键放回下面、主界面全程正常。
  3. 运行中按 Home 3 分钟再回来：任务不因心跳超时失败，日志可见暂停 / 恢复。
  4. 运行中改字体大小：主界面重建后容器重新挂上，任务继续。
  5. 打崩渲染进程：任务以 `renderGone` 失败，主界面重建，app 不退出。
  6. 登录态：先在畅游登录某站，再跑需要登录的 webview 插件，`Kabegame.downloadImage` 的请求带 Cookie / UA / Referer。

### 风险与待验证
- **WebView 的 Context 是 `CrawlerActivity`，窗口却是 `MainActivity` 的。** 原型里点击、输入法都正常；但
  `<select>` 下拉、`alert()`、文件选择、HTTP 认证这些以 Context 弹窗的功能可能弹到不可见的宿主窗口上。需逐项实测，
  必要时在 `RustWebChromeClient` 外包一层，把弹窗改挂到 `MainActivity`。
- **共享渲染进程。** 爬虫页的长任务和内存与主界面同一进程、同一渲染主线程；重页面可能让主界面卡顿，OOM 时整组 WebView
  被回收（任务失败、主界面重建）。是否给安卓设「同时最多 1 个 WebView 任务」留到实测后决定。
- **移动版页面。** 视口是手机尺寸、UA 是系统 WebView 的移动 UA，现有三个 webview 插件按桌面 DOM 写的选择器大概率失效；
  Phase 1 只保证运行时，插件适配另开。
- **tao JNI 局部引用泄漏**（畅游 Phase 2 已知）：每个任务一个 Activity，长时间批量跑任务会累积残留 Java 对象。
- **rAF 常驻 60fps** 带来的耗电，需要在真机跑 30 分钟看温度与电量。
- `MainActivity` 重建时容器摘下再挂回，页面会短暂 detach；需确认不会触发 `visibilitychange` 引起插件逻辑分支。

### 原型实测（2026-10-18，已删除的 `DEBUG-crawler-proto`）
| 方案 / 场景 | 结果 |
|---|---|
| 单独成栈 + `onCreate` 里 `moveTaskToBack` | 打开不闪（录屏逐帧）；`excludeFromRecents` 时 182 ms 被回收；去掉后存活 |
| 同上，页面在后台 | `hidden`，计时器对齐到 1–2 秒；隐藏约 60 秒后整页冻结（两轮复现，一次停 250 秒） |
| 同上 + 撤销 `WebView.onPause()` | 76 秒冻结 |
| 停靠到主界面 webview 下面 | 始终 `visible`；`setInterval` 110 次 / 110 秒；rAF 约 59fps；主界面显示正常 |
| 停靠后改 Z 序显示 | 点击坐标正确；输入法弹出，`input` 事件逐字到达 |
| 停靠状态下 app 退后台（无前台服务） | 6.6 秒 hidden，17 秒后进程被 cached freezer 冻结 |
| 渲染进程崩溃（修复前） | 主界面未处理 → 整个 app 被杀；修复后 app 存活、主界面重建、爬虫页退出 |
