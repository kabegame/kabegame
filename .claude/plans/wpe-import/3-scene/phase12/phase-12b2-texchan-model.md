# P12b2 — 纹理通道与模型对象的骨骼（子计划，草稿）

> 上级：[P12 总计划](phase-12-puppet.md)「P12b」的拆分（2026-11-14 用户定）。WPE 语义以读码 `ignore/p12/b/rea/texchan-model.txt` 为准（静态，全部没实测），P12a / P12b1 的结论照旧有效。
> 现状行号按 HEAD `d1f2dbcf`。2026-11-15 用户：「开始」。
> 步骤 0 已做完（见「实施记录」）；「决定」1–3 用户已定（2026-11-15，2、3「可以，开始」）。

## 总体设计思路

P12b2 有两样东西，彼此不相干，在 WPE 里走的是两条代码路径：
- **纹理通道**：图像层 puppet 的一种附加绘制。mdl 里带标志 bit1 的网格是「纹理通道网格」，材质是 `puppettexturechannels`。它在合成 RT 里、基础四边形之后再画一遍，按 `g_BlendMap`（每个 puppet 16 个 float）把通道图混进原图。`g_BlendMap` 由动画层的「n3 条标量轨道」驱动，规则和骨骼透明度相似，但**每帧不复位**，加法层会一直累加。
- **模型对象的骨骼**：P5c 的模型对象（`model` + mdl）带 `MDLS` / `MDLA` / `MDMP` 时，WPE 用和图像层 puppet 同一套时钟、采样、混合、蒙皮函数，所以运行时复用 P12a 的 `src/puppet/`。差别有几处：
  - 不可见时整段冻结；
  - 权重 0 的层整层跳过；
  - 静止姿势只取 `MDLS` 局部矩阵；
  - 只处理 TRS 与变形权重两种轨道，变形权重按网格，混合时钳 [0, 1]；
  - 组合键规则不同：`BONECOUNT` 取 2 的幂，`SKINNING` 按网格写 0 / 1，另有 `MORPHING_NORMALS`；
  - 变形纹理是另一种布局，每网格一张；
  - 剔除盒跟着动画包围盒变；
  - 挂点用加载时就有的模型空间骨骼矩阵。

两样都**不解锁任何场景**：
- 纹理通道只有 `3811424158`，它还差精灵表动画（`tex:animation`、`combo:SPRITESHEET`）。而且它的 `01_z` 没有动画层，读码推断通道网格画了也一个像素都不写。
- 带骨骼的模型只有 `3706286085`（还差 P13 的雾与方向光阴影）和 `3662790108`（还差预光照、透视文本、缺材质、媒体回调等）。

所以 P12b2 的价值在于：实现之后，这三张场景只差别的节的能力；`3706286085` 里的骨骼动画就绪，P13 做完即可解锁。

边界和 P12a / P12b1 一样：数据在编译期定好；运行时 `src/puppet/` 是纯 TS，按「图像层 / 模型」两种模式参数化，不复制一份；渲染侧只多每帧 uniform、模型的变形纹理与纹理通道的那一次绘制。

## 现状锚点

**a. 纹理通道照报**（`compile/puppet.ts:319`）
```ts
if (file.meshes.some((item) => item.flags & 2)) issues.add("puppet:texture-channels");   // 现状：任一网格 bit1 就报
```

**b. 模型 mdl 的尾部段照报**（`compile/features.ts:1026`）
```ts
function sectionIssue(tag: string): string | undefined {
  if (tag.startsWith("MDLS") || tag === "MDLE0002") return "mdl:skeleton";   // 现状：模型带骨骼、动画、变形、挂点段一律照报
  if (tag.startsWith("MDLA")) return "mdl:animation";
  if (tag.startsWith("MDMP0001")) return "mdl:morph";
  if (tag.startsWith("MDAT0001")) return "mdl:attachment";
  return undefined;
}
```
另有：
- 模型对象上的 `animationlayers` 报 `object:animationlayers`；
- 网格标志 bit10（`MORPHING_NORMALS`）报 `mdl:flags:0x400`。

## 步骤 0 — 语料、翻译器预检与实测

读码已有（`texchan-model.txt`），而且全部是静态结论。步骤 2 的教训是静态推断不够，所以步骤 0 补三样：

