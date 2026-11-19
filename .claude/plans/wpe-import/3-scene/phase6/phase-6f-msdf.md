# P6f — 文本的 MSDF 路径（描边、模糊、投影）

> 上级：[phase-6b-text.md](phase-6b-text.md)（P6b 当时定了 MSDF 照报，「已定 3」）。读码：[rea-p6b-raster.md](rea-p6b-raster.md) 第 3–7 节、
> [rea-p6f-msdf.md](rea-p6f-msdf.md)（本步的逆向，2026-11-19）。工作目录 `ignore/p6/f0/`。

## 总体设计思路

WPE 的文本对象只要打开 `msdf`、`outline`、`blur`、`dropshadow` 四个开关中的任意一个，就整层换成 MSDF 画法：
- 字形不再是 R8 覆盖率位图，而是 msdfgen 生成的三通道距离场，放进一张 RGBA8 图集；
- 描边、模糊、投影全在 `font.frag` 的 `MSDF` 分支里，由 `g_RenderVar0..3` 驱动。

我们沿用 P6b 处理 FreeType 的思路：**不重新实现距离场，而是把同一个库编进 `wpefont`，按 WPE 的外围流程调用**。理由是步骤 0b 已经证明这条路能做到逐字节一致。把 msdfgen v1.13 和 FreeType 2.14.3 编成 wasm、照逆向记录第 2 节走一遍，结果和 WPE 抓帧里的图集比：
- 9 张图集、148 个格子、约 101 万字节，**全部逐字节相同**；
- 覆盖了 TrueType 字节码、CFF、无指令 TrueType、回退到 msyh 的 CJK、空格占格、「同字形先到的字号胜出」、94 个字形跨多行的装箱。

所以距离场这一层没有任何自写算法，C 接口只多一个 `wpefont_msdf`。

宿主这边，MSDF 是同一套文本管线上的一个「模式」，不是新的图层类型。改动只有以下几处：

| 环节 | 普通路径 | MSDF 路径 |
|---|---|---|
| 字体键 | `<路径>_<size26.6>` | `<路径>_msdf`，与字号无关，所以同一字体文件的所有字号共用一张图集 |
| 图集与格子 | R8，格子 = 位图尺寸 | RGBA8，格子 = `inner + 24`；装箱器是同一个（WPE 也是同一段代码，产品里已逐行移植） |
| 四边形 | 字形包围盒 | 各边外扩 `pad = y_ppem · 12 / 32`（按本对象字号） |
| 材质 | `basefont` | `basefont_msdf`，按描边、模糊、投影三位选 8 个 COMBO 变体之一 |

每次绘制按对象当前的装饰参数现算 `g_RenderVar0..3`，算式是逆向 4.2 的 float32 顺序。

运行中变化的划分照 WPE 的重建条件（逆向 4.3）：
- **装饰参数**（厚度、颜色、偏移、不透明度、模糊半径）每帧从对象拷，所以绑属性时走就地写，当帧生效；
- **「是不是 MSDF」**（四个开关有没有任何一个开着）决定图集与几何，变了要重排；
- **开着时在三个装饰开关之间切换**只换材质变体。

本步把绑了属性的开关登记成对象级重编译（L6 已有的路，语料里没有开关绑属性的），不另做就地切换。

彩色字形（emoji）在 MSDF 下 WPE 不经 msdfgen，用的是自己的距离变换。语料的 6 个 MSDF 文本对象一个 emoji 都没有，所以照报，由宿主在排版时发现彩色字形就报运行期不支持项（决定 2）。

## 步骤 0 的结论（2026-11-19）

**语料**：293 张里还剩 3 张只差 MSDF，一共 6 个文本对象，全是正交场景、没有 HDR。

