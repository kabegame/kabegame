# P5b — 图像模型标志（子计划）

> 上级：[phase-5-camera-mesh.md](phase-5-camera-mesh.md)「P5b」。读码见 [rea-p5-modelflags](rea-p5-modelflags.md)（全部没有实测），图像层 `perspective` 另见 [rea-p5-camera](rea-p5-camera.md) 与 P5a 的实测（[p5-REPORT](p5-REPORT.md)）。
> 语料是 2026-11-12 在 `306d0e8b` 上重扫的结果（`ignore/p5/b0/corpus-head.json`，173 个场景，能渲染 39 张），按对象细分在 `ignore/p5/b0/out/scan_b.txt`（`scan_b.py`）。
> 现状锚点取自 `306d0e8b`。P6、P7 在别的会话进行，也改 `compile/features.ts`、`compile/bundle.ts`、`render/scene.ts`；每个实现步骤动工前再核对一次共享文件，并行期在 HEAD 快照里实现再三方合并。
> 分步：步骤 0 只调研；步骤 1–5 每步能单独验收、单独提交，各步的现状锚点、点和验收在步骤 0 之后补全（同 P5a 的做法）。

## 总体设计思路

P5b 的六个标志都作用在图像层上，不新增图层种类，改的是一个图像层「画什么、画多大、画到哪」。按改动的深浅分三类。

**只改编译期的量。** `nopadding` 只改上屏四边形的 UV 内缩条件；`autosize` 改尺寸的来源顺序（WPE 在纹理就绪时用它覆盖对象 `size`，不是「`size` 缺失时才生效」）；`projectlayer` 让尺寸取 `orthogonalprojection` 的宽高；`instanced` 在编译材质之前把对象的 `instance`（`textures`、`combos`）合进材质 pass，合成 RT 仍按纹理图像尺寸（`util/white` 是 32×32）。这几项都在 `bundle.ts` 和 `graph.ts` 的现有函数里加条件，渲染器不动。

**只改一次绘制的矩阵。** 图像层 `perspective: true` 在上屏那一下把视图投影换成透视（和透视粒子同一个函数），合成 RT 里的 pass 不受影响。`fullscreen` 的上屏换成单位矩阵加 NDC 正交，几何是 2×2 的 NDC 四边形，`origin`、`scale`、`angles`、视差、抖动都不起作用；带 effect 时不画基础材质，合成 RT 0 直接整张拷贝当前目标。这两项落在 `planLayer` 的步骤角色和 `drawMatrices` 上，和 P5a 加视差偏移是同一个位置。

**组合层是唯一的结构变化。** passthrough 模型（`composelayer` / `composelayer_depthtest` / `fullscreenlayer` / `projectlayer`）是一个「组」：它的所有子孙不在顶层画，由它按先序画进自己的合成 RT，遇到嵌套组合层停止下探；画子孙时模型乘 `inverse(W_组)`、视图为单位阵、投影是层的局部正交 `±w/2, ±h/2, ±1000`，层矩形外的部分自然裁掉。组的基础 pass 按 `copybackground` 分两种：true 用 composelayer 着色器把层背后的快照透视正确地铺进合成 RT；false 清成 (0, 0, 0, 0)，子层画进去时写 RGBA、alpha 取 MAX。之后照常跑 effect 链、借基础材质的 blend 上屏；没有 effect、没有子层、`colorBlendMode` 是 0 或 31 时整层不画。

渲染器现在每帧按 `layers` 平铺地跑每个图层的 ops（`GpuScene.encode`）。组合层不改这个形状，只改两处：编译期给每个图层算出「归属的组」，顶层循环跳过被组代画的图层；组的计划里在基础 pass 之后插一个 `subtree` 步骤，展开成子孙的 ops，目标改成组的合成 RT、矩阵按组的局部坐标系每帧现算。子孙自己带 effect、粒子、快照的规则都在组的上下文里照常走，只是「场景目标」换成组的合成 RT。

**关键决策：**
- **组合层分两步做。** 语料 219 个 passthrough 对象里只有 12 个带子层，另有 3 个嵌套在别的组里；其余都没有子层，最多的是「有 effect、无子层」的 composelayer（112 个）和 fullscreenlayer（38 个）。没有子层时组就是「背景快照 → effect 链 → 世界四边形上屏」，不碰顶层循环，先做；带子层的子树归属、局部正交、alpha MAX、嵌套放在后面单独一步。
- **能实测的不读码。** 读码已经给出流程，步骤 0 的主体是确定性工程加 WPE 抓帧，逐条核对读码和它标了【推】的地方（无 effect 带子层的组直接上屏会拉伸、fullscreen 走拷贝路径时拿到上一层的颜色、`_rt_FullFrameBuffer` 的尺寸、图层 `perspective` 和视差的先后）。抓帧解决不了的才派 REA 代理补读。
- **能力表照旧是唯一事实来源。** `model:passthrough` 等按实现进度细分出键，没实现的形态照报、整张退回。`instance.usertextures`（`$mediaThumbnail`、用户属性纹理、`usershortcut`）属于材质系统和媒体集成，照报 `material:usertextures`。

## 范围与解锁

| 步骤 | 内容 | 用到的场景 |
|---|---|---|
| 0 调研 | 语料细分（已做）、确定性工程与 WPE 抓帧、必要时补读码 | — |
| 1 尺寸、UV 与透视图层 | `nopadding`；`autosize` 的优先级（含 `projectlayer` 的尺寸来源）；图像层 `perspective` | `nopadding` 40、`perspective` 5 |
| 2 组合层：无子层 | `copybackground` 两种基础 pass、effect 链、上屏；不画的情况；`colorBlendMode` 混合上屏；`projectlayer` | 68 中的大部分 |
| 3 `fullscreen` | 拷贝当前目标的合成路径、NDC 上屏；无 effect 的 2×2 四边形（neon_sunset 的 `cloudsbg`） | 27 |
| 4 组合层：子层 | 子树归属、局部正交、alpha MAX、无 effect 带子层的直接上屏、嵌套、组里的粒子 | 12 个对象 |
| 5 `instanced` | 实例材质（`textures`、`combos`），合成 RT 按纹理尺寸 | 30 |

键的场景数（`keys_b.py`）：`model:passthrough` 68、`model:nopadding` 40、`model:instanced` 30、`model:fullscreen` 27、`model:projectlayer` 12、`object:perspective` 5。

