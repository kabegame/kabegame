# L4 — GPU 按对象装卸（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L4」。前一块：[phase-l3b-host-subsystems.md](phase-l3b-host-subsystems.md)（宿主子系统、`addCompiledObject` 的 GPU 空钩子、删除路径只接了一半）。
> 基线：`ignore/live/l4/hash-base-1.json`、`hash-base-2.json`（L3b 提交后、本步动工前，用当时的宿主产物 `ignore/live/l4/host-build.json` 取的全库画面哈希，两遍；两遍不同的进排除表）。

## 总体设计思路

`GpuScene` 现在是「整场一次建」：`populate` 按 `bundle.layers` 一口气建完全部图层的运行时、draw、合成 RT、fbo、粒子树、阴影投射者，场景级资源（纹理表、fbo 池、粒子索引缓冲、变形纹理、裁切遮罩、挂点戳）也都按整场 bundle 一次定死大小。运行中加一个对象没有入口，只能整场重建。

L4 把它改成「场景级准备 + 逐对象装卸」。三个入口：
- `prepareObject(layer, state)`：异步，备好一个对象画出来要的一切——计划、程序、管线（含变体与 HDR 反射副本）、网格布局、fbo、新纹理上传。它不碰正在画的任何东西，失败只收回自己建的。
- `installObject(prepared, state)`：同步，在帧边界把备好的对象装上——运行时、合成 RT、draw、粒子树（预热）、阴影投射者、挂点。`encode` 读的是装好的整体，半装的状态不会被画到。
- `removeObject(object)`：`releaseRemoved` 的单对象版，另外放掉 fbo 引用。

`populate` 改成「场景级准备 → 全部对象并行 `prepareObject` → 按顺序 `installObject`」。**整场加载的产物必须和现在逐位相同**：判据是全库画面哈希等于基线。这也是为什么不另写一条增量路径，而是让整场加载走同一条路——只有这样「整场 = 逐个装」才有东西可比。

场景级资源改成可增长：纹理表按增量追加上传；fbo 池从 `populate` 的局部变量改成带引用计数的字段，归零释放；粒子索引缓冲容量不够时重建，draw 在编码时取当前缓冲（现在就是这么取的）；变形纹理按对象建；裁切遮罩、挂点戳第一次用到才建；阴影投射者按对象建，投射管线按键缓存。深度附件仍按加载时定一次：运行中的片段要深度而场景没有时，由片段的 `sceneFlips` 退回整场重载（总计划已定）。

派生量不再在构造函数里从 `bundle.layers` 算死：
- **粒子序号**决定随机种子，L3a 起登记表是它的属主，`GpuScene` 改成由调用方给（`build` 的 `particleOrdinal` 回调，缺省按 `bundle.layers` 的顺序数，产物不变；宿主传 `registry.particleOrdinal`）；
- **反射名单**按 `structureVersion` 从活的 `bundle.reflection.list` 刷新（登记表原地维护这个数组）；
- `layerByObject` 随装卸维护。

**删除路径接上登记表**（L3b 留下的 `structural: true`）。两个阻碍里，`newLayerId` 改成单调分配器就解决；组字段那个只在「删除改了组归属」时出现，而这种删除到 L7 之前仍走整场重载，所以本步 `restructure` 只在不改组时调，改组的删除摘掉登记表条目后直接重载。

不在本步：接进 `createLayer`（L5）、进出组与挂点的 GPU 重排（L7）、单对象重编译（L6）。

**几条关键决策**
- 缺管线怎么建（总计划「待定」3，已定）：`prepareObjectSync`（克隆命中缓存的同步路径）缺管线时同步 `createRenderPipeline`，当帧生效，同 WPE；异步路径照旧 `createRenderPipelineAsync`。`readyPipelines` 已经是解析完的管线表，同步路径查它。
- 装的时候出错（校验错、缺资源）：`installObject` 回滚已加的 draw、target、树，抛 `SceneRenderError`，由调用方整场重载。`prepareObject` 出错只释放自己建的 fbo。
- `releaseRemoved` 保留：它仍是「状态里没有了就释放」的唯一通路（L3b 的 `onDestroyed` 不直接调 `removeObject`），只是循环体换成 `removeObject`。L5 替换对象时才由宿主直接调。

## 现状锚点

