# P9 — 视频纹理（总计划）

> 上级：[PLAN.md](../PLAN.md)「P9 — 视频纹理」。前置：步骤 0 只读码、只实测，可以和 P4–P7 并行（2026-11-12 用户：「其他地方在做 P4、P5、P6、P7，你趁这个时间开始 P9」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 P7d 步骤 0 的语料扫描 `ignore/p7d/out/corpus-base.json`（175 个工程，能渲染 45 张）。P9 的覆盖数：`ignore/p9/ana_p9.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`）。视频段的清单与探测结果：`ignore/p9/scan_vtex.py` → `probe_vtex.py`（ffprobe 的 `subfile` 协议原地读包内区间、不拷贝）→ `refs.py`，合并结果在 `ignore/p9/out/vtex.json`。脚本用法：`ignore/p9/gvt_usage.py`。
> 现状行号按 HEAD `f0abb228`。

## 总体设计思路

WPE 的视频纹理是一张普通 `.tex`，头标志带 Video（32）。它只有一张图、一个 mip，mip 的数据就是一整段视频文件。语料里这类纹理全部挂在图像层材质的槽 0（albedo）上，没有用在 effect pass、粒子或别的槽位。WPE 每帧把解出来的画面写进这张纹理，着色器照常按普通纹理采样。脚本经 `thisLayer.getVideoTexture()` 拿到 `IVideoTexture`，成员是 `duration`、`rate`、`loop`、`play`、`pause`、`stop`、`isPlaying`、`getCurrentTime`、`setCurrentTime`、`addEndedCallback`。这一组成员和 Media Foundation 的 `IMFMediaEngine` 一一对应，我们推断 WPE 用的就是它。这样的话，视频有自己的时钟，不跟场景时间逐帧对齐。（步骤 0 已确认：`IMFMediaEngineEx` 帧服务器模式，见实施记录。）

`IMFMediaEngine` 在浏览器里的对应物就是 `<video>`。所以解码交给浏览器，渲染器只负责把画面搬进纹理：
- **字节**：主线程按区间 `fetch(file:)` 读出视频段，用 `Response.blob()` 直接生成 Blob，数据不进 JS 堆。散文件和 `scene.pkg` 里的条目一样处理，因为散的 `.tex` 也在视频前面带着头。
- **解码**：每段视频一个 `<video>`，地址是 Blob 的对象 URL，按 WPE 的规则设循环、静音和速率。
- **纹理**：槽 0 仍是一张普通的 `rgba8unorm` 纹理，尺寸取头里的纹理尺寸（语料 60 段都和视频尺寸相同），只有一级 mip。视频每出一帧（`requestVideoFrameCallback`），就在下一次编码这个图层之前 `copyExternalImageToTexture` 一次。
- **不动的部分**：着色器、绑定组、管线都不变，GPU 纹理对象从头到尾是同一个。FreeImage 形态的纹理已经这样上传（`render/textures.ts`），视频只是每帧再拷一次。

不选 PLAN 写的 `importExternalTexture`：它要求着色器把这个槽声明成 `texture_external`，采样也只能用 `textureSampleBaseClampToEdge`。可我们的翻译器为每个槽都输出 `texture_2d<f32>` 加采样器，作者着色器里的 `texSample2D` 会被原样翻译。改成外部纹理，就要按「哪个槽是视频」给着色器出变体。外部纹理每帧还会失效，绑定组也得每帧重建。拷贝的代价是视频每出一帧，GPU 上多一次纹理复制（4K 一帧约 33 MB），步骤 0 实测。

另外两条路先不走，留作退路：
- **WebCodecs + 自己解封装**：时序、速率、跳转都由我们掌控，能逐帧对齐场景时间。代价是要一个 MP4 / Matroska 解封装器，还要自己管帧队列、跳转和 `VideoFrame` 的释放。只有步骤 0 发现 WPE 按场景时间逐帧取帧、`<video>` 做不到时才换。
- **MSE**：语料 59 段 MP4 都不是分片的（顶层没有 `moof`），Chromium 的 MSE 只收分片 MP4，要先在 JS 里重新封装，不如直接走 WebCodecs。

