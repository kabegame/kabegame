# P5 — 相机、网格与图像模型标志（总计划）

> 上级：[PLAN.md](../PLAN.md)「P5 — 透视相机与静态网格」。前置：P4c（指针、`g_PointerPosition`）。调研与总计划和 P4d–P4f 并行（2026-11-09 用户）。
> 范围：按语料覆盖相机、网格与图像模型标志的全部用法，不再只做 retro、neon_sunset 两张（2026-11-10 用户）。本文件只定目标、分节和验收，各节动工前另写子计划：[P5a](phase-5a-parallax.md)、[P5b](phase-5b-modelflags.md)。
> 统计基于 P4c 收尾的语料扫描（`ignore/p4/c5/out/corpus-wsc.json`，152 个工程，能渲染 22 张），以及 2026-11-09 的只读扫描和网格材质探针（`ignore/p5/`）。
> 读码：[rea-p5-camera](rea-p5-camera.md)（透视、路径、相机对象、抖动、视差、uniform）、[rea-p5-mesh](rea-p5-mesh.md)（mdl、模型对象、深度、绘制顺序）、[rea-p5-modelflags](rea-p5-modelflags.md)（图像模型 JSON 的标志）。都是静态逆向，没有实测；我抽查了视差平滑的常量（3、0.5、1、10）、深度模板状态（三个都是 GREATER）、`cropoffset` 不在 `wallpaper64.exe` 里，都对得上。

## 总体设计思路

PLAN 把 P5 定成两张默认样本。按 P4c 收尾的语料重扫，这一节的键挡住的远不止两张：`cameraparallax` 41 张（10 张只差它），passthrough 类图像模型 54 张，`nopadding`、`instanced` 各二三十张，相机对象 14 张，mdl 网格 12 张，透视相机 10 张。所以 P5 和 P4 一样，把目标定成覆盖这几类用法，直接解锁 18 张，能渲染的场景从 22 张到 40 张。这是到目前为止解锁最多的一节。

这些能力分成四块，彼此独立，按解锁收益排先后：
- **视差与抖动**：只改每次绘制的视图矩阵，不碰几何。指针在 P4c 已经接好，所以最先做，单这一块解锁 12 张。
- **图像模型标志**：改的是图像层的几何、UV、合成 RT 和绘制流程，接在 P2a 的渲染图上。
- **网格**：新的图层种类。mdl 解析成顶点和索引，材质走图像层同一条编译路径，和图像层、粒子按 `objects` 顺序混排。
- **透视相机、相机对象与深度**：最后做。它们改整场的投影，几乎所有 3D 样本都要。

还有几项修正很便宜：读码确认 `cropoffset` 和对象 `config` 中性，translucent / additive 的 pass 不写深度。这几项放进「前置」先做。

关键决策沿用 P4：
- 能力表是唯一事实来源。每块先细分出键，没实现的照报，整张退回。
- WPE 语义以读码加抓帧为准，三份读码在各节步骤 0 实测核对。
- 验收用确定性工程和 WPE 逐像素或逐 uniform 比。真实样本和 WPE 同一时刻的画面比，不和作者的预览图比。

深度是这一节的转折点。WPE 每帧给后备缓冲清一个 D32F 深度，用反向 Z 和 GREATER 比较。材质缺键时三项都是「开」：`depthtest`、`depthwrite` 为 enabled，`cullmode` 为 normal。我们现在的缺省正好相反。语料里图像层材质的 1768 个 pass 全都显式写了 `depthtest` / `depthwrite`，只有 beach、deep_space、eagleflag 的 6 个 pass 没写 `cullmode`。所以改缺省对现有场景基本中性，但这要用基线证明。

## 范围与覆盖

