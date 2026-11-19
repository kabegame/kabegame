> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。范围是 exe 侧文本对象的 MSDF 路径：链入的 msdfgen 版本、WPE 在 msdfgen 外围做的事（轮廓、包围盒、投影、转字节、装箱）、MSDF 图集与采样、装饰常量、合成路径、彩色字形的 MSDF。材质选择、字体加载、回退链、普通栅格化、排版见 [rea-p6b-raster.md](rea-p6b-raster.md) 与 [rea-p6b-layout.md](rea-p6b-layout.md)，本文只在补充或更正时重复。

# WPE 2.8.42 文本 MSDF 路径静态逆向（msdfgen 版本、外围流程、图集、装饰常量）

**概括**
1. **msdfgen 版本：核心代码等价于 tag `v1.13`**【确，有界】。可用范围是提交 `e36d714`（2025-09-18）到 `1c106ed` 之前（2026-08-29），这一段里本流程用到的 `core/` 代码逐行相同（`b25851c` 只改了 `rasterization.cpp`，本流程不调；`e36d714..v1.13` 的 `MSDFErrorCorrection.cpp` 只删了一个没用的函数）。决定性证据：
   - 下界：`Shape::normalize` 的反收敛用 `convergentCurveOrdering`（`FUN_14028a4c0`，`54535fc` 引入，v1.12.1 及以前是内联的叉积和）；`CubicSegment::signedDistance`（`FUN_140287720`）是 `e3ced1e` 的 `improvedT` / `remainingSteps` 结构（`t = 0.25·i`、首次改进不在 (0, 1) 就不算距离）；`QuadraticSegment::signedDistance`（`FUN_140286990`）的 `epDir = direction(1)` 在 `if` 里（`1583315` 起）；`generateMSDF` 的输出是带 `rowStride` 与 `yOrientation` 的 `BitmapSection`（`e36d714` 起，调用点栈上 `{pixels, w, h, 3w, 0}`）。
   - 上界：`edgeColoringSimple`（`FUN_140283500`）里的 `symmetricalTrichotomy` 是旧式 `int(3 + 2.875·p/(n−1) − 1.4375 + .5) − 3`（常量 2.875 / 1.4375 在 `0x1404927c0` / `0x140492798`），`1c106ed`（v1.13.1 的一部分）改成了 `(3p+1)/n − 1`。
   - 旁证：PE 时间戳 `0x6a42830c` = 2026-06-29 UTC，落在区间里。
   - **建议编 `v1.13` tag。** v1.13.1 与它在本流程上只差 trichotomy，两式只在「恰有一个角的轮廓、边数 ≥ 47」时不同（`tri2.py`：n < 47 全等），字体里几乎不出现，但要逐字节一致就用 v1.13。
2. **外围流程**（`FUN_1401ae080`，`0x1401aef9f`–`0x1401af6a9`）【确】：
   1. `FT_Load_Glyph(face, gid, FT_LOAD_NO_BITMAP)`（标志 8，**带 hinting**），按**第一次遇到这个字形的那个对象字号**的 face（300 DPI）取轮廓；格式不是 `'outl'` 的不走 MSDF。
   2. `FT_Get_Glyph` → `FT_Glyph_Get_CBox(…, FT_GLYPH_BBOX_PIXELS)` 得整数像素包围盒 `(x0, y0, x1, y1)`。
   3. 轮廓经 `FT_Outline_Decompose` 进 `Shape`：回调、上下文、`shift = delta = 0`、缩放 1/64、去掉末尾空轮廓，与 msdfgen-ext v1.13 的 `readFreetypeOutline` 逐条等价（只是 WPE 直接调，没经 `loadGlyph`）。
   4. `Shape::normalize()`（内联，与 v1.13 逐条相同：单边轮廓三等分、反收敛常量 `−0.0015713495811804866`）。
   5. **`Shape::orientContours()`**（`FUN_140281900`）——msdfgen 缺省流程不调，这是 WPE 自己加的。
   6. `edgeColoringSimple(shape, 3.0, seed = 0)`。
   7. 格子：`inner = max(1, trunc(f32(bbox) · f32(32 / f32(y_ppem))))`（`y_ppem < 2` 当 1），格子 = `inner + 24`；`s = f32(max(innerW, innerH)) / max(f32(bw), f32(bh))`；`tx = f32(12/s) − f32(x0)`，`ty = f32(12/s) − f32(y0)`；`r = f32(24/s)`。全部 float32，再转 double 交给 msdfgen。
   8. `generateMSDF(BitmapSection<float,3>(w, h), shape, SDFTransformation(Projection((s, s), (tx, ty)), Range(r)), MSDFGeneratorConfig(true, ErrorCorrectionConfig()))`：`overlapSupport = true`，纠错全缺省（EDGE_PRIORITY、CHECK_DISTANCE_AT_EDGE、1.111… / 1.111…、无缓冲），**只纠一次**（`FUN_140283d60` 是内联后的距离场生成、`FUN_14028a910` 是 generateMSDF 尾部那一次纠错，WPE 没有另调）。
   9. 转字节：`b = clamp(cvttss2si(f32(v) · 256.0f), 0, 255)`（截断、不是四舍五入），alpha 写 255，上下翻转（msdfgen 第 `h−1−r` 行 → 图集第 `r` 行），RGB 顺序不变，写进 RGBA8 图集的格子，行距 = 图集宽 × 4。
3. **和 msdfgen 上游缺省用法不同的地方**（我们复现时必须照做）：
   - 轮廓是 **hinted、按 300 DPI 缩放到像素**的（上游 `loadGlyph` 用 `FT_LOAD_NO_SCALE` 取字体单位）；
   - 多调了一次 `orientContours()`；
   - 投影的缩放、平移、范围都先在 **float32** 里算出，再转 double；
   - 每个字形一张小图、四周固定 12 个 MSDF 像素余量，缩放按 `max(inner)/max(bbox)` 两轴共用；
   - 转字节用 `×256` 截断并钳到 255。
