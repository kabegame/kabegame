# REA：P8 步骤 0 —— 对象级几何与采样：形状对象、对齐、`clampuvs` / `nointerpolation`（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出（只做静态分析，没有运行、附加或启动 WPE）。置信度三档：**静态确认**（反编译或汇编直接看到）、**推断**（由代码推出，或依赖别处没逐行读的代码）、**未知**。
> 反编译出的字符串与代码只当数据看。地址一律是镜像基址 `0x140000000` 下的虚拟地址。

## 方法

- 分析副本：`d:\Codes\kabegame\ignore\p8\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（开工时 `sha256sum` 复核一致）。
- REA（Ghidra 12.1.4）从 `ignore\p8\rea\layer\start.rea-snapshot` 打开，结束时另存 `ignore\p8\rea\layer\wallpaper64-2.8.42-p8layer.rea-snapshot`。本轮没有改分析元数据（没有改名、加注释），快照与起点只差 Ghidra 自身的缓存。
- 汇编按地址切自 `ignore\p4\rea\wp.asm`；常量、字符串、虚表用 `ignore\p8\rea\*.py`（`slice.py`、`grepfn.py`、`xr.py`、`vtdump.py`、`ptr.py`、`rd.py`、`strs.py`、`fn.py`）直接读副本。
- 本轮的产物都在 `ignore\p8\rea\layer\`：
  - 反编译：`dec\f_<地址>.c`（新导出 `14025fac0`、`14025faf0`、`14025ff50`、`140260190`；另从 `ignore\p5\rea\modelflags\` 拷来 `1401e6f50`、`1401e8aa0`、`1401ea310`、`1401ea500`、`1401ebf60`、`1401ecb20`、`1401ede30`、`1402066a0`、`1402091e0`、`140209360` 等）。`split.py` 把 `batch_decompile` 的 JSON 拆成这些文件。
  - 汇编摘录：`shape_load_14025fac0.asm`、`shape_draw_14025faf0.asm`、`shape_combos_14025ff50.asm`、`shape_rebuild_140260190.asm`、`shape_vt108_120_128.asm`、`f_14025f8a0.asm`（按名读材质常量）、`image_quads_align_1402066a0.asm`、`image_world_1401fd3f0.asm`、`align_desc.asm`、`align_enum_140212262.asm`、`align_fns.asm`、`clamp_desc.asm`、`flag_setters_14019bb40.asm`、`composite_flags_1401ea500.asm`、`sampler_140099980.asm`、`hittest_14018a020.asm`、`hit_image_14019dbb0.asm`；虚表对照 `vt_shape.txt` / `vt_image.txt`；grep 模式 `pat*.txt`。
  - 语料小扫描（只读语料）：`scan\shape_consts.py` → `shape_consts.txt`（形状对象 effect 实例的 `point0..3` 等常量）、`scan\shape_parents.py`（形状的父对象）、`scan\script_alignment.py` → `script_alignment.txt`（脚本里的 `.alignment`）、`scan\texflags_sum.py`（汇总已有的 `ignore\p8\out\texflags.json`）。
- 锚点：
  - 形状：分派 `FUN_14018ff60` 的 `0x140190768`–`0x1401907de`，虚表 `0x140491d10`（与图像层虚表 `0x1404911a8` 逐槽对照，见 `vt_shape.txt` / `vt_image.txt`）。
  - 对齐：字符串 `alignment`（`0x140488490`）在 `0x14021113a` 的描述符登记；`+0x4b1` 的两处读取 `0x1401fd3f6`、`0x1402069fa`。
  - 采样：合成 RT 分配 `FUN_1401ea500` 里调虚函数 `+0x128` 之后的标志计算（`0x1401ea5b1`–`0x1401ea71b`）；采样器创建 `FUN_140099980`（调 `ID3D11Device::CreateSamplerState`）及其 7 个调用点。
- 没有 PDB。下文命名：**图层 L**（图像层，虚表 `0x1404911a8`）、**形状 S**（虚表 `0x140491d10`，0x460 字节）、**`ctx`** = 对象 `+0xc8`（渲染上下文）、**`W`** = 对象世界矩阵、**`dev`** = `ctx+0x1518`。矩阵一律按 WPE 的行向量约定写（`v' = v · M`）；换成我们 `layout.ts` 的列向量约定时顺序反过来。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1a | 形状虚表 +0x128 | 和图像层同一个槽（`FUN_1402091e0`「合成 RT 尺寸查询」）：输出 `点采样=0`、UV 缩放 `(1,1)`、合成 RT 尺寸与纹理尺寸都是 `(正交宽/2, 正交高/2)`。只给 `FUN_1401ea500` 定合成 RT 与 effect fbo 的基准尺寸；`lightshafts` 没有 compose、没有 fbo，实际不用。 | 静态确认 |
| 1b | 形状的几何 | **不是正方形**：加载时 `size := (正交高, 正交高)`（JSON 写了 `size` 会覆盖），然后在 `+0x110` 里按**第一个 effect 第一个 pass 材质的 `point0..point3`** 建一个任意四边形：顶点 `(Sx·p.x − Sx/2, Sy·(1 − p.y) − Sy/2, 0)`，UV = `p`，三角形 `(0,2,1)(0,3,2)`。材质里找不到这四个常量时才退回以原点为中心的 `Sx × Sy` 方块、UV 0..1。`scale`、`angles`、`origin`、父链经 `W` 起作用。 | 静态确认（透视场景的边长为推断） |
| 1c | 形状画哪个 effect | `effects` 列表的**最后一个**，不看它的 `visible`（列表里包括不可见的 effect，形状绘制不检查可见位）；前面的 effect 永远不画；最后一个不可见也照画。几何却取**第一个** effect 的点。 | 静态确认 |
| 1d | `FUN_1401ebf60(this, effect, i, -1, 1)` | `-1` = 没有当前合成 RT：不给槽 0 赋值，`bind` 里的 `previous` 跳过；`1` = final 模式：最后一个绘制 pass 调虚表 +0x108（形状：混合强写 additive）、画形状四边形，其余 pass 画 `+0x2e0`（形状上通常为空，多 pass 的 effect 会解引用空指针）。MVP = `W`（不含对齐偏移，含父链）× 场景视图（含视差平移）× 场景投影；`perspective` 时换透视。`g_Color4` / `g_Alpha` 不写（残留值）；效果矩阵若被着色器声明，取单位阵与 `diag(Sx/2, Sy/2, 1, 1)`；空槽的 `g_TextureNResolution` = (2,2,2,2)。 | 静态确认 |
| 1e | 画到哪、管线状态 | 画到当前目标（场景目标；父对象是组合层时是它的合成 RT），没有基础 pass、没有合成 RT。混合 additive（`SRC_ALPHA / ONE`），深度、剔除取材质（`lightshafts` 都关）。每个 pass 加载材质前 `combos.DIRECTDRAW := 1`。 | 静态确认 |
| 1f | 对象键对形状的作用 | 起作用：`visible`（含父链、含绑属性）、`origin` / `angles` / `scale` / `parent`（经 `W`）、`parallaxDepth`（根对象，经场景视图）、`perspective`、`size`。不起作用：`alpha`、`color`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation`、`castshadow`、`disablepropagation`、`alignment`（形状的属性查找链里没有它）。形状不参加光标命中测试。 | 静态确认（`castshadow` / `disablepropagation` 在别处的语义未知） |
| 2a | `alignment` 映射 | 图像层类自己的属性表（`0x1404e85e0`），字节 `+0x4b1`：`center 0, top 1, topright 2, right 3, bottomright 4, bottom 5, bottomleft 6, left 7, topleft 8`。查不到或不是字符串（包括 `{user, value}`）都取 `center`。 | 静态确认 |
| 2b | 偏移公式 | `a = (+0x2f8, +0x2fc, +0x300)`，在建四边形（图像层虚表 +0xb0 `FUN_1402066a0`）时按对齐算：`w = trunc(size.x)`、`h = trunc(size.y)`，`a.x ∈ {0, ±w/2}`、`a.y ∈ {0, ±h/2}`、`a.z = 0`（表见 2.2）。世界矩阵虚函数 +0x80 `FUN_1401fd3f0` = `T(a) · W`：**在缩放、旋转之前**，本地空间平移。 | 静态确认 |
| 2c | 谁跟着偏 | 跟着偏：直接上屏与 final 上屏的模型矩阵、`g_LayerModelMatrix` / 效果矩阵（原料 `L`、`M0` 取自 +0x80）、组合层画子层用的 `inverse(W)`（裁剪窗口）、`perspective` 图层、光标命中测试。不偏：子层的世界矩阵（父链走不带偏移的 `FUN_1401850a0`）、视差平移（用根的 `origin`）、画进合成 RT 的基础 pass。 | 静态确认 |
| 2d | 脚本 `layer.alignment` | 图像层可读可写（WPE 自带声明 `IImageLayer.alignment: String`）：读回名字字符串；写入字符串，查不到写成 `center`；写入后回调虚表 +0x110 同步重建（重算偏移、四边形、合成 RT），下一次绘制就生效。语料里 10 张场景的脚本写它，全是图像层。文本、形状没有这个属性。 | 静态确认（「同帧生效」为推断） |
| 2e | rea-p4a 的冲突 | rea-p5-modelflags 对、rea-p4a 错。`alignment` 是对象级属性，走通用属性系统（`FUN_1401de470` → 虚表 +0x20 按名查表），不在模型 JSON 的解析段 `0x1401fa8e2–0x1401fb400` 里；`0x1402110be` 也不是文本类，而是图像层属性表的登记代码（图像层虚表 +0x20 `0x140212a00` 查的就是这张表 `0x1404e85e0`）。 | 静态确认 |
| 3a | 两位的来源与缺省 | 图层标志字 `+0x304`：bit14 `nointerpolation`、bit15 `clampuvs`。构造时 `+0x304 = 0x8040`，即 **`clampuvs` 缺省为真、`nointerpolation` 缺省为假**。只有对象 JSON（布尔或 `{user, value}`）和脚本能改；模型 JSON、`.tex` 标志都不写这两位。这两个属性没有改动回调，运行中改值要等下一次重建才影响 RT。 | 静态确认（运行中改值的时机为推断） |
| 3b | 各类采样器 | **合成 RT**（池化 `sc.*` 与独占 `_rt_imageLayerComposite_*_a` 同一套）：寻址只看对象 `clampuvs`（缺省钳制）；过滤 = 基础纹理 `.tex` NoInterpolation **或** 对象 `nointerpolation` 时点采样，否则线性，无各向异性。**基础纹理**：只看 `.tex` 标志（ClampUVs → 钳制否则重复；NoInterpolation → 点采样，否则各向异性 ×8），对象标志不影响。**effect fbo**：`uvs: "repeat"` 时重复否则钳制，一律线性。 | 静态确认（文件纹理用各向异性 ×8 为推断，与 p2-REPORT J 的抓帧一致） |
| 3c | 形状与文本 | 形状、文本的 +0x128 都把「基础纹理点采样」位置 0，规则退化为：点采样 ⇔ 对象 `nointerpolation`，钳制 ⇔ 对象 `clampuvs`（缺省真）。形状没有合成 RT，这两个键对它实际无效。 | 静态确认 |

**对 Kabegame 的直接含义**（推断，供步骤 1–3 的现状锚点参考）：
- 形状对象要按 `point0..3` 建四边形，不是 `正交高 × 正交高` 的正方形；sample-gaps §2.1 的「边长等于正交高度的正方形」只在找不到点时成立（语料 24 个形状都写了点）。
- 对齐复用 `layerLocalMatrix` 已有的 `offset`（P6b 文本用的同一个右乘 `T(offset)`），偏移按 `trunc(size)` 算；子层的世界矩阵不能带父层的偏移。
- 合成 RT 的寻址改成「对象 `clampuvs`，缺省钳制」，过滤改成「`.tex` NoInterpolation 或对象 `nointerpolation`」。计划「风险 1」写的「缺省 false = 重复」不对：缺省是钳制。按 `ignore\p8\out\texflags.json`，已能渲染的场景里只有 `3832772446` 的 1 个带 effect 图层（`.tex` 无 ClampUVs、对象没写 `clampuvs`）会从重复变成钳制；`nointerpolation` 的 3 个图层所在场景都还不能渲染。
- 顺带：WPE 图像层四边形的边长和对齐偏移都用 `trunc(size)`（`cvttss2si`），我们的 `layerQuad` 用浮点 `size`。只对 `size` 带小数、又不是 `autosize` 的图层有影响，语料没扫。

---

## 1. 形状对象

### 1.1 类与虚表（静态确认）

`FUN_14018ff60` 在 `0x14019075e`–`0x1401907de` 判 `shape`（只要是字符串，不比较取值），`new 0x460`，调基类构造 `FUN_1401e6980`，装虚表 `0x140491d10`，`+0x304 |= 0x2000`，`+0x450 = 1.0`，然后统一调虚表 +0x40（加载）。

和图像层逐槽对照（`vt_shape.txt` / `vt_image.txt`），与本节有关的槽：

| 槽 | 形状 | 图像层 | 形状这一槽做什么 |
|---|---|---|---|
| +0x20 | `0x140260820` | `0x140212a00` | 按名找属性描述符：先查形状类表 `0x1404e89e0`（只有静态初始化 `0x140004854`，**空表**），再查实例表 `+0x3d8`，最后尾跳 `FUN_1401ef570`（基类图层表 `0x1404e8360`）。所以形状认基类图层的全部键（`size`、`color`、`alpha`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation`、`perspective`……），**不认图像层表里的 `alignment`**。 |
| +0x40 | `0x14025fac0` | `0x1401fbae0` | 加载：`+0x2f0 = +0x2f4 = (float)ctx+0x88`（正交高），尾跳 `FUN_1401e6f50`（解析对象键与 `effects`）。 |
| +0x50 | `0x14025faf0` | `0x140206430` | 绘制，见 1.4。 |
| +0x60 | `0x14025fa30`（返回 10） | `0x140050790`（返回 1） | 类型号。 |
| +0x68 | `0x1401ea2d0` | 同 | 「该不该画」：`visible` 且父链都可见，或 `+0x304 & 0x1100`。 |
| +0x80 | `0x1401850a0` | `0x1401fd3f0` | 世界矩阵。形状用基类的，**没有对齐偏移**。 |
| +0xa8 | `0x1400a36d0` | 同 | 空函数（`xor al, al; ret`）。 |
| +0xb0 | `0x1401ea310` | `0x1402066a0` | 建 `+0x2e0`（2×2）/ `+0x2e8`（世界四边形）。形状用基类版本：只在合成计数 `+0x320 > 0`、或 `+0x304 & 0x10`、或「组合层且有子层」时才建；**不算对齐偏移**。 |
| +0xb8 | `0x1401ea500` | 同 | 分配合成 RT 与 effect fbo。 |
| +0xc8 | `0x14025ff50` | `0x14000ec30`（空） | effect pass 加载材质前改 pass JSON：`combos.DIRECTDRAW := 1`。 |
| +0x108 | `0x140260790` | `0x140209160` | final pass 上屏前改材质：`material+0x1f0 := 2`（additive）。不碰 `+0x1f2` / `+0x1f3`（深度类状态）。 |
| +0x110 | `0x140260190` | `0x1402065e0` | 重建：见 1.3。 |
| +0x120 | `0x1402607a0`（返回 2） | `0x1402091d0`（返回基础材质 `+0x1f0`） | 基础混合模式。 |
| +0x128 | `0x1402607b0` | `0x1402091e0` | 合成 RT 尺寸查询，见 1.2。 |

