# v4.5.2 regression

## Android WebView 爬虫 Phase 1（宿主 Activity + 停靠到主界面下）

安卓 WebView 后端落地：`run_webview_session` / `crawl_*` 命令 / `crawler-capability` 全平台编译，
每个任务一个 `CrawlerActivity`（`documentLaunchMode="always"`、第一帧前 `moveTaskToBack`）只当 wry
宿主，`CrawlerHost` 把页面装进容器垫到 `MainActivity` 主 webview 之下（`z=-1`），`show` / `hide` 只改
Z 序。主框架 IPC 从 `SurfActivity` 抽到 `ContentWebView` 共用；`CrawlerPlugin` 用每任务 events Channel
回传 `pageDownload` / `renderGone` / `cancel` / `closed`；`ProcessLifecycleOwner` 的前后台切换经全局
Channel 推给 `crawler::webview::set_host_visible`，看门狗在后台挂起计时。安卓 `is_native_job` 恒为
false，脚本下载与页面自发下载都补 Cookie / UA / Referer 后走 reqwest。前端不再拒绝 JS 插件，网页收集
恢复 WebView 后端，插件选择器上的「需桌面浏览器 / 安卓不支持」警告一并移除。文档见 `cocs/crawler/ANDROID_WEBVIEW_CRAWLER.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面静态检查 | 仓库 / Linux standard | `check-kabegame` driver `--skip vue` | `cargo check` 无 error；共享初始化脚本抽取未破坏桌面建窗 | 已运行：0 error |
| [x] | Android 静态检查 | Android NDK | `check-kabegame` driver `--mode android --skip vue` | aarch64 `cargo check` 无 error | 已运行：0 error |
| [x] | Kotlin 编译 | Android SDK 36 | `gradle :app:compileArm64DebugKotlin -x rustBuildArm64Debug` | `ContentWebView` / `CrawlerActivity` / `CrawlerHost` / `CrawlerPlugin` 与 manifest 编译通过 | 已运行：BUILD SUCCESSFUL |
| [x] | 下载 transport 单测 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib native_job_only_on_desktop` | 桌面畅游 job 返回 true、安卓 false；普通 http job 与 `data:` 恒为 false | 已运行：1 passed |
| [x] | 显示窗口 id 解析单测 | Rust 单测 | `test-kabegame` driver：`kabegame show_task_id` | 显式 `taskId` 去空白；缺省 / 空串时从 `crawler-<id>` 反推；主界面调用缺 `taskId` 报错 | 已运行：3 passed |
| [x] | 看门狗后台挂起单测 | Rust 单测（tokio 暂停时钟） | `test-kabegame` driver：`kabegame-core --lib webview_watchdog_suspends_while_host_hidden` | 宿主不可见时虚拟时间推进 10 分钟任务仍不结束；回到可见并正常完成返回 Ok | 已运行：1 passed（`dev-dependencies` 为 `tokio` 增加 `test-util`） |
| [ ] | WebView 网页收集 | Android dev | 网页收集选 webview 后端，收一个普通图集页 | 任务完成、图片入库、快照有 CSS；任务日志无心跳超时 | 先在畅游登录目标站可顺带验证登录态 |
| [ ] | 最小测试插件常驻 | Android dev | 最小 JS 插件：`setInterval` 计数 5 分钟 + `requestShowWebview()` + 输入框 | 计数不掉拍；显示后可点、可输入；「收起」与返回键放回下面；主界面全程正常 | 页面在任务运行期间 rAF 约 60fps |
| [ ] | 三分钟后台 | Android dev | 任务运行中按 Home 3 分钟再回来 | 任务不因心跳超时失败；日志可见后台暂停 / 恢复；回来后页面继续 | 无前台服务时可能被 cached freezer 冻结，属预期 |
| [ ] | 主界面重建 | Android dev | 任务运行中改系统字体大小 | 主界面重建后容器重新挂上，任务继续，不出现两份页面 | 关注端口 detach 是否触发 `visibilitychange` |
| [ ] | 渲染进程崩溃 | Android dev | 打崩共用渲染进程（可用 `chrome://crash` 页面） | 任务以 `renderGone` 失败；主界面重建；app 不退出 | 三处 WebView 都要接 `onRenderProcessGone` |
| [ ] | 登录态补头 | Android dev | 先在畅游登录某站，再跑需要登录的 webview 插件并用 `Kabegame.downloadImage` 下载 | 请求带 Cookie / UA / Referer，图片入库；无 Cookie 的 CDN 不崩溃 | Cookie 走 `SurfPlugin.getCookie` |
| [ ] | 页面自发下载 | Android dev（不连 CDP） | 在爬虫页点一个附件链接 | 落到任务 VFS `tmp/Downloads`，`onNativeDownload` 收到成功载荷并可导入 | CDP 会劫持 WebView 下载回调，测试时不要连 |
| [ ] | `clearData` | Android dev | 插件调用 `Kabegame.clearData()` | 该 URL 的 Cookie 被写成过期；localStorage / sessionStorage 清空 | 安卓走 `CrawlerPlugin.clearCookies` |
| [ ] | 后台 requestShowWebview | Android dev | 任务运行中按 Home，脚本调用 `requestShowWebview()`，再回到前台 | 日志出现 `taskLogWebviewPendingShow`；回到前台页面自动提到最上层 | 安卓限制后台拉起界面 |
| [ ] | 最近任务划掉 | Android dev | 任务运行中从最近任务划掉爬虫卡片 | 任务以取消结束，日志有 `taskLogWebviewHostClosed`，主界面不受影响 | 不能 `excludeFromRecents`，否则 182 ms 被回收 |
| [ ] | 桌面回归 | Windows / macOS / Linux | JS 插件任务、`requestShowWebview()`、`is_native_job` 下载、网页收集 webview 后端 | 结果与改动前一致；插件内 `requestShowWebview()` 不再报缺 `taskId` | |


## Android 畅游 Phase 2（内容页改为 Tauri webview + 原生导航栏）

Android 畅游的主次对调：外部内容页成为 `SurfActivity` 的 Tauri 主 webview（label `surf-<host>:<n>`），顶部导航栏改成原生 Kotlin 控件。内容页因此拿到与桌面同一份注入脚本与按 label 认会话的命令；wry 的 `addJavascriptInterface("ipc")` 换成只收主框架消息的 `addWebMessageListener`，脚本下载与页面自发下载共用 `surf_receive::enqueue_surf_download` 并补 Cookie / UA / Referer。安卓没有 CEF 下载通道，`is_native_job` 不再把 `surf_record_id` 当作 native；`crawl_fs_*` / `crawl_ffmpeg_*` / `surf_collect_*` / `surf_download_image` / `surf_import_media` 改为全平台注册，`raw_body_bytes` 兼容 postMessage 送来的 JSON 数字数组。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面静态检查 | 仓库 / Linux standard | `check-kabegame` driver `--skip vue` | `cargo check` 无 error，模块拆分与脚本列表抽取未破坏桌面 | 已运行：0 error |
| [x] | Android 静态检查 | Android NDK | `check-kabegame` driver `--mode android --skip vue` | aarch64 `cargo check` 无 error | 已运行：0 error（需先修复 `~/.cargo/registry` 下 tauri-plugin 的只读 `tauri-api/build` 残留） |
| [x] | Kotlin 编译 | Android SDK 36 | `./gradlew :app:compileArm64DebugKotlin` | `SurfActivity` / `SurfToolbar` / `SurfPlugin` 与 `ic_surf_*` 矢量资源编译通过 | 已运行 |
| [x] | 平台分支单测 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib surf_uses_native` | 桌面返回 true、安卓返回 false；非畅游 job 恒为 false | 已运行：1 passed |
| [x] | label 解析单测 | Rust 单测 | `test-kabegame` driver：`kabegame surf_common` | 桌面 `surf-example_com`、安卓 `surf-example_com:7` 都解析为 `example.com`；navbar / 空 label / 非 surf label 返回 None | 已运行：3 passed |
| [x] | raw body 兼容单测 | Rust 单测 | `test-kabegame` driver：`kabegame raw_body` | `InvokeBody::Raw` 与 0–255 的 JSON 数字数组都还原为字节；越界值 / 负数 / 非数组报错 | 已运行：3 passed |
| [ ] | 原生工具栏导航 | Android dev | 打开畅游站点，点后退 / 前进 / 刷新，地址栏输入新 URL 回车；触发 SPA 路由切换 | 四个操作都直接作用内容页；整页与 SPA 跳转后地址栏更新；系统返回键先页内后退，退到头关闭 Activity | dev 与 prod 包都测 |
| [ ] | 一键下载（pixiv） | Android dev / 已登录 pixiv 记录 | 在作品页点工具栏下载按钮 | 页内 toast、工具栏转圈并在完成后复位；图片进入该畅游记录；`i.pximg.net` 不 403（Referer 生效） | 补头来自 SurfPlugin `getCookie` / 系统 UA / `webview.url()` |
| [ ] | 无 Cookie 域名的下载 | Android dev | 在内容页点下载，媒体位于从未写过 Cookie 的 CDN 域名（如未登录时的 `i.pximg.net`） | 应用不崩溃；请求不带 `Cookie` 头，照常入队下载 | 曾因 wry `RustWebView.getCookies` 对 null 抛 NPE 而闪退，现改走 SurfPlugin `getCookie` |
| [ ] | 一键下载取消 | Android dev | 一键下载运行中点正在旋转的同一按钮 | 先停止旋转并取消尚未入队的候选；已入队项照常下载；再点一次可重新开始 | 运行中按钮仍是同一个 `ImageView`，只换图标 |
| [ ] | 工具栏图标与动画 | Android dev，浅色 / 深色各一次 | 打开畅游站点，逐个按压工具栏按钮；地址栏聚焦后输入 `ftp://x` 回车；启动一键下载 | 图标与桌面导航栏同一套线条图标并跟随深浅色；按压出现 32dp 圆角底色；聚焦时边框变蓝，无效输入红框约 0.9s 后恢复；运行中下载按钮换成弧线并以 0.8s 一圈匀速旋转，结束后复位到下载图标且不残留角度 | 图标在 `res/drawable/ic_surf_*.xml`，关闭按钮为新增的同风格 × |
| [ ] | YouTube Shorts 长按下载视频 | Android dev / `m.youtube.com/shorts/*`（桌面 CEF 畅游 YouTube Shorts 亦测） | 播放中长按视频画面 | 菜单显示「下载视频」而非「下载图片」，下载走 `blob:` / MSE 捕获 | 顶层手势覆盖层的祖先轮播项带首帧占位背景图 `frame0.jpg`，曾先于下层 `<video>` 命中；现在元素栈逐层只看自身媒体，祖先背景图仅作兜底。已在真机用新逻辑求值命中 `VIDEO` |
| [x] | 页面自发下载（媒体） | Android dev / 站点直链附件 | 点击一个图片或视频附件链接 | 直接进入该畅游记录；Cookie / Referer 生效 | `setDownloadListener` → `pageDownload`。已用本机测试服务（`Content-Disposition: attachment` 的 PNG）实测：WebView 与 reqwest 各请求一次，后者带 `Referer`，图片入库 |
| [x] | 页面自发下载（无类型） | Android dev | 点击 `application/octet-stream`、URL 无扩展名的图片附件（`guessFileName` 给出 `xxx.bin`） | 照样入队，后处理按字节识别为图片并入库；真非媒体在后处理报「格式不受支持」 | 原先文件名与 MIME 都认不出就直接拒绝，真图片也被挡；现在只提前拒绝明确的压缩包（`surf_common::is_archive_download`）。已实测入库 |
| [x] | 页面自发下载（压缩包） | Android dev | 点击 zip / 7z / tar 附件链接 | 提示 `surf.download.unsupportedType`，不发起下载、不入库 | 畅游只收媒体，解压交给插件。已实测：只有 WebView 的一次请求，没有 reqwest 重下 |
| [ ] | 页面自发 `blob:` / `data:` 下载 | Android dev | 点击页面生成的 `<a download href="blob:…">` 与 `data:` 图片链接 | `onDownloadStart` 触发，经页内 `__kb_media_download__` 导入该畅游记录 | 尚未在干净进程验证：此前的测试连着 CDP，playwright 的 `Browser.setDownloadBehavior` 劫持会吞掉 WebView 下载回调（http 附件同样不触发），结论作废。即使不触发，页面 revoke 也不影响脚本发起的下载：`media_capture.js` 的捕获表保留 Blob 对象（已实测） |
| [x] | `blob:` / MSE 视频 | Android dev / YouTube Shorts | 长按或右键视频触发下载 | 分块写入成功，合流后入库，进度面板正常 | 安卓分块写改发 `{ base64 }`（Rust `raw_body_bytes` 解码），1 MiB 一块往返从 0.8–1.1 s 降到 40–60 ms；MSE 小分片先合并到 1 MiB 再写，一条 Shorts 从 1308 次 invoke 降到 2 次，整次约 1.5 s |
| [x] | 直链视频下载 | Android dev / bilibili 移动版播放页 | 对 mp4 直链视频触发下载 | 补头入队，入库后可播放 | 已实测 |
| [x] | IPC 主框架化 | Android debug / CDP | 首个文档检查 `window.ipc`；在跨源 iframe（example.com）里重放主框架截获的合法 IPC 消息 | 首个文档的 `window.ipc` 即 WebMessageListener 版本（有 `addEventListener`）；iframe 重放无任何效果，同一条消息由主框架发出时回调正常触发 | 跨源 iframe 里同样有 `window.ipc` 与 `__TAURI_INTERNALS__`（含 invoke key），隔离完全依赖 Kotlin 的 `isMainFrame` 判断。设备不支持 `WEB_MESSAGE_LISTENER` 时工具栏下载提示 `surf.collect.ipcUnavailable` |
| [x] | 关闭后释放内容 WebView | Android dev | 连续开关畅游数次，`dumpsys meminfo` 看 Activities / WebViews，CDP 看页面列表 | 关闭后 CDP 页面列表立即不再有该页；页面 JS、定时器与网络停止 | 原先 `addWebMessageListener` 的监听被 Chromium 以 JNI 全局引用持有并捕获 webview，wry 又从不 `destroy()`，每关一次就整页泄漏。剩余已知泄漏：tao 在事件循环线程上取 `WindowMetrics` 的 JNI 局部引用不释放，仍会钉住部分已销毁的 Activity（5 次开关残留 2 个、约 1 MB） |
| [x] | IPC 响应 Channel 不再进表 | Android dev | 临时插桩统计 tauri mobile `CHANNELS` 表大小，连续 invoke 100 次 | 表大小不随 invoke 增长 | `third-patches/tauri/0011`：修复前每次 invoke 的响应 Channel 都进表且永不移除（100 次 +101） |
| [x] | 重建不残留旧主 webview | Android dev / CDP | 先确认 CDP 只有一个主界面页面并在页面上打标记，再 `adb shell settings put system font_scale 1.15` 触发 `MainActivity` 重建 | 重建后 CDP 只剩一个主界面页面且不带标记；新页面 `invoke` 正常返回 | 原先 wry 在新 Activity 里新建 webview、从不销毁旧的，旧页面继续跑并以同一 id 发 IPC（响应回到新页面，旧页面上的 `invoke` 永远挂起）。安装后首次启动的系统重建（`wm_relaunch_resume_activity` 0x80000000）也会触发。已实测；测完把 `font_scale` 改回 1.0 |
| [x] | 畅游页重建 | Android dev / CDP | 打开畅游站点并打标记，再改 `font_scale` 触发 `SurfActivity` 重建 | 只剩一个内容页且不带标记；工具栏文案仍在；一键下载能触发并复位 | binding 经 `SurfRegistry.carried` 交给新实例。已实测：重建后点下载，Rust 回推两次 `setCollectRunning`（开始 / 结束） |
| [x] | 渲染进程崩溃不连带应用 | Android dev | 让一个外部页面的渲染进程崩溃（原型用 `chrome://crash`；也可在畅游页触发） | 应用进程存活；主界面重建并可正常 `invoke`；畅游页关闭 | 应用内 WebView 共用一个渲染进程，此前主界面没处理 `onRenderProcessGone`，崩溃信息为 `Render process's crash wasn't handled by all associated webviews`，整个应用被杀。已用爬虫 WebView 原型实测主界面路径；畅游关闭路径未单独实测 |
| [ ] | 关闭会话 | Android dev | 关闭 SurfActivity，再查看主界面与临时目录 | 会话 VFS 目录被清理；Cookie 已保存；`surf-session-changed` 正确 | `closed` 事件走 `drop_session` / `drop_slot` |
| [ ] | 桌面回归 | Windows / macOS / Linux | 一键下载、冻结快照、取消、页面自发下载（含 zip 解压）、MSE 视频捕获 | 结果与改动前一致；页面自发下载仍走 CEF 并在桌面解压 | 桌面 `surf_uses_native` 保持 true |

## Android 畅游 Phase 3（导航状态与进度、OAuth 弹窗、桌面版网站、apk 拦截）

工具栏后退 / 前进按内容页历史置灰，加载进度改为 `onProgressChanged` 驱动的确定进度条；「在浏览器打开」
与新增的「桌面版网站」收进「更多」菜单。内容页开启多窗口并包装 wry 的 `WebChromeClient`：链接型新窗口
用隐藏 transport 探针取真实 URL 后交回内容页，脚本 `window.open`（GIS 等 OAuth）进 `SurfPopup` 覆盖层，
弹窗是共享 CookieManager 的普通 WebView，最多一个、关闭时补发 `pageFinished`。桌面版网站按站点存进
`surf_records.desktop_mode`（迁移 v042），桌面 UA 只由 `android_desktop_user_agent()` 从系统默认 UA 派生；
内容页建窗、弹窗、插件 `requireCookie`、畅游下载补头都认记录模式。页面自发下载的 apk / 安装包提前拒绝。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面静态检查 | 仓库 / Linux standard | `check-kabegame` driver `--skip vue` | `cargo check` 无 error；存储与迁移改动未破坏桌面 | 已运行：0 error |
| [x] | Android 静态检查 | Android NDK | `check-kabegame` driver `--mode android --skip vue` | aarch64 `cargo check` 无 error | 已运行：0 error |
| [x] | Kotlin 编译 | Android SDK 36 | `./gradlew :app:compileArm64DebugKotlin -x rustBuildArm64Debug` | `SurfChromeClient` / `SurfPopup` / `SurfUaMode` / `SurfTheme` 与改动后的工具 Activity 编译通过 | 已运行：BUILD SUCCESSFUL |
| [x] | 桌面 UA 派生单测 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib desktop_chrome_major` | 典型 WebView UA 解析出 `155`；缺 `Chrome/` 或版本非数字返回 `None` | 已运行：1 passed |
| [x] | 迁移与模式写入单测 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib v042`、`--lib surf_records` | v042 幂等加列且默认 0；`desktop_mode` 只在值变化时写库 | 已运行：1 + 2 passed |
| [x] | apk 判定单测 | Rust 单测 | `test-kabegame` driver：`kabegame --lib surf_common` | apk / apks / xapk / aab 与安装包 MIME 命中；媒体与 zip 不命中 | 已运行：5 passed |
| [ ] | 导航置灰与进度 | Android dev | 刚打开站点、点链接、后退、SPA 路由切换各一次；在慢网页加载中点新链接 | 无历史时后退 / 前进置灰且按压无 ripple；有历史后对应按钮可用；进度条从左到右增长、到 100 隐藏，加载中切新链接不做回退动画 | 后退 / 前进置灰与启用已实测；进度条动画与 SPA 待复测 |
| [x] | 链接型新窗口分流 | Android dev / 合成锚点 | 点一个 `target=_blank` 的 http 链接 | 仍在内容页打开，不出现覆盖层；后退键随即可用 | 已实测 example.org：内容页跳转、目标列表无新增 page；锚点 + 用户手势 + http(s) href 分流 |
| [ ] | Google 登录弹窗 | Android dev / x.com 登录页 | 点「使用 Google 登录」（GIS 按钮在跨域 iframe 内） | 出现覆盖层，标题为 `accounts.google.com`；完成登录后弹窗自行关闭，内容页进入登录态，畅游记录 Cookie 立即更新 | 弹窗共享 CookieManager；关闭补发 `pageFinished` |
| [x] | 弹窗返回键与关闭 | Android dev / 合成 `window.open` | 用户手势打开弹窗，弹窗内再导航后按返回键；再按一次；另测 `window.close()` | 先弹窗页内后退，退到头关闭弹窗，再按作用于内容页；`window.close()` 立即关闭 | 已实测：目标列表只剩内容页，覆盖层标题为来源 host；关闭畅游时的清理待复测。同时最多一个弹窗 |
| [ ] | 弹窗渲染进程崩溃 | Android dev | 弹窗打开时打崩共用渲染进程（如 `chrome://crash`） | 应用进程存活；畅游关闭，主界面自动重建 | 弹窗与内容页都要在 `onRenderProcessGone` 返回 true |
| [ ] | 转发型 ChromeClient | Android dev | 打开全屏视频、任意上传框、`alert` / `confirm` | 行为与包装前一致 | 升级 wry 时 diff `RustWebChromeClient` 的 override 列表 |
| [x] | 桌面版网站切换 | Android dev | 「更多」→ 勾选 / 取消「桌面版网站」 | 页面刷新；勾选后 `navigator.userAgent` 为桌面 UA、`navigator.userAgentData.mobile === false`、platform `Linux`；取消后回到系统 UA、`mobile === true`、platform `Android` | 已实测（Chrome 155）。取消时必须在「重开桌面模式会话」后再测一次：`bind` 换实例曾把桌面 Client Hints 误当默认值，已改为进程级缓存并在首次 apply 前捕获 |
| [x] | 按站点记住模式 | Android dev | 切桌面版后关闭畅游，再打开同站 | 同站首屏即桌面版且菜单仍勾选 | 已实测：`surf_records.desktop_mode` 1 → 0 随开关写入；重开后首屏 `navigator.userAgent` 即桌面 UA。另一个站点未单独复测 |
| [ ] | 强制跳应用的站点 | Android dev | 移动 UA 下会跳应用商店 / 下 apk 的站点，切桌面版 | 出现网页登录入口并可登录 | |
| [x] | 被服务端跳到手机版后切桌面版 | Android dev / weibo.com（移动 UA 302 到 `m.weibo.cn`） | 在 `m.weibo.cn` 上「更多」→ 勾选「桌面版网站」，再取消 | 勾选后回到 `weibo.com` 桌面版（帖子显示「来自 微博网页版」）；取消后回到 `m.weibo.cn` | 已实测。曾经只 `reload()` 跳转后的 `m.weibo.cn`，UA 已是桌面但页面始终是手机版；现在重载 `WebHistoryItem.originalUrl` |
| [x] | 爬虫页面返回键收起 | Android dev / xhs-webview 运行中，主界面有可后退的历史（如打开了任务抽屉） | 在任务抽屉点「打开窗口」，再按系统返回键 | 爬虫页面收起回主界面下面，任务抽屉与主界面路由保持不变；再按返回才作用于主界面 | 已实测。曾因爬虫返回回调早于 wry 的回调注册，返回键被主界面 webview 消费，只收起了任务抽屉 |
| [x] | 爬虫页面显示 / 收起动画 | 同上 | 打开窗口、按返回或点「收起」；在收起途中立刻再打开 | 显示从底部滑上（约 260ms），收起滑出底部（约 200ms）后露出主界面；中途再打开从当前位置滑回，不闪白、不跳 | 已录屏抽帧核对显示与收起；中途再打开未测 |
| [x] | 爬虫并行与销毁 | Android dev / 任务并发上限 2 | 同时启动两个 xhs-webview 任务（各 3 条），等全部完成 | 运行中有 2 个 `CrawlerActivity`、2 个爬虫页面，各自完成 3/3、日志不串；结束后只剩 `MainActivity`，最近任务里没有爬虫卡片，强制 GC 后堆内 Activities / WebViews 都只剩主界面的 1 个 | 已实测（`dumpsys activity activities` / `dumpsys meminfo`，ART `SIGUSR1` 触发 GC） |
| [x] | 安卓 WebView 爬虫能跑 | Android dev / xhs-webview 0.1.3 | 推荐模式、最多 3 条 | 任务日志从「ページ読み込み · initial」一路到「完了 · 成功 3/3」，3 张图入库 | 已实测。曾因安卓 capability 清单漏了 `crawler-capability`，`crawl_heartbeat` 被 ACL 拒绝，插件一行日志都没有，120 秒后报「WebView 窗口无响应」 |
| [x] | 安卓注入脚本不重复执行 | Android dev / xhs-webview | 同上 | 每条插件日志只出现一次，作品不重复处理 | 已实测。wry 的 `onPageStarted` 会对外部网页再 `evaluateJavascript` 一遍初始化脚本，插件曾并行跑两份；现由 `android_init_script` 每文档一次守卫挡住 |
| [ ] | WebView 爬虫跟随桌面版 | Android dev / 小红书畅游记录已勾选「桌面版网站」 | 运行 xhs-webview 任务，展开爬虫页面；页面里查 `navigator.userAgent` / `navigator.userAgentData.mobile`；再取消该记录的桌面版重跑 | 勾选时爬虫页面为桌面版，UA 为桌面 UA、`mobile === false`；页面自发下载补的 `User-Agent` 也是桌面 UA；取消后爬虫回到移动 UA | 已实测勾选时爬虫页为桌面 UA、`mobile === false`；取消后回移动 UA 与下载补头未测。曾经 `create_crawler_activity` 不读畅游记录，爬虫恒为移动 UA，用桌面 UA 签发的 Cookie 失配。`www.` 前缀有无视为同一站点（单测 `surf_host_candidates_toggle_www_prefix`） |
| [ ] | Google 拒绝 WebView UA | Android dev | 移动模式弹窗报 `disallowed_useragent` 后切桌面版重试 | 桌面模式下可通过 | Google 按 UA 里的 `; wv` 识别 WebView |
| [ ] | 插件桌面 UA 配对 | Android dev / 桌面模式记录跑 weibo | 运行 `setHeader("User-Agent", cefUserAgent())` + `requireCookie` 的插件 | 任务日志出现 `taskLogDesktopUaInjected`；请求不 403 | 只替换缺失或等于默认 UA 的值 |
| [ ] | 插件写死 UA 不覆盖 | Android dev / 桌面模式记录跑 xhs | 运行写死 UA 的插件 | UA 保持插件自己的值，不出现 `taskLogDesktopUaInjected` | |
| [ ] | 桌面模式下载补头 | Android dev | 桌面模式下一键下载一个需要登录的媒体 | 请求 `User-Agent` 为桌面 UA（debug ingest 补头记录） | `android_identity_headers` 按会话模式取 UA |
| [ ] | apk 下载拦截 | Android dev（不连 CDP） | 页面里点一个 apk 链接 | toast `surf.download.appPackage`，下载列表不出现该项 | 扩展名与 `application/vnd.android.package-archive` 都判 |
| [ ] | 桌面回归 | Windows / macOS / Linux | 桌面畅游、插件 `requireCookie`、一键下载 | 结果与改动前一致 | 桌面 `cefUserAgent()` 与 `requireCookie` 的 UA 不变 |

