# 场景壁纸：声音与视频纹理

> [场景壁纸文档](../WPE_SCENE.md) 的一章：声音对象（P6a）、视频纹理与脚本 `IVideoTexture`（P9）。总体形态、各阶段状态与全部章节的索引在总览里。

## 声音（P6a）

声音对象不画东西：在 `layers` 里仍是一个没有 pass 的图层（层级、名字、`getLayer` 照旧），播放字段另进 bundle 的声音表，由宿主按 WPE 的规则排期播放。渲染图不碰。依据：读码 [rea-p6a-sound](../../../.claude/plans/wpe-import/3-scene/phase6/rea-p6a-sound.md)，实测 [p6-REPORT](../../../.claude/plans/wpe-import/3-scene/phase6/p6-REPORT.md)「P6a 声音语义的实测核对」（冲突时以实测为准，读码的结论除暂停淡出外都已实测成立）。

分四层，彼此只经很窄的接口相连：

| 层 | 位置 | 做什么 |
|---|---|---|
| 声音表 | `compile/sounds.ts` → `SceneBundle.sounds` | 有非 null 的 `sound` 键就是声音对象（`features.ts` 的 `isSoundObject`，空字符串、空数组也算）。文件按场景的资源查找顺序定位，记磁盘位置（散文件 / `scene.pkg` 加偏移）；找不到的、扩展名不是 wav / ogg / flac / mp3（不分大小写）的不进表。缺省值 `volume` 1（不钳制）、`mintime` 1、`maxtime` 5、`loop`、`startsilent` 假 |
| 排期器 | `audio/scheduler.ts` | 纯 TS、Node 可单测，一个声音对象一个。照读码的 `P`（开始 / 续播）、`U`（每帧）、`V`（音量回调）、`X`（停掉全部）与全局音量规则复刻状态机，只对抽象后端发命令；`play` / `pause` / `stop` / `isPlaying` 也在这里，宿主经 `ScriptApiState.sound(object)` 交给声音层的脚本对象（`script/api.ts`，步骤 2） |
| 播放后端 | `audio/player.ts` | 场景一个 `AudioContext`，每个文件一个 `<audio>`：散文件用 `file:` 地址，pkg 条目按区间读成 Blob（同一条目只读一次）。元素 → `MediaElementAudioSourceNode` → 本声音的增益 → 淡变增益 → `destination`。不整段解码（语料最大一段 114 MB FLAC） |
| 宿主接线 | `audio/sceneSounds.ts`、`host.ts`、`main.ts` | 宿主收到 bundle 就建、立即开始（不等 GPU，WPE 加载时就放）；渲染器每个实时帧在粒子步进之后、脚本之前调 `stepObjects(dt)` 推进排期器（补画帧、暂停时不调，计时冻结）；重编译时声音表没变的对象保留排期器、播放不中断；退回预览图与销毁时释放元素、Blob 和 context |

**播放规则**（实测）：
- `loop` 单文件：元素自己无缝循环。`loop` 多文件：每个放一遍、到时长后带放回随机换下一个（可以连选同一个），中间不留空，切换落在帧边界。
- `single`：放一遍，`isPlaying` 在时长内为真、之后为假，不自动重放。放完之后 `pause` 再 `play` 会从头重放一遍而 `isPlaying` 仍为假（包装层状态自然放完不变，照搬）。
- `random`：从开始播放算起，等「时长 + U(mintime, maxtime)」秒再随机选下一个；两段之间 `isPlaying` 仍为真。选文件与等待的随机数用宿主自己的随机源（WPE 用 CRT `rand()` 与粒子共用的 mt19937，序列本来对不上），只照规则。
  `mintime` / `maxtime` 在每次开始播放时现读（P6a2）：它们是就地目标（`{ kind: "sound" }`，`SceneState.sounds`，排期器经 `SceneSounds` 的 `timingOf` 读状态），
  绑用户属性、挂字段脚本或属性关键帧，运行中改了，正在等的这次不变，下一次排期用新值。WPE 这两个字段没有改值回调，但 setter 照样写字段，`P` 读字段算等待
  （rea-p6a 2.1、rea-p10-keyframes 第 4 条）；`p6a-delay` 的回环录音与 WPE 探针频谱两边一致（属性与脚本两路，1.5 s → 3.5 s，跨过改值时刻的那一段仍是旧值）。
  它们不进排期器签名（`soundKey`），改过之后别的原因触发的重编译不会打断播放。