**解锁：** 只有 `1923929928`（只差 `object:perspective`，步骤 1）。P5b 主要是清键：去掉这六个键后只差 1–2 项的场景有 6 张，剩下的都归别的阶段——`3822149301`、`3824550659`、`3828359750` 差 `tex:video`；neon_sunset 差透视与网格（P5d）；`1333579536` 差 `particle:children`（P4f）；`3502090109` 差 `cull:normal`（P5d）和一个翻译错误（P7c）。

语料细分（对象数，`scan_b.txt`）：
- **passthrough 219 个**：
  - composelayer 有 effect、无子层 112 个（`copybackground` 缺省即 true 的 91 个，显式 true 14 个，false 7 个；`colorBlendMode` 非 0 / 31 的 5 个）；无 effect、无子层 21 个，WPE 整层不画；带子层 11 个（`copybackground: false` 2 个，`colorBlendMode 21` 1 个）；嵌套在别的组里的 3 个（都没有子层）；
  - composelayer_depthtest 1 个，带子层，在透视场景（归 P5d 的深度）；
  - fullscreenlayer 49 个，有 effect 38 个；
  - projectlayer 25 个，有 effect 6 个，`colorBlendMode` 非 0 / 31 的 3 个。
- **`fullscreen` 非组合层 1 个**：neon_sunset 的 `cloudsbg`（透视场景，归 P5d 才能验收，步骤 3 用确定性工程验）。
- **`nopadding` 72 个**，有 effect 28 个。
- **`instanced` 167 个**：
  - `instance` 只有 `combos`、`textures`：88 个，其中有 effect 11 个；`combos` 全是 `{"version": 2}`，`textures` 大多是 `util/white`；
  - 带 `usertextures`：79 个（`$mediaThumbnail` 系统纹理、用户属性纹理、`usershortcut`），照报。
- **图像层 `perspective` 6 个对象 5 张**：`1923929928` 的 `grid` 带 3 个 effect、x 轴转 −75°；`3146703458` 的多边形只有很小的 z 旋转。
- **`autosize` 的优先级**（`autosize_b.py`，不含 `instanced`、`fullscreen`）：同时写了 `autosize` 和 `size` 的 1514 个对象里，取图像尺寸的 1433 个、取正交投影的 25 个（projectlayer），`size` 和 WPE 的取值全部一致；取精灵表帧尺寸的 56 个在 14 张场景里，这些场景全都另报 `tex:animation`（图像层帧动画，P6），没有一张能渲染。不写 `autosize` 的 518 个对象两边取值也一致。所以改优先级对现有场景是中性的，精灵表的帧尺寸跟图像层帧动画一起做。

**P5b 不做：**
- `composelayer_depthtest` 的深度测试、透视场景里的透明排序（`0x200` 的 −∞ 排序键）：P5d。正交场景按列表顺序画，排序键不起作用。
- `instance.usertextures` 与材质的 `usertextures`：照报 `material:usertextures`。
- 透视场景里的 `projectlayer`（正交投影为空时尺寸来源读码未知，语料 0 个）。
- 对象 `alignment`（24 张）：不在这一节，照报 `object:alignment`。

## 现状锚点

**a. 能力表：五个模型标志照报，图像层 `perspective` 照报**（`compile/features.ts:204`、`:221`、`:539`）
```ts
const OBJECT_FLAGS = ["perspective", "fullscreen", "passthrough", "attachment", /* … */]; // 现状：perspective 为 true 报 object:perspective
const SUPPORTED_MODEL = new Set(["material", "width", "height", "autosize", "solidlayer", "cropoffset"]);
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const [key, value] of Object.entries(model)) {
    if (SUPPORTED_MODEL.has(key)) continue;
    // 现状：fullscreen、nopadding、passthrough、projectlayer、instanced 为 true 时报 model:<键>
    if (MODEL_FLAGS.has(key) ? modelFlag(model, key) : active(value)) unsupported.add(`model:${key}`);
  }
```

**b. 尺寸来源：对象 `size` 优先，缺失时才看模型宽高、再看纹理**（`compile/bundle.ts:1068`、`:1081`）
```ts
    layer.solidLayer = modelFlag(model, "solidlayer") && !modelFlag(model, "instanced");
    // …
    if (!layer.size.length) {   // 现状：WPE 是 autosize 在纹理就绪时覆盖 size；三者都缺时 WPE 是 1×1，这里取纹理尺寸
      const base = layer.passes[0]?.textures[0];
      const texture = base === undefined ? undefined : bundle.textures[base];
      layer.size =
        model.width && model.height
          ? [model.width, model.height]
          : texture
            ? [texture.width, texture.height]
            : [model.width ?? 0, model.height ?? 0];
    }
```

**c. 合成 RT 尺寸与 UV 内缩**（`render/graph.ts:94`、`:195`）
```ts
export function compositeSize(layer: Pick<SceneLayer, "size" | "solidLayer">, texture: TextureSize | undefined) {
  const [w, h] =
    texture && !layer.solidLayer ? [texture.width, texture.height] : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  return [Math.max(4, Math.round(w)), Math.max(4, Math.round(h))]; // 现状：没有 fullscreen（帧缓冲尺寸）、组合层（size）的分支
}
  // WPE 的 `nopadding` 只关直接上屏这一块，`fullscreen`、`passthrough` 模型两块都关；这三个现在都报不支持
  const screenInset = layer.solidLayer ? NO_INSET : uvInset(layer.size, baseTexture); // 现状：direct 与 final 共用一个内缩
```

**d. 合成路径：基础 pass 关混合画满合成 RT，effect 链，最后一个 effect pass 上屏**（`render/graph.ts:243`）
```ts
  steps.push({
    kind: "draw", role: "base", pass: base, effect: null,
    target: nextComposite(),
    geometry: "fill",   // 现状：组合层的 composelayer 基础 pass 也会走这里，铺满合成 RT 但矩阵不对（WPE 用 W 与场景相机）
    uv, inset: NO_INSET, blending: null,
  });
  // 现状：没有「不画基础材质、整张拷贝当前目标」（fullscreen）、「清成透明」（copybackground: false）两种基础 pass
```

**e. 每帧平铺地跑每个可见图层的 ops**（`render/scene.ts:1976`）
```ts
    // 不可见图层整段跳过（含它的快照与 copy / swap）；运行时可见性由 `SceneState` 决定（P3a）
    const visible = new Set(visibleObjects(this.layers, state));
    for (const layer of this.layers) if (visible.has(layer.object)) runOps(layer.ops); // 现状：没有「由组代画、顶层跳过」
```

