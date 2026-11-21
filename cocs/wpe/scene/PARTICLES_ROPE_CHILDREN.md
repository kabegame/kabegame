# 场景壁纸：粒子：绳、映射与子系统

> [场景壁纸文档](../WPE_SCENE.md) 的一章：绳与拖尾、映射与距离类模块、子系统与音频（P4d、P4e）。总体形态、各阶段状态与全部章节的索引在总览里。

## 粒子（P4d）

P4d 有两块性质不同的内容，底座的形状仍不变：
- 绳（`rope`、`ropetrail`）是新的**绘制**：WPE 用几何着色器把每段一个点展开成三角形带，我们由翻译器把几何着色器展开进顶点着色器。模拟侧只多两份状态：rope 的出生序表、ropetrail 的位置历史。
- 映射类（`mapsequence*`、`remap*`）与距离类（`maintaindistance*`、`reducemovementnearcontrolpoint`、`vortex_v2`）是普通模块，读 P4c 的控制点。`mapsequence*` 是第一批带运行状态的 initializer；两个 maintaindistance 第一次读控制点的 `previous`，由此带出「不可见的帧也更新控制点」。

依据：
- 步骤 0 的读码：[rea-p4d-rope](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md)（绳的段顶点、rope 表、字段与宏、ropetrail 历史）、[rea-p4d-modules](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md)（映射类、距离类、`vortex_v2`、不可见时的行为）；
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4d 语义的实测核对」；
- 逐步的验收数据与收尾走查：[子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4d-ropes.md)「步骤 1–5 实施记录」「收尾 A 实施记录」。下面每条只点出依据是读码还是实测，数字和例外以子计划为准。

验收照 P4a–P4c：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子（绳逐段）和 RenderDoc 抓帧比，近似倒数按误差包络放宽。
- 绳另比几何：离线把 WPE 的 `vs_in` 喂给我们翻译的着色器（Deno 的 WebGPU），和 WPE 的 `gs_out` 逐顶点比；真机由 dev 探针 `particleCorners` 读回整条带子。
- 回放案例在 `ignore/p4/cases/`（`d1`、`d3`–`d6`，`kbp replay`；ropetrail 是 `ignore/p4/d2/replay.test.ts`）；每步 `kbp regress` 现有案例逐字节相同；变异检查子代理与 Claude 各做一组，全部检出（只靠单测的几条在子计划里逐条写明）。

### 绳的绘制：几何着色器展开

| 项 | 规则 | 依据 |
|---|---|---|
| WPE 的画法 | `POINTLIST` 加 `genericropeparticle.geom`：每段一个点，几何着色器输出 `4 + 2·subdivision` 个顶点的三角形带，中间点走三次贝塞尔。`.vert` 的非 GS 分支和 GS 路径不同（没有细分、不看 `ORIENTATION`、`right * uvs.x * 2.0 - 1.0` 的优先级错误），WPE 恒定义 `GS_ENABLED`，所以只能复刻 GS | 实测：所有绳的绘制都是 `PointList`，`dcl_maxout` 随 `subdivision` 0 / 3 / 4 / 16 / 40 是 4 / 10 / 12 / 36 / 68 |
| 翻译器 | 请求带 `geometry`（`.geom` 原文）时定义 `GS_ENABLED`，把几何段拼进顶点段：每段一个实例，`vertex_index` 是第几个输出顶点，第 `vertex_index` 次 `OUT.Append` 的顶点就是输出；结果带 `geometry.maxVertices`。只支持点输入（`IN[0]`）、单条带；`normalize` 的参数是零向量时整个图元落到裁剪体外。规则与限制见 [wpesl2wgsl README](../../../src-tauri/wpesl2wgsl/README.md)「几何着色器展开」 | 实测：零长段在 WPE 里是 NaN 顶点（D3D 丢掉含 NaN 的三角形），NaN 段和我们落到裁剪体外的段逐段一一对应 |
| 着色器替换 | rope 两类系统的 pass 一律换成 `genericropeparticle`，不论材质写的是什么；混合、深度、纹理、常量照旧取材质。`ShaderCompiler.compile` 的 `geometry` 选项读 `shaders/<名>.geom`，进缓存键 | 读码第 6 节；`2254685070` 的管线状态和 WPE 一致 |
| 宏 | rope：`THICKFORMAT=1`、`TRAILSUBDIVISION`、`ORIENTATION`。ropetrail：`TRAILRENDERER=1`、`TRAILSUBDIVISION`、`ORIENTATION`，`uvscrolling` 时 `TRAILSCROLLALPHA=1`，`fadealpha` / `fadesize` 为真时 `TRAILFADEALPHA` / `TRAILFADESIZE`，不写 `THICKFORMAT`。两者都只在槽 0 是格式 8–11 时写 `TEX0FORMAT`，不写 `SPRITESHEET*`（`compile/bundle.ts`，`isRopeRenderer`） | 读码 3.4 |
| 管线与绘制 | 翻译结果带 `geometry` 时顶点布局按实例步进（`stepMode: "instance"`）、拓扑是三角形带（`PipelineSpec.topology`，进管线键），`pass.draw(maxVertices, 段数)`，段数为 0 不画。顶点缓冲：rope 按 `capacity` 段，ropetrail 按 `capacity × n` 段。属性检查：rope 6 个、ropetrail 5 个（含一个 `vec3`），别的照报 `render:particle-attribute:*` | — |
| 剔除与朝向 | 绳的光栅化是 `NoCull`；`upright` / `fixed` 只让 u 左右对调，不会整条不画。`ORIENTATION ≠ 0` 时用 P4c 的 `g_Orientation*`；`ORIENTATION 0` 的绳不因它们是 NaN 而跳过 | 实测 R6u：Forward 是 (0, 0, 1)，宽度正好 40 |
| `g_RenderVar0` | rope 写 0（rope 分支不读）；ropetrail 每帧写，见下 | 读码第 4 节 |

**验收**：离线展开 rope 34 组 201 帧、ropetrail 22 组，位置差 ≤ 2.3e-4 像素，uv ≤ 9.5e-7，颜色 0；真机四角 rope 17 个系统 ≤ 0.004 像素，ropetrail 11 个系统 ≤ 4.6e-4。翻译器不带 `geometry` 的请求，177 次翻译、708 个输出文件逐字节不变。

### `rope`

实现在 `particles/rope.ts`（`RopeOrder`、`writeRopeSegments`），模块记录在 `particles/modules.ts`。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `subdivision` | 4 | 钳到 `[0, 32]`，即 `TRAILSUBDIVISION`；一段最多 68 个顶点，语料最大 16 |
| `uvscale` | 1 | 存倒数 `K = 1/uvscale`；写 0 时不改，保持 1 |
| `uvscrolling` | false | 为真时不看 `uvsmoothing` |
| `uvsmoothing` | true | |

