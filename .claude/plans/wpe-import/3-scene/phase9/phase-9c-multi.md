# P9c — 多实例、大文件与播放卡住的兜底（子计划）

总计划见 [phase-9-video.md](phase-9-video.md)「P9c」。本节分三步：步骤 0 实测与读码，步骤 1 卡住的兜底（2026-11-14 用户：直接兜底，根因对照实验以后再跑），步骤 2 多实例与落盘量（等步骤 1 之后再量）。

## 总体设计思路

Chromium 的硬件解码会在长时间播放 4K60 视频后静默停住：元素仍是「在放」、没有错误，只是 `readyState` 停在 `HAVE_CURRENT_DATA`，Chromium 内部没有任何超时或恢复（读码见步骤 0）。原地跳一下（`currentTime = currentTime`）会让管线清空、解码器复位，立即恢复。所以兜底放在我们自己的播放器里：每次 GpuScene 画到这张纹理时顺便看一眼「该在放的视频时间有没有前进」，超过阈值没前进就原地跳一下；跳了仍不前进，再按同一个 Blob 地址重新加载、回到原时间。

关键决策：
- **只在 `drawn()` 里判断**：画到才说明这张纹理此刻要用，宿主暂停、空闲暂停（30 帧没画到）、脚本暂停或停止、页面隐藏（rAF 不跑）都自然不进判断，不用另起定时器。用墙钟（`performance.now()`，可注入）计时，不用渲染帧数，因为帧率随显示器变。
- **阈值 2 s、要求 `readyState < HAVE_FUTURE_DATA`**：实测的短暂缺帧每次约 1 s 自己恢复（`BUFFERING_HAVE_NOTHING` → `HAVE_ENOUGH`），2 s 不会误伤；只看时间不前进还不够，速率为 0、`seeking`、第一帧之前都排除。
- **原地跳不经脚本接口的 setter**：setter 会钳制并清结束判定的 `armed`；原地跳不是脚本的意图，时间也不回退，不该影响结束回调。
- **升级到重载、有上限**：慢机器上解码本来就跟不上时，反复跳转只会更糟，所以每次兜底之后重新计时，连续两次原地跳都没救回才重载；重载之后仍连续失败三轮就停手、记一条 warn，不再折腾。
- **每次兜底记一条 warn、探针加计数**：卡住约十几分钟一次，日志量可以接受；以后能从日志和 `host.videos()` 看出它多常发生。

## 步骤 0 — 实测与读码（2026-11-14）

**复现**（主窗口预览 13586，3429479356 的 4K60 H.264、40 Mbps、141.43 s；加载之前开 CDP `Media` 域，每秒采样，不干预）：
- 两次都卡住：第一次约 10 分 20 秒（第 5 遍 55.33 s），第二次 13 分 28 秒（第 6 遍 94.94 s）。卡住时 `paused` / `ended` 假、无 `error`、`readyState` 2、`networkState` 1、`buffered` 整段，时间、解码帧数、`webkitVideoDecodedByteCount` 都不再变；视频没有音轨，场景脚本不碰视频。
- 解码器 `D3D11VideoDecoder`（`kIsPlatformVideoDecoder`，输出 NV12），H.264 Main 3840×2160。
- 卡住那一刻 video renderer 报 `BUFFERING_HAVE_NOTHING`，`reason` 是 **`DECODER_UNDERFLOW`**（解码器不出帧，不是读 Blob 读不到）。之前 13 分钟里有 12 次约 1 s 的短暂缺帧：前 4 分钟 3 次都是 `DEMUXER_UNDERFLOW`，6 分钟后多为 `DECODER_UNDERFLOW`，最后 10 s 连着 4 次，第 4 次没恢复。Chromium 自己的统计 `kVideoPlaybackFreezing` 0.22、`kVideoPlaybackRoughness` 21。
- 原地跳一下：约 75 ms 后 `seeked`、`readyState` 回到 4，之后按 60 fps 正常播放。

