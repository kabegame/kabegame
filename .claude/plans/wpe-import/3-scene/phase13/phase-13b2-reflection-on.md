# P13b2 — 反射开：反射 pass 与场景视图（子计划）

> 上级：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13b」。前一步：[phase-13b1-reflection-off.md](phase-13b1-reflection-off.md)（设置、两张 RT、「反射关」，`0e0f69fc`）。依据：[rea-p13-passes.md](rea-p13-passes.md) 第 1 节、[p13-REPORT.md](p13-REPORT.md) 第 3–7 条与下面「步骤 0 的结果」。
> 现状行号按 HEAD `0e0f69fc`（调研代理读的版本）。`render/scene.ts` 是 P13 冲突最多的文件：在独立工作树（HEAD 快照）里实现，验收后三方合并，按块暂存（同 P13b1）。
> 执行交 sonnet 子代理，验收由 Claude 独立做。

## 总体设计思路

WPE 设置开着反射、且场景里有模型读 `_rt_Reflection` 时，每帧在主 pass 之前多画一遍：把「反射名单」里的对象用一个镜像视图画进 `_rt_Reflection`。名单是可画对象中 `reflected` 不为 false 的，排除读 `_rt_Reflection` 的模型（整个对象），按 `objects` 顺序，不做透明排序。反射 pass 和主 pass 共用场景深度附件；`clearenabled` 开时反射 pass 先把颜色清成 `(clearcolor, 1)`、深度清成 0，关时两样都不清（接着上一帧画）。主 pass 照旧。

镜像视图只改相机给的那几样，模型矩阵、材质常量、每帧量都不变：
- **透视场景**：视图投影 `VP' = S·VP·S`（`S = diag(1, −1, 1, 1)`，WPE 行向量与我们列向量下写法相同，`S` 对称），MVP 按 `VP'` 现算；`g_EyePosition`、`g_ViewRight`、`g_ViewUp` 的 y 取反，`g_ViewForward` 不变。视锥剔除用 `VP'`。
- **正交场景**：视图投影与 MVP **不变**，只有眼位与两个视图向量的 y 取反（步骤 0 实测，推翻了读码的「同一段代码」）。反射图就是同一画面去掉不在名单里的对象再画一遍。

渲染器现在的结构是「一个 draw 一块独占 uniform 缓冲、一帧一次 submit」，同一个 draw 不能在一帧里用两套值各画一次。所以参加反射的 draw 各多一份**反射副本**：自己的 uniform 缓冲与 bind group，内容是主块的拷贝再盖上镜像视图的相机量；管线 LDR 下直接复用（场景目标与 `_rt_Reflection` 同为 `rgba8unorm`、深度附件相同），HDR 下另备一份格式换成 `rgba8unorm` 的管线，加载时异步建好。相机相关的值收进一个「场景视图」对象（`render/views.ts`）往下传，主视图与镜像视图走同一个 `uniformValues`，这样两份值的规则只有一处。

这一节支持四类对象进反射 pass（2026-11-14 用户：「粒子、文本也支持」）：**模型**（每个网格一次）、**直接上屏的图像层**（`direct` 角色：无 effect、不走合成，FR / CLK 测试图层就是这种）、**直接上屏的文本层**（背景 / 字形 / 彩色字形三步，透视场景里的文本仍照报 `camera:perspective:text`，归 P13h）、**粒子**（整棵系统树：sprite、拖尾、事件实例，按本帧 `forEachDrawn` 的同一次排列）。粒子的规则来自步骤 0 P10–P12：sprite 的朝向 `g_Orientation*` 是 WPE 在对象更新时按主视图写的，反射 pass 不重算（世界里的形状同主 pass，只换 VP）；拖尾的宽度方向在几何着色器里按本 pass 的 `g_EyePosition` 算，所以按镜像眼位展开——我们的着色器同样读 `g_EyePosition`，副本里放镜像眼位就对了。名单里有别的（带 effect 或合成的图层、组、形状、`perspective: true` 的图层、透视粒子 `flags & 4`、要快照的粒子如折射）时，反射开着就照报 `reflection:planar:<种类>`、整张退回：它们的上屏要先跑合成链或快照，在反射 pass 里重跑会改状态，WPE 怎么处理没测，语料 0 处。读反射图的三张场景（arsenal、audiophile、fantasticcar）名单里只有模型。

