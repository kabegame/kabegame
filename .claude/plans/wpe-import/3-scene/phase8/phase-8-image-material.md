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

## 步骤 3 — 对齐

### 思路

对齐是图层**自己绘制时**多出的一段平移：WPE 的世界矩阵虚函数（图像层 +0x80）在基类矩阵后面右乘 `T(a)`，`a` 按对齐取值是 `(±w/2, ±h/2)`，`w`、`h` 是 `trunc(size)`。子层的世界矩阵走另一条非虚的基类函数，不带父层的这段平移。所以对齐不是「本地矩阵的一部分」，而是「这一层画自己时用的矩阵」比层级里的矩阵多一个 `T(a)`。

我们现在把文本层的排版偏移（P6b 1d）写成本地矩阵的一部分（`layerLocalMatrix` 右乘 `T(offset)`），子层跟着走。读码说文本的 +0x80 结构相同、子层同样不带它，步骤 3 的补测也实测到了（下文 `p8-align2` 的 Xc）。所以这一步把偏移从层级里拿出来：
- `worldMatrixOf` 只沿父链乘不带偏移的本地矩阵，子层、粒子、控制点、模型都用它；
- 新增 `drawMatrixOf`，等于 `worldMatrixOf · T(offset)`，图层自己的每一次绘制（直接上屏、末 pass、passthrough、compose 基础 pass、effect 的效果矩阵与 `g_LayerModelMatrix`、文本）和组的局部正交（裁剪窗口）都用它。

`LayerState.offset` 成为唯一的「自身偏移」：文本层照旧由排版填，图像层由 `SceneState` 按对齐取值和 `trunc(size)` 算，脚本写 `alignment` 时就地重算。

对齐只在图像层上有（WPE 图像层自己的属性表）：文本、形状、粒子、模型、声音、灯、分组节点都不认它，中性。取值只认字符串，查不到或不是字符串（含绑用户属性、写数字）一律 `center`，所以 JSON 里的任何写法都不用报。唯一照报的是 `fullscreen` 图层带非 `center` 的对齐：它的末 pass 是单位矩阵，偏移落在哪里没测，语料 0 个。

顺带两条（读码加 `p8-align2` 实测）：
- 图像层上屏的四边形（几何 `layer`：直接上屏、末 pass、passthrough、compose）边长按 `trunc(size)`，没有对齐时也是；
- 效果矩阵里的缩放仍按浮点 `size / 2`。

画进合成 RT 的基础 pass（几何 `fill`）不变。文本层的四边形不动（尺寸来自排版）。

脚本 `thisLayer.alignment`（图像层）读回名字字符串，写入时查表、查不到写 `center`，偏移就地重算、同帧生效（WPE 写完回调重建，下一次绘制生效）。其它图层上照旧是普通属性（WPE 读回什么由脚本 dll 决定，没查）。

另记：WPE 的光标命中测试用带对齐的矩阵（rea-p8-layer 2.3）；P6 做命中测试时用 `drawMatrixOf` 和截断后的尺寸。

### 补测（`p8-align2`，2026-11-13）

步骤 0 的 `p8-align` / `p8-par` 已经实测了 9 种取值、旋转缩放、effect、子层、视差和脚本写入（270 个顶点 1.4e-4 像素）。动工前补测四处没覆盖的：
- 工程：`ignore/p8/s2/gen_align2.py` → `ignore/p8/proj/p8-align2`；
- 抓帧：`A:\p8\p8-align2-fps20`，导出 `ignore/p8/s2/dump-align2.json`，`show_align2.py` 读。

| 对象 | 实测 | 结论 |
|---|---|---|
| F1：101.7×50.5、`topleft` | `vs_in` 是 ±50.5 / ±25，MVP 平移 = origin + (50.5, −25) | 四边形与偏移都按 `trunc(size)` |
| F2：同上、带读效果矩阵的 effect | `g_EffectTextureProjectionMatrix` 的 x 缩放 0.052969 = 50.85 / 960，平移同 MVP；`g_EffectModelMatrix`、`g_LayerModelMatrix` 的平移是 origin + 偏移 | 效果矩阵按浮点 `size / 2`；原料是带偏移的 `W` |
| F3：同尺寸、不对齐、带 effect | 末 pass 屏幕边 1049.5–1150.5 | 没对齐也按 `trunc(size)` |
| X / Xc：文本（左上对齐）下挂 20×20 子层 | Xc 的 MVP 平移 = 文本的 origin (500, 500)。我们现在画在 (574, 668) 一带（子层跟了排版偏移） | 文本的子层也不带偏移，P6b 的「子层跟着走」要改 |
| U：`{user, value: "topleft"}`；N：数字 3 | 都居中 | 不是字符串一律 `center` |
| G / Gc：带子层的组 `topleft` | 组的 compose 基础 pass 与上屏的平移 = origin + (150, −100)；Gc 在组 RT 里落在左上角（局部正交按带偏移的矩阵） | 组的裁剪窗口跟着偏，子层留在原来的世界位置 |

### 现状锚点（HEAD `3c4f723b`）

**a. 对齐照报**（`compile/features.ts:707`）
```ts
  if (object.alignment !== undefined && object.alignment !== "center" && !text && !shape)
    unsupported.add("object:alignment"); // 现状：图像层上 8 种取值整张退回（24 张、158 个对象，全是字符串）
```

**b. 偏移在本地矩阵里，子层跟着走**（`render/layout.ts:129`、`:150`）
```ts
export function layerLocalMatrix(layer: Pick<LayerTransform, "origin" | "angles" | "scale" | "offset">): Mat4 {
  // …
  const [ox = 0, oy = 0] = layer.offset ?? [];
  return ox === 0 && oy === 0 ? local : multiply(local, translation(ox, oy, 0)); // 现状：worldMatrixOf 沿父链乘它，子孙都带
}
  /** 局部平移（P6b 1d，只有文本层有）……右乘在本地矩阵最后（`T · R · S · T(offset)`），子对象跟着走 */
  offset?: readonly number[];
```

**c. 绘制与组的局部正交用层级矩阵**（`render/scene.ts:2005`、`:2023`）
```ts
      world: worldMatrixOf(layer.object, state.layers, worlds),   // 现状：自身绘制与子层同一个矩阵
        ? groupViewProjection(group.size, worldMatrixOf(group.object, state.layers, worlds))
```

**d. 上屏四边形用浮点尺寸**（`render/scene.ts:1848`）
```ts
          : layerQuad(this.layerSize(layer, state), step.uv, step.inset);   // 现状：101.7 × 50.5 画成 ±50.85 / ±25.25
```

**e. 脚本 `layer.alignment` 照报**（`compile/scriptApi.ts:171`，「字段：写入在我们这边落成普通属性」那张表）
```ts
    ...fields([
      "alignment",   // 现状：脚本读写 alignment 报 script:api:layer.alignment
```

### 点 1 — 编译（`compile/features.ts`、`compile/bundle.ts`、`compile/scriptApi.ts`）
- **新增**
  - `ALIGNMENTS`（`center` 0 … `topleft` 8，rea-p8-layer 2.1 的表）与 `alignmentIndex(value)`：字符串查表，查不到或不是字符串为 0。放 `compile/features.ts` 或新的小模块，编译、状态、脚本共用。
  - `SceneLayer.alignment?: number`：图像层（`compileImageModel`）填 `alignmentIndex(object.alignment)`，其它对象不填（可选同 `text`、`model`，不动手写的测试图层）。绑用户属性的照样按 JSON 值求（`{user, value}` 不是字符串 → 0），不登记绑定。
- **修改**
  - `checkObjectFeatures`：删掉 `object:alignment`；未知键循环的跳过名单保留 `alignment`。
  - `compileImageModel`：`fullscreen` 图层的对齐不为 0 时报 `object:alignment:fullscreen`。
- **删除**
  - `scriptApi.ts` 字段表里的 `alignment`（图像层上实现了；别的图层上 WPE 读回什么没查，不再静态报）。

### 点 2 — 偏移与矩阵（`render/layout.ts`）
- **新增**
```ts
/**
 * 对齐偏移（P8 步骤 3，rea-p8-layer 2.2，p8-REPORT 结论 6，`p8-align2` 的 F1）：`w`、`h` 是 `trunc(size)`，
 * `a = (±w/2, ±h/2)`（left +、right −、top −、bottom +，场景 y 向上），float32 的 `(float)int × 0.5`。center 为 (0, 0)。
 */
export function alignmentOffset(alignment: number, size: readonly number[]): [number, number];
/**
 * 图层画自己时的矩阵（P8 步骤 3，rea-p8-layer 2.3）：`worldMatrixOf · T(offset)`。WPE 的世界矩阵虚函数（+0x80）在基类矩阵后
 * 右乘对齐（图像层）或排版（文本层）的平移；子层的世界矩阵走非虚的基类函数，不带它（`p8-align` 的 d 行、`p8-align2` 的 Xc、Gc）。
 */
export function drawMatrixOf(object: number, layers: …, cache: Map<number, Mat4>): Mat4;
```
- **修改**
  - `layerLocalMatrix` 不再读 `offset`；`LayerTransform.offset` 的注释改成「只作用在这一层自己的绘制上，子孙不带」。
  - `worldMatrixOf` 的注释写明不含偏移。

