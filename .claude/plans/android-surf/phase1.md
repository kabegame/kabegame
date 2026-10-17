# 安卓畅游 Phase 1：SurfActivity + 复用桌面导航栏 + Cookie 捕获

> 范围：让安卓能打开外部站点、登录，并把 Cookie 写入 `surf_records`、让 `Kabegame.cefUserAgent()` 在安卓上返回 Cookie 的签发 UA，
> 让现有 `Kabegame.requireCookie()` / 网页收集的 `injectSurfCookie` 在安卓上直接可用。
> **不含**：一键下载、页面自发下载、媒体捕获、真实 `window.open` 弹窗、内容页 JS 注入（见文末 Phase 2）。

### 总体设计思路

安卓的畅游会话是一个独立的 `SurfActivity`，压在 `MainActivity` 之上。它的界面分成上下两段：
上方是**桌面同一份** `surf-navbar.html` 导航栏，由 Tauri 2.12 的
`WebviewWindowBuilder::activity_name("SurfActivity")` 在新 Activity 里创建，是一个带 IPC 的
Tauri WebView；下方是一个**普通的** `android.webkit.WebView`，用来加载外部站点。内容 WebView
不是 Tauri webview，没有 `window.ipc` 和初始化脚本，外部页面接触不到任何应用能力。
`MainActivity` 和其中的 Vue 应用在下面原样保留，关闭 `SurfActivity` 时用户回到原来的位置。

两段 WebView 之间的同步**以 Rust 为中枢，复用桌面的命令和事件协议**。导航栏点后退、前进、刷新、
回车导航时，调用的仍是桌面的 `surf_go_back` / `surf_go_forward` / `surf_reload` /
`surf_navigate`，只是这些命令在安卓上的实现不再操作 Tauri `Webview`，而是经一个 app 内联
Tauri 插件（Kotlin `SurfPlugin`）去操作 `SurfActivity` 的内容 WebView。反方向上，内容 WebView 的
`WebViewClient` 回调（`onPageStarted` / `doUpdateVisitedHistory` / `onPageFinished`）和 Activity
销毁事件，经 Rust 侧创建的 `tauri::ipc::Channel` 推回 Rust。Rust 收到 URL 变化后，照旧
`emit_to(<navbar label>, "surf-url-changed", url)`。这样导航栏代码只需加一个安卓按钮变体，
主界面的 `surf` store 也继续听原来的 `surf-records-change` / `surf-session-changed`。

Cookie 的取法和桌面同口径：每次 `onPageFinished` 时由 Kotlin 用进程级
`CookieManager.getCookie(url)`（含 HttpOnly）对根 URL 与本站访问过的 URL 合并，得到
`name=value; ...` 串，随事件交给 Rust 写库。Activity 关闭时再做最后一次保存。和 Cookie 一起存下的
UA 不入库。`cf_clearance` 这类 Cookie 绑定签发时的 UA，而内容 WebView 不改 UA，签发 UA 就是
系统 WebView 默认 UA（同进程内所有 WebView 一致）。所以启动时取一次 `WebSettings.getDefaultUserAgent`，
登记为安卓上 `Kabegame.cefUserAgent()` 的返回值；插件沿用桌面「先设 UA 再 `requireCookie()`」的配对写法，
`requireCookie` 不偷偷改 UA，桌面行为不变。

关键决策：

1. **用 Tauri 多 Activity，不在 MainActivity 里叠原生 View。** 前者让导航栏天然拥有 IPC
   和桌面同一份页面，后者要自己对齐 Vue 顶栏和原生 WebView 的布局与返回键归属。
2. **以 Rust 为中枢，导航栏和 Kotlin 不直连。** 导航栏保持「只调命令、只听定向事件」，会话状态和
   写库也只在 Rust 一处，与桌面「Rust 权威」的模型一致。
3. **安卓同时只开一个畅游会话。** Activity 栈里 `SurfActivity` 要么在最上面、要么已销毁，
   多会话没有交互入口，单会话可以省掉 label 到 Activity 的多对多路由。
4. **Phase 1 内容页不注入 JS。** SPA 地址变化靠 `doUpdateVisitedHistory`
   （pushState / replaceState 也会触发），不需要桌面那份 `surf_url_report.js`。

