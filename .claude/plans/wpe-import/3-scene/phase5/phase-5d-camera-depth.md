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
| 2 透视相机 | 透视投影与基准相机、路径、透视抖动、视图向量（`g_ViewForward` / `Right` / `Up`，正交下也补）；透视场景按画布尺寸渲染（已定 6）；透视场景里的图像层、合成链、fullscreen、粒子；没测过的用法照报 `camera:perspective:<用法>`（文本、透视粒子等，见步骤 2 点 7）；去掉 `camera:perspective`、`general:camerashake`。解锁 dna_fragment、techno、neon_sunset |
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

## 步骤 2 — 透视相机

### 思路

这一步把「透视场景整张退回」拆开：透视投影、基准相机、路径、三维抖动做出来，透视场景改按画布尺寸渲染；透视场景里没测过的用法换成细分键照报。正交场景的相机一行不改，基线逐字节不变。

**投影类型一处判定，透视场景没有场景尺寸。** 现在有两套判定：能力表看 `general.orthogonalprojection` 真不真，粒子缺省值看 `isOrthographic`（rea-p4a「基础」【确】：是对象，且 `auto: true` 或宽高都非 0）。统一成后者，结果放进 `SceneGeneral.perspective`，能力表、`SCENE_ORTHO` 宏、粒子缺省值、渲染器都读它。透视场景的 `SceneGeneral.width/height` 改成 WPE 的值 0（rea-p5-camera 2.1【确】：W、H 只由 `orthogonalprojection` 写），不再占位 1920×1080。编译期用到场景尺寸的有三处：fullscreenlayer 的合成 RT（槽 0 是 `_rt_FullFrameBuffer`）改成渲染时取场景目标尺寸；`projectlayer` 的 `autosize` 与形状对象的缺省尺寸在透视场景里没测过、语料 0 个，照报。脚本的 `engine.canvasSize` 照读码在透视场景读到 (0, 0)（没测，语料 0 处）。

**相机每帧求值，三个来源只做两个。** 编译期解析 `scene.json` 顶层的 `camera`：基准 `eye` / `center` / `up`（字符串按空格 `atof` 三次、缺分量为 0；不是字符串时保留构造值 (2, 2, 2) / (0, 0, 0) / (0, 1, 0)，p3-script-REPORT L2）和 `paths` 指向的文件（格式与容错照 rea-p5-camera 3.1：不是对象或 `transforms` 空就 `break`，`disabled` 跳过，缺 `timestamp` 按 i/(n−1)·duration 铺开，缺向量为 0、缺 `zoom` 为 1）。新模块 `render/camera.ts` 是纯函数：路径状态三元组（路径、关键帧、本路径内时间）的求值与推进照 3.2（段内 `p0 + (p1 − p0)·(−s³ + 1.5s² + 0.5s)`，先求值后 `t += dt`，切换时 t 归零、余量丢掉，按顺序循环），三维抖动（`0.1·amplitude` 个世界单位，长度指数作用在三维长度上），`lookAtRH`，反向深度的 `perspectiveRH`（m22 = n/(f − n)、m32 = n·f/(f − n)），视图向量取 V 的列。来源优先级是「相机对象 > 路径 > 基准」，相机对象归步骤 3，这一步透视场景有可见相机对象时仍整张退回（`object:camera` 照报），所以只实现后两个。fov 取 `general.fov` 钳到 [0.1, 179.9]，`nearz` / `farz` 每帧读，三者已经在 `GENERAL_FIELDS` 里、属性与脚本写入就地生效；宽高比取场景目标（就是画布）。求值时刻同 P5a 的抖动：帧开头算、粒子步进之后交给场景（WPE 先更新对象再更新相机，粒子模拟用上一帧的相机），补画帧 dt 为 0、路径不推进。路径状态归渲染器，整场重编译保留（同视差点，WPE 改属性不重建场景）。正交场景照旧是单位视图（P5a），正交场景带非空 `paths` 照报（读码说那时不重置相机、视图会平移，语料 0 张，没测）。

**透视场景按画布尺寸渲染（已定 6）。** 场景目标取渲染器的 `fullResolution`（显示缩放为 1 的画布尺寸，同 `engine.screenResolution`；预览里画布按主屏逻辑尺寸排版，所以和桌面同分辨率），超设备上限时等比缩。上屏整张铺满、壁纸样式不起作用，指针按窗口坐标原样用（同 `fill`）。`g_Screen` / `g_TexelSize` 本来就按场景目标算，透视场景里等于画布，和 WPE 取窗口一致。画布分辨率变了（桌面换分辨率、应用背景随主窗口变）时，渲染器等尺寸稳定 300 ms 后请宿主整场重新加载（走现有的 `reload`：bundle 和尺寸无关、编译结果相同，脚本写入照常重放）。这比给 `GpuScene` 写 resize 简单得多：场景目标、深度、快照、泛光、fullscreen 合成 RT 和引用它们的绑定组都跟尺寸有关。代价是粒子重新预热，WPE 只重建 RT、粒子接着跑，记为已知差异。

**透视场景的绘制只换场景级的视图投影。** 图像层、粒子、模型、合成链的末 pass、模型的视锥剔除、粒子的指针反投影都已经从 `GpuScene.viewProjection` 取，透视场景把它换成 `P·V` 就够了（步骤 0 的 `p5d-persp`、`p5d-2d`、`p5d-ptc` 实测：普通图像层 MVP = VP·W，合成链基础 pass 用合成 RT 自己的正交、末 pass 用场景 VP·W，fullscreen 与相机无关）。`g_EyePosition` 是 eye（含路径与抖动），视图向量 `g_ViewForward` / `Right` / `Up` 加进引擎 uniform，所有 pass 都写（正交下是 (0, 0, −1) / (1, 0, 0) / (0, 1, 0)）。粒子的 `g_ViewUp` / `g_ViewRight` 和朝向用的视线、上方向改成相机的：**步骤 0 的「sprite 按对象朝向、不面向相机」不成立**，`p5d-ptc` 的相机正对 −Z，两种说法读数一样；dna_fragment 的抓帧（相机是斜的）里 `g_OrientationForward` = (0.691, 0.494, 0.528) 正是 eye − center 的单位向量，和 `orientationVectors` 的 screen 分支 `F = −vf` 逐位对上，所以现有朝向代码拿到相机的视线就对。视差在透视场景里不移动对象（读码 6.1），`g_ParallaxPosition` 照 WPE 的算式：W = H = 0、P 初值 0，除出的 NaN 不钳成 0（步骤 0 推翻了【推】，开视差时读到 NaN）。

**照报的细分。** 透视场景里没测过的用法换成 `camera:perspective:<用法>`：文本对象 `text`（P6b 只测了正交）、透视粒子（`flags & 4`，读码说宽高是 0 时 fov 退化）`particle`、图像层 `perspective: true` `image`、组（带子层的组合层）`group`、`projectlayer`、形状 `shape`；路径文件读不到或解析不出 `camera:paths:unreadable`，正交场景的路径 `camera:paths:orthographic`。语料里这些只出现在还差 20 项以上的 3 张里（文本 2 张、组 1 张）。

### 现状锚点

现状取自 HEAD `4a96da29`，快照基点 `a32a8071`（P4f 步骤 2 只改粒子 instanceoverride，不碰这些锚点）。

**a. 透视场景整张退回，透视抖动另报**（`compile/features.ts` 的 `checkSceneFeatures`）
```ts
  if (!g.orthogonalprojection) unsupported.add("camera:perspective");                       // 现状：按真假判透视，与粒子的 isOrthographic 不同
  if (!g.orthogonalprojection && active(g.camerashake)) unsupported.add("general:camerashake");
```

**b. 透视场景的尺寸是占位，编译期按它定 fullscreen 合成 RT**（`compile/bundle.ts` 的 `compileScene`、图像层尺寸）
```ts
      width: projection.width ?? 1920,    // 现状：没有 orthogonalprojection 时 1920×1080
      height: projection.height ?? 1080,
      layer.fullscreenSize = baseTexture
        ? [baseTexture.width, baseTexture.height]
        : [bundle.general.width, bundle.general.height];   // 现状：运行时 RT 槽取编译期的场景尺寸
```
`engineDefines(postprocess.hdr, !!general.orthogonalprojection)`、`const orthographic = isOrthographic(general)` 是另外两处判定。

**c. 视图投影与眼位只有正交**（`render/layout.ts`）
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">, zoom = 1): Mat4 {
  const projection = orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH); // 现状：没有透视分支
  return zoom === 1 ? projection : multiply(scaling(zoom, zoom, 1), projection);
}
export function eyePosition(general, offset = [0, 0]): number[] {
  return [general.width / 2 + offset[0], general.height / 2 + offset[1], 2000];  // 现状：只有正交公式
}
```

**d. 渲染器每帧只算二维抖动与缩放**（`render/renderer.ts` 的 `render`）
```ts
    const [width, height] = this.projection;                      // 现状：正交尺寸，透视场景是占位 1920×1080
    const shake = shakeOffset(state.general, wrapped, height);    // 现状：二维，只有正交
    const camera = { shake, zoom: state.general.zoom };
    // … 粒子步进之后
    scene.setCamera(camera);
```

**e. 场景只认「基准矩阵 × T(−s)」**（`render/scene.ts` 的 `setCamera`）
```ts
  setCamera(camera: SceneCamera): void {
    const [x, y] = camera.shake;
    // …
    this.viewProjection = still ? this.baseViewProjection : multiply(this.baseViewProjection, translation(-x, -y, 0));
    this.eye = eyePosition(this.bundle.general, [x, y]);     // 现状：没有透视相机
    this.cameraDirty = true;
  }
```

**f. 场景目标按编译期的场景尺寸建，上屏按壁纸样式铺**（`render/scene.ts` 的 `populate`；`render/renderer.ts` 的 `load`、`syncPlacement`）
```ts
    const [width, height] = sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D); // 现状：不看画布
    this.placement = scenePlacement(this.style, scene.width, scene.height, this.canvas.width, this.canvas.height, ratio); // 现状：样式恒生效
```
画布尺寸变了只重算铺放（`resize` → `syncPlacement`），场景目标不变。

**g. 粒子的视线与视图向量是正交常量**（`render/uniforms.ts` 的 `particleBuiltins`；`render/scene.ts` 的 `refreshParticleGeometry`）
```ts
  const { forward, right, up } = orientationVectors(renderer.orientation, model, VIEW_FORWARD, VIEW_UP); // 现状：(0,0,−1)、(0,1,0)
    g_ViewUp: [0, 1, 0],          // 现状：常量
    g_ViewRight: [1, 0, 0],
        : orientationBasis(renderer.orientation, model, VIEW_FORWARD, VIEW_UP) === null;
