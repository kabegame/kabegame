> 逆向原始记录，代理写的，地址按 Ghidra。实测核对见 [p4-particles-REPORT.md](p4-particles-REPORT.md)。**已知要修正：** `brightness` 只在场景 HDR 时生效，不是「后处理 ultra」；预热步数按 float32 累加算，`starttime 2.5`、步长 0.05 是 51 步，不是 `ceil` 的 50。

# WPE 2.8.42 P4a 静态逆向结论

**概括**
- B（档 1 模块）全部读到代码：字段名、默认值、公式和用到的列都有。
- A（层级）基本查清：世界矩阵是 `父世界 · T · R · S`，旋转是 Z·Y·X，单位弧度。`visible` 沿父链继承，`alpha`、`color`、`brightness` 不继承。绘制是扁平的 `objects` 数组顺序。
- C 大部分查清。透视粒子是每次绘制临时换投影，`fov` 取 `perspectiveoverridefov`，默认 95；`nearz`、`farz` 不参与。风、重力键未找到引擎读取点。
- **上轮结论要改一处：** `obj+0x854` 是 `instanceoverride.rate`，不是 `speed`。上轮写的 `dt' = dt·speed` 应为 `dt' = dt·rate`。`speed` 另有用途，见 C5。
- **默认值分正交、透视两套：** 取决于场景是否正交。
- **透视场景默认值与 LWE 不同：** 例如 `distancemax` 是 1 不是 256，`sizerandom` 是 0.001–1。LWE 其余差异没有逐项对。
- 未查完的项都列在最后。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 前缀 `40e2ce02`，只分析副本，未运行。
- 快照：`D:\Codes\kabegame\ignore\p4\rea\p4a\wallpaper64-2.8.42-p4a.rea-snapshot`。
- 工作文件在 `D:\Codes\kabegame\ignore\p4\rea\p4a\`。
- 没有改仓库，没有提交。
- 标记：【确】已确认（读到代码），【推】推断，【未知】。

---

## 基础

- **正交判定：** 【确】`general.orthogonalprojection` 为对象时，`auto: true` 或 `width`、`height` 都非 0，就置 `scene+0xe0` bit3。随后 `ctx+0x118 |= 0x400`（`0x14018768a`），解析粒子时用它作默认值开关（`FUN_14010daa0`）。下文用「正交值 / 透视值」区分。
- **随机数：** 【确】MT19937，状态在 `ctx+0x1cd0`，构造时取时间做种（`0x14017d6a1`），种子来源细节是【推】。取值公式是 `(u32>>8)·2⁻²⁴·(hi−lo)+lo`。
  - A 区间 `[0,1)`：`ctx+0x20/24`。
  - B 区间 `[1e-5,1)`：`ctx+0x28/2c`。
- **JSON 默认值：** 【确】由 `FUN_1401b8df0`、`FUN_1401b9100` 等在解析前写回 JSON。
- **数学精度：** 【确】`alphafade`、发射方向、blend 用 `rcpps` / `rsqrtps` 近似，相对误差约 3.7e-4。确定性工程比位置时要留余量。`sin` 是 SIMD 多项式实现。

---

## A. 层级

**1. 世界矩阵（`FUN_1401850a0`，虚表 +0x80）【确】**
- 局部矩阵：`col0 = scale.x·R.col0`，`col1 = scale.y·R.col1`，`col2 = scale.z·R.col2`，`col3 = (origin, 1)`，即 `L = T·R·S`。
- 世界矩阵：`W = W_parent · L`（`FUN_14005ecb0`，父在左）。有 `attachment` 时，先经父对象虚函数 +0x78 处理 `L`。
- `angles` 是**弧度**，直接取 sin/cos，没有换算（`FUN_1401dd630`）。`R = Rz(a.z)·Ry(a.y)·Rx(a.x)`，列向量：
  - `c0 = (cy·cz, cy·sz, −sy)`
  - `c1 = (sx·sy·cz−cx·sz, sx·sy·sz+cx·cz, sx·cy)`
  - `c2 = (cx·sy·cz+sx·sz, cx·sy·sz−sx·cz, cx·cy)`
- 缓存按 `scene+0x144` 的版本号，惰性递归计算，所以和数组顺序无关。

**2. 继承【确】**
- `visible`：继承。有效可见 = 自身 bit0 且所有祖先可见（`FUN_140185010`）。
- `alpha`、`color`、`brightness`：不继承。图像绘制直接读自身的 `+0x33c`、`+0x330`、`+0x340`（`0x140207a2b`、`0x140207b50`、`0x140208670`）。
- `brightness` 只在 `ctx+0x118 & 0x2000`（后处理 ultra）时生效。写入的 uniform 是 `color·brightness`，alpha 不乘亮度。
- 粒子同样只用自身的 `instanceoverride`。

**3. 无内容分组节点【确】**
- `FUN_14018ff60` 按 model → particle → image → sprite → 文本 → light → sound → camera → shape 派发。其中文本键的字符串地址是 `0x140488b08`，内容没核对，「文本」是【推】。
- 全都不命中时建基类对象（虚表 `0x14048ec88`，大小 0x2c0）。
- 这种对象读取 `FUN_1401de470`（变换、parent 等），更新和绘制虚函数指向 `0x14000ec30`（单 `ret` 是【推】）。
- 它们也进 `objects` 列表，能当父节点，能用 `visible` 遮蔽子树。

**4. 绘制顺序【确】**
- 默认就是 `objects` 数组顺序，不按层级重排（`0x14018aedf`）。
- 跳过 `+0x120 & 2` 的对象和不可见对象。
- `customsortorder` 为真且 `transparentsorting` 为假时（`scene+0xe0 & 0x3000 == 0x2000`），复制列表后按 `sortorder` 升序**稳定**排序（比较器 `0x140186980`）。
- `transparentsorting` 且非正交（`& 0x1008 == 0x1000`）走另一条路径，未展开。
- **子在父前：** 无影响。第一遍取不到的 parent 在第二遍补上（`0x140187fb0`）。
- **父不存在：** 保持无父，当根节点。
- **`parent` 指向自己：** 忽略。
- **`parent` 取值：** 只认数字，按 id 比对。
- **循环引用：** 第二遍先清后又重设（`0x14018800a`→`0x140188026`），指针环还在。`FUN_140185010` 等递归没有防环，WPE 大概率栈溢出【推】。Kabegame 自定即可，建议断环。

**5. 组合层**
- 【确】`effects` 只在图像类解析（`FUN_1401e6f50`）。基类分组节点上的 `effects` 不读。
- 【确】`+0x120 bit2` 由图像的 `passthrough: true` 置位（`0x1401fb333`）。
- 【确】有 bit2 或 bit1 的对象，子孙都置 bit1（`FUN_1401dd9a0`），被顶层遍历跳过，由组合父对象负责绘制。父对象内部路径未读。
- 【确】嵌套限制：祖先中的组合层数加子树深度必须小于 4，否则拒绝设 parent（`FUN_1401de750`）。
- 【确】`disablepropagation` 是 `+0x120 bit14`，`clampuvs` 是图像 `+0x304 bit15`，默认值是 `+0x120 = 0x2001`。
- 【未知】这两个键的语义：读取点没找到。

**6. 与父变换的关系**
- `size`（`+0x2f0`）：不进 `FUN_1401850a0`，不影响子对象。父的 `scale` 经矩阵作用于子。【确】
- `alignment`：图像层没有读。字符串的引用是视频壁纸、文本等，文本是 `0x1402110be`。图像解析段 `0x1401fa8e2–0x1401fb400` 没有这个键，其余引用点只按所属函数判断，没有全部展开。【确，有界搜索】
- `parallaxDepth`（`+0x170`，默认 `1 1`）【确】：只在正交且 `cameraparallax` 时用（`scene+0xe0 & 0x108 == 0x108`，`0x14018b047`）。
  - 先走到**根祖先**。
  - `Δ = (root.origin.xy − scene+0x340) · cameraparallaxamount · root.parallaxDepth`。
  - 只平移视图矩阵，并存到 `obj+0x178`。
  - 子对象用根的值，自身的 `parallaxDepth` 不起作用。

---

## B. 第一批模块

### 发射数量（`FUN_1402378a0`，每个 emitter、每帧）【确】

字段：
| 字段 | 默认 |
|---|---|
| `rate` | 10 |
| `duration` | 0（不限） |
| `delay` | 0 |
| `instantaneous` | 0 |
| `flags` | 0 |
| `minperiodicduration` / `maxperiodicduration` | 2 / 3 |
| `minperiodicdelay` / `maxperiodicdelay` | 1 / 2 |
| `maxtoemitperperiod` | 0 |

- `flags` 位：bit0 用 `sign`，`sign` 非零时自动置位；bit1 每帧最多发 1 个；bit2 周期发射；bit31 内部表示已结束。

```
只有 存活 < 容量 且 未结束 且 delay ≤ 0 才进：
  n0 = pending_instantaneous + 脚本数量; pending = 0
  x  = rate·dt + acc
  x < 1：              acc = x − n0
  否则：k = floor(x);  acc = x − (k + n0)
        bit1 时 k = min(1, k);周期且 maxtoemit≠0 时再限额
        n0 += k