```
MainActivity (Vue /surf)                 Rust                         SurfActivity
───────────────────────                  ────                         ────────────
startSession(url) ──invoke──► surf_start_session
                               ├─ get_or_create_surf_record + visit
                               ├─ WebviewWindowBuilder(label=surf-<h>-navbar,
                               │    App("surf-navbar.html?host&url"))
                               │    .activity_name("SurfActivity") ──tao startActivity──► onCreate
                               │                                       setContentView(RustWebView)
                               │                                        → [navbar | content]
                               └─ SurfPlugin.attach{label,host,url,events: Channel} ──► 绑定，content.loadUrl(url)

navbar  ──invoke surf_go_back{host}──► surf_go_back ──run_mobile_plugin("goBack")──► content.goBack()
navbar ◄──emit_to(label,"surf-url-changed")── Channel{urlChanged} ◄── onPageStarted / doUpdateVisitedHistory
Vue    ◄──surf-records-change── update_surf_record_cookie_if_changed ◄── Channel{pageFinished,cookie} ◄── onPageFinished
Vue    ◄──surf-session-changed{active:false}── Channel{closed,cookie} ◄── onDestroy(isFinishing)
```

### 现状锚点

**a. 畅游命令整体被门控在非安卓**（`src-tauri/kabegame/src/commands/mod.rs:13`）
```rust
#[cfg(not(target_os = "android"))]
pub mod surf;            // 现状：记录 CRUD 与窗口操作混在同一个桌面专属模块
#[cfg(not(target_os = "android"))]
pub mod surf_collect;
#[cfg(not(target_os = "android"))]
pub mod surf_session;
```
记录类命令本身只是转发 core 共享层，没有平台依赖（`commands/surf.rs:564`）：
```rust
#[cfg(not(target_os = "android"))]   // 现状：纯存储命令也被门控掉
#[tauri::command]
pub async fn surf_get_all_records() -> Result<Vec<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_all_records()
}
```
`lib.rs:531` 起的注册列表里，`surf_*` 全部带 `#[cfg(not(target_os = "android"))]`。

**b. 桌面导航命令直接操作 Tauri 内容 webview**（`commands/surf.rs:166`）
```rust
pub async fn surf_go_back<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let webview = surf_content_webview(&app, Some(&host))?;   // 现状：label = surf-<host>
    webview.eval("history.back()").map_err(|e| format!("后退失败: {}", e))
}
```
URL 同步是 Rust 定向发给导航栏（`commands/surf.rs` 的 `on_page_load` / `surf_report_url`）：
```rust
let _ = app.emit_to(navbar_label.as_str(), "surf-url-changed", payload.url().as_str());
```
Cookie 在每次 `PageLoadEvent::Finished` 后从 CEF 读取、写库（`save_surf_session_cookies_for_host`）。

**c. 导航栏只依赖命令和定向事件**（`apps/kabegame/src/surf-navbar.ts:191`）
```ts
const back = iconButton("Back", ..., () => runCommand("surf_go_back", { host }));
// ... forward / reload / devtools / openInBrowser / collect
bar.append(back, forward, reload, address, devtools, openInBrowser, collect); // 现状：无关闭按钮
listen<string>("surf-url-changed", ..., { target: getCurrentWebview().label });
```
`surf-navbar.html` 已经是全平台 rollup 入口（`vite.config.ts`：`hasSurfNavbar = !isWeb`）。

**d. 安卓 capability 不含导航栏**（`src-tauri/kabegame/tauri.conf.json.handlebars:40`）
```
"capabilities": ["main-capability"{{#if isAndroid}}, "android-capability"{{else}}, "crawler-capability", "surf-capability", "surf-navbar-capability"{{/if}}],
```
`capabilities/surf-navbar.json` 用 `"webviews": ["surf-*-navbar"]` 授予 `surf`、`surf-navbar`、`core:event:default`。

