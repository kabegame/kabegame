# P6 — 声音、文本、交互与动态图层（总计划）

> 上级：[PLAN.md](../PLAN.md)「P6 — 声音、文本、交互与动态图层」。前置：P3b 脚本运行时、P3-0a 宿主音量通路、P4b 帧表解析、P4c 指针。
> 调研与总计划和 P4、P5 的实施并行（2026-11-10 用户），不改产品代码。本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `47486b72` 的语料扫描，2026-11-11 用户新下载 13 张后重扫（`ignore/p6/out/corpus-new.json`，165 个工程，能渲染 35 张，新的 13 张都还不能渲染），以及对 `scene.json` 的只读扫描：
> 文本、声音对象（`ignore/p6/scan_objects.py` → `out/objects-new.json`）、脚本导出与 API 用法（`scan_scripts.py` → `out/scripts-new.json`）、
> 按节去键的解锁数（`ana_order.py`）、声音与字体文件大小（`sizes.py`）。152 张时的结果留在 `out/corpus-head.json` 等不带 `-new` 的文件里。
> 后续 Phase 的名字照 PLAN.md 2026-11-11 的重分（D15）：P7–P13，旧名见 PLAN.md「旧名对照表」。
> 读码：本节还没有专门的读码。已有的依据是 [p3-script-REPORT](../phase3/p3-script-REPORT.md) C 节（导出回调表、作用域限制、`thisScene` 方法），
> 以及 `wallpaper64.exe` 的字符串：有 `DWriteCreateFactory`、`hb_shape`、`hb_buffer`（文本推断走 DirectWrite 加 HarfBuzz），
> 有 `MFStartup`、`MFCreateSourceReader`（声音推断用 Media Foundation 解码）。这些都要在各节步骤 0 确认。

## 总体设计思路

PLAN 原来把 P6 定成一张 dino_run：文本、声音、几个建层删层的脚本 API。按语料重扫，这几类能力挡住的远不止一张。165 张语料里，87 张有文本对象（945 个），77 张有声音对象（161 个），47 张的脚本要光标输入或光标回调，21 张要建层、删层或读层级，16 张在图像层或 effect 上用了帧表。合起来 106 张，比粒子还多。所以 P6 和 P4、P5 一样，把目标定成覆盖这几类用法，不只做一张样本。

单看解锁数，P6 不如 P5：这 106 张里多数还挡着视频纹理、关键帧动画、puppet 这些更重的能力（P9、P10、P12）。只做 P6，能渲染从 35 张到 40 张；P4、P5 先做完的话，是 45 张到 56 张。P6 的价值主要在覆盖面：文本和声音是工坊场景里最常见的两类对象，后面几节的场景几乎都要。

这些能力分成五块，彼此基本独立：
- **声音**：新的对象种类，不画东西。在宿主里用 Web Audio 播放，音量走 P3-0a 已经接好的宿主音量消息。最独立，和 P4、P5 几乎不抢文件，所以排第一。
- **文本**：新的对象种类，画法和图像层相同。差别只在基础纹理：用字体和文字栅格化出来，脚本改文字时重画。945 个文本对象里 746 个的 `text` 挂着脚本（多半是时钟），307 个带 effect，所以文本必须走图像层的完整 effect 链。
- **交互**：光标回调（`cursorClick` / `Down` / `Up` / `Move` / `Enter` / `Leave`，带命中测试）和 `input.*`。原来在 W4，D15 提前到这里：dino_run 靠 `cursorDown` 跳跃，P6 做完能渲染的场景里还有 3 张导出了光标回调。
- **动态图层与层级 API**：`createLayer` / `destroyLayer` / `sortLayer`、`registerAsset`、`getInitialLayerConfig`、`effect.getMaterial`，以及 `getParent` / `getChildren` / `getTransformMatrix` / `getEffect`。难点在 `createLayer`：WPE 当场返回图层，我们的着色器翻译在 Worker 里是异步的。
- **图像层帧表**：P4b 已经解析了帧表（`TEXS`）、写了粒子的帧表宏，图像层只差宏、uniform 和 `getTextureAnimation`。

