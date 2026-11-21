# 场景壁纸：puppet 与骨骼动画

> [场景壁纸文档](../WPE_SCENE.md) 的一章：puppet、挂点 / 变形 / 裁切、模型骨骼、动画层脚本 API、骨骼物理、建删层、绘制顺序、局部骨骼（P12）。总体形态、各阶段状态与全部章节的索引在总览里。

## puppet 与骨骼动画（P12a）

puppet 在 WPE 里是图像层的一种画法，不是新的对象种类。图像层的模型 JSON 写了 `puppet: <mdl>` 时，WPE 用 mdl 的网格 0 代替图层上屏的四边形，每帧推进动画层、求出骨骼姿势，画的时候把蒙皮矩阵交给着色器的 `g_Bones`；着色器、材质、effect、合成 RT 都还是图像层那一套。所以我们不建新的图层类型，只给图像层加三样东西：puppet 数据（`SceneLayer.puppet`）、一个每帧求姿势的运行时、一种上屏几何 `"puppet"`。模型对象（P5c）上的骨骼不在这一节（`3706286085`，随 P13 接线）。

依据：读码 [rea-p12-mdl](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12-mdl.md)、[rea-p12-runtime](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12-runtime.md)；实测 [p12-REPORT](../../../.claude/plans/wpe-import/3-scene/phase12/p12-REPORT.md)；计划、实施记录与走查见 [phase-12a-mesh-animation.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md)。挂点、变形、脚本与骨骼物理（P12b–d）见 [总计划](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12-puppet.md)。

| 层 | 位置 | 做什么 |
|---|---|---|
| mdl | `compile/mdl.ts`（`parseMdl`） | 在 P5c 的基础上读出 `MDLS` v1–v4（骨骼父链、局部矩阵、可选的绑定姿势矩阵）、`MDLA` v1–v6（动画、轨道、事件）、可选块 2（绘制组）与 v23 记录表；`MDLE` 跳过（图像层的加载、更新、绘制都不读它）。段没恰好读到段末时记进 `sectionIssues`，不置 `truncated` |
| 整理 | `compile/puppet.ts`（`buildPuppet`） | 网格 0、骨骼、静止姿势（`MDLS` v ≥ 2 的可选矩阵，没有时用局部矩阵）、转好四元数的轨道、动画层（`animation` 在 `MDLA` 里找不到的整层丢掉，字段缺省照读码）与字段的属性绑定，以及细分键 |
| 接线 | `compile/bundle.ts`（`compileImageModel`、`finalizePuppet`）、`compile/features.ts`、`compile/bindings.ts` | 图像层读模型 JSON 的 `puppet`；effect 编完后定上屏路径；有骨骼时组合键加 `SKINNING` 与 `BONECOUNT`；`g_Bones` 进引擎 uniform 表；动画层字段绑用户属性时登记成就地目标 `animation-layer` |
| 运行时 | `puppet/pose.ts`、`puppet/player.ts`（`ScenePuppets`）、`puppet/math.ts` | 纯 TS，逐步 `Math.fround`，Node 单测、dev 探针、宿主共用。每个动画层一个 P10 的 `AnimationClock`；采样、三种混合、淡入淡出、父链；蒙皮矩阵 K = 世界 · 绑定姿势的逆，每根骨骼 12 个数（K 的 4 行 × xyz，和 WPE 的 `g_Bones` 同序） |
| 渲染 | `render/graph.ts`、`render/scene.ts`、`render/puppet.ts` | 上屏步骤的几何 `"puppet"`，网格缓冲与顶点布局复用 P5c；每帧在 `update` 里把蒙皮矩阵写进 `g_Bones`。翻译器把 `g_Bones` 出成普通 uniform 块里的 `array<mat4x3<f32>, N>`（每项 64 字节，WGSL 第 c 列就是 K 的第 c 行），12 个数原样写、不转置；WPE 是单独的 b2 缓冲、每项 48 字节，数据相同 |
| 宿主 | `host.ts`、`render/renderer.ts` | 加载时新建 `ScenePuppets`，重编译时按 `(对象下标, 动画层下标)` `carryOver` 接回时钟，建 GPU 资源前先 `refresh` 一次（不闪绑定姿势）；实时帧在粒子与相机之前调 `stepPuppets`（P12b1 起先于粒子） |

**规则**（读码与实测）：
- **两条上屏路径**，编译期定：
  - 合成：图层有 effect、`colorBlendMode` 不是 0 / 31、或被依赖时，WPE 加载时就走合成。基础 pass 用不带 puppet 组合键的基础材质画四边形进合成 RT（按图像尺寸），effect 全部留在合成链；最后用 P8 的 passthrough 材质加 puppet 组合键与 `BLENDMODE`，以 puppet 网格采样合成 RT 上屏，UV 不缩放，`g_Color4` 置 1。
  - 直接上屏：基础材质的第一个 pass 加 puppet 组合键画网格（稳定键同基础 pass，常量、属性绑定、关键帧共用），UV 乘「图像宽高 / GPU 纹理宽高」（DXT 纹理会缩放，FreeImage 纹理比例 1），不内缩（`scaledPuppetVertices`）。
  - 只画网格 0；顶点坐标是图层局部像素，不按 `size` 缩放。静态 puppet（没有 `MDLS`）不加组合键、不进运行时。
- **`BONECOUNT`** 等于真实骨骼数，不取 2 的幂（和模型路径不同）。
- **时钟**：和 P10 关键帧同一个函数，每帧 `t += rate · dt`（float32），模式（`loop` / `mirror` / `single`）在 `MDLA` 的动画记录里，帧号 `t / spf`。`visible` 为假的动画层时钟不走，也不参与混合。
- **采样与混合**：平移、缩放线性插值，旋转按最短路径 nlerp；按层序逐层叠，有覆盖、权重、加法三种，权重和不归一化；淡入时长 `min(D/2, blendtime)`，非 `single` 只淡一次，淡出只在 `single` 有效。
- **绘制组**：没有绘制顺序轨道时保持文件顺序，可选块 2 只解析、不起作用。有轨道时的重排见「puppet 绘制顺序（P12f）」。
- **一帧里的位置**：和粒子在同一个对象更新循环里，在相机 / 关键帧 / 脚本之前；P12b1 起改在粒子之前（按 `objects` 顺序，挂点上的粒子读本帧姿势）。用户属性在两帧之间写进状态，当帧生效；脚本写回晚一帧（实测 K+0 / K+1）。图层隐藏时照样推进，壁纸暂停时冻结，补画的帧不推进。
- **动画层字段**：`rate`、`blend`、`visible` 绑用户属性时就地改，不重编译。

**能力表**：去掉 `model:puppet`、`object:animationlayers`。P12a 不做、照报的细分键：
- P12b：`object:attachment`、`puppet:alpha`（网格 0 标志 bit2 → `SKINNING_ALPHA`）、`puppet:morph`（格式含 `a_PositionVec4`）、`puppet:clipping`（v23 记录）、`puppet:texture-channels`（任一网格标志 bit1）；
- P12c：`puppet:layer-script`（动画层字段挂脚本，脚本里的 `thisObject` 是动画层）；
- P12d：`puppet:physics`（骨骼 JSON 满足 `(r ‖ t) && (se ‖ re)`）；
- 绘制顺序轨道：`puppet:draw-order`（动画带绘制顺序轨道且网格 0 有 bit3，1 张，同场景还有别的键；P12f 起支持）；
- 语料 0 处：`puppet:ik`、`puppet:animation-ref`、`puppet:index32`、`mdl:animation:tracks`、`mdl:animation-id`、`mdl:section:<标签>`；
- 会让 WPE 崩溃的组合照报、不照抄：`puppet:alpha-track`（有骨骼透明度轨道、网格 0 没有 bit2，实测崩溃）、`puppet:order-track`（有绘制顺序轨道、没有 bit3，读码推断）、`mdl:skeleton:bones`（骨骼数 > 128，WPE 终止进程）。

**走查**（FINAL_CHECK，2026-11-14，报告 `ignore/p12/a/final/report.txt`）：
- 5 个生成工程（`p12-modes` / `-fade` / `-mix` / `-fx` / `-fx2`，窗口与场景同为 1920×1080）各 8 帧，整帧逐像素相同（含 FR、CLK），覆盖直接上屏（DXT、非 2 的幂、静态）与合成路径。
- 真实壁纸复制工程（`kbp content isolate`）：`3354366708`、`3203778110` 6 帧逐像素相同（后者用和场景同尺寸的 3840×2160 无边框窗口）；`2896608544` 每帧几十到几百个像素差 ≤ 2 级，输入除 `g_Bones` 外逐位相同，差异是顶点位置在 1e-4 像素量级上的舍入，一部分已证实来自 `rsqrtps`；`3409595232`、`3828324728`、`3814576310` 解释到 draw 级，`g_Bones` 逐位相同或在 `rsqrtps` 量级。
- 10 张解锁的场景整张能画，没有不支持项、没有退回，脚本 `init` 全部成功。
- 走查里发现两处不属于 P12a 的问题，已转给 P7：单级 mip 的文件纹理没开各向异性（`3811769317` 的 cloudmotion 边缘差到 204 级）；waterwaves 输出的零星 1 级差缩到翻译出的着色器算术。