4. **图集**【确】：初始 512×512，RGBA8（DXGI 28，`R8G8B8A8_UNORM`，非 sRGB），**1 级 mip**，`D3D11_USAGE_DYNAMIC` + CPU 写；采样器线性（`MIN_MAG_MIP_LINEAR`）、**WRAP** 寻址、各向异性 1。装箱、清边、回收、翻倍（UV × 0.5、宽 > 4095 放弃）与 R8 图集同一段代码，MSDF 只是格子换成 `inner + 24`、每像素 4 字节。`g_Texture0Resolution` = `(W, H, W, H)`（图集尺寸）。MSDF 字体对象按字体路径共享（键 `<路径>_msdf`，不含字号），图集里字形键 `face 下标 << 24 | glyph id`。
5. **几何与常量**【确】：四边形外扩 `pad = f32(y_ppem) · 12 · 0.03125`（这里的 `y_ppem` 是**当前对象字号**的 face，不是生成字形时的那个）。`s' = f32(32 / M+0xa8) · 0.24f`（`M+0xa8` 是钳到 [1, 256] 的字号，`0.24f` = 0.23999999463558197）；`RV0 = (24, min(5.1f, thick·s'), min(blur·s', 6), min(shadow·s', 6))`，之后 `if (RV0.z + RV0.y > 5.1f) RV0.y = max(5.1f − RV0.z, 0)`；`RV1.w = min(off.x·s', 6)`、`RV2.w = min(off.y·s', 6)`；`RV3.x = opacity`。参数每次绘制前从对象拷，属性 / 脚本写入当帧生效【推：依赖帧序】。
6. **合成路径**（`FUN_140257d70`）【确】：与直接上屏同一个绘制函数、同一组 MSDF 变体与装饰常量，只是平移不同、不画背景四边形。合成 RT = `trunc(文字框 + 2·padding)`，**文字框不含 MSDF 的 `pad`**，所以 `padding` 小于 `pad` 时边缘字形的描边 / 投影会被 RT 裁掉【推：由尺寸算式推出】。
7. **彩色字形的 MSDF**（`FUN_1401ab9c0`）【确：概要】：不是 msdfgen。位图 alpha ≥ 128 二值化 → 两次精确欧氏距离变换（内、外，`INF = 1e20`）→ 有符号距离 `±(√d² − 0.5)`（源位图像素）→ 按与 MSDF 相同的投影在目标格子里**双线性**采样，越界部分加上到边界的欧氏距离 → `v = (d / r) + 0.5`，**四个通道写同一个值**。颜色另按 `k` 倍分辨率双线性重采样进颜色缓冲（`FUN_1401ac4e0`，`+0.5` 后截断）。可以复现，但细节（距离变换的实现、取整）没逐条核对，列入「未查清」。

**元数据**
- 目标：`wallpaper64.exe` 2.8.42，副本 `ignore/p6/rea/msdf/exe/wallpaper64.exe`（拷自 `ignore/p9/rea/wallpaper64.exe`），开工核对 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，一致。PE 时间戳 `1782743820`（`0x6a42830c`，2026-06-29 14:37 UTC）。没运行、没附加 WPE，没写 Steam / WPE 目录。
- msdfgen 上游：`ignore/p6/f0/msdfgen-src`（只用 `git show` / `git diff` / `git log` 读，没改工作区）。
- 方法：REA 6.9.0 / Ghidra 12.1.4。开工时 `binary_session` 显示没有打开的目标，直接不带快照打开副本；`decompile_all` 导出 msdfgen 段与彩色 MSDF 段，`batch_decompile` / `procedure_pseudo_code` 补单个函数；指令级细节（float / double、寄存器参数、常量地址）切 `ignore/p4/rea/wp.asm` 逐条核对。结束时另存快照 `ignore/p6/rea/msdf/exe/wallpaper64-2.8.42-p6f-msdf.rea-snapshot`（6 条 Evidence）并 `close_binary`。
- 工作文件 `ignore/p6/rea/msdf/`：
  - `dec-msdf/functions/`：`0x14027f000`–`0x14028af00` 的 69 个函数（msdfgen 全部核心：`Shape` / `Contour` / 边段 / 选择器 / 合并器 / 纠错 / 着色 / 求根）；
  - `dec-color/functions/`：`0x1401ab9c0`（彩色距离场）、`0x1401ac130`、`0x1401ac3b0`（一维距离变换）、`0x1401ac4e0`（颜色重采样）；
  - `f_1401ae080.c` / `f_1401b0410.c`：拷自上一轮；
  - `asm/`：`msdf_seg_1401aee00.asm`（轮廓 → normalize → orient → 着色 → 生成 → 转字节，`wp.asm` 第 453700–454420 行）、`edgecoloring_140283500.asm`、`inner_1401ae400.asm`（格子尺寸）、`b3b60_msdf_vars.asm`（拷自上一轮）；
  - `py/`：`pe.py`（读副本）、`k.py`（常量与 PE 时间戳）、`s.py`（字符串）、`vt.py`（虚表）、`tri.py` / `tri2.py`（新旧 trichotomy 对比）。
- 标记：【确】伪代码 / 汇编直接看到；【推】由代码推出或依赖上游行为；【确，有界】在注明范围内搜过。

**命名**（沿用 rea-p6b-raster）
- `O` 文本对象，`P` / `M` 参数块 / 网格，`T` 字体对象，`A` 图集，`G` 图集字形。
- `F` = `FT_Face`（`FUN_1401ae080` 的 `param_6`），`F+0x78` = `glyph` 槽，`F+0x80` = `size`，`size+0x1a` = `metrics.y_ppem`；槽 `+0x60` = `format`，`+0x98` = `outline`。
- msdfgen 函数：

