# P5c — 静态网格（子计划）

> 上级：[phase-5-camera-mesh.md](phase-5-camera-mesh.md)「P5c」。读码见 [rea-p5-mesh](rea-p5-mesh.md)（全部没有实测），深度与剔除的前置几条在 [p5-REPORT](p5-REPORT.md)「P5a 语义的实测核对」里实测过。
> 语料是 2026-11-12 在 `a261a3b9` 之后的扫描（`ignore/p5/b5/corpus-idx2.json`，173 个场景，能渲染 47 张），模型对象逐个细分在 `ignore/p5/c0/out/scan_mesh.txt`（`scan_mesh.py`，照 rea 的 `mdl.py` 解析）。
> 现状锚点取自 `849a094f`。P4e、P6b、P7、P8、P9 在别的会话进行，也改 `compile/features.ts`、`compile/bundle.ts`、`render/scene.ts`、`render/programs.ts`；每个实现步骤动工前再核对一次共享文件，并行期在 HEAD 快照里实现再三方合并。
> 分步：步骤 0 只调研；步骤 1 起每步能单独验收、单独提交，各步的现状锚点、点和验收在步骤 0 之后补全（同 P5a、P5b 的做法）。

## 总体设计思路

模型对象是第三种有内容的图层，和粒子一样挂在 `SceneLayer` 上（`layer.model`），不另开一张表。这样 `objects` 顺序、父链的世界矩阵与可见性、视差、组的归属、属性绑定这些现成的机制都直接适用：一个模型对象就是一个图层，只是它「画什么」从图层四边形换成 mdl 里的若干个网格。

**编译。** mdl 在编译 Worker 里解析（新文件 `compile/mdl.ts`）。WPE 所有版本走同一个加载函数，各段按版本号门槛读，所以解析器也只有一个函数：读文件头、逐个网格读材质表、标志、包围盒、顶点格式、顶点块与索引块，再按标签跳过尾部段。顶点与索引字节原样进 bundle，GPU 上直接当顶点缓冲、索引缓冲用，不在 CPU 上逐顶点重排。每个网格按对象的 `skin` 选一个材质，走图像层同一条 `compilePass`：静态网格不追加任何引擎 COMBO，全局宏（`HDR`、`SCENE_ORTHO`）照常。同一个 mdl 被多个对象引用时（3354366708 的两个圆环）解析一次、缓冲共用，材质按对象各编一份（`skin` 可能不同）。

**绘制。** 渲染图给模型图层排出「每个网格一次绘制」的步骤，不透明网格在前（WPE 的比较器），画到场景目标，和图像层、粒子在同一个场景 pass 里按 `objects` 顺序混排。顶点布局不再由着色器推导：按 mdl 的格式掩码照 WPE 的表序算出每个属性的偏移，再按着色器声明的 `a_*` 名字找同一语义的那一项，填 `shaderLocation`（`a_TexCoord` 和 `a_TexCoordVec4` 都是 TEXCOORD0，宽度不同由 WebGPU 截断或补 (0, 0, 0, 1)）。所以管线除了程序、混合、格式之外，还要按「网格格式」和索引宽度区分。模型的 uniform 和图像层同一套函数算，只有三处不同：`g_Color4` / `g_Color` / `g_Alpha` 固定为 1（WPE 不读模型的 `color`、`alpha`、`brightness`），`g_NormalModelMatrix` 照 WPE 的算法（读码是 3×3 各轴归一化，不是逆转置，步骤 0 实测），没有 `size`（模型矩阵就是世界矩阵）。

**深度与剔除。** 深度附件在 P5d 才建。模型材质大多不写深度键，WPE 的缺省是「测、写、剔背面」，所以模型 pass 要按 WPE 的缺省推出实际的深度状态：会写深度的（normal / alphatocoverage 且没关测试、没关写入）照报 `depthwrite:enabled` 留给 P5d；只测不写的中性，因为语料里会写深度的 pass 都已照报，场景里没有别人写过深度，GREATER 对清屏值 0 总是通过。剔除只是管线状态，不需要深度附件，模型 pass 照 WPE 的缺省（`cullmode` 缺键 = normal）在 P5c 实现；图像层、粒子的剔除缺省保持现状，等 P5d 和深度一起统一，所以现有场景的基线不受影响。

**关键决策：**
- **P5c 只做正交场景。** 语料 54 个模型对象在 13 张场景里，正交的只有 retro 和 3354366708（后者另差文本、木偶、相机对象等 18 个键），其余 11 张都是透视，归 P5d。P5c 直接解锁的只有 retro，其余是给 P5d 打底。
- **能实测的不读码。** 读码已经把 mdl 布局、顶点表序、皮肤、模型 uniform、绘制顺序、剔除状态都给出来了，步骤 0 用自己写的 mdl 编码器生成确定性工程，在 WPE 里抓帧逐条核对；读码标了【未知】的几处（着色器声明了网格没有的属性、绘制排序稳不稳定、视锥剔除在正交场景里生不生效）也靠抓帧回答，答不了才派 REA 代理。
- **能力表照旧是唯一事实来源。** `object:model` 拆成细分键（`mdl:skeleton`、`mdl:animation`、`mdl:morph`、`mdl:missing-attribute:<名>` 等），没实现的照报、整张退回。

## 范围与解锁

语料（`scan_mesh.txt`）：
- **模型对象 54 个，13 张场景。** 正交 2 张（retro 1 个、3354366708 3 个），透视 11 张。
- **mdl：** v4 9 个、v14 17 个、v16 1 个、v23 27 个（按对象数）。带 `MDLS` / `MDLA` 段的 4 个对象都在 3706286085（`FBX3`、`RioSonicLite`、3 个 `BoostModel`，后者还有 `MDMP`），归 W6。其余全部「无段或只有结尾的空标签」。
- **网格格式：** 静态网格只有 0x9、0xb、0xf、0x27 四种（位置 + uv，加法线，再加切线，0x27 是位置 + 法线 + 切线 + `a_TexCoordVec4`）。u32 索引只在 `FBX3`。
- **皮肤：** 只有 audiophile 的 `grid` 写了 `skin: 1`（2 个皮肤）。
- **对象键：** `castshadow`（14，全 false）、`solid`、`disablepropagation`、`locktransforms`、`parallaxDepth`（全 "1 1"）、`visible`（含用户属性与脚本）、`parent`（挂在分组节点下，没有挂在组合层下的）、`reflected`（3，全 true）、`dependencies`（2，3509243656，已报）、`animationlayers`（3706286085）。
- **材质 pass（130 个）：** `depthtest` 缺 84、`depthwrite` 缺 79、`cullmode` 缺 84；显式 `enabled` / `normal` 各 36–38。按 WPE 缺省，大部分模型 pass 要测深度、写深度、剔背面。
- **着色器声明了网格没有的属性：** audiophile、fantasticcar 的 `grid` 着色器声明 `a_Normal`，网格格式 0x9 没有法线（WPE 里照常显示，所以 WPE 对缺属性一定有处理）；`a_BlendIndices` / `a_BlendWeights` 23 处都在 `#if SKINNING` 里（扫描脚本不展开预处理，按实际编译为准）。
- **模型着色器读的 uniform：** `g_ModelMatrix`、`g_ViewProjectionMatrix`、`g_EyePosition`、`g_LightAmbientColor` / `g_LightSkylightColor` 最多；`g_NormalModelMatrix`、`g_Bones`、`g_Morph*`、`g_Screen` 在 `generic4` 一类着色器里（84 处）；retro 的 `bg` 只读 `g_TexelSize`。

