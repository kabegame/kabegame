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

**动工前的实验（2026-11-12，`ignore/p6/b1c/`）：WPE 的字形框与图集格子各取什么。** 反编译里 WPE 取框（`FUN_1401addb0`）是 `FT_Load_Glyph(face, gid, 8)`，标志只有 `FT_LOAD_NO_BITMAP`，没有强制自动 hinting 的位（渲染那次也只有 `RENDER | COLOR`，opensticks 走自动 hinter 是 WPE 那份 FreeType 自己定的，两次加载一样）。`box.c` 在产品胶水上加一个按标志取框的导出，`boxes.mjs` 对 p6b 六个工程的全部字形（含省略号）算位图框与三组 NO_BITMAP 标志下的框，和抓帧里每个四边形的顶点尺寸、UV 格子比：

| | 普通字形（499 个 WPE 四边形） | 彩色 emoji（seguiemj 😀，p6b-fallback b1） |
|---|---|---|
| WPE 四边形尺寸 | 位图框 = 轮廓框（三组标志全一样，加不加强制规则也一样） | **141×142 = NO_BITMAP 轮廓框**（`21,-24,162,118`） |
| WPE 图集 UV 区域 | 等于四边形 | **133×132 = 位图尺寸**（`25,-19,158,113`），在 (0, 0) |

结论（和 rea-p6b-raster 3.2「格子 = 位图宽高」、rea-p6b-layout 2.4「字形四边形用 `FUN_1401addb0` 的边界」一致）：**几何一律用轮廓框**（四边形、断行的墨迹右沿、行与文字框的包围盒），**图集格子与 UV 用位图宽高**；两者不同时位图被拉伸到四边形上。普通字形两者相同，所以 0c 的离线参考（全用位图框）能对上。我们的轮廓框取法：`FT_LOAD_NO_BITMAP | (强制规则成立时 FT_LOAD_FORCE_AUTOHINT)`。没覆盖到、照读码推的：只有内嵌点阵的彩色字体（sbix / CBDT，`NO_BITMAP` 加载失败）、基础字形没有轮廓的 COLR 字体（框为空）、小字号下的单色内嵌点阵（WPE 按宽度当灰度拷，结果是乱码）。

**点 1 — 字体与回退链（`text/fonts.ts`）**
- **新增** `TextFonts`：按「字体文件 + 字号」缓存 face 列表（主字体在前，回退字体按 WPE 的表顺序追加、加载过的永久留下，rea-p6b-raster 2.3）；字体字节由宿主注入的读取器提供（工程字体走 `SceneFs`，`systemfont_*` 与回退链走 `C:\Windows\Fonts`，Twemoji 走 WPE `assets`）。查字是同步的：某个回退字体还没读进来时记下「缺」，返回当前能用的结果，由调用方异步读完再排。
- 分段规则照 WPE：逐码点在已加载的 face 里找，找不到就按表加载下一项；相邻 face 不同就切段，空白与 ZWJ 不切段。

**点 2 — 排版（`text/layout.ts`）**
- **新增** `layoutText(fields, fonts): TextLayout`，逐条照 rea-p6b-layout 2–3 与 0c 的补充（离线参考 `ignore/p6/b0/ft_layout.py` 已和 WPE 逐坐标对上）：
  - 预处理：删 `\r`、按 `\n` 分段、尾部 `\n` 不成行；`limitrows` 时超出的段丢掉、最后一段去尾部空白、按需接「…」；
  - 逐行：每段 HarfBuzz 排字，笔位 `pen += (x_advance >> 6) + spacing.x`，字形四边形 = 轮廓框（`WpefontFace.box`，见上面的实验）加 `x_offset >> 6`、`y_offset >> 6`；墨迹、断行、包围盒也都用它；
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
  - 格子尺寸取位图宽高（rea-p6b-raster 3.2，上面的实验），UV 是格子的像素矩形；按行（shelf）放，每行一张按 x 排序的格子表，在已有格子之间找第一个放得下的空隙（判定 `w ≤ 下一格.x0 − 上一格.x1`，起点 `上一格.x1 + 1`，**保留会和下一格重叠的那个差一**）；
  - 放下后清零四周各一行 / 一列（x 或 y 为 0 时清最后一列 / 一行）；
  - 满了先回收引用数为 0 的旧字形，再宽高翻倍（512 → 4096）、旧 UV × 0.5；
  - R8 与 RGBA8 两张，按「字体 + 字号」共享；记录脏区，供渲染层增量上传。
    > 说明：零尺寸字形（空格）在这套规则下会占位、清零相邻格子的边缘像素（1a 那 1 个像素）；照抄才能和 WPE 逐字节相同。
    > 说明：`wpefont` 补导出 `wpefont_glyph_box(font, gid, out)`：`FT_Load_Glyph(gid, FT_LOAD_NO_BITMAP | 强制规则)` → `FT_Get_Glyph` → `FT_Glyph_Get_CBox(PIXELS)`，TS 侧 `WpefontFace.box(gid)`，按「face + gid」缓存（WPE 按 `faceIdx << 24 | glyph` 缓存）。1b `glyph()` 里那个等于位图框的 `cbox` 删掉，免得两个框混用。
    > 说明：灰度位图逐行拷进 R8；BGRA 交换 R、B 成 RGBA、不反预乘（rea-p6b-raster 3.2）。单色内嵌点阵（`pixel_mode 1`）WPE 当灰度按宽度拷、画出乱码，我们照 WPE 的拷法照抄没有意义，展开成 0 / 255 并在实施记录里记为已知差异。

**点 4 — 基线与单测（新增 `text/fixtures/p6b.json`、`text/*.test.ts`；新增 `apps/wpe-scene/scripts/fixtures/make_text_fixture.py`）**
- **新增** 从 `ignore/p6/b0/out/rd/dump*.json` 与图集 PNG 生成小体积的基线：每个对象的四边形（排版坐标与 UV）、局部原点在场景里的位置、文字框、合成 RT 尺寸，每张图集解码后像素的 SHA-256。生成脚本照 1b 的惯例放 `scripts/fixtures/`、在同目录 README 登记。单测在 `KABEGAME_WPE_ROOT` 与 wasm 都在时运行，逐项相等；要读系统字体的对象（`systemfont_*`、回退链）在字体文件缺失时跳过。图集按「字体 + 字号」跨对象共享，单测按场景里的对象顺序把一个工程整个排一遍再比图集。

**验收（1c）：** `p6b-*` 的 44 个静态对象：四边形、原点、文字框、合成 RT 尺寸全部相同；静态工程的 21 张 WPE 图集（含 1 张彩色）解码后逐字节相同（含 opensticks 那 1 个像素）。`p6b-script` 的两帧图集随计数器变，1c 不比。

### 1c 实施记录（2026-11-12）

照点 1–4 做完，子代理实现。验收全部达成：44 个对象的四边形（排版坐标与 UV）、排版原点、文字框、合成 RT 尺寸和 WPE 相同，21 张图集（含彩色那张）解码后逐字节相同，opensticks「2」那 1 个像素也对上（空格的 1×1 格子按差一规则放在「1」「2」之间只有 1 列的空隙里，压在「2」的第一列上，清零下一行时清掉了 (32, 1)）。第一次跑就全过，所以另做了变异检查确认基线在比（见下表）。

**接口（和计划的形状不同处）：**
- `wpefont`：`wpefont_glyph` 回到 6 个 int；新导出 `wpefont_glyph_box(font, gid, out[4]) -> 0/非 0`（`NO_BITMAP | 强制规则`），TS `WpefontFace.box(gid): GlyphBox | null`，按 gid 缓存；`GlyphBitmap` 删掉 `cbox`。Twemoji 能复现「框 ≠ 位图框」（COLR，基础字形没有轮廓，框为空），单测加了这一条。
- `fonts.ts`：字体位置约定 `system:<文件>` = `%WINDIR%\Fonts\<文件>`，其余是引擎路径（先工程、再 WPE `assets`；回退链里的 Twemoji 是 `fonts/TwemojiMozilla.ttf`，走引擎路径，同 WPE）。`TextFonts(engine, read)`：`load(paths)` 异步读字节；`faceList` / `lookup` / `segment` 同步，缺字节时把路径记进 `missing`、不推进回退链。排版先对「截行之后的全部码点 + 可能接的省略号」预查一遍，缺字体就返回 `missingFonts`、**不碰图集**，调用方读完重排。查字结果只取决于「主字体 + 回退链里存在的文件」这个顺序，和加载先后无关，所以预查多加载的字体不改结果（只多占内存）。
- `layout.ts`：`layoutText(fields, fonts, atlases): TextLayout`，`TextLayout = { missingFonts, mesh: TextMesh | null, padding, size, compositeSize, offset }`；`TextMesh` 有 `glyphs` / `colorGlyphs`（`TextQuad`：排版坐标的左、下、右、上 + 图集字形的引用，**UV 不烤进去**，扩容后从字形读）、`box`、`lineHeight`、`rows`、`refs`；`releaseTextLayout` 减引用；`directTranslation` / `compositeTranslation` 是两条绘制路径的平移（`FUN_140258050` / `FUN_140257d70`）。`TextFields` 多两项 `visibleEffects`、`colorBlendMode`（决定加不加 `padding`）。`mesh.ts` 的 `textVertices` / `textIndices` 照 WPE 的顶点、索引布局，给 1d。
- `atlas.ts`：`TextAtlases`（按字体键）→ `FontAtlases { main, color }` → `GlyphAtlas`；`rasterizeGlyph` 是 `FUN_1401ae080` 的非 MSDF 路径；`generation`（扩容次数）与 `takeDirty()`（矩形或整张）给渲染层。

**照反编译补的规则（计划与 `ft_layout.py` 没写或写得不同）：**
1. **字形进图集的时机：** 逐行、逐段排字时每个字形先 `FUN_1401ae080` 进图集，再判断越界——越界的那个进了图集但不画；越界后这一段剩下的与后面的段都不碰；省略号回退量宽只取框（`FUN_1401addb0`），不进图集；重排的行（折行后、加省略号后）再排一遍，已在图集里的直接复用。对象按场景顺序。`p6b` 的图集里没有任何格子外的像素（`ignore/p6/b1c/work/atlas_cover.py`），解析期没有用缺省字体的中间排版。
2. **分段（`FUN_1401ad670`，读汇编）：** 每个码点都先查（空白、ZWJ 也查，可能触发加载回退字体），找到的 face 不同才切段，但 ZWJ 与 `\t \n \r` 空格不切；**还没有段时，开头的空白、ZWJ 与哪个字体都没有的码点不进任何段**（不排、不占步进）。`ft_ref.py` 把开头的空白放进第一段，p6b 里没有这种文字。
3. **行的包围盒**含零尺寸字形（空格在笔位置上，行末的空格会撑大右沿）；`ft_layout.py` 排除了它们。
4. **折行**往前找空白时包括下标 0；末尾去空白、后半段去开头空白用同一个掩码（`\t \r` 空格，`FUN_1401b0340`）。WPE 折行后只在断点「不能安全断开」（HarfBuzz `UNSAFE_TO_BREAK`）时重排这一行，否则直接截掉排好的字形；我们一律重排——按 HarfBuzz 的约定两者结果相同，重排时的字形都已在图集里。这样 `wpefont_shape` 不用多输出字形标志。
5. **省略号量宽**不加 `spacing.x`（只累加 `x_advance >> 6`），宽度是最后一个字形的右沿；前缀为空或已以「…」结尾时不改写，本行截在越界处、不画省略号。加了 `spacing.x` 时省略号行可能每次都越界，WPE 会死循环，这里一行最多重排 64 次。
6. **截行后的收尾**（`LAB_1401b205c`）：折行使行数超过 `maxrows` 时丢掉后面的行，最后一行去尾部空白、按开关接「…」（`FUN_1401b0360`）。
7. **尺寸**：图层 `size = (w + p) + p`，`p` 按 `512 ≤ p` 钳；合成 RT `trunc((p + p) + w)`，`p` 按 `minss` 钳（只在 NaN 上不同）；没有排版结果时 `size = 2 + 2p`、RT 1×1。全部 float32 逐步舍入。
8. **装箱器**另几处怪处（照抄）：非最后一行要 `h + 1 ≤ 行高`，所以同样高的字形用不上前面行里回收出来的格子；回收后行的最大空隙取 `max(原值, x1 − x0 + 1)`；翻倍后每行的最大空隙一律记成旧宽度；图集宽到 4096 还满时 WPE 清空每行的格子（行高不动、像素不清）、全部标成已回收再从头排，这张图集之后基本放不进东西。
9. **取框失败**（只有内嵌点阵的字体）时 WPE 沿用上一个字形的框（栈上的旧值），照做；没有实测。
10. **单色点阵**：WPE 不是「按宽度当灰度拷」，而是**根本不拷**（只认 `pixel_mode` 2 与 7），格子保持原样、字形画不出来。照计划展开成 0 / 255，记为已知差异。
11. 回退到 Twemoji 的 emoji 在 WPE 里是零尺寸四边形（框为空），看不见。

**验证（我跑的）：**

| 项 | 结果 |
|---|---|
| `deno task build:wpefont` | 成功，产物 1,850,248 字节，WASI 导入 13 个 |
| 位图不变 | `ignore/p6/b1c/work/harness.mjs`（1b harness 改新接口）+ `b1a/compare.py` 对 `ft2.14.3/wasm-b.json`：38 个对象、342 个字形，字段不同：无；新框只在 😀 上和位图框不同 |
| 单测 | `src/text src/wpefont` 带 `KABEGAME_WPE_ROOT`：34 passed（`layout.test.ts` 8、`atlas.test.ts` 8、`fonts.test.ts` 4、wpefont 14）；不带：10 passed、24 skipped |
| 变异检查 | 差一改成 `w + 1` → `p6b-extra` 挂；去掉下一行清零 → `p6b-extra` 挂；BGRA 不交换 → `p6b-fallback` 挂；纵向居中不乘 0.5 → 六个工程全挂；关两端对齐 → `p6b-wrap` 挂。右一列绕回清零、行末空格撑右沿、省略号量宽阈值改坏后基线仍过（抓帧覆盖不到），前两处由 `atlas.test.ts`、`layout.test.ts` 的读码用例钉住（改坏即挂） |
| 基线可复现 | `make_text_fixture.py` 重新生成、Prettier 后与仓库里的逐字节相同；PNG 自己解码，用 PIL 核对过 21 张图集的哈希 |
| tsc / 格式 | 本步文件 0 error；Prettier、`deno fmt` 通过。同轮 `src/render/events.test.ts` 有 1 个别的会话的错误 |
| 整个宿主 vitest | 1933 passed、1 failed（`compile/pipeline.test.ts` 语料请求次数，1b 时就在） |
| 耗时（Node） | 字体就绪后同一对象重排：9 字 0.03 ms、70 字两行带省略号 0.13 ms；新图集（含栅格化）1–2.7 ms |

**没做：** CEF 里跑 `text/`（还没有调用方，1d 接进宿主时做）；changelog 不在本步允许改的文件里，没写。字体字节按「字体 + 字号」各拷一份进 wasm 堆（`msyh.ttc` 19.7 MB，两个主字体都回退到它时有两份；WPE 按路径共享），1d 接宿主时看要不要加共享字节的导出。

**我复核的：**
- 重新 `build:wpefont`，产物与宿主里的副本逐字节相同；`src/text src/wpefont` 34 passed，详细输出里 6 个工程的用例都真跑了，没有因字体环境不同而跳过。vitest 要在大写盘符的目录下跑（`cd "D:/Codes/kabegame/apps/wpe-scene"`），`d:/` 小写盘符下三个测试文件报 `Cannot read properties of undefined (reading 'config')`，和代码无关。
- `make_text_fixture.py` 重新生成、Prettier 后与仓库里的 `p6b.json` 逐字节相同；图集哈希取自 RenderDoc 存下的 WPE 图集 PNG。
- 自己做的两处变异：差一判定改成 `w + 1` → `p6b-extra` 与合成用例挂；`box()` 改返回位图框 → `p6b-fallback` 与 wpefont 两个用例挂。改回后逐字节还原。
- 位图对 1a 的 2.14.3 结果仍字段不同：无；宿主 tsc 0 error；Prettier、`deno fmt`、LF 通过。
- 循环都有界：折行每次前进至少一个码点，省略号回退到前缀为空为止，图集满后的第二轮遇到放不下直接跳过，省略号重排有 64 次上限；测试里没有构造会让 WPE 死循环的输入。

### 1d — 静态文本的编译与渲染

> 2026-11-12 照 HEAD `def7408f` 与当时的工作区重写（P4e 事件、P5b 带子层的组合层、P7d 之后）。下面的行号是工作区的；`bundle.ts` 957 行之后比 HEAD 小 1。

#### 思路

1d 让文本层成为图像层的一种，画法照 WPE：基础 pass 不是一张贴图，而是两组逐字四边形（普通字形采样 R8 图集，彩色字形采样 RGBA8 图集，画在普通字形之后），开了 `opaquebackground` 时前面再画一个纯色背景。其余一切（变换、可见性、`color` / `alpha` / `brightness`、effect 链、`colorBlendMode`）走图像层现成的路。

**谁在哪里算。** 编译 Worker 只产文本表：排版字段、字体在哪里、四个宿主指定材质编出的 pass。排版要 wasm、字体字节与图集，放在宿主主线程：`SceneHost` 持有一个 `SceneTexts`（照声音播放器的写法，跨重编译保留 wasm 实例与读过的字体字节），每次加载按场景对象顺序把全部文本层排一遍，缺回退字体就读完再排，直到不缺；结果（每层的 `TextLayout` 与这次加载的 `TextAtlases`）经 `SceneRenderer.load` → `GpuScene.build` 的新选项交给渲染器。图集每次加载重新建（WPE 每次加载也是新的），这样装箱顺序、那 1 个像素都和 WPE 一样；1d 的文字不变，加载之后不再排版。

**尺寸来自排版，不来自 JSON。** WPE 运行时不用 JSON 的 `size`。文本层的「图层 size」（合成后上屏的四边形、`compose` 四边形、基础矩阵）用 `layout.size`，合成 RT 用 `layout.compositeSize`（WPE 截断取整、没有 `max(4, ·)`），对齐偏移 `layout.offset` 写进这一层的世界矩阵（局部平移，子对象跟着走，同 WPE 的 `+0x80`）。`GpuScene` 建层时对文本层用这几个值代替 `layer.size`。

**渲染图加一种步骤。** 现在一个图层只画一次基础 pass，文本要画三次、而且几何是动态的逐字四边形、要三角形列表和自己的索引缓冲——和粒子步骤是同一类东西，所以照 `particles` 步骤加一个 `text` 步骤（带 `part: "background" | "glyphs" | "color"`），而不是去扩 `DrawStep` 的几何种类：
- 直接上屏：`[text background] → text glyphs → [text color]`，三者的混合都是 `colorBlendMode == 31 ? additive : translucent`（rea-p6b-layout 4、5.1），画到场景目标，矩阵 = 本层 MVP（含对齐偏移）× 平移 `directTranslation`；
- 合成：RT 初值二选一——开了 `opaquebackground` 就 `clear` 成 `(背景色 × f, 图层 alpha)`（`clear` 步骤加颜色来源），否则 `snapshot` + `compose` 角色画 `composelayer_clearalpha`（场景快照、alpha 清 0，几何是 `layout.size` 的图层四边形，即 P5b 组合层那条路）；再画 `text glyphs` / `text color`（材质自己的 translucent，矩阵 = RT 像素的正交 × 平移 `compositeTranslation`）；之后 effect 链、passthrough 上屏照旧。

**图集是第一张运行时纹理。** 纹理引用加一种 `{ kind: "atlas"; color: boolean }`，按本层文本的字体键解析成 GPU 纹理（同一「字体 + 字号」的层共用一张）；建场景时整张上传，`sync` 按 `takeDirty()` 增量上传（1d 里加载后不会再脏，机制给 1e）。采样器照 WPE：线性过滤、repeat（rea-p6b-raster 3.2，装箱的「x 或 y 为 0 时清最后一列 / 一行」正是防 wrap 的写法）。

