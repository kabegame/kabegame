> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。全部没有实测，P5 步骤 0 实测核对后以报告为准。
> **2026-11-10：** 第 5 节（抖动）、第 6 节（视差）与正交 `zoom` 已由 P5a 步骤 0 实测核对，全部成立，补充两点：`roughness` 的临界比较要按 float32 算；P 不钳制、只有 `g_ParallaxPosition` 钳制。见 [p5-REPORT.md](p5-REPORT.md)「P5a 语义的实测核对」。

# WPE 2.8.42 P5 相机静态逆向（透视投影、路径、相机对象、抖动、视差、`perspective` 图层、相机 uniform）

**概括**
- **透视投影：** `FUN_140183a70` 的透视分支调 DirectXMath 的 `PerspectiveFovRH` 内联（`FUN_14009a360`），竖直 fov（度）、宽高比取**窗口客户区**（`R+0x84 / R+0x88`），不是场景尺寸。传参顺序让结果成为**反向深度**：view z = −nearz 处深度 1，−farz 处深度 0；正交 ±2000 也是同样的反向写法。
- **透视下不生效的东西：** crop、`alignment*`、`zoom`（general 的和相机的都不生效）在透视分支里一概不读；`orthogonalprojection` 缺失时场景 W/H（`G+0x354/0x358`）一直是 0。`alignmentfliph`（`R+0x128` 0x800）两种投影都翻，**只翻 x**。
- **fov 取值：** 每帧开头 `G+0x148 = 正交 ? perspectiveoverridefov : fov`，透视场景里有活动相机对象时换成相机对象的 fov，最后钳到 [0.1, 179.9]。缺省 fov 50、nearz 0.1、farz 10000（构造函数），8 张不写这三个键的透视场景就用它们。
- **透视场景里的 2D 图层：** 普通图像层和 3D 物体共用同一个 VP，尺寸按世界单位算（3453730450 的图层 scale 都在 0.001–0.01）。`fullscreen` 层另走一条路（不在本文范围）。
- **`camera.paths`：** 文件格式是 `{paths: [{duration, transforms: [{eye, center, up, zoom?, timestamp?}]}]}`。段内用 Hermite 插值，两端切线都取 `(p1 − p0)/2`，按段内归一化参数算、不乘段长；路径之间直接切换、不过渡，按文件顺序依次播放并循环；时间按帧 dt 推进。
- **相机对象：** 对象带字符串型 `camera` 键就建相机图层（进 `G+0x1f8`）。每帧倒序找**最后一个可见**（自身与父链都可见）的相机图层，用它的世界矩阵：eye = 平移，看向本地 −Z，up = 本地 +Y；zoom 取对象的 `zoom`；透视场景里 fov 取对象的 `fov`。`visible: false` 的不参与。`path` / `queuemode` 只驱动相机自己的动画条目，语料 22 个相机对象的 path 文件全是 `{"paths": []}`，等于静态相机。
- **正交场景的相机对象（冲突，最优先实测）：** 按读码，视图平移量是 −eye，正交投影仍是 0..W。语料里 11 张同一模板的正交场景把相机原点脚本设成 (0.5·canvasSize.x, 0.5·canvasSize.y, 500)，照读码画面会偏半屏，和作者意图矛盾。可能有我们没读到的补偿，也可能 `canvasSize` 的含义和我们以为的不同。
- **`camerashake`：** 不是噪声，是确定性正弦：T = speed²·g_Time，v = (cos T, sin 1.333T, sin T)，roughness³ 作长度指数，eye 和 center 加同一个偏移 = 纯平移。正交时 z 清零，幅度 = 0.01·amplitude·H；透视时幅度 = 0.1·amplitude（世界单位）。
- **`cameraparallax`（只在正交场景改画面）：** 先算视差点 P = eye.xy + lerp(场景中心, 指针的场景坐标, mouseinfluence)，按 delay 做一阶指数平滑：k = min(1, (1 − delay/3)·10·dt)。每个对象画的时候，视图左乘一个平移 o = amount · 根对象 parallaxDepth ⊙ (根对象 origin.xy − P)。只用**根对象**的 origin 和 parallaxDepth，子对象整体跟着根走、自身的 parallaxDepth 不起作用。**没写 parallaxDepth 的对象缺省是 (1, 1)**。`g_ParallaxPosition` = clamp(P / (W, H))，加载时 (0.5, 0.5)，只在开视差时每帧更新。壁纸属性 `cameraparallax: false`（宿主位 0x200）只让 mouseinfluence 归零，各层的静态偏移仍在。
- **图像层 `perspective: true`：** 和透视粒子同一个函数 `FUN_1401e5b60`：每次绘制临时换成 fov = perspectiveoverridefov（缺省 95）的透视投影，把相机放到可见区中心、距离 d = (可见高/2)/tan(fov/2)，使 z = 0 平面和正交画面重合，带 3D 旋转的四边形就有了透视。
- **uniform：** VP（0xb）= V·P，MVP（0xd）= M·V·P，MVPInverse（0xc），g_EyePosition（0x19）。g_ViewForward / Right / Up（0x1a / 0x1b / 0x1c）是 V 的 −第 2 列、第 0 列、第 1 列（世界空间）。g_ParallaxPosition 是 0x6b。没有 g_ViewMatrix / g_ProjectionMatrix。

**元数据**
- 目标 `D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42），开工只读核对 SHA-256 前缀 `40e2ce021e935232` 一致（全值 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`）。没运行、没附加 WPE，没写 Steam 目录。
- 方法：REA（Ghidra 12.1.4）打开 exe 副本 + `p4b-mod` 快照的副本（`ignore/p5/rea/camera/`），反编译；汇编查 `ignore/p4/rea/wp.asm`；常量和字符串用脚本直接读副本 exe。样本只读：默认工程散文件 + 工坊 `scene.pkg`（`ignore/hdr-macro/scan_misc_lib.py`）。
- 工作文件 `ignore/p5/rea/camera/`：
  - 汇编摘录：`cam_update_1401891a0.asm`（相机每帧更新）、`proj_140183a70.asm`（投影）、`proj_wrappers_14009a360.asm`（透视 / 正交矩阵包装）、`lookat_14019d920.asm`、`shake_140199580.asm`、`draw_parallax_14018aac0.asm`（绘制循环与视差）、`camlayer_update_1401f2ad0.asm`、`campath_parse_140198e20.asm`、`persp_override_1401e5b60.asm`、`f_14017fa70.asm`（帧函数前 2600 行）、`f_1400d8300.asm`（uniform 写入）。
  - 脚本：`rd.py`（读常量）、`strs.py`（字符串）、`findptr.py`（找虚表）、`jt.py`（uniform switch 跳转表）、`scan_cam.py` / `scan_cam2.py` / `scan_persp_imgs.py` / `dump_objs.py` / `dump_cam_script.py`（扫样本），输出 `scan_cam.out.txt`、`scan_cam2.out.txt`。
  - 没做标注；快照副本用完已删，exe 副本留着给 `rd.py` 等脚本读常量。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过、范围外没排除。

