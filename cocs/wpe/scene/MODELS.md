# 场景壁纸：模型与自定义几何

> [场景壁纸文档](../WPE_SCENE.md) 的一章：静态网格 mdl（P5c）、脚本自定义几何与组里的模型（P14）。总体形态、各阶段状态与全部章节的索引在总览里。

## 静态网格（P5c）

模型对象（`model` 指向 `.mdl`）是第三种有内容的图层，和粒子一样挂在图层上（`SceneLayer.model`），不另开一张表。所以 `objects` 顺序、父链的世界矩阵与可见性、视差、属性绑定这些现成的机制都直接适用：一个模型对象就是一个图层，只是「画什么」从图层四边形换成 mdl 里的若干个网格。P5c 只做正交场景里的静态网格；透视场景与深度附件由 P5d 接上（见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」），骨骼、动画、变形归 W6。

依据：
- 读码：[rea-p5-mesh](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-mesh.md)（mdl 布局、顶点表序、皮肤、模型 uniform、绘制顺序、剔除状态，全部没有实测）。
- 实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase5/p5-REPORT.md)「P5c 语义的实测核对」。12 个确定性工程加 retro，读码的结论全部成立，推翻一处：`skin` 为负数时取 0，不是最后一项。读码标了未知的几处（着色器声明了网格没有的属性、排序稳不稳定、正交场景里的视锥剔除）都测清了。
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md)「实施记录」「P5c 收尾」。

验收：
- 确定性工程按 WPE 抓帧的日志回放到同一帧，和 WPE 整帧逐像素比（`kbp cmp frame --kbp-layers`），10 个工程 0 差异；
- retro 解包加日志，按 WPE 日志回放到第 199 帧（2520×1080），整帧最大差 1；
- 10 张基线场景 × 三档后处理的画面哈希不变。

### mdl（`compile/mdl.ts`）

| 项 | 规则 | 依据 |
|---|---|---|
| 加载 | 一个函数（`parseMdl`）、按版本门槛读：网格标志 v ≥ 4、网格自带顶点格式 v ≥ 15、包围盒 v ≥ 17、两个可选块 v ≥ 21、记录表 v ≥ 23、尾部段 v ≥ 13。不认识的尾部段按长度跳过；读越界报 `mdl:truncated`，段表的结尾例外（同 WPE：标签在文件末尾之前找不到 `\0` 当空标签、段表结束，`FUN_14009c500`；段末超出文件时下一个标签从文件末尾读，`FUN_140261770`；myprojects/3840815204 的 puppet mdl 最后一段顶到文件末尾、没有结尾的空标签） | 读码 1.2–1.7；实测 `p5c-ver`：v4、v14、v16、v17、v21、v23 的同一个四边形都画在原处，尾部带不认识的段照常显示。语料 139 个 mdl 按这套规则都恰好读到文件末尾 |
| 顶点格式 | 26 位掩码（`MDL_ATTRIBUTES`），属性按表序交错，stride 是置位属性大小之和（`meshAttributes` / `mdlStride`）；除 `a_BlendIndices`（u32×4）外都是 float | 实测 `p5c-layout`：两个网格（stride 156、104）的输入布局逐项和表序算的相同 |
| 索引 | 网格标志 bit0 置位是 u32，否则 u16；bit1 多读一个 u32；三角形列表 | 实测 `p5c-ver` |
| 包围盒 | 全部网格包围盒的并集（`unionBounds`），给视锥剔除用；v < 17 没有包围盒，取 ±131072，等于不剔 | 读码 1.6；实测 `p5c-frustum` 的 v14 版本不剔 |
| 解析一次 | 同一个 mdl 被多个对象引用时只读、只解析一次（`bundle.ts` 的 `readMdl`），顶点 / 索引是文件缓冲上的视图，整个文件缓冲随 bundle 转移、不拷贝 | 3354366708 的两个圆环共用一个 mdl |

编码器 `ignore/p5/c0/mdl_enc.py` 照这套布局写 mdl，对语料 46 个静态 mdl 解析再编码逐字节一致；单测直接拿这些文件和编码器的输出当夹具。

### 编译

| 项 | 规则 | 依据 |
|---|---|---|
| 皮肤 | 每个网格按对象 `skin` 选一个材质（`meshSkin`）：非负整数（含 `1.0`）取 min(skin, N − 1)，其余（负数、字符串、布尔、缺键）取 0 | 实测 `p5c-skin`，**推翻读码**（读码推断负数按无符号落到最后一项） |
| 材质 | 走图像层同一条 `compilePass`，稳定键 `objects/<i>/meshes/<m>/passes/<k>`，材质按对象各编一份（`skin` 可能不同）；静态网格不追加引擎 COMBO，全局宏（`HDR`、`SCENE_ORTHO`）照常 | 读码 2.4 |
| 深度与剔除的缺省 | 模型 pass 照 WPE：缺 `cullmode` 是 normal，缺 `depthtest` / `depthwrite` 是 enabled（`PassContext.model`）。会写深度的原先照报 `depthwrite:enabled`，P5d 步骤 1 加深度附件后不再报，图像层、粒子、文本的缺省也一并统一（见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」）；`PassContext.model` 随之删除 | 实测 `p5c-cull`；`p5c-depth`：正交场景里模型也测深度、写深度，translucent 只测不写 |
| 绘制顺序 | 编译期排好 `model.order`（`meshDrawOrder`）：比较器是「a 不透明（normal / alphatocoverage）且 b 半透明（translucent / additive）」，照 MSVC STL 的 `std::sort` 移植，≤ 32 个网格时是插入排序，等于稳定排序 | 实测 `p5c-order`：40 个网格时同类内部不是原顺序，`sim_sort.py` 逐个复现 |
| 缺属性 | 着色器声明了网格没有的语义：翻译器标了 `unused`（入口可达的代码没读到，`naga_stage::inputs_read`，跟着 `Access` / `AccessIndex` 指针链找）的照常画，渲染器接占位；读了的报 `mdl:missing-attribute:<名>` | 实测 `p5c-attr`：没读的被 fxc 从输入签名里去掉，正常画；读了的 WPE 建不出输入布局，画出未定义的值，日志不报错。语料里 fantasticcar、audiophile 的 `grid` 声明 `a_Normal` 但不读 |
| 透视 | 模型 `perspective: true` 同 P5b 的透视图层（`layer.perspective`） | 实测 `p5c-matrix` 的透视一份 |

