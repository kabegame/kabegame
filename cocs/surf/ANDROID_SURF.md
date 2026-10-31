# Android 畅游（Phase 1 + Phase 2 + Phase 3）

Android 畅游用于打开外部站点、完成登录，并把 Cookie 与签发 Cookie 时的 User-Agent 保存到
`surf_records`。V8 插件调用 `Kabegame.requireCookie()` 后会同时注入两者，避免
`cf_clearance` 等与 UA 绑定的 Cookie 因请求指纹不一致而失效。

Phase 2 之后内容页就是 Tauri webview，因此一键下载、页面自发下载、`blob:` / `data:` / MSE
捕获都与桌面共用同一套注入脚本与命令；导航栏改为 Kotlin 原生控件。

Phase 3 补齐三件事：工具栏后退 / 前进按历史置灰、地址栏下方显示真实加载进度、脚本
`window.open`（Google Identity Services 等 OAuth）在 Activity 内以覆盖层承载并保留真实
`WindowProxy`。另外按站点记住「桌面版网站」：内容页、弹窗、插件 `requireCookie` 与畅游
下载补头共用同一个桌面 UA，Cookie 与签发 UA 始终配对；页面自发的 apk 安装包下载提前拦截。

## Activity 与 WebView 边界

`SurfActivity` 位于 `MainActivity` 上方，关闭后直接回到原 Vue 页面。主次已对调：

- 内容页是 `WebviewWindowBuilder::new(..., WebviewUrl::External(url))` +
  `.activity_name("SurfActivity")` 创建的 **Tauri 主 webview**（label `surf-<host>:<n>`）。
  它拿到与桌面同一份 `initialization_script`、`on_page_load`，并用真实 Tauri `invoke` 与
  `Channel` 和后端通信，权限由 capability `surf-capability` 管。
- 顶部 48dp 是 `SurfToolbar`：后退、前进、刷新、地址栏、一键下载（运行中同一格换成转圈，
  点转圈即取消）、更多（⋮）、关闭。全部直接操作 `RustWebView`，不经 Rust 往返。
  后退 / 前进按内容页历史置灰（不可用时 `isEnabled = false`、`alpha = 0.38`，不进入按压态）；
  地址栏下方是 2dp 确定进度条，由 `WebChromeClient.onProgressChanged` 驱动，100 时隐藏。
  「在浏览器打开」与「桌面版网站」收在「更多」菜单里（与 Chrome Android 同位置），地址栏因此更宽。
- 颜色统一由 `SurfTheme` 提供，工具栏与弹窗标题栏共用同一套深浅色。

`created_by_activity_name` 必须传主窗口 `activity_name()` 的返回值，不能写死 `"MainActivity"`：
tao 用 `getLocalClassName()` 登记 Activity 名，类名不以 applicationId 开头时返回全限定名。dev 包
applicationId 为 `app.kabegame.dev`、类为 `app.kabegame.MainActivity`，登记的是全名，写死短名会匹配
失败，`build()` 报 `failed to create window`（prod 包恰好能匹配，所以只在 dev 出现）。

wry 的创建顺序是先把 `RustWebView` 交给 `onWebViewCreate`，配置 client 与 IPC，最后才调用
`setContentView(webview)`；首个 `loadUrl` 是 post 出去的，晚于 `setContentView`。因此组合布局与
IPC 替换都在 `SurfActivity.setContentView` 中完成。根布局统一消费 system bar、display cutout 与
IME inset，键盘弹出时底部 padding 取 system bar 和 IME 的较大值。

## IPC 主框架化

wry 安卓用 `addJavascriptInterface("ipc")`，**所有 frame** 都能调用，而上报给 Tauri 做 ACL 的
URL 取自主框架最近一次 `onPageStarted` 的地址。外部页面成为 Tauri webview 后，页面里的第三方
iframe 会冒用主页面身份。