| 地址 | 上游 | 依据 |
|---|---|---|
| `FUN_140282920` / `…b90` / `…db0` / `FUN_1402830a0` | `ftMoveTo` / `ftLineTo` / `ftConicTo` / `ftCubicTo` | 回调表，`EdgeHolder` 构造、颜色 7、`crossProduct` 判退化 |
| `FUN_140281730` | `deconvergeEdge(holder, param, vector)` | 调用点 |
| `FUN_14028a4c0` | `convergentCurveOrdering(const EdgeSegment*, const EdgeSegment*)` | 取控制点、`simplifyDegenerateCurve`（`FUN_140289d00`）、`FUN_140289df0` |
| `FUN_140281900` | `Shape::orientContours` | 黄金分割 0.381966… / 0.618034…、`scanlineIntersections`、交点排序与翻转 |
| `FUN_140283500` | `edgeColoringSimple` | `sin(3.0)`、`CYAN = 6`、trichotomy 常量 |
| `FUN_140283d60` | `generateDistanceField<OverlappingContourCombiner<MultiDistanceSelector>>` | `reorient`、蛇形扫描、`DistancePixelConversion` |
| `FUN_14028a910` | `msdfErrorCorrection(BitmapSection<float,3>, shape, SDFTransformation, MSDFGeneratorConfig)` | mode 2 / 3、distanceCheckMode 0 / 1 / 2、`overlapSupport` 分派 |
| `FUN_140286990` / `FUN_140287720` | `QuadraticSegment` / `CubicSegment::signedDistance` | 内联 `solveCubic`、搜索结构 |
| `FUN_140285390` | `solveQuadratic` | `1e12` 判退化 |
| `FUN_14028a670` | `Contour::winding` | 1/3、2/3、1/2 采样 |

---

## 1. msdfgen 版本

### 1.1 逐项对照【确】

| 检查点 | WPE | 上游各版本 | 结论 |
|---|---|---|---|
| `Shape::normalize` 反收敛 | 有，`factor = −0.0015713495811804866`，方向由 `FUN_14028a4c0(prev, edge) < 0` 决定 | v1.8–v1.11：`deconverge(param, MSDFGEN_DECONVERGENCE_FACTOR)`，无方向；v1.12–v1.12.1：`factor` 同值、方向用内联叉积；`54535fc` 起改调 `convergentCurveOrdering` | ≥ `54535fc` |
| `Shape::normalize` 空轮廓 | `else if (begin != end)` | v1.13 加了 `else if (!contour->edges.empty())` | 与 v1.13 一致（编译器对旧写法也可能生成同样的判断，不作证据） |
| `CubicSegment::signedDistance` | `t = 0.25·i`；先算一次 `improvedT`，在 (0, 1) 里才进循环，`remainingSteps = 4`，循环后算一次距离 | `1583315` / `9e7901a` 是 `for (step < 4)` 每步算距离；`e3ced1e` 起是 `improvedT` 结构 | ≥ `e3ced1e` |
| `QuadraticSegment::signedDistance` | `epDir = direction(1)` 在 `distance < fabs(minDistance)` 之后才取 | `1583315` 起 | ≥ `1583315` |
| `generateMSDF` 输出 | `{pixels, width, height, rowStride = 3w, yOrientation = 0}`，函数开头按 `shape.inverseYAxis` 调 `reorient`（`FUN_140283d60` 开头的翻转） | `e36d714` 起 `BitmapSection`；以前是 `BitmapRef {pixels, w, h}` | ≥ `e36d714` |
| `symmetricalTrichotomy` | `int(3 + 2.875·p/(n−1) − 1.4375 + .5) − 3` | `1c106ed` 改成 `(3p+1)/n − 1` | < `1c106ed` |
| `solveCubic` / `solveQuadratic` | `fabs(b/a) < 1e6`、`1e12` 判退化、`r² < q³` 走三角、`1e-12` 判重根 | `0b633e7`（2021）以后没改 | 无区分力 |

- `e36d714..v1.13` 的 `core/` 差异：`MSDFErrorCorrection.cpp` 删了没用的 `isArtifact`，`contour-combiners.cpp` / `edge-selectors.cpp` 只改参数名与注释，`rasterization.*`（`b25851c`）本流程不调。`v1.13..1c106ed~1` 的 `core/` 只有 `BitmapRef.hpp` 重构。所以整段区间在本流程上**数值等价**【确，有界：按 `git diff --stat` 与逐个 diff 看过】。
- `edge-coloring.cpp` 在 v1.12.1..v1.13 没变，`orientContours` 在 v1.12.1..v1.13.1 没变。
- 结论：**编 `v1.13` tag**。若必须用 v1.13.1，把 `symmetricalTrichotomy` 换回旧式即可。

### 1.2 宏与配置【确】
- `MSDFGEN_CUBIC_SEARCH_STARTS = 4`、`MSDFGEN_CUBIC_SEARCH_STEPS = 4`（`t = 0.25·i`、`i ≤ 4`、步数 4）。
- 没有 OpenMP：`FUN_140283d60` 单线程蛇形扫描（每行反转 `xDirection`）。
- `edgeColoringSimple` 的种子：调用点只设了 `rcx` 与 `xmm1 = 3.0`；被调方开头 `xor r12d, r12d`，种子在 `r12` 里恒为 0，`initColor` 被折成 `esi = 6`（CYAN）。也就是 `edgeColoringSimple(shape, 3.0)` 用缺省种子 0【确】。
- `MSDFGeneratorConfig` 在栈上 `[rbp+0x60]`：`overlapSupport = 1`、`mode = 2`（EDGE_PRIORITY）、`distanceCheckMode = 1`（CHECK_DISTANCE_AT_EDGE）、`minDeviationRatio = minImproveRatio = 0x3ff1c71c71c71c72`（1.1111111111111112）、`buffer = NULL`。与 `MSDFGeneratorConfig(true)` 完全相同。
- 纠错在 `FUN_14028a910` 里：`buffer == NULL` 时自己分配 `w·h` 字节的模板；mode 2 → `protectCorners` + `protectEdges`；distanceCheckMode 1 → `findErrors` 带形状（`overlapSupport` 为真选 `OverlappingContourCombiner`）；最后 `apply`。与 v1.13 `msdfErrorCorrectionInner` 一致【确：结构；没逐行比对 `MSDFErrorCorrection` 内部】。

