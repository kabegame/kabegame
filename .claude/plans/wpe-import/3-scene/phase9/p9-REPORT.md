# P9 步骤 0 实测报告（2026-11-12）

> 上级：[P9 总计划](phase-9-video.md)。读码见 [rea-p9-video.md](rea-p9-video.md)。
> 本报告是 WPE 与 Kabegame（dev app 的 CEF）两侧的实测。没有改产品代码。

## 结论

1. **WPE 把视频画进一张普通纹理。** 格式 `R8G8B8A8_UNORM`，尺寸等于视频，只有一级 mip，采样器照 `.tex` 头标志（ClampUVs → 钳边），8 倍各向异性。这和总计划「拷进普通 `rgba8unorm` 纹理」完全对得上，着色器、绑定组都不用动。
2. **颜色转换两边一致。** WPE 把 BT.709 limited 换成 full，色卡 34 块和源值最大差 2（编码量化）；Chromium 的 `copyExternalImageToTexture` 和 WPE 画面逐块比，最大差 1。
3. **视频有自己的时钟，加载即播放、缺省循环。** `init` 里 `isPlaying` 已经为真、`loop` 为真。视频时间和场景时间步长相同，但抓帧那几帧里多走或少走约 11 ms，循环点每轮停约 3 ms，不是从场景时间算出来的。读码：媒体引擎（`IMFMediaEngineEx` 帧服务器模式）自己的实时时钟，不读 `g_Time`。
4. **纹理里是当前时间之前最近的一帧**（显示的帧号 = `getCurrentTime × fps` 减 0.1–1.4 帧）。读码：画到这个图层、绑定纹理时，若有新解出的帧就 `TransferVideoFrame` 拷进来。脚本这一帧 `setCurrentTime`，读回的时间立即变，画面下一帧才变（seek 是异步的）。
5. **纹理连续 30 个渲染帧没被画到，视频就暂停。** 不看 `visible`，看的是「这张纹理最近一次被绑定的帧号 + 30 ≥ 当前帧号」（读码）。实测图层不可见后第 32 帧冻住（差的是工作线程的延迟），`isPlaying` 仍为真。重新显示时立即显示冻住的那一帧，从冻住的时间接着放，不追赶。加载时就不可见的图层同样先播约 30 帧。
6. **`IVideoTexture` 的语义**见下表：`rate` 精确按倍率；`setCurrentTime` 钳到 `[0, duration − 0.005]`；`loop` 为假时停在 `duration`、`isPlaying` 变假、`ended` 触发一次；`loop` 为真时 `ended` 每轮都触发；非视频图层的 `getVideoTexture()` 返回 `null`。
7. **视频纹理不出声。** 带 AAC 音轨的测试视频，WPE 音频会话的峰值全程是 0；同一读法对声音对象的工程读到 0.093（阳性对照）。WPE 设置里 `videoaudiooutput` 是开着的。
8. **解不了的视频是透明的。** `duration` 为 NaN、`isPlaying` 为假、时间停在 0，纹理全是 0（alpha 也是 0），按半透明混合画上去等于没画；日志里没有专门的报错行。
9. **Kabegame 侧能播语料里的全部编码**：H.264、HEVC（本机硬件解码）、Matroska 装 H.264 都能放；`<video>` 不挂 DOM 也正常回调 `requestVideoFrameCallback`。
10. **674 MiB 的 Blob 不占内存，但会整段落盘。** `Response.blob()` 用了 781 ms；浏览器进程、渲染进程的私有内存都没涨，Chromium 把它换到了 `%LOCALAPPDATA%\kabegame-cef-dev\Default\blob_storage`（673 MB），释放后删掉。
11. **拷贝开销可以接受。** 4K 单次 `copyExternalImageToTexture` 摊到 GPU 上约 1.3 ms（同尺寸普通纹理拷贝 0.46 ms），60 fps 视频约占 8% 的 GPU 时间；三路 4K60 同时解码并拷贝，每路每秒 58 次回调、丢帧 2–6 / 300，页面 rAF 仍是 140 Hz。

## 方法与工具

