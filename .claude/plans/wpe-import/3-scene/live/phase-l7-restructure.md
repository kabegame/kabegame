# L7 — 结构变化不重编（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L7」。前面几块：[phase-l4-gpu-objects.md](phase-l4-gpu-objects.md)（`prepareObjectSync` 同步建缺的管线、`installObject` / `removeObject`、删除路径接登记表但改组归属的仍重载）、[phase-l6-object-recompile.md](phase-l6-object-recompile.md)（`LiveObjects` 的替换路径、运行中不支持项的处理）。
> WPE 实测（P6d3 步骤 0，`phase6/phase-6d3-runtime-layers.md`「步骤 0 实测记录」）：**进组当帧生效**——R 挂进组 G 的同一帧就画进 G 的合成 RT；R2 挂进没有子层的组合层 H，当帧 H 就有了合成 RT（成了组）；**删组当帧**剩下的子层改由顶层画（`p6d3-struct` 第 5、6 阶段，抓帧 `ignore/p6/d3/out/wpe-s5.png` / `wpe-s6.png`）。我们现在这三种都整场重编译、晚一段，是 P6d3a 记下的已知差异；语料里 `setParent` 0 处、`destroyLayer` 只有 `2887099508`，本步同样主要是正确性与把最后一类整场重载去掉。

## 总体设计思路

结构变化（换父、换挂点、删除）现在分两类：不改编译产物的只改状态、渲染侧每帧读状态；改组归属或挂点的（`reparentNeedsRecompile` / `destroyNeedsRecompile`）请求一次整场重编译。本步把第二类也改成当帧生效，办法不是把「组」编进片段，而是承认组、子树、挂点本来就是**位置相关的派生量**（L1 起就不进片段、L3a 起由登记表 `restructure` 按运行中的父与子表重算），只差渲染器没有跟着派生量重排。所以 L7 做三件事：

1. **编译期把组可能用到的东西都备齐**：每个组合层（`passthroughModel`）都编 `groupUpload` 上屏 pass，不再只给加载时就有子层的——运行中变成组的组合层要用它上屏。别的都不用预编：组的基础 pass（compose / clear）本来就有，子层在组里的管线差异（写 alpha 的混合、不带深度附件）是管线状态不是程序，缺的管线按 L4 的 `createPipelineNow` 当帧同步建。
2. **登记表 `restructure` 变成唯一的结构入口并报出「谁变了」**：换父与删除都当场 `restructure`（删除不再分改不改组），它比较每个图层重算前后的 `group` / `subtree` / `attachment` / effect 的组内标记，返回变了的对象集合与组内不支持项。`reparentNeedsRecompile` / `destroyNeedsRecompile` 删掉，宿主的两处 `requestScriptReload` 删掉。
3. **渲染器按「谁变了」当帧重排**：`GpuScene.restructure(changed)` 记下集合，下一次 `sync`（同一帧，脚本之后、绘制之前）在 `releaseRemoved` 之后、`rebuildStructures` 之前处理：对每个已装的受影响图层按当前状态重新规划、签名变了就重建（`rebuildLayer`，缺的管线同步建），新组借到合成 RT、出组的回顶层、挂点表按 `layer.attachment` 更新。组只是子树顺序变了（本来就是组、子表增减）不用重建：`subtree` op 每帧读 `layer.subtree`。`SceneLayer` 对象是登记表与渲染器共用的同一份，`groupOf` / `groupDepth` / `layerStructure` 读到的已经是新值，渲染器要补的只是 draw 与资源。