---

## 2. 外围流程（`FUN_1401ae080`）

### 2.1 查缓存与加载【确】
```c
key = faceIdx << 24 | gid;                 // faceIdx = 字形所在 face 在「当前字号的 face 列表」里的下标
G = T->mainAtlas.glyphs[key] 或彩色图集里找;  // 命中且没被回收 → 直接用，不重生成
if (!T->msdf)                     FT_Load_Glyph(F, gid, FT_LOAD_RENDER | FT_LOAD_COLOR);   // 0x100004
else if (!(F->face_flags & FT_FACE_FLAG_COLOR)) {
    FT_Load_Glyph(F, gid, FT_LOAD_NO_BITMAP);                // 8：带 hinting，按 F 当前的 char size 缩放
    isMsdf = (F->glyph->format == 'outl');
} else {
    FT_Load_Glyph(F, gid, FT_LOAD_RENDER | FT_LOAD_COLOR);
    isMsdf = (F->glyph->bitmap.pixel_mode == FT_PIXEL_MODE_BGRA);   // 彩色 MSDF（第 6 节）
}
FT_Get_Glyph(F->glyph, &g);
FT_Glyph_Get_CBox(g, FT_GLYPH_BBOX_PIXELS /*3*/, &bb);        // (x0, y0, x1, y1)，整数像素
if (T->msdf && !(F->face_flags & COLOR)) faceList->bboxCache[key] = bb;   // 排版 FUN_1401addb0 读这张表
```
- **hinting**：`FT_LOAD_NO_BITMAP` 不带 `FT_LOAD_NO_HINTING`，轮廓是按 face 当前尺寸（`FT_Set_Char_Size(0, int(size·64), 300, 300)`）hinted 后的 26.6 坐标【确：标志；推：hinting 行为是 FreeType 缺省】。msdfgen 自带的 `loadGlyph` 用 `FT_LOAD_NO_SCALE`，WPE 不是。
- **按哪个字号生成**：MSDF 的 `T` 键是 `<路径>_msdf`，没有字号；字形第一次被某个对象排到时，用那个对象字号的 face 生成，之后所有字号复用这一张【确】。所以图集内容取决于场景里**先建网格的那个文本对象**的字号。
- **缓存键的隐患**【推】：`faceIdx` 是「当前字号的 face 列表」里的下标，回退字体按需追加、每个字号的列表各自追加。两个字号的列表回退顺序不同时（比如 16 号先遇到汉字、64 号先遇到 emoji），同一个 `faceIdx` 可能指向不同的字体文件，第二个字号会拿到另一个字体的同号字形。主字体（下标 0）不受影响。
- `y_ppem`：`F->size->metrics.y_ppem`，FreeType 由 `(int(size·64)·300/72 + 32) >> 6` 得出（TrueType 头标志 bit3 时还会把 `y_scale` 取整）【推：上游】。`pointsize 32` → 133。

### 2.2 轮廓转 Shape【确】
```c
Shape shape;                         // contours 空，inverseYAxis = false（Y 向上）
FtContext ctx = { scale = 1/64.0 /*0x3f90000000000000*/, position = (0, 0), shape = &shape, contour = NULL };
FT_Outline_Funcs f = { ftMoveTo, ftLineTo, ftConicTo, ftCubicTo, shift = 0, delta = 0 };
FT_Outline_Decompose(&F->glyph->outline, &f, &ctx);
if (!shape.contours.empty() && shape.contours.back().edges.empty()) shape.contours.pop_back();
```
- 四个回调与 v1.13 `ext/import-font.cpp` 逐条等价：
  - `moveTo`：当前轮廓为空就复用，否则新开轮廓；`position = to · scale`。
  - `lineTo`：终点 ≠ `position` 才加 `LinearSegment`（颜色 WHITE = 7）。
  - `conicTo`：终点 ≠ `position` 才加二次段（`EdgeHolder` 三点构造，控制点共线时退化成线段，v1.11 起的 `EdgeSegment::create`）。
  - `cubicTo`：终点 ≠ `position` 或 `crossProduct(c1 − end, c2 − end) ≠ 0` 才加三次段（同样可能退化）。
  - 坐标 `double(int(v)) · (1/64)`：`FT_Pos` 在 Windows 上是 32 位，转 double 再乘。
- 缩放 1/64 在回调里做（`ftPoint2`），shape 的单位就是 300 DPI 下的 face 像素，原点是字形原点（笔位置），Y 向上。

### 2.3 normalize、定向、着色【确】
- 紧接着内联的循环就是 v1.13 `Shape::normalize()`：
  - 单边轮廓（`edges.size() == 1`）：虚函数 `+0x70`（`splitInThirds`）切三段，清空后压回三段；
  - 其它非空轮廓：`prev = back()`，对每条边比较 `normalize(prev->direction(1))` 与 `normalize(edge->direction(0))`，点积 `< −0.999999`（`MSDFGEN_CORNER_DOT_EPSILON − 1`）时 `axis = factor · normalize(cur − prev)`，`factor = 1.11111111111111111 · sqrt(1 − (1e-6 − 1)²) / (1e-6 − 1) = −0.0015713495811804866`（编译期常量），`convergentCurveOrdering(prev, edge) < 0` 时取反，再 `deconvergeEdge(prev, 1, axis.getOrthogonal(true))`、`deconvergeEdge(edge, 0, axis.getOrthogonal(false))`。
  - 「只有一条边的轮廓」与常量 `−0.0015713…` 就是这段，**不是 WPE 自己的处理**，上一轮未查清的这一项由此结清。
