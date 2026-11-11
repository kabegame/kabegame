> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`；`scenescript64.dll` 基址 `0x180000000`），全部没有实测。P6b 步骤 0c 实测核对后以报告为准。范围是「加载、排版、文字框、作为图层、脚本」；材质选择、字体加载、栅格化、图集、MSDF、逐字几何见并行的 `rea-p6b-raster.md`，重叠处各写各的。

# WPE 2.8.42 文本对象静态逆向（加载、排版、文字框与原点、背景、作为图层、脚本接口）

**概括**
1. **加载：** JSON 里有 `text` 键就建文本对象（`FUN_14018ff60` 的 `0x140190332` 分支，0x5d0 字节，构造 `FUN_140256ae0`，虚表 `0x140491950`），判定在 `sprite` 之后、`light` 之前。描述符表 `DAT_1404e88e0`（`FUN_140258ca0` 登记）共 31 个键，缺省值见 1.2；排版类键的改值回调都是 `FUN_140256f20`（重排）。**JSON 的 `size` 运行时不用**：加载末尾和每次重排都用排版结果覆盖 `+0x2f0`，编辑器存的 `size` 就是这个算出来的值（语料核对一致）。`text` 写成非字符串时 JSON 侧不写入（保持空串）；脚本侧走 V8 `ToString`（`5` → `"5"`），`null` / `undefined` 不写。【确】
2. **排版：** 不用 `IDWriteTextLayout`，**自己用 FreeType + HarfBuzz 排**。字号 `FT_Set_Char_Size(face, 0, trunc(pointsize·64), 300, 300)`，即 **em = pointsize × 300/72 像素**（`pointsize` 先钳到 [1, 256]），不随屏幕 DPI、场景分辨率变。行高 = 主字体 `size->metrics.height >> 6` + `spacing.y`；每个字形的步进 = `x_advance >> 6`（**取整到像素**）+ `spacing.x`。先去掉 `\r`、按 `\n` 分段；`limitwidth` 时按「字形墨迹右沿超出 `maxwidth`」断行，**只在空格、制表符处断词，找不到就按字断**，中日韩没有专门规则。`limitrows` 截到 `maxrows` 行；`limituseellipsis` 在最后一行末尾加 U+2026「…」（单字符），宽度不够时逐字回退。`horizontalalign` 同时管行内对齐与整块相对原点的位置；`blockalign` 是两端对齐（把余量平分给被折行的那些行里的空白字符）。【确，个别细节推】
3. **文字框与原点：** 文字框 = 字形包围盒（含原点 (0,0)，纵向至少覆盖 `行数 × 行高`）。`padding` 只在「有 effect、有 colorBlendMode 合成、或开了 `opaquebackground`」时加，每边钳到 ≤ 512；`"x y"` 和单个数字两种写法都是 vec2（数字铺满）。文字框就是图层 `size` 与合成 RT 尺寸（截断成整数）。对齐决定包围盒中心相对对象原点的偏移（写进 `+0x2f8`，由世界矩阵加上）；`anchor` 不是对齐，是「贴屏幕边」：按缩放模式裁掉的场景边距平移，**屏幕与场景同比例时完全中性**。文字或排版键变了当场重排，尺寸、四边形、合成 RT 一起重建。【确；`anchor` 语义推】
4. **背景：** `opaquebackground` 开时：直接上屏路径另画一个四边形（材质 `materials/fonts/fontbackground*.json`，`flat` 着色器，`g_Color = backgroundcolor`、`g_Alpha = 对象 alpha`），大小是文字框（含 `padding`）；合成路径则直接把合成 RT 清成 `(backgroundcolor, alpha)`。`backgroundbrightness` 和对象 `brightness` 一样**只在 HDR 场景生效**。没开时，合成 RT 初值是背景快照、alpha 清 0（`composelayer_clearalpha`）。【确】
5. **作为图层：** 继承图像层基类 `FUN_1401e6980`，绘制走基类 `FUN_1401e8aa0`。`g_Color4 = (color × (HDR ? brightness : 1), alpha)`。有 effect（或 colorBlendMode ∉ {0, 31}）时文字作为基础 pass 画进合成 RT（文字框中央、四周留 `padding`），再接 effect 链，与图像层相同。colorBlendMode 31 = additive。`copybackground` 对文本**不起作用**；`clampuvs` 只影响合成 RT 采样。对象级 `depthtest` 只在**透视场景**里选 `basefont*_depth` / `fontbackground_depth`，**正交场景恒用无深度材质，完全中性**；缺省值是 `enabled`。【确；`clampuvs`、`solid` 推】
6. **脚本：** 文本类没有专属方法（方法表 `DAT_1404e8920` 空），`ITextLayer` 的字段都是描述符。脚本写入经 `desc+0x48` 写字段后**同步**调改值回调 → 重排，`update` 在渲染之前，所以**当帧生效**；值没变时重排函数比对缓存直接返回，时钟每帧写同一串不重排。用户属性走同一个 setter + 回调，在帧间消息里处理，下一帧画出。**没有 `alignment`**（那是图像层的描述符）。`backgroundcolor`、`backgroundbrightness` 没有回调，每帧绘制时读。【确】

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42），副本 `ignore/p6/rea/text/layout/wallpaper64.exe`，开工时核对 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（前缀一致）。另拷 `bin\scenescript64.dll`（SHA-256 `58039ef9…`），只用 `llvm-objdump` 反汇编了脚本写回函数的类型分派。
- 没运行、没附加 WPE，没写 Steam / WPE 目录。
- 方法：REA（Ghidra 12.1.4）反编译 exe 副本（导入 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot`）；REA 会话与并行代理共用，后期对方关闭了目标，之后的读码全部改用 `ignore/p4/rea/wp.asm` 切片；常量、字符串、虚表用脚本直接读副本。语料读 `ignore/p6/out/objects-new.json`。WPE 自带的 `assets/shaders/font.*`、`materials/fonts/*.json`、`materials/util/composelayer_clearalpha.json`、`shaders/composelayer.frag`、`ui/dist/monaco/autocomplete/lib.sceneScript.d.ts` 只读。
- 工作文件 `ignore/p6/rea/text/layout/`：
  - 反编译：`dec/f_140256f20.c`（重排）、`f_1401b0410.c`（排版主函数）、`f_140257840.c`（passthrough 材质）、`f_140257c30.c` / `f_140257d70.c` / `f_140258050.c`（+0xe0 / +0xe8 / +0xf0）、`f_1402585c0.c`（anchor）、`f_140258900.c`（尺寸）、`f_140256e10.c`（世界矩阵）、`f_1402577e0.c`（可见性）、`f_14025bea0.c` / `f_14025c020.c` / `f_14025c320.c` / `f_14025c400.c`（反射查找）。
  - 汇编摘录：`decomp_rebuild_140256f20.asm`、`draw_e0_e8_f0_140257c30.asm`、`anchor_size_1402585c0.asm`、`ss_writeback.asm`（dll 写回）。
  - 脚本：沿用 sound 那套（`xr.py` / `slice.py` / `fn.py` / `grepfn.py` / `strs.py` / `rd.py` / `vtdump.py`），新增 `vtcmp.py`（虚表并排比较）、`dumpstr.py`、`jt.py`（dll 跳转表）、`systab.py`（systemfont 表）、`ext.py`（拆 REA 结果）、`corp.py`（语料 `pointsize` / `size` 核对）。
