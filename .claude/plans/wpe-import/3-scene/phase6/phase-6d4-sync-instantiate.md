# P6d4 — 运行中建层的同步实例化（子计划）

> **2026-11-16 起不再执行**：并入横切重构「活的场景图」（[../phase-live-scene.md](../phase-live-scene.md)「已定」1）。本文的盘点、步骤 0、改键分别进了 L0、L1、L3–L5，留作参考。

> 上级：[phase-6d-dynamic-layers.md](phase-6d-dynamic-layers.md)「后续步骤」4；前一步 [phase-6d3-runtime-layers.md](phase-6d3-runtime-layers.md)（P6d3b 已提交 `88be89b3`）。
> 现状盘点（只读代理，2026-11-16）：`ignore/p6/d4/inventory.md`。本文的「改键」「运行时要补」清单出自它，行号以函数名为准（盘点时 `render/scene.ts`、`script/api.ts` 有别的会话在改）。
> 已定（沿用）：P6d「已定」3（第一次出现的配置晚几帧出现，作为已知差异）、P6d3「已定」3（`update` 里建的改成「编过的配置同步实例化」）。

## 总体设计思路

P6d3b 之后，运行中 `createLayer` 是对的但慢：每建一个对象就整场重编译（编译、建 GPU 场景约 0.5–0.8 s），新对象晚一段才画；建了又删、再建同样配置的（`p6d-cycle` 每 4 帧建删一次、dino_run 反复建删金币）每次都重编，而且对象往往在重编完之前就删了，于是永远画不出来。WPE 是当帧建、当帧画（P6d 步骤 0 实测）。

P6d4 的做法是**按模板克隆**：新配置规整之后（`normalizeConfig`，去 `id`、键排序）如果和当前 bundle 里某个已经编译过的对象的配置相同，这个对象就是模板。把模板编好的一切——`SceneLayer`、它的属性绑定、脚本条目、关键帧、声音 / 灯 / 相机条目——换成新对象的下标复制一份，当场加进 `SceneState`、`GpuScene` 与宿主的各张表。程序、管线、纹理、网格缓冲都是同一个 bundle 里的，直接共用：`pipelineKey` 不含对象下标，模板加载时备好的管线在 `readyPipelines` 里，克隆同步取得到（运行中 `rebuildLayer` 本来就这样取）。整个过程同步，`createLayer` 返回时新对象已经在画面里，这一帧就画、读得到真实的 `size`（P6d3b 的「编译前读不到自动尺寸」在这条路上消失）。

模板从两处来：
- **当前 bundle 里活着的对象**：克隆 `getInitialLayerConfig(现有图层)` 当场命中；已经编进 bundle 的运行中新建对象也是。
- **编译保留的模板**：结构里「建了又删」的新建对象，编译照常编一份，但不进 `layers`、不画，整条记录（图层、绑定、脚本、关键帧……）放进 `bundle.templates`，GPU 场景加载时只备它的程序与管线。这样建删循环第一次走重编译之后，以后都是同步的。

没有模板的配置（第一次出现）照 P6d3b 走重编译，晚一段出现，是已定的已知差异。另有几类克隆起来要新接线、量大或语料用不到的，也退回重编译：文本、puppet 与带骨骼的模型、体积光灯、带挂点的、父链上有组的、模板被依赖的、加载进行中的。退回不是照报：对象照样建出来、字段与脚本照常，只是晚一段画。

关键决策：
- **克隆而不是增量编译**。在 Worker 里只编一个对象需要把编译管线拆成可增量的形状（纹理与程序表的下标合并、依赖名字表、组归属），工作量远大于改键；而 WPE 场景里运行中建的对象几乎都是同一配置反复建（音频条、金币、对象池），模板命中率高。
- **改键是确定的字符串前缀替换加少数几个数字字段**：编译产物里含对象下标的字符串只有 `objects/<i>/…` 这一种形状（pass 键、绑定路径、脚本 id、关键帧 id），数字字段是 `object`、`parent`、`group`、`subtree` 与各表条目的 `object`。克隆函数是纯函数，单测逐字段对照「同一配置在新下标上真重编译的结果」。
- **一条共用的实例化代码**：宿主与 dev 探针调同一个函数，探针用它逐帧对照 WPE。
- **结构照记**：同步建出的对象照样进 `SceneStructure.created`，之后任何重编译都把它当普通对象编，和模板克隆的结果一致（验收比这一点）。