| 节 | 新增能力 | 用到的场景 | 累计能渲染 |
|---|---|---|---|
| 前置 | `cropoffset`、对象 `config` 中性；translucent / additive 或 `depthtest: disabled` 的 pass 上 `depthwrite: enabled` 中性 | — | 22 → 23 |
| P5a | `cameraparallax*` 与对象 `parallaxDepth`、`g_ParallaxPosition`；`camerashake*`；正交 `zoom` | 47 | 35 |
| P5b | passthrough 组合层（`composelayer` / `fullscreenlayer` / `projectlayer`）、`fullscreen`、`projectlayer`、`nopadding`、`instanced`；图像层 `perspective` | 75 | 36 |
| P5c | 静态 mdl（全部版本，不含骨骼、变形）、模型对象、`skin` | 12 | 37 |
| P5d | 深度附件与 `depthtest` / `depthwrite` / `cullmode`；透视投影；相机路径；相机对象；透视下的 2D 图层与粒子 | 34 | 40 |

口径：「用到的场景」是报这一节任一键的场景数。「累计能渲染」按表的顺序依次去掉各节的键，数 `unsupported` 为空的场景。mdl 现在不进编译，所以 9 张带 mdl 的默认样本用探针的结果代替：探针把 mdl 对象换成「用它的材质画的图像层」，透视改成正交，再跑一遍真实编译，补上材质进编译后冒出来的键（`ignore/p5/probe/`）。假设 P4 先全部做完（去掉 `particle:*`），起点是 24 张，P5 之后 43 张。

解锁明细：
- **前置：** `3778549173`。它只差一个粒子 pass 的 `depthwrite: enabled`，这个 pass 是 translucent、`depthtest: disabled`，WPE 不写深度。
- **P5a：** `2272499163`、`2279259068`、`2381978484`、`2382002554`、`2382120706`、`2382121137`、`2570822804`、`2955749185`、`3000769374`、`3445915391`（都只差 `cameraparallax`）；`3818481122`（还要 `g_ParallaxPosition`）；`3830255100`（还要 `camerashake`，它的 `cropoffset` 在前置变中性）。
- **P5b：** `1923929928`。它只差图像层 `perspective`，P4c 收尾时记过。
- **P5c：** retro。正交场景，只差网格；它的模型材质不写深度，没有深度附件也能画对。
- **P5d：** dna_fragment、techno（透视加网格）；neon_sunset（再加深度、剔除、`fullscreen` 与 passthrough）。
- 假设 P4 先做完，`1333579536` 也会解锁。

**P5 不做，继续报不支持：**
- 带骨骼、动画或变形的 mdl（`MDLS` / `MDLA` / `MDMP` 段，3706286085 的 3 个模型）和 puppet warp：W6。
- 网格材质里属于 P8 的内容：arsenal 的 `generic` lightmap / normalmap（探针报 `g_LightmapMapSampler` 翻译失败）与 `_rt_Reflection`，demon_core 的遗留灯 `g_LightsPosition`，fantasticcar 的车漆与 `reflected`，ricepod 的 `selfillum`、`sprite`。
- 音频 uniform：demon_core、audiophile 的 `g_AudioSpectrum*`，归 W2 / P4e。
- 对象 `reflected`、`castshadow`（反射 RT、阴影图集）：P7 / P8。
- 文本对象上的 `depthtest`：36 张，全在文本上，归 P6。
- `attachment`（骨骼挂点）：W6。
- `transparentsorting` / `customsortorder`：语料 0 张开启，先报能力键。
- 相机对象的 `path` 条目动画：语料 22 个相机的 path 文件全是 `{"paths": []}`，先报 `camera:path`。

## 现状锚点

**a. 透视、视差、抖动、缩放整张退回**（`compile/features.ts:264`）
```ts
export function checkSceneFeatures(scene: SceneJson, unsupported: Set<string>): void {
  const g = scene.general ?? {};
  if (!g.orthogonalprojection) unsupported.add("camera:perspective"); // 现状：透视场景直接退回
  for (const key of ["cameraparallax", "camerashake", "supportsaudioprocessing"])
    if (active(g[key])) unsupported.add(`general:${key}`); // 现状：视差、抖动没实现
  if (g.zoom !== undefined && g.zoom !== 1) unsupported.add("general:zoom");
```

