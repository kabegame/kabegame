# P8 — 图像层与材质补全（总计划）

> 上级：[PLAN.md](../PLAN.md)「P8 — 图像层与材质补全」。前置：步骤 0 只读码、只实测，可以和 P4–P7 并行（2026-11-12 用户：「其他地方在做 phase4、phase5、phase6、phase7，你趁这个时间开始 P8」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件定目标、分步和验收。每步动工前在本文件里补这一步的现状锚点与各点（同 P5b 的写法），步骤 0 先读码再实测。
> 统计基于 HEAD `a261a3b9`（P5b 步骤 5）的快照 `ignore/p8/head` 上的语料扫描 `ignore/p8/out/corpus-head.json`（173 个工程，能渲染 47 张）。语料细分：`ignore/p8/scan_p8.py` → `out/scan.json`，摘要 `sum_p8.py`；覆盖数：`ana_p8.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`，进行中的键同 `ignore/p9/ana_p9.py`），结果在 `out/ana_p8.txt`；合成 RT 引用的逐条清单：`rtref.py` → `out/rtref.txt`。
> 现状行号按 HEAD `a261a3b9`。

## 总体设计思路

P8 收的是图像层上几处还没对齐 WPE 的地方。它们互不依赖，各自很小，但都落在图像层的同一条渲染路径上：四边形怎么摆、合成 RT 怎么采样、effect 能读到哪些别的图层、管线写哪些通道。所以 P8 不引入新的图层种类或模块，只在现有的图像层管线（P2a 的渲染图、P5b 改过的几何与合成 RT）上补规则。形状对象是唯一的例外：WPE 把它当图像类的子类，我们也把它接进图像层管线，而不是另写一套绘制。

五件事分五步，按解锁数和依赖排：
- **合成 RT 的采样**（`clampuvs`、`nointerpolation`）：WPE 按图层的这两个标志给合成 RT 选寻址和过滤（p2-REPORT B5 的池化 RT 名 `sc.<W>.<H>.<n|b><c|r><k>`），我们现在跟着基础纹理的 `.tex` 标志走（LWE 的做法）。先查清两个标志从哪来、缺省是什么，再改成按图层。缺省值如果和现在不同，这一步会顺带改变已经能渲染的场景，要用语料回归兜住。
- **形状对象**（`shape: "quad"`）：读码已经查到大半（[sample-gaps](../phase4/sample-gaps.md) §2.1）：边长等于正交高度的正方形、只画最后一个 effect 的 pass、强制 `DIRECTDRAW = 1` 和 additive、没有基础纹理和合成 RT。实现上是一个「没有基础 pass、只有末尾 effect pass 直接上屏」的图层，渲染图已有这种形态的上屏 pass，缺的是几何、强制改写和占位纹理。
- **对齐**（`alignment`）：WPE 在对象世界矩阵里按对齐方式加一段平移（rea-p5-modelflags：`alignment` 不为 0 时 `W` 另加 `+0x2f8..+0x300` 的偏移）。要查清的是偏移的公式、它和缩放旋转的先后、子层与 effect、视差是否跟着偏。
- **图层依赖与合成 RT 引用**（`dependencies`、`_rt_imageLayerComposite_<id>_a`）：effect 的材质槽引用别的图层的合成 RT，对象的 `dependencies` 列出被引用的图层。语料里被引用的图层多数写死 `visible: false`，当遮罩或纹理源用。要查清：被引用图层的合成 RT 装的是什么（基础 pass 还是走完 effect 链）、在哪一刻画（本帧在引用方之前，还是上一帧）、隐藏的图层是不是照画进 RT 但不上屏、尺寸和格式。我们这边要让「不上屏但要出 RT」成为图层的一种状态：资源要建、画进 RT、跳过上屏。
- **写入状态**（`alphawriting`、`alphatocoverage`）：`alphawriting` 的映射和开关读码已定（sample-gaps §2.10：`default` 等于没写，`enabled` / `disabled` 才改 alpha 写入），差 WPE 在各种目标上的缺省写掩码，我们现在按「画到场景目标不写 alpha、画进合成 RT 和 fbo 写」走。语料里的 `enabled` 全在内置 effect `cursorripple` 的两个力场 pass 上。`alphatocoverage` 只有 2 张、都是图像层材质；WPE 用户设置 `msaa: none` 时单采样下的结果要实测，WebGPU 的 alpha-to-coverage 只在多重采样目标上可用，单采样只能在着色器里模拟。

关键决策沿用前几节：
- WPE 语义以读码加实测为准；验收和 WPE 比，不和作者的预览图比。
- 能力表是唯一事实来源，没实现的照报。
- 步骤 0 一次做完：两个 REA 代理并行读，一次 WPE 会话抓完全部确定性工程，后面各步只回放和比图。

P8 另有两条：
- **图像层的 `clampuvs` 归 P8**：`ignore/p6/ana_phases.py` 把对象键 `clampuvs` 整个算进 P6（文本），但语料里 428 个非文本对象写了它（图像层 427、形状 1，15 张场景），文本只有 175 个。文本的那部分仍归 P6b，机制相同（合成 RT 的采样），谁先做谁建。
- **共享文件只加接线**：规则尽量放进纯函数（几何放 `render/layout.ts`，采样与写掩码放 `render/programs.ts` / 新的小模块），`render/graph.ts`、`render/scene.ts`、`compile/bundle.ts` 里只改调用，方便和并行会话合并。

## 范围与覆盖

语料（`ignore/p8/out/scan.json`，173 张）：
- **`alignment` 不为 `center`**：24 张场景、158 个对象，全部是图像层。取值 `bottom` 77、`left` 32、`right` 20、`top` 12、`bottomleft` 9、`topleft` 3、`topright` 3、`bottomright` 2。
- **形状对象**：18 张场景、24 个对象。全部 `shape: "quad"`、只挂一个 `effects/lightshafts`；都没写 `size`、`alpha`、`color`。其余键：`angles` 14、`visible` 14（全部绑用户属性）、`scale` 11、`parent` 7、`parallaxDepth` 4、`clampuvs` 1；`disablepropagation` 17 个、`castshadow` 8 个，值都是 false，能力表不报。
- **`clampuvs`（非文本）**：15 张场景、428 个对象（图像层 427、形状 1），值都是 true。
- **`dependencies`**：9 张场景、33 个对象，值都是对象 id 的数组。31 个在图像层上、指向图像层；2 个在模型对象上（3509243656 的天空盒、导航盘，指向图像层，属 P5c / P13 的网格，P8 只记下）。
- **合成 RT 引用**：15 张场景、52 处，全部写在 effect 实例的 `passes[].textures` 里。
  - **引用别的图层**：8 张场景、44 处（2251857160、2974757317、3243449890、3276911872、3351072238、3554161528、3643916956、3829467967），能力表报 `texture:rendertarget:_rt_imageLayerComposite_<id>_a`。都列在引用方的 `dependencies` 里。被引用的图层多数写死 `visible: false`；是普通图像层（`autosize` 模型）或 `composelayer`；38 处排在引用方之前，6 处之后。用到的 effect：`clipping_mask`（工坊）、`blend`、`blendgradient`、`refraction`、`opacity`。
  - **引用自己**：7 张场景、8 处（含 `_b` 后缀 3 处），都写在 effect 用 `bind` 占了的槽上（如 `blur` 第 3 个 pass 的槽 2 是 `previous`），是编辑器写进去的名字。我们已经让 `bind` 优先（`compilePass` 的 `planned`），能力表不报，步骤 0 核对 WPE 也忽略它。