还有一处便宜的能力表修正，放进「前置」先做：脚本导出了我们没实现的回调（光标、媒体等）时，现在既不调用、也不报，场景会静默缺交互。按 2026-11-07「用到没实现的 API 就整张退回」的约定，这些回调也要照报。现在能渲染的 35 张里没有一张受影响；P4、P5 做完后会有 1 张（`3810092560`），所以要赶在它们之前改。

关键决策沿用 P4、P5：
- 能力表是唯一事实来源，每块先细分出键，没实现的照报，整张退回。
- WPE 语义以读码加实测为准。
- 验收和 WPE 比，不和作者的预览图比。

文本和声音的验收方式要另定。文本画出来的是纹理，可以抓帧逐像素比，但两边的栅格化器不同（WPE 是 DirectWrite，Chromium 的画布文字是 Skia 加 DirectWrite 字体后端）。纹理尺寸和字形位置可以要求严格一致，抗锯齿只能按误差包络比。声音抓不进 RenderDoc，验收改成比播放状态的时序：测试工程的脚本用 `console.error` 把状态写进 WPE 的 `log.txt`，我们这边经应用日志拿同一串，两边逐帧比。真实的出声靠人耳确认。

## 范围与覆盖

| 节 | 新增能力 | 用到的场景 | 只做 P6 时累计能渲染 | P4、P5 先做完时累计 |
|---|---|---|---|---|
| 前置 | 未实现的导出回调照报（`script:callback:*`） | 光标 47、媒体 30 | 35 | 45 |
| P6a 声音 | 声音对象、播放模式、音量、脚本控制、三维声音 | 77 | 37 | 49 |
| P6b 文本 | 文本对象、字体、排版、背景 / 阴影 / 描边、脚本改文字 | 91 | 38 | 51 |
| P6c 交互 | 光标回调与命中测试、`input.*` | 47 | 39 | 53 |
| P6d 动态图层 | 建层、删层、排序、`registerAsset`、层级与 effect 访问 | 21 | 40 | 54 |
| P6e 帧表 | 图像层帧表（含多图像帧表）、`getTextureAnimation` | 16 | 40 | 56 |

口径：
- 「用到的场景」是报这一节任一键的场景数。光标和媒体回调按 `scene.json` 里脚本的 `export` 粗扫，前置改完后以编译期扫描为准。文本一节含文本对象上的脚本字段（`layer.text`、`layer.maxwidth` 等），所以比有文本对象的 87 张多。
- 「累计能渲染」按表的顺序依次去掉各节的键，数 `unsupported` 为空的场景。
- 「P4、P5 先做完」去掉 `particle:*` 和 P5 总计划列的键（透视、深度、剔除、组合层、`fullscreen`、`nopadding`、`instanced`、相机对象、mdl），不去掉形状对象（P8）。
- 起点 45 比去键后的 46 少 1 张，就是前置改完后照报的 `3810092560`。
- 2026-11-11 新下载的 13 张都不在解锁明细里：它们都还要 P7–P13 的能力。

解锁明细（P4、P5 先做完时）：
- **P6a：** `1514925620`、`1967162875`、`3778592720`、`3827677885`。只做 P6 时是 `1967162875`、`3827677885`。
- **P6b：** `2304304373`、`2391389126`。只做 P6 时是 `2391389126`。
- **P6c：** `3637191856`、`3810092560`。只做 P6 时是 `3637191856`。
- **P6d：** `3304642534`（`createLayer` 造 63 根音频条，2026-11-07 发现的那张）。
- **P6e：** dino_run、`3826860299`。两张都还要 P5 的键（dino_run 是 P5b 的 `fullscreen` 和组合层），只做 P6 时解锁不了。

