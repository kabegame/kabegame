> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。只读码，没有实测；实测核对写进 p4-particles-REPORT.md「P4g 语义的实测核对」。本文件覆盖子计划 [phase-4g-color-modules.md](phase-4g-color-modules.md) 步骤 0a。

# WPE 2.8.42 P4g 粒子颜色 initializer `hsvcolorrandom` / `colorlist` 静态逆向

**概括**
- **`hsvcolorrandom`（initializer 类型 4）的键：** `huemin`（缺省 0）、`huemax`（缺省 1）、`huesteps`（缺省 **6**，整数）、`saturationmin`（0.5）、`saturationmax`（1）、`valuemin`（0.5）、`valuemax`（1）。没有 `exponent` 一类的分布参数，也没有任何钳制，只有 `huesteps` 被钳到 ≥ 0【确】。
- **`huesteps` 变成步长：** 记 `s = max(0, huesteps)`、`d = huemax − huemin`（float32，可以为负）。`s ≤ 1` 时步长 0（色相恒为 `huemin`）；否则 `span = (d == 0) ? 1 : d`，`|fmodf(d, 1)| < 1/360` 时 `div = s`，不然 `div = s − 1`；`step = span / div`【确】。
- **出生（init.c case 4）：** `k = min(int(rand()/32767 · (s+1)), s)`（全 float32，`rand()` 是 MSVC CRT 的 `rand`），色相 `= huemin + k·step`，**`k` 取 0..s 共 s+1 档、各约 1/(s+1)**。所以区间不跨整圈时，最后一档比 `huemax` 还多走一步（语料：0.837、0.758、0.680、0.601、**0.523**）。饱和度、明度各抽一次 `uA`（先 S 后 V），`min + uA·(max−min)`，不钳制。色相不取模，交给 `hsv2rgb` 里的 `fmod(h·6, 6)`：`h ≥ 1` 正常回绕，**`h < 0` 落进「其它」分支得灰色 `(v−vs)·(1,1,1)`**。结果乘到 `rgb0` 三列【确】。
- **随机数：** `rand()`（`FUN_1402c97a0`）是 MSVC CRT 的线程局部 LCG，状态在 `__acrt_getptd()+0x28`，场景渲染线程启动时 `srand(QPC 低 32 位)`，同一线程上的全部 `hsvcolorrandom` 和声音选文件共用【确，引 rea-p6a-sound 9.2–9.5】。`uA` 是渲染上下文的 mt19937（`ctx+0x1cd0`，全部粒子系统共用），`FUN_1401f87a0(ctx+0x20, ctx+0x1cd0)` 就是我们的 `uA`【确】。每出生一个粒子：`rand()` 1 次 + mt19937 2 个 u32。
- **`colorlist`（类型 5）的键：** `colors`（数组）、`huenoise`、`saturationnoise`、`valuenoise`（缺省都是 0）。`colors` 只认**字符串项**，按空格切出前三个数、`atof`，**不 ÷255、不钳制**，存进记录前就 `rgb2hsv` 成 HSV。少于三个数的项、非字符串项整项丢掉；没有一项有效（包括缺 `colors`：缺省值是字符串 `"1 1 1"` 而不是数组）时补一项 **HSV (0, 1, 1)，即纯红**。数量没有上限（`std::vector`）【确】。
- **出生（init.c case 5）：** 用 `std::uniform_int_distribution<int>(0, n−1)` 从 mt19937 取下标（1 个 u32，有极小概率的拒绝重抽），取出该项的 HSV，各分量的区间是 `[max(x − noise, 0), min(x + noise, 1)]`，再依次抽 `uA` 得 H、S、V；然后加上记录里的 HSV 平移（`colorn` 用，缺省 0），色相 `h − floor(h)` 取模，S、V 钳到 [0, 1]，`hsv2rgb` 后乘到 `rgb0` 三列【确】。每粒子 mt19937 共 4 个 u32。
- **系统色（`FUN_1401c45f0`）：** `hsvcolorrandom` 取 `hsv2rgb(clamp01((huemin+huemax)/2), clamp01((smin+smax)/2), clamp01((vmin+vmax)/2))`，不看 `huesteps`。`colorlist` 取第一个有效字符串项的原始 RGB；**没有有效项时这个模块不改系统色、也不置 `hascolor`**（和出生时补的红色不一致）。initializer 按顺序走、后者覆盖前者，所以语料「`colorrandom` 在前、`hsvcolorrandom` 在后」的系统色是后者的中点色 (0.36397, 0.18750, 0.75000)【确】。
- **绑定记录与重算（`FUN_1401d15a0`）：** 0xd（`hsvcolorrandom`）记录存基值 `huemin`、`span`、`div`、S/V 的 min 与 range；生效时 `huemin' = hc − span/2`（**不取模、不钳**），S、V 的 min 居中到 `colorn` 的 S、V 并钳到 [0, 1]，超出 1 时把 range 截短；**`step` 与档数不动**；不生效时写回基值。0xe（`colorlist`）记录存第一项的 HSV `(h0, s0, v0)`，生效时写 `(hc−h0, sc−s0, vc−v0)` 到出生时的平移字段，否则写 0。系统 `flags & 8` 时两种记录都不建，平移保持解析时的 0，`colorn` 也不生效【确】。
- **组合：** 解释器按 JSON 顺序逐条执行，`colorrandom`（case 3）和 `hsvcolorrandom`（case 4）都是 `rgb0 *= 颜色`，所以**各乘一次**；`colorn` 生效时 0xb 和 0xd 两条记录也各自重算【确】。