**已知差异与只记不补**：
- **`rsqrtps`**：WPE 归一化四元数用 `rsqrtps` 硬件近似加一次牛顿，我们用精确倒数平方根加同一次牛顿。骨骼旋转差 1 ulp 量级，乘上上千像素的绑定平移后，平移分量差 1e-4 量级；单位旋转 WPE 是 0.9999995，我们是 1.0。硬件表随 CPU 变，不复刻（同 P4「近似倒数不复刻」）。
- **窗口与场景不同尺寸**（2026-11-19 方案 A 起产品也按窗口画，这一项不再有）：WPE 按窗口建投影直接画，当时产品按场景画再上屏。只差高度、缩放正好为 1 时（4K 屏上 3840×2160 被压成 3840×2130）也会有 ≤ 2 级的差和偶发的边缘覆盖翻转；泛光链 RT 的尺寸同理。是已登记的分辨率差异的特例。dev 探针按窗口尺寸画时没有这一项：3840×2130 窗口那组复制工程重跑后 `3203778110` 只剩第 280 帧 32 个像素差 1（`rsqrtps`），`2896608544` 每帧 178–1990 个 ≤ 2 级，和走查时「只换骨骼」的预测同量级（[phase-render-size](../../../.claude/plans/wpe-import/3-scene/phase-render-size.md)「步骤 2」）。
- **写死不可见的 effect**：编译期不进 effect 列表，判合成路径时不算；WPE 的 effect 个数可能不同。语料里没有「puppet 的 effect 全部写死不可见」的。
- **精灵表与纹理通道**：WPE 也会让它们走合成路径；它们本来就在 `tex:animation` / `puppet:texture-channels` 下照报。
- **性能**：一张场景最多 21 个 puppet、单个最多 86 根骨骼，每帧在 CPU 上采样、混合、算矩阵，可见与否都算。

**语料**（192 张，2026-11-14）：能渲染 100 → 110，解锁 `2896608544`、`3203778110`、`3351072238`、`3354366708`、`3409595232`、`3811769317`、`3813473025`、`3814576310`、`3818986268`、`3828324728`；去掉 `model:puppet` 36 张、`object:animationlayers` 32 张，新增的只有细分键（`puppet:alpha` 6、`puppet:layer-script` 5、`puppet:physics` 5、`puppet:clipping` 4、`puppet:morph` 2、`puppet:draw-order` 1、`puppet:texture-channels` 1），别的场景逐张不变。其余 26 张还差挂点、光标与媒体回调、`getAnimationLayer` 等（P12b、P12c、P6c、P11）。

**dev 探针**：`renderFrame` 有 `particles.dts` 时 puppet 沿同一串 dt 从第 1 帧推进（P12b1 起在粒子之前、相机之前，同渲染器），没有时按 `time` `seek` 再按当前状态 `refresh`；没有 puppet 图层时不建，调用序列和以前逐字节相同。逐 draw 轨迹（`trace`）里 puppet 的 draw 带 `g_Bones`，可以按 MVP 配对 `kbp rdc consts` 导出的 WPE 常量逐分量比。

## puppet 的挂点、骨骼透明度、变形与裁切（P12b1）

P12b1 在 P12a 的 puppet 上再接四样东西，四样都是 WPE 图像层 puppet 的一部分：
- 挂点：子对象挂在父 puppet 的骨骼上；
- 骨骼透明度（`SKINNING_ALPHA`）；
- 顶点变形（`MORPHING`）；
- 裁切遮罩：mdl v23 的记录表。

数据仍全部在编译期（Worker）定好，`ScenePuppet` 多四个字段：`attachments`、`boneAlpha`、`morph`、`clipping`。运行时 `src/puppet/` 仍是纯 TS，`ScenePuppets` 多交出三样：`pose`、`boneAlpha`、`morph`。渲染侧多四样：
- 每帧多写几个 uniform；
- 每个变形 puppet 一张变形纹理；
- 全场共用一张半分辨率 R8 遮罩 RT；
- 一份照 WPE 缓存戳的世界矩阵影子（`render/worldStamps.ts`）。

纹理通道与模型对象的骨骼归 P12b2。

依据：读码 `ignore/p12/b/rea/clip-morph-attach.txt` 与 [rea-p12-attach-physics](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12-attach-physics.md) 第 1 节；计划、实测与走查见 [phase-12b-attach-morph-clip.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12b-attach-morph-clip.md)。

| 层 | 位置 | 做什么 |
|---|---|---|
| mdl | `compile/mdl.ts` | 读 `MDAT`（挂点：名字、骨骼、64 字节矩阵）、`MDMP`（每网格的变形：缩放、变形顶点数、目标的 i16 位置差与 bit12 时的透明度）、动画的每骨骼透明度轨道与每目标权重轨道 |
| 整理 | `compile/puppet.ts` | 组合键：网格 0 标志 bit2 → `SKINNING_ALPHA`，格式含 `a_PositionVec4` → `MORPHING`（不看有没有目标）；变形纹理在编译期打好；裁切命令表（照 `FUN_14020b720`） |
| 运行时 | `puppet/pose.ts`、`puppet/player.ts` | 透明度与变形权重的三种叠法；变形上传的取舍与排序（`morphUniforms`）；`pose` 交出模型空间骨骼矩阵给挂点 |
| 接线 | `compile/bundle.ts`（`resolveAttachment`）、`compile/features.ts` | 挂点在编译期解析成 `{ 父, 骨骼, 矩阵 }`；放行表加 `g_BonesAlpha` / `g_MorphOffsets` / `g_MorphWeights` 与两个组合键；遮罩 pass 另有放行表 `PUPPET_CLIP_MASK_UNIFORMS`（`g_RenderVar0`） |
| 渲染 | `render/layout.ts`、`render/scene.ts`、`render/graph.ts`、`render/puppet.ts`、`render/worldStamps.ts` | 世界矩阵的挂点钩子；变形纹理与遮罩 RT；puppet 上屏按裁切命令拆成多次绘制；挂点子树的绘制矩阵按缓存戳 |

**挂点**：
- 子对象的世界矩阵 `W = W_父 · ((Pose[骨骼] · Att) · L)`：
  - `W_父` 是父的基类世界矩阵，不含对齐偏移；
  - `Pose` 是父 puppet 本帧动画之后的模型空间骨骼矩阵；
  - `Att` 取自 mdl。
  
  `worldMatrixOf` / `drawMatrixOf` 多一个钩子，图像、粒子、文本、分组子对象都经它。
- 挂点只在这几个条件都满足时成立，否则按普通父子，不报键：
  - `attachment` 是字符串；
  - 父有蒙皮 puppet，且在 `objects` 里排在子前面；
  - 父 mdl 的 `MDAT` 里有同名项（区分大小写，取第一个）。
- 挂点子树每帧标脏重算（姿势每帧变）。
- **帧里的顺序**：WPE 的对象更新循环按 `objects` 顺序跑，所以 puppet 改在粒子之前推进，挂点上的粒子读本帧姿势；这对 P12a 中性，走查复核过。
- **父被脚本或关键帧动画移动时**（B1，`p12-lag` 实测）：WPE 的世界矩阵函数（`FUN_1401850a0`）带缓存，每个对象记一个戳（帧号），命中时不重新记戳。挂点对象要求戳等于本帧号，所以在更新循环里每帧重算。渲染时被写过的祖先先画、重算后戳也是本帧号，挂点对象就判成缓存有效，于是：
  - **晚一帧**（用更新循环里的值：祖先的变换是上一帧的，姿势是本帧的）：
    - 挂点的 puppet，有没有动画层都算；
    - 挂点的局部空间粒子的绘制；
    - 它们的子孙。
  - **不晚**：
    - 挂点的图像；
    - 不挂点的 puppet（更新时命中、渲染时因为父的戳更新而重算）；
    - 自己的变换也被写的对象。
  - 世界空间粒子的绘制不乘 `W`。
  
  `render/worldStamps.ts` 照读码移植这个缓存，跨帧保留戳，在两个时刻求值：
  - 更新阶段（`stepParticles` 开头）：蒙皮 puppet 与粒子层各一次；
  - 渲染阶段（`drawPhase`，脚本之后）：画出来的对象各一次，都按 `objects` 顺序。
  
  变换写入（`SceneState.takeTransformWrites`）在下一个求值时刻之前清戳。结果只用于挂点子树的绘制：预置进脚本之后那次 `sync` 的世界矩阵缓存。别的对象照旧现算，没有挂点的场景不建影子。

**骨骼透明度**：
- 每帧先全置 1，再按动画层逐层叠：
  - 覆盖：`lerp(lo, hi, f)`；
  - 混合：`lerp(cur, v, w)`；
  - 加法：`clamp(cur + (v − 1)·w, min(cur, v), max(cur, v))`。
