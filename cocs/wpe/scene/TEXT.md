# 场景壁纸：文本

> [场景壁纸文档](../WPE_SCENE.md) 的一章：字体引擎 `wpefont`、文本对象与 MSDF（P6b、P6f）。总体形态、各阶段状态与全部章节的索引在总览里。

## 字体引擎 `wpefont`（P6b 1b 起）

文本对象（P6b）照 WPE 的画法：FreeType 栅格化、HarfBuzz 排字，逐字四边形加图集。WPE 的字形位置和位图由这两个库的具体版本与加载参数决定，自己写栅格化器对不上像素，所以直接把同版本的库编成 wasm 放进场景宿主，排版规则（回退链、断行、对齐、图集装箱）另在 TS 里照读码写（1c 起）。静态文本 1d 起照 WPE 画，文字随脚本或属性变化 1e 起就地重排（见下一节「文本对象」）。完整接口契约见 [src-tauri/wpefont/README.md](../../../src-tauri/wpefont/README.md)，计划与实测见 [phase-6b-text.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md)「步骤 1a」「1b」。

| 项 | 内容 |
|---|---|
| 版本 | FreeType 2.14.3（子模块 `third/freetype`，标签 `VER-2-14-3`）、HarfBuzz 15.0.0（`third/harfbuzz`），都没有补丁，vendor base 记在 `third-patches/{freetype,harfbuzz}/README.md`。1a 把 2.13.2 – 2.15.0 编成 wasm 和 WPE 抓帧的图集比：2.14 系列只差 1 个像素（WPE 装箱器清零格子四周造成，不是栅格化），2.13 差 37 个，2.15 另差 251 个 |
| 位置 | `src-tauri/wpefont/`：C 胶水 `wpefont.c`、FreeType 模块表 `ftmodule.h`；编成 wasm32-wasip1 reactor，不链进应用 |
| 构建 | `deno task build:wpefont` → `bin/wasm/wpefont/wpefont.wasm`（git 忽略，约 1.8 MB，全量约 1 分钟）。首次把 wasi-sdk 34 的 `wasi-sysroot` 与 `libclang_rt` 下到 `bin/wasm/wpefont/toolchain/`（`scripts/download.ts` 的 `fetchPinned`：SHA-256 校验、可续传、已有就不下）；要带 wasm32 目标的 LLVM clang（`WPEFONT_CLANG` → `PATH` → macOS Homebrew 的 llvm）。编译参数照 1a：`-O2`、不加改数值的开关，setjmp 走 wasm 异常处理 |
| 进宿主 | kabegame 命令不带 `--skip vue` 时，`WpefontPlugin` 拷到 `apps/wpe-scene/src/wpefont/`（内容相同不重写）；缺失只告警，文本对象会退回预览图 |
| 前端接口 | `apps/wpe-scene/src/wpefont/index.ts`：`loadWpefont()`（主线程 `fetch` → `compile` → 带 WASI 桩实例化 → `_initialize`；失败返回 null，原因见 `wpefontLoadError()`）；`Wpefont.face(bytes, pointsize)` → `WpefontFace` 的 `has` / `metrics` / `shape` / `glyph` / `box` / `dispose`。排字结果与度量是 26.6，位图与字形框是整数像素；位图拷出成按行紧排的 `Uint8Array`（灰度 1 字节、BGRA 4 字节 / 像素），位图宽高就是 WPE 图集的格子；`box(gid)`（导出 `wpefont_glyph_box`，按 gid 缓存）是 WPE 取框 `FUN_1401addb0` 的 `FT_LOAD_NO_BITMAP` 轮廓框（`FT_Glyph_Get_CBox(PIXELS)`），四边形、断行、包围盒都用它。普通字形两者相同，彩色字形不同（Segoe UI Emoji 的 😀：框 141×142、位图 133×132，位图被拉伸；Twemoji 是 COLR，框为空） |
| 排版与图集（1c） | `apps/wpe-scene/src/text/`，纯 TS、不碰 GPU：`fonts.ts` 的 `TextFonts`（按「字体 + 字号」的 face 列表，回退链按需加载、永久留下；字体字节由注入的读取器给，位置约定 `system:<文件>` = `%WINDIR%\Fonts`、其余是引擎路径；缺字体时同步返回 `missingFonts`，读完重排、图集不动；分段照 `FUN_1401ad670`）、`layout.ts` 的 `layoutText`（照 `FUN_1401b0410`：分行、断行、省略号、两端对齐、行内对齐、包围盒，float32 逐步舍入；输出普通 / 彩色两组四边形、文字框、图层 `size`、合成 RT 尺寸、对齐偏移；`directTranslation` / `compositeTranslation` 是两条绘制路径的平移）、`atlas.ts`（逐行移植 `FUN_1401ae080` 的装箱器：格子 = 位图宽高、shelf、空隙判定的差一、四周清零、零尺寸字形占位、回收与翻倍；R8 与 RGBA8 按「字体 + 字号」共享；脏区给增量上传）、`mesh.ts`（WPE 的顶点 / 索引布局）。字形在排版时逐个栅格化进图集（越界的那个也进，省略号量宽不进），对象按场景顺序 |
| 加载参数 | 第 0 个 face、Unicode 字符表、`FT_Set_Char_Size(0, trunc(pointsize · 64), 300, 300)`（300 DPI）、`hb_ft_font_create`；加载字形用 `FT_LOAD_RENDER \| FT_LOAD_COLOR` |
| 两条 hinting 规则 | TrueType（有 `glyf`）**没有 `fpgm`** 时加 `FT_LOAD_FORCE_AUTOHINT`（FreeType 自己判「没有 hinting」还看 `prep`，所以在胶水里补）；CFF 不强制，走原生 CFF 引擎。两条都和 WPE 图集逐字节对过 |
| 系统字体 | `systemfont_*` 与回退链要读的是 WPE 在 `%WINDIR%\Fonts` 下的 13 个文件（WPE 不随壁纸分发）：`wpe_scene_host.rs` 的 `SYSTEM_FONT_FILES` 是所有平台共用的名字表（`arial.ttf calibri.ttf cambria.ttc comic.ttf consola.ttf micross.ttf segoeui.ttf verdana.ttf`，rea-p6b-raster 2.2；`seguiemj.ttf arialuni.ttf seguisym.ttf msyh.ttc Malgun.ttf`，2.3；拼写和 `text/fonts.ts` 逐字相同）。后端按平台把每个名字解析成本机上第一个存在的文件（`platform_system_fonts`，P6b 1d2）：Windows 是 `%WINDIR%\Fonts\<名字>`（取不到 `WINDIR` 时为空表；系统装在别的盘时同样读得到）；macOS / Linux 各有一张候选表（`MACOS_SYSTEM_FONTS` / `LINUX_SYSTEM_FONTS`），先同一款字体（macOS `Supplemental/` 自带的 Arial、Verdana 等，Linux 的 msttcorefonts），再度量兼容或外观接近的替代（Liberation、Carlito、Caladea、DejaVu、Noto、Noto Sans CJK 等），画面只求像、不会和 WPE 逐像素相同；macOS 表 2026-11-21 在 26.6.2（装了 Office）上核对过：除 `seguiemj.ttf` 外都解析到文件，交给宿主的表与之一致，宿主经 `file:` 都读得到、表外文件被拒；不装 Office 时的后备（Georgia、Menlo、Helvetica）同一系统上也在。实际画出的字形和 Linux 表仍没核对，标 `TODO:[WPE_SCENE]`。候选必须是普通文件、不是符号链接（同 `file:` 闸门），所以 Debian msttcorefonts 的小写链接会跳到首字母大写的文件。彩色 emoji（`seguiemj.ttf`）在 macOS / Linux 不给替代：Apple Color Emoji（sbix）与 Noto Color Emoji（CBDT）是内嵌 PNG，wpefont 没编进 libpng、读不了，emoji 交给回退链后面的 Twemoji（COLR）；`arialuni.ttf` 只有 macOS 有同款。宿主的 `file:` 范围逐个放行解析出的文件（不放行整个目录），`wpe_scene_target` 的 `systemFonts` 把同一份表交给宿主，两边不会对不上；本机没有的名字不在表里，宿主读它时当读不到（同 WPE 跳过不存在的文件）。TTC 一律取 face 0（同 WPE），Noto Sans CJK 的 face 0 是 JP 字形 |
| 测试 | `src/wpefont/index.test.ts`：wasm 不存在整组跳过；`KABEGAME_WPE_ROOT` 指向 WPE 时用 WPE 自带字体跑基础用例和 `fixtures/baseline.json` 的逐项基线（9 个单行、不需要回退的对象，gid、步进、位图尺寸、left / top、位图 SHA-1，由 `scripts/fixtures/make_wpefont_baseline.py` 从 1a 的结果生成）；测试不读系统字体。`src/text/layout.test.ts`：`fixtures/p6b.json`（`scripts/fixtures/make_text_fixture.py` 从 WPE 抓帧生成）的 6 个工程、44 个对象逐个比四边形（排版坐标与 UV）、排版原点在场景 / RT 里的位置、图层 size、合成 RT 与背景尺寸，21 张图集比解码后像素的 SHA-256；系统字体和抓帧机器不同时跳过那个工程。`atlas.test.ts`、`fonts.test.ts` 钉装箱与分段里基线覆盖不到的分支 |

