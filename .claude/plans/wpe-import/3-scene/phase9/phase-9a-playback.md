# P9a — 视频纹理的播放与纹理（子计划）

> 上级：[P9 总计划](phase-9-video.md)「P9a — 播放与纹理」。WPE 语义以 [p9-REPORT](p9-REPORT.md) 与 [rea-p9-video](rea-p9-video.md) 为准，本节不另做步骤 0。
> 现状行号按 HEAD `ffed218b`。语料口径同总计划（`ignore/p7d/out/corpus-base.json`，175 张）。

## 总体设计思路

视频纹理在渲染器眼里就是一张普通纹理：槽位、绑定组、着色器都和别的纹理一样，只是内容每帧可能变。所以 P9a 把它拆成两半，中间只隔一个很窄的接口：
- **GPU 一侧**（`GpuScene`）：视频纹理建成 `rgba8unorm`、一级 mip、初值全 0 的 GPU 纹理，从头到尾是同一个对象，绑定组建一次就不再变。编码时每画到一个绑定了视频纹理的 draw，就问一句「这张纹理有没有新帧」；有就 `copyExternalImageToTexture` 一次。这一步对应 WPE 的「绑定纹理时 `TransferVideoFrame`」。拷贝是队列操作，在本帧提交之前执行，所以总是先于这一帧的绘制。粒子顶点已经这样传（`uploadParticles`）。
- **主线程一侧**（新模块 `src/video/`，仿 P6a 的 `audio/`）：每段视频一个播放器，管 Blob、`<video>`、新帧标志和「最近一次被画到的帧号」。场景一份 `SceneVideos`，跨重编译按视频的文件区间复用播放器，不必每次改属性都重读几百 MB。

接口（`VideoSink`）只有两个调用：渲染器每个实时帧开头调 `beginFrame()`，帧号加一，并按 WPE 的规则暂停 30 帧没画到的视频；`GpuScene` 画到视频纹理时调 `drawn(index)`，记下帧号，必要时恢复播放，有新帧就交出 `<video>`。`GpuScene` 不知道播放器的存在，dev 探针的确定性回放可以换上自己的实现（按目标时刻 seek 好再交出元素）。

WPE 的规则全部照 p9-REPORT：
- 加载即播放、`loop` 缺省为真、一律静音（`FORCEMUTE`）、视频用自己的时钟；
- 纹理连续 30 个渲染帧没被画到就 `pause()`，再被画到时 `play()`、不追赶，期间对外仍算「在放」；
- 宿主暂停时全部 `pause()`，恢复时全部 `play()`。WPE 恢复时连脚本暂停过的也放，P9b 有脚本之后照做；
- 解不了的视频不退回整张场景，纹理保持全 0、图层透明，宿主记一条 warn。

字节的读法：主线程按区间 `fetch(file:)`，直接 `Response.blob()`，数据不经过 JS 堆（步骤 0 实测 674 MiB 用 781 ms，Chromium 把它换到磁盘、不占内存）。编译 Worker 只给出视频在磁盘上的区间，**一个字节都不读**。现在 `tex.ts` 靠 `tex:video` 让 `shouldDecode` 为假才跳过 mip；去掉这个键之后必须显式按 Video 标志跳过，否则 Worker 会经主线程代读整段视频。

P9a 只做播放与纹理。脚本的 `getVideoTexture` / `IVideoTexture` 是 P9b，仍照报 `script:api:layer.getVideoTexture`；播放器的接口按 P9b 的需要留好（`play` / `pause` / `stop`、`rate`、`loop`、`currentTime`、`duration`、结束回调），这一节不接进脚本。

## 现状锚点

**a. 视频纹理报 `tex:video`，靠它跳过 mip 字节**（`apps/wpe-scene/src/compile/tex.ts:291`、`:303`）
```ts
  if (flags & TEX_FLAGS.video) unsupported.push("tex:video"); // 现状：整张退回
  // …
  const shouldDecode = decode && unsupported.every((key) => key === ANIMATION_ISSUE) && !freeImageMime; // 现状：有 tex:video 就不读 mip
```

