# L5 — 运行中建层走片段（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L5」。前几块：[phase-l3b-host-subsystems.md](phase-l3b-host-subsystems.md)（`addCompiledObject` / `removeObjectEverywhere`）、[phase-l4-gpu-objects.md](phase-l4-gpu-objects.md)（`prepareObject` / `prepareObjectSync` / `installObject`）。
> 依据：P6d4 盘点 `ignore/p6/d4/inventory.md`，L0 实测 `ignore/live/l0/wpe-results.md`（克隆四项），P6d3b 的 WPE 日志 `ignore/p6/d3/out/wpe-*.log`。
> 拆成 **L5a**（宿主路径）与 **L5b**（提示链）两块并行实现，只在 `SceneReporter.unsupported` 一个接口上相接。

## 总体设计思路

现在脚本 `createLayer` 的落点是「建一个壳状态 + 请求整场重编译」：新对象晚一段（0.5–0.8 s）才画出来，`init` 里建的层让首次加载多编一次。L1–L4 已经把编译、登记表、状态、子系统、GPU 都做成了按对象的，L5 把它们接到 `createLayer` 上。

**两条路。** `createLayer` 调到宿主时先查**片段缓存**（键是规整配置）：
- **命中**：`rekeyFragment` 改成新下标与 id，`addCompiledObject(mode: "add")`（登记表 → 状态 → `restructure` → 子系统）再 `prepareObjectSync` + `installObject`，全部在 `createLayer` 返回之前同步完成。之后 `ScriptApi` 照常 `addScripts` 跑新对象的 `init`，`init` 读到的已经是编好的状态（真实的 `size`）。渲染器这一帧的第二次 `sync` / `update` / `encode` 带上它，**当帧画出**，同 WPE。
- **没命中**：照 P6d3b 建壳、`init` 照常跑；把 `create` 排进**变更队列**，会话异步编片段。片段到了之后，在下一帧 `beforeFrame` 开头（脚本之前）：`addCompiledObject(mode: "replace")`（状态换成编好的、重放这个对象建出以来的脚本写入、脚本条目换成定型的）→ `prepareObject` 已在到达时异步备好 → `installObject` → 片段进缓存。

**缓存按会话归属。** 片段里的程序、纹理下标是会话（这份 bundle）的坐标，换场景 / 整场重载时缓存整个丢掉，不跨会话用。缓存从整场 bundle 预置：每个 `fragmentBlocker` 为 null 的对象用 `fragmentOf` 取片段，**只预置「原文经规整无损」的对象**（L1 发现：`configs[i]` 规整时非整数只留 8 位有效数字，按它编出的片段和按原文编出的在少数常量末几位不同）。无损与否只有会话知道（主线程没有原文），所以会话在 `finalize` 时另算一张 `exactConfigs`（对象下标列表），经 `opened` 消息带回，**不进 bundle**（编译产物摘要不能变）。不无损的配置第一次照样异步真编，之后命中的是真编的片段。

**首次加载 `init` 里建的层**不再「放弃本次、整场再编」：`init` 跑完后，把 `structure.created` 里编译快照之后的对象经会话编成片段，逐个 `addCompiledObject` 进 bundle（这时还没有 GPU 场景，GPU 一步为空；文本层经 `layoutInCurrent` 排进当前图集），再建 GPU 场景——`populate` 从 `bundle.layers` 建，自然带上它们，首帧画的就是带新对象的画面。整场重载进行中建的层：当前场景上照常走上面两条路；新场景换上时（`beforeFirstFrame`），编译快照之后建的对象在新场景上**建壳并排 `create`**（缓存已随旧会话丢掉，不能从缓存实例化），不丢对象。

**异常都退回整场重载**：编片段失败、片段带 `sceneFlips`、装 GPU 出错。重载的结构里照记新建对象，重载后照样在。**运行中出现的不支持项**（已定 4）：这个对象不装 GPU（不画），登记表 / 状态 / 子系统 / 脚本照常，键经 `SceneReporter.unsupported(keys)` 上报（L5b 接到看板娘），记 `stats`；场景不退回。

