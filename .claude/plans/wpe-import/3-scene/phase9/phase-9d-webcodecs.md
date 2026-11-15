# P9d — 视频纹理自己解码（WebCodecs + TypeScript 拆包）

2026-11-14 用户：「不只是偏色，而是改成不用 video，也许需要编一个 wasm」「这样很多行为更可控」；拆包「用 1」（TypeScript 自己写，不编 FFmpeg wasm）；「不要长测了，直接开始」。

## 总体设计思路

视频纹理不再经过 `<video>`：宿主自己从 `.tex` / `scene.pkg` 的磁盘区间里拆出每一帧的压缩数据，交给 WebCodecs 的 `VideoDecoder`（显卡硬解），解出的 `VideoFrame` 由播放器按自己的媒体时钟挑出当前帧，GpuScene 画到视频纹理时 `copyExternalImageToTexture(VideoFrame)`，拷完即可释放。数据从此只沿「磁盘区间 → 按区间 `fetch(file:)` → 拆包 → 解码器 → VideoFrame → 纹理」一个方向流动，中间没有 Blob、没有媒体元素、没有 Chromium 的媒体管线与合成器。

这样换来的是可控：
- **时钟**完全是我们的，时长、循环点、速率、暂停、跳转都照 WPE 的语义写，P9a / P9b 记下的时间差异（循环点早 22–40 ms、一帧内的跳转、开场视频比场景早 0.3–1.4 s）都可以消掉；
- **颜色**由 `VideoDecoderConfig.colorSpace` 指定（步骤 0：WebCodecs 不读码流的色彩标签、缺省一律 BT.709；指定后与 WPE 差 ±1）；
- **字节**按需读、读多少解多少，不再每次加载把整段视频写进 Blob 存储（674 MiB 那段每次 0.8 s、落盘 707 MB）；
- **卡住**看得见：解码器有没有出帧、帧什么时候释放都在我们手里，卡住时直接重置解码器再从关键帧接上，不用猜；
- 看不见的元素暂停后恢复要等约 255 ms、挂进 DOM 的 2 像素都随 `<video>` 一起消失；dev 回放可以精确解到指定帧。

关键决策：
- **拆包用 TypeScript**：语料 60 段几乎全是普通 MP4（帧表集中在 `moov`，13586 只有 79 KB、解析 4 ms），只有一两段 Matroska。FFmpeg 编 wasm 的难点是它要同步读数据，而宿主只能异步 `fetch(file:)`、Worker 读不了 `file:`。
- **解码器只解不播**：媒体时钟、帧的挑选、预读与流控都在播放器里；解码器只管按解码顺序吃进、按显示顺序吐出（步骤 0 实测输出不用重排）。
- **颜色照 WPE（Media Foundation）**：矩阵取码流的（`colr` 盒或 H.264 SPS 的 VUI），没标时按 MF 的规则按分辨率选 601 / 709；原色与传递函数一律报 BT.709，即不做色域与传递函数转换（WPE 不做，见 phase-9c「步骤 3」的实测）；范围取码流的。
- **接口尽量不变**：`VideoTexturePlayer` 的脚本语义接口（`rate` / `loop` / `currentTime` / `duration` / `play` / `pause` / `stop` / `isPlaying` / 结束回调 / `resetScriptState` / `probe`）原样保留，只换内部；`VideoSink.drawn` 改为交出 `VideoFrame`。P11b 的用户视频用同一个类，读字节的方式改成可注入的区间读取（文件区间或 Blob 切片）。
- **主线程**：`fetch(file:)` 只能在主线程；解码量实测 4K60 吞吐 181 fps，不需要 Worker。

## 步骤 0 — 可行性（2026-11-14）

在宿主里（屏外宿主测吞吐，主窗口页面测颜色）实测：
- **拆包**：TS 解析 MP4 帧表，13586（4K60 H.264，8486 帧、142 个关键帧、带 `ctts` 与 `edts`）`moov` 79 KB、4 ms；3822149301（HEVC 2560×1440 60 fps）2 ms。
- **吞吐**：解 600 帧并每帧 `copyExternalImageToTexture` 进 `rgba8unorm` 后立即 `close()`：13586 181 fps（实时的 3 倍），读文件共 99 ms（约 40 MB），每帧拷贝 0.23 ms，输出顺序正确；HEVC 450 fps，codec 串 `hvc1.1.6.L153.90`。
- **颜色**：P11b 的彩条片（320×240、未标）缺省解出 (16,173,26) 等（按 709 矩阵）；`colorSpace: { matrix: smpte170m, primaries: bt709, transfer: bt709, fullRange: false }` 后 8 条与源色差 ≤ 1、与 WPE 相同。3400241651（960×540，码流标 `bt470bg`）缺省同样报 bt709：**WebCodecs 不读码流色彩标签**，必须自己解析。
- **实时播放**：桌面壁纸宿主里按墙钟 60 fps 播 1.7 分钟，解 5964 帧、显示 5896、丢 62，没有卡住（未做长测，用户要求直接开始）。屏外宿主里 `setTimeout` 被节流到约 1 次 / 秒，实时播放只能在屏上的宿主里测。
- 工具在会话临时目录（`wc_probe.js`、`wc_long.js`），不入库。

## 现状锚点

**a. 帧来源接口**（`apps/wpe-scene/src/video/sceneVideos.ts:25`）
```ts
export interface VideoSink {
  beginFrame(): void;
  /** 画到绑定这张纹理的 draw 时调：记帧号、空闲中的恢复播放；有新帧就交出元素（交出即清标志）。 */
  drawn(texture: number): HTMLVideoElement | null;   // 现状：交出 <video> 元素
}
```

**b. GPU 拷贝**（`apps/wpe-scene/src/render/scene.ts:4110`）
```ts
private copyVideo(index: number, source: HTMLVideoElement): void {
  const { videoWidth, videoHeight } = source;         // 现状：尺寸取元素的 videoWidth / videoHeight
  ...
  this.device.queue.copyExternalImageToTexture({ source }, { texture }, { width: ..., height: ... });
}
```

**c. 播放器**（`apps/wpe-scene/src/video/player.ts`）：一段视频一个 `VideoTexturePlayer`，`fetchVideoBlob` 读整段 Blob → `<video src=对象地址>`，`attachToDocument` 挂进页面，`requestVideoFrameCallback` 置新帧标志，`sync()` 按 wantPlay / 空闲 / 宿主暂停调 `play()` / `pause()`，`watchStall` 兜底卡住（P9c 步骤 1）。容器时长由编译期 `video/container.ts` 读 `mvhd` / Matroska `Info.Duration`。

## 步骤

1. **MP4 拆包与解码配置**（只新增文件，纯函数，Node 单测）：`video/demux/` 下帧表解析、codec 串、`description`、色彩空间（`colr` / H.264 SPS VUI / MF 规则）、编辑列表。语料扫描：60 段逐段解析，帧数、关键帧、时长、codec、色彩和 `ignore/p9/out/vtex.json` 对照。
2. **WebCodecs 播放器**，分两半（`usertex/sources.ts` 有 P11b 未提交的改动，`render/scene.ts`、`host.ts` 有别的会话的改动）：
   - **2a**：新增 `video/codecPlayer.ts`（区间读取与预读、解码流控、媒体时钟、挑帧、跳转、循环预滚、暂停、速率、结束、解码器卡住重置、帧的释放），场景视频纹理（`SceneVideos`）换用它；拆包失败（Matroska 等）的退回旧的 `<video>` 播放器；`VideoSink.drawn` 交出 `VideoFrame | HTMLVideoElement`，`GpuScene.copyVideo` 两种都认（只改这一处）；脚本接口的类型改成接口；`host.videos()` 探针加新字段。
   - **2b**：P11b 提交后，用户视频与 dev 探针 `videoTime` 换用新播放器（探针改为精确解到那一帧），删掉旧播放器的 `<video>`、Blob、`attachToDocument`、`watchStall`。
