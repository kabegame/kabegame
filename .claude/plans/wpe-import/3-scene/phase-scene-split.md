# `render/scene.ts` 拆分

## 总体设计思路

`apps/wpe-scene/src/render/scene.ts` 有 7252 行，其中 `GpuScene` 一个类就占约 5800 行、326 个成员（字段与方法）。它同时是并行会话最常一起改的文件：粒子、文本、用户纹理、puppet、反射、阴影、相机各阶段都往里加字段和方法。改动互相覆盖的事已经出过（2026-11-18，P11b2 往这个文件写改动时把刚提交的 P13j-1 代码整段撤掉了）。拆分的目的有两个：一是让单个文件回到能读的尺度，二是让按功能分工的会话各改各的文件。

做法是**纯搬家，不改行为**。分两层：

- **第一层**：把类之外的 1100 行类型与纯函数（管线键、可渲染自查、内部类型、粒子的辅助函数、相机类型）搬进几个按主题分的模块。`scene.ts` 照原名再导出，50 个引用方一行不改。
- **第二层**：把 `GpuScene` 里自成一组的功能抽成协作类，**状态跟着代码走**。字段与方法一起搬进新类，新类只通过构造时传入的窄接口（`device`、`own` / `release`、几个取值函数）用到核心状态，不反向持有 `GpuScene`。
  - 按耦合从低到高排：相机、帧表 / 视频 / 灯光、puppet 资源、反射 / sprite / 阴影投射者、用户纹理、文本资源、粒子。
  - 牵动所有 draw 的那一步（比如视差变了刷新全部 draw）留在 `GpuScene`：协作类返回「变了没有」，由 `GpuScene` 去刷。

`GpuScene` 留下编排：建场景与对象增删（`build`、`populate`、`prepare*`、`install*`）、结构重排、`createDraw`、`uniformValues`、`sync` / `update`、`encode`、`destroy`。它的公开方法与签名全部不变，搬走的那部分改成一行转发。

关键决策：

1. **协作类，而不是「接收 `GpuScene` 的自由函数」**。自由函数要把约 100 个 `private` 字段全部放开，等于没有边界。协作类则让依赖变显式。耦合统计（下文锚点 b）表明，除了核心之外，各组对别组的引用大多在 15 次以内，窄接口写得下。
2. **每一步一个提交、逐字节不变**。验收是全库画面哈希与几段回放的哈希和拆之前完全相同，外加「搬动校验」脚本：每个搬走的成员，方法体去掉接收者前缀的改写后与原文逐字相同。所以每一步只能搬、不能顺手改。
3. **不改写大方法**。`createDraw`（326 行）、`encode`（410 行）、`uniformValues`（161 行）、`populate`（191 行）这一步不动。`encode` 按 op 拆成函数属于改写，单列为可选的最后一步，要另行决定。
4. **管线缓存与目标池放在后面，可选**。它们被别组引用最多（目标池 160 次、管线 53 次），抽出来改动面大、收益主要是行数。
5. **并行会话**：每一步开始前 `scene.ts` 不能有任何会话未提交的改动，搬完当场提交；别的会话之后按方法名到新文件里找原来的位置。这一条要你协调，见「时机」。

预计结果：做完第 1–8 点，`scene.ts` 约 4300 行（各点合计约 −2900）；加上可选的第 9 点约 3600 行，第 10 点约 3200 行。核心编排（约 2200 行）这次不拆，它是所有功能的交汇点，再拆就要改写。

## 现状锚点

**a. 文件构成**（2026-11-19，`b50240eb` 加工作区里 P11b2 未提交的 4 个块）

| 行 | 内容 |
|---|---|
| 1–170 | 文件头说明（渲染步骤、快照、合成 RT 池化、fbo 等） |
| 171–327 | 58 条 import |
| 328–1415 | 类之外的类型与纯函数：目标格式、`Draw` / `LayerRuntime` 等内部类型、步骤判别（`isPuppetDraw`、`isPrelitDraw`…）、粒子模板与计时、相机类型、`pipelineKey` / `stepPipeline` / `wantsDepth`、`checkRenderable` / `planProblems` / `buildableLayers` / `uploadableTextures` / `visibleObjects` / `layerOpsToRun` |
| 1416–1722 | `GpuScene` 的字段（约 110 个，各带说明） |
| 1723–7252 | `GpuScene` 的方法（约 215 个） |