### 绘制（`render/graph.ts`、`render/mesh.ts`、`render/scene.ts`）

| 项 | 规则 | 依据 |
|---|---|---|
| 步骤 | `planModelLayer` 按 `model.order` 每个网格排一个 `mesh` 步骤（取网格的第一个 pass，没有 pass 的跳过），直接画到场景目标，和图像层、粒子、文本在同一个场景 pass 里按 `objects` 顺序混排。模型没有合成路径：不读 `effects`，没有 colorBlendMode 的上屏。编码时整层一个 `model` op | 读码 2.6 |
| 顶点布局 | 不由着色器推（`vertexPacking` 只给图层四边形）：`meshVertexLayout` 按网格格式算出每项的偏移；程序的每个属性按语义（`attributeSemantic`：TEXCOORDn 的三种宽度共用一个槽，POSITION 的两种也是）在网格里找同一语义的那一项，格式按数据宽度（`float32xN` / `uint32x4`），`shaderLocation` 照程序。分量少了由 WebGPU 截断，多了补 (0, 0, 0, 1)。类型对不上（`attributeTypeMatches`，编译期与渲染器共用）编译期报 `mdl:attribute-type:<名>` | 实测 `p5c-layout`；`p5c-attr`：vec4 数据给 vec2 读到 xy，vec2 数据给 vec4 读到 (u, v, 0, 1) |
| 占位属性 | 网格没有的属性接到槽 1 的占位缓冲：全场一份 256 字节的全零缓冲，`arrayStride` 0，每项 16 字节，格式按着色器自己的类型。WGSL 入口可能仍带这个 location，WebGPU 建管线要有 | 实测 `p5c-attr-ok` 的 M3 |
| 缓冲 | 顶点缓冲按「文件缓冲 + 用途 + 偏移 + 长度」去重共用，图层重建不释放、随场景销毁；索引按 4 字节补齐（`writeBuffer` 的要求），`drawIndexed` | — |
| 剔除 | 模型 pass 的 `cullmode` 为 normal 时 `frontFace: "ccw"`、`cullMode: "back"`，只看屏幕上的绕序（镜像不补偿）；nocull 不剔。管线键只在出现时加 `\|mesh:<布局键>`、`\|cull:back`，现有管线的键逐字不变 | 实测 `p5c-cull`：`CullMode.Back`、`FrontCounterClockwise`；`scale −1` 的对象不翻转正面 |
| 视锥剔除 | 每帧画模型前判一次（`mesh.ts` 的 `frustumCulled`）：包围盒并集的两个角经世界矩阵（不含视差）变换，中点为球心、半对角线为半径，和场景视图投影（带抖动、缩放，不带每个对象的视差，WPE 在场景绘制开头算一次平面）的六个平面比，球完全在某个平面外就整个模型不画。组里的模型不剔（P14b D1，和 WPE 有意不同，见「脚本自定义几何（P14）」的「组里的模型（P14b）」） | 实测 `p5c-frustum`、`p5c-frustum3`：盒子在外、z 远在深度范围外的不画，跨边缘、外接球伸进来的画，十个包围盒逐个和 WPE 相同。retro 这类不乘矩阵的着色器也会被剔（看的是包围盒，不是画出来的位置） |
| uniform | 和图像层直接上屏同一个函数，只换三处输入：颜色 (1, 1, 1)、alpha 1、颜色系数 1（WPE 不读模型的 `color` / `alpha` / `brightness`）；模型矩阵就是世界矩阵（没有 `size`）；视图投影同图像层（带视差、抖动、缩放，`perspective` 换透视那一份）。网格 pass 的材质常量进 `SceneState`（`fromBundle`），属性绑定与就地写照常 | 实测 `p5c-color`：`g_Color4` = (1, 1, 1, 1)、`g_Color` = (1, 1, 1)、`g_Alpha` = 1；`p5c-matrix`：MVP = VP · W，含视差与 `zoom 1.5` |
| 法线矩阵 | `g_NormalModelMatrix` 全局改成 WPE 的算法（`math.ts` 的 `normalMatrix`，原来是逆转置）：世界矩阵 3×3 的三个本地轴各自归一化，长度平方按 float32 累加，用 `0x5f375a86` 快速倒数平方根加一次牛顿迭代（照 Quake 原式 `y·(1.5 − ((0.5x·y)·y))`）。WPE 的 uniform 写入函数所有对象共用，图像层 genericimage 的光照路径也读它 | 实测 `p5c-matrix`：三个模型 27 个值逐位相同；精确归一化差 1e-3 量级，逆转置差 0.4–0.67。语料里能渲染的场景没有打开 `LIGHTING` 的图像层，对现有画面中性 |

### 能力表

