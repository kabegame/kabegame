# effect 各 pass 的内置矩阵：WPE 2.8.42 与我们的对照

> 状态：完成（2026-11-12）。只调研、不改产品代码。

## 目的

P7d 步骤 0 的测试工程 `ignore/p7d/proj/p7d-uni`（生成器 `ignore/p7d/gen_uni.py`）里，图层 `kbfx` 只挂一个两 pass 的 effect
（第一个画进 fbo `_rt_KbA`，第二个 bind 它上屏）。抓帧 `A:\p7d\uni\uni-frame161.rdc` 事件 73（第一个 pass）读到：

- 顶点是 ±1 的全屏四边形；
- `g_ModelViewProjectionMatrix` = 图层 MVP（场景视图投影 × 图层世界矩阵），**不是单位阵**；
- `g_ModelMatrix` = 图层世界矩阵，`g_EffectModelMatrix` = 图层世界矩阵（**不缩放**）。

我们的 `drawMatrices`（`apps/wpe-scene/src/render/uniforms.ts`）把这一步当 `effect` 角色：MVP、`g_ModelMatrix` 单位阵，效果矩阵乘
`scale(w/2, h/2)`。本报告核对 WPE 给 effect 各 pass 写的内置矩阵，与我们的实现逐种对照，并评估语料影响。

要回答的五种情况：

1. 非最后一个 effect 的各个 pass（画进合成 RT / fbo）；
2. 最后一个 effect 的非最后 pass（画进 fbo，或 `compose` 画进合成 RT）；
3. 最后一个 effect 的最后一个 pass（上屏）；
4. colorBlendMode 走 passthrough 时（所有 effect 都留在合成链）；
5. 基础 pass（图层本身画进合成 RT）。

每种情况要的量：`g_ModelViewProjectionMatrix`、`g_ModelMatrix`、`g_EffectModelMatrix`、`g_EffectModelViewProjectionMatrix`、
`g_EffectTextureProjectionMatrix`（及各 `Inverse`），以及用的几何。

## 方法

- **读码**：`wallpaper64.exe` 2.8.42 分析副本（SHA-256 `40e2ce02…`）。P7d 读码代理已把要用的函数导出成 scratchpad 的
  `p7d/dc/*.c`（`FUN_1401ebf60`、`FUN_1401e8aa0`、`FUN_1400d8300`、`FUN_1400d4200`、`FUN_1401e7170`…），同目录还有全量反汇编
  `decomp/all.asm`；本次直接读这两份、用小脚本查虚表与跳转表（`p7d/vt.py`、`jt.py`、`findq.py`），**没有再开 REA**，所以没有
  新快照（`wallpaper64-2.8.42-p7d.rea-snapshot` 原样留着）。
