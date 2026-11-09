> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。全部没有实测，P5 步骤 0 实测核对后以报告为准。

# WPE 2.8.42 P5 静态网格（`.mdl`）与深度静态逆向

**概括**
- **一个加载函数：** 所有版本的 mdl 都走 `FUN_140261880(data, size, out)`。调用者只有两个：模型资源 `FUN_1401d5a40`（模型对象）和图像层 `0x1401fbedd`（puppet），分支点在调用者，容器格式完全共用。
- **版本门槛：** 网格标志 v≥4，网格自带顶点格式 v≥15，网格包围盒 v≥17，两个可选块 v≥21，记录表 v≥23，尾部段 v≥13。v<15 的顶点格式取文件头那个 u32。语料 139 个 mdl（v4/13/14/16/17/19/21/23）用这套规则全部恰好读到文件末尾。
- **顶点格式：** 26 位掩码，每位一个属性（`a_Position`、`a_Normal`、`a_Tangent4`、`a_TexCoord*`、`a_BlendIndices`、`a_BlendWeights`、`a_Color` 等），stride 是置位属性大小之和，按固定表序交错存放。除 `a_BlendIndices`（u32×4）外全是 float。
- **索引：** 网格标志 bit0 置位是 u32，否则 u16；图元是三角形列表。语料只有 3706286085 的 FBX3 有两个网格用 u32。
- **材质：** 文件头第 2 个 u32 是「皮肤数」N，每个网格存 N 个材质路径，对象键 `skin` 选第 min(skin, N−1) 个。每个网格一个材质。有骨骼时才加 `SKINNING`、`BONECOUNT`、`MORPHING`、`MORPHING_NORMALS` 四个 COMBO，静态网格没有任何引擎追加的 COMBO。
- **模型对象：** 不读 `color`、`alpha`、`brightness`，绘制时把 `g_Color` / `g_Alpha` 强制写成 1。世界矩阵和图像层同一个函数。`castshadow` 对模型缺省为开，`reflected` 缺省为真，`locktransforms` 在 exe 里不存在。
- **深度是反向 Z：** 主目标（交换链后备缓冲）带 D32_FLOAT 深度，每帧清 0.0，比较函数 GREATER。透视与正交投影都按近 1 远 0 写（见相机那份）。
- **材质缺键的缺省是「开」：** 材质 pass 字节缺省为 0，0 的含义是 `depthtest` enabled、`depthwrite` enabled、`cullmode` normal。默认工程的 3D 模型材质基本都不写这三个键。现在 `bundle.ts` 把缺键当 disabled / nocull，和 WPE 相反。
- **混合压过深度写：** translucent / additive 的 pass 一律不写深度，不管 `depthwrite` 写了什么。`depthtest: disabled` 也连带不写深度。neon_sunset 的两个 translucent 模型写着 `depthwrite: enabled`，实际只测不写。
- **剔除：** 光栅状态 `FrontCounterClockwise = TRUE`、`CullMode = BACK`，即 NDC（y 向上）里逆时针是正面。语料网格的绕序都与存储的法线一致（右手、逆时针朝外），WebGPU 用 `frontFace: "ccw"`、`cullMode: "back"`。`alignmentfliph` 水平镜像时整帧改剔正面。
- **合成 RT 和 effect fbo 没有深度：** 这些 RT 的深度格式是 0x1b，绑定时不挂 DSV，里面画的 pass 深度状态不起作用。深度格式 0x1a 的 RT 借用后备缓冲的深度。
- **绘制顺序：** 默认按 `objects` 数组顺序，模型内部再把不透明网格排到半透明网格前面（不稳定排序）。只有透视场景开了 `transparentsorting` 才分两遍：先按数组顺序画所有非半透明对象，再把半透明对象按「局部 origin · 相机前向」从大到小画，fullscreen / projectlayer 图像排最后。
- **视锥剔除：** 模型每帧用 mdl 包围盒变换后的外接球做剔除。v<17 的 mdl 没有包围盒，退回 ±131072 的盒子，等于不剔。
- **与旧报告冲突：** ① p2 把渲染标志 0x800 记成「投影 Y 翻转」，实为 general `alignmentfliph`，取反投影第 0 行，是水平镜像（相机那份结论相同）。② p2 的深度格式表把 0x1a 记成「无深度」，实为「借用后备缓冲深度」，0x1b 才是不挂深度。③ hdr-macro-REPORT 建议不定义 `REVERSEDEPTH`，理由是「我们的深度不是反向的」。P5 若照 WPE 用反向 Z，这条要改成定义为 1。

**元数据**
- 目标 `wallpaper64.exe`（2.8.42），SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对前缀 `40e2ce021e935232` 一致。未运行、未附加 WPE，没写 Steam 目录，样本只读。
- 方法：REA（Ghidra 12.1.4），从 `ignore/p4/rea/p4b-mod/` 快照复制到 `ignore/p5/rea/mesh/wallpaper64-2.8.42-p5-mesh.rea-snapshot` 后打开副本；`ignore/p4/rea/wp.asm` 按地址读汇编；Python 解析样本与语料。
- 工作文件在 `ignore/p5/rea/mesh/`：
  - 反编译：`mdlload_140261880.c`（mdl 加载）、`modelload_14021ad10.c`（模型对象加载）、`bindmat_140155fc0.c`（材质绑定）。
  - 汇编摘录：`modelmat_140224c70.asm`、`modeldraw_1402222a0.asm`、`scenedraw_14018aac0.asm`、`tsort_1401865c0.asm`、`meshgpu_1401d7760.asm`、`dev_140099050.asm`（D3D11 状态对象）、`devstate_14009af50.asm`、`devapply_140099f80.asm`、`resetstate_14017eae0.asm`、`rt_1400d2c60.asm`、`proj_14009a360.asm`、`uni_1400d8300.asm`、`basetable_1401e0530.asm`、`bindmat_140155fc0.asm`。
  - 脚本：`mdl.py`（解析器，照加载函数写）、`scan.py` / `scan2.py`（语料 mdl 汇总，输出 `scan.txt`）、`objscan.py`（模型对象键，`objscan.txt`）、`matscan.py`（模型材质状态，`matscan.txt`）、`misskey.py`（缺深度键的材质）、`wind.py`（相机下绕序）、`nrm.py`（几何法线与顶点法线）、`tbl.py` / `tbl2.py` / `tbl3.py`（顶点格式三张表）、`jt.py`（uniform 跳转表）、`order.py`，以及从 p4 拷来改过路径的 `pe.py`、`fn.py`、`d.py`、`xr.py`、`vtd.py`、`qref.py`、`findstr.py`、`rawfind.py`、`s.py`。笔记 `notes.md`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过，范围外没排除；【样本】样本解析得到。

**命名**
- `R`：场景渲染器；`ctx` = `R+0x10`（对象代码里的 `obj+0xc8`）。`ctx+0x118` = `R+0x128` 是渲染标志字。
- `dev`：D3D11 设备封装（`ctx+0x1518` = `R+0x1528`，虚表 `0x140485b90`）。
- `mdl`：加载结果（模型资源 `+0x10`，即 `FUN_140261880` 的 `out`）。`mesh`：`mdl+0x10` 起的网格记录，每条 200 字节。
- `obj`：模型对象（800 字节，虚表 `0x140491338`）。`M`：模型矩阵栈顶 `*(ctx+0x30)`。
- 材质 pass 字段（材质对象内）：`+0x1f0` blending、`+0x1f1` alphawriting、`+0x1f2` depthtest、`+0x1f3` depthwrite、`+0x1f4` cullmode。