### 1.2 虚表 +0x128：`(1,1)` 与 `(W/2, H/2)`（静态确认）

`0x1402607b0`：
```asm
1402607b0: mov byte ptr [rdx], 0x0             ; out1：基础纹理点采样位 = 0
1402607b3: mov dword ptr [r8], 0x3f800000       ; out2：UV 缩放 = (1.0, 1.0)
1402607ba: mov dword ptr [r8 + 0x4], 0x3f800000
1402607c9: mov eax, dword ptr [r8 + 0x88]       ; r8 = ctx：正交高
1402607d0: cdq / sub eax, edx / sar eax          ; /2（向零取整）
1402607e0: mov dword ptr [r9 + 0x4], r10d       ; out3.y = 正交高 / 2
1402607e8: mov dword ptr [r9], eax              ; out3.x = 正交宽(ctx+0x84) / 2
140260810: mov dword ptr [rcx], eax             ; out4 = 同 out3（rcx = 第 5 个参数）
140260812: mov dword ptr [rcx + 0x4], r8d
```
对照图像层的同一槽 `FUN_1402091e0(layer, *pointFlag, *uvScale, *rtSize, *texSize)`（`dec\f_1402091e0.c`）：
- `out1`：基础纹理 `tex+0x1c & 1`（`.tex` NoInterpolation）；
- `out2`：`(图像宽/纹理宽, 图像高/纹理高)`；
- `out3`：合成 RT 尺寸；
- `out4`：纹理尺寸。