- **实测**：生成器 `ignore/p7d/gen_mvp.py` → 工程 `ignore/p7d/proj/p7d-mvp`，几个图层分别覆盖五种情况，顶点着色器把全部矩阵读一遍；
  wpe-renderdoc MCP 抓帧到 `A:\p7d\mvp\`（测试窗口 1280x720），用 `get_shader_info` / `get_mesh_data` 读常量与顶点。
- **语料**：P7 请求夹具 `ignore/p7/requests-p7c/*.json`（每个请求的顶点 / 片元原文与 `name`、`scenes`），能否渲染看
  `ignore/p7/out/corpus-p7c.json` 的 `unsupported`。

置信度用语：**实测**（抓帧读到）、**静态确认**（反编译读到）、**推断**、**未知**。


## 一、读码结论（静态）

反编译直接用 scratchpad 里已导出的 `p7d/dc/*.c`（与快照同一份 `wallpaper64.exe`，SHA-256 `40e2ce02…`），机器码核对用同目录的
全量反汇编 `decomp/all.asm`；没有再起 REA 长任务。

### S1. 矩阵 uniform 分两类：「随变换栈现算」与「上下文存值」

`FUN_1400d8300`（uniform ID → 取值）：

| uniform | ID | 取值 | 类别 |
|---|---|---|---|
| `g_ModelMatrix` | 9 | 模型栈顶 `*(ctx+0x30)` | 现算 |
| `g_ModelMatrixInverse` | 0xa | 模型栈顶求逆 | 现算 |
| `g_ViewProjectionMatrix` | 0xb | `ctx+0x930` = 视图栈顶 × 投影栈顶（`FUN_1400d4200`，脏标志 `ctx+0x1ca` 时重算） | 现算 |
| `g_ModelViewProjectionMatrixInverse` | 0xc | `ctx+0x8f0` 求逆 | 现算 |
| `g_ModelViewProjectionMatrix` | 0xd | `ctx+0x8f0` = 模型 × 视图 × 投影（行向量约定，`FUN_1400d4200`） | 现算 |
| `g_NormalModelMatrix` | 0xe | 模型栈顶前三行各自单位化 | 现算 |
| `g_EffectModelMatrix` | 0x13 | `ctx+0x970` | 存值 |
| `g_EffectModelViewProjectionMatrix` | 0x14 | `ctx+0x9b0` | 存值 |
| `g_EffectModelViewProjectionMatrixInverse` | 0x15 | `ctx+0x9b0` 求逆 | 存值 |
| `g_EffectTextureProjectionMatrix` | 0x16 | `ctx+0x9f0` | 存值 |
| `g_EffectTextureProjectionMatrixInverse` | 0x17 | `ctx+0x9f0` 求逆 | 存值 |
| `g_LayerModelMatrix` | 0x18 | `ctx+0xa30` | 存值 |

- **WPE 没有 `g_EffectModelMatrixInverse`**：内置名表（`uniids.txt`，0x13–0x17 连续）里没有它，着色器声明了也只是普通 uniform
  （材质常量缺省值）。我们 `staticBuiltins` 给它写了逆矩阵。
- **MVP 与 `g_ModelMatrix` 不存在「只在某些条件下写」**：每次 bind 都从当前变换栈取（脏了先重算），值就是这次绘制时栈上的东西。
- **存值类的写入点只有三处**（全量反汇编里搜 `0x970/0x9b0/0x9f0/0xa30(%r…)` 的写入）：
  1. `0x14017c9b4` 一带：上下文初始化成单位阵；
  2. `FUN_1401ebf60`（effect 的每个 pass）：只在 pass 标志 bit0 置位时写 0x970 / 0x9b0 / 0x9f0 / 0xa30 四个；
  3. 粒子绘制（`0x1401986de`）：只写 0x970（取自 `ctx+0x930` 派生的局部矩阵），不写另外三个。
  所以基础 pass、直接上屏、passthrough 上屏、组上屏这些绘制读到的效果矩阵和 `g_LayerModelMatrix` **是残留值**：上一次写它们的
  effect pass（或粒子）留下的。
- **pass 标志 bit0 的来源**（`FUN_1401e7170` 第 469–473 行）：`material+0x1e0`（着色器程序）的虚函数 +0x20 = `FUN_1400d7f80`
  返回 `shader+0x10 | (shader+0xe0 != 0)`，`& 4` 置位 → pass 标志 bit0。`shader+0x10 |= 4` 在 `0x1400dbc73`：注册 uniform 时
  按 ID−0x13 查跳转表（`0x1400dc020` 字节表 + `0x1400dc010` 四项表），ID 0x13–0x18（五个效果矩阵 + `g_LayerModelMatrix`）落在
  `orl $0x4, 0x10(%rax)`。即「这个 pass 的着色器声明（反射到）任一效果矩阵或 `g_LayerModelMatrix`」。所以对读这些矩阵的
  effect pass 而言值总是新写的；残留只发生在不走 `FUN_1401ebf60` 的绘制上。置信度：静态确认。

### S2. 每个 pass 前的变换栈（`FUN_1401e8aa0`）

- **图层开始**（第 486–546 行）：压模型栈，栈顶 = `vfunc+0x80` 返回的矩阵（`FUN_1401fd3f0` → `FUN_1401850a0`，图层世界矩阵，下称
  `W`），存进 `layer+0x384`（下称 `L`，= `W`）；脏了重算后把 `ctx+0x8f0`（`W × 场景视图 × 场景投影`，下称 `M0`）快照进
  `layer+0x344`，然后弹栈。`L`、`M0` 就是效果矩阵的原料。
- **基础 pass**（第 563–607 行，图层标志 `0x304` bit5 = 0，即普通图像层）：模型 = 单位阵，视图 = 单位阵（拷模型栈顶），投影 =
  设备 vfunc+0x18 按合成 RT 尺寸给的正交（铺满）；bit5 = 1（组合层模型）时模型 = `W`、视图投影保持场景相机。之后 vfunc+0xe8
  画基础材质。**不调 `FUN_1401ebf60`，效果矩阵不写。**
- **effect 循环之前**（第 734–774 行）：bit5 = 1 时把模型、视图重置成单位阵（bit5 = 0 时基础 pass 已经是单位阵）；投影一律
  `ortho(−1, 1, −1, 1, −1000, 1000)`（`0x1401e99d8`–`0x1401e9a1b`：xmm2 = −1、xmm3 = 1、栈上 −1、1、−1000、1000）。所以
  **非 final 的 effect pass：MVP = 这个正交（xy 是单位阵，z 只差一个缩放 / 平移），`g_ModelMatrix` = 单位阵，
  `g_ViewProjectionMatrix` = 同一个正交**；几何是 `layer[0x5c]`（±1 全屏四边形）。
- **effect 循环**（第 786–888 行）：逐个启用 effect、逐个 pass：进 pass 之前若（非 passthrough 且）**合成计数 == 阈值**就跳出，
  记下当前 effect 与 pass 下标；否则调 `FUN_1401ebf60(…, final = 0)`；pass 带 `compose`（标志 bit1）时计数 +1 并换合成 RT；
  effect 结束时计数 +1。阈值 `0x180(rsp)` = `layer+0x320`（合成次数 = Σ 启用 effect (1 + compose 数)）− 1，passthrough 时不减 1
  （第 474–481 行），计数从 0 开始。
  - 推论：**非 passthrough 图层里，最后一个启用 effect 从「它最后一个 compose pass 之后」的那个 pass 起全部转成 final 模式**；
    该 effect 没有 compose 时从它的第一个 pass 起就是 final。passthrough 图层的阈值够不到，所有 effect pass 都是非 final。
- **final 段**（第 890–1071 行）：弹回图层开始时的三个栈，再压栈：非 fullscreen 时模型 = `W`（`vfunc+0xa8` 对图像层是空函数
  `0x1400a36d0`，再左乘 `W`），视图投影 = 场景相机（`0x304 & 0x80` 时另走 `FUN_1401e5b60`，透视）；fullscreen 时模型、视图 =
  单位阵、投影 `ortho(−1, 1, −1, 1, −1, 1)`。然后对记下的 effect，从记下的 pass 起到最后逐个调 `FUN_1401ebf60(…, final = 1)`。
  **final 模式下所有 pass 的 MVP = `W × VP`（图层 MVP）、`g_ModelMatrix` = `W`，不论它画进 fbo 还是上屏**；只有下标 ==
  `effect+0x144`（最后一个绘制 pass）的那个画图层四边形 `layer[0x5d]`、借基础材质的混合上屏，其余照旧画 `layer[0x5c]`（±1）
  进各自 fbo。
- **passthrough 段**（第 1072–1109 行）：同一套 final 变换栈（模型 = `W`、场景相机），`g_Color4` = 1，passthrough 材质槽 0 =
  最终合成 RT，vfunc+0xf8 上屏。**不调 `FUN_1401ebf60`**，效果矩阵是残留值（WPE 的 `genericimage3/4` 不读它们，见下）。

### S3. 效果矩阵的写法（`FUN_1401ebf60` 第 183–327 行，pass 标志 bit0 时）

记 `S = diag(w/2, h/2, 1, 1)`（w、h = 图层 `size`，`layer+0x2f0 / 0x2f4`），行向量约定下「先缩放」写作 `S·X`，换成列向量就是
`X × scale(w/2, h/2)`：

| 量 | final = 0（非 final） | final = 1 |
|---|---|---|
| `g_LayerModelMatrix`（0xa30） | `L` | `L` |
| `g_EffectModelMatrix`（0x970） | `L × scale(w/2, h/2)` | `L` |
| `g_EffectModelViewProjectionMatrix`（0x9b0） | `M0 × scale(w/2, h/2)` | `M0` |
| `g_EffectTextureProjectionMatrix`（0x9f0） | 同 0x9b0 | `M0 × scale(w/2, h/2)` |

`L = W`、`M0` = 图层开始时的 `W × VP`。注意按 **final 标志** 分，不是按「是不是最后一个绘制 pass」分。置信度：静态确认
（与 p2-REPORT I4 一致，补上了 final 标志的含义）。

### S4. WPE 自带着色器的写法佐证

- `effects/blurprecise`：两个 pass 共用 `blur_precise_gaussian.vert`，`VERTICAL`（第二个 pass，最后一个绘制）才
  `mul(a_Position, g_ModelViewProjectionMatrix)`，第一个（画进 fbo）用 `vec4(a_Position, 1.0)`。这个 effect 单独挂在图层上时
  第一个 pass 是 final 模式，乘 MVP 会把 ±1 四边形变成 fbo 里图层位置上 2×2 模型单位的一小块——作者正是因此不乘。
- `materials/util/effectcomposebackground.json`（`refraction` 的第一个 pass，`compose: true`）：
  `gl_Position = mul(a_Position, g_ModelViewProjectionMatrix)`、`v_ScreenCoord = mul(a_Position, g_EffectModelViewProjectionMatrix)`。
  它在 compose 之前，是非 final：MVP ≈ 单位阵，铺满合成 RT；效果 MVP = `M0 × scale` 把 ±1 映到图层在屏幕上的位置。
- passthrough 材质 `effectpassthrough(_4).json` = `genericimage3/4`：只读 `g_ModelMatrix`、`g_ModelViewProjectionMatrix`
  （`g_NormalModelMatrix` 等只在 LIGHTING / REFLECTION 下），不读效果矩阵。

## 二、实测（`p7d-mvp`，抓帧 `A:\p7d\mvp\mvp-frame225.rdc`，1280x720）

工程 `ignore/p7d/proj/p7d-mvp`（生成器 `ignore/p7d/gen_mvp.py`）：所有着色器的顶点阶段把 12 个矩阵（含 WPE 没有的
`g_EffectModelMatrixInverse`）读一遍，`gl_Position` 一律乘 MVP；每个 effect pass 用材质常量 `k_tag` 标号。常量用
`ignore/p7d/rdc_cbuf.py`（隐藏的 qrenderdoc 里调 MCP 服务层，导出 25 个绘制的顶点常量、输入顶点、输出目标，
`ignore/p7d/out/mvp-cbuf.json`）批量读，`ignore/p7d/ana_mvp.py` 按候选矩阵归类（`ignore/p7d/out/mvp-ana.txt`）。

记号（行向量约定，常量缓冲里平移在第 4 行；换成我们的列向量写法就是转置、乘法顺序反过来）：`W` 图层世界矩阵（子层含父链），
`VP` 场景视图投影（1920x1080 正交，z 缩放 0.00025、平移 0.5），`S` = `diag(w/2, h/2, 1, 1)`，`E` = `ortho(−1, 1, −1, 1, −1000, 1000)`
= `[1,0,0,0 | 0,1,0,0 | 0,0,0.0005,0 | 0,0,0.5,1]`，`F` = 基础 pass 的铺满正交。

| 事件 | 图层 / tag | 情况 | 几何（a_Position） | MVP | Model | VP | EffectModel | EffectMVP | EffectTexProj | LayerModel |
|---|---|---|---|---|---|---|---|---|---|---|
| 37 | A 111 | 非末 effect，p0 → fbo | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W` |
| 54 | A 112 | 非末 effect，p1 → 合成 | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W` |
| 72 | A 121 | 末 effect，compose 之前，→ fbo | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W` |
| 89 | A 122 | 末 effect 的 compose pass → 合成 | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W` |
| 107 | A 123 | 末 effect，compose 之后，→ fbo | ±1 | **`W·VP`** | **`W`** | **`VP`** | **`W`** | **`W·VP`** | **`S·W·VP`** | `W` |
| 125 | A 124 | 末 effect 末 pass，上屏 | ±w/2, ±h/2 | `W·VP` | `W` | `VP` | `W` | `W·VP` | `S·W·VP` | `W` |
| 160 | B 131 | 唯一 effect，p0 → fbo | ±1 | **`W·VP`** | **`W`** | **`VP`** | **`W`** | **`W·VP`** | **`S·W·VP`** | `W` |
| 177 | B 132 | 唯一 effect，p1 → fbo | ±1 | **`W·VP`** | **`W`** | **`VP`** | **`W`** | **`W·VP`** | **`S·W·VP`** | `W` |
| 195 | B 133 | 唯一 effect，末 pass，上屏 | ±w/2, ±h/2 | `W·VP` | `W` | `VP` | `W` | `W·VP` | `S·W·VP` | `W` |
| 232 / 249 | C 141 / 142 | passthrough 图层的 effect pass | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W` |
| 271 | C passthrough 上屏（genericimage4） | passthrough | ±w/2, ±h/2 | `W·VP` | （未引用） | — | — | — | — | — |
| 288 | D 941 | 基础 pass → 合成 | **0…w, 0…h** | `F` | `I` | `F` | 残留 = C 142 的 `S·W·VP` 等 | 残留 | 残留 | 残留 = `W[C]` |
| 305 / 323 | D 151 / 152 | 唯一 effect | ±1 / ±w/2 | `W·VP` | `W` | `VP` | `W` | `W·VP` | `S·W·VP` | `W` |
| 373 / 390 | K 161 / 162（子层） | 非末 effect | ±1 | `E` | `I` | `E` | `S·W` | `S·W·VP` | `S·W·VP` | `W`（含父链） |
| 408 / 426 | K 163 / 164（子层） | 末 effect（无 compose） | ±1 / ±w/2 | `W·VP` | `W` | `VP` | `W` | `W·VP` | `S·W·VP` | `W`（含父链） |
| 440 | G 971 | 直接上屏（无 effect） | ±w/2, ±h/2 | `W·VP` | `W` | `VP` | 残留 = K 164 的 `W`、`W·VP`、`S·W·VP` | 残留 | 残留 | 残留 = `W[K]` |

- 各 `Inverse` 都是对应矩阵的逆（`ModelInverse` = `W⁻¹` / `I`、`MVPInverse` = `(W·VP)⁻¹` / `E⁻¹` 等），归类全部命中。
- **`g_EffectModelMatrixInverse`**：在材质常量缓冲 `g_bufStatic` 里，值是未初始化的垃圾（`4390.41, 4389.00, 1.63e9, …`，每个
  pass 不同）——WPE 不认这个名字，S1 实测证实。
- **基础 pass 的几何**：`a_Position` 是 `(0…w, 0…h)` 的四边形（`(0, h)` 处 UV `(0, 0)`），`F` = `[2/w,0,0,0 | 0,2/h,0,0 |
  0,0,0.0005,0 | −1,−1,0.5,1]`。结果和我们「±w/2 的图层四边形 × `ortho(±w/2, ±h/2)`」铺出的画面相同，但 `a_Position` 与 MVP
  的数值不同（只有基础材质的顶点着色器直接用 `a_Position` 或读 MVP 的分量时才看得出）。
- 子层（K）的 `W`、`g_LayerModelMatrix` 都带父链（与 `Wlocal` 不同、与 `W_local · W_parent` 相同），`L = W` 证实。

**结论：S2 / S3 的读码全部被实测证实。** 置信度：实测。

## 三、五种情况的 WPE 规则（结论）

决定矩阵的不是「是不是最后一个绘制 pass」，而是 **final 标志**：非 passthrough 图层里，最后一个启用 effect 从它最后一个
`compose` pass 之后的那个 pass 起（没有 compose 就从第一个 pass 起）全部是 final；其余 effect pass 一律非 final。

| 情况 | 几何 | MVP | Model | VP | EffectModel | EffectMVP | EffectTexProj | 置信度 |
|---|---|---|---|---|---|---|---|---|
| ① 非最后一个 effect 的各 pass（fbo / 合成 RT） | ±1 | `E` | `I` | `E` | `W × scale(w/2,h/2)` | `M0 × scale` | 同 EffectMVP | 实测（37、54、373、390） |
| ②a 最后一个 effect、最后一个 compose 及之前的 pass（含 compose pass 本身） | ±1 | `E` | `I` | `E` | `W × scale` | `M0 × scale` | 同 EffectMVP | 实测（72、89） |
| ②b 最后一个 effect、最后一个 compose 之后的非末 pass（画进 fbo；无 compose 时就是除末 pass 外的全部） | **±1** | **`M0`（图层 MVP）** | **`W`** | 场景 `VP` | **`W`** | **`M0`** | `M0 × scale` | 实测（107、160、177、305、408） |
| ③ 最后一个 effect 的最后一个绘制 pass（上屏） | 图层四边形 ±w/2 | `M0` | `W` | 场景 `VP` | `W` | `M0` | `M0 × scale` | 实测（125、195、323、426） |
| ④ passthrough 图层：全部 effect pass | ±1 | `E` | `I` | `E` | `W × scale` | `M0 × scale` | 同 EffectMVP | 实测（232、249） |
| ④ passthrough 上屏（genericimage3/4） | 图层四边形 | `M0` | `W` | 场景 `VP` | 残留 | 残留 | 残留 | MVP 实测（271）、残留静态确认 |
| ⑤ 基础 pass（普通图像层画进合成 RT） | **(0…w, 0…h)** | `F` | `I` | `F` | 残留 | 残留 | 残留 | 实测（20、143、214、288、356） |

- `E` = `ortho(−1,1,−1,1,−1000,1000)`：xy 是单位阵，z 乘 0.0005 再加 0.5；`F` = 把 `(0…w, 0…h)` 铺满合成 RT 的正交（z 同 `E`）；
  `W` = 图层世界矩阵（含父链、**不带视差**）；`M0` = 图层开始时快照的 `W × VP`，视差在 `VP` 里（p5a-fx）；`scale` 用图层 `size`。各 `Inverse` = 对应矩阵求逆。
  更正（2026-11-12 主会话实测 `A:\p7d\unipar\unipar-frame132.rdc` 事件 73，`p7d-uni` 开视差）：MVP 的平移随视差变了，
  `g_LayerModelMatrix` 与 `g_ModelMatrix` 的平移仍是 `(960, 600)`。初稿写成「`W` 带视差」是错的。
- **MVP / Model / VP 没有「只在某些条件下写」**：每次绑定都取当前变换栈。**效果矩阵与 `g_LayerModelMatrix` 只在 effect pass 的
  着色器声明（反射到）其中任一个时写**（ID 0x13–0x18 → 能力位 4 → pass 标志 bit0），所以 effect pass 自己读到的总是新值；
  基础 pass、直接上屏、passthrough 上屏读到的是上一次写入的残留（实测 288 读到 C 图层末 pass、440 读到 K 图层末 pass 的值）。
- WPE 没有 `g_EffectModelMatrixInverse`：读到的是材质常量缓冲里未初始化的垃圾。

## 四、我们的实现差在哪

角色划分（`graph.ts`）：只有「最后一个启用 effect 的最后一个绘制 pass」是 `final`，其余 effect pass 全是 `effect`；passthrough
图层全是 `effect` + 一个 `passthrough`；基础 pass `base`（几何 `fill` = ±w/2 的图层四边形，`scene.ts` 的 `layerQuad(layer.size)`）。
矩阵（`uniforms.ts` 的 `drawMatrices` / `staticBuiltins`，列向量写法）：

| 情况 | 量 | WPE | 我们 | 影响 |
|---|---|---|---|---|
| ②b | `g_ModelViewProjectionMatrix` 及逆 | 图层 MVP | 单位阵 | **主要差异**：乘 MVP 的顶点着色器在 WPE 里画成 fbo 里一小块，我们铺满 |
| ②b | `g_ModelMatrix` 及逆、`g_NormalModelMatrix` | `W` | 单位阵 | 读模型矩阵的着色器不同 |
| ②b | `g_EffectModelMatrix` | `W` | `W × scale(w/2,h/2)` | 不同 |
| ②b | `g_EffectModelViewProjectionMatrix` 及逆 | `M0` | `M0 × scale` | 不同 |
| ②b | `g_EffectTextureProjectionMatrix` 及逆、`g_ViewProjectionMatrix` | `M0 × scale`、场景 VP | 同 | 一致 |
| ②b（透视图层） | VP | final 段整段换透视相机（`0x304 & 0x80` → `FUN_1401e5b60`） | `scene.ts` 只在 `target.kind === "scene"` 时换透视 | 跟着 ②b 一起改（读码，没实测） |
| ①②a④ | `g_ViewProjectionMatrix` | `E` | 场景 VP（带视差） | 不同，读 VP 的非 final pass 才看得出 |
| ①②a④ | MVP、MVP⁻¹ 的 z 行 / 列 | `E`（z·0.0005 + 0.5）、`E⁻¹` | 单位阵 | 只差 z；不开深度、不用 `.z` 时看不出 |
| ③ | 全部 | — | — | 一致 |
| ④ passthrough 上屏 | 效果矩阵 | 残留（最后一个 effect pass 的非 final 值） | final 式（`W`、`M0`、`M0 × scale`） | genericimage3/4 不读，看不出 |
| ⑤ | `a_Position` 与 MVP | `(0…w, 0…h)` × `F`（平移 −1） | `±w/2` × `ortho(±w/2, ±h/2, ±10000)` | 铺出的画面相同；直接用 `a_Position` 或 MVP 分量的基础材质不同 |
| ⑤、直接上屏 | 效果矩阵、`g_LayerModelMatrix` | 残留（别的图层的值） | `EffectModel = Model`、`EffectMVP = MVP`、`TexProj = I`；`g_LayerModelMatrix` 不提供 | 无法复刻（取决于绘制顺序）；P7d 已定照报 |
| 全部 | `g_EffectModelMatrixInverse` | 不是内置名（垃圾值） | 写成 `EffectModel` 的逆 | 读它的着色器在 WPE 里本来就未定义 |

## 五、语料影响

脚本 `ignore/p7d/corpus_mvp.py`（结果 `ignore/p7d/out/corpus-mvp.json`）：对 `ignore/p7/out/corpus-p7c.json` 的 173 个场景（能渲染 42 个），
读 scene.json / effect.json / 材质，按 S2 的规则给每个启用的绘制 pass 定 WPE 模式；着色器用法取 P7 请求夹具（按请求自己的 combos、
defines、litDefines 预处理 `#if`、内联头文件，去掉注释与 uniform 声明后看名字；pass 与请求按「材质 + 实例 combos，缺省取 `[COMBO]`
注解默认值」匹配，2206 个 pass 全部精确匹配到请求）。顶点、片元两个阶段都算。

| 模式（WPE / 我们） | pass 数 |
|---|---|
| ③ last / `final` | 1012 |
| ①②a④ nonfinal / `effect` | 1044 |
| **②b final / `effect`（角色不一致的那一类）** | **150**（37 个场景，其中能渲染 4 个：3799426930、3812822229、3820104696、3822495444，共 16 个 pass） |

- **②b 的 150 个 pass 里，读 MVP / MVP⁻¹ / Model / Model⁻¹ / NormalModel / EffectModel / EffectMVP（及逆）的：0 个**；
  `gl_Position` 乘 MVP 的：0 个。它们来自 godrays（9 场景）、blurprecise（9）、cursorripple（5）、blur（4）、工坊 blurprecise 副本
  （3 + 1）、glitter（3）、motionblur、bokeh_blur、shine、工坊 bloom（各 2）；唯一读到矩阵的是 `cursorripple_apply_force` 的
  `g_EffectTextureProjectionMatrixInverse`（两边相同）。`blur_precise_gaussian` 原文里有 MVP，但在 `VERTICAL` 分支，第一个 pass
  不走（P7 请求的 combos 证实）。
- **①②a④ 读 `g_ViewProjectionMatrix` 的：0 个**；读 MVP⁻¹ 的 1 个：工坊 2423877731 的 `chromatic_aberration`（场景 3585875739，
  不能渲染），只取 `.xyw`，z 的差别不影响结果。
- **读 `g_EffectModelMatrixInverse` 的：0 个**；基础材质读效果矩阵或 `g_LayerModelMatrix` 的：0 个（读效果矩阵的请求全是 effect 着色器：
  xray、depthparallax、cursorripple、fluidsimulation_vorticity 读 `EffectTexProj⁻¹`，effectcomposebackground、dot_matrix、
  frame_builder、audio_responsive_oscilloscope 读 `EffectMVP`，都落在 ①②a 或 ③；`ignore/p7d/req_usage.py`）。
- WPE 自带 effect 全集（`assets/effects/*`，单独挂在图层上，`ignore/p7d/assets_scan.py`）：②b pass 里按原文读这些矩阵的只有
  blurprecise p0（`VERTICAL` 分支，按材质 combos 不走）。`fluidsimulation`（P7d）的 17 个 ②b pass 里只有 vorticity 读
  `EffectTexProj⁻¹`（两边相同），末 pass combine 读 MVP 与 `EffectModel`，属 ③（`ignore/p7d/fluid_modes.py`）。

**结论：当前语料没有任何场景（能渲染的更没有）会因这处差异画得不同。** 差异只会出现在作者在「最后一个 effect 的中间 pass」里也
乘 MVP、或读模型 / 效果矩阵的工坊 effect 上——WPE 自己的写法正好避开了它（中间 pass 用 `vec4(a_Position, 1.0)`）。

## 六、修法建议（不实现）

1. **新增角色 `effectFinal`**（或给 `effect` 加 `final: boolean`），`graph.ts` 按 WPE 的计数排：
   - 非 passthrough 图层：`count` = Σ 启用 effect（1 + compose 数），阈值 `count − 1`；逐 pass 前若「计数 == 阈值」，本 effect
     剩余的 pass 都是 final；其中最后一个绘制 pass 仍是现在的 `final`（上屏），其余是 `effectFinal`（几何仍 `fullscreen` ±1、目标照旧）。
   - 现在的 `nextComposite()` 计数（`writes`）不能直接用：它从基础 pass 算起；WPE 的计数从 0 开始、不含基础 pass。实现时另记一个
     从 0 起的计数，在 compose pass 之后与每个 effect 结束时 +1（`FUN_1401e8aa0` 第 786–888 行）。
   - passthrough 图层不变（全部 `effect`）。
2. **`drawMatrices` 的 `effectFinal`**：`modelViewProjection` = 图层 MVP，`model` = `world`，`viewProjection` 照传，`effectModel` =
   `world`，`effectModelViewProjection` = 图层 MVP，`effectTextureProjection` = 图层 MVP × scale(w/2, h/2)——和 `final` 完全相同，
   只是几何不同。最省事的写法是 `case "final": case "effectFinal":` 共用。`LAYER_UNIFORMS` 就地刷新是同一组名字，不用动。
3. **`scene.ts` 的透视换相机**：条件从 `step.target.kind === "scene"` 改成「角色是 `final` / `effectFinal` / `passthrough`」（WPE 整个
   final 段都换透视相机；passthrough 上屏同段）。组（`groupVp`）与 fullscreen 分支照旧按角色走，`effectFinal` 跟 `final` 同处理。
4. **顺带（可选，语料 0 处）**：
   - `effect` 角色的 `viewProjection` 改给 `E`（`ortho(−1,1,−1,1,−1000,1000)`），MVP 也给 `E`（只差 z），与 WPE 逐值一致；
   - `g_EffectModelMatrixInverse` 从 `ENGINE_UNIFORMS` 与 `staticBuiltins` 去掉（WPE 不认，按普通 uniform / 照报处理）；
   - 基础 pass 的几何改成 `(0…w, 0…h)` 配 `F`，只影响直接用 `a_Position` 的基础材质，优先级最低。
5. **验收**：`p7d-mvp` 已有 WPE 真值（`A:\p7d\mvp\mvp-frame225.rdc`，表见第二节），改完用 kabegame-dev 渲染同一工程，读各 pass 的
   uniform 逐项比；另加一个「②b pass 的顶点乘 MVP」的画面用例（例如本工程 A / B 图层的 fbo 内容：WPE 里是一小块）。

## 七、仍未知

- **fullscreen 图层的 ②b 与效果矩阵**：final 段对 fullscreen 用 `ortho(−1,1,−1,1,−1,1)`、模型 / 视图单位阵（读码），而 `L`、`M0` 仍取
  图层自己的 `vfunc+0x80`；fullscreenlayer 的 `W` 与 `size` 是什么、我们 fullscreen 分支（`world = I`、`FULLSCREEN_VIEW_PROJECTION`）
  在效果矩阵上是否一致，没实测。
- **透视图层的 ②b**：只读码，没实测。
- **组（composelayer 带子层）里子层的 effect**：WPE 画子树时的投影栈，没实测（P5b 已记）。
- **passthrough 上屏 / 组上屏的残留值**：静态确认不写，genericimage3/4 不读，读不到；除非覆盖 `materials/util/effectpassthrough*.json`
  （没试）。
- 图层标志 0x100（`ledsource`）也会让图层走 passthrough（p2-REPORT），语料扫描只按 colorBlendMode 判断。
- pass 的 `conditions`（combo 条件）没进模式计算；语料里没遇到问题，但没专门核对。
- 边角：最后一个 effect 的最后一个绘制 pass 本身带 `compose` 时，计数在它之后才到阈值，读码上 final 段找不到 pass、图层不上屏；没实测。

## 产物

- 工程：`ignore/p7d/gen_mvp.py` → `ignore/p7d/proj/p7d-mvp`；抓帧 `A:\p7d\mvp\mvp-frame225.rdc`、`mvp-frame226.rdc`。
- 常量导出：`ignore/p7d/rdc_cbuf.py` + `rdc_cbuf_inner.py` → `ignore/p7d/out/mvp-cbuf.json`；归类 `ignore/p7d/ana_mvp.py` →
  `ignore/p7d/out/mvp-ana.txt`。
- 语料：`ignore/p7d/corpus_mvp.py` → `ignore/p7d/out/corpus-mvp.json`；`list_final.py`、`stats_mvp.py`、`req_usage.py`、
  `assets_scan.py`、`fluid_modes.py`。