- 轨道标志 `flags & 3 == 1` 的骨骼跳过。
- 直接上屏、合成上屏、裁切的遮罩段与目标段都写 puppet 自己的 `g_BonesAlpha`。

**变形**：
- **纹理**：`side = ⌊√(目标数·nv + 1)⌋`，不够再加 1；纹素 0 = (0, 0, 0, 1)；目标 t 的第 v 个变形顶点放在 `1 + t·nv + v`；网格 0 没有 bit12 时只有纹素 0。格式一律 `rgba32float`，值为 `max(c / 32767, −1)`，要 `float32-filterable`，没有时报 `render:morph-texture`。不用 WPE 的 `rgba16snorm`：它在 Dawn 上只能当 unfilterable 采样，翻译出的着色器用不了。
- **权重**：每帧清 0；生效条件是 `|v| ≥ FLT_EPSILON`，负权重也算生效。三种叠法：
  - 覆盖：生效时写值，不生效清位；
  - 混合：总是 `lerp(cur, v, w)`；
  - 加法：`a = v·w`，`max(min(cur, a), min(max(cur, a), cur + a))`。
- **上传**（`FUN_14020cff0`）：按目标号升序取前 11 个生效目标，按带符号权重稳定降序；`g_MorphOffsets = [n, t·nv, …]`，`g_MorphWeights = [缩放, w, …]`。
- 合成路径的上屏用 puppet 自己的值。读码推断是「残留」，步骤 0b 实测推翻了。

**裁切遮罩**：
- **命令表**：编译期按组表顺序建一份（加载时不排序）；P12f 起绘制顺序轨道重排之后按当前顺序重建，见「puppet 绘制顺序（P12f）」。普通组（含遮罩组本身）累积成普通段；走到某条记录的末遮罩位置时，先落普通段，再发射这条记录：遮罩段 + 目标段，一条记录的多个 `list1` 组合成一个目标段。遮罩段 = 首末遮罩位置之间的全部位置减去本记录的目标，夹在中间的普通组也画进遮罩，在 0 处擦掉。每段一份 u16 索引。
- **遮罩 RT**：全场一张 `r8unorm`，场景目标宽、高各整除 2。WPE 是后备缓冲的一半；2026-11-19 起产品的场景目标就是画布（`tile` 与旧画法时是场景分辨率），两边一致。每条记录先清 0 再画。
- **遮罩 pass**：`clippingmaskimage4`，缺省剔背面（顺时针网格的遮罩会被整片剔掉，WPE 一样）。槽 0 同普通段（直接上屏是反照率，合成路径是合成 RT），槽 1 是 `materials/masks/clipping_mask_*.tex`（在 `scene.pkg` 里），槽 5 是变形纹理；`g_RenderVar0.x = 0`。
- **目标 pass**：基础材质的着色器加 `CLIPPINGUVS` + `CLIPPINGTARGET`，`g_Texture8` 是遮罩 RT（线性、钳制）。混合固定 translucent，不用基础材质的 blending。
- 带 effect 的 puppet 走同一套命令，槽 0 换成合成 RT。

**能力表**：去掉 `object:attachment`、`puppet:alpha`、`puppet:morph`、`puppet:clipping`，`attachment` 改为中性。新增语料 0 处的照报键：
- `puppet:morph:modifiers`（bit13）；
- `puppet:clipping:flags`（记录标志非 0）；
- `puppet:clipping:nested`（遮罩被另一条记录裁切）；
- `puppet:clipping:groups`。

会让 WPE 崩溃的组合照旧照报，生成测试工程时也不要做：
- 有透明度轨道、网格 0 没有 bit2；
- 有绘制顺序轨道、没有 bit3；
- 记录下标越界；
- 骨骼数 > 128。

**走查**（FINAL_CHECK，2026-11-15，报告 `ignore/p12/b/final/report.txt`、`ignore/p12/b/lag/report.txt`）：
- **生成工程全部逐像素相同**：
  - `p12-am`（透明度与变形的三种叠法）、`p12-att`（挂点，含粒子子对象）；
  - 两版裁切工程（`p12-clip2` 覆盖单条记录、共用遮罩、一条记录多组、遮罩之间夹普通组、合成路径、透明度 + 变形 + 裁切）；
  - P12a 的 5 个工程，换序之后。
- **6 张解锁场景的复制工程**：差异全部 ≤ 2 级，逐 draw 解释为 waterwaves 的零星舍入与 `rsqrtps`；变形值、透明度、挂点矩阵在不移动父的样本里逐位相同。`2964778792` 有两帧各 1 个像素 1 级没能定位。
- **`p12-lag`** 核对了「父被移动」的 16 种组合，就是上面的规则。修之后 16 个对象的 MVP 与 WPE 逐位相同，整帧逐像素相同。`3491865410` 的父移动变体（`clipmove`）从最大 241 级降到 ≤ 2 级。

**已知差异与只记不补**：
- **`rsqrtps` 传到挂点**：父 `Pose` 的末位差原样传给挂点子对象，`3253330537` 右手的 MVP 差 64 ulp。
- **遮罩 RT 的分辨率**：随场景而不是窗口，窗口与场景不同尺寸时会不同。属于已登记的「WPE 按窗口分辨率画」。
- **缓存戳的求值时刻**：只建模更新与渲染两个时刻。WPE 在光标命中、相机对象、灯光取世界矩阵时也会记戳，这些没建模。绘制顺序按 `objects`，不看透明排序与组的子层顺序。首帧与「同帧属性和脚本都写同一个祖先」的例外只在影子里算，不用于不挂点的对象。
- **没接挂点钩子**（语料都没有这种组合）：光标命中（`cursor.ts`）、相机对象、`particles/track.ts` 的加载期静态世界矩阵；平面反射 pass 对带裁切的 puppet 只画目标段。
- **性能**：挂点子树每帧刷新两次，帧时间没量。

**语料**（2026-11-15，提交前后的快照各扫一遍）：233 个工程能渲染 156 → 162（提交时的 226 个工程口径 151 → 157）。去掉 `object:attachment` 13 张、`puppet:alpha` 9 张、`puppet:clipping` 5 张、`puppet:morph` 3 张，没有新增的键。解锁：
- `3463520581`、`3829467967`（挂点）；
- `2964778792`、`3500648585`（透明度）；
- `3491865410`（挂点 + 裁切）；
- `3253330537`（挂点 + 加法透明度 + 负权重变形 + 合成路径变形）。

别的场景逐张不变。还差 P12c / P12d 的：
- `3426865175`（物理）；
- `3830665420`（动画层脚本）；
- `3346715292`（动画层脚本 + `getAnimationLayer`）。

## 模型对象的骨骼与纹理通道（P12b2）

P12b2 有两样东西，在 WPE 里走两条不相干的代码路径：
- 模型对象（P5c）带骨骼、动画、变形、挂点；
- 图像层 puppet 的纹理通道。

依据：
- 读码 `ignore/p12/b/rea/texchan-model.txt`；
- 实测 `ignore/p12/b2/meas/report.txt`，读码的各项全部成立；
- 计划与记录见 [phase-12b2-texchan-model.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md)。

### 模型对象的骨骼（P12b2-1）

WPE 的模型更新和图像层 puppet 用同一组时钟、采样、混合、蒙皮函数（实测逐位相同），所以运行时复用 `src/puppet/`。`ScenePuppets` 的每个运行时带一个模式 `"image" | "model"`，下面几处按模式分支；宿主与探针都经 `puppetEntries` 建立，模型不会漏。

| 规则 | 图像层 puppet | 模型 |
|---|---|---|
| 更新门 | 隐藏照推进 | 对象或父链不可见时整段跳过、时钟冻结；看的是推进那一刻的可见性，即上一帧脚本写下的。重新可见的第一帧照画，但那一帧的更新已被跳过 |
| 权重 0 的层 | 照常参与 | 整层跳过，时钟照推进；全部跳过等于没有层，局部矩阵直接用 MDLS 局部矩阵、不经分解 |
| 静止姿势 | MDLS 可选矩阵优先 | 只用 MDLS 局部矩阵 |
| 标量轨道 | 透明度、变形（网格 0）、纹理通道 | 只有变形，按网格 |
| 变形权重 | 覆盖 `\|v\| ≥ ε` 置位；混合不钳 | 覆盖 `\|v\| > ε` 置位、不钳；混合钳 [0, 1]、`\|v\| > ε` 时置位；加法同式（夹在 [min(cur, d), max(cur, d)]） |
| 剔除盒 | — | 可见层（不看权重）动画包围盒的并，至少一个有效（max.x > min.x）才用，否则 mdl 包围盒；MDLA v < 5 的动画按全 0 盒子并进去 |

- **组合键**（每网格，只在 mdl 有骨骼时加）：
  - `SKINNING` = 格式含 `a_BlendIndices` ? 1 : 0（0 也写）；
  - `BONECOUNT` = `min(128, pow2ceil(max(16, n)))`；
  - `MORPHING` = 网格有 MDMP 目标；
  - `MORPHING_NORMALS` = 网格标志 bit10。
