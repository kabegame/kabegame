> 逆向原始记录，代理写的，地址按 llvm-objdump / Ghidra（基址 `0x140000000`）。**全部没有实测**，只有 `capvelocity` 的 99.9927% 用本机 CPU 的 `rsqrtps` 复算过。P4b 步骤 0b 实测核对后，结论以报告为准。

# WPE 2.8.42 P4b 档 2 模块与发射静态逆向

**概括**
- **A 发射：** 周期发射是两态计时器（周期内 / 间歇），两个时长都从流 A 抽，各一次。`flags` bit1 和 `maxtoemitperperiod` 都是先从累积余数里扣掉全部整数，再限额，多余的直接丢。`boxrandom` 是逐轴独立的「空心盒」，速度方向等于出生点相对中心的方向。
- **B 模块：** 字段、两套缺省值、公式、列和标志都读到了。几条容易错的：
  - `turbulence` 和 `vortex` 乘的是 operator 的 `k`（drag 用的那个时间因子），不是 `h`。
  - `turbulence` 解析 `phasemin`，但执行时不读它。
  - `sizechange` 的 `startvalue`、`endvalue` 都乘 `instanceoverride.size`；和 `sizerandom` 叠用时，尺寸按 `size²` 放大。
  - `turbulentvelocityrandom` 不用噪声场，用的是场景时间的一维噪声：同一时刻出生的粒子方向相同。
  - `capvelocity` 的 99.9927% 就是 `rsqrtps(90000)·300`，本机复算 0.99992752。
- **C 噪声：** 三个函数。
  - `turbulentvelocityrandom`：一维 simplex（Gustavson `SimplexNoise1234::noise1`，系数 0.395）。
  - `positionoffsetrandom`：二维 simplex，多倍频叠加；梯度选择和原版不同。
  - `turbulence`：三维 simplex（Gustavson 2012 版，半径 0.6、×32），SIMD 实现。有两处和原版不同：相等时的顶点顺序，第 4 个角的哈希。
  - 常量表都已导出到 `ignore/p4/rea/p4b-mod/noise-tables.json`。
- **D 音频：** 档 2 里 `boxrandom`、`turbulentvelocityrandom`、`turbulence`、`vortex` 带 `audioprocessing*`；作用对象分别是 `rate`、相位范围、速度、速度。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致，只分析 scratchpad 副本，未运行 WPE。
- 方法：全量反汇编 `ignore/p4/rea/wp.asm` 与 `parser.asm`（解析函数读汇编），缺省值函数和发射函数用 REA（Ghidra 12.1.4）反编译。快照 `ignore/p4/rea/p4b-mod/wallpaper64-2.8.42-p4b-mod.rea-snapshot`。
- 工作文件都在 `ignore/p4/rea/p4b-mod/`：`noise-tables.json`（常量表）、`noise3_sse4.asm` / `noise3_sse2.asm`（三维噪声）、`rotate.asm`、`emit_1402378a0.c`（发射函数伪代码）、`tables.py`（导出脚本）。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。

**命名**
- `rec`：流里的一条记录，头 4 字节是「类型 u8、保留 u8、长度 u16」。`p`：记录负载，`p = rec + 0x10`（16 字节对齐的 SIMD 记录）或 `rec + 4`（initializer 的标量记录），各模块注明。
- `×4`：字段在记录里存成 4 份相同的 float（SIMD 广播）。
- `R`：每粒子随机数列 `sys+0x338`，出生时抽一次，所有模块共用。
- `uA`：从流 A 新抽一个 `[0,1)`（区间在 `ctx+0x20/24`）。`uB`：从流 B 新抽一个 `[1e-5,1)`（`ctx+0x28/2c`）。两个流共用一个 MT19937 状态 `ctx+0x1cd0`，取值都是 `((u32>>8)·2⁻²⁴)·(hi−lo) + lo`，先乘 `2⁻²⁴` 再乘区间宽度。
- `h`、`k`：operator 解释器 `FUN_14023fbc0(sys, h, k)` 的两个参数。`h` 存 `[rbp+0x2008]`、广播在 `[rbp+0xf0]`；`k` 存 `[rbp+0x2010]`、广播在 `[rbp+0x5f0]`，每条 operator 开头 `0x140240290` 重新装进 `xmm8`。`k = k0 = pow(min(1, 0.025/ctx.dt), 0.7)·dt'`，两遍模式时 `h`、`k` 都减半（rea-framework Q1）。`dt ≤ 0.025` 时 `k0 = dt'`。
- `T`：`ctx+0x130` 的 float，即 `R+0x140`。它是场景时间的 float 副本，超过 432000 归零（rea-framework Q2 第 5 步）；和着色器 `g_Time` 同源【推】。
- 运算：本文伪代码里 `a·b + c` 都是 `mulss` 再 `addss` 两步，读到的代码里没有 FMA；括号就是实际的结合顺序。CRT 的 `sinf`、`cosf`、`powf` 内部可能走 FMA 分派，没有读。
- 矩阵：`Mij` 是第 i 列的第 j 个分量（列主序，和内存顺序一致）。

---

## 基础补充

### 记录类型与位置【确】

| 模块 | 类 | 类型号 | 记录长度 | 负载 | 解析段 | 缺省值函数 | 执行入口 |
|---|---|---|---|---|---|---|---|
| `boxrandom` | emitter | 2 | 0xb0 | rec+0x10 | `0x1401c6390` | `FUN_1401b9520`（含公共 `FUN_1401b8df0`） | `0x140238563` 起的循环 |
| `alpharandom` | initializer | 6 | 0x10 | rec+4 | `0x1401c7f37` | `FUN_1401baa10` | `0x14023ba6f` |
| `turbulentvelocityrandom` | initializer | 9 | 0x64 | rec+4 | `0x1401c8748` | `FUN_1401bb030` | `0x14023bdbc` |
| `positionoffsetrandom` | initializer | 11 | 0x30 | rec+4 | `0x1401c903a` | `FUN_1401bb660` | `0x14023c09a` |
| `sizechange` | operator | 4 | 0x50 | rec+0x10 | `0x1401cb964` | `FUN_1401bcfe0` | `0x14024033a` |
| `colorchange` | operator | 5 | 0x90 | rec+0x10 | `0x1401cbb68` | `FUN_1401bd2a0` | `0x1402403a2` |
| `alphachange` | operator | 6 | 0x50 | rec+0x10 | `0x1401cbf2a` | `FUN_1401bcfe0` | `0x140240457` |
| `oscillatesize` | operator | 9；blend 0x1f | 0xb0 | rec+0x10 | `0x1401cc7f4` | `FUN_1401bdbf0` | `0x14024123a`；blend `0x1402413a0` |
| `turbulence` | operator | 14；blend 0x24 | 0x100 | rec+0x10 | `0x1401cd41c` | `FUN_1401beb80` | `0x14024295a`；blend `0x140242d6e` |
| `vortex` | operator | 15 | 0xf0 | rec+0x10 | `0x1401cd8a2` | `FUN_1401bef00` | `0x1402431be` |
| `capvelocity` | operator | 18；blend 0x26 | 0x60 | rec+0x10 | `0x1401ce5c6` | `FUN_1401bfab0` | `0x1402446fd`；blend `0x140244790` |

