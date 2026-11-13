# P5d — 透视相机、相机对象与深度（子计划）

> 上级：[phase-5-camera-mesh.md](phase-5-camera-mesh.md)「P5d」与「已定」5、6、8。读码见 [rea-p5-camera](rea-p5-camera.md) 1–4、8 节（透视、路径、相机对象、uniform）与 [rea-p5-mesh](rea-p5-mesh.md) 3、4 节（深度、剔除、排序），都没有实测；P5a、P5c 已实测过的几条在 [p5-REPORT](p5-REPORT.md)。
> 语料是 2026-11-13 在 HEAD `35b96c9d` 上的扫描（`ignore/p5/d0/corpus-head.json`，173 个场景，能渲染 52 张），P5d 的键逐张归类在 `ignore/p5/d0/out/p5d_keys.txt`（`p5d_keys.py`），非模型 pass 的深度与剔除用法在 `out/scan_depth.txt`（`scan_depth.py`）。
> 现状锚点取自 `35b96c9d`。P4f、P6b、P7、P8、P9、P10 在别的会话进行，也改 `compile/features.ts`、`compile/bundle.ts`、`render/scene.ts`、`render/programs.ts`；每个实现步骤动工前再核对一次共享文件，并行期在 HEAD 快照里实现再三方合并。
> 分步：步骤 0 只调研；步骤 1 起每步能单独验收、单独提交，各步的现状锚点、点和验收在步骤 0 之后补全（同 P5a–P5c 的做法）。

## 总体设计思路

P5d 改的是整场的投影与深度，几乎所有 3D 样本都要它。它分三块，彼此依赖的方向是单向的：深度与剔除是底座，透视相机在它上面，相机对象再在相机上面。

**深度与剔除。** WPE 每帧给场景目标清一张 D32F 深度，比较用 GREATER（反向 Z），正交与透视同一套。材质缺键时 `depthtest`、`depthwrite` 是 enabled、`cullmode` 是 normal，半透明（translucent / additive）只测不写，`depthtest: disabled` 不测也不写。P5c 已经让模型 pass 按这套缺省推，但因为没有深度附件，会写深度的照报。P5d 给场景目标加 `depth32float` 附件，把这套规则推广到所有画进场景目标的 pass：图像层的直接上屏与末 pass、粒子、文本、模型。合成 RT、effect fbo、泛光不挂深度，所以同一个材质要按「目标有没有深度」各建一份管线。剔除同理：缺键剔背面、正面是逆时针，图像层、粒子的缺省也改成 normal（已定 8 把粒子的深度与剔除移进来）。语料里正交场景的非模型 pass 多是「剔背面的半透明图像层」与「只测不写」，没有镜像的图层、也没有人写深度，所以这一块对现有画面应当中性，要用基线证明。

**透视相机。** 没有 `orthogonalprojection` 的场景用 `PerspectiveFovRH`（竖直 fov、度，反向深度），宽高比取窗口；普通图像层、粒子、模型共用同一个 VP，按世界单位画。相机每帧求值，来源三选一：相机对象 > 路径 > 基准字段，再加抖动（透视下是三维、`0.1·amplitude` 个世界单位）。透视场景没有「场景分辨率」，按画布尺寸渲染，壁纸样式不起作用（已定 6）。这一块解锁 dna_fragment、techno、neon_sunset：三张都是静态相机（dna_fragment 与 neon_sunset 的路径只有一个姿态，techno 没有路径），所以路径的插值与循环靠确定性工程验收，不靠样本。

**相机对象。** 对象带字符串型 `camera` 键就是相机，每帧倒序找最后一个自身与父链都可见的，用它的世界矩阵定 eye、朝向（本地 −Z）、up（本地 +Y），透视场景另取它的 `fov`。正交场景里读码说视图平移 −eye，但语料里 11 张同一模板的正交场景把相机原点放在画布中心，照读码会偏半屏，和作者意图矛盾，所以步骤 0 最先测它。语料里 18 张带相机对象，都还差别的能力，这一块不直接解锁，只去掉这一组键。

**关键决策：**
- **能实测的不读码。** 三份读码已经给出投影、路径、相机对象、深度与剔除的全部规则，步骤 0 用确定性工程在 WPE 里逐条核对；读码标了冲突与未知的（正交相机对象、`clearenabled: false` 时的深度、透视场景里的粒子和合成链）靠抓帧回答，答不了再派 REA 代理。
- **能力表照旧是唯一事实来源。** `camera:perspective`、`cull:*`、`depthtest:*`、`depthwrite:*`、`object:camera` 等拆开后，没实现的细分照报、整张退回。
- **透明排序与透视场景里的文本先照报。** `transparentsorting` 只出现在 3 张场景（每张还差 14 项以上），透视场景里的文本对象也都在这几张里；步骤 0 不测，照报。