**b. bundle 里只有相对 `.tex` 文件开头的区间，没人读**（`compile/bundle.ts:134`、`:890`）
```ts
  videoRange?: { start: number; end: number }; // 现状：相对 .tex 开头；pkg 里的条目还要加条目偏移才是磁盘位置
  // …
      encoded: tex.encoded,       // FreeImage 形态已经给的是磁盘上的绝对区间（file.location.offset + …）
      videoRange: tex.videoRange, // 现状：没换成绝对区间
```

**c. 纹理全部在建场景时上传一次**（`render/scene.ts:1179`、`render/textures.ts:113`）
```ts
    const uploadable = uploadableTextures(bundle);
    this.textures = bundle.textures.map((texture, index) =>
      uploadable.has(index) ? this.own(uploadTexture(device, texture)) : null, // 现状：视频纹理没有 mip，会在 planTextureUpload 抛 texture-empty
    );
```

**d. 编码里每个 draw 都经同一个 `draw()`，粒子顶点在这里做队列写入**（`render/scene.ts:2403`）
```ts
    const draw = (pass: GPURenderPassEncoder, item: Draw) => {
      const particles = item.particles;
      if (particles) {
        if (particles.hidden) return;
        this.uploadParticles(item, particles); // 现状：队列写入排在本帧提交之前；视频的拷贝照这个做
```

**e. 渲染器一帧的顺序**（`render/renderer.ts:494`–`:577`）
```ts
  private render(runScripts = false): void {
    // …
    const live = !this.paused && !document.hidden && (runScripts || this.shouldRun); // 现状：实时帧与补画帧之分
    // … sync → stepParticles → setCamera
    if (live) this.options.stepObjects?.(frametime); // 声音
    if (live) this.options.beforeFrame?.(frametime); // 脚本
    // … setParallax → sync → update → encode
    device.queue.submit([encoder.finish()]); // 现状：没有帧号；视频的拷贝要在这之前
```

**f. 宿主管声音的方式**（`host.ts:552`、`:568`、`:780`、`:823`）
```ts
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.renderer?.setPaused(paused);
    this.syncSoundGlobal(); // 现状：暂停只通知声音
  }
  setHidden(hidden: boolean): void { /* … */ this.syncSoundGlobal(); }
  // reload():
      this.loadSounds(bundle);              // 现状：声音在脚本与 GPU 资源之前开始
  // …
        this.options.report.ready();        // 现状：第一帧画完就 ready
```

**g. dev 探针的确定性回放自己建 `GpuScene`、不走 rAF**（`dev/probe.ts:310`）：`renderFrame` 编译 → `GpuScene.build` → 按固定 `g_Time` 步进、`encode`、读回。

## 步骤 1 — 视频模块（`src/video/`）

纯 TS，DOM 对象经注入可换成替身，规则全部能在 Node 里单测。

- **新增** `src/video/player.ts`：一段视频一个 `VideoTexturePlayer`。
  > 说明：Blob 由 `fetch(file:, Range).blob()` 得到；`<video>` 不挂 DOM，`muted`、`playsInline`；新帧标志由 `requestVideoFrameCallback`、`loadeddata`、`seeked` 置位；元素 `error` 时标为失败、不再置位（纹理保持全 0）。