**对照结论**（1b）：子模块版本的产物对 `p6b-geom`、`p6b-align`、`p6b-fx`、`p6b-fallback`、`p6b-extra` 的 38 个对象、342 个字形，和 1a 发布包 2.14.3 的结果逐字段相同。1c 改接口后重跑仍逐字段相同。

**对照结论**（1c）：`p6b-*` 六个静态工程的 44 个对象，四边形、原点、文字框、合成 RT 尺寸和 WPE 全部相同；21 张图集（含 1 张彩色）解码后逐字节相同，包括 1a 剩下的 opensticks「2」那 1 个像素（空格的 1×1 格子按差一规则压在「2」的第一列上，清零下一行时清掉了它）。

**CEF**（1b，dev，Chrome/149.0.7827.201）：宿主里编译、实例化成功（wasm 异常处理可用）；NotoSans 32 / 200 号、`arial.ttf`、`msyh.ttc` 的排字与位图哈希和 Node 逐项相同；没放行的 `times.ttf` 被 `file:` 闸门拒（`deny file: … OutsideRoot`）。

## 文本对象（P6b 1d 起）

文本对象在 WPE 里是一种图层：变换、可见性、`color` / `alpha` / `brightness`、effect 链和图像层一样，只是基础 pass 画的是逐字四边形，四边形来自排版（`text/layout.ts`，1c）。1d 做静态文字（加载时排一次）；1e 让文字在运行中变：字段脚本的返回值（时钟、计数）与用户属性（`textinput` 改文字、`slider` 改字号）就地重排，不整场重编译。步骤 2 加上 `ITextLayer` 脚本 API（`thisLayer.text = …`、`getLayer(…).text`）。计划与读码依据见 [phase-6b-text.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md)「1d」「1e」「步骤 2」。