`SurfActivity` 在 `setContentView` 里 `removeJavascriptInterface("ipc")`，改用
`WebViewCompat.addWebMessageListener(webView, "ipc", setOf("*"))`：JS 侧仍是
`window.ipc.postMessage(string)`，Tauri 的 `ipc-protocol.js` 无感；Kotlin 丢弃非主框架消息，并以
当前主框架 URL 调用 `Rust.ipc`。回调在 UI 线程，`Rust.ipc` 移进单线程 executor——同步命令若再经
MainPipe 等主线程会死锁。设备不支持 `WEB_MESSAGE_LISTENER` 时**关闭 IPC**（只能浏览、不能一键
下载），不回退到所有框架可见的通道；`attach` 把 `ipcAvailable` 回传给 Rust，一键下载按钮据此
提示 `surf.collect.ipcUnavailable`。

## 注入脚本守卫（主框架 + 每文档一次）

安卓上每段初始化脚本都经 `surf_common::android_init_script(script, key)` 包两道守卫，畅游
（`surf_initialization_scripts`，key `surf-<序号>`）与 WebView 爬虫宿主（`create_crawler_activity`，
key `crawler-<序号>`）共用：

1. **只在主框架**：桌面 Tauri 的 `initialization_script` 只进主框架；wry 安卓用
   `addDocumentStartJavaScript(…, setOf("*"))`，脚本会进 iframe。
2. **每个文档只执行一次**：wry 生成的 `RustWebViewClient.onPageStarted` 对没经它拦截的请求（外部网页都是）
   会再 `evaluateJavascript` 一遍全部初始化脚本，不看 document-start 注入是否已生效，于是同一文档里每段
   脚本跑两次。守卫用 window 上不可枚举、不可改的 `__kb_init_<key>__` 标记挡掉第二次。没有它时，爬虫
   bootstrap 会在同一页把插件并行跑两份（日志成对出现、作品重复处理）。`RustWebViewClient.kt` 每次构建都
   重新生成，不能在那里改。

Tauri 自己的初始化脚本不经这层守卫，第二次执行时会在控制台报 `Cannot redefine property`，无害。
安卓没有导航栏，`surf_url_report.js` 不注入（地址由原生工具栏直接读 `doUpdateVisitedHistory` / `onPageStarted`）。

## 会合与单会话

Rust 创建 Activity 和调用移动插件 `attach` 的先后不能作为约定。`SurfRegistry` 分别保存已就绪
Activity 与待绑定 `SurfBinding`：

1. Activity 先到：按 label 登记并等待 binding。
2. `attach` 先到：保存 binding 与 invoke，等 `setContentView` 完成 IPC 替换后再一起 resolve
   （这样 Rust 才拿得到 `ipcAvailable`）。Rust 侧对 `attach` 设 10s 超时，超时销毁窗口并报错。
3. 两边齐备后，`bind` 让工具栏拿到文案与初始地址。

Android 同时只维护一个畅游会话。Rust 的 `SESSION` 是会话状态权威，记录 `host`、record id、
label 与 `ipc_available`。新会话会先通过 Kotlin 插件关闭旧 Activity；事件闭包还会核对 label。
每次会话的 label 追加进程内序号（`surf-<host>:<n>`），防止同站点重开时旧 Activity 的迟到
`closed` 事件清掉新会话，也不依赖 Tauri 立即从窗口表移除旧 label。

## 命令与事件流

Vue 继续使用桌面命令名：`surf_start_session`、`surf_close_session`、`surf_get_session_status`。
导航（后退 / 前进 / 刷新 / 地址跳转）不再有 Rust 命令，由原生工具栏直接操作 WebView。

Kotlin 通过 Rust 创建的 `tauri::ipc::Channel` 上报六类消息：

- `pageFinished { url, cookie }`：刷新记录的 Cookie；只有值实际变化时才写库
  （`update_surf_record_cookie_if_changed`）并广播 `surf-records-change`。弹窗可见时关闭弹窗也会
  补发一次，OAuth 登录后立即落库。
- `closed { cookie }`：Activity 销毁前最后保存一次，随后清除 `SESSION`、会话 VFS 目录
  （`surf_session::drop_session`）与一键下载槽位（`surf_collect::drop_slot`），并发
  `surf-session-changed { active: false }`。
- `collectToggle`：原生工具栏的一键下载按钮，Rust 调 `surf_collect::toggle(label)`。
- `pageDownload { url, suggestedName, mimeType }`：`setDownloadListener` 拦到的页面自发下载。
- `desktopModeChanged { desktop }`：「更多」菜单的「桌面版网站」开关。Kotlin 是显示状态权威，
  已经立即应用并刷新；Rust 核对当前会话后更新 `SESSION.desktop_mode` 与 `surf_records.desktop_mode`
  （只在值变化时写库并发 `SurfRecordChanged`）。
