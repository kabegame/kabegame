# P4 — 粒子系统（总计划）

> 上级：[PLAN.md](../PLAN.md)「P4 — 粒子」。前置：P3a、P3b、P3c。
> 范围：覆盖全部 70 张的粒子用法，层级支持提前到 P4a（2026-11-07 用户）。本文件只定目标、分节和验收，各节动工前另写子计划。
> 统计基于 2026-11-07 重扫的本机 117 张场景，已包含 solidlayer 和 LightingV1 的改动。

## 总体设计思路

本机 117 张场景有 70 张带粒子，但只差粒子的只有 4 张。所以 P4 的目标不是跑通一张样本，而是建好粒子运行时：把全部 70 张的粒子用法都覆盖掉，直接解锁这 4 张：`shimmering_particles`、`3062029089`、`1838478131`、`2254685070`。其余 66 张不再被粒子挡住，等文本、声音等后续阶段补齐后解锁。层级是图像层和粒子共用的能力，放在 P4a 最前面。

粒子对象变成一种图层，和图像层共用 `objects` 顺序。编译期把粒子 JSON 解析成纯数据放进 bundle，不碰 GPU。宿主在渲染循环里同步模拟，把存活粒子写成顶点，再按图层顺序绘制。模拟是 TypedArray 的 CPU 实现，放在宿主主线程：脚本和属性写入要在同一帧生效，这与 3b 脚本同步运行的决定一致。

关键决策是**模块表作为唯一事实来源**。emitter、initializer、operator、renderer 每种一项，模拟器和能力表读同一张表，表里没有的模块报 `particle:<类别>:<名字>`。这样能力表不会和实现漂移，语料能逐档统计覆盖，不支持的粒子走现有的退回预览图路径，不会静默画错。

WPE 语义以 REA 和实验为准，LWE 只作线索：它解析了 `starttime` 却没有使用，透视粒子的投影也未经核对。粒子带随机，逐像素对比不成立，所以把随机范围收成 min = max 做确定性工程，和 WPE 逐帧比；真实样本只比统计量。调研不一次做完：P4-0 只做共用的工具和框架问题，每节用步骤 0 查清本节要用的内容。

## 范围与覆盖