**e. Tauri 2.12 已支持安卓多 Activity**（`third/tauri/crates/tauri/src/webview/webview_window.rs:1525`）
```rust
#[cfg(target_os = "android")]
impl<R: Runtime, M: Manager<R>> WebviewWindowBuilder<'_, R, M> {
  pub fn activity_name<S: Into<String>>(mut self, class_name: S) -> Self { ... }
  pub fn created_by_activity_name<S: Into<String>>(mut self, class_name: S) -> Self { ... }
}
```
tao 用 `{PACKAGE}/{activity_name}` 找类，再通过创建者 Activity 的 `startActivity(Class)` 拉起，
最多等 5s 等它创建完（`tao-0.37.1/src/platform_impl/android/ndk_glue.rs:169`）。
wry 往 Activity 挂 WebView 的顺序是：**先** `setWebView`（触发 `onWebViewCreate`），然后
`setWebViewClient` / `addJavascriptInterface("ipc")`，**最后才** `setContentView(webview)`
（`wry-0.57.0/src/android/main_pipe.rs:238-323`）。所以不能在 `onWebViewCreate` 里改布局，
否则会被随后的 `setContentView` 覆盖。

**f. Kotlin→Rust Channel 在移动端可用**（`third/tauri/crates/tauri/src/ipc/channel.rs:388`）
```rust
fn new_with_id(id: u32, on_message: OnMessageFn, on_drop: OnDropFn) -> Self {
    // ...
    #[cfg(mobile)]
    crate::plugin::mobile::register_channel(Channel { ... });  // 进 CHANNELS 表
}
```
Rust 侧 `Channel::new(|body| ...)` 序列化为 `__CHANNEL__:<id>`，Kotlin 端 `Channel.send(JSObject)`
经 `PluginManager.sendChannelData` 回到 `plugin/mobile.rs:113` 的 `send_channel_data`，最后调用
这个闭包。

**g. 前端 surf store 在安卓上全部短路**（`apps/kabegame/src/stores/surf.ts:205`）
```ts
initPromise = (async () => {
  if (IS_ANDROID) { inited = true; return; }   // 现状：记录列表永远为空
  ...
async function startSession(url: string) {
  if (IS_ANDROID) throw new Error("Surf is not supported on Android");
```
紧凑布局没有畅游入口：底部 tab 只有画廊 / 画册 / 插件（`App.vue:282`），
`GlobalToolsPopover.vue` 的 compact 分组只有「设置」一行。

**h. Cookie 注入只设 `Cookie` 头**（`kabegame-core/src/plugin/v8/ops.rs:545`）
```rust
Ok(Some(rec)) if !rec.cookie.trim().is_empty() => {
    match run.set_header("Cookie".to_string(), rec.cookie) {   // 现状：不带 UA
```
`cef_user_agent()`（`ops.rs:482`）在安卓上返回 `None`。

**i. `surf_records` 表**（`storage/migrations/init.rs:187`）
```sql
CREATE TABLE surf_records (
    id TEXT PRIMARY KEY, host TEXT NOT NULL UNIQUE, root_url TEXT NOT NULL, icon BLOB,
    last_visit_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '', cookie TEXT NOT NULL DEFAULT ''   -- 现状：无 UA 列
);
```
`LATEST_VERSION = 41`（`migrations/mod.rs`）。

---

### 点 1 — 安卓 `cefUserAgent()` 返回系统 WebView 默认 UA（core + Kotlin）

> 修订：初版方案是给 `surf_records` 加 `user_agent` 列（v042）并让 `requireCookie` 顺带设 UA。
> 已改为不入库：同进程 WebView 默认 UA 一致，插件本来就显式配对 `cefUserAgent()` 与 `requireCookie()`，
> 加列只换来「WebView 升级后旧 Cookie 仍可用」，代价是迁移和 `requireCookie` 的隐式改 UA。
> 将来要为单站点改 UA（「桌面版网站」）时再按记录存 UA。

- **新增**
  - `ops.rs`：`#[cfg(target_os = "android")] static ANDROID_WEBVIEW_USER_AGENT: OnceLock<String>` 与 `pub fn set_android_webview_user_agent(&str)`，经 `plugin::v8` 再导出。
  - `Storage::update_surf_record_cookie_if_changed(id, cookie)`：`UPDATE ... WHERE id = ?2 AND cookie != ?1`，只在变化时发 `SurfRecordChanged { cookie }`（安卓每次加载完成都会上报）。
  - Kotlin `SurfPlugin.getDefaultUserAgent`：返回 `{ userAgent: WebSettings.getDefaultUserAgent(activity) }`。
