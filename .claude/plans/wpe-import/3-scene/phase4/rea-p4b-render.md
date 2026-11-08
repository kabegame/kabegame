> 逆向原始记录，代理写的，地址按 Ghidra。只读码，没有实测；实测核对写进 [p4-particles-REPORT.md](p4-particles-REPORT.md)「P4b 语义的实测核对」。本文件覆盖步骤 0a 的第 1、2、6、7 项，第 3、4、5、8 项见 `rea-p4b-modules.md`。

# WPE 2.8.42 P4b 渲染侧静态逆向（纹理、帧表、折射、colorn）

**概括**
- 纹理格式【确】：`.tex` 枚举直接查表转 DXGI。DXT3 → `BC2_UNORM`，DXT1 → `BC1_UNORM`，RG88 → `R8G8_UNORM`，R8 → `R8_UNORM`，都不是 sRGB。加载时不转换通道。
- alpha-priority（头标志 0x80000）【确，有界】：全二进制没有任何纹理代码读 bit19。整个标志字只进采样器缓存的哈希键。
- NPOT【确】：`g_Texture0Resolution = (纹理宽, 纹理高, 图像宽, 图像高)`。粒子四角 UV 固定 0/1，不按图像尺寸缩，填充区会被采到。
- 帧表【确】：运行时把每帧坐标按第 0 级 mip 尺寸归一化。粒子只用第 0 帧的宽、高和帧数，写成 `g_RenderVar1`。`SPRITESHEET` 一定伴随 `THICKFORMAT`。`a_TexCoordVec4C1 = (速度xyz, frame 原值)`，frac 在着色器里做。
- 系统 `flags` bit1【确】：读取点找到了，作用是关掉 `SPRITESHEETBLEND`。`randomframe` 会顺带置它。
- 折射【确】：快照就在本粒子系统画之前拷，同一顶层对象每次绘制只拷一次（父子系统共用防重位）。`NORMALMAP` 是普通采样器 combo，绑了槽 1 就定义；`require`、`requireany`、`format` 注解运行时都不读。
- colorn【确】：要改 rea-p4a 一处。「系统颜色」**不是**粒子 JSON 的 `colorn` 键，而是加载时从颜色模块推出来的代表色。四类颜色模块各有一种绑定记录，按 HSV 差值从基值重算。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 前缀 `40e2ce021e935232`，开工核对一致。只分析 scratchpad 副本，未运行 WPE。
- 方法：REA（Ghidra 12.1.4，从 `p4a` 快照复制到 `ignore/p4/rea/p4b-render/` 打开）+ `wp.asm` 切片 + 脚本。会话已关闭，没有改元数据，没有另存快照。
- 工作文件在 `D:\Codes\kabegame\ignore\p4\rea\p4b-render\`：`bit19.py`、`bit19b.py`（alpha-priority 搜索）、`texscan.py`（`.tex` 头扫描，输出 `texscan_assets.txt`）、`cand.py`（候选纹理）、`c45f0.c`（`FUN_1401c45f0` 伪代码）、`ec7b0.asm`（建纹理函数）等。
- 没有改仓库代码和别的计划文件，没有提交。
- 标记：【确】读到代码；【推】推出、没逐行确认；【未知】没读到。
- 对象命名沿用 rea-framework：`ctx` = R+0x10，`obj` = 粒子对象，`sys` = obj+0x2c0，`def` = 解析出的系统定义（`sys` 里的偏移 = `def` 偏移 + 0x18）。`tex` = 纹理对象。

---

## 1. 纹理

### 1.1 `.tex` 的读入【确】

- 容器 `FUN_14015e580`：`TEXV0005` 后循环读块，块名只比前 4 个字符，版本号取后 4 位。`TEXI` → `FUN_14015c760`，`TEXB` → `FUN_14015c8d0`，`TEXS` → `FUN_14015e1d0`。
- `TEXI`（`FUN_14015c760`）按序读：format、flags（**或**进已有值）、textureWidth、textureHeight、（flags & 0x40 时多一项，3D 纹理深度）、imageWidth、imageHeight、版本 ≥ 1 时再一项。
- 纹理对象布局：从 `tex+0x18` 起照头的顺序。`+0x18` 格式，`+0x1c` 标志，`+0x20/+0x24` 纹理宽高，`+0x28` 深度，`+0x2c/+0x30` 图像宽高。依据：`FUN_1401d2340` 读 `+0x18`、`+0x20`、`+0x2c`；`FUN_1400d8300` 读 `+0x20/+0x24/+0x2c/+0x30`。
- 第 0 张图像的 mip 少于 2 级时标志 `|= 8`（`FUN_14015e580` 尾部）。用途【未知】。
- `TEXB` 返回 1 时，帧表里的 6 个归一化坐标全部 `×0.5`（`FUN_14015e580` 尾部循环）。【推】这是读入时跳过了最高一级 mip，坐标是按跳过后的 mip 归一化的，这里改回去。

### 1.2 格式 → DXGI【确】

映射函数 `FUN_1400d2a20`（`switch(format)`，跳转表 `0x1400d2aa4`），调用者是建纹理函数 `FUN_1400ec7b0`（`0x1400ed033`，参数 `ecx = tex+0x18`）。

| `.tex` 格式 | DXGI | 值 |
|---|---|---|
| 0 RGBA8888 | `R8G8B8A8_UNORM` | 28 |
| 4 DXT5 | `BC3_UNORM` | 77 |
| **6 DXT3** | **`BC2_UNORM`** | 74 |
| **7 DXT1** | **`BC1_UNORM`** | 71 |
| **8 RG88** | **`R8G8_UNORM`** | 49 |
| **9 R8** | **`R8_UNORM`** | 61 |
| 10 RG1616F / 11 R16F | `R16G16_FLOAT` / `R16_FLOAT` | 34 / 54 |
| 12 BC7 | `BC7_UNORM` | 98 |
| 1、2、3、5 | `R8G8B8A8_UNORM` | 28 |

- 13 以后是引擎内部格式（RT、深度），与 `.tex` 无关。
- 1、2、3、5 映射到 RGBA8，【推】加载时已转成 RGBA8。
- 描述（`0x1400ed53a` 起）：`Width/Height` 取该图像第 0 级 mip 的尺寸，`Format` 取上表，`ArraySize 1`。`flags & 0x20` 时 `Usage DEFAULT`、`Bind SR|RT`、`GENERATE_MIPS`，否则 `IMMUTABLE`、`Bind SR`。`flags & 0x40` 建 3D 纹理（`0x1400eda8c`）。
- 没有发现上传前改通道的代码。所以 D3D 采样 RG88 得 `(r, g, 0, 1)`，R8 得 `(r, 0, 0, 1)`。WebGPU 的 `rg8unorm` / `r8unorm` / `bc1-rgba-unorm` / `bc2-rgba-unorm` 语义相同。
- 通道换算由着色器做（`ConvertTexture0Format`：RG88 → `rrrg`，R8 → `(1,1,1,r)`），前提是定义了 `TEX0FORMAT`，见 2.4。
- 每个图像各建一个 D3D 纹理和 SRV，存在 `tex+0x140` 起的 24 字节项向量里（`0x1400edb10`）。绑定 `FUN_1400ee8b0` 取 `tex+0x98` 号图像的 SRV，采样器取 `tex+0x158`。

### 1.3 alpha-priority（头标志 0x80000）【确，有界】

结论：运行时没有任何分支看这一位。

标志字的读者（逐个看过）：
| 读者 | 用到的位 |
|---|---|
| `FUN_14015c760` 解析 | 0x40（多读一项） |
| `FUN_14015e580` | 置 8 |
| `FUN_1400ec7b0` 建纹理 | 0x20、0x40、0x2000000（SRV 维度），整字传给采样器 |
| `FUN_140099980` 采样器缓存 | 描述只看 bit0（点采样）、bit1（clamp）、0x4000000、0x8000000；**整字只作哈希键** |
| `FUN_14015c470` | bit2（精灵表，见 2.3） |
| `FUN_14016c800` 采样器宏 | `0x100000 << i`（bit20 起），不含 bit19 |

全二进制指令扫描（`bit19.py`、`bit19b.py`）：
- 搜了：`test/and/or` 立即数含 0x80000（掩码 < 0x1000000、置位数 ≤ 6）；`bt/bts/btr x, 0x13`；`shr/sar x, 0x13`；`shr x, N` 后 4 条内 `test/and 1<<(19−N)`；字节测试 `[r+0x1e], 8`、`[r+0x6], 8`；`movzx byte [r+0x1e]` 后测 8。
- 22 处命中，没有一处在纹理代码里：
  - 【推】窗口扩展样式 `WS_EX_LAYERED`（`0x14003da1a`、`0x140062ed0`：导入函数调用后 `bts eax, 0x13`，导入名没解析）、窗口样式 `0x90000`（`0x1400b210b`）。
  - 浮点转字符串（`0x140165c00`）、数字串解析（`0x1400e74d0` 一带）、暂停全局量（`0x14006d436`）、JSON 属性（`0x140104b60`）、CRT（`0x14028b…`、`0x1402e…`）。
  - **粒子系统 `flags` 的 bit19**（`0x1401d02d1` 置位、`0x1401d2340`、`0x140232e13`、`0x1402368ff`、`0x1402378ea`）。这是 rope 的 `uvscrolling`，与纹理无关。
  - 字节测试 `[r+0x1e], 8` 的 18 处全在脚本引擎哈希表 `FUN_140265c30`。
  - `0x1400a6a52` 未细看，不在纹理代码段。
- 没覆盖：按 `cl` 的变量移位、以标志为下标的查表、整字比较、置位数 > 6 的掩码、SIMD。

语料里带 0x80000 的都是 RG88 / R8（列表见末节）。

### 1.4 NPOT（纹理尺寸大于图像尺寸）【确】

- `g_Texture0Resolution`（ID 0x3e）在 `FUN_1400d8300` 的 `0x1400d97d5`：`(float)tex+0x20, +0x24, +0x2c, +0x30`，即 **(纹理宽, 纹理高, 图像宽, 图像高)**。空槽 `(2,2,2,2)`。与 p2-REPORT I3 一致。
- D3D 纹理按第 0 级 mip 建。assets 实测（只读头）：`effects/foliagesway/preview/materials/plant1.tex` 头 512×1024、图像 512×875，mip0 = 512×1024；`effects/xray/.../x-ray-1704855_960_720.tex` 1024² / 598×720，mip0 = 1024²。所以 mip0 是填充后的尺寸。
- 粒子路径不缩 UV：
  - 顶点四角 UV 只取 0、1（非 GS 写入 `0x140235b71` 起：`r13 = (0,0)`、`r10 = (0,1)`、`r11 = (1,1)`）。GS 路径着色器里同样是 0..1。
  - 着色器 `genericparticle` 不读纹理矩阵。
  - 非精灵表时 `textureRatio = g_Texture0Resolution.y / .x`，用的是填充后的宽高比。
- 精灵表：帧坐标按 mip0（填充后）归一化（1.1、2.1）。`SPRITESHEETBLENDNPOT` 时着色器用 `g_Texture0Resolution.z / .x` 算每行帧数（2.4）。
- 图层路径的 UV 缩放见 p2-REPORT（`img/tex`），与粒子不同。

---

## 2. 帧表（粒子路径）

### 2.1 TEXS 读入【确】

`FUN_14015e1d0(版本, 读指针, texinfo, 图像表, 帧表)`：
- 头：帧数（int）。版本 ≥ 3 再读宽、高（原样 4 字节存）；版本 < 3 时宽高取 texinfo 的图像宽高。
- 每帧 32 字节，文件顺序：`imageId`（int，`movsxd`）、`frametime`（float）、`x, y, width, widthY, heightX, height`。版本 1 这 6 项是 int（`cvtdq2ps`），版本 2、3 是 float。
- 归一化：取 `imageId` 号图像的第 0 级 mip 宽高 `(W, H)`（`cvtsi2ss`），`divss` 精确除：

```
entry = { frametime, imageId,
          x/W, y/H, width/W, widthY/H, heightX/W, height/H }   // 偏移 +0 … +0x1c