- `pinShortcut`：「更多」菜单的「添加到桌面」，Rust 走与前端同一个 `pin_shortcut`（见下节）。

导航状态、加载进度与弹窗生命周期都只在 Kotlin 内处理，不经 Rust 往返。

Rust → Kotlin 侧：`attach`（含工具栏文案、`desktopUserAgent`、`desktopMode`）、`close`、
`setCollectRunning`、`getDefaultUserAgent`，以及桌面快捷方式的 `listenShortcuts`、`pinShortcut`、
`updateShortcut`、`disableShortcut`。

## 桌面快捷方式

站点可以固定到桌面（`ShortcutManagerCompat.requestPinShortcut`），点开直接进入该站点的畅游。
入口两处：前端站点卡片菜单的「添加到桌面」（`surf_pin_shortcut`，仅 Android 注册）与原生工具栏
「更多」菜单（`pinShortcut` 事件），都落到 `surf_android::pin_shortcut`。

- **intent 指向 `MainActivity`，不是 `SurfActivity`**：`SurfActivity` 由 Rust `WebviewWindowBuilder`
  建窗（依赖主窗口的 Activity 名、注入脚本、`SESSION`），不能被单独拉起。快捷方式 intent 为
  `app.kabegame.action.OPEN_SURF` + extra `host`，快捷方式 id 为 `surf:<host>`。
- **只认已有记录**：`MainActivity` 是 exported 的，任何应用都能发这个 intent；Rust 按 host 查
  `surf_records`，查不到直接丢弃，查到用记录的 `root_url` 调 `surf_start_session`。intent 里不放 URL。
- **冷启动会合**：intent 早于 Rust 就绪到达。`SurfShortcuts` 暂存最新一个 host；Rust 在插件 setup 里
  调 `listenShortcuts` 注册 Channel，注册时投递暂存值，之后实时投递。插件 setup 早于 `init_globals`，
  投递到达时 `Storage::global()` 还没初始化（直接访问会 panic，实测冷启动停在画廊）：`open_from_shortcut`
  必须**先**等主窗口（在全局初始化之后创建，最多 10s），再查记录、开会话。不用 `.kgpg` 导入那种 `evaluateJavascript` 调前端全局函数的做法：
  前端未加载完时调用会落空。
- **重放保护**：`onCreate` 只在 `savedInstanceState == null` 时处理 intent（配置变化 / 进程恢复会带回
  原 intent）；带 `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`（从最近任务恢复）的快捷方式 intent 忽略。
- **返回与任务栈**：`MainActivity` 是 `singleTask`，点快捷方式会清掉其上已有的 `SurfActivity`，再由
  Rust 开新会话；从畅游按返回回到主界面（第一版有意保留）。冷启动时主界面会先短暂出现。
- **图标**：`surf_records.icon`（favicon，ico / png）以 base64 下发，Kotlin 放大到自适应图标画布的 44%
  居中垫白底（在 66dp 安全区内）；解不出时按 host 取色画首字母。固定时 favicon 可能还没抓到：
  `surf_start_session` 抓到 favicon 后、`surf_update_name` 改名后调 `refresh_shortcut`，只更新已固定且
  启用的快捷方式。
- **重复添加**：已固定且启用时不再 `requestPinShortcut`，只 `updateShortcuts` 刷新名称与图标并提示
  「已存在于桌面上」。用户从桌面移除图标后系统取消固定，可以再次添加。
- **删除记录**：应用删不掉桌面图标，`surf_delete_record` 后 `disableShortcuts`（点击显示「站点已删除」）。
  再次固定同一 host 前先 `enableShortcuts`，否则系统拒绝更新被禁用的快捷方式。
- **ROM 权限**：小米 / OPPO / vivo / 华为等默认关闭「创建桌面快捷方式」，`requestPinShortcut` 仍返回 true
  且没有回调。因此请求发出后统一弹系统 Toast 提示去设置里开启（Android 12+ Toast 最多两行，文案要短）；`supported=false` / `requested=false`
  才作为错误返回（前端 `ElMessage`、工具栏入口走页内 toast）。