**f. 画到场景目标不写 alpha，场景目标清成 alpha 1**（`render/programs.ts:289`、`render/scene.ts:1907`）
```ts
        targets: [{ format, blend: blending ? blendState(blending) : undefined, writeMask: writeAlpha ? 0xf : 0x7 }],
              clearValue: { r, g, b, a: 1 },   // 现状：和 P5a 实测的 WPE 写掩码 7 一致；组里写 RGBA、alpha 取 MAX 的状态还没有
```

**g. 透视矩阵只给粒子**（`render/layout.ts:230`）
```ts
export function particleViewProjection(general: Pick<SceneGeneral, "width" | "height" | "perspectiveOverrideFov">, zoom = 1): Mat4 {
  // 现状：相机在 (w/2, h/2, d)，z = 0 平面和正交画面重合；图像层还不用它
```

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

`ignore/p5/b0/keys_b.py` 数键、`scan_b.py` 按对象细分、`autosize_b.py` 比尺寸来源，结论见上「范围与解锁」。输出在 `ignore/p5/b0/out/`。

### 0b — 确定性工程与实测（Claude）

工具同 P5a：
- 工程由 `ignore/p5/b0/gen_b.py`（kbp gen，FR / CLK 层）生成，放在 `ignore/p5/proj/p5b-*`；
- `wpe-renderdoc` MCP 抓帧，放在 `A:\p5b\<用途>\`，窗口 1920×1080，`_rt_FullFrameBuffer` 的尺寸另用 1344×756 窗口；
- 读数用 `ignore/p5/a0/rdc_dump.py` 的导出（常量、管线状态、RT 尺寸），整帧比用 `kbp rdc frame`。

不移动用户的鼠标；和指针有关的只有 `p5b-persp` 的视差一项，开着 `cursor=True` 的逐帧光标日志。

| 工程 | 构造 | 核对 |
|---|---|---|
| `p5b-nopad` | 1920×1080 的 NPOT 纹理（不补边）1:1 铺满；模型写与不写 `nopadding`，各有无 effect（alpha 1 的 opacity） | 无 effect 时不内缩；有 effect 时末 pass 照旧内缩 0.15 texel |
| `p5b-autosize` | 普通模型加 `autosize`，对象 `size` 写成图像尺寸的一半；再去掉 `autosize`、模型宽高、对象 `size` | `autosize` 覆盖 `size`；三者都缺时 1×1 |
| `p5b-persp` | 图像层 `perspective: true`，x 轴转 −75°，有无 effect 各一；`perspectiveoverridefov` 取缺省与 30；另开视差、`zoom 1.5` 各一 | 上屏用透视、合成 RT 里不用；透视和视差、缩放的先后 |
| `p5b-cl` | composelayer `size` 800×400、`origin` (700, 600)、`angles` z = 0.4，挂 tint；`copybackground` true / false；再去掉 effect；再改 `colorBlendMode 2` | 合成 RT 800×400；true 时基础 pass 是 composelayer 着色器、顶点铺满 RT；false 时清成透明、没有基础 draw；无 effect 时没有 draw；cbm 混合上屏 |
| `p5b-proj` | projectlayer 的 `size` 写成 500×300，挂 tint；再把 `orthogonalprojection` 改成 1280×720 | 尺寸 = 正交投影宽高 |
| `p5b-fs` | fullscreenlayer 设 `origin` (100, 50)、`scale` 0.5、`angles` z = 0.7、`size` 300×200，挂 tint；去掉 effect；另一个 fullscreen 模型用乘 MVP 的自写着色器；1344×756 窗口再抓一次 | 合成 RT 是整张拷贝、没有基础 draw；末 pass 单位阵、NDC；无 effect 时没有 draw；乘 MVP 时是 2×2 的方块；`_rt_FullFrameBuffer` 尺寸是场景还是窗口；上屏 pass 拿到的 `g_Color4` |
| `p5b-grp` | composelayer 下挂红、蓝两个子图层（alpha 0.5，部分重叠，一个伸出矩形），`copybackground` true / false；组上挂与不挂 effect（不挂时 `size` 小于屏幕） | 子层不在顶层再画；局部正交、伸出部分裁掉；false 时重叠处 alpha = 0.5（MAX）；无 effect 带子层的直接上屏是否拉伸到全屏 |
| `p5b-nest` | 组里套组（内层带 effect），外层组里在内层之前放一个兄弟图层 | 内层按真实屏幕坐标采快照，采到的是外层开始时的快照（不含先画的兄弟层） |
| `p5b-grpptc` | 组里放一个本地粒子系统、一个世界空间粒子系统、一个带 effect 的子图层 | 粒子与子图层的 effect 在组里的矩阵；子图层的快照规则 |
| `p5b-inst` | `instanced` 纯色层 `size` 1920×1080，挂 opacity 遮罩（锐利棋盘）；对照组去掉 `instanced` 改普通 genericimage2 + `util/white`；另一个 `instance.textures` 换成一张图 | 合成 RT 32×32、遮罩变糊；对照组 1920×1080；`textures` 覆盖 |
| `p5b-alpha` | 一个 translucent 图层和一个 additive 图层，后接 composelayer（`copybackground` true，挂只透传颜色和 alpha 的 effect） | 场景目标的 alpha（清屏后、普通绘制后）：组里采到的快照 alpha 是不是恒为 1 |

真实样本：`1923929928`（透视图层）、`3286859278`（fullscreenlayer + Tint）、`2251857160`（`copybackground: false`）、`3233141951`（带子层与嵌套）、`3219908811`（instanced）、`3146703458`（nopadding 与透视图层）。抓帧读合成 RT 尺寸、基础 pass 的着色器与矩阵、上屏的矩阵，和读码对照。

**验收：** 每条读码结论和每个【推】都有工程对上，或者写明被推翻的地方和改正后的规则；结论写进 [p5-REPORT.md](p5-REPORT.md) 新的「P5b 语义的实测核对」一节；对步骤 1–5 的影响写进本文件的实施记录，并补全各步的现状锚点、点和验收。

### 0c — 读码补查（只在抓帧解决不了时）

候选（先不派代理）：
- 嵌套组合层基础 pass 换回的 `ctx+0x1168` / `ctx+0x11a8` 是不是场景相机（rea 2.4【推】）：`p5b-nest` 的矩阵能直接回答。
- `instance` 能覆盖哪些键：语料只用 `textures`、`combos`、`usertextures`，后者照报，不查。
- `_rt_FullFrameBuffer` 的尺寸由谁定：`p5b-fs` 两个窗口尺寸能直接回答。

### 步骤 0 实施记录（2026-11-12）

结论全在 [p5-REPORT.md](p5-REPORT.md)「P5b 语义的实测核对」：21 个确定性工程，读码的流程全部成立，`_rt_FullFrameBuffer` 的尺寸、嵌套组的快照、组里的粒子、组与视差这几处没查清或没写的也测清了。只推翻两处【推】：
- **无 effect 带子层的组怎么上屏**：不是「composelayer 着色器铺满全屏并拉伸」，而是透传着色器（`采样 × g_Color4`，`g_Color4` = 1）画世界四边形，UV 0–1；`copybackground` 为 true 时不混合，false 时 translucent。
- **`instanced` 的遮罩变糊**：只有多 pass 的 effect 才有中间 pass 在 32×32 上跑；单个 effect 的末 pass 直接上屏，遮罩按自己的分辨率采样。

另有一条只记不补：effect pass 的 `g_Color4` 是这一帧最后设置的值（fullscreen 拷贝路径拿到前一层的颜色，带子层的组拿到最后一个子层的颜色），我们给的是层自己的颜色。语料 171 个工程的 2190 个着色器文件里没有一个读 `g_Color4`（`kbp content grep`），WPE 自带的 46 个 effect 也不读。

0c 的读码补查不需要了：三条候选都由抓帧直接回答。真实样本不在步骤 0 抓，留到各步的验收和 WPE 同一时刻比。

**对各步的影响：**
- **步骤 1：** 按提纲做，没有改动。透视图层的矩阵就是透视粒子那一套（相机距离随 `perspectiveoverridefov` 与 `zoom` 变），视差平移乘在投影之前；`nopadding` 只关直接上屏的内缩；`autosize` 覆盖 `size`，三者都缺时 1×1。
- **步骤 2：** 按提纲做。基础 pass 关混合、写掩码 RGBA、MVP = 场景 VP · 视差 · `W`；`copybackground: false` 只清屏；不画的层照常拷快照（看不出来，可以不拷）。
- **步骤 3：** 合成 RT 0 是场景目标的整张拷贝，尺寸取我们场景目标的尺寸（WPE 是窗口尺寸，我们离屏按场景分辨率渲染）。
- **步骤 4：** 无 effect 带子层的组按上面实测的规则上屏；视差只作用在组本身，子层在组里用单位视图；嵌套组的基础 pass 用场景相机、采外层开始时那份快照；世界空间粒子在组里经 `inverse(W_组)`。
- **步骤 5：** 合成 RT 按纹理图像尺寸，`instance.textures` 覆盖槽 0；颜色照常进基础 pass。

**工具：**
- 工程：`ignore/p5/b0/gen_b.py`（复用 `../a0/gen_a.py`，`.tex` 自写）；
- 导出：`rdc_dump_b.py`（`RD_DUMP_LIST` / `RD_DUMP_OUT` / `RD_DUMP_PNG`），摘要 `ana_b.py`；
- 抓帧：`A:\p5b\*`，日志 `ignore/p5/b0/out/logs/`。

## 步骤 1 — 尺寸、UV 内缩与透视图层

### 思路

三件事都只改一个图像层自己，不碰渲染图的形状。尺寸是编译期的量：照 WPE 的顺序，先取模型宽高（缺了是 1），再被对象 `size` 覆盖，最后在「纹理就绪」时被 `autosize` 覆盖成槽 0 纹理的图像尺寸；我们没有异步的纹理就绪，编译期按同一顺序一次算完。UV 内缩分成两种：直接上屏的四边形看 `fullscreen | nopadding | passthrough | solidlayer`，末 pass 和 passthrough 上屏的四边形不看 `nopadding`。透视图层只在画到场景目标的那几次绘制（直接上屏、末 pass、passthrough 上屏）把视图投影换成透视粒子那一份（`perspectiveViewProjection`，已带抖动与缩放），视差平移照旧右乘，所以是 `P_persp · T(o − s) · W`；画进合成 RT 的 pass 和 effect 中间 pass 不变。

步骤 0 已经量好：`autosize` 改优先级对语料是中性的，`nopadding`、透视矩阵都有 WPE 的四角坐标可比。`projectlayer` 的尺寸来源也属于 `autosize`，但它是组合层，放到步骤 2 和组合层一起做；步骤 1 只做普通图像层的 `autosize`。

### 现状锚点

**a. 尺寸**（`compile/bundle.ts:1018`、`:1081`）
```ts
      size: numbers(bindings.bind(object.size, properties, recompile("layer-structure", `objects/${index}/size`))),
    // …
    if (!layer.size.length) {   // 现状：对象 size 优先；没写时模型宽高，再没有就取纹理图像尺寸（WPE：autosize 覆盖 size，三者都缺时 1×1）
      layer.size = model.width && model.height ? [model.width, model.height] : texture ? [texture.width, texture.height] : [model.width ?? 0, model.height ?? 0];
    }