**a. `populate` 整场一次**（`render/scene.ts:2695`）
```ts
private async populate(state, size?, target?, onProgress?): Promise<void> {
  // …场景目标、纹理表（this.textures = bundle.textures.map(…)）、占位纹理、反射 RT、阴影图集、图集纹理…
  const built = buildableLayers(bundle);
  this.createPuppetResources(built);                        // 现状：全部 puppet 一次（变形纹理 + 裁切遮罩）
  for (const layer of bundle.layers) if (layer.attachment) this.attachments.set(layer.object, layer.attachment);
  if (this.attachments.size) this.stamps = new WorldStamps();  // 现状：加载时定
  const plans = built.map((layer) => this.planOf(layer, state));
  if (… wantsDepth(…)) this.depthTarget = this.createDepthTarget();  // 深度附件：按全部计划定一次（保留）
  // 程序：收集全部 used → ensureProgram 并行 → 汇总失败
  const fboPool = new Map<string, number>();                 // 现状：局部变量，没有引用计数
  // …视图投影、透视相机…
  const particleCapacity = plans.reduce(…maxcount…);         // 现状：按全场最大 maxcount 建一次
  if (particleCapacity >= 0) this.createParticleIndices(particleCapacity);
  const runtimes = plans.map((plan, index) => { /* fbo 映射（池 / 独占）、LayerRuntime、this.layers.push、runtimeByObject.set */ });
  for (const runtime of runtimes) if (runtime.layer.dependedOn) this.createLayerTarget(runtime.layer);
  const prepared = await Promise.all(plans.map((plan, index) => this.prepareLayer(plan, runtimes[index])));
  // 泛光、体积光（场景级）
  const worlds = new Map<number, Mat4>();
  runtimes.forEach((runtime, index) => this.install(runtime, this.buildLayer(runtime, plans[index], prepared[index], state, worlds)));
  device.queue.submit([setup.finish()]);
}
```
`build`（`:1636`）在 `populate` 之后另调 `prepareVariants(state)`（预建变体管线）与 `buildShadowCasters(state)`（整场的投射者）。

**b. 构造函数里从 bundle 算死的表**（`:1489`）
```ts
for (const layer of bundle.layers) if (layer.particle) this.particleOrdinals.set(layer.object, ordinal++);   // 现状：GpuScene 自己数
for (const layer of bundle.layers) this.layerByObject.set(layer.object, layer);                           // 现状：加载时一次
this.reflectionList = reflection?.planar && reflection.enabled ? new Set(reflection.list ?? []) : null;   // 现状：readonly，加载时拷一份
```

**c. 删除的清理**（`:1524`）
```ts
private releaseRemoved(state: SceneState): void {
  const gone = this.layers.filter((runtime) => !state.layers.has(runtime.object));
  for (const runtime of gone) { /* draw 的缓冲、反射副本、独占 RT、文本合成 RT 与 fbo、变形纹理、计数器… */ }   // 现状：循环体内联，没有单对象入口；池化 fbo 不放
}
```

**d. 管线缓存**（`:1828`）：`pipelineFor` 按键缓存 `Promise`，解析完另记 `readyPipelines`；阴影投射管线 `createShadowPipeline`（`:4686`）每个投射者直接建、没有缓存。

**e. 宿主删除路径**（`host.ts:718`，L3b）
```ts
private onDestroyed(objects: number[], regroup: boolean): void {
  recordDestroyed(this.structure, objects);
  this.removeObjectEverywhere(objects, { structural: false });   // 现状：登记表与 restructure 不接
  this.renderer?.forgetObjects(objects);
  if (!regroup) return;
  this.requestScriptReload();                                     // 删除改了组归属：整场重载（L7 去掉）
}
```

**f. 新图层 id**（`script/api.ts:1778`）
```ts
private newLayerId(config): number {
  // 现状：取「bundle.layers 与已建对象的 id 最大值 + 1」——从 bundle.layers 摘掉最大 id 的层后会再发一次
  for (const layer of this.access.bundle().layers) used.add(layer.id);
  …
}
```

## 点 1 — 场景级资源可增长（`render/scene.ts`）