关键决策：
- **当帧而不是下一帧**：换父发生在脚本阶段，`sync` 在脚本之后、`encode` 之前，所以在 `sync` 里重排就是 WPE 的时序（进组当帧画进组的 RT、删组当帧子层由顶层画）。删除同理：`settleDestroyed` 在全部脚本之后，`sync` 先 `releaseRemoved` 再重排。
- **受影响集合由登记表比较得出，不由调用方推算**：换父要考虑旧父链、新父链、自己的子树、新旧组的 `subtree`，删除要考虑被删组的子树与变根的子对象，推算容易漏；比较重算前后每个图层的派生字段最稳，代价是一次全表比较（图层数量级几十到几百，每次结构变化一次，可以接受）。
- **运行中出现的组内不支持组合**（P6d3 时「待定」4）：`restructure` 返回的 `groupChildIssues`（子层读快照、fullscreen、透视、模型、形状）与新组自身的三个场景级条件（透视场景里的组 `camera:perspective:group`、被依赖的组 `dependency:group`、开雾的组 `fog:group`）照 L5 / L6 的规则：**那个对象不画**（卸掉它的 GPU 运行时）、`report.unsupported(keys)` 经看板娘提示一次，场景不退回、不重载。出组之后再变回支持的，照常重排回来（`restructure` 的变化集合会含它）。
- **重排失败整场重载兜底**：规划问题、管线建不出、合成 RT 建不出都抛，宿主按 `LiveObjects` 的 `reload` 路径整场重载（结构里照记，重载后一致）。这是原路径，不新加。
- **编译摘要基线**：`groupUpload` 从「有子层才编」改成「组合层都编」，没有子层的组合层所在场景的 bundle 多了这个字段，L0 的编译摘要会变。比较脚本忽略 `layers[*].groupUpload`，其它逐字段全同；画面哈希不受影响（没有子层的组合层整层不画，`graph.ts` 的空计划路径不读它）。
- **探针同路**：`probe.ts` 的 `createProbeLive` target 加 `restructure`，`probeScripts` 的换父 / 删除钩子交给它，不再需要 `bundle` 参数；`scriptCorpus` 没有 GPU，只做登记表 `restructure`（现状如此）。

## 现状锚点

**a. 判定要不要重编译**（`script/structure.ts:54-88`）
```ts
export function reparentNeedsRecompile(input: {...}): boolean {   // 现状：挂点前后有一边不为空、子树或两条父链上有组 → 整场重编译
  if (oldBone !== null || bone !== null) return true;
  return subtreeHasGroup(...) || chainHasGroup(..., oldParent) || chainHasGroup(..., parent);
}
export function destroyNeedsRecompile(state, bundle, objects): boolean { ... }   // 现状：被删的在组里、是组、父链或子树有组 → 整场
export function settleDestroyed(state: SceneState, hooks: SettleHooks = {}): number[] {
  const regroup = destroyNeedsRecompile(state, hooks.bundle, state.pendingDestroy);   // 现状：先判，再 flushDestroy，交给 removed(objects, regroup)
  ...
}
```

**b. 宿主的两处重载**（`host.ts:806-818`、`:913-922`）
```ts
private onReparented(change): void {
  recordReparent(this.structure, change.object, change.parent, change.bone);
  if (!this.scriptState || !reparentNeedsRecompile({ state: this.scriptState, bundle: this.scriptBundle, ...change })) return;
  this.stats.recompiled.push({ reason: `script（setParent ${change.object}）`, keys: [] });   // 现状：改组 / 挂点 → 整场
  this.requestScriptReload();
}
private onDestroyed(objects: number[], regroup: boolean): void {
  recordDestroyed(this.structure, objects);
  this.removeObjectEverywhere(objects, { structural: true, restructure: !regroup });   // 现状：改组归属时不 restructure
  this.renderer?.forgetObjects(objects);
  if (!regroup) return;
  this.stats.recompiled.push({ reason: `script（destroyLayer …）`, keys: [] });   // 现状：改组归属 → 整场
  this.requestScriptReload();
}
```
换父之后登记表没有 `restructure`（不改组的换父只改状态里的 `parent`，`bundle.layers[i].parent` 与 `children` 留在旧值；渲染器的世界矩阵读状态，所以画面对，但 `attachment` 不会跟着变）。

**c. 登记表的重算**（`compile/registry.ts:305-331`）
```ts
restructure(state, bones): Map<number, string[]> {
  for (const layer of layers) { const live = state.layers.get(layer.object); if (live) layer.parent = live.parent; }
  ... bundle.children 按状态子表重写 ...
  applyAttachments(layers, (layer) => bones(layer.object));
  const issues = applyGroupRules(layers, children);        // assignGroups 写回每个图层的 group / subtree，再标组内 effect
  for (const layer of layers) if (state.layers.has(layer.object)) state.syncEffectSupport(layer);
  this.cameraCache = null; this.revision++;
  return issues;                                           // 现状：只返回组内不支持项，不说谁变了
}
```