唯一的调用者是 `FUN_1401ea500`（`0x1401ea5b1`）。它用 `out3` 定合成 RT 尺寸（`max(4, ·)`），作为 effect fbo 的基准（再 `/scale`、`fit`、`width/height`），用 `out1` 参与点采样判定（第 3 节），用 `out2`、`out3`、`out4` 建基础 pass 四边形 `+0x2d8`。形状的 `+0x304` 带 bit13，`+0x2d8` 不建（`0x1401eb16e`）。

所以 `(1,1)` 是 UV 缩放，`(W/2, H/2)` 是「合成 RT / fbo 的基准尺寸」，W、H 是 `general.orthogonalprojection` 的宽和高。注意它和形状自己的 `size`（`H × H`）不一样。`lightshafts` 没有 `compose`、没有 `fbos`，合成计数为 0（形状带 bit13，每个 effect 不 +1），所以这组值在语料里实际不被使用。

### 1.3 几何：`+0x110` = `FUN_140260190`（静态确认）

加载（`0x14025fac0`）先写 `size`，再进 `FUN_1401e6f50`。后者解析对象键（`size` 的描述符在基类表，偏移 `0x2f0`，JSON setter `0x1401a3fc0`：字符串按空格拆成两个 float，数字铺满两维，`{user, value}` 取 `value`，`null` 不写），再加载 `effects`，最后尾调 `+0x110`。所以 JSON 写了 `size` 就覆盖 `(H, H)`；语料没有形状写 `size`。

`+0x110`（`dec\f_140260190.c`，汇编 `shape_rebuild_140260190.asm`）：
1. `vfunc+0xb0(this, 1.0, 1.0, (int)Sx, (int)Sy, (int)Sx, (int)Sy)` → `FUN_1401ea310`。合成计数为 0 时什么都不建。
2. `vfunc+0xb8` → `FUN_1401ea500`（合成 RT、fbo）。
3. `effects` 非空时，取**第一个** effect（`*[+0x308]`）的**第一个** pass 的材质 `m = pass[0]+8`：
   - 在 `m+0x1e0`（着色器程序）`+0x20` 的 `std::map`（键是 uniform 注解里的 `"material"` 名）里找 `"point0"`（`0x140491cec`），取 `m+0x120 + 4·idx` 的 vec2；
   - 再用 `FUN_14025f8a0(m, "point1"/"point2"/"point3", &out)`（同一张 map，找到就拷 8 字节，返回真）；
   - 四个都找到时，删掉旧 `+0x2e8`，建一个 4 顶点、6 索引的网格（格式 7：位置 xyz + uv）：

```c
// Sx, Sy = +0x2f0, +0x2f4（浮点，不取整）；p0..p3 = 材质常量 point0..point3
v[i].pos = (Sx*p[i].x - Sx/2,  Sy*(1 - p[i].y) - Sy/2,  0);
v[i].uv  = p[i];
index    = {0, 2, 1,  0, 3, 2};                       // local_150..148 = 0x20000, 0x1, 0x20003
+0x450   = sqrt(max(1, max_i |v[i].pos.xy|^2));       // 视锥剔除半径
```
   - 找不到（或没有 effect、第一个 pass 没材质）时跳 `0x14026072d`：`FUN_1401ede30(ctx, size=(Sx,Sy), (Sx,Sy), uvMax=(1,1), flags=1, &+0x2e8)`，即以原点为中心的 `Sx × Sy` 方块，左上 UV (0,0)、右下 (1,1)，`+0x450` 不更新（保持 1.0）。

点的含义：`p` 是 `Sx × Sy` 方块里的归一化坐标，x 向右、y 向下（`p = (0,0)` 是方块左上角，局部坐标 `(-Sx/2, +Sy/2)`）。`lightshafts.vert` 里 `v_TexCoordFx = (uv, 1) · inverse(squareToQuad(g_Point0..3))`，而 `g_Point*` 就是同一组材质常量，所以四个顶点正好落到单位正方形的四个角，光束铺满这个四边形。

材质常量取自 effect 实例：材质由 `FUN_1401e7170` 的 `0x1401e7b04` 调 `FUN_140150770` → `FUN_1401515b0` → `FUN_140154480` 创建，后者读同一个 pass JSON 的 `constantshadervalues`（`0x14015464e`）。【静态确认调用链；「`m+0x120` 就是实例写的值」为推断】

语料（`scan\shape_consts.txt`）：24 个形状全部在实例里写了 `point0..3`，取值远离 `0..1` 的也很多（例如 `3409595232` 的 `(-0.80924, -0.18247)`），所以没有一个是正方形。

**透视场景**：`ctx+0x84/+0x88` 只在 `general.orthogonalprojection` 的宽高是数字时写（`0x1401875eb`、`0x1401875fb`），`auto` 时取第一个类型 1 对象的 `size`（`0x14018b331`），否则保持上下文构造的初值 1（`0x14017c763`）。所以透视场景里形状的 `size` 推断为 `(1, 1)`，再乘 `scale`。【推断：语料 24 个形状都在正交场景】

**点绑用户属性**：材质常量变了不会触发 `+0x110`，四边形不跟着变（着色器里的 `g_Point*` 会变）。【推断：没找到常量改动时调图层 +0x110 的路径；语料的点都是写死的】

### 1.4 绘制：`+0x50` = `FUN_14025faf0`（静态确认）

