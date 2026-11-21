# P9e — Matroska 里的 VP9 视频纹理（子计划）

起因（2026-11-21）：15026（工坊 3662390671）的背景图层 `Scene` 是整张画面，它的 `.tex` 里嵌的是 WebM（Matroska）封装的 VP9，拆包
报「视频编码 V_VP9 不支持」，图层透明，整张壁纸只剩前景。用户定：只做 Matroska 的 VP9，AV1 / VP8 / MP4 里的 `vp09` 不做。

同一张壁纸的另一条日志「No valid audio layers found. Script sopped.」是作者的问题：对象 43 的音乐播放器脚本把子图层当歌单，作者删光了
歌曲图层，`getChildren()` 为空；WPE 的 `log.txt` 里是同一句（`A:\p9e\vp9\` 抓帧时截的日志），不改。

## 总体设计思路

VP9 只差拆包。WebCodecs 本来就能解 VP9（本机 CEF 实测软硬解都支持，`vp09.00.41.08` 等），播放器的时钟、流控、跳转、颜色都和
H.264 走同一条路；Matroska 的帧表（扫 Cluster 记块头）原样可用，VP9 没有 B 帧，显示顺序就是解码顺序。所以改动集中在两处：
`mkv.ts` 认 `V_VP9` 并从码流里取出解码配置需要的信息，`config.ts` 按这些信息拼 codec 串与颜色。

VP9 的解码配置不像 H.264 那样有 avcC：Matroska 规范里 VP9 的 `CodecPrivate` 可有可无（这张就没有），有时也只是可选的
「codec feature metadata」。profile、位深、色度采样、color_space、color_range 都在每个关键帧的未压缩帧头里，是码流里的权威值，
所以扫 Cluster 时遇到这条轨的第一个关键帧，就把它开头的几十个字节读出来解析一次（`vp9.ts` 的 `parseVp9KeyFrame`），存进帧表的
`vp9` 字段。codec 串 `vp09.PP.LL.DD` 还要一个 level：Chromium 只认合法的 level 值、不按它判断支不支持（实测 1080p 写 level 10
也支持、写 15 不支持），有 `CodecPrivate` 的 level 就用它，否则照 VP9 规范附录 A 的表按「画面像素数 × 帧率」挑最小的合法 level
（帧率取帧表相邻显示时间之差的中位数）。VP9 不用 `description`，配置里不给。

superframe（libvpx 把隐藏的 alt-ref 帧和下一个显示帧打成一块）整块就是一个 chunk，WebCodecs 自己拆，解码器每块出一帧，和帧表一一对应；
关键帧块的第一个子帧就是关键帧（libvpx 的写法），所以帧头只看块的开头，不是关键帧头时失败并给出原因。

颜色沿用现有两条规则：场景视频矩阵恒为 BT.709（这张 1080p、码流未标，按哪条规则都是 709）；用户视频在 `colr`（Matroska 的
`Colour`）之后、按分辨率之前，多一个来源「VP9 帧头」（color_space 映射成 ISO/IEC 23091-2 的矩阵码，同 ffmpeg），范围同样取帧头的
color_range。VP9 用户视频实际进不来（面板只给 `.mp4`、MP4 的 `vp09` 不做），这一支只为规则完整。

已知限制：Chromium 把 `prefer-hardware` 当成「必须硬解」，显卡不支持 VP9 硬解时视频透明，同 P9a 回归 V8 的 HEVC。

## 现状锚点

**a. 编码表只有 H.264 / H.265，`CodecPrivate` 必须有**（`video/demux/mkv.ts:92`、`:383`）
```ts
const CODECS: Record<string, { codec: "avc" | "hevc"; sampleEntry: VideoSampleEntry; config: string; min: number }> = {
  "V_MPEG4/ISO/AVC": { codec: "avc", sampleEntry: "avc1", config: "avcC", min: 7 },
  "V_MPEGH/ISO/HEVC": { codec: "hevc", sampleEntry: "hvc1", config: "hvcC", min: 23 },
};
// parseTracks 里：
if (!codec) fail(`视频编码 ${codecId} 不支持（只支持 V_MPEG4/ISO/AVC / V_MPEGH/ISO/HEVC）`);
const privateElement = find(ID.CodecPrivate) ?? fail(`${codecId} 视频轨缺少 CodecPrivate（${codec.config}）`);
```

**b. 块只读块头，不看帧数据**（`mkv.ts:472`）
```ts
async function block(state: State, element: Element, timecode: number | undefined, key: boolean | null): Promise<void> {
  ...
  const data = element.content + number.length + 3;
  state.frames.push(data, element.end - data, timecode + relative, key ?? (flags & 0x80) !== 0); // 现状：帧数据不读
}
```

**c. 帧表类型**（`video/demux/mp4.ts:34`）
```ts
export interface VideoTrackIndex {
  codec: "avc" | "hevc";
  sampleEntry: VideoSampleEntry;   // 现状：avc1 / avc3 / hvc1 / hev1
  description: Uint8Array;         // 现状：avcC / hvcC
  ...
}
```

**d. 解码配置与颜色**（`video/demux/config.ts:58`、`:85`、`:153`）
```ts
export function decoderConfig(track: VideoTrackIndex, rule: ColorRule): VideoDecoderConfig {
  return { codec: codecString(track), codedWidth, codedHeight, description: track.description, ... }; // 现状：总给 description
}
// wpeColor：矩阵来源 colr → H.264 SPS VUI → 分辨率；范围 colr → VUI → 缺省
// codecString：avc / hevc 两支
```

## 点 1 — VP9 码流工具（`video/demux/vp9.ts`，新增）

- **新增**
```ts
/** 第一个关键帧帧头里解码配置要用的字段，加上 level（CodecPrivate 写的，或按表算的）。 */
export interface Vp9Info {
  profile: number;           // 0–3
  bitDepth: number;          // 8 / 10 / 12
  subsamplingX: number;      // 0 / 1
  subsamplingY: number;
  /** 帧头的 color_space：0 未知、1 BT.601、2 BT.709、3 SMPTE 170、4 SMPTE 240、5 BT.2020、6 保留、7 RGB。 */
  colorSpace: number;
  fullRange: boolean;
  /** 帧头的 frame_width_minus_1 + 1 等。 */
  width: number;
  height: number;
  level: number;
  levelSource: "codecprivate" | "table";
}