**大文件**：最大的一段是 674 MiB（3429479356 `loop-4k`，4K60，141 s）。预览、桌面、应用背景可能同时播同一张场景，每个实例各读一份 Blob。Chromium 的 Blob 超过内存上限时会换到磁盘，但读入时间和峰值占用要实测。实测不行，就由 Rust 把这段区间一次解到应用缓存目录，三个实例共用一个 `file:` 地址（宿主的 `file:` 范围要加上这个缓存目录）。这是退路，步骤 0 的数字出来后再定。

**编码**：CEF 是自编的，带 `proprietary_codecs=true`、`ffmpeg_branding="Chrome"`（`D:\Codes\cefbuild\…\out\Release_GN_x64\args.gn`），H.264 能解。HEVC 在 Windows 上缺省开着 `enable_platform_hevc`，但只走硬件解码，能不能播要看显卡。还有一段 H.264 装在 Matroska 里，Chromium 认不认这种容器要实测。解不了的视频在运行时退回，不在编译期猜。

关键决策沿用前几节：
- WPE 语义以读码加实测为准。
- 能力表是唯一事实来源，没实现的照报。
- 验收和 WPE 比，不和作者的预览图比。

P9 另有两条：
- **视频的时钟按 WPE**：步骤 0 定下来以后，确定性回放（dev 探针的 `renderFrame`）按目标时刻 seek 视频、等到那一帧再拷贝，不和实时播放混用一套逻辑。
- **新代码放进独立模块**：视频放 `apps/wpe-scene/src/video/`，仿 P6a 的 `audio/`。共享文件（`compile/bundle.ts`、`render/scene.ts`、`host.ts`）里只加接线。

## 范围与覆盖

语料（`ignore/p9/out/vtex.json`）：
- **场景与视频段**：41 张场景报 `tex:video`，共 60 段视频，合计 5.4 GiB。31 张只有一段；10 张有多段，最多 5 段（3326873240、3470764447 按时段切换）。
- **编码**：
  - H.264 59 段：Main 31、High 27、Constrained Baseline 1；
  - HEVC Main 1 段（3822149301 `Wardogs Wet Background`，2560×1440、60 fps、156 s、358 MiB）；
  - 全部 `yuv420p`；
  - 容器 MP4 59 段，Matroska 1 段（3816870245 `清宵.rife`，H.264、3456×2160、120 fps）。
- **尺寸与帧率**：
  - 尺寸：3840×2160 29 段；最大 4094×2160 与 3840×2650；竖屏 2488×3594；最小 960×540；
  - 帧率：60 fps 42 段，59.94 fps 6 段，30 fps 4 段，90 fps 2 段，120 fps 1 段，其余是 24 / 25 / 29.97 和两个非整数帧率。
- **音轨**：35 段带 AAC，25 段没有。WPE 放不放视频里的声音，步骤 0 查。
- **`moov` 位置**：21 段在 `mdat` 之后（不是 faststart），用 Blob 播没有影响。
- **`.tex` 头**：
  - 全部是格式 0、一张图、一个 mip、不压缩；
  - 标志 34（Video + ClampUVs）59 段，35（再加 NoInterpolation）1 段；
  - 头里的图像尺寸、纹理尺寸都等于视频尺寸；
  - 容器 `TEXB0004` 43 段，`isVideoMp4` 字段全是 0；`TEXB0003` 17 段。
- **引用**：被引用的 59 段都是图像层材质的槽 0（`genericimage4` 56、`genericimage2` 2、`genericimage3` 1）。3783690410 的 `水梓_裸足_无衣` 没有材质引用。
- **`supportsvideo`**：没有一张场景写这个键，没有可核对的语料，不在范围里。
- **脚本 `getVideoTexture`**：6 张场景用到。
  - 按变量名粗扫，调到的成员是 `duration`、`rate`、`play`、`pause`、`stop`、`isPlaying`、`getCurrentTime`、`setCurrentTime`；
  - `loop`、`addEndedCallback` 没扫到；
  - 3326873240、3470764447 按时段 `play` 一段、`pause` 其余各段，并切换图层可见；
  - 3243449890、3276911872 在 `init` 里隐藏图层、`stop()`，延时再 `play()`；
  - 3361965869 按属性设 `rate`。