## 范围与解锁

语料（`p5d_keys.txt`，173 个场景）：报 P5d 键的 37 张，只去掉 P5d 的键能渲染的 3 张。

| 键 | 张数 | 说明 |
|---|---|---|
| `object:camera`（连同 `object:fov` / `path` / `queuemode` / `zoom`） | 18 | 相机对象；都还差别的能力（木偶、文本脚本、音频频谱、光标回调等 4–37 项） |
| `cull:normal` | 12 | 非模型 pass：正交图像层 27 处、正交粒子 7 处、透视粒子 1 处（`scan_depth.txt`），都没有镜像 |
| `camera:perspective` | 11 | 透视场景 |
| `depthwrite:enabled` | 10 | 会写深度的 pass（多是模型） |
| `depthtest:enabled` | 6 | 非模型 pass 的深度测试 |
| `general:camerashake` | 3 | 透视场景开抖动（ricepod、3453730450、3706286085） |
| `general:transparentsorting` | 3 | 照报 |
| `material:depthtesting` / `depthwriting` | 1 | ricepod 拼错的键（WPE 不认，等于缺键），步骤 0 顺带确认 |

**解锁：** dna_fragment（透视 + 深度）、techno（透视）、neon_sunset（透视，另有 `fullscreen` 层、sprite 粒子）。只差一项的还有 fantasticcar（`_rt_Reflection`，P8）、ricepod（`object:sprite`）。

**P5d 不做，继续报不支持：**
- `transparentsorting` / `customsortorder`；透视场景里的文本对象（`text:perspective`，新键）；透视场景里的图像层 `perspective: true`（语料 0 个）；相机对象的条目动画（`path` 文件非空时报 `camera:path`，语料 22 个相机都是空表）。
- 反射 pass、阴影 pass（`reflected`、`castshadow` 的消费者）：P7 / P8。骨骼、动画、变形：W6。

## 现状锚点

**a. 透视场景整张退回，透视下的抖动另报**（`compile/features.ts:395`、`:399`）
```ts
  if (!g.orthogonalprojection) unsupported.add("camera:perspective"); // 现状：透视场景一律退回
  if (!g.orthogonalprojection && active(g.camerashake)) unsupported.add("general:camerashake"); // 现状：透视抖动没做
```

**b. 非模型 pass 的深度与剔除照报**（`compile/features.ts` 的 `checkPassFeatures`）
```ts
  } else {
    if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);       // 现状：只认 nocull
    if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`); // 现状：只认 disabled
    if (pass.depthwrite && pass.depthwrite !== "disabled" && writesDepth(pass))
      unsupported.add(`depthwrite:${pass.depthwrite}`);
  }
```
模型 pass（`context.model`，P5c）只对会写深度的报 `depthwrite:*`。

**c. 缺键只有模型按 WPE 推**（`compile/bundle.ts:1337`）
```ts
      cullmode: pass.cullmode ?? (context.model ? "normal" : "nocull"),       // 现状：非模型缺键当 nocull
      depthtest: pass.depthtest ?? (context.model ? "enabled" : "disabled"),  // 现状：非模型缺键当 disabled
      depthwrite: pass.depthwrite ?? (context.model ? "enabled" : "disabled"),
```

**d. 场景目标没有深度，管线不带深度状态**（`render/scene.ts` 的 `createSceneTarget`、`render/programs.ts:324`）
```ts
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | extraUsage,
      primitive: cull ? { topology, cullMode: cull, frontFace: "ccw" } : { topology, cullMode: "none" }, // 现状：没有 depthStencil
```

**e. 视图投影只有正交**（`render/layout.ts:224`）
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">, zoom = 1): Mat4 {
  const projection = orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH); // 现状：没有透视分支，也不读 camera
```
`eyePosition` 同样只有正交公式 `(W/2, H/2, 2000)`。

**f. 透视场景的尺寸是占位**（`compile/bundle.ts:846`）
```ts
      width: projection.width ?? 1920,   // 现状：没有 orthogonalprojection 时按 1920×1080
      height: projection.height ?? 1080,
```

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

见上「范围与解锁」。`scan_depth.py` 另查了非模型 pass：正交图像层 `cullmode: normal` 27 处（26 处 translucent）、`depthtest: enabled` 11 处（都 translucent，只测不写）；正交粒子 `cullmode: normal` 7 处、缺 `depthtest` 4 处（additive）；透视图像层 `depthtest: enabled` 94 处（4 处 normal 且写深度）；文本对象的 `depthtest` 正交 485 个、透视 64 个（P6b 已定正交恒用无深度材质）。图层的 `scale` 都没有镜像，父链没查。