- 标记：【确】反编译或汇编直接看到；【推】由代码推出，或依赖 FreeType / HarfBuzz / V8 上游行为；【确，有界】在注明范围内搜过。

**命名**
- `T`：文本对象（0x5d0 字节，虚表 `0x140491950`）。`ctx = *(T+0xc8)`（= 渲染器 `R+0x10`）。`L = *(T+0x5a8)`：排版结果（`FUN_1401b0410` 返回，0x108 字节）。
- `ctx` 用到的字段：`+0x118` 渲染标志（bit10 `0x400` = 正交场景，bit13 `0x2000` = HDR，见 rea-p5-camera、p3 I3），`+0x100..+0x10c` 屏幕边距（第 3.4 节），`+0x120` / `+0x124..+0x12c` 渲染器颜色（alpha / rgb），`+0x1518` 设备，`+0x1630` 材质缓存，`+0x18a0` 字体管理器，`+0x19d8` 文字绘制混合覆盖。
- 虚表（与图像层 `0x1404911a8`、形状 `0x140491d10` 并排比较，`vtcmp.py`）：

| 槽 | 文本 | 作用 |
|---|---|---|
| +0x10 / +0x20 | `0x14025c020` / `0x14025bea0` | 列出 / 按名找属性描述符（本类表 → 对象动态表 → 基类 `FUN_1401ef570`） |
| +0x18 / +0x28 | `0x14025c400` / `0x14025c320` | 列出 / 按名找方法（本类方法表 `DAT_1404e8920`，**空**，再找基类） |
| +0x40 | `0x140256df0` | 加载：基类 `FUN_1401e6f50`，再 `FUN_140256f20` |
| +0x48 | `0x14000ec30` | 每帧更新：空函数 |
| +0x50 | `0x1401e8aa0` | 绘制：直接用基类（图像层是 `0x140206430` → 同一个） |
| +0x68 | `0x1402577e0` | 可见：（可见位且父链可见，或 `+0x304 & 0x1100`）且 `L ≠ 0` 且文字长度（`+0x460`）≠ 0 |
| +0x80 | `0x140256e10` | 世界矩阵 = 基类矩阵 × 平移 `(+0x2f8, +0x2fc, +0x300)`，存 `+0x554` |
| +0xa8 | `0x1402585c0` | `anchor` 平移（第 3.4 节） |
| +0xc0 | `0x140257840` | passthrough 上屏材质（第 5.3 节） |
| +0xe0 / +0xe8 / +0xf0 | `0x140257c30` / `0x140257d70` / `0x140258050` | 合成 RT 初值 / 画进合成 RT / 直接上屏 |
| +0x110 | `0x140258900` | 算尺寸、建四边形与合成 RT |
| +0x118 | `0x140256ab0` | 是否走合成：`+0x320 > 0` 或 `+0x304 & 0x10` |
| +0x128 | `0x140258ab0` | 合成 RT 尺寸 |

---

## 1. 加载

### 1.1 谁是文本对象【确】
- `FUN_14018ff60` 按顺序判键：……`sprite`（字符串）→ **`text`**（`0x140190332`：`FUN_140087490(obj, "text")` 非空）→ `light` → …… → `sound`。命中就 `new 0x5d0`，调 `FUN_140256ae0`。判定只看有没有 `text` 成员，不看类型【确：同一个查找函数，空值的处理沿用 rea-p6a-sound 1.1 的结论，推】。
- 构造：基类 `FUN_1401e6980`（图像层、形状共用），挂虚表，`+0x120 |= 0x100`（进透明表，rea-p5-modelflags 1.4），其余见 1.2。

### 1.2 键表与缺省值（描述符表 `DAT_1404e88e0`，构造 `FUN_140256ae0`）【确】
「回调」= 描述符 `+0x58`；`重排` = `LAB_140256ad0`（直接跳 `FUN_140256f20`）。类型号：0 int、1 vec2、2 vec3、4 float、5 字符串 / 枚举、6 位。