### 点 3 — 状态（`render/state.ts`、`compile/bindings.ts`）
- **新增**
  - `LayerState.alignment?: number`（图像层，取 `SceneLayer.alignment`）。
  - `LayerField` 加 `"alignment"`：只给脚本写，写入值按 `alignmentIndex` 换成下标。
- **修改**
  - `SceneState.fromBundle`：图像层的 `offset` = `alignmentOffset(alignment, layer.size)`（`layer.size` 已是 autosize / fullscreen 之后的尺寸；不为 0 才写，没有对齐的图层字节不变）。
  - 写 `alignment`：改下标、重算 `offset`、标脏。组的子孙要跟着刷新局部正交，按会传给子孙的字段处理。
  - `offset` 的注释改成「自身偏移：文本层排版、图像层对齐」。

### 点 4 — 渲染器（`render/scene.ts`）
- **修改**
  - `uniformValues` 的 `world` 与组的局部正交改用 `drawMatrixOf`。粒子、控制点、模型的视锥剔除和预热仍用 `worldMatrixOf`：这些对象没有偏移，也不会是带偏移的层的「自身」。逐处核对 `worldMatrixOf` 的调用，各写一句用哪个的理由。
  - 建 draw 的几何 `layer`：图像层（不是文本层）的尺寸按 `trunc`。规则放进 `layout.ts` 的纯函数（如 `screenQuadSize(layer, size)`），`fill` 与 `fullscreen` 不变。
  - 效果矩阵（`drawMatrices` 的 `half`）不改，仍按浮点 `size`（F2 实测）。

### 点 5 — 脚本（`script/api.ts`）
- **新增** 图像层（`SceneLayer.alignment !== undefined`）的 `alignment` 访问器：读返回 `ALIGNMENTS` 里的名字，写经 `this.write({ kind: "layer", object, field: "alignment" }, value, …)`，字符串查表、别的值写成 `center`。其它图层不装（照旧是普通属性）。

### 点 6 — 单测
- **新增** `compile/p8.test.ts`、`render/p8.test.ts` 的步骤 3 `describe`：
  - `alignmentIndex`（9 个名字、大小写不对、数字、`{user, value}`、null）。
  - `alignmentOffset` 对 `p8-align` 的 ana_align 表（9 种 × 160×100）和 F1（101.7×50.5 → (50.5, −25)）。
  - `drawMatrixOf` 与 `worldMatrixOf`：子层不带父层偏移（`p8-align` d 行）；对旋转缩放的偏移（b 行的数字）；文本层的子层（Xc）。
  - 组的局部正交用带偏移的矩阵（Gc 的 MVP 平移 (0, 1080)、缩放 6.4 / 5.4）。
  - 四边形：图像层 101.7 × 50.5 → ±50.5 / ±25，文本层不截断；效果矩阵仍是 50.85。
  - 能力表：8 种取值不报，`fullscreen` 报 `object:alignment:fullscreen`；脚本表不再有 `alignment`。
  - 脚本读写：读名字、写字符串、写数字读回 `center`、写后 MVP 同帧变、非图像层没有访问器。
- **修改** 现有断言「子层跟着文本偏移」的测试（如果有）改成新语义，报告里列出来。

### 实施方式

同前两步：工作区里文本脚本的会话正在改 `script/api.ts`、`render/state.ts`、`host.ts` 等。实现代理只改 `ignore/p8/s3/ov/src`（HEAD 快照），我验收后逐文件三方合并，不碰暂存区。

### 验收
- 快照里 tsc 0 error，vitest 全过（基线就失败的照记）。
- `kbp regress --corpus`：回放案例全部相同。语料去掉 `object:alignment`（24 张）和 `script:api:layer.alignment`，新出现的键逐张核对。干净场景不变（53）：`3812487163` 还差 `thisScene.createLayer` / `sortLayer`（P6），这一步解锁不了。
- 四角：`p8-align` 的 45 个图层、`p8-align2` 的 F1–F3、U、N、G、Gc 和 Xc（产品代码的四边形 × MVP）对 RenderDoc 的 `vs_out`，限值 0.01 像素。
- 画面：`p8-align`、`p8-align2`、`p8-par` 用 `render_scene` 渲染，和 WPE 抓帧逐像素比（屏蔽 FR / CLK；`p8-par` 的 T 是脚本改的对齐，探针不跑脚本，这一块另算）。
- 变异检查：偏移的正负号（left / right、top / bottom）、偏移不截断、四边形不截断、效果矩阵截断、子层带父层偏移、组的局部正交不带偏移、绑属性的值当字符串求、脚本写数字不落 `center`，单测或比图要能检出。

## 步骤 4 — 图层依赖

### 思路

WPE 的图层依赖是两件事，各自独立：
- 一个图层「被依赖」，它的合成链第 0 张就换成按图层独占、跨帧保留的 RT；
- 材质槽里写的 `_rt_imageLayerComposite_<id>_a` 按名字绑到这张 RT 上。

**被依赖。** 场景加载完，WPE 把全部对象（含模型对象）的 `dependencies` 取并集，命中的图像层置 `0x1010`：
- `0x10` 让它像 colorBlendMode 混合的图层一样走合成路径。全部 effect 都留在合成链里，最后用 passthrough 材质把结果铺上屏；
- 起点按写入次数的奇偶安排，让最后一次写入落在第 0 张，也就是独占的 `_a`；
- `0x1000` 让它不可见（自身或祖先）时也照画，只是不上屏；
- 不改绘制顺序。被依赖者排在引用方后面时，引用方读到的是上一帧。

我们这边把「被依赖」做成图层的一个静态标志 `SceneLayer.dependedOn`，编译期按并集定下来，渲染图与渲染器各认它一处：
- **渲染图**（`planLayer`）：
  - 被依赖的图层一律走合成路径，组合层没有 effect 时也画；
  - 最后一个 effect 不上屏；
  - 有 `layer.passthrough` 时多一步 `passthrough` 上屏（被依赖时也编这个材质，`BLENDMODE` 取 colorBlendMode ∉ {0, 31} 时的值，否则 0）；
  - 排完后若最后一次写入落在 1，就把整份计划里合成 RT 的 0、1 对调。
- **渲染器**：
  - 每个被依赖的图层在建场景时建一张独占 RT，尺寸、格式、采样同它的合成 RT，跨帧、跨 effect 开关的重建都保留；
  - 它的合成 RT 0 就是这张，其余张照旧从池里借；
  - 不可见时照跑它的 op，只跳过画到「场景」的那一步上屏，在组里也一样。

**引用。** WPE 在材质创建时按名字查纹理表。依赖段在加载末尾才给被依赖图层建 RT，建 RT 时接管同名的占位对象，所以只要被依赖，引用方的槽最终就是那张 RT；查不到的名字一直是占位纹理，即 6×6 的黄黑棋盘格。我们在编译期一次定下：
- **名字是某个被依赖图像层的 `_rt_imageLayerComposite_<id>_a`**：pass 里记下「槽 → 图层」（`ScenePass.layerComposites`），渲染图给出新的纹理来源 `{ kind: "layer", object }`，渲染器解析到那张独占 RT。采样器随那张 RT，`g_Texture<n>Resolution` 是 RT 的尺寸。
- **别的 `_rt_imageLayerComposite_*` 名字**（没被依赖、id 不存在、不是图像层、`_b`）：绑 bundle 里的一张棋盘格纹理。它是普通的静态纹理（RGBA8、点采样、重复），和材质纹理走同一条路。
- **`TEX<n>FORMAT`**（refraction 的法线槽声明了 `formatcombo`）：取材质创建那一刻纹理表里那个对象的格式：
  - 经 `dependencies` 置位的 RT 在全部材质之后才建，所以是占位的 0；
  - 被依赖者自己就有 `0x10`（colorBlendMode 混合）且排在引用方前面时，HDR 下是 RT 的 14；
  - LDR 一律 0。

**中性与照报。**
- `dependencies` 在各种对象上都中性：只影响并集。粒子对象另有一套同名键，元素是对象，WPE 拿来做发射图与碰撞模型，没做，照报。
- 被依赖的图层不做视锥剔除：我们的图像层本来就不剔除，这一条不用做。
- 语料 0 处、照报的四种：
  - 被依赖的是文本层：文本层的合成 RT 随重排换尺寸，引用方的绑定要跟着换；
  - 被依赖的是组：组隐藏时子层怎么画没查；
  - 被依赖的图层在自己的 pass 里读自己的 `_a`：读写同一张；
  - 名字指向一个没被依赖、但自己有 `0x10` 的图层：WPE 能绑上，我们只能给棋盘格。

### 核对（`p8-dep`、`p8-dep2`、`p8-misc` 的已有导出，语料 `ignore/p8/s4/scan_deps.py` → `ignore/p8/s4/deps.txt`）