**b. 模型对象、相机对象和图像模型标志**（`compile/features.ts:365`、`:194`、`:437`）
```ts
  } else if (kind && kind !== "image" && kind !== "light") unsupported.add(`object:${kind}`); // 现状：mdl 对象报 object:model
const OBJECT_FLAGS = ["perspective", "fullscreen", "passthrough", "attachment", /* … */];
// 相机对象的 camera / fov / zoom / path / queuemode 落进「未知键」，报 object:<键>
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const key of ["puppet", "fullscreen", "passthrough"]) if (active(model[key])) unsupported.add(`model:${key}`);
  // 现状：cropoffset、nopadding、instanced、projectlayer 落进「未知键」；active() 把字符串 "0 0"、数字 1 都当真
```

**c. 深度与剔除：能力表只放行 disabled / nocull，缺键也按 disabled / nocull 编译**（`compile/features.ts:456`、`compile/bundle.ts:846`）
```ts
  if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);
  if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`);
  if (pass.depthwrite && pass.depthwrite !== "disabled") unsupported.add(`depthwrite:${pass.depthwrite}`);
// bundle.ts
      cullmode: pass.cullmode ?? "nocull",     // 现状：WPE 缺键是 normal（剔背面）
      depthtest: pass.depthtest ?? "disabled", // 现状：WPE 缺键是 enabled
      depthwrite: pass.depthwrite ?? "disabled", // 现状：WPE 缺键是 enabled
```

**d. 视图投影只有正交一种，透视只给粒子**（`render/layout.ts:192`、`:202`）
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">): Mat4 {
  return orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH); // 已是反向 Z
}
export function particleViewProjection(/* … */): Mat4 {
  // 透视粒子：相机在 (w/2, h/2, d)，z = 0 平面和正交画面重合（P4a 实测）
```

**e. 场景目标没有深度附件**（`render/scene.ts:994`）
```ts
    const depth = this.own(
      device.createTexture({
        label: "dummy depth", // 现状：只有一张 1×1 深度纹理，给着色器的深度采样槽占位
        size: [1, 1],
        format: "depth32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
```

**f. 翻译器有意不定义 `REVERSEDEPTH`**（`src-tauri/wpesl2wgsl/src/lib.rs:35`）
```rust
/// `GS_ENABLED`、`REVERSEDEPTH` WPE 也恒定义，这里有意不定义：……深度也不是反向的。
// 现状：注释已过时，正交和透视粒子的投影都已是反向 Z；只有阴影、遮挡、体积光的着色器读它
```

## 与 PLAN.md 的差异

1. **范围：** PLAN 只写 retro、neon_sunset 两张，改成覆盖语料里的全部用法（已定 2）。
2. **视差提前：** PLAN 写「指针在 P6 才接」，P4c 已经接好，视差成了 P5 解锁最多的一项。
3. **dna_fragment、techno 从 P7 提前到 P5d：** 探针显示它们只差透视和网格，材质着色器都能翻译。mdl 的版本差异只在一个加载函数里，按版本号跳过几段，不需要单独一节。audiophile 留在 P7（音频、`reflected`、`skin` 加反射）。
4. **图像模型标志：** PLAN 只在 W5 提了一句 `composelayer`，语料里 passthrough 54 张、`nopadding` 33 张、`instanced` 22 张，放进 P5b。
5. **相机对象：** PLAN 放在 W3「带 camera 的对象」。语料 14 张，几乎都是正交场景，改到 P5d。
6. **相机路径：** PLAN 没写。6 张默认 3D 样本有 `camera.paths`（neon_sunset 那条只有一个关键帧）。
7. **验收：** PLAN 写「与预览图一致」，改成和 WPE 抓帧比。

## 前置 — 能力表修正

读码可以定论、改动很小的几项，先做：
- `model:cropoffset` 改成中性：`wallpaper64.exe` 里没有这个字符串，只有编辑器 `wallpaperui.exe` 有。它是编辑器裁掉透明边后的中心偏移，导入时已经加进了 `origin`，渲染时再加一次就重复了。
- 对象 `config` 改成中性：只在托盘、播放列表代码里读。
- `depthwrite: enabled` 在 translucent / additive 或 `depthtest: disabled` 的 pass 上中性：WPE 选深度状态时把混合模式或进去，这两种情况都不写深度（rea-p5-mesh 3.4）。
- 模型 JSON 的布尔键只认 JSON `true`（rea-p5-modelflags §7）：`active()` 现在把数字 1、字符串都当真，按 WPE 收紧，避免误报和误放。
- `parseWpeJson` 认 `//` 注释：fantasticcar 的 `materials/car/glass.json` 有一行，现在解析失败、整张编译抛错。WPE 用 jsoncpp，它缺省允许注释（推断，P5c 步骤 0 用一个带注释的材质确认）。