关键决策：
- **反射副本而不是动态偏移。** 现有 bind group 布局没有 `hasDynamicOffset`，改布局会碰全部程序；粒子实例池已经用「多一个 Draw / 多一块缓冲」解决同类问题，照着做，改动只落在参加反射的 draw 上，别的场景逐字节不变。
- **视图对象只收相机量。** `viewProjection`、`perspectiveViewProjection`、`sceneCamera`、`eye`、`viewVectors` 现在散在 `GpuScene` 的字段里、被 `uniformValues` / `viewProjectionOf` 直接读；收成 `SceneView` 后，主视图由 `setCamera` 填，镜像视图由 `mirroredView(主视图, 正交?)` 现算，`viewProjectionOf` 里按引用比较 `base === this.viewProjection` 的分支改成比较视图对象自己的字段。
- **不支持的种类照报，不画半成品。** 反射图画错比退回预览图更糟（地面颜色整片不同）；先把语料要的做对。

## 现状锚点

（摘自调研，行号按 `0e0f69fc`）

**a. 每个 draw 一块独占 uniform 缓冲，bind group 绑整块**（`render/scene.ts:689`、`:2883`、`:2908`；`render/programs.ts:200`）
```ts
  uniformBuffer: GPUBuffer | null;
  block: UniformBlock | null;
// createDraw
      uniformBuffer = this.own(device.createBuffer({ … }));
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
      if (uniformBuffer) list.push({ binding: 0, resource: { buffer: uniformBuffer } }); // 现状：没有偏移
// programs.ts
  if (program.uniforms?.length) entries.push({ binding: 0, visibility, buffer: { type: "uniform" } }); // 现状：没有动态偏移
```

**b. 相机量是场景级字段，`uniformValues` 直接读**（`scene.ts:1153`–`:1214`、`:3024`–`:3028`、`:3164`）
```ts
  private viewProjection: Float32Array = new Float32Array(16);
  private perspectiveViewProjection: Float32Array = new Float32Array(16);
  private sceneCamera: { projection: Mat4; view: Mat4 } = …;
  private viewVectors: ViewVectors = ORTHO_VIEW_VECTORS;
  private eye: readonly number[] = [];
// uniformValues
      eye: this.eye,
      view: this.viewVectors,
// viewProjectionOf
    if (base === this.viewProjection) { // 现状：按引用认主视图，走「在 V 上平移」的视差分支
      const { projection, view } = this.sceneCamera;
      return mulAffine(projection, translateGlm(view, [x, y, 0]));
    }
    return multiply(base, translation(x, y, 0));
```

**c. 相机变了重写全部 draw 的 CPU 块，`update` 按 draw 的脏标记整块上传**（`scene.ts:3305`、`:3720`、`:3758`）
```ts
    if (same && !this.cameraDirty) return;
    for (const draw of this.draws) this.refreshLayer(draw, state, worlds); // 现状：只有一份块
// update
      if (!draw.frameNames.length && !draw.dirty && !draw.trailRenderVar && draw.puppet === null) continue;
      this.applyFrame(draw, values);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
```

**d. encode：反射图只清屏，接着主 pass**（`scene.ts:4215`、`:4232`、`:4351`）
```ts
    this.reflectionTargets?.encode(encoder, clearcolor); // 现状：P13b1 的「反射关」
    const begin = (view: GPUTextureView = sceneView): GPURenderPassEncoder => {
      const scene = view === sceneView; // 现状：只有场景目标挂深度，别的目标按「组」处理
// model op 的视锥剔除
            frustumCulled(model.bounds, worldMatrixOf(op.layer.object, state.layers, worlds), this.viewProjection)
```

**e. 管线键带格式与深度，encode 同步取、缺了抛错**（`scene.ts:845`、`:879`、`:2094`）
```ts
  return `${program}|${blending}|${format}|${alpha}…${depth ? `|depth:${depthFlags(depth)}` : ""}…`;
    format: target.kind === "fbo" ? fboFormat(target.effect, target.name) : format, // 现状：场景目标格式，HDR 为 rgba16float
      if (!program || !pipeline) throw new SceneRenderError(["render:variant-missing"]);
```

