# 活的场景图：运行中按对象增、删、改，不再整场重编译（总计划）

> 横切重构，不属于 P7–P13 任何一节。2026-11-16 提出（用户：「我发现这里有一个架构问题，我们不能支持运行时改一些东西」）。
> 相关：
> - P6d「已定」3：第一次出现的配置晚几帧，是已知差异。
> - P6d3「已定」2–3：结构变化与建层现在走重编译。
> - [P6d4 计划](phase6/phase-6d4-sync-instantiate.md)与它的盘点 `ignore/p6/d4/inventory.md`。盘点列全了「改键」和「运行时要补」的地方，L1、L3、L4 直接按它做。
> - P6d1b：新组合的管线在后台建，晚几帧换上。
>
> 状态：计划。各步动工前另写子计划（`phase-live-L<n>.md`）。「待定」各项等用户定。

## 总体设计思路

现在的场景是「编一次、画一份不可变的 bundle」：
- Worker 一次编完整场，编完就关；
- 主线程按 bundle 建 `SceneState`、`GpuScene` 和宿主各子系统，之后只改状态。

凡是动到编译产物的改动，都走整场重编译：
- 运行中 `createLayer` 一个新配置；
- 图层的 `size`、`colorBlendMode`、文本的 `font` 等非运行中字段；
- 进出组的 `setParent`、挂到骨骼上、删组。

整场重编译的过程是：Worker 从头编一遍，新建一个 `GpuScene`，粒子树重新预热（只接回脚本的暂停 / 停止），文本图集重建，旧场景一直画到新场景换上，前后约 0.5–0.8 s。WPE 在它活的对象表上当帧做完这些。P6d3 已经把状态这一侧做活了（对象表、排序、删除、换父），编译和 GPU 两侧还是整批的。

目标是三层都按对象增量：

**编译：常驻的编译会话。**
- 每张加载中的场景有一个常驻 Worker，里面是一个编译会话。会话就是现在 `compileScene` 的闭包作用域，原样保留：开场的解析、着色器编译器、纹理 / 程序表、名字表、各种缓存只建一次。
- 现在的对象循环体包成 `compileObject`，循环之后的收尾包成 `finalize`。整场编译 = 开会话 + 逐个 `compileObject` + `finalize`，产物逐字节不变。
- 运行中，会话再编一个对象（新配置，或带覆盖的已有对象），得到一个**对象片段**（`ObjectFragment`）。新加的程序和纹理一起发回；这两张表只增不减。

**主线程：bundle 成为可增删的登记表。**
- `addFragment` / `replaceFragment` / `removeObject` 同时改三处：
  - bundle 的各张表；
  - `SceneState` 里这个对象的各项；
  - 宿主子系统：动画、puppet、声音、文本、视频、用户纹理、脚本条目。
- 整场才定得下来的派生量（组与子树、挂点、反射名单、相机列表、粒子序号）不再在编译期烤死，改成结构代数变了时从登记表与状态现算。

**GPU：按对象装卸。**
- `GpuScene` 加 `prepareObject`（异步：程序、管线、纹理）和 `installObject` / `removeObject`（同步，在帧边界做）。
- 场景级资源改成可增长的：纹理增量上传、fbo 池常驻带引用计数、粒子索引缓冲扩容、变形纹理按对象建。
- `populate` 改写成「场景级准备 + 对每个对象 prepare / install」。加载和运行中走同一条路，所以现有工程的画面哈希就能验证运行中的路径。

**宿主：变更队列。**
- 对象级的改动不再 `requestScriptReload`，而是进一个变更队列：建层、单对象重编译、结构调整。
- 整场重载只留给场景设置（HDR、后处理、阴影、反射、体积光档位），以及下面说的「场景级不变量」被打破的情况。

**什么时候生效。** WPE 是同步的：读文件、编着色器都阻塞渲染线程，所以一切当帧生效。我们读文件只能异步，于是分四种：
- **见过的配置**（加载时就有的对象，以及运行中编过的）：片段按规整配置缓存。克隆时只把片段改键（P6d4 的 `cloneTemplate`），程序、管线都已就绪，同步装上，当帧就画。片段缓存就是 P6d4 的模板表，而且对象删掉之后片段还留着，P6d4 点 1 的 `bundle.templates` 就不需要了。
- **第一次出现的配置**：会话异步编一个对象，几十毫秒到几帧之后出现。这仍是 P6d「已定」3 的已知差异，但不再整场重编，别的对象不受打扰。
- **单对象重编译**（`size`、`colorBlendMode`、`font`）：异步编，备好后在帧边界换下旧的，期间照画旧的。WPE 当帧生效，我们晚几帧，是已知差异。
- **结构变化**（进出组、挂点）：不用编。每个组合层都预先编好组上屏 pass，缺的管线按「待定」3 同步建，当帧生效。

**场景级不变量。** 有一些事实每张场景只定一次，烤进全部程序或管线：
- HDR、`lightconfig` 与阴影档、雾的宏；
- 有没有深度附件；
- `usesEffectAccess`（脚本拿得到 effect，写死关闭的 effect 也编进来）；
- 平面反射开不开、泛光链、体积光渲染器。

运行中的改动要翻转其中任何一项时，照旧整场重载：对，但慢，而且少见。这条让重构有边界：活的路径只管对象局部的改动，别的都退回整场重载。

**关键决策与理由：**
- **会话就是现有的闭包作用域，不改写成类。** `compile/bundle.ts` 是别的会话最常改的文件，约 1700 行闭包一行不搬，只把循环体（约 290 行）和收尾（约 140 行）各包一层。验收用全库编译产物逐字节相同。
- **片段的键保持绝对路径**（`objects/<i>/…`），改键收成一个纯函数。bundle 格式和全部消费者都不用改。改键函数用「同一配置在新下标上真编一次」逐字段对照（L1 的片段一致性检查），克隆和会话编片段互相验证。
- **整场重载永远保留，作为兜底。** 每个活的操作出错或碰到场景级不变量，都退回它。所以不论覆盖到哪一步，结果都是对的。
- **加载和运行中只有一条装卸路径**，dev 探针也用它：L0 的编译产物摘要和画面哈希基线直接验证运行中的代码。

