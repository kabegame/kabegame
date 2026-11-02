# P3-0c — 子 frame 进程与 rAF：子 frame 不再跨窗口复用渲染进程（CEF 08）、同进程 iframe 每帧只派发一次 rAF（CEF 09）

> 上级：[phase-3-0-scene-host.md](phase-3-0-scene-host.md)。前置：[phase-3-0b-renderer-move.md](phase-3-0b-renderer-move.md) 已提交（dcda18ea）。
> 依据：2026-11-02 的只读调查（CDP 页面级 tracing 读 `TracingStartedInBrowser.frames[].processId`、helper 进程命令行、
> Chromium 149.0.7827.201 / CEF 7827 源码）与 rAF 实测（`rafcount.mjs`）。用户裁定见文末「已定」；实施记录见文末。

## 总体设计思路

这一步解决两个现象。它们出自 Chromium 的两套不相干机制，所以拆成两个 CEF 补丁，一次重编。两个补丁都只动 CEF / Chromium，没有 Rust、前端或配置改动。

**第一个现象：三个场景宿主共用一个渲染进程。**

Chromium 对所有 `file:` URL 只算一个站点 `file:`。同一窗口里的两个 `file:` iframe 属于同一个 BrowsingInstance、同一个 SiteInfo，必然拿到同一个 SiteInstance，也就是同一个进程。这是「同源、同 browsing context group 的文档能同步互相脚本访问」的约束，任何开关都拆不开，本步不碰。

跨窗口的共用来自一条可选的复用策略。内容层给「需要专用进程的子 frame」新建 SiteInstance 时，会设 `kReusePendingOrCommittedSiteSubframe`。这条策略在整个 BrowserContext 里找已经承载同站点的进程，跨 BrowsingInstance 复用。它的总开关是 embedder 钩子 `ShouldEmbeddedFramesTryToReuseExistingProcess(outermost_main_frame)`，而 CEF 没有覆盖这个钩子。

CEF 补丁 08 在 `ChromeContentBrowserClientCef` 里覆盖它，对所有 browser 无条件返回 false。Chrome 基类只对扩展页面里的子 frame 返回 false，无条件 false 已经涵盖了这种情况。之后，子 frame 的新 SiteInstance 保持默认策略：
- 有 spare 就用 spare，否则新建进程；
- 只有完全空的进程，或者进程数打满上限时，才会复用别的进程。

结果是两个窗口的 `file:` 子 frame 各自一个进程，场景宿主与网页壁纸都覆盖到，畅游 / 爬虫窗口里的第三方 OOPIF 也不再跨窗口复用。

宿主本来就是 OOPIF，只是换进另一个 OOPIF 进程，所以以下机制都不受影响：
- CEF 04–07 的文件访问、闸门与文档 URL 归属；
- tauri 18–19 的子 frame IPC 与按 frame 投递；
- `localStorage`：它按 origin 存在 StorageService 里，跨进程照常共用。

**为什么不直接开 `DisableProcessReuse` feature。** 那个 feature 也能关掉子 frame 的这条复用策略（`render_frame_host_manager.cc:3290`）。但它同时会让 http(s) 主 frame 的按站点复用失效：`render_frame_host_manager.cc:488-491` 在 `GetProcessReusePolicyForMainFrame` 里直接返回 `kDisableProcessReuse`，桌面默认开启的 `kProcessPerSiteUpToMainFrameThreshold` 因此失效。08 只作用于子 frame，主 frame 的复用照旧。

**第二个现象：同一页面里有 N 个同进程 iframe 时，每个文档的 rAF 每帧被派发 N 次。**

成因如下：
- 每个 local root 的 frame widget 每帧都调 `Page::Animate`；
- `PageAnimator` 遍历整页里本进程的全部文档，逐个跑 rAF；
- 所以每个 widget 的这一轮都会把整页文档再跑一遍。

CEF 补丁 09 用 Chromium 内层补丁改 Blink：
- `WebFrameWidgetImpl::BeginMainFrame` 改调新的 `PageAnimator::AnimateForLocalRoot`，只服务本 widget 控制的文档，即本 local root 及其 local 子孙，与 `ForEachLocalFrameControlledByWidget` 同一口径；
- 别的 local root 交给它自己的 widget。文档请求帧本来就只请求自己 local root 的 widget；
- `PostAnimate` 同样按 widget 收窄。

Blink 侧比较了两种改法，选 (a)：
- **(a) 按 widget 收窄**（选用）；
- **(b) 按帧时间记账、同一时间跳过**。

选 (a) 的理由，对比表见点 2：
- 每个文档只在自己 widget 的任务里服务，行为与「每个 OOPIF 独占一个进程」时完全相同；
- 顺带去掉了「隐藏的 OOPIF 被同进程兄弟 widget 带着跑 rAF」的泄漏；
- `SetCurrentFrameHadRaf` 等帧标志改由真正跑了 rAF 的 widget 上报；
- 不引入新状态，也不依赖不同 widget 的帧时间恰好相等。

09 对所有页面生效，包括畅游 / 爬虫里的第三方页面。

**补丁承载**
- **08** 只改 `//cef`，与 04 / 06 同类，是 `third-patches/cef/` 里的普通补丁。
- **09** 只改 Chromium，照 01 / 03 的做法：
  - 外层补丁给 `third/cef` 的 `patch/patch.cfg` 加一条 `kabegame_raf_local_root_only`，再加内层补丁文件 `patch/patches/kabegame_raf_local_root_only.patch`；
  - 构建时 CEF 的 `patcher.py` 把它应用到 Chromium 源码，已应用的就跳过。
- 两个补丁功能独立、回滚独立，所以分成两个编号。

**几个关键取舍**
- **不改 `Page::Animate` 的签名**：`page.h` 有 331 个直接包含者，改它会引起大规模重编。改为在 `PageAnimator` 里加方法，`page_animator.h` 只有 22 个非测试编译单元包含。
- **`web_frame_widget_impl.cc` 两边都在改**：CEF 自带的 `views_widget.patch` 已经改了这个文件（第 5534 行附近一行）。09 的内层补丁以「上游 + views_widget」的状态为底生成，两处 hunk 相距很远，可以叠加。这个内层补丁不能用 CEF 的 `patch_updater.py --resave` 重存，否则会把 `views_widget` 的 hunk 一并收进来。
- **09 不加运行时开关**：加 Blink runtime feature 或改 `features.h` 同样会引起大规模重编。回滚就是撤补丁、重编。
- **两个补丁都不改 CEF 公共 API**：`third/cef-rs` 的 bindings 不用重生成。

## 现状锚点

**a. 子 frame 的新 SiteInstance 默认带「跨 BrowsingInstance 复用同站点进程」策略**
（Chromium `content/browser/renderer_host/render_frame_host_manager.cc:3274-3299`，`RenderFrameHostManager::GetSiteInstanceForNavigation` 内）
```cpp
  // 现状：非最外层主 frame、新 SiteInstance 还没有进程、需要专用进程（桌面 site-per-process 下恒真）时，
  //       只要 kDisableProcessReuse 没开、embedder 钩子返回 true，就设 kReusePendingOrCommittedSiteSubframe
  if (!frame_tree_node_->IsOutermostMainFrame() &&
      !new_instance->HasProcess() && new_instance->RequiresDedicatedProcess() &&
      !new_instance->IsPdf()) {
    if (!base::FeatureList::IsEnabled(features::kDisableProcessReuse) &&
        GetContentClient()
            ->browser()
            ->ShouldEmbeddedFramesTryToReuseExistingProcess(
                frame_tree_node_->GetParentOrOuterDocument()
                    ->GetOutermostMainFrame())) {
      new_instance->set_process_reuse_policy(
          ProcessReusePolicy::kReusePendingOrCommittedSiteSubframe);
    }
  }
```
同文件 `:483-519` 是主 frame 的策略：
- `:488-491`：`kDisableProcessReuse` 一开，主 frame 的复用也被拦下；
- `:507-519`：主 frame 的复用本就排除 localhost / IP 与非 http(s)，所以应用页主 frame 从不复用，两个窗口的应用页主 frame 实测也在不同进程。