frameTable.total += frametime
```

- `imageId` 越界或该图像没有 mip 时，6 个坐标写 0。
- 存储：帧表结构在 `tex+0xa8`：`+0xa8` 总时长、`+0xac` 版本、`+0xb0/+0xb4` 头宽高、`+0xb8..+0xc0` 帧向量（32 字节项）。

### 2.2 `g_RenderVar1` / `g_RenderVar0`【确】

写入在系统绘制 `FUN_1402366f0`（`0x140236827` 起），renderer 循环之前，每次绘制写一次。`ctx+0xb8..0xc4` 就是 `g_RenderVar1`（`FUN_1400d8300` case 0x6d 读 `ctx+0xb8`，`0x1400d9ec0`）。

```
if (sys.flags & 0x1000000) && tex0 && frames 非空:      // tex0 = 基础材质 +0xd0
    f0 = frames[0]
    RV1.x = f0.width/W          // +0x10
    RV1.y = f0.height/H         // +0x1c
    RV1.z = (float) frameCount  // (end-begin)>>5
    RV1.w = (tex.texH / tex.texW) * (f0.height/H / (f0.width/W))
```

- 只用第 0 帧。`x, y, widthY, heightX, frametime, imageId` 粒子路径都不读。
- `RV1.w` 在 mip0 等于头尺寸时就是帧的像素宽高比 `height_px / width_px`。
- 例：`fog1` = (0.125, 0.125, 64, 1)；`rain1` = (0.5, 0.5, 4, 1)；`bubble1` = (0.16667, 0.2, 30, 1.2)；`lightning2`（TEXS0002）= (0.25, 0.125, 32, 0.25)。
- 帧向量为空但设了 `0x1000000` 时不写，`RV1` 保留上一次绘制的值（边界情况）。

`g_RenderVar0`（`ctx+0xa8`，P4c 用）：
- `spritetrail`（renderer 类型 2）：`RV0.xyz = 记录 +0x3c, +0x40, +0x44`。解析 `0x1401cfe75` 起依次读 `length`、`maxlength`、`minlength`。【推】三者正好落在 +0x3c/+0x40/+0x44（与着色器 `max(RV0.z, min(len·RV0.x, RV0.y))` 对得上）。`RV0.w` 不写。
- rope 类型 3、4 写 `ctx+0xb0/+0xb4`（即 `RV0.zw`），细节属 P4c。

### 2.3 系统 `flags` 高位与 bit1

| 位 | 置位条件 | 地址 | 证据 |
|---|---|---|---|
| bit1 = 2 | JSON `flags` 写了，或 `animationmode == "randomframe"` | `0x1401c57d7` | 【确】 |
| 0x10000 | 有 rope | `0x1401d0403` | 【确】 |
| 0x80000 | rope `uvscrolling` | `0x1401d02d1` | 【确】 |
| 0x200000 | scene.json 根的 `version` < 5（缺键为 0），或没有任何颜色模块（见 7.3、7.4） | `0x1401c57bb`、`0x1401c5af9` | 【确】 |
| 0x800000 | 材质着色器带几何着色器阶段（`[mat+0x1e0]` 虚函数 `+0x20` 的 bit0） | `0x1401d04d0` | 【确】 |
| **0x1000000** | **材质槽 0 纹理的头标志 bit2（0x4）**：`FUN_14015c470` = `(tex+0x1c >> 2) & 1` | `0x1401d04a5` | 【确】 |
| 0x2000000 | 有 `spritetrail` | `0x1401cff1b` | 【确】 |

- JSON `flags` 只取低 8 位（`0x1401c56f0` `movzx ecx, al`），高位都是引擎自己置的。
- `animationmode`：字符串等于 `"randomframe"` 时 `def+0x30 = 1`，其余（含 `"sequence"`、缺省）为 0（`0x1401c5717`–`0x1401c5731`）。
- **bit1 的读取点**：`FUN_1401d2340` 的 `0x1401d24d2`，结果只用于 `SPRITESHEETBLEND`（2.4）。在 `0x1401b8000–0x1401d9000`、`0x140220000–0x140262000` 两段搜 `test … 0x2` 一类，另两处命中都是模块记录自己的 flags（`0x14023cd22`、`0x1401ce074`）。【确，有界】
- 注意区分：发射器 `flags` bit1（每帧最多发 1 个）是 emitter 记录的字段，与这里的系统 `flags` 无关。

### 2.4 粒子材质的宏【确】

`FUN_1401d2340` 按 renderer 流逐条给材质建变体（`0x1401d2531` 起）：

```
need = 0
for r in renderers:
    sprite(1):      need |= (flags & 0x1000000) ? 2 : 1
    spritetrail(2): need |= 2
    rope(3):        need |= 8
    ropetrail(4):   need |= 4