**d. 编译期只给有子层的组合层编上屏 pass**（`compile/bundle.ts:3034`、`:3125-3139`）
```ts
const hasChildren = layer.passthroughModel && parents.includes(index);
if (hasChildren && bundle.general.perspective) unsupported.add("camera:perspective:group");
...
if (depended && hasChildren) unsupported.add("dependency:group");
...
if (hasChildren) {                                          // 现状：有子层才编 groupUpload
  layer.groupUpload = await compilePass({ ...pass, combos: { ...pass.combos, ...passthroughCombos(0) } },
    { key: `objects/${index}/groupupload`, planned: [{ slot: 0 }] });
  layer.groupUpload.uniforms.g_Color4 = [1, 1, 1, 1];
}
```
`fog:group` 同样按 `hasChildren` 报（`:3085-3094`）。

**e. 渲染器对组的依赖**（`render/scene.ts`）
- `groupOf(layer)` / `groupDepth(layer)`（`:1744-1757`）读 `layer.group`，`layerStructure`（`render/structure.ts`）按 `layer.group == null` 取顶层，都按 `state.structureVersion` 缓存，**读的是和登记表同一个 `SceneLayer` 对象**；
- `pipelineOf`（`:2590-2606`）把 `groupOf(layer)` 与「有没有深度附件」编进管线键：组里「画到场景」的绘制写 alpha、`copyBackground` 为 false 时 alpha 取 MAX，组里的管线不带深度状态——进出组时管线不同；
- `ensureComposites`（`:2175-2200`）按 `groupDepth` 另开池（键 `|k<depth>`）；
- `planLayer`（`render/graph.ts:907-908`、`:1192-1197`）：`group = passthroughModel && subtree.length > 0` 时走「基础 pass → `subtree` → `groupUpload` 上屏」，没有 `groupUpload` 报 `render:no-group-upload`；
- `subtree` op（`:6224-6235`）每帧按 `op.layer.subtree` 画子孙，顶层按 `layerStructure(...).top`（`:6378`）；
- `rebuildLayer(runtime, state, worlds, { force })`（`:4946-5006`）：`planOf` → 签名比较 → `preparedOf`（管线缺了抛 `render:variant-missing`）→ `buildLayer` → 换 draw；`prepareObjectSync`（`:3284`）里缺的管线用 `createPipelineNow` 当帧建，但 `rebuildLayer` 没有这条；
- `teardown`（`:1712-1716`）：`layerByObject` 在「还是别的图层的组」时留着（L4 为改组归属的删除到重载之前留的）；
- `sync`（`:4546-4567`）：`syncReflectionList` → `structureVersion` 变了就 `releaseRemoved` → 文本 / 用户纹理 / 材质状态 → `rebuildStructures(dirty.structures)` → 刷新；
- 挂点：`installCore` 按 `layer.attachment` 写 `this.attachments`（`:3488-3491`），之后不再更新。

**f. 探针**（`dev/probeScripts.ts:620`、`dev/probe.ts` 的 `createProbeLive`）：`settleDestroyed(state, { runtime, removed })` 没传 `bundle`（删除一律当不改组），换父钩子只记结构；`probe.ts` 的 target 有 `prepareSync` / `install` / `removeGpu`，没有重排。

## 点 1 — 组合层都编 `groupUpload`（`compile/bundle.ts`）

- **修改** `compileOne`：`groupUpload` 的条件从 `hasChildren` 改成 `layer.passthroughModel`（fullscreenlayer 也是组合层，照编；带子层照报 `model:fullscreen:children` 不变）。三个场景级条件（`camera:perspective:group`、`dependency:group`、`fog:group`）仍按 `hasChildren` 报——加载时的组照旧整场退回，运行中变成组的交给点 3。
```ts
if (layer.passthroughModel) {                                // 修改：组合层都编（运行中变成组时要用，L7）
  ...compilePass(...groupupload...)
}
```
- **修改** `ignore/live/l0` 的摘要比较（`sum.mjs` / 比较脚本）：忽略 `layers[*].groupUpload`，其余逐字段比；或在确认只差这一字段后重取 `bundle-base-2.json`。两种都可，以执行时省事为准，结果里写明。

