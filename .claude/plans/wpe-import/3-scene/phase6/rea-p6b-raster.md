> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。P6b 步骤 0c 实测核对后以报告为准。范围是材质选择、字体、栅格化、MSDF、几何、装饰与重建；对象字段、排版、文字框、作为图层、脚本另见 `rea-p6b-layout.md`，重叠处各写各的。

# WPE 2.8.42 文本对象静态逆向（材质选择、字体、栅格化、MSDF、几何、装饰、重建）

**概括**
1. **材质选择：** 8 个 `basefont*` 由三个独立条件选出【确】。
   - `_msdf`：对象打开了 `msdf`、`outline`、`blur`、`dropshadow` 四个开关中任意一个。和字号、缩放、透视、全局设置都无关。
   - `_depth`：场景**不是正交**（`ctx+0x118` 位 0x400 清零），并且对象 `depthtest` 是 `enabled`（缺省就是 `enabled`）。正交场景里永远不选 `_depth`，`depthtest` 不起作用。
   - `rgba`：不是按对象选的。同一个文本对象拆成两次绘制：普通字形一个网格，用 `basefont*`；彩色字形（FreeType 渲染出 BGRA 位图的，即 emoji 等 COLR / CBDT 字形）另一个网格，用 `basefontrgba*`，画在普通字形**之后**。
   - 语料 945 个文本对象里没有 `msdf` 和 `blur`，`outline` 3 个（1 张）、`dropshadow` 5 个（2 张），文本场景里透视的只有 2 张。所以绝大多数走「R8 覆盖率 × `g_Color4`」的普通路径，画法 A 可行（见第 8 节）。
2. **字体：** 不是 DirectWrite。exe 静态链了 **FreeType + HarfBuzz**。DirectWrite 只是 HarfBuzz 的 `directwrite` 整形器被一起链进来，文本路径不调【确：调用链；推：HarfBuzz 缺省走 `ot` 整形器】。
   - 字体文件整份读进内存（引擎文件系统），`FT_New_Memory_Face(…, 0)`，选 Unicode 字符表，`FT_Set_Char_Size(0, pointsize·64, 300, 300)`。也就是 **300 DPI**，每 em 像素 = `pointsize × 300 / 72`。再用 `hb_ft_font_create` 建 HarfBuzz 字体【确】。
   - `systemfont_*` 映射到 `%WINDIR%\Fonts`（`SHGetFolderPathW(CSIDL_FONTS)`）下的**文件**，取 face 0：arial → `arial.ttf`，calibri → `calibri.ttf`，cambria → `cambria.ttc`，comicsans → `comic.ttf`，consolas → `consola.ttf`，sansserif → `micross.ttf`，segoe → `segoeui.ttf`，verdana → `verdana.ttf`【确】。
   - 回退链按码点逐个查：主字体 → `arial.ttf` → `seguiemj.ttf` → `arialuni.ttf` → `segoeui.ttf` → `assets/fonts/TwemojiMozilla.ttf` → `seguisym.ttf` → `msyh.ttc` → `Malgun.ttf`。主字体读不到时换成 `arial.ttf`。**`NotoSans-Regular.ttf` 不在链里**【确】。中日韩字一般落到 `msyh.ttc`（微软雅黑；装了 Office 的机器先落到 `arialuni.ttf`），日文汉字因此是简体中文字形【推：取决于本机字体】。
   - 没有字重、斜体字段，没有合成粗体 / 斜体，字形就是文件本身【确，有界】。
3. **栅格化：** FreeType 自己栅格化，`FT_Load_Glyph(FT_LOAD_RENDER | FT_LOAD_COLOR)`【确】。
   - 渲染模式 NORMAL，即 8 位灰度抗锯齿，没有 ClearType / LCD，没有 gamma、对比度增强。
   - hinting 是 FreeType 缺省：有字节码的 TrueType 走解释器（缺省 v40），CFF 走 Adobe 引擎，没有指令的走 autohinter【推：FreeType 缺省行为，WPE 没改加载标志；`FREETYPE_PROPERTIES` 环境变量能改】。
   - 字形进**图集**：初始 512×512，普通字形 R8（`__font_atlas_`，格式 9），彩色字形另一张 RGBA8（`__font_atlas_color_`）。按行装箱，字形之间留 1 像素并清零。满了先回收没人用的字形，再把宽高都翻倍，最大 4096【确】。
4. **MSDF：** 自带 msdfgen【确：常量与流程对上】。
   - 字形轮廓经 `FT_Outline_Decompose` 进 msdfgen 形状，`edgeColoringSimple(3.0)`，三通道 `generateMSDF`，纠错是 msdfgen 缺省配置（EDGE_PRIORITY、CHECK_DISTANCE_AT_EDGE、1.111 / 1.111、`overlapSupport`）。
   - 按 **32 像素每 em** 生成，四周各留 12 像素，距离范围 24 像素。`MSDF_RANGE` = `g_RenderVar0.x` = **24**。
   - MSDF 字体的图集按字体文件共享，与字号无关。
5. **几何：** 每个字形一个四边形，4 个顶点 6 个索引（uint16），顶点 20 字节：`a_Position` float3（z = 0）+ `a_TexCoord` float2【确】。
   - 坐标单位是 300 DPI 下的 FreeType 像素，等于对象本地单位。
   - 笔位置是整数：HarfBuzz 的 26.6 步进与偏移都右移 6 位（向下取整）。四边形就是字形的像素包围盒（`FT_Glyph_Get_CBox` 的 PIXELS 模式），图集里 1:1。MSDF 时四边形四周各扩 `y_ppem·12/32`。
   - **不存在**「整段一张纹理」，也没有逐字变换。
6. **装饰：** 全部只在 MSDF 路径里，换算系数 `s = 32 / y_ppem = 0.24 · 32 / pointsize`【确】。
   - `g_RenderVar0 = (24, min(outline·s, 5.1), min(blur·s, 6), min(shadowsize·s, 6))`，`.y + .z > 5.1` 时 `.y = max(5.1 − .z, 0)`。
   - `g_RenderVar1 = (outlinecolor, min(offset.x·s, 6))`，`g_RenderVar2 = (shadowcolor, min(offset.y·s, 6))`，`g_RenderVar3.x = dropshadowopacity`。
   - COMBO：`OUTLINE_ENABLED` 在开了 `outline` 时置，`BLUR_ENABLED` 在开了 `blur` 时置，`DROP_SHADOW_ENABLED` 在开了 `dropshadow` 时置。开关打开时厚度至少 1，模糊、投影大小至少 0.01。
   - 打开任何一个都强制 MSDF。
