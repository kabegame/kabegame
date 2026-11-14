# P12a — puppet 网格与骨骼动画（子计划）

> 上级：[P12 总计划](phase-12-puppet.md)「P12a — puppet 网格与骨骼动画」。WPE 语义以 [rea-p12-mdl](rea-p12-mdl.md)、[rea-p12-runtime](rea-p12-runtime.md) 与 [p12-REPORT](p12-REPORT.md) 为准，本节不另做步骤 0。
> 现状行号按 HEAD `45e1cb89`（只读快照 `ignore/p12/a/head`）。语料口径同总计划（`ignore/p12/out/corpus-head.json`，183 张）。
> 2026-11-14 用户：「开始 p12a」。

## 总体设计思路

puppet 在 WPE 里是图像层的一种画法，不是新的对象种类。WPE 加载图像层时读模型 JSON 的 `puppet`，用 mdl 的网格 0 代替图像层上屏的四边形。每帧在对象更新里推进动画层、算出骨骼矩阵，画的时候把蒙皮矩阵交给着色器的 `g_Bones`。着色器、材质、effect、合成 RT 都还是图像层那一套。所以 P12a 不建新的图层类型，只在图像层上加三样东西：
- 一份 puppet 数据：网格、骨骼、动画、动画层；
- 一个每帧求姿势的运行时；
- 一种几何：上屏时画 puppet 网格，不画四边形。

分三块，边界和 P10a 一样清楚：
- **puppet 运行时 `src/puppet/`（纯 TS，不依赖 GPU 与编译管线）**：
  - `pose.ts`：采样、三种混合、淡入淡出、父链与蒙皮矩阵；
  - `player.ts`：`ScenePuppets` 持有每个 puppet 图层的动画层时钟，每帧推进、求姿势，交出每个图层的蒙皮矩阵。

  时钟直接用 P10 的 `AnimationClock`，读码与实测都确认两者是同一个函数。全部照读码逐步 `Math.fround`。Node 单测、dev 探针、宿主共用这一份。
- **编译期（Worker）**：
  - `compile/mdl.ts` 的 `parseMdl` 把 `MDLS`、`MDLA` 与可选块 2 读出来（P5c 只记了段标签）；
  - `compile/puppet.ts` 把它们整理成 `ScenePuppet`：网格 0、骨骼父链与局部矩阵、静止姿势、轨道转好的四元数、动画层与它们字段的绑定；
  - 图像层的材质按 WPE 的规则加 `SKINNING` / `BONECOUNT`；
  - 能力表去掉 `model:puppet` 和 `object:animationlayers`，P12b–d 的用法报 `puppet:*` 细分键。
- **渲染（主线程）**：
  - 渲染图给图像层的上屏步骤一种新几何 `"puppet"`：不带 effect 时是直接上屏，带 effect 时是 passthrough 上屏（P8 的那条路，全部 effect 留在合成链里）；
  - `GpuScene` 建这种 draw 时，用 P5c 的网格缓冲与顶点布局；
  - 每帧在 `update` 里把 `ScenePuppets` 算好的蒙皮矩阵写进这些 draw 的 `g_Bones`。

照 WPE 的几条规则直接决定了实现形状：
- **帧里的位置**：puppet 和粒子在同一个对象更新循环里，排在相机、P10 关键帧与脚本之前。所以渲染器在 `stepParticles` 之后、`setCamera` 之前调 `ScenePuppets.frame`。
  - 用户属性在两帧之间写进 `SceneState`，puppet 当帧就读到；
  - 脚本写回在 puppet 之后，自然晚一帧。

  实测：用户属性 K+0，脚本 K+1。
- **图层隐藏也推进**，暂停冻结，补画帧不推进。静态 puppet（没有 `MDLS`）不进运行时。
- **两条上屏路径在编译期定**：
  - 图层有 effect、`colorBlendMode` 不是 0 / 31、或被依赖时，WPE 在加载时就置 `0x10`，一律走合成路径：基础 pass 用不带 puppet 组合键的基础材质画四边形进合成 RT；effect 全部留在合成链；最后用 passthrough 材质加 puppet 组合键，以 puppet 网格采样合成 RT 上屏，UV 不缩放。
  - 否则直接上屏：基础材质加 puppet 组合键，画 puppet 网格，UV 乘「图像宽高 / GPU 纹理宽高」（就是现有的 `textureUvExtent`），不内缩。
- **`BONECOUNT` 等于真实骨骼数**：不取 2 的幂，和模型路径不同。
- **蒙皮矩阵按我们的 uniform 布局写**：翻译器把 `g_Bones` 出成普通 uniform 块里的 `array<mat4x3<f32>, N>`，每项 64 字节。WPE 是单独的 b2 缓冲、每项 48 字节。数据相同、布局不同，所以按翻译器的反射写，不照搬 WPE 的字节。
- **重编译保留时钟**：同 P10，按 `(对象下标, 动画层下标)` 接回。

不选「CPU 蒙皮后当静态网格画」：总计划「决定」1 已定 GPU 蒙皮。

**P12a 不做、照报的细分键**（P12b–d 与语料 0 处）：
- `object:attachment`（P12b，键名不变）；
- `puppet:alpha`（网格 0 标志 bit2 → `SKINNING_ALPHA`）、`puppet:morph`（网格 0 格式含 `a_PositionVec4` → `MORPHING`）、`puppet:clipping`（网格 0 有 v23 记录）、`puppet:texture-channels`（任一网格带 bit1）：P12b；
- `puppet:layer-script`（动画层字段挂脚本，脚本里 `thisObject` 是 `IAnimationLayer`）：P12c；
- `puppet:physics`（骨骼 JSON 满足 `(r‖t) && (se‖re)`）：P12d；
- 语料 0 处的照报：
  - `puppet:ik`（`MDLS` v≥2 的记录、约束、键表、链表非空）；
  - `puppet:draw-order`（动画带绘制顺序轨道）；
  - `puppet:animation-ref`（`MDLA` 动画 flags bit0、记录轨道、约束轨道）；
  - `puppet:alpha-track` / `puppet:order-track`：两种会让 WPE 崩溃的组合，有骨骼透明度轨道但网格 0 没有 bit2、有绘制顺序轨道但没有 bit3；
  - `mdl:skeleton:bones`（骨骼数 > 128，WPE 直接终止进程）。