| 场景 | 对象 | 用法 |
|---|---|---|
| 3833971732 | 2 个 | 霞鹜文楷（CJK）；只开投影（大小 32 / 26.8，超过 6 的上限，被钳）；一个 `text` 绑属性，一个挂时钟脚本 |
| 3816870245 | 3 个 | Quicksand / Anurati（CFF）；描边加投影；都带 `blurprecise` effect（走合成路径）；时钟脚本 |
| 3829268059 | 1 个 | spincycle_3d（CFF）；描边、模糊、投影全开；时钟脚本 |

开关和装饰参数都没有绑属性，也没有挂脚本。

**逆向**（rea-p6f-msdf）：
- 版本等价于 msdfgen **v1.13**（`e36d714` 到 `1c106ed` 之间，本流程用到的代码逐行等价；v1.13.1 只改了一处 trichotomy）。
- 和 msdfgen 上游缺省用法不同的地方：
  - 轮廓用 `FT_LOAD_NO_BITMAP` 加载、带 hinting、按 300 DPI 的对象字号；
  - 包围盒来自 `FT_Glyph_Get_CBox(PIXELS)`；
  - 多调一次 `orientContours`；
  - 投影参数用 float32 算；
  - 转字节是 `×256` 后截断、上下翻转、alpha 写 255；
  - 生成用「第一个用到这个字形的对象」的字号。
- 图集：RGBA8、无 mip、双线性、WRAP，`g_Texture0Resolution = (W, H, W, H)`；装箱与 R8 图集是同一段代码。