**读码**（Chromium 149.0.7827.201，`D:\Codes\cefbuild\chromium_git\chromium\src`，子代理只读）：
- `readyState` 2 只来自 pipeline 的 `BUFFERING_HAVE_NOTHING`（`web_media_player_impl.cc:2431-2450`）；没有停顿超时，`stalled` 事件只在 `networkState` 为 LOADING 时发，Blob / `file:` 都不发。
- `D3D11VideoDecoder` 拿不到空闲输出缓冲时直接返回、不记日志、没有定时器，要等某帧释放并等到它的 sync token 才继续（`d3d11_video_decoder.cc:656-661, 472-484`）；池约 DPB + 6，4K 约 11 个。跳转时 `VideoRendererImpl::Flush` 清队列、`D3D11VideoDecoder::Reset` → `H264Decoder::Reset` 清 DPB（`d3d11_video_decoder.cc:722-739`、`h264_decoder.cc:161`），解释了「跳一下就好」。
- 可疑的占用方：WebGPU 零拷贝导入把帧的释放 sync token 换成 WebGPU 上下文的（`webgpu_mailbox_texture.cc:189-199, 266-299`），或合成器持有的当前帧；没有对照实验，**根因未证实**。
- 媒体检查器每个上下文只缓存 512 条事件，`Media.enable` 之前建的播放器超限时整个被丢（`inspector_media_context_impl.h:20-22`），所以第一次卡住时读不到这个播放器。
- 换成 `file:` 地址走同一条 `MultiBufferDataSource` 路径（浏览器端 `FileURLLoader` 直接按区间读文件），省掉 Blob 注册表与 100 MB 分片，不影响这种卡住。

**其它实测**：
- 一路 4K60 H.264 占 RTX 4070（Chromium 的首选显卡）解码器约 32%，三路同时接近上限（步骤 2 量）。
- 旧实例的 Blob 都释放了（`blob_storage` 只剩当前一份 670 MB）；13586 当天加载 6 次，每次写约 707 MB。
- dev 工具的屏外宿主在 `left:-20000px`，跨源 iframe 屏外会被节流、不跑 rAF，测不了实时播放；复现用应用内路由打开预览（不整页重载，别的会话的屏外宿主不受影响）。

**根因对照实验（留待以后）**：同一视频一组每帧 `copyExternalImageToTexture(元素)`、一组只放不拷、一组 `new VideoFrame(元素)` 拷完立即 `close()`，各跑两次 20 分钟。

## 现状锚点

**a. 播放器每帧被画到时**（`apps/wpe-scene/src/video/player.ts:244`）
```ts
drawn(frame: number, hostPaused: boolean): HTMLVideoElement | null {
  if (this.disposed) return null;
  this.lastDrawn = frame;
  this.apply(frame, hostPaused);
  // 现状：只交新帧，不看时间有没有前进
  if (!this.fresh || this.failed || !this.wantPlay) return null;
  this.fresh = false;
  return this.element;
}
```

**b. 该不该在放**（`player.ts:446`）
```ts
private sync(): void {
  if (this.disposed || this.failed || this.url === null) return;
  const want = this.wantPlay && !this.hostPaused && this.frame <= this.lastDrawn + IDLE_FRAMES;
  if (want === this.playing) return;   // 现状：只在结论变化时调 play() / pause()
  this.playing = want;
  ...
}
```

**c. 工厂与探针**（`player.ts:38`、`:52`）
```ts
export interface VideoFactories {
  createElement?: () => HTMLVideoElement;
  attach?: (element: HTMLVideoElement) => () => void;
  readBlob?: (source: SceneVideoSource) => Promise<Blob>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  // 现状：没有时钟
}
export interface VideoPlayerProbe { /* … */ totalFrames: number | null; droppedFrames: number | null; } // 现状：没有兜底计数
```

## 步骤 1 — 卡住的兜底（`player.ts`）

### 点 1 — 判定与处理
- **新增**
  - `STALL_MS = 2000`、`STALL_SEEKS_BEFORE_RELOAD = 2`、`STALL_MAX_RELOADS = 3` 三个常量（导出给测试）。
  - `VideoFactories.now?: () => number`（缺省 `performance.now()`）。
  - 私有状态：上次看到的时间与看到它的墙钟、本轮连续原地跳次数、连续重载次数、是否已放弃；计数 `stallSeeks` / `stallReloads`。
  - `private watchStall()`：在 `drawn()` 里 `apply` 之后调。
    > 该前进的条件全满足才计时：没释放没失败、有对象地址、出过第一帧、`playing`（元素被要求在放）、`wantPlay`、非宿主暂停、元素 `!paused && !ended && !seeking`、`playbackRate > 0`、`readyState < HAVE_FUTURE_DATA`。任一不满足、或 `currentTime` 和上次不同，就把基准重置为「现在、这个时间」并清掉本轮跳转次数（时间前进时也清重载次数）。
    > 满足且 `now − 基准 ≥ STALL_MS`：本轮跳转次数 < 2 → 原地跳（`element.currentTime = element.currentTime`，不经 setter、不碰 `armed`），计数加一、记 warn；否则重载次数 < 3 → 重载（记下时间 → `element.src = url`、`element.load()` 隐含 → `loadedmetadata` 之后设回时间 → `playing = false; sync()` 重新 `play()`），计数加一、记 warn；否则放弃，记一条 warn，之后不再兜底直到时间重新前进。每次处理后基准重置为现在。
  - `probe()` 增加 `stallSeeks`、`stallReloads`。