## 现状锚点

**a. 宿主的建层落点**（`host.ts` `onCreateLayer`）：运行中一律请求重编译。
```ts
private onCreateLayer(config: string, parent: number | null): number | null {
  const state = this.scriptState;
  if (!state) return null;
  syncAllocator(this.allocator, this.scriptBundle);
  const object = createStructureObject(state, this.structure, this.allocator, config, parent);
  if (object === null) return null;
  this.options.report.debug(`场景脚本建了图层：${object}`);
  if (this.runtimeTask) return object;          // init 期间：只记结构，reload 里带结构重编
  this.stats.recompiled.push({ reason: `script（createLayer ${object}）`, keys: [] });
  this.requestScriptReload();                   // 现状：运行中每建一个就整场重编
  return object;
}
```

**b. 待编对象只有图层状态**（`script/structure.ts` `createStructureObject` → `render/state.ts` `addLayer`）：
```ts
const object = allocator.next++;
const root = parent === null || !state.layers.has(parent) || state.pendingDestroy.has(parent) ? null : parent;
state.addLayer(object, layerStateFromShell(shell, root, { imageLayer: kind === "image" }));   // 只填 layers / order / children / alignmentSizes(0×0)
structure.created.push({ object, config: configText });
```
`constants`、`effects`（缺项时 `effectEnabled` 为假）、`shadowPasses`、`particleInstances`、`sounds`、`lights`、`cameras` 都没填（盘点 §3）。

**c. 编译把建了又删的对象当不存在**（`compile/bundle.ts`）：
```ts
// 运行中删掉的对象（P6d3）：这一项当作不存在，保持下标对齐；之后所有读 `scene.objects` 的地方都跳过不是对象的项
for (const index of structure.destroyed)
  if (Number.isInteger(index) && index >= 0 && index < scene.objects.length)
    (scene.objects as unknown[])[index] = null;
```
所以建删循环里，重编完时对象往往已经删了，新 bundle 里没有它，下一次建又重编。

**d. 同步取管线**（`render/scene.ts` `preparedOf`，运行中 `rebuildLayer` 用它）：
```ts
const spec = this.pipelineOf(step, runtime);
const program = this.readyPrograms.get(spec.program);
const pipeline = this.readyPipelines.get(pipelineKey(spec));   // pipelineKey 不含对象下标
if (!program || !pipeline) throw new SceneRenderError(["render:variant-missing"]);
```

**e. GPU 场景按层建资源只在加载时**（`render/scene.ts` `populate`）：fbo 池是局部变量、建完就丢；`particleOrdinals`、`layerByObject`、`reflectionList` 在构造时从 bundle 派生，之后不跟。
```ts
const fboPool = new Map<string, number>();     // populate 的局部变量
…
const key = fbo.unique ? `unique|${layer.id}|${effect.id}|${fbo.name}` : `${fbo.name}|${fw}x${fh}|${fboFormat}|${fbo.repeat}`;
…
this.layers.push(runtime);
this.runtimeByObject.set(layer.object, runtime);
…
runtimes.forEach((runtime, index) => this.install(runtime, this.buildLayer(runtime, plans[index], prepared[index], state, worlds)));
```

**f. dev 探针回放中途建的层只记账**（`dev/probeScripts.ts` `createLayer`）：
```ts
const object = createStructureObject(state, structure, allocator, config, parent);
if (object !== null && frames > 0)
  recompile.set(`createLayer/${object}`, { path: `createLayer/${object}`, count: 1, firstFrame: frames, value: config });
```