步骤 0 的抓帧已经覆盖了 14 种组合，动工前只补核对三处没写进报告的细节和语料分布，不再开 WPE：

| 项 | 实测 / 语料 | 结论 |
|---|---|---|
| 上屏的内缩 | `p8-dep` A2（64×64 纹理、200×200 图层）上屏那次 `vs_in` 的 UV 是 0.00234375–0.99765625 = 0.15 / 64；A7（组合层）0–1 | 同普通的末 pass（`finalInset`），rea-p8-render 2.4 写的「不内缩」不对 |
| 上屏的混合与颜色 | A2、A9 上屏：基础材质的 translucent、写掩码 7、`g_Color4` = 1；槽 0 是独占 RT | 同 colorBlendMode 混合的 passthrough 上屏 |
| 写入顺序 | A2（1 个 effect）：基础 pass → 池化、`kbtime` → 独占；A11（2 个）：基础 → 独占、`kbinv` → 池化、`kbtime` → 独占；A9 / A12（没有 effect）：基础 → 独占 | 最后一次写入落在 0 |
| 语料的被依赖者 | 9 张场景、23 个，全是图像层（`autosize` 13、组合层 9、`solidlayer` 1）；没有组、没有文本层；1 个在组里（`3554161528` 的 411，组 1111 自己读它）；5 个有父对象，其中几个祖先的 `visible` 绑了属性或脚本 | 照规则做，不可见的祖先不影响画进 RT |
| 语料的引用 | 52 处：44 处都解析得到；8 处自引用都在 `bind` 占的槽上 | 棋盘格在语料里用不到，只在测试工程里出现 |
| 模型对象的依赖 | `3509243656` 的两个模型对象列了两个隐藏的图像层；它们的材质（`materials/models/自制天空盒02/材质.json`、`materials/models/Hollow Cylinder/diffuse_0.json`）槽 0 就读这两个 `_a`（核对脚本只看了模型 JSON，漏了，语料回归时才发现） | 网格 pass 同样按名字解析（四种计划都认 `layerComposites`）；这张场景还差别的节，模型这条路没和 WPE 比 |
| `formatcombo` | WPE 自带 effect 里只有 `refraction` 的槽 1（法线）声明；`2251857160` 的 foggy_glass 在这个槽上引用 1755（排在后面、经依赖置位） | 格式按上面的规则，语料里都是 0 |

### 现状锚点（HEAD `187f41c9`）

**a. 依赖与引用都照报**（`compile/features.ts:726`、`compile/bundle.ts:1350`、`:1418`）
```ts
  for (const [key, value] of Object.entries(object))
    if (!SUPPORTED_OBJECT.has(key) && !OBJECT_FLAGS.includes(key) && ![/* … */].includes(key) && /* … */ active(value))
      unsupported.add(`object:${key}`); // 现状：`dependencies` 从这里报 object:dependencies（9 张）
// compilePass
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name)) formats.push(/* … */);
        else issues.add(`texture:rendertarget:${name}`); // 现状：_rt_imageLayerComposite_<id>_a 报这里（8 张）
        continue;
      }
// 注解 default 的同一条路
        if (fallback.startsWith("_rt_")) {
          if (!bindRuntime(binding.slot, fallback)) issues.add(`texture:rendertarget:${fallback}`);
```

**b. passthrough 材质只给 colorBlendMode 混合编**（`compile/bundle.ts:1812`）
```ts
    if (cbm !== 0 && cbm !== 31) {   // 现状：被依赖的图层没有上屏材质
      // …
        layer.passthrough = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(cbm) } },
```

**c. 渲染图：组合层不画、最后一个 effect 上屏、写入从 0 起**（`render/graph.ts:598`、`:726`、`:790`、`:646`）
```ts
  if (!needsComposite(layer, enabled) && !group) {
    if (layer.passthroughModel) return { composite: null, steps, reasons }; // 现状：被依赖的组合层也不画
  // …
  if (!passthrough)   // 现状：只有 colorBlendMode 混合才让最后一个 effect 留在合成链
    for (let e = layer.effects.length - 1; e >= 0 && finalEffect < 0; e--) { /* … */ }
  // …
  if (passthrough) { const pass = layer.passthrough; /* … */ blending: base.blending, /* … */ }
  const nextComposite = (): TargetRef => {
    const index = writes % 2;   // 现状：第一次写入总在 0，最后一次落在 (写入数 − 1) % 2
```

**d. 运行时纹理只认快照与 fbo**（`render/graph.ts:568`）
```ts
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else if (effect !== null && fboNames[effect].has(name)) inputs[Number(slot)] = { kind: "fbo", effect, name };
      else reasons.push(`render:texture-rt:${name}`);
    }
```

**e. 写死不可见的不建资源，合成 RT 全从池里借，不可见的整段跳过**（`render/scene.ts:853`、`:1411`、`:3328`、`:3386`、`:3412`）
```ts
      everyAncestor(layer.object, byObject, (item) => item.visible || item.visibleBound || scripted), // 现状：隐藏的被依赖图层不建
  // ensureComposites
    const { composites } = runtime.resources;
    composites.push(...pool.slice(composites.length, count));   // 现状：没有独占的
  // encode
    const visible = new Set(visibleObjects(this.layers, state));
            const child = visible.has(object) ? this.runtimeByObject.get(object) : undefined; // 组里：不可见的不画
    for (const layer of this.layers) if (layer.layer.group == null && visible.has(layer.object)) runOps(layer.ops);
```

### 点 1 — 依赖表与棋盘格（新文件 `compile/dependencies.ts`）
- **新增**
```ts
/** 合成 RT 的名字前缀（rea-p8-render 2.1）。 */
export const LAYER_COMPOSITE_PREFIX = "_rt_imageLayerComposite_";
/** 被依赖图层独占 RT 的名字：id 按十进制，后缀写死 `a`（`_b` 不存在，rea-p8-render 2.2）。 */
export function layerCompositeName(id: number): string;
/**
 * 全部对象 `dependencies` 的并集（rea-p8-render 第 1 节，`FUN_1401ddbb0` + 场景构造的依赖段）：值是数组或对象（取值）才遍历，
 * 元素是非负整数才收；别的元素跳过。不分是谁列的（模型对象列的也算）。
 */
export function dependencyIds(objects: readonly SceneObject[]): Set<number>;
/**
 * 引用不到时的占位纹理（rea-p8-render 2.6，p8-REPORT 结论 12）：6×6 RGBA8，第 i 个像素行 = i / 6，(行 & 1) ≠ (i & 1) 时
 * (255, 255, 0, 255)，否则 (0, 0, 0, 255)；标志 9，点采样、重复（`clampUVs` 假、`noInterpolation` 真），一级 mip。
 */
export function checkerTexture(): SceneTexture;
```

### 点 2 — 编译（`compile/bundle.ts`、`compile/features.ts`）
- **新增**
  - `SceneLayer.dependedOn?: boolean`：图像层（走到 `compileImageModel` 的对象）的 JSON `id` 在并集里。可选同 `alignment`，不动手写的测试图层。
  - `ScenePass.layerComposites?: Record<number, number>`：槽 → 被依赖图层的 `objects` 下标。这些槽不进 `runtime`。
  - `compileScene` 开头：
    - 并集；
    - 名字表：每个图像层（判定同编译循环：不是粒子、模型、声音、形状、文本，有 `image`）的 `layerCompositeName(id)` → `{ object, depended, ownComposite }`；
    - `ownComposite` 是 colorBlendMode ∉ {0, 31}，按属性当前值求，同 `colorBlendMode` 字段，不登记绑定。
  - 棋盘格纹理按需加进 `bundle.textures` 一次，各处共用同一个下标。
- **修改**
  - `compilePass`：材质 `textures` 与注解 `default` 里以 `LAYER_COMPOSITE_PREFIX` 开头的名字（`planned` 的槽照旧跳过，`bind` 胜出）：
    - 名字表里有、`depended`：
      - 记进 `layerComposites`；
      - 格式按思路里的规则：HDR、`ownComposite`、被依赖者下标 < 本 pass 所属对象的下标时 14，否则 0；
      - 被依赖者就是本对象时报 `dependency:self`。
    - 其余：
      - 槽绑棋盘格，格式 0；
      - 名字表里有、没被依赖、`ownComposite` 时报 `dependency:passthrough-undeclared`。
    - 不再报 `texture:rendertarget:_rt_imageLayerComposite_*`。
  - 编译循环：
    - 图像层填 `dependedOn`；
    - 被依赖时：
      - 也编 `layer.passthrough`，`BLENDMODE` = cbm ∉ {0, 31} ? cbm : 0，`g_Color4` 照旧置 1；
      - 光照照报的条件加上它（`lighting:prelighting`，WPE 在 `0x10` 时同样挪光照）；
      - 是组（有子层的组合层）时报 `dependency:group`。
    - 文本对象的 id 在并集里：报 `dependency:text`。
  - `checkObjectFeatures`：
    - `dependencies` 不再从未知键报；
    - 粒子对象的 `dependencies` 有不是数字的元素时报 `particle:dependencies`；
    - 模型对象那段注释同步改。