**颜色。** 字形 pass 的 `g_Color4` 就是图层现成的 `(color × k, alpha)`（`k` 是 HDR 时的 `brightness`，LDR 为 1），两条路径都一样；背景 pass 的 `g_Color` = `backgroundcolor × (HDR ? backgroundbrightness : 1)`、`g_Alpha` = 图层 alpha。

**1d 不做的：** 文字会变（脚本、绑属性的就地重排）是 1e；1d 里 `text` 挂脚本报 `text:script`，文字或排版键绑用户属性登记成重编译目标（改了整场重编译，结果仍对）。effect 的 `visible` 绑属性或挂脚本、又在文本层上的，切换会改 padding 与尺寸，1d 也登记成重编译。

#### 现状锚点

**a. 文本对象被拦两道**（`compile/bundle.ts:1270`；能力检查在对象循环之前，`:719`）
```ts
    // 声音对象（P6a 步骤 1）：图层上只有变换，播放字段进声音表；可见性不影响播放（p6-REPORT `p6a-misc`）
    if (isSoundObject(object)) {
      sounds.push(await compileSound(index, object, fs, properties, bindings));
      continue;
    }
    // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
    if (!object.image) continue;   // 现状：文本对象走到这里，图层没有 pass
```
`checkSceneFeatures` 先报 `object:text`，非 force 时 `settled()` 为真，循环第一轮就 `break`（`:1225`）。

**b. 宿主指定材质编 pass 只有内联写法**（`compile/bundle.ts:1368`，passthrough；组的上屏 `:1382` 同样写法）
```ts
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) unsupported.add(`material:missing:${path}`);
      else {
        layer.passthrough = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(cbm) } },
          { key: `objects/${index}/passthrough`, planned: [{ slot: 0 }] },
        );
        layer.passthrough.uniforms.g_Color4 = [1, 1, 1, 1];   // 材质值优先：就地刷新不覆盖
```

**c. 能力表里没有文本**（`compile/features.ts:494`）
```ts
  } else if (kind && kind !== "image" && kind !== "light" && kind !== "sound") unsupported.add(`object:${kind}`);
  ...
      !["alignment", "perspective", "model", "particle", "sound", "text", "light"].includes(key) &&
      !lightKey(key) && !soundKey(key) && ...
      unsupported.add(`object:${key}`);   // 现状：font、pointsize、horizontalalign、depthtest 等都报 object:<键>
```
`isSoundObject`（`:430`）、`SOUND_KEYS` / `soundKey` / `checkSoundFeatures`（`:447`–`:470`）是现成样板；`compilePass` 的程序检查只给粒子放行额外 uniform（`bundle.ts:1111`：`checkProgramFeatures(result, issues, context.particle ? PARTICLE_UNIFORMS : undefined)`）。

**d. 每层只画一次基础 pass；`clear` 只能清成 0**（`render/graph.ts:119`、`:369`；`render/scene.ts:2485`）
```ts
export type LayerStep =
  | DrawStep
  | ParticleStep
  | { kind: "snapshot" }
  | { kind: "copy"; effect: number | null; source: TextureRef; target: TargetRef }
  | { kind: "swap"; effect: number; source: string; target: string }
  | { kind: "clear"; target: TargetRef }          // 现状：没有颜色
  | { kind: "subtree"; target: TargetRef };
```
```ts
        } else if (op.kind === "clear") {
          end();
          const target = this.resolveTarget(op.target, op.resources);
          if (target) this.clearTarget(encoder, target, [0, 0, 0, 0], "clear composite");   // clearTarget 本身收颜色
```
直接上屏只有一个 `role: "direct"` 的 draw（`graph.ts:334`），合成路径的基础 pass 是 `fill` / `clear` / `compose` / `copy` 四选一（`:369`–`:408`），多 pass 报 `render:multi-pass`（`:300`）。

**e. 动态几何只有粒子**（`render/scene.ts:1485`、`:2416`、`:532`）
```ts
      if (step.kind === "particles") {
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
图像层的顶点是 `layerQuad(layer.size, uv, inset)` 经 `program.vertexPacking.pack` 打包（`pack` 收任意个 `QuadVertex`）；索引缓冲只有全场一份粒子的。

**f. 尺寸按编译期的 `layer.size`**（`render/graph.ts:152`；`render/uniforms.ts:282`；`render/scene.ts:1226`、`:1701`）
```ts
  const [w, h] = layer.fullscreenSize ? layer.fullscreenSize
    : texture && !layer.solidLayer && !layer.passthroughModel ? [texture.width, texture.height]
    : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  return [Math.max(4, Math.round(w)), Math.max(4, Math.round(h))];
```
`drawMatrices` 的 `base` 是按 `size` 居中铺满的正交，`direct` / `compose` 用图层 MVP；世界矩阵 `worldMatrixOf` 只读 `LayerState` 的 origin / angles / scale，没有局部偏移的入口。fbo 在加载时按 `compositeSize` 建。

**g. 没有运行时纹理**（`render/scene.ts:1345`、`:1568`；`render/textures.ts:113`）
```ts
    if (ref.kind === "composite") return resources.composites[ref.index] ?? null;
    if (ref.kind === "fbo") return this.targets[resources.fbos.resolve(ref.effect, ref.name)] ?? null;
    if (ref.kind === "framebuffer") return this.snapshot;
    return null;   // 现状：texture 种类在 createDraw 的 entries 里另走一支，没有图集
```
`writeTexture` 只在加载时的 `uploadTexture` 里出现；`g_Texture0Resolution` 在建 draw 时算一次（`scene.ts:1530`）。

**h. 宿主的跨重编译对象与加载入口**（`host.ts:589`、`:780`；`render/renderer.ts:289`）
```ts
    if (!this.sceneSounds) {
      this.soundPlayer = new ScenePlayer({ reader: this.reader }, this.options.report);
      this.sceneSounds = new SceneSounds(this.soundPlayer, Math.random, ...);
    }
    this.sceneSounds.load(sounds);
```
```ts
    const scene = await GpuScene.build(this.gpu.device, bundle, state, this.gpu.features, this.warnings, {
      ignoreUnsupported: options.ignoreUnsupported,
      particles: { passes: particlePasses(fps), fps, cursor: this.cursorOf(placement) },   // 现状：没有文本的入口
    });
```
`reload` 里 unsupported 判定（`:778`）与 `ensureRenderer`（`:788`）之间是插异步准备的地方（每个 `await` 后照现有写法比 `generation`）。`SceneState.fromBundle`（`render/state.ts:244`）只给 `layer.passes`、粒子树、effect、passthrough、`groupUpload` 登记材质常量。

#### 点 1 — 编译期文本表（新增 `compile/texts.ts`；修改 `compile/bundle.ts`）
- **新增** `compileText(index, object, ctx): SceneText`：
  - 字段全表与缺省值（rea-p6b-layout 1.2），规整成 `text/layout.ts` 的 `TextFields`；`text` 只收字符串或对象里的字符串 `value`，别的类型当空串（1.3）；枚举查不到取表里第一项。
  - 字体：`systemfont_*` 照 `text/fonts.ts` 的表；其余按资源查找顺序（散文件 → `scene.pkg` → WPE `assets`）定位，产出 `{ path, location }`（同 `SceneSound.files[].location`，宿主经 reader 读，pkg 条目按区间读）。找不到时照 WPE 用 arial（`fonts.ts` 已处理），不报错。
  - 材质：抽一个 `compileHostPass(path, combos, key, planned)` 小函数（照锚点 b），编 `materials/fonts/basefont.json`（`planned: [{ slot: 0, format: 9 }]`）、`basefontrgba.json`（`[{ slot: 0 }]`）、开 `opaquebackground` 且直接上屏时 `fontbackground.json`、要合成且没开 `opaquebackground` 时 `materials/util/composelayer_clearalpha.json`（槽 0 是快照）。正交场景一律用不带 `_depth` 的材质（5.4）。
  - 背景色：`g_Color` 写进背景 pass 的 `uniforms`（材质值优先，就地刷新不覆盖）；`backgroundcolor` / `backgroundbrightness` 绑属性时登记成这个 pass 的常量目标（就地），开合成时清屏色读同一份值。
- **修改** `SceneLayer` 加 `text: SceneText | null`；对象循环在声音分支后面加文本分支：
```ts
    // 文本对象（P6b 1d）：图层照常（变换、颜色、effect），基础 pass 换成文本表里的四个宿主材质；排版在宿主主线程
    if (isTextObject(object)) {
      layer.text = await compileText(index, object, textContext);
      // 不 continue：下面的 effect、colorBlendMode passthrough 与图像层同一段
    } else if (!object.image) continue;
```
  > 说明：文本层 `passes` 保持空，effect 与 passthrough 走图像层那段代码；凡是按「`passes.length > 0`」判断的地方（`buildableLayers` 等）都要认 `layer.text`。
- **修改** `SceneState.fromBundle` 给文本的四个 pass 登记材质常量。

```ts
export interface SceneText {
  fields: TextFields;
  font: { path: string; location: FileLocation | null };   // location 为 null：systemfont 或引擎路径，宿主自己找
  glyphPass: ScenePass;              // basefont
  colorPass: ScenePass;              // basefontrgba
  backgroundPass: ScenePass | null;  // fontbackground：直接上屏且 opaquebackground
  clearAlphaPass: ScenePass | null;  // composelayer_clearalpha：合成且没开 opaquebackground
  background: { color: [number, number, number]; brightness: number };
}
```

#### 点 2 — 能力表（修改 `compile/features.ts`、`compile/bundle.ts`）
- **新增** `isTextObject`（照 `isSoundObject`：`text` 成员在就算，`text: ""` 也算，rea-p6b-layout 1.1）、`TEXT_KEYS`、`textKey`、`checkTextFeatures`；`objectKind` 为 `text` 时不再报 `object:text`。
- **新增** 文本自己的键：
  - `msdf` / `outline` / `blur` / `dropshadow` 为真报 `text:msdf:<键>`；
  - `anchor` 是 `none` / `center` 以外的值报 `text:anchor:<值>`（`center` 在居中裁切下中性，其余要按铺放算可见区域的边，语料 23 个）；
  - `text` 挂脚本报 `text:script`，其它文本键挂脚本报 `text:script:<键>`（1e 删）；
  - 中性：`depthtest`（正交场景不选 `_depth`；透视场景本来由 `camera:perspective` 挡）、`size`、`alignment`（不在文本的查找链上）、`copybackground`（文本不看它）、装饰参数（`outlinethickness` 等，只在 MSDF 路径用）。
- **修改** `compilePass` 的程序检查给文本 pass 放行 `g_RenderVar0–3`、`g_Texture1`（`TEXT_UNIFORMS`，字体着色器声明了、普通路径不用）。

#### 点 3 — 渲染（新增 `render/text.ts`；修改 `render/graph.ts`、`render/scene.ts`、`render/uniforms.ts`、`render/state.ts`）
- **修改** `graph.ts`：
```ts
export interface TextStep {
  kind: "text";
  part: "background" | "glyphs" | "color";
  pass: ScenePass;
  /** direct：画到场景目标（图层 MVP × directTranslation）；composite：画进合成 RT（RT 像素正交 × compositeTranslation） */
  space: "direct" | "composite";
  target: TargetRef;
  blending: string;
}
export type LayerStep = DrawStep | ParticleStep | TextStep | ...
  | { kind: "clear"; target: TargetRef; color?: "text-background" };   // 新增：清成 (背景色 × f, 图层 alpha)
```
  - 直接上屏：`needsComposite` 为假时，文本层的计划是 `[text background] → text glyphs → [text color]`（没有彩色字形时不画），混合按思路一节；
  - 合成：基础 pass 位置换成「`clear`（`color: "text-background"`）」或「`snapshot` + `compose`（`clearAlphaPass`，`inputs[0]` 是快照）」，接着 `text glyphs` / `text color`（`space: "composite"`），然后 effect 链、passthrough 照旧；
  - `compositeSize` 对文本层取 `layout.compositeSize`（不套 `max(4, ·)`，至少 1）。计划不依赖排版结果的内容，只依赖「有没有彩色字形 / 背景」：签名里带上这两项。
- **新增** `render/text.ts`：每个文本层的 GPU 资源——普通字形、彩色字形、背景各一组顶点缓冲（`program.vertexPacking.pack`，位置 `(x, y, 0)` + UV）与索引缓冲（`text/mesh.ts` 的索引顺序，按字形数选 uint16 / uint32），三角形列表；图集纹理按字体键共享（R8 → `r8unorm`，RGBA8 → `rgba8unorm`，线性、repeat），建场景时整张上传，`sync` 按 `takeDirty()` 增量 `writeTexture`。
- **修改** `scene.ts`：`stepPipeline` 给 `text` 步骤开三角形列表；`buildableLayers`、`planProblems` 认文本层与 `atlas` 引用；`resolveTexture` / `createDraw` 的纹理分支认 `atlas`；`clear` 带 `text-background` 时颜色从文本表与本层 alpha 现算；对文本层用 `layout.size` 代替 `layer.size`（图层四边形、矩阵、fbo）。
- **修改** `uniforms.ts`：世界矩阵对文本层加局部平移 `layout.offset`；`text` 步骤的矩阵（直接上屏 = 图层 MVP × `directTranslation`，合成 = RT 像素正交 × `compositeTranslation`，两者都来自 `text/layout.ts`）。
- **修改** `state.ts`：文本层的运行时数据（本层 `TextLayout`、所属图集）放 `SceneState.texts`，照 `particleInstances` / `dirtyParticles` 的挂法预留 `dirtyTexts`（1e 用）。

#### 点 4 — 宿主（新增 `text/host.ts`；修改 `host.ts`、`render/renderer.ts`）
- **新增** `SceneTexts`：持有 `Wpefont`（`loadWpefont`）与 `TextFonts`（字体字节跨重编译保留）；`prepare(bundle)` 新建这次加载的 `TextAtlases`，按对象顺序对全部文本层 `layoutText`，有 `missingFonts` 就读完再排（读取器：主字体按 `SceneText.font.location`，`system:<文件>` 读 `file:///<WINDIR>/Fonts/<文件>`，其余引擎路径读 WPE `assets`）。
- **修改** `host.ts` `reload`：unsupported 判定之后、`ensureRenderer` 之前 `await this.texts.prepare(bundle)`，每个 `await` 后比 `generation`；wasm 不在或实例化失败时，有文本层的场景报 `text:engine` 退回（`fallbackAfterLoad`）。`SceneLoadOptions` 加 `texts`，`GpuScene.build` 的选项加 `texts`。

#### 验收（1d）
- **单测（Node）：** 文本层的计划（直接上屏有 / 没有背景与彩色字形、合成的两种初值、`colorBlendMode` 31 与合成）；假设备的编码轨迹（步骤、拓扑、索引数、矩阵）；用 1c 的 `p6b.json` 核对两条路径的平移与 RT 尺寸；能力表的键。
- **真机：** `p6b-geom` / `-align` / `-wrap` / `-fx` / `-fallback` / `-extra` 导入 dev 库，`kabegame-dev` 渲染，和 WPE 抓帧（`A:\p6b\…` 的 rdc，`kbp rdc frame`）比整帧（`kbp cmp frame`，按对象 bbox 归类）；字形区域逐像素相同或只差混合的舍入（门槛按实测定，记进报告）。在 CEF 宿主里跑通 `wpefont` + `text/`（1b、1c 没做的那一项）。
- **语料：** `kbp corpus scan` 比 HEAD 与改后：现有能渲染的逐张相同；`object:text` 系列消失、换成 `text:*`；数出解锁的场景。

#### 实施方式
子代理在 `kbp snapshot export HEAD ignore/p6/b1d/ov` 的副本里实现并跑单测（同时导出 `ignore/p6/b1d/head` 作基线；wpefont 的 wasm 不入库，要另拷进两份快照），做完 `kbp snapshot diff` 出补丁。我核对、复跑，`git apply --3way` 合进工作区，再重建 dev 的宿主产物（`KABEGAME_WPE_SCENE_OUT_DIR=target/debug/resources/wpe-scene`，`--mode development`）做真机与语料验收。

#### 1d 实施记录（2026-11-12）

照点 1–4 做完，子代理在 HEAD `a261a3b9` 的快照（`ignore/p6/b1d/ov`，基线 `ignore/p6/b1d/head`）里实现。补丁两份：
- `ignore/p6/b1d/step.patch`：对 HEAD（`849a094f` 的 `apps/wpe-scene/src` 与 `a261a3b9` 相同），+3080 / −151，改 10 个文件、新增 7 个（`compile/texts.ts`、`render/text.ts`、`text/fields.ts`、`text/host.ts` 与三个测试）；`git apply --cached --check` 通过。
- `ignore/p6/b1d/step-worktree.patch`：对导出时的工作区（别的会话没提交的 P4e 步骤 4 改了 `bundle.ts`、`host.ts`、`renderer.ts`，第一份补丁的上下文对不上）。三方合并（`diff3`，快照里做）只有 `renderer.ts` 一处冲突（`GpuScene.build` 的选项：取工作区的 `particles.audio`，再加 `texts`），合并结果 tsc 0 error、文本相关 8 个测试文件 144 个用例全过；生成时 `git apply --check` 通过。工作区还在变，合之前再查一次。

**实现：**
- **编译**（`compile/texts.ts`、`bundle.ts`）：`isTextObject` 的对象跳过模型，effect 与 colorBlendMode passthrough 照图像层编；`compileText` 排在它们之后（`padding` 看启用的 effect 个数）。字段照 WPE 的 setter 规整（`text` 只收字符串或对象的字符串 `value`、`font` 不是字符串保持缺省、枚举查不到取表里第一项、vec2 一个分量铺满、写成 `{value}` 的取 `value`）；主字体按资源查找顺序定位（`SceneFontFile`，`system:` 与找不到的位置为空）；四个宿主材质经 `compileHostPass` 编（字形槽 0 planned 格式 9，彩色字形槽 0 planned，程序检查放行 `TEXT_UNIFORMS`）；背景色 `g_Color` 写进背景 pass 的材质值，并登记成常量键 `objects/<i>/text/background`。
- **能力表**（`features.ts`）：`isTextObject`、`TEXT_KEYS`、`checkTextFeatures`（文本键挂脚本：`text:script` / `text:script:<键>`）、`checkTextOptions`（MSDF 四个开关 `text:msdf:<键>`，`anchor` 除 none / center 报 `text:anchor:<值>`）；文本对象不再报 `object:text` 与各文本键，`alignment` 在文本上中性；`groupChildIssues` 把文本层的 clearalpha 算作读快照。
- **渲染**：`graph.ts` 加 `TextStep`（`part`、`space`、`inputs`、`blending`）、`atlas` 纹理引用、`clear` 的 `color: "text-background"`、`TextPlanLayout` 与 `textCompositeSize`；`planLayer` 的文本分支（直接上屏 `[背景] → 字形 → [彩色字形]`；合成 `clear` 或 clearalpha 的 `compose` → 字形 → 照常的 effect 链 / passthrough / 上屏，上屏借 `basefont` 的 translucent、内缩分母是文字框整数部分）。`uniforms.ts` 的 `textMatrices` / `textUniformValues`（直接上屏 `VP · W · T(directTranslation)`，背景 `VP · W · T(−w/2 − pad.x, −h/2 − pad.y)`，合成 `ortho(0, W, 0, H, ±1000) · T(compositeTranslation)`）。`render/layout.ts` 的本地矩阵右乘 `T(offset)`（`LayerState.offset`，子对象跟着走）。`render/text.ts`：逐字四边形与背景四边形的顶点、uint16 索引（超过 16384 字形退 uint32）、`TextAtlasTextures`（每个 `GlyphAtlas` 一张 `r8unorm` / `rgba8unorm`，线性、repeat，建场景整张传，`sync` 传脏区）。`scene.ts`：文本 draw 带索引缓冲、三角形列表、`layerSize` 取排版尺寸（四边形、矩阵、fbo）、`clear` op 每帧按背景常量与图层 alpha 现算清屏色。`state.ts`：`texts`（`setTexts` 写排版与偏移）、文本 pass 与背景常量进常量表、文本层冻结。
- **宿主**（`text/host.ts`、`host.ts`、`renderer.ts`）：`SceneTexts` 跨重编译保留 wasm 与 `TextFonts`，每次加载新建图集，按对象顺序排、缺字体就读完重排（每对象最多 16 轮）；`reload` 在 unsupported 判定之后、声音与 GPU 资源之前准备，每个 await 后比代数；wasm 不在或排版出错抛 `text:engine`。`SceneLoadOptions.texts` → `GpuScene.build` 的 `texts`。