- `startsilent`：不放，直到脚本 `play()`。对象音量或全局音量为 0 时不开始、不读文件，变成正数时才从文件开头放（`single` 例外，WPE 的音量回调跳过它）。
- 可见性不影响声音：自身或父层不可见照样放。多个声音在同一次调用里按对象顺序开始。

**音量**：WPE 的增益是 `min(1, volume² · G)`（对象音量取平方，钳在乘积上，实测 `p6a-vol2`），没有渐变。我们的 G 是宿主音量 h：垫片把父页面的音量放进只读的 `window.__kabegameHostVolume` 并派发 `kabegame-host-volume`（只当通知，值总从只读属性读），宿主经 `setHostVolume` 收下；暂停或文档隐藏时 G 为 0。垫片的主增益已经乘 h（接进 Web Audio 的元素不在元素上再乘），所以每个声音的增益节点设成 `min(1, volume²·h) / h`。G 从正变 0：暂停在放的，`single` / `random` 已放完的停掉，计时冻结；从 0 变正：续播，从没开始过的从头开始。`volume` 绑用户属性是就地目标（`{ kind: "sound" }`，`SceneState.sounds`），改值当场生效；脚本写 `volume`（API 写入或字段脚本写回）走同一条路，同样当场生效。

**暂停**：WPE 暂停时全局音量按 `k = min(1, 6·dt)` 指数淡出再暂停、恢复时淡回。播放器的淡变增益用 `setTargetAtTime`（时间常数 1/6 s）；但暂停消息到达时垫片的主增益已立即变 0、排期器也立即暂停元素，所以只有恢复时的淡入听得见。文档隐藏（渲染循环停转）按暂停处理。

**脚本控制**（步骤 2）：只有声音对象的图层有 WPE `ISoundLayer` 的 `play`（= `P`：暂停中续播，否则停掉、重新随机选、从头放）、`pause`、`stop`（= `X`：停并回到开头）、`isPlaying()` 和可读写的 `volume`，别的图层调用照旧报 `TypeError`（WPE 的方法按对象类型登记）。`volume` 读 `SceneState.sounds`，写入落到就地目标、不钳制，宿主写完当场交给排期器（暂停时也生效）；声音对象的 `volume` 挂 `{script}` 时，字段脚本的返回值每帧写回同一个目标。没有播放器时（宿主没建、或已退回预览图）方法什么都不做，`isPlaying` 为假。真机和 WPE 逐条对过 `p6a-play` / `p6a-single` 的调用前后 `isPlaying` 与录音段序列（含 `single` 放完后 `pause` 再 `play` 会重放而 `isPlaying` 仍假）。

**能力表**：不再报 `object:sound` 与声音对象自己的键（`muteineditor`、`attenuation`、`mindistance` 中性）。新键：`object:spatialization`（三维声音，语料 0 张打开）、`sound:playbackmode:<值>`、`sound:binding:<键>`（`playbackmode` / `startsilent` / `spatialization` 绑了属性或脚本，WPE 没有回调，运行中改的效果没有实测；`mintime` / `maxtime` P6a2 起不报，见上「播放规则」）。粒子层的同名方法 P4f 步骤 3 实现之后，`play` / `pause` / `stop` / `isPlaying` 按对象类型在运行时分派，编译期不再报（P6a 到 P4f 之间，场景里有粒子层时任意接收者上的这四个名字都报 `script:api:particle.<名>`，`PARTICLE_LAYER_METHODS` 已删）。

**已知差异**：
- 开始是异步的：元素拿到元数据才从头放并回报时长，`T` / `Rm` 从那一刻起算；WPE 是同步读完整个文件。等回报期间 `isPlaying` 按 WPE 当场的值（真）。
- 文件读不出在开始时才知道：照 WPE 从列表删掉（宿主记 warn），正在等它开始的用剩下的文件重新选。
- 单声道源：WPE 在本机每个前置声道约 −4.1 dB（OpenAL Soft 的声像，随输出设备变），Web Audio 原样复制到两个声道，同一文件我们这边约响 4 dB，不补偿。
- 预览与桌面同时放同一张场景时各放各的，同网页壁纸。