- 跳转表下标 = 类型号 − 1：initializer 表 `0x14023fa78`，operator 表 `0x14024bb58`。
- 缺省值函数只在 JSON 缺键时写（辅助函数 `FUN_1401d7d30` / `FUN_1401d7e80` / `FUN_1401d7be0` 先查键）。第二个参数是正交开关（`ctx+0x118 & 0x400`），下文「正交 / 透视」。
- 只有 `oscillatesize`、`turbulence`、`capvelocity` 有 blend 变体。blend 的四个键、切换条件和系数 `b` 与 rea-p4a 相同（`FUN_1401c2a40` 解析，`FUN_14022a530` 计算 `b = clamp((oe−t)·rcpps(oe−os)) · clamp((t−is)·rcpps(ie−is))`，`t = rcpps(life)·age`）【确】。

### 向量字段【确 / 推】
- 向量键（`distancemin`、`mask`、`forward` 等）用 `asCString` 取字符串再逐个 `atof`，空格分隔。缺的分量是 0【推：填充值来自 `xmm13`，在 operator / initializer 段里为 0】。
- `asCString`（`FUN_140085ca0`）不检查类型。写成数字时，`0` 被当成空指针，得 `0 0 0`；非零数字会把 double 的位当指针用【推：多半崩溃或读到垃圾】。Kabegame 对非字符串的向量键应报不支持。

### `instanceoverride` 写回的条目类型（`FUN_1401d15a0`）【确】
解析时登记条目，加载与每次重算时从 JSON 原值重新写回字段：

| 条目类型 | 写法 | 用在 |
|---|---|---|
| 1 | `field = int(f32(value) · o)`，截断 | `maxtoemitperperiod` × `count` |
| 2 | `field = value · o` | 发射 `rate` × `count`；`turbulence`、`turbulentvelocityrandom` 的 `timescale` × `rate` |
| 6 | `f1 = v1·o`，`f2 = v2·o − v1·o`（标量） | `boxrandom`、`turbulentvelocityrandom` 的 `speedmin/max` × `speed` |
| 7 | 同 6，但写 ×4 广播 | `sizechange` 的 `startvalue/endvalue` × `size`；`turbulence` 的 `speedmin/max` × `speed`；`vortex` 的 `speedinner/outer` × `speed` |

`o` 是 `instanceoverride` 的对应值（`size +0xcc`、`count +0xd0`、`speed +0xd4`、`rate +0xdc`）。`speed` 条目在粒子 `flags & 0x10` 时不登记，`size` 在 `& 0x80` 时不登记，`count` 在 `& 0x20` 时不登记；`rate` 条目无条件登记。

---

## A. 发射

### A0 发射器公共字段（`FUN_1401c1c70` 解析，`FUN_1401b8df0` 缺省）【确】

| 字段 | 缺省 | rec 偏移 | 说明 |
|---|---|---|---|
| `rate` | 10 | +0x10 | 乘 `count`（类型 2） |
| `duration` | 0 | +0x14 | 运行时递减；+0x1c 存初值 |
| `delay` | 0 | +0x18 | 运行时递减；+0x20 存初值 |
| — | 0 | +0x24 | **累积余数 `acc`** |
| `minperiodicduration` / `maxperiodicduration` | 2 / 3 | +0x28 / +0x2c | 解析时 `min = min(min, max)` |
| `minperiodicdelay` / `maxperiodicdelay` | 1 / 2 | +0x30 / +0x34 | 同上 |
| `maxtoemitperperiod` | 0 | +0x38 | 整数，乘 `count`（类型 1） |
| — | 0 | +0x3c | **本周期已连续发射数 `burst`** |
| — | 0 | +0x40 | **周期计时 `P`**：正数是本周期剩余时长，负数是剩余间歇 |
| `instantaneous` | 0 | +0x44 | 待发数 `pending`；+0x48 存初值 |
| `flags` | 0 | +0x4c | bit0 用 `sign`、bit1 每帧至多 1 个、bit2 周期、bit31 已结束 |
| `audioprocessing*` | 见 D | +0x50 | |

rea-framework Q5 记的 `+0x24` 累积余数、`+0x40` 周期计时、`+0x3c` 连发计数，都是相对记录头的偏移，和上表一致。

### A1 每帧数量（`FUN_1402378a0`，`0x1402379c0`–`0x140237b74`）【确】

逐个 emitter 按流顺序执行（`dt` 是 `dt'`，不受两遍模式影响）：

```
if 存活 < 容量 且 !(flags & bit31) 且 sys+0x3f7 bit0 == 0 且 delay <= 0:      // 0x1402379c0–0x1402379ef
    rate = rec.rate
    if audio.mode != 0: rate = audio(…) · rate                                 // 0x140237a09
    if flags & 4:  …周期计时，见 A3，可能把 rate 乘 0…
    n0 = pending + 脚本数量;  pending = 0                                       // 整数
    x  = rate·dt + acc                                                         // mulss 再 addss
    if x < 1 或 duration < 0:
        acc = x − f32(n0)
    else:
        k  = int(floorf(x))                                                    // FUN_14041a5c0 是 floorf
        acc = x − f32(k + n0)                                                  // 先扣掉全部 k
        if flags & 2: k = min(1, k)                                            // 0x140237b05、0x140237b25
        if (flags & 4) 且 maxtoemit != 0:                                      // 0x140237b33
            k = min(k, max(0, maxtoemit − burst));  burst += k
        n0 += k
本帧发射 = min(n0, 容量 − 存活)
```

- **满容量时整段跳过：** `acc`、周期计时、`pending` 都不动。
- **`delay > 0` 时整段跳过：** 周期计时也不走，`pending` 留到第一个 `delay ≤ 0` 的帧。
- **bit1 与 `maxtoemitperperiod` 丢弃多余的：** `acc` 已经扣掉了全部 `k`，限额砍掉的部分不退回。`rate 200`、`flags 2`、60 fps 时每帧 `x ≈ 3.3`，只发 1 个，`acc` 留 0.3。
- **bit1 不限 `instantaneous`：** `n0` 不受 bit1 约束，`instantaneous 50` 仍一帧发 50 个。
- **`burst` 只数连续发射：** `instantaneous` 不计入 `maxtoemitperperiod`。
- `sys+0x3f7` bit0 由子系统更新写入（`0x14023641b`、`0x1402364bc`），顶层系统应为 0【推】。
  - **更正（P4f，rea-p4f-script 2.1）：** bit0 是脚本 `pause()` 的暂停位，顶层系统也会置；置位时发射函数整段返回（不发、帧尾不跑、计时冻结），子系统每帧从父拷。

### A2 帧尾（`0x140238461`、`0x14023ae24`–`0x14023ae67`）【确】

发射之后，每个 emitter：
```
if delay > 0:            delay −= dt
elif duration > 0:       duration −= dt
                         if duration <= 0: duration = −1;  标记结束
elif rate <= 0 且 (instantaneous 初值 == 0 或 !(flags & 4)):  标记结束
标记结束：flags |= 0x80000000，第一次标记时 sys+0x3f4 减一
```
- 三支互斥：`delay` 没走完时 `duration` 不递减。
- 第一个发射帧在帧尾就递减 `duration`。发射帧数是让 `Σdt ≥ duration` 的最小帧数，最后一帧照常发射。
- `rate 0`、`instantaneous` 非零、非周期：第一帧发完 `instantaneous` 后结束。周期发射时不结束，每个周期开头重发。
- `rate` 读的是 `rec.rate`（已乘 `count`），不含音频。