| 键 | 偏移 | 类型 / JSON setter | 缺省 | 回调 |
|---|---|---|---|---|
| `text` | `+0x450` | 5 / `FUN_1401a4bc0` | `""` | 重排 |
| `font` | `+0x490` | 5 / `FUN_1401a4bc0` | `"systemfont_arial"` | 重排 |
| `pointsize` | `+0x4e0` | 4 / `FUN_1401a4b00` | 32 | 重排 |
| `padding` | `+0x4e8` | 1 / `FUN_1401a3fc0` | (32, 32) | 重排 |
| `spacing` | `+0x4f8` | 1 | (0, 0) | 重排 |
| `maxwidth` | `+0x508` | 4 | 500 | 重排 |
| `maxrows` | `+0x510` | 0 / `FUN_1401a4930` | 1 | 重排 |
| `opaquebackground` | `+0x594` bit1 | 6 / `FUN_14019b4e0` | 假 | 重排 |
| `limitwidth` | `+0x594` bit2 | 6 / `FUN_14019bfa0` | 假 | 重排 |
| `limitrows` | `+0x594` bit3 | 6 / `FUN_14025aca0` | 假 | 重排 |
| `limituseellipsis` | `+0x594` bit4 | 6 / `FUN_14025aec0` | 假 | 重排 |
| `blockalign` | `+0x594` bit5 | 6 / `FUN_14019b920` | 假 | 重排 |
| `horizontalalign` | `+0x59c` | 5 枚举 `left` 0 / `center` 1 / `right` 2 | `center` | 重排 |
| `verticalalign` | `+0x59e` | 5 枚举 `bottom` 0 / `center` 1 / `top` 2 | `center` | 重排 |
| `anchor` | `+0x550` | 5 枚举 `none` 0、`center` 1、`top` 2、`topright` 3、`right` 4、`bottomright` 5、`bottom` 6、`bottomleft` 7、`left` 8、`topleft` 9 | `none` | 重排 |
| `depthtest` | `+0x5a0` | 5 枚举 **`enabled` 0 / `disabled` 1** | **`enabled`**（0） | 重排 |
| `backgroundcolor` | `+0x4d0` | 2 / `FUN_1401a4230` | (0, 0, 0) | **无** |
| `backgroundbrightness` | `+0x4dc` | 4 | 1 | **无** |
| `msdf` / `outline` / `blur` / `dropshadow` | `+0x518` bit0–3 | 6 | 假 | 重排 |
| `outlinethickness` | `+0x520` | 4 | 4 | 无 |
| `outlinecolor` | `+0x524` | 2 | (0, 0, 0) | 无 |
| `blursize` | `+0x530` | 4 | 6 | 无 |
| `dropshadowsize` / `dropshadowopacity` | `+0x534` / `+0x538` | 4 | 6 / 1 | 无 |
| `dropshadowoffset` | `+0x53c` | 1 | (4, 4) | 无 |
| `dropshadowcolor` | `+0x544` | 2 | (0, 0, 0) | 无 |

- 基类表 `0x1404e8360`（`FUN_1401ee520` 登记）提供 `size`、`color` / `alpha` / `brightness`（`+0x330` / `+0x33c` / `+0x340`）、`colorBlendMode`（`+0x32c`）、`copybackground`、`clampuvs`、`perspective`、`solid` 等；`origin` / `scale` / `angles` / `visible` / `parent` 在更上层的对象表。**`alignment` 不在文本的查找链上**：它是图像层表（`FUN_1402110be`，偏移 `0x4b1`）的键【确，有界：`alignment` 串的 5 处引用里只有 `0x14021113a` 登记描述符】。
- 构造时另有一组「上次排版用的值」：`+0x470`（文字）、`+0x4b0`（字体）、`+0x4e4`（字号）、`+0x4f0`（padding）、`+0x500`（spacing）、`+0x50c`（maxwidth）、`+0x514`（maxrows）、`+0x598`（`+0x594` 整字）、`+0x59d` / `+0x59f`（两个对齐）、`+0x5a1`（depthtest）、`+0x51c`（`+0x518`）。`+0x594` 的 bit0 初值为 1，没找到读取点。
- **语料里写的 `depthtest: "enabled"` 等于缺省值**，没写的也是 `enabled`；它只在透视场景起作用（第 5.4 节）。
- 枚举 setter（JSON `FUN_14025bb30` 等，脚本 `FUN_14025ab40` 等）：字符串查表，**查不到取表里第一项**（`horizontalalign` → `left`，`verticalalign` → `center`，`anchor` → `none`，`depthtest` → `disabled`）；JSON 值不是字符串时按空串处理，同样取第一项【确】。

### 1.3 `text` 的值类型【确】
- JSON setter `FUN_1401a4bc0`：只收字符串（类型 4），或对象（类型 7）里的字符串 `value`；数字、布尔等**不写入**（保持空串，不可见），但仍调回调、仍登记 `user` / `script` 绑定（`FUN_1401a4db0`）。
- 脚本写入见第 6.2 节。

### 1.4 `size` 不用【确】
- 基类加载 `FUN_1401e6f50` 置 `+0x328 = 1`（`0x1401e6f65`）解析全部键，解析期间每个文本键的回调都会跑 `FUN_140256f20`，但它调的 `+0x110` 见 `+0x328 ≠ 0` 就跳过；结尾清 `+0x328`（`0x1401e7147`）再尾调 `+0x110`（`0x1401e7165`），用排版结果覆盖 `+0x2f0 / +0x2f4`。之后每次重排也覆盖。所以 JSON `size` 只在解析和第一次 `+0x110` 之间存在。
- 语料核对（`corp.py`，无 effect 的对象不加 padding）：`systemfont_arial`、32 号、`"xxxx"`、`size 264 × 153`，按 300 DPI 算 em = 133.3，Arial 行高 1.15 em = 153.3，宽约 3 × 66 + 66；`opensticks` 32 号两份，无 effect 的 `665 × 145`、带 effect `padding 51` 的 `767 × 247` = 145 + 2 × 51；空文字一律 `2 × 2`（无排版时的尺寸）。编辑器存的就是运行时算出的值【推：语料吻合】。

---

## 2. 排版（`FUN_1401b0410`，字体管理器 `ctx+0x18a0`）

### 2.1 入口与参数【确】
- `FUN_140256f20`（重排）先比对 1.2 的「上次值」：文字、字号、字体、`+0x594` 整字、两个对齐、padding、spacing、maxwidth、maxrows、depthtest，以及 `+0x518` 是否为 0。**全部相同就返回**，不排、不建任何东西。
- 不同则同步缓存，组装参数结构（`rbp-0x69` 起，`0x140257228`–`0x1402575a6`）调 `FUN_1401b0410(ctx+0x18a0, &参数, 文字, 0)`，结果存 `L`，再调 `+0x110`，最后算原点偏移（第 3.3 节）。
- 参数结构：