**和 P6d4 的关系。** P6d4（在现有架构里按模板克隆）是本计划 L1 的改键、L3 的状态加对象、L4 的 GPU 加层、L5 的克隆路径的子集。它的盘点、步骤 0、`cloneBlocker` 的分析都直接并进来；`bundle.templates`、探针预跑、结构去重由会话片段缓存取代。去留见「待定」1。

## 收益与不变的部分

- **不多解锁场景。** 建层的场景 P6d3b 起已能渲染；语料里 `setParent` 0 处，`combo:user-binding` 0 处；全库跑 120 帧，没有脚本写到重编译目标。
- **收益在运行时与 WPE 一致：**
  - dino_run 一类的对象池：建了又删的对象当帧出现（现在每建一个整场重编一次，重编完时对象往往已删，永远画不出来）；
  - 用户改 `size` / `colorBlendMode` / 字体类属性、脚本改结构：不再整场重载，粒子不重来，文本图集不重建，没有 0.5 s 的延迟；
  - 结构变化当帧生效，P6d3 记下的「删组后子层晚一段」「进组晚一段」两条已知差异消失。
- **不变：**
  - 场景设置的改动照旧整场重载。WPE 也要重载或重启。
  - `compileScene(input)` 的签名不变，`kbp` 工具、语料扫描、dev 渲染都不用改。

## 现状锚点

**a. 编译一次编完整场**（`compile/bundle.ts` `compileScene`）。开场、对象循环、收尾都在一个函数里，闭包共享全部表与缓存：
```ts
export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const fs = new SceneFs(input.projectDir, input.sceneAssets, input.reader);
  const unsupported = new Set<string>();
  const bindings = new BindingCollector();
  …                                                    // 约 400 行开场：project / scene、结构、脚本、动画、general、后处理、
                                                       // 灯对象、父链、依赖名字表、ShaderCompiler、纹理 / 程序表
  async function getTexture(…) { … }                   // 约 1100 行闭包：compilePass / compileEffect / compileImageModel /
  async function compilePass(…) { … }                  // compileParticle / compileModel / finalizePuppet / compileShape …
  for (const [index, object] of scene.objects.entries()) {
    if (settled()) break;
    …                                                  // 约 290 行循环体：一个对象的图层、effect、passthrough、组上屏、文本
  }
  …                                                    // 约 140 行收尾：挂点、子表与 assignGroups、反射名单、体积光、泛光、
  return bundle;                                       // 动画层属主回填、音频 / 媒体位。现状：没有「只编一个对象」的入口
}
```

**b. Worker 每次编译新建、编完就关**（`compile/client.ts` `compileInWorker`）：
```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
…
function finish(result?: SceneBundle, error?: Error) {
  …
  worker.terminate();                                  // 现状：着色器翻译、文件、mdl 的缓存都随 Worker 丢掉，下次重编从头来
```

**c. 宿主把对象级改动一律变成整场重编译**（`host.ts`）：
```ts
private overrideAndReload(path: string, value: ScriptValue): boolean {   // 脚本写 size / colorBlendMode / 文本字段等
  if (!recordRecompileWrite(this.scriptOverrides, this.scriptBundle?.general, path, value)) return true;
  …
  this.requestScriptReload();                          // 现状：整场
}
private onReparented(change: …): void {
  recordReparent(this.structure, change.object, change.parent, change.bone);
  if (!this.scriptState || !reparentNeedsRecompile({ … })) return;      // 组归属或挂点变了
  …
  this.requestScriptReload();                          // 现状：整场
}
private onCreateLayer(config: string, parent: number | null): number | null {
  …
  if (this.runtimeTask) return object;
  this.stats.recompiled.push({ reason: `script（createLayer ${object}）`, keys: [] });
  this.requestScriptReload();                          // 现状：运行中每建一个就整场重编
  return object;
}
```
属性面板的改动同理：`applyChanges` 里 `planApply` 分出的 `plan.recompile`，加上 `needsRecompile` 拦下的写入（打开带不支持项的 effect、冻结的图层、没有泛光链），都整场重编。

**d. 重编译目标**（`compile/bindings.ts`、`compile/bundle.ts`、`compile/texts.ts`、`script/api.ts`）只有两种原因，对象级和场景级混在一起：
```ts
export type RecompileReason =
  | "postprocess-hdr"   // general.hdr
  | "layer-structure";  // 现状：size、colorBlendMode、castshadow、reflected、general/perspectiveoverridefov 都归这一类
```
文本层另有 `recompile("backgroundcolor")`（不能就地写时），以及 `font` 等非运行中字段（`api.ts`）。

**e. 渲染器每次加载新建 `GpuScene`，粒子只接回脚本控制**（`render/renderer.ts` `load`、`render/scene.ts`）：
```ts
const state = SceneState.fromBundle(bundle);
const scene = await GpuScene.build(this.gpu.device, bundle, state, …);
…
if (old) scene.adoptParticleScripts(old);     // 现状：只调 adoptScriptControl，模拟状态从预热重来
this.cameraLayers = cameraObjectLayers(bundle);   // 现状：加载时过滤出的新数组
```

**f. `populate` 一次建完全部图层，场景级资源只在这里定**（`render/scene.ts`）：
```ts
this.textures = bundle.textures.map((texture, index) => uploadable.has(index) ? this.own(uploadTexture(device, texture)) : null);
…
if (bundle.scripts.usesEffectAccess || bundle.volumetrics !== undefined || wantsDepth(…))
  this.depthTarget = this.createDepthTarget();          // 现状：深度附件只在加载时定，管线的深度状态跟着它
…
if (particleCapacity >= 0) this.createParticleIndices(particleCapacity);   // 现状：按加载时最大的 maxcount，之后不扩
const fboPool = new Map<string, number>();              // 现状：populate 的局部变量，建完就丢
…
runtimes.forEach((runtime, index) => this.install(runtime, this.buildLayer(runtime, plans[index], prepared[index], state, worlds)));
```
构造函数里还从 bundle 派生三张表，之后不再跟：
```ts
for (const layer of bundle.layers) if (layer.particle) this.particleOrdinals.set(layer.object, ordinal++);
for (const layer of bundle.layers) this.layerByObject.set(layer.object, layer);
this.reflectionList = reflection?.planar && reflection.enabled ? new Set(reflection.list ?? []) : null;
```

**g. 宿主子系统只能按整份 bundle 构造**（盘点 §5）：
- `new SceneAnimations(bundle.animations)` 按下标建时钟；
- `new ScenePuppets(puppetEntries(bundle.layers))` 只有构造、`carryOver`、`refresh`；
- `SceneTexts.prepare(bundle, …)` 一次排全部文本层。