### A3 周期发射（`flags & 4`，`0x140237a15`–`0x140237ac8`）【确】

`P` 初值 0。计时在 A1 那段里、算数量之前：
```
if P > 0:                                    // 周期内
    P −= dt
    if P < 0:  P = −(uA·(maxdelay − mindelay) + mindelay)       // 进入间歇；本帧照常发
else:                                        // 间歇（含初值 0）
    P += dt
    if P < 0:  rate = rate · 0                                   // 间歇中不连续发射
    else:                                    // 新周期
        u = uA
        pending = instantaneous 初值;  burst = 0
        P = u·(maxduration − minduration) + minduration
        FUN_14022f790(sys)                   // 见下
```
- **随机数：** `FUN_1401f4bc0` 取流 A，`u·(max−min)+min`。每次切换抽一个：进入新周期抽时长，进入间歇抽间歇。抽取时机在该 emitter 算数量时，早于它本帧的任何新粒子，晚于流顺序在它之前的 emitter 的新粒子。
- **第一帧就开始周期：** 计时初值 0，第一帧 `P = dt ≥ 0`，立即抽时长、重装 `pending`。
- **不补零头：** 新周期把 `P` 直接设成抽到的时长，丢掉 `P + dt` 的余量；进入间歇时同样丢掉 `P − dt` 的负余量。计时按帧量化。
- **切换帧都发射：** 周期最后一帧（`P − dt < 0`）和间歇最后一帧（`P + dt ≥ 0`）都以全 `rate` 发射。
- **间歇里 `acc` 保留：** 间歇中 `x = acc < 1`，余数原样带过间歇。
- `FUN_14022f790`：对 `sys+0x480` 里定义带 `+0x64 & 2` 的子系统调 `FUN_14022f6c0` 复位计时并清结束标志；对 initializer 类型 13 / 14（`mapsequence*`）满足条件的清零序号（`rec+8`）。P4b 只需知道它存在。
- 发射器计时复位 `FUN_14022f6c0`（对象不可见时调用）：`duration`、`delay`、`pending` 回初值，`acc`、`burst`、`P` 归零，不清 bit31【确】。

### A4 `boxrandom`

**字段与缺省（`FUN_1401b9520`）【确】**

| 字段 | 正交 | 透视 | 负载偏移 | 说明 |
|---|---|---|---|---|
| `origin` | `0 0 0` | 同 | p+0x60 | 只接受字符串 |
| `directions` | `1 1 0` | `1 1 1` | p+0x6c | 只接受字符串 |
| `distancemin` | `0 0 0` | 同 | p+0x78 | **向量**，只接受字符串 |
| `distancemax` | `256 256 0` | `1 1 1` | p+0x84 存 `max − min` | **向量** |
| `speedmin` / `speedmax` | 0 / 0 | 同 | p+0x90 / p+0x94 存 `min`、`max − min` | 乘 `speed`（类型 6） |
| `controlpoint` | 0 | 同 | p+0x98 | 上限 7 |
| `flags` | 0 | 同 | 公共 | 只有 bit1、bit2 有用 |
| 公共发射字段 | 见 A0 | | | |

- 没有 `sign`，也没有 `cone`。`flags` bit0 不会自动置位，盒形代码也不读它。
- 解析时 `[r13+0x2c] = max(已有, controlpoint + 1)`（用到的控制点数）。

**每个新粒子（`0x140238563`–`0x140238c3a`）【确】**
```
// 进循环前：
base = origin + cp.t                         // origin.x + cp[+0x30] 等，一次加法
M    = cp 的 3×3（cp[+0x00..0x08]、[+0x10..0x18]、[+0x20..0x28] 三列）
旋转 = (sys flags & 1) 或 controlpoint != 0

找第一个 life == 0 的槽
rz = (2·uB − 1)·directions.z                 // 抽取顺序 z、y、x；2u 用 addss u,u 得到
ry = (2·uB − 1)·directions.y
rx = (2·uB − 1)·directions.x
s_i = (r_i > 0) − (r_i < 0)                   // 符号，r_i = 0 时为 0
q_i = s_i · ((s_i·r_i)·(max_i − min_i) + min_i)
if 旋转:
    X = (qx·M00 + qy·M10) + qz·M20
    Y = (qy·M11 + qx·M01) + qz·M21
    Z = (qx·M02 + qy·M12) + qz·M22
pos = q + base                                // 写位置列
d   = pos − base                              // 用写进去的 float 重新减，不是 q 本身
if 1 / fastInvSqrt(|d|²) < 0.0001:            // 0x14023896e：0x5f375a86 加一次牛顿迭代
    dz = (2·uB − 1)·directions.z;  dy = …y;  dx = …x       // 同样 z、y、x 顺序，再按上面过旋转
len = sqrtss((dy·dy + dx·dx) + dz·dz);  inv = 1 / len    // 精确
speed = uB·(max − min) + min
v_i = speed·(inv·d_i)
写默认值、跑 initializer（第 3 参数传 M，见 B2）、存活数加一
```
- **含义：** 每轴独立，`|q_i| ∈ [min_i, min_i + |directions_i|·(max_i − min_i)]`，符号随机。`distancemin` 三轴都大于 0 时，粒子落在 8 个角块里，不是盒壳。`directions_i = 0` 时这一轴是 0，`distancemin_i` 不起作用。
- **速度方向就是出生点相对中心的方向**（过了控制点旋转）。没有 `cone`。
- **同帧出生的粒子位置随机，但没有按子帧错开时间**【确】。
- 近似：`fastInvSqrt` 是整数位技巧加一次牛顿，可以逐位复刻（Float32Array / Int32Array 互转），只用于 1e-4 的判断。速度用精确 `sqrtss` 和 `divss`。
- `|d| = 0`（回退后仍为 0，比如 `directions "0 0 0"`）时 `inv = inf`，速度是 NaN【推】。

---

## B. 模块

### B1 `alpharandom`（initializer 6）

| 字段 | 缺省 | 偏移 |
|---|---|---|
| `min` | 0.05（float 值 `0x3d4ccccd`） | p+0 |
| `max` | 1 | p+4 存 `max − min` |
| `exponent` | 1 | p+8 |

两套缺省相同，没有覆盖项，没有音频。

```
t = uA;  if exponent != 1: t = powf(t, exponent)      // 0x14023ba6f，FUN_14041e350 是 powf【推】
a0 = (t·(max − min) + min) · a0                       // 共用 sizerandom 的乘法尾巴 0x14023b684
```
- 写 alpha 初值列 `sys+0x330`，不碰当前值列，不置标志。当前值在每遍 operator 开头从 `a0` 复制，结果一样。
- 用新抽的 `uA`，不用 `R`。`min = max` 时与随机数无关（`t·0 = 0`）。

### B2 `turbulentvelocityrandom`（initializer 9）