**动态文字的流向**（1e）：WPE 改文本字段时先和上次排版用的值逐项比较，变了才重排（`FUN_140256f20` 开头的比较表，rea-p6b-layout 3.5）；我们照这个做。
- **字段与通道**：运行中可改的是比较表里除 `font`、`opaquebackground` 以外的 12 个字段（`compile/bindings.ts` 的 `TEXT_RUNTIME_FIELDS`：`text`、`pointsize`、`padding`、`spacing`、`maxwidth`、`maxrows`、`limitwidth`、`limitrows`、`limituseellipsis`、`blockalign`、`horizontalalign`、`verticalalign`）。它们挂脚本或绑属性时，绑定目标是 `{ kind: "text", object, field }`，字符串只在这种目标上流通。
- **取值**：规则只在 `text/fields.ts` 一份。脚本侧 `textFieldFromScript` 照 WPE 类型 5 的 `ToString`（`null` / `undefined` 不写，`12` → `"12"`），枚举再查表，布尔位只收布尔；属性侧 `textFieldFromJson` 同编译期的 setter（`text` 只收字符串）。`text` 字段脚本的值类型恒为字符串，不按初值猜（`"Song Title"` 按初值猜会当成 vec2）。
- **状态**：值写进 `SceneState.textFields`，和现值比较（`sameTextField`），变了才标 `dirtyTexts`，所以脚本每帧返回同一串时不重排。脚本写回在帧内第二次 `sync` 里排，当帧生效；属性写在两帧之间，下一帧生效。
- **重排器**（`SceneTexts.relayouter()`）：排进这次加载的图集，绑定加载代数，更新的加载开始或宿主销毁之后返回 null、不动图集（重编译期间旧场景还在画，不能把字形排进新加载的图集）。先放旧排版的字形引用再排新的（同 WPE「先放旧、再排新」）；缺字体时把引用加回去、旧排版照画，后台读字体，读完 `onReady` 把这一层重新标脏（暂停时补画一帧）。
- **仍要重编译的**：`font`、`opaquebackground`、MSDF 四个开关、`anchor`、HDR 下的 `backgroundbrightness` 绑属性照旧重编译（1e 已定 3；MSDF 开关 P6f 起是对象级重编译），文本层的 effect 开关也是。MSDF 的装饰参数绑属性就地写、当帧生效（P6f）。