**解锁：** retro。它是正交场景，唯一的模型 `bgfade`（v14、1 网格、格式 0x9）是全屏背景：着色器不乘矩阵，直接输出 `(a_TexCoord·2−1, 0.5, 1)`，材质 translucent、`depthwrite: disabled`、`nocull`、缺 `depthtest`（WPE 按 enabled，深度 0.5 大于清屏值 0，照常通过）。

**P5c 不做，继续报不支持：**
- 透视场景、深度附件、图像层与粒子的深度 / 剔除缺省、`transparentsorting`：P5d。
- 带 `MDLS` / `MDLA` / `MDMP` 段的 mdl、`animationlayers`、`attachment`：W6。
- `reflected`、`castshadow` 的消费者（反射 pass、阴影 pass）：P7 / P8。这两个键本身在没有消费者时不改变画面，而消费者现在都照报（读 `_rt_Reflection` 报 `texture:rendertarget:_rt_Reflection`，`REFLECTION` 非 0 报 `combo:REFLECTION`，投影灯报 `lightconfig:*`），所以在模型上中性。
- 模型对象的 `effects`（语料 0 个）、`model` 是数字（脚本 `createModelData`，语料 0 个）、模型在组合层里（语料 0 个）：照报。
- 模型对象上的脚本 API（`thisScene.getLayer` 拿到模型层）：语料里挂脚本的模型都在透视场景，照现有图层 API 走，不另做。

## 现状锚点

**a. 模型对象整个报 `object:model`**（`compile/features.ts:542`）
```ts
  } else if (kind && kind !== "image" && kind !== "light" && kind !== "sound") unsupported.add(`object:${kind}`); // 现状：model 落到这里
```

**b. 编译时没有 image 的对象到这里为止**（`compile/bundle.ts:1341`）
```ts
    // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
    if (!object.image) continue; // 现状：模型对象在 `layers` 里只是一个没有 pass 的图层
```

**c. 材质的深度 / 剔除缺键按 disabled / nocull 编译**（`compile/bundle.ts:1167`）
```ts
      cullmode: pass.cullmode ?? "nocull",     // 现状：WPE 缺键是 normal
      depthtest: pass.depthtest ?? "disabled", // 现状：WPE 缺键是 enabled
      depthwrite: pass.depthwrite ?? "disabled", // 现状：WPE 缺键是 enabled
```

**d. 顶点布局由着色器的属性推出，值是图层四边形的**（`render/programs.ts:129`、`:96`）
```ts
export function vertexPacking(attributes: readonly InterfaceVariable[], stepMode: GPUVertexStepMode = "vertex"): VertexPacking {
  // 现状：按着色器声明的顺序紧排，offset 自己累加；网格的偏移要按 mdl 格式掩码的表序算
function attributeValue(name: string, vertex: QuadVertex, column: number): number[] {
    case "a_Normal":
      return [0, 0, 1]; // 现状：四边形没有的属性补默认值
```

**e. 管线不剔除，图元只有三角形带 / 列表两种**（`render/programs.ts:308`）
```ts
      primitive: { topology, cullMode: "none" }, // 现状：没有 frontFace / cullMode，也没有按索引宽度区分
```

**f. 法线矩阵是逆转置**（`render/math.ts:146`）
```ts
/** 法线矩阵：左上 3×3 的逆转置，列主序 9 个数；不可逆时退回单位阵。 */
export function normalMatrix(m: Mat4): number[] { // 现状：读码说 WPE 是 3×3 各轴归一化
```

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

`ignore/p5/c0/scan_mesh.py` 逐个模型对象列出 mdl、网格、材质 pass 与着色器属性，结论见上「范围与解锁」。输出在 `ignore/p5/c0/out/scan_mesh.txt`。

### 0b — 确定性工程与实测（Claude）

