> 逆向原始记录，代理写的，地址按 Ghidra。只读码，没有实测；实测核对写进 [p4-particles-REPORT.md](p4-particles-REPORT.md)「P4c 语义的实测核对」。本文件覆盖步骤 0a 的第 6、7 项，第 1–5 项见 `rea-p4c-sim.md`。

# WPE 2.8.42 P4c 渲染侧静态逆向（`spritetrail`、`sprite` 的朝向）

**概括**
- `spritetrail` 解析【确】：`length` → 记录 `+0x3c`（缺省 0.05），`maxlength` → `+0x40`（缺省 10），`minlength` → `+0x44`（不补缺省，读成 0）。正交、透视同一套缺省，不钳制。
- `g_RenderVar0`【确】：绘制拖尾前写 `(length, maxlength, minlength)`，`w` 不写。着色器里 `L = max(minlength, min(|v|·length, maxlength))`，是 `size` 的倍数，与帧时间无关。
- 拖尾几何【确，着色器源码】：四边形**以粒子为中心**，沿当帧速度方向前后各伸 `0.5·size·ratio·L`，宽 `size`。宽向 = `normalize(cross(p − eye, v))`，依赖 `g_EyePosition`，离开视轴时正交下会变窄。速度为 0 时整块 NaN【推】不画。
- 同系统 `sprite` + `spritetrail`【确】：两次绘制，共用一个顶点缓冲 `sys+0x1f8`，各绑各的变体材质，按 renderer 数组顺序画。
- 环形历史缓冲 `sys+0x230…0x250`【确】：**属于 `ropetrail`**，`spritetrail` 不分配、不读、不写。
- `g_OrientationForward / Right / Up`【确】：`ctx+0x184 / 0x190 / 0x19c`，唯一写入者 `FUN_1402298b0`，每个 renderer 每次绘制前按 `orientation`、`axis`、`flags` bit0、模型矩阵、相机算一次，结果在模型本地空间。
- 三种朝向【确】：`screen` 面朝相机；`upright` 绕 `axis` 转的圆柱公告板；`fixed` 法线固定为 `axis`。`flags` 只有 bit0 有读者：选「随对象」还是「随相机 / 世界」。
- 正交缺省相机、对象没有 x/y 旋转时：`screen`（任意 `flags`）、`upright` 缺省轴、`fixed` 轴 `"0 0 1"` 都等于现在写死的单位基。`fixed` 缺省轴（解析成 `(0,1,0)`）的四边形躺在 XZ 平面，正交下看不见。
- 朝向对 `spritetrail` 没有几何作用【确】：值照算，`genericparticle` 的 `TRAILRENDERER` 分支不读。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。只分析 scratchpad 副本，未运行 WPE。
- 方法：REA（Ghidra 12.1.4，`p4b-mod` 快照复制到 `ignore/p4/rea/p4c-render/` 打开）+ `wp.asm` 切片 + 脚本 + WPE 着色器源码（`assets/shaders/genericparticle.*`、`common_particles.h`，只读）。会话已关闭，没有改元数据，没有另存快照，复制的快照已删。
- 工作文件在 `D:\Codes\kabegame\ignore\p4\rea\p4c-render\`：`rend_parse.asm`、`parser_full.asm`（解析）、`d2340.asm`（变体与缓冲）、`orient_298b0.asm`、`orient_tail.asm`（朝向函数）、`names.asm`（名表）、`pass577e0.asm`（pass 属性）；脚本 `jt.py`（`FUN_1400d8300` 两级跳转表）、`wr.py` / `grepoff.py` / `bytes.py`（按偏移扫写入 / 引用 / 字节读）、`predict.py`（按本文公式算实验预测值）。
- 没有改仓库代码和别的计划文件，没有提交。
- 标记：【确】读到代码；【推】推出、没逐行确认；【未知】没读到。
- 命名沿用 rea-framework / rea-p4b-render：`ctx` = R+0x10，`sys` = obj+0x2c0，`rec` = renderer 流里的一条记录（`+0` 类型字节，`+2` 长度 u16），`p` = `rec+4`（追加器的返回值，解析函数和朝向函数的参数）。`M` = 绘制时模型矩阵栈顶 `*(ctx+0x30)`，行主序 `m0…m15`，第 i 行 = 本地第 i 轴在世界里的向量（与 `g_ModelMatrix` 同源，见 7.2）。记号 `v·M` = 本地 → 世界（`v.x·行0 + v.y·行1 + v.z·行2`）；`M·v` = 与三行分别点积。

---

## 6. `spritetrail`（renderer 类型 2）

### 6.1 解析【确】

分支 `0x1401cfe16`（字符串比较 `"spritetrail"`），在 `FUN_1401c5490` 的 renderer 循环里。

```
p = FUN_1401d8d90(&流写指针)      // 类型 2，长度 0x4c，返回 rec+4
FUN_1401c22e0(p, json)            // orientation、axis、flags，见 7.1
FUN_1401c0af0(json, [rbp+0x2238]) // 往 JSON 里补缺省，第二参数没用到
*(u64*)p = 0                      // 材质指针，FUN_1401d2340 之后写变体
p+0x38 = asFloat(json["length"])      // rec+0x3c   0x1401cfeb3
p+0x3c = asFloat(json["maxlength"])   // rec+0x40   0x1401cfee8
p+0x40 = asFloat(json["minlength"])   // rec+0x44   0x1401cff16
sys.flags |= 0x2000000                // 0x1401cff1b
```

| 键 | 记录偏移 | 缺省 | 来源 |
|---|---|---|---|
| `length` | `+0x3c` | 0.05（写回 JSON 的 double 是 `0x3fa99999a0000000`，即 float 0.05 提升） | `FUN_1401c0af0` `0x1401c0b55` |
| `maxlength` | `+0x40` | 10 | `0x1401c0c13` |
| `minlength` | `+0x44` | 不补，JSON 里是 null，`asFloat` 得 0 | `FUN_140086220` null 分支 |
| `orientation`、`axis`、`flags` | `+0xc` 起 | 见 7.1 | `FUN_1401c22e0` |

- **一套缺省**：`FUN_1401c0af0` 的第二个参数（`edx`，调用方传 `[rbp+0x2238]` 字节）在函数里没有使用（`0x1401c0af0`–`0x1401c0c8c` 全段）。正交、透视粒子缺省相同。
- **不钳制、不排序**：三个值原样存。`minlength > maxlength` 时着色器 `max` 在外层，`minlength` 胜。负值也原样传。
- `asFloat`（`FUN_140086220`）：int、uint、real、bool 都转；null 得 0；字符串走断言。
- 分支里只读这三个键加共用的三个键。记录尾 `+0x48` 没看到写入，【推】填充。

### 6.2 宏与变体【确】

`FUN_1401d2340` 的类型分发在 `0x1401d2590`：1 → `0x1401d2f78`，2 → `0x1401d2c02`，3 → `0x1401d29e1`，4 → `0x1401d25b7`。

`spritetrail` 分支（`0x1401d2c02`–`0x1401d2f78`）：

```
THICKFORMAT = 1                          // 0x1401d2c6d
TRAILRENDERER = 1                        // 0x1401d2cf6
if sys.flags & 0x1000000:                // 0x1401d2d89
    SPRITESHEET = 1
    SPRITESHEETBLEND = blendOK
    SPRITESHEETBLENDNPOT = npot