实际发射 = min(n0, 容量 − 存活)
帧尾：delay > 0 → delay −= dt
      否则 duration > 0 → duration −= dt，≤0 时置 −1 并标记结束
      否则 rate ≤ 0 且（instantaneous == 0 或非周期）→ 标记结束
```

要点：
- `instantaneous` 从 `acc` 里扣，`acc` 会变负，之后的连续发射要等这笔还完。
- 满容量时不进这段，`acc` 不累积，溢出的数量不退回。
- `dt` 是 `dt'`，发射不受两遍模式影响。

### `sphererandom`【确】

`FUN_1401b9100` 默认值：
| 字段 | 默认 |
|---|---|
| `origin` | `0 0 0` |
| `directions` | `1 1 0` |
| `sign` | `0 0 0` |
| `distancemin` | 0 |
| `distancemax` | 正交 256，透视 1 |
| `speedmin` / `speedmax` | 0 / 0 |
| `controlpoint` | 0（上限 7） |
| `cone` | 0 |

每粒子按此顺序抽随机：
1. `φ = 2π·uB`
2. `cosθ = uA·(1−c)+c`，其中 `c = −cos(π·cone)`。`cone=0` 全球，`0.5` 半球，`1` 只剩 +X。
3. `r = cbrt(uB)`
4. `p = (r·cosθ, sinφ·r·sinθ, cosφ·r·sinθ)·directions`，`len = |p|`，`û = p·rcp(len)`
5. `sign[i]≠0` 时强制 `û[i]` 与之同号，幅度不变。
6. `q = (distancemin + (distancemax−distancemin)·len)·û`。注意这里用 `len`，不是 `r`。
7. 若 `flags&1` 或 `controlpoint≠0`：`q = M_cp·(q,0)`，只有旋转缩放。
8. **位置列：** `q + cp.平移 + origin`。`origin` 不经过 `M_cp`。
9. **速度方向：** `|q|² < 1e-4` 时另抽 3 个 uB，取 `(2u−1)·directions`，同样过 `M_cp`；否则就是 `q`。
10. **速度列：** `(speedmin + (speedmax−speedmin)·uB)·rsqrt(|dir|²)·dir`，三轴共用一个随机。