3. **Matroska 拆包**：EBML、`Tracks`（`CodecPrivate`）、`Cues`、按 Cluster 流式读 SimpleBlock / BlockGroup。
4. **对照与收尾**：和 WPE 对照时间（循环点、一帧内跳转、开场、编辑列表）与颜色（SD / HD 未标的分界）；语料；文档、回归、changelog。

## 步骤 1 — MP4 拆包与解码配置

### 点 1 — 帧表（`video/demux/mp4.ts`，新增）
- **新增**
```ts
/** 按区间读字节（相对视频起点），文件区间或 Blob 切片都实现它。 */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

export interface VideoTrackIndex {
  codec: "avc" | "hevc";
  /** avcC / hvcC 盒的内容（不含盒头），即 VideoDecoderConfig.description。 */
  description: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  timescale: number;
  /** 容器时长（秒，mvhd，和 containerDuration 一致）。 */
  duration: number;
  /** 每个样本按解码顺序：相对视频起点的字节偏移、长度、显示时间（秒，已扣编辑列表）、是否关键帧。 */
  offsets: Float64Array;
  sizes: Uint32Array;
  times: Float64Array;
  keys: Uint8Array;
  /** `colr` 盒（nclx）的标签，没有为 null。 */
  colr: { primaries: number; transfer: number; matrix: number; fullRange: boolean } | null;
}

/** 读顶层盒找到 moov（不读 mdat），解析第一条视频轨；不是 MP4、没有视频轨、编码不是 avc1/avc3/hvc1/hev1 时返回带原因的失败。 */
export async function indexMp4(read: ReadRange, length: number): Promise<VideoTrackIndex | { error: string }>;
```
  > 说明：`stsz` / `stsc` / `stco` / `co64` / `stts` / `ctts`（v0 无符号、v1 有符号）/ `stss`（缺省全是关键帧）；编辑列表只认「一段、`media_time ≥ 0`」，显示时间扣掉 `media_time`（和 ffmpeg 一致，P9a 对照里 WPE 与 ffmpeg 帧号一致），其它形状报原因；fragmented MP4（`moof`）报原因。上限照 `container.ts`：顶层盒数、`moov` 大小（≤ 64 MiB）。

### 点 2 — 解码配置（`video/demux/config.ts`，新增）
- **新增**
```ts
/** codec 串（avc1.PPCCLL / hvc1.<space><idc>.<compat 反序>.<L|H><level>.<约束>）、description、色彩空间，交给 VideoDecoder.configure。 */
export function decoderConfig(track: VideoTrackIndex): VideoDecoderConfig;

/** 照 WPE（Media Foundation）的颜色：矩阵取 colr → H.264 SPS VUI → 没标时按分辨率（MF_SD_HD_RULE），原色与传递函数恒为 bt709，范围取码流的。 */
export function wpeColorSpace(track: VideoTrackIndex): VideoColorSpaceInit;
```
  > 说明：H.264 的 VUI 从 avcC 的第一个 SPS 解（去防竞争字节、exp-Golomb，跳过 scaling list、帧裁剪等到 VUI）。HEVC 先只认 `colr`，没有就按分辨率规则（语料里的 HEVC 是 1440p，规则给 709，和它码流的标签一致），HEVC VUI 解析放到需要时再做。矩阵码：1 → bt709，5 / 6 → smpte170m（`bt470bg` 在 WebCodecs 里也是 smpte170m 一类），9 → bt2020-ncl，其它按 bt709 并记原因。分辨率规则的阈值先取「高 ≥ 720 用 709，否则 601」，步骤 4 用 WPE 实测分界。

### 点 3 — 测试
- **新增** `video/demux/mp4.test.ts`、`config.test.ts`：手造的最小 MP4（盒子拼字节）覆盖各表与编辑列表、`co64`、`ctts` v1、缺 `stss`；SPS VUI 有 / 无颜色描述、带 scaling list 的 High profile；codec 串（含 HEVC 的约束字节裁剪）。
- **语料扫描**（不入库）：`ignore/p9/p9d/step1/corpus.ts`，按 `ignore/p9/out/vtex.json` 的 60 个条目逐段 `indexMp4`，和表里的帧数 / codec / 宽高 / 色彩 / 时长对照，并用 ffprobe 抽查几段的关键帧数与首帧显示时间。

## 步骤 2a — WebCodecs 播放器（场景视频纹理）

### 现状锚点
**d. 场景视频的播放器工厂**（`video/sceneVideos.ts` 的 `SceneVideos.load`）：每个视频区间 `new VideoTexturePlayer(video, this.frame, { ...this.factories, report })`，跨重编译按 `videoSourceKey` 复用；`beginFrame` 里 `detectEnd` 与 `apply`，`drawn(texture)` 转给播放器。

### 点 1 — 新播放器（`video/codecPlayer.ts`，新增）
- **新增** `CodecVideoPlayer`，对外成员与 `VideoTexturePlayer` 相同（`wantPlay`、`lastDrawn`、`fresh`、`failed`、`source`、`apply`、`drawn`、`detectEnd`、`hasFirstFrame`、`firstFrame`、`rate`、`loop`、`currentTime`、`duration`、`play`、`pause`、`stop`、`isPlaying`、`resetScriptState`、`addEndedCallback`、`probe`、`dispose`），另有 `videoWidth` / `videoHeight`。语义照 `player.ts` 现有的 WPE 规则（rea-p9-video、p9-REPORT），只换实现：
  - **读**：`ReadRange`（缺省按 `source.path` 区间 `fetch(file:)`，`source.start` 为基点），先 `indexMp4`；失败交给工厂退回旧播放器（`indexMp4` 的错误原因进 warn）。预读按解码顺序连续读约 4 MiB 一块，至多留两块。
  - **解码**：`VideoDecoder`（可注入，测试用替身），`decoderConfig(track)`；`isConfigSupported` 不支持或解码出错 → `fail`（图层透明、记 warn，同旧播放器）。流控：解码队列 + 已解出未显示的帧合计不超过 8。循环时不停顿地接着喂下一遍的帧（时间戳加 `n × duration`），不 flush。
  - **时钟**：媒体时间只在「在放」（`wantPlay && !宿主暂停 && 没空闲` 且出了第一帧）时按墙钟 × 速率前进，第一次 `drawn` 时才起步（消掉开场时视频比场景早）；时长取 `source.duration ?? track.duration`（mvhd），时钟走到时长才绕回（`loop`）或结束（停在时长，`ended`）。
  - **挑帧**：显示时间 ≤ 媒体时间的最新一帧；被越过的帧直接 `close()`、计入丢帧；当前帧留到被替换时再 `close()`。
  - **跳转**（脚本 `currentTime` 写、`stop`、结束后 `play`）：`decoder.reset()`，关掉队列里的帧，从显示时间 ≤ 目标的最近关键帧重新喂，丢掉早于目标帧的输出；脚本暂停期间照旧不交帧（P9b 语义）。
  - **卡住**：在放、队列空、解码器有待解的输入，2 s 没有输出 → `reset()` 后从当前媒体时间重新跳转，记 warn、计数（替代 P9c 的 `watchStall`）。
  - **探针**：`probe()` 在 `VideoPlayerProbe` 的字段外加 `decoder`（`"webcodecs"`）、`decoded`、`dropped`、`queued`、`decodeQueue`、`stallResets`、`color`（`wpeColor` 的说明）。