| 偏移 | 内容 |
|---|---|
| `+0x00` | 字体名 |
| `+0x08` | systemfont 序号：`arial` 0、`calibri` 1、`cambria` 2、`comicsans` 3、`consolas` 4、`sansserif` 5、`segoe` 6、`verdana` 7，其它（工程字体）8；文件表 `0x140484cd0`：`arial.ttf`、`calibri.ttf`、`cambria.ttc`、`comic.ttf`、`consola.ttf`、`micross.ttf`、`segoeui.ttf`、`verdana.ttf` |
| `+0x0c` | `pointsize` |
| `+0x10` | `spacing`（x, y） |
| `+0x18` | 字号按 `ctx+0x78 / 768` 缩放的开关：**文本对象恒为 0**（`0x140257466` 写 `r13b` = 0） |
| `+0x19` | 用深度材质（第 5.4 节） |
| `+0x1a` | `+0x518 ≠ 0`（走 MSDF，raster 那份细说） |
| `+0x1b` | `horizontalalign` |
| `+0x1c..+0x48` | 描边、模糊、投影参数（只在对应位开时填，带下限钳制） |
| `+0x4c` | `limitwidth` 时 = `maxwidth`，否则 0 |
| `+0x50` | `limitrows` 时 = `maxrows`，否则 0 |
| `+0x54` / `+0x55` | `limituseellipsis` / `blockalign` |

### 2.2 字号【确】
- `size = clamp(pointsize, 1, 256)`（`0x1401b0520` 之后），`+0x18` 为 0 所以不缩放。
- 字体链（`FUN_1401ad400` → `FUN_1401acaf0`）对每个字体：`FT_Select_Charmap(face, 'unic')`（`0x1401ad1c4`），**`FT_Set_Char_Size(face, 0, trunc(size·64), 300, 300)`**（`0x1401ad1f2`，r9 与栈参数都是 `0x12c`），再 `hb_ft_font_create`（`0x1401ad1fc`）【确：参数形状与 FreeType API 一致；函数身份是推，没对 FreeType 符号】。
- 所以 **em（像素）= pointsize × 300 / 72 ≈ 4.1667 × pointsize**，与 WPE 自带声明「Size of the font in points for 300 DPI」一致。与屏幕 DPI、场景分辨率、窗口大小无关。
- FreeType 的 ppem、`ascender` / `descender` / `height` 会按驱动规则取整（TrueType 驱动整像素取整，CFF 走 `GRID_FIT_METRICS` 的 ceil / floor / round）【推：上游行为】。WPE 再 `>> 6`（向下取整到整像素）使用。

### 2.3 文字预处理与分行【确】
1. UTF-8 拷贝后**删掉所有 `\r`**（`FUN_1401b40a0` 的 remove，`local_434 = 0xd`），转 UTF-32。
2. 按 `\n` 切段；文末的 `\n` 不产生空行，中间的空段保留为空行。
3. `limitrows`（`maxrows ≥ 1`）且已有 `maxrows` 段时停止：最后一段去掉尾部空白（空格、制表、回车），`limituseellipsis` 时末尾不是「…」就追加 **U+2026**（`FUN_1401b0360`），其余段丢弃。

### 2.4 逐行排字【确】
- 每段先按字体回退切成 run（`FUN_1401ad670`，回退规则见 raster 那份），每个 run 一个 `hb_buffer`：`hb_buffer_add_utf32`、`hb_buffer_guess_segment_properties`（方向、文字、语言靠猜）、`hb_shape(font, buf, 无 features)`（`0x1401b0df5`）。所以 kerning、连字按 HarfBuzz 缺省特性开着【推：features 为空即缺省】。
- 每个字形：笔位 `pen += (x_advance >> 6) + spacing.x`；字形四边形用 `x_offset >> 6`、`y_offset >> 6` 和位图边界（`FUN_1401addb0`）。**步进先截成整像素再累加**，`spacing.x` 加在每个字形（含最后一个）的步进上。
- 行高 `lh = (主字体 size->metrics.height >> 6) + spacing.y`（`0x1401b0bf0`，主字体 = 回退链第一个，`FUN_1400eef60(链, 0)`）。第 i 行基线 `y = −i·lh`（y 向上）。

### 2.5 断行（`limitwidth`，`maxwidth > 0`）【确】
- 触发：当前行已有字形，当前字形不是空白（空格 0x20、制表 0x9、回车 0xd），不是上一个字形的同一簇，且 **`pen + 字形墨迹右沿 > maxwidth`**（右沿 = `位图右边界 + x_offset`）。空白字形永远不触发，可以越界。
- 还能加行（`maxrows` 为 0，或 `已完成行数 + 1 < maxrows`）时折行：
  1. 从越界字符往前：先跳过它本身所在的空白，再往前找最近的空白（只认空格、制表、回车，`joined_r0x0001401b1a43` / `…1a7f`）。
  2. 找到：在该空白处断开；找不到（整行没有空白，例如中日韩）：**在越界字符处断开（按字）**。
  3. 后半段作为新的一行插到下一行，**去掉行首空白**；当前行截断、**去掉行尾空白**，标记「被折行」（行结构 `+0x20 = 1`，供 `blockalign` 用），然后重新排。
  - 没有 Unicode 断行规则（UAX #14）：中日韩不区分禁则（句号可以到行首），全角空格 U+3000、零宽空格 U+200B 都不是断点【确，有界：断点判定只有 `0x100002200` 位掩码与 `0x20 / 9 / 0xd` 比较】。
- 不能再加行时（`maxrows` 已满）：
  - `limituseellipsis`：取越界处之前的前缀 + 「…」重新排字量宽，宽度大于 `maxwidth` 就前缀少一个字符再试，直到放得下或前缀为空（`LAB_1401b14a0` 循环，**逐字回退，不按词**）；量宽用最后一个字形的位置加位图宽【推：`local_118` 的含义没逐字段核对】。之后丢掉这一行余下部分和后续各段。
  - 否则：本 run 在越界字形处停止，后面的 run 再越界也同样停止，等于**在第一个越界的非空白字形处截断，不加省略号**【推：由控制流推出，没核对多 run 的情形】。后续各段丢掉。