### 0b — 确定性工程与实测（Claude）

工具同 P5c：
- 工程由 `ignore/p5/d0/gen_d.py` 生成（复用 `../c0/gen_c.py` 的 mdl 编码与着色器，`../a0/gen_a.py` 的骨架），放在 `ignore/p5/proj/p5d-*`。透视工程里 FR、CLK 两层改用裁剪空间的着色器，画在和正交工程相同的像素位置，`kbp cmp frame --kbp-layers` 照常遮掉；
- `wpe-renderdoc` MCP 的 `capture_sweep` 抓帧，放在 `A:\p5d\<用途>\`，窗口 1920×1080（宽高比另加 1280×1024）；
- 读数用 `ignore/p5/c0/rdc_dump_c.py` 的导出（输入布局、顶点 / 索引、深度与光栅状态、混合、常量），整帧比用 `kbp rdc frame`。

不移动用户的鼠标；开视差的工程只看「透视下视差不改画面」，与指针位置无关。

| 工程 | 构造 | 核对 |
|---|---|---|
| `p5d-camo-*`（正交相机对象，最先测） | 正交 1920×1080；一组按场景坐标摆的色块（四角、中心、(200, 100)）加一个探针模型（读 `g_EyePosition`、`g_ViewProjectionMatrix`、`g_ViewForward` / `Right` / `Up`）；相机对象 5 份：origin (0, 0, 0)、(960, 540, 500)、(200, 100, 0)、模板脚本（`0.5·engine.canvasSize`，另把 `canvasSize` 写进日志）、(0, 0, 0) 加 `angles "0 0 0.3"` 与 `zoom 2` | 画面平移多少、`g_EyePosition`、VP；读码说平移 −eye，和 11 张模板场景的意图冲突 |
| `p5d-camp-*`（透视相机对象） | 透视；两个可见相机（位置、fov 不同）；另一份把后一个设成 `visible: false` | JSON 里靠后的生效；不可见的不参与；fov 取相机的 |
| `p5d-persp`（透视投影） | 透视，相机 eye (0, 0, 10) 看原点，不写 fov / nearz / farz；mdl 方片在 z = 0 与 −5，一个普通图像层（size 256、scale 0.01）；探针读 MVP、VP、`g_EyePosition`、`g_Screen`、`g_TexelSize`、`g_ViewForward` / `Right` / `Up`、`g_ParallaxPosition`；窗口 1920×1080、1280×1024 各一份 | VP 是 `PerspectiveFovRH`（反向深度）、宽高比取窗口；图像层按世界单位、和模型同一个 VP；`g_EyePosition` 是 eye |
| `p5d-persp-b` | 同上，fov 30、nearz 1、farz 100、`zoom 2`、`cameraparallax` 开 | fov / near / far 生效；透视下 zoom 与视差都不改画面 |
| `p5d-depth`（透视深度） | 方片对：缺键；A `depthwrite: disabled`；A translucent 且 `depthwrite: enabled`；A alphatocoverage；B `depthtest: disabled`、之后再画更远的 C；共面；非法值（`depthtest: "yes"`、`cullmode: "back"`）；图像层（translucent、`depthtest: enabled`）在模型后面；normal 图像层写深度、挡住之后画的模型；粒子（additive、`depthtest: enabled`）在模型后面 | OM 状态（D32F、清 0、GREATER、写掩码）与遮挡逐条对上 rea-p5-mesh 3.4 |
| `p5d-depth-o`（正交深度） | 正交：normal 模型在 z = 100 写深度；之后在 z = 0 画图像层（translucent、`depthtest: enabled`）、带 effect 的图像层（末 pass 借基础材质的深度状态）、粒子（缺 `depthtest`） | 正交场景同样测深度；合成链只在上屏时测 |
| `p5d-noclear` | 正交、`clearenabled: false`，一个 normal、写深度的静止模型 | 不清深度时第二帧起模型被 GREATER（严格）挡掉，还是照画 |
| `p5d-cull` | 正交：`cullmode: normal` 的图像层，scale 正常、x 取 −1、挂在镜像的父层下各一；粒子 `cullmode: normal`；带 effect 的图像层 `cullmode: normal`；另一份开 `alignmentfliph` | 图像层四边形的绕序，镜像后剔不剔；`alignmentfliph` 整帧镜像、剔正面、可见性不变 |
| `p5d-path` | 透视，`camera.paths` 两条：第一条 3 个关键帧（t 0 / 2 / 4，duration 4，eye 沿 x 摆开），第二条 1 个关键帧、duration 2；fps 20，按不同等待时间各抓 3 帧 | `g_EyePosition` 随时间的曲线是 `−s³ + 1.5s² + 0.5s`；4 s 硬切、6 s 回到第一条 |
| `p5d-shakep` | 透视，`camerashake` speed 1、amplitude 1、roughness 1；另一份 roughness 0.1 | `g_EyePosition` 的三维偏移是 `0.1·amplitude·v`；roughness 0.1 的临界（P5a 在正交里已按 float32 测过） |
| `p5d-ptc` | 透视：普通粒子系统（sprite，世界单位）、透视粒子（`flags & 4`） | 普通粒子用场景 VP、sprite 面向相机；透视粒子用什么矩阵（读码：透视场景的宽高是 0） |
| `p5d-2d` | 透视：带 effect 的图像层（合成链）、fullscreen 层、fullscreenlayer 带 effect（neon_sunset 那种） | 合成链的基础 pass、effect pass、末 pass 各用哪组矩阵；fullscreen 与相机无关 |

真实样本：dna_fragment、techno、neon_sunset。`kbp content unpack --instrument` 解包加日志，WPE 1920×1080 抓帧，留作步骤 2 的对照（按日志回放比整帧）。

**验收：** 每条读码结论和每个冲突 / 未知都有工程对上，或者写明被推翻的地方和改正后的规则；结论写进 [p5-REPORT.md](p5-REPORT.md) 新的「P5d 语义的实测核对」一节；对各步的影响写进本文件的实施记录，并补全各步的现状锚点、点和验收。

### 0c — 读码补查（只在抓帧解决不了时）

候选（先不派代理）：正交相机对象若和读码不符，补读 `FUN_140183a70` 正交分支与 `canvasSize` 的来源；`clearenabled: false` 的深度若和推断不符，补读清屏路径。

### 步骤 0 实施记录（2026-11-13）

结论全在 [p5-REPORT.md](p5-REPORT.md)「P5d 语义的实测核对」：20 个确定性工程、三张目标样本与一张模板相机场景，读码的结论全部成立，0c 的读码补查不需要了。

**和计划不一致的地方：**
- **工程多了 4 个**：`p5d-imgcull` / `-imgcull-p`（第一批透视工程的 FR、CLK 没画，查出透视场景也剔图像层）、`p5d-depth2`（`p5d-depth` 有几组被透视拉开、屏幕上没重叠，补测）。`alignmentfliph` 语料 0 张，照报 `general:alignmentfliph`，没测。
- **正交相机对象最先测**，结果照读码：视图平移 −eye。11 张模板场景的「冲突」是内容本来就摆在偏移的坐标上（3462279189 的抓帧画面正常），不是读码错了。

**定下来的规则：**
- **深度**：场景目标一张 D32F，每帧清 0（`clearenabled: false` 时不清），GREATER；pass 的深度状态：`depthtest: disabled` 不测不写，否则测，只有 normal / alphatocoverage 且 `depthwrite` 不是 disabled 才写；缺键为开，非法值取 disabled。画进合成 RT、fbo 的不挂深度；带 effect 的图层只在上屏 pass 测，深度键借基础材质。正交与透视同一套。
- **剔除**：缺键与 `normal` 剔背面、正面逆时针，只看屏幕绕序；非法值取 normal。图像层、粒子、模型都一样，镜像的被剔；带 effect 的上屏 pass 用 effect 材质自己的 `cullmode`。
- **透视投影与相机**：`PerspectiveFovRH`（竖直 fov、反向深度、宽高比取画布）；`zoom` 与视差不改画面，开视差时 `g_ParallaxPosition` 是 NaN；`g_EyePosition` 是 eye（含路径、相机对象、抖动），视图向量取 V 的列；路径与抖动照读码（逐帧状态机、切换丢余量）。
- **相机对象**：倒序找最后一个可见的；正交：视图 = lookAt（平移 −eye、`angles` 转视图），`g_EyePosition` = eye + (W/2, H/2)、z 2000，对象 `zoom` 乘进正交缩放；透视：fov 取相机的。
- **透视场景里的其它对象**：普通图像层、粒子、合成链和正交场景同一套矩阵（场景 VP 换成透视的）；fullscreen 与相机无关。透视粒子（`flags & 4`）与文本对象照报。
- **只记不补**：图像层的视锥剔除（对乘 MVP 的着色器没有画面差别）；槽 0 没有纹理的 fullscreen 模型的几何（语料 0 个）。

**对各步的影响：** 分步不变（见下表）。深度与剔除不分投影，所以步骤 1 自己就能用正交场景验收（3354366708 的模型、`cull:normal` 的 12 张）；步骤 2 的样本回放里，neon_sunset 的插桩 FR 被剔，帧号按「抓帧帧号 + 1」对日志。

## 分步

| 步骤 | 内容 |
|---|---|
| 0 调研 | 已完成（上面的实施记录） |
| 1 深度与剔除 | 场景目标加 `depth32float`（清 0，跟 `clearenabled`）；管线按「目标有没有深度」各建一份；全部画进场景目标的 pass 按 WPE 推深度状态与剔除，缺键改成开，非法值取表的第一项，带 effect 的上屏 pass 深度借基础材质、剔除用 effect 材质；去掉 `cull:*`、`depthtest:*`、`depthwrite:*`（ricepod 拼错的 `material:depthtesting` / `depthwriting` 没测，照报）。不直接解锁，基线逐张不变 |
| 2 透视相机 | 透视投影与基准相机、路径、透视抖动、视图向量（`g_ViewForward` / `Right` / `Up`，正交下也补）；透视场景按画布尺寸渲染（已定 6）；透视场景里的图像层、合成链、fullscreen、粒子；新增照报键 `text:perspective`、透视场景里的透视粒子；去掉 `camera:perspective`、`general:camerashake`。解锁 dna_fragment、techno、neon_sunset |
| 3 相机对象 | 正交与透视的相机对象，去掉 `object:camera` 一组，条目动画照报 `camera:path` |
| 收尾 | 未实测清单走查、文档（`cocs/wpe/WPE_SCENE.md`、回归、changelog） |

## 步骤 1 — 深度与剔除

### 思路

深度与剔除对全部对象是同一套规则（步骤 0），正交场景同样生效，所以这一步不碰投影，只把「材质 pass 的三个键」从编译期一直接到管线与 render pass 上。

**编译期把三个键规整好。** 所有 pass（图像层基础材质、effect、passthrough、粒子、模型、文本、形状）在 `compilePass` 里按 WPE 的表规整：缺键 `depthtest` / `depthwrite` 为 enabled、`cullmode` 为 normal；写了但不是表里的串（含非字符串），`depthtest` / `depthwrite` 取 disabled、`cullmode` 取 normal。之后 `ScenePass` 上这三个字段只会是合法值，渲染器不再兜底。能力表的 `cull:*`、`depthtest:*`、`depthwrite:*` 全部去掉（P5c 给模型留的 `depthwrite:enabled` 一起去掉）。

**渲染图给每个绘制步骤定光栅状态。** 新增纯函数 `rasterState(depthPass, cullPass, blending)` → `{ test, write, cull }`：`test` = `depthPass.depthtest !== "disabled"`；`write` = `test && depthPass.depthwrite !== "disabled" && blending ∈ {normal, alphatocoverage}`；`cull` = `cullPass.cullmode !== "nocull"`。大多数步骤两个 pass 都是自己；带 effect / passthrough / 组上屏的「上屏」角色（`final` / `passthrough`），深度借图层的基础 pass（WPE 末 pass 借基础材质的 blend 与深度键，`p5d-depth-o`），剔除用上屏 pass 自己的（`p5d-cull` 的 C4：tint 是 nocull，镜像图层照样显示）；`blending` 用步骤实际的混合（已经借了基础材质，cbm 31 改 additive）。没有基础 pass 的（形状对象，P8）两个都取自己。画进合成 RT、fbo 的步骤只用 `cull`，`test` / `write` 不起作用。

**深度附件按需建。** 场景里有任何「可能画进场景目标、而且测深度」的步骤（预建的全部计划取并集：基础、可变 effect 的各上屏角色、粒子、网格、文本）才给场景目标配一张同尺寸的 `depth32float`；一个都没有的场景不建，管线、render pass 与现在逐字节相同。理由：不测深度的 pass 也不写深度（WPE 的 `depthtest: disabled` 连写入一起关），这时深度附件对画面没有任何作用；而语料里能渲染的正交场景几乎都是这样，按需建能让基线保持逐字节相同、也不白占显存（4K 一张 32 MiB）。有深度附件时，所有画进场景目标的管线都要带 `depthStencil`（格式与 render pass 一致是 WebGPU 的硬性要求）：测深度的 `depthCompare: "greater"`，不测的 `"always"`，`depthWriteEnabled` = `write`。组里的绘制落在组的合成 RT 上（WPE 的合成 RT 不挂深度），不带 `depthStencil`。

**清屏跟 `clearenabled`。** 每帧第一个场景 pass 在清颜色时一起把深度清成 0（反向 Z），之后同一帧里再开场景 pass 都是 `load`；`clearenabled: false` 时深度也不清（`p5d-noclear`：静止的写深度物体从第二帧起被自己上一帧的深度挡掉，照 WPE）。两张交替的场景目标（P3c）共用这一张深度，同 WPE 后备缓冲的深度不随交换链翻转。

**剔除推广到所有步骤。** `cull` 为真时管线 `cullMode: "back"`、`frontFace: "ccw"`（P5c 的模型那一套）。前提是我们的几何在屏幕上的绕序和 WPE 相同：图层四边形（`layerQuad`，三角形带 BL、BR、TL、TR）、粒子（`CORNER_UVS` 加 `QUAD_INDICES`）、形状（P8 已按 WPE 排）、模型（P5c）、合成 RT 与 fbo 里的全屏四边形、fullscreen 的 NDC 四边形、绳（翻译器展开 WPE 的几何着色器）。这一步对每种几何加单测：未镜像时投影后是逆时针（正面），镜像（`scale` x 取负）后是顺时针。文本的四个宿主材质都写了 `nocull`、深度 disabled，这一步对文本没有变化。

### 现状锚点

**a. 缺键只有模型按 WPE 推**（`compile/bundle.ts` 的 `compilePass`）
```ts
      cullmode: pass.cullmode ?? (context.model ? "normal" : "nocull"),       // 现状：非模型缺键当 nocull
      depthtest: pass.depthtest ?? (context.model ? "enabled" : "disabled"),  // 现状：非模型缺键当 disabled
      depthwrite: pass.depthwrite ?? (context.model ? "enabled" : "disabled"),
