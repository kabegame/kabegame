> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。只读码，没有实测；实测核对写进 p4-particles-REPORT.md「P4d 语义的实测核对」。本文件覆盖子计划步骤 0a 的模块一份，绳见 `rea-p4d-rope.md`。

# WPE 2.8.42 P4d 映射类、remap 与距离类模块静态逆向

**概括**
- **`mapsequencearoundcontrolpoint`（init 13）：** 覆盖位置。保留出生点到轴线的距离 `L` 和沿轴分量，只把角度换成 `θ = 2π·(bounds.x + seq·(bounds.y − bounds.x))`；轴和两条基向量都乘 `mat3(cp.current)`。速度**加上**切向、径向、轴向三段，每个粒子**无条件抽 3 个 `uA`**。`seq` 先用后加，`step = 1/count`；超过 1 时 repeat 用 `fmodf`，mirror 反射并把 `step` 取反。**`flags` 只写回 JSON、不进记录**，读它的两处拿到的是暂存缓冲区残留值。
- **`mapsequencebetweencontrolpoints`（init 14）：** 位置放到起点到终点的线段上 `t = bounds.x + seq·Δb` 处，保留垂直分量；本地系统按**系统原点**量垂直分量，世界系统按起点量。`w = 1 − (2·seq − 1)²`，`flags` bit0–3 用它缩放垂直偏移、速度、尺寸、加弧，bit4 让 `count` 乘 `instanceoverride.count`，bit5 让周期发射的新周期清零序号。`step = 1/(count − 1)`，repeat 超过 1 时**直接归零**。
- **`remapinitialvalue`（init 15）、`remapvalue`（op 19，blend 0x27）：** 「输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回」。20 个输入、8 个分量、7 个变换、4 个运算、14 个有效输出（枚举共 20 个名字，6 个不写）。两个模块**有好几处不同**：`particlesystemtime` 在 remapvalue 里读的是场景时间 `T`，和 `runtime` 一样；归一化一个用 `divss`、一个用解析期 `rcpps`；正弦一个用 CRT `sinf`、一个用 `sin_ps`；噪声一个是 P4b 的一维 `snoise1`，一个是 FastNoise2 的二维 Simplex（种子取每粒子 `R` 的位）。
- **控制点输出：** 输出 `controlpoint` 时解析期给 `outputcontrolpoint0` 打 `0x10000`，该点不再按 base 更新，只被 remap 改写。remapvalue 每 4 个粒子只写 lane 0，写法还会把 `t.w` 和 `previous` 前两个 float 写坏。remapinitialvalue 的输入 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint` 会把 `cp[inputcontrolpoint0].current.t` 写成 0（疑似 WPE bug）。
- **`maintaindistancetocontrolpoint`（op 11）：** 先把粒子平移 `Δcp = current.t − previous.t`，再在控制点局部坐标 `u = inverse(mat3(cp.current))·d` 里量长度，沿 `d` 拉回半径 `distance`。强度 `s = 1`（`variablestrength = 0`）或 `clamp01(variablestrength·h)`。
- **`maintaindistancebetweencontrolpoints`（op 12）：** 读两个点的 current **和** previous，把粒子从上一帧的线段映射到本帧的线段（比例夹到 [0, 1]，垂直偏移不旋转）。没有别的字段。
- **`reducemovementnearcontrolpoint`（op 13）：** 只改速度，`v *= 1 − clamp01((ri + t·(ro − ri))·h)`，`t = clamp01((L − inner)·rcpps(outer − inner))`。`reductionouter == reductioninner` 时解析期把差存成 1.0，是 bug。
- **`vortex_v2`（op 16，blend 0x25）：** 轴乘 `cp.current` 的 3×3（不重新归一化）。`Δv = (r̂ × a)·spd + P′·c`，`spd` 乘 **`k`**；`c = (L·rsqrt|P′|² − 1)·centerforce/h`，`P′` 是「按当前速度走 `h` 后」的径向偏移。环形模式另加拉力 `sign(ringradius − L)·(1 − t)·h·ringpullforce`。
- **共通：** 读 previous 的两个 maintaindistance 在两遍模式下**每遍都按完整 `Δcp` 跟随**，因为 previous 只在帧尾更新。不可见时 WPE 照常更新控制点；`FUN_14022f6c0` 还会清零 mapsequence 序号、系统时间 `sys+0x3f0`。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。只分析 scratchpad 副本，未运行 WPE。
- 方法：`ignore/p4/rea/wp.asm` 按地址切片读汇编；REA（Ghidra 12.1.4，从 `p4b-mod` 快照的副本打开）反编译缺省值函数和小辅助函数。`FUN_1401c5490` 读汇编。
- 工作文件在 `ignore/p4/rea/p4d-mod/`：
  - 脚本：`pe.py`、`d.py`（按地址打印、注解常量）、`fn.py`（`.pdata` 函数边界）、`jt.py` / `jt2.py`（跳转表）、`rd.py`、`strref.py`、`attrtab.py`、`seq.py`（序号 float32 推演）。
  - 解析段：`parse13.asm`、`parse14.asm`、`parse15.asm`、`parse_op11_13.asm`、`parse_op16.asm`、`parse_op19.asm`、`parser_full.asm`。
  - 执行段：`init_all.asm`、`init13.asm`、`init14.asm`、`init15.asm`、`op11(b).asm`、`op12(b).asm`、`op13(b).asm`、`op16(b).asm`、`op19(b).asm`、`opint.asm`（operator 解释器开头）。
  - 其它：`helpers.asm`（remap 用到的向量小函数）、`noise2_sse4.asm` / `noise2_sse2.asm`（二维 Simplex）、`fbm2_sse4.asm` / `fbm2_sse2.asm`（FBm）、`frame.asm`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。

**命名**
- `rec`：流里一条记录，`rec+0` 是类型字节。initializer 的负载在 `rec+4`，operator 在 `rec+0x10`；下文偏移一律写 `rec+X`（执行段用的偏移，等于解析段偏移加 4 或 0x10）。`×4`：存成 4 份的 SIMD 广播。
- `sys`、`ctx`、`cp[i]`、`current` / `previous` / `base`、`W`、`M` 同 rea-p4c-sim。`C = cp.current.t`。
- `h`、`k`：operator 两个参数，`h` 标量在 `[rbp+0x2008]`、广播在 `[rbp+0xf0]`；`k` 广播在 `[rbp+0x5f0]`、每条 operator 开头装进 `xmm8`（rea-p4b）。`uA`：流 A 随机数（`FUN_1401f87a0(ctx+0x20, ctx+0x1cd0)`）。`R`：每粒子随机数列 `sys+0x338`。
- `T`：`ctx+0x130`（`R+0x140`）场景时间 float。`St`：`sys+0x3f0` 系统时间。
- 列：`pos` `+0x2b0/0x2b8/0x2c0`，`vel` `+0x2c8/0x2d0/0x2d8`，`age` `+0x258`，`life` `+0x260`，`frame` `+0x268`，`size` `+0x270`，`size0` `+0x278`，`rotz` `+0x290`，`angvz` `+0x2a8`，`c` `+0x2f8..`，`a` `+0x310`，`c0` `+0x318..`，`a0` `+0x330`。
- 向量小函数：`FUN_14005f0a0(o,a,b) = a − b`，`FUN_14019d8f0(a,b): a −= b`，`FUN_14019e860(a,b): a += b`，`FUN_14019d540(o,a,b) = a + b`，`FUN_14019d570(o,s,v) = v·s`，`FUN_14005eb40(o,v,s) = v·s`，`FUN_14024f4f0(o,v,s) = v − s`，`FUN_14005f070 = dot = (x·x′ + y·y′) + z·z′`，`FUN_14019e890 = sqrtss((x²+y²)+z²)`，`FUN_14005eb80 = v·(1/sqrtss(…))`，`FUN_140184440 = M·v`（`x = (v.y·m10 + v.x·m00) + v.z·m20`），`FUN_14022a120`：把 `m[3].xyz` 各自广播成 4 份。

---

## 1. mapsequence

### 1.1 `mapsequencearoundcontrolpoint`（init 13）

记录 `FUN_1401d88f0`：类型 0xd，长度 0x5c。解析 `0x1401c9928`–`0x1401ca1cf`；缺省 `FUN_1401bbc90`，**不分正交 / 透视**（函数不读第二参数）。执行 `0x14023c4cf`（`0x14023c4fd` 是取控制点那一句）。

| 字段 | 偏移 | 类型 | 缺省 | 解析 / 钳制 |
|---|---|---|---|---|
| `count` | rec+0x04 存 `step = 1/c` | float | 32（JSON 整数） | `c = count > 1e-4 ? count : 1e-4`，`divss` |
| —（序号 `seq`） | rec+0x08 | float | 0 | 运行状态 |
| `bounds` | rec+0x0c = x，rec+0x10 = y − x | 字符串两个数 | `"0 1"` | 缺的分量 0，不钳制 |
| `speedmin` | rec+0x14..0x1c | 字符串向量 | `"0 0 0"` | 乘 `instanceoverride.speed`（条目 0xa） |
| `speedmax` | rec+0x20..0x28 存 `max − min` | 字符串向量 | `"0 0 0"` | 同上 |
| `axis` | rec+0x2c..0x34 | 字符串向量 | `"0 0 1"` | 见下 `FUN_1401c19e0` |
| —（基 `B1`） | rec+0x38..0x40 | | | |
| —（基 `B2`） | rec+0x44..0x4c | | | |
| `limitbehavior` | rec+0x50 | bool | `"repeat"` | 字符串等于 `"mirror"` 才是 1 |
| `controlpoint` | rec+0x54 | u32 | 0 | `min(·, 7)`，无符号 |
| `flags` | （rec+0x58） | — | 0（只写回 JSON） | **不解析**【确】 |

- **`flags` 不进记录【确】：** 解析段没有读 `"flags"`，`rec+0x58` 也没有写入点（`parse13.asm` 全段），执行段不读它。但有两处读 `rec+0x58`：解析期 `test [p+0x54], 1` 决定是否登记 `count` 覆盖（`0x1401ca184`），`FUN_14022f790` 用 bit1 决定周期复位（1.3）。暂存缓冲区 `ctx+0x1450` 只在渲染器构造时 `_aligned_malloc(0x8000, 16)` 一次（`0x14017cf65`），从不清零，所以这个字的值是上一次解析在同一偏移写下的东西【确】，具体值【未知】。
- 覆盖条目：
  - 粒子 `flags & 0x10` 为 0 时登记条目 0xa：`speedmin = json·speed`，`Δs = json.max·speed − json.min·speed`（`FUN_1401d15a0` case 0xa）。
  - 粒子 `flags & 0x20` 为 0 且 `rec+0x58` bit0 时登记条目 3：`step = 1/max(count·instanceoverride.count, 1e-4)`。
- `def+0x2c = max(·, controlpoint + 1)`。

**基向量 `FUN_1401c19e0(axis, B1, B2)`【确】**（全部 `sqrtss`、`divss` 精确）：
```
a = axis
if a == (0,0,0): a = (0,0,1)                        // 逐分量精确比较 0
else:            a = a·(1/sqrtss((a.x² + a.y²) + a.z²))
if a.x == 0 且 a.y == 0:  B1 = (1,0,0); B2 = (0,1,0)
else:
    t  = (a.y − a.z·0, a.z·0 − a.x, a.x·0 − a.y·0)   // = a × (0,0,1)，乘 0 照写
    B1 = t·(1/|t|)
    B2 = c·(1/|c|),  c = a × t                      // 用未归一化的 t