---

## 1. mdl 容器

### 1.1 读取原语【确】
| 函数 | 读法 |
|---|---|
| `FUN_14009c500` | 以 `\0` 结尾的字符串，越界返回空串 |
| `FUN_14009c560` / `FUN_14009c590` | u32 / f32，越界返回 0 |
| `FUN_14009c5c0` | u32 字节数 + 字节块，返回块指针，字节数写到出参 |
| `FUN_1402616e0` / `FUN_140261680` / `FUN_1402616b0` | u8 / u16 / u64 |
| `FUN_140261770` | 段头：读 u32，把读取上限设成「文件起点 + min(u32, 文件长)」，即**段末的绝对偏移** |

全部小端，没有对齐填充。

### 1.2 文件头【确】
| 顺序 | 类型 | 内容 |
|---|---|---|
| 1 | 字符串 | 魔数，如 `MDLV0014`。版本 = `atoi(魔数 + 4)`，不比较前 4 个字符 |
| 2 | u32 | v<15 时是所有网格共用的顶点格式；v≥15 读了不用（语料里与网格格式相同）【样本】 |
| 3 | u32 | 皮肤数 N，存 `mdl+0x8` |
| 4 | u32 | 网格数 |

exe 里只有 `MDLV0023` 这一个 MDLV 串，用在编辑器把 json 转 mdl 的写出函数 `FUN_1402785a0`，说明当前写出版本是 23【推】。

### 1.3 网格记录【确】
| 顺序 | 版本 | 类型 | 内容 | 存到 mesh |
|---|---|---|---|---|
| 1 | 全部 | N×字符串 | 每个皮肤一个材质 json 路径 | `+0x00` 向量 |
| 2 | ≥4 | u32 | 网格标志 | `+0x18` |
| 3 | 标志 bit1 | u32 | 含义未读【未知】 | `+0x1c` |
| 4 | ≥17 | 6×f32 | 包围盒 min xyz、max xyz | `+0x20..+0x34` |
| 5 | ≥15 | u32 | 顶点格式（<15 用文件头的） | `+0x38` |
| — | 全部 | — | stride，按 1.4 求和 | `+0x3c` |
| 6 | 全部 | u32 + 字节 | 顶点块 | 字节数 `+0x40`，指针 `+0x48` |
| 7 | 全部 | u32 + 字节 | 索引块 | 字节数 `+0x50`，指针 `+0x58` |
| 8 | ≥21 | u8，为真时 u32 + 字节块 | 可选块 1 | `+0x88` |
| 9 | ≥21 | u8，为真时字节块 | 可选块 2，按 16 字节一项计数 | 数 `+0xa0`，指针 `+0xa8` |
| 10 | ≥23 | u32 计数，每项：u64、字符串、u32 标志、u32 k + k×u32、u32 k2 + k2×u32 | 记录表，两组 u32 都必须小于可选块 2 的项数，否则 `int 0x29` | `+0xb0` 向量，每项 0x50 |

- 网格标志的位：bit0 u32 索引；bit1 多一个 u32；bit10 `MORPHING_NORMALS`，bit10–13 决定 MDMP 段里每个变形目标多读哪些块【确】。语料还出现 bit2（7 个 puppet）、bit12（5 个 puppet，都带 MDMP），含义没查【未知】。
- 可选块 1、2 和记录表在语料里只出现在 puppet mdl（可选块 2 每项 16 字节；记录表的名字形如 `masks/clipping_mask_<hash>`），模型对象用的 mdl 里都是空的【样本】。归 W6。
- v≥23 有记录表时，加载末尾还会在记录之间按名字查重、建链（`mesh+0x48` 记下一个），细节没读【未知】。

### 1.4 顶点格式位表【确】
三张并行表：掩码 `0x140484a20`、字节数 `0x1404849b0`、属性名 `0x140484a90`，另有 D3D11 输入元素描述 `0x140482af0`（每项 32 字节）和着色器属性记录 `0x140482fa0`（每项 16 字节：序号、分量类型、语义、语义号）。顶点内按下表**表序**交错，偏移是前面置位属性大小的累加（`FUN_1400d81b8` 建输入布局时这样算 `AlignedByteOffset`）。

| 表序 | 掩码 | 字节 | 属性名 | 语义 | DXGI |
|---|---|---|---|---|---|
| 0 | 0x1 | 12 | `a_Position` | POSITION0 | R32G32B32_FLOAT |
| 1 | 0x10000 | 16 | `a_PositionVec4` | POSITION0 | R32G32B32A32_FLOAT |
| 2 | 0x2000000 | 12 | `a_PositionC1` | POSITION1 | R32G32B32_FLOAT |
| 3 | 0x2 | 12 | `a_Normal` | NORMAL0 | R32G32B32_FLOAT |
| 4 | 0x4 | 16 | `a_Tangent4` | TANGENT0 | R32G32B32A32_FLOAT |
| 5 | 0x800000 | 16 | `a_BlendIndices` | BLENDINDICES0 | R32G32B32A32_UINT |
| 6 | 0x1000000 | 16 | `a_BlendWeights` | BLENDWEIGHT0 | R32G32B32A32_FLOAT |
| 7 / 8 / 9 | 0x8 / 0x10 / 0x20 | 8 / 12 / 16 | `a_TexCoord` / `a_TexCoordVec3` / `a_TexCoordVec4` | TEXCOORD0 | RG / RGB / RGBA32F |
| 10–12 | 0x40 / 0x80 / 0x100 | 8 / 12 / 16 | `a_TexCoordC1` / `Vec3C1` / `Vec4C1` | TEXCOORD1 | 同上 |
| 13–15 | 0x200 / 0x400 / 0x800 | 同上 | `…C2` | TEXCOORD2 | 同上 |
| 16–18 | 0x1000 / 0x2000 / 0x4000 | 同上 | `…C3` | TEXCOORD3 | 同上 |
| 19–21 | 0x20000 / 0x40000 / 0x80000 | 同上 | `…C4` | TEXCOORD4 | 同上 |
| 22–24 | 0x100000 / 0x200000 / 0x400000 | 同上 | `…C5` | TEXCOORD5 | 同上 |
| 25 | 0x8000 | 16 | `a_Color` | COLOR0 | R32G32B32A32_FLOAT |

- stride 的计算在加载函数里是展开的 24 项加循环补两项（表序 24、25），与 `FUN_1400ea5b0` 的 stride 函数结果相同【确】。
- 着色器翻译时，`FUN_1400f4460` 在源码里按整词找这 26 个名字，`FUN_1400f5110` 给它们写 HLSL 语义（`a_Xxx : SEMANTIC<n>`）。输入布局按网格格式建，按语义和着色器配对【确】。着色器声明了网格没有的属性时 `CreateInputLayout` 会失败，WPE 怎么处理没读【未知】。
- 同一语义号的三种宽度（如 `a_TexCoord` 与 `a_TexCoordVec4`）共用 TEXCOORD0。着色器读的分量少于数据时 D3D 截断，多于数据时补 (0, 0, 0, 1)【推，D3D 规则】。arsenal 的格式 0x27 带 `a_TexCoordVec4`，`generic` 着色器的 lightmap UV 在 zw【样本】。