用到的列：`x y z vx vy vz`。写完后调 initializer，存活数加一。

### initializer【确】

入口先抽 `R = uA`（共用列），再写默认值，再按 JSON 顺序执行。下面的 `t` 都是 `uA`；`exponent≠1` 时 `t = pow(t, exponent)`（`powf` 是【推】）。

| 模块 | 默认 | 公式 | 列 |
|---|---|---|---|
| `lifetimerandom` | `min 0, max 1, exponent 1` | `life = max(0.001, min + t·(max−min))`，绝对写入 | life |
| `sizerandom` | 正交 `5..50`，透视 `0.001..1`，`exponent 1` | `size0 *= min + t·range`，`size0` 初值 0.5 | size0 |
| `colorrandom` | `min 0 0 0, max 255 255 255, exponent 1`（解析时 ÷255） | `rgb0 *= min + t·range`，**三通道共用一个 t** | r0 g0 b0 |
| `velocityrandom` | 正交 `−32 −32 0 .. 32 32 0`，透视 `−1 −1 −1 .. 1 1 1`，`exponent 1` | 三轴独立，抽取顺序 **z、y、x**，经 `mat3(cp)` 后**加**到速度 | vx vy vz |
| `rotationrandom` | `min 0 0 0, max 0 0 6.28318530717, exponent 1` | 三轴独立，顺序 x、y、z，`rot[i] += min+t·range`。`min`/`max` 写成数字时只作用于 z | rot xyz（置 bit0） |
| `angularvelocityrandom` | `min 0 0 −5, max 0 0 5, exponent 1`（只接受字符串） | 同上，加到角速度 | 角速度 xyz（置 bit1） |