**b. 这个策略在整个 BrowserContext 里按 SiteInfo 找进程**
（`content/browser/renderer_host/render_process_host_impl.cc:6189-6215`；跟踪器定义见 `:665-670`、`:760-787`；Windows 上另有延迟关闭表，见 `:5083-5089`、`:6224-6238`）
```cpp
RenderProcessHost*
RenderProcessHostImpl::FindReusableProcessHostForSiteInstance(
    SiteInstanceImpl* site_instance,
    ProcessReusePolicy process_reuse_policy) {
  BrowserContext* browser_context = site_instance->GetBrowserContext();
  // 现状：pending / committed 两张表都挂在 BrowserContext 上、按 SiteInfo 建 map，
  //       不看 BrowsingInstance——主窗口宿主所在进程登记在「file:」下，壁纸窗口的宿主一查就命中
  SiteProcessCountTracker* pending_tracker =
      static_cast<SiteProcessCountTracker*>(
          browser_context->GetUserData(kPendingSiteProcessCountTrackerKey));
  // …
  SiteProcessCountTracker* committed_tracker =
      static_cast<SiteProcessCountTracker*>(
          browser_context->GetUserData(kCommittedSiteProcessCountTrackerKey));
  // …（Windows 上还会查延迟关闭表：重载后的壁纸宿主回到原进程）
}
```
`file:` 只算一个站点的依据：
- `content/browser/site_info.cc:938-958`：对 `file:` 跳过 host；
- `:1060-1077`：返回 `GURL(origin.scheme() + ":")`；
- `:578-581`：进程锁的比较键里也没有 BrowsingInstance。

非默认策略下，复用别的进程只有两条路，`GetProcessHostForSiteInstance` 从 `:5286` 开始：
- `:5353` 的 `FindEmptyBackgroundHostForReuse`：只拿完全没有 frame 的进程；
- `:5393` 的进程数上限：Windows 取不到系统上限时为 82，见 `:1475-1485`；实际值按物理内存折算再截断，见 `:1537-1557`。

**c. 钩子默认放行，CEF 没有覆盖**
```cpp
// content/public/browser/content_browser_client.cc:340-343
bool ContentBrowserClient::ShouldEmbeddedFramesTryToReuseExistingProcess(
    RenderFrameHost* outermost_main_frame) {
  return true;                                  // 现状：默认激进复用
}
// chrome/browser/chrome_content_browser_client.cc:2472-2479
bool ChromeContentBrowserClient::ShouldEmbeddedFramesTryToReuseExistingProcess(
    content::RenderFrameHost* outermost_main_frame) {
#if BUILDFLAG(ENABLE_EXTENSIONS_CORE)
  return ChromeContentBrowserClientExtensionsPart::        // 现状：只有扩展页面（非 hosted app）里的子 frame 返回 false
      ShouldEmbeddedFramesTryToReuseExistingProcess(outermost_main_frame);
#else
  return true;
#endif
}
```
```cpp
// third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.h（已带 01–07，与构建树一致）
  // Kabegame: adds a file: URLLoaderFactory for subresources of the app page
  // (outermost main frame, non-popup browser created with the bool extra_info
  // key "kabegame.allow_local_resources"). See the .cc for details.
  void RegisterNonNetworkSubresourceURLLoaderFactories(
      int render_process_id,
      int render_frame_id,
      const std::optional<url::Origin>& request_initiator_origin,
      NonNetworkURLLoaderFactoryMap* factories) override;
  // 现状：没有 ShouldEmbeddedFramesTryToReuseExistingProcess / IsSuitableHost / MayReuseHost 等复用钩子的覆盖
```

**d. 同一窗口里同站点必然同一个 SiteInstance**（`content/browser/browsing_instance.cc:128-135`）
```cpp
scoped_refptr<SiteInstanceImpl> BrowsingInstance::GetSiteInstanceForURLHelper(
    const UrlInfo& url_info,
    bool allow_default_instance) {
  const SiteInfo site_info = ComputeSiteInfoForURL(url_info);
  auto i = site_instance_map_.find(site_info);
  if (i != site_instance_map_.end()) {
    return i->second.get();               // 现状：预览宿主与应用背景宿主拿到同一个 SiteInstance → 同一个进程
  }
  // …
```

