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
2. **WebCodecs 播放器**：`VideoTexturePlayer` 换内部（区间读取与预读、解码流控、媒体时钟、挑帧、跳转、循环预滚、暂停、速率、结束、解码器卡住重置、帧的释放）；`VideoSink.drawn` 交出 `VideoFrame`，`GpuScene.copyVideo` 跟着改；删 `<video>`、Blob、`attachToDocument`、`watchStall`；`host.videos()` 探针换字段；`usertex/sources.ts` 跟着换读取方式。
3. **Matroska 拆包**：EBML、`Tracks`（`CodecPrivate`）、`Cues`、按 Cluster 流式读 SimpleBlock / BlockGroup。
4. **对照与收尾**：dev 探针 `videoTime` 改为精确解到那一帧；和 WPE 对照时间（循环点、一帧内跳转、开场、编辑列表）与颜色（SD / HD 未标的分界）；语料；文档、回归、changelog。

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