**g. 宿主各表的追加入口**（盘点 §5）：`SceneAnimations`、`ScenePuppets` 只能构造时给全表；`SceneSounds.load(list)` 按对象做差（重传全表即增量）；渲染器的 `cameraLayers` 是加载时过滤出的新数组；`bundle.layers`、`bundle.bindings`、`bundle.lightObjects` 是每帧 / 每次改值现读的同一个数组。

## 点 1 — 编译保留模板（`compile/bundle.ts`、`compile/protocol.ts`）

- **修改**：结构里「建了又删」的新建对象（`structure.created` 里、又在 `structure.destroyed` 里的）不再置空，照常编；编完从各表里摘出来，按规整配置去重（同一配置留最后一个），放进 `bundle.templates`。加载时的对象被删仍按现状置空（它们的配置本来就在 `configs` 里，克隆它们的配置时由活着的同配置对象或之前建出的模板命中）。
- **新增**
```ts
/** 一个可克隆的对象（P6d4）：编好的图层加上它在各表里的条目，下标都是 `object`。 */
export interface SceneTemplate {
  object: number;
  /** 规整配置（`normalizeConfig`，去 id、键排序）：模板按它命中 */
  config: string;
  layer: SceneLayer;
  bindings: SceneBinding[];
  /** 定型后的脚本条目（常量目标带 uniforms / members，动画层属主已回填）；不进 `scripts.list`，运行时不跑 */
  scripts: SceneScript[];
  animations: SceneAnimation[];
  sound?: SceneSound;
  light?: SceneLightObject;
}
export interface SceneBundle {
  …
  /** 结构里建了又删的新建对象（P6d4）：不画、不进状态，运行中按配置克隆；GPU 场景加载时备好它们的程序与管线 */
  templates?: SceneTemplate[];
}
```
  > 说明：模板的脚本参与 `usesEffectAccess` / `media` / 脚本能力检查（和活着的对象一样），所以克隆出来的脚本不会用到 bundle 没开的场景级能力。

## 点 2 — 克隆与可克隆判定（新 `compile/clone.ts`，纯函数）

- **新增**
```ts
/** 从 bundle 里取一个活着的对象的模板记录（各表按 object 过滤）；`templates` 里的直接用。 */
export function templateOf(bundle: SceneBundle, object: number): SceneTemplate | null;
/** 按规整配置找模板：先找活着的对象（`configs[i]` 相同、可克隆），再找 `bundle.templates`。 */
export function findTemplate(bundle: SceneBundle, config: string, alive: (object: number) => boolean): SceneTemplate | null;
/**
 * 换成新下标：字符串里 `objects/<模板>/` 前缀一律换成 `objects/<新>/`（pass 键、绑定路径、脚本 id 与目标、关键帧 id），
 * 数字字段 `layer.object` / 各条目的 `object` 换成新下标，`id` 换成新 id，`parent` 取新对象解析出的父，`group` 为 null，
 * `subtree` 为 []、`groupUpload` 为 null，关键帧条目的 `parent`（在 animations 数组里的下标）留给追加方加偏移。
 */
export function cloneTemplate(template: SceneTemplate, to: { object: number; id: number; parent: number | null }): SceneTemplate;
/** 克隆不了、要退回重编译的原因；null 表示可以克隆。 */
export function cloneBlocker(template: SceneTemplate, to: { parent: number | null; inGroup: boolean }): string | null;
```
- `cloneBlocker` 的条件（任一即退回，原因记 debug）：模板 `dependedOn`；新父链上有组或模板 `group` 非空；模板或配置带 `attachment`；文本（`layer.text`）；puppet（`layer.puppet`）或带骨骼的模型（`model.skeleton`）；体积光灯（在 `bundle.volumetrics.lights` 里）；HDR 且模板有 `layerComposites`（依赖格式随下标翻转，盘点 §1.2）。
- **单测的对照方法**：同一配置在新下标上真重编译（结构带 `created`），与 `cloneTemplate(模板, 新下标)` 的结果逐字段相同（`id`、`parent`、绑定顺序等可预期的差异列白名单）。

## 点 3 — 状态里加编好的对象（`render/state.ts`）