### 1.5 索引与图元【确】
- 顶点数 = 顶点字节数 / stride（整除），索引数 = 索引字节数 /（标志 bit0 ? 4 : 2）（`FUN_1401d7760`）。
- 索引指针为空时调设备 `+0x48` 建非索引网格，否则调 `+0x40`（带 32 位标志）建索引网格。字节数为 0 时指针不为空（读取原语返回当前位置），仍走索引分支【推】。
- 设备建网格时在网格对象 `+0x30` 写 4（`0x14009a8fa`），即 `D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST`【推：值确认，传给 `IASetPrimitiveTopology` 没跟】。语料所有索引数都是 3 的倍数【样本】。

### 1.6 包围盒【确】
- 加载末尾 `FUN_1402617c0` 把所有网格的包围盒取并集，写到 `mdl+0x1b8`（min）、`mdl+0x1c4`（max）。并集不满足 `max.x > min.x` 时（v<17 没有包围盒，或 puppet 写的全 0）改成 ±131072（`0xc8000000` / `0x48000000`）。
- 模型对象把它拷到 `obj+0x2f8`（min）、`obj+0x304`（max），只用于视锥剔除（4.4）。

### 1.7 尾部段【确】
- v>12 时，网格之后是段列表：每段 = 字符串标签 + u32 段末绝对偏移 + 数据。处理完一段，下一个标签从段末偏移处读，所以不认识的段被整段跳过。读到空串（或越界）结束。没有段的 v≥13 文件结尾就是一个 `\0`。v4 没有段，网格读完即文件末尾【样本】。
- 识别：`MDLS`、`MDLA` 只比较前 4 个字符，版本号 `atoi(标签 + 4)`；`MDAT0001`、`MDMP0001` 比较 8 个字符；`MDLE0002` 全串比较。
| 段 | 内容 | 存到 |
|---|---|---|
| `MDLS` 骨骼 | u32 骨骼数（>128 触发 `int 0x29`）；每骨骼 0xf0 字节：名字、u32（→ `+0x64`，0 / 1）、u32 父骨骼（→ `+0x60`，0xFFFFFFFF 为根）、局部 4×4（`FUN_1400d3ef0`，样本里是 u32 长度 64 + 64 字节）、一段 JSON 串（`FUN_140265c30` 解析）。版本 ≥2 还有 u16 计数的 0x80 字节记录与一组可选矩阵 | `mdl+0x30` 向量等 |
| `MDLA` 动画 | 动画层数据 | `mdl+0x60`… |
| `MDAT` 挂点 | u16 计数；每项 u16、名字、64 字节矩阵 | `mdl+0xa8` |
| `MDMP` 变形目标 | 每网格 u16 计数；非 0 时 f32 → `mesh+0x60`、u32 → `mesh+0x64`；每目标 u64、名字、位置差块（n×6 字节），网格标志 bit10 / bit11 / bit12 / bit13 时依次多读法线块、切线块、n×2 字节块、u32 + u32 + f32 + f32 | `mesh+0x68` 向量 |
| `MDLE` | 每骨骼一个 64 字节矩阵 | `mdl+0x48` 起 |

- **只有 MDLS 没有 MDLA：** 模型对象加载时只要骨骼向量非空，就建骨骼运行时（`obj+0x2d8`，0xb8 字节），按父链算绑定姿势世界矩阵再求逆（`FUN_14005f730`）。网格格式含 `a_BlendIndices` 时材质加 `SKINNING=1`，`BONECOUNT` = max(16, 骨骼数) 向上取 2 的幂、上限 128。每帧更新和绘制都会上传骨骼矩阵（每骨骼 0x30 字节）【确】。没有动画层时矩阵停在绑定姿势、网格按原样显示【推】。语料里没有只带 MDLS 的模型对象 mdl（只有 MDLS + MDLE 的 puppet 有两个，`3830665420` 的 `头发左`、`脖子`）【样本】。

### 1.8 样本解析【样本】
`mdl.py` 照 1.2–1.7 写，所有文件都恰好读到末尾（有段的读到最后一个空标签）。

| 样本 | 版本 | 文件头格式 | 皮肤 | 网格 | 网格格式 / stride | 顶点 | 索引 | 网格标志 | 段 |
|---|---|---|---|---|---|---|---|---|---|
| retro `bgfade` | 14 | 0x9 | 1 | 1 | 0x9 / 20 | 4 | 6 | 0 | 无（末尾 `\0`） |
| neon_sunset `neonsun` | 14 | 0xf | 1 | 1 | 0xf / 48 | 4 | 6 | 0 | 无 |
| neon_sunset `neongrid` | 14 | 0xf | 1 | 1 | 0xf / 48 | 2601 | 15000 | 0 | 无 |
| dna_fragment `bg` / `dna` | 4 | 0xb | 1 | 1 | 0xb / 32 | 4 / 2604 | 6 / 11472 | 0 | v4 无段区 |
| techno `glow` | 23 | 0x9 | 1 | 1 | 0x9 / 20（带包围盒） | 4 | 6 | 0 | 无 |
| techno `orbitsmall` | 23 | 0x9 | 1 | 4 | 0x9 / 20 | 66–99 | 192–384 | 0 | 无 |
| techno `sphere` | 14 | 0xb | 1 | 1 | 0xb / 32 | 417 | 2400 | 0 | 无 |
| demon_core `core` / `backgroundsphere` | 14 | 0xb | 1 | 1 | 0xb / 32 | 970 / 1087 | 1440 / 5952 | 0 | 无 |
| arsenal `pistols` | 14 | 0x27 | 1 | 6 | 0x27 / 56 | 8–4698 | 12–11292 | 0 | 无 |
| audiophile `grid` | 4 | 0x9 | **2** | 1 | 0x9 / 20 | 4 | 6 | 0 | — |
| 编辑器相机 `assets/models/editor/camera/camera.mdl` | 17 | 0xf | 1 | 1 | 0xf / 48 | 692 | 1671 | 0 | 无 |
| 3706286085 `BoostModel` | 23 | 0x180000f | 1 | 4 | 0x180000f / 80 | 164–380 | 918–1728 | 0x400 | `MDLS0004`（3 骨骼，91052–91565）、`MDLA0006`、`MDMP0001` |
| 3706286085 `FBX3`（68 MB） | 23 | 0x180000f | 1 | 43 | 同上 | — | 两个网格 u32 索引，最大 75061 / 106196 | 0 / 1 | `MDLS0004`（2 骨骼）、`MDLA0006` |

- retro `bgfade` 逐字节：`0x00` 魔数 9 字节，`0x09` 格式 9，`0x0d` 皮肤 1，`0x11` 网格 1，`0x15` 材质串（29 字节），`0x32` 标志 0，`0x36` 顶点字节 80，`0x3a` 4 个顶点，`0x8a` 索引字节 12，`0x8e` 索引 0 1 2 0 2 3，`0x9a` 空标签，共 155 字节。
- BoostModel 的骨骼：`RootNode`（父 0xFFFFFFFF）、`Boost2`、`Boost1`（父 0），局部矩阵块都是 64 字节，JSON 串为空。
- 语料汇总（`scan.txt`）：139 个 mdl，版本 4×8、13×1、14×15、16×10、19×22、21×9、23×74。非 puppet 的模型对象 mdl 只有 v4、v14、v23，格式 0x9、0xb、0xf、0x27、0x180000f。网格标志：0×191、bit2×7、bit12×5、bit10×4、bit0×2、bit1×1。段：`MDLS0001–0004`、`MDLA0001–0006`、`MDAT0001`、`MDMP0001`、`MDLE0002`。