- **测试**（`codecPlayer.test.ts`）：解码器替身（按喂入顺序在微任务里吐出带时间戳的假帧、可让它停止输出）、注入时钟、用 `demux/mp4.test.ts` 的手造 MP4 拼字节：起步、按时钟挑帧与丢帧、循环不停顿、不循环时结束停在时长、跳转到关键帧之间、暂停不前进、速率、空闲暂停、宿主暂停、卡住重置、失败、释放后不再交帧、帧都被 `close()`（统计打开的帧数为 0）。

### 点 2 — 接线
- **修改** `video/sceneVideos.ts`：工厂先试 `CodecVideoPlayer`，拆包失败退回 `VideoTexturePlayer`；`VideoSink.drawn` 的返回类型改为 `VideoFrameSource = VideoFrame | HTMLVideoElement`。
- **修改** `render/scene.ts` `copyVideo`：尺寸取 `displayWidth` / `displayHeight`（`VideoFrame`）或 `videoWidth` / `videoHeight`（元素），其余不变。
- **修改** `script/api.ts`：`VideoScriptTarget` 从 `Pick<VideoTexturePlayer, …>` 改为两个播放器都满足的接口。

## 步骤 3 — Matroska 拆包

### 总体思路
Matroska 没有 MP4 那样集中的帧表：每一帧（SimpleBlock / BlockGroup 里的 Block）散在各个 Cluster 里，帧的时间是「Cluster 时间码 + 块的相对时间码」再乘 `TimecodeScale`，块在文件里按解码顺序排、时间码是显示时间。所以索引只能把 Cluster 顺着读一遍、跳过块的数据只记头。按区间逐块去读块头要上万次 `fetch`，太慢；按约 4 MiB 一块顺序读、在内存里解析，等于整段读一遍（语料那段 299 MiB，量级和原来读成 Blob 相同，只在加载时做一次）。产出和 MP4 同一个 `VideoTrackIndex`，播放器不分格式。

### 点 1 — `video/demux/mkv.ts`（新增）
- **新增** `indexMatroska(read: ReadRange, length: number): Promise<VideoTrackIndex | { error: string }>`：
  - EBML 头（DocType `matroska` / `webm`）→ Segment → 顶层元素：`Info`（`TimecodeScale` 缺省 1e6、`Duration`）、`Tracks`（第一条 `TrackType = 1` 的视频轨：`TrackNumber`、`CodecID` 只认 `V_MPEG4/ISO/AVC` 与 `V_MPEGH/ISO/HEVC`、`CodecPrivate` 即 avcC / hvcC、`Video` 的 `PixelWidth` / `PixelHeight` 与 `Colour` 的 `MatrixCoefficients` / `Range` / `Primaries` / `TransferCharacteristics`）、`Cluster`（`Timecode`、`SimpleBlock`、`BlockGroup` 里的 `Block` 与 `ReferenceBlock`）；其余跳过。未知大小的 Segment / Cluster（size 全 1）按「读到下一个同级 ID」处理。
  - 只收这条轨的块；块的帧标志：SimpleBlock 的 0x80 是关键帧，BlockGroup 没有 `ReferenceBlock` 是关键帧；有 lacing 的块报原因。
  - `times` = (Cluster 时间码 + 有符号 16 位相对时间码) × `TimecodeScale` / 1e9 秒，再减去第一帧的时间（照 MP4 扣编辑列表的口径，首帧为 0；`editMediaTime` 记扣掉的量）。
  - 时长：`Info.Duration × TimecodeScale`（和 `containerDuration` 一致），没有时退到最后一帧的显示时间加一帧。
  - `colr` 字段由 `Colour` 填（码值同 ISO/IEC 23091-2，`Range` 2 是 full），没有 `Colour` 时为 null，交给 `wpeColor` 再看 SPS VUI。
  - 上限照 `container.ts` / `mp4.ts`：EBML 头 ≤ 4 KiB、元素嵌套深度、帧数 ≤ 10,000,000；不抛错。
- **新增** `indexVideo(read, length)`：前 4 字节是 EBML 魔数 `1A 45 DF A3` 走 `indexMatroska`，否则 `indexMp4`。
- **修改** `codecPlayer.ts`：`indexMp4` 换成 `indexVideo`；Matroska 不再退回 `<video>`。

### 点 2 — 测试与语料
- **新增** `mkv.test.ts`：手造 EBML 字节覆盖 SimpleBlock / BlockGroup、负的相对时间码、未知大小的 Cluster、`TimecodeScale` 非缺省、`Colour`、lacing 报错、非视频轨、截断；本机 ffmpeg 现编一段带 B 帧的 H.264 / HEVC Matroska 做真实字节样例（命令写进注释）。
- **语料**：3816870245（Matroska H.264 3456×2160 120 fps，299 MiB）用 `indexVideo` 解析，帧数、关键帧数、首帧时间、时长与 ffprobe 一致；记下整段读的耗时。

## 步骤 2b — 只剩 WebCodecs 一条路

2026-11-16 用户：「不需要 webcodecs 不存在的兜底，我们是自编 cef。开始 2b」。

### 总体思路
场景视频纹理、用户视频（P11b）、dev 探针的 `videoTime` 三处都改用 `CodecVideoPlayer`，旧的 `<video>` 播放器整个删掉：没有 `VideoTexturePlayer`、没有 Blob → 对象地址 → 媒体元素、没有 `attachToDocument`、没有 P9c 的 `watchStall`。退回也一起删掉——没有 WebCodecs 的环境（只剩 Node 单测，单测一律注入解码器替身）不再考虑；拆不了包（分片 MP4、不认识的编码、Matroska 的 lacing 等）和解码失败一样按失败处理：记一条 warn、纹理保持全 0（场景视频图层透明、用户视频槽用缺省纹理），同 WPE 打不开视频时的表现。语料 60 段全部拆得了（步骤 1、3），用户视频按 WPE 的过滤只有 mp4。

帧来源从此只有 `VideoFrame`：`VideoSink.drawn`、`UserTextureFrame` 的视频一支、`GpuScene` 的两处拷贝都只认它。用户视频仍先整段读成 Blob（`file:` 响应没有长度，拆包要先知道总长；Blob 由 Chromium 换到磁盘），区间读取改成 `blob.slice(a, b).arrayBuffer()`。

dev 探针改成「精确解到那一帧」：给播放器加一个等跳转完成的 `seeked()`，跳转本来就是「从目标帧往回最近的关键帧喂起、丢掉早于目标帧的输出、目标帧到了才换当前帧」，到手的就是显示时间 ≤ 目标的最新一帧。bundle 视频由 `ProbeVideos` 自己建播放器、跳到目标、留一份 `clone()` 的帧给每个 draw、随即释放播放器；用户视频沿用来源表里的播放器（来源表在探针里是宿主暂停状态，时钟不走），写 `currentTime` 后等 `seeked()`。

`video/player.ts` 只剩公共定义（`SceneVideoSource`、`VideoReport`、`IDLE_FRAMES`、`SEEK_END_MARGIN`、`STALL_MS`、`videoSourceKey`）：`compile/bundle.ts`、`compile/tex.ts` 从它导入类型，这两个文件别的会话在改，不改名、不动导入。

