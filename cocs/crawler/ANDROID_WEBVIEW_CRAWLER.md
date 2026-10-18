# Android WebView 爬虫（crawl.js 后端）

安卓上的 WebView 爬虫复用桌面的全部上层链路：`run_webview_session`、初始化脚本、`bootstrap.js`、
按 `crawler-<task_id>` label 认任务的 `crawl_*` 命令、心跳看门狗、下载队列与后处理都与桌面同一份。
差别只有三处：窗口放在哪、下载怎么执行、渲染进程退出怎么接。本文记录这三处与它们带来的生命周期约束。

## 宿主 Activity 与显示位置分离

每个 WebView 任务对应一个 `CrawlerActivity` 实例（`activity_name("CrawlerActivity")`，
`documentLaunchMode="always"`，每个实例单独成栈），但它**只当 wry 的宿主**：

- `onCreate` 在第一帧之前 `moveTaskToBack(true)`，用户看不到这个 Activity。
- wry 把 `RustWebView` 交给 `setContentView` 时，`CrawlerActivity` 不放进自己的窗口，而是交给
  `CrawlerHost.dock(label, webview)`。
- `CrawlerHost` 建一个 `FrameLayout` 容器（薄工具栏 + webview），以 `z = -1` 加到 `MainActivity`
  内容根节点第 0 位——**垫在主 webview 下面**。
- 插件调 `Kabegame.requestShowWebview()` 或用户在任务抽屉点「打开窗口」时，`show` 把容器 `z`
  提到 `10`；工具栏「收起」或系统返回键把它放回 `-1`。显示时先提到 `10` 再从底部滑上来（260ms，
  减速）；收起时先滑出底部（200ms，加速），动画结束才放回 `-1` 并复原 `translationY`。`shown` 与返回键
  回调的启用状态立即切换，只有画面在动；动画中途再显示会从当前位置滑回。容器不开硬件层（WebView 经
  draw functor 绘制，父级离屏层会让页面闪白）。

为什么不在宿主 Activity 里直接显示：原型实测「单独成栈 + 退到后台」的页面隐藏约 60 秒就被
Chromium 冻结（两轮复现，最长一次冻结 250 秒，期间 `setInterval` 一次都没跑）；只撤销 wry 的
`WebView.onPause()` 也仍在 76 秒冻结。只有挂进**可见窗口**的视图树才能持续运行：主界面窗口始终
可见，主 webview 不透明，用户看不到垫着的页面，但 Chromium 认为它 `visible`（rAF 约 59fps）。

代价与取舍：

- **不缩成 1×1**：爬虫依赖真实视口（布局、懒加载、`IntersectionObserver`、滚动），缩小会让页面行为
  与用户看到的不一致；垫着的页面在任务运行期间以约 60fps 跑 rAF，占 GPU 与电量。
- **不 `excludeFromRecents`**：实测不进最近任务的栈一离开前台就被 RecentTasks 当可清理项回收
  （`finish-imm:recent-task-trimmed`，182 ms）。代价是最近任务里可能多一张卡（同应用的栈通常被
  启动器合并）；`setTaskDescription` 用任务名标注，`autoRemoveFromRecents` 在结束时清理。
- **容器保持 `VISIBLE`**：只改 Z 序，不用 `GONE` / `INVISIBLE`，否则页面会被判成 hidden。工具栏用
  `INVISIBLE`（保留布局高度），显示 / 收起时视口不跳动。

`MainActivity` 重建（改字体大小、渲染进程退出后的 `recreate()`）时，`onWebViewCreate` 末尾调
`CrawlerHost.attachMain(this)`：容器从旧内容根节点摘下、挂到新根节点，并按当前显示状态重排 Z 序。
`CrawlerHost` 只持 `MainActivity` 弱引用。

## IPC 主框架化

与畅游共用 `ContentWebView.installMainFrameIpc(webView, executor)`：移除 wry 的
`addJavascriptInterface("ipc")`，换成 `addWebMessageListener("ipc")`，只收主框架消息；设备不支持
`WEB_MESSAGE_LISTENER` 时关闭 IPC（`attach` 回传 `ipcAvailable=false`），不回退到全 frame 可见的通道。
`Rust.ipc` 在单线程 executor 上执行（同步命令若再等主线程会死锁），同时保证消息顺序。