**验收：** `3778549173` 解锁，和 WPE 画面比；语料的变化只在这几个键上，现有基线逐张相同。

## P5a — 视差、抖动与缩放

读码已经查到能直接实现的程度（rea-p5-camera 5、6），步骤 0 主要是实测核对。

**步骤 0：**
- **视差静止偏移：** 对象偏移是 `o = amount · parallaxDepth(根) ⊙ (origin(根).xy − P)`。指针在中心时，原点不在中心的层也会被推开，这和直觉不同，先测。
- **只看根对象：** 子对象跟着根走，自己的 `parallaxDepth` 不参与；没写 `parallaxDepth` 的对象缺省 (1, 1)。
- **平滑：** `k = min(1, (1 − delay/3)·10·dt)`；视差点的初值是场景中心，开场有一段从中心滑到指针的过渡。
- **指针：** 视差点用的指针先钳到 [0, 1]、y 翻成向上，再直接乘场景宽高。这和 `g_PointerPosition` 同源，不是 P4c 控制点用的反投影，`fit` / `center` 下怎么换算照 `g_PointerPosition` 的现有规则。
- **`g_ParallaxPosition`：** 等于 `clamp(P / (W, H))`，加载时 (0.5, 0.5)，只在开视差时更新。
- **抖动：** 确定性正弦，`T = speed² · g_Time`，偏移加到 eye 和 center 上；正交幅度 `0.01 · amplitude · H`。ricepod 的 roughness 0.1 正好落在阈值上，float 比较结果要测（ricepod 不在本节，只作记录）。
- **缩放：** 正交 `zoom` 在投影上绕场景中心乘 `zoom × 相机 zoom`（p3 L2），和壁纸样式、指针换算的关系一起测。
- **壁纸属性 `cameraparallax`：** WPE 的壁纸属性 `cameraparallax: false` 只把 mouseinfluence 归零，各层的静态偏移不变。Kabegame 没有这个开关，按缺省（开）处理。

**实现：**
- 每帧在脚本之前算视差点、`g_ParallaxPosition` 与抖动偏移，和相机同一步（帧顺序见 rea-p5-camera「一帧里的顺序」）。
- 绘制时，每个对象的 V 左乘自己根对象的视差平移；粒子、文本、模型同样处理。合成 RT 的上屏矩阵也乘这个平移（`0x1401ed27f`）。
- `g_ParallaxPosition` 进引擎 uniform 表。
- 能力表：放开 `general:cameraparallax`、`general:camerashake`、`general:zoom`、`uniform:g_ParallaxPosition`；透视场景开视差不移动对象（语料 0 张），照读码实现。

**验收：**
- 12 张解锁，和 WPE 画面比。
- 确定性工程：读码里的工程 F（视差各方块、父子、缺省深度）、F′（平滑）、抖动按固定 `g_Time`，和 WPE 逐 uniform 比。
- 改指针时只有视差相关的层动，静止偏移和 WPE 一致。

**指针怎么控：** 不用 `SetCursorPos` 移动用户的鼠标，沿用 P4c 的做法：抓帧时由 CLK 层记下每帧的 `g_PointerPosition`，回放时给我们这边喂同一串指针。