**命名**
- `R`：场景渲染器（`FUN_14017fa70` 的 `this`）。`G = *R`：场景 general 结构（同 p3 L 节）。`ctx = R+0x10 = *(G+0xd8)`。
- `W`、`H`：场景正交尺寸 `G+0x354 / +0x358`（float）。`Wi`、`Hi`：它的整数副本 `ctx+0x84 / +0x88`。`Ws`、`Hs`：窗口客户区（后备缓冲）尺寸 `ctx+0x74 / +0x78 = R+0x84 / +0x88`（float，p2 I4；也是 `g_Screen` 的来源）。
- 视图 / 投影 / 模型栈顶：`*(ctx+0x38)` = V，`*(ctx+0x40)` = P，`*(ctx+0x30)` = M（同 rea-p4c-sim）。
- 当前相机：`G+0xf0` eye、`+0xfc` center、`+0x108` up、`+0x114` zoom。基准（JSON / `setCameraTransforms`）：`+0x118` / `+0x124` / `+0x130` / `+0x13c`（同 p3 L2）。
- 矩阵约定：DirectXMath 行向量，clip = p·M·V·P；`Mij` 指第 i 行第 j 列，平移在第 3 行。上传 uniform 时转置（`FUN_1400d8300` 按 +0 / +0x10 / +0x20 / +0x30 跨步写）。

**一帧里的顺序**（`FUN_14017fa70`，在 p3 L4 表的基础上细化）【确】

| 顺序 | 动作 | 地址 |
|---|---|---|
| 1 | 选清屏色、`g_Time += dt`（`R+0x148` double / `R+0x140` float，超过 432000 归零） | `0x14017fc4c`–`0x14017fcf6` |
| 2 | `FUN_1401891a0(G, dt)`：对 `G+0x158` 里的对象调虚函数 +0x48（含相机图层的条目动画）→ 选相机来源（相机图层 > 路径 > 基准）→ 抖动 → 钳 fov → 视差点与 `g_ParallaxPosition` → `g_EyePosition = eye` → `V = lookAt` → 正交时 `g_EyePosition` 加 (Wi/2, Hi/2)、z = 2000 | `0x14017fd26` |
| 3 | `FUN_140183a70`：P（透视 / 正交）、crop 比例 `ctx+0xf8/0xfc`、透视覆盖用的 fov `ctx+0x110` | `0x14017fd2e` |
| 4 | 正交时对 P 绕场景中心乘 `G.zoom × G+0x114` | `0x14017fd3f`–`0x1401800a2` |
| 5 | 存 V、P 的副本到 `ctx+0x1160 / +0x11a0`，M 置单位阵，算 `g_ViewForward / Right / Up` | `0x1401800a7`–`0x1401802c7` |
| 6 | 鼠标命中与事件 `FUN_140189e10`（正交 + 视差时带视差偏移） | `0x1401802d5` |
| 7 | 脚本 `FUN_140171440`（写相机字段，下一帧才进 V / P） | `0x1401802e5` |
| 8 | 绘制循环 `FUN_14018aac0`：正交 + 视差时逐对象临时平移 V | 之后 |

---

## 1. 透视投影

### 1.1 分支与调用【确】
- `FUN_140183a70` 在 `G+0xe0` bit3（正交）为 0 时走 `0x140183edf`：
  1. `R+0x108` 置 0（qword，即 `ctx+0xf8 / +0xfc` 两个 crop 中心比例都是 0）。
  2. 调设备 `R+0x1528`（虚表 `0x140485b90`）的 +0x10 = `FUN_14009a360(dev, P, fovY, aspect, a, b)`：
     - `fovY = G+0x148 × 0.017453292`（度转弧度）；
     - `aspect = R+0x84 / R+0x88` = Ws / Hs；
     - `a = G+0x14c`（nearz），`b = G+0x150`（farz）。描述符偏移已核对：`nearz` → 0x14c（`0x14019ab29`），`farz` → 0x150（`0x14019abad`），`zoom` → 0x154。
  3. `R+0x120`（= `ctx+0x110`）= 2·atan(1/(P11·2000))，给透视覆盖用（第 7 节），和 rea-p4a C4 一致。
  4. `R+0x128 & 0x800` 时把 P 的第 0 行取反。
- `FUN_14009a360` 是 `XMMatrixPerspectiveFovRH` 的内联（断言字符串指向 `DirectXMathMatrix.inl`）。结果（行向量）：
  - m00 = cot(fov/2)/aspect，m11 = cot(fov/2)；
  - m22 = a/(b − a)，m23 = −1，m32 = a·b/(b − a)，其余 0。
- 正交包装是 `FUN_14009a630`（设备 +0x18），透视分支不调它。

### 1.2 深度范围与手性【确】
- **视图是右手系**：`FUN_14019d920` = `LookAtRH`。f = normalize(center − eye)，s = normalize(f × up)，u = s × f；V 的三列是 (s, u, −f)，平移 = (−s·eye, −u·eye, f·eye)。相机看 −Z。
- **投影是反向深度**：ndc.z = −m22 − m32/z_view。
  - z_view = −nearz 时为 **1**，z_view = −farz 时为 **0**。
  - 和 DirectXMath 原式（m22 = FarZ/(NearZ − FarZ)，m32 = m22·NearZ）对照，等于把 NearZ 当成 farz、FarZ 当成 nearz，即 near / far 互换。参数顺序读汇编确认：`[rsp+0x20]` = `G+0x14c`（nearz），`[rsp+0x28]` = `G+0x150`（farz）。
  - 正交同理：`ortho(…, −2000, 2000)` 经 `FUN_14009a630` 得到 ndc.z = z_view/4000 + 0.5，离相机越近越大。
  - 与 hdr-macro-REPORT 记的 `REVERSEDEPTH`（`ctx+0x118` 0x1000，壁纸进程恒置）一致。深度测试函数和清屏深度值不在本文范围（交给「网格与深度」那份）。
- WebGPU 的深度范围也是 [0, 1]，矩阵可以原样用。

### 1.3 fov、nearz、farz 的来源与缺省【确】
- 构造（`FUN_140186c90` 开头 `0x140186d46`–`0x140186d93`）：
  - `fov`（0x140）= 50，`perspectiveoverridefov`（0x144）= 95，`G+0x148` = 50；
  - `nearz`（0x14c）= 0.1，`farz`（0x150）= 10000；
  - `zoom`（0x154）= 1，当前 zoom（0x114）= 1，基准 zoom（0x13c）= 1。
- 缺键时保留构造值（描述符只对出现的键调 setter，p3 I3）。语料 10 张透视里 8 张不写，就是 50 / 0.1 / 10000；3453730450 写了 50 / 0.0099999998 / 10000，3706286085 写了 50 / 0.1 / 1000。
- **每帧生效值 `G+0x148`**（`FUN_1401891a0`）：
  1. 开头（`0x140189271`–`0x1401892c4`）：正交取 0x144，透视取 0x140。
  2. 有活动相机图层且是透视场景时，换成相机图层的 fov（第 4 节）。
  3. 末尾（`0x140189b12`）钳到 [0.1, 179.9]。
