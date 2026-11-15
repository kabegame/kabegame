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