- **`g_Bones`**：每个对象一份，所有网格共用，写前 n 根。
- **变形**：
  - **纹理**：每网格一张 `rgba32float`（同 P12b1，值 `max(c / 32767, −1)`）。内容是 WPE 的 i16 分量流，按「目标 → 顶点 → 位置 xyz（bit10 时接法线 xyz）」紧排；边长 `floor(sqrt(ceil(3K / 4)))`，不够加 1。
  - **uniform**：按目标号取前 11 个生效目标，再按权重降序。
- **挂点**：子对象可以挂在模型骨骼上，矩阵来源是模型空间骨骼矩阵（没有层时是绑定姿势）。B1 的缓存戳影子把带骨骼的模型放进更新阶段。
- **和 WPE 有意不同**（语料不依赖，2026-11-15 用户定「语料依赖的缺陷才复现」）：
  - **偏移**：WPE 的变形偏移用最后一个变形网格的顶点数，我们用各网格自己的。多个变形网格顶点数不同、且有 t ≥ 1 的目标权重非 0 时才不同。
  - **缩放与权重**：WPE 按「不透明在前」排序后的绘制记录下标取，我们按真实网格下标。有半透明网格排在不透明网格前面时才不同。
- **能力表**：
  - 去掉模型上的 `mdl:skeleton` / `animation` / `morph` / `attachment`、`object:animationlayers`、`mdl:flags:0x400`；模型上的 `MDLE0002` 中性（模型不读它）。
  - 照报（语料 0 处）：`mdl:morph:tangent`（bit11）、`mdl:morph:vertices`（MDMP 的 nv ≠ 网格顶点数）、`model:rootmotion`。
  - 动画层字段的 `rate` / `blend` / `visible` 挂脚本 P12c 起支持（见「puppet 动画层的脚本 API」），物理骨骼照报 `puppet:physics`（P12d）。

### 纹理通道（P12b2-2）

- **判定**：图像层 puppet 是 skinned 的，第一个标志 bit1 的网格是纹理通道网格。有它就强制走合成路径（UV 不缩放）。
- **绘制**：在合成 RT 里画完基础四边形之后，用通道网格自己的材质再画一次（几何 `"texchan"`）：
  - 材质加 `BLENDROWCOUNT` = 网格多读的 u32 的低字节，`DOUBLEBUFFERED` 照纹理组合键规则；
  - MVP 是合成 RT 的 `ortho(0, W, 0, H)`，模型矩阵是单位阵（WPE 是 `diag(1/s, 1/s, 1, 1)`，我们的 s 恒为 1）；
  - `g_Color4` 与基础四边形相同。
- **`g_BlendMap`**：每个 puppet 一份 16 个 float，初值 0，**帧首不复位**。可见层按 MDLA v≥3 的通道轨道写（第 i 条写第 i 个 float，超出 16 的丢掉，WPE 会越界）：
  - 覆盖：`lerp(lo, hi, f)`；
  - 混合：`lerp(cur, v, w)`；
  - 加法：`cur + fround(v·w)`，不钳制，会一直涨。
  
  只在推进时写，重编译时保留；上传取前 `4 × BLENDROWCOUNT` 个。`DOUBLEBUFFERED` 下全 0 时通道片元全被 `clip` 掉。
- **照报**：预光照（基础材质带 LIGHTING / REFLECTION 且走合成）`puppet:texture-channels:prelighting`；不是 skinned 的 puppet 带 bit1 网格仍报 `puppet:texture-channels`。

### 走查

- **生成工程**用步骤 0 的同一份 WPE 抓帧：
  - `p12b2-mdl` / `mdl2` / `vis` / `att` / `cull` / `rest` / `deimos` 整帧逐像素相同；
  - `g_Bones` 逐位相同或只差 `rsqrtps`（K2，模型和同层的图像层 puppet 差得一样）；
  - `p12b2-morph` 只在两处有意不同的 3 个 draw 上不同，数值是正确做法。
- **复制工程 `3706286085`**（只留模型，雾与阴影关闭，脚本字段换成固定值）：
  - 61 个带骨骼的 draw 矩阵逐位相同，组合键与变形 uniform 相同；
  - 城市边缘的细碎差是 K2 被 −161200 的绑定平移放大；
  - Sonic 手套、鞋、扣子的颜色差是 `generic4` 的 PBR 遮罩少了 emissive 那一项，与骨骼无关、属材质（F1，已转 P7，证据 `ignore/p12/b2/check1/F1-emissive.md`）。
- **纹理通道**：
  - `p12b2-tc` 8 帧整帧逐像素相同；
  - 10 个 puppet 的 `g_BlendMap`（含加法层的累加值）、通道 draw 的 MVP 与 `g_Color4` 逐位相同；
  - 合成 RT 在基础 pass 后、通道 pass 后都 0 差。
  - `3811424158` 的 `01_z`：通道 draw 存在、`g_BlendMap` 全 0、合成 RT 前后不变，同 WPE。它的合成 RT 是整张精灵表大小（WPE 是单帧），属精灵表还没支持的连带。
- **不变**：P12a、P12b1 与 P12b2-1 的生成工程在两半之后都和之前逐字节相同。

**语料**：不解锁任何场景。
- `3811424158` 只剩精灵表帧动画（`combo:SPRITESHEET`、`tex:animation`）。
- `3706286085` 只剩 P13 的雾与方向光阴影、挂在模型下的点光（`object:parent`）与动画层脚本（`puppet:layer-script`，P12c 已支持）。
- `3662790108` 还差预光照、透视文本等十几项（2026-11-20 起能渲染：预光照 P13j、透视文本 P13h，剩下的 9 个缺材质是 `scene.pkg` 查找区分大小写，见 [COMPILE.md](COMPILE.md)「`scene.pkg`」）。

## puppet 动画层的脚本 API（P12c）

脚本拿到 puppet 的动画层并控制它：`getAnimationLayerCount` / `getAnimationLayer`、`IAnimationLayer`、动画层字段上的脚本、`addEndedCallback`、MDLA 事件。

依据：
- 读码 [rea-p12-attach-physics](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12-attach-physics.md) 第 4 节、[rea-p12c-script](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12c-script.md)；
- 实测 p12-REPORT 用例 9（`p12-script`）；
- 计划与记录见 [phase-12c-script.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12c-script.md)。

### 分层

- **运行时**（`puppet/player.ts`）：
  - `ScenePuppets.ids` / `control` / `findLayer` 给出每层的控制口 `PuppetLayerControl`（P12e 起按层 id，见「puppet 动画层的建删（P12e）」）；
  - 每层一张播完回调表；
  - 时钟带 MDLA 事件；
  - `frame(dt, state, hooks)` 在每个 puppet 推进完全部层之后派发：先事件（交给 `hooks.event` → 脚本运行时的 `animationEvent`），再进回调循环（P12e 起照 WPE：本帧有层播完才进、调过回调就复位下标、之后删单次层）。所以回调里的任何写入都是下一帧生效。P12g 起派发在层循环之后、物理交换与蒙皮之前（同 WPE）：回调里读到的骨骼矩阵是上一帧的，回调里写的局部 / 世界骨骼矩阵被本帧的推进盖掉，见「puppet 骨骼的局部读写（P12g）」。
- **脚本 API**（`script/api.ts`）：
  - 包装对象按「对象:层 id」缓存（P12e 前是层下标），不持有运行时，每次经宿主现取控制口，重编译换了运行时也接得上，同 `IAnimation`。
  - `rate` / `blend` / `visible` 是用户属性、字段脚本、API 三方共写的字段，在 `SceneState.animationLayers`，写入走 `animation-layer` 目标，会记进重放表。
  - `name` / `additive` / `blendin` / `blendout` / `blendtime` 只有 API 写，直接落在运行时的层上，重编译时随 `carryOver` 接回（连同回调表）。
- **宿主**（`host.ts`）：首次加载时 `init` 先于 `beforeFirstFrame`，所以照 P10b 的 `pendingAnimations` 在跑 `init` 之前建好待用的 `ScenePuppets`（`pendingPuppets`）。语料里约 50 处「相位偏移」脚本在 `init` 里 `setFrame`，靠它才有落点。

### 规则