```c
draw = vfunc_68(this);                                     // visible&&父链可见 || (+0x304 & 0x1100)
if (!((+0x120 & 1) && (!parent || FUN_140185010(parent))) && !draw) return;
W = vfunc_80(this);                                        // 形状：FUN_1401850a0，含父链，无对齐偏移
if ((ctx+0x11c & 2) && !(+0x304 & 0x1100))                 // 视锥剔除；正交场景在 0x140187610 清掉 bit1
    if (W·(+0x2f8,+0x2fc,+0x300) 在某个视锥平面外超过 +0x450) return;
push model / view / proj;                                  // 拷贝栈顶
vfunc_a8(this, model);                                     // 空函数
model = W ∘ model;                                         // FUN_14005ecb0
if (+0x120 & 0x80) FUN_1401e5b60(ctx);                     // perspective：换透视投影
e = effects.back();                                        // 0x14025fe92：mov rsi, [rsi+rax-8]
for (i = 0; i < e.passes.size(); i++) FUN_1401ebf60(this, e, i, -1, 1);
pop ×3;
```
- 形状函数里只读 `+0x120` 的 bit0（`0x14025fb02`）和 bit7（`0x14025fe4b`），不读 `+0x330..+0x340`（color / alpha / brightness）、`+0x32c`（colorBlendMode）、effect 的 `+0x118`（可见位）。
- 视图栈顶在进来之前已被场景绘制循环平移过视差（`0x14018b00c`–`0x14018b149`：找根对象，`Δ = (root.origin.xy − P)·amount·root.parallaxDepth`，平移视图，然后 `0x14018b170` 调 `+0x50`）。形状和图像层同等对待。
- 形状 `+0x120` 带 bit1（被组合层祖先代画）时，场景循环跳过它（`0x14018b15a`），由组合层的 `FUN_1401ecb20` 在它的合成 RT 里调 `+0x50`（`dec\f_1401ecb20.c` 第 149、155 行）。语料里有父对象的形状，父对象全是分组节点（`scan\shape_parents.py`）。

### 1.5 `FUN_1401ebf60(this, effect, pass, -1, 1)` 的参数与 uniform（静态确认）

参数 4 = `compIndex`（当前合成 RT 下标），参数 5 = `final`（`dec\f_1401ebf60.c`）：
- **`compIndex = -1`**：
  - pass 没有 `bind` 时不给槽 0 赋值（`compIndex ≥ 0` 时才写 `material+0xd0 = layer[0x59+compIndex]+0x20`）；
  - 有 `bind` 时只处理指向本 effect fbo 的条目（`*piVar27 ≥ 0`），`previous`（−1）跳过，那个槽保留材质自己的纹理。
- **`final = 1`**：
  - 下标等于 `effect+0x144`（最后一个绘制 pass）的那个 pass：`bVar20 = 1`，调 `vfunc+0x108(this, material)`（`0x1401ec23d`，形状：`material+0x1f0 := 2`），绑材质（`FUN_140155fc0`），`dev+0xd8(1, ctx+0x1c9 != 0)`，再处理 `ctx+0x1b0` 的状态栈，然后画 `[this+0x2e8]`（`0x1401ec667`，形状的四点四边形）。画完把 `+0x1f0/+0x1f2/+0x1f3` 恢复成原值（`0x1401ec68b` 起）。这一段和图像层的 final 上屏是同一段代码，写掩码的含义见 rea-p8-render。
  - 其余 pass：画 `[this+0x2e0]`（`0x1401ec6b2`），**不判空**。形状的合成计数为 0 时 `+0x2e0` 没建（`FUN_1401ea310`），所以多 pass 的 effect 挂在形状上会解引用空指针。【静态确认没有判空；「会崩溃」为推断，语料没有这种形状】
  - pass 有 `target` 时照常先压 fbo（在函数开头，与 final 无关），最后一个 pass 写了 `target` 就画进 fbo 而不上屏。
- **MVP**：上面的栈。`g_ModelViewProjectionMatrix` = `W × V × P`：`W` 含父链、不含对齐；`V` = 场景视图加视差平移（相机抖动、缩放在场景视图里）；`P` = 场景投影，`perspective` 时由 `FUN_1401e5b60` 换掉。`g_ModelMatrix` = `W`。
- **效果矩阵**（只在 pass 标志 bit0 时写，即着色器声明了 `g_Effect*` 或 `g_LayerModelMatrix`；`lightshafts` 没声明）：
  - final 公式：`0xa30 = 0x970 = this+0x384`，`0x9b0 = this+0x344`，`0x9f0 = this+0x344` 的前两行分别乘 `Sx/2`、`Sy/2`。
  - `this+0x344`、`this+0x384` 只在图像层的 `FUN_1401e8aa0` 里写（全文件写入点 `0x1401e95b5`–`0x1401e961a`），形状不调它；基类构造 `0x1401e6a9d`–`0x1401e6af3` 把两者初始化成单位阵。
  - 所以形状上：`g_LayerModelMatrix` = `g_EffectModelMatrix` = `g_EffectModelViewProjectionMatrix` = 单位阵，`g_EffectTextureProjectionMatrix` = `diag(Sx/2, Sy/2, 1, 1)`，Inverse = `diag(2/Sx, 2/Sy, 1, 1)`。
- **`g_Color4` / `g_Alpha` / `g_Color`**：形状路径不写 `ctx+0x120..+0x12c`（`FUN_1401ebf60` 里没有对它们的写入），值是上一次写它们的绘制留下的。对象的 `alpha` / `color` / `brightness` 没有作用。
- **`g_TextureNResolution`**：按槽里实际的纹理取 `(纹理宽, 纹理高, 图像宽, 图像高)`，空槽 `(2,2,2,2)`（p2-REPORT I4）。形状的槽 0 没人赋值，`lightshafts` 槽 0 无缺省纹理，所以若声明了 `g_Texture0Resolution` 应为 `(2,2,2,2)`。

### 1.6 没有纹理的槽（静态确认 + 推断）

- 着色器绑定 `FUN_1400d7440` 只遍历着色器自己的槽表（`shader+0x14`，`0xff` 结尾），对每个槽取 `ctx+0x58[slot]`，**为空就跳过**，不绑任何 SRV / 采样器。设备上那个槽保持上一次绑的东西。【静态确认】
- 材质绑定尾部 `0x1401572a0` 对同一张槽表逐槽调 `material+0xd0[slot]->vfunc+0x20`，**不判空**。所以出现在槽表里的槽必须有纹理。【静态确认】
- `DIRECTDRAW = 1` 时 `lightshafts.frag` 只在 `#else` 里采样 `g_Texture0`；`MASK = 0` 时 `g_Texture3` 只在 `#if MASK` 里用。编译后这两个槽不在槽表里，什么都不绑。【推断：槽表由编译反射得到，没逐行读】
- 实际被绑的槽：1（`util/noise`），`RENDERING = 1` 时还有 2（`gradient/*` 或实例给的纹理），都按各自 `.tex` 的采样器（第 3 节）。

### 1.7 effect 的改写（静态确认）

- `+0xc8`（`0x14025ff50`）：在 `FUN_1401e7170` 的 `0x1401e7ad2` 调，即**每个** effect 的**每个**带 `material` 的 pass，在建材质（`0x1401e7b04`）之前，把这个 pass JSON 的 `combos` 补成对象（没有就新建）并写 `DIRECTDRAW = 1`。
- `+0x108`（`0x140260790`）：只在 final 的最后一个绘制 pass 写 `blending := 2`，即 additive（p2 B7 的枚举：normal 0、translucent 1、additive 2、alphatocoverage 3；rea-p5-modelflags：additive = `SRC_ALPHA / ONE`，颜色与 alpha 相同）。深度测试、深度写入保持材质原值（`lightshafts`：都关）。剔除取材质（`nocull`）。
- 合成计数：加载时（`0x1401e8946`）每个可见 effect 加 `(~+0x304 >> 13 & 1) + compose 数`，形状带 bit13，只加 compose 数，`lightshafts` 为 0。p2 I5 记的运行时重算（`FUN_1401e6300`）没有 bit13 的条件：第一次切换某个 effect 的可见性后计数会变成 1，触发 `+0x110`，建出 `+0x2e0` 并分配一张用不到的合成 RT。绘制不变。【前半静态确认；「谁调 `FUN_1401e6300`」沿用 p2 的推断】

