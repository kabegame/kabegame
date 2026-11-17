# P4g — 粒子颜色 initializer `hsvcolorrandom` 与 `colorlist`（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)。P4b 当时语料 0 张没做（[phase-4b-tier2.md](phase-4b-tier2.md)「本节不做」）；2026-11-18 wpe p6 d/e 的全库扫描（`ignore/p6/e0/corpus-now3.json`，含 myprojects 共 293 张）里 5 张只差 `particle:initializer:hsvcolorrandom`，用户让 P4 接手。
> 步骤 0 只调研；之后每步能单独验收、单独提交。数据放 `ignore/p4/g0/` 起。

## 总体设计思路

两个模块都是出生时的颜色 initializer，和 P4b 的 `colorrandom` 同一类：在模块表里登记字段与解析规则，模拟器出生时算一个颜色**乘**到初值颜色列上（rea-p4b-render 第 7 节：颜色 initializer 都是乘到初值列，init.c case 3 / 4 / 5）。和 `colorrandom` 不同的地方有三处，决定了这一节的形状：

- **系统色与重算**：P4b 已读出，粒子 JSON 解析时按 initializer 顺序算系统色（`hsvcolorrandom` 取色相 / 饱和度 / 明度区间中点的 HSV 转 RGB，`colorlist` 取第一个颜色原值），并给每个颜色模块追加一条颜色绑定记录（0xd、0xe）；`instanceoverride.colorn` 生效时，重算把模块的区间「搬」到 `colorn` 的 HSV 上（0xd 以 `colorn` 色相为中心、饱和度 / 明度区间居中并钳到 [0, 1]；0xe 写 `colorn` 与系统色的 HSV 差，出生时加到每个粒子的 HSV 上）。我们的 `particleColorSystem` 现在只认 `colorrandom`，`colorn` 的重算（`particles/colorn.ts`）只认 0xb、0xc，要各补一种。语料里的 5 张正好是这条路：`colorn` 绑了用户属性（「颜色可调」）。
- **色相分档用的是另一个随机数**：init.c case 4 的色相档位是 `int(rand() / 32767 · (steps + 1))`，像是 C 运行库的全局 `rand()`，不是粒子的随机流 `R`；饱和度与明度才各抽一次 `R`。全进程共用的 `rand()` 序列我们复刻不了，所以分档的那一项按「随机数不复刻」处理（同 P4a 起的约定：确定性工程把随机范围收成 min = max），验收靠「档位取值集合与分布」和「固定档位时逐粒子相同」。步骤 0 要先读清它到底是不是 `rand()`、种子在哪、`steps` 为 0 / 负数 / 缺省时取什么。
- **反向区间**：语料唯一的写法是 `huemin 0.837 > huemax 0.601`、`huesteps 4`、不写饱和度与明度，前面另有一个 `colorrandom`。区间相减得负步长、色相超出 [0, 1) 怎么回绕（`hsv2rgb` 里取模）都要按读码与实测定，不能想当然。

模拟器侧只多两个 initializer 分发项与两种颜色记录，不新建列、不改帧序；能力表去掉这两个键。`colorlist` 语料 0 张，和 `hsvcolorrandom` 一起读、一起实测、一起做（用户 2026-11-18 同意顺手做）。

## 范围与解锁

- 语料（293 张口径）：只差 `particle:initializer:hsvcolorrandom` 的 5 张（`3841315879`、`3841322784`、`3841330265`、`3841337134`、`3841390912`，都在 WPE 的 `projects/myprojects/` 下），用的是同一份粒子 JSON（「followed by mice」，`particles/workshop/3686787181/new_particle_system_copy2.json`）：
  ```json
  {"huemax": 0.60130719, "huemin": 0.83660131, "huesteps": 4, "id": 13, "name": "hsvcolorrandom"}
  ```
  initializer 顺序 `lifetimerandom, sizerandom, velocityrandom, colorrandom, velocityrandom, hsvcolorrandom`，系统 `flags 16`，对象 `instanceoverride.colorn` 绑用户属性 `micecolor`（缺省 `0.50196 0 0.50196`）。扫描脚本 `ignore/p4/g0/scan_usage.py`。
- 做完预计解锁这 5 张（能渲染 +5），粒子用法覆盖相应增加；`colorlist` 0 张。