- **修改**
  - **纹理**：`this.textures` 改成可追加；新增 `ensureTextures(from: number)`，把 `bundle.textures[from…]` 里可上传的上传、其余留 null（规则同 `uploadableTextures`，改成按下标区间算）。`populate` 调 `ensureTextures(0)`。
  - **fbo 池**：`fboPool` 从局部变量改成字段 `Map<string, { id: number; refs: number }>`，`unique` 的键照旧按图层独占。取用加引用，`removeObject` 减引用、归零 `releaseTarget` 并删键。
  - **粒子索引缓冲**：`createParticleIndices(capacity)` 改成「容量够就不动，不够重建并释放旧的」；装粒子对象时按它的 `maxcount` 调一次。编码时已经现取 `this.particleIndices`，draw 不持有缓冲。
  - **变形纹理与裁切遮罩**：`createPuppetResources(layers)` 拆成按图层的 `ensurePuppetResources(layer)`；裁切遮罩第一次遇到有裁切的 puppet 才建，之后共用。
  - **挂点戳**：`attachments.set` 与 `stamps ??= new WorldStamps()` 放进装对象；卸对象时 `attachments.delete`，`attachedLayers` 置 null 让下次 `sync` 重算。
  - **阴影投射者**：`buildShadowCasters(state)` 拆成按对象的 `buildShadowCaster(runtime, state)`；`createShadowPipeline` 的结果按管线键缓存（同 `pipelineFor` 的键加 `shadow` 前缀），卸对象时从 `shadowCasters` 摘掉。
  - **派生量**：
    - `particleOrdinals` 改由 `build` 的 `options.particleOrdinal?: (object: number) => number` 给，缺省闭包按 `bundle.layers` 顺序数（产物不变）；装对象时取一次记进表，卸时删。
    - `reflectionList` 去掉 `readonly`，改成私有方法 `reflected(object)` 查一个按 `structureVersion` 刷新的 Set（`sync` 开头、`populate` 各刷一次；没开平面反射恒 null）。
    - `layerByObject` 装时 `set`、卸时 `delete`。
- **不动**：深度附件、场景目标、占位纹理、反射 RT、阴影图集、图集纹理、泛光、体积光，仍是场景级一次。

## 点 2 — 装卸入口（`render/scene.ts`、`render/renderer.ts`）

- **新增**
```ts
/** 备好的对象（L4）：装之前不进任何帧内结构；失败或不装时 `discardPrepared` 收回它建的 fbo。 */
interface PreparedObject {
  layer: SceneLayer;
  plan: LayerPlan;
  prepared: ReadonlyMap<DrawLike, PreparedDraw>;   // prepareLayer 的结果（程序、管线、网格布局）
  fbos: FboBindings;                                // 取过引用的池化 fbo 与独占 fbo
  textAtlases: …;                                   // textAtlasesOf(layout)
}
/** 备好一个对象（异步，不改正在画的东西）：ensureTextures → 变形纹理 → planOf → 程序 → fbo（取引用）→ prepareLayer → 变体管线。 */
async prepareObject(layer: SceneLayer, state: SceneState): Promise<PreparedObject>;
/** 程序与管线都已就绪时不经 await 备好（克隆命中缓存）：查 readyPipelines，缺的同步 createRenderPipeline（已定）；程序缺时返回 null。 */
prepareObjectSync(layer: SceneLayer, state: SceneState): PreparedObject | null;
/** 同步装上（帧边界）：LayerRuntime → layerByObject / 粒子序号 / 挂点 → 被依赖的独占 RT → buildLayer（合成 RT、draw、粒子树预热）→ install → 阴影投射者 → 粒子索引扩容。
 *  同下标已有运行时时先 removeObject（L5 的替换；粒子树经 adoptScriptControl 接回脚本控制）。出错时回滚本次加的，抛 SceneRenderError。 */
installObject(prepared: PreparedObject, state: SceneState): void;
/** releaseRemoved 的单对象版，另放 fbo 引用、粒子序号、挂点、投射者。 */
removeObject(object: number): void;
discardPrepared(prepared: PreparedObject): void;
```
- **修改**
  - `populate` = 场景级准备（含 `ensureTextures(0)`、深度附件按全部计划定、程序预收集与进度、泛光、体积光）→ `Promise.all(built.map(prepareObject))` → 按 `built` 顺序 `installObject`。
    - 世界矩阵缓存 `worlds` 在整场装的循环里共用一份（现状），单个 `installObject` 自己建一份。
    - 程序失败的汇总（Tint 一次列全）保留在场景级：`populate` 先收集全部 `used` 程序并行建，`prepareObject` 里的 `ensureProgram` 命中缓存。
    - `build` 之后的 `prepareVariants` / `buildShadowCasters` 并进 `prepareObject` / `installObject`，`build` 不再另调。
  - `releaseRemoved` 的循环体换成 `removeObject`。
  - `SceneRenderer` 转发 `prepareObject` / `prepareObjectSync` / `installObject` / `removeObject`（当前场景没有时抛错）；`build` 时把 `particleOrdinal` 传下去（渲染器的选项加一项，宿主与探针各传各的）。