**元数据**
- 目标 `D:/Applications/Steam/steamapps/common/wallpaper_engine/wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。没有运行或附加 WPE，没有写 Steam 目录。
- 方法：解析分支与解释器读 `ignore/p4/rea/wp.asm`（objdump 全文）；缺省值函数、随机数、`hsv2rgb`、重算函数、系统色函数用 REA（Ghidra 12.1.4，新开分析，旧快照因分析档位摘要变了打不开）反编译，关键处回汇编核对。
- 工作目录 `ignore/p4/g0/rea/`：
  - `c.py`：读 float 常量；`iat.py`：读导入名；
  - `corpus_sys.py`：读语料那份粒子 JSON 的 initializer（只读，经 kbp content）；
  - `corpus_calc.py`：按读码用 float32 算语料的解析值、系统色、`colorn` 重算结果；
  - `bucket.py`：`rand()` 0..32767 全集上的档位分布。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。

**命名**
- `rec`：initializer 记录起点（类型字节在 `rec+0`、长度字在 `rec+2`），init.c 里的 `pbVar24`；解析段拿到的负载指针 `p = rec + 4`。
- `uA`：`FUN_1401f87a0(ctx+0x20, ctx+0x1cd0)`，`((u32 >> 8) · 2⁻²⁴) · (hi − lo) + lo`，区间 `ctx+0x20/24 = [0, 1)`（rea-p4a、rea-p4b-modules 的定义）。
- `rgb0`：初值颜色列 `sys+0x318/0x320/0x328`（init.c 的 `param_1[99]`、`[100]`、`[0x65]`，rea-framework Q5）。
- `colorn` 的 HSV 记 `(hc, sc, vc)`，系统色记 `(h0, s0, v0)`。

---

## 1. 解析

### 1.1 `hsvcolorrandom`：键、缺省、类型【确】

解析段 `0x1401c7828`–`0x1401c7b3f`（`memcmp` 名字串 `0x14048fca8` 在 `0x1401c783a`），记录分配 `FUN_1401d8560`：类型字节 4、长度 0x20、返回 `rec+4`。缺省值函数 `FUN_1401ba3e0(模块 JSON)`（`0x1401c786d` 调，第二参数正交开关没用到），只在键不存在时写（`FUN_140087490` 查键）：

| 键 | 字符串地址 | 缺省（JSON 类型） | 读法 | 读到寄存器 |
|---|---|---|---|---|
| `huemin` | `0x14048f55c` | 0.0（real） | `asFloat` `FUN_140086220` | `xmm13` |
| `huemax` | `0x14048f564` | 1.0（real，`0x3ff0000000000000`） | `asFloat` | `xmm7` |
| `saturationmin` | `0x14048f5f0` | 0.5（real） | `asFloat` | `xmm11` |
| `saturationmax` | `0x14048f600` | 1.0（`FUN_1401d7d30`，`0x3f800000`） | `asFloat` | `xmm8` |
| `valuemin` | `0x14048f610` | 0.5（`0x3f000000`） | `asFloat` | `xmm12` |
| `valuemax` | `0x14048f620` | 1.0 | `asFloat` | `xmm9` |
| `huesteps` | `0x14048f570` | **6（int）**（`0x1401ba5ab` `mov qword ptr [rax], 0x6`，类型字节 1） | `asInt` `FUN_140085ee0` | `ecx` |

- `asInt`：null 得 0，int / uint 原值，real 截断（`(int)double`），bool 0/1，字符串等触发 jsoncpp 断言（`FUN_140085ee0`）。`asFloat` 同理，null 得 0（rea-p4c-render）。
- 饱和度 / 明度的键名就是 `saturationmin` / `saturationmax` / `valuemin` / `valuemax`。没有 `exponent`（`0x14048f5a8` 只在 `colorrandom` 段引用）。
- 写进记录（`p = rec+4`，init.c 读的偏移在右）：

| 写入指令 | `p` 偏移 | `rec` 偏移 | 值 |
|---|---|---|---|
| `0x1401c79ac` | `+0` | `+4` | `huemin` |
| `0x1401c7a52` | `+4` | `+8` | `step`（1.2） |
| `0x1401c79e5` | `+8` | `+0xc` | `s = max(0, huesteps)`（`cmovg`，`0x1401c79e2`） |
| `0x1401c7a5b` | `+0xc` | `+0x10` | `saturationmin` |
| `0x1401c7a6f` | `+0x10` | `+0x14` | `saturationmax − saturationmin` |
| `0x1401c7a74` | `+0x14` | `+0x18` | `valuemin` |
| `0x1401c7a7a` | `+0x18` | `+0x1c` | `valuemax − valuemin` |

- 不钳制：min > max、超出 [0, 1]、负数都原样写入【确：段内没有比较指令，只有 `huesteps` 的 `cmovg`】。

### 1.2 `huesteps` → 步长（`0x1401c79e8`–`0x1401c7a52`）【确】

```
s    = max(0, asInt(huesteps))                      // rec+0xc
if 1.0 >= (float)s:                                 // comiss xmm10(=1.0), xmm6 ; jb
    step = 0; span = 0; div = 0                     // 0x1401c79f5–0x1401c79fb