```ts
/** 视频在磁盘上的位置：散文件或 scene.pkg 的绝对区间（编译期给出，见步骤 2）。 */
export interface SceneVideoSource {
  path: string;
  start: number;
  end: number;
}

export class VideoTexturePlayer {
  /** 想放（WPE 的 P+0x90）：缺省为真；P9b 的 play / pause / stop 改它。 */
  wantPlay = true;
  /** 最近一次被画到的渲染帧号（WPE 的 P+0x60），建好时取当前帧号：一开始就不可见的图层也先播 30 帧。 */
  lastDrawn: number;
  /** 有还没拷进纹理的新帧。 */
  fresh = false;
  failed = false;
  readonly element: HTMLVideoElement;
  constructor(source: SceneVideoSource, frame: number, options: VideoPlayerOptions) {}
  /** 按 wantPlay、空闲（30 帧没画到）、宿主暂停三者算出元素该不该在放，只在变化时调 play() / pause()。 */
  apply(frame: number, hostPaused: boolean): void {}
  /** P9b 用：rate、loop、currentTime、duration、结束回调（loop 为真时每次绕回一次，为假时结束那一帧一次）。 */
  dispose(): void {} // 停元素、清 src、撤销对象 URL
}
```
- **新增** `src/video/sceneVideos.ts`：场景一份，实现渲染器用的 `VideoSink`。
```ts
export interface VideoSink {
  /** 每个实时帧开头：帧号 +1，再按「lastDrawn + 30 < 帧号」暂停空闲的视频。补画帧不调。 */
  beginFrame(): void;
  /** GpuScene 画到绑定这张纹理的 draw 时调：记帧号、空闲中的恢复播放；有新帧就交出元素（交出即清标志）。 */
  drawn(texture: number): HTMLVideoElement | null;
}

export class SceneVideos implements VideoSink {
  /** 换上 bundle 的视频纹理：按 (path, start, end) 复用已有播放器，用不到的释放；下标表随 bundle 重建。 */
  load(textures: readonly SceneTexture[]): void {}
  /** 宿主暂停或文档隐藏：全部 pause；恢复时按各自的 wantPlay 放（P9b 起照 WPE 全部放）。 */
  setPaused(paused: boolean): void {}
  /** ready 之前等这些纹理出第一帧，最多 timeoutMs（失败的视频立即算完成）。 */
  firstFrames(textures: readonly number[], timeoutMs: number): Promise<void> {}
  dispose(): void {}
  /** dev 探针：每段视频的位置、currentTime、paused、lastDrawn、fresh、failed、videoWidth / Height、丢帧数。 */
  probe(): SceneVideoProbe[] {}
}
```
- **新增** `src/video/*.test.ts`：替身元素（可手动推进 `currentTime`、触发 `loadeddata` / `seeked` / 帧回调）。覆盖：
  - 30 帧规则：第 30 帧还在放、第 31 帧暂停；再画到时恢复，`currentTime` 不跳；
  - 加载时就没被画到的视频先播 30 帧；
  - 宿主暂停 → 全部暂停，恢复 → `wantPlay` 的恢复；
  - 新帧只交出一次，同一帧被两个 draw 画到只拷一次；
  - 跨 `load` 复用（同区间同一个元素，不重读），换场景释放并撤销对象 URL；
  - 读失败、元素 `error`：不再交出元素，记一条 warn。

**验收：** 单测全过；`tsc`、Prettier 通过。这一步不碰共享文件。

## 步骤 2 — 接进编译、渲染与宿主

- **修改** `compile/tex.ts`：视频纹理照常报 `tex:video`（这一步还不解锁），但 mip 的字节一律跳过；给出磁盘上的绝对区间。
```ts
  // 视频的 mip 就是整段视频（最大 674 MiB）：编译期一个字节都不读，只给区间，由主线程的播放器读（P9a）
  const shouldDecode =
    decode && !(flags & TEX_FLAGS.video) && unsupported.every((key) => key === ANIMATION_ISSUE) && !freeImageMime; // 修改
  // …
  const video = flags & TEX_FLAGS.video && first                                      // 修改：原 videoRange（相对 .tex 开头）
    ? { path: file.location.path, start: file.location.offset + first.offset, end: file.location.offset + first.offset + first.length }
    : undefined;
```
- **修改** `compile/bundle.ts`：`SceneTexture.videoRange` 换成 `video?: SceneVideoSource`。
- **修改** `render/textures.ts`：视频纹理不走 mip 上传。
```ts
export function uploadTexture(device: GPUDevice, texture: SceneTexture): GPUTexture {
  // 新增：视频纹理（P9a）。尺寸取头里的纹理尺寸（语料 60 段都等于视频尺寸），一级 mip，初值全 0：第一帧之前与解不了时
  // 图层透明，同 WPE（p9-REPORT「坏视频」）。每帧由 GpuScene 在画到它时 copyExternalImageToTexture
  if (texture.video)
    return device.createTexture({
      label: texture.path,
      size: { width: texture.textureWidth, height: texture.textureHeight },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  // …原有分支不变
}
```
- **修改** `render/scene.ts`：
  - `Draw` 记下它绑定的视频纹理下标（`ref.kind === "texture"` 且 `bundle.textures[ref.index].video`），建 draw 时算一次；
  - `setVideoSink(sink: VideoSink | null)`；
  - `encode` 的 `draw()` 开头：