## 现状锚点

**a. 系统色只认 `colorrandom`**（`compile/particles.ts` 的 `particleColorSystem`）
```ts
if (name === "colorrandom") { /* 中点 · 1/255 */ hasColor = true; }
else if (name === "hsvcolorrandom" || name === "colorlist") hasColor = true; // 现状：只置 hascolor，系统色不跟着算
```

**b. 模块表里没有这两个 initializer**（`particles/modules.ts`）：不在表里的模块由能力表报 `particle:initializer:<名>`；`colorrandom` 是 `{ min, max（÷255）, exponent }`，`run: colorRandom` 乘到 `color0`。

**c. 读码已有的部分**（rea-p4b-render.md 7.1–7.4、`ignore/p4/rea/init.c` case 4 / 5）：系统色公式、绑定记录 0xd / 0xe 的类型与重算写法；出生公式的反编译（case 4：`rand()` 定档 + 两次 `R`；case 5：`FUN_14024f410` 挑颜色、三次 `R`、`FUN_14041a5c0`），没有逐字段核对记录布局与字段名、缺省值。

## 步骤 0 — 调研

不改产品代码。

### 0a — 读码（一个子代理）

写 **`rea-p4g-color.md`**，格式同 `rea-p4f-script.md`，每条标地址和证据等级。要回答：
1. **解析**：两个模块的字段名、缺省值、类型与钳制（`hsvcolorrandom` 的 `huemin` / `huemax` / `huesteps`、饱和度 / 明度的键名；`colorlist` 的 `colors` 数组项的格式与数量上限、是否 ÷255），写进初始化记录的哪些偏移（init.c case 4 的 `+4 +8 +0xc +0x10 +0x14 +0x18 +0x1c`、case 5 的 `+4 +0xc +0x1c..+0x30`），`huesteps` 怎么变成步长（`(max − min) / steps`？反向区间、`steps ≤ 0` 时）。
2. **出生公式**：case 4、case 5 逐行：随机数各从哪来、抽几次、什么顺序（`FUN_1402c97a0` 是不是 CRT `rand()`、种子在哪设、全进程共用还是每系统；`FUN_1401f87a0` 是否就是我们的 `R`；`FUN_14024f410` 怎么挑颜色、用哪个随机数），`FUN_1401b8c70`（hsv2rgb）与 `FUN_14041a5c0`（`floor` / `fmod`？）的定义，色相超出 [0, 1) 时的处理，结果乘到哪几列。
3. **系统色与绑定记录**：核对 7.1 的系统色公式（中点的取法、`colorlist` 取第一项且不 ÷255），0xd、0xe 记录的布局与写回目标（字段逐个对上 init 记录的偏移），`colorn` 不生效 / `flags & 8` 时写什么，运行中改 `colorn` 时的重算。
4. **和其它颜色模块的组合**：同一系统里 `colorrandom` + `hsvcolorrandom`（语料写法）各自乘一次？系统色按「后者覆盖前者」取最后一个？
5. **`exponent` 之类的随机分布参数**有没有。

### 0b — 确定性工程与实测（Claude）

- **新增** `ignore/p4/defs/p4g0.py`（`kbp gen p4g0`），出：
  - `p4g-hsv`：`hsvcolorrandom` 各一系统——饱和度 / 明度收成 min = max、`huesteps` 0 与 1（色相确定）、正向与反向区间、色相超出 [0, 1)、语料原样（`huesteps 4` 的反向区间，看档位取值集合）、带 / 不带前面的 `colorrandom`、带 `colorn`（`scene.json` `version` 3 与 5 两份）与 `flags 8` 对照；
  - `p4g-list`：`colorlist` 一个颜色 / 多个颜色（看挑选的分布）、带 `colorn`、项的格式边界；
  - `p4g-live`：`colorn` 绑属性，运行中用 `apply_properties` 改（同 P4f 收尾的 `p4f-bright2` 写法：粒子匀速右移、越右越老，看新老粒子的颜色）。
- 抓帧（`wpe-renderdoc` MCP，fps 20 / 60，`kbp rdc track --points` 读颜色列），结论写进报告新节「P4g 语义的实测核对」。
- 语料那 5 张：WPE 里开一张（只读打开、不改工坊内容）抓帧看粒子颜色的取值集合，作为真实场景的参照。