- **修改**：`fromBundle` 里按对象初始化的部分抽成一个函数，加载与运行中共用（不留两份）。
- **新增**
```ts
/**
 * 运行中加一个编好的对象（P6d4，克隆）：同 `fromBundle` 对一个对象做的事——图层状态（`layerStateOf`，属性值、对齐偏移、尺寸）、
 * 全部 pass 键的常量（含粒子子系统、多 renderer、网格与阴影变体、effect、passthrough）、`shadowPasses`、effect 开关、粒子实例覆盖、
 * 声音、灯、相机；再同 `addLayer` 追加到对象表尾与父的子表尾。`frozen` 随模板。
 */
addCompiledLayer(template: SceneTemplate, options: { frozen: boolean }): void;
```
- **修改**：`createStructureObject` 收可选的克隆结果：有就 `addCompiledLayer`，没有照旧 `addLayer`（壳值）。

## 点 4 — GPU 场景运行中加层（`render/scene.ts`、`render/renderer.ts`）

- **新增**
```ts
/**
 * 运行中加一个克隆出的图层（P6d4），全程同步：`layerByObject`、粒子序号（排在已有粒子层之后，同重编译）、反射名单（模板在就在）、
 * fbo（非 unique 的按模板 `fbos.initial` 共用同一个下标，unique 的新建、清屏随下一次提交）、`LayerRuntime` 进 `layers` 与
 * `runtimeByObject`、`planOf` → `preparedOf`（同步，缺管线抛 `render:variant-missing`）→ `buildLayer` → `install`、阴影投射者
 * （借模板投射 draw 的管线同步建）。抛错时回滚已加的项，由调用方退回重编译。
 */
addLayer(layer: SceneLayer, template: number, state: SceneState): void;
```
- **修改** `populate`：`bundle.templates` 的图层也 `planOf` + `prepareLayer`（只备程序与管线、不建 draw、不进 `layers`），加载进度把它们算进总数。
- **修改** `SceneRenderer`：`addLayer` 转给 `GpuScene`，相机对象另追加进 `cameraLayers`。
- 灯：`bundle.lightObjects` 由宿主 push（每帧现读），`legacySlot` 按「排在最后」取第一个空槽（同编译 `compileLightObjects` 的规则）。

## 点 5 — 宿主与 API 接上（`host.ts`、`script/api.ts`、`animation/player.ts`）

- **修改** `onCreateLayer`：
```ts
if (this.runtimeTask) return object;                       // init 期间：不变
const clone = this.tryInstantiate(object, configText, parent);   // 新增：找模板 → cloneBlocker → 改键 → 加进各表
if (clone) return object;                                 // 同步建好，不重编
this.stats.recompiled.push(…); this.requestScriptReload();   // 没有模板或克隆不了：照旧
```
  `tryInstantiate` 的顺序：分配下标 → 找模板（`findTemplate`，只认 `state.layers` 里活着的对象或 `templates`）→ `cloneBlocker` → `cloneTemplate` → `state.addCompiledLayer` → push `bundle.layers` / `bindings` / `configs[新]` / `lightObjects`、`SceneSounds.load(全表)`、`SceneAnimations.add` → `renderer.addLayer`（抛错就撤回状态与表、退回重编译）→ 记结构。
  加载进行中（`reloading`）不克隆：新 bundle 是加载开始时的结构编的，换场景时克隆会丢（盘点 §7.8），照旧挂起重编。
- **新增** `SceneAnimations.add(entries)`：按条目建时钟与通道，`parent` 加上追加前的条目数。
- **修改** API `createLayer`：克隆成功时不进 `pending`（`findLayer` 已找得到），脚本条目用克隆出的定型条目（push 进 `bundle.scripts.list`）交给 `addScripts`，不再走 `collectObjectScriptsSync`；没克隆时照旧。`createdIds` 照记。

## 点 6 — dev 探针（`dev/probeScripts.ts`、`dev/probe.ts`）

