# kabegame-sample 用到而计划没安排的特性

> 对象：用户自建的 WPE 场景 `D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\myprojects\kabegame-sample`（编辑器自带的粒子预设、一个形状对象和 effect 拼成）。
> 对照：[PLAN.md](../PLAN.md)、[phase-4-particles.md](phase-4-particles.md)（P4a–P4f「范围与覆盖」）、[phase-4a-base.md](phase-4a-base.md)、[rea-framework.md](rea-framework.md)、[rea-p4a.md](rea-p4a.md)。
> 日期：2026-11-07。只读调研，没有改产品代码和计划文件。
>
> 证据等级：**读码**是本轮在 `wallpaper64.exe`（SHA-256 前缀 `40e2ce02`，scratchpad 副本）的全量反汇编 `ignore/p4/rea/wp.asm` 和 REA（Ghidra）里读到的代码，标地址；**推**是由读码推出、没有逐行确认或没有实测；**未查**就是没读到。全部结论都没有实测。语料是本机 149 个工程（与 P4a 步骤 2 同一份清单），下文的场景数不含本壁纸，另行注明。

## 总体结论

**按现有计划做完 P4a–P4f，这张壁纸仍然不能渲染。** 还差四类东西：

1. **计划里完全没有的四项：**
   - 形状对象 `shape: "quad"` 加 `lightshafts` effect。PLAN W1 把它误认成「带 effects 的分组节点」。
   - operator `vortex_v2`。
   - operator `maintaindistancetocontrolpoint`。
   - 属性关键帧动画：`涡流球体` 的 `instanceoverride.controlpointangle1`。
2. **计划放错节的一项：** `tex:alpha-priority` 记在 W5，但本壁纸 4 个 RG88 粒子纹理都带这个标志，P4b–P4d 做完仍会被它挡住。读码看它多半对运行时中性。
3. **P4 内部没指定归属的五项：** 粒子世界空间（系统 `flags` bit0）、发射器 `flags` bit1、`static` 子系统（缺省类型）、控制点 `flags` 2 和 16、`REFRACT` 带出的 `NORMALMAP`。它们都在 P4 的大范围里，但「范围与覆盖」表和各节步骤 0 都没写，覆盖数里也没有统计。
4. **能力表误报一项：** `material:alphawriting`。本壁纸写的是 `"default"`，读码确认它不改任何状态，等同于没写。

把这些补进计划后，本壁纸在 P4 结束时可以渲染。

另外一个**能力表漏洞**要尽快补：关键帧值现在被 `resolveValue` 解析成 `undefined`，属性静默退回缺省值，能力表不报。这张壁纸现在被 `object:instanceoverride` 挡住，所以还没有画错；P4a 步骤 5 一旦放开 `instanceoverride`，P4c 接上 `controlpointangle*`，它就会静默画错。语料里另有 32 张场景用了关键帧，好在现在都还有别的不支持项挡着。建议在 P4a 步骤 5 之前（最晚 P4c 之前）先在能力表报 `value:animation`。改法见第 3 节。

顺带一提：这个工程目录里没有预览图。退回时预览、桌面都没有东西可显示，用户自测时会以为加载失败。

---

## 1. 特性总表

状态列：**已实现**、**P4x**（计划在该节，正在做的标注进度）、**不清楚**（P4 范围内，但没有指定节或步骤 0 没写）、**无计划**。P4a 当前进度（本报告写作时）：步骤 1–3 已提交（层级、编译与能力表、模拟器）；步骤 4（绘制）在主会话的工作区里，还没提交；步骤 5（生命周期与 `instanceoverride`）没做。下文引用的行号以写作时的工作区为准，以函数名为准。

### 1.1 场景、对象与 general

| 特性 | 本壁纸的用法 | 当前能力表 | 状态 |
|---|---|---|---|
| 正交 1920×1080、`camera`、`version: 5` | — | 不报 | 已实现 |
| `general`：`bloom false`、`hdr false`、`clearcolor`、`ambientcolor`、`skylightcolor`、`camera*`（开关都关）、`zoom 1`、`fov` / `nearz` / `farz` | 都是中性或已实现的取值 | 不报 | 已实现 |
| 风、重力 5 个键 | 缺省值 | 不报 | 已实现（P4a 实测中性） |
| `perspectiveoverridefov: 90` | 透视粒子（`flags & 4`）的 fov | 解析 | P4a 步骤 4 |
| 粒子对象 16 个 | 都只有 `origin`，`烟花 2` 另有 `angles` z −0.121 | `particle:pending` | P4a 步骤 4 |
| 对象键 `solid: true`、`disablepropagation: false` | — | 中性 | 已实现 |
| `instanceoverride.controlpoint1`（`电弧`） | `"213.89 240.32 0"` | `object:instanceoverride` | P4c |
| `instanceoverride.controlpointangle1`（`涡流球体`） | **关键帧动画**，见 2.4、第 3 节 | 只报 `object:instanceoverride` | 无计划 |
| 形状对象 `shape: "quad"`（`光束 - 径向`） | 挂 `lightshafts`，`DIRECTDRAW 1`、`RAYMODE 1`、`RENDERING 1` | `object:shape` | **无计划**（2.1） |

### 1.2 粒子系统级

24 个系统：16 个顶层，8 个子系统（`烟花 2` 4 个 `eventdeath`，`萤火虫`、`流星` 各 1 个 `eventfollow`，`火花` 1 个 `eventspawn`，`叶子 3` 1 个缺 `type`）。