**e. 每个 widget 每帧跑一遍整页的 rAF**
```cpp
// third_party/blink/renderer/core/frame/web_frame_widget_impl.cc:2633-2663
void WebFrameWidgetImpl::BeginMainFrame(const viz::BeginFrameArgs& args) {
  base::TimeTicks last_frame_time = args.frame_time;
  // …（animation_frame_timing_monitor_、RecomputeMouseHoverStateIfNeeded、ukm_timer）
  GetPage()->Animate(last_frame_time);   // 现状：每个 local root 的 widget 每帧都调整页的 Animate
  // Animate can cause the local frame to detach.
  if (!LocalRootImpl())
    return;
  GetPage()->GetValidationMessageClient().LayoutOverlay();
}
// 同文件 :1678-1688
void WebFrameWidgetImpl::DidBeginMainFrame() {
  LocalFrame* local_root_frame = LocalRootImpl()->GetFrame();
  // …
  if (Page* page = local_root_frame->GetPage()) {
    page->Animator().PostAnimate();      // 现状：按整页解锁动画时钟
  }
}
// third_party/blink/renderer/core/page/page.cc:1540-1548
void Page::Animate(base::TimeTicks monotonic_frame_begin_time) {
  GetAutoscrollController().Animate();
  Animator().ServiceScriptedAnimations(monotonic_frame_begin_time);
  GetValidationMessageClient().ServiceScriptedAnimations(
      monotonic_frame_begin_time);
}
```
```cpp
// third_party/blink/renderer/core/page/page_animator.cc:41-52、66-76
DocumentsVector GetAllDocuments(Frame* main_frame) {
  DocumentsVector documents;
  // 现状：从（可能是 RemoteFrame 的）主 frame 起前序遍历，收本进程里该页面的**全部** LocalFrame，
  //       包括属于其它 local root（其它 widget）的文档
  for (Frame* frame = main_frame; frame; frame = frame->Tree().TraverseNext()) {
    if (auto* local_frame = DynamicTo<LocalFrame>(frame)) { /* emplace (document, can_throttle) */ }
  }
  return documents;
}
void PageAnimator::ServiceScriptedAnimations(
    base::TimeTicks monotonic_animation_start_time) {
  base::AutoReset<bool> servicing(&servicing_animations_, true);
  Clock().SetAllowedToDynamicallyUpdateTime(false);
  Clock().UpdateTime(monotonic_animation_start_time);
  DocumentsVector documents = GetAllDocuments(page_->MainFrame());   // 现状：整页
  // …逐文档更新 AnimationClock、ServiceScrollAnimations，收集 controllers，
  //   调静态 ServiceScriptedAnimations(time, controllers) 依次跑 pagereveal / autofocus / resize / scroll /
  //   媒体查询 / 动画事件 / RunTasks / rVFC / rAF（ExecuteFrameCallbacks）
}
// :314-328
void PageAnimator::PostAnimate() {
  if (!next_frame_has_pending_raf_) {
    Clock().SetAllowedToDynamicallyUpdateTime(true);
    DocumentsVector documents = GetAllDocuments(page_->MainFrame());   // 现状：整页解锁
    for (const auto& [document, can_throttle] : documents) {
      document->GetAnimationClock().SetAllowedToDynamicallyUpdateTime(true);
    }
  }
  next_frame_has_pending_raf_ = false;
}
```
事件与回调队列都是取空式的，会重复执行的只有在回调里重新登记的 rAF：
```cpp
// third_party/blink/renderer/core/dom/scripted_animation_controller.cc:127-131、176-183
bool ScriptedAnimationController::DispatchEvents(DispatchFilter filter) {
  HeapVector<Member<Event>> events;
  if (filter.is_null()) {
    events.swap(event_queue_);           // 现状：resize / scroll / 动画事件第一轮就取空，第二轮无事可做
  // …
void ScriptedAnimationController::ExecuteFrameCallbacks() {
  if (!GetExecutionContext())
    return;
  callback_collection_.ExecuteFrameCallbacks(current_frame_time_ms_,      // 现状：第一轮回调里重新登记的 rAF
                                             current_frame_legacy_time_ms_); //       在同一帧的下一轮被再跑一次
}
```
文档请求帧时只请求自己 local root 的 widget：
```cpp
// third_party/blink/renderer/core/page/chrome_client_impl.cc:565-578
void ChromeClientImpl::ScheduleAnimation(const LocalFrameView* frame_view,
                                         base::TimeDelta delay,
                                         bool urgent) {
  LocalFrame& frame = frame_view->GetFrame();
  FrameWidget* widget = frame.GetWidgetForLocalRoot();   // 现状：文档只请求自己 local root 的 widget
  if (widget) {
    widget->RequestAnimationAfterDelay(delay, urgent);
  }
}
```
帧标志的用处只有两个：
- cc 的帧序列指标：`cc/trees/client_layer_tree_host_impl.cc:248-256`、`cc/trees/layer_tree_host_impl.cc:2752-2760`；
- `PostAnimate` 判断要不要解锁时钟。

**f. Chromium 侧改动的承载方式**（以补丁 03 为例）
```diff
# third-patches/cef/03-drag-source-filenames.patch 里的外层 hunk：给 patch.cfg 追加一条，并新建内层补丁文件
diff --git a/patch/patch.cfg b/patch/patch.cfg
@@ -895,5 +895,11 @@ patches = [
     'name': 'kabegame_flat_subprocess_path',
+  },
+  {
+    # kabegame: let WebContentsViewDelegate turn a renderer-initiated drag into …
+    'name': 'kabegame_drag_source_filenames',
   }
 ]
diff --git a/patch/patches/kabegame_drag_source_filenames.patch b/patch/patches/kabegame_drag_source_filenames.patch
new file mode 100644
```
```python
# 构建树 cef/tools/git_util.py:176-197（patcher.py 经 gclient_hook 在每次构建时对 patch.cfg 逐条调用）
  config = '-p0 --ignore-whitespace'
  # Reverse check to see if the patch has already been applied.
  cmd = '%s apply %s --reverse --check' % (git_exe, config)   # 现状：已应用 → "already applied (skipping)"
  # Normal check to see if the patch can be applied cleanly.
  cmd = '%s apply %s --check' % (git_exe, config)             # 现状：不能干净应用 → 构建失败
```
上次构建日志 `D:\Codes\cefbuild\build.log:1773-1780` 里有：
- `Apply kabegame_flat_subprocess_path.patch … already applied (skipping)`；
- `Apply kabegame_drag_source_filenames.patch`。

CEF 自带补丁也改 `web_frame_widget_impl.cc`：
```diff
# 构建树 cef/patch/patches/views_widget.patch（上游 CEF，内层补丁无 a/ b/ 前缀）
diff --git third_party/blink/renderer/core/frame/web_frame_widget_impl.cc third_party/blink/renderer/core/frame/web_frame_widget_impl.cc
@@ -5534,6 +5534,7 @@ void WebFrameWidgetImpl::OnWindowShowStateChanged(
     case WindowShowState::kFullscreen:
+    case WindowShowState::kHidden:
     case WindowShowState::kEnd:
```

**g. 实测现状**（2026-11-02，dev，Windows，144 Hz）

| 项 | 值 |
| --- | --- |
| 进程分布（`frames_pids3.mjs`） | 三个宿主都在 pid 29500（`--renderer-client-id=7`）；主窗口应用页 10692、壁纸窗口应用页 31804；另有一个没有 frame 的 renderer 11136，推断为 spare |
| 内存（私有） | 宿主进程 211 MB（三个宿主，其中主窗口两个处于 hidden）；空进程 15.9 MB；壁纸应用页进程 50 MB |
| rAF（`rafcount.mjs`） | 主窗口两个宿主各 288.5 次/秒，不同时间戳 144.5 个/秒；壁纸窗口唯一的宿主 144.5；两个应用页主 frame 144.5 |

## 点 1 — CEF 补丁 08：子 frame 不再跨 browser 复用同站点进程（`third/cef` → `third-patches/cef/08-no-embedded-frame-process-reuse.patch`）

- **修改** `third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.h`：紧跟 `RegisterNonNetworkSubresourceURLLoaderFactories` 的声明之后加覆盖。
```cpp
  void RegisterNonNetworkSubresourceURLLoaderFactories(
      int render_process_id,
      int render_frame_id,
      const std::optional<url::Origin>& request_initiator_origin,
      NonNetworkURLLoaderFactoryMap* factories) override;
  // Kabegame: embedded frames never reuse a same-site renderer process of        // 新增
  // another browser (always returns false). See the .cc for details.             // 新增
  bool ShouldEmbeddedFramesTryToReuseExistingProcess(                             // 新增
      content::RenderFrameHost* outermost_main_frame) override;                   // 新增
```
- **修改** `third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.cc`：在 `RegisterNonNetworkSubresourceURLLoaderFactories` 的定义之后、`WillCreateURLLoaderFactory` 之前加实现。
```cpp
bool ChromeContentBrowserClientCef::ShouldEmbeddedFramesTryToReuseExistingProcess(  // 新增
    content::RenderFrameHost* outermost_main_frame) {
  // Kabegame: a new SiteInstance of an embedded frame that needs a dedicated
  // process gets kReusePendingOrCommittedSiteSubframe unless this returns false
  // (RenderFrameHostManager::GetSiteInstanceForNavigation). That policy joins
  // any process of the BrowserContext already hosting the same site, across
  // BrowsingInstances, and every file: URL is one site, so a hung file: iframe
  // in one browser froze the file: iframes of every other browser. Returning
  // false for every browser keeps the default policy for embedded frames:
  // frames of one BrowsingInstance still share their SiteInstance's process,
  // but they no longer join a process of another browser. Chrome's base
  // implementation returns false only for frames inside extension pages; an
  // unconditional false covers that case. Unlike the DisableProcessReuse
  // feature, this leaves main-frame process reuse
  // (GetProcessReusePolicyForMainFrame) untouched.
  return false;
}
```
  > 说明：
  > - 只改 `//cef`，没有 `patch.cfg`、公共 API、C API、胶水或 `extra_info` 键的变化，也不需要 Rust 侧配合。
  > - 04 / 06 也改这两个文件，按序列叠加，hunk 不重叠。
  > - 参数 `outermost_main_frame` 不用，保留覆盖签名即可。若编译器对未用参数告警，按 Chromium 惯例去掉形参名，或写成 `content::RenderFrameHost* /*outermost_main_frame*/`。