## 点 2 — 登记表报出变化（`compile/registry.ts`、`script/structure.ts`）

- **修改** `restructure` 返回 `{ changed: Set<number>; issues: Map<number, string[]> }`：重算前记每个图层的 `group`、`subtree`（数组拷贝）、`attachment`（`parent` + `bone`）与 effects 里 `GROUP_CHILD_FRAMEBUFFER` 的标记集合，重算后逐图层比较，任一不同就进 `changed`。`parent` 本身变了但派生量没变的（顶层之间换父）不进 `changed`——渲染器读状态里的父，不用重排。
```ts
restructure(state, bones): { changed: Set<number>; issues: Map<number, string[]> } {
  const before = new Map(layers.map((layer) => [layer.object, snapshotOf(layer)]));   // 新增：group / subtree / attachment / 组内 effect 标记
  ... 原来的重算 ...
  const changed = new Set<number>();
  for (const layer of layers) if (!sameSnapshot(before.get(layer.object), snapshotOf(layer))) changed.add(layer.object);   // 新增
  return { changed, issues };
}
```
- **删除** `reparentNeedsRecompile`、`destroyNeedsRecompile`、`chainHasGroup` / `subtreeHasGroup` / `isGroup`；`SettleHooks.bundle` 与 `removed` 的 `regroup` 参数。
```ts
export interface SettleHooks {
  runtime?: ...;
  removed?(objects: number[]): void;                       // 修改：没有 regroup
}
export function settleDestroyed(state: SceneState, hooks: SettleHooks = {}): number[] {
  const removed = state.flushDestroy();                    // 修改：不再先判改不改组
  ...
}
```
- 现有调用方（`host.ts`、`probeScripts.ts`、`addCompiledObject` 里的 `restructure`、`removeObjectEverywhere`）接新的返回形状；`addCompiledObject` 的 `issues` 处理不变。

## 点 3 — 宿主：当场重排、不再重载（`host.ts`）

- **修改** `onReparented`：记结构 → `registry.restructure` → 把 `changed` 与 `issues` 交给 `applyRestructure`。不再 `requestScriptReload`，`stats.recompiled` 不增。
- **修改** `onDestroyed(objects)`：`removeObjectEverywhere(objects, { structural: true })` 一律 `restructure`（选项 `restructure` 删掉），`removeObjectEverywhere` 返回 `restructure` 的结果，交给 `applyRestructure`。
- **新增** `applyRestructure({ changed, issues })`：
  1. `issues` 里新出现的（对象 → 键，和上次 `restructure` 的结果比；`addCompiledObject` 里那一份也并进来）：`report.unsupported(keys)`，有 GPU 时 `renderer.removeObject(object)`（不画）；从 `issues` 里消失的对象（出组后又支持了）照常重排回来。新组的三个场景级条件在这里判（组是 `passthroughModel && subtree.length > 0`；透视场景、`dependedOn`、`fogPassthrough` 开雾）：同样上报、组本身不画。
  2. 其余 `changed` 里已装 GPU 的：`renderer.restructure(changed)`（记下，`sync` 里做）；`init` 期间（`runtimeTask`）没有 GPU，登记表已经是新的，建场景时自然带上，不再二次编译。
  3. 用 `stats` 新增 `restructured: number` 计数（dev 探针读）。
- **修改** `sessionUseful`：不再认 `layer-structure` 这个原因（它只剩 `general/perspectiveoverridefov` 一类场景级的，整场重载不用会话）——检查 `RecompileReason` 里 `layer-structure` 的发出处（`compile/bundle.ts:1453`、`texts.ts:157`）在 L6 之后对象级的都走 `objects/<i>/`，这里只是把会话常驻条件收紧；若收紧后 L6 的对象级重编译接不上会话（`objectLive` 要 `compileSession`），就保持原样。执行时按 `host.l6.test.ts` 的用例定。
- **删除** `removeObjectEverywhere` 的 `restructure` 选项与两处「L7 去掉」注释。

## 点 4 — 渲染器当帧重排（`render/scene.ts`、`render/renderer.ts`）