`object:model` 拆成细分键，没实现的照报、整张退回：
- **对象**（`features.ts` 的 `checkObjectFeatures`）：`skin`、`castshadow`、`reflected`、`disablepropagation` 中性（`MODEL_NEUTRAL_FLAGS`）。`reflected` / `castshadow` 本身没有画面，它们的消费者都照报：读 `_rt_Reflection` 报 `texture:rendertarget:_rt_Reflection`，`REFLECTION` 非 0 报 `combo:REFLECTION`，投影灯报 `lightconfig:*`。`perspective: true` 已实现；`effects` 非空报 `model:effects`；`model` 是整数时是脚本模型数据的 token（P14，见「脚本自定义几何（P14）」），其余不是字符串的报 `model:id`；`animationlayers`、`dependencies` 照未知键报。
- **mdl**（`checkMdlFeatures`）：`mdl:missing:<路径>`、`mdl:truncated`；骨骼 / 动画层 / 变形 / 挂点段报 `mdl:skeleton` / `mdl:animation` / `mdl:morph` / `mdl:attachment`（W6）；网格带可选块或记录表（木偶数据）报 `mdl:puppet`；网格标志除 bit0、bit1 外还有位报 `mdl:flags:<多出来的位>`；格式有表外的位或同一语义出现两次报 `mdl:format:<格式>`。
- **网格**（`compileMesh`、`checkMeshAttributes`）：属性名不在 26 个名字里报 `mdl:attribute:<名>`，读了缺的语义报 `mdl:missing-attribute:<名>`，类型不符报 `mdl:attribute-type:<名>`；材质多于一个 pass 报 `mdl:material-passes`；读 `_rt_FullFrameBuffer` 不报：P14 起画这个模型之前拷一次快照（`planModelLayer` 的层首 `snapshot`，同图像层），和 WPE 有意不同（WPE 的模型绘制不拷，读到别的层最近一次拷下的内容，没人拷过是全 0），见「脚本自定义几何（P14）」的 E16。
- **组里的模型**：P14b 起不报（见「脚本自定义几何（P14）」的「组里的模型（P14b）」）；组里的 sprite 照报 `model:passthrough:children:sprite`。

### 已知差异与只记不补

- **视差、抖动下的视锥平面**：照读码，用场景视图投影、世界矩阵不带每个对象的视差，没有实测。收尾统计：正交的模型场景只有 retro（mdl v14 没有包围盒，不剔；视差、抖动都没开）和 3354366708（视差、抖动都关，还差 11 项），没有受影响的场景。透视场景的三维抖动 P5d 已实现，视锥平面带抖动的部分仍没有实测（ricepod 还差 `object:sprite`，3706286085 有骨骼动画）。
- **组里的模型**：P14b 实测并实现（矩阵、深度、阴影、视锥剔除），见「脚本自定义几何（P14）」的「组里的模型（P14b）」。
- **读了的缺属性**：WPE 画出未定义的值，我们报 `mdl:missing-attribute`；强制渲染时接占位，读到 0。
- **`g_UserAlpha` / `g_Brightness`**：着色器读了不带 `"material"` 注解的这两个名字时，WPE 给 0，我们给 alpha 与 1（图像层也一样）。语料与 WPE 自带的着色器里这两个名字全部带注解，没有画面差别。
- **语料 0 个、照报**：`mdl:attribute-type`、`mdl:truncated`（WPE 的读取原语越界返回 0 / 空串 / 空指针后接着读，我们保守报；段表结尾缺空标签、段末超出文件不算，见上面「加载」一行）、`mdl:material-passes`、`model:effects`、`model:id`。
- **原归 P5d，现状**：透视场景、深度附件、图像层与粒子的剔除 / 深度缺省、`transparentsorting` 都由 P5d 实现，见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」。

### 语料与解锁

| 步骤 | 去掉的键 | 新增的键 | 能渲染 | 新解锁 |
|---|---|---|---|---|
| 1 编译 | `object:model` 13 张、`object:reflected` 2、`object:skin` 1 | 过渡键 `model:pending` 13；`depthwrite:enabled` 9（P5d）；模型材质进编译后冒出的别的键：`texture:rendertarget:_rt_Reflection` 3、`_rt_MipMappedFrameBuffer` 2、音频频谱、遗留灯、ricepod 拼错的 `depthtesting` / `depthwriting`、arsenal 的光照贴图翻译失败；3706286085 的 `mdl:skeleton` / `animation` / `morph` / `flags:0x400` | 47 → 47 | — |
| 2 绘制 | `model:pending` 13 | — | 47 → 48（合到 `ff4ad0e3` 上是 48 → 49） | retro |

- 13 张模型场景里，只差 `camera:perspective` 的有 neon_sunset、techno，再加 `depthwrite:enabled` 的有 dna_fragment，P5d 之后这三张都能渲染；其余还差反射、音频频谱、相机对象、文本、木偶等 3–36 项。没有场景因 P5c 不再能渲染。
- **和 WPE 比**：
  - 确定性工程：`p5c-layout`、`p5c-attr-ok`、`p5c-ver`、`p5c-color`、`p5c-skin`、`p5c-matrix`、`-par`、`-zoom`、`p5c-order-ok`、`p5c-cull` 0 差异（`-ok` 两个是去掉了编译期会退回的对象的版本）；
  - `p5c-frustum3`（1600×900 窗口）：画了的方块与 WPE 相同，剔掉的也相同，只有方块边缘因缩放有差；
  - retro：整帧最大差 1（1171 个像素差 1）。
- **基线**：10 张原本能渲染的场景 × 三档后处理的画面哈希不变。它们不含模型，所以这只能说明没改坏别的（法线矩阵的全局改动对它们中性），对不对靠上面的整帧比较。

### 对比台