没有绘制顺序轨道时，绘制组不重排、保持文件顺序（p12-REPORT 用例 7）。所以可选块 2 在 P12a 里只解析、不起作用，没有键。

### 能解锁的场景

只差 P12a 的 13 张（P4–P11 先做完的口径）：
- `2896608544`、`3203778110`、`3243449890`、`3351072238`、`3354366708`、`3409595232`、`3487328036`；
- `3560756264`、`3811769317`、`3813473025`、`3814576310`、`3818986268`、`3828324728`。

其中 9 张 HEAD 上就只差 P12，P12a 合入即解锁（88 → 97）：
- `2896608544`、`3203778110`、`3354366708`、`3409595232`、`3811769317`；
- `3813473025`、`3814576310`、`3818986268`、`3828324728`。

## 现状锚点

**a. 图像层只读模型 JSON 的材质，pass 不加任何引擎组合键**（`compile/bundle.ts:1847`、`:1889`）
```ts
  async function compileImageModel(index: number, object: SceneObject, layer: SceneLayer): Promise<boolean> {
    const image = object.image!;
    const modelText = await fs.text(image);
    // …
    const model = parseModel(modelText);
    checkModelFeatures(model, unsupported); // 现状：`puppet` 是路径字符串，报 model:puppet
    // … solidlayer / instanced / nopadding / perspective / passthrough / fullscreen / alignment
    for (const [k, raw] of material.passes.entries()) {
      // …
      layer.passes.push(
        await compilePass(pass, {
          key: `objects/${index}/passes/${k}`, // 现状：context 只有 key（与 instanced 的 instanceSize），不加 SKINNING / BONECOUNT
          ...(instance ? { instanceSize: instanceReferenceSize(object.size) } : {}),
        }),
      );
    }
```

**b. mdl 的段只记标签、可选块读过即丢**（`compile/mdl.ts:119`、`:232`、`:272`）
```ts
export interface MdlMesh {
  // … materials / flags / format / stride / vertices / indices / vertexCount / indexFormat / indexCount / bounds
  /** v ≥ 21 的两个可选块、v ≥ 23 的记录表非空（木偶数据……）。 */
  puppet: boolean; // 现状：木偶数据只剩一个布尔
}
export interface MdlFile {
  version: number;
  skins: number;
  meshes: MdlMesh[];
  bounds: number[];
  sections: string[]; // 现状：尾部段只留标签
  truncated: boolean;
}
// parseMdl：段整段跳过
        file.sections.push(tag);
        const end = reader.u32();
        if (end < reader.pos || end > bytes.length) throw new Truncated();
        reader.pos = end; // 现状：MDLS / MDLA 内容不读
```

**c. 能力表：`SKINNING` 在引擎组合键表里，`g_Bones` 不是引擎 uniform，`animationlayers` 是未知对象键**（`compile/features.ts:172`、`:97`、`:814`、`:951`）
```ts
const ENGINE_COMBOS = new Set(["SPRITESHEET", "REFLECTION", "SKINNING", "SKINNING_ALPHA", "MORPHING", "PRELIGHTING"]);
// checkProgramFeatures
  for (const combo of result.combos ?? [])
    if (combo.value !== 0 && ENGINE_COMBOS.has(combo.name.toUpperCase()))
      unsupported.add(`combo:${combo.name.toUpperCase()}`); // 现状：给 puppet 加了 SKINNING 就会报 combo:SKINNING
// isEngineUniform：ENGINE_UNIFORMS 里没有 g_Bones → 读到就报 uniform:g_Bones
// checkObjectFeatures：animationlayers 不在 SUPPORTED_OBJECT → 报 object:animationlayers
// checkModelFeatures：model.puppet 是字符串 → 报 model:puppet
```

**d. 渲染图：模型对象整层走 `planModelLayer`，图像层的上屏几何只有四边形**（`render/graph.ts:613`、`:706`、`:834`）
```ts
  if (layer.model) return planModelLayer(layer); // 模型对象（P5c）
  // …
  const screenGeometry: Geometry = layer.fullscreen ? "fullscreen" : "layer"; // 现状：上屏几何只有四边形两种
  // 直接上屏：needsComposite 为假、不是组、不被依赖时
    steps.push({ kind: "draw", role: "direct", pass: base, /* … */ geometry: screenGeometry, uv, inset: directInset, /* … */ });
  // 合成路径：基础 pass geometry "fill" 画进合成 RT；最后一个 effect（或 passthrough）上屏 geometry screenGeometry
```

**e. draw 的几何：网格只认 `layer.model`，其余一律四边形**（`render/scene.ts:2582`、`:2634`、`:1505`）
```ts
    if (step.kind === "mesh") {
      const mesh = layer.model?.meshes[step.mesh]; // 现状：网格只从 layer.model 取
      // … meshBuffer 按 mdl 视图去重上传，meshVertexLayout 配对属性
    } else {
      const vertices =
        step.geometry === "fullscreen"
          ? layerQuad([2, 2], step.uv, step.inset)
          : /* shape / layer / fill */ layerQuad(this.layerSize(layer, state), step.uv, step.inset);
      const vertexData = program.vertexPacking.pack(vertices); // 现状：四边形按程序的打包
```

**f. 每帧 uniform：只写 `frameBuiltins` 与 ropetrail 的 `g_RenderVar0`**（`render/scene.ts:3528`、`render/uniforms.ts:79`）
```ts
  update(frame: FrameInput, _state?: SceneState): void {
    const values = (this.frameValues = frameBuiltins(frame));
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer) continue;
      if (!draw.frameNames.length && !draw.dirty && !draw.trailRenderVar) continue; // 现状：没有「每个 draw 每帧不同」的骨骼通道
      this.applyFrame(draw, values);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
      draw.dirty = false;
    }
  }
// UniformBlock.set：矩阵数组按元素 offset + i·stride、列主序写，rows === 3 时列步长 16（现状：有这条路径，但没有调用方写过矩阵数组）
```

