> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。只读码，没有实测；实测核对写进 [p4-particles-REPORT.md](p4-particles-REPORT.md)「P4d 语义的实测核对」。本文件覆盖子计划步骤 0a 的 rope 一份，模块见 `rea-p4d-modules.md`。

# WPE 2.8.42 P4d 绳的绘制静态逆向（rope、ropetrail）

**概括**
- **rope 恒走厚格式**【确】：每段一个点，96 字节。段 k 连接 rope 表里的第 k、k+1 个粒子，`k = 0 … 存活数 − 2`；存活数 ≤ 1 时不写也不画。两端的位置、尺寸、颜色各取各的。样条控制点 `in_SplineCP0` 取 `idx[k−1]`、`in_SplineCP1` 取 `idx[k+2]` 的位置，首段 CP0 取起点自身，末段 CP1 取终点自身。尺寸原样写，GS 在 `±size` 处出顶点，所以带宽是 `2·size`，是同尺寸 sprite 的两倍。
- **UV 按下标，不按长度**【确】：`a_TexCoordVec4.w = TL`，`a_TexCoordVec4C1.w = k + TP0`，着色器 `v = 1 − (k + TP0)/(TL − 1)`。
  - 缺省 `TL = 存活数 / uvscale`，`TP0 = 0`。
  - `uvsmoothing`（**缺省 true**）在 `存活数 ≥ N − 1` 时把 `TL` 换成 `(N − 1)/uvscale`，`TP0 = saturate((L − age最老)·Rf) − 1`。
  - `uvscrolling` 恒用 `(N − 1)/uvscale`，`TP0 = 累计死亡数`。
  - `N = Rf·L`。`L` 是第一个 `lifetimerandom` 的中点，`R` 是第一个 rate 非零的 emitter 的 `rate`，两者乘 `instanceoverride` 的 `lifetime`、`count`；`R·L > 存活数` 时 `Rf = min(fps, R)`，否则 `Rf = R`。读 `fps` 的就是这里。
  - 存活数正好是 2 时 `TL = 2`、`TP0 = 0`，不乘 `uvscale`，不平滑也不滚动。
- **rope 表 `sys+0x218` 是 `std::vector<u32>`，存槽号，表序就是出生序**【确】：发射时 `push_back`，判死后逐个线性查找并保序删除（`memmove`）。预热、两遍模式下照常维护，清空系统时一起清。`sys+0x350` 累计死亡数，只给 rope 的 `uvscrolling` 用。
- **缺省值**【确】：
  - rope：`subdivision 4`、`uvsmoothing true`、`uvscrolling false`、`uvscale 1`；
  - ropetrail：`length 1`、`segments 4`、`subdivision 1`、`uvscale 1`、三个开关 false。
  - 正交、透视同一套。
  - 钳制：`subdivision` 两类都钳到 `[0, 32]`，`segments` 钳到 `[2, 32]`，`length` 至少 0.001；`uvscale` 存成倒数，写 0 时不改。
- **宏**【确】：两类都把着色器无条件换成 `genericropeparticle`，并写 `TRAILSUBDIVISION`、`ORIENTATION`，格式 8–11 时写 `TEX0FORMAT`。
  - rope 另写 `THICKFORMAT=1`。
  - ropetrail 另写 `TRAILRENDERER=1`；`uvscrolling` 时写 `TRAILSCROLLALPHA=1`；`fadealpha`、`fadesize` 写 `TRAILFADEALPHA`、`TRAILFADESIZE`，不写 `THICKFORMAT`。
  - 都不写 `SPRITESHEET*`。
- **系统 `flags`**【确】：rope `uvscrolling` 是 `0x20000`，`uvsmoothing` 是 `0x40000`，ropetrail `uvscrolling` 是 `0x80000`（rea-p4b-render 1.3、2.3 写成「rope uvscrolling」，要更正）。`0x10000` 是「有 rope 且没有别的 renderer」，唯一作用是让基础材质也用 `genericropeparticle`。
- **ropetrail 历史**【确】：
  - 计时器每系统一个，在顶点函数里减 `dt'`，`≤ 0` 时重置为 `length/segments`，余量丢掉；每帧最多采一次。
  - 采样把每个存活粒子的历史整体后移一格，0 号写本帧模拟后的位置，新的在前，已存段数 `+1` 封顶 `segments`。
  - 出生时全部历史写出生位置，已存段数 = 1；预热不采样，预热完把所有历史塌缩到当前位置。
  - 每个粒子恒写 `segments` 段，未填满的段退化成零长【推：NaN，不画】。
  - `fadealpha`、`fadesize` 只在 `uvscrolling` 时有效，着色器只在 `TRAILSCROLLALPHA` 分支读这两个宏。
- **绘制**【确】：拓扑是 `POINTLIST`，加 GS（建缓冲 `mode 2` → D3D 拓扑 1）。每个 rope / ropetrail 绘制前都调 `FUN_1402298b0` 算 `g_Orientation*`。
  - rope 写 `RV0.z = 0`、`RV0.w = 存活数`，rope 分支不读这两个值。
  - ropetrail 写 `RV0.z = 1 − max(timer, 0)/interval`；`RV0.w = segments − 0.5`，`uvscrolling` 时改为 `(segments − 1)/uvscale`，并写 `RV0.x = segments − 1`。
