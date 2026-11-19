# P4h — 粒子 operator `boids`（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)。2026-11-20 用户指出 myprojects 的 `3826719942`（滴水）只差一个不支持项 `particle:operator:boids`，让 P4 接手。233 张语料里没有别的场景用它。
> 步骤 0 只调研；之后每步能单独验收、单独提交。数据放 `ignore/p4/h0/` 起。

## 总体设计思路

`boids` 是 operator 17（rea-framework 的跳转表），按名字是经典的「鸟群」三规则：对齐（朝邻居的平均速度）、聚合（朝邻居的平均位置）、分离（离太近的邻居推开），邻居按 `neighborthreshold` 的距离判定。和我们已有的 operator 相比，它是**第一个粒子之间互相读的 operator**：之前的 operator 只读自己这一颗与控制点，帧内的遍历顺序无所谓；boids 的结果取决于「读的是本帧已经改过的邻居，还是改之前的快照」以及遍历顺序（存活粒子表的顺序），这决定了能不能逐粒子对上 WPE，也决定模拟器要不要多一份临时列。所以步骤 0 的重点是把公式、写回方式与遍历顺序读清楚并用抓帧证实，实现时照 WPE 的那一种做，不按教科书版本。

它是确定性的（不用随机数），所以验收按 P4a 起的惯例逐粒子比：确定性工程关掉发射随机、粒子初速与位置固定，WPE 抓帧轨迹和我们按同一时间线回放逐粒子比，误差包络照近似倒数等已知差异放宽。复杂度方面，语料这一张最多 16 个粒子，暴力 O(n²) 足够；读码若显示 WPE 有空间划分或邻居数上限，照 WPE（上限会改变结果）。

## 范围与解锁

- 场景：`D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\myprojects\3826719942`（滴水，`scene.pkg`），对象「滴水」用 `particles/presets/dripping_water.json`：
  ```json
  { "name": "boids", "id": 14, "flags": 0, "alignmentfactor": 5, "cohesionfactor": 5,
    "separationfactor": 0, "neighborthreshold": 150 }
  ```
  同系统：`maxcount 16`、`flags 1`、`lifetimerandom 0.5–1`、`velocityrandom 0 -200 0`、`movement`（重力 `0 -2000 0`、`drag 0`）、`alphafade`、`sizechange`，两个 `sphererandom` 从控制点 1 / 2 发射（实例覆盖 ±22），renderer `ropetrail`，三个子系统。operator 顺序 `movement, alphafade, sizechange, boids`。对象 `scale 2`、`instanceoverride` 带 `speed 0.42`。
- 扫描：`kbp corpus scan --project <目录> --only 3826719942` 只报 `particle:operator:boids`；做完预计能渲染 +1。

## 现状锚点

**a. 模块表没有 `boids`**（`particles/modules.ts`）：不在表里的 operator 由能力表报 `particle:operator:<名>`；P4d 的测试拿 `boids` 当「表外模块」的例子（`phase-4d-ropes.md` 1249 行），实现后那几个测试要换一个表外名字。

**b. operator 的执行**（`particles/system.ts`）：每帧按 JSON 顺序对每个 operator 遍历存活粒子、就地改列；两遍模式（fps ≤ 20）整组 operator 跑两次。没有「读别的粒子」的 operator。

## 步骤 0 — 调研

不改产品代码。

### 0a — 读码（一个子代理）

写 **`rea-p4h-boids.md`**，格式同 [rea-p4g-color.md](rea-p4g-color.md)，每条标地址和证据等级。要回答：
1. **解析**：字段名、缺省值、类型与钳制（`alignmentfactor` / `cohesionfactor` / `separationfactor` / `neighborthreshold` / `flags`，以及有没有别的键，如最大速度、邻居数上限、分离半径），写进 operator 记录的哪些偏移；`flags` 每一位的含义。
2. **每帧公式**：逐行：邻居怎么找（全遍历 / 网格 / 上限）、距离用平方还是开方、阈值比较是 `<` 还是 `<=`、自己算不算邻居；对齐 / 聚合 / 分离各自的量（平均速度差？平均位置差？按距离加权？归一化？），三项怎么乘系数、乘不乘 `dt`、写到速度还是位置；有没有近似倒数（`rsqrtps` / `rcpps`）。
3. **写回与顺序**：先对全部粒子算完再统一写（快照），还是边算边写（后面的粒子读到前面已改的值）；遍历顺序是不是存活表顺序；两遍模式下各跑一次还是怎样。
4. **空间**：位置 / 速度是模拟空间还是世界空间（本地系统、世界系统、`movement` `flags` bit0 那类差别），控制点、子系统、事件实例里各自独立吗（只在同一系统实例内找邻居？）。
5. **和 `speed` 实例覆盖、`timescale` 的关系**：是否乘系统的速度系数。