**和计划不同的地方：**
1. `SceneLayer.text` 是可选的（`text?: SceneText | null`，`compileScene` 总给 null 或文本表）：必填的话各处手写测试图层都要改（P5b 步骤 5 加 `instanced` 改了十几个测试文件），同 `bundle.sounds?` 的做法。
2. 图像层的模型部分搬进 `compileImageModel`（内容不变），循环里文本对象跳过它；`hasChildren` 移到外面。没把 passthrough / 组上屏改成用 `compileHostPass`（少动别的会话在改的行）。
3. `TextFields` 与 `TEXT_DEFAULTS` 拆到 `text/fields.ts`（`layout.ts` 原样再导出）：编译 Worker 只要它们，不必连带图集与 wpefont 的包装进 Worker。
4. 文本层 effect 的 `visible`：绑定目标仍是 `effect`，`SceneState.fromBundle` 把文本层当冻结的图层（切换 → `"recompile"`），属性与脚本两条路都整场重编译；`variantPlans` 对文本层返回空。计划写的是「登记成重编译目标」，效果相同，且覆盖了脚本 API 的写入。
5. 背景 pass 只要开了 `opaquebackground` 就编、clearalpha 只要「可能合成」（有任何 effect，含绑了属性的关着的，或 cbm ∉ {0, 31}）且没开背景就编，用哪个由渲染图按当时的开关选。
6. `backgroundcolor` 的就地写：LDR，或 HDR 下 `backgroundbrightness` 没绑属性且为 1 时，是背景常量的 `constant` 目标（类型 vec3，取值走材质 setter：数字铺满、字符串按空格切）；否则重编译。`backgroundbrightness` 只在 HDR 下读（绑了属性登记成重编译），LDR 下不读、不登记。合成路径的清屏色读同一份常量。
7. MSDF 开关与 `anchor` 按生效值（含当前用户属性）在 `compileText` 里查，绑了属性登记成重编译；`checkTextFeatures` 只管挂脚本的键。
8. 没预留 `dirtyTexts`：`DirtyState` 加字段会让 `render/p3a.test.ts` 的整体比较挂掉，1d 也没有写入者，留给 1e。
9. `TextStep` 多一个 `inputs`（图集引用），建 draw 时和别的步骤走同一条绑定路径。普通字形为 0 个（全是彩色字形）时不出 `glyphs` 步骤，WPE 这时画不画空网格没查。
10. 图集扩容后的纹理重建与网格重写留给 1e：`sync` 遇到尺寸变了只记一条警告。
11. 系统字体目录：宿主页面拿不到 `%WINDIR%`，`wpe_scene_target` 也不给。宿主的 `SceneTarget` 加了可选的 `fontsDir`（后端现在不填），缺省按 `C:\Windows\Fonts`；`WINDIR` 不在 C 盘时系统字体读不到（`file:` 闸门放行的是真实的 `%WINDIR%\Fonts`），按读不到处理（主字体换 arial 也读不到时整层不画）。建议后端在 `WpeSceneTarget` 加 `fonts_dir`。
12. 回退链里的引擎路径（Twemoji）只查 WPE `assets`，不查工程与 `scene.pkg`（WPE 先查工程；语料里没有工程自带 Twemoji 的）。
13. 文本层上的 effect 以前不编（文本对象在「没有 image」处就结束了），现在照图像层编，它们自己的不支持项随之出现在语料里（见下）。

**验证：**

| 项 | 结果 |
|---|---|
| tsc（`ov`） | 0 error |
| vitest（`ov`，带 `KABEGAME_WPE_ROOT`） | 82 个文件、2084 个用例：2083 过、1 失败（`compile/pipeline.test.ts` 的 `3830255100: 219 次请求`）；`head` 同样这一个失败（79 个文件、2031 个用例、2030 过），1b、1c 时就有 |
| 新增用例 | `compile/texts.test.ts` 14、`render/text.test.ts` 29、`text/host.test.ts` 10，带 wasm 与 WPE 的都真跑了（真翻译器编 WPE 自带的 `font` / `flat` / `composelayer` 四个材质，程序检查不报） |
| 矩阵对 WPE | `p6b-fx` 第 181 帧：f1 / f2 / f3 / f5 字形画进合成 RT、f4 背景与字形、f6 字形、f1 clearalpha 与上屏的 MVP，x、y、z 系数与平移相对误差 < 1e-6；`p6b.json` 六个工程 44 个对象经世界矩阵（含偏移）与 `textMatrices` 的排版原点、RT 里的原点、合成四边形中心、合成 RT、图层 size、上屏内缩、背景四边形全部相同 |
| 变异检查（`ignore/p6/b1d/mutate.cjs`） | 10 处全部检出：RT 平移 x / y 对调、直接上屏不加 `directTranslation`、背景不减 padding、忽略对齐偏移、cbm 31 不改 additive、清屏色恒 0、UV 顶点顺序、`verticalalign` 回退项、合成 RT 套 max(4, ·)、系统字体目录 |
| 格式 | 改动的文件 Prettier 通过，LF |

**语料**（`ignore/p6/b1d/corpus-head.json` → `corpus-ov.json`，`corpus-diff.txt`）：173 个场景，干净 47 → 47，新增无、掉出无；变化的 92 张都是文本场景。`object:text`、`object:font`、`object:pointsize`、`object:horizontalalign`、`object:verticalalign`（92 张）等文本键全部消失；新增 `text:script` 87 张、`text:script:maxwidth` 6、`text:anchor:*` 5 张（left 2、right 2、topright 2、top、topleft、bottomleft、bottomright 各 1，3643916956 一张占了 6 种）、`text:msdf:dropshadow` 2、`text:msdf:outline` 1；文本层上的 effect 带出 `uniform:g_AudioSpectrum16Left/Right` 4 张、`model:passthrough:children:framebuffer` 2 张、`combo:REFLECTION` 与 `material:alphawriting` 1 张（3498150384），这些场景本来就不干净。**解锁 0 张**：只剩 `text:script` 的是 `2304304373`、`2391389126`、`3824424509`（1e）；没有 `text:script` 的 5 张（3146703458、3605722997、3828324728、3830665420、dino_run）另有别的项。

**没做 / 要真机确认：**
- 真机渲染与整帧对比（`p6b-*` 导入 dev 库、`kabegame-dev` 渲染、`kbp cmp frame`）没做；CEF 里跑 `wpefont` + `text/` + 新的绘制也没做。
- 只在 Node 里对过矩阵与几何；要真机确认的是：字形与彩色字形的混合（translucent 逐字 over、cbm 31 的 additive）、彩色字形不反预乘的边缘、背景 `flat` 四边形与合成路径清屏色的实际颜色（清屏没有读过 WPE 的 Clear 值）、clearalpha 读到的快照与 alpha 清 0、合成 RT 采样（clamp，抓帧是 ClampEdge）、R8 图集按 `.r` 采样、线性 + repeat 在缩放旋转下的边缘。
- `anchor: center` 当中性是按「居中盖满时裁边相等」推的，留白样式（`fit` / `center`）下没查。
- 透视场景（`_depth` 材质）、MSDF、文字变化（1e）都不在 1d。

#### 1d 复核（Claude，2026-11-12）

- **越界**：工作区的 `apps/wpe-scene/src` 在合并前没有文本代码，子代理只写了 `ignore/p6/b1d/`。两份补丁的增删行完全相同，只差上下文；`step-worktree.patch` 合并前 `git apply --check` 通过，已应用到工作区。
- **读码**：编译、渲染图、矩阵、状态、宿主逐段读过，和点 1–4 一致。`compileImageModel` 是原样搬移（`hasChildren` 换成 `parents.includes(index)`，外层本来就在 `passthroughModel` 分支里，等价）。`freezeLayer` 只影响 effect 开关，文本层的变换、颜色照常就地写。
- **变异**：另做 12 处（`ignore/p6/b1d` 下的 `wtm` 快照，按原字节还原）。10 处检出，漏 2 处，已补用例：
  - `textIndexData` 的 uint16 / uint32 边界；
  - 背景四边形用 `compositeSize` 还是图层 `size`：测试夹具的文字框是整数，两者相等。把背景层的文字框改成带小数（149.5）后能区分。
  补用例后 12 处全部检出。
- **测试**：工作区 tsc 0 error；文本单测 6 个文件 74 passed；整个宿主 89 个文件 2191 passed、6 failed，都与本步无关（P7d 的 `conditions.test.ts` 4 个、P4e 的 `host.audio().raw` 1 个、已知的语料请求次数 1 个）。
- **dev 探针**：`render_scene` 走 `renderFrame`，它直接调 `GpuScene.build`，没排文本，报 `render:text-layout`。新增 `dev/probeTexts.ts`，`renderFrame` 建场景前同样排好，用完释放字体。
- **真机**（dev，CEF 149.0.7827.201，重建 dev 宿主产物；1d 之前宿主入口不引用 wpefont，产物里没有这份 wasm，现在有）：
  - 六个 `p6b-*` 工程按 1920×1080 渲染，和 WPE 上屏整帧比（排除 FR / CLK）：五个逐像素相同，`p6b-fx` 1 个像素差 1；
  - 宿主按产品路径加载 `p6b-fx` 后渲染，遮掉右下角的哈希和探针的结果相同；
  - 测完 `projects_remove` 移除了测试行。
- **语料排版**（`ignore/p6/b1d/layoutscan/`）：92 张文本场景在 Node 里用真 wasm 排版全部成功：981 层、8476 个字形，中位 5 ms、最慢 189 ms，46 层排版为空。
  - 主字体找不到的 3 张：`3000562427`、`3643916956` 的工程里确实没有这个文件，WPE 同样会退回 arial。
  - `2887099508` 要的是 `fonts/三极萌萌简体.ttf`，pkg 里有一个同样大小、名字乱码的条目（像是 GBK 编码的文件名），WPE 能不能按 UTF-8 路径找到没查。
- **遗留**：
  1. 后端在 `WpeSceneTarget` 加 `fonts_dir`（Windows 填 `%WINDIR%\Fonts`），宿主就不用写死 C 盘；
  2. pkg 条目名的编码（上面的 `2887099508`）；
  3. `anchor: center` 在留白样式下的裁边；
  4. 背景色绑属性的就地写，以及预览 / 桌面的实时显示，还没在真机上测（回归 T10、T11）。

### 1d2 — 系统字体按平台换成本机文件（2026-11-13 用户要求）

**总体设计思路**

文本的回退链与 `systemfont_*` 照 WPE 写死 Windows 文件名（`text/fonts.ts`），这一层不动：它决定的是「按什么顺序找字形」，和平台无关。平台差异只在「这个名字对应本机哪个文件」，交给后端：`wpe_scene_host.rs` 按平台把 13 个 Windows 字体名各解析成本机上第一个存在的文件，放行范围与交给宿主的表是同一次解析的结果，宿主读 `system:<名字>` 时查表，查不到就当读不到（同 WPE 的「文件不在就跳过」）。

- Windows：`%WINDIR%\Fonts\<名字>`，顺带解决 `WINDIR` 不在 C 盘（原先的 `fonts_dir` 待办）。
- macOS / Linux：每个名字一张候选表，先同一款字体（macOS `Supplemental/` 里自带的 Arial、Verdana 等，Linux 的 msttcorefonts），再字形度量兼容或外观接近的替代（Liberation、Carlito、Caladea、DejaVu、Noto CJK 等）。画面不会和 WPE 逐像素相同，只求「像」。候选路径没在真机上核对过，全部标 `TODO:[WPE_SCENE]`。
- 彩色 emoji 不给替代：Apple Color Emoji（sbix）与 Noto Color Emoji（CBDT）是内嵌 PNG，wpefont 没编进 libpng，FreeType 读不了；这两个平台的 emoji 交给链里后面的 Twemoji（COLR）。`arialuni.ttf` 只有 macOS 有同款（`Arial Unicode.ttf`）。

关键决策：表由后端给，而不是宿主按平台自己猜路径。放行范围必须和宿主要读的文件一致，两边各写一份迟早对不上；后端本来就要知道平台和文件是否存在。

**现状锚点**

a. 后端只在 Windows 放行，按 `%WINDIR%\Fonts`（`wallpaper/wpe_scene_host.rs`）
```rust
#[cfg(windows)]
fn font_grants() -> Vec<FileGrant> {
    let Some(windir) = std::env::var_os("WINDIR") else { return Vec::new(); };
    font_grants_in(&PathBuf::from(windir).join("Fonts"))
}
#[cfg(not(windows))]
fn font_grants() -> Vec<FileGrant> { Vec::new() } // 现状：其它平台一个系统字体都不放行
```

b. 宿主拿不到字体目录（`commands/wpe_scene.rs`、`apps/wpe-scene/src/text/host.ts`）
```rust
pub struct WpeSceneTarget { pub path: String, pub scene_assets: Vec<String> } // 现状：没有字体信息
```
```ts
const dir = this.sources.fontsDir || DEFAULT_SYSTEM_FONTS_DIR; // 现状：fontsDir 后端不填，恒为 C:\Windows\Fonts
return reader.readWhole(joinPath(dir, path.slice(SYSTEM_FONT_PREFIX.length)));
```

**点 1 — 后端按平台解析（`wallpaper/wpe_scene_host.rs`）**
- 新增 候选表 `WINDOWS`（只有文件名，目录取 `%WINDIR%\Fonts`）、`MACOS_SYSTEM_FONTS`、`LINUX_SYSTEM_FONTS`：每个 Windows 名字一组绝对路径候选，按优先级排；两张非 Windows 表不加 `cfg`，Windows 上也编译、可单测。
- 新增 `resolve_system_fonts(table, exists) -> BTreeMap<String, PathBuf>`：取第一个存在的候选；`exists` 注入，单测用假的文件集合。
- 修改 `HostScope` 存解析结果 `system_fonts`，`font_grants` 由它生成；新增 `pub fn system_fonts() -> BTreeMap<String, String>` 读 `HOST_SCOPE`。
```rust
// TODO:[WPE_SCENE] 在 macOS 上测试：候选路径没在真机核对；Office for Mac 的字体在 app 包里
const MACOS_SYSTEM_FONTS: &[(&str, &[&str])] = &[
    ("arial.ttf", &["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]),
    // …
];
```

**点 2 — 交给宿主（`commands/wpe_scene.rs`、`host.ts`、`text/host.ts`）**
- 修改 `WpeSceneTarget` 加 `system_fonts: BTreeMap<String, String>`（JSON `systemFonts`）。
- 修改 宿主 `SceneTarget` 的 `fontsDir` 换成 `systemFonts`；`TextFontSources` 加 `systemFonts`，`readFont` 有表就只查表（查不到返回 null），没有表（Node 单测、dev 探针）才按 `fontsDir ?? C:\Windows\Fonts` 拼。
```ts
if (path.startsWith(SYSTEM_FONT_PREFIX)) {
  const name = path.slice(SYSTEM_FONT_PREFIX.length);
  const table = this.sources.systemFonts;
  if (table) return table[name] ? reader.readWhole(table[name]) : null; // 新增：后端解析好的本机文件
  return reader.readWhole(joinPath(this.sources.fontsDir || DEFAULT_SYSTEM_FONTS_DIR, name));
}
```

**点 3 — 文档**：WPE_SCENE.md 的「字体引擎」「文本对象」两节、`src-tauri/wpefont/README.md` 更正「sbix / CBDT 栅格化成 BGRA」（没有 libpng 读不了）、回归与 changelog。

**验收**：Rust 单测（Windows 上跑：三张表都覆盖 13 个名字、取第一个存在的、放行与表一致、`%WINDIR%` 解析）；宿主单测（有表查表、表里没有返回 null 不回落、没表时按目录）；Windows dev 真机：`wpe_scene_target` 返回 13 项里本机存在的那些，重渲染 `p6b-fallback` 和 1d 结果逐像素相同。macOS / Linux 留给 `TODO:[WPE_SCENE]`。

#### 1d2 实施记录（2026-11-13）

**做了什么：**
- `wallpaper/wpe_scene_host.rs`：`SYSTEM_FONT_FILES`（13 个名字）去掉 `cfg`，成为所有平台共用的键表；新增 `MACOS_SYSTEM_FONTS`、`LINUX_SYSTEM_FONTS`（候选照用户给的表，顺序即优先级，各带一段 `TODO:[WPE_SCENE] 在 macOS / Linux 上测试：…`）、`windows_system_fonts(<WINDIR>\Fonts)`、纯函数 `resolve_system_fonts(table, exists)`、`platform_system_fonts()`（`cfg!` 选表，`WINDIR` 取不到时为空表）、`font_grants(&表)`、`pub fn system_fonts()`。`HostScope` 加 `system_fonts`，`refresh_scene_host` 解析一次、放行项由它生成（只放文件），另记一条 debug 日志列出本机没有的名字。
- `commands/wpe_scene.rs`：`WpeSceneTarget` 加 `system_fonts`（JSON `systemFonts`），读 `system_fonts()` 的内存表、不再解析：宿主能跑起来说明应用页已经取过宿主地址（`get_wpe_scene_host_url` 先 `refresh_scene_host`），启动时也解析过一次。
- 宿主：`host.ts` 的 `SceneTarget.fontsDir` 换成 `systemFonts`（只改这个字段与注释）；`text/host.ts` 的 `TextFontSources` 加 `systemFonts`，`readFont` 有表只查表（`Object.hasOwn`，名字原样），查不到返回 null；没表才按 `fontsDir || C:\Windows\Fonts`；文件头注释改写。`text/fonts.ts` 的 `FontPath` 注释补一句「宿主按后端的表换成本机文件，名字与顺序不随平台变」。
- 文档：`src-tauri/wpefont/README.md` 更正「COLR / sbix / CBDT 栅格化成 BGRA」（核对过：`FT_DEFS` 只有模块表，`third/freetype` 的 `ftoption.h` 里 `FT_CONFIG_OPTION_USE_PNG` 是注释掉的，`third-patches/freetype` 只有 README，`ttsbit.c` 遇到 PNG 字形报 `Unimplemented_Feature`）；`cocs/wpe/WPE_SCENE.md` 的「字体引擎」系统字体一行与「文本对象」两处；回归 T12–T15、changelog 一行。

**和计划不同的地方：**
1. 产品里的「存在」是「普通文件、本身不是符号链接」（`is_grantable_font` = `FileGrant::new(path, false).is_some()`），不是只看存在：`file:` 闸门不认符号链接（`check_file_request` 对链接报 `Symlink`），表里每一项都要能放行、宿主都读得到，才谈得上「放行与表一致」。Debian msttcorefonts 的小写文件名是链接时会落到首字母大写的那条（候选表本来两种写法都列）。
2. 没有常量表 `WINDOWS`：Windows 的候选由 `windows_system_fonts(fonts)` 按键表现生成（每个名字一个），所以 `resolve_system_fonts` 的表参数是泛型（`IntoIterator<Item = (&str, C)>`，`C` 的元素 `AsRef<Path>`），静态表传 `.iter().copied()`。
3. 平台选择用 `cfg!()` 而不是 `#[cfg]`：三张表在所有平台都被引用，不需要 `allow(dead_code)`。
4. dev 探针（`dev/probeTexts.ts`）与 `scripts/kabegame-dev/scene.ts` 的 `SceneTarget` 没改：探针仍不传 `systemFonts`、按 `C:\Windows\Fonts` 读（计划本来就留了这条路），只在 Windows 上对。
5. 两个 Rust 文件跑了 `rustfmt`（原文件有一处既有格式差异，正好在被替换掉的旧用例里，没有改到别的代码）。