| 节 | 新增能力 | 粒子用法被完全覆盖（共 70 张） |
|---|---|---|
| P4a | 层级；`sphererandom`；lifetime / size / velocity / color / rotation / angular velocity 随机；`movement`、`oscillateposition`、`alphafade`、`oscillatealpha`、`angularmovement`；`sprite`；透视粒子；`starttime`；`instanceoverride` | 4 |
| P4b | 帧表、`rg88` / `r8`；`boxrandom` 与发射时序；`alpharandom`、`turbulentvelocityrandom`、`positionoffsetrandom`；`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`turbulence`、`vortex`、`capvelocity`；`REFRACT`（含它带出的 `NORMALMAP`）、`CUTOUT`；发射器 `flags` bit1 / bit2；`tex:alpha-priority` | 22 |
| P4c | `spritetrail`；控制点（含控制点 `flags` 逐位）；`controlpointattract`；`locktopointer`；粒子世界空间（系统 `flags` bit0） | 34 |
| P4d | `rope`、`ropetrail`；`mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`；`remapinitialvalue`、`remapvalue`；`maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint`；`vortex_v2`、`maintaindistancetocontrolpoint` | 47 |
| P4e | `children` 的 `static`（缺省类型）、`eventfollow`、`eventspawn`、`eventdeath`；`audioprocessing*` | 60 |
| P4f | `emitParticles`；脚本写 `instanceoverride`；粒子的深度与剔除 | 70 |

覆盖数按特性名统计，COMBO 只算值非 0 的。2026-11-07 按 kabegame-sample 调研（[sample-gaps.md](sample-gaps.md)）补入的项还没计入覆盖数，各节步骤 0 用能力表重算：世界空间语料 25 张、发射器 `flags` bit1 20 张、`static` 子系统 21 张、`NORMALMAP` 15 张，`vortex_v2`、`maintaindistancetocontrolpoint` 0 张（只为 kabegame-sample）。帧表和纹理格式放进 P4：不做它们，P4c 的 34 张只剩 14 张，其中 18 张用帧表，再有 2 张用 `rg88` 或 `r8`。P4d 排在 P4e 之前，因为绳用得最多：先做 P4d 累计 47 张，先做 P4e 只有 38 张。

**解锁数：** 确定解锁 4 张，能渲染的场景从 10 张到 14 张。如果 P4a 步骤 0 确认风、重力和 `perspectiveoverridefov` 这几个键中性，加上 P4a 的层级和 P4b 的纹理格式，还能多解锁 6 张：`3778549173`、`3811798465`、`3799426930`、`3812822229`、`3820104696`、`3832772446`。

> 2026-11-07 用 P4a 收尾后的代码重扫（152 个工程）：能渲染 14 张，P4a 解锁了 `shimmering_particles`、`3062029089`；`3304642534` 因脚本 API 检查重新被挡。上面 6 张里，`3799426930`、`3812822229`、`3820104696` 在 P4b 解锁；`3778549173`、`3811798465`、`3832772446` 还差控制点、子系统、深度等，估计错了。P4b 实际解锁 6 张，见[子计划](phase-4b-tier2.md)「范围与解锁」。

> 2026-11-09 P4c 收尾重算覆盖数（`ignore/p4/c5/coverage_p4c.py`）：口径同 P4b 收尾，是重扫语料（152 个工程）里带粒子的 95 张中，不报任何 `particle:*` 键的场景数。P4b 收尾 22 张，P4c 收尾 44 张。上表的 4 / 22 / 34 / 47 / 60 / 70 是 2026-11-07 按本机 117 张、带粒子 70 张、按特性名统计的估计，和重算的数不能直接比；P4d 起的目标留到各节步骤 0 用能力表重算。`3832772446` 在 P4c 步骤 5 解锁。

**P4 不做，继续报不支持：**
- 带 `effects` 的粒子对象，本机 0 个。
- 粒子开 `LIGHTING`，本机 0 张。`ENGINE_COMBOS` 已不再拦 `LIGHTING`，粒子材质开了它要自己报不支持。
- 图像层的帧动画，仍属 P6。

## 现状锚点

**a. 粒子只报一个键**（`compile/features.ts:233`）
```ts
export function checkObjectFeatures(object: SceneObject, unsupported: Set<string>): void {
  const kind = ["image", "model", "particle", "sound", "text", "light"].find((key) => active(object[key]));
  if (!kind) unsupported.add("object:empty");
  else if (kind !== "image") unsupported.add(`object:${kind}`); // 现状：粒子的具体用法看不出来
```

**b. 粒子对象是没有 pass 的空图层**（`compile/bundle.ts:667`）
```ts
bundle.layers.push(layer);
if (!object.image) continue; // 现状：粒子的 JSON、材质、纹理、着色器都不进编译
```

**c. 帧表和 `rg88` / `r8` 被直接拒绝**（`compile/tex.ts:202`）
```ts
if (flags & TEX_FLAGS.animated) unsupported.push("tex:animation");
if (format !== 0 && format !== 4) unsupported.push(`tex:format:${format}`);
```

**d. 层级被直接拒绝**（`compile/features.ts:161`）
```ts
const OBJECT_FLAGS = [
  "parent", // 现状：写了 parent 就整张退回；无内容的分组节点另报 object:empty
```

## 与 PLAN.md 的差异

1. **透视粒子：** PLAN 写「三屏正交」，但 `shimmering_particles` 有 3 个系统 `flags & 4`，全语料 251 个粒子对象里有 67 个。
2. **`starttime`：** PLAN 没写。134 个对象大于 0，这张样本是 200 和 50。
3. **绘制方式：** PLAN 写实例化四边形。翻译后的 `a_TexCoordVec4` 同时装角点 UV、旋转和尺寸，所以改成每个粒子 4 个顶点加索引。
4. **验收：** PLAN 写「画面与预览图一致」，粒子随机，做不到。改成确定性工程逐帧对比。
5. **模块归属：** 档 2–4 的模块原本排在 W2、W5、W6、P8，提前到 P4；层级从 W1 提前到 P4a；R8 / RG88 从 W5 提前到 P4b。

## 前置 — 引擎宏修正（已完成）

已按 [hdr-macro-REPORT.md](../hdr-macro-REPORT.md) 第 6 节落地（2026-11-07），P4a 依赖它：
- 删掉翻译器的 `HLSL_GS40_DISABLED`。WPE 不定义它；`shimmering_particles` 的 `particle.vert` 定义后走几何着色器分支，顶点不经过 MVP，翻译能过但画不对。
- `TEX<n>FORMAT` 只按 `formatcombo` 定义。`eagleflag` 和 WPE 比，差值大于 8 的像素从 6.22% 降到 1.66%。
- `HDR` 等引擎宏全局传。关闭时 `HDR` 必须不定义，不能传 0，`common_blending.h` 用的是 `#ifdef`。

## P4-0 — 对比工具与框架问题

子计划：[phase-4-0-tools.md](phase-4-0-tools.md)。不改产品代码，只做各节共用的部分，具体语义留给各节的步骤 0。结论写进 `p4-particles-REPORT.md`，每条标证据来源和置信度，后续步骤 0 接着往里写。

- 确定性工程的生成和逐帧对比工具，能和 WPE 比位置、尺寸、颜色、透明度。
- 只查决定底座形状的问题：模块的执行顺序、每个粒子存哪些字段、时间步进（dt 的来源和上限，暂停、低帧率时的行为）。

**验收：** 用一个最简单的确定性工程跑通和 WPE 的逐帧对比；上述框架问题有结论。

## P4a — 层级、底座与档 1

子计划：[phase-4a-base.md](phase-4a-base.md)，步骤 0 已完成。

底座的要求已由 P4-0 查清，见[报告](p4-particles-REPORT.md)「对 P4a 底座的要求」：定长列加标志、`R` 共用一列、模块按 JSON 顺序、帧内顺序、`fps` 不超过 20 时 operator 跑两遍、帧时钟钳到 `[0.0001, 0.25]`。

**步骤 0：**
- 层级：父链的变换累乘，`alpha`、`visible` 是否继承，无内容分组节点、带 `effects` 的分组、`disablepropagation`、`clampuvs`，以及绘制顺序。
- `starttime` 的语义和步长。
- `flags` 各位，透视投影怎么取相机，`fov` / `nearz` / `farz` 和 `perspectiveoverridefov` 的关系。
- `rate`、`maxcount` 的关系。
- 档 1 模块的公式和字段默认值。
- `instanceoverride` 各字段的作用，以及运行时改值的反应（3c 记录是脏标志，下次更新重算）。
- 粒子的绘制顺序和混合，粒子之间是否排序。
- 风、重力键是否影响粒子。
- 重新加载和属性变化时，粒子状态保留还是重来。

**实现：**
- 层级：父链变换和分组节点。最先做，它改所有图层的世界矩阵，图像层也受益。
- 解析粒子 JSON，建模块表，细分能力表。
- 模拟器框架和档 1 模块，包括透视粒子和 `starttime`。
- 顶点上传、绘制、与图像层混排、接入泛光和双缓冲不清屏。
- `genericparticle` 和项目自定义 `particle` 着色器，`WORLDBLUR`、`USERCOLORBLEND`。
- 粒子路径自己写的宏：`TEX0FORMAT` 无条件写，并进 `ShaderCompiler` 的缓存键。`THICKFORMAT`、`SPRITESHEETBLEND*`、`TRAIL*` 在用到的节再写。
- `instanceoverride` 进绑定表，就地生效。
- 预览、桌面、暂停、切换壁纸的状态与资源释放。

**验收：**
- `shimmering_particles`、`3062029089` 解锁，统计量和 WPE 一致。这两张都不用帧表，纹理都是 RGBA8888。
- 层级的确定性工程和 WPE 逐像素一致。
- 档 1 模块的确定性工程和 WPE 逐帧一致。
- 改 `count`、`glow`、`style` 不重编译。
- 语料的变化只在粒子和层级键上，现有基线逐张相同。
- 记录这两张的帧时间，并给出 `maxcount` 上限的实测结论。

## P4b — 帧表、纹理格式与档 2

子计划：[phase-4b-tier2.md](phase-4b-tier2.md)。P4a 留下的 `instanceoverride.colorn`（挡住 60 张）纳入本节作为步骤 6，DXT1、DXT3 在步骤 1 一起放开（2026-11-08 用户）。

**步骤 0：**
- 帧表：`SPRITESHEET` 与 `THICKFORMAT` 的组合，`animationmode`、`sequencemultiplier`。
- `rg88`、`r8` 的通道语义。
- `instantaneous`、`delay`、`duration` 的发射时序。
- 档 2 模块的公式和字段默认值，`REFRACT`、`CUTOUT`。
- 发射器 `flags` bit1（每帧至多 1 个）、bit2（周期发射，`minperiodic*` / `maxperiodic*` / `maxtoemitperperiod`）。
- 系统 `flags` bit1：`randomframe` 时也会置位，读取点没找到。
- `REFRACT` 带出的 `NORMALMAP` 与 `_rt_FullFrameBuffer`。
- `tex:alpha-priority`（从 W5 移入）：读码看运行时多半不读这个标志，着色器只按 `TEX<n>FORMAT` 换通道（sample-gaps §2.9），确认中性后放行。

**实现：**
- `TEXS` 帧表进粒子路径，`animationmode`、`sequencemultiplier`。图像层的帧动画仍属 P6。
- `rg88`、`r8` 纹理，全局放开，图像层也能用。
- `boxrandom`、发射时序和档 2 模块。
- `REFRACT`（含 `NORMALMAP`）、`CUTOUT`。
- 发射器 `flags` bit1、bit2。

**验收：** ~~`1838478131` 解锁~~（2026-11-07 改：它的控制点 0 写了 `flags 1`，`sphererandom` 的发射位置总要加控制点 0 的平移，不中性，步骤 0 实测确认后移到 P4c；2026-11-08 已确认 `flags 1` 跟随指针）；`3799426930`、`3812822229`、`3829603837`、`2854083091`、`1504316159`、`3820104696` 解锁；语料中粒子用法覆盖达到 22 张；每个模块都有确定性工程，和 WPE 逐帧一致；帧表各模式和 WPE 一致。

**完成情况（2026-11-08）：** 步骤 0–6 都已提交，收尾写进了 `cocs/wpe/WPE_SCENE.md`「粒子（P4b）」、changelog 与回归文档。
- 解锁：验收列的 6 张全部解锁，能渲染的场景 14 → 20。
- 覆盖：粒子用法完全覆盖 22 张，和本表一致。口径换成了重扫的语料：152 个工程里带粒子的 95 张中，不报任何 `particle:*` 键的场景数；P4a 收尾时是 5 张。
- 确定性工程：每个模块和帧表的各模式都和 WPE 逐帧或逐像素比过，见[子计划](phase-4b-tier2.md)「实施记录」。
- 读码被实测推翻或更正的有两处：
  - 预热遍数（P4a）；
  - `0x200000` 的来源是场景 `version`，不是设备档位（P4b 步骤 6，rea-p4b-render 7.4）。
- 留给后面各节的：
  - P4c：`1838478131`；
  - P4e：子系统的 `colorn` 传递，以及模块上的 `audioprocessing*` 字段；
  - P6：图像层帧动画。

## P4c — 档 3

子计划：[phase-4c-controlpoints.md](phase-4c-controlpoints.md)。`sprite` 的 `orientation`、`axis`、`flags`（语料 7 张，目前不归任何一节）纳入本节步骤 5（2026-11-08 用户）。

**步骤 0：**
- `spritetrail` 的几何，`length`、`minlength`、`maxlength`。
- 控制点各字段、坐标空间和父子关系，`locktopointer`。
- `controlpointattract` 的公式。
- 控制点 `flags` 1、2、4、8、16 逐位查清。
- 粒子世界空间（系统 `flags` bit0）：控制点乘模型矩阵、绘制时不乘对象矩阵（rea-p4a C3），发射位置怎么进世界空间。

**实现：**
- `spritetrail`。
- 控制点：`offset`、`flags`、`parentcontrolpoint`、`locktopointer`，以及 `instanceoverride` 的 `controlpoint*`。
- `controlpointattract`。
- 粒子世界空间。

**验收：** `1838478131` 解锁（从 P4b 移来，要控制点 0 跟随指针）；语料中粒子用法覆盖达到 34 张；拖尾和控制点的确定性工程和 WPE 一致；指针跟随在预览和桌面都正常。`1923929928` 还差 `object:perspective`，不算本节验收。

**完成情况（2026-11-09）：** 步骤 0–5 都已提交（步骤 1–5：`0946bb45`、`a1276b37`、`55904dec`、`7cf9bb9b`、`a0a84322`），收尾写进了 `cocs/wpe/WPE_SCENE.md`「粒子（P4c）」、changelog 与回归文档。
- 解锁：`1838478131`（步骤 2）、`3832772446`（步骤 5，还要步骤 1–3），能渲染的场景 20 → 22。
  - `1838478131`：用户在预览和桌面上看过，跟随鼠标没有问题；跟随规则由 `p4c-ptr` 三种窗口的回放核对。
  - `3832772446`：和 WPE 比过画面，粒子以外逐像素一致，粒子的数量、尺寸、分布一致（子计划「P4c 收尾」）。
  - `1923929928` 只差 `object:perspective`。
- 覆盖：粒子用法完全覆盖 44 张（P4b 收尾 22 张），各步之后依次 22、26、31、32、44。口径同 P4b：152 个工程里带粒子的 95 张中，不报任何 `particle:*` 键的场景数（`ignore/p4/c5/coverage_p4c.py`）。本节验收写的 34 张是旧口径的估计，见上「范围与覆盖」的说明。
- 确定性工程：控制点、指针（三种窗口）、`controlpointattract`、世界空间逐粒子回放，拖尾与朝向（含对象带 x / y 旋转的补测）比四角，都和 WPE 一致，见[子计划](phase-4c-controlpoints.md)「实施记录」。`controlpointattract` 的 `a-default` 长程回放超出包络，单步核对已确定公式，用户接受。
- 读码被更正的一处：`controlpointattract` 删除判定的乘加顺序（rea-p4c-sim 4.3 按 Ghidra 写的不对，步骤 3 按汇编改）。实测新得到的两点：
  - WPE 一帧里先模拟粒子、后跑脚本（步骤 4 预研），渲染器的帧顺序跟着改了；
  - P4a、P4b 写死的单位基朝向在对象带 x / y 旋转时不对，WPE 的 `screen` sprite 朝向相机（步骤 5 补测）。
- 一个系统多个 renderer 继续报 `particle:renderers`（语料 0 张，2026-11-09 用户定）。
- 留给后面各节的：
  - P4d：读控制点的映射与距离类模块（`mapsequence*`、`maintaindistance*`、`reducemovementnearcontrolpoint`、`vortex_v2`），rope 两类；
  - P4e：父控制点（控制点 `flags` 4、8 与 `parentcontrolpoint`，只对子系统有意义），`audioprocessing*`；
  - P4f：脚本写控制点；
  - 没有排期：`instanceoverride` 控制点绑属性（`particle:instance:controlpoint:user`，语料 0 处），一个系统多个 renderer。

## P4d — 绳与映射

子计划：[phase-4d-ropes.md](phase-4d-ropes.md)。2026-11-09 按 P4c 收尾后的代码重扫：P4d 做完，粒子用法完全覆盖从 44 张到 57 张（口径同 P4b「完成情况」，本表的 47 张是旧口径）；解锁只有 `2254685070`，它现在只差 `rope`。绳在 WPE 里走几何着色器。步骤 0 已在 2026-11-09 做完（读码两份、确定性工程 6 个、抓帧 11 组），结论见报告「P4d 语义的实测核对」。2026-11-10 用户定了两项（子计划「决定」）：绳由翻译器加几何着色器展开复刻；`remap*` 读码确定的取值全做，`timeofday` 和未知枚举照报。

**步骤 0：**
- 绳的几何：分段、细分、UV 和 `ropetrail` 的长度。
- 映射类和控制点距离类模块的公式。
- `vortex_v2`（`flags` bit1 开 `centerforce`、bit2 环形模式）与 `maintaindistancetocontrolpoint`（先跟随控制点位移，再拉回半径 `distance` 的球面）：sample-gaps §2.2、§2.3 已读到字段、缺省值和公式结构，补实测。

**实现：**
- `rope`、`ropetrail` 和 `genericropeparticle` 着色器。
- `mapsequence*`、`remap*`。
- `maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint`。
- `vortex_v2`、`maintaindistancetocontrolpoint`（语料 0 张，为 kabegame-sample）。

**验收：** `2254685070` 解锁（它依赖 P4b 的发射器 `flags` bit1）；语料中粒子用法覆盖达到 47 张；绳和映射模块的确定性工程和 WPE 一致。

## P4e — 子系统与音频

**步骤 0：**
- `children` 的触发时机、`probability`、`maxcount`、`controlpointstartindex`，子系统和父系统的控制点、绘制顺序。
- `static` 子系统（`children` 条目没写 `type` 时的缺省，语料最常见的用法），以及条目的 `origin`、`angles`、`scale`、`flags`。
- `audioprocessing*` 的频段、模式和指数，以及没有音频数据时的行为。

**实现：**
- `children` 的 `static` 与三种事件子系统。
- `audioprocessing*` 接入宿主现有的音频数据，用在 emitter、`turbulentvelocityrandom`、`turbulence`、`vortex`、`vortex_v2` 上。音频只有 Windows，其它平台和没声明 `supportsaudioprocessing` 时按步骤 0 查到的行为处理。

**验收：** 语料中粒子用法覆盖达到 60 张；三种事件的确定性工程和 WPE 一致；固定音频输入下的响应和 WPE 一致。

## P4f — 脚本与深度

**步骤 0：**
- `emitParticles` 和脚本写 `instanceoverride` 的 API 形态与时机。
- 粒子的深度测试、深度写入和剔除，和场景目标怎么配合。

**实现：**
- `emitParticles`，图层 API 能拿到粒子对象。
- `{script}` 挂在 `instanceoverride` 上，以及脚本写入。
- 粒子的 `depthtest`、`depthwrite`、`cullmode`。场景目标现在没有深度附件，要新建。

**验收：** 语料中粒子用法覆盖达到 70 张；`emitParticles` 和脚本写入的确定性工程和 WPE 一致；深度和剔除的工程和 WPE 逐像素一致；不用深度的场景基线逐张相同。

## 决定

**已定：**
1. 范围覆盖全部 70 张的粒子用法，分 P4a–P4f（2026-11-07 用户）。
2. 模拟在宿主主线程，不用 Worker。
3. 档 4 拆成 P4d、P4e 两节，先绳与映射，后子系统与音频。
4. 帧表和 `rg88` / `r8` 放进 P4（2026-11-07 用户）。
5. 层级支持提前到 P4a（2026-11-07 用户）。
6. P4-0 不把调研做完，各节用步骤 0 查自己要用的内容（2026-11-07 用户）。
7. 重新编译时粒子状态重来，含预热；改 `instanceoverride` 就地更新，不清粒子（P4a 步骤 0）。
8. kabegame-sample 作为 P4 的整场验收样本，`vortex_v2`、`maintaindistancetocontrolpoint` 进 P4d；按 [sample-gaps.md](sample-gaps.md) 补入的其余项归属见范围表（2026-11-07 用户）。它还要形状对象（PLAN W1）和属性关键帧动画（PLAN K），P4 做完后差这两项。
9. 能力表先报 `value:animation`、放行 `alphawriting: "default"`，在 P4a 步骤 5 放开 `instanceoverride` 之前做（2026-11-07 用户）。

**待定：**
1. `maxcount` 的上限和超限处理：看 P4a 实测。最大的 2582765611 是 62.5 万，其次 12.8 万。

## 风险

1. **覆盖数是上限：** 档位只按特性名统计，粒子材质进编译后可能暴露新的不支持项。
2. **主线程预算：** 模拟和脚本共用一帧，大 `maxcount` 场景可能超预算。
3. **加载开销：** `starttime` 若是快进模拟，200 秒的系统会拖慢加载。
4. **P4c–P4f 解锁很少：** P4b 解锁 6 张（2026-11-07 重扫），P4c、P4d 各 1 张，P4e、P4f 不解锁新场景。主要靠确定性工程和 dev 强制渲染验证，大部分效果要等后续阶段才能在真实壁纸上看到。
5. **风、重力的语义只读到代码：** 粒子路径不碰这几个键，读码也没有找到别的消费点，P4a 步骤 2 用实验确认。`perspectiveoverridefov` 已实测，是透视粒子的 `fov`。`3811798465` 等 6 张的解锁取决于这一项。
6. **层级动的是现有路径：** 它改所有图层的世界矩阵，现有能渲染的场景都要过基线。
7. **内置粒子着色器的路径和 WPE 不同：** `genericparticle` 在 WPE 里是 `PointList` 加几何着色器，项目自定义 `particle` 走顶点展开。无旋转时两条路径的最终几何相同（[报告](p4-particles-REPORT.md)）；旋转的情形要在 P4a 对比。