工具同 P5b：
- mdl 用自写的编码器生成（`ignore/p5/c0/mdl_enc.py`，照 rea-p5-mesh 1.2–1.7 的布局），生成后用 rea 的 `mdl.py` 回读核对，再和语料里真实 mdl 的解析结果对照（同版本同格式逐字节同构）；
- 工程由 `ignore/p5/c0/gen_c.py` 生成（复用 `../b0/gen_b.py`、`../a0/gen_a.py`，FR / CLK 层），放在 `ignore/p5/proj/p5c-*`，场景正交 1920×1080；
- `wpe-renderdoc` MCP 抓帧，放在 `A:\p5c\<用途>\`，窗口 1920×1080；
- 读数用 `ignore/p5/b0/rdc_dump_b.py` 的导出，另加输入布局（IA 元素的语义、格式、偏移）、顶点着色器输入、光栅状态，整帧比用 `kbp rdc frame`。

不移动用户的鼠标；不开视差的工程与指针无关。

| 工程 | 构造 | 核对 |
|---|---|---|
| `p5c-layout` | v23 mdl，三个网格：A 用 12 个属性（位置、`PositionC1`、法线、切线、`BlendWeights`、各宽度的 TEXCOORD0–5、颜色），B 用另一半宽度（`PositionVec4`、`TexCoordVec4`、`BlendIndices` 等），C 是格式 0x8009 的三角形、三个顶点纯红绿蓝；每个属性的值按「属性序号 + 分量」编码 | 输入布局各元素的语义、格式、偏移和 stride 与表序一致；`BlendIndices` 是 uint；C 三个角的颜色 |
| `p5c-attr` | M1 网格有 `a_TexCoordVec4`、着色器声明 `vec2 a_TexCoord`；M2 网格没有法线、着色器声明并读 `a_Normal`；M3 同 M2 但不读；M4 网格只有 `a_TexCoord`、着色器声明 `vec4 a_TexCoordVec4` | M1 读到 xy；M2、M3 画不画、读到什么、日志有没有报错；M4 的 zw |
| `p5c-ver` | 同一个四边形按 v4、v14、v16、v23 各编一份（v23 带包围盒、两个可选块为空、记录表为空），另加 u32 索引一份、尾部带一个不认识的段一份 | 各版本都画出同样的四边形；u32 索引；不认识的段被跳过 |
| `p5c-color` | 模型对象写 `color "1 0 0"`、`alpha 0.5`、`brightness 3`，着色器输出 `g_Color4`，并读 `g_Color`、`g_Alpha`、`g_UserAlpha`、`g_Brightness`；HDR 开一份 | 读码预测全是 1、画面纯白不透明 |
| `p5c-skin` | 2 个皮肤（红、蓝两个材质），对象 `skin` 取缺省、0、1、5、−1、`"1"`、`1.0`、`true` | 选到哪个材质（读码：min(skin, N−1)，只认整数） |
| `p5c-matrix` | 模型 `scale "1 4 1"`、`angles "0.3 0 0.5"`、挂在一个带变换的分组节点下；着色器读 `g_ModelMatrix`、`g_ModelMatrixInverse`、`g_NormalModelMatrix`、`g_ModelViewProjectionMatrix`、`g_ViewProjectionMatrix`、`g_EyePosition`；另开视差一份、`zoom 1.5` 一份、模型 `perspective: true` 一份 | 各矩阵的值；法线矩阵是「各轴归一化」还是「逆转置」；视差、缩放、透视覆盖对模型的作用和图像层相同 |
| `p5c-order` | 一个 mdl 4 个网格：translucent、normal、additive、normal；另一个 40 个网格交替 | 不透明的先画；40 个网格时同类网格的顺序（introsort 小于 32 个时是插入排序，稳定） |
| `p5c-cull` | 屏幕上逆时针、顺时针两个三角形，`cullmode` 缺键 / normal / nocull 三组（`depthtest: disabled`，排除深度） | 光栅状态 `CullMode`、`FrontCounterClockwise`；逆时针恒可见、顺时针只在 nocull 时可见 |
| `p5c-frustum` | 着色器不乘矩阵、直接输出裁剪坐标（同 retro）：v23 网格的包围盒放在场景外；同几何的 v14 版本；包围盒部分在场景内一份；补测三个「盒子在外、外接球伸进来」的（立方体、扁盒各一，扁盒另一个够不到） | 正交场景里视锥剔除生不生效、按什么判 |
| `p5c-depth` | 正交场景，两个 normal 混合、缺深度键的模型前后重叠（z 不同），`objects` 里远的在后 | 确认正交场景里模型照样测深度、写深度（P5d 的事，P5c 只用来确定「会写深度」的判定） |

真实样本：retro。WPE 窗口取 2520×1080（和场景同尺寸，避开 `g_TexelSize` 按窗口尺寸算的差别），按 `kbp content unpack --instrument` 的日志在 Kabegame 里回放同一时刻比整帧；它属于步骤 2 的验收，步骤 0 只抓一份留作对照。

**验收：** 每条读码结论和每个【未知】都有工程对上，或者写明被推翻的地方和改正后的规则；结论写进 [p5-REPORT.md](p5-REPORT.md) 新的「P5c 语义的实测核对」一节；对各步的影响写进本文件的实施记录，并补全各步的现状锚点、点和验收。

### 0c — 读码补查（只在抓帧解决不了时）

候选（先不派代理）：
- 着色器声明了网格没有的属性时 WPE 的处理（`FUN_1400d81b8` 之后的错误分支）：`p5c-attr` 的 M2、M3 能直接看到结果，只在结果看不懂时补读。
- 绘制排序的稳定性：`p5c-order` 的 40 个网格能直接看到。

### 步骤 0 实施记录（2026-11-12）

结论全在 [p5-REPORT.md](p5-REPORT.md)「P5c 语义的实测核对」：12 个确定性工程加 retro，读码的结论全部成立，标了【推】【未知】的几处也测清了。推翻一处：`skin` 为负数时取 0，不是最后一项。0c 的读码补查不需要了。

**定下来的规则：**
- **mdl：** 一个加载函数、按版本门槛读，v4–v23 都对；索引 bit0 定宽度，bit1 多读一个 u32；不认识的尾部段跳过。编码器对语料 46 个静态 mdl 往返逐字节一致，解析器的单测可以直接拿这些文件和编码器的输出当夹具。
- **顶点布局：** 偏移按表序，属性按语义配对（TEXCOORDn 的三种宽度、POSITION 的两种共用一个槽），分量少了截断、多了补 (0, 0, 0, 1)，WebGPU 的格式与着色器类型分量数不同时是同样的规则。
- **缺属性：** 着色器声明了却没读的，WPE 的 fxc 把它从输入签名里去掉，正常画；读了的，WPE 建不出输入布局，画出来是未定义的值。所以只有「读了」才报 `mdl:missing-attribute:<名>`；没读的要给 WebGPU 一个占位（翻译器的 WGSL 入口可能仍带这个 location），值无所谓。
- **模型 uniform：** `g_Color4` / `g_Color` / `g_Alpha` 固定 1；`g_NormalModelMatrix` 是世界矩阵 3×3 的三个本地轴各自归一化，用 `0x5f375a86` 快速倒数平方根加一次牛顿迭代、按 float32 算（实测逐位到 1.2e-7）。WPE 的 uniform 写入函数是所有对象共用的，图像层的 `genericimage2/3/4` 在光照路径里也读它，所以改成全局的，有光照的基线要重核。
- **皮肤：** 非负整数（含 `1.0`）取 min(skin, N − 1)，其余（负数、字符串、布尔、缺键）取 0。
- **排序：** 比较器「a 不透明（normal / alphatocoverage）且 b 半透明（translucent / additive）」，照 MSVC STL 的 `std::sort` 移植（`sim_sort.py` 已逐个复现 40 个网格的顺序），≤ 32 个网格时就是稳定排序。
- **剔除：** 模型 pass 照 WPE 缺省（缺 `cullmode` = normal），`frontFace: "ccw"`、`cullMode: "back"`，只看屏幕上的绕序。
- **视锥剔除：** 正交场景里生效，按 mdl 全部网格包围盒的并集（v < 17 没有包围盒、不剔）：两角经世界矩阵变换，中点为球心、半对角线为半径，和视图投影的六个平面比，球完全在某个平面外就整个模型不画。retro 这类不乘矩阵的着色器会被它影响，所以要做。
- **视差、缩放、透视：** 模型和图像层完全相同；模型 `perspective: true` 就是 P5b 透视图层那一套，一起实现（语料 0 个，代价只是放开一个条件）。
- **深度（P5d）：** 正交场景里模型也测深度、写深度，缺键为开；translucent / additive 只测不写。P5c 把「会写深度」的模型 pass 照报 `depthwrite:enabled`。

**对各步的影响：** 按提纲分两步，内容见下表。翻译器要给 `attributes` 也标 `unused`（照 uniform 的做法，入口可达的代码没读到就标），宿主据此决定缺属性报不报；这是 `src-tauri/wpesl2wgsl` 的改动，动工前看一次 P7 会话的翻译器工作区。

## 分步

| 步骤 | 内容 |
|---|---|
| 0 调研 | 已完成（上面的实施记录） |
| 1 编译 | 翻译器 `attributes` 标 `unused`；`compile/mdl.ts` 解析器（全部版本、包围盒并集、尾部段）；模型图层 `layer.model`（网格的顶点 / 索引字节、格式、stride、索引宽度，按 `skin` 选的材质 pass；同一个 mdl 只解析一次）；模型 pass 的深度 / 剔除按 WPE 缺省推，会写深度的照报；能力表把 `object:model` 拆成细分键（`mdl:skeleton` / `mdl:animation` / `mdl:morph`、不支持的已知段、木偶数据、未知网格标志、`mdl:missing-attribute:<名>`、模型是数字、模型带 effect、模型在组里），`skin`、`castshadow`、`reflected`、`solid` 等中性；绘制没接上之前另报过渡键 `model:pending`，不解锁 |
| 2 绘制 | 按格式掩码建顶点布局（按语义配对，没读的缺属性给占位），索引缓冲，网格绘制步骤（MSVC 排序），模型 uniform（`g_Color4` = 1、法线矩阵全局改成快速倒数平方根），模型 pass 的剔除，模型 `perspective`，视锥剔除；去掉 `model:pending`，retro 解锁；确定性工程与 WPE 逐像素比、retro 按日志回放比 |
| 收尾 | 未实测清单走查、文档（`cocs/wpe/WPE_SCENE.md`、回归、changelog） |

**未实测（留到收尾走查）：** 视差、抖动下视锥平面用不用这次绘制的偏移（WPE 在场景绘制开头算一次平面，读码推断不带每个对象的视差）；模型在组合层里（语料 0 个，照报）。

## 步骤 1 — 编译

### 思路

这一步只动编译侧与翻译器，渲染器不动：模型对象读进 bundle、能力表细分，绘制在步骤 2 接上，所以另报过渡键 `model:pending`，任何场景都不会因此解锁或改变画面。

翻译器给顶点属性也标 `unused`。naga 的 GLSL 前端把每个声明的输入都做成入口参数（WGSL 里照样带 `@location`），入口包装函数先把参数 `Store` 进同名的私有全局变量，再调用户的 `main`；compact 之后，还有 `Load`（直接或经 `AccessIndex` / `Access` 链）落在这个全局变量上，就算读了。这和 uniform 的 `unused` 同一个判据、同一个已知差别（结果没被用到的读 naga 算读、fxc 会删）。只改反射，WGSL 逐字节不变。

mdl 解析器照 WPE 的加载函数写成一个函数（`compile/mdl.ts`），各段按版本门槛读，读越界就整个报 `mdl:truncated`（WPE 的读取原语越界返回 0，语料全部恰好读到末尾，没有截断的样本，所以不猜）。顶点与索引字节用文件缓冲的视图，不拷贝。包围盒并集、版本、尾部段标签都留在结果里，网格的绘制顺序（MSVC `std::sort` 的移植）也在编译期排好，步骤 2 的渲染器直接用。

模型 pass 的深度与剔除按 WPE 的缺省推（缺 `depthtest` / `depthwrite` 为 enabled，缺 `cullmode` 为 normal），推出的值写进 `ScenePass`，步骤 2 的管线照它建。会写深度的照报 `depthwrite:enabled`（P5d），只测不写中性，剔除在模型上支持。图像层、粒子的这三个缺省和检查都不动。

### 现状锚点

**a. 翻译器的属性反射没有 `unused`**（`src-tauri/wpesl2wgsl/src/lib.rs:522`）
```rust
fn interfaces(decls: &[rewrite::InterfaceDecl]) -> Vec<Interface> {
    decls
        .iter()
        .map(|decl| Interface {
            name: decl.name.clone(),
            location: decl.location,
            ty: decl.ty.clone(),
            array: decl.array, // 现状：属性与 varying 共用，没有「读没读」
        })
        .collect()
}
```

**b. 对象循环只认粒子、声音、图像**（`compile/bundle.ts:1304`、`:1314`）
```ts
    if (objectKind(object) === "particle") {
      await compileParticle(index, object, layer);
      continue;
    }
    // …声音对象…
    if (!object.image) continue; // 现状：模型对象到这里为止，只是一个没有 pass 的图层