## 下载：脚本下载与页面下载

桌面的畅游下载交给 CEF 原生下载，浏览器自己带 Cookie；安卓没有这条路。两类下载收敛到
`surf_receive::enqueue_surf_download`：

- **脚本发起**（一键下载、长按菜单、`surf_bootstrap.js` 的 `triggerDownload`）照旧
  `invoke("surf_download_image")`。
- **页面自发**（WebView 判定为附件的导航）由 `setDownloadListener` 拦截，交给 Rust。
  Rust 先拒绝**安卓应用安装包**（`surf_common::is_app_package_download`：扩展名 apk / apks /
  xapk / aab 或 MIME `application/vnd.android.package-archive`），toast
  `surf.download.appPackage` 并提示可在菜单切到桌面版网站；再拒绝**明确的压缩包**
  （`surf_common::is_archive_download`：扩展名或 MIME 是 zip / rar / 7z / tar / gz 等），
  toast `surf.download.unsupportedType`、不发起下载；压缩包不解压，解压属于各爬虫插件自己的事
  （`Kabegame.archive`），畅游只收媒体。其余一律走同一个入队函数，包括文件名与 MIME 都认不出的
  （`application/octet-stream` + URL 无扩展名很常见，`guessFileName` 会给出 `xxx.bin`）：
  由下载后处理按字节判定，真媒体入库，非媒体在那里报「格式不受支持」。

入队前安卓会补三个头，平台补的头覆盖页面给的：

- `Cookie`：SurfPlugin `getCookie` 读 `CookieManager.getCookie(媒体 URL)`（含 HttpOnly，空则不加头），
  Rust 入口 `surf_android::cookie_header_for_url`。**不要用 wry 的 `cookies_for_url`**：wry 生成的
  `RustWebView.getCookies` 把返回值声明为非空 `String`，没有 Cookie 的 URL（媒体 CDN 如 `i.pximg.net`
  很常见）返回 null 时会在主线程抛 NPE，应用直接崩溃。
- `User-Agent`：按当前会话模式取——移动版为系统 WebView UA（`android_webview_user_agent()`），
  桌面版为 `android_desktop_user_agent()`；派生失败时回落系统 UA。爬虫宿主取建窗时选定的 UA
  （`crawler_android::desktop_user_agent_for_label`，见下文「WebView 爬虫」）。
- `Referer`：`webview.url()`。

`data:` / `blob:` 的页面下载，Rust 在页面外取不到字节，转回页面里 `media_download.js` 已有的
`__kb_media_download__`，与 `surf_bootstrap.js` 的 `triggerDownload` 同口径。其它 scheme 提示
`surf.download.unsupportedScheme`。

`is_native_job` 在安卓上不再把 `surf_record_id` 当作 native（没有 CEF 下载 handler），改由
reqwest 下载并直接入图库；终态 toast 由 `DownloadState` 的统一分支经 `surf_toast_for_host`
返回页内。

## raw body 的安卓形态

Tauri 在安卓上没有自定义协议 IPC（`ipc-protocol.js`：`canUseCustomProtocol = osName !== 'android'`），
invoke 的 body 一律经 `JSON.stringify` 走 postMessage，到 Rust 是 `InvokeBody::Json`。
`page_fs::raw_body_bytes` 接受三种形态：桌面的 `Raw`、安卓分块写用的 `{ "base64": "..." }`、
页面直接传 `Uint8Array` 时得到的 JSON 数字数组（值必须 0–255，兼容用）。

`media_download.js` 在安卓上把每块编码成 base64 再发：数字数组约是原始体积的 3.6 倍，实测 1 MiB
一块往返 0.8–1.1 s（页面 `JSON.stringify` 约 80 ms、Rust 逐元素还原约 110 ms，其余耗在 JNI 与消息
传递上）；base64 只有 1.33 倍，同样一块往返 40–60 ms，Rust 解码不到 1 ms。安卓写块仍是 1 MiB（整块要
装进一条字符串消息），桌面 8 MiB。MSE 的分片常只有几 KB（YouTube Shorts 平均不到 2 KB），
`writeBuffer` 先把分片合并到写块大小再写，否则耗时全在逐片往返上（一条 Shorts 曾要 1308 次 invoke，
合并后 2 次）。