else:
    d    = huemax − huemin                          // float32
    span = (d != 0.0) ? d : 1.0                     // ucomiss 常量 0x1404925c0 = 0.0；相等时 xmm10 保持 1.0
    div  = s − 1
    if |fmodf(d, 1.0)| < 0.0027777778:  div = s     // FUN_14041d0c0 = fmodf，FUN_1400604c0 = fabs，常量 0x140492610 = 1/360
    step = span / div                               // divss
```

- `xmm10 = 1.0` 是模块循环头 `0x1401c70c0`（常量 `0x140492704` = 1.0）每轮重载的循环不变量；第一轮从 `0x1401c70af` 跳过这条指令，此时 `xmm10` 来自前面的发射器循环（`0x1401c6377` 同样载 1.0，二者之间没有写 `xmm10`）【第二轮起【确】；第一轮【推】，很强】。
- `fmodf` 保留被除数的符号：`d = −0.235` 时 `fmodf = −0.235`，不是整圈，`div = s − 1`。
- 整圈的含义：`d` 是 1 的整数倍（含 0，此时 span 改成 1）时首尾同色，所以除以 `s`；否则除以 `s − 1`。但出生时 `k` 取到 `s`（2.1），两种情况都多一档：整圈时首尾重复（`k = 0` 与 `k = s` 同色），非整圈时最后一档越过 `huemax` 一步。
- `s = 0`、`s = 1`、负数：步长 0，色相恒为 `huemin`。缺省（不写 `huesteps`）是 `s = 6`：缺省区间 0..1 是整圈，`step = 1/6`，`k` 取 0..6，红色（`k = 0` 与 `k = 6`）占 2/7。
- 区间里 `span` 与 `div` 另存进 0xd 记录（3.2），出生不读它们。

### 1.3 `colorlist`：键、缺省、类型【确】

解析段 `0x1401c7b44`–`0x1401c7f27`（名字串 `0x14048fcb8`），记录分配 `FUN_1401d85a0`：类型字节 5、长度 0x34。缺省值函数 `FUN_1401ba740`：

| 键 | 字符串地址 | 缺省 | 读法 | 写到 |
|---|---|---|---|---|
| `colors` | `0x14048f5b4` | **字符串 `"1 1 1"`**（类型 4，`0x1401ba740` 里 `_malloc_base(10)` 拼 `"1 1 1"`） | 见下 | `rec+4` 起的 `std::vector<vec3>`（begin `rec+4`、end `rec+0xc`、cap `rec+0x14`） |
| `huenoise` | `0x14048f5c0` | 0.0 | `asFloat` | `rec+0x28`（`0x1401c7e64`） |
| `saturationnoise` | `0x14048f5d0` | 0.0 | `asFloat` | `rec+0x2c`（`0x1401c7e99`） |
| `valuenoise` | `0x14048f5e0` | 0.0 | `asFloat` | `rec+0x30`（`0x1401c7ec7`） |
| （平移） | — | (0, 0, 0)（`xmm13 = 0` 经 `FUN_140077f30` 建 vec3） | — | `rec+0x1c..0x24`（`0x1401c7e30`–`0x1401c7e38`） |

`colors` 的解析（`0x1401c7bb9`–`0x1401c7db5`）：
1. 取 `colors`，**不是数组（类型 6，`FUN_1400888a0`）就跳过整个循环**（`0x1401c7bcb`）。缺省值是字符串，所以不写 `colors` 等于空列表。
2. 逐项：不是字符串（类型 4，`FUN_140088890`）就跳过（`0x1401c7c39`）。
3. `asCString` 为空指针或空串：压入 (0, 0, 0)（`0x1401c7c72`、`0x1401c7c7b` → `0x1401c7d68`）。
4. 否则 `atof`（`FUN_1402d06ac`）第一个数；向后找空格，**找不到就整项丢掉**（`0x1401c7cbd`）；跳过连续空格，再 `atof` 第二个数；同样找不到空格就丢掉（`0x1401c7d1d`）；第三个数直接 `atof`。空格之后到了串尾时 `atof("")` 得 0，所以 `"a b "` 被当作 `(a, b, 0)`，`"a "` 丢掉。第四个及以后的数忽略。只认空格（0x20），不认制表符、逗号。
5. 三个数**不 ÷255、不钳制**，经 `rgb2hsv`（`FUN_1401b8b90`，`0x1401c7d84`）转成 HSV 后 `push_back`（`FUN_1401d85c0`，元素 12 字节）。
6. 循环后 `empty()`（`FUN_1401d76a0`）为真时压入 HSV **(0, 1, 1)**（`FUN_1401d8750`，参数 `0x1401c7dda`–`0x1401c7dfc`：h = 0、s = 1、v = 1），即纯红。

- 数量没有上限，出生时 `n = (end − begin)/12`（init.c case 5 的 `* −0x55555555`）。
- 分量大于 1 时 `rgb2hsv` 给出 `v > 1`；出生时 V 的区间上界钳到 1、最终 V 钳到 [0, 1]（2.2），所以等效于 `v = 1`【确：代码；画面是推论】。

---

## 2. 出生公式

### 2.1 case 4 `hsvcolorrandom`（`0x14023b74a`–`0x14023b866`）【确】

```
s  = rec+0xc                                     // 已钳到 ≥ 0
r  = rand()                                      // 0x14023b74e，FUN_1402c97a0
k  = (int)trunc( (float)r / 32767.0f * (float)(s + 1) + 0.0f )   // divss 常量 0x140492960 = 32767.0；cvttss2si
k  = min(k, s); k = max(k, 0)                    // cmovg / cmovs
H  = (float)k * rec+0x8 + rec+0x4                // mulss、addss，float32
S  = uA * rec+0x14 + rec+0x10                    // 0x14023b7a8，第一次 mt
V  = uA * rec+0x1c + rec+0x18                    // 0x14023b7ca，第二次 mt
(cr, cg, cb) = hsv2rgb(H, S, V)                  // 0x14023b801
rgb0.r *= cr; rgb0.g *= cg; rgb0.b *= cb         // sys+0x318 / 0x320 / 0x328，0x14023b806–0x14023b860
```

- 次序：`rand()` → `uA`（S）→ `uA`（V）。`rand()` 不碰 mt19937，所以 mt19937 每粒子正好 2 个 u32。`rand()` 每出生一个粒子无条件调一次，`s = 0` 也调【确】。
- 档位分布（`bucket.py`，`r` 取 0..32767 全集，float32 照汇编）：`s = 4` 时 `[6554, 6553, 6554, 6553, 6554]`；`s = 6` 时前 6 档各 4681、最后一档 4682；`s = 1` 时两档各半。即 `k` 在 0..s 上近似均匀，`r = 32767` 时乘出 `s + 1`、被钳到 `s`。
- H、S、V 都不钳、不取模。`hsv2rgb`（2.3）对 `H ≥ 1` 自然回绕，对 `H < 0` 得灰色；`S > 1` 或 `S < 0` 会使 `m = V − V·S` 越界，输出可能为负或大于 V【确：代码；没有 WPE 实测】。
- 只写 `rgb0`；`def+0xc` bit3（`colorchange` 置）时，当前列在 initializer 之前就从 `sys+0x3e0` 拷过（rea-p4b-render 7.4 末尾），颜色 initializer 不写当前列【确：case 4 只写 `+0x318/0x320/0x328`】。

### 2.2 case 5 `colorlist`（`0x14023b86b`–约 `0x14023ba80`）【确】

```
n   = (rec+0xc − rec+0x4) / 12
idx = uniform_int(0, n − 1, mt)                  // FUN_14024f410(&{0, n−1}, ctx+0x1cd0)
(h, s, v) = colors[idx]                          // 已是 HSV
hlo = max(h − huenoise, 0);  hhi = min(h + huenoise, 1)        // rec+0x28
slo = max(s − saturationnoise, 0); shi = min(s + saturationnoise, 1)  // rec+0x2c
vlo = max(v − valuenoise, 0); vhi = min(v + valuenoise, 1)     // rec+0x30
H = uA(hlo, hhi) + rec+0x1c                      // 第 2 个 u32
S = uA(slo, shi) + rec+0x20                      // 第 3 个
V = uA(vlo, vhi) + rec+0x24                      // 第 4 个
H = H − floorf(H)                                // FUN_14041a5c0 = floorf（SSE4.1 时 roundss 9）
S = clamp(S, 0, 1); V = clamp(V, 0, 1)           // 0x14023b9a7–0x14023b9e2
rgb0 *= hsv2rgb(H, S, V)                         // 0x14023ba0d 起
```

- `FUN_14024f410` 是 MSVC `std::uniform_int_distribution<int>` 的实现（Lemire 乘法法）：`range = n`，`v = u32 · range`（64 位），低 32 位 `< (2³² mod range)` 时重抽，结果取高 32 位 + 0。`n = 1` 也照样抽 1 个 u32。重抽概率 `(2³² mod n)/2³²`，`n` 为 2 的幂时为 0【确】。它和 `uA` 用的是同一个 mt19937（`FUN_14007d8f0` 与 `FUN_14007f5b0` 是同一段 MT19937 生成 + tempering，前者多一层指针间接）【确】。
- 上下界的钳制写法（`0x14023b8c8` 起）：`hi = (1 > x+noise) ? x+noise : 1`、`lo = (x−noise > 0) ? x−noise : 0`。`noise` 为负时 `lo > hi`，`uA(lo, hi)` 照常在两者之间【确】。
- `uA(lo, hi)` 的区间结构按 `{lo, hi}` 存在栈上：H `[rbp+0x68/0x6c]`、S `[rbp+0x78/0x7c]`、V `[rbp+0x70/0x74]`，调用顺序 H（`0x14023b957`）→ S（`0x14023b96e`）→ V（`0x14023b984`）【确】。
- 色相：随机区间不跨 0 / 1（钳了），平移之后才用 `floor` 取模。

### 2.3 `hsv2rgb`（`FUN_1401b8c70`）与 `floorf`（`FUN_14041a5c0`）【确】

沿用 rea-p4b-render 7.3，本轮回汇编核对了精度：

```
C = v·s                                             // float32
H = (float) fmod( (double)(h·6.0f), 6.0 )           // h·6 在 float 里乘（0x1401b8cb3 mulss），再 cvtps2pd
X = (float)( (1 − |fmod((double)H, 2.0) − 1|) · (double)C )
m = v − C
[0,1):(C,X,0) [1,2):(X,C,0) [2,3):(0,C,X) [3,4):(0,X,C) [4,5):(X,0,C) [5,6):(C,0,X) 其它（H<0、NaN）:(0,0,0)
return (r+m, g+m, b+m)
```

- `FUN_14041a5c0`：CPU 支持 SSE4.1（`DAT_1404dc008 > 1`）时 `roundss imm 9`，否则软件实现，结果都是 `floorf`。
- `FUN_14041d0c0` 是 CRT `fmodf`（报错名字串 `"fmodf"`），`FUN_1400604c0` 是 `fabsf`（与掩码）。

### 2.4 `rand()` 是哪个、种子在哪【确】

- `FUN_1402c97a0`：`ptd = FUN_1402d9894()`（`__acrt_getptd`），`ptd+0x28 = ptd+0x28 · 0x343fd + 0x269ec3`，返回 `(x >> 16) & 0x7fff`。即 MSVC CRT `rand()`，**每线程一个状态**。
- `srand` = `0x1402c97cc`，全二进制只有 4 个直接调用点，种子全是 `QueryPerformanceCounter` 的低 32 位（IAT `0x140426588`）。场景渲染线程在入口 `FUN_140110630` 的 `0x14011065e` 播种一次；同一线程上 `0x465` 重载场景不重新播种（rea-p6a-sound 9.2、9.4）。
- 所以：全进程不是一个序列，而是**每条场景渲染线程一个序列**；同一线程上全部粒子系统的 `hsvcolorrandom` 出生（含加载时预热）与声音选文件（`FUN_1401f5980`）交替消耗它（rea-p6a-sound 9.3）。种子不可知，序列复刻不了。
- mt19937（`uA` 与 `colorlist` 的下标）：渲染上下文构造 `FUN_14017c6d0` 里以毫秒时间重播种，状态 `ctx+0x1cd0`，同一上下文的全部粒子系统、声音 `random` 等待共用（rea-p6a-sound 9.6、rea-p4a）。也是每次打开不同。

---

## 3. 系统色与颜色绑定记录

### 3.1 系统色（`FUN_1401c45f0`，粒子解析 `0x1401c5963` 调）【确】

在 rea-p4b-render 7.1 的循环基础上核对两个分支：

```
hsvcolorrandom:                                    // 先调缺省值函数 FUN_1401ba3e0
    hm = clamp01((huemax + huemin)·0.5)            // 先 max(0, ·) 再 min(·, 1)
    sm = clamp01((saturationmax + saturationmin)·0.5)
    vm = clamp01((valuemax + valuemin)·0.5)
    color = hsv2rgb(hm, sm, vm); hascolor = true    // 不看 huesteps