**测试：**

| 项 | 结果 |
|---|---|
| Rust（`test-kabegame`，`CARGO_TARGET_DIR=target-check`，`kabegame --lib wpe_scene`） | 17 passed / 0 failed（`wpe_scene_host` 15 个，含新的 `every_platform_table_covers_every_name`、`unix_candidates_are_absolute_font_files`、`resolve_takes_the_first_existing_candidate`、`color_emoji_has_no_substitute_off_windows`、`font_grants_match_the_resolved_table`、`windows_names_ignore_case`、`windows_system_fonts_stay_in_the_windows_fonts_dir`；`commands::wpe_scene` 2 个）。`#[cfg(unix)]` 的 `symlinked_candidates_are_skipped` 在 Windows 上不编译、没跑 |
| 宿主 tsc | 0 error |
| vitest（`src/text src/render/text.test.ts src/compile/texts.test.ts`，带 `KABEGAME_WPE_ROOT`） | 6 个文件 77 passed（1d 的 74 + 新增 3：有表按表读、表里没有 / 空表返回 null 且不读目录、没表按目录） |
| 格式 | 改动的 TS 文件 Prettier 通过，两个 Rust 文件 `rustfmt --check --edition 2021` 通过，LF |

**没做：** Windows dev 真机（`wpe_scene_target` 的返回、重渲染 `p6b-fallback`）留给用户；macOS / Linux 真机（`TODO:[WPE_SCENE]`，回归 T14、T15）。`cocs/wpe/WPE_SCENE.md` 场景宿主一节（`file:` 闸门那段）还写着「Windows 上文本对象要读的 13 个系统字体文件」，那一节有别的会话在改，没动。

#### 1d2 复核（Claude，2026-11-13）

- 读过 Rust 与 TS 的全部改动：候选表与计划逐条相同；放行项与交给宿主的表出自同一次解析；宿主有表时只查表、查不到不回落。「存在」按 `FileGrant::new` 判（普通文件、不是符号链接）是对的：`file:` 闸门拒符号链接，表里的每一项才都读得到。
- 复跑：`kabegame --lib wpe_scene`（`CARGO_TARGET_DIR=target-check`）17 passed；宿主 tsc 0 error；文本测试 6 个文件 77 passed。
- Windows 真机（dev 后端在改动之后重编、重启，宿主产物重建）：`wpe_scene_target` 返回 12 项（本机没装 `arialuni.ttf`），应用日志「解析到 12 个，本机没有 ["arialuni.ttf"]」；`p6b-fallback` 按产品路径加载后渲染，整帧哈希与 1d 相同。
- 顺手改了 WPE_SCENE.md 场景宿主一节里「Windows 上文本对象要读的 13 个系统字体文件」那句。dev 探针（`dev/probeTexts.ts`）仍按 `C:\Windows\Fonts` 读，只在 Windows dev 上用，没改。
- macOS / Linux 的候选路径都没核对，见代码里的 `TODO:[WPE_SCENE]` 与回归 T14、T15。

### 1e — 动态文字（2026-11-13 按 HEAD `8ab0b58a` 重写，调研笔记 `ignore/p6/b1e/research.md`）

**总体设计思路**

1d 的文本是「加载时排一次、之后不变」。1e 让文字在运行中变：字段脚本的返回值（时钟、计数）和用户属性（`textinput` 改文字、`slider` 改字号）写进一份「当前排版字段」，和上次排版用的值逐项比较，变了才重排，同 WPE（`FUN_140256f20` 开头的比较表，rea-p6b-layout §3.5）。脚本写回在帧内第二次 `sync` 里重排，当帧生效；属性写在两帧之间，下一帧生效，都不整场重编译。

数据流分三段。第一段是**字符串通道**：新增绑定目标 `{ kind: "text", object, field }`，字符串只在这种目标上流通。脚本侧按 WPE 的 `ToString` 规则（`null` / `undefined` 不写），属性侧按 JSON setter（`text` 只收字符串）；`text` 字段脚本的 `valueType` 定成 `"string"`，不再按初值猜。第二段是**状态**：`SceneState` 存每个文本层的当前 `TextFields`，写入时按字段规整、和现值比较，变了才标 `dirtyTexts`。第三段是**重排与重建**：宿主的 `SceneTexts` 在加载后不再丢掉图集，变成一个「重排器」交给 `GpuScene`；`sync` 先处理脏文本层（释放旧排版的字形引用 → 排新的 → 换进 `state.texts`、改对齐偏移），再把这一层按新排版强制重建（新 draw、新顶点索引；合成 RT 或 effect fbo 尺寸变了就换；图集扩容了就重建纹理、引用它的层一起重建）。

关键决策：
- **重排后整层重建 draw**，不另写「只改顶点」的路径。重建只是几个缓冲和 bind group，每秒一次的时钟可以忽略；每帧都变的只有 2 张场景（34 个对象），1e 量出耗时再说。这样合成 RT 尺寸变、步骤增减（空 ↔ 非空、第一次出现彩色字形）、图集换纹理都走同一条路。
- **文本层的合成 RT 与 effect fbo 由本层独占**，不进共享池：尺寸会随文字变，共享池只增不减，按尺寸共享的话时钟每分钟换一个宽度就会一直攒新 RT。独占后尺寸变了就销毁重建，内存有界（WPE 也是每次重排重新分配，rea-p8-layer `+0xb8`）。
- **加载时为文本层预备全部可能的步骤的管线**（普通字形、彩色字形、背景、clearalpha、上屏），`variantPlans` 对文本层按「两种字形都有」的假想排版给出计划。管线和尺寸、字数无关，这样运行中步骤增减不会碰到 `render:variant-missing`。
- **缺字体异步读**：帧循环里不能等。重排发现缺字体时保留旧排版（把刚释放的引用加回去），宿主读完字体把这一层标脏，下一帧补上；WPE 是同步读，所以第一次出现新回退字时我们会晚一到几帧（见待定 4）。

**现状锚点**

a. 文本键的字段脚本落到 `unsupported`，`valueType` 按初值猜（`compile/scripts.ts:65-90`）
```ts
function valueType(initial: SceneScalar): ValueType | "string" {
  if (typeof initial === "string") {
    const parts = initial.trim().split(/\s+/);
    if (parts.length === 2) return "vec2";   // 现状："Song Title" 被当成 vec2，update(value) 收到 Vec2(NaN, NaN)
    // …
  }
  return "string";
}
function targetOf(path, owner, key, initial, sound): SceneScript["target"] {
  if (owner.kind === "layer" && key in layerTypes) return { kind: "layer", /* … */ };
  // …
  return { kind: "unsupported", path };      // 现状：objects/<i>/text、/pointsize、/maxwidth 都到这里
}
```

b. 脚本写回整条链只认 `number[] | boolean`（`script/runtime.ts:78`，另有 `ScriptApi.write`、宿主 `writeScript` / `readScript` / `scriptOverrides` 同型）
```ts
private writes = new Map<string, { target: ScriptTarget; value: number[] | boolean }>(); // 现状：没有 string
```

c. 文本排版字段绑属性登记成整场重编译（`compile/texts.ts`）
```ts
const recompile = (key: string): BindingTarget => ({ kind: "recompile", reason: "layer-structure", path: `objects/${index}/${key}` });
const read = (key: string, target: BindingTarget = recompile(key)): unknown => { /* 现状：text、pointsize 等都走 recompile */ };
```

d. `SceneState.write` 的分支按目标种类排，最后一个兜底是泛光（研究笔记 A5）——新增目标种类不显式处理会写坏泛光参数。

e. 运行中重建只有 effect 开关一套：签名相同就不动，管线只从加载时备好的表取，合成 RT 只增不换（`render/scene.ts:2075-2097`、`1125-1136`、`1053-1080`）
```ts
const signature = planSignature(plan);
if (signature === runtime.signature) return;             // 现状：直接上屏的文本换了字，签名不变
// preparedOf：缺管线抛 render:variant-missing
composites.push(...pool.slice(composites.length, count)); // 现状：已有的 RT 不换成新尺寸的
```

f. effect fbo 只在 `populate` 里按加载时的尺寸建，池是局部变量（`render/scene.ts:1321-1387`）
```ts
const fboPool = new Map<string, number>();  // 现状：populate 返回后拿不到，运行中没法按新尺寸建
```

g. 图集纹理尺寸变了只记警告（`render/text.ts:115-126`）；`TextAtlases` 是 `SceneTexts.prepare` 的局部变量，`releaseTextLayout` 没有调用方（`text/host.ts:90`、`text/layout.ts`）
```ts
const atlases = new TextAtlases();       // 现状：prepare 返回后没人持有，运行中重排拿不到同一套图集
```

h. 文本层不预备变体（`render/graph.ts:663-665`）
```ts
if (layer.text) return [];               // 现状：运行中步骤增减时没有备好的管线
```

**点 1 — 文本目标与字符串通道（`compile/bindings.ts`、`compile/scripts.ts`、`compile/texts.ts`、`script/runtime.ts`、`script/api.ts`、`host.ts`）**
- **新增** `BindingTarget` 加文本目标，`TEXT_RUNTIME_FIELDS` 是运行中可改的排版字段（比较表里除 `font`、`opaquebackground` 以外的，见待定 3）：
```ts
/** 运行中可改、改了要重排的文本字段（WPE 比较表 f_140256f20.c:55-80）。 */
export const TEXT_RUNTIME_FIELDS = ["text", "pointsize", "padding", "spacing", "maxwidth", "maxrows",
  "limitwidth", "limitrows", "limituseellipsis", "blockalign", "horizontalalign", "verticalalign"] as const;
export type TextRuntimeField = (typeof TEXT_RUNTIME_FIELDS)[number];
  | { kind: "text"; object: number; field: TextRuntimeField }   // 新增
```
- **新增** `text/fields.ts` 的两个规整函数，取值规则只写一份：`textFieldFromJson(field, raw)`（属性侧，同 `compileText` 的 setter：`text` 只收字符串，返回 `undefined` 表示不写）与 `textFieldFromScript(field, value)`（脚本侧：`text` 是 `null` / `undefined` 不写、字符串原样、其余 `String(value)`；数值、向量、布尔、枚举同属性侧）。`compileText` 改用 `textFieldFromJson`，结果不变。
- **修改** `compileText`：`TEXT_RUNTIME_FIELDS` 里的键绑属性时登记文本目标，不再 `recompile`；`font`、`opaquebackground`、MSDF 开关、`anchor`、`backgroundbrightness` 照旧。
- **修改** `targetOf`：文本对象的 `objects/<i>/<TEXT_RUNTIME_FIELDS 之一>` → 文本目标；`valueType`：`text` 定成 `"string"`，数值键 `"float"`，向量 `"vec2"`，布尔 `"bool"`，枚举 `"string"`。
- **修改** 写回链的值类型加上 `string`：`ScriptRuntime` 的 `write` / `read` 回调与 `writes` 重放表、`ScriptApi.write`、宿主 `writeScript` / `readScript` / `scriptOverrides`、`targetKey` / `targetPath`（文本目标的键 `objects/<i>/<field>`，显式分支，不落到兜底）。`writeReturn` 对 `"string"` 不再 `return`，交给 `textFieldFromScript`。

**点 2 — 状态：当前字段与逐项比较（`render/state.ts`）**
- **新增** `textFields: Map<number, TextFields>`（`fromBundle` 取编译期的 `SceneText.fields`），`dirtyTexts: Set<number>`，`takeDirty` 多一项 `texts`。值在来源处规整好再写：属性走 `write` 的文本分支（`textFieldFromJson`），脚本走 `writeText`（宿主 `writeScript` 先 `textFieldFromScript`）；`needsRecompile` 对文本目标恒为假，`write` 的文本分支写在兜底之前：
```ts
/** 文本字段的写入：value 已按来源规整（undefined 表示不写）。值没变不标脏、不重排（同 WPE 的逐项比较）。 */
writeText(object: number, field: TextRuntimeField, value: TextFields[TextRuntimeField] | undefined): void {
  const fields = this.textFields.get(object);
  if (!fields || value === undefined || sameTextField(fields[field], value)) return;
  (fields as Record<TextRuntimeField, unknown>)[field] = value;
  this.dirtyTexts.add(object);
}
// write(binding, raw) 里：
if (target.kind === "text") {
  this.writeText(target.object, target.field, textFieldFromJson(target.field, raw));
  return "applied";
}
```
- **修改** `render/p3a.test.ts` 里整体比较脏状态的用例补 `texts`。
- **新增** `setText(object, layout)`：换排版结果、写对齐偏移，偏移变了把本层与子孙标进 `dirtyLayers`（矩阵要重写）。

**点 3 — 重排器（`text/host.ts`、`text/layout.ts`、`text/atlas.ts`）**
- **修改** `SceneTexts.prepare` 把这次加载的 `TextAtlases` 留在实例上（新加载换新的），并实现：
```ts
export interface TextRelayouter {
  /** 按新字段重排一层：先放旧排版的字形引用再排（同 WPE「先放旧、再排新」）；缺字体时把引用加回去、返回 null，
   *  后台读字体，读完调 onReady(object)（宿主把这一层标脏、暂停时补画一帧）。 */
  relayout(object: number, fields: TextFields, previous: TextLayout): TextLayout | null;
}
```
- **新增** `retainTextLayout`（`releaseTextLayout` 的反操作）；`GlyphAtlas` 加 `resets` 计数（到 4096 重置时加一），渲染器据此找出要连带重排的层（待定 5）。
- 字体读完时比加载代数，场景已换就丢掉；`dispose` 时取消回调。

**点 4 — 渲染器：文本层运行中重建（`render/scene.ts`、`render/graph.ts`、`render/text.ts`、`render/renderer.ts`）**
- **修改** `GpuScene.build` 选项加 `relayout?: TextRelayouter`；`sync` 最先处理 `dirty.texts`：
```ts
const rebuild = new Set<number>();
for (const object of dirty.texts) {
  const layout = this.relayout?.relayout(object, state.textFields.get(object)!, state.texts.get(object)!);
  if (!layout) continue;                         // 缺字体：旧排版照画，读完再来
  state.setText(object, layout);
  rebuild.add(object);
}
for (const atlas of this.atlasTextures.sync()) // 新：返回尺寸变了、重建了纹理的图集
  for (const object of this.textLayersUsing(atlas)) rebuild.add(object);
for (const object of rebuild) this.rebuildLayer(this.runtimeByObject.get(object)!, state, worlds, { force: true });
```
- **修改** `rebuildLayer` 加 `force`（签名相同也重建）；文本层重建前先 `ensureTextResources`：合成 RT 与 effect fbo 由本层独占（建场景时也一样），尺寸和新排版的 `compositeSize` 不同就销毁旧的、建新的；`resources.atlases` 按新排版重新取。fbo 的创建从 `populate` 抽成方法，非文本层仍用共享池，行为不变。
- **修改** `variantPlans`：文本层按「普通字形与彩色字形都有」的假想排版给计划（尺寸取当前排版），`prepareVariants` 为它备好管线。
- **修改** `TextAtlasTextures.sync`：尺寸变了就销毁旧纹理、按新尺寸建并整张上传，返回这些图集；`get` 按当前尺寸取。
- **新增** dev 计数：每帧重排的层数与耗时（`GpuScene.textStats()`，探针 `host.texts()` 读），给验收量耗时。

**点 5 — 能力表与 dev 探针（`compile/features.ts`、`compile/scriptApi.ts`、`dev/scriptValues.ts`、`dev/probeTexts.ts`）**
- **修改** `checkTextFeatures`：`TEXT_RUNTIME_FIELDS` 里的键挂脚本不再报；`text:script:font`、`text:script:opaquebackground` 等照报。`text:script` 键整体去掉。
- 脚本 API 检查不改（已定 1）。
- **修改** 探针的 `scriptValues` 收文本目标（`objects/<i>/text` → 字符串），`renderFrame` 带上重排器，能按指定字符串渲染一帧和 WPE 比。

**点 6 — 文档**：WPE_SCENE.md「文本对象」一节（运行中重排、独占合成 RT、异步字体、已知差异）、cocs/README.md 条目、回归、changelog。

**验收**
- 单测：
  - 两套规整规则（`ToString`、`null` 不写、属性侧非字符串不写、枚举回退、向量铺满）；
  - `text` 的 `valueType` 恒为 `"string"`（拿语料里 `"Song Title"` 这类初值测）；
  - 值没变不标脏；重编译后字符串写入能重放；
  - 假设备上：直接上屏换字（新 draw、索引数对）、合成路径换尺寸（RT 与 fbo 换成新尺寸、旧的销毁）、空 → 非空、第一次出现彩色字形（不报 `render:variant-missing`）、图集扩容（纹理重建、bind group 绑新纹理、同图集的另一层也重建）、缺字体（旧排版保留、引用数复原、读完后重排）。
- 真机（Windows dev）：
  - `p6b-script` 的 s1（`'F' + n`，每帧变）：探针按 `scriptValues` 渲染「F183」，只比 s1 所在区域，和 WPE 第 182 帧逐像素比（s2 / s3 是步骤 2 的 API）；在预览里实时跑，量每帧重排耗时；
  - `2391389126`：WPE 抓一帧，按它画出的时间字符串渲染我们的一帧逐像素比；
  - `2304304373`：属性面板改 `textinput` 与 `pointsize`，`stats.recompiled` 不增加、画面跟着变；带 `blurprecise` 的时钟换宽度时合成 RT 与 fbo 跟着换；
  - 语料：`text:script` 消失，记下解锁数（预期 `2391389126`、`2304304373`，`3824424509` 看待定 1）；
  - 待定 2 的 WPE 实验。

**拆步**（每步在 HEAD 快照里交子代理，我核对、复跑、真机验收后再进下一步）
- **1e-1**：点 1、点 2，只有单测（字符串通道与状态，不碰渲染器）。点 1 里 `compileText` 把属性绑定从 `recompile` 换成文本目标那一条留到 1e-2：渲染器还不会重排时就换，1e-1 单独提交后改文字属性会没有效果。
- **1e-2**：点 3、点 4，加上 `compileText` 的登记切换，单测加假设备测试。
- **1e-3**：点 5、点 6，真机验收与语料。待定 2 的 WPE 实验由我在 1e-1 期间并行做。