全部在 `ignore/p9/`：
- `gen_v.py`：测试视频与测试工程。1280×720、60 fps、151 帧（2.517 s）；上面两行色块编 10 位帧号（第二行取反校验），下面固定色卡。ffmpeg 转 BT.709 limited 的 `yuv420p`，libx264 High；封进视频 `.tex`，头照语料（格式 0、标志 34、`TEXB0004` 91 字节 / `TEXB0003` 87 字节）。工程用 kbp 生成库写（FR、CLK、视频图层），脚本挂在图层的 `origin` 上，每帧往 `log.txt` 记 `帧,runtime,frametime,getCurrentTime,isPlaying,rate,loop`。
- `ana_sample.py`：读 `kbp sample series --changed-only` 采的画面，解出 FR 帧号、视频帧号，按 FR 帧号和日志对上 `getCurrentTime`。
- `logcut.py`：从 `log.txt` 的字节偏移读到末尾。`log_since` 的游标里 `created` 是超过 2^53 的整数，经工具参数的 JSON 传回去会丢精度，被误判成「日志被重写」，所以改用偏移直接读（wpe-renderdoc MCP 的问题，记在「工具问题」）。
- `rows.py`、`jumps.py`、`loopdrift.py`、`freeze.py`、`seg.py`、`outliers.py`：日志与采样的逐帧分析。
- `chart.py`：色卡读回。
- `peak.ps1`：只读，经 Core Audio 读各音频会话的峰值（`IAudioMeterInformation`）。
- 语料：`scan_vtex.py`、`probe_vtex.py`、`refs.py`、`gvt_usage.py`、`sv.py`、`ana_p9.py`，结果 `out/vtex.json`。

环境：WPE 2.8.42，用户设置 `fps` 20、`videoframework` `mfEngine`、`videoreadmode` `fromdisk`、`videoloopmode` `default`、`videoaudiooutput` true（只读，没改）。测试窗口 1280×720（另一个会话开着 1920×1080 的窗口，避开）。Kabegame dev app：CEF / Chromium 149.0.7827.201，显卡 NVIDIA Ada。

## WPE 的视频纹理

### 纹理与颜色

`A:\p9\clock\clock-frame1964.rdc`，视频图层的绘制（事件 47）：

| 项 | 值 |
|---|---|
| `g_Texture0` | `2D Render Target`，1280×720，`R8G8B8A8_UNORM`，1 级 mip |
| 采样器 | ClampEdge（头标志 34 = Video + ClampUVs），Anisotropic、`max_anisotropy` 8 |
| 帧里的调用 | 只有清屏、3 次绘制、Present；看不到把视频写进纹理的调用（在别的上下文写） |

色卡（`chart.py`，WPE 采样画面第 5 张；Chromium 侧是同一个 MP4 seek 到第 5 帧、`copyExternalImageToTexture` 后整张读回）：

| | 和源 RGB 的最大差 | 两者之间的最大差 |
|---|---|---|
| WPE | 2 | 1 |
| Chromium | 2 | 1 |

差 1 的块：灰阶 153 / 238（WPE 152 / 237）、纯红的 G（Chromium 1）、几个杂色差 1。都在编码量化以内。

### 时钟、循环与显示的帧（`p9-clock`）

日志 2690 帧（约 135 s）+ 采样 140 张：
- **开始**：`init` 时 `duration` 2.5169999599456787（容器时长 2.517 的 float32）、`getCurrentTime` 0、`isPlaying` 真、`rate` 1、`loop` 真。第 1 帧 `getCurrentTime` 0.021。
- **步长**：`getCurrentTime` 每帧走的和 `runtime` 走的基本相同（比值 0.99–1.01），之后 `runtime − getCurrentTime` 恒约 0.0365 s。
- **不是场景时间**：RenderDoc 抓帧那几帧（日志帧 1650、1651）视频比场景多走 11.6 ms、少走 10.5 ms。
- **循环**：53 轮，每轮回绕 2.5196 s（标准差 2.9 ms，范围 2.514–2.525），比时长 2.517 多约 2.6 ms，即循环点停约 3 ms。`addEndedCallback` 每轮都触发，在回绕那一帧的脚本 `update` 之前调用。
- **显示的帧**：140 张全部解出帧号，`帧号 − getCurrentTime × 60` 在 −1.39 到 −0.09 之间，均值 −0.84。