`ContentWebView.release(webView, ipcAvailable)` 负责摘监听、停载、摘链、`destroy()`。`CrawlerActivity`
在 `super.onDestroy()` 之后调用它（保证 wry 先拿到 webview id）；不释放的话监听被 Chromium 以 JNI
全局引用持有，整个页面渲染、定时器与网络都会留在进程里。

## 会合、命令与事件

`CrawlerRegistry` 是 `CrawlerActivity` 与 Rust `attach` 的会合点，两边到达顺序不定：

- Activity 先到：`onActivityReady` 登记，等 binding。
- `attach` 先到：先存 binding 与 invoke，等 `setContentView` 完成 IPC 替换后一起 resolve，
  Rust 由此拿到 `ipcAvailable`。
- Activity 已销毁：pending attach 直接 reject，避免 Rust 干等（Rust 侧另有 10 秒超时）。

`CrawlerPlugin` 命令：

| 命令 | 作用 |
|---|---|
| `attach { label, taskName, texts, events }` | 绑定任务名 / 工具栏文案 / 每任务 events Channel；resolve `{ ipcAvailable }` |
| `show { label }` | 提到主 webview 之上；app 在后台时记为待显示并 resolve `{ pending: true }` |
| `hide { label }` | 放回主 webview 之下（只改 Z 序） |
| `close { label }` | `finishAndRemoveTask()`，标记「预期关闭」 |
| `clearCookies { url }` | 逐个把该 URL 的 Cookie 写成过期，替代 wry 安卓空实现的 `delete_cookie` |
| `subscribeHost { events }` | 订阅进程级前后台切换 |

每任务 events Channel 的载荷：

- `pageDownload { url, suggestedName, mimeType }`：`setDownloadListener` 拦到的页面自发下载。
- `renderGone { crashed }`：共用渲染进程退出。Kotlin 返回 `true` 后由 Rust 结束任务。
- `cancel`：工具栏「取消任务」。
- `closed`：用户从最近任务划掉宿主。**只在不是 Rust 主动 close 时发送**——`CrawlerRegistry` 用
  「预期关闭」标记区分，否则刚完成的任务会被误标成取消。

全局 Channel 的 `hostVisibility { visible }` 由 `ProcessLifecycleOwner` 的 `ON_START` / `ON_STOP`
驱动（Activity 之间切换不触发）。

## 前后台语义

- app 退后台：主界面窗口不可见，垫着的页面同样 hidden；没有前台服务时进程会被 cached freezer
  冻结（原型实测 17 秒），有前台服务时也会在约 60 秒后被 Chromium 冻结。这是**暂停，不是失败**。
- 心跳看门狗在宿主不可见期间挂起（`crawler::webview::set_host_visible`），回到前台重新进入
  `select!` 循环、重置 120 秒期限；否则后台三分钟就会被误判成「WebView 窗口无响应」。
- `requestShowWebview` 在后台只记「待显示」，回到前台自动提到最上层并写一条任务日志
  （`taskLogWebviewPendingShow`）。用通知把用户拉回来留到后续。
- 返回键：有爬虫页面在前台时 `MainActivity` 的 `OnBackPressedCallback` 只把它收起，不退出主界面。
  这个回调必须在 `onWebViewCreate` 里、`super.onWebViewCreate` **之后**注册：`OnBackPressedDispatcher`
  先调用最后注册的回调，而 wry 在 `setWebView` 里注册的回调会把返回键消费成主界面 webview 的后退
  （主界面 `useModalBack` 靠历史记录关闭任务抽屉等覆盖层）。曾在 `onCreate` 里注册，结果按返回只收起了
  主界面的任务抽屉，爬虫页面原地不动；只有主界面退到历史起点时才轮到它。

## 共享渲染进程