```

**c. 能力表：模型对象整个报 `object:model`，`castshadow` 等对象开关照报**（`compile/features.ts:523`、`:228`、`:534`）
```ts
  } else if (kind && kind !== "image" && kind !== "light" && kind !== "sound") unsupported.add(`object:${kind}`);
const OBJECT_FLAGS = ["fullscreen", "passthrough", "attachment", "castshadow", "disablepropagation", "reflected", "skin"];
  if (active(object.perspective) && !(kind === "image" && object.perspective === true)) unsupported.add("object:perspective");
```

**d. 材质 pass 的深度 / 剔除检查只有一种**（`compile/features.ts:725`；缺省见上面的现状锚点 c）
```ts
export function checkPassFeatures(pass: MaterialPass, unsupported: Set<string>): void {
  if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`); // 现状：缺键当 nocull
  if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`);
```

### 点 1 — 翻译器：属性的 `unused`（`src-tauri/wpesl2wgsl`）
- **修改** `naga_stage::Compiled` **新增** `inputs_read: BTreeSet<String>`：compact 之后，入口可达函数里 `Load` 链的根是私有全局变量的名字。和 `read_members` 共用一次 compact。
- **修改** `Interface` **新增** `unused: bool`（为假时不输出）；`interfaces` 给属性传顶点阶段的 `inputs_read`，varying 恒为假。
```rust
pub struct Interface {
    pub name: String,
    pub location: u32,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub array: Option<u32>,
    /// 新增：只用于属性。顶点阶段入口可达的代码没读它（naga compact 后没有落在它上面的 `Load`）。WPE 的 fxc 把没读的输入从
    /// 签名里去掉，网格缺这个属性也照常画（p5-REPORT `p5c-attr` 的 M3）。为假时不输出。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unused: bool,
}
```
- **新增** 单测：声明不读 → `unused`；直接读、只读分量、在被 `main` 调用的函数里读 → 不标；只在没被调用的函数里读 → 标；WGSL 与不标时逐字节相同。
- **修改** README 的反射表，在「没被读的 uniform」旁边加「没被读的属性」。
- **修改** `apps/wpe-scene/src/wpesl2wgsl/index.ts` 的 `InterfaceVariable` 加 `unused?: boolean`。

### 点 2 — mdl 解析（新增 `compile/mdl.ts`）
- **新增** 属性表 `MDL_ATTRIBUTES`（表序：掩码、字节、名字、语义、语义号、分量数、`float` / `uint`），`mdlStride(format)`、`attributeSemantic(name)`。
- **新增** `parseMdl(bytes): MdlFile`，照 rea-p5-mesh 1.2–1.7：
```ts
export interface MdlMesh {
  /** 每个皮肤一个材质路径（长度 = 文件头的皮肤数）。 */
  materials: string[];
  flags: number;
  /** 顶点格式（v < 15 取文件头的）。 */
  format: number;
  stride: number;
  /** 原文件缓冲上的视图，不拷贝。 */
  vertices: Uint8Array;
  indices: Uint8Array;
  vertexCount: number; // floor(顶点字节 / stride)
  indexFormat: "uint16" | "uint32"; // flags bit0
  indexCount: number;
  /** v ≥ 17 的包围盒（min xyz、max xyz），否则 null。 */
  bounds: number[] | null;
  /** v ≥ 21 的两个可选块、v ≥ 23 的记录表非空（木偶数据）。 */
  puppet: boolean;
}
export interface MdlFile {
  version: number; // atoi(魔数 + 4)
  skins: number;
  meshes: MdlMesh[];
  /** 全部网格包围盒的并集；并集不满足 max.x > min.x 时 ±131072（rea 1.6）。 */
  bounds: number[];
  /** 尾部段的标签（v > 12），按出现顺序。 */
  sections: string[];
  /** 读越界（文件被截断）。 */
  truncated: boolean;
}
```
- **新增** `meshDrawOrder(opaque: boolean[]): number[]`：MSVC STL `std::sort` 的移植（`_Sort_unchecked`、`_Partition_by_median_guess_unchecked`、`_Guess_median_unchecked`、`_Med3_unchecked`、插入排序，`_ISORT_MAX` 32），比较器「a 不透明且 b 半透明」，照 `ignore/p5/c0/sim_sort.py`。
- **新增** `meshSkin(skin, count)`：非负整数取 `min(skin, count − 1)`，其余 0（`p5c-skin`）。

### 点 3 — 模型图层（`compile/bundle.ts`）
- **新增** `SceneLayer.model: SceneModel | null`（其余对象为 null）：
```ts
export interface SceneMesh {
  format: number;
  stride: number;
  vertices: Uint8Array;
  indices: Uint8Array;
  vertexCount: number;
  indexFormat: "uint16" | "uint32";
  indexCount: number;
  /** 按 `skin` 选中的材质路径与它的 pass（语料都是一个 pass）。 */
  material: string;
  passes: ScenePass[];
}
export interface SceneModel {
  /** 对象的 `model` 路径。 */
  path: string;
  version: number;
  meshes: SceneMesh[];
  /** 绘制顺序（网格下标，`meshDrawOrder`）。 */
  order: number[];
  /** 视锥剔除用的包围盒并集（`MdlFile.bounds`）。 */
  bounds: number[];
}
```
- **修改** 对象循环：`objectKind(object) === "model"` 时调 `compileModel` 后 `continue`。`layer.perspective` 对模型同样取 `object.perspective === true`。
- **新增** `compileModel`：`model` 不是字符串报 `model:id`；读文件（`fs.read`，同一路径编译期只解析一次）；读不到报 `mdl:missing:<路径>`；解析后按点 4 报键；每个网格按 `meshSkin` 选材质、`parseMaterial`，每个 pass `compilePass(pass, { key: "objects/<i>/meshes/<m>/passes/<k>", model: true })`；最后报 `model:pending`。
- **修改** `PassContext` **新增** `model?: boolean`：`checkPassFeatures` 走模型规则（点 4）；`ScenePass` 的三个状态按 WPE 缺省写（`cullmode ?? "normal"`、`depthtest ?? "enabled"`、`depthwrite ?? "enabled"`）。
- **修改** `transferableBuffers` 带上 mdl 文件缓冲（去重）。
- **修改** 组的检查：模型在组里报 `model:passthrough:children:model`（`groupChildIssues`）。

### 点 4 — 能力表（`compile/features.ts`）
- **修改** `checkObjectFeatures`：`kind === "model"` 不再报 `object:model`；模型上 `skin`、`castshadow`、`reflected`、`disablepropagation` 中性（`OBJECT_FLAGS` 跳过），`perspective === true` 中性；`effects` 非空报 `model:effects`。图像、粒子等对象上这几个键照旧。
- **新增** `checkMdlFeatures(file, unsupported)`：
  - `truncated` → `mdl:truncated`；
  - 段：`MDLS*` → `mdl:skeleton`，`MDLA*` → `mdl:animation`，`MDMP0001` → `mdl:morph`，`MDAT0001` → `mdl:attachment`，`MDLE0002` → `mdl:skeleton`；其余标签跳过（WPE 同样跳过，`p5c-ver` 的 S14 / S23）；
  - 网格 `puppet` → `mdl:puppet`；标志除 bit0、bit1 外还有位 → `mdl:flags:<十六进制>`；
  - 格式有表外的位，或同一个语义出现两次 → `mdl:format:<十六进制>`；
  - 材质多于一个 pass → `mdl:material-passes`（语料 0 个，WPE 怎么画没测）。
- **新增** `checkMeshAttributes(program, format, unsupported)`：程序的属性里不带 `unused` 的，按名字查语义（不在表里报 `mdl:attribute:<名>`），网格格式没有这个语义报 `mdl:missing-attribute:<名>`（`p5c-attr` 的 M2、M5）。
- **修改** `checkPassFeatures(pass, unsupported, { model })`：`model` 为真时 `cullmode` 只认缺键 / `normal` / `nocull`，`depthtest` 只认缺键 / `enabled` / `disabled`，其余取值照报；会写深度（`writesDepth`，且 `depthwrite` 缺键或 `enabled`）报 `depthwrite:enabled`；其余检查同图像层。

### 点 5 — 单测（新增 `compile/mdl.test.ts`、`compile/p5c.test.ts`，翻译器在 `lib.rs`）
- `mdl.test.ts`：
  - 语料（有 `KABEGAME_WPE_ROOT` 时）retro 的 `bgfade.mdl`：155 字节、v14、格式 9、4 顶点 6 索引、没有段；
  - 测试里写一个小编码器（照 `ignore/p5/c0/mdl_enc.py`）造字节：v4 / v14 / v16 / v17 / v21 / v23、u32 索引、bit1、不认识的段、`MDLS` 段、截断、木偶记录表；
  - `p5c-layout` 两种格式的偏移与 stride；
  - `meshDrawOrder`：5 个网格 `[1, 3, 4, 0, 2]`，40 个网格逐个等于 `p5c-order` 的实测；≤ 32 个时等于稳定排序；
  - `meshSkin`：`p5c-skin` 的 8 种写法。
- `p5c.test.ts`（编译）：模型对象进 `layer.model`、报 `model:pending`、不报 `object:model`；`skin` 选材质；同一 mdl 两个对象只读一次文件；模型 pass 的三个状态按 WPE 缺省；会写深度报 `depthwrite:enabled`、只测不写不报；`mdl:missing-attribute` 只对读了的属性报（M2 / M3 两种着色器，用真翻译器）；`mdl:*` 各键；`model:id`、`model:effects`、模型在组里；`castshadow` 等在模型上不报、在图像层上照报；`transferableBuffers` 含 mdl 缓冲。
- 翻译器：点 1 的单测。

### 实施方式

子代理实现。宿主的改动在 HEAD 快照 `ignore/p5/c1/head`（`ffa0e061`）里做；翻译器的文件在工作区和 HEAD 相同，直接在工作区改，wasm 用 cargo 编到工作区的 target 后只拷进快照（`ignore/p5/c1/head/src/wpesl2wgsl/wpesl2wgsl.wasm`），不动 `bin/wasm` 与 `apps/wpe-scene/src/wpesl2wgsl/`，提交时再由我重建。

### 验收

子代理：`cargo test -p wpesl2wgsl` 全过（含语料测试）；快照 tsc 0 错误、vitest 除已知的 `3830255100: 219 次请求` 外全过；Prettier。

Claude 独立验收：
1. 越界检查：工作区只有翻译器的几个文件被改；快照对 HEAD 的差异只在计划内的文件。
2. 自跑 cargo test、tsc、vitest；变异检查：`unused` 判据去掉 `Load` 链、`meshSkin` 负数取最后、排序换成稳定排序、模型 pass 缺省改回 nocull / disabled、`mdl:missing-attribute` 不看 `unused`。
3. 翻译器基线：`WPESL2WGSL_BASELINE_DIR` 对改动前导出的一份逐文件比较，WGSL / GLSL 全部相同。
4. 语料 173 张：`object:model` 消失，换成 `model:pending` 与细分键，没有别的键变化；带模型的场景细分键和 `scan_mesh.txt` 对得上（3706286085 报骨骼 / 动画 / 变形，其余静态）；不带模型的场景逐张相同。
5. 画面哈希基线不变（渲染器没动，模型场景照旧退回）。
6. 三方合并进工作区，合并后再跑一次 tsc、vitest。

### 步骤 1 实施记录（2026-11-13）

子代理在 HEAD 快照（`ffa0e061`）里实现宿主侧，翻译器在工作区直接改；我独立验收后三方合并。实施期间 HEAD 前进了四次（P6b 1d 文本对象、P8 文档、P7d 3a / 3b），本步的改动依次合到 `7d80ad07`、`e5370601` 上重测，提交树是 `57e2053e` 加本步（3b 没碰本步的文件）。

**和计划不一致的地方：**
- **`SceneLayer.model` 改成可选**（`model?: SceneModel | null`）：合并时发现 P6b 1d 的 `text?` 是同样的做法（「不动各处手写的测试图层，读的地方按 null 处理」）。子代理原来给 14 个测试文件补了 `model: null`，合并时撤回成 HEAD 版本，少和并行会话抢测试文件。`compileScene` 里每个图层仍显式写 `model: null`。
- **`model:pending` 在 `compileModel` 开头报**：`model` 不是字符串、mdl 读不到这类提前返回也带着它。网格循环里看 `settled()`，快速路径只读、只查 mdl，不编网格。
- **`mdl:material-passes` 在 `compileMesh` 里报**（`MdlFile` 没有材质内容）。
- **截断按「任何越界都算」**：v ≥ 13 缺结尾空标签、段末倒退或超出文件长度都报 `mdl:truncated`（WPE 的读取原语这时读出空串、正常结束；语料 0 个，保守）。
- **木偶数据**：可选块的 u8 为真（块再空也算）或记录表项数大于 0。`mdl:flags:` 取多出来的位（`flags & ~3`），`mdl:format:` 取整个格式。
- **排序没移植堆排序那一支**：比较器只有两个等价类，一次划分就把和枢轴同类的全收进中间，递归最多两层，`_Ideal` 走不到 0。
- **翻译器的指针链**：`inputs_read` 回溯 `AccessIndex` / `Access` 链。子代理打印 naga IR 确认：整体读与 `.x` 类分量是先整体 `Load`，常量下标 `a_Color[2]`、动态下标、属性数组元素是指针链再 `Load`；补了 `inputs_read_follow_pointer_chains`。

**验收：**
- 越界：工作区只有翻译器的 `lib.rs`、`naga_stage.rs`、`README.md`；快照对 HEAD 的差异只在计划内的文件。
- 翻译器：`cargo test -p wpesl2wgsl --lib` 82 全过；改动前后各导出一次语料 WGSL / GLSL（`WPESL2WGSL_DUMP_DIR`），3740 个文件逐字节相同（`ignore/p5/c1/wgsl-head-ffa0e061` 对 `wgsl-after2`）。corpus 测试本身仍因旧夹具里的「夹具失败、重放通过」记录失败，改动前后一样。
- 宿主：提交树 tsc 0 错误；vitest 2200 通过，只有以前就有的 `3830255100: 219 次请求`；Prettier 通过；合并后的工作区 tsc 0 错误。
- 变异（`ignore/p5/c1/mutate_s1.py`，快照模式）18 处全部检出、还原后整树哈希一致：skin 负数取最后、稳定排序、模型 pass 缺省回到 nocull / disabled、模型缺 depthwrite 不报、`mdl:missing-attribute` 不看 `unused`、模型上 castshadow 照报、MDLS 不报、包围盒不退化、记录表不算木偶、索引一律 u16、v < 15 读网格格式、bit1 不多读、`object:model` 照报、不报 `model:pending`、不转移 mdl 缓冲、不按 skin 选材质、不排顺序。翻译器手工变异 2 处（`mutate_rust.py`）：去掉指针链回溯、把 `Store` 也算读，都检出（指针链那处第一轮漏检，补用例后检出）。
- 语料 173 张（配同一份 wasm 的对照）：只有 13 张模型场景变化，其余逐张相同；`object:model` 13 → `model:pending` 13，`object:reflected` / `object:skin` 去掉后消费者照报（3 张 `texture:rendertarget:_rt_Reflection`、1 张 `combo:REFLECTION`）；模型材质进编译后新冒出的键：`depthwrite:enabled` 9 张（P5d）、arsenal 的 lightmap / normalmap 翻译失败、demon_core 的遗留灯与音频 uniform、3509243656 引用别的图层的合成 RT、ricepod 拼错的 `depthtesting` / `depthwriting`；3706286085 报 `mdl:skeleton` / `mdl:animation` / `mdl:morph` / `mdl:flags:0x400`；没有任何 `mdl:missing-attribute`（`grid` 的 `a_Normal` 没读）。retro 只剩 `model:pending`。能渲染的仍是 47 张。这组变化在 `7d80ad07` 与 `e5370601` 两个底上逐项相同。
- **wasm 过时**：开工时工作区的翻译器 wasm（`8ed07a4…`）早于 `049420f0`（P7d 步骤 1），按当前源码重编后另有 4 张不带模型的场景少了 `constant:*` / `uniform:g_FrameTime`，那是 P7d 步骤 1 的效果，和本步无关（`diff-wasm.txt`）。工作区与 `bin/wasm` 的 wasm 后来被别的会话重编过。
- **画面哈希没做**：验收时 dev 应用没在跑（CDP 不应答），不能代起。渲染器本步没改，非模型场景的编译结果只多一个值为 null 的 `model` 字段。
- 子代理开工早期误跑过一次 `python - <<'EOF'`（heredoc 是空的，什么也没执行），违反了「禁止从标准输入喂 Python」。

提交：`b2070b2f`（用户提交，核对过本步的改动与测过的版本逐行一致）。

## 步骤 2 — 绘制

### 思路

模型图层在渲染图里排成「每个网格一个 `mesh` 步骤」，顺序取编译期排好的 `model.order`，全部直接画到场景目标，和图像层、粒子在同一个场景 pass 里按 `objects` 顺序混排。模型没有合成路径：WPE 的模型对象不读 `effects`（编译期已报 `model:effects`），也没有 colorBlendMode 的上屏。

几何来自 mdl：顶点字节原样上传成一个顶点缓冲（同一个 mdl 的网格视图共用一份 GPU 缓冲，按视图去重），索引上传成索引缓冲（`writeBuffer` 要 4 字节对齐，u16 奇数个时补齐长度），`drawIndexed(indexCount)`，三角形列表。顶点布局不能用 `vertexPacking`（那是按着色器属性紧排、给图层四边形用的），新写一个按网格格式建的：stride 取 mdl 的，程序的每个属性按名字查语义，再在网格格式里找同一语义的那一项，偏移、格式（`float32xN` / `uint32x4`，宽度按数据）照它，`shaderLocation` 照程序。程序声明了、网格没有、而且没读（`unused`）的属性，接到一个 `arrayStride` 0 的全零占位缓冲上（WGSL 入口仍带这个 location，WebGPU 建管线要有）；读了的在编译期已报 `mdl:missing-attribute`，渲染器不会遇到。

管线多两个维度：顶点布局（按网格格式区分）和剔除。模型 pass 的 `cullmode` 为 normal 时 `frontFace: "ccw"`、`cullMode: "back"`，nocull 时不剔；图像层、粒子、文本照旧不剔。`pipelineKey` 只在这两项出现时加后缀，现有管线的键逐字不变（同 P5b 加 `alphaMax` 的做法）。

uniform 走图像层同一个函数，只换三处输入：颜色 (1, 1, 1)、alpha 1、颜色系数 1（WPE 不读模型的 `color` / `alpha` / `brightness`，`p5c-color`）；尺寸不参与（模型矩阵就是世界矩阵）；视图投影同图像层直接上屏（带视差、抖动、缩放，`perspective: true` 换透视那一份）。`g_NormalModelMatrix` 全局改成 WPE 的算法：世界矩阵 3×3 的三个本地轴各自归一化，长度平方按 float32 累加，用 `0x5f375a86` 快速倒数平方根加一次牛顿迭代（`p5c-matrix` 三个模型逐位到 1.2e-7）。WPE 的 uniform 写入函数是所有对象共用的，图像层光照路径读它，所以有光照的场景要过基线。

视锥剔除每帧在画模型之前算一次：模型包围盒并集的两个角经世界矩阵（不含视差）变换，中点为球心、半对角线为半径，对场景视图投影（带抖动、缩放，不带每个对象的视差，WPE 在场景绘制开头算一次平面）的六个平面判断，球完全在某个平面外就整个模型不画。v < 17 的 ±131072 盒子等于不剔。

### 现状锚点

**a. 渲染图没有模型图层**（`render/graph.ts:346`）
```ts
export function planLayer(layer: SceneLayer, textures, enabled, text = null): LayerPlan {
  if (layer.particle) return planParticleLayer(layer);
  // …文本层…
  const base = sceneText ? sceneText.glyphPass : layer.passes[0];
  if (!base) return { composite: null, steps, reasons }; // 现状：模型图层没有 passes，是空计划
```

**b. 模型图层不建资源**（`render/scene.ts:670`）
```ts
      (layer.passes.length > 0 || (layer.particle?.passes.length ?? 0) > 0 || !!layer.text) && // 现状：不认 layer.model
```

**c. 管线的五项与键**（`render/scene.ts:545`、`render/programs.ts:308`）
```ts
export function pipelineKey({ program, blending, format, alpha, topology, alphaMax }: PipelineSpec): string {
      primitive: { topology, cullMode: "none" }, // 现状：顶点布局取 program.vertexPacking，不剔除
```

**d. 法线矩阵是逆转置**（`render/math.ts:146`）
```ts
export function normalMatrix(m: Mat4): number[] { // 现状：左上 3×3 的逆转置；WPE 是三个轴各自归一化（快速倒数平方根）
```

**e. 编译期的过渡键**（`compile/bundle.ts` 的 `compileModel`）
```ts
    unsupported.add("model:pending"); // 现状：绘制接上之前一律退回
```

### 点 1 — 渲染图（`render/graph.ts`）
- **新增** `MeshStep` 与 `planModelLayer(layer)`：
```ts
/** 模型图层的一次网格绘制（P5c 步骤 2）：mdl 的顶点 / 索引，三角形列表，直接画到场景目标。 */
export interface MeshStep {
  kind: "mesh";
  /** `layer.model.meshes` 的下标（步骤按 `model.order` 排）。 */
  mesh: number;
  pass: ScenePass;
  target: { kind: "scene" };
  inputs: Record<number, TextureRef>;
  blending: string;
}
```
  - 每个网格取 `passes[0]`（多 pass 编译期已报），没有 pass 的网格跳过；运行时纹理只认 `_rt_FullFrameBuffer`（见点 4 的编译期键，渲染器不会遇到），其余照报 `render:texture-rt:<名>`。
- **修改** `planLayer`：`layer.model` 非空时走 `planModelLayer`（在粒子之后、文本之前）。`LayerStep` 加 `MeshStep`。

### 点 2 — 顶点布局与管线（`render/programs.ts`、新增 `render/mesh.ts`）
- **新增** `meshVertexLayout(attributes, format)`：返回 `{ buffers: GPUVertexBufferLayout[]（网格一个、占位一个可选）, key, problems }`，规则见「思路」；类型（float / sint / uint）和数据对不上时进 `problems`（编译期另有键，见点 4）。
- **新增** 网格 GPU 缓冲：顶点缓冲按 `vertices` 视图（`buffer` + `byteOffset` + `byteLength`）去重共用；索引缓冲按 4 字节补齐。
- **修改** `createPipeline` 收可选的 `vertexBuffers` 与 `cull`；`PipelineSpec` 加 `mesh?: string`（布局键）与 `cull?: "back"`，`pipelineKey` 只在它们出现时加后缀。
- **修改** `stepPipeline`：`mesh` 步骤用三角形列表、按 `pass.cullmode` 定剔除、按布局键区分。

### 点 3 — 渲染器（`render/scene.ts`、`render/uniforms.ts`、`render/math.ts`）
- **修改** `buildableLayers` 认 `layer.model`（有网格 pass 才建）；`uploadableTextures` 带上网格材质的纹理；自查（`planProblems`）对网格程序用 `meshVertexLayout` 的 `problems`。
- **新增** `Draw.mesh`（顶点缓冲、索引缓冲、索引格式、索引数）；`createDraw` 的 `mesh` 分支；编码时 `setVertexBuffer(0, 网格)`、需要时 `setVertexBuffer(1, 占位)`、`setIndexBuffer`、`drawIndexed`。
- **新增** 模型图层的视锥剔除（`render/layout.ts` 或 `mesh.ts` 的纯函数 `frustumCulled(bounds, world, viewProjection)`），编码时每帧判一次，被剔的整个模型跳过。
- **修改** `uniformValues` 的 `mesh` 分支：同图像层直接上屏，图层状态的颜色换成 (1, 1, 1)、alpha 1、颜色系数 1；就地刷新（`refreshLayer`）、视差 / 相机重写照常经过它。
- **修改** `normalMatrix`：改成 WPE 的算法（见「思路」），注释写依据。

### 点 4 — 编译期（`compile/bundle.ts`、`compile/features.ts`）
- **删除** `model:pending`。
- **新增** 网格材质读 `_rt_FullFrameBuffer` 报 `mdl:framebuffer`（WPE 的模型绘制不拷快照，读到的是什么没测，语料 0 个）。
- **新增** `checkMeshAttributes` 查类型：程序属性的分量类型（float / int / uint）和网格数据（`a_BlendIndices` uint，其余 float）对不上报 `mdl:attribute-type:<名>`（语料 0 个）。

### 点 5 — 单测
- `render/graph`：模型图层的步骤（顺序同 `model.order`、混合、输入、没有 pass 的网格跳过、没有合成 RT）。
- `render/mesh`：`p5c-layout` 两种格式与 0x8009 的布局（偏移、格式、`shaderLocation` 按语义配对），同语义不同宽度（M1、M4），占位属性（M3），类型不符进 `problems`。
- `render/math`：`normalMatrix` 对 `p5c-matrix` 三个模型的世界矩阵，和 WPE 实测值（`ignore/p5/c0/out/ana_c.txt`）逐项差 ≤ 2e-7。
- 视锥剔除：`p5c-frustum3` 的 F1–F10 十个包围盒逐个得到 WPE 的结果（F1、F5、F7、F10 剔掉）。
- `pipelineKey`：已有规格的键逐字不变，`mesh` / `cull` 各加后缀。
- 编译：retro 不再报 `model:pending`；`mdl:framebuffer`、`mdl:attribute-type`。

### 实施方式

子代理在 HEAD 快照里实现（P9 的会话正在改工作区的 `render/scene.ts`、`renderer.ts`），我独立验收后三方合并。

### 验收

子代理：快照 tsc 0 错误；vitest 除已知的 `3830255100: 219 次请求` 外全过；Prettier。

Claude 独立验收：
1. 越界检查、自跑 tsc / vitest；变异：剔除方向反了、占位属性不接、法线矩阵改回精确归一化、视锥剔除用盒子不用球、网格顺序不按 `model.order`、模型颜色不固定为 1。
2. 语料：retro 从 `model:pending` 变成能渲染（能渲染 47 → 48），其余模型场景只少 `model:pending`，不带模型的场景逐张相同。
3. 确定性工程（`ignore/p5/proj/p5c-*`）在 Kabegame 里渲染、和 WPE 抓帧逐像素比：layout、ver、color、skin、matrix（含视差、缩放）、cull、frustum；attr 与 order 另生成不含会退回的对象的版本（M2 / M5、alphatocoverage）再抓、再比。depth 归 P5d，不比。
4. retro：`kbp content unpack --instrument` 解包，WPE 按 2520×1080 抓帧，Kabegame 按日志里同一时刻回放，整帧比。
5. 画面哈希基线：10 张基线场景 × 三档不变；另挑有光照的场景核对法线矩阵的变化（变了要能用 WPE 抓帧说明是对齐）。
6. 三方合并进工作区，合并后再跑 tsc、vitest。

### 步骤 2 实施记录（2026-11-13）

子代理在 HEAD 快照（`b2070b2f`）里实现，我独立验收后合到 `ff4ad0e3`（中间 P9a 步骤 2、P6b 1d2、P8 步骤 1 改过 `render/scene.ts`，三处冲突都是两边各加一段，照两边都留解；P8 给 `SceneLayer` 加的 `clampUVs` / `noInterpolation` 在新测试的字面量里补上）。

**和计划不一致或计划没写到的：**
- **`render/state.ts`**：`SceneState.fromBundle` 原来不收集网格 pass 的材质常量，网格 draw 会丢掉 `constantshadervalues`（retro 的 `g_Tint`），属性绑定也写不进去，补上了。
- **模型层整层一个 `model` op**：编码时先做视锥剔除，再按 `model.order` 画各网格；顶点缓冲放在原有的 `Draw.vertexBuffer`，`Draw.mesh` 存索引缓冲、格式、个数与占位缓冲。网格缓冲按「文件缓冲 + 用途 + 偏移 + 长度」去重共用，图层重建时不释放、随场景销毁。
- **占位缓冲**：全场一份 256 字节的全零缓冲，每个占位属性占 16 字节，格式按着色器自己的类型。读了的缺属性（编译期已报）也接占位，强制渲染时读到 0。
- **法线矩阵的运算顺序**：牛顿迭代照 Quake 原式 `y·(1.5 − ((0.5x·y)·y))`，对 WPE 实测的 `g_ModelMatrix` 输入，三个模型 27 个值逐位相同（`ignore/p5/c2/nmm_variants.mjs`）；步骤 0 分析脚本的写法 `0.5x·(y·y)` 差 1 ulp。
- **新增 `attributeTypeMatches`**（`compile/mdl.ts`）：着色器属性类型能不能读这项网格数据的唯一一处规则，编译期 `mdl:attribute-type` 与渲染器的布局共用。
- **组里的模型不剔**：组里的模型照报 `model:passthrough:children:model`，只有强制渲染才到这里，WPE 在组里用哪组平面没测。
- `compile/pipeline.test.ts` 的 `unlocked` 加上 retro。

**验收：**
- 越界：快照对 HEAD 的差异只在计划内的文件（加上 `render/state.ts`）。
- 快照与合并树：tsc 0 错误；vitest 合并树 2319 通过，只有已知的 `3830255100: 219 次请求`；Prettier 通过；合并后的工作区 tsc 0 错误。
- 变异（`ignore/p5/c2/mutate_s2.py`）14 处全部检出、还原后整树哈希一致：正面换成顺时针、normal 不剔、不接占位、法线矩阵改回精确归一化、视锥剔除半径为 0、不做视锥剔除、网格不按 `model.order`、模型颜色不固定为 1、索引不补齐、管线键不带剔除、属性偏移取 0、类型不符不报、又报 `model:pending`、不收集网格材质常量。
- 语料（配同一份 wasm 的对照）：只有 13 张模型场景少了 `model:pending`，retro 变成能渲染，其余逐张相同（`b2070b2f` 上 47 → 48，`ff4ad0e3` 上 48 → 49）。
- 画面哈希：合并前后各构建一次宿主，10 张基线场景 × 三档全部相同。语料里能渲染的场景没有一张有打开 `LIGHTING` 的图像层（`ignore/p5/c2/lit_scenes.py`、`lit_where.py`：`LIGHTING` 只出现在透视场景的模型材质和一个流体 effect 里），所以全局改法线矩阵对现有画面中性。
- **真机对 WPE**（dev 应用渲染、按 WPE 抓帧日志回放、`kbp cmp frame --kbp-layers`）：
  - `p5c-layout`、`p5c-attr-ok`（M1 / M3 / M4）、`p5c-ver`、`p5c-color`、`p5c-skin`、`p5c-matrix`、`p5c-matrix-par`、`p5c-matrix-zoom`、`p5c-order-ok`、`p5c-cull`：整帧逐像素相同（差 0）；
  - `p5c-frustum3`（1600×900 窗口）：画了的方块与 WPE 相同（F2、F3、F4、F6、F8、F9，剔掉 F1、F5、F7、F10），只有 6 个方块一圈边缘差（我们按 1920×1080 画再缩放）；
  - retro（2520×1080、按日志回放到第 199 帧）：整帧最大差 1（1171 个像素差 1）。
  - `p5c-attr-ok`、`p5c-order-ok` 是去掉了编译期会退回的对象（M2 / M5 读了缺的属性、alphatocoverage）的对照版，另抓了 WPE 帧（`A:\p5c\p5c-attr-ok`、`p5c-order-ok`）。`p5c-depth` 归 P5d，不比。
- **wasm**：工作区里给宿主打包的翻译器 wasm（`d3ed5a82`，别的会话早先编的）不带属性的 `unused`，`p5c-attr-ok` 的 M3 因此误报 `mdl:missing-attribute:a_Normal`；按当前源码重编（`deno task build:wpesl2wgsl`，`ba25b097`，和快照测试用的同一份）拷进 `apps/wpe-scene/src/wpesl2wgsl/` 后不再报，画面不变。