colorlist:                                         // 先调 FUN_1401ba740
    if colors 是数组:
        for item in colors:
            if item 不是字符串: continue
            空指针 / 空串: color = (0,0,0); hascolor = true; break
            按 1.3 第 4 条切三个数；切不出三个: continue（看下一项）
            color = (a, b, c)（原值，不 ÷255、不 rgb2hsv）; hascolor = true; break
    // 没有有效项（含缺 colors）：color 与 hascolor 都不变
```

- 与出生侧的差别：`colorlist` 没有有效项时，出生用补出的红色 HSV (0, 1, 1)（1.3 第 6 条），而系统色保持前面模块（或初值 (1, 1, 1)）的值，`hascolor` 也不因它置位。只有这一个 `colorlist`、又没有有效项时，`hascolor` 为假 → 置 `0x200000`（rea-p4b-render 7.1）【确：代码路径；画面是推论】。
- 系统色写成 `"%.5f %.5f %.5f"` 再读回（rea-p4b-render 7.1），有 1e-5 舍入。
- 语料（`corpus_calc.py`）：中点 (0.718954, 0.75, 0.75) → 系统色 `0.36397 0.18750 0.75000`，它的 HSV ≈ (0.718954, 0.75, 0.75)。

### 3.2 0xd 记录（`hsvcolorrandom`）【确】

追加器 `FUN_1401d8580`：类型字节 0xd、步长 0x34、返回 `rec+4`，**不写 `+2` 的长度字**；遍历用 `+0xc` 的长度（同 0xb、0xc）。字段由解析段 `0x1401c7ac5`–`0x1401c7b3c` 写（下表用记录起点 `R`）：

| `R` 偏移 | 写入指令 | 内容 |
|---|---|---|
| `+0` | `FUN_1401d8580` | 类型 0xd |
| `+4` | `0x1401c7ad3` | initializer 流基址（8 字节，`[rsp+0x40]`） |
| `+0xc` | `0x1401c7ac5` | 长度 0x34 |
| `+0x10` | — | 不写 |
| `+0x14` | `0x1401c7b03` | `huemin` |
| `+0x18` | `0x1401c7b12` | `span`（1.2 的 `xmm10`；`s ≤ 1` 时为 0） |
| `+0x1c` | `0x1401c7b0d` | `div`（`xmm6`；`s ≤ 1` 时为 0） |
| `+0x20` | `0x1401c7b18` | `saturationmin` |
| `+0x24` | `0x1401c7b21` | 饱和度 range |
| `+0x28` | `0x1401c7b24` | `valuemin` |
| `+0x2c` | `0x1401c7b39` | 明度 range |
| `+0x30` | `0x1401c7b3c` | 目标：initializer 负载 `rec+4` 相对流基址的偏移 |

- `0x1401c7aef` 用 S/V/H 的中点调了 `FUN_14005f460`（写 `[rbp+0x7e0]`），结果不进记录【推：构造临时 vec3，和系统色无关】。
- 重算（`FUN_1401d15a0` case 0xd），`T = R+4 处基址 + R+0x30`（= initializer 的 `rec+4`）：

```
if !active:                                   // 写回基值
    T+0x0  = R+0x14                           // rec+0x4  huemin
    T+0xc  = R+0x20; T+0x10 = R+0x24          // rec+0x10 / 0x14
    T+0x14 = R+0x28; T+0x18 = R+0x2c          // rec+0x18 / 0x1c