- **新增** `GpuScene.restructure(objects: Iterable<number>)`：并进 `pendingRestructure`（Set）。`SceneRenderer` 转发。
- **修改** `sync`：`releaseRemoved` 之后、`rebuildStructures` 之前：
```ts
if (this.pendingRestructure.size) this.applyRestructure(this.pendingRestructure, state, worlds);   // 新增
```
- **新增** `applyRestructure(objects, state, worlds)`，对每个有运行时的对象：
  1. 挂点：按 `runtime.layer.attachment` 写 / 删 `this.attachments`，`attachedLayers = null`，有挂点时 `stamps ??= new WorldStamps()`；
  2. `rebuildLayer(runtime, state, worlds, { syncPipelines: true })`：签名没变就不重建（本来就是组、只是子表变了；顶层之间换父）；
  3. 清空 `pendingRestructure`，`structureCache = null`（`structureVersion` 已变，保险起见）。
- **修改** `rebuildLayer` 加选项 `syncPipelines`：`preparedOf` 抛 `render:variant-missing` 时，若带这个选项，改走 `prepareObjectSync` 里那一段「程序在 `readyPrograms`、管线缺的 `createPipelineNow`」（抽成 `preparedOfSync(plan, runtime)`，程序不在就照抛）。进出组时程序不变、只有管线状态变，所以同步建总能成。
- **修改** `teardown`：去掉「还是别的图层的组时留着 `layerByObject`」的特例（删除生效前登记表已 `restructure`，子层的 `group` 已不是它）。
- **修改** `ensureComposites`：出组 / 组深度变了的图层，`runtime.resources.composites` 里借的是旧深度池的 RT，重建时按新键重借（清掉 `composites` 再 `ensureComposites`；被依赖层的独占那张照旧第 0 张）。文本层独占的 `ensureTextComposites` 同样按新深度键重建标签即可（尺寸不变不用换）。
- 组的合成 RT：新组走 `buildLayer` → `ensureComposites` 按 `plan.composite` 借，`groupUpload` 的管线按组自己的管线键（顶层 / 上一层组）同步建；被删的组 `releaseRemoved` 的 `teardown` 已放资源。

## 点 5 — 探针（`dev/probe.ts`、`dev/probeScripts.ts`）

- **修改** `probeScripts` 的 `reparented` / `removed` 钩子：换父后、删除后都调 `live.restructure()`（新钩子，`ProbeLiveHooks.restructure?(objects)`），由 `probe.ts` 做登记表 `restructure` + `scene.restructure(changed)`；`issues` 照 L5 的 `unsupportedKeys` 记、对象 `removeObject`。`scriptCorpus` 没给 `live`：只做登记表（`probeScripts` 自己持有 registry 时）或什么都不做（现状），结果不变。
- `renderFrame` 结果加 `restructured`（次数）。

## 验收

- **编译摘要**：全语料与 L0 基线比，差异只在 `layers[*].groupUpload`（没有子层的组合层），其余逐字段全同；登记表对照（`ignore/live/l3/run-reg.sh`）、子系统对照（`ignore/live/l3b/run-sub.sh`）全 0。
- **全库画面哈希**：216 张 × 3 档与 L4 基线相同（`render/scene.ts` 的 `teardown` / `rebuildLayer` 改了，加载路径要复核）。
- **`scriptCorpus`**：236 张不变（它不走 GPU；如有 `setParent` / `destroyLayer` 原因的 `recompile` 项则消失，其余不变）。
- **单测**：
  - `registry.restructure` 的 `changed`：进组（自己 + 新组）、出组（自己 + 旧组）、换到另一个组（三者）、删组（子层变根：子层进 `changed`）、顶层之间换父（空集）、换挂点（自己）、子表只换顺序（组进 `changed`——`subtree` 变了，但渲染器签名不变不重建）；
  - `GpuScene.restructure`：进组后子层的 draw 目标是组的合成 RT、管线换成组内的（同步建）、顶层不再画它；没有子层的组合层变成组时借到合成 RT、`groupUpload` 上屏；出组回顶层、管线换回带深度的；删组当帧子层由顶层画；挂点表更新；签名不变不重建（`rebuildStats` 不增）；重排失败抛错；
  - 宿主：`onReparented` / `onDestroyed` 不再 `requestScriptReload`、`stats.recompiled` 不增、`restructured` 计数；组内不支持组合上报并卸 GPU，出组后恢复；`init` 里换父进组不二次编译、建场景时子层在组里；重排抛错走整场重载；
  - `settleDestroyed` 新签名；探针同路。
