# P6b — 文本（子计划）

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)「P6b — 文本」。P6a 已提交（`b4d57aaa`、`3d03c976`）。
> 语料是 2026-11-11 在 HEAD `4891ff71` 上的扫描（`ignore/p6/out/b0-corpus.json`，165 个工程，能渲染 38 张）；文本对象的细节读 `out/objects-new.json`，脚本在 `ignore/p6/b0/`（`ana_text.py`、`text_stats.py`、`text_of.py`）。现状锚点取自 HEAD `4891ff71`。
> 分步：步骤 0 只调研；之后每步能单独验收、单独提交。各实现步骤的细节在步骤 0 之后补写。P4、P5、P7 在别的会话进行，实现步骤动工前再核对一次共享文件。

## 总体设计思路

文本对象在 WPE 里是一种图层：位置、变换、可见性、`color` / `alpha`、effect 链都和图像层一样，只是基础 pass 画的不是一张贴图，而是一段文字。WPE 为它自带一个着色器 `assets/shaders/font.vert` / `font.frag` 和 8 个材质 `assets/materials/fonts/basefont*.json`。材质分三个维度：
- `_depth`：深度开；
- `rgba`：彩色字体，`COLORFONT`；
- `_msdf`：多通道距离场，`MSDF`。

着色器的普通路径是「字形覆盖率（R8）× `g_Color4`」，混合是 translucent。描边、投影、模糊只在 MSDF 路径里，参数从 `g_RenderVar0–3` 进来。

所以 P6b 的形态是：**编译期**把文本对象解析成 bundle 里的文本表（字体、字号、排版字段、文字的初值与绑定），并照 WPE 的规则选 `basefont` / `basefontrgba` 材质，交给现成的着色器翻译；**运行时**宿主排版、栅格化，照 WPE 的做法把每个字形画成一个四边形、采样字形图集。文字变了就重新排版，其余字段走 P3a 的就地路径。有 effect 的文本照图像层的路子：基础 pass 画进合成 RT，再接 effect 链。

**和 WPE 用同一套栅格化与排字（2026-11-12 步骤 0 后改定）。** 步骤 0 推翻了「WPE 用 DirectWrite」的推断：WPE 静态链接了 FreeType 与 HarfBuzz，300 DPI、8 位灰度、步进截成整数像素（rea-p6b-raster / rea-p6b-layout）。实测用离线的 FreeType 2.13.2 + HarfBuzz，照读码的规则复现了 7 个工程的 45 个对象，其中 44 个的字形位图、四边形位置、对象原点和 WPE **逐像素、逐坐标相同**（p6-REPORT「P6b 文本语义的实测核对」）。要补的是两条 hinting 规则：TrueType 字体没有 `fpgm` 表时用自动 hinter，CFF 字体走 FreeType 自带的 CFF 引擎；例外是 opensticks 的 3 个字形，推断是 WPE 的 FreeType 版本更新。所以不走浏览器画布（DirectWrite 后端的抗锯齿与 hinting 不同、也拿不到逐字形的排字结果），而是把 FreeType + HarfBuzz 编成 wasm，排版规则（分行、断行、省略号、两端对齐、对齐与原点、文字框、`padding`）用 TS 照读码写，单测拿离线参考的输出做逐坐标基线。

**画法照 WPE：逐字四边形 + 图集。** 每个字形一个四边形，图集 R8、1:1、字形之间留清零的 1 像素；彩色字形（emoji，FreeType 出 BGRA）进另一张 RGBA8 图集，在本对象的普通字形之后单独画一次。这样半透明加负字距时字形重叠处的合成、对象缩放旋转时字形边上的双线性插值，都和 WPE 相同。图集按「字体 + 字号」在场景内共享；排布不必和 WPE 一样（采样 1:1、有清零间隔，结果相同）。

**MSDF 先不做。** WPE 只在打开 `msdf`、`outline`、`blur`、`dropshadow` 之一时才走 MSDF；语料只有 2 张、5 个对象（3 个同时开描边和投影、2 个只开投影），P6b 报 `text:msdf:<键>`。

**深度在正交场景里中性。** 546 个文本对象写了 `depthtest: "enabled"`，但 WPE 只在透视场景里选 `_depth` 材质，正交场景一律不测深度（读码加实测）。所以正交场景直接放开，透视场景本来就由 `camera:perspective` 挡着，等 P5d。

## 范围与解锁

| 步骤 | 内容 | 只做 P6 时累计能渲染 | P4、P5 先做完时 |
|---|---|---|---|
| 0 调研 | 语料（已做）、读码、确定性工程实测 | 38 | — |
| 1 静态文本 | 字体、排版、栅格化、绘制（含 effect 链）、背景、用户属性就地、`text` 字段脚本（时钟） | 39 | 51 |
| 2 脚本 API | `ITextLayer` 字段的读写（`text`、`font`、`pointsize`、`padding`、对齐、`anchor`、`limit*` / `max*`、背景） | 39 | 51 |
| ~~3 视步骤 0 定~~ | 步骤 0 后取消：MSDF 报 `text:msdf:*`（语料 2 张、5 个对象）；`depthtest` 在正交场景中性，透视场景随 P5d | — | — |

步骤 1 之前另有一步 **1a 选型探针**：把 FreeType + HarfBuzz 编成能在宿主里跑的 wasm，核对和 WPE 逐像素一致（已做，见「步骤 1a」：FreeType 2.14.x 与 WPE 只差 1 个像素，是 WPE 图集装箱的副作用）。

解锁明细：
- **步骤 1：** `2391389126`（时钟，`systemfont_cambria`，挂脚本的 `text`，`alpha` 绑属性）。P4、P5 先做完时再加 `2304304373`：工程自带的 `otf` / `ttf`，`text` / `color` / `pointsize` 绑属性，6 个时钟按条件可见，其中 2 个带 `blurprecise` effect、`scale` 的 y 是 −1（倒影）。
- 两张都不带 `depthtest`，`depthtest` 的结论不影响步骤 1 的解锁。

语料里的文本对象（945 个，87 张；用到文本键或文本 API 的 91 张）：
- **文字：** 746 个挂脚本（82 张），其中 603 个用 `Date`，是一秒一变的时钟；57 + 23 个读媒体，这些场景另有 `script:callback:media*` 挡着；24 张的文字绑用户属性。148 个对象的文字含中日韩字符（31 张），字体回退要查。
- **字体：** 80 种。`ttf` 496 个、`otf` 362 个、`systemfont_*` 87 个；7 种系统字体，`arial` 62 个。WPE 的 `assets/fonts` 自带 17 个字体，其中 `NotoSans-Regular.ttf`、`TwemojiMozilla.ttf` 推断是回退字体。最大的字体文件 25 MB。
- **排版：** `horizontalalign` center 750、left 133、right 62；`anchor` `none` 535、缺省 336、`center` 51，其余 7 种共 23 个；`padding` 有数字和 `"x y"` 两种写法；`maxrows` 几乎都是 1；`limitwidth` / `limitrows` / `limituseellipsis` 为真的分别是 75、74、53 个（2026-11-10 的 152 张统计）；`blockalign` 为真 10 个。
- **背景与装饰：** 598 个写了背景键，只有 2 个开 `opaquebackground`；投影 2 个对象、描边 1 个。
- **作为图层：** 307 个带 effect（`blurprecise` 最多）；`clampuvs` 9 张；`scale` 带负值的有倒影写法。
- 去掉文本键后，这 91 张里最常挡着的是 `value:animation` 37、`script:api:particle.play` 36、`script:callback:cursorClick` 35、`tex:video` 31、puppet 31：文本做完，解锁数主要看 P4–P10。

**P6b 不做：**
- 媒体相关的文字（读 `media*` 回调的脚本）：P11。
- 文本对象上的 `perspective: true`：语料 0 个（都写 `false`），照报 `object:perspective`，随 P5b 的图像层 `perspective`。

## 现状锚点