- **世界空间、透视**【确】：顶点就是模拟空间的列值。世界空间系统绘制时模型矩阵是 `ctx+0xaf0`（平时单位阵），同 sprite。透视粒子只覆盖视图与投影，`ORIENTATION 0` 用的 `g_EyePosition` 仍是场景的【推，同 rea-p4c-render 6.4】。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。拷到本会话 scratchpad 后只读分析，没有开 REA 会话，没有运行 WPE。
- 方法：`ignore/p4/rea/wp.asm`（llvm-objdump 全量）按地址切片，加脚本，加 WPE 着色器原文（`assets/shaders/genericropeparticle.{vert,geom,frag}`、`common_particles.h`，只读）。`FUN_1401c5490` 读汇编。
- 工作文件在 `D:\Codes\kabegame\ignore\p4\rea\p4d-rope\`：
  - 切片：`vtx_full.asm`（`FUN_1402308a0` 全文）、`parser.asm` / `rend_parse.asm`（解析）、`def_rope.asm` / `def_ropetrail.asm`（缺省）、`defctor.asm`（def 构造）、`sim_head.asm`（模拟开头与 rope 表删除）、`emit.asm`（发射）、`d2340.asm`（变体与缓冲）、`draw.asm`（`FUN_1402366f0`）、`buf.asm`（动态缓冲）、`mat.asm` / `mload.asm` / `pass.asm`（材质加载）、`sph.asm`。
  - 脚本：`d.py`（切片）、`fn.py` / `pdata.py`（函数边界）、`grepoff.py`（按偏移扫引用）、`bits.py`（flags 高位读者）、`ints.py`（常量表按 int 读）、`findstr.py` / `findsub.py` / `ptrtab.py`（字符串与指针表）、`predict.py`（本文实验的 float32 预测）。`pe.py` 读的是本会话 scratchpad 里的副本，重跑前改 `P`。
- 没有改仓库代码和别的计划文件，没有提交。
- 标记：【确】读到代码；【推】推出、没逐行确认；【未知】没读到。
- 命名沿用前几份：
  - `ctx` = R+0x10，`sys` = obj+0x2c0，`def` = 解析出的系统定义（`sys` 偏移 = `def` 偏移 + 0x18），`io` = `instanceoverride` 基址 obj+0x778。
  - `rec` = renderer 记录（`+0` 类型，`+2` 长度），`p` = rec+4。
  - `idx` = rope 表，`h[i][j]` = 粒子 i 的第 j 个历史位置，`n` = `segments`，`K` = `sys+0x30` = 1/`uvscale`。
  - 列：位置 `0x2b0/0x2b8/0x2c0`，size `0x270`，颜色 `0x2f8/0x300/0x308`，alpha `0x310`，age `0x258`，life `0x260`。

---

## 1. rope 的段顶点（`FUN_1402308a0` 的 rope 路径）

### 1.1 入口与段数【确】

```
FUN_1402308a0(sys, dt', emit):                       // 0x1402308a0
  sys+0x3f0 += dt'; if dt' > 0: FUN_140236cd0(...)   // 先模拟（发射、判死、operator）
  if 存活数 == 0: 全部跳过（含 ropetrail 计时器）      // 0x140230911
  buf = sys+0x208                                     // 0x140230919
  if buf && 存活数 > 1:                               // 0x140230958、0x140230961
      count = GS ? 存活数 − 1 : 4·(存活数 − 1)          // 0x14023096c–0x140230989
      map(buf, count)                                 // 0x140230991
      …算 TL、TP0（1.2）…
      GS: 存活数 == 2 → 特例；否则 首段 + 中段循环 + 末段   // 0x140230aa3
      非 GS: 0x14023114a 起，同样三段，每段 4 个顶点
      unmap                                           // 0x140232c9a
  → ropetrail（第 5 节）→ sprite 缓冲 sys+0x1f8 → 子系统
```

- 段 k 连接 `idx[k]` → `idx[k+1]`，`k = 0 … 存活数 − 2`，共 `存活数 − 1` 段，按 rope 表顺序写。
- 存活数 ≤ 1 时不 map、不写，绘制也跳过（4）。

### 1.2 `TL` 与 `TP0`（读 `fps` 的那段，`0x1402309b0`–`0x140230a84`）【确】

```
io = FUN_1402298a0(sys[1])                    // = obj+0x778
R  = sys+0x1c0 · io+0xd0                      // 第一个 emitter 的 rate × instanceoverride.count
L  = sys+0x1bc · io+0xd8                      // 第一个 lifetimerandom 的中点 × instanceoverride.lifetime
Rf = (R·L > 存活数) ? min((float)fps, R) : R   // fps = *(ctx+0x148)，0x1402309f8
N  = Rf · L
if flags & 0x20000:                           // rope uvscrolling，0x140230a1b
    TL = N − 1;  TP0 = (float) sys+0x350      // 累计死亡数
else:
    TL = 存活数; TP0 = 0
    if N > 0 && !(存活数 < N − 1) && flags & 0x40000:   // uvsmoothing，0x140230a4c
        TL  = N − 1
        TP0 = saturate((L − age[idx[0]]) / (1/Rf)) − 1  // FUN_1401d8df0 = min(1, max(0, x))
TL *= K                                       // K = sys+0x30 = 1/uvscale，0x140230a84
```

- `R`、`L` 的来源见 3.2。乘 `io` 两项不看系统 `flags` 的 bit5、bit6（禁止 `count`、`lifetime` 覆盖的位）。
- `(L − age)/(1/Rf)` 是先求倒数再除，不是直接乘 `Rf`。
- 比较都是 `comiss`。`存活数 < N − 1` 用 `jb`，相等时进平滑分支。
- `uvsmoothing` 的含义【推】：绳满了以后长度按「期望粒子数」算，最老的一段随最老粒子的年龄平移最多一格，粒子死去时纹理不跳。`TP0` 从 0（刚有粒子死去）走到 −1（最老的粒子 age = L）。
- `uvscrolling` 的含义【推】：`TP = k + 死亡数` = 该粒子的出生序号，纹理钉在粒子上随绳移动。
- 读 `fps` 的作用：绳还没满（`存活数 < R·L`）时把期望数估成 `min(fps, R)·L`。这只影响 `uvsmoothing`、`uvscrolling` 的 `TL`。例：`rate 100`、`lifetime 0.5`，fps 60 时填充期 `TL = 29`，fps 10 时 `TL = 4`（`predict.py`）。
- 存活数 = 2 的特例（`0x140230f8e`）：`TL = (float)存活数 = 2`，`TP = 0`，不乘 `K`，也不看 `0x20000`、`0x40000`。

### 1.3 顶点布局【确】

元素代码来自 `FUN_1401d2340` 尾部（3.5），名字表在 `0x140484a90`（0 `a_Position`、1 `a_PositionVec4`、9 `a_TexCoordVec4`、12 `a_TexCoordVec4C1`、14 `a_TexCoordVec3C2`、15 `a_TexCoordVec4C2`、16 `a_TexCoordC3`、18 `a_TexCoordVec4C3`、19 `a_TexCoordC4`、25 `a_Color`）。写入偏移和元素顺序逐项对得上。

**rope，GS 厚格式，96 字节 / 段**（`sys+0x208`，元素 `1, 9, 12, 15, 18, 25`）：

| 偏移 | 属性 | 着色器名 | 写入内容 |
|---|---|---|---|
| `+0x00` | `a_PositionVec4` | 起点、`in_ParticleSize` | `pos[idx[k]]`，`size[idx[k]]` |
| `+0x10` | `a_TexCoordVec4` | 终点、`in_ParticleTrailLength` | `pos[idx[k+1]]`，`TL` |
| `+0x20` | `a_TexCoordVec4C1` | `in_SplineCP0`、`in_ParticleTrailPosition` | `pos[idx[k−1]]`（k = 0 时 `pos[idx[0]]`），`k + TP0` |
| `+0x30` | `a_TexCoordVec4C2` | `in_SplineCP1`、终点尺寸 | `pos[idx[k+2]]`（末段 `pos[idx[k+1]]`），`size[idx[k+1]]` |
| `+0x40` | `a_TexCoordVec4C3` | 终点颜色 `v_Color2` | `rgba[idx[k+1]]` |
| `+0x50` | `a_Color` | 起点颜色 | `rgba[idx[k]]` |

**ropetrail，GS 非厚格式，76 字节 / 段**（`sys+0x200`，元素 `1, 9, 12, 14, 25`），内容见 5.3：

| 偏移 | 属性 | 写入内容 |
|---|---|---|
| `+0x00` | `a_PositionVec4` | 段起点，`size[i]` |
| `+0x10` | `a_TexCoordVec4` | 段终点，`w` 见 5.3 |
| `+0x20` | `a_TexCoordVec4C1` | CP0，`w` 见 5.3 |
| `+0x30` | `a_TexCoordVec3C2` | CP1（vec3） |
| `+0x3c` | `a_Color` | `rgba[i]` |

非 GS 布局（WPE 实际不走，见 6）：
- rope 104 字节 / 顶点：元素 `1, 9, 12, 15, 18, 19, 25`，`+0x50` 是 `a_TexCoordC4`（uv），`+0x58` 是 `a_Color`；
- ropetrail 84 字节 / 顶点：元素 `1, 9, 12, 14, 16, 25`，`+0x3c` 是 `a_TexCoordC3`，`+0x44` 是 `a_Color`。

每段 4 个顶点，属性相同，只有 uv 依次是 `(0,0) (0,1) (1,1) (1,0)`，配四边形索引 `0 1 2 0 2 3`（`FUN_140261250`）。

### 1.4 首段、中段、末段【确】

```
// 存活数 ≥ 3（0x140230aaf–0x14023113e）
seg 0:          a=idx[0] b=idx[1] c=idx[0] d=idx[2]            TP = TP0
seg k (1…n−3):  a=idx[k] b=idx[k+1] c=idx[k−1] d=idx[k+2]      TP = k + TP0   // 循环 0x140230c80
seg n−2（末段）: a=idx[n−2] b=idx[n−1] c=idx[n−3] d=idx[n−1]    TP = (n−2) + TP0
写: PosVec4 = (pos[a], size[a]); TexVec4 = (pos[b], TL); C1 = (pos[c], TP);
    C2 = (pos[d], size[b]); C3 = rgba[b]; Color = rgba[a]
// 存活数 == 2（0x140230f8e）
seg 0: a=idx[0] b=idx[1] c=idx[0] d=idx[1]，TL = 2，TP = 0
```

（这里 `n` = 存活数。）

### 1.5 着色器侧（`genericropeparticle.vert` 的 GS 分支 + `.geom`）【确，着色器源码】

```
// VS（GS_ENABLED）
gl_Position = (start, sizeStart);  v_EndPoint = (end, sizeEnd)    // THICKFORMAT
v_Color = Color;  v_Color2 = C3
usable = TL − 1;  uvMin = 1 − TP/usable;  uvDelta = −1/usable     // rope 走 #else 分支
v_UVMinMax = (uvMin, uvMin + uvDelta)
v_CPStart = end − CP0            // = p[k+1] − p[k−1]，起点切线（中心差分）
v_CPEnd   = start − CP1          // = −(p[k+2] − p[k])
// GS，[maxvertexcount(4 + 2·TRAILSUBDIVISION)]，输入一个点
eye = ORIENTATION == 0 ? normalize((start + end)/2 − eyeModel)    // eyeModel = (g_EyePosition,1)·g_ModelMatrixInverse
                       : g_OrientationForward · mat3(g_ModelMatrixInverse)
R0 = normalize(cross(eye, v_CPStart)) · sizeStart
R1 = normalize(cross(eye, −v_CPEnd))  · sizeEnd                   // 源码写作 trailDelta − (CPEnd + trailDelta)
B1 = start + 0.15·v_CPStart;  B2 = end + 0.15·v_CPEnd             // 三次贝塞尔的两个内控制点
输出（三角形带）:
  start − R0 (0, uvMin)   start + R0 (1, uvMin)      颜色 colorStart
  for j = 1…SUB:  s = smoothstep(0, 1, c_j)，c_j = 逐次累加 1/(SUB+1)
      m = bezier(start, B1, B2, end, s);  Rm = mix(R0, R1, s)
      m − Rm (0, mix(uvMin, uvMax, s))    m + Rm (1, …)          颜色 mix(colorStart, colorEnd, s)
  end − R1 (0, uvMax)     end + R1 (1, uvMax)        颜色 colorEnd
```

- 宽度 = `2·size`：`R0`、`R1` 的模就是 `size`，两侧各一个。顶点写的 `size` 是列值原样，没有像 sprite 那样的 `(u − 0.5)`。
- 样条：首段 `v_CPStart = p[1] − p[0]`（前向差分），末段 `−v_CPEnd = p[末] − p[末−1]`。系数是 0.15，不是 Catmull-Rom 的 1/6。
- 细分参数是 `smoothstep` 之后的 `s`，位置、`R`、颜色、`v` 全按 `s` 插值；`c_j` 是 float 逐次相加，不是 `j/(SUB+1)`。
- `R` 依赖眼位：`ORIENTATION 0` 时每段用段中点到眼的方向。正交场景的 `g_EyePosition` 是 `(W/2 + eye.x, H/2 + eye.y, 2000)`，离开视轴时带子会带 z 分量，屏幕宽度小于 `2·size`（同 rea-p4c-render 6.4 的 T7）。
- `ORIENTATION ≠ 0` 时 `eye` 取 `g_OrientationForward`。正交缺省下 `upright` / `fixed "0 0 1"` 的 Forward 是 `(0,0,1)`，与 `ORIENTATION 0` 的 `(…, …, −2000)` 方向相反，所以 `R` 反号，u 的左右对调。
- 零长或切线平行于 `eye` 时 `normalize(0)` 得 NaN【推：D3D11 丢弃含 NaN 顶点的三角形】。
- `REFRACT`、雾、`LIGHTING` 只用 `R` 与 `g_ModelMatrix` 派生量，不改几何。

**实现要点**：
- CPU 照 1.3 / 1.4 写每段一个实例（96 字节就够，不必拆）。
- GS 展开照 1.5；`TRAILSUBDIVISION` 最大 32，一段最多 68 个顶点。子计划写的 36 是语料最大值 16 的情况。
- `normalize(0)` 要显式做成不画（WebGPU 不保证 NaN）。

---

## 2. rope 表（顺序索引）

### 2.1 存放【确】

- `sys+0x218` / `+0x220` / `+0x228` = `std::vector<u32>` 的 begin / end / capacity。元素是粒子槽号。
- 证据：`FUN_1400e4aa0(vec, i)` = `&vec.begin[i]`（`0x1400e4aa0`）；发射处比较 end 与 cap 后 `push_back`；删除处 `end −= 4`。
- 构造函数 `FUN_1402293a0` 置零（`0x14022958c`–`0x1402295a2`）。

### 2.2 出生：追加到尾【确】

三个发射分支在「存活数 + 1、高水位更新」之后都有同一段：

```
if sys+0x208 != 0: idx.push_back(slot)      // 0x1402382e0–0x14023841e、0x140238c12–0x140238c28、0x14023aca3–0x14023ad93
```

- `slot` 就是刚写入的空槽（`r14d`：扫描 `life == 0` 的槽号，`0x140237d47` 起）。
- 同一帧内按 emitter 流顺序、每个 emitter 依次发射的顺序追加。

### 2.3 判死：保序删除【确】

`FUN_140236cd0`：

```
清空死亡列表 sys+0x420                                       // 0x140236cfa
need = (sys+0x41 & 0x14) || sys+0x208 != 0                   // 0x140236d11–0x140236d39
逐 4 个槽: age += dt'; life != 0 && life < age → life = 0, 存活数−−;
           need 时把槽号 push 进死亡列表（槽号升序）            // 0x140236d70 起，FUN_14002ff50
（frame 列更新）
if sys+0x208 != 0:                                           // 0x140237082
    for d in 死亡列表:
        j = 0
        while j < idx.size:
            if idx[j] == d: memmove(&idx[j], &idx[j+1], …); idx.end −= 4   // 0x1402370e7，保序
            else: j++
if 死亡列表非空: sys+0x350 += 死亡数                           // 0x140237146
```

- 删除后不跳出，继续查同一位置，所以重复项也会删光。
- 删除在发射之前，所以同一帧里先删死的、再追加新的。

### 2.4 结论【确】

- 表序 = 存活粒子的出生顺序，与槽号无关。
  - 稳态下槽 0 会被新粒子复用（首个空槽），槽序与出生序不同。
  - 绳从 `idx[0]`（最老）连到 `idx[末]`（最新），`v` 从 1 走到 0，着色器注释「New particles are at the end of the array」。
- **两遍模式**：只影响 operator（`FUN_14023fbc0` 调两次），发射与判死在 `FUN_140236cd0` 里各一次，表不受影响。
- **预热**：`FUN_14022ebe0` 先 `FUN_14022f990` 清空（含表和 `sys+0x350`），再逐步调 `FUN_140236cd0`，所以表照常维护，`sys+0x350` 记下预热期间的死亡数。
  - 前提是预热时 `sys+0x208` 已建好：分配 `FUN_14022c3c0`（`0x14022cd1f` 调 `FUN_1401d2340` 建缓冲）在所有预热调用点之前（`0x14022b408` → 加载完成 `FUN_14022feb0` → `0x14022fefc`；事件子系统 `0x1402374bf` → `0x14023750d`、`0x14023afe0` → `0x14023b031`）【推，按调用顺序】。
- **清空**：不可见时的 `FUN_14022fd90`（`0x14022fdc1`、`0x14022fde7`）和 `FUN_14022f990` 在高水位 > 0 时同时清零高水位、存活数、`sys+0x350`，并清空表。
- `controlpointattract` 的删除是置 `age = life`，下一帧照常进死亡列表（rea-p4c-sim 4.3），不会绕过表。

---

## 3. 字段与宏

### 3.1 解析（`FUN_1401c5490` 的 renderer 循环）【确】

**rope**（`0x1401cff33`，追加器 `FUN_1401d8db0`：类型 3，长度 0x44，返回 `rec+4`）：

```
FUN_1401c22e0(p, json)                     // orientation、axis、flags，同 sprite（rea-p4c-render 7.1）
FUN_1401c0c90(json, …)                     // 补缺省，第二参数不用
*(u64*)p = 0
p+0x38 = clamp(asInt(json["subdivision"]), 0, 32)        // rec+0x3c，0x1401cffcf
def+0x1a4 = L;  def+0x1a8 = R                            // 即 sys+0x1bc、sys+0x1c0，0x1401cffd9（3.2）
u = asFloat(json["uvscale"]); if u != 0: def+0x18 = 1/u   // sys+0x30 = K，0x1401d0026
if asBool(json["uvscrolling"]): flags |= 0x20000          // 0x1401d0060，跳过 uvsmoothing
else if asBool(json["uvsmoothing"]): flags |= 0x40000     // 0x1401d00a4
有 rope = 1
```

**ropetrail**（`0x1401d00bf`，追加器 `FUN_1401d8dd0`：类型 4，长度 0x4c）：

```
FUN_1401c22e0(p, json);  FUN_1401c1070(json, …);  *(u64*)p = 0
p+0x38 = max(asFloat(json["length"]), 0.001)             // rec+0x3c，0x1401d015f
p+0x3c = clamp(asInt(json["segments"]), 2, 32)           // rec+0x40，0x1401d01a0（r15d = 2）
p+0x40 = clamp(asInt(json["subdivision"]), 0, 32)        // rec+0x44，0x1401d01de
p+0x44 = (fadealpha ? 1 : 0) | (fadesize ? 2 : 0)        // rec+0x48
u = asFloat(json["uvscale"]); if u != 0: def+0x18 = 1/u   // 与 rope 共用 sys+0x30
if asBool(json["uvscrolling"]): flags |= 0x80000          // 0x1401d02d1
有别的 renderer = 1                                       // sprite、spritetrail 也置这一位
```

| renderer | 键 | 记录偏移 | 缺省 | 钳制 / 存法 |
|---|---|---|---|---|
| rope | `subdivision` | `rec+0x3c` | **4** | `[0, 32]` 整数 |
| rope | `uvscale` | `sys+0x30`（存 `1/uvscale`） | 1 | 0 时不写，保留 def 构造值 1.0（`0x1401c17c6`）或先前的值 |
| rope | `uvscrolling` | flags `0x20000` | false | 为真时不读 `uvsmoothing` |
| rope | `uvsmoothing` | flags `0x40000` | **true** | — |
| ropetrail | `length` | `rec+0x3c` | 1 | `≥ 0.001` |
| ropetrail | `segments` | `rec+0x40` | 4 | `[2, 32]` |
| ropetrail | `subdivision` | `rec+0x44` | 1 | `[0, 32]` |
| ropetrail | `fadealpha` / `fadesize` | `rec+0x48` bit0 / bit1 | false | — |
| ropetrail | `uvscale` | `sys+0x30` | 1 | 同 rope |
| ropetrail | `uvscrolling` | flags `0x80000` | false | — |
| 两类 | `orientation`、`axis`、`flags` | `rec+0xc` 起 | 同 sprite | 经 `FUN_1401c22e0` |

- 缺省函数 `FUN_1401c0c90`、`FUN_1401c1070`（经 `FUN_1401d7be0` 写整数、`FUN_1401d8120` 写布尔）都不读第二参数（正交 / 透视标志）。两套相同。
- 语料 30 个 rope 里只有 10 个写了 `subdivision`、7 个写了 `uvsmoothing false`，其余吃缺省 4 和 true。

### 3.2 `L` 与 `R` 的来源【确】

- `L`（`[rsp+0x58]`，初值 0）：每个 `lifetimerandom` 解析完后，若当前 `L == 0` 就设为 `min + (max − min)·0.5`（`0x1401c72d0`–`0x1401c72f5`）。即第一个中点非零的 `lifetimerandom`，`exponent` 不参与。没有 `lifetimerandom` 时 `L = 0`，于是 `N = 0`，`uvsmoothing` 不生效。
- `R`（`xmm14`，初值 0，循环后存 `[rbp−0x18]`）：`sphererandom`、`boxrandom` 分支尾部（`0x1401c6ab4`），若 `R == 0` 就设为该 emitter 的 `rate`（`rec+0x10`，`FUN_1401c1c70` 写入，缺省 10）。`layerimage` 不参与。
- 两者在 renderer 循环前装进 `xmm7`、`xmm8`（`0x1401cc543`、`0x1401cc549`），只有 rope 分支把它们写进 `def`。读者只有 1.2 的那段（`0x1402309b5`、`0x1402309c1`）。

### 3.3 系统 `flags` 的相关位【确，有界】

搜索范围：`0x1401b8000–0x1401d9800`、`0x140220000–0x140262000`。搜了立即数 `test` / `and` / `or`、`bt 0x10–0x13`、`shr 0x10–0x13`（`bits.py`）。

| 位 | 置位 | 读者 |
|---|---|---|
| `0x10000` | 有 rope 且没有 sprite / spritetrail / ropetrail（`r14b && !sil`，`0x1401d0403`） | 只用来给基础材质选着色器覆盖 `"genericropeparticle"`：解析 `0x1401d0419`（决定 `0x1000000`、`0x800000` 用的材质）、`FUN_1401d2340` `0x1401d236d`、分配 `FUN_14022c3c0` `0x14022cd59`（写 `sys+0x358`） |
| `0x20000` | rope `uvscrolling`（`0x1401d0060`） | 只有 `0x140230a1b` |
| `0x40000` | rope `uvsmoothing`（`0x1401d00a4`） | 只有 `0x140230a4c` |
| `0x80000` | ropetrail `uvscrolling`（`0x1401d02d1`） | `FUN_1401d2340`（`0x1401d256f` / `0x1401d32d2`：写 `TRAILSCROLLALPHA`、分配 `sys+0x240`）；顶点 `0x140232e2d`（选分支）；绘制 `0x140236982`（`RV0`） |

- 发射函数里的 `test [r15+0x4c], 0x10000 / 0x20000 / 0x40000 / 0x80000`（`0x140238d4f` 等）测的是 emitter 记录自己的 `flags`，不是系统 `flags`。
- `0x1401d086c`、`0x14022e468` 是控制点数组的 `0x10000`，归 `rea-p4d-modules.md`。
- rea-p4b-render 把 `0x80000` 记作「rope uvscrolling」，应为 ropetrail。

### 3.4 变体材质的宏（`FUN_1401d2340`）【确】

类型分发 `0x1401d2590`。`need`：rope `|= 8`，ropetrail `|= 4`；`thick = need & 2` 只管 sprite 两类，不影响 rope 两类。

```
ropetrail（0x1401d25b7–0x1401d29dc）:
  TRAILSUBDIVISION = rec+0x44
  if 格式 ∈ 8..11: TEX0FORMAT = 格式
  ORIENTATION = rec+0xc                         // 0x1401d271b
  TRAILRENDERER = 1
  if flags & 0x80000: TRAILSCROLLALPHA = 1
  if rec+0x48 & 1: TRAILFADEALPHA = 1
  if rec+0x48 & 2: TRAILFADESIZE = 1
  rec+4 = FUN_140150110(材质库, 基础材质路径, 宏, "genericropeparticle")
  if sys+0x230 == 0: sys+0x248 = (u16)rec+0x40;  sys+0x250 = rec+0x3c / (float)rec+0x40   // 0x1401d29ae
rope（0x1401d29e1–0x1401d2bfd）:
  THICKFORMAT = 1                               // 无条件
  TRAILSUBDIVISION = rec+0x3c
  if 格式 ∈ 8..11: TEX0FORMAT = 格式
  ORIENTATION = rec+0xc                         // 0x1401d2b3e
  rec+4 = FUN_140150110(…, "genericropeparticle")
```

- 两类都不写 `SPRITESHEET*`。`0x1000000` 仍可能因纹理置位，但 rope 着色器不读帧表。
- `TEX0FORMAT` 只看格式 8–11，不像非厚格式 sprite 那样也看朝向。
- 值为 0 的宏也写（`ORIENTATION 0`），`#if` 照常判断。
- `sys+0x248` / `0x250` 只在 `sys+0x230` 还没分配时写，而分配在循环之后（`0x1401d3326`）。所以同系统有多个 ropetrail 时生效的是**最后一个**，rea-p4c-render 6.5 写的「第一个」要改【推：多 renderer 不在本节范围】。

### 3.5 缓冲与布局（`FUN_1401d2340` 尾部）【确】

```
if sys+0x248 != 0:                                               // 0x1401d32e3
    N4 = maxcount 上取到 4 的倍数
    sys+0x230 = alloc(segments·N4·12)，清零                         // 历史位置
    sys+0x238 = alloc(2·N4)，不清零（出生时写）                       // 已存段数 u16
    if flags & 0x80000: sys+0x240 = alloc(2·N4)，清零                // uvscrolling 计数 u16
GS（flags & 0x800000，0x1401d336e）:
    need & 4: sys+0x200 = FUN_140261250(布局 [1,9,12,14,25], segments·maxcount, mode 2)
    need & 8: sys+0x208 = FUN_140261250(布局 [1,9,12,15,18,25], maxcount, mode 2)
非 GS:
    ropetrail [1,9,12,14,16,25]、rope [1,9,12,15,18,19,25]，mode 0
```

- 元素表常量：`0x140492c60 = {1, 9, 12, 14}`、`0x140492c70 = {1, 9, 12, 15}`，后面再接 18、19、25（`ints.py`）。
- `FUN_140261250`：mode 0 生成四边形索引（每四边形 `0 1 2 0 2 3`），顶点数 ×4；其它 mode 不建索引。
- D3D11 缓冲构造（`FUN_14009a780` / `FUN_14009a880`，`0x14009a7db`）把 mode 0 / 1 / 其它映射成拓扑 4（TRIANGLELIST）/ 2（LINELIST）/ 1（POINTLIST），存在 `[buf+0x30]`。绘制时 `IASetPrimitiveTopology([buf+0x30])`（`0x1400ea7c0`），再 `Draw([buf+0x2c])`。`[buf+0x2c]` 是最近一次 map 传入的数，map 传 ≤ 0 时保留旧值（`0x1400ea8d0`）。

---

## 4. uniform（`FUN_1402366f0`，`0x14023694f`–`0x140236a39`）【确】

```
type 4 ropetrail（缺省分支，0x14023694f）:
    FUN_1402298b0(ctx, rec+4)                           // g_Orientation*，与 ORIENTATION 无关，总是算
    RV0.z = 1 − max(sys+0x24c, 0) / sys+0x250           // ctx+0xb0
    if !(flags & 0x80000): RV0.w = (float)segments − 0.5
    else:                  RV0.w = ((float)segments − 1) · K;  RV0.x = (float)segments − 1
    绑 rec+4；画 sys+0x200
type 3 rope（0x1402369ed）:
    if 存活数 <= 1: 跳过（不算朝向、不绑、不画）
    FUN_1402298b0(ctx, rec+4)
    RV0.z = 0;  RV0.w = (float)存活数
    绑 rec+4；画 sys+0x208
```

- `RV0.x`、`RV0.y` 对 rope 不写，ropetrail 也不写 `RV0.y`，保留之前绘制写的值。着色器只在 `TRAILSCROLLALPHA` 分支读 `RV0.x`，rope 分支不读 `RV0` 任何分量。
- `g_RenderVar1` 只在 `0x1000000` 时于 renderer 循环前写（rea-p4b-render 2.2），`genericropeparticle` 不读。
- `g_Orientation*` 就是 P4c `orientation.ts` 算的三个（rea-p4c-render 7.2）。绳只用 `g_OrientationForward`，且只在 `ORIENTATION ≠ 0` 时用。

---

## 5. ropetrail 的历史缓冲

### 5.1 初始化【确】

- **出生**（initializer 解释器尾部，`0x14023f953`–`0x14023f9fd`，所有 initializer 之后）：

  ```
  if sys+0x230:
      for j in 0..n−1: h[i][j] = pos[i]      // 出生位置（已含 positionoffsetrandom 等）
      count[i] = 1                            // sys+0x238
      if sys+0x240: U[i] = 0
  ```

- **预热**：`FUN_14022ebe0` 的步进只调 `FUN_140236cd0`，不调顶点函数，所以预热期间历史不采样。结束后（`0x14022f2fc`–`0x14022f3e9`）对 `0..高水位−1` 的每个槽：`count = 1`、`h[i][*] = pos[i]`，`U` 整段清零。
- **计时器**：`sys+0x24c` 构造时为 0（`0x1402295c5` 连同 `0x250` 一起清零），之后只有顶点函数写它；清空系统、预热都不重置。存活数为 0 时计时器停走（5.2），所以第一个粒子出生的那一帧（或预热后的第一帧）就采样。

### 5.2 每帧采样（`0x140232c9f`–`0x140232db8`）【确】

```
if sys+0x200 == 0: 跳过
timer = sys+0x24c − dt'                        // dt' 已乘 instanceoverride.rate
if !(0 < timer):                               // comiss 0, timer; jb → 比较常量就是 0，≤ 0 采样
    timer = sys+0x250                          // 重置为间隔，余量丢掉
    for i in 0..高水位−1, life[i] != 0:
        memmove(&h[i][1], &h[i][0], (n−1)·12)  // 后移一格，新的在前
        h[i][0] = pos[i]                       // 本帧模拟后的位置
        count[i] = min(count[i] + 1, n)
        if sys+0x240: U[i]++                   // u16，不封顶
sys+0x24c = timer
```

- 计时器每系统一个，所有粒子同帧采样；每帧最多采一次，`dt' > interval` 时也只采一次。
- 余量丢掉：采样周期是使计时器 ≤ 0 的帧数乘 `dt`，比 `interval` 长。理想 `dt = 1/60`、`interval = 0.25` 时 float32 累减 15 次仍是正数，16 帧采一次（`predict.py`）。
- 存活数为 0 时整个顶点函数跳过，计时器停走。
- 两遍模式对历史无影响（采样在模拟之外，每帧一次）。
- ropetrail 路径不读 `fps`。

### 5.3 每个粒子的段（GS，76 字节，`0x140232e13`–`0x1402339a7`）【确】

先 map `存活数 · max(n, 1)` 个点（`0x140232dbe`–`0x140232e03`）。再按槽序 `0..高水位−1` 跳过 `life == 0`，每个粒子**恒写 n 段**，不看 `count`：

```
p = pos[i]，s = size[i]，c = rgba[i]，C = count[i]，U = U[i]
seg 0:        start p     end h[0]   CP0 p        CP1 h[1]
seg 1:        start h[0]  end h[1]   CP0 p        CP1 h[2]
seg k (2…n−2):start h[k−1] end h[k]  CP0 h[k−2]   CP1 h[k+1]
seg n−1:      start h[n−2] end h[n−1] CP0 h[n−3]  CP1 h[n−1]（终点自身）
n == 2（0x140233215、0x1402337b7）: seg 0 同上，seg 1: start h[0] end h[1] CP0 p CP1 h[1]
PosVec4 = (start, s)；Color = c；C2 = CP1（vec3）
非 uvscrolling（TRAILRENDERER）: TexVec4.w = C·K（in_ParticleTrailLength），C1.w = k
uvscrolling（TRAILSCROLLALPHA）: TexVec4.w = k（in_TrailVertexIndex），  C1.w = k − U
```

- 首段是「当前位置 → 最近一次采样」。采样当帧 `h[0] = p`，首段零长，起点一侧 `normalize(0)`【推：不画】，此时 `RV0.z = 0`，它的 `v` 区间也是空的。
- 未填满时 `h[C−1]` 及之后全是出生位置 B。段 `C−1`（`h[C−2] → B`，`C = 1` 时是 `p → B`）仍有效；段 `≥ C` 是 `B → B` 零长，`v_CPEnd = 0` 让终点一侧 `normalize(0)`【推：NaN，D3D11 不画】。
- 尺寸、颜色只有一份（非厚格式），取当前值。

### 5.4 着色器侧【确，着色器源码】

```
// TRAILRENDERER（无 uvscrolling）
usable = TL − 1;  if TL < RV0.w: usable += z            // RV0.w = n − 0.5，z = RV0.z
seg 0:   v ∈ [0, z/usable]
seg k≥1: v ∈ [(k − 1 + z)/usable, (k + z)/usable]
// TRAILSCROLLALPHA（uvscrolling）
usable = RV0.w = (n−1)·K；  TP = k − U
uvMin = 1 − TP/usable；uvDelta = −1/usable
seg 0: uvMin += uvDelta·(1 − z)；uvDelta *= z
fadeIn  = sin(saturate((k − (1 − z))/(n − 1))·3.141)
fadeOut = sin(saturate((k − (1 − z) + 1)/(n − 1))·3.141)
TRAILFADEALPHA: colorStart.a *= fadeIn；colorEnd.a *= fadeOut
TRAILFADESIZE:  sizeStart *= fadeIn；sizeEnd *= fadeOut
```

- 非 uvscrolling 时 `v` 从当前位置的 0 走向尾部。
  - `K = 1` 且未满（`C < n − 0.5`）时，最后一个有效点（出生位置）正好是 1。
  - 满了以后末端是 `(n − 1 + z)/(n − 1)`，略大于 1。
- `TRAILFADEALPHA` / `TRAILFADESIZE` 只出现在 `TRAILSCROLLALPHA` 分支里。不开 `uvscrolling` 时宏写了也不起作用。
- 非 `TRAILSCROLLALPHA` 的非厚格式 GS 只有一种颜色、一种尺寸；`TRAILSCROLLALPHA` 走 GS 的「厚格式」那半，起止尺寸与颜色来自 VS 的渐隐。
- 例（`n 4`、`K 1`）：`C 4`、`z 0.5` 时 4 段的 `v` 是 `[0, 0.167] [0.167, 0.5] [0.5, 0.833] [0.833, 1.167]`；`C 2`、`z 0.25` 时前两段是 `[0, 0.2] [0.2, 1]`，后两段退化（`predict.py`）。

---

## 6. 着色器替换与绘制【确】

- **无条件替换**：`FUN_140150110(库, 名字, 宏, 着色器)` 把选项拼成 `{"combos": {…}, "shader": "genericropeparticle"}`（`0x1401505f4`–`0x14015068f`），交给 `FUN_1401515b0`。后者取 `passes[0]`，用 `FUN_140153200` 把选项**递归覆盖**进 pass（选项里非空的值替换原值，对象逐键合并，`0x14015193d`）。所以材质 JSON 写了别的着色器也会被换掉；blending、深度、textures、constantshadervalues 等仍来自材质文件，`combos` 合并，变体宏优先。
- **基础材质**（`sys+0x358`，折射快照判断与 `g_RenderVar1` 的纹理用）：只有 `0x10000`（纯 rope 系统）时也换成 `genericropeparticle`，否则用材质自己的着色器。变体材质读同一个材质文件，纹理相同。
- **GS 与拓扑**：
  - 建缓冲 mode 2 → `POINTLIST`（3.5），每个点交给 GS，输出 `4 + 2·TRAILSUBDIVISION` 个顶点的三角形带。
  - `#define GS_ENABLED 1` 由设备能力位决定（`[[r14+8]+0x118]` bit3，`0x140162dbb`–`0x140162e0d`），不看着色器有没有 `.geom`；`.geom` 按 `shaders/<名>.geom` 另行加载（`0x140162cb7`）。
  - 粒子路径选 GS 布局看系统 `0x800000`，即基础材质的着色器是否带 GS 阶段（rea-p4b-render 2.3）。
- **非 GS 情况**：只有基础材质着色器没有 GS 阶段时才走。纯 rope 系统的基础材质是 `genericropeparticle`，有 `.geom`；语料 48 个绳系统全是 `genericparticle`，也有 `.geom`。所以 WPE 实际总走 GS【推：能力位的含义没核】。自定义无 GS 着色器配 ropetrail 时，顶点会按非 GS 布局写，变体着色器却仍可能带 GS，两者对不上【推，语料不涉及】。
- **REFRACT**：快照判断看基础材质 `+0x1fc` bit1，与 sprite 相同（rea-p4b-render 6.1）。绳的 GS 用 `right = R·mat3(g_ModelMatrix)`、`up = cross(right, eye)` 算屏幕切线。

---

## 7. 世界空间、透视粒子【确】

- 顶点里的位置都是模拟列的原值。世界空间系统（`flags` bit0）的列本来就是世界坐标（rea-p4c-sim 第 5 节），本地系统是对象本地坐标。rope、ropetrail 都不额外变换。
- 绘制：`FUN_1402366f0` 开头在 bit0 时把模型栈顶整块换成 `ctx+0xaf0`（`0x14023670c`–`0x140236748`，平时单位阵），画完换回 `sys+0x3a0`。这在 renderer 循环之前，rope 两类与 sprite 一样。所以世界空间绳的 `g_ModelMatrix`、`g_ModelMatrixInverse` 是单位阵，`eyeModel = g_EyePosition`，`FUN_1402298b0` 的 `M` 也是单位阵。
- 透视粒子（bit2）：`FUN_1401e5b60` 只压栈并覆盖视图平移和投影，不改 `ctx+0x68`（`g_EyePosition`）和 `g_ViewForward`。`ORIENTATION 0` 的绳仍用场景眼位算 `eye`，与该系统实际的透视眼位不一致【推，同 rea-p4c-render 6.4】。

---

## 未查完 / 未解决

- **NaN 图元**【推】：零长段、未填满的历史段、切线平行于眼方向时 `normalize(0)`。D3D11 是否一律丢弃，没有实测。实验 T1 能直接读到 `gs_out` 里的 NaN。
- **背面剔除**【未知】：材质缺省 `cullmode` 没读（rea-p4c-render「未解决」）。`upright` / `fixed` 会让绳的 u 左右对调、三角形带绕序反向；若缺省剔除背面，这种绳可能整条不画。实验 R6 顺带确认。
- `GS_ENABLED` 能力位的确切含义，以及自定义无 GS 着色器配 ropetrail 的结果（6）。
- 同系统多个 ropetrail 取最后一个的 `segments` / `length`（3.4），多个 rope 共用一个缓冲各画一次。都属多 renderer，不在本节。
- `R` 只取第一个 rate 非零的 `sphererandom` / `boxrandom`。周期发射、`instantaneous`、`rate 0` 加脚本发射时，`N` 与实际存活数的关系没有推演。
- `instanceoverride` 的 `count`、`lifetime` 总乘进 `R`、`L`，即使系统 `flags` 的 bit5 / bit6 禁止覆盖（1.2）。读码确定，效果没验证。
- 第二次调 `FUN_1401d2340`（`FUN_14024be64` `0x14024becd`，疑似运行时换材质）会重新分配历史缓冲而不重写 `sys+0x248` / `0x250`。路径没追。
- 非 GS rope 路径里的两粒子特例（`0x1402325d0`）没有逐项读，WPE 实际不走。
- `uvscrolling` 计数 `U` 是 u16，65536 次采样后回绕。
- 运行时改 rope 字段（属性绑定）的路径没找。

---

## 建议的确定性实验

骨架同 `ignore/p4/gen_b.py`：
- 正交 1920×1080、`zoom 1`，粒子对象在场景中心，`eyeModel = (0, 0, 2000)`。
- 每个系统用 `sphererandom` 的 `distancemax 0`，`lifetimerandom`、`sizerandom`、`velocityrandom` 收成定值。`sizerandom 40` 时 `size` 列是 20，绳宽 40。
- 材质 `white`，各系统用 `colorrandom` 区分。
- RenderDoc 读三样：GS 输入（每点 96 / 76 字节）、`gs_out` 的整条带子（每点 `4 + 2·SUB` 个顶点）、cbuffer（`g_RenderVar0`、`g_Orientation*`）。
- 坐标都在模型本地、y 向上；换屏幕像素时 y 取反。

**校验方法**：
- 先按 1.4 / 5.3 从粒子位置预测 GS 输入，检查 CPU 侧：顺序、CP、`w` 分量。
- 再从读到的 GS 输入按 1.5 / 5.4 算 `gs_out`，检查展开。两步分开，能区分错在哪一侧。
- 数值用 `ignore/p4/rea/p4d-rope/predict.py`。

### `proj/p4d-rope`

| 组 | 设置 | 验证哪条 | 预期 `gs_out` / 输入特征 |
|---|---|---|---|
| R1 | `rate 4`、`lifetime 1.6`、`maxcount 8`、`velocity "200 0 0"`、`uvsmoothing false`；`subdivision` 0 / 3 / 16 各一个系统 | 1.1、1.3–1.5、2.4 | 每帧一次绘制、`存活数 − 1` 个点，拓扑 POINTLIST，步长 96。<br>首段 C1.xyz = 起点、末段 C2.xyz = 终点，其余取 `idx[k−1]` / `idx[k+2]`。<br>宽 40（`±20`，`ORIENTATION 0` 时 u=0 在下方）。<br>`v(k) = 1 − k/(存活数 − 1)`，存活数 7 时为 1, 0.833, …, 0。<br>`SUB 3` 的细分点沿段方向在 0.0971 / 0.4438 / 0.8435（首段）、0.1472 / 0.5 / 0.8528（中段）、0.1565 / 0.5563 / 0.9029（末段）处（单位为相邻粒子间距）；`SUB 16` 见 `predict.py`。<br>稳态下槽 0 被复用，带子仍连续、不回跳，即表序 = 出生序 |
| R2 | 同 R1，renderer 只写 `{"name": "rope"}` | 3.1 缺省、1.2 平滑 | 每点 12 个顶点（`SUB 4`）。<br>存活数 ≥ 6 时 `TL = 5.4`（float 5.4000001），`TP0 = saturate((1.6 − age最老)·4) − 1 ∈ [−1, 0]`。<br>存活数 ≤ 5 时 `TL = 存活数`、`TP0 = 0` |
| R3 | 同 R1，`uvscrolling true` | 1.2、2.3 | `TL = 5.4`，`TP0 = 累计死亡数`，每死一个加 1；对象隐藏再显示后从 0 重新数 |
| R4 | 同 R1，`uvscale 0.5` | `K = 1/uvscale` | `TL = 2·存活数`，存活数 7 时 `v` 每段降 0.0769，整条只用 `[0.538, 1]` |
| R5 | `maxcount 1`；另一系统 `maxcount 2`、`uvscale 0.5`、`uvsmoothing true` | 1.1、1.2 特例 | 前者没有绳的绘制调用。<br>后者 `TL = 2`、`TP = 0`，`v` 从 1 到 0，不受 `uvscale` 与平滑影响 |
| R6 | 同 R1（`SUB 0`），`orientation` 写 `screen` / `upright` / `fixed`（`axis "0 0 1"`） | 1.5 朝向 | `screen`：顶点 0、1 在 `y = −20 / +20`。<br>`upright`、`fixed`：`g_OrientationForward = (0,0,1)`，顶点 0、1 对调为 `+20 / −20`。<br>同时看这两种是否被剔除 |
| R7 | 同 R1，加 `sizechange`（1 → 0）和 `colorchange`（红 → 蓝） | 两端各取各的 | 每点 `PosVec4.w ≠ C2.w`、`Color ≠ C3`。<br>`gs_out` 起点对用 `size[idx[k]]`、终点对用 `size[idx[k+1]]`，中间按 `s` 线性插值宽度与颜色 |
| R8 | 两个 emitter：A 沿 +x；B 朝控制点 1 飞，`controlpointattract` 带 `flags 1` 和 `deletethreshold`，让 B 的粒子先死 | 2.3 保序删除 | B0 死后原来的 `A0 → B0 → A1` 变成 `A0 → A1`。<br>占用 B0 槽的新粒子出现在绳尾，`TP` 下标连续 |
| R9 | `rate 100`、`lifetime 0.5`、`maxcount 64`、`uvsmoothing` 缺省；fps 60 与 fps 10 各抓一次 | 1.2 读 `fps` | fps 60：存活数 < 29 时 `TL = 存活数`，29–49 时 `TL = 29`，到 50 时 `TL = 49`。<br>fps 10：存活数 ≥ 4 起就进平滑分支，`TL = 4`，`TP0 = saturate((0.5 − age最老)·10) − 1`（填充早期为 0），到 50 时 `TL = 49` |
| R10 | 对象 `origin (1760, 540)`，`velocity "0 200 0"` | 1.5 眼位 | `R` 带 z 分量，约 `(−0.928, 0, −0.371)·20`。<br>屏幕宽约 37.1 而不是 40（同 rea-p4c-render T7） |
| R11 | 系统 `flags 1`，对象平移加 `angles.z` 旋转 | 第 7 节 | GS 输入是世界坐标，cbuffer `g_ModelMatrix` 是单位阵 |
| R12 | R1 加 `starttime 2` | 2.4 预热 | 第一帧就有 `存活数 − 1` 段，顺序连续；`uvscrolling` 版的 `TP0` 等于预热期间的死亡数 |

### `proj/p4d-ropetrail`

| 组 | 设置 | 验证哪条 | 预期 |
|---|---|---|---|
| T1 | `maxcount 1`、`lifetime 20`、`velocity "200 0 0"`、`movement` 带 `gravity "0 -300 0"`（让轨迹弯）；`ropetrail` 缺省（`length 1`、`segments 4`、`SUB 1`） | 5.1–5.4 | 每帧 4 个点、步长 76，宏有 `TRAILRENDERER`、`TRAILSUBDIVISION 1`，没有 `THICKFORMAT`。<br>粒子出生那一帧就采样（计时器初值 0，存活数为 0 时停走），之后按日志 dt 累减 0.25，余量不带；理想 60 fps 是 16 帧一采。<br>采样帧 `h[0]` = 该帧模拟后的位置，其它后移一格；采样当帧段 0 零长（NaN）。<br>`TexVec4.w = count`：出生帧采样后就是 2，之后每次采样 +1，封顶 4；`C1.w = 0, 1, 2, 3`。<br>段 `≥ count` 的 `gs_out` 含 NaN。<br>`RV0 = (·, ·, 1 − timer/0.25, 3.5)`，`v` 见 5.4 的例子 |
| T2 | T1 加 `uvscrolling true`、`fadealpha true`、`fadesize true`、`uvscale 0.5` | 5.4 | 宏加 `TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`。<br>`RV0.x = 3`、`RV0.w = 6`。<br>`TexVec4.w = 0, 1, 2, 3`，`C1.w = k − U`，`U` 每采样加 1。<br>`gs_out` 首段起点 alpha 与宽度为 0，尾端趋 0，`uvscale 1` 时数值见 `predict.py` |
| T3 | T1 加 `fadealpha true`、`fadesize true`，不开 `uvscrolling` | 5.4 渐隐只在滚动分支 | 宏有两个 FADE，但 alpha 和宽度不变 |
| T4 | `segments` 写 0、40；`length` 写 0；`subdivision` 写 0、2、40 | 3.1 钳制 | 每粒子 2 / 32 段。<br>`length 0` → 0.001，每帧都采样。<br>`gs_out` 每点 4 / 8 / 68 个顶点（缺省 `SUB 1` 是 6 个） |
| T5 | `rate 2`、`maxcount 4`、`lifetime 1.5` | 5.2、5.3 | 每粒子 4 个点，按槽序排、跳过死槽。<br>所有粒子同一帧采样；后出生的粒子在下一次全系统采样之前 `h[*]` = 出生位置、`count = 1`，段 0 是「当前位置 → 出生位置」 |
| T6 | T1 在 fps 10 下抓 | 5.2 | `dt ≈ 0.1` 时 3 帧一采（0.3 s），历史间距按 3 帧的位移。<br>两遍模式不影响采样 |
| T7 | T1 加 `starttime 1` | 5.1 预热 | 预热结束时 `count = 1`、`U = 0`、历史全是当时的位置。<br>第一帧立即采样：`count = 2`，`h[0]` = 当前位置，`h[1]` = 预热结束时的位置，段 0 零长，段 1 有效，其余退化 |

### 最想用实测核对的读码结论

1. rope 每段的内容与先后：CP 取法、两端各取、宽 `2·size`、`v` 按下标、POINTLIST + GS（R1、R7）。
2. 表序 = 出生序，保序删除（R1 稳态、R8）。
3. rope 缺省 `subdivision 4`、`uvsmoothing true`，平滑与 `fps` 的公式，两粒子特例（R2、R5、R9）。
4. ropetrail 采样：比较常量 0、余量丢掉、每帧最多一次、新的在前、出生写满出生位置、`count` 从 1 起（T1、T5、T6）。
5. 每粒子恒写 `segments` 段，未填满的段退化不画；FADE 只在 `uvscrolling` 时有效（T1、T3）。
6. `upright` / `fixed` 让绳的 u 左右对调，以及是否被剔除（R6）。