### 1.9 GPU 网格（`FUN_1401d7760`）【确】
- 每个网格建一个设备网格对象，存进模型资源 `+0x238` 的向量（每项 0x20 字节：`[0]` 网格对象，`[3]` 变形纹理）。
- 有骨骼且网格有变形目标时，把差值打包成一张近似正方形的纹理（名字 `"morph"`，格式 0x13 = `R16G16B16A16_SNORM`），宽高取 ceil(sqrt(·))。归 W6 / P8。

### 对实现的含义
- 解析器照 1.2–1.7 写一个函数即可，不需要分版本的结构体。P5 只需支持「无段或跳过所有段」，可选块和记录表读过即丢。
- 顶点属性按 1.4 的表序算偏移，直接生成 WebGPU `vertexBuffers[0].attributes`，`shaderLocation` 按着色器里实际声明的 `a_*` 名字分配。`a_BlendIndices` 用 `uint32x4`，其余 `float32xN`。WebGPU 同样允许格式分量少于着色器类型（补 0, 0, 0, 1）。
- 着色器声明了网格缺的属性：先报 `mdl:missing-attribute:<名>` 退回，等实测 WPE 的行为。
- 索引 bit0 → `uint32`，否则 `uint16`；三角形列表。
- 带 MDLS 的 mdl 归 P8 / W6，P5 可以按「有 MDLS / MDLA / MDMP 段」报 `mdl:skeleton` 等键退回。

### 建议实测
- 工程 `p5-mdl-layout`（透视，固定相机，无路径）：用 Python 生成 v23 mdl，一个网格、格式 0x8009（位置 + uv + 顶点色），三个顶点色分别纯红、纯绿、纯蓝，材质着色器直接输出 `a_Color`。RenderDoc 看输入布局各元素的偏移（应为 0 / 12 / 20）与格式，画面三角形三个角颜色对上表序。
- 同工程换格式 0x27（`a_TexCoordVec4`）且着色器只声明 `a_TexCoord`：确认读到 xy；再让着色器声明 `a_Normal` 而网格没有法线：看网格画不画、日志有没有报错。
- `p5-mdl-u32`：一个网格标志 bit0、索引全用 u32、顶点数 70000：画面完整。再把 bit0 清掉但数据不变，看画面错乱成什么样，确认标志就是索引宽度开关。

---

## 2. 模型对象

### 2.1 创建与派发【确】
- `FUN_14018ff60` 先查 `model` 键：值是字符串、数字或对象（jsoncpp 类型 1–4、7）就建模型对象（800 字节，虚表 `0x140491338`），构造时 `obj+0x120 |= 0x800`。`null` 不算。
- 虚函数：`+0x40` 加载 `FUN_14021ad10`，`+0x48` 每帧更新 `FUN_14021c480`，`+0x50` 绘制 `FUN_1402222a0`，`+0x80` 世界矩阵沿用基类 `FUN_1401850a0`。
- 加载：基类属性 `FUN_1401de470`；`model` 为字符串时经资源管理器 `ctx+0x1a60` 取模型资源（`FUN_1401d5a40`，按路径 FNV-1a 哈希缓存、引用计数 `+0x230`）存 `obj+0x2f0`，`obj+0x2e8 = 资源+0x10`；为数字时按 id 取脚本创建的模型数据（`createModelData`）。然后 `FUN_140224c70` 建材质与绘制记录，有骨骼时建骨骼运行时并读 `animationlayers`。

### 2.2 读取的键【确，有界：模型属性表 `FUN_140227470`、基类表 `FUN_1401e0530`、`FUN_14018ff60`、`FUN_140224c70`】
| 键 | 读法 | 作用 |
|---|---|---|
| `origin` / `scale` / `angles` / `parent` | 基类，`+0x128` / `+0x134` / `+0x140` | 同图像层 |
| `visible` | 模型表，`+0x120` bit0，可绑用户属性 | 不可见不更新不画 |
| `perspective` | 模型表，`+0x120` bit7 | 绘制时临时换透视投影（`FUN_1401e5b60`），归相机那份 |
| `castshadow` | 模型表，`+0x120` bit11，构造缺省置位 | 阴影 pass 的投射者（第 5 节） |
| `rootmotion` | 模型表，`+0x310` | 动画，归 P8 |
| `skin` | 直接读对象 json（`obj+0x1b0`），整数才取 | 选材质（2.4） |
| `reflected` | 工厂里读，布尔且为 false 时排除 | 反射 pass 名单（第 5 节） |
| `solid` / `disablepropagation` | 基类 `+0x120` bit13 / bit14 | 渲染侧没有读取点（p2 I6） |
| `parallaxDepth` / `sortorder` / `name` | 基类 `+0x170` / `+0x124` / `+0x1d8` | 同其他对象 |
| `animationlayers` | 有骨骼时读 | P8 |
| `color` / `alpha` / `brightness` | **不读** | 2.5 |
| `locktransforms` | exe 里按 ASCII、UTF-16 都搜不到 | 只有编辑器用 |

语料模型对象（`objscan.txt`，46 个）用到的键：`angles`、`origin`、`scale`、`parent`、`visible`（含用户属性和脚本）、`castshadow`（全是 false，10 个）、`solid`、`disablepropagation`（全 false）、`parallaxDepth`（全 1）、`reflected`（全 true，3 个）、`skin`（1 个，audiophile grid 取 1）、`locktransforms`、`animationlayers`（5 个，3706286085）【样本】。

### 2.3 世界矩阵与模型矩阵【确】
- 世界矩阵就是基类 `FUN_1401850a0`：`W = W_parent · T · Rz·Ry·Rx · S`，`angles` 弧度（rea-p4a A1）。
- 绘制时 `M = 栈顶 · W`（`FUN_14005ecb0`，压栈后写 `*(ctx+0x30)`），画完弹栈。
- `g_ModelMatrix`（9）取 `M`，`g_ModelMatrixInverse`（10）是 `M` 的逆（`FUN_14005f730`），写进常量缓冲时都转置存放（`FUN_1400d8300`）。
- **`g_NormalModelMatrix`（0xe）不是逆转置：** 取 `M` 的 3×3，把三个局部轴（内存里的三行）各自归一化，按与 `g_ModelMatrix` 相同的转置方式写成 3 个 vec4 槽（`0x1400d8840`）。归一化用 `0x5f375a86` 快速倒数平方根加一次牛顿迭代，有约 0.2% 的误差【推：误差量级】。非均匀缩放下与逆转置不同。