先做文本还是先做声音，最终数一样。先做声音，中途解锁得多一些，也更少和 P5b 抢图像层的代码。

**P6 不做，继续报不支持：**
- 媒体回调 `media*Changed`（30 张）：P11。前置先照报，不再静默。
- `engine.openUserShortcut`（1 张，`3643916956`）：打开用户在属性里配置的快捷方式，和 `usershortcut` 属性类型一起归 P11。
- `object.getAnimation`、`thisScene.getAnimation`、`animationEvent`：P10（关键帧动画）。
- `getAnimationLayer*` 与骨骼：P12。`getVideoTexture`：P9。
- 文本对象上的 `depthtest`：语义要 P5d 的深度附件。P5d 先做完就在 P6b 放开；没做完就照报，P6b 只放开其余文本键。
- 图像层的 `alignment`（21 张）、`dependencies`（9 张）、`nointerpolation`（3 张）：P8。

## 现状锚点

行号按 HEAD `47486b72`。

**a. 文本、声音对象整张退回，它们的键都报 `object:<键>`**（`compile/features.ts:388`、`:394`）
```ts
  } else if (kind && kind !== "image" && kind !== "light") unsupported.add(`object:${kind}`); // 现状：报 object:text / object:sound
  // …
  for (const [key, value] of Object.entries(object))
    if (!SUPPORTED_OBJECT.has(key) && /* … */ active(value))
      unsupported.add(`object:${key}`); // 现状：font、pointsize、playbackmode、volume 等都落进「未知键」
```

**b. 编译只认粒子和图像**（`compile/bundle.ts:1037`）
```ts
    bundle.layers.push(layer);
    if (objectKind(object) === "particle") {
      await compileParticle(index, object, layer);
      continue;
    }
    // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
    if (!object.image) continue; // 现状：文本、声音对象走到这里，只剩变换
```

**c. 脚本运行时只调四个回调，其余导出静默忽略**（`script/runtime.ts:17`、`:154`）
```ts
type Callback = "init" | "update" | "applyUserProperties" | "destroy"; // 现状：WPE 有 19 个（p3-script-REPORT C）
    if (record.disabled.has(callback) || !record.exports || typeof record.exports[callback] !== "function")
      return; // 现状：cursorDown、mediaPlaybackChanged 等导出从不调用，能力表也不报
```

**d. 没实现的脚本 API 表**（`compile/scriptApi.ts:61`、`:102`–`:104`、`:163`）
```ts
  thisScene: [
    ...methods("root", ["getLayerByID", "createLayer", "destroyLayer", "sortLayer", "getInitialLayerConfig", /* … */]),
  engine: methods("root", ["registerAsset", "openUserShortcut", "requestFeatures"]),
  input: fields(["cursorWorldPosition", "cursorScreenPosition", "cursorLeftDown"]),
  layer: [
    // 现状：play / pause / stop / isPlaying 只认 thisLayer. / thisObject.，经 getLayer(…) 拿到的声音层调 play() 不报
    ...methods("root", ["play", "pause", "stop", "isPlaying"]),
    ...fields(["alignment", "volume", /* … */ "text", "pointsize", "font", "padding", "horizontalalign", /* … */]),
```

**e. 宿主只收指针移动**（`apps/wpe-scene/src/main.ts:30`）
```ts
document.addEventListener("pointermove", (event) => {
  host.setPointer(event.clientX / innerWidth, event.clientY / innerHeight); // 现状：没有按下、抬起；P4c 起用于 g_PointerPosition 与控制点
});
```
桌面的鼠标转发已经对场景壁纸打开（`src-tauri/kabegame/src/wallpaper/manager/window.rs:131` `wp.set_mouse_forwarding(is_web || is_scene)`），转发移动和左键。

**f. 图像层的帧表照报**（`compile/bundle.ts:651` 的注释与 `getTexture`）
```ts
   * `tex:animation`；`tex:animation:multi-image`、`tex:animation:empty` 照报。帧表纹理用在图像层、effect 时照报（图像层的
   * 帧动画属 P6）。
```