**语料**（165 个工程）：能渲染 36 → 38（`1967162875`、`3827677885`）；带声音的 77 张里去掉 `object:sound` 及其键，不含声音对象的场景不变。步骤 2 之后仍 38 张：`script:api:layer.*` 与 `sound:volume:script` 消失，有粒子层的场景报 `script:api:particle.play` 38 张、`stop` 29、`pause` 16、`isPlaying` 8。`1514925620`、`3778592720` 只剩 `particle:children`。

**dev 探针**：`__kabegameSceneProbe.host.sounds()` 给宿主音量、暂停 / 隐藏，每个声音对象的模式、当前文件、可用文件、实例状态、`T`、`Rm`、`isPlaying`、增益，以及播放器的 context 状态、淡变值、Blob 数与各元素的状态。

## 视频纹理（P9a、P9d）

视频纹理是头标志带 Video（`0x20`）的 `.tex`：一张图、一级 mip，mip 的数据就是整段视频（语料 59 段 MP4、1 段 Matroska；H.264 为主，1 段 HEVC；P9e 起另有 3662390671 的背景，WebM 封装的 VP9）。WPE 用 Media Foundation 的 `IMFMediaEngineEx`（帧服务器模式）解码，每次绑定这张纹理画图时把最新一帧拷进一张普通的 RGBA8 纹理。我们照同样的结构，GPU 侧仍是普通纹理，着色器与绑定组不变；解码自 P9d 起不经 `<video>`：宿主自己从磁盘区间拆出每一帧的压缩数据，交给 WebCodecs 的 `VideoDecoder`（显卡硬解），按自己的媒体时钟挑出当前的 `VideoFrame` 拷进纹理。脚本经 `getVideoTexture()` 控制播放是 P9b（本节「脚本 `IVideoTexture`」）。依据：读码 [rea-p9-video](../../../.claude/plans/wpe-import/3-scene/phase9/rea-p9-video.md)，实测 [p9-REPORT](../../../.claude/plans/wpe-import/3-scene/phase9/p9-REPORT.md)（P9b 的补测在「P9b 步骤 0 的补测」），P9b 的计划与真机对照见 [phase-9b-script.md](../../../.claude/plans/wpe-import/3-scene/phase9/phase-9b-script.md)，P9d 的设计、实施与走查见 [phase-9d-webcodecs.md](../../../.claude/plans/wpe-import/3-scene/phase9/phase-9d-webcodecs.md)。