```
- `axis "0 0 −1"` 也落在第一支，基向量和 `+z` 相同。
- 语料里的 `axis "0 1 0"`：`B1 = (1,0,0)`，`B2 = (0,0,−1)`。

**执行（每个新粒子）【确】**
```
P  = pos                                            // 发射器和前面的 initializer 写的
M  = mat3(cp.current)                               // FUN_14024f2d0 拷 4×4，FUN_1400dd7d0 取 3×3
C  = cp.current.t
A  = M·axis;   B1′ = M·B1;   B2′ = M·B2             // FUN_140184440，乘完不再归一化
d  = P − C
proj = (d.x·A.x + d.y·A.y) + d.z·A.z
r  = d − proj·A
L  = sqrtss((r.x² + r.y²) + r.z²)                   // 出生点到轴的距离，原样保留
θ  = ((rec.Δb·seq) + rec.b0)·2π                      // 2π = 0x40c90fdb
s  = sinf(θ);  c = cosf(θ)                          // CRT：FUN_14041a9c0 / FUN_14041a2e0
dirA = (c·B2′) + (s·B1′)                            // 径向，θ = 0 时等于 B2′
dirB = ((−s)·B2′) + (c·B1′)                         // 切向 = d(dirA)/dθ
u1 = uA;  u2 = uA;  u3 = uA                         // 三个都抽，顺序固定
pos = (dirA·L) + ((proj·A) + C)                     // 覆盖
vel += (((((dirA·smin.y) + u3·(dirA·Δs.y)) + smin.x·dirB) + u2·(Δs.x·dirB)) + smin.z·A) + u1·(Δs.z·A)
```
- 速度逐分量，括号就是加法顺序。**`speed` 三个分量的含义：x 切向、y 径向、z 轴向**，切向是 θ 增大的方向。语料 `speedmin = speedmax = "0 100 0"` 即径向向外 100。
- 缺省轴 z 时 `dirA = (sin θ, cos θ, 0)`：θ = 0 在 +y，随 θ 增大转向 +x。
- **不用 `R`，但每粒子推进流 A 三次**，`speed` 全 0 也照抽。WPE 按时间做种（rea-p4a），抽到的值不可复现，Kabegame 保持抽取次数和顺序即可（phase-4a 的决定）。
- 只改位置、速度，不置列标志，不用 `h` / `k`。

**序号更新（同一粒子用完之后）【确】**
```
seq′ = rec.step + rec.seq;   rec.seq = seq′
if seq′ > 1:                                        // comiss，严格大于
    mirror == 0: rec.seq = fmodf(seq′, 1)           // FUN_14041d0c0（转 double 算，结果精确）
    mirror == 1: rec.seq = 1 − (seq′ − 1);  rec.step = −rec.step