| 特性 | 用到的系统 | 能力表 | 状态 |
|---|---|---|---|
| `maxcount`（1 – 15000）、`starttime`（0 – 15） | 全部；`magic_vortex_orb` 是 15000，`rate` 5000，还带 `spritetrail` | 支持 | P4a。15000 带拖尾要计入「`maxcount` 上限」实测 |
| `flags` bit2 透视 | `leaves3`、`leaves3b`、`snowperspective` | 支持 | P4a 步骤 4 |
| `flags` bit3（禁 `colorn` / `brightness` 覆盖） | `fireworkshitdistort` | 支持 | P4a |
| `flags` bit0 世界空间 | `fireworks2hit`、`fireworks2stars`、`firefliestrail`、`magic_vortex_orb`、`sparktrails`、`shootingstar`、`water_faucet_large` | `particle:flags:world` | **不清楚**（2.6） |
| `animationmode: randomframe` | `raindownpour` | `particle:animationmode` | P4b |
| `sequencemultiplier` 2 / 3 | `bubbles1`、`leaves3`、`leaves3b`、`smoke2` | `particle:sequencemultiplier` | P4b |
| `controlpoint` | `flags` 1：`bubbles1`、`trail_0`、`fireflies`、`dna`、`magic_vortex_orb`；`flags` 2：`dischargearc`、`water_faucet_large`；`flags` 16：`magic_vortex_orb`；`offset`：`dischargearc` `450 0 0`、`dna` `0 500 0`；`parentcontrolpoint`：`water_faucet_large` | `particle:controlpoint` | P4c；`flags` 2 和 16 的含义**不清楚**（2.8） |
| `children` `eventdeath` / `eventfollow` / `eventspawn` | 见上；条目带 `maxcount`（`萤火虫` 的子系统写 20）、`flags 0`、`id` | `particle:children` | P4e |
| `children` 缺 `type`（即 `static`） | `leaves3 → leaves3b` | `particle:children` | **不清楚**（2.5） |

### 1.3 模块