- **rope 表**（WPE 的 `sys+0x218`）：存槽号，出生时追加，判死后保序删除（同一槽出现多次也删光），表序就是出生序，同帧出生的按 emitter 顺序排。我们的槽位复用第一个空槽，所以另记这张表和累计死亡数；`clear`（预热、复位都经过它）清空两者。实测：稳态下槽位已复用，绳上的位置仍严格单调。
- **段顶点**：段 k 连接表的第 k、k + 1 项，存活数 ≤ 1 时不画：
```
a = idx[k]  b = idx[k+1]  c = idx[k−1]（首段取 a）  d = idx[k+2]（末段取 b）
a_PositionVec4   = (pos[a], size[a])     a_TexCoordVec4   = (pos[b], TL)
a_TexCoordVec4C1 = (pos[c], k + TP0)     a_TexCoordVec4C2 = (pos[d], size[b])
a_TexCoordVec4C3 = rgba[b]               a_Color          = rgba[a]
```
- **`TL` 与 `TP0`**（整条绳共用，逐步 float32）：
```
R = 第一个 rate 非零的发射器的 rate · io.count               // 不看系统 flags 的禁用位
L = 第一个中点非零的 lifetimerandom 的中点 · io.lifetime        // 没有则 0
Rf = (R·L > 存活数) ? min(fps, R) : R;  N = Rf·L
uvscrolling：TL = N − 1，TP0 = 累计死亡数
否则：TL = 存活数，TP0 = 0；N > 0、!(存活数 < N − 1) 且 uvsmoothing 时
      TL = N − 1，TP0 = saturate((L − age[idx[0]]) / (1/Rf)) − 1   // 先求倒数再除
TL *= K
```
  存活数正好是 2 时另按特例：`c = a`、`d = b`、`TL = 2`、`TP = 0`，不乘 `K`，也不看滚动和平滑。
- **`fps`** 是宿主的帧上限（`maxFps`，缺省 60），和两遍模式用的是同一个值，不是 WPE 设置的 `fps`。所以 Kabegame 的帧上限和 WPE 设置不同时，绳在填充期（存活数还没到 `R·L`）的 uv 就和 WPE 不同，满了以后相同。
- **依据**：段内容、表序、缺省值、两粒子特例、`uvscale`、滚动在步骤 0 实测成立；`Rf = min(fps, R)` 由收尾 A 的 `r9-fill`（`rate 100`、寿命 2、`maxcount 64`，一直走「没满」）实测：fps 10 下 `TL` 两边都是 19。
- **回放**：`p4d-rope` 16 个系统、两种 fps，段数逐帧相同；位置 ≤ 4.3e-4（坐标过千的 R11 7.3e-4），`TL` 差 0，`TP` ≤ 5.7e-5。

### `ropetrail`

实现在 `particles/ropetrail.ts`（`TrailHistory`、`writeTrailSegments`、`trailRenderVar0`）。

| 字段 | 缺省 | 钳制 |
|---|---|---|
| `length` | 1 | 至少 0.001 |
| `segments`（n） | 4 | `[2, 32]` |
| `subdivision` | 1 | `[0, 32]` |
| `fadealpha`、`fadesize`、`uvscrolling` | false | |
| `uvscale` | 1 | 0 时不改；和 rope 共用 `K` |

- **历史**：每粒子 n 个位置（新的在前）、已存段数 `C`、`uvscrolling` 计数 `U`（u16 回绕）；计时器每系统一个，间隔 `f32(length / n)`，初值 0，复位与预热都不重置它。
  - 出生（全部 initializer 之后）：历史全写出生位置，`C = 1`、`U = 0`。
  - 预热后：高水位以内的每个槽塌缩到当前位置，`C = 1`、`U = 0`。收尾 A 的 `t7-pre` 实测：抓帧时 `h[1]` 是预热结束时的位置，不是出生点。
  - 采样（每帧模拟之后，`dt'` 已乘 `rate`）：存活数为 0 时计时器停走；否则 `timer −= dt'`，`!(0 < timer)` 时 `timer = 间隔`、**余量丢掉**，全部存活粒子的历史后移一格，`h[0]` 写本帧位置，`C = min(C + 1, n)`，`U + 1`。每帧最多采一次，`dt'` 大于间隔也只采一次。预热不采样。
- **段**：每个存活粒子按槽序恒写 n 段。段 0 是 `p → h[0]`，CP0 是 `p`、CP1 是 `h[1]`；段 1 是 `h[0] → h[1]`，CP0 是 `p`；中间段 `h[k−1] → h[k]`，CP 取 `h[k−2]`、`h[k+1]`；末段的 CP1 取终点自身。w 分量不滚动时是 `C·K` 和 `k`，滚动时是 `k` 和 `k − U`。没填满的段零长，由展开的退化规则整段不画，不另外处理。
- **`g_RenderVar0`**（每帧按当时的计时器写）：`z = 1 − max(timer, 0)/间隔`；`w = n − 0.5`；滚动时 `w = (n − 1)·K`、`x = n − 1`，不滚动时 `x`、`y` 写 0。
- **渐隐**：`fadealpha` / `fadesize` 只在 `uvscrolling` 时起作用（宏照写，着色器只在滚动分支里用）。实测：开渐隐、不滚动的 T3 和不渐隐的展开逐位相同。
- **依据**：采样、余量丢掉、每帧一采、钳制、`RV0` 在步骤 0 实测成立；T7（`starttime 1`）在 WPE 里一直没画，是满容量时发射计时冻结（P4b 已实现），周期约 3.94 s，我们的回放同样没有存活粒子。
- **回放**：`p4d-ropetrail` 12 个系统、两种 fps，每帧段数相同；位置 ≤ 4.4e-4，尺寸、颜色、alpha、两个 w 分量差 0，`RV0` ≤ 2.2e-6。

### `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`

实现在 `particles/mapsequence.ts`。这是第一批有运行状态的 initializer，模块表为此多了三个钩子：`createState`（每个系统实例一份）、`resetState`（系统复位）、`newPeriod`（周期发射进入新周期，在本帧的新粒子出生之前）；字段多了 `instanceIf`（按解析值决定乘不乘 `instanceoverride`）。

- **序号**：状态是 `seq` 与 `step`，先用后加：`seq′ = f32(step + seq)`。
  - `step`：around `1/max(count, 1e-4)`，between `1/max(count − 1, 1e-4)`。
  - `seq′ > 1`：repeat 时 around 取 `fmodf(seq′, 1)`、between 归零；mirror 时反射、`step` 取反。比较都是严格的，所以 around 的第一圈留着 1.0。
- **清零**：
  - 系统复位（对象不可见且有存活粒子）：两者 `seq = 0`，`step` 不动。实测（步骤 3 的 `ma-hide`）：清空之后逐粒子对上。
  - 新周期：只有 between 在 `flags & 0x20` 时清零（实测 `mb-period32`）。
  - around 不解析 `flags`，记录里那个字是解析暂存区的残留值，取决于这次 WPE 运行里之前解析过什么。四次先行解析（含一次干净重启）里 `count` 都不乘 `instanceoverride.count`，照此实现、不报；配周期发射时新周期清不清零只测到一次（收尾 A 的 `around-period`：这次是不清零），能力表照报 `particle:initializer:mapsequencearoundcontrolpoint:periodic`（语料 0 张）。