| 层 | 位置 | 做什么 |
|---|---|---|
| 编译 | `compile/tex.ts` → `SceneTexture.video` | 按 Video 标志跳过 mip 字节（最大一段 674 MiB，编译 Worker 不读视频数据，这是唯一的一道），只给视频在磁盘上的绝对区间（散 `.tex` 从文件开头算，`scene.pkg` 条目带条目偏移）。要解码时另读容器头里的时长（`video/container.ts`：MP4 的 `mvhd`、Matroska 的 `Info.Duration`，盒子只读头、`mdat` 按大小跳过，每段 2–6 次小读；场景确定退回时不读），放进 `video.duration`（P9b 步骤 1）。不报能力键：槽 0 以外同样工作，WPE 也是逐槽更新 |
| 拆包 | `video/demux/`（`index.ts` 的 `indexVideo` 按 EBML 魔数分派） | MP4（`mp4.ts`）读 `moov` 里的帧表：偏移、大小、显示时间（`ctts`）、关键帧（`stss`），扣编辑列表的 `media_time`（只认「没有」或「一段、`media_time ≥ 0`、速率 1」）；Matroska（`mkv.ts`）按 4 MiB 一块顺序扫 Cluster、只记块头，时间扣全部帧里最小的显示时间；Matroska 另认 VP9（P9e，`V_VP9`）：`CodecPrivate` 可有可无，解码配置要的 profile、位深、色度采样与颜色取第一个关键帧的未压缩帧头（`vp9.ts`），level 取 `CodecPrivate` 里的、没有时按 VP9 规范附录 A 的表用画面与帧率挑，superframe 整块一帧（WebCodecs 自己拆）。产出同一个 `VideoTrackIndex`，帧时间与 ffmpeg 的 pts 逐帧相同。拆不了（分片 MP4、`stz2`、lacing、`ContentEncodings`、编码不是 H.264 / HEVC / Matroska 的 VP9、表不一致等）给出原因、不抛错。`config.ts` 给 codec 串（VP9 是 `vp09.PP.LL.DD`）、`description`（VP9 不给）与色彩空间（见下「颜色」） |
| 播放器 | `video/codecPlayer.ts`（`CodecVideoPlayer`） | 一段视频一个：按区间 `fetch(file:)` 读（散文件与 pkg 条目同样，偏移加 `source.start`），先 `indexVideo`，之后按解码顺序约 4 MiB 一块预读、至多两块在手；`VideoDecoder` 只解不播，媒体时钟、挑帧、跳转、流控（解码队列 + 已解出未显示的帧合计不超过 8）都在这里；硬解优先、显卡不能硬解时退到软解（见下「硬解与软解」）；读不到、拆不了包、硬解软解都不支持、软解出错时标为失败、记一条 warn。脚本 `IVideoTexture` 的落点（`rate`、`loop`、`currentTime`、`duration`、`play` / `pause` / `stop`、`isPlaying`、结束回调）；`seeked()` 给 dev 探针与用户视频等跳转完成 |
| 脚本 | `script/api.ts`（`getVideoTexture`）、`script/runtime.ts`（`callFor`） | P9b：每个图层的 `getVideoTexture`，包装对象按 WPE 的成员与类型，经宿主按视频区间键现取播放器；结束回调在登记它的脚本上下文里调 |
| 场景视频表 | `video/sceneVideos.ts`（实现 `VideoSink`） | 帧号、30 帧规则、宿主暂停；跨重编译按视频区间复用播放器（改属性不重读、不打断） |
| GPU | `render/textures.ts`、`render/scene.ts`（`copyVideo`）、`render/renderer.ts` | 视频纹理建成初值全 0 的 `rgba8unorm`、一级 mip，绑定组建一次不再变；每个 draw 建时记下着色器真正绑定的视频纹理，编码时画到它就问 `VideoSink.drawn`，有新帧就 `copyExternalImageToTexture(VideoFrame)`（尺寸取显示尺寸，队列操作，先于这一帧的绘制；帧由播放器持有、下次替换时关掉）；渲染器每个实时帧开头调 `beginFrame`（补画帧不调） |
| 宿主 | `host.ts` | `loadVideos` 紧挨声音、不等 GPU；暂停与文档隐藏都转给 `setPaused`；第一次 ready 之前等可见图层的视频出第一帧（最多 2 s，免得淡入时看见透明的几帧）；重编译期间按视频区间把旧场景的纹理下标换算到新表；脚本的落点按 `scriptBundle`（脚本正在用的那份）找图层槽 0 的视频，经 `SceneVideos.playerFor` 按区间键取；「清空脚本存储」重启脚本时 `SceneVideos.resetScriptState`（清结束回调、`loop` 真、`rate` 1、想放，不 seek）；退回预览图与销毁时释放 |

**播放规则**（WPE 实测）：
- 视频用自己的时钟（不读 `g_Time`），`loop` 缺省为真。我们的时钟在「在放」时按墙钟 × 速率前进：想放、宿主没暂停、没空闲、没结束，且出了第一帧、已被画到过一次（第一次画到时起步，宿主 ready 前已等到第一帧，所以视频和场景同时开始）。
- 不出声：WPE 的场景视频纹理带 `FORCEMUTE` 创建，`videoaudiooutput` 不起作用；我们只解视频轨。
- 纹理连续 30 个渲染帧没被画到（图层不可见、被剔除、所在材质不画）就暂停，再被画到时从暂停处续放、不追赶，期间 `isPlaying` 仍为真；加载时就不可见的图层也先播约 30 帧。不看 `visible` 本身。
- 宿主暂停（含文档隐藏）时全部暂停，恢复时全部放（WPE 恢复时连脚本暂停过的也放）。
- 第一帧之前与失败时纹理全 0（alpha 也是 0），图层透明，场景不退回。
- 脚本暂停或停止期间不取帧：seek 读回的时间立即变，画面不变，到 `play()` 那一帧才换成新位置；`stop()` 后画面停在 stop 那一刻的帧（P9b）。空闲暂停（30 帧没画到）期间 `wantPlay` 仍为真，照常取帧。
- 时长是容器头里的（MP4 `mvhd`），时钟走到它才绕回或结束，结束时读到的时间正好等于它（P9b）；编辑列表两边都认（WPE：P9 测试片带 2 帧的 `media_time`，显示帧号比当前时间 × 60 小 0.09–1.39，不认会再小 2 帧）。