| 模块 | 次数 | 本壁纸里的非缺省字段 | 状态 |
|---|---|---|---|
| emitter `sphererandom` | 24 | `directions`、`distancemin/max`、`origin`、`rate`、`speedmin/max`、`instantaneous` 0/1/50/100/150、`sign`（`0 1 0`、`0 0 1`）、`cone 0` | P4a |
| ↳ `flags: 2`（每帧至多 1 个） | 1（`water_faucet_large`） | — | **不清楚**（2.7），现报 `particle:emitter:sphererandom:flags` |
| `lifetimerandom`、`sizerandom`、`colorrandom`、`velocityrandom`、`rotationrandom`、`angularvelocityrandom` | 24、24、23、13、7、4 | `exponent` 2 / 10，`rotationrandom.max "0 0 2"` | P4a（模拟器已提交） |
| `movement`、`alphafade`、`oscillatealpha`、`oscillateposition`、`angularmovement` | 21、21、4、2、4 | `drag`、`gravity`；`oscillatealpha` 带 `blendinstart/end`、`phasemax`；`oscillateposition` 带 `mask "1 0.5 0"` | P4a |
| renderer `sprite` | 17 | — | P4a 步骤 4 |
| `alpharandom`、`turbulentvelocityrandom` | 7、4 | `turbulentvelocityrandom` 带 `offset`、`phasemax`、`timescale`、`speedmin/max` | P4b |
| `sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`turbulence`、`vortex` | 9、2、2、1、2、2 | `colorchange` 的值写成 0–1 向量；`turbulence` 带 `mask`；`vortex` 带 `axis`、`flags 1` | P4b |
| `controlpointattract` | 4 | `scale` 为负（排斥），`threshold`，`flags 0` | P4c |
| renderer `spritetrail` | 3 | `length`、`maxlength` | P4c |
| `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints` | 1、2 | `count 2.2`、`axis`；`count`、`flags 15`、`limitbehavior "mirror"` | P4d |
| renderer `rope`、`ropetrail` | 2、2 | `subdivision 0`、`uvscale`、`uvscrolling`、`uvsmoothing`；`length` | P4d |
| **operator `vortex_v2`** | 1（`magic_vortex_orb`） | `controlpoint 1`、`flags 2`、`distanceinner 0`、`distanceouter 1`、`speedinner 0`、`speedouter 2500`、`ringradius 256`、`ringwidth 5`、`ringpulldistance 250` | **无计划**（2.2） |
| **operator `maintaindistancetocontrolpoint`** | 1（`magic_vortex_orb`） | `variablestrength 5` | **无计划**（2.3） |

### 1.4 材质：COMBO、混合、深度

| 特性 | 用到的材质 | 能力表 | 状态 |
|---|---|---|---|
| `genericparticle`，`additive` / `translucent`，`nocull` | 全部 | 支持 | P4a 步骤 4 |
| 材质常量 `ui_editor_properties_overbright`、`refract_amount`、`cutout_*` | 多个 | 是普通材质常量 | 已实现（翻译器） |
| `REFRACT 1` | `bubbles1`、`fireworks_hit_distort`、`water_faucet` | `particle:combo:REFRACT` | P4b |
| `NORMALMAP`（由 `REFRACT` 的法线纹理槽带出） | 同上 3 个 | `particle:combo:NORMALMAP` | **不清楚**（2.11），P4b 只写了 `REFRACT` |
| `REFRACT 0`、`CUTOUT 0` | `magic_vortex_orb`、`water_faucet` | 值为 0，不报 | 已实现 |
| `depthtest: "enabled"` | `magic_vortex_orb` | `depthtest:enabled` | P4f |
| `alphawriting: "default"` | `magic_vortex_orb`、`water_faucet` | `material:alphawriting` | **误报**（2.10） |

### 1.5 纹理

| 特性 | 纹理 | 能力表 | 状态 |
|---|---|---|---|
| RGBA8888（含 `rgba8888n` 法线图）、`clampUVs`、`nomip`，TEXB0001–0004 | `halo*`、`star`、`drop`、`chromaticdot`、`normal_ring_smooth`、`bubble1normal`、`hose_2_normal`、`util/white` | 支持 | 已实现 |
| 帧表（TEXS0003） | `fog1` 64 帧（R8）、`rain1` 4 帧（R8）、`smoke2` 64 帧（RG88）、`bubble1` / `leaves3` / `leaves5` 各 30 帧 | `tex:animation` | P4b |
| R8（格式 9）、RG88（格式 8） | `fog1`、`rain1`；`smoke2`、`beam_1`、`beam_2`、`light_shafts_0`、`hose_2` | `tex:format:9` / `:8` | P4b |
| `alphaPriority`（标志 0x80000） | `beam_1`、`beam_2`、`light_shafts_0`、`hose_2`（都是 RG88） | `tex:alpha-priority` | **放错节**：W5（2.9） |

### 1.6 形状对象上的 effect

| 特性 | 取值 | 状态 |
|---|---|---|
| `effects/lightshafts`（工程里的副本与 assets 逐字节相同） | 单 pass，材质 `blending: normal` | effect 链已实现，但它挂在形状对象上：**无计划**（2.1） |
| COMBO `DIRECTDRAW 1`、`RAYMODE 1`、`RENDERING 1` | 纹理 `util/noise`（RGBA8888）、`gradient/gradient_iridescent`（RGBA8888，`formatcombo`） | 翻译通过，见 2.1 |
| `gizmos`（`EffectPerspectiveUV`） | 编辑器手柄 | 已中性 |

### 1.7 属性动画

| 位置 | 内容 | 状态 |
|---|---|---|
| `objects[涡流球体].instanceoverride.controlpointangle1` | `c0` 常数 2.478，`c2` 常数 0.022，`c1` 从 −0.628 线性到 −6.971（两端切线 `enabled: false`）；`fps 20`、`length 60`、`mode loop`。即控制点 1 绕 y 每 3 秒转约一圈，带动 `vortex_v2` 的轴 | **无计划**，能力表也不报（第 3 节） |

---

## 2. 逐项说明

### 2.1 形状对象 `shape`

**语义（读码）：**
- **分派：** `FUN_14018ff60` 在 `0x140190768`–`0x1401907d4` 判断 `shape` 键。它只看值是不是字符串（JSON 类型 4），不比较是不是 `"quad"`。是字符串就建一个 0x460 字节的对象：基类构造 `FUN_1401e6980`（图像层在 `0x1401fac77` 用同一个），虚表 `0x140491d10`；另设 `obj+0x304 |= 0x2000`、`obj+0x450 = 1.0`（绘制前视锥剔除用的半径）。
- **加载（虚表 +0x40 = `0x14025fac0`）：** `size`（`obj+0x2f0`）设为 `(ctx+0x88, ctx+0x88)`，然后尾跳 `FUN_1401e6f50` 解析 `effects`。`ctx+0x84` / `ctx+0x88` 是 `orthogonalprojection` 的宽和高（写入点 `0x1401875eb`、`0x1401875fb`）。所以形状是**边长等于正交高度的正方形**，本壁纸是 1080×1080；语料里没有一个形状写 `size`。
- **绘制（虚表 +0x50 = `0x14025faf0`）：**
  1. 可见性判断和视锥剔除。
  2. 推入模型矩阵；`obj+0x120 & 0x80` 时调 `FUN_1401e5b60`，和透视粒子是同一个函数。
  3. **只取 `effects` 列表的最后一个**（`0x14025fe92`），对它的每个 pass 调 `FUN_1401ebf60(this, effect, pass, -1, 1)`。
  4. 没有基础纹理，没有合成 RT，直接画到当前目标。
- **effect 被改写的两处：**
  - 虚表 +0xc8 = `0x14025ff50`：在 pass 的 `combos` 里强写 `DIRECTDRAW = 1`，没有 `combos` 就新建。
  - 虚表 +0x108 = `0x140260790`：把 pass 的 `blending`（`pass+0x1f0`）写成 2。按映射表（`0x140157d82`–`0x140157e4a`：normal 0、translucent 1、additive 2、alphatocoverage 3），2 是 **additive**，覆盖材质里写的 `normal`。
- **未查：** 虚表 +0x128 = `0x1402607b0` 输出 `(1, 1)` 和 `(W/2, H/2)`，用途没查。
- **推：**
  - 这些虚函数确实在 effect 建立时被调用。
  - 四边形以 `origin` 为中心，和图像层一样。
  - pass 的 `g_ModelViewProjectionMatrix` 是对象自己的 MVP。`lightshafts.vert` 用它变换 `a_Position`，和普通 effect 的全屏 pass 不同。

**翻译：** `ignore/p4/sample/shape.test.ts` 用现有 `ShaderCompiler` 编了语料里出现的三种组合（radial、corner、linear，都是 `DIRECTDRAW 1`），全部通过，`checkProgramFeatures` 不报任何项。纹理绑定是 `g_Texture0`–`g_Texture3`：`DIRECTDRAW` 下 0 不采样，3 是没开的 `MASK`，都要给占位纹理。

**语料：** 16 张场景、17 个对象（本壁纸另有 1 个）。全部是 `quad`，全部只挂一个 `lightshafts`，全部 `DIRECTDRAW 1`。对象键（含本壁纸）：`castshadow` 7、`visible` 8（7 个绑用户属性）、`angles` 8、`scale` 4、`parallaxDepth` 4、`disablepropagation` 12、`parent` 1、`clampuvs` 1。
- `3821678218` 只差 `object:shape` 和 R8 / RG88：P4b 后只剩形状。
- `3819646765` 在 P4 之后也只剩形状。
- **PLAN W1 的样本 `3656079027`** 里「带 `effects` 的分组节点（`disablepropagation`、`castshadow`、`clampuvs`）」就是这个形状对象，键完全吻合，语料里也没有别的这种对象。W1 写「分组节点已提前到 P4a」，但分组节点的 `effects` WPE 确实不读，形状对象的却要画。P4a 步骤 1 保留了 `object:shape`，所以没有静默漏画，只是 W1 缺这一项。

**建议：** 形状对象作为一种图层，放进 W1，同时更正 W1 的描述。如果想让 `3821678218` 早点解锁，可以排在 P4b 之后单独做，工作量不大：
- 正方形 H×H 的四边形；
- 只画最后一个 effect 的 pass；
- 强制 `DIRECTDRAW = 1` 和 additive；
- 占位纹理。

**实现前要查：**
- 虚表 +0x128 和 `FUN_1401ebf60(…, -1, 1)` 里 uniform 的取值（MVP、`g_Texture0Resolution`）。
- 有多个 effect 或最后一个不可见时画哪个：`visible: false` 的 effect 是先过滤，还是照样算「最后一个」。
- `alpha`、`color`、`brightness`、`parallaxDepth`、`castshadow`、`clampuvs` 对形状有没有作用。
- 用 `wpe-renderdoc` 抓本壁纸，核对四角位置、混合状态，以及 `DIRECTDRAW` 下 `ApplyBlending(BLENDMODE 31, 0, …)` 的输出。

### 2.2 operator `vortex_v2`

**语义（读码，公式读到结构，系数没逐项核对）：**
- **解析：** `FUN_1401c5490` 的分段 `0x1401cde39`–`0x1401ce3eb`，记录 0x110 字节，blend 变体类型 0x25（`FUN_1401c2a40`）。字段如下：
  - `axis`：字符串，归一化；长度 < 0.001 时取缺省。
  - `flags`、`distanceinner`、`distanceouter`、`speedinner`、`speedouter`。
  - `centerforce`：只在 `flags & 2` 时读，否则为 0。
  - `controlpoint`：上限 7。
  - `ringradius`、`ringwidth`、`ringpulldistance`、`ringpullforce`。
  - 音频：`FUN_1401c1e20` 解析 `audioprocessing*`，把 `speedinner` / `speedouter` 登记为音频目标（`0x1401ce31f`–`0x1401ce3ab`）。
- **缺省值**（`FUN_1401bf2d0`，正交 / 透视）：

| 字段 | 正交 | 透视 |
|---|---|---|
| `axis` | `0 0 1` | 同左 |
| `distanceinner` | 500 | 1 |
| `distanceouter` | 650 | 2 |
| `speedinner` | 2500 | 1 |
| `speedouter` | 0 | 0 |
| `centerforce` | 1 | 1 |
| `controlpoint`、`flags` | 0 | 0 |
| `ringradius` | 300 | 1 |
| `ringwidth` | 50 | 0.2 |
| `ringpulldistance` | 50 | 0.25 |
| `ringpullforce` | 10 | 0.05 |

- **`flags`：**
  - bit0：轴向分量的掩码（记录 +0x40 取常量或 0）。【推】置位时去掉沿轴分量，按到轴的距离算（柱形）；否则按到控制点的距离。
  - bit1：启用 `centerforce`。
  - bit2：环形模式，执行时分支在 `0x14024356f`。
- **执行：** operator 跳转表下标 15 → `0x1402433ea`，blend 版下标 0x24 → `0x140243a17`。非环形分支（`0x1402437f8`–`0x140243a12`）：
  1. `r = d − (d·a)·a`，`d` 是粒子到控制点的向量，`a` 是经控制点旋转后的轴。
  2. `t = saturate((|r| − inner)·rcp(outer − inner))`，`speed = speedinner + t·(speedouter − speedinner)`。
  3. 速度加 `(a × r̂)·speed`。
  4. 有 `centerforce` 时，按「走一步后的径向长度回到原半径」修正速度，系数 `centerforce / h`。
  - 切向项是否乘 dt、入口 `xmm8` 那个缩放因子（音频还是实例 `speed`），**未确认**。
- **本壁纸：** `flags 2`，即只开 `centerforce`（缺省 1），不走环形分支，所以 `ringradius`、`ringwidth`、`ringpulldistance` 三个值不生效（读码）。`controlpoint 1` 的方向由 1.7 的关键帧动画驱动。

**语料：** 0 张，只有本壁纸用。

**建议：** 放进 P4d，和控制点距离类一起，它依赖 P4c 的控制点；音频部分放 P4e。在总计划里注明「语料 0 张，只为 kabegame-sample」。

**实现前要查：** 环形分支（`0x140243575`–`0x1402437f3`）；`xmm8`、`[rbp+0xf0]` 的来源；两遍模式下的行为。做一个确定性工程和 WPE 逐帧比。

### 2.3 operator `maintaindistancetocontrolpoint`

**语义（读码）：**
- **解析：** `0x1401ccdc5`–`0x1401ccf6b`，记录 0x60 字节，blend 变体类型 0x21。字段和缺省（`FUN_1401be2a0`）：

| 字段 | 缺省 |
|---|---|
| `controlpoint` | 0（上限 7） |
| `distance` | 正交 200 / 透视 1 |
| `variablestrength` | 0 |

- **执行：** 跳转表下标 10 → `0x14024197a`，blend 版下标 0x20 → `0x140241ccf`。每个粒子：
  1. `p = x + Δcp`，`Δcp` 是控制点平移的本帧变化量。用的是 `FUN_14005f0a0(当前, 上一帧)`，减法方向是【推】。
  2. `d = p − cp`，`L = |M·d|`。`M` 是由控制点矩阵算出的 3×3，来源**未追**。
  3. `x' = p + (distance / L − 1)·k·d`。`variablestrength == 0` 时 `k = 1`（硬约束，直接拉回球面）；否则 `k = saturate(variablestrength·h)`（`FUN_1401d8df0` 是 clamp 0–1，`h` 是 `[rbp+0x2008]`，和 `movement` 的 `h` 同一个）。
  - `rsqrtps` 是近似值。