## Android 分享 MediaStore 图片

Android 图片的 `local_path` 是 MediaStore `content://` URI，原 `SharePlugin.shareFile` 把它当文件路径做 `File.exists()`，必然报「文件不存在」。现对 `content://` 直接作为 `EXTRA_STREAM` 分享并附 `ClipData` + 读授权；content URI 没有扩展名，前端推出的 `application/octet-stream` 回退为 `ContentResolver.getType`。普通文件路径仍走 FileProvider。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | MediaStore 图片分享 | Android dev | 在画廊或预览中对已下载图片点击分享 | 弹出系统分享面板，不再提示分享失败 | 原报错 `文件不存在: content://media/...` |
| [ ] | 目标应用可读 | Android dev | 分享到聊天应用或相册类应用 | 目标应用能正常显示图片，无权限错误 | 依赖 `FLAG_GRANT_READ_URI_PERMISSION` + `ClipData` |
| [ ] | MIME 正确 | Android dev | 分享 JPEG、PNG 与视频各一项 | 分享面板只列出能处理对应类型的应用，视频不被当作图片 | 类型来自 `ContentResolver.getType` |
| [ ] | 外部导入图片 | Android dev | 分享从系统相册导入（沿用原 content URI）的图片 | 同样能分享并被目标应用读取 | |

## Android 启动任务时请求通知权限

Android 13 及以上把通知权限请求移到用户主动启动任务的入口：系统弹窗在任务入队前出现，授权或拒绝后都继续启动任务。通知状态刷新不再自行触发权限弹窗，避免任务已经运行后才询问；权限 launcher 由 `MainActivity` 在生命周期启动前注册，插件只经 host 接口调用。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 首次启动请求 | Android 13+ / 清除应用通知权限状态 | 在插件详情或任务配置中点击启动任务 | 点击后立即出现系统通知权限弹窗，任务尚未入队 | 用户动作与权限请求同一条调用链 |
| [ ] | 授权后启动 | Android 13+ | 在权限弹窗选择允许 | 弹窗关闭后任务正常启动，任务与下载进度通知正常显示 | |
| [ ] | 拒绝后启动 | Android 13+ | 在权限弹窗选择不允许 | 弹窗关闭后任务仍正常启动；调用不悬挂，界面不一直等待 | 前台服务仍可按 Android 规则运行 |
| [ ] | 状态刷新不补弹窗 | Android 13+ / 通知权限未授予 | 让定时任务或已有任务产生状态、下载进度变化 | 状态刷新本身不弹通知权限框 | 只在用户主动 `start_task` 时请求 |
| [ ] | 旧系统兼容 | Android 12 及以下 | 启动任务 | 不出现运行时通知权限弹窗，任务和通知行为保持不变 | `POST_NOTIFICATIONS` 无运行时授权要求 |
| [ ] | 已授权重复启动 | Android 13+ / 已允许通知 | 连续启动两个任务 | 不重复弹权限框，两个任务均正常入队 | |

## Android 插件标签提示

Android 上的插件标签改用点击触发 Tooltip，避开 WebView 把触摸合成为短暂 hover 后在抬手时发送 `mouseleave` 的行为。桌面端继续使用延迟悬停提示。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 触发策略单测 | Vitest | 运行 `KbLabel.test.ts` | Android 标签 Tooltip 使用 `click` 且无显示延迟 | 覆盖平台分流 |
| [x] | 点击保持 | Android dev | 打开任一带标签的插件详情并点击标签 | 抬手后提示保持显示，不会立即消失 | 真机实测抬手 1 秒后仍为 `display: block`、`aria-hidden=false`；再次点击标签或点外部均可关闭 |
| [ ] | 多入口回归 | Android dev | 在插件列表、选择器与快捷预览中分别点击标签 | 各入口的标签提示均可保持并正常关闭 | 共用 `KbLabel` |
| [ ] | 桌面回归 | Windows / macOS / Linux | 鼠标悬停及移出插件标签 | 悬停 200ms 后显示，移出后关闭，无需点击 | Android 分支不影响桌面 |

## Android 外部链接打开方式确认

Android 不再绕过应用内统一的外部链接打开设置。首次点击插件详情中的 `baseUrl` 等外部链接时，与桌面端一样确认是在畅游中打开还是跳转系统浏览器；用户选择记住后，后续链接直接沿用该设置。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Android 分流单测 | Vitest | 运行 `openExternalLink.test.ts` | 选择畅游只启动畅游会话；选择系统浏览器只调用外部跳转 | 覆盖 Android 平台常量 |
| [x] | 首次确认 | Android dev / `linkOpenMode` 为“每次询问” | 打开任一插件详情，点击正文上方的 `baseUrl` | 弹出“如何打开这个链接？”，可选择畅游或系统浏览器，不直接跳转 | 真机 CDP 点击确认 |
| [x] | 弹窗不挤走文档 | Android dev | 打开选择框，再关闭选择框 | 全局宿主位于 `app-container` 外，遮罩固定覆盖视口；插件 Doc 留在原位，不会被约一屏高的遮罩挤到下方形成空白 | 真机修复前测得遮罩误为 `position: relative`、高约 680px；修复后为 `position: fixed`、Doc 标题纵坐标保持 377.67px |
| [x] | 全局模态宿主层级 | Android dev | 检查 `App.vue` 挂载后的 DOM，再打开链接选择框 | 设置、导入、更新、任务、整理、收集等全局模态单例与选择框都位于 `app-container` 外；选择框遮罩不在容器内 | 真机 CDP 检查容器只保留主内容与底部导航，选择框 `insideContainer=false` |
| [x] | 畅游打开 | Android dev | 在确认框选择“在畅游窗口打开” | 打开 Android 独立畅游页面并导航到插件 `baseUrl` | 真机打开 `https://anime-pictures.net/` 并成功显示站点 |
| [ ] | 系统浏览器打开 | Android dev | 在确认框选择“在系统浏览器打开” | 跳转系统默认浏览器，不启动畅游会话 | |
| [ ] | 记住选择 | Android dev | 勾选“下次保持此选择”后任选一种方式，再点击另一个外部链接 | 不再弹框，直接沿用已保存的打开方式；设置页可改回“每次询问” | |
| [ ] | 桌面与 Web 回归 | Windows / macOS / Linux / Web | 分别点击插件 `baseUrl` | 桌面维持原确认与设置逻辑；Web 仍直接新标签页打开 | |

## Android 页面标题栏全宽贴边

Android 紧凑布局下所有使用公共 `PageHeader` 的页面统一紧贴状态栏安全区下缘并按视口全宽展示，标题栏不再跟随图库、画册、源等页面内容区的外围留白缩进；布局由既有 `isCompact` 响应式状态统一控制，平板横屏等非紧凑布局维持桌面 gutter。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 主导航页面 | Android dev | 依次进入图库、画册、畅游和源 | 各页标题栏紧贴状态栏安全区下缘并左右贴齐屏幕边缘，正文原有宽度和留白不变 | 四页真机 CDP 实测均为 x=0、y=42px、宽 360px，无横向溢出；图库截图确认按钮未裁切 |
| [x] | 设置与详情页面 | Android dev | 打开设置、任务详情、插件详情和自动配置页 | 公共标题栏顶部和左右均不留页面 padding，正文仍保留原 gutter，返回与操作按钮可正常点击 | 真机实测标题栏均为 x=0、y=42px、宽 360px；设置正文保留 20px、插件与任务详情保留 16px gutter |
| [ ] | 畅游图片页 | Android dev / 有畅游媒体记录 | 从畅游记录打开图片页 | 公共标题栏顶部和左右均不留页面 padding，查询区仍保留 20px gutter | 当前空态不挂载 `PageHeader`，需有数据场景复核 |
| [ ] | 平板横屏回退 | Android 平板横屏 | 进入任一含公共标题栏的页面 | 非紧凑布局恢复桌面 gutter，不继续强制按视口全宽贴边 | 复用 `uiStore.isCompact`，不按平台常量判断 |
| [ ] | 桌面回归 | Windows / macOS / Linux 非紧凑布局 | 打开任一含标题栏的页面 | 标题栏继续服从页面内容宽度，不扩展到视口边缘 | 由 `uiStore.isCompact` 响应式隔离 |

## Android 畅游插件快选按钮

Android 畅游首页不再把完整插件选择器塞进搜索胶囊，改为左侧固定宽度的图标按钮；点击仍复用统一 Android 插件选择弹窗，选中后把插件根 URL 填入输入框。桌面宽屏保留原有下拉选择器。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Android 全宽布局 | Android dev | 进入畅游首页 | 页面内容区不再保留 20px 外围 padding，正文与标题栏等宽铺满可用宽度；搜索框与下方记录卡片左右对齐 | 真机 CDP 实测容器 padding 为 0，正文与标题栏宽度均为 360px；搜索框与卡片均从 x=14.4px 起、宽 331.2px，截图确认无横向溢出 |
| [x] | Android 首页布局 | Android dev | 进入畅游首页 | 胶囊左侧只显示插件图标按钮，URL 输入区不再被插件占位文案挤压 | 真机 HMR 截图确认 |
| [x] | 插件选择 | Android dev | 点击插件图标，选择任一有 HTTP 根地址的插件 | 弹窗正常打开并可由返回键关闭；选中后关闭弹窗并把根 URL 填入输入框 | 真机已验证打开、返回关闭与 URL 填充 |
| [ ] | 无障碍标签 | Android TalkBack | 聚焦插件图标按钮 | 读出“选择插件”等当前语言文案 | |
| [ ] | 桌面回归 | Windows / macOS / Linux | 进入畅游首页并选择插件 | 仍显示 `150px` 下拉选择器，填充 URL 与启动畅游行为不变 | |

## Android 插件详情标题栏动作图标化

Android / 紧凑布局的插件详情标题栏不再显示“已安装”状态 chip 或安装、更新、重装文字按钮；状态仍在正文展示，标题栏动作统一使用带无障碍标签的图标按钮。桌面宽屏继续显示原有文字与状态。
商店插件的安装确认框与已安装插件的卸载确认框都改由统一 `useModal` 栈管理，Android 返回键可按层级关闭；安装确认框同时补齐格式化后的安装包大小，不再出现空括号。安装成功后保留当前商店详情与滚动位置，不再切换到本地详情路由；卸载成功后因详情对象已不存在，直接用 replace 切到插件列表，不再叠加历史回退。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 待安装插件标题栏 | Android dev | 从任一商店源打开未安装插件详情 | 标题栏显示下载图标按钮，不显示“安装”文字；插件名、ID 与版本获得更多空间 | 真机 CDP 截图确认 |
| [x] | 安装确认框包大小 | Android dev / 日语 | 点击待安装插件标题栏的下载图标 | 确认文案的括号内显示格式化后的安装包大小，不出现 `()` | 修复后真机 CDP 截图显示 `1 MB` |
| [ ] | 安装确认返回栈 | Android dev | 打开安装确认框后按系统返回键 | 只关闭确认框，仍停留在插件详情；再次按返回才离开详情 | `useModal` 统一管理 |
| [ ] | 安装后保留详情 | Android dev | 在商店插件详情确认安装并等待成功 | 弹窗关闭并提示成功；URL、当前商店详情和滚动位置不变，操作按钮更新为重装 | |
| [ ] | 卸载确认返回栈 | Android dev | 从“已安装”详情打开卸载确认框后按系统返回键 | 只关闭确认框，仍停留在插件详情；再次按返回才离开详情 | `useModal` 统一管理 |
| [ ] | 卸载后返回列表 | Android dev | 在已安装插件详情确认卸载并等待成功 | 弹窗关闭并提示成功，只切换一次到插件列表；不会越过列表，也不会通过返回重新进入已删除详情 | 使用确定性 replace，不调用 `router.back()` |
| [ ] | 更新与重装图标 | Android | 分别打开有新版和同版本的商店插件详情 | 两种状态均显示刷新图标，点击后仍进入对应更新或重装确认流程 | |
| [ ] | 已安装插件标题栏 | Android | 从“已安装”打开插件详情 | 标题栏不显示“已安装”chip，只保留复制 ID 与卸载图标；正文状态 chip 仍存在 | |
| [ ] | 桌面宽屏回归 | Windows / macOS / Linux | 打开待安装、可更新、可重装与已安装插件详情 | 安装类按钮仍显示文字，已安装状态 chip 仍显示，动作行为不变 | |

## 本地媒体 URL 统一为 wildcard path

桌面、Android 与 debug Web 的原图、缩略图、浏览器兼容副本统一把绝对路径编码在 URL path 中：`/file/{*path}`、`/thumbnail/{*path}`、`/compatible/{*path}`。旧 `?path=` 形式和独立 `/download/{*path}` 均删除；三类端点继续使用各自的图库字段白名单。Windows 拖出不固定选择原图，而是使用触发拖拽的媒体元素当前 `currentSrc`，让已经回退成功的缩略图或兼容副本也能拖出。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 三类媒体加载 | Windows / macOS / Linux | 浏览网格并打开原图、缩略图和兼容副本各不相同的图片或视频 | 请求分别走三个 wildcard 端点，中文、空格、`#`、`?` 路径均正常加载 | 不出现 `?path=` |
| [ ] | Windows 原图拖出 | Windows | 从网格或预览拖一张原图存在的媒体到资源管理器 | 通过当前 `/file/{*path}` 地址落地，文件名和内容正确 | 无 `/download` 请求 |
| [ ] | Windows 回退源拖出 | Windows | 临时移走原图，让界面回退到缩略图或兼容副本后拖到资源管理器 | 拖出当前可见/可播放的回退源，文件名后缀与该源一致 | 分别覆盖 thumbnail、compatible |
| [ ] | Android content URI | Android | 导入 `content://` 图片和视频，打开网格、预览并拖动视频进度 | wildcard URL 能还原完整 content URI，图片显示、视频 Range/seek 正常 | |
| [ ] | 旧端点移除 | curl | 请求 `/file?path=...` 与 `/download/...`，再请求三个新端点 | 旧形式 404；新端点仅对图库登记路径返回媒体，任意本地路径仍为 404 | |
| [ ] | Kabegame Server 插件 | 两台桌面端 | 从开启 Web 服务器的实例复制一页图片 | 媒体经 `/file/{*path}` 下载成功，元数据与标签不变 | |
| [x] | 前端 URL 单测 | Vitest | 运行 `fileUrl.test.ts` | Unix、Windows 盘符、UNC、中文、保留字符与 content URI 均生成正确 URL，三端点可还原原路径，拖出文件名为当前 source 的 basename | 35 passed |
| [x] | Rust 路径与路由单测 | `test-kabegame` | 运行 `kabegame media_route` | Unix 补回 `/`，Windows 盘符与 UNC 保持原样；query 与 `/download` 已不匹配路由 | 3 passed |
| [x] | 桌面静态检查 | `check-kabegame` | 运行完整检查 | vue-tsc、cargo check 均无 error | 已通过，仅既存 warning |
| [x] | Android 静态检查 | Android NDK / Gradle | 运行 Android check 与 `:app:compileUniversalDebugKotlin` | aarch64 Rust 与 Kotlin 均无 error | Kotlin BUILD SUCCESSFUL |
| [x] | 插件打包 | `kabegame-plugin` skill | 部署 `kabegame-server` | 生成 `kabegame-server.kgpg` | 已通过；未改插件版本号 |

## Web 兼容副本 CDN 转写与 OSS 挂载

Web release 的媒体响应不提供 `/file`、`/thumbnail` 或 `/compatible`，所有媒体路径必须在 RPC 出口转成 CDN URL。此前只处理 `local_path` 与 `thumbnail_path`，导致 `compatible_path` 泄露服务器本地路径；线上 `images`、`thumbnails` 已指向 `/mnt/oss`，但约 19.86 GB 的 `compatibles` 仍在本地。现在四个路径字段统一转写，线上兼容目录同步到 OSS 后改为软链接。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 线上现状确认 | `cmtheit.com` | 检查文件、挂载、RPC 与 CDN | 兼容文件本地存在；`compatible_path` 未转写；OSS 无 `compatibles`；对应 CDN URL 为 404 | 已确认：2010 个文件，约 19.86 GB |
| [x] | OSS 初次同步 | `cmtheit.com` | 将本地 `compatibles/` 两阶段同步到 `/mnt/oss/compatibles/` | 文件数与总字节一致，抽样文件 CDN 返回 200 | 2010 个文件、19,863,366,234 字节完全一致；首/中/末样本 SHA-256 一致；示例 CDN 200 |
| [x] | 目录切换与释放空间 | `cmtheit.com` | 停服补增量，建立 OSS 软链接，启动验证后删除原目录 | 服务恢复 active；新生成兼容副本直接进入 OSS；本地不再保留约 19.86 GB 副本 | 链接解析到 `/mnt/oss/compatibles`，`/__ping` 为 `ok`；原目录已删除，根盘约 23 GB 可用 |
| [x] | 新对象 MIME | `cmtheit.com` | 安装 `mailcap`、重启 ossfs2，经软链接写入临时 PNG 后请求 CDN | CDN `Content-Type` 为 `image/png`，探针随后删除 | 已实测；迁移批次旧对象仍保留 `application/octet-stream` 元数据，但无 `nosniff` 且均为 PNG/JPG |
| [ ] | RPC 路径转写 | Web release | 查询含四类路径的图片行 | 所有非空本地路径均为 `https://cdn.kabegame.com/<目录>/<文件>`，无服务器绝对路径 | |
| [x] | 静态检查与单测 | 仓库 | 跑 `image_rewrite` 测试及 `deno task check -c kabegame` | 测试、vue-tsc、cargo check 均无错误 | 7 tests passed；vue-tsc 与 cargo check 0 error，仅有既存 warning |

## Web RPC 按方法拆分请求路径

Web 前端把 JSON-RPC 请求从统一的 `/rpc` 改为 `/rpc/{method}`，URL 中的方法名经编码并与 body 的 `method` 保持一致，方便在浏览器 Network 面板按接口筛选。服务端继续保留 `/rpc` 兼容既有插件与外部客户端；命名路径与 body 不一致时返回 JSON-RPC `-32600`，不执行调用。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | Network 按方法过滤 | Web | 打开开发者工具 Network，触发画廊翻页、打开设置 | 请求分别显示为 `/rpc/pathql_fetch` 等具体方法，可按 URL 过滤 | |
| [ ] | super 请求 | Web `?super=1` | 执行一个写操作 | 请求为 `/rpc/<方法>?super=1`，写操作正常完成 | |
| [ ] | 旧入口兼容 | curl / `kabegame-server` 插件 | 继续向 `/rpc` 发送合法 JSON-RPC body | 行为与改动前一致 | |
| [ ] | 方法不一致 | curl | 向 `/rpc/get_albums` 发送 body `method: get_tasks_page` | 返回 `-32600`，两个方法均不执行 | |
| [x] | 前端请求单测 | Vitest | `deno task --cwd apps/kabegame test --run src/api/web.test.ts` | URL pathname 为 `/rpc/pathql_fetch`，body 仍携带同名 `method` 与参数 | 已运行，1 passed |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 无错误 | 已运行；仅有既存 warning |

## Tauri 2.12.4 升级