**几条关键决策**
- 片段到达时对象已被删：只进缓存不装。
- 命中缓存装入后，这个对象的绑定按当前属性全集重写一遍（缓存里的片段按编它那一刻的属性编的初值；加载时 `applyUserProperties` 传全集，这里只对该对象的绑定做同一件事）。
- 删除生效后片段留在缓存里（建删循环第二轮起当帧出现）；`structure.created` 按 P6d4 点 7 去重（每种规整配置最多留一个已删的），只给整场重载兜底。
- L0 实测的四条由前几步天然满足，这里只验收：运行中建的粒子层按 `starttime` 预热、不复制模板现存粒子（`createParticleTree`）；关键帧时钟从 0 起、建出那帧读静态值（`SceneAnimations.add`）；保留属性绑定（片段带 `bindings`）；收光标事件（可拾取表读 `bundle.layers` 与 `state.layers`）。
- dev 探针：改用会话（`openSceneSession`），`createLayer` 调同一个变更函数；选项 `prewarmFragments`：先跑一遍收集建出的配置、经会话编好进缓存，再正式回放，第一轮就走同步路径（和 WPE 逐帧比用）。不开时照产品行为晚几帧。
- 提示链（L5b）：宿主 `report.unsupported(keys)`（同实例同键只报一次、记 warn、经 `wpe_scene_report` 上报）→ Rust `WpeSceneReport::Unsupported` 记 warn 并 `emit_to("main", "wpe-scene-unsupported", { image, surface, keys })`（`surface` 按调用方 label：`is_wallpaper_label` → `"desktop"`，否则 `"preview"`）→ 主窗口 `useSceneUnsupportedNotice`（同一张图同一个键本次运行只提示一次）调 `kameMessage.warning`，文案分桌面 / 预览，五种语言。

## 现状锚点

**a. 建层落点**（`host.ts:707`）
```ts
private onCreateLayer(config: string, parent: number | null): number | null {
  const state = this.scriptState;
  if (!state) return null;
  syncAllocator(this.allocator, this.scriptBundle);
  const object = createStructureObject(state, this.structure, this.allocator, config, parent);   // 现状：只建壳状态、记结构
  if (object === null) return null;
  if (this.runtimeTask) return object;                     // init 里建的：reload 之后发现结构变长，放弃本次、整场再编（:1966）
  this.stats.recompiled.push({ reason: `script（createLayer ${object}）`, keys: [] });
  this.requestScriptReload();                              // 现状：运行中每建一个就整场重编
  return object;
}
```
`ScriptApi.installCreateLayer`（`script/api.ts:1794`）：`createLayerConfig` → `newLayerId` → 配置文本带 `id` → `create.call(access, text, parent)` → `pending.set` → `addScripts`（跑 `init`）→ 返回图层对象。

**b. 帧序**（`render/renderer.ts:12`）：`sync` → 步进粒子 → 脚本（`beforeFrame`）→ `sync` → 写每帧 uniform → 编码。宿主 `beforeFrame`（`host.ts:1651`）：频谱 → 媒体 → 关键帧 → `runtime.frame` → `settleDestroyed` → puppet `settle`。

**c. 加载顺序**（`host.ts` `reload`）：编译 → 文本 `prepare`（:1924）→ 声音 → 用户纹理 → `pendingAnimations` / `pendingPuppets` → `ensureRuntime`（跑 `init`，:1958）→ 「init 里建了层就 `reload()`」（:1966）→ 取设备 → `current.load`（建 GPU 场景）→ `beforeFirstFrame`。

**d. 会话与片段**：`SceneCompileSession.compileFragment(request: FragmentRequest)`（`object` 是新下标，中间空位补 null；`config` 原文带 `id`；`parent` / `bone` / `properties`）返回 `FragmentDelta`；`CompileSessionClient.compileFragment(request, signal)`；`fragmentOf` / `rekeyFragment(fragment, { object, id, parent })`；`normalizeConfig` 去掉顶层 `id`、8 位有效数字。宿主的 `compileSession` 只在 `sessionUseful` 时留着（有脚本就留）。

**e. 上报**（`report.ts`）：`SceneReport` 只有 `ready` / `fallback` / `log`；Rust `WpeSceneReport` 同三种，`Ready` / `Fallback` 以 `wpe-scene-status` 发回调用方 webview。主窗口 `App.vue` 没有场景相关的全局监听；看板娘消息 `kameMessage.warning(message)`（`utils/kameMessage.ts`）；i18n 在 `packages/kabegame-i18n/src/locales/<en|ja|ko|zh|zhtw>/gallery.json`（`wpe*` 键在这里）。