| 字段 | 正交 | 透视 | 偏移 | 说明 |
|---|---|---|---|---|
| `speedmin` | 100 | 0.5 | p+0 | 乘 `speed`（类型 6） |
| `speedmax` | 250 | 1 | p+4 存 `max − min` | 同上 |
| `phasemin` | 0 | 同 | p+8 | |
| `phasemax` | 0.1（float） | 同 | p+0xc 存 `max − min` | |
| `timescale` | 1 | 同 | p+0x10 | 乘 `instanceoverride.rate`（类型 2，无条件） |
| `scale` | 1 | 同 | p+0x14 | |
| `offset` | 0 | 同 | p+0x18 | 标量，弧度 |
| `forward` | `0 1 0` | 同 | p+0x1c | 向量，**不归一化** |
| `right` | `0 0 1` | 同 | p+0x28 | 向量，执行时归一化 |
| `audioprocessing*` | 见 D | | p+0x40 | |

没有 `up` 键。

**执行（`0x14023bdbc`）【确】**
```
prange = phasemax − phasemin;  if audio.mode != 0: prange = audio(…)·prange
u1   = uA
t    = ((u1·prange + phasemin) + T) · timescale         // T = 场景时间
n    = snoise1(t)                                       // C1
ang  = ((n · π) · scale) + offset                       // π = 0x40490fdb
Rm   = glm::rotate(I, ang, normalize(right))            // FUN_1401e2500，cos/sin 走 CRT
dir  = mat3(Rm) · forward                               // FUN_140184440
u2   = uA
spd  = u2·(speedmax − speedmin) + speedmin
add  = dir · spd
vel += M · add                                          // M 是发射器传来的控制点 3×3
```
- `glm::rotate`：`a = normalize(right)`（精确 `1/sqrtss`）、`c = cosf(ang)`、`s = sinf(ang)`、`temp = (1−c)·a`；`R[i][i] = c + temp_i·a_i`，`R[0][1] = temp0·a1 + s·a2`、`R[0][2] = temp0·a2 − s·a1`、`R[1][0] = temp1·a0 − s·a2`、`R[1][2] = temp1·a2 + s·a0`、`R[2][0] = temp2·a0 + s·a1`、`R[2][1] = temp2·a1 − s·a0`（`FUN_14041a2e0` = cos，`FUN_14041a9c0` = sin）【确】。
- `mat3·v`（`FUN_140184440`）：`x = (v.y·m10 + v.x·m00) + v.z·m20`，`y = (v.x·m01 + v.y·m11) + v.z·m21`，`z = (v.x·m02 + v.y·m12) + v.z·m22`【确】。
- **加到**速度上，不覆盖。不用 `R`，用两个新的 `uA`（先相位后速度）。
- **方向只由出生时刻决定：** 同一时刻出生、`phasemin = phasemax` 的粒子方向完全相同。缺省 `forward 0 1 0`、`right 0 0 1` 时 `dir = (−sin ang, cos ang, 0)`。
- `M` 总是乘上。发射器 cp 0、非世界空间时 `M` 是 cp 0 的旋转部分；cp 0 没有旋转时就是单位阵【推：cp 初值是单位阵加 offset，rea-p4a 未查完一项】。
- 不置列标志，没有 blend。
- 预热（`starttime`）不走帧函数，`T` 在加载期保持初值【推：多半是 0】，所以预热期出生的粒子方向都一样。

### B3 `positionoffsetrandom`（initializer 11）

| 字段 | 正交 | 透视 | 偏移 | 说明 |
|---|---|---|---|---|
| `directions` | `1 1 0` | `1 1 1` | p+0 | 向量 |
| `sign` | `0 0 0` | 同 | p+0xc | 向量；`|sign|² > 1.19e-7` 时置 p+0x28 bit0 |
| `scale` | 0.001 | 1 | p+0x18 | 位置缩放 |
| `distance` | 100 | 0.1 | p+0x1c | 输出幅度 |
| `timescale` | 1 | 同 | p+0x20 | **不乘** `instanceoverride.rate` |
| `octaves` | 6 | 同 | p+0x24 | 解析时钳到 `[1, 8]`（无符号比较） |

没有覆盖项，没有音频，没有 blend，不置标志。

**执行（`0x14023c09a`）【确】**
```
Ts = timescale · T
(px, py, pz) = 当前位置（发射器和前面的 initializer 已写）
X = fbm(i => snoise2(f·(px·scale), f·Ts))
Y = fbm(i => snoise2(f·Ts,          f·(py·scale)))       // 参数顺序和 X 相反
Z = fbm(i => snoise2(f·(pz·scale), f·(−Ts)))              // 时间取负
fbm：f = 1, a = 1, sum = 0, norm = 0
     重复 octaves 次：n = 噪声(f);  sum += n·a;  norm += a;  a = a·0.5;  f = f + f
     结果 = sum / norm                                    // divss
o = (X·dir.x, Y·dir.y, Z·dir.z)
if sign 标志: o_i = |o_i|·sign_i + o_i·(1 − |sign_i|)      // FUN_1401e2880 + fabs
pos_i = o_i·distance + p_i
```
- **完全确定：** 不用 `R`，也不抽随机数。只依赖出生位置、场景时间和参数。
- `sign` 的效果：`±1` 强制该轴符号，`0` 不变，中间值是两者线性混合。

### B4 `sizechange`、`alphachange`、`colorchange`（operator 4、6、5）

**字段【确】**

| 模块 | `startvalue` | `endvalue` | `starttime` | `endtime` | 覆盖项 | 置标志 |
|---|---|---|---|---|---|---|
| `sizechange` | 1 | 0 | 0 | 1 | `size` 乘 `startvalue` 和 `endvalue`（类型 7） | 无 |
| `alphachange` | 1 | 0 | 0 | 1 | 无 | bit4 |
| `colorchange` | `"1 1 1"` | `"0 0 0"` | 0 | 1 | 有一条类型 0xc（`colorn` 的 HSV 路径，`flags & 8` 时不登记），归 `rea-p4b-render.md` | bit3 |

- 三个模块两套缺省相同，没有 blend，没有音频。
- `colorchange` 的颜色是两个字符串向量，**不除以 255**，就是 0–1 的倍数。只接受字符串。
- 解析期：记录存 `start`（×4）、`end − start`（×4）、`starttime`（×4）、`rcpps(endtime − starttime)`（×4）。**倒数是解析时用 `rcpps` 算的近似值**；`endtime = starttime` 时是 `inf`【推：之后 `t` 按 NaN / inf 走 min / max】。

**执行【确】**
```
t = max(0, min(1, ((rcpps(life)·age) − starttime) · rcpEnd))     // rcpEnd 是解析期的 rcpps
size *= t·(end − start) + start                                   // sizechange，0x14024033a
a    *= t·(end − start) + start                                   // alphachange，0x140240457，a 是当前值列
r    *= t·(end.r − start.r) + start.r                             // colorchange，0x1402403a2，g、b 同理
```
- `t` 是生命比例，不是秒。`minps(x, 1)`、`maxps(0, …)`：`x` 为 NaN 时得 1。
- 都乘到当前值上；当前值每遍开头从初值复制，所以两遍模式结果不变。不用 `h`、`k`、`R`。
- **`sizechange` 乘 `size` 的后果：** `sizerandom` 的 min / max 也乘 `size`，两个模块同时存在时，最终尺寸按 `size²` 变化。这一点读码确定，但和直觉不同，要实测。