- **本壁纸：** 只写了 `variablestrength 5`，所以控制点 0、半径 200。发射器也是 `distancemin = distancemax = 200`，粒子被软约束在以系统原点为心、半径 200 的球面上。

**语料：** 0 张。

**建议：** 和兄弟模块 `maintaindistancebetweencontrolpoints` 一起放 P4d，注明只为本壁纸。

**实现前要查：** `M` 的来源（对象缩放还是控制点缩放）；`Δcp` 的方向；世界空间系统下的行为。

### 2.4 属性关键帧动画

见第 3 节。本壁纸是全语料里唯一在 `instanceoverride` 上用关键帧的。

### 2.5 `static` 子系统（`children` 缺 `type`）

**语义（读码）：** 子系统条目的缺省值由 `FUN_1401c1430` 写回 JSON：`probability` 1、`maxcount` 10、`type "static"`、`controlpointstartindex` 0、`flags` 0。解析 `0x1401d1354`–`0x1401d13ad`：`eventfollow` = 2、`eventspawn` = 3、`eventdeath` = 4，其余是初值（应为 `static` = 1，初值没核对）。

**本壁纸：** `leaves3 → leaves3b`，只有 `id`。

**语料：** 缺 `type` 和显式 `static` 合计 21 张，是最常见的子系统用法。另外子系统条目里的 `flags`、`scale`、`origin`、`angles`（约 10、10、9、6 张）也都没写进 P4e 的步骤 0。