**b. 按功能分组的耦合**（`ignore/refactor/scene_split/coupling.py`：成员按名字分组，统计成员体里 `this.<名>` 指向别组成员的次数）

| 组 | 行数 | 引用别组 | 被别组引用 | 主要成员 |
|---|---|---|---|---|
| 核心 | 2176 | 359 | 124 | `build`、`populate`、`createDraw`、`uniformValues`、`sync`、`update`、`install*`、`prepare*` |
| 粒子 | 642 | 46 | 34 | `trees`、`stepParticles`、`createParticles`、`uploadParticles`、`arrangeParticles`、`particleProbe` |
| encode | 447 | 79 | 22 | `encode`、`bloom`、`volumetrics`、`drawPhase` |
| 目标池 | 441 | 30 | 160 | `targets`、`createTarget`、`acquireFbo`、`ensureComposites`、`compositePool`、`layerTargets` |
| 用户纹理 | 366 | 29 | 11 | `userGpu`、`userGpuOf`、`syncUserTextures`、`rebindDrawInputs` |
| 管线 | 332 | 20 | 53 | `programs`、`pipelines`、`pipelineFor`、`prepareVariants*`、`syncPassStates` |
| 相机 | 257 | 2 | 61 | `view`、`setCamera`、`setParallax`、`viewProjectionOf`、`cursorCamera` |
| 文本 | 234 | 17 | 15 | `textFbos`、`syncTexts`、`relayoutTexts`、`ensureTextComposites` |
| puppet | 184 | 8 | 71 | `attachHook`、`stamps`、`writePuppetUniforms`、`uploadMorph`、`clipMask` |
| 阴影投射者 | 171 | 11 | 27 | `shadowAtlas`、`shadowCasters`、`buildShadowCasters`、`shadowCasterOf` |
| 结构重排 | 142 | 24 | 19 | `restructure`、`applyRestructure`、`structure`、`groupDepth` |
| 反射 | 141 | 9 | 34 | `reflectionTargets`、`reflectionCopies`、`refreshReflection`、`reflectedView` |
| sprite | 107 | 13 | 10 | `spriteCounters`、`encodeSprite`、`spriteSamples` |
| 灯光 | 80 | 5 | 8 | `refreshLights`、`frameLightValues`、`legacyFrame` |
| 帧表 | 67 | 1 | 3 | `sheetClocks`、`bindSheets`、`setSheetOverrides` |
| 视频 | 50 | 1 | 2 | `videoSink`、`copyVideo` |

**c. 相机这一组现在的样子**（字段在类的字段区，方法分散在 `setCamera` 一带；`setParallax` 只有最后一行碰核心）
```ts
  private view: SceneView = {               // 现状：本帧的主视图，核心读它 8 次（uniformValues、encode、反射、sprite…）
    viewProjection: new Float32Array(16),
    perspectiveViewProjection: new Float32Array(16),
    sceneCamera: { projection: new Float32Array(16), view: identity() },
    eye: [],
    viewVectors: ORTHO_VIEW_VECTORS,
  };
  private baseViewProjection: Float32Array = new Float32Array(16);
  private shake: [number, number] = [0, 0];
  private cameraDirty = false;
  private parallax: SceneParallax | null = null;
  // …

  setParallax(next: SceneParallax | null, state: SceneState): void {
    const current = this.parallax;
    const same = /* 比 amount 与 point */;
    if (same && !this.cameraDirty) return;
    this.parallax = next ? { point: [next.point[0], next.point[1]], amount: next.amount } : null;
    this.cameraDirty = false;
    const worlds = new Map<number, Mat4>();
    for (const draw of this.draws) this.refreshLayer(draw, state, worlds);   // 现状：唯一碰核心的一行
  }
```