### 点 3 — 渲染图（`render/graph.ts`）
- **新增**
  - `TextureRef` 加 `{ kind: "layer"; object: number }`：别的图层的独占 RT。
  - 各处输入（`planLayer` 的 `staticInputs`、`planShapeLayer`、`planParticleLayer`、`planModelLayer`）把 `pass.layerComposites` 映射成它。
- **修改** `planLayer`，`const depended = !!layer.dependedOn`：
```ts
  // 被依赖（P8 步骤 4，rea-p8-render 第 1、2 节）：强制合成；组合层没有 effect 也画（`p8-dep` A7、`p8-misc` A13）
  if (!needsComposite(layer, enabled) && !group && !depended) { /* 原样 */ }
  // …
  if (!passthrough && !depended) /* 找最后一个 effect 的最后一个绘制 pass，原样 */;
  // …
  if (passthrough || depended) {
    // 上屏：passthrough 材质，混合 = colorBlendMode 31 ? additive : 基础材质的（rea-p8-render 2.3）；内缩同末 pass（核对表第 1 行）
    blending: additive ? "additive" : base.blending,
  }
  // 最后一次写入落在 0（`_a`）：排完后若落在 1，计划里全部合成 RT 引用 0 ↔ 1 对调（draw 的目标与输入、copy、clear、subtree）
  if (depended && current === 1) swapCompositeIndices(steps);
```
  - 快照规则 1 不变（看 colorBlendMode 与基础材质，不看 `0x10`，rea-p8-render 2.4）。合成 RT 张数仍是 min(2, 写入次数)。
- 文件头注释加一条「被依赖」。

### 点 4 — 渲染器（`render/scene.ts`）
- **新增**
  - `layerTargets: Map<number, RenderTarget>`：`objects` 下标 → 独占 RT。
  - `build` 里建完全部 runtime 之后、任何 `buildLayer` 之前，给每个被依赖的图层建一张：
    - 尺寸 = `compositeSize(layer, baseTexture)`；
    - 格式 = 场景格式；
    - 采样 = `compositeSampling`；
    - 计进 `targetBytes`、随场景销毁。
- **修改**
  - `buildableLayers`：`layer.dependedOn` 时不看自身与祖先的可见性（`0x1000`）。
  - `ensureComposites`：被依赖的图层 `composites[0]` 是独占 RT，其余照旧从同键的池里借；effect 开关重建时保留。
  - `resolveTexture`：`layer` → `layerTargets.get(object)`，取不到返回 null（建 draw 时照旧报 `render:texture-rt:layer`）。
  - `encode`：顶层与组里的子树都走同一个判断：
```ts
    // 被依赖的图层不可见（自身或祖先）时照画进 RT，只跳过上屏（WPE `0x1000`，rea-p8-render 2.4）：它画到「场景」的只有上屏那一步
    const runLayer = (runtime: LayerRuntime, sceneTarget?: GPUTextureView) => {
      if (visible.has(runtime.object)) runOps(runtime.ops, sceneTarget);
      else if (runtime.layer.dependedOn)
        runOps(runtime.ops.filter((op) => !(op.kind === "draw" && op.draw.step.target.kind === "scene")), sceneTarget);
    };
```
  - 文件头注释加一条「被依赖」。

### 点 5 — 单测
- **新增** `compile/p8.test.ts`、`render/p8.test.ts` 的步骤 4 `describe`：
  - `dependencyIds`：数组、对象取值、重复、负数 / 小数 / 字符串 / null 跳过、模型对象列的也算。
  - 棋盘格逐像素（(0, 0) 黑、(1, 0) 黄、(0, 1) 黄）、标志与采样。
  - 名字解析：被依赖 → `layerComposites`；没被依赖、不存在、`_b`、不是图像层 → 棋盘格；`bind` 的槽不动；注解 `default` 同样。
  - 格式：LDR 0；HDR 下经依赖置位 0、自带 `0x10` 且在前 14、在后 0。
  - 照报四键与 `particle:dependencies`；`object:dependencies` 不再报。
  - 被依赖时编 `passthrough`（`BLENDMODE` 0 / cbm）。
  - 计划，照 `p8-dep` / `p8-dep2` / `p8-misc` 的组合：
    - 0 / 1 / 2 个 effect 的写入顺序（核对表第 3 行）；
    - 组合层没有 effect 也画（compose → 0 → 上屏）；
    - 上屏的混合（translucent / cbm 31 additive / cbm 7 基础材质）与内缩；
    - colorBlendMode 7 + 被依赖（`2251857160` 的 356）。
  - 渲染器：
    - `buildableLayers` 收写死隐藏、祖先隐藏的被依赖图层；
    - 不可见时只跳过画到场景的 draw（纯函数抽出来测，或假设备测 op 序列）；
    - 引用解析到同一张独占 RT，两个引用方共用；
    - effect 开关重建后还是同一张。

### 实施方式

同前几步：子代理在 HEAD 快照副本 `ignore/p8/s4/ov` 里实现，`ignore/p8/s4/head` 作基线；我验收后逐文件三方合并到工作区，不碰暂存区。

### 验收
- 快照里 tsc 0 error，vitest 全过（基线就失败的照记）。
- `kbp regress --corpus`：回放案例全部相同。语料只去掉 `object:dependencies`（9 张）与 `texture:rendertarget:_rt_imageLayerComposite_*`（8 张），新出现的键逐张核对（预期没有）。干净场景不变：这 9 张都还差别的节。
- 画面：`p8-dep`、`p8-dep2`、`p8-misc` 用 `render_scene` 按日志回放，和 WPE 抓帧逐像素比，屏蔽 FR / CLK。
  - `p8-misc` 的 W1、W2 是步骤 5 的，另算。
  - A3 / B3 要读到上一帧：回放要连续画到目标帧。
  - 棋盘格的 B4–B6 逐格对上。
- 语料：强制渲染 `3243449890`（4 个引用方读一个组合层）、`3554161528`（组里的被依赖者）、`2251857160`（依赖链与 cbm 7），没有 WebGPU 校验错误，引用方那块不是棋盘格。只看这些，不逐像素验收，这几张还差别的节。
- 变异检查：
  - 不对调奇偶；
  - 不可见时连上屏一起画，或整层跳过；
  - `buildableLayers` 不收；
  - 最后一个 effect 仍上屏；
  - 上屏不看 cbm 31；
  - 并集漏掉模型对象列的；
  - `_b` 也解析；
  - 棋盘格换成透明；
  - 格式恒取 14。

  单测或比图要能检出。

## 步骤 5 — 写入状态

### 思路

两件事都只改「一次绘制写哪些通道」，不碰渲染图的结构。

**`alphawriting`**：WPE 的设备有一个「写不写 alpha」的状态。稳态是不写，图层进合成路径时打开，上屏前关掉。材质 pass 的 `alphawriting` 在绑定时改它：`enabled` 打开，`disabled` 关掉，`default` 不动。有两处例外：
- 最后一个 effect 的上屏 pass 绑定之后被强制改回（只看是不是在 `copybackground: false` 的组里），所以这个 pass 上写什么都不起作用；
- `copybackground: false` 的组里 alpha 取 MAX，写掩码被强制成 0xF。

我们现在的 `stepPipeline` 已经按目标、组和上屏角色算出缺省的 `alpha`，这一步只在它上面叠材质的取值。规则做成纯函数：
1. 上屏角色（`final` / `passthrough`）不看材质；
2. 组的 alpha MAX 强制写；
3. 其余 `enabled` 写、`disabled` 不写，缺省照旧。

`alphawriting` 随 `ScenePass` 带到渲染器，只在 `enabled` / `disabled` 时写这个字段。语料里的 `enabled` 全在 `cursorripple` 画进 fbo 的 pass 上，本来就写 alpha，画面不变。

**`alphatocoverage`**（混合模式 3）：WPE 的混合状态是混合关、`AlphaToCoverageEnable` 开，写掩码与深度照 `normal`。另外，绑定时给着色器组合键加 `ALPHATOCOVERAGE = 1`，`genericimage4` 等读它，把 alpha 锐化成以 0.5 为中心的阶跃。WPE 用户设置是 `msaa: none`，场景目标单采样，实测 A2C 等于「alpha > 0.5 才写入」的硬阈值。

WebGPU 的 alpha-to-coverage 只能用在多重采样目标上，所以在片元着色器里丢弃：
- **丢弃的位置**：在翻译出的片元模块里另加一个入口 `kb_a2c_<入口>`。它是原入口的逐字副本，只把每个 `return X;` 换成「X 的位置 0 输出的 alpha 不大于 0.5 就 `discard`，否则返回 X」。主体 `main_1()` 一字不动，丢弃发生在它之后，导数不受影响。
- **只有 A2C 管线用新入口**：同一个程序既可能画进合成 RT（A2C 关），也可能上屏（A2C 开）。上屏的是哪个 effect pass 要到运行时按 effect 开关才定，所以丢弃必须按管线开关，不能在编译期按程序定。
- **按需建**：新入口所在的模块按程序在第一次需要 A2C 管线时才建，其余程序和管线的着色器、管线键逐字节不变。