只有 `SceneSounds.load(list)` 按对象做差，可以增量。

**h. 状态的写入把对象级改动报成「重编译」**（`render/state.ts` `write`）：
```ts
write(binding: SceneBinding, raw: SceneScalar): WriteResult {
  const { target } = binding;
  if (target.kind === "recompile") return "recompile";       // 现状：调用方整场重编
  …
  if (this.needsRecompile(binding, raw)) return "recompile"; // 打开带不支持项 / 冻结图层的 effect
```

## 分步

每步单独验收、单独提交；动工前写子计划。依赖关系：
```
L0 ─┬─ L1 ── L2 ──┐
    └─ L3 ── L4 ──┴─ L5 ── L6
                       └── L7
```
编译轨（L1、L2）和运行时轨（L3、L4）互不依赖，可以先后做，也可以两个工作树并行（见「待定」5）。

### L0 — 基线与 WPE 补测（Claude）

子计划：[live/phase-l0-baselines.md](live/phase-l0-baselines.md)。

- **基线**（后面每步都和它比）：
  - **编译产物摘要**：`ignore/p6/d3/bundlehash.test.ts` 全库跑一遍存下（L1、L2、L7 比）。
  - **画面哈希**：FINAL_CHECK 的工程，加上语料里能渲染的场景，用 `hash_baseline` 存下（L4 起每步比）。
  - **`scriptCorpus` 全库结果**（L5、L6 比）。
- **语料统计**（`kbp corpus scan` 附加字段）：绑了用户属性的重编译目标各有几张，按 `size`、`colorBlendMode`、`reflected`、`castshadow`、文本字段分。用来定 L6 先做哪几种。
- **WPE 补测**（wpe-renderdoc），工程 `ignore/live/l0/make_step0.py`：
  - 运行中改 `size` / `colorBlendMode` / 文本 `font`，用 `apply_properties` 和脚本各写一次：当帧生效还是晚几帧；同一图层上的粒子会不会重来。
  - 原 P6d4 步骤 0 的四项原样并入：
    - 克隆粒子层的预热与发射起点；
    - 克隆带关键帧的对象，时钟从 0 起还是接模板；
    - 克隆带属性绑定的对象，之后改属性跟不跟；
    - 克隆的图层收不收光标事件。
  - 进组当帧生效已在 P6d3 步骤 0 测过，不重测。

### L1 — 编译会话与对象片段（纯重构，`compile/bundle.ts`、新 `compile/fragment.ts`）

子计划：[live/phase-l1-session.md](live/phase-l1-session.md)（细化：位置相关字段一律不进片段、由 L3 派生；不支持项用能记录的 Set；场景级不变量的翻转记进 `sceneFlips`）。

#### 点 1 — `compileScene` 拆成会话
- **新增**
```ts
/**
 * 一个场景的编译会话（L1）：`compileScene` 的闭包作用域原样保留，开场解析、着色器编译器、纹理 / 程序表、名字表、各种缓存都在里面。
 * 整场编译 = `openCompileSession` → 逐个 `compileObject` → `finalize`；运行中编一个对象用 `compileFragment`（点 2）。
 */
export interface SceneCompileSession {
  /** 加载时的对象下标（`scene.objects` 的全部项，含运行中建的、被删的置 null） */
  readonly objects: readonly number[];
  /** 已确定退回且不列全时为真（同现在的 `settled`）：整场编译的循环在这里停 */
  settled(): boolean;
  /** 现在的对象循环体，原样：编一个对象，产物推进共享的表 */
  compileObject(index: number): Promise<void>;
  /** 现在的收尾，原样：挂点、子表与组、反射、体积光、泛光、动画层属主回填、音频 / 媒体位。只调一次 */
  finalize(): Promise<SceneBundle>;
  compileFragment(request: FragmentRequest): Promise<FragmentDelta>;
}
export async function openCompileSession(input: CompileSceneInput): Promise<SceneCompileSession>;
```
- **修改**
```ts
export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const session = await openCompileSession(input);   // 修改：开场之后不再内联循环
  for (const index of session.objects) {
    if (session.settled()) break;
    await session.compileObject(index);
  }
  return session.finalize();
}
```
  > 说明：`openCompileSession` 的函数体就是现在 `compileScene` 的开场加全部闭包。循环体移进 `compileObject` 闭包（`continue` 改 `return`），收尾移进 `finalize` 闭包。进度回报留在 `compileObject` 里。`unsupported` 与 `bindings` 改成 `let`，点 2 编片段时临时换成新的收集器，闭包在调用时读当前绑定。