**播放器的内部**（P9d，`CodecVideoPlayer` 文件头有全文）：
- **时钟与时间戳**：喂进解码器的时间戳 = `(n × 时长 + 样本显示时间) × 10⁶`，n 是本次跳转起喂到第几遍；循环时不 flush、接着喂下一遍，媒体时钟按展开的时间走、绕了几遍记在 `loops`，所以循环点无缝。`loop` 为假时喂到结尾 flush 一次，时钟停在时长、`ended`。
- **挑帧**：显示时间 ≤ 媒体时间的最新一帧成为当前帧；被越过的直接关掉、计入丢帧。
- **跳转**（脚本 `currentTime`、`stop`、结束后 `play`、卡住重置）：`reset()` + 重新 `configure`，从显示时间 ≤ 目标帧的最近关键帧喂起，丢掉早于目标帧的输出，目标帧到了才换当前帧（之前一直显示旧帧）。所以取到的就是「显示时间 ≤ 目标的最新一帧」。
- **速率**：时钟是自己的，非负有限数都收（旧 `<video>` 受 Chromium 的 [0.0625, 16] 限制）；负数按 0（WPE 负数让工作线程卡死，不复刻）。
- **卡住**：画到时看，在放（或在跳转）、没有已解出的帧、解码器有待解的输入、喂帧没在等读盘，且 2 s 没有任何输出，就 reset 并从当前媒体时间重新跳转，记 warn、计数 `stallResets`。P9c 记的 Chromium `<video>` 硬件解码静默卡住（`DECODER_UNDERFLOW`）随 `<video>` 一起不再适用；硬件解码的输出帧池有限，流控与「越过即关」保证播放器不长时间握着帧。
- **主窗口隐藏**：WebCodecs 不经 Chromium 推迟隐藏页面媒体加载的那条路（`DeferMediaLoad`），隐藏时照常解（P9d 步骤 4 实测：40 ms 出第一帧）。
- **硬解与软解**（P9e 之后，`Acceleration`）：Chromium 把 `prefer-hardware` 当成必须硬解，显卡没有这种编码的硬解（老显卡的 VP9、HEVC）或画面小于硬解的最小尺寸（本机 RTX 4090 D 实测 VP9 约 128、HEVC 约 144、H.264 在 64×48 与 96×96 之间）时 `isConfigSupported` 说不支持；`no-preference` 的 `isConfigSupported` 不可靠（硬解、软解都不支持的 HEVC 64×48 也说支持），所以不用它。播放器先问硬解，不支持再问 `prefer-software`，都不支持才失败；硬解说支持、实际配置或解码时才出错（`error` 回调，或 Chromium 已关掉出错的解码器时 `decode` / `configure` 同步抛错）也换软解一次：关掉旧解码器（代数加一，它迟到的输出与出错都不理），从出错时的媒体时间接着解，换的期间时钟停着、画面停在当前帧；软解再出错才失败。退到软解记一条 warn，`host.videos()` 与 dev 探针结果的 `acceleration` 是 `hardware` / `software`。本机自编的 CEF 没有 HEVC 的软解，HEVC 退不了；H.264、VP9 都有。WPE 的 Media Foundation 同样会退到软解。Linux 上 Chromium 的硬解只有 VA-API 一条路：NVIDIA 闭源驱动不提供 VA-API，要装第三方 `nvidia-vaapi-driver`（deb 包以 Recommends 带上），Chromium 还默认跳过 `nvidia-drm` 设备，CEF runtime 在 libva 找得到 `nvidia_drv_video.so` 时自动打开 `VaapiOnNvidiaGPUs`（见 [tauri-runtime-kbcef README](../../../src-tauri/tauri-runtime-kbcef/README.md)）；两样缺一样，N 卡上的场景视频就全部软解，日志里是「显卡不能硬解这段视频」。真机：64×48 的 VP9 与 H.264 测试工程（`ignore/p9/p9e/gen_small.py`）以前透明，现在软解出图，1080p 的 VP9 仍走硬解、画面逐字节不变。