- **`alphawriting`**：6 张场景（扫描到 7 张，3498150384 的挂在文本对象上，文本图层的 effect 等 P6b 才编译），全部是 `enabled`，全部在 `cursorripple` 的 `cursorripple_apply_force`、`cursorripple_simulate_force` 两个 pass 上（画进 512 适配的 `_rt_EightBuffer1/2`，跨帧保留）。`disabled` 0 个。
- **`nointerpolation`**：3 张场景、3 个图像层（3308867900 的「水波纹」，3823859141、3823864170 的组合层）。
- **`alphatocoverage`**：2 张场景（3611425904、3783690410），都是图像层基础材质、`genericimage4`、`depthtest` / `depthwrite` 关。

| 步骤 | 内容 | 用到的场景 | P4–P7 先做完时解锁 |
|---|---|---|---|
| 0 调研 | REA 读码、确定性工程抓帧、语料场景的真值 | — | — |
| 1 合成 RT 的采样 | `clampuvs`、`nointerpolation`（图像层、形状），合成 RT 寻址与过滤的来源 | 18 | `2981249186`、`3637191856`、`3668499717` |
| 2 形状对象 | `shape: "quad"`：几何、末尾 effect 直接上屏、`DIRECTDRAW` 与 additive 改写、占位纹理 | 18 | `3811764016`、`3812887609`、`3819646765`、`3821678218`；`3656079027`（还要步骤 1） |
| 3 对齐 | `alignment` 的 8 种取值 | 24 | `3812487163` |
| 4 图层依赖 | `dependencies`、`_rt_imageLayerComposite_<id>_a`：隐藏图层照画进 RT、绘制先后、RT 内容 | 9 | — |
| 5 写入状态 | `alphawriting`（`cursorripple`）、`alphatocoverage` | 8 | — |

口径：
- **只做 P8**（其它都不做）：能渲染 47 → 53。解锁 `3656079027`、`3668499717`、`3811764016`、`3812887609`、`3819646765`、`3821678218`，它们现在只差 P8。
- **P4–P7 先做完**：去掉 `done()` 的键（图像层上的 `clampuvs` 例外）、P7 的键，并把进行中的 P4f（`script:api:particle.*`）、P5b（`model:passthrough:children*`）、P7d（`constant:*`、`uniform:g_FrameTime`、`uniform:g_LayerModelMatrix`）算作做完，能渲染 60 张；P8 解锁 9 张，到 69 张。
- 用到 P8 任一键的 56 张场景里，P4–P7 之后只差 P8 的是上面 9 张；其余 47 张还差 P9–P13（最多的组合是 P11 单独 6 张、P9 + P10 + P11 7 张）。步骤 4、5 在 P8 内解锁不了场景，管的是正确性。
- 之后的累计（同 `ana_phases.py` 的顺序）：P9 +14 → 83，P10 +2 → 85，P11 +43 → 128，P12 +33 → 161，P13 +12 → 173。
- PLAN 的表是 165 张口径（用到 45、只差它 6、累计 72），没算图像层的 `clampuvs`；这里按 173 张重算。P9 总计划按 175 张算的「P8 做完 70 张」和这里的 69 张差在语料张数与 `clampuvs` 的归属。

**P8 不做，继续报不支持：**
- 文本对象的对齐（`horizontalalign` 等）：P6b。文本的 `clampuvs` 原写归 P6b，步骤 1 按同一规则一起放行了（见实施记录）。脚本 `layer.alignment` 原在 P6 的 API 名单里，步骤 0 查到语料 3 张都写在图像层上，挪进步骤 3（见实施记录）。
- 模型对象上的 `dependencies`：P5c / P13。
- `cursorripple` 本身已经能画（effect fbo 跨帧保留、指针、效果矩阵都有），P8 只补 `alphawriting`；它的视觉对照放在步骤 5。

## 现状锚点

**a. 形状对象不认，`shape` 和几个对象键从未知键循环报出**（`compile/features.ts:426`、`compile/features.ts:538`）
```ts
const OBJECT_KINDS = ["image", "model", "particle", "sound", "text", "light"] as const; // 现状：没有 shape，形状对象被当成分组节点
// …
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      !OBJECT_FLAGS.includes(key) &&
      !["alignment", "perspective", "instance", "model", "particle", "sound", "text", "light"].includes(key) &&
      // …
      active(value)
    )
      unsupported.add(`object:${key}`); // 现状：object:shape、object:dependencies、object:clampuvs、object:nointerpolation 都从这里报
```

**b. 对齐只放行 `center`**（`compile/features.ts:532`）
```ts
  if (object.alignment !== undefined && object.alignment !== "center") unsupported.add("object:alignment"); // 现状：其余 8 种整张退回
```

**c. 图层四边形以 `origin` 为中心**（`render/layout.ts:81`）
```ts
export function layerQuad(size: readonly number[], uv: [number, number], [left, top] = NO_INSET): QuadVertex[] {
  const hw = (size[0] ?? 0) / 2,
    hh = (size[1] ?? 0) / 2; // 现状：模型空间中心是原点，没有对齐偏移
  // …
  return [
    { position: [-hw, -hh, 0], texCoord: [left, bottom] },
```

**d. 合成 RT 的采样跟着基础纹理的 `.tex` 标志**（`render/scene.ts:961`）
```ts
    const baseTexture = this.baseTexture(runtime.layer);
    // 合成 RT 的采样跟随基础纹理（WPE 用图层的 nointerpolation / clampuvs，LWE 用基础纹理的 flags）
    const clamp = baseTexture ? baseTexture.clampUVs : true; // 现状：不看对象的 clampuvs；没有基础纹理时钳制
    const nearest = baseTexture?.noInterpolation ?? false;   // 现状：不看对象的 nointerpolation
```

**e. 别的图层的合成 RT 解析不了**（`compile/bundle.ts:1099`）
```ts
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name)) // 只认 _rt_FullFrameBuffer 和本 effect 的 fbo
          formats.push({ slot, format: FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex });
        else issues.add(`texture:rendertarget:${name}`); // 现状：_rt_imageLayerComposite_<id>_a 报这里
        continue;
      }
```

**f. 写死不可见的图层不建资源**（`render/scene.ts:622`）
```ts
export function buildableLayers(bundle: Pick<SceneBundle, "layers" | "scripts">): SceneLayer[] {
  // …
  return bundle.layers.filter(
    (layer) =>
      (layer.passes.length > 0 || (layer.particle?.passes.length ?? 0) > 0) &&
      everyAncestor(layer.object, byObject, (item) => item.visible || item.visibleBound || scripted), // 现状：被依赖的隐藏图层也不建
  );
}
```

**g. alpha 写入只看目标种类**（`compile/features.ts:712`、`render/programs.ts:306`）
```ts
function alphaWritingUsed(value: unknown): boolean {
  return active(value) && value !== "default"; // 现状：enabled / disabled 报 material:alphawriting
}
// programs.ts
        targets: [{ format, blend, writeMask: writeAlpha ? 0xf : 0x7 }], // 现状：画到场景目标不写 alpha，画进合成 RT / fbo 写
```

**h. 混合只认三种**（`compile/features.ts:46`）
```ts
  blending: ["normal", "translucent", "additive"], // 现状：alphatocoverage 报 blend:alphatocoverage
```

## 与 PLAN.md 的差异

1. **多了图像层的 `clampuvs`**：PLAN 的 P8 没有它（`ana_phases.py` 算进了 P6），按对象种类拆开后归 P8，和 `nointerpolation` 同一步。
2. **自引用的合成 RT 不算范围**：PLAN 写「引用别的图层合成 RT 的 `_rt_imageLayerComposite_*`（8 张）」，扫描另有 7 张引用自己，都在 `bind` 占了的槽上，已经中性。
3. **`alphawriting` 只剩 `cursorripple`**：PLAN 的 6 张就是它。
4. **覆盖数**：按 173 张重算，见上表。