哪一步开 A2C：
- 步骤的实际混合是 `alphatocoverage` 就开，包括借了基础材质混合的上屏 pass 与 passthrough，以及粒子、网格；
- 画进合成 RT 的基础 pass 混合是 null，不开，写的是锐化后的 RGBA（`p8-misc` 的 W2）。

组合键只加在混合是 `alphatocoverage` 的材质 pass 上。WPE 在上屏时把基础材质的混合拷给最后一个 effect pass，组合键可能也带上，但 WPE 自带 effect 与语料 167 个工程的着色器里没有一处读 `ALPHATOCOVERAGE`，加不加结果相同。

### 核对（`p8-alpha`、`p8-a2c`、`p8-misc` 的已有抓帧与 rea-p8-render 第 4、5 节，语料 `ignore/p8/s5/`）

| 项 | 读码 / 实测 / 语料 | 结论 |
|---|---|---|
| 写掩码表 | rea-p8-render 4.4，`p8-alpha`、`p8-misc` W1 | 见下面点 3 的规则，表的每一行都覆盖 |
| A2C 的混合与深度 | 4.1、5.2–5.3：混合关、`AlphaToCoverageEnable` 开，不进「强制关深度写」那一档 | `blendState` 对不认识的模式已返回「不混合」，`rasterState` 已按 `normal` 算深度写，都不用改 |
| A2C 的阈值 | `p8-a2c`：alpha 0.4995 不画、0.5005 画，对象 alpha 0.5（锐化后最大正好 0.5）一列都没画 | 丢弃条件是 `!(a > 0.5)`（NaN 也丢） |
| 读 `ALPHATOCOVERAGE` 的着色器 | WPE `assets/shaders`：`genericimage3/4`、`clippingmaskimage4`、`generic3/4`、`genericparticle`、`genericropeparticle`、`shadowcaster*`、`base/model_fragment_v1.h`；`effects/` 下 0 个；语料 167 个工程 0 处 | 组合键按材质 pass 自己的混合加，图层、粒子、模型一样 |
| 语料的 A2C | 2 张：`3611425904` 的「提示模板2」没有 effect（直接上屏）；`3783690410` 的「水梓_裸足」挂 `xray`（基础 pass 进合成 RT、`xray` 的末 pass 上屏开 A2C），它另差 `effect:xray:pass:usertextures` | 两条路径语料里都有，都解锁不了 |
| 语料的 `alphawriting` | 6 张，全是 `cursorripple` 力场 pass 上的 `enabled`，画进 fbo | 画面不变 |
| 翻译器输出的片元入口 | `p8-a2c` 的导出（`ignore/p8/s5/out/dump.txt`）：`@fragment fn main(@location(0) …) -> FragmentOutput { …; main_1(); let _e25 = kb_FragColor; return FragmentOutput(_e25); }`，`struct FragmentOutput { @location(0) kb_FragColor: vec4<f32>, }` | 改写只认这两种返回（结构里 `@location(0)` 的成员，或直接 `-> @location(0) vec4<f32>`），认不出就报 `render:program:<下标>:a2c`、整张退回 |

### 现状锚点（HEAD `82653a66`）

**a. 能力表报这两项**（`compile/features.ts:65`、`:1147`、`:1196`）
```ts
  blending: ["normal", "translucent", "additive"], // 现状：alphatocoverage 报 blend:alphatocoverage
// …
function alphaWritingUsed(value: unknown): boolean {
  return active(value) && value !== "default"; // 现状：enabled / disabled 也报 material:alphawriting
}
// …
  if (alphaWritingUsed(pass.alphawriting)) unsupported.add("material:alphawriting");
```

**b. 编译不带组合键，`ScenePass` 不带 `alphawriting`**（`compile/bundle.ts:1518`、`:1581`）
```ts
    const result = shaderName
      ? await shader.compile(shaderName, pass.combos ?? {}, formats, scope, issues, defines, rope) // 现状：A2C 不加 ALPHATOCOVERAGE
      : null;
// …
    return {
      key: context.key,
      program,
      blending: pass.blending ?? "normal", // 现状：没有 alphawriting
      ...normalizeDepthKeys(pass),
```

**c. 写不写 alpha 只看目标、组与上屏角色**（`render/scene.ts:735`、`:752`）
```ts
export function stepPipeline(step: DrawLike, format, fboFormat, geometry = false, group = null, mesh?, sceneDepth = false): PipelineSpec {
  const { pass, blending, target, raster } = step;
  const inGroup = !!group && target.kind === "scene";
  const alphaMax = inGroup && !group.copyBackground;
  const upload = step.kind === "draw" && (step.role === "final" || step.role === "passthrough");
  return {
    program: pass.program!,
    blending,
    // …
    alpha: target.kind !== "scene" || alphaMax || (inGroup && !upload), // 现状：不看材质的 alphawriting
```

**d. 管线键与建管线没有 A2C**（`render/scene.ts:709`；`render/programs.ts:310`、`:337`）
```ts
  return `${program}|${blending}|${format}|${alpha}${topology === "triangle-list" ? "|list" : ""}${alphaMax ? "|max" : ""}…`; // 现状：没有 a2c
// programs.ts
      fragment: {
        module: program.fragment,
        entryPoint: program.result.fragment?.entryPoint ?? "main", // 现状：只有原入口
        targets: [{ format, blend, writeMask: writeAlpha ? 0xf : 0x7 }],
      },
```

### 点 1 — 规则（新文件 `render/writeState.ts`）

- **新增**
```ts
/** 材质 pass 的 `alphawriting`（rea-p8-render 4.3）：只有这两个取值改设备状态；`default` 与没写一样，编译期不写进 `ScenePass`。 */
export type AlphaWriting = "enabled" | "disabled";

/**
 * 一次绘制写不写 alpha（rea-p8-render 4.4 的表，p8-REPORT 结论 10、`p8-misc` W1）。`base` 是 `stepPipeline` 按目标、组与上屏角色算的
 * 缺省值；上屏角色不看材质（绑定后被强制改回）；组的 alpha MAX 强制写（状态 0x10 → 0xF）；其余 enabled 写、disabled 不写。
 */
export function writesAlpha(
  base: boolean,
  options: { upload: boolean; alphaMax: boolean; alphaWriting?: AlphaWriting },
): boolean;

/** 这一步开不开 alpha-to-coverage（rea-p8-render 第 5 节）：步骤的实际混合是 `alphatocoverage`。画进合成 RT 的基础 pass 混合是 null。 */
export function alphaToCoverage(blending: string | null): boolean;
```

### 点 2 — 编译（`compile/features.ts`、`compile/bundle.ts`）

- **修改** `SUPPORTED.blending` 加 `"alphatocoverage"`。
- **修改** `alphaWritingUsed`：只报 `default` / `enabled` / `disabled` 以外的取值（WPE 映射表只有这三个，别的值没查，语料 0 个）。
```ts
function alphaWritingUsed(value: unknown): boolean {
  return active(value) && value !== "default" && value !== "enabled" && value !== "disabled"; // 修改
}
```
- **修改** `ScenePass` **新增** `alphaWriting?: AlphaWriting`，`compilePass` 只在 `enabled` / `disabled` 时写。
- **修改** `compilePass` 编译着色器的组合键：混合是 `alphatocoverage` 时加 `ALPHATOCOVERAGE = 1`（先去掉大小写不同的同名键，翻译器按大写处理）。规则放 `compile/` 下的小函数，`bundle.ts` 只改调用。
```ts
    const result = shaderName
      ? await shader.compile(shaderName, materialCombos(pass), formats, scope, issues, defines, rope) // 修改
      : null;
```

### 点 3 — 管线（`render/scene.ts`）

- **修改** `PipelineSpec` **新增** `alphaToCoverage?: true`；`pipelineKey` 只在它为真时加 `|a2c`，其余键逐字不变。
- **修改** `stepPipeline`：
```ts
  const base = target.kind !== "scene" || alphaMax || (inGroup && !upload);
  return {
    // …
    alpha: writesAlpha(base, { upload, alphaMax, alphaWriting: pass.alphaWriting }), // 修改
    ...(alphaToCoverage(blending) ? { alphaToCoverage: true as const } : {}),      // 新增
```
- **修改** `pipelineFor` 把 `alphaToCoverage` 传给 `createPipeline`。

### 点 4 — A2C 入口（`render/programs.ts`）

- **新增** 纯函数，字符串层面改写，结构认不出时抛错：
```ts
/**
 * 给翻译出的片元 WGSL 追加 A2C 入口 `kb_a2c_<入口>`（rea-p8-render 第 5 节，p8-REPORT 结论 11）：原入口的逐字副本，每个 `return X;`
 * 换成「X 的位置 0 输出的 alpha 不大于 0.5（含 NaN）就 discard，否则返回 X」。原入口与主体不动。
 */
export function alphaToCoverageEntry(wgsl: string, entryPoint: string): { code: string; entryPoint: string };
```
- **新增** 按程序缓存的 A2C 片元模块（第一次建 A2C 管线时建，编译消息照 `checkModule` 检查，error 报 `webgpu:shader:<下标>:fragment-a2c:…`；改写抛错报 `render:program:<下标>:a2c`）。
- **修改** `createPipeline` 收 `alphaToCoverage`：为真时片元用 A2C 模块与入口，标签多一个 ` a2c`；为假时与改前逐项相同。