| 节 | 内容 | 只做 P9 时累计能渲染 | P4–P8 先做完时累计 |
|---|---|---|---|
| P9a 播放与纹理 | 读取、解码、逐帧拷贝、循环与时钟、暂停、确定性回放、音轨、解不了时退回 | 45 → 48 | 70 → 84 |
| P9b 脚本与多段视频 | `IVideoTexture` 全部成员、隐藏图层的视频、多段切换 | 48 | 84 |
| P9c 多实例与大文件 | 预览 + 桌面 + 应用背景同时播放、674 MiB 级别的 Blob、必要时改缓存文件 | 48 | 84 |

口径：
- 「只做 P9」：去掉 `tex:video` 和 `script:api:layer.getVideoTexture` 两个键。解锁 `3822149301`（HEVC）、`3824550659`、`3828359750`。HEVC 在本机解不了的话，P9a 只解锁 2 张。
- 「P4–P8 先做完」：P4–P7 的键沿用 `ana_phases.py`，另把进行中的 P4f（`script:api:particle.*`）、P5b（`model:passthrough:children`）、P7d（`constant:*`、`uniform:g_FrameTime`、`uniform:g_LayerModelMatrix`）算作做完，能渲染 64 张；P8 做完 70 张；P9 再解锁 14 张，到 84 张：
  - `2903412088`、`3173418061`、`3429479356`、`3549863808`、`3570308528`、`3809965824`、`3813887347`；
  - `3819179413`、`3822149301`、`3824550659`、`3825103811`、`3826727460`、`3828359750`、`3836725625`。
- 只差 P8 + P9 的场景是 0 张，所以 P9 的解锁数和 P8 先做还是后做无关。
- P9b 的 6 张在 P4–P7 做完后都还差 P11，多数还差 P8、P10、P12，P9 内解锁不了。P9b 管的是正确性：多段视频与脚本控制。
- PLAN 的表是 165 张口径（用到 39、只差它 12、累计 89），这里按 175 张重算。

**P9 不做，继续报不支持：**
- 图像层的帧动画 `tex:animation`：P6。
- 媒体缩略图 `$mediaThumbnail`、用户自选纹理：P11。

## 现状锚点

**a. 视频纹理一律报 `tex:video`**（`apps/wpe-scene/src/compile/tex.ts:289`）
```ts
  const mipLayoutVersion = containerVersion === 4 && videoMp4 === 1 ? 4 : Math.min(containerVersion, 3); // 现状：isVideoMp4 = 0 时退回 TEXB0003 的 mip 布局，语料 43 段 TEXB0004 都走这里
  const unsupported: string[] = [];
  if (flags & TEX_FLAGS.video) unsupported.push("tex:video"); // 现状：整张退回
```

**b. 视频段的区间已经算好、进了 bundle，但没有人读**（`compile/tex.ts:362`、`compile/bundle.ts:129`）
```ts
  const videoRange =
    flags & TEX_FLAGS.video && first ? { start: first.offset, end: first.offset + first.length } : undefined; // 现状：mip 0 的数据区间，相对 .tex 文件开头
// bundle.ts
  videoRange?: { start: number; end: number }; // 现状：SceneTexture 上只带区间，渲染器没有分支用它
```

**c. 位图形态的纹理已经用 `copyExternalImageToTexture` 上传**（`render/textures.ts:113`）
```ts
export function uploadTexture(device: GPUDevice, texture: SceneTexture): GPUTexture {
  if (texture.mips[0]?.bitmap) {
    const levels = planBitmapUpload(texture);
    const gpu = device.createTexture({
      label: texture.path,
      size: { width: texture.textureWidth, height: texture.textureHeight },
      format: "rgba8unorm",
      mipLevelCount: levels,
      // copyExternalImageToTexture 要求目标带 RENDER_ATTACHMENT
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    texture.mips.forEach((mip, level) =>
      device.queue.copyExternalImageToTexture( // 现状：只在加载时拷一次；视频要每出一帧拷一次
        { source: mip.bitmap! },
```