```
`g_ViewForward` / `Right` / `Up` 不在 `ENGINE_UNIFORMS` 里，后两个只在 `PARTICLE_UNIFORMS`。

**h. 视差的钳制把 NaN 变成 0，初值按正交算**（`render/parallax.ts`）
```ts
/** 钳到 0…1；NaN 当 0（透视场景 W = 0 时 WPE 除出 NaN，钳制分支把它变成 0，rea-p5-camera.md 6.2【推】）。 */
function clamp01(value: number): number {
  return value > 0 ? Math.min(1, value) : 0;     // 现状：步骤 0 实测推翻，WPE 保留 NaN
}
export function initialParallaxPoint(width: number, height: number): [number, number] {
  return [LOAD_EYE + width / 2, LOAD_EYE + height / 2];   // 现状：透视场景 WPE 的初值是 0
}
```

**i. 脚本的 `canvasSize` 读编译期尺寸**（`script/api.ts`）
```ts
    scoped("canvasSize", () =>
      this.vector([this.access.bundle().general.width, this.access.bundle().general.height], 2),  // 现状：透视场景读到占位 1920×1080
    );
```

### 点 1 — 投影类型与透视场景的尺寸（`compile/bundle.ts`、`compile/particles.ts`、`compile/features.ts`）
- **新增** `SceneGeneral.perspective: boolean`，由 `isOrthographic(general)` 一处定；`checkSceneFeatures`、`engineDefines` 的 `SCENE_ORTHO`、粒子缺省值都读它（`isOrthographic` 挪到 `features.ts` 或单独导出，两边 import 同一个）。
```ts
  general: {
    perspective: !orthographic,                        // 新增
    width: orthographic ? projection.width : 0,         // 修改：透视场景是 WPE 的 0（rea-p5-camera 2.1），不再占位
    height: orthographic ? projection.height : 0,
```
  > `auto: true` 的正交场景没有宽高（p3-script-REPORT 的 `q4-eye-auto` 整窗白，本机 0 张），现状是占位 1920×1080，这一步不动：写成 `projection.width ?? 1920`，只改透视分支。
- **修改** fullscreen 图层的合成 RT：槽 0 是运行时 RT 或没有纹理时，`fullscreenSize` 记成 `"scene"`，渲染器建合成 RT 时取场景目标尺寸（正交场景两者相同，没超上限时字节不变）。
- **修改** `imageLayerSize` 的 `projectlayer` 分支与 `shapeLayerSize`：透视场景报 `camera:perspective:projectlayer` / `camera:perspective:shape`（见点 7），尺寸照算（0），不会被画。

### 点 2 — 相机的编译期数据（新 `compile/camera.ts`）
- **新增**
```ts
/** 路径的一个关键帧（rea-p5-camera 3.1：t、eye、center、up、zoom）。 */
export interface CameraKey { t: number; eye: Vec3; center: Vec3; up: Vec3; zoom: number }
export interface CameraPath { duration: number; keys: CameraKey[] }
/** 透视场景的基准相机与路径；正交场景为 null（视图恒为单位阵，L2）。 */
export interface SceneCameraJson { eye: Vec3; center: Vec3; up: Vec3; paths: CameraPath[] }
/** `"x y z"` → atof 三次，缺分量 0；不是字符串返回 null（调用方保留缺省）。 */
export function cameraVector(value: unknown): Vec3 | null;
/** 解析一个路径文件，照 3.1 的容错；追加到 `out`。 */
export function parseCameraPaths(json: unknown, out: CameraPath[]): void;
/** 读 `scene.camera`：基准缺省 (2,2,2) / (0,0,0) / (0,1,0)；`paths` 按文件顺序读，读不到或不是 JSON 报 `camera:paths:unreadable`。 */
export async function compileCamera(scene: SceneJson, fs: SceneFs, unsupported: Set<string>): Promise<SceneCameraJson>;
```
- **修改** `SceneGeneral` **新增** `camera: SceneCameraJson | null`（透视场景才有）。路径文件按项目散文件 → `scene.pkg` → assets 的现有查找读，计进请求数。
  > `camera` 不在 `objects` 里，绑定与脚本都碰不到（L2：不是描述符）；`getCameraTransforms` / `setCameraTransforms` 仍在 `MISSING_SCRIPT_API`。

### 点 3 — 相机求值（新 `render/camera.ts`、`render/shake.ts`）
- **新增**
```ts
/** 路径状态（WPE G+0xe4 / +0xe8 / +0xec）：路径下标、关键帧下标、本路径内时间。 */
export interface CameraPathState { path: number; key: number; t: number }
/** 求本帧的 eye / center / up / zoom 并推进（rea-p5-camera 3.2：先求值后 t += dt；t > 段末时换关键帧或下一条路径，换路径时 t = 0）。 */
export function stepCameraPath(paths: readonly CameraPath[], state: CameraPathState, dt: number): { pose: CameraPose; next: CameraPathState };
/** 透视的一帧相机：来源（路径 > 基准）、加三维抖动、fov 钳制，返回 V、P、eye 与视图向量。 */
export function perspectiveCamera(input: PerspectiveCameraInput): PerspectiveCameraFrame;
export function lookAtRH(eye: Vec3, center: Vec3, up: Vec3): Mat4;
/** 反向深度（rea-p5-camera 1.1、步骤 0 `p5d-persp` / `persp-b` 实测）：m00 = cot(fov/2)/aspect、m11 = cot(fov/2)、m22 = n/(f − n)、m23 = −1、m32 = n·f/(f − n)。 */
export function perspectiveRH(fovRadians: number, aspect: number, near: number, far: number): Mat4;
```
- **修改** `shake.ts` **新增** `shakeOffset3(fields, time)`：`amp = 0.1·amplitude`，v 三维，长度指数作用在三维长度上，float32 逐步同 `shakeOffset`（`p5d-shakep` / `-r` 实测）。正交的 `shakeOffset` 不动。
- **新增** dev 回放用的 `replayCameraPath(paths, dts)`：从加载起按逐帧 dt 推状态机，同 `replayParallax`。

### 点 4 — 场景目标尺寸、上屏与重新加载（`render/renderer.ts`、`render/scene.ts`、`host.ts`）
- **修改** `GpuScene.build` 的选项 **新增** `size?: [number, number]`：透视场景必给，`populate` 用它（经 `sceneTargetSize` 钳上限）建场景目标；正交场景不给，照旧按 `general.width/height`。
- **修改** `SceneRenderer.load`：透视场景传 `size: this.fullResolution`，记下这次的尺寸；铺放与指针按 `stretch` 算（样式不起作用，铺满）。
- **修改** `resize`：透视场景的 `fullResolution` 和建场景时不同，尺寸稳定 300 ms 后调 `options.onRenderSizeChange?.()`；宿主收到后 `void this.reload()`。
```ts
  /** 透视场景按画布尺寸渲染（已定 6）：分辨率变了要整场重建，宿主走重新加载。 */
  onRenderSizeChange?: () => void;
```
- **修改** 渲染器的 `projection` 在透视场景是 (0, 0)（`SceneGeneral` 的值），视差与正交抖动照旧读它。

### 点 5 — 视图投影、眼位与视图向量（`render/scene.ts`、`render/uniforms.ts`、`render/renderer.ts`、`compile/features.ts`）
- **修改** `SceneCamera` 成两种：
```ts
export type SceneCamera =
  | { kind: "orthographic"; shake: [number, number]; zoom: number }          // 现状的那一份
  | { kind: "perspective"; frame: PerspectiveCameraFrame };                 // 新增：V、P、eye、视图向量
```
  渲染器帧开头按场景类型算（透视：`stepCameraPath` + `perspectiveCamera`，实时帧推进路径状态，补画帧 dt 0），粒子步进之后交给 `setCamera`。
- **修改** `setCamera` 透视分支：`viewProjection = P·V`、`eye = frame.eye`、`viewVectors = frame.vectors`，有变化才标 `cameraDirty`；透视粒子那一份不算（照报）。正交分支逐字不变。
- **新增** `ENGINE_UNIFORMS` 加 `g_ViewForward` / `g_ViewRight` / `g_ViewUp`（`PARTICLE_UNIFORMS` 去掉后两个），`staticBuiltins` 收 `viewVectors` 写入，进 `LAYER_UNIFORMS`（随相机重写）。正交下是常量，字节不变。
- **修改** `particleBuiltins`、`refreshParticleGeometry` 的 `VIEW_FORWARD` / `VIEW_UP` 换成场景当前的视线与上方向（正交下同值）；相机变了时粒子 draw 的朝向一起重算。

### 点 6 — 视差在透视场景（`render/parallax.ts`、`render/renderer.ts`）
- **修改** `clamp01` 保留 NaN（`Number.isNaN(v) ? v : …`）；**修改** `initialParallaxPoint` 收 `perspective`，透视场景为 (0, 0)（读码 6.2）。透视场景 `drawParallax` 返回 null：不移动对象（6.1），`g_ParallaxPosition` 照常每帧算（W = H = 0，结果是 NaN 或 0 / 1）。eye.xy 用透视相机的 eye。
  > 正交场景 W、H 恒大于 0，不会产生 NaN，行为不变。

### 点 7 — 能力表（`compile/features.ts`、`compile/bundle.ts`）
- **删除** `camera:perspective`、透视的 `general:camerashake`；`NEUTRAL_GENERAL` 里 `fov` / `nearz` / `farz` 的注释改成「透视每帧读」。
- **新增** 透视场景的细分（只在 `general.perspective` 时报）：

| 键 | 条件 | 依据 |
|---|---|---|
| `camera:perspective:text` | 文本对象 | P6b 只测了正交（文本在透视场景选 `_depth` 材质，rea-p6b-raster 1） |
| `camera:perspective:particle` | 粒子系统树里有 `flags & 4` | 读码：W = H = 0 时覆盖的 fov 退化（7.2），步骤 0 只测了 MVP |
| `camera:perspective:image` | 图像层 / 模型 `perspective: true` | 7.3【推】，语料 0 |
| `camera:perspective:group` | 带子层的组合层 | 组的局部正交在透视场景没测 |
| `camera:perspective:projectlayer` | `autosize` + `projectlayer` | W = H = 0，语料 0 |
| `camera:perspective:shape` | 形状对象 | 缺省尺寸是正交高，语料 0 |
| `camera:paths:orthographic` | 正交场景 `camera.paths` 非空 | 读码说不重置相机，没测，语料 0 |
| `camera:paths:unreadable` | 路径文件读不到或不是 JSON | 没测，语料 0 |

### 点 8 — dev 探针（`dev/probe.ts`、`dev/particleCorners.ts`、`dev/fluidProbe.ts`、`dev/realmProbe.ts`、`dev/scriptCorpus.ts`）
- **修改** `renderFrame`：透视场景的场景目标取 `canvas ?? window ?? [1920, 1080]`；回放时按 `particles.dts` 推路径状态（`replayCameraPath`），没给 dts 时 t = 0；读回的那一帧按最后的状态算相机，抖动按 `times` 的最后一项。
- **修改** 其余探针里按 `general.width/height` 算正交抖动 / 视差的地方，透视场景走 `perspectiveCamera`（只在要用时）。

### 点 9 — 单测
- `render/camera`：`perspectiveRH` 对上 `p5d-persp`（m00 1.206285、m11 2.144507、m22 1.00001e-5）、`p5d-persp-1280x1024`（m00 1.715605）、`p5d-persp-b`（m11 3.732051、m22 1/99）；`lookAtRH` 的列与平移；视图向量；路径：`p5d-path` 的 8 个时刻（第一圈按 t = g_Time − dt 闭式、第二圈按日志 dt 推，差 ≤ 3.6e-6）、硬切、循环、单关键帧保持、3.3 的两个怪癖；`shakeOffset3` 对上 `p5d-shakep` / `-r`。
- `compile/camera`：3.1 的容错（`break`、`disabled`、缺 `timestamp`、缺向量、缺 `zoom`、非字符串的基准保留缺省）；读不到报键。
- `compile`：`perspective` 的判定（`{auto: true}`、`{width: 0}`、`null`）；透视场景 width/height 为 0、fullscreenSize 为 `"scene"`；细分键逐个；正交场景的 bundle 与改前逐字段相同。
- `render/scene`（假设备）：透视场景的场景目标取 `size`、VP = P·V、`g_EyePosition` = eye、视图向量进全部 draw、粒子朝向用相机视线（dna_fragment 抓帧的 `g_OrientationForward` / `Up`）；正交场景 uniform 字节与改前相同。
- `render/parallax`：透视场景 P 初值 0、eye (0, 0) 时 `g_ParallaxPosition` 是 NaN、eye.x ≠ 0 时钳成 0 或 1、不移动对象。
- `render/renderer`：透视场景铺满不看样式；分辨率变化去抖后回调一次；正交场景不回调。

### 实施方式

先补测（Claude，见验收 4 的 `p5d-tilt`），确认视图向量与粒子朝向，再派子代理。子代理在 HEAD 快照（`ignore/p5/d2/head`，`a32a8071`）里实现，我独立验收后三方合并（P6b 1e 正在改 `render/scene.ts`、`render/renderer.ts`、`render/uniforms.ts`、`host.ts`，P4f、P10a 改 `compile/bundle.ts`、`compile/features.ts`）。

### 验收

子代理：快照 tsc 0 错误；vitest 除已知的 `3830255100: 219 次请求` 外全过；Prettier。

Claude 独立验收：
1. 越界检查、自跑 tsc / vitest；变异：m22 / m32 取 DirectX 原式（不反向）、宽高比取场景尺寸、fov 不钳、路径切换不清 t、切线乘段长、先推进后求值、抖动只二维 / 幅度按正交、视图向量取行、粒子朝向仍用常量、视差在透视场景移动对象、NaN 钳成 0、透视场景按样式铺放、尺寸变化不回调、`perspective` 改回按真假判。
2. 语料：去掉 `camera:perspective` 11 张、透视的 `general:camerashake` 3 张，新增的只有点 7 的细分键；能渲染 57 → 60（dna_fragment、techno、neon_sunset），原来能渲染的不掉出。
3. 画面哈希：10 张基线场景 × 三档不变（全是正交）。
4. **补测 `p5d-tilt`**（动工前，`gen_d.py` 新增）：透视、斜相机（eye (6, 4, 10) 看原点），探针网格读 `g_ViewForward` / `Right` / `Up`、`g_EyePosition`、VP；sprite 粒子缺省朝向与 `upright`、带 `REFRACT` 读 `g_ViewUp` / `Right`。抓帧核对读码（视图向量取 V 的列）与 dna_fragment 的结论。
5. **真机对 WPE**（dev 应用渲染、按 WPE 日志回放、`kbp cmp frame --kbp-layers`，窗口 1920×1080）：确定性工程 `p5d-persp`（另 1280×1024）、`p5d-persp-b`、`p5d-path`（9 个等待时间）、`p5d-shakep` / `-r`、`p5d-2d`、`p5d-depth2`、`p5d-imgcull-p`、`p5d-tilt` 整帧逐像素；三张样本：去掉粒子层的变体整帧逐像素（新抓），粒子层另比每次绘制的 MVP 与 `g_Orientation*`（抓帧常量对 dev 探针的 uniform）。
6. 画布尺寸：预览、桌面窗口模式各看一次透视样本（铺满、不拉伸、样式切换不影响），改宿主画布尺寸后只重新加载一次、场景目标跟着变。
7. 三方合并进工作区，合并后再跑 tsc、vitest。测试行用 `projects_remove` 删掉。

### 步骤 2 实施记录（2026-11-13）

先补测 `p5d-tilt`（`ignore/p5/d2/gen_d2.py`，抓帧 `A:\p5d\p5d-tilt`，结论写进 p5-REPORT）：视图向量是世界空间的 V 列，粒子朝向用相机的视线与上方向，步骤 0「sprite 不面向相机」更正。子代理在 HEAD 快照（`a32a8071`，`ignore/p5/d2/head`）里实现（第一个代理读了 9 小时代码没有落盘，停掉重派），我独立验收后变基到 `1616bb2b`（`ignore/p5/d2/new`，9 处冲突：P6b 1e 的文本重排参数、`variantPlans` 的文本排版参数、fbo 建法重构，都是两边各加），再三方合并进工作区（另 8 处冲突，来自工作区里 P8 步骤 4 的图层依赖与 P10a 的关键帧回放，`ignore/p5/d2/resolve_wt.py` 逐处断言原文后拼接；合并前工作区相对 HEAD 的新增行一行不少，`check_kept.py`）。

**和计划不一致或计划没写到的：**
- `SceneGeneral.perspective` / `camera` 写成可选（缺省按正交），`SceneCamera` 正交那种的 `kind` 可省：不动约 20 个手写 `SceneGeneral` 的测试，少一些合并冲突。
- 路径表的边界（语料 0）：第 0 条没有关键帧时整表清空、别的空路径去掉、两个关键帧同一时刻 s 取 1、状态越界从头开始。
- 建场景时先按加载时的相机（路径起点、`g_Time` 0）算一份，给预热与第一批 uniform；第一帧就换成当帧的。
- `camera:perspective:image` 在 `checkSceneFeatures` 按对象 JSON 判；`particleTrackProbe` 在透视场景给了 `cursors` 时直接抛错（跟随点的反投影没接透视相机，语料 0）。
- 宿主「分辨率变化 → 重新加载」由补的 `host.test.ts` 用例锁住（变异时发现原来没有测试）。

**验收：**
- 越界：快照对基点只改计划内的文件。tsc 0 错误；vitest 2768 通过（变基后 2858），只有已知的 `3830255100: 219 次请求`；Prettier 通过。
- 变异（`ignore/p5/d2/mutate_d2.py`，快照模式）32 处：31 处检出，「宿主不重新加载」补单测后检出；还原后整树哈希一致。子代理另有 28 处，全部检出。
- 路径状态机按 `p5d-path` 的 WPE 日志逐帧推，能核对的 6 帧（w1 第 41–43 帧、w6 第 142–144 帧，两次切换之后）`g_EyePosition` 差 ≤ 3.7e-6；其余几组日志不全（步骤 0 同样跳过）。
- 语料（同一份 wasm、183 张）：只去掉 `camera:perspective` 11 张与透视的 `general:camerashake` 3 张，新增 `camera:perspective:text` 2 张、`:group` 1 张；能渲染 66 → 69（dna_fragment、techno、neon_sunset），没有掉出。变基后在 `1616bb2b` 上重扫，结果相同。
- 画面哈希：10 张基线 × 三档，变基前（`a32a8071`）与变基后（`1616bb2b`）各对一次，全部相同。
- **真机对 WPE**（`render_scene` 按 WPE 日志回放、`kbp cmp frame` 数值比，两边后处理关闭，窗口 1920×1080）：
  - 逐像素相同（差 0）：`p5d-persp`、`p5d-persp`（1280×1024）、`p5d-persp-b`、`p5d-depth2`、`p5d-path` w1 / w6、`p5d-shakep-r`、`p5d-tilt`、`p5d-2d-nofs`（去掉 FS 探针，合成链与 fullscreenlayer）。
  - techno 最大差 4；dna_fragment 去粒子最大差 8（1 个像素超过 2）。
  - neon_sunset 去粒子：超过 2 的像素 0.13%、超过 32 的 20 个。逐层与组合拆开（`ignore/p5/d2/mk_layers.py`，12 个变体）：太阳单层 0 差，残差只在带 neongrid（顶点着色器 `frac(sin(...)·43758.5453)` 哈希）或 filmgrain 时出现，没有继续查。
  - 和步骤 0「只记不补」两条对上的差别：`p5d-2d` 原版（槽 0 没有纹理的 fullscreen 几何，WPE 用对象 `size`）、`p5d-imgcull-p`（不乘 MVP 的着色器下看得出的图像层视锥剔除，正好是 I1 / I2 两块）。
  - 合并后的构建对 5 个工程（`p5d-tilt`、`p5d-path` w6、techno、dna / neon 去粒子）回放，像素摘要和合并前逐字节相同。
- **没做 / 和计划不同**：`p5d-shakep`（日志到第 150 帧、抓帧在 180，没比；`p5d-shakep-r` 与单测已覆盖三维抖动）；样本里粒子层的 MVP 与朝向没逐绘制比（斜相机的朝向由 `p5d-tilt` 锁住）；桌面壁纸窗口没看，「改画布尺寸只重载一次」只有单测、没在真机上拖窗口。预览里原版 techno / dna_fragment / neon_sunset 都实时渲染，场景目标 3840×2160（主屏全分辨率），铺满。
- 过程中的事：
  - 头两次去粒子抓帧带着 WPE 的泛光（多出画到 240×135、480×270 的 4 次绘制，当时 WPE 设置界面开着、内存里的档位是开的），重抓后才是上面的结果；
  - 解包工程的光标日志脚本用到 `input.cursorScreenPosition`，所以 `*-kbp` 工程在预览里退回，回放探针强制渲染不受影响；
  - 共享宿主产物被别的会话中途重建过两次，哈希重测；
  - 收尾时：「场景后处理」改回超高，测试行全部移除，宿主产物按合并后的工作区重建。

## 步骤 3 — 相机对象

### 思路

相机对象已经有了大半的骨架：它没有 `image` / `model` 等内容键，编译期本来就作为「分组节点」进 `layers`，层级、可见性（含绑属性）、`origin` 上的字段脚本都照常工作，现在只是 `camera`、`fov`、`zoom`、`path`、`queuemode` 被当未知键报。这一步让它真正驱动相机，规则全部来自步骤 0 与步骤 3 补测（p5-REPORT「P5d 语义的实测核对」与「步骤 3 补测」）。

**编译期。** 相机对象照 WPE 的工厂判定：`camera` 是字符串。`SceneLayer` 新增 `camera: { fov, zoom } | null`（缺省 50 / 1，float 取值同 `GENERAL_FIELDS` 的规则）；`fov`、`zoom` 绑用户属性或挂字段脚本时登记成新的就地目标（`{ kind: "camera"; object; field }`），值落在 `SceneState.cameras`。`path` 指向的条目动画文件读出非空 `paths` 或读不到报 `camera:path`（语料 22 个都是空表），`queuemode` 中性。相机对象同时带别的内容键（图像、模型、粒子、声音、文本、灯、形状）时 WPE 按哪个类建没查，报 `object:camera:mixed`（语料 0）。`fov` / `zoom` 挂关键帧照旧由 P10a 的 `value:animation:camera` 报，这一步不碰动画。

**每帧选相机。** 和步骤 2 的相机求值同一时刻（帧开头、粒子步进之后交给场景，用的是上一帧脚本写过的状态）：按 `objects` 倒序找第一个自身与父链都可见（`effectiveVisible`）的相机对象，取它的世界矩阵（`worldMatrixOf`）：eye = 平移列，center = eye − 第 2 列（看本地 −Z），up = 第 1 列。有活动相机时路径不推进（WPE 只在没有相机对象时走路径）。都不可见时回到步骤 2 的来源（路径 / 基准；正交场景是单位视图）。

**正交场景。** 视图 V = `lookAtRH(eye + s, center + s, up)`（s 是正交抖动），VP = `sceneViewProjection(general, general.zoom × camera.zoom) · V`；`g_EyePosition` = (eye.x + s.x + W/2, eye.y + s.y + H/2, 2000)；视图向量取 V（步骤 0 `p5d-camo-r`）；视差点的 eye.xy 是相机的 eye.xy + s（补测 `-par`）。透视覆盖（透视粒子、`perspective: true` 的图像层 / 模型）改成在相机 V 上做：旋转不变，平移换成 (t.x − W/2, t.y − H/2, −d)，d 照旧按含缩放的可见高算（补测 `-pp`、`-ppr`）。没有可见相机对象时一行不变（`lookAtRH` 在 eye 为 (0, 0, 0) + s 时就是 `T(−s)`，但仍走原来的分支保证字节不变）。

**透视场景。** 来源姿态换成相机的（步骤 2 的 `perspectiveCamera` 只换 pose），fov 取相机对象的 `fov`（钳制），zoom 不起作用（步骤 0 `p5d-camp-*`）。

**不做、照报：** 相机条目动画（`camera:path`）；脚本的 `getCameraTransforms` / `setCameraTransforms` 与图层上的 `fov` / `zoom` 字段访问（仍在 `MISSING_SCRIPT_API`，语料 0 处）。语料 18 张带相机对象的场景都还差别的能力，这一步只去掉相机一组键，不解锁。

### 现状锚点

现状取自 HEAD `c92f5b5c`。

**a. 相机对象的键被当未知键报**（`compile/features.ts` 的 `checkObjectFeatures`）
```ts
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      // … 已知的各类键 …
      active(value)
    )
      unsupported.add(`object:${key}`);   // 现状：camera / fov / zoom / path / queuemode 都走到这里