- **around**：`M`、`C` 是控制点 `current` 的 3×3 与平移，基向量乘 `M`。保留出生点到轴的距离 `L`，`θ = (Δb·seq + b0)·2π`，`θ = 0` 在 +y、往 +x 转；位置覆盖成 `dirA·L + proj·A + C`；`speedmin` / `speedmax`（乘 `instanceoverride.speed`）的 x 切向、y 径向、z 轴向加到速度上；无条件抽 3 个随机数。`axis "0 1 0"` 时基向量是 `(1, 0, 0)`、`(0, 0, −1)`。
- **between**：两个控制点的平移 `S`、`E`；本地系统按系统原点量垂直分量（**不减** `S`），世界系统先减 `S`；`w = 1 − (2·seq − 1)²`（用 `seq`，不是 `t`）。`flags` 1 / 2 / 4 / 8 分别是垂直分量乘 `w`、速度乘 `w`、尺寸按 `sizereductionamount` 缩、加 `arcdirection` 方向的弧；别的位照报 `…:flags`。`count` 只在 `flags & 0x10` 时乘 `instanceoverride.count`，改值时 `step` 重写成正的新值（mirror 走到一半会回到正向）。不抽随机数。
- **控制点个数**：`controlpointstart` / `controlpointend` 也计入，between 不写字段时也有 2 个点。
- **回放**：`p4d-map` 20 个系统按槽序逐粒子比；between 9 组逐位为 0（`f2` 3.7e-4），around 差/限 0.42–0.69（`sphererandom` 的近似倒数）。「复位不清零」「新周期不清零」两个变体分别超限 9.5e4、5.25e5 倍。

### `remapinitialvalue`、`remapvalue`

实现在 `particles/remap.ts`：一条管线「读输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回」，两个模块共用，按种类（init / op）在 18 处取变体，文件头逐条列出。读码确定的取值全做（20 个输入、8 个分量、7 个变换、4 个运算、14 个有效输出）。新字段类型 `vec3splat`：字符串读三个数，数字铺满三分量（`inputrange*` / `outputrange*`）。

最容易弄错的几处（init 对 op）：

| 项 | init（`remapinitialvalue`） | op（`remapvalue`） | 依据 |
|---|---|---|---|
| 输入 `particlesystemtime` | 系统时间 `St`（乘 `rate`） | 场景时间 `T`，和 `runtime` 相同 | 实测 ri-time / rv-time |
| 输入 `lifetimefraction` | 读 frame 列（出生时 0，`randomframe` 时是 `R`） | `rcp(life)·age` | 读码 |
| 归一化 | 三分量各自 `(in − min)/range` | 向量输入 `(in − min)·rcp(range)`；标量输入只用 x 分量的 min 与倒数，夹完再铺满 | 收尾 A 实测 `rv-vec2` / `ri-vec2` |
| `square` / `saw` | `floorf`、`roundf` | 截断、偶舍入 | 实测 rv-square / rv-saw；收尾 A 实测 `ri-square2` / `ri-saw2` |
| 噪声 | `snoise1` / `fbm1`（P4b 的 WPE 噪声），和 `R` 无关 | FastNoise2 二维 Simplex / FBm（`particles/fastnoise2.ts`），种子取每粒子 `R`，y、z 分量再异或 `0x0b3924ad`、`0x493a8e83` | 实测：rv-noise 三分量残差 ≤ 4e-4；FBm 倍频在步骤 4b 的回放里定下 |
| 写 size / opacity / color | 初始值列 | 当前值列（置列标志） | 读码 |
| 输入 `positionbetweentwocontrolpoints` | 读 `outputcontrolpoint0` / `1`（不是 input） | 同左 | 实测 |