else:
    T+0x0  = (hc − (span·0.5 + huemin)) + huemin          // 不取模、不钳
    smin'  = clamp01((sc − (srange·0.5 + smin)) + smin)
    srange'= (smin' + srange > 1) ? 1 − smin' : srange
    （V 同 S，用 vc）
```

- **步长 `rec+8` 和档数 `rec+0xc` 不在重算里**，`div` 存了但没人读【确：case 0xd 只写 `T+0`、`+0xc..+0x18`】。
- 色相：生效后 `huemin' = hc − span/2`，`span` 有符号。语料 `span = −0.2353`、`hc = 5/6`：`huemin' = 0.95098`，档位 0.951 / 0.873 / 0.794 / 0.716 / 0.637（`corpus_calc.py`）。`hc` 小而 `span` 为正时 `huemin'` 为负，出生色相为负的档位是灰色（2.3）【确：代码；画面是推论，值得实测】。
- S / V：语料 `colorn = (0.50196, 0, 0.50196)`，`(hc, sc, vc) = (0.8333, 1, 0.50196)` → S ∈ [0.75, 1.0]（range 截成 0.25），V ∈ [0.25196, 0.75196]。
- 0xd 不用系统色 HSV；`active` 的判断仍然比较 `colorn` 与系统色（rea-p4b-render 7.3），所以系统色只决定「生不生效」。