## Cookie 与 UA 口径

内容页每次完成加载时记录同站 host 的已访问 URL。保存时依次读取初始根 URL 和这些访问路径的
`CookieManager.getCookie(url)`，按 Cookie 名覆盖合并并排序。这样既能拿到 HttpOnly Cookie，也能
覆盖已经访问过的 `Path=/xxx` Cookie；从未访问过的其它 path-only Cookie 无法枚举，这是 Android
`CookieManager` API 的固有限制。第三方 Cookie 已开启，以兼容常见 SSO。

UA 不入库，`surf_records` 只存每站点的 `desktop_mode` 布尔值（存模式不存 UA 串：WebView 升级后
不会留下旧 Chrome 版本）。移动模式内容页不改 `userAgentString`，Cookie 的签发 UA 就是系统 WebView
默认 UA；桌面模式把内容页 UA 换成与当前 WebView 同 Chrome 大版本的 Linux 桌面 UA。桌面 UA 只有
一个派生入口 `kabegame_core::plugin::v8::android_desktop_user_agent()`（由已登记的系统默认 UA 取
`Chrome/<major>` 拼出；默认 UA 未登记或解析不出版本时返回 `None`），内容页、弹窗、插件与下载补头
都认它：

- **内容页**：`surf_start_session` 发现记录是桌面模式时用 `builder.user_agent(desktop)`，首个请求
  就是桌面 UA（强制跳应用商店 / 下发 apk 多发生在首个请求）。切换时 Kotlin 立即改
  `WebSettings.userAgentString`、UA Client Hints（`mobile=false`、`platform=Linux`、`model=""`）、
  宽视口与缩放，然后**重新请求跳转前的原始地址**（`WebHistoryItem.originalUrl`，同 Chrome「桌面版网站」的
  ORIGINAL_REQUEST_URL 重载），再发 `desktopModeChanged` 落库。不能用 `reload()`：站点按 UA 做服务端跳转时
  （`weibo.com` → 302 → `m.weibo.cn`），`reload()` 只重载跳转后的手机版地址，UA 已换成桌面也回不到桌面版。
  原始地址与当前地址相同（页面靠 JS 跳转）时才退回 `reload()`，这种站点要从首页重新进入。
- **弹窗**：`SurfPopup` 构造时应用内容页同一份 `SurfUaMode`，弹窗里签发的 Cookie 也配对。
- **Client Hints 的默认值**由 `SurfUaMode` 以进程级缓存捕获（`SurfActivity.setContentView` 在首次
  apply 前显式捕获）。不要按实例缓存：`bind` 会换一个新的 `SurfUaMode`，而重建后的内容页可能已经
  是桌面元数据，切回移动版时会把它误当默认值。
- **插件 `requireCookie(host)`**：记录是桌面模式时，在注入 Cookie 之后把任务的 `User-Agent`
  换成桌面 UA，但只替换「缺失或等于系统默认 UA」的值。现有插件都是先
  `setHeader("User-Agent", cefUserAgent())` 再 `requireCookie`，因此无需改插件就能配对；插件写死的
  UA（xhs、kemono、bilibili）和用户在任务 Header 里显式填的 UA 不被覆盖。命中时任务日志出现
  `taskLogDesktopUaInjected`。
- **畅游下载补头**：当前会话是桌面模式就补桌面 UA（见「下载」一节）。
- **WebView 爬虫（`CrawlerActivity`）**：与畅游共用 `CookieManager`，必须同样配对。
  `crawler_android::create_task_window` 用建窗地址（`start_url`，网页收集即来源页）的 host 查畅游记录
  （`surf_common::android_desktop_user_agent_for_url`，host 精确匹配后再试 `www.` 前缀的有无），是桌面模式
  就经 `builder.user_agent` 建窗，并按 label 登记，页面自发下载的补头读这份登记，任务窗口销毁时清掉；
  `CrawlerActivity.setContentView` 发现 UA 已被改过，就用 `SurfUaMode` 在首个请求前补齐 Client Hints 与视口。
  不能事后按任务的插件 `base_url` 重新推导：两者不一定相同。任务运行中切换畅游模式不影响已建的爬虫窗口。