- **修改**
  - `cef_user_agent()`：安卓分支返回登记值（未登记为 `None`）。
  - `surf_android::plugin()` 的 setup：异步调用 `getDefaultUserAgent` 并登记。
  - 内容 WebView 不得修改 `userAgentString`（加注释约束）。
  - 插件文档（`kabegame-api.mdx`、`dev/changelog.mdx` 4.5.2「变更」、`PLUGIN_FORMAT.md`、`lib.kabegame.d.ts`）把「Android 返回 `null`」改为返回 WebView 默认 UA。

```rust
// ops.rs
fn cef_user_agent() -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return ANDROID_WEBVIEW_USER_AGENT.get().cloned();   // 新增
    }
    // 桌面：不变
}
```

### 点 2 — 拆出全平台共用的 `surf_common.rs`（app 命令层）

- **新增**
  - `commands/surf_common.rs`（不门控）：从 `surf.rs` 移入纯存储命令 `surf_list_records` / `surf_get_all_records` / `surf_get_records_by_ids` / `surf_get_record` / `surf_get_record_images` / `surf_update_root_url` / `surf_update_name` / `surf_delete_record`、`surf_open_in_browser`（`tauri-plugin-opener` 已在 `android` feature 里），以及共享 helper `parse_external_url` / `resolve_root_url` / `encode_query_value` / `surf_label` / `surf_navbar_label` / `normalize_surf_host`。
- **修改**
  - `surf.rs` 删除上述定义，改为 `pub(crate) use super::surf_common::{surf_label, normalize_surf_host, ...};`，保证 `surf_collect`、`crawler`、`lib.rs` 里 `commands::surf::*` 的既有引用不用改。
  - `commands/mod.rs`：`pub mod surf_common; pub use surf_common::*;`（无 cfg）。
  - `lib.rs` 注册表：上述命令去掉 `#[cfg(not(target_os = "android"))]`。
- **删除**
  - 无（只是搬迁）。

```rust
// commands/mod.rs
pub mod surf_common;                 // 新增：全平台
pub use surf_common::*;
#[cfg(not(target_os = "android"))]
pub mod surf;                        // 不变：桌面窗口 / CEF 相关
#[cfg(target_os = "android")]
pub mod surf_android;                // 新增：点 3
#[cfg(target_os = "android")]
pub use surf_android::*;
```

### 点 3 — 安卓会话中枢 `surf_android.rs`（app 命令层）

- **新增** `commands/surf_android.rs`（`cfg(target_os = "android")`），对外命令**与桌面同名**，
  导航栏和 `surf` store 都不必区分平台：
  - `surf_start_session(url)`：解析 URL → `get_or_create_surf_record` + `update_surf_record_visit` →
    若已有会话就先 `close` 它（单会话）→ 用 `WebviewWindowBuilder` 以 `activity_name("SurfActivity")`
    创建导航栏窗口 → 记会话 → 调 `SurfPlugin.attach` 并传入事件 Channel → 发 `surf-session-changed`
    → 异步抓 favicon（与桌面相同）。
  - `surf_close_session(host?)` / `surf_get_session_status()`：读写会话状态。安卓上**不靠
    `app.windows()`**，因为 Activity 销毁后 Tauri 窗口表的清理时机还没验证（见风险 4）。
  - `surf_go_back` / `surf_go_forward` / `surf_reload` / `surf_navigate(host, url)`：校验 host 是当前会话，再 `run_mobile_plugin_async` 到 Kotlin。
  - 内联插件 `plugin()`：`register_android_plugin("app.kabegame", "SurfPlugin")`，把 `PluginHandle` 放进 managed state。
  - 事件处理：`urlChanged` → `emit_to(label, "surf-url-changed", url)`；`pageFinished` → `update_surf_record_session`；`closed` → 最后保存一次 → 清会话 → `surf-session-changed {active:false}`。
- **修改**
  - `lib.rs`：`#[cfg(target_os = "android")] builder = builder.plugin(commands::surf_android::plugin());`；把 `surf_start_session` / `surf_close_session` / `surf_get_session_status` / `surf_go_back` / `surf_go_forward` / `surf_reload` / `surf_navigate` 的注册改成全平台（两个平台各由自己的模块提供同名函数）。