## 和其它节的交界

- **P5b**：图像层的几何、UV 内缩、组合层与合成 RT 池已经改完（步骤 1–5 已提交，收尾在并行会话里写）。P8 依赖的就是这些，前置已满足。工作区里还有并行会话对 `render/graph.ts` 和十几个测试文件的未提交改动，P8 的实现步骤要等它们提交，或者照「在 HEAD 快照里实现再三方合并」的做法（`kbp snapshot export HEAD` → 改副本 → `snapshot diff` → `git apply --3way`）。
- **P6b**：文本对象作为图层用同一个基类（rea-p6b-layout：`clampuvs` 只影响合成 RT 采样）。步骤 1 的规则做成按对象标志取值的纯函数，P6b 直接用。
- **P7d**：`cursorripple` 的 fbo 跨帧保留与 `swap` 规则 P7d 步骤 0 已核对；步骤 5 不碰 fbo 的生命周期，只改写掩码。
- **P9 / P11**：被依赖的图层可能是视频、媒体缩略图或用户纹理（语料没有），步骤 4 不特殊处理，这类纹理照各自节的进度报。
- **P13**：模型对象的 `dependencies` 不在 P8。

## 风险

1. ~~**合成 RT 的缺省寻址可能已经不对**~~（步骤 0 已定：`clampuvs` 缺省为真、合成 RT 缺省钳制，方向和这里的假设相反；现在能渲染的场景里只有 `3832772446` 的一个图层受影响，见实施记录）：WPE 如果只按对象的 `clampuvs`（缺省 false = 重复）选合成 RT 的寻址，而我们按 `.tex` 的 ClampUVs 走，那么已经能渲染的场景里，基础纹理带 ClampUVs、effect 又采样越界的地方会和 WPE 不同。步骤 0 先定来源和缺省值，再离线扫一遍语料里「`.tex` 标志 × 对象 `clampuvs`」的组合，估出影响几张已渲染的场景；要改缺省时，步骤 1 用 `kbp regress --corpus` 和这些场景的整帧比较兜住。
2. ~~**alpha-to-coverage 在单采样下的结果**~~（步骤 0 已定：着色器先锐化、单采样是 alpha > 0.5 的硬阈值，能精确模拟）：D3D11 单采样时的覆盖由驱动决定（阈值或抖动图案）。阈值能在着色器里精确模拟；抖动图案就只能按误差包络验收。p2-REPORT 时读到用户 WPE 的设置是 `msaa: none`，步骤 0 用 `get_settings` 再确认；WPE 缺省的 `x2` 我们没有多重采样，本来就对不上，只记不补。
3. ~~**被依赖图层画在哪一帧**~~（步骤 0 已定：不改绘制顺序，在后面时读上一帧，独占 RT 跨帧保留）：被引用的图层排在引用方之后（6 处）时，WPE 如果按 `dependencies` 提前画，我们要改绘制顺序；如果读的是上一帧，就要保留上一帧的 RT。两种都影响渲染图的组织，步骤 0 先定。

## 步骤 0 — 调研（整节一次）

**读码**（两个代理并行，REA 看 `wallpaper64.exe` 2.8.42）：
- **`rea-p8-layer.md`**（对象级：几何与采样）：
  - **形状对象**（sample-gaps §2.1 的「实现前要查」）：虚表 +0x128 的用途；`FUN_1401ebf60(…, -1, 1)` 里 uniform 的取值（MVP、`g_Texture0Resolution`、`g_EffectTextureProjectionMatrix*`）；多个 effect、最后一个 effect 不可见时画哪个；`alpha`、`color`、`brightness`、`parallaxDepth`、`clampuvs`、`castshadow`、`disablepropagation`、`parent` 对形状有没有作用；透视场景里的边长。
  - **对齐**：字符串到枚举的映射（9 种）；`W` 里偏移的公式（按 `size` 还是按缩放后的尺寸、在旋转之前还是之后）；子层的世界矩阵带不带父层的对齐偏移；effect 的合成 RT、效果矩阵、视差（`parallaxDepth`）、图像层 `perspective`、命中测试是否跟着偏；脚本 `layer.alignment` 能不能写、写了什么时候生效。
  - **`clampuvs` / `nointerpolation`**：图层 `+0x304` 的这两位从哪来（对象 JSON、基础纹理的 `.tex` 标志、模型 JSON），缺省值；合成 RT 的采样器、基础纹理的采样器、effect fbo 的采样器各按什么选；形状对象（没有基础纹理）怎么取。
- **`rea-p8-render.md`**（渲染图与管线状态）：
  - **图层依赖**：`dependencies` 的读取点和作用（排序、建 RT、保活）；`_rt_imageLayerComposite_<id>_a` 对非 passthrough 图层什么时候建（p2-REPORT B5 只在 passthrough 时独占命名）、尺寸与格式、`_b` 存不存在；被引用图层的 RT 是基础 pass 的结果还是走完 effect 链的；被引用的隐藏图层画不画、画进哪里、上不上屏；引用方在被引用方之前时读到的是哪一帧；引用的 id 不存在或不是图像层时绑定什么。
  - **自引用**：实例 `textures` 写在 `bind` 占了的槽上时 WPE 用哪个。
  - **写入状态**：`alphawriting` 0 / 1 / 2 在画到场景目标、合成 RT、effect fbo 时的写掩码（含缺省时 WPE 写不写 alpha，和我们现在的「场景目标不写」对照）；`alphatocoverage`（`blending` 3）的混合状态、`AlphaToCoverageEnable`、深度写入，以及和 MSAA 设置的关系。