### 2.4 材质、皮肤与 COMBO（`FUN_140224c70`）【确】
- 每个网格一个材质：路径 = 网格材质表第 min(`skin`, N−1) 项（无符号比较，负数也落到最后一项），缺 `skin` 取 0。
- 无骨骼：`FUN_14014ff70(ctx+0x1630, 路径)` 直接加载，**不追加任何 COMBO**。
- 有骨骼：`FUN_140150110(…, 路径, combos)`，combos = `SKINNING`（格式含 0x800000 时为 1，否则 0）、`BONECOUNT`、`MORPHING`（网格有变形目标）、`MORPHING_NORMALS`（网格标志 bit10）。
- 图像层专有的引擎 COMBO（`LIGHTING`、`REFLECTION` 等，`FUN_140206b3a` / `FUN_140209563`）不进模型路径。全局引擎宏（`SCENE_ORTHO`、`HDR`、`FOG_*`、`REVERSEDEPTH`，`FUN_1401a5c40`）照常【确】。
- 加载每个材质后：
  - 函数开头 `obj+0x120` 先清 0x400、0x8，置 0x100（半透明）。之后任一网格的材质 blending 为 normal 或 alphatocoverage，就清 0x100、置 0x400（不透明）。所以只有「所有网格都是 translucent / additive」的模型才算半透明对象，进 `transparentsorting` 的半透明名单（4.2）。
  - 材质标志 `+0x1fc` bit0 → `obj+0x120 |= 8`，所有网格的 `+0x1fc` 取或后 bit3 → `obj+0x120` bit6。两位含义未读【未知】。
- 绘制记录（`obj+0x2c0`，每项 0x18）：GPU 网格、材质、变形纹理。最后用比较器 `0x14021a620`（a 不透明且 b 半透明时 a 在前）排序，`FUN_140228440` 是 introsort，**不稳定**【推：按函数形态与参数】。

### 2.5 着色器属性与 uniform【确】
- 属性名对 mdl 数据：见 1.4。
- 模型绘制在画网格之前把 `ctx+0x120..+0x12c` 全写 1.0，即 `g_Alpha = 1`、`g_Color = (1, 1, 1)`、`g_Color4 = (1, 1, 1, 1)`（uniform 来源见 p2 I4）。对象的 `color`、`alpha`、`brightness` 对模型不起作用。
- 矩阵：`g_ModelMatrix`、`g_ModelMatrixInverse`、`g_NormalModelMatrix` 按 2.3，`g_ModelViewProjectionMatrix`、`g_ViewProjectionMatrix`、`g_EyePosition` 与其他对象共用（相机那份）。
- 骨骼：`g_Bones[BONECOUNT]` 每项 0x30 字节（mat4x3），常量缓冲大小 = BONECOUNT × 0x30；`ctx+0x12e8` = 骨骼数。
- 变形：每帧从骨骼运行时的激活位图里取目标，最多 11 个，按权重降序写 `ctx+0x1334`（偏移 = 序号 × 顶点数）与 `ctx+0x1360`（权重，余下的槽写 0），`ctx+0x12ea` = 个数，`ctx+0x1330` = `mesh+0x60`。对应 `g_MorphOffsets` / `g_MorphWeights`【推：对应关系按名字】。
- `g_AltModelMatrix`（0xf）取 `ctx+0xa70`，模型路径没写它【确，有界：`FUN_1402222a0`】。

### 2.6 每帧更新与绘制（`FUN_14021c480`、`FUN_1402222a0`）【确】
- 更新：骨骼运行时为空（静态网格）、或对象不可见时直接返回。静态网格每帧没有任何更新工作。
- 绘制顺序：
  1. `ctx+0x11c` bit0（场景加载时总置位，`0x1401872d5`）时做视锥剔除（4.4），剔掉就返回。
  2. `perspective`（bit7）时复制并压投影、视图栈，调 `FUN_1401e5b60`。
  3. 写 `g_Color` / `g_Alpha` = 1，压模型矩阵 `M = 栈顶 · W`。
  4. 有骨骼时上传骨骼矩阵。
  5. 逐绘制记录：阴影 pass（`ctx+0x12eb == 0`）只画不透明材质的网格；普通 pass（`ctx+0x12eb == 2`）全画。绑材质 `FUN_140155fc0` → 网格对象虚函数 `+8` 画 → 解绑 `FUN_140157430`。
  6. 弹栈。

### 2.7 正交场景与单位【样本】
- 正交场景里模型和图像层用同一套 V、P，单位是场景像素。3354366708 的两个模型 `scale` 700–814、`origin` 为几百像素，材质 `depthtest` / `depthwrite` enabled、`cullmode` normal。
- retro 的 `bgfade.mdl` 是 x = −0.68 平面上的 ±0.5 方片，对象变换为单位阵。项目着色器 `bg.vert` 不用任何矩阵，直接输出 `gl_Position = (a_TexCoord·2−1, 0.5, 1)`（HLSL 下再偏半个纹素），所以它是一张全屏背景，几何尺寸无关紧要。它排在 `objects` 第一个，材质 translucent、缺 `depthtest`（= 开）、`depthwrite: disabled`、`nocull`。深度 0.5 大于清屏值 0，能通过 GREATER。
- 透视场景的模型尺寸在 1 量级（core 半径 1、backgroundsphere 7.6、neongrid 2×2），单位就是 3D 世界单位。

### 对实现的含义
- 模型对象只需 `model`、变换、`visible`、`skin`，P5 先不做 `castshadow`、`reflected`、`perspective`。`color` / `alpha` / `brightness` 在模型上要忽略，`g_Color4` 固定 (1, 1, 1, 1)。
- 世界矩阵、矩阵栈直接复用图像层与粒子的代码；`g_NormalModelMatrix` 按「3×3 各轴归一化」实现，不要用逆转置。
- 静态网格的材质编译只加全局引擎宏，和图像层的材质编译共用一条路径，不需要模型专用 COMBO。
- 一个模型对象展开成多次绘制，按 2.4 的比较器排（不透明在前）；为了确定性可以用稳定排序，等实测看 WPE 的不稳定排序是否改变同类网格的顺序。
- 能力键：`object:model` 拆成 `mdl:skeleton`、`mdl:morph`、`object:castshadow`（仅值为 true 时）、`object:reflected`（场景实际有反射 pass 时）、`object:perspective`、`object:skin`（如果不想马上做）。

### 建议实测
- 工程 `p5-model-color`：透视，一个方片模型，着色器输出 `g_Color4`。对象写 `color "1 0 0"`、`alpha 0.5`、`brightness 3`，HDR 开关各一份。读码预测画面纯白、不透明。
- `p5-skin`：audiophile 的 grid（2 皮肤）复制，`skin` 取 0、1、5、−1，预测分别用 grid、grid2、grid2、grid2。
- `p5-normal-matrix`：模型 `scale "1 4 1"`、`angles "0 0 0.5"`，着色器输出 `mul(a_Normal, g_NormalModelMatrix)` 的编码颜色；RenderDoc 读常量缓冲里 `g_NormalModelMatrix`，与「各轴归一化」和「逆转置」两种算法比。

---

## 3. 深度与剔除

### 3.1 哪些目标有深度【确】
RT 构造 `FUN_1400d2c60` 的第 6、7 个参数是颜色、深度格式。深度格式 0x1a 时 `rt+0x58 = 1`。绑定 `FUN_1400d3920` 调 `OMSetRenderTargets`：`rt+0x58` 为 1 时挂**设备默认目标（后备缓冲）的 DSV**，否则挂自己的 DSV（0x1b 时为空）。