```ts
      // 视频纹理（P9a）：画到它就记下帧号；有新帧就拷进来，排在本帧提交之前（同 WPE 绑定时 TransferVideoFrame）。
      // 视频尺寸和纹理不同时只拷重叠部分并记一条 warn（语料 0 段）
      for (const index of item.videos) {
        const source = this.videoSink?.drawn(index);
        if (source) this.copyVideo(index, source);
      }
```
- **修改** `render/renderer.ts`：选项加 `videos?: VideoSink`；`load` 里 `scene.setVideoSink(this.options.videos ?? null)`；`render` 里实时帧开头调 `videos.beginFrame()`（补画帧不调，暂停期间帧号不走）。
- **修改** `host.ts`：
  - `loadVideos(bundle)` 紧挨 `loadSounds`：没有视频纹理的场景不建 `SceneVideos`；
  - `setPaused` / `setHidden` 时 `sceneVideos.setPaused(paused || hidden)`；
  - 第一次 ready 之前 `await sceneVideos.firstFrames(可见图层用到的视频, 2000)`（见「决定」1）；
  - `dispose` 时释放；
  - dev 探针 `host.videos()` 返回 `probe()`。
- **新增** dev 测试工程（`ignore/p9/gen_v.py` 加，不带 `getVideoTexture`，dev 强制渲染下能跑）：
  - `p9a-plain`：只有视频图层；
  - `p9a-vis`：控制脚本经 `getLayer` 在 10 s 显示、13 s 隐藏、15 s 再显示（同 `p9-hidden`，去掉视频 API）。

**验收：**
- 单测、`tsc`、Prettier 通过。
- dev app（强制渲染）里：
  - `p9a-plain` 的色卡读回和 WPE 最大差不超过 2；循环、暂停后恢复正常；
  - `p9a-vis` 的 `host.videos()` 显示隐藏后第 31 帧暂停、再显示后从原处接着放；
  - 宿主暂停时 `paused` 为真、`getVideoPlaybackQuality` 的帧数不涨。
- 没有视频的场景：确定性渲染结果和改动前逐字节相同（`renderFrame` 的 SHA-256，取 5 张代表场景）。

## 步骤 3 — 解锁与确定性回放

- **删除** `tex.ts` 的 `tex:video` 键；**修改** `features.ts` 里 `supportsvideo` 的注释。
  > 说明：视频纹理用在图像层槽 0 以外（effect pass、粒子）时同样工作。WPE 也是逐槽更新（rea-p9-video 第 2 节），所以不另报键（语料 0 处）。
- **修改** `dev/probe.ts` 的 `renderFrame`：
  - 新选项 `videoTime`：秒，缺省 0；也可以按纹理路径分别给。
  - 探针用自己的 `VideoSink` 实现：建元素 → 等 `loadeddata` → seek 到时刻（超过时长按 `loop` 取模）→ 等 `seeked` → 交出元素。
  - `hostRenderFrame` 读当前状态，视频保持当前帧，不改。
- **修改** kabegame-dev 的 `render_scene` 工具与 kbp 的文档：透传 `videoTime`。
- **语料**：`kbp corpus scan` 在产品源码上重扫，能渲染数和改动前比。预期 +3：`3822149301`、`3824550659`、`3828359750`；其余报 `tex:video` 的场景只剩别的键。
- **对照**：3 张解锁场景各抓一帧 WPE。用 ffmpeg 把视频逐帧解出来，按 WPE 抓帧里视频纹理的内容找出帧号，Kabegame 按这一帧的时刻 `renderFrame`，整帧比（`kbp cmp frame`）。