thick = need & 2                               // 任一 renderer 要 THICKFORMAT，所有 sprite 一起走厚格式

fmt     = tex0.format;  is8to11 = (fmt - 8) <= 3        // RG88、R8、RG1616F、R16F
npot    = tex0.imageWidth < tex0.textureWidth           // 只比宽度
blendOK = !(flags & 2) && def+0x30 == 0                 // bit1 或 randomframe 关混帧

sprite 变体:
  if !thick:
      if !is8to11 && orientation == 0: 直接用基础材质（不写任何宏）
      else: TEX0FORMAT = fmt
  else:
      THICKFORMAT = 1
      if flags & 0x1000000:
          SPRITESHEET = 1
          SPRITESHEETBLEND = blendOK
          SPRITESHEETBLENDNPOT = npot
      if is8to11: TEX0FORMAT = fmt
spritetrail 变体: THICKFORMAT = 1, TRAILRENDERER = 1，其余同上
```

- `SPRITESHEET` 只在厚格式分支写，所以**有 `SPRITESHEET` 就一定有 `THICKFORMAT`**。
- `TEX0FORMAT` 对 RG88、R8 所有分支都会写；对 RGBA、DXT 只在非 `screen` 朝向时写（值为格式本身，不影响画面）。hdr-macro-REPORT 写的「粒子路径无条件写」要按这里修正。
- 值为 0 的宏也会写（`#define SPRITESHEETBLEND 0`），`#if` 不成立，等同未定义。
- sprite 记录 `+0xc` 是 `orientation`（`FUN_1401c22e0` 写 `param_1+8`，`param_1` = 记录 +4）。【推】

### 2.5 frame 列【确】

| 时机 | 公式 | 地址 |
|---|---|---|
| 出生 | `frame = (def+0x30 == 0) ? 0 : R`（`R` 是共用随机列 `sys+0x338`） | `0x14023b4e9` |
| 每帧（模拟第 3 步） | `flags & 0x1000000` 且 `def+0x30 == 0` 时 `frame = rcpps(life) · age · seqmul` | `0x140237022` |

- 运算顺序：`rcpps(life)` 先乘 `age` 再乘 `seqmul`，4 宽 SIMD。`rcpps` 相对误差约 3.7e-4。
- `seqmul` = `sys+0x2c` = `def+0x14`，即 `sequencemultiplier`。缺失或不是数字时取 1（`0x1401c574a`–`0x1401c5779`）。
- 引擎不取 frac，`frame` 可以大于 1。`seqmul = 2` 时一生循环两遍。
- `randomframe`：出生写 `R` 后不再更新；同时 `SPRITESHEETBLEND = 0`，所以整生固定在 `floor(frac(R)·帧数)` 那一帧。
- 着色器侧：`ComputeSpriteFrame(frac(frame))`，`cur = floor(t·N)`，`next = min(N−1, cur+1)`（不回绕），`blend = frac(t·N)`。

### 2.6 顶点布局与 `a_TexCoordVec4C1`【确】

`FUN_1401d2340` 尾部（`0x1401d3522` 起）按元素代码建顶点格式：0 = `a_Position`，9 = `a_TexCoordVec4`，0xc = `a_TexCoordVec4C1`，0xd = `a_TexCoordC2`，0x19 = `a_Color`。

| 路径 | 条件 | 元素 | 步长 |
|---|---|---|---|
| GS（每粒子 1 点） | `flags & 0x800000` | 0, 9, 0x19 | 44 |
| GS + 厚格式 | 且 `flags & 0x3000000` | 0, 9, 0xc, 0x19 | 60 |
| 非 GS（每粒子 4 顶点） | 无 `0x800000` | 0, 9, 0xd, 0x19 | 52 |
| 非 GS + 厚格式 | 且 `flags & 0x3000000` | 0, 9, 0xc, 0xd, 0x19 | 68 |

顶点写入（`FUN_1402308a0` 内，分支 `0x1402358a3`：`FUN_140229750` = `flags>>23 & 1` 选 GS，`flags & 0x3000000` 选厚格式）：

```
GS 60 字节（0x1402359c0）:
  +0x00 x y z            (0x2b0 0x2b8 0x2c0)
  +0x0c rotx roty rotz   (0x280 0x288 0x290)
  +0x18 size             (0x270)
  +0x1c vx vy vz         (0x2c8 0x2d0 0x2d8)   ← a_TexCoordVec4C1.xyz
  +0x28 frame            (0x268)               ← a_TexCoordVec4C1.w，原值
  +0x2c r g b a          (0x2f8 0x300 0x308 0x310)
非 GS 68 字节（0x140235ea9，每顶点）:
  +0x00 x y z
  +0x0c u v rotz size    (u v ∈ {0,1})
  +0x1c vx vy vz frame   ← C1
  +0x2c rotx roty        ← C2
  +0x34 r g b a
```

- C1 = **(速度三分量, frame 原值)**，都是系统本地空间的列值，不变换、不取 frac。GS 路径由顶点着色器 `frac(w)`，非 GS 路径在 `ComputeSpriteFrame(frac(...))` 里取。
- 跳过 `life == 0` 的槽，按槽序写。
- WPE 实际走 GS 布局（`genericparticle` 带 `.geom`）。WebGPU 走非 GS 布局，每粒子内容相同。

### 2.7 多图像纹理（`imageCount > 1`）【推】

- 粒子路径只用第 0 帧的宽高和帧数。帧项里的 `imageId` 没有读者（`FUN_1402366f0` 不读）。
- 着色器按网格算帧 UV（`uvs.x = frac(cur·frameWidth)`，`uvs.y = floor(cur·frameWidth)·frameHeight`），不会切换图像。
- 绑定取 `tex+0x98` 号图像（`FUN_1400ee8b0`）。没找到运行中写 `tex+0x98` 的地方（只有两纹理互换 `0x14015fae3`），所以【推】粒子总是采第 0 张图像，落在其它图像上的帧采不到（网格 UV 会超出 1）。
- assets 里没有 `imageCount > 1` 的纹理。建议继续报 `tex:animation:multi-image`。

---

## 6. `REFRACT`