- 空轮廓：Decompose 之后只去掉**末尾**一个空轮廓（同上游）；`normalize`、`orientContours`、`edgeColoringSimple` 都跳过空轮廓。
- 然后 `FUN_140281900` = `Shape::orientContours()`：按非零绕数规则给每条轮廓定向（在 `y = 0.381966·y0 + 0.618034·y1` 处扫描），反向的轮廓整条 `reverse()`。**msdfgen 的 `main.cpp` 只在 `-guessorder` 时调它，库的缺省流程不调。** WPE 在 `normalize` 之后、着色之前调。
- `edgeColoringSimple(shape, 3.0)`，种子 0（1.2）。
- 没调 `Shape::validate`、`Shape::bound` / `getBounds`、`resolveShapeGeometry`（skia）、`inverseYAxis` 相关的接口【确，有界：调用点之间只有这几个 call】。

### 2.4 格子、投影、范围【确：`inner_1401ae400.asm`、`msdf_seg_1401aee00.asm` `0x1401af41f`–`0x1401af58f`】
```c
bw = x1 - x0;  bh = y1 - y0;                              // int
innerW = innerH = 0;
if (isMsdf && bw > 0 && bh > 0) {
    ppem = max(F->size->metrics.y_ppem, 1);                // < 2 当 1
    k = 32.0f / (float)ppem;                               // divss
    innerW = max(1, (int)((float)bw * k));                 // cvttss2si，截断
    innerH = max(1, (int)((float)bh * k));
}
cellW = innerW + 24;  cellH = innerH + 24;                 // 非 MSDF：cell = bw × bh
// 装箱见第 3 节；bw 或 bh 为 0 时格子 24×24、不生成（2.6）
s  = (float)max(innerW, innerH) / max((float)bh, (float)bw);   // maxss，float
tx = 12.0f / s - (float)x0;                                // float
ty = 12.0f / s - (float)y0;
r  = 24.0f / s;                                            // float
SDFTransformation T = {
    scale     = ((double)s, (double)s),
    translate = ((double)tx, (double)ty),
    mapping   = { scale = 1.0 / ((double)r·0.5 − (double)r·(−0.5)),   // = 1/r
                  translate = −((double)r·(−0.5)) },                   // = r/2
};
```
- 投影是 msdfgen 的 `Projection`：像素中心 `(x + .5, y + .5)` 反投影成 `p / s − t`，即 shape 坐标 `x0 + (x + 0.5 − 12)/s`。字形包围盒落在格子 `[12, 12 + bw·s]`，主轴正好铺满 `inner`（浮点舍入内），次轴 `≤ inner`。
- `Range(r)` 是对称的 `(−r/2, r/2)`，距离映射 `v = (d + r/2) / r`，边界 0.5。`r` 是 MSDF 像素里的 24。
- 包围盒来源是 **FreeType 的 `FT_Glyph_Get_CBox(PIXELS)`**（`floor(xMin)`、`ceil(xMax)` 再 `>> 6`，对 hinted 轮廓），不是 `Shape::bound`。

### 2.5 生成与纠错【确】
- `BitmapSection<float, 3>{ pixels = new float[cellW·cellH·3], width = cellW, height = cellH, rowStride = 3·cellW, yOrientation = Y_UPWARD }`。
- `FUN_140283d60`：`reorient(shape.getYAxisOrientation())`（两者都 Y_UPWARD，不翻）→ `OverlappingContourCombiner<MultiDistanceSelector>` 逐像素蛇形扫描 → `pixel[c] = float(mapping(distance.c))`。
- `FUN_14028a910(BitmapSection 副本, shape, T, config)`：就是 `generateMSDF` 尾部那次纠错（`generateMSDF` 被内联拆开；没有第二次）。

### 2.6 转字节、翻转、写图集【确：`0x1401af5d5`–`0x1401af6a9`】
```c
dst = A->pixels + ((G->y0 · A->W) + G->x0) · 4;            // 格子左上角
for (r = 0; r < cellH; ++r, dst += A->W · 4)
  for (c = 0; c < cellW; ++c) {
    const float *m = msdf + ((cellH − 1 − r) · cellW + c) · 3;     // 上下翻转
    for (k = 0; k < 3; ++k) {
      int v = cvttss2si(m[k] · 256.0f);                    // float 乘、截断
      dst[c·4 + k] = v >= 255 ? 255 : (v < 0 ? 0 : v);     // NaN → 0x80000000 → 0
    }
    dst[c·4 + 3] = 255;
  }
A->dirty = 1;
```
- 通道：msdfgen 的 R、G、B 原样进图集的 R、G、B；alpha 恒 255。
- `bw` 或 `bh` 为 0（空格等）时 `0 < innerW && 0 < innerH` 不成立，不生成、不写：格子 24×24 里是图集原有内容（新图集是 0，回收来的格子是旧字形的残留）【确：跳过；推：残留的后果】。这类字形的四边形是否画、画了会不会露出残留，取决于排版是否给它出四边形（`rea-p6b-raster` 第 5 节：每个输出字形一个四边形，宽高为 0 时四边形只剩 `2·pad` 的方块）。

---

## 3. MSDF 图集与采样

### 3.1 纹理【确：`FUN_1401ac7f0` → 设备虚表 `0x140485b90` 槽 `+0x58` = `FUN_14009aab0`】
- `FUN_1401ac7f0`：格式 `(!彩色 && !msdf) ? 9 : 0`，尺寸 `A+0 / A+4`，数据 `A+0x10`，标志 `0x20000008`。彩色 MSDF 另建 `__font_atlas_color_`（格式 0，`k·W × k·H`）。
- `FUN_14009aab0`（建运行时纹理，对象 0x170 字节、虚表 `0x140487088`，与 `.tex` 纹理同一个类）：
  - 格式表 `FUN_1400d2a20`：0 → DXGI 28（`R8G8B8A8_UNORM`），9 → DXGI 61（`R8_UNORM`）；
  - `D3D11_TEXTURE2D_DESC`：`MipLevels = 1`、`ArraySize = 1`、`SampleDesc = (1, 0)`、`BindFlags = SHADER_RESOURCE`；标志里有 `0x30000000` 任一位时 `Usage = DYNAMIC`，bit29（`0x20000000`）再加 `CPUAccessFlags = WRITE`。所以 **`0x20000000` = 可 CPU 写的动态纹理**，图集**没有 mip**。
  - 纹理对象 `+0x1c` = 标志、`+0x20 / +0x24` = 宽高、`+0x2c / +0x30` = 宽高。按 rea-p6e 第 1 节的取值表，`g_Texture<n>Resolution` = `(texW, texH, imgW, imgH)` = **`(W, H, W, H)`**，即图集当前尺寸【确：写入；读法引 rea-p6e】。