在 `ignore/p5/` 下：
- mdl 编码器 `c0/mdl_enc.py`（`enc_check.py` 对语料往返核对），确定性工程由 `c0/gen_c.py` 生成，放在 `proj/p5c-*`；
- 读数：`c0/rdc_dump_c.py` 在 `qrenderdoc --python` 下导出每次绘制的输入布局、顶点 / 索引、深度与光栅状态、混合与常量，`ana_c.py` 逐个核对，`sim_sort.py` 复现排序，`ana_frustum3.py` 看视锥剔除；
- 各步的快照、补丁、变异清单、语料比较与整帧比对在 `c1/`、`c2/`，收尾的语料统计是 `c3/walk_c.py`、`c3/model_keys.py`；
- WPE 参照在 `A:\p5c\`。

## 脚本自定义几何（P14）

`IModelData` 让场景脚本把顶点 / 索引缓冲直接交给引擎：
- `thisScene.createModelData({ shapes: [...] })` 返回句柄，`createLayer({ model: 句柄 })` 建模型层；
- 之后每帧 `applyData` 换顶点（和索引），`replaceData` 整体换形状，`destroyModelData` 释放。

语料里只有 3834692798（Karin，把 Live2D Cubism 运行时整个写进 2.6 MB 场景脚本的移植壁纸）用它。它在第一次 `update` 里建出 358 个模型层，之后每帧 `applyData`。

WPE 建出的就是 mdl 加载出来的同一种模型资源：格式是 mdl 的 26 位掩码、按表序交错，绘制走同一个函数。所以我们把 `IModelData` 当成「内存里的 mdl」：模型层就是 P5c 的模型层，顶点布局、属性配对、占位属性、视锥剔除都沿用 `render/mesh.ts`。新的只有两件事：字节从哪来，以及怎么在运行中当帧建出来。

- **依据**：
  - 读码：[rea-p14-script.md](../../../.claude/plans/wpe-import/3-scene/phase14/rea-p14-script.md)（dll 侧的参数整理与报错串，第 9 节）、[rea-p14-exe.md](../../../.claude/plans/wpe-import/3-scene/phase14/rea-p14-exe.md)（exe 侧的建、更新、绘制与释放）。
  - WPE 实测：工程由 `ignore/p14/0/` 的 `make_api.py`、`make_api2.py`、`make_draw.py`、`make_fb.py` 生成（`p14-api*` 比日志，`p14-format` / `p14-apply` / `p14-fb*` 比抓帧，抓帧在 `A:\p14\`）。
  - 计划：[phase-14-model-data.md](../../../.claude/plans/wpe-import/3-scene/phase14/phase-14-model-data.md)，含 S1–S17 / E1–E16 两张对照表与缺陷表 D1–D14。

### 数据流

方向是「脚本 → 主线程数据仓 → GPU」，编译只看描述：

- **数据仓 `ModelDataStore`**（`modeldata/store.ts`，宿主主线程，随脚本运行时建与丢）：
  - 按 token 存每个形状的格式、材质、顶点 / 索引字节（调用时拷一份）、索引格式、动态标志、包围盒、版本号；
  - 引用计数是脚本一份加每个图层一份，最后一个图层删掉后释放；
  - token 从 1 起，只在创建成功时分配。
- **编译按描述**：
  - 对象配置里的 `model` 是整数 token。宿主把 token 的描述 `ModelDataDesc`（每个形状的格式、顶点数、索引格式与个数、材质，加上包围盒）随开会话输入、片段请求、L6 重编带进 Worker；
  - `compileModel` 的数字分支按描述建 `SceneModel`，每个形状照 mdl 网格编一个材质 pass；
  - `SceneMesh` 不带字节，只记来源 `source: { token, shape }`。无索引形状记成 `indexCount: 0` 加一个 `uint16` 占位。
  - 字节不进 Worker、不进 bundle。查不到的 token 编出 `model: null`，建出不画的层（同 WPE）。
- **GPU 缓冲**：GPU 场景按 `(token, 形状)` 建自己的顶点 / 索引缓冲，多个图层共用，每帧按版本整块重写（下面「GPU 缓冲」）。

### 脚本 API（`script/modelData.ts`）

- **装不装**：宿主给了数据仓才装 `createModelData` / `destroyModelData`。两个方法都是 `sceneMethod`，在模块顶层调抛 `... cannot be called from global scope.`。
- **参数**：
  - 没有参数或不是对象，返回 `null`；
  - `shapes` 是数组就逐个当形状，否则整个配置当一个形状，`shapes: []` 抛 `Shapes missing.`；
  - 顶点必须是 `Float32Array`，字节数是 stride 的整数倍；索引收 `Uint16Array` / `Uint32Array`，别的类型当没有；
  - `vertexFormat` 区分大小写按位或，遇到非字符串的元素停下；
  - `material` 必填，经 `__workshopId` 改写；
  - 包围盒要两个都是对象才生效，读 `.x .y .z`；
  - `is*Dynamic` 只认 JS 布尔。
- **报错**：一律 realm 的 `SyntaxError`，文字逐字照 rea-p14-script 第 9 节（错误码 1–13 的表加 dll 自己的校验）。
- **材质检查**：材质有预编模板（见下面「precache 与材质模板」）时，`createModelData` / `replaceData` 当场按模板查着色器要的顶点属性，给不出时报码 2 `Shader expecting more vertex data.`。没有模板时当场不知道着色器，创建照常成功，编出来缺属性时那个图层不画、看板娘提示（已知差异，Karin 的材质都预编了）。
- **句柄**：
  - 是 realm 里 `IModelData.prototype` 的实例；`__modelDataToken` 不可写、不可枚举、不可配置；
  - `applyData` / `replaceData` 是自有属性，全部实例共用同一个函数对象；
  - `toConfigString()` 返回 token，所以 `createLayer` 的配置原文里 `model` 是整数，`createLayer(句柄)` 等同于 `{ model: 句柄 }`。
- **`applyData`**：
  - 当场拷贝、当帧生效；
  - 不许加 / 删形状、删缓冲、换材质、换格式、写非动态缓冲（码 7、9–13）；
  - 有索引时绘制数 = 这次的索引个数，无索引 = 顶点数。
- **`replaceData`**：可以重建（换容量、格式、材质、形状数），同一帧换网格；在 `update` 回调里抛 `IModelData.replace cannot be called in update.`，字段脚本的 `update` 也算。
- **`destroyModelData`**：释放脚本那一份引用。还有图层在用时资源留着，等最后一个图层删掉再释放。

### precache 与材质模板（`compile/bundle.ts`）

- **WPE 的 `general.precache`**：加载时预载列出的材质，不改语义。
- **我们拿它预编**：`finalize` 里把列出的材质编成「模型材质模板」`bundle.modelMaterials`。
  - 键是 `modelMaterialKey`（小写、`/` 分隔的路径）；
  - 每个模板有基础 pass、阴影投射变体，以及 `castsShadows` / `usable`；
  - 编模板时登记的绑定、反射、用户纹理、灯都回滚，不留在场景里。
- **不可用的模板**：带 A2C、用户纹理、图层合成 RT 这类要在加载时按对象定的东西时，标 `usable: false`，这样的材质走 Worker。
- **建 GPU 场景时**：`usable` 模板的程序一并进 `used`、预建管线，所以同步拼出的层第一次准备就有程序。

### 建层的两条路（`modeldata/assemble.ts`、`host.ts` 的 `createOn`）

WPE 的 `createLayer` 当帧建好，Karin 又在第一次 `update` 里一口气建出全部部件，所以模型数据层不走 L5 的片段缓存（`fragmentKey` 对整数 `model` 返回 `null`，键里没有描述，缓存会过期）：

- **同步拼装**：同时满足下面几条时，用编译期同一套纯函数在主线程拼出片段，照 L5 命中缓存那条路当场接进场景、同步装上 GPU，当帧画出：
  - 配置只有平常字段，白名单是 `id name model origin angles scale visible alpha color brightness perspective parent solid parallaxDepth colorBlendMode castshadow`，值只收数字 / 布尔 / 字符串；
  - 每个形状的材质都有可用模板；
  - 不是透视场景，也没有平面反射；
  - token 与描述相符。

  拼装时图层字面量与 `SceneModel` 按描述建，模板 pass 改键成 `objects/<i>/meshes/<m>/passes/<k>`，再按格式查一遍着色器输入。
- **Worker**：上面任一条不满足就走这条，片段请求带描述，晚几帧出现（同 L5 没命中）。
- **两条路等价**：对同一配置、同一描述，拼出的片段与 `compileFragment` 编出的逐字段相同（`assemble.test.ts` 的对照测试；3834692798 的普通、遮罩、合批、游戏特效、正片叠底五种部件用真翻译器对照过）。
- **结构变化**：`replaceData` 改了结构（形状数、格式、材质、容量）时，宿主对用这个 token 的每个图层重拼，能拼就按替换接回，拼不了走 L6 单对象重编（带新描述）。整场重载时 `collectModelData` 把现有描述带进开会话输入，这些层在重载之后仍在。
- **引用**：建壳时 `retainLayer`，`removeObjectEverywhere` 里 `releaseLayer`。

### GPU 缓冲（`render/scene.ts`）

- **缓冲组 `ModelBufferSet`**：
  - 键 `token:形状`，多个图层共用；
  - 顶点缓冲 `VERTEX | COPY_DST`，索引块非空时另有 `INDEX | COPY_DST`，建时写入数据仓当前的字节（4 字节对齐）。
- **每帧上传 `syncModelData`**：在 `encode` 开头（`syncPuppetIndices` 之后）逐组比数据仓的版本与记录，变了就整块 `writeBuffer`，并更新共用它的全部 draw 的绘制数。一帧里多次 `applyData` 只写一次；脚本在 `encode` 之前跑完，所以当帧生效。
- **重建与释放**：
  - 数据仓里这个形状的字节数组换了（`replaceData`），新图层另建一组；旧组留给还没重拼的图层，容量不符时不再写入，先画旧的；
  - 缓冲组按引用它的 draw 计数，最后一个 draw 摘掉时销毁；
  - token 释放后绘制数归零。
- **无索引绘制**：`MeshDraw.indexBuffer` 为空时主 pass `draw(顶点数, 实例数)`，阴影 pass `draw(顶点数, 1, 0, 视图号)`；无索引的形状也建阴影投射者。
- **和 mdl 模型层相同的部分**：
  - `g_Color4` / `g_Alpha` / `g_Color` 恒为 1，`g_ModelMatrix` 含 `scale.z`；
  - 材质只带自己的 `combos`；
  - 视锥剔除用描述里的包围盒（建时定一次，`applyData` / `replaceData` 都不改）；
  - 不参与光标命中。

### 和 WPE 有意不同

WPE 的缺陷按「壁纸依赖才复现」处理。语料里只有 3834692798 用这套 API，它都不依赖，所以都按 d.ts 的意图实现（依据见计划的缺陷表）：

| # | WPE | 我们 |
|---|---|---|
| D1 | `destroyModelData` 只收数字 token，传句柄静默无效（d.ts 与 Karin 都传句柄，Karin 的数据从没释放过） | 句柄与 token 都收 |
| D2 | 不查格式顺序，乱序时顶点与布局错位 | 乱序抛 `Vertex format in incorrect order.` |
| D3 | `applyData` 变长报码 7（码 5 / 6 走不到） | 报 `Vertex buffer size cannot increase` / `Index buffer size cannot increase` |
| D4 | 数组比建时短时按容量多读 | 只拷给出的长度 |
| D5 | 无索引形状 `applyData` 后只画 1/4 | 绘制数 = 顶点数 |
| D6 | 没给包围盒时把整段交错 float 当 xyz 求范围 | 只取位置分量 |
| D7 / D8 / D9 | `replaceData` 加形状后旧材质串释放后使用、没写格式时除零、多次 `destroyModelData` 在图层底下释放（会崩溃或写坏堆） | 正确实现、沿用原格式、每个句柄只释放一次 |
| D10 | 创建时 `undefined` / 数字形状交全零形状、`null` 形状打删除标志 | 创建时按缺 `vertexBuffer` 报错；`applyData` 里照 WPE |
| D11 | 材质加载失败换成 `error` 着色器，格式没有 UV 时报码 2 | 报 `Invalid material` |
| D12 | 材质路径截到 255 字节 | 不截 |
| D13 | `applyData` / `replaceData` 的顶层数组当一个形状（静默无效） | 数组逐个当形状（d.ts 写的是 `Object|Array`） |
| D14 | `replaceData` 换索引类型不重建、报码 9 | 重建 |
| E16 | 模型绘制不拷帧缓冲快照，读 `_rt_FullFrameBuffer` 读到别的层最近一次拷下的内容，没人拷过是全 0。Karin 的正片叠底部件 `clip_119` 因此画成半透明黑 | 读帧缓冲的模型图层在画之前拷一次快照（同图像层的层首拷贝，每图层至多一次），正片叠底按作者意图生效 |

另外几处：
- **无索引形状投不投影**：WPE 没实测，按和有索引的一样处理。
- **模型层的光标命中**：WPE 按包围盒参与，我们同 mdl 模型层不参与。Karin 的模型层不挂脚本、不挡传播。

### 已知差异

- **微任务时机**：WPE 在 `update` 返回前跑完它排出的微任务，`update` 里的 `async` 续体也算在 `update` 里，`replaceData` 照样抛错。我们的 realm 是浏览器的微任务，整帧脚本之后才跑，这时 `replaceData` 放行。
- **没预编的材质**：创建时不查着色器输入（见上面「材质检查」），图层晚几帧出现。
- **上传量**：按形状整块重写，不按改过的范围。Karin 每帧约 0.4 MB 起（321 个部件、7513 个顶点，遮罩部件按容量传），30 fps 下十几 MB/s。

### 对比结果

- **脚本 API**：
  - S1–S17 的每条都有单测（`script/modelData.test.ts`、`modeldata/store.test.ts`），报错文字逐字照 WPE。
  - `p14-api2` 用探针跑 120 帧加一次点击，和 WPE 日志逐行比，不同的只有：
    - S15d / S15d2：D1 收句柄，传句柄那一下就释放了，之后的 `applyData` 报 `Invalid model data token`；
    - S13d：上面「微任务时机」的差异。探针是同步回放，续体排到最后；
    - 点击与属性回调的先后：两边输入时机不同，不是行为差异。

    对照存在 `ignore/p14/4/api/`。
  - `p14-api` 在 WPE 里两次让它堆损坏崩溃，所以那些出错路径的用例只在单测里比，不在 WPE 里跑。
- **画面**：探针 `render_scene` + `scripts`，和 WPE 抓帧逐像素比：

  | 工程 | 结果 |
  |---|---|
  | `p14-format` | 整帧 0 差异：四种顶点格式（stride 48 / 64 / 36 / 32）、材质 COMBO、`g_Color4` 恒为 1、`scale.z` |
  | `p14-apply`（加 `precache` 的变体） | 回放 140 帧对 WPE 第 140 帧整帧 0 差异：当帧生效、调用时拷贝、两层共用、三种索引、包围盒剔除、`replaceData` 换成四边形 |
  | `p14-fb1` / `p14-fb2` | E16：模型读到当前画面。差异只在两个 / 一个三角形上，WPE 是全 0 快照的黑或旧快照的红 |

  `p14-apply` 原工程没写 `precache`，全走 Worker，REPLACE 那块探针重拼不了（探针没有单对象重编译，宿主走 L6），其余同样 0 差异。
- **3834692798**：复制工程（`ignore/p14/4/make_karin.py`，声音换成静音）。
  - **固定帧**：脚本常量 `FIXED_FRAME=120`。
    - 两边的 `KARIN_SCENE_SAMPLE` 相同（`modelHash 3b2a47a2`、321 个 drawable）。
    - 按 WPE 那一帧的 `g_Time` 渲染，整帧 207 万像素里只差 128 个，全在 `clip_119` 上，也就是 E16。
  - **性能**：`PROFILE_SECONDS=10`。WPE 是帧率 20 的测试窗口，我们是帧率 30 的预览：

    | | Kabegame | WPE |
    |---|---|---|
    | 每帧脚本 `update` 平均 / p95 / 最大 | 12.3 / 13 / 211 ms | 18.0 / 30 / 243 ms |

    我们的加载用时 7.2 s，其中编译 1.8 s、首帧 3.1 s（第一次 `update` 建 Cubism 运行时与 358 个层，全部同步拼装、当帧装上）。
- **语料**：234 张全部干净（3834692798 是最后一张有不支持项的）。

### dev 探针

- **同一套机制**：探针脚本自带数据仓，建层先走同步拼装，片段请求带描述，`replaceData` 改结构时能拼就按替换接回。
- **探针的限制**：拼不了的记进结果的 `reloads`，因为探针没有单对象重编译。
- **`prewarmFragments`**：预跑不收集整数 `model` 的配置，它们本来就同步。

### 组里的模型（P14b）

3816948983（锦鲤水景）的控制器脚本用 `createModelData` + `createLayer` 建模型层，再 `setParent(组, false)` 挂进组合层：224×126 的高度场网格
画进 `height-copy`，一部分锦鲤批次画进 `rain-copy`，水面 effect 读这两张组 RT。P5b 起组里的模型一律照报 `model:passthrough:children:model`，
运行中进组的按 L7「不画 + 看板娘提示」，组 RT 全是 0，水面偏亮偏青、上边与左边拉丝。P14b 起组里的模型照 WPE 画（静态 `parent` 指向组的 mdl
模型同样适用）。

- **依据**：
  - 读码：[rea-p14b-group-models.md](../../../.claude/plans/wpe-import/3-scene/phase14/rea-p14b-group-models.md)（网格绘制的模型栈、剔除平面、阴影 pass 的对象判定）。
  - WPE 实测：`ignore/p14/b/gen_p14b.py` 生成的 `p14b-gm-basic` / `-copybg` / `-rot3d` / `-depth` / `-shadow` / `-shadow-cb`，抓帧在 `A:\p14b\`。
  - 计划：[phase-14b-group-models.md](../../../.claude/plans/wpe-import/3-scene/phase14/phase-14b-group-models.md)。

| 项 | 规则 | 依据 |
|---|---|---|
| 不再照报 | `groupChildIssues` 去掉 `model:passthrough:children:model`；sprite（P13c）照报 | — |
| 矩阵 | 组画子树时 WPE 的模型栈是 `inverse(W_组)`、视图单位阵、投影是组的局部正交 `ortho(±w/2, ±h/2, ±1000)`，网格把世界矩阵并进模型栈：`g_ModelMatrix` = `inverse(W_组) · W`（`multiply`，即 glm 的 `FUN_14005ecb0`）、`g_ViewProjectionMatrix` = P、MVP = `P ⊗ M`（仿射），`g_EyePosition` 仍是场景的。`render/scene.ts` 网格那次 `drawUniformValues` 在组里换掉世界矩阵与视图投影 | `p14b-gm-basic` 的静态 S1、脚本 T1 与 `p14b-gm-rot3d`（组与子层都带 x / y 旋转）的 S1、R1 逐位相同；带 x / y 旋转时仿射乘法差 1 ulp。T1 的平移 y 是 19.999969…，WPE 真的做了这次乘法 |
| 光照 | 灯与阴影是场景空间的，组里的网格按局部坐标算光照（同 WPE，画面更暗） | `p14b-gm-shadow` |
| 深度 | 组的合成 RT 没有深度附件，深度状态不起作用，后画的盖住先画的；管线按目标有无深度各建一份（已有） | `p14b-gm-depth`：组里后画的 z −100 盖住 z +100，顶层对照 z +100 在前 |
| alpha | `copybackground: false` 的组 alpha 取 MAX，同图像层 | `p14b-gm-basic` |
| 阴影 | 组的子孙不投射：WPE 阴影 pass 跳过带 `0x2` 的对象，组本身不是不透明模型、也不画。我们的投射者照旧按对象建（换父不重建），`encode` 每帧按当前的组归属筛（`casterInGroup`），运行中进组 / 出组当帧生效 | 读码 4 节；`p14b-gm-shadow` / `-shadow-cb`（组写 `castshadow: true`）：阴影 pass 都只有顶层的 3 个投射 draw |
| 读帧缓冲 | E16 的层首快照照图像层的层首拷贝（P5f）：直接父是组时不拷，读到上一次拷下的内容（同 WPE），隔着分组节点的孙子照拷（拷组的合成 RT） | 照规则推，没有实测（语料 0 个） |
| 运行中换父 | L7 的重排对模型层照常：进组画进组 RT、管线换成没有深度的（同步建），出组换回 | `render/l7.test.ts` |

**和 WPE 有意不同（D1）**：WPE 组里的模型照样拿场景相机的六个平面测场景空间的外接球（平面只在场景绘制开头与阴影、体积光的视图函数里算，
组画子树不重算），组在画面外而组 RT 被别的图层读时，模型被错剔、引用方读到全空。这是缺陷，3816948983 不依赖它，语料里组里放模型的也只有
它，所以组里的模型不按场景相机剔除（`modelCulled` 见组就返回 false）。按组自己的视锥剔掉的只会是画不进组 RT 的东西，和不剔画面相同，所以
也不剔。只读了码、没有实测。

**对比结果**：探针 `render_scene`（`scripts: true`）和 WPE 抓帧整帧比，`p14b-gm-basic` / `-copybg` / `-rot3d` / `-depth` 0 差异，两个阴影工程
各 3 个像素差 1。3816948983 的复制工程（控制脚本的 `Math.random` 换成固定种子，`ignore/p14/b/seed_random.py`）按 WPE 日志回放到第 313 帧：
整帧只有 37 个像素差 1，`height-copy` 组 RT（224×126）的 RGBA 逐位相同。

**组里图像层的矩阵（P14c）**：同一次抓帧里组里的**图像层**也是 `g_ModelMatrix` = 局部、`g_ViewProjectionMatrix` = P，P14c 另开一步修了：
- **依据**：工程 `ignore/p14/c/gen_p14c.py` 的 `p14c-gi`（组带 x / y 旋转，组里与顶层各一份直接上屏、两个探针 effect、预光照、本地 / 世界空间粒子），
  抓帧 `A:\p14c\gi\`，常量用 `kbp rdc consts` 导出，我们的用 `render_scene` 的逐 draw 轨迹，`ignore/p14/c/cmp_consts.py` 逐 draw 逐常量比；
  计划 [phase-14c-group-image-matrices.md](../../../.claude/plans/wpe-import/3-scene/phase14/phase-14c-group-image-matrices.md)。
- **规则**（`render/uniforms.ts` 的 `drawMatrices` 收到 `group` 时）：模型矩阵是 `inverse(W_组) ⊗ W`（图像层画自己时 `FUN_1401e8aa0` 内联的仿射乘法，
  `mulAffine`；glm 乘法差 1 ulp），`g_ViewProjectionMatrix` 是组的局部正交 P，MVP 不变（`P ⊗ M`，P8 步骤 7 的抓帧照样逐位）；effect 中间 pass 与末
  pass 的 `g_EffectModelMatrix`（中间 pass 再乘半尺寸）、`g_LayerModelMatrix` 仍是世界矩阵 W（WPE 的 `this+0x384`）。直接上屏、末 pass 的这些矩阵和
  WPE 逐位相同；预光照的 Alt 矩阵改动前就相同。
- **和 WPE 有意不同**：组里 effect 的 `g_EffectModelViewProjectionMatrix` / `g_EffectTextureProjectionMatrix`，WPE 是 `P_组 ⊗ W`（`this+0x344` 是模型栈顶被
  换成 W 之后算的 MVP，漏了组的逆；铺满全屏、居中不转的组就差半个屏幕），读它们采屏幕或换算光标的 effect（`godrays` / `shine` 的合成、`cursorripple`、
  `fluidsimulation`、`xray`、`depthparallax`）在组里会错位。语料里组里没有读它们的 effect（`ignore/p14/c/scan_group_fx.py`），按缺陷不复现，取图层 MVP。
- **语料**：组里读 `g_ModelMatrix` / `g_ViewProjectionMatrix` 等的只有 3 张（3784630846、3838255453、3838495182 的 `genericimage4`），都没开光照、反射、
  雾，着色器实际不读它们，画面不变。
- **没覆盖的**：组里的文本仍用 `groupViewProjection`。`p14c-gi` 里两颗粒子和 WPE 不同的原因是朝向，P14d 修了（见下）。

**组里的粒子（P14d）**：`p14c-gi` 里组带 x / y 旋转时，组里两颗粒子的位置和 WPE 相同（质心差 0.05 像素），四边形的形状不同：WPE 的跟着组 RT
一起斜，我们的正对屏幕。
- **依据**：读码 rea-p4c-sim 5.3（组合层离屏渲染时 `ctx+0xaf0` 临时设成当时的模型矩阵，`0x1401ecd0a` / `0x1402083e4`）与 rea-p4e-children
  第 6 节；工程 `ignore/p14/d/gen_p14d.py` 的 `p14d-gp`（组同 `p14c-gi`，组里与顶层各一份 sprite / 世界 sprite / `upright` / `fixed` /
  spritetrail / `LIGHTING` / 本地父带本地与世界 static 子 / 世界父带本地 static 子），抓帧 `A:\p14d\gp\`，`kbp rdc consts` 起导出几何阶段
  （`gs`：粒子的 MVP 与 `g_Orientation*` 在几何着色器里读，P14c 因此没导出来），`ignore/p14/d/cmp_consts.py` 逐 draw 逐常量比；计划
  [phase-14d-group-particles.md](../../../.claude/plans/wpe-import/3-scene/phase14/phase-14d-group-particles.md)。
- **规则**：WPE 画组的子树时粒子的绘制栈从 `inverse(W_组)` 起：本地系统的模型矩阵 `inverse(W_组) · W`（压栈的 glm 乘法，仿射乘法差 1 ulp），
  世界系统与世界子系统 `inverse(W_组)`（`ctx+0xaf0`），本地子系统与事件实例在栈顶上照 P4e 乘局部矩阵；视图投影是组的局部正交 P，
  MVP = `P ⊗ M`。`g_ModelMatrix`、`g_Orientation*`、拖尾的 `g_ModelMatrixInverse` 都从 M 来，所以 sprite 正对组自己的相机，组 RT 斜着上屏时
  跟着斜；`g_ViewForward` / `g_ViewUp`、`g_EyePosition` 仍是场景的。实现：`ParticleSystem.forEachDrawn` / `drawTransform` 的起点 `base`，
  渲染器 `particleBase`（非全屏组、组的世界矩阵可逆时取 `groupMvpParts(...).inverse`），粒子分支的视图投影换成 P；不在组里时逐字节不变。
- **和 WPE 有意不同**：世界空间系统画完，WPE 把栈顶恢复成 `sys+0x3a0` = W（不带组的逆），挂在它下面的本地 static 子系统按 `W · L` 配 P 画到
  组 RT 外（`p14d-gp` 的 WCa，事件 260，MVP 与朝向都逐位对上 `W · L`）。语料里没有组里的粒子（`ignore/p14/d/scan_group_particles.py`：有父的
  粒子 16 个，父都是粒子、puppet 或分组节点），缺陷不复现，取 `inverse(W_组) · W`，子系统画在组里该在的位置。
- **对比结果**：`p14d-gp` 组里 11 次粒子绘制除 WCa 外全部常量逐位相同，整帧只有 WCa 那一颗（173 个像素）不同；`p14c-gi` 整帧 0 差异（改动前
  308 个像素）。