**完成情况**（2026-11-10 – 11-12，[子计划](phase-5a-parallax.md)「实施记录」「P5a 收尾」，实测见 [p5-REPORT](p5-REPORT.md)）：
- **分步**：步骤 0 实测核对读码；1 前置（本文件「前置」一节并进来，另加 `parseWpeJson` 认 `/* */`）；2 视差；3 抖动；4 缩放；收尾前补回放逐帧光标；收尾走查「未实测清单」、对齐视差点初值、补开场指针。
- **解锁**：能渲染 23 → 36，和「范围与覆盖」里前置加 P5a 的预期一致。起点比本文件的 22 多 1 张，是同期 P4d 解锁的 `2254685070`。
  - 步骤 1：`3778549173`；
  - 步骤 2：本文件列的 11 张；
  - 步骤 3：`3830255100`；
  - 步骤 4 不单独解锁：`zoom ≠ 1` 的 6 张还被别的键挡着。
- **读码**：公式全部实测成立，补了两处：`roughness` 的临界比较要按 float32 算（ricepod 的 0.1 正好不改长度）；视差点 P 本身不钳制，只有 `g_ParallaxPosition` 钳制。
- **和计划的差别**：
  - 粒子模拟用上一帧的相机（带上一帧的抖动与缩放、不带视差）。步骤 3 端到端补测 `p5a-shakepar` 推翻了「模拟用当帧视图」，所以 `setCamera` 挪到粒子步进之后。
  - effect 的中间 pass 也带视差（动工前补测 `p5a-fx`），所以一个对象的每次绘制都换成 `VP · T(o)`，不只是合成 RT 的上屏。
  - 透视粒子的相机距离随缩放变（`p5a-zoomx*`），计划里没写。
  - 视差点初值是 (W/2 + 2, H/2 + 2)，不是场景中心：WPE 加载时用相机的缺省 eye (2, 2) 算初值。收尾走查发现、REA 查清，已对齐；步骤 2 记的 `delay 2.9` 回放差 1 像素就是它。
  - 开场指针：真机走查发现打开后视差停在中间、鼠标动一下才滑过去。现在应用页在可交互时问一次真实光标（`wpe_scene_cursor` → `kabegame:wpe-scene-pointer`），宿主预热与第一帧就用它。
  - 回放逐帧光标（工具）：开窗期间光标动过的抓帧原来复现不了。现在 kbp 日志可带五列光标（`write_project(…, cursor=True)`），时间线加 `cursors: "log"`，`render_scene`、`particle_corners`、`particle_track` 都收逐帧光标与窗口尺寸。
  - 指针照计划不移动用户的鼠标。走查与逐帧光标的抓帧由用户自己在测试窗口上晃鼠标；只有开场指针的主窗口坐标核对，经用户同意由我们移动了光标。
- **验收**：视差 7 组、抖动 5 组、缩放 5 组测试工程和 WPE 整帧 0 差异，`p5a-shakepar2` 带逐帧光标同样 0 差异；真实样本 `2381978484`、`3445915391`、`3818481122`、`3830255100` 和 WPE 同一时刻比对上；10 张基线场景 × 三档的画面哈希每步不变；2026-11-11 用户真机走查通过（桌面开场还没看）。
- **只记不补**：`delay > 3`、预热时的抖动、重编译时的 `zoom`、`zoom ≤ 0`、`alignmentfliph`、命中测试的视差偏移（W4）、透视场景开视差（P5d），见 `cocs/wpe/WPE_SCENE.md`「相机：视差、抖动与缩放（P5a）」的「已知差异与只记不补」。

## P5b — 图像模型标志

**步骤 0：**
- **passthrough 组合层：** 加载时所有子孙都被标成「不在顶层画」，由组合层按先序画进自己的合成 RT。画子孙时用层的局部正交，超出层矩形的部分裁掉。
  - 基础 pass 按 `copybackground` 分两种：true 用 composelayer 着色器从快照拷贝层背后的画面，false 清成透明，用「alpha 取 MAX」的混合画子层。
  - 没有 effect、没有子层、`colorBlendMode` 是 0 或 31 时整层不画。
  - 语料 174 个组合层对象里 140 多个是「有 effect、无子层」，先核对这一种。
- **`fullscreen`：** 尺寸取槽 0 的图像尺寸（实际都是 `_rt_FullFrameBuffer`），覆盖对象 `size`。几何是 NDC 的 2×2 四边形。
  - 带 effect 时不画基础材质，合成 RT 直接整张拷贝当前目标。
  - 上屏用单位矩阵，`origin`、`scale`、`angles`、相机、视差都不起作用。
  - `_rt_FullFrameBuffer` 的图像尺寸是场景目标还是窗口，没确认。