#### 点 2 — 编一个对象的片段
- **新增**（`compile/fragment.ts`）
```ts
/** 运行中编一个对象的请求（L1；L2 起经 Worker 传）。 */
export interface FragmentRequest {
  /** `objects` 下标：新建的接在已分配的之后；单对象重编译是已有下标 */
  object: number;
  /** 配置原文：新建的是 `createLayerConfig` 整理后的；重编译的是当前配置 */
  config: string;
  /** 单对象重编译的覆盖，路径同 `scriptOverrides`（`objects/<i>/size` 等） */
  overrides?: Record<string, number[] | boolean | string>;
  /** 运行中的父与挂点（`SceneState`），新建的没有子 */
  parent: number | null;
  bone: string | null;
  /** 当前属性全集：绑定按它取值 */
  properties: Record<string, unknown>;
}
/** 一个对象的编译产物（L1）。下标都是全局的；键是绝对路径 `objects/<object>/…`，克隆时由 `rekeyFragment` 改。 */
export interface ObjectFragment {
  object: number;
  /** 规整配置（`normalizeConfig`）：片段缓存的键 */
  config: string;
  layer: SceneLayer;
  bindings: SceneBinding[];
  /** 定型后的脚本条目：常量目标已按程序补 uniforms / members，动画层属主已回填 */
  scripts: SceneScript[];
  /** `parent` 是片段内的下标 */
  animations: SceneAnimation[];
  sound?: SceneSound;
  light?: SceneLightObject;
  userTextures: UserTextureSource[];
  /** 反射名单用：`reflected` 不为 false、自己不是读反射图的模型 */
  reflected: boolean;
  /**
   * 这个对象会翻转的场景级不变量（总体设计「场景级不变量」）：任一为真时宿主不装这个片段，整场重载。
   * 例：脚本用了 `getEffect` 而场景 `usesEffectAccess` 为假；模型读 `_rt_Reflection` 而场景没有平面反射；计划要深度而场景没有深度附件；
   * 会画的体积光灯。
   */
  sceneFlips: string[];
  /** 场景位：只会从假变真、可以运行中补上的（订阅音频、媒体） */
  audio: boolean;
  media: boolean;
  /** 这个对象带来的不支持项（运行中怎么处理见「待定」4） */
  unsupported: string[];
}
/** 随片段发给主线程的新表项：两张表只增，`from` 是第一项的下标。 */
export interface FragmentDelta {
  fragment: ObjectFragment;
  programs: { from: number; list: TranslateResult[] };
  textures: { from: number; list: SceneTexture[] };
}
```
- `compileFragment` 做的事，按顺序：
  1. 配置放进 `scene.objects[object]`（数组配置编成分组节点，同 P6d3b），套用 `overrides`，`parents[object]` 与挂点取请求里的；
  2. 这个对象的脚本（`collectObjectScriptsSync`，**带** bindings）、关键帧（新增单对象版 `collectObjectAnimations`）、灯对象（新增单对象版，`legacySlot` 按「排在最后」取第一个空槽）推进会话的表，再跑 `checkScriptFeatures`；
  3. 调 `compileObject(object)`；
  4. 收尾里和这个对象有关的部分，抽成单对象版与 `finalize` 共用：
     - 挂点；
     - 动画层属主回填；
     - 反射读者，非模型读者在没有平面反射时改绑棋盘格，同 `finalize`；
     - 音频 / 媒体位；
  5. 按调用前后的表长度切出片段与 `FragmentDelta`，场景级不变量记进 `sceneFlips`。
- 依赖名字表只含加载时的对象（rea-p6d-layers 11）：新建对象既不会被依赖，也不进名字表。这条照旧。

#### 点 3 — 从 bundle 取片段、改键（`compile/fragment.ts`，纯函数，即 P6d4 点 2）
- **新增**
```ts
/** 从整场 bundle 里取一个对象的片段（各表按 object 过滤）：加载时就有的对象据此进片段缓存。 */
export function fragmentOf(bundle: SceneBundle, object: number): ObjectFragment | null;
/**
 * 改键（克隆）：字符串里 `objects/<from>/` 前缀换成 `objects/<to>/`（pass 键、绑定路径、脚本 id 与目标、关键帧 id），数字字段 `object` 换成新下标，
 * `id` 换成新 id，`parent` 取新父，`group` 为 null，`subtree` 为空，`dependedOn` 为假（新建对象不被依赖）。字段清单见盘点 §1–§2。
 */
export function rekeyFragment(fragment: ObjectFragment, to: { object: number; id: number; parent: number | null }): ObjectFragment;
```

#### 验收
- **全库编译产物逐字节相同**：和 L0 基线比，走 `compileScene`，也就是会话路径。
- **片段一致性**（新，全库）：每张场景、每个对象 i，在新下标 N 上做两件事，逐字段对照：
  - `compileFragment({ object: N, config: configs[i] })`；
  - `rekeyFragment(fragmentOf(bundle, i), N)`。

  白名单只放可预期的差异：登记顺序、`dependedOn`。这一条同时验证会话编片段和克隆改键，差异逐项登记原因。
- 现有 compile 测试全过。
- **变异**：
  - 改键漏一类；
  - 片段少切一张表；
  - `compileFragment` 漏掉脚本的 bindings；
  - 单对象版灯槽仍按 `objects` 顺序取。

### L2 — 常驻 Worker 与增量协议（`compile/worker.ts`、`client.ts`、`protocol.ts`、`host.ts`）

子计划：[live/phase-l2-worker.md](live/phase-l2-worker.md)（细化：转移后会话忘掉 `mdls` 与 `SceneFs.contents` 里的那批缓冲；片段只转移新纹理；Worker 串行处理片段、出错即标坏；宿主只在场景有脚本或对象级重编译绑定时留着会话）。

#### 点 1 — 协议
- **修改** `WorkerRequest` / `WorkerResponse`：
  - `start` 改名 `open`，回 `opened`（整场 bundle，同现在的 `done`）；
  - 新增 `fragment` 请求（带 `id` 与 `FragmentRequest`），回 `fragment-done`（`FragmentDelta`）或 `fragment-error`；
  - 新增 `close`；
  - 读文件、进度两种消息不变。
- **修改** 缓冲的转移：现在 `transferableBuffers` 把纹理 mip 和 mdl 文件整个转移走，常驻会话之后还要用缓存里的 mdl。转移过的缓冲在会话里作废，并从缓存摘掉，之后再要就重读。纹理 mip 只发一次，片段按下标引用，不受影响。

#### 点 2 — 主线程的会话客户端
- **新增**（`compile/client.ts`）
```ts
/** 一张场景的编译会话客户端（L2）：Worker 从 `open` 活到 `close`；同一时刻只有一个请求在 Worker 里跑，其余排队。 */
export class CompileSessionClient {
  static async open(input: WorkerCompileInput): Promise<{ client: CompileSessionClient; bundle: SceneBundle }>;
  /** 新纹理按 `textureCache` 在主线程解码（同 `compileSceneInWorker`），解完才返回 */
  fragment(request: FragmentRequest, signal?: AbortSignal): Promise<FragmentDelta>;
  close(): void;
}
```
- **修改** `compileSceneInWorker` 改成 `open` 之后马上 `close` 的薄包装（dev 探针、测试仍用它）。
- **修改** 宿主：
  - `reload` 用 `CompileSessionClient.open`，新场景换上后关掉旧会话；
  - 退回、销毁时关掉；
  - 被取代的加载关掉自己开的会话。

#### 验收
- 经会话打开的 bundle 与 L0 基线逐字节相同。
- 协议单测（假 Worker）：
  - 排队；
  - 取消；
  - 片段错误不影响会话；
  - `close` 之后的请求被拒；
  - 转移过的 mdl 再用时重读。
- 真机：
  - 反复切换壁纸、重载之后，Worker 数回到 0 或 1；
  - 记下会话常驻时 Worker 的堆大小，写进文档。

### L3 — 主线程按对象增删（`render/state.ts`、新 `compile/registry.ts`、新 `render/derived.ts`、宿主子系统）