```rust
// commands/surf_android.rs（新增，示意）
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum SurfContentEvent {
    UrlChanged { url: String },
    PageFinished { url: String, cookie: String },
    Closed { cookie: String },
}

struct AndroidSurfSession { host: String, record_id: String, label: String }
static SESSION: Mutex<Option<AndroidSurfSession>> = Mutex::new(None);

pub struct SurfAndroid<R: Runtime>(PluginHandle<R>);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("kabegame-surf")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame", "SurfPlugin")?;
            app.manage(SurfAndroid(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn surf_start_session<R: Runtime>(app: AppHandle<R>, url: String) -> Result<serde_json::Value, String> {
    let parsed = parse_external_url(url.trim())?;
    let host = parsed.host_str().ok_or("URL 缺少 host")?.to_lowercase();
    let record = /* get_or_create_surf_record + update_surf_record_visit，同桌面 */;
    if let Some(old_label) = current_label() {
        close_label(&app, &old_label).await?;          // 单会话：先关旧的
    }
    let label = surf_navbar_label(&host);              // 窗口 = 导航栏，label 对上 capability 与 emit_to
    let navbar_url = WebviewUrl::App(format!(
        "surf-navbar.html?host={}&url={}", encode_query_value(&host), encode_query_value(parsed.as_str())
    ).into());
    WebviewWindowBuilder::new(&app, &label, navbar_url)
        .activity_name("SurfActivity")
        .created_by_activity_name("MainActivity")
        .build()
        .map_err(|e| format!("创建畅游 Activity 失败: {e}"))?;
    *SESSION.lock().unwrap() = Some(AndroidSurfSession { host: host.clone(), record_id: record.id.clone(), label: label.clone() });

    let events = Channel::new({
        let app = app.clone();
        move |body| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(ev) = serde_json::from_str::<SurfContentEvent>(&s) { on_content_event(&app, ev); }
            }
            Ok(())
        }
    });
    app.state::<SurfAndroid<R>>().0
        .run_mobile_plugin_async::<()>("attach", AttachArgs { label, host, url: parsed.to_string(), events })
        .await.map_err(|e| e.to_string())?;
    // emit surf-session-changed + favicon，同桌面
    serde_json::to_value(record).map_err(|e| e.to_string())
}
```

### 点 4 — Kotlin `SurfPlugin`（app 模块）

- **新增** `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfPlugin.kt`
  > 说明：放在 app 模块而不是 `src-tauri-plugins/`，因为它要引用 `SurfActivity`，而
  > `SurfActivity` 继承的 `TauriActivity` 是 app 模块里生成的类，插件库引用不到。
  - `SurfRegistry`（object）：以 label 为键做双向会合。`attach` 先到，就把配置挂起等 Activity；
    Activity 先就绪，就等配置。两边都到齐后调用 `activity.bind(config)`。这样不依赖 tao 的
    `build()` 返回和 `setContentView` 谁先谁后。
  - 命令：`attach` / `goBack` / `goForward` / `reload` / `navigate` / `close`，全部在 UI 线程执行。

```kotlin
@InvokeArg class AttachArgs { lateinit var label: String; lateinit var host: String; lateinit var url: String; lateinit var events: Channel }
@InvokeArg class LabelArgs { lateinit var label: String }
@InvokeArg class NavigateArgs { lateinit var label: String; lateinit var url: String }

data class SurfBinding(val label: String, val host: String, val url: String, val events: Channel)

object SurfRegistry {
  private val activities = HashMap<String, SurfActivity>()
  private val pending = HashMap<String, SurfBinding>()
  fun attach(b: SurfBinding) { activities[b.label]?.bind(b) ?: run { pending[b.label] = b } }
  fun onActivityReady(label: String, a: SurfActivity) { activities[label] = a; pending.remove(label)?.let(a::bind) }
  fun onActivityGone(label: String) { activities.remove(label); pending.remove(label) }
  fun get(label: String): SurfActivity? = activities[label]
}

@TauriPlugin
class SurfPlugin(private val activity: Activity) : Plugin(activity) {
  @Command fun attach(invoke: Invoke) {
    val a = invoke.parseArgs(AttachArgs::class.java)
    activity.runOnUiThread { SurfRegistry.attach(SurfBinding(a.label, a.host, a.url, a.events)); invoke.resolve() }
  }
  @Command fun goBack(invoke: Invoke) = onSurf(invoke) { if (it.content.canGoBack()) it.content.goBack() }
  @Command fun goForward(invoke: Invoke) = onSurf(invoke) { if (it.content.canGoForward()) it.content.goForward() }
  @Command fun reload(invoke: Invoke) = onSurf(invoke) { it.content.reload() }
  @Command fun navigate(invoke: Invoke) { /* NavigateArgs → it.content.loadUrl(url) */ }
  @Command fun close(invoke: Invoke) = onSurf(invoke) { it.finish() }

  private fun onSurf(invoke: Invoke, block: (SurfActivity) -> Unit) {
    val label = invoke.parseArgs(LabelArgs::class.java).label
    activity.runOnUiThread {
      val a = SurfRegistry.get(label) ?: return@runOnUiThread invoke.reject("畅游页面未打开")
      block(a); invoke.resolve()
    }
  }
}
```