## 点 2 — Blink 去重：每个 widget 只服务自己 local root 的文档（Chromium 内层补丁 → `third-patches/cef/09-raf-local-root-only.patch`）

**两种改法对比**

| 项 | (a) `AnimateForLocalRoot`：只服务本 widget 控制的文档 | (b) 按帧时间记账：同一 `frame_time` 已服务过的 controller 跳过 |
| --- | --- | --- |
| rAF 次数 | 每文档每帧一次 | 帧时间相同才去重；同页各 widget 的 `frame_time` 一旦不同（节流、不同 BeginFrame）仍会重复 |
| 在哪个任务里跑 | 文档自己的 widget 的 BeginMainFrame，与请求帧的 widget 一致（`ScheduleAnimation` 只请求自己的 widget） | 本帧第一个跑到的 widget，可能是别的 local root |
| 隐藏 / 节流的 OOPIF | 自己的 widget 不出帧就不跑，与独占进程时一致 | 仍被同进程兄弟 widget 带着跑 rAF、派发 resize（现状的泄漏保留） |
| resize / scroll / 媒体查询 / 动画事件 / RunTasks / rVFC | 队列都是取空式，次数不变（本来就只在第一轮派发），只换成在自己 widget 的任务里派发 | 不变 |
| view transition（pagereveal） | 每文档一次，激活在本 widget 的这一轮，不变 | 不变 |
| IntersectionObserver | 不在这条流程里（各 local root 生命周期内计算，通知走任务），不受影响 | 同左 |
| Web Animations 时钟 | 本 widget 的文档在自己这一轮 `UpdateTime`，紧接着本 widget 的生命周期更新动画，前后一致 | 跳过的文档仍得每轮更新时钟，否则时钟停在别的 widget 那一轮 |
| `SetCurrentFrameHadRaf` / `SetNextFrameHasPendingRaf` | 只反映本 widget 的文档，经 `ReportFrameAnimations` 报给本 widget 的 cc，准确 | 记在第一个 widget 上，后面的 widget 报「本帧无 rAF」（只影响 cc 帧序列指标） |
| `PostAnimate` 解锁时钟 | 同步改为只解锁本 widget 的文档，不会因别的 widget 没有 rAF 而解锁本 widget 的时钟 | 不变（整页） |
| 新状态 | 无，纯筛选 | `PageAnimator` 里一张 `WeakMember<ScriptedAnimationController> → TimeTicks` 表，要 Trace |
| 漏帧 | 每个 LocalFrame 恰好属于一个 local root；文档只请求、只靠自己的 widget，widget 不存在或不出帧时等下一次调度，与跨进程 OOPIF 相同 | 不会漏 |
| 主 frame 与 OOPIF 同进程混合（A-B-A） | 主 frame 的 widget 只服务主 frame 的 local 子树，同进程的孙级 local root 由自己的 widget 服务；没有文档同时落在两个集合，也没有文档不落在任何集合 | 第一个 widget 服务全部 |
| 改动文件 | `page_animator.h` / `.cc` + `web_frame_widget_impl.cc`（后者 CEF `views_widget.patch` 也改，生成方法见点 3） | 只有 `page_animator.h` / `.cc` |

**选 (a)。**
- (b) 唯一的优势是不碰 `web_frame_widget_impl.cc`，但它有三个问题：
  - 保留了跨 widget 的耦合与上面说的泄漏；
  - 帧标志报错地方；
  - 依赖「同帧时间相等」，而这一点没有保证。
- (a) 的代价是内层补丁要按 `views_widget` 之后的状态生成，点 3 有固定做法。
- 主 frame 与 OOPIF 同进程的混合情形在本应用里不存在：应用页主 frame 与 `file:` 子 frame 永远不同站点、不同进程。它只会出现在畅游 / 爬虫的第三方页面里，09 对这些页面同样生效（已定 3）。

- **修改** `third_party/blink/renderer/core/page/page_animator.h`
```cpp
  void ServiceScriptedAnimations(
      base::TimeTicks monotonic_animation_start_time);
  // Kabegame: Page::Animate() for one frame widget. Runs the same steps but         // 新增
  // services only the documents |local_root|'s widget controls (|local_root| and   // 新增
  // its local descendants). Called from WebFrameWidgetImpl::BeginMainFrame.        // 新增
  void AnimateForLocalRoot(base::TimeTicks monotonic_frame_begin_time,             // 新增
                           LocalFrame& local_root);                                // 新增
  // Invokes callbacks, dispatches events, etc. The order is defined by HTML:
  // https://html.spec.whatwg.org/C/#event-loop-processing-model
  static void ServiceScriptedAnimations(
      base::TimeTicks monotonic_time_now,
      const ControllersVector& documents_vector);
  // Kabegame: with |local_root|, only unlocks the clocks of the documents that    // 新增
  // widget controls.                                                               // 新增
  void PostAnimate(LocalFrame* local_root = nullptr);                               // 修改：加可选参数
  // …
 private:
  // Body of ServiceScriptedAnimations(base::TimeTicks) for |documents|.           // 新增
  void ServiceScriptedAnimationsForDocuments(                                       // 新增
      base::TimeTicks monotonic_animation_start_time,
      const DocumentsVector& documents);
  Member<Page> page_;
```
- **修改** `third_party/blink/renderer/core/page/page_animator.cc`
```cpp
#include "third_party/blink/renderer/core/page/autoscroll_controller.h"   // 新增（AnimateForLocalRoot 用）

namespace {
// GetAllDocuments(Frame* main_frame) 不变

// Kabegame: the documents a frame widget controls: |frame| (a local root on the  // 新增
// first call) and its local descendants, in the same tree order as
// GetAllDocuments(). A RemoteFrame child ends the walk: frames below it belong to
// another local root (another widget, maybe another process). Mirrors
// ForEachLocalFrameControlledByWidget() in web_frame_widget_impl.cc.
void CollectWidgetDocuments(LocalFrame& frame, DocumentsVector& documents) {
  Document* document = frame.GetDocument();
  bool can_throttle =
      document->View() && document->View()->CanThrottleRendering();
  documents.emplace_back(std::make_pair(document, can_throttle));
  for (Frame* child = frame.FirstChild(); child; child = child->NextSibling()) {
    if (auto* local_child = DynamicTo<LocalFrame>(child)) {
      CollectWidgetDocuments(*local_child, documents);
    }
  }
}
}  // namespace

void PageAnimator::ServiceScriptedAnimations(                                       // 修改：只剩转调
    base::TimeTicks monotonic_animation_start_time) {
  ServiceScriptedAnimationsForDocuments(monotonic_animation_start_time,
                                        GetAllDocuments(page_->MainFrame()));
}

void PageAnimator::AnimateForLocalRoot(base::TimeTicks monotonic_frame_begin_time,  // 新增
                                       LocalFrame& local_root) {
  DCHECK(local_root.IsLocalRoot());
  // Same steps as Page::Animate(); keep in sync. Only the document set differs.
  page_->GetAutoscrollController().Animate();
  DocumentsVector documents;
  CollectWidgetDocuments(local_root, documents);
  ServiceScriptedAnimationsForDocuments(monotonic_frame_begin_time, documents);
  page_->GetValidationMessageClient().ServiceScriptedAnimations(
      monotonic_frame_begin_time);
}

void PageAnimator::ServiceScriptedAnimationsForDocuments(                           // 新增：原函数体
    base::TimeTicks monotonic_animation_start_time,
    const DocumentsVector& documents) {
  // 原 ServiceScriptedAnimations(base::TimeTicks) 的函数体原样搬来，只删掉
  // `DocumentsVector documents = GetAllDocuments(page_->MainFrame());` 这一行（改由参数传入）；
  // AutoReset、Clock()、逐文档时钟、ServiceScrollAnimations、SyncScrollAttemptHeuristic(page_->MainFrame())、
  // 静态 ServiceScriptedAnimations(time, controllers)、LayoutOverlay() 全部不动。
}

void PageAnimator::PostAnimate(LocalFrame* local_root) {                            // 修改
  if (!next_frame_has_pending_raf_) {
    Clock().SetAllowedToDynamicallyUpdateTime(true);
    DocumentsVector documents;                                                      // 修改：按 widget 收窄
    if (local_root) {
      CollectWidgetDocuments(*local_root, documents);
    } else {
      documents = GetAllDocuments(page_->MainFrame());
    }
    for (const auto& [document, can_throttle] : documents) {
      document->GetAnimationClock().SetAllowedToDynamicallyUpdateTime(true);
    }
  }
  next_frame_has_pending_raf_ = false;
}
```
  > 说明：
  > - `ServiceScriptedAnimations(base::TimeTicks)` 的其它调用方行为不变：SVG 图片自己的 Page、校验消息浮层、`WebPagePopupImpl` 的 `Page::Animate`，它们各自都是只有一个 local root 的页面。
  > - `GetAnimations(TreeScope&)`（`document.getAnimations()`）照旧整页。