**d. P6a 的声音已经把包内条目读成 Blob 交给媒体元素**（`audio/player.ts:278`）
```ts
      task = this.options.reader.readRange(path, offset, offset + size).then((bytes) => { // 现状：先整段读进 JS 堆
        if (bytes.length !== size) throw new Error(`声音文件被截断：${file.path}`);
        if (this.disposed) throw new DOMException("播放器已释放", "AbortError");
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type }); // 再拷一次进 Blob；声音最大 114 MB 还行，视频 674 MiB 要换成 Response.blob()
```

**e. 脚本 API 检查把 `getVideoTexture` 列为缺失**（`compile/scriptApi.ts:130`）
```ts
    // 纹理动画、视频、动画层、骨骼与混合形状（W5 / P6）
    ...methods(
      "any",
      [
        "getTextureAnimation",
        "getVideoTexture", // 现状：用到就报 script:api:layer.getVideoTexture，整张退回
```

**f. 壁纸窗口允许带声自动播放**（`src-tauri/tauri-runtime-kbcef/src/runtime.rs:1069`）
```rust
                cl.append_switch_with_value(
                    Some(&CefString::from("autoplay-policy")),
                    Some(&CefString::from("no-user-gesture-required")), // 现状：视频不用静音也能自动播放
                );
```

## 与 PLAN.md 的差异

1. **帧进纹理**：PLAN 写「每帧 `importExternalTexture`」，这里改成拷进普通纹理，理由见「总体设计思路」。
2. **退路**：PLAN 写「不行再看 MSE 分段喂入」。语料没有分片 MP4，MSE 要先重新封装，所以退路改成 Rust 缓存文件（管大文件）和 WebCodecs（管逐帧对齐）。
3. **静音**：PLAN 写「静音循环的 `<video>`」。语料 35 段带音轨，WPE 放不放声、按什么音量，步骤 0 查清再定。
4. **不只是 MP4**：有一段 HEVC、一段 Matroska。
5. **Blob 的读法**：不走 `readRange` 读进 JS 堆，直接 `Response.blob()`。
6. **覆盖数**：按 175 张重算，见上表。

## 步骤 0 — 调研（整节一次）

**读码**（交给代理，REA 看 `wallpaper64.exe`）：
- **解码路径**：
  - 用的是哪个 Media Foundation 接口（`IMFMediaEngine`、`IMFSourceReader` 还是别的）；
  - 字节怎么交给它：是不是在 pkg 条目上包了一个 `IMFByteStream`；
  - 输出格式与颜色转换：BGRA 还是 NV12 加着色器、BT.709 的 limited range 怎么换算；
  - 写进哪张纹理、纹理多大、有没有 mip；
  - 每帧什么时候取帧（`OnVideoStreamTick` / `TransferVideoFrame`），一帧里排在哪。
- **时钟**：
  - 视频走自己的时钟还是场景时间；
  - 加载后从哪一帧开始；
  - `loop` 的缺省值和循环点怎么处理；
  - `rate` 的范围；
  - 壁纸暂停、被全屏程序挡住、预览与桌面、属性改动与重新加载时视频怎么办。
- **可见性**：图层不可见（写死或脚本改）时视频继续解码、暂停，还是继续计时但不取帧；再显示时从哪里接着放。
- **声音**：媒体引擎静不静音，音量取壁纸音量还是别的。
- **脚本**：`IVideoTexture` 每个成员对应的原生调用；`getVideoTexture()` 在非视频图层上返回什么；`addEndedCallback` 在 `loop` 为真时触发不触发；`stop()` 之后 `isPlaying` 和 `getCurrentTime` 的值。
- **失败**：解不了的视频画什么、日志写什么。

**实测（WPE + RenderDoc）：**
- **测试视频**：kbp gen 加一个视频纹理的生成器：
  - 用 ffmpeg 生成合成视频，每帧用色块编出帧号，另带一张固定的色卡；
  - H.264、`yuv420p`、BT.709 limited；
  - 封进 `TEXB0003` / `TEXB0004` 的视频 `.tex`，头字段照语料。
- **从抓帧读帧号**：在 RenderDoc 抓帧里读视频纹理的内容，解出帧号，和 CLK 图层的场景时间对齐。由此定下：
  - 开始帧和时钟；
  - `rate`；
  - 循环点（时长不是帧时间整数倍时怎么接）；
  - 暂停与恢复；
  - 隐藏再显示。