### 6.1 快照时机【确】

```
FUN_140236600(obj)   // 粒子对象绘制虚函数（虚表 +0x50）
  obj+0x93d &= ~1                          // 每次绘制先清防重位
  压模型矩阵 → FUN_1402366f0(sys) → 弹出

FUN_1402366f0(sys)   // 系统绘制
  if 存活数 == 0: 本系统不拷也不画（子系统照常走下面的递归）
  if flags & 4: 压 view/proj，FUN_1401e5b60（透视覆盖）
  if 基础材质 +0x1fc & 2 && !(sys.obj+0x93d & 1):          // 0x1402367e4
      sys.obj+0x93d |= 1
      rt = FUN_1401ab410(场景 +0x16c0, "_rt_FullFrameBuffer"); rt->vfunc[+8]()
  写 g_RenderVar1（2.2）
  逐 renderer 绑材质、画
  子系统：对每个子系统递归 FUN_1402366f0
```

- 拷贝在本系统**任何 renderer 画之前**，所以快照 = 本帧按 `objects` 顺序画在它前面的全部内容，不含自己。
- 调用方式与图层「层首拷贝」完全相同（`0x1401e8f78`：同一个 `FUN_1401ab410` + 虚函数 `+8`）。p2-REPORT B8 已确认实现是 `CopyResource`（MSAA 时 `ResolveSubresource`），把**当前场景目标整张**拷进 `_rt_FullFrameBuffer`。
- `_rt_FullFrameBuffer`：场景尺寸、scale 1；LDR `R8G8B8A8_UNORM`，HDR `R16G16B16A16_FLOAT`（p2-REPORT）。
- 子系统构造时传入父系统的 `sys[1]`（`FUN_1402293a0(…, ctx, 父 sys[1])`，sim.c 1795 行一带），所以父子共用同一个 `obj+0x93d`：一次对象绘制最多拷一次，由第一个需要的系统（先父后子）触发。父系统不需要而子系统需要时，在子系统绘制前拷，此时快照已含父系统粒子。
- 判断看的是基础材质 `sys+0x358` 的 `+0x1fc` bit1（纹理槽解析到 `_rt_FullFrameBuffer` 时置位，p2-REPORT I2），不是 renderer 变体材质。

### 6.2 `g_RefractAmount` 与 `NORMALMAP`【确】

- `g_RefractAmount` 不是引擎 uniform：二进制里没有这个字符串，名表 `FUN_140002860` 里也没有。它走普通材质常量，缺省值来自着色器注解（0.05）。【推】与图层的材质常量同一路径。
- 二进制里没有 `normalmap`、`requireany`、`REFRACT` 字符串。`require` 只出现在预处理器 `#require`（`0x14016c0ec`）。所以采样器注解的 `"format":"normalmap"`、`"require"`、`"requireany"` 运行时都不读。
- `NORMALMAP` 定义条件（`FUN_14016c800`）：遍历着色器声明的采样器，**该槽绑了纹理**就写 `#define <combo> 1`。不看 `REFRACT` / `LIGHTING`。`g_Texture1` 的声明在 `#if REFRACT || LIGHTING` 里，所以没开折射时定义了也没有作用。
- `TEX1FORMAT`：`g_Texture1` 带 `formatcombo`，材质按名字绑了纹理时写 `.tex` 格式值（hdr-macro-REPORT，已落地）。`DecompressNormalWithMask` 按它选解码：DXT 一类走 `normal.xw = normal.wx` 再 `*2 − (0.965, 1)`，RG88 走 `gr`，其它（含 RGBA8888）走 `wx` 交换后 `*2−1`。
- `_rt_FullFrameBuffer` 由 `g_Texture3` 注解缺省绑定；`TEX3FORMAT` 不定义（该槽没有 `formatcombo`）。

### 6.3 `g_ViewRight`、`g_ViewUp`【确】

- 名表（`FUN_140002860`，编号写在名字之后）：`g_EyePosition` 0x19、`g_ViewForward` 0x1a、`g_ViewRight` 0x1b、`g_ViewUp` 0x1c。
- 取值（`FUN_1400d8300`，`0x1400d96b9`–`0x1400d9722`）：`g_ViewForward = ctx+0x160`，`g_ViewRight = ctx+0x16c`，`g_ViewUp = ctx+0x178`。
- 写入在帧函数（`0x14018018c`–`0x1401802c7`，R 基址，ctx = R+0x10），从视图栈顶 `V = *(ctx+0x38)`（行主序 float[4][4]）抽：

```
g_ViewRight = (V[0][0], V[1][0], V[2][0])     // 第 0 列前三项
g_ViewUp    = (V[0][1], V[1][1], V[2][1])     // 第 1 列前三项
g_ViewForward = −FUN_140184310(V)
```

- 每帧算一次；位置在帧函数调场景绘制（`0x14018031a`）之前，所以【推】早于所有对象绘制。透视覆盖 `FUN_1401e5b60` 只改视图平移，不重算这两个向量，所以**正交粒子与透视粒子拿到的值相同**。
- 正交场景默认相机旋转为单位阵时，值是 `(1,0,0)` 和 `(0,1,0)`。【推】依赖相机矩阵，没逐项读相机构造。

---

## 7. `instanceoverride.colorn`

### 7.1 加载期【确】

**`color` → `colorn`**（对象加载，`0x14022b44b`–`0x14022b746`）：
- `instanceoverride` 里有 `color` 键就无条件处理（即使已有 `colorn` 也覆盖）。
- 三个分量 `strtod` 后各自 `divss 255`（`0x14022b581`–`0x14022b592`），按 `"%.5f %.5f %.5f"` 格式化写回 `colorn`，再删掉 `color`。所以 `colorn` 有 1e-5 的舍入。
- `colorn` 缺省 `−1 −1 −1`（属性表 `FUN_14024d940`，沿用 rea-p4a C5，本轮没重读）。判断「未设」只看 `r < 0`（本轮读到）。
- 存放：`obj+0x85c..0x864`（= `instanceoverride` 基址 `obj+0x778` + 0xe4）。

**系统颜色**（粒子解析 `FUN_1401c5490` 调 `FUN_1401c45f0(粒子 JSON, 临时对象)`，`0x1401c5963`）：

```
color = (1, 1, 1); hascolor = false
for init in initializers（按顺序，不提前退出，后者覆盖前者）:
    colorrandom:    color = ((max − min)·0.5 + min) · 0.003921569   // min/max 是 0–255，缺省 "0 0 0" / "255 255 255"
    hsvcolorrandom: color = hsv2rgb(clamp(hue 中点), clamp(sat 中点), clamp(val 中点))
    colorlist:      color = colors 里第一个字符串项的原值（不 ÷255）
    （命中任一项 hascolor = true）
if 一个都没命中:
    找第一个 operator colorchange: color = startvalue（缺省 "1 1 1"），hascolor = true
临时对象.colorn   = sprintf("%.5f %.5f %.5f", color)
临时对象.hascolor = hascolor
```

- 解析器随后从临时对象读 `colorn` 写进 `def+0x1c..0x24`（`0x1401c5a92`），即 `sys+0x34..0x3c`。这就是比较用的「系统颜色」。
- **改 rea-p4a C5**：不是「粒子 JSON 里的 `colorn`」，粒子 JSON 根上的 `colorn` 键不被读。
- 紧接着 `FUN_1401b8b90` 把系统颜色转成 HSV（`0x1401c5aaf`，结果存进 `[rbp−0x10]`，`0x1401c5ac6`），写进每条颜色绑定记录。
- `hascolor` 为假时置 `0x200000`（`0x1401c5af9`）。
- 1/255 用乘法常量 `0x140492618`（float32 0.0039215689），不是除法。