**已定**（2026-11-13 用户）
1. **`3824424509` 的日历：不为它单独加识别。** 用户的意见是只有能覆盖别的隐式 API 才做。语料统计（`ignore/p6/b1e/getlayer_root.mjs`）：经 `getLayer(…)` 访问「只认根对象」的图层成员的只有 3 张——`3824424509`（`.text`，日历）、`3000562427`（`.text`，同脚本另有 `thisLayer.text`，本来就报）、`3643916956`（`.font`，另用 `engine.registerAsset`，本来就退回）；`zoom`、`fov`、`alignment` 等 0 处。通用改法只改变日历这一张的判定，所以不做。1e 之后 `3824424509` 会被判成能渲染、日历停在初值，记为已知差异，步骤 2 实现 `ITextLayer` 时补。
2. **合成 RT 的 `max(4, ·)`：按推荐**，Claude 在 1e-1 期间做测试工程在 WPE 里抓帧定下来，结果写进 1e-2。
   - **实验结果（2026-11-13）：WPE 套了 `max(4, ·)`，1d 写「不套」是错的。** 工程 `ignore/p6/b1e/proj/p6b-tiny`、`p6b-tiny2`（`make_tiny.mjs` 生成：三个带 tint、`padding: 0` 的极小文字，放大 40 倍），抓帧 `A:\p6b\p6b-tiny\`、`A:\p6b\p6b-tiny2\`，上屏整帧导出在 `ignore/p6/b1e/out/frames/`。
     - 第一组（2 号「.」「-」、4 号「.」）：WPE 合成 RT 4×11、7×22，我们排版算出的 `compositeSize` 相同，宽度正好 4，分不出来；
     - 第二组（1 号「.」、0.6 号「.」、1 号「i」）：我们算出 2×6、2×6、3×6，**WPE 三个都是 4×6**。高度没有小于 4 的样本，按 rea-p8-layer 的读码两维都套。
     - 1e-2 把 `textCompositeSize` 改成 `max(4, trunc(…))`，改完用这两组整帧逐像素比，确认 RT 变宽后字形与上屏的映射也对。
3. **`font` 与 `opaquebackground` 运行中改：按推荐**，照旧整场重编译，1e 不做。
4. **缺字体时的帧：按推荐**，接受「读完字体才补、中间照画旧文字」这一差异。
5. **图集到 4096 还放不下时的重置：按推荐**，重置后把用这张图集的层全部重排。
6. **文本层独占合成 RT 与 fbo：按推荐。**

#### 1e-1 实施记录（2026-11-13）

在快照 `ignore/p6/b1e/ov`（HEAD `ff4ad0e3`）里做，补丁 `ignore/p6/b1e/step1.patch`（19 个文件，+1307 / −81；对当前工作区 `git apply --check` 通过）。只做点 1（不含 `compileText` 的登记切换）与点 2，渲染器不消费 `dirty.texts`。

**做了什么**
- **点 1 — 字符串通道**
  - **新增** `compile/bindings.ts`：`TEXT_RUNTIME_FIELDS` / `TextRuntimeField` / `isTextRuntimeField`，`BindingTarget` 加 `{ kind: "text"; object; field }`。
  - **新增** `text/fields.ts`：`textFieldFromJson`、`textFieldFromScript`、`scriptToString`（WPE 类型 5 的 `ToString`）、`sameTextField`；`textFloat` / `textVec2` / `textEnum` 与两张对齐表从 `compile/texts.ts` 挪进来（`texts.ts` 再导出 `textFloat` / `textVec2`，原单测不动）。`text/fields.ts` 因此多依赖 `compile/model` 的 `numbers`（无别的依赖，Worker 里本来就有）。
  - **修改** `compileText`：14 个排版字段一律 `textFieldFromJson(键, read(键)) ?? 缺省`（向量缺省给新数组），读取与登记顺序不变；登记仍是 `recompile`（1e-2 再换）。
  - **修改** `compile/scripts.ts`：`targetOf` 对文本对象（`isTextObject`）顶层的 `objects/<i>/<TEXT_RUNTIME_FIELDS 之一>` 给文本目标（核对路径，嵌套同名键与非文本对象不算）；`valueType` 按字段表 `textTypes` 定（`text` 与两个对齐 `"string"`，数字键 `"float"`，向量 `"vec2"`，布尔位 `"bool"`），不再按初值猜。`font`、`opaquebackground` 仍是 `unsupported`。
  - **修改** 写回链的值类型：`script/runtime.ts` 新增 `ScriptValue = number[] | boolean | string`，`write` / `read` 回调、`writes` 重放表、`rememberWrite`、`targetKey`（显式 `case "text"`，键 `objects/<i>/<字段>`，与宿主 `targetPath` 一致）；`writeReturn` 的 `"string"` 只对文本目标经 `scriptToString` 交出，别的目标照旧丢（见下「不同处」2）。`script/api.ts` 的 `ScriptApiState.write` / `read` 与私有 `write` 加 `"string"` 分支（同一规则，只给文本目标，步骤 2 用）。`host.ts`：`scriptOverrides`、`overrideAndReload` 用 `ScriptValue`；`targetPath`、`readScript`（返回当前字段：数字 → `[n]`、向量拷贝、字符串 / 布尔原样）、`writeScript`（`state.writeText(…, textFieldFromScript(字段, scriptWriteValue(值)))`，恒 `true`，不走重编译）都有显式文本分支。
- **点 2 — 状态**（`render/state.ts`）
  - **新增** `textFields`（`fromBundle` 拷贝编译期 `SceneText.fields`，向量不共用）、`dirtyTexts`、`DirtyState.texts`、`writeText`（undefined 不写、`sameTextField` 相同不标脏、向量存拷贝）、`setText`（换排版、写 `offset`，偏移变了本层与子孙进 `dirtyLayers`；加载时的 `setTexts` 不变、不标脏）。
  - **修改** `write` 的文本分支在兜底之前（`textFieldFromJson(字段, conditioned(binding, raw))`）；`needsRecompile` 显式 `text → false`；`takeDirty` 多 `texts`；`scriptWriteValue` 收字符串。
  - **修改** `render/p3a.test.ts` 两处整体比较补 `texts`。

**和计划不同处**
1. `TEXT_RUNTIME_FIELDS` 照计划放在 `compile/bindings.ts`；两个规整函数的字段参数是 `TextFieldKey`（14 个对象字段，含 `font`、`opaquebackground`），`compileText` 才能整份走同一个函数。
2. `writeReturn` 的 `"string"` 只放行文本目标：别的目标初值猜成 `"string"` 的（材质常量没有 `value`、`bloom` 写成一个词的串等）以前丢掉，现在仍丢，不改行为。ToString 在运行时（`scriptToString`）做，宿主再 `textFieldFromScript`（对字符串幂等），规则只在 `text/fields.ts` 一份。
3. 脚本侧枚举先 `ToString` 再查表（B 节第 4 条：枚举是类型 5）；对标量（数字、布尔、字符串）与属性侧结果逐一相同（单测对拍），只有数组 / 自带 `toString` 的对象不同（`["right"]` → right，同 WPE）。脚本侧布尔位只收布尔（类型 6）：运行时 `"bool"` 本来就丢非布尔，函数与链路一致；属性侧仍是编译期的 `=== true`。`ToString` 抛错（Symbol、无原型对象）时不写（WPE 会把异常抛给脚本，我们不禁用 `update`）。
4. 属性侧文本分支先按 `condition` 换布尔再规整（计划代码直接传 `raw`）：编译期 `resolveValue` 就是这样，`pointsize` 绑 `bool` 条件时就地 = 重编译。
5. 编译协议 `scriptOverrides`（`compile/bundle.ts`、`client.ts`、`protocol.ts`）的类型加 `string`：宿主覆盖表放宽后要传得过去；套用逻辑本来就收字符串，1e-1 没有字符串真的进覆盖表（文本目标不重编译），步骤 2 的 `font` 会用到。三个已有测试的替身类型同步放宽（`api.test.ts`、`runtime.test.ts`、`host.script.test.ts`）。
6. `host.script.test.ts` 文件级加了 `vi.mock("./text/host")`（`SceneTexts.prepare` 返回空表），文本层的宿主用例才不去读字体；别的用例没有文本层，不受影响。

**测试**
- tsc（快照）0 错误；prettier `--check` 全部通过，文件均为 LF。
- vitest：ov 98 个文件、2380 条，2378 过；head 94 个文件、2321 条，2319 过。两边失败的是同样两条（`pipeline.test.ts` 的 `3830255100: 219 次请求`、`p5c.test.ts` M3 的 `mdl:missing-attribute:a_Normal`），与本步无关。
- 新增 59 条：`text/fields.test.ts` 24（含与 1d 原写法的逐字段对拍：14 个字段 × 32 种原始值）、`compile/textScripts.test.ts` 12（`"Song Title"` / `"<Time and Date>"` 等初值恒 `"string"`、`maxwidth` 走 float、`font` / `opaquebackground` / 嵌套键 / 图像对象不是文本目标）、`script/textWrites.test.ts` 9（ToString、`null` 不写、抛错不写不禁用、`update(value)` 收字符串、重放与 `forgetWrite` 的键、非文本目标照旧丢、API 的 `"string"` 分支、直接跑 `collectScripts` 的结果）、`render/textState.test.ts` 9（拷贝、规整、同值不标脏、`takeDirty`、不走兜底不碰泛光、`setText` 标子孙）、`host.script.test.ts` 5（字段脚本当帧进状态、ToString 与 `null`、`maxwidth`、重编译后重放、属性就地写盖掉脚本写入且重编译后不再重放）。
- 编译结果不变：`compile/texts.test.ts`、`text/*.test.ts` 全过；另用 `ignore/p6/b1e/cmp/compileText.test.ts` 对语料 981 个文本对象，head / ov 的 `compileText` 各跑 4 种（属性取当前值 / 取 JSON 的 `value` × LDR / HDR），比文本表、登记的绑定与不支持项，3924 次 0 处不同（`cmp/sanity.mjs` 把 ov 的 `text` 改成转大写时该测试失败，确认能检出）。
- 语料：`kbp corpus scan` head / ov 各 173 张、0 出错、48 张干净，两份 JSON 逐字节相同（`corpus diff` 无变化，`corpus-diff.txt`）。
- 变异检查（`ignore/p6/b1e/mutate1.mjs`，结果 `mutate1.json`）：16 处全部检出，每处按原字节还原，前后整树哈希一致——脚本侧 `null` 写成 `"null"`、`valueType` 退回按初值猜、`writeText` 不比较、文本分支落到泛光兜底、`maxrows` 不截断、枚举回退取缺省、重放表丢字符串、`setText` 不标子孙、`targetOf` 不核对路径、`readScript` 读不到文本、字符串交给非文本目标、向量不铺满、`needsRecompile` 对文本为真、`fromBundle` 不拷贝、重放键与 `targetPath` 不一致、脚本侧布尔位收数字。

**没做 / 留给 1e-2**
- `compileText` 的属性绑定仍登记 `recompile`；能力表照报 `text:script`，所以产品里 1e-1 没有可见变化（语料不变即此）。`GpuScene.sync` 不读 `dirty.texts`。
- `host.readTarget`（dev 读值）没有文本路径；探针 `scriptValues` 不收文本（点 5）。

#### 1e-2 实施记录（2026-11-13）

在快照 `ignore/p6/b1e/o2`（HEAD `3c4f723b`，基线 `ignore/p6/b1e/h2`）里做，补丁 `ignore/p6/b1e/step2.patch`（18 个文件，+1575 / −116，新增 `text/relayout.test.ts`）。做了点 3、点 4 与 `compileText` 的登记切换；点 5（能力表的 `text:script`、探针 `scriptValues`）、点 6（文档）没做，所以产品里只有「绑用户属性的文字 / 字号等改了就地重排」这一处可见变化，挂脚本的文本场景仍因 `text:script` 退回（语料不变即此）。

**做了什么**
- **点 3 — 重排器**
  - **新增** `text/atlas.ts` 的 `GlyphAtlas.resets`：`resetForRelayout()` 时加一。
  - **修改** `text/layout.ts`：`releaseTextLayout` 不再清空 `mesh.refs`，改记 `mesh.released`；**新增** `retainTextLayout(layout)`（反操作），两者都可重复调用。
  - **修改** `text/host.ts`：`TextRelayouter` 接口；`SceneTexts` 有加载代数（`prepare` 开头、`dispose` 时加一）与最近一次排完的加载 `{ 代数, 图集 }`；`relayouter()` 返回绑定这次加载的重排器：过期（有更新的加载、已销毁）返回 null、不动图集；否则先 `releaseTextLayout(previous)` 再 `layoutText`，出错或缺字体时 `retainTextLayout(previous)`、返回 null，缺字体时后台 `fonts.load`，读完比代数与 `disposed`，仍有效才调选项里的 `onReady(object)`。
  - **新增** `render/state.ts` 的 `touchText(object)`：不改字段、只标 `dirtyTexts`（不是文本层不做事）。
  - **修改** `host.ts`：建 `SceneTexts` 时给 `onReady` → `onTextReady`（`touchText`，暂停时 `renderer.redraw()`，同属性就地写的补画）；`prepare` 之后取 `relayouter()` 经 `load` 的 `relayout` 交给渲染器。
- **点 4 — 渲染器**
  - **修改** `render/renderer.ts` / `GpuScene.build`：选项加 `relayout`；建场景时记下各图集的 `resets`（加载期间的重置不算）。dev 探针 `dev/probeTexts.ts` 返回 `relayout`，`dev/probe.ts` 的 `renderFrame` 传给 `build`。
  - **修改** `GpuScene.sync`：最先 `syncTexts`——对 `dirty.texts` 逐层 `relayout(object, textFields, texts)`，排成的 `setText`；某层的旧 / 新排版用到的图集 `resets` 变了（已定 5），用这张图集的别的层（本次已排过的也算）进队列再排，每层一次 `sync` 至多 2 次（`TEXT_RELAYOUT_LIMIT`）；有重排时再 `takeDirty()` 一次把 `setText` 标的脏图层并进这次的 `dirty`（同一帧刷矩阵）；然后 `TextAtlasTextures.sync()`，返回的扩容图集的使用层也进待重建集合；最后对集合 `rebuildLayer(…, { force: true })`。之后才是 `rebuildStructures` 与原来的刷新。原来末尾的 `atlasTextures.sync()` 挪进 `syncTexts`（非文本场景是一次空遍历）。
  - **修改** `rebuildLayer` 加 `force`：签名相同也重建；先 `preparedOf`（缺管线就抛，这时什么都没换）、文本层再 `ensureTextResources`（图集按新排版重新取；计划没有合成路径时释放本层合成 RT；fbo 按新的 `textCompositeSize` 换）、再 `buildLayer`。强制重建不计入 `rebuildStats`（那是 effect 开关的），记在 `textStats`。
  - **独占资源**（已定 6）：`ensureComposites` 对文本层走 `ensureTextComposites`（本层一组，尺寸变了销毁旧的、按新尺寸建，采样、标签照共享池的写法）；`populate` 里文本层的 fbo 走 `createTextFbos`（每个 effect 的每个名字一张，记进 `textFbos`），`resizeTextFbos` 在同一个 `targets` 下标上换新尺寸的纹理并清成 `clear` 色（`FboBindings` 的对应与 swap 状态不变）。fbo 的创建从 `populate` 抽成 `createFbo`，非文本层的共享池调用顺序、标签、清屏与原来逐字节相同。新增 `releaseTarget`（释放并从 `targetBytes` 减掉）。
  - **修改** `render/text.ts` 的 `TextAtlasTextures`：构造的第 4 个参数由 `warnings` 换成 `release`；`sync()` 遇到尺寸变了就释放旧纹理、按新尺寸建（标签不变）并整张上传，返回这些图集。
  - **修改** `render/graph.ts`：`variantPlans(layer, textures, text?)` 对文本层返回一份「两种字形都有」的假想排版的计划（`textVariantLayout`，尺寸取当前排版，没有时取空排版的）；`GpuScene.prepareVariants` 对文本层只备程序与管线（不按假想尺寸建 RT、不建快照），备不好时记一条警告。
  - **新增** `GpuScene.textStats()`（有重排或重建的 `sync` 次数、重排器调用次数、没排成的次数、重建层数，及每次的层数 / 重排用时 / 重建用时的均值、p95、最大值）；`dev/probe.ts` 的 `hostTexts` 与 `dev/install.ts` 的 `host.texts()` 读它，另列每个文本层当前的文字、字号、`size`、`compositeSize`、字形数。
- **`max(4, ·)`**（已定 2 的实验结论）：`textCompositeSize` 改成两维 `max(4, ·)`（截断后不是有限数时同 `cvttss2si` 得 `INT_MIN`，取 4）。`TextLayout.compositeSize` 本身不变（仍是 `trunc(2·pad + 文字框)`，即 WPE `+0x128` 的查询结果）。
- **`compileText` 的登记切换**：`TEXT_RUNTIME_FIELDS` 里的 12 个键绑属性登记 `{ kind: "text", object, field }`；`font`、`opaquebackground`、MSDF 四个开关、`anchor`、HDR 下的 `backgroundbrightness` 照旧重编译。

**`max(4, ·)` 落在哪里、依据**（读码：`ignore/p8/rea/layer/dec/f_1401ea500.c` 与 `ignore/p4/rea/wp.asm`）
- `FUN_1401ea500` 调 `+0x128` 取 `out3` 后，`0x1401ea5dc`–`0x1401ea628` 用 `cmovg` 把 `[rbp-0x60]` / `[rbp-0x5c]` **原地**改成 `max(4, ·)`；之后这个函数里读它们的地方拿到的都是改过的值：
  1. **合成 RT 尺寸**（`FUN_1401ab570(…, local_e8, local_e4, …)`）→ `planLayer` 的 `composite`；
  2. **effect fbo 的基准**（fbo 循环 `uVar8 = local_e8`、`uVar23 = local_e4`，再 `/scale`、`fit`）→ `populate` / `resizeTextFbos` 的 `fboSize(fbo, textCompositeSize(…))`；
  3. **`+0x2d8` 四边形**（`0x1401eb1b2` / `0x1401eb1bf` 读 `[rbp-0x60]` / `[rbp-0x5c]`，`cvtdq2ps` 后作 `FUN_1401ede30` 的尺寸参数）→ 直接上屏的**背景四边形** `[0, W] × [0, H]` 也套 `max(4, ·)`。**这一条和交代的「背景四边形是整数文字框」不同**，按读码取：1d 对过的 f4（213×240）大于 4，分不出来；`p6b-tiny2` 没开背景，验不到，要另做一个开背景的小文字工程才能定。
  4. **画进合成 RT 的正交**：`FUN_1401e8aa0` 压入合成 RT 后按 RT 对象设投影（返回地址 `0x1401e977c` 那次调用的高取 RT 对象 `+0x1a`，宽同样取 RT 对象是推断），即套过的纹理尺寸 → `textMatrices` 的 `ortho(0, W, 0, H)` 按 `textCompositeSize`。字形在 RT 里的平移不变（左下角在 `(pad.x, pad.y)`），RT 多出来的列在右、行在上。
- **不套的**：图层尺寸 `TextLayout.size`（上屏的 `+0x2e8` 四边形、clearalpha 的 `+0x5b0` 四边形、矩阵里的 w、h），以及上屏的 UV 内缩（`FUN_140258900` 交给 `+0xb0` 的是没套过的 `(int)size`，`uvInset` 的分母照旧是 `trunc(size)`）。所以宽 2 的文字在 4 宽的 RT 里只占左半，上屏时整张 RT 铺到 2 宽的四边形上（字形横向被压一半）——这正是要用 `p6b-tiny2` 整帧逐像素验的地方。

**和计划不同处**
1. 重排器不是 `SceneTexts` 自己，而是 `relayouter()` 给出的、绑定一次加载的对象：重编译时旧场景在新场景建好之前还在画，`SceneTexts` 若直接作重排器，旧场景会把字形排进新加载的图集（新加载的装箱顺序就不再和 WPE 一样）。加载代数在 `prepare` **开头**加，所以重编译期间旧场景的文字停在原样（重排器返回 null），新场景换上后照常。
2. `releaseTextLayout` 不清 `refs`、改记 `released`，`retainTextLayout(layout)` 只收排版一个参数（清了列表就没法加回去）。
3. 只标脏的方法叫 `touchText`。
4. 文本层的 fbo 连本层不同 effect 之间也不共用（每个 effect 的每个名字一张）：按尺寸变化原地换时，同名同尺寸、但 `scale` / `fit` 不同的两个 fbo 换完尺寸会不同，共用一张就换不了。1d 里它们经全局池按名字与尺寸共用，现在多建几张；只影响带同名 fbo 的多个 effect 的文本层。fbo 的标签是 `fbo text <图层 id>|<effect>|<名字>|<宽>x<高>|<格式>|<repeat>`；合成 RT 的标签沿用共享池的写法（`composite <宽>x<高>|<clamp>|<nearest> #i`），1d 的轨迹测试不用改。
5. 文字变空（计划没有合成路径）时释放本层的合成 RT，再变非空时按新尺寸重建（计划没写，内存更省；WPE 空文字时照样按 4×4 分配，看不出来）。fbo 不释放，按空排版的 4×4 基准换小。
6. 图集重置连带重排设了每层每次 `sync` 至多 2 次的上限（计划没写）：重排别的层可能又触发重置，不设上限会连环。到上限后剩下的层留到下一次标脏（实际上 WPE 这时也只是放弃放不下的字形）。
7. 强制重建不计入 `rebuildStats`：P3a 的探针用它核对 effect 开关，时钟每分钟重建一次会搅进去。
8. `setText` 标的脏图层在同一次 `sync` 里刷（第二次 `takeDirty` 并进来，文本项放回状态），计划没写这一步；不这样做，偏移变了的子对象要晚一帧才跟上。
9. 计划里 `sync` 的伪代码是「重排 → 图集 → 重建」三段直接写在 `sync` 里，这里收进 `syncTexts` / `relayoutTexts` 两个方法，次序相同。
10. 没有用到的图集的 GPU 纹理不释放（滑块拖着改字号会一直攒新的「字体 + 字号」图集，每张 512² 起），直到场景销毁；CPU 侧 `TextAtlases` 同样。WPE 的字体管理器也按字体键留着，没查它释放不释放；记为待定。

**测试**（tsc 0 error；Prettier `--check` 全过，LF）
- vitest：o2 101 个文件、2489 条，2488 过；h2 100 个文件、2471 条，2470 过。两边失败的是同一条 `pipeline.test.ts` 的 `3830255100: 219 次请求`（这次 `p5c.test.ts` 的 `a_Normal` 两边都过）。日志 `ignore/p6/b1e/vitest-o2.log`、`vitest-h2.log`。
- 新增 18 条：
  - `render/text.test.ts` 10 条（假设备）：直接上屏换字（签名不变也重建、新 draw、顶点 400 字节 / 索引 30、旧顶点与索引缓冲销毁、别的层不动、`textStats`、不计入 `rebuildStats`）；值没变不重排；合成路径换尺寸（本层 RT 149×176 → 300×176、旧的销毁，fbo 同下标换成 150×88 并清成 clear 色，图像层共享池里的 RT 与 fbo 不动，`targetBytes` 增减对，画进 RT 的正交按新宽度）；空 → 非空与第一次出现彩色字形（不报 `render:variant-missing`，再变空时 RT 释放）；图集扩容（纹理 512 → 1024 重建、同标签整张上传、旧的销毁，F 没重排但重建、顶点按减半的 UV、bind group 绑新纹理的视图，别的图集的层不动）；图集重置（同图集的层跟着重排、别的不排，连环重置时 4 次后停）；缺字体（旧排版照画、不重建，`touchText` 后再排）；对齐偏移变了时本层与子对象（图像层）的矩阵在同一次 `sync` 里刷；没有重排器时不重排；`max(4, ·)` 的场景（2×6 的文字：RT 4×6、画进 RT 的正交 x 系数 2/4、上屏四边形 ±1 × ±3、直接上屏背景 `[0, 4] × [0, 6]`）。
  - `text/relayout.test.ts` 5 条：`release` / `retain` 互逆、可重复；`resets` 只在重置时加；真 wasm 下 `SceneTexts` 的重排器——排进同一套图集、先放旧引用（只被旧文字用的字形归 0）；缺字体时返回 null、旧引用复原、图集不动，按 `onReady` 一轮读一个回退字体（「A中」沿 seguiemj → arialuni → segoeui → Twemoji → seguisym → msyh 逐轮读，用例只断言 12 轮内排成）；更新的加载开始后与 `dispose` 后旧重排器返回 null、不动引用，读完字体的回调丢掉（读取用闸门卡住再放行）。
  - `compile/texts.test.ts` 1 条：16 个键逐个绑属性，12 个运行中字段是文本目标，其余重编译。
  - `host.script.test.ts` 2 条：真 `compileText` 登记的绑定换进宿主，属性改 `text`、`pointsize` 就地写、`applied` +2、不重编译，改 `font` 重编译一次；重排器原样交给渲染器，`onReady` 标脏、暂停时补画、非文本对象与销毁后不做事。
- 因改动而改了期望的 1d / 1e-1 用例（逐条）：
  - `render/text.test.ts`「合成 RT 取排版的尺寸，不套 max(4, ·)」→ 3×2 的文字合成 RT 由 3×2 改成 4×4，另加 2×6 → 4×6、内缩仍按 2、6，及 `textCompositeSize` 的边界；
  - `render/text.test.ts`「文本层不预备 effect 变体」→ `variantPlans` 由空表改成一份「两种字形都有」的计划（直接上屏背景 + 字形 + 彩色字形；合成 clearalpha + 字形 + 彩色字形 + 上屏）；
  - `compile/texts.test.ts` 的绑定用例 → `text`、`pointsize` 由 `recompile` 改成文本目标；
  - `host.script.test.ts` 的 `SceneTexts` 替身补 `relayouter()` 与 `onReady`（宿主现在会调），原用例不变。
  - 其余 1d 的文本用例（p6b-fx 的矩阵、六个工程的排版 → 图层矩阵、编码轨迹）原样通过：抓帧里的合成 RT 都大于 4。
- 非文本场景：`createFbo` 抽出与 `atlasTextures.sync()` 挪位之后，`render/rebuild.test.ts`（fbo 按真实合成尺寸建、换开关清 fbo 的提交、泛光关着 / 没有链时编码轨迹逐项相同、清屏可变时每帧轨迹相同）、`render/p5b-*.test.ts`、`render/graph.test.ts` 等两边结果相同。
- 语料：`kbp corpus scan` h2 / o2 各 173 张、0 出错、57 张干净，`corpus diff` 无变化（`ignore/p6/b1e/corpus2-*.json`、`corpus2-diff.txt`）。
- 变异检查（`ignore/p6/b1e/mutate2.mjs`，结果 `mutate2.json` / `mutate2.log`）：22 处全部检出，每处按原字节还原，前后整树哈希一致——`force` 不生效、文本 RT 尺寸变了不换、旧 RT 不销毁、文本 RT 进共享池、fbo 不换尺寸、变体不备彩色字形、文本层不备变体、图集扩容不重建纹理、同图集的层不跟着重建、图集重置不连带重排、连带重排不设上限、`setText` 的脏图层不并进这次 `sync`、强制重建计入 `rebuildStats`、缺字体不复原引用、重排前不放旧引用、旧加载的重排器不过期、读完字体不比代数、去掉 `max(4, ·)`、`compileText` 退回 `recompile`、值没变也重排、暂停时读完字体不补画、宿主不把重排器交给渲染器。第一轮（`mutate2-run1.*`）漏了「脏图层不并进」（第二次 `takeDirty` 照样把状态取空，原用例只看本层，本层本来就重建）；给那条用例加了子对象（图像层），核对它的矩阵同一次 `sync` 就带上偏移，第二轮检出。

**没做 / 要真机确认**
- 点 5、点 6（能力表 `text:script`、探针 `scriptValues`、文档、回归、changelog）是 1e-3。
- `p6b-tiny2` 两组整帧逐像素比（RT 变宽后字形与上屏的映射），以及开背景的小文字工程（背景四边形套不套 `max(4, ·)`，上面第 3 条）。
- 预览里实时改 `textinput` / `pointsize`（`2304304373`）：`stats.recompiled` 不增加、带 `blurprecise` 的时钟换宽度时 RT 与 fbo 跟着换（`host.texts()` 看次数与用时）。
- 补丁对当前工作区（HEAD `ef16dcf1`）`git apply --check` 不过：`render/graph.ts`、`render/scene.ts`、`render/state.ts`、`render/uniforms.ts` 被别的会话改过，要三方合并。

#### 1e-2 复核（Claude，2026-11-13）

- **合并**：补丁按 h2（3c4f723b）出，期间 HEAD 有别的会话的提交（P8 步骤 3 等）。先以 HEAD 为基础三方合并（`ignore/p6/b1e/m2/`），两处冲突：
  - `render/scene.ts` 的导入：两边都要，合在一起；
  - `render/state.ts` 的 `setText`：P8 步骤 3 改了对齐偏移的模型（自身偏移不再传给子层，`drawMatrixOf`），`setText` 只标本层。保留子代理新增的 `touchText`，`setText` 用 HEAD 的写法。
  子代理的「偏移带子对象」用例按 1d 的旧模型写，改成新模型：文本层自己的矩阵用 `drawMatrixOf`、同一次 `sync` 里刷；子对象的世界矩阵不带偏移、不变。
  合并后的 HEAD 快照（`ignore/p6/b1e/c3`）tsc 0 error、vitest 2693 / 2694（只有已知的语料请求次数）。再以同样的三方合并进工作区（只有 `host.ts` 有别的会话未提交的改动，合并干净），工作区 tsc 0 error、相关 404 个用例全过。
- **背景四边形的 `max(4, ·)`**（子代理按读码套了，和我交代的不同）：做了第三组 `p6b-tiny3`（开背景、不带 effect，`make_tiny.mjs` 的 `VARIANT=3`），WPE 抓帧 `A:\p6b\p6b-tiny3\` 的背景四边形顶点是 `[0, 4] × [0, 6]`（文字框宽 2、3 的两层一样），**套 `max(4, ·)` 是对的**。
- **真机（dev，重建宿主产物）**：
  - `p6b-tiny`、`p6b-tiny2`、`p6b-tiny3` 和 WPE 整帧逐像素相同（最大差 0）：合成 RT 套 4、字形在上屏时被横向压缩、背景四边形套 4，三处映射都对；
  - 1d 的六个 `p6b-*` 工程渲染的像素摘要和 1d 时逐个相同，没有回归；
  - 运行中重排（`ignore/p6/b1e/proj/p6b-user`，`make_user.mjs`：`textinput` 属性 `msg`、`slider` 属性 `size`，直接上屏与合成各一层）：经 `set_wpe_web_user_properties` 依次改成「Hello world」→ 空 → 「Ab😀」（字号 32 → 64）→「你好 Ab」，`recompiled` 始终为空；合成 RT 随文字换尺寸（184 → 901 → 676 → 945 宽）；空排版、第一次出现彩色字形都正常；
  - 每次改完，宿主的画面（遮掉右下角帧号 / 时钟的哈希）都和「用新属性整场编译」的画面相同；
  - 异步读字体：可见预览里帧循环自己走完 5 轮回退链（不到 0.7 秒），单次重排最长 8.7 ms（64 号中文首次栅格化）、重建最长 1.6 ms；
  - 屏外宿主的帧循环不跑（时钟停在 0.0001 s），那里的验证靠 `host.renderFrame` 手动推帧，是测试环境的特点；
  - 测完移除了测试行。
- **遗留**：不再用的图集的 GPU 纹理在场景销毁前不释放（拖字号滑块会攒新图集，每张至少 512²），WPE 释不释放没查。

### 1e-3 — 能力表、探针与文档（2026-11-13，按 HEAD `187f41c9`）

**总体设计思路**

1e-2 之后，挂脚本的文本字段在宿主里已经能当帧重排：字段脚本的返回值经 `writeScript` 进 `textFields`，`sync` 里重排、重建。现在挡住这类场景的只剩能力表的 `text:script`。1e-3 拆掉这道闸：`TEXT_RUNTIME_FIELDS` 里的 12 个键挂脚本不再报；`font`、`opaquebackground` 等其余文本键挂脚本照报 `text:script:<键>`，它们运行中改要整场重编译（已定 3）。按 1e-2 的语料结果（`ignore/p6/b1e/corpus2-o2.json`），只差 `text:script` 的有 9 张：`2304304373`、`2391389126`、`2903412088`、`3813887347`、`3819179413`、`3824424509`、`3825103811`、`3826727460`、`3836725625`。调研时只有前两张加 `3824424509`，后 6 张是语料扩到 173 张以后多出来的。它们的文本脚本都是 `new Date()` 的取值拼字符串，不用 `toLocale*` / `Intl`，所以不涉及本地化格式差异。`3824424509` 的日历格子要等步骤 2 的 `ITextLayer`，会停在初值（已定 1）。

验收要拿带时钟的文字和 WPE 逐像素比，但探针为了确定性不跑脚本，文字一直是编译期的初值。所以 dev 探针的 `scriptValues` 扩到文本目标：调用方给出「这一帧字段脚本返回了什么」（例如 WPE 抓帧里画的是 `F183`、`12:34`），探针按宿主同一条写回（`textFieldFromScript` → `writeText`）写进状态。

探针没有帧外补画。缺字体时重排器保留旧排版，读回帧就会画旧文字，所以回放前加一步「结清」：
- `sync` 一次；
- 有字体在读，就等读完。读完时 `onReady` 已把那一层重新标脏；
- 再 `sync`，直到没有在读的字体。轮数上限同 `prepare`，超过就抛错。

没给文本值时不多调 `sync`，逐字节同以前。REST 的校验（`scripts/kabegame-dev/replay.ts`）同步放宽：文本字段的值可以是字符串。MCP 的 `render_scene` 只发 FR 帧号块、不收通用 `scriptValues`，这次不改；要按字符串渲染时走 REST，或用 `host_eval` 直接调探针。

文档把 1e 整体写进去：WPE_SCENE.md「文本对象」一节、cocs/README.md 的条目、回归一节、changelog 一行。回归行先留 `[ ]`，我真机验收后再勾。

**现状锚点**

a. 能力表：`text` 挂脚本报 `text:script`，别的文本键报 `text:script:<键>`（`compile/features.ts:604-611`）
```ts
export function checkTextFeatures(object: SceneObject, unsupported: Set<string>): void {
  for (const key of TEXT_KEYS)
    if (isScriptValue(object[key])) unsupported.add(key === "text" ? "text:script" : `text:script:${key}`); // 现状：12 个运行中字段也报
}
```

b. 探针的脚本值只认图层字段（`dev/scriptValues.ts`）
```ts
export interface ScriptValue {
  object: number | string;
  field: LayerField;          // 现状：只有图层字段（SCRIPT_VALUE_FIELDS）
  value: number[] | boolean;  // 现状：没有字符串
  optional?: boolean;
}
// resolveScriptValues：只找 s.target.kind === "layer" 的字段脚本
// applyScriptValues：state.write({ property: "", target }, scriptWriteValue(value))
```

c. 探针写完脚本值直接回放（`dev/probe.ts:388-389`）
```ts
// 脚本值（第 6 批）：建好场景之后、回放之前写进状态，同宿主的脚本写回；第一次 `sync` 把它刷进 uniform
const scriptValues = applyScriptValues(state, bundle, options.scriptValues);
// 现状：文本字段写进状态后，第一次 sync 才重排；缺字体时重排器返回 null，读回帧画旧文字
```

d. 探针的 `SceneTexts` 没有 `onReady`，运行中重排发起的字体读取外面等不到（`dev/probeTexts.ts`、`text/host.ts:181`）
```ts
const owner = new SceneTexts({ reader });          // 现状：读完字体没人通知
// relayoutIn：
fonts.load(layout.missingFonts).then(() => { /* … */ this.options.onReady?.(object); }, () => {}); // 现状：Promise 不留
```

e. REST 校验只认图层字段与数值 / 布尔（`scripts/kabegame-dev/replay.ts:302-332`）
```ts
if (!LAYER_FIELDS.includes(item.field as SceneLayerField)) fail(`${at}.field`, /* … */); // 现状
const v = item.value;
if (typeof v !== "boolean") { /* 现状：只收 1–4 个有限数 */ }
```

**点 1 — 能力表（`compile/features.ts`）**
- **修改** `checkTextFeatures`：
```ts
export function checkTextFeatures(object: SceneObject, unsupported: Set<string>): void {
  for (const key of TEXT_KEYS)
    // 修改：运行中字段（TEXT_RUNTIME_FIELDS）挂脚本在宿主里就地重排（1e），不报；其余文本键照报，运行中改要重编译（已定 3）
    if (isScriptValue(object[key]) && !isTextRuntimeField(key)) unsupported.add(`text:script:${key}`);
}
```
- **删除** `text:script` 键，函数注释同步。`compile/scripts.ts` 的注释本来就只提 `text:script:<键>`，不动。
- 脚本 API 检查不改（已定 1）。

**点 2 — 探针的文本脚本值（`dev/scriptValues.ts`、`dev/probeTexts.ts`、`dev/probe.ts`、`text/host.ts`）**
- **修改** `ScriptValue` / `ScriptValueResult`：
```ts
export interface ScriptValue {
  object: number | string;
  /** 图层字段，或文本层的运行中字段（P6b 1e-3，`TEXT_RUNTIME_FIELDS`）。 */
  field: LayerField | TextRuntimeField;
  /**
   * 图层字段：1–4 个数或布尔（不变）。文本字段：字段脚本这一帧的返回值——字符串（最长 MAX_SCRIPT_TEXT 个 UTF-16 单元）、
   * 1–4 个有限数或布尔，按宿主同一规则规整（`textFieldFromScript`，如 `pointsize` 收数，`text` 收数时 ToString）。
   */
  value: number[] | boolean | string;
  optional?: boolean;
}
```
- **修改** `checkValue`：字段在 `SCRIPT_VALUE_FIELDS` 或 `TEXT_RUNTIME_FIELDS` 里；字符串只给文本字段。
- **修改** `resolveScriptValues`：文本字段找 `target.kind === "text"`、同 `object`、同 `field` 的字段脚本；找对象的方式不变（文本层也在 `bundle.layers` 里）。没挂脚本时的跳过 / 抛错规则同图层字段。
- **修改** `applyScriptValues`：文本目标写 `state.writeText(target.object, target.field, textFieldFromScript(target.field, scriptWriteValue(value)))`，同 `host.ts` 的 `writeScript` 文本分支；图层目标照旧。仍是先全部解析、再写。
- **新增** `SceneTexts.idle()`（`text/host.ts`）：
```ts
/** 运行中重排发起、还没结束的字体读取（P6b 1e-3，dev 探针结清用）。 */
private readonly reading = new Set<Promise<void>>();
/**
 * 等运行中重排发起的字体读取全部结束（成功或失败、`onReady` 已调过）。返回有没有等到东西：没有在读的时候立即返回 false。
 * 宿主不用（帧循环里不能等）。
 */