- 单位是**度**、**竖直**视场。

### 1.4 crop、alignment、zoom 在透视下【确，有界】
- crop / `alignment` / `alignmentx` / `alignmenty` / `alignmentposition` 只在正交分支读（`0x140183ab8` 起）；透视分支没有任何对齐计算，画面直接按窗口宽高比铺满，没有 fill / fit / 留白。
- `zoom`：当前 zoom `G+0x114` 在场景段 `0x140170000`–`0x1401a4000` 内唯一的读取点是 `0x14017fd5d`；经 `G` 读 general `zoom`（`G+0x154`）的是 `0x14017fd50`，都在 `G+0xe0` bit3（正交）分支里。段内另有两处 `+0x154` 读取（`0x140171e4e`、`0x140172e02`，在绑定管理器里），没核对基址是不是 `G`。**透视场景里 zoom 不起作用**，相机图层或路径给的 zoom 也一样。
- `alignmentfliph`（`R+0x128` 0x800）：第 0 行乘 −1（常量 `0x140493050` = −1 只乘 float 0–3，`0x140492e30` = 1 乘其余），即**水平镜像**，两种投影都做。

### 对实现的含义
- 透视场景的 P 用 `perspectiveRH_reversedZ(fov°→rad, canvas 宽 / canvas 高, nearz, farz)`，深度清 0、测试用大于（以深度那份为准）。宽高比取画布，不经过 Kabegame 的壁纸样式铺放；`fit` / `center` 这些样式在 WPE 的透视场景里没有对应，要另定规则。
- `general:zoom`、相机对象的 zoom 在透视场景里可以判为中性。
- 正交投影要和透视统一成反向深度，混画 3D 物体时深度才一致。

### 建议实测
- 工程 A（透视、不写 fov / nearz / farz）：一个已知位置的立方体或带 `perspective: false` 的图像四边形，`camera` 固定（无 `paths`）。RenderDoc 读 `g_ViewProjectionMatrix`（ID 0xb）与 `g_EyePosition`，和公式逐项比；分别用 1920×1080、1280×1024 的 `-playInWindow` 窗口确认宽高比取窗口。
- 工程 A′：fov 30、nearz 1、farz 100；读深度缓冲：近处物体深度应接近 1，远处接近 0；看 OM 状态里的深度比较函数。
- 工程 A″：透视场景写 `zoom: 2`、`alignment: 1`，确认画面与 A 逐像素相同。

---

## 2. 透视场景的分辨率与 2D 图层

### 2.1 W / H 与相关量
- **W / H 在透视场景里是 0**【确，有界：场景段内对 `G+0x354/+0x358` 的全部写入】。只有三处写入：
  - `0x14018759e` / `0x1401875c0`：`orthogonalprojection` 的 `width` / `height`；
  - `0x14018b322`：正交 `auto` 时取第一个图像层的 `size`（`FUN_14018b2c0`），并把该层原点挪到 (w/2, h/2, 0)；
  - 构造时清零（`0x140186fcd` qword 0x350、`0x140186f61` qword 0x358）。
- `Wi / Hi`（`ctx+0x84 / +0x88`）只在同两处写（`0x1401875eb`、`0x14018b331`），透视场景里也是 0【推：构造值没逐项核对】。
- `g_Screen`、`g_TexelSize`、`g_TexelSizeHalf` 两种场景都取 Ws / Hs（p2 I4）。
- **`g_EyePosition`**：`FUN_1401891a0` 先写 `ctx+0x68 = eye`（`0x140189d0f`），lookAt 在 `0x140189d27`，只有正交才加 (Wi/2, Hi/2) 并把 z 置 2000（函数`0x140189dbf`–`0x140189df0`，`G+0xe0 & 8` 判断）。透视场景里就是当前相机的世界坐标，包含路径、相机图层、抖动的结果【确】。
- `_rt_*` 的尺寸本文没查；p2 的结论是全屏 RT 跟后备缓冲走，与 W / H 无关【推】。

### 2.2 2D 图层用什么矩阵【推】
- 绘制循环 `FUN_14018aac0` 只在「正交 + 视差」时改 V，图像层绘制只在 `obj+0x120` bit7（`perspective`）时换矩阵（`0x1401e9233`、`0x1401e9e9f`，第 7 节）。所以透视场景里的普通图像层、文本层与 3D 物体**共用同一个 V、P**，四边形尺寸 = `size × scale`，单位是世界单位。
- 语料核对：3453730450 的图像层 scale 都是 0.001–0.01，原点 z 从 −30 到 10，就是按世界单位摆的（`scan_persp_imgs.py`）。
- neon_sunset 的两个图像层都是 `fullscreen`（`models/cloudsbg.json` 里有 `"fullscreen": true`，另一个是 `models/util/fullscreenlayer.json`），走全屏路径，归「图像模型标志」那份。
- 「没有别的矩阵切换」没有逐个图层类型核对，只看了图像层与粒子的 bit7 分支，所以记【推】。

### 对实现的含义
- 透视场景的场景尺寸不能拿 W / H：投影用画布像素，`g_Screen` 用画布，`g_EyePosition` 用 eye。正交专用的 Wi / Hi 相关量（透视覆盖里的 `Wi·ctx+0xf8`）在透视场景里都按 0 处理。
- 普通 2D 图层在透视场景里按 3D 四边形画（模型矩阵 × 同一个 VP），不需要第二套正交矩阵。

### 建议实测
- 工程 B（透视）：一个普通图像层（`size 256 256`、`scale 0.01`、原点 (0, 0, −5)）加一个 `fullscreen` 层，各挂一个读 `g_ModelViewProjectionMatrix` 和 `g_Screen` 的探针着色器。确认普通层的 MVP = M·V·P、`g_Screen` = 窗口尺寸。
- 同一工程读 `g_EyePosition`，应等于 `camera.eye`（不加 W/2，z 不是 2000）。

---

## 3. 相机路径（`camera.paths`）

### 3.1 文件格式与解析（`FUN_140198e20`）【确】
- 加载：`FUN_140186c90` 在 `0x140188597`–`0x1401885e9` 先清空 `G+0x310`，再对 `camera.paths` 里每个字符串调一次解析器，结果按文件顺序、文件内路径顺序追加。
- 根对象要有 `paths` 数组。对每个路径：
  - 不是对象，或 `transforms` 不是非空数组 → **`break`**，同一文件后面的路径都不读；
  - `disabled` 为 bool 且 true → 跳过；
  - `duration`：`asFloat`，缺省 0。
- 对每个 transform：
  - 不是对象就跳过；`disabled: true` 也跳过；
  - `eye`、`center`、`up`：字符串，空格分隔、`atof` 三次，缺的分量是 0；**缺键时整个向量是 (0, 0, 0)**，`up` 也是（不是 (0, 1, 0)）；
  - `zoom`：有这个键才 `asFloat`，否则 1；
  - `timestamp`：是数字（jsoncpp 类型 1–3）就用；否则第 i 项取 i/(n−1)·duration，第 0 项是 0。