### 0b — 确定性工程与实测（Claude）

- **新增** `ignore/p4/defs/p4h0.py`（`kbp gen p4h0`），每组一个系统、粒子位置 / 初速确定（发射收成 min = max、固定时间间隔），无重力或固定重力：
  - 只开 `alignmentfactor`、只开 `cohesionfactor`、只开 `separationfactor`、三项全开；
  - `neighborthreshold` 卡在两粒子距离两侧（判 `<` / `<=`）；
  - `flags` 读码给出的各位；
  - 本地 / 世界空间系统、带 `scale` 的对象、带 `speed` 实例覆盖；
  - fps 20（两遍）与 60（一遍）。
- 抓帧（`wpe-renderdoc` MCP，`kbp rdc track --points`），结论写进报告新节「P4h 语义的实测核对」。
- 滴水场景：WPE 里开一次（只读打开）抓帧，作真实场景的参照。

**验收：** 读码覆盖上面各项，都有地址、公式和证据等级；确定性工程的实测和读码逐条对上（对不上的以实测为准、写明）；步骤 1 以后的划分写进本文件。

### 步骤 0 实施记录（2026-11-20）

**0a 读码。** 一个子代理只读 `ignore/p4/rea/wp.asm`，写成 [rea-p4h-boids.md](rea-p4h-boids.md)，临时文件在 `ignore/p4/h0/rea/`。要点：7 个键（`separationthreshold` / `neighborthreshold` / `maxspeed` 缺省按正交 / 透视切换，`separationfactor 15`、`alignmentfactor 1`、`cohesionfactor 2`、`flags 1` = 限速）；4 槽一组 SIMD、组升序、组级边算边写；存活位取 `life[j + l]` 不随 lane 移位（缺陷）；距离用 `d2·rsqrtps(d2)`、阈值严格 `<`、1/n 用 `rcpps`；系数乘 `k` 不乘 `h`、只改速度；不乘 `speed`；`hw ≥ 200` 时分帧更新（语料用不到）。注意 `ops.c` 的 `case 0x11` 是内层 switch 的标号，不是 boids。