**颜色**（P9d 步骤 4 走查：抓 WPE 的视频纹理，从原始 YUV 按不同写法重建，看哪种能逐像素还原；`video/demux/config.ts`）：
- WebCodecs 不读码流的色彩标签、缺省一律按 BT.709，色彩空间由我们给：原色与传递函数恒报 bt709，即不做色域与传递函数转换（WPE 不做）；范围取码流的（`colr` → H.264 的 VUI 或 VP9 帧头的 color_range → limited）。
- **场景视频的矩阵恒为 BT.709**：WPE 不看标签、也不按分辨率。标 bt709 的 1080p、1440p HEVC、Matroska，以及标 bt470bg 的 540p（3400241651）与 4K（3812007032）都是 709；后两段按 601 重建最大差 7 与 22。语料画面依赖它，照做。VP9（P9e，3662390671，1080p、码流未标）的 WPE 纹理同样按 709、limited、WPE 的色度位置重建最大差 1，WPE 走 Media Foundation 的 VP9 解码器之后和 H.264 / HEVC 同一条转换。
- 用户视频见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「用户纹理」的「解码」：照标签，没标时高 > 576 用 709（WPE 不看标签记为缺陷，有意不同）。
- **色度上采样的位置**（已知差异，不照）：两边都是双线性插值（权重 9/16、3/16、3/16、1/16），横向位置相同；WPE 纵向第 k 个色度样本在亮度第 2k − 0.5 行，Chromium 拷 `VideoFrame` 时在标准的 2k + 0.5 行。按各自的位置重建，WPE 四段都只差 1、我们最大差 2；两边之间的差全部来自这一处：3823859141（1:1）整帧 58% 像素不同、平均 1.22、最大 45，3816870245 缩到一半后平均 0.48、最大 17，3400241651 的合成 RT 最大 22。要照它得 `VideoFrame.copyTo` 读回 YUV、自己的着色器转换，每帧多一次显存读回，用户定不做。P9a 记的「色度上采样插值不同」就是这一处。

**已知差异**：
- 色度上采样的纵向位置，见上「颜色」。
- 时钟（WPE 的视频时钟在媒体引擎自己的线程上，和渲染帧之间有延迟与抖动，每帧显示哪一帧本身不确定；走查回放把视频时刻当输入还原，画面比较不受影响）：
  - 显示的帧：WPE 落后当前时间 0.09–1.39 帧（均值 0.84），我们 0.07–0.81（均值 0.37）。WPE 多出的约半帧是帧服务器 `TransferVideoFrame` 的转交延迟。
  - 循环点：WPE 每轮停约 2.6 ms（标准差 2.9 ms），我们不停。
  - 开场：WPE 视频时间 ≈ 场景时间 − 36.5 ms（媒体引擎的启动延迟），我们 ≈ 场景时间，早约 2 帧（60 fps）。
  - 场景时间与视频时间的步长：WPE 抓帧那几帧多走 / 少走约 11 ms，我们按墙钟。
- 拆不了包（分片 MP4、Matroska 的 VP8 / AV1、MP4 里的 `vp09` / `av01` 等，语料 0 段）时图层透明；WPE 的媒体引擎能放。
- 显卡不能硬解的 HEVC 透明：我们退到软解（见上「硬解与软解」），但本机自编的 CEF 没有 HEVC 的软解；WPE 的 Media Foundation 有（系统的 HEVC 扩展）。语料里的 HEVC 都是 1440p 以上，本机 0 段受影响。
- 离当前位置不到一帧的 seek：WPE 忽略（暂停在 0.2867 时 seek 0.3 读回不变），我们照跳（P9b 决定 5）。
- 脚本细节：写 `duration` 抛的 `TypeError` 文字不同；包装对象的原型是 `Object.prototype`（WPE 是只有 `constructor` 的类原型）；`loop` 改回真后在结尾立即 `play()`，这一帧读到 0（WPE 读到结尾时刻），下一帧两边都从开头放；seek 后读回只到微秒。
- 暂停时机：WPE 由工作线程判断，实测第 32 帧冻住，我们是第 31 帧。
- 预览、桌面、应用背景同时播同一张场景时各解各的。
- 视频尺寸和纹理尺寸不同时只拷重叠部分、记一条 warning（WPE 缩放到纹理尺寸；语料 0 段）。

