# Phase 5.1 — GPU 路线收敛:dmabuf OSR → CEF 自建窗口

> 父:[phase5](cef-linux-runtime-phase5.md)。**本阶段最关键**——这是换 CEF 的初衷。
>
> **当前结论**:CPU 软件 OSR 对 kabegame 图库(大图 + 密集滚动 + 可能视频)
> 不够快,不能作为最终方案。GPU 必须启用。
>
> **2026-06-26 交互式结论**:`dmabuf` OSR 已收敛到 CEF/ANGLE 共享纹理
> readback 全 0,短期继续挖同步/ownership 成本高;切到 **路线 A:CEF 自建
> 顶层窗口 + GPU**。该路线已用 `minimal_windowed` 证明可显示、可交互、
> 可滚动、可点击、可关闭退出。

## 现状锚点
**软件 OSR**(`runtime.rs:446`)
```rust
cl.append_switch(Some(&CefString::from("disable-gpu")));
cl.append_switch(Some(&CefString::from("disable-gpu-compositing")));  // 现状:CPU 光栅
```
渲染链:CEF CPU 光栅 → `on_paint` 整帧 BGRA(CPU)→ `webview.rs` softbuffer
逐像素 blit(CPU)。这个路径可作为保底显示路径,但不再投入主线性能优化。

**GPU OSR 复现基线**(`examples/minimal_gpu.rs`)
- 已启用 `shared_texture_enabled = 1`、`external_begin_frame_enabled = 1`。
- 已强制 `--ozone-platform=x11`、`--use-angle=vulkan`、`--enable-features=Vulkan`。
- 已确认 `on_accelerated_paint` 连续回调、cef-rs Vulkan dmabuf `import_texture`
  返回 OK、GPU 进程不崩。
- 当前失败点:导入纹理作为 wgpu sampled texture 上屏后为黑。

## 点 1 — dmabuf 黑屏根因收敛(已暂停)
**已知怀疑点**:`cef/src/osr_texture_import/dmabuf.rs` 创建外部 VkImage 后直接交给
wgpu:
- **CEF shared handle 生命周期**:CEF 文档说明 `on_accelerated_paint` 的 handle
  每帧可能不同,不能缓存,不能在回调外访问;回调返回后资源会归还给池。当前
  `minimal_gpu.rs` 把 imported texture 包成 bind group 后在回调外 `render()`
  采样,这本身可能就是黑屏根因。正确方向应是在回调内 reopen/import 后 copy
  到应用自有 texture,再在回调外采样自有 texture。
- `VkImageCreateInfo` 没显式处理 imported dmabuf 的当前 layout。
- 没有从 `VK_QUEUE_FAMILY_FOREIGN_EXT` acquire ownership。
- 没有等待 CEF/ANGLE 写入完成的跨进程 / 跨队列同步对象。
- wgpu 首次使用纹理时可能按 `UNDEFINED` 处理并丢弃既有内容,在 NVIDIA 上表现为黑屏。

**第一轮任务**
- [x] 给 `minimal_gpu.rs` 增加诊断:打印 `AcceleratedPaintInfo` 的 format、modifier、
  size、plane_count、每个 plane 的 fd/stride/offset,确认导入参数稳定且非空。
- [x] 在 shader / bind group 层排除合成错误:用固定颜色、测试纹理、导入纹理三种模式切换,
  确认 wgpu surface、pipeline、采样器和 UV 没问题。
- [x] 检查 cef-rs dmabuf 导入器的实际 Vulkan 调用,列出必须 patch 的最小集合:
  external memory import、DRM modifier、layout transition、foreign queue-family acquire、
  同步等待。
- [x] 验证 CEF shared handle 生命周期问题:把 imported dmabuf 在
  `on_accelerated_paint` 回调内 copy 到应用自有 wgpu texture,再采样自有 texture。