**d. 测试直接读内部字段**（27 个测试文件经 `as unknown as {…}` 读 `GpuScene` 的私有成员）
```ts
// src/render/parallax.test.ts:1708
const zoomOf = (scene: GpuScene) => (scene as unknown as { zoom: number }).zoom;
// src/render/p4f1.test.ts:220
const system = (scene as unknown as { trees: Map<number, { system: ParticleSystem }> }).trees.get(1)!.system;
```
按字段计的文件数：`draws` 15、`layers` 9、`trees` 2、`pipelines` 2、`structure` 2、`parallax` 2、`zoom` 1、`particleFps` 1、`targets` 1、`targetClear` 1、`refreshLayer` 1。`draws`、`layers`、`structure`、`refreshLayer` 留在核心，不受影响；其余随所在的那一步改。

**e. 引用方**：50 个文件从 `./scene` 导入，名字是 `GpuScene`（36 个文件）、`checkRenderable`（8）、`stepPipeline`（7）、`pipelineKey`（6）、`visibleObjects`、`SceneCamera`（各 4）、`uploadableTextures`、`PreparedObject`（各 3）、`buildableLayers`（2）等。`cocs/wpe/WPE_SCENE.md` 有 18 处提到 `scene.ts` 或 `GpuScene.<方法>`。

## 点 1 — 类之外的类型与纯函数搬出（`render/scene.ts` → 四个新模块）

- **新增**
  - `render/sceneTypes.ts`：内部类型与步骤判别。包括 `RenderTarget`、`SceneTarget`、`LayerResources`、`LayerRuntime`、`LayerHandle`、`Draw`、`DrawLike`、`PreparedDraw`、`TextDraw`、`MeshDraw`、`ParticleDraw`、`ReflectionCopy`、`UserGpu` / `UserAnim` / `UserRef` / `UserResolved`、`TextureSize`、`Op`，以及 `isPuppetDraw`、`isTexchanDraw`、`isPrelitDraw`、`prelitModel`、`drawsMesh`、`isDrawLike`、`baseUserSlot`、`sameTargetShape`、`texelBytes`。
  - `render/scenePipelineKey.ts`：`PipelineSpec`、`pipelineKey`、`stepPipeline`、`wantsDepth`、`shadowPipelineKey`、`groupPrograms`、`samePlacement`。
  - `render/sceneCheck.ts`：`checkRenderable`、`planProblems`、`particleAttributeProblems`、`wantsSnapshot`、`buildableLayers`、`uploadableTextures`、`visibleObjects`、`layerOpsToRun`、`drawsToScene`。
  - `render/sceneParticles.ts`（第 8 点的落脚处，先放纯函数）：`ParticleTemplate`、`ParticleTree`、`ParticleArrangement`、`sameParticleDefinition`、`particleUnits`、`particleFloats`、`ParticleTiming`、`recordSample`、`timingStats`、`ParticleProfile`、`ParticleOptions`、`defaultParticleOrdinals`、`writeSegments`、`INSTANCE_UNITS_MIN`、`PARTICLE_TIMING_FRAMES`。
- **修改**
  - 相机类型 `OrthographicSceneCamera` / `PerspectiveSceneCamera` / `SceneCamera` 搬进 `render/camera.ts`。它现在从 `./scene` 导入这几个类型，搬过去顺带消掉一条循环引用。
  - `scene.ts` 照原名再导出全部公开名字，引用方不动：
```ts
// render/scene.ts 文件头说明之后（新增）：拆出去的公开名字照原样再导出，50 个引用方不改 import
export { checkRenderable, buildableLayers, uploadableTextures, visibleObjects, layerOpsToRun } from "./sceneCheck";
export { pipelineKey, stepPipeline, wantsDepth, type PipelineSpec } from "./scenePipelineKey";
export { sameParticleDefinition, timingStats, type ParticleProfile, type ParticleOptions } from "./sceneParticles";
export type { OrthographicSceneCamera, PerspectiveSceneCamera, SceneCamera } from "./camera";
```
- **删除** `scene.ts` 里这 1100 行原文。
- 测试不用改；约 −1050 行。

## 点 2 — 相机视图（新增 `render/sceneView.ts` 的 `SceneViewState`）