elif seq′ < 0:   rec.seq = −seq′;  rec.step = −rec.step   // 只有 mirror 会出现负 step
```
float32 推演（`seq.py`，前 12 个粒子用的 `seq`）：
- `count 5` repeat：`0 0.2 0.4 0.6 0.8 1 0.20000005 0.4 0.6 0.8 1 0.20000005`。第一圈有 6 个值，`1.0` 不大于 1 所以留着；`bounds "0 1"` 下 `θ = 2π` 和 `θ = 0` 几乎重合（`sinf(6.2831855) ≈ 1.7e−7`）。
- `count 2.2` repeat：`step = 0.45454544`，`0 0.4545 0.9091 0.3636 0.8182 0.2727 0.7273 0.1818 0.6364 0.0909 0.5455 0.99999976`，不成周期。
- `count 2.2` mirror：`0 0.4545 0.9091 0.6364 0.1818 0.2727 0.7273 0.8182 …`。

### 1.2 `mapsequencebetweencontrolpoints`（init 14）

记录 `FUN_1401d8930`：类型 0xe，长度 0x38。解析 `0x1401ca1da`–`0x1401ca6c2`；缺省 `FUN_1401bc080`，不分正交 / 透视。执行 `0x14023ca93`。

| 字段 | 偏移 | 类型 | 缺省 | 解析 / 钳制 |
|---|---|---|---|---|
| `count` | rec+0x04 存 `step = 1/c` | float | 32 | `c = (count − 1) > 1e-4 ? count − 1 : 1e-4` |
| —（`seq`） | rec+0x08 | float | 0 | |
| `bounds` | rec+0x0c、rec+0x10（y − x） | 两个数 | `"0 1"` | |
| `limitbehavior` | rec+0x14 | bool | `"repeat"` | 等于 `"mirror"` |
| `controlpointstart` | rec+0x18 | u32 | 0 | `min(·, 7)` |
| `controlpointend` | rec+0x1c | u32 | 1 | `min(·, 7)` |
| `flags` | rec+0x20 | u32 | 0 | 见下 |
| `arcamount` | rec+0x24 | float | 0.3（`0x3e99999a`） | |
| `arcdirection` | rec+0x28..0x30 | 字符串向量 | `"0 1 0"` | 不归一化，执行时也不乘控制点矩阵 |
| `sizereductionamount` | rec+0x34 | float | 0.9（`0x3f666666`） | |

- `def+0x2c = max(·, start + 1, end + 1)`。
- `flags & 0x10` 且粒子 `flags & 0x20` 为 0 时登记条目 4：`step = 1/max(count·instanceoverride.count − 1, 1e-4)`。
- **`flags` 位【确】：** 1 垂直偏移 ×`w`；2 速度 ×`w`；4 `size0` ×`(1 − srm) + srm·w`；8 加弧；0x10 `count` 乘 `instanceoverride.count`；0x20 周期发射的新周期清零 `seq`（1.3）。语料：15 = 1|2|4|8，19 = 1|2|0x10，23 = 1|2|4|0x10。

**执行【确】**
```
P  = pos
S  = cp[start].current.t;  E = cp[end].current.t
D  = E − S
L  = sqrtss((D.x² + D.y²) + D.z²);  Lc = maxss(L, FLT_MIN)      // 0x00800000；L 为 NaN 时取 FLT_MIN
û  = D / Lc                                                    // divss ×3
if sys.flags & 1: P = P − S                                    // 世界空间才减，本地系统量的是到系统原点
proj = (P.x·û.x + P.y·û.y) + P.z·û.z
r  = P − proj·û
t  = (seq·rec.Δb) + rec.b0
w  = 1 − powf(|seq + seq − 1|, 2)                               // CRT powf（FUN_14041e350），用的是 seq 不是 t
if flags & 1: r = r·w
pos = r + (((t·û)·Lc) + S)                                     // 逐分量
if flags & 8: pos += arcdirection·((w·Lc)·arcamount)
写 pos
if flags & 2: vel *= w
if flags & 4: size0 *= (1 − srm) + srm·w
```
- **本地系统的垂直分量按系统原点量【确】：** `0x14023cb55` 只在 `sys+0x20` bit0 时调 `FUN_14019d8f0`。发射点在系统原点附近、起点不在原点时，本地和世界系统结果不同。
- 不抽随机数，不用 `R`、`h`、`k`。`w` 在两端为 0、中点为 1，只看 `seq`，和 `bounds` 无关。
- `powf(x, 2)`：取 `Math.fround(x·x)`【推：MSVC `powf` 在 double 里算，`x·x` 对 float 输入精确，结果应逐位相同】。

**序号更新【确】：** 同 1.1，但 repeat 超过 1 时 **`seq = 0`**（`0x14023cdcc`），不取模。推演：
- `count 8`：`0 1/7 … 0.85714287 1 0 …`，第 8 个恰好是 1.0，一圈 8 个点含两端。`count 10`、`64` 同样各 10、64 个点。
- `count 4` mirror：`0 0.33333334 0.6666667 1 0.6666666 0.3333333 5.96e−8 0.3333334 …`。

### 1.3 序号状态与清零
- **每实例一份【确】：** 状态在记录里，实例创建时 `FUN_1401c4220` 拷贝整条流（rea-framework）。
- **递增时机：** 每个新粒子跑到这条 initializer 时先用后加，和发射器无关。
- **`FUN_14022f6c0`（系统复位）【确】：** 对类型 13、14 **无条件** `rec+8 = 0`，`step` 的符号不复位（`0x14022f735`–`0x14022f750`）；同时 `sys+0x3f0 = 0`、复位发射器，并递归到子系统。调用点：
  - `FUN_140230650` 不可见且存活数 > 0 时（`0x1402306bc`），同时 `obj+0x770 = 0`；
  - 事件子系统实例创建（`0x14023754c`、`0x14023b07e`，P4e）；
  - `FUN_14024c680`（`0x14024c708`）：先给全部发射器置结束位再复位、清粒子，调用者没追【未知】。
- **`FUN_14022f790`【确】：** 唯一调用点 `0x140237ac1`，即周期发射（发射器 `flags` bit2）进入新周期时。清零条件：
  - 类型 13：`rec+0x58 & 2`，读的是残留值；
  - 类型 14：`flags & 0x20`。
  - 另对 `def+0x64 & 2` 的子系统调 `FUN_14022f6c0`，并清它们发射器的结束位。

---

## 2. remap

### 2.1 记录与字段

| | `remapinitialvalue` | `remapvalue` |
|---|---|---|
| 记录 | `FUN_1401d8970`，类型 0xf，长度 0x68 | `FUN_1401d8c70`，类型 0x13，长度 0x160；有 blend 键时改类型 0x27 |
| 解析 | `0x1401ca6cd`–`0x1401cb052` | `0x1401ce660`–`0x1401cf140` |
| 缺省 | `FUN_1401bc4b0` + `FUN_1401d8040` | `FUN_1401bfbb0` + `FUN_1401d8040` |
| 执行 | `0x14023ce53`（输入跳转表 `0x14023fab8`） | 非 blend `0x140244874`，blend `0x140246ec0`（`0x140244bd4` 在输入 7 里） |

缺省不分正交 / 透视，两模块相同，只有 `input` 不同。

| 字段 | init 偏移 | op 偏移 | 缺省 | 解析 |
|---|---|---|---|---|
| `operation` | rec+0x04 | rec+0x10 | `"multiply"` | `remap` 0 / `multiply` 1 / `add` 2 / `subtract` 3，其它 5（不写）；`FUN_140260fb0` |
| `input` | rec+0x08 | rec+0x14 | init `"maxlifetime"`，op `"lifetimefraction"` | 属性枚举 0–19，未知 21；`FUN_140260f50`，名字表 `0x140484e80` |
| `output` | rec+0x0c | rec+0x18 | `"size"` | 同一个属性枚举 |
| `inputcomponent` | rec+0x10 | rec+0x1c | `"all"` | `all` 0 / `x` 1 / `y` 2 / `z` 3 / `sum` 4 / `average` 5 / `max` 6 / `min` 7，未知 9；`FUN_140261030` |
| `outputcomponent` | rec+0x14 | rec+0x20 | `"all"` | 同上，写出时只认 0–3 |
| `transformfunction` | rec+0x18 | rec+0x24 | `"none"` | `none` 0 / `sine` 1 / `square` 2 / `saw` 3 / `triangle` 4 / `simplexnoise` 5 / `fbmnoise` 6，未知 8；`FUN_140261120` |
| `inputrangemin` | rec+0x1c..0x24 | rec+0x30 / 0x40 / 0x50（各 ×4） | 0 | 字符串读三个数，否则 `asFloat` 铺满三分量 |
| `inputrangemax` | rec+0x28..0x30 存 `max − min` | rec+0x60 / 0x70 / 0x80 存 **`rcpps(max − min)`** | 1 | 差为 0 的分量换成 `FLT_EPSILON`（`0x34000000`），op 再取 `rcpps` |
| `outputrangemin` | rec+0x34..0x3c | rec+0x90 / 0xa0 / 0xb0 | 0 | 同上 |
| `outputrangemax` | rec+0x40..0x48 存 `max − min` | rec+0xc0 / 0xd0 / 0xe0 存 `max − min` | 1 | 不防 0 |
| `inputcontrolpoint0` | rec+0x4c | rec+0xf0 | 0 | `min(·, 7)` |
| `outputcontrolpoint0` | rec+0x50 | rec+0xf4 | 0 | `min(·, 7)` |
| `inputcontrolpoint1` | rec+0x54 | rec+0xf8 | 1 | `min(·, 7)`；**两个执行段都不读**【确】 |
| `outputcontrolpoint1` | rec+0x58 | rec+0xfc | 1 | `min(·, 7)` |
| `transforminputscale` | rec+0x5c | rec+0x100（×4） | 2 | |
| `transformoctaves` | rec+0x60 | rec+0x28 | 3 | `asUInt`，不钳制 |
| `flags` | rec+0x64 | rec+0x2c | 1 | bit0 归一化后夹到 [0, 1]；bit1 输出区间后夹到 [0, 1] |
| —（fbm 归一） | — | rec+0x110 | | `1/Σ_{i<octaves} 0.5^i`，噪声对象槽 3（`0x1400fb740`，`divss`），`octaves ≤ 1` 时为 1 |
| blend 四键 | — | rec+0x120 | | `FUN_1401c2a40`，类型 0x27 |

- **控制点个数【确】：** 输入或输出属于 {7, 8, 16, 17, 18} 时 `def+0x2c = max(·, icp0 + 1, ocp0 + 1)`（`FUN_1401bc480`）；输入或输出是 8 时再 `max(·, icp1 + 1, ocp1 + 1)`（`FUN_1401bc4a0`）。`icp1` 不读也计数。
- **`0x10000`：** 输出是 16（`FUN_1401bc470`）时把 `ocp0` 插进解析器的集合（`FUN_140130b20`），见 2.8。
- **列标志【确】：** remapvalue 输出是 opacity（3）时 `def+0xc |= 0x10`（bit4，`a` 当前值列），输出是 color（13）时 `|= 0x08`（bit3）。remapinitialvalue 不置标志。
- 两个模块都没有 `instanceoverride` 条目、不用音频。

### 2.2 输入

标量输入铺满三分量。op 的 9–12、19 每系统在序言里算一次（`FUN_140229380`：9–12 或 19）。

| # | 名字 | `remapinitialvalue` | `remapvalue` |
|---|---|---|---|
| 0 | `lifetimefraction` | **`frame` 列 `sys+0x268`**：出生时是 0，`randomframe` 时是 `R`【确，疑似 bug】 | `rcpps(life)·age` |
| 1 | `maxlifetime` | `life` | `life` |
| 2 | `size` | `size0` | `size`（当前值） |
| 3 | `opacity` | `a0` | `a`（当前值） |
| 4 | `speed` | `sqrtss((vx² + vy²) + vz²)` | `sqrtps((vy² + vx²) + vz²)` |
| 5 | `rotation` | `rotz` | `rotz` |
| 6 | `angularspeed` | `sys+0x24 & 2` 时 `angvz`，否则 0 | 同 |
| 7 | `distancetocontrolpoint` | `|P − C|`，`C = cp[icp0]` | `sqrtps((dy² + dx²) + dz²)`，`C = cp[icp0]` |
| 8 | `positionbetweentwocontrolpoints` | `A = cp[ocp0]`、`B = cp[ocp1]`（**不是 icp**）；`L = |B − A|`，`L > FLT_EPSILON` 时 `D̂ = (B−A)/L`、`v = dot(P − A, D̂)/L`，否则 0 | `A`、`B` 同；`v = dot(P − A, D)·rcpps(|D|²)`，`|D|² ≤ 0` 时 0；点积顺序 `(Py·Dy + Px·Dx) + Pz·Dz` |
| 9 | `runtime` | `T`（`ctx+0x130`） | `T` |
| 10 | `timeofday` | `ctx+0x140` | `ctx+0x140`（写入点没找到【未知】） |
| 11 | `particlesystemtime` | **`St = sys+0x3f0`** | **`T`，和 `runtime` 相同**（`0x1402448bc`、blend `0x140246f05`）【确】 |
| 12 | `layertime` | `obj+0x770` | `obj+0x770` |
| 13 | `color` | `c0` | `c`（当前值） |
| 14 | `position` | `pos` | `pos` |
| 15 | `velocity` | `vel` | `vel` |
| 16 | `controlpoint` | **把 `cp[icp0].current.t` 写成 (0, 0, 0)**，输入 0 | `cp[icp0].current.t` |
| 17 | `deltatocontrolpoint` | 同上写 0，输入 `0 − P` | `C − P` |
| 18 | `directiontocontrolpoint` | 同上写 0，输入 `normalize(−P)` | `(C − P)·(rsqrtps(|C−P|²) & (0 < |C−P|²))` |
| 19 | `layerorigin` | `W.t`（对象虚函数 +0x80 的第 3 列） | 同 |

- **时间：**
  - `St`：`FUN_1402308a0` 开头 `+= dt′`（`0x1402308c2`，模拟之前），`FUN_14022f6c0` 清零。
  - `obj+0x770`：可见时 `+= dt′`（`0x140230810`），不可见且有粒子时清零。
  - `T`：帧函数写，超过 432000 归零（rea-framework Q2）。
- **初始化器 16–18 写控制点【确】：** `0x14023d31d`、`0x14023d3af`、`0x14023d473` 用 glm 访问器 `FUN_140251ca0` / `FUN_140251c20` 取 `&cp.current[3][i]`，再把输入累加器（此时全 0）存进去。本地系统、无 bit1 的控制点每帧不重算 current，写坏会一直留着。看起来是输出段代码被抄进了输入段。
- 未知输入（21）：init 输入为 0；op 读到上一组残留的栈值。照报不支持。

### 2.3 分量（只在输入编号 > 12 时）【确】
- `x` / `y` / `z`：取该分量铺满。
- `sum`：init `(x + y) + z`，op `(y + x) + z`，两者逐位相同。
- `average`：同上再 `·0.33333334`（`0x3eaaaaab`）。
- `max`：init `maxss(maxss(z, y), x)`，op `maxps(maxps(x, y), z)`；`min` 同理。
- `all`、未知：不变。

### 2.4 归一化【确】
- **init：** 三分量各自 `v_i = (in_i − min_i) / range_i`（`divss`）；`flags & 1` 时 `v = min(1, max(0, v))`（`FUN_1401d8360`）。
- **op 向量输入：** `v_i = (in_i − min_i)·rcpps(range_i)`，倒数是解析期 `rcpps` 的近似值；`flags & 1` 时 `max(0, min(v, 1))`。
- **op 标量输入：** 只用 x 分量的 min 和倒数，`v_x = (x − min.x)·rcp.x`，夹完**铺到 y、z**。init 是先铺再按各自分量算，`inputrange*` 写成分量不同的向量时两者不同。

### 2.5 变换函数【确】（`s = transforminputscale`）

| | `remapinitialvalue` | `remapvalue` |
|---|---|---|
| `sine` | `sinf((v·π)·s − π/2)·0.5 + 0.5`，CRT `sinf`，三分量 | `sin_ps(v·(s·π) − π/2)·0.5 + 0.5`；`s·π` 解析后预乘（`0x14024498e`），`sin_ps` 同 rea-p4b C4 |
| `square` | `t = v·s`（原地）；`roundf(t − floorf(t)) + (t < 0 ? 1 : 0)`，`roundf` 是半数远离零（`0x1402edef0`） | `t = v·s`；`rne(t − trunc(t)) + (t < 0)`，`roundps` 0xb 截断、0x8 偶舍入 |
| `saw` | `(t − floorf(t)) + (v < 0)`，符号看缩放前的 `v` | `(t − trunc(t)) + (v < 0)` |
| `triangle` | `1 − |2·(|t| − floorf(|t|)) − 1|` | `1 − |2·(|t| − trunc(|t|)) − 1|`，`|t| ≥ 0` 时两者相同 |
| `simplexnoise` | `snoise1(v.x·s)·0.5 + 0.5`，`snoise1` 即 rea-p4b C1 `FUN_14027b090`，不用 `R`；输出是向量时 y、z 各自同样算 | `simplex2(seed, v·s, 0)·0.5 + 0.5`（2.9）；种子 x = `R` 的位，y = `R ^ 0x0b3924ad`，z = `R ^ 0x493a8e83`；y、z 只在输出是向量时算 |
| `fbmnoise` | `fbm1(v.x)·0.5 + 0.5`：频率从 `s` 起每倍频 ×2，振幅从 1 起每倍频 ×0.5，共 `octaves` 次，`Σ a_i·snoise1(f_i·v)/Σ a_i`（`FUN_14027b4b0`，内联 C1）；`octaves = 0` 时 0/0 | `fbm2(seed, v·s, 0)·0.5 + 0.5`（2.9），种子同上；`octaves ≤ 1` 只算一层 |
| `none` | 不变 | 不变 |

- 负输入才会看出 `floor` 与 `trunc`、两种舍入的差别。`square`、`saw` 对负 `t` 会得到大于 1 的值，init 最大到 2。
- `sine` 的 `s` 是半周期数（`s = 2` 时输入 0→1 走一整个周期），`square`、`saw`、`triangle` 的 `s` 是整周期数。

### 2.6 输出区间【确】
`o_i = range_i·v_i + min_i`；`flags & 2` 时夹到 [0, 1]。init 三分量都算；op 只在输出是向量（`> 12`）时算 y、z。

### 2.7 运算与输出【确】
- **运算** `op(old, o)`：`remap` → `o`；`multiply` → `o·old`；`add` → `o + old`；`subtract` → `old − o`；其它值不写。
- **blend 版（类型 0x27）：** `new = (op(old, o) − old)·b + old`。例如 subtract 是 `((old − o) − old)·b + old`。`b` 由 `FUN_14022a530`（`0x140247fe1`）每 4 个粒子算一次，公式同 rea-p4b「基础补充」。
- 标量输出用 `o.x`。

| # | 输出 | `remapinitialvalue` 写 | `remapvalue` 写 |
|---|---|---|---|
| 1 | `maxlifetime` | `life` | `life`（不在每遍开头重置） |
| 2 | `size` | `size0` | `size`（每遍开头从 `size0` 复制） |
| 3 | `opacity` | `a0` | `a`（每遍重置） |
| 4 | `speed` | `L = sqrtss(|v|²)`；`s = op(L, o.x)`；`L ≠ 0` 时 `s /= L`（`divss`）；`vel *= s` | `L = sqrtps`；`s = op(L, o.x)`；`L > 0` 时 `s = rcpps(L)·s`；`vel *= s` |
| 5 | `rotation` | `rotz` | `rotz`（持久） |
| 6 | `angularspeed` | `angvz`（要 bit1） | 同 |
| 7 | `distancetocontrolpoint` | `C = cp[ocp0]`；`d = P − C`；`L = |d|`，`L ≠ 0` 时 `d /= L`；`P = C + d·op(L, o.x)` | `q = rsqrtps(|d|²)`，`L = q·|d|²`，`d̂ = d·(q & (L ≠ 0))`；`P = d̂·op(L, o.x) + C` |
| 8 | `positionbetweentwocontrolpoints` | `A = cp[ocp0]`、`B = cp[ocp1]`；`D̂ = D/L`（`L > FLT_EPSILON`）；`tp = (P−A)·D̂`，`perp = (P−A) − D̂·tp`，`frac = tp/L`；`P = (A + perp) + (D̂·op(frac, o.x))·L` | `q = rsqrtps(|D|²)`、`L = q·|D|²`、`D̂ = D·(q & mask)`；`tp`、`perp` 同；`frac = (tp·q) & mask`；`P = ((op(frac, o.x)·L)·D̂ + perp) + A` |
| 9–12 | `runtime` … `layertime` | 不写 | 不写 |
| 13 | `color` | `c0`，按 `outputcomponent` 写 all / x / y / z，其它值不写 | `c`（当前值） |
| 14 | `position` | `pos`，按分量 | 同 |
| 15 | `velocity` | `vel`，按分量 | 同 |
| 16 | `controlpoint` | `cp[ocp0].current.t` 逐分量 op 后写回 xyz，每个新粒子一次 | 同样逐分量 op，但见 2.8 |
| 17 | `deltatocontrolpoint` | `Δ = C − P` 按分量 op；`P = C − Δ′` | 同 |
| 18 | `directiontocontrolpoint` | `Δ = C − P`，`L = |Δ|`，`L > FLT_EPSILON` 时 `n = Δ/L`；按分量 op；`P = C − normalize(n′)·L` | `n = Δ·(rsqrtps & (0 < L))`；op；`P = C − n′·((rsqrtps(|n′|²) & mask)·L)` |
| 0、19 | `lifetimefraction`、`layerorigin` | 不写 | 不写 |

- **两遍模式：** remapvalue 不用 `h`、`k`，两遍都完整执行。`size`、`opacity`、`color` 每遍从初始值重算，结果不变；其余输出列是持久的，`multiply` / `add` / `subtract` 在两遍模式下一帧叠两次。

### 2.8 控制点输出与 `0x10000`【确】
- **打标：** 解析完控制点数组后，对集合里 `< 8` 的下标 `flags |= 0x10000`（`0x1401d0860`–`0x1401d087e`，rea-p4c-sim 1.2）。集合只由「输出 = controlpoint」插入，17、18 不插。
- **效果：** `FUN_14022e3e0` 整点跳过（不按 base / `M` 重算、不跟指针、不走父控制点），`FUN_14022bd40` 不应用 `instanceoverride`（`f & 0x10005`）。初值仍是加载时的 `base`（单位阵 + `offset`），帧尾照常 `previous ← current`。
- **init 写法：** 每个新粒子按出生顺序写一次：`remap` 时本帧最后出生的粒子胜出，`add` 时累加。
- **op 写法（`0x1402469db`–`0x140246a4d`）：** 每 4 个槽一组（含死槽），读 C、按分量 op，然后把 x、y、z 各自 `shufps` 成 4 份，分别 `movups` 到 `&t.x`、`&t.y`、`&t.z`。结果：
  - 只有 **lane 0**（每组第一个槽）的值生效，`remap` 时最后一组的 lane 0 胜出，`add` 时每组累加一次；
  - `current[3][3]`（`t.w`）被写成 z；
  - `previous[0][0]`、`[0][1]` 被写成 z，帧尾 previous 整体覆盖后消失，`t.w` 留着。

### 2.9 remapvalue 的噪声：FastNoise2 Simplex 2D 与 FBm【确】
全局噪声对象 `0x1404e52d8` 在启动时按 CPUID 建（`0x14000c646`，SSE4.1 版虚表 `0x140488440`、SSE2 版 `0x140488468`），字段 `+0x8 = 0.5`（gain）、`+0xc = 0`（weighted strength）、`+0x10 = 2.0`（lacunarity），之后无写入点。槽 1 是二维 Simplex，槽 4 是 FBm，槽 3 算 FBm 的归一系数。代码与 FastNoise2 的 `Simplex` 2D、`FractalFBm`、`HashPrimes`、`GetGradientDot` 逐项对上，编译时没有 FMA。

```
simplex2(seed:i32, x, y):                          // 槽 1：0x1400fbe90（SSE4.1）/ 0x1400fb820（SSE2）
    F2 = 0x3ebb67ae; G2 = 0x3e58658c; G2m = 0xbf13cd3a (2·G2 − 1)
    PX = 501125321 (0x1dde90c9); PY = 1136930381 (0x43c42e4d)
    f  = (x + y)·F2
    xs = floor(x + f);  ys = floor(y + f)          // SSE4.1 roundps 向下；SSE2 截断再修正
    i  = int(xs)·PX;  j = int(ys)·PY               // 32 位回绕乘
    g  = (ys + xs)·G2
    x0 = x − (xs − g);  y0 = y − (ys − g)
    m  = y0 < x0
    x1 = (x0 − (m ? 1 : 0)) + G2;  y1 = (y0 − (m ? 0 : 1)) + G2
    x2 = x0 + G2m;  y2 = y0 + G2m
    tK = max(0, (0.5 − yK·yK) − xK·xK);  tK = tK²;  tK = tK²     // K = 0,1,2
    hash(a, b) = H = ((b ^ a) ^ seed)·0x27d4eb2d;  H = (H >> 15 算术) ^ H
    h0 = hash(i, j);  h1 = hash(i + (m ? PX : 0), j + (m ? 0 : PY));  h2 = hash(i + PX, j + PY)
    grad(H, X, Y):
        X′ = X ^ (H << 31);  Y′ = Y ^ ((H >> 1) << 31)            // 翻符号位
        bit2 = H 的第 2 位（H << 29 的符号位）
        a = bit2 ? Y′ : X′;  b = bit2 ? X′ : Y′
        return 2.4142137·a + b                                   // 0x401a827a = 1 + √2，先乘后加
    return 38.2836876·((grad(h0,x0,y0)·t0) + ((grad(h1,x1,y1)·t1) + (grad(h2,x2,y2)·t2)))   // 0x4219227f