### 1.8 选哪个 effect（静态确认）

- 加载时每个 effect 都进 `+0x308` 列表（`0x1401e897b`–`0x1401e89a3`），不看可见位；可见位只决定是否计入合成计数（`0x1401e893d`）。
- 形状绘制取列表最后一个（`0x14025fe92`），整个形状路径不读 effect 的 `+0x118`。
- 所以：
  - 多个 effect：只画最后一个，前面的永远不画；
  - 最后一个 `visible: false`：照画；
  - 全部不可见：照画最后一个。
- 几何取第一个 effect 的点（1.3）。两者不是同一个 effect 时，四边形和着色器里的 `g_Point*` 对不上。

### 1.9 对象键逐项

| 键 | 对形状 | 依据 | 置信度 |
|---|---|---|---|
| `visible`（含绑属性） | 每次绘制读 `+0x120` bit0 和父链（`FUN_140185010`） | `0x14025fb02` | 静态确认（绑定刷新沿用图像层的机制，推断） |
| `origin` / `angles` / `scale` | 经 `W`（`FUN_1401850a0`：`S·R·T(origin)`，再乘父的 `W`） | `0x14025fb3e` | 静态确认 |
| `parent` | `W` 含父链；可见性要父链都可见；组合层祖先代画 | 同上、`0x14018b15a` | 静态确认 |
| `parallaxDepth` | 作为根对象时经场景视图平移；子对象用根的 | `0x14018b047`–`0x14018b149` | 静态确认 |
| `perspective` | `FUN_1401e5b60` 换透视 | `0x14025fe4b` | 静态确认（语料 0 个） |
| `size` | 覆盖 `(正交高, 正交高)` | 1.3 | 静态确认（语料 0 个） |
| `alpha` / `color` / `brightness` | 无作用 | 形状路径不读 `+0x330..+0x340`，不写 `ctx+0x120..` | 静态确认 |
| `colorBlendMode` | 不影响绘制（只可能多分配一张合成 RT） | `+0x108` 不看 `+0x32c` | 静态确认（语料 0 个） |
| `clampuvs` / `nointerpolation` | 无作用（没有合成 RT；fbo 只看 `uvs`） | 第 3 节 | 静态确认 |
| `castshadow` / `disablepropagation` | 形状绘制与重建都不读 | 形状函数里对 `+0x120` 只读 bit0、bit7 | 静态确认；它们在别处的语义未知 |
| `alignment` | 不认（属性查找链里没有） | 1.1 的 +0x20 | 静态确认 |
| 光标事件 | 不参加：命中测试只处理类型 1、4、5（`0x14018a041`–`0x14018a067`），形状类型 10 | — | 静态确认 |

---

## 2. 对齐 `alignment`

### 2.1 描述符与映射（静态确认）

图像层属性表 `0x1404e85e0`（图像层虚表 +0x20 `0x140212a00` 查的就是它）。`alignment` 的登记在 `0x1402110be`–`0x14021119d`：
```asm
14021113a: lea rdx, [0x140488490]            ; "alignment"
140211157: mov dword ptr [rbx + 0x34], 0x4b1  ; 偏移
14021116c: mov dword ptr [rbx + 0x30], 0x5    ; 类型 5（枚举）
140211150: lea rax, [0x140212690] → [rbx+0x38] ; JSON setter
140211165: lea rax, [0x140212820] → [rbx+0x40] ; （未查）
14021117c: lea rax, [0x140212530] → [rbx+0x48] ; 脚本写
14021118b: lea rax, [0x140212610] → [rbx+0x50] ; 脚本读
140211196: lea rax, [0x1401fa290] → [rbx+0x58] ; 改动回调：jmp [vtbl+0x110]
```
枚举表在 `0x1404e97f0`（每项 0x28 字节：`std::string` + 1 字节值），首尾指针 `0x1404e97d8` / `0x1404e97e0`，由 `0x140212262`–`0x140212519` 一次性构造：

| 字符串 | 值 | 写值的指令 |
|---|---|---|
| `center` | 0 | `0x1402123c9`（`dil` = 0） |
| `top` | 1 | `0x1402123ed` |
| `topright` | 2 | `0x140212411` |
| `right` | 3 | `0x140212435` |
| `bottomright` | 4 | `0x140212459` |
| `bottom` | 5 | `0x14021247d` |
| `bottomleft` | 6 | `0x1402124a1` |
| `left` | 7 | `0x1402124c5` |
| `topleft` | 8 | `0x140212512` |

- JSON setter `0x140212690`：值是字符串（类型 4）时取字符串，否则当空串；逐项比较，**查不到取第一项 `center`**（`0x140212779`）。所以 `{user, value}` 形式也落到 `center`（这个 setter 没有绑定分支）。写完调回调（`0x1402127b3`）。
- 脚本写 `0x140212530`：同样的查表（查不到取 `center`），写 `+0x4b1`，调回调（`0x1402125e5`）。
- 脚本读 `0x140212610`：按 `+0x4b1` 的值找名字，把名字交给回调（即返回字符串）。
- 图像层构造 `FUN_1401fac50` 在 `0x1401faccc` 把 `+0x4b0/+0x4b1` 清 0，缺省 `center`。
- 场景级的 `alignment*` 伪属性（渲染器 `+0x124`，p3-script-REPORT L3）是另一回事，只决定清屏色用不用 `schemecolor`。

### 2.2 偏移公式（静态确认）

偏移在图像层的建四边形函数（虚表 +0xb0 `FUN_1402066a0`，`0x1402069e5`–`0x140206ab2`，跳转表 `0x140206ab4`）末尾计算：
```c
// param_6, param_7 = (int) size.x, (int) size.y（调用方用 cvttss2si 截断）
+0x2f8 = +0x2fc = +0x300 = 0;
switch (+0x4b1) {           // 结果：a = (+0x2f8, +0x2fc, 0)
  case 1 top:         a = ( 0,    -h/2);
  case 2 topright:    a = (-w/2,  -h/2);
  case 3 right:       a = (-w/2,   0  );
  case 4 bottomright: a = (-w/2,  +h/2);
  case 5 bottom:      a = ( 0,    +h/2);
  case 6 bottomleft:  a = (+w/2,  +h/2);
  case 7 left:        a = (+w/2,   0  );
  case 8 topleft:     a = (+w/2,  -h/2);
}                            // (float)int × 0.5（常量 0x1404926c0 = 0.5）
```
- `w`、`h` 的来源：
  - 有基础纹理时 `FUN_140209360` 传 `(int)size`：`fullscreen` 时 size 先改成 `(2, 2)`；`autosize` 时先改成纹理图像尺寸、精灵帧尺寸或正交尺寸。
  - 没有纹理时 `FUN_1402065e0` 直接传 `(int)size`。
- 同一对整数也是上屏四边形 `+0x490`、世界四边形 `+0x2e8` 的边长。WPE 图像层的四边形和偏移都用截断后的整数 `size`。
- 方向：场景坐标 y 向上，`topleft` 把四边形往右、往下推半个尺寸，物体原点就落在图像的左上角；其余同理。

世界矩阵（图像层虚表 +0x80 `FUN_1401fd3f0`，`image_world_1401fd3f0.asm`）：
```c
if (+0x4b1 == 0) return FUN_1401850a0(this);   // 0x1401fd3f6
M = FUN_1401850a0(this);  copy → this+0x450;
row3(M) += a.x*row0(M) + a.y*row1(M) + a.z*row2(M);   // 0x1401fd422–0x1401fd4fb
return this+0x450;
```
即行向量约定下 `W_al = T(a) · W`，顶点先加 `a` 再缩放、旋转、平移、乘父链。换成我们的列向量写法：`W_al = W_parent · T(origin)·Rz·Ry·Rx·S(scale) · T(a)`，和 `layerLocalMatrix` 的 `offset` 位置相同。偏移是缩放前的本地单位，所以 `scale` 会放大偏移，旋转会带着偏移转。`+0x300` 恒为 0。