**g. 帧循环：粒子 → 相机 → 声音 → 关键帧与脚本**（`render/renderer.ts:685`、`host.ts:944`）
```ts
    try {
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor); // 现状：对象更新只有粒子
    } catch (error) { /* … */ }
    // …
    scene.setCamera(camera);
    if (live) this.options.stepObjects?.(frametime); // 声音（P6a）
    if (live) this.options.beforeFrame?.(frametime, this.spectrum); // host：关键帧动画 → 脚本
```

**h. 绑定目标没有动画层**（`compile/bindings.ts:153`、`render/state.ts:532`）
```ts
export type BindingTarget =
  | { kind: "layer"; object: number; field: LayerField }
  // … effect / constant / bloom / general / particle-instance / sound / text / camera / user-texture / recompile
  // 现状：没有 animation-layer；animationlayers 里的 {user} 不登记
```

**i. dev 探针的回放：粒子之后接动画与脚本**（`dev/particleCorners.ts:666`、`:566`）
```ts
    scene.sync(state);
    replayAudio(scene, replay, i);
    scene.stepParticles(frametime, time, state, pointers.cursors[i]); // 现状：puppet 要接在这一句之后
    const eye = shake.apply(time);
    if (animations) {
      animations.frame(frametime, state);
      if (!scripts) scene.sync(state);
    }
```

## 步骤 1 — mdl 解析与 puppet 数据（`compile/mdl.ts` + 新建 `compile/puppet.ts`）

`compile/mdl.ts` 没有别的会话在改；`compile/puppet.ts` 是新文件。现在就能在工作区做。

### 点 1 — `parseMdl` 读出骨骼、动画与绘制组（`compile/mdl.ts`）

- **修改**
  - `MdlMesh` 加 `drawGroups`（可选块 2）、`records`（v23 记录表，保留 `{name, flags, list1, list2}`，P12b 用）、`blendRowCount`（标志 bit1 多读的 u32）。可选块 1 照旧丢弃。
  - `MdlFile` 加 `skeleton`（`MDLS`）与 `animations`（`MDLA`）。段的循环里按标签分派到 `readSkeleton` / `readAnimations`，其余段照旧跳过；读完核对恰好到段末偏移，不一致报 `mdl:section:<标签>`（语料 0 处）。
    > 说明：格式照 rea-p12-mdl 第 1、2、4、7 节，与 `ignore/p12/rea/mdl/mdl12.py` 一字一句对应。帧数据用原文件缓冲上的 `Float32Array` 视图，不拷贝，因为 4 字节对齐的才能直接建视图，不对齐时拷一份。
  - `MDLE`、`MDAT`、`MDMP` 照旧跳过（P12a 不用；`MDAT` / `MDMP` 在 P12b 读）。

```ts
export interface MdlBone {
  name: string;
  /** 文件里的 u32（rea-p12-mdl 1.2，只有 bit1 有运行时作用：物理）。 */
  flags: number;
  /** 0xFFFFFFFF 为根，读成 -1。 */
  parent: number;
  /** 局部 4×4（行主序、行向量约定，平移在第 4 行）。 */
  local: Float32Array;
  /** 骨骼 JSON 原文（P12d 解析物理；P12a 只用它判断 `puppet:physics`）。 */
  json: string;
}
export interface MdlSkeleton {
  version: number;
  bones: MdlBone[];
  /** v≥2 的可选骨骼矩阵（mdl+0x48，静止姿势的来源，rea-p12-runtime 7）；没有为 null。 */
  restMatrices: Float32Array[] | null;
  /** v≥3 每骨骼绘制顺序基数（mdl+0x1e8）。 */
  drawOrder: number[] | null;
  /** v≥2 的记录、约束、键表、链表个数（语料全 0，非 0 报 `puppet:ik`）。 */
  extras: { records: number; constraints: number; keyMaps: number; chains: number };
}
export interface MdlAnimation {
  /** u64，语料都 < 2³²：按 number 存，超出报 `mdl:animation-id`。 */
  id: number;
  name: string;
  mode: "loop" | "mirror" | "single";
  fps: number;
  /** 文件里的长度；帧数 = length + 1。 */
  length: number;
  flags: number;
  /** 每骨骼一条：flags 与 9 × (length + 1) 个 f32（平移、欧拉角弧度、缩放）。 */
  tracks: { flags: number; frames: Float32Array }[];
  /** v3 起的每骨骼透明度轨道、v6 的绘制顺序轨道、事件等：P12a 只记有没有，内容由 P12b / P12c 读。 */
  boneAlpha: boolean;
  drawOrderTrack: boolean;
  events: { time: number; json: string }[];
  /** flags bit0 的引用块、记录轨道、约束轨道（语料 0 处）。 */
  unsupported: boolean;
}
export interface MdlFile {
  // …原有字段
  skeleton: MdlSkeleton | null; // 新增
  animations: MdlAnimation[]; // 新增
}
```

### 点 2 — `compile/puppet.ts`：把 mdl 整理成 `ScenePuppet`