- 采样器 `FUN_140099980(dev, 0x20000008, 1)`：
  - bit0（`nointerpolation`）没置、bit27 没置 → `Filter = 0x15`（`MIN_MAG_MIP_LINEAR`），只有 1 级 mip，等于双线性；
  - bit26 没置 → `AddressU/V/W = (flags & 2) | 1 = 1`（**WRAP**）；
  - `MaxAnisotropy = 1`、`ComparisonFunc = 8`、`MinLOD = 0`、`MaxLOD = FLT_MAX`、`MipLODBias = 0`。
  - 上一轮「线性、wrap、无 mip」三条推断由此转成【确】。

### 3.2 装箱、回收、翻倍【确：与 R8 图集同一段代码】
- 格子 = `inner + 24`（2.4），之后的装箱与 rea-p6b-raster 3.2 完全相同：按行从上往下、从左往右，格子之间、行之间各留 1 像素；放下后清零格子上下各一行、左右各一列（x 或 y 为 0 时清最后一列 / 最后一行，按 wrap 处理）；先回收引用数为 0、没回收过、格子够大的旧字形；放不下就宽高翻倍，旧字形 UV × 0.5，宽 > 4095 放弃（这个字形不画）。MSDF 的清零写的是 4 字节 0（RGBA 全 0，即距离 0 = 远在外面、alpha 0）【确：清零按每像素字节数】。
- UV：`u0 = f32(x0)/f32(W)`、`v0 = f32(y0)/f32(H)`、`u1 = f32(x0 + cellW)/f32(W)`、`v1 = f32(y0 + cellH)/f32(H)`，覆盖整个格子（含 24 像素余量）。
- 上传：脏位置位后，下一次绘制整张重新上传（同 R8）。
- 彩色 MSDF：按 `k = max(1, ceil(max(w, h)/32))`（位图尺寸）分图集，每个 `k` 一张 512 起步的 RGBA8 距离场图集加一张 `k` 倍的颜色缓冲（`FUN_1401adf30`，rea-p6b-raster 3.2）。

---

## 4. 几何与常量

### 4.1 四边形外扩【确：`f_1401b0410.c` 第 958–963 行】
```c
pad = 0;
if (T->msdf) {
    ppem = max(faceOfThisObject->size->metrics.y_ppem, 1);
    pad  = (float)ppem * 12.0f * 0.03125f;    // 整数 ppem 下精确 = ppem·12/32
}
```
- `faceOfThisObject` 是本对象字号的 face 列表里该字形所在的 face，**不是**生成字形时的 face。四边形 = 本字号的像素包围盒（`FUN_1401addb0`，按 face 列表缓存）各边外扩 `pad`，UV 取整个格子。
- 推论【推】：同一字形被不同字号用时，几何按本字号、纹理按首个字号，格子里「12 像素余量 : 包围盒」的比例按首个字号算，所以别的字号会有亚像素级的拉伸；装饰常量 `s'` 按本字号（4.2），和生成时的 `s` 不完全一致。逐字节复现只需照做。
- 文字框（`M+0x90..0x9c`）由每个字形记录的 `+0x1c..+0x28` 包围盒累计，**不含 `pad`**【确：`f_1401b0410.c` 第 1734–1756 行】。

### 4.2 `g_RenderVar0..3`（`FUN_1401b3b60`，逐条按 `b3b60_msdf_vars.asm`）【确】
```c
// 变体位
v = 0;
if (M->thick >= 1.0f)                                   { OUTLINE_ENABLED = 1;     v = 1; }
if (M->blur  >  0.0f)                                   { BLUR_ENABLED = 1;        v = outline ? 3 : 2; }
if (M->shadow > 0.0f || off.x·off.x + off.y·off.y > 1.1920929e-7f)   // 先 x² 再 y²，y² + x²
                                                        { DROP_SHADOW_ENABLED = 1; v |= 4; }
// 常量（全 float32，顺序如下）
s' = (32.0f / M->size /*+0xa8，钳到 [1,256]*/) * 0.24f;       // 0.24f = 0x3e75c28f
RV0.x = 24.0f;                                            // 0x41c00000
RV0.y = s' * M->thick;   RV0.z = s' * M->blur;   RV0.w = s' * M->shadow;
RV1.w = s' * off.x;      RV2.w = s' * off.y;
RV1.xyz = M->outlineColor;  RV2.xyz = M->shadowColor;
RV0.y = minss(5.1f, RV0.y);                               // 5.1f = 0x40a33334
RV0.z = RV0.z > 6 ? 6 : RV0.z;  RV0.w = RV0.w > 6 ? 6 : RV0.w;
RV1.w = RV1.w > 6 ? 6 : RV1.w;  RV2.w = RV2.w > 6 ? 6 : RV2.w;
if (RV0.z + RV0.y > 5.1f) { t = 5.1f − RV0.z; RV0.y = t > 0 ? t : 0; }
RV3.x = M->shadowOpacity;                                 // RV3.yzw 不写，保留 ctx 里的旧值
```
- `minss(5.1f, x)` 对 NaN 返回 x（第二操作数）；`> 6` 比较对 NaN 为假也保留 NaN。负偏移不钳。
- 写在 `ctx+0xa8..+0xd8`（`RV0` = `+0xa8`、`RV1` = `+0xb8`、`RV2` = `+0xc8`、`RV3` = `+0xd8`）。`RV3.yzw` 保留上一个写过它的绘制留下的值【推：ctx 全局量】，`basefont_msdf` 着色器如果读了它们就会受前一个绘制影响，要看着色器（没查）。
- 变体号 `v` 选 `R[0x17 + v]` / `R[0x1f + v]` 缓存的材质（rea-p6b-raster 第 1 节）。