### B5 `oscillatesize`（operator 9，blend 0x1f）

| 字段 | 缺省（两套相同） | 偏移 |
|---|---|---|
| `frequencymin` / `frequencymax` | 1 / 10 | p+0 / p+0x10 存 `max − min` |
| `phasemin` / `phasemax` | 0 / 2π（float `0x40c90fdb`） | p+0x20 / p+0x30 |
| `scalemin` / `scalemax` | 0.8 / 1.2（float 值） | p+0x40 / p+0x50 |
| blend 四键 | 同 rea-p4a | p+0x60 |

没有覆盖项（频率不乘 `speed`），没有音频，不置标志。

**执行【确】**
```
ω   = R·(fmax − fmin) + fmin
τ   = (R·(pmax − pmin) + pmin) + age
s   = sin_ps(τ·ω)                                       // sse_mathfun 的 sin_ps，见 C4
amp = R·((smax − smin)·0.5)
无 blend（0x14024123a）：size *= (s + 1)·amp + smin
有 blend（0x1402413a0）：size *= (((s + 1)·amp + (smin − 1))·b) + 1
```
- `ω` 就是频率，不乘 2π；相位加在时间上（和 P4a 的 `oscillateposition` 相同）。
- **幅度也乘 `R`**，和 `oscillatealpha` 一样。
- 绝对式（不是增量），两遍结果不变，不用 `h`、`k`。

### B6 `turbulence`（operator 14，blend 0x24）

| 字段 | 正交 | 透视 | 偏移 | 说明 |
|---|---|---|---|---|
| `mask` | `1 1 0` | `1 1 1` | p+0 / +0x10 / +0x20（各 ×4） | 向量；每轴非 0 时在 p+0xc4 置 bit0/1/2 |
| `scale` | 0.01 | 0.5 | p+0x30 | 位置缩放 |
| `speedmin` / `speedmax` | 500 / 1000 | 1 / 5 | p+0x40 / p+0x50 存 `max − min` | 乘 `speed`（类型 7） |
| `phasemin` / `phasemax` | 0 / 0 | 同 | p+0x60 / p+0x70 存 `max − min` | **执行时不读 `phasemin`** |
| `timescale` | 20 | 1 | p+0xc0 | 乘 `instanceoverride.rate`（类型 2，无条件） |
| blend 四键 | | | p+0x80 | |
| `audioprocessing*` | | | p+0xd0 | |

**执行（`0x14024295a`，blend `0x140242d6e`）【确】**
```
if 掩码位 == 0: 跳过
Ts = T · timescale
smin' = speedmin、srange' = speedmax − speedmin；有音频时都乘 audio(…)
mk_i = k · mask_i                                      // 注意是 k
每粒子：
    φ   = R·(phasemax − phasemin) + Ts                 // phasemin 不参与
    spd = R·srange' + smin'
    有 blend：spd = spd · b
    X = (x + φ)·scale;  Y = (y + φ)·scale;  Z = (z + φ)·scale
    按掩码位只算需要的轴（跳转表 0x14024bbf8，blend 版 0x14024bc14）：
        Nx = snoise3(X, Y, Z)
        Ny = snoise3(Z, X, Y)
        Nz = snoise3(Y, Z, X)
        未算的轴为 0
    v_i = (N_i · mk_i) · spd + v_i
```
- **用 `k`，不用 `h`：** `xmm8` 每条 operator 开头重新装成 `k`（`0x140240290`）。fps ≥ 40（`dt ≤ 0.025`）时 `k = dt'`，看不出差别；fps 低于 40 时 `k < dt'`，湍流被压弱。两遍模式时每遍是 `k/2`，两遍之间位置会被 `movement` 改动，噪声输入不同。
- 噪声输入用当前位置、场景时间，`φ` 同时加到三个坐标上。
- 用 `R` 两处：相位、速度。用 `instanceoverride.speed`（经 `speedmin/max`）和 `instanceoverride.rate`（经 `timescale`）。
- 不置标志，不用控制点。

### B7 `vortex`（operator 15，无 blend）

| 字段 | 正交 | 透视 | 偏移 | 说明 |
|---|---|---|---|---|
| `offset` | `0 0 0` | 同 | p+0 / +0x10 / +0x20 | 向量，**不经控制点旋转** |
| `axis` | `0 0 1` | 同 | p+0x30 / +0x40 / +0x50 | 精确归一化；`|axis|² < 0.001` 时取 `0 0 1`【`0.001` 来自 `xmm11`，推】 |
| `distanceinner` | 500 | 1 | p+0x60 | |
| `distanceouter` | 650 | 2 | p+0x70 存 `rcpps(outer − inner)` | 两者相等时存 1.0【`xmm15`，推】 |
| `speedinner` | 2500 | 1 | p+0x80 | 乘 `speed`（类型 7） |
| `speedouter` | 0 | 同 | p+0x90 存 `outer − inner` | 同上 |
| `flags` | 0 | 同 | p+0xa0 | bit0：轴向掩码（全 1 或 0） |
| `controlpoint` | 0 | 同 | p+0xb0 | 上限 7 |
| `audioprocessing*` | | | p+0xc0 | |

**执行（`0x1402431be`）【确】**
```
C = cp[controlpoint].t + offset                     // cp 当前矩阵 +0x30..0x38，axis、offset 都不旋转
si' = speedinner、sr' = speedouter − speedinner；有音频时都乘 audio(…)；再都乘 k
每粒子：
    d    = pos − C
    proj = ((d.y·a.y + d.x·a.x) + d.z·a.z) & mask     // flags bit0 = 0 时 proj = 0
    r    = d − proj·a
    L2   = (r.y² + r.x²) + r.z²
    q    = rsqrtps(L2)                               // 近似
    r̂    = q·r
    L    = q·L2
    t    = max(0, min(1, (L − inner)·rcpRange))
    spd  = t·sr' + si'
    v   += (r̂ × a)·spd       // r̂×a = (r̂y·az − r̂z·ay, r̂z·ax − r̂x·az, r̂x·ay − r̂y·ax)
```
- `flags` bit0 置位：按到轴线的距离（柱形）；否则按到中心的距离（球形），`r̂` 是径向单位向量。
- **用 `k`**，理由同 `turbulence`。不用 `R`。
- 用控制点平移（缺省 cp 0），不用控制点旋转。按 P4b 计划，用到非 0 控制点的归 P4c；cp 0 的平移是否就是系统原点要看 cp 初值【推】。
- `L2 = 0`（粒子正好在轴上或中心）时 `r̂` 是 NaN【推】。

### B8 `capvelocity`（operator 18，blend 0x26）

| 字段 | 正交 | 透视 | 偏移 |
|---|---|---|---|
| `maxspeed` | 100 | 1 | p+0（×4） |
| blend 四键 | | | p+0x10 |

**没有覆盖项**：`instanceoverride.speed` 放大速度，但不放大上限。没有音频。