| 项 | 内容 |
|---|---|
| 认定 | `isTextObject`：`text` 键不为 null（`text: ""` 也算，整层不画）。能力表不再报 `object:text` 与各文本键；`alignment`、`depthtest`（正交场景）在文本上中性；MSDF 四个开关与装饰参数 P6f 起支持（见下「MSDF（P6f）」） |
| 编译（`compile/texts.ts`） | 文本对象跳过模型，effect 与 colorBlendMode passthrough 照图像层编，文本表排在它们之后（`padding` 看启用的 effect 个数）。字段照 WPE 的 setter 规整：`text` 只收字符串（或对象的字符串 `value`），枚举查不到取表里第一项（`horizontalalign` → left、`verticalalign` → center、`anchor` → none），vec2 一个分量铺满。主字体按资源查找顺序定位（工程 → `scene.pkg` → WPE `assets`），`system:` 字体由宿主读。四个 WPE 自带材质经宿主 pass 编：`basefont`（R8 图集；MSDF 时换 `basefont_msdf`，按描边、模糊、投影三位带 COMBO）、`basefontrgba`（彩色图集）、`fontbackground`（开 `opaquebackground` 时）、`composelayer_clearalpha`（没开背景、可能走合成时）。背景色 `backgroundcolor × (HDR ? backgroundbrightness : 1)` 是常量键 `objects/<i>/text/background` 的 `g_Color`，LDR（或 HDR 下亮度恒为 1）时就地可改。12 个运行中字段绑属性登记文本目标（1e），其余绑定登记成重编译 |
| 排版（`text/host.ts`） | 宿主主线程的 `SceneTexts` 在声音、脚本与 GPU 资源之前排好全部文本层：wasm 实例与读过的字体跨重编译保留，每次加载新建图集（装箱顺序同 WPE），按对象顺序排、缺字体就读完重排（每对象最多 16 轮），每个 await 后比加载代数。wasm 不在或排版出错报 `text:engine`、退回预览图。`system:<名字>` 按 `wpe_scene_target` 的 `systemFonts` 表读本机文件（后端按平台解析，见「字体引擎」的系统字体一行），表里没有的名字读不到、不回落到目录；没有表时（Node 单测、dev 探针）才按 `fontsDir`、缺省 `C:\Windows\Fonts` 拼。排完后图集留在实例上，`relayouter()` 经 `load` 交给渲染器（1e） |
| 渲染图（`render/graph.ts`） | `text` 步骤（`part`：`background` / `glyphs` / `color`；`space`：`direct` / `composite`）。直接上屏：`[背景] → 普通字形 → [彩色字形]`，colorBlendMode 31 时全部 additive，否则材质的 translucent。合成：RT 先「清成 (背景色, 图层 alpha)」（`clear` 的 `color: "text-background"`，每帧现算）或 clearalpha（`compose` 角色、读快照），再画字形（translucent），之后 effect 链、passthrough、上屏照图像层，上屏 UV 内缩的分母是文字框的整数部分。合成 RT 是排版的 `compositeSize`（`trunc(w + 2·padding)`）两维 `max(4, ·)`（`textCompositeSize`，1e 更正，见下）。排版为空的层不画；文本层的 effect 开关会改 `padding` 与文字框，切换整场重编译 |
| 矩阵（`render/uniforms.ts` 的 `textMatrices`） | 直接上屏的字形 `VP · W · T(directTranslation)`；背景 `VP · W · T(−w/2 − pad.x, −h/2 − pad.y)`，四边形 `[0, W] × [0, H]` 取 `textCompositeSize`；画进合成 RT `ortho(0, W, 0, H, ±1000) · T(compositeTranslation)`，W、H 同样是 `textCompositeSize`（对着 RT 像素）。对齐偏移只在本层画自己时右乘（`drawMatrixOf`，P8 步骤 3 起子对象的世界矩阵不带它） |
| `anchor`（P6e 第 3 步，`render/layout.ts`） | 九种取值都支持。绘制时在**世界空间**给本层画自己的矩阵加平移：`T(ax, ay, 0) · W`（`withAnchor`，只改平移列、f32 加）。实测 `p6e-anchor2`：自身放大 2 倍的仍移 E、自身转 90° 的仍沿世界 x、父对象缩放 0.5 下仍移 E，与自身和父链的缩放、旋转都无关。直接上屏与合成上屏都带，合成 RT 内部的矩阵不动；光标命中同样带（`render/cursor.ts`，WPE 拾取时也调这一项）；`getTransformMatrix` 不带（rea-p6d-layers 第 8 条）。<br>平移表（`anchorOffset`，rea-p6b-layout 3.4，f32），`mx = (E0 − E2)/2`、`my = (E3 − E1)/2`：<br>- `center (mx, my)`、`top (mx, −E1)`、`bottom (mx, E3)`、`left (E0, my)`、`right (−E2, my)`；<br>- `topleft (E0, −E1)`、`topright (−E2, −E1)`、`bottomleft (E0, E3)`、`bottomright (−E2, E3)`；<br>- `none` 为 0，矩阵原样。<br>`E0..E3` 是四边被裁掉的场景单位（WPE 正交投影 `ortho(E0, W − E2, E3, H − E1)` 的边距，rea-render-size 第 1 节），每帧一份（`GpuScene.setAnchorEdges`）：<br>- dev 探针给了 `canvas` 时：正交投影用的同一份 `alignEdges`；<br>- 产品：2026-11-19 起同探针，按画布画、`E` 就是投影用的那份边距（`GpuScene.anchorEdgesNow` 取 `crop`），`fit` / `center` 下推到场景之外的文字在留白里看得见，同 WPE；之前先按场景分辨率画再铺放、按显示铺放算 `anchorEdgesFor`，`fit` / `center` 下贴边文字看不到；<br>- 拉伸、平铺与透视场景为 0。 |
| GPU（`render/text.ts`） | 每字形 4 个顶点、6 个索引的三角形列表，索引 uint16（超过 16384 个字形换 uint32）。图集是第一种运行时纹理：每个 `GlyphAtlas` 一张（`r8unorm` / `rgba8unorm`，线性、repeat，同一「字体 + 字号」的层共用），建场景时整张上传，`sync` 按脏区增量上传；扩容（尺寸与 UV 全变）时释放旧纹理、按新尺寸建并整张上传（标签不变），用这张图集的层一起重建（1e） |
| 运行中重排与重建（`render/scene.ts`，1e） | `sync` 最先 `syncTexts`：对 `dirty.texts` 逐层调重排器，排成的 `setText` 换进状态（偏移变了，本层的矩阵在同一次 `sync` 里刷）。某张图集到 4096 清空重排过（`GlyphAtlas.resets` 变了）时，用它的别的层也重排（1e 已定 5），每层每次 `sync` 至多 2 次（`TEXT_RELAYOUT_LIMIT`，防连环重置），到上限的留到下一次标脏。然后图集纹理增量上传，扩容了的层也进重建集合；最后对集合 `rebuildLayer(…, { force: true })`：签名相同也整层重建 draw（新顶点、新索引）。不另写「只改顶点」的路径，步骤增减（空 ↔ 非空、第一次出现彩色字形）、合成 RT 换尺寸、图集换纹理都走这一条。强制重建不计入 effect 开关的 `rebuildStats`，次数与用时记在 `GpuScene.textStats()` |
| 独占合成 RT 与 fbo（1e 已定 6） | 文本层的合成 RT 与 effect fbo 由本层独占、不进共享池：共享池只增不减，按尺寸共享的话时钟每换一个宽度就攒一张新 RT。尺寸和新排版不同就销毁旧的、按新尺寸建（WPE 也是每次重排重新分配）。fbo 每个 effect 的每个名字一张（同名同尺寸、`scale` / `fit` 不同的两张换尺寸后会不同，共用一张就换不了），换尺寸时在同一下标换纹理并清成 `clear` 色，swap 状态不变；标签 `fbo text <图层 id>\|<effect>\|<名字>\|<宽>x<高>\|<格式>\|<repeat>`。文字变空（没有合成路径）时释放本层合成 RT，再变非空时按新尺寸重建；fbo 不释放，换成空排版的 4×4 基准 |
| `max(4, ·)`（1e 更正） | `textCompositeSize` = 排版的 `compositeSize`（WPE `+0x128` 查询的结果，`TextLayout` 里不变）两维各取 `max(4, ·)`，截断后不是有限数时同 `cvttss2si` 取 4。WPE 在 `FUN_1401ea500` 里把查询结果原地改成 `max(4, ·)`，之后读它的三处都套：合成 RT（连同画进 RT 的正交）、effect fbo 的基准、直接上屏的背景四边形。不套的两处：图层尺寸 `TextLayout.size`（上屏四边形、clearalpha 四边形、矩阵里的 w、h），以及上屏 UV 内缩的分母（`trunc(size)`）。所以宽 2 的文字在 4 宽的 RT 里只占左半，上屏时整张 RT 铺到 2 宽的四边形上，字形横向压一半。1d 写「不套」是错的：两组极小文字的工程 `p6b-tiny`、`p6b-tiny2`（WPE 的合成 RT 宽 2、3 的都是 4×6）和开背景的 `p6b-tiny3`（WPE 的背景四边形是 `[0, 4] × [0, 6]`）都和 WPE 整帧逐像素相同 |
| 异步字体（1e 已定 4） | 帧循环里不能等：重排发现缺字体时保留旧排版、后台读，读完下一帧补上。WPE 同步读，所以第一次出现新回退字时我们晚一到几帧。真机可见预览里，帧循环自己走完 5 轮回退链不到 0.7 秒 |
| 变体预备（1e） | `variantPlans` 对文本层按「普通字形与彩色字形都有」的假想排版给计划（尺寸取当前排版）；`prepareVariants` 只备程序与管线，不按假想尺寸建 RT、不建快照。管线和尺寸、字数无关，运行中步骤增减不会碰到 `render:variant-missing` |
| 不支持项 | `text:script:<键>`：运行中字段以外的文本键挂脚本。`font`、`opaquebackground` 运行中改要整场重编译，MSDF 的开关与参数没有脚本写回目标（`ITextLayer` 没有这些字段）。12 个运行中字段挂脚本不报（1e-3 去掉了 `text:script`）；`backgroundcolor` 挂脚本 P6f 起不报（目标同属性绑定，只有 HDR 且 `backgroundbrightness` 不恒为 1 时照报）。`text:msdf:color`：MSDF 下的彩色字形（emoji），那个字形不画、运行期经看板娘提示（P6f 已定 2）。另有 `text:engine`、`render:text-layout`（没交排版结果）。P6e 之前 none / center 以外的 `anchor` 报 `text:anchor:<值>`，第 3 步起支持（见上一行） |
| dev 探针 | `renderFrame` 建场景前同样排好文本层（`dev/probeTexts.ts`），`render_scene` 能直接渲染文本场景。`scriptValues`（1e-3）收文本层的运行中字段，`value` 可以是字符串（最长 4096 个 UTF-16 单元），按宿主同一条写回规整（`textFieldFromScript` → `writeText`），宿主不会写的值报错。探针不跑脚本、没有帧外补画，写进文本值之后回放前**结清**：`sync` 一次，有字体在读（`SceneTexts.idle()`）就等读完，把 `onReady` 记下的层重新标脏再 `sync`，直到没有在读的字体（最多读 16 轮，同 `prepare`），结果的 `textSyncs` 是 `sync` 的次数；没有文本值时不结清、逐字节同以前。vite 的 `/render` 同样放宽（`scripts/kabegame-dev/replay.ts` 的 `TEXT_FIELDS`，图层字段给字符串 400）；MCP 的 `render_scene` 只发 FR 帧号块，按字符串渲染走 REST 或 `host_eval`。`host.texts()`（1e-2）：`textStats()`（有重排或重建的 `sync` 次数、重排器调用与没排成的次数、重建层数，每次的层数、重排用时、重建用时的均值 / p95 / 最大值）与每个文本层当前的文字、字号、`size`、`compositeSize`、字形数 |