- **颜色转换**：色卡在 WPE 纹理里的像素值，和我们 `copyExternalImageToTexture` 的结果逐像素比。
- **脚本**：测试工程里的脚本按时间调 `play` / `pause` / `stop` / `setCurrentTime` / `rate`，抓帧核对每一步的效果。
- **声音**：放一段带 AAC 的测试视频，读 `wallpaper64.exe` 音频会话的峰值（只读 `IAudioMeterInformation`，不改系统音量）。
- **语料**：3 张只差 P9 的场景各抓一组，作为 P9a 的对照真值。HEVC 那张顺便看 WPE 本机能不能解。

**实测（Kabegame，dev app，kabegame-dev MCP）：**
- **能不能播**：
  - `canPlayType` 与 `MediaCapabilities.decodingInfo`：H.264 Main / High Level 5.1–5.2 的 4K60、HEVC Main、Matroska 装 H.264；
  - 真放三段语料：674 MiB 的 `loop-4k`、HEVC 的 `Wardogs`、Matroska 的 `清宵`。
- **Blob**：`Response.blob()` 读 674 MiB 的耗时与浏览器进程、渲染进程的内存峰值，和 `readRange` + `new Blob` 对比。
- **拷贝**：4K60 每帧 `copyExternalImageToTexture` 的 GPU 时间，以及 `getVideoPlaybackQuality` 的丢帧数。
- **多实例**：预览、桌面、应用背景同时播 4K60 时的 CPU / GPU 占用和丢帧数。
- **循环**：`<video loop>` 在循环点停顿几帧。

**产出：** `rea-p9-video.md`（读码）、`p9-REPORT.md`（实测）、子计划的步骤 0 实施记录、kbp-tools 的视频纹理生成器与抓帧读帧号。

## P9a — 播放与纹理

**实现**（按步骤 0 的结论细化）：
- **编译期**：
  - `tex.ts` 去掉 `tex:video`；
  - `SceneTexture` 带视频段的位置（文件路径、区间、容器、编码）；
  - 视频纹理用在图像层槽 0 以外的地方时照报 `tex:video:<用途>`（语料 0 处）。
- **主线程**：`src/video/` 里每段视频一个播放器，管 Blob、`<video>`、`requestVideoFrameCallback` 和脏标记。
  - 场景加载时建，换场景、销毁宿主时撤销对象 URL；
  - 等不等第一帧再发 `ready`，子计划定：WPE 不等，第一帧之前纹理全 0、图层透明（步骤 0）；等的话最多几十毫秒，可以省掉一帧透明。
- **渲染器**：
  - 视频槽建 `rgba8unorm` 纹理，带 `COPY_DST | RENDER_ATTACHMENT`，一级 mip，初值全 0；
  - 编码到这个图层时，若报过新帧就拷一次（WPE 是绑定纹理时 `TransferVideoFrame`）；
  - 采样器照头标志（ClampUVs、NoInterpolation）。
- **时钟与暂停**（步骤 0 已查清）：
  - `<video>` 自己的时钟，加载即播放，`loop` 缺省为真；
  - 这张纹理最近一次被画到的帧号加 30 小于当前帧号时 `pause()`，再被画到时 `play()`、不追赶，`isPlaying` 照报真；
  - 宿主暂停时全部 `pause()`，恢复时全部 `play()`，连脚本暂停过的也放（照 WPE）。
- **确定性回放**：dev 探针的 `renderFrame` 与 kbp 回放按目标时刻设 `currentTime`，等 `seeked` 和那一帧到达再拷贝。
- **声音**：一律 `muted`。WPE 的场景视频纹理带 `FORCEMUTE` 创建，`videoaudiooutput` 不起作用（步骤 0 读码 + 实测）。
- **解不了的视频**：不退回整张场景。照 WPE，纹理保持全 0、图层透明，宿主记一条 warn。