async idle(): Promise<boolean>;
// relayoutIn：fonts.load(…).then(…) 的 Promise 进 reading，finally 时删掉
```
- **修改** `prepareProbeTexts`：给 `SceneTexts` 传 `onReady`，读完字体的对象记在 `ProbeTexts` 上；**新增** `ProbeTexts.settle`：
```ts
/**
 * 回放之前把文本字段的重排做完（P6b 1e-3）。每轮先 `touchText` 上一轮读完字体的对象，再 `scene.sync(state)`；之后 `idle()` 返回 false
 * （没有在读的字体）就结束；否则继续下一轮。超过 MAX_FONT_ROUNDS 轮仍有在读的时抛错。返回 `sync` 的次数。没有文本层时返回 0、不调 sync。
 */
settle(scene: Pick<GpuScene, "sync">, state: Pick<SceneState, "touchText">): Promise<number>;
```
- **修改** `renderFrame`：`applyScriptValues` 之后，有文本字段的值写进了状态（`applied` 且字段是文本字段）时 `await texts.settle(scene, state)`，结果 `RenderFrameResult` 多一项 `textSyncs?: number`（只在结清过时给）。没给文本值时不调 `settle`，逐字节同以前。

**点 3 — REST 校验（`scripts/kabegame-dev/replay.ts`、`types.ts`、`replay.test.ts`、`rest.test.ts`；`.claude/skills/kabegame-chromium/SKILL.md`）**
- **新增** `TEXT_FIELDS`：12 个运行中字段，是 `TEXT_RUNTIME_FIELDS` 的抄本。照 `LAYER_FIELDS` 的写法注明「改了两边一起改」。
- **修改** `checkScriptValues`：
  - `field` 可以是图层字段或文本字段，错误文案列出两组；
  - 文本字段的 `value` 可以是字符串（长度上限同探针），也可以是 1–4 个有限数或布尔；
  - 图层字段照旧，给字符串时 400，错误指到 `value`。
- **修改** `types.ts` 的 `ScriptValue`。SKILL.md 两处说明（「探针的通用能力 `scriptValues`」与 REST 表的 `render` 行）补上文本字段、字符串值和结清。

**点 4 — 文档**（共享文件，别的会话在改，在快照里写，我三方合并）
- **修改** `cocs/wpe/WPE_SCENE.md`「文本对象（P6b 1d 起）」：
  - 开头一段改成 1e 已做，动态文字的流向一段：字段比较、脚本当帧 / 属性下一帧、绑加载代数的重排器、先放旧再排新；
  - 表里补这些行：运行中重排与重建（`syncTexts`、强制重建、`textStats`）、独占合成 RT 与 fbo（尺寸变了换、空文字释放）、`max(4, ·)`（套的三处、不套的两处，依据是 `p6b-tiny*` 的实测）、异步字体、图集扩容与重置连带、变体预备；
  - 能力键一行去掉 `text:script`；
  - dev 探针（`scriptValues` 的文本字段与结清、`host.texts()`）；
  - 已知差异：缺字体时晚一到几帧；`3824424509` 的日历停在初值；不用的图集纹理不释放；`font` / `opaquebackground` 运行中改整场重编译。
- **修改** `cocs/README.md` 的 WPE_SCENE 条目：「文本对象（P6b 1d 起，静态文字）」改成含 1e 的摘要；适用场景加「时钟不走 / 改文字属性没变化或整场重编译 / 文字换宽度后合成 RT、effect 不对 / 探针按字符串渲染文字」。
- **新增** `versions/latest/regression.md`「## 场景壁纸 P6b 1e：动态文字」一节，格式照 1d 一节，行留 `[ ]`：
  - 时钟走动；
  - 属性改文字 / 字号不重编译；
  - 空 ↔ 非空、第一次出现 emoji；
  - 合成 RT 换尺寸；
  - 缺字体补上；
  - `max(4, ·)` 三个工程；
  - 9 张解锁场景；
  - 探针按字符串渲染；
  - 每帧变的文字耗时。
- **新增** `versions/latest/changelog.md` 一行：P6b 1e 整体，包括字符串写回、运行中重排与重建、独占合成 RT、`max(4, ·)` 更正、能力表去掉 `text:script` 后解锁的张数、探针。

**验收**
- 子代理：
  - 宿主 tsc 0 error；
  - vitest 带 `KABEGAME_WPE_ROOT` 全过（已知 `pipeline.test.ts` 那条请求次数除外）；
  - 在 `ignore/p6/b1e/x3/` 里 `deno test -A --no-check scripts/kabegame-dev/` 全过（Node 不支持参数属性，要用 deno）；
  - Prettier `--check`。
- 单测：
  - 能力表：12 个运行中字段挂脚本不报；`font`、`opaquebackground`、`backgroundcolor` 挂脚本报 `text:script:<键>`；
  - 探针解析：文本字段按下标与名字都能找到；没挂脚本时 `optional` 跳过、否则抛错；字符串给图层字段时抛错；`pointsize` 收数；超长字符串抛错；
  - 探针写入：经 `writeText`，结果同宿主 `writeScript`；
  - 结清：用假重排器，缺字体一轮 → 等 → 再 `sync` 后排成；超过轮数抛错；没有文本值时不调 `sync`；
  - `SceneTexts.idle()`：没在读时返回 false；在读时等到读完、`onReady` 已调；
  - REST 校验的新分支（`replay.test.ts`、`rest.test.ts`）。
- 语料：`kbp corpus scan` 和 1e-2 的 `corpus2-o2.json` 比，只有 `text:script` 与 `text:script:maxwidth` 消失，干净场景 57 → 66。
- 变异检查：
  - 运行中字段照报；
  - `font` 不报；
  - 探针文本值落到图层兜底；
  - 结清不等字体；
  - 结清不 `touchText`；
  - `idle` 不删已结束的读取；
  - REST 放过图层字段的字符串。

**真机（我）**
- 重建宿主产物：
  - `p6b-script` 的 s1 由探针按 `scriptValues` 渲染「F183」，只比 s1 所在区域，对照 WPE 第 182 帧（`A:\p6b\p6b-script\`，`kbp rdc frame --present` 导出上屏图）逐像素比；
  - 在预览里实时跑 s1（每帧变），用 `host.texts()` 量每帧的重排与重建用时。
- `2391389126`：WPE 抓一帧，读出画的时间字符串，由探针按它渲染，比文字区域。
- `2304304373`：在属性面板改 `textinput` 与 `pointsize`，`stats.recompiled` 不增加；带 `blurprecise` 的时钟换宽度时，合成 RT 与 fbo 跟着换（`host.texts()`）。
- 后 6 张新解锁的：
  - 每张都在预览里跑，时钟走、没有报错；
  - 和 WPE 抓帧逐区域比的是 `2903412088`（带 effect）与 `3836725625`（带 effect、有父对象）；
  - 其余 4 张和 WPE 的截图并排看。
- `3824424509`：确认能渲染、时钟走、日历停在初值（记为已知差异）。
- 测完删测试行，WPE 设置与 Kabegame 设置恢复原样，写进复核记录。

#### 1e-3 实施记录（2026-11-13）

在两份快照里做：
- 宿主：`ignore/p6/b1e/o3`（HEAD `187f41c9` 的 `apps/wpe-scene/src`，基线 `h3`），补丁 `ignore/p6/b1e/step3.patch`（10 个文件，+847 / −80，新增 `dev/probeTexts.test.ts`、`text/idle.test.ts`；对当前工作区 `git apply --check` 通过）；
- vite 插件、SKILL 与文档：`ignore/p6/b1e/x3`（基线 `xb3`），补丁 `ignore/p6/b1e/step3-x.patch`（9 个文件，+257 / −27；`git diff --no-index` 出的，路径是 `ignore/p6/b1e/xb3|x3/…`，要三方合并）。

点 1–4 都做了。真机验收没做（回归 E6–E16）。做完时 HEAD 已到 `b42b9990`（P9b 步骤 3 与收尾、P11 步骤 0 收尾，改过 `WPE_SCENE.md`、`cocs/README.md`、回归与 changelog；没碰 `scripts/kabegame-dev/` 与 SKILL.md），x3 的文档要按 `187f41c9` 三方合并；`step3.patch` 对当时的工作区 `git apply --check` 通过。

**做了什么**
- **点 1 — 能力表**（`compile/features.ts`）
  - **修改** `checkTextFeatures`：`TEXT_RUNTIME_FIELDS` 里的 12 个键挂脚本不报，其余文本键照报 `text:script:<键>`。
  - **删除** `text:script` 键；函数注释改写：运行中字段为什么不报，`font`、`opaquebackground`、`backgroundcolor` 等为什么照报。
  - `compile/scripts.ts` 与脚本 API 检查没动。
- **点 2 — 探针的文本脚本值**
  - **修改** `dev/scriptValues.ts`：
    - `ScriptValue.field` 是 `LayerField | TextRuntimeField`（类型别名 `ScriptValueField`），`value` 加 `string`；`ScriptValueResult` 同步。
    - **新增** `MAX_SCRIPT_TEXT = 4096`。
    - `checkValue` 先认字段：字符串只给文本字段。图层字段给字符串时报错，文案带「字符串只给文本字段」。文本字段的值按宿主同一条写回规整，即 `textFieldFromScript(字段, scriptWriteValue(值))`，规整不出值（宿主不会写）时抛错。
    - `resolveScriptValues`：文本字段找 `target.kind === "text"`、同对象、同字段的字段脚本，图层字段照旧找 `"layer"`。找对象、重名、`optional` 的规则不变。结果是三种形状的联合（图层目标、文本目标带规整好的 `text`、跳过）。
    - `applyScriptValues`：文本目标 `state.writeText(对象, 字段, 规整后的值)`，图层目标照旧 `state.write`；仍是先全部解析、再写。
    - **新增** `wroteTextValues(results)`：有文本字段的值写进了状态（`applied`）才为真。
  - **修改** `text/host.ts`：
    - **新增** `SceneTexts.reading`：运行中重排发起的「读字体 → 比代数 → `onReady`」整条链，结束时自己删掉。
    - **新增** `idle()`：没有在读的时候返回 false；有就 `Promise.allSettled` 等这一刻在读的那些，返回 true。
    - `MAX_FONT_ROUNDS` 改成导出。
  - **修改** `dev/probeTexts.ts`：
    - `prepareProbeTexts` 给 `SceneTexts` 传 `onReady`，读完字体的对象记进一个集合；
    - **新增** `ProbeTexts.settle(scene, state)`，实现是导出函数 `settleTexts(owner, ready, scene, state)`。每轮先 `touchText` 上一轮读完字体的对象，再 `scene.sync(state)`，然后 `idle()`：返回 false 就结束；读满 `MAX_FONT_ROUNDS` 轮仍有在读的就抛错。返回 `sync` 的次数。
    - 没有文本层时 `settle` 返回 0、不调 `sync`。
  - **修改** `dev/probe.ts` 的 `renderFrame`：`applyScriptValues` 之后，`wroteTextValues` 为真时 `await texts.settle(scene, state)`。结果多一项 `textSyncs`，只在结清过时给。文件头与 `scriptValues` 选项的说明同步。
- **点 3 — REST 校验**（`x3/scripts/kabegame-dev/`）
  - **新增** `replay.ts` 的 `TEXT_FIELDS`（宿主 `TEXT_RUNTIME_FIELDS` 的抄本，注明两边一起改）与 `MAX_SCRIPT_TEXT = 4096`（同探针）。
  - **修改** `checkScriptValues`：
    - `field` 可以是图层字段或文本字段，错误文案列出两组；
    - 文本字段的 `value` 收字符串（超长 400）、1–4 个有限数或布尔；
    - 图层字段给字符串 400，`field` 指到 `value`。
  - **修改** `types.ts`：
    - 新增 `SceneTextField`；
    - `ScriptValue` / `ScriptValueResult` 的 `field` 与 `value` 放宽；
    - `RenderRequest.scriptValues` 的说明补一句；
    - `RenderMeta` 加 `textSyncs?`。
  - **修改** `.claude/skills/kabegame-chromium/SKILL.md` 两处：
    - 「探针的通用能力 `scriptValues`」后面加「文本字段」一条：字段表、字符串值、规整规则、结清、`textSyncs`、MCP 只发 FR、`host.texts()`；
    - REST 表的 `render` 行补文本字段、字符串、`textSyncs`。
- **点 4 — 文档**（`x3/`）
  - `cocs/wpe/WPE_SCENE.md`「文本对象（P6b 1d 起）」：
    - 开头改成 1d、1e 两段，另起「动态文字的流向」：字段与通道、取值、状态、重排器、仍要重编译的；
    - 表里改了编译、排版、渲染图、矩阵、GPU、不支持项、dev 探针七行；
    - 新增「运行中重排与重建」「独占合成 RT 与 fbo」「`max(4, ·)`」「异步字体」「变体预备」五行；
    - 新增 1e-2 的对照结论、1e-3 的语料段；
    - 「已知差异与后续」补 1e 的四条。
  - `cocs/README.md`：WPE_SCENE 条目的「文本对象」一项改成含 1e 的摘要；适用场景加时钟不走、改属性没变化或整场重编译、换宽度后合成 RT / effect 不对、回退字晚几帧、极小文字、探针按字符串渲染。
  - `versions/latest/regression.md`：新增「## 场景壁纸 P6b 1e：动态文字」一节（E1–E16，全部 `[ ]`），放在「P6b 1d」一节之前。
  - `versions/latest/changelog.md`：开发侧 Added 加一行 P6b 1e（放在 1d 那行之前）。

**和计划不同处**
1. **`MAX_SCRIPT_TEXT` 取 4096**：计划没给数。时钟、计数一类不过十几个字，上限只为挡住误传的大串；64 项都取满是 256 K 个 UTF-16 单元，远小于 vite 请求体的 8 MB 上限。
2. **宿主不会写的值直接报错**：计划只写「按宿主同一规则规整」。按宿主规则，`pointsize` 给不是数的串、布尔位给数、`pointsize` 给两个分量时不写；探针这时抛错（REST 回 422），不是 `applied: true` 却什么都没变。规整放在解析阶段，所以有一项不对时状态不动。
3. **`ResolvedScriptValue` 改成联合类型**：文本目标多带一项规整好的值。`applyScriptValues` 的状态类型从 `Pick<SceneState, "write">` 放宽到 `"write" | "writeText"`，`scriptValues.test.ts` 里两个旧用例的替身补了 `writeText: vi.fn()`，断言不变。
4. **`settle` 的签名是泛型**：`settle<S extends Pick<SceneState, "touchText">>(scene: { sync(state: S): void }, state: S)`。计划写的是 `Pick<GpuScene, "sync">` 加 `Pick<SceneState, "touchText">`，但 `GpuScene.sync` 要整个 `SceneState`，这两个类型放不进同一个签名。实现抽成导出函数 `settleTexts`，单测用假的重排器、场景与状态直接调。
5. **轮数上限的数法**：同 `prepare`（每个对象最多读 16 轮字体、排 17 次），结清最多读 `MAX_FONT_ROUNDS` 轮、`sync` 最多 `MAX_FONT_ROUNDS + 1` 次；第 17 次 `sync` 之后仍有在读的抛错。
6. **新增 `wroteTextValues`**：`renderFrame` 要 GPU，单测测不到「没有文本值时不调 `sync`」。判断抽成纯函数，单测覆盖「只有图层字段」「文本值被跳过」两种情况；`renderFrame` 里的接线要真机验（见「没做」）。
7. **`idle()` 不循环**：只用一次 `Promise.allSettled` 等调用这一刻在读的那些，不循环等到集合为空。等的期间没有人重排，不会冒出新的读取；而循环的写法遇到「不删已结束的读取」会变成微任务死循环，单测会卡死，不会失败。
8. **REST 的字段错误文案**：沿用「只能是 origin / scale / …」开头，后面接「（图层字段），或 text / pointsize / …（文本字段）」。这样第 6 批的旧用例正则不用改。
9. **文档里顺手改的**：
   - `WPE_SCENE.md` 矩阵一行的对齐偏移：1d 写「子对象跟着走」，P8 步骤 3 起子对象的世界矩阵不带它（`drawMatrixOf`），按代码更正；
   - 「已知差异」一段的 `TODO:[WPE_SCENC]` 写成 `TODO:[WPE_SCENE]`。工作区里别的会话也在做这个更正，合并时取哪边都一样；「字体引擎」一节那处不在本节，没动。
10. **回归一节的位置**：放在「P6b 1d」一节之前，挨着 1d 的文本各节，没放到文件最上面。

**测试**
- tsc（o3）0 error（`tsc-o3.log`）。vite 插件 `deno check`（`replay.ts`、`replay.test.ts`、`rest.test.ts`、`scene.ts`、`types.ts`）通过。
- Prettier `--check`：改动的 14 个 TS 文件全过（`prettier3.log`）。仓库的 Markdown 不按 Prettier 排（基线 `xb3` 的三份 md 本来就不过），没查。文件都是 LF、有结尾换行。
- vitest（带 `KABEGAME_WPE_ROOT`；快照里没有 `wpefont.wasm`，同基线）：
  - o3：115 个文件、2785 条，2742 过、1 失败、42 跳过（`vitest-o3.log`）；
  - h3：113 个文件、2767 条，2725 过、1 失败、41 跳过（`vitest-h3.log`）；
  - 多出的 18 条都是新增用例（17 过，1 条真 wasm 的跳过）；
  - 失败的是同一条 `pipeline.test.ts`「全部场景编译、P1 / P2a 解锁、读取及请求次数有界」，**但失败项多了一个**：
    - h3 只有 `3830255100: 219 次请求`，o3 另有 `3413921910: 335 次请求`；
    - 原因：`3413921910` 的 `text:script` 以前在对象检查阶段就报，快速路径（确定退回就停）只发 4 次请求；去掉之后要编到着色器才遇到 `combo:REFLECTION` / `material:alphawriting`，发了 335 次请求、读 22.5 MB；
    - 它仍然退回，结论不变；200 次的上限没改，留给你定（见「没做」）。
- vitest（放进 `wpefont.wasm`，真 wasm 的文本用例也跑；`o3` 是临时放进去、跑完删了，基线用 `h3` 的临时拷贝，跑完删了）：
  - o3：115 个文件、2795 条，2794 过、1 失败、0 跳过（`vitest-o3-wasm.log`）；
  - 基线：113 个文件、2777 条，2776 过、1 失败、0 跳过（`vitest-h3w-wasm.log`）；
  - 多出的 18 条全过；失败的同上（o3 多 `3413921910` 一项）。
- deno（`deno test -A --no-check scripts/kabegame-dev/`）：x3 26 passed（119 steps），xb3 26 passed（117 steps），多出的 2 个 step 是新增用例。
- 新增用例 18 条（宿主）+ 2 条（vite 插件）：
  - `dev/scriptValues.test.ts` 8 条：
    - 编译出的文本层与字段脚本（S1 的 `text`、`pointsize` 是文本目标，能力表不报）；
    - 按名字、按下标都解析到文本目标，字符串原样、`pointsize` 收数，空串也是值；
    - `text` 收数时 ToString、收布尔转字符串，`pointsize` 收数字串；
    - 没挂字段脚本时 `optional` 跳过、否则抛错，图层与文本字段的脚本不互认；
    - 字符串给图层字段、超长（4096 过、4097 抛）、形状不对、宿主不会写（`pointsize: "abc"`、`[1, 2]`，`limitwidth: [1]`）、不是运行中字段的文本键（`font`、`opaquebackground`、`backgroundcolor`、`Text`）都抛错；
    - 真 `SceneState` 经 `writeText` 写、只标 `dirtyTexts`，图层字段照旧，`text: [7]` 写成 "7"（属性侧规则不写）；
    - 替身上文本目标只调 `writeText(对象, 字段, 规整后的值)`、不调 `write`；
    - `wroteTextValues`。
  - `compile/texts.test.ts`：改了 2 条的期望（见下），没有新增。
  - `text/idle.test.ts` 4 条（假排版 + 闸门读取器，不要 wasm）：
    - 没在读时返回 false；
    - 缺字体发起的读取：结束前不返回，结束时 `onReady` 已调过、返回 true，之后再问返回 false；
    - 两个读取同时在读时等全部结束，读取器抛错也算结束；
    - `dispose` 后回调丢掉，读取照样算结束。
  - `dev/probeTexts.test.ts` 5 条：
    - 假重排器：缺字体一轮 → 等 → 标脏再 `sync` 后排成，返回 2；字体都在时一次；
    - 一直有在读的：`sync` 17 次后抛错；
    - 没有文本层时 `settle` 返回 0、不调 `sync`、不读文件；
    - 真 wasm（没有 wasm 时跳过）：`prepareProbeTexts` 排「A」，换成「A中」后 `settle` 沿回退链逐轮读字体，排出两个字形。
  - `host.script.test.ts` 1 条：同一个返回值（"F183"、12、true；`maxwidth` 250.5）经字段脚本写回的 `textFields` 与经探针 `applyScriptValues` 写进的完全相同。
  - vite 插件：
    - `replay.test.ts` 1 条：`TEXT_FIELDS` 等于宿主的 12 个；文本字段收字符串、空串、4096 长、数与布尔；图层字段给字符串 400 指到 `value`；4097 长 400；形状不对 400；`NaN` 指到分量；`font` / `opaquebackground` / `backgroundcolor` / `Text` 400 指到 `field`；
    - `rest.test.ts` 1 条：文本字段的字符串原样转给后端，四种不合法回 400、不调后端。
- 改了期望的旧用例（逐条）：
  - `compile/texts.test.ts`「text 挂脚本报 text:script…」：改成 12 个运行中字段逐个挂脚本不报、全挂也不报，`font`、`opaquebackground`、`backgroundcolor`、`outlinecolor` 挂脚本报 `text:script:<键>`；
  - `compile/texts.test.ts`「能力：MSDF 开关与 anchor…」：编译结果的 `unsupported` 去掉 `text:script`，另加一个 `font` 挂脚本的对象、期望 `text:script:font`。
- 语料（`kbp corpus scan` / `diff`）：
  - 扫描期间本机语料在长：第一次 173 → 175，再扫是 179、183。所以最后用同一份清单（`corpus3-samples.txt`，183 张）`--only` 两边各扫一次（`corpus3-h3.json` / `corpus3-o3.json`、`corpus3-diff.txt`）。
  - 结果：两边 183 张、0 出错；只有 `text:script`（88 张）与 `text:script:maxwidth`（6 张）消失，没有新增的键；干净 66 → 75。
  - 1e-2 那份 173 张的子集是 57 → 66，同计划。
  - 解锁 9 张：`2304304373`、`2391389126`、`2903412088`、`3813887347`、`3819179413`、`3824424509`、`3825103811`、`3826727460`、`3836725625`，同计划列的 9 张。
  - 新出现的 10 张里 9 张两边都干净；`2861028294` 去掉 `text:script` 后还缺 `script:api:layer.text` 等，所以不算解锁。
  - 第一次扫描的结果留在 `corpus3-*-first.json` / `corpus3-diff-first.txt`。
- 变异检查：
  - 宿主：`kbp mutate`，快照模式，清单 `mutate3.json`，结果 `mutate3.txt`。跑之前把 `wpefont.wasm` 临时放进 `o3/src/wpefont/`，让真 wasm 的用例也当检出方，跑完删掉。
    - 15 处全部检出，每处按原字节还原，整树哈希前后一致；
    - 计划的 6 条：运行中字段照报、`font` 不报、探针文本值落到 `state.write` 兜底、结清不等字体、结清不 `touchText`、`idle` 不删已结束的读取；
    - 补的 9 条：只放行 `text`、探针不按宿主规则规整、探针图层字段收字符串、探针超长差一、探针文本字段只找图层目标、`wroteTextValues` 不看 `applied`、结清上限差一、`prepareProbeTexts` 的 `onReady` 不记对象（只有真 wasm 的用例能检出）、`idle` 不等读取。
  - vite 插件：`mutate3x.py` 在 x3 里逐处按原文替换，跑 `replay.test.ts`、`rest.test.ts`，再按原字节写回、核对文件 SHA-256。没用 workspace 模式。
    - 5 处全部检出，整树哈希前后一致（`mutate3x.log` / `.json`）；
    - 5 处是：REST 放过图层字段的字符串（计划的那条）、超长差一、不认文本字段、抄本多一个 `font`、文本字段的值不查形状。
    - Prettier 改写 `replay.ts` 之后重跑过一遍，结果相同。

**没做 / 要你定或真机确认**
- **`pipeline.test.ts` 的 200 次请求上限**：`3413921910` 现在 335 次（见测试）。三种处理：
  - 把上限放宽；
  - 给这张单独记一条；
  - 让快速路径更早发现 `combo:REFLECTION` / `material:alphawriting`（产品改动，不在 1e-3）。
  没改测试，等你定。
- **真机全部没做**（回归 E6–E16）：
  - `p6b-script` 的 s1 按「F183」渲染和 WPE 第 182 帧比；
  - `2391389126` 按抓帧里的时间字符串渲染；
  - `2304304373` 改 `textinput` / `pointsize` 不重编译、`blurprecise` 时钟换宽度时 RT 与 fbo 跟着换；
  - 9 张解锁场景（`2903412088`、`3836725625` 逐区域比，其余 4 张并排看，`3824424509` 日历停在初值）；
  - 每帧变的文字耗时；桌面。
- **`renderFrame` 里结清的接线**：`wroteTextValues` → `texts.settle(scene, state)`，以及 `textSyncs` 进结果，要 GPU，只有真机能验。REST `/render` 的 409 检查（宿主产物不认识 `scriptValues`）没改：没重建的老产物收到文本字段时，探针会报「field 要是图层字段」，按现有的错误映射应当回 422，没实测。
- **MCP** 的 `render_scene` / `host_render` 没改（计划如此），只发 FR；`apps/kabegame-dev-mcp` 自己的 `ScriptValue` 类型也没放宽。
- **`WPE_SCENE.md`「字体引擎」一节**开头还写着「文字随脚本或属性变化是 1e」，不在本节范围，没动。
- **changelog 用户侧**没加。建议照别的场景能力加一行，例如「场景壁纸里的时钟与文字会走动：…创意工坊 2304304373 等 9 张现在可实时渲染」，要不要加、怎么措辞由你定。
- dev 探针仍按 `C:\Windows\Fonts` 读系统字体（1d2 的约定），所以结清只在 Windows dev 上对。

#### 1e-3 复核（Claude，2026-11-13）

- **越界**：真实工作区里子代理没动任何文件（`.claude/skills/kbp-tools/ts/replayLib.ts` 的改动是别的会话 P4f 步骤 3 的）。
- **复跑**：
  - o3 tsc 0 error；
  - vitest（放进 `wpefont.wasm`）2795 条，2794 过，失败的就是 `pipeline.test.ts` 那一条（`3413921910: 335 次请求`、`3830255100: 219 次请求`）；
  - x3 `deno test` 26 passed（119 steps）。都和子代理报的一样。
  - 注意：快照里的 vitest 要在快照目录里用根目录的 `node_modules/vitest/vitest.mjs` 跑；从仓库根 `--config` 指过去会全部报 `Cannot read properties of undefined (reading 'config')`。
- **我加的变异**（`ignore/p6/b1e/mutate3-claude.json` → `mutate3-claude.txt`）：4 处全部检出，还原一致：
  - `wroteTextValues` 恒为假；
  - 结清上限差一；
  - 结清时先等字体、后 `sync`；
  - 探针规整时跳过 `scriptWriteValue`。
- **合并**：期间 HEAD 先到 `b42b9990`、又到 `1616bb2b`（P4f 步骤 3）。工作区里有别的会话没提交的改动（P4f、P10a 等），`features.ts`、`probe.ts`、`host.script.test.ts` 和本步重叠，所以逐个文件三方合并：
  - 宿主 8 个文件：祖先取 h3（这些文件 HEAD 上和 `187f41c9` 相同）。只有 `probe.ts` 两处冲突，都是两边在同一处各加了一项（别的会话的 `animations`、本步的 `textSyncs`），两项都留；
  - `scripts/kabegame-dev/` 4 个文件与 SKILL.md：工作区和 xb3 相同，直接拷；
  - 文档 4 份三方合并：
    - README：「适用场景」那一行 HEAD 的 P9b 在行尾加了一段、本步在文本那段后插了一段，按位置拼起来；
    - WPE_SCENE.md：取本步（只多「1e 起：」）；
    - changelog：两边都留（P9b 在前、1e 在后）；
    - 回归没有冲突。
  - 合并后导出工作区快照（`ignore/p6/b1e/w3`）：tsc 0 error，vitest 2910 条过 2909 条。失败的仍是 `pipeline.test.ts`，多出来的 `2251857160`（读 82 MB、553 次请求）来自别的会话没提交的改动。
  - 顺手：WPE_SCENE.md「字体引擎」一节开头「文字随脚本或属性变化是 1e」改成 1e 起就地重排；回归 1e 一节按下面的真机结果勾选。
- **真机**（dev，宿主产物用合并后的工作区重建；工坊场景用 `kbp content unpack` 解包到 `ignore/p6/b1e/real3/proj/` 再导入，WPE 抓帧在 `A:\p6b\e3-*`）：
  - **`p6b-script`，探针按「F183」**：s1 区域和 WPE 第 182 帧 0 差异，`textSyncs` 1。对照组（不给文本值）同一区域 10628 个像素不同。给「你好😀F7」时 `textSyncs` 8，中文、彩色 emoji 都画出来了；给没挂字段脚本的 `pointsize` 回 422、写明原因。
  - **`2391389126`**：WPE 窗口按 3840×2160 开，系统把客户区限成 3840×2130（fill 缩放仍是 1）。WPE 画「21:33」，探针按它渲染，文字区域 0 差异。1600×900 窗口下差 805 个像素：WPE 按窗口分辨率直接画字形，我们先按场景分辨率画再缩，这是已知的上屏差异，所以真实场景都按场景分辨率比。
  - **`2903412088`**：从抓帧读 foliagesway 的 `g_Time`（12.798033714294434），按属性缺省（horizontal 86、vertical 95）与场景尺寸算两层的 `origin`：
    - 字形内部和 WPE 相同，边缘最大差 19；
    - 背景随时间在动，没有文字的区域也处处有差（最大 12），所以边缘差归背景；
    - 宿主实时跑脚本算出的 `origin` 与我给探针的完全相同。
  - **`3836725625`**：背景是视频，文字的 effect 是模糊（和时间无关），像素不比。我当时记成「三层文字的排版和 WPE 一致」，**这是错的**，见下面的「更正与修复」。WPE 的 Date 层画了 11 个字形（「13 NOV 2026」，带空格，虽然场景里 `addDelimiter` 覆盖成空串），我们宿主的脚本算出的也是这一串。
  - **`2304304373` 实时预览**：
    - 5 个时钟层是当前时间；
    - 用属性面板的同一条命令改 `yourname`、`textsize`：`applied` +1，`recompiled` 为空，「Kabegame 你好」等 8 轮回退字体后补上，最长重排 16.3 ms；
    - 跨整分时 5 层在同一次 `sync` 里重排、重建，合成 RT 宽度 632 → 636、`blurprecise` 的 734 → 738。
  - **每帧变的文字**（`p6b-script` 实时）：10 秒 600 帧，重排平均 0.07 ms、重建 0.23 ms，整帧 0.56–0.63 ms。
  - **9 张解锁场景**：都实时渲染、时钟是当前时间、没有重编译。唯一的脚本错误在 `3824424509` 的 `objects/8/visible`：
    - 脚本先 `layers.push(thisScene.getLayer(i.toString()))`，再拿这些图层对象调 `thisScene.getLayer(layers[i])`；
    - 我们的 `getLayer` 收到对象返回 null，`update` 抛错后被禁用，日历的文字与颜色停在初值；
    - 归在已定 1 的「日历要等步骤 2」里，步骤 2 做 `getLayer` 时要认图层对象参数。
  - 应用日志没有 WebGPU 错误、没有 `text:engine`。
  - **收尾**：
    - 移除 10 个测试行（`batch_remove_images`），关掉主窗口的预览（开始时原来的预览已经关了）；
    - WPE 只开关了本会话的测试窗口，设置没改；Kabegame 设置没改；
    - E16（设为桌面壁纸）没测。
- **待定**：
  1. `pipeline.test.ts` 的 200 次上限：`3413921910` 现在 335 次；
  2. ~~changelog 用户侧要不要加一行~~：用户定不加（2026-11-13）。

#### 1e-3 更正与修复：图层向量字段绑标量属性（Claude，2026-11-13，用户要求直接修）

**发现。** 用户在真机上并排看 `3836725625`，我们的字被纵向拉长。上面复核里「排版一致」是看裁图下的结论：背景是视频、比不了像素，我就退回了肉眼。

**定位**（复制工程，`ignore/p6/b1e/make_e3text.mjs`）：
- 去掉视频图层，父对象「时钟」的 `origin` 脚本换成场景中心，`scale` 绑定照留，只留三层文字；做静态字符串（`e3text-s`）、脚本返回同一串（`e3text-r`）两版；
- WPE 3840×2130 窗口抓帧（`A:\p6b\e3text-s\`、`A:\p6b\e3text-r\`），探针同尺寸整帧比：两版我们这边相同（不是运行中重排的问题），和 WPE 都差 15631 个像素；
- x 方向一致，y 方向三层都拉长约 1.4 倍；排版 `size`、合成 RT 尺寸三层都和 WPE 相同（490×219、457×154、896×219）；
- WPE 事件 146（Day 上屏）的顶点是 ±228.5 × ±77，上屏高 125.5 = 154 × 1.13179 × 0.72。我们父对象的 `scale` 是 `[0.72]`（实时宿主 `host.state()` 与临时诊断单测 `ignore/p6/b1e/w3/src/render/e3dump.test.ts` 都读到），y、z 在 `layerLocalMatrix` 里补成 1。

**根因与来历。**
- WPE 的 `origin` / `scale` / 图像层 `color`（vec3，`FUN_1401a4230`）与 `parallaxDepth`（vec2，`FUN_1401a3fc0`），和材质常量、general 字段是同一组 setter（`ignore/p3-userprops/notes/descriptors-decomp.txt`）：数字铺满各分量，字符串少写的分量为 0，布尔不写。
- P1（`916f5cf5`、`3780ab82`，2026-11-01）用 `numbers()` 取图层字段，建矩阵时补缺省。
- P3 读码（`phase3/p3-script-REPORT.md`「属性写入」表）记下了「数字会铺满三个分量」并实测过。
- P3a（`8f5a44ac`）的绑定表与 `writeLayer` 原样继承了 P1 的写法。
- P3c 的 `generalValue` 给 general 字段做了铺满；2026-11-08 的 `54ab0c08` 给材质常量做了铺满。图层字段都没改。

**影响。** 本机语料 34 张场景、245 个字段是这种绑定（scale 119、parallaxDepth 120、origin 6），见 `ignore/p6/b1e/scalar_vec_scan.mjs` → `scalar_vec_scan.txt`。当时判成能渲染的有 3 张，都是 1e-3 刚解锁的：`3836725625`、`3825103811`（时钟 `scale` 1.5，这层缺省隐藏）、`2903412088`（`origin`，脚本每帧覆盖 x、y）。

**修复。**
- **修改** `compile/materialValues.ts`：原来的 `writeValue` 导出为 `setterValue`，`materialSetter` 照旧用它。
- **新增** `compile/bindings.ts`：`LAYER_VECTOR_FIELDS`（origin / scale / color 3 个分量，parallaxDepth 2 个）、`isLayerVectorField`、`layerVectorValue`（= `setterValue`）。`angles` 是另一个 setter（`FUN_1401df2f0`，没读透、语料没有标量绑它），不动。
- **修改** `compile/bundle.ts`：这四个字段改走 `layerVectorValue`。属性值写不进时退回 JSON 的 `value`，再写不进取缺省。
- **修改** `render/state.ts`：`write` 的图层分支对这四个字段走 `layerVectorValue(conditioned(…))`，写不进时不写、不标脏，同 WPE 不改字段。
- **新增** `compile/layerVector.test.ts` 7 条：
  - 与 `materialSetter` 逐值相同；
  - 四个字段绑数字铺满，写死的字符串照读；
  - 布尔、条件、两者都写不进三种情况；
  - 就地写 = 重编译（数字、字符串）；
  - 写不进时不标脏。
- 文档：WPE_SCENE.md 材质常量一条后补「图层的向量字段同这组 setter」；回归 E14 更正、新增 E17；changelog 按用户定不加。

**验证。**
- 工作区快照（`ignore/p6/b1e/w4`）：tsc 0 error，vitest 2917 条过 2916 条，失败的只有 `pipeline.test.ts` 那一条，失败明细和修复前相同。
- 重建宿主产物后，`e3text-s`、`e3text-r` 和 WPE 整帧（3840×2130）都是 0 差异。

**教训**，已写进 `.claude/plans/wpe-import/3-scene/FINAL_CHECK.md`：
- 同一条 WPE 规则在代码里有好几份实现，阶段验收只证明自己那一份；
- 真实场景比不了像素时，要做复制工程再比，不能退回肉眼；
- 复制时被测对象的父链、绑定一样都不能动。

#### 走查 `2903412088`（按 `FINAL_CHECK.md`，Claude，2026-11-14，两层时钟文字已完成）

**复制工程**（`ignore/p6/b1e/make_e3clock.mjs`）：只留两层时钟文字（对象 179、67，没有父对象），脚本、`origin` 绑的标量属性、`visible` 绑定、`scriptproperties`、foliagesway、`colorBlendMode` 30 / 8 全部原样，删掉背景、两组粒子、全屏组合层、声音。另有两个**诊断变体**，只用来隔离：
- `e3clock-nofx`：去掉两层的 foliagesway；
- `e3clock-nofx2130`：再把场景正交尺寸改成 3840×2130，和 WPE 测试窗口的客户区一样大。

**状态还原**（探针不跑脚本，按 `scriptValues` 塞脚本这一帧的输出）：
- 文字串取 WPE 画面；
- `origin` 照两段脚本，用属性缺省（horizontal 86、vertical 95）和 `canvasSize` 算，z 取属性铺满后的值；
- `g_Time` 取抓帧里 foliagesway 的常量；
- 窗口 3840×2130（系统把客户区限到这么大），后处理关闭。

**结果与定位**：

| 工程 | 帧 | 和 WPE 整帧比 |
|---|---|---|
| `e3clock`（原样） | `A:\p6b\e3clock\` 4 帧 | 每帧 17–31 个像素，最大差 3 |
| `e3clock-nofx` | `A:\p6b\e3clock-nofx\` | 12 个像素，都差 1 |
| `e3clock-nofx2130` | `A:\p6b\e3clock-nofx2130\` | 29 个像素，最大差 3 |

用逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）逐 draw 对照 `nofx2130`：
- **黑字层**：画字形后的合成 RT 和 WPE RT 10356 逐像素相同；
- **青字层**：合成 RT 有 196 个像素差 1，都在 alpha 为 0 的背景拷贝里。这一层 `copybackground`，先用 composelayer 从场景快照拷背景，快照里已有黑字层的边缘；
- **两边逐项相同**：顶点、UV、`g_Color4`、混合、着色器公式；
- **只有两处不同**：
  1. MVP 的平移和 WPE 差 1–3 个 float32 ulp：
     - 黑字层两个 draw 的 x、y 都小 1 ulp；
     - 青字层两个 draw 的 x 大 3 ulp；
     - 两层画字形的 y 大 1 ulp。
  2. 图层四边形的三角形对角线：我们 `layerQuad` 是 4 顶点三角形带，对角线右下–左上；WPE 是 6 索引列表，对角线左下–右上。

**实验**（临时钩子 `// DEBUG-e3clock`，已删）：
- 只把 6 个 draw 的 MVP 换成 WPE 的值（轨迹确认逐位相同）：29 → 14 个像素，青字层 RT 196 → 71；
- 只换对角线：29 → 19 个像素，最大差 1；青字层 RT 188；
- **两样都换：整帧 0 差异，两层合成 RT 都 0 差异**。