- **新增** `buildPuppet(file: MdlFile, layers: unknown, path: string): { puppet: ScenePuppet | null; issues: Set<string> }`。
  - **网格**：只取网格 0。索引一律按 `uint16` 读；标志 bit0 的 u32 索引不看，语料 0 处，照报 `puppet:index32`。顶点与索引是 mdl 视图。
  - **skinned 的判断**：网格 0 格式含 `a_BlendIndices`（0x800000）且骨骼表非空。为真时 `combos = { SKINNING: 1, BONECOUNT: 骨骼数 }`，否则是静态 puppet（`combos = {}`、不进运行时）。
  - **绑定姿势的逆**：`MDLS` 局部矩阵按下标沿父链完整 4×4 相乘，再照 glm 的标量 `compute_inverse` 求逆。全程 float32（rea-p12-runtime 6.1）。
  - **静止姿势**：来源矩阵有可选骨骼矩阵就用它，没有就用局部矩阵。分解成 T / q / S 时用快速倒数平方根（`0x5f375a86` 加一次牛顿），单位旋转的静止四元数是 `(0.99936533, 0, 0, 0)`，不是单位长度（rea-p12-runtime 7）。
  - **轨道**：每帧 9 个 f32 转成 `{t[3], q[4], s[3]}`，`q = qz·qy·qx`（半角，`Math.sin` / `Math.cos` 后 `fround`，rea-p12-mdl 4.5）。轨道 flags bit0 为 1 的骨骼不采样（mask）。
  - **动画层**：`animationlayers` 的每一项。
    - `animation` 按 id 在 `MDLA` 里找，找不到整层丢掉，不报；
    - `rate` / `blend` / `visible` / `additive` / `blendin` / `blendout` / `blendtime` / `name` 的缺省值 1 / 1 / 真 / 假 / 假 / 假 / 0.5 / ""；
    - 层顺序照 JSON。
  - **字段绑定**：`{user}` 的 `rate` / `blend` / `visible` 登记成 `animation-layer` 目标（点 4）；`{script}` 报 `puppet:layer-script`。
  - **细分键**：总体设计思路里「P12a 不做」那一串，在这里按 mdl 与 JSON 判定。
- **新增** `ScenePuppet` 类型（放 `compile/bundle.ts` 旁的 `compile/puppet.ts` 导出，bundle 只引用）：

```ts
export interface ScenePuppet {
  path: string;
  /** 网格 0：顶点格式、stride、顶点 / 索引视图（索引一律 u16）。 */
  mesh: { format: number; stride: number; vertices: Uint8Array; indices: Uint8Array; vertexCount: number; indexCount: number };
  /** skinned 时的组合键（`SKINNING` / `BONECOUNT`）；静态 puppet 为空对象。 */
  combos: Record<string, number>;
  /** 静态 puppet 为 null。 */
  skeleton: {
    parents: Int32Array;
    /** 每骨骼 16 个 f32，绑定姿势的逆。 */
    inverseBind: Float32Array;
    /** 静止姿势：每骨骼 T(3) q(4) S(3)，以及来源矩阵本身（没有可见层时直接用）。 */
    rest: Float32Array;
    restMatrices: Float32Array;
  } | null;
  animations: { id: number; mode: number; fps: number; length: number; mask: Uint8Array; frames: Float32Array }[];
  layers: PuppetLayerDef[];
}
export interface PuppetLayerDef {
  /** `animations` 的下标。 */
  animation: number;
  name: string;
  rate: number;
  blend: number;
  visible: boolean;
  additive: boolean;
  blendin: boolean;
  blendout: boolean;
  blendtime: number;
}
```

### 点 3 — 单测

- **新增** `compile/mdl.test.ts`（或扩现有的 P5c 测试）：
  - 用 `ignore/p12/defs/puppet.py` 的格式手写一个小编码器（照 P5c 的 `mdl_enc.py` 做法），造 v13 / v19 / v21 / v23、`MDLS0001`–`0004`、`MDLA0001` / `0003` / `0005` / `0006` 的字节；
  - 逐字段比解析结果；
  - 截断、段长不符、骨骼数 > 128 各一例。
- **新增** `compile/puppet.test.ts`：
  - 欧拉转四元数、静止姿势分解（含 `0.99936533`）、绑定姿势的逆，各几组值和 `ignore/p12/rea/runtime/posemodel.py` 的输出逐位比（把 python 输出抄成常量）；
  - 细分键各一例。
- **语料**（只在 `KABEGAME_WPE_ROOT` 指向 WPE 时跑）：137 个 mdl 全部解析不报 `mdl:section:*`，骨骼数、动画数、每动画帧数和 `ignore/p12/rea/mdl/run_corpus.py` 的统计一致。

**验收**：tsc 0 error；新增单测通过；语料测试的统计和 python 一致。

## 步骤 2 — puppet 运行时（新建 `src/puppet/`，只新建文件）

不碰任何共享文件，现在就能做。

### 点 1 — `src/puppet/pose.ts`：采样、混合、蒙皮

- **新增**，照 rea-p12-runtime 第 4–7 节与「对实现的含义」的伪代码：
  - `sampleLayer(anim, lo, hi, frac, out)`：平移、缩放按 `a + (b − a)·frac`；旋转先取最短路径（点积 < 0 时取负）再 nlerp。归一化用 `rsqrtps` 的近似：`1 / Math.sqrt` 后做一次牛顿，逐位误差 ≤ 2 ulp，同 P4 的「近似倒数不复刻」。
  - `blendInto(pose, sample, w, additive, rest)`：三种合成。
    - `w == 1` 且非加法：覆盖；
    - 非加法：T、S 按 `样本·w + 来源·(1−w)`，q 用 nlerp；
    - 加法：T、S 按 `来源 + (样本 − 静止)·w`；q 按 `来源 ⊗ nlerp(单位, conj(静止) ⊗ 样本, w)`。
  - `layerWeight(layer, clock)`：淡入时长 `min(D/2, blendtime)`、线性。非 single 第一次到 1 后清掉 `blendin`；淡出只在 single 有效；single 带淡出播完后恒 0（p12-REPORT 用例 2）。
  - `skinMatrices(pose | null, puppet, out)`：
    - 局部 `[R·S | T]`；
    - 没有可见层时直接用来源矩阵；
    - 父链用仿射相乘（运算顺序照 rea-p12-runtime 6.1）；
    - `K = B · 逆绑定`。
    - 输出每骨骼 12 个 f32，就是 `K` 的前三列，排成 4 行 × 3 列（行 = 原矩阵的行，xyz）。这正是 RenderDoc 里 `g_Bones` 的读法，也是 `UniformBlock.set` 给 `mat4x3` 要的顺序（见步骤 4 点 3）。