**建议：** P4e「范围与覆盖」加上 `static`，步骤 0 加上条目的 `origin`、`angles`、`scale`、`flags`。`static` 子系统和父系统一起模拟、一起画，不靠事件触发，预热时是否跟着父系统一起预热要查（`rea-framework` 记录预热时只关掉了事件子系统的处理）。

### 2.6 粒子世界空间（系统 `flags` bit0）

**语义（读码，rea-p4a C3）：** 控制点乘模型矩阵；绘制时模型矩阵换成 `ctx+0xaf0`，不乘对象矩阵；`movement.flags & 1` 的重力变换也看它。

**本壁纸：** 7 个系统，大多是事件子系统。

**语料：** 25 张。

**现状：** 能力表报 `particle:flags:world`，但没有一节认领。

**建议：** 放 P4c（和控制点一起查坐标空间），步骤 0 要实测对象平移、旋转之后已发射粒子是否留在原地。P4e 的事件子系统依赖它。

### 2.7 发射器 `flags` bit1 / bit2

**语义（读码，rea-p4a B）：** bit1 每帧至多发 1 个；bit2 周期发射，配 `min/maxperiodicduration`、`min/maxperiodicdelay`、`maxtoemitperperiod`。

**本壁纸：** `water_faucet_large` 的 `flags 2`。

**语料：** bit1 有 20 张，其中包括 P4d 的解锁目标 `2254685070`；bit2 有 2 张。

**建议：** 放 P4b，和 `instantaneous`、`delay`、`duration` 的发射时序一起。

### 2.8 控制点 `flags`

**读码（`FUN_14022e3e0` 控制点更新）：**
- bit0：`0x14022e472` 读 `ctx+0x8c` 和 `1 − ctx+0x90`。【推】这是跟随指针。
- bit2：`0x14022e66e` 取父系统的控制点（`[cp+0xc4]`，即 `parentcontrolpoint`）。
- bit3：`0x14022e6b3`，也在同一段里。
- bit1、bit4：这个函数里**没有读到**，含义未查。

**本壁纸：** 1（多处）、2（`dischargearc`、`water_faucet_large`）、16（`magic_vortex_orb` 的控制点 1，被 `vortex_v2` 用）。

**语料：** `flags 1` 44 张，`flags 2` 1 张，`flags 4` 1 张，`flags 16` 0 张。

**建议：** P4c 步骤 0 把 1、2、4、8、16 逐位列清。

### 2.9 `tex:alpha-priority`

**语义：**
- `.tex` 头标志 0x80000，对应 tex-json 的 `alphachannelpriority`。这个字符串不在 `wallpaper64.exe` 里，是纹理编译器的选项。
- `.tex` 加载函数 `FUN_14015e580` 一带找不到 0x80000 或 bit19 的判断（有界搜索）。
- 着色器只按 `TEX<n>FORMAT` 换通道（`common_fragment.h` 的 `ConvertTexture0Format`：RG88 → `rrrg`，R8 → `(1, 1, 1, r)`）。
- 所以【推】运行时不读这个标志，能力表可以放行。

**本壁纸：** 4 个 RG88 纹理。