**验收：**
- 测试视频在 Kabegame 里显示的帧号、循环点、暂停后的行为和 WPE 一致；色卡逐像素比，误差写进实施记录。
- 解锁的 3 张和 WPE 比同一个视频帧的整帧画面：用 ffmpeg 把视频逐帧解出来，按 WPE 抓帧里的纹理找出帧号，Kabegame 按这一帧确定性回放后再比。
- 隐藏、切走、暂停时不再解码（`getVideoPlaybackQuality` 的帧数不涨）。

## P9b — 脚本与多段视频

- **`IVideoTexture`**：照步骤 0 实现全部 10 个成员（[p9-REPORT](p9-REPORT.md)「脚本 API」与「读码与实测的对照」），`getVideoTexture` 从 `scriptApi.ts` 的缺失表删掉。脚本 realm 和宿主同源，包装对象直接调主线程的播放器。
  - `rate`、`loop` 是包装对象上的字段，写入转给播放器；
  - `setCurrentTime` 读回钳到 `[0, duration − 0.005]`；
  - `duration` 是容器时长（WPE 2.517，Chromium 的 `video.duration` 按流算是 2.516667），取法子计划定；
  - `rate` 为负时 WPE 的工作线程会卡住，不复刻。
- **隐藏图层**：按 P9a 的「30 帧没画到就暂停」。5 段 4K60 的场景一次只解码可见的一段，其余 30 帧后就停了。
- **多段切换**：3326873240、3470764447 的「按时段播一段、暂停其余」，3243449890、3276911872 的「先停、延时再放」，按步骤 0 测出的语义在测试工程里各复现一遍。

**验收：** 测试工程脚本的每一步和 WPE 抓帧一致；6 张用到脚本的场景在 dev 下强制渲染（`kabegame-dev-scene-force-render`）时，脚本不报错、切换的时机和 WPE 一致。

## P9c — 多实例与大文件

- **多实例**：预览、桌面、应用背景同时播放时的开销按步骤 0 的数字处理：可以接受就保持各自解码；不能接受再看能不能让应用背景降帧，或在同一时刻只让一个实例解码。
- **大文件**：Blob 的读入时间或内存不能接受，就加 Rust 缓存文件：
  - 按目录哈希加区间命名；
  - 宿主的 `file:` 范围加上缓存目录；
  - 删除场景行时一起清掉。
  - 不另起 HTTP 服务。
- **HEVC 与 Matroska**：本机都能放（步骤 0）。用户显卡不支持 HEVC 时按 P9a 的规则，图层透明、记 warn。

**验收：**
- 674 MiB 那张在预览与桌面同时打开时，读入时间、内存和丢帧在实施记录里有数字，并和步骤 0 定的上限比。
- 切走场景后内存回落（对象 URL 撤销、元素释放）。

## 和其它节的交界