### 点 5 — 单测

- `compile/p8.test.ts`（步骤 5 的 describe，接在后面）：
  - 能力表：`alphawriting` 三个合法值都不报、`true` 等照报；A2C 不报；
  - `ScenePass.alphaWriting` 只在 `enabled` / `disabled` 时有；
  - A2C pass 的翻译请求带 `ALPHATOCOVERAGE = 1`（`source: "request"`），别的混合不带，材质里写了小写同名键时被换掉；
  - 真翻译器（带 `KABEGAME_WPE_ROOT`）：`genericimage4` 的 A2C 变体输出里有锐化（`fwidth`、`saturate`），A2C 入口改写成功。
- `render/p8.test.ts`：
  - `writesAlpha` 逐行对 4.4 的表（直接上屏、末 pass 上屏、passthrough、合成 RT 的基础 pass、fbo、`copybackground` 为 false / true 的组里）；
  - `stepPipeline` 在各角色与粒子、网格、文本上的 `alpha` 与 `alphaToCoverage`，没有这两项的步骤管线键逐字不变；
  - `alphaToCoverageEntry`：对导出的真实入口、直接返回 `@location(0)` 的入口、多个 `return` 的改写结果；找不到入口、结构里没有位置 0、已有 `kb_a2c_` 名字时抛错。
- **改的现有断言**（随设计）：`compile/p4a5.test.ts` 的 `enabled` / `disabled` 不再报；`compile/p5c.test.ts:271` 的 A2C 不再报。

### 实施方式

同前几步：子代理在 HEAD `82653a66` 的快照副本 `ignore/p8/s5/ov` 里做（`ignore/p8/s5/head` 是基线），我验收后按 HEAD 当时的版本逐文件三方合并到工作区，不碰暂存区。

### 验收

- 快照里 tsc 0 error，vitest 全过（基线就失败的照记），Prettier。
- `kbp regress --corpus`：回放案例全部相同；语料只去掉 `blend:alphatocoverage`（2 张）与 `material:alphawriting`，新出现的键逐张核对（预期没有）。
- 改写的覆盖面：语料与 WPE `assets/` 里全部片元程序都跑一遍 `alphaToCoverageEntry`，认不出的为 0。
- 画面（dev 宿主，和 WPE 抓帧逐像素比，屏蔽 FR / CLK）：
  - `p8-a2c`：三条渐变（A2C、translucent 对照、A2C + 对象 alpha 0.5）；
  - `p8-misc`：W2 那一条（步骤 4 时差在左半条）应该对上，其余照旧相同；
  - `p8-alpha`：写掩码按逐 draw 轨迹的管线 `writeMask` 对实测的表；画面上能看出差别的只有「合成 RT 的基础 pass `disabled`」那块（RT 里留着之前的 alpha），池化 RT 的分配和 WPE 不同时如实记下。
- 语料强制渲染 `3611425904`、`3783690410`：没有 WebGPU 校验错误，A2C 管线建成。
- 变异检查：
  - 不丢弃；
  - 阈值写成 `>=`；
  - 组合键不加；
  - 上屏角色看材质的 `alphawriting`；
  - `disabled` 在合成 RT 上不生效；
  - `enabled` 在场景目标上不生效；
  - 组的 alpha MAX 不强制；
  - 合成 RT 的基础 pass 也开 A2C；
  - 能力表仍报。

  单测或比图要能检出。

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

### 步骤 3 — 对齐（2026-11-13）

动工前补测了 `p8-align2`（见步骤 3 的补测表），定下三件读码没覆盖的事：效果矩阵按浮点 `size / 2`；文本的子层不带排版偏移；组的裁剪窗口跟着对齐偏。然后按提纲做，偏离四处：
- **对齐表放进新的小模块 `compile/alignment.ts`**（`ALIGNMENTS`、`alignmentIndex`、`alignmentName`），编译、状态、脚本共用，少碰 `features.ts`。
- **多报一个键 `object:alignment:script`**：图像层的 `alignment` 挂 `{script}`（字段脚本写回枚举）没有实现，WPE 怎么处理也没测，语料 0 个。
- **`setText` 只标本层**：原来标整棵子树（子孙跟着排版偏移）；新语义下子孙不带它，文本层也不会是组。
- **脚本值的形状**：没加新的值类型，API 层把字符串换成下标、写 `[下标]`，状态侧再校验一次（非法下标按 `center`）；重放表存同样的形状。

- **实现**：
  - 代理在 HEAD `3c4f723b` 的快照副本 `ignore/p8/s3/ov` 里做，16 个文件（新增 `compile/alignment.ts`）。
  - 我拷 `3c4f723b` 作基线 `ignore/p8/s3/head3`。`ignore/p8/s3/head` 是我前一次导出时 HEAD 的 `0633b0d8`，两次导出之间 HEAD 动过，不用它。
  - 验收后逐文件 `git merge-file` 合并到新 HEAD `ef16dcf1`（期间 P9b 步骤 0–1、P4f 步骤 0–1 提交）：15 个干净合并。`render/state.ts` 1 处冲突，P4f 改了粒子实例的写回（钳 `rate`），我在它后面加了对齐尺寸表，两边都留。没有碰暂存区。
  - 合并后 `worldMatrixOf` / `drawMatrixOf` 的调用点和快照里逐个相同，新提交没有新增调用点。
- **世界矩阵的调用点**：
  - 用 `drawMatrixOf`（图层画自己的矩阵）：`uniformValues` 的 `world`（直接上屏、基础 pass、effect、末 pass、passthrough、compose、文本）、组的局部正交。
  - 仍用 `worldMatrixOf`：粒子的预热、模型矩阵、控制点、编排，模型的视锥剔除，`particles/track.ts`。这些对象自己没有偏移，父层的偏移也不传下来。
- **改了的现有断言**：
  - `render/textState.test.ts` 的 `setText` 标脏从本层加子孙改成只有本层；
  - `render/text.test.ts` 三处期望矩阵改用 `drawMatrixOf`（都是根节点，期望值不变）；
  - `compile/p2a.test.ts` 的照报名单去掉 `object:alignment`；
  - `compile/p8.test.ts` 步骤 2 的「中性」用例里图像层 `alignment: "bottom"` 不再报。
- **快照验收**：tsc 0 error；vitest 2501 个用例 1 个失败（`pipeline.test.ts` 的请求次数上限，`3830255100` 219 次，基线同样失败）。
- **回归**（`kbp regress --corpus`，`ignore/p8/s3/regress`）：
  - 回放案例两边逐字节相同。新案例 `f1`（别的会话加的）两边同样有失败、逐字节相同，与本步无关。
  - 语料只去掉 `object:alignment`（24 张）和 `script:api:layer.alignment`（3 张：`3577990983`、`3643916956`、`3660962877`），没有新增的键。
  - 干净 57 → 57（这期间别的步骤已把干净场景推到 57）。`3812487163` 还差 P6 的 `thisScene.createLayer` / `sortLayer`，这一步解锁不了；总计划「解锁 `3812487163`」是按 P4–P7 先做完的口径算的。
- **四角**（`ignore/p8/s3/corners/`，产品代码按执行顺序算每次图像绘制，组展开子树，对 RenderDoc 的 `vs_out` 与 MVP）：
  - `p8-align` 两帧各 56 次、`p8-align2` 13 次，四角最大差 1.9e-4 像素（限值 0.01）。
  - 组 G 的 compose 基础 pass 只比 MVP：composelayer 着色器按纹理坐标铺满合成 RT，不用 MVP 摆顶点。MVP 与 WPE 相同，差 < 1e-4。
  - 画进合成 RT 的 `fill` 基础 pass 的 MVP 写法和 WPE 不同（WPE 用 0–64 的四边形配自己的正交），四角相同，是 P2a 起就有的写法。
- **变异**（`ignore/p8/s3/mutations.py`，快照模式）：left / top 的正负号、偏移不截断、四边形不截断、效果矩阵截断、子层带父层偏移、自身绘制不带偏移、组的局部正交不带偏移、`{user, value}` 按字符串求、脚本写数字不落 `center`、能力表仍报字符串取值，11 处全部被单测检出，按原字节还原。
- **工作区验收**：tsc 0 error；vitest 2611 个用例 1 个失败（`pipeline.test.ts` 同上）；Prettier 通过。
- **画面**（dev 宿主按 `--mode development` 重建后渲染，屏蔽 FR / CLK，和 WPE 抓帧比）：
  - `p8-align` 最大差 1。日志里交错着另一个窗口的 `[kbp]` 行，按线程号取一份。
  - `p8-align2` 只有 F1 内部一行差 > 8（最大 11），在 kbmark 上下两色的交界：F1 直接上屏、竖直方向从 64 缩到 50，基础纹理 WPE 用 8 倍各向异性、我们用线性（p8-REPORT 记过的差异），四角相同。
    - 文本子层 Xc 落在文本原点 (490–510, 570–590)，和 WPE 相同（改前在 (564–584, 658–678)）。
    - 组 G 的子层只露出右上四分之一，和 WPE 相同。
  - `p8-par` 的 D（深度 0、`top`）对上了；唯一不同的是 T：WPE 里脚本在第 8 帧把它改成 `center`，探针不跑脚本，停在 JSON 的 `top`。脚本另在应用的预览里实测（用户同意占用预览；屏外宿主不跑帧循环）：脚本跑满 495 帧后 T 的对齐是 `center`、偏移清空，D 仍是 `top`；脚本日志 `align before top string`、`align after bottomright`、`align number center string` 和 WPE 逐字相同。单测另覆盖同帧生效、重编译后重放。