**语料：** 20 张。

**现状：** PLAN 把 AlphaChannelPriority 记在 W5，R8 / RG88 提前到了 P4b，这一项没跟着提前。

**建议：** 移进 P4b 步骤 0：确认中性后从能力表删掉，否则 P4b–P4d 的粒子仍然被它挡住。

### 2.10 `material:alphawriting`

**语义（读码，可以定论）：**
- 映射在 `0x140157eb0`–`0x140157f40`：`"default"` = 0、`"enabled"` = 1、`"disabled"` = 2，存在 `pass+0x1f1`。
- 绘制时 `0x140157201`：值为 0 什么都不做；1 和 2 才保存设备状态、开或关 alpha 写入，画完再恢复。
- 所以 `"default"` 等同于没写。

**语料：** 写 `"default"` 的 47 张（图层材质 30、粒子材质 27），写 `"enabled"` 的 6 张（都在 effect 材质里）。
- `3304642534` 现在只差这一项：改完能力表就能解锁，要真机核对。
- `3829603837` 在 P4b 后解锁。

**建议：** 能力表对 `"default"` 放行，`enabled` / `disabled` 照报。不依赖粒子，随时可做。

### 2.11 `NORMALMAP`

`genericparticle.frag` 的 `g_Texture1` 注解是 `"combo":"NORMALMAP","require":{"REFRACT":1,"LIGHTING":1},"requireany":true`，有 `REFRACT` 和第二张纹理时自动带出，`REFRACT` 还要 `g_Texture3 = _rt_FullFrameBuffer`。语料 15 张。

**建议：** P4b 写成「`REFRACT`（含 `NORMALMAP` 和 `_rt_FullFrameBuffer` 快照）」。

---

## 3. 关键帧动画：能力表漏洞与实现所需语义

### 3.1 现状

**a. 关键帧值被解析成 `undefined`**（`compile/model.ts:174`）
```ts
export function resolveValue(value, properties) {
  if (value && typeof value === "object") {
    if ("script" in value) return value.value;
    if (!("user" in value) || !value.user) return undefined; // 现状：{animation, value} 走到这里，调用方 numbers(undefined, 缺省) 退回缺省值
    …
```

**b. 递归扫描的空壳**（`compile/features.ts` 的 `scanValue`，约 229 行）
```ts
export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) scanValue(v, unsupported); return; }
  if (!value || typeof value !== "object") return;
  for (const v of Object.values(value)) scanValue(v, unsupported); // 现状：只递归，什么都不报（3b 删掉 value:script 后留下的）
}
```

`checkSceneFeatures` 对整个 `scene` 调 `scanValue`，`checkPassFeatures` 对材质的 `constantshadervalues` 调它，粒子 JSON 和模型 JSON 不扫。主会话步骤 4 新加的 `particleObjectValueUsed` 遇到对象值会报 `particle:object:<键>`，所以粒子对象自己的 `alpha` / `color` / `brightness` 写成关键帧时已经会报；其余路径不会。

### 3.2 语料

`ignore/p4/sample/gaps.json` 的 `keyframes` 段。主会话的 `anim.json` 统计的是 47 张，那里把 puppet 的 `animationlayers[i].animation`（整数 id）也算进去了；去掉之后是 32 张（本壁纸另算）、169 条动画（含本壁纸 1 条）：

| 落点 | 场景数 |
|---|---|
| effect 实例的 `constantshadervalues`（`multiply` 15 张，其余是 `scale`、`Opacity`、`point0–3`、`right`、`top`、`Brightness` 等） | 22 |
| 图层字段（`alpha` 16、`origin` 10、`angles` 4、`scale` 2、`color` 1、`zoom` 1） | 20 |
| `general`（`zoom`、`bloomstrength`） | 2 |
| `instanceoverride` | 0（只有本壁纸） |
| 粒子 JSON、材质 JSON | 0 |

播放方式：
- 自动播放 106 条：`single` 63、`loop` 42、`mirror` 1。
- `startpaused` 63 条，都是 `single`，由脚本 `getAnimation` 控制。
- 66 条的值同时挂了脚本，30 条有 `relative`，15 条用 `options.parent` / `children` 联动。
- 以上条数都含本壁纸那 1 条（自动播放的 `loop`）。
- 关键帧里没有 `step`；`magic: true` 的切线约一半。

有不带脚本的自动播放动画的场景 22 张。这 32 张现在都还有 22 项以上别的不支持项，所以**目前没有一张因此画错**，漏洞是潜在的。

### 3.3 最小改法：在能力表报不支持（只是建议）

**建议的键：** 统一报 `value:animation`。如果想留统计口径，再加一个细分键 `value:animation:<general|object|effect|instanceoverride|material|particle>`。值同时挂了 `user` 或 `script` 也照报：三种绑定在 WPE 里是并存的（见 3.4），谁优先还没查清。

**建议的位置：**

```ts
// bindings.ts 新增
/** `{animation: {c0…, options}, value}`。puppet 的 `animationlayers[i].animation` 是整数 id，不算。 */
export function isKeyframedValue(value: unknown): boolean {
  const animation = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { animation?: unknown }).animation : undefined;
  return !!animation && typeof animation === "object" && !Array.isArray(animation);
}

// features.ts 修改 scanValue
export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) scanValue(v, unsupported); return; }
  if (!value || typeof value !== "object") return;
  if (isKeyframedValue(value)) unsupported.add("value:animation"); // 新增
  for (const v of Object.values(value)) scanValue(v, unsupported);
}
```

**要覆盖的路径：**