**语料**（173 个工程）：能渲染 47 → 50（`3822149301`（HEVC）、`3824550659`、`3828359750`）；报 `tex:video` 的 41 张只去掉这个键。P9b：用到 `getVideoTexture` 的 6 张（3243449890、3276911872、3326873240、3361965869、3470764447、3605722997）只去掉 `script:api:layer.getVideoTexture`，能渲染数不变，它们还差别的节（人偶、相机、`input`、粒子层的 `play` 等）；强制渲染下按时段切换、改速度、自写控制都和脚本逻辑一致，没有和视频有关的报错。P9d 的走查（复制工程只留视频图层，`ignore/p9/p9d/walk/`，抓帧 `A:\p9d\walk\`）：3823859141、3400241651、3822149301、3812007032、3816870245 五张的视频纹理、一张经缩放的整帧，差异都只剩上面的已知差异；语料 60 段全部拆得了，Matroska 那段（3816870245，7049 帧）与 ffprobe 逐包相同。P9e（VP9，[phase-9e-vp9.md](../../../.claude/plans/wpe-import/3-scene/phase9/phase-9e-vp9.md)）：本机库 88 个工程的 128 段视频纹理里只有 3662390671 一段不是 H.264 / HEVC；它的复制工程（`ignore/p9/p9e/walk/`，抓帧 `A:\p9e\vp9\`）在 7.000 s 那一帧和 WPE 的视频纹理只差色度纵向位置（两边各按自己的位置重建都最大差 1；两边之间平均 2.63、最大 89，锐利彩色描边多）；superframe 与 1 字节的 show_existing_frame 块在真解码器上一块出一帧（硬解、软解都是 40 块 40 帧）。

**dev 探针**：`host.videos()` 给每段视频的位置、`currentTime`、`paused`（时钟停着）、`wantPlay`、`lastDrawn`、当前帧号、`fresh`、`failed`、尺寸、时长，解码计数 `decoded` / `dropped` / `queued` / `decodeQueue`、`stallResets` 与色彩说明 `color`。`renderFrame` 的 `videoTime`（秒，或按纹理路径分别给；超过时长按循环取模、钳到 `duration − 0.005`）给每段视频建播放器、跳到那一刻、等目标帧到手，留一份帧给每个 draw 拷，结果的 `videos` 带实际取的 `time` 与帧的显示时间 `frameTime`；主窗口最小化时照常可用。这是屏外宿主里确定性回放视频的唯一办法（屏外 iframe 里 rAF 不跑）；vite 的 `/render` 与 MCP `render_scene` / `host_render` 收同名参数。

### 脚本 `IVideoTexture`（P9b）

`thisLayer.getVideoTexture()`（任何图层上都有）：图层基础材质槽 0 是视频纹理时返回包装对象，每个图层一个、之后是同一个；不是视频时返回 `null`（WPE 同样；3276911872 的预设脚本挂在非视频图层上，两边报同样两条错）。「是不是视频图层」只看 bundle，语料诊断与 `realmProbe` 没有播放器时也照样建对象，方法空操作。

| 成员 | 照 WPE 实测 |
|---|---|
| `duration` | 只读（严格模式写入抛 `TypeError`），容器时长的 float32（`mvhd` 2.517 → 2.5169999599456787）；没有播放器时取 bundle 里的容器时长 |
| `loop` | 包装对象自己的字段，缺省真，**读出数字 1 / 0**（和 WPE 自带的 `.d.ts` 不同）；写入取 `Boolean` 并转给播放器 |
| `rate` | 包装对象自己的字段，缺省 1，读出 float32；写入取 `Number`、不是有限数时不写；负数播放器按 0 处理（WPE 负数会让工作线程卡死，不复刻），其余非负有限数都收（P9d 起时钟是自己的） |
| `play()` / `pause()` / `stop()` | 返回 `undefined`；已结束（`loop` 为假）时 `play()` 先回到 0；`stop()` = 暂停 + 回到 0，之后 `isPlaying()` 为假 |
| `setCurrentTime(t)` / `getCurrentTime()` | 钳到 `[0, duration − 0.005]`；读出 float32 |
| `isPlaying()` | 布尔（`想放 && !已结束`）；空闲暂停、宿主暂停期间仍为真；解码失败为假，脚本 `play()` 之后为真 |
| `addEndedCallback(fn)` | 不去重、没有删除；`loop` 为真时每次绕回、为假时结束那一帧各一次，在这一帧的脚本 `update` 之前、在登记它的脚本上下文里调（`ScriptRuntime.callFor`，类别 `ended`，出错只记诊断不禁用），不带参数 |
| `getAnimation()` | 返回 `undefined`（WPE 有这个成员） |

自有属性按 WPE 的 `Object.keys` 顺序：`duration`、`loop`、`rate`、`addEndedCallback`、`play`、`setCurrentTime`、`isPlaying`、`stop`、`pause`、`getCurrentTime`、`getAnimation`。宿主暂停恢复时把所有播放器置为想放（连脚本暂停、停止过的也放，同 WPE 读码）。