### 现状锚点
**a. 两种播放器与退回**（`video/sceneVideos.ts`）
```ts
export type VideoFrameSource = VideoFrame | HTMLVideoElement;   // 现状：两种帧来源
private create(video: SceneVideoSource): SceneVideoPlayer {
  if (!this.codecs) return new VideoTexturePlayer(video, this.frame, { ...this.factories, report: this.report });  // 现状：没有 WebCodecs 用旧的
  const player: CodecVideoPlayer = new CodecVideoPlayer(video, this.frame, {
    ...this.factories, report: this.report,
    onUnsupported: (reason) => this.fallBack(player, reason),   // 现状：拆不了包退回旧播放器
  });
  return player;
}
```
**b. 用户视频**（`usertex/sources.ts:907`）
```ts
private newPlayer(shared: Shared, blob: Blob): VideoTexturePlayer {
  const player = new VideoTexturePlayer({ path: shared.value, start: 0, end: blob.size }, this.clock.frame, {
    ...this.deps.videoFactories, readBlob: () => Promise.resolve(blob), report: this.deps.report,   // 现状：<video> 播 Blob
  });
```
`seek` 读 `player.element.duration`、等元素的 `seeked`；`loadShared` 读 `player.element.videoWidth`；`UserTextureFrame` 的视频一支是 `{ kind: "element"; element: HTMLVideoElement }`。
**c. dev 探针**（`dev/videoProbe.ts`）：每段视频 `fetchVideoBlob` → 不挂 DOM 的 `<video>` → seek → 等 `seeked` 与 `readyState ≥ 2`，每个 draw 交出元素。
**d. GPU**（`render/scene.ts`）：`copyVideo(index, source: VideoFrameSource)` 两种尺寸都认；`uploadUserFrame` 对视频读 `frame.element.videoWidth` 并以元素为源拷。

### 点 1 — 播放器（`video/codecPlayer.ts`、`video/player.ts`）
- **删除** `CodecPlayerOptions.onUnsupported`、`takeScriptState`、`CodecScriptState`：拆不了包直接 `fail("场景视频不能拆包", 原因)`。文件头「读」一条改写（不再退回）；「卡住」一条不再提 `watchStall` 的替代关系以外的旧实现细节。
- **新增** `seeked(): Promise<void>`：没有在跳转（含拆包期间等着的 `pendingSeek`：等到建好解码器、那次跳转完成）、失败或释放时 resolve，不 reject。实现同 `firstFrame` 的等待表：`seeking` 落下（目标帧到手、成为当前帧）时结清。
- **修改** `CodecVideoProbe` 不再 `extends VideoPlayerProbe`，自己列全字段；去掉只对旧播放器有意义的 `totalFrames` / `droppedFrames`（就是 `decoded` / `dropped`）、`stallSeeks` / `stallReloads`；`decoder` 字段也去掉（只有一种）。
- **修改** `video/player.ts` 只留 `SceneVideoSource`（`duration` 的注释改成「读不出时播放器取帧表的时长」）、`VideoReport`、`IDLE_FRAMES`、`SEEK_END_MARGIN`、`STALL_MS`、`videoSourceKey`，文件头改成「场景视频的公共定义」，说明播放器在 `codecPlayer.ts`。**删除** `VideoTexturePlayer`、`VideoFactories`、`VideoPlayerOptions`、`VideoPlayerProbe`、`attachToDocument`、`fetchVideoBlob`、`STALL_SEEKS_BEFORE_RELOAD`、`STALL_MAX_RELOADS`、`HAVE_*` 与辅助函数。
- **新增** `blobRangeReader(blob: Blob): ReadRange`（放在 `codecPlayer.ts`，`fileRangeReader` 旁边）：`blob.slice(start, end).arrayBuffer()`，区间越界抛 `RangeError`，读到的长度核对同 `fileRangeReader`。

### 点 2 — 场景视频（`video/sceneVideos.ts`）
- **删除** `VideoFrameSource`、`ElementVideoProbe`、`codecs` 字段、`fallBack`、`SceneVideoFactories`（构造参数改为 `CodecFactories`）；`create` 只建 `CodecVideoPlayer`。
- **修改** `SceneVideoPlayer` 接口与 `VideoSink.drawn` 的返回类型为 `VideoFrame | null`；`SceneVideoProbe = CodecVideoProbe & { frame; textures }`；`firstFrames` / `firstFrameOf` 去掉「被顶替接着等」（`firstFrameOf` 简化为等当前播放器一次）。文件头「两种播放器」一条改成「播放器」：只有 `CodecVideoPlayer`，拆不了包与解码失败同样透明。

### 点 3 — 用户视频（`usertex/sources.ts`）
- **修改** `UserTextureFrame` 的视频一支改为 `{ kind: "video"; frame: VideoFrame }`；`VideoTexture.drawn` 交 `player.drawn(...)` 的帧。
- **修改** `newPlayer` 建 `CodecVideoPlayer({ path: shared.value, start: 0, end: blob.size }, frame, { ...this.deps.codecFactories, readRange: () => blobRangeReader(blob), report })`；`UserTextureDeps.videoFactories` 改名 `codecFactories: CodecFactories`（测试注入解码器替身；`readRange` 由来源表自己给，注入的会被覆盖）。`loadShared` 尺寸取 `player.videoWidth / videoHeight`（第一帧之后是显示尺寸）。
- **修改** `seek`：目标 = `seekTarget(time, player.duration)`，写 `player.currentTime = target` 后等 `player.seeked()`（保留 `SEEK_TIMEOUT_MS` 超时与日志）。失败的播放器不等。
- 类型 `VideoTexturePlayer` → `CodecVideoPlayer`、`VideoPlayerProbe` → `CodecVideoProbe`；文件头「加载」一条改写（Blob → 区间读取 → `CodecVideoPlayer`，颜色照 WPE 的规则，P9c「步骤 3 候选」里标清视频的偏色随之消掉）。

### 点 4 — GPU（`render/scene.ts`，共享文件，只改这两处，之后按块提交）
- **修改** `import type { VideoFrameSource, VideoSink }` → `import type { VideoSink }`；`copyVideo(index, source: VideoFrame)` 尺寸取 `displayWidth / displayHeight`，注释去掉「视频元素」「也可以是」的说法。
- **修改** `uploadUserFrame` 的视频一支：`frame.frame` 的 `displayWidth / displayHeight`，以 `frame.frame` 为源；注释「元素装不下」改「画面装不下」。

### 点 5 — dev 探针（`dev/videoProbe.ts`）
- **修改** `ProbeVideos`：第三个参数改为 `CodecFactories`（`probe.ts` 的调用点传 `{}`，不用改）。`prepareOne`：建 `CodecVideoPlayer(source, 0, { ...factories, report })`，`apply(0, true)`（宿主暂停：时钟不走），`await firstFrame()`，失败则标失败；否则 `currentTime = videoSeekTime(requested, player.duration)`，`await seeked()`，`player.drawn(0, true)` 取当前帧（跳转后 `fresh` 为真），`clone()` 存进 entry，记 `time`（读回的 `currentTime`）、`frameTime`（帧的 `timestamp / 1e6`，跳转后时间戳从 0 编，就是媒体时间）、`duration`、`width / height`（显示尺寸），然后释放播放器。总时限与 `ProbeVideoTimeout` 照旧（用 `beforeDeadline` 包住整段）；释放时关掉 clone 的帧。
- **修改** `drawn` 每次交出 clone 的帧（确定性优先，同以前每个 draw 都拷）；`ProbeVideoResult` 加 `frameTime`（失败时 null），`duration` 注释改「容器时长」。
- **删除** `waitFor`、`POLL_MS`、`HAVE_CURRENT_DATA`、`describe` 里 `MediaError` 的分支、`release` 里元素与对象地址的处理。
- `checkVideoVisibility` 保留不动：WebCodecs 不经 `DeferMediaLoad`，主窗口隐藏时可能已经能解，但要最小化用户的主窗口才能实测，留到步骤 4 问过再测。文件头改写成新做法。