### 7.2 颜色绑定记录【确】

解析颜色模块时，若系统 `flags` 无 bit3，就往绑定流（`def+0x98`，写指针 `[rsp+0x30]`）追加一条记录：

| 模块 | 记录类型 / 长度 | 追加器 | 调用点 |
|---|---|---|---|
| initializer `colorrandom` | 0xb / 0x44 | `FUN_1401d8540` | `0x1401c77c4`（`0x1401c77a2` 测 bit3） |
| operator `colorchange` | 0xc / 0x54 | `FUN_1401d8a90` | `0x1401cbea9`（`0x1401cbe87` 测 bit3） |
| initializer `hsvcolorrandom` | 0xd / 0x34 | `FUN_1401d8580` | `0x1401c7aa1` |
| initializer `colorlist` | 0xe / 0x24 | `FUN_1401d87a0` | `0x1401c7eee` |

- 0xb 记录：`+4` 目标模块指针，`+0xc` 长度，`+0x14..+0x1c` 基色 A（min），`+0x20..+0x28` 基色 B（max），`+0x2c..+0x34` 系统颜色 HSV，`+0x38/+0x3c` 目标字段偏移（`colorrandom` 记录的 min `+4`、range `+0x10`，见 init.c）。
- 0xd、0xe 的对应关系按调用点所在的模块分支定，没有逐字段核对记录内偏移。

### 7.3 重算（`FUN_14022bd40` → `FUN_1401d15a0`）【确】

**是否生效**（`FUN_14022bd40`，`0x14022bd7f`–`0x14022be4f`）：

```
active = !(colorn.r < 0)
      && !(|sys.color.r − colorn.r| < 0.0035294117 && …g… && …b…)   // 系统颜色 sys+0x34..0x3c
      && !(sys.flags & 8)                                          // 0x14022be10
if (p3 & 1): if !active: p3 |= 2          // 本系统没生效时给子系统传 bit1
if (p3 & 2): active = false
sys+0x3f7 bit1 = active
子系统递归时传 p3 & ~1
```

- 0.0035294117 = 0.9/255。
- 每帧脏标志置位时调 `FUN_14022bd40(sys, 1, 1)`（`0x1402307df`）；加载时同样（`0x14022b848`）。所以**父系统没生效时，子系统一律不生效**；父系统生效时子系统各自比较。

**实例颜色与亮度**（`FUN_1401d15a0` 开头，`0x1401d15ec`–`0x1401d16aa`）：

```
k = (ctx.flags & 0x2000 && !(sys.flags & 8)) ? brightness : 1     // HDR 才乘亮度
if (sys.flags & 0x200000) && active: instColor = colorn · k
else:                                instColor = (k, k, k)
sys+0x3e0..0x3e8 = instColor          // 新粒子 rgb0 初值
sys+0x3ec        = instanceoverride.alpha
if active: (h, s, v) = rgb2hsv(colorn)
```

- `0x200000` 的两个来源：场景 `version` < 5（`[ctx+0x1510]` 虚函数 `+0x40` 返回 scene.json 根的 `version`，`0x1401c57b6`；7.4 更正，原写「设备档位」），或没有任何颜色模块（7.1）。
- 没有颜色模块时（常见情况）就是 `instColor = colorn·k`，没有绑定记录。
- `version` < 5 且有颜色模块时，实例颜色和下面的 HSV 平移会同时生效：颜色模块平移之后再乘一次 `colorn`（7.4）。

**HSV 平移**（逐条绑定记录，`active` 为假时把基值原样写回）：

```
rgb2hsv(c):                               // FUN_1401b8b90，全部 divss
    mx = max(r,g,b); d = mx − min(r,g,b); v = mx
    if d < 1e-5 || mx <= 0: h = 0, s = 0
    else: s = d/mx
          h = (r < mx) ? ((g < mx) ? (r−g)/d + 4 : (b−r)/d + 2) : (g−b)/d
          h /= 6; if h < 0: h += 1
hsv2rgb(h,s,v):                           // FUN_1401b8c70
    C = v·s; H = (float) fmod((double)(h·6), 6.0)
    X = C·(1 − |fmod((double)H, 2.0) − 1|)（双精度算，再转 float）
    m = v − C
    [0,1):(C,X,0) [1,2):(X,C,0) [2,3):(0,C,X) [3,4):(0,X,C) [4,5):(X,0,C) [5,6):(C,0,X) 其它:(0,0,0)
    return (各分量 + m)

shift(c):                                 // case 0xb / 0xc，(hc,sc,vc)=colorn 的 HSV，(h0,s0,v0)=记录里的系统色 HSV
    (h,s,v) = rgb2hsv(c)
    h' = (hc − h0) + h;  h' = h' − floor(h')      // roundss 9，取模到 [0,1)
    s' = clamp((sc − s0) + s, 0, 1)
    v' = clamp((vc − v0) + v, 0, 1)
    return hsv2rgb(h', s', v')
```

| 记录 | active 时写入 | 目标 |
|---|---|---|
| 0xb `colorrandom` | `A' = shift(A)`、`B' = shift(B)`；写 `A'` 与 `B'−A'` | min、range |
| 0xc `colorchange` | 同上，每个分量广播成 4 宽 | start、end−start（【推】字段对应，布局归 modules 报告） |
| 0xd `hsvcolorrandom` | `hmin' = hc − hrange/2`（不取模）；`smin' = clamp(sc − srange/2, 0, 1)`，`smin'+srange > 1` 时 `srange' = 1 − smin'`；`v` 同 `s` | hue 基值、sat/val 的 min 与 range |
| 0xe `colorlist` | 写 `(hc−h0, sc−s0, vc−v0)`，不生效时写 0 | colorlist 记录 +0x1c..+0x24，出生时每粒子加到随机 HSV 上（init.c case 5） |

- 0xd 不用系统颜色，直接把区间居中到 `colorn` 的 S、V；色相区间以 `colorn` 色相为中心。
- **运行时改值从基值重算**：每条记录保留自己的基色和系统 HSV，`FUN_1401d15a0` 每次从它们算，不在当前值上累加。存活粒子不变，只影响之后出生的粒子（rea-p4a C8）。
- bit3 的判断位置：`FUN_14022bd40` `0x14022be10`（禁 `colorn`）、`FUN_1401d15a0` `0x1401d15f8`（禁亮度）、解析时 `0x1401c77a2`、`0x1401cbe87`（不建绑定记录）。

### 7.4 0xc 记录补读（P4b 步骤 6，2026-11-08）

> 快照从 `p4b-render` 复制到 `ignore/p4/rea/p4b-color/` 打开，二进制 SHA-256 前缀 `40e2ce021e935232` 核对一致。工作文件：`cbb68.asm`（解析分支）、`d15a0.asm`（重算函数全文）、`c5490.asm` / `cc4ab.asm`（解析函数）、`jt.py`（跳转表）、`predict.py`（float32 预测）、`scanver.py`（工坊 `version` 统计）。

**结论【确】**：0xc 的字段对应和 7.3 的公式都对。记录里 A = `startvalue`、B = `endvalue`（解析出的原值），两端各自平移，写回 start = `A'`、Δ = `B' − A'`，每个分量广播成 4 宽。实测终点变黑和 0xc 无关，原因是 `0x200000`：

- 它的「档位」来源不是设备，而是 **scene.json 根的 `version`**。测试工程 `ignore/p4/proj/p4b-color/scene.json` 是 `"version": 3`，小于 5，所以置了 `0x200000`。
- 于是实例颜色 = `colorn · k` = (0, 1, 0)，出生时写进颜色初值列；`colorchange` 又是乘到当前色上的。
- 最终颜色 = (0,1,0) ⊙ lerp(A', B', t) = (0,1,0) ⊙ (t, 1−t, 0) = (0, 1−t, 0)，和 9 个粒子的拟合一致。B' 仍是读码的 (1,0,0)，只是红通道被实例颜色乘成了 0。