```
相机对象 `objectKind` 为 undefined，`compileScene` 把它当分组节点放进 `layers`（`bundle.ts`：「每个对象都进 layers（分组节点、灯、粒子是没有 pass 的图层）」）。

**b. 渲染器每帧的相机只有路径 / 基准与正交抖动**（`render/renderer.ts` 的 `render`）
```ts
    if (this.perspective) {
      const { pose, next } = stepCameraSource(this.camera!, this.cameraPath, frametime);  // 现状：没有相机对象
      this.cameraPath = next;
      const frame = perspectiveCamera({ pose, fields: state.general, time: wrapped, width: scene.width, height: scene.height });
      camera = { kind: "perspective", frame };
      eye = [frame.eye[0], frame.eye[1]];
    } else {
      const shake = shakeOffset(state.general, wrapped, height);
      camera = { shake, zoom: state.general.zoom };   // 现状：正交视图恒为 T(−s)
      eye = shake;
    }
```

**c. 正交的 `setCamera` 只认平移与缩放**（`render/scene.ts`）
```ts
    this.viewProjection = still ? this.baseViewProjection : multiply(this.baseViewProjection, translation(-x, -y, 0));
    this.perspectiveViewProjection = still
      ? this.basePerspectiveViewProjection
      : multiply(this.basePerspectiveViewProjection, translation(-x, -y, 0));   // 现状：透视覆盖的视图是 T(−W/2 − s, −H/2 − s, −d)
    this.eye = eyePosition(this.bundle.general, [x, y]);