if 格式 ∈ 8..11: TEX0FORMAT = 格式       // 0x1401d2ed1
p->材质 = FUN_140150110(基础材质名, 宏表, 0)  // 0x1401d2f30
```

- 不读 `orientation`（分支内没有 `[rdi+0xc]`），与 `sprite` 非厚格式分支不同（rea-p4b-render 2.4）。
- 第 4 个参数是 0，即沿用基础材质的着色器（`genericparticle`）；rope 两类传 `"genericropeparticle"`。
- 有 `spritetrail` 时 `need |= 2`，同系统的 `sprite` 一起走厚格式（rea-p4b-render 2.4，本轮在 `0x1401d2552` 一带复核）。

### 6.3 绘制与 `g_RenderVar0`【确】

`FUN_1402366f0` 的 renderer 循环（`0x140236940`–`0x140236a9f`），按 renderer 流的顺序（即 JSON 数组顺序）：

```
for rec in 流:
  switch rec.type:
  1 sprite:                                  // 0x140236a6d
      FUN_1402298b0(ctx, rec+4)              // 朝向，见 7.2
      bind(rec 材质); 画 sys+0x1f8
  2 spritetrail:                             // 0x140236a3b
      FUN_1402298b0(ctx, rec+4)
      ctx+0xa8 = rec+0x3c                    // RV0.x = length
      ctx+0xac = rec+0x40                    // RV0.y = maxlength
      ctx+0xb0 = rec+0x44                    // RV0.z = minlength
      bind(rec 材质); 画 sys+0x1f8           // 0x140236a82
  3 rope:      存活数 > 1 才画；RV0.z = 0，RV0.w = 存活数；画 sys+0x208
  4 ropetrail: RV0.z = 1 − max(sys+0x24c, 0) / sys+0x250；RV0.w = 段数 − 0.5（uvscrolling 时另算，并写 RV0.x）；画 sys+0x200