### 点 6 — 测试
- **新增** `video/fakeDecoder.ts`：从 `codecPlayer.test.ts` 抽出解码器替身（`FakeFrame`、`FakeDecoder`、建工厂的函数、打开帧计数），`codecPlayer.test.ts` 改为导入它。
- **删除** `video/player.test.ts` 里旧播放器的全部用例（`videoSourceKey` 若有用例就留下）、`video/fakeVideo.ts`。
- **修改** `sceneVideos.test.ts`、`host.video.test.ts`、`usertex/sources.media.test.ts`、`dev/videoProbe.test.ts`（与 `probeUserTextures.test.ts` 若受影响）改用解码器替身 + `demux/testMp4.ts` 造的 MP4 字节；原来断言旧播放器行为（退回、`decoder: "element"`、元素事件、`watchStall`）的用例删掉或改成新行为：拆不了包 → `failed`、warn 一条、不交帧。
- **新增** 用例：`seeked()`（跳转中等到目标帧、拆包期间写的时间等到那次跳转完成、失败 / 释放时 resolve、没在跳时立即 resolve）；`blobRangeReader`（切片、越界、长度）；`ProbeVideos` 交出的是目标帧（关键帧之间的时刻取 ≤ 目标的最新一帧、`frameTime` 对得上）、每个 draw 都交同一帧、释放后帧被关掉；用户视频 `seekVideos` 之后 `drawn` 交出目标帧。
- 打开的帧最后都被关掉（替身的计数为 0）。

## 实施记录

### 步骤 1 — MP4 拆包与解码配置（2026-11-14）

**实现**（子代理，只新增 `video/demux/` 下 `mp4.ts`、`config.ts` 与两个测试；语料脚本 `ignore/p9/p9d/step1/corpus.ts` 不入库）：
- `indexMp4(read, length)`：不抛错，失败给中文原因；`VideoTrackIndex` 另带 `sampleEntry`（codec 串前缀照它写，`avc3` / `hev1` 也认）与 `editMediaTime`。
- 编辑列表只接受「没有」或「恰好一段、`media_time ≥ 0`、速率 1」，段长不截尾；表的一致性查得严（`stsc` 样本项序号必须是 1、`stts` / `ctts` 覆盖的样本数等于 `stsz`、样本落在数据范围内），`stz2`、`moof` 报原因。
- 时长：有 `mvhd` 时和 `containerDuration` 一致；没有或为 0 时退到 `mdhd`、再退到 `stts` 总长。`container.ts` 的函数没导出，`mp4.ts` 按同样的盒子规则与上限另写了一份。
- 颜色：矩阵码 2（未指定）当作没标、继续找下一个来源；范围有 `colr` 用 `colr`，否则用 VUI 的 `video_full_range_flag`（VUI 没有颜色描述也用），都没有为 limited；`colr` 也认 QuickTime 的 `nclc`。`wpeColor` 给出来源与一句说明，供日志与语料扫描。
- 测试用了真实字节：语料 2887099508 / 3400241651 的 SPS（后者带防竞争字节）、3822149301 的 hvcC；本机 ffmpeg 现编的 AVC-Intra 100 / 50（SPS 里带 scaling list）、High 320×180（裁剪、full 范围、矩阵 6）、Baseline、libx265 360p。

**验收**：
- tsc 0 error；`src/video` 151 个用例全过（demux 61 个）；Prettier 通过。
- 变异 13 个全部有测试挂掉：ctts v1 当无符号、co64 当 stco、编辑列表不扣 `media_time`、缺 `stss` 当全不是关键帧、`stsc` 的 first_chunk 不减 1、8×8 scaling list 当 4×4 跳、4:4:4 只跳 8 个 scaling list、HEVC 兼容标志不反序、不去防竞争字节、矩阵码 2 不当没标、分辨率阈值 ≥ 改 >、se 符号取反、场编码纵向裁剪不乘 2。
- 语料（Claude 复跑）：60 段里 59 段 MP4 全部解析成功，1 段 Matroska 跳过（3816870245）。帧数、codec、宽高与 `vtex.json` 一致，时长与 `mvhd` 逐段相等，首帧显示时间都是 0；ffprobe 抽查全部 59 段的包数、关键帧数、首帧 pts 一致。每段读 3–5 次、0.4–4.3 ms，最多读 247 KB。色彩：VUI → bt709 29 段、`colr` → bt709 14 段、按分辨率 → bt709 14 段、VUI → smpte170m 2 段（3400241651 960×540；**3812007032 是 4K 却标了 `bt470bg`**，WPE 在 4K 上是否照码流用 601 留到步骤 4 实测）。唯一的「不一致」是设计如此：3822149301（HEVC）码流 VUI 标 bt709，我们只认 `colr`、走分辨率规则，结果同为 bt709。

### 步骤 2a — WebCodecs 播放器（2026-11-14）

**实现**（子代理新增 `video/codecPlayer.ts`、`codecPlayer.test.ts`、`video/demux/testMp4.ts`（从 `mp4.test.ts` 抽出的造 MP4 工具），改 `video/sceneVideos.ts` 与测试、`script/api.ts`；Claude 改 `render/scene.ts` 的 `copyVideo`）：
- **退回**：`SceneVideos.load` 仍同步建播放器；有 WebCodecs 时建 `CodecVideoPlayer`，它异步拆包，`indexMp4` 失败时经 `onUnsupported` 让 `SceneVideos.fallBack` 换成旧播放器（核对区间键仍是它 → warn 一条 → `takeScriptState()` 收走想放 / loop / rate / 结束回调 / 拆包期间写的时间 / `lastDrawn` → 建 `VideoTexturePlayer` 设回去）。拆包期间没有帧、时钟没走，脚本能改的只有这几项；脚本每次经 `playerFor` 现取。读本身失败（文件不在、长度不符）直接失败、不退回。没有 WebCodecs（Node 单测）时直接用旧播放器。`firstFrames` 按区间键等，被顶替时接着等新的。
- **时钟与时间戳**：`clock` 从本次跳转的 0 点起展开、不绕回，`loops` 记遍数，媒体时间 = `clock − loops × 时长`；喂进解码器的时间戳 = `round((n × 时长 + 样本显示时间) × 10⁶)`，挑帧直接比 `timestamp ≤ round(clock × 10⁶)`。循环时不 flush、接着喂下一遍；不 loop 时喂到结尾 flush 一次，时钟停在时长、`ended`，挑帧上限减 1 µs。跳转时 reset + configure，`clock` 设为目标，遍数归零，登记喂进去的时间戳，不在登记里的输出是 reset 之前的残留、直接关掉。「在放」= 画到过一次、出了第一帧、不在跳转中、想放、宿主没暂停、没空闲、没结束；凡改变它的地方先 `advance()` 结清之前的墙钟。
- 和计划的出入：`rate` 收任何非负有限数（新时钟不受 Chromium 的 [0.0625, 16] 限制），负数按 0、非有限值不收；跳转期间当前帧保留到目标帧到达、时钟停着；丢帧只计被越过的已解出帧；卡住判定另要求「喂帧不在等读盘」；第一帧之前就画到时，时钟从第一帧到达时起步；流控 `decodeQueueSize + 已解出未显示 < 8` 不含硬件解码器内部为 B 帧重排攒的帧。