Tauri 栈从 2.11.2 升级到 2.12.4，`third-patches/tauri` 已重基到新上游；现有 CEF runtime 的 trait 适配回归见下一节。本节集中验证升级影响到的桌面打包、NSIS、Android 开发/安装链路、窗口与 Channel 生命周期、ACL，以及删除 0010 后的 Windows vcruntime 行为。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查 | 仓库 / Linux standard | `deno task check -c kabegame` | `vue-tsc` 与 Rust `cargo check` 无 error | 已运行；仅有既存 warning |
| [ ] | dev helper 静态 vcruntime | 未安装 VC++ 运行库的 Windows | `deno task dev -c kabegame`，等待 dev 期预构建并启动 `kabegame-cef-helper` | helper 正常启动，不报缺少 `VCRUNTIME140.dll` | 0010 已删除，验证上游 `staticVCRuntime=true` 默认值 |
| [ ] | Linux `tauri build` | Linux | 构建 deb，检查 Cargo 产物与包内 `files` | `kabegame-cef-helper` 被编译并安装到 `/usr/lib/kabegame/`，可随主程序启动 | |
| [ ] | Windows `tauri build` | Windows | 构建 NSIS 并安装，检查安装根目录后卸载 | helper 被编译并由 NSIS 安装到主 exe 同级；卸载后 helper 无残留 | 顶层 `bins` / patch 0009 |
| [ ] | macOS `tauri build` | macOS | 构建 `.app`，检查 `macOS.files` 与启动链路 | helper 被编译并打入配置位置，主程序可正常派生 | |
| [ ] | NSIS 安装生命周期 | Windows | 分别做同版覆盖安装、低版→高版升级、卸载 | 配置/数据符合现有策略，旧 exe 与 helper 均被替换或清理，不出现文件占用失败 | |
| [ ] | NSIS 降级拦截 | Windows | 对更高版本分别运行普通、静默与被动模式的低版安装包 | 三种模式均拦截降级；静默/被动模式不绕过版本判定 | |
| [ ] | Android USB dev + HMR | Android USB 真机 | `deno task dev -c kabegame --mode android`，检查 devUrl、`adb reverse`，修改前端源码 | 保留 localhost，自动建立 `adb reverse tcp:1420 tcp:1420`，页面和 HMR WebSocket 均走 USB 回环且连续热更新 | patch 0005 |
| [ ] | Android `tauri android check` | Android NDK | `deno task check -c kabegame --mode android --skip vue` | fork CLI 执行 `tauri android check`，共用 cargo-mobile2 工具链并无 Rust error | patch 0004 |
| [ ] | Android Picker 导入 | Android USB 真机 | 多选图片和视频，再通过 SAF 选择文件夹导入 | 多选结果全部入库；`content://` 视频和 SAF 目录均可读，无序列化或权限异常 | |
| [ ] | Android 压缩包导出 | Android USB 真机 | 选择多张图片导出压缩包到 Pictures | Pictures 中生成可打开的压缩包，文件齐全且无 `content://` 错误 | |
| [ ] | Android 返回键退出 | Android USB 真机 | 从主界面按返回键退出，再从桌面图标重新启动 | `exit_app → app.exit(0)` 完整退出，无白屏/残留 Activity，重启正常 | 上游 2.12 会 `finishAffinity()` |
| [ ] | Android 运行中覆盖安装 | Android USB 真机 | 应用运行时覆盖安装新 APK，重启后使用 Picker 并请求通知权限 | 无 PluginManager / ActivityResult 注册崩溃；Picker 可回传，通知权限流程正常 | `TaskNotificationPlugin` 的 lazy 注册原有风险仍需观察 |
| [ ] | 爬虫窗口生命周期 | 桌面 CEF | 反复创建并关闭 `crawler-<task_id>` 窗口，记录监听器数与内存 | 关闭后监听器不累积，renderer/browser 资源和内存回落 | |
| [ ] | 畅游窗口生命周期 | 桌面 CEF | 反复打开/关闭畅游窗口，记录监听器数与内存 | 监听器不累积，关闭后内存回落，不影响主窗口 | |
| [ ] | 畅游一键下载 Channel | 桌面 CEF | 对多张媒体执行一键下载，观察 Channel 进度直到完成 | 进度单调、连续到达完成值，无中途停更、跳回或关窗后残留回调 | |
| [ ] | `dynamic-acl` / capability 拒绝 | 桌面 CEF / Android | 从未授权窗口调用受限命令，再从已授权窗口调用 | 未授权调用按 capability 拒绝，已授权调用正常；不出现全放行或全拒绝 | |
| [ ] | deb 无 WebKit Depends | Linux | 构建 deb 后读取 control `Depends` | 仍不含 `libwebkit2gtk-*`，依赖无重复 | patch 0002 + 0006 |

## CEF runtime 适配 Tauri 2.12

`tauri-runtime-cef` 已同步 `tauri-runtime` 2.12.2（Tauri 2.12.4）的 trait：app handle 的显示器查询返回 `Result`；指定显示器全屏会在 CEF UI 线程退出旧全屏、移动到目标显示器并重新全屏；CEF 无法在创建 HWND 时注入 `WS_EX_NOREDIRECTIONBITMAP`，因此该 builder 选项明确保留为 no-op。新增的权限请求 handler 转发到 CEF 权限回调，macOS 启动激活策略与不再受 feature 门控的透明窗口签名也已同步。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查 | 仓库 / Linux standard | `deno task check -c kabegame` | `vue-tsc` 与 Rust `cargo check` 无 error | 已运行；仅有既存 warning |
| [ ] | 指定显示器全屏 | Windows / macOS / Linux 双屏 | 将窗口放在一块显示器，从另一块显示器的物理坐标调用 `set_fullscreen_on_monitor` | 窗口移动到坐标所在显示器并全屏；坐标不命中任何显示器时不改变窗口 | 需双屏实机回归 |
| [ ] | 权限请求转发 | 桌面 CEF | 注册 `on_permission_request`，分别触发允许、拒绝与默认处理的摄像头 / 麦克风 / 通知请求 | handler 收到对应 `PermissionKind`，CEF 按返回值允许、拒绝或执行默认策略 | 需带权限设备实机回归 |
| [ ] | macOS 启动激活策略 | macOS | 分别以 `activate_ignoring_other_apps` 开 / 关启动应用 | 启动激活行为与配置一致，窗口透明配置仍能正常构建 | Linux check 不覆盖该 cfg 分支 |

## CEF IPC 恢复 fetch 主通道

删除 `tauri-runtime-cef` 的 `force_postmessage_ipc_transport`：不再把上游 `ipc-protocol.js` 的 `customProtocolIpcFailed` 预置为 `true`，invoke 回到上游 `fetch(ipc://localhost/<cmd>)` 主通道，响应直接作为 fetch body 返回，DevTools Network 面板可见。原注释所称「`Tauri-*` 头触发 CORS 预检、CEF 收不到」经实测不成立：CEF scheme handler 处理的请求不发预检，只在响应上校验 ACAO，Tauri `ipc` handler 已返回 `*`。fetch 失败时上游脚本仍自动回退 `window.ipc.postMessage`（`cef-ipc://` JSON 桥）。第三方页面实测（`connect-src 'self'` 严格 CSP 下）标准 invoke 照样走 `ipc://` 并携带 raw body，因此删除 runtime 注入的 `__kb_raw_invoke__` 与 `cef-ipc://localhost/raw` 帧化通道；`media_download.js` 的分块写与 `bootstrap.js` 的 `Kabegame.fs` 写入改用标准 `invoke(cmd, Uint8Array, { headers })`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查 | 仓库 / Linux standard | `deno task check -c kabegame --skip vue` | Rust `cargo check` 无 error | 已运行；仅有既存 warning |
| [x] | 主窗口首帧起 invoke | Linux dev（删除前用 `KB_DEBUG_IPC_FETCH=1` 插桩等效验证） | 经 CDP 开 Network 域后重载主窗口，统计全部 IPC 请求与控制台回退告警 | 全部为 `POST ipc://localhost/<cmd>` 且 200，无 `IPC custom protocol failed` 告警；raw body invoke 同样 200 | 实测 54 个请求全部成功；手工 fetch 用错误 invoke key 时 Tauri 不回调 responder，表现为请求失败，与 CORS 无关 |
| [ ] | Network 面板可见 | 桌面 CEF（三平台） | 打开主窗口 DevTools → Network，触发画廊翻页、设置保存等 invoke | 每次 invoke 显示为一条 ipc 请求，状态 200，Response 可读到 JSON | |
| [ ] | macOS 主通道 | macOS | 同上，并观察控制台 | 不出现 `IPC custom protocol failed` 回退告警，功能正常 | 用户待测 |
| [ ] | Windows 主通道 | Windows | 同上；Windows 上 ipc 走 `http://ipc.localhost` | 请求 200、无回退告警 | Linux 已用 `http://ipc.localhost` 对照实验验证 JSON 与 raw body 均可达 |
| [ ] | Windows 严格 CSP 第三方页面 | Windows 畅游窗口（CSP 严格站点，如 github.com） | 畅游一键下载视频 | 下载正常 | 风险：`http://ipc.localhost` 不享受 `CSP_BYPASSING`，若被 `connect-src` 拦下会回退 postMessage，二进制退化成数字数组导致写入失败 |
| [x] | 第三方页面 IPC 与 CSP | Linux dev 畅游窗口（anime-pictures.net，动态插入 `connect-src 'self'` 的 meta CSP） | 对照：`no-cors` 请求 example.com；再用标准 invoke 调 `crawl_fs_fwrite`（raw body）与 JSON 命令 | 对照请求被 CSP 拦下并触发 `securitypolicyviolation`；invoke 仍走 `ipc://` 返回 200，raw body 被解析（业务错误 `resource id invalid`），无回退告警 | 经 CDP 改写文档响应头注入 CSP 的尝试未生效，结论只取 meta 方式 |
| [ ] | raw 大块读写一致 | 桌面 CEF 畅游窗口（严格 CSP） | 标准 invoke 以 8 MiB 分块写 16 MiB+ 随机数据后 `crawl_fs_read_file` 读回比对 | 写入字节数正确，读回逐字节一致 | 验证删除帧化桥后 `fetch` 直接携带大 `Uint8Array` body 不丢数据 |
| [ ] | 畅游一键下载 / WebView 插件 | 桌面 CEF（三平台） | 畅游一键下载 blob/MSE 视频；跑一个用 `Kabegame.fs.writeFile` 的 WebView 插件任务 | 下载、合流、导入正常；Network 中写入为普通 `ipc://…/crawl_fs_fwrite` 请求 | |
| [ ] | 生产包主通道 | 安装版（页面为 `tauri://localhost`） | 安装新构建后操作画廊、设置、任务 | invoke 正常，Network 可见 | dev 下页面 origin 为 `http://localhost:1420` |

## 畅游 / WebView MSE 视频下载：按捕获覆盖补拉、按清晰度拼接与进度面板

长视频右键下载原先「16 倍速从头播 + loop」，完整性看 `video.buffered`：X 只往前缓冲十几秒并回收已播部分，条件永远不满足，表现为结尾回卷重放直到停滞超时；16 倍速还让自适应码率降档，多档清晰度的分片被套在第一个 init 后拼接，导致流错位或 FFmpeg 找不到流；MediaSource 刚重建时 `duration` 为 `NaN` 被误判为直播。现在 `media_capture.js` 在 append 时按清晰度分组并累计覆盖区间，`media_download.js` 等元数据后以正常倍速跳缺口补拉、只拼同一清晰度，并在页面右下角显示每档覆盖条与阶段。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 分组与拼接（离线） | node + ffmpeg | 720p / 360p 两档分片交替追加，含重复 init、重复分片、跨两次 append 的半截分片，选 720p 拼接后 ffprobe / 解码 | 720p 20 片覆盖 0–20s，360p 4 片覆盖 3–7s；拼出文件 1280×720、20.0s，解码无错误 | |
| [x] | 长视频右键下载 | Linux dev 畅游 x.com（197s 视频） | 播放几秒后右键「下载视频」 | 不再 16 倍速回卷；全程 1280×720 单一清晰度，约 48s 补齐 0–197s 后写入、合并、导入成功；面板显示两路覆盖条、目标标记与补拉位置 | 同场另外 2 次下载亦成功 |
| [ ] | 元数据未就绪 | 桌面 CEF 畅游 x.com | 点播放后立刻右键下载 | 先显示「等待视频元数据」，随后正常补拉；不再报「无法全缓冲直播流」 | |
| [ ] | 清晰度回退 | 桌面 CEF（限速网络，播放器会降档） | 长视频右键下载 | 目标档在缺口 8s 无增长时面板提示改用覆盖最完整的一档，产物为单一清晰度可正常播放 | |
| [ ] | 换集 / 移除 | 桌面 CEF 畅游 B 站或 X 时间线 | 下载中切到下一集或滚动使视频卸载 | 面板与提示「视频已切换或被移除，下载中断」，原视频状态不被写到新视频上 | |
| [x] | 混合容器合流 | 本机 FFmpeg 8.1.1 | H.264（MP4）+ Opus（WebM）分别 stream copy 封 WebM / MP4 | WebM 写头失败（复现 YouTube 的 `write mux header … Error(-22)`）；MP4 成功且完整解码无错误；H.264 + Vorbis 封 MP4 亦成功 | 规则改为全部流是 WebM 才封 WebM |
| [ ] | YouTube 右键下载 | 桌面 CEF 畅游 YouTube（H.264 视频 + Opus 音频） | 右键下载一个长视频 | 合并为 MP4 并导入成功，可正常播放 | |
| [x] | 捕获层中止与重同步（离线） | node + ffmpeg | 分片切 64 KiB 流式追加；半截分片后 `abort()`；半截后不 abort 直接换段；中途混入 5000 字节垃圾 | 四种情况均 20 片覆盖 0–20s、仍为 fMP4、拼出文件解码无错误；计数分别为 aborts 1 / resyncs 1 / resyncs 1，丢弃字节等于半截或垃圾长度 | |
| [ ] | YouTube 补拉不再停滞 | 桌面 CEF 畅游 YouTube | 多次右键下载 2–5 分钟视频 | 面板在播放器正下载缺口时显示「等待 X 处的分片下载完成」且不回跳；不再出现「视频补拉停滞超时」；分组标题若出现中止 / 重同步计数仍能完成 | 复现时面板曾停在 0:30，播放位置约 0:36 |
| [ ] | 丢片移除重拉 | 桌面 CEF | 制造捕获丢片（如重同步丢弃）后下载 | 面板提示「重新拉取 X 处丢失的分片（第 n 次）」并补齐；3 次仍失败时报「捕获丢失 X 处的分片…」 | 依赖站点播放器在缓冲被移除后重新下载 |
| [ ] | 非 fMP4 容器 | 桌面 CEF（WebM MSE 站点） | 右键下载 | 覆盖条取 `SourceBuffer.buffered` 历史并集，能补齐并完成或给出明确错误 | WebM 仍按 append 顺序拼接（`unordered`），乱序时可能不可播，为既有限制 |
| [ ] | WebView 插件 blob 下载 | 桌面 CEF WebView 插件任务 | 插件 `downloadImage(blob:)` 下载 MSE 视频 | 有对应 `<video>` 时同样补拉；没有时按现有覆盖选清晰度并成功或明确报错 | |
| [x] | Linux 畅游帮助不再提示无法下载 | Linux 桌面 CEF / 仓库 | 打开「畅游」页的帮助弹窗；`deno task check -c kabegame --skip cargo` | 弹窗只有功能介绍与记录说明，不再出现「因 WebKit 限制无法下载」；`surf.linuxHintHelp` 已从五种语言移除，vue-tsc 无 error | 已运行静态检查；弹窗待实机看一眼 |
| [x] | 注入页文案五语齐全 | 仓库 | `cargo test -p kabegame-i18n` | `webview_keys_translated_in_every_locale` 通过：`WEBVIEW_KEYS` 每个键在 zh/zhtw/en/ja/ko 都有译文 | 已运行 |
| [ ] | 畅游文案跟随应用语言 | 桌面 CEF 畅游 | 把应用语言切到 English，新开畅游窗口：右键图片 / 视频、下载一张图、右键下载一个 MSE 视频 | 右键菜单、「已加入下载列表」/ 成功 / 失败 toast、视频捕获面板标题、分组、阶段与错误都显示英文，没有 `menu.xxx` 之类的原始键 | 已打开的页面要刷新后才换语言 |
| [ ] | WebView 爬虫窗口文案 | 桌面 CEF WebView 插件任务 | 非中文语言下跑一个会下载 `blob:` / MSE 视频的 WebView 插件，显示爬虫窗口 | 捕获面板显示当前语言；`get_webview_i18n` 未被 capability 拒绝 | `crawler.toml` 已加授权 |

## 插件商店启动刷新、可更新导航角标与最低版本安装守卫

应用加载已安装插件后，商店 store 会先从后端 index 缓存恢复所有源，再在全平台静默强制刷新一次，之后每 4 小时继续强制刷新；进入商店 tab 的兜底重拉阈值也同步为 4 小时。可更新插件按 id 去重，并统一排除 `minAppIncompatible` 条目；桌面侧栏与紧凑端底部 tab 的「插件」图标通过通用 `v-corner-badge` 显示数量。后端在 `.kgpg` 复制进插件目录前校验 `min_app_version`，商店安装、文件导入和拖入导入共用守卫。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 启动缓存与静默刷新 | 桌面 CEF / Web | 启动后不进入插件页，观察商店请求与插件导航图标 | 先显示缓存计算出的角标；每个源随后静默强制刷新一次，期间不出现商店骨架屏 | 桌面 dev：停在画廊页，官方源与虚拟源均已加载，虚拟源 index 被请求（缓存缺失 + 强制刷新）；停在虚拟源 tab 重载、index 延迟 4s，7s 内 67 次采样骨架屏 0 次、`loadingBySource` 始终为假，卡片首帧即由缓存显示；Web 未测 |
| [x] | 4h 周期与 tab 兜底 | 桌面 CEF / Web | 保持应用运行超过 4h，再进入一个商店 tab | 周期刷新按时强制拉取；进入 tab 只在 index 至少 4h 未更新时兜底联网 | 周期临时改为 1 分钟验证：启动刷新后约 64s 定时器再次请求，期间无操作，index 换成含兼容更新的版本后角标自动 0→1；随后进入商店 tab 无额外请求（缓存未满 4h）；Web 未测 |
| [x] | 桌面与紧凑导航角标 | 桌面侧栏 / 窄窗口或 Android | 准备多个已安装低版本插件，其中一个商店版本不兼容 | 仅「插件」图标显示去重后的兼容更新数；不兼容条目不计入，亮/暗主题和折叠侧栏下不裁切 | 桌面侧栏：虚拟源 nekos-moe 0.1.2 计入、konachan 99.0.0（要求 >=99.0.0）不计入，显示 1，选中态不裁切；应用无暗色模式；紧凑端（仅 Android / 窄 web）未测 |
| [x] | 更新状态统一 | 插件页 | 对同一插件检查商店卡片、快捷预览并完成更新 | 只对兼容新版本提示；更新完成后红点与导航数量立即减少或消失 | 商店卡片仅 nekos-moe 有红点；商店快捷预览 nekos-moe 显示「可更新至 0.1.2」、konachan 无更新提示；更新 nekos-moe 后导航角标立即消失（已安装 tab 不再提示，见下一节） |
| [x] | 不兼容包安装守卫 | 商店 / 文件导入 / 拖入 | 尝试安装 `engines.kabegame: ">= 99.0.0"` 的 `.kgpg` | 返回「此插件要求 Kabegame >= 99.0.0」，插件目录不留下该文件 | 详情页「更新」按钮禁用并提示版本；`install_from_store` 与 `import_plugin_from_zip`（拖入同入口）均被拒，盘上 konachan 仍为 1.7.3 |
| [x] | 后端单测 | `test-kabegame` | 运行 `kabegame-core --lib install_plugin_rejects_incompatible_min_app_version_before_copy` | 新增测试通过，且断言插件目录无目标文件 | 1 passed / 0 failed |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 零错误 | 退出码 0；vue-tsc / cargo 均 0 error |

## 插件页更新提示归位商店源 tab、右键快捷预览与统一角标样式