### MSDF（P6f）

文本对象打开 `msdf`、`outline`、`blur`、`dropshadow` 任一个，整层换成多通道距离场画法；描边、模糊、投影全在 `font.frag` 的 `MSDF` 分支里。计划与依据见 [phase-6f-msdf.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6f-msdf.md)、[rea-p6f-msdf.md](../../../.claude/plans/wpe-import/3-scene/phase6/rea-p6f-msdf.md)。

- **距离场**：不自写算法，`wpefont` 编进 msdfgen **v1.13**（子模块 `third/msdfgen`，导出 `wpefont_msdf`），照 WPE 的外围流程调：
  - 轮廓用 `FT_LOAD_NO_BITMAP`（带 hinting、对象字号）加载；
  - 包围盒 `FT_Glyph_Get_CBox(PIXELS)`；
  - `normalize` 之后多调一次 `orientContours`；
  - 投影参数 float32；
  - 转字节 `×256` 截断、上下翻转、alpha 255。

  v1.13.1 改了 `symmetricalTrichotomy`，和 WPE 不同，不用。
- **图集与排版**：
  - 字体键 `<路径>_msdf`，与字号无关，同一字体文件的所有字号共用一张 RGBA8 图集；字形按「第一个用到它的对象」的字号生成，后面的字号复用（同 WPE）。
  - 格子 = `max(1, trunc(bbox · 32 / y_ppem)) + 24`，装箱与 R8 图集是同一个装箱器；空格占 24×24 不写像素。
  - 四边形各边外扩 `pad = f32(y_ppem) · 12 · 0.03125`，`y_ppem` 取本对象字号的；文字框不含 `pad`，所以 `padding` 小于 `pad` 时合成路径会裁掉贴边的装饰（同 WPE）。