```

**d. 透视覆盖从单位视图算**（`render/layout.ts`）
```ts
export function particleViewProjection(general, zoom = 1): Mat4 {
  // …
  return multiply(projection, translation(-width / 2, -height / 2, -d));   // 现状：不看相机（补测 `-pp` 推翻）
}
export function eyePosition(general, offset = [0, 0]): number[] {
  return [general.width / 2 + offset[0], general.height / 2 + offset[1], 2000];   // 现状：不加相机 eye
}
```

### 点 1 — 编译（`compile/bundle.ts`、`compile/features.ts`、`compile/bindings.ts`、`compile/scripts.ts`）
- **新增** `isCameraObject(object)`（`typeof object.camera === "string"`，`features.ts`，编译与能力表共用）；`SceneLayer.camera: { fov: number; zoom: number } | null`。
- **新增** 绑定目标 `{ kind: "camera"; object: number; field: "fov" | "zoom" }`：`fov` / `zoom` 绑用户属性、挂 `{script}` 时登记它；取值规则同 `generalValue` 的 float。
- **修改** `checkObjectFeatures`：相机对象的 `camera`、`fov`、`zoom`、`path`、`queuemode` 不再报；**新增** `object:camera:mixed`（相机对象另带内容键）。`compileScene` 读 `path` 文件：非空 `paths` 或读不到报 `camera:path`。

### 点 2 — 状态（`render/state.ts`）
- **新增** `SceneState.cameras: Map<number, { fov: number; zoom: number }>`（`fromBundle` 填初值），`write` / `needsRecompile` 加 `camera` 目标，就地写、不标脏（渲染器每帧读）。

### 点 3 — 选相机与求值（`render/camera.ts`）
- **新增**
```ts
/** 本帧生效的相机对象（倒序找第一个自身与父链都可见的），取世界矩阵的平移、第 2 列取负、第 1 列；没有为 null。 */
export function activeCameraObject(bundle: SceneBundle, state: SceneState, worlds: Map<number, Mat4>): { object: number; pose: CameraPose; fov: number; zoom: number } | null;
/** 正交场景带相机对象的一帧：V = lookAtRH(eye + s, center + s, up)；VP、eye uniform、视图向量、透视覆盖的 V'。 */
export function orthographicCameraObjectFrame(…): OrthographicCameraFrame;
```
- **修改** `stepCameraSource` 前先看相机对象：有就用它的 pose（透视场景另取 fov），路径不推进。

### 点 4 — 场景与渲染器（`render/scene.ts`、`render/renderer.ts`、`render/layout.ts`）
- **修改** `SceneCamera` 的正交那种可带相机对象的帧（`{ shake, zoom, view? }`）；`setCamera` 有 `view` 时 `viewProjection = sceneViewProjection(general, zoom) · V`，`eye` 加相机 eye.xy，视图向量取 V，透视覆盖用 `particleViewProjection(general, zoom, V)`。没有 `view` 时逐字不变。
- **修改** `particleViewProjection` 收可选的视图 V：旋转不变，平移 (t.x − W/2, t.y − H/2, −d)；不给时同现在。
- **修改** 渲染器帧开头先选相机对象：正交传 `view` 与 `zoom = general.zoom × camera.zoom`，视差点的 eye.xy 用相机的 eye.xy + s；透视用相机 pose 与 fov。
- **修改** dev 探针（`dev/probe.ts`、`dev/particleCorners.ts`）的 `frameCamera` 同样选相机对象。

### 点 5 — 单测
- `compile`：`isCameraObject`；相机对象的五个键不再报、`object:camera:mixed`、`camera:path`（非空 / 读不到）；`fov` / `zoom` 的绑定与字段脚本目标。
- `render/camera`：选相机（倒序、父链不可见、都不可见回退）；正交帧对上步骤 0 `p5d-camo-c`（VP 平移 (−2, −2)、深度 0.375，`g_EyePosition` (1920, 1080, 2000)）、`-o`（平移 (−1.208, −1.185)）、`-r`（`g_ViewRight` (cos 0.3, sin 0.3, 0)、线性项 ×2）；透视覆盖对上补测 `-pp`（NDC (−0.5, −0.5)、w 494.82）、`-ppr`（(−0.932, −1.502)、w 247.41、m00 0.5154·cos 0.3）；视差对上 `-par`（`g_ParallaxPosition` (0.60417, 0.59259)）；抖动对上 `-shake`；透视场景对上 `p5d-camp-1` / `-2`（eye、fov）。
- `render/scene`（假设备）：没有相机对象的场景 uniform 字节与改前相同；绑属性切换可见的相机，下一帧换相机。

### 实施方式

子代理在 HEAD 快照（`ignore/p5/d3/head`，`c92f5b5c`）里实现，我独立验收后三方合并（P8 步骤 4、P10a、P6b 在工作区改 `compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`dev/*`）。

### 验收

子代理：快照 tsc 0 错误；vitest 除已知的 `3830255100: 219 次请求` 外全过；Prettier。

Claude 独立验收：
1. 越界检查、自跑 tsc / vitest；变异：选相机改成正序、不看父链可见、center 取 +Z、up 取第 0 列、正交 VP 不乘 V、相机 zoom 不乘、`g_EyePosition` 不加相机 eye、视差 eye.xy 不用相机、透视覆盖不看 V / 改了旋转、透视场景 fov 仍取 general、有相机时路径仍推进、`camera:path` 不报、可见性绑定不触发换相机。
2. 语料：只去掉 18 张的 `object:camera` / `fov` / `zoom` / `path` / `queuemode`，不新增键、不解锁、不掉出。
3. 画面哈希：10 张基线 × 三档不变。
4. 真机对 WPE（`render_scene` 按日志回放、`kbp cmp frame` 数值比，后处理关闭，1920×1080）：步骤 0 的 `p5d-camo-0` / `-c` / `-o` / `-r`、`p5d-camp-1` / `-2`，补测的 `p5d-camo-pp` / `-ppr` / `-par` / `-shake`，整帧逐像素。`p5d-camo-s`（原点挂脚本）回放探针不跑脚本，不比，由单测覆盖。
5. 三方合并进工作区，合并后再跑 tsc、vitest。测试行用 `projects_remove` 删掉。