**a. 文本对象整张退回，文本字段都报 `object:<键>`**（`compile/features.ts:460`）
```ts
  } else if (kind && kind !== "image" && kind !== "light" && kind !== "sound") unsupported.add(`object:${kind}`); // 现状：报 object:text
  // … 下面的未知键循环里，font、pointsize、padding、horizontalalign 等全落成 object:<键>
```

**b. 编译只认粒子、声音和图像**（`compile/bundle.ts:1049`–`:1060`）
```ts
    if (objectKind(object) === "particle") {
      await compileParticle(index, object, layer);
      continue;
    }
    // 声音对象（P6a 步骤 1）：图层上只有变换，播放字段进声音表；可见性不影响播放（p6-REPORT `p6a-misc`）
    if (isSoundObject(object)) {
      sounds.push(await compileSound(index, object, fs, properties, bindings));
      continue;
    }
    // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
    if (!object.image) continue; // 现状：文本对象走到这里，只剩变换
```

**c. `text` 字段脚本没有写回目标**（`compile/scripts.ts:90`）
```ts
  if (owner.kind === "material")
    return { kind: "constant", /* … */ };
  return { kind: "unsupported", path }; // 现状：objects/<i>/text 的脚本落到这里，返回值不写回任何地方
```

**d. 文本字段在 API 缺口表里**（`compile/scriptApi.ts:170`–`:189`）
```ts
    ...fields([
      "alignment", "perspective", "solid", "rootmotion", "fov", "zoom", "instance",
      "text", "opaquebackground", "backgroundcolor", "pointsize", "font", "padding", // 现状：ITextLayer 的字段都没实现
      "horizontalalign", "verticalalign", "anchor", "limitrows", "maxrows", "limitwidth", "maxwidth",
    ]),
```

**e. 图层的脚本对象按种类装成员，声音层是样板**（`script/api.ts:232`）
```ts
  private installSound(api: ApiObject, object: number): void {
    // 现状：只有声音层有专属成员（play / pause / stop / isPlaying / volume）；文本层没有 installText
```

**f. WPE 的文本材质与着色器**（`<WPE>/assets/materials/fonts/basefont.json`、`shaders/font.frag`）
```json
{ "passes": [{ "shader": "font", "blending": "translucent", "depthtest": "disabled", "depthwrite": "disabled", "cullmode": "nocull" }] }
```
```glsl
#else // Basic rasterization
	float _sample = ConvertSampleR8(texSample2D(g_Texture0, v_TexCoord.xy));
	gl_FragColor = vec4(g_Color4.rgb, _sample * g_Color4.a);   // 普通路径：覆盖率 × 颜色
```
`_depth` 变体把 `depthtest` / `depthwrite` 改成 `enabled`；`_msdf` 加 `MSDF: 1`；`rgba` 加 `COLORFONT: 1`。

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

见上「范围与解锁」。

### 0b — 读码（两个代理并行）

- `rea-p6b-raster.md`：下面第 1 题的材质选择、第 2、3、7、10 题，以及逐字几何（第 5 题前半）。工作文件 `ignore/p6/rea/text/raster/`。
- `rea-p6b-layout.md`：第 1 题的字段表、第 4、5、6、8、9 题。工作文件 `ignore/p6/rea/text/layout/`。

两份重叠的地方各写各的，0c 实测时以抓帧为准。

目标 `wallpaper64.exe` 2.8.42（核对 SHA-256 前缀 `40e2ce021e935232`），脚本 API 部分另看 `scenescript64.dll`。exe 里有 `DWriteCreateFactory`、`hb_shape`、`hb_buffer` 的字符串，推断用 DirectWrite 加 HarfBuzz。要回答：
1. **加载：** 文本对象的 JSON 字段全表与缺省值；`size` 字段用不用（语料里是编辑器存的文字框，如 `665 145`）；8 个 `basefont*` 材质怎么选：`_depth` 是不是对象的 `depthtest`，`rgba` / `COLORFONT` 什么时候用，`_msdf` / `MSDF` 什么时候用。
2. **字体：** 工程字体怎么加载（DirectWrite 自定义字体集还是别的）；`systemfont_*` 各对应哪个系统字体名；字体回退链（`assets/fonts` 的 `NotoSans-Regular.ttf`、`TwemojiMozilla.ttf`，以及系统回退），中日韩字落在哪个字体。
3. **栅格化：** DirectWrite 的渲染模式、抗锯齿（灰度还是 ClearType）、gamma 与对比度、hinting；图集的格式与尺寸；MSDF 的生成参数（`MSDF_RANGE` 等）。
4. **排版：** `pointsize` 到像素的换算；行高；字距与 kerning；`spacing` 的 x、y；换行规则（`maxwidth` / `limitwidth` 按词还是按字、中日韩怎么断）；`maxrows` / `limitrows`；`limituseellipsis` 的省略号位置；`horizontalalign` / `verticalalign`；`anchor`；`padding` 两种写法；`blockalign`。
5. **几何：** 每字一个四边形还是整段一个；文字框（含 `padding`）的尺寸怎么算，它是不是图层尺寸与合成 RT 尺寸（有 effect 时）；`anchor` 怎么改原点；文字变了尺寸是否跟着变。
6. **背景：** `backgroundcolor` / `backgroundbrightness` / `opaquebackground` 怎么画（另一个四边形？画在文字框还是 `size` 上？）。
7. **装饰：** `outline*`、`dropshadow*`、模糊到 `g_RenderVar0–3` 的映射；它们是不是强制走 MSDF。
8. **作为图层：** `color` / `alpha` / `brightness` 怎么进 `g_Color4`；effect 链怎么接（文本画进合成 RT）；`clampuvs`；对象级 `depthtest`；`perspective`、`colorBlendMode`、`copybackground`、`solid` 在文本上的意义。
9. **脚本：** `text` 字段脚本返回值的写回时机，当帧还是下帧重排；`ITextLayer` 各字段（`text`、`font`、`pointsize`、`padding`、`horizontalalign`、`verticalalign`、`anchor`、`limitrows`、`maxrows`、`limitwidth`、`maxwidth`、`opaquebackground`、`backgroundcolor`、`alignment`）的读写语义与生效时机；`text` 写入非字符串时怎么转。
10. **重建：** 文字或字段变了才重新排版、栅格化，还是每帧都做；图集怎么增量更新。

产出照以前的读码文档：概括、元数据（目标哈希、方法、工作文件）、逐题结论带地址与置信度、未查清的列表、建议的实测。

### 0c — 确定性工程与实测（Claude）

- **工程：** 只用 WPE `assets/fonts` 自带的字体（`NotoSans-Regular.ttf`、`RobotoMono-Regular.ttf`）和一种 `systemfont_*`，不依赖工坊字体。按读码的结论，每个排版字段一组，加时钟脚本一组，加带 effect 的一组。
- **取数：** RenderDoc 抓帧，拿文本绘制的顶点（四边形位置与 UV）、覆盖率纹理或图集、`g_Color4` / `g_RenderVar*` / 材质与混合；有 effect 时拿合成 RT 的尺寸。
- **两边的抗锯齿差异：** 同字体、同字号、同文字，在 Kabegame 的画布上画一次，和 WPE 的覆盖率纹理逐像素比，定步骤 1 的验收门槛。
- **深度：** 一组「前面有写深度的 pass」和一组「没有」的工程，确认 `depthtest` 的中性条件。

### 步骤 0b 实施记录（2026-11-12）

读码在 [rea-p6b-raster.md](rea-p6b-raster.md) 与 [rea-p6b-layout.md](rea-p6b-layout.md)（代理写，没有实测），工作文件 `ignore/p6/rea/text/raster/`、`layout/`。