fbm2(seed, x, y, octaves, bounding):               // 槽 4：0x1400fbc70 / 0x1400fb570
    n = simplex2(seed, x, y);  amp = bounding;  sum = n·amp
    for i in 1 .. octaves − 1:
        x = x·2;  y = y·2;  seed = seed + 1        // psubd 全 1
        amp = (amp·((((n + 1)·0.5) − 1)·0 + 1))·0.5   // weighted strength 0：乘 1（n 非有限时是 NaN）
        n = simplex2(seed, x, y)
        sum = sum + n·amp
    return sum
bounding = 1/(1 + 0.5 + … 共 octaves 项)            // 槽 3，divss；octaves ≤ 1 时为 1
```
- remapvalue 的调用：`x = v·s`，`y = 0`（`xmm10` 在序言清零），种子 `R` 的位（`movdqu` 读 `sys+0x338`）。
- SSE2 版的取整与整数乘写法不同，`|x| < 2³¹` 时结果应相同【推：没逐行对】。

---

## 3. 距离类

### 3.1 `maintaindistancetocontrolpoint`（op 11，blend 0x21）

记录 `FUN_1401d8b70`：类型 0xb，长度 0x70。解析 `0x1401ccdc5`–`0x1401ccf6b`，缺省 `FUN_1401be2a0`。执行 `0x14024197a`，blend `0x140241ccf`。

| 字段 | 偏移 | 类型 | 缺省 正交 / 透视 | 说明 |
|---|---|---|---|---|
| `distance` | rec+0x10 | float | 200 / 1 | 标量，执行时广播；无覆盖项 |
| `variablestrength` | rec+0x14 | float | 0 | 精确等于 0 时硬约束 |
| blend 四键 | rec+0x20 | | | 类型 0x21 |
| `controlpoint` | rec+0x60 | u32 | 0 | `min(·, 7)`，`def+0x2c = max(·, cp + 1)` |

**执行【确】**
```
s  = (variablestrength == 0) ? 1 : clamp01(variablestrength·h)   // h 标量 [rbp+0x2008]；FUN_1401d8df0，NaN → 0
C  = cp.current.t
Δ  = cp.current.t − cp.previous.t                                // FUN_14005f0a0(当前, 上一帧)，0x140241a3f
T  = inverse(mat3(cp.current))                                   // FUN_140228b00：glm，1/det（divss）后乘伴随阵
每 4 个槽（0 .. 高水位，死槽也算）：
    p′ = Δ + p
    d  = p′ − C
    u_k = (d.y·T[1][k] + d.x·T[0][k]) + d.z·T[2][k]             // T[i] 第 i 列（glm::column）
    q  = rsqrtps((u.x² + u.y²) + u.z²)
    f  = (q·distance − 1)·s                [blend：f·b]
    p  = f·d + p′