已安装 tab 的卡片红点和快捷预览里的「可更新至」被去掉：从那里点开的是本地插件详情，不能执行更新。可更新数量改为显示在各商店源 tab 的文字右上角（只计该源的兼容更新）。`v-corner-badge` 下沉到组件库 `@kabegame/element-plus`，外观照搬 `el-badge`；`KbTab` 新增 `badge` 字段，画廊 / 任务详情的失败图片按钮也改用同一指令。插件页卡片的快捷预览由鼠标悬停自动弹出改为右键弹出（点面板外或 Esc 关闭），插件选择器下拉行保持悬停；没有 banner 图时预览不再渲染示例图区域与空态占位。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 已安装 tab 不提示更新 | 桌面 CEF | 准备一个有兼容商店更新的已安装插件，进入「已安装源」tab 并右键它 | 卡片无红点，预览无「可更新至」 | 虚拟源 nekos-moe 0.1.1 → 0.1.2：已安装 tab 红点 0 个，预览无更新行；商店 tab 该卡片仍有红点、预览显示「可更新至 0.1.2」 |
| [x] | 商店源 tab 角标 | 桌面 CEF | 同上，观察 tab 栏 | 有可更新的源 tab 文字右上角显示数量，不兼容条目不计入；不压住计数与叉号，选中态可读 | regtest tab 显示 1（konachan 99.0.0 不计），官方源无更新不显示；补右内边距后角标落在计数「2」之后、叉号之前；删除虚拟源后导航角标归 0 |
| [x] | 角标样式统一 | 桌面 CEF | 对比画廊顶栏失败图片按钮、侧栏「插件」图标、商店 tab | 三处同为 el-badge 外观（18px 高、12px 字、白描边） | 失败图片按钮实测 2 条，`data-kb-badge="2"`；首版因 KbTab 的 `:class` patch 冲掉宿主类导致 tab 角标错位，已改为每次 `updated` 补回宿主类后复测通过 |
| [x] | 右键快捷预览 | 桌面 CEF | 在插件卡片上悬停、右键、移出、右键另一张卡、点空白、按 Esc | 悬停不弹；右键弹出并阻止系统菜单；移出不关；右键另一张切换；点外部或 Esc 关闭 | 悬停 700ms 无面板；右键 `defaultPrevented=true`；移出 400ms 后仍在；切换到 Pixiv 后只剩 1 个面板；外部点击、Esc 后面板数均为 0 |
| [x] | 无 banner 不渲染示例区 | 桌面 CEF | 右键没有 banner 图的插件与有 banner 图的插件 | 前者面板无走马灯区域，后者正常显示 | nekos-moe 面板无 `.qp-carousel`，Pixiv 有；截图核对面板只剩头部、描述与页脚 |
| [ ] | 插件选择器悬停预览 | 桌面 CEF | 收集弹窗的插件下拉中悬停一行 | 仍按悬停 400ms 弹出，行为不变 | 未测（默认 `trigger="hover"`，代码路径未改） |
| [ ] | 紧凑端长按 | Android / 窄 Web | 长按插件卡片 | 仍弹底部抽屉，右键模式不影响长按 | 未测 |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame --skip cargo` | vue-tsc 零错误 | 退出码 0；vue-tsc 0 error |

## 桌面端视频预览键盘快捷键

视频预览复用已有的 `<video>` 元素执行播放、暂停与 seek：空格键切换播放状态，`Command/Ctrl + ←/→` 将进度限制在媒体起止范围内并移动 5 秒。快捷键只在视频预览中拦截，普通图片的左右切图行为不变；输入框与可编辑区域仍不接管全局快捷键。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 播放 / 暂停 | 桌面 CEF | 打开一个视频预览，连续按两次空格 | 第一次暂停，第二次从原进度继续播放；长按不会因按键重复事件连续反转 | macOS CEF dev 实测：暂停后 1s 进度保持 0.141s，续播 1s 后到 1.411s；`repeat` 事件未反转状态 |
| [x] | 快退 / 快进 | macOS / Windows / Linux | 在播放中分别按 `Command/Ctrl + ←` 和 `Command/Ctrl + →` | 当前进度分别减少 / 增加 5 秒，控制条时间同步更新，不切换前后媒体 | macOS CEF dev 实测 `Command + ←` 6s → 1s、`Ctrl + →` 1s → 6s，标题未变 |
| [x] | 起止边界 | 桌面 CEF | 在开头 5 秒内快退，在末尾 5 秒内快进 | 进度分别停在 0 和视频时长，不报错 | macOS CEF dev 实测 2s 快退到 0，9s 快进到 10.041667s 总时长 |
| [x] | 原有快捷键 | 桌面 CEF | 预览普通图片时按 `←/→`；在详情输入控件中输入空格 | 图片仍正常切换；输入时不触发视频播放或 seek | macOS CEF dev 实测普通图片 `→` 切到下一张；输入元素上的空格事件未被拦截、视频继续播放 |

## 文件夹画册切换同步模式后子画册状态实时刷新

把文件夹画册切到递归同步（或从递归切走）时，后端会在同一事务里把子树规整为「同步委托」/「不同步」，并逐个发 `album-changed { syncMode }`；但前端 `dataChangeHub` 只放行 `name` / `parentId` / `labelKey` / `albumType` 四个结构字段，`syncMode` 事件被整条丢弃，画册树里已展开的子画册图标停在旧状态（被操作的画册本身只是碰巧经同步的成员变更事件刷新）。现在 `syncMode` 作为行展示字段放行，只写入 `albumIds` 与 `albumPaths`，不进 `albumStructure`，避免画廊网格与过滤树跟着重查；后端 `normalize_local_folder_sync_modes` 同时返回各画册的 `ancestor_path`，`syncMode` 事件统一经 `emit_sync_mode_changes` 携带 `ancestorPath`，树只重拉变更画册所在目录，不再走通配整树刷新。`folderStatus` 事件同样未被放行，但它每次同步都会发且无路径，本次不纳入。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 递归 → 浅同步 | macOS 桌面 CEF / CDP | 展开 `comfy_output`（递归，5 个子画册委托），切为浅同步 | 根画册立即显示浅同步图标，5 个已展开子行同步图标消失（不同步） | 已实测；页面监听到 6 条 `album-changed`，均带 `ancestorPath` |
| [x] | 浅同步 → 递归 | macOS 桌面 CEF / CDP | 同上切回递归同步 | 根画册显示递归图标，5 个已展开子行无需刷新即显示委托（链接）图标 | 已实测并截图核对；dev 数据已恢复为原递归状态 |
| [ ] | 选中子画册时详情面板 | 桌面 CEF | 选中某个子画册，再在父画册上切换递归 / 浅同步 | 右栏同步状态随之在「同步委托」与「不同步」间切换，右键菜单禁用态同步更新 | `useAlbumQuery` 经 `albumIds` 命中 |
| [ ] | 不误刷画廊 | 桌面 CEF | 停留在画廊页，从另一入口切换文件夹画册同步模式 | 画廊网格与过滤侧栏不因 `syncMode` 事件重查 | `syncMode` 不进入 `albumStructure` |
| [ ] | 转为普通画册 / 重新串联 | 桌面 CEF | 对递归画册的祖先关系做调整（新建父级文件夹画册触发 rechain），或转换含委托子树的画册 | 规整产生的 `syncMode` 变更同样带路径并刷新所在目录 | 三处调用方共用 `emit_sync_mode_changes` |
| [x] | 后端单测 | cargo test | `kabegame-core --lib sync_mode` | 3 项通过；规整结果断言包含 `ancestor_path` | 已运行 |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 无错误 | 已运行 |

## 任务指南补齐收尾状态与逐任务并发

通过 `kabegame-chromium` 在桌面 dev 中实际启动 `Kabegame 服务器` 任务，核对创建弹窗、运行中任务卡片、下载队列、任务详情页和停止确认流程后更新任务指南。文档将并发关系从旧的两个全局设置改为「同时运行任务数 + 全局下载上限 + 本任务下载上限」，补充创建时关闭跟随全局、运行中即时调节及不突破全局上限的规则；任务状态新增「等待剩余下载」，明确它表示插件脚本已经结束、任务仍在等待排队或处理中的下载落盘。五张 2400×1536 dev 实机截图使用 `annotate-ui-screenshots` 标出创建步骤、任务级并发、任务状态、单张下载阶段、详情统计与停止确认，正文同步删去重复说明。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Kabegame Server 实跑 | macOS 桌面 CEF / CDP | 在画廊选择 `Kabegame 服务器` 并启动真实任务 | 任务进入抽屉，下载结果持续入库并最终结束 | 已实测；额外截图任务已停止 |
| [x] | 逐任务下载并发 | 创建弹窗 / 任务抽屉 | 关闭「跟随全局」设为 1，运行中用 `− / +` 调整 | 卡片显示当前占用 / 本任务上限；本任务上限即时生效且不突破全局上限 | 已实测 `1/1`、自定义上限与恢复跟随全局 |
| [x] | 等待剩余下载 | Kabegame Server 任务 | 插件脚本结束后观察任务卡片 | 状态徽章显示「等待剩余下载」，队列排空后自动变为「完成」 | dev 中两次观察到 `99.90%` 收尾状态 |
| [x] | 详情与停止确认 | 任务详情页 | 从运行中任务进入详情页并点击「停止任务」 | 统计实时刷新；停止前出现确认弹窗，确认后任务变为「已取消」且已下载图片保留 | 已实测并停止截图任务 |
| [x] | 标注截图资源 | 文档资源 | 检查创建弹窗、任务抽屉、任务详情与停止确认的原图和 `-annotated` 输出 | 5 张标注图保持 2400×1536，箭头指向真实控件；输出路径留空，不暴露个人目录 | 已静态核对与逐张目视检查 |
| [x] | 关联文案 | 任务 / 设置 / 插件使用指南 | 搜索五种状态、全局并发与清理条件的旧描述 | 状态列表包含收尾阶段，设置页明确全局上限，清理与停止覆盖等待剩余下载 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片引用、资源尺寸与 Git diff | 图片路径存在，原图保留，无空白错误 | 已静态核对 |
| [x] | 文档站构建 | Astro / Starlight | 运行 `deno task docs:build` | `/guide/tasks/` 正常生成，5 张标注图均完成优化 | 构建通过；现有重复文档 ID 与 `ejs` 高亮警告不由本次变更引入 |

## 项目内界面截图标注 skill

新增 `.claude/skills/annotate-ui-screenshots`，把本轮畅游文档采用的真实 UI 保留、紫色短标签、粉色箭头、`-annotated` 文件名、目视复核和正文去重流程固化为项目技能。技能附带基于 ImageMagick 的确定性脚本，以 JSON 指定标签框、文本基线和箭头目标，不把 Wallhaven 等单次截图内容写死；`AGENTS.md` 与 `.cursor/rules/screenshot-annotation.mdc` 同步登记使用约定。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 技能位置与发现 | `.claude/skills/annotate-ui-screenshots` / `AGENTS.md` / Cursor 规则 | 检查 `SKILL.md`、界面元数据和项目索引 | 技能随仓库版本管理，Codex 与 Cursor 都能定位真实 UI 截图标注约定 | 已静态核对 |
| [x] | 确定性标注脚本 | macOS / ImageMagick | 用现有 2400×1536 畅游截图和临时 JSON spec 运行 `scripts/annotate.py` | 自动探测中文字体，生成紫色标签与粉色箭头，输出尺寸与输入一致 | 已实测并目视检查 |
| [x] | 安全边界 | 技能说明 | 检查输出命名、覆盖保护和生成式编辑约束 | 默认输出 `-annotated` 文件，不覆盖原图，不重绘真实 UI | 已静态核对 |
| [x] | 脚本语法 | Python 3 | 运行 `py_compile` | 无语法错误 | 已实测 |

## 畅游文档按 dev 实机流程重写

通过 `kabegame-chromium` 连接正在运行的桌面 dev，在畅游中真实打开 Wallhaven 搜索页与图片详情页，执行一键下载并从记录卡片进入站点下载图片页。文档从旧的“逐张右键下载”说明更新为当前的一键下载主流程，补齐导航栏、取消、当前页扫描、列表页缩略图与详情页原图差异、冻结网页性能影响、Cookie 复用、显式关闭会话和新版查询工具栏。旧总览截图已替换，并新增 Wallhaven 详情窗口与 50 张实际下载结果截图；三张图片加入短标签和箭头，正文同步删去重复的按钮说明。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | macOS 桌面 CEF / CDP | 用 `kabegame-chromium` 打开畅游主页、Wallhaven 窗口和畅游图片页 | 说明与截图来自当前运行界面 | 已实测 |
| [x] | Wallhaven 一键下载 | 畅游详情页 | 从 nature 搜索进入单张详情页，点击导航栏下载箭头并检查记录 | 下载结果关联到 `wallhaven.cc` 畅游记录，同时进入总画廊 | 记录最终显示 50 张；用户手动确认下载成功 |
| [x] | 冻结网页边界 | 下载设置 / 畅游 | 对比开启与临时关闭「冻结网页」后的运行状态，再恢复原设置 | 文档说明保存页面快照会增加复杂页面开始下载前的处理时间 | 原设置已恢复为开启 |
| [x] | 查看下载图片 | 畅游记录 | 点击 Wallhaven 记录卡片进入站点图片页 | 显示该记录的实际下载结果和当前查询工具栏 | 已实测并截图 |
| [x] | 截图资源 | 文档资源 | 检查记录列表、Wallhaven 窗口和下载结果三张截图 | 均为 2400×1536 PNG，使用 `-annotated` 后缀标识已标注版本，短标签与箭头指向准确，内容清晰且无 Cookie | 已静态核对与目视检查 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片、站内锚点、旧交互描述和 Git diff | 资源路径存在，不再宣称没有关闭会话按钮或仅能右键下载 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/surf/` 检查表格、提示块与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 顶层命令指南归档

开发、构建、检查、测试及辅助命令的参数与注意事项已统一迁移到 `scripts/AGENTS.md`；根
`AGENTS.md` 只列出可用命令、单行用途摘要并提供详情入口。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根命令索引 | 仓库 | 检查根 `AGENTS.md` 的命令章节 | 只包含命令名、单行用途摘要和 `scripts/AGENTS.md` 链接，不再展开参数或平台说明 | 已静态核对 |
| [x] | 指南完整性 | 仓库 | 对照迁移前后的开发、构建、检查、测试、数据目录和验证章节 | 原有详细说明完整保留在目录级文件 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff 与相对链接 | 无空白错误，根入口可解析到命令指南 | 已静态核对 |

## packages 目录级规则归档

组件库、独立 git submodule、格式化排除项与 PathQL 生成型包的维护说明已统一迁移到
`packages/AGENTS.md`，根 `AGENTS.md` 只保留目录索引、规则入口和命令摘要。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 规则归属 | 仓库 | 对照根与 `packages/AGENTS.md` 的组件库和子仓库说明 | 详细规则只在目录级文件维护，根文件保留有效入口 | 已静态核对 |
| [x] | 包类型清单 | `.gitmodules` / `packages/*/package.json` | 核对 vendored fork、git submodule、普通包与生成型包 | 目录性质和修改边界与仓库现状一致 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff 与相对链接 | 无空白错误，目录级文档链接均可解析 | 已静态核对 |

## 第三方补丁工作流规则归档

第三方补丁序列说明与原 Cursor 路径规则已统一迁移到 `third-patches/AGENTS.md`，根 `AGENTS.md` 只保留入口引用，相关文档链接同步更新；CEF 明确由 `third-patches/cef/*.patch` 与 patch-manager 管理，构建期的 `kabegame-build` 提交只负责桥接 automate-git。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 规则单一来源 | 仓库 | 搜索旧 Cursor 规则与第三方补丁规则引用 | 不再引用已删除的路径规则，目录级 `AGENTS.md` 包含完整工作流 | 已静态核对 |
| [x] | CEF 补丁归属 | 仓库 | 对照 `third-patches/cef/`、patch-manager 与 Chromium 构建脚本 | 文档明确补丁序列是唯一来源，临时提交仅供构建消费 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff | 根规则仅保留入口，目录内链接均可解析 | 已静态核对 |

## 移除已下线的 Wallpaper Engine 导出文档

Wallpaper Engine 导出功能已经下线，壁纸、设置、Android 和画册盘指南同步删除导出教程、目录设置、平台能力矩阵及相关集成暗示，避免文档继续引导用户寻找不存在的入口。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 失效功能文案清理 | 中文文档 | 搜索 Wallpaper Engine 导出、设置项和平台矩阵 | 用户指南不再宣称支持导出或展示相关设置入口 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff | 无空白错误，删除后章节与表格连续 | 已静态核对 |

## 画册文档按 dev 实机界面重写