### 点 2 — `src/puppet/player.ts`：`ScenePuppets`

- **新增**：

```ts
export class ScenePuppets {
  constructor(list: readonly { object: number; puppet: ScenePuppet }[]);
  /** 推进全部动画层时钟、求姿势、算蒙皮矩阵（实时帧；dt 已钳到 [0.0001, 0.25]）。图层隐藏也推进。 */
  frame(dt: number, state: PuppetSink): void;
  /** 当前蒙皮矩阵（每骨骼 12 个 f32）；静态 puppet 没有。 */
  skin(object: number): Float32Array | null;
  /** 重编译时接回时钟、`blendin` 已清位：按 (对象下标, 层下标)。 */
  carryOver(previous: ScenePuppets | null): void;
  /** 探针在没有回放时按时间定位：时钟一次推进 `time` 秒（近似，回放时不用）。 */
  seek(time: number): void;
}
```

  - 每个动画层一个 P10 的 `AnimationClock`：
    - 帧率、长度、模式取自 `MDLA` 的动画记录；
    - `D = length / fps`，帧号 = `t / spf`；
    - `lo = trunc`、`hi = lo + 1`，回绕处照读码不插值。
  - `rate` / `blend` / `visible` 每帧从 `SceneState` 的动画层字段读（点 4 写进去）。`visible` 为假的层时钟不走、不参与混合。
  - P12a 不派发事件与播完回调（P12c），时钟收集的事件丢掉。

### 点 3 — 单测（用步骤 0 的 WPE 真值）

- **新增** `src/puppet/fixtures/`：从 `ignore/p12/` 挑小样本抄成 JSON（每个几 KB），测试不依赖 `ignore/`。每个样本的内容：
  - mdl 字节（base64）、动画层定义；
  - 从第 1 帧起的 dt 序列；
  - WPE 在若干帧的 `g_Bones`。

  样本：
  - 生成工程 `p12-modes`（12 个模式 / 帧率 / rate 组合）、`p12-fade`、`p12-mix`（覆盖、权重、加法、层序、隐藏的层、缺轨道）；
  - 语料 `3203778110`（三个 puppet）。
- **新增** `src/puppet/player.test.ts`：按 dt 序列推进，和 WPE 的 `g_Bones` 逐个比，容差 ≤ 5 ulp（步骤 0 读码模型的水平）。

**验收**：tsc 0 error；单测通过，残差和步骤 0 的 python 模型同量级（`check3203` 最大 1.9e-6、`p12-modes` 最大 2 ulp、`p12-mix` ≤ 5 ulp）。

## 步骤 3 — 编译期接线（`compile/bundle.ts`、`compile/features.ts`、`compile/bindings.ts`）

共享文件，别的会话正在改。在 HEAD 快照里实现，再三方合并（见「和其它会话的交界」）。

### 点 1 — 图像层读 `puppet`（`compile/bundle.ts` 的 `compileImageModel`）

- **修改**：模型 JSON 的 `puppet` 是字符串、且不是 fullscreen、不是组合层（WPE `0x22`）时：`readMdl`（P5c 的缓存）→ `buildPuppet` → `layer.puppet`。
  - mdl 读不到或网格为空时 `layer.puppet = null`，照常画四边形，不报（WPE 销毁 P、照常画）。
  - 上屏路径在这里定：`layer.puppet.composite = 有 effect || colorBlendMode ∉ {0, 31} || 被依赖`。
  - 直接上屏时：基础材质的 pass 另编一份「加 `puppet.combos`」的变体，放 `layer.puppet.passes`。`layer.passes` 不加，合成路径的基础 pass 要用不带组合键的那份。
  - 合成路径时：passthrough 材质（`passthroughMaterial(scene.version)`，P8 的那份）加 `puppet.combos` 与 `BLENDMODE`，编成 `layer.puppet.upload`。
    > 说明：WPE 合成上屏用的是 `effectpassthrough_4.json`（genericimage4）。版本条件 `ctx+0x1510` 没查清，先按 P8 的 `passthroughMaterial` 选，步骤 5 核对。
- **修改** `transferableBuffers`：收集 `layer.puppet.mesh` 与动画帧数据的缓冲。

```ts
export interface SceneLayer {
  // …
  /** puppet（P12a）：图像层的模型 JSON 带 `puppet` 且 mdl 有网格时有；网格 0 代替上屏的四边形。 */
  puppet?: (ScenePuppet & {
    /** 编译期定的上屏路径：有 effect / colorBlendMode 混合 / 被依赖时为 true（WPE 加载时置 0x10）。 */
    composite: boolean;
    /** 直接上屏的 pass（基础材质 + puppet 组合键）；composite 时为空。 */
    passes: ScenePass[];
    /** 合成路径的上屏 pass（passthrough 材质 + puppet 组合键 + BLENDMODE）；直接上屏时为 null。 */
    upload: ScenePass | null;
  }) | null; // 新增
}
```

### 点 2 — 能力表（`compile/features.ts`）

- **修改** `checkModelFeatures`：`puppet` 进 `SUPPORTED_MODEL`。不支持的用法由 `buildPuppet` 报细分键。
- **修改** `checkObjectFeatures`：图像对象上的 `animationlayers` 放行；模型对象上的照报（`3706286085`，随 P13）。
- **修改** `checkProgramFeatures` 的调用（`compilePass` 的 context 加 `puppet: true`）：puppet 的 pass 放行 `SKINNING` / `BONECOUNT` 组合键与 `g_Bones`（`PUPPET_UNIFORMS`，同 `PARTICLE_UNIFORMS` 的做法）。别的 pass 照旧报。
- `checkMdlFeatures` 只给模型对象用，不动。

### 点 3 — 动画层的绑定目标（`compile/bindings.ts`、`render/state.ts`）