**g. 宿主已经拿得到音量**：P3-0a 让场景宿主沿用网页壁纸的音量消息（`kabegame:wpe-volume`，带 `paused`），宿主里的垫片把 Web Audio 连到实时输出的连接改接到每个 context 一个主增益（[phase-3-0a](../phase3/phase-3-0a-host-channel.md) 关键决策：「P6 场景出声时不会被压成 0」）。桌面与预览用设置里的壁纸音量，应用背景与暂停时为 0。

## 与 PLAN.md 的差异

1. **范围：** PLAN 只写 dino_run，改成覆盖语料里文本、声音、交互、动态图层、图像层帧表的全部用法。
2. **交互从 W4 提前（D15）：** 光标回调、命中测试、`input.*` 原在 W4。dino_run 要 `cursorDown`，P6 之后能渲染的场景里还有 3 张要光标回调，不能往后放。
3. **声音的脚本控制从 W4 提前（D15）：** `play` / `pause` / `stop` / `isPlaying` 原在 W4。42 张的脚本里有 `.play(`，其中 35 张有声音对象。API 表对这几个名字只认 `thisLayer.` / `thisObject.`，经 `getLayer(…)` 拿到声音层再调不报；所以声音对象和这些方法必须同时做，否则又是静默缺口。
4. **文本 API 从 W2 提前（D15）：** `thisLayer.text` 等字段和 `systemfont_*`（原 W4）跟文本对象一起做。
5. **层级 API 从 W1 / W5 提前（D15）：** P4a 已经有层级，`getParent` / `getChildren` / `getTransformMatrix` 只是读现成的数据。
6. **已经不用做的：** `localStorage`（P3b 已实现、持久化）、`camerafade`（能力表已当中性，加载淡入不改稳定画面）、godrays 等多 pass effect（P2a 起已支持）。
7. **声音播放方式：** PLAN 写「WebAudio 播放」「音量为 0 时不解码、不建 `AudioContext`」。语料里的声音文件最大 114 MB（FLAC），一段 87 MB 的 MP3 约一小时，整段 `decodeAudioData` 解成 PCM 要 1 GB 以上，不可行。改成流式：媒体元素播放，接进 Web Audio 的主增益（见 P6a）。
8. **验收：** PLAN 写「dino_run 可玩」，改成和 WPE 比，见各节。

## 前置 — 未实现的回调照报

**改动：** 编译期扫描脚本时，已经知道每段的源码。导出了 WPE 回调表里、我们没实现的回调，报 `script:callback:<名>`：
- 光标：`cursorHitTest`、`cursorEnter`、`cursorLeave`、`cursorMove`、`cursorClick`、`cursorDown`、`cursorUp`（P6c 实现后删掉）；
- 媒体：`mediaStatusChanged`、`mediaPlaybackChanged`、`mediaPropertiesChanged`、`mediaThumbnailChanged`、`mediaTimelineChanged`（P11）；
- 其它：`resizeScreen`、`applyGeneralSettings`、`animationEvent`（P10）。

和 API 表一样「实现一个删一个」，`script/api.test.ts` 双向核对表和运行时实际调用的回调。

**怎么认导出：** 运行时拿的是模块对象的导出名，编译期只有源码。用和 API 表同一套词法扫描，认 `export function 名`、`export async function 名`、`export { 名 }`、`export const 名 =`。漏认会变回静默缺口，所以宁可多报；语料里所有段的结果和真实 `import` 后的导出名对一次（用 P3b 步骤 6 的 `scriptCorpus` 探针）。

**验收：** 现有 35 张逐张相同；语料的变化只有这几个新键。

## P6a — 声音