拆成两块，各自验收：
- [live/phase-l3a-registry-state.md](live/phase-l3a-registry-state.md)：登记表、状态逐对象增删、组与挂点运行时重算。派生量不另建 `derived.ts`，由登记表现算、写回图层，L4 的消费者不改。片段缓存挪到 L5。
- [live/phase-l3b-host-subsystems.md](live/phase-l3b-host-subsystems.md)：宿主子系统（关键帧、puppet、文本、脚本、声音、用户纹理 / 媒体）的按对象增删入口，加上宿主的 `addCompiledObject` / `removeObjectEverywhere`，不接进 `createLayer`（L5 接）。

#### 点 1 — 状态按对象（`render/state.ts`，即 P6d4 点 3 的扩展）
- **修改** `fromBundle` 里按对象初始化的部分抽成一个函数。`fromBundle` 改成「场景级部分 + 对每个对象调它」，不留两份。
- **新增**
```ts
/** 加一个编好的对象（L3）：同 `fromBundle` 对一个对象做的事（图层状态、全部 pass 键的常量、阴影变体、effect 开关、粒子实例覆盖、声音、灯、相机、
 *  动画层、文本对象），再追加到对象表尾与父的子表尾（新建）或保持原位（加载、替换）。 */
addFragment(fragment: ObjectFragment, options: { append: boolean }): void;
/** 换掉一个对象的编译产物（L6）：运行中写过的图层字段、同键的常量覆盖与 pass 状态覆盖、effect 开关保留，键没了的丢掉。 */
replaceFragment(fragment: ObjectFragment): void;
/** 删除生效之后摘掉这个对象的全部按对象项（现在 `flushDestroy` 只摘一部分，常量等留到重编译） */
dropObject(object: number): void;
```

#### 点 2 — bundle 登记表（新 `compile/registry.ts`）
- **新增**
```ts
/** 片段进 bundle（L3）：layers、bindings、scripts.list、animations（parent 加偏移）、sounds、lightObjects、configs、userTextures，programs / textures 按 delta 追加。 */
export function addFragment(bundle: SceneBundle, delta: FragmentDelta): void;
export function replaceFragment(bundle: SceneBundle, delta: FragmentDelta): void;
export function removeFragment(bundle: SceneBundle, object: number): void;
/** 片段缓存：规整配置 → 片段。对象删了也留着（建删循环的第二次起同步）；按配置种类封顶，超了按最久没用的淘汰。 */
export class FragmentCache { … }
```

#### 点 3 — 运行时派生量（新 `render/derived.ts`）
- **新增** 一个按 `structureVersion` 失效的缓存，从登记表与状态现算：
  - 组与子树（`assignGroups`，子表取 `SceneState.children`）；
  - 挂点（`resolveAttachment`）；
  - 反射名单（片段的 `reflected` 按对象表顺序）；
  - 相机对象列表；
  - 粒子序号（新建的排在已有粒子层之后，同重编译）。
- **修改** 消费者改读它：
  - `SceneRenderer.cameraLayers`；
  - `GpuScene` 的 `layerByObject` / `reflectionList` / `particleOrdinals`；
  - `script/structure.ts` 的组判定。

#### 点 4 — 宿主子系统按对象增删
- **新增**
  - `SceneAnimations.add(entries)` / `remove(object)`；
  - `ScenePuppets.add(entries)` / `remove(object)`；
  - `SceneTexts.prepareObjects(layers)`：异步，按对象排版，读完字体才返回；
  - `UserTextureSources` 预解码新来源；
  - `SceneVideos.load` 按区间做差：确认现状，缺就补。
- **修改**
  - `ScriptRuntime.refreshScripts` 接受部分条目；
  - `ScriptApi.adoptBundle` 改成按对象（`adoptObjects(objects)`）；
  - 音频 / 媒体位运行中从假变真时补订阅。

#### 验收
- **状态等价**（全库）：`SceneState.fromBundle(bundle)` 与「空状态 + 按对象表顺序逐个 `addFragment(fragmentOf(bundle, i))`」深相等。
- 子系统单测：增删前后与整份构造的结果相同。
- 派生量：全库的组、挂点、反射名单、相机列表和编译期结果相同。
- 变异：
  - 状态少补 `effects`；
  - 动画 parent 不加偏移；
  - 派生缓存不随结构代数失效。

### L4 — GPU 按对象装卸（`render/scene.ts`、`render/renderer.ts`、`dev/probe.ts`）

子计划：[live/phase-l4-gpu-objects.md](live/phase-l4-gpu-objects.md)（2026-11-17）。要点：`populate` 改成「场景级准备 + 逐对象 `prepareObject` / `installObject`」且整场产物逐位不变（全库画面哈希对基线）；场景级资源可增长；粒子序号由登记表给；删除路径接上登记表（改组归属的删除仍重载，L7 去掉）；`newLayerId` 单调。进出组 / 挂点的 GPU 重排是 L7。

#### 点 1 — 场景级资源可增长
- **修改**
  - **纹理**：`ensureTextures(from)` 增量上传。
  - **fbo 池**：从 `populate` 的局部变量改成字段 `{ target, refs }`，引用数归零时释放。unique 的照旧独占。
  - **粒子索引缓冲**：容量不够时重建；draw 在编码时取当前缓冲。
  - **变形纹理**：按对象上传。
  - **裁切遮罩**、**挂点戳**（`WorldStamps`）：第一次用到时建。
  - **阴影投射者**：按对象建；`createShadowPipeline` 按管线键缓存。

#### 点 2 — 装卸入口
- **新增**
```ts
/** 备好一个对象（L4）：计划、程序、管线（含变体与 HDR 反射副本）、新纹理上传。异步；不改正在画的东西。 */
async prepareObject(layer: SceneLayer, state: SceneState): Promise<PreparedObject>;
/** 同步装上（帧边界）：fbo、`LayerRuntime`、draw、粒子树（按派生的序号定种子）、阴影投射者。同下标已有运行时就替换，
 *  替换时粒子接回脚本控制（模拟状态是否接回看 L6 子计划）。出错时回滚已加的项，由调用方退回整场重载。 */
installObject(prepared: PreparedObject, state: SceneState): void;
/** 程序与管线都已就绪时不经 await 直接备好（克隆）；缺管线按「待定」3。 */
prepareObjectSync(layer: SceneLayer, state: SceneState): PreparedObject | null;
/** `releaseRemoved` 的单对象版，另外放掉 fbo 引用、粒子序号。 */
removeObject(object: number): void;
```
- **修改** `populate` = 场景级准备 + 全部对象并行 `prepareObject` + 按顺序 `installObject`：
  - 场景级准备包括场景目标、占位纹理、反射 RT、阴影图集、深度附件、泛光、体积光；
  - 深度附件仍按全部计划定一次。运行中的片段要深度而场景没有时，由片段的 `sceneFlips` 退回整场重载。