- **共享文件**：P4–P7 的会话都在改 `compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`render/graph.ts`、`host.ts`。
  - P9 的新代码放 `src/video/`；
  - 共享文件只加接线，按块暂存；
  - 改 `render/scene.ts` 的帧循环之前先看一次别的会话的状态，同 P6、P7 的约定。
- **翻译器**：P9 不改 `wpesl2wgsl`，着色器输出不变。这也是不用外部纹理的好处之一。
- **P5b / P8 的图像层**：视频只是图像层的槽 0，几何、UV、合成 RT 都沿用 P5b 改完的路径。P9a 的语料验收要等 P5b 合入。
- **P6a 的声音**：如果 WPE 放视频的声，增益和暂停时的淡变沿用 P6a 的通路。
- **P11 的媒体**：`$mediaThumbnail` 是系统纹理，不是视频纹理，归 P11。
- **工具**：kbp-tools 的视频纹理生成器、抓帧读帧号是 kbp-tools 的新子功能，按它的协议加（SKILL 里登记）。

## 决定（待定，2026-11-12）

1. **帧进纹理：** 推荐拷进普通纹理（`copyExternalImageToTexture`），不用外部纹理。理由：着色器和绑定组都不用动，代价是视频每出一帧一次 GPU 复制。
2. **解码：** 推荐 `<video>`。步骤 0 证实 WPE 按场景时间逐帧取帧时，再换 WebCodecs。
3. **字节：** 推荐先用 `Response.blob()`，步骤 0 的数字不行再加 Rust 缓存文件。
4. **顺序：** 步骤 0 → P9a → P9b → P9c。步骤 0 现在就做；P9a 的实现等 P5b 合入，并和改帧循环的会话错开。

## 风险

1. **多实例的解码开销**：4K60 H.264 在预览、桌面、应用背景同时播放是三路硬件解码。步骤 0 在本机（NVIDIA Ada）同一页面里三路 4K60 没有问题；别的显卡、核显没量过。
2. ~~**时钟对不上**~~：步骤 0 证实 WPE 用媒体引擎自己的时钟，不按场景时间取帧，`<video>` 对得上。
3. ~~**颜色转换**~~：步骤 0 实测 Chromium 与 WPE 的色卡最大差 1。语料里 13 段没标颜色、2 段标 `bt470bg`，两边各按缺省处理，P9a 验收时用这几段核对。
4. ~~**循环点**~~：步骤 0 实测 WPE 每轮停约 3 ms、Chromium 约 4 ms。
5. **HEVC 与 Matroska**：本机都能放；HEVC 在别的显卡上可能解不了，那时图层透明。
6. **验收的确定性**：实时播放时视频帧取决于解码器的节奏，同一场景时间不一定是同一帧，所以按「同一视频帧」比，不按「同一场景时间」比。
7. **共享文件**：和 P4–P7 的会话同时改帧循环。按块暂存，必要时在 HEAD 快照里实现再三方合并。

## 实施记录

### 步骤 0 — 调研（2026-11-12）

读码 [rea-p9-video](rea-p9-video.md)（代理用 REA 读 `wallpaper64.exe` 2.8.42），实测 [p9-REPORT](p9-REPORT.md)（WPE 测试窗口 + Kabegame dev app）。工具与数据在 `ignore/p9/`：测试视频与工程 `gen_v.py`，采样分析 `ana_sample.py`，日志按偏移读 `logcut.py`，音频会话峰值 `peak.ps1`。

结论（详见报告）：
- **解码**：场景视频纹理一律用 `IMFMediaEngineEx` 帧服务器模式，不走视频壁纸的 `videoframework` 回退链；总计划的推断成立。
- **纹理**：`R8G8B8A8_UNORM`、一级 mip，采样器照头标志；颜色转换在 MF 视频处理器里，Chromium 的 `copyExternalImageToTexture` 和它最大差 1。决定 1（拷进普通纹理）有了依据。
- **时钟**：媒体引擎自己的时钟，加载即播放、缺省循环，循环点停约 3 ms。决定 2（`<video>`）有了依据，不需要 WebCodecs。
- **暂停**：不看 `visible`，纹理连续 30 个渲染帧没被画到就暂停，再画到时续放、不追赶；宿主暂停时全部暂停、恢复时全部放。
- **声音**：不出声（`FORCEMUTE`），实测峰值 0、阳性对照 0.093。
- **失败**：纹理保持全 0，图层透明，不写日志。
- **Kabegame 侧**：语料的三种编码在本机都能放；674 MiB 读成 Blob 用 781 ms、不占内存但整段落盘；4K 单次拷贝摊到 GPU 约 1.3 ms；三路 4K60 同时播放没有问题。决定 3（`Response.blob()`）可以先用。

对后面各节的影响已改进上文：P9a 的声音、失败、暂停规则；P9b 的 `IVideoTexture` 细节；P9c 的 HEVC / Matroska；风险 2–4 划掉。

我的失误：
- 报告初稿把「脚本 `setCurrentTime` 之后画面晚一帧」解释成 WPE 在脚本之前取帧。读码表明 WPE 在绑定纹理时取帧，晚一帧是因为 seek 异步；已改正。
- 第一次在隐藏的场景宿主里量帧时序：屏外宿主的 rAF 是 0，`requestVideoFrameCallback` 不回调。改到主窗口页面里测（不挂 DOM、跑完释放）。
- 第一次读回拷贝结果全是 0：读回用的纹理没带 `COPY_SRC`，失败的是读回而不是拷贝。

工具问题：`wpe-renderdoc` MCP 的日志游标里 `created` 大于 2^53，经工具参数的 JSON 传回会丢精度，`log_since` 误报「日志被重写」。本轮用 `logcut.py` 绕开，没改 MCP。