**执行【确】**
```
L2 = (vy² + vx²) + vz²
q  = rsqrtps(L2)·maxspeed                              // 0x140244756
无 blend：s = min(1, q)
有 blend：s = min(0, q − 1)·b + 1
v *= s
```
- **99.9927% 的来源：** P4a `o2-cap` 的初速 300、`maxspeed 100`，`s = rsqrtps(90000)·100`。本机（i7-13790F）用 .NET `Sse.ReciprocalSqrt` 复算：`rsqrtps(90000) = 0.0033330917`，`300·s = 99.99275`，比例 0.99992752。
- 下一帧 `|v|² = 9998.551`，`rsqrtps·100 = 1.0002 > 1`，`s = 1`，所以截一次后稳定。
- 比例由 `|v|²` 的尾数决定，不是常数；Intel 与 AMD 的近似表不同。按计划不复刻，用精确 `1/sqrt`，允许相对 3.7e-4。
- `v = 0` 时 `q = inf`，`s = 1`；`maxspeed = 0` 且 `v = 0` 时 `inf·0 = NaN`【推】。
- 两遍模式每遍都截。截过一次后，`rsqrtps` 偏大时第二遍 `s = 1`，偏小时会再截一点。

### B9 汇总

| 模块 | 用 `R` | 新随机数 | `h` / `k` | 覆盖项 | 控制点 | 近似运算 |
|---|---|---|---|---|---|---|
| `alpharandom` | 否 | `uA` 1 个 | — | 无 | 否 | 无 |
| `turbulentvelocityrandom` | 否 | `uA` 2 个 | — | `speed`、`rate` | 发射器的 3×3 | CRT `sinf` / `cosf` |
| `positionoffsetrandom` | 否 | 无 | — | 无 | 否 | 无 |
| `sizechange` | 否 | 无 | 无 | `size` | 否 | `rcpps(life)`、解析期 `rcpps` |
| `alphachange` / `colorchange` | 否 | 无 | 无 | 无（`colorchange` 另有 `colorn`） | 否 | 同上 |
| `oscillatesize` | 是：ω、相位、幅度 | 无 | 无 | 无 | 否 | `sin_ps`；blend 的 `rcpps` |
| `turbulence` | 是：相位、速度 | 无 | `k` | `speed`、`rate` | 否 | blend 的 `rcpps` |
| `vortex` | 否 | 无 | `k` | `speed` | 平移 | `rsqrtps`、解析期 `rcpps` |
| `capvelocity` | 否 | 无 | 无 | 无 | 否 | `rsqrtps` |
| `boxrandom` | — | `uB` 4 个（回退时 7 个） | — | `count`、`speed` | 平移、旋转 | 判断用的 `fastInvSqrt`（可逐位复刻） |

---

## C. 噪声

三个函数、两套表。常量全部导出在 `ignore/p4/rea/p4b-mod/noise-tables.json`（`tables.py` 生成）：
- `snoise1` / `snoise2` 共用 `0x140484f40` 的 256 字节置换表（Ken Perlin 原表），下标按 u8 回绕。
- `snoise3` 用 `0x1404833a0` 的 512 字节 `perm`（前 256 字节同上，后 256 字节重复）和 `0x1404831a0` 的 512 字节 `permMod12`（`= perm % 12`），三张 12 项 float 梯度表：`gx 0x140483170`、`gy 0x140483140`、`gz 0x1404835a0`，和 Gustavson `grad3` 相同。

下面的伪代码都是 float32，每一步结果都要 `Math.fround`。`floor` 指向下取整到整数。

### C1 `snoise1(x)`（`FUN_14027b090`，`turbulentvelocityrandom` 用）【确】

```
i0 = int(x)（cvttss2si 截断）;  if f32(i0) > x: i0 −= 1
x0 = x − f32(i0)
x1 = x0 − 1
grad(h, v): g = f32(h & 7) + 1;  if (h & 8) g = −g;  return g·v
h0 = perm[i0 & 255]
t0 = 1 − x0·x0;  t0 = t0·t0;  t0 = t0·t0
n0 = grad(h0, x0)·t0
h1 = perm[(i0 + 1) & 255]
t1 = 1 − x1·x1;  t1 = t1·t1;  t1 = t1·t1
n1 = grad(h1, x1)·t1
return (n1 + n0)·0.395                    // 0x3eca3d71
```
- 就是 Gustavson `SimplexNoise1234::noise1`，没有半径截断（`t` 恒为非负）。
- `x ≥ 2³¹` 时 `cvttss2si` 返回 `0x80000000`，结果无意义；场景时间 432000 内、`timescale` 不太大时碰不到。

### C2 `snoise2(x, y)`（`FUN_14027b170`，`positionoffsetrandom` 用）【确】

```
F2 = 0x3ebb67ae, G2 = 0x3e58658c, C2 = 0x3ed8658c（= x0 − 1 + 2·G2 那项）
s  = (x + y)·F2
i  = floorI(x + s);  j = floorI(y + s)          // 截断再修正，同 C1
t  = f32(i + j)·G2                              // 整数先加
x0 = x − (f32(i) − t);  y0 = y − (f32(j) − t)
i1 = x0 > y0 ? 1 : 0;  j1 = 1 − i1
x1 = (x0 − i1) + G2;  y1 = (y0 − j1) + G2
x2 = (x0 − 1) + C2;   y2 = (y0 − 1) + C2
ii = i & 255;  jj = j & 255                     // 下面的加法都按 u8 回绕
grad(h, a, b):
    (u, v) = ((h & 0x3c) == 0) ? (a, b) : (b, a)      // 原版是 (h & 7) < 4
    if (h & 1) u = −u
    v = (h & 2) ? v·(−2) : v + v
    return v + u
t0 = (0.5 − x0·x0) − y0·y0;  n0 = t0 < 0 ? 0 : grad(perm[ii + perm[jj]], x0, y0)·((t0·t0)·(t0·t0))
t1 = (0.5 − x1·x1) − y1·y1;  n1 = t1 < 0 ? 0 : grad(perm[ii + i1 + perm[jj + j1]], x1, y1)·(t1⁴)
t2 = (0.5 − x2·x2) − y2·y2;  n2 = t2 < 0 ? 0 : grad(perm[ii + 1 + perm[jj + 1]], x2, y2)·(t2⁴)
return ((n1 + n0) + n2)·45.23065                 // 0x4234ec30
```
- 和 SimplexNoise1234 的 `noise2` 结构相同，**梯度选择不同**：`(h & 0x3c) == 0` 时才是 `(x, y)`，即 `(h & 63) < 4`，约 1/16 的哈希值；原版是 `(h & 7) < 4`。照这个移植，不能换成通用库。

### C3 `snoise3(a, b, c)`（`turbulence` 用）【确】

**分派：** 全局对象 `0x1404e52d8`，在 `0x14000c646` 按 CPUID 选实现。`ecx & 0x980201` 全有（SSE3、SSSE3、SSE4.1、SSE4.2、POPCNT）时用虚表 `0x140488440`，槽 2 `0x1400fbe40` 转调 `FUN_1400fd010`；否则用虚表 `0x140488468`，槽 2 `0x1400fb7d0` 转调 `FUN_1400fc220`。`turbulence` 调槽 2，一次算 4 个粒子，每个通道独立。本机走 SSE4.1 版。SSE2 版用标量截断加修正代替 `roundps`，表、索引方式相同（`gi3` 的写法也相同，抽查过），其余没有逐行核对【推：结果相同】。