**f. 探针**（`dev/probeScripts.ts:452`）：`createLayer` 建壳记结构，`frames > 0` 时记进 `recompile`（`createLayer/<object>`）；探针用 `compileSceneInWorker` 一次性编译，没有会话。

## L5a — 宿主路径

### 点 1 — 变更队列与帧边界（新 `changes.ts`，`host.ts`）
- **新增**
```ts
/** 宿主的场景变更（L5）：对象级改动排进来，编好的在下一帧 beforeFrame 开头（脚本之前）按先后装上；场景级的整场重载。 */
export type SceneChange =
  | { kind: "create"; object: number; config: string; parent: number | null; bone: string | null }
  | { kind: "reload"; reason: string };
/** 队列：`push(create)` 立刻向会话要片段（串行由会话保证），到达后 `prepareObject` 异步备好；`drain()` 在 beforeFrame 开头把已备好的按先后交给回调装上。 */
export class SceneChangeQueue { … }
```
  - 到达的片段在 `drain` 前先经 `prepareObject` 备好（异步，不碰正在画的）；`drain` 只做同步的装入。
  - 会话 `broken`、编片段抛错、`sceneFlips` 非空 → 转成 `reload`，宿主 `requestScriptReload`。
  - 对象在到达前已删（`state.layers` 没有、或在 `structure.destroyed`）：片段只进缓存，备好的 GPU 资源 `discardPrepared`。
- **修改** `beforeFrame` 开头（频谱之后、媒体之前）调 `drain`。

### 点 2 — 片段缓存（新 `fragmentCache.ts`，`compile/bundle.ts`、`compile/protocol.ts`、`compile/workerHandler.ts`、`compile/client.ts`）
- **新增** `FragmentCache`：键 = 规整配置（`normalizeConfig`，去 `id`），值 = `ObjectFragment`（模板坐标，用时 `rekeyFragment`）。
  - `seed(bundle, exact: ReadonlySet<number>)`：对每个 `fragmentBlocker(bundle, i) === null` 且 `exact.has(i)` 的对象 `fragmentOf` 进缓存；同键先到先得。
  - `put(config, fragment)`、`get(config)`；文本层的排版不进缓存（装入时 `layoutInCurrent` 现排，L3b 的 `retainLayout` 本步不用）。
  - 换场景 / 重载换上新 bundle 时整个丢掉。
- **新增** 会话：`finalize` 之后 `exactConfigs(): number[]`——对象原文经 `normalizeConfig` 的数值规整无损（每个非整数有限数 `Number(v.toPrecision(8)) === v`）的下标。`opened` 消息加 `exactConfigs`，`CompileSessionClient` 带回，`openSceneSession` 的返回值加这一项。**bundle 不加字段**（全库编译摘要必须和基线相同）。

### 点 3 — `createLayer` 的两条路（`host.ts`、`script/api.ts`）
- **修改** `onCreateLayer(config, parent)`：
  1. 照旧 `createStructureObject`（分配下标、壳状态、记结构）；
  2. `runtimeTask` 还在（`init` 里建的）→ 返回（点 4 处理）；
  3. 查缓存：**命中** → `rekeyFragment(片段, { object, id, parent })` → `addCompiledObject({ fragment }, "replace")`（壳已在状态与登记表里；登记表对这个对象还没有条目，`replace` 路径要能接受「状态有壳、登记表没有」：登记表走 `addObject`，状态走 `replaceObject`）→ 这个对象的绑定按当前属性全集重写 → 不支持项为空时 `prepareObjectSync` + `installObject`（`prepareObjectSync` 返回 null 时退回异步路径：排 `create`）→ 不支持项非空时不装 GPU、`report.unsupported(keys)`、记 `stats`；
  4. **没命中** → 排 `create` 进队列。
  - `createLayer` 的 `id` 已在配置文本里，`rekeyFragment` 的 `id` 取它。
- **修改** 片段到达的装入（队列回调）：`addCompiledObject(delta, "replace")`（含 `applyDelta`、`refreshScripts`、`replayWritesFor`）→ 绑定按当前属性重写 → 不支持项判定同上 → `installObject(已备好的)` → `cache.put`。
- **删除** 运行中建层的 `requestScriptReload` 与对应的 `stats.recompiled` 记录（`recompiled` 改记 `script（createLayer …）` 以外的原因；`stats` 加 `created: { sync, async, unsupported }` 计数）。
- `ScriptApi` 不改流程：`create` 返回之后才 `addScripts`，命中路径的装入已在 `create` 里完成。