`SurfPlugin` 注册时 Rust 异步调用 Kotlin `getDefaultUserAgent`（`WebSettings.getDefaultUserAgent`），
经 `kabegame_core::plugin::v8::set_android_webview_user_agent` 登记进 `OnceLock`，安卓上的
`Kabegame.cefUserAgent()`、移动模式的下载补头与桌面 UA 的派生都以它为基准。早于登记完成打开畅游时
`desktopUserAgent` 为 `null`，「桌面版网站」菜单项隐藏，下次打开恢复。

WebView 自动更新会改变 UA 里的 Chrome 版本（并重启进程），此前签发的 UA 绑定 Cookie 可能失效，需要
重新进畅游过一次验证；这与桌面升级 CEF 后的情况相同。切换桌面 / 移动模式后，旧 UA 下签发的
`cf_clearance` 也会失效一次，站点会重新校验；记录的模式与 Cookie 在下一次 `pageFinished` 同时更新。

## 导航、新窗口与限制

http/https 始终留在内容 WebView。`intent:` 仅接受 http/https 的 `browser_fallback_url`，其它 scheme
会被拦截；`on_navigation` 与 Kotlin 包装 client 同口径。内容 WebView 只在 debug 构建启用 WebView
debugging，可用 `chrome://inspect` 查看。

### 多窗口与 OAuth 弹窗

wry 安卓没有 `on_new_window`，也不动 `setSupportMultipleWindows`。Phase 3 在
`SurfActivity.setContentView` 里开启多窗口，并给内容页装转发型 `SurfChromeClient`：wry 的
`RustWebChromeClient` 是 Kotlin `final` 类、不能继承，因此逐方法转发它的 override（全屏视频、
权限、文件选择、JS 对话框、地理位置、控制台、标题），只额外实现 `onProgressChanged` 与
`onCreateWindow`。

新窗口请求按来源分流：

- **用户点链接**（命中测试是锚点、`isUserGesture`、href 为 http/https）：普通「新标签页打开」，
  保持单页语义，把目标 URL 交回内容页加载。pixiv 等站点的作品链接大量使用 `target=_blank`，
  若一律弹覆盖层，一键下载和长按菜单都会失效。
- **其余**（脚本 `window.open`，包括 GIS 按钮这种位于跨域 iframe 里的点击）：新建一个普通
  `android.webkit.WebView` 作为 transport 目标，放在内容区之上的覆盖层 `SurfPopup` 里，显示来源
  host 与关闭按钮。弹窗是普通 WebView（无 Tauri IPC、无注入脚本、无下载监听），与内容页同进程、
  共享 `CookieManager`，UA / Client Hints 跟随内容页当前模式；页面 `window.close()` 经
  `onCloseWindow` 关闭，关闭时补发一次 `pageFinished` 立即保存 Cookie，不等用户再导航。

`onCreateWindow` 本身不给目标 URL：链接型先建一个不显示的 transport 目标，拿到首个 http(s)
地址后再 `stopLoading`、销毁探针、把 URL 交回内容页。锚点里包图片时命中测试的 `extra` 是图片
地址而非 href，同样靠探针取真实目标；探针 2 秒内没拿到 http(s) 地址就静默销毁，不会留下隐藏
WebView。

- 同时最多一个弹窗；弹窗内 `setSupportMultipleWindows(false)`，弹窗里再 `window.open` 就在弹窗
  自身打开。
- 工具栏始终作用于内容页；弹窗有自己的标题栏。系统返回键优先作用于弹窗：弹窗能后退就后退，
  否则关闭弹窗；没有弹窗时先让内容页后退，退到头关闭 Activity。
- 关闭畅游（含配置变化重建）时先关弹窗再释放内容 WebView，弹窗不跨实例保留。

已知限制 / 待复查：

- wry 安卓没有 `on_download`、`on_new_window`；下载与弹窗分别由 `setDownloadListener` 与
  包装后的 `WebChromeClient` 兜底。**升级 wry / Tauri 时 diff `generated/RustWebChromeClient.kt`
  的 `override fun` 列表**：新增 override 若没在 `SurfChromeClient` 转发，会静默丢掉对应功能。
