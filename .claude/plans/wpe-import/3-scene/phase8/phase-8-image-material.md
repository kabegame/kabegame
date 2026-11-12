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
- 文本对象的 `clampuvs`、对齐（`horizontalalign` 等）：P6b。脚本 `layer.alignment` 原在 P6 的 API 名单里，步骤 0 查到语料 3 张都写在图像层上，挪进步骤 3（见实施记录）。
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