### 点 4 — 首次加载与重载进行中（`host.ts`）
- **修改** `reload` 里「`init` 建了层就 `reload()`」（:1966）改成：对 `structure.created` 里下标 ≥ `createdAtCompile` 的对象，按先后经会话 `compileFragment`（会话这时还在 `held` 里），逐个 `addCompiledObject(delta, "replace")` 的非 GPU 部分（文本层 `layoutInCurrent`；声音、用户纹理、媒体照 L3b），`sceneFlips` 非空或编失败 → 照旧 `reload()`；然后继续建 GPU 场景。`exactConfigs` 与缓存 `seed` 在这一步之前做，`init` 建的层命中缓存时直接改键、不经会话。
- **修改** `beforeFirstFrame`：编译快照之后（`createdAtCompile` 起）建的对象，在新场景的状态上 `createStructureObject` 建壳（下标照旧）并排 `create`；旧缓存丢弃、新缓存按新 bundle `seed`。
- **修改** `sessionUseful`：有脚本的场景本来就留会话，不变；没有脚本的场景不会 `createLayer`。

### 点 5 — 删除与结构去重（`host.ts`、`script/structure.ts`）
- **修改** `recordDestroyed`：被删的是新建对象、且结构里已有同一规整配置的已删新建对象时，摘掉旧的那条（`created` 与 `destroyed` 各一项）。
- 删除生效后的清理照 L4（`removeObjectEverywhere` + GPU `releaseRemoved`），片段留在缓存。

### 点 6 — dev 探针（`dev/probeScripts.ts`、`dev/probe.ts`）
- **修改** 探针改用 `openSceneSession` 持有会话（回放结束关掉）；`createLayer` 调和宿主同一个变更函数（抽成 `script/createLayerChange.ts` 或 `host` 里可注入的纯函数，宿主与探针共用缓存、队列、两条路）。
- **新增** 回放选项 `prewarmFragments`：先按同样的 dt 序列空跑一遍（不读回、不比），收集建出的配置经会话编好进缓存，再正式回放。不开时片段到达的时机和产品一致（晚几帧）。
- `recompile` 里不再记 `createLayer/*`。

## L5b — 提示链

### 点 7 — 宿主上报（`report.ts`）
- **新增** `SceneReporter.unsupported?(keys: readonly string[]): void`；`createReporter`：本实例报过的键过滤掉，剩下的记 warn（键全列）并 `send({ kind: "unsupported", instance, image, keys })`，`image` 取 `kbScene`。dev 探针的上报器不实现。

### 点 8 — Rust（`src-tauri/kabegame/src/commands/wpe_scene.rs`）
- **新增** `WpeSceneReport::Unsupported { instance, image, keys }`：记 warn；`webview.emit_to("main", "wpe-scene-unsupported", json!({ "image": image, "surface": surface, "keys": keys }))`，`surface` 按 `crate::wallpaper::is_wallpaper_label(webview.label())` 定 `"desktop"` / `"preview"`。只送主窗口（补丁 14）。
- 反序列化单测加一条。

### 点 9 — 主窗口（`apps/kabegame/src/composables/useSceneUnsupportedNotice.ts` 新增，`App.vue`，i18n）
- **新增** composable：`listen("wpe-scene-unsupported")`，按 `image:key` 去重（本次运行），调 `kameMessage.warning(t(surface === "desktop" ? "gallery.wpeSceneUnsupportedDesktop" : "gallery.wpeSceneUnsupportedPreview", { keys }))`。
- **修改** `App.vue` 挂它（同其它全局 composable）。
- **新增** i18n 五种语言 `gallery.json`：桌面 /预览两条，例：「桌面的场景壁纸运行中用到了暂不支持的特性：{keys}，相关图层没有画出」「预览里的场景壁纸运行中用到了暂不支持的特性：{keys}，相关图层没有画出」。

## 验收