**步骤 0：**
- **对象字段：** `sound`（文件数组，152 个对象 1 个文件，9 个对象 2–4 个）、`playbackmode`（`loop` 109、`single` 46、`random` 6）、`mintime` / `maxtime`（`mintime` 全是 1，`maxtime` 多是 5，推断是 `random` 两次播放之间的随机间隔）、`startsilent`（79 个为真）、`volume`（70 个绑用户属性、7 个挂脚本，有 3 个写成 1.2，大于 1 时怎么处理要查）。多文件时 `loop` 是顺序轮播还是只放第一个，`random` 怎么选文件。
- **中性字段：** `muteineditor`（推断只在编辑器里起作用）、`solid`（声音对象上的意义）。
- **时机：** 加载完立即开始播放，还是第一帧之后；场景暂停、壁纸被遮挡时停不停、恢复时从哪接着放；属性改 `volume` 是否立即生效。
- **全局音量：** WPE 自己的音量设置怎么乘进来（壁纸音量、「其它程序出声时静音」等），哪些 Kabegame 已经有对应设置。
- **脚本：** `ISoundLayer` 的 `play` / `pause` / `stop` / `isPlaying` / `volume`，`startsilent` 时 `isPlaying` 的初值，`stop` 之后 `play` 从头还是接着放。
- **格式：** `mp3` 144 个、`flac` 20、`wav` 15、`ogg` 1。Chromium 都能解码，确认 WPE 有没有不支持的（它用 Media Foundation 解码，FLAC 支持取决于系统版本）。
- **三维声音：** `attenuation` / `mindistance` 的语义（1 张，`3832133196`）：声音对象的位置和距离怎么影响音量、声像，参照点是相机还是指针。

**实现：**
- 声音文件按区间读出（180 个文件引用里 178 个在 `scene.pkg` 里，合计 1.5 GB），做成 Blob，交给媒体元素播放，经 `MediaElementAudioSourceNode` 接进宿主的 `AudioContext`。不整段解码：最大的一段 114 MB。
- 主音量沿用宿主音量消息：音量为 0 时不建 `AudioContext`、不读文件，大于 0 时再建。暂停时暂停全部声音。
  宿主里的垫片既接管媒体元素的 `volume`，又把 Web Audio 改接到主增益；媒体元素再经 `MediaElementAudioSourceNode` 进 Web Audio 时，宿主音量可能被乘两次，步骤 0 先核对。
- 播放模式按步骤 0 的结论实现。`random` 的随机间隔用场景的随机数源。
- 声音层进 `getLayer` / `enumerateLayers`，实现 `ISoundLayer`；`volume` 的属性绑定和脚本写回走 P3a 的就地路径。
- 能力表：放开 `object:sound` 与上面实现的字段；`script:api:layer.play` 等删掉；不认识的字段照报。
- 三维声音按步骤 0 的结论用 Web Audio 的 `PannerNode` 或增益实现，放开 `object:attenuation` / `object:mindistance`。
- 预览和桌面同时播放同一张场景时会叠音：沿用网页壁纸现在的行为，不另做处理（网页壁纸也是两边各放各的）。

**验收：**
- 4 张解锁（P4、P5 先做完时；否则 2 张）。人耳确认声音和 WPE 一致：开始时机、循环、音量。
- 确定性工程：每种播放模式、`startsilent`、脚本 `play` / `stop` / `pause` 加 `isPlaying`。脚本每帧用 `console.error` 把 `isPlaying` 和帧号写进日志，WPE 的 `log.txt` 和 Kabegame 的应用日志逐帧比。
- 应用背景、暂停、音量为 0 时不出声，也不建 `AudioContext`。

## P6b — 文本