- 图集满时（`FUN_1401ae080` 返回 2）清空整份结果从头再排一次（`bVar16`）。

### 2.6 包围盒与行内对齐【确】
- 每行：遍历字形取墨迹的 `minx`（初值 0）、`maxx`（初值 0）、`miny`、`maxy`（相对基线，初值 0），行宽 `w_row = maxx − minx`。
- `blockalign` 且该行被折行且非空：数出行内空白字符个数 n，`n > 0` 时每个空白字形步进加 `(maxwidth − w_row) / n`，行宽视为 `maxwidth`（`LAB_1401b215d` 之后）。
- 全部行完成后建网格：每行加对齐偏移 `center: (W − w_row) / 2`、`right: W − w_row`、`left: 0`，`W` = 各行最大行宽。字形分两份网格：普通字形与彩色字形（`+0x39` 标志，彩色字体 / emoji），各自一个顶点缓冲（`L+0x78` / `L+0x80`）。
- `L` 的字段：`+0x90` minx = 各行 `minx` 的最小值（**不含行内对齐偏移**）；`+0x98` maxx；`+0x9c` maxy = `max(ascender, 各行 −i·lh + maxy)`；`+0x94` miny = `min(ascender − 行数·lh, 各行 −i·lh + miny)`；`+0xa0` = `lh`；`+0xa4` = 行数；`+0xa8` = 钳过的字号；`+0x100` = 字体链。
- 因此文字框高度通常就是 `行数 × lh`（`ascender` 到 `ascender − 行数·lh`），只有墨迹伸出（大字形、回退字体更高）时更大；宽度 = 最宽一行的墨迹宽，左边至少到 0。

---

## 3. 文字框与原点

### 3.1 尺寸（`+0x110` = `FUN_140258900`）【确】
- `w = L.maxx − L.minx`，`h = L.maxy − L.miny`；没有 `L`（空文字或排版失败）时 2 × 2。
- `pad = (padding.x, padding.y)`，每个分量 `min(·, 512)`，**只在「`+0x320 > 0`（有 effect）或 `+0x304 & 0x10`（colorBlendMode 合成）或 `opaquebackground`」时加**，否则为 0。没有下限钳制，负 padding 照算【推：代码里只有 `minss 512`】。
- `size = (w + 2·pad.x, h + 2·pad.y)` 写 `+0x2f0 / +0x2f4`（float）。
- 然后依次调 `+0xb0`（基类 `FUN_1401ea310`：有合成时建 2 × 2 与 `size` 四边形 `+0x2e0` / `+0x2e8`）、`+0xb8`（基类 `FUN_1401ea500`：分配合成 RT，并按 `+0x128` 的整数尺寸建 `+0x2d8` 四边形）、`+0xc0`（passthrough 材质）。走合成时另建 `size` 大小的四边形 `+0x5b0` 和材质 `composelayer_clearalpha`（`+0x5b8`）。
- 合成 RT 尺寸（`+0x128` = `FUN_140258ab0`）：`(trunc(w + 2·pad.x), trunc(h + 2·pad.y))`，UV 缩放 (1, 1)；没有 `L` 时 1 × 1。图像层同槽最后有 `max(4, ·)`，文本这个函数里没有，调用方是否再钳没查【推】。

### 3.2 两条绘制路径里文字的位置【确】
设 `w`、`h` 同上，`minx`、`maxy` 取自 `L`：
- **直接上屏**（`+0xf0`，无 effect、无 colorBlendMode 合成）：在世界矩阵上再平移 `(−w/2 − min(minx, 0), h/2 − maxy)` 画字形网格，即**包围盒中心落在对象局部原点**。`minx` 恒 ≤ 0，所以等价于减 `minx`。
- **画进合成 RT**（`+0xe8`）：在对着 RT 像素的矩阵上平移 `(pad.x − min(minx, 0), pad.y − miny)`，包围盒左下角落在 `(pad.x, pad.y)`，即**包围盒在 RT 里居中、四周留 padding**。合成 RT 再按 `size` 四边形（中心在对象原点）上屏，两条路径位置一致。

### 3.3 对齐写进原点偏移（`FUN_140256f20` 尾部）【确】
- 世界矩阵（`+0x80`）总是在基类矩阵上加 `(+0x2f8, +0x2fc, 0)` 的局部平移（图像层只在 `alignment ≠ 0` 时加）。重排时写：
  - `+0x2f8`：`left` → `+w/2`，`center` → 0，`right` → `−w/2`。
  - `+0x2fc = (maxy + miny)/2 − d`，其中 `asc` / `desc` 是主字体 `size->metrics.ascender / descender >> 6`，`n` = 行数：`bottom` → `d = desc − (n−1)·lh`；`center` → `d = (asc − (n−1)·lh) / 2`；`top` → `d = asc`。
- 合起来（以第一行基线为排版原点 `(0, 0)`）：
  - 横向：`left` → 包围盒左沿在对象原点；`center` → 包围盒中心在原点；`right` → 右沿在原点。
  - 纵向：排版坐标 `y` 映到 `y − d`。`top` → 第一行 ascender 线在原点（文字往下长）；`bottom` → 最后一行 descender 线在原点（往上长）；`center` → 「第一行 ascender 线」与「最后一行基线」的中点在原点（**不是**包围盒中心，也不含最后一行的 descender）。
- 多行时行内还有 2.6 的行对齐；块的位置只由包围盒和上面的偏移决定。

### 3.4 `anchor`（`+0xa8` = `FUN_1402585c0`）【确：代码；语义推】
- 基类绘制在乘世界矩阵之前调 `+0xa8` 改当前模型矩阵（`0x1401e916e`、`0x1401e9dd5`；光标拾取 `0x140189e88` 等处也调），即在世界空间再加一段平移 `(ax, ay)`。`none`（0）不变：