- **`projectlayer`：** 是带 `autosize` 的 composelayer，尺寸取 `orthogonalprojection` 的宽高；排序键 −∞ 只在透视场景的透明排序里起作用。
- **`nopadding`：** 只关掉无 effect 时上屏四边形的 0.15 texel UV 内缩。
- **`instanced`：** 是编辑器的「纯色图层」。材质按对象的 `instance` 键实例化，覆盖 `textures`、`combos` 等。合成 RT 按纹理图像尺寸分配，`util/white` 只有 32×32，带 effect 时整条链在 32×32 上跑。这条和直觉差得远，先测。
- **`autosize`：** 纹理就绪时覆盖对象 `size`，不是「`size` 缺失时才生效」，三者都缺时是 1×1。这一条会改现有场景的尺寸来源，要过基线。
- **图像层 `perspective: true`：** 和透视粒子是同一个函数（`FUN_1401e5b60`）。每次绘制临时换成 `perspectiveoverridefov` 的透视投影，`z = 0` 平面和正交画面重合，带 3D 旋转的四边形就有了透视。渲染器已有这套矩阵（`particleViewProjection`），注意要先乘视差平移再换投影。
- **组合层上屏：** 不透明度、颜色基本不生效；fullscreen 走拷贝路径时，effect pass 会拿到上一层残留的颜色（推断）。

**实现：**
- 组合层的子树归属、局部正交、`copybackground` 两种基础 pass、alpha MAX 混合，接在 P2a 的渲染图上；先做「有 effect、无子层」。
- `fullscreen` 的拷贝路径和 NDC 上屏；`projectlayer`；`nopadding` 的 UV 条件；`instanced` 的实例材质（只做 `textures`、`combos` 覆盖，`usertextures` 照报）。
- `autosize` 按 WPE 的优先级取尺寸。
- 图像层 `perspective` 复用透视粒子的矩阵。

**验收：**
- `1923929928` 解锁；每个标志一个确定性工程，和 WPE 逐像素比。
- 组合层带子层、`copybackground` 两种取值各一个工程。
- `instanced` 带 effect 的 32×32 合成 RT 实测确认。
- 不用这些标志的场景，基线逐张相同。

## P5c — 静态网格

**步骤 0：**
- **mdl：** 所有版本走同一个加载函数，各段按版本号门槛读：网格标志 v ≥ 4、网格自带顶点格式 v ≥ 15、包围盒 v ≥ 17、两个可选块 v ≥ 21、记录表 v ≥ 23、尾部段 v ≥ 13。语料 139 个 mdl 按这套规则全部恰好读到文件末尾。
- **顶点：** 格式是 26 位掩码，按固定表序交错存放，stride 是置位属性大小之和。除 `a_BlendIndices`（u32×4）外都是 float。网格标志 bit0 决定索引是 u32 还是 u16，图元是三角形列表。
- **材质与皮肤：** 文件头第 2 个 u32 是皮肤数 N，每个网格存 N 个材质路径，对象键 `skin` 选第 `min(skin, N − 1)` 个。静态网格不追加任何引擎 COMBO。
- **模型对象：** 不读 `color`、`alpha`、`brightness`，`g_Color4` 强制 (1, 1, 1, 1)。世界矩阵和图像层同一个函数。`g_NormalModelMatrix` 是 3×3 各轴分别归一化，不是逆转置。
- **绘制：** 一个模型对象展开成多次绘制，不透明网格排在前面。WPE 用的是不稳定排序，同类网格的顺序要实测。
- **着色器声明了网格没有的属性：** WPE 怎么处理没读到，先报 `mdl:missing-attribute:<名>`。
- **单位：** 正交场景里 retro 的网格是全屏背景，着色器不乘矩阵，尺寸无关紧要。正交场景里真正带尺寸的模型（3354366708）用什么单位，要核对。