### 点 5 — Kotlin `SurfActivity`（app 模块）

- **新增** `.../app/kabegame/SurfActivity.kt`，继承 `TauriActivity`：
  - **布局**：覆写 `setContentView(view)`。收到 wry 传来的 `RustWebView` 时，把它装进竖排
    `LinearLayout`：导航栏固定 48dp 高，内容 WebView 占满剩余高度（`weight = 1`），然后再调用
    `super.setContentView(root)`，并登记 `SurfRegistry.onActivityReady(nav.id, this)`
    （`RustWebView.id` 就是 webview label）。
  - **安全区和键盘**：`enableEdgeToEdge()`（targetSdk 36 强制 edge-to-edge），在根布局上按
    `systemBars | displayCutout` 加内边距，底部取它与 `ime` 的较大值，避免键盘挡住登录表单。
    导航栏页面不必感知 inset。
  - **内容 WebView**：普通 `WebView`，开启 `javaScriptEnabled`、`domStorageEnabled`、
    `CookieManager.setAcceptThirdPartyCookies(content, true)`（SSO 需要），设
    `setSupportMultipleWindows(false)`（`target=_blank` 在原页导航，和桌面单窗口语义一致）；UA
    保持默认。**不**调 `addJavascriptInterface`，**不**注入脚本。只在 debug 构建打开
    `setWebContentsDebuggingEnabled`，调试用 `chrome://inspect`，代替桌面的开发者工具按钮。
  - **`shouldOverrideUrlLoading`**：http/https 返回 false，留在原页加载；`intent:` 链接带
    `browser_fallback_url` 的改为加载这个回退地址；其它 scheme（`weixin://` 等）返回 true 拦掉。
  - **上报**：`onPageStarted` 和 `doUpdateVisitedHistory` 发 `urlChanged`；`onPageFinished` 先记下
    访问 URL，再发 `pageFinished{url, cookie}`；`onDestroy` 且 `isFinishing` 时发
    `closed{cookie}`，然后 `SurfRegistry.onActivityGone`。
  - **返回键**：`TauriActivity` 的 `handleBackNavigation = false`，自己注册
    `OnBackPressedCallback`：`content.canGoBack()` 时后退，否则 `finish()`。