| 路径 | 现在扫不扫 | 要做的 |
|---|---|---|
| `general.*` | `scanValue(scene)` 已覆盖 | 无 |
| 图层字段（`origin`、`angles`、`scale`、`alpha`、`color`、`visible`、`brightness`、`zoom`……） | 已覆盖 | 无 |
| effect 实例 `passes[].constantshadervalues`、effect 的 `visible` | 已覆盖 | 无 |
| `instanceoverride.*` | 已覆盖。**必须在 P4a 步骤 5 删掉 `object:instanceoverride` 之前落地** | 无 |
| 材质 JSON 的 `constantshadervalues`（图层、effect、粒子材质） | `checkPassFeatures` 已覆盖 | 无 |
| 粒子 JSON 的系统级键 | 不扫 | `checkParticleFeatures` 顶层循环里报 `particle:binding:system:<键>` 的那一行加 `isKeyframedValue` |
| 粒子模块字段 | 不扫 | `readParticleModule`（`particles/modules.ts:486`）的 `bound` 判断加 `isKeyframedValue`；控制点、子系统条目对整个 system 调一次 `scanValue` |
| 模型 JSON、`effect.json` | 不扫 | `checkModelFeatures`、`checkEffectFeatures` 各补一次 `scanValue`，语料 0 处，防御用 |
| `animationlayers[i]` | 已覆盖 | **不能误报**：`isKeyframedValue` 要求 `animation` 是对象 |

`resolveValue` 可以不动。如果想让 dev 强制渲染更接近画面，可以对没有 `user` / `script` 的关键帧值返回 `value.value`。但不能因为这样就省掉能力表这一步：`value` 是编辑器里的当前值，不是运行时的值。

**验收：** 单测覆盖图层字段、`general`、effect 常量、`instanceoverride`、粒子模块字段五处会报，puppet 的 `animationlayers` 不报；语料重扫，新增的 `value:animation` 正好落在这 32 张加本壁纸上，干净场景不变。

### 3.4 已读到的 WPE 语义（读码）

- **三种绑定并存：** `FUN_1401a4db0` 对一个值依次检查 `user`、`animation`、`script`，各自建一条绑定记录，按这个顺序挂进同一个列表（`FUN_140175880`）。所以三者可以同时存在，每帧谁最后写、谁生效，**未查**。
- **丢弃条件：**
  - `options` 必须是对象，`fps` 和 `length` 必须是数值，`fps > 0` 且 `length / fps > 0`，否则这条动画整条丢掉，属性保持静态（`FUN_1401a96b0`，`FUN_1401a8c10` 的 `0x1401a8c21`–`0x1401a8c4c`）。
  - 存下的是 `1/fps`、当前时间、时长 `length/fps`、标志、`length`（帧）。
- **`options` 标志**（`FUN_1401a8c10`）：
  - `mode`：`"mirror"` → 1，`"single"` → 2，其它（包括 `"loop"`、缺键）→ 0。
  - `random` → 4，语料没有。
  - `startpaused` → 0x20000000，即暂停。
  - `wraploop` → 0x10，加载时对每个通道调 `FUN_1401a98b0` 预处理。
  - `name`、`options.parent.key`（联动）、`events`（数组，`FUN_1401a9410`）也读。
- **通道：**
  - `c0`–`c3` 必须连续，有 `c0` 才看 `c1`，以此类推。
  - 每个关键帧 0x1c 字节：`{frame, value, flags, backX, backY, frontX, frontY}`（`0x1401a9127`–`0x1401a914c`）。`flags`：1 是 `back.enabled`，2 是 `front.enabled`，4 是 `step`（这时不读切线）。
  - `frame` 不严格递增的关键帧直接跳过（`0x1401a8fc1`）。
  - **`magic`、`lockangle`、`locklength` 运行时不读**：二进制里连这三个字符串都没有，是编辑器用的。运行时只用存下来的 `x`、`y`。
- **`relative`：** 只在 `value` 是字符串时处理。加载时把 `value` 的第 i 个分量加到 `c_i` 每个关键帧的 `value` 上（`FUN_1401a89a0` 的 `addss`，`0x1401a8a8a`），然后删掉 `relative` 键。等于加载期换算成绝对值。
- **脚本 API**（W5 的 `getAnimation` 返回的对象）：
  - `play`（`0x1401707f0`）：清 0x60000000；如果在 0x40000000 状态，时间归零。
  - `pause`（`0x140170820`）：置 0x20000000。
  - `stop`（`0x140170830`）：暂停并清 0x40000000，时间归零。
  - `isPlaying`（`0x140170860`）：`(flags & 0x60000000) == 0`。

### 3.5 实现前要查清

- **求值函数：** 本轮**没定位到**。要查时间怎么推进：`+= dt`？是否乘场景 `rate` 和暂停淡变？用 `g_Time` 还是独立时钟？
- **帧号与插值：** 帧号是不是 `time·fps`；切线 `x`、`y` 的单位（帧、值）；有切线时是不是三次贝塞尔、按 x 反解；两端切线都关时是线性还是 Hermite；只开一端时怎么算。
- **`length` 与关键帧：** `length` 和最后一个关键帧的关系：超出部分保持还是外推；`loop` 回绕时最后一帧和第一帧怎么接；`wraploop` 的预处理做了什么。
- **`mirror` 和 `single`：** `mirror` 的往返周期；`single` 播完是保持末值，还是置 0x40000000 停在那里。
- **`startpaused` 时显示什么：** 第 0 帧的值，还是 `value`。
- **优先级与类型：**
  - `user`、`animation`、`script` 并存时每帧的先后。
  - 用户改属性会不会打断动画。
  - 关键帧值和 `{script}` 的初值关系：脚本的 `value` 参数拿到的是动画值还是原值。