**更正 7.3**：7.3 里的「设备档位」应为「场景 `version`」，「低档位且有颜色模块时……同时生效」应为「`version < 5` 的场景里，有颜色模块且 `colorn` 生效时，HSV 平移和乘 `colorn` 同时生效」。本机工坊 136 个场景中，`version` 小于 5（含缺省）的有 67 个，这种情况很常见。

#### 1. `FUN_1401d8a90` 与 0xc 记录布局【确】

`FUN_1401d8a90` 只分配：`rec = *wp; *wp += 0x54; rec[0] = 0xc; return rec + 4`。不写 `+2` 的长度字（0xb `FUN_1401d8540`、0xd `FUN_1401d8580` 也不写），遍历步长用 `+0xc`。字段由调用点 `0x1401cbeae`–`0x1401cbf12` 写，`p = rec + 4`：

| rec 偏移 | 内容 | 来源 |
|---|---|---|
| `+0` | 类型 0xc | 追加器 `0x1401d8a97` |
| `+4`（u64） | 基址 = operator 暂存流基址 `[rsp+0x50]`（= `ctx+0x1450` + 0x6000） | `r14`，`0x1401cbebb` |
| `+0xc` | 记录长度 0x54 | `0x1401cbeb4` |
| `+0x10` | 未写 | — |
| `+0x14..+0x1c` | **A = `startvalue`** 解析值 | 临时量 `[rbp+0..8]`，`0x1401cbebe`–`0x1401cbecb` |
| `+0x20..+0x28` | **B = `endvalue`** 解析值 | 临时量 `[rbp+0x90..0x98]`，`0x1401cbece`–`0x1401cbee1` |
| `+0x2c..+0x34` | 系统色 HSV | `[rbp−0x10..−8]`，`0x1401cbee4`–`0x1401cbef1` |
| `+0x38`、`+0x3c`、`+0x40` | start.r、start.g、start.b 的偏移（相对基址） | `esi = 负载 − r14`，`+0`、`+0x10`、`+0x20` |
| `+0x44`、`+0x48`、`+0x4c` | Δr、Δg、Δb 的偏移 | `esi + 0x30`、`+0x40`、`+0x50` |
| `+0x50` | 未写 | — |

- `r14` 在 colorchange 分支里就是 `[rsp+0x50]`：会改 `r14` 的分支都跳到 `0x1401cc441` 恢复（`mov r14, [rsp+0x50]`），colorchange 跳 `0x1401cc446`，本身不改 `r14`。
- 解析末尾 `FUN_1401c2ef0(旧基址, 新基址, 绑定流)` 把 `+4` 等于旧基址的记录改成新基址：operator 的调用在 `0x1401d03db`，新基址是 `def+0x78`；initializer 的调用在 `0x1401d03c6`，`[rsp+0x40]` 改成 `def+0x68`。所以运行时写回落在活的 operator 记录上。
- A、B 用的临时量和写模块存储用的是同一份，没有读到缺省 `"0 0 0"` 或全零字段的路径。

#### 2. 解析顺序与模块存储【确】

`0x1401cbb68` 起依次是：

1. 建 operator 记录（`FUN_1401d8a70`：类型 5、长 0x90、负载 `rsi = rec + 0x10`）。
2. `FUN_1401bd2a0` 补缺省。
3. 读 `starttime`（`xmm8`）、`endtime`（`xmm7`）。
4. 解析 `startvalue` 到 `[rbp+0..8]`、`endvalue` 到 `[rbp+0x90..0x98]`。
5. 写模块存储（`0x1401cbe06`–`0x1401cbe83`），含 `end − start`。
6. 测 bit3（`0x1401cbe87`）。
7. 追加 0xc 记录（`0x1401cbea9`）。
8. `def+0xc |= 8`（`0x1401cbf15`）。

所以追加发生在解析两端和算 `end − start` **之后**。

| 负载偏移 | 内容（每项 ×4） |
|---|---|
| `+0x00` / `+0x10` / `+0x20` | start.r / start.g / start.b |
| `+0x30` / `+0x40` / `+0x50` | end.r − start.r / end.g − start.g / end.b − start.b |
| `+0x60` | starttime |
| `+0x70` | `rcpps(endtime − starttime)` |

- 修正 rea-p4b-modules B4 的写法：「start ×4」实为三个分量各 ×4，共 0x30 字节；Δ 同理。
- 执行段 `0x1402403a2` 按 `r14 = rec` 读：`+0x10..+0x30` 是 start，`+0x40..+0x60` 是 Δ，`+0x70` 是 starttime，`+0x80` 是 rcp，和上表一致。

#### 3. `FUN_1401d15a0` 的 0xc 分支（跳转表 `0x1401d2308`，0xc → `0x1401d1db1`）【确】

```
A = rec[+0x14..+0x1c]; B = rec[+0x20..+0x28]
if active:                                   // r14b = colorn 有效，0x1401d1dd7
    (hA,sA,vA) = rgb2hsv(A); (hB,sB,vB) = rgb2hsv(B)      // 内联，同 7.3
    dh = hc − rec[+0x2c]; ds = sc − rec[+0x30]; dv = vc − rec[+0x34]
    A' = hsv2rgb(frac(dh + hA), clamp(ds + sA), clamp(dv + vA))   // floorf = FUN_14041a5c0
    B' = hsv2rgb(frac(dh + hB), clamp(ds + sB), clamp(dv + vB))
else:
    A' = A; B' = B                           // 原样写回解析值
base = rec[+4]
*(f32x4*)(base + rec[+0x38]) = A'.r ×4; …[+0x3c] = A'.g ×4; …[+0x40] = A'.b ×4
*(f32x4*)(base + rec[+0x44]) = (B'.r − A'.r) ×4; …[+0x48] g; …[+0x4c] b
```

- `hsv2rgb`（`FUN_1401b8c70`）、`floorf`（`FUN_14041a5c0`）逐条核过，没有能把 (0,0,1) 平移成黑色的分支。B = (0,0,1) 的色相是 4/6，加 1/3 等于 1.0（float32），取小数后为 0，所以得 (1,0,0)。
- 跨调用存活的是 `xmm6`–`xmm9`、`xmm13` 和栈槽，都是被调方保存，不会被破坏。

#### 4. 实测的解释与区分实验

**颜色链（各环都读到，【确】）**：

- **`0x200000` 来源**：`0x1401c57b3` 调 `[ctx+0x1510]` 的虚函数 `+0x40`，结果 < 5 就置 `def+8 |= 0x200000`。
  - `ctx+0x1510` = 场景对象 + 0x50（`0x1401872e8`），这里装的虚表是 `0x14048ea08`（构造 `0x140186cff`），槽 `+0x40` 是 `FUN_1401853b0`：`return [this+0x41c]`，即场景对象 `+0x46c`。
  - `+0x46c` 在 `0x140187401` 由 scene.json 根的 `"version"` 写入，缺键为 0。
  - 同一个 getter 的其它已知门控：≥3 时用 `effectpassthrough_4.json`（`0x1401ebe34`、`0x1401ecaf8`、`0x140257b11`），≥2 时 `0x140257abc` 一处。`version` 从 3 改成 5，已知只有粒子这一处行为会变。【推】这个列表只来自经 `+0x1510` 调用的点。
  - `flags` 在 `0x1401c56f0` 读 JSON，`0x200000` 在其后 `or` 进去；粒子代码里没有清这个位的地方。