### 4.3 参数何时生效【确：拷贝时机；推：帧序】
- `FUN_140258b80` 在每次绘制（`FUN_140257d70` 合成、`FUN_140258050` 直接上屏）开头把 `O` 的 `outline*` / `blur*` / `dropshadow*` 拷进 `M+0x1c..0x48`，只在 `O+0x518 != 0` 时拷。属性回调与脚本 `update` 在渲染之前（rea-p6e 概括第 8 条的帧序），所以**当帧生效**。
- 切换：`FUN_140256f20` 的比较里只有「`O+0x518` 是否为 0」。四个开关之间切换，只要还剩至少一个开着，就不重建网格、只换变体（变体按 `M` 里的参数现算）；全关 → 重建成非 MSDF；从全关打开任一个 → 重建成 MSDF。只开 `msdf` 时变体 0。

---

## 5. 合成路径（`FUN_140257d70`，虚表 +0xe8）【确】
```c
push(matrix);
pad2 = (有 effect || colorBlendMode 合成 || opaquebackground) ? min(O->padding, 512) : 0;
dx = pad2.x − (M->minX < 0 ? M->minX : 0);
dy = pad2.y − M->minY;                    // 注意是 +0x94（minY），对着 RT 像素的矩阵
matrix.translate(dx, dy, 0);
if (O+0x518 != 0) FUN_140258b80(O, &M->decor);           // 同直接上屏
rgb = O->color · (HDR ? O->brightness : 1);
FUN_1401b3430(fontMgr, M, 0, 0, &rgb, O->alpha);          // 与直接上屏同一个函数：同材质变体、同 RV0..3
pop(matrix);
```
- 和直接上屏（`FUN_140258050`）的差别只有三处：平移按 RT 像素、不画 `fontbackground` 四边形（背景由合成 RT 初值 `FUN_140257c30` 负责：`opaquebackground` 清成背景色，否则背景快照 + `composelayer_clearalpha`）、混合用材质自己的 translucent（不走 `ctx+0x19d8` 的 additive 覆盖）（rea-p6b-layout 第 4、5 节）。
- 装饰照画。合成 RT = `trunc(文字框 + 2·padding)`（rea-p6b-layout，`FUN_140258ab0`），文字框不含 `pad`（4.1），所以 MSDF 四边形会伸出 RT：`padding`（缺省 32、钳到 512）小于 `pad`（`pointsize 32` 时 50）时，贴边字形的描边、模糊、投影被裁掉【推】。非 MSDF 文本没有 `pad`，不会裁。

---

## 6. 彩色字形的 MSDF（`FUN_1401ab9c0`、`FUN_1401ac4e0`）【确：结构；细节未逐条核对】
- 触发：MSDF 字体、face 带 `FT_FACE_FLAG_COLOR`、位图是 BGRA（2.1）。格子算法同 2.4（`bbox` 来自彩色位图字形，`s`、`tx`、`ty`、`r` 同式），只是不调 msdfgen。
- 距离场（`FUN_1401ab9c0(bitmapGlyph, &out4, r, &scale, &translate)`）：
  1. 位图每像素 `alpha ≥ 128` 为内、否则为外，建两张 `w·h` 的 float 表：内表在外像素处为 0、内像素处为 `1e20`（`0x60ad78ec`），外表相反；
  2. 两张表各做一次可分离的平方欧氏距离变换（`FUN_1401ac3b0` 先行后列，辅助数组 `v`、`z` 的形状是 Felzenszwalb–Huttenlocher 的下包络法）【推：按数组形状认的】；
  3. 有符号距离（源位图像素）：外像素 `0.5 − sqrt(d²_外)`，内像素 `sqrt(d²_内) − 0.5`；
  4. 对输出格子每个像素：`(px, py) = ((x + .5)/s − tx, (y + .5)/s − ty)` 换到位图坐标（x 减位图 `left`，y 用 `top − py`，float），钳进 `[0, w−1] × [0, h−1]`，在钳后的点上对有符号距离表双线性插值，再减去「原点到钳后点」的欧氏距离；
  5. `v = d · (1/r) + 0.5`，`out4[x, y]` 的四个通道写同一个 `v`。
  6. 之后同 2.6 转字节（4 个通道都按 `×256` 截断，不写 alpha 255），翻转相同。
- 颜色（`FUN_1401ac4e0`）：颜色缓冲是距离场的 `k` 倍分辨率；每个颜色像素按 `((i + .5)/(k·s) − tx) − left` 一类的式子映射回位图，越界写 0，否则 BGRA 位图四邻双线性（f32 权重）、`+0.5` 截断、钳 [0, 255]，交换 R、B。
- 能否复现：算法可以复现（精确 EDT 结果唯一，与实现无关；剩下的是 f32 / f64 的混用与取整）。逐字节一致要把 `FUN_1401ab9c0` 的指令级细节核一遍，见「未查清」。

---