```

**b. UV 内缩：直接上屏和末 pass 共用一个**（`render/graph.ts:195`）
```ts
  // WPE 的 `nopadding` 只关直接上屏这一块，`fullscreen`、`passthrough` 模型两块都关；这三个现在都报不支持
  const screenInset = layer.solidLayer ? NO_INSET : uvInset(layer.size, baseTexture);
  // direct：inset: screenInset；final：inset: final ? screenInset : NO_INSET；passthrough：inset: screenInset
```

**c. 图像层的绘制一律用正交的场景视图投影**（`render/scene.ts:1420`）
```ts
    return drawUniformValues({
      ...common,
      step,
      layer: { ...layerState, size: layer.size },
      viewProjection: this.viewProjectionOf(layer, state, this.viewProjection), // 现状：只有粒子按 step.perspective 换透视
    });
```

**d. 能力表**（`compile/features.ts:204`、`:221`、`:470`）
```ts
const OBJECT_FLAGS = ["perspective", "fullscreen", "passthrough", /* … */]; // 现状：perspective 为真就报 object:perspective
const SUPPORTED_MODEL = new Set(["material", "width", "height", "autosize", "solidlayer", "cropoffset"]); // 现状：nopadding 报 model:nopadding
```

### 点 1 — 图层记下两个标志（`compile/bundle.ts`）
- **新增** `SceneLayer` 两个字段：
```ts
  /** 模型 `nopadding`（只认 JSON true）：直接上屏的四边形不内缩，末 pass 照旧内缩（p5-REPORT `p5b-nopad`）。 */
  noPadding: boolean;
  /** 对象 `perspective`（只认 JSON true，图像层）：画到场景目标的绘制换成透视视图投影（`p5b-persp`）。 */
  perspective: boolean;