- 存储：路径 0x20 字节（关键帧向量的 begin / end / cap，`+0x18` = duration）；关键帧 0x2c 字节 = t、eye、center、up、zoom，共 11 个 float。
- 样本（6 个默认工程，都是 `scripts/camera_00.json`）：
  - 1–6 条路径，每条 1–2 个关键帧，`timestamp` 都写了，最后一帧的 `timestamp` 等于 `duration`；
  - 只有 neon_sunset 写了 `zoom`；它只有 1 个关键帧（t = 0，duration 5）；
  - up 大多是 (0, 1, 0)，fantasticcar 的 up 带倾斜。

### 3.2 每帧求值（`FUN_1401891a0` `0x1401894a9`–`0x140189b07`）【确】
- 只在没有活动相机图层、且路径非空（`G+0x310` 非空且第 0 条有关键帧）时走这条路。
- 状态：路径下标 `G+0xe4`、关键帧下标 i = `G+0xe8`、本路径内时间 t = `G+0xec`。
- 设当前路径的关键帧为 k[0..n−1]，先求本帧的值，再推进时间：
  1. t < k[i].t：取 k[i]；段末 e = k[i].t + (i+1 < n ? k[i+1].t : 0)。
  2. 否则若 i 是最后一帧：取 k[i]；e = duration − k[i].t。
  3. 否则插值：s = (t − k[i].t)/(k[i+1].t − k[i].t)，e = k[i+1].t。
     - 对 eye、center、up、zoom 的每个分量，用 Hermite 基 h00 = 2s³ − 3s² + 1、h10 = s³ − 2s² + s、h01 = 3s² − 2s³、h11 = s³ − s²；
     - **两端切线都是 m = (p1 − p0)/2**（Catmull-Rom 公式里把段外的点换成端点本身），不乘段长；
     - 等价于 p0 + (p1 − p0)·(−s³ + 1.5s² + 0.5s)，两端速度是中间的 0.4 倍；
     - up 不归一化，靠 lookAt 内部归一化。
- 写进当前值后做抖动（第 5 节）。
- 推进：t += dt（帧 dt，与 `g_Frametime` 同源，即帧函数的 `xmm10`）。若 t > e：
  - 若 i+1 < n 且 duration > k[i+1].t：i = i+1；
  - 否则切到下一条路径（下标 +1，越界回 0），i = 0，**t = 0**（`0x140189ad9` 一次清零 8 字节）。
- 路径之间不混合，直接切（硬切）；全部播完从第一条重来，永远循环。剩余的 dt 在切换时丢掉。
- 有路径时，基准 eye / center / up / zoom 不参与（每帧被覆盖）；正交场景有路径时也不做 p3 L2 的加载末尾重置。

### 3.3 怪癖（照读码，按需复刻）
- 「保持最后一帧」的段末是 duration − k[last].t，而 t 是从路径开头算的绝对时间。k[last].t > duration/2 时，下一帧就切走。样本里最后一帧的 t 都等于 duration（走 3 的条件判断直接切），或只有一帧且 t = 0（neon_sunset 保持 5 s），所以碰不到。
- t < k[0].t 的段末是 k[0].t + k[1].t，同样是读码结果，样本里 k[0].t 都是 0。

### 对实现的含义
- 相机来源做成「相机图层 > 路径 > 基准」三选一，每帧在脚本之前求值。路径求值是纯函数（路径表 + 状态三元组 + dt），可以单测。
- 关键帧不必按段长缩放切线；硬切；循环。

### 建议实测
- 工程 C（透视）：`camera.paths` 指向自造的文件，两条路径。
  - 第一条 3 个关键帧（t = 0 / 2 / 4，duration 4），eye 沿 x 线性摆开；第二条 1 个关键帧，duration 2。
  - 用固定 fps 抓帧，读 `g_EyePosition`，拟合 s 曲线（应为 −s³ + 1.5s² + 0.5s）。
  - 确认第 4 s 处硬切、6 s 处回到第一条。
- 工程 C′：一条路径的最后一帧 t = 3、duration 4，看实际在第几秒切走，核对 3.3 的怪癖。

---

## 4. 相机对象

### 4.1 创建与字段【确】
- `FUN_14018ff60`（`0x140190654`）：对象有 `camera` 成员且是字符串（jsoncpp 类型 4）时，建 0x360 字节的相机图层：
  - 基础对象构造 `FUN_1401ddbb0`，虚表 `0x140490980`；
  - 推进 `G+0x1f8`（`FUN_14019e140`），顺序是 JSON 里的对象顺序【推：未核对对象创建顺序】。
- `camera` 的字符串值除了类型判断外没看到读取【确，有界：只看了创建分支】；语料全是 `"default"`。
- 类表 `0x1404e8460` 的描述符：

| 键 | 偏移 | 缺省 | 说明 |
|---|---|---|---|
| `visible` | `+0x120` bit0 | 1（基础构造写 `0x2001`，`0x1401ddc72`） | 可绑定 |
| `fov` | `+0x2d8` | 50 | float，可绑定 / 挂脚本 |
| `zoom` | `+0x2dc` | 1 | float，可绑定 / 挂动画 |
| `queuemode` | `+0x350` | 0 | 枚举：`random` = 0，`sequential` = 1（字符串 `0x140478098` / `0x140490960`） |
| `origin` / `angles` / `scale` / `parent` | 基础对象 `0x128` / `0x140` / `0x134` / `0x180` | 0 / 0 / 1 / 空 | 同其它对象 |

- `path` 不是描述符，由虚函数 +0x40（`FUN_1401f2030`）读文件，见 4.4。

### 4.2 选哪一个、怎么变成 V / P（`FUN_1401891a0` `0x140189205`–`0x14018942a`）【确】
- **选择：** 从 `G+0x1f8` 末尾往前找第一个满足条件的：自身 `+0x120` bit0 为 1，且没有父对象或父链可见（`FUN_140185010`）。也就是**按 JSON 顺序最后一个可见的相机生效**。
  - `visible: false` 的相机完全不参与，它的条目动画也不更新（4.4）。
  - 都不可见时退回路径 / 基准。
- **生效后**，取 Wc = 相机世界矩阵（虚函数 +0x80 = `FUN_1401850a0`，含父链）：
  - eye = Wc 的平移（第 3 行）；
  - center = eye − Wc 第 2 行（**看向本地 −Z**；行带缩放，lookAt 会归一化）；
  - up = Wc 第 1 行（本地 +Y）；
  - zoom（`G+0x114`）= 当前条目 ? 条目 `+0x338` : 对象 `+0x2dc`；
  - 透视场景还设 `G+0x148` = 当前条目 ? 条目 `+0x33c` : 对象 `+0x2d8`。正交场景**不**改 `G+0x148`，所以正交场景里相机对象的 fov 没有作用，透视覆盖仍用 `perspectiveoverridefov`。
  - 然后照常做抖动、fov 钳制、视差、lookAt。