```

- `g_RenderVar0` = `ctx+0xa8`（uniform 编号 0x6c，`FUN_1400d8300` `0x1400d9eaa`，读 16 字节）。
- `RV0.w` 对 `spritetrail` 不写，保留上一次写入的值；`genericparticle` 不读它。
- 顶点缓冲（`FUN_1401d2340` 尾部，`0x1401d3522` 起）：`sys+0x1f8` 在 `need & 3` 时建（sprite / spritetrail），`sys+0x200` 在 `need & 4`（ropetrail），`sys+0x208` 在 `need & 8`（rope）。
- **同系统 `sprite` + `spritetrail`**：两次绘制，同一个缓冲 `sys+0x1f8`（顶点每帧只写一次），各绑自己的变体材质，按数组顺序先后画。两次之前都调 `FUN_1402298b0`。blend、深度等 pass 状态来自同一个基础材质。所以每个粒子既有一个普通四边形，又有一个拉伸的四边形。
- uniform 每次绑定都从 `ctx` 取【推】：与 `g_RenderVar1` 同一机制，P4b 已实测 RV1 逐绘制生效；`FUN_140155fc0` 到常量缓冲更新的路径本轮没追。

### 6.4 顶点与拖尾几何

**顶点**【确】（rea-p4b-render 2.6）：厚格式 GS 60 字节 / 非 GS 68 字节。`a_TexCoordVec4C1.xyz` = 速度列 `0x2c8 / 0x2d0 / 0x2d8` 原值（单位 / 秒），不乘帧时间、不变换；`.w` = frame。系统 `flags` 的 `0x2000000` 在粒子代码段里只有两处：解析置位（`0x1401cff1b`）和顶点写入选厚格式（`0x14023588d`，`& 0x3000000`）【确，有界：`0x1401b8000–0x1401d9800`、`0x140220000–0x140262000` 搜立即数】。模拟侧没有为拖尾多做任何事。

**速度的空间**：与位置列同一个模拟空间。着色器把它和 `a_Position` 都当成模型空间，最后乘 `g_ModelViewProjectionMatrix`。世界空间系统（系统 `flags` bit0）绘制时的模型矩阵归 `rea-p4c-sim.md`。

**着色器**（`common_particles.h` 的 `ComputeParticleTrailTangents`、`ComputeParticlePosition`，`genericparticle.vert` / `.geom`）：

```
eyeLocal = (g_EyePosition, 1) · g_ModelMatrixInverse      // 行向量乘
eyeDir   = p − eyeLocal.xyz
right    = normalize(cross(eyeDir, v))
s        = length(v)
up       = (v / s) · max(RV0.z, min(s · RV0.x, RV0.y))    // L = max(minlength, min(s·length, maxlength))
ratio    = SPRITESHEET ? g_RenderVar1.w : g_Texture0Resolution.y / g_Texture0Resolution.x
corner(u, w) = p + size·right·(u − 0.5) − size·up·(w − 0.5)·ratio
```

结论：
- `trailLength` 就是 `length(v)`，当帧速度的模长。和帧时间、粒子年龄、历史位置都无关。
- 四边形以粒子为中心：沿速度方向从 `−0.5·size·ratio·L` 到 `+0.5·size·ratio·L`，不是挂在粒子后面的尾巴。纹理 `w = 0` 一端在速度前方。
- 宽 = `size`（`right` 是单位向量）；`L` 只拉长度。
- 宽向依赖 `g_EyePosition`。正交场景里它是 `(W/2 + eye.x, H/2 + eye.y, 2000)`（p3-script-REPORT L2），视图却是单位阵。粒子离开视轴、速度又不沿径向时，`right` 带 z 分量，正交投影下屏幕宽度小于 `size`（例：偏离 800、速度竖直，宽 18.57 而不是 20，实验 T7）。
- 速度为 0：`v / 0` 与 `normalize(0)` 都是 NaN，四角全是 NaN【推】D3D11 丢弃该图元，即静止粒子在拖尾里不画，`minlength` 也救不回。速度与视线平行时 `right` 也是 NaN。
- 透视粒子（系统 `flags` bit2）：覆盖函数 `FUN_1401e5b60` 只改视图平移和投影，不写 `ctx+0x68`【确】，所以拖尾用的仍是场景的 `g_EyePosition`，与该系统实际的透视眼位不一致【推】。
- GS 与顶点展开一致【确，着色器源码】：GS 把 `vec4(a_Position, size)` 截成 xyz 传进同一个函数，四角 uv `(0,0)(0,1)(1,0)(1,1)` 与非 GS 的逐顶点 uv 同值，只有角点顺序不同。
- 不读 `g_Orientation*`：`TRAILRENDERER` 分支不调 `ComputeParticleTangents`。`REFRACT` 用 `right`、`up` 和 `g_ViewRight / Up`，`LIGHTING` 用 `right`，都照上面的 `right`、`up`。

**实现要点**：
- 模块表加 `spritetrail`：`length` 0.05、`maxlength` 10、`minlength` 0，不钳制。
- 宏照 6.2；`g_RenderVar0 = (length, maxlength, minlength, 任意)`。
- `g_EyePosition`、`g_ModelMatrixInverse` 必须是真值（现在 `uniforms.ts` 已有两者）。
- WebGPU 的 `normalize(0)` 结果不保证是 NaN，要显式处理 `s == 0` 和 `right` 退化，做成与 WPE 一样不画。
- 同系统两个 renderer 就画两遍。

### 6.5 环形历史缓冲：属于 `ropetrail`【确】

rea-framework Q5 的 `sys+0x230` 等字段：

| 字段 | 含义 | 证据 |
|---|---|---|
| `sys+0x230` | 历史位置，`段数 × N4 × 12` 字节（每段 3 个 float），清零 | `FUN_1401d2340` `0x1401d3323` |
| `sys+0x238` | 每粒子 u16，已存段数（封顶段数） | `0x1401d3346`；更新 `0x140232d90` |
| `sys+0x240` | 每粒子 u16，只在系统 `flags` bit19（rope `uvscrolling`）时分配，只增不封顶 | `0x1401d335c`；更新 `0x140232dab` |
| `sys+0x248` | u16 段数 | 写入 `0x1401d29be` |
| `sys+0x24c` | 计时器 | 更新 `0x140232cad` |
| `sys+0x250` | 段间隔 = `length / segments` | 写入 `0x1401d29d5` |

（`N4` = `maxcount` 上取到 4 的倍数。）

- `sys+0x248`、`sys+0x250` 只在 `ropetrail` 分支的末尾写（`0x1401d29ae`–`0x1401d29d5`，紧挨类型 3 分支入口 `0x1401d29e1`），取第一个 `ropetrail` 记录的 `segments`（`+0x40`）和 `length / segments`（`+0x3c`）。`sys+0x230` 只在 `sys+0x248 != 0` 时分配（`0x1401d32e3`）。
- 更新在顶点写入 `FUN_1402308a0` 内（`0x140232c9f` 起），前提是 `sys+0x200`（ropetrail 缓冲）存在：计时器减 `dt`，到点后重置为间隔，对每个存活粒子把历史后移一格（`memmove`）、写入当前位置、计数加 1。比较常量是 0【推】。
- 绘制时只有类型 4 读 `sys+0x248 / 0x24c / 0x250`（6.3）。
- `spritetrail` 不碰这些字段。

### 6.6 rope / ropetrail（只标出）

- `ropetrail` 字段（`0x1401d00bf` 起）：`length` `+0x3c`、`segments` `+0x40`、`subdivision` `+0x44`、`+0x48` bit0 `fadealpha` / bit1 `fadesize`，`uvscale`，`uvscrolling` → 系统 `0x80000`。
- rope 两类的变体写 `ORIENTATION = rec+0xc`（`0x1401d271b`、`0x1401d2b3e`），着色器是 `genericropeparticle`，它读 `g_OrientationForward`（`eyeDirection = mul(g_OrientationForward, CAST3X3(g_ModelMatrixInverse))`）。展开属 P4d。

---

## 7. `sprite` 的 `orientation`、`axis`、`flags`

### 7.1 解析 `FUN_1401c22e0(p, json)`【确】

`sprite` 分支 `0x1401cc5b5`：追加器 `FUN_1401d8d70`（类型 1，长度 0x3c，返回 `rec+4`），只调 `FUN_1401c22e0`，再把 `*(u64*)p` 清零（`0x1401cc5fd`），没有别的键。

```
// orientation
if !has("orientation"): json["orientation"] = "screen"
s = json["orientation"].asString()
p+8 = (s == "upright") ? 1 : (s == "fixed") ? 2 : 0      // 精确比较，区分大小写；其它一律 0