- **修改** 探针的 `createLayer` 调同一个实例化函数；克隆成功不再记进 `recompile`。
- **新增** 预跑：回放里有没模板的建层时（第一遍记下这些配置），带「这些配置作模板」的结构（`created` + `destroyed`）重编后从头再跑一遍，回放里的建层全部走同步克隆，和 WPE 逐帧对照。结果里记 `scripts.templated`（预跑补的配置数）。

## 点 7 — 结构不无限长（`script/structure.ts`）

- **修改** `recordDestroyed`：被删的是新建对象，而且结构里已有同一规整配置、也已删的新建对象时，摘掉旧的那条（`created` 与 `destroyed` 各一项），每种配置最多留一个模板。dino_run 一类反复建删的场景，结构长度按配置种类数封顶。

## 步骤 0 — WPE 补测（Claude，wpe-renderdoc）

工程由 `ignore/p6/d4/make_step0.py` 生成，日志前缀 `[kbp6d4]`。
- **`p6d-frame` 的日志夹具**（现在只有抓帧）：截 WPE `log.txt`，供逐行比。
- **运行中克隆的粒子层**：加载时就有的粒子层 P（`starttime` 非 0、数量看得出差别），第 N 帧在 `update` 里克隆。抓 N、N+1、N+2 帧：克隆当帧有没有预热出的粒子、发射从哪一刻算。我们的 `createParticleTree` 现在按 `starttime` 预热。
- **运行中克隆带关键帧的对象**：克隆的动画从 0 开始还是接模板的时钟（日志读字段值）。
- **运行中克隆带属性绑定的对象**：克隆之后改属性（`apply_properties`），克隆跟不跟着变。
- **运行中克隆被光标命中**：克隆出的图像层收不收 `cursorEnter` / `cursorClick`（日志）。

## 验收

- **单测**（只跑相关文件）：`cloneTemplate` 与真重编译逐字段对照（图像层、带 effect、粒子含子系统与多 renderer、静态模型与阴影、sprite、形状、声音、灯、相机、带脚本与 `script-property` 绑定、带关键帧）；`cloneBlocker` 各条；`addCompiledLayer` 与 `fromBundle` 同一对象的状态相同；`GpuScene.addLayer` 与加载时建同一对象的 draw 相同（假设备）；模板去重；宿主建删循环只重编一次。
- **和 WPE 逐行 / 逐像素比**：`p6d-cycle` 8 帧（探针预跑后）逐像素；`p6d-frame` 日志逐行；步骤 0 的工程。
- **编译产物**：没有结构变化时与改前逐字节相同（`ignore/p6/d3/bundlehash.test.ts`）。
- **语料**：`scriptCorpus` 前后比，变化只在运行中建层的场景（`recompile` 里的 `createLayer/*` 消失）。
- **变异**：改键漏一类、模板命中不看规整配置、`cloneBlocker` 少判一条、状态少补 `effects`、fbo 共用错、探针不预跑、去重摘错。
- **真机**（用户勾）：dino_run 一类反复建删的场景，第二次起新对象当帧出现。

## 待定（请用户定）

1. **同步路径覆盖哪些种类**（推荐：图像层（含 effect、无子的组合层）、粒子、静态模型、sprite、形状、声音、普通灯、相机，以及它们身上的脚本与关键帧；文本、puppet / 带骨骼的模型、体积光灯、带挂点的、父链上有组的、模板被依赖的退回重编译）。另一选项是把文本也做进来（共用模板的排版并 retain，或按字段重排），多一份文本资源的接线。
2. **第一次出现的配置**（推荐：维持 P6d「已定」3，走重编译、晚一段出现）。另一选项是编译期扫描脚本里 `createLayer` 的字面量参数（字符串路径、`registerAsset` 字面量）预编模板，让第一次也同步；要在编译期静态取 `__workshopId` 与改写，覆盖不到对象字面量。
3. **dev 探针预跑补模板**（推荐：做，否则建删循环的第一轮在探针里也画不出来，没法和 WPE 逐帧比）。
4. **结构去重**（推荐：做，每种配置最多留一个已删的模板）。