**我核对过的：**
- `0x1401ad1dc`–`0x1401ad1f2`：`FT_Set_Char_Size(face, 0, (int)(pointsize·64), 300, 300)`，乘数常量读出来是 64.0。
- exe 里有 FreeType 的模块名（`autofitter`、`truetype`、`psaux`、`sfnt`），回退链的文件名（`seguiemj`、`arialuni`、`msyh.ttc`、`malgun`、`TwemojiMozilla`）与 `__font_atlas_` / `__font_atlas_color_` 都在。
- `0x140257de9`–`0x140257e62`：`padding` 只在「effect 数 > 0，或 `+0x304` 有 0x10，或 `+0x594` 有 0x2（`opaquebackground`）」时取 `min(padding, 512)`，否则为 0。
- 我先怀疑过「无 effect 不加 `padding`」：`2391389126` 的时钟存的 `size` 是 328×156。按读码算，高 156 正是 Cambria 一行的行高、宽 328 接近「12:34」的步进和，没有 `padding`，对得上。

**两份的主要结论**（逐条实测见 p6-REPORT）：
- WPE 用静态链接的 FreeType + HarfBuzz，不用 DirectWrite 画字（DirectWrite 只在 HarfBuzz 的 `hb-directwrite` 里）。300 DPI，8 位灰度，没有 ClearType / gamma。
- 每个字形一个四边形，图集 R8 512² 起、按「字体 + 字号」共享；彩色字形另一张 RGBA8 图集、另画一次。
- MSDF 只在 `msdf` / `outline` / `blur` / `dropshadow` 之一打开时走；`_depth` 只在透视场景。
- 运行时不用 JSON 的 `size`；文字框 = 墨迹包围盒（高至少「行数 × 行高」）+ 条件 `padding`；对齐写进原点偏移。
- 脚本：`ITextLayer` 只有字段、没有方法，写入当帧重排；值没变不重排。

### 步骤 0c 实施记录（2026-11-12）

结果在 [p6-REPORT.md](p6-REPORT.md)「P6b 文本语义的实测核对」：读码的结论**全部成立**，补了一条读码没说的（没有 `fpgm` 的字体用自动 hinter）。

**做法和计划不同：**
- 不和画布比抗锯齿。读码说 WPE 用 FreeType，我在独立虚拟环境 `ignore/p6/venv` 里装了 `freetype-py`（FreeType 2.13.2）和 `uharfbuzz`，照读码写离线参考（`ignore/p6/b0/ft_ref.py`、`ft_layout.py`），直接和 WPE 的图集与顶点逐像素、逐坐标比。结果完全相同，画布那条路就不用量了。
- 深度没做「前面有写深度的 pass」的工程：读码与实测都说正交场景根本不选 `_depth` 材质，深度测试是关的。

**对后面几步的影响：**
1. **栅格化与排字用 FreeType + HarfBuzz 的 wasm，不用画布。** 离线参考已经证明能做到和 WPE 完全一致；画布做不到（字形 hinting、抗锯齿不同，也拿不到逐字形的排字结果）。
2. **加一步 1a 选型探针：** 本机有 LLVM 的 `clang` / `wasm-ld`，Rust 装了 `wasm32-unknown-unknown`，没有 emscripten。要试的是把 FreeType 2.13.2（C）和 HarfBuzz（C++，不用异常与 RTTI）编进一个 wasm，只暴露「加载字体 / 设字号 / 查字 / 排字 / 取位图与度量」几个接口；编不过再看 emscripten 或现成的 `harfbuzzjs`。验收：在 Node 里对 `p6b-*` 的 45 个对象跑出和 WPE 图集逐字节相同的位图与位置；顺带按版本（2.13.2、2.13.3、2.14.x）试 opensticks 的残差，定下要编的 FreeType 版本。
3. **两条 hinting 规则**：TrueType（`glyf`）没有 `fpgm` 就强制自动 hinting（FreeType 2.13.2 的判定还看 `prep`，要在调用侧补）；CFF 不强制、走原生 CFF 引擎。离线参考已验证（`FTRULE=fpgm FTCFF=native`）。
4. **画法照 WPE（逐字四边形 + 图集）**，不再考虑「整段一张纹理」。排版规则在 TS 里写，单测用离线参考的输出做基线。
5. **步骤 3 取消：** MSDF 报 `text:msdf:<键>`（2 张、5 个对象）；正交场景的 `depthtest` 中性，`object:depthtest` 直接放开。
6. **系统字体与回退链读 `C:\Windows\Fonts`：** 宿主要能读这几个文件（`file:` 闸门要放行），不随应用分发；文件不存在时照 WPE 跳过。
7. **排版补两条读码没写的：** 行数已满、加省略号时，接「…」前先去掉前缀尾部的空白（`p6b-extra` e8）；不加省略号时在第一个越界的非空白字形处截断（e9，读码是推断，实测成立）。

**补测（同日，`p6b-extra`）：** 4 个 CFF 的 `otf`、3 个 TrueType（没有 hinting 表的 opensticks、8bitOperator，带完整指令的 Blackout）和两种省略号情形。CFF 要走原生引擎（第 3 条因此改成两条规则）；opensticks 有 3 个字形没对上，见风险 2。

## 步骤 1a — 选型探针（2026-11-12，已做）

**做法：** 全在 `ignore/p6/b1a/`，不碰产品代码。
- **源码与工具链：** FreeType 2.13.2 / 2.13.3 / 2.14.0–2.14.3 / 2.15.0、HarfBuzz 15.0.0（与离线参考 `uharfbuzz` 同版本）的源码包解到 `src/` 各自目录，只编译、不运行其中的脚本。FreeType 2.13.2 的 SHA-256 与官方值一致。libc 用 wasi-sdk 34 的 `wasi-sysroot`（119 MB，用户手动下载、SHA-256 与发布页一致）和 `libclang_rt`，编译器用本机 LLVM clang 22.1.6，目标 `wasm32-wasip1`（reactor）。没有装 emscripten。
- **构建**（`build.py`）：FreeType 只编 `truetype`、`cff`、`autofit`、`psaux`、`pshinter`、`psnames`、`sfnt`、`smooth`（加 `gzip`），HarfBuzz 用单文件合并编译、带 `hb-ft`，不用异常与 RTTI；`setjmp`（光栅化器的池溢出要用）走 wasm 异常处理（`-mllvm -wasm-enable-sjlj`，链 `libsetjmp`）。C 胶水 `kbfont.c` 只导出：加载字体（300 DPI、Unicode 字符表、`hb_ft_font_create`、两条 hinting 规则）、查字、度量、排字、取字形位图。
- **对照：** `harness.mjs` 在 Node 26 里用 `node:wasi` 加载，对 `p6b-*` 的 44 个静态文本对象逐行做回退分段、排字、栅格化，输出规范 JSON；`ref_dump.py`（离线参考）同格式，`compare.py` 逐字段比；`wpe_cmp.py` 直接和 WPE 抓帧的图集逐像素比；`px_where.py`、`atlas_overlap.py` 查残差；`perf.mjs` 量耗时。

**结果：**
1. **能编，能跑。** 本机 clang 22 + wasi-sysroot 34（LLVM 23 编的）链接没问题；Node 26 跑 wasm 异常处理没问题。产物 1.85 MB（没做体积优化）。
2. **2.13.2 先差了 27 个字形（覆盖率 ±1）：** x64 上 `ftgrays.c` 因 `FT_SSE2` 成立而用 DDA 展平二次曲线，wasm32 不满足条件、退回二分细分。把 `BEZIER_USE_DDA` 改成 1 之后，wasm 和离线参考（x64）在 44 个对象、557 个字形上**每个字段都相同**（含位图、emoji 的彩色位图）。2.14 起 FreeType 自己改成「有 64 位整数就用 DDA」，不用补。
3. **WPE 用的是 FreeType 2.14 系列。** 直接和 WPE 图集比（约 70 万像素）：

| 版本 | 和 WPE 不同的像素 |
|---|---|
| 2.13.2、2.13.3 | opensticks 3 个字形、37 个像素（「M」宽差 1） |
| 2.14.0、2.14.1、2.14.2、2.14.3 | **1 个像素**（opensticks 的「2」） |
| 2.14.3 + 自动 hinter 用 HarfBuzz（`FT_CONFIG_OPTION_USE_HARFBUZZ`） | 同上，1 个像素 |
| 2.15.0 | 另加微软雅黑 / Malgun 251 个像素 |