/** VP9 规范附录 A：level、最大亮度采样率（每秒）、最大亮度画面（像素）。 */
export const VP9_LEVELS: readonly [level: number, sampleRate: number, pictureSize: number][];

/** 解析关键帧的未压缩帧头（frame_marker、profile、frame_type、sync code、color_config、frame_size）；不是关键帧或截断时抛错。 */
export function parseVp9KeyFrame(bytes: Uint8Array): Omit<Vp9Info, "level" | "levelSource">;

/** CodecPrivate 的 VP9 codec feature metadata（ID、长度、值的序列）里的 level（ID 2）；没有或畸形为 null。 */
export function vp9CodecPrivateLevel(bytes: Uint8Array): number | null;

/** 按表挑能容纳「宽 × 高」与「宽 × 高 × 帧率」的最小 level；帧率未知时只看画面；都超出取 62。 */
export function vp9Level(width: number, height: number, fps: number | null): number;

/** color_space → ISO/IEC 23091-2 矩阵码（同 ffmpeg 的 vp9 解码器）：0 → 2、1 → 5、2 → 1、3 → 6、4 → 7、5 → 9、6 → 2、7 → 0。 */
export function vp9MatrixCode(colorSpace: number): number;
```

## 点 2 — Matroska 认 `V_VP9`（`mkv.ts`）

- **修改**
  - `CODECS` 加 `"V_VP9": { codec: "vp9", sampleEntry: "vp09", config: "VP9 codec feature metadata", min: 0 }`，`codec` 的类型加 `"vp9"`；
    不支持时的提示加上 `V_VP9`。
  - `parseTracks`：VP9 的 `CodecPrivate` 可以没有（`description` 为空数组），H.264 / H.265 照旧必须有。
  - `State` 加 `vp9: Omit<Vp9Info, "level" | "levelSource"> | null`。
  - `block`：这条轨是 VP9、还没解析过、这块是关键帧时，读块数据开头 `min(大小, 32)` 字节交给 `parseVp9KeyFrame`，失败就整段失败
    （「VP9 第一个关键帧的帧头解析失败：…」）。
  - `finish`：VP9 没有解析到帧头时失败（「VP9 视频轨没有关键帧」）；level 取 `vp9CodecPrivateLevel(description)`，没有时按
    `vp9Level(宽, 高, 1 / 相邻显示时间之差的中位数)`；结果带 `vp9`。
  - 文件头注释的「轨」「帧」两条补 VP9。
```ts
const CODECS: Record<string, { codec: "avc" | "hevc" | "vp9"; sampleEntry: VideoSampleEntry | "vp09"; config: string; min: number }> = {
  "V_MPEG4/ISO/AVC": { codec: "avc", sampleEntry: "avc1", config: "avcC", min: 7 },
  "V_MPEGH/ISO/HEVC": { codec: "hevc", sampleEntry: "hvc1", config: "hvcC", min: 23 },
  "V_VP9": { codec: "vp9", sampleEntry: "vp09", config: "VP9 codec feature metadata", min: 0 }, // 新增
};
```

## 点 3 — 帧表类型（`mp4.ts`）

- **修改**
```ts
export interface VideoTrackIndex {
  codec: "avc" | "hevc" | "vp9";                  // 修改
  /** codec 串的前缀：MP4 的样本项类型；Matroska 的 VP9 为 vp09。 */
  sampleEntry: VideoSampleEntry | "vp09";         // 修改
  /** avcC / hvcC（不含盒头），即 VideoDecoderConfig.description；VP9 是 CodecPrivate 原样（可能为空），不交给解码器。 */
  description: Uint8Array;
  /** VP9 第一个关键帧的帧头与 level；H.264 / H.265 为 null。 */
  vp9: Vp9Info | null;                            // 新增
  ...
}
```
  - `indexMp4` 的结果加 `vp9: null`。

## 点 4 — 解码配置与颜色（`config.ts`）

- **修改**
  - `codecString`：VP9 为 `vp09.PP.LL.DD`（两位十进制）；4:2:2 / 4:4:4 时再加 `.CC`（02 / 03），4:2:0 不加（缺省即 4:2:0）。
  - `decoderConfig`：VP9 不给 `description`。
  - `wpeColor`：矩阵来源 `colr` → H.264 SPS VUI 或 VP9 帧头（`vp9MatrixCode`，码 2 当没标）→ 分辨率；范围 `colr` → VUI / VP9 帧头 →
    缺省。`ColorSource`、`rangeSource` 加 `"vp9"`，说明里写「VP9 帧头」。场景规则不变（恒为 709）。
  - 文件头注释补 VP9。

## 验证

**单测**（vitest，只跑 `video/` 下相关文件）
- `vp9.test.ts`：手拼帧头的 profile 0 / 1 / 2 / 3（位深、采样、RGB）、不是关键帧、sync code 不对、截断；level 表（1080p60 → 41、
  4K60 → 51、帧率未知只看画面、超出取 62）；CodecPrivate 的 level。
- `mkv.test.ts`：
  - ffmpeg 现编的 `vp9.mkv`（libvpx-vp9、带 alt-ref，有 superframe）帧数 / pts / 关键帧 / 大小 / 位置与 ffprobe 一致，`vp9` 字段对；
  - `vp9-10bit.mkv`（profile 2）的位深；
  - 手拼：没有 `CodecPrivate` 能拆、`CodecPrivate` 的 level 优先、第一个关键帧头坏了失败、没有关键帧失败。
- `config.test.ts`：VP9 的 codec 串（含 4:4:4 的 `.03`）、不给 `description`、场景规则 709、用户规则按帧头 / `Colour` / 分辨率。
- `codecPlayer.test.ts` 用替身解码器跑一段 VP9 帧表，确认配置交出去、帧能出来。

**变异**（按原字节还原）：level 表取错一档、profile 位序颠倒、位深分支反了、帧头只认 profile 0、`description` 照给、用户规则漏 VP9 帧头。

**真机**
- 15026（3662390671）预览：`host.videos()` 不失败、每秒解 60 帧、8 s 处绕回，背景出来。
- 按 FINAL_CHECK 走查：`kbp content isolate` 只留 `Scene` 的复制工程，WPE 抓帧取视频纹理，找到对应的视频帧，Kabegame 按同一帧
  `videoTime` 渲染，逐像素比（预期只剩色度纵向位置的已知差异）。

**检查**：wpe-scene 的 tsc、Prettier。

**文档**：`cocs/wpe/WPE_SCENE.md`「视频纹理」拆包一条补 VP9；`cocs/README.md` 的 WPE_SCENE 条目；`versions/latest/regression.md`
新增一节；`changelog.md` 一行。

## 实施记录（2026-11-21）

**实现**（Claude 直接写，范围同上）：
- 新增 `video/demux/vp9.ts` 与 `vp9.test.ts`；`mkv.ts` 认 `V_VP9`（`CodecPrivate` 可缺、第一个关键帧读 `VP9_HEADER_BYTES` 字节解析、`finish` 定 level；相邻显示时间之差的中位数抽成 `medianStep`，时长兜底与帧率共用）；`mp4.ts` 的 `VideoTrackIndex` 加 `vp9`、`codec` / `sampleEntry` 加 VP9；`config.ts` 的 codec 串、不给 `description`、用户规则的「VP9 帧头」来源。
- 样例：`vp9.webm`（两遍编码才有 superframe：一遍编码与 `testsrc` 都出不了；8 块 superframe、另有 1 字节的 show_existing_frame 块）、`vp9-10bit.webm`。ffmpeg 给的 `-colorspace` 等会同时写进 `Colour` 元素，所以两段样例的颜色都走 `colr`（`vp9.webm` 与语料一样只有 Range 1），「VP9 帧头」来源只由合成用例覆盖。

**验收**：
- tsc 0 error；`src/video/` 9 个文件 242 例全过，引用视频模块的 27 个文件加 `src/dev` 共 41 个文件 611 例全过；Prettier 通过。
- 变异 15 个全部挂掉（`mutate.py` 在会话临时目录）：level 表不看采样率、profile 两位颠倒、10 / 12 位反了、profile 1 不读色度采样、BT.601 的矩阵码写成 6、VP9 照给 `description`、用户规则漏 VP9 帧头、4:2:2 判反、codec 串 level 与位深对调、范围不取帧头、不用 `CodecPrivate` 的 level、每个关键帧都解析、帧率不进 level、VP9 也必须有 `CodecPrivate`、没有关键帧不失败。
- 语料（`ignore/p9/p9e/corpus.ts`）：3662390671 的 VP9 段 480 帧、4 个关键帧与 ffprobe 逐包相同，`vp09.00.41.08`；P9d 的 Matroska H.264 段（3816870245，7049 帧）仍逐包相同。本机库 88 个工程的 128 段视频纹理：124 段 MP4 H.264、2 段 MP4 HEVC、1 段 Matroska H.264、1 段 WebM VP9（这张）。
- 真解码器（主窗口页面里直接喂 `VideoDecoder`）：`vp9.webm` 软解 40 块 40 帧；硬解有最小尺寸，用 `ignore/p9/p9e/vp9-256.webm`（256×144，6 块 superframe）硬解、软解都是 40 块 40 帧、时间戳顺序不变。
- 硬解的最小尺寸（`isConfigSupported`，`prefer-hardware`，本机 RTX 4090 D）：VP9 128×128 起支持、160×90 / 192×108 不支持；HEVC 约 144；H.264 96×96 支持、64×48 不支持。语料最小 270×480，不受影响；记为已知差异（WPE 会退软解）。
- 宿主产物：正在跑的 dev 读 `target-dev`（dev 换过 `CARGO_TARGET_DIR`），`buildSceneHost.ts` 要给 `--out-dir`；先前误换了 `target/debug` 下的旧产物（当前 dev 不用它）。

**走查**（FINAL_CHECK）：
- WPE：`capture_wallpaper` 抓 3662390671（`A:\p9e\vp9\vp9-frame268.rdc`），`Scene` 图层的视频纹理（RT 12403，1920×1080）存 `wpe-scene-video-f268.png`；日志只有一行「Error: No valid audio layers found. Script sopped.」，和我们的脚本日志相同。
- 找帧：ffmpeg 解 0–8 s 按 1/8 灰度比，7.000 s 最近（`p9d2b/match.py`）。
- 重建（`p9d2b/yuvmodel.py`，原始 yuv420p）：WPE 的纹理按 709、limited、双线性、WPE 的色度位置 (0.5, −0.5)、四舍五入最大差 1（70.1% 相同）；Kabegame 的复制工程（`kbp content isolate --keep 185`，`ignore/p9/p9e/walk/3662390671-iso-scene-video`，`render_scene` `videoTime` 7）按标准位置 (0.5, 0.5) 最大差 1（91.6% 相同）。两边之间平均 2.63、最大 89、99 分位 26，全部来自色度纵向位置（已知差异，这张锐利彩色描边多）。复制工程已 `projects_remove`。
- 实时预览没测：用户当时开着别的预览，留给回归 VP8。

**回归**：`versions/latest/regression.md`「场景壁纸 VP9 视频纹理（P9e）」VP0–VP8（原写作 Z0–Z6，和 CEF 补丁 10 那节的前缀撞了，改成 VP），VP6–VP8 待测。

## 退到软解（2026-11-21，用户：「支持退回软解，避免别人显卡不能」）

### 总体设计思路

Chromium 把 `hardwareAcceleration: "prefer-hardware"` 当成必须硬解：`isConfigSupported` 只在有硬件解码器能接这份配置时才说支持，
`configure` 之后硬件初始化失败也是直接出错、不会自己换软解。P9d 一直传 `prefer-hardware`，所以显卡没有这种编码的硬解（老显卡的 VP9、
HEVC）、画面小于硬解的最小尺寸、驱动解码出错时，视频都是整层透明；WPE 的 Media Foundation 这几种情况都会退到软解。

做法是在播放器里分两处退：配置时先问硬解、不支持再问 `prefer-software`；运行中硬解的解码器出错（出错回调，或 Chromium 已关掉
它、错误回调还没到时 `decode` / `configure` 同步抛的 `InvalidStateError`）换成软解的新解码器，从出错时的媒体时间接着解。不用
`no-preference`：它的 `isConfigSupported` 不可靠（本机 HEVC 64×48 硬解、软解都不支持，它也说支持）。只退一次：软解再出错就是视频本身
的问题，照旧失败。换解码器时旧的那个还可能迟到地回调（出错、输出），所以解码器带代数，只认当前这一代。换的期间按跳转处理：时钟停着、
画面停在当前帧，新解码器的目标帧到了才接着走；脚本这期间写的时间记进 `pendingSeek`，新解码器从它开始。

### 实测依据（本机 RTX 4090 D，自编 CEF 156）

| 配置 | 硬解 | 软解 |
| --- | --- | --- |
| VP9 64×48 / 96×96 / 160×90 / 192×108 | 不支持 | 支持 |
| VP9 128×128、256×144 以上 | 支持 | 支持 |
| H.264 64×48 | 不支持 | 支持 |
| H.264 96×96 以上 | 支持 | 支持 |
| HEVC 64×48、160×90 | 不支持 | 不支持（自编 CEF 没有 HEVC 软解） |
| HEVC 144×144、2560×1440 | 支持 | 不支持 |

`no-preference` 在上面全部说支持（包括 HEVC 64×48），实际 `configure` 会出错。

### 实施

- **修改** `video/codecPlayer.ts`：
  - `prepare` 先 `supported(config)`（`isConfigSupported` 包一层，同步抛错与 reject 都当不支持并带回原因），不支持再
    `supported(softwareConfig(config))`，都不支持才 `fail`（说明写「硬解、软解都不支持」）；退到软解记一条 warn。
  - `open(config, acceleration)`：记下路径，代数加一，三个回调只认当前代（旧代的输出直接 `close()`）。
  - 新增 `decoderFailed`：出错回调、`pump` 里 `decode` 抛错、`seekTo` 里 `configure` 抛错都走它；硬解时 `fallBackToSoftware`，否则 `fail`。
  - 新增 `fallBackToSoftware`：结清时钟、记下媒体时间、关旧解码器（代数加一）、关掉已解出未显示的帧、清登记、`seeking = true`，
    问软解支不支持，支持就记 warn 并 `open(software, "software")`，否则 `fail`（「硬件解码出错、软件解码不支持」）。
  - `CodecVideoProbe.acceleration`，导出 `Acceleration`、`softwareConfig`；文件头「硬解优先、退到软解」一条。
- **修改** `dev/videoProbe.ts`：结果加 `acceleration`；失败原因改取最后一条 warn（之前可能有「改用软件解码」的提示）。
- **修改** `video/fakeDecoder.ts`：`configs`、`throwOnDecode`、`throwOnConfigure`，`supported` 可传按配置判断的函数。
- 测试：`codecPlayer.test.ts`「硬解优先、退到软解」12 例；原「解码器 error 就失败」三处（播放器、探针、用户纹理来源）改成软解的解码器出错。

### 验收

- tsc 0 error；`src/video/`、引用视频模块的文件与 `src/dev` 共 49 个文件全过；Prettier 通过。
- 变异 16 个全部挂掉：配置时不问软解、退到软解不记 warn、运行中出错不退、软解出错也再退、旧解码器的输出 / 出错不过滤、`decode` /
  `configure` 抛错直接失败、换的期间时钟不停、从 0 重来、出错时不结清时钟、不关旧解码器、软解不支持时照样开、probe 不报路径、
  探针留第一条 warn、探针结果不带路径。第一轮「旧解码器的输出不过滤」活下来（迟到帧的时间戳已经不在登记里，被登记挡掉），用例改成
  解码器不出帧、迟到帧的时间戳正好是新解码器在等的之后挂掉。
- 真机（宿主产物重建进 `target-dev`）：`ignore/p9/p9e/gen_small.py` 生成的 64×48 VP9 与 H.264 两个工程 `render_scene` 0.5 s 都出图、
  `acceleration` 是 `software`，应用日志各一条「场景视频改用软件解码（显卡不能硬解这段视频）」；15026 仍是 `hardware`、像素摘要与加之前
  相同；用完 `projects_remove`。运行中硬解出错本机造不出，只有单测（回归 VP6）。