**f. 编译期反射只有场景级的一个位**（`compile/bundle.ts:721`、`:2430`）
```ts
  reflection?: { planar: boolean };
      if (reflectionOn) unsupported.add("reflection:planar"); // 现状：反射开一律照报
```

## 步骤 0 的结果（2026-11-14，已做）

工程 `ignore/p13/b2/gen_b2.py` → `ignore/p13/proj/p13b2-{persp,noclear,ortho,cull}`；抓帧 `A:\p13b2\<persp|noclear|ortho|cull|ortho2>-on\`（`capture_sweep` 临时 `reflection: true`，三次扫描各自改回、`config.json` 哈希复原）；常量 `ignore/p13/b2/out/wpe-*-consts.json`，反射图 `ignore/p13/b2/wpe/*.png`。

| # | 问题 | 结果 |
|---|---|---|
| P1 | 名单 | 透视工程反射 pass 画 FR、CLK（图像层）、红、绿、蓝、探针；不画地面（读反射图的模型）与黄片（`reflected: false`）；顺序同 `objects` |
| P2 | 透视的视图投影 | 反射 pass 的 `g_ModelViewProjectionMatrix` 与探针的 `g_ViewProjectionMatrix` = `S·VP·S`（第 1 行、第 1 列取反，逐值）；`g_ModelMatrix` 不变 |
| P3 | 眼位与视图向量 | `g_EyePosition` (0, 3, 8) → (0, −3, 8)；`g_ViewUp` y 取反；`g_ViewRight` y 取反（0 → −0）；`g_ViewForward` 不变 |
| P4 | 无裁剪面 | 整个在地面以下的蓝片照样画进反射图 |
| P5 | 目标、深度、光栅 | `_rt_Reflection` 1920×1080 RGBA8；和主 pass 共用同一张深度（D32F），反射 pass 开头清颜色（清屏色，alpha 1）与深度，主 pass 再清一次；深度 GREATER、剔除同材质、写掩码 RGB（alpha 留在 1） |
| P6 | `clearenabled: false` | 一帧里没有任何清屏：反射图与深度都接着上一帧 |
| P7 | 正交场景 | 反射 pass 的 MVP / VP 与主 pass **逐值相同**（不镜像）；`g_EyePosition` (960, 540, 2000) → (960, −540, 2000)、`g_ViewUp` 取反。推翻读码「正交走同一段代码」 |
| P8 | 视锥剔除 | 品红片在主视图视锥外、镜像后在视锥内：反射 pass 画了、主 pass 剔了，剔除用镜像 VP |
| P9 | 正交的图像层 | 正交工程加图像层探针 PI（`ortho2-on`）：反射 pass 与主 pass 的 MVP 逐值相同，`g_EyePosition`、`g_ViewUp` 的 y 取反，同模型 |
| P10 | 透视的 sprite 粒子 | `p13b2-ptc`（`ptc-on`）：主 pass 四角 w 相同（正对相机），反射 pass 上下两边 w 为 8.9714 / 8.6866 = 按**主视图**的 up 在世界里展开、再乘镜像 VP（手算逐位相同）。`genericparticle.geom` 的 sprite 切线取 `g_Orientation*`，WPE 在对象更新时按主视图写，反射 pass 不重算 |
| P11 | 拖尾粒子 | 主 pass 的世界顶点乘镜像 VP 和反射 pass 差 0.135（形状变了）；两段的宽度方向都和「cross(速度, 中心 − **本 pass** 眼位)」平行（|cos| = 1.00000，另一个眼位 0.836）：`ComputeParticleTrailTangents` 读 `g_EyePosition`，反射 pass 用镜像眼位 |
| P12 | 正交的粒子与文本 | `p13b2-ptco`（`ptco-on`）：反射 pass 与主 pass 的输出顶点，sprite、文本（两个字形）逐值相同，拖尾差 0.0026（眼位翻了）；文本的 MVP、`g_Color4` 逐值相同 |

## 点 1 — 编译期：名单与照报（`compile/bundle.ts`、`compile/features.ts` 接线）

- **新增** `SceneLayer.reflected?: boolean`：对象的 `reflected` 不是 false（缺键、true、绑属性取当前值）时为 true；绑属性登记成重编译（名单在加载时定，语料 0 处绑定；2026-11-14 用户：「同意用户属性重新编译」）。读 `_rt_Reflection` 的模型（`reflectionReaders` 里 `model` 的那几个对象）为 false。
- **修改** `bundle.reflection` 加 `list: number[]`（`objects` 下标，按顺序），反射开时不再一律报 `reflection:planar`，改为对名单里每个对象判断种类：模型、无 effect 且不走合成的图像层与文本层、粒子（整棵树里没有 `flags & 4`、没有要快照的材质）可画；其余报 `reflection:planar:<种类>`（`effect`、`composite`、`group`、`shape`、`perspective`、`particle-perspective`、`particle-framebuffer`，按图层判定，判定函数单独导出便于测试）。名单为空时不画反射 pass（只清屏，同 WPE 有 bit0 而名单空）。
- 能力表里 `reflection:planar` 键不再出现。

## 点 2 — 场景视图（`render/views.ts` 新文件，`render/scene.ts` 接线）

```ts
/** 一个场景视图的相机量（P13b2）：主视图由 `setCamera` 填，反射视图由 `mirroredView` 现算。 */
export interface SceneView {
  viewProjection: Float32Array;
  perspectiveViewProjection: Float32Array;
  sceneCamera: { projection: Mat4; view: Mat4 };
  eye: readonly number[];
  viewVectors: ViewVectors;
}
/**
 * 反射视图（rea-p13-passes 1.3，步骤 0 P2、P3、P7）：透视场景 VP' = S·VP·S（三个 VP 都换），正交场景 VP 不变；
 * 两种场景都把 eye、right、up 的 y 取反，forward 不变。
 */