### 步骤 3 实施记录（2026-11-14）

先补测正交相机对象和透视覆盖、视差、抖动的相互作用（`ignore/p5/d3/gen_d3.py` 的 `p5d-camo-pp` / `-ppr` / `-par` / `-shake`，抓帧 `A:\p5d\p5d-camo-pp` 等，`ana_par.py` 逐色块核对 MVP，结论写进 p5-REPORT「步骤 3 补测」），确定透视覆盖在相机 V 上做、视差点与抖动都跟相机 eye。子代理在 HEAD 快照（`c92f5b5c`，`ignore/p5/d3/head`）里实现，我独立验收后变基到 `cb6e8cff`（`ignore/p5/d3/new`，2 处冲突：`SceneLayer` 上 P8 步骤 4 的 `dependedOn` 与 `camera` 相邻、`features.ts` 文档注释相邻，`resolve_new.py` 两边都留），再三方合并进工作区（`dev/particleCorners.ts` 2 处冲突：工作区 P10a 加的 `SceneAnimations` import 与 `animate` 块，`resolve_wt.py` 逐处断言原文后拼接）。

**和计划不一致或计划没写到的：**
- `SceneLayer.camera` 写成可选、编出来的图层一律填（非相机为 null），理由同 `text` / `model`。正交 `SceneCamera` 的新字段叫 `cameraObject`，是整份预先算好的帧（`OrthographicCameraFrame`），不是计划写的 `view?`。
- `stepCameraSource` 没改：选相机放进新的共享函数 `sceneCameraFrame`（渲染器与 dev 探针都调，`cameraObjectLayers` 加载时取一次），两边不分叉。选相机按 `object` 下标取最大，与倒序遍历等价，不依赖 `layers` 顺序。
- 相机对象另带内容（`object:camera:mixed`）时不当相机：不进 `cameras`、不登记 `fov` / `zoom` 目标，只读 `path`。
- `camera:path` 的边界（语料 0）：空串、不是字符串、根不是对象都报，`paths` 不是数组按空表。
- `scene.ts` 新增 `objectCamera` 标志：离开相机对象时不提前返回、视图向量复位；`same` 提成模块级函数。
- `particleTrackProbe` 在带相机对象的场景给了 `cursors` 时抛错（跟随点反投影没接相机视图，同步骤 2 的透视场景）。

**验收：**
- 越界：快照对基点只改计划内的 18 个文件（新增 `compile/p5d3.test.ts` 24 条、`render/p5d3-camera.test.ts` 26 条）。tsc 0 错误；vitest 2908 通过，只有已知的 `3830255100: 219 次请求`；变基后 2944 全过（那一项在 `cb6e8cff` 上不再失败，原因没查）。
- 变异（`ignore/p5/d3/mutate_d3.py`，快照模式）21 处全部检出、按原字节还原。子代理另有 31 处，全部检出（「离开相机对象时提前返回」补用例后检出）。
- 语料（183 张）：只去掉 18 张的 `object:camera` / `fov` / `zoom` / `path` / `queuemode`，不新增键；能渲染 69 → 69，没有解锁也没有掉出（18 张都还差别的能力）。变基后在 `cb6e8cff` 上重扫，结果相同。
- 画面哈希：10 张基线 × 三档，变基前与步骤 2 相同，变基后 `cb6e8cff` 对 `cb6e8cff` + 步骤 3 相同。变基前后步骤 3 的增删行按文件逐行相同（`same_patch.py`），所以下面的真机对比对变基后同样成立。
- **真机对 WPE**（`render_scene` 按 WPE 日志回放、`kbp cmp frame` 数值比，两边后处理关闭，1920×1080）：
  - 逐像素相同（差 0）：`p5d-camo-c`、`-o`、`-r`、`-pp`、`-ppr`、`-par`、`-shake`，`p5d-camp-2`（排除 FR / CLK）。
  - `p5d-camo-0`：只有 CLK 块差 34（CLK 的 R 通道是 `frac(g_PointerPosition…)`，回放用缺省光标、抓帧时光标在别处），排除 FR / CLK 后差 0。
  - `p5d-camp-1`：只有 FR / CLK 两块不同。它们在 (1820, 40, 0)，WPE 在透视场景对图像层做了视锥剔除（步骤 0「只记不补」的同一条），排除后差 0。
- 合并：合并前工作区相对 HEAD 的新增行一行不少（`check_kept.py`），步骤 3 的新增行也一行不少。合并后工作区 tsc 0 错误；vitest 3068 通过、1 失败 `2251857160: 553 次请求`：工作区里 P10a 去掉了 `value:animation:pending`，这张能编完、请求变多（`cb6e8cff` 与 `cb6e8cff` + 步骤 3 的语料里它都还停在这个键上），与步骤 3 无关，上限归 P10a 调。
- 提交基点：合并之后 HEAD 又前进到 `5889b490`（P6b 1e-3 与逐 draw 轨迹两笔，和步骤 3 重叠 6 个文件），提交的树是 `5889b490` + 步骤 3（`ignore/p5/d3/commit`，三方合并无冲突，增删行与变基前逐行相同）。在它上面 tsc 0 错误、vitest 2996 全过；语料对 `5889b490` 只去掉同样 18 张的相机五个键，能渲染 78 → 78。这一树没有重测画面哈希：共享宿主产物当时正被别的会话的临时插桩实验使用，没有重建。
- **没做 / 留给后面**：`p5d-camo-s`（原点挂脚本）回放探针不跑脚本，只有单测；加载时的预热与视差点初值不看相机对象（WPE 这时的 eye 没测，`-par` 用的是 delay 0），带相机对象的模板场景开场可能不同；每个相机对象多读一次 `path` 文件，计进请求数。
- **和真实写法之间的缺口（`FINAL_CHECK.md`，提交后补做）**：上面逐像素比的都是生成的工程，相机变换写死。语料 18 张的真实写法没有比过：
  - 15 个相机对象的 `origin` 挂脚本，多数是同一个模板，按 `engine.canvasSize` 乘脚本属性定位，相机停在哪取决于运行时的 `canvasSize`；
  - 14 个 `zoom` 绑用户属性；
  - 另有按属性切换可见性轮换的多相机、`fov` 挂脚本、带父对象、`origin` / `zoom` 挂关键帧。

  这 18 张都还缺别的能力，步骤 3 不解锁，画面上暂时看不出来。补做按原则 5：复制工程（只留相机对象及其脚本、绑定与几张图像层），在 WPE 里录帧，回放时让原点脚本照常跑，逐像素比。
- 收尾：测试行全部移除；共享宿主产物按合并后的工作区重建。

## 步骤 3 补充 — 相机对象的真实写法走查（`FINAL_CHECK.md` 原则 5）

### 思路

步骤 3 和 WPE 逐像素比的都是生成的工程，相机变换写死。语料里的真实写法另有几种（实施记录「和真实写法之间的缺口」）：原点挂脚本、`zoom` 绑属性、按属性切换的多相机、`fov` 挂脚本、带父对象。这一步从真实壁纸做复制工程（`kbp content isolate`），只留相机对象和它依赖的东西，再加几张能渲染的图像层。在 WPE 里录帧，我们按同样的输入回放，**脚本照常跑**（工具第 7 批），整帧逐像素比，每处差异定位到 draw 与数值，归为已知差异或 bug。

### 补测（2026-11-14，已做）

`ignore/p5/d3/gen_d3b.py` 的 `p5d-camo-s4k`：同 `p5d-camo-s`（原点挂模板脚本、把 `canvasSize` 等写进日志），场景改成 3840×2160，窗口 1920×1080，抓帧 `A:\p5d\p5d-camo-s4k`，分析 `ana_s4k.py`。
- WPE 日志：`canvasSize 3840 2160 screen 1920 1080 origin 1920 1080 500`。`engine.canvasSize` 是场景尺寸，`engine.screenResolution` 是窗口尺寸，和我们的 API 相同。
- 5 个色块的 NDC 与「视图平移 −eye」逐个相同（如 S2 (960, 540) → (−1.5, −1.5)），深度 0.375，`g_EyePosition` = (3840, 2160, 2000)。相机放在场景中心时，WPE 的画面就是偏半屏，模板写法照这个规则画。

### 样本（工具到位后定稿）

| 样本 | 真实写法 | 复制工程留什么 |
|---|---|---|
| `3462279189` | 模板：原点脚本 `scriptProperties.x/y × engine.canvasSize`，`zoom` 绑属性，开视差 | 相机、天空（含子层月亮）、地板、人物、一张树丛；文本、音频条、粒子、声音删掉 |
| `3605722997` | 三个相机按属性切换可见，`zoom` 2.87、原点不在零点 | 三个相机与几张图像层；属性分别切到每个相机各录一段 |
| `3706286085` | 透视，多个相机 `fov` 挂脚本、按属性切换、带父对象 | 相机、父对象与几个模型 / 图像层，能渲染才做，不能渲染记下原因 |

每张：窗口 1920×1080 与 1600×900 各录一段（场景尺寸 ≠ 窗口尺寸）；`zoom` 属性取缺省值与一个非缺省值；后处理关闭。

### 做法

1. `kbp content isolate <工坊 ID> --keep … --instrument`，看 `warnings`（脚本按下标找图层、被删对象的依赖等），有影响画面的警告就换样本或改留的对象。
2. WPE 侧：`capture_sweep` 连续抓帧，日志带 FR 帧号与帧时间；属性用 `apply_properties`。
3. 我们这边：`projects_import`，`renderFrames.ts --timeline-log … --scripts` 按帧回放，`kbp cmp frames` 逐帧比。
4. 每处差异定位到 draw 与数值（WPE 侧 RenderDoc，我们这边 `trace`），归为已知差异（写明依据）或 bug（修）。
5. 记录：每张一行（留了哪些对象、换了哪些字段、帧数、窗口、结果、每处差异与解释、依据），写进本节的实施记录。

### 依赖

工具第 7 批（`.claude/plans/tools/kabegame-chromium-lib.md`「回放跑场景脚本」）。它之前能做的只有补测和 WPE 侧的录制。

### 走查记录（2026-11-14，进行中）