- **全语料**
  - 编译摘要与 `ignore/live/l0/bundle-base-1.json` 全同（`exactConfigs` 不进 bundle）；
  - L3 登记表对照、L3b 子系统对照仍全 0；
  - `scriptCorpus` 与 `ignore/live/l3b/corpus-base-1` 比：`recompile` 里的 `createLayer/*` 全部消失，其余字段不变（我跑）；
  - 全库画面哈希与 `ignore/live/l4/hash-base-1.json` 全同，包括 `init` 里建层的四张 bars 场景（我跑）。
- **和 WPE 比**：`p6d3b-bars` / `p6d3b-clone` 的脚本日志与 `ignore/p6/d3/out/wpe-bars.log` / `wpe-clone.log` 逐行不变，`size` 的已知差异在命中缓存时消失；`live-clone` 的四项（`ignore/live/l0/wpe-results.md`）真机核对。
- **单测**（L5a）：
  - 缓存：键去 `id`、规整；`seed` 只收无损且无 blocker 的；换 bundle 清空；
  - `exactConfigs`：有 / 无 8 位舍入的对象各一个；`opened` 消息带回；
  - 命中路径：`createLayer` 返回前登记表 / 状态 / GPU 已装、`init` 读到编好的 `size`；绑定按当前属性重写；
  - 没命中路径：壳 → 片段到达 → 状态替换、写入重放、脚本条目换成定型、GPU 装上、进缓存；到达前已删只进缓存；
  - `sceneFlips` / 编失败 / 装失败 → 重载；
  - 不支持项：不装 GPU、`report.unsupported` 调到、`stats` 计数；
  - `init` 里建的层不再二次 `reload`，建 GPU 场景前已在 bundle 里；重载进行中建的在新场景建壳并排 `create`；
  - `recordDestroyed` 去重；
  - 探针 `prewarmFragments` 第一轮命中。
- **单测**（L5b）：reporter 同键只报一次；Rust 反序列化；composable 去重与两种文案。
- 相关测试照过（`host*`、`script/`、`compile/`、`dev/`、`apps/kabegame` 的 `App` / composable 测试），wpe-scene 与 kabegame 前端 `tsc` / `vue-tsc` 0 错误，`cargo check -p kabegame`，prettier / rustfmt。
- **变异**：命中不看规整配置；片段到达时不重放写入；已删对象的片段照装；换场景不清缓存；预置不看无损标记；不支持的对象照装 GPU；reporter 不去重；composable 不去重。
- **真机**（我做，Rust 改动要用户重启 dev 后才生效）：`live-clone` 预览里点触发器克隆，四项对照；`p6d3b-bars` 当帧出现；用一个运行中建不支持对象的测试工程（`createLayer` 带缺失资源的 effect）看看板娘弹警告，桌面上的那张也弹在主窗口。

## 验收中的补充（2026-11-17）

**L5a 实现与本计划不同的几处**（复核后接受）：
- 片段到达时不直接用到达时备好的 GPU 对象：那一刻状态里还是壳（effect 开关缺省关、文本没排版），备出的计划会错，而装上之后 `sync` 不会因此重建。改成到达时只预热（`prepareObject` 一次后放弃，程序与管线进缓存），`drain` 时按真实状态 `prepareObjectSync` 再装，同步备不好才用异步备的。
- 场景级增量在到达时就进登记表（预热要用新程序与纹理；到达前已删、只进缓存的片段下标也要有效），`addCompiledObject` 加 `deltaApplied` 选项。
- `init` 里建的层当场走 `loadingLive.create`（命中就接进还没换上的 bundle，`init` 读到编好的值），没命中的在 `init` 之后等片段到齐再接上，然后建 GPU 场景；结果同计划，命中的更早。
- 重载期间建的对象：新场景上先建壳，再走完整的两条路（能命中新会话预置的缓存），不是一律排 `create`。
- `exactConfigs` 另排除带 `objects/<i>/` 脚本覆盖的对象与已删对象；缓存不收数组配置与没有 `id` 的配置；属性变化时 `dropBoundTo` 作废带「按属性整场重编译」绑定的片段。
- 绑定重写只写不挂脚本的目标（同编译期规则）。
- 文本层的 GPU 一律异步（要等 `layoutInCurrent`），命中缓存的文本层至少晚一帧出现——已知差异。
- 暂停时 `drain` 不做，恢复后才装。
- 顺带补了 L3b 的缺口：增量带视频纹理时 `addCompiledObject` 调 `loadVideos`。
- 探针：`drain` 在 `frame()` 开头（动画之后，宿主是媒体与动画之前，`particleCorners.ts` 不在范围内没动）；回放同步，没命中的片段赶不上读回帧、结果计入 `pending`；预跑那一遍只建壳不编，靠读新层的值决定建什么的脚本可能收集不全；运行中建的文本层另开一套 `SceneTexts`；声音 / 视频 / 用户纹理 / 媒体不接。`prewarmFragments` 2026-11-17 已接进 MCP / REST（`render_scene` / `host_render` / REST `render` / `renderFrames.ts --prewarm-fragments`，要和 `scripts` 一起给）。