- **修改**
  - `drawn()`：`apply` 之后调 `watchStall()`。
```ts
drawn(frame: number, hostPaused: boolean): HTMLVideoElement | null {
  if (this.disposed) return null;
  this.lastDrawn = frame;
  this.apply(frame, hostPaused);
  this.watchStall(); // 新增：画到时看时间有没有前进，卡住就原地跳 / 重载（P9c 步骤 1）
  if (!this.fresh || this.failed || !this.wantPlay) return null;
  this.fresh = false;
  return this.element;
}
```

### 点 2 — 测试（`player.test.ts`）
- **新增**：用元素替身与注入时钟覆盖：
  - 卡住 2 s 原地跳一次、时间前进后计数不再涨；
  - 连续两次原地跳无效后重载，重载后回到原时间并重新 `play()`；
  - 三次重载都无效后放弃、只记一条放弃的 warn，时间前进后重新装上；
  - 不误判：脚本暂停、宿主暂停、空闲暂停（不画）、`seeking`、速率 0、第一帧之前、`readyState ≥ 3`、1.9 s 内恢复；
  - 原地跳不触发结束回调、不改 `armed`（之后真绕回仍触发一次）。

### 验收
- tsc、wpe-scene 全部 vitest、Prettier；变异检查：去掉 `readyState` 条件、去掉 `playing` 条件、阈值改 0、不重置基准，各有测试挂掉。
- 真机：13586 预览跑到兜底触发（真卡造不出来，暂停不算卡，只能等它自然卡住，约 10–14 分钟），日志里有兜底 warn，`host.videos()` 的 `stallSeeks` 增加，画面继续动。

## 步骤 2 — 多实例与落盘量（之后）

按总计划「P9c」量：预览 + 桌面 + 应用背景同时放 13586 的解码器占用、丢帧与卡住频率，反复加载的写盘量与读入时间；改桌面壁纸与应用背景前先问用户。数字出来再定要不要 Rust 缓存文件。

## 实施记录

### 步骤 1 — 卡住的兜底（2026-11-14）

**实现**（子代理，只改 `video/player.ts`、`player.test.ts`；Claude 补 `sceneVideos.test.ts` 的探针期望、把 warn 的详情改成字符串）：
- 照点 1 实现，另加的保护：
  - 元素没被要求在放时（重新加载等元数据、各种暂停）不比时间：重载期间元素时间暂时回到 0，不能当成前进，否则重载次数永远清零、到不了停手。
  - `sync()` 的结论变化时重新计时：空闲暂停期间不调 `drawn`，没有这一条，恢复后第一帧就会把暂停的时长算进去、立即误跳。
  - 两次判断之间隔了 2 s 以上（没画到，比如窗口被盖住）时重新计时，只算连续看着的那段。
  - 重新加载期间 `sync` 不碰元素、`detectEnd` 不判定（时间回到 0 不是绕回），脚本读到的是要设回的时间，脚本这期间写的时间在元数据回来时生效。
- warn 的详情是字符串：宿主转发日志时对详情取 `String()`（`report.ts`），给对象只剩「[object Object]」（真机上发现）。
- `requestVideoFrameCallback` 换源后会自己重新接上（Chromium `video_frame_callback_requester_impl.cc`），重载后不用重新登记。

**验收**：
- tsc 0 error；`video/` 90 个用例全过；wpe-scene 全量 3593 个只挂 `compile/pipeline.test.ts` 的语料读取上界（`3293687972`），`compile/` 只以类型方式引用播放器，相关文件是别的会话未提交的改动。Prettier 通过。
- 变异检查 7 个：去掉 `readyState` 条件、去掉 `playing` 条件、阈值改 ≥ 0、条件不满足时 / 时间变化时 / `sync` 结论变化时 / 中间没画到时不重置基准，各有测试挂掉。
- 真机（主窗口预览 13586，加载前开 `Media` 域）：放了约 7 分钟在 131.90 s 卡住（`DECODER_UNDERFLOW`），约 2 s 后日志「场景视频卡住 2000 ms 没前进，原地跳一下」，`stallSeeks` 1，`readyState` 回到 4，按 60 fps 放到 141.4 s 并正常绕回。
- 回归 `versions/latest/regression.md`「场景壁纸视频卡住的兜底（P9c）」X0–X2，X2（桌面上放 30 分钟）待测。