4. **剩下那 1 个像素是 WPE 图集装箱的副作用，不是栅格化：** 「2」的格子从 x 32 开始，同一张图集在 (32, 0) 还有一个 1×1 的格子，属于 e5 里的零尺寸字形（空格）。装箱器放下字形后会把格子四周各清零 1 行 / 1 列，这一清盖到了「2」格子的 (32, 1)，WPE 画出来就是 0。2.13.2 的离线参考在同一个像素上也差同样的值。照抄 WPE 的装箱器（rea-p6b-raster「装箱」，`FUN_1401ae080`）就能对上；零尺寸字形怎么定位还要看一眼代码。
5. **耗时（Node）：** 编译加实例化 21 ms；加载字体 3–5 ms（19.7 MB 的 `msyh.ttc` 也是 5 ms）；排一行 28 个字 0.017 ms；首次栅格化每个字形约 0.2 ms（之后进图集）。每帧都变的文字也撑得住。

**对步骤 1 的影响：**
1. **版本：** FreeType 2.14.3、HarfBuzz 15.0.0，自动 hinter 不开 HarfBuzz（结果相同，少一层依赖）。2.14 不需要 DDA 补丁。
2. **装箱器照抄 WPE**，包括零尺寸字形的 1×1 格子和四周清零；验收以「和 WPE 图集逐字节相同」为准。
3. **还没在浏览器里跑：** CEF 149 应支持 wasm 异常处理（exnref），步骤 1 接进宿主时第一件事核对；浏览器里的 WASI 只需要几个桩（不读文件、不写 stdout）。
4. **构建怎么进仓库要定（待定 5）：** 源码、sysroot 与 clang 的来源，见「决定」。macOS 的 Apple clang 没有 wasm 后端，要 Homebrew 的 LLVM。

## 步骤 1 — 文本（拆成 1b–1e）

> 现状锚点与目标代码取自 HEAD `644628cd`；摸底见两份调查（构建与加载链、渲染与绑定链，2026-11-12，结论摘进下面各点）。P4e 正在改 `compile/bundle.ts`、`compile/features.ts`、`render/graph.ts`、`render/scene.ts`、`render/state.ts`：照旧在 HEAD 快照里实现、按块合并，每小步动工前看一次工作区。

### 思路

文本分三层，数据从上往下流：
- **`wpefont`（wasm）：** FreeType 2.14.3 + HarfBuzz 15.0.0 加一小段 C 胶水，只做「加载字体、查字、度量、排字、取字形位图」。它没有状态之外的逻辑，排版规则一条都不放在 C 里。
- **`text/`（TS，宿主主线程）：** 字体与回退链、排版、图集。输入是一个文本对象的当前字段（文字、字体、字号、排版键），输出是 `TextMesh`：普通字形与彩色字形两组四边形（排版坐标 + 图集 UV）、文字框、原点偏移、图集的脏区。规则全部照读码与 0c 的实测，单测拿 WPE 抓帧做逐坐标、逐字节的基线。
- **渲染：** 文本层是图像层的一种。基础 pass 换成「逐字四边形 + 图集」的绘制，背景、彩色字形各多一次绘制；有 effect 时这几次绘制画进合成 RT（先清成背景色，或画 `composelayer_clearalpha`），再接现有的 effect 链。

**为什么放主线程、何时排版。** 编译 Worker 每次编译都销毁，留不住字体和图集，所以 `wpefont` 和 `text/` 放在宿主主线程，跨重编译保留（同 P6a 的声音播放器）。读字体文件是异步的，在宿主加载阶段（`GpuScene.build` 之前）读好主字体；回退字体按需加载：加载时先排一遍，找出要的回退字体，读完再排，然后才出第一帧；运行时文字变出新的回退字（少见）就异步读，读完下一帧补上。排版本身是同步的 wasm 调用（一行 0.017 ms），放在 `GpuScene.sync` 里，所以脚本写的文字当帧生效（0c 实测）。

**文字框会变。** WPE 文字一变就重算文字框、四边形、合成 RT（rea-p6b-layout 3.5），而我们的合成 RT 尺寸、基础 pass 的矩阵、图层四边形现在都是加载时定死的。1d 让文本层的这几样跟着 `TextMesh` 走，1e 在重排时重建这一层的合成 RT。

**字符串值贯穿写回链。** P3a / P3b 的整条链（`bindingValue`、`SceneState.write`、`ScriptRuntime.writeReturn`、`ScriptApi.write`、`scriptOverrides`）只认数字、向量、布尔，`"string"` 类型的写回现在直接丢掉。1e 只为 `text` 目标开一条字符串通路，不去泛化整条链的类型。

**拆分与解锁：**

| 小步 | 内容 | 能单独验收的东西 |
|---|---|---|
| 1b | `wpefont` 进仓库：子模块、构建、宿主里的加载与包装、系统字体放行 | Node 与 CEF 里都跑得出和 1a 相同的字形 |
| 1c | `text/`：字体与回退、排版、图集（照抄 WPE 的装箱器） | `p6b-*` 的四边形、原点、文字框、图集和 WPE 逐坐标、逐字节相同 |
| 1d | 静态文本的编译与渲染、能力表 | `p6b-*` 的画面和 WPE 抓帧比；不变的文本场景解锁 |
| 1e | 动态文字：字符串写回、字段脚本、用户属性、重排 | `p6b-script` 当帧生效；`2391389126` 解锁 |

### 现状锚点

**a. wasm 的取法：构建期拷进宿主，Vite 资源 URL，缺了为 null**（`apps/wpe-scene/src/wpesl2wgsl/index.ts:11`）
```ts
// 文件不存在时 glob 结果为空，构建不会失败
const wasmUrls = import.meta.glob<string>("./wpesl2wgsl.wasm", { query: "?url", import: "default", eager: true });
export const WPESL2WGSL_WASM_URL: string | null = Object.values(wasmUrls)[0] ?? null;
```
拷贝在 `scripts/plugins/wpesl2wgsl-plugin.ts`（`prepareEnv`，standard 模式、不带 `--skip vue` 时，缺失只告警），任务在根 `package.json` 的 `"build:wpesl2wgsl": "deno run -A scripts/build-wpesl2wgsl.ts"`，产物路径常量在 `scripts/paths.ts:65`。仓库里没有「按版本下载、校验 SHA-256、缓存」的工具函数。

**b. 宿主的 `file:` 范围只有宿主目录、WPE `assets` / `config.json` 与库内场景目录**（`src-tauri/kabegame/src/wallpaper/wpe_scene_host.rs:37`、`:94`）
```rust
struct HostScope {
    root: PathBuf,
    root_key: String,
    /// WPE 安装目录的 `assets`（目录）与 `config.json`（文件）。
    engine_grants: Vec<FileGrant>,   // 现状：没有 C:\Windows\Fonts 下的任何文件
}
fn engine_grants(engine_dirs: &[PathBuf]) -> Vec<FileGrant> {
    engine_dirs.iter().flat_map(|engine| [
        FileGrant::new(&engine.join("assets"), true),
        FileGrant::new(&engine.join("config.json"), false),
    ]).flatten().collect()
}
```

**c. 文本对象走到「没有 image」就结束**（`compile/bundle.ts:1113`，现状锚点 b 的同一处）。

**d. 基础 pass 进合成 RT 是关混合的整面覆盖，清屏步骤只能清成 0**（`render/graph.ts:269`、`:289`）
```ts
  if (layer.passthroughModel && !layer.copyBackground) {
    steps.push({ kind: "clear", target: nextComposite() });   // 现状：清成 (0, 0, 0, 0)
  ...
    steps.push({ kind: "draw", role: "base", pass: base, effect: null, target: nextComposite(),
      inputs: staticInputs(base, null), geometry: "fill", uv, inset: NO_INSET, blending: null });  // 现状：只画 passes[0]
```