**L5b 实现与本计划不同的两处**（接受）：宿主侧的 warn 只写 iframe 控制台（Rust 收到时已记一行，再走 `log` 会重复）；同一张图同一个键在桌面提示过后预览里不再提示（按「同图同键只一次」）。Web / Android 不监听。

**我做的变异**：L5a 5 条（装入后不重写绑定、没有 id 也命中、带 `sceneFlips` 的片段进缓存、`beforeFrame` 不 `drain`、无损判定恒真），4 条抓到；「带 `sceneFlips` 的片段进缓存」没抓到——它触发的是整场重载，重载时缓存随会话丢掉，所以这个条件只是省一次 `cacheCopy`，不是行为缺口，不补测试。L5b 的 6 条（reporter 两条、composable 四条）都抓到。

**复核数字**：wpe-scene 单测 204 文件 4002 条通过（含 L5a 新增约 55 条、L5b 9 条），tsc 0 错误，prettier 通过；Rust `wpe_scene` 16 通过；编译摘要 233 全同、登记表与子系统对照 0 差异（执行代理跑、我复跑了单测与变异）。`cargo check` 被正在跑的 dev 占文件没跑成，`cargo test` 编译 0 错误。

**结果（2026-11-17）**：
- **全库画面哈希**：L5 产物（`index-BOaCnIn9.js`）与 L4 基线对上的 216 张 × 3 档全部相同（含 `init` 里建层的 bars 场景）。
- **`scriptCorpus`**：236 张只有 `14294` 变，变化只在 `recompile`（`createLayer/142`、`/143` 消失），状态与控制台摘要不变。
- **真机**：`live-clone` 三个克隆 `created.sync: 3`、无重编译、K2 当帧读 0.5（同 WPE）；`p6d3b-bars` 一次编译、首帧 10 层、日志前 10 行与 WPE 逐行相同；`live-unsup` 形状对象不画（`unsupported: 1`）、K2 当帧出现、后端一条 warn、看板娘历史里有「预览里的场景壁纸运行中用到了暂不支持的特性：shape:effects…」（dev 自动重编了 Rust）。主窗口在后台时帧循环不走，要用户切前台。
- 回归条目见 `versions/latest/regression.md`「场景壁纸运行中建层走片段」。

## 交付

两个 opus 执行代理并行，在主工作区实现；文件不重叠。
- **L5a 只改**：`apps/wpe-scene/src/` 下的 `host.ts`、`changes.ts`（新）、`fragmentCache.ts`（新）、`script/api.ts`、`script/structure.ts`、`compile/bundle.ts`（只加 `exactConfigs`）、`compile/protocol.ts`、`compile/workerHandler.ts`、`compile/client.ts`、`dev/probeScripts.ts`、`dev/probe.ts`、各自测试、`ignore/live/l5/`。调 `this.options.report.unsupported?.(keys)`，接口由 L5b 定义：`unsupported?(keys: readonly string[]): void`。
- **L5b 只改**：`apps/wpe-scene/src/report.ts` 及测试、`src-tauri/kabegame/src/commands/wpe_scene.rs`、`apps/kabegame/src/composables/useSceneUnsupportedNotice.ts`（新）及测试、`apps/kabegame/src/App.vue`（只挂 composable）、`packages/kabegame-i18n/src/locales/*/gallery.json`。
- **都不碰**：`render/`、`compile/fragment.ts`、`compile/registry.ts`、文档与计划（我写）、`ignore/live/l4/`。
- **不跑**：`buildSceneHost.ts`、`hash_all.mjs`、`corpus_run.mjs`（我来）；不重启 dev。