| 项 | 规则 |
|---|---|
| 入口 | 所有图层对象都有（图像层与带骨骼的模型都是同一套）。不是 skinned puppet / 骨骼模型时计数 0、查找 `null` |
| `getAnimationLayer(x)` | number 只认 `0 ≤ x < 计数` 的整数（`1.5`、`-1` 为 `null`）；非空字符串按**当前**名字找，最后一个匹配（`"1"` 也按名字）；其余 `null`。同一层每次返回同一个对象 |
| 成员 | 19 个自有可枚举成员，顺序 `duration、frameCount、fps、blend、name、blendout、blendin、rate、additive、visible、blendtime、addEndedCallback、play、isPlaying、stop、pause、setFrame、getFrame、getAnimation`；原型只有一个不可枚举 `constructor` |
| 只读三项 | `fps` = f32(1 / spf)、`frameCount` = length、`duration` = D；赋值抛 `TypeError`（文字同 WPE 的 `Cannot assign to read only property …`）。P12e 起是访问器（层释放后读 `undefined`），WPE 的原生只读属性在 `getOwnPropertyDescriptor` 里是数据属性，这一点不同 |
| 写入转换 | 照 WPE 的通用写入函数：`rate` / `blend` / `blendtime` 只收 number（`NaN`、`±Infinity` 也收）；四个布尔只收 `true` / `false`；`name` 忽略 `null` / `undefined`，其余 `ToString`；别的类型静默忽略。不钳制、没有改值回调 |
| `blendin` / `blendout` | 脚本可以重新置位：`blendin` 按当前 `t` 淡入（`t` 大时看不出）；`blendout` 写成真后循环层每轮末尾也淡出（加载时只对 single 保留） |
| 方法 | `play` / `pause` / `stop` / `isPlaying` / `getFrame` 同 `IAnimation`；`setFrame(f)` 是 `t = f32(spf × f32(f))` 并置 `SETFRAME`（本帧不判播完）；都是下一帧进画面 |
| 播完 | 推进前没有暂停、结束、`SETFRAME` 位时判：single 刚结束、mirror 换向、loop 的 `t` 变小（负 rate 每帧都成立）。`SETFRAME` 只在可见并推进的层上清 |
| 回调 | `addEndedCallback(fn)` 可加多个。调用时进入登记它的那段脚本（`thisObject` / `thisLayer` 是它的），`this` 是它的模块命名空间，不带参数；抛错只记诊断，不禁用 |
| 事件 | 层时钟越过 MDLA 事件时，交给同一图层上导出了 `animationEvent` 的脚本（含动画层字段上的脚本）；`event` 是事件 JSON 的全部字段 |
| 字段脚本 | `animationlayers[k]` 的 `rate` / `blend` / `visible` 上的 `{script}` 是新属主 `animation-layer`：`thisObject` 是那个 `IAnimationLayer`，`thisLayer` 是所属图层；`update(value)` 收到状态里的当前值，返回值写回，下一帧生效。按所属图层派发光标回调、`animationEvent`、`applyUserProperties`。对象没有骨骼运行时或这一项被丢掉时，脚本不登记 |
| 模型 | 和图像层一样派发事件与回调；对象或父链不可见时整段不推进，也就不发 |

**和 WPE 有意不同**：`addEndedCallback` 传入不是函数时，WPE 会把空指针存进回调表、播完时解引用（推断会崩溃），我们抛 `TypeError`、不登记。

**照报**：
- 动画层的 `name` / `additive` / `blendin` / `blendout` / `blendtime` 挂脚本：`puppet:layer-script`（语料 0 处）；
- 建删层的 `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`：P12e 已实现，见下面一节。

**dev 探针**：
- `host.puppets()`：每个 puppet 每层的名字、帧号、是否在播（还没换上时取待用的那份）；
- 确定性回放带脚本时，`puppets.frame` 也带事件钩子，回调读到本帧的 `engine.runtime`。

### 设备纹理上限（P12c 走查 F2）

`acquireGpu` 申请设备时按适配器支持的最大值要 `maxTextureDimension2D`。WebGPU 缺省只有 8192，WPE（D3D11）是 16384。`3830665420` 的一个带 effect 的文本层是 9787×199，按缺省上限合成 RT 建不出、整张退回。按 `device.limits` 钳的地方（场景目标、用户纹理、探针画布）随之放宽到同一个值。

### 走查

- **`p12-script` 夹具**（`puppet/p12script.test.ts`）：266 帧、642 行脚本日志与 WPE 逐行相同；`g_Bones` 100 帧最大 4 ulp（`rsqrtps`）。
- **`p12-script` 整帧**：dev 回放到第 201 帧，和 WPE 比最大差 1 级。
- **解锁的 4 张**（复制工程，WPE 各抓 1 帧，按 WPE 帧时间回放、脚本时钟设到开窗时刻）：
  - `3346715292`、`3492627662`、`3830665420` 的 puppet `g_Bones` 全部对上。超出 P12a 容差的数都在平移分量上（≈ 1e-5，`rsqrtps` 被平移放大），说明各层的帧号、`init` 里设的起始帧与 WPE 一致。整帧差在光束、音频条、时钟文字与粒子上，不在 puppet 上。
  - `3346715292` 缺 NSL 脚本库，WPE 与我们都是 6 段 `init` 抛 `TypeError`。
  - `3361965869` 点击才播的两个 puppet 逐位相同；另两个的 `rate` 跟系统声音走，不能确定性对照。
- **宿主路径**：
  - 实时预览里 MDLA 事件与播完回调照常派发、各层推进；
  - 首次加载时 `init` 的 `setFrame` 落在待用运行时上（`3492627662` 开场各层帧号不同）。
- **不变**：P12a / P12b 的 8 个生成工程 22 帧，P12c 之后与修 F2 之后都逐字节相同。

**语料**：233 张能渲染 160 → 164，解锁 `3346715292`、`3361965869`、`3492627662`、`3830665420`（后者靠 F2）。工作区快照的语料扫描里，P12c 的三个键全部消失，没有场景变成退回。

## puppet 骨骼物理与骨骼脚本 API（P12d）

依据：
- 读码 [rea-p12-attach-physics](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12-attach-physics.md) 第 2 节、[rea-p12d-bones](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12d-bones.md)；
- 实测 p12-REPORT 第一部分用例 10、第二部分第 1 节，以及 `p12-bones`；
- 计划与记录见 [phase-12d-physics.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12d-physics.md)。

### 物理

- **开关**：骨骼 JSON 要 `(r‖t) && (se‖re)` 才开，否则 `r`、`t` 一起清掉；`re` 优先于 `se`。参数在编译期解析成 `BonePhysics`（`compile/puppet.ts`，键、换算、缺省照读码 2.1）：
  - `la` 只认 JSON `true`；
  - 三个轴锁三个都在且都是布尔才读；
  - `gd` / `tp` 取空格分隔的三个数。
- **位置**：每帧动画采样、混合之后，`skinMatrices` 按骨骼下标逐根算模型空间矩阵 `Pose[i]`。算完一根就解一次物理（`puppet/physics.ts` 的 `solveBone`），`Pose[i] ← Pose[i]·D`，子骨骼、蒙皮、挂点都用改过的值。
- **输入**：
  - 图层本帧的世界矩阵 `W`，含对齐偏移，由宿主经 `PuppetSink.world`（`drawMatrixOf`）交进来。puppet 推进在脚本之前，所以是上一帧脚本写下的，同 WPE；
  - `s` = 三列长度平均（z 列也算）；
  - `Mp` = 上一帧物理（和脚本 `setBoneTransform`）之后的世界骨骼矩阵。
- **世界骨骼缓冲**：两份，推进开头交换，`cur` 对全部骨骼写 `W·Pose[i]`（WPE 的 `P+0x340` / `P+0x348`）。
- **求解**：全程 float32，照读码 2.4。
  - 惯性：距离当度数折成插值比例；
  - 重力：只取垂直分量、强度 `m·s`；
  - 积分比例：`min(60·dt, 1)`；
  - `re`：没有回弹；`se`：有弹簧；
  - `la` 钳制并扣掉越界的角速度；
  - 平移：半隐式欧拉，按 `tm` 钳距离。
- **时机**：首帧不算（没有 `Mp`），`refresh` 不算，图层隐藏照算，暂停冻结，重编译接回状态与缓冲；有物理骨骼的 puppet 不走「静止捷径」。
- **范围**：只做图像层 puppet；模型对象开物理、骨骼文件 flags bit1 仍报 `puppet:physics`（语料 0 处）。
- **语料 0 处、照读码实现（未实测）**：`lt`（每轴角速度限幅）、平移轴锁、`t + re`。这几个与 `la` 撞限位一起，只对读码的 python 模型验证过（`puppet/physics.branches.test.ts`）。

### 骨骼脚本 API

图像层对象上五个方法（模型与别的图层没有）：

| 方法 | 规则 |
|---|---|
| 选骨 | 整数下标（越界失败），或字符串取第一个全名匹配；空串在读写矩阵时失败，在冲量与复位时落到骨骼 0；第一次推进之前一律失败 |
| `getBoneCount()` | mdl 的骨骼数；没有 `MDLS` 的静态 puppet 与非 puppet 为 0 |
| `getBoneTransform(b)` | 本帧（含物理）的世界骨骼矩阵 `W·Pose[i]` 的拷贝，每次新建 `Mat4`；失败返回**单位阵**，不是 `null`；`init` 里全是单位阵 |
| `setBoneTransform(b, M)` | 写三处：`cur[i] = M`、模型空间 `Pose[i] = W⁻¹·M`（P12g 起 `W` 取调用那一刻的图层矩阵，同 WPE；之前取推进时的）、这根骨骼的蒙皮矩阵。当帧画在 `M`，子骨骼当帧不跟；只持续一帧，下一帧全部重算；唯一的残留是 `M` 成为下一帧物理的 `Mp`，所以 `t` 骨骼会被拉向 `M` 再弹回。缺矩阵或元素不是数时写单位阵 |
| `applyBonePhysicsImpulse(b, dir, ang)` | `vel += dir`、`q ⊗= eulerQuat(ang·DEG/2)`，下一帧的物理里起作用；`ang` 缺省 (0, 0, 0)，只传两个参数不抛错；没开物理的骨骼没有效果 |
| `resetBonePhysicsSimulation(b)` | 状态置初值，不清 `Mp` |

