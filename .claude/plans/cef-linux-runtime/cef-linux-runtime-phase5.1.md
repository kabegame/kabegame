# Phase 5.1 — GPU OSR / dmabuf 黑屏排查

> 父:[phase5](cef-linux-runtime-phase5.md)。**本阶段最关键**——这是换 CEF 的初衷。
>
> **当前结论**:CPU 软件 OSR 对 kabegame 图库(大图 + 密集滚动 + 可能视频)
> 不够快,不能作为最终方案。Phase 5.1 不再把"软件路径是否够用"作为主问题,
> 而是直接以 **GPU 加速 OSR** 为硬目标。
>
> **目标**:先挖清 `dmabuf` 黑屏问题,把 CEF GPU 出帧 → Vulkan dmabuf 导入 →
> wgpu 采样上屏这条链路修通或证伪;只有在 OSR+GPU 不可行时,再退回 CEF
> 自建顶层窗口路线。

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

## 点 1 — dmabuf 黑屏根因收敛(先做)
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
- [ ] 验证 CEF shared handle 生命周期问题:把 imported dmabuf 在
  `on_accelerated_paint` 回调内 copy 到应用自有 wgpu texture,再采样自有 texture。
- [ ] 判断 patch 落点:优先在本仓库 vendor/patch 一份 importer 或复制最小 importer;
  能稳定后再考虑上游 PR。

**产出**
- 一份"黑屏发生在哪一层"的结论:
  - CEF/ANGLE 没写内容;
  - CEF shared handle 生命周期违规;
  - dmabuf import 参数/格式错误;
  - Vulkan layout/ownership/sync 错;
  - wgpu 合成层错。
- 如果结论指向 layout/ownership/sync,进入点 2。

## 点 2 — 修 dmabuf 导入路径
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

## 点 3 — 接入 runtime 渲染层
前提:点 2 的最小复现已正确显示。

- 把 runtime 从软件 `on_paint`/softbuffer 主路径切到 accelerated OSR + wgpu。
- 保留软件 OSR 作为启动参数或运行期 fallback,用于不支持 dmabuf/Vulkan 的环境。
- 运行期开关从 `disable-gpu` 改为 GPU 路线:
  - `--ozone-platform=x11`
  - `--use-angle=vulkan`
  - `--enable-features=Vulkan`
  - 继续保留 `--no-sandbox` / `--no-zygote` 的现有约束。
- 输入、resize、DPI、page-load、IPC 不应因渲染层替换回退。

**验收**
- kabegame 真实图库滚动在 NVIDIA 下 GPU 合成,无明显卡顿。
- CPU 占用相比软件 OSR 明显下降。
- 大窗口 / 高分屏 / 视频缩略或视频播放场景稳定。

## 兜底 — CEF 自建顶层窗口
仅当 OSR+GPU 的 dmabuf 路径被证伪时启用。

- Phase 1 已证明 CEF 自建窗口 + GPU 正确显示。
- 代价:窗口归 CEF,丢 tao 现有窗口/事件循环集成,会冲击 Tauri runtime 适配层。
- 若走此路,需要另开计划,不要在本阶段和 dmabuf patch 混做。

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