- **新增** `BindingTarget` 的 `{ kind: "animation-layer"; object: number; layer: number; field: "rate" | "blend" | "visible" }`。
- **修改** `SceneState`：加 `animationLayers: Map<string, { rate: number; blend: number; visible: boolean }>`（键 `对象:层`）；`write` 加对应分支，值照 WPE 的描述符 setter（float / bool，`condition` 照 `bindingValue`）。
  > 说明：只给用户属性用。动画层字段挂脚本报 `puppet:layer-script`（P12c），P10 的关键帧值也不会落到这里（语料 0 处）。

**验收**：
- tsc 0 error；
- 新增单测：组合键与两种上屏路径、细分键、绑定目标各一例；
- 语料（`kbp corpus scan` 对快照，和 `ignore/p12/out/corpus-head.json` 比）：
  - `model:puppet`、`object:animationlayers` 从 puppet 场景上消失，换成预期的细分键；
  - 上面 9 张变干净；
  - 不带 puppet 的场景逐张不变。

## 步骤 4 — 渲染接线（`render/graph.ts`、`render/scene.ts`、`render/renderer.ts`、`host.ts`、dev 探针）

共享文件，同步骤 3 在快照里做。

### 点 1 — 渲染图（`render/graph.ts`）

- **新增** `Geometry` 加 `"puppet"`。
- **修改** `planLayer`：
  - `layer.puppet` 且不是 composite：直接上屏那一步用 `layer.puppet.passes[0]`、`geometry: "puppet"`、`inset: NO_INSET`，`uv` 照旧（= 图像 / GPU 纹理，就是 WPE 的 puppet UV 比例）。
  - composite：强制走合成路径，相当于 P8「被依赖」的那条：基础 pass 照旧（`fill`、不带组合键）、effect 全部留在合成链，最后上屏用 `layer.puppet.upload`、`geometry: "puppet"`、`uv: [1, 1]`、不内缩。
  - 模型对象（`layer.model`）的分派不变。

### 点 2 — draw 的几何（`render/scene.ts`）

- **修改** 建 draw：`step.geometry === "puppet"` 时：
  - 顶点用 puppet 网格。直接上屏时把 `a_TexCoord`（表序 7）乘 `step.uv` 后单独上传一份（`Math.fround` 逐个乘，同 WPE 加载时改顶点）；`uv` 为 (1, 1) 时直接用 mdl 视图（`meshBuffer` 去重）。
  - 索引 `uint16`，顶点布局用 `meshVertexLayout(program.attributes, mesh.format)`，拓扑三角形列表，`drawIndexed`。
  - 把 `meshLayoutOf` 从「只认 `layer.model`」扩成也认 puppet。
- 矩阵：直接上屏与上屏都走现有的 `direct` / `final`（passthrough）矩阵，含对齐偏移与视差；不乘 `size`，网格顶点本来就是图层局部像素。

### 点 3 — 每帧写 `g_Bones`（`render/scene.ts`）

- **修改** `Draw` 加 `puppet: number | null`（图层的对象下标；只有 skinned puppet 的 `"puppet"` draw 有）。
- **修改** `GpuScene` 加 `setPuppets(puppets: Pick<ScenePuppets, "skin"> | null)`。
- **修改** `update`：`draw.puppet !== null` 时 `block.set("g_Bones", skin)` 再写缓冲（同 `trailRenderVar` 的做法，这类 draw 每帧都写）。
  > 说明：`UniformBlock.set` 对 `array<mat4x3<f32>, N>` 按「每元素 4 列 × 3 行、列步长 16」写。`mul(vec4(p, 1), g_Bones[i])` 翻成 WGSL 后是 `g_Bones[i] * vec4(p, 1)`，列 c 就是原矩阵的第 c 行，所以 `skinMatrices` 的 12 个数原样传入。这一点在点 6 用 trace 对 WPE 的 `g_Bones` 实测确认，不靠推断。

### 点 4 — 帧循环与重编译（`render/renderer.ts`、`host.ts`）

- **修改** 渲染器：实时帧在 `stepParticles` 之后、`setCamera` 之前调 `options.stepPuppets?.(frametime)`。
- **修改** 宿主：
  - 换场景时建 `ScenePuppets(bundle 里的 puppet 图层)`，`carryOver` 旧的，交给 `GpuScene.setPuppets`；
  - `stepPuppets` 里 `scenePuppets.frame(dt, drawnState)`。
  - 建 GPU 资源之前先按当前时钟算一次姿势，避免第一帧闪出绑定姿势（同 P10 的 `write`）。

### 点 5 — dev 探针的确定性回放（`dev/particleCorners.ts`、`dev/probe.ts`）

- **修改** `replayEncoded` / `replayReadback` / `replayParticles` 的每帧：`stepParticles` 之后调 `puppets.frame(dt, state)`。
- **修改** `renderFrame`：从 bundle 建 `ScenePuppets`。有回放时沿同一串 dt 从第 1 帧推进；没有回放时 `seek(time)`。
- **修改** `render_scene` 的 `trace`：已能按名字解码 uniform，`g_Bones` 自然在里面。不另加工具。

### 点 6 — 单测与 GPU 核对

- **修改** `render/graph.ts` 的单测：puppet 直接上屏、composite、静态 puppet 各一例，看步骤与几何。
- **新增** `render/p12a.test.ts`（无 GPU）：`g_Bones` 写进 `UniformBlock` 后的字节，和翻译器反射的偏移、列步长核对。
- **dev app**：导入 `p12-modes`、`p12-fx`、`p12-fx2`、`3203778110` 的副本，`render_scene` 带 `trace` 读回，`g_Bones`、顶点输出和 WPE 抓帧比。这一步顺带确认 WGSL 管线能建出来（步骤 0 只在 Node 里翻译过）。

**验收**：
- tsc、vitest、Prettier 通过；
- dev app 里上面四个工程能渲染，`g_Bones` 与 WPE 逐帧 ≤ 5 ulp；
- 不带 puppet 的场景渲染逐字节不变（`kbp regress` 的案例全部相同）。