- **修改** `SceneRenderer` 转发 `addObject` / `replaceObject` / `removeObject`；dev 探针建场景走同一条路。

#### 点 3 — 删除路径接上登记表（L3b 留下的）

L3b 的 `removeObjectEverywhere` 在删除生效处只接了 `structural: false`，即子系统与状态的清理。登记表的 `removeObject` 和之后的 `restructure` 没接，因为有两类消费者还按整场 bundle 现读（见 [live/phase-l3b-host-subsystems.md](live/phase-l3b-host-subsystems.md)「验收中的补充」）。L4 改掉它们之后才改成 `structural: true`：
- **渲染侧读组字段**：`render/structure.ts` 按 `layer.group == null` 选顶层，`groupOf` / `groupDepth` 找组的 RT。删组之后子层的 `group` 会变成 null，按顶层去画，但它们的 op 还指向已释放的组合成 RT。L4 的装卸要让组归属变化时重建这些 op，或者在删组时把子层重装成顶层。
- **脚本 API 读 `bundle.layers`**：
  - `ScriptApi.newLayerId` 取 `bundle.layers` 里最大的 id 加 1。删掉最大 id 的层之后，这个 id 会被再发一次，而 WPE 的 id 不回收。要改成单调的分配器。
  - `findLayer`、`getLayerByID` 等也按 `bundle.layers` 找，要核对删掉之后的语义。

#### 验收
- **画面哈希与 L0 基线全部相同**：加载路径已经换成逐对象装。
- 假设备单测：
  - 整场建与逐个装的 draw 列表相同；
  - 同一对象删了再装，draw 相同；
  - 建删循环 100 次后 fbo 引用数与 GPU 资源数回到基线。
- 变异：
  - fbo 引用不减；
  - 粒子索引不扩；
  - 装的时候漏 `runtimeByObject`。

### L5 — 运行中建层走片段（`host.ts`、新 `changes.ts`、`script/api.ts`、`script/structure.ts`、`dev/probeScripts.ts`；提示链另涉 `report.ts`、Rust `commands/wpe_scene.rs`、主窗口 `App.vue`）

子计划：[live/phase-l5-create-layer.md](live/phase-l5-create-layer.md)（2026-11-17），拆成 L5a 宿主路径与 L5b 提示链并行。与下面不同的两处：缓存按会话归属、换场景丢掉（片段里的程序 / 纹理下标是会话坐标），重载进行中建的对象在新场景上建壳并排 `create`，不从缓存实例化；无损规整的判定由会话算、经 `opened` 消息带回（`exactConfigs`），不进 bundle。

#### 点 1 — 变更队列
- **新增**（`changes.ts`）
```ts
/** 宿主的场景变更（L5）：对象级改动排进来，编好的在下一帧开头（脚本之前）按先后装上；场景级的整场重载。 */
export type SceneChange =
  | { kind: "create"; object: number; config: string }
  | { kind: "recompile-object"; object: number; overrides: Record<string, number[] | boolean | string> }   // L6
  | { kind: "restructure"; objects: number[] }                                                            // L7
  | { kind: "reload"; reason: string };
```
  > 说明：异步编好的片段在 `beforeFrame` 开头装：装上的那一帧，脚本就读得到编好的值。片段到达时对象已删的，只进缓存不装。
  > 编片段失败、带 `sceneFlips`、装的时候出错，都退回整场重载（结构里照记新建对象，重载后照样在）。

#### 点 2 — `createLayer` 的两条路
- **修改** `onCreateLayer`：
  - **命中**片段缓存（规整配置）：
    1. `rekeyFragment`；
    2. 登记表、状态、子系统加上；
    3. `prepareObjectSync` + `installObject`。

    以上都在 `createLayer` 返回之前完成，之后 `addScripts` 跑 `init`，`init` 的写入落在编好的状态上，读得到真实的 `size`。
  - **没命中**：先照 P6d3b 建壳状态，`init` 照常跑；再排 `create` 进队列，会话异步编。片段到了之后：
    1. `replaceFragment` 换成编好的状态，并重放这个对象建出以来的脚本写入（运行时的写入表按对象过滤）；
    2. 装 GPU；
    3. 进缓存。
- **修改** 首次加载 `init` 里建的层：不再「放弃本次、整场再编」，改成会话编片段，在建 GPU 场景之前加进 bundle。去掉「首次加载多编一次约 0.2 s」。
- **修改** 加载进行中（整场重载）建的层：照记结构，并在当前场景上照常活建；新场景换上时（`beforeFirstFrame`），把编译快照之后建的对象从缓存实例化到新场景上。这条补 P6d4 盘点 §7.8 的漏洞。
- **删除** 运行中建层的 `requestScriptReload`。
- **缓存从整场 bundle 预置片段的前提**（L1 发现）：`configs[i]` 规整时非整数只留 8 位有效数字。脚本 `createLayer(getInitialLayerConfig(x))` 拿到的是舍入后的值，WPE 同样如此；而 `fragmentOf(bundle, i)` 是按原文编的。两者在少数常量的末几位上不同（全库 54 个对象、107 条路径，其中 99 条在 float32 下相等）。
  - 推荐：只在「该对象原文经规整无损」时用 `fragmentOf` 预置；否则这个配置第一次照样异步真编，之后命中的是真编的片段。
  - 写 L5 子计划时定。
- **L0 实测要对齐的四条**（`ignore/live/l0/wpe-results.md`）：
  - 运行中建的粒子层按 `starttime` 预热、从建出那刻起发射，不复制模板的现存粒子（同现在的 `createParticleTree`）；
  - 克隆的关键帧时钟从 0 起，建出那一帧读到静态 `value`，下一帧才求值；
  - 克隆保留属性绑定，之后改属性模板与克隆一起变；
  - 克隆的图层照收光标事件（进光标命中表）。