- **材质与常量**：
  - `basefont_msdf` 的 COMBO：`OUTLINE_ENABLED`（厚度 ≥ 1）、`BLUR_ENABLED`、`DROP_SHADOW_ENABLED`；
  - 每次绘制按装饰参数现算 `g_RenderVar0..3`（`render/uniforms.ts` 的 `msdfRenderVars`，逐条 float32，含 5.1（`0x40a33334`）与 6 的钳制、描边给模糊让位）；
  - `g_Texture0Resolution = (W, H, W, H)`；
  - 合成路径与直接上屏用同一个变体和同样的常量。
- **运行中**：装饰参数（颜色、厚度、模糊、投影大小 / 偏移 / 不透明度）绑属性是就地目标 `text-decor`，当帧生效、不重排；四个开关绑属性走对象级重编译（语料 0 处）。
- **彩色字形**（emoji）：WPE 在 MSDF 下不经 msdfgen、用自己的距离变换，我们照报 `text:msdf:color`（语料 0 处）。
- **FreeType 要开 `FT_CONFIG_OPTION_USE_HARFBUZZ`**（走查查出，普通 R8 文字同样受益）：自动 hinter 经 HarfBuzz 顺着 GSUB 给只能经替换到达的字形归类。`3833971732` 的「16:22」里 HarfBuzz 把冒号换成抬高的冒号（LXGW 文楷 gid 20066，字体没有 `fpgm`），不开时 hinted 框宽 13、和 WPE 差 1 像素，开了逐字节相同。见 [wpefont README](../../../src-tauri/wpefont/README.md)。
- **`backgroundcolor` 的字段脚本**（P6f 点 7，`p6f-bg` 实测）：返回值当帧生效（直接上屏的背景与合成 RT 的清屏色同帧）；`Vec3` 原样写、数字铺满、字符串不写（保持上一个值），目标同属性绑定。