### 2.3 哪些路径跟着偏

| 路径 | 用哪个矩阵 | 结果 | 依据 |
|---|---|---|---|
| 直接上屏 / final 上屏 | `FUN_1401e8aa0` 开头 `vfunc+0x80`（`0x1401e8b53`）一次取 `W_al`，基础与 final 都用它 | 偏 | 静态确认 |
| `g_LayerModelMatrix`、`g_EffectModelMatrix`、`g_EffectModelViewProjectionMatrix`、`g_EffectTextureProjectionMatrix` | 原料 `L = W_al`、`M0 = W_al × V × P`（effect-matrices-REPORT S2） | 偏（平移行 = origin + a 经 R·S） | 静态确认 |
| 画进合成 RT 的基础 pass、非 final 的 effect pass | 单位模型 + 铺满 RT 的正交 | 不偏 | 静态确认 |
| 组合层（passthrough）的基础 pass（`copybackground`） | `FUN_140207b50` 的 `vfunc+0x80`（`0x140207da7`、`0x1402082d2`） | 偏 | 静态确认 |
| 组合层画子层 | 视图 = `inverse(vfunc+0x80)`（`dec\f_1401ecb20.c` 第 88–89 行），子层自己的 `W` 不带父偏移 | 子层留在原来的世界位置，组合层的裁剪窗口跟着偏 | 静态确认 |
| 子层的世界矩阵 | `FUN_1401850a0` 递归调父的 `FUN_1401850a0`（非虚函数，不经 +0x80） | **不带父层的对齐偏移** | 静态确认 |
| 视差 | 场景循环用根的 `origin`（`+0x128`）和 `parallaxDepth` 平移视图 | 不受对齐影响 | 静态确认 |
| `perspective` 图层 | `FUN_1401e5b60` 只换视图平移与投影，模型仍是 `W_al` | 偏 | 静态确认 |
| 光标命中测试 | `FUN_14019dbb0` 用 `vfunc+0x80`（`0x14019dc85`）和 `size`，再加对象自己的视差偏移 | 命中区域跟着偏 | 静态确认 |
| 视锥剔除 | 图像层剔除在 `FUN_1401e8aa0` 里，没细看 | — | 未知（只影响透视场景） |

文本层的 +0x80 `0x140256e10` 结构相同（基类矩阵后加 `+0x2f8..` 的平移，存 `+0x554`），只是偏移由 `anchor` 排版算（rea-p6b-layout）；文本没有 `alignment` 键。形状的 +0x80 是基类的，没有偏移。

### 2.4 脚本 `layer.alignment`

- **能读写**：对图像层，脚本按名找属性时经图像层虚表 +0x20 查到这张表。
  - 读：`0x140212610`，返回名字。
  - 写：`0x140212530`，字符串，查不到写成 `center`。
  - WPE 自带声明 `ui\dist\monaco\autocomplete\lib.sceneScript.d.ts` 第 1790 行：`IImageLayer.alignment: String`。
  - 【静态确认】
- **生效时机**：写入后回调 `0x1401fa290` → `vfunc+0x110` = `FUN_1402065e0`。加载标志 `+0x328` 为 0 时立刻：
  - `FUN_140209360` → `+0xb0`：重算 `a`、四边形；
  - `+0xb8`：重新分配合成 RT；
  - `+0xc0`：passthrough 材质。

  `W_al` 每次调用 +0x80 现算，没有缓存问题。所以写完之后的下一次绘制就生效；脚本的 `update` 在同一帧的绘制之前（P4c），推断同帧生效。【链路静态确认，同帧为推断】
- **语料**（`scan\script_alignment.txt`）：10 张场景写 `.alignment`，都在图像层上，大多是 `createLayer` 出来的音频条或图标。其中 4 张先读后比较（`if (bar.alignment !== barAlignment)`），和「读回名字字符串」一致：3304642534、3570308528、3799462430、3812473896。全部 10 张：3304642534、3549863808、3570308528、3577990983、3643916956、3660962877、3799462430、3812473896、3812487163、3818053626。
- 文本、形状上没有这个描述符，脚本读写不到。读回什么由脚本 dll 决定，【未知】。

### 2.5 裁决：rea-p4a 第 78 行错在哪（静态确认）

- rea-p4a 在图像**模型 JSON** 的解析段（`FUN_1401fac50`，`0x1401fa8e2`–`0x1401fb400`）里找 `alignment`，没找到就下了「图像层没有读」的结论。但 `alignment` 是**对象 JSON** 的键，和 `size`、`clampuvs` 一样走通用属性系统：`FUN_1401e6f50` → `FUN_1401de470` → `FUN_1401730d0` 按 JSON 键调对象虚表 +0x20 找描述符（`0x140173152`）。它本来就不在模型解析段里。
- rea-p4a 把 `0x1402110be` 认成文本类。实际上它是图像层属性表 `0x1404e85e0` 的登记代码。证据：图像层虚表 +0x20 `0x140212a00` 在 `0x140212a53`–`0x140212a6c` 读的正是 `0x1404e85e0` 这张表的桶与哨兵；rea-p6b-layout 也确认文本的查找链上没有 `alignment`。
- rea-p5-modelflags 第 26、49 行（`W` = +0x80 `FUN_1401fd3f0`，`alignment` 不为 0 时加 `+0x2f8..+0x300`；`+0x4b1` 由 `0x140211157` 登记）是对的。本节补上偏移本身的公式（2.2）。

---

## 3. `clampuvs` / `nointerpolation`

### 3.1 两位的来源（静态确认）

- 图层标志 `+0x304`：bit14 = `nointerpolation`（`0x4000`），bit15 = `clampuvs`（`0x8000`）。
- 缺省：基类构造 `0x1401e69e8` 写 `+0x304 = 0x8040`，即 `clampuvs = 1`、`nointerpolation = 0`、`copybackground = 1`。
- 描述符在基类图层表 `0x1404e8360`（`FUN_1401ee520`）：
  - `nointerpolation`：`0x1401eec40`–`0x1401eec89`，JSON setter `0x14019bb40`，脚本写 `0x14019bd10`，读 `0x14019bd50`；
  - `clampuvs`：`0x1401eed0d`–`0x1401eed5a`，JSON setter `0x14019bd70`，脚本写 `0x14019bf40`，读 `0x14019bf80`。
  - 两个的改动回调槽 `[rbx+0x58]` 都写 `rdi`，`rdi` 在 `0x1401ee859` 清 0 之后没再改过，所以**没有回调**。
- JSON setter（`flag_setters_14019bb40.asm`）：
  - 布尔（类型 5）按真假置 / 清位；
  - `{user, value}`（类型 7）取 `value`，并登记绑定（`FUN_1401a4db0`）；
  - `null`（没写这个键）不动，保持构造的缺省值。
- 全文件对 bit14 / bit15 的置清（`bts` / `btr … 0xe/0xf`）只出现在这几个 setter 里（`0x14019bb75`–`0x14019bf54`），其余命中都不是对 `+0x304`。对 `+0x304` 的整体写入只有构造函数一处（`0x1401e69e8`）。**模型 JSON、`.tex` 标志都不写这两位**：模型解析 `FUN_1401fac50` 只 `or` 了 `0x2/0x4/0x8/0x20/0x200/0x400/0x800`；`.tex` 标志只在用的时候参与判定（3.2）。
- 运行中改值（脚本写、绑定的属性变化）只改位，不触发合成 RT 重建；要等下一次 `+0x110` / `+0xb8`（纹理重载、`size` 或 `alignment` 改变、effect 可见性计数变化）才用上。【推断：没找到别的重建入口】