### 4.3 正交场景里的相机对象（读码结论与样本冲突）
- 读码：V = lookAt(eye, eye − Wc 第 2 行, Wc 第 1 行)。angles 为 0 时就是平移 −eye；正交 P 仍是 ortho(0..W, 0..H)（`0x140183e1b`–`0x140183e95`，与相机无关）。
  - 世界点 (x, y) 显示在投影坐标 (x − eye.x, y − eye.y)；angles 会旋转视图。
  - `g_EyePosition` = (eye.x + Wi/2, eye.y + Hi/2, 2000)。
  - zoom 经正交 zoom 生效（第 4 步），zoom > 1 放大：P 的第 0、1 行乘 zoom，前后各有绕 (W/2, H/2) 的平移【确：缩放；推：平移的方向】。
- 冲突：语料 12 张正交场景有可见相机，其中 11 张是同一模板（id 1297271 等）：
  - `origin` 挂脚本 `value.x = x·engine.canvasSize.x; value.y = y·engine.canvasSize.y`，滑块缺省 0.5；
  - JSON 值是 (2434.38, 725.25, 500)，`zoom` 绑用户属性（多为 1，3516174947 为 0.75）。
  - 按读码，原点 (W/2, H/2, 500) 会让画面整体移向左下半屏，作者不会这样发布。
  - 可能：引擎里有我们没读到的补偿；`canvasSize` 不是 (W, H)；或者这些场景在 WPE 里确实偏。**必须实测**（见下）。
- 另一张正交场景 3554161528：origin 为 0，`visible` 绑用户属性（缺省 true），`zoom` 挂关键帧动画。按读码视图不平移、只有 zoom 动画，和意图一致。

### 4.4 `path`、`queuemode` 与条目动画
- 解析（`FUN_1401f2030`）【确：键名；推：语义】：
  - 读 `path` 指向的文件，取 `paths` 数组；
  - 每项建一个条目对象（虚表 `0x140490a28`），读 `options`、`events`、`center`、`eye`、`up`、`zoom`、`fov`（`FUN_1401f1bc0` ×3、`FUN_1401a8ce0` / `FUN_1401a98b0`），条目再走一次描述符套用（`FUN_1401730d0`）。
- 更新（虚函数 +0x48 = `FUN_1401f2ad0`，在步骤 2 开头对 `G+0x158` 的循环里调用【推：相机图层在 `G+0x158` 里】）：
  - 相机不可见、父链不可见、或条目表为空（`obj+0x2f8 == 0`）就直接返回。
  - 当前条目 `obj+0x2e0`（−1 为无）结束（条目 `+0x104` bit30）时，清标志、时间归零，再按 `queuemode` 选下一个：
    - `random`：从 `obj+0x2f0` 的集合建「洗牌袋」（`obj+0x328`），随机取一个（随机源 `ctx+0x1cd0`），避免和上一个（`obj+0x340`，`+0x344` 为已有标志）重复，取出后从袋里删掉；袋空了重建。
    - `sequential`：下标 +1 取模，跳过 `+0xf0` bit0 为 0 的条目。
  - 推进条目时间（`FUN_1401a9f60(dt, 条目+0xf8)`，按帧长 `+0xf8` 定位帧）；`center` / `eye` / `up` 三条轨各分量在相邻两帧间**线性**插值（`FUN_1401a9bc0`）；没有轨的分量用相机当前的 eye / eye − 5·normalize(Wc 第 2 行) / normalize(Wc 第 1 行)。
  - 把结果变成 lookAt，再分解成欧拉角，**写回相机对象自己的 origin 与 angles**（`obj+0x128`、`FUN_1401dd630`）。
  - 正交（`ctx+0x118` 0x400）时条目 zoom（`+0x338`）= `zoom` 轨或 1；透视时条目 fov（`+0x33c`）= `fov` 轨或 50。
- **语料 22 个相机对象的 path 文件全是 `{"paths": []}`**（`scan_cam.out.txt`），条目表为空，相机只是静态对象（加上 origin / fov 上的脚本与动画）。轨的具体格式没细读【未知】。

### 4.5 语料（14 张、22 个）
- 正交 12 张、12 个：上面的模板 11 个（`visible` 缺省 = 生效），3554161528 1 个。
- 透视 2 张、10 个：
  - 3453730450：id 208 可见，`origin` 脚本从 z = 9 起；id 200 `visible: false`。生效的是 208。
  - 3706286085：8 个相机都是 `visible: {user, value: false}`，`fov` 挂脚本。缺省都不可见 → 用 `camera` 基准；用户打开哪个就用哪个（多个同时打开时取 JSON 里靠后的）。

### 对实现的含义
- 相机图层：作为普通对象参与层级、脚本、动画与可见性，每帧按「最后一个可见」选出，用它的世界矩阵产生 eye / center / up。透视用它的 fov，两种场景都用它的 zoom（透视下无效）。条目动画可以先报 `camera:path`（语料 0 张非空）。
- 正交相机的平移语义要等 4.3 实测定。实测前，带可见相机的正交场景继续报 `object:camera`。

### 建议实测
- 工程 D（最优先，正交 1920×1080）：一张铺满的图像层 + 一个 `camera: "default"` 对象，origin 分别取 (0, 0, 0)、(960, 540, 500)、(200, 100, 0) 三个版本；另做一个用模板脚本（`0.5·canvasSize`）的版本。截图看画面平移多少，同时读 `g_EyePosition`；脚本里 `console.error(engine.canvasSize)`。
- 工程 D′：同一相机加 `angles "0 0 0.3"`、`zoom 2`，看旋转和缩放中心。
- 工程 D″（透视）：两个可见相机（不同 fov 和位置），确认 JSON 里靠后的生效；把它设成 `visible: false` 后应切到前一个。

---

## 5. `camerashake`（`FUN_140199580`）【确】

- **调用：** `G+0xe0` bit7（`camerashake`）为 1 时，在三种相机来源里各调一次（`0x140189420` 相机图层、`0x14018949f` 基准、`0x140189a6f` 路径），参数都是 (G, &eye, &center)。在 lookAt 之前、视差之前。
- **算法：**
  1. e = roughness³（`FUN_14041e350` = powf）；amp = amplitude × 0.1；T = speed² × `ctx+0x130`（`g_Time`，场景时间，超过 432000 归零）。
  2. v = (cos T, sin(1.333·T), sin T)（`FUN_14041a2e0` = cosf：小参数返回 1.0，常量 `0x140471cb8`；`FUN_14041a9c0` = sinf）。
  3. **正交：** v.z = 0，amp = H × 0.1 × amp = **0.01 × amplitude × H**（场景像素）。**透视：** amp = 0.1 × amplitude（世界单位）。
  4. 若 e > 0.001 且 e ≠ 1：L = |v|，v = v/L · L^e（只改长度，方向不变）。
  5. eye += v·amp，center += v·amp（同一偏移，纯平移，不转动）。