**e. 合成 RT 尺寸与基础矩阵按 `layer.size`，加载时定死**（`render/graph.ts:108`、`render/uniforms.ts:289`）
```ts
export function compositeSize(layer, texture): [number, number] {
  const [w, h] = texture && !layer.solidLayer && !layer.passthroughModel
    ? [texture.width, texture.height] : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  return [Math.max(4, Math.round(w)), Math.max(4, Math.round(h))];   // 现状：文本层没有静态纹理，会落到 size
}
```

**f. 动态几何只有粒子：按容量建顶点缓冲、全场一份索引、只有粒子用三角形列表**（`render/scene.ts:1251`、`:1947`、`:394`）
```ts
      if (step.kind === "particles") {
        particles = this.createParticles(layer, program, state);
        vertexBuffer = this.own(device.createBuffer({ label, size: particles.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
  ...
        } else if (particles) {
          pass.setIndexBuffer(this.particleIndices!.buffer, this.particleIndices!.format);
          pass.drawIndexed(particles.count * 6);
        } else pass.draw(4);
  ...
      topology: step.kind === "particles" && !geometry ? "triangle-list" : "triangle-strip",
```

**g. 纹理只在加载时从 bundle 上传，没有运行时生成或更新的纹理**（`render/textures.ts:113` 的 `uploadTexture`；`scene.ts:448` 的 `planProblems` 要求纹理引用有 mip）。

**h. 字符串写回被丢掉**（`script/runtime.ts:185` 的 `writeReturn`；`render/state.ts:90` 的 `scriptWriteValue`；`compile/bindings.ts:209` 的 `bindingValue`）
```ts
      let value: number[] | boolean;
      if (type === "bool") { ... }
      else if (type === "string") return;   // 现状：objects/<i>/text 的脚本返回值不写回
```

### 1b — `wpefont` 进仓库

**点 1 — 子模块（`.gitmodules`、`third/freetype`、`third/harfbuzz`、`third-patches/{freetype,harfbuzz}/README.md`）**
- **新增**
  - `third/freetype`：`https://gitlab.freedesktop.org/freetype/freetype.git`，gitlink pin 到 `VER-2-14-3`。
  - `third/harfbuzz`：`https://github.com/harfbuzz/harfbuzz.git`，pin 到 `15.0.0`。
  - 两个 `README.md` 记 vendor base（提交号、标签）。目前没有补丁，`deno task patch --all` 只看有目录的仓库，有 README 不影响。
    > 说明：1a 编的是官方发布包；git checkout 和发布包在源码上应该相同，验收时用同一套对照重跑确认。FreeType 仓库带嵌套子模块 `subprojects/dlg`（只在 `FT_DEBUG_LOGGING` 时用），`release.yml` 的 `submodules: recursive` 会拉它，无害。

```ini
[submodule "third/freetype"]
	path = third/freetype
	url = https://gitlab.freedesktop.org/freetype/freetype.git
[submodule "third/harfbuzz"]
	path = third/harfbuzz
	url = https://github.com/harfbuzz/harfbuzz.git
```

**点 2 — C 胶水与 FreeType 配置（新增 `src-tauri/wpefont/`）**
- **新增**
  - `wpefont.c`：由 1a 的 `kbfont.c` 改名，导出名改成 `wpefont_*`，内容不变（两条 hinting 规则、300 DPI、`hb_ft_font_create`）。
  - `ftmodule.h`：1a 的模块表（`autofit`、`truetype`、`cff`、`psaux`、`psnames`、`pshinter`、`sfnt`、`smooth`）。
  - `README.md`：接口契约（每个导出的参数与输出布局）、版本、为什么这么编、和 WPE 的对照结论。
    > 说明：和 `src-tauri/wpesl2wgsl` 并列，都是「编成 wasm 给场景渲染器用、不链进应用」。

```c
/* 导出（输出布局见 README）：
 *   wpefont_alloc / wpefont_free
 *   wpefont_font_new(data, length, size26_6) -> handle   FT_Set_Char_Size(0, size26_6, 300, 300) + hb_ft_font_create
 *   wpefont_font_free(handle)
 *   wpefont_font_has(handle, codepoint) -> 0/1
 *   wpefont_font_metrics(handle, out[5])                 ascender、descender、height（26.6）、upem、load_flags
 *   wpefont_shape(handle, utf32, length, out, cap) -> n  每字形 gid、cluster、x/y 步进、x/y 偏移
 *   wpefont_glyph(handle, gid, out[6]) -> bitmap ptr     width、rows、pitch、left、top、pixel_mode
 */
```

**点 3 — 构建脚本（新增 `scripts/build-wpefont.ts`、`scripts/download.ts`；修改 `scripts/paths.ts`、`package.json`、`.gitignore`）**
- **新增**
  - `scripts/download.ts`：`fetchPinned(url, sha256, dest)`，下载到临时名、校验 SHA-256、改名；已有且摘要对就跳过；失败带重试。
  - `scripts/build-wpefont.ts`：
    1. 检查 `third/freetype`、`third/harfbuzz` 存在（照 `build-ffmpeg.ts` 的 `ensureSource`）；
    2. 用 `fetchPinned` 把 `wasi-sysroot-34.0`、`libclang_rt-34.0` 下到 `bin/wasm/wpefont/toolchain/` 并解压；
    3. 找 clang：环境变量 `WPEFONT_CLANG` → `PATH` 上的 `clang` → macOS 的 `/opt/homebrew/opt/llvm/bin/clang`、`/usr/local/opt/llvm/bin/clang`；要求有 wasm32 目标（`--print-targets`），没有就报错并说明怎么装；
    4. 照 1a 的参数编 FreeType 的几个单元、`harfbuzz.cc` 与 `wpefont.c`，链接成 reactor，输出 `bin/wasm/wpefont/wpefont.wasm`；
    5. 编译参数里不加任何会改变数值结果的优化开关（不开 `-ffast-math`），`-O2`。
- **修改**
  - `scripts/paths.ts`：加 `WPEFONT_WASM`、`WPEFONT_FE_WASM`、`WPEFONT_TOOLCHAIN_DIR`。
  - `package.json`：`"build:wpefont": "deno run -A scripts/build-wpefont.ts"`。
  - `.gitignore`：加 `apps/wpe-scene/src/wpefont/*.wasm`（`/bin/wasm/` 已忽略）。

```ts
// scripts/build-wpefont.ts（摘）
const TOOLCHAIN = [
  { name: "wasi-sysroot-34.0", url: ".../wasi-sdk-34/wasi-sysroot-34.0.tar.gz",
    sha256: "9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be" },
  { name: "libclang_rt-34.0", url: ".../wasi-sdk-34/libclang_rt-34.0.tar.gz",
    sha256: "eee3e634dcf71aa22b1333391623cf5c9965a637dc428a27b1a858c026c587f1" },
];
// setjmp / longjmp 走 wasm 异常处理（光栅化器的池溢出要用）
const SJLJ = ["-mllvm", "-wasm-enable-sjlj", "-mllvm", "-wasm-use-legacy-eh=false"];
```

**点 4 — 拷进宿主（新增 `scripts/plugins/wpefont-plugin.ts`；修改 `scripts/build-system.ts`）**
- **新增** 照 `Wpesl2wgslPlugin`：standard 模式、不带 `--skip vue` 时把 `WPEFONT_WASM` 拷到 `apps/wpe-scene/src/wpefont/wpefont.wasm`，内容相同不重写，缺失只告警（「文本对象会退回预览图，先运行 deno task build:wpefont」）。
- **修改** `build-system.ts` 在 `WpeSceneHostPlugin` 之前注册。