**步骤 0：**
- **栅格化：** WPE 是不是 DirectWrite 加 HarfBuzz，抗锯齿模式（灰度还是 ClearType）、gamma、纹理格式。抓帧能拿到文本对象的纹理，先抓几张看。
- **尺寸：** `pointsize` 到像素的换算（是否乘 96/72）；纹理尺寸怎么由文字、`padding`（数字和 `"x y"` 两种写法）、`maxwidth`、`maxrows`、`limitwidth`、`limitrows` 定；`size` 字段和纹理尺寸的关系；文字变了纹理尺寸跟不跟着变。
- **排版：** `horizontalalign`（center 750、left 133、right 62）、`verticalalign`、`anchor`（9 种取值，`none` 535）、`spacing`（`"x y"`，字距与行距）、换行规则、`limituseellipsis` 的省略号位置。
- **字体：** 文本对象里 496 个用 `ttf`、362 个用 `otf`、87 个用 `systemfont_*`。按场景去重后是 272 个字体文件，148 个在 `scene.pkg` 里，124 个取自 WPE 的 `assets`。`systemfont_*` 有 7 种（arial 62 个，其余是 sansserif、consolas、comicsans、calibri、cambria、segoe），各对应哪个系统字体；字体里没有的字（中文场景很多）走哪个回退字体。
- **装饰：** `backgroundcolor` / `backgroundbrightness` / `opaquebackground`（598 个对象写了这几个键，只有 2 个开不透明背景）、`dropshadow*`、`outline*`，各画在纹理里还是另一个 pass。
- **作为图层：** 文本对象用哪个材质、着色器和混合；`color` / `alpha` / `brightness` 怎么乘；effect 链的输入尺寸；`clampuvs`（173 个对象）；对象级的 `depthtest`（546 个对象写了 `enabled`）。
- **脚本：** `text` 挂脚本时 `update` 每帧返回字符串，没变时是否重画；`thisLayer.text`、`pointsize`、`font` 等字段可写，写了何时生效。
- **性能：** 746 个挂脚本的文本对象（82 张）多半是时钟，一秒变一次；有没有每帧都变的。

**实现：**
- 字体在主线程用 `FontFace` 从字节加载（`Worker` 读不了 `file:`，字节照常由主线程代读），按场景缓存，场景卸载时释放。最大的字体 25 MB。
- 主线程用 `OffscreenCanvas` 按 WPE 的规则排版、栅格化，上传成图层的基础纹理。文字、字体、字号、排版字段变了才重画，同一帧内多次修改只画一次。
- 文本对象作为图像层的一种：基础纹理换成文字纹理，其余（变换、颜色、effect 链、合成 RT）复用图像层的路径。
- `systemfont_*` 按步骤 0 的映射用系统字体名，不随应用分发字体。
- 文本绑定用户属性（24 张）走 P3a 的就地路径，改了重画纹理，不整场重编译。
- 能力表：放开 `object:text` 与实现了的字段，`script:api:layer.text` 等删掉；`depthtest` 看 P5d（见「P6 不做」）。

**验收：**
- 2 张解锁（只做 P6 时 1 张），和 WPE 同一时刻的画面比。
- 确定性工程：每个排版字段一组，和 WPE 抓帧里的文本纹理比。纹理尺寸、每行的基线和字形包围盒要一致，像素按误差包络比（门槛在步骤 0 实测两边的抗锯齿差异后定）。
- 脚本改文字：时钟类工程，纹理只在文字变时重画。

## P6c — 交互

**步骤 0：**
- **命中测试：** 哪些对象参与（图像、文本、粒子？），用图层的四边形还是纹理的 alpha；`cursorHitTest` 导出时怎么覆盖缺省命中；层叠时谁收到事件（最上面一个，还是都收到）。
- **回调：** 每个回调在哪个脚本上调（光标下的图层自己的脚本、场景上的脚本，还是全部）；参数里有什么（位置是场景坐标还是屏幕坐标）；`cursorEnter` / `cursorLeave` 的判定时机；`cursorClick` 和 `Down` / `Up` 的关系（拖出图层再抬起算不算点击）。
- **`input.*`：** `cursorWorldPosition`、`cursorScreenPosition` 的坐标系，和 P4c 的指针反投影、P5a 的视差点是不是同一个点；`cursorLeftDown` 只看左键。
- **时机：** 回调在帧内什么位置调（`update` 之前还是之后），一帧里多次点击怎么排。
- **测试手段：** 不移动用户的鼠标（P4c 的约定）。看能不能给 MCP 开的测试窗口直接发鼠标消息（`PostMessage` 的 `WM_MOUSEMOVE` / `WM_LBUTTONDOWN`），WPE 的桌面壁纸靠钩子收输入，测试窗口未必收消息。这一条决定验收能不能自动化。