### 步骤 4 — 图层依赖（2026-11-13）

按提纲做，偏离与补充：
- **粒子对象的 `dependencies`**：只在有不是数字的元素时报 `particle:dependencies`（`hasNonNumericDependency`）。纯数字的照样进并集、和别的对象一样中性，粒子那套 `{id, type, …}` 元素是发射图与碰撞模型，没做。
- **id 只认非负整数**（`jsonId`）：WPE 的 id 与 `dependencies` 元素都按 64 位无符号整数取，别的写法不进名字表、不算被依赖。id 重复时名字表里后面的胜出（WPE 后建的 RT 再次接管同名对象）。
- **名字表只收走 `compileImageModel` 的对象**（`isImageLayerObject`，判定与对象循环逐条一致）：形状、文本、模型、粒子、声音的 `_a` 名字都绑棋盘格；文本被依赖另报 `dependency:text`。
- **引用方所属的对象从 pass 的稳定键里取**（`passObject`），`dependency:self` 与 HDR 格式规则用它；泛光等不属于对象的 pass 为 null。
- **注解 `default` 写的名字**同材质 `textures` 的解析规则，但不加 `TEX<n>FORMAT`：着色器那时已经编好，同注解缺省的静态纹理。
- **奇偶对调只对被依赖的图层做**：只有 colorBlendMode 混合、没被依赖的图层照旧（它的合成 RT 没人按名字读，起点不影响画面）。
- **`host.ts` 的 `visibleVideoTextures` 不改**：隐藏的被依赖图层上的视频纹理不进「等第一帧」的名单，语料没有这种。

- **实现**：
  - 代理在 HEAD `187f41c9` 的快照副本 `ignore/p8/s4/ov` 里做，7 个文件（新增 `compile/dependencies.ts`；`compile/bundle.ts`、`compile/features.ts`、`render/graph.ts`、`render/scene.ts` 与两个 `p8.test.ts`），没有改现有断言。
  - 我验收后逐文件 `git merge-file` 三方合并到工作区，没有碰暂存区。工作区里 `bundle.ts`、`features.ts`、`scene.ts` 混着别的会话没提交的改动（P10a 关键帧、P4f）。
  - 画面验收时 HEAD 已到 `1616bb2b`（P9b 步骤 2–3、P4f 步骤 3），工作区又有别的会话没解决的合并冲突（`dev/particleCorners.ts`），不能从工作区构建宿主。改在 `ignore/p8/s4/build` 里导出 `1616bb2b`、同样三方合并这 7 个文件（全部干净），tsc 0 error，从这里按 `--mode development` 构建 dev 宿主。
  - 之后 HEAD 到 `c92f5b5c`（P5d 步骤 2，改了 `render/graph.ts`、`render/scene.ts`），提交用的版本在 `ignore/p8/s4/build2` 重新合并：5 个干净，2 处冲突都是相邻改动、两边都留（`ignore/p8/s4/resolve2.py`）：
    - `bundle.ts`：P5d 把 `orthographic` 的声明挪到前面、原处只留一行注释，依赖表与棋盘格放在这行注释之前，不再重复声明；
    - `graph.ts`：奇偶对调照留，`compositeSize` 用 P5d 新加的 `sceneSize`。

    合并后 `graph.ts`、`scene.ts` 和工作区逐字节相同，`bundle.ts`、`features.ts` 只差别的会话没提交的改动（P10a 步骤 3、P6b 1e-3）。
- **快照验收**：
  - `187f41c9` + 本步：tsc 0 error；vitest 2812 个用例 1 个失败（`pipeline.test.ts` 的请求次数上限，`3830255100` 219 次，基线同样失败）。
  - `c92f5b5c` + 本步（`build2`）：tsc 0 error；vitest 2935 个用例，同一个用例失败，失败项多了 `2251857160` 的两条：快速路径 404 次请求（上限 200）、读取 73,995,846 字节（上限 64 MiB）。
    - 逐条记了请求（`ignore/p8/s4/reqdiag.test.ts` → `out/reqdiag-*.json`）。基线 `c92f5b5c` 4 次就停在 `object:dependencies`；本步去掉这个键之后，要一路编到 P10a 的临时键 `value:animation:pending` 才停。
    - 404 次请求（161 次是「散文件 → pkg → assets」逐级查找的未命中）路径与区间全不重复，多出来的是资源本身。
    - 照 P4b（同样的原因 150 → 200）放宽，用户定（2026-11-14）：请求上限 200 → 450、读取上限 64 → 80 MiB，另加「同一路径、同一区间不请求第二次」的断言（`FetchTally.repeated`），这才是上限原本要守的东西。P11a 的计划要把同一行改成 240，后提交的一方合并。改后语料用例 16 个全过（`3830255100` 的 219 次也在上限内了）。
- **回归**（`kbp regress --corpus`，`ignore/p8/s4/regress`）：
  - 回放案例两边逐字节相同。新案例 `f3`（别的会话加的）两边都跑不下去，与本步无关。
  - 语料只去掉 `object:dependencies`（9 张）与 21 个 `texture:rendertarget:_rt_imageLayerComposite_<id>_a`（9 张，比计划多 `3509243656`：它的两个模型材质读 `_a`，见核对表），没有新增的键。干净 66 → 66，这 9 张都还差别的节。
- **变异**（`ignore/p8/s4/mutations.py`，快照模式）：
  - 我的 15 处：
    - 不对调奇偶；
    - 不可见时连上屏一起画 / 整层跳过；
    - `buildableLayers` 不收；
    - 最后一个 effect 仍上屏；
    - 上屏不看 cbm 31；
    - 组合层没有 effect 时整层不画；
    - 并集漏掉模型对象列的；
    - `_b` 也解析；
    - 棋盘格换成透明；
    - HDR 格式恒取 14；
    - `BLENDMODE` 恒取 cbm；
    - 组画子树时按可见性跳过；
    - 独占 RT 不当合成 RT 0；
    - 能力表仍报 `dependencies`。

    全部被单测检出，按原字节还原。代理自己的 19 处同样全部检出。
- **工作区验收**：tsc 0 error；vitest 2814 个用例 1 个失败（`pipeline.test.ts` 同上）；Prettier 通过。
- **画面**（dev 宿主按上面的快照构建，测试工程导入 dev 库，测完用 `projects_remove` 移除）：
  - `p8-dep`：`render_scene` 按日志回放到第 160 帧，除 B3 外和 WPE 逐像素相同（屏蔽 FR / CLK）。
    - B3 排在被依赖者前面，WPE 画的是上一帧：第 159 帧的值 (246, 8, 127)，第 161 帧是 (17, 8, 127)，正好等于第 160 帧 A2 的颜色。
    - 回放只编码读回那一帧，独占 RT 还是空的，B3 是黑的（差 40000 像素，正好是 B3 那块 200×200）。这是探针的限制，产品每帧都画。
    - 改用探针的 `profile: 1` 在第 159 帧的时刻先编码一帧，再按第 160 帧的 dt 与时刻读回：B3 整块 (246, 8, 127)，和 WPE 相同；和不先编码那一帧的读回相比，差异只在 B3 那块。
  - `p8-dep2`：回放到第 158 帧，和 WPE 整帧 0 差异（A9 无 effect、A10 可见性绑属性、A11 隐藏带两个 effect、两个引用方读同一个 A12）。
  - `p8-misc`：回放到第 155 帧，差异只在 (588, 180)–(1100, 280)，正好是 W2（alphatocoverage）的左半条，归步骤 5；A13（隐藏的组合层）、A14（隐藏、在画面外）的引用方和 W1 逐像素相同。
  - 语料强制渲染（屏外宿主，`profile: 2` 让排在前面的引用方读到内容，`requestDevice` 临时挂 `uncapturederror` 监听，用完还原）：
    - `2251857160`、`3554161528` 渲染完成，没有校验错误。
    - `3243449890` 建管线失败：工坊 effect `auto_sway`（不在被依赖的图层上）的顶点输出超过 WebGPU 的 16 个阶段间变量。我们没有处理这个上限，和本步无关；它的被依赖者 16613 没有 effect，步骤 4 不会让它多建这个管线。
    - 结构相同的 `3276911872`、`3351072238` 当时卡在屏外宿主等视频第一帧（10 s 超时）。之后屏外宿主的 frame 改成可见（`host_open` 报 `frameVisibility: visible`），2026-11-14 用工作区构建的宿主（带本步）重试 `3276911872`：
      - 5.7 s 渲染完成，视频纹理出了第一帧，没有校验错误；
      - 4 个引用方的 `visible` 绑在用户属性上、缺省 `false`，渲染时把这 4 个属性打开，用探针的逐 draw 轨迹（`renderFrame` 的 `trace`）核对：
        - 写死隐藏的被依赖者 16613（组合层）在 pass 7 画进 `_rt_imageLayerComposite_16613_a`（1920×1080，`load`），不上屏；读回这张 RT，整张不透明、平均色 (137, 120, 168)，是组合层拷下来的背景；
        - 4 个引用方的末 pass 槽 1 都绑这张 RT；不开属性时这 4 个 draw 都不出现（36 → 44 个 draw）；
        - 整帧没有 draw 绑棋盘格。
      - 开不开这 4 个属性，最终画面逐字节相同：引用方的 `clipping_mask` 另有一个 `usertextures` pass 没实现（照报 `effect:clipping_mask:pass:usertextures`，那一槽绑白图占位），画出来是透明的，和依赖无关。
  - 引用方绑没绑上，改在快照里静态核对（`ignore/p8/s4/s4corpus.test.ts` → `ignore/p8/s4/out/corpus-bind.json`）：9 张有依赖的场景，被依赖者 23 个，读独占 RT 的 pass 45 个（46 个槽，同核对表的 44 + 2），没有一个绑棋盘格，没有 `dependency:*` 键。