// axis
if !has("axis"): json["axis"] = "0 0 0"
(ax, ay, az) = 按空格切三段，各自 atof（FUN_1402d06ac）   // 没有空格时后两段从串尾解析，得 0
p+0xc..0x14 = (ax, ay, az)
if ax == 0 && ay == 0 && az == 0:                        // 精确零，没有阈值
    axis = (0, 1, 0)
else:
    axis = normalize(axis)       // FUN_14005eb80：len = sqrt((x²+y²)+z²)，inv = 1/len，各乘 inv
if axis.x == 0 && axis.z == 0:                           // 0x1401c27aa
    r = (1, 0, 0); t = (0, 0, −1)
else:                                                    // 0x1401c27df，·0 真的算
    r' = (az − ay·0, ax·0 − az·0, ay·0 − ax)             // = cross((0,1,0), axis)
    r  = normalize(r')
    t  = normalize(cross(axis, r'))
p+0x18..0x20 = r
p+0x24..0x2c = t

// flags
if !has("flags"): json["flags"] = 0
p+0x30 = (u8) json["flags"].asUInt()                     // FUN_140085f70：int/uint 直取，real 截断，bool 0/1，null 0，字符串断言
```

记录布局（`sprite` 0x3c、`spritetrail` 0x4c 共用前段）：

| 记录偏移 | `p` 偏移 | 内容 |
|---|---|---|
| `+0x4` | `+0x0` | 变体材质指针（解析时清零） |
| `+0xc` | `+0x8` | `orientation` 0 / 1 / 2 |
| `+0x10..0x18` | `+0xc` | `axis`（归一化后） |
| `+0x1c..0x24` | `+0x18` | `r`，粒子路径不读 |
| `+0x28..0x30` | `+0x24` | `t` |
| `+0x34` | `+0x30` | `flags` 低 8 位 |

- 「零向量取缺省」只认精确的 0。`"0 0 0.000001"` 会归一化成 `(0,0,1)`。这与 `vortex` 等模块「长度 < 0.001 取缺省」不同。
- `axis` 的符号对 `ax == az == 0` 的特例不起作用：`"0 -1 0"` 的 `r`、`t` 也是 `(1,0,0)`、`(0,0,−1)`，但 `axis` 本身是 `(0,−1,0)`。

### 7.2 `g_Orientation*` 的写入【确】

- 名表（`FUN_140002860`）：`g_OrientationForward` 0x1d、`g_OrientationRight` 0x1e、`g_OrientationUp` 0x1f（`0x140002ef1`–`0x140003091`）。
- 取值（`FUN_1400d8300`，字节表 `0x1400daaac` + 偏移表 `0x1400da984`，`jt.py`）：0x1d → `ctx+0x184`（`0x1400d972b`），0x1e → `ctx+0x190`（`0x1400d9751`），0x1f → `ctx+0x19c`（`0x1400d9777`）。
- 唯一的运行时写入者 `FUN_1402298b0(ctx, p)`。调用点只有 `FUN_1402366f0` 的 4 个 renderer 分支（`0x140236956`、`0x140236a01`、`0x140236a42`、`0x140236a74`），每个 renderer 每次绘制前算一次。另一处写入是构造函数 `FUN_14017c6d0` 清零（`0x14017c85c`）。按偏移扫了全二进制对 `+0x184…+0x1a4`（任意基址）和 `+0x1a8…+0x1b4`（R 基址 = ctx−0x10 时的对应偏移）的写入，`0x140170000–0x140240000` 内逐个看过：帧函数 `0x14018022a`–`0x140180885` 写的是 R 基址的 `g_ViewRight.z`、`g_ViewUp`（R+0x184… = ctx+0x174…），其余属于别的结构。没有别的写入者【确，有界】。
- 输入：
  - `M` = `*(ctx+0x30)` 的 3×3 部分。`g_ModelMatrix`（编号 9，`0x1400d8515`）也直接取 `*(ctx+0x30)`，两者同源。平移不参与。
  - `vf` = `g_ViewForward`（`ctx+0x160`）= −视图矩阵 `V` 第 2 列（`FUN_140184310(V, 2)`，`0x1401800af`）。
  - `vup` = `g_ViewUp`（`ctx+0x178`）= `V` 第 1 列（rea-p4b-render 6.3）。
  - `p` 的朝向、`axis`、`t`、`flags`。

```
bit0 = p.flags & 1                       // 0x1402298c2：cl = ~flags & 1，cl 为 0 即 bit0 置位
switch p.orientation:
case 0 screen:                                           // 0x140229c35
    F = −vf
    U = bit0 ? vup : (0,1,0)·M                           // 后者 = M 第 1 行 (m4,m5,m6)，SIMD 算（0x140229c67）
    d = (F.y·U.y + F.x·U.x) + F.z·U.z
    U = U − F·d                                          // 对 F 做一次 Gram-Schmidt，不归一化
case 1 upright:                                          // 0x140229ab8
    U = bit0 ? (0,1,0) : axis·M                          // 每分量 (ay·m[4+j] + ax·m[j]) + az·m[8+j]
    R = vf × U                                           // 临时值，尾部会覆盖
    F = R × U
case 2 fixed:                                            // 0x14022997d
    if bit0: F = axis;   U = t                           // 0x140229a87，原样拷贝
    else:    F = axis·M; U = t·M
// 公共尾 0x140229d55
F' = M·F          // F'_i = (F.y·m[4i+1] + F.x·m[4i]) + F.z·m[4i+2]
U' = M·U
R' = U' × F'
g_OrientationForward = normalize(F')     // 平方和顺序 (y² + x²) + z²，1/sqrt 再乘
g_OrientationRight   = normalize(R')     // (y² + x²) + z²
g_OrientationUp      = normalize(U')     // (y² + x²) + z²
```

- 三个结果都在模型本地空间，着色器再乘 MVP。
- `M·(v·M) = v` 只对正交矩阵成立。均匀缩放被最后的归一化消掉；非均匀缩放会把基拉斜【推】，按公式算即可，不必特殊处理。
- 每次绘制都重算，同一系统两个 renderer 朝向不同时各用各的。

### 7.3 着色器怎么用【确，着色器源码】

```
Rot = Rz · Rx · Ry                         // 粒子旋转列 (rotx, roty, rotz)
O   = 以 (Right, Up, Forward) 为三行的 3×3
B   = Rot · O
right = B 第 0 行 = Rot00·Right + Rot01·Up + Rot02·Forward
up    = B 第 1 行 = Rot10·Right + Rot11·Up + Rot12·Forward
corner(u, w) = p + size·right·(u − 0.5) − size·up·(w − 0.5)·ratio
```

- P4a 已用 `O = 单位阵` 和 WPE 对齐（含三轴旋转），乘法约定已验证。P4c 只是让 `O` 不再恒为单位阵。
- `Forward` 只有粒子带 x / y 旋转时才进几何。

### 7.4 三种朝向的含义

| 朝向 | 法线（F） | 上方向（U） | `flags` bit0 = 0 | bit0 = 1 |
|---|---|---|---|---|
| `screen` | 指向相机（`−vf`） | 垂直于 F | U 取对象 Y 轴，四边形随对象转 | U 取相机上方向，屏幕直立 |
| `upright` | 视线在 U 垂面上的投影，朝相机 | `axis` | `axis` 在对象本地空间 | U 固定为世界 `(0,1,0)`，**`axis` 被忽略** |
| `fixed` | `axis` | `t` | `axis`、`t` 在对象本地空间 | `axis`、`t` 是世界向量 |

- `screen` 不读 `axis`。
- `upright` 的 `axis` 与视线平行时 `R = 0`，归一化成 NaN【推】不画。
- `fixed` 不朝相机。`axis` 垂直于视线时四边形侧对相机。
- 正交场景的视图是单位阵（p3-script-REPORT L2：正交且没有 `paths` 时强制 `eye (0,0,0)`、`center (0,0,−1)`、`up (0,1,0)`），所以 `vf = (0,0,−1)`、`vup = (0,1,0)`。对象没有旋转（或只有 z 旋转、只看本地基）时：

| 写法 | Right | Up | Forward | 正交下的样子 |
|---|---|---|---|---|
| `screen`，任意 `flags` | (1,0,0) | (0,1,0) | (0,0,1) | 与现在相同 |
| `upright` 缺省轴 / 轴 `"0 1 0"` | (1,0,0) | (0,1,0) | (0,0,1) | 与现在相同 |
| `upright` 轴 `"1 0 0"` | (0,−1,0) | (1,0,0) | (0,0,1) | 纹理转 90° |
| `upright` 轴 `"0 -1 0"` | (−1,0,0) | (0,−1,0) | (0,0,1) | 转 180° |
| `upright` 轴 `"0 0 1"` | NaN | (0,0,1) | NaN | 不画【推】 |
| `fixed` 缺省轴（→ `(0,1,0)`） | (1,0,0) | (0,0,−1) | (0,1,0) | 躺在 XZ 平面，高度为 0，看不见 |
| `fixed` 轴 `"0 0 1"` | (1,0,0) | (0,1,0) | (0,0,1) | 与现在相同 |
| `fixed` 轴 `"0 0 -1"` | (−1,0,0) | (0,1,0) | (0,0,−1) | 水平镜像（是否被剔除见「未解决」） |
| `fixed` 轴 `"1 0 1"` | (0.7071,0,−0.7071) | (0,1,0) | (0.7071,0,0.7071) | 宽缩到 0.7071 |

- 对象只有 z 旋转、`flags` 0 时，本地基仍是上表，四边形随对象转；`screen` / `upright`(bit0) / `fixed`(bit0) 加 `flags 1` 时，本地基反向转，世界里保持直立（实验 S13）。

### 7.5 `axis`

- 只在 `upright`（bit0 = 0）和 `fixed` 下起作用；`screen` 不读，`upright` 的 bit0 = 1 也不读。
- 解析期归一化一次（7.1），零向量（精确 0）换成 `(0,1,0)`。
- `upright` 只用 `axis`；`fixed` 用 `axis` 和派生的 `t`；派生的 `r` 在粒子路径没有读者。
- 语料里 `axis` 2 张（phase-4c 计划）。

### 7.6 `flags`

- 只有 bit0 有读者：`FUN_1402298b0` `0x1402298c2`。在 `0x1401b8000–0x1401d9800`、`0x140220000–0x140262000` 搜了对 `[reg+0x30]` / `[reg+0x34]` 的字节读，粒子代码里只有这一处（另一处是栈变量）。其余 7 位【确，有界】没有作用。没覆盖：按 dword 整字读后再测位的写法。
- bit0 的语义随朝向变（7.4），总的说是「上方向 / 轴不跟对象」。
- 编辑器里的显示名【未知】：本地化里没找到对应条目，编辑器是另一个可执行文件，不在本次范围。
- 语料的 `sprite` 写 `flags 1`（7 张）：正交场景、对象没有旋转时与 `flags 0` 完全相同。只有对象有旋转（或透视相机转了）时才不同。

### 7.7 对 `spritetrail`、rope 是否适用

- `spritetrail`：同样解析、同样算 `g_Orientation*`；变体不看朝向（6.2）；`genericparticle` 的拖尾分支不读这三个 uniform。**没有几何作用**【确】。自定义粒子着色器若在拖尾下读它们，值按 7.2 算。
- rope / ropetrail：同样算；变体写 `ORIENTATION` 宏；`genericropeparticle` 读 `g_OrientationForward`（6.6）。不展开。

### 7.8 材质变体（复述 rea-p4b-render 2.4）

- `sprite` 非厚格式：`orientation != 0` 或格式 8–11 时建变体并写 `TEX0FORMAT = 格式`，否则直接用基础材质。厚格式只看格式 8–11。这些宏不影响几何。

**实现要点**：
- 每个 renderer、每帧在 CPU 按 7.2 算三个向量。输入是绘制用的模型矩阵（与 `g_ModelMatrix` 同一个）和相机矩阵的第 1、2 列。
- 能力表放开 `upright`、`fixed`、`axis`、`flags`（bit0 有语义，其余位中性）。
- 退化（`upright` 轴平行视线）同 6.4，显式做成不画。

---

## 未查完 / 未解决

- **NaN 图元**【推】：速度为 0 的拖尾、轴平行视线的 `upright` 都算出 NaN。D3D11 下这些三角形会不会真的被丢弃，没有实测。
- **`cullmode` 缺省**【未知】：pass 属性表 `FUN_1401577e0`（`0x140157c1b` 一带）的选项是 `"normal"` / `"nocull"`，内置粒子材质只有 `halo`、`halo_translucent` 写了 `nocull`。缺省是否背面剔除、哪个绕序算正面没读。`fixed` 反向轴、`upright` 某些轴会翻面，画不画取决于它。归 P4f，实验 S10 可以顺便定。
- `flags` 各位在编辑器里的名字。
- 材质绑定时 uniform 是否每次都从 `ctx` 重新上传，`FUN_140155fc0` 之后的常量缓冲更新没追（6.3）。
- 世界空间系统和子系统绘制时的 `M`（`ctx+0xaf0`、`FUN_14005ecb0`）：朝向与拖尾的 `eyeLocal` 都用绘制时的模型矩阵，取值归 `rea-p4c-sim.md` / P4e。
- 透视粒子下 `g_EyePosition` 与实际眼位不一致的画面效果；`camerashake`、视差是否改 `g_EyePosition`、`g_ViewUp`。
- 非均匀缩放下基的拉斜程度【推】。
- `ropetrail` 计时器的比较常量是 0【推】；`r`（`p+0x18`）是否被 rope 用。
- `spritetrail` 记录 `+0x48` 的用途。
- 运行时改 `length` 等（用户属性绑定）的路径没找。

---

## 建议的确定性实验

骨架同 `gen_b.py`：正交 1920×1080、`zoom 1`、对象无缩放；每个系统 `sphererandom` 的 `distancemax 0`、`rate 1`、`maxcount 1`，`lifetimerandom` / `sizerandom` / `velocityrandom` 收成定值；`sizerandom 40`（顶点 `size` = 20，rea-framework Q5）；材质 `white`（方形纹理，`ratio` = 1）。RenderDoc 读 GS 输入（位置、速度、size）、`gs_out` 四角和 cbuffer。

下面的四角都是相对粒子位置 `p` 的模型本地坐标（y 向上，正交 1:1 时就是像素，换屏幕像素时 y 取反），按 uv `(0,0) (1,0) (0,1) (1,1)` 排列；GS 的输出顺序是 `(0,0)(0,1)(1,0)(1,1)`，按 uv 对号。数值由 `ignore/p4/rea/p4c-render/predict.py` 算出。

### `proj/p4c-trail`（对象放在场景中心，`eyeLocal = (0, 0, 2000)`）

粒子从对象原点出发、只有 `movement`（无重力），`p` 与 `v` 共线，`cross(p − eye, v)` 不随时间变，所以下表的四角对每一帧都成立。

| 组 | 设置 | 预测 |
|---|---|---|
| T1 | 只有 `spritetrail`，全缺省，`v = (100,0,0)` | `RV0 = (0.05, 10, 0, ·)`；宏 `THICKFORMAT=1`、`TRAILRENDERER=1`；顶点 60 字节；`L = 5`；四角 (50,10) (50,−10) (−50,10) (−50,−10) |
| T2 | `v = (400,0,0)` | `L = 10`（`maxlength` 截顶）；四角 x = ±100 |
| T3 | `minlength 8`，`v = (100,0,0)` | `L = 8`；x = ±80 |
| T4 | `minlength 12`、`maxlength 10`，`v = (100,0,0)` | `L = 12`（`minlength` 胜）；x = ±120 |
| T5 | `length 0.08`，`v = (60,80,0)` | `L = 8`，`right = (0.8,−0.6,0)`，`up = (4.8,6.4,0)`；四角 (40,70) (56,58) (−56,−58) (−40,−70) |
| T6 | `velocityrandom "0 0 0"`，`minlength 5` | 不画（NaN） |
| T7 | 对象 `origin (1760, 540)`（`eyeLocal = (−800,0,2000)`），`v = (0,100,0)`；对照 `v = (100,0,0)` | `right = (0.92848, 0, 0.37139)`，四角 (−9.2848,50,−3.7139) (9.2848,50,3.7139) (−9.2848,−50,−3.7139) (9.2848,−50,3.7139)，屏幕宽 18.57；对照组宽 20，四角同 T1 |
| T8 | 同系统 `renderer: [sprite, spritetrail]`，再做一份倒序；`v = (100,0,0)` | 每帧两次绘制、同一个顶点缓冲；sprite 绘制有 `THICKFORMAT=1`、没有 `TRAILRENDERER`，四角 (−10,10) (10,10) (−10,−10) (10,−10)；拖尾绘制同 T1；先后顺序跟数组 |
| T9 | `spritetrail` 写 `orientation "fixed"`、`axis "1 0 0"`、`flags 1` | 几何同 T1；cbuffer 里 `g_Orientation*` 有值但 `referenced: false` |
| T10（可选） | 系统 `flags 4`（透视粒子）+ `spritetrail` | cbuffer `g_EyePosition = (960, 540, 2000)`，不随透视覆盖变 |

### `proj/p4c-sprite`（`v = (10,0,0)`，读 `g_Orientation*` 与四角）

| 组 | 设置 | Right / Up / Forward | 四角 |
|---|---|---|---|
| S1 | `screen`，`flags` 0、1、2、255 各一个 | (1,0,0) / (0,1,0) / (0,0,1) | (−10,10) (10,10) (−10,−10) (10,−10)，四个相同 |
| S2 | `upright` 缺省轴 | 同 S1 | 同 S1 |
| S3 | `upright` 轴 `"1 0 0"` | (0,−1,0) / (1,0,0) / (0,0,1) | (10,10) (10,−10) (−10,10) (−10,−10) |
| S4 | `upright` 轴 `"0 -1 0"` | (−1,0,0) / (0,−1,0) / (0,0,1) | (10,−10) (−10,−10) (10,10) (−10,10) |
| S5 | `upright` 轴 `"1 1 0"` | (0.7071,−0.7071,0) / (0.7071,0.7071,0) / (0,0,1) | (0,14.142) (14.142,0) (−14.142,0) (0,−14.142) |
| S6 | `upright` 轴 `"1 0 0"` + `flags 1` | 同 S1（轴被忽略） | 同 S1 |
| S7 | `upright` 轴 `"0 0 1"` | NaN | 不画 |
| S8 | `fixed` 缺省轴 | (1,0,0) / (0,0,−1) / (0,1,0) | (−10,0,−10) (10,0,−10) (−10,0,10) (10,0,10)，屏幕上看不见 |
| S9 | `fixed` 轴 `"0 0 1"` | 同 S1 | 同 S1 |
| S10 | `fixed` 轴 `"0 0 -1"` | (−1,0,0) / (0,1,0) / (0,0,−1) | (10,10) (−10,10) (10,−10) (−10,−10)；同时看是否被剔除 |
| S11 | `fixed` 轴 `"1 0 1"` | (0.7071,0,−0.7071) / (0,1,0) / (0.7071,0,0.7071) | (−7.071,10,7.071) (7.071,10,−7.071) (−7.071,−10,7.071) (7.071,−10,−7.071)，屏幕宽 14.14 |
| S12 | `fixed` 轴 `"0 1 1"` | (1,0,0) / (0,0.7071,−0.7071) / (0,0.7071,0.7071) | 屏幕高 14.14 |
| S13 | 对象 `angles "0 0 0.5"`：`screen`、`upright` 轴 `"1 0 0"`、`fixed` 轴 `"0 0 1"`，各配 `flags 0` 与 `1` | `flags 0`：本地基同上表；`flags 1`：(0.8776,−0.4794,0) / (0.4794,0.8776,0) / (0,0,1) | 世界四角：`screen`、`fixed` 的 `flags 0` 为 (−13.570,3.982) (3.982,13.570) (−3.982,−13.570) (13.570,−3.982)（随对象转）；`upright` `flags 0` 为 (3.982,13.570) (13.570,−3.982) (−13.570,3.982) (−3.982,−13.570)；三者 `flags 1` 都是 (−10,10) (10,10) (−10,−10) (10,−10)（直立） |
| S14 | `fixed` 轴 `"0 0 0.000001"` 对照 `"0 0 0"` | 前者同 S1，后者同 S8 | 验证「只认精确零」 |
| S15（可选） | `fixed` 轴 `"1 0 1"` + `rotationrandom` 让 `rotx` 定值 | 用 7.3 公式算 | 核对 `Forward` 进几何 |

另外核对一张语料：`3832772446` 的 `sprite` `flags 1`，看所在对象有没有旋转。没有旋转时预测与 `flags 0` 逐像素相同。

### 最想用实测核对的读码结论

1. `g_Orientation*` 每次绘制按朝向和 `flags` bit0 计算；正交缺省下 `screen` 与 `flags` 无关（S1），对象旋转后 `flags 1` 保持直立（S13）。
2. `upright`、`fixed` 的基与退化：`fixed` 缺省轴看不见（S8），`upright` 加 `flags 1` 忽略轴（S6），零向量只认精确零（S14）。
3. 拖尾 `L = max(minlength, min(|v|·length, maxlength))`，以粒子为中心，`v = 0` 不画（T1–T6）。
4. 拖尾宽向依赖 `g_EyePosition`，离轴变窄（T7）。
5. `sprite` + `spritetrail` 两次绘制、共用顶点（T8）；`spritetrail` 忽略朝向（T9）。
6. `RV0` 缺省 `(0.05, 10, 0)`（T1）。