**实测（WPE + RenderDoc）：** 确定性工程用 `kbp gen p8`（实验定义 `ignore/p8/defs/p8.py`，数据目录 `ignore/p8`），抓帧放 `A:\p8\<用途>\`：
- **`p8-clamp`**：带一个让 UV 越界的 effect（平移或缩放采样坐标）的图层，`clampuvs` × `nointerpolation` × 基础纹理带不带 ClampUVs / NoInterpolation 标志，另加一个没有 effect 的对照。读 RenderDoc 的采样器状态和像素。
- **`p8-shape`**：照编辑器的做法把 `lightshafts` 的材质、着色器打包进工程。单个形状；两个 effect；最后一个 effect `visible: false`；带 `alpha` / `color`、`angles`、`scale`、`parent`、`parallaxDepth`；读四角、混合状态、COMBO、uniform。
- **`p8-align`**：9 种对齐 × 有无 effect，再加旋转与非均匀缩放、对齐的父层下挂子层、`cameraparallax` 打开时的 `parallaxDepth`；读四角（`vs_out`）。
- **`p8-dep`**：被引用图层 A × 引用方 B：A 可见 / 写死隐藏 / 绑属性隐藏；A 有无 effect；A 是普通图层 / `composelayer`；A 在 B 之前 / 之后；A 由脚本每帧移动（看 B 读到的是不是同一帧）；引用不存在的 id；`_b` 后缀。读 B 那次绘制绑定的纹理与像素。
- **`p8-alpha`**：两个 pass 的 effect 画进 fbo，`alphawriting` 缺省 / `enabled` / `disabled`，读 fbo 的 alpha；同样三种写在画到场景目标的图层材质上，读后备缓冲的 alpha。
- **`p8-a2c`**：alpha 从 0 到 1 的渐变图层，`blending: alphatocoverage`，在当前设置（`msaa: none`）下读像素与混合状态；`capture_sweep` 另跑一组 `msaa: x2`（只记录，sweep 跑完会改回）。
- **语料真值**：只差 P8 的 6 张（`3656079027`、`3668499717`、`3811764016`、`3812887609`、`3819646765`、`3821678218`）各抓一组 `--present`，作为步骤 1–3 的对照；再挑两张带跨图层引用的（如 `3829467967`、`2974757317`）看被依赖图层的实际绘制顺序。

**离线扫描**：语料里图像层基础纹理的 `.tex` 标志与对象 `clampuvs` / `nointerpolation` 的组合分布，按已渲染 / 未渲染分开，用来估风险 1。Kabegame 这边（dev app、kabegame-dev MCP）步骤 0 不用跑，各步验收时再用。

**产出：** `rea-p8-layer.md`、`rea-p8-render.md`（读码），`p8-REPORT.md`（实测），本文件的步骤 0 实施记录（对各步的影响），`ignore/p8/gen_p8.py`（实际没走 `kbp gen` 的实验定义，见实施记录）。

## 步骤 1 — 合成 RT 的采样

### 思路

步骤 0 定下的规则（p8-REPORT「合成 RT 与基础纹理的采样」，rea-p8-layer §3）：图层 `+0x304` 的 bit14 / bit15 只由对象 JSON（和脚本）写，构造时缺省 `clampuvs` 真、`nointerpolation` 假；合成 RT（池化的和被依赖图层独占的同一套）的寻址只看 `clampuvs`，过滤在「对象 `nointerpolation` 或基础纹理 `.tex` 的 NoInterpolation」时最近邻。基础纹理的采样器只看 `.tex` 标志，不动。

所以这一步只是把图层上的两个标志读进 `SceneLayer`，合成 RT 的采样改成按它们选，能力表放行这两个键的 JSON 布尔值。规则写成 `render/graph.ts` 里和 `compositeSize` 并排的纯函数，`ensureComposites` 只调它。文本对象走同一个 `ensureComposites`（P6b 1d），读码说文本同一条规则（rea-p6b-layout、rea-p8-layer §3），一起生效。

绑用户属性或挂脚本的值（语料 0 个）照报：WPE 改了这两位不触发重建（rea-p8-layer §3，推断），和就地写的语义对不上，没有实测，不做。

### 现状锚点（HEAD `7d430828`）

**a. 合成 RT 的采样跟着基础纹理**（`render/scene.ts:1037`）
```ts
  private ensureComposites(runtime: LayerRuntime, plan: LayerPlan): void {
    if (!plan.composite) return;
    const { width, height, count } = plan.composite;
    const baseTexture = this.baseTexture(runtime.layer);
    // 合成 RT 的采样跟随基础纹理（WPE 用图层的 nointerpolation / clampuvs，LWE 用基础纹理的 flags）
    const clamp = baseTexture ? baseTexture.clampUVs : true;   // 现状：纹理没有 ClampUVs 时 Wrap（WPE 恒为 Clamp）
    const nearest = baseTexture?.noInterpolation ?? false;     // 现状：不看对象的 nointerpolation
    // …
    const key = `${width}x${height}|${clamp}|${nearest}${depth ? `|k${depth}` : ""}`;
```

**b. 两个键从未知键循环报出**（`compile/features.ts:656`）
```ts
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      !OBJECT_FLAGS.includes(key) &&
      !["alignment", "perspective", "instance", "model", "particle", "sound", "text", "light"].includes(key) &&
      // …
      active(value)
    )
      unsupported.add(`object:${key}`); // 现状：object:clampuvs（15 张，值都是 true）、object:nointerpolation（3 张）