通过 `kabegame-chromium` 连接正在运行的桌面 dev，逐项核对画册树、新建窗口、标签菜单、本地文件夹同步、加入画册选择器、排序和图片菜单后重写旧文档。新文档以普通画册、标签自动归类和本地文件夹持续同步三种整理方式为主线，补齐当前三栏布局、四类画册、查询工具栏、拖入规则、独立的「从画册移除」与「删除文件」语义；壁纸轮播和画册盘收进桌面附加功能。总览及八个关键交互截图均重新取自本次 dev 实机，并用 `annotate-ui-screenshots` 添加短标签和箭头；正文同步删除与标注重复的入口、字段和菜单复述，保留行为边界、安全提示与平台差异。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | 桌面 CEF / CDP | 用 `kabegame-chromium` 连接运行中的画册页并逐项打开交互 | 截图和说明来自当前实现，不沿用旧界面推断 | 已实测 |
| [x] | 画册类型与树操作 | 桌面 CEF | 检查普通画册、标签、标签目录、本地文件夹及其右键菜单 | 新建字段、层级限制、移动和删除语义与界面一致 | 已实测 |
| [x] | 浏览与图片操作 | 桌面 CEF | 检查查询工具栏、排序、信息栏、加入画册选择器与图片菜单 | 当前入口、筛选能力及「移除 / 删除文件」边界与界面一致 | 已实测 |
| [x] | 标注截图资源 | 文档资源 | 检查总览及八张交互截图的 `-annotated` 版本 | 9 张均保持 2400×1536；每张 2–3 个标注，箭头落在真实控件，原图保留 | 已静态核对与逐张目视检查 |
| [x] | 正文去重 | 画册指南 | 对照标注图检查入口、字段、菜单说明 | 图中可直接理解的操作不再由大段正文重复，限制、删除后果和平台差异仍完整保留 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片与站内锚点、旧术语和 Git diff | 标注图片路径全部存在，不再引用四选一过滤、双击标题改名及删除复选框等旧交互 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/albums/` 检查长表格、提示块与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 插件变量空值、必填与链式显隐语义

插件变量改为显式 `required`，可见空值统一传 `null`，boolean 始终传 bool，被 `when` 隐藏的字段不再出现在任务配置中。主应用和 CLI 只负责把各自输入转换成规范值；后端统一执行「本次提交 > 用户默认 > 插件 default > 隐式空值」合并、链式 `when` 过滤和严格校验。v041 会一次性规范化历史 RunConfig、任务快照和插件默认配置。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 可选字段留空 | 主应用 / CLI / 自动任务 | 留空 string、date、number、list 与 checkbox 后启动 | 可见 key 存在且值为 `null`；插件不会收到 `"null"`、空数组或全 false 对象 | 主应用 UI 与 CLI 已用探针插件实测：插件收到 null、boolean 为 false；自动任务未测 |
| [x] | 清空带 default 的字段 | 主应用 / 再次执行 | 清空已有 default 的可选字段并提交，再次执行该任务 | 本次值保持 `null`，不回落到插件 default；再次执行能还原清空状态 | dev app 实测：清空 T2 后任务与插件日志均为 null，「再次执行」回填为空 |
| [x] | 隐藏字段缺键 | 主应用 / CLI dry-run | 切换模式使字段被 `when` 隐藏 | 最终配置中没有该 key，脚本读取为 `undefined` | CLI dry-run（danbooru）与主应用提交均不含被隐藏的 key，插件读取为 undefined |
| [ ] | 链式 when | 主应用 / CLI / 自动任务 | A 依赖 B，B 因 C 隐藏 | B 与 A 逐级隐藏且都不提交；切回 C 后恢复原值与可见性 | CLI 实测 only_b 改值后 chain 一并消失；主应用切回后恢复原值未测，自动任务未测 |
| [ ] | required 拦截 | 主应用 / CLI / 自动任务 | 清空当前可见的 `required: true` 字段 | 创建或调度任务前报配置错误，不产生可运行任务 | 主应用提示「请填写所有必填项」、CLI dry-run 与真实提交均报错且任务数不变；自动任务未测 |
| [x] | options 空字符串值 | 主应用 / CLI | 选择声明了 `variable: ""` 的 option | `""` 原样提交并通过校验，不转换为 `null` | CLI 与主应用均实测：KbSelect 不再过滤 variable ""，分段器（nullprobe「Any」）与下拉（danbooru「不限」）都能显示并选中 ""，提交为 ""；清除回到占位并提交 null。分段器「未选」与 AndroidPickerSelect「清除」改用私有哨兵，不再与 "" 混淆；Android 紧凑布局未实机验证 |
| [ ] | v041 旧数据迁移 | 旧 dev 数据目录 | 启动新版后检查 `run_configs.user_config`、`tasks.user_config`、`default-configs/*.json`，并触发一个旧自动任务 | 旧空串 / 空列表 / 全 false checkbox 按字段类型规范化，数字字符串转数字，旧自动任务可运行 | 文件迁移失败只记日志，不阻断数据库迁移；dev 库升到 v41，已安装插件的 tasks 与 default-configs 中旧空值已规范化，只剩 options 里合法的 ""；*-test 临时 id 取不到定义，"" 按设计保留；dev 无 RunConfig，自动任务未测 |
| [x] | when 环拒绝 | 插件安装 / 商店安装 | 安装字段级或选项级 `when` 形成依赖环的 KGPG | 复制到插件目录前报出成环 key 路径，不留下坏文件 | CLI import 与临时运行均报「when 依赖成环: a -> b -> a」，插件目录无残留；商店安装复用同一入口，未单独实测 |
| [x] | CLI 显式清空 | `kabegame-cli plugin run --dry-run` | 传 `--var tag=` | 输出中 `tag` 为 `null`，不回落默认值 | danbooru `mode_tag_value=` / `quality=` / `start_page=` 均为 null |
| [x] | CLI checkbox | `kabegame-cli plugin run --dry-run` | 传 `--var kinds=a,b`，再传未知 variable | 合法输入展开为包含所有 variable 的 bool 对象；未知值立即报错 | `checks=q` 展开为 {p:false,q:true}；`checks=p,zzz` 报未知选项 |
| [x] | CLI options 严格匹配 | `kabegame-cli plugin run --dry-run` | 传合法 variable / 显示名 / 非法字符串 | 前两者转换成功，非法值立即报错；仅声明空 variable 时 `key=` 可选中它 | 显示名 X → "x"，`opt_empty=` 选中声明的 ""，非法值与 `crawl_mode=bogus` 报错 |
| [x] | 迁移插件空值实跑 | danbooru / pixiv / 任一 WebView 插件 | 可选字段全部留空，各跑一次最小任务 | 日志与请求中没有字面量 `"null"`，插件不因 null / undefined 崩溃 | 32 个插件全部迁移：无 `""` 选项的 options 一律 required，模式相关输入按 when 设为 required；修了 Number(null)=0 类问题（xhs max_items、pixai/kabegame-server/kemono 页码与数量、pixiv num_artworks、booru 系 end_page 兜底）与 URL 拼出 null 的问题（wallpapers-craft、wallspic）。全量打包 32/32，默认配置 dry-run 全部通过（3 个默认模式需填输入的插件补必填后通过，WebView 经 app）；V8 插件逐个真跑，日志与 URL 无字面量 null。weibo、xhs 推荐流需登录，anime-pictures 403、twodwallpapers 站点下线，失败与本次改动无关 |
| [x] | 默认配置不写 null boolean | dev app 导入插件 / CLI | 导入含无 default boolean 的插件后用 CLI dry-run | 生成的默认配置只写有 default 的键；v041 删除旧文件里值为 null 的 boolean 键，CLI 不再报「boolean 不能为 null」 | 实测发现后修复；单测覆盖迁移，生成器修复需重启 app 生效 |
| [x] | 插件字段随时可清空 | 收集弹窗 / 自动任务 / 插件详情 | 对有 default 与 `required: true` 的 string、date、options、path 字段点击清除 | 所有字段都显示清除按钮，清空后提交为 `null`；必填项为空时仍在启动任务时被拦截 | `PluginVar` 不再接收 `allowUnset`，统一允许清空 |
| [x] | 默认配置忽略必填 | 设置 → 插件 → 默认配置 | 选择含 `required: true` 字段的插件，留空必填项后保存 | 不显示必填星号，保存不被校验拦截，必填项以 `null` 写入 `default-configs/<id>.json` | dev app 用 nullprobe 实测：`must` 无星号、保存成功并写入 null；`PluginVarsForm` 以 `ignore-required` 取代 `allow-unset-all` |
| [x] | checkbox 数组 default | CLI `--via local` | wallhaven / haowallpaper / ziworld 默认配置 dry-run | 清单里 `default: ["a","b"]` 在定义解析期规范成完整 {variable: bool} 对象，不再被判「必须是对象」；运行期合并仍不做值转换 | 迁移中发现的宿主回归，已修并补单测；运行中的 dev app 需重启生效 |
| [x] | 推荐配置导入规范化 | 主应用 | 导入含 `""` / `[]` / checkbox 数组的推荐配置 | 只规范出现的键：空值转 null、checkbox 数组展开、声明的 `""` 选项保留，不补默认值；定时运行不再因旧式空值被拒 | vitest 覆盖；pixiv、wallhaven 推荐配置源文件同步清理 |

## 画廊文档按 dev 实机界面更新

通过 `kabegame-chromium` 连接正在运行的桌面 dev，逐项操作画廊后重写旧文档。查询部分从已移除的「过滤折叠按钮 + 七个维度」更新为当前的单行查询工具栏，补齐多范围搜索、五类快捷过滤、高级条件和常用项自定义；同步修正当前 / 全部计数、网页收集、随机排序、桌面每页数量设置入口、复制标签、三栏预览和工具箱动作语义。画廊总览、各查询弹层、右键菜单、预览、导入、整理、失败列表与空状态等截图均重新取自本次 dev 实机，并逐张目视检查。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | 桌面 CEF / CDP | 用 `kabegame-chromium` 连接运行中的画廊并逐项打开交互 | 截图和说明来自当前实现，不沿用旧界面推断 | 已实测 |
| [x] | 查询工具栏 | 桌面 CEF | 检查搜索范围、时间 / 插件 / 类型 / 比例 / 大小、高级查询与常用项设置 | 文档中的入口、组合关系、清除行为和字段名称与界面一致 | 已实测 |
| [x] | 画廊操作 | 桌面 CEF | 检查收集菜单、排序、单选 / 多选菜单、预览、工具箱与维护对话框 | 文档移除失效入口，并补齐网页收集、复制标签、插件详情等现有能力 | 已实测 |
| [x] | 截图资源 | 文档资源 | 检查 19 张替换截图与 2 张新增截图 | 均为 2400×1536 PNG；内容清晰，查询截图使用安全的风景结果 | 已静态核对与目视检查 |
| [x] | Markdown 静态检查 | 仓库 | 检查文档引用、旧术语和 Git diff | 图片路径全部存在，不再引用过滤折叠、名称维度、壁纸维度和桌面每页数量旧截图 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/gallery/` 检查长表格与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 快速上手带用户完成首次网络收集

快速上手不再假设 Kabegame 完全不带插件，也不再把设置壁纸作为首次体验的终点。新流程先在「开始收集 → 网络」中查找通常已内置的
「Kabegame 服务器」；只有找不到时才进入 GitHub 官方插件目录安装，并用实际商店截图标出对应插件。选择插件后不要求用户理解或修改
参数，直接使用在线 Demo、全站随机、跳过隐藏内容、每页 20 项、只跑第一页的默认值创建真实任务。默认参数表单、任务抽屉与任务结果
均使用实际截图，继续说明任务状态、画廊结果、标签与来源详情，形成可验证的首次网络收集闭环；完成提示改用轻快的祝贺语气，
鼓励用户继续探索标签和插件详情。桌面端还补充来源选择框旁的畅游快捷按钮：可以先打开插件网站测试基本连通性，也可以为需要账号的
来源完成登录，再由支持该能力的插件自动复用畅游保存的 Cookie。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 默认参数来源 | `kabegame-server/package.json` | 核对插件配置默认值 | 全站、在线 Demo、随机、排除隐藏项、每页 20、起止页均为 1，与教程一致 | 已静态核对 |
| [x] | 操作截图 | 文档资源 | 检查商店、默认参数、畅游快捷按钮、任务进度和任务结果五张 Desktop 截图 | 五个关键阶段清晰可辨，资源路径全部存在 | 已静态核对 |
| [x] | 畅游快捷入口 | 桌面端收集表单 | 对照按钮实现与畅游 Cookie 文档检查说明 | 明确按钮只打开插件网站，不会启动任务；连通性检查、账号登录和 Cookie 复用边界表述准确 | 已静态核对 |
| [x] | 首次收集路径 | 快速上手 | 顺序检查插件确认、默认参数、任务进度和结果验收 | 用户选择插件后无需改参数即可完成第一批图片的网络收集 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/quickstart/` 并检查提示块与五张截图 | 图片不溢出，提示块在窄屏可读 | 待运行文档站后验证 |

## 中文 README 产品入口重构

中文 `README.md` 从作者叙事型首页改为面向用户与插件贡献者的产品入口：定位调整为插件驱动的图片与视频收集、归档工具，
前置下载、在线体验、快速上手、插件目录与插件开发五个行动入口；截图收敛为直接证明差异化能力的六张功能界面。
首要亮点明确展示标签自动归类、本地文件夹持续同步、畅游 Cookie 自动保存与安全复用、真实 WebView 驱动收集、
JavaScript / TypeScript 脚本扩展与来源元数据保留；脚本扩展说明同时覆盖配置表单、标签分类、元数据、详情视图和 `.kgpg` 分享能力。
壁纸设置降为桌面端附加能力。功能说明按用户任务重组，并新增四步快速开始、插件生态、参与项目和合规提醒；
安装步骤、平台限制、技术亮点、许可证与名称由来继续保留。
功能截图覆盖标签归类、文件夹同步、Cookie 复用和来源元数据各一张，WebView 收集用图片结果与任务日志两张并排展示；
图片实际编码为 JPEG，因此资源统一使用 `.jpg` 扩展名。旧的画廊、预览、画册和插件列表截图组已移除，避免重复展示通用界面。
日文、韩文和英文 README 随后按同一结构同步翻译：三份译文与中文版逐行同构，标题行号、HTML 骨架、代码块与全部链接一致，
各语言标题按母语改写（`核心亮点` / `Highlights` / `主なハイライト` / `핵심 하이라이트` 等）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 首屏转化路径 | GitHub Markdown | 从标题向下检查定位、行动链接与首组截图 | 无需越过长篇背景即可理解产品，并可直接下载、体验、上手或进入插件开发 | 已静态核对 |
| [x] | 本地资源链接 | 仓库 | 检查 README 中 6 张截图、3 个源码入口与 LICENSE | 所有相对路径均存在 | 已静态核对 |
| [x] | 亮点截图 | README 源码 | 检查核心亮点后的图片与说明 | 标签归类、文件夹同步、Cookie 复用、来源元数据各有一张实图；WebView 的收集结果与任务日志两张并排展示 | 已静态核对 |
| [x] | 脚本扩展入口 | README 源码 | 检查核心亮点与插件生态的衔接 | 首屏说明可用 JavaScript / TypeScript 添加来源，无需修改或重新编译主程序，并可将完整插件打包分享 | 已静态核对 |
| [x] | 内容范围 | Git diff | 核对本轮文件列表 | 中文 README、功能截图与强制回归记录发生变化；三份译文随后按同一结构同步 | 已核对 |
| [x] | 译文结构同构 | 仓库文档 | 比对四份 README 的行数与 `##` 标题行号 | 均为 181 行，10 个二级标题逐一对齐（35 / 80 / 90 / 99 / 111 / 123 / 154 / 165 / 175 / 179） | 已静态核对 |
| [x] | 译文链接与代码块 | 仓库文档 | 比对全部 `src` / `href`、Markdown 链接目标与三段 `bash` 代码块 | 与中文源文件完全一致；Markdown 链接目标仅语言切换行不同（新版 README 已无内部锚点链接） | 已静态核对 |
| [x] | 译文内容完整 | 仓库文档 | 逐节核对核心亮点、从收集到归档、快速开始、核心能力表、插件生态、下载与平台、参与项目、技术亮点、License 与名称由来 | 各节均完整翻译，无漏段；除语言切换器与名称由来的「壁亀 / 壁紙」外无残留 CJK | 已静态核对 |
| [ ] | GitHub 实际渲染 | GitHub 仓库首页 | 推送后分别用桌面与窄屏打开仓库首页 | 表格、徽章、截图和行动入口无溢出或错位 | 待推送后验证 |

## 画廊工具栏计数成对刷新

`GalleryToolbar` 现在接收当前 `filter`，在首次进入、过滤变化和 `images-change` 后并行读取过滤后数量与无过滤总数；
两条查询全部完成后才整体提交“数量 / 总数”显示快照。`ImageGrid.totalCount` 只作为首次加载或查询失败时的降级值，
分页器原有的独立 live count 不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 成对提交自动化 | 前端 Vitest | 让过滤 count 与总 count 以相反顺序先后返回 | 任一单条请求完成时仍显示上一份完整快照；两条都完成后一次切到新值 | 全量 30 个文件、255 个用例通过 |
| [x] | 前端类型检查 | 本机 | `.claude/skills/check-kabegame/driver.sh --skip cargo` | `vue-tsc` 0 error | 已实测 |
| [ ] | 下载时计数同步 | 桌面 CEF / Android / Web | 应用一个能排除部分图片的过滤，持续下载新图并观察画廊副标题 | “数量 / 总数”每次作为一对同时变化，不短暂出现新旧值混搭 | |
| [ ] | 隐藏上下文与过滤切换 | 桌面 CEF / Android / Web | 切换“隐藏已隐藏图片”、`no-album` 与普通 / 高级过滤 | 分子符合当前完整过滤；分母只保留 `hide` 上下文；过滤切换期间不显示上一过滤的分母组合 | |

## README 自包含安装步骤（已被重写取代）

本轮曾把中文 README 的“下载与安装”细化为逐平台包名与安装步骤，并把画廊真实组合过滤的 PathQL 示例写进“你可能感兴趣”，
三份译文也按该 196 行结构同步过一轮。随后中文 README 被整体重写为产品入口（见「中文 README 产品入口重构」），
安装章节改为“下载与平台”、PathQL 示例收进“技术亮点”一行，上述结构与译文同步均已作废，以重写后的 181 行版本为准。

## 新增 Safebooru 收集源插件

新增插件 `safebooru`（1.0.0，`src-crawler-plugins/plugins/kabegame-plugin-safebooru/`）。帖子列表走站点匿名可用的 dapi JSON：
请求带 `fields=tag_info`，一页一个请求就拿到带分类的全量标签。同参数再取一次 XML，按 id 合并发布时间
（JSON 没有这个字段；XML 的 rating 是旧单字母，不采用）。有评论的帖子按 10 条一页翻详情页取评论
（dapi 评论接口的时间是假的）。id 范围模式用 `id:>=A id:<=B sort:id:asc`，每页 100 条，按 id 升序抓完闭区间，两端最多相差 5000
（站点不认 `id:A..B`，会当成普通标签）。标签名先解码 HTML 实体；label key 里字符集外的字符
编码成 `(u<码点>)`，保证 `:p` / `;p` 这类标签不会并进同一个画册。
站点（API 和网页都一样）只允许起始偏移 ≤ 200000：默认排序越过这一页时，改用 `id:<` 游标接续上一页末条，
或用 `limit=1` 每跳 200001 条跳转定位；其他排序越界时直接报错，并提示可用的排序。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | API 分页与网页一致 | 探针 | 对比 `limit=42&pid=页号-1` 与网页列表在全部 / 标签 / `sort:` 元标签下的 ID 序列 | 9 组页面逐条相同 | 已实测 |
| [x] | 标签模式 | dev CLI | `run-cli.sh safebooru` 标签 `hakurei_reimu,highres` 第 1 页、中质量 | 42/42 完成；入库 ID 集合与网页第 1 页相同；每张都有 metadata；1930 个标签挂上 1929 个 | 已实测 |
| [x] | 全部 + 高分排序 + 评论 | dev CLI | 全部模式 `sort:score:desc` 第 1、2 页 | 各 42/42；带评论帖的评论条数与 `comment_count` 一致（13 条跨两页取全） | 已实测 |
| [x] | 元标签 + 原图 | dev CLI | 标签 `scenery,width:>=1920,height:<=1200`、高质量 | 42/42；落盘为原始分辨率（如 1920x1080、2688x960） | 已实测 |
| [x] | 翻过 API 上限（接续） | dev CLI | 全部模式、默认排序、第 4762–4763 页 | 84/84；4762 页直接翻，4763 页接在 4762 页末条 `id:<7033073` 之后，入库集合与预期逐条相同 | 已实测 |
| [x] | 翻过 API 上限（跳转） | dev CLI | 全部模式、默认排序、第 20000–20001 页 | 84/84；5 次 `limit=1` 跳转定位，结果与独立实现的 Python 原型相同 | 已实测 |
| [x] | 其他排序越界报错 | dev CLI | 高分 / 随机排序翻第 4763 / 4800 页 | 任务 failed，错误提示上限、当前排序名，并建议改用「最新发布」或收窄标签 | 已实测 |
| [x] | 页码超出结果总数 | dev CLI | 标签 `hakurei_reimu`、默认排序、第 9000 页 | 第一次跳转就判定到底，任务 completed，0 下载 | 已实测 |
| [x] | id 范围与网页一致 | 探针 | 对比 `id:>=1 id:<=5000 sort:id:asc` 的 dapi 第 2 页与网页列表第 2 页 | 42 个 ID 逐条相同；已删除的帖子两边都不出现（1–5000 共 4543 张） | 已实测 |
| [x] | id 范围模式 | dev CLI | id 5000000–5000100、中质量 | 101/101，100 + 1 跨两页；入库 post_id 恰为该区间的 101 个，均有 metadata | 已实测 |
| [x] | id 范围含已删除帖 | dev CLI | id 1–150 | 121/121，与 `limit=0` 的 XML 总数一致，0 WARN | 已实测 |
| [x] | id 跨度超限 | dev CLI | id 1–5002 | 任务 failed，提示「id 范围最多相差 5000」，不发请求 | 已实测 |
| [x] | 详情模板 | render-desc | 用 post 1084336 的真实 metadata 渲染 `description.ejs` | 分组标签、Statistics、Options、评论区与源站详情页一致 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 Safebooru，图标、推荐配置、README 正常 | |

## 新增 nekos.moe 收集源插件

新增插件 `nekos-moe`（0.1.0，`src-crawler-plugins/plugins/kabegame-plugin-nekos-moe/`，V8）。数据走开源后端的
`POST /api/v1/images/search`：排序支持 newest / likes / oldest（`relevance` 不带 tags 时等同自然顺序，不提供），
NSFW 支持仅全年龄 / 仅 NSFW / 全部（全部时不传 `nsfw`），每页 1–50（超过 50 服务端会回落成 20）。
服务端 `skip` 上限 2500，越界的页码在发请求前截断或报 warn；站点现存 792 张（SFW 471 / NSFW 321），不会碰到上限。
搜索接口按 IP 限流，10 秒固定窗口 5 次：两次搜索至少间隔 2.1 秒，遇到 429 按 `retryAfter` 等待后最多重试 3 次。
搜索结果已带齐详情页信息，不请求详情接口；原图 `/image/<id>` 无需 Referer。画师挂 `nekos-moe/artist`，
其余标签挂 `nekos-moe/tag`；纯日文画师名编码成 `u-<码点>` 作 key，纯符号标签（如 `!`）跳过。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全年龄 + 最新 + 小页 | dev CLI | `run-cli.sh nekos-moe` 最新、仅全年龄、每页 5、第 1–3 页 | 15/15；入库 ID 集合与接口 `limit=15` 相同；每张都有 metadata；718 个标签挂上 717 个（跳过 `!`） | 已实测，翻页未触发 429 |
| [x] | 仅 NSFW + 点赞 + 末页 | dev CLI | 最多点赞、仅 NSFW、每页 50、第 6–9 页 | 第 6 页 50 张、第 7 页 21 张后提前结束，共 71/71；集合与接口 skip 250/300 相同，全部 `nsfw=true` | 已实测 |
| [x] | skip 上限保护 | dev CLI | 每页 50、第 60–61 页 | 不发请求，WARN 提示最多 51 页，任务 completed | 已实测 |
| [x] | 原图 | dev CLI | 抽查落盘文件 | 与站点 `/image/<id>` 逐字节一致（缩略图为 322×420） | 已实测 |
| [x] | 详情模板 | render-desc | SFW `PnG9CS0Ea` 与 NSFW `TwfJgm7Xk` 渲染 `description.ejs` | Post Info / 点赞收藏 / Tags 与源站一致；NSFW 图标签为红色并带 NSFW 徽标 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 nekos.moe，图标、README、更新日志正常 | |

## 新增 AIBooru 收集源插件

新增插件 `aibooru`（1.0.0，`src-crawler-plugins/plugins/kabegame-plugin-aibooru/`）。AIBooru 是 Danbooru 的分支，专收 AI 生成图。
和 danbooru 插件解析 HTML 不同，这里全程走 JSON API：列表接口用 `only=` 把上传者、审核者、AI 生成参数、作者评论和评论
一次带回，每页一个请求拿齐详情页信息；标签帖数另查 `/tags.json`（`name_array` 按 URL 长度切块，任务内缓存）。
网页先分页再隐藏已删除作品，插件同样在分页后过滤，保证与网页同页一致。标签多一个 `model` 分类（分类号 6），
落到标签画册 `aibooru/model`。站点 R-18 占比高，分级过滤默认只抓全年龄；人气榜接口不收 tags，分级在插件里逐张筛。
日榜在美东零点刚过时为空，自动改抓前一天，时区偏移从站点最新作品的 `created_at` 读取。prompt / 负面词按逗号、
换行拆成短语写入元数据搜索（宿主拒收超过 1024 字符的条目）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | API 分页与网页一致 | 探针 | 过滤已删除后，对比 JSON 与网页在周榜、日榜（指定日期）、标签（含 `rating:g`）、`limit=50` 下各两页的 ID 序列 | 8 组页面逐条相同 | 已实测 |
| [x] | 标签模式 | dev CLI | `1girl,scenery`、全年龄、每页 20、第 1 页 | 20/20 完成；入库 ID 与网页第 1 页逐条相同 | 已实测 |
| [x] | 人气榜 + 分级筛选 | dev CLI | 周榜第 1–2 页、全年龄 | 13/13；入库 ID 与接口同页全年龄作品逐条相同；434 个标签全部挂上，六个分类（含 model）都有 | 已实测 |
| [x] | 日榜零点兜底 | dev CLI | 美东 00:45 跑日榜、全年龄 | 当天为空时改抓 2026-10-14，符合条件 7 张，与网页该日同页全年龄数一致 | 首版按 UTC-5 粗算退到了前两天，已改为读站点时区偏移 |
| [x] | id 范围 | dev CLI | `64385..64400`、全年龄 | 2/2，与 `/counts/posts.json` 一致 | 已实测 |
| [x] | 全部 + 中画质 + 视频 | dev CLI | 全部模式、全年龄、每页 20、中质量 | 20/20；含 mp4 视频帖 | 其中一个 AV1 视频生成预览失败（`[av1] Get current frame error`），宿主按「无预览」入库，属 FFmpeg 解码能力问题，非插件问题 |
| [x] | 标签超限 | dev CLI | 填 5 个普通标签 | 任务 failed，提示最多 4 个（`rating:` / `status:` / `id:` 不计入） | 已实测 |
| [x] | 元数据搜索片段 | dev CLI + 查库 | 查 post 64393 的 `metadata_search_terms` | 153 条、最长 31 字符；含 prompt 短语、采样器、模型名；超长 WARN 消失 | 已实测 |
| [x] | 详情模板 | render-desc | 用 post 64393 的真实 metadata 渲染 `description.ejs`，切换两个页签 | 分组标签及帖数、Information、Original Commentary / AI Metadata（行序同源站）、评论区与用户等级配色与源站一致 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板，点击两个页签 | 面板正常渲染，页签可切换，链接用外部浏览器打开 | |
| [ ] | 画廊插件扩展筛选 | 桌面 CEF | 在画廊插件扩展里按分数 / 收藏 / 分级筛 aibooru 图片 | 分组计数与筛选结果一致 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 AIBooru，图标、推荐配置、README 正常 | |

## Pixiv 插件新增「第三方 API」模式（Lolicon）

`pixiv` 插件升到 1.5.0，源码按模式拆成 `src/modes/`：`ranking` / `bookmark` / `user` / `keyword` 原样搬出，
共用的请求头、登录态与进度放进 `src/common.ts`，单作品的详情、标签、metadata 与全部分页下载放进 `src/illust.ts`。
新增爬取类型 `third_party`：`src/modes/third-party/` 里每个适配器只产出 pixiv 作品 id，约定为
`fetchPage(vars, cursor) → { ids, next }`，`next` 为 `null` 即结束，执行器统一处理翻页、按作品去重与进度，
下载仍走 `downloadIllust`。首个适配器 `lolicon` 不分页，请求一次即结束；参数为 `lolicon_r18`、
`lolicon_tags`、`lolicon_uids`、`lolicon_count`（1～20）、`lolicon_orientation`（不限 / 横图 / 竖图）、
`lolicon_exclude_ai`、`lolicon_date_after` / `lolicon_date_before`（JST 整日，含当天），图片固定为 pixiv 原图。
lolicon 见到任何 `Referer` / `Origin` 都返回 403，所以请求期间由 `togglePixivHeaders(false)` 置空这两个头和
`Cookie`（也避免把 pixiv 登录态发给第三方），结束后恢复并按需重新注入 Cookie。lolicon 的全年龄分类会混入
pixiv 标为 R-18 的作品，全年龄模式在本地按 `R-18` / `R-18G` 标签再排除。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 横图 + 排除 AI | debug CLI | `run-cli.sh pixiv` 设 `source=third_party`、`lolicon_orientation=landscape`、`lolicon_count=3` | 请求带 `aspectRatio=gt1&excludeAI=true`；下载 `i.pximg.net` 原图且为横图；metadata 完整、标签入库 | 3 个结果中 1 个带 R-18 标签被跳过，2 个作品下载成功（4500×4300、3456×2110），各挂 10～11 个标签 |
| [x] | 标签 OR + 日期区间 | debug CLI | `lolicon_tags=原神\|鸣潮`、`lolicon_date_after=2026-10-01`、`lolicon_date_before=2026-10-14` | `dateAfter` / `dateBefore` 为 JST 当日 0 点与次日 0 点前 1ms；多页作品下载全部页 | 已实测：1 个作品 3 页全部落盘 |
| [x] | R18 无登录态 | debug CLI | `lolicon_r18=r18`，畅游无 pixiv Cookie | 任务失败并提示先在畅游登录 pixiv | 已实测 |
| [x] | 旧模式回归 | debug CLI | 排行榜 `daily`、`num_artworks=1` | 与拆分前行为一致 | 已实测：1 个作品 8 页全部下载 |
| [ ] | 表单显隐 | 桌面 CEF | 收集弹窗选 pixiv →「第三方 API」→ Lolicon | 只显示 lolicon 参数；切回其它类型后 lolicon 参数隐藏且不提交；推荐配置「Lolicon 随机横图」能一键回填 | |
| [ ] | R18 登录态不外泄 | 桌面 CEF | 畅游登录 pixiv 后以 `lolicon_r18=all` 运行 | lolicon 请求成功（未被 403），R18 作品详情与原图能正常下载 | |

## 文档站新增「插件开发更新日志」

插件开发一节新增「更新日志」页（`/dev/changelog/`），从文档基线 4.3.0 起按版本列出插件作者可见的接口、
清单字段与行为变化，并给出各能力首次可用版本的速查表，用来确定 `engines.kabegame`。各版本的首次可用版本
均用 `git grep` 在 v4.3.0 / v4.4.0 / v4.5.0 / v4.5.1 tag 上对源码逐项核对过。`kabegame-plugin` skill 第 4 步
改为按这张速查表取最高版本来写 `engines.kabegame`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 侧栏与链接 | 文档站 dev server | 打开「插件开发 → 更新日志」，逐个点击页内锚点链接，以及开发总览、打包与发布、插件清单字段三处新增的入口链接 | 侧栏出现该页；所有链接跳到正确标题，无 404 | |
| [x] | 版本核对 | 仓库源码 | 对照各版本 tag 的 `prelude.js`、`ops.rs`、`bootstrap.js` 与 `plugin/mod.rs` 核对速查表 | 每项首次可用版本与 tag 上首次出现一致 | 已静态核对 |

## 文档站「打包与发布」改为面向仓库外的插件作者

「打包与发布」与「插件开发总览」不再假设作者在 Kabegame 源码仓库里工作：先从 GitHub Releases 最新版下载
`kabegame-cli`，再用 `plugin new` → `npm run build` → `plugin pack` → `plugin run` → `plugin import` 走完整流程；
自建源改为直接给出 `index.json` 字段表（必填 `id` / `name` / `version` / `downloadUrl`）和 sha256 计算方法。
插件 ID 说明改为「`--id` → `package.json` 的 `name` → 文件名」，删除「目录名就是 ID」的旧说法。CLI 参考页的
Release 资产名改为实际的 `kabegame-cli-standard_<版本>_<os>_<arch>`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 仓库外完整流程 | release CLI 4.5.1，scratchpad 目录 | `plugin new` 后把 devDependencies 改成 `github:kabegame/kabegame-types`，构建、`plugin pack`、`plugin run --dry-run` | 构建成功，打包产出 `.kgpg`，试跑识别为 `demo-plugin-test v0.1.0` | 已实测；npm registry 当时网络不通，rspack 借用本地已装版本，类型包确认可从 GitHub 安装 |
| [x] | 文档链接 | 文档站构建产物 | 校验打包与发布、总览、plugin-sdk、CLI、WebView 页的站内锚点 | 全部指向存在的标题 | 已静态核对 |
| [x] | Release 资产名 | GitHub Releases | 对照最新 Release 的 Assets 列表 | 与文档表格的三个文件名一致 | 已核对 v4.5.1 |

## 新增微博收集源插件

新增插件 `weibo`（0.1.0，`src-crawler-plugins/plugins/kabegame-plugin-weibo/`，V8）。全部模式依赖畅游里 `weibo.com` 的登录态
（`requireCookie("weibo.com")`；未登录时时间线 403、m 站 432、搜索跳登录页，所以不走访客 Cookie，也不用 m 站）。
五种模式各自产出微博，统一交给 `processPost`：用户相册走 `ajax/profile/getImageWall`（`since_id` 游标，按 mid 分组后逐条
`statuses/show`），用户微博走 `ajax/statuses/mymblog`（`feature` 0/1/2 = 全部/原创/图片，转发可选收原帖），超话走
`ajax_proxy/chaohua/page`（必须带 `X-Requested-With`，翻页参数在 `moreInfo.params`；超话 id = `100808` + md5(超话名)，
标签频道按标题从 `channelInfo.channels` 查 flowId），关键词搜索只从 `s.weibo.com` HTML 抽 mid 再逐条 `statuses/show`
（最多 50 页），单条模式接受 weibo.com / m.weibo.cn 各种链接与 mblogid / mid。超话 feed 是精简结构（无 `text_raw`
/ `topic_struct`），有图时补拉一次 `statuses/show`。图片取 `pic_infos` 的 `largest`，`wx1`～`wx4` 统一到 `wx1` 让 URL 去重命中；
下载带 `Referer: https://weibo.com/`。评论走 `buildComments`（`max_id` 游标），带楼中楼预览；评论配图在评论 `url_struct`
的「查看图片」卡片里，只认 `pic_num > 0` 的评论。详情模板的头像与评论缩略图经 `__bridge.fetch` 带 Referer 拉取
（sinaimg 对带 `Sec-Fetch` 头的跨站图片请求返回 403）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 单条微博 + GIF | release CLI（经 IPC 交给 prod app） | `mode=single` 填 `https://weibo.com/6593199887/RmLmsDzd7` | 3 张 GIF + 1 张 JPG 原图落盘（750x2213 等），共用 1 条 metadata；挂上作者 / 超话 / 话题 3 类标签 | 已实测 |
| [x] | 单条 LivePhoto | release CLI | `mode=single` 填 `https://m.weibo.cn/status/RmNeGwSt1` | 6 张静图 + 6 段 `(live)` mp4 | 已实测 |
| [x] | 单条转发链接 | release CLI | `mode=single` 填一条转发 | 收原帖的图 | 已实测 |
| [x] | 用户相册 | release CLI | 用户分别填昵称 `原神`、主页链接 | 按图片墙顺序收带图微博，同帖多图一起入库 | 已实测 |
| [x] | 用户微博 + 转发 | release CLI | `timeline_filter=all`、`include_retweets=true` | 转发微博收原帖图片，同一原帖只处理一次 | 已实测 |
| [x] | 超话精华 / 最新 / 标签频道 | release CLI | 超话填 `原神超话`、超话链接；频道精华、最新发帖、标签频道「同人」 | 三种频道都能翻页入库；补拉详情后正文、话题、IP 属地齐全 | 已实测 |
| [x] | 超话频道名错误 | release CLI | 标签频道填「不存在」 | 任务 failed，错误列出该超话全部频道名 | 已实测 |
| [x] | 关键词搜索 | release CLI | `原神同人` + 热门 + 只看原创 + 2026-09-01～09-30；`#原神同人#` | 入库微博的发布时间都在区间内；话题搜索正常 | 已实测 |
| [x] | 用户不存在 | release CLI | 用户填随机昵称 | 任务 failed，提示找不到该用户 | 已实测 |
| [x] | 评论与评论配图 | release CLI | `mode=single` 填 `RkZDM6Dny`、`max_comments=40` | 4 条一级评论 + 4 条楼中楼，与帖子评论数 8 一致；3 楼配图以 `[comment_3]` 原图（1206x1155）下载 | 已实测 |
| [x] | 详情模板 | render-desc | 用 `RkZDM6Dny` 的真实 metadata 渲染 | 作者、时间 / 来源 / 属地、正文话题着色、超话与话题标签、互动数、评论与楼中楼排版正常 | 已截图核对；离线渲染没有 `__bridge`，头像与评论缩略图显示为占位 |
| [ ] | 应用内预览 | 桌面 CEF | 在 app 打开一张微博图片预览的「插件详情」面板 | 头像与评论配图缩略图经 `__bridge` 正常显示，链接用外部浏览器打开 | |
| [ ] | 登录过期 | 桌面 CEF | 在畅游退出微博登录后运行任意模式 | 任务 failed，提示去畅游重新登录 weibo.com | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现微博，图标、README、更新日志正常 | |

## 新增 X（Twitter）媒体收集源插件（画师媒体 / 搜索 / 单条推文 / 书签 / 点赞）

新增插件 `x-webview`（0.1.0，`src-crawler-plugins/plugins/kabegame-plugin-x-webview/`，WebView）。不自己调 GraphQL（请求要带页面 JS 算的
`x-client-transaction-id`，queryId 也会轮换）：`crawl.js` 顶层在 document-start 同步 hook `XMLHttpRequest.prototype.open`，
截获页面滚动时自己发出的时间线响应，思路参考 prinsss/twitter-web-exporter。2026-10 实测旧 `UserMedia` 已退役，主页「媒体」标签
带「图片 / 视频」下拉：`/<user>/media?filter=photo` → `UserPhotoTimeline`（首屏 `profile-photo-grid-0` 模块，后续页
`TimelineAddToModule`），`?filter=video` → `UserVideoTimeline`（普通 `tweet-*` 条目），一页 20 条，返回 0 条推文即到底。
「全部」模式在同一页里用下拉从图片切到视频，不整页导航（导航会让在途的 CEF 原生下载丢失认领）。图片取
`pbs.twimg.com/media/<id>?format=<原扩展名>&name=orig`（无需 Cookie / Referer），视频取码率最高的 mp4。
`UserByScreenName` 的 `legacy` 在 2026-07 起被拿掉，媒体推文数改读 `tweet_counts.media_tweets`。增量水位线按
`<userId>:<photo|video>` 存在 `pluginData`，只有翻到旧水位 / 末尾 / 最旧时间才推进；推文 id 是 snowflake，时间由 id 推算。
同一推文的多张图共用一条 metadata（`createImageMetadata` + `searchTexts`）；画师按 rest_id、话题按 ASCII 小写或
`u-<码点>` 挂成 `x-webview/artist`、`x-webview/hashtag` 标签。展示名按字形截断：按 UTF-16 截断会切出孤立代理项，
带它的 `name` 经 IPC 传给宿主后 `downloadImage` 永不返回，任务挂在 `exit()`。

评论（参照小黑盒插件）：有回复的推文在同一页里用 `history.pushState` + `popstate` 做 SPA 跳转打开详情（文档不重载，
在途下载不受影响），截获 `TweetDetail`，按 `conversationthread-*` 模块取回复（含楼中楼、作者标记、被回复者、父回复 id），
还有 Bottom 游标就滚动加载直到 `max_comments`（默认 50，0 不开详情页）。回复快照写进同一条 metadata 的 `comments`，
回复者名字和正文进 `searchTexts`，模板在推文卡片下渲染回复区；`fetch_comment_images`（默认关）把回复配图共用 metadata_id
下载、不挂标签。X 折叠的「可能是垃圾信息」回复不取。实测直接推 `/<user>/status/<id>` 连续几条后 X 只用缓存渲染焦点推文、
不再发 `TweetDetail`，改推 `/i/web/status/<id>`（X 自己重定向到规范路径）后每次都会请求；没等到再退回规范路径一次。

搜索模式（`mode=search`）：打开 `x.com/search?q=…`，同样截获页面自己的 `SearchTimeline`。「最新」走 `f=live`
（product=Latest，普通 `tweet-*` 条目，一页 20 条，严格按时间倒序，水位线 key 为 `search:<媒体类型>:<搜索词哈希>`）；
「热门」走 `f=media`（product=Media，`search-grid-0` 网格，首屏约 40 条，按热度排、顺序不单调，所以不用水位线，
最旧时间只过滤不提前停）。搜索词没写 `filter:media|images|videos` 时按「媒体类型」补上；推广推文跳过；结果多挂一个
`x-webview/search` 标签（key 为搜索词哈希，名字为原文）。实测搜索页偶尔滚到底也不发下一页请求，空等时改为先上退
4000px 再把最后一个 `cellInnerDiv` 滚进视口，原先只上抖 800px 时会在 40/53 条处以「连续无响应」结束。

单条推文（`mode=tweet`）：配置填一条推文链接或 id，整页打开 `x.com/i/web/status/<id>`，加载即请求 `TweetDetail`，
焦点推文与回复一次取到（`fetchConversation` 改为按 id 调用，`navigate=false` 时从页面首个响应读起）。
书签（`mode=bookmarks`）打开 `/i/bookmarks` 截获 `Bookmarks`（`data.bookmark_timeline_v2`）；点赞（`mode=likes`）只能看自己的，
先进首页取当前账号用户名（侧栏个人资料链接 → `__INITIAL_STATE__` → SPA 跳 `/i/user/<twid 里的 id>` 等 X 换成 `/<用户名>`；
隐藏的爬虫窗口是窄屏布局、没有侧栏链接），再 SPA 跳到 `/<用户名>/likes` 截获 `Likes`。两者按收藏 / 点赞时间排而不是推文 id，
水位线改存上次最前面 5 条的 id（`<mode>:<twid>:<媒体类型>`），遇到其中任一条即停，最旧时间只过滤；会混入纯文字推文，
`collectTimeline` 统一跳过没有所选媒体类型的推文、不计入上限。结果多挂 `x-webview/collection` 标签（「X 书签」/「X 点赞」）。

同时修正文档：WebView 后端自 4.4.0 起就有 `createImageMetadata`，4.5.1 起支持 `searchTexts`（`dev/webview-api.mdx`
原说「没有」、`dev/changelog.mdx` 速查表原说「WebView 只有 downloadImage」）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 时间线截获 | release CLI（经 IPC 交给 prod app） | 探针版打开 `karokaro6665/media`，切换下拉 | 截获到 `UserVideoTimeline` 与 `UserPhotoTimeline`，结构与上文一致 | 已实测 |
| [x] | 原图可直拉 | 探针 | `probe.ts media` 拉 `name=orig` | jpeg，尺寸等于 `original_info`（2176x1216）；`format=png` 对 jpg 原图 404 | 已实测 |
| [x] | 全量翻页 | release CLI | `media_type=all`、不限条数 | 图片 20+20+14 = 54 条、视频 1 条，合计等于 `media_tweets` 55；三页翻完判定到底 | 已实测 |
| [x] | 「全部」切换不丢下载 | release CLI | 上一轮整页导航时失败的 5 张恰在图片时间线末尾，改为下拉切换后重跑 | 5 张全部下载成功，0 失败，视频在同一页面里加载 | 已实测；整页导航时这 5 张以 `webview destroyed` 失败 |
| [x] | 增量 | release CLI | 全量写入水位线后，开增量再跑 | 两条时间线各读首屏即「遇到上次抓过的推文」停止，0 下载 | 已实测 |
| [x] | 推文数上限 | release CLI | `media_type=all`、`max_tweets=3` | 图片时间线处理 3 条后停止，不再切到视频 | 已实测 |
| [ ] | 上限不推进水位线 | release CLI | 新画师开增量、`max_tweets=3` 跑一次，再不限条数跑一次 | 第一次不写水位线；第二次从最新翻到底，不漏第 4 条以后的推文 | |
| [x] | 含 emoji 的展示名 | release CLI | 第 7 条推文正文第 40 个码元落在 emoji 中间 | 按字形截断后正常入库；旧写法该次 `downloadImage` 永不返回 | 已实测 |
| [x] | metadata 与标签 | release CLI | 查库 | 58 张图全有 metadata（55 条推文 55 条）；源数据 2 个话题全部挂上，画师标签 58 张 | 已实测 |
| [x] | 视频 | release CLI | 视频时间线 | 1080x1584 最高码率 mp4 入库 | 已实测 |
| [x] | 详情模板 | render-desc | 用带话题的单图推文与 4 图推文的真实 metadata 渲染 | 头像、名字、正文话题着色、时间 / 浏览数 / 图数、互动数、话题胶囊、画师简介正常 | 已截图核对 |
| [ ] | 未登录 | 桌面 CEF | 在畅游退出 x.com 后运行 | 弹出爬虫窗口并提示登录，登录后自动继续；3 分钟未登录则结束 | |
| [ ] | 敏感内容 | 桌面 CEF | 对开启 / 未开启「显示敏感媒体」的账号各跑一次 R-18 画师 | 开启时敏感推文正常收集，`possiblySensitive` 为 true 且模板显示「敏感内容」 | |
| [ ] | 限流 | 桌面 CEF | 连续翻大量推文直到 429 | 日志提示被限流并停止，不推进水位线 | |
| [ ] | 应用内预览 | 桌面 CEF | 打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 X 画师媒体，图标、README 正常 | |
| [x] | 保存评论 | release CLI | `max_tweets=10`、`max_comments=50` | 10 条推文 8 条有回复，详情全部取到、无「回复没取到」警告；楼中楼父子关系、作者标记正确；约 59 秒跑完 | 已实测，查 metadata `comments` |
| [x] | 详情不再丢请求 | release CLI | 之前推规范路径时取不到回复的几条推文改走 `/i/web/status/<id>` | 每条都等到 `TweetDetail` | 已实测 |
| [x] | 评论模板 | render-desc | 用带 5 条回复（含作者楼中楼）的真实 metadata 渲染 | 回复区头部计数、作者徽章、「回复 @x」、缩进、点赞数正常 | 已截图核对 |
| [ ] | 垃圾回复折叠 | release CLI | 推文回复数 6、已保存 1 的那条 | 折叠在「显示可能是垃圾信息的回复」里的回复不保存，模板显示已保存数 | 已知现象，未单独核对页面 |
| [ ] | 评论区图片 | release CLI | 对评论带图的推文开 `fetch_comment_images` | 回复配图入库，与原推文共用 metadata，不挂画师 / 话题标签，展示名带「@用户 的回复」 | 本轮样本评论无配图，未覆盖 |
| [x] | 搜索最新全量 | release CLI | `query=from:karokaro6665`、最新、不限条数、增量 | 20+20+13 = 53 条，第 4 页 0 条判定到底并写水位线；媒体与画师模式完全重合（56 个文件全去重） | 已实测 |
| [x] | 搜索翻页不卡住 | release CLI | 同上，改滚动兜底前后对比 | 改前在 40 条处「连续 3 次滚动都没有新响应」；改后翻到第 3 页 | 已实测；偶发，多跑几次更稳 |
| [x] | 搜索增量 | release CLI | 写入水位线后再跑 | 首屏即「遇到上次抓过的推文」，0 下载 | 已实测 |
| [x] | 话题搜索热门 | release CLI | `#ブルアカ min_faves:1000`、热门、仅图片、上限 8、评论 20 | 首屏网格 40 条，取 8 条下载；提示热门不使用增量；7 条打开详情共 39 条回复 | 已实测 |
| [x] | 话题搜索最新 | release CLI | 同上改最新 | 8 张新图、49 条回复，0 警告 | 已实测 |
| [x] | 搜索词标签 | release CLI | 查库 | `x-webview/search/q-<哈希>` 名为搜索词原文，两次话题搜索 16 张、`from:` 搜索 56 张（去重的图也挂上） | 已实测 |
| [ ] | 搜索模式表单 | 桌面 CEF | 在收集弹窗里切换模式 | 画师模式只显示「画师」，搜索模式显示「搜索词」「排序」；搜索词留空运行时提示并结束 | |
| [x] | 视频搜索 | release CLI | `#ブルアカ min_faves:500`、`media_type=video`、上限 3 | 搜索词补 `filter:videos`，3 个最高码率 mp4 入库（1080x1920 / 1280x720 / 1920x1080） | 已实测 |
| [ ] | 搜索首屏无响应重载 | release CLI | 短时间内连续跑多次搜索 | 25 秒没等到 `SearchTimeline` 时重载页面重试一次；仍没有则警告里带页面请求与页面文字后结束 | 实测连跑后出现过两次空等、约 1 分钟后恢复；重载兜底尚未在空等现场验证 |
| [x] | 单条推文 | release CLI | `mode=tweet`，填带 `/photo/1` 尾巴的推文链接 | 识别出 id，图片入库（已有则去重），保存 5 条回复 | 已实测 |
| [x] | 书签 | release CLI | `mode=bookmarks`、增量、评论 0 | 账号全部 4 条书签推文 7 张图入库，到底后写入 4 个 id 的水位线 | 已实测 |
| [x] | 书签增量 | release CLI | 写入水位线后再跑 | 首屏即「遇到上次抓过的推文」，0 下载 | 已实测 |
| [x] | 点赞 | release CLI | `mode=likes`、上限 5、评论 0 | 侧栏链接缺失时兜底取到 `@cmtheit`，首屏 20 条取 5 条带图推文；因上限停止不写水位线 | 已实测；首版只找侧栏链接时报「找不到主页链接」 |
| [x] | 来源标签 | release CLI | 查库 | 「X 书签」7 张、「X 点赞」5 张（去重的图也挂上） | 已实测 |
| [ ] | 点赞增量 | release CLI | 不限条数开增量跑到底，再跑一次 | 第二次首屏遇到上次前 5 条之一即停；取消其中一条点赞后仍能停 | |
| [ ] | 推文无效 | release CLI | 填已删除推文或非推文链接 | 提示无法识别或「推文不存在、已删除或当前账号看不到」后结束 | |
| [ ] | 新模式表单 | 桌面 CEF | 收集弹窗切到单条推文 | 只显示「推文」「媒体类型」与评论两项，不显示上限 / 最旧时间 / 增量 | |
| [ ] | 关闭评论 | release CLI | `max_comments=0` | 不打开任何详情页，metadata `comments` 为空数组，模板不显示回复区 | |
| [ ] | 长评论区滚动 | release CLI | 回复数超过 50 的推文 | 滚动加载到 50 条即停，`commentsMax` 为 50 | |

## Kabegame 服务器插件适配 4.5.1 PathQL 续接语法

4.5.1 起画廊续接段改名为 `_kb_fc` / `_kb_desc` / `_kb_x<N>x`，旧写法不再识别，插件仍拼 `…/x20x/1`，连 4.5.1+ 服务器时每页都报 `path not found`。插件 0.2.1 运行前先各取一张图探测服务器方言，全站排序段与分页尾按探测结果拼；过滤模式两种分页尾都剥，原样路径解析失败时再把组合 / 倒序段改写成服务器方言重试。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全站随机 | debug CLI → demo（4.5.1+） | 默认配置，`page_size=3` | 识别为 `_kb_*` 语法，路径 `gallery/hide/sort/random-<种子>/_kb_x3x/1`，3 张下载成功 | 已实测 |
| [x] | 全站时间倒序 | debug CLI → demo | `sort=time` | 路径为 `sort/by-time/_kb_desc`，最新的 2 张入库 | 已实测 |
| [x] | 过滤模式粘贴旧写法 | debug CLI → demo | `pathql=…/pixiv/filter_comb/sort/by-time/desc/x100x/3` | 剥掉分页尾，改写成 `_kb_fc` / `_kb_desc` 后解析成功，总数 788 | 已实测 |
| [ ] | 连旧版服务器 | debug CLI → 4.5.0 及以前的桌面 Web 服务器 | 全站 + 过滤（粘贴新写法路径）各跑一次 | 识别为旧版语法，分页用 `x<N>x/<页>`，过滤路径的 `_kb_*` 段改回裸段名 | 手边没有旧版服务器，未覆盖 |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | kabegame-server 显示 0.2.1 | |

## 插件选择下拉框按 ID 搜索（`apps/kabegame/src/components/PluginPickerField.vue`）

桌面端 `el-select` 改用 `filter-method`：输入词不区分大小写，命中显示名或插件 ID 的选项保留；「全部」等前置项只按显示名匹配。Android 选择弹窗不受影响。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 按 ID 搜索 | 桌面 CEF | 收集弹窗的插件下拉中输入 `bluedafeiyu`、`BLUEDAFEIYU`、`pixiv` | 分别只剩「蓝色大肥鱼 AI 娘档案」「Pixiv」，显示名不含 ID 的插件也能搜到；输入无关词 `xyzzy` 结果为空 | 已实测（CDP 写入输入框并派发 input 事件） |
| [x] | 按名称搜索 | 桌面 CEF | 输入「蓝色」 | 只剩「蓝色大肥鱼 AI 娘档案」，与改动前一致 | 已实测 |
| [x] | 重新展开重置 | 桌面 CEF | 按 ID 搜索后选中蓝色大肥鱼，再次展开下拉 | 32 个选项全部恢复，输入框与选中行显示「蓝色大肥鱼 AI 娘档案」 | 已实测 |
| [x] | 前置项 | 桌面 CEF | 自动任务页插件过滤下拉输入「全部」 | 「全部插件(0)」行保留，计数正常 | 已实测；当前没有自动任务配置，只有这一行 |

## 插件页商店 tab 导航参数与商店列表 store 化（`apps/kabegame/src/stores/pluginMarket.ts`）

插件页当前 tab 改为 settings query 键 `pluginBrowserTab`（`?tab=store:<sourceId>`，已安装 tab 不写参数），切 tab 用 `replace`，从插件详情 `router.back()` 回来即恢复。商店源列表、各源插件列表、远程图标下沉到 `usePluginMarketStore`：按需加载、跨路由保存、`plugin-sources-changed` 事件被动刷新；`installedVersion` 读取时按已安装列表现算，删掉导入后的重拉。后端 storage 层源增 / 改 / 删后广播 `plugin-sources-changed`。顺带修复源管理弹窗「删除」只移除本地数组、不调后端的问题。回归中发现并修复：store 加载结束时删除 loading key 而非置 false，骨架屏 300ms 定时器未被清掉，导致列表加载完后骨架屏常驻。

回归方式：dev 桌面 CEF + `kabegame-chromium` 驱动 UI，前端临时 `sendDebugEvent` 插桩（session `plugin-tab-regress`）记录每次 `get_plugin_sources` / `get_store_plugins`（区分强制刷新与后台检查）/ `get_remote_plugin_icon` 请求、`plugin-sources-changed` 事件、挂载与 tab 变化，验证后已删除插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 切到商店 tab | 桌面 CEF | 重载 `/plugins` 后点官方源 tab | URL 为 `/plugins?tab=store:official_github_release`，30 张卡片，骨架屏不残留 | 已实测；首测发现骨架屏常驻，修复后复测通过 |
| [x] | 详情返回保留 tab | 桌面 CEF | 点 aibooru 卡片进详情，`history.back()` | 重挂载直接读回官方源 tab；无 `get_plugin_sources` / `get_store_plugins` / 图标请求、无骨架屏，只有一次后台 revalidate | 已实测（debug ingest 日志） |
| [x] | 已安装 tab URL | 桌面 CEF | 切回「已安装」 | URL 为 `/plugins`，不带 `tab` | 已实测 |
| [x] | 无效 tab 回落 | 桌面 CEF | 整页打开 `/plugins?tab=store:does_not_exist` | 源列表加载后回落「已安装」，`tab` 参数被清掉 | 已实测 |
| [x] | 详情无历史兜底 | 桌面 CEF | 整页打开远程详情 `/plugins/aibooru?mode=remote&source=official_github_release&version=1.0.1`，覆盖 `history.length = 1` 后点返回 | 回到 `/plugins?tab=store:official_github_release` | 已实测（`history.length` 为模拟） |
| [x] | 外部新增源 | 桌面 CEF | 页面外直接 invoke `add_plugin_source`（不经插件页代码） | 收到 `plugin-sources-changed {reason: added}`，store 重拉源列表，新 tab 出现；打开后首次网络加载显示骨架屏并正常消失 | 已实测；CLI 没有源命令，用直接 invoke 代替外部入口 |
| [x] | 修改源地址 | 桌面 CEF | 直接 invoke `update_plugin_source` 改 index 地址 | 收到 `{reason: updated}`，地址变化的已加载源以 `forceRefresh: true` 重拉 | 已实测 |
| [x] | 源管理弹窗删除 | 桌面 CEF | 「管理源」弹窗删除测试源并确认 | 后端 `get_plugin_sources` 已无该源；收到 `{reason: deleted}`；当前 tab 自动回「已安装」 | 已实测（当时宽屏无入口，经组件实例打开弹窗） |
| [x] | 桌面「管理源」入口 | 桌面 CEF 宽屏 | 看插件页标题栏右上角，点「管理源」按钮 | 标题栏依次为刷新（super）/ 导入源 / 管理源；点击打开「商店源」弹窗，可编辑源 | 已实测并截图；此前宽屏只有紧凑布局折叠菜单里有该入口，编辑源无路可达；light 模式不渲染弹窗，两处入口均按 `!IS_LIGHT_MODE` 隐藏 |
| [x] | 已安装状态同步 | 桌面 CEF | 内存中临时从 `pluginStore.plugins` 移除 aibooru 再恢复 | 商店条目 `installedVersion` 随之 `1.0.0 → null → 1.0.0`，无 `get_store_plugins` 请求 | 已实测（内存模拟，未真实卸载）；`plugin-*` 事件驱动 `pluginStore` 为既有逻辑 |
| [ ] | 真实安装 / 卸载 / 拖入导入 | 桌面 CEF | 从商店安装或卸载插件、拖入 `.kgpg` | 卡片更新角标与已安装状态即时正确，不重拉商店 | 官方源 30 个插件已全部安装，未做破坏性操作 |
| [x] | 语言切换 | 桌面 CEF | 设置语言 zh → en → zh | 收到 `{reason: official-source-name-i18n-sync}`，官方源 tab 名称随之切换 | 已实测，语言已恢复 zh |
| [ ] | Web 版 | Web | `?tab=` 恢复与只读源行为 | 与桌面一致，源增删改仍被只读拦截 | 未覆盖 |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 无错误 | 已运行 |

## Android 源管理页商店网格横向溢出（`apps/kabegame/src/views/PluginBrowser.vue`）

紧凑端插件网格与骨架屏网格由 `repeat(2, 1fr)` 改为 `repeat(2, minmax(0, 1fr))`：`1fr` 的下限是 min-content，`nowrap` 的长插件名会把列撑宽（实测 203px + 281px，容器仅 320px）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 商店 tab 两列等宽 | Android dev（360 CSS px，ja） | 打开源管理页，切到官方 GitHub 源 tab | 两列各 155px，`.plugin-browser-content` 的 `scrollWidth` 等于容器宽 320；长名称显示省略号 | 已实测并截图 |
| [ ] | 骨架屏 | Android | 首次加载商店 tab | 骨架卡片同样两列等宽，不横向溢出 | 同一规则，未单独截图 |
| [ ] | 桌面不受影响 | 桌面 CEF 窄窗 | 缩窄窗口进入紧凑布局 | 两列等宽 | 未覆盖 |

## Android 查询 chip 改为对话框面板（`KbFilterDropdown` / `GalleryQueryBar.vue` / `GalleryToolbar.vue`）

`KbFilterDropdown` 新增经 `kbFilterDropdownContextKey` 注入的面板承载方式：`App.vue` 在紧凑模式下提供 `panelMode: "dialog"` 与 `bindVisible: useModalBack`，面板内容（自定义 `#panel` 或内置选项列表）原样放进 `ElDialog`。`GalleryQueryBar` 的查询行不再只在桌面渲染，紧凑模式不换行、中段从 0 伸缩横向滚动；删除旧的 van-picker 过滤 / 时间 / 插件 / 媒体类型 / 宽高比 / 排序 picker 与其懒加载，仅保留每页条数 picker；画廊折叠菜单去掉「过滤」「排序」两项。dialog 档下 tooltip 恒给 `visible=false`：disabled 的 tooltip 收到 `true` 会立刻经 `useModelToggle` 回发 `false`，把对话框关掉。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | chip 单行 | Android dev（360 CSS px，ja） | 打开画廊 | 排序两颗 + 搜索 / 过滤 chip 横向滚动 + 行末 ⋯，同一行不换行 | 已实测并截图 |
| [x] | 过滤 chip 弹窗 | Android dev | 点时间 chip | 居中对话框，标题「時間」，内容为过滤树 `2026 通年 (100)` | 已实测并截图 |
| [x] | 内置选项列表 | Android dev | 点排序维度 chip | 对话框列出全部排序维度，当前项高亮 | 已实测并截图 |
| [x] | 返回键 | Android dev | 对话框打开时按返回键 | 只关闭对话框，不弹退出确认 | 已实测 |
| [ ] | 选值后关闭 | Android | 在过滤树 / 排序列表中选择一项 | 查询生效，对话框关闭，chip 显示取值 | 未在真机点选（避免改动用户当前查询） |
| [ ] | 搜索 chip | Android | 点搜索 chip 输入关键字 | 对话框内输入框聚焦、防抖生效 | 未覆盖 |
| [ ] | 高级查询弹窗内的 chip | Android | 在高级查询条件行点 chip | 嵌套对话框在上层，返回键逐层关闭 | 未覆盖 |
| [ ] | 画册 / 任务 / 畅游详情 | Android | 打开各详情页 | 出现同样的 chip 行并可弹窗 | 未覆盖 |
| [ ] | 每页条数 | Android | 右上角 ⋯ → 每页条数 | van-picker 仍可用 | 未覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 点各 chip | 仍为下拉弹层 | 未覆盖 |
| [x] | 类型与单测 | 仓库 | `vue-tsc`；`vitest` GalleryQueryBar / GalleryToolbar | 无错误，12 个用例通过 | 已运行 |

## Android 预览关闭中途重开后不可见（`packages/photoswipe-vue/src/vue/composables/useOpener.ts`）

`CSSAnimation.destroy()` 会同步回调 `onComplete`。关闭动画进行中重新 `open()` 时，`_applyStartProps` 里的 `stopAll()` 让被打断的关闭动画按「打开完成」收尾（`isOpening` 被清成 false），随后设置打开起始样式的分支被跳过，根节点停在关闭留下的 `opacity: 0; transition: none`：opener 认为已打开、返回栈占位、吉祥物被隐藏，画面却看不见预览。修复：opener 增加动画轮次 `_generation`，每次 open / close 自增；动画 `onComplete`、图片解码回调与关闭的延迟 `_start` 只在本轮有效。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根因复现 | Android dev | 未修复代码：打开预览后经 CDP 调 `opener.close()`，150ms 后 `opener.open()` | 根节点 `opacity: 0`、`transition: none`、背景 0.8、opener `isOpen=true`，与现场一致 | 已实测 |
| [x] | 修复后 | Android dev | 同上，关闭后 50 / 150 / 300ms 重新打开 | 关闭中途 opacity 为 0，重新打开后均恢复为 1，状态为已打开；返回键可关闭 | 重启 dev 后已实测 |
| [x] | 后台下载时预览 | Android dev | 下载任务运行中（总数 319 → 377）打开预览停留 20s，每 0.5s 采样；再左右滑动翻 6 次 | 全程 opacity 1、opener 无开合切换；翻页时 `pvwimgid` 跟随，预览可见；返回键可关闭 | 已实测并截图；本轮未自然触发「关闭中途重开」时序，该时序由上一行的直接复现覆盖 |
| [x] | 正常开合 / 打开中途关闭 | Android dev | 点图打开后立即返回；正常打开再返回 | 正常打开时 opacity 1、背景 0.8；两种情况都能关闭，吉祥物恢复，不误弹退出确认 | 已实测并截图 |

## Android 下载中返回键关闭预览被重新打开（`apps/kabegame/src/components/common/ImagePreviewDialog.vue`）

上一节「关闭中途重开后不可见」的触发源。返回键只关掉 `previewModal`，PhotoSwipe 的 `close` 要等关闭动画结束（约 0.4s）才发，期间 `ImageGrid` 的 `previewedId` 仍在；下载刷新经 `reconcilePreview` 给同一 id 换入新 `ImageInfo`，弹窗的 `props.image` watch 看到「非空且未打开」就重新 `previewModal.open()`。修 opener 之前重开落在关闭动画中途 → 不可见；之后 → 看起来按返回没反应。桌面 `el-dialog` 的 `@close` 在关闭开始时就发，没有这个窗口。修复：紧凑模式下 `previewVisible` 一变 false 就通知上层 `preview-close`（`notifyCompactPreviewClose`，每次打开只发一次，动画结束时那次去重）；同时冻结 `pswpWindow`（`imageById` 改为从同一窗口取），关闭动画期间幻灯片不被抽空。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 竞态复现（修复前） | Android dev | HEAD 版本：打开预览，经 `modalStack.closeTop()` 模拟返回，80ms 后给同 id 换新 `ImageInfo` 对象 | 预览被重新打开，`pvwimgid` 保留 | 已实测；下载中真实按返回也偶发复现（5 次左右出现 1 次） |
| [x] | 修复后竞态 | Android dev | 同上，跑 5 次 | 返回时 `previewedId` 立即清空，预览关闭、URL 清除，不再重开 | 已实测 |
| [x] | 关闭动画完整 | Android dev | 打开预览后返回，逐帧采样 | 关闭期间 PhotoSwipe 数据源保持 3 项、媒体元素在，约 0.4s 后移除 | 已实测 |
| [x] | 正常路径 | Android dev | 滑动翻图后返回；打开后立即返回；关闭后重开同一张 | 均正常关闭 / 打开，`pvwimgid` 跟随与清除正确 | 已实测 |
| [ ] | 下载中真实操作 | Android | 下载任务运行中反复打开预览、滑动、按返回 | 每次返回都关闭 | 测试时下载已结束，由上面的模拟覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 预览开合、切图、关闭 | 行为不变（改动只在紧凑模式分支） | 未覆盖 |
| [x] | 前端单测 | 仓库 | `vitest` `ImageGrid.previewFollowPage.test.ts` | 通过 | 测试补上 `@/stores/ui` 的 mock 后 32 例通过（`ImageGrid.vue` 新增了 `useUiStore()`） |

## Android 预览切图模型：手势回流 + 受控窗口（`ImagePreviewDialog.vue` / `photoswipe-vue` / `ImageGrid.vue`）

旧模型下「当前图」有三份状态（`previewedId`、URL `pvwimgid`、PhotoSwipe 内部下标），彼此用窗口下标与相对方向异步互写：给 PhotoSwipe 的 `index` 是一次性命令、关闭后残留，打开时 `runInit` 读到上一轮的下标；初始化、重定位发出的 `change` 又被当成用户滑动转成 `switch`，把上层的 `previewedId` 改走（现象：预览过 B 后再点 A 或 C，打开的都是 B）；URL 回写没有序号，旧写入落地会把 `previewedId` 拉回。

现模型：`previewedId` 唯一真源，URL 与 PhotoSwipe 只做投影。
- `ImageGrid` 只在挂载 / keep-alive 激活时读一次 `pvwimgid`，之后只写不读。
- 弹窗把三项窗口与当前下标（`pswpCurrentIndex`，派生值）随 `open` 同一轮下发；PhotoSwipe 的 `change` 不再回流。
- photoswipe-vue 区分手势与程序导航：手势翻页落定后发新的 `swipe` 事件，弹窗与边界滑动（`reach-boundary`）一样，和桌面箭头一样 `requestSwitch(方向)`；上层重算窗口与下标回设，PhotoSwipe 在同一个 watcher 里先按 id `relocate`、再 `goTo` 下标，通常是 no-op；手势翻页尚未结算时不收敛。
- slideView 改读父组件的实时数据源（`getItems`）：父组件 watcher 里重定位时子组件 `items` prop 还是上一帧，按旧长度夹取下标会落到错误的幻灯片（从下一页滑回上一页落到倒数第二张）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根因复现 | Android dev | 旧代码：依次点第 2、1、3 张（B → 返回 → A → 返回 → C） | 打开 C 显示的是 B | 已实测，debug ingest 记录到初始化 `change` 触发的 `prev` 切图与 URL 回写拉回 |
| [x] | 打开正确 | Android dev | 同上 | B、A、C 各自打开正确，`runInit` 读到的 `propsIndex` 即当前图，打开后无切图请求 | 已实测并截图 |
| [x] | 滑动翻页 | Android dev | 从 B 往后滑两张、往回滑一张 | `pvwimgid` 依次 574 → 573 → 574；每次 `swipe` 后新窗口 `relocate` 到原位，`goTo` 的 diff 为 0 | 已实测 |
| [x] | 首张往前滑 | Android dev | 第 1 页首张往前滑 | 停在首张，不发切图 | 已实测 |
| [x] | 快速连滑 | Android dev | 连续快速滑两下（next×2、prev×2） | 第二下撞窗口边缘走 `reach-boundary`，第一下落定再发 `swipe`，上层走两步，PhotoSwipe `goTo` 跟上；最终显示与 `pvwimgid` 一致 | 已实测并截图 |
| [x] | 跨页往后 | Android dev（每页 100） | 第 1 页末张往后滑 | 翻到第 2 页，显示 476 | 已实测 |
| [ ] | 跨页往回 | Android dev | 第 2 页首张往前滑 | 回到第 1 页末张 477 | 修复前落到倒数第二张 478；`getItems` 修复待重启 dev 后复测（Vite 未重载 `PhotoSwipe.vue`） |
| [x] | URL 只写不读 | 仓库 | `vitest`：挂载后改 `pvwimgid` | 预览目标不变 | 新增用例通过 |
| [ ] | 深链接 | Android / 桌面 | 带 `?pvwimgid=` 进入画廊或从其它页切回 | 打开该图 | 挂载 / 激活读取路径未改，未单独复测 |
| [ ] | 下载中滑动 | Android | 下载任务运行中滑动翻页、按返回 | 不跳图、不回弹 | 未覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 预览切图、关闭 | 行为不变（桌面不走 PhotoSwipe） | 未覆盖 |
| [x] | 类型与单测 | 仓库 | `vue-tsc`；`vitest src/components` | 无错误；16 个文件 80 例通过 | 已运行 |

## Android 画册页左侧贴边（`Albums.vue`）

`.albums-page` 的左内边距为 0，是给桌面三栏布局让树列贴窗口左缘；紧凑模式没有树列，`ImageGrid` 中栏又是 `display: contents` 加不上内边距，结果面包屑、查询 chip 行和图片都贴着屏幕左边，只有页头靠 `ml-5` 缩进。现在紧凑模式在页面根上补回 20px 左内边距，页头的 `ml-5` 只在非紧凑模式保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 左右对称 | Android dev | 打开任一子画册 | 页头、面包屑、chip 行左右边缘均为 20 / 340（360 宽视口），与画廊一致 | 已实测并截图 |
| [ ] | 未选画册 | Android | 进入画册页未选中任何画册 | 页头与内容左缘对齐，无面包屑 | 未覆盖 |
| [ ] | 桌面三栏不受影响 | 桌面 CEF | 宽屏打开画册页、开关信息面板 | 树列仍贴左缘，页头仍缩进 20px | `isCompact` 为 false 时样式未变，未单独复测 |

## 插件 SDK 与类型发布 npm，CLI 模板改用 npm 版本（`src-tauri/kabegame-cli/template/package.json`）

`@kabegame/types` 与 `@kabegame/plugin-sdk` 发布到 npm（scope `@kabegame`），两包改为 MIT 许可并补 LICENSE / README / 仓库元数据；SDK 对 types 的依赖由 `file:` 改为 `devDependencies`（发布的 `.d.ts` 不引用 types 全局）。`kabegame-cli plugin new` 新增模板变量 `kabegame-version`（取 CLI 的 `CARGO_PKG_VERSION`），V8 模板的两个依赖渲染为 `^<CLI 版本>`。仓库内插件仍用 `file:../../../packages/…`，`kabegame-plugin` skill 改为要求用 `plugin new` 生成后改回 `file:`。文档站「打包与发布」「plugin-sdk 工具库」「概览」去掉「未发布到 npm」的说明。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 模板渲染 | cargo test | `test_template_package_json_uses_cli_version` | v8 模板渲染为合法 JSON，两依赖均为 `^<CLI 版本>` | |
| [ ] | 仓库外生成并构建 | 任意目录 | `kabegame-cli plugin new demo && cd demo && npm install && npm run build` | 从 npm 装到 SDK 与 types，产出 `dist/main.js`，`plugin pack` 成功 | 需对应版本已发布 |
| [x] | 发布内容 | 本地 | 两包 `npm pack --dry-run` | types 只含 `.d.ts`、README、LICENSE；SDK 只含 `dist`、README、LICENSE | 已运行 |
| [ ] | npm 页面许可证 | npmjs.com | 发布新版本后查看两包 | 显示 MIT 与 README | 已发布的 4.5.1 仍为 GPL，需新版本 |

## 插件包名 `kabegame-plugin-<id>`，应用剥离前缀作插件 id（`kabegame-core/src/plugin/mod.rs`、`kabegame-cli`、`src-crawler-plugins/`）

`package.json.name` 与插件 id 分开：`kabegame_core::plugin::plugin_id_from_package_name` 剥离可选前缀 `kabegame-plugin-`（剥完为空则不剥），`resolve_kgpg_plugin_id` 的 `name` 来源与 manifest 显示名回退都经它；显式 `--id` 与文件名 stem 不剥离。`kabegame-cli plugin new <id>` 生成 `kabegame-plugin-<id>/`、模板 `name` 加前缀、`engines.kabegame` 改 `>=4.5.2`；`plugin pack` 改为「目录名 = name、输出 stem = 剥离后 id」，目录名先 canonicalize（修 `--plugin-dir .`）。插件仓库 32 个目录 `git mv` 为 `plugins/kabegame-plugin-<id>/`，`name` 同步、`engines.kabegame` 统一 `>=4.5.2`（旧版应用不剥离前缀）；`package-plugin.ts`、`generate-index.ts`、repack / run driver 按 id 输出 `<id>.kgpg` 与索引条目，参数接受 id 或目录名。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | core 单测 | cargo test | `kabegame-core --lib prefix` | 前缀剥离、`resolve_kgpg_plugin_id`（含撞内建 id 拒绝）、显示名回退 3 个新测试通过 | `plugin::` 全部 92 个通过 |
| [x] | CLI 单测 | cargo test | `kabegame-cli` 全部 | 模板 `name` 为 `kabegame-plugin-my-plugin`；带前缀目录打出 `<id>.kgpg`，输出 stem 用包名被拒，`<dir>/.` 也能识别目录名 | 27 个通过 |
| [x] | plugin new / pack | 本地 debug CLI | `plugin new demo`、`plugin new kabegame-plugin-demo2`，进目录 `plugin pack --plugin-dir . --output ../demo.kgpg` 与 `--output ../kabegame-plugin-demo.kgpg` | 目录分别为 `kabegame-plugin-demo` / `kabegame-plugin-demo2`（不重复加前缀）；前者成功，后者报 P3-7 | 已实测 |
| [x] | 全量打包 | 本地 debug CLI | `KABEGAME_CLI=target/debug/kabegame-cli deno run -A package-plugin.ts --out-dir <临时目录>` | 32 个全部成功，产物文件名均为无前缀 `<id>.kgpg` | 已实测；未覆盖仓库内已跟踪的 `packed/` |
| [x] | 索引生成 | 临时目录 | 软链 plugins 后跑 `generate-index.ts --tag v4.5.2` | 32 条，`id` / `name` / `downloadUrl` 均无前缀，`minAppVersion` 为 `4.5.2` | 已实测 |
| [x] | 临时运行识别 id | 本地 debug CLI | `plugin run <临时目录>/konachan.kgpg --dry-run --via local` | 显示「插件 konachan」，读取原 id 的默认配置 | 已实测 |
| [ ] | 已安装用户升级 | 桌面 dev | 已装旧包的情况下，装新打的 `wallhaven.kgpg` | 识别为同一插件（覆盖更新），已有图片、插件数据目录不变，不会出现 `kabegame-plugin-wallhaven` | 未覆盖 |
| [ ] | 旧版应用 | 4.5.1 应用 | 商店看新索引 | 插件显示「版本不兼容」，不会装出重复插件 | 未覆盖，需发版后验证 |
| [ ] | release CLI | `target/release` | 重建 release CLI 后 `deno task --cwd src-crawler-plugins package` | 打包成功；旧 release CLI 会因输出 stem ≠ name 报 P3-7 | 本机 release CLI 为改动前版本，未重建 |

## 画册选择器 / 画册树打开慢：图片计数不挡渲染，标签目录不参与子树 join（`albums_images_provider.yaml`、`services/albums.ts`、`AlbumTreeView.vue`）

prod 库（标签画册 52,915 个，挂在标签上的 `album_images` 1,218,972 行）打开 `AlbumPicker` 要等 2 秒多。用 `KABEGAME_SQL_DEBUG=1 kabegame-cli pathql query` 逐条跑打开时的查询，其它都在 30ms 内，只有标签根页的 `albums://roots/~any/album_kind/label/~or/album_kind/label_dir/~end/x500x/1/~~/images` 要 2262ms：17 个标签根里 16 个是 `label_dir`，子树覆盖整片标签森林，要把约 122 万成员行 join 一遍；而 `label_dir` 的 `image_count` 前端根本不用（显示的是 `child_count`）。又因为 `fetchPageWithCounts` 用 `Promise.all` 等三条查询，`useTreeModel.reload` 再等所有分区，整棵树都陪这一条一起等。

改动：`albums_images_provider` 在 tree join 的 `ON` 里加 `albums.type <> 'label_dir'`（放外层 `WHERE` 会让规划器改成全表扫 `album_images`，实测反而 1.0s），标签目录不再出计数行；前端 `fetchAlbumPage` 只等行与 `~~/children`，`image_count` 经 `AlbumPage.imageCounts` 单独到达，`AlbumTreeView` 按 key 补进句柄（`AlbumNode.count` 为 `null` 时不显示数字，刷新时先沿用旧计数）；系统画册计数同样后补；`searchAlbums` 只用于查重名，改为只取行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 慢 SQL 定位 | prod 库 + release CLI | 逐条跑选择器打开时的 `albums://` 查询 | 仅标签根页 `~~/images` 秒级 | 2262ms，其余 ≤ 26ms |
| [x] | 新 SQL 耗时 | prod 库 sqlite3 只读 | 原 SQL 与 `ON` 加 `albums.type <> 'label_dir'` 对比 | 结果中 `label` 叶子计数不变，耗时降到几十毫秒 | 1.2–2.3s → 30ms（冷缓存 128ms）；执行计划仍走 `idx_albums_ancestor_path` |
| [x] | 计数口径 e2e | cargo test | `kabegame-core --test dsl_e2e album`、`count_without_top_order` | 叶子 / 普通画册计数与 images:// 一致；`label_dir` 不出计数行 | 10 个通过 |
| [x] | 前端类型 | 仓库 | `deno task check -c kabegame --skip cargo` | vue-tsc 无错误 | 已运行 |
| [x] | 选择器首屏 | 桌面 dev（prod 数据，55,886 张） | 画廊右键图片 →「加入画册」→ 点开选择器，逐帧计时 | 各分区行立即出现，图片计数随后补上；标签目录显示子画册数 | 点击到首行 328ms，同帧计数全部到齐（标签根页 `~~/images` 已不再秒级）；e-shuushuu / konachan 等目录显示子画册数 |
| [x] | 计数后补 | 桌面 dev（prod 数据） | 画册页侧栏展开 konachan → general（436 个标签叶子） | 叶子行先出现、计数为空，随后补齐且数值正确 | 84ms 出行、926ms 计数补齐；抽查 glasses / gray hair / bikini 与 sqlite 按隐藏口径直算一致（773 / 4302 / 1387） |
| [x] | 计数后补不串号（数据变化） | 桌面 dev（prod 数据） | 画册页展开 konachan → general，依次跑 kabegame-server（1 页 20 张）与 konachan 任务（6 新增、143 去重），debug ingest 记录每页行与计数到达 | 计数先保持旧值再更新，不闪空、不被旧查询覆盖 | 约 4 分钟内 67 次刷新、292 页：刷新页空计数 0 行（仅首次加载与 1 个新建标签为空）；98 次计数乱序到达，163 行按句柄身份跳过，跳过值无一成为最终显示值；任务停止后 general 437 个叶子 + konachan 6 个目录与 sqlite 直算全部一致。插桩已删除 |
| [x] | 隐藏口径 | 桌面 dev（prod 数据） | 展开 465 行的画册树，切换 `globalPathRoute.hide`（等同工具箱开关）开 → 关 → 开，逐帧检查 | 普通画册 / 标签叶子计数按 `~~/images/hide` 变化，标签目录不受影响，重载期间不闪空 | gray hair 4302 ⇄ 4313、bikini 1387 ⇄ 1390，与 sqlite 两种口径一致；general 恒为 436；约 420 帧内空计数 0 行、行数不减；已恢复为开启 |
| [ ] | 画册页右键菜单计数 | 桌面 | 计数还没到时右键画册 | `albumImageCount` 按 0 处理，不报错 | `Albums.vue` 已 `?? 0` |
| [x] | 选择器无分割线 | 桌面 | 打开「加入画册」的 `AlbumPicker` 下拉；再看画册页侧栏 | 分区之间不再画分割横线，「标签」分区标题仍在；侧栏画册树照旧显示分割线 | 选择器内 `.kb-tree-panel__separator` 0 个、侧栏 3 个，截图确认 |
| [ ] | 选择器无分割线（Android） | Android | 打开 `AlbumPicker` 全屏选择页 | 同上 | 未覆盖 |
| [x] | 选择器内标签目录可展开 | 桌面 dev | 「加入画册」选择器里点 konachan 目录行，再点 general，再点叶子 glasses | 目录行点击只展开不选中、弹层不关；叶子可选中并关闭弹层 | 6 处选择器（加入画册、本地导入、网页收集、收集输出、自动任务、轮播目标）由 `is-selectable` 禁用目录改为 `expand-label-dirs`；实测加入画册一处，选中后关闭对话框未提交 |

## 任务抽屉：运行中任务禁止删除，任务数改为搜索（`TaskDrawerContent.vue`、`TaskDrawer.vue`、`TaskContextMenu.vue`）

任务卡片右上角的删除按钮与右键「删除任务」在 `running` / `waiting_downloads` 时禁用，提示先停止；`handleDeleteTaskById` 同样拦截，抽屉不再走「停止并删除」（任务详情页的删除不变）。任务列表顶部「共 N 个任务」换成搜索框，按插件 id 与当前语言插件名做不区分大小写的子串过滤（任务启动时已经全量加载，纯前端过滤），无结果时显示空状态，搜索词变化时列表滚回顶部；面板标题右侧仍显示总任务数。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端类型 | 仓库 | `deno task check -c kabegame --skip cargo` | vue-tsc 无错误 | 已运行 |
| [x] | 运行中禁删 | 桌面 dev（CDP） | 启动 konachan 任务，点其卡片右上角删除按钮、右键「删除任务」；再停止任务 | 按钮半透明禁用、悬停提示需先停止，点击不弹确认；右键「删除任务」置灰，点击无反应；停止（canceled）后两者恢复可用 | 已实测；补了 `.close-btn.is-disabled` 样式，原自定义样式会盖住禁用态 |
| [ ] | 等待下载收尾 | 桌面 | 任务进入 `waiting_downloads` | 同上，仍不可删除 | 未覆盖 |
| [x] | 搜索 | 桌面 dev（145 个任务） | 依次输入 `kona`、`动漫壁纸`、`KABEGAME`、`Server`、`zzz-none`，再清空 | 列表只剩匹配任务（`Server` 经 id `kabegame-server` 命中）；无匹配显示「没有匹配的任务」；清空恢复全部 | 已实测；Android 未覆盖 |
| [x] | 深滚动后搜索 | 桌面 dev | 列表滚到 scrollTop 5000 后输入 `KABEGAME` | 回到顶部并显示 3 条结果，不出现空白列表 | 修复前整列空白（沿用旧 scrollTop），已加 `scrollTo(0)` 并复测 |
| [ ] | 搜索中清除所有 | 桌面 | 搜索状态下点「清除所有任务」 | 仍按全部已结束任务清除（与搜索无关），计数文字不变 | 未覆盖 |

## 任务抽屉：停止叉号改为下方小确认框（`TaskDrawerContent.vue`、`TaskDrawer.vue`）

进度条旁的停止叉号包进 `el-popconfirm`（`placement="bottom-end"`，文案 `tasks.drawerStopConfirm`「停止任务？」，确认按钮 danger），确认后才 emit `cancel-task`；`TaskDrawer` 把抽屉的 `cancel-task` 接到不弹窗的 `handleStopTaskById`，右键菜单「停止任务」仍走带 `ElMessageBox` 的 `handleCancelTaskById`。各行确认框由 `stopConfirmTaskId` 受控，同一时刻最多开一个，并经 `useModalBack` 接入 Android 返回栈。placement 不能用居中的 `bottom`：叉号贴着抽屉右缘，居中会右溢出，popper flip 的横轴检查随之否掉 bottom / top，小框被翻到左侧盖住卡片。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端类型 | 仓库 | `deno task check -c kabegame --skip cargo` | vue-tsc 无错误 | 已运行 |
| [x] | 叉号小确认框 | 桌面 dev（CDP） | 启动两个 konachan 任务，点第一个任务进度条旁叉号 | 叉号正下方弹出「停止任务？」小框，含「取消 / 确认」，无居中对话框 | 已实测：`bottom-end`，小框顶 609.5 = 叉号底 597 + 12，右缘与叉号对齐；首版用 `bottom` 时被翻到左侧，已修复并复测 |
| [x] | 靠近视口底部 | 桌面 dev | 点第二个任务的叉号（底部 763px） | 下方放不下时翻到叉号上方 | 已实测 |
| [x] | 单开 | 桌面 dev | 第一个框开着时点第二个叉号 | 只保留后点的那个小框 | 已实测，可见小框恒为 1 |
| [x] | 取消 / 点框外 | 桌面 dev | 小框内点「取消」；重开后点抽屉内其它区域 | 只关闭小框，任务仍 running，抽屉保持打开 | 已实测 |
| [x] | 确认 | 桌面 dev | 小框内点「确认」 | 任务转 canceled，不弹居中对话框 | 已实测 |
| [x] | 任务结束时框还开着 | 桌面 dev | 打开小框后等任务自然完成 | 叉号随进度条状态消失，小框一并关闭，不残留 | 已实测：两个 konachan 任务跑完后可见小框为 0 |
| [x] | 右键「停止任务」 | 桌面 dev | 右键运行中任务 →「停止任务」 | 仍弹出居中确认对话框，确认后停止 | 已实测 |
| [ ] | Android 返回键 | Android | 打开小框后按返回键 | 只关闭小框，抽屉保持打开 | 未覆盖 |

## Android 收集表单统一选择器交互

Android 收集表单使用与桌面一致的 `el-select` 展示插件选择入口和当前值，但不打开桌面下拉面板；点击后仍打开原有 Android 插件选择弹窗，选中插件后将值回写到 `el-select`。输出画册复用现有选择框、搜索和画册树，但选择面板从全屏覆盖层改为居中弹窗。插件配置中的 `options` 单选字段统一使用项目 `el-select`，不再打开 Vant picker。其它 `AlbumPicker` 入口、桌面端与窄屏 Web 的触发器不受影响。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 下拉框触发器 | Android | 打开收集表单，查看“选择源”并点击选择框 | 外观与桌面下拉框一致；只打开 Android 插件选择弹窗，不出现桌面下拉面板 | 待 Android 实机验证 |
| [ ] | 插件选择与值回写 | Android | 在弹窗中选择可用插件 | 弹窗关闭，选择框显示所选插件名称，插件配置加载且任务可正常启动 | 待 Android 实机验证 |
| [ ] | 输出画册弹窗 | Android | 点击“输出画册”，搜索并选择一个画册 | 居中弹窗显示搜索框和画册树；选择后弹窗关闭，选择框显示画册名称 | 待 Android 实机验证 |
| [ ] | 插件配置单选字段 | Android | 打开包含 `options` 变量的插件表单，选择普通值、空字符串选项并清空 | 使用项目 `el-select` 下拉面板，不出现 Vant picker；选择值与清空语义保持正确 | 待 Android 实机验证 |
| [ ] | 可搜索下拉焦点 | Android | 打开选项不少于 9 项的 `options` 字段或可新增的 `list` 字段 | 首次点击只展开下拉，不聚焦输入框、不弹软键盘；再次点击搜索输入区后才可输入 | 待 Android 实机验证 |
| [ ] | 选择后焦点 | Android | 搜索并选择一项，或清空当前单选值 | 下拉按原规则关闭或保持，不自动抢回输入焦点、不重新弹出软键盘 | 待 Android 实机验证 |
| [ ] | 非 Android 回归 | 桌面 / 窄屏 Web | 打开收集表单 | 继续显示原有选择触发器 | 待验证 |

## 插件与宿主任务日志多语言（`Kabegame.getLang()`、`defineI18n`、konachan 1.7.4）

插件可通过同步 `Kabegame.getLang()` 取得应用已解析的语言码；V8 每次调用读取设置，WebView 在建窗时把语言烘焙进 bootstrap。SDK `defineI18n` 按当前语言、基准语言、key 本身的顺序回退。konachan 的用户可见日志和校验错误改用插件内五语言 JSON；宿主的导航、请求、Cookie、标签和任务收尾日志改存 `_i18n` 载荷，由前端或 CLI 按当前语言渲染。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | konachan 日志语言 | 桌面 CEF | 依次把应用语言切到简中、英文、日文、韩文、繁中，每次运行一页 konachan 任务 | Cookie、打开页面、排行榜 / 分级、校验错误等插件日志使用当前语言；旧版宿主没有 `getLang` 时回退简中 | 待验证 |
| [ ] | V8 `getLang()` | dev CLI / 桌面 CEF | 在 V8 插件中记录 `Kabegame.getLang()`，切换五种应用语言后分别运行 | 返回 `zh` / `en` / `ja` / `ko` / `zhtw`，与界面语言一致 | 待验证 |
| [ ] | WebView `getLang()` | 桌面 CEF | 在 WebView 插件中记录 `Kabegame.getLang()`，切换语言后新建任务窗口 | 返回建窗时的已解析语言码；脚本可同步调用，无新增 Tauri IPC | 待验证 |
| [ ] | 历史宿主日志重译 | 桌面 CEF | 运行会产生 `[to]`、`[cookie]`、HTTP 重试与下载等待日志的任务，保持日志对话框打开并切换应用语言 | 宿主日志立即按新语言重新渲染；插件已写入的纯文本日志保持任务运行时语言 | 待验证 |
| [ ] | CLI 日志渲染 | dev CLI | 切换设置语言后执行 `kabegame-cli plugin run`，触发宿主 `[to]` / `[cookie]` 日志 | CLI 输出对应语言的可读文本，不出现原始 `{"_i18n":...}` 载荷 | 待验证 |

## 运行配置复制为推荐配置 JSON

运行配置卡片的「更多」由 `el-dropdown` 改为 `el-select`（`model-value` 恒为 `null`，选中只发命令），新增「复制为推荐配置 JSON」。导出由 `runConfigToPresetJson` 生成，字段与 `parsePluginRecommendedPreset` 读取的一致：`name`、可选 `description`、`userConfig`、有模式时的 `scheduleSpec`、非空时的 `httpHeaders`；不导出 id、时间戳、输出目录、画册与并发。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查 | 仓库 / Linux standard | `deno task check -c kabegame --skip cargo` | `vue-tsc` 无 error | 已运行 |
| [ ] | 更多菜单交互 | 桌面 CEF / Android | 点卡片「更多」依次选编辑、复制、删除 | 各动作与改前一致；选完触发器仍显示「更多」，不残留所选项；点下拉不触发卡片详情 | |
| [ ] | 复制 JSON 内容 | 桌面 CEF / Web | 对带定时与不带定时的配置各选「复制为推荐配置 JSON」并粘贴 | 成功提示；JSON 只含上述字段，无定时时无 `scheduleSpec` | Web 走 `navigator.clipboard` |
| [ ] | 回放为推荐配置 | 桌面 CEF + 插件源码 | 把复制内容存为插件 `configs/x.json` 并加入 `kbRecommendedConfigs`，打包安装后在「推荐」tab 预览并导入 | 预览参数、定时与原配置一致，导入成功且可正常运行 | |

## Android 畅游 Phase 1

Android 畅游使用独立 `SurfActivity`：顶部复用桌面 `surf-navbar.html` Tauri webview，底部普通 Android WebView 加载外部站点。导航由 Rust 命令转给 Kotlin，URL / Cookie 由 Channel 回到 Rust；内容页没有 Tauri IPC。UA 不入库：内容页保持系统 WebView 默认 UA，启动时登记为 `Kabegame.cefUserAgent()` 的返回值，插件照桌面写法与 `requireCookie()` 配对。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面静态检查 | 仓库 / Linux standard | `check-kabegame` driver | `vue-tsc` 与 Rust `cargo check` 无 error；桌面畅游引用未被共用模块搬迁破坏 | 已运行（撤 UA 列后重跑）：vue-tsc 0 error，cargo 0 error |
| [x] | Android 静态检查 | Android NDK | `check-kabegame` driver `--mode android --skip vue` | Rust Android target 与 Kotlin/Gradle 配置无 error | 已运行（撤 UA 列后重跑）：Android Rust 0 error；`:app:compileUniversalDebugKotlin` 成功 |
| [x] | Cookie 写入去重 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib surf_record` | Cookie 相同不写库、不发事件；变化时更新 | 已运行：1 项定向单测通过；`dsl_e2e` 52 项通过 |
| [ ] | 启动与布局 | Android 真机 | 工具箱 → 畅游 → 输入 `https://www.pixiv.net` | 打开独立 Activity；顶部 48dp 导航栏、底部站点；主 Vue 页面保留在下方 | dev 包与 prod 包都要测：dev 的 applicationId 与 Java 包不同，曾因写死 `MainActivity` 报 `failed to create window` |
| [x] | 导航栏紧凑间距 | Android 真机 | 打开畅游站点，对比顶部五个图标按钮与地址栏 | 图标按钮按 SVG 自然宽度加 6px 左右 padding 排列，不再占用固定 40px 宽度；地址栏占用剩余宽度 | 真机 HMR 截图确认 |
| [ ] | 导航与地址同步 | Android 真机 | 点站内链接、触发 SPA 路由，再测试地址栏回车、后退、前进、刷新 | 内容页导航正确；navbar 地址随整页与 SPA 跳转更新 | |
| [ ] | 返回键与关闭 | Android 真机 | 页面有历史时连续按系统返回键，再点 navbar 关闭 | 先逐级后退，退到头关闭 Activity；回到原 `/surf` 且 Vue 状态不丢；会话状态立即清除 | |
| [ ] | Cookie 保存 | Android 真机 | 登录站点后关闭 Activity，查看记录并查询数据库 | Cookie 非空且包含 HttpOnly 登录 Cookie；`surf_records` 没有 `user_agent` 列；列表由事件即时更新 | |
| [ ] | `cefUserAgent()` 返回 WebView UA | Android 真机 / V8 插件 | 冷启动后直接运行调用 `Kabegame.cefUserAgent()` 的插件（不先开畅游） | 返回值与内容页 `navigator.userAgent` 一致，不为 `null` | |
| [ ] | 插件登录态复用 | Android 真机 / V8 插件 | 运行需要该站登录态且调用 `requireCookie` 的插件 | 日志出现 `taskLogCookieInjected`；插件用 `cefUserAgent()` 设置的 UA 与 Cookie 签发 UA 一致，登录态有效；Cloudflare 站点（如 danbooru）不再 403 | |
| [ ] | 旋转、键盘与重开 | Android 真机 | 旋转屏幕、聚焦登录表单，再关闭并重复打开畅游 | Activity 不因旋转重建；表单不被键盘遮挡；第二次打开无 label 残留或空白页 | |
| [ ] | 安全边界 | Android debug / `chrome://inspect` | 分别检查 navbar 与内容页全局对象 | navbar 有 `__TAURI_INTERNALS__`；内容页 `window.ipc` 与 `__TAURI_INTERNALS__` 均为 `undefined` | |

## 插件请求头大小写与 HTTP/2

hyper 走 HTTP/1.1 时默认把请求头名全部转成小写，Cloudflare 视作机器人特征直接挑战（实测同一请求 curl 用 `User-Agent` 是 200，全小写是 403）。V8 插件客户端（`plugin/v8/ops.rs::build_client`）与下载器客户端（`crawler/downloader/http.rs::create_client`）开启 `http1_title_case_headers()`；桌面 reqwest 增加 `native-tls-alpn`，握手声明 `h2`，能协商 HTTP/2 的连接按规范使用小写头名。安卓 rustls 原本就会声明 h2。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查 | 仓库 / Linux standard + Android | `check-kabegame` driver（桌面、`--mode android`） | cargo 无 error；`Cargo.lock` 无变化 | 已运行 |
| [x] | Cloudflare 站点不再 403 | 桌面 dev CLI | `run-cli.sh anime-pictures --var startPage=0 --var endPage=0 --via local`，不进畅游、无 Cookie | 列表 / 详情 API 返回 200，原图下载成功 | 已运行：修复前 API 稳定返回 `cf-mitigated: challenge`；修复后全站与 `tag=blue archive` 两轮共新下载 24 张原图、0 失败，metadata 齐全、标签 948 条与源数据一致 |
| [ ] | 其它插件回归 | 桌面 dev CLI | 各跑一页 pixiv、danbooru、konachan、weibo | 请求与下载结果和修复前一致；需要登录态的插件 Cookie 仍生效 | 关注依赖自定义小写头名的插件 |
| [ ] | HTTP/2 协商与代理 | 桌面，开 / 关系统代理 | 跑任一 HTTPS 插件，观察网络或服务端日志 | 支持 h2 的站点走 HTTP/2；只支持 HTTP/1.1 的站点与 HTTP 代理照常可用 | |
| [ ] | Android 下载 | Android 真机 | 跑 anime-pictures 一页 | 不需要畅游 Cookie 也能下载 | 安卓走 rustls |

## 画廊网格空白格（合成层拆分）

`ImageContent` 的缩略图 / 原图层 `<img>` 带 `z-index: 1/2`，而画廊滚动容器 `.image-grid-container` 不是层叠上下文，图片的 z-index 逃到外层，绘制顺序排在底部导航等已合成层之后，无法并回滚动内容层，被 Chromium 按行拆成几十个 squashing layer（安卓实测 40 层，其中 26 个是 936×465 的整行图片层）。某层漏光栅化就整行空白，手指一点触发失效才出现；桌面 CEF 偶发。修复：滚动容器加 `isolation: isolate`（实测降到 14 层，图片不再单独成层）；同时删除 `ImageItem` 上常驻的 `will-change: transform, box-shadow` / `will-change: contents`，避免每项各自成层。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 合成层数 | Android 真机（dev 包） | CDP `LayerTree.enable` 统计画廊页图层与 compositing reasons | 不再出现 `IMG.thumbnail-layer` 的 `Overlap` 层；总层数约 14 | 修复前 40 层 |
| [ ] | 安卓空白格 | Android 真机（dev 包） | 画廊每页 100 / 500 / 1000，快速上下滑动多屏、翻页后停在页顶，用 `adb exec-out screencap` 截图（不要连 CDP，CDP 截图 / 求值会触发重绘掩盖问题） | 不再出现整格 / 整行空白；无需点击即显示 | 修复后 adb 连续 10 帧未复现；问题偶发，需日常使用观察 |
| [ ] | 桌面空白格 | 桌面 CEF | 每页 1000、5 列以上快速滚动，含左侧画册树的画册页 | 不再偶发空白格 | |
| [ ] | 层叠关系 | 桌面 CEF / Android | 画廊、画册、任务详情页：页头「…」菜单、sticky 分页器、滚动按钮、右键菜单、空状态与 loading 遮罩 | 页头与分页器仍盖在图片之上；弹出菜单不被网格遮挡 | 滚动容器成为层叠上下文后，容器内 z-index 不再与外部比较 |
| [ ] | hover / 选中动画 | 桌面 CEF | 悬停、框选、Ctrl 多选网格项 | 描边、阴影与 transform 过渡仍顺滑 | |