- **实例颜色**：`FUN_1401d15a0` 开头，`(flags & 0x200000) && active` 时实例颜色是 `colorn · k`，否则是 `(k, k, k)`，写进 `sys+0x3e0..0x3e8`（7.3）。
- **出生**：`FUN_14023b340` 在跑 initializer 之前，把 `sys+0x3e0..0x3e8` 拷进初值列 `sys+0x318/0x320/0x328`（`0x14023b3c6`）。`def+0xc` 有 bit3（colorchange 置的）时，也拷进当前列 `sys+0x2f8/0x300/0x308`（`0x14023b427`）。
  - 颜色 initializer 都是**乘**到初值列上的：case 3 `colorrandom`、case 4 `hsvcolorrandom`、case 5 `colorlist`（init.c）。
- **每遍**：operator 解释器开头，bit3 时把初值列拷到当前列（`0x14023fc08`–`0x14023fc70`）。colorchange 执行时 `当前 *= t·Δ + start`（`0x14024042f`–`0x140240436`）。

```
I     = (version < 5 || !hascolor) && active ? colorn·k : (k, k, k)
color = I ⊙ [各颜色 initializer 的乘积] ⊙ (A' + t·(B' − A'))
t     = clamp((age/life − starttime) · rcpps(endtime − starttime))     // rcpps(1) ≈ 0.99976
```

**候选解释**：只有 H1 与读码一致，H2、H3 已被读码排除，列出来是为了说明怎样实测区分。

| 编号 | 解释 | 公式 |
|---|---|---|
| H1（读码） | 0xc 照 7.3，`version < 5` 再乘 `colorn` | `I ⊙ lerp(A', B', t)` |
| H2 | B 读成 0（或缺省 end） | `A'·(1−t)` |
| H3 | Δ 写成 −A' | 同 H2 |
| H4 | 只乘 `colorn`，不平移（对照） | `I ⊙ lerp(A, B, t)` |

**预期**（`predict.py`，float32；k = 1，非 HDR；格式为 t = 0 / 0.5 / 1）：

| 实验 | `version` | H1（读码） | H2 / H3 | H4 |
|---|---|---|---|---|
| 原实验 `1 0 0`→`0 0 1`，`colorn 0 1 0` | 3 | (0,1,0) / (0,.5,0) / (0,0,0) | 同 H1 | (0,0,0) 全程 |
| 同上 | **5** | (0,1,0) / (.5,.5,0) / (1,0,0) | (0,1,0) / (0,.5,0) / (0,0,0) | 不平移：(1,0,0) / (.5,0,.5) / (0,0,1) |
| (a) `0.5 0 0`→`0 0 1`，`colorn 0 1 0` | 3 | (0,1,0) / (0,.5,0) / (0,0,0) | 同 H1 | (0,0,0) 全程 |
| (a) | 5 | (0,1,0) / (.5,.5,0) / (1,0,0) | (0,1,0) / (0,.5,0) / (0,0,0) | — |
| (b) `1 0 0`→`0 0.5 1`，`colorn 0 0.5 0` | 3 | (0,.25,0) / (0,.125,0) / (0,0,0) | (0,.5,0) / (0,.25,0) / (0,0,0) | (0,0,0) / (0,.125,0) / (0,.25,0) |
| (b) | 5 | (0,.5,0) / (.25,.25,.125) / (.5,0,.25) | (0,.5,0) / (0,.25,0) / (0,0,0) | — |

- (a) 中 A' = (0,1,0)，B' = (1,0,0)：v 从 0.5 抬到 1，钳位后和原实验相同。在 `version 3` 下 (a) **分不开** H1 和 H2。
- (b) 中 A' = (0,0.5,0)，B' = (0.5,0,0.25)。`version 3` 下 t = 0 时 g 为 0.25（H1）还是 0.5（H2），就能区分。
- **最小区分实验**：只把 `p4b-color/scene.json` 的 `"version"` 从 3 改成 5，其余不动。`c-change` 预期变成 (t, 1−t, 0)，H2 仍是 (0, 1−t, 0)。
  - 同时 `c-range` 的 g 应能超过 0.5（现在 3 个粒子的 g 是 0.10、0.20、0.15）；`c-none` 不变（`hascolor` 为假，照样置 `0x200000`）。
- **对已有实测的影响**：`ana_color.py` 的 7 组吻合不能推翻 H1，原因如下。
  - `c-red-green`、`c-255`、`c-two` 乘不乘结果相同；`c-near`、`c-flag8` 不生效（`active` 假时 I = 1）。
  - `c-range` 乘 (0, 0.5, 1) 后点仍在 A'–B' 线上，只是自由拟合出的 t 都落在 [0.5, 1]。3 个 g 都 ≤ 0.5，和 H1 一致，但样本太少，不作证据。
- **对 Kabegame 的要求**：要读 scene.json 根的 `version`，`< 5` 视同置 `0x200000`。

#### 5. 0xb 与 0xc 的对照【确】

- **系统色 HSV 同源**：0xb 在 `0x1401c780a` 读 `[rbp−0x10..−8]`，0xc 在 `0x1401cbee4` 读同一处，都是 `0x1401c5ac6` 存的那一份（同一栈帧，`FUN_1401c5490`）。
- **平移代码不共用**：0xb 在 `0x1401d1a71`–`0x1401d1dac`，0xc 在 `0x1401d1db1`–`0x1401d2126`，是两份内联拷贝，指令序列同构，算法相同。
- **写回不同**：0xb 在 `+0x38` 处写 A' 三个连续标量，在 `+0x3c` 处写 B'−A' 三个连续标量（`colorrandom` 的标量记录）。0xc 写 6 个独立偏移，每个 ×4。

---

## 未查完 / 未解决

- `tex+0x98`（当前图像）运行中的写入者没找到，多图像纹理在粒子里只采第 0 张是【推】。
- `TEXB` 返回 1 的含义（帧坐标 ×0.5）是【推】。
- 纹理标志 8（mip 少于 2 级时置）、0x2000000（SRV 维度）的完整用途。
- `FUN_14016c800` 的 `0x100000 << i` 宏名来源（采样器上的哪个列表）。
- ~~设备档位 `[ctx+0x1510]` 虚函数 `+0x40` 的含义~~：已解决，是 scene.json 根的 `version`（7.4）。`version` < 5 时颜色双重作用的实测见报告。
- `0xc` 记录已逐项核对（7.4【确】）：A = `startvalue`、B = `endvalue`，写 start 与 `B'−A'`，各 ×4。实测终点变黑是测试工程 `version 3` 置 `0x200000`、再乘 `colorn` 造成的，不是 0xc 的问题。区分实验见 7.4 第 4 小节。`0xd` / `0xe` 记录内的字段偏移仍没有逐项核对。
- `g_ViewRight` / `g_ViewUp` 在正交场景的具体值依赖相机矩阵，没读相机构造。
- `FUN_140184310`（`g_ViewForward`）没读。
- alpha-priority 搜索的盲区：变量移位、查表、整字比较、宽掩码、SIMD。
- 0x80000 搜索命中 `0x1400a6a52` 没细看。
- spritetrail 的 `length` / `maxlength` / `minlength` 缺省值没读（P4c）。

---

## 建议的确定性实验

### assets 候选纹理（只读头，`texscan_assets.txt`）

assets 里共 311 个 `.tex`：RGBA8888 191、R8 60、RG88 51、DXT5 9。**没有 DXT1、DXT3**，要用语料里的纹理。没有 NPOT 的帧表纹理。