| 目标 | 深度格式 | 实际深度 |
|---|---|---|
| 后备缓冲（`FUN_140099050` 建，存 `dev内部+0x20`） | 0x18 | **D32_FLOAT** |
| `_rt_FullFrameBufferMultiSampled`（开 MSAA 时场景画进它） | 0x18 | D32_FLOAT，多重采样 |
| `_rt_FullFrameBuffer`、`_rt_Reflection` | `0x16 + 4·(R 标志 & 1)` | D16_UNORM；R 标志 bit0 置位时 0x1a，借用后备缓冲深度 |
| 图像层合成 RT（`FUN_1401ea500` `0x1401ea86b`）、effect fbo（`0x1401eb9f6`）、泛光链、阴影辅助等 | 0x1b | 不挂深度 |

- 场景在无 MSAA 时直接画进后备缓冲（p2 A4），所以主绘制总有 D32F 深度。
- 不挂 DSV 时 D3D11 不做深度测试也不写深度，pass 上的深度状态不起作用【推，D3D 规则】。
- 清屏 `FUN_14009b160(dev, 清颜色, 清深度)`：清深度时挑当前 RT 的 DSV，当前 RT 不带深度时清后备缓冲的 DSV，深度值取 `dev+0x20`，只清深度不清模板。

### 3.2 反向 Z【确】
- 深度模板状态在设备初始化 `FUN_140099050` 一次建好，比较函数都是 5（`D3D11_COMPARISON_GREATER`），模板关闭。
- `dev+0x20`（清屏深度）构造时为 1.0，`dev` 虚函数 `+0x110`（`FUN_14009b130`）改成 0.0。
- `FUN_14017eae0` 依次调 `+0x110`（清屏深度 0）、`+0xa8(1)`（开剔除）、`+0xb0(0)`（剔背面）、`+0xc8(1)`（开深度测试）、`+0xd8(1, 0)`（颜色写掩码），在渲染循环（`0x140110c2e`、`0x14011127d`）和 resize 后（`0x14011ffa8`）调用。所以每帧主目标深度清成 0，近处深度大，比较用「大于」。
- 投影：透视 `FUN_14009a360` 写的是 m22 = n/(f−n)、m32 = n·f/(f−n)，z_view = −n 得 1、−f 得 0（与相机那份 1.2 一致）。
- `REVERSEDEPTH` 宏随 `ctx+0x118` bit12 定义（`0x1401a67ef`），hdr-macro-REPORT 记为壁纸进程恒置。只有阴影、遮挡、体积光着色器读它。

### 3.3 材质 pass 键（`FUN_1401577e0`）【确】
| 键 | 字段 | 取值 → 字节 | 缺键 |
|---|---|---|---|
| `blending` | `+0x1f0` | normal 0、translucent 1、additive 2、alphatocoverage 3 | 0 normal |
| `alphawriting` | `+0x1f1` | default 0、enabled 1、disabled 2 | 0 default |
| `depthtest` | `+0x1f2` | **enabled 0、disabled 1** | **0 enabled** |
| `depthwrite` | `+0x1f3` | **enabled 0、disabled 1** | **0 enabled** |
| `cullmode` | `+0x1f4` | **normal 0、nocull 1** | **0 normal** |

- 材质构造 `FUN_1401515b0` 把 `+0x1f0..+0x1f4` 清零（`0x140151680`、`0x14015168a`），缺键就是 0。
- 键存在但值不是表里的串（或不是字符串）时，`FUN_140158eb0` 等取表的**第一项**：depthtest、depthwrite 落到 disabled，cullmode 落到 normal，blending 落到 normal，alphawriting 落到 default。
- 语料（`matscan.txt`）：默认工程的不透明 3D 模型材质（arsenal、demon_core、dna、fantasticcar 车身、ricepod 船体、audiophile bars 等）三个键都不写，靠缺省得到「深度测试 + 深度写 + 背面剔除」。编辑器生成的图像、粒子材质几乎都显式写 `disabled` / `nocull`。语料共 2318 个 pass 写 `depthtest: disabled`、29 个写 enabled、82 个缺键【样本】。
- 缺键的非模型材质只有两处：demon_core `materials/particle/particle.json`（additive、`depthwrite: disabled`、缺 `depthtest` 和 `cullmode`）与 shimmering_particles 的 `dustmote*.json`（additive、`depthwrite: disabled`、`nocull`、缺 `depthtest`）【样本】。

### 3.4 设备上的深度与剔除状态【确】
- 绑材质 `FUN_140155fc0` 末尾：blending ∈ {1, 2, 3} 时 `dev+0x128(blend)` 记到 `dev+0x26`；`depthtest == 1` 时 `+0xc8(0)`；`depthwrite == 1` 时 `+0xd0(0)`；`cullmode == 1` 时 `+0xa8(0)`；alphawriting 1 / 2 时 `+0xd8`。解绑 `FUN_140157430` 逐项恢复成开。
- 设备里两个状态字节：`dev+0x24` 深度（bit0 不写、bit1 不测），`dev+0x25` 光栅（bit0 剔正面、bit1 不剔、bit2 深度偏移）。
- 画之前 `FUN_140099f60`（网格对象的绘制函数 `0x1400ea805`、`0x1400ead7a` 调用）选状态对象：
  - **深度状态序号 = `dev+0x24` |（`dev+0x26` 为 translucent 或 additive ? 1 : 0）**，取 `dev+0xc0 + 8·序号`，`OMSetDepthStencilState`（上下文 `+0x120`）。
  - 光栅状态序号 = `dev+0x25`，取 `dev+0xe8 + 8·序号`，`RSSetState`（`+0x158`）。

| 深度序号 | 状态（`FUN_140099050`） |
|---|---|
| 0 | DepthEnable 1、WriteMask ALL、GREATER |
| 1 | DepthEnable 1、WriteMask ZERO、GREATER |
| 2、3 | DepthEnable 0（D3D 里不测也不写） |

| 光栅序号 | 状态 |
|---|---|
| 0 | SOLID、CullMode BACK、**FrontCounterClockwise 1**、DepthClipEnable 1、MultisampleEnable = 是否 MSAA |
| 1 | 同上，CullMode FRONT |
| 2、3 | 同上，CullMode NONE |
| 4–7 | 同上加 SlopeScaledDepthBias −4，序号 4 的剔除写成 NONE、5 为 FRONT、6 / 7 为 NONE（阴影 pass 用，`+0xa0` 置 bit2）【确：参数；推：用途】 |

由此：
- `depthtest: disabled` → 不测也不写，`depthwrite` 写什么都没用。
- translucent / additive → 测（若开）但**不写深度**。normal 与 alphatocoverage 才按 `depthwrite` 写。
- 剔除只有「背面 / 正面 / 不剔」三种，材质只能关掉剔除；剔正面由帧级状态决定：主 pass 用 `alignmentfliph`（`R+0x128` bit11，`0x140180901`）作「剔正面」，反射 pass 再取反（`0x1401806ee`–`0x140180737`）。

### 3.5 绕序【确 + 样本】
- D3D 的 `FrontCounterClockwise = TRUE`：在渲染目标上看逆时针为正面，等价于 NDC（y 向上）逆时针为正面。
- 语料网格（core、backgroundsphere、neongrid、car body 6 个网格、pistols 6 个网格、dna）三角形 (p0, p1, p2) 的右手几何法线与顶点法线同向的比例 > 99.9%（`nrm.py`：body 网格 2 有 2 个反向）。即 mdl 是右手坐标、逆时针朝外【样本】。
- 按场景相机投影（`wind.py`）：neongrid 可见的 5000 个三角形全部逆时针，neonsun 2 个全部逆时针；从内部看 backgroundsphere，可见的 1906 个全部逆时针（它是向内建模的，缺 `cullmode` = 背面剔除下仍可见）【样本】。