**点 5 — 宿主里的包装（新增 `apps/wpe-scene/src/wpefont/index.ts`、`index.test.ts`）**
- **新增**
  - URL 取法同锚点 a，缺失为 null。
  - 主线程 `fetch` → `WebAssembly.compile` → 实例化时给 `wasi_snapshot_preview1` 一组桩（`fd_write` 丢弃、`proc_exit` 抛错、`environ_*` / `args_*` 返回 0、`clock_time_get` 用 `performance.now`、`random_get` 用 `crypto.getRandomValues`、其余返回 `EBADF`），再调 `_initialize`。
  - 对外是 `Wpefont` / `WpefontFace`：`face(bytes, pointsize)`（`trunc(pointsize·64)`）、`has(cp)`、`metrics()`、`shape(codepoints)`、`glyph(gid)`（拷出位图，不暴露 wasm 内存）、`dispose()`。
  - 单测：wasm 不存在就整组跳过；`KABEGAME_WPE_ROOT` 指向 WPE 时，用 1a 已证明和 WPE 一致的结果做基线（RobotoMono、NotoSans、Arial、4 个 CFF 字体的若干字形：gid、步进、位图尺寸、位图 SHA-1），逐项相等。
```ts
export interface ShapedGlyph { gid: number; cluster: number; xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }
export interface GlyphBitmap { width: number; rows: number; left: number; top: number; color: boolean; pixels: Uint8Array }
export class WpefontFace {
  has(codepoint: number): boolean;
  metrics(): { ascender: number; descender: number; height: number; unitsPerEm: number };  // 26.6
  shape(codepoints: readonly number[]): ShapedGlyph[];
  glyph(gid: number): GlyphBitmap;
  dispose(): void;
}
```

**点 6 — 系统字体放行（修改 `wpe_scene_host.rs`）**
- **修改** `HostScope` 加 `font_grants: Vec<FileGrant>`；新增 `font_grants()`（只 Windows）：`%WINDIR%\Fonts` 下的 `arial.ttf`、`calibri.ttf`、`cambria.ttc`、`comic.ttf`、`consola.ttf`、`micross.ttf`、`segoeui.ttf`、`verdana.ttf`（`systemfont_*`，rea-p6b-raster 2.2）与 `seguiemj.ttf`、`arialuni.ttf`、`seguisym.ttf`、`msyh.ttc`、`Malgun.ttf`（回退链，2.3），不存在的跳过（`FileGrant::new` 返回 None）；`refresh_scene_host` 填、`host_scope_for` 并入；补单测。
```rust
#[cfg(windows)]
fn font_grants() -> Vec<FileGrant> {
    let Ok(windir) = std::env::var("WINDIR") else { return Vec::new() };
    let fonts = PathBuf::from(windir).join("Fonts");
    // systemfont_*（rea-p6b-raster 2.2）与回退链（2.3）用到的文件；只放行这几个，不放行整个目录
    SYSTEM_FONT_FILES.iter().filter_map(|name| FileGrant::new(&fonts.join(name), false)).collect()
}
```

**点 7 — 文档**：`scripts/AGENTS.md` 的命令清单、根 `AGENTS.md` 的命令列表、`cocs/wpe/WPE_SCENE.md`（字体引擎一节）、`cocs/README.md` 索引。

**验收（1b）：**
- `deno task build:wpefont` 在 Windows 上从干净缓存跑通（下载、校验、编译）；子模块版本的产物在 Node 里对 `p6b-*` 的对照和 1a 的发布包版本逐字节相同。
- `wpefont/index.test.ts` 全过；tsc、Prettier；`cargo check` / `cargo test`（`wpe_scene_host` 的单测）。
- CEF：dev 宿主里实例化 `wpefont`、加载一个 WPE 自带字体和 `C:\Windows\Fonts\arial.ttf`、栅格化几个字，结果和 Node 相同（核对 wasm 异常处理在 CEF 149 可用、系统字体放行生效）。

### 1b 实施记录（2026-11-12）

照点 1–7 做完，子代理实现，我核对、复跑。和计划不同的地方：

- `wpefont_glyph` 失败（gid 越界、字形坏）时返回 0、`pixel_mode` 写 −1，TS 的 `glyph()` 返回 null；`face()` 不是字体时也返回 null。`GlyphBitmap` 多一个 `mode`（单色按 1 位 / 像素拷出），`metrics()` 多一个 `forceAutohint`。trap 或 `proc_exit` 之后实例作废，之后的调用都报错。
- 像素框等于位图框：加载时带 `FT_LOAD_RENDER`，`FT_Get_Glyph` 拿到的是位图字形，`FT_Glyph_Get_CBox(PIXELS)` 在 342 个字形上都等于 `(left, top − rows, left + width, top)`，单测钉住了这个关系。**这不是 WPE 的格子框**：rea-p6b-raster 的加载标志表里，WPE 取框（`FUN_1401addb0`）是另一次 `FT_LOAD_NO_BITMAP`（8）加载的轮廓框。普通灰度字形两者相同；彩色字形、小字号下的内嵌点阵、两次加载 hinting 不同时会不同。1b 只把文档改准确，取轮廓框的导出放进 1c 点 3。
- 构建不经 `utils.ts` 的 `run`（Windows 上走 cmd.exe，会拆坏 `-DFT_CONFIG_MODULES_H="ftmodule.h"` 与带空格的 clang 路径），HarfBuzz 与链接用同一个 clang 加 `--driver-mode=g++`；Windows 上用 System32 的 bsdtar 解压。每次全量重编，约 40–60 s。
- 字形基线 `src/wpefont/fixtures/baseline.json`（9 个单行、不需要回退的对象，97 个字形，只存 SHA-1）由 `apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py` 从 1a 的 2.14.3 结果生成；同目录 README 登记了脚本。
- 根 AGENTS.md 要求的回归与 changelog 一并写了（`versions/latest/regression.md`「P6b 1b」T1–T11、changelog 开发侧一行）。

验证（我复跑的）：

| 项 | 结果 |
|---|---|
| `deno task build:wpefont` | 38 s，产物 1,850,118 字节，和子代理那次逐字节相同（构建可复现）；WASI 导入 13 个，同 1a |
| 和 1a 发布包比 | `ignore/p6/b1b/harness.mjs` 跑 `p6b-geom/align/fx/fallback/extra`，`b1a/compare.py` 对 `ft2.14.3/wasm-b.json`：38 个对象、342 个字形，字段不同：无，整数步进不同 0；cbox 与位图框不一致 0 |
| 宿主单测 | `src/wpefont` 带 `KABEGAME_WPE_ROOT` 14 passed；tsc 0 error；Prettier 通过；`scripts/` 的新文件过 deno fmt（`wpefont-plugin.ts` 我补格式化了一次；`build-system.ts` 在 HEAD 就不合格，没动） |
| Rust | `test-kabegame kabegame wpe_scene_host`（`target-check`）11 passed（新增 3、改 2）；子代理另跑了 `check-kabegame --skip vue` 0 error |
| CEF（dev，Chrome/149.0.7827.201） | 临时把 wasm 拷进 dev 宿主目录、开屏外宿主，用同一段探针在宿主和 Node 里各跑一遍：编译、实例化成功（exnref 可用）；NotoSans 32 号、NotoSans 200 号（大字形，光栅化器分带）、`arial.ttf`、`msyh.ttc` 的排字与位图哈希两边逐项相同；没放行的 `times.ttf` 被闸门拒（日志 `deny file: … OutsideRoot`，放行 188 项）。探针全程 61 ms。之后关宿主、删临时文件 |

没做：从干净缓存真实下载 119 MB 的 sysroot（这次预置了压缩包，`fetchPinned` 只用 756 KiB 的 libclang_rt 实测过下载、跳过、续传、坏 `.part`、错摘要五种情况）；macOS / Linux 构建；`deno task dev` 整条链上插件的拷贝（直接调过插件方法）。整个宿主 vitest 里 `compile/pipeline.test.ts` 的语料请求次数（`3830255100: 219 次请求`，上限 200）失败，`compile/` 正被别的会话修改，`wpefont` 在 `src/wpefont/` 之外没有引用，与 1b 无关。

### 1c — 排版与图集（新增 `apps/wpe-scene/src/text/`）