```

**b. 能力表照报深度与剔除**（`compile/features.ts` 的 `checkPassFeatures`、`writesDepth`）
```ts
  if (context.model) {
    if (pass.cullmode && pass.cullmode !== "normal" && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);
    if (pass.depthtest && pass.depthtest !== "enabled" && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`);
    if (pass.depthwrite !== "disabled" && writesDepth(pass)) unsupported.add(`depthwrite:${pass.depthwrite || "enabled"}`); // 现状：会写深度的模型照报
  } else {
    if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);          // 现状：只认 nocull
    if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`); // 现状：只认 disabled
    if (pass.depthwrite && pass.depthwrite !== "disabled" && writesDepth(pass)) unsupported.add(`depthwrite:${pass.depthwrite}`);
  }
```

**c. 管线规格只有模型的剔除，没有深度**（`render/scene.ts` 的 `PipelineSpec`、`pipelineKey`、`stepPipeline`）
```ts
  /** 剔背面（P5c 步骤 2：模型 pass 的 `cullmode` 为 normal，`p5c-cull`）；不剔时不写，管线键不变。 */
  cull?: "back";
  return `${program}|${blending}|${format}|${alpha}…${cull ? `|cull:${cull}` : ""}`;
    ...(step.kind === "mesh" && pass.cullmode === "normal" ? { cull: "back" as const } : {}), // 现状：只有网格步骤剔