### operator【确】

每遍开头 `size←size0`，有对应列时 `rgb←rgb0`、`a←a0`。下文 `(h,k)` 是这遍的参数。

共用 blend，四个键：`blendinstart 0, blendinend 0, blendoutstart 1, blendoutend 1`。
```
t = age·rcp(life)
b = clamp((t−is)·rcp(ie−is),0,1) · clamp((oe−t)·rcp(oe−os),0,1)
```
- 只有参数实质非默认时才切到带 blend 的记录类型：`in_end > 0.01` 或 `out_start < 0.99`，并且三个间距里至少一个 > 0.01。
- 解析时 `is ≤ ie−0.0001`，`oe ≥ os+0.0001`。
- 本节模块里 `angularmovement`、`oscillateposition`、`oscillatealpha` 有 blend。

**`movement`**：`gravity 0 0 0, drag 0, flags 0`
```
v' = v + g·h
x' = x + v'·h
v'' = v'·(1 − min(drag·k, 0.99999988))
```
- `flags&1` 且系统非世界空间时：`g = Mᵀ·g`，`M = mat3(当前模型矩阵)`（`0x1401f87e0` 是向量左乘矩阵）。
- 有缩放时不归一化。
- 列：`x v`，有 bit2 时开头把位置拷到上一步位置。

**`angularmovement`**：`force 0 0 0, drag 0`，加 blend，置 bit0、bit1
- 无 blend：`w' = w + f·h`；`rot += w'·h`；`w'' = w'·(1 − min(drag·k, 0.99999988))`
- 有 blend：`w' = w + f·h·b`；`rot += w'·h·b`；`w'' = w'·(1 − b·min(drag·k, 0.99999988))`

**`alphafade`**：`fadeintime 0.5, fadeouttime 0.5`，置 bit4
```
t = age·rcp(life)
t < in  : a *= t·rcp(in)
t > out : a *= (1−t)·rcp(1−out)
其余    : a *= 1
```
- 用的是掩码按位或。`in > out` 且两段同时命中时，结果是两个浮点数按位或的值，这是实现细节。

**`oscillateposition`**：`mask 1 1 0, frequencymin 1, frequencymax 5, scalemin 0, scalemax 正交 10 / 透视 0.5, phasemin 0, phasemax 2π`，加 blend
```
ω = fmin + R·frange
t = age + pmin + R·prange
s = smin + R·srange（有 blend 时 s *= b）
D(τ) = sin(ω·τ) − sin(ω·(τ−h))
x += s·mask.x·D(t)
z += s·mask.z·D(t)
y += s·mask.y·D(t + 2π·R)
```
- 相位加在时间上，不是加在 `ωt` 上。
- y 比 x、z 多一个 `2π·R` 的时间偏移，x 和 z 同相。
- 不读速度。列：`age R x y z`。

**`oscillatealpha`**：`frequencymin 1, frequencymax 10, scalemin 0, scalemax 1, phasemin 0, phasemax 2π`，加 blend，置 bit4
```
ω、t 同上
V = smin + R·srange·(1 + sin(ω·t))/2
无 blend：a *= V
有 blend：a *= 1 − (1−V)·b
```
- 幅度里还乘了一次 `R`，所以 `srange` 被每粒子缩放。

### renderer `sprite`【确】

- `renderer` 为空时自动补一个 `sprite`（`0x1401c58af`）。
- 字段：`orientation` 默认 `"screen"`（0），`"upright"`=1，`"fixed"`=2；还有 `axis`、`flags`。
- 这三个字段走同一个解析函数 `FUN_1401c22e0`，trail、rope 也用它。
- 非默认朝向的几何没有读。P4a 可以先把非 `screen` 报不支持。

---

## C. 其它语义

**1. `starttime`【确】**
- 粒子对象加载完成时同步执行（`FUN_14022feb0` → `FUN_14022ebe0` 尾部，内联）。**一次跑完，不分帧**。
- 步长 `maxcount < 500` 时 0.05，否则 0.2。循环 `while t < starttime`，步数等于 `ceil(starttime/步长)`。每步调 `FUN_140236cd0(sys, 步长, emit=1)`，发射开启。
- 预热期间清掉 `sys+0x41`（关掉事件子系统相关处理），结束后恢复。
- 两遍分支：读 `ctx+0x148`。第一次加载时这个值是构造默认 0，所以是一遍；`ctx.dt` 也是 0，`min(1, 0.025/0)=1`，`k0 = 步长`。这一段是【推】，按「加载早于第一帧」的代码顺序推出。
- 没有读到系统重用的情形。子系统的预热入口在 `0x14022f430`。