### 脚本 API（`p9-api`）

按场景时间依次调用，`act` 行是调用之后立即读的状态：

| 时间 | 动作 | 结果 |
|---|---|---|
| 1.0 | `pause()` | `isPlaying` 立即为假，时间停在 1.0198，直到下一次 `play()` |
| 1.5 | `play()` | 从 1.0198 接着走 |
| 2.0 | `setCurrentTime(2.0)` | 读回立即是 2.0；画面下一帧才变 |
| 2.5 | `rate = 2` | 下一帧起每帧走 2.000 倍 |
| 3.5 | `rate = 0.5` | 下一帧起 0.500 倍 |
| 4.5 | `rate = 1; stop()` | 时间 0、`isPlaying` 假 |
| 5.0 | `play()` | 从 0 开始 |
| 5.5 → 6.5 | 隐藏 1.0 s 再显示 | 时间照走（0.4929 → 1.5077），隐藏约 20 帧，不到 30 帧，没冻住 |
| 7.0 | `loop = false` | 播到结尾：时间停在 2.517（等于 `duration`）、`isPlaying` 变假，`ended` 触发一次 |
| 10.5 | `setCurrentTime(-1)` | 0 |
| 11.0 | `setCurrentTime(99)` | 2.512（`duration − 0.005`） |
| 11.5 | `play()` | 下一帧到结尾 2.517、`isPlaying` 变假、`ended` 触发 |
| 12.0 | `loop = true; play()` | 下一帧从 0.043 开始重新循环 |

另：
- 非视频图层（`util/white`）的 `getVideoTexture()` 返回 `null`，不抛异常。
- 画面与 `getCurrentTime` 偏开超过 2 帧的采样只有 4 张：两张是刚 `setCurrentTime` 的那一帧（画面晚一帧），两张是 2.45 帧的解码抖动。

### 不可见的图层（`p9-hidden`）

视频图层在 `scene.json` 里写死不可见，控制脚本挂在另一个图层上，10 s 显示、13 s 隐藏、15 s 再显示：

| 事件 | 视频时间 |
|---|---|
| 加载（不可见） | 照常走，第 32 帧（1.65 s）停在 1.5237，之后一直不动；`isPlaying` 始终为真 |
| 10.0 s 显示 | 当帧显示的就是 1.5237 那一帧（帧号 91），下一帧起接着走 |
| 13.0 s 隐藏 | 照常走，第 32 帧（1.60 s 后）停在 0.9989 |
| 15.0 s 显示 | 当帧显示冻住的那一帧（帧号 59），接着走 |

`p9-api` 里隐藏 1.0 s（约 20 帧）再显示，时间一直在走，和「32 帧后冻住」一致。

### 容器、坏视频与声音

- **`TEXB0003`**（`p9-clock-b3`）：和 `TEXB0004` 一样播放，显示的帧与时间的关系相同。
- **坏视频**（`p9-bad`，`ftyp` 头后面是随机字节）：`duration` NaN、`isPlaying` 假、时间 0；抓帧里视频纹理 min / max 全是 0，图层不可见；`log.txt` 没有和视频相关的报错行。
- **声音**（`p9-audio`，1 kHz 正弦 AAC）：`wallpaper64.exe` 两个音频会话 4 s 内峰值全是 0。阳性对照 `ignore/p6/proj/p6a-calib`（`loop` 声音对象）在同一会话读到 0.093。

## Kabegame 侧（dev app，CEF 149）

主窗口页面里临时建不挂 DOM 的 `<video>` 和 GPU 设备，每项跑几秒、跑完释放；没有改界面。隐藏的场景宿主在屏外，rAF 是 0，量不了帧时序，所以不在宿主里测（产品里的宿主是可见的）。

**能不能播**（`canPlayType` / `MediaSource.isTypeSupported` / `decodingInfo` 4K60 50 Mbps）：

| 类型 | `canPlayType` | MSE | `decodingInfo` |
|---|---|---|---|
| H.264 Main / High / Constrained Baseline，Level 5.1–5.2 | probably | 是 | 支持、流畅、省电 |
| HEVC Main（`hvc1` / `hev1`） | probably | 是 | 支持、流畅、省电 |
| `video/x-matroska` + H.264 | probably | 否 | 支持、流畅、省电 |
| `video/webm` + H.264 | 空 | 否 | 不支持 |

