# P6a — 声音（子计划）

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)「P6a — 声音」。前置已提交（`4dd05464`）。
> 语料是 2026-11-11 的扫描（`ignore/p6/out/pre-after.json`，165 个工程，能渲染 36 张；声音对象的细节 `ignore/p6/sound_detail.py` 读 `out/objects-new.json`）。现状锚点取自 HEAD `4dd05464`。
> 分四步：步骤 0 只调研；步骤 1–3 每步能单独验收、单独提交。P4、P5 在别的会话进行，实现步骤动工前再核对一次共享文件。

## 总体设计思路

声音对象不画东西，所以 P6a 不碰渲染图，只在宿主里加一个**声音播放器**：编译期把声音对象解析成 bundle 里的声音表（文件、播放模式、音量、开始是否静音），运行时由播放器按 WPE 的规则排期播放，每帧跟着场景状态更新音量与暂停。声音对象在 bundle 里仍是一个没有 pass 的图层，层级、名字、`getLayer` 照旧；播放器只按下标挂在它旁边。

**播放走媒体元素，不整段解码。** 语料的声音文件 180 个引用、合计 1.5 GB，最大一段 114 MB（FLAC），整段 `decodeAudioData` 解成 PCM 要上 GB，不可行。每个文件做成一个 `<audio>` 元素（散文件直接用 `file:` 地址，`scene.pkg` 里的条目按区间读成 Blob），经 `MediaElementAudioSourceNode` 接进宿主唯一的 `AudioContext`，每个声音对象一个增益节点乘自己的 `volume`。Chromium 负责流式解码，一个文件同一时刻最多一个元素。

**音量和暂停接现成的通路。** 宿主里的垫片已经把实时 `AudioContext` 的输出接到主增益、乘宿主音量（桌面与预览是设置里的壁纸音量，应用背景与暂停时为 0），接进 Web Audio 的媒体元素不再在元素上乘第二次（`wpe_shim.js` 的 `routed`）。所以播放器不用自己处理宿主音量；但垫片吞掉了音量消息，宿主拿不到「音量是不是 0」。要做到「音量为 0 时不建 `AudioContext`、不读文件」，垫片要把音量也交给场景宿主，和 `setPaused` 一样走 `wallpaperPropertyListener`。暂停时播放器暂停全部元素，恢复时从原处接着放（以步骤 0 的 WPE 行为为准）。自动播放不用手势：CEF 启动参数已有 `autoplay-policy=no-user-gesture-required`。

**语义以 WPE 为准，靠读码加日志对时序。** 播放模式（`loop` / `single` / `random`）、`mintime` / `maxtime` 的间隔、多文件怎么选、`startsilent`、`volume` 大于 1、父层隐藏时停不停，这些都要先查清。声音抓不进 RenderDoc，步骤 0 用两种办法拿 WPE 的真值：测试工程的脚本每帧用 `console.error` 把 `isPlaying` 写进 WPE 的 `log.txt`；或者让 WPE 自己的频谱 uniform（`g_AudioSpectrum*`，它采的是系统回环，含 WPE 自己的输出）进 CLK 层，每个测试文件放不同频率的纯音，抓帧就能逐帧看出哪段在响。第二种不依赖脚本 API，能测「没有脚本」时的自动播放。

**脚本控制和三维声音单独成步。** 解锁的 4 张都是纯背景音乐、没有脚本，步骤 1 只做自动播放就能解锁；`ISoundLayer` 的 `play` / `pause` / `stop` / `isPlaying` / `volume` 是步骤 2，带声音对象的 35 张脚本里调了 `.play(`。三维声音（`attenuation` / `mindistance`）只有 1 张，排最后，步骤 0 读完再定做不做。

## 范围与解锁

| 步骤 | 内容 | 只做 P6 时累计能渲染 | P4、P5 先做完时 |
|---|---|---|---|
| 0 调研 | 读码 + 确定性工程实测 | 36 | — |
| 1 自动播放 | 声音对象、三种播放模式、`startsilent`、`volume`（含用户属性）、宿主音量与暂停 | 38 | 4 张 |
| 2 脚本控制 | `ISoundLayer`：`play` / `pause` / `stop` / `isPlaying` / `volume`；`volume` 挂脚本 | 38 | — |
| ~~3 三维声音~~ | 步骤 0b 取消：语料 0 张打开 `spatialization` | — | — |

解锁明细：
- **步骤 1：** `1967162875`、`3827677885`（只差声音）；P4、P5 先做完时再加 `1514925620`、`3778592720`（还差 `particle:children`）。这 4 张都没有脚本：前 3 张是一个或两个 `loop` 单文件，`3778592720` 是 `random` 三个文件、`mintime` = `maxtime` = 1。
- 步骤 2、3 不单独解锁：用脚本控制声音的场景都还挡着文本、交互等别的键。

语料里的声音对象（161 个，77 张）：
- `playbackmode`：`loop` 109（107 个单文件）、`single` 46、`random` 6（2–4 个文件）。
- `mintime` 全是 1；`maxtime` 155 个是 5，另有 1 和 2。
- `startsilent` 79 个为真；`volume` 84 个是数，70 个绑用户属性，7 个挂脚本；`3173418061`、`3605722997` 写成 2.0。
- 没有一个写 `visible`；49 个有 `parent`，74 个写了 `origin`（2 个挂脚本）。一张场景最多 13 个声音对象。
- 格式：`mp3` 144 个、`flac` 20、`wav` 15、`ogg` 1；180 个文件引用里 178 个在 `scene.pkg` 里。
- 脚本：带声音对象的场景里，35 张调 `.play(`、23 张 `.stop(`、16 张 `.pause(`、6 张 `.isPlaying`、3 张 `.volume`。