- **装卸的顺序约束**（写进注释）：`installObject` 只能在 `sync` 之前或 `encode` 之后调（帧边界），L5 定具体时机。

## 点 3 — 删除路径接上登记表（`host.ts`、`script/api.ts`）

- **修改** `onDestroyed`：
```ts
this.removeObjectEverywhere(objects, { structural: true, restructure: !regroup });   // 改组归属的删除：摘登记表条目、不 restructure，照旧重载
```
  `removeObjectEverywhere` 的选项相应拆成 `structural` 与 `restructure` 两项。
- **修改** `newLayerId`：`ScriptApi` 记一个单调的 `nextLayerId`，在 `adoptBundle` / 换 bundle 时取「当前 bundle 图层与已建对象 id 的最大值 + 1」与旧值的较大者，发出后加一；配置里带的非 0 id 照用。`findLayer` / `getLayerByID` 按活 bundle 找，删掉的找不到就是对的，不改。
- `GpuScene.restructure` 不做（L7）。

## 点 4 — 宿主与探针

- 宿主 `beforeFirstFrame` 建登记表的时机提前到拿到 bundle 之后、建 GPU 场景之前，`SceneRenderer.load` 传 `particleOrdinal: (o) => registry.particleOrdinal(o)`。
- dev 探针建场景不传，走缺省闭包，产物不变。
- `addGpuObject` 空钩子本步仍不接（L5 接 `prepareObject` → `installObject`）。

## 验收

- **画面哈希**：`node ignore/live/l0/hash_all.mjs --out ignore/live/l4/hash-after.json`，与 `hash-base-1.json` 用 `hash_compare` 比，排除两遍基线之间不同的场景；判据是 0 差异。这一项由我在执行代理交回后跑（要重建宿主产物）。
- **假设备单测**（搭法同 `render/p6d3.test.ts`）：
  - 整场 `build` 与「空场景逐个 `prepareObject` + `installObject`」的 draw 列表相同：比每个 draw 的 `object`、`passKey`、管线键、顶点缓冲字节数、op 种类序列、合成 RT 数、fbo 池键集；
  - 同一对象 `removeObject` 再装回，draw 相同；池化 fbo 引用回到原值；
  - 建删 100 次后 `owned` 数、`targets` 活跃数、fbo 池大小、`shadowCasters` 数、`particleOrdinals` 大小回到基线；
  - 粒子索引：先装小 `maxcount` 再装大的，缓冲重建、旧 draw 编码时用新缓冲；
  - `prepareObjectSync`：管线就绪时返回备好的对象且不建新管线；缺管线时同步建、`readyPipelines` 多一项；程序缺时返回 null；
  - `installObject` 中途失败（桩让 `createTarget` 抛）回滚：`layers` / `runtimeByObject` / `draws` 不含它、fbo 引用不涨；
  - `newLayerId`：删掉最大 id 的层后再建，id 不回落。
- **全语料**：`ignore/live/l3/run-reg.sh`（登记表对照）与 `ignore/live/l0` 的编译摘要仍全 0 / 全同（本步不碰编译，只做回归）；`scriptCorpus` 236/236 不变（我跑）。
- 相关测试照过（`render/`、`host*`、`script/`、`dev/`），wpe-scene `tsc` 0 错误，prettier。
- **变异**（按原字节还原）：
  - fbo 引用不减；
  - 粒子索引不扩；
  - `installObject` 漏 `runtimeByObject`；
  - `removeObject` 漏独占 RT；
  - `newLayerId` 不单调；
  - 删除后不调 `restructure`（非改组）。
- **真机**（我做）：`p6d3-struct` 再跑一遍（删非组对象走登记表，删组仍重载），日志无异常；几张带粒子、文本、puppet 的真实场景预览正常。

## 验收中的补充（2026-11-17）