WebCodecs `VideoDecoder.isConfigSupported`：H.264、HEVC 4K 都支持（硬件优先）。

**语料实放**（区间 `fetch(file:)` → `Response.blob()` → `<video muted loop>`）：

| 视频 | 读成 Blob | 首次回调 | 回调 / 秒 | 丢帧 |
|---|---|---|---|---|
| 3828359750，H.264 3140×2160 30 fps，8.8 MiB | 18 ms | 95 ms | 29.0 | 9 / 129 |
| 3429479356，H.264 3840×2160 60 fps，674 MiB | 781 ms | 33 ms | 59.9 | 12 / 377 |
| 3822149301，HEVC 2560×1440 60 fps，358 MiB | 548 ms | 37 ms | 60.0 | 12 / 258 |
| 3816870245，Matroska H.264 3456×2160 120 fps，299 MiB | 508 ms | 119 ms | 82.4 | 175 / 501 |

- 丢帧集中在开头；Matroska 那段是 120 fps 4K，超过显示器能呈现的帧，只取得到刷新率以内的帧。
- 区间请求在 `file:` 上回的是 200（不是 206），但只给了请求的区间（长度对得上）。
- **内存**：只读 674 MiB 成 Blob、还没播放时，浏览器进程私有内存 332 → 334 MB，渲染进程 526 → 340 MB（中间有 GC），GPU 进程 1366 → 1477 MB（用户的两个场景宿主同时在渲染，和 Blob 无关）；`blob_storage` 目录从 0 到 673 MB，释放后回到 4 MB。

**拷贝开销**（3840×2160）：
- 播放中每帧拷贝，CPU 侧调用 0.2 ms（p95 0.3 ms）。
- 连发 60 次再等一次完成：每次 1.295 ms；对照同尺寸 `copyTextureToTexture` 0.458 ms。
- 三路 4K60 同时播放并每帧拷贝 5 s：每路 58.0 / 58.2 / 58.0 次回调，丢帧 2 / 4 / 6（约 300 帧中），页面 rAF 140 Hz。

**循环点**（同一段测试视频，`<video loop>`，9 s 三轮）：每轮周期 2520.8 ms，`duration` 2.516667，循环点停约 4 ms（WPE 约 3 ms）；媒体时间步长恒为 1/60 s，没有漏帧。注意 Chromium 的 `duration` 按流算（2.516667），WPE 的 `GetDuration` 是容器时长（2.517）。这一项 `getVideoPlaybackQuality` 报丢帧 531 / 543，和逐帧回调对不上，不可信，忽略。

## 读码与实测的对照

读码见 [rea-p9-video.md](rea-p9-video.md)（静态分析，`wallpaper64.exe` 2.8.42）。