**实测**：
- 5 个工程（`ignore/p6/f0/defs/p6f.py`：atlas、deco、fx、grow、color），WPE 抓帧在 `A:\p6f\`，图集导出在 `ignore/p6/f0/out/rd/tex/`。
- 对照 wasm：`ignore/p6/f0/msdf/build.py` + `kbmsdf.cpp`；对照脚本 `cmp.mjs`。
- 除彩色字形外，全部格子逐字节相同（见上）。
- `KBRULE`（wpefont 的 fpgm 规则，无指令 TrueType 强制自动 hinting）照加：opensticks 的格子在加规则时相同。

## 现状锚点

**a. 四个开关一律报不支持**（`compile/features.ts:769`、`:790`）
```ts
const TEXT_MSDF_KEYS = ["msdf", "outline", "blur", "dropshadow"] as const;
export function checkTextOptions(values: …, unsupported: Set<string>): void {
  for (const key of TEXT_MSDF_KEYS) if (values[key]) unsupported.add(`text:msdf:${key}`);   // 现状：开了就整张退回
}
```

**b. 文本只编普通字形与彩色字形两种材质**（`compile/texts.ts:41`）
```ts
const TEXT_MATERIALS = {
  glyphs: "materials/fonts/basefont.json",   // 现状：没有 basefont_msdf*
  color: "materials/fonts/basefontrgba.json",
  background: "materials/fonts/fontbackground.json",
  clearAlpha: "materials/util/composelayer_clearalpha.json",
};
```

**c. 字体键带字号，图集一律 R8 / 彩色 RGBA8**（`text/fonts.ts:76`、`text/atlas.ts:362`、`:391`）
```ts
export const fontKey = (path: FontPath, size: number) => `${path}_${size26_6(size)}`;   // 现状：没有 _msdf 键
export interface FontAtlases { readonly key: string; readonly main: GlyphAtlas; color: GlyphAtlas | null; }
export function rasterizeGlyph(atlases, face, faceIndex, gid) {
  …
  const bitmap = face.glyph(gid);            // 现状：只有位图路径（FT_LOAD_RENDER | FT_LOAD_COLOR）
  const atlas = bitmap.mode === PIXEL_MODE_BGRA ? (atlases.color ??= new GlyphAtlas(true)) : atlases.main;
  return atlas.insert(key, gid, bitmap);
}
```
`GlyphAtlas` 的 `bpp` 由构造参数 `color` 决定（`color ? 4 : 1`），插入只认 `GlyphBitmap`。

**d. 四边形就是包围盒**（`text/layout.ts:433`）
```ts
const quad: TextQuad = {
  x0: f(f(x + record.x0) + shift),   // 现状：没有外扩 pad
  y0: f(baseline + record.y0),
  x1: f(f(x + record.x1) + shift),
  y1: f(baseline + record.y1),
  glyph: record.glyph,
};
```

**e. 文本绘制的 uniform 不写 `g_RenderVar*`**（`compile/features.ts:797` 注释，`render/uniforms.ts` 的 `textUniformValues`）
```ts
// features.ts：文本 pass 的程序检查放行 g_RenderVar0–3，渲染器不写（MSDF 另报 text:msdf:*）
export function textUniformValues(input: TextUniformInput): Record<string, number[]> {
  …staticBuiltins(…)   // 现状：g_Texture0Resolution 已经按槽传（注释写着「只有 MSDF 路径读」），RenderVar 不写
}
```

**f. `wpefont` 没有 msdfgen**（`src-tauri/wpefont/`、`scripts/build-wpefont.ts`）：FreeType 21 个单元、`harfbuzz.cc`、`wpefont.c`。导出见 README 的接口表，没有距离场。

## 点 1 — `wpefont` 加 msdfgen（`third/msdfgen`、`src-tauri/wpefont/`、`scripts/build-wpefont.ts`）

- **新增**
  - 子模块 `third/msdfgen`，pin 在 tag `v1.13`（同 `third/freetype`、`third/harfbuzz` 的做法；决定 1）。
  - `src-tauri/wpefont/msdf.cpp`：照 `ignore/p6/f0/msdf/kbmsdf.cpp` 的 `kb_msdf`，导出
    ```c
    // out[8]：x0 y0 x1 y1（FT_Glyph_Get_CBox PIXELS）、cellW cellH、生成了没有（0/1）、y_ppem。
    // 返回 cellW·cellH·4 字节 RGBA（第 0 行在上、alpha 255）；包围盒为空时返回全 0 的格子、out[6] = 0；加载失败返回 0。
    // 调用方用 wpefont_free 释放。
    uint8_t *wpefont_msdf(wpefont_font *font, int gid, int32_t *out);
    ```
    加载标志 `FT_LOAD_NO_BITMAP | (load_flags & FT_LOAD_FORCE_AUTOHINT)`，同 `wpefont_glyph_box`。
- **修改**
  - `build-wpefont.ts`：
    - 检查子模块与版本（`third/msdfgen` 的 `git describe` 是 `v1.13`）；
    - 并行编 `core/*.cpp`（去掉 `save-*`、`export-svg`、`shape-description`），用 HarfBuzz 那套 C++ 参数加 `-DMSDFGEN_PUBLIC=`；
    - `msdf.cpp` 加 sjlj（它包含 FreeType 头）；
    - 链接加 `-lc++abi`；导出加 `wpefont_msdf`。
  - `README.md`：接口表、版本与对照结论各补一段（v1.13 的依据、逐字节对照结果）。
  - `scripts/AGENTS.md` 若列了子模块，同步。

## 点 2 — 宿主的字形接口与图集（`wpefont/index.ts`、`text/atlas.ts`、`text/fonts.ts`）

- **新增**
  - `WpefontFace.msdf(gid): MsdfCell | null`：`{ x0, y0, x1, y1, width, height, generated, yPpem, pixels }`，拷出像素后立即释放。
  - `fontKey(path, size, msdf)`：MSDF 时返回 `<路径>_msdf`（逆向 2.1：键里没有字号）。
  - `rasterizeGlyph` 的 MSDF 分支（`atlases.msdf` 为真时）：
    - 查表命中直接用；
    - 否则 `face.msdf(gid)`，按格子尺寸进主图集（RGBA8）；
    - 彩色 face（`FT_FACE_FLAG_COLOR`）的字形不生成，返回 `{ unsupported: "text:msdf:color" }`，排版跳过它（决定 2）。
- **修改**
  - `GlyphAtlas`：构造参数从 `color: boolean` 改成 `bpp: 1 | 4`。MSDF 主图集 `bpp = 4`、`color = false`（`AtlasGlyph.color` 仍只表示进了彩色图集）。
  - `GlyphAtlas.insert` 多收一种来源：`{ width, height, rgba }` 原样整格拷进去（逐行 `width·4` 字节），清零四周写 4 字节 0（逆向 3.2）。
  - `FontAtlases` 加 `msdf: boolean`；`TextAtlases.get(key, msdf)`。
  > 说明：空格等包围盒为空的字形照样占 24×24 的格子、不写像素（逆向 2.6；步骤 0b 实测相同）。回收来的格子里残留的旧像素也照 WPE 不清。

## 点 3 — 排版（`text/layout.ts`、`text/host.ts`、`text/fields.ts`）

- **修改**
  - `layoutText` 的字体键与图集按 `fields.msdf`（四个开关之一为真）取。
  - 字形记录多一个 `pad`：MSDF 时 `f32(max(yPpem, 1)) · 12 · 0.03125`，`yPpem` 取本对象字号下这个字形所在 face 的值（逆向 4.1：不是生成字形时的字号）。
  - 建四边形时各边外扩：
```ts
const quad: TextQuad = {
  x0: f(f(f(x + record.x0) - record.pad) + shift),   // 修改：MSDF 时减 pad（非 MSDF pad 为 0，结果不变）
  y0: f(f(baseline + record.y0) - record.pad),
  x1: f(f(f(x + record.x1) + record.pad) + shift),
  y1: f(f(baseline + record.y1) + record.pad),
  glyph: record.glyph,
};
```
  - 顶点的先后照 `rea-p6b-raster` 第 5 节的表（`penX + x0 − pad + alignX`），落实时用 p6f 抓帧的顶点逐个核对 float32 的结合顺序。
  - 文字框、`minX` / `minY` 不含 `pad`（逆向 4.1），所以合成路径会裁掉贴边的装饰（逆向第 5 节）：照 WPE，不另处理。
  - `TextFields` 加 `msdf: boolean`（由四个开关算出）。「是不是 MSDF」进重排的比较字段（逆向 4.3）。
  - 排版遇到 `text:msdf:color` 时把它交给宿主的运行期不支持项（L5 的 `wpe-scene-unsupported`，看板娘提示、按图 + 键去重），那个字形不画。

## 点 4 — 编译（`compile/texts.ts`、`compile/features.ts`）

- **新增**
  - `TEXT_MATERIALS.msdf = "materials/fonts/basefont_msdf.json"`（透视场景用 `_depth`）。
  - 开了 MSDF 时，按三位变体编 `glyphs` pass，`combos` 加：
    - `OUTLINE_ENABLED`（`outline` 开、厚度 ≥ 1）；
    - `BLUR_ENABLED`（`blur` 开）；
    - `DROP_SHADOW_ENABLED`（`dropshadow` 开）。

    变体按编译时的生效值定一个，开关绑属性时登记重编译（决定 3）。厚度 / 大小的下限照逆向 6：开关开着时厚度至少 1、模糊和投影大小至少 0.01，所以开关开着就一定有对应的位。
  - 装饰参数（`outlinecolor`、`outlinethickness`、`blursize`、`dropshadowcolor`、`dropshadowopacity`、`dropshadowsize`、`dropshadowoffset`）进 `TextFields`；绑属性时登记文本就地目标 `{ kind: "text", field }`，不重排、当帧生效（逆向 4.3）。
- **修改**
  - `checkTextOptions` 不再报 `text:msdf:<键>`，`TEXT_MSDF_KEYS` 只留给登记重编译用。
  - 装饰参数与四个开关挂脚本照旧报 `text:script:<键>`（`ITextLayer` 没有这些字段，语料 0 处）。
  - 注释（`features.ts:797`）改成「MSDF 路径由渲染器写」。

## 点 5 — 渲染（`render/text.ts`、`render/uniforms.ts`、`render/graph.ts`）

- **新增**
  - `msdfRenderVars(fields, pointsize)`：照逆向 4.2 逐条 float32（`s' = (32 / 钳过的字号) · 0.24`、5.1 与 6 的钳制、让位规则、NaN 行为），返回 `g_RenderVar0..3`。`RV3.yzw` 写 0。
    > 说明：WPE 保留上一个绘制的残值；`font.frag` 不读 `RV3.yzw`，写什么都一样。
  - 字形 pass 的 uniform：MSDF 时并入上面四个值；`g_Texture0Resolution = (W, H, W, H)`（逆向 3.1，已有的按槽传值核对）。
- **修改**
  - 图集纹理按 `bpp` 定格式：`bpp 4` → `rgba8unorm`，采样器不变（线性、repeat、无 mip）。
  - 合成路径（`FUN_140257d70`）与直接上屏用同一个材质变体、同样的 `RenderVar`，不画背景四边形（现状如此）。

## 点 7 — `backgroundcolor` 的字段脚本（`compile/scripts.ts`、`compile/features.ts`、`compile/texts.ts`）

2026-11-19 并入本步（用户）。语料 `3593919489` 只差 `text:script:backgroundcolor`：对象 105 开了 `opaquebackground`，`backgroundcolor` 挂字段脚本，`update` 每帧返回 `shared.chTime_color`（Vec3）。

**现状**：
- 这个字段已经有就地目标，属性绑定和脚本 API 的 `thisLayer.backgroundcolor` 共用它：
  - LDR，或 HDR 下 `backgroundbrightness` 恒为 1 时，写背景 pass 的常量 `g_Color`（`texts.ts:251`）；
  - 其余情况走重编译。
- 只有字段脚本的分派 `targetOf`（`scripts.ts:149`）不认它，返回 `unsupported`，能力表照报 `text:script:backgroundcolor`。

- **修改**
  - `targetOf`：文本对象顶层的 `objects/<i>/backgroundcolor` 返回与属性绑定相同的目标。目标由 `texts.ts` 的同一个判断定（抽成共用函数，两处调用），就地时是背景常量 `{ kind: "constant", pass: objects/<i>/text/background, material: "backgroundcolor", uniforms: ["g_Color"], type: "vec3" }`。
  - `checkTextFeatures`：`backgroundcolor` 挂脚本时，只在要走重编译的那种情况（HDR 且 `backgroundbrightness` 不恒为 1）照报 `text:script:backgroundcolor`，其余不报。
- **实测**（2026-11-19，`p6f-bg`，抓帧 `A:\p6f\p6f-bg\`，逐帧常量 `ignore/p6/f0/bgdump.py`）：
  - **工程**：b1 直接上屏，b2 带 effect。两个对象的 `text` 和 `backgroundcolor` 各挂一个计数脚本，`backgroundcolor` 按 `n % 4` 依次返回 `Vec3(1,0,0)`、`'0 1 0'`、`0.5`、`Vec3(0,0,1)`。
  - **生效帧**：4 帧（178–181）里，文字末位依次是 9、0、1、2，`n` 依次是 179–182，对应背景依次是 (0,0,1)、(1,0,0)、(1,0,0)、(0.5,0.5,0.5)。所以返回值**当帧生效**，和文本字段脚本同帧。b2 合成 RT 的清屏色（第 178 帧事件 82 之前取像素）同样是当帧的 (0,0,1)。
  - **返回值转换**：
    - `Vec3` 原样写；
    - 数字铺满三个分量；
    - 字符串（`'0 1 0'`）**不写**，背景保持上一个值。

  落实时先核对现有字段脚本写回 vec3 常量目标的转换（`writeScript` 一带）是不是就是这三条；不一致只改这个目标的写回，别的目标的规则另立项核对，不在本步顺手改。

## 点 6 — 文档、回归与语料

- `cocs/wpe/WPE_SCENE.md`：「文本对象」一节加 MSDF（流程、v1.13 的依据、照报的彩色字形、合成路径会裁掉装饰）；能力键表去掉 `text:msdf:<键>`，加 `text:msdf:color`。
- `cocs/README.md`：WPE_SCENE 的主题加一句，适用场景加「描边 / 投影 / 模糊的文字和 WPE 不同、`text:msdf:color`」；wpefont 一条加 msdfgen。
- `versions/latest/regression.md` 一节；`changelog.md` 一行。
- 语料：`kbp corpus scan`（含 myprojects）前后比，预期解锁 3833971732、3816870245、3829268059（MSDF）与 3593919489（点 7），别的场景不变。

## 已定（2026-11-19，用户确认）

1. msdfgen 以子模块 `third/msdfgen` pin 在 `v1.13`，编进 `wpefont` 的 wasm。不用 v1.13.1，因为它改了 `symmetricalTrichotomy`，和 WPE 不同。
2. 彩色字形在 MSDF 下照报 `text:msdf:color`：那个字形不画，看板娘提示。WPE 的算法（二值化 → 两次 EDT → 双线性 → 越界加距离）可以复现，但语料 0 处，以后有语料再做。
3. 四个开关绑属性时走对象级重编译（L6），不做就地切换材质变体（语料 0 处）；装饰参数绑属性走就地写。
4. WPE 的两处怪处照 WPE，都是现有机制自然复现，不另写代码：
   - 「同字形先到的字号胜出」导致别的字号亚像素拉伸；
   - 合成路径裁掉贴边装饰。

   逆向推出的「回退顺序不同时 `faceIdx` 指错字体」，在我们这里也会同样发生，因为键的算法相同。按「语料依赖的 WPE 缺陷才复现」这一规则，它不在语料里，但要避开就得改键的语义，反而和 WPE 不同；所以保持现状，记为已知。

## 验证

**单测**（只跑相关文件）：
- `wpefont/index.test.ts`：p6f-atlas 里 6 个字体各取 1–2 个字形，格子的 SHA-1 与 WPE 图集逐字节相同（基线取自 `ignore/p6/f0/out/rd/tex/`，测试里只存哈希）。
- `text/atlas.test.ts`：RGBA 格子插入、清零四周 4 字节、空格占格、跨行回填（p6f-grow 的 94 个位置）。
- `text/layout.test.ts`：MSDF 的 `pad`（本字号 `y_ppem`）、文字框不含 `pad`、字体键与字号无关。
- `render/uniforms.test.ts`（或新文件）：`msdfRenderVars` 对 p6f-deco 11 个对象的值和抓帧常量逐位相同，包括 5.1 让位、6 的钳制、负偏移。
- `compile/texts.test.ts`：变体 COMBO、开关绑属性登记重编译、参数绑属性登记就地、不再报 `text:msdf:*`。

**变异**（按原字节还原）：
- 字体键带回字号；
- `pad` 用生成时的字号；
- `pad` 进文字框；
- `RenderVar` 去掉让位规则；
- 清零写 1 字节。

**真机**（dev 探针 + WPE 抓帧，`kbp cmp frame`）：
- p6f-atlas、p6f-deco、p6f-fx、p6f-grow 整帧和 WPE 比。差异归类到「双线性采样器在格子边上的差」之外的都要追；
- 三张语料场景的复制工程（`kbp content isolate`）。时钟文字用固定值（`--fix`）。

**检查**：wpefont 重建（`deno task build:wpefont`）、`deno task check -c kabegame` 的 vue-tsc 一半、Prettier。

**最终走查**（[FINAL_CHECK.md](../FINAL_CHECK.md)，用户 2026-11-19 提醒）：
- **样本**：4 张语料场景 3833971732、3816870245、3829268059、3593919489，各做一个复制工程（`kbp content isolate`）。
  - 只留 MSDF / 背景色脚本的文本对象及其整条父链、绑定、脚本、effect，删掉无关对象（视频、粒子等）；
  - 时钟脚本不换成固定值，走探针 `scripts` 的 `Date` 起点；
  - 3833971732 的 `text` 属性取缺省值。
- **录制与回放**：WPE 录 N 帧，带 FR 日志与帧时间；我们按同样的输入确定性回放，`canvas` 等于 WPE 测试窗口尺寸。
- **比较**：每帧整帧逐像素比（`kbp cmp frames`）。差异逐处落到 draw 和值，归为已知差异（写依据）或 bug；解释不了就不通过。
- **记录**：每张一行，写进 `WPE_SCENE.md` 的走查表。

## 执行顺序

1. 点 1（wpefont + 子模块），重建 wasm，跑点 2 的格子基线测试。
2. 点 2、3（图集与排版），单测。
3. 点 4、5（编译与渲染），单测，真机对照 p6f-*。
4. 语料扫描、复制工程走查。
5. 点 6 文档。

执行代理用 sonnet，按步骤派；子模块的添加（`git submodule add`）由我做。

## 执行记录（2026-11-19）

- **第 1–2 步**（点 1–3，sonnet 执行代理，独立工作树 `ignore/p6/f1/wt`）：`wpefont_msdf`、`wpefont.h`、RGBA 图集与 `<路径>_msdf` 字体键、`pad`、`text:msdf:color` 经 `report.unsupported` 上报。和计划不同处：
  - `wpefont_font_metrics` 由 5 个 int 增为 7 个，加 `y_ppem` 与 `FT_HAS_COLOR`，`pad` 与彩色判定要用；
  - 版本检查读 `third/msdfgen/vcpkg.json` 的 `1.13.0`；
  - 彩色字形保留字距、只是不画；
  - 「是不是 MSDF」没进重排比较字段：开关绑属性走重编译，运行中不变。
  
  验收时补修 `wpefont/index.test.ts` 没设 `KABEGAME_WPE_ROOT` 时收集阶段报错。
- **第 3 步**（点 4、5、7，同一工作树）：
  - **新增**：`text-decor` 就地目标；`msdfRenderVars`，5.1 用 exe 里的 `0x40a33334`；`backgroundColorInPlace` 由属性绑定与字段脚本共用。
  - **点 7**：现有写回规则本来就是「`Vec3` 写、数字铺满、字符串不写」，只加目标；`targetOf` 不知道 HDR，照报的判断挪到 `compileText`。
  - **附带变化**：关键帧动画也走 `targetOf`，文本 `backgroundcolor` 上的关键帧现在有就地目标（语料 0 处，未实测）。
  - **验证**：四边形顶点和 WPE 抓帧逐位相同，`layout.ts` 没改。语料 286 → 290。
- **合并**：三方合并进主工作区，祖先取 1d8eef6d；`host.ts`、`render/scene.ts` 与别的会话未提交的改动无冲突。
- **最终走查**（FINAL_CHECK）：
  - **生成工程**：4 个整帧 0 差异。
  - **语料复制工程**：4 张逐像素相同，期间查出并解释两处差异：
    1. `3816870245` 第一次录制没控光标，场景开了相机视差，整组文字偏几像素。改用 `input_start` 喂中心光标、回放 `cursors: "log"` 后为 0（录制问题，不是代码问题）。
    2. `3833971732` 的冒号：HarfBuzz 把数字间的冒号换成抬高的冒号（LXGW 文楷 gid 20066，只能经 GSUB 到达）。我们的 FreeType 没开 `FT_CONFIG_OPTION_USE_HARFBUZZ`，自动 hinter 给它的分类和 WPE 不同，hinted 框宽 1 像素。打开后图集与整帧逐字节相同，P6b 的 R8 基线不变。这是 wpefont 的修正，普通 R8 文字里经替换到达的字形同样受益（README 已改）。
- **工作文件**：`ignore/p6/f0/`（步骤 0）、`ignore/p6/f2/`（走查：复制工程、录制日志、对照脚本 `diffloc.py` / `rgba.py` / `side.py` / `findcells.mjs` / `loadorder.mjs` / `prodmsdf.mjs`）。抓帧在 `A:\p6f\`。