- **修改** `third_party/blink/renderer/core/frame/web_frame_widget_impl.cc`
```cpp
void WebFrameWidgetImpl::BeginMainFrame(const viz::BeginFrameArgs& args) {
  // …前面不变
  // Kabegame: Page::Animate() walks every local frame of the page in this          // 新增
  // renderer, so with N local roots of one page in this process (e.g. N same-site
  // OOPIFs) every document ran its animation frame callbacks N times per frame.
  // Service only the documents this widget controls; the other local roots are
  // serviced by their own widgets, which their documents schedule.
  GetPage()->Animator().AnimateForLocalRoot(last_frame_time,                         // 修改：原为 GetPage()->Animate(last_frame_time);
                                            *LocalRootImpl()->GetFrame());
  // Animate can cause the local frame to detach.
  if (!LocalRootImpl())
    return;

  GetPage()->GetValidationMessageClient().LayoutOverlay();
}

void WebFrameWidgetImpl::DidBeginMainFrame() {
  LocalFrame* local_root_frame = LocalRootImpl()->GetFrame();
  // …
  if (Page* page = local_root_frame->GetPage()) {
    page->Animator().PostAnimate(local_root_frame);                                  // 修改：传 local root
  }
}
```
- **新增**（`third/cef`）`patch/patches/kabegame_raf_local_root_only.patch`：上面三个文件的内层补丁，`-p0` 路径、无 `a/` `b/` 前缀、LF 行尾。生成方法见点 3。
- **修改**（`third/cef`）`patch/patch.cfg`：在 `kabegame_drag_source_filenames` 条目之后追加：
```python
  {
    # kabegame: drag-source filenames …（03 的条目，不变）
    'name': 'kabegame_drag_source_filenames',
  },
  {                                                                                  # 新增
    # kabegame: each frame widget's BeginMainFrame services only the documents of
    # its own local root, so N same-process OOPIFs of one page no longer run every
    # document's animation frame callbacks N times per frame.
    # web_frame_widget_impl.cc is also modified by views_widget.patch; this patch
    # is relative to that state. Do not resave it with patch_updater.py.
    'name': 'kabegame_raf_local_root_only',
  }
]
```

## 点 3 — 补丁生成、预检与重编

补丁的生成与预检都由 Claude 在沙箱外执行：Windows 沙箱里跑不了 `deno task patch --gen/--check`，也写不了构建树。CEF 重编由用户执行（已定 4）。

**08**（前提：`third/cef` 工作树恰为 01–07）
```bash
deno task patch cef --gen --from 07                 # 输出必须为空：工作树没有系列之外的残留，否则先停下
# codex 按点 1 改 third/cef 的两个文件
deno task patch cef --gen --from 07 --out third-patches/cef/08-no-embedded-frame-process-reuse.patch
deno task patch cef --check                          # 01–08 在一次性 worktree 里链式预检
deno task patch cef                                  # reset + 重新应用 01–08；git -C third/cef status 仍是 01–07 的那些文件（两个文件本来就是 M）
```

**09 的内层补丁**：在 `ignore/` 里改副本，以「上游 + CEF 补丁」的状态为底出 diff，不动构建树。
```bash
SRC=D:/Codes/cefbuild/chromium_git/chromium/src
W=ignore/p3-0c/blink
F1=third_party/blink/renderer/core/page/page_animator.h
F2=third_party/blink/renderer/core/page/page_animator.cc
F3=third_party/blink/renderer/core/frame/web_frame_widget_impl.cc
# 1. 取底稿：构建树里这三个文件就是「上游 + 全部 CEF 补丁」（F3 含 views_widget 的一行），F1 / F2 没有被任何补丁改过
git -C $SRC status --short -- $F1 $F2 $F3            # 预期：只有 F3 为 M
for f in $F1 $F2 $F3; do mkdir -p $W/base/$(dirname $f) $W/work/$(dirname $f); cp $SRC/$f $W/base/$f; cp $SRC/$f $W/work/$f; done
# 2. codex 按点 2 改 $W/work/ 下的三个文件
# 3. 逐文件出 -p0 diff 并拼接（diff 退出码 1 表示有差异，属正常）
for f in $F1 $F2 $F3; do diff -u --label $f --label $f $W/base/$f $W/work/$f; done \
  > third/cef/patch/patches/kabegame_raf_local_root_only.patch
grep -c $'\r' third/cef/patch/patches/kabegame_raf_local_root_only.patch   # 预期 0
# 4. 在构建树上正向干跑：应当能干净应用（构建时 patcher.py 也是这么判的）
git -C $SRC apply -p0 --ignore-whitespace --check "$PWD/third/cef/patch/patches/kabegame_raf_local_root_only.patch"
```
  > 说明：
  > - 不用 `git diff` / `patch_updater.py --resave`：对 F3 它们都以 `HEAD` 为底，会把 `views_widget` 的 hunk 收进来。
  > - 这一步不在构建树里预改文件，留给构建时的 `patcher.py` 正向应用，顺带走一遍真实构建路径。
  > - 以后要改 09 的内容：
  >   1. 先在构建树里 `git -C $SRC apply -p0 -R <旧内层补丁>` 撤回。F1 / F2 也可以 `git checkout --`；F3 只能用 `-R`，checkout 会把 `views_widget` 的改动一起丢掉。
  >   2. 再按上面的步骤重出。