## 步骤 2 — 多实例与落盘量（2026-11-14，进行中）

**X2 桌面长时间播放**（13586 设为桌面壁纸 30 分钟，加载后开 `Media` 域，每秒采样，每 30 s 记 `nvidia-smi`；测完改回 14295 并关掉壁纸）：
- 桌面加载 13586 用时 1687 ms（日志「开始渲染」），`blob_storage` 涨到 670 MB。
- 这次 Chromium 的 GPU 进程在 RTX 4090 D 上（上午在 RTX 4070，dev 重启后选的显卡变了）。同一块卡上 WPE（`wallpaper64.exe`，别的会话的测试窗口）占解码器 92%，61 次采样里 36 次整卡解码 100%、多数 ≥ 94%。
- 30 分钟里卡住 11 次（`readyState` 2），每次原地跳一下就恢复，一次重新加载都没用到；另有 76 次约 1 s 的短暂缺帧（75 次 `DECODER_UNDERFLOW`、1 次 `DEMUXER_UNDERFLOW`）自己恢复。间隔 1–7 分钟，没有越来越密：和「输出缓冲泄漏、池子越用越少」的推测不太吻合，更像是解码器吃紧时卡住的概率上升。根因仍未证实。
- 解码器满载时的多实例开销数字不可信，等 WPE 空下来再量。

## 步骤 3（候选）— 标清未标视频的原色转换（P11b 实测转来，2026-11-14）

P11b 会话实测（`ignore/p11/texsrc/ut-vstripe.mp4`，生成脚本 `ignore/p11/b4/make_stripe_video.py`；WPE 抓帧 `A:\p11b\vstripe`，工程 `ignore/p11/proj/p11-ut`）：
- 320×240 libx264 yuv420p，四个色彩标签都未标。Chromium 的 `new VideoFrame(video).colorSpace` 是 `{ matrix, primaries, transfer: smpte170m, fullRange: false }`，`copyTo` 出的 NV12 与按 BT.601 限定范围编码的源色逐值相同：**矩阵是对的**。
- `copyExternalImageToTexture`（缺省 srgb 目标）的结果整体偏色，例如 (30,200,30) → (57,197,26)，WPE 是 (29,199,30)；灰不变。偏移方向正是 SMPTE-C 原色 → sRGB 的色域转换（另有 170m → sRGB 传递函数），**WPE 不做这一步**，只按 601 矩阵解。
- 高清未标时 Chromium 认作 BT.709 原色（≈ sRGB），不发生这一步，所以 P9a 在高清语料上没看到偏色（p9-REPORT「P9a 的对照」只对高清成立）。
- P9 先前回复里「Chromium 一律按 709 解」的推断不对，以此为准。

**影响**：`.tex` 视频与用户纹理视频走同一条拷贝路径。本机语料里未标的 13 段都是高清（≥ 2560×1440），不受影响；要实测的是矩阵标了 `bt470bg`、原色未标的两段：3400241651（960×540）、3812007032（3840×2160），看 Chromium 给的 `primaries` 与是否偏色。

**可能的修法（都没试）**：
- WebCodecs 取 YUV，按 `VideoFrameBufferInit` 带 `colorSpace { matrix: smpte170m, primaries: bt709, transfer: iec61966-2-1, fullRange: false }` 重建再拷：每帧一次读回，SD 可以，4K 不行。
- 拷完后在着色器里做逆转换（sRGB 解码 → 逆 3×3 → 170m 编码）：便宜，但色域外被截断的值找不回来。
- 只在 `VideoFrame(video).colorSpace.primaries` 不是 bt709 / 未标时才走修正路径。

**改标签实验**（2026-11-14，`ignore/p9/p9c/color/`）：`ffmpeg -c copy -bsf:v h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=6` 加容器的 `-color_primaries bt709 -color_trc bt709 -colorspace smpte170m -color_range tv`，不重编码。主窗口页面里 `<video>` → WebGPU `copyExternalImageToTexture` → 读回 8 条竖条中心：原片 `VideoFrame.colorSpace` 全是 smpte170m、绿 (30,200,30) → (57,197,26)；改标签后报 `matrix smpte170m / primaries bt709 / transfer bt709`，8 条与源色差 ≤ 1（绿 (29,200,30)、青 (29,220,219)，和 WPE 相同）。即只要让 Chromium 的原色与传递函数是 bt709、矩阵照 MF 的选法，就和 WPE 一致。

2026-11-14 用户：「不只是偏色，而是改成不用 video，也许需要编一个 wasm」——方向改为视频纹理不用 `<video>`，见下一节的讨论。