**2. `rate` 与 `maxcount`【确】**
- 容量等于 `maxcount`，不受 `count` 影响，缺失时为 0，不分配。
- 分配按 4 对齐，有效容量仍是 `maxcount`。
- 满容量行为见 B。

**3. 粒子 `flags`（低 8 位）**

| 位 | 含义 | 证据 |
|---|---|---|
| bit0 = 1 | 世界空间：控制点乘模型矩阵，绘制时模型矩阵换成 `ctx+0xaf0`，不乘对象矩阵 | 【确】 |
| bit1 = 2 | `animationmode: randomframe` 时也会置位，读取点没找到 | 【未知】 |
| bit2 = 4 | 透视覆盖，见下；另外 `def+4 = 0x80` | 用途【确】，`def+4` 【未知】 |
| bit3 = 8 | 禁用 `colorn`、`brightness` 覆盖 | 【确】 |
| bit4 = 0x10 | 禁用 `speed` 覆盖 | 【确】 |
| bit5 = 0x20 | 禁用 `count` 覆盖 | 【确】 |
| bit6 = 0x40 | 禁用 `lifetime` 覆盖 | 【确】 |
| bit7 = 0x80 | 禁用 `size` 覆盖 | 【确】 |

- 高位内部用：`0x200000` 表示材质没有 `hascolor` 或场景 `version` 低于 5（rea-p4b-render.md 7.4 更正，原写「设备档位」）；`0x10000` 绳；`0x1000000` 帧序列。

**4. 透视投影（`FUN_1401e5b60`，`flags&4` 时在绘制期调用）【确】**
- 压栈 view、projection，绘制后恢复。**正交场景里也能用**，这正是主要用途。
- `d = (1/P[1][1]) / tan(fov/2)`，`P` 是当前投影。这样 `z=0` 平面和正交画面完全重合。
- `view.t.x −= W·ctx+0xf8`，`view.t.y −= H·ctx+0xfc`，`view.t.z = −d`。无裁剪时两个比率是 0.5，相机在场景中心。
- 投影：`perspective(fov, aspect, near=5, far=max(15000, d+1000))`。`aspect = ctx+0x74/ctx+0x78`，这两个值是【推】视口宽高。
- `fov` 来源：正交场景 `ctx+0x110 = radians(perspectiveoverridefov)`（默认 **95**）。`scene+0x148` 钳到 `[0.1, 179.9]`。
- `nearz`（默认 0.1）、`farz`（默认 10000）、`fov`（默认 50）：只用于透视场景自身的相机，不参与这里。
- 透视场景走另一分支，`ctx+0x110 = 2·atan((1/P11)/2000)`。
- `ctx.flags & 0x800` 时翻转投影的 x 和 y 列，这个位的含义【未知】。

**5. `instanceoverride`（基址 `obj+0x778`，属性表 `FUN_14024d940`）【确】**

| 键 | 偏移 | 默认 | 作用 |
|---|---|---|---|
| `alpha` | +0xc8 | 1 | 写入 `sys+0x3ec`，作为**新粒子** `a0` |
| `size` | +0xcc | 1 | `sizerandom`、`sizechange` 的 min/max 乘它 |
| `count` | +0xd0 | 1 | 各 emitter 的 `rate`、`maxtoemitperperiod` 乘它，不改 `maxcount` |
| `speed` | +0xd4 | 1 | 乘发射 speed、`velocityrandom`、`movement.gravity`、`angularmovement.force`、`angularvelocityrandom`、`oscillateposition` 频率、`turbulence` 等 |
| `lifetime` | +0xd8 | 1 | `lifetimerandom` 的 min/max 乘它 |
| `rate` | +0xdc | 1 | **整个模拟时间缩放**，`dt' = dt·rate`，下限 0.01；也作 `turbulence` 时间比例 |
| `brightness` | +0xe0 | 1 | 仅 HDR 且无 flags bit3：实例颜色三通道乘它 |
| `colorn` | +0xe4 | `−1 −1 −1`（未设） | 见下 |
| `color` | | | 0–255 的字符串，加载时 ÷255 转成 `colorn` 并删除原键 |
| `controlpoint0..7`、`controlpointangle0..7` | +0xf0、+0x150 | FLT_MAX（未设） | 属 P4c |