**09 的外层补丁**
```bash
# codex 已按点 2 在 third/cef/patch/patch.cfg 追加条目；内层补丁文件由上一步写好
deno task patch cef --gen --from 08 --out third-patches/cef/09-raf-local-root-only.patch
deno task patch cef --check                          # 01–09
deno task patch cef                                  # git -C third/cef status：比 01–08 多 ?? patch/patches/kabegame_raf_local_root_only.patch
deno task patch cef --gen --from none --out ignore/p3-0c/all.patch   # 并集核对：文件 = 01–09 涉及文件的并集，含 3 个 new file（三个 kabegame 内层补丁）
```

**重编**：用户在 MSYS2 里执行，命令与顺序见步骤 3。
- 流程：
  1. `stageCefPatchesAsCommit` 把工作树固化到 `kabegame-build`；
  2. automate 判定 cef 变了，整树重拷 `src/cef`，mtime 保全会中和内容未变的文件；
  3. `gclient_hook` 跑 `patcher.py`：前面的补丁跳过，`kabegame_raf_local_root_only` 正向应用；
  4. ninja 重编；
  5. 导出到 `bin/windows/x86_64/cef-build`：先删旧目录，再改名换入。
- 耗时估计：上次只改 `//cef` 的 07，ninja 约 6.6 分钟，其中 `libcef.dll` 链接约 80 s。本次多出 `chrome_content_browser_client_cef.cc`、约 22 个包含 `page_animator.h` 的 Blink 编译单元和 `web_frame_widget_impl.cc`。预计 ninja 10–20 分钟，加上同步、`make_distrib` 与导出，共约 20–35 分钟。
- 运行中的 dev 从 `target/debug/libcef.dll` 加载 DLL，但 `--resources-dir-path` 指向 `bin/windows/x86_64/cef-build`，`.pak` / `icudtl.dat` 被映射在内存里。导出时删这个目录，在 Windows 上可能因文件占用而失败，所以重编前先退出 dev。

## 点 4 — 文档

- **`third-patches/cef/README.md`**：Patches 清单追加两条，用英文，同现有体例。
  - `08-no-embedded-frame-process-reuse.patch`，要写：
    - 钩子名与触发点：`GetSiteInstanceForNavigation` 的 `kReusePendingOrCommittedSiteSubframe`，跨 BrowsingInstance，所有 `file:` 同站点；
    - 对所有 browser 无条件返回 false；
    - Chrome 基类只对扩展页面返回 false，已被涵盖；
    - 同一 browser 里同站点的子 frame 仍同进程；
    - 与 `DisableProcessReuse` feature 的区别：主 frame 的复用不受影响；
    - 只改 `//cef`，没有 API 或键。
  - `09-raf-local-root-only.patch`，要写：
    - 内层补丁名与三个文件；
    - `AnimateForLocalRoot` / `PostAnimate(local_root)` 的语义；
    - 与 `views_widget.patch` 共改 `web_frame_widget_impl.cc`，补丁以其应用后的状态为底，**不得**用 `patch_updater.py --resave`，以及要改内容时如何撤回；
    - 没有 CEF 侧改动，也不改 API。
- **`cocs/README.md`**：
  - `third-patches/cef/README.md` 条目：「现有七个 patch」改为「九个」，08 与 09 各补一句；适用场景加两条：「同一页面里 iframe 的 rAF 每帧回调多次」「两个窗口的 iframe 共用渲染进程」。
  - `wpe/WPE_SCENE.md` 条目：在「场景宿主」小项补一句「子 frame 不跨窗口复用渲染进程（CEF 08）、同进程 iframe 每帧一次 rAF（CEF 09）」。
- **`cocs/wpe/WPE_SCENE.md`**：
  - 第 340 行「进程隔离」改为现行事实：
    - 宿主是独立 OOPIF，保留忙等实测；
    - CEF 08 起子 frame 不跨窗口复用进程，两个窗口的 `file:` 子 frame 各一个进程，附实测 pid 分布；
    - 同一窗口里的宿主与网页壁纸仍同进程（同源、同 BrowsingInstance），预览宿主卡死会连带应用背景，但不影响桌面；
    - 卡死后的恢复见后续。
  - 第 328 行「rAF」：N 倍回调那段改成「CEF 09 之前的历史」；现行写「每个 widget 只服务自己 local root 的文档，同进程多个 iframe 每帧各一次」，附实测。保留「逐帧逻辑挂在渲染器的帧上」的建议。
  - 第 341 行「资源开销」：补拆分后两个 `file:` 进程各自的私有内存。
- **`AGENTS.md`**：进程模型表 `kabegame-cef-helper` 一行，在「`renderer`（每个 browser / 站点一个）」后补半句「子 frame 不跨 browser 复用 renderer（CEF 08，包括畅游与爬虫窗口里的第三方 iframe）」。
  - 理由：这是全局进程模型的事实，直接决定一个渲染进程卡死或被 `terminate()` 时波及哪些窗口，也会影响畅游 / 爬虫的进程数，排查时需要。
  - 改了 AGENTS 的约定，执行时 grep `.cursor/rules/` 有没有对应描述，有就同步。
- **`versions/latest/regression.md`**：在文件顶部、「场景宿主 P3-0b」之前新增小节「场景宿主 P3-0c：子 frame 不跨窗口复用进程与 rAF 去重」。
  - 内容：一段说明，写日期、两个补丁各做什么，以及前置条件「必须由用户重编 CEF 并完全重启 dev」；下面是「实施步骤与验收」的 S / B / D 行。
  - 同时在 P3-0b 的 D4 / D5 备注末尾加「→ P3-0c」。
- **`versions/latest/changelog.md`**：只写开发侧（已定 5）。在「开发侧 / Added」里 P3-0b 那一行之前加一行：
  > 场景宿主 P3-0c：CEF 补丁 08 让 `ChromeContentBrowserClientCef::ShouldEmbeddedFramesTryToReuseExistingProcess` 无条件返回 false，子 frame 不再跨 browser 复用同站点渲染进程（两个窗口的 `file:` 宿主 / 网页壁纸各自一个进程，畅游 / 爬虫的第三方 iframe 同样生效，主 frame 复用不变）；CEF 补丁 09（Chromium 内层 `kabegame_raf_local_root_only`）让每个 frame widget 只服务自己 local root 的文档，同一页面里多个同进程 iframe 的 rAF 不再每帧重复派发。
- **计划文件**：`PLAN.md` 的 P3-0 列表与 `phase-3-0-scene-host.md` 的总述链接、实测行都已指向本文件。实施完成后在本文件末尾加「实施记录」。

## 实施步骤与验收

每一步都能单独验收。分工：
- codex 只写仓库内文件；
- 标「沙箱外」的由 Claude 执行；
- 标「用户」的由用户执行。

独立验收时先 `git status` 查越界，不采信自报。本步没有 Rust 与前端改动，所以不跑 `check-kabegame` 和单测：08 / 09 都是 CEF / Chromium C++，只能由步骤 3 的构建来验证。