| 读码结论 | 实测 |
|---|---|
| 场景视频纹理一律用 `IMFMediaEngineEx`（帧服务器模式），不走 `videoframework` 回退链；`videoreadmode` 等四个视频设置只作用于视频壁纸 | 本机 `videoframework` 是 `mfEngine`，无从区分；不矛盾 |
| 字节经自写的 `IMFByteStream` 按需从散 `.tex` 或 `scene.pkg` 读，只露出 mip 数据那一段 | `TEXB0003` / `TEXB0004` 都能放 |
| 纹理 `R8G8B8A8_UNORM`、尺寸取 mip 0、1 级 mip，带 `SHARED_KEYEDMUTEX`，由播放器自己的设备写入 | 抓帧里纹理格式、尺寸、mip 数相同，帧里看不到写入调用 |
| 颜色转换全在 `TransferVideoFrame`（MF 视频处理器），没有 YUV 着色器 | 色卡和源值最大差 2 |
| 绑定纹理时若有新帧才拷，和场景帧不同步 | 显示的帧比 `getCurrentTime` 早 0.1–1.4 帧 |
| 自己的实时时钟，建好纹理就从 0 播，`loop` 缺省为真 | 一致 |
| 30 个渲染帧没画到就暂停，再画到时续放、不追赶 | 第 32 帧冻住，续放、不追赶 |
| 场景从不置渲染位 17，引擎带 `FORCEMUTE` 创建，`videoaudiooutput` 无效 | 峰值 0，阳性对照 0.093 |
| `rate` / `loop` 是包装对象上的字段，写入转给引擎 | 读回即写入值 |
| `setCurrentTime` 不钳制 | 读回钳到 `[0, duration − 0.005]`：钳制发生在媒体引擎里，脚本看得到 |
| `stop()` = `pause()` + `setCurrentTime(0)`，画面停在 stop 那一帧直到再 `play()` | 时间 0、`isPlaying` 假；画面没采到 |
| `play()` 在已结束时先 seek 到 0 | 没测「`loop` 为假、已结束再 `play()`」；`loop = true` 后 `play()` 从 0 开始 |
| `addEndedCallback`：`loop` 为真时每次绕回触发，为假时在结束那一帧触发一次 | 一致 |
| `getVideoTexture()` 在槽 0 不是视频、或播放器没建成时返回空 | 非视频图层 `null`；坏视频那张返回的是对象（`duration` NaN） |
| 失败不写日志，纹理保持初值（全 0） | 一致 |
| WPE 暂停时对所有视频纹理 `Pause`，恢复时全部 `Play`，连脚本暂停过的也放 | 没测 |
| `rate` 为负时工作线程的等待变成约 49 天，相当于卡死 | 没测（不造这种工况） |

读码顺带更正 [rea-p4b-render](../phase4/rea-p4b-render.md) 1.2：视频纹理的 `MiscFlags 0x100` 是 `SHARED_KEYEDMUTEX`，不是 `GENERATE_MIPS`。

## 对计划的影响

- **P9a**：
  - 纹理：`rgba8unorm`、一级 mip、采样器照头标志；第一帧之前和解不了时纹理保持全 0（WebGPU 纹理缺省就是 0），图层透明。
  - 时钟：用 `<video>` 自己的时钟，不用 WebCodecs；加载即播放、`loop` 缺省为真；一律 `muted`（WPE 带 `FORCEMUTE`）。
  - 取帧：编码到这个图层时，若 `requestVideoFrameCallback` 报过新帧就拷一次，和 WPE「绑定时拷」对应；脚本的 `setCurrentTime` 自然晚一帧。
  - 暂停：按「这张纹理最近一次被画到的帧号 + 30」判断，超过就 `pause()`、`isPlaying` 照报真；再被画到时 `play()`，不追赶。宿主暂停时全部 `pause()`，恢复时全部 `play()`（连脚本暂停过的也放，照 WPE）。
  - 解不了的视频：不退回整张场景，图层透明，宿主记一条 warn。总计划写的「退回预览图、记 `video:decode:*`」改掉。
- **P9b**：`IVideoTexture` 的 10 个成员按上表实现；`setCurrentTime` 照实测钳到 `[0, duration − 0.005]`；`duration` 要和 WPE 的容器时长对齐，Chromium 的 `video.duration` 按流算、会差几毫秒，子计划定取法；`rate` 为负不复刻卡死。
- **P9c**：Blob 不占内存，但每次加载整段写一遍磁盘（674 MiB 约 0.8 s），三个实例各写一份。是否改成 Rust 缓存文件，看实际加载时间是否可以接受，P9c 再定。

## 未定

- **同一个 `.tex` 被多个图层引用**时是否共用一个播放器：语料里没有这种用法（59 段各被一个材质引用），不查。
- **`loop` 为假、已结束再 `play()`**：读码是先 seek 到 0，没实测，P9b 的测试工程补上。
- **3 张只差 P9 的场景的对照真值**：留到 P9a 的验收再抓（要和 Kabegame 的同一视频帧比，现在抓没有用）。

## P9a 的对照（2026-11-13）