```kotlin
class SurfActivity : TauriActivity() {
  lateinit var content: WebView
  private var binding: SurfBinding? = null
  private var label: String? = null
  private val visited = LinkedHashSet<String>()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() { if (content.canGoBack()) content.goBack() else finish() }
    })
  }

  // wry 先 setWebView(→onWebViewCreate) 后 setContentView(webview)：在这里换成「导航栏 + 内容」
  override fun setContentView(view: View?) {
    val nav = view as? RustWebView ?: return super.setContentView(view)
    content = createContentWebView()
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(nav, LinearLayout.LayoutParams(MATCH_PARENT, dp(48)))
      addView(content, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    super.setContentView(root)
    label = nav.id
    SurfRegistry.onActivityReady(nav.id, this)
  }

  fun bind(b: SurfBinding) { binding = b; content.loadUrl(b.url) }

  /** 与桌面 collect_surf_cookie_string 同口径：根 URL + 本站访问过的 URL 合并，按名去重、排序 */
  private fun collectCookie(): String {
    val b = binding ?: return ""
    val cm = CookieManager.getInstance().also { it.flush() }
    val merged = sortedMapOf<String, String>()
    (listOf(b.url) + visited).forEach { u ->
      cm.getCookie(u)?.split(';')?.forEach { kv ->
        val i = kv.indexOf('=')
        if (i > 0) merged[kv.substring(0, i).trim()] = kv.substring(i + 1).trim()
      }
    }
    return merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
  }

  private fun emit(type: String, extra: JSObject.() -> Unit = {}) {
    binding?.events?.send(JSObject().apply { put("type", type); extra() })
  }

  override fun onDestroy() {
    if (isFinishing) emit("closed") { put("cookie", collectCookie()) }
    label?.let(SurfRegistry::onActivityGone)
    super.onDestroy()
  }
}
```
`visited` 只收 host 等于站点 host 的页面 URL，和桌面「Cookie 域匹配站点 host」的口径一致；
多收集不同路径的 URL，是为了带上 `Path=/xxx` 的 Cookie。

### 点 6 — Manifest 与 capability

- **修改** `gen/android/app/src/main/AndroidManifest.xml`：新增
  ```xml
  <activity
      android:name=".SurfActivity"
      android:exported="false"
      android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
      android:windowSoftInputMode="adjustResize" />
  ```
  > 说明：`configChanges` 与 MainActivity 相同，避免旋转时重建 Activity、销毁 Tauri webview。
- **修改** `tauri.conf.json.handlebars`：安卓分支加 `"surf-navbar-capability"`（**不**加带
  `remote` 的 `surf-capability`，因为内容页本来就不是 Tauri webview）。
  ```
  {{#if isAndroid}}, "android-capability", "surf-navbar-capability"{{else}}...
  ```

### 点 7 — 导航栏安卓变体（`surf-navbar.ts`）

- **修改**
  - `IS_ANDROID` 时不放 `devtools` 和 `collect` 两个按钮（Phase 2 再加回一键下载），末尾加「关闭」按钮，调用 `surf_close_session { host }`。
  - 安卓上按钮放大到 40px，地址栏加 `inputmode="url"` 和 `enterkeyhint="go"`。
  - 其它不变：命令名、`surf-url-changed` 定向监听都沿用。

```ts
const close = iconButton("Close", CLOSE_ICON, () => runCommand("surf_close_session", { host })); // 新增
bar.append(
  ...(IS_ANDROID
    ? [back, forward, reload, address, openInBrowser, close]          // 新增：安卓变体
    : [back, forward, reload, address, devtools, openInBrowser, collect]),
);
```

### 点 8 — 主界面：store、入口、页面适配

- **修改** `stores/surf.ts`：删掉所有 `IS_ANDROID` 短路（`init` / `initListeners` / `checkSession` / `startSession` / `closeSession` / 记录 CRUD / `getRecordImages`），让安卓与桌面走同一条路径。
- **修改** `header/comps/GlobalToolsPopover.vue`：compact 分组在「设置」下面加一行「畅游」（`route.surf`），`router.push("/surf")`，条件为 `!IS_WEB`。
  > 说明：桌面窄窗口的 compact 布局目前也没有畅游入口，这一行顺带补上。
- **修改** `views/Surf.vue`：用 `kabegame-chromium --android` 实机过一遍紧凑布局；
  隐藏或改写桌面专属文案（帮助弹窗里的一键下载、开发者工具说明）。
- **修改** `actions/surfRecordActions.ts`：检查有没有桌面专属动作（需要窗口的），在安卓上隐藏。

### 点 9 — 文档、回归与 changelog

- **新增** `cocs/surf/ANDROID_SURF.md`：讲 SurfActivity 的两段布局、`setContentView` 时序、
  SurfRegistry 会合、命令与 Channel 协议、Cookie 口径、UA 登记、单会话约束；同时在
  `cocs/README.md` 加索引条目。
- **修改** `versions/latest/regression.md`（格式参照 `versions/v4.5.1/regression.md`）和
  `versions/latest/changelog.md`（一两行：「安卓支持畅游：打开站点登录后自动保存 Cookie，
  供需要登录的插件使用」）。