**验收：** 读码覆盖上面各项，都有地址、公式和证据等级；确定性工程的实测和读码逐条对上（对不上的以实测为准、写明）；分档随机数的处理方式定下来；步骤 1 以后的划分写进本文件。

### 步骤 0 实施记录（2026-11-18）

**0a 读码。** 一个子代理只读汇编与已有反编译，写成 [rea-p4g-color.md](rea-p4g-color.md)，五个问题都有结论，临时文件与新 REA 快照在 `ignore/p4/g0/rea/`。要点：
- `hsvcolorrandom` 的键 `huemin` / `huemax` / `huesteps` / `saturationmin` / `saturationmax` / `valuemin` / `valuemax`，缺省 0 / 1 / 6 / 0.5 / 1 / 0.5 / 1，不钳制，`huesteps` 按整数截断、取 `max(0, ·)`。步长：`s ≤ 1` 时 0；否则 `d = huemax − huemin`（可为负），`span = d == 0 ? 1 : d`，整圈（`|fmodf(d, 1)| < 1/360`）时 `div = s`、否则 `s − 1`，`step = span / div`。
- 出生：档位 `k = min(int(rand()/32767·(s+1)), s)`（共 s+1 档，非整圈时最后一档越过 `huemax`），`rand()` 是 MSVC CRT 的每线程状态（渲染线程启动时用 QPC 播种一次，和声音选文件共用）；之后饱和度、明度各抽一次 `R`；色相不取模，交给 `hsv2rgb` 的 `fmod(h·6, 6)`，负色相得灰色；结果乘到 rgb0。
- `colorlist`：`colors` 只认能切出三个数的字符串项、不 ÷255、存成 HSV；`huenoise` / `saturationnoise` / `valuenoise` 缺省 0；出生时 `uniform_int_distribution` 从 mt19937 取一个 u32 挑下标（n = 1 也抽），再按 `[max(x − noise, 0), min(x + noise, 1)]` 抽三次 `R`，加上平移后色相取小数、S / V 钳到 [0, 1]，每粒子消耗 4 个 u32。
- 系统色：`hsvcolorrandom` 取三个区间中点（各钳到 [0, 1]）的 hsv2rgb，`colorlist` 取第一个有效项的 RGB；绑定记录 0xd（只动 `huemin` 与 S / V 区间，不重算步长）、0xe（写 `colorn` 与第一项的 HSV 差）；`flags & 8` 不建记录；运行中改 `colorn` 下一帧从基值重算。
- 都没有 `exponent`。