- **变异**（执行代理做 + 我另做）：不重算 `subtree`（组内新加的子层不画）；旧组不重排（出组后仍画进旧组）；不建新组的合成 RT；管线不同步建（进组后 `variant-missing`）；`teardown` 保留旧组的 `layerByObject`；挂点表不更新；`changed` 漏掉新组自身。
- **真机**（我做）：
  - `ignore/p6/d3/proj/p6d3-struct` 第 5、6 阶段：删组后左下角 G1 当帧由顶层画，和 `wpe-s5.png` / `wpe-s6.png` 逐像素比（此前已知差异消失）；日志 27 行仍逐行相同；
  - `p6d3-parent`：R 进组 G 当帧画进 G 的 RT（被裁掉）、R2 挂进 H 当帧 H 成组；日志前 40 行相同；
  - `p6d3-attach`：挂点换父后矩阵当帧跟 puppet（P6d3a 时「要等重编译」的那一条消失）；
  - 新工程 `live-regroup`（`ignore/live/l7/make_regroup.py`，照 L0 的生成脚本）：粒子 P 一直发射，第 60 帧把纯色层 A 挂进组 G、第 120 帧把 A 解除、第 180 帧删组 G（G 里另有常驻子层 B）；只有一次「开始渲染」、`recompiled: []`、`restructured: 3`、P 的粒子连续；WPE 抓第 60 / 120 / 180 帧与我们的逐像素比。

## 验收中的补充（2026-11-17）

**实现与本计划不同的几处**（复核后接受）：
- `groupUpload` 不就地编：只改条件、就地编时 78 张场景的程序下标被挪（`programs` / `layers` 都变），放到全部对象之后编（整场在 `finalize` 泛光链之后、片段在 `compileOne` 之后）才只多表尾的程序。摘要比较的口径相应改成「没有子层的图层把 `groupUpload` 记成 null、截掉表尾只被它们引用的程序」（`KBP_IGNORE_GROUP_UPLOAD=1`），这个口径下当前产物和 L0 原基线 `bundle-base-1.json` 233/233 相同（HEAD 带开关也相同）。
- `structureKey` 多比组的层数：嵌套组换归属时组里子孙的 `group` 不变、层数变了，合成 RT 要换按层数分开的池。
- 渲染器签名之外还比组归属（`LayerRuntime.placement`）：子层在组里组外的计划签名相同，只看签名进出组都不会重建。
- 宿主在脚本之后自己调 `flushRestructure`（出错整场重载），`sync` 只兜底（暂停时的补画帧、探针）：`sync` 里抛错会被渲染器当成 `fail` 直接退回预览图。
- 组合层变组要用的程序（compose / `groupUpload` / passthrough）在建场景与备对象时另外备好（`groupPrograms`）：没有子层的组合层加载时计划是空的，不备就永远同步建不出管线。
- 计划外的保护：深度检查 `render:restructure-depth`；组归属变了之后同步重备变体管线（否则之后切 effect `variant-missing` 退回）；粒子层重排时沿用粒子树。
- 组内问题只跟踪这次 `changed` 里的与已记下的对象；运行中接进的对象（L5 / L6）自己的组内问题并进片段的不支持项，走 L5 的「不装 + 上报」；异步装的对象装之前再拦一次。
- `sessionUseful`：点 3 的前提不对（`size` / `colorBlendMode` / `castshadow` / `reflected` / 文本字段的 `layer-structure` 仍是对象级路径），只收紧成「对象级路径留会话、`general/perspectiveoverridefov` 不留」。
- `fragment.ts` 原不在交付范围，复核时追加授权：删掉 `fragmentBlocker` 的 `group-upload`（否则所有组合层都被挡、不进片段缓存，组合层的克隆退回异步）。之后 L1 新下标对照多比了 15 个组合层（6407 个）0 不同、L6 会话对照 2572 个 0 不同，blocked 只剩 `depended`。
- 探针原来没有换父钩子（锚点 f 写错），这次补上；探针的 `restructure` 删除时也把被删对象从登记表摘掉。`removeObjectEverywhere` 保留 `structural` 选项（l3b 测试在用）。
- 登记表对照脚本 l3 的那份按旧返回值写，拷到 `ignore/live/l7/registry.test.ts` 改两行；登记表 / 子系统对照的摘要基线用当前编译结果（L0 基线按设计在 94 张上不同）。