- 缺省 speed 3、amplitude 0.5、roughness 1（p3 L14），e = 1，跳过第 4 步。
- 随机源：没有，完全由 `g_Time` 决定。时间步进：跟 `g_Time` 走（含 rate 缩放与否同 `g_Time`）。
- 也作用于 `g_EyePosition`（先抖动、后写 `ctx+0x68`），并经 eye.xy 影响视差点（第 6 节）。
- 语料开 `camerashake` 的 7 张：正交 5 张、透视 2 张（ricepod、3706286085）。ricepod 的 roughness 0.1 → e = 0.001，「e > 0.001」在 float 下的结果要实测。

### 对实现的含义
- 一个纯函数 `shakeOffset(g_Time, speed, amplitude, roughness, ortho, H)`，加到 eye 和 center 上，在 lookAt 前。正交是 xy 平移，透视是三维平移。
- 能和 `g_Time` 同源回放，确定性对拍容易。

### 建议实测
- 工程 E（正交 1920×1080）：`camerashake` 开，speed 1、amplitude 1、roughness 1；一个小图像层在中心。按 RenderDoc 读到的 `g_Time` 读该层 MVP 的平移，和 (10.8·cos T, 10.8·sin 1.333T) 像素比。再测 roughness 2 看长度指数，roughness 0.1 看临界值。
- 工程 E′（透视）：同参数，读 `g_EyePosition` 的三维偏移。

---

## 6. `cameraparallax`

### 6.1 开关与输入【确】
- **场景开关：** general `cameraparallax` = `G+0xe0` bit8。
  - 视差点每帧都算（只要 bit8 为 1）；
  - **对象偏移只在 bit8 且 bit3（正交）时做**：绘制循环 `FUN_14018aac0` 的 `(G+0xe0 & 0x108) == 0x108`；命中测试 `FUN_140189e10` 同样要 bit8 与 bit3。
  - **透视场景开了视差也不移动对象**。语料开视差的 41 张全是正交。
- **壁纸属性 `cameraparallax`**（与 `rate` / `volume` 同一通道；首次加载在 `FUN_140113c80` 的 `0x140114f30`–`0x140114f71`，运行中改属性在 `FUN_140115280` 的 `0x14011544e`–`0x1401154ac`，尾跳 `FUN_140115a90`）：值为对象时读 `value`：
  - false → 置 `R+0x128` 的 0x200（并同步宿主 `+0x248`，`FUN_140115a90(inst, 置位, 清位)`）；true → 清 0x200；键缺失或不是对象 → 两个掩码都是 0，不变。
  - 0x200（以及来源不明的 0x200000）**只把 mouseinfluence 当 0**（`0x140189b67`），视差点退回 eye.xy + 场景中心，各层的静态偏移仍在。
- **指针：** `ctx+0x8c / +0x90`，渲染线程每帧 `GetCursorPos` → `ScreenToClient(渲染窗口)` → 除以 (Ws, Hs)（`0x14011161a`–`0x14011164b`），左上为原点、y 向下、不钳制。
  - 桌面与预览用同一段代码，区别只在窗口：桌面是覆盖显示器的壁纸窗口，`-playInWindow` 是那个窗口的客户区【推】。

### 6.2 视差点 P（`FUN_1401891a0` `0x140189b67`–`0x140189cea`）【确】
- mx = clamp(ptr.x, 0, 1)，my = clamp(1 − ptr.y, 0, 1)（场景 y 向上）。`R+0x128 & 0x800`（水平翻转）时 mx = 1 − mx。
- mi = (0x200 或 0x200000 置位) ? 0 : `cameraparallaxmouseinfluence`（`G+0x33c`）。不钳制，语料有 −2、1.0、−0.22。
- 目标：Ptgt = eye.xy + (W·(0.5·(1 − mi) + mx·mi), H·(0.5·(1 − mi) + my·mi))。eye 是本帧当前值（含相机图层、路径、抖动）。
- 平滑：delay = `cameraparallaxdelay`（`G+0x338`）。
  - delay > 0：k = min(1, (1 − delay/3)·10·dt)，P ← P + (Ptgt − P)·k；
  - 否则 P = Ptgt。
  - dt 是帧 dt；delay ≥ 3 时 k ≤ 0（语料最大 2.0）。
- P 存 `G+0x340 / +0x344`。加载末尾（`0x14018870c`）：正交时初值 = eye.xy + (W/2, H/2)，透视时为 0。所以开场有一段从中心滑到指针的过渡。
- **`g_ParallaxPosition`**（ID 0x6b，`ctx+0x9c / +0xa0`）= (clamp(P.x/W, 0, 1), clamp(P.y/H, 0, 1))，水平翻转时 x 取 1 − x。
  - 加载时写 (0.5, 0.5)（`0x1401886ea`），只在 bit8 为 1 时每帧更新【确，有界：场景段与渲染线程内对 `ctx+0x9c` 的写入】；
  - 和对象偏移无关、只进 uniform。语料里 16 张着色器读它，视差关时读到的恒为 (0.5, 0.5)。
  - 透视场景 W = 0 时除出 NaN，钳制分支把它变成 0【推】。

### 6.3 对象偏移（`FUN_14018aac0`，读 amount `0x14018b074`、写 `obj+0x178/0x17c` `0x14018b0ab`–`0x14018b0b9`）【确】
- 对绘制列表里每个要画的对象（虚函数 +0x68 为真；列表是 `G+0x158`、`G+0x1c8` 或排序后的 `G+0x250`，子对象也在里面）：
  1. 视图栈压一层（拷贝当前 V），`ctx+0x1ca` 置脏（MVP 重算）。
  2. 沿 `obj+0x180` 走到**根对象** r。
  3. o.x = amount · r.parallaxDepth.x · (r.origin.x − P.x)；o.y 同理；amount = `cameraparallaxamount`（`G+0x334`）；z 恒 0。
  4. 存进 `obj+0x178 / +0x17c`（图层合成矩阵也会读，`0x1401ed27f` 起把它乘到保存的 V 上）。
  5. V′ = T(o.x, o.y, 0)·V（行向量下，等于世界空间先平移 o），然后画，再弹栈。
- 含义：
  - 指针居中且 eye = 0 时，P = 场景中心，对象被推离中心：o = amount·depth·(origin − 中心)，**静止时也有偏移**，原点不在中心的层会被挪开。
  - 指针右移时 P.x 增大，depth > 0 的层左移。
  - 只用根对象的 origin（字段值，不是世界矩阵）和 parallaxDepth；子对象整体随根平移，**子对象自己的 parallaxDepth 不参与绘制**。
  - 粒子、文本、模型等类型一视同仁（只要在绘制列表里、经 V 画）。粒子模拟期间 V 未偏移，指针跟随的控制点不含视差（rea-p4c-sim 的反投影用的是步骤 2 的 V）【推】。
- **parallaxDepth 缺省是 (1, 1)**（基础构造 `0x1401ddce1`、`0x1401ddcec` 写 1.0），描述符只在键出现时覆盖【推，同 p3 I3】。语料：`0 0` 707 次、`1 1` 220 次、`-0.7 -0.7` 133 次，另有绑用户属性的（`hudparallax` 0.01 等）；写了该键的对象类型分布：图像 824、文本 431、粒子 161、分组 56、声音 21、模型 8、灯 5。
- **命中测试不一致：** `FUN_140189e10` 只给类型 1 / 4 的对象算偏移，用的是**对象自己**的 origin 与 parallaxDepth（不是根）【确】。