| anchor | ax | ay |
|---|---|---|
| `center` | `(E0 − E2)/2` | `(E3 − E1)/2` |
| `top` | `(E0 − E2)/2` | `−E1` |
| `topright` | `−E2` | `−E1` |
| `right` | `−E2` | `(E3 − E1)/2` |
| `bottomright` | `−E2` | `E3` |
| `bottom` | `(E0 − E2)/2` | `E3` |
| `bottomleft` | `E0` | `E3` |
| `left` | `E0` | `(E3 − E1)/2` |
| `topleft` | `E0` | `−E1` |

- `E0..E3` = `ctx+0x100 / +0x104 / +0x108 / +0x10c`。构造（`0x14017c7c3`）清 0；每次布局更新在 `FUN_140183a70`（`R+0x110..+0x11c`，`R = ctx − 0x10`）按场景正交宽高、屏幕宽高和缩放模式（`R+0x124` 起的 switch）算出，缺省分支全为 0。
- 读法：`E0..E3` 是左、上、右、下四边被裁掉（正）或留出（负）的场景单位，`anchor` 让对象跟着可见区域的边或中心走。**屏幕与场景同比例（或 stretch）时全为 0，`anchor` 中性**【推：没逐个核对缩放模式的公式】。语料 `none` 535、缺省 336、`center` 51，其余 23 个。
- `anchor` 有重排回调，但重排不读它，回调只是白跑一次比对（`anchor` 不在比对表里，所以只改 `anchor` 不会重排）。

### 3.5 何时重算【确】
- 只有 `FUN_140256f20` 发现排版键变了才重排；重排同步完成「排字 → `+0x110`（尺寸、四边形、合成 RT、passthrough 材质）→ 原点偏移」。
- effect `visible` 变化（`FUN_1401e6300`，p3 I2）会调 `+0x110`，padding 随之加上或去掉。
- 文本没有每帧更新（`+0x48` 空）。绘制时 `FUN_1401b3430` 若发现 `L` 不在字体管理器的有效表里（图集重建过），用 `L` 里存的参数与文字**就地再排一次**，尺寸不变【推：只看了前段】。

---

## 4. 背景【确】

- **直接上屏**（`+0xf0`，`opaquebackground` 开）：
  - 先画背景：四边形 `+0x2d8`（整数文字框尺寸，`+0xb8` 建），平移 `(−w/2 − pad.x, −h/2 − pad.y)`，即**以包围盒中心为中心、大小为文字框（含 padding）**【推：`+0x2d8` 是以角为原点的四边形，由平移量推出】。
  - 材质 `materials/fonts/fontbackground.json`，透视场景且 `depthtest = enabled` 时 `fontbackground_depth.json`（同 5.4 的条件）；着色器 `flat`：`gl_FragColor = vec4(g_Color, g_Alpha)`。
  - `g_Color = backgroundcolor × f`，`g_Alpha = 对象 alpha`（`+0x33c`），`f = HDR ? backgroundbrightness : 1`（`ctx+0x118 & 0x2000`）。
  - 混合：材质 `+0x1f0` 每帧改成 `colorBlendMode == 31 ? additive : translucent`。
  - 然后画文字。
- **合成路径**（`+0xe0` 在压入合成 RT 0 之后调，`0x1401e968a`）：
  - `opaquebackground` 开：直接把 RT **清成** `(backgroundcolor × f, alpha)`（设备 `+0x118` 设清屏色、`+0x120(1, 0)` 只清颜色）。
  - 没开：用 `composelayer_clearalpha`（`composelayer` + `CLEARALPHA 1`，纹理 `_rt_FullFrameBuffer`）把 `+0x5b0` 四边形按世界矩阵画进 RT，即 RT 初值 = **文字框背后那块场景快照，alpha 清 0**。字形边缘的 RGB 因此带的是真实背景色而不是黑色，effect（模糊等）不会出黑边【推：用途】。
- `backgroundcolor` / `backgroundbrightness` 没有回调，绘制时读，改了下一次绘制就生效；`opaquebackground` 有回调，改了会重排（padding 跟着变）。
- 语料 598 个写了背景键，只有 2 个开 `opaquebackground`。

---

## 5. 作为图层

### 5.1 颜色【确】
- 直接上屏与画进合成 RT 都把 `color × (HDR ? brightness : 1)` 和 `alpha` 交给 `FUN_1401b3430`，它写渲染器颜色 `ctx+0x124..+0x12c`（rgb）、`ctx+0x120`（alpha），即 `g_Color4`（p2 B10 的「渲染器颜色」）【确：写入；对应 `g_Color4` 是推】。
- **`brightness` 在 LDR 场景不乘**（文本的两处都看 `ctx+0x118 & 0x2000`）。
- 字形绘制的混合：直接上屏时 `ctx+0x19d8 = colorBlendMode == 31 ? additive : translucent`；画进合成 RT 时用材质自己的 `translucent`。

### 5.2 effect 链【确】
- 是否合成（`+0x118`）：`+0x320 > 0` 或 `+0x304 & 0x10`。`+0x304 & 0x10` 由基类加载在 `colorBlendMode ∉ {0, 31}` 时置（p2 B8）。
- 合成时（基类 `FUN_1401e8aa0`）：压合成 RT 0 → `+0xe0`（第 4 节的初值）→ 设对着 RT 像素的矩阵 → `+0xe8` 画字形（第 3.2 节）→ effect 链 → 末 pass 上屏，与图像层同一套（p2 B5–B8、rea-p5-modelflags 2.3）。合成 RT 个数、`effectpassthrough` 都照基类规则。
- 不合成时 `+0xf0` 直接画到当前目标。
- 文本基础 pass 不是「一张覆盖率贴图的四边形」：WPE 画的是逐字形四边形网格（两份：普通、彩色）。普通路径下着色器只输出 `(g_Color4.rgb, 覆盖率 × g_Color4.a)`，同色字形重叠时按 translucent 逐个 over 合成【推：覆盖率叠加的等价性留给 raster 那份与 0c 实测】。