- **`colorn`：** 与粒子 JSON 里的 `colorn` 差异不小于 0.0035294117 才生效。
  - `flags & 0x200000` 时作实例颜色。
  - 否则由 `colorrandom` 等记录转 HSV，按差值平移色相和饱和度后再转回（`FUN_1401d15a0` 的 `case 0xb`）。这部分读得不完整，细节可能有误。
- **运行时改值：** 属性 setter 回调 `0x14022ab30` 置 `obj+0x928`。下次 `FUN_140230650` 调 `FUN_14022bd40(sys,1)` 重算，从基值重新乘，不累乘。子系统一并重算。
- **`rate` 钳制：** 只在脏时做。
- **已结束 emitter：** `param_2=1` 时，`rate>0` 的已结束 emitter 会被重新打开。
- **脚本名字：** 脚本侧叫 `instance`（`FUN_14024cb00`）。

**6. 绘制和混合**
- 【确】粒子之间不排序，按槽序写顶点。
- 【确】`blending` 是材质 pass 的属性表（`FUN_1401577e0`，pass+0x1f0），和图像层共用，粒子走同一个 pass 绑定 `FUN_140155fc0`。
- 【确】材质需要 `_rt_FullFrameBuffer` 时（pass+0x1fc bit1），每对象每帧拷一次，靠 `obj+0x93d` 防重。
- 【未知】`blending` 各取值到混合状态的具体映射本轮没有重读。现有实现照 LWE，与 WPE 是否一致要实测。

**7. 风和重力键【确，有界】**
- 实际键名：`gravitydirection`（`scene+0x3e4`，默认 `0 −1 0`）、`gravitystrength`（+0x3f0，默认 1）、`windenabled`（+0xe0 bit16）、`winddirection`（+0x3f4，默认约 `0.707 0.707 0`）、`windstrength`（+0x400，默认 1）。
- 都只在 `FUN_140199780` 的属性表里。
- 全二进制搜 `+0x3e4`、`+0x3f4` 的读取，1401/1402 段搜 `+0x3f0`、`+0x400`，都只命中场景构造函数和粒子 `sys` 的同名偏移，没有引擎消费点。
- `windenabled`：搜 `0xe2` 和 `0x10000`，只有 getter（`0x14019cb50`）。
- 字符串里没有对应的 shader 常量。
- 粒子路径完全不碰它们，`movement` 的重力只来自模块自己的 `gravity`。
- 结论：对粒子中性，且未发现其它引擎消费者【推】。边界：无法排除经属性表被脚本读取。

**8. 重新加载与属性变化**
- 【确】改 `instanceoverride`：不清粒子，存活粒子保留已有的 life、颜色、尺寸。新值只影响之后出生的粒子，以及每帧现算的参数，如 `rate`。
- 【确】对象重建时重新分配并预热：`FUN_14022c3c0` 分配，`FUN_14022ebe0` 预热。
- 【确】不可见时：`emit=0`，还有存活粒子就清空系统和子系统（`0x14023068e`）。emitter 计时由 `FUN_14022f6c0` 复位。重新可见时重新发射，**不重新预热**。这是读码结论，未实测。
- 【未知】WPE 改用户属性时是否触发整场景重载。属性绑定在 `FUN_1401730d0` 注册，从结构看走绑定就地更新【推】。

---

## 未查完 / 未解决

- A5 `disablepropagation`、`clampuvs` 的读取点。
- 组合层父对象如何绘制子对象。
- `transparentsorting` 路径。
- 循环引用的实际结果（崩溃是【推】）。
- C3 bit1、`def+4=0x80`、`0x200000` 的完整用途。
- C4 `ctx.flags & 0x800`、`ctx+0x74/78`。
- C5 `colorn` 与 `colorrandom` 的 HSV 细节。
- C6 `blending` 取值映射。
- C8 用户属性是否重载。
- `sprite` 的 `upright` / `fixed` 几何。
- `cp[0]` 初值默认是单位阵加 `offset`，这是【推】，`FUN_14022c3c0` 的控制点段没逐行读。
- 全部结论都没有实测，建议优先用确定性工程验证三项：透视粒子的 `d`、`oscillateposition` 的 y 偏移、`instantaneous` 欠账。
