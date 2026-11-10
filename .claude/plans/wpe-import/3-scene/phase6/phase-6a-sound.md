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

**思路：** 编译期解析声音对象进 bundle 的声音表，宿主建播放器、按 WPE 规则排期；音量与暂停接宿主现有通路；能力表放开声音对象和步骤 0 认定的字段。

**要点（步骤 0 之后细化成点）：**
- **编译**（`compile/bundle.ts`、`compile/features.ts`、`compile/bindings.ts`）：声音表 `SceneSound { object, files, mode, mintime, maxtime, startSilent, volume }`；文件按资源解析顺序定位（散文件给 `file:` 地址，pkg 条目给区间），`volume` 绑用户属性进 P3a 的就地路径。
- **播放器**（新增 `audio/`）：一个 `AudioContext`（音量为 0 时不建）、每个声音对象一个增益节点、按需建 `<audio>`；排期逻辑写成不依赖 DOM 的纯函数（输入时间与随机数，输出「此刻该放哪个文件、从哪开始」），能在 Node 里单测，也能用 WPE 的日志序列回放核对。
- **宿主**（`host.ts`、`main.ts`、`wpe_shim.js`）：垫片把音量经 `wallpaperPropertyListener` 交给场景宿主（只在场景宿主里，网页壁纸不受影响）；`setPaused` 同时暂停播放器；场景重编译时保留播放器与播放位置，卸载时释放元素、Blob 与 `AudioContext`。
- **能力表：** 放开 `object:sound`、`playbackmode`、`mintime`、`maxtime`、`startsilent`、`volume`；`muteineditor`、`solid`、`attenuation`、`mindistance` 中性（步骤 0b）；`spatialization: true` 报 `object:spatialization`。

**验收：**
- 4 张解锁（只做 P6 时 2 张），人耳和 WPE 比：开始时机、循环、音量；`3778592720` 的随机切换间隔。
- 确定性工程：各播放模式的状态序列和 WPE 的日志、频谱逐帧比（`random` 选哪个文件比分布，不比序列）。
- 应用背景、暂停、壁纸音量为 0 时不出声，也不建 `AudioContext`；预览关掉后元素和 Blob 都释放。
- 不含声音的场景，语料与基线逐张相同。

## 步骤 2 — 脚本控制

- 声音层的脚本对象加上 `play` / `pause` / `stop` / `isPlaying` / `volume`，其它图层照旧；写回落进播放器。
- `volume` 挂 `{script}` 的字段脚本（7 个）写回到增益。
- `compile/scriptApi.ts` 删掉这几项；`api.test.ts` 的双向核对照旧。
- **验收：** 确定性工程的脚本序列和 WPE 日志逐帧比；`script:api:layer.play` 等从语料消失。

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