7. **重建：** 只在加载和字段改变时重建网格，每次先逐项比较，没变就返回【确】。
   - 比较的字段：文字、字号、字体、对齐、`padding`、`spacing`、`maxwidth` / `maxrows`、四个限制位、`depthtest`、「是否 MSDF」。
   - 描边、投影等参数每帧从对象拷到网格，改它们**不重建**。
   - 图集按「字体文件 + 字号」（MSDF 按字体文件）在场景内共享，新字形增量写进 CPU 缓冲，脏了整张重新上传。图集扩容后 UV 失效，用到这个字体的网格在下次绘制时惰性重建。

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42），副本 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工时核对前缀 `40e2ce021e935232` 一致。`scenescript64.dll` 没看（这一份不涉及脚本）。
- 没运行、没附加 WPE，没写 Steam / WPE 目录。
- 方法：
  - 反编译：REA（Ghidra 12.1.4）打开 exe 副本，导入 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot` 的拷贝（用完删掉），没做标注。
  - 汇编：按地址切 `ignore/p4/rea/wp.asm`。
  - 常量、字符串、虚表、导入表：脚本直接读副本。
  - 语料：`ignore/p6/out/objects-new.json` 的 `texts`、`ignore/p6/out/b0-corpus.json`。
  - WPE 自带的 `assets/shaders/font.vert`、`font.frag`、`common_fragment.h`、`assets/materials/fonts/*.json` 只读看过。
- 工作文件 `ignore/p6/rea/text/raster/`：
  - 副本 `wallpaper64.exe`。
  - 反编译：
    - `f_1401b0410.c`：建网格，含字体键、整形、排版、顶点；
    - `f_1401ae080.c`：字形栅格化、装箱、MSDF；
    - `f_1401addb0.c`：包围盒缓存；
    - `f_140258ca0.c`：文本字段描述符表。
  - 汇编：
    - `draw_1401b3430.asm`：绘制与材质选择；
    - `b3b60_msdf_vars.asm`：MSDF 的 COMBO 与 `g_RenderVar*`；
    - `ctor_defaults_140256b40.asm`：构造缺省值。
  - 脚本：
    - `strs.py` / `wstrs.py` / `rng.py`：字符串；
    - `xr.py` / `grepfn.py` / `slice.py` / `fn.py`：`wp.asm` 交叉引用与切片；
    - `tbl.py` / `tbl2.py` / `vt.py` / `qref.py`：字体表、虚表；
    - `f32.py`：浮点常量；
    - `imports.py`：导入表；
    - `ext.py` / `extb.py`：抽 REA 结果；
    - `corpus_fx.py` / `persp.py`：语料统计。
- 标记：【确】反编译或汇编直接看到；【推】由代码推出，或依赖 FreeType / HarfBuzz / msdfgen 的上游行为，没有逐行确认；【确，有界】在注明范围内搜过，范围外没排除。
- 库函数的认定：FreeType / HarfBuzz / msdfgen 都没有符号，函数名是按参数、结构偏移和常量认的【推，强】：
  - `FT_Load_Glyph` = `FUN_1402f12d0`，加载标志的分支和 `(flags >> 16) & 0xf` 取渲染模式与上游一致；
  - `FT_Get_Char_Index` = `FUN_1402f0060`，读 `face+0x88` 的 charmap 和 `+0x10` 的 `num_glyphs`；
  - `FT_New_Memory_Face` = `FUN_1402f24e0`；
  - `FT_Select_Charmap` = `FUN_1402f4b80`，参数 `0x756e6963` = `'unic'`；
  - `FT_Set_Char_Size` = `FUN_1402f4dd0`；
  - `FT_Get_Glyph` = `FUN_1402ee9d0`，`FT_Glyph_Get_CBox` = `FUN_1402eeb40`，`FT_Done_Glyph` = `FUN_1402ee990`；
  - `FT_Outline_Decompose` = `FUN_1402f27a0`，四个回调，缩放 `0x3f90000000000000` = 1/64；
  - `hb_ft_font_create` = `FUN_140416c70`，`(face, NULL)`；
  - `hb_buffer_create` / `add_utf32` / `guess_segment_properties` / `hb_shape` / `get_length` / `get_glyph_infos` / `get_glyph_positions` / `destroy` = `FUN_1404144f0` / `FUN_14038a420` / `FUN_140414930` / `FUN_140419010` / `FUN_140414920` / `FUN_1404148a0` / `FUN_1404148b0` / `FUN_1404145e0`；
  - msdfgen：`edgeColoringSimple` = `FUN_140283500`（参数 3.0），`generateMSDF` = `FUN_140283d60`，`msdfErrorCorrection` = `FUN_14028a910`，`Shape::normalize` = `FUN_140281900`。
  - FreeType 模块名字符串都在：`truetype`、`cff`、`type1`、`t1cid`、`type42`、`winfonts`、`pshinter`、`psaux`、`psnames`、`autofitter`、`smooth`、`raster1`、`bsdf`、`sfnt`，以及 `interpreter-version`、`no-stem-darkening`、`FREETYPE_PROPERTIES`。版本号字符串都没找到。

**命名**
- `O`：文本对象（虚表 `0x140491950`）。字段（缺省值见构造 `0x140256bbf`–`0x140256d06`）【确】：

| 偏移 | 含义 | 缺省 |
|---|---|---|
| `+0x330` / `+0x33c` / `+0x340` | 图层 `color` / `alpha` / `brightness` | — |
| `+0x450` / `+0x470` | 当前文字 / 上次建网格时的文字 | — |
| `+0x490` / `+0x4b0` | 当前 / 上次的 `font` | `"systemfont_arial"` |
| `+0x4d0`、`+0x4dc` | `backgroundcolor`、`backgroundbrightness` | 0 0 0、1 |
| `+0x4e0` / `+0x4e4` | `pointsize` 当前 / 上次 | 32 / 32 |
| `+0x4e8` | `padding` x、y（上次值在 `+0x4f0`） | 32 32 |
| `+0x4f8` | `spacing` x、y（上次值在 `+0x500`） | 0 0 |
| `+0x508` / `+0x510` | `maxwidth` / `maxrows`（上次值在 `+0x50c` / `+0x514`） | 500 / 1 |
| `+0x518` | 效果位：bit0 `msdf`、bit1 `outline`、bit2 `blur`、bit3 `dropshadow`；`+0x51c` 是上次值 | 0 |
| `+0x520` | `outlinethickness` | 4 |
| `+0x524` | `outlinecolor` | 0 0 0 |
| `+0x530` / `+0x534` / `+0x538` | `blursize` / `dropshadowsize` / `dropshadowopacity` | 6 / 6 / 1 |
| `+0x53c` | `dropshadowoffset` x、y | 4 4 |
| `+0x544` | `dropshadowcolor` | 0 0 0 |
| `+0x594` | 位：bit1 `opaquebackground`、bit2 `limitwidth`、bit3 `limitrows`、bit4 `limituseellipsis`、bit5 `blockalign`；bit0 用途没查；`+0x598` 是上次值 | 1 |
| `+0x59c` / `+0x59e` | `horizontalalign` / `verticalalign`（0 左 / 上、1 中、2 右 / 下）；`+0x59d` / `+0x59f` 是上次值 | 1 / 1 |
| `+0x5a0` | `depthtest`（`enabled` = 0，`disabled` = 1）；`+0x5a1` 是上次值 | 0 |
| `+0x5a8` | 网格 `M` | — |
| `+0x5c0` | 背景材质 | — |

  - 位与偏移出自描述符表 `FUN_140258ca0`：每项 `+0x34` 是偏移、`+0x38` / `+0x40` 是读写函数。位读写函数与 rea-p6a-sound 相同：`FUN_1401e1a90` bit0、`FUN_14019b4e0` bit1、`FUN_14019bfa0` bit2、`FUN_14025aca0` bit3、`FUN_14025aec0` bit4、`FUN_14019b920` bit5。`depthtest` 的枚举表在 `0x1404e99e0`：`"disabled"` → 1、`"enabled"` → 0。
- `P`：建网格的参数块，由 `FUN_140256f20` 从 `O` 拼出，0x58 字节。`M` 的开头拷一份 `P`，所以下文 `M+x` 和 `P+x` 偏移相同。

| 偏移 | 含义 |
|---|---|
| `+0x0` | 字体路径（`char*`） |
| `+0x8` | 系统字体编号 0–7，8 = 文件 |
| `+0xc` | 字号 |
| `+0x10` / `+0x14` | `spacing` x / y |
| `+0x18` | 按分辨率缩放字号（`× ctx+0x78 / 768`）；文本对象恒为 0，只有调试叠层用 |
| `+0x19` | 用深度 |
| `+0x1a` | `msdf` 位 |
| `+0x1b` | 水平对齐 |
| `+0x1c` | 描边厚度 |
| `+0x20..+0x28` | 描边色 |
| `+0x2c` | 模糊 |
| `+0x30` / `+0x34` | 投影大小 / 投影不透明度 |
| `+0x38..+0x40` | 投影色 |
| `+0x44` / `+0x48` | 投影偏移 |
| `+0x4c` / `+0x50` | `maxwidth` / `maxrows`（没开 `limitwidth` / `limitrows` 时为 0） |
| `+0x54` / `+0x55` | 省略号 / `blockalign` |

- `M`：文本网格（0x108 字节，`FUN_1401b0410` 建）。
  - `+0x58`：文字（`std::string`）；
  - `+0x78` / `+0x80`：普通 / 彩色字形网格；
  - `+0x90..+0x9c`：包围盒 minX、minY、maxX、maxY；
  - `+0xa0` / `+0xa4`：行高 / 行数；
  - `+0xa8`：钳过的字号；
  - `+0xb0`：彩色图集；
  - `+0x100`：字体 `T`。
- `T`：字体对象（0xf8 字节），按字体键存在渲染器 `R = ctx+0x18a0` 的表里（`R+0x140` 起）【确】。
  - `+0x0`：路径；
  - `+0x20`：MSDF；
  - `+0x28`：引用数；
  - `+0x30` 起：按字号的 face 列表表；
  - `+0x70`：主图集 `A`；
  - `+0x78`：按倍率的彩色图集表；
  - `+0xb8` 起：用到它的网格集合。
- `A`：图集（0x98 字节，`FUN_1401ac8d0`）。
  - `+0` / `+4`：宽 / 高；
  - `+8`：彩色；`+9`：MSDF；
  - `+0x10`：像素缓冲；`+0x18`：纹理；
  - `+0x20`：脏位；
  - `+0x28` / `+0x30`：彩色 MSDF 的颜色缓冲 / 纹理；
  - `+0x38`：颜色倍率 `k`；
  - `+0x40` 起：行表；
  - `+0x60` 起：字形表（键 `face 下标 << 24 | glyph id`）。
- `G`：图集里的字形（0x48 字节）。
  - `+0x10..+0x1c`：u0、v0、u1、v1；
  - `+0x20..+0x2c`：像素矩形 x0、y0、x1、y1；
  - `+0x30`：步进；
  - `+0x34`：引用数；
  - `+0x38`：已回收；
  - `+0x39`：彩色。

---

## 1. 材质选择【确】

绘制函数 `FUN_1401b3430(R, M, dx, dy, &rgb, alpha)`：

1. **普通字形网格**（`M+0x78`，图集 `T+0x70`）：
   - `T+0x20 == 0`（非 MSDF）：`M+0x19` 为假选 `basefont.json`，为真选 `basefont_depth.json`。结果缓存在 `R[0x15]` / `R[0x16]`（`0x1401b3809`–`0x1401b38a2`）。
   - MSDF：调 `FUN_1401b3b60` 得变体号 0–7，选 `basefont_msdf.json` / `basefont_msdf_depth.json` 并带上 COMBO，按变体缓存在 `R[0x17 + i]` / `R[0x1f + i]`。
2. **彩色字形网格**（`M+0x80`，图集 `M+0xb0`）：同样的规则选 `basefontrgba*`，缓存在 `R[3]`、`R[4]`、`R[5 + i]`、`R[0xd + i]`（`0x1401b3993`–`0x1401b3a16`）。
   - 第二张纹理 `+0xd8` 取图集 `+0x30`：彩色 MSDF 时 `g_Texture0` 是距离场，`g_Texture1` 是颜色。
   - **先画普通网格、再画彩色网格**，与字形在文字中的先后无关。
3. 材质 `+0x1f0`（混合覆盖）取 `R+0x138`。`FUN_140258050` 在绘制前把它设成 `(colorBlendMode == 31) + 1`，画完再设回 1（`0x14025834c`、`R+0x19d8`）。即 `colorBlendMode` 31 时文本走另一种混合【推：P2a 已知 31 是 additive】。

**`_depth` 的条件**：`P+0x19 = !(ctx+0x118 & 0x400) && O+0x5a0 == 0`（`FUN_140256f20`）。
- `ctx+0x118` 的 0x400 是正交场景（`SCENE_ORTHO`，见 hdr-macro-REPORT）；
- `O+0x5a0 == 0` 是 `depthtest: "enabled"`，也是缺省值；
- 背景材质 `fontbackground` / `fontbackground_depth` 用同一个条件（`FUN_140258050`，`0x14025830b`–`0x140258326`）。

结论：
- **正交场景里永远是不带深度的 `basefont`**，`depthtest` 不起作用。总计划里「546 个 `depthtest: enabled` 对应 `_depth`」的推断只在透视场景成立。
- 透视场景里，没写 `depthtest` 的对象也走 `_depth`。这个材质的 JSON 写的是 `depthtest` / `depthwrite` 都开。
- 语料 87 张文本场景里只有 `3453730450`、`3509243656` 带 `camera:perspective`（`persp.py`）【推：用不支持键代表透视】。

**`_msdf` 的条件**（`FUN_1401b0410`，`0x1401b05b6` 之后）：
- `P+0x1a`（`msdf`）为真，或 `P+0x1c >= 1`，或 `P+0x2c > 0`，或 `P+0x30 > 0`，或 `|P+0x44..0x48|² > 1.19e-7`；
- 而 `FUN_140256f20` 拼参数时，这四项只在对应开关打开时才非零：厚度 `max(thickness, 1)`、模糊 `max(blur, 0.01)`、投影大小 `max(size, 0.01)`、偏移按投影开关取值；
- 所以等价于 **`O+0x518 != 0`**，即 `msdf`、`outline`、`blur`、`dropshadow` 至少开了一个；
- 字号、缩放、透视、HDR、后处理档位都不参与。

**语料**（`corpus_fx.py`）：
- `msdf`、`blur` 两个键 0 次；
- `outline: true` 3 个对象，都在 `3816870245`；
- `dropshadow: true` 5 个对象，在 `3816870245`、`3833971732`；
- 其余 937 个对象走普通路径。

---

## 2. 字体

### 2.1 加载【确】
- `FUN_1401b0410` 拼字体键：
  - 非 MSDF：`<路径>_<int(size·64)>`；
  - MSDF：`<路径>_msdf`；
  - `size` = `P+0xc`，钳到 [1, 256]（`0x1401b0520` 起）。
- 键在 `R` 的表里没有就新建 `T`。`T+0x70` = `FUN_1401ac8d0(彩色 = 0, msdf, 1)`。
- 按字号取 face 列表 `FUN_1401ad400(T, size)`，列表第一次用时调 `FUN_1401acaf0(path, size)`：
  1. 按路径（FNV 哈希）在 `ctx` 的文件缓存里找；没有就经资源文件系统 `FUN_1400d4160(ctx+0x1898, path)` 整份读进内存。字体字节按路径共享，引用计数。
  2. `FT_New_Memory_Face(lib, data, len, 0, &face)`（`0x1401ad1a6`），只取 face 0。
  3. `FT_Select_Charmap(face, 'unic')`（`0x1401ad1c4`）。
  4. `FT_Set_Char_Size(face, 0, (int)(size·64), 300, 300)`（`0x1401ad1dc`–`0x1401ad1f2`：`r9d = 0x12c`，栈上第 5 参数 `0x12c`）。
  5. `hb_ft_font_create(face, NULL)`（`0x1401ad1fc`），`{文件, face, hb_font}` 追加进列表。
- 主字体读不到时，`FUN_1401ad400` 改用 `<Fonts>/arial.ttf` 再试一次。
- 工程字体（如 `fonts/Segment7Standard.otf`）是相对路径，经引擎文件系统解析，先工程、后 WPE `assets`【推：同其它资源，见 P4 文档】。所以 `fonts/NotoSans-Regular.ttf` 这类写法能读到 `assets/fonts` 里的文件。
- **300 DPI 的旁证**：MSDF 换算系数 `0.24 · 32 / size`（第 6 节）里的 0.24 = 72 / 300。语料里 `pointsize` 64 的对象配 `scale` 0.057、`size` 780×291 的文字框，与「每 em 266 像素」吻合。

### 2.2 `systemfont_*`【确】
- `FUN_140256f20` 逐个比较字符串，得编号 0–7，其它为 8。
- 表 `0x140484cc0`，每项 3 个指针：显示名、键、文件。
- `FUN_1401b0410` 在编号不为 8 时把路径换成 `<Fonts>/<文件>`（`0x1401b05b6`）。`<Fonts>` 由 `FUN_1401ab7c0` 取：`SHGetFolderPathW(CSIDL_FONTS = 0x14)` 转 UTF-8 再加 `/`。

| 编号 | 键 | 显示名 | 文件（face 0） |
|---|---|---|---|
| 0 | `systemfont_arial` | Arial | `arial.ttf` |
| 1 | `systemfont_calibri` | Calibri | `calibri.ttf` |
| 2 | `systemfont_cambria` | Cambria | `cambria.ttc`（face 0 = Cambria） |
| 3 | `systemfont_comicsans` | Comic Sans | `comic.ttf` |
| 4 | `systemfont_consolas` | Consolas | `consola.ttf` |
| 5 | `systemfont_sansserif` | Sans Serif | `micross.ttf`（Microsoft Sans Serif） |
| 6 | `systemfont_segoe` | Segoe | `segoeui.ttf` |
| 7 | `systemfont_verdana` | Verdana | `verdana.ttf` |

- 显示名只在编辑器里用；运行时只按文件加载，不按族名查。
- 全是 Regular 文件。Kabegame 用画布时可以写族名（`Arial`、`Calibri`、`Cambria`、`Comic Sans MS`、`Consolas`、`Microsoft Sans Serif`、`Segoe UI`、`Verdana`），但字形只有在同一台 Windows 上才和 WPE 同源。

### 2.3 回退链【确】
- 表 `0x140484c40`，8 项，每项 `{文件, 是否系统字体}`：

| 顺序 | 文件 | 位置 |
|---|---|---|
| 1 | `arial.ttf` | `<Fonts>` |
| 2 | `seguiemj.ttf`（Segoe UI Emoji） | `<Fonts>` |
| 3 | `arialuni.ttf`（Arial Unicode MS，随 Office 装） | `<Fonts>` |
| 4 | `segoeui.ttf` | `<Fonts>` |
| 5 | `fonts/TwemojiMozilla.ttf` | 引擎文件系统（WPE `assets`） |
| 6 | `seguisym.ttf`（Segoe UI Symbol） | `<Fonts>` |
| 7 | `msyh.ttc`（微软雅黑，face 0） | `<Fonts>` |
| 8 | `Malgun.ttf`（Malgun Gothic） | `<Fonts>` |

- 查找 `FUN_1401ad670`，对每个码点：
  - 先在当前字号的 face 列表里按顺序查 `FT_Get_Char_Index ≠ 0`；
  - 都没有就按表的顺序加载下一项（计数器 `列表+0x18`，加载过的永久留在列表里），读不到的文件跳过；
  - 8 项都试完仍没有，就留在当前段，用当前字体的 `.notdef`【推】。
- 分段：相邻码点的 face 不同就切一段。例外是 ZWJ（U+200D）和空白（`\t`、`\n`、`\r`、空格，掩码 `0x100002600`），它们不切段。每段单独 `hb_shape`（`hb_buffer_guess_segment_properties` 猜方向、文种、语言）。
- **`NotoSans-Regular.ttf` 不在链里**，exe 里也没有 `noto` 字符串【确，有界：全 exe ASCII / UTF-16 搜索】。它只是给用户选的字体。
- emoji 在 Windows 10 / 11 上落到 `seguiemj.ttf`，Twemoji 只在它缺字或文件不存在时才用到。
- 中日韩：主字体没有时依次过 Arial → Segoe UI Emoji → Arial Unicode MS（多半没装）→ Segoe UI → Twemoji → Segoe UI Symbol → **微软雅黑** → Malgun。
  - 汉字、假名落到微软雅黑【推：雅黑含 GB18030 范围的假名】，韩文落到 Malgun；
  - 日文汉字是简体字形，不是日文字形；
  - 148 个带中日韩字的对象，主字体自带中日韩字的就不回退。
- 回退以 face 列表为单位，列表按字号分开：同一字体文件的不同字号各自回退、各自加载。

### 2.4 字重、斜体【确，有界】
- 描述符表 `FUN_140258ca0` 里没有字重、斜体、粗体类字段。
- 只取 face 0。
- 没看到 `FT_Outline_Embolden` / 倾斜一类的调用：只查了文本路径上的函数，没做全库扫描。
- 字重、斜体完全由字体文件决定。

---

## 3. 栅格化

### 3.1 字形加载标志【确】
`FUN_1401ae080(R, …, T, faces, face, faceIdx, glyph, &out, …)`，先按 `faceIdx << 24 | glyph` 查 `T` 的主图集和彩色图集：

| 情形 | 标志 | 用途 |
|---|---|---|
| 非 MSDF | `0x100004` = `FT_LOAD_RENDER \| FT_LOAD_COLOR` | 直接出位图 |
| MSDF，face 没有 `FT_FACE_FLAG_COLOR`（`0x4000`） | `8` = `FT_LOAD_NO_BITMAP` | 取轮廓，格式 `'outl'` 才走 MSDF |
| MSDF，彩色 face | `0x100004` | 位图 `pixel_mode == 7`（BGRA）时走彩色 MSDF |
| 包围盒（`FUN_1401addb0`） | `8` | `FT_Get_Glyph` → `FT_Glyph_Get_CBox(…, FT_GLYPH_BBOX_PIXELS)`，按 `faceIdx << 24 \| glyph` 缓存 |

- 渲染模式取 `(flags >> 16) & 0xf` = 0，即 `FT_RENDER_MODE_NORMAL`：8 位灰度，线性覆盖率，没有 gamma，没有 LCD 滤波（`FUN_1402f12d0` 尾部）。
- hinting 没关（没有 `FT_LOAD_NO_HINTING` / `FORCE_AUTOHINT` / `TARGET_LIGHT`），走 FreeType 缺省【推：上游行为】：
  - 有字节码的 TrueType 走解释器，2.7 起缺省 v40，只做竖直方向；
  - 没有字节码的 TrueType 走 autohinter；
  - CFF / OTF 走 Adobe 引擎，2.8 起缺省不做 stem darkening。
  - 环境变量 `FREETYPE_PROPERTIES` 能改这些（字符串在 `0x140436a00`）；没看到 WPE 自己调 `FT_Property_Set`【确，有界：只查了文本路径】。
- 内嵌位图（EBDT）在非 MSDF 路径里没有被关掉。但 300 DPI 下 ppem 很大，一般用不到。
- **步进不经 hinting**：HarfBuzz 的 `hb_ft_font_create` 缺省用 `FT_LOAD_DEFAULT | FT_LOAD_NO_HINTING` 取步进【推：HarfBuzz 上游】。位图却是 hinted 的。

### 3.2 图集【确】
- **分配** `FUN_1401ac8d0(彩色, msdf, k)`：
  - 512×512；`彩色 || msdf` 时每像素 4 字节，否则 1 字节；
  - 两者都真时另分一块 `(512k)²×4` 的颜色缓冲（`A+0x28`）。
- **建纹理** `FUN_1401ac7f0`：经 `ctx+0x1518` 的接口槽 `+0x58`：
  - `"__font_atlas_"`：格式 `彩色 || msdf ? 0 : 9`，`A+0/+4` 尺寸，`A+0x10` 数据，标志 `0x20000008`；
  - 有颜色缓冲时再建 `"__font_atlas_color_"`：格式 0，尺寸 `k·512`。
  - 格式号沿用 `.tex` 的：0 = RGBA8，9 = R8（rea-p4b-render 1.2）【推：引擎内部建纹理接口与 `.tex` 共用格式号】。
  - 标志 bit0 没置，bit1 没置，所以线性过滤、wrap 寻址【推：按 rea-p4b 的采样器缓存语义】。装箱时 x 或 y 为 0 的字形去清最后一列 / 最后一行，正是防 wrap 的写法，可作旁证。
  - 没有 mip【推：标志里没有生成 mip 的位】。所以对象缩得很小时（语料常见 `scale` 0.05）WPE 直接对大字形做无 mip 双线性缩小，会有闪烁和锯齿。
- **装箱**：
  - 普通字形的格子 = 位图宽高；MSDF 字形 = `max(1, int(bbox·32/y_ppem)) + 24`。
  - 按行（shelf）放，从上往下、从左往右，格子之间、行之间各留 1 像素（`宽 + 1`、`高 + 1`，`local_22c += 行高 + 1`）。
  - 放下后清零格子上方一行、下方一行、左侧一列、右侧一列（`0x1401aef50` 之后）。x 或 y 为 0 时清的是最后一列 / 最后一行，按 wrap 处理。
  - UV = 像素矩形 ÷ 图集尺寸，存 `G+0x10..0x1c`。
- **写入**：
  - 灰度位图（`pixel_mode 2`）逐行拷进 R8；源行距按宽算，没用 `pitch`【确】，FreeType 灰度位图的 `pitch` 等于宽，没有影响【推】。
  - BGRA 位图（`pixel_mode 7`）拷进彩色图集，交换 R、B 成 RGBA，**不反预乘**。FreeType 的 BGRA 位图是预乘的【推：上游文档】，而 `basefontrgba` 的混合是 `SrcAlpha / InvSrcAlpha`，所以 emoji 边缘会偏暗。
  - 每写一个字形置 `A+0x20` 脏位。
- **满了的处理**：
  1. 先找引用数为 0、没回收过、格子够大的旧字形，把它从行里摘掉、标记已回收，再试一次；
  2. 还放不下就宽高都翻倍（重新分配并拷贝旧像素到左上角）。旧字形 UV × 0.5（`0x140492dd0` = 0.5 ×4），重建纹理，清空 `T` 的网格集合，让用到它的网格下次绘制时重建；
  3. 宽度已经大于 4095 时放弃（返回 2），这个字形不画。
- **彩色图集**（`FUN_1401adf30`）：
  - 非 MSDF：倍率 `k = 1`，一张 512² RGBA；
  - MSDF：`k = max(1, ceil(max(w, h) / 32))`，`w`、`h` 是位图尺寸。按 `k` 分表，每个 `k` 一张图集，颜色缓冲是距离场的 `k` 倍分辨率。
- **上传**：绘制时 `A+0x20` 脏就清掉，调纹理接口 `+0x48`，把整张缓冲重新上传（`FUN_1401b3430`，`0x1401b37c5`；彩色 `0x1401b3943`、`0x1401b3956`）。彩色 MSDF 两张都传。

### 3.3 DirectWrite 在哪【确】
- 导入表有 `DWrite.dll!DWriteCreateFactory`，唯一的调用点 `FUN_1403ce860`：
  - 建工厂（共享，IID `0x140470b68`）；
  - `RegisterFontFileLoader`，虚表 `+0x68`，加载器虚表 `0x140470af8`。
- RTTI `DWriteFontFileLoader`、`DWriteFontFileStream`、`IDWriteTextAnalysisSource`、`IDWriteTextAnalysisSink` 正是 HarfBuzz `hb-directwrite.cc` 里的类名。
- `FUN_1403ce860` 只被 `0x14035d200` / `0x1403bec00` 一带调，`0x14035d200` 又被 HarfBuzz 的整形器表（`0x140419480` 一带）引用。文本路径用的是 `hb_ft_font_create` 建的字体，没有调到这里。
- HarfBuzz 缺省整形器顺序里 `ot` 在 `directwrite` 前面，`hb_shape(font, buf, NULL, 0)` 实际用 `ot`【推：HarfBuzz 上游】。
- 所以「DirectWrite 渲染模式、ClearType 级别、`CreateCustomRenderingParams`」这一题在 WPE 文本里**不存在**。

---

## 4. MSDF【确，除注明外】

字形在 `FUN_1401ae080` 的 `0x1401aea..` 段生成：
1. `FT_Outline_Decompose(&glyph->outline, 回调, 1/64)` 建 msdfgen `Shape`，坐标是 face 像素。只有一条边的轮廓另作处理，然后 `Shape::normalize`，再 `edgeColoringSimple(shape, 3.0)`。
2. 字形包围盒 `bbox`（像素）：
   - `inner = max(1, int(bbox.w · 32 / y_ppem))` × `max(1, int(bbox.h · 32 / y_ppem))`，`y_ppem` 取 `face->size->metrics.y_ppem`，小于 2 时当 1；
   - 格子 = `inner + 24`；
   - `scale = max(inner_w, inner_h) / max(bbox.w, bbox.h)`，即 MSDF 像素 / face 像素，约等于 `32 / y_ppem`，两轴共用；
   - `translate = (12 / scale − bbox.x0, 12 / scale − bbox.y0)`；
   - `range = 24 / scale`（shape 单位），即 MSDF 像素里的 24。
3. `generateMSDF`（3 通道 float）→ `msdfErrorCorrection`。
   - 配置：`mode = 2`（EDGE_PRIORITY）、`distanceCheckMode = 1`（CHECK_DISTANCE_AT_EDGE）、`minDeviationRatio = minImproveRatio = 1.111…`（`0x3ff1c71c71c71c72`）、`overlapSupport = true`，全是 msdfgen 缺省；
   - 距离映射 `(d + range/2) / range`，边界 = 0.5。
4. 转字节：`clamp(int(v · 256), 0, 255)`，不是 `round(v · 255)`，边界 0.5 → 128。上下翻转（msdfgen 自底向上），alpha 写 255，进 RGBA8 图集。
5. 彩色字形（MSDF 下 `pixel_mode 7`）：
   - `FUN_1401ab9c0` 从位图算一个 4 通道场，写进主图集，RGBA 四个通道都来自它；
   - 颜色经 `FUN_1401ac4e0` 按 `k` 倍分辨率重采样进颜色缓冲；
   - 【推：`FUN_1401ab9c0` 没细看，可能是由 alpha 算距离】。
- 着色器常量：`MSDF_RANGE` = `g_RenderVar0.x` = 24（`0x1401b3db8` 写 `0x41c00000`）。
- MSDF 字体的 `T` 键里没有字号，所有字号共用一张图集。字形按第一次遇到它的字号生成，因为归一到 32 ppem，与字号基本无关；包围盒取整会带来很小的差。
- 四边形外扩 `pad = y_ppem · 12 / 32`（face 像素）（`FUN_1401b0410` 写 `fStack_314`），正好对应格子四周的 12 个 MSDF 像素。

---

## 5. 几何【确】

**整形**（`FUN_1401b0410`，`0x1401b0da0` 起）：
- 每段一个 `hb_buffer`，`add_utf32(buf, text, −1, 0, −1)` → `guess_segment_properties` → `hb_shape(hb_font, buf, NULL, 0)`。
- 对每个输出字形：
  - `FUN_1401ae080` 取图集字形 `G`，`FUN_1401addb0` 取包围盒 `(x0, y0, x1, y1)`；
  - 记录 0x30 字节：
    - `+0x14` 步进 `(x_advance >> 6) + spacing.x`；
    - `+0x18` `y_advance >> 6`；
    - `+0x1c..0x28` `(x0 + (x_offset >> 6), y0 + (y_offset >> 6), x1 + …, y1 + …)`；
    - `+0x2c` `pad`（非 MSDF 为 0）。
- **右移 6 位是向下取整**，所以笔位置、字形位置全是整数像素。
- 行高 = `size->metrics.height >> 6` + `spacing.y`（`0x1401b0c26` 前）。
- 换行、对齐、省略号见 `rea-p6b-layout.md`。

**顶点**（`0x1401b29be` 一带）：
- 普通 / 彩色字形分进两组数组，按 `G+0x39` 分；
- 每个字形 4 个顶点，每个 20 字节，`a_Position` float3（z 恒 0）+ `a_TexCoord` float2：

| 顶点 | 位置 | UV |
|---|---|---|
| 0 | `(penX + x0 − pad + alignX, penY + y1 + pad)` | `(u0, v0)` |
| 1 | `(penX + x1 + pad + alignX, penY + y1 + pad)` | `(u1, v0)` |
| 2 | `(penX + x0 − pad + alignX, penY + y0 − pad)` | `(u0, v1)` |
| 3 | `(penX + x1 + pad + alignX, penY + y0 − pad)` | `(u1, v1)` |

- 索引 uint16：`4i, 4i+2, 4i+1, 4i+1, 4i+2, 4i+3`。
- y 向上（FreeType 坐标），第一行基线 `penY = 0`，每行 `penY −= 行高`。图集第 0 行是位图顶行，所以顶边用 `v0`。
- `alignX`：居中 `(行宽最大值 − 本行宽) / 2`，右对齐 `行宽最大值 − 本行宽`。
- 网格经 `ctx+0x1518` 槽 `+0x40` 建，顶点格式号 7（`FUN_140098c30`）【推：格式号的含义没追，布局按写入推出】。

**变换**：
- 顶点单位是 300 DPI 的 face 像素，等于对象本地单位。
- 绘制时 `FUN_140258050` 在矩阵栈上压一层平移 `(−宽/2 − (minX < 0 ? minX : 0), 高/2 − maxY)`，再乘对象自身矩阵。`FUN_1401b3430` 的 `(dx, dy)` 对文本对象恒为 0。
- 字形之间没有各自的变换。

**`g_Color4`**（`FUN_140258050` → `FUN_1401b3430` 写 `ctx+0x120..0x12c`）：
- rgb = `color`（`O+0x330`）× `brightness`（`O+0x340`），**只在 HDR（`ctx+0x118 & 0x2000`）时乘**；
- a = `alpha`（`O+0x33c`）。
- 背景用 `fontbackground`（`flat` 着色器）先画，颜色 = `backgroundcolor` × `backgroundbrightness`（同样只在 HDR 时乘），alpha 同文本。
- **混合**：材质 JSON 是 translucent（`SrcAlpha, InvSrcAlpha`）。字形按顺序逐个混合进目标。

---

## 6. 装饰【确】

**每帧拷参数**：`FUN_140258c40` → `FUN_140258b80` 从 `O` 写进 `M+0x1c..0x48`：
- `+0x1c`：`outline ? max(thickness, 1.0) : 0`；
- `+0x20`：描边色；
- `+0x2c`：`blur ? max(blursize, 0.01) : 0`；
- `+0x30`：`dropshadow ? max(size, 0.01) : 0`；
- `+0x34`：不透明度；
- `+0x38`：投影色；
- `+0x44`：`dropshadow ? offset : (0, 0)`。

只在 `O+0x518 != 0` 时拷。`FUN_140257d70`、`FUN_140258050` 每次绘制都调。

**COMBO 与常量**（`FUN_1401b3b60`，`b3b60_msdf_vars.asm`）：
- 变体位：
  - `M+0x1c >= 1` → `OUTLINE_ENABLED = 1`，bit0；
  - `M+0x2c > 0` → `BLUR_ENABLED = 1`，bit1；
  - `M+0x30 > 0` 或 `|M+0x44..0x48|² > 1.19e-7` → `DROP_SHADOW_ENABLED = 1`，bit2。
- `s = (32 / M+0xa8) · 0.24`，float32；`M+0xa8` 是钳过的字号；`0.24 · 32 / pointsize = 32 / y_ppem`，即 face 像素 → MSDF 像素。

| uniform | 值 |
|---|---|
| `g_RenderVar0` | `(24, min(M+0x1c·s, 5.1), min(M+0x2c·s, 6), min(M+0x30·s, 6))`；之后若 `.y + .z > 5.1` 则 `.y = max(5.1 − .z, 0)` |
| `g_RenderVar1` | `(描边色 rgb, min(offset.x·s, 6))` |
| `g_RenderVar2` | `(投影色 rgb, min(offset.y·s, 6))` |
| `g_RenderVar3` | `.x = dropshadowopacity`，其余没写 |

- 只有上限，没有下限：负的投影偏移不钳。
- 上限对应 MSDF 格子四周的 12 像素余量（`5.1 + 6 < 12`、`6 + 6 = 12`）。
- 写在 `ctx+0xa8..0xd8`。`g_RenderVar0` = `ctx+0xa8`、`RV1`–`RV3` = `ctx+0xb8` / `+0xc8` / `+0xd8`，见 p2-REPORT。
- 缺省值（打开开关但不写参数时）：
  - 厚度 4、描边色黑；
  - 模糊 6；
  - 投影大小 6、不透明度 1、偏移 (4, 4)、颜色黑。
- 这些参数都是 face 像素，乘 `s` 后才是着色器里的 MSDF 像素。
- **它们全部强制 MSDF**（第 1 节），普通路径里没有任何装饰。`font.frag` 的普通路径只读 `g_Color4` 与 R8 覆盖率，与此一致。

---

## 7. 重建与共享【确，除注明外】

- **触发**：
  - 网格只在 `FUN_140256f20` 里建。它的入口是加载虚函数 +0x40（`FUN_140256df0`，虚表 `0x140491990`：先调基类，再跳过来）和描述符的「改后」回调 `LAB_140256ad0`（字段被属性或脚本写入时调）。
  - 每帧的候选函数（虚表 +0x68 `FUN_1402577e0`、+0x80 `FUN_140256e10`）都不调它【确，有界：只看了这两个】。
- **比较**：`FUN_140256f20` 开头逐项比当前值与上次值，全一样就直接返回：
  - 文字、`pointsize`、`font`、`O+0x594` 位、两个对齐、`padding`、`spacing`、`maxwidth`、`maxrows`、`depthtest`；
  - 「`O+0x518` 是否为 0」。
- 不在里面的字段不触发重建：
  - 描边、投影、模糊的参数和颜色，每帧拷；
  - `color`、`alpha`、`brightness`、背景色，每次绘制读；
  - `msdf` / `outline` / `blur` / `dropshadow` 在已经是 MSDF 时互相切换，只换材质变体。
- **时钟**：脚本每帧返回同一字符串时不重建；秒数变了才重建。
- **每次重建**：
  - 重新分段、整形、生成全部顶点，`FUN_1401b0410(R, P, text, 0)` 新建 `M`；
  - 已在图集里的字形直接复用，只栅格化新字形。
- **共享**：
  - `T` 在 `R`（每个场景一个渲染上下文）里按字体键共享。非 MSDF 是「字体文件 + 字号 × 64」，MSDF 是字体文件。
  - 所以同一场景里同字体同字号的所有文本对象共用一张图集。字体文件字节按路径全局共享。
  - 引用计数：`T+0x28` 记网格数，`G+0x34` 记网格数；没人用的字形在图集满时被回收（3.2）。
- **增量**：
  - 新字形写进 CPU 缓冲并置脏，下一次绘制整张重新上传，不是子区域上传。
  - 扩容时重建纹理并清空 `T` 的网格集合。`FUN_1401b3430` 绘制前发现网格不在集合里，就用原参数原地重建（`FUN_1401b0410(R, M, M+0x58, M)`）。

---

## 8. 对 P6b 画法的含义

- **普通路径和画法 A 等价**，条件是两条：
  - 同一像素上没有两个字形的覆盖率都非零，或者 `alpha` = 1；
  - 对象变换下，字形边界上的双线性差可以忽略。
- 理由：
  - 字形都在整数位置，图集 1:1；
  - 每个四边形只盖自己的包围盒，覆盖率为 0 的地方不改目标；
  - 字形同色。
- 「整段一张 R8 纹理、一个四边形」和 WPE 的差别只有三处：
  1. **覆盖率重叠且 `alpha` < 1**：WPE 逐字 over 合成，得 `1 − (1 − a·c1)(1 − a·c2)`；整段纹理得 `a·(1 − (1 − c1)(1 − c2))`。只出现在字形相互侵入的地方，比如负 `spacing`、连写文字、斜体。
  2. **双线性在字形边界**：WPE 每个字形在自己格子里与 0 插值、四边形外不画；整段纹理会和邻字插值，边缘外多半个纹素。缩放、旋转后才有差，量级是一个纹素的边。
  3. **彩色字形**：WPE 另一次绘制、在所有普通字形之后、RGBA 且预乘未还原。画法 A 要再配一张 RGBA 纹理、第二个四边形，画在普通的之后。
- 纹理要**不生成 mip、线性过滤**，才和 WPE 的缩小行为一样。
- **像素一致的真正障碍是栅格化器，不是画法**：
  - WPE 是 FreeType hinted 灰度，步进不 hinted 并向下取整到整数像素；
  - Chromium 画布在 Windows 上走 Skia 的 DirectWrite 后端：抗锯齿、gamma / 对比度、hinting 都不同，步进是小数，排版也不经 HarfBuzz 的同一字体实例；
  - 所以「字形包围盒严格一致」只有用整数笔位置、并按 FreeType 的步进规则自己排版才可能。
  - 两条路：
    1. 画布逐字（或逐簇）画在自己算的整数位置，步进从画布的 `measureText` 近似。误差来源是 hinted 位图形状和 HarfBuzz 的 kerning / 连字。
    2. 把 FreeType + HarfBuzz 编成 wasm（两者都开源，WPE 用的就是缺省配置），用同样的加载标志和 300 DPI。普通路径可以做到逐像素一致，MSDF 再加 msdfgen。
  - 这是总计划待定 3 的输入。
- MSDF 只在 3 张场景出现（第 1 节），P6b 先报 `text:msdf:*` 的方案成立。

---

## 未查清

- `O+0x594` 的 bit0（缺省 1）对应哪个字段；`T+0x24 = ctx+0x144` 的含义。
- `FUN_1401ab9c0`（彩色字形在 MSDF 下由位图生成 4 通道场）的具体算法；彩色 MSDF 的 `g_Texture0` 是距离场还是别的。
- 只有一条边的轮廓的特殊处理（`FUN_1401ae080` 约 600–700 行，常量 `−0.0015713…`），可能是 msdfgen 的去收敛处理，没逐行对。
- 纹理接口 `ctx+0x1518` 槽 `+0x58` 的格式号与 `.tex` 格式号是否同表，标志 `0x20000008` 里 0x20000000 的含义，是否真的无 mip、wrap 寻址：都是推断，要抓帧确认。
- `FUN_140257d70`（虚表 +0xe8）与 `FUN_140258050`（+0xf0）分别在什么场合调：前者按 `padding`（钳到 512）平移、不画背景，【推】是画进合成 RT 的那条路径（有 effect 时）；归 `rea-p6b-layout.md`。
- FreeType / HarfBuzz 的版本：没有版本字符串。它决定 TrueType 解释器版本、COLRv1 支持（Segoe UI Emoji 新版含 COLRv1 表，FreeType 只渲染 COLRv0 图层）等。
- 8 项回退都缺字时，用的是哪个 face 的 `.notdef`。
- 空字符串时 `FUN_1401b0410` 直接返回 0，网格为空、不画；背景是否还画没看。

---

## 建议的实测

确定性工程放 `ignore/p6/c0/`，用 kbp-tools 生成，抓帧用 wpe-renderdoc MCP，放 `A:\p6b\raster\`。场景一律 1920×1080 正交，除非注明。

- **R1 普通路径的几何与图集**：
  - 工程：一个文本对象，`font: "fonts/RobotoMono-Regular.ttf"`、`pointsize: 32`、`text: "AVAWay g|"`、`scale: 1`、无 effect、`alpha: 1`。
  - 核对：
    1. 找 `font` 着色器的绘制：顶点步长 20、每字 4 顶点 6 索引；
    2. 顶点 x、y 全是整数，四边形宽高 = 图集里的格子尺寸；
    3. `g_Texture0` 名 `__font_atlas_`、`R8_UNORM`、512×512、1 级 mip；
    4. 采样器线性、wrap；
    5. 混合 `SrcAlpha / InvSrcAlpha`、无深度；
    6. `g_Color4` = `(color, alpha)`。
  - 验证 300 DPI：大写字母的格子高约 `0.7 · 32 · 300 / 72 ≈ 93` 像素，存下纹理比字形高度。
- **R2 字号与共享**：同一字体放 3 个对象，`pointsize` 16 / 32 / 32。应当出 2 张图集，32 号的两个对象共用一张。
- **R3 扩容与回收**：一个对象放约 600 个不同的汉字（主字体 `fonts/NotoSans-Regular.ttf`，回退到微软雅黑），看图集变 1024 / 2048。再用脚本把文字换成别的一批，看旧字形的格子被复用。
- **R4 回退链**：`RobotoMono-Regular` 写 `"é漢字かな한글😀★"`。核对 emoji 进第二次绘制（`basefontrgba`，`__font_atlas_color_`、RGBA8），并且画在普通字形之后。存下两张图集，对照字形来源（雅黑、Malgun、Segoe UI Emoji / Symbol）。看 emoji 边缘是否偏暗（预乘未还原）。
- **R5 `systemfont_*`**：8 种各一个对象写同一句，存图集，和 `C:\Windows\Fonts` 下对应文件用 FreeType 离线渲染（`ft_render` 一类脚本，300 DPI、`FT_LOAD_RENDER`）逐像素比，确认文件映射与 hinting 一致。
- **R6 MSDF 开关**：同一句话 5 个对象，分别 `msdf: true`、`outline: true`、`blur: true`、`dropshadow: true`、全开。核对：
  1. 都换成 `basefont_msdf` 与对应 COMBO；
  2. 图集 RGBA8，格子 = `int(bbox·32/ppem) + 24`；
  3. `g_RenderVar0.x = 24`；
  4. `outline` 缺省时 `RV0.y = min(4 · 0.24 · 32/32, 5.1) = 0.96`（`pointsize` 32）；
  5. 投影缺省 `RV1.w = RV2.w = 0.96`、`RV3.x = 1`；
  6. 四边形每边外扩 `ppem · 12/32 = 50` 像素。
  - 再改 `pointsize` 64，`RV0.y` 应减半。
- **R7 深度**：
  - 正交场景 `depthtest: "enabled"` 的对象：材质应为 `basefont`，无深度测试；
  - 透视场景（`camera` 透视）同一对象：`basefont_depth`，深度测试、写入都开；
  - 再写 `depthtest: "disabled"`：回到 `basefont`。
- **R8 混合与颜色**：
  - `colorBlendMode: 31` 的文本：混合状态应变成另一种（P2a 推断为 additive）；
  - `brightness: 2` 在 LDR 下 `g_Color4.rgb` 不变，在 HDR 档（`ultra`）下翻倍。
- **R9 重建时机**：时钟脚本每帧返回同一字符串、每秒变一次。用 RenderDoc 连抓 N 帧，看顶点缓冲只在秒变时换。改 `outlinecolor` 属性（`apply_properties`）时顶点缓冲不变、`g_RenderVar1` 变。
- **R10 画法 A 的误差包络**：
  - R1 的工程 `alpha: 0.5` 加负 `spacing`（如 −20）；
  - 在 Kabegame 用画布整段画一张 R8，和 WPE 抓帧的合成结果逐像素比；
  - 分开统计「覆盖率重叠处」与其它像素的差，给出步骤 1 的验收门槛。