**我做的变异**（6 条，5 条抓到，按原字节还原）：宿主不把变了的对象交给渲染器（6 条测试）；`rebuildLayer` 只比签名不比组归属（`l7` 6 条）；新出现的组内不支持组合不上报；`structureKey` 不比挂点；删除之后不 `applyRestructure`。「`flushRestructure` 不先释放被删对象」没抓到——等价变异：子层的 `group` 在登记表 `restructure` 时已置空，重建不再查旧组，旧组的运行时同一帧 `sync` 的 `releaseRemoved` 照样释放，画面相同。执行代理的 11 条（子计划 7 条 + 层数不换池、`groupUpload` 就地编、接进的对象组内问题不并进片段、去掉深度检查）全部抓到。

**复核数字**：L7 相关 12 个测试文件 355 条通过，tsc 0 错误，prettier 通过；编译摘要我重跑一遍 233/233（忽略 `groupUpload` 口径，对 HEAD 与对 L0 原基线都相同）；登记表 / 子系统对照（代理跑）全 0。

**结果（2026-11-17）**：
- **`scriptCorpus`**：236 张里 95 张 `stateDigest` 变，逐张对照「有没有空组合层」234/234 一致（`SceneState.constants` 收了 `groupUpload` 的 `g_Color4`）；脚本诊断、控制台摘要、`recompile` 都不变。判据相应改成「只有这一类变化」。
- **真机 `live-regroup`**（WPE 真值 `ignore/live/l7/out/wpe-regroup-*.png`，f37 / 66 / 115 / 159 / 219）：回放到同样帧号，`recompile: []`、`restructured` 1 → 4，五张整帧的差异连通块只在标记行（y 0–32，WPE 抓到帧间）与粒子行（y 96–128，发射时序），A / B / C / G / H 各块 0 差异；脚本 11 行日志与 WPE 逐行相同；粒子 P 存活 112 → 173 连续。
- **真机 `p6d3-struct`**：第 5（f660）、6（f760）阶段与 `wpe-s5.png` / `wpe-s6.png` 0 差异，P6d3a 的「删组后子层晚一段」已知差异消失。
- **全库画面哈希**：L7 产物（`index-BxBNZdYW.js`）与 L4 基线对上的 213 张 × 3 档全部相同（基线里的 `13546`–`13548` 已不在库里，`15030`、`15336` 与两个真机工程只在新的一边，不算差异）。
- 回归条目见 `versions/latest/regression.md`「场景壁纸运行中的结构变化不重编」；T4（预览实时）、T5（组内不支持组合提示）、T6（`p6d3-attach`）留给用户勾。
- 留给以后：暂停时补画帧里的重排失败只能退回预览图；因组内问题卸掉的 puppet 连带挂点子对象一起不画；文本层换组层数时合成 RT 标签不更新。

## 交付

opus 执行代理在主工作区实现。
- **只改**：`apps/wpe-scene/src/` 下的 `compile/bundle.ts`（`groupUpload` 条件）、`compile/registry.ts`、`script/structure.ts`、`host.ts`、`render/scene.ts`、`render/renderer.ts`、`dev/probe.ts`、`dev/probeScripts.ts`、各自测试、`ignore/live/l7/`、`ignore/live/l0` 的摘要比较脚本（忽略 `groupUpload`）。
- **不碰**：`compile/fragment.ts`、`script/createLayerChange.ts`（L6 的路径不动；重排失败走它已有的 `reload`）、`report.ts`、文档与计划。
- **不跑**：`buildSceneHost.ts`、`hash_all.mjs`、`corpus_run.mjs`；不重启 dev；不做 git 写操作。