- **修改** `AGENTS.md`：进程模型表的 Android 行补一句「畅游为独立 `SurfActivity`，
  导航栏是 Tauri webview，内容页是无 IPC 的普通 WebView」。

---

### 验证

1. `deno task check -c kabegame --mode android` 和 `deno task check -c kabegame`（桌面，确认搬迁没有破坏引用）。
2. `deno task test`：`update_surf_record_cookie_if_changed` 只在 Cookie 变化时写库。
3. 实机（`deno task dev` 安卓 + `kabegame-chromium --android`）：
   - 工具箱 →「畅游」→ 输入 `https://www.pixiv.net` → 出现 SurfActivity，上方导航栏、下方站点。
   - 站内点链接、SPA 切换路由，导航栏地址同步；在导航栏输入地址回车，内容页跳转。
   - 后退 / 前进 / 刷新按钮生效；系统返回键先在页面内后退，退到头关闭 SurfActivity，回到原来的 `/surf`，Vue 状态不丢。
   - 登录后关闭，记录的 Cookie 非空；冷启动后插件里 `cefUserAgent()` 等于内容页 `navigator.userAgent`；`surf-records-change` 让列表即时更新。
   - 用需要登录的 V8 插件跑一次（weibo / xhs / bilibili-video），任务日志出现 `taskLogCookieInjected`，结果与桌面一致。
   - 旋转屏幕、弹出键盘，布局不重建、表单不被遮挡。
   - 在导航栏的 DevTools（chrome://inspect）里确认导航栏有 `__TAURI_INTERNALS__`，内容页的 `window.ipc`、`__TAURI_INTERNALS__` 都是 `undefined`。

### 风险与待验证

1. **移动 UA 带来的站点差异。** `cefUserAgent()` 在安卓上是移动 WebView UA，插件用它请求时，有的站会返回移动版
   页面或跳到 `m.` 子域（微博尤其明显），解析逻辑可能失效。要逐个实测用到 `requireCookie`
   的插件：weibo、xhs、bilibili-video、anime-pictures、danbooru、konachan。不行的话，Phase 2
   在导航栏加一个「桌面版网站」开关（改内容 WebView 的 UA，届时才需要按记录存 UA）。
2. **OAuth 弹窗。** `setSupportMultipleWindows(false)` 下，依赖 `window.open` 返回
   WindowProxy 的登录流程（如 Google Identity Services）会失败。Phase 1 接受这个限制，
   Phase 2 再用 `onCreateWindow` 开一个子 WebView 补上。
3. **Cookie 口径差异。** `getCookie(url)` 拿不到只发给其它路径、而我们又没访问过的
   `Path=` Cookie。对登录态影响很小，文档里写明。
4. **Tauri 安卓多 Activity 的清理。** Activity 销毁后，`app.windows()` 里的窗口什么时候移除、
   会不会发 `WindowEvent::Destroyed`，都要实测。会话状态以 Rust 的 `SESSION` 加 Kotlin 的
   `closed` 事件为准，不依赖窗口表。若同 label 的残留窗口导致第二次 `build()` 失败，就在
   `closed` 处理里显式 `destroy()` 旧窗口。
5. **Channel 不会释放。** 移动端 `CHANNELS` 表只增不减，每个会话泄漏一个闭包。体量可以忽略，但要在文档里记一笔。
6. **`build()` 阻塞。** tao 会在调用线程上最多等 5s，等 Activity 创建完。命令是 async 的，跑在
   tokio worker 上，不会卡 UI。但如果此时 MainActivity 正在后台（用户切走了），`startActivity`
   可能失败，命令要能返回错误而不是挂起。

### Phase 2 预告（不在本期）

- 一键下载：用 `addDocumentStartJavaScript`（限定当前站 origin）注入 `page_discover.js` 和
  `surf_collect.js`，经 `addWebMessageListener` 回传，下载走现有队列，导航栏恢复 collect 按钮
  和 `surf-collect-state`。
- 页面自发下载：`setDownloadListener` 接到 `surf_import_media` 的路径。
- 导航栏加载进度、`canGoBack/canGoForward` 置灰、「桌面版网站」UA 开关、`onCreateWindow` 真实弹窗。