- **联动与事件：** `options.parent` / `children`、`events` 怎么触发脚本，`random` 是什么。
- **通道分量：** `color`、向量、布尔（`visible`）各自怎么映射到 `c0`–`c3`。

**查法：**
- REA：从 `getAnimation` 返回对象的虚表、关键帧数组 `+0x20`、时间 `+0x3c` 的读者往回找求值函数。候选是 `0x1401a98b0` 一带和 `FUN_1401a9410` 的调用者。
- 确定性工程：图层 `origin` 用已知切线做 `loop`、`mirror`、`single`、`step`、`relative`、`startpaused` 各一条，用 `wpe-renderdoc` 逐帧读四角，和模型比。

**放在哪里：**
- 能力表的修改归 P4a 步骤 5，最晚 P4c 之前。
- 实现本身建议新开一节，例如「P3d / K — 属性关键帧动画」：放在 P4 之后、W 系列之前，复用 3a 的绑定目标（图层字段、材质常量、`general` 字段）、3c 的 effect 可见性，以及 P4 的 `instanceoverride` 目标。
- `getAnimation` 和 `startpaused` 那 63 条留给 W5。
- 22 张语料场景有不靠脚本的自动播放动画。

---

## 4. 建议的计划改动清单

以下只是建议，计划文件本身没有改。

1. **`phase-4-particles.md`「范围与覆盖」与各节步骤 0：**
   - **P4b：**
     - 加发射器 `flags` bit1（每帧至多 1 个）和 bit2（周期发射）。
     - 加系统 `flags` bit1 的步骤 0（它和 `randomframe` 有关，读取点没找到）。
     - `REFRACT` 写明含 `NORMALMAP` 和 `_rt_FullFrameBuffer`。
     - 步骤 0 确认 `tex:alpha-priority` 中性后删掉（从 W5 移过来）。
   - **P4c：** 加系统 `flags` bit0 世界空间；步骤 0 把控制点 `flags` 1、2、4、8、16 逐位查清。
   - **P4d：** 加 `vortex_v2`、`maintaindistancetocontrolpoint`，注明「语料 0 张，只为 kabegame-sample」。
   - **P4e：** 加 `static`（缺省类型）子系统；步骤 0 加条目的 `origin`、`angles`、`scale`、`flags`；`audioprocessing*` 的适用模块加 `vortex_v2`。
   - **「P4 不做」：** 如果不想为 0 张语料做 `vortex_v2` 和 `maintaindistancetocontrolpoint`，就在这里写明，同时说明 kabegame-sample 因此不能作为 P4 的整场验收样本。
2. **能力表的两处修正，可以独立于各节先做：**
   - `value:animation`：见 3.3，必须在 P4a 步骤 5 之前。
   - `alphawriting: "default"` 放行：读码可以定论，可能直接解锁 `3304642534`，要真机核对。
3. **`PLAN.md`：**
   - 样本表和 W1 节的「带 `effects` 的分组节点（`disablepropagation`、`castshadow`、`clampuvs`）」改成「形状对象 `shape: quad` + `lightshafts`（`DIRECTDRAW`，正交高度的正方形，强制 additive）」。
   - W1 加「新增形状图层」；或者在 P4b 之后单列一步，解锁 `3821678218`。
   - W5 的 AlphaChannelPriority 改为「已提前到 P4b，读码看是中性」。
   - 新增属性关键帧动画一节（3.5），W5 的 `getAnimation` 依赖它。
4. **验收样本：** kabegame-sample 可以作为 P4 整体收尾和关键帧、形状两项的综合样本。它没有预览图，退回时什么都不显示，所以自测时要用 dev 探针看 `unsupported`。
5. **顺带发现（不属于本壁纸）：**
   - P4b 的解锁目标 `1838478131` 还带 `particle:controlpoint`（控制点 `flags 1`），按现在的分节要到 P4c 才能解锁。除非 P4b 步骤 0 证明这个控制点没有模块引用、可以算中性。
   - P4d 的 `2254685070` 依赖第 1 条里的发射器 `flags` bit1。

---

## 附：脚本与输出（只读，都在 `ignore/p4/sample/`）

| 文件 | 作用 |
|---|---|
| `features.py` → `features.txt` | 本壁纸逐对象、逐系统、逐模块的全部字段，材质 pass，纹理头的格式、标志、帧表 |
| `gaps.test.ts` → `gaps.json` | 语料扫描（149 个工程加本壁纸）：关键帧的落点、选项和逐条列表（排除 puppet）；形状对象；全部粒子模块（递归子系统）和字段；子系统类型和条目键；系统、发射器、控制点 `flags`；`instanceoverride` 键；粒子深度；各类材质的 `alphawriting` |
| `shapes.test.ts` → `shapes.json` | 语料里全部形状对象的原文（核对 W1） |
| `shape.test.ts` → `shape.json` | 用现有 `ShaderCompiler` 编三种 `lightshafts` 组合，看翻译和能力检查 |
| `rea/strx.py`、`rea/asmr.py`、`rea/jtab.py` | 在 `wp.asm` 上找字符串引用、按地址区间打印汇编（标注字符串和 float）、读跳转表。要在 `ignore/p4/rea/` 目录下运行，复用那里的 `pe.py`、`fn.py` |

运行：Python 用 `python -X utf8 -I`；vitest 用 `node node_modules/vitest/vitest.mjs run --config ignore/p4/sample/vitest.config.ts <文件>`。