- 探针的首个导航在部分 WebView 版本上可能先报 `about:blank`，或只走 `shouldOverrideUrlLoading`
  不走 `onPageStarted`；两处都接了，且跳过 `about:blank`。
- 锚点里包着脚本按钮（`href` 为 http(s) 但 `onclick` 里 `window.open`）会被当成链接交回内容页，
  丢掉 opener。实测再按 host 白名单强制走覆盖层。
- 部分 OAuth 提供方给弹窗设置 `Cross-Origin-Opener-Policy`，会切断 opener；此时站点通常自带
  重定向回退，与桌面浏览器行为一致，不另做处理。
- 弹窗里的附件下载与一键下载不处理：弹窗没有注入脚本，也不装下载监听。要下载媒体请回内容页。
- 移动端 `Channel::new_with_id` 会把 Channel 登记进 `CHANNELS` 表（供原生插件按 id 推消息），
  表只增不减。上游连每次 IPC 调用的一次性响应 Channel 也登记，实测每次 invoke +1 且捕获 `Webview`；
  `third-patches/tauri/10` 让响应 Channel 不再登记。Rust 主动创建、交给 Kotlin 的 Channel（如本会话的
  `events`）仍每会话留一项，升级 Tauri 时复查。
- **内容 WebView 必须在 `onDestroy` 里手动释放**（`SurfActivity.releaseContent`）：先
  `removeWebMessageListener`，再 `stopLoading`、从布局摘下、`destroy()`。Chromium 以 JNI 全局引用持有
  WebMessageListener，监听闭包捕获了 webview 进而是 Activity，而 wry 的 `onWebviewDestroy` 只清 Rust
  侧回调表、从不调 `WebView.destroy()`；不释放时每关一次畅游，整个页面（渲染、定时器、网络）都留在进程里。
  **配置变化重建时同样要释放**：wry 只保留按 webview id 登记的回调表与创建参数，在新 Activity 里**新建**
  webview（同一 id、同一初始 URL），旧 Java 对象没人再用；不释放的话旧页面继续运行，并以同一 id 向 Rust
  发 IPC，响应却按 id 回到新页面。`MainActivity.onDestroy` 对主 webview 做同样处理。`configChanges`
  覆盖不到的变化（字体大小、显示大小、安装后首次启动的资源更新、`recreate()`）都会走这条路。
- 重建后的 `SurfActivity` 拿不到 binding（`attach` 只发生一次）：`onDestroy` 在 `isChangingConfigurations`
  时把 binding 交给 `SurfRegistry.carried`，同 label 的新实例在 `onActivityReady` 接走，工具栏文案、
  事件 Channel 与桌面模式开关照常可用；页面按初始 URL 重新加载，一键下载运行态不保留。
- **应用内所有 WebView 共用一个渲染进程**（主界面、畅游内容页、畅游弹窗、爬虫页）。渲染进程退出（崩溃或被系统
  回收）时，只要有一个 WebView 没在 `onRenderProcessGone` 返回 `true`，Chromium 就杀掉整个应用进程。
  `SurfActivity` 收到后关闭畅游；`MainActivity` 摘下死掉的主 webview、post `recreate()`，由 wry 重建
  主界面（前端从头加载，路由状态丢失）。外部页面的长任务与内存也会和主界面抢同一个渲染进程。