### 3.2 各类采样器（静态确认）

采样器一律由 `FUN_140099980(dev, flags, linearOnly)` 建（`sampler_140099980.asm`）：
```c
if (flags & 1)              Filter = MIN_MAG_MIP_POINT (0);
else if (linearOnly)        Filter = MIN_MAG_MIP_LINEAR (0x15);
else                        Filter = ANISOTROPIC (0x55), MaxAnisotropy = 8;   // 0x140099ac1
Address = (flags & 0x4000000) ? BORDER : (flags & 2) ? CLAMP : WRAP;    // U、V、W 相同，0x140099b7f–0x140099b95
MipLODBias 0, MinLOD 0, MaxLOD FLT_MAX;  bit27 时改成比较采样器（与本题无关）
```
标志的位定义和 `.tex` 头一致：1 = NoInterpolation，2 = ClampUVs。

**合成 RT**（`FUN_1401ea500`，`composite_flags_1401ea500.asm`）：
```asm
1401ea5b1: call [vtbl + 0x128]                 ; out1 → [rbp+0x98]：基础纹理 tex+0x1c & 1（图像层）/ 0（形状、文本）
1401ea5b7: mov r8d, [rbx + 0x304]
1401ea5c1: shr eax, 0xe / test al, 1            ; nointerpolation
1401ea5c8: mov r9b, 1 → [rbp+0x98]              ; 点采样 = out1 | bit14
1401ea636: setne r10b                          ; r10 = 点采样
1401ea704: shr r8d, 0xf / and r8b, 1            ; clampuvs
1401ea713: add eax, eax / or r10d, eax
1401ea71b: mov [rbp-0x30], r10d                 ; flags = 点采样 | clampuvs<<1
```
- 池化 RT：名字 `sc.<W>.<H>.<n|b><c|r><i>`（`n`/`b` 取点采样，`c`/`r` 取 bit15，`i` 是本图层第几张）。`0x1401eb0cc` 把 `[rbp-0x30]` 作为第 8 个参数交给 `FUN_1401ab570` → `FUN_1401aadb0` → 设备 +0x70（`0x14009ada0`）→ RT 构造 `FUN_1400d2c60` 的 `param_9` → 纹理对象 `FUN_1400eb440`：`tex+0x1c = flags`（`0x1400eb4b3`），采样器 = `FUN_140099980(dev, flags, 1)`（`0x1400eb4d7`–`0x1400eb4e0`）。
- 独占的 `_rt_imageLayerComposite_<id>_a`（passthrough 且第 0 张）：设备 +0x70 直接拿同一个 `local_b8`。
- 结论：**Filter** = 点采样 ⇔ 基础纹理 `.tex` NoInterpolation **或** 对象 `nointerpolation`，否则 `MIN_MAG_MIP_LINEAR`、无各向异性；**Address** = 对象 `clampuvs`（缺省真）? CLAMP : WRAP，和 `.tex` 的 ClampUVs 无关。

**基础纹理**（文件 `.tex`，`FUN_1400ec7b0`）：
```asm
1400ed00f: movzx r8d, byte ptr [r15 + 0x10]
1400ed014: mov edx, dword ptr [r15 + 0x1c]     ; .tex 标志
1400ed018: shr r8b / and r8b, 1                 ; linearOnly = tex+0x10 bit1
1400ed023: call 0x140099980
```
- 寻址：`.tex` ClampUVs ? CLAMP : WRAP。
- 过滤：NoInterpolation ? POINT : 线性或各向异性。
- 纹理对象 `+0x10` 的 bit1 只在 RT 构造（`0x1400eb4d2`，`or 3`）和设备 +0x58 建的动态纹理（`0x14009ab47`）里置，`.tex` 加载路径只置 bit2（视频，`0x1400ed582`）、基类构造清 0（`0x14015ebb8`）。所以文件纹理推断走各向异性 ×8。这和 p2-REPORT J1 抓到的「静态纹理一律 Anisotropic 8x、合成 RT Linear 无各向异性」一致。
- 对象的 `clampuvs` / `nointerpolation` 不参与。纹理按缓存在图层之间共享，采样器是纹理的属性。

**effect fbo**（`FUN_1401ea500` 后半，`0x1401eba0b`）：`flags = (fbo.flags & 4) ? 0 : 2`。bit2 是 `uvs == "repeat"`（p2 B6）。fbo 的采样器是 `uvs: "repeat"` ? WRAP : CLAMP，一律 `MIN_MAG_MIP_LINEAR`，对象的 `nointerpolation` 管不到。非 `unique` 的 fbo 按 `<name>_<W>_<H>_<scale>` 跨图层共享，名字里没有 `uvs`，同名时先建的那张决定采样器（我们的 fbo 池键里有 `repeat`，差在这一点）。

### 3.3 形状与文本（静态确认）

- 形状 +0x128（`0x1402607b0`）、文本 +0x128（`0x140258ab0`）都写 `*out1 = 0`，所以合成 RT：点采样 ⇔ 对象 `nointerpolation`，钳制 ⇔ 对象 `clampuvs`（缺省真），和图像层用同一个 `FUN_1401ea500`。
- 形状的合成计数为 0，不分配合成 RT；effect fbo 只看 `uvs`；它画的纹理槽都是各自 `.tex` 的采样器。所以 `clampuvs`（语料 1 个形状写了 true）、`nointerpolation` 对形状实际无效。
- 文本同一规则，只在走合成路径时有意义（和 rea-p6b-layout 5.5 的推断一致，现在可以定为静态确认）。

---

## 未知 / 没查清的点

1. 形状上多 pass effect 的非末 pass 会解引用空的 `+0x2e0`：静态确认没有判空，是否真的崩溃（或编辑器根本不让这样做）没验证。
2. 透视场景里形状的 `size` 推断为 `(1,1)`（`ctx+0x88` 的构造初值），没有核对别的写入路径能否在透视场景改它；`orthogonalprojection: auto` 时形状加载与 `0x14018b2e9` 赋值的先后没查。
3. 形状实例属性表 `+0x3d8`（属性查找的第二站）存的是什么，没查。
4. `+0x304 & 0x1100` 让形状和图像层跳过可见性与剔除。`0x100` 是 `ledsource`（J1 推断）；`0x1000` 在场景加载 `0x1401881b8` 对某个集合里的类型 1 / 4 对象置位（同时置 `0x10`，并调 `+0x110`），集合的来源没追，推断与 `dependencies` 有关，交给 rea-p8-render。
5. `castshadow`、`disablepropagation` 在形状以外的语义：形状路径不读，全文件没搜到直接的 `test` 指令（可能经访问器），未知。
6. 槽表（`shader+0x14`）由编译反射生成、`DIRECTDRAW` 下槽 0 不在表里：推断，没读着色器创建代码。
7. 对齐描述符的 `+0x40` 槽（`0x140212820`）的用途没查（不影响本节结论）。
8. 图像层视锥剔除（透视场景）是否也把 `+0x2f8` 当中心、和 `W_al` 叠加算两次：没细看。
9. final pass 的 `dev+0xd8(1, ctx+0x1c9)` 与 `ctx+0x1b0` 状态栈的确切含义（写掩码）：交给 rea-p8-render。
10. 点常量、`clampuvs` 绑用户属性后运行中变化不重建：推断。

## 实测要核对的预测

约定：
- 场景坐标 y 向上，原点在左下。窗口和正交投影同尺寸时，像素坐标 `px = x`、`py = 正交高 − y`。
- 「四角」指该次绘制 `vs_out` 换算回屏幕的位置。
- RenderDoc 的采样器在 Pipeline State → PS → Samplers 里看。