工具第 7 批完成之前，先用现有的 `scriptValues` 把挂脚本相机的原点塞成脚本会算出的值（REST 渲染，`ignore/p5/d3/walk_sv.ts`），单独核对「真实内容 + 步骤 3 的相机」。WPE 抓帧在 `A:\p5d\walk\`，日志 `ignore/p5/d3/out/logs/`，比较结果 `ignore/p5/d3/out/walk/`。逐 draw 对照：WPE 侧 `peek_draws.py`（`rdc_dump_c.py` 导出），我们这边 `peek_trace.py`（渲染的 `trace`）。

| 复制工程 | 留的对象 / 换的字段 | 窗口 | 帧 | 结果 |
|---|---|---|---|---|
| `3462279189-iso-tmpl`（含人物） | 天空、月亮、树丛1、地板、人物、相机 | 1920×1080 | 270 | 全部 draw 的 MVP、`g_ParallaxPosition`、`g_Time` 和 WPE 逐位相同；整帧差来自人物：纹理标志 0x22（视频），视频时刻对不上，属于 P9a 的特性，按原则 5 去掉人物重做 |
| `3462279189-iso-tmpl2` | 天空、月亮、树丛1、地板、相机 | 1920×1080 | 278 | 最大差 68，超过 32 的 138 像素，全在月亮轮廓 |
| 同上 | 同上 | 1600×900 | 291 | 最大差 90，超过 32 的 128 像素，全在月亮轮廓 |
| 同上，`zoom` 属性 2（开窗后改） | 同上 | 1920×1080 | 144 | 最大差 12，没有超过 32 的 |
| 同上，镜头位置 `x3` 0.3 / `y1` −0.2（开窗后改） | 同上 | 1920×1080 | 156 | 相机原点 (1152, −432) 和 WPE 相同（FR 的 MVP 逐位相同）；视差点差 7.9e-5：WPE 改属性之前的几帧相机还在 (0, 0)，视差有 2 s 延迟、带着这段历史（下一行验证） |
| `3462279189-iso-tmpl2pos`（`x3` / `y1` 缺省值改成 0.3 / −0.2，从加载起生效） | 同上 | 1920×1080 | 238 | 全部 draw 的 MVP、视差点 (0.955, 0.145)、`g_Time` 和 WPE 逐位相同；超过 32 的 2829 像素都是图层硬边缘上的细线（相机右移后天空、地板的边进了画面） |
| `3605722997-iso-camsA`（只留静态图 202，`visible` 固定为 true；主图是视频，去掉） | 202、三个相机，206 生效 | 1920×1080 | 198 | 最大差 35，超过 32 的 1 像素 |
| `3605722997-iso-camsB`（`newproperty11` 缺省 true） | 同上，「近景」188 生效（`zoom` 2.87） | 1920×1080 | 202 | 最大差 12，没有超过 32 的 |
| `3605722997-iso-camsC`（`newproperty2` 缺省 true） | 同上，「默认镜头」204 生效 | 1920×1080 | 204 | 和 A 逐项相同（xy 都是零点，z 只影响深度，没有深度测试） |

**差异的解释（已知差异）**：每组逐 draw 的几何与内置量都和 WPE 逐位相同，剩下的差只在锐利边缘（月亮轮廓、图层硬边），而且只在缩小采样时出现。WPE 按窗口分辨率直接画，我们先按场景分辨率画再缩到画布（`FINAL_CHECK.md`「已知差异」里的同一条）。对照：同一工程放大到 `zoom` 2 / 2.87 时纹理是放大采样，最大差只有 12。

**脚本自己跑（工具第 7 批，2026-11-14）**：上表里挂脚本相机的五组（tmpl2 的 1080 / 900 / `zoom` 2、tmpl2pos、camsA）都开 `scripts` 重跑，结果和塞值逐字节相同，和 WPE 的比较统计逐项不变。另外两组生成工程开脚本，和 WPE 整帧不排除任何区域逐像素相同：
- `p5d-camo-s`：原点挂模板脚本，第 184 帧；
- `p5d-camo-s4k`：同一脚本，场景 3840×2160、窗口 1920×1080，第 131 帧。我们的脚本日志与 WPE 日志相同：`canvasSize 3840 2160 screen 1920 1080 origin 1920 1080`。

**透视样本**：`3706286085` 做不了。它的相机都挂在带骨骼动画的模型下（`CameraBoneMoveMesh` 等，`mdl:skeleton` / `mdl:animation` 没实现），相机的世界矩阵依赖这些模型，复制工程去不掉。换成 `3453730450`：
- **场景**：透视；相机 208 的原点脚本用 `Date.now()` 在前 10 s 把 z 从 25 缓到 `wz`（绑属性 `ylensy`，缺省 9），x 读另一个对象写的 `shared.catE`。
- **复制工程**：留相机、纯色层 302 / 14 与图像 125，去掉三个灯（闭包会把灯和它们的父对象拉进来，带出反射、体积光等不支持项）。125 的透明度、角度、缩放也挂脚本：透明度用 `Date.now()` 在 10–15 s 缓入，角度按 `engine.frametime` 累加，缩放在 `init` 里定。`shared.*` 的写入方删掉了，两边读到的都是 undefined。
- **结果**：
  - 抓帧在约 16 s（第 332 帧）。全部 draw 的 MVP 和 WPE 相同。唯一一块明显的差（292 像素）是 125 被黑色纯色层盖住（步骤 4 实现透明排序后消失，见步骤 4 实施记录）：WPE 开了 `general:transparentsorting`，按深度从远到近画（w = 39 → 9 → 8），我们按对象顺序画，远处的黑层最后画。这一项是能力表照报的不支持项，与相机无关。
  - 对照：同一复制工程把 `transparentsorting` 改成 false，第 328 帧和 WPE 整帧逐像素相同。

**发现、没修**：WPE 交给字段脚本的向量分量是 float32（日志里 z 是 `500.0000305175781`），我们是 double（`500.00003`）。这里只影响深度，看不出差别，归 P3b 的脚本运行时。

**结论**：相机对象的真实写法都和 WPE 一致，包括：
- 原点脚本按 `canvasSize` 定位；
- `zoom` 绑属性；
- 属性切换多相机；
- 透视场景里用 `Date.now()` 缓入原点。

剩下的差异有两类：一类是先按场景分辨率画再缩到画布的采样差，FINAL_CHECK 已登记为已知差异；另一类来自别的能力（视频时刻、透明排序）。

## 步骤 4 — 透明排序（`transparentsorting`）

`phase-13-3d-lighting.md` 的「决定」2 把它并进了 P13h。2026-11-14 用户让 P5d 会话先做：P5d 步骤 3 走查的 `3453730450` 正是被它挡住的唯一差异。P13 的计划文件不由这里改，P13h 做时以这里为准。

### 思路

WPE 的场景绘制只有一个开关会改顺序（rea-p5-mesh 4.2，读码已确认的部分）：透视场景开了 `transparentsorting` 时分两遍。
- 第一遍：按 `objects` 顺序画所有不在「半透明集合」里的对象。
- 第二遍：把半透明对象按「对象**局部** `origin` · 相机前向」从大到小排序后画，也就是从远到近。`fullscreen` / `projectlayer` 图像的键是 −∞，排在最后。
- 半透明集合：粒子、灯在构造时就进；图像层看材质 blending 是不是 normal / alphatocoverage 以外的；模型要所有网格都是 translucent / additive。
- 正交场景、开关关闭时照旧按 `objects` 顺序。

我们的渲染器在 `GpuScene.encode` 末尾按 `objects` 顺序逐层 `runLayer`。实现就落在这一处：编译期给每个顶层图层定好排序类别（不透明 / 半透明 / 排最后），渲染时在透视场景、开关打开时，每帧按当帧相机的前向和状态里的当前 `origin` 重排顶层这一轮。组画子树、模型内部的网格顺序、粒子树的先序都不动。探针用的是同一个 `encode`，回放自动跟上。

读码没查清、要靠步骤 0 实测定的几件事：
- 前向取视图矩阵哪一轴、正负（「从大到小」是不是由远到近）；
- 排序是否稳定；
- 用的是局部 `origin` 还是世界位置；
- 脚本写过的 `origin` 是否当帧生效；
- 文本、粒子、模型算不算半透明；
- 开关能不能运行中改。

### 现状锚点

**a. 顶层按 `objects` 顺序画**（`render/scene.ts` 的 `encode`）
```ts
    // 组的子孙（`group` 非空）在顶层不画，由组的 `subtree` op 画（P5b 步骤 4）
    for (const layer of this.layers) if (layer.layer.group == null) runLayer(layer);   // 现状：不看 transparentsorting
```

**b. general 里不认识的键照报**（`compile/features.ts` 的 `checkSceneFeatures`）
```ts
  for (const [key, value] of Object.entries(g))
    if (!NEUTRAL_GENERAL.has(key) && !PARSED_GENERAL.has(key) && /* … */ active(value))
      unsupported.add(`general:${key}`);   // 现状：transparentsorting 为 true 时报 general:transparentsorting
```

**c. 脚本 API 缺口表**（`compile/scriptApi.ts`）：`thisScene.transparentsorting`、`customsortorder` 在缺口表里，脚本用到就报 `script:api:*`。

**d. 模型的网格顺序已按 blending 分了不透明 / 半透明**（`compile/bundle.ts`）
```ts
    const opaque = meshes.map((mesh) => ["normal", "alphatocoverage"].includes(mesh.passes[0]?.blending ?? ""));