**实现：**
- 宿主收 `pointerdown` / `pointerup`（今天只有 `pointermove`），按壁纸样式换算到场景坐标（复用 P4c 的 `sceneCursor`）。
- 每帧按步骤 0 的规则做命中测试，派发光标回调；`input.*` 在宿主维护。
- 桌面靠已有的鼠标转发；预览在 `interactive` 时 iframe 已收指针事件，点击照常派发；应用背景不交互。
- 能力表：删掉 `script:callback:cursor*` 和 `script:api:input.*`。

**验收：**
- 2 张解锁（只做 P6 时 1 张）。
- 确定性工程：重叠图层、隐藏图层、带变换的图层上的点击与进出，回调序列写进日志，和 WPE 比（能自动发鼠标消息时）；不能时用读码结论做单测，再真机手点核对。

## P6d — 动态图层与层级 API

**步骤 0：**
- **`createLayer`：** 参数形态（模型路径、配置对象、`registerAsset` 返回的句柄、`getInitialLayerConfig` 的结果）；新层插在哪（末尾、父的子节点）；当帧画不画；id 和名字怎么取。
- **`destroyLayer` / `sortLayer`：** 删掉后脚本手里的对象变成什么；`sortLayer` 的下标是全局顺序还是同级顺序。
- **`registerAsset`：** 只能在模块顶层调（p3-script-REPORT C），WPE 在加载时就把资源准备好，推断是为了让 `createLayer` 当场可用。
- **`effect.getMaterial`：** 返回什么，改材质常量何时生效；和 3c 的 effect 对象怎么对上。
- **层级 API：** `getParent` / `getChildren` / `getTransformMatrix` 的返回值，`getTransformMatrix` 是本地还是世界矩阵。

**实现：**
- 编译期把三类东西预先编好：`registerAsset` 登记的资源、场景里已有对象的配置、脚本源码里能静态看出来的 `createLayer` 参数。`createLayer` 运行时只组装预编译的结果，当场返回图层；资源没准备好的，图层先建出来、下一帧再画。
- 渲染器的图层表支持运行中增删、改顺序；P4a 的层级（世界矩阵、可见性继承、标脏）照常工作。
- 层级 API 读现成的层级数据。
- 能力表：删掉实现了的 `script:api:*`；预编译不了的 `createLayer` 参数报 `script:createLayer:dynamic`。

**验收：**
- `3304642534` 解锁，63 根音频条和 WPE 同一时刻的画面比。
- 确定性工程：在固定帧建层、删层、排序，抓帧比绘制顺序和变换。

## P6e — 图像层帧表

**步骤 0：**
- 图像层的 `SPRITESHEET` 宏、帧 uniform 和粒子有何不同；帧率从哪来、循环规则；`getTextureAnimation` 返回对象的 `setFrame` / `play` / `pause` / `getFrame` / `frameCount` 等。
- 帧表纹理用在 effect 上（`tex:animation` 有一部分是这种）时怎么处理。

**实现：**
- 复用 P4b 的 `TEXS` 解析和帧表宏，图像层每帧算帧号与 uniform。
- `getTextureAnimation` 返回控制对象，写回落在 `SceneState`。
- 多图像帧表（`tex:animation:multi-image`，2026-11-11 新下载的 `3000562427`、`3486806915`，都在图像层上）：一张 `.tex` 里多张图像组成的帧表，步骤 0 查帧怎么映射到图像。
- 能力表：图像层与 effect 上的 `tex:animation`、`tex:animation:multi-image`、`combo:SPRITESHEET` 放开；`tex:animation:empty` 照报。