**对照结论**（P6f，dev）：
- **生成工程**：`p6f-atlas`（6 种字体，含 CFF、无指令 TrueType、回退 CJK）、`p6f-deco`（11 组装饰与钳制、缩小 / 放大）、`p6f-fx`（合成路径）、`p6f-grow`（94 个字形跨多行）和 WPE 整帧比（排除 FR / CLK）全部 0 差异。
- **图集**：9 张、148 个格子与 WPE 逐字节相同。
- **最终走查**（FINAL_CHECK，复制工程，脚本按录制的 `Date` 起点跑）：`3829268059`、`3833971732`、`3816870245`、`3593919489` 和 WPE 录制帧整帧逐像素相同。过程中解释并处理了两处差异：
  - `3816870245` 的整组文字偏移：场景开了相机视差，第一次录制没控制光标；改用 `input_start` 喂中心光标、回放 `cursors: "log"` 后为 0。
  - `3833971732` 冒号的 1 像素：即上面的 `USE_HARFBUZZ`，修后为 0。
- **语料**：293 张干净 286 → 290，解锁 `3833971732`、`3816870245`、`3829268059`（MSDF）与 `3593919489`（`backgroundcolor` 脚本），别的场景不变。

**对照结论**（1d，dev，Chrome/149.0.7827.201）：`p6b-geom`、`p6b-align`、`p6b-wrap`、`p6b-fx`、`p6b-fallback`、`p6b-extra` 六个工程按 1920×1080 渲染，和 WPE 的上屏整帧（排除 FR / CLK）比：五个逐像素相同，`p6b-fx` 只有 1 个像素差 1。覆盖直接上屏、合成路径（effect、清成背景色、clearalpha）、背景、CJK 回退与彩色 emoji。宿主实际加载的画面和探针的画面（遮掉 FR / CLK）哈希相同。

**对照结论**（1e-2，dev）：`p6b-tiny`、`p6b-tiny2`、`p6b-tiny3` 和 WPE 整帧逐像素相同（最大差 0），合成 RT 套 4、上屏时字形横向压缩、背景四边形套 4 三处映射都对；1d 的六个工程像素摘要不变。运行中改属性用 `p6b-user`（`textinput` 属性改文字、`slider` 属性改字号，直接上屏与合成各一层）：依次改成「Hello world」→ 空 →「Ab😀」（字号 32 → 64）→「你好 Ab」，`recompiled` 始终为空，合成 RT 随文字换尺寸（宽 184 → 901 → 676 → 945），空排版与第一次出现彩色字形都正常；每次改完的画面（遮掉右下角帧号 / 时钟）都和「用新属性整场编译」的画面相同。单次重排最长 8.7 ms（64 号中文首次栅格化），重建最长 1.6 ms。挂脚本的文字（时钟）和 WPE 的对照在 1e-3 真机验收里做。

**语料**（1d）：173 张场景干净 47 → 47，解锁 0 张。92 张文本场景里 87 张有 `text:script`（时钟类，1e）；只剩 `text:script` 的是 `2304304373`、`2391389126`、`3824424509`。文本层上的 effect 以前不编，现在照编，带出了它们自己的不支持项（`uniform:g_AudioSpectrum16*` 4 张、`model:passthrough:children:framebuffer` 2 张等），这些场景本来就不干净。92 张文本场景在 Node 里用真 wasm 排版全部成功（981 层、8476 个字形，中位 5 ms、最慢 189 ms）；3 张的主字体找不到、退回 arial，其中 2 张是工程里确实没有这个文件，`2887099508` 的 pkg 条目名像是 GBK 编码，WPE 能不能按 UTF-8 路径找到没查。