**P6a 不做：**
- 媒体回调、音频频谱 uniform：P11、P9。
- 预览和桌面同时播放同一张场景时的叠音：沿用网页壁纸现在的行为，两边各放各的。

## 现状锚点

**a. 声音对象整张退回**（`compile/features.ts:394`）
```ts
  } else if (kind && kind !== "image" && kind !== "light") unsupported.add(`object:${kind}`); // 现状：报 object:sound
  // 下面的未知键循环里，playbackmode、volume、mintime、maxtime、startsilent、muteineditor 都报 object:<键>
```

**b. 声音对象进图层表，只有变换**（`compile/bundle.ts:1042`）
```ts
    bundle.layers.push(layer); // 每个对象都进 layers：声音对象是一个没有 pass 的图层
    if (objectKind(object) === "particle") { /* … */ }
    if (!object.image) continue; // 现状：声音对象到这里为止，`sound` 等字段不读
```

**c. 脚本拿得到声音层，但上面没有播放方法**（`script/api.ts:156`）
```ts
  layer(object: number): ApiObject | null {
    // 现状：任何对象都给同一种图层代理：name、id、size 和 LAYER_FIELDS（origin、scale、angles、alpha、color、visible …）
    // 没有 play / pause / stop / isPlaying / volume；脚本调用会抛 TypeError、禁用那个回调
```

**d. API 缺口表**（`compile/scriptApi.ts:168`、`:172`）
```ts
    ...methods("root", ["play", "pause", "stop", "isPlaying"]), // 现状：只认 thisLayer. / thisObject.，经 getLayer(…) 拿到的不报
    ...fields(["alignment", "volume", /* … */]),
```

**e. 垫片接管音量，但吞掉了音量消息**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:207`、`:446`）
```js
        var factor = routed.has(el) ? 1 : hostVolume; // 接进实时 AudioContext 的元素不在元素上乘，避免乘两次
        // …
        event.stopImmediatePropagation(); // 现状：宿主页面自己的 message 监听收不到音量；只经 setPaused 拿到暂停
        hostVolume = clamp01(data.volume);
```

**f. 宿主的暂停只冻结渲染**（`host.ts:519`）
```ts
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.renderer?.setPaused(paused); // 现状：没有声音要停
  }
```

**g. 自动播放不要手势**（`src-tauri/tauri-runtime-kbcef/src/runtime.rs:1069`）
```rust
                cl.append_switch_with_value(
                    Some(&CefString::from("autoplay-policy")),
                    Some(&CefString::from("no-user-gesture-required")), // 现状：壁纸视频为此加的，声音同样受益
                );