```

### 步骤 0 — 实测（`ignore/p5/d4/gen_d4.py`，抓帧 `A:\p5d\sort\`）

透视工程用步骤 0 的骨架（基准相机 eye (0, 0, 10) 看向原点）。对象都是纯色图像层（`kbcolor`，关深度，按颜色认 draw），抓帧后按 RenderDoc 的绘制顺序读出排序：

| 工程 | 摆法 | 要回答 |
|---|---|---|
| `p5d-sort-a` | 不透明 A（z −5）、半透明 B（+2）、C（−8）、不透明 D（+3）、additive E（0）、全半透明网格的模型 M1（−6）、normal 网格的模型 M2（−7）、粒子 P（−4）、半透明 S（存储 z −9，原点脚本返回 +5） | 两遍的划分（normal / additive / 模型 / 粒子）、从大到小的方向、脚本写的 `origin` 是否当帧生效 |
| `p5d-sort-off` | 同上，开关关 | 对照：按 `objects` 顺序 |
| `p5d-sort-rot` | 相机 eye (10, 0, 0) 看向原点；半透明 K（x +3）、J（x −5）、L（x 0） | 前向是哪一轴（预测 J、L、K） |
| `p5d-sort-par` | 分组 G（z +5）下的半透明 F（局部 z −6，世界 −1）、半透明 H（z −3） | 局部还是世界（局部：F、H；世界：H、F） |
| `p5d-sort-eq` | 三个半透明 I1、I2、I3 同在 z −2 | 稳定性 |
| `p5d-sort-fs` | 最前面放 `fullscreenlayer`、`projectlayer`，后面放半透明图像 | −∞ 排最后、两者之间的先后 |
| `p5d-sort-ortho` | 正交场景，开关开，同样的不透明 / 半透明交错 | 正交不排 |

文本对象不测（透视场景里的文本照报 `camera:perspective:text`）。开关绑属性 / 脚本写回、`customsortorder`：语料 0，先看读码；如果要实测，补 `p5d-sort-prop`（运行中改开关）。

**步骤 0 结论（p5-REPORT「步骤 4 步骤 0：透明排序」）**：rea-p5-mesh 4.2 全部成立，「推」的几项也都实测确认了：
- 前向是视线方向（center − eye），键 = 原点 · 前向，从大到小，也就是由远到近；
- 用局部 `origin`，而且是脚本写回之后的当帧值；
- 排序稳定；
- normal 图像、normal 网格的模型在第一遍；translucent / additive 图像、网格全半透明的模型、粒子在第二遍；
- `fullscreen` / `projectlayer` 标志的半透明图像键为 −∞；
- 正交场景、开关关时都按 `objects` 顺序。

### 点 1 — 编译（`compile/bundle.ts`、`compile/features.ts`）
- **新增** `SceneLayer.sortClass?: "opaque" | "translucent" | "last"`，编译期按 WPE 加载时的规则定，之后不变（WPE 在加载末尾置 `+0x120` 的 bit8 / bit9）：
  - 粒子：`translucent`；
  - 图像层（含组合层、文本、形状）：基础材质第一个 pass 的 blending 是 normal / alphatocoverage 时为 `opaque`，否则 `translucent`；模型标志 `fullscreen` 或 `projectlayer` 为真且是 `translucent` 时为 `last`；
  - 模型：任一网格第一个 pass 的 blending 是 normal / alphatocoverage 时为 `opaque`，否则 `translucent`；
  - 不画的对象（分组、灯、声音、相机）不填。
  - 文本、形状按图像层的规则是推断（语料里透视场景的文本照报，形状没有出现在开了排序的场景里）。
- **新增** `SceneGeneral.transparentSorting: boolean`：只认 JSON 布尔。
- **修改** 能力表：`transparentsorting` 是布尔时不报。绑属性、挂脚本时照报 `general:transparentsorting`：WPE 每帧读这一位，但语料 0、没实测，先不做运行中改。`customsortorder` 照报。

### 点 2 — 排序（新增 `render/sortOrder.ts`）
```ts
/**
 * 透明排序（rea-p5-mesh 4.2，p5-REPORT 步骤 4 步骤 0）：先按原顺序画不是半透明的，再把半透明的按「局部 origin · 前向」从大到小稳定排序，
 * `last` 的键是 −∞。`forward` 是视线方向（center − eye，单位向量）；键按 float32 算。
 */