### 3.6 各类对象的缺省【确】
- 三类对象绑的都是同一个 `FUN_140155fc0`，缺键规则相同：缺 `depthtest` = 测，缺 `depthwrite` = 写（除非半透明），缺 `cullmode` = 剔背面。
- 图像层：基础 pass 画进合成 RT，没有深度；有 effect 时末 pass 借基础材质的 blend、`+0x1f2`、`+0x1f3` 上屏（p2 B7，`FUN_140209160`），上屏时才对主深度生效。没有 effect 的图像层直接画进场景，按自己材质的状态。
- 粒子：同上，材质缺键时照样深度测试。shimmering_particles 是正交场景，粒子在 z = 0 附近；按相机那份 1.2（正交 ndc.z = z_view/4000 + 0.5）且视图 eye 在 z = 1 附近时深度约 0.5，大于清屏值 0，不受影响【推：依赖正交视图的 eye z，交给相机那份核对】。
- 模型：同上。

### 3.7 MSAA、清屏开关、快照
- MSAA 时场景画进 `_rt_FullFrameBufferMultiSampled`，带自己的多重采样 D32F；深度不解析（只解析颜色，p2）【推】。
- `clearenabled: false` 时颜色和深度都不清（p3 L3）。后备缓冲的深度是一张独立纹理，不随交换链翻转，所以不清时留下的是上一帧的深度，而颜色是 N−2 帧（p3 L3）【推】。
- `_rt_FullFrameBuffer` 快照是 `CopyResource` 颜色，深度不进快照【推】。

### 对实现的含义
- 场景目标加 `depth32float` 附件，清 0，`depthCompare: "greater"`，投影保持反向 Z（相机那份已给矩阵），`REVERSEDEPTH` 改为定义 1，并改 hdr-macro-REPORT 的那条建议。
- 管线状态从材质推：
  - `depthtest == disabled` → `depthCompare: "always"`、`depthWriteEnabled: false`；
  - 否则 `depthCompare: "greater"`，`depthWriteEnabled = (depthwrite != disabled) && blending ∈ {normal, alphatocoverage}`；
  - `cullMode = cullmode == nocull ? "none" : (帧级剔正面 ? "front" : "back")`，`frontFace: "ccw"`。
- **缺键改成开：** `bundle.ts` 现在 `pass.cullmode ?? "nocull"`、`depthtest ?? "disabled"`、`depthwrite ?? "disabled"`。上深度缓冲时要改成 `normal` / `enabled` / `enabled`，否则 demon_core 的背景球会盖住核心，dna_fragment 的 dna 也没有自遮挡。不合法的取值按「表的第一项」处理。
- 没有深度附件的通道（合成 RT、effect fbo、泛光）建管线时不带 `depthStencil`，同一材质要按目标有无深度建两份管线。图像层末 pass、普通图像层、粒子画进场景目标时都要带深度状态。
- 能力表：`checkPassFeatures` 不再对 `depthtest` / `depthwrite` / `cullmode` 报不支持，改成只报不认识的取值。正交场景同样要带深度（3354366708 的模型在正交里开深度）。
- `alignmentfliph` 时整帧 `cullMode` front / back 互换。

### 建议实测
- 工程 `p5-depth`（透视，固定相机）：两张 normal 混合的方片 A（近）、B（远），`objects` 顺序 A 在前。
  - 两张都不写深度键：B 被 A 挡住（测 + 写）。
  - A 写 `depthwrite: disabled`：B 盖过 A。
  - A 改 translucent、`depthwrite: enabled`：B 盖过 A（半透明不写深度）。
  - A 改 alphatocoverage：B 被挡住。
  - B 写 `depthtest: disabled`：B 盖过 A；再让 B 写 `depthwrite: enabled` 并在后面加方片 C（比 B 远，normal）：C 不被 B 挡（关测试时不写）。
  - A、B 共面：后画的那张不显示（GREATER 严格）。
  - RenderDoc 读 OM：深度格式 D32_FLOAT、清屏值 0、比较 GREATER；读两张方片的深度值，近的大。
- `p5-cull`：同一方片分别用顺时针、逆时针两套索引（Python 生成 mdl），`cullmode` 缺省 / normal / nocull 三组，预测逆时针恒可见、顺时针只在 nocull 时可见。再开 general `alignmentfliph`：结果反过来不应出现，画面镜像但可见性不变（帧级剔正面抵消镜像）。
- `p5-badkey`：`depthtest: "yes"`、`cullmode: "back"` 这类非法值，预测分别按 disabled、normal 处理。
- `p5-ortho-depth`：正交场景，方片 A 在 z = 100、B 在 z = 0，都缺深度键，B 在 `objects` 后面：B 被 A 挡住，确认正交也走同一张深度。

---

## 4. 绘制顺序

### 4.1 场景绘制函数 `FUN_14018aac0(场景, 模式)`【确】
| 模式 | 调用者 | 名单 | 额外条件 |
|---|---|---|---|
| 0 主 pass | `FUN_140183550`（`0x140180a7a`、`0x140180b6e`） | `场景+0x158`（所有对象，`objects` 顺序） | — |
| 1 反射 pass | `0x140180762` | `场景+0x1c8`（`reflected` 不为 false 的可画对象） | 画进 `_rt_Reflection`（`R+0x3090`） |
| 2 阴影 pass | `FUN_140196530`（`0x140196638`） | `场景+0x158` | 只画 `(obj+0x120 & 0xc00) == 0xc00`（`castshadow` 且不透明） |

- 每个对象：跳过 `obj+0x120` bit1（组合层的子孙）和不可见的，调虚函数 `+0x50`。
- 模式 0 且需要时，对非某类型（`+0x60` 返回 6）的对象调 `FUN_140198d00`【未知：作用】。

### 4.2 排序【确】
- `customsortorder` 且非 `transparentsorting`（`场景+0xe0 & 0x3000 == 0x2000`）：复制名单后按 `sortorder` 稳定排序（rea-p4a）。
- 正交且 `cameraparallax`（`& 0x108 == 0x108`）：按数组顺序画，每个对象前按根对象的 `parallaxDepth` 平移视图（rea-p4a）。模型同样适用。
- `transparentsorting` 且透视（`& 0x1008 == 0x1000`）：
  1. 按名单顺序画所有**不在**半透明集合（`场景+0x188`）里的对象；
  2. 半透明名单 `场景+0x170` 按键值从大到小排序后画。键 = 对象**局部** `origin`（`+0x128..+0x130`）· `ctx+0x160`；`ctx+0x160` 是视图矩阵某一轴取反（`0x140180185`），即相机前向【推：哪一轴】。`obj+0x120` bit9（图像 `fullscreen` 或 `projectlayer` 为真时置位，`0x1401fae25`、`0x1401faf23`）的对象键为 −∞，排在最后。排序是插入排序 / 归并（`FUN_14019ee60` / `FUN_14019ef50`，稳定）【推：稳定性】。
  - 半透明集合的成员：对象 `+0x120` bit8（0x100）在加载后置位的对象（`FUN_14018ff60` 末尾）。粒子、灯构造即置位；图像层材质 blending 不是 normal / alphatocoverage 时置位；模型见 2.4。