```
- **`M` 的来源（sample-gaps §2.3 未追的项）：** `M = inverse(mat3(cp.current))`，只在控制点有旋转、缩放时起作用：`controlpointangle*` 的旋转不改变 `|u|`；世界系统里含 `W` 的缩放时球变成椭球。修正沿原空间的 `d`，所以落点在椭球面上。
- **`Δcp` 的方向（未追的另一项）：** current − previous，粒子跟着控制点平移。
- **每遍都平移完整的 `Δ`：** previous 只在帧尾 `0x140237798` 更新，在两遍 operator（`0x140237784`、`0x140237793`）之后，所以两遍模式下一帧平移 `2·Δ`【确：代码结构；效果待实测】。
- blend 只乘修正量 `f`，平移 `Δ` 不受 `b` 影响。
- 近似：`rsqrtps`，壳半径有约 3.7e−4 的相对误差。

### 3.2 `maintaindistancebetweencontrolpoints`（op 12，blend 0x22）

记录 `FUN_1401d8b90`：类型 0xc，长度 0x60。解析 `0x1401ccf7b`–`0x1401cd199`，缺省 `FUN_1401be5d0`。执行 `0x140242058`，blend `0x140242352`。

| 字段 | 偏移 | 缺省 | 说明 |
|---|---|---|---|
| blend 四键 | rec+0x10 | | 类型 0x22 |
| `controlpointstart` | rec+0x50 | 0 | `min(·, 7)` |
| `controlpointend` | rec+0x54 | 1 | `min(·, 7)` |

没有别的字段，语料 6 个全用缺省。`def+0x2c = max(·, start + 1, end + 1)`。

**执行【确】**
```
A  = cp[start].current.t;   B  = cp[end].current.t
Ap = cp[start].previous.t;  Bp = cp[end].previous.t
D  = B − A;  Dp = Bp − Ap;  ΔA = A − Ap
n  = (D.y² + D.x²) + D.z²;   np = (Dp.y² + Dp.x²) + Dp.z²
if n ≤ 2⁻⁴⁶ 或 np ≤ 2⁻⁴⁶: 整条跳过                    // 0x28800000，0x1402421ff
q  = rsqrtps(n);   L = q·n;   D̂ = D·q
qp = rsqrtps(np);  D̂p = Dp·qp
每 4 个槽：
    Q  = P − Ap
    t  = (Q.y·D̂p.y + Q.x·D̂p.x) + Q.z·D̂p.z
    s  = clamp01(t·qp)·L
    P_c = ((s·D̂_c − t·D̂p_c) + ΔA_c) + P_c              [blend：((s·D̂_c − t·D̂p_c) + ΔA_c)·b + P_c]