### 对实现的含义（尽量可直接实现）
- 每帧（脚本之前，与相机同一步）：
  1. 取 eye（抖动后）、W、H、指针（画布归一化，左上原点）、mi、delay、dt；
  2. 按 6.2 更新 P，写 `g_ParallaxPosition`。
- 绘制每个对象时：o = amount · depth(root) ⊙ (origin(root).xy − P)，视图左乘平移 o。需要根对象的当前 origin 字段（脚本 / 动画后的值）。
- P 的初值 = eye.xy + (W/2, H/2)。
- 壁纸属性 `cameraparallax`（若 Kabegame 要支持这个用户开关）只置零 mi。
- 宿主侧：预览与桌面都把指针换成画布归一化坐标。没有指针时的取值要定（WPE 窗口外的坐标不钳制，会超出 0..1，再由这里钳）。
- 命中测试的偏移要另按「对象自身」实现，才和 WPE 一样。

### 建议实测
- 工程 F（正交 1920×1080，`cameraparallax: true`，amount 0.5，delay 0，mouseinfluence 1）：
  - 四个小方块：原点 (960, 540) depth (1, 1)；原点 (1460, 540) depth (1, 1)；原点 (460, 540) depth (−0.7, −0.7)；原点 (960, 840) depth (0, 1)；外加一个父分组（depth (1, 1)）下挂子方块（depth (0, 0)）。
  - 用测试脚本把光标放到窗口 (0.5, 0.5)、(1, 0.5)、(0, 0) 等位置（`SetCursorPos`），每个位置抓一帧，读每层 MVP 平移与 `g_ParallaxPosition`，和 6.2 / 6.3 的公式比。
  - 子方块应只跟父的偏移走。
- 工程 F′：delay 0.3、固定 fps，光标从左跳到右，逐帧读 P（经 `g_ParallaxPosition`）拟合 k。
- 工程 F″：不写 parallaxDepth 的图层，确认它按 (1, 1) 移动。
- 工程 F‴：`-control applyProperties` 发 `{"cameraparallax": {"value": false}}`，确认光标不再影响、但静态偏移不变。

---

## 7. 图像层 `perspective: true`

### 7.1 字段与读取点【确】
- 描述符：图像层类表 `0x1404e8360`、粒子类表 `0x1404e8760` 的 `perspective` → `+0x120` bit7（setter `0x14019c620`：`bts/btr 0x7`）。
- 图像层绘制在 `0x1401e9233` / `0x1401e92c4` / `0x1401e9e9f` 检查 bit7；粒子在 `0x140222770` / `0x140222fe6` 检查同一位（rea-p4a C3 的 bit2 是粒子定义里的 flags，最终也落到这个绘制分支）。
- 置位时：压栈 P 和 V（拷贝），调 `FUN_1401e5b60(ctx)`，画完弹栈。命中测试（`FUN_140189e10`）对 bit7 的对象改用另一组矩阵（`G` 虚函数 +0x40 给的），图层合成矩阵在正交 + bit7 时经 `FUN_140184f00` 换算（`0x1401ed27a`）。

### 7.2 `FUN_1401e5b60`【确】
- fov = `ctx+0x110`：
  - 正交场景 = radians(`G+0x148`) = radians(`perspectiveoverridefov`)，缺省 95，钳 [0.1, 179.9]；
  - 透视场景 = 2·atan(1/(P11·2000))，见 1.1。
- d = (1/P11)/tan(fov/2)，P11 是当前（已含正交 zoom 的）投影 m11。正交下 1/P11 = 可见高/2，所以 d 正好让竖直视场覆盖可见高。
- 改当前 V（已是压栈后的拷贝，含视差平移）：t.x −= Wi·`ctx+0xf8`，t.y −= Hi·`ctx+0xfc`，t.z = −d。
  - `ctx+0xf8 / +0xfc` 是 crop 后可见区中心占 W / H 的比例，无 crop 时 0.5；即相机放到 (可见区中心, d)、看 −Z。
- P = 反向深度透视（`FUN_14009a360`），fov 如上，aspect = Ws/Hs，near = **5**（`0x140492858`），far = max(15000, d + 1000)（`0x14049295c`、`0x140492944`）；水平翻转位照做。
- `g_EyePosition` 不改，仍是正交值 (W/2, H/2, 2000)，与这个临时相机的真实位置 (·, ·, d) 不同。

### 7.3 效果
- 图层自身的模型矩阵（含 angles 的 x / y 旋转）不变。z = 0 平面上的点投影位置与正交相同，离开 z = 0 的部分（旋转后的四边形）按透视收缩：这就是「带 3D 旋转的平面有透视」。
- 1923929928（`models/grid.json`，angles x = −1.309，即向后倒 75°）就是地面网格。另外 3 张：3146703458（6 层，z 轴小角度）、3487328036、3824550659（无 angles），旋转为 0 时画面与正交相同。
- 透视场景里 `perspective: true`：Wi = Hi = 0、crop 比例 0，平移不变，t.z 被强制成 −2000、fov 极小，结果与场景相机无关【推】。语料没有这种组合（4 张全是正交）。

### 对实现的含义
- 渲染器里已有透视粒子的同一套矩阵（P4a C4，`perspectiveoverridefov`），图像层直接复用：bit7 的图层画时换 V′ / P′。注意 V′ 要在视差平移之后再改平移，P′ 用画布宽高比。
- 合成 RT / effect 的投影矩阵也要跟着换（`FUN_140184f00` 段），细节归 P5 的图层标志那份。

### 建议实测
- 工程 G（正交 1920×1080）：两个同样的 512×512 图像层，一个 `perspective: true`、angles x = −1.0，一个 `perspective: false` 同角度。分别用 `perspectiveoverridefov` 95 和 50 抓帧，读 MVP，与 7.2 公式比；再加 `general.zoom 1.5` 看 d 是否跟着变。

---

## 8. 相机相关 uniform

ID 来自名字表 `FUN_140002860`（`0x140002a6d`–`0x140003091`，每项 0x28 字节，ID 在 +0x20），取值来自 `FUN_1400d8300` 的跳转表（字节表 `0x1400daaac`、偏移表 `0x1400da984`，`jt.py`）【确】。