- 其余情况：按名单顺序。
- 语料里没有场景写 `transparentsorting` 或 `customsortorder`（`objscan.txt`）【样本】。

### 4.3 模型内部【确】
- 网格按 2.4 的比较器排，不透明在前。每个网格独立绑材质、画、解绑，没有跨对象合批。

### 4.4 视锥剔除【确】
- `FUN_14018aac0` 每次调用先由 `FUN_1401849e0(ctx+0xec0, ctx+0x930)` 从视图投影矩阵算平面。
- 模型绘制：把 `obj+0x2f8` / `+0x304` 两个角用世界矩阵变换，中点为球心、半对角线长为半径，`FUN_1401e5a10` 判在平面外就不画。`ctx+0x1c8` 非 0（阴影多视图）时改为逐视图测试，只给可见视图发实例。
- v<17 的 mdl 包围盒为 ±131072，实际不剔。

### 对实现的含义
- P5 按 `objects` 顺序把模型当成一种对象插进现有的图层循环即可，模型内部再展开网格。`transparentsorting` / `customsortorder` 语料没用，先报能力键。
- 视锥剔除不影响画面（只省绘制），可以先不做；做的话要照 WPE 用外接球，不能更严，否则会多剔。

### 建议实测
- `p5-order`：透视，`objects` 顺序为远处不透明模型 X、近处半透明模型 Y、更远的半透明模型 Z（Z 在 Y 后面）。`transparentsorting` 关：按 X、Y、Z 画，Z 盖在 Y 上（Z 测深度只被 X 挡）。开：先 X，再按前向点积画 Z、Y。再把 Y 的 `origin` 放在 Z 后面、但用父对象把它挪到近处，验证排序用的是局部 origin。
- `p5-mesh-order`：一个 mdl 两个网格，网格 0 半透明、网格 1 不透明且在前方挡住网格 0：预测不透明先画，半透明被深度挡住。
- `p5-frustum`：Python 生成 v23 mdl，几何在原点，包围盒故意写在相机背后：预测整个模型不画；同几何的 v14 版本照常画。

---

## 5. `reflected`、`skin`、`castshadow`

- **`skin`**：见 2.4，选材质，不影响几何【确】。
- **`reflected`**【确，有界：工厂、`FUN_14018aac0`、`0x1401806a4`–`0x140180767`】
  - 工厂里：可画类型（模型、粒子、图像、精灵、文本）且 `reflected` 不为 false、对象 `+0x58` 标志 bit3 不置位时加入 `场景+0x1c8`。缺省加入。
  - 反射 pass：`FUN_14017e180(R+0x1c0, 剔正面标志)` 设镜像视图【推】，设备剔正面取「`alignmentfliph` 的反」（R 标志 bit0 置位时不取反），压 `_rt_Reflection`，以模式 1 画名单。
  - 对象 `+0x58` 标志 bit12 置位时场景 `+0xe0 |= 0x20000`【推：表示需要反射 pass】。用户设置 `reflection`（`0x140476ed0`）控制 R 标志 bit7，`resolution`（`full` / `half`）控制 bit4 / bit5【确：键名与位；推：作用】。
  - 涉及 RT：`_rt_Reflection`（RGBA8，D16 或借后备缓冲深度）。实现留给 P7 / P8（fantasticcar 车身 / 穹顶、audiophile bars 写了 `reflected: true`）。
- **`castshadow`**【确】
  - `obj+0x120` bit11，模型构造时缺省置位，其他对象缺省不置。
  - 阴影 pass `FUN_140196530`：设备 `+0xa0(1)`（深度偏移光栅状态），压阴影 RT（`场景+0x420`），按需清深度，`ctx+0x12eb = 0`，`ctx+0x1c8` = 级联数，逐级联算视锥平面（`ctx+0xb30` 矩阵、`+0xf20` 平面），以模式 2 画，最后 `ctx+0x12eb = 2`。阴影着色器宏 `SHADOW`（`FUN_140198124`）、`common_pbr_2.h` 的级联投影读 `REVERSEDEPTH`。
  - 谁触发阴影 pass（哪种灯、哪个设置）没追【未知】。语料里写了 `castshadow` 的 10 个模型对象全是 false【样本】。实现留给 P8。

### 对实现的含义
- P5 可以忽略 `reflected` 与 `castshadow`：只在场景里存在反射 / 阴影的消费者（`REFLECTION` COMBO、`_rt_Reflection`、`SHADOW`、投影灯）时才有画面影响，那时由 P7 / P8 报能力键。

### 建议实测
- `p5-reflect`：fantasticcar 去掉其它对象只留车身与地面，切换车身 `reflected` true / false，RenderDoc 看 `_rt_Reflection` 的绘制里有没有车身、光栅状态是否剔正面。
- `p5-shadow`：带一个会投影的灯（从 arsenal / fantasticcar 找写法），模型 `castshadow` 缺省 vs false，看阴影 RT 里的绘制列表。

---

## 未查清

- 着色器声明了网格缺的属性时，`CreateInputLayout` 失败后 WPE 怎么画（`FUN_1400d81b8` 之后的错误分支没读）。
- 网格标志 bit1（多读的 u32）、bit2、bit12 的含义；v23 记录表查重建链的用途（都只在 puppet 里出现，归 W6）。
- MDLS 段版本 ≥2 的 0x80 字节记录、可选矩阵块、`FUN_140265c30` 解析的骨骼 JSON 的内容；只有 MDLS 时骨骼矩阵是否真停在绑定姿势（`FUN_14021c480` 的动画求值没读）。
- `obj+0x120` bit3 / bit6（来自材质 `+0x1fc` bit0 / bit3）的作用；`FUN_140198d00` 的作用。
- 图元拓扑值 4 写进网格对象后是否原样传给 `IASetPrimitiveTopology`。
- `FUN_140228440` 是否真是不稳定的 introsort（只按形态判断），同类网格的绘制顺序可能与 mdl 顺序不同。
- 半透明排序键里 `ctx+0x160` 是视图矩阵的哪一轴、正负，影响「从大到小」是不是由远到近。
- 阴影 pass 的触发条件、阴影 RT 格式与尺寸；反射 pass 的触发条件和镜像平面来源（`FUN_14017e180`）；光栅序号 4（偏移 + 剔背面）为什么建成 NONE。
- 正交投影的 z 范围、`perspective` 位换投影的细节、`g_ModelViewProjectionMatrix` 的乘法顺序，交给相机那份（`rea-p5-camera.md`）。`composelayer_depthtest` 组在合成 RT 里没有深度可测，只有末 pass 上屏时对主深度测试，图像标志那份（`rea-p5-modelflags.md`）的工程 G 可以一起核对。
- `fullscreen` / `projectlayer` 置 `obj+0x120` bit9 的其它用途，交给图像标志那份。
- R 标志 bit0（「主 RT 不带深度」）与 bit12（`REVERSEDEPTH`）由谁置位：`ctx+0x118` 的初值来自创建参数（`0x14017c7d5` 读 `[rdx+0x20]`），没往上追；两者都按旧报告的结论（bit0 平时不置、bit12 恒置）理解。