**0b 实测。** 工程 `ignore/p4/defs/p4g0.py`（`kbp gen p4g0`）：`p4g-hsv` 13 组、`p4g-hsv5` 6 组（`version 5`、带 `colorn`）、`p4g-list` 8 组、`p4g-live` 2 组（`colorn` 绑属性）。抓帧在 `A:\p4g\`（fps 20，WPE 当时的设置，没改设置），轨迹 `ignore/p4/tracks/rd-p4g-*.json`，读数脚本 `ignore/p4/g0/ana.py`。结论见报告「P4g 语义的实测核对」：读码能用抓帧判定的各条都成立，只有两处和读码不同、以实测为准：
1. `huesteps ≤ 1` 且 `huemin = huemax` 时（`hsv-colorn-fixed`），套 `colorn` 后色相就是 `colorn` 的色相（0.8333），没有按 `span = 1` 偏半圈：说明这种情况记录里的 span 是 0。读码的「`span = d == 0 ? 1 : d`」只在 `s > 1` 的分支里成立【实测】。
2. `colorlist` 不写 `colors` 键时粒子是白色 (1, 1, 1)：缺省值字符串 `"1 1 1"` 被当成一项白色；写成空数组 `[]` 才走「补纯红」。读码原说缺省等同空列表【实测更正】。
- 分档的 `rand()` 不复刻（同 P4a 起「随机数不复刻」）：验收里档位确定的组逐粒子比，分档的组只比取值集合（档位集合、S / V 区间）与大致比例。

## 步骤 1 以后（定稿）

| 步骤 | 内容 |
|---|---|
| 1 | 模块表加 `hsvcolorrandom`、`colorlist`（字段、缺省、解析规则），模拟器出生时两种公式（档位用一个独立的随机源，不占 `R`；`colorlist` 的挑选与三个分量走 `R`、每粒子 4 次抽取的顺序照 WPE），系统色与颜色绑定记录 0xd / 0xe 接进 `particleColorSystem` 与 `particles/colorn.ts` 的重算（含两处实测更正）；能力表去掉两个键。新回放案例 `g1`（`p4g-hsv` / `p4g-hsv5` / `p4g-list` 档位确定的组逐粒子比，分档的组比取值集合）。语料那 5 张预计能渲染，真机看「followed by mice」的颜色并和 WPE 抓帧比取值集合 |
| 收尾 | 文档、回归、changelog、覆盖数 |

### 步骤 1 实施记录（2026-11-18）

**实现**（执行子代理在 HEAD `66210f51` 快照 `ignore/p4/g1/ov` 里做，补丁 `ignore/p4/g1/step1.patch`，10 个文件 +1285 / −16，合并时 10 个文件 HEAD 未动、工作区干净，直接拷入）：
- `particles/random.ts`：档位随机源 `HueSource`（`ParticleRandom.hueRand?()`，缺省是种子派生的独立流，不占 `R`），测试注入 `injectedHue` / `fixedHue`。
- `particles/modules.ts`：两个 initializer 进模块表，新字段类型 `colorlist`；`normalizeHsvColor` 编译期算步长（`s > 1` 才有步长与 `span`，实测更正 1）。
- `particles/initializers.ts`：`hsvColorRandom`（`k = min(trunc(r/32767·(s+1)), s)`，S、V 各一次 `R`，色相不取模，乘到 rgb0）、`colorList`（下标一次 `R`、三分量各一次 `R`，色相取小数、S / V 钳制）。
- `particles/colorn.ts` / `particles/system.ts`：0xd（`recenterHsvRange`：色相按区间中点平移、S / V 居中后钳、超出 1 截短 range，步长不重算）、0xe（第一项 HSV 差平移）；`compile/particles.ts` 的 `particleColorSystem` 认两个模块。缺 `colors` 键当一项白色（实测更正 2），单个字符串当一项，其它形状报 `particle:initializer:colorlist:colors`，字符串 `huesteps` 照报。
- 能力表不用改：模块表登记后两个键自动不再报。

**验收（Claude）**
- tsc 0；相关 vitest 工作区 30 个文件 787 通过（新增 `particles/p4g1.test.ts` 55 条、`compile/p4g1.test.ts` 14 条）。
- `kbp regress`（HEAD 快照 vs 实现快照 + 语料）：20 个旧案例逐字节相同（e1 / e2 / e5 / f1 / f3 两边同样有原有失败），语料 233 张逐场景相同（语料里没有用这两个模块的场景）。
- `kbp mutate`（`ignore/p4/g1/mutate_g1.py`）：7 个变异（档位不加 1、步长恒 s − 1、span 不换 1、`huesteps = 1` 也算步长、0xd 不截短、colorlist 色相不取小数、档位占用 `R`）全部被单测检出，按原字节还原。
- 真机（dev 宿主重建后 `particle_track` 按 WPE 时间线回放，`ignore/p4/g1/cmp_colors.py` 比 `rd-` / `kb-` 轨迹）：档位确定的组（hsv-fixed / steps1 / neg / neg-s1 / wrap / after-cr、hsv-colorn-fixed、list-one / bad / empty / empty2 / 255）逐粒子颜色差 0；分档的组取值集合与 WPE 相同、比例在采样误差内（hsv-fwd / rev / zero-span / real、hsv-colorn-neg、list-many、list-colorn）；连续随机的组色相档位相同、S / V 区间一致（hsv-default / corpus / sv、hsv-colorn / flags8 / corpus5、list-noise / noise-sv）。`p4g-live`（运行中改 `colorn`）只有单测覆盖，回放工具不收运行中的属性写入。
- myprojects 那 5 张（3841315879、3841322784、3841330265、3841337134、3841390912）：`kbp corpus scan --project` 在 HEAD 上都只剩 `particle:initializer:hsvcolorrandom`，实现后 0 项，5 张都能渲染。