- [x] 增加 raw Vulkan dmabuf readback:外部 memory import、DRM modifier explicit layout、
  dedicated allocation、memory fd properties、queue family/layout matrix 后仍 `nonzero=0`。
- [x] 暂停 patch 落点判断:没有 sync fd/fence 信息时继续投入不可控。

**产出**
- 一份"黑屏发生在哪一层"的结论:
  - CEF/ANGLE 没写内容;
  - CEF shared handle 生命周期违规;
  - dmabuf import 参数/格式错误;
  - Vulkan layout/ownership/sync 错;
  - wgpu 合成层错。
- 当前结论:wgpu surface / shader / test texture 均正常;CEF accelerated paint 回调
  与 cef-rs Vulkan importer 都返回 OK;但 raw Vulkan 读回全 0。短期不把 dmabuf
  作为主线。

## 点 2 — CEF 自建顶层窗口 + GPU(当前主线)
**已验证**
- `examples/minimal_windowed.rs` 走 `browser_view_create` + `window_create_top_level`,
  不使用 OSR、softbuffer、dmabuf。
- `--ozone-platform=x11`、`--no-sandbox`、`--use-angle=vulkan`、
  `--enable-features=Vulkan` 下能正常显示。
- `CEF_WINDOWED_PUMP=external` + GLib `MainContext` 迭代后,文字选择、滚动、
  按钮点击、关闭退出均正常。

**关键经验**
- CEF Views 自建窗口不能只靠固定周期 `cef::do_message_loop_work()`。
- Linux external pump 必须同时驱动 GLib/X11 事件队列;否则会出现显示正常但
  鼠标拖选等交互不完整。

**下一轮任务**
- [ ] 设计纯 CEF/GLib runtime loop:用 CEF Views `Window` 作为真实窗口,
  不再把 tao 作为 Linux CEF backend 的窗口基座。
- [ ] 设计 runtime 接入方式:把 CEF window delegate 包装成 Tauri runtime window,
  保留必要的 dispatcher/state 表,但窗口操作直接落到 CEF Views。
- [ ] 明确窗口 API 映射范围:位置、尺寸、标题、显示/隐藏、关闭、focus、fullscreen、
  menu/tray/monitor 相关能力哪些能保持,哪些需要降级。
- [ ] 明确 webview API 映射范围:URL、eval、IPC、protocol、page-load、devtools。

## 点 3 — 修 dmabuf 导入路径(暂缓)
**方向**
- 建立 patched importer,不要直接依赖 cef-rs 当前 `SharedTextureHandle::import_texture`
  的黑盒行为。
- 导入后的内容必须在 `on_accelerated_paint` 回调返回前 copy 到应用自有 texture;
  runtime 持有和采样的应是自有 texture,不是 CEF pooled handle。
- 创建 VkImage 时保留 DRM format modifier / plane layout / external memory 语义。
- 在采样前显式提交一次 barrier:
  - queue family: `VK_QUEUE_FAMILY_FOREIGN_EXT` → wgpu graphics queue family。
  - layout: imported/current layout → `SHADER_READ_ONLY_OPTIMAL`。
  - access mask / stage mask 与 external write → fragment shader sample 匹配。
- 若 CEF 暴露 fence/semaphore FD 或 sync fd,纳入等待;若没有,先确认 CEF 回调时机是否已保证
  content ready,并记录驱动风险。

**验收**
- `examples/minimal_gpu.rs` 不再黑屏,能显示页面内容。
- resize / 持续 begin-frame / 页面动画稳定。
- 无 GPU process crash,无 wgpu validation error。

## 点 4 — 接入 runtime 窗口层
前提:点 2 的 CEF 自建窗口 + external GLib pump 已验证通过。

- runtime 初始化不再强制 `windowless_rendering_enabled = 1` 作为唯一主路径。
- 运行期开关从 `disable-gpu` 改为 GPU 路线:
  - `--ozone-platform=x11`
  - `--use-angle=vulkan`
  - `--enable-features=Vulkan`
  - 继续保留 `--no-sandbox` / `--no-zygote` 的现有约束。