## 7. 对我们的 wasm 构建的含义
1. 编 msdfgen **v1.13**（`core/` + `ext/import-font.cpp` 的回调可以不用，自己写等价的四个回调即可），不开 OpenMP、不开 skia，`MSDFGEN_USE_CPP11` 与否不影响数值。
2. FreeType 侧：`FT_Set_Char_Size(face, 0, int(size·64), 300, 300)`，`FT_Load_Glyph(…, FT_LOAD_NO_BITMAP)`（**不要** `NO_HINTING` / `NO_SCALE`），`FT_Get_Glyph` + `FT_Glyph_Get_CBox(PIXELS)`。字号用「场景里第一个用到该字形的文本对象」的字号。
3. 流程：`readFreetypeOutline` 等价物（scale 1/64）→ `normalize()` → `orientContours()` → `edgeColoringSimple(3.0)` → 按 2.4 的 float32 式子算 `inner`、`s`、`t`、`r` → `generateMSDF(…, MSDFGeneratorConfig(true))` → 2.6 转字节、翻转、alpha 255。
4. 图集、UV、四边形外扩、装饰常量照第 3、4 节。纹理无 mip、双线性、WRAP。
5. 我们的编译器与 MSVC 的浮点差异：msdfgen 全是 double，MSVC x64 用 SSE2、不收缩成 FMA（`/fp:precise` 缺省）【推：没看编译选项，汇编里没见 FMA 指令】；wasm 的 f64 也不做 FMA，`sqrt` 正确舍入，一致。`pow(…, 1/3.)`、`acos`、`cos`、`sin(3.0)` 走 CRT（`FUN_14041db10`、`FUN_14041bf60`、`FUN_14041c880`、`FUN_14041f210`），与 wasm 里 musl / wasi-libc 的实现可能差 1 ulp，`solveCubic` 只在二次段距离里用到，最坏影响个别像素的末位，转字节截断后多半看不出。这是逐字节比对时最可能的残差来源。

---

## 未查清
- `FUN_14028a910` 内部（`MSDFErrorCorrection` 的 `protectCorners` / `protectEdges` / `findErrors` / `apply`）只核了结构与分派，没逐行与 v1.13 比；按版本区间结论应当相同。
- MSVC 的 CRT 数学函数（`pow`、`acos`、`cos`、`sin`）与 wasm libc 的 ulp 差异（见第 7 节第 5 条）。
- 编译选项（`/fp:precise` / `/fp:fast`）：汇编里看到的乘加都是分开的 `mulsd` / `addsd`，没见 FMA，但没系统搜。
- `basefont_msdf*` 着色器读不读 `g_RenderVar3.yzw`（不写、保留旧值）。
- 空包围盒字形（空格）在 MSDF 下是否出四边形、四边形里会不会露出回收格子的残留。
- `faceIdx` 跨字号不一致导致取错字形（2.1）只是由代码推出，没构造实例。
- 彩色 MSDF：`FUN_1401ab9c0` 的距离变换实现（是否就是 Felzenszwalb）、坐标里 f32 / f64 的混用、越界距离项的确切写法；`FUN_1401ac4e0` 的坐标式子；彩色 MSDF 的 alpha 通道（转字节第 4 个通道来自距离场，不是 255）在 `basefontrgba_msdf` 里怎么用。
- `y_ppem` 的 FreeType 取整（TrueType 头 bit3 的 `y_scale` 取整）按上游推断，没在 exe 里核。

---

## 建议的实测
抓帧用 wpe-renderdoc MCP，放 `A:\p6f\msdf\`；工程用 kbp-tools 生成，放 `ignore/p6/f0/`；1920×1080 正交。核对都以「存下 `__font_atlas_`（RGBA8）原始字节，与我们的 wasm 流程逐字节比」为主。

- **M1 基线**：`fonts/RobotoMono-Regular.ttf`（TrueType，二次曲线），`pointsize 32`，`msdf: true`，`text: "AVAWay g|O0"`。核对：
  1. 图集 512×512 RGBA8、1 级 mip，采样器线性 + WRAP；`g_Texture0Resolution = (512, 512, 512, 512)`；
  2. 每个格子尺寸 = `max(1, trunc(f32(bbox)·f32(32/133))) + 24`，格子间 1 像素间隙、四周清零；
  3. 格子字节与我们 v1.13 + 本文外围流程逐字节相同；
  4. 四边形外扩 `133·12/32 = 49.875`，`RV0 = (24, 0, 0, 0)`。
  - 再出一份「不调 `orientContours`」与「用 `FT_LOAD_NO_HINTING`」的我们版本，确认两处都会让字节不同（证明 WPE 确实这么做）。
- **M2 三次曲线（区分 `e3ced1e` 之前 / 之后）**：CFF 字体（`fonts/Segment7Standard.otf` 或系统的 `.otf`），带弯曲笔画的字（`"S8&@"`）。同时用 v1.12.1 与 v1.13 各出一份，挑出两者字节不同的格子，看 WPE 落在哪一边。
- **M3 反收敛（区分 `54535fc` 之前 / 之后）**：需要带尖角收敛（两条曲线在角点切线相反）的字形。字体里少见，建议自造一个只含这种字形的 TTF 放进工程 `fonts/`（如一个月牙形 / 鸟嘴形轮廓），v1.12.1 与 v1.13 对比同 M2。
- **M4 字号顺序**：同一字体两个对象，先建 `pointsize 16`、再建 `pointsize 64`（JSON 顺序），再交换顺序各抓一次。预期格子内容随**先建的那个**字号变化，几何与 `pad` 随各自字号；两次抓帧的格子字节不同。
- **M5 装饰常量**：`outline` / `blur` / `dropshadow` 各开、全开，`pointsize 32` 与 `64`，再加 `outlinethickness 30`、`blursize 30`、`dropshadowoffset "-50 80"`，核对 `RV0..RV3` 逐位等于 4.2 的 float32 算式（含 5.1 与 6 的钳制、`RV0.y` 让位），`RV3.yzw` 是什么。
- **M6 合成路径裁切**：M5 全开的对象加一个 tint effect，`padding 0` 与 `padding 64` 各一次，看合成 RT 尺寸与贴边字形的投影是否被裁。
- **M7 彩色 MSDF**：`msdf: true`，`text: "😀A"`（主字体没有 emoji → Segoe UI Emoji）。存 `__font_atlas_`（距离场，四通道同值）与 `__font_atlas_color_`（`k` 倍），用于第 6 节的逐条核对。
- **M8 回收与翻倍**：MSDF 下放约 300 个不同汉字（格子大，很快满），看翻倍到 1024、UV 减半，以及回收后格子里残留与清零的样子。