**单个通道（`FUN_1400fd010`）：**
```
F3 = 0x3eaaaaab（1/3），G3 = 0x3e2aaaab（1/6），twoG3 = 0x3eaaaaab（单独一个常量，值同 F3）
s  = ((b + c) + a)·F3
i  = floor(a + s);  j = floor(b + s);  k = floor(c + s)      // roundps 向下，cvtps2dq
t  = f32(k + j + i)·G3                                       // 整数先加
x0 = a − (f32(i) − t);  y0 = b − (f32(j) − t);  z0 = c − (f32(k) − t)

// 单形顶点顺序（相等时和 Gustavson 原版不同）
i1 = (y0 <= x0) && (z0 <= x0)
j1 = (x0 <  y0) && (z0 <  y0)
k1 = (x0 <  z0) && (y0 <  z0)
i2 = i1 || (x0 < y0 && z0 <= x0) || (x0 < z0 && y0 <= x0)
j2 = j1 || (y0 < z0 && x0 < y0)  || (z0 <= y0 && y0 <= x0)
k2 = k1 || (z0 <= y0 && x0 < z0) || (y0 < z0 && z0 <= x0)

x1 = (x0 − i1) + G3;     y1 = (y0 − j1) + G3;     z1 = (z0 − k1) + G3
x2 = (x0 − i2) + twoG3;  y2 = (y0 − j2) + twoG3;  z2 = (z0 − k2) + twoG3
x3 = (x0 − 1) + 0.5;     y3 = (y0 − 1) + 0.5;     z3 = (z0 − 1) + 0.5

ii = i & 255;  jj = j & 255;  kk = k & 255
gi0 = permMod12[ii      + perm[jj      + perm[kk]]]
gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]
gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]
gi3 = permMod12[ii + 1  + perm[jj + 1  + perm[kk]]]          // 原版是 perm[kk + 1]

corner(g, x, y, z, t):
    t2 = t·t;  t4 = t2·t2
    return t < 0 ? 0 : ((gz[g]·z + gy[g]·y) + gx[g]·x)·t4
t0 = ((0.6 − x0·x0) − y0·y0) − z0·z0      // 0.6 = 0x3f19999a
…t1、t2、t3 同理
return (((n3 + n2) + n1) + n0)·32
```
- **相等时的顺序：** `x0 < y0` 且 `y0 == z0` 时，这里 `i1 = j1 = k1 = 0`；原版给 `j1 = 1`。连续输入下几乎碰不到，但要照抄。
- **`gi3`：** 两个实现都复用 `perm[kk] + jj`（寄存器 `r10`），访问 `perm[那个值 + 1]`。原版是 `perm[jj + 1 + perm[kk + 1]]`。
- 下标最大 511，表都是 512 项，不需要再取模。

### C4 `sin_ps`（`oscillatesize` 用）【确】
- 和 P4a 的 `oscillate*` 是同一段代码：Julien Pommier `sse_mathfun` 的 `sin_ps`（Cephes 多项式，`4/π`、`DP1/2/3`、余弦三项、正弦三项）。常量和位模式在 JSON 的 `sin_ps` 段。
- P4a 现有实现用 `Math.sin` 取整，没复刻 `sin_ps`。要逐位对齐时照 `sse_mathfun` 移植：`y = x·4/π` 截断取整，`(j+1) & ~1`，`x = ((x + y·DP1) + y·DP2) + y·DP3`，`y1 = ((((p0·z + p1)·z + p2)·z)·z − 0.5·z) + 1`，`y2 = (((s0·z + s1)·z + s2)·z)·x + x`，按 `j & 2` 选、按 `j & 4` 和原符号翻转。

### C5 参数怎么进入噪声

| 模块 | 时间 | 相位 | `scale` | 其他 | `R` |
|---|---|---|---|---|---|
| `turbulentvelocityrandom` | `t = (相位 + T)·timescale`，`timescale` 已乘 `rate` | `uA·prange + phasemin`，音频乘 `prange` | 角度 `(n·π)·scale` | `offset` 加到角度；`forward` 被旋转；`right` 是旋转轴 | 不用 |
| `positionoffsetrandom` | `Ts = timescale·T`，不乘 `rate` | 无 | 坐标 `p·scale` | `octaves`、`directions`、`sign`、`distance` | 不用 |
| `turbulence` | `Ts = T·timescale`，`timescale` 已乘 `rate` | `φ = R·(phasemax − phasemin) + Ts`，同一个 `φ` 加到三轴 | `(p + φ)·scale` | `mask` 选轴并乘输出 | 相位、速度 |

**让结果与 `R` 和新随机数无关的设置：**
- `turbulence`：`phasemin = phasemax`（`φ = Ts`；`phasemin` 本来就不起作用）且 `speedmin = speedmax`。
- `turbulentvelocityrandom`：`phasemin = phasemax` 且 `speedmin = speedmax`。两个 `uA` 照样抽，只推进随机数状态，不影响结果。
- `positionoffsetrandom`：天然确定，不用设。
- `oscillatesize`：`frequencymin = frequencymax`、`phasemin = phasemax` 能消掉 ω 和相位里的 `R`。但幅度是 `R·(smax − smin)/2`，`scalemin = scalemax` 时振荡整个消失（`size *= smin`）。要保留振荡只能留着 `R`：取 `scalemin 0`、`scalemax 1`，相邻两帧之比 `(1 + sin ωτ₁)/(1 + sin ωτ₂)` 与 `R` 无关，或照 P4a 的做法由一帧反推 `R`。
- 发射位置：`sphererandom` 用 `distancemin = distancemax`、`directions` 只留一轴；`boxrandom` 见 A4，符号仍随机。

---

## D. 音频字段（P4e 用）【确】

`FUN_1401c1e20` 解析，结构 24 字节：

| 键 | 缺省 | 偏移 | 说明 |
|---|---|---|---|
| `audioprocessingmode` | 0 | +0 | 0 表示关，执行时只看它是否为 0 |
| `audioprocessingexponent` | 2 | +4 | |
| `audioprocessingbounds` | `"0.8 1.0"` | +8 / +0xc | 字符串 |
| `audioprocessingfrequencystart` | 0 | +0x10 | 钳到 ≤ 15 |
| `audioprocessingfrequencyend` | 1 | +0x14 | 钳到 ≤ 15，比 start 小时两者交换 |

调用解析的模块和运行时的作用对象（取值函数 `FUN_14022a8a0`，内部没读）：

| 模块 | 结构位置 | 作用对象 | 取值点 |
|---|---|---|---|
| `boxrandom`、`sphererandom`、`layerimage` | 发射器 rec+0x50 | 乘发射 `rate` | `0x140237a09` |
| `turbulentvelocityrandom` | p+0x40 | 乘相位范围 `phasemax − phasemin` | `0x14023bdd4` |
| `turbulence` | p+0xd0 | 乘 `speedmin` 和速度范围 | `0x140242998`、`0x140242dac` |
| `vortex` | p+0xc0 | 乘 `speedinner` 和速度范围 | `0x140243246` |
| `vortex_v2` | — | `speedinner` / `speedouter`（sample-gaps §2.2） | `0x140243418`、`0x140243a45` |