#### 点 3 — 删除与内存
- **修改** 删除生效后，三处一起摘掉：GPU 的 `removeObject`、状态的 `dropObject`、登记表的 `removeFragment`。片段留在缓存里。
- **修改** 结构里的新建记录照 P6d4 点 7 去重：每种配置最多留一个已删的。它只给整场重载的兜底用。

#### 点 4 — dev 探针
- **修改** 探针的 `createLayer` 调同一个变更函数。
- **新增** 探针选项 `awaitFragments`：没命中缓存时，回放在当帧等片段编好。用于和 WPE 逐帧比逻辑；不开时照产品行为晚几帧。

#### 点 5 — 运行中不支持项的提示（已定 4，用户加）
运行中出现的不支持项不让场景退回，所以要另外告诉用户：经主窗口的看板娘消息（`kameMessage.warning`）提示。桌面壁纸窗口没有看板娘，提示一律送到主窗口；主窗口隐藏在托盘里时，消息照常进看板娘的历史。
- **新增**（宿主 `report.ts`）：`SceneReporter.unsupported?(keys)`。
  - 本宿主实例里报过的键不再报；
  - 同时记 warn 日志（键全列）；
  - 经 `wpe_scene_report` 上报 `{ kind: "unsupported", instance, image, keys }`，`image` 取 `kbScene`。
  - dev 探针的上报器可以不实现。
- **新增**（Rust `commands/wpe_scene.rs`）：`WpeSceneReport::Unsupported { instance, image, keys }`。
  - 记 warn；
  - `emit_to("main", "wpe-scene-unsupported", { image, surface, keys })`，其中 `surface` 由调用方 label 定：壁纸窗口（`is_wallpaper_label`）为 `"desktop"`，否则为 `"preview"`。
  - 只送主窗口，补丁 14 保证别的 webview 收不到。
- **新增**（主窗口 composable `useSceneUnsupportedNotice`，挂在 `App.vue`）：听 `wpe-scene-unsupported`。
  - 同一张图、同一个键本次运行只提示一次；建删循环的场景会反复冒同一个键。
  - 调 `kameMessage.warning(t(…, { keys }))`，文案分桌面 / 预览，例：「桌面的场景壁纸运行中用到了暂不支持的特性：{keys}，相关图层没有画出」。
  - i18n 五种语言都补。
- **产生方**：L5 片段的 `unsupported`、L6 单对象重编译的 `unsupported`、L7 运行中的组内不支持组合，都走这一个入口。加载时的不支持项照旧整场退回预览图，不走这里。
- **验收**：
  - Rust 反序列化单测；
  - composable 单测：去重、桌面 / 预览两种文案；
  - 宿主 reporter 单测：同键只报一次；
  - 真机（用户勾）：用 dev 强制一个运行中的不支持项（探针或测试工程），看板娘弹出警告；桌面上的那张也弹在主窗口。

#### 验收
- **和 WPE 比**：
  - `p6d-cycle` 8 帧逐像素（建删循环第二轮起当帧出现；开 `awaitFragments` 时第一轮也比）；
  - `p6d3b-bars` / `p6d3b-clone` 日志逐行不变，`size` 的已知差异在命中缓存时消失；
  - L0 的克隆四项。
- **语料**：`scriptCorpus` 和基线比，`recompile` 里的 `createLayer/*` 全部消失，其余不变。
- **变异**：
  - 命中不看规整配置；
  - 片段到达时不重放写入；
  - 已删对象的片段照装；
  - 加载中建的层换场景时丢失。
- **真机**（用户勾）：dino_run 一类反复建删的场景，新对象当帧出现，其它对象（粒子）不重来。

### L6 — 单对象重编译（`compile/bindings.ts`、`render/state.ts`、`host.ts`）

子计划：[live/phase-l6-object-recompile.md](live/phase-l6-object-recompile.md)（2026-11-17）。与下面不同：不改 `BindingTarget` 的形状，对象级 / 场景级按 `path` 是否 `objects/<i>/` 前缀分；会话按开会话时留的原文副本套累计覆盖重编；GPU 替换时粒子定义相同就沿用旧树。实现后另有几处（见子计划「验收中的补充」）：被依赖的图层、带体积光的灯、整场重载进行中的写入保守走整场；`scriptCorpus` 没有会话、结果不变（点 3 里「对象级路径消失」只在 `probe.ts` 的回放里成立）。补丁 [live/phase-l6b-depended-replace.md](live/phase-l6b-depended-replace.md)（L7 之后做）：被依赖图层的替换沿用同尺寸的独占 RT、尺寸变了引用方按 P11b 的 `rebindUserDraw` 重绑，去掉 `objectLive` 的 `dependedOn` 退回。

#### 点 1 — 重编译目标分级
- **修改** 绑定目标：
```ts
export type BindingTarget =
  …
  // 修改：对象级重编译带上对象（size、colorBlendMode、castshadow、reflected、文本非运行中字段、backgroundcolor 不能就地写时）
  | { kind: "recompile"; reason: "object"; path: string; object: number }
  // 场景级不变：general/hdr、general/perspectiveoverridefov
  | { kind: "recompile"; reason: "postprocess-hdr" | "scene"; path: string };
```
- **修改** `needsRecompile` 拦下的写入同样分级：
  - 打开带不支持项 / 冻结图层的 effect，是对象级；
  - 没有泛光链时打开泛光，是场景级。

#### 点 2 — 宿主
- **修改** 对象级的写入（脚本写与属性面板改值）排 `recompile-object`：同一对象的多次合并，最后一次胜出。覆盖进会话的 `FragmentRequest.overrides`，片段到了在帧边界替换：
  - 状态 `replaceFragment`；
  - 脚本条目刷新；
  - 关键帧按 id `carryOver`；
  - 文本重排；
  - GPU `prepareObject` → `installObject`。

  替换期间旧对象照画。
- **修改** `reflected` 变了：派生的反射名单跟着变，不用编；读反射图的模型身份变了的，由片段的 `sceneFlips` 处理。
- **修改** 场景级照旧整场重载。

#### 验收
- **和整场重载比**（L0 结论）：
  - `size` 在 WPE 运行中改了无效；用户定了我们照样生效（3a 已定 5）。
  - `colorBlendMode` 在 WPE 运行中只在普通 ↔ 加法之间切混合，要换 passthrough 的值不生效。我们照 `size` 的先例生效，记为有意不同（语料 0 处绑定）。
  - 所以判据是：单对象重编译换上之后，那一帧和「带新值整场加载」的同一帧逐像素相同。
  - `font` 在 WPE 当场生效（P6b），我们晚几帧，记为已知差异。