### 3.3 0xe 记录（`colorlist`）【确】

追加器 `FUN_1401d87a0`：类型 0xe、步长 0x24。字段（`0x1401c7ef3`–`0x1401c7f24`）：

| `R` 偏移 | 内容 |
|---|---|
| `+4` | initializer 流基址 |
| `+0xc` | 长度 0x24 |
| `+0x14..+0x1c` | `colors[0]` 的 HSV（`FUN_1401d9270(vec, 0)`，即解析后列表的第一项；没有有效项时是补出的 (0, 1, 1)） |
| `+0x20` | 目标：`rec+4` 偏移 + 0x18，即 initializer 的平移字段 `rec+0x1c` |

重算（case 0xe）：`active` 时写 `(hc − h0, sc − s0, vc − v0)`，否则写 (0, 0, 0)。出生时加到随机 HSV 上（2.2），色相平移后 `floor` 取模，S、V 钳到 [0, 1]。

- `h0` 取自记录（列表第一项的 HSV），`active` 比较用的是系统色（3.1）。正常情况二者是同一种颜色；没有有效项时二者不同（`h0` = 红，系统色是别的模块的）【确】。

### 3.4 `flags & 8`、`colorn` 不生效、运行中改 `colorn`【确】

- 解析时 `test byte ptr [r13+8], 8`：`hsvcolorrandom` 在 `0x1401c7a7f`、`colorlist` 在 `0x1401c7ecc`，置位就跳过追加记录。initializer 记录保持解析值，`colorlist` 的平移保持 0。`FUN_14022bd40` 也在 `flags & 8` 时令 `active = false`（rea-p4b-render 7.3）。
- `colorn` 未设（`r < 0`）、与系统色差 < 0.9/255、或父系统不生效时 `active = false`，两种记录都写回基值 / 写 0。
- 运行中改 `colorn`：置脏 → 下一帧对象更新开头 `FUN_14022bd40(sys, 1, 1)` → `FUN_1401d15a0` 从记录里的基值重算（不在当前值上累加），只影响之后出生的粒子（rea-p4b-render 7.3、rea-p4f-script 5.2）。0xd、0xe 与 0xb、0xc 同一条路径。
- 场景 `version < 5` 时 `0x200000` 置位，`colorn` 生效则实例颜色 = `colorn·k`，再乘颜色模块（rea-p4b-render 7.4）；语料 `scene.json` `version` 为 5，不走这条。