```

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

见上「范围与解锁」，脚本 `ignore/p6/sound_detail.py`。

### 0b — 读码（代理，写 `rea-p6a-sound.md`）

目标 `wallpaper64.exe` 2.8.42（核对 SHA-256 前缀 `40e2ce021e935232`），脚本 API 部分另看 `scenescript64.dll`。要回答：
1. **加载：** 声音对象的 JSON 字段全表与缺省值（`sound`、`playbackmode`、`mintime`、`maxtime`、`startsilent`、`volume`、`muteineditor`、`solid`、`attenuation`、`mindistance`、`origin` / `parent` 的作用）；`volume` 大于 1 是否钳制；文件读不到时怎么办。
2. **播放模式：** `loop` 多文件是顺序轮播、随机还是只放第一个；`single` 放完一次之后的状态；`random` 怎么选文件（会不会连放同一个）、两次之间按 `mintime` / `maxtime` 怎么等（均匀分布？秒？放完之后才开始等？）。
3. **时机：** 加载完立即开始，还是第一帧之后、还是等资源解码；`startsilent` 为真时的初始状态；同一张场景多个声音是否同步开始。
4. **暂停与可见：** WPE 暂停壁纸（其它程序全屏、手动暂停）时声音停不停、恢复从哪接着放；父层或自身 `visible` 为假时声音停不停（语料没有 `visible`，但脚本可能改）；壁纸被换走、场景重载时。
5. **音量：** 对象 `volume` 怎么乘进去，WPE 的全局音量设置（`config.json` 里的键名）和「其它程序出声时静音」等选项，属性改 `volume` 是否立即生效、有没有渐变。
6. **解码与输出：** Media Foundation 解码（`MFCreateSourceReader`）支持哪些格式，输出走什么（XAudio2、WASAPI），重采样和声道。
7. **脚本 API（`ISoundLayer`）：** `play` / `pause` / `stop` / `isPlaying` / `volume` 的语义：`stop` 后 `play` 从头还是接着放，`random` 模式下 `play` 做什么，`isPlaying` 在 `startsilent`、`single` 放完、暂停时的值，写 `volume` 的范围。
8. **三维声音：** `attenuation` / `mindistance` 怎么用对象位置算音量和声像，参照点是相机、场景中心还是指针。

产出照以前的读码文档：概括、元数据（目标哈希、方法、工作文件在 `ignore/p6/rea/sound/`）、逐题结论带地址与置信度、未查清的列表、建议的实测。

### 步骤 0b 实施记录（2026-11-11）

读码在 [rea-p6a-sound.md](rea-p6a-sound.md)（代理写，没有实测），工作文件 `ignore/p6/rea/sound/`。

**我核对过的：**
- 声音引擎在 `bin\mediaextensions64.dll`，不在 exe 里，也不走 Media Foundation。dll 里有「OpenAL Soft」、SFML 的报错文案「Failed to open sound file」「Failed to play audio stream」，以及 FLAC 字符串，exe 里都没有。
- `spatialization` 是 exe 里的键。语料 149 个工程、5575 个 JSON 里只有 `3832133196` 写了它，值是 `false`。

**结论（以实测为准，0c 核对）：**

| 问题 | 读码结论 | 置信 |
|---|---|---|
| 谁是声音对象 | 有非 null 的 `sound` 键；字符串或数组都行 | 确 |
| 缺省值 | `volume` 1、`mintime` 1、`maxtime` 5、`playbackmode` loop、`startsilent` / `muteineditor` / `spatialization` 假 | 确 |
| `muteineditor`、`solid` | 播放器里没有读取点 → 中性 | 确，有界 |
| 文件 | 第一次开始播放时整份读进内存；读不到就从列表删掉，不报错 | 确 |
| 选文件 | 三种模式都用 CRT `rand()` 带放回随机选，可能连选同一个 | 确 |
| `loop` | 单文件循环；多文件每个放一遍、紧接着随机换下一个，中间不留空 | 确 |
| `single` | 放一遍，不再自动重放 | 确 |
| `random` | 从开始播放算起，等「时长 + U(mintime, maxtime) 秒」再选下一个；随机数取自和粒子共用的 mt19937 | 确 |
| 时机 | 对象加载时就同步读文件、开始播放，不等第一帧；多个声音按对象顺序依次启动 | 确 / 推 |
| 可见 | 自身或父层 `visible` 为假都不停 | 确 |
| WPE 暂停 / 静音 | 全局音量按 `k = min(1, 6·dt)` 指数淡到 0，到 0 时暂停；恢复时从原处续播；计时冻结 | 确，触发条件推 |
| 音量 | 增益 = `volume² × 全局音量`（对象音量**取平方**）；运行时改立即生效、无渐变；`volume` 不钳制，但 OpenAL 把增益钳到 1 | 平方确，钳制推 |
| 格式 | WAV、OGG Vorbis、FLAC、MP3 | 确 |
| `ISoundLayer` | `play`：暂停中续播，否则停掉、重新随机选、从头放（`random` 在等待中什么都不做）；`stop`：停并回到开头；`pause`；`isPlaying` 在 `random` 的间隙里、WPE 自身暂停时仍为真 | 方法确，`isPlaying` 的取值推 |
| 三维声音 | 只有 `spatialization: true` 才生效；位置是对象世界位置减 `g_EyePosition`、投到相机轴；`attenuation` / `mindistance` 是 OpenAL 的 rolloff / reference distance | 确 |

**对后面几步的影响：**
1. **步骤 3 取消。** 语料没有一张打开 `spatialization`，`attenuation` / `mindistance` 在步骤 1 定为中性，`spatialization: true` 报新键 `object:spatialization`。
2. **音量要平方、要钳制。** 每个声音的增益是 `min(1, volume² × 宿主音量)`。宿主音量现在由垫片乘在主增益上，播放器看不到；为了钳制，播放器要知道宿主音量，增益节点设成 `min(1, volume²·h) / h`。这更说明步骤 1 要让垫片把音量交给场景宿主。
3. **排期按读码：** `loop` 多文件带放回随机连播；`random` 的间隔从开始播放算起；暂停按 `min(1, 6·dt)` 淡出淡入，计时冻结；可见性不影响。`random` 的等待随机数和粒子共用一个源，我们这边用场景的随机源，序列本来就对不上，只比规则和分布。
4. **开始时机：** WPE 在加载时就开始放，不等第一帧。我们在宿主收到 bundle、建播放器时开始，不等 GPU 资源。
5. **不整段读入的做法不变：** WPE 自己是整份读进内存再流式解码，我们改用 Blob 加媒体元素，占用相近（Blob 是压缩数据）。

### 0c — 确定性工程与实测（Claude）

读码给了 12 条建议实测（rea-p6a-sound.md 末节），按优先级：音量平方（最优先）、`volume` 大于 1 的钳制、`loop` 多文件、`random` 间隔、`single`、`play` / `pause` / `stop` 的语义、`startsilent` 与音量从 0 起步、可见性、WPE 暂停的淡出、启动时机、多声音同步。三维声音不测。

### 步骤 0c 实施记录（2026-11-11）

结果在 [p6-REPORT.md](p6-REPORT.md)「P6a 声音语义的实测核对」：读码的结论除暂停淡出没测外**全部成立**，没有推翻的。

**取数办法和计划不同：**
- 不用 RenderDoc。频谱那一路改成脚本：WPE 的 `engine.registerAudioBuffers(64)` 每帧给 64 段频谱，探针脚本连同 `isPlaying` 一起用 `console.error` 写日志，几十秒连续、每帧都有。
- 但脚本的频谱带自适应归一化，只能认频率，比不了音量。音量与时序改用 WASAPI 回环录系统混音、自己按频率量幅度（`uv run --with soundcard --with numpy`，只进 uv 缓存）。
- 实测从扬声器放了 11 个工程的测试音，桌面壁纸没碰，WPE 设置没改（壁纸音量只经 `apply_properties` 改了测试窗口自己的）。

**对后面几步的影响：**
1. **音量：** 增益 `min(1, volume² × G)` 实测成立，钳制在乘积上。播放器每个声音的增益节点设成 `min(1, volume²·h) / h`（h 是宿主音量，垫片的主增益再乘 h）；h = 0 时不出声、不开始。
2. **开始：** 音量为 0 时不开始；从 0 变成正数时才从文件开头放（`p6a-silent`）。宿主音量从 0 变正数时按同一规则。
3. **单声道声像：** WPE 在本机上单声道源每个前置声道约 0.62，我们不补偿（系数随设备变），记为已知差异；若人耳对比明显偏响，再在单声道源上乘一个固定的 0.707。
4. **测试窗口的壁纸音量缺省 50：** 和 Kabegame 无关（我们用设置里的壁纸音量），只影响以后的对照：对照 WPE 时先 `apply_properties({volume: …})` 设成已知值。
5. **步骤 1 的验收工程现成：** `p6a-*` 这套工程导入 Kabegame 后，同样录回环、同样分析，和 WPE 的录音逐段比。



- **工程**（`kbp gen` 新模块 `ignore/p6/defs/p6a.py`）：每个声音用不同频率的纯音（单声道 WAV，自己生成，几秒长，开头结尾各有一段静音便于定时），覆盖 `loop` 单 / 多文件、`single`、`random`（2–3 个文件，`mintime` / `maxtime` 取小值）、`startsilent`、`volume` 0.5 / 2.0，以及挂在隐藏父层下的声音、脚本 `play` / `stop` / `pause` 序列。
- **WPE 真值两路：**
  - 日志：脚本每帧用 `console.error` 写 `帧号 isPlaying`（`console.log` 不进 `log.txt`，p3-script-REPORT I4），`log_mark` / `log_since` 截取；
  - 频谱：`general.supportsaudioprocessing: true`，CLK 层多带一组读 `g_AudioSpectrum64Left` 的像素，`kbp rdc` 逐帧读出各频带的能量，按频率认出正在响的文件。先用一个最简单的 `loop` 工程确认 WPE 的回环能采到它自己的声音。
- **我们这边：** 宿主日志（脚本的 `console.error` 进应用日志）和播放器的 dev 探针（每帧各声音对象的状态、当前文件、播放位置）。
- **会出声：** 实测会从扬声器放出测试音（纯音，几秒一段），桌面壁纸不动。动手前向用户确认，并检查别的会话没有在用 WPE 抓帧。

## 步骤 1 — 自动播放

### 思路

声音分三层，彼此只经很窄的接口相连：
- **编译期的声音表：** bundle 多一个 `sounds`，每个声音对象一条，记文件的磁盘位置和各字段的值。
- **排期器：** 纯 TS，照 WPE 的状态机逐项复刻（实例状态、暂停位、停止位、计时 `T`、剩余时长 `Rm`），只对抽象的「播放后端」发命令。它不碰 DOM，在 Node 里能单测，也能直接对着 p6-REPORT 的实测序列核对。
- **播放后端：** 浏览器侧，媒体元素加 Web Audio，按命令建元素、播放、暂停、调增益。

排期器由渲染器每帧推进：在粒子步进之后、脚本之前，用同一个帧时间，对应 WPE 在对象更新里走声音计时器；暂停时帧不前进，计时自然冻结。

文件时长要到媒体元素拿到元数据才知道，而 WPE 是同步读完再放的。所以后端的「开始」是异步的：排期器发出「放第 k 个文件」后，计时 `T` / `Rm` 从后端报回的真正开始时刻起算。差的只是 WPE 那边「同步读整份文件」占掉的时间。

宿主音量 h 由垫片交给场景宿主，排期器把它当 WPE 的全局音量 G：
- h 从正变 0：暂停在放的声音；`single` / `random` 已放完的停掉。
- h 从 0 变正：续播；之前从没开始过的，从头开始。
- 每个声音的增益节点设成 `min(1, volume²·h) / h`，垫片的主增益再乘 h，合起来就是 WPE 的 `min(1, volume²·G)`。
- 暂停走同一条路，只是先按 WPE 的指数淡出（时间常数 1/6 s，音频线程上 `setTargetAtTime`），再暂停元素。

### 现状锚点（补充）

**h. 渲染器每帧的顺序**（`render/renderer.ts:537`）
```ts
    try {
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor); // 现状：对象更新只有粒子
    } catch (error) { /* … */ }
    scene.setCamera(camera);
    if (live) this.options.beforeFrame?.(frametime); // 脚本