**点 1 — 字体与回退链（`text/fonts.ts`）**
- **新增** `TextFonts`：按「字体文件 + 字号」缓存 face 列表（主字体在前，回退字体按 WPE 的表顺序追加、加载过的永久留下，rea-p6b-raster 2.3）；字体字节由宿主注入的读取器提供（工程字体走 `SceneFs`，`systemfont_*` 与回退链走 `C:\Windows\Fonts`，Twemoji 走 WPE `assets`）。查字是同步的：某个回退字体还没读进来时记下「缺」，返回当前能用的结果，由调用方异步读完再排。
- 分段规则照 WPE：逐码点在已加载的 face 里找，找不到就按表加载下一项；相邻 face 不同就切段，空白与 ZWJ 不切段。

**点 2 — 排版（`text/layout.ts`）**
- **新增** `layoutText(fields, fonts): TextLayout`，逐条照 rea-p6b-layout 2–3 与 0c 的补充（离线参考 `ignore/p6/b0/ft_layout.py` 已和 WPE 逐坐标对上）：
  - 预处理：删 `\r`、按 `\n` 分段、尾部 `\n` 不成行；`limitrows` 时超出的段丢掉、最后一段去尾部空白、按需接「…」；
  - 逐行：每段 HarfBuzz 排字，笔位 `pen += (x_advance >> 6) + spacing.x`，字形四边形 = 位图框；
  - 断行：`limitwidth` 时按「笔位 + 墨迹右沿 > maxwidth」触发，往前找空白断词、找不到按字断；行满时加省略号逐字回退（接「…」前去掉前缀尾部空白）或在第一个越界的非空白字形处截断；
  - 行高 `(height >> 6) + spacing.y`，行内对齐，`blockalign` 两端对齐；
  - 包围盒（高至少「行数 × 行高」）、`padding`（有 effect、`colorBlendMode` 合成或背景时才加，钳到 512）、横纵对齐写进原点偏移。
```ts
export interface TextLayout {
  glyphs: LaidGlyph[];        // 普通字形：排版坐标的四边形 + 图集键
  colorGlyphs: LaidGlyph[];   // 彩色字形（BGRA）
  box: { minX: number; maxX: number; minY: number; maxY: number };
  size: [number, number];     // 文字框 + 2·padding（图层 size、合成 RT 尺寸）
  offset: [number, number];   // 对齐写进原点的偏移（+0x2f8 / +0x2fc）
  missingFonts: string[];     // 回退字体还没读进来
}
```

**点 3 — 图集（`text/atlas.ts`）**
- **新增** 照抄 WPE 的装箱器（rea-p6b-raster「装箱」与 `FUN_1401ae080` 的反编译，`ignore/p6/rea/text/raster/f_1401ae080.c`）：
  - 格子尺寸取 `FT_Glyph_Get_CBox` 的像素框（不是位图尺寸），按行（shelf）放，每行一张按 x 排序的格子表，在已有格子之间找第一个放得下的空隙（判定 `w ≤ 下一格.x0 − 上一格.x1`，起点 `上一格.x1 + 1`，**保留会和下一格重叠的那个差一**）；
  - 放下后清零四周各一行 / 一列（x 或 y 为 0 时清最后一列 / 一行）；
  - 满了先回收引用数为 0 的旧字形，再宽高翻倍（512 → 4096）、旧 UV × 0.5；
  - R8 与 RGBA8 两张，按「字体 + 字号」共享；记录脏区，供渲染层增量上传。
    > 说明：零尺寸字形（空格）在这套规则下会占位、清零相邻格子的边缘像素（1a 那 1 个像素）；照抄才能和 WPE 逐字节相同。
    > 说明：WPE 的格子框来自另一次 `FT_LOAD_NO_BITMAP` 加载的轮廓框（`FUN_1401addb0`，按 `faceIdx << 24 | glyph` 缓存），不是 1b `glyph()` 里那个等于位图框的 `cbox`。`wpefont` 补一个导出 `wpefont_glyph_box(font, gid, out)`：`FT_Load_Glyph(gid, FT_LOAD_NO_BITMAP [| FORCE_AUTOHINT])` → `FT_Get_Glyph` → `FT_Glyph_Get_CBox(PIXELS)`。带不带强制自动 hinting、彩色字形（框比位图小或大时位图怎么放进格子）、内嵌点阵三处用 WPE 图集定，测试工程加一个彩色 emoji 与一个小字号的雅黑。

**点 4 — 基线与单测（新增 `text/fixtures/p6b.json`、`text/*.test.ts`；新增 `ignore/p6/b0/make_fixture.py`）**
- **新增** 从 `ignore/p6/b0/out/rd/dump*.json` 与图集 PNG 生成小体积的基线：每个对象的四边形（排版坐标与 UV）、局部原点在场景里的位置、文字框、合成 RT 尺寸，每张图集的 SHA-256。单测在 `KABEGAME_WPE_ROOT` 与 wasm 都在时运行，逐项相等。

**验收（1c）：** `p6b-*` 的 45 个对象：四边形、原点、文字框、合成 RT 尺寸全部相同；15 张 WPE 图集的 SHA-256 全部相同（含 opensticks 那 1 个像素）。

### 1d — 静态文本的编译与渲染

**点 1 — 编译期文本表（新增 `compile/texts.ts`；修改 `compile/bundle.ts`）**
- **新增** `compileText(index, object, ctx): SceneText`：字段全表与缺省值（rea-p6b-layout 1.2），字体位置（工程 / pkg / `assets` / `systemfont_*`），文字初值（静态串、用户属性的值、字段脚本的 `value`），材质：照 passthrough 的写法用宿主指定的材质编 pass（`materials/fonts/basefont.json`、`basefontrgba.json`、开背景时 `fontbackground.json`，有 effect 时另编 `materials/util/composelayer_clearalpha.json`），槽 0 交给运行时（`planned: [{ slot: 0, format: 9 }]`，彩色为 0）。
- **修改** `SceneLayer` 加 `text: SceneText | null`；对象循环在「没有 image」之前加文本分支（锚点 c）。
```ts
export interface SceneText {
  fields: TextFields;          // text、font、pointsize、padding、spacing、对齐、maxwidth / maxrows、limit*、blockalign、背景
  font: SceneFontRef;          // 工程文件位置 | systemfont 名
  glyphPass: ScenePass;        // basefont
  colorPass: ScenePass;        // basefontrgba
  backgroundPass: ScenePass | null;
  clearAlphaPass: ScenePass | null;
}
```

**点 2 — 能力表（修改 `compile/features.ts`）**
- **修改** 仿 `isSoundObject` 加 `isTextObject`（`text: ""` 也算文本对象）；`TEXT_KEYS` 放开实现了的键；`msdf` / `outline` / `blur` / `dropshadow` 为真报 `text:msdf:<键>`；正交场景的 `depthtest` 中性（透视场景另由 `camera:perspective` 挡）；文本 pass 放行 `g_RenderVar0–3`（`TEXT_UNIFORMS`）。
- **新增** 1d 还没有动态文字：`text` 挂脚本报 `text:script`，绑用户属性的文字登记成重编译目标（改了整场重编译，结果仍对）。1e 删掉这两条。

**点 3 — 渲染（新增 `render/text.ts`；修改 `render/graph.ts`、`render/scene.ts`、`render/uniforms.ts`）**
- **新增** `render/text.ts`：每个文本层的 GPU 资源：两组逐字四边形的顶点 / 索引缓冲（按容量建，`writeBuffer` 更新，三角形列表）、图集纹理（R8 / RGBA8，按脏区 `writeTexture`）、背景四边形。新的纹理引用 `{ kind: "atlas", key }`，按 `resolveTexture` 的形状解析（锚点 g）。
- **修改** `graph.ts` 给文本层一个计划：
  - 直接上屏：背景（开时）→ 普通字形 → 彩色字形，各用自己的 pass 与 blend；
  - 有 effect 或 `colorBlendMode` 合成：合成 RT 先清成背景色或画 `composelayer_clearalpha`（初值是场景快照、alpha 清 0），再用 translucent 把两组字形画进去，然后接现有 effect 链；
  - `compositeSize` 与基础矩阵对文本层取 `TextLayout.size`（锚点 e）；
  - 字形绘制的平移：直接上屏 `(−w/2 − min(minX, 0), h/2 − maxY)` 加原点偏移，画进合成 RT `(pad.x − min(minX, 0), pad.y − minY)`（rea-p6b-layout 3.2–3.3）。