---

## 4. 和 `colorrandom` 同在一个系统【确】

- 解释器 `FUN_14023b340` 按 initializer 在流里的顺序逐条执行（跳转表 `0x14023fa78`，rea-framework）。case 3 `colorrandom` 和 case 4 都是 `rgb0 *= 颜色`（init.c 约 395–433 行），所以最终 `rgb0 = 实例颜色 · colorrandom 色 · hsvcolorrandom 色`，各乘一次。
- 系统色：`FUN_1401c45f0` 不提前退出、后者覆盖前者，语料取 `hsvcolorrandom` 的中点色（3.1）。
- `colorn` 生效时：0xb 记录按 `(hc − h0, sc − s0, vc − v0)` 平移 `colorrandom` 的两端（`h0` 等是 `hsvcolorrandom` 中点色的 HSV），0xd 记录把 `hsvcolorrandom` 的区间居中到 `colorn`。两者各自独立重算。
- 语料 `colorrandom` 是 `min "255 130 130"`、`max "134 132 255"`、`exponent 2`，与 `hsvcolorrandom` 相乘，颜色会明显偏暗、偏冷【推：画面效果】。

## 5. 分布参数【确】

- `hsvcolorrandom`：只有上面 7 个键，没有 `exponent`。`huesteps` 决定离散档位；S、V 是 `uA` 的线性映射（均匀）。
- `colorlist`：`colors` + 三个 `*noise`，下标均匀、各分量在钳后的区间里均匀。
- 两个缺省值函数里都没有别的键（`FUN_1401ba3e0` 只写 7 个键，`FUN_1401ba740` 只写 4 个键）。

---

## 6. 和已有读码的对照与更正

1. rea-p4b-render 7.1「`colorlist`：color = colors 里第一个字符串项的原值」：补充为「第一个能切出三个数的字符串项（空串当 (0,0,0)）；一个都没有时不改系统色、不置 `hascolor`」。
2. rea-p4b-render 7.2「0xd、0xe 的对应关系按调用点所在的模块分支定，没有逐字段核对记录内偏移」：本文件 3.2、3.3 已逐项核对，与 7.3 表格的写法一致；补充「0xd 不改步长与档数」「0xe 的 `h0` 取解析后列表第一项，可能与系统色不同」。
3. rea-p6a-sound 9.3 表里 `hsvcolorrandom` 一行「字段对应 `huesteps` 等是推」：本文件 1.1 已核对，改为【确】；色相是 `k·step + huemin`，`step` 不是 `huemax`。
4. phase-4g 计划「`(max − min) / steps`」：实际是 `span / (s−1)` 或 `span / s`（1.2），且 `k` 取到 `s`。

## 未查完 / 未解决

1. 1.2 第一轮模块循环里 `xmm10` 的初值是从发射器循环带过来的 1.0，没把从函数入口到 `0x1401c70af` 的全部路径逐条走完【推】。只在「粒子 JSON 的第一个 initializer 就是 `hsvcolorrandom`、且 `s ≥ 2`」时有影响。
2. `0x1401c7aef` 调 `FUN_14005f460` 的用途没读（结果不进 0xd 记录）。
3. 负色相、`S > 1` 时 WPE 实际画面（灰色、负值颜色）没有实测；顶点颜色是否在上传或着色器里再钳没有追。
4. `colorlist` 解析里 `atof` 遇到非数字（`"a b c"`）得 0 是 CRT 行为，没单独核对。
5. `asInt` 遇到字符串型 `huesteps` 走 jsoncpp 断言，release 下的实际行为（返回什么、是否崩溃）没读。

## 建议的确定性实验

不复刻 `rand()`：确定性工程里让色相档位确定（`huesteps` 0 / 1，或 `huemin = huemax` 且 `s ≤ 1`），随机的档位只核对取值集合与比例。