所以 `nofx2130` 的全部差异都由这两处解释：它们让双线性采样点挪动约 1e-4 像素，边缘少数像素跨过取整边界。

**读码确认**（2026-11-14，`../rea-matrix-order.md`，Claude 另从二进制直接反汇编核对了 VP / MVP、文本层对齐偏移、公共四边形三段）：
- MVP：WPE 每个乘积、每次加法都舍入成 f32，没有 FMA。
  - `MVP = M ⊗ (V ⊗ P)`，`⊗` 是丢掉第 3 行的仿射乘法，求和顺序 k = 2 →（平移项）→ 1 → 0；
  - 对齐偏移只改平移列，顺序是 `((a.x·W[r] + W[12+r]) + a.y·W[4+r]) + a.z·W[8+r]`；
  - 我们的 `multiply` 在 double 里累加 4 项、最后舍入一次。按读出的顺序复算，6 个值全部逐位等于抓帧。
- 四边形：公共函数 `FUN_1401ede30`，顶点依次是左上、右上、左下、右下，索引 `0,2,1, 1,2,3`，对角线是右上–左下。字形和粒子的索引我们已经照 WPE。泛光链 WPE 画的是一个全屏三角形，我们画的是 `layerQuad([2, 2])`。

**产品修正后**（`../phase-f32-matrix.md`，2026-11-14，宿主产物 `index-Dnwr6b5o.js`，请求体在 `ignore/p6/b1e/real3/e3clock/f32/`）：

| 工程 | 帧 | 修正前 | 修正后 |
|---|---|---|---|
| `e3clock`（原样） | WPE 第 304–307 帧 | 每帧 17–31 个像素，最大差 3 | 4 帧都是 0 |
| `e3clock-nofx`（先按 3840×2160 画、再按 fill 裁到 3840×2130） | WPE 第 241、242 帧 | 12 个像素，都差 1 | 两帧都是 0 |
| `e3clock-nofx2130` | WPE 第 240、241 帧 | 29 个像素，最大差 3 | 两帧都是 0；6 个 draw 的 MVP 逐位等于 WPE，两层合成 RT 0 差异 |

foliagesway 的 pass 和「先画再裁」那条路径都没有新的差异，三份工程的差异全部来自上面两处。**走查结论**：`2903412088` 的两层时钟文字和 WPE 逐帧整帧逐像素相同，没有遗留差异。完整场景里另外几个对象（背景、两组粒子、全屏组合层、声音）不在这次走查范围内。

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