**实现与本计划不同的几处**（复核后接受）：
- **变体管线与投射者在整场加载时没有并进 `populate`**：`render/rebuild.test.ts` 钉住了「预建在 `populate` 的错误作用域之外、坏 WGSL 只落在图层自己的作用域」「预建时显存不足加载不失败、图层冻结」两条，并进去会破坏。`build` 仍在 `populate` 之后另跑，但改成逐对象调和 `prepareObject` / `installObject` 同一组函数（`prepareVariantsOf`、`prepareShadowCasters`、`installShadowCasters`）；单个对象的变体段串成一串跑（`serialVariants`）。
- **同步建管线**没改 `programs.ts`（不在范围里）：`capturePipeline` 给 `createPipeline` / `createShadowPipeline` 一个只有 `createRenderPipelineAsync` 的设备替身，当场转调同步的 `createRenderPipeline`，管线描述不另写一份。实现变了它返回 null、退回异步路径。
- `ensureTextures(from, layer)` 另外补传这一层要用、之前没传的纹理：空场景起步逐个装时，只被「关着且带不支持项」的 effect 用过的纹理不在表里。整场加载时是空操作。
- `targets` 加了空位表，放掉的下标复用，不无限增长。
- `layerByObject` 卸载时若仍是别的图层的组就保留（改组归属的删除到重载之前，子层的 `groupOf` / `groupDepth` 还要查它）。
- 替换同一对象（L5 的路）：`teardown({ replacing: true })` 不删子对象的挂点、粒子树接回脚本控制；别的图层引用旧独占 RT 的 draw 没有重绑，留给 L5。
- 删对象时投射者的 draw 从 `draws` / `drawsByPass` 摘掉（原来会留着），不影响画面。
- `newLayerId` 的下界除了 `adoptBundle` 时抬高，发现脚本看到的 bundle 换了也抬高。
- `removeObjectEverywhere` 的选项拆成 `structural` / `restructure` 两项，`onDestroyed` 传 `{ structural: true, restructure: !regroup }`。

**复核时补的一条测试**：我的变异「`syncReflectionList` 只在 `force` 时刷新」原来没有任何测试抓到；执行代理在 `p13b2-reflection.test.ts` 补了「名单随登记表增删刷新」：运行中装进来的反射对象进反射 pass、已装的对象进出名单、代数不变时不重读。补后抓到。

**我做的变异**（执行代理的 6 条之外）：投射者泄漏、`acquireFbo` 不加引用、`installCore` 漏记粒子序号、反射名单不刷新——4 条都被抓到（最后一条是补测试之后）。

**基线的两遍**：第一遍 3434 s，216 张有哈希、20 张出错（视频首帧超时、`render:no-program`、求值无应答等，和 L0 同类，不进对照）。第二遍第一次起不来（最后一张场景求值无应答后 20 s 内开不出新宿主，瞬时），重跑后 217 张有哈希、19 张出错，两遍对上的 216 张逐张相同、0 张不稳定。

**结果（2026-11-17）**：
- **画面哈希**：L4 产物（`index-DUj4Ypx6.js`）全库再跑一遍，与基线对上的 216 张 × 3 档全部相同，0 差异。
- **`scriptCorpus`**：与 L3b 基线 236/236 相同。
- **真机** `p6d3-struct`：删非组对象走登记表（`structural: true` + `restructure`），删组仍两次重编译（L7 前的预期），最终 6 个对象与 WPE 日志一致，帧时间均值 0.34 ms，脚本无报错，应用日志无异常。主窗口在后台时场景帧循环不走，要用户切到前台才跑得到删层阶段。
- 单测 175 文件 3594 条（含补的反射用例后 l4 / p13b2 21 条）通过，tsc 0 错误，prettier 通过；全语料登记表对照与编译摘要仍全 0 / 全同。

## 交付

opus 执行代理在主工作区实现（起初派的 sonnet 改了 6 行就停掉还原，按用户要求换成 opus 重派）。
- **只改**：
  - `apps/wpe-scene/src/render/scene.ts`、`render/renderer.ts`、`render/structure.ts`（如需）、`render/shadows.ts`（投射管线缓存，如需）；
  - `script/api.ts`（只 `newLayerId`）；
  - `host.ts`（只 `onDestroyed` / `removeObjectEverywhere` 的选项、登记表建立时机、`particleOrdinal` 传递）；
  - 各自的测试；
  - `ignore/live/l4/`（`hash-base-*`、`host-build.json` 是基线，不要碰）。
- **不碰**：`compile/`（本步产物不能变）、`dev/`、`particles/`、文档与计划（我写）。
- **不跑**：`buildSceneHost.ts`、`hash_all.mjs`、`corpus_run.mjs`——基线正在用 dev 宿主取，重建产物会污染它。