export function transparentDrawOrder<T extends { object: number; sortClass?: SortClass }>(
  layers: readonly T[], state: SceneState, forward: Vec3,
): T[];
```

### 点 3 — 渲染（`render/scene.ts`）
- **修改** `encode` 顶层那一轮：透视场景且 `transparentSorting` 时改成 `transparentDrawOrder(顶层, state, 当帧前向)`，否则逐字不变。前向取当帧透视相机（`setCamera` 记下的帧）的视线方向，带抖动、相机对象、路径。
- 组画子树、模型网格顺序、粒子树先序、被依赖图层（P8 步骤 4）都不另处理：被依赖的图层跟着它自己在新顺序里的位置画，同 WPE。

### 点 4 — 单测
- 编译：各类对象的 `sortClass`（含 additive、alphatocoverage、模型混合网格、`fullscreen` / `projectlayer`、粒子）；`transparentSorting` 的取值；能力表在布尔、绑属性、正交下的报法。
- `transparentDrawOrder`：步骤 0 的 7 组顺序逐个复现（以 WPE 的结果为期望）；键相同时稳定；用当帧状态里的 `origin`；前向任意方向。
- `encode`（假设备）：开关关、正交场景时调用序列与以前逐项相同。

### 实施方式与验收
子代理在 HEAD 的独立工作树里实现。Claude 独立验收：
1. 越界、tsc、vitest、变异。变异包括：不分两遍、键取反、用世界位置、不稳定排序、`last` 不排最后、正交也排、前向取错轴。
2. 语料：只去掉 3 张的 `general:transparentsorting`，不新增键。
3. 画面哈希 10 张 × 三档不变。
4. 真机对 WPE（按日志回放、开 `scripts`，窗口 1600×900）：步骤 0 的 7 个工程整帧逐像素比，FR / CLK 不排除；P5d 步骤 3 走查的 `3453730450-iso-persp`（开着排序）整帧比，预期原来那块 292 像素的差消失。

### 步骤 4 实施记录（2026-11-14）

子代理在 HEAD `9ecaa6fe` 的独立工作树 `ignore/p5/d4/wt` 里实现。改动：
- `compile/bundle.ts`：新增 `SortClass`、`SceneLayer.sortClass?`、`SceneGeneral.transparentSorting?`、`isOpaqueBlending`、`imageSortClass`；模型网格顺序改用 `isOpaqueBlending`，结果不变。
- `compile/features.ts`：`transparentsorting` 是布尔时不报。
- `render/scene.ts`：顶层那一轮的分支。
- `render/sortOrder.ts`：新增，排序纯函数。
- 单测三个：`compile/p5d4.test.ts`、`render/sortOrder.test.ts`、`render/p5d4-sort.test.ts`。

**和计划不一致或计划没写到的：**
- 形状记为 `opaque`：WPE 的形状工厂只调基类构造，加载路径不置 bit8（读码 `factory_14018ff60` 等）。
- 文本无条件记为 `translucent`：构造函数直接置 `0x100`（rea-p6b-layout 1.1）。两者在透视场景都照报，只影响强制渲染。
- 组合层、fullscreen、instanced、带 effect 的图层只看基础材质第一个 pass；effect、colorBlendMode、`copybackground` 不参与。
- `SceneGeneral.transparentSorting` 写成可选，不动约 39 处手写夹具；`compileScene` 总会填。
- 能力表：除布尔外的写法照报，正交场景也照报（保守）。

**验收：**
- 越界只有计划内的文件。
- 工作树：tsc 0 错误，vitest 137 个文件、3256 条全过。
- 变异：子代理 18 处、我 3 处（前向写死、组的子孙进顶层、`last` 进第一遍，`ignore/p5/d4/mutate_d4.py`），全部检出。
- 语料（183 张）：只去掉 3 张的 `general:transparentsorting`，不新增键，能渲染 90 → 90。
- 三方合并进主工作区（基点 `9ecaa6fe`，别的会话在这 3 个文件里有未提交改动，无冲突），两个方向的新增行都在。主工作区 tsc 0 错误，vitest 149 个文件、3456 条全过。
- **真机对 WPE**（开 `scripts` 按日志回放，宿主产物按主工作区构建 index-CLzLasFu.js，全程没被换掉）：
  - 7 个补测工程（窗口 1600×900，FR 日志改成每 10 帧落盘后重录）：实现前，需要排序的 5 组有大片差异。实现后，6 个透视工程都只剩同一块 (1376, 832)–(1472, 896)：那是 CLK，颜色取自光标，而这批日志没记光标；关开关的那组本来也只有这一块。正交那组只有 CLK 加先按场景尺寸画再缩的边缘采样差，和实现前相同。
  - 走查的 `3453730450-iso-persp`（开着排序）：原来那块 292 像素的差消失。剩下 1–7 级的小差是因为录制时 WPE 后处理开着（抓帧里 `1htt` 之后有泛光链的 4 个 draw），按开启档回放后整帧逐像素相同。对照的 `-perspns`（关排序）在两种档位下都是 0 差。
- **没做**：画面哈希没跑成：共享宿主产物这段时间每一两分钟就被别的会话重建，按用户的意见不再抢。10 张基线场景都没开 `transparentsorting`，关闭时的调用序列有假设备单测锁住。「HEAD + 步骤 4」这棵提交树也没有单独跑测试（用户叫停），它的代码和验过的工作树只差 HEAD 新提交带来的那几个文件的改动，三方合并无冲突。

## 收尾（2026-11-14）

P5d 四步（深度与剔除、透视相机、相机对象、透明排序）全部合入后的文档收尾。按用户意见没有新跑测试、没有新抓帧、没有 git 操作（改动留在工作区，未暂存），只汇总已有记录。

改了哪些文档：
- `cocs/wpe/WPE_SCENE.md`：新增一节「透视相机、相机对象与深度（P5d）」（放在 P5c 静态网格之后、P8 之前），含深度与剔除、透视相机、相机对象、透明排序四张规则表，已知差异，语料与解锁，和 WPE 比（确定性工程与真实壁纸复制工程走查），**未实测与照报清单**，对比台；另把早先写「归 P5d」「P5d 实现……时」的 18 处改成现状（能力表的 `camerashake` / `camerafade` / `depthwrite` / `value:animation:camera` 行，P4c 的透视粒子一行与「深度与剔除不在这里」，P5a 的透视抖动、相机 zoom、深度写入、透视视差，P5b 的 `projectlayer` 排序键与「归 P5d」，P5c 的深度缺省、视锥平面、「归 P5d」、解锁说明与范围一句，第 2236 行附近 P10a 的 `value:animation:camera`，加上示例键 `camera:perspective:<用法>`）。
- `cocs/README.md`：WPE_SCENE.md 条目的主题列表加一条 P5d 摘要，适用场景补透视场景退回、相机位置 / 视角、相机对象不生效或选错、深度遮挡 / 剔除、半透明先后顺序。
- `versions/latest/changelog.md`：用户侧一条、开发侧一条（P5d 的四块）。
- `versions/latest/regression.md`：新增「场景壁纸 P5d」一节（D0–D16）。记录里做过的（单测、读码核对、对 WPE 的整帧比较、真实壁纸走查、变异、语料、画面哈希、三张样本在预览里实时渲染）标 `[x]` 并写依据；没做的真机项（预览里目视对比三张透视样本、桌面壁纸窗口、改画布尺寸只重载一次、属性切换相机、真实壁纸里的透明排序）标 `[ ]`。

未实测清单放在 `cocs/wpe/WPE_SCENE.md`「未实测与照报清单」一节（按条目、状态、出处各步汇总），regression 的 `[ ]` 项与它对应。

## 补修：透视相机矩阵逐步 float32（2026-11-15，P13c 走查转来）

P13c 按 FINAL_CHECK 走查 ricepod（复制工程 `ignore/p13/proj/ricepod-iso-sun`，相机来自 `camera.paths`）：每个 draw 的 `g_ViewProjectionMatrix` 与 WPE 差最多 131 ULP（接近 0 的项），`g_EyePosition` 差 1 ULP，`g_ModelMatrix` 0；整帧每帧 529–6288 个像素差 1、7 个孤立像素差 > 2（三角形边上覆盖翻转）。5 个静态相机的 P13c 透视工程和 WPE 整帧 0 差。对应 `phase-f32-matrix.md` 登记的已知差异「`lookAtRH` 仍在 double 里算」「透视的顺序没读」。

### 总体设计思路

透视场景的一帧相机是三段：路径插值出 eye / center / up → `LookAtRH`（`FUN_14019d920`）→ 与反向深度透视（`FUN_14009a360`，内联的 `XMMatrixPerspectiveFovRH`）做仿射乘法。仿射乘法 f32 那一步已经照抄，三段的前两段和投影还在 double 里，而且投影的 sin / cos 用的是 `Math.cos/sin`，WPE 用的是 DirectXMath `XMScalarSinCos` 的多项式近似（11 次 sin、10 次 cos），两者不是同一个函数。这次把三段都改成照汇编逐步 `fround`：结果是确定的 f32 值，和 WPE 逐位相同，静态相机原来 0 差的工程不会变（照抄的值本来就是 WPE 的）。视图向量 `g_ViewForward / Right / Up` 取同一份 f32 的 s、u、f，不再另算一遍。

透视覆盖（`perspective: true` 图层，`FUN_1401e5b60`）与透视粒子 / sprite 那份「去平移的 V」视图投影（`particleViewProjection`）不在这一步：先修三段，再拿 ricepod 第 2223 帧逐 draw 看喷口与 sprite 遮挡方块剩多少，剩下的再按同样方法读码。

### 现状锚点

**a. lookAt 在 double 里**（`render/camera.ts:173`–`228`）
```ts
function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(dot(v, v));                 // 现状：double 平方和与开方
  return length > 0 ? [v[0] / length, ...] : [0, 0, 0]; // 现状：逐分量除；WPE 是先算 1/len 再乘
}
m[12] = -dot(s, eye);                                    // 现状：double 点积
```

**b. 透视投影用 Math.cos / sin**（`render/camera.ts:235`）
```ts
const cot = Math.cos(fovRadians / 2) / Math.sin(fovRadians / 2);   // 现状：不是 XMScalarSinCos
const range = near / (far - near);                                  // 现状：double
m[14] = range * far;                                                 // 现状：double 乘 double 的 range
```

**c. 路径插值是 `a + (b − a)·h`**（`render/camera.ts:78`、`82`）
```ts
return -s * s * s + 1.5 * s * s + 0.5 * s;              // 现状：double 的系数
f(a[0] + (b[0] - a[0]) * h)                              // 现状：WPE 是 Hermite 四项展开（h00·p0 + h10·m0 + h01·p1 + h11·m1）
```

### 步骤 0 — 读码（已做一部分）

- **lookAt**（`0x14019d920`–`0x14019dba2`，已读完）：f = center − eye（逐分量 `subss`）；`len² = (fx² + fy²) + fz²`，`inv = 1/sqrtss(len²)`，f ×= inv（先倒数再乘）；s = f × up 的三项写成 `uz·fy − uy·fz`、`ux·fz − uz·fx`、`uy·fx − ux·fy`，同样 `1/sqrt` 再乘；u = s × f 为 `sy·fz − sz·fy`、`sz·fx − sx·fz`、`sx·fy − sy·fx`；平移 `−((sx·ex + sy·ey) + sz·ez)`、`−((ux·ex + uy·ey) + uz·ez)`、`(fx·ex + fy·ey) + fz·ez`。长度为 0 时 WPE 得 inf·0 = NaN（我们现在给 0 向量），照 WPE 还是保留，实施时定。
- **透视**（`0x14009a360`，已读完、常量已从 exe 读出）：`y = 0.5·fov`，`XMScalarSinCos`（`quotient = trunc(y·0.159154937 ± 0.5)`，`y −= 6.283185482·quotient`，大于 π/2 / 小于 −π/2 时折回、符号 −1；sin、cos 多项式常量 `0x1404925d8` 等 10 个）；`Height = cos / sin`，`Width = Height / aspect`；`range = n / (f − n)`，`m32 = range · f`。哪个参数是 n、哪个是 f 实施时从调用方 `FUN_140183a70` 核对（现在的矩阵对静态工程 0 差，说明 n、f 的位置是对的）。
- **路径插值**（`0x1401894a9`–`0x1401899d2`）：Hermite 四项，eye / center / up 各三分量；顺序用 rea-matrix-order 的符号执行脚本（`symex.py`）出运算树，不靠人工读寄存器。`t` 的除法 `(t − t0) / (t1 − t0)` 是 `divss`。
- **抖动**（`shake_140199580`）：透视的三维抖动加到 eye / center 的顺序，P5d 步骤 2 已按 f32 写，核一遍。

### 点 1 — lookAt、视图向量（`render/camera.ts`）
- **修改** `lookAtRH` / `lookAtVectors`：照上面的顺序逐步 `fround`，两者共用一份 f32 的 s、u、f。

### 点 2 — 透视投影（`render/camera.ts`）
- **新增** `xmScalarSinCos(y)`：逐步 f32 的 DirectXMath 实现，常量按 exe 的位模式写。
- **修改** `perspectiveRH`：Height、Width、range、m32 逐步 `fround`。

### 点 3 — 路径插值（`render/camera.ts`）
- **修改** `stepCameraPath` 的段内插值：按运算树逐步 `fround`；`pathEase` 若不再被用到就删。

### 验收
- 单测：lookAt、`xmScalarSinCos`、`perspectiveRH`、路径插值各加写死期望值的用例（期望值来自 WPE 抓帧里的常量，或按运算树手算，独立于实现）；变异检查。
- ricepod：P13c 的抓帧 `A:\p13c\ricepod-sun-t110-fps20-1920x1080`（帧 2221–2225）与日志，按 P13c 的回放参数（scripts、cursors log、gap split、canvas 1920×1080、ultra）回放；第 2223 帧逐 draw 比 `g_ViewProjectionMatrix` / `g_EyePosition` / MVP，目标 0 ULP；5 帧整帧逐像素相同或差异逐处解释。
- 回归：P5d 的透视工程（`p5d-persp*`、`p5d-path`、`p5d-camp-*`、`p5d-sort-*`）与 P13c 的 5 个静态相机工程按原记录重比，不比原来差。

### 实施记录（2026-11-15）

子代理（Sonnet）直接在工作区改 `render/camera.ts`（P6c 在同一文件里未提交的 `OrthographicCameraFrame.zoom` 两处没碰），Claude 独立验收。读码与符号执行（路径段 `prep_path.py` + rea-matrix-order 的 `symex.py`）由 Claude 做，公式照抄给子代理。
- **lookAt**：新增内部 `lookAtF32`，`lookAtRH` 与 `lookAtVectors` 共用；长度为 0 时照 WPE 得 NaN（以前给 0 向量），`camera.test.ts`「up 与视线平行」一条的期望由 0 改成 NaN。
- **投影**：新增导出 `xmScalarSinCos`（DirectXMath，13 个常量按 exe 位模式），`perspectiveRH` 的 Height / Width / range / m32 逐步 `fround`。调用方 `0x140183edf` 核对了参数：第 5 个是 nearz（`G+0x14c`）、第 6 个是 farz（`G+0x150`）。
- **路径**：新增 `hermiteComponent`（运算树原样，切线 (p1 − p0)·0.5、`(p0 − p0)·0.5` 照写不化简），`s = f(f(t − t0) / f(t1 − t0))`；zoom 分量与状态推进不变（`pathEase` 只剩 zoom 与旧测试在用）。我给子代理的提示把切线误写成多乘一次 0.5，子代理按旧测试发现并改对。
- **测试**：新建 `render/p5d-f32-camera.test.ts`（常量、sin/cos 10 组、lookAt、投影、路径，期望写死、来自独立参考实现）；Claude 补「斜相机 16 项」与「near 0.3 / far 777.7 的 m32」两条，用来区分逐分量除、平方和不取 f、m32 用 double。
- **变异**（`ignore/p5/pb/mutate_cam.py`，按原字节还原）：归一化逐分量除、平移点积换序、平方和不取 f、投影改回 `Math.cos/sin`、sin 少一项、去掉折回分支、m32 用 double、路径改回 lerp、路径加法换序，9 个全被抓住（补两条用例前 3 个没抓住）。
- **检查**：提到透视 / 相机的 66 个测试文件里只有 `dev/probe.renderSize.test.ts`、`dev/probe.scripts.test.ts` 共 10 条失败，原因是 P13c 未提交的 `dev/probe.ts` 调了 `scene.spriteSamples`、测试的假场景没有它，与本次无关；tsc 只剩 `uniformInverse.test.ts` 两条（别的会话）；Prettier 通过。
- **ricepod**（`buildSceneHost.ts` 重建产物 `index-CIjvFYbC.js`；图 15090 是 P13c 导入的、用完没移除）：按 P13c 参数回放 2221–2225 帧。第 2223 帧逐 draw：skybox、orbit、船体、三个喷口、sprite 遮挡方块的 `g_ViewProjectionMatrix` / `g_ModelViewProjectionMatrix` / `g_EyePosition` 全部 0 ULP（改前最多 131 ULP）。sprite 遮挡方块的 `g_ViewUp` 剩 1 ULP（改前 163），WPE 那份是按 sprite 尺寸缩放过的向量，归 P13c；e162 那行的 `g_ViewUp` / `g_ViewRight` / `g_Alpha` 大差改前就有，是配对问题。整帧：第 2221 帧逐像素相同；2222 只有 4 个 alpha 像素；2223 一个像素差 1；2224 有 132 个像素差 1、集中在 x 1146–1315、y 469–766；2225 三个像素差 1。没有差 > 1 的像素（改前每帧 529–6288 个、最大 48）。
- **回归**（P5d 步骤 2 的抓帧与日志，`ignore/p5/pb/regress_d.py`，屏蔽 FR / CLK）：`p5d-path` w1 第 41–43 帧、w6 第 142–144 帧，`p5d-persp`、`p5d-persp-b`（静态相机，日志不到抓帧那帧，按帧号推时刻），`p5d-tilt`（斜相机）第 197–199 帧，全部逐像素相同。P13c 的 5 个静态透视工程没重跑（同类的 `p5d-persp*` 已覆盖）。测试工程 15091–15094 已移除。