P9a 步骤 3 解锁后，在 Kabegame 里按 WPE 实际显示的那一帧回放（探针 `renderFrame` 的 `videoTime`），和 WPE 抓帧比。工具：`ignore/p9/match_frame.py`（ffmpeg 经 `subfile` 原地解码、逐帧缩小比、候选帧原尺寸精比）、`color_diff.py`（矩阵与线性拟合）、`decode_png.py`（测试视频的帧号）；Kabegame 一侧的读回与比较在屏外宿主里做，只带回统计。抓帧在 `A:\p9\p9a\`、`A:\p9\clock1080\`。

**找 WPE 显示的帧**（视频纹理和 ffmpeg 解出的每一帧比）：

| 场景 | WPE 显示的帧 | 时刻 | 和 ffmpeg 同一帧（BT.709） |
|---|---|---|---|
| 3822149301（HEVC，标了 BT.709） | 559 | 9.317 s | 均方差 0.11、最大 7 |
| 3824550659（H.264，没标颜色） | 593 | 9.883 s | 平均绝对差 0.90、99 分位 9 |
| 3828359750（H.264，没标颜色，30 fps 慢镜头） | 293 | 9.767 s | 平均绝对差 1.04、99 分位 8 |

- 三张都在开窗后约 9.3–9.9 s（等 8 s 加加载），印证加载后视频从头播。
- 没标颜色的视频 ffmpeg 缺省按 BT.601 换算，WPE 按 BT.709：按 601 比时有整体偏色（`3828359750` 平均差 R +4.3、G +2.1、B −2.4），按 709 比没有（线性拟合斜率 0.997–1.000、截距 < 0.5）。

**Kabegame 的视频纹理和 WPE 的**（Chromium seek → `copyExternalImageToTexture` 原尺寸读回）：

| 场景 | Chromium 时刻 | 平均差 | 99 分位 | 最大 | 符号平均差（R, G, B） |
|---|---|---|---|---|---|
| 3822149301 | 9.321 s | 0.19 | 1 | 5 | 0.04, 0.02, 0.11 |
| 3824550659 | 589 / 60 s | 1.15 | 10 | 34 | 0.06, 0.05, 0.15 |
| 3828359750 | 294 / 30 s | 1.66 | 9 | 51 | 0.02, 0.06, 0.19 |

- 没标颜色的两段也没有整体偏色：Chromium 对没标颜色的高清视频同样按 BT.709。剩下的差和 WPE 与 ffmpeg 之间同一量级，集中在颜色变化剧烈的边缘，是 4:2:0 色度上采样的插值不同。
- `3824550659` 在 Chromium 的时间轴上对应 589 / 60 s，比 ffmpeg 的帧序号 593 早 4 帧（约 67 ms），多半是容器的编辑列表；其余两段对得上。

**整帧**（`renderFrame` 读回到 1280×720 画布，和 WPE 1280×720 窗口比）：
- `3822149301`（只有视频图层）：最大 4、平均 0.19、99 分位 1。
- 另两张差异大（`3824550659` 平均 1.5–1.8，`3828359750` 平均约 13），来自樱花、烟雾粒子与随 `g_Time` 变化的水面效果，两边的随机数与时刻对不上，不是视频。

**测试工程**（`p9-clock` 的 WPE 抓帧 vs `p9a-plain` 的回放，只比视频区域）：

| 对照 | 平均差 | 99 分位 | 差 ≤ 1 的像素 | 最大 |
|---|---|---|---|---|
| 1280×720 窗口（两边都缩到 2/3） | 0.59 | 18 | 约 96.5% | 98 |
| 1920×1080 窗口（两边都 1:1） | 0.41 | 7 | 98.2% | 102 |

- 1:1 时采样器不起作用，差异仍在，所以不是各向异性；最大的点都在色卡色块边缘（如红块上方的灰底，WPE (104, 93, 93)、我们 (97, 95, 96)），是色度上采样。
- 缩放后多出来的边缘差异来自缩放路径：WPE 按窗口分辨率直接画，我们先画场景分辨率再缩到画布。所有图层共有，不是视频的。

## 工具问题

- `wpe-renderdoc` MCP 的日志游标：`created` 是 Windows FILETIME（约 1.79e18），大于 2^53，经工具参数的 JSON 传回时丢精度，`log_since` 误报「日志被重写」。可以把 `created` 改成字符串，或游标只比较 `head`。本轮用 `ignore/p9/logcut.py` 按偏移读，没有改 MCP。