- **新增** `SceneViewState`，持有相机组的 23 个成员：`view`、两份基准矩阵、`shake`、`zoom`、`pointerZoom`、`cursorCrop`、`anchorEdges`、`crop`、`cameraDirty`、`objectCamera`、`parallax`，以及 `setCamera`、`applyPerspective`、`applyCameraObject`、`viewProjectionOf`、`setAnchorEdges`、`anchorEdgesNow`、`setCursorCrop`、`cursorEdges`、`cursorViewProjection`、`cursorCamera`。
  - 构造参数只有 `bundle.general` 与编译期 zoom。`viewProjectionOf` 要的根对象由调用方传入，不读核心。
```ts
// render/sceneView.ts（新增）
export class SceneViewState {
  view: SceneView = { /* 原样搬来 */ };
  private baseViewProjection = new Float32Array(16);
  // … 其余字段原样
  constructor(private readonly general: SceneGeneral, zoom: number) { /* 原构造里的相机初值 */ }

  /** 原 `setParallax` 的前半段：值没变且相机不脏时返回 false；变了就记下并清掉脏标记。 */
  setParallax(next: SceneParallax | null): boolean { /* 原样 */ }
  viewProjectionOf(layer: SceneLayer, state: SceneState, view: SceneView, perspective: boolean): Mat4 { /* 原样 */ }
  // …
}
```
- **修改** `GpuScene` 持有 `readonly camera: SceneViewState`，公开方法改成转发；牵动全部 draw 的一步留在这里：
```ts
// render/scene.ts（修改）
  setParallax(next: SceneParallax | null, state: SceneState): void {
    if (!this.camera.setParallax(next)) return;          // 修改：比较与记录在 SceneViewState
    const worlds = new Map<number, Mat4>();
    for (const draw of this.draws) this.refreshLayer(draw, state, worlds);
  }
```
  - 核心里 44 处 `this.view` / `this.crop` 等改成 `this.camera.view` / `this.camera.crop`。
- **修改** 测试：`parallax.test.ts` 读 `zoom`；读 `parallax` 的 2 个文件改成经 `camera` 读。
- 约 −230 行。

## 点 3 — 小块：帧表、视频、灯光

- **新增**
  - `render/sceneSheets.ts` 的 `SheetBinder`：`sheetClocks`、`sheetSlots`、`sheetFrameNo`、`sheetDt`、`sheetOverride`、`bindSheets`、`setSheetOverrides`、`sheetClockOf`。要的 `extraTextures` 从构造参数传入。
  - `render/sceneVideo.ts` 的 `VideoBinder`：`videoSink`、`videoWarned`、`copyVideo`、`warnVideo`。
  - `render/sceneLights.ts` 的 `LightUniforms`：`lightFrameCache`、`lightState`、三个 `legacy*`、`refreshLights`、`frameLightValues`、`legacyFrame`。要的视图、挂点、阴影图集从构造参数传入取值函数。
- **修改** `GpuScene` 的 `setSheetOverrides`、`sheetClockOf`、`setVideoSink` 改成转发。
- 测试不涉及；约 −170 行。

## 点 4 — puppet 的 GPU 资源（新增 `render/scenePuppets.ts` 的 `PuppetGpu`）

- **新增** `PuppetGpu`：`puppets`、`attachments`、`attachedLayers`、`attachHook`、`hasAttachment`、`stamps`、`stampUpdated`、`drawSeeds`、`onesCache`、`morphTargets`、`clipMask`，以及 `ensurePuppetResources`、`createClipMask`、`uploadMorph`、`setPuppets`、`liveSeeds`、`attachedList`、`writePuppetUniforms`、`attachPose`。
  - 依赖：`device`、`own`、`sampler`、`createTarget`、`targetBytes` 的增减、场景宽高。
- **修改** 被别组引用 71 次（粒子 21、encode 9、结构重排 5、核心 34），大多是 `this.attachHook` / `this.stamps`，改成 `this.puppets.attachHook`。
  - `attachHook` 原是箭头函数字段，搬过去仍是箭头函数，传给 `worldMatrixOf` 的引用不变。
- 约 −160 行。

## 点 5 — 反射、sprite、阴影投射者