export function mirroredView(view: SceneView, orthographic: boolean): SceneView;
```
- **修改** `GpuScene` 的五个字段收成 `mainView: SceneView`，`uniformValues` / `viewProjectionOf` / 粒子几何（`refreshParticleGeometry`、`trailEye`）收一个视图参数，缺省主视图；`viewProjectionOf` 的引用比较改成比视图对象的 `viewProjection`。没有反射的场景逐字节不变（验收看命令轨迹）。

## 点 3 — 反射副本（`render/reflection.ts`、`render/scene.ts` 接线）

- **新增** 参加反射的 draw（名单里对象的「画到场景」步骤：模型的网格、直接上屏图像层的 `direct` 步骤、文本层的直接上屏三步、粒子的每次绘制）各建一份副本 `{ uniformBuffer, block, bindGroup, pipeline }`：块从主块拷贝，再按反射视图写相机量（`LAYER_UNIFORMS` 里的相机项）；bind group 与主 draw 相同、只换 binding 0；管线 LDR 用主 draw 的，HDR 用格式为 `rgba8unorm` 的那份（`populate` / `prepareVariants` 里一起异步建，`pipelineKey` 只改 `format`）。读 `_rt_Reflection` 的 draw 不在名单（同一纹理既采样又作附件会被 WebGPU 拒绝）。
- **修改** 刷新与上传：`setParallax` 相机脏时，同一轮给副本按反射视图重算相机量；`update` 里主块写完之后把每帧量同步进副本、整块上传（每帧量与主块相同，只有相机项不同）。`rebuildLayer` 换了 draw 时副本随之重建。
- **粒子**：副本里的 `g_Orientation*` 保留主块的值（步骤 0 P10，不按镜像视图重算），`g_EyePosition` 用镜像值（拖尾的宽度方向随之按镜像眼位，P11）。顶点缓冲两段共用（粒子顶点不含相机量）；`trailEye` 的退化判断仍按主视图的眼位，这是已知差异（只在速度与视线平行时影响跳不跳过那个粒子）。实例池里的 draw（事件实例）第一次进反射 pass 时建副本、之后复用；反射 pass 按主 pass 本帧 `arrangeParticles` 的同一次排列画，不另排。
- **文本**：直接上屏的三步各一份副本；重排（`textStats`）换了 draw 时副本随之重建。

## 点 4 — 反射 pass（`render/reflection.ts` 的 `ReflectionTargets.encode` 扩展、`render/scene.ts` 的 `encode` 接线）

```ts
// 主 pass 之前（替代 P13b1 的只清屏，设置关时仍只清屏）：
// clearenabled 开：颜色清成 (clearcolor, 1)、深度清 0；关：都 load（步骤 0 P6）
// 按名单顺序画每个对象的反射副本：模型逐网格（先用反射视图的 VP 做视锥剔除，步骤 0 P8）、图像层的 direct 步骤、文本的直接上屏三步、
// 粒子树（主 pass 本帧的排列，粒子顶点上传在反射 pass 之前完成）；不可见的对象跳过（同主 pass）
```
- 深度附件用场景的那一张（`depthTarget` 为 null 的场景反射 pass 也不挂深度，管线一致）。
- 「反射开」在 bundle 上：编译期把设置解析好写进 `bundle.reflection.enabled`，渲染器只看它。
- dev：`_rt_Reflection` 加 `COPY_SRC`，探针读回（`render_scene` 的 `trace.readback` 能按标签取到 `_rt_Reflection` 的反射 pass）。

## 点 5 — 测试

- `render/views.test.ts`：`mirroredView` 用步骤 0 的 WPE 常量逐值核对（透视工程的主视图 VP → 反射 VP、eye、up、right、forward；正交工程 VP 不变）。
- `compile/p13b2.test.ts`：名单（缺键 / true / false / 绑属性、读反射图的模型整体排除、顺序）；各种类的照报键；反射开且名单只有模型 / 直接图像层 / 直接文本 / 普通粒子时不报。
- `render/` 假设备：
  - 有名单时 encode 的命令轨迹：反射 pass（清屏规则、深度附件、每个副本一次绘制、副本的 bind group 与主 draw 只差 binding 0）在主 pass 之前；`clearenabled: false` 两样都 load；
  - 副本的块：相机项为反射视图的值，其余与主块逐字节相同，每帧量跟着主块更新；
  - HDR：副本用 `rgba8unorm` 管线、加载时建好、encode 不抛 `render:variant-missing`；
  - 视锥剔除按反射 VP；
  - 粒子副本：`g_Orientation*` 等于主块、`g_EyePosition` 为镜像值；事件实例的池化 draw 建副本、复用；反射 pass 与主 pass 用同一次排列；
  - 文本副本随重排重建；
  - 没有反射名单的场景：命令轨迹、uniform 字节与改动前逐项相同。

## 验收

子代理：宿主 tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过，Prettier。

Claude 独立验收：
1. `git status` 查越界；tsc、vitest 自跑；变异检查（S 少乘一边、正交也镜像、forward 也取反、剔除用主 VP、`reflected: false` 不排除、读反射图的模型进名单、`clearenabled: false` 仍清、副本没跟主块每帧量、HDR 管线用场景格式）。
2. 语料：反射关时与 P13b1 逐张相同；反射开时 arsenal、audiophile、fantasticcar 不再报键，别的场景只把 `reflection:planar` 换成细分键。
3. 确定性工程（`p13b2-*`，已录的 `A:\p13b2\` 抓帧与日志）：`renderFrames.ts` 按日志回放、反射开，和 WPE 整帧逐像素比；`trace.readback` 读回 `_rt_Reflection` 和 WPE 的反射图（`ignore/p13/b2/wpe/`）逐像素比；逐 draw 对常量（反射 pass 的 MVP、eye、视图向量）。
4. **按 FINAL_CHECK 走查**：arsenal、audiophile、fantasticcar（`*-kbp` 复制工程）用 `capture_sweep` 临时 `reflection: true` 各录 5 帧，按日志逐帧回放、逐像素比、逐处解释；反射 pass 逐 draw 对常量。
5. 没有反射名单的场景逐字节不变（基线场景的画面哈希与命令轨迹）。
6. 恢复：WPE 设置（`capture_sweep` 自动改回，核对哈希）、测试行 `projects_remove`。过后才请用户提交。

文档：`cocs/wpe/WPE_SCENE.md`「反射」一节改成「设置与反射 pass」，索引、回归、changelog 各一条；p13-REPORT 补步骤 0 的 P1–P8。

## 风险

1. **`render/scene.ts` 的大改与并行会话冲突**：场景视图要改 `uniformValues` 等核心函数的签名。在独立工作树实现、三方合并；签名改动只加参数（缺省主视图），减少和别人的块相交。
2. **每帧开销**：相机每帧都动（透视路径、抖动）时副本也每帧整块重算、上传。只落在名单里的 draw（语料三张各几个网格）。
3. **HDR 管线变体**：漏建会在 encode 时抛 `render:variant-missing`；单测覆盖 HDR 的加载与运行中切换（`rebuildLayer`）。
4. **正交场景的规则来自一个工程**：模型（P7）与图像层（P9）都核对过「VP 不变、只翻眼位与视图向量」；正交场景加相机对象、视差时没测（语料里读反射图的三张都是透视）。

## 已定（2026-11-14 用户：「粒子、文本也支持。同意用户属性重新编译。」）

1. **反射 pass 支持的对象**：模型、直接上屏的图像层、直接上屏的文本层、粒子；其余照报 `reflection:planar:<种类>`。
2. **`reflected` 绑属性**：登记成重编译。

## 实施记录（2026-11-14）

**实现**：sonnet 执行代理开工即撞周额度、没有改动，由 Claude 在独立工作树 `ignore/p13/b2/wt`（基于 HEAD `896e7f1c`）里实现，验收后三方合并进主工作区（祖先取工作树基点，7 个文件 0 冲突；HEAD 期间前进到 `487a6c26`，不碰本节的文件）。和上文点 2–4 的出入：
- **场景视图**（按点 2）：五个相机字段收成 `GpuScene.view: SceneView`；`uniformValues` 加 `view` 参数（缺省主视图），`viewProjectionOf(layer, state, view, perspective)` 按「是不是透视覆盖」取基准，不再靠和 `this.viewProjection` 比对象来认场景那一份。第一版为了不和并行会话的块相交，用 `withView` 临时换字段、签名不动；用户 2026-11-14 指出「不要为了避免冲突写不好的代码」，按本节改回。
- **副本**（`ReflectionCopy`）：第一次画到时建（`reflectionCopyOf`），draw 被重建时释放；相机项（`REFLECTION_CAMERA_UNIFORMS`，不含 `g_Orientation*`）在 `refreshLayer` 末尾按镜像视图现算成 overlay，编码时拷主块（`Uint8Array` 视图整块拷）再盖 overlay、`writeBuffer`。所以每帧量天然跟主块，事件实例的池化 draw 也走同一条。
- **反射 pass 在 `GpuScene.encode` 里**（不在 `ReflectionTargets.encode`）：按 `this.layers` 顺序遍历、只画名单里且本帧可见的，op 为 draw / particle-tree / model。粒子层一帧只排一次：`arrangeParticles` 改成返回排好的列表（draw 与快照标记），`encode` 按树缓存，反射 pass 与主 pass 用同一份（第一版调两次、靠幂等，同上改回）；视锥剔除抽成 `modelCulled`，两个 pass 各传自己视图的 VP。
- **`_rt_Reflection` 带 `COPY_SRC`**：同场景目标、合成 RT、泛光 RT（都带），dev 探针按标签读回。
- **`reflected` 对全部对象中性**：`features.ts` 的对象标志表跳过它，图像层不再报 `object:reflected`（`p5c.test.ts` 跟着改）。
- **dev 覆盖**（验收需要，新加）：`dev/reflectionOverride.ts`，`localStorage["kabegame-dev-scene-reflection"]` 为三档之一时宿主与 dev 探针都用它（探针另收 `reflection` 选项），生产构建摇掉。
- 点 2 的 `trailEye` 退化判断仍按主视图（已知差异照旧）；点 5 的「事件实例池化副本」「文本副本随重排重建」没有单独的单测，由副本按需建、随 draw 释放的同一条路覆盖。

**验收**（Claude）：
1. 范围：工作树 7 个改动 + 5 个新文件；主工作区另加 `dev/reflectionOverride.ts` 与 `host.ts` / `dev/probe.ts` 的接线。
2. tsc 0 error；Prettier 通过。返工前主工作区全量 vitest 166 个文件 3897 个全过；返工后在「HEAD `da553ea1` + 只有本节改动」的快照（`ignore/p13/b2/iso`：`scene.ts` 由合并结果重放两个重构脚本得到，`dev/probe.ts` 只做本节三处，和主工作区之差只剩渲染尺寸会话的块）上跑本节相关的 11 个文件 249 个全过（用户：全量等他说再跑）。
3. 变异 16 / 16 检出（`ignore/p13/b2/mutations.py`，`kbp mutate --mode workspace`，结果 `ignore/p13/b2/mutate2.txt`）：返工后加了「副本相机项按主视图算」「反射 pass 剔除用主视图 VP」「`viewProjectionOf` 不分透视覆盖」三处；剔除那处由 `p5c-mesh.test.ts` 新加的用例（只在镜像视锥里的模型只画进反射 pass）检出，第一版单测测不出。
   返工后真机重渲：四个确定性工程（persp、cull、ptc、ptco）像素摘要与返工前逐字相同，fantasticcar、audiophile 按日志回放的 10 帧 PNG 逐字节相同。
4. 语料（201 个工程，`ignore/p13/b2/corpus-{head,after,on}.json`）：跟随（WPE 反射关）与 HEAD 逐张相同；强制开（`scan-on` 副本把缺省设置换成 `enabled`）干净 139 不变，没有场景报 `reflection:planar:*`，只有读 mip 帧缓冲的 3453730450、3706286085 新增 `reflection:screen`（P13g）。
5. 确定性工程对 WPE（dev 覆盖为 `enabled`，`render_scene` 画布 1920×1080、按抓帧的 `g_Time` 与光标，粒子工程用 `make_track.py` 从 `kbp rdc consts` 拼时钟轨迹回放，`kbp cmp frame --kbp-layers`）：persp、ortho（对 `ortho2-on`，`ortho-on` 是加图像层探针之前的工程）、cull、ptc、ptco 整帧 0 差异；noclear 只差 RenderDoc 叠加文字（不清屏时留在后备缓冲里）；persp 的反射图读回（`trace.readback`）对 WPE 的反射图只差帧号块。cull 证实视锥剔除用镜像 VP（只在镜像视锥里的品红片画进了倒影）。
6. **按 FINAL_CHECK 走查**：arsenal、audiophile、fantasticcar（`*-kbp` 复制工程，WPE 反射开、fps 20、后处理超高，`A:\p13b2\<名>-on-fps20-1920x1080` 各 5 帧），`renderFrames.ts` 按日志逐帧回放（`--scripts --postprocess ultra`，audiophile 加 `--audio`）：

| 场景 | 帧 | > 0 | > 8 | 最大 | 判定 |
|---|---|---|---|---|---|
| arsenal | 223–227 | 5227–31756 | 0–9 | 105 | 已解释 |
| audiophile | 224–228 | 210–356 | 0–11 | 28 | 已解释 |
| fantasticcar | 221–225 | 15330–21042 | 1–12 | 134 | 已解释 |

- 倒影区域（读反射图的 grid）没有 > 8 级的差；> 8 级的全是孤立单像素、落在几何边上、不在反射区域，同 P13b1 的「网格边上的覆盖翻转」；arsenal 的反射名单实际为空（C12），只清屏。1–2 级的散差同 P13b1（着色与泛光的舍入）。
- 第一轮按后处理关闭渲染、整帧差 8 级：WPE 当时是超高档（别的会话改的，`config.json` 哈希 `d53b…`），按 `--postprocess ultra` 重渲后即上表。
7. 恢复：dev 覆盖已删、屏外宿主已关；测试行 14962–14970 已用 `projects_remove` 移除并核对；WPE 设置本节没改（`reflection: false` 是现值，抓帧时由 `capture_sweep` 临时开、自动改回）。

**没做**：
- 设置页切到开启看 Fantastic Car（回归 RB4）、绑属性的 `reflected` 真机切换（RB5）：同 P13b1 R4，运行中的 dev 构建还没有 `get_wpe_scene_reflection`，等用户重启 dev。
- 逐 draw 对常量（反射 pass 的 MVP、eye、视图向量）没再对真实壁纸做：确定性工程整帧 0 差，单测已用 WPE 的反射 VP 逐值核对。