### 5.3 passthrough 材质（`+0xc0` = `FUN_140257840`）【确】
- 只在 `+0x304 & 0x10` 时建：`effectpassthrough.json`（设备等级 > 2 时 `_4`），combos `BLENDMODE = colorBlendMode`（0 或 31 写 0）、`FOG_COMPUTED = 1`；透视场景、`depthtest = enabled`、设备等级 > 1 时 pass 的 `depthtest` 写 `enabled`。

### 5.4 `depthtest`【确】
- 「用深度材质」= `!(ctx+0x118 & 0x400)`（**不是正交场景**）且 `depthtest == enabled`（`+0x5a0 == 0`）。这个值进排版参数 `+0x19`（选 `basefont*_depth`，raster 那份），也决定背景用 `fontbackground_depth`、passthrough 开深度。
- **正交场景一律用无深度材质，`depthtest` 完全中性**；语料 546 个 `enabled` 只要场景是正交的就不用管。透视场景里没写 `depthtest` 的文本也走深度材质（缺省 `enabled`）。
- `basefont_depth.json` 与 `fontbackground_depth.json` 是 `depthtest` / `depthwrite` 都 `enabled`（WPE 自带材质原文），与子计划「translucent 不写深度」的说法不同，深度写不写以 P5a 的实测为准【确：材质文件；运行时是否写深度没查】。

### 5.5 其它图层键
- `copybackground`：文本的 `+0xe0` 不看 `+0x304 & 0x40`，**不起作用**【确，有界：`FUN_140257c30` 全文】。
- `clampuvs`（`+0x304` bit15）：基类用于合成 RT 的采样，文本只在合成时有意义【推】。
- `colorBlendMode`：31 → additive（背景、字形都改）；其它非 0 → 合成 + passthrough 混合上屏，同图像层。
- `solid`（`+0x120` bit13）：基类属性，影响光标拾取，与图像层同【推】。
- `perspective`（`+0x120 & 0x80`）：走基类绘制，压相机的处理同图像层（rea-p5-modelflags 1.3）。语料 0 个为真。
- 可见性（`+0x68`）：另外要求文字非空、有排版结果；空文字的对象整层不画（背景也不画）。

---

## 6. 脚本

### 6.1 `ITextLayer` 的来源【确】
- 文本类的方法表 `DAT_1404e8920` 没有任何登记（只有退出时的析构 `0x140425530`），按名找方法直接落到基类。所以 `ITextLayer` 没有专属方法，字段全部是第 1.2 节的描述符，读写走描述符的 `+0x48`（写）/ `+0x50`（读）。
- WPE 自带声明（`lib.sceneScript.d.ts:1577`）列了 `text`、`color`、`alpha`、`opaquebackground`、`backgroundcolor`、`pointsize`（注释「points for 300 DPI」）、`font`、`padding`（标的是 `Number`）、`horizontalalign`、`verticalalign`、`anchor`（注释「Dynamic screen anchor」）、`limitrows`、`maxrows`、`limitwidth`、`maxwidth`。**没有 `alignment`**；对文本写 `thisLayer.alignment` 找不到描述符。

### 6.2 写入的类型转换（dll `FUN_181620e10`，跳转表 `0x181621474`）
- 类型 5（`text`、`font`、三个枚举、`depthtest`）`0x181621338`：
  - 值是 `undefined` / `null`（V8 oddball 的两种）→ **不写、不回调**。
  - 是字符串 → 直接用；否则（数字、布尔、对象）**调 `ToString`**（`0x1800172c0`），失败不写。
  - 转 UTF-8 后调 exe 的 `+0x48`：`text` / `font` 是 `FUN_1401a4d00`（拷贝字符串再调回调），枚举是 `FUN_14025ab40` 等（查表，查不到取第一项，再调回调）。
  - 所以 `thisLayer.text = 12` 得到 `"12"`，`= true` 得到 `"true"`，`= {}` 得到 `"[object Object]"`【确：分支；V8 类型常量 0x83 / 0x80 的含义是推】。
- 类型 6（布尔位）`0x181621415`：要求是布尔（`0x180016fe0`），否则不写。
- 类型 1 / 2 / 4 / 0：沿用 p3 D 节、L6 节的规则：向量接受 `{x, y[, z]}` 或一个数字铺满（`padding = 10` → (10, 10)），float 收数字【推：本次没重读这几支】。`maxrows`（类型 0）按整数写【推】。
- 读取：`text` / `font` 返回字符串，枚举返回名字串（`FUN_14025ac20` 反查表），`padding` / `spacing` 返回 Vec2，`backgroundcolor` 返回 Vec3【推：读取路径没读 dll】。

### 6.3 时机【确】
- 写入 `+0x48` 后尾调 `+0x58`（p3 J5、L6）。文本键的 `+0x58` 是 `FUN_140256f20`，所以**写入当场重排**（变了才排），尺寸、合成 RT 一起重建。
- `update` 在渲染之前（`FUN_14017fa70` 的 `0x1401802e5`），所以 `update` 里写的文字**当帧就画出来**；`init` 同理。
- `text` 字段挂脚本（`{script}` 绑定，`update` 返回字符串）：返回值经同一个写回函数、同一个 `+0x48`，同样当帧生效【推：路径与 p3 J5 的 effect `visible` 相同，没单独核对文本】。
- 时钟每帧返回同一个字符串：`FUN_140256f20` 比对文字相同直接返回，不重排、不重建 RT；只在秒变化时重排一次。
- 没有回调的键（`backgroundcolor`、`backgroundbrightness`、描边 / 模糊 / 投影的颜色与尺寸）：只改字段。背景两个键每次绘制都读，立即生效；描边类尺寸进排版参数，要等下一次重排才进 `L`（绘制时 `FUN_140258b80` / `FUN_140258c40` 另外读一部分，见 raster 那份）【推】。
- **只改 `anchor` 不重排**（不在比对表里），但 `+0xa8` 每次绘制都读，立即生效。