照报：混合形状的方法（语料 0 处）。`getLocalBone*`、`getBoneIndex`、`getBoneParentIndex` P12g 起支持，见「puppet 骨骼的局部读写（P12g）」。

### 走查

- **物理夹具**（`puppet/physics.test.ts`，WPE 抓帧）：
  - `p12-phys` 的 re / se / ronly / tse，`p12-phys2` 的 ronly_y / se_y，逐位相同；
  - re_ge、re_y、re_rot、se_rot 在 1.5e−5–3.6e−4 px；
  - `2345214324` 帧 216–220 最大 4.8e−3 px，`3426865175` 帧 190–192 为 0。
  都在 p12-REPORT 的 python 模型量级以内。剩下的差来自 `rotTo` 阈值附近的判定翻转（差 1 ulp 就翻），逐位一致做不到。
- **骨骼 API 夹具**（`puppet/p12bones.test.ts`，WPE 抓帧）：`p12-bones` 355 行脚本日志与 200 个 `g_Bones` draw 逐位相同。
- **语料**：233 张能渲染 182 → 185，解锁 `2345214324`、`3359451610`、`3426865175`；没有场景变成退回。

## puppet 动画层的建删（P12e）

脚本在运行中给 puppet（图像层与带骨骼的模型）建动画层、播一次就删的单次层、删层：图层上的 `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`。

依据：
- 读码 [rea-p12e-createlayer](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12e-createlayer.md)；
- WPE 2.8.42 实测（同文件末尾「实测」，工程 `ignore/p12/e/proj/p12-create`，生成器 `ignore/p12/e/defs/p12e.py`）；
- 计划与记录见 [phase-12e-createlayer.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12e-createlayer.md)。

### 动画全编与层 id

- **动画全编**（`compile/puppet.ts`）：脚本能按名字引用 MDLA 里任何一条动画，编译期认不出，所以 `ScenePuppet.animations` 是 MDLA 的每一条，`PuppetLayerDef.animation` 就是 MDLA 下标。
  - 被 `animationlayers` 引用的动画，问题照旧报进 `unsupported`；
  - 没被引用又用到不支持特性的，只留名字、id、模式、fps、长度、事件与 `unsupported`，不转帧数据，也不报（不能因为一条可能永远用不到的动画把整张场景退回）。运行时在它上面建层返回 `null` 并记一条 warn。
- **层 id**：编译期的层 = 它在 `animationlayers` 里的 JSON 下标（`entry`），运行时建的层是负数（每个 puppet 从 −1 起递减、不复用）。状态键（`SceneState.animationLayers`）、包装缓存、`{user}` 绑定、字段脚本、重放表都按 id，和 `scene.json` 路径同形。「下标」只在按下标取层、按下标删层、插入位置这几处出现。
- **取值改严**：加载 `animationlayers` 与运行时建层是 WPE 同一个 setter，float 只收 JSON 数、bool 只收 JSON 布尔、`name` 只收字符串（`floatField` / `boolField`，两处共用）。语料 316 项全部符合，0 处受影响。用户属性与脚本写入的路径（`animationLayerValue`）仍是 P12c 的规则。

### 建层：`createAnimationLayer(第一参, config?)` / `playSingleAnimation(…)`

参数规整是纯函数 `script/animationLayerConfig.ts`：

| 项 | 规则 |
|---|---|
| 第一参 | 字符串：按名字找 MDLA 动画（逐字节、区分大小写、第一条）。对象：当一项 `animationlayers`，`animation` 要是 JSON 数（`900.5` 向零取整），按 id 找第一条；`animation` 是字符串（含名字）返回 `null`。数、布尔、`null`、`undefined`、空串、缺参数：`null` |
| `config` | 对象，或 JSON 文本；数字同缺省。缺 `blendin` 键补 `true`、缺 `blendout` 键补 `true`；config 里的键覆盖第一参的同名键（所以对象第一参里的 `blendin: false` 会被缺省的 `true` 盖掉） |
| 字段 | 8 个描述符字段按上面的严规则（`NaN`、`'3'`、`0`、`'yes'`、`name: 5` 都不写）；缺省 name `""`、rate 1、blend 1、可见、非加法、blendtime 0.5。值是 `{value, user / script / animation}` 时只取 `value`、不登记绑定（warn 一次，语料 0 处） |
| 新层 | 在播、t = 0、时钟模式取动画自己的；非 single 动画清掉 `blendout`；没有 `SETFRAME`，第一次推进就判播完；`IAnimationLayer.id` 读出 `undefined`；返回值 `=== getAnimationLayer(计数 − 1)` 只在追加时成立 |
| 插入 | 缺省追加。`index` 0 插 0；`1 ≤ index ≤ 计数 − 1` 插 `index`；负数或 ≥ 计数 − 1 插到 `计数 − 1`（最后一层之前）。`autosort` 为 JSON `true` 时从尾往前跳过加法层，插在最后一个非加法层之后，优先于 `index` |
| 生效 | 脚本阶段建的层下一帧才推进；回调里给排在后面的 puppet 建层同帧推进 |
| `playSingleAnimation` | 同 `createAnimationLayer`，另给层置 `SINGLE_SHOT`（`0x8000000`） |

### 单次层与回调循环

每个 puppet 推进完全部层后（`ScenePuppets.dispatch`）：
1. 派发 MDLA 事件；
2. 本帧有层播完（`anyEnded`）才进回调循环：按层序找带 `ENDED` 的层，清 `ENDED`；单次层先置 `DOOMED`（`0x10000000`）再调回调；调过回调的层把循环下标**复位成 0**，`++` 后从 1 重扫；
3. 删掉全部 `DOOMED` 的层并当场释放。

由此得到的 WPE 行为：
- 「播完」随模式：single 到头、loop 第一次回绕、mirror 第一次换向；
- 删层那一帧层仍参与姿势，回调里层仍有效、计数未减、回调不带参数；同一帧之后的 `update` 里已经作废、计数已减；
- 隐藏的层不推进、永远不删；暂停的不删；回调里 `play()` / `setFrame(0)` 救不回；
- **漏扫**：A 的回调删了 A，后面的 B 本轮漏掉，`ENDED` 留着，下一次有层播完时才调。

### 删层：`destroyAnimationLayer(x)`

- 参数：字符串按名字删**全部**同名层（区分大小写，空串 `false`）；Int32 按下标（`0 ≤ i < 计数`）；有效的包装按它自己（别的 puppet 的包装 `false`）；其余（`1.5`、`{}`、作废的包装、`null`、找不到的名字）`false`。
- 两段：命中的层**当场**摘出层表（计数、下标、名字查找立刻看不到），进 `detached`；本帧全部脚本跑完之后宿主调 `ScenePuppets.settle` 释放。所以同一帧里包装仍可读写、可调方法，下一帧作废。
- 释放（单次层与 `settle` 共用，`PuppetHooks.released`）：删状态项、给这一层的动画层字段脚本发 `destroy`、去掉重放表里 `objects/<o>/animationlayers/<id>/` 开头的项。
- 删光或全部隐藏后姿势回到静止；骨骼透明度与变形复位；`g_BlendMap` 不复位。

### 作废的包装

读 `undefined`、写忽略、方法返回 `undefined` 且不抛错（`addEndedCallback(非函数)` 也不抛）、`engine.isObjectValid` 为假、作 `destroyAnimationLayer` 的参数返回 `false`。活着的层 `isObjectValid` 为真。

### 跨重编译

运行时建删的层不进编译输入。重编译后 `carryOver` 按 id 把上一份层表原样接回：顺序、运行时建的层（按新 rig 里同一条 MDLA 动画重建）、删过的编译期层（`destroyedEntries`）、时钟的全部位、回调、`nextId`。之后 `SceneState.syncAnimationLayers` 对齐状态项（只对齐有运行时的对象）。理由：`autosort` 的插入位置取决于当时各层的加法位，编译期重演得不到同样的顺序。清空脚本存储后回到 JSON 原样。

### 有意不同与已知差异