```
- 粒子、分组、声音等没有图像模型的图层两者都是 false。

### 点 2 — 尺寸按 WPE 的顺序（`compile/bundle.ts`）
- **新增** 导出纯函数，`compileScene` 读完模型与基础纹理后调用：
```ts
/**
 * 图像层的尺寸（rea-p5-modelflags §7「尺寸的最终取值顺序」，p5-REPORT `p5b-autosize` 实测）：1×1 → 模型 `width` / `height`（数字才算，
 * 两个分量各自生效）→ 对象 `size` → `autosize` 时槽 0 纹理的图像尺寸（覆盖前面的值；没有纹理时不覆盖）。
 * 精灵表的帧尺寸、`projectlayer` 的正交投影、用户纹理的参考尺寸不在这里：前者随图像层帧动画（`tex:animation`），后两者属步骤 2 / 照报。
 */
export function imageLayerSize(model: ModelJson, objectSize: readonly number[], texture: Pick<SceneTexture, "width" | "height"> | undefined): number[];
```
- **修改** 原来的 `if (!layer.size.length) { … }` 换成 `layer.size = imageLayerSize(model, layer.size, texture)`。
  > 说明：语料里两种取法结果全部相同（0a），基线逐张核对；`size` 绑属性又 `autosize` 的语料 0 个，WPE 运行中改 `size` 不会重跑纹理回调、我们会重编译重算，记进未实测清单。

### 点 3 — UV 内缩分两种（`render/graph.ts`）
```ts
  // 直接上屏（WPE `+0x490`，flags & 0x226）：fullscreen、nopadding、passthrough、solidlayer 不内缩；
  // 末 pass 与 passthrough 上屏（`+0x2e8`，flags & 0x222）不看 nopadding（p5-REPORT `p5b-nopad`）
  const directInset = layer.solidLayer || layer.noPadding ? NO_INSET : uvInset(layer.size, baseTexture);
  const finalInset = layer.solidLayer ? NO_INSET : uvInset(layer.size, baseTexture);
```
- **修改** `direct` 用 `directInset`；`final`、`passthrough` 用 `finalInset`。`fullscreen`、`passthrough` 模型在步骤 2、3 加进这两个条件。

### 点 4 — 透视图层（`render/scene.ts`）
- **修改** `uniformValues` 的图像分支：
```ts
      // 图像层 perspective（P5b 步骤 1，p5-REPORT `p5b-persp`）：画到场景目标的绘制（直接上屏、末 pass、passthrough 上屏）换成透视粒子
      // 那一份视图投影（相机距离随 perspectiveoverridefov 与 zoom 变，已带抖动），视差平移照旧右乘；画进合成 RT 的 pass 不变
      viewProjection: this.viewProjectionOf(
        layer,
        state,
        layer.perspective && step.target.kind === "scene" ? this.perspectiveViewProjection : this.viewProjection,
      ),
```
- 文件头的注释补一条「透视图层」。
  > 说明：effect 中间 pass 的效果矩阵（`g_EffectModelViewProjectionMatrix` 等）仍按正交算，WPE 读码是只在上屏时压相机（rea 1.3）；语料里透视图层的 effect（scroll、perspective、pulse）都只读 MVP，记进未实测清单。

### 点 5 — 能力表（`compile/features.ts`）
- **修改** `SUPPORTED_MODEL` 加 `nopadding`；`autosize` 的注释改成「纹理就绪时覆盖 `size`」。
- **修改** `OBJECT_FLAGS` 去掉 `perspective`，另写一条：
```ts
  // 图像层 perspective（P5b 步骤 1）：JSON true 已实现；绑属性、挂脚本或别的取值，以及非图像对象上为真，照报
  if (active(object.perspective) && !(kind === "image" && object.perspective === true)) unsupported.add("object:perspective");