**实现：**
- mdl 解析放进编译 Worker，顶点、索引、网格表进 bundle。带骨骼、动画、变形段的报 `mdl:skeleton` / `mdl:animation` / `mdl:morph`。
- 模型对象成为第三种图层，和图像层、粒子按 `objects` 顺序画；顶点属性按着色器实际声明的 `a_*` 名字分配 location。
- 材质走图像层同一条编译路径；补 `g_NormalModelMatrix` 等模型 uniform。
- 能力表：`object:model` 拆成上面的细分键；`skin` 支持；`reflected`、`castshadow` 只在场景里有反射或阴影的消费者时才报（P7 / P8）。
- 视锥剔除不影响画面，先不做。

**验收：**
- retro 解锁，和 WPE 画面逐像素比。
- 确定性网格工程和 WPE 逐像素比：顶点格式各位、u16 / u32 索引、多网格多材质、`skin`。
- 测试用的 mdl 用自己写的编码器生成（照 rea-p5-mesh 1.2–1.4 的布局），能精确控制顶点和绕序，也顺带验证对格式的理解。

## P5d — 透视相机、相机对象与深度

**步骤 0：**
- **深度：** 后备缓冲带 D32F 深度，每帧清 0，比较函数 GREATER，正交与透视都是反向 Z。`clearenabled: false` 时颜色和深度都不清。合成 RT、effect fbo 不挂深度。
- **深度状态：**
  - `depthtest: disabled` 时不测也不写；
  - 其余时候用 GREATER 测，只有 blending 是 normal 或 alphatocoverage 且 `depthwrite` 不是 disabled 才写；
  - 缺键为「开」。
- **剔除：** `cullmode: normal` 剔背面，正面是逆时针（WebGPU `ccw` + `back`）；`alignmentfliph` 时整帧剔正面。
- **透视投影：** DirectXMath 的 `PerspectiveFovRH`，fov 是竖直方向、单位度，缺省 50、`nearz` 0.1、`farz` 10000，宽高比取窗口客户区。crop、`alignment`、`zoom` 在透视分支里都不读。
- **透视场景的尺寸：** 没有 `orthogonalprojection` 时场景宽高一直是 0，`g_EyePosition` 就是相机的 eye。普通 2D 图层和 3D 物体共用同一个 VP，按世界单位画。
- **相机路径：**
  - 文件格式 `{paths: [{duration, transforms: [{eye, center, up, zoom?, timestamp?}]}]}`，缺 `up` 时是 (0, 0, 0)，缺 `zoom` 时是 1；
  - 段内用 Hermite 插值，两端切线都取 `(p1 − p0)/2`，不乘段长；
  - 路径之间硬切，按顺序循环，时间每帧加 dt。
- **相机对象：**
  - 每帧倒序找最后一个自身和父链都可见的相机对象；
  - eye 取世界矩阵的平移，看向本地 −Z，up 取本地 +Y；`zoom` 取对象的，`fov` 只在透视场景生效；
  - 优先级：相机对象 > 路径 > 基准字段。
- **正交场景的相机对象（最先测）：** 读码是视图平移 −eye。语料 11 张同一模板的场景把相机原点设成 `(0.5·canvasSize, 500)`，照读码画面会偏半屏，和作者意图矛盾。实测之前，带可见相机对象的正交场景继续报 `object:camera`。
- **相机 uniform：** VP、MVP、MVP 逆、`g_EyePosition`、`g_ViewForward` / `Right` / `Up`（取 V 的列）。
- **透视场景里的粒子：** P4 的粒子默认场景是正交的；透视粒子在透视场景里，透视覆盖用到的场景宽高是 0（rea-p5-camera 2）。neon_sunset 有一个粒子系统，要核对。
- **透视排序：** 只在透视场景开 `transparentsorting` 时，半透明对象才按深度排序，`fullscreen` / `projectlayer` 排最后（语料 0 张开启）。