**验收：**
- P4、P5 先做完时 `3826860299` 解锁；P5b 也做完时 dino_run 解锁，计分、跳跃、建删障碍物都和 WPE 一致，重启后最高分仍在。
- 确定性工程：帧率、循环、脚本 `setFrame`，抓帧比帧号。

## 和 P4、P5 的交界

- **共享文件：** 五块都要改 `compile/features.ts`、`compile/bundle.ts`、`compile/scriptApi.ts`；文本、帧表、动态图层还要改 `render/scene.ts`、`render/graph.ts`。实施时和 P4、P5 一样：同一时刻只让一边改这几个文件，每个实现步骤动工前看一次另两边的工作区。调研和计划可以并行。
- **P4f：** P4f 的「脚本与深度」也要改 `script/api.ts`（`emitParticles` 等）。P6 的脚本改动和 P4f 错开。
- **P5b：** 文本走图像层的 effect 链，P5b 正在改图像层的几何、UV 和合成 RT，P6b 排在 P5b 之后动工最省事。dino_run 也要 P5b。
- **P5d：** 文本对象的 `depthtest` 要深度附件。
- **声音不抢文件：** P6a 新增的代码基本在新模块里，只在能力表、`bundle.ts` 的对象分派和宿主的音量处理上碰共享文件。所以 P6a 可以最先动工。

## 决定

**已定：**
1. 调研与总计划和 P4、P5 的实施并行，不改产品代码（2026-11-10 用户）。
2. 交互提前：光标回调、`input.*`、声音的脚本控制从 W4 提前到 P6，文本 API 从 W2、层级 API 从 W1 / W5 提前。随 PLAN.md 的重分（D15）一起定（2026-11-11 用户）。

**待定（附推荐）：**
1. **范围：** 覆盖语料里五类能力的全部用法（106 张用到），而不是只做 dino_run。推荐覆盖全部。
2. **顺序：** 前置 → P6a 声音 → P6b 文本 → P6c 交互 → P6d 动态图层 → P6e 帧表。推荐这个顺序：前置要赶在 P4、P5 做完之前；声音最独立；文本等 P5b。
3. **文本验收的精度：** 纹理尺寸、基线和字形包围盒严格一致，像素按误差包络比。推荐这样；要逐像素一致只能自己实现 DirectWrite 的栅格化，代价不成比例。
4. **声音验收：** 播放状态逐帧比日志，出声靠人耳。推荐这样。
5. **前置现在做：** 前置只改能力表和测试，量很小，但要动 `compile/scriptApi.ts` 和 `script/api.test.ts`。推荐等 P4、P5 手上的步骤提交后、下一个步骤动工前插进去。

## 风险

1. **覆盖数是上限：** 这里的统计只看 `unsupported` 和 `scene.json` 的粗扫。文本和声音进编译后，字段组合、材质、字体可能暴露新键；光标回调的数字来自正则扫描。
2. **文本像素对不齐：** 两边的栅格化器不同，抗锯齿、hinting、字体回退都可能有差异。中文场景的字体回退最没把握。
3. **`createLayer` 的同步语义：** WPE 当场返回图层。参数在编译期看不出来时只能退回，覆盖数可能比统计少。
4. **交互测不了 WPE：** 测试窗口不一定收发给它的鼠标消息，那样光标回调的语义只能靠读码加人工点。
5. **声音的资源占用：** 一张场景的声音文件可以上百 MB，Blob 常驻内存；预览和桌面同时开时翻倍。要实测，不行再改成由 Rust 把区间解到缓存文件、用 `file:` 地址播放。
6. **自动播放策略：** 宿主是 iframe，Chromium 可能要求用户手势才让 `AudioContext` 出声。网页壁纸现在能出声，推断 CEF 已放开；步骤 0 确认。
7. **和 P4、P5 抢文件：** 见上节。