### 6.4 用户属性【确】
- 与 p3 I3 相同：绑定表找到「文本对象 + 描述符」，调 JSON setter（`FUN_1401a4bc0` 等，对象值读 `value`；`condition` 换成布尔），setter 尾调 `+0x58` → 重排。没有整场重载，没有重编着色器（字体网格与图集由字体管理器增量处理）。
- 在帧间消息 `0x466` 里处理，下一帧画出（p3 I1）。
- `text` 绑 `{user}` 时，首次加载先由解析期的 `value` 排一次，场景构造完再以用户当前值触发一次。

---

## 未查清

1. `anchor` 的边距 `E0..E3`（`FUN_140183a70`）在各缩放模式下的公式没逐支读；只确定了写入点、缺省为 0。
2. 断行在 `maxrows` 已满且无省略号时的截断方式（按 run 停止）是从控制流推的，多字体 run 的情形没核对；省略号回退的量宽项 `local_118` 的含义没逐字段确认。
3. 合成 RT 尺寸有没有 `max(4, ·)`（`+0x128` 的调用方 `FUN_1401ea500`）。
4. `+0x2d8` 四边形是否以角为原点（背景位置由平移量推出）。
5. `+0x594` bit0（初值 1）的用途。
6. HarfBuzz 的 `hb_shape` 第 4 个参数（features 个数）没核对寄存器，按 0 理解；`hb_ft_font_create` 的 load flags（是否 hinting）影响步进，没查。
7. 图集重建后绘制时就地重排（`FUN_1401b3430` 前段）的完整条件。
8. dll 类型 0 / 1 / 4 分支的具体转换（沿用 p3 结论）。
9. FreeType 的 ascender / descender / height 取整用的是哪个驱动的规则（TrueType 与 CFF 不同），以及字体回退时行高仍取主字体这一点对中日韩文字的影响，要实测。

## 建议的实测

验证工程只用 `<WPE>/assets/fonts/NotoSans-Regular.ttf`、`RobotoMono-Regular.ttf` 和 `systemfont_arial`，场景 1920 × 1080 正交，测试窗口与场景同比例（避免 `anchor` 干扰）。WPE 真值：RenderDoc 抓帧取字形网格的顶点（位置、UV）、`g_Color4`、合成 RT 尺寸、背景 draw；脚本用 `console.error` 写 WPE 日志读 `thisLayer.*`。

1. **字号换算**（最优先）：`RobotoMono`，`pointsize` 12 / 32 / 72，`text` 为 `"H"`、`"Hg"`。核对字形四边形高度 ≈ 字体单位 × `pointsize·300/72 / upm`，以及 `size`（脚本读不到 `size`，用合成 RT 尺寸：挂一个 tint effect、`padding 0`）。预期 32 号 em = 133.33 px。
2. **行高与 `spacing`**：三行文字 `"A\nB\nC"`，`spacing` 分别 `"0 0"`、`"10 20"`。预期行间距 = `round(height·scale) + 20`，每字多 10 px，最后一个字的步进也多 10 但包围盒不变。
3. **步进取整**：`RobotoMono` 等宽，20 个相同字符，比较首末字形 x 与 `20 × floor(advance)`；再用非整数步进的 `NotoSans` 字符串比较累积误差。
4. **对齐与原点**：同一单行文字，`horizontalalign` × `verticalalign` 九种组合，对象 `origin` 放在 (960, 540)，抓字形网格，核对第 3.3 节的公式（尤其 `verticalalign: center` 是「首行 ascender 线与末行基线的中点」）；再做三行版本。
5. **断行**：`limitwidth: true`、`maxwidth: 300`：
   - 英文长句（有空格）：在空格处断，行首行尾空白被去掉；
   - 无空格的长串与中文串（NotoSans 没有中文字形时会落到回退字体，可改用 `"AAAA…"` 长串）：按字断；
   - 再加 `limitrows: true`、`maxrows: 2`，分别开关 `limituseellipsis`：看第二行末尾是否是一个「…」字形、是否逐字回退到宽度 ≤ 300；
   - `blockalign: true`：被折行的行空格变宽、行宽恰为 300，末行不变。
6. **`\n` 与 `maxrows`**：`"a\nb\nc\n"`、`limitrows` 2、开省略号：预期两行，第二行 `"b…"`。
7. **padding 与文字框**：无 effect 时改 `padding` 包围盒不动；挂 effect 后合成 RT = 包围盒 + 2·padding（截断取整）；`padding` 写 600 看是否钳到 512。
8. **背景**：`opaquebackground: true`、`backgroundcolor 1 0 0`、`alpha 0.5`、`backgroundbrightness 3`：无 effect 时多一个 `flat` draw，四边形 = 文字框；HDR 关时颜色不乘 3，开 `general.hdr` 时乘 3。挂 effect 时没有背景 draw，合成 RT 清屏色为 `(1, 0, 0, 0.5)`。
9. **合成 RT 初值**：不开背景、挂 effect，抓合成 RT 第一次写入：预期是 `composelayer` draw，alpha 为 0、RGB 为背后的场景。
10. **`depthtest`**：正交场景下 `enabled` / `disabled` 两个对象，核对绑定的是否都是无深度的 pipeline（`basefont.json`）；透视场景（`orthogonalprojection: null`）再核对 `_depth`。
11. **脚本时机**：`update` 每帧写 `thisLayer.text = String(frame)`，同时一个 CLK 时钟层；抓帧核对文字与时钟同帧。再写 `thisLayer.text = 12`、`= null`，读回 `console.error(typeof thisLayer.text, thisLayer.text)`：预期 `"12"`、`null` 不改。写 `thisLayer.horizontalalign = "foo"` 预期变 `left`；读 `thisLayer.alignment` 预期 `undefined`。
12. **时钟不重排**：`update` 每帧返回同一字符串，用 RenderDoc 看顶点缓冲是否每帧重建（只在值变化时才应有新的上传）。
13. **`anchor`**：测试窗口改成与场景不同比例（如 900 × 1600 竖屏，WPE 缩放模式 fill），`anchor` 取 `topleft` / `bottomright` / `none`，核对是否贴到可见区域的角；同比例窗口下三者位置相同。