**实现：**
- 场景目标加 `depth32float` 附件：清屏跟 `clearenabled`；管线按「目标有无深度」各建一份。缺键改成「开」，深度状态按上面的规则推。翻译器定义 `REVERSEDEPTH`，并更正 hdr-macro-REPORT 的那条建议。
- 场景相机每帧求值：相机对象 > 路径 > 基准，加抖动，算 V 和 P（透视 / 正交）、`g_EyePosition`、视图向量。
- 透视场景按画布尺寸渲染，壁纸样式不起作用（已定 6）。
- 能力表：放开 `camera:perspective`、`cull:*`、`depthtest:*`、`depthwrite:*`；新增 `camera:path`（相机对象的条目动画）、`general:transparentsorting`；正交可见相机对象按步骤 0 的结论处理。

**验收：**
- dna_fragment、techno、neon_sunset 解锁，和 WPE 同一时刻的画面逐像素比。路径用固定时刻。
- 确定性工程：深度（共面、前后遮挡、translucent 不写深度、缺键缺省）、剔除（含镜像）、透视投影、路径插值与循环、相机对象（正交与透视各一）。
- 不用深度的场景，基线逐张相同。

## 和 P4 的交界

- **深度附件：** P4f 也计划给粒子新建深度附件。网格先用到，由 P5d 建，P4f 复用，只剩粒子自己的深度状态与剔除（已定 5）。
- **共享文件：** 两边都改 `compile/features.ts`、`compile/bundle.ts`、`render/scene.ts`、`render/uniforms.ts`。调研和计划可以并行；实施时同一时刻只让一边改这几个文件，每个实现步骤动工前看一次 P4 的工作区。
- **粒子在透视场景里：** 见 P5d 步骤 0。粒子在视差下的位移（绘制时乘 V，模拟时不乘）也要和 P4 的指针跟随一起核对：rea-p5-camera 6.3 推断，跟随指针的控制点不含视差。

## 决定

**已定：**
1. 调研与总计划和 P4d–P4f 并行，不改产品代码（2026-11-09 用户）。
2. 范围覆盖全部用法，目标解锁 18 张（2026-11-10 用户，按推荐）。
3. 顺序：前置 → P5a → P5b → P5c → P5d（2026-11-10 用户，按推荐）。
4. dna_fragment、techno 从 P7 提前到 P5d，相机对象从 W3 提前到 P5d；PLAN.md 的 P5、P7、W3 已同步（2026-11-10 用户，按推荐）。
5. 深度附件由 P5d 建，P4f 复用（2026-11-10 用户，按推荐）。
6. 透视场景按画布尺寸渲染，壁纸样式不起作用，导入时没有分辨率的行按主屏比例显示预览；细节在 P5d 子计划里落实（2026-11-10 用户，按推荐）。
7. P5a 现在开始，先做步骤 0（2026-11-10 用户）。前置的实现并进 P5a 子计划的第一个实现步骤，见 [phase-5a-parallax.md](phase-5a-parallax.md)。

**待定：** 无。实施时和 P4 共用文件的协调见「和 P4 的交界」，每个实现步骤动工前看一次 P4 的工作区。

## 风险

1. **覆盖数是上限：** 组合层的子层、`instanced` 的实例材质只读到代码；网格探针是把 mdl 换成图像层，顶点属性和网格本身的问题看不到，进编译后可能暴露新键。
2. **视差的静止偏移与直觉不符：** 若实测推翻，P5a 的公式要重查。
3. **正交相机对象：** 读码和样本意图冲突，没测清之前这 14 张里带可见相机的继续退回。
4. **测试网格要自己编码：** 编码器写错会和读码一起错。用语料里的真实 mdl 解析结果对照，再用 WPE 抓帧核对。
5. **改动现有路径：**
   - 深度附件和「缺键为开」改了所有管线的状态，现有 22 张都要过基线；
   - beach、deep_space、eagleflag 的 6 个材质 pass 缺 `cullmode`，改缺省后会剔背面。这三张从 P1 起就能渲染，要先确认我们图像四边形的绕序和 WPE 一致，否则整层被剔掉；
   - `autosize` 的优先级同样改现有场景的尺寸来源。
6. **透视场景的尺寸：** 导入时没有分辨率（Rust 只取 `orthogonalprojection`），预览比例、壁纸样式、`engine.canvasSize` 都要另定规则。
7. **和 P4 抢文件：** 见上节。