- tao 的 `MonitorHandle::size()` 在事件循环线程（永不返回 Java）上调 `getCurrentWindowMetrics`，
  JNI 局部引用不会释放，`WindowMetrics` 经 `ContextImpl` 钉住已销毁的 Activity。WebView 已
  `destroy()`，残留的只是 Java 对象（Activity + WebView 空壳）。畅游与 WebView 爬虫宿主都受影响，
  **每建一个子 Activity 约 50% 概率残留一个**（畅游 5 次开关残留 2 个；爬虫 8 个任务残留 4 个），触发链：
  1. 安卓开了 `unstable`，`tauri-runtime-wry` 建 webview 时调 `window.inner_size()`，落到 tao 的
     `MonitorHandle::size()`；
  2. 它用的是 `ndk_glue::main_window_manager()` = `WINDOW_MANAGER`（`BTreeMap<ActivityId, …>`）里
     **id 最小**的那个，而不是本窗口的；
  3. `ActivityId` 来自 wry 生成的 `WryActivity`：主界面是 `hashCode()`（正数），`startActivity(cls)`
     拉起的子 Activity 是 `Random.nextInt()`，比主界面小的概率约一半，此时新建的子 Activity 被当成「主窗口」，
     它的 `WindowMetrics` 局部引用就留在事件循环线程上。
  **已绕开**：`MainActivity.pinMainActivityId()` 在 `super.onCreate` 前往 intent 写
  `__wryActivityId = Int.MIN_VALUE`（wry `WryActivity.kt` 私有常量 `ACTIVITY_ID_KEY` 的值，升级 wry 要核对），
  主界面 id 恒为最小，子 Activity 不再被选中；重建时 wry 自己的 `onSaveInstanceState` 带回同一个 id。实测修后
  爬虫 8 个任务、畅游开关 6 次，强制 GC 后都只剩主界面 1 个 Activity。
  **仍残留**：主界面因未声明的配置变化（如字体缩放）或渲染进程崩溃而重建时，旧 MainActivity 可能被钉住
  （实测两次重建多 1 个）。根治只能给 tao 打补丁（`size()` 内用 local frame 释放引用并改用本窗口的
  window manager）。
- 初始化脚本在外部网页上会被注入两次（见「注入脚本守卫」）。我们的脚本由 `android_init_script` 保证
  每文档只执行一次；Tauri 自己的脚本第二次执行时在控制台报 `Cannot redefine property`，无害。
- 安卓 `tauri.conf.json` 的 capability 清单必须含 `crawler-capability`（模板
  `tauri.conf.json.handlebars` 的 `isAndroid` 分支）。漏掉时爬虫页的 `crawl_*` 全被 ACL 拒绝（`Command
  crawl_heartbeat not allowed by ACL`），插件一行日志都发不出，120 秒后任务以「WebView 窗口无响应」失败。
- 页面自发的 `blob:` / `data:` 下载（`<a download href="blob:…">`）是否触发 `onDownloadStart`
  尚未在干净进程验证。用 CDP（`kabegame-chromium`）连着测下载时，playwright 下发的
  `Browser.setDownloadBehavior` 会吞掉 WebView 的下载回调，连 http 附件都不触发，
  且断开后仍残留；测页面下载必须先强制停止应用、全程不连 CDP。
- `reqwest` 与浏览器指纹不同，个别 CDN 在 Cookie / UA / Referer 都正确时仍可能拒绝。
- 长按菜单依赖页面的 `contextmenu` 事件；已在 YouTube Shorts 真机确认长按会派发。命中判断先在整个
  元素栈里找自身带媒体的元素，祖先的背景图只作兜底（Shorts 的轮播项带首帧占位背景图，曾盖过下层
  `<video>`，把视频认成图片）。
- 大响应经 `fetch` 取数据：已用 `use_https_scheme(true)` 避开 https 页面的混合内容限制，
  `ipc` 自定义协议响应带 `Access-Control-Allow-Origin: *`。

相关实现：

- `src-tauri/kabegame/src/commands/surf_android.rs`
- `src-tauri/kabegame/src/commands/surf_common.rs`（label 解析、注入脚本、页内 toast）
- `src-tauri/kabegame/src/commands/page_fs.rs`（`crawl_fs_*` / `crawl_ffmpeg_*`，全平台）
- `src-tauri/kabegame/src/commands/surf_receive.rs`（下载入队与安卓补头）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfActivity.kt`（内容区、多窗口分流、桌面模式）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfToolbar.kt`（导航状态、进度、更多菜单）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfChromeClient.kt`（转发型 `WebChromeClient`）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfPopup.kt`（OAuth 弹窗 / 链接探针）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfUaMode.kt`（桌面 / 移动 UA、Client Hints、视口）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfTheme.kt`（工具栏与弹窗共用配色）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfPlugin.kt`
- `src-tauri/kabegame-core/src/plugin/v8/ops.rs`（`android_desktop_user_agent`、`requireCookie` 的 UA 替换）
- `src-tauri/kabegame-core/src/storage/migrations/v042_surf_record_desktop_mode.rs`
- `apps/kabegame/src/surf-navbar.ts`（仅桌面）