- 图像层按名字删、原表最后一层匹配：WPE 崩溃，我们删掉全部同名；
- `config` 解析成非对象、第一参对象是数组：WPE 未定义行为，我们返回 `null` 并 warn；
- `autosort` 没有非加法层、空表上 `index ≠ 0`：WPE 越界写，我们插到 0；
- 静态 puppet（没有骨骼）上建层：WPE 建出一个永不推进的层，我们返回 `null` 并 warn；
- 运行时 `config` 里的 `{user / script / animation}` 只取 `value`、不登记；
- 对象 id：WPE 建层让共享计数器前进 2，影响之后 `createLayer` 的自动 id，我们不复刻；
- jsoncpp 解析失败时可能留下部分键（`'{"rate":2, x'`），我们整段当失败；
- 只读三项是访问器（见 P12c 一节）；`addEndedCallback(非函数)` 抛 `TypeError`（P12c）。

### 走查

- **`p12-create` 夹具**（`puppet/p12create.test.ts`）：从第 1 帧按 WPE 帧时间回放 268 帧，545 行 `[kbp]` 日志（含 `@f64` 时间线、初值、查找、config、插入、单次层、删层、回调循环）与 WPE 逐行相同；脚本帧 241、242 五个 puppet 的 `g_Bones` 480 个数里 470 个逐位相同，最大差 5.96e-8（4 ulp，`rsqrtps`）。
- **宿主路径**：dev 里经探针按同一时间线回放，545 行逐行相同；实时预览里各 puppet 的最终层数与 WPE 相同，`host.puppets()` 的 `detached` 为 0（`settle` 接上）。
- **不变**：P12a–P12d 的 8 个生成工程 22 帧逐字节相同。
- **语料**：233 张的不支持键逐张不变（`2887099508` 的调用编译期认不出，本来就不报；`2916324703` 仍差精灵表与 `tex:animation`），能渲染数不变。动画全编后 puppet 动画数据 36.4 → 49.7 MB（41 → 43 张、315 → 473 条），最大 `3706286085` 1.9 → 14.2 MB，全库编译 91.4 → 94.2 s。
- **2887099508**：点书走的是「page首」的 `cursorClick` → `hand book.playSingleAnimation("hand turn")`。探针模拟点击没点中（开场镜头推近，书不在算出的位置），用户在预览里点书确认翻页正常（回归 PE6）。

## puppet 绘制顺序（P12f）

网格 0 带标志 bit3 的图像层 puppet，动画的绘制顺序轨道（MDLA v ≥ 6 的每骨骼 f32 轨道）在运行中改变绘制组的先后：WPE 重写网格 0 的索引缓冲，有裁切记录时按新顺序重建裁切命令表。

依据：
- 读码 [rea-p12f-draworder](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12f-draworder.md)；
- WPE 2.8.42 实测 `ignore/p12/f/meas/REPORT.md`（生成工程 `p12f-order` 16 个 puppet，补测 `p12f-rebuild`；生成器 `ignore/p12/f/defs/p12f.py`）；
- 计划与记录见 [phase-12f-draworder.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12f-draworder.md)。

### 节点与键

- **节点**：网格 0 的绘制组（可选块 2，`{骨骼, 偏移, 索引起点, 索引数}`），网格 0 有 bit3 或有 v23 记录时建（`ScenePuppet.order`）。节点的静态部分 `base = 骨骼基数 + 组偏移`（i32，骨骼基数是 `MDLS` 的每骨骼绘制顺序）。加载时节点保持组表顺序，GPU 索引是文件原样，基数与偏移在第一次重排之前都不起作用。
- **当前值 `cur`**（WPE 的 `P+0x280`）：每帧推进时先复位成 `f32(骨骼基数)`，再由每个可见动画层用这一层的 lo 帧（不插值）写，全程 float32：
  - 覆盖（`w == 1` 且非加法）：`cur = v`；
  - 混合：`cur = (1 − w)·cur + v·w`；
  - 加法：`clamp(cur + (v − 骨骼基数)·w, min(cur, v), max(cur, v))`。减的是骨骼基数，结果钳在 `cur` 与 `v` 之间。
  
  只有不可见的层不写；权重 0、暂停、单次层停在末帧都照写，照样触发重排。骨骼轨道 `flags & 3 == 1` 的骨骼跳过（同骨骼透明度）。
- **键**：`cvttss2si(f32(base) + cur[骨骼])`，向零取整（`−0.9 → 0`、`−100 + 49.5 → −50`），NaN 与越界得 `−2147483648`。非覆盖时基数会算两次（blend 0 的层得到 `2·基数 + 偏移`）。

### 重排

- 本帧有层写过才重算键。当前顺序已是非降序时什么都不做；否则稳定排序（只比键），重拼索引。不是 `std::sort`，不能用 `meshDrawOrder`。
- 节点顺序跨帧保留：并列的组保持上一次的相对顺序，不回到组表顺序。没有层写的帧、写入的层被隐藏或删掉之后，顺序都保持。
- 运行中改属性（对象 `size`、`colorBlendMode`、对象或动画层的 `visible`）WPE 不重建几何、不重置顺序（补测）；顺序只在加载时回到组表顺序。
- 时机：puppet 推进里、蒙皮之后，所以本帧的绘制就用新顺序。只在真的推进时做（`refresh` 不写不排）。
- 实现：纯函数在 `puppet/drawOrder.ts`（`blendDrawOrder`、`reorder`、`orderedIndices`、`clippingTable`）。运行时 `ScenePuppets.drawOrder(object)` 给 `{ version, indices, clipping }`，真的重排时 `version` 加 1。重编译时 `carryOver` 在节点表相同时接回顺序（我们因属性做的重编译 WPE 没有）；清空脚本存储回到组表顺序。

### 裁切命令表随顺序重建

规则同 P12b1 的裁切命令表（区间遮罩、末遮罩位置触发、按最小目标位置稳定排序），只是「位置 p」上的节点是当前顺序的 `order[p]`。编译期按组表顺序建一份，结果与 P12b1 逐段相同；每次重排后按当前顺序重建。命令条数与记录先后都会变：生成工程的 `clip_move` 在 3 次与 4 次绘制之间切换，`clip_two` 两条记录换先后。

### 渲染

- 会重排的 puppet（`order.dynamic`）与有裁切记录的 puppet，每个绘制模板一块**私有**索引缓冲（`INDEX | COPY_DST`，容量是整张网格的索引数）；别的 puppet 仍共用 mdl 视图的缓冲。
- 有裁切时计划不再按命令表展开：普通段模板有「记录数 + 1」个槽位，每条记录一组遮罩模板与目标模板。新的 `puppet-clip` op 在编码时按当前命令表现排：第 j 个普通命令画第 j 个普通槽位；裁切命令先清遮罩 RT，再画遮罩，再画目标。平面反射 pass 按同一序列逐个 draw 反射。
- `syncPuppetIndices` 在编码开头写缓冲：来源对象（`drawOrder` 返回的那个）与版本都没变就不写；用不到的槽位 count 为 0。

### 能力表

- 去掉 `puppet:draw-order`。
- 照报：
  - `puppet:order-track`：有绘制顺序轨道、没有 bit3。WPE 写空指针，崩溃。
  - `puppet:draw-order:base`：网格要绘制组、`MDLS` 却没有每骨骼基数。WPE 加载时读空指针，推断崩溃，语料 0 处。
  - 记录标志非 0 照旧报 `puppet:clipping:flags`。bit3 的查表缺陷不复刻：WPE 会把后面全部位置收作目标。

### 有意不同与已知差异

- 换了 mdl 的重编译（节点表变了）从组表顺序重来。WPE 运行中不会换 mdl。

### 走查

- **生成工程 `p12f-order`**（16 个 puppet）：
  - 夹具 `puppet/p12f.test.ts` 从第 1 帧按 WPE 帧时间回放，采样帧 240 / 242 / 248 / 252 共 29 个 puppet-帧，每次绘制的组序列与 WPE 抓帧逐个相同，含裁切命令数的变化。
  - dev 里真渲染器按同一时间线回放（跑场景脚本，hide / destroy 由脚本触发），逐 draw 轨迹的索引同样 29 个逐个相同，绘制数 25 / 26 也同 WPE。
- **两张真实壁纸的复制工程**（`kbp content isolate`，WPE 1280×720 连抓 100 帧，我们按 WPE 日志的帧时间与光标回放、跑脚本、后处理 ultra）：
  - `3577990983` 的 `sl`（第 170–269 帧）：100 帧整帧最大差 2，没有大于 2 的像素。这段时间里节点顺序是第 21 帧那次重排的结果（加法层「眼」减基数后被钳住，之后不再变），组 36 换到组 35 前面，遮罩区间随之后移、组 36 移出遮罩段；第 220 帧 4 次绘制（19872 / 7077 / 15 / 201 个索引）与 WPE 逐个相同。
  - `3841310696` 的 `眼睛`（第 159–258 帧）：100 帧整帧最大差 2，第 257 帧逐像素相同；这段时间重排 17 次，第 230 帧 6 次绘制（两条共用遮罩的裁切记录）的索引与 WPE 逐个相同。
- **语料**（293 张，`ignore/p6/e0/corpus-now4.json` 的范围加 myprojects 60 个目录）：干净 286 → 288（`3577990983`、`3841310696`），只去掉 `puppet:draw-order` 2 张，没有新键，`clean_lost` 0。