```
- 含义：`P = Ap + t·D̂p + perp` 映射成 `A + s·D̂ + perp`，比例夹到 [0, 1]，垂直偏移 `perp` 原样带过、不随线段旋转。越过两端的粒子沿线段方向被拉回端点所在的平面。
- **两个点的 current 和 previous 都读**，rea-p4c-sim 第 3 节表里「一个点的 previous」要更正。
- 两个控制点重合时整条不执行：缺省 0、1 号点都没有 `offset` 时什么也不做。
- 两遍模式：每遍都从 previous 线段映射一次，等于平移两次【确：代码结构】。

### 3.3 `reducemovementnearcontrolpoint`（op 13，blend 0x23）

记录 `FUN_1401d8bb0`：类型 0xd，长度 0xa0。解析 `0x1401cd1a9`–`0x1401cd40c`，缺省 `FUN_1401be810`。执行 `0x14024268f`，blend `0x1402427b8`。

| 字段 | 偏移 | 缺省 正交 / 透视 | 解析 |
|---|---|---|---|
| blend 四键 | rec+0x10 | | 类型 0x23 |
| `distanceinner` | rec+0x50（×4） | 100 / 0.5 | |
| `distanceouter` | rec+0x60 存 `rcpps(outer − inner)` | 350 / 1 | 相等时存 1.0（`xmm15`，`0x1401cb184` 起恒为 1.0） |
| `reductioninner` | rec+0x70（×4） | 100 | |
| `reductionouter` | rec+0x80 存 `outer − inner` | 0 | **相等时存 1.0**（`0x1401cd3d1`），应为 0，bug |
| `controlpoint` | rec+0x90 | 0 | `min(·, 7)` |

**执行【确】**
```
C = cp.current.t
每 4 个槽：
    n = ((y − Cy)² + (x − Cx)²) + (z − Cz)²
    L = rsqrtps(n)·n
    t = max(0, min((L − inner)·rcp, 1))
    r = t·Δred + rinner
    f = max(0, min(r·h, 1))            [blend：f·b]      // h 广播 [rbp+0xf0]
    vel *= 1 − f
```
- 只改速度，用 `h`。语料（`inner 20`、`outer 50`、`rinner 1000`、`router` 缺省 0）：60 fps 时 20 以内 `1000·h ≈ 16.7`，速度清零；20–50 线性减弱，约 48 以外才不再全停。两遍模式每遍乘 `(1 − f(h/2))`。
- `rinner == router` 时 `r = rinner + t`，不是常数。
- `n = 0` 时 `rsqrtps(0)·0` 是 NaN，`minps` 取第二个操作数得 1，`t = 1`。

### 3.4 `inheritcontrolpointvelocity`（init 8）
rea-p4c-sim 第 3 节已记：`(cur.t − prev.t)/ctx+0x150`，世界系统且无 bit1 时再变换一次，再乘 `M`。本节不细读。

---

## 4. `vortex_v2`（op 16，blend 0x25）

记录 `FUN_1401d8c10`：类型 0x10，长度 0x120。解析 `0x1401cde39`–`0x1401ce3eb`，缺省 `FUN_1401bf2d0`（复核同 sample-gaps）。执行 `0x1402433ea`，blend `0x140243a17`。

| 字段 | 偏移 | 缺省 正交 / 透视 | 解析 |
|---|---|---|---|
| `distanceinner`；环形时 `ringwidth` | rec+0x10（×4） | 500 / 1；`ringwidth` 50 / 0.2 | `flags & 4` 时存 `ringwidth` |
| `distanceouter`；环形时 `ringpulldistance` | rec+0x20 存 `rcpps(outer − inner)` 或 `rcpps(ringpulldistance)` | 650 / 2；`ringpulldistance` 50 / 0.25 | 相等或为 0 时存 1.0 |
| `speedinner` | rec+0x30（×4） | 2500 / 1 | 乘 `instanceoverride.speed`（条目 7） |
| `speedouter` | rec+0x40 存 `outer − inner` | 0 / 0 | 同上 |
| `flags` bit0 掩码 | rec+0x50（×4） | | 全 1 或 0 |
| `centerforce` | rec+0x60（×4） | 1 / 1 | 只在 `flags & 2` 时读，否则 0 |
| `ringradius` | rec+0x70 | 300 / 1 | |
| `ringpullforce` | rec+0x80 | 10 / 0.05 | |
| `axis` | rec+0x90..0x98 | `"0 0 1"` | `(x² + y²) + z² < 0.001` 时取 (0,0,1)，否则精确归一化 |
| blend 四键 | rec+0xa0 | | 类型 0x25 |
| `controlpoint` | rec+0xe0 | 0 | `min(·, 7)` |
| `audioprocessing*` | rec+0xf0 | | `FUN_1401c1e20`；`mode ≠ 0` 时乘两个速度 |
| `flags` | rec+0x110 | 0 | **只存低 8 位**；bit0 柱形，bit1 `centerforce`，bit2 环形 |

- 条目 7（粒子 `flags & 0x10` 为 0 时登记）：`speedinner·o` 与 `speedouter·o − speedinner·o`，`o = instanceoverride.speed`。
- 环形模式不读 `distanceinner` / `distanceouter`，两个槽位被 `ringwidth`、`ringpulldistance` 占用。

**执行【确】**
```
am = audio.mode ≠ 0 ? FUN_14022a8a0(…) : 1
SI = (speedinner·am)·k;   DS = (Δspeed·am)·k        // k = xmm8（本条 operator 的 k 广播）
CF = (1/h)·centerforce                               // divps，精确
C  = cp.current.t
a  = (cp.current · vec4(axis, 0)).xyz                // FUN_14024f080：(c0·x + c1·y) + (c2·z + c3·0)，不重新归一化
mask = flags bit0 ? 全 1 : 0
每 4 个槽：
    d = p − C
    proj = ((d.y·a.y + d.x·a.x) + d.z·a.z) & mask     // bit0 = 0 时 proj = 0：按到控制点的距离（球形）
    r = d − proj·a;  n = (r.y² + r.x²) + r.z²
    q = rsqrtps(n);  r̂ = r·q;  L = q·n
    P′ = ((vel·h + p) − C) − proj·a                   // 逐分量；按当前速度走 h 后的径向偏移
    c0 = (rsqrtps((P′.y² + P′.x²) + P′.z²)·L − 1)·CF
    T = r̂ × a = (r̂y·az − r̂z·ay, r̂z·ax − r̂x·az, r̂x·ay − r̂y·ax)
  非环形（flags bit2 = 0，0x140243818 起）：
    t = clamp01((L − inner)·rcpRange)
    spd = t·DS + SI                     [blend：spd·b]
    c = c0                              [blend：c·b]
  环形（flags bit2，0x1402435a1 起）：
    e = ringradius − L
    t = clamp01((|e| − ringwidth)·rcp(ringpulldistance))
    spd = t·DS + SI
    w = 1 − t;  m = (w ≠ 1) ? w : 0                    // 环带内（t = 0）为 0
    pull = (m 按位或 e 的符号位)·(h·ringpullforce)      // = sign(e)·m·h·pullforce
    c = c0 + pull
    vel = (T·spd + P′·c) + vel                         // 逐分量：(T_x·spd + P′_x·c) + v_x