- **写控制点**：输出 `controlpoint` 时按 `outputcomponent` 运算后写回 `cp[ocp0].current` 的平移；init 每个新粒子写一次，op 每 4 个槽一组（含死槽）只有槽 `4g` 生效。这个点在建系统时置 `0x10000`（模块表的 `controlPointFlags`），`update` 跳过它、不吃实例覆盖。init 的输入 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint` 先把 `cp[icp0].current` 的平移写成 0（WPE 的 bug，实测 ri-cpbug），照做。
- **控制点个数**：输入或输出是 7、8、16、17、18 号时计 `icp0`、`ocp0`，是 8 号时再计 `icp1`、`ocp1`（`controlPointRefs`）。
- **系统时间 `St`**：每次步进在模拟之前 `St = f32(St + dt′)`；预热期间不累加（收尾 A `st-pre`）；不可见期间也累加（见下「不可见的帧」）。图层时间只在可见时累加。
- **照报**：输入、输出 `timeofday`（写入点没找到），未知的输入 / 输出 / 分量 / 变换 / 运算名；op 的输出 `maxlifetime`（WPE 按 4 个一组写到组尾、把死槽写回非零寿命，存活数下溢后不再发射，复刻不了），init 的照常支持。
- **回放**：`p4d-remap` 26 个系统、`p4d-remap2` 63 个系统（除两个 `timeofday` 与 op 的 `maxlifetime`），两种 fps，差/限 ≤ 0.79。

### 距离类与 `vortex_v2`

实现在 `particles/distance.ts`，四个都是普通 operator，每遍处理 `[0, count)` 的全部槽，逐步 float32、加法顺序照汇编。blend 变体用现成的 `readBlend`。

| 模块 | 要点 | 依据 |
|---|---|---|
| `maintaindistancetocontrolpoint` | 先平移 `Δ = current.t − previous.t`，再拉回 `T = inverse(mat3(current))` 下半径 `distance` 的球面；强度 `variablestrength` 为 0 时是硬约束，否则 `clamp01(vs·h)` | 实测：对象 `scale "2 1 1"` 时落在 400 × 200 的椭圆上 |
| `maintaindistancebetweencontrolpoints` | 两个点的 `current` 与 `previous` 都读；`n` 或 `np` ≤ 2⁻⁴⁶ 时整条跳过（NaN 也跳过） | 读码；实测 mb2-same 是直线 |
| `reducemovementnearcontrolpoint` | 只改速度：`vel *= 1 − clamp01(r·h)`。`distanceouter == distanceinner` 时倒数存 1.0，`reductionouter == reductioninner` 时差存 1.0（两处都是 WPE 的 bug，照做） | 实测 `rm-eq2`：两种 fps 都停在 100/3，按 0 实现会停在 50 |
| `vortex_v2` | 切向 `(r̂ × a)·spd`，`spd` 乘 drag 系数 `k`（不是步长 `h`）；轴的 `(x² + y²) + z² < 0.001` 时取 (0, 0, 1)，否则 `axis·(1/sqrt)` 再乘控制点 `current` 的 3×3；`flags & 2` 时读 `centerforce`（系数 `cf/h`），`flags & 4` 是环形；`n = 0` 或 `\|P′\| = 0` 时照 WPE 写 NaN；音频系数见「粒子（P4e）」 | 实测：换成 `h` 差 2.1–2.7，sample-gaps 写的方向是反的 |

- **两遍模式**：`previous` 只在帧尾更新，两遍都看到同一个 `Δcp`，一帧平移两次。这是 WPE 的行为（实测 md-move 在 fps 10 下两倍速跟随，世界空间粒子会跑到对象前面），按现在的结构自然得到。
- **NaN 的钳制**：`clamp01`（`minss(1, maxss(0, x))`）让 NaN 原样通过，`saturatePs` 让 NaN 得 1，按汇编各用在各自的位置；rea 写的「NaN → 0」不对。
- **回放**：`p4d-dist`、`p4d-dist2` 两种 fps，逐帧比较通过的差/限都 ≤ 0.77。`md-hard`、`md-scale`（绝对差 0.04–0.09 像素）与 fps 10 的 `v2-ring-*` 只报告、另做单步核对（每帧换成 WPE 上一帧的状态步进一帧，全部通过）：WPE 的 `rsqrtps` 误差随输入逐帧变化，在把粒子拉回半径的系统里是随机游走，常量偏置的包络界不住。

### 不可见的帧

对象不可见（自身或父链）时，渲染器调 `ParticleSystem.suspend(inputs, frameDt)`，不步进粒子：
1. **控制点照常更新**：按当帧的 `W` 与跟随点更新，帧尾 `previous ← current`；没有存活粒子时也做。依据：读码 rea-p4c-sim 5.6；实测 `p4d-dist2` 的 `hide-r`，「不更新」的变体超限 1156 倍。没有这一条，重新可见的第一帧 `Δcp` 是整段隐藏期间的位移，maintaindistance 的粒子会被一次拽过去。
2. **有存活粒子时复位**（和 WPE 一样，没有粒子时不做）：emitter 计时、模块状态（`mapsequence*` 的 `seq`）、系统时间与图层时间清零，再 `clear`（rope 表与累计死亡数一起清）。
3. **系统时间照常累加**：复位之后无条件 `St += f32(frameDt)·rate`，图层时间不累加。依据：收尾 A 实测 `st-hide`，「不累加」「先累加再复位」都超限，「复位后累加本帧」差 ≤ 7.6e-6；原实现不累加，收尾 A 改正。
4. **不发射**：实测「不可见期间照常发射」的变体四段粒子数都对不上（WPE 不可见期间不发射，或最后一个不可见帧发出的粒子活不到可见，这组数据分不出）。
5. **可见性按脚本之前的状态**（同 P4c「粒子先于脚本」）：实测「按本帧」的变体四段都更差。

### 已知差异

都按「近似倒数不复刻」接受，或是能力表照报的残留行为：
- **`remapvalue` 输出 `speed` 且区间跨 0**：一遍模式下，`o` 过零的那一帧符号取决于 `rcpps` 和精确倒数的差，个别粒子会和 WPE 反向、之后整段反向运动（精确倒数下 `rv-noise` fps 60 有 6 个粒子·帧）。语料里 3815289650 有一处（`fbmnoise`、区间 −5..7），噪声驱动的粒子统计上看不出区别。
- **`maintaindistance*` 与 `vortex_v2` 的 `centerforce`**：`rsqrtps` 的随机游走与 `|P′|/h` 放大，见上「回放」；单步核对在包络内。
- **rope 的 alpha**：`age·rcpps(1)` 少算的量随年龄线性增长（`2254685070` 对照里 ≤ 2.7e-4）。
- **周期发射在计时余量极小时**：fps 10 的 `around-period` 有一个粒子我们早 11 帧发出（周期计时只剩 2e-4、发射余数 1.0001），没查清，留在子计划「未实测清单」；fps 60 逐帧对上。
- **工具边角**：kabegame-dev MCP 的 `particle_corners` / `render_scene` 不传 `fps`，低 fps 下 rope 的 `Rf` 仍按 60 算；dev `particleTrack` 对 rope 系统按槽序输出，不是表序；暂停时改 `instanceoverride` 的 `count` / `lifetime`，rope 的 `TL` 要到下一次步进才更新。

### 语料与解锁

覆盖的口径同 P4b、P4c：带粒子的场景里不报任何 `particle:*` 键的场景数（`ignore/p4/d7/coverage_p4d.py`，结果 `coverage.txt`）。语料在 P4d 期间从 152 个工程涨到 165 个（别的会话加了 13 张，都带粒子），两种口径都给：

| 口径 | 带粒子 | 粒子用法完全覆盖 | 能渲染 |
|---|---|---|---|
| 152 张（P4c 收尾时的名单） | 95 | 44 → 57；步骤 1–5、收尾 A 之后依次 53、53、57、57、57、57、57 | P4d 解锁 1 张（`2254685070`，步骤 1）；HEAD 共 38 张，其余 15 张来自同期别的阶段（P5a、P6a 等） |
| 165 张（现在的全集，基线是 P4c 收尾的代码 `c345e1cd` 重扫） | 108 | 46 → 61（后加的 13 张里 `3486806915`、`3660962877` 由 P4d 覆盖） | 同上，后加的 13 张都还不能渲染 |

- **P4d 去掉的键**（152 张口径的场景数）：`particle:renderer:rope` 22、`particle:initializer:mapsequencearoundcontrolpoint` 8、`particle:renderer:ropetrail` 8、`particle:operator:remapvalue` 2、`mapsequencebetweencontrolpoints`、`maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint` 各 1；165 张口径另有 `particle:operator:vortex_v2` 1。没有新增的 `particle:*` 键；165 张口径的 `3585875739` 把 `vortex_v2` 换成 `vortex_v2:audioprocessingmode`（两个粒子文件都是 mode 3，属 P4e）。kabegame-sample 各步另扫，步骤 5 之后粒子只剩 `particle:children`（另有 `object:shape`、`value:animation`、`depthtest:enabled`）。
- **新覆盖的 13 张**（152 张口径）：只差 `rope` 的 9 张、只差 `mapsequencearoundcontrolpoint` 的 2 张、两者都要的 2 张。只有 `2254685070` 能渲染；`3811764016` 只差 `object:shape`，其余还差文字对象、`model:*` 等 16–59 项。
- **`2254685070`**（收尾 A，鼠标拖尾，用户在测试窗口里移动鼠标抓帧）：绳逐顶点和 WPE 的 `gs_out` 最大差 1.72e-4 像素；挖掉绳的三角形后整帧最大差 1 个色阶；按反推出的光标时间线回放，段数逐帧相同（20 → 8），位置、`CP0` / `CP1`、`TL` 差 0。
- **还挡得最多的粒子键**（152 / 165 张）：`particle:children` 32 / 36（其中只差它的 22 / 24 张）、模块上的 `audioprocessing*` 字段各 2–8 张（P4e）；`particle:binding:instance:rate` 7 / 8、`colorn` 5、`count`、`size` 各 3（`{script}`，P4f）。
- **基线**：10 张干净场景 × 三档后处理共 30 个画面哈希，步骤 1、2、5、收尾 A 各自量过前后，全部相同；步骤 3、4a、4b 没有单独量，步骤 2 之后（`ignore/p4/d2/out/hash-after.json`）和步骤 5 之前（`ignore/p4/d5/out/hash-before.json`）的 30 个哈希逐个相同。

### dev 探针与对比台的增补

| 探针 | P4d 增补 |
|---|---|
| `particleCorners` | 程序带 `geometry` 时第 `id` 个调用算第 `id / maxVertices` 段的第 `id % maxVertices` 个顶点、按段读输入；结果多一个 `rope`（`maxVertices`，ropetrail 另有 `segments`），`corners` / `pixels` 每项是一段的整条带子（同 WPE `gs_out` 还原成带的顺序），rope 的 `particles` 按 rope 表排；选项多一个 `fps`（缺省 60） |
| `particleTrack` | 没有改：rope 系统仍按槽序输出 |

对比台在 `ignore/p4/`：
- 确定性工程：步骤 0 的 `gen_d.py`（`p4d-rope`、`p4d-ropetrail`、`p4d-map`、`p4d-remap`、`p4d-remap2`、`p4d-dist`），之后改用 `kbp gen`：`defs/p4d5.py`（`p4d-dist2`）、`defs/p4d6.py`（收尾 A 的 `p4d-close`、`p4d-close-rope`），以及 `d3/gen_around.py`（`p4d-around-ic`）。
- 回放案例 `cases/d1.json`、`d3`–`d6`（`kbp replay`，钩子 `*.hook.ts` 处理 fps 10 日志的缺帧、`R` 的注入与近似倒数的拟合）；离线展开 `kbp corners offline`；各步的快照、补丁与变异清单在 `d1/`–`d6/`，覆盖数在 `d7/`。
- WPE 参照：步骤 0 在 `A:\p4b\p4d-*`，步骤 3 之后在 `A:\p4d\`（wpe-renderdoc MCP 的 `capture_sweep` / `capture_wallpaper`），读取用 `kbp rdc track --points`；步骤 0 的旧轨迹（draws 认法）改名为 `*.rdc_rope.json`。

## 粒子（P4e）

P4e 有两块：
- **子系统**把「一个粒子层一个系统」变成一棵树。粒子 JSON 的 `children` 每一项引用另一个粒子 JSON：`static` 和父系统一起建、一起模拟、一起画；三种事件类型（`eventfollow`、`eventspawn`、`eventdeath`）是一个实例池，父粒子出生或死亡时取一个实例，实例本身是一棵完整的子树。绘制从「一层一次」变成「一层每帧现排若干次」。
- **音频**是现有模块上的一个系数：`audioprocessingmode ≠ 0` 时，发射数、`turbulentvelocityrandom` 的相位范围、`turbulence` / `vortex` / `vortex_v2` 的速度乘上一个由这一帧的 16 段归一化频谱算出的值。频谱是场景的一份状态，宿主每帧推进一次，粒子与脚本共用。

依据：
- 步骤 0 的读码：[rea-p4e-children](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4e-children.md)（条目解析、static、实例池、实例矩阵、绘制先序、随机数）、[rea-p4e-audio](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4e-audio.md)（取值函数、采集线程的原始频谱、渲染线程的归一化、开关）；
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4e 语义的实测核对」；
- 逐步的验收数据与收尾走查：[子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4e-children.md)「步骤 1–4 实施记录」「P4e 收尾」。下面每条只点出依据是读码还是实测，数字和例外以子计划为准。

验收照 P4a–P4d：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子和 RenderDoc 抓帧比，近似倒数按误差包络放宽。
- 子系统按绘制认系统（`kbp rdc track --points`，`kbp-meta.json` 按绘制先序给子系统颜色条目），事件实例按出现先后起名；另核对「我们有粒子而 WPE 没画」为无。`probability` 只用 0 / 1 比位置，小数只做统计（随机流不同，见「已知差异」）。
- 音频的工程自带纯音，同一帧从 CLK 层读出 WPE 的 `g_AudioSpectrum16Left/Right`，回放时直接喂给模拟器（不经归一化），比每帧的出生数与速度。
- 回放案例 `ignore/p4/cases/e1`–`e5`（`kbp replay`）；每步 `kbp regress` 现有案例逐字节相同；变异检查每步一组（步骤 1–4 共 48 处，收尾 A 1 处另加一处检不出的对照），全部检出（只靠单测的几条在子计划里逐条写明）。

### 子系统条目与系统树

条目解析在 `compile/particles.ts`（`SceneParticleChild`、`parseParticleChildEntry`），编译在 `compile/bundle.ts` 的 `compileParticleSystem`，顶层与子系统共用一条路径：能力检查 → 解析 → 编材质 → 递归 `children`。所以能力表、模块表、着色器、帧表都不分叉。

| 字段 | 缺省 | 说明 | 依据 |
|---|---|---|---|
| `type` | `static` | 只认小写的 `static` / `eventfollow` / `eventspawn` / `eventdeath`，别的（含大小写不同）整条忽略 | 实测 `st-type` |
| `name` | — | 子系统 JSON 的路径，按编译管线的查找顺序读；不是字符串报 `particle:child:name`，读不到报 `particle:missing:<name>`，解析失败报 `particle:parse:<name>` | 读码 1.1 |
| `origin` / `angles` / `scale` | 0 / 0 / 1 | 局部矩阵 `L = T·Rz·Ry·Rx·S`，角度是弧度；只认字符串，缺的分量补 0（`scale "2"` 得 (2, 0, 0)）；别的类型报 `particle:child:<键>` | 实测 `s-xf`、`st-scale1` |
| `flags` | 0 | bit0：父的存活粒子写进子系统的控制点；bit1：父的周期发射进入新周期时复位这个 static 子系统；别的位没有读者 | 读码 1.3；实测 |
| `controlpointstartindex` | 0 | bit0 时从这一号写起；负数时 WPE 越界写，我们跳过并报 `particle:child:controlpointstartindex`（语料 0） | 读码第 5 节 |
| `probability` / `maxcount` | 1 / 10 | 只有事件类读：建实例的概率与活跃实例上限；static 不读 | 实测 `s-p0`、`s-max` |

- **深度**：到第 10 层停（自引用的文件也一样）。WPE 第 8 层起位置是乱的（像矩阵栈溢出），不复刻，语料最深 2 层。
- **稳定键**：子系统的材质 pass 是 `objects/<i>/particle/children/<n>/…/passes/<k>`，`<n>` 是 JSON `children` 里的下标（跳过的条目也占号）；顶层不变。
- **事件条目的子系统也编进 bundle**，模拟与绘制按需建实例。
- **实例覆盖**：对象的 `instanceoverride` 按子系统**自己的** `flags` bit3–7 传下去，`rate` 也乘子系统的 `timescale`（实测 `p4e-rate`：对象 `rate 0.5` 下 static 子系统与同参数顶层系统逐粒子相同）。子系统的字段不能绑属性，绑了报 `particle:binding:child:<键>`；运行中改实例覆盖递归到 static 子系统与各池的活跃、空闲实例（不重开已结束的发射器）。
- **随机数**：子系统与事件实例共用对象的 `ParticleRandom`。WPE 全场景共用一个 MT19937，我们不复刻它的流。
- **`renderer: []`**：不画，照常递归子系统（语料 8 处，都是只为挂子系统的发射器系统）。

### static 子系统

实现在 `particles/system.ts`（`statics`、`stepStatics`、`writeParentPoints`）。

| 项 | 规则 | 依据 |
|---|---|---|
| 帧内顺序 | 父系统模拟（判死 → 事件死亡处理 → 控制点 → 发射 → 事件出生处理 → operator）→ 按条目顺序步进 static 子系统 → 按条目、按建立先后步进事件实例 | 读码 7.3 |
| 模拟矩阵 | 子系统 `M = 父的模拟 M · L`，本地、世界子系统都一样；`dt′` 用父的 | 读码 3.3；实测 `s-def`、`s-pw` |
| 预热 | 建系统时先建并预热全部 static 子孙（深度优先，各按**自己的** `starttime`，`duration` 把预热算在内），再做本系统；父的预热循环不步进子系统。世界子系统的预热用 `M = L`（不含 `W`） | 实测 `st-warmp`、`st-warmc`、`st-wwarm` |
| 条目 bit0（父粒子写控制点） | 父的存活粒子按槽号写进子系统 `cp[startindex..7]` 的 `current` 平移，跳过 `flags & 0x10005` 的点；`X = 父世界 ? (子世界 ? I : top⁻¹) : (子世界 ? top : I)`，不补偿 `L`；子系统控制点数强制 8 个，被写的点不做缺省更新 | 读码第 5 节；实测 |
| 控制点的父分支 | 子系统控制点 `flags 4` 且 `parentcontrolpoint` 在父的个数之内时读父本帧的 `cp[parentcontrolpoint].current`：本 / 父都本地且非 `flags 8` 时 `inverse(M)·Mprev·pcp`，父世界时 `inverse(M)·pcp`，本世界时 `Mprev·pcp`，否则 `pcp`（`Mprev` 是父的模拟矩阵）；子系统预热时读到的是父的初值 | 读码 rea-p4c-sim 1.8 |
| 条目 bit1 | 父的周期发射进入新周期时递归复位这个 static 子系统（系统时间、发射计时、mapsequence 序号）并重开发射器，不清粒子 | 读码 3.7；实测 |
| 不可见 | 顶层有存活粒子时，复位与清空递归到 static 子孙，顶层与 static 子孙各池的活跃实例**销毁**（不进空闲表），空闲表不动；之后整棵树照常以「不发射」步进。顶层没有存活粒子时不复位，子系统里还活着的粒子照常活完 | 读码 3.6；实测 `s-hide` |

### 事件子系统：实例池

一个事件条目一个池（`ParticleEventPool`：活跃表按建立先后、空闲表后进先出），实例与 static 子系统用同一个构造，多一个对象矩阵 `X`。

- **上限与回收**：活跃数到 `maxcount` 就不再建（满了丢弃，不排队）；实例的发射器都结束、粒子死光、子孙也都不活跃时还回空闲表。池只增不减，同 WPE。
- **建实例**：新建时同 static 子系统的构造，再按自己的 `starttime` 预热（建孙辈、控制点初值）；复用时递归复位计时与 mapsequence 序号、重开发射器、重算 `X`，`starttime > 0` 时只跑自己的预热循环（不重新初始化控制点，不重新应用实例覆盖，static 孙辈不再预热【推】）。本帧建的实例当帧就步进一次完整的 `dt′`。
- **实例预热的时间**：运行中建的实例按自己的 `starttime` 预热时，场景时间 `T` 取这一帧的 `g_Time`（收尾 A 实测 `p4e-close`：「取 0」的变体超限 9514 倍）；图层时间同样取这一帧的值【推】（测试工程不读，语料里带 `starttime` 又读 `T` 的事件子系统有 2 张）。
- **`probability`**：每次建之前抽本对象的随机源 `uA`，`uA ≤ p` 才建。

三种类型只差触发点：

| 类型 | 触发 | `X` 用的位置 | 之后 | 依据 |
|---|---|---|---|---|
| `eventfollow` | 发射之后，条目在外、本帧新粒子在内；条目已满时整条不抽 | 新粒子 operator 之前的位置 | 每帧步进前按父粒子本帧（operator 之后）的位置重算 `X`；父粒子死的那帧停跟随、全部发射器（含 static 子孙）标结束，已有粒子照常活完 | 读码 4.3、4.6；实测 `p4e-follow` |
| `eventspawn` | 同上 | 同上 | 只写一次，不跟父粒子、父粒子死了也不停 | 读码 4.3；实测 `p4e-event` |
| `eventdeath` | 判死之后、控制点之前（和停跟随同一个循环），死粒子升序在外、条目在内 | 死粒子上一帧末的位置（判死只把寿命清零） | 同 eventspawn | 读码 4.2；实测 `p4e-event`、`p4e-event2` |

- **eventdeath 的上限照 WPE**：本帧开头把各 eventdeath 条目的「`maxcount` − 活跃数」加起来得 `cap`，循环里只看 `cap` 是不是**恰好**为 0；建了实例后 `cap − 1`，某条目「活跃数 == `maxcount`」时跳到下一个死粒子。单条目时上限严格成立，多条目时会失守（实测 `ed-max2` 两个条目各 60、59 个实例）。语料 3 张烟花预设一个系统挂 3 个 eventdeath 条目，不复刻时烟花会比 WPE 少。
- **预热**：预热期间不记新粒子、不为事件收集死亡，所以 eventfollow / eventspawn 不建；但父系统带 rope 类 renderer 时判死照样收集死亡（rope 表要用），eventdeath 的循环只看死亡表与 `cap`，于是预热里也会建，这些实例到预热之后的第一个正常帧才步进（实测 `ed-rope` 比 `ed-sprite` 多 1 个实例）。
- **不可见**：子系统以「不发射」步进时，判死与 eventdeath 照常【推】。语料里的 eventdeath 条目都挂在顶层系统上，顶层隐藏时粒子被清空、不判死，碰不到这条。
- **`followSlot`**：三种类型都写建实例的父粒子槽号，留给 `inheritinitialvaluefromevent` / `inheritvaluefromevent`（语料 0 处，没实现，照报未知模块）。

**实例矩阵**（`top` 是父的模拟矩阵，`p` 是父粒子位置）：

| 子 / 父 | `X` | 模拟用的 `M` |
|---|---|---|
| 本地 / 本地 | `T(p)·L` | `top·X` |
| 本地 / 世界 | `top⁻¹·T(p)·L` | `top·X`（= `T(p)·L`） |
| 世界 / 本地 | `top·T(p)·L` | `X` |
| 世界 / 世界 | `T(p)·L` | `X` |

依据：读码 4.5；实测（本地实例的粒子存实例坐标，所以「不乘 `L`」「父世界不乘 `top⁻¹`」只有单测看得出）。

### 绘制：粒子层每帧现排

实现在 `render/graph.ts`（`planParticleLayer` 只按模板树预备管线）、`render/scene.ts`（`particle-tree` op）与 `particles/system.ts` 的 `forEachDrawn` / `drawTransform`。

- **一个粒子层一个 `particle-tree` op**，编码时沿根系统的 `forEachDrawn` 走一遍先序：自己 → static 子系统（条目顺序，各自递归）→ 事件池（条目顺序）→ 活跃实例（建立先后，各自递归）。所以带 static 孙辈的事件实例画成「实例 1 → 它的子孙 → 实例 2 → 它的子孙」。WPE 每实例一次绘制（读码第 6 节；实测绘制数与顺序），我们照做，不合并。
- **模型矩阵**：顶层 `世界 ? I : W`，画完栈顶是 `W`；static `世界 ? I : top·L`，栈顶 `世界 ? L : 模型矩阵`；实例 `世界 ? I : top·X`，栈顶 `世界 ? X : 模型矩阵`。就地刷新（对象变换、视差、相机）时由 `drawTransform` 自底向上现算，和 `forEachDrawn` 是同一串运算、逐位相同。
- **draw 池**：每个模板（按条目下标的路径，实例不计序号）一个池，本帧第 k 次出现取第 k 个，第一次用到才建（顶点缓冲、uniform、bind group），之后常驻到场景销毁。实例的顶点缓冲按存活数分配（最少 64 个粒子、不够翻倍、最多到容量），容量 20000 的事件子系统不会每个实例先占 4 MB；新建或换了实例的 draw 当场写 uniform。
- **存活数为 0 的系统**：不画、不占 draw，照常递归子系统（读码第 6 节）；回放与探针起名也只数有存活粒子的。
- **快照**：本帧先序里第一个需要帧缓冲的系统之前拷一次，每对象至多一次（父子共用「本对象已拷」位，读码第 6 节）。
- **帧时间**（屏外宿主强制渲染 600 帧）：`3811798465` 均值约 4 ms、粒子模拟 0.22 ms；实例最多的 `2974757317`（86 个 eventfollow 条目，129 个实例 draw）粒子模拟 0.76 ms、写顶点 0.13 ms。每实例一次绘制不用合并。烟花预设见「已知差异」。

### 音频：取值函数与作用点

实现在 `particles/audio.ts`（`audioParams`、`audioCoefficient`），作用点在 `particles/emitters.ts` 与 `particles/modules.ts`。

```
v = mode 1：max(L16[s..e])   mode 2：max(R16[s..e])   mode 3：0.5·max(L16[i] + R16[i])   其它：0
f = clamp01(powf(smoothstep(clamp01((v − lo)/(hi − lo))), exponent))   // NaN 当 1，全按 float32
```

| 字段 | 缺省 | 解析 |
|---|---|---|
| `audioprocessingmode` | 0 | 任意整数，非 0 才取值；4 及以上、负数 `v = 0` |
| `audioprocessingbounds` | `"0.8 1.0"` | 只认字符串，第二个数缺省 0；数字 0 得 `(0, 0)`，别的类型报 `…:audioprocessingbounds`。`lo`、`hi` 存 float32（WPE 存 float，`0.8` 附近才和 `subss` 逐位相同） |
| `audioprocessingexponent` | 2 | float32 |
| `audioprocessingfrequencystart` / `end` | 0 / 1 | 按无符号钳到 ≤ 15，`end < start` 时交换 |

作用点（`f` 在前，都只在 `mode ≠ 0` 时取值）：
- **发射器**（`sphererandom`、`boxrandom`）：进门（存活数 < 容量、没结束、`delay ≤ 0`）之后、周期发射之前 `rate = f32(f·rate)`；帧尾判结束仍用原 `rate`；`instantaneous` 不乘。`f = 0` 时余数保留，恢复后接着累积。
- **`turbulentvelocityrandom`**：每个新粒子取一次，乘相位范围 `f·(phasemax − phasemin)`。
- **`turbulence`**：三轴掩码全 0 时整条跳过（连取值也不调）；否则 `f·speedmin`、`f·range`，再乘 `k·mask`。
- **`vortex`**：`f·speedinner`、`f·range` 再乘 `k`；**`vortex_v2`**：`(speedinner·f)·k`、`(Δspeed·f)·k`（乘法顺序不同，照抄）。
- 两遍模式下 operator 每遍各取一次（值相同）；一帧里各系统、各遍读到的是同一份频谱。

**开关**只有 `project.json` 的 `general.supportsaudioprocessing`（JSON `true`）。没声明、平台没有回环采集（Linux；Windows 与 macOS 14.2+ 有）、订阅被拒或还没收到数据时频谱全 0、`f = 0`：带音频的发射器不发、速度项为 0，不报不支持（和 WPE 没声音时的画面相同）。`scene.json` 里的同名键 WPE 不读，改为中性。编译结果的 `SceneBundle.audio` 是「声明了开关，且有系统（含子系统）带 `mode ≠ 0` 的模块」，为真时宿主加载就订阅 `WpeMediaHub`；脚本注册音频缓冲时照旧订阅。

### 音频：场景频谱

**原始频谱**（Rust，`src-tauri/kabegame/src/wpe_media/wpe_spectrum.rs`，照 rea-p4e-audio 3.2）：左右各 64 段线性幅值，每攒够 `ns` 个样本做一次长度 `fftSize` 的复数 FFT（44.1 kHz 为 1920 / 1280，48 kHz 为 2089 / 1392），不加窗、不重叠，按 bin 取最大、乘频率倾斜；数据包带 SILENT 时立即清零、连续 1 s 没有数据包时清零。Hub 同一批样本另算一份自定频谱给网页壁纸（`data`），WPE 原始频谱随同一条消息的 `raw` 只给场景（2026-11-13 用户定的方案 B，见 [WPE 导入文档](../WPE_IMPORT.md)「音频与媒体集成」）。

**归一化**（TS，`audio/spectrum.ts` 的 `SceneSpectrum`，照 rea 3.3）：归渲染器所有，跨重编译保留。每帧在粒子步进之前 `advance(raw, frametime)` 一次：
- 64 段每 8 段一组，16 组各有一个慢慢跟随的峰值：目标 `max(0.333·M, 组最大)`，升 `min(dt, |d|)`、降 `0.5·min(dt, |d|)`，差 ≤ 1e-4 直接到位；`peak[0] ≤ 1e-4` 且 `M ≥ 1e-4` 时 16 个峰值重置为 1（之后同一帧照常降一步，所以起音第一帧读数是 `raw/(1 − 0.5·min(dt, 1 − raw))`，按汇编）。
- 每段除以本组峰值（精确倒数，不复刻 `rcpps`），再一阶低通 `α = min(20·dt, 1)`、每帧限幅 `±min(40·dt, 1)`；`M < 1e-4` 时输出整块 0、低通状态不动。
- `A64 = (L + R)/2`；32 段、16 段由相邻两段取最大逐级得到。
- 暂停与补画帧（`frametime = 0`）不推进，同 WPE 整帧跳过时冻结；Hub 拒绝订阅时 `disable()`，之后保持 0。加载时的预热频谱是 0，重编译时的预热读到当时的值（rea 3.5【推】）。

**读者**：粒子读 `L16` / `R16`（所有系统共用一个只读引用）；脚本 `registerAudioBuffers(n)` 返回的 left / right / average 在 `beforeFrame` 里、只在实时帧从同分辨率的块拷入（`average` 是 `A` 段），暂停时冻结，不再自己从 Hub 原值段内取最大。六个 `g_AudioSpectrum*` uniform 也读这三块（P11a，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「音频频谱 uniform（P11a）」）。

### 已知差异

- **随机流**：事件实例与 `probability` 抽本对象的随机源，不复刻 WPE 全场景共用的 MT19937；`probability` 小数的场景实例数统计上一致、逐个不同。
- **音频的绝对量级**：同一段声音 WPE 两声道的原始值约是我们的 0.52 倍，判断是 WPE 播放这个声音对象时又乘了自己的壁纸音量【推】，不是算法差。归一化按组相对，只经 `M < 1e-4` 的静音门起作用，对粒子与脚本没有影响。
- **「音频录制」属性没做**：缺省就是开，和现在的行为相同（WPE 关掉时频谱立即清零）。
- **网页壁纸的频谱**不是 WPE 给网页壁纸的原值，是我们的自定频谱（方案 B，用户比较后选的观感）。
- **按推断实现、语料没有用到的三条**：复用实例时 static 孙辈不再预热（语料 0 处）、运行中建实例预热用的图层时间、不可见时照常建 eventdeath 实例（语料碰不到，见上）。
- **嵌套第 8 层起**的错位不复刻。
- **烟花预设的开销**：`3560756264` 强制渲染时两个烟花对象各同时 5 个实例、单实例最多 8500 个粒子（WPE 抓帧数量对得上），帧时间均值 43 ms，其中 CPU 写 spritetrail 顶点约 28 ms（每粒子约 1.1 µs）、模拟 5.8 ms。带这套预设的 3 张场景都还有别的不支持项、暂时不会渲染；解锁之前要先降写顶点的开销（如 GPU 上展开拖尾，或只写可见的粒子）。
- **细雨丝变暗**（顺带发现，和 P4e 无关）：`1514925620` 天空区域最亮的雨丝像素 WPE 每帧 80–130 个、我们个位数，粒子数、尺寸、alpha、位置都一致；是 P1 起场景目标按场景分辨率（2400×1332）画再缩，2.1 宽的细线峰值被摊薄。

### 语料与解锁

口径同 P4d：带粒子的场景里不报任何 `particle:*` 键的场景数，基线是 P4e 开工时的扫描（`ignore/p4/d7/corpus.json`，HEAD `c22b66a2`），收尾是 HEAD `1e929b3b` 的扫描（`ignore/p4/e5/corpus.json`）。步骤 0 在快照里让能力表递归检查子系统，子系统没有带出任何新键，所以计划的上限就是准确数，四步都正好到上限：

| 口径 | 带粒子 | 粒子用法完全覆盖 | 能渲染 |
|---|---|---|---|
| 165 张 | 108 | 61 → 93；步骤 1–4 之后依次 72、82、87、93 | 38 → 45：P4e 解锁 `3778592720`（步骤 1）、`3811798465`（步骤 2）、`1514925620`（步骤 3），`1333579536` 与 P5b 一起；其余 3 张（`1923929928`、`3822495444`、`3831518461`）来自同期别的阶段 |
| 152 张 | 95 | 57 → 83；依次 67、75、80、83 | 同上 |

- **P4e 去掉的键**（165 张口径）：`particle:children` 36 张（步骤 1 先换成 `particle:children:eventfollow` 19、`eventspawn` 7、`eventdeath` 3，步骤 2、3 去掉），`mode 0` 的音频字段 7 个键（步骤 1），各模块的 `audioprocessingmode` 与 `audiophile` 的 `general:supportsaudioprocessing` 12 张（步骤 4）。没有新增的 `particle:*` 键，没有场景不再能渲染。
- **音频不解锁场景**：开着音频的 11 张都还差别的。
- **还挡着粒子覆盖的键**（165 张，括号里是只差它的张数）：`particle:binding:instance:rate` 8（2）、`colorn` 5（2）、`count`、`size` 各 3、`speed`、`alpha` 各 2（`alpha` 1）、`lifetime` 1（都是 `{script}`，P4f）；`particle:instance:brightness` 3（3）；`particle:renderers` 1（1，一个系统多个 renderer）。这些 P4f 全部去掉，见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」。
- **真机对照**：
  - `3778592720`（fps 20）：父系统 36–38 个、子系统各 4 个，WPE 36–39、3–4 个，尺寸与 alpha 的范围一致，整帧目视一致。
  - `3811798465`（fps 20）：绘制结构相同（两个萤火虫父系统各自后面紧跟一串实例），两边都是实例数约等于父粒子数减 1–2，每个实例 5–10 个粒子，世界坐标范围相同，整帧目视一致。
  - `1514925620`：原场景闪电平均 5 s 一道、光晕实例只活 0.1 s，抓帧碰不到，所以解包成测试副本、把闪电的 `instanceoverride.count` 调大再抓；按 WPE 的帧时间回放 5 帧，光晕实例「有、有、有、无、有」与 WPE 完全相同，位置、alpha 一致，两个雨系统逐帧粒子数相同。
  - 音频响应的 `3809965824`（删掉视频立绘的测试副本）：系统里循环放同一段测试音乐，不带绑定的 `notes1_audio_responsive` 我们 7–8 个、WPE 6–8 个；停掉音乐后两边带音频的系统都不再发射。

### dev 探针与对比台的增补

| 探针 | P4e 增补 |
|---|---|
| `particleTrack`、`host.particles` | 按 `forEachDrawn` 输出，键 `<名字>/<模板路径>`，同一模板第 k 次出现（k ≥ 2）加 `#k`，只数有存活粒子的 |
| `renderFrame`、`particleCorners` | 选项 `particles.audio` 收逐帧 16 段左右（`{ left, right }`，`null` 沿用全 0），直接写进粒子读的数组、不经归一化 |
| `particleTrack` | 选项 `audio`，同上 |
| `host.audio()` | 多 `spectrum16`（场景频谱归一化后的 16 段，粒子读的就是它）与 `raw`（最近一帧 Hub 的 WPE 原始频谱，左 64 + 右 64） |