- **新增**
  - `render/sceneReflection.ts` 的 `ReflectionDraws`：`reflectionTargets`、`reflectionSet`、`reflectionSeen`、`reflectionCopies`，以及 `reflectedView`、`reflects`、`refreshReflection`、`reflectionCopyOf`、`createReflectionGroup`、`reflectionGroupOf`、`reflectionPipeline`、`syncReflectionList`、`reflected`。
    - `reflectionCopyOf` 要的 `uniformValues` / `bindGroupOf` 由构造参数传入函数。
  - `render/sceneSprite.ts` 的 `SpriteOcclusion`：`spriteCounters`、`spriteTarget`、`spriteTexture`、`encodeSprite`、`spriteCounter`、`spriteCountTarget`、`createSpriteTarget`、`spriteSamples`。
  - `render/shadowCasters.ts` 的 `ShadowCasters`：`shadowAtlas`、`shadowCasters`、`shadowCasterRecords`、`shadowPipelines`、`readyShadowPipelines`、`buildShadowCasters`、`shadowCasterSteps`、`prepareShadowCasters`、`prepareShadowCastersNow`、`shadowPipelineFor`、`installShadowCasters`、`shadowCasterOf`。
    - 它要 `createDraw` / `indexDraw`（建投射者的 draw），由构造参数传入。
- **修改** `GpuScene` 的 `spriteSamples`、`buildShadowCasters` 改成转发。
- 测试不涉及；约 −380 行。

## 点 6 — 用户纹理（新增 `render/sceneUserTextures.ts` 的 `UserTextureGpu`）

- **新增** `UserTextureGpu`：`userProvider`、`userGpu`、`userWarned`、`userWritten`、`gammaPass`，以及 `userCrop`、`userGpuOf`、`uploadUserFrame`、`userAnimationsOf`、`drawnUserAnimations`、`warnUser`、`userSampler`、`resolveUser`、`userBaseOf`、`releaseUnusedUserTextures`、`userWhiteout`。
- **不变** `syncUserTextures`、`rebindDrawInputs`、`rebindDependents`、`ensureUserSizing` 留在核心：它们遍历图层与 draw、调 `rebuildLayer`。只把其中查用户纹理的部分改成调 `UserTextureGpu`。
- 测试不涉及；约 −220 行。

## 点 7 — 文本资源（新增 `render/sceneTextGpu.ts` 的 `TextGpu`）

- **新增** `TextGpu`：`atlasTextures`、`relayouter`、`textFbos`、`atlasResets`、`textCounts`、`textTimings`，以及 `ensureTextComposites`、`createTextFbo`、`createTextFbos`、`resizeTextFbos`、`ensureTextResources`、`textAtlasesOf`、`textLayersUsing`、`textStats`。
- **不变** `syncTexts`、`relayoutTexts` 留在核心（它们调 `rebuildLayer`），只改调用。
- 测试不涉及；约 −150 行。

## 点 8 — 粒子（`render/sceneParticles.ts` 加 `ParticleDraws`）

- **新增** `ParticleDraws`：`particleIndices`、`particleOrdinals`、`particlePasses`、`particleFps`、`particleSeed`、`particleROverride`、`particleAudio`、`particleCursor`、`particleTimings`、`trees`，以及 `ensureParticleIndices`、`createParticleTree`、`attachMatrix`、`transformMatrix`、`particleScript`、`adoptParticleScripts`、`setFrameRate`、`markParticlesStale`、`createParticles`、`particleModel`、`refreshParticleGeometry`、`stepParticles`、`uploadParticles`、`growParticles`、`walkParticles`、`arrangeParticles`、`assignParticles`、`addPooledGroup`、`modelCulled`、`particleStats`、`profileParticles`、`particleProfile`、`particleProbe`、`particleCapacityOf`。
  - 依赖 puppet（挂点、戳）、相机（光标视图投影）、核心的 `drawsByLayer`、`applyFrame`、`frameValues`，都由构造参数传入。
