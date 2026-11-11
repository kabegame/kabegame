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

步骤 1 之前另有一步 **1a 选型探针**：把 FreeType + HarfBuzz 编成能在宿主里跑的 wasm，用离线参考的基线核对逐像素一致（见步骤 0c 实施记录「对后面几步的影响」）。

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

## 步骤 1 — 静态文本（细节待 1a 之后补写）

大致的点：
- **编译期：** 文本表（字体文件、字号、排版字段、文字初值、绑定）；选 `basefont*` 材质并翻译；能力表放开 `object:text` 与实现了的字段，没实现的照报细分键（`text:msdf:*` 等）。
- **`text` 字段脚本：** 写回目标 `{ kind: "text", object }`，返回值进 `SceneState`，变了才重画。
- **宿主：** 字体加载与缓存（FreeType wasm）；回退链；排版（TS，照读码）；字形图集（R8 与 RGBA8）；文字框尺寸进图层；背景（`fontbackground` / `flat`）。
- **渲染：** 文本层作为图像层的一种，基础 pass 用 `font` 材质画逐字四边形；彩色字形另画一次；有 effect 时画进合成 RT（初值 `composelayer_clearalpha` 或背景色）再接链。
- **用户属性：** `text` / `color` / `pointsize` 等就地，改了重排、重画，不整场重编译。

**验收：**
- `2391389126` 解锁，和 WPE 同一时刻的画面比。
- 确定性工程：`p6b-*` 的字形图集、四边形、原点、合成 RT 尺寸和 WPE 逐像素、逐坐标相同；整帧画面在字形区域逐像素比。
- 时钟工程：只在文字变时重排。

## 步骤 2 — 脚本 API（细节待步骤 0 后补写）

`ITextLayer` 的字段装进文本层的脚本对象（照 `installSound` 的样板），写入落到就地目标、触发重排；从 `scriptApi.ts` 的缺口表里删掉实现了的字段。

## 风险

1. **wasm 工具链：** FreeType 与 HarfBuzz 能不能用现有的 `clang` + `wasm32-unknown-unknown` 编过（没有 libc，要自己给 `malloc` / `memcpy` 之类；HarfBuzz 是 C++），1a 先探；Linux 构建 guest 与 macOS 也要有同样的 clang。不行就换 emscripten 或现成的 `harfbuzzjs`。
2. **版本漂移：** WPE 内嵌的 FreeType 版本不明。2.13.2 加两条 hinting 规则对 12 种字体（含 4 个 CFF）逐像素一致，只有 opensticks（没有 hinting 表的 TrueType，走自动 hinter）3 个字形有残差，2.12.0 / 2.13.0 / 2.13.2 结果相同。推断 WPE 用的是改过自动 hinter 的更新版本；1a 自己编 FreeType 时按版本试。语料 80 种字体里大多没测，1a 之后拿语料字体补一轮。
3. **字体回退：** 回退链读 `C:\Windows\Fonts`，用户机器上缺 `arialuni.ttf`（随 Office 装）等文件时和 WPE 一样跳过；两台机器字体不同时画面本来就不同。
4. **重排的开销：** 82 张有时钟，一秒重排一次没问题；每帧都变的文字（滚动字幕之类）要实测 wasm 排字加图集上传的耗时。
5. **字体内存：** 最大的字体 25 MB，一张场景的字体可能几十 MB，预览和桌面各一份。
6. **和别的会话抢文件：** 步骤 1 要改 `compile/bundle.ts`、`compile/features.ts`、`compile/scripts.ts`、`render/scene.ts`、`render/graph.ts`、`host.ts`。P5b 正在改图像层的几何与合成 RT，动工前看一次另几边的工作区，新代码尽量放进新模块（`compile/texts.ts`、`text/`）。
7. ~~**读码工具：**~~ REA 一度连接超时，2026-11-11 用户重连后已恢复。

## 决定

**已定：**
1. 进入 P6b（2026-11-11 用户）。

**待定（附推荐）：**
1. **栅格化与排字：** 推荐把 FreeType 2.13.2 + HarfBuzz 编成 wasm（步骤 1a 先探工具链），和 WPE 逐像素一致；不用浏览器画布（做不到一致）。画法随之照 WPE，逐字四边形加图集（原待定 1「整段一张纹理」作废）。
2. **MSDF 路径：** 推荐 P6b 报 `text:msdf:<键>`、不做（语料 2 张、5 个对象），以后要做再移植 msdfgen。
3. **`depthtest`：** 推荐正交场景直接放开（读码加实测：正交场景 WPE 不测深度），透视场景随 P5d。
4. **系统字体：** 推荐宿主读 `C:\Windows\Fonts` 下回退链与 `systemfont_*` 的那几个文件（`file:` 闸门对这几个文件放行），不随应用分发字体。