```

**i. 就地绑定的样板：粒子 `instanceoverride`**（`compile/bindings.ts:127`、`render/state.ts:328`）
```ts
  | { kind: "particle-instance"; object: number; field: InstanceKey } // 编译期登记，SceneState.particleInstances 存值，sync 交给模拟器
```

**j. 文件的磁盘位置**（`compile/fs.ts:5`）
```ts
export interface SceneFile {
  source: SceneSource;
  size: number | null; // pkg 条目有确切长度；散文件为 null
  location: { path: string; offset: number }; // 要读的真实文件与内容起点：散文件就是它本身，pkg 条目是 scene.pkg 加偏移
```

### 点 1 — 声音表（`compile/bundle.ts`、`compile/bindings.ts`、`render/state.ts`）

- **新增** `SceneSound` 与 `SceneBundle.sounds`：
```ts
export interface SceneSound {
  object: number;                       // objects 下标（稳定键）；同一对象在 layers 里仍有一个没有 pass 的图层
  files: SceneSoundFile[];              // 解析得到的文件；找不到的、扩展名不是 wav / ogg / flac / mp3 的不进表（WPE 读不出就从列表删掉、不报错）
  mode: "loop" | "single" | "random";
  mintime: number;                      // 缺省 1
  maxtime: number;                      // 缺省 5
  startSilent: boolean;
  volume: number;                       // 缺省 1，不钳制；绑用户属性时是解析后的值
}
export interface SceneSoundFile {
  path: string;                         // scene.json 里写的相对路径
  location: { path: string; offset: number }; // 同 SceneFile.location
  size: number | null;                  // pkg 条目的长度；散文件 null（直接用 file: 地址）
}
```
- **新增** 绑定目标 `{ kind: "sound"; object: number; field: "volume" }`，`SceneState.sounds: Map<number, { volume: number }>`，起始值 = 编译期的 `volume`；写入不标脏，排期器每帧读。
- **修改** `compileScene` 的对象循环：`objectKind(object) === "sound"` 时解析 `sound`（字符串或数组，`fs.resolve` 逐个定位）并读各字段，`sound` 键为 null 或缺失的不是声音对象（同 WPE）。

### 点 2 — 能力表（`compile/features.ts`）

- **修改** `checkObjectFeatures`：`kind === "sound"` 不再报 `object:sound`；声音对象上放行 `sound`、`playbackmode`、`volume`、`mintime`、`maxtime`、`startsilent`、`muteineditor`、`attenuation`、`mindistance`、`spatialization: false`。
- **新增** 报键：
  - `spatialization` 为真报 `object:spatialization`（三维声音，没做）；
  - `playbackmode` 不是 `loop` / `single` / `random` 报 `sound:playbackmode:<值>`；
  - `volume` 挂 `{script}` 报 `sound:volume:script`（步骤 2 删）；
  - `startsilent` 等布尔键绑用户属性报 `sound:binding:<键>`（语料 0 个，WPE 没有回调）。
- **修改** `checkScriptFeatures`：场景里有声音对象时，任意接收者上的 `play` / `pause` / `stop` / `isPlaying` 都报 `script:api:layer.<名>`（现在只认 `thisLayer.`，经 `getLayer(…)` 拿到声音层再调会漏报），步骤 2 实现后删掉这条。

### 点 3 — 排期器（新增 `audio/scheduler.ts`）

- **新增** `SoundScheduler`：一个声音对象一个，照 rea-p6a-sound 第 2、5、7 节与 p6-REPORT 实现 `P`（开始 / 续播）、`U`（每帧）、`V`（音量变化）、全局音量变化，以及步骤 2 要用的 `stop` / `pause` / `isPlaying`。
```ts
export interface SoundBackend {
  start(file: number, loop: boolean): void;   // 从头放第 file 个文件；开始后经 onStarted(file, duration) 回报
  resume(file: number, loop: boolean): void;  // 续播
  pause(file: number): void;
  stop(file: number): void;                   // 停并回到开头
  setGain(gain: number): void;                // 已含 min(1, volume²·h) / h
}
export class SoundScheduler {
  constructor(sound: SceneSound, backend: SoundBackend, random: () => number);
  load(globalVolume: number): void;           // 对应 WPE 加载虚函数：不是 startSilent 且 volume²·G > 0 才 P
  update(dt: number, volume: number, globalVolume: number): void; // 每帧：音量变了走 V，G 变了走全局规则，再走 U
  onStarted(file: number, duration: number): void;                // 后端回报：设 T / Rm
  // 步骤 2：play() = P、pause()、stop()、isPlaying()
}
```
- 选文件用 `random`（单独的随机源，不动粒子的 `R`：WPE 选文件用 CRT `rand()`、间隔用和粒子共用的 mt19937，序列本来对不上，只照规则）。
- **新增** `audio/scheduler.test.ts`：假后端记录命令序列，逐条覆盖 p6-REPORT 表里的行为（`loop` 单 / 多文件、`random` 的间隔与 `isPlaying`、`single` 与陷阱、音量 0 起步、全局音量降到 0 再恢复、`volume` 2 的钳制）。

### 点 4 — 播放后端（新增 `audio/player.ts`）

- **新增** `ScenePlayer`：场景一个，管 `AudioContext`、每个声音的增益节点、按文件的 `<audio>` 元素和 Blob。
  - h = 0 时不建 `AudioContext`、不建元素、不读文件；h 第一次变正时再建。
  - 散文件：`audio.src = fileToUrl(location.path)`；pkg 条目：主线程 `reader.readRange(location.path, offset, offset + size)` 读成 Blob，`URL.createObjectURL`。元素 `preload = "auto"`，`loadedmetadata` 后才真正 `play()` 并回报 `onStarted(file, duration)`。
  - 单文件 `loop` 用元素的 `loop`；多文件、`single`、`random` 不循环，换文件由排期器定。
  - 连线：元素 → `MediaElementAudioSourceNode` → 每个声音的增益 → 场景的淡变增益 → `destination`（垫片把这条接到主增益、乘 h，接进 Web Audio 的元素上不再乘第二次）。
  - `dispose()`：暂停并清空元素、`revokeObjectURL`、`AudioContext.close()`。
- 读文件失败、解码失败：照 WPE 从这个声音的文件列表里删掉，宿主日志记一条 warn，不退回。

### 点 5 — 宿主与垫片（`host.ts`、`main.ts`、`render/renderer.ts`、`src-tauri/kabegame/src/webview_js/wpe_shim.js`）

- **修改** `wpe_shim.js`：收到音量消息时，把宿主音量放进一个只读的 `window.__kabegameHostVolume`，再派发 `kabegame-host-volume` 事件。网页壁纸读得到也无妨（只是自己的音量）；不调页面的 `wallpaperPropertyListener`，以免和 WPE 的网页 API 撞名。
- **修改** `main.ts`：读初值、监听事件，交给 `host.setHostVolume(h)`。
- **修改** `SceneRenderer`：`options` 加 `stepObjects?(dt)`，在 `stepParticles` 之后、脚本之前调；宿主在里面推进各排期器。补画帧（帧时间 0）不调。
- **修改** `SceneHost`：
  - `load` 之后按 `bundle.sounds` 建排期器与播放器；
  - 重编译时同一对象的排期器保留，播放不中断（文件表变了才重建该对象的）；
  - `setPaused(true)` 时让播放器淡出后暂停，恢复时续播（暂停期间 h 已经是 0，走全局音量规则）；
  - `dispose` 时释放播放器。
- **dev 探针：** `host.sounds()` 返回每个声音对象的模式、当前文件、实例状态、`T`、`Rm`、`isPlaying`、增益，给真机核对用。

### 点 6 — 文档

`cocs/wpe/WPE_SCENE.md` 加「声音（P6a）」一节，cocs 索引与 changelog、回归按惯例补。

### 实施方式

照前置：在 HEAD 快照里实现、交子代理，我核对后按块合进工作区。点 5 改了 Rust 内嵌的 `wpe_shim.js`，要用户重启 dev 才能真机验。

### 验收

- **单测：** 排期器覆盖 p6-REPORT 表里的全部行为；tsc、vitest、Prettier 通过。
- **语料：** `1967162875`、`3827677885` 解锁（P4、P5 先做完时另有 2 张）。其余变化只在声音相关的键上；不含声音对象的场景，结果和基线逐张相同。
- **真机：** `p6a-*` 工程导入 Kabegame，用同样的回环录音和分析脚本，和 WPE 的录音逐项比：
  - 播放模式的段序列与间隔；
  - 两边都设成同一个壁纸音量后，各对象的幅度比（含 `volume` 2 的钳制）；
  - 音量 0 起步；
  - 暂停后续播。
- **生命周期：** 应用背景、暂停、壁纸音量为 0 时不出声，也不建 `AudioContext`；关掉预览后元素和 Blob 都释放（dev 探针看）。
- **人耳：** 两张解锁场景和 WPE 比。

### 步骤 1 实施记录（2026-11-11）

**做法：** 在 HEAD `bafb4a93` 的快照（`ignore/p6/a1/work`，基线 `a1/base`）里实现，交子代理；垫片与场景文档在副本上改（`a1/shim/`、`a1/WPE_SCENE.md`）。我逐段读过排期器（对着读码的 `P` / `U` / `V` / `X`）、播放器、宿主接线、垫片与入口，独立重跑验证后，补丁 `ignore/p6/a1/out/step1.patch` 打进工作区。期间 HEAD 只多了一个文档提交，产品代码与快照基线相同。

**新增：** `compile/sounds.ts`、`audio/scheduler.ts`、`audio/sceneSounds.ts`、`audio/player.ts` 与各自的单测。**修改：** `compile/bindings.ts`、`compile/bundle.ts`、`compile/features.ts`、`compile/scriptApi.ts`、`render/state.ts`、`render/renderer.ts`、`host.ts`、`main.ts`、`script/runtime.ts`、`dev/install.ts`；`wpe_shim.js`；`cocs/wpe/WPE_SCENE.md`「声音（P6a）」；我另补了垫片单测（`wpeWebVolume.test.ts`）、cocs 索引、changelog、回归。

**和子计划不同、或子计划没写的取舍（都按最贴近 WPE 实测）：**
1. **暂停：** 宿主音量在暂停时已经是 0（垫片的主增益立即归零），排期器立即暂停元素；淡变增益只在恢复时听得出淡入。
2. **文档隐藏按暂停处理：** 渲染循环停转、计时冻结，不暂停的话多文件和 `random` 放完一段就断了。
3. **`SceneBundle.sounds` 是可选字段：** 测试里手写的 bundle 不用改（那些文件 P4、P5 也在改），读的地方按空表处理。
4. **开始是异步的：** `T` / `Rm` 从后端回报起算；等回报期间 `isPlaying` 按 WPE 当场的值（真），`random` 不会重复开始。
5. **文件失败在开始时才知道：** 照 WPE 删掉，正在等它的用剩下的文件重新选；`play()` 被拒（如 `NotAllowedError`）只记 warn，不删文件。
6. **`sound:binding:<键>`** 扩到 `playbackmode` / `mintime` / `maxtime` / `startsilent` / `spatialization` 绑属性或脚本（语料 0 处）；`playbackmode` 按全小写精确匹配，未知值报 `sound:playbackmode:<值>`。
7. `single` 的音量从 0 变正不自动开始：照读码 `V` 跳过 `single`，实测没覆盖到。
8. pkg 的 Blob 只在场景释放时撤销；重编译换掉某个对象的文件时，旧 Blob 留到场景释放。

**我核对时记下的风险：**
- 某个文件的 `duration` 读出来是无穷大时（流式 MP3 可能如此），多文件 `loop` 拿不到时长，`T` 为 0，放完这个文件后不再切换。语料没见到，真机测到再处理（可改用元素的 `ended` 事件）。
- 散文件直接用 `file:` 地址接进 `MediaElementAudioSourceNode`：若 CEF 把它判成跨源，输出会静音。要真机确认。

**验证：**
- tsc 0 error；vitest 62 个文件、1652 个用例全过（基线 58 个、1592 个，新增 60 个）；垫片测试 24 个全过；Prettier 通过。
- 语料 165 张：能渲染 36 → 38（`1967162875`、`3827677885`），没有掉出；有变化的 77 张正好是含声音对象的。去掉的是 `object:sound` 及其键；新增 `script:api:layer.play` 35 张、`stop` 23、`pause` 15、`isPlaying` 6，以及 `sound:volume:script` 4 张。
- 真机（回归 S2–S6）没做：垫片是 Rust 内嵌的，要用户重启 dev。

**真机（2026-11-11，用户重启 dev 后）：** 导入 `p6a-vol2`、`-loopmulti`、`-random`、`-single`、`-silent`（`-play` 要步骤 2），图库预览里放，用测 WPE 时同一套回环录音与分析脚本比。测试工程的探针脚本调了声音层的 `isPlaying()`，按步骤 1 的规则会被报不支持，所以临时打开了宿主的 dev 强制渲染开关，测完已删；测试行已用 `projects_remove` 删掉；壁纸音量改回原来的 1。

| 项目 | Kabegame | WPE（p6-REPORT） |
|---|---|---|
| 音量平方与钳制 | G = 1 / 0.5 / 0.25 时 A / B 都是 1.00，D / B = 1.00 / 2.00 / 4.00，C / B 2.0、E / B 9.0；改音量当场生效 | 一致 |
| `loop` 多文件 | 段长是文件长或整数倍，段间 0–0.02 s | 段间 0–0.06 s（20 fps） |
| `random` | 固定间隔 2.00 s；随机 13 个间隔 1.86–3.92 s、均值 2.70 | 2.00 s；1.70–3.94 s、均值 2.82 |
| `single` | 放一遍 2.00 s，之后 `isPlaying` 假、实例状态仍是在放 | 一致 |
| 音量属性 0 → 1 | 之前不建 `AudioContext`；改值后从文件开头放；`startsilent` 的不出声 | 一致 |
| 壁纸音量 0 → 正 | 暂停在原处、`isPlaying` 仍真，恢复从原处续播；音量 0 时打开场景不建 context、不建元素，调回后从头放 | 一致 |
| 切预览 | 上一个场景的声音在切换那一刻断掉 | — |

- 散文件经 `file:` 地址接进 `MediaElementAudioSourceNode` 正常出声，「跨源静音」的风险不成立。
- 单声道源输出是文件幅度 × G，WPE 另乘约 0.62：已知差异，不补偿。
- **没覆盖：** 应用背景与桌面「暂停壁纸」（与音量 0 同一条路，宿主音量为 0 / `setPaused`）、pkg 条目的 Blob（测试工程都是散文件）、两张解锁场景的人耳对比（回归 S4–S6，待用户）。

## 步骤 2 — 脚本控制

### 思路

声音层的脚本对象加上 WPE 的 `ISoundLayer`：`play` / `pause` / `stop` / `isPlaying` 四个方法和可读写的 `volume`，直接接到步骤 1 的排期器上（方法在排期器里已经实现并测过）。`volume` 的写入和用户属性走同一条路：落到就地目标 `{ kind: "sound" }`，并当场调排期器的 `V`（WPE 改值立即生效、没有渐变，暂停时也是）。`volume` 挂 `{script}` 的字段脚本（4 张）每帧把返回值写回到同一个目标。

**粒子层也有这四个名字。** WPE 的 `IParticleSystem` 同样有 `play` / `pause` / `stop` / `isPlaying`（重新发射、停止发射、清空），那是 P4f 的事。语料里这些调用的接收者绝大多数静态认不出类型（463 处认不出，能认出的 16 处都是声音层；`ignore/p6/a2/overlap.py`），所以不能按接收者区分。规则改成：
- 把这四个名字从缺口表的 `layer` 组删掉（声音层有了）；
- 场景里**有粒子层**时，任意接收者访问这四个名字都报 `script:api:particle.<名>`，P4f 实现粒子的这几个方法后删掉这条；
- 语料里同时有声音、粒子并调了这几个方法的有 28 张，它们在 P4f 之前继续退回（多半另有文本等阻塞）。

### 点 1 — 声音层的脚本对象（`script/api.ts`）

- **新增** 访问排期器的接口：`ScriptApiAccess` 加 `sound(object): SoundScriptTarget | null`（宿主从 `SceneSounds` 取），`SoundScriptTarget` 只露 `play()` / `pause()` / `stop()` / `isPlaying()`。
- **修改** `layer(object)`：对象是声音对象时多定义这四个方法（同 WPE 的方法表，只登记在声音层上）和 `volume` 访问器：读 `SceneState.sounds` 的值；写走 `write({ kind: "sound", object, field: "volume" }, value, "float")`，不钳制。其它图层不加，调用照旧报 `TypeError`（WPE 的方法也只登记在对应类型上）。

### 点 2 — 写回与字段脚本（`compile/scripts.ts`、`host.ts`、`compile/features.ts`）

- **修改** 字段脚本的目标：声音对象的 `volume` 挂 `{script}` 时，目标是 `{ kind: "sound", object, field: "volume" }`，`update` 的返回值每帧写回。
- **修改** `host.ts`：脚本写到 `sound` 目标后当场 `syncSoundVolumes`（同属性就地写）。
- **删除** 能力键 `sound:volume:script`。

### 点 3 — 能力表（`compile/scriptApi.ts`）

- **删除** `MISSING_SCRIPT_API.layer` 的 `play` / `pause` / `stop` / `isPlaying` 与字段 `volume`，以及步骤 1 加的「有声音对象时任意接收者照报」。
- **新增** 「有粒子层时任意接收者照报」：`script:api:particle.<名>`，名单在 `PARTICLE_LAYER_METHODS`（不进 `MISSING_SCRIPT_API`，那张表由 `api.test.ts` 和 `ScriptApi` 双向核对，粒子的方法不在 `ScriptApi` 上也不该在声音层之外出现）。

### 验收

- **单测：** 声音层有、其它层没有这几个方法；`volume` 读写、写入当场生效、字段脚本写回；能力表的新旧规则；`api.test.ts` 双向核对照旧。
- **语料：** `script:api:layer.play` 等全部消失；有粒子层的场景出现 `script:api:particle.*`；`sound:volume:script` 消失；能渲染的场景不减少。
- **真机：** `p6a-single`（放完后 `pause` 再 `play` 的陷阱）与 `p6a-play`（在放时 `play` 从头、`pause` → `play` 续播、`stop` → `play` 从头、重复 `pause`）导入 Kabegame，回环录音和 WPE 的段序列比，CTRL 脚本的 `[p6c]` 日志（调前调后的 `isPlaying`）逐条比。

### 步骤 2 实施记录（2026-11-11）

**做法：** 同步骤 1：HEAD `b4d57aaa` 的快照（`ignore/p6/a2/work`，基线 `a2/base`）里实现、交子代理，我读过 `script/api.ts`、`host.ts`、`compile/scripts.ts` 的改动、独立复跑后，补丁 `ignore/p6/a2/out/step2.patch` 打进工作区；期间 HEAD 没动这些文件。宿主产物按 `scripts/plugins/wpe-scene-host-plugin.ts` 的说明用 `deno task --cwd apps/wpe-scene build --mode development` 重建，不重启 dev。

**改动：** `script/api.ts`（`SoundScriptTarget`、`ScriptApiState.sound`、只在声音层装 `play` / `pause` / `stop` / `isPlaying` 与 `volume`）、`host.ts`（把排期器交给脚本 API；脚本写 `sound` 目标后当场 `setVolume`）、`compile/scripts.ts`（声音对象的 `volume` 字段脚本目标是 `sound`）、`compile/features.ts`（删 `sound:volume:script`）、`compile/scriptApi.ts`（删表里的四个方法与 `volume`、删步骤 1 的声音规则、加 `PARTICLE_LAYER_METHODS`）、`compile/bundle.ts`；单测在 `api.test.ts`、`host.script.test.ts`、`sounds.test.ts`、`scriptApi.test.ts`。

**取舍：**
1. 脚本写音量后只同步写到的那个对象，值取脚本看到的状态（首次加载 `init` 时它还不是渲染器的状态），首帧前重放写入时再同步一次。
2. 粒子规则照子计划：任意接收者都报，包括声音层自己脚本里的 `thisLayer.play()`（静态能确定不是粒子，这一种可以放过，没做，留给 P4f 一起定）。
3. 字段脚本只认对象顶层的 `objects/<i>/volume`。

**验证：**
- tsc 0 error；vitest 64 个文件、1701 个用例全过；Prettier 通过。
- 语料 165 张，能渲染 38 → 38、没有掉出；去掉 `script:api:layer.play` 36 张、`stop` 24、`pause` 16、`isPlaying` 7、`layer.volume` 1、`sound:volume:script` 4；新增 `script:api:particle.play` 38、`stop` 29、`pause` 16、`isPlaying` 8；变化 46 张。
- **真机：** 测试工程写了 `supportsaudioprocessing: true`（WPE 那边的探针要频谱），这一项报不支持，所以仍要临时开强制渲染（测完已删）。`p6a-play` 的 `[p6c]` 日志 8 条和 WPE 逐条相同；录音里在放时 `play` 从头重来、`pause` → `play` 接着放、`stop` → `play` 从头放都成立。`p6a-single` 三段 2 秒的声音对应自动播放、陷阱重放、12 秒的 `play`，日志 `pause 0 0`、`play 0 0`、`play 0 1` 与 WPE 相同。录音里有一次 40–60 ms 的整体输出中断（两个声音同时静音），像音频设备欠载，不是排期问题，记作观察。测试行已删。

## ~~步骤 3 — 三维声音~~（步骤 0b 取消）

语料没有一张打开 `spatialization`。`attenuation` / `mindistance` 在步骤 1 定为中性，`spatialization: true` 报 `object:spatialization`。以后有样本再按 rea-p6a-sound 第 8 节做（`PannerNode`，距离模型 `inverse clamped`，只对单声道源）。

## 风险

1. **WPE 的回环采不到自己的声音**：频谱那一路就不成立，只剩脚本日志，测不了「没有脚本」时的自动播放时机，只能靠读码加人耳。
2. **随机序列对不上**：`random` 的选择和间隔用 WPE 自己的随机数，逐帧比不了，只能比分布和规则。
3. **Blob 的内存**：一张场景的声音可以上百 MB，Blob 常驻；预览和桌面同时开时翻倍。实测不行就让 Rust 把 pkg 区间解到缓存文件、改用 `file:` 地址。
4. **媒体元素的循环有缝**：`<audio loop>` 在循环点可能有几十毫秒的空隙，WPE 若是无缝循环，要改成两个元素交替或用 `AudioBufferSourceNode` 播短文件。
5. **和 P4、P5 抢文件**：步骤 1 要改 `compile/bundle.ts`、`compile/features.ts`、`compile/bindings.ts`、`host.ts`、`script/api.ts`，动工前看一次另两边的工作区；新代码尽量放进新模块。

## 决定

**已定：**
1. 进入 P6a（2026-11-11 用户）。

**待定（附推荐）：**
1. ~~**实测出声**~~：2026-11-11 用户同意，已做完，见步骤 0c 实施记录。
2. ~~**步骤 3 做不做**~~：读码后取消，见上（语料 0 张打开 `spatialization`）。