- **没和 WPE 比的**：`3509243656` 的模型网格读 `_a`，这张场景还差别的节；语料场景都没逐像素比。

### 步骤 5 — 写入状态（2026-11-14）

按提纲做，偏离与补充：
- **`ENGINE_COMBOS` 去掉 `ALPHATOCOVERAGE`**（计划漏了）：不去掉的话，每个 A2C 程序都会因为编译期加的组合键报 `combo:ALPHATOCOVERAGE`，语料那 2 张会换个键继续退回。去掉后，材质自己写这个组合键、而混合不是 A2C 时也不再报：这时着色器只锐化、不丢弃，和 WPE 在 D3D11 下（`GLSL` 为 0）相同。语料回归核对过，没有场景因此少报这个键。
- **`PARTICLE_COMBOS` 加上 `ALPHATOCOVERAGE`**：否则粒子 A2C 会改报 `particle:combo:ALPHATOCOVERAGE`，「粒子同一规则」落空。语料粒子 A2C 0 处。
- **A2C 模块的缓存挂在 `GpuProgram` 上**：`createProgram` 给程序挂一个 `alphaToCoverage()`，第一次调用时改写、建模块、检查 Tint 消息，之后返回同一个 Promise（失败的也缓存）；没有另做缓存表。改写失败报 `render:program:<下标>:a2c`，原因另写进 warnings。
- **`AlphaWriting` 类型定义在 `compile/writeState.ts`**（`passAlphaWriting`、`materialCombos` 也在这里），`render/writeState.ts` 只转出类型，compile 目录仍然不依赖 render。
- **改写的写法**：每个 `return X;` 换成 `{ let kb_a2c_out = X; if !(… > 0.5) { discard; } return kb_a2c_out; }`；`@fragment` 与 `fn` 之间允许夹别的属性；位置 0 的输出要是 `vec4<f32>` 或 `vec4f`。
- **真翻译器用例的断言**：翻译器把 `saturate` 展开成 `clamp(…, 0f, 1f)`，用例断言 `fwidth` 加这条 clamp 锐化表达式。
- **没改的两处**：泛光材质的编译路径（WPE `assets/materials` 里没有材质用这两个键）；`particleDefines` 里只读注解的探测编译仍用材质原来的组合键（只读槽 0 的注解，和组合键无关）。

- **实现**：
  - 代理在 HEAD `82653a66` 的快照副本 `ignore/p8/s5/ov` 里做：
    - 新增 `compile/writeState.ts`、`render/writeState.ts`；
    - 改 `compile/features.ts`、`compile/bundle.ts`（只有导入、`ScenePass` 字段与两处调用）、`render/programs.ts`、`render/scene.ts`；
    - 单测加在两个 `p8.test.ts` 末尾；
    - 现有断言只改了计划列出的两处（`p4a5`、`p5c:271`）。
  - 我验收后逐文件 `git merge-file` 三方合并到工作区（HEAD 仍是 `82653a66`），8 个文件全部干净合并，没有碰暂存区。工作区里 `bundle.ts`、`features.ts`、`scene.ts`、`render/p8.test.ts` 混着别的会话没提交的改动。
- **快照验收**（Claude 自跑）：tsc 0 error；vitest 127 个文件、3082 个用例全过；Prettier 通过。
- **工作区验收**：tsc 0 error；本步相关的 4 个测试文件 225 个用例全过。
- **回归**（`kbp regress --corpus`，`ignore/p8/s5/regress`）：
  - 回放案例两边逐字节相同（`e4` 两边同样失败、报告相同，基线就有）；
  - 语料只去掉 `material:alphawriting`（7 张，比计划多 `3498150384`：它挂在文本对象的 effect 上，文本 effect 现在会编译了）与 `blend:alphatocoverage`（2 张），没有新增的键；
  - 干净 87 → 87。
- **改写的覆盖面**：
  - 我的扫描（`ignore/p8/s5/sweep.test.ts` → `out/sweep.json`）：语料与 WPE 默认工程 179 张场景编出的 522 个不同的片元程序，全部改写成功，返回都是结构形态。
  - 代理的扫描（`out/a2c-coverage.json`）：WPE `assets/` 下 127 对着色器，在缺省组合键与 `ALPHATOCOVERAGE=1` 下翻译成功的 236 份同样全部成功。
- **变异**（`ignore/p8/s5/mutations.py`，快照模式，Claude 写的 11 处）：
  - 不丢弃；
  - 阈值 `>=`；
  - 不加组合键；
  - 上屏角色看材质；
  - 组的 alpha MAX 不强制；
  - 混合为 null 也开 A2C；
  - 所有管线都用 A2C 入口；
  - 能力表仍报 A2C；
  - `ScenePass` 不带字段；
  - 管线键不区分 A2C；
  - `enabled` 不生效。

  全部被单测检出，按原字节还原。代理另做的 10 处同样全部检出。
- **画面**：
  - **宿主**：盘上的 dev 宿主是别的会话用工作区新编的翻译器 wasm 建的。为了不把它换回旧翻译器，我导出工作区现状（`ignore/p8/s5/wt`），三方合并本步后 tsc 0 error，从这里按 `--mode development` 构建。测试工程导入 dev 库，测完用 `projects_remove` 移除。
  - **比图**（按日志回放，和 WPE 抓帧逐像素比）：
    - `p8-a2c` 第 162 帧：三条渐变逐像素相同，只有右下角 CLK 时钟图层有 4800 个像素差 1（测试工程约定屏蔽）；
    - `p8-misc` 第 155 帧：整帧 0 差异（步骤 4 时差在 W2 左半条）；
    - `p8-alpha` 第 158 帧：Y（直接上屏）与 Z（合成 RT 的基础 pass，含 `disabled`）六块逐像素相同；X 三块（两 pass 的 effect 画进 fbo）我们是 (64, 64, 64)、WPE 是黑。原因是测试工程自写的 fbo pass 顶点乘了 MVP（步骤 0 的失误），我们的中间 pass 按 P2a 的做法用 NDC 四边形、MVP 单位阵，照样铺满 fbo、写进 alpha 0.25；WPE 那边落到 fbo 外、一个像素都没画。三种取值结果相同，和写掩码无关。WPE 自带的 effect 中间 pass 都不读这个矩阵。
  - **写掩码**：用探针的逐 draw 轨迹读每次绘制的管线状态，`p8-alpha` 的 X / Y / Z 三组九种、`p8-misc` 的 W1 / W2、`p8-a2c` 的三条全部对上 p8-REPORT 的实测表（fbo 15 / 15 / 7，直接上屏 7 / 15 / 7，合成 RT 基础 pass 15 / 15 / 7，上屏 pass 一律 7；A2C 上屏混合关、7、走 A2C 入口，画进合成 RT 的基础 pass 混合关、15、不走），整帧没有校验错误。
  - **语料强制渲染**（屏外宿主，`requestDevice` 临时挂 `uncapturederror` 监听，用完还原）：
    - `3611425904`：图层基础材质直接上屏；
    - `3783690410`：`xray` effect 的末 pass 借基础材质的混合上屏，A2C 入口对 effect 程序同样成立。

    两张都渲染完成、A2C 管线建成，没有校验错误。
- **没覆盖的**：组的 alpha MAX 与 A2C 并存、粒子 A2C（语料都是 0 张）只有单测；`msaa: x2` 的 A2C 不做（WPE 缺省 `x2`，我们没有多重采样，本来就对不上）。