- **修改** `GpuScene` 的 `stepParticles`、`particleStats`、`particleProfile`、`particleProbe`、`setFrameRate`、`attachMatrix`、`transformMatrix`、`particleScript`、`adoptParticleScripts`、`profileParticles` 改成转发；`particleAudio` 公开字段改成 getter。
- **修改** 测试：读 `trees` 的 2 个文件、读 `particleFps` 的 1 个文件改成经 `particles` 读。
- 约 −560 行。

## 点 9（可选）— 管线缓存与目标池

- **新增**
  - `render/pipelineCache.ts` 的 `PipelineCache`：`programs`、`pipelines`、`readyPrograms`、`readyPipelines`、`samplers`、`passState*`，以及 `ensureProgram`、`pipelineFor`、`pipelineNow`、`createPipelineNow`、`capturePipeline`、`pipelineOf`、`sampler`、`samplerFor`、`meshLayoutOf`。
  - `render/targetPool.ts` 的 `TargetPool`：`targets`、`freeTargets`、`fboPool`、`compositePool`、`layerTargets`、`targetBytes` 计数，以及 `createTarget`、`releaseTarget`、`createFbo`、`acquireFbo`、`releaseFbo`、`addTarget`、`dropTarget`、`createLayerTarget`、`ensureComposites`、`compositeSizeOf`。
- **修改** 被别组引用 213 次，改动面最大；测试读 `pipelines` 的 2 个文件、读 `targets` 的 1 个文件跟着改。`targetBytes` 是探针读的公开字段，改成 getter。
- 约 −700 行。要不要做由你定。

## 点 10（可选，属于改写）— `encode` 按 op 拆函数

`encode`（410 行）是一个大 `switch`，按 op 种类拆成 `render/sceneEncode.ts` 里的函数，共用一个本帧的编码上下文。这一步不是搬家，方法体会变，「搬动校验」用不上，只靠哈希与回放验收。单独决定。约 −400 行。

## 验收（每一步相同）

1. **类型与单测**
   - `apps/wpe-scene` 的 tsc 0 error。
   - wpe-scene 全量 vitest。这一步动的是全场共用的文件，只跑相关文件不够，**要你同意每步跑全量**。现有的已知失败（`compile/refract.test.ts` 一条，P6e 第 4 步之后的期望）单独列出，不算这次的。
2. **搬动校验**（新写 `ignore/refactor/scene_split/movecheck.py`）：按成员名在拆之前的 `scene.ts` 与拆之后的各文件里取方法体，把 `this.camera.` / `this.host.` 这类改写还原成 `this.` 后逐字比较。不同的逐条列出、人工核对。
3. **画面哈希**
   - 第 1 点之前跑一次全库基线（`hash_baseline`，3 档，约 35 分钟），全部做完再跑一次，用 `hash_compare` 比，要求逐字节相同。
   - 中间每一步跑一个覆盖子集（约 40 张，选法：每组功能至少 3 张），约 6 分钟。
4. **回放**（覆盖每帧推进的路径：粒子步进、puppet、文本重排、反射、阴影）：几段固定的 `render_scene` 回放，拆前拆后哈希相同。
   - Artorias 复制工程第 208 帧，现在是 `fbe5185a…`；
   - P4 粒子案例一段、P6b 文字时钟一段、P13d 阴影一段、P13b2 反射一段。
5. **文档**：`cocs/wpe/WPE_SCENE.md` 18 处、`cocs/README.md` 3 处提到 `scene.ts` 或 `GpuScene.<方法>`，按新位置改。历史计划与报告不改。

## 时机与并行会话

- **前提**：开始每一步之前，`git diff HEAD -- apps/wpe-scene/src/render/scene.ts` 必须是空的。现在不满足：工作区里有 P11b2 的 4 个块（粒子 draw 跟着用户纹理重绑），要等它提交。
- **一步一提交**：每一步在一次会话里做完、验收、当场提交，期间没有别人的改动混进来。别的会话之后在自己的工作区里，按方法名去新文件里找原来的位置。搬动是逐字的，对方的改动可以原样贴过去。
- **要你做的**：在开始前告诉正在改 `scene.ts` 的会话先提交或暂停。姐姐不主动给别的会话发消息。

## 实施记录

（实现后补）