```

**c. 图层没有这两个字段**（`compile/bundle.ts:1420`，建 `SceneLayer` 的字面量）
```ts
    const layer: SceneLayer = {
      // …
      perspective: false,
      passthroughModel: false,
      // …
      copyBackground: true,   // 现状：对象级的开关只有 copyBackground 等，没有 clampUVs / noInterpolation
```

**d. 合成 RT 尺寸的纯函数在 `render/graph.ts:200`**（`compositeSize`），采样规则放它旁边。

### 点 1 — 图层字段（`compile/bundle.ts`）
- **新增**
  - `SceneLayer.clampUVs: boolean`：对象 `clampuvs` 不为 JSON `false` 时为真（缺省真）。
  - `SceneLayer.noInterpolation: boolean`：对象 `nointerpolation` 为 JSON `true` 时为真（缺省假）。
    > 说明：在建 `SceneLayer` 的字面量里按对象 JSON 直接取，全部对象种类都填（粒子、分组节点用不到，无害）。注释引 p8-REPORT 与 rea-p8-layer §3。
```ts
      copyBackground: true,
      // 合成 RT 的采样（P8 步骤 1，p8-REPORT、rea-p8-layer §3）：图层 +0x304 的两位只由对象 JSON 写，构造时缺省 clampuvs 真
      clampUVs: object.clampuvs !== false,           // 新增
      noInterpolation: object.nointerpolation === true, // 新增
```

### 点 2 — 能力表（`compile/features.ts`）
- **修改**
  - `checkObjectFeatures`：`clampuvs`、`nointerpolation` 取 JSON 布尔值时放行；其余（绑属性、挂脚本、非布尔）报 `object:clampuvs` / `object:nointerpolation`。两个键加进未知键循环的跳过名单，`SUPPORTED_OBJECT` 上方的注释补一条。
```ts
  // 合成 RT 的采样（P8 步骤 1）：JSON 布尔值已实现；绑属性、挂脚本时 WPE 不重建 RT（rea-p8-layer §3，推断），没有实测，照报
  for (const key of ["clampuvs", "nointerpolation"])
    if (object[key] !== undefined && typeof object[key] !== "boolean") unsupported.add(`object:${key}`); // 新增
```

### 点 3 — 采样规则（`render/graph.ts`、`render/scene.ts`）
- **新增**
  - `render/graph.ts` 的 `compositeSampling(layer, texture)` → `{ clamp, nearest }`：`clamp = layer.clampUVs`，`nearest = layer.noInterpolation || !!texture?.noInterpolation`。
```ts
/**
 * 合成 RT 的采样（P8 步骤 1，p8-REPORT「合成 RT 与基础纹理的采样」、rea-p8-layer §3）：寻址只看对象的 clampuvs（缺省钳制），
 * 过滤在对象 nointerpolation 或基础纹理 NoInterpolation 时最近邻。池化与被依赖图层的独占 RT 同一套。
 */
export function compositeSampling(
  layer: Pick<SceneLayer, "clampUVs" | "noInterpolation">,
  texture: Pick<SceneTexture, "noInterpolation"> | undefined,
): { clamp: boolean; nearest: boolean } {
  return { clamp: layer.clampUVs, nearest: layer.noInterpolation || !!texture?.noInterpolation };
}
```
- **修改**
  - `ensureComposites`：`clamp` / `nearest` 改由 `compositeSampling(runtime.layer, baseTexture)` 给，池键格式不变，注释改成新规则。
```ts
    const { clamp, nearest } = compositeSampling(runtime.layer, this.baseTexture(runtime.layer)); // 修改
```

### 点 4 — 单测
- **新增** `compile/p8.test.ts`：两个键的布尔值放行、绑属性照报；`SceneLayer` 两个字段的缺省与 JSON `false` / `true`。
- **新增** `render/p8.test.ts`：`compositeSampling` 的 p8-REPORT 表（纹理标志 0 / 3 × 对象不写 / `true` / `false` × 两个键，组合层没有纹理）。
- **修改** 现有测试里手写的 `SceneLayer` 字面量补两个字段（tsc 会指出）。

### 实施方式

工作区里 P5c、P6b、P9a 的会话正在改 `compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`。照「在 HEAD 快照里实现再三方合并」：实现代理只改 `ignore/p8/s1/ov/src`（`kbp snapshot export HEAD` 出的副本，基线是 `ignore/p8/s1/head`），我验收后 `kbp snapshot diff` 出补丁，`git apply --3way` 进工作区。

### 验收
- 快照里 tsc 0 error，vitest 全过。
- `kbp regress --src ignore/p8/s1/head/src --src ignore/p8/s1/ov/src --corpus`：回放案例全部相同；语料只去掉 `object:clampuvs`（15 张）与 `object:nointerpolation`（3 张），干净场景 47 → 48（`3668499717`）。
- 画面：`p8-clamp`、`p8-clamp2` 用 kabegame-dev 的 `render_scene` 渲染，和 WPE 抓帧（`kbp rdc frame --present`）逐像素比（`--kbp-layers` 屏蔽 FR / CLK）；`3668499717` 和受影响的 `3832772446` 各比一帧。
- 变异检查：缺省改成 `clampuvs === true`、`nearest` 去掉对象或纹理的一边，单测要能检出。

## 步骤 2 — 形状对象

### 思路

形状对象在 WPE 里是图像类的子类，我们照样把它当成一种图层，接进现有的图像层管线，不另写绘制。它和普通图像层只差三处：没有基础 pass 和合成 RT；几何是 effect 常量围成的四边形；只画最后一个 effect 的那一个绘制 pass，直接画到当前目标。所以 `SceneLayer` 多一个可选的 `shape` 字段（四个点），`passes` 留空；渲染图对形状层只排一步：最后一个 effect 的唯一绘制 pass，角色是 `final`（画到场景、写 RGB，和上屏同一套管线规则），几何是新的 `shape`，混合强制 additive，不看 effect 的开关。渲染器只在两处认它：建顶点时按四个点出四边形，算矩阵时效果矩阵取 WPE 给形状的那组值。

规则全部来自步骤 0（p8-REPORT 结论 4、5，rea-p8-layer §1，实测与读码一致）：
- **认法**：`shape` 是字符串（不比较取值），且没有图像、模型、粒子、声音、文本、灯的内容。同时带别的内容的对象 WPE 按哪个类建没查，照报 `object:shape`（语料 0 个）。
- **几何**：第一个 effect 第一个绘制 pass 的材质常量 `point0`–`point3`（实例覆盖、注解缺省都算，按材质名从程序反射找），顶点 `(Sx·p.x − Sx/2, Sy·(1 − p.y) − Sy/2, 0)`、uv = p，三角形 (p0, p2, p1)、(p0, p3, p2)。`Sx×Sy` 是对象 `size`，缺省正交高 × 正交高（不是宽 × 高）。四个点找不全时退回以原点为中心的 `size` 方块、uv 0–1。点只在编译期取一次：WPE 改常量不重建四边形（读码推断），我们的常量就地写也不碰顶点，语义相同。
- **绘制**：最后一个 effect，不看它的 `visible`（写死不可见、绑属性都照画），前面的 effect 永远不画；每个 effect pass 的 `DIRECTDRAW` 强制为 1；混合 SrcAlpha / One；槽 0 不填（WPE 没有当前合成 RT，`bind` 里的 `previous` 跳过）；矩阵 MVP = 场景视图投影 · 视差 · W（含父链，形状没有对齐偏移），效果矩阵是单位阵、纹理投影 `diag(Sx/2, Sy/2, 1, 1)`。
- **对象键**：`visible`（含父链、绑属性）、变换、`parent`、`parallaxDepth`、`size` 起作用，走图层已有的路径；`alpha`、`color`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation`、`castshadow`、`disablepropagation`、`alignment` 对形状无作用。

effect 的开关对形状中性，所以形状层的 effect 编译时一律当开着，不登记 `visible` 的绑定，也不预备变体计划；脚本写 effect 的 `visible` 照样落进状态，渲染图不看它，签名不变、不重建。effect 的不支持项一律算进整场（不分画不画）：语料 24 个形状都只有一个 `lightshafts`，保守不丢东西。

照报（语料都是 0 个）：
- `shape:effects`：没有 effect（WPE 取 `effects.back()`，空列表是未定义行为）；
- `shape:effect-passes`：最后一个 effect 不是恰好一个绘制步骤（多 pass、`copy` / `swap`、fbo）：非末 pass 在 WPE 里画一个没建的四边形，读码说会解引用空指针；
- `shape:uniform:<名字>`：画的程序读 `g_Color4`、`g_Alpha`、`g_Color`（WPE 形状路径不写，值是上一次绘制留下的）；
- `shape:texture0`：画的程序用槽 0、材质又没给静态纹理（WPE 槽 0 没人赋值）；
- `model:passthrough:children:shape`：形状挂在组（带子层的组合层）下，WPE 由组代画进它的合成 RT，没实测；
- `object:perspective`：形状上的 `perspective: true` 照旧报（只放行图像层与模型）；透视场景整张另报 `camera:perspective`。

另记：形状不参加光标命中测试（WPE 只认类型 1、4、5），P6 做命中测试时要排除它。

### 现状锚点（HEAD `ff4ad0e3`）

**a. 形状对象认不出，`shape` 从未知键循环报出**（`compile/features.ts:461`、`:676`、`:684`）
```ts
const OBJECT_KINDS = ["image", "model", "particle", "sound", "text", "light"] as const; // 现状：没有 shape，形状对象是分组节点
// checkObjectFeatures
  if (object.alignment !== undefined && object.alignment !== "center" && !text) unsupported.add("object:alignment"); // 现状：只放过文本
  for (const [key, value] of Object.entries(object))
    if (!SUPPORTED_OBJECT.has(key) && /* … */ active(value))
      unsupported.add(`object:${key}`); // 现状：object:shape（18 张）从这里报
```

**b. 没有 image 的对象不编 effect**（`compile/bundle.ts:1605`）
```ts
    const textObject = isTextObject(object);
    if (!textObject) {
      // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
      if (!object.image) continue;   // 现状：形状对象到这里为止
      if (!(await compileImageModel(index, object, layer))) continue;
    }
```

**c. effect 写死不可见整步跳过，开关登记成绑定**（`compile/bundle.ts:1617`）
```ts
      const enabled =
        bindings.bind(instance.visible, properties, { kind: "effect", object: index, effect: source }) !== false;
      // 写死关闭、没有绑定的整步跳过（B11），也不检查它的能力
      if (!enabled && !visibleBound) continue;   // 现状：形状的最后一个 effect 写死不可见时 WPE 照画
```

**d. 渲染图要基础 pass**（`render/graph.ts:372`）
```ts
  const base = sceneText ? sceneText.glyphPass : layer.passes[0];
  if (!base) return { composite: null, steps, reasons };   // 现状：没有基础 pass 的图层什么都不画
```

**e. 只给有 pass 的图层建资源**（`render/scene.ts:676`）
```ts
      (layer.passes.length > 0 || (layer.particle?.passes.length ?? 0) > 0 || !!layer.text) &&   // 现状：没有 shape
```

**f. 几何只有图层四边形和 NDC 四边形**（`render/scene.ts:1669`，`render/graph.ts:87`）
```ts
      const vertices =
        step.geometry === "fullscreen"
          ? layerQuad([2, 2], step.uv, step.inset)
          : layerQuad(this.layerSize(layer, state), step.uv, step.inset);   // 现状：三角形带，左下、右下、左上、右上
export type Geometry = "layer" | "fill" | "fullscreen";
```

**g. 上屏的效果矩阵按图层算**（`render/uniforms.ts:324`）
```ts
    case "final":
    case "passthrough":
      return {
        modelViewProjection: layerMvp,
        model,
        viewProjection,
        effectModel: model,                                // 现状：形状要单位阵
        effectModelViewProjection: layerMvp,               // 现状：形状要单位阵
        effectTextureProjection: multiply(layerMvp, half), // 现状：形状要 diag(Sx/2, Sy/2, 1, 1)
        layerModel: step.role === "final" ? model : undefined, // 现状：形状要单位阵
      };
```

**h. 组里子层的检查没有形状**（`compile/features.ts:905`）
```ts
  if (layer.model) keys.push("model:passthrough:children:model");   // 现状：形状挂在组下不报
  return keys;
```

### 点 1 — 认出形状与能力表（`compile/features.ts`）
- **新增**
  - `isShapeObject(object)`：`typeof object.shape === "string"`，且 `objectKind` 为 undefined、不是声音或文本对象。`compileScene` 与能力表共用。
```ts
/**
 * 形状对象（P8 步骤 2，rea-p8-layer 1.1）：WPE 的工厂只看 `shape` 是不是字符串、不比较取值。同时带图像、模型、粒子、声音、文本、灯的对象
 * WPE 按哪个类建没查（语料 0 个），不算形状，`shape` 照未知键报。`compileScene` 与能力表共用。
 */
export function isShapeObject(object: SceneObject): boolean {
  return typeof object.shape === "string" && objectKind(object) === undefined && !isSoundObject(object) && !isTextObject(object);
}
```
- **修改**
  - `checkObjectFeatures`：形状对象的 `shape` 键不进未知键循环；`alignment` 对形状中性（条件加 `&& !shape`）。`perspective` 不动（形状上为真照报）。
  - `groupChildIssues`：`layer.shape` 非空时加 `model:passthrough:children:shape`（`Pick` 加 `shape`）。

### 点 2 — 编译（`compile/bundle.ts`）
- **新增**
  - `SceneShape` 与 `SceneLayer.shape?: SceneShape | null`（可选同 `text`、`model`，不动各处手写的测试图层）：
```ts
/** 形状对象（P8 步骤 2，rea-p8-layer §1，p8-REPORT 结论 4、5）：图层的 `passes` 为空，没有合成 RT，渲染图只画最后一个 effect（`planShapeLayer`）。 */
export interface SceneShape {
  /**
   * 第一个 effect 第一个绘制 pass 的材质常量 `point0`–`point3`（实例覆盖、注解缺省都算，按材质名从程序反射找，`size` 方块里的
   * 归一化坐标，y 向下）；四个找不全时 null，几何退回以原点为中心的 `size` 方块。编译期取一次（WPE 改常量不重建四边形）。
   */
  points: [number, number][] | null;
}
```
  - `compileShape(index, object, layer)`（`compileScene` 里的内部函数，和 `compileImageModel` 并排）：
    - `size`：JSON 写了就按它（数字铺满两维，两个分量缺哪个取正交高），否则 `[正交高, 正交高]`（`bundle.general.height`）。
    - 每个 effect 都编，不看 `visible`：`enabled: true`、`visibleBound: false`，不调 `bindings.bind` 登记开关，不支持项进整场 `unsupported`；编译时 `combos` 在实例覆盖之后再写 `DIRECTDRAW: 1`（`compileEffect` 加一个可选参数）。
    - 编完：没有 effect 报 `shape:effects`；最后一个 effect 的步骤不是恰好一个 `draw`、或有 fbo，报 `shape:effect-passes`；画的程序读 `g_Color4` / `g_Alpha` / `g_Color`（`unused` 为假）报 `shape:uniform:<名字>`；程序用槽 0 而 pass 没有静态纹理、也不在 `runtime` 里，报 `shape:texture0`。
    - `layer.shape = { points }`：取 `layer.effects[0]` 的第一个 `draw` 步骤的 pass，在 `bundle.programs[pass.program].result.uniforms` 里按 `meta.material` 找 `point0`–`point3`，值取 `pass.uniforms[名字]` 的前两项。
  - `colorBlendMode` 不编 passthrough（对形状中性）。
- **修改**
  - 对象循环在文本判断之前分出形状：
```ts
    // 形状对象（P8 步骤 2）：没有模型和基础 pass，effect 不看开关全编，渲染图只画最后一个（`planShapeLayer`）
    if (isShapeObject(object)) {
      await compileShape(index, object, layer);
      continue;
    }
    const textObject = isTextObject(object);
```

### 点 3 — 几何（`render/layout.ts`）
- **新增**
```ts
/**
 * 形状对象的四边形（P8 步骤 2，rea-p8-layer 1.3，p8-REPORT 结论 4）：点 p 是 `size` 方块里的归一化坐标（x 向右、y 向下），顶点
 * `(Sx·p.x − Sx/2, Sy·(1 − p.y) − Sy/2, 0)`、uv = p，float32 逐步算（`Sx`、`Sy` 不取整）。WPE 是 4 顶点 6 索引 (0, 2, 1)、(0, 3, 2)；
 * 这里排成三角形带 [p1, p0, p2, p3]：带的两个三角形 (p1, p0, p2)、(p2, p0, p3) 与 WPE 的两个逐个相同、绕向相同、先后相同。
 * `points` 为 null 时退回以原点为中心的方块、uv 0–1（`layerQuad(size, [1, 1])`）。
 */
export function shapeQuad(size: readonly number[], points: readonly (readonly [number, number])[] | null): QuadVertex[];
```

### 点 4 — 渲染图（`render/graph.ts`）
- **新增**
  - `Geometry` 加 `"shape"`（注释：形状四边形，`shapeQuad`，场景视图投影 × 图层世界矩阵）。
  - `planShapeLayer(layer)`：
```ts
/**
 * 形状层（P8 步骤 2，rea-p8-layer 1.4、1.5、1.8，p8-REPORT 结论 4、5）：没有基础 pass、没有合成 RT，只画最后一个 effect 的唯一绘制 pass，
 * 不看 effect 的开关（前面的 effect 永远不画）。角色 `final`（画到场景、写 RGB；在组里由组改写目标），几何 `shape`，混合强制 additive。
 * 槽 0 不填（WPE 没有当前合成 RT），bind 里不是本 effect fbo 的名字（如 previous）跳过、保留材质的纹理；材质要快照时先拍（规则 3）。
 * 结构不对（没有 effect、最后一个不是恰好一个绘制步骤）时编译期已报 `shape:*`，这里另给 `render:shape` 兜底、不画。
 */
export function planShapeLayer(layer: Pick<SceneLayer, "effects">): LayerPlan;
```
- **修改**
  - `planLayer`：粒子判断之后 `if (layer.shape) return planShapeLayer(layer);`。
  - `variantPlans`：`if (layer.shape) return [];`（effect 开关对形状中性）。

### 点 5 — 渲染器与矩阵（`render/scene.ts`、`render/uniforms.ts`）
- **修改**
  - `buildableLayers`：条件加 `|| !!layer.shape`。
  - 建 draw 的几何：`step.geometry === "shape"` 时 `shapeQuad(this.layerSize(layer, state), layer.shape?.points ?? null)`。
  - `drawMatrices` 的 `step` 改收 `Pick<DrawStep, "role"> & { geometry?: Geometry }`（`DrawUniformInput.step` 同步），形状单列：
```ts
  // 形状（P8 步骤 2，rea-p8-layer 1.5）：MVP、g_ModelMatrix 同上屏；效果矩阵 WPE 取图层 +0x344 / +0x384（形状不写，是构造时的单位阵），
  // 纹理投影是它的前两行乘 Sx/2、Sy/2；g_LayerModelMatrix 同样是单位阵
  if (step.geometry === "shape")
    return {
      modelViewProjection: layerMvp,
      model,
      viewProjection,
      effectModel: identity(),
      effectModelViewProjection: identity(),
      effectTextureProjection: half,
      layerModel: identity(),
    };
```
  - 管线不改：`final` 画到场景时写 RGB、topology 是三角形带，正好是形状要的。

### 点 6 — 单测
- **修改** `compile/p8.test.ts`（加 `describe`）：
  - 认法：形状对象不再报 `object:shape`；`shape` 加 `image` 照报；`alignment`、`colorBlendMode`、`clampuvs`、`alpha` / `color` / `brightness` 中性；`perspective: true` 照报。
  - `size`：缺省 `[正交高, 正交高]`（宽高不等的场景）、`"300 200"`、数字铺满。
  - effect：写死不可见、绑属性的都编进来、`enabled` 为真、没有登记 effect 开关的绑定；`DIRECTDRAW` 实例写 0 也编成 1（看翻译请求或程序的 combo）。
  - 点：两个 effect 时取第一个的点；点不全时 null。
  - 照报的五个键各一例；`colorBlendMode` 非 0 不编 passthrough。
- **修改** `render/p8.test.ts`（加 `describe`）：
  - `shapeQuad`：`p8-shape` S1（1080×1080，p0 `0.24560 0.09457` → (−274.75, 437.86) 一带，四个点逐个对 RenderDoc 的 `vs_in`）、S10（300×200）；带的两个三角形和 WPE 索引 (0, 2, 1)、(0, 3, 2) 逐个相同；null 时等于 `layerQuad(size, [1, 1])`。
  - `planShapeLayer`：一步 `final`、additive、场景目标、几何 `shape`、没有合成 RT；最后一个 effect 关着也画、第一个不画；要快照时先拍；结构不对时 `render:shape`；`variantPlans` 为空。
  - `drawMatrices` 的形状分支：MVP = VP · W，三个效果矩阵与 `g_LayerModelMatrix` 是单位阵，纹理投影 `diag(Sx/2, Sy/2, 1, 1)`。
  - `buildableLayers` 收形状层，写死不可见的祖先下面不收。

### 实施方式

同步骤 1：工作区的 `apps/wpe-scene` 现在干净，但 P4f、P5c、P9 等会话随时会改共享文件。实现代理只改 `ignore/p8/s2/ov/src`（`kbp snapshot export HEAD` 出的副本，基线 `ignore/p8/s2/head`），我验收后逐文件三方合并进工作区，不碰暂存区。

### 验收
- 快照里 tsc 0 error，vitest 全过（基线就失败的照记）。
- `kbp regress --src ignore/p8/s2/head/src --src ignore/p8/s2/ov/src --corpus`：回放案例全部相同；语料去掉 `object:shape`（18 张），新出现的键逐张核对；干净场景 48 → 53（`3656079027`、`3811764016`、`3812887609`、`3819646765`、`3821678218`）。
- 四角：`p8-shape`、`p8-shape2` 每个形状的四个顶点（我们的 `shapeQuad` × MVP）和 RenderDoc 的 `vs_out` 比，限值 0.01 像素。
- 画面：`p8-shape`、`p8-shape2`、`p8-par` 用 `render_scene` 按日志回放，和 WPE 抓帧逐像素比（屏蔽 FR / CLK）；解锁的 5 张各解包加日志、抓一帧、按日志回放比。
- 变异检查：带的顶点顺序、`1 − p.y` 写成 `p.y`、缺省边长取宽、几何取最后一个 effect、画第一个 effect、不强制 additive、看 effect 开关、不强制 `DIRECTDRAW`，单测或比图要能检出。

## 步骤 1–5 的验收

- **每步**：确定性工程和 WPE 逐像素比（`kbp cmp frame --meta`，图层带 `bbox`）；几何类（形状、对齐）另比四角，限值 0.01 像素。
- **语料**：`kbp regress --corpus` 只去掉本步的键；解锁的场景各比一帧 `--present` 真值（`content unpack --instrument` 的回放，按 WPE 实际帧时间）。
- **变异检查**：每步的关键规则（对齐偏移的方向、形状的强制 additive、合成 RT 的寻址来源、被依赖图层的跳过上屏、写掩码）各改坏一处，单测或比图要能检出。
- **单测**：规则都是纯函数，单测直接对读码与实测的数字。

## 实施记录

### 步骤 0 — 调研（2026-11-12）

读码：[rea-p8-layer.md](rea-p8-layer.md)（形状、对齐、采样）、[rea-p8-render.md](rea-p8-render.md)（依赖、自引用、写入状态），两个代理并行。实测：[p8-REPORT.md](p8-REPORT.md)，11 个确定性工程（`ignore/p8/gen_p8.py`，没有用 `kbp gen` 的实验定义，照 P5b 的 `gen_b.py` 自写 `.tex` 与 effect）加只差 P8 的 6 张语料场景，WPE 设置 `fps` 20、`msaa` none，没改。读码与实测覆盖到的部分全部吻合，推翻了 sample-gaps §2.1（形状不是正方形）、rea-p4a（图像层读 `alignment`）、本计划风险 1 的前提（`clampuvs` 缺省为真）。

对各步的影响（细节见报告「对各步的影响」）：
- **步骤 1**：合成 RT 寻址 = 对象 `clampuvs !== false` 时钳制，过滤 = 对象 `nointerpolation: true` 或纹理 NoInterpolation 时最近邻；`clampuvs: true` 中性。改的是现状锚点 d 的两行。基础纹理的采样器不动。`3832772446` 的一个图层会从重复变成钳制，要回归。
- **步骤 2**：形状的几何是第一个 effect 的四个点围成的四边形（不是正方形），画最后一个 effect、不看 effect 的 `visible`，吃视差。比总计划多出「取点」「effect 可见性中性」两条；多 pass 的 effect 与透视场景照报。
- **步骤 3**：多两项——脚本 `layer.alignment`（读写字符串，不是字符串按 `center`，语料 3 张，从 P6 挪来）与四边形边长按 `trunc(size)`（语料 1 张）。绑属性的 `alignment` 按 `center`。
- **步骤 4**：被依赖的图层要从 `buildableLayers` 的「写死不可见不建资源」里例外；独占 RT 跨帧保留；占位纹理是 6×6 黄黑棋盘格。模型对象写的 `dependencies` 也会给图像层置位，一起处理。
- **步骤 5**：`alphawriting` 只在场景目标 `enabled`、合成路径 `disabled` 时和现在不同，上屏的最后一个 effect pass 不受它影响；`alphatocoverage` 着色器加 `ALPHATOCOVERAGE=1`、画到场景目标时丢弃锐化后 alpha ≤ 0.5 的片元。

工具：`ignore/p8/rdc_dump_p8.py`（qrenderdoc 无界面导出每次绘制，含直接读 D3D11 输出合并状态的 `AlphaToCoverage`）、`show.py`、`ana_align.py`、`check_align.py`；语料 `scan_p8.py`、`sum_p8.py`、`ana_p8.py`（脚本 `layer.alignment` 已改算 P8，覆盖数不变）、`rtref.py`、`rtgap.py`、`scan_texflags.py`。

失误：`p8-alpha` 里自写的 fbo pass 顶点乘了 MVP（中间 pass 应该直接用 NDC 四边形），fbo 里没有像素；写掩码从管线状态读，结论不受影响。`p8-shape` 的 S5 两个 effect 是同一个变体、同一组点，分辨不出画的是哪一个，初稿据此推错，`p8-shape2` 补测更正。

### 步骤 1 — 合成 RT 的采样（2026-11-13）

按提纲做，两处偏离：`clampuvs: null` 当没写（rea-p8-layer §3.1：`null` 不动构造缺省；语料 0 个）；文本对象同一规则一起放行（总计划「P8 不做」原写文本归 P6b，读码说同一基类、同一个 `ensureComposites`，分开反而要加种类判断）。

- **实现**：代理在 HEAD `7d430828` 的快照副本 `ignore/p8/s1/ov` 里做；我验收后逐文件 `git merge-file` 三方合并到新 HEAD `461310c4`（期间 P5c、P9a、P6b、P4e 收尾提交了 4 个），18 个文件全部干净合并，没有碰暂存区。新 HEAD 里 P9a 的 `render/p9a.test.ts` 也有手写的 `SceneLayer`，补了两个字段。
- **快照验收**：tsc 0 error；vitest 2228 个用例 1 个失败（`pipeline.test.ts` 的请求次数上限，`3830255100` 219 次，基线快照同样失败）。
- **回归**（`kbp regress --corpus`，`ignore/p8/s1/regress`）：回放案例两边全部相同、全部通过；语料只去掉 `object:clampuvs` 15 张、`object:nointerpolation` 3 张，没有新增的键，干净 47 → 48（`3668499717`）。
- **变异**（`ignore/p8/s1/mutations.py`，快照模式）：缺省改成只认 true、过滤去掉纹理一边、去掉对象一边、寻址退回跟纹理、能力表仍报布尔值，5 处全部被新单测检出，按原字节还原。
- **工作区验收**：tsc 0 error；vitest 2321 个用例 2 个失败，`pipeline.test.ts` 同上，`p5c.test.ts` 的 M3（P5c 会话的真翻译器用例）在干净的新 HEAD 快照上同样失败，和本步无关；Prettier 通过。
- **画面**：dev 宿主按 `--mode development` 重建后渲染。`p8-clamp`、`p8-clamp2` 和 WPE 抓帧逐像素 0 差异（屏蔽 FR / CLK；改前 `p8-clamp` 差 106776 个像素，全在纹理不带 ClampUVs 的那 4 个图层）。`3668499717`（新解锁）和 `3832772446`（受影响的那个图层从重复变钳制）各解包加日志、抓一帧、按日志回放比：差 > 32 的像素分别占 0.11%、0.21%，都在随机粒子和缩放的轮廓上；`3832772446` 的主图层带 `shake` 位移，画面四边平均差 0.2–0.95。

### 步骤 2 — 形状对象（2026-11-13）

按提纲做，三处偏离：
- **形状 effect 的槽位预留**：不只写 `DIRECTDRAW`，`compileEffect` 的 `options.shape` 还改了预留，不再给槽 0 预留（只给指向本 effect fbo 的 bind 预留），其余槽照材质的纹理与注解缺省编。不这样的话 `compilePass` 跳过材质的槽 0，点 4 说的「保留材质的纹理」做不到，`shape:texture0` 也判断不了。
- **`shape:texture0` 看 WGSL**：翻译器的纹理反射不带 `unused`，`DIRECTDRAW = 1` 时 `g_Texture0` 照样列出、只剩声明（真翻译器实测），只看反射语料 24 个形状全会报。改成 `textureSlotRead`：按反射的绑定号在输出的 WGSL 里找到变量名，某个阶段里出现不止声明那一处才算读了；没有 WGSL 文本时按读了算。正经做法是翻译器给纹理反射加 `unused`，要改 `src-tauri/wpesl2wgsl`，留作以后。
- **`shape:uniform:*` 只算引擎 uniform**：带 `meta.material` 的是材质常量，WPE 照材质写，不报。

另：形状上的 `castshadow`、`disablepropagation` 为真时照旧报（别处语义没查清，语料都是 false）；编译中途停下（`settled()`）时不跑 `shapeIssues`。

- **实现**：代理在 HEAD `ff4ad0e3` 的快照副本 `ignore/p8/s2/ov` 里做，8 个文件（`compile/bundle.ts`、`compile/features.ts`、`render/graph.ts`、`render/layout.ts`、`render/scene.ts`、`render/uniforms.ts` 与两个 `p8.test.ts`）。我验收后逐文件 `git merge-file` 合并到新 HEAD `e49e9f79`（期间 P5c 步骤 2、P9a 步骤 3 提交）：6 个干净合并；`render/graph.ts`、`render/scene.ts` 各 3 处冲突，都是和 P5c 的模型层在同一位置各加一段（文件头说明、`planModelLayer` / `planShapeLayer`、`planLayer` 的分流、`buildableLayers` 的条件与注释），两边都留。没有碰暂存区。
- **快照验收**：tsc 0 error；vitest 2362 个用例 2 个失败，`pipeline.test.ts` 的请求次数上限（`3830255100` 219 次）与 `p5c.test.ts` 的 M3，基线快照上同样失败。
- **回归**（`kbp regress --corpus`，`ignore/p8/s2/regress`）：回放案例 17 组两边逐字节相同、全部通过；语料只去掉 `object:shape`（18 张），没有新增的键（`lightshafts` 的 `DIRECTDRAW = 1` 变体在 24 个形状上都翻译通过），干净 48 → 53（`3656079027`、`3811764016`、`3812887609`、`3819646765`、`3821678218`）。
- **四角**（`ignore/p8/s2/corners/`，产品代码的 `shapeQuad` × 形状分支的 MVP 对 RenderDoc 的 `vs_out`）：`p8-shape` 9 个、`p8-shape2` 3 个形状，各两帧，每次 6 个顶点，最大差 8.1e-5 像素（限值 0.01），uv 逐个相同，画的 pass 的 `g_Point0` / `g_Scale` 与 WPE 读到的相同（`p8-shape2` 的 SA 几何取第一个 effect、画第二个）。
- **变异**（`ignore/p8/s2/mutations.py`，快照模式）：带的顶点顺序、`1 − p.y`、缺省边长取宽、几何取最后一个 effect、画第一个 effect、不强制 additive、看 effect 的 `visible`、不强制 `DIRECTDRAW`、`g_LayerModelMatrix` 取世界矩阵、`buildableLayers` 不收形状、仍报 `object:shape`，11 处全部被单测检出，按原字节还原。
- **工作区验收**：tsc 0 error；vitest 2412 个用例 1 个失败，`pipeline.test.ts` 同上（`p5c` 的 M3 已被 P5c 步骤 2 修好）；Prettier 通过。
- **画面**：dev 宿主按 `--mode development` 重建后渲染，和 WPE 抓帧比（屏蔽 FR / CLK）。
  - `p8-shape` 最大差 6、> 2 的像素 0.081%；`p8-shape2` 最大差 2。两个工程的 `rayspeed` / `noiseamount` 为 0，画面不随时间变；日志每 50 帧才刷，回放到第 150 帧对 WPE 第 158 / 155 帧。
  - `p8-par`：日志不带光标，光标按 WPE 抓帧里 L1 的 MVP 平移反推成 (1.0, 0.9806)，除了 A（`top` 对齐，步骤 3）那一块全部相同。形状 S 在 WPE 里被视差整个推出画面（`vs_out` 全在 x < 0），和我们一致。
  - 解锁的 5 张各解包加日志（`ignore/p8/proj/<ID>-kbp`）、抓一帧（`A:\p8\<ID>-kbp-fps20-1920x1080`）、按日志回放比。共用的 log.txt 里混进了另一个会话 WPE 窗口的 `[kbp]` 行（3 列），按列数滤成 `ignore/p8/s2/<ID>-log.txt`。
    - 差 > 32 的像素占 0.02%–0.65%，在随机粒子和 4K 场景缩放的轮廓上。
    - 按 WPE 的形状 `vs_out` 分四边形里外算（`shape_region.py`）：里外的有符号平均差都在 ±0.2 以内，里面 > 8 的占比不比外面高，光束没有缺失或错位。
    - `3821678218` 的舞台光束放大并排看一致。