**步骤 0 — 准备与基线**（Claude，沙箱外）
1. 用 `git -C third/cef status --short` 和 `deno task patch cef --gen --from 07` 确认工作树恰为 01–07（diff 为空）。
2. 把会话 scratchpad 里的 `frames_pids3.mjs`、`rafcount.mjs` 拷到 `ignore/p3-0c/`。`ignore/` 是 gitignore 的；scratchpad 会随会话清掉。
   - 副本 `rafcount.mjs` 的过滤从 `href.includes("wpe-scene")` 放宽为 `href.startsWith("file:")`，把网页壁纸 iframe 也计入。
   - 两个脚本运行前都要 `export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`，端口用 `driver.sh port`。
   - `frames_pids3.mjs` 用页面级 tracing，会让 Chromium 拉起一个 `tracing.mojom.TracingService` utility 进程，无害。
   - `rafcount.mjs` 经 playwright 连接，会劫持下载；测完不要在同一个 dev 里测下载。
3. 测基线，输出存 `ignore/p3-0c/baseline-pids.txt`、`baseline-raf.txt`。
   - 需要的状态：主窗口可见，预览与应用背景都在显示场景，壁纸窗口在窗口模式下显示场景。
   - 当前不是这个状态就记未测，不去改用户的壁纸设置。
   - 顺带记下当前 renderer 进程总数。
4. 按点 3 取 Blink 底稿到 `ignore/p3-0c/blink/{base,work}/`。

**步骤 1 — CEF 08**（codex 按点 1 改 `third/cef/libcef/browser/chrome/chrome_content_browser_client_cef.{h,cc}`；Claude 生成与检查）

验收（沙箱外）：
- 按点 3 生成 08，`--check` 通过；
- `deno task patch cef` 后，`git -C third/cef status` 只有 01–08 涉及的文件；
- 08 的 diff 只有点 1 的两处 hunk，不含其它文件，也不含任何 `extra_info` 键。

**步骤 2 — Blink 去重补丁 09**（codex 按点 2 改 `ignore/p3-0c/blink/work/` 下的三个副本和 `third/cef/patch/patch.cfg`；Claude 出内层补丁与 09）

- codex 编不了 Blink，只能按点 2 的目标代码改。`ServiceScriptedAnimationsForDocuments` 的函数体必须逐字搬自原 `ServiceScriptedAnimations(base::TimeTicks)`，只删掉取文档的那一行。
- 验收（沙箱外）：
  - `diff -u base work` 只有点 2 列出的 hunk：F3 两处（`BeginMainFrame`、`DidBeginMainFrame`），F2 多一行 include；
  - 内层补丁无 CR，在构建树上 `git apply -p0 --ignore-whitespace --check` 通过；
  - `deno task patch cef --check`（01–09）与 `--gen --from none` 的并集核对通过；
  - `git -C D:/Codes/cefbuild/chromium_git/chromium/src apply -p0 --reverse --check cef/patch/patches/views_widget.patch` 仍通过，说明构建树没被动过，09 与 `views_widget` 不冲突。

**步骤 3 — 一次 CEF 重编**（用户执行；Claude 做重编前检查与重编后验收）

重编前，Claude 在沙箱外检查：
- `deno task patch cef --check` 通过；
- `deno task patch cef --gen --from 09` 输出为空，工作树没有系列外残留；
- 内层补丁在构建树上正向 `--check` 通过。

三项都过了再通知用户。

用户在 MSYS2 里按顺序执行。建议从 VS x64 Native Tools 环境启动 `msys2_shell.cmd -use-full-path`，同以往重编：
```bash
# 0. 完全退出正在运行的 dev（关掉应用窗口并结束 deno task dev）：导出要替换 bin/windows/x86_64/cef-build，
#    而运行中的应用映射着其中的 .pak / icudtl.dat
cd /d/Codes/kabegame
deno task patch cef                                   # 1. 重置 third/cef 并应用 01–09（stageCefPatchesAsCommit 只认工作树）
git -C third/cef status --short                       # 2. 核对：含 ?? patch/patches/kabegame_raf_local_root_only.patch
CEFBUILD=D:/Codes/cefbuild deno task build:chromium   # 3. 增量重编（--no-chromium-update --force-build --force-distrib），约 20–35 分钟
deno task dev -c kabegame                             # 4. 重编成功后重新启动 dev
```

重编后，Claude 验收：
- `D:\Codes\cefbuild\build.log` 里 `Apply kabegame_raf_local_root_only.patch` 之后不是 `failed to apply`；首次应当是正向应用，不是 `already applied`；
- mtime 保全输出的真实变更清单含 `chrome_content_browser_client_cef.cc` 与 `patch.cfg`；
- ninja 成功，`bin/windows/x86_64/cef-build/libcef.dll` 的修改时间更新；
- 重启 dev 后，`target/debug/libcef.dll` 与导出目录里的那份大小、哈希一致，说明新 runtime 已被加载；
- 在构建树上对内层补丁执行 `git apply -p0 --reverse --check` 通过，说明它真的应用了。

编译失败时：
1. Claude 修改 `ignore/p3-0c/blink/work/`；
2. 在构建树上 `git apply -p0 -R` 撤回旧的内层补丁；
3. 按点 3 重出内层补丁与 09；
4. 用户重跑步骤 3 的 1、3、4。

**步骤 4 — 真机验收**（重启 dev 后，Claude 经 CDP 只读测量；需要的窗口状态由用户摆好）

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| D1 进程分布 | `node ignore/p3-0c/frames_pids3.mjs <port>` | 壁纸宿主 pid ≠ 主窗口两个宿主的 pid；主窗口两个宿主同 pid（同窗口必然如此）；三者都 ≠ 两个应用页主 frame 的 pid；renderer 数比基线多 1（spare 可能浮动） |
| D2 重载不回流 | 如果有应用自身触发壁纸窗口重载的路径（换壁纸、看门狗）就顺带看，否则跳过 | 重载后壁纸宿主进入新 pid 或 spare，永远不等于主窗口宿主的 pid |
| D3 rAF 次数 | `node ignore/p3-0c/rafcount.mjs <port>`（主窗口可见，预览与应用背景都在显示场景） | 主窗口两个宿主 `callbacksPerSec` ≈ `distinctPerSec` ≈ 144.5；壁纸宿主 144.5；两个应用页主 frame 144.5（以显示器刷新率为准，±1） |
| D4 同 local root 的子 frame | 在一个宿主 frame 里经 CDP 建一个 `about:blank` 子 iframe，在其中跑同样的 2 s 计数，测完移除 | 144.5：同一 local root 下的 local 子 frame 照常每帧一次，没有漏帧 |
| D5 网页壁纸 | 主窗口应用背景是网页壁纸、预览是场景或另一张网页壁纸时跑 D3（当前不是这个设置就记未测） | 网页壁纸 iframe 144.5，按回调次数推进的动画不再快一倍 |
| D6 隐藏 / 恢复 | 用户最小化主窗口再恢复 | 隐藏期间主窗口宿主的 rAF 停止（与基线相同），恢复后回到 144.5；壁纸宿主始终 144.5 |
| D7 场景回归 | 三处画面（预览 / 应用背景 / 桌面）；宿主 `GPUQueue.submit` 次数；暂停与恢复 | 画面正常；每个宿主每秒约 60–62 次提交（与 P3-0b D2 相同）；暂停时 60 → 0，恢复后回到 60 |
| D8 内存 | `Win32_Process` 读两个 `file:` 进程的私有内存 | 记录数值，填进 WPE_SCENE.md「资源开销」与回归表；预期多一个进程约 20–60 MB |
| D9 畅游 / 爬虫（全局行为） | 开两个畅游窗口访问同一个带第三方 iframe（如嵌入视频或广告）的站点；用 `Target.getTargets` 加页面级 tracing 看两边同一第三方站点 iframe 的 pid；可选再开一个爬虫窗口 | 页面与动画正常；两个窗口里同站点的第三方 iframe 落在不同 pid（不再跨窗口复用），同一窗口内同站点 iframe 仍同 pid；记录 renderer 总数，远低于上限 82 |