## 步骤 5 — 真机对照（照 `FINAL_CHECK.md`）

- **生成工程**：`p12-modes`、`p12-fade`、`p12-mix`、`p12-bind`、`p12-fx`、`p12-fx2`。WPE 录一段（已有抓帧可复用，帧时间在日志里），我们按同一串帧时间回放，逐帧整帧逐像素比，差异逐处解释到 draw 与值。
- **语料复制工程**：13 张里挑覆盖面最广的几张，用 `kbp content isolate` 只留 puppet 图层及其父链、依赖与 effect，去掉别的阶段的干扰（文本、粒子、视频）：
  - `3203778110`：三个 puppet、覆盖与权重层、带 effect；
  - `2896608544`：用户属性绑 `rate` / `visible`、68 根骨骼；
  - `3354366708`：静态 puppet；
  - `3828324728`、`3814576310`：骨骼多、带 effect。

  WPE 与我们用同一份工程，按 FINAL_CHECK 的原则 2–4 比。
- **9 张解锁场景**：整张在 dev app 里渲染一遍，记录能不能画、有没有退回，以及和 WPE 同一时刻的整帧差异。差异来自别的阶段的照样逐处归因。
- 已知差异：
  - `rsqrtps` 硬件近似带来的 ≤ 5 ulp；
  - 合成路径上屏材质的版本条件（如果和 P8 的选法不同）。

**验收**：生成工程与复制工程逐帧逐像素相同，或差异全部有解释；记一行一张。

## 步骤 6 — 收尾

- `cocs/wpe/WPE_SCENE.md` 加「puppet 与骨骼动画（P12a）」一节：数据、运行时、两条上屏路径、帧里的位置、细分键、已知差异；同步 `cocs/README.md` 的索引条目。
- `versions/latest/regression.md` 加 P12a 的用例（带样本名），`changelog.md` 一行：「新增可渲染的场景壁纸：带 puppet 骨骼动画的……」。
- `PLAN.md` 与总计划更新进度、能渲染数。
- 步骤 0 的读码与实测文档（[p12-REPORT](p12-REPORT.md) 与三份读码）随步骤 1 的提交一起提交。

## 和其它会话的交界

- **共享文件**：`compile/bundle.ts`、`compile/features.ts`、`host.ts`、`render/renderer.ts`、`dev/probe.ts`、`dev/particleCorners.ts` 正被 P5、P6、P8、P10、P11 的会话改；`render/graph.ts`、`render/scene.ts`、`render/state.ts`、`compile/bindings.ts` 也是热点。
  - 步骤 1、2 只动 `compile/mdl.ts`（目前没人改）与新文件，在工作区直接做；
  - 步骤 3、4 在 HEAD 快照（`ignore/p12/a/head`，`kbp snapshot`）的副本里实现，`kbp snapshot diff` 出补丁，合入时三方合并、按块暂存，同 P10 / P11 的做法。合入前先看一次各会话的状态。
- **P10**：动画层时钟用 `animation/clock.ts` 的 `AnimationClock`。P10 的会话正在改这个文件（P10b），合入时以它的接口为准，P12a 只用构造、`advance`、`t` / `D` / `spf` / `flags`。
- **P5b / P5c**：mdl 解析、网格缓冲与顶点布局复用 P5c。puppet 的 `0x22` 跳过规则来自 P5b。
- **P8**：合成路径上屏借 P8「被依赖」与 passthrough 的那条路，对齐偏移照 P8。
- **P12b–d**：细分键按总计划划分，P12a 只报不做。`ScenePuppets` 的接口留好：P12b 的骨骼透明度与变形、P12c 的 `IAnimationLayer`、P12d 的物理，都在 `frame` 里接。

## 风险

1. **`g_Bones` 的列与行**：翻译器把 `mul(vec, float4x3)` 翻成什么，没在真 WebGPU 上跑过。点 6 用 trace 对 WPE 的值确认；不对就在 `skinMatrices` 的输出处转置，不改翻译器。
2. **合成路径的上屏材质**：WPE 在 `ctx+0x1510` 的条件下在 `effectpassthrough_4` / `effectpassthrough` 之间选，条件没查清。先用 P8 的 `passthroughMaterial`，步骤 5 用 `p12-fx` 核对。
3. **共享文件**：步骤 3、4 动的文件多，三方合并的冲突多。补丁按文件分块，合入前先在快照上跑通全部测试。
4. **性能**：一张场景最多 21 个 puppet、单个最多 86 根骨骼。`ScenePuppets.frame` 每帧在 CPU 上采样、混合、算矩阵；步骤 4 用 dev 探针量每帧开销，需要时把没有可见层的 puppet 只算一次。

## 实施记录

### 步骤 1、2 — mdl 解析、puppet 数据与运行时（2026-11-14）

由实现代理完成，主会话独立核对。

**改动的文件**（都在 `apps/wpe-scene/src/`）：
- 修改：`compile/mdl.ts`、`compile/mdl.test.ts`；
- 新建：`compile/puppet.ts`、`compile/puppet.test.ts`、`puppet/math.ts`、`puppet/pose.ts`、`puppet/player.ts`、`puppet/player.test.ts`；
- 新建 fixtures：`puppet/fixtures/` 下 4 个 JSON（共约 110 KB）。生成脚本在 `ignore/p12/a/fix/`。

**做了什么**：
- `parseMdl` 读出 `MDLS` v1–v4、`MDLA` v1–v6、可选块 2 的绘制组、v23 记录表与标志 bit1 的 `blendRowCount`。原有字段与语义不变，模型对象的能力表结果不变（P5c 的测试全过）。
- 段没恰好读到段末时只记进 `sectionIssues`，不置 `truncated`。
- `buildPuppet` 产出 `ScenePuppet` 与细分键。
- `src/puppet/` 的运行时直接复用 P10 的 `AnimationClock`。

**和 WPE 比**（单测里按 dt 序列从第 1 帧推进，比 `g_Bones`）：