- `run_loop` 可从 tao `run_return` 切到纯 CEF/GLib 外部泵;在
  `do_message_loop_work()` 外还要泵 GLib `MainContext`。
- 窗口/ webview 创建从 `WindowInfo.windowless_rendering_enabled=1` 的 OSR browser
  改为 CEF Views `BrowserView + Window`。
- 保留软件 OSR 作为 fallback 或独立实验路径,但不作为性能主线。

**验收**
- kabegame 真实图库滚动在 NVIDIA 下走 CEF GPU 窗口,无明显卡顿。
- CPU 占用相比软件 OSR 明显下降。
- 文字选择、滚动、按钮点击、IPC、protocol、page-load、关闭退出稳定。

## 风险
- Vulkan external memory / queue-family ownership / sync 细节深,驱动敏感。
- CEF 是否提供足够同步信息尚未确认;如果没有 sync fd/fence,需要验证回调时序保证。
- `external_begin_frame` vs `windowless_frame_rate` 的取舍影响帧率/功耗。
- 本仓库若 vendor importer,后续要跟 cef-rs/wgpu 版本维护。

## 锚点
- `examples/minimal_gpu.rs`:GPU 复现基线。
- README §9.2.2 / §9.3:现有 spike 结论与交付物。
- `/home/cm/code/cef-rs/cef/src/osr_texture_import/dmabuf.rs`:当前导入器。
- `runtime.rs:446`:现仍硬关 GPU。
- `webview.rs`:`on_paint`/softbuffer 软件 fallback。

## 执行拆解(5.1.x)— 路线 A 迁移(tao+OSR → CEF Views windowed + GLib pump)

> 范围提示:路线 A 会让 Phase 3 的 **tao 窗口半边(`window.rs`)+ OSR 输入转发/softbuffer blit** 在 windowed 路径上**被取代**(降级为 OSR fallback)。各步保持可编译,OSR 路径不删、按 mode 分流。

| 子段 | 主题 | 验收 |
|---|---|---|
| [5.1.1](cef-linux-runtime-phase5.1.1.md) | windowed 骨架:GPU 开关 + CEF/GLib 外部泵 | runtime 起 CEF Views 窗口加载固定 URL、GPU、可交互 |
| [5.1.2](cef-linux-runtime-phase5.1.2.md) | Tauri `create_window`/`create_webview` → CEF Views(BrowserView)| `Builder::<Cef>` 出无外壳 GPU 窗口 + 前端,IPC/protocol/init-script 通 |
| [5.1.3](cef-linux-runtime-phase5.1.3.md) | `WindowDispatch` 映射到 CEF Views + 降级矩阵 | 主窗口常用操作可用,降级项明确 |
| [5.1.4](cef-linux-runtime-phase5.1.4.md) | 收敛 OSR 专属(输入/blit)为 fallback + webview 复核 | windowed 原生输入/呈现,webview 方法全通 |
| [5.1.5](cef-linux-runtime-phase5.1.5.md) | kabegame 端到端 GPU + 性能对照 + 退出清理 | 图库滚动丝滑、CPU 降、稳定退出 |
| [5.1.6](cef-linux-runtime-phase5.1.6.md) ⚠️ | **windowed 弃用 tao**(纯 CEF/GLib pump + `post_task` 建窗口),修 5.1.2 启动卡死/无窗口根因;**OSR 的 tao 保留** | windowed 真窗口弹出、可交互、无 10s 卡顿 |

建议顺序:**先 5.1.6**(修根因、解卡)→ 再 5.1.3(窗口方法映射 CEF Views)→ 5.1.4 → 5.1.5。

> 5.1.6 修订了 5.1.1/5.1.2 的"windowed 仍借 tao run_return"做法:windowed 改纯 CEF/GLib pump,所有 CEF Views 创建经 `post_task(TID_UI)`;OSR 路径 tao 不动。