- **0a 语料与翻译器**（代理，只读，`ignore/p12/b2/corpus/`）：
  - 全语料里纹理通道网格、带骨骼 / 动画 / 变形 / 挂点的模型对象各自的用法：网格数、骨骼数、`BONECOUNT`、变形目标与 bit10 / bit11、动画层的模式与权重、可见性、是否被脚本驱动、包围盒；
  - 每张场景剩下的不支持项；
  - 翻译器预检：模型着色器在 `SKINNING` 0 / 1、`BONECOUNT` 16 / 32 / 64 / 128、`MORPHING`、`MORPHING_NORMALS` 的各组合，以及 `puppettexturechannels` 在 `BLENDROWCOUNT` 1–4、`DOUBLEBUFFERED` 0 / 1 下能否翻译，`gl_VertexID`、`g_Texture5Resolution`、`g_Bones` 的反射是否正确。
- **0b 真实壁纸的抓帧**（代理，wpe-renderdoc，`A:\p12\b2\`），核对读码第 9 条「没有任何实测」的三项：
  - `3811424158` 的 `01_z`：纹理通道网格画没画、合成 RT 在那次 draw 前后是否逐像素相同、`g_BlendMap` 是否全 0；
  - `3706286085` 的模型：`g_Bones` 常量缓冲的大小是否是 48 × `BONECOUNT`、`g_MorphOffsets[0]` 是否为 0、组合键；
  - `3662790108`：没有动画层的模型是否保持绑定姿势。
- **0c 生成工程**（代理，kbp-tools 的生成库 + `ignore/p12/defs` 的 mdl 编码器，抓帧在 `A:\p12\b2\gen\`），核对会改变画面的规则：
  - 模型：三种叠法与权重 0 的层（含全部为 0 时走 `MDLS` 局部矩阵）、隐藏后时钟是否冻结（和图像层 puppet 对照）、`BONECOUNT` 取 2 的幂、变形权重的三种叠法与钳制、`MORPHING_NORMALS`、挂点（子对象挂在模型骨骼上，第一帧就有绑定姿势）、剔除盒取动画包围盒；
  - 纹理通道：动画层驱动通道轨道时 `g_BlendMap` 不复位、加法层累加、`DOUBLEBUFFERED`、`BLENDROWCOUNT` 1–4。
  - **WPE 安全**：通道轨道条数 n3 ≤ 16（> 16 时 WPE 越界写）；`BLENDROWCOUNT` ≤ 4（> 4 时越界读）；骨骼 ≤ 128；挂点排在父后面；不做读码里标了「越界」「笔误」的组合。

做完写进「实施记录 步骤 0」，报告给用户。

## 决定

1. **两处 WPE 缺陷不照抄**（2026-11-15 用户：「我的原则是语料依赖的缺陷复现」）：
   - 模型变形偏移按各网格自己的顶点数，WPE 用的是最后一个变形网格的顶点数；
   - 缩放与权重按真实网格下标取，WPE 用的是排序后的记录下标。
   
   语料不表现（步骤 0a），文档记为「和 WPE 有意不同」并写明触发条件：
   - 多个变形网格顶点数不同、且有 t ≥ 1 的目标权重非 0；
   - 半透明网格排在不透明网格前。
2. **模型动画层的字段脚本归 P12c**，和图像层的一起做；P12b2 里照报同一个键 `puppet:layer-script`。
3. **分两半，顺序做**：两半都要改 `compile/puppet.ts` 与 `puppet/player.ts`，所以不并行。先做模型（大），再做纹理通道（小），各自独立验收。
   - 预光照下的纹理通道照报 `puppet:texture-channels:prelighting`；
   - 同一 mdl 里不带 `a_BlendIndices` 的网格写 `SKINNING` 0、画在模型空间（照读码）。

## P12b2-1 — 模型对象的骨骼

### 总体设计思路

WPE 的模型更新和图像层 puppet 用同一组时钟、采样、混合、蒙皮函数（实测逐位相同），所以不另写运行时。`ScenePuppets` 的每个运行时多一个模式 `"image" | "model"`，下面这几处按模式分支，其余共用：

| 规则 | 图像层 puppet（不变） | 模型（新） |
|---|---|---|
| 更新门 | 隐藏照推进 | 对象或父链不可见时整段跳过、时钟冻结。看的是推进那一刻状态里的可见性，也就是上一帧脚本写下的 |
| 权重 0 的层 | 照常参与 | 整层跳过；全部跳过等于没有层，局部矩阵直接用 MDLS |
| 静止姿势来源 | MDLS 可选矩阵优先 | 只用 MDLS 局部矩阵（编译期定，运行时不分支） |
| 标量轨道 | 透明度、变形、通道 | 只有变形，且按网格 |
| 变形权重 | 覆盖 `\|v\| ≥ ε` 置位；混合不钳 | 覆盖 `\|v\| > ε` 置位、不钳；混合钳 [0, 1]、只在 `\|v\| > ε` 时置位；加法同式 |
| 剔除盒 | — | 可见层（不看权重）的动画包围盒的并，至少一个有效才用，否则 mdl 包围盒 |

编译期给模型对象多一份 `SceneModel.skeleton`：骨骼、动画、动画层、挂点，与每网格的变形。数据形状尽量复用 `ScenePuppet` 的字段，`buildPuppet` 里的解析拆出共用的部分，不复制。渲染侧的模型网格 draw 多三样：
- **`g_Bones`**：每个对象一份，所有网格共用；写前 n 根，其余 0。
- **变形纹理**：每网格一张，`rgba32float`，内容按 WPE 的 i16 分量流排布，见下。
- **每帧的变形 uniform**。

挂点钩子 `attachPose` 按父是图像层还是模型取各自的姿势；模型的姿势在加载时就是绑定姿势。场景的 puppet 推进（`stepPuppets`）同时推进模型，位置不变：粒子之前、相机与脚本之前。B1 的影子缓存（`worldStamps.ts`）的更新阶段集合加上带骨骼的模型，WPE 的模型更新同样在更新循环里取 W。

### 点 1 — 编译（`compile/mdl.ts`、`compile/puppet.ts`、`compile/bundle.ts`、`compile/features.ts`）
- **修改** `compileModel`：mdl 有 `MDLS` 时建 `SceneModel.skeleton`，复用 `buildPuppet` 拆出的骨骼 / 动画 / 动画层 / 挂点解析：
  - 静止姿势只用 MDLS 局部矩阵；
  - 动画层规则同图像层（`autosort` / `index` / 找不到动画整层丢）；
  - 字段挂脚本照报 `puppet:layer-script`。
- **修改** 组合键（每网格，只在有骨骼时）：
  - `SKINNING` = 格式含 `a_BlendIndices` ? 1 : 0，总写；
  - `BONECOUNT` = `min(128, pow2ceil(max(16, n)))`；
  - `MORPHING` = 网格有 MDMP 目标；
  - `MORPHING_NORMALS` = 网格标志 bit10。
- **新增** 变形纹理（每网格，编译期打好，`rgba32float`，值 `max(c / 32767, −1)`）：
  - 分量流按「目标 → 顶点 → 位置 xyz（bit10 时再接法线 xyz）」紧排，`nVert` 用网格顶点数；
  - 纹素数 `ceil(3K / 4)`，边长 `floor(sqrt)` 不够加 1。
- **修改** 能力表：
  - 模型上去掉 `mdl:skeleton`、`mdl:animation`、`mdl:morph`、`mdl:attachment`、`object:animationlayers`、`mdl:flags:0x400`；
  - **新增**照报（语料 0 处）：`mdl:morph:tangent`（bit11）、`model:rootmotion`；物理骨骼照报 `puppet:physics`（P12d）。

### 点 2 — 运行时（`puppet/player.ts`、`puppet/pose.ts`）
- **修改** `ScenePuppets` 的构造收 `{ object, puppet, kind }`，按上表分支：
  - 更新门读 `PuppetSink` 的可见性（对象与父链）；
  - 权重 0 跳过；
  - 变形按网格的数组；
  - 模型的变形权重叠法新增 `blendModelMorphWeights`。
- **新增** `bounds(object)`（剔除盒）。
- **修改** `morph(object)` 对模型返回每网格一份 uniform：
  - 偏移 = 目标号 × 该网格的顶点数；
  - `g_MorphWeights[0]` = 该网格的 MDMP 缩放。
  
  这两处都是决定 1 的正确做法。
- `carryOver`、`seek` 照旧覆盖模型。

### 点 3 — 渲染（`render/scene.ts`、`render/graph.ts`、`render/layout.ts`、`render/worldStamps.ts` 的调用方）
- **修改** 模型网格 draw 每帧写 `g_Bones`、`g_MorphOffsets` / `g_MorphWeights`（块里有才写），槽 5 绑该网格的变形纹理。
- **修改** `attachPose` 认模型父；`modelCulled` 用 `bounds(object)`。
- **修改** 影子缓存更新阶段的对象集合加带骨骼的模型。
- 宿主与 dev 回放：`ScenePuppets` 的建立处把模型一起交进去，`stepPuppets` 不变。

### 点 4 — 单测与对照
- 运行时：用 `ignore/p12/b2/gen` 的 `p12b2-mdl` / `mdl2` / `vis` / `morph` / `rest` 抓帧的常量，按日志 dt 回放：`g_Bones`、变形 uniform 逐位对 WPE；`morph` 工程里的缺陷那一项断言「正确做法」的值，并注明 WPE 的值。
- 编译：组合键、变形纹理逐分量对 WPE 抓帧（`p12b2-morph`）；语料 `3706286085` 的模型编译后只剩 P13 的键与 `puppet:layer-script`、`object:parent`。

## P12b2-2 — 纹理通道

### 总体设计思路

纹理通道是图像层 puppet 的一次附加绘制：
- 只认第一个 bit1 网格，且要 skinned；
- 有它就强制走合成路径（UV 不缩放，同 effect / 精灵表）；
- 在合成 RT 里画完基础四边形之后，用通道网格自己的材质（加 `BLENDROWCOUNT` = 网格多读的 u32 的低字节）再画一次；
- 矩阵用合成 RT 的 `ortho(0, W, 0, H)`，模型矩阵 `diag(1/s, 1/s, 1, 1)`，我们的 s 恒为 1；
- `g_Color4` 与基础四边形相同。

`g_BlendMap` 是每个 puppet 一份 16 个 float 的持久状态，初值 0、帧首不复位。每个可见层按通道轨道写：
- 覆盖：`lerp(lo, hi, f)`；
- 混合：`lerp(cur, v, w)`；
- 加法：`cur + fround(v·w)`。

第 i 条轨道写第 i 个 float，超出 16 的丢掉（WPE 越界，语料 0）。上传取前 `4 × BLENDROWCOUNT` 个；重编译时保留。

### 点 1 — 编译
`ScenePuppet.textureChannels`：
- 网格视图；
- 材质 pass：网格的材质 + `BLENDROWCOUNT`，`DOUBLEBUFFERED` 照纹理组合键规则；
- 行数。

`PuppetAnimation.channels`：MDLA v≥3 的 n3 条轨道。预光照（基础材质带 LIGHTING / REFLECTION 且走合成）照报 `puppet:texture-channels:prelighting`；去掉 `puppet:texture-channels`。

### 点 2 — 运行时
`ScenePuppets.blendMap(object)`，叠法同上；`carryOver` 拷这 16 个 float。

### 点 3 — 渲染
合成路径的基础 pass 之后加一步「纹理通道」：通道网格的顶点、u16 索引，同一个合成 RT；每帧写 `g_BlendMap`。

### 点 4 — 单测与对照
`p12b2-tc` 的 `g_BlendMap` 序列按日志 dt 逐位对 WPE；合成 RT 的读回对 WPE（最大差 1 的着色器舍入除外）。

## 走查与收尾

照 `FINAL_CHECK.md`：
- **生成工程**：`p12b2-*` 9 个，用同一份抓帧，整帧逐像素对照。
- **复制工程**：`3706286085` 只留模型，雾与阴影的字段换成关闭；`3811424158` 的 `01_z` 能画到的部分。
- **不变**：P12a、P12b1 的生成工程。

收尾：WPE_SCENE.md、cocs 索引、回归、changelog、PLAN 与总计划进度。

## 实施记录

### 步骤 0a — 语料与翻译器预检（2026-11-15，代理，报告 `ignore/p12/b2/corpus/report.txt`）

HEAD `2fc14669` 快照重扫 233 张，能渲染 163 张。P12b2 不解锁任何场景。

**纹理通道**：全语料只有 `3811424158` 的 `01_z`（`01_z_puppet.mdl`）一处：
- 通道网格是网格 1（唯一的 bit1 网格，44 个顶点），`BLENDROWCOUNT` = 1；
- 动画 231 有 4 条通道轨道（n3 = 4），但对象没有 `animationlayers`，没有层引用它；
- 材质 `puppettexturechannels`、normal 混合，槽 1 有纹理 → `DOUBLEBUFFERED` = 1；
- 不带 LIGHTING / REFLECTION，不走预光照路径；
- 没有越界组合。

**模型骨骼**：147 个模型对象里 6 个带骨骼段，分在 2 张场景，着色器全是 `generic4`：

| 场景 | 对象 | 骨骼 → `BONECOUNT` | 网格 | 变形 | 动画层 |
|---|---|---|---|---|---|
| `3662790108` | deimos | 2 → 16 | 1，normal | 无 | 无，保持绑定姿势 |
| `3706286085` | FBX_Stage | 2 → 16 | 43 | 无 | 1 层，`rate` 挂脚本 |
| `3706286085` | RioSonic | 79 → 128 | 6，normal | 无 | 5 层，`rate` / `blend` 挂 7 处脚本 |
| `3706286085` | BoostModel1/2/3（共用 mdl） | 3 → 16 | 4（164 / 380 / 304 / 164 顶点），additive | 每网格 2 个目标，带 bit10，没有 bit11 | 各 2 个加法层 |

- 全部网格带 `a_BlendIndices`（`SKINNING` 全为 1）。
- 没有挂点段、`rootmotion`、物理骨骼。
- 所有动画都没有变形权重轨道，v5 包围盒全部有效。
- **更正读码**：RioSonic 是 5 层，不是 1 层（Claude 核过）。层 3、4 的 `blend` 初值是 0（脚本驱动），所以「权重 0 的层整层跳过」「全部为 0 时直接用 MDLS 局部矩阵」会被实际用到。

**做完 P12b2 后各场景还差**：
- `3811424158`：精灵表帧动画（`combo:SPRITESHEET`、`tex:animation`）。
- `3706286085`：P13 的雾 10 项、方向光阴影（`shadowcaster` 现在翻不了，归 P13）、挂在 RioSonic 下的点光（`object:parent`，P13f），以及**模型动画层上的 8 个字段脚本**。后者现在被 `object:animationlayers` 盖住；图像层 puppet 上同样的写法报 `puppet:layer-script`，归 P12c。
- `3662790108`：还剩 18 项（透视文本、预光照、缺 9 个材质、挂父对象的灯、媒体回调等）。

**翻译器预检**（433 次）：
- 语料管线的 234 个真实请求全部能译；`generic4` 在 `SKINNING` × `BONECOUNT` 16 / 32 / 64 / 128 × `MORPHING` × `MORPHING_NORMALS` 的 32 种组合全部能译；`puppettexturechannels` 在 `BLENDROWCOUNT` 1–5、`DOUBLEBUFFERED` 各写法都能译。
- 反射：
  - `g_Bones` 是 `array<mat4x3<f32>, BONECOUNT>`（每骨骼 64 字节，同 P12a）；
  - `g_MorphOffsets` / `g_MorphWeights` 是 `array<vec4<u32 / f32>, 12>`，只用 `.x`；
  - `gl_VertexID` 翻成 `vertex_index`；
  - `g_BlendMap` 是 `array<vec4<f32>, BLENDROWCOUNT>`。
- 不能译的语料都没用到：
  - `BLENDROWCOUNT` 0；
  - `foliage4` / `fur4` / `chroma4` 的 `MORPHING` 1（纹理当函数参数传）；
  - `shadowcaster`（`gl_ViewportIndex`，归 P13）。

**两处 WPE 缺陷**在语料里都不表现：BoostModel 的变形网格顶点数确实不同，但权重恒 0；四个骨骼 mdl 的网格都是同一类混合，不换序。只能靠 0c 的生成工程区分。

### 步骤 0b、0c — WPE 实测（2026-11-15，代理，报告 `ignore/p12/b2/meas/report.txt`）

读码第 9 条「没有任何实测」的各项**全部成立，没有不一致**。
- 生成定义：`ignore/p12/b2/gen/defs/p12b2.py`。
- 抓帧：`A:\p12\b2\`、`A:\p12\b2\gen\`。
- WPE 全程没崩，错误日志为空；设置没改。

**真实壁纸**：
- `3811424158` 的 `01_z`（隔离副本）：
  - 通道网格那次 draw 存在，画进合成 RT、在基础四边形之后；
  - 前后合成 RT 逐像素相同，`g_BlendMap` 全 0；
  - `BLENDROWCOUNT` = 1，`DOUBLEBUFFERED` = 1；
  - MVP 是 `ortho(0, W, 0, H)`、y 向上，混合关。
- `3706286085`：
  - `BONECOUNT` 128 / 16 / 16，`g_Bones` 反射大小 48 × `BONECOUNT`；
  - BoostModel 是 `MORPHING` = 1、`MORPHING_NORMALS` = 1；`g_MorphOffsets[0]` = 0，`g_MorphWeights[0]` = 各网格的 MDMP 缩放；
  - 变形纹理边长 23 / 34 / 31 与公式相同；
  - 骨骼矩阵逐帧在变，同一对象的所有网格（含阴影 pass）共用一份 `g_Bones`。
- `3662790108`：原场景三帧都没画 deimos；把原 mdl 放进生成工程，保持绑定姿势（K ≈ I，逐帧不变）。

**生成工程**：模型和同 mdl、同动画层的图像层 puppet 放在一起逐位比。
- **骨骼动画**：
  - 覆盖、混合、加法下模型与 puppet 的 `g_Bones` 逐位相同；
  - 权重 0 的层整层跳过；全部为 0 等于没有层，走 MDLS 局部矩阵、不经分解；
  - `BONECOUNT` 3 或 4 根 → 16、17 根 → 32，`cb2` 按 48 × `BONECOUNT` 映射。
- **隐藏冻结**：
  - 模型自己或父链隐藏时时钟冻结，图像层 puppet 照常推进；
  - **读码没写的时机**：第 f 帧的更新看第 f−1 帧脚本写下的可见性，重新可见的第一帧会画出来，但那帧的更新已被跳过。
- **变形**：66 处预测全部一致。
  - 覆盖不钳制（1.5、−0.3 原样）；混合钳 [0, 1]；加法夹在 [min(cur, d), max(cur, d)]（0.4 加 0.3 得 0.4）；
  - 只取下标最前的 11 个生效目标再按权重排；
  - 变形纹理的 i16 分量逐个相同（带 bit10 时位置、法线交错）。
- **两处 WPE 缺陷实测成立**：
  - 偏移用最后一个变形网格的顶点数：实测 [2, 4, 8]，按各网格自己的顶点数应是 [2, 8, 16]；
  - 排序后按记录下标取缩放与权重：先画的不透明网格 1 用了网格 0 的缩放 40 和权重。
- **挂点**：模型与 puppet 的子对象 MVP 36 对逐位相同，按 `W · B[骨骼] · Att · L` 预测误差 ≤ 1.5e−7；没有层时 B 是绑定姿势。
- **纹理通道**：
  - `g_BlendMap` 每帧不复位（单个混合层收敛到 v）、加法层每帧加 `fround(v·w)`、不钳制；
  - `BLENDROWCOUNT` 1–4 读回 4 / 8 / 12 / 16 个 float；
  - 合成 RT 对着色器公式最大差 1；
  - `DOUBLEBUFFERED` 下全 0 时片元全丢，`DOUBLEBUFFERED` 0 的分支也对。
- **剔除盒**：有可见层时按可见层动画包围盒的并剔除（权重 0 的可见层也算），没有可见层时退回 mdl 包围盒。
- **加做**：模型不读 MDLS 的可选骨骼矩阵（mdl+0x48），图像层 puppet 读。
- **顺带**：图像层 puppet **不跳过**权重 0 的非加法层。P12a 运行时本来就不跳过（`player.ts` 的层循环，Claude 核过），两者一致；模型要跳过。

**没做**：
- 同一 mdl 里混有不带 `a_BlendIndices` 的网格（WPE 稳不稳没把握）；
- 预光照下纹理通道走 RT 的路径；
- 只有 bit10 而没有变形目标的网格；
- 挂点在第一帧之前就有值（测试窗口抓不到首帧）。

### P12b2-1 — 实现（2026-11-15，执行代理，主工作区，报告 `ignore/p12/b2/impl/step1.txt`）

- **实现**：照点 1–4，设计没有缺口。
  - 运行时是 `ScenePuppets` 的 `kind`；`puppetEntries` 统一宿主与探针的建立，模型不会漏。
  - 可见性门经 `stateSink` 读状态，只在推进时判。
  - 新增照报 `mdl:morph:vertices`（MDMP 的 nv ≠ 网格顶点数，WPE 读出界，语料 0）。
  - 模型上 `MDLE0002` 改中性，读码说模型不读它。
- **检查**：
  - tsc 0 error；
  - 新测试 `puppet/model.test.ts`、`compile/p12b2.test.ts`，加上 `render/p12b.test.ts` 的追加，按 `p12b2-*` 抓帧常量逐位回放；
  - 26 个相关文件全过，`probe.*` 的 `spriteSamples` 失败来自别的会话 P13c 未提交的改动；
  - 本机语料 `3706286085` 只剩 P13 的键、`object:parent`、`puppet:layer-script`；
  - `g_Bones` 的容差放到「中间量的 2e−6 倍」（K = B · 逆绑定，相消后 `rsqrtps` 的末位放大），实测最大 7.45e−7 倍，逻辑错误是 1e−2 量级。
- **变异**：执行代理做了 6 处，都被抓住：
  - 不跳权重 0；
  - 隐藏不冻结；
  - 混合不钳；
  - `BONECOUNT` 不取 2 的幂；
  - 偏移用最后一个网格的顶点数；
  - B1 更新阶段不含模型。
  
  Claude 另做 1 处（加法不乘权重），也被抓住。
- **Claude 复核**：叠法、更新门、权重 0 跳过与读码逐条对过。改了一处：没有包围盒的动画（MDLA v < 5）原来跳过，改成按全 0 盒子并进剔除盒，同 WPE 动画记录的初值（推断，语料全是 v5）。
- **没覆盖**：
  - 加载后第一次更新之前的 K 初值：WPE 是单位阵，我们按 t = 0 算一次，只在从加载起一直不可见的模型上不同；
  - 平面反射 pass 里的带骨骼模型；
  - 同一 mdl 里 `SKINNING` 0 / 1 并存（WPE 行为没实测）；
  - 目标数超过 64（WPE 的位图取模 64）；
  - 组里的模型。

### P12b2-1 — 真机对照（2026-11-15，代理，宿主产物 `index-Dgcvw3Jl.js`，报告 `ignore/p12/b2/check1/report.txt`）

- **生成工程**用步骤 0 的同一份抓帧：
  - `mdl` 8 帧、`mdl2` 6 帧、`vis` 30 帧（含重新可见的第一帧）、`att`、`cull`、`rest`、`deimos` 各 6 帧，整帧全部逐像素相同；
  - MVP 与 `g_ModelMatrix` 逐位相同，`g_Bones` 逐位相同或差 ≤ 64 ulp（K2，模型与同层的图像层 puppet 差得一模一样）。
- **`morph`**：差异只落在两处缺陷涉及的 3 个 draw 上，数值就是正确做法（Claude 抽查过常量对照）：
  - `mo_two` 网格 0 的偏移：WPE [2, 4, 8]，我们 [2, 8, 16]；
  - `mo_sort` 两个网格的缩放与权重：WPE 互相借用，我们各取各的。
  
  其余 10 个变形 draw 常量逐位相同。
- **不变**：`p12-modes`、`p12-fx`、`p12-am`、`p12-att`、`p12-clip2` 各 2 帧，和 B1 修复后的帧逐字节相同。
- **`3706286085` 复制工程**：
  - **范围**：只留 RioSonic、BoostModel、FBX_Stage；脚本字段换成固定值，关雾、关方向光阴影。
  - **骨骼**：61 个带骨骼的 draw 的矩阵逐位相同，`g_Bones` 在 K2 量级，组合键与变形 uniform 逐位相同。
  - **城市边缘的细碎差**：FBX 骨骼 1 的旋转 33 ulp 被绑定平移 −161200 的力臂放大，K2；它逐位相同的那一帧城市 0 差。
  - **Sonic 手套、鞋、扣子的颜色差，与骨骼无关**：WPE 亮 1.15–1.31 倍，像素着色器多一项 `albedo · tint · emissive · mask.a · 0.35`。推断我们 `generic4` 的 PBRMASKS 遮罩少了 emissive 那一项，而且没照报（F1，不属 P12b2，已报告用户）。

## 风险

1. **没有能解锁的场景**：只能靠生成工程与复制工程验收，真实壁纸整张要等别的节。
2. **两处 WPE 缺陷不照抄**（决定 1）：「多个变形网格顶点数不同」「半透明网格排在前面」时画面和 WPE 不同；语料不表现。
3. **模型变形纹理格式**：WPE 是 `rgba16snorm`，我们同 P12b1 改用 `rgba32float`，布局按模型的 i16 分量流重排。