- **语料**（L0）：
  - 绑定触发的重编译全库只有 1 处（`general.hdr`，场景级）；
  - 脚本触发的对象级重编译只有 `font`（13608、15019，都在 `init` 里）。

  所以 L6 主要是为了正确性，语料受益小。
- 粒子不重来：替换前后粒子轨迹连续，用 `particle_track` 看。
- 单测：替换保留运行中写过的字段与同键覆盖；同一对象连写 10 次只编最后一次。
- 语料：`scriptCorpus` 不变。
- 变异：
  - 替换丢了运行中的写入；
  - 不合并；
  - 场景级误走对象级。

### L7 — 结构变化不重编（`compile/bundle.ts`、`script/structure.ts`、`render/scene.ts`、`host.ts`）

子计划：[live/phase-l7-restructure.md](live/phase-l7-restructure.md)（2026-11-17）。与下面不同：没有单独的 `restructure(受影响的对象)` 排队——登记表 `restructure` 比较重算前后的 `group` / `subtree` / `attachment` 报出变化集合，渲染器在同一帧的 `sync` 里对这些图层按签名重建（缺的管线同步建）；运行中出现的组内不支持组合按 L5 / L6 的规则「那个对象不画 + 看板娘提示」。

#### 点 1 — 组上屏 pass 预编
- **修改** 每个组合层（passthrough 模型）都编 `groupUpload`，不再只给有子的。
  > 说明：没有子的组合层运行中可能变成组（P6d3 步骤 0：当帧就有了合成 RT）。编译产物只在这个字段上变，L0 摘要比较时按白名单放过。

#### 点 2 — 运行中重排组与挂点
- **修改** 换父、删除改了组归属或挂点时，排 `restructure(受影响的对象)`，当帧处理：
  1. 派生量重算；
  2. 受影响图层重新规划：新组、旧组、移动的子树；
  3. 缺的管线按「待定」3 建；
  4. 新组建合成 RT；
  5. 重建 op。
- **删除** `reparentNeedsRecompile` / `destroyNeedsRecompile` 和它们触发的重编译。
- **修改** 运行中出现的组内不支持组合（`groupChildIssues`）按「待定」4 处理。

#### 验收
- 和 WPE 比：`p6d3-struct` / `p6d3-parent` / `p6d3-attach` 的日志与抓帧。「删组后子层晚一段」「进组晚一段」两条已知差异消失，切换的那一帧逐像素比。
- 语料：编译产物除 `groupUpload` 外与 L0 基线相同；`scriptCorpus` 不变。
- 变异：
  - 不重算子树；
  - 旧组不重新规划；
  - 不建新组的合成 RT。

### L8 — 按需（不在本轮）

- **COMBO 绑用户属性**（`combo:user-binding`，语料 0）：L6 的单对象重编译加一种绑定目标即可。
- **灯的结构字段**（`light:runtime:*`）、体积光灯的运行中增删。
- **场景级不变量的运行中翻转**（`usesEffectAccess`、深度附件、平面反射）：不再整场重载。
- **首次出现配置的预编**：扫描脚本里 `createLayer` 的字面量参数，加载时编好片段，让第一次也当帧出现（P6d4「待定」2 的另一选项）。

## 工作量

单位是「步」，以 P6d1a 的规模为一步。

| 步 | 规模 | 主要风险 | 回归手段 |
|---|---|---|---|
| L0 | 0.5 | — | — |
| L1 | 1 | 别的会话同时改 `bundle.ts` | 全库编译产物逐字节；片段一致性 |
| L2 | 1 | 缓冲转移、Worker 生命周期 | 逐字节；协议单测 |
| L3 | 2 | 状态 / 子系统漏项（盘点 §3、§5） | 全库状态等价 |
| L4 | 2 | `populate` 里「只建一次」的假设，回归面最大 | 全库画面哈希；假设备 |
| L5 | 1.5 | 写入重放、加载中建层 | WPE 逐像素 / 逐行；`scriptCorpus` |
| L6 | 1 | 替换时的状态保留 | WPE 逐像素；粒子轨迹 |
| L7 | 1 | 组的重新规划 | WPE 逐像素 / 逐行 |
| **合计** | **约 10** | | |

和现计划比：P6d4 约 2 步，它的内容并进 L1 / L3 / L4 / L5。所以比照现计划，多出约 8 步。

## 风险与做法

- **并行冲突。** `compile/bundle.ts`、`render/scene.ts`、`render/state.ts`、`host.ts` 别的会话一直在改。照现有做法：
  - 每步在独立工作树、HEAD 快照里实现，由 sonnet 执行代理做；
  - 三方合并进主工作区；
  - 临时索引提交。

  L1 只包两层闭包、不搬闭包，冲突面已经压到最小。
- **回归面。** L4 把加载路径换成逐对象装，回归面最大。画面哈希基线要覆盖足够多的场景种类：组、依赖、puppet、文本、粒子、体积光、反射、阴影都要有。
- **内存。** 常驻 Worker 一直持有文件、翻译、mdl 缓存与 wasm 实例；片段缓存与登记表随建删增长。L2 量 Worker 的堆，片段缓存按种类封顶，删除生效即从登记表摘掉。
- **不是什么都能活改。** 场景级不变量照旧整场重载，WPE 自己也重载或重启。

## 已定（2026-11-16，用户：全部按推荐，另加一条）

1. **P6d4 并入本计划**，不单独做：它的盘点、步骤 0、改键并进 L0 / L1 / L3–L5。`phase-6d4-sync-instantiate.md` 保留作参考，不再执行。另一个会话如果在做 P6d4，要停下（由用户转告）。
2. **范围 L0–L7**，L8 按需。
3. **结构变化与克隆缺管线时，同步 `createRenderPipeline`**，当帧生效，同 WPE。
4. **运行中出现的不支持项：这个对象不画**，脚本和字段照常，记 warn 与 `stats`，场景不退回。
   **另加（用户）：要用看板娘消息（`kameMessage.warning`）提示用户「有不支持项」**，桌面与预览都提示。链路见 L5 点 5。
5. **先编译轨 L1–L2，再运行时轨 L3–L4**，一次一个工作树。