安卓整个 app 只有一个 WebView 渲染进程。任何一个 WebView 的 `onRenderProcessGone` 不返回 `true`，
Chromium 就杀掉整个应用。三处都要接：主界面（`MainActivity`，重建自身）、畅游（`SurfActivity`，
关闭内容页）、爬虫（`CrawlerActivity`，以 `renderGone` 结束任务）。爬虫页收到后立即标记预期关闭并
回发事件，宿主窗口由 Rust 的 `destroy_task_window` 关闭。

代价：爬虫页的长任务和内存与主界面同一进程、同一渲染主线程；重页面可能让主界面卡顿，OOM 时整组
WebView 被回收（任务失败、主界面重建）。是否给安卓设「同时最多 1 个 WebView 任务」留到实测后决定。

## 下载

安卓没有 CEF 下载通道，`DownloadQueue::is_native_job` 在安卓恒为 false。两类下载都在入队前补
`Cookie` / `User-Agent` / `Referer`（`commands/surf_receive::android_identity_headers`，与畅游共用
同一份口径；Cookie 经 `SurfPlugin.getCookie` 读 CookieManager，避免 wry `cookies_for_url` 在无
Cookie 的媒体 URL 上 NPE）：

1. **脚本下载**：`Kabegame.downloadImage` → `crawl_download_image` → 补头 → `dq.download_image`，
   由 reqwest 下载并进入统一后处理。
2. **页面自发下载**：`pageDownload` → `assign_page_download_destination` 定向到任务 VFS 的
   `tmp/Downloads` → 带同一份头用 reqwest 流式落盘 → `finish_page_download`（成功 / 失败都经它 eval
   `window.__kb_native_download_finished__`，交回插件的 `Kabegame.onNativeDownload`）。不做压缩包
   拦截：WebView 插件自己决定怎么处理（与桌面一致）。`data:` / `blob:` 的字节只在页面里，页面外
   取不到，忽略。

## 与畅游的复用边界

共用：`ContentWebView`（主框架 IPC / 释放）、顶层守卫 `top_frame_only`（wry 安卓会把初始化脚本注入
到每个 frame）、`android_identity_headers`、`getCookie`、`CrawlerActivity` 式的 `created_by_activity_name`
读取（tao 用 `getLocalClassName()` 登记，dev 包是全限定名）。

不复用：显示位置（畅游的页面就是 `SurfActivity` 的主 webview、占满整屏；爬虫页面停靠在主界面下）、
工具栏（畅游是浏览器导航栏，爬虫只有任务名 / 收起 / 取消）、渲染进程退出的收尾（畅游关闭会话，
爬虫结束任务）。

## 测试与排查

- 真机（dev）：`deno task dev -c kabegame --mode android`。
- 页面下载在连 CDP 调试时不会触发 `setDownloadListener`（与畅游同一个已知限制），测页面下载时不要连 CDP。
- 页面在后台被冻结时，`setInterval` 停摆属预期；确认日志里没有心跳超时才是关键。
- 改字体大小 / 主界面渲染进程退出后，确认容器重新挂上、任务继续；不要出现同一任务两份页面。
- 渲染进程崩溃：任务以 `renderGone` 失败、主界面重建、app 不退出。

## 已知限制

- `<select>` 下拉、`alert()`、文件选择、HTTP 认证这些以 Activity Context 弹窗的功能可能弹到不可见的
  宿主窗口上；需逐项实测，必要时在 `RustWebChromeClient` 外包一层改挂到 `MainActivity`。
- 移动版页面：视口是手机尺寸、UA 是系统 WebView 的移动 UA，现有按桌面 DOM 写的 webview 插件
  选择器大概率失效；本期只保证运行时。
- tao JNI 局部引用泄漏：已由 `MainActivity.pinMainActivityId()` 绕开（主界面 wry ActivityId 固定为
  `Int.MIN_VALUE`），爬虫宿主不再残留；仍会残留的只有主界面重建时的旧 MainActivity。机制见
  [../surf/ANDROID_SURF.md](../surf/ANDROID_SURF.md) 已知限制。
- rAF 常驻 60fps 的耗电与温度需要在真机跑 30 分钟确认。
- `MainActivity` 重建时容器摘下再挂回，页面会短暂 detach；需确认不会触发 `visibilitychange`
  引起插件逻辑分支。