**形状（`p8-shape`，正交 1920×1080，窗口 1920×1080，照编辑器打包 `lightshafts`）**
1. **几何不是正方形**：形状 `origin = (960, 540)`，不写 `size`、`scale`、`angles`，实例常量 `point0..3 = (0.75,0.25) (0.75,0.75) (0.25,0.75) (0.25,0.25)`。
   - 该次绘制：4 个顶点、6 个索引 `0,2,1,0,3,2`；
   - 输入位置 `(270,270,0) (270,−270,0) (−270,−270,0) (−270,270,0)`，texcoord 等于四个点；
   - 屏幕四角 `(1230,270) (1230,810) (690,810) (690,270)`，即 540×540 的方块，不是 1080×1080。
2. **任意四边形**：把点改成语料 `3819646765` 的 `(-0.41370,0.48503) (-0.08742,-0.80541) (1.46483,-0.20986) (1.39570,1.23912)`，输入位置 = `(1080·p.x − 540, 1080·(1 − p.y) − 540)`。
3. **`size` 覆盖**：同 1，再写 `size: "400 200"`，位置变成 `(400·p.x − 200, 200·(1 − p.y) − 100)`，即 `(100,50) (100,−50) (−100,−50) (−100,50)`。
4. **没有点时退回方块**：effect 换成一个着色器里没有 `point0` 注解的 effect（`DIRECTDRAW` 兼容、单 pass），输入位置 `(±540, ±540)`，UV 左上 (0,0)、右下 (1,1)。
5. **混合与状态**：
   - 混合 `SrcBlend = SRC_ALPHA, DestBlend = ONE`（颜色与 alpha 相同），尽管材质写 `normal`；
   - 深度测试、深度写入关，剔除 None；
   - 着色器带 `DIRECTDRAW=1`（即使实例 `combos` 里删掉它）。
6. **effect 的选择**：
   - 两个 `lightshafts`，点不同：只出现一次绘制，常量是第二个（最后一个）的，几何是第一个的点；
   - 最后一个 effect `visible: false`：照样有这次绘制；
   - 对象 `visible: false`：没有这次绘制。
7. **MVP**：
   - `g_ModelViewProjectionMatrix` = `W × V × P`：`W` = `S·R·T(origin)` × 父链；
   - 开 `cameraparallax` 时 `V` 带视差平移（四角随指针移动，同一位置的图像层移动量相同）；
   - `perspective: true` 时投影换透视。
8. **不起作用的键**：`alpha 0.2`、`color "1 0 0"`、`brightness 3`、`clampuvs`、`nointerpolation`、`colorBlendMode 5` 分别打开，像素逐位不变；资源列表里没有这个对象的 `sc.*` 合成 RT（`colorBlendMode` 那组可能多一张但不被采样）。
9. **效果矩阵**：自写一个 `DIRECTDRAW` 兼容、顶点着色器读 `g_LayerModelMatrix`、`g_EffectModelMatrix`、`g_EffectModelViewProjectionMatrix`、`g_EffectTextureProjectionMatrix(Inverse)`、`g_Texture0Resolution` 的单 pass effect 挂到形状上（`size` 缺省，H = 1080）。常量缓冲里应为：
   - 前三个单位阵；
   - `g_EffectTextureProjectionMatrix` 第 0 行 `(540,0,0,0)`、第 1 行 `(0,540,0,0)`，其余单位；
   - Inverse 对应 `1/540`；
   - `g_Texture0Resolution = (2,2,2,2)`；
   - `g_Color4` 等于上一次绘制留下的值，和形状的 `color` / `alpha` 无关。
10. 不建议测「两个 pass 的 effect 挂在形状上」：按静态分析会解引用空指针，可能让 WPE 崩溃。要测就单独开窗、最后测。

**对齐（`p8-align`，正交 1920×1080，图像层 `size` 为整数 `w × h`，`origin (ox, oy)`）**
11. **9 种取值，无旋转、`scale (sx, sy)`**：
    - 四角 `x ∈ [ox + sx·(ax − w/2), ox + sx·(ax + w/2)]`，`y ∈ [oy + sy·(ay − h/2), oy + sy·(ay + h/2)]`；
    - `(ax, ay)` 见 2.2 的表；
    - 例：`topleft` 时 `x ∈ [ox, ox + sx·w]`、`y ∈ [oy − sy·h, oy]`，原点是图像左上角；`bottom` 时 `y ∈ [oy, oy + sy·h]`。
12. **旋转与非均匀缩放**：四角 = `origin + Rz(θ)·(sx·(cx + ax), sy·(cy + ay))`，`(cx, cy) ∈ {±w/2} × {±h/2}`。偏移跟着缩放和旋转。
13. **非整数 `size`**：例如 `size "101.6 50.8"`、`topleft`、`scale 1`。四边形宽 101、高 50（截断），偏移 `(50.5, −25)`，四角 `x ∈ [ox, ox + 101]`、`y ∈ [oy − 50, oy]`。这条同时验证 `center` 时边长也是 101 × 50。
14. **子层**：父层 `topleft`，子层 `origin (0,0)`、不写对齐。子层四角和父层改成 `center` 时完全相同（不带父偏移）。
15. **带 effect**：
    - 末 pass 上屏四角与 11 相同；
    - 第一个 pass（画进合成 RT 或 fbo）铺满 RT、不受对齐影响；
    - 着色器读 `g_LayerModelMatrix` 时平移行 = `(ox + sx·ax, oy + sy·ay, 0, 1)`（无旋转时）。
16. **视差**：开 `cameraparallax`，同一图层 `center` 与 `topleft` 两次抓帧，视差引起的平移量相同（只差对齐偏移本身）。
17. **`perspective: true` 的图层**：模型矩阵同样带偏移，四角是偏移后的四边形再经透视。
18. **脚本**：
    - `update` 里在第 N 帧 `thisLayer.alignment = "topleft"`，第 N 帧的绘制就是偏移后的位置；
    - 读回 `"topleft"`；
    - 写 `"foo"` 后读回 `"center"`、位置回到居中；
    - JSON 写 `alignment: {"user": "...", "value": "top"}` 时按 `center` 画。
19. **命中测试**：`cursorClick` 只在偏移后的矩形里触发（脚本打印即可，不必抓帧）。

**采样（`p8-clamp`）**
20. **合成 RT**（effect 的第一个 pass 采样 `g_Texture0` = 基础 pass 的合成 RT）：
    - 对象不写 `clampuvs`、`.tex` 不带 ClampUVs：AddressU/V/W = CLAMP（我们现在是 WRAP）；
    - 对象 `clampuvs: false`：WRAP；
    - `.tex` 带 NoInterpolation，或对象 `nointerpolation: true`：Filter = `MIN_MAG_MIP_POINT`；否则 `MIN_MAG_MIP_LINEAR`、MaxAnisotropy 1。
21. **基础纹理**（基础 pass 采样 `.tex`）：
    - 对象的 `clampuvs` / `nointerpolation` 改了也不变；
    - Address 只跟 `.tex` ClampUVs；
    - Filter：`.tex` NoInterpolation 时 POINT，否则 `ANISOTROPIC`、MaxAnisotropy 8。
22. **effect fbo**：不写 `uvs` 时 CLAMP，`uvs: "repeat"` 时 WRAP；Filter 一律 LINEAR，对象 `nointerpolation: true` 也不变。
23. **运行中改**：`clampuvs` 绑用户属性，`apply_properties` 改成 false，合成 RT 的采样器不变；推断要重新加载或触发重建（例如脚本改一次 `alignment`）才变成 WRAP。
24. **语料对照**：`3832772446` 那个带 effect、基础 `.tex` 无 ClampUVs 的图层，WPE 的合成 RT 采样器是 CLAMP。