| 名 | 设置 | 预测 |
|---|---|---|
| `hsv-fixed` | `huesteps 0`、`huemin = huemax = 0.25`、S/V 收成 min = max = 1 | 全部粒子 `hsv2rgb(0.25,1,1) = (0.5, 1, 0)`（乘在实例颜色上） |
| `hsv-steps1` | `huesteps 1`、`huemin 0.1`、`huemax 0.9` | 全部色相 0.1（步长 0，不是两档） |
| `hsv-default` | 只写 `name`（全部缺省） | 7 档色相 0, 1/6, …, 1，红色约 2/7；S ∈ [0.5, 1]、V ∈ [0.5, 1] |
| `hsv-fwd` | `huemin 0`、`huemax 0.5`、`huesteps 3`，S/V 固定 | 档位 0、0.25、0.5、**0.75**（div = 2，k 取 0..3），各约 1/4 |
| `hsv-rev`（语料原样） | `huemin 0.83660131`、`huemax 0.60130719`、`huesteps 4` | 5 档 0.837 / 0.758 / 0.680 / 0.601 / **0.523**，各约 1/5 |
| `hsv-zero-span` | `huemin = huemax = 0.3`、`huesteps 4` | span 改成 1、div = 4：档位 0.3、0.55、0.8、1.05(=0.05)、1.3(=0.3)，0.3 占 2/5 |
| `hsv-neg` | `huemin −0.2`、`huesteps 0`、S = V = 1 | 灰色：`(0,0,0) + (V − VS)` = 黑（S = 1 时）；S = 0.5 时 (0.5, 0.5, 0.5) |
| `hsv-wrap` | `huemin 1.25`、`huesteps 0` | 与 0.25 相同 |
| `hsv-colorn` | 语料原样 + 对象 `colorn` 设 `0.50196 0 0.50196`，`version 5` | 档位 0.951 / 0.873 / 0.794 / 0.716 / 0.637；S ∈ [0.75, 1]；V ∈ [0.252, 0.752] |
| `hsv-colorn-neg` | `huemin 0`、`huemax 0.4`、`huesteps 2`；`colorn "1 0 0"`（hc = 0，与系统色不同所以生效） | span 0.4、div 1、step 0.4：`huemin' = −0.2`，档位 −0.2（灰）、0.2、0.6 |
| `hsv-flags8` | `hsv-colorn` 加系统 `flags 8` | 与不设 `colorn` 相同（不重算） |
| `hsv-after-cr` | `colorrandom min=max "255 0 0"` 在前、`hsvcolorrandom` 固定色 (0.5,1,1)（青）在后 | 黑（两次相乘）；系统色 = 青 |
| `list-one` | `colors ["0 0.5 1"]`、noise 0 | 全部 (0, 0.5, 1)；mt 每粒子 4 个 u32（与 `uA` 粒子字段错位可用来核对次序） |
| `list-many` | `colors` 3 项 | 三色各约 1/3 |
| `list-bad` | `colors ["1 0", 5, "0 1 0"]` | 只有绿色（前两项丢掉）；系统色 = 绿 |
| `list-empty` | 不写 `colors`；另一组 `colors []` | 全部红色 (1, 0, 0)；系统色保持 (1, 1, 1)，没有别的颜色模块时 `hascolor` 为假 |
| `list-255` | `colors ["255 0 0"]` | 与 `"1 0 0"` 同（V 钳到 1） |
| `list-noise` | `colors ["0 1 1"]`、`huenoise 0.1` | 色相 ∈ [0, 0.1]（下界钳到 0，不跨到 0.9 一侧） |
| `list-colorn` | `colors ["1 0 0", "0 1 0"]`、`colorn "0 0 1"` | 平移 = 蓝 − 红的 HSV 差 (2/3, 0, 0)：红 → 蓝、绿 → 色相 1/3 + 2/3 = 1 → 红 |
| `live-colorn` | `hsv-colorn` 的 `colorn` 绑属性，运行中改 | 只有改之后出生的粒子变色，档位按新 `hc` 居中 |

### 最想用实测核对的读码结论
1. `k` 取 0..s 共 s+1 档、非整圈时多走一步（`hsv-fwd`、`hsv-rev`）。
2. 缺省 `huesteps` 是 6（`hsv-default`）。
3. `huemin = huemax` 时 span 被换成 1（`hsv-zero-span`）。
4. 负色相出灰色（`hsv-neg`、`hsv-colorn-neg`）。
5. `colorlist` 空列表出红色而系统色不变（`list-empty`）。
6. 0xd 重算只动 min 不动步长（`hsv-colorn`）。

---

## 实测更正（2026-11-18，P4g 步骤 0b，`p4-particles-REPORT.md`「P4g 语义的实测核对」）

1. **0xd 记录在 `huesteps ≤ 1` 时的 span**：`hsv-colorn-fixed`（`huemin = huemax = 0.25`、`huesteps 0`、`colorn` 紫）出生色相等于 `colorn` 的色相 0.8333，所以这一支写进记录的 span 是 0（`huemin' = hc`），不是 1。上文「`span = d == 0 ? 1 : d`」只在 `s > 1` 的分支成立。
2. **`colorlist` 缺 `colors` 键**：`list-empty` 的粒子是白色 (1, 1, 1)：缺省值字符串 `"1 1 1"` 被当成一项白色，不等同空列表；写成 `colors: []` 才走「补纯红 HSV (0, 1, 1)」。系统色在这种情况下取什么没有单独实测。