**0b 实测。** 工程 `ignore/p4/defs/p4h0.py`，抓帧 `A:\p4h\`（fps 20 / 60），参考模型 `ignore/p4/h0/model.py`。结论见报告「P4h 语义的实测核对」：读码各条都成立，没有更正。两处实测补充：
1. 存活位缺陷在只有两颗粒子的系统里就触发（同组里未出生的槽位置是 0，被当成邻居），滴水场景必然受影响：**照抄**（「语料依赖的 WPE 缺陷才复现」）。
2. `rcpps` 的近似误差在世界坐标（几百到几千像素）里累积成可见漂移（11 s 漂 23 像素）；`rsqrtps` 影响「正好等于阈值」的判定。是否复刻见下。
- 滴水场景的参照抓帧 `A:\p4h\drip\`（1200×800，3 帧）。
- WPE 日志各会话共用：同时开着别的会话的测试窗口时 `[kbp]` 行会交错，读时间线要按进程号拆开（`model.py` 的 `log_timeline`）。`kbp` 的回放工具有没有这个问题要在步骤 1 查。

## 步骤 1 以后（定稿，2026-11-20）

**决定（用户 2026-11-20）：** `rcpps`（1/n）与 `rsqrtps`（距离、分离权重、限速缩放）**不复刻**，同 P4a 起的惯例，验收按误差包络放宽；存活位缺陷**照抄**。

| 步骤 | 内容 |
|---|---|
| 1 | 模块表加 `boids`；模拟器实现 boids（下面 1a–1d）；P4d 起拿 `boids` 当表外模块的几个测试换名字；回放案例 `h1`（p4h-a / p4h-b 逐粒子比）；最终走查滴水场景 |
| 收尾 | 文档、回归、changelog、覆盖数 |

### 步骤 1 的实现要点（执行子代理在快照 `ignore/p4/h1/ov` 里做）

- **1a 模块表**（`particles/modules.ts`）：operator `boids`，7 个键与缺省（`separationthreshold` 20 / 0.02、`neighborthreshold` 50 / 0.2、`maxspeed` 500 / 1 按正交 / 透视；`separationfactor` 15、`alignmentfactor` 1、`cohesionfactor` 2；`flags` 1，只看 bit0），不钳制；字段取值规则同其它 operator 的 `num` / 整数字段。
- **1b 槽范围**：WPE 的 operator 循环到 `⌈hw/4⌉·4`（rea-p4h 2.3、rea-framework Q5）。boids 读写 `[hw, ⌈hw/4⌉·4)` 里未出生的槽（位置、速度初值 0，会被 boids 写速度、再被 `movement` 积分），所以带 boids 的系统里 operator 的 `count` 要取 `⌈highWater/4⌉·4`（列本来就按 4 对齐分配，`allocatedCount`）。只对带 boids 的系统这样改（别的系统结果不变、回归逐字节相同），或证明全部系统都这样改不改变别的 operator 的结果后统一改——二选一，执行时写明理由。出生时这些槽的位置、速度由发射器与 initializer 重写（核对现有出生路径确实整列重写，不是累加）。
- **1c boids 本体**（`particles/operators.ts` 或新文件 `particles/boids.ts`）：照 rea-p4h-boids.md 2.2–2.6 逐行：
  - `S = floor(hw/200) + 1`、分帧相位与系数乘 `S`（帧计数器初值未知：从 0 起、每个渲染帧加 1，标 `TODO:[WPE_SCENE]`，语料用不到）；
  - 组 `i` 升序、每组对全部组 `j`（含自己）比 16 对，lane `l` 的邻居 `j + ((l − k4) mod 4)`，有效位取 `life[j + l] !== 0`（缺陷照抄），`k4` 0..3 的顺序与累加顺序照读码；
  - `d2 = (dy² + dx²) + dz²`，`d = sqrt(d2)`（不复刻 rsqrtps），`d2 === 0` 时两项都不算；`mS = d2 ≠ 0 && alive && d < sepT`、`mN = alive && d < nbT`；`w = sepT/d − 1`；
  - `Δ = ((sV/nN − v)·A' + (sep/nS)·Sep') + (sP/nN − p)·C'`，`A' = S·A·k` 等；没有邻居时那一项为 0；1/n 用精确除法（不复刻 rcpps）；float32 运算顺序照读码（`f32` 包每一步）；
  - 一组算完立即写速度；`flags & 1` 时限速：`new² > max(old², maxS²)` 才乘 `maxS/sqrt(new²)`；
  - 不改位置；系数乘 `context.k`，不读 `h`；不乘实例 `speed`。
- **1d 能力表**：模块表登记后 `particle:operator:boids` 自然不再报；检查 `features.ts` 有没有别处写死。
- **测试**：新 `particles/p4h1.test.ts`，用 `p4h0` 的工程定义里的数据（手算或按读码写期望）覆盖：存活位缺陷（两颗粒子被原点的未出生槽推开）、组级边算边写（8 颗 vs 全快照）、阈值严格 `<`、重合不算、限速三种情形、缺省值正交 / 透视、两遍模式下系数用 `k`、`hw ≥ 200` 的分帧；`compile/` 一侧的解析与能力键测试。
- **回放案例 `h1`**（Claude 写，`ignore/p4/cases/h1.json`）：p4h-a fps20 / fps60、p4h-b fps60（fps20 那份 `dead` 已全死、按顺序认会错位，不用），`envelope.approx: true`；p4h-a fps60 的日志混进了别的会话的行，已按进程号清理（原件 `p4h-a-fps60-1280x720-log.raw.txt`，`ignore/p4/h0/split_log.py`）。
- **走查**：滴水场景 `3826719942` 在 Kabegame 里渲染，和 `A:\p4h\drip\` 的抓帧比（随机发射，不逐粒子比；看粒子数与分布、整帧画面）。

### 步骤 1 实施记录（2026-11-20）

**实现**（执行子代理在 HEAD `af726345` 快照 `ignore/p4/h1/ov` 里做，8 个文件 +721 / −10；合并时 8 个文件 HEAD 未动、工作区干净，直接拷入，合并前的副本在 `ignore/p4/h1/pre-merge/`）：
- 新增 `particles/boids.ts`：照 rea-p4h-boids.md 2.2–2.6 逐行，float32；4 槽一组、组升序、组级写回、存活位缺陷照抄、阈值严格 `<`、`d2 = 0` 两项都不算、限速门 `new² > max(old², maxS²)`、系数 `f32(f32(S·X)·k)`；`rcp` / `rsqrt` 用 `f32.ts` 的精确版（不复刻，回放的近似包络照常扰动它们）；`S = floor(hw/200) + 1` 的分帧照读码，帧计数器从 0 起（`TODO:[WPE_SCENE]`，初值未知、语料用不到）。
- `particles/modules.ts`：operator `boids` 进模块表（7 个键，三个阈值与 `maxspeed` 按正交 / 透视取缺省）；`ParticleRunContext` 加可选的 `highWater`、`frame`。
- `particles/system.ts`：带 boids 的系统 operator 的 `count` 取 `⌈highWater/4⌉·4`（1b 选「只对带 boids 的系统」：其它系统让 `movement` 去积分未出生槽是行为变化，回归要逐字节相同）；出生路径核对过是整列重写（发射器赋值、`velocityrandom` 加在发射器写的值上）。
- 测试：`particles/p4h1.test.ts`（24 条，期望手算或测试里独立的 float64 参考实现）、`compile/p4h1.test.ts`（3 条）；P4d 起拿 `boids` 当表外模块的测试换成 `collisionmodel`。

**验收（Claude）**
- tsc 0；相关 vitest 工作区 32 个文件 814 通过。
- `kbp regress`（HEAD 快照 vs 实现快照 + 语料）：20 个旧案例逐字节相同（e1 / e2 / e5 / f1 / f3 两边同样有原有失败），新案例 `h1` HEAD 失败（报 `particle:operator:boids`）、实现通过；语料 233 张逐场景相同。
- 回放案例 `ignore/p4/cases/h1.json`：p4h-a fps20 / fps60、p4h-b fps60 共 18 组逐粒子比全部通过（world-s2 的 rcpps 漂移 23.4 在包络 35.8 内）。thr-eq 跳过（正好等于阈值看硬件 rsqrtps）；thr-out、speed2 另开 run 放宽 pos：发射器给速度归一化用的 `1/Math.sqrt` 不在 approx 包络里，WPE 的近似让速度差约 2.2e-4、两个 fps 正负相反，和 boids 无关（P4b 起的发射器差异，没动）。
- `kbp mutate`（`ignore/p4/h1/mutate_h1.py`）：10 个变异全部检出、按原字节还原。原清单里「组内逐 lane 立即写」是等价变异（邻居累加在写回前已算完），换成「全快照」；`count-hw`（operator 只跑到高水位）只有单测检出：p4h 工程没有重力，未出生槽不会动，滴水场景有重力时才看得出。
- 走查：滴水场景 `3826719942` 编译 0 个不支持项；解包成 `ignore/p4/proj/3826719942-kbp` 导入、按 fps 20 回放 80 帧在 1200×800 画，和 `A:\p4h\drip\` 的 WPE 帧比水流区域（`ignore/p4/h1/out/drip-crop.png`）：水流从瓶口落到腿上的形状、走向、粗细一致（随机发射，不逐粒子比）。测试行已用 `projects_remove` 移除。

### 收尾（2026-11-20，P4g、P4h 一起）

- 文档：`cocs/wpe/WPE_SCENE.md` 新增「粒子（P4g）」「粒子（P4h）」两节，状态行与计划链接补上；「粒子（P4b）」的 `colorn` 一节指向 P4g；`cocs/README.md` 加两条主题与适用场景。
- 回归：`versions/latest/regression.md`「场景壁纸 P4g、P4h」G1–G6、H1–H6；G6、H5（`myprojects` 6 张的真机观感）待用户勾，H6 是已知差异的说明。
- changelog：用户侧、开发侧各一条。
- 总计划 [phase-4-particles.md](phase-4-particles.md) 加「P4g、P4h — 补遗」与完成情况。