| 样本 | 最大差 | 最大 ulp | 逐位相同 |
|---|---|---|---|
| `p12-modes` | 1.19e-7 | 2 | 1386 / 1440 |
| `p12-fade` | 0 | 0 | 960 / 960 |
| `p12-mix` | 2.98e-7 | 5 | 1950 / 2040 |
| `3203778110` | 1.9e-6 | 3 | 220 / 240 |

四个样本和步骤 0 的 python 模型逐位相同。剩下的差都来自 `rsqrtps` 的硬件近似：模型用的是一次牛顿，WPE 是硬件近似值。

**语料**：137 个 mdl 全部读到段末，统计和 `ignore/p12/rea/mdl/stats.txt` 一致；`buildPuppet` 在语料上不报任何 `mdl:*` 键。

**主会话核对**：
- 改动范围只在上面这些文件；
- `apps/wpe-scene` 的 tsc 0 error；
- `mdl` / `puppet` / `src/puppet` / `p5c` 四组单测 156 个全过；
- 改动文件 Prettier 通过；
- 抽读 `pose.ts`：输出顺序是 K 的 4 行 × 前 3 列，和 RenderDoc 读到的 `g_Bones` 同序。

**和上文的出入**（都只增不改）：
- 类型：
  - `MdlSkeleton.count`；
  - `MdlFile.sectionIssues`；
  - `PuppetLayerDef.bindings`；
  - 动画类型叫 `PuppetAnimation`、多 `name`。
- 接口：
  - `buildPuppet` 多一个可选参数 `properties`（解析 `{user}` 的初值）；
  - `ScenePuppets` 多 `refresh(state?)`（不推进、按当前时钟重算，给步骤 4「建 GPU 资源前先算一次」用）。
- 细分键：
  - 多 `mdl:animation:tracks`（轨道数不等于骨骼数，语料 0 处）；
  - 只在 skinned 时起作用的键只在 skinned 时报，网格级的键总报。
- 其它：
  - `seek` 照 P10 的 `seek` 直接定位，不是「一次推进」；
  - fixtures 里的 mdl 先 gzip 再 base64。

**别的发现**：
- rea-p12-runtime 第 7 节把快速倒数平方根的结果抄成了 0.99830717，实际是 0.998308122，已在读码文档里更正。
- 全量 vitest 有 1 个失败，和本步无关：`compile/pipeline.test.ts` 的本机语料测试里，`3293687972` 读了 125 MB，超过 80 MB 上限。`parseMdl` 不读文件，`buildPuppet` 也还没接进 `bundle.ts`，所以不可能改变读取的字节数；这是同期别的会话的提交带来的。

**留给步骤 3、4**：
- `PuppetSink` 还没接 `SceneState`，`bindings` 还没登记成绑定目标；
- 宿主要按「新建 → `carryOver` → `refresh`」的顺序调用。

### 步骤 3、4 — 编译期与渲染接线（2026-11-14，进行中）

由执行代理（Sonnet）在独立工作树 `ignore/p12/a/wt`（基点 `69dc573f`）实现，主会话核对后三方合并进主工作区（祖先取基点；14 个改动文件无冲突，`script/runtime.ts` 在合并途中被别的会话改过，按它的新内容重新合并）。**还没提交，dev app 里的 GPU 核对还没做。**

**改动**：
- 修改 `compile/bindings.ts`、`compile/bundle.ts`、`compile/features.ts`、`compile/puppet.ts`、`compile/p5a.test.ts`、`dev/particleCorners.ts`、`dev/probe.ts`、`host.ts`、`puppet/player.ts`、`render/graph.ts`、`render/renderer.ts`、`render/scene.ts`、`render/state.ts`、`script/runtime.ts`；
- 新建 `render/puppet.ts`、`compile/p12a.test.ts`、`render/p12a.test.ts`。

**核对（工作树里）**：
- tsc 0 error；
- p12a / p5a / p5c / puppet / mdl / graph / state 相关单测 185 个全过；全量 vitest 只有 `compile/pipeline.test.ts` 的 `3293687972` 读取超限一处失败，和步骤 1、2 时相同，与本步无关。
- 语料（192 张，`ignore/p12/a/corpus-diff.txt`）：
  - 干净 100 → 110，新增的是子计划列的 9 张加 `3351072238`（puppet 默认被用户属性隐藏）；
  - 去掉的键：`model:puppet` 36 张、`object:animationlayers` 32 张；新增的只有预期的 `puppet:*` 细分键；
  - 非 puppet 场景逐张不变。
- `g_Bones` 的传法：翻译器把 `mul(vec4(p, 1), g_Bones[i])` 译成 `mat4x3 * vec4`（列向量），WGSL 的第 c 列就是 K 的第 c 行的 xyz，`skinMatrices` 的 12 个数原样传给 `UniformBlock.set`，不用转置。单测按 WGSL 的算法读回字节，和 WPE 的公式逐位一致。

**和子计划的出入**：
- 直接上屏的材质变体沿用基础 pass 的稳定键 `objects/N/passes/0`（常量、属性绑定、关键帧共用），重编后把重复登记的绑定截掉。
- `composite` 取 `layer.effects.length > 0`。写死不可见的 effect 编译期不进列表，和 WPE 的 effect 个数可能不同；语料里没有「puppet 的 effect 全部写死不可见」的（0 个），步骤 5 再核。
- 精灵表与纹理通道也会让 WPE 走合成路径，没做：这两类本来就在 `tex:animation` / `puppet:texture-channels` 下照报。

**合并进主工作区后**：
- 主工作区的 tsc 报 `script/runtime.ts` 找不到 `../render/cursor`；`compile/p5c.test.ts` 有 2 个失败（`cursor:model`、`disablepropagation`）。
- 两处都来自同期 P6c 会话还没写完的改动，不是本步的。

**GPU 核对受阻**：主工作区缺 `render/cursor` 时建不出场景宿主。共享的宿主产物不能用工作树的源码覆盖，要等主工作区能构建，再按主工作区建一次、在 dev app 里核对。