对比台在 `ignore/p4/`：
- 确定性工程：`defs/p4e0.py`（`kbp gen p4e0`）出 `p4e-static`、`p4e-static2`、`p4e-rate`、`p4e-follow`、`p4e-follow2`、`p4e-event`、`p4e-event2`、`p4e-audio`、`p4e-audio-off`（步骤 0–1）与收尾 A 的 `p4e-close`；子系统 JSON 写进工程的 `particles/`，`kbp-meta.json` 按绘制先序给子系统颜色条目。`gen.write_project(audio=…)` 让 CLK 读频谱、`project.json` 声明开关。
- 回放案例 `cases/e1.json`–`e5.json`（`kbp replay`）：`e1` static、`e2` eventfollow（含 fps 20 的两遍模式）、`e3` eventspawn / eventdeath、`e4` 音频（轨迹帧带 `audio` 时每帧步进前写进系统共用的数组）、`e5` 运行中建实例的预热时间。各步的快照、补丁与变异清单在 `e0/`–`e5/`。
- WPE 参照在 `A:\p4e\`（wpe-renderdoc MCP 的 `capture_sweep` / `capture_wallpaper`）；`kbp rdc track --points` 读轨迹，同时记下 CLK 读到的 `g_AudioSpectrum*`（WPE 把 `float[n]` 打包成 `float4[n/4]`，从 `members` 展开）；`kbp rdc track` 的 points 认法在连续同系统绘制时另核颜色。步骤 0 的 draws 认法轨迹改名为 `rd-<标签>-draws.json`。
- 真实场景的测试副本用 `kbp content unpack --instrument` 解包到 `ignore/p4/proj/real-<id>-kbp`（不动工坊原件），导入 dev 库对照，看完用 `projects_remove` 移除。