```
- `SUPPORTED_OBJECT` 的注释补 `perspective`。

### 点 6 — 单测（新增 `compile/p5b.test.ts`、`render/p5b.test.ts`）
- `imageLayerSize`：`p5b-autosize` 的五种组合（48×40、1×1、100×50、48×40、48×40），模型宽高只写一个分量、写成字符串时的取值。
- `planLayer`：`nopadding` 的直接上屏 inset 为 0，带 effect 时末 pass inset = `0.15 / 纹理尺寸`；`solidLayer` 两者都是 0。
- 透视图层：用 `drawUniformValues` 加透视视图投影算 P1、P2（末 pass）、P3 四角的裁剪坐标，和 WPE 抓帧（`ignore/p5/b1/persp_fixture.json` 抄进测试的常量，四个变体：缺省、`fov 30`、视差、`zoom 1.5`）逐个比，x、y、w 相对误差 < 1e-4。
- 能力表：图像层 `perspective: true` 不报；`{user}`、粒子对象上为真报 `object:perspective`；`nopadding` 不报。

### 实施方式

并行期在 HEAD 快照里实现：`kbp snapshot export HEAD ignore/p5/b1/head` 与 `ignore/p5/b1/ov`，子代理只改 `ov/src`，Claude 用 `kbp snapshot diff` 出补丁、`git apply --3way` 合进仓库。

### 验收
1. 子代理：快照里 tsc 0 error，vitest 全过（带 `KABEGAME_WPE_ROOT`），Prettier。
2. Claude 独立：`git status` 查越界；变异检查（`imageLayerSize` 去掉 `autosize` 覆盖、`directInset` 去掉 `noPadding`、透视换回正交）各有用例失败。
3. 语料：`kbp corpus diff` 前后只少 `model:nopadding`、`object:perspective`，干净场景 39 → 40（`1923929928`），别的场景的键不变。
4. 基线：10 张原本能渲染的场景 × 三档后处理，画面哈希不变（同 P5a A11）。
5. 和 WPE 整帧比：`p5b-nopad`、`p5b-autosize`、`p5b-persp`（四个变体）用 `render_scene` 按日志的时间线回放，和 WPE 抓帧逐像素比；`1923929928` 和 WPE 同一时刻比。

### 步骤 1 实施记录（2026-11-12）

子代理在 `ignore/p5/b1/ov`（HEAD `37606401` 快照）里实现，Claude 用 `kbp snapshot diff` 出补丁（`ignore/p5/b1/step1.patch`），工作区里这几个文件没有别的会话的改动，`git apply` 直接打进（不经索引）。

**改动：** 4 个产品文件照点 1–5 落地，和计划没有出入：
- `bundle.ts`：`noPadding`、`perspective` 两个字段与 `imageLayerSize`；
- `graph.ts`：`directInset` / `finalInset`；
- `scene.ts`：透视图层换 `perspectiveViewProjection`，加文件头注释；
- `features.ts`：放开 `model:nopadding`；图像层 `perspective: true` 不再报，别的取值照报。

新增 `compile/p5b.test.ts`（17 个）、`render/p5b.test.ts`（16 个）。改了 2 个已有测试的期望：
- `p5a.test.ts`：`nopadding` 不再报；
- `p2a.test.ts`：照报的用例换成绑属性的 `perspective`；靠「三者都缺取纹理尺寸」的用例给模型加上 `autosize`。

另有 8 个测试文件只是给手写的 `SceneLayer` 补两个字段。

**验收：**
1. **检查（Claude 在工作区复跑）：**
   - 宿主 tsc 0 error；
   - vitest 1761 过、1 败。失败的是 `pipeline.test.ts` 的 `3830255100: 219 次请求`，HEAD 上同样失败，与本次无关；
   - Prettier 通过。
2. **变异：** `kbp mutate`（`ignore/p5/b1/mutate_s1.py`）8 处全部检出，源码原样还原：
   - 去掉 `autosize` 覆盖；退回纹理尺寸；
   - `directInset` 去掉 `noPadding`；末 pass 也看 `noPadding`；
   - 透视换回正交；合成 RT 里也用透视；
   - 放行绑属性的 `perspective`；`nopadding` 照报。
3. **语料**（`kbp corpus diff`，`ignore/p5/b1/out/corpus-diff.txt`）：只去掉 40 张的 `model:nopadding` 和 5 张的 `object:perspective`，没有新增的键；干净场景 39 → 40（`1923929928`）。
4. **画面哈希：** 合并前（`hash-before.json`，和 P5a 收尾的基线相同）与合并后重建宿主（`index-DXZMaZLe.js`）的 10 张 × 3 档全部相同。
5. **和 WPE 整帧比**（`render_scene` 固定时刻，视差变体给 40 帧 dt 收敛；`kbp cmp frame --kbp-layers` 排除 FR / CLK）：
   - `p5b-autosize`：0 个像素不同。
   - `p5b-nopad`：1845 个像素差 1。第一版的测试纹理标志位写成 0x22，0x20 是视频位，我们把它当视频纹理没解码；改成 2 后重抓（`p5b-nopad-v2`）。
   - 透视四个变体（棋盘纹理）：差异 0.1%–0.4%，最大 98–184。差异全在纵向被压扁的 32 像素棋盘格上，是采样混叠；不是透视层的正交对照 Q 也有同样的横线。
   - 为此补测 `p5b-persp-smooth`：平滑渐变纹理，四个透视层，含 x、y 两轴旋转和带 effect 的。结果 2268 个像素差 1、最大 1。
   - `1923929928`：解包加日志（`kbp content unpack --instrument`），按 WPE 日志的帧时间与逐帧光标回放到第 190 帧，缩到 1920×1080 和 WPE 比。透视网格的线位、汇聚方向、间距和颜色一致（`zoom-1923929928.png`）。其余差异是随机星空粒子和 3840 → 1920 的缩放。
6. 测试工程（8 个）已用 `projects_remove` 移除。

**更正读码：** rea-p5-modelflags 5.1 推断「纹理标志 0x20 对应未补边」，实际 0x20 是视频位（`compile/tex.ts` 的 `TEX_FLAGS.video`）。语料里写 `nopadding` 的纹理带 0x20，是因为编辑器给视频纹理写了 `nopadding`。`3822149301`、`3824550659`、`3828359750` 去掉 `model:nopadding` 后只剩 `tex:video` 也是这个原因。

**未实测清单（P5b 收尾时走查）：**
- 透视图层带多 pass effect 时，中间 pass 的效果矩阵（`g_EffectModelViewProjectionMatrix` 等）。我们按正交算：rea-p5-modelflags 1.3 读到的是只在上屏时压相机，rea-p5-camera 7.1 另提到正交 + bit7 时合成矩阵经 `FUN_140184f00` 换算。语料里透视图层的 effect 只读 MVP。
- `size` 绑属性、同时 `autosize`：WPE 运行中改 `size` 不会重跑纹理回调，我们整场重编译会重新按 `autosize` 覆盖。语料 0 个。
- 对象 `size` 只写一个分量时，另一个取模型值或 1（按「各分量各自覆盖」推的）。

## 步骤 2 — 组合层：无子层

### 思路

不带子层的组合层就是「一个基础 pass 换了写法的带 effect 图层」，渲染图的形状不变：基础 pass → effect 链 → 借基础材质的 blend 上屏（或 `colorBlendMode` 混合上屏）。和普通图层只差四处，全部落在 `planLayer` 里：
- **基础 pass**：`copybackground` 为 true（缺省）时画基础材质本身（composelayer 着色器），矩阵是图层的 MVP（场景视图投影 · 视差 · `W`），不是普通基础 pass 那个铺满 RT 的正交。着色器自己用 UV 铺满合成 RT，用 MVP 算这块在屏幕上的位置去采快照。为 false 时不画基础材质，合成 RT 0 清成 (0, 0, 0, 0)。
- **不画**：没有启用的 effect、`colorBlendMode` 是 0 或 31 时整层没有步骤（WPE 照拷一次快照，看不出来，我们不拷）。
- **合成 RT 尺寸**：按图层 `size`，同 `solidlayer`。
- **UV 内缩**：上屏四边形（末 pass、passthrough 上屏）不内缩；组合层没有直接上屏这条路。

渲染器只多认一种步骤 `clear`（把合成 RT 清成透明），和一种绘制角色 `compose`（基础 pass，矩阵取图层 MVP）。`projectlayer` 只是尺寸来源：`autosize` 时尺寸取正交投影宽高，排序键 −∞ 只在透视场景起作用（步骤 0，P5d 的事）。

带子层的组合层留到步骤 4，照报 `model:passthrough:children`；`fullscreen` 的组合层（fullscreenlayer）留到步骤 3，照报 `model:fullscreen`。

### 现状锚点

**a. 能力表把 passthrough、projectlayer 模型整个报掉**（`compile/features.ts:539`）
```ts
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const [key, value] of Object.entries(model)) {
    if (SUPPORTED_MODEL.has(key)) continue;
    // 现状：fullscreen、passthrough、projectlayer、instanced 为 true 时报 model:<键>
    if (MODEL_FLAGS.has(key) ? modelFlag(model, key) : active(value)) unsupported.add(`model:${key}`);
  }
```

**b. 基础 pass 一律关混合、用铺满 RT 的正交画**（`render/graph.ts:255` 起、`render/uniforms.ts:283`）
```ts
  steps.push({ kind: "draw", role: "base", pass: base, effect: null, target: nextComposite(),
    inputs: staticInputs(base, null), geometry: "fill", uv, inset: NO_INSET, blending: null });
    case "base": {   // drawMatrices：现状只有这一种基础 pass 的矩阵
      const fill = orthographic(-(hw || 1), hw || 1, -(hh || 1), hh || 1, -FILL_DEPTH, FILL_DEPTH);
      return { modelViewProjection: fill, model: identity(), viewProjection: fill };
    }