**验收**：
- tsc：视频与脚本相关文件 0 error（剩 `src/puppet/player.test.ts` 一处，别的会话改动中）。`src/video src/script` 17 个文件 345 个用例全过；全量 4134 个里 4 个失败都在 `compile/`（`mdl.test.ts` 3 个、`pipeline.test.ts` 语料 1 个），对应文件在别的会话里改着。Prettier 通过。
- 变异 14 个全部有测试挂掉：挑帧 ≤ 改 <、空闲时时钟仍前进、循环不加 n×时长、跳转从目标样本而不是关键帧喂、越过的帧不 close、卡住阈值失效、流控上限 < 改 ≤、退回判断取反、没画到就起步、不丢早于目标的输出、不 loop 时不停在时长、读失败也退回、跳转不 reset 解码器、交接不带结束回调。
- 真机（桌面壁纸 14295「Miku Monitoring」，3585875739 的 4K H.264，`colr` → bt709；宿主重建后 iframe 重载）：`decoder: "webcodecs"`，时长取 `mvhd` 12.758 s（旧路线是 Chromium 的 12.757333）；连续 30 s 每秒采样：媒体时间每秒走 1.000 s，在 12.758 s 处绕回、接着播，解码每秒 60 帧，丢 0 帧，`stallResets` 0，解码队列 + 待显示 3–5 帧。

### 步骤 3 — Matroska 拆包（2026-11-15）

**实现**（子代理新增 `video/demux/mkv.ts`、`index.ts`（`indexVideo` 按 EBML 魔数分派）、`testMkv.ts`、`mkv.test.ts` 与两段 ffmpeg 现编的样例 `h264-bframes.mkv`（30 帧带 B 帧、有 Colour）/ `hevc.mkv`（24 帧带 B 帧）；`container.ts` 只加 export；`codecPlayer.ts` 改用 `indexVideo`；两个「拆不了要退回」的用例改用全 0 字节；Claude 改 `sceneVideos.ts` 的过时注释）：
- 按 4 MiB 一块顺序读、只记块头；元素跨块边界时接着读，要跳过的元素越过手里的块时从跳到处重读。未知大小的 Segment / Cluster 读到下一个同级或上级 ID 为止。只收第一条视频轨，只对视频轨查 lacing。
- 时间扣全部帧里最小的显示时间（B 帧时解码顺序第一帧未必最小），`editMediaTime` 用 Matroska 时间码单位、`timescale = 1e9 / TimecodeScale`；时长 = `Info.Duration × TimecodeScale`，没有时退到「最大显示时间 + 相邻差的中位数」（只有一帧时退到 `DefaultDuration`）。`Colour` 填进 `colr`，缺的码值记 2（未指定）。
- 和计划的出入：不读 `Cues`（帧表靠顺序扫 Cluster）；视频轨带 `ContentEncodings`（头部剥离会让块数据不完整）、Cluster 出现在 Tracks 之前都报原因；编码不支持或没有视频轨时在 Tracks 处就失败、不往下读。

**验收**：
- tsc 0 error（`script/api.ts` 一度有 2 个错误，是 P11d 改到一半，复跑消失）；`src/video` 7 个文件 212 个用例全过；Prettier 通过。
- 变异 14 个全部有测试挂掉：关键帧标志位取错、相对时间码当无符号、忽略 TimecodeScale、未知大小 Cluster 不按同级 ID 结束、跨块边界的元素截断、lacing 不报错、有 ReferenceBlock 仍当关键帧、首帧时间不扣、`indexVideo` 分派取反、扣解码顺序第一帧、时长退路取最大差、收了别的轨的块、Range 1 当 full、块数据偏移少去一字节。
- 语料 3816870245（13632「鸣潮清宵」，Matroska H.264 3456×2160 120 fps）：7049 帧、29 个关键帧、首帧 0（扣 0.023 s，音轨从 0 开始）、时长 58.793，逐包 pts / size / 关键帧 / 位置与 ffprobe 无差异；Node 里 201 ms（76 次读，读 311 MB）。
- 真机：13632 因 `text:msdf:*` 退回预览图，强制渲染开关也没让它渲染；改在主窗口页面里经 vite `/@fs/` 直接导入 `codecPlayer.ts`，用 rAF 驱动 `CodecVideoPlayer` 20 s、每帧拷进 WebGPU 纹理（不建 DOM，结束全部释放）：浏览器里 `indexVideo` 809 ms（原来读成 Blob 是 508 ms），`decoder: "webcodecs"`，每秒解 120 帧、拷 120 次，时钟每秒走 1.000 s，丢 19 帧（多在开头），`stallResets` 0，没有 warn。

### 步骤 2b — 只剩 WebCodecs 一条路（2026-11-16）

**实现**（子代理；Claude 补 `usertex/sources.media.test.ts` 一条用例、改 `dev/probe.ts` 一句过时注释）：
- 删 `VideoTexturePlayer` 与 `fakeVideo.ts`，`video/player.ts` 只剩公共定义；`CodecVideoPlayer` 去掉退回（`onUnsupported` / `takeScriptState`），拆不了包直接失败；加 `seeked()` 与 `blobRangeReader`；`CodecVideoProbe` 自己列字段，去掉 `totalFrames` / `droppedFrames` / `stallSeeks` / `stallReloads` / `decoder`。
- `SceneVideos` 只建 `CodecVideoPlayer`，`firstFrames` 直接等播放器；`VideoSink.drawn` 与 `UserTextureFrame` 的视频一支（`{ kind: "video"; frame }`）只交 `VideoFrame`，`render/scene.ts` 只改 import、`copyVideo`、`uploadUserFrame` 的视频一支。
- 用户视频：Blob → `blobRangeReader` → `CodecVideoPlayer`，`UserTextureDeps.videoFactories` 改名 `codecFactories`；`seekVideos` 写 `currentTime` 后等 `seeked()`。
- 探针：每段视频建播放器（宿主暂停）→ `firstFrame()` → 写 `currentTime` → `seeked()` → 取当前帧 `clone()`、释放播放器，每个 draw 交同一帧；结果多 `frameTime`。
- 和计划的出入：`render/p9a.test.ts`、`render/p11b.test.ts` 的替身跟着改成 `VideoFrame`（不改过不了类型检查）；`host.video.test.ts` 里 `SceneHost` 自己 `new SceneVideos`，改为桩全局 `VideoDecoder` / `EncodedVideoChunk` / `fetch`；`sceneVideos.test.ts` 里「建好就播」「加载时就没画到的先播 30 帧」两条按新时钟（第一次画到才起步）改写；用户视频「没有画面尺寸 → 失败」换成「不认识的封装 → 失败」。

**验收**：
- tsc 0 error（含别的会话的文件）；引用视频模块的 46 个测试文件 859 个用例全过；Prettier 通过。
- 变异 8 个全部有测试挂掉：`seeked()` 立即返回、目标帧到手不结清、失败不结清、Blob 越界不查、探针不按时长取模、探针不 `clone`、拆不了包不失败、用户视频 seek 不等（这一条起初漏了：替身在微任务里出帧，等不等结果一样；补了「解码器停住时 `seekVideos` 不返回」的用例后挂掉）。
- 真机（屏外宿主，重建的 dev 产物）：
  - 14295（4K H.264 60 fps）`videoTime: 1` → `frameTime` 1.0；`videoTime: 13` → 按时长 12.758 取模 0.242、`frameTime` 0.233333（≤ 目标的最新一帧）；同一请求两次像素摘要相同。
  - p11-ut 临时导入，属性 `ut` 设为 P11b 的彩条片 `ut-video.mp4`（320×240、未标）、`videoTime` 0.5：用户视频 ready，矩阵按分辨率取 smpte170m，渲染出的颜色 (254, 0, 0) 与 ffmpeg 按 BT.601 解出的 (253, 0, 0) 差 1。P11b 记的「屏外探针拿不到用户视频的帧」随 `<video>` 一起消失。测完 `projects_remove` 移除。
  - 先要用 `set_wpe_web_user_properties` 把文件写进属性：探针请求里给的 `userProperties` 不进 `file:` 放行（`deny file: … OutsideRoot`），这是 P11b 起就有的规则。