- **修改** `scene.ts`：拓扑与索引给文本绘制开三角形列表；`buildableLayers`、`planProblems` 认识文本层与图集引用；`g_Texture0Resolution` 跟图集尺寸走。

**点 4 — 宿主（修改 `host.ts`、`render/renderer.ts`）**
- **修改** `reload` 里在 `current.load` 之前：确保 `wpefont` 实例化、按 bundle 的文本表读主字体、预排一遍拿到要的回退字体并读好；`TextEngine` 经 `SceneRenderer.load` → `GpuScene.build` 传入（同粒子选项的传法），跨重编译保留。`wpefont` 缺失或实例化失败时，文本场景照报 `text:engine` 退回。

**验收（1d）：**
- `p6b-geom` / `-align` / `-wrap` / `-fx` / `-fallback` / `-extra`：用 `kabegame-dev` 渲染，和 WPE 抓帧比整帧（`kbp cmp frame`，按对象 bbox 归类），字形区域逐像素相同或只差混合的舍入（门槛按实测定，记进报告）。
- 语料：没有动态文字、其余键都已支持的场景解锁（数字以扫描为准）；现有 38 张逐张相同；`object:text` 系列键按预期减少。

### 1e — 动态文字

**点 1 — 字符串目标（修改 `compile/bindings.ts`、`render/state.ts`）**
- **新增** `BindingTarget` 加 `{ kind: "text"; object: number; field: TextField }`；`TextField` 是会触发重排的字段（`text`、`pointsize`、`padding`、`spacing`、对齐、`maxwidth`、`maxrows`、`limit*`、`blockalign`、`opaquebackground`），`backgroundcolor` 等只在绘制时读的走现有的就地路径。
- **修改** `SceneState` 加 `texts`（每个文本层的当前字段）与 `dirtyTexts`，`takeDirty` 多返回一项；字符串只在 `text` 目标上流通，`bindingValue` 对文本目标返回 `string`，其余目标的类型不变（锚点 h）。

**点 2 — 字段脚本（修改 `compile/scripts.ts`、`script/runtime.ts`、`host.ts`）**
- **修改** `targetOf`：`objects/<i>/text`（文本对象）→ `{ kind: "text", object, field: "text" }`，值类型 `string`；`writeReturn` 对 `string` 类型：字符串原样、数字等经 `String()`、`null` / `undefined` 不写（0c 实测）；`host.ts` 的 `targetPath` / `readScript` / `writeScript` 认 `text` 目标。

**点 3 — 重排（修改 `render/scene.ts`、`render/text.ts`）**
- **新增** `GpuScene.sync` 对脏文本层：`layoutText` → 图集脏区上传 → 重写两组顶点 → 文字框变了就重建这一层的合成 RT、更新图层尺寸与基础矩阵。值没变不重排（WPE 先逐项比较，rea-p6b-layout 3.5）。缺回退字体时异步读、读完再标脏。

**点 4 — 能力表**：删 `text:script` 与文字绑属性的重编译登记。

**验收（1e）：**
- `p6b-script`：计数器每帧变，抓帧比当帧画的数字（同 0c 的 `script_frame.py`）。
- `2391389126` 解锁，和 WPE 同一时刻的画面比（时钟取同一个字符串）；改用户属性不重编译。
- 每帧都变的文字：量 `sync` 里重排加上传的耗时，记进报告。

### 实施方式

每小步在 HEAD 快照里实现（`kbp snapshot`），交子代理，我核对、独立复跑验证后按块合进工作区，提交前等你同意。1b 不碰 P4e 在改的文件，可以先做；1c 只新增 `text/`；1d、1e 动共享文件，动工前对一次工作区。

## 步骤 2 — 脚本 API（细节待步骤 0 后补写）

`ITextLayer` 的字段装进文本层的脚本对象（照 `installSound` 的样板），写入落到就地目标、触发重排；从 `scriptApi.ts` 的缺口表里删掉实现了的字段。

## 风险

1. **wasm 工具链：** 1a、1b 已在 Windows 上用本机 clang + wasi-sdk 34 的 sysroot 编通（`wasm32-wasip1` reactor），CEF 149 能跑；Linux 构建 guest 与 macOS（要 Homebrew 的 llvm + lld）还没试。
2. **版本漂移：** WPE 内嵌的 FreeType 版本不明。2.13.2 加两条 hinting 规则对 12 种字体（含 4 个 CFF）逐像素一致，只有 opensticks（没有 hinting 表的 TrueType，走自动 hinter）3 个字形有残差，2.12.0 / 2.13.0 / 2.13.2 结果相同。推断 WPE 用的是改过自动 hinter 的更新版本；1a 自己编 FreeType 时按版本试。语料 80 种字体里大多没测，1a 之后拿语料字体补一轮。
3. **字体回退：** 回退链读 `C:\Windows\Fonts`，用户机器上缺 `arialuni.ttf`（随 Office 装）等文件时和 WPE 一样跳过；两台机器字体不同时画面本来就不同。
4. **重排的开销：** 82 张有时钟，一秒重排一次没问题；每帧都变的文字（滚动字幕之类）要实测 wasm 排字加图集上传的耗时。
5. **字体内存：** 最大的字体 25 MB，一张场景的字体可能几十 MB，预览和桌面各一份。
6. **和别的会话抢文件：** 步骤 1 要改 `compile/bundle.ts`、`compile/features.ts`、`compile/scripts.ts`、`render/scene.ts`、`render/graph.ts`、`host.ts`。P5b 正在改图像层的几何与合成 RT，动工前看一次另几边的工作区，新代码尽量放进新模块（`compile/texts.ts`、`text/`）。
7. ~~**读码工具：**~~ REA 一度连接超时，2026-11-11 用户重连后已恢复。

## 决定

**已定：**
1. 进入 P6b（2026-11-11 用户）。
2. 栅格化与排字用 FreeType + HarfBuzz 编成的 wasm，不用浏览器画布；画法照 WPE，逐字四边形加图集（2026-11-12 用户，按推荐）。1a 之后版本定为 FreeType 2.14.3、HarfBuzz 15.0.0。
3. MSDF 报 `text:msdf:<键>`、不做（2026-11-12 用户，按推荐）。
4. 正交场景的 `depthtest` 直接放开，透视场景随 P5d（2026-11-12 用户，按推荐）。
5. 宿主读 `C:\Windows\Fonts` 下回退链与 `systemfont_*` 的那几个文件，不随应用分发字体（2026-11-12 用户，按推荐）。
6. 字体引擎叫 **`wpefont`**，构建照推荐进仓库（2026-11-12 用户）：
   - **源码：** FreeType、HarfBuzz 照 `third/` 的惯例做成子模块（pin `VER-2-14-3`、`15.0.0`），补丁走 `third-patches/`（2.14 目前不需要补丁）。
   - **工具链：** 构建脚本按固定版本与 SHA-256 下载 `wasi-sysroot` 和 `libclang_rt` 到缓存目录，编译器用本机 LLVM clang（Windows 已有；Linux 构建 guest 要装；macOS 要 Homebrew 的 LLVM，Apple clang 没有 wasm 后端）。
   - **入口与产物：** 照 `build:wpesl2wgsl` 加 `deno task build:wpefont`，产物进 `bin/wasm/wpefont/` 再拷进场景宿主，不入库；缺失时文本对象照报不支持、不影响别的。
   - 1a 探针里的 C 胶水叫 `kbfont.c`，进仓库时一并改名。

**待定：** 无。步骤 1 的子计划细节（点、现状锚点、目标代码）动工前补写。