```
- **sample-gaps §2.2 未确认的三项：**
  - `xmm8` 是本条 operator 的 `k`，`[rbp+0xf0]` 是 `h`。`instanceoverride.speed` 在加载 / 重算时经条目 7 写进两个速度，音频（P4e）也是乘两个速度。
  - 切向项乘 `k`（不是 `h` 或 `dt`），方向是 **`r̂ × a`**（sample-gaps 写的 `a × r̂` 符号反了）。缺省轴 z 时 `r̂ = (1,0,0)` 得 `T = (0, −1, 0)`。
  - `centerforce` 的系数是 `centerforce/h`，作用在预测偏移 `P′` 上：`cf = 1` 时走完下一步 `h` 后径向距离回到 `L`。
- **轴经控制点旋转【确】：** 乘的是 `cp.current` 的 3×3（含缩放），回答 rea-p4c-sim 第 3 节的【推】。kabegame-sample 用 `controlpointangle1` 关键帧转轴，就靠这一条。
- 环形拉力乘的是未归一化的 `P′`，与到轴的距离成正比；环带边界处 `m` 从 0 跳到约 1，不连续。
- `n = 0`（粒子在轴上）时 `r̂` 为 NaN【推】。
- 语料（kabegame-sample）：`flags 2`、`inner 0`、`outer 1`、`speedinner 0`、`speedouter 2500`，非环形、球形；`L ≥ 1` 时 `spd = 2500·k`，`ring*` 不起作用。

---

## 5. 共通

### 5.1 `h` / `k` 与两遍模式

| 模块 | `h` | `k` | 每遍都做的事 |
|---|---|---|---|
| `maintaindistancetocontrolpoint` | `s = clamp01(vs·h)` | — | 平移完整 `Δcp`、拉回 |
| `maintaindistancebetweencontrolpoints` | — | — | 从 previous 线段映射到 current 线段 |
| `reducemovementnearcontrolpoint` | `f = clamp01(r·h)` | — | `vel *= 1 − f` |
| `vortex_v2` | `P′` 预测、`cf/h`、环形 `h·pullforce` | 切向 `spd·k` | 加速度 |
| `remapvalue` | — | — | 整条管线；持久输出列的乘加减叠两次 |
| blend 变体 | `b` 由 `rcpps(life)·age` 和四个 blend 键算（`FUN_14022a530`） | | 年龄在两遍之前更新，两遍 `b` 相同 |

- 帧内顺序【确】：控制点更新 `0x1402376fe` → 发射 `0x14023771b` → 一遍或两遍 operator（`0x140237784`、`0x140237793`）→ `previous ← current`（`0x140237798`）。两遍之间没有改控制点。
- initializer（mapsequence*、remapinitialvalue）每粒子出生时跑一次，不受两遍模式影响。

### 5.2 世界空间（系统 `flags` bit0）
- 这些模块里只有 `mapsequencebetweencontrolpoints` 有世界空间分支（`P −= S`，1.2）。
- 其余模块都直接用 `cp.current`：世界系统里它是 `W·base`（rea-p4c-sim 1.5），所以
  - mapsequencearound 的基向量、vortex_v2 的轴、maintaindistanceto 的 `T` 都带上 `W` 的旋转和缩放；
  - 对象移动时世界系统的控制点会动，`Δcp ≠ 0`，maintaindistance* 让粒子跟着走。本地系统的控制点通常不动（除 bit1、`instanceoverride`、关键帧）。
- remap 的 `layerorigin` 读的是 `W.t`，与系统空间无关。

### 5.3 对象不可见
- `FUN_140230650` 不可见且有存活粒子时调 `FUN_14022f6c0`，然后清空粒子：
  - mapsequence 的 `seq` 归零，`step` 符号保留；
  - `St = 0`，`obj+0x770 = 0`；
  - 发射器复位。
- 之后每帧照常模拟【推：依据 rea-framework Q3、rea-p4c-sim 5.6，`FUN_1402308a0` 不看可见性】：
  - 控制点更新，previous 跟着 current 走；
  - `St` 继续累加，`obj+0x770` 不累加（只在可见时加）。
- 读 previous 的模块重新可见时 `Δcp` 是一帧的量，不会跳。Kabegame 现在 `suspend` 时不更新控制点，重新可见第一帧的 `Δcp` 是整段不可见期间的位移，maintaindistance* 会把粒子一次拽过去，所以计划步骤 5 要补上。

---

## 未查完 / 未解决

- **`mapsequencearoundcontrolpoint` 的 `rec+0x58`：** 残留值【未知】，影响两处：`count` 是否乘 `instanceoverride.count`，周期发射的新周期是否清零 `seq`。建议实现按 0 处理；场景同时用到周期发射或 `instanceoverride.count` 时照报。
- **`timeofday`（`ctx+0x140` = `R+0x150`）** 的写入点没找到【未知】。
- **`FUN_14024c680`** 的调用者（什么事件触发系统复位）没追【未知】。
- **CRT `sinf` / `cosf` / `powf`**（`FUN_14041a9c0`、`FUN_14041a2e0`、`FUN_14041e350`）没读，和 JS 可能差 1 ulp。mapsequencearound 的角度、remapinitialvalue 的 sine 受影响。
- **FastNoise2 SSE2 版**（`0x1400fb820`、`0x1400fb570`）没和 SSE4.1 版逐行对【推：结果相同】。
- **remapinitialvalue 输入 16–18 写控制点、输入 0 读 `frame` 列：** 读码确定，像是 WPE 的 bug，需要实测确认（见实验 `ri-cpbug`）。
- **remapvalue 未知输入（21）：** 读到栈上残留，未细查。
- **预热期 `St` 是否累加：** 预热走 `FUN_14022f430`，有没有经过 `FUN_1402308a0` 没追【未知】。影响 `starttime > 0` 且 remapinitialvalue 用 `particlesystemtime` 的系统。
- **两遍模式下 maintaindistance* 跟随两倍：** 代码结构确定，效果要实测。

---

## 建议的确定性实验

骨架同 `ignore/p4/gen_b.py`：
- 正交 1920×1080；对象 `origin "960 540 0"`、无旋转缩放；
- `movement` 无重力、`drag 0`；
- 发射用 `sphererandom` `distancemin = distancemax`、`directions "1 0 0"`、`sign "1 0 0"`，速度 0 或 `velocityrandom min = max`，所有随机范围 min = max；
- `maxcount` 小、`rate` 低，按 `colorrandom` 认系统；
- 控制点要动时用 `flags 2` 的控制点，再用脚本移动对象（P4c 世界空间工程的做法，`angles` 是度）。

下文「出生点」是场景坐标，`O = (960, 540)`。

### `proj/p4d-map`

| 名 | 设置 | 验证 | 判读 |
|---|---|---|---|
| `ma-basic` | 发射半径 100，`mapsequencearoundcontrolpoint` `count 5`、`speed* "0 0 0"`，`rate 2`，寿命 10 | `θ = 2π·seq`、`θ = 0` 在 +y、顺时针（`dirA = (sinθ, cosθ)`）、半径取出生点到轴的距离 | 出生点依次 `O + 100·(sin 2πs, cos 2πs)`，`s` 取 1.1 的推演序列；第 6 个与第 1 个重合 |
| `ma-r` | 同上，发射半径 40 与 160 两个系统 | `L` 原样保留 | 两系统半径各 40、160，角度序列相同 |
| `ma-speed` | `speedmin = speedmax = "10 100 5"` | x 切向、y 径向、z 轴向；速度是**加**到发射速度上 | 首帧位移 `(10·dirB + 100·dirA)·dt` |
| `ma-22` | `count 2.2` repeat 与 mirror 各一个 | `step = 1/2.2f`、`fmodf`、mirror 反射 | 角度序列对照 1.1 推演 |
| `ma-bounds` | `bounds "0.25 0.5"` | 角度落在 [90°, 180°] | `θ = 2π(0.25 + 0.25·seq)` |
| `ma-axis` | `axis "0 1 0"` | 基 `B1 = (1,0,0)`、`B2 = (0,0,−1)` | 屏幕 x 偏移 `100·sinθ`，y 不变 |
| `ma-cp` | 控制点 1 `offset "300 0 0"`，`instanceoverride.controlpointangle1 "0 0 0.5236"`；发射器和模块都用 `controlpoint 1` | 中心是 `cp.t`，基向量乘 `mat3(cp)` | 圆心 `O + (300, 0)`、半径 100，`θ = 0` 的点从 +y 逆时针转 30°（偏向 −x） |
| `ma-hide` | 脚本 3 s 时 `visible = false`、4 s 时 `true` | `FUN_14022f6c0` 清零 `seq` | 重新可见后第一个粒子在 `θ = 0` |
| `mb-basic` | 控制点 0 `offset "−300 0 0"`、1 `offset "300 0 0"`，发射半径 0，`mapsequencebetweencontrolpoints` `count 5`、`flags 0` | `step = 1/(count − 1)`、repeat 归零 | 出生 x 依次 −300、−150、0、150、300、−300… |
| `mb-perp` | 控制点 0、1 改成 `offset "−300 −200 0"`、`"300 −200 0"`，发射器 `origin "0 100 0"`；本地系统与世界系统各一个 | 本地按系统原点量垂直分量，世界按起点量 | 线段在 y = −200；本地组出生点 y = −100（偏 +100），世界组 y = +100（偏 +300） |
| `mb-flags` | `count 9`、发射点偏 +100 y，`flags` 取 1、2、4、8 各一组，`arcamount 0.3` | `w = 1 − (2seq − 1)²` 与四个位 | `flags 1` 偏移 `100·w`；`flags 2` 速度 ×`w`；`flags 4` 尺寸 ×`(0.1 + 0.9w)`；`flags 8` y 加 `w·600·0.3` |
| `mb-mirror` | `count 4`、mirror | 反射序列与 `step` 取反 | 对照 1.2 推演 |
| `mb-period` | 发射器 `flags 4`，周期、间歇 min = max，`flags 32` 与 `flags 0` 各一个 | bit5 在新周期清零 | 开 bit5 的组每周期第一个粒子回到起点 |

### `proj/p4d-remap`

| 名 | 设置 | 验证 | 判读 |
|---|---|---|---|
| `rv-time` | remapvalue `input particlesystemtime`、`inputrange 0..10`、`flags 0`、`sine`、`scale 2`、`output opacity`、`multiply`；对象 `instanceoverride.rate 2`；同场景另一个系统改 `input runtime` | op 的 `particlesystemtime` 就是 `T` | 两系统 alpha 曲线完全相同，周期 10 s 跟场景时间，不受 `rate 2` 影响 |
| `ri-time` | remapinitialvalue 同样设置，`output size` | init 读 `St = sys+0x3f0` | 出生尺寸按 `St`（2 倍速）变化，周期 5 s |
| `rv-life` | 缺省输入 `lifetimefraction`、`output size`、`multiply` | `rcpps(life)·age` | 尺寸 ∝ 年龄比例，相对误差 ≤ 4e−4 |
| `rv-vec` | `inputrangemin "0 5 0"`、`inputrangemax "10 6 1"`，标量输入 `particlesystemtime`，`output velocity` `remap` | op 标量输入只用 x 分量归一化再铺满；init 按分量 | op 三分量相同；init 组 y、z 不同 |
| `rv-noise` | `simplexnoise`、`scale 10`、`output velocity`、`remap`；`animationmode randomframe`，从顶点的 frame 读出每粒子 `R`（同 P4b `s-rand`） | FastNoise2 Simplex 2D、种子 `R` 位、y/z 种子异或 | 用读出的 `R` 按 2.9 算出的速度和实测一致；同一粒子三分量不同 |
| `rv-fbm` | `fbmnoise`、`octaves 1` / `3`、`output speed`、`outputrange −5..7` | FBm 每倍频 `seed + 1`、坐标 ×2、`amp` ×0.5、`bounding` | 同上逐粒子比 |
| `ri-noise` | init `simplexnoise` / `fbmnoise`，输入 `particlesystemtime`，`output size` | init 噪声是 `snoise1`、与 `R` 无关 | 同帧出生的粒子尺寸相同 |
| `rv-wave` | `square` / `saw` / `triangle`，输入 `lifetimefraction`、`inputrangemin 0.5`、`flags 0`，op 与 init 各一 | 负输入下 `trunc` 与 `floor`、两种舍入 | 年轻粒子（归一化 < 0）的 op 和 init 结果按 2.5 不同 |
| `rv-ops` | 输出 `rotation`，四种 `operation`；fps 60 与 fps 10 各抓 | 运算公式；两遍模式持久列叠两次 | fps 10 时 `add` 的增量是 fps 60 的 2 倍（每帧） |
| `rv-blend` | `rv-time` 加 `blendinstart 0.5`、`blendinend 0.6` | `old + (op − old)·b` | 寿命前半 alpha 不变，0.5–0.6 渐入 |
| `rv-between` | 输入 `positionbetweentwocontrolpoints`，`icp0/1 = 2/3` 与 `ocp0/1 = 0/1` 指向不同位置的控制点 | 输入读的是 `ocp0`、`ocp1` | 比例按 0、1 号点算 |
| `rv-cpout` | `output controlpoint`、`ocp0 = 1`、`remap` 自 `particlesystemtime`；另一个系统 `controlpoint 1` 发射 | `0x10000`（`offset` 不起作用）、只写 lane 0 | 第二个系统的出生点随时间走，与 1 号点 `offset` 无关 |
| `ri-cpbug` | remapinitialvalue 输入 `controlpoint`、`icp0 = 1`；1 号点 `offset "300 0 0"`，另一个系统用 1 号点发射 | 输入 16 把 `cp.current.t` 写成 0 | 第一个粒子出生后，第二个系统的出生点从 `O + (300,0)` 跳到 `O` |
| `ri-dist` | 语料写法：`input distancetocontrolpoint`、`icp0 1`、`inputrangemax 50`、`multiply`，缺省 `output size` | 出生尺寸 ×`clamp01(d/50)` | 发射半径 25 时尺寸减半 |

### `proj/p4d-dist`

| 名 | 设置 | 验证 | 判读 |
|---|---|---|---|
| `md-hard` | 发射半径 100、切向速度 50，`maintaindistancetocontrolpoint` `distance 200` | 硬约束拉回 | 每帧末半径 200（误差 ≤ 0.1） |
| `md-soft` | `variablestrength 5`；fps 60、10 各抓 | `s = clamp01(5·h)` | 半径按 `r ← r + (200 − r)·s` 收敛，fps 10 时每遍 `h = dt/2` |
| `md-move` | 世界系统，1 号点 `offset "200 0 0"`、`flags 0`，`controlpoint 1`、`variablestrength 0.001`（几乎只剩平移）；脚本让对象匀速右移；对照组去掉该模块；fps 60、10 各抓 | `Δcp = current − previous`，两遍模式平移两次 | fps 60 粒子跟着对象（控制点）以同速平移，对照组留在原地；fps 10 以两倍速平移 |
| `md-scale` | 世界系统、对象 `scale "2 1 1"` | `T = inverse(mat3(cp))` | 粒子落在 x 半轴 400、y 半轴 200 的椭圆上 |
| `mb2-move` | 世界系统，`maintaindistancebetweencontrolpoints`，0、1 号点 `offset "−200 0 0"`、`"200 0 0"`，脚本让对象平移并绕 z 旋转；fps 60、10 | 线段映射与 `ΔA`、垂直偏移不旋转、两遍加倍 | 粒子沿线段的比例不变、跟随平移；垂直偏移方向不随线段转；fps 10 平移两倍 |
| `mb2-same` | 两个控制点都不写 `offset` | 长度² ≤ 2⁻⁴⁶ 跳过 | 粒子轨迹与没有该模块时逐位相同 |
| `rm-basic` | 语料写法：`controlpoint 1`、`inner 20`、`outer 50`、`rinner 1000`；粒子以 100/s 穿过 1 号点 | `vel *= 1 − clamp01((ri + t·(ro−ri))·h)` | 进入 48 左右开始减速，20 以内停住；fps 10 再抓一次 |
| `rm-eq` | `rinner = router = 100` | 相等时差存 1.0 | `r = 100 + t`，与按 0 实现的预测可分辨 |
| `v2-sphere` | `vortex_v2` `flags 0`、`inner 100`、`outer 300`、`speedinner 200`、`speedouter 50`；fps 60、10 | 切向 `(r̂ × a)·spd·k` | 速度增量方向 `(r̂y, −r̂x)`，大小按 `k` 而不是 `dt` |
| `v2-center` | 同上加 `flags 2`、`centerforce 1` | `c = (L/|P′| − 1)/h` | 半径保持不变 |
| `v2-cyl` | `flags 1`，出生点带 z 偏移 | 柱形掩码 | 只按到轴的距离 |
| `v2-ring` | `flags 6`、`ringradius 200`、`ringwidth 10`、`ringpulldistance 100`、`ringpullforce 10`，出生半径 100 与 280 | 环形拉力的符号与 `(1 − t)` | 内侧外推、外侧内拉；环带 190–210 内拉力为 0 |
| `v2-axis` | 1 号点 `controlpointangle1 "1.5708 0 0"`、`controlpoint 1` | 轴乘控制点 3×3 | 旋转平面变成 x–z，屏幕上只剩 x 方向的往复 |
| `dist-hide` | `md-move`（fps 60）加脚本让对象隐藏 1 s 再显示，隐藏期间对象继续移动 | WPE 不可见时照常更新控制点和 previous | 重新可见后新出生的粒子只多平移一帧的 `Δcp`，不会被拽过整段位移 |

### 最想用实测核对的读码结论
1. remapvalue 的 `particlesystemtime` 就是场景时间（`rv-time`），语料 3 个系统用它。
2. remapvalue 的噪声是 FastNoise2 Simplex 2D、种子取 `R`（`rv-noise`、`rv-fbm`），init 是 `snoise1`（`ri-noise`）。
3. mapsequencearound 保留出生半径、`θ = 0` 在 +y、第一圈 `seq` 到 1.0（`ma-r`、`ma-basic`）。
4. mapsequencebetween 的 repeat 归零、本地系统按系统原点量垂直分量（`mb-basic`、`mb-perp`）。
5. maintaindistance* 每遍平移完整 `Δcp`（`md-move`、`mb2-move` 的 fps 10）。
6. `vortex_v2` 的切向乘 `k`、方向 `r̂ × a`、轴随控制点旋转（`v2-sphere`、`v2-axis`）。
7. remapinitialvalue 输入 16–18 会写坏控制点（`ri-cpbug`）。