**步骤 5 — 文档**（codex 按点 4 写；Claude 把步骤 0–4 的实测数值填进回归表与 WPE_SCENE.md，并核对文档与代码一致）

验收：
- 回归小节每行都有状态与备注；
- `cocs/README.md` 的两个条目与 README 清单一致；
- `grep -n "七个" cocs/README.md` 不再指 CEF 补丁数；
- AGENTS.md 与 `.cursor/rules/` 没有冲突。

提交（git 写操作）由 Claude 在用户确认后进行：`third-patches/cef/08`、`09` 与文档一起提交，`third/cef` 的 gitlink 不变。

## 风险与备注

- **08 全局生效**：畅游 / 爬虫窗口里的第三方 OOPIF 也不再跨窗口复用同站点进程。
  - 后果：同时开多个畅游窗口，或并发多个 `crawler-<task_id>` 窗口时，进程数会上升，每个多出来的 renderer 约 20–60 MB。
  - 进程数受渲染进程上限约束：Windows 取不到系统上限时为 82，实际值按物理内存折算再截断，见 `render_process_host_impl.cc:1475-1485`、`:1537-1557`。打满后 `IsProcessLimitReached` 会退回复用已有进程（`:5393`），那时子 frame 可能又跨窗口同进程。
  - 主 frame 的复用不受 08 影响：http(s) 主 frame 的 `kProcessPerSiteUpToMainFrameThreshold` 照旧，这也是不用 `DisableProcessReuse` 的原因。
  - 08 之后仍会复用的情况：`FindEmptyBackgroundHostForReuse`（只拿完全空的进程）与 spare 进程。两者都不会让两个窗口的活 frame 同进程。
- **09 全局生效**：畅游 / 爬虫窗口里的第三方页面同样按 widget 服务。
  - 对 A-B-A 结构的站点：同进程孙级 iframe 的 rAF 不再重复，隐藏的同进程 OOPIF 不再被兄弟 widget 带着跑。
  - 这与站点隔离下「各自独占进程」的语义一致，但偏离了 HTML 规范「同一事件循环的文档在同一次渲染更新里一起处理」的理想顺序。Chromium 对跨进程 iframe 本来就是这样。
- **两个补丁都不可开关**：回滚就是撤掉对应补丁、由用户重编。
- **内层补丁的维护**：`web_frame_widget_impl.cc` 被两个补丁共改。re-vendor CEF / Chromium 时，`views_widget` 的变化可能让 09 的上下文漂移，修法见点 3。CEF 的 `patch_updater.py --resave` 对 09 永远不能用。
- **卡死后的恢复没有改善**：08 只缩小了影响面，主窗口宿主卡死不再连累桌面。但渲染进程被 hang 处理 `terminate()` 后，iframe 不会自动重载，因为 `OnRenderProcessTerminated` 只在主 frame 的进程死亡时触发。见后续。
- **顺带发现**：`scripts/build-chromium.ts` 的 `listPatchedChromiumFiles` 用 `^\+\+\+ b\/` 去匹配，而 CEF 内层补丁都是无前缀格式，所以这个兜底快照实际是空的。本步不修，列入后续。

## 已定（2026-11-02 用户）

1. **08 与 09 分开**：保持两个补丁，功能独立、回滚独立。
2. **08 不分窗口，全局开**：`ShouldEmbeddedFramesTryToReuseExistingProcess` 对所有 browser 无条件返回 false。
   - 不设 `extra_info` 键，kbcef 与应用侧都没有登记，08 只改 `//cef`，没有 Rust 改动；
   - 补丁注释写明：Chrome 基类只对扩展页面返回 false，已被涵盖；
   - 不用 `DisableProcessReuse` feature，因为它还会关掉 http(s) 主 frame 的按站点复用。
3. **09 全局生效**：接受，包括畅游 / 爬虫里的第三方页面。
4. **CEF 重编由用户自己跑**：命令与顺序见步骤 3；重编前的检查与重编后的验收由 Claude 做。
5. **changelog 只写开发侧**，不加用户侧条目。

## 后续（范围外，不展开）

- **宿主卡死后的恢复**：
  - 渲染进程被 `on_render_process_unresponsive` 的 `terminate()` 杀掉后，iframe 不会自动重载；
  - 壁纸窗口没有输入，卡死的进程不会被标为 unresponsive，可能经空进程复用又被重载后的宿主接上；
  - 需要一个按 frame 结束进程的手段。
- **同一窗口内每个宿主一个进程**：即调查报告的方案 E，每个槽位一个自定义 scheme 源，要迁移资源读取、闸门与 capability。
- **第三方场景脚本放进宿主内的 Worker**：超时就 `terminate()`，作为进程之外的故障隔离。
- **`build-chromium.ts` 的 `listPatchedChromiumFiles` 前缀正则**。

## 实施记录（2026-11-03，Windows dev）

- **步骤 0–1**：基线测得三个宿主共用进程 29500；主窗口两个宿主 rAF 各约 288.5 / 289 次/秒，壁纸宿主 144.5 次/秒。开工前发现 `third/cef` 的注释仍用旧编号「patch 0005 / 0007」，重新应用 01–07 后生成 45 行的 08，01–08 检查通过，重应用后无残留。
- **步骤 2**：内层 `kabegame_raf_local_root_only.patch` 以「上游 + `views_widget.patch`」为底生成，156 行、无 CR；构建树正向检查与 `views_widget.patch` 反向检查均通过。生成 09 后，01–09 检查、重应用残留检查及并集核对通过；并集 23 个文件，含 3 个新建内层补丁。
- **步骤 3**：首次重编在链接 `bootstrapc.exe` 时因提交上限与 siso Local:24 并发触发 `LLVM ERROR: out of memory`，与补丁无关。用户裁定不改 `build-chromium.ts`；退出 dev 释放内存后重跑成功，`page_animator.obj` 23:24 编出、`libcef.dll` 23:29，运行时 DLL 与导出目录哈希一致，内层补丁在构建树上反向检查通过。
- **步骤 4**：新 DLL 下，壁纸宿主进程 61204 与主窗口两个宿主进程 74360 分开；换场景后没有回流，整窗重载未测。主窗口两个宿主、壁纸宿主及应用页均回到约 144.5 次 rAF/秒，local 子 frame 与网页壁纸也通过；vortex 预览每秒 60 次 GPU 提交，淡入的首次 rAF（930175 / 930176 ms）与 `live` 类出现（930177 ms）相隔 1–2 ms、之后无大于 40 ms 的间隔。
- **新现象**：透明度为 0 的宿主（退回预览图或仍在加载）现每秒仅 1.5–2 次 rAF，tracing 未见宿主主线程长任务；限流层级和修复前为何满速未查清，实测淡入未受影响。拆分后壁纸宿主进程私有 30 MB、主窗口宿主进程 84 MB；畅游单窗口多层 iframe 显示正常，但跨两个畅游窗口与爬虫窗口未测。