## puppet 骨骼的局部读写（P12g）

图像层 puppet 的 8 个骨骼脚本方法：`getBoneIndex`、`getBoneParentIndex`、`get/setLocalBoneTransform`、`get/setLocalBoneAngles`、`get/setLocalBoneOrigin`。它们读写同一份每骨骼的局部矩阵（WPE 的 `P+0x310`）。混合形状的 3 个方法照报（语料 0 处）。

依据：
- 读码 [rea-p12g-localbones](../../../.claude/plans/wpe-import/3-scene/phase12/rea-p12g-localbones.md)；
- WPE 2.8.42 实测 `ignore/p12/g/meas/REPORT.md`：
  - 生成工程 `p12g-local`（13 个 puppet）、`p12g-args`；
  - 生成器 `ignore/p12/g/defs/p12g.py`；
- 计划与记录见 [phase-12g-localbones.md](../../../.claude/plans/wpe-import/3-scene/phase12/phase-12g-localbones.md)。

### 局部矩阵与写入

- **局部矩阵**：`ScenePuppets` 的 `PuppetRuntime.local`（每骨骼 16 个 f32）。每次真的算蒙皮时，`skinMatrices` 对全部骨骼重写它：
  - 没有可见动画层时，取静止来源（MDLS 的可选静止矩阵，没有就是骨骼的局部矩阵）；
  - 有可见层时，取混合后姿势的 TRS 矩阵。
  
  静止捷径跳过的帧保持上一次的值，期间只有脚本写入会改它，写入会清掉捷径。
- **写入**（`setLocalBone*`，`ScenePuppets.writeLocal`）：
  - 改 `local[i]` 后，当场重算骨骼 i 与它的子孙（`puppet/localBones.ts` 的 `recomputeSubtree`），三处都是完整 4×4 乘法（`mulFull`）：
    - `Pose[j] = Pose[父]·Local[j]`（根直接取 `Local`）；
    - `K[j] = Pose[j]·绑定逆[j]`；
    - `World[j] = W·Pose[j]`。
  - 子树：从 i 起按下标往后扫，父在脏集合里的才算（父下标比子大的骨骼不算，同 WPE）。
  - `W` 取**调用那一刻**的图层矩阵：从 `PuppetSink.world` 现取，同一帧先改了图层 `origin` 再写，子树就用新的。
- **生效与保持**：
  - 绘制在脚本之后上传蒙皮矩阵，所以当帧生效，子骨骼当帧跟着动。
  - 下一次推进对全部骨骼重写 `local` / `Pose` / `K` / `World`，所以写一次只管一帧；写入不进动画混合，也不进下一帧的静止来源。
  - 有动画层时，每帧「读 → 改 → 写」等于叠在动画上；每帧写固定的基准等于盖掉这根骨骼的动画。
  - 跨帧的痕迹只有一处：重算出的 `World` 在下一帧推进开头交换成物理的上一帧矩阵。
- **完整乘法不能换成仿射乘法**：推进的父链与蒙皮用仿射乘法，两者结合顺序不同。所以原样写回也会改变子树的低位（实测 1e-6 级，`p12g-args` 的 lh / li）。

### 方法

| 方法 | 行为 |
|---|---|
| `getBoneIndex(name)` | 只收 JS 字符串，非空时取第一个全名相等（区分大小写）的骨骼下标，否则 −1。不看运行时：`init` 里、静态 puppet 上都能用，非 puppet 图层为 −1 |
| `getBoneParentIndex(b)` | 选骨规整同下。整数按骨骼数判界，返回 MDLS 的原始父下标（根 −1）；名字取第一个同名**且有父**的骨骼的父（同名的根被跳过）；其余 −1。不看运行时 |
| `getLocalBoneTransform(b)` | `local[i]` 的拷贝，每次新建 `Mat4`。第一帧推进之后读到的就是静止来源（逐字节），同帧写过之后读回新值。失败返回单位阵 |
| `getLocalBoneAngles(b)` | 对 `R = Rz·Ry·Rx` 求逆，弧度，不先去缩放（均匀缩放无影响，非均匀缩放让 x / y 失真）。`|y| > π/2` 的角读回等价的另一组（`(0, 2, 0)` 读回 `(π, π − 2, −π)`）。失败返回 `(0, 0, 0)` |
| `getLocalBoneOrigin(b)` | 平移列 `c3.xyz`。失败返回 `(0, 0, 0)` |
| `setLocalBoneTransform(b, M)` | 整个 16 个数。Mat4 实参转换同 `setBoneTransform`：不是对象、`m` 不是数组时为单位阵，非数元素保留单位阵对应位 |
| `setLocalBoneAngles(b, v)` | 前三列重写成 `Rz(v.z)·Ry(v.y)·Rx(v.x)`（w 写 0），**原有缩放丢掉**，平移保留 |
| `setLocalBoneOrigin(b, v)` | 只改 `c3.xyz` |

- **选骨**：同 `getBoneTransform`，Int32 下标或名字（第一个），空串、`1.5`、越界、第一次推进之前都失败。
- **失败**：读返回单位阵或 `(0, 0, 0)`，写什么都不做，都不抛错。
- **实参不对照样写**：第二个参数缺省或类型不对时照样写单位阵 / `(0, 0, 0)`。Vec3 实参取对象的 `x y z`，非数分量为 0（`Vec2` 得 z = 0）。
- **只在图像层上**：模型对象、文本 / 粒子 / 声音层没有这些方法。
- **派发时机**（P12g 起，同 WPE）：MDLA 事件与播完回调在层循环之后、物理交换与蒙皮之前派发（`ScenePuppets.evaluate` 里）。所以：
  - 回调里读到的骨骼矩阵是上一帧的；
  - 回调里写的局部矩阵被本帧推进盖掉，只改了本帧物理的上一帧矩阵（实测 le4）。
- **`setBoneTransform` 的先后**：它不写 `Local`。之后对它的子骨骼写局部矩阵，会以它写的姿势为父；对它或它的祖先写，会把它冲掉（实测 t16 / t17）。`setBoneTransform` 的 `W` 也改成调用时刻的。

### 和物理的交互

- 子树里开了物理的骨骼，当帧的物理增量被丢掉，画面上不摆（重算只从 `Local` 算）。
- 被重算的 `World` 不含增量，成为下一帧物理的上一帧矩阵，所以物理状态的演化也跟着变（实测 lf1–lf3）。
- 写不在子树里的骨骼不影响物理。

### 能力表

- 缺失表去掉这 8 个方法（`script:api:layer.<名>`），只剩混合形状 3 个。
- 编译期 `ScenePuppet.parents`：MDLS 原始父下标，静态 puppet 也有，给 `getBoneParentIndex`。

### 有意不同与已知差异

- `getLocalBoneAngles` / `setLocalBoneAngles` 用 `Math.atan2` / `sin` / `cos` 再取 float32。WPE 是 CRT 的 `atan2f` / `sinf` / `cosf`，可能差 1 ulp；实测的读回值全部逐位相同。
- IK 是否另写局部矩阵没读（语料 0 条 IK 链）。

### 走查

- **生成工程**：
  - 夹具 `puppet/p12g.test.ts`（`puppet/fixtures/p12g-local.json`）按 WPE 帧时间逐帧回放 `p12g-local` / `p12g-args`：
    - 日志读回值与 WPE 逐字相同；
    - 抓帧（第 124–129、525–530 帧，args 112–114）的 `g_Bones` 逐位相同。
    - 动画驱动的 le1–le4 有 64 个分量不逐位：动画四元数转矩阵本来就不复刻 `rsqrtps`，是已有差异。
  - dev 里真渲染器跑场景脚本、按同一时间线回放：
    - 第 129、528 帧 13 个 puppet 的 `g_Bones` 全部与 WPE 逐位相同，含照搬真实壁纸脚本的 `lr`，以及用 WPE `Mat4.rotate` 写的 le1 / le3；
    - 挂在骨骼上的子图像层 MVP 逐位相同。
- **真实壁纸复制工程**：`3820240793` 只留对象 0（puppet、4 个 effect、`visible` 上的字段脚本），用 `kbp content isolate` 切出。
  - WPE 1280×720、20 fps 连抓 100 帧（第 271–370 帧）；我们按 WPE 日志的帧时间与光标回放、跑脚本、后处理跟随 WPE。
  - 100 帧整帧最大差 2，没有大于 2 的像素，每帧 100 个上下的像素差 1–2。
  - 第 300 帧 5 根骨骼的 `g_Bones` 与 WPE 逐位相同（胸骨此时偏移 (2.94, 6.22)，呼吸确实在动）。
- **语料**（294 张：P12f 的范围加 `3820240793`）：同一基点 `aeebf031` 的源码有无 P12g 各扫一次，干净 293 → 294（全部干净）。只去掉 `3820240793` 的 3 个 `script:api:layer.*` 键，没有新键，别的场景不变。