`alpharandom`、`positionoffsetrandom`、`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`capvelocity` 不带音频字段。

---

## 未查完 / 未解决

- **`snoise3` 的 SSE2 回退版**只抽查了 `gi3` 的索引写法，顶点顺序和取整没有逐行对比。
- **CRT `sinf` / `cosf` / `powf`**（`FUN_14041a9c0`、`FUN_14041a2e0`、`FUN_14041e350`）没读，和 JS `Math.sin` 取整后可能差 1 ulp。`turbulentvelocityrandom` 的方向要逐位对齐时会受影响。
- **`vortex` 解析期的两个寄存器常量**：`axis` 判零阈值 `xmm11 = 0.001`、`inner == outer` 时的倒数 `xmm15 = 1.0`，都是按 operator 段开头 `0x1401cb184` / `0x1401cb194` 的赋值推的，中间路径没有逐条排除【推】。
- **控制点初值**：cp 0 的矩阵是不是单位阵、平移是不是 0 或 `offset`（影响 `boxrandom` 的 `base`、`vortex` 的中心、`turbulentvelocityrandom` 的 `M`）。rea-p4a 也列为未查完。
- **`sys+0x3f7` bit0** 的完整含义（事件子系统相关），只确认顶层系统一般不置【推】。
  - **已查清（P4f）：** 脚本暂停位，见 rea-p4f-script.md 2.1。
- **音频取值函数 `FUN_14022a8a0`** 没读；`turbulentvelocityrandom` 用音频乘相位范围，语义上奇怪，但代码如此。
- **预热期的场景时间**：`T` 在预热时是否为 0【推】，影响用了 `turbulence` / `turbulentvelocityrandom` / `positionoffsetrandom` 且 `starttime > 0` 的系统。
- **非字符串向量键**的实际后果（崩溃还是读垃圾）没有验证。
- **`colorchange` 的类型 0xc 条目**（`colorn` HSV 路径）留给 `rea-p4b-render.md` 第 7 项。

---

## 建议的确定性实验

除注明外，都用正交场景、`movement` 不加重力、`drag 0`，按 WPE 日志的 `dt` 和场景时间回放。速度能直接读到时（`THICKFORMAT` 的 `a_TexCoordVec4C1`，见 `rea-p4b-render.md`）优先比速度。

### 发射（`proj/p4b-emit`）

| 名 | 参数 | 预测 |
|---|---|---|
| `delay-dur` | `sphererandom` `distance 0`、`directions "1 0 0"`、速度 100；`rate 10`、`delay 0.5`、`duration 1.0` | 第一个 `delay ≤ 0` 的帧起发射；累计 `Σdt ≥ 1.0` 那帧发完后停；数量和每个粒子的出生帧按 A1、A2 逐帧可算 |
| `bit1` | 同上，`rate 200`、`flags 2`、`instantaneous 5` | 第一帧 5 + 1 个，之后每帧正好 1 个；`acc` 只留小数 |
| `periodic` | `flags 4`、周期时长 `min = max = 0.5`、间歇 `min = max = 0.3`、`rate 20`、`instantaneous 3`、`maxtoemitperperiod 4` | 第一帧开周期；每周期 3 个突发 + 至多 4 个连续；计时按帧量化、不补零头（A3） |
| `periodic-full` | 同上，`maxcount 2` | 满容量期间周期计时不走，周期整体推迟 |
| `box-line` | `boxrandom` `directions "1 0 0"`、`distancemin = distancemax = "100 0 0"`、`speedmin = speedmax = 50` | `x0 = ±100`，`v = ±50` 沿 x，符号随机；按 `|x|` 比 |
| `box-corner` | `directions "1 1 0"`、`distancemin "50 50 0"`、`distancemax "100 100 0"` | 统计：没有 `|x| < 50` 或 `|y| < 50` 的粒子（角块，不是盒壳）；速度沿出生方向 |
| `box-zero` | `distancemin = distancemax = "0 0 0"`、`directions "1 0 0"`、速度 50 | 走回退分支：位置 0，`v = ±50` 沿 x |

### 模块（`proj/p4b`）

| 名 | 参数 | 预测 / 核对点 |
|---|---|---|
| `alpharandom` | `min = max = 0.4` | `a0 = 0.4·实例 alpha` |
| `sizechange` | `start 1`、`end 3`、`starttime 0.2`、`endtime 0.8`、寿命 2 | `size(t)` 分段线性 |
| `sizechange-ovr` | 同上加 `sizerandom min = max = 20`、`instanceoverride.size 2` | **按读码是 4 倍**（`size²`），对照只开 `sizerandom` 的 2 倍 |
| `colorchange` | `start "1 0.5 0"`、`end "0 1 1"` | 颜色是 0–1 倍数，不除以 255 |
| `alphachange` | `start 1`、`end 0`、`starttime 0.5` | 前半生命不变，后半线性降 |
| `oscillatesize` | `frequencymin = max = 2`、`phasemin = max = 0`、`scalemin 0`、`scalemax 1` | `size ∝ R·(1 + sin(2·age))/2`；相邻帧之比与 `R` 无关；再测一组 blend |
| `capvelocity` | 初速 300 / 250 / 173，`maxspeed 100` | 第一步比例分别等于 `v·rsqrtps(v²)`（本机可用 .NET 复算）；之后稳定 |
| `vortex-sphere` | `box-line` 出生；`vortex` `distanceinner 100`、`outer 300`、`speedinner 200`、`speedouter 50`、`flags 0` | 切向速度增量 = `(r̂ × z)·spd·k`；**fps 60 与 fps 10 各测一次**，验证用的是 `k` 而不是 `dt` |
| `vortex-cyl` | 同上，`flags 1`，出生点加 z 偏移 | 只按到轴的距离 |
| `turbulence` | `mask "1 0 0"`、`phasemin = phasemax = 0`、`speedmin = speedmax = 100`、`scale 0.01`、`timescale 1` | `Δv.x = snoise3(X, Y, Z)·k·100`，按日志场景时间回放；另测 `phasemin 5、phasemax 5` 应与 0 结果相同（`phasemin` 不起作用） |
| `turbulence-fps` | 同上，fps 10 | 每遍 `k0/2`，两遍之间位置变化影响噪声输入 |
| `turbvel` | `phasemin = phasemax = 0`、`speedmin = speedmax = 100`、其余缺省 | `v0 = 100·(−sin(π·n), cos(π·n), 0)`，`n = snoise1(T_出生)`；同帧出生的粒子方向相同 |
| `posoffset` | `scale 0.001`、`distance 100`、`timescale 1`、`octaves 1` 和 `6` 各一组 | 偏移按 C2 的 fbm 确定，与随机数无关 |

### 最想用实测核对的读码结论
1. `turbulence`、`vortex` 乘的是 `k`（fps < 40 时弱于按 `dt` 的预期）。
2. `sizechange` 与 `sizerandom` 同时存在时尺寸按 `instanceoverride.size²` 变化。
3. `turbulence` 不读 `phasemin`。
4. `turbulentvelocityrandom` 的方向只由出生时刻决定。
5. 周期发射的切换帧、不补零头、满容量时计时冻结。
6. `boxrandom` 是逐轴空心（角块），速度沿出生方向。
7. `snoise2` 的梯度选择 `(h & 0x3c)`、`snoise3` 的 `gi3`：只能通过整条轨迹和移植结果逐帧比来间接验证。