- 实时播放没有重测：场景视频的播放路径和 2a 相同（2a 已在桌面实测）；用户视频换成同一个播放器，桌面 / 预览里的实时播放留到步骤 4 一起看。

### 步骤 4 走查第一轮 — 视频纹理的颜色（2026-11-16，按 FINAL_CHECK）

做法：每张建复制工程（`kbp content isolate`，只留视频图层，工程在 `ignore/p9/p9d/walk/`），WPE 1920×1080 测试窗口抓一帧（`A:\p9d\walk\`，fps 20、后处理 ultra），存下视频纹理（WPE 的视频 RT，原尺寸）；从 `.tex` 切出 MP4，ffmpeg 逐帧缩小比对找出 WPE 显示的那一帧，取原始 yuv420p，用不同的「色度上采样位置 × 矩阵 × 取整」重建 RGB，分别和 WPE、和我们比（脚本在会话临时目录 `p9d2b/`：`match.py`、`yuvmodel.py`、`fit.py`）。

| 样本 | 视频 | WPE 显示的帧 | 还原 WPE 的写法 | 和 WPE |
|---|---|---|---|---|
| 3823859141 | H.264 1920×1080，标 bt709 | 11.966667 s | 709，色度纵向 2k − 0.5 | 最大 1，81.0% 相同 |
| 3400241651 | H.264 960×540，**标 bt470bg** | 8.666667 s | **709**，同上 | 最大 1，97.8% 相同（按 601 最大 7） |
| 3822149301 | HEVC 2560×1440，标 bt709 | 8.033333 s | 709，同上 | 最大 1，75.5% 相同 |
| 3812007032 | H.264 3840×2160，**标 bt470bg** | 8.533333 s | **709**，同上 | 最大 1，77.3% 相同（按 601 平均 5.3、最大 22） |

结论：
1. **色度上采样的位置**（最小二乘拟合 WPE 的纹理，4×4 邻域、按像素相位分四组，残差 rms 0.16–0.17）：WPE 是双线性，权重 9/16、3/16、3/16、1/16；横向色度样本在两个亮度像素正中（同标准），**纵向第 k 个色度样本在亮度第 2k − 0.5 行**，比标准（2k + 0.5，Chromium 的 `copyExternalImageToTexture(VideoFrame)` 即如此）高一行。
2. **我们和 WPE 的整帧**（3823859141，1:1，`render_scene` 取 11.966667 s、canvas 1920×1080、ultra）：58.2% 的像素有差，平均 1.22、最大 45。我们的图按「标准位置、709、四舍五入」重建时 92.5% 相同、最大 2；按 WPE 的位置重建就是和 WPE 的差。**差异全部来自纵向色度位置**，剩下 ±1 是两边各自的算术精度。
3. **矩阵**：场景视频四张都是 BT.709，包括码流标 bt470bg 的两张（一张 540 高、一张 4K）。WPE 不读码流的矩阵、也不按分辨率选；我们的 `wpeColor` 照码流取 601，这两段（语料里仅有的两段）现在偏色。用户视频（P11b，320×240、未标）步骤 0 记的是 WPE 用 601，走的是不是另一条路径这轮没测。
4. 时刻：WPE 开窗后约 8.0–12.0 s 显示的帧，和 ffmpeg 的 pts 逐帧对上；本轮只为找帧，没有核对开场与循环点（留给下一轮）。

没做：Matroska（3816870245）、用户视频、经过缩放的整帧（4K 视频画进 1080 窗口）、时间轴（开场、循环点、跳转、编辑列表）。

### 场景视频的矩阵恒为 BT.709（2026-11-16）

用户：「只改矩阵吧」（色度位置记为已知差异，不读回 YUV 自己转换）。

- **修改** `video/demux/config.ts`：新增 `ColorRule = "scene" | "user"`，`decoderConfig` / `wpeColorSpace` / `wpeColor` 必须给规则。场景视频矩阵恒为 bt709（`source: "scene"`，码流的标签只进说明）；用户视频照旧（`colr` → VUI → 按分辨率）。原色、传递函数、范围两条路径相同。文件头补走查依据与色度位置的已知差异。
- **修改** `video/codecPlayer.ts`：选项 `colorRule`，缺省 `"scene"`；`usertex/sources.ts` 建用户视频播放器时传 `"user"`。
- **测试**：`config.test.ts` 原有用例改为显式 `"user"`，新增场景规则两条（标 bt470bg 的 540p / 4K、未标的标清与 colr 601 都是 bt709，范围照码流）；`codecPlayer.test.ts` 新增「缺省场景 → 240 高也是 bt709、`user` → smpte170m」；`sources.media.test.ts` 的探针用例断言用户视频走分辨率规则；`mkv.test.ts` 跟着补参数。tsc 0 error，`src/video src/usertex` 等 16 个文件 349 个用例全过，Prettier 通过；变异 3 个（场景规则不生效、用户视频不传 `user`、播放器缺省改 `user`）全部有测试挂掉。
- **真机**：3400241651 复制工程（标 bt470bg、960×540）取 8.666667 s，用探针逐 draw 轨迹读回「鱼」的合成 RT（960×540，视频 1:1 画进去），和 WPE 同一 RT 比：平均 0.170、最大 22、6.3% 不同；我们的 RT 按「709、标准位置」重建 99.4% 相同、最大 2，WPE 的按「709、2k − 0.5」重建 97.8% 相同、最大 1，两个模型之间的差就是这 22——剩下的只有色度位置。改之前我们按 601，比 WPE 多一层整体偏差（按 601 重建和 WPE 最大差 7）。整帧两边都是全黑（这张场景单留「鱼」时上屏混合结果为黑），所以比的是合成 RT。
- **已知差异（定）**：色度上采样的纵向位置。WPE 第 k 个色度样本在亮度第 2k − 0.5 行，Chromium 拷 `VideoFrame` 时在 2k + 0.5 行；颜色在纵向剧烈变化的边缘差到几十级（3823859141 整帧 58% 像素有差、平均 1.22、最大 45；3400241651 合成 RT 最大 22）。照它要 `VideoFrame.copyTo` 读回 YUV、自己的着色器转换，用户定不做。

### 步骤 4 走查第二轮（2026-11-16）

**Matroska**（3816870245，复制工程只留对象 21，1728×1080 窗口，`A:\p9d\walk\d3816870245-frame186.rdc`）：WPE 显示 ffmpeg pts 9.340 那一帧（我们的时间轴扣首帧 0.023 s，即 9.317）；按「709、色度纵向 2k − 0.5」重建 WPE 的视频纹理最大差 1、73.3% 相同。规则同 MP4。

**经过缩放的整帧**（同一张，3456×2160 画进 1728×1080，正好 0.5 倍）：我们（`render_scene` 取 9.317 s、canvas 1728×1080、ultra）对 WPE 整帧 41.3% 像素有差、平均 0.476、最大 17。两边各自「按自己的色度位置重建纹理 → 2×2 平均（0.5 倍时采样点在纹素角上，双线性即四个的平均；WPE 是 8 倍各向异性、单 mip，等比时同样）」和自己的整帧都只差 ≤ 2（WPE 用它的实测纹理 2×2 平均对整帧 ≤ 1），两个模型之间正好最大 17。缩放一步两边相同，差异仍然只是色度位置。

**用户视频的矩阵**（p11-ut，属性 `ut` 逐个换成生成的测试片，`A:\p9d\walk\ut\`，测试片在 `ignore/p9/p9d/walk/ut/`）：
- 方形 testsrc2 静帧（整张进 1:1 槽，不裁）：`sd-unl` 480² 未标 → 601；`sd-709` 480² **标 709 → 601**；`hd-unl` 720² 未标 → 709；`hd-601` 720² **标 601 → 709**。四张按「对应矩阵、2k − 0.5」重建最大差 3（≥ 2 的像素 0.02%–0.2%，都在蓝 / 红高饱和处，定点系数的精度），换另一个矩阵平均差 16–25。
- 纯色片（YUV 102 / 128 / 190：601 → (199, 50, 100)、709 → (211, 67, 100)，取纹理中心）：1280×480 → 601；480×720 → 709；720×576 → 601；**720×578 → 709**；1024×700 → 709。
- 结论：WPE 读用户视频**不看码流标签，只按高度：高 > 576 用 709，否则 601**（宽度不参与）。我们现在的 `"user"` 规则（先看 `colr` / VUI、阈值 720）三处不对：标签、阈值、576 < 高 < 720 的片子。色度位置同场景视频（2k − 0.5）。

**时间轴**（WPE 侧用 P9 步骤 0 的 `p9-clock` 实测，p9-REPORT「时钟、循环与显示的帧」；我们这边在主窗口页面经 vite `/@fs/` 导入 `CodecVideoPlayer`，rAF 驱动 12 s 播 `ignore/p9/media/v60-151.mp4`（60 fps、151 帧、mvhd 2.517、elst media_time 512/15360 = 2 帧），不建 DOM、结束释放）：

| 项 | WPE | 我们 | 判定 |
|---|---|---|---|
| 编辑列表 | 认：显示帧号 − 当前时间 × 60 ∈ [−1.39, −0.09]；不认的话会整体再小 2 帧 | 认（拆包扣 media_time，帧时间与 ffmpeg 的 pts 逐帧相同，走查各张都对上） | 相同。P9a 记的 3824550659「差 4 帧」是旧 `<video>` 路线 |
| 时钟步长 | 和场景时间步长相同，抓帧那几帧多走 / 少走约 11 ms（媒体引擎自己的实时时钟） | 每墙钟秒 1.000 s | 相同语义；WPE 的抖动来自它的时钟线程，不复刻 |
| 显示哪一帧 | 当前时间之前的帧，落后 0.09–1.39 帧，均值 0.84 | 落后 0.07–0.81 帧，均值 0.37（rAF 144 Hz 时取「≤ 时钟的最新一帧」） | 已知差异：WPE 多出约半帧，是帧服务器 `TransferVideoFrame` 的转交延迟；我们按定义取当前帧 |
| 循环 | 每轮 2.5196 s（标准差 2.9 ms），循环点停约 2.6 ms | 每轮正好时长（实测 rAF 粒度内 2.5165–2.5167），不停 | 已知差异：WPE 的停顿是媒体引擎回绕的开销、有抖动，不复刻 |
| 开场 | `init` 时 0，之后视频时间 ≈ 场景 runtime − 36.5 ms | 第一次画到、第一帧到手时起步（本次 42 ms 拿到第一帧，起步时 currentTime 0） | 已知差异：WPE 的 36.5 ms 是媒体引擎的启动延迟；宿主 ready 前等第一帧，我们的视频时间 ≈ 场景时间，比 WPE 早约 2 帧（60 fps） |
| 时长 | mvhd | mvhd（`source.duration` 取容器时长） | 相同 |

时间轴的差异都是「WPE 的视频时钟在媒体引擎的线程上、和渲染帧之间有延迟与抖动」，每帧显示哪一帧在 WPE 那边本身不确定。走查的回放按 FINAL_CHECK 把它当输入还原（从 WPE 的画面认出帧、`videoTime` 取那一帧），画面比较不受影响。

**第二轮结论**：
- 场景视频：颜色、Matroska、缩放、编辑列表都只剩已知差异（色度位置、时钟的延迟与循环停顿、开场 2 帧）。
- 要修的一处：用户视频的矩阵（按高度 > 576、不看标签），见上「用户视频的矩阵」。

**用户视频的矩阵：不改（2026-11-16）**。用户：「我觉得这一点应该算 wpe 的 bug，不改」。WPE 读用户视频不看码流标签记为 WPE 的缺陷，我们照标签（`"user"` 规则不变：`colr` → VUI → 没标按分辨率），有意不同；依据：用户视频不在语料里，没有画面依赖它（同「语料依赖的 WPE 缺陷才复现」）。记进 `video/demux/config.ts` 文件头。没标时的分界 WPE 是 576、我们是 720（高 577–719 的未标片两边矩阵不同），也没改。场景视频的「恒为 709」是语料画面依赖的（两段标 bt470bg 的语料作者在 WPE 里看到的是 709），保留。

**用户视频没标时的分界对齐 WPE（2026-11-16）**。用户：「可以对齐」。`MF_HD_MIN_HEIGHT = 720`（高 ≥ 720 用 709）改为 `MF_SD_MAX_HEIGHT = 576`（高 > 576 用 709，否则 601，宽度不参与），照走查的纯色片实测。标签照旧优先（上一条的有意不同不变）。测试改成走查的四个尺寸（720×576 → 601、720×578 → 709、1280×480 → 601、480×720 → 709）；tsc 0 error，引用视频模块的 48 个文件 905 个用例全过，Prettier 通过；变异 2 个（分界不含 576、阈值改回 719）都有测试挂掉。

**主窗口隐藏时的探针（2026-11-16）**。用户把主窗口最小化后实测：主窗口页面 `visibilityState` 为 `hidden` 时，`CodecVideoPlayer` 40 ms 出第一帧、跳到 1 s 拿到时间戳 1 000 000 的那一帧，没有告警（WebCodecs 不经 Chromium 的 `DeferMediaLoad`）。于是删掉探针的 `checkVideoVisibility`（P11b 步骤 5 为 `<video>` 加的「不可见就报错」）与只给它用的 `userVideoValues`，`dev/probe.ts` 只删调用与两处导入；重建宿主后在最小化状态下 `render_scene` 14295 `videoTime: 1`，像素摘要 `56c1095e…` 与窗口可见时逐字节相同。tsc 0 error，`src/dev` 17 个文件 194 个用例全过，Prettier 通过。`cocs/wpe/WPE_SCENE.md` 里「屏外宿主要用视频时主窗口不能最小化」一句留到步骤 4 改文档时删。

### 步骤 4 — 收尾（2026-11-16）

- `cocs/wpe/WPE_SCENE.md`：「视频纹理（P9a）」整节按 P9d 重写为「视频纹理（P9a、P9d）」（拆包、播放器、颜色、已知差异、走查、dev 探针；删去挂进页面与 P9c 卡住兜底两段）；「用户纹理」里视频一条改为 `CodecVideoPlayer` 与用户视频的颜色规则，删去「主窗口不能最小化」，「标清视频偏色」的已知差异改为「标了色彩标签的用户视频」；`IVideoTexture` 表的 `rate` 一行改为非负有限数都收。
- `cocs/README.md`：WPE_SCENE 条目的「视频纹理」与「用户纹理」两条、适用场景里视频相关的几句。
- `versions/latest/regression.md`：新增「场景壁纸视频改用 WebCodecs（P9d）」Y0–Y10，已勾 Y0–Y7，Y8（预览里的用户视频实时播放）待用户，Y9（长时间播放）按用户要求未长测，Y10（拆不了包）只有单测。
- `versions/latest/changelog.md`：用户侧 Optimized 一条、开发侧 Changed 一条；P11b 用户侧那条里「标清视频的色彩有细微差别」改为「JPEG 与视频在颜色剧烈变化的边缘有细微差别」。