**语料**（1e-3，去掉 `text:script`）：只有 `text:script`（88 张）与 `text:script:maxwidth`（6 张）消失，没有新增的键。1e-2 那份 173 张的语料干净 57 → 66，解锁 9 张：`2304304373`、`2391389126`、`2903412088`、`3813887347`、`3819179413`、`3824424509`、`3825103811`、`3826727460`、`3836725625`；本机语料扩到 183 张后是 66 → 75，解锁的是同样 9 张（新增的 10 张里 9 张本来就干净，`2861028294` 还缺 `script:api:layer.text` 等）。这 9 张的文本脚本都是 `new Date()` 的取值拼字符串，不用 `toLocale*` / `Intl`，不涉及本地化格式差异。去掉一个早报的项以后，快速路径（确定退回就停）要编到更后面才遇到第一个不支持项：`3413921910`（剩 `combo:REFLECTION`、`material:alphawriting`）从 4 次请求变成 335 次，超过 `compile/pipeline.test.ts` 的 200 次上限。

**脚本 API**（步骤 2，`script/api.ts` 的 `installText`）：

- **装在哪**：文本层的脚本对象装上 WPE 文本描述符的 17 个字段，只装在文本层上，别的图层上同名属性是普通属性。
- **规则**：读回的形状与写入规则照 WPE 实测（`p6b-api`、`p6b-api-enum`，计划里有逐条表）：
  - float 只收数字、按 f32 读回；
  - 向量收一个数字（铺满）或带齐分量的对象；
  - 布尔位只收布尔；
  - 字符串类 ToString；
  - 枚举大小写敏感，查不到取表里第一项；
  - `maxrows` 截断取整。
- **生效**：
  - 12 个运行中字段落到 1e 的文本目标，当帧重排；
  - `backgroundcolor` 用和属性绑定同一个目标，LDR 下就地写背景常量；
  - `font`、`opaquebackground`、`backgroundbrightness`、`anchor` 整场重编译，重编译完成前读回待生效的值（WPE 当场生效、不重载）。
- **`getLayer`**：收到本场景的图层对象时原样返回（WPE 实测 `getLayer(layer) === layer`）。
- **对照**：
  - `p6b-api-rt` 用探针跑脚本，和 WPE 整帧比：除每帧变的帧号文字与 FR / CLK，0 差异；
  - `p6b-api` 在预览里重编译后，s3 的字体、背景、文字框（310×168）和 WPE 一致；
  - `3824424509` 的日历格子和 WPE 同一天的画面 0 差异；
  - 语料 183 张干净 88 → 90，解锁 `2861028294`、`3429479356`（后者带 4K 视频纹理，探针等第一帧超时；改用去掉视频层的复制工程，3840×2130 窗口下整帧 0 差异；1920×1080 窗口按窗口尺寸画也是 0 差异，以前两个 `blurprecise` 层的差来自先画再缩）。

**已知差异与后续**：回退链里的 Twemoji 只查 WPE `assets`；普通字形为 0 个时不出 `glyphs` 步骤（WPE 画不画空网格没查）；系统字体在 macOS / Linux 上换成本机的同款或替代字体（1d2；macOS 的路径 2026-11-21 核对过，画出的字形与 Linux 的路径待真机核对，`TODO:[WPE_SCENE]`），画面和 WPE 不会逐像素相同。1e 起：
- 缺字体时晚一到几帧：WPE 同步读字体，我们读完下一帧才补上，中间照画旧文字（已定 4）；
- 不再用的图集不释放：GPU 纹理与 CPU 侧的 `TextAtlases` 留到场景销毁，拖字号滑块会攒新的「字体 + 字号」图集（每张至少 512²）。WPE 的字体管理器也按字体键留着，释不释放没查；
- `font` / `opaquebackground` 运行中改整场重编译（已定 3），挂脚本报 `text:script:<键>`；经 API 写同样整场重编译（步骤 2）；
- `anchor`（P6e 第 3 步）：
  - 2026-11-18 之前产品在 `fit` / `center` 下 E 为负，贴边的文字被推到场景之外看不到；2026-11-19 产品按画布分辨率画之后留白里看得见，同 WPE；
  - 脚本或属性运行中改 `anchor` 走单对象重编译（L6），晚一小段才生效（WPE 当帧，语料没有这种写法）；
  - 带 effect 的文本层：anchor 平移在本层画自己的矩阵里（`GpuScene.drawWorldOf`），效果矩阵与 `g_LayerModelMatrix` 也带上了；WPE 的 effect pass 带不带没有专门实测（语料只有 `2981249186` 的模糊文字，走查时看）；
- 经 API 写过的重编译类字段，之后读回一直取那次写入的值（`recompileValues`），用户再改同一属性时读回可能和画面不一致（语料没有这种用法）。