**验收：**
- 语料能渲染数 +3（其它会话同期的变化分开列）。
- 3 张整帧比的最大差写进实施记录，目标是和图像层的现有误差同一量级（最大差 2 左右）。
- 预览里打开 3 张，画面在动、循环正常。

## 步骤 4 — 收尾

- `cocs/wpe/WPE_SCENE.md` 加「视频纹理（P9a）」一条，`cocs/README.md` 的 WPE_SCENE 条目同步一句。
- `versions/latest/regression.md` 加回归项（视频场景能播、循环、暂停、隐藏图层不解码、坏视频透明），尽量真机勾选；`versions/latest/changelog.md` 一行。
- 总计划与本文件的实施记录，PLAN.md 的 P9 节记一句。

## 和其它会话的交界

- **共享文件**：`compile/tex.ts`、`compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`render/renderer.ts`、`render/textures.ts`、`host.ts`、`dev/probe.ts`。现在（HEAD `ffed218b`）`apps/wpe-scene` 没有别的会话的未提交改动。
  - 步骤 2、3 动手前各看一次 `git status`；
  - 只按块暂存自己的改动；
  - 别的会话同时在改这些文件时，在 HEAD 快照里实现再三方合并。
- **翻译器**：不改。
- **P9b**：播放器的 `wantPlay`、`rate`、`loop`、结束回调在步骤 1 留好，P9b 只接脚本。

## 决定（2026-11-12 用户：三条都按推荐）

1. **ready 等不等第一帧：** 推荐等，可见图层用到的视频出第一帧再发 `ready`，最多 2 s。WPE 不等，第一帧之前图层透明；我们 ready 之后要淡入，透明的那几帧会被看见。等的代价是首次加载多几十毫秒，674 MiB 那段还要加上读入的约 0.8 s。之后的画面和 WPE 相同。
2. **跨重编译复用播放器：** 推荐复用（按文件区间），改属性不打断视频、不重读。WPE 改属性多数是就地生效、视频不受影响，我们整场重编译的情况也保持不动，更接近 WPE。
3. **视频与纹理尺寸不同：** 推荐只拷重叠部分并记 warn（语料 0 段），不做缩放。WPE 是缩放到纹理尺寸，要照做就得每帧多一次 blit；等语料里出现再做。

## 风险

1. **离屏宿主没有帧回调：** 屏外的 iframe 里 rAF 和 `requestVideoFrameCallback` 都不跑（步骤 0），dev 的隐藏宿主验不了实时行为。实时检查用预览宿主（会占用主窗口的预览，跟用户错开），确定性部分用 `renderFrame`。
2. **单级 mip 的采样：** WPE 对视频纹理也开 8 倍各向异性；我们只有一级 mip 时 `samplerDescriptor` 不开各向异性。4K 视频缩到小窗口时可能有细微差别，步骤 3 的整帧比会看出来。要改就只改视频纹理的采样器，不动别的纹理。
3. **Blob 每次加载都落盘：** 674 MiB 的场景每次加载写一遍磁盘（P9c 再看要不要换成缓存文件）。P9a 不处理。
4. **共享文件冲突：** `render/scene.ts` 是热点文件，见上一节。

## 实施记录

开发方式：步骤 1–3 都交给子代理实现、我独立验收。别的会话同时在改 `render/scene.ts`、`host.ts`、`bundle.ts` 等，所以步骤 2、3 在基于 HEAD 的独立工作树（`ignore/p9/wt`，`node_modules` 用目录联接指回主仓库、wasm 拷一份）里实现与验收，再以工作树的基点为祖先三方合并进主工作区；提交用临时索引只放自己的文件，提交后把共享暂存区里这些文件重置到新 HEAD。期间 HEAD 前进了十来次，每次提交前都把改动挪到最新 HEAD 上重新验收。

### 步骤 1 — 视频模块（`ffa0e061`，2026-11-12）

`src/video/player.ts`（`VideoTexturePlayer`）、`sceneVideos.ts`（`SceneVideos` / `VideoSink`）、共用替身 `fakeVideo.ts`，36 个单测。和子计划的出入：
- `loop` 为假播完时清 `wantPlay`（WPE 的结束事件清 `P+0x90`），否则空闲后再画到会从头重放。
- `rate` 超出 Chromium 接受的范围（0 与 [0.0625, 16]）时保持原速率并 warn；负数按 0，不复刻 WPE 卡死。
- 读取或解码失败时立即释放，让 Chromium 尽早删掉落盘的 Blob。
- 多了 `SceneVideos.player(texture)`，给 P9b 的 `getVideoTexture` 用。

### 步骤 2 — 接进编译、渲染与宿主（`ce8c22ca`，2026-11-13）

改动见总体设计。子代理多做的三处，我认为都对：
- `planProblems` 不把没有 mip 的视频纹理当缺纹理。
- `Draw.videos` 只看着色器真正绑定的槽（WPE 逐槽更新，只更新程序用到的）。
- 宿主的下标换算：重编译时新 bundle 的视频表已经建好，旧场景还在画、用旧下标问，按视频区间换算，免得拷错。

另修一处 `player.ts`：解码已失败时 `play()` 必然被拒，不再重复记 warn。dev 预览实测：实时播放与循环、不可见 30 帧后暂停（第 31 帧）与再画到时续放、宿主暂停与恢复、坏视频透明，全部成立（回归 V2–V5）。

### 步骤 3 — 解锁与确定性回放（`e49e9f79`，2026-11-13）

- 删 `tex:video`；`p3c.test.ts` 原来借视频标志造「不支持的纹理」，改用 `clamp-border`。变异检查：去掉编译期的视频判断后 6 个用例失败。
- 探针 `renderFrame` 的 `videoTime`（`dev/videoProbe.ts`）：seek → 等事件 → 短轮询，超过 10 s 整次渲染失败；vite 插件与 MCP 透传（要重启 dev 与 MCP 才生效，本轮在宿主里直接调探针验证）。
- 语料 47 → 50。三张解锁场景的对照见 [p9-REPORT](p9-REPORT.md)「P9a 的对照」。

### 步骤 4 — 收尾（2026-11-13）

- `cocs/wpe/WPE_SCENE.md` 新增「视频纹理（P9a）」一节，`cocs/README.md` 的 WPE_SCENE 条目加一条与适用场景。
- 回归 V0–V8（V7 桌面 / 预览 / 应用背景同时播、V8 别的显卡上的 HEVC 待用户）；changelog 用户侧、开发侧各一行。
- 库里的三个测试工程已移除，独立工作树已删。

### 已知差异与只记不补

- **色度上采样**：Chromium 与 Media Foundation 把 4:2:0 还原成 RGB 时插值不同，颜色剧烈变化的边缘差到几十级，整体无偏色。要逐像素一致得用 WebCodecs 拿 YUV 自己写转换，不值得。
- **容器编辑列表**：同一时刻两边可能差几帧（语料一段约 67 ms），实时播放看不出。
- **整帧对照的缩放路径**：WPE 按窗口分辨率直接画，我们先画场景分辨率再缩到画布，锐利边缘多出十几级差；所有图层共有，不是视频的。两边都不缩放时测试工程 98% 的像素差 ≤ 1。
- **暂停时机**：WPE 第 32 帧冻住（工作线程延迟），我们第 31 帧。
- **时长**：`video.duration` 按流算，WPE 按容器，P9b 对齐。

### 我的失误

- 读码之前，我在实测报告里把「脚本 `setCurrentTime` 后画面晚一帧」解释成 WPE 在脚本之前取帧；读码表明是绑定时取帧、seek 异步。已改正。
- 步骤 3 对照时，我先把测试工程边缘的差异归因到 WPE 的 8 倍各向异性；不缩放的对照证明各向异性在等比缩放下不起作用，差异来自缩放路径与色度上采样。已改正，回归与文档按改正后的结论写。
- 两次把宿主句柄写错（凭记忆填），一次说屏外宿主已关而实际还开着，都随即纠正了。
- 步骤 2 合并时，一度拿新 HEAD 当祖先做试合并（HEAD 在两步之间前进了）；写回前发现，按工作树的基点重做，没有写坏文件。