| uniform | ID | 取值 | 透视场景 | 正交场景 |
|---|---|---|---|---|
| `g_ViewProjectionMatrix` | 0xb | `ctx+0x930` = V·P（`ctx+0x1ca` 脏时先 `FUN_1400d4200` 重算） | lookAt · 反向深度透视 | V · 正交（含 zoom）；视差 / 透视覆盖时是临时 V′ / P′ |
| `g_ModelViewProjectionMatrix` | 0xd | `ctx+0x8f0` = M·V·P | 同上 | 同上 |
| `g_ModelViewProjectionMatrixInverse` | 0xc | inverse(`ctx+0x8f0`) | | |
| `g_EyePosition` | 0x19 | `ctx+0x68` | 当前 eye（世界） | eye + (Wi/2, Hi/2)，z = 2000 |
| `g_ViewForward` | 0x1a | `ctx+0x160` = −V 第 2 列（`0x14018017e`） | 相机朝向（世界） | 默认 (0, 0, −1) |
| `g_ViewRight` | 0x1b | `ctx+0x16c` = V 第 0 列（`0x1401801a0` 循环） | 相机右（世界） | 默认 (1, 0, 0) |
| `g_ViewUp` | 0x1c | `ctx+0x178` = V 第 1 列（`0x140180240` 循环） | 相机上（世界） | 默认 (0, 1, 0) |
| `g_OrientationForward / Right / Up` | 0x1d / 0x1e / 0x1f | `ctx+0x184 / +0x190 / +0x19c` | 写入点没找到【未知】，推测是逐对象的模型朝向 | |
| `g_AltViewProjectionMatrix` | 0x11 | `ctx+0xab0` | 用途没查【未知】 | |
| `g_ViewportViewProjectionMatrices` | 0x12 | 没读 case 体【未知】 | | |
| `g_NormalModelMatrix` / `g_AltModelMatrix` / `g_AltNormalModelMatrix` | 0xe / 0xf / 0x10 | 模型矩阵类，不属本文 | | |
| `g_ParallaxPosition` | 0x6b | `ctx+0x9c`（vec2），见 6.2 | (0.5, 0.5)（透视开视差时为 0【推】） | 开视差时每帧更新 |
| `g_Screen` / `g_TexelSize` | 8 / 7 | Ws, Hs（p2 I4） | 窗口 | 窗口 |

- 视图向量取自步骤 5（脚本之前）的 V，**不含**每对象的视差平移和透视覆盖。
- 帧函数在步骤 5 把 V、P 存到 `ctx+0x1160 / +0x11a0`，图层合成矩阵用这对副本（`0x1401ed1fa` 起）。
- 二进制里没有 `g_ViewMatrix`、`g_ProjectionMatrix`、`g_CameraPosition` 一类名字（`strs.py` 全量扫描）。

### 对实现的含义
- 渲染器要补 `g_ViewForward / Right / Up`（若有着色器读）；正交下给常量即可，透视下从 V 取列。
- `g_EyePosition` 按场景类型分两种公式。
- 视差平移、透视覆盖都只改「当次绘制」的 V / P，VP / MVP 跟着变，视图向量不变。

### 建议实测
- 工程 H（透视，带路径）：探针着色器把 `g_ViewForward`、`g_ViewRight`、`g_ViewUp`、`g_EyePosition` 编码进颜色，RenderDoc 读常量缓冲，与路径当前帧的 lookAt 比；同时看 `g_OrientationUp` 等在模型和图像层上的值。

---

## 更正与补充（旧文字未改）

- **p2 总表「`R+0x128` 0x800 投影 Y 翻转」、rea-p4a C4「翻转投影的 x 和 y 列」：** 实际只把 P 的第 0 行（float 0–3）乘 −1，是**水平**镜像。依据：`0x140183f7d`–`0x140183fe0` 只对 `[rdi]`、`[rdi+8]` 乘常量 `0x140493050`（−1），其余乘 1；视差里同一位使 mx = 1 − mx（`0x140189b8d` 之后）。与 p3 I5 把它记为 `alignmentfliph` 一致。
- **p2 I4「`g_ParallaxPosition` 每帧由视差逻辑写入（细节没看）」：** 加载时 (0.5, 0.5)，只在 general `cameraparallax` 开时每帧写，公式见 6.2。
- **p3 I1 / I5「`cameraparallax` → `FUN_140115a90` 置 / 清 0x200（视差开关）」：** 这是壁纸属性那个 `cameraparallax`。`FUN_140115a90` 是通用的「置位 / 清位」函数；0x200 置位时只让 mouseinfluence 归零，不关场景视差，也不去掉各层的静态偏移。I1 的「缺陷」说它用非 const `operator[]` 读：读法属实，但缺键时插入的是 null、类型不是对象，两个掩码都是 0，位不变（`0x140115468`）。
- **p3 L2「`eye.xy` 是视差中心」：** 更准确地说，视差点 = eye.xy + lerp(场景中心, 指针, mouseinfluence)，eye.xy 是叠加项。
- **p3 L2 正交投影 `ortho(…, −2000, 2000)`：** 成立。补充：这对参数经包装后是反向深度（离相机越近深度越大），透视也是。
- **p3 L2「第四个 float 叫 zoom 是推断」：** 基准分支把 `G+0x13c` 拷进当前 zoom `G+0x114`（`0x140189484`），路径关键帧的第 11 个 float 也进 `G+0x114`，命名可视为确认。
- **p3 L2「相机图层优先」：** 成立，补充选择规则（倒序找最后一个可见）、`visible: false` 不参与、正交场景里相机 fov 无效。
- **本任务说明里的「相机对象典型形状 `visible: false`」：** 语料 22 个里只有 1 个写死 false（3453730450 id 200）、7 个绑用户属性（缺省 false 6 个、true 1 个），其余 14 个不写（= 可见、生效）。
- **features.ts 注释「`parallaxDepth` 只在视差开时起作用」：** 成立；补充缺省值 (1, 1)，开视差的场景里没写该键的对象也会动。

## 未查清

- **正交场景可见相机的平移（4.3）：** 读码与 11 张模板场景的意图冲突，P5 步骤 0 第一个要测的项。
- `0x200000`（`R+0x128`）由谁置位：wallpaper64 里没找到立即数写入，推测是编辑器宿主。
- 相机条目动画（相机对象 `path` 文件）的轨格式、`options` / `events` 的含义、结束标志由谁置；语料全是空表，没细读。
- 相机图层是否在 `G+0x158`（每帧 +0x48 更新）列表里；创建顺序是否等于 JSON 顺序。
- `g_OrientationForward / Right / Up`、`g_AltViewProjectionMatrix`、`g_ViewportViewProjectionMatrices` 的写入与用途。
- 透视场景里的 `engine.canvasSize`（W / H 是 0）和脚本 `screenResolution` 的取值。
- 深度比较函数、深度清屏值、透视场景的 `_rt_*` 尺寸：归「网格与深度」那份。`fullscreen`、`passthrough`、`cropoffset`、`autosize`、`solidlayer` 在透视场景里怎么画：归「图像模型标志」那份。3453730450 大量使用 `autosize` + `cropoffset`，neon_sunset 靠 `fullscreen`，两份结论要对上。
- ricepod 的 roughness 0.1：e = 0.1³ 与阈值 0.001 的 float 比较结果。
- 透视场景开视差（语料 0 张）时 `g_ParallaxPosition` 的 NaN 钳制结果。
- 指针在窗口外、桌面被其它窗口遮挡时的取值（`ScreenToClient` 失败分支保持旧值，没细看）。