| 用途 | 纹理（`materials/` 下） | 格式 / 标志 | 尺寸 | 帧表 |
|---|---|---|---|---|
| R8 帧表 | `particle/fog/fog1` | R8 / 0x4 | 1024² | TEXS0003，64 帧 128² |
| R8 帧表，4 帧 | `particle/nature/rain1` | R8 / 0x4 | 1024² | 4 帧 512² |
| R8 非方帧（TEXS0002） | `particle/lightning/lightning2` | R8 / 0x4 | 1024×512 | 32 帧 256×64，ratio 0.25 |
| R8 非方帧，高大于宽 | `particle/fire/fire3` | R8 / 0x4 | 1024² | TEXS0002，128 帧 64×128，ratio 2 |
| RG88 帧表 | `particle/smoke/smoke2` | RG88 / 0x4 | 1024² | 64 帧 128² |
| RG88 非整除帧 | `particle/explosion/explosion1` | RG88 / 0x6 | 1024×512 | 72 帧 85.33×73.14 |
| RG88 帧表带 0x80000 | `particle/water/splash_0` | RG88 / 0x80004 | 1024² | 64 帧 128² |
| RGBA 帧表，非方帧 | `particle/bubbles/bubble1` | RGBA / 0x4 | 512² | 30 帧 85.33×102.4，ratio 1.2 |
| DXT5 帧表，单行 | `particle/water/rain_drops_0` | DXT5 / 0x4 | 256² | 8 帧 32×128，ratio 4 |
| R8 非帧表 | `particle/misc/lambda` | R8 / 0x2 | 256² | — |
| R8 非帧表带 0x80000 | `particle/shape/circle_halo` | R8 / 0x80002 | 512² | — |
| RG88 非帧表 | `particle/smoke/smoke2normal` | RG88 / 0x0 | 1024² | — |
| RG88 非帧表带 0x80000 | `particle/swirl_0`、`particle/beam/beam_1`、`particle/light/light_shafts_0` | RG88 / 0x80002 | 256²、32×128、256×512 | — |
| NPOT（只填高） | `../effects/foliagesway/preview/materials/plant1` | RGBA / 0x2 | 512×1024，图像 512×875 | — |
| NPOT（填宽） | `../effects/xray/preview/materials/x-ray-1704855_960_720`；`../presets/fern/preview/materials/presets/fern1`（DXT5） | RGBA；DXT5 | 1024² / 598×720；512² / 299×512 | — |
| 法线图 | `particle/drop_normal`（RGBA）、`particle/water/rain_drops_sheet_normal`（RGBA，16 帧）、`particle/smoke/smoke2normal`（RG88） | | | |

`.tex` 头标志在文件偏移 0x16（u32），bit19 在偏移 0x18 字节的 bit3。

### 实验

1. **格式与 `TEX0FORMAT`**：同一工程放 `fog1`（R8）、`smoke2`（RG88）各一个粒子系统，renderer 只有 sprite。
   - RenderDoc 看 SRV 格式（应为 `R8_UNORM`、`R8G8_UNORM`）和着色器宏：`TEX0FORMAT=9/8`、`THICKFORMAT=1`、`SPRITESHEET=1`。
   - 再用 `lambda`（R8 非帧表）：应有 `TEX0FORMAT=9`、无 `THICKFORMAT`。
   - DXT1/DXT3 从语料取一张，看 `BC1_UNORM`/`BC2_UNORM`。
2. **alpha-priority**：复制 `swirl_0` 到工程，清掉偏移 0x18 的 bit3，两份各做一层图像和一个粒子系统。整帧逐像素比，预期相同。顺带确认采样器对象不同但描述相同（RenderDoc 里 sampler state 逐项相同）。
3. **帧表**：`fog1`，`lifetimerandom` 收成定值、`velocityrandom` 收成定值。
   - `sequencemultiplier` 1、2、3 各一个系统。读 `g_RenderVar1`（预期 `(0.125, 0.125, 64, 1)`）和顶点 C1：`.xyz` = 速度，`.w` = `rcpps(life)·age·seqmul` 原值（大于 1 不回绕）。
   - `animationmode: randomframe`：`.w` 整生不变，等于出生时的 `R`；宏 `SPRITESHEETBLEND=0`。
   - 系统 `flags: 2`（不是发射器 flags）：`SPRITESHEETBLEND=0`，帧逐格跳。
   - 非方帧：`lightning2`（`RV1 = (0.25, 0.125, 32, 0.25)`）、`bubble1`（`(0.16667, 0.2, 30, 1.2)`），核对四边形宽高比。
4. **NPOT**：
   - 粒子用 `x-ray-1704855_960_720`（非帧表）：`g_Texture0Resolution = (1024, 1024, 598, 720)`，四角 UV 是 0/1，画面应带出右侧和下方的填充区；宽高比按 1024/1024。
   - 帧表 NPOT 没有现成纹理：复制 `fog1`，只改头里的图像宽为 896（7×128）。预期 `SPRITESHEETBLENDNPOT=1`、`g_Texture0Resolution.z = 896`，每行只取 7 帧。只改图像高的副本应仍是 `SPRITESHEETBLENDNPOT=0`。
5. **折射快照时机**：`objects` 顺序为 图像 A → 粒子 P（`REFRACT 1`）→ 图像 B → 粒子 Q（`REFRACT 1`）。
   - RenderDoc 数 `CopyResource` 次数和位置：应在 P、Q 各自第一次绘制前各一次；P 的快照含 A 不含 B，Q 的快照含 A、P、B。
   - P 加一个同样折射的子系统：总共仍只拷一次。
   - 让 P 存活数为 0 的那一帧：不拷。
   - 带 `NORMALMAP`（槽 1 绑 `drop_normal`）与不带各一份；再用 `smoke2normal`（RG88）看 `TEX1FORMAT=8` 走 `gr` 解码。
   - 读 cbuffer 里的 `g_ViewRight`、`g_ViewUp`（预期 `(1,0,0)`、`(0,1,0)`），粒子 `flags: 4` 的一份应相同；`g_RefractAmount` 缺省 0.05。
6. **colorn**：都用 `lifetimerandom` 定值、单一出生点。
   - 无颜色模块 + `colorn "0 1 0"`：粒子颜色 = (0,1,0)（走 `0x200000`）。
   - `colorrandom` min = max = `"255 0 0"` + `colorn "0 1 0"`：系统色 (1,0,0)，色相 +1/3，预期 (0,1,0)。
   - `colorrandom` min `"255 0 0"`、max `"255 255 0"` + `colorn "0 0.5 1"`：系统色是中点 (1, 0.5, 0)，A、B 各自平移，按 7.3 公式算预期。
   - 两个 `colorrandom` 先红后绿：系统色取后一个（绿）。
   - `colorn` 与系统色每分量差 0.003 以内：无效果。
   - `color "0 255 0"`（0–255 写法）与 `colorn "0 1 0"` 结果相同。
   - 系统 `flags: 8`：`colorn` 无效。
   - 用户属性绑 `colorn`，运行中连改两次再改回：结果与直接设置相同（从基值重算）。
   - 父系统不生效、子系统带 `colorrandom` 和 `colorn`：子系统不生效。

### 最想用实测核对的读码结论

1. alpha-priority 中性（实验 2）。
2. `g_RenderVar1` 只取第 0 帧，`w` 的公式；`SPRITESHEETBLENDNPOT` 只比宽度（实验 3、4）。
3. C1 = (速度, frame 原值)，frac 在着色器；`randomframe` 帧固定且不混帧（实验 3）。
4. 快照在每个对象画之前、父子共用一次、存活为 0 不拷（实验 5）。
5. 系统颜色来自颜色模块（最后一个 initializer 的中点），HSV 平移公式，双精度 `fmod`，`%.5f` 舍入（实验 6）。
6. `TEX0FORMAT` 只对格式 8–11（或非 `screen` 朝向）写（实验 1）。