```

**c. 没有 effect、没有 cbm 时走直接上屏**（`render/graph.ts:236`）
```ts
  if (!needsComposite(layer, enabled)) {   // 现状：组合层也会走这里，按 composelayer 着色器画一块「铺满全屏」的四边形
```

**d. 合成 RT 尺寸与内缩只认 `solidLayer`**（`render/graph.ts:102`、`:230`）
```ts
    texture && !layer.solidLayer ? [texture.width, texture.height] : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  const finalInset = layer.solidLayer ? NO_INSET : uvInset(layer.size, baseTexture);
```

### 点 1 — 图层记下组合层（`compile/bundle.ts`）
- **新增** `SceneLayer` 两个字段：
```ts
  /** 模型 `passthrough`（只认 JSON true）：组合层，基础 pass 见 `copyBackground`（P5b 步骤 2）。 */
  passthroughModel: boolean;
  /** 对象 `copybackground`（缺省 true，JSON false 才关）：基础 pass 从快照铺进合成 RT，否则合成 RT 清成透明。 */
  copyBackground: boolean;
```
- **修改** `imageLayerSize` 加一个参数：`autosize` 且 `projectlayer` 时取正交投影宽高（`general.width` / `height`），排在纹理之前（rea §7，`p5b-proj` 实测）。
- **新增** 两条照报，在读完模型之后：
  - 组合层有子层（`parents` 里有指向它的）：`model:passthrough:children`（步骤 4）；
  - 组合层同时 `perspective: true`：`object:perspective`（语料 0 个，WPE 这时基础 pass 用哪套相机没测）。

### 点 2 — 能力表（`compile/features.ts`）
- **修改** `checkModelFeatures`：`passthrough`、`projectlayer` 不再报（`fullscreen`、`instanced` 照报）；注释写清组合层的语义与子层、fullscreen 的去向。
- **修改** `SUPPORTED_OBJECT` 里 `copybackground` 的注释（组合层读它，普通模型上中性）。

### 点 3 — 渲染图（`render/graph.ts`）
- **新增** `DrawRole` 加 `"compose"`；`LayerStep` 加 `{ kind: "clear"; target: TargetRef }`（清成 (0, 0, 0, 0)）。
- **修改** `planLayer`：
```ts
  // 组合层（P5b 步骤 2，p5-REPORT `p5b-cl`）：没有启用的 effect、cbm 是 0 / 31 时整层不画；否则基础 pass 按 copybackground 分两种
  if (layer.passthroughModel && !needsComposite(layer, enabled)) return { composite: null, steps, reasons };
  // …
  if (layer.passthroughModel && !layer.copyBackground) steps.push({ kind: "clear", target: nextComposite() });
  else steps.push({ kind: "draw", role: layer.passthroughModel ? "compose" : "base", /* geometry 组合层用 "layer" */ … });
```
- **修改** `compositeSize`、`finalInset`：`solidLayer || passthroughModel` 时按 `size`、不内缩。
- `variantPlans`、`planSignature` 照旧（`clear` 步骤进签名）。

### 点 4 — 矩阵与渲染器（`render/uniforms.ts`、`render/scene.ts`）
- **修改** `drawMatrices`：`compose` 和 `final` 一样取图层 MVP（`viewProjection · W`，视差、抖动已在 `viewProjection` 里）。
- **修改** `GpuScene`：`clear` 步骤建成一个 op，`runOps` 里 `end()` 之后对目标开一个 `loadOp: "clear"`、清成透明的 render pass；`wantsSnapshot`、`checkPlanOps`、`ensureComposites` 等遍历步骤的地方认它。`compose` 的管线同基础 pass（关混合、写 RGBA）。

### 点 5 — 单测（`compile/p5b.test.ts`、`render/p5b.test.ts` 续写）
- 能力表：composelayer / projectlayer 模型不报；带子层报 `model:passthrough:children`；fullscreenlayer 只报 `model:fullscreen`。
- `imageLayerSize`：projectlayer + `autosize` 取正交投影；没有 `autosize` 时照常。
- `planLayer`（`p5b-cl` 的 CL1–CL5 与 `p5b-proj`）：步骤序列（compose → effect 末 pass；clear → effect；无 effect 时空；cbm 2 时 compose → effect → passthrough）、合成 RT 尺寸、inset 为 0。
- `drawMatrices` / GpuScene 假设备：compose 的 MVP 和 WPE 抓帧的基础 pass 常量逐元素相同（`p5b-cl` 事件 62，`p5b-grp-par` 事件 62 带视差），`clear` 进了 op 序列。

### 实施方式

同步骤 1：HEAD 快照 `ignore/p5/b2/head` 与 `ignore/p5/b2/ov`，子代理只改 `ov/src`，Claude 出补丁合进工作区。P4e 正在改 `bundle.ts`、`features.ts`、`graph.ts`、`scene.ts`，合并用三方合并，提交时只把补丁打进索引。

### 验收
1. 子代理：快照里 tsc 0 error，vitest 全过，Prettier。
2. Claude 独立：变异检查（composelayer 的基础 pass 换回铺满正交、`copybackground: false` 不清屏、无 effect 时照画、合成 RT 回到纹理尺寸、projectlayer 不取投影尺寸）。
3. 语料：`model:passthrough` 全部去掉，新增 `model:passthrough:children`（带子层的场景），`model:projectlayer` 去掉；别的键不变。
4. 基线：10 张 × 三档画面哈希不变。
5. 和 WPE 整帧比：`p5b-cl`、`p5b-proj`、`p5b-proj-720`（固定时刻）；真实样本挑 2–3 张组合层多、其余键少的（如 `2251857160` 的 `copybackground: false`、`3823859141` 的 cbm 30），强制渲染后只比组合层所在区域。

### 步骤 2 实施记录（2026-11-12）

子代理在 `ignore/p5/b2/ov`（HEAD `f6293632` 快照）里实现，补丁 `ignore/p5/b2/step2.patch`。

**改动：** 5 个产品文件照点 1–4 落地：
- `bundle.ts`：`passthroughModel`、`copyBackground`；`imageLayerSize` 加正交投影参数，`autosize && projectlayer` 时取投影宽高并取整（rea §3.1）；带子层报 `model:passthrough:children`，加 `perspective` 的报 `object:perspective`。
- `features.ts`：`passthrough`、`projectlayer` 进支持表。
- `graph.ts`：`compose` 角色与 `clear` 步骤；无 effect 的组合层是空计划；合成 RT 按 `size`、不内缩。
- `uniforms.ts`：`compose` 取图层 MVP。
- `scene.ts`：`clear` op。

测试：新增 `render/p5b-compose.test.ts`（23 个），`compile/p5b.test.ts` 续写 21 个；另有 9 个测试文件只是给手写的 `SceneLayer` 补字段，`compositeSize`、`imageLayerSize` 的已有调用补了参数。没有哪个已有断言要改。

**合并：** P4e（粒子子系统）同时在改 `bundle.ts`、`features.ts`、`graph.ts`、`scene.ts`、`render/particles.test.ts`，还没提交。我用 `git merge-file` 逐文件三方合并（基线快照 / 工作区 / 副本），只有 `graph.ts` 文件头注释冲突一处：两边改的是同一段说明，条件那句与「组合层」一条取 P5b，「粒子层」一条取 P4e（`ignore/p5/b2/resolve_graph.py`）。

**验收：**
1. **检查：**
   - 子代理快照：tsc 0，vitest 1805 过、1 败（`3830255100: 219 次请求`，HEAD 上同样失败）；
   - 合并后的工作区（含 P4e 未提交的改动）：tsc 0，vitest 1842 过、1 败（同一条）；
   - 「HEAD + 本补丁」用临时索引导出：tsc 0，vitest 1600 过、0 败；
   - Prettier 通过。
2. **变异：** 9 处全部检出（`mutate_s2.py` 里第一版有两处写错：`compose` 与 `default` 同一分支、`clear` 的原文带花括号，改正后另跑 `mutate_s2b.py`）。
   - 基础 pass 换回铺满正交；`copybackground: false` 不清屏；无 effect 照画；
   - 合成 RT 回到纹理尺寸；projectlayer 不取投影；上屏照旧内缩；
   - 带子层不报；`copybackground` 缺省成 false；渲染器不执行 `clear`。
3. **语料**（`ignore/p5/b2/out/corpus-diff.txt`）：去掉 68 张的 `model:passthrough`、12 张的 `model:projectlayer`；新增 9 张的 `model:passthrough:children`；别的键不变，干净场景 43 → 43。
4. **画面哈希：** 和步骤 1 合并后的基线比，10 张 × 3 档全部相同。合并后重建的宿主 `index-DdD5IEiw.js` 含 P4e 未提交的改动。
5. **和 WPE 整帧比**（`kbp cmp frame`）：
   - `p5b-cl`（五个组合层：旋转、`copybackground: false`、无 effect 两种、cbm 2）：32 个像素差 1；
   - `p5b-proj`：0 差异；
   - `p5b-proj-720` 我们读回的是 1280×720 场景目标，这次会话的 MCP 还没有 `canvas` 参数，没逐像素比：平均色和 1920×1080 那份一致，组合层铺满投影尺寸，合成 RT 尺寸另有单测。
   - 真实样本：按 WPE 日志回放到抓到的那一帧。
     - `1333579536`：整屏组合层一致，差异是随机粒子与 2500 → 1920 的缩放。P4e 的子系统在工作区里，这张两步合起来已经没有不支持项。
     - `3825170583`：经过组合层的人物、翅膀、背景一致；左上角的光束差异来自 `shape` 对象（`object:shape`，没画）；另有随机粒子。`音阶` 组合层读音频频谱，另报不支持。
     - `3502090109`：差异超过 8 的约 2.4%，最大 92。场景另有 `cull:normal`、音频频谱两项不支持。
6. 测试工程（6 个）已用 `projects_remove` 移除。

**未实测清单（续）：**
- `copybackground: false` 的组合层上屏时 `g_Color4`：WPE 没有基础 draw，上屏拿到前一个画过的层的颜色，我们给的是自己的（同步骤 0 的 `g_Color4` 一条，语料不读）。
- `copybackground` 绑属性或挂脚本时按 true、不报（语料 0 个）。
- fullscreenlayer 的 `passthroughModel` 也是 true：照报 `model:fullscreen`，dev 强制渲染时会按普通组合层画，步骤 3 改。

## 步骤 3–5（提纲，步骤 0 之后补全）
- **步骤 3 — `fullscreen`。** 合成路径的第一步换成 `copy`（当前目标 → 合成 RT 0），上屏单位阵 + NDC；无 effect 时 2×2 四边形、MVP 照常算。组里的 fullscreen（当前目标是组的合成 RT）留到步骤 4 一起验。
- **步骤 4 — 组合层：子层。** 编译期算每个图层归属的组；顶层跳过；组的计划插 `subtree`；子孙的 draw 按组的局部坐标系现算矩阵；`copybackground: false` 的组里写 RGBA、alpha MAX 的管线变体；无 effect 带子层时透传着色器画世界四边形（`copybackground` true 不混合、false translucent）；嵌套；组里的粒子（世界空间系统用组的模型矩阵，rea-p4c 的 `ctx+0xaf0`）。
- **步骤 5 — `instanced`。** 编译材质前合并 `instance.textures` / `combos`；`usertextures` 照报；合成 RT 按纹理图像尺寸（`solidLayer` 已经排除了 instanced）。

每步的回归同 P5a：语料前后比（`kbp corpus diff`），原来能渲染的场景画面哈希不变（基线 10 张 × 三档后处理），确定性工程和 WPE 整帧比。

## 风险

1. **`autosize` 改尺寸来源**：语料里取值全部一致（0a），但它改的是每个图像层都走的路径，基线照样逐张核对；精灵表的帧尺寸留给图像层帧动画（P6），这里不改。
2. **组合层子树改了顶层循环**：可见性、快照、粒子步进、脚本对子图层的写回都要在组里照常生效。步骤 4 单独验收，不和无子层的组一起提交。
3. **组里的抖动**：视差已测清（只作用在组本身），抖动在正交场景里是整场平移，按同一个视图走，步骤 4 加一个带抖动的工程核对。
4. **fullscreen 的合成 RT 尺寸**：`_rt_FullFrameBuffer` 是窗口尺寸（步骤 0），我们按场景目标取。窗口比例和场景不同时，WPE 的合成 RT 是窗口那一块，我们是场景那一块，铺到画布后一致。
5. **和 P6、P7 抢文件**：见文件头。

## 决定

**已定：**
1. P5b 现在开始（2026-11-12 用户）。

**待定：** 无。步骤 0 之后若有读码被推翻、或某一类的工作量明显超出预期（如带子层的组合层），再提出来定。