```

**d. 管线不带深度状态**（`render/programs.ts` 的 `createPipeline`）
```ts
      primitive: cull ? { topology, cullMode: cull, frontFace: "ccw" } : { topology, cullMode: "none" }, // 现状：没有 depthStencil
```

**e. 场景 pass 只有颜色附件**（`render/scene.ts` 的 `encode` 里的 `begin`）
```ts
      const pass = encoder.beginRenderPass({
        label: scene ? "scene" : "group",
        colorAttachments: [ /* 现状：第一个场景 pass 清颜色（clearenabled），没有 depthStencilAttachment */ ],
      });
```

### 点 1 — 编译（`compile/bundle.ts`、`compile/features.ts`）
- **修改** `compilePass`：三个键按 WPE 的表规整（新增导出的 `normalizeDepthKeys(pass)`，`features.ts`），所有 pass 一套，删掉 `context.model` 的分支。
```ts
/** 材质 pass 的深度 / 剔除键照 WPE 规整（rea-p5-mesh 3.3，p5-REPORT「P5d」）：缺键为开；写了但不是表里的串取表的第一项 */
export function normalizeDepthKeys(pass: MaterialPass): { cullmode: "normal" | "nocull"; depthtest: "enabled" | "disabled"; depthwrite: "enabled" | "disabled" } {
  const pick = (value: unknown, on: string, off: string, fallback: string) =>
    value === undefined ? on : value === on || value === off ? value : fallback;
  return {
    cullmode: pick(pass.cullmode, "normal", "nocull", "normal"),
    depthtest: pick(pass.depthtest, "enabled", "disabled", "disabled"),
    depthwrite: pick(pass.depthwrite, "enabled", "disabled", "disabled"),
  } as …;
}
```
- **删除** `checkPassFeatures` 里的 `cull:*`、`depthtest:*`、`depthwrite:*` 与 `writesDepth`；`context.model` 参数如果只剩这一个用途就一起删掉（调用处同步）。注释改成依据实测。

### 点 2 — 渲染图（`render/graph.ts`）
- **新增** `RasterState { test: boolean; write: boolean; cull: boolean }` 与纯函数 `rasterState(depthPass, cullPass, blending)`（规则见「思路」）。
- **修改** 会画东西的步骤（`DrawStep`、`ParticleStep`、`MeshStep`、`TextStep`）加 `raster: RasterState`，在构造处填好：上屏角色（`final` / `passthrough`，含组的无 effect 上屏）深度取图层基础 pass、剔除取自己；形状对象两个都取自己；其余都取自己。

### 点 3 — 管线（`render/programs.ts`、`render/scene.ts`）
- **修改** `PipelineSpec`：`cull?: "back"` 不再限于网格；**新增** `depth?: { test: boolean; write: boolean }`，只在「这一步画进场景目标、不在组里、而且场景有深度附件」时出现。`pipelineKey` 只在出现时加后缀（`|depth:<t|-><w|->`），没有深度附件的场景键逐字不变。
- **修改** `stepPipeline` 按 `step.raster` 填 `cull` 与 `depth`；`createPipeline` 收 `depth`，有时加 `depthStencil: { format: "depth32float", depthCompare: test ? "greater" : "always", depthWriteEnabled: write }`。

### 点 4 — 深度附件与编码（`render/scene.ts`）
- **新增** 场景是否需要深度（按预建的全部计划，有一个画进场景目标、不在组里且 `raster.test` 的步骤就要）；需要时建一张场景目标尺寸的 `depth32float`（`RENDER_ATTACHMENT`），尺寸变化时随场景目标重建，计进显存统计。
- **修改** `encode` 的 `begin`：场景 pass 带 `depthStencilAttachment`（`depthClearValue: 0`，第一个场景 pass 在清颜色时 `depthLoadOp: "clear"`，其余与 `clearenabled: false` 时 `"load"`，`depthStoreOp: "store"`）；组的 pass 不带。只清屏的分支（全部图层不可见）同样清深度。

### 点 5 — 单测
- `compile/`：`normalizeDepthKeys` 的缺键、合法值、非法值（`"yes"`、`"back"`、数字、null）；能力表不再报这三类键；模型照常（P5c 的用例改期望）。
- `render/graph`：`rasterState` 的规则表（`p5d-depth` 的 12 组状态逐个对上），上屏角色借基础 pass 的深度、剔除用自己（`p5d-cull` C4 / C5、`p5d-depth-o` 的 L2）。
- 绕序：`layerQuad`、粒子四角、形状、全屏 / NDC 四边形、合成 RT 里的四边形在各自的矩阵下投影后逆时针；`scale` x 取负后顺时针。
- `render/scene`（假设备）：没有测深度步骤的场景不建深度、管线键与改前逐字相同；有的场景 render pass 带深度附件、清屏跟 `clearenabled`；组的 pass 不带；管线的 `depthStencil` 对上。

### 实施方式

子代理在 HEAD 快照（`ignore/p5/d1/head`，`3c4f723b`）里实现，我独立验收后三方合并（P6b、P8、P10 的会话在并行改 `render/scene.ts`、`compile/features.ts`、`compile/bundle.ts`）。

### 验收

子代理：快照 tsc 0 错误；vitest 除已知的 `3830255100: 219 次请求` 外全过；Prettier。

Claude 独立验收：
1. 越界检查、自跑 tsc / vitest；变异：缺键改回不测 / 不剔、非法值取错、上屏角色的深度不借基础 pass、上屏的剔除取基础 pass、半透明也写深度、深度附件不清 / `clearenabled: false` 也清、按需建改成从不建、组里也带深度、管线键不带深度后缀。
2. 语料：只去掉 `cull:*`、`depthtest:*`、`depthwrite:*`，原来能渲染的场景不掉出；列出新能渲染的（预计没有）。
3. 画面哈希：10 张基线场景 × 三档不变；另外扫一遍能渲染的场景里「剔背面的 pass 画在镜像的图层上」与「需要深度附件」的，逐个渲染核对（这是本步唯一会改画面的地方，改了要和 WPE 一致）。
4. 确定性工程（正交，透视要等步骤 2）和 WPE 整帧逐像素比：`p5d-depth-o`、`p5d-cull`、`p5c-depth`（P5c 步骤 0 抓过、当时归 P5d 没比），`p5d-noclear` 看第二帧起写深度的模型不再更新。
5. 三方合并进工作区，合并后再跑 tsc、vitest。

### 步骤 1 实施记录（2026-11-13）

子代理在 HEAD 快照（`3c4f723b`，`ignore/p5/d1/head`）里实现，我独立验收后合到 `ef16dcf1`（中间 P10a 步骤 1、P11 文档、P9b 步骤 0–1、P4f 步骤 0–1 进来，改过 `compile/features.ts`、`render/scene.ts`，三方合并没有冲突），合并树是 `ignore/p5/d1/head2`。

**和计划不一致或计划没写到的：**
- **`ScenePass` 的三个字段仍是 `string`**：没收窄成联合类型，免得并行会话里手写 `ScenePass` 的代码合并时编不过；`normalizeDepthKeys` 的返回值是窄类型，字段注释写明了不变量。
- **`PassContext.model` 删掉了**：P5c 加它只为定缺省值与传给 `checkPassFeatures`，规整统一之后没有用处；`checkPassFeatures` 的 `context` 参数一起删。
- **泛光材质也走 `normalizeDepthKeys`**：WPE 的泛光材质都写了 nocull / disabled，值不变；泛光链自己开 pass，这三个值不进管线。
- **null 混合按 normal 算**：只有画进合成 RT 的 `base` / `compose` 是 null，深度两项对它们本来不起作用。
- **管线标签**照 ` mesh` / ` cull` 的惯例多一个 ` depth:<t|-><w|->`；`depthFlags` 与 `SCENE_DEPTH_FORMAT` 放在 `programs.ts`，避免循环引用。
- **深度附件不需要另写 resize**：场景目标的尺寸在 `populate` 定死，改尺寸整场重建；两张交替的场景目标同尺寸，共用这一张深度。
- **ricepod 拼错的 `depthtesting` / `depthwriting`** 不在已知键里，照报 `material:*`（没测）。

**验收：**
- 越界：快照对 HEAD 的差异只在计划内的文件（另加 `compile/bloom.ts`）。
- 绕序（子代理单测）：图层四边形、合成 RT 里的基础 pass、全屏 / NDC 四边形、组的局部正交、形状、粒子四角，未镜像都是逆时针、镜像后顺时针，和 WPE 一致，`frontFace` 不用动。文本的四个宿主材质都是 nocull、深度 disabled，网格 P5c 已对过，绳是翻译器原样展开 WPE 的几何着色器。
- 快照与合并树：tsc 0 错误；vitest 合并树 2607 通过，只有已知的 `3830255100: 219 次请求`；Prettier 通过。合并后的工作区 tsc 0 错误，相关的 8 个测试文件 268 条全过。
- 变异（`ignore/p5/d1/mutate_d1.py`，快照模式）16 处全部检出、还原后整树哈希一致：缺 `cullmode` 当 nocull、非法 `depthtest` 取 enabled、缺 `depthwrite` 当 disabled、又报 `cull:*`、末 pass 深度不借基础、末 pass 剔除取基础、passthrough 剔除取基础、组上屏深度不借基础、半透明也写深度、剔除只给网格、组里也带深度、管线键不带深度、按需建不看变体、从不建深度、深度每次都清、比较改成 greater-equal（子代理另有 13 处，也全部检出）。
- 语料（同一份 wasm，`ef16dcf1` 上前后各扫一次）：只去掉 `cull:normal` 12 张、`depthwrite:enabled` 10、`depthtest:enabled` 6，没有新增的键；能渲染 57 → 57，没有场景掉出。dna_fragment 只剩 `camera:perspective`。
- 画面影响扫描（`ignore/p5/d1/scan_step1.py`）：能渲染的 57 张里没有「镜像且剔背面」的图层；会建深度附件的只有 retro（模型缺键测深度）与 shimmering_particles（4 个 additive 粒子缺 `depthtest`），都没有写深度的 pass。
- 画面哈希（宿主分别从 `ef16dcf1` 与合并树干净构建，`ignore/p5/d1/app`）：10 张基线场景 × 三档全部相同；retro、shimmering_particles × 三档相同，`targetBytes` 正好多一张深度。
- **真机对 WPE**（dev 应用渲染、按 WPE 日志回放、`kbp cmp frame --kbp-layers`）：`p5d-depth-o`、`p5d-cull`、`p5c-depth` 整帧逐像素相同（差 0）。`p5d-noclear` 没比：WPE 不清屏的后备缓冲在 RenderDoc 回放里是未定义的内容，「不清深度、第二帧起不再画」由单测锁住。
- `p5d-depth-o` 的抓帧日志里混进了别的会话窗口的行（另一个进程号），回放前按本窗口的进程号过滤（`ignore/p5/d1/out/p5d-depth-o-log.txt`）。
