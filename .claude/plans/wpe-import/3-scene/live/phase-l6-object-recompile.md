# L6 — 单对象重编译（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L6」。前一块：[phase-l5-create-layer.md](phase-l5-create-layer.md)（`LiveObjects` 两条路、变更队列、`addCompiledObject(replace)`）。
> 语料（L0）：绑定触发的重编译全库只有 1 处（`3355291946` 的 `general.hdr`，场景级）；脚本触发的对象级重编译只有 `font`（`13608`、`15019`，都在 `init` 里）。所以 L6 主要是正确性，语料受益小。

## 总体设计思路

现在凡是「要重编译才生效」的写入——脚本写文本层的 `font` / `opaquebackground` / `backgroundbrightness` / `anchor` 等非运行中字段、绑属性的 `size` / `colorBlendMode` / 灯的编译期字段、`needsRecompile` 挡下的 effect 开关——都记进 `scriptOverrides`、整场重载（0.5–0.8 s，粒子重来、文本图集重建）。L6 把**对象级**的这些改成只编那一个对象：会话按「原文 + 这个对象累计的覆盖」重编它，片段到了在帧边界替换（登记表 / 状态 / 子系统 / GPU），旧对象在此期间照画。**场景级**的（`general/hdr`、没有泛光链时打开泛光）照旧整场重载。

**分级的依据是路径。** 重编译目标的 `path` 形如 `objects/<i>/…` 的就是对象级（`layer-structure` 这个 reason 全部如此；文本的 `recompile(key)`、`bundle.ts` 的 `recompile` 都按 `objects/${index}/${key}` 发），`general/…` 的是场景级。`needsRecompile` 挡下的写入：目标是 `effect` 的按 `target.object` 对象级，`bloom-enabled` 场景级。不改 `BindingTarget` 的形状（总计划点 1 写的加 `object` 字段没有必要，路径已经带着）。

**会话侧**：`compileFragment` 现在对已有下标抛「单对象重编译在 L6」。改成：请求带 `overrides`（这个对象累计的全部覆盖，路径 → 值，同 `scriptOverrides` 的形状）时，会话取开会话时留的**原文副本**（`originals[at]`，套整场 `scriptOverrides` 与删除之前的 JSON；运行中建的对象是它的配置原文），套上 `overrides`，先从会话的 `bundle.layers` / `sounds` / `lightObjects` 里摘掉这个对象的旧条目，再走和新对象完全相同的单对象管线（脚本 → 灯 → 关键帧 → 能力检查 → `compileOne(at)` → 单对象收尾），切出片段与增量。`configs[at]` 不动（`getInitialLayerConfig` 取的是加载原文，覆盖不进去）。绑定 / 脚本 / 关键帧表照旧只追加（片段按 `from` 切），旧条目留在会话里无害。

**宿主侧**：`LiveObjects` 加第二种变更 `recompile-object`。
- 入口有两处：`overrideAndReload(path, value)`（脚本写）与 `applyChanges` 里的 `plan.recompile` / `blocked`（属性）。路径对象级 → 记覆盖（照旧进 `scriptOverrides`，整场重载的兜底仍读它）→ `live.recompile(object)`；场景级 → 照旧 `requestScriptReload`。
- **合并**：同一对象标脏一次；在编时又写了，编完再编一次（最后一次胜出，覆盖是累计的）；`drain` 只装最新到达的那份。10 次连写只编 1–2 次。
- **到达后**（帧边界，同 L5 的 `drain`）：`addCompiledObject(delta, "replace")`——登记表 `replaceObject`（图层留原位、条目插回原位、灯沿用槽、粒子沿用序号）、状态 `replaceObject`（保留 `order` 位置、运行中的父、子表、冻结与待删）、`restructure`、绑定按当前属性重写、关键帧**按 id 接回时钟**（新增 `SceneAnimations.replaceObjects(objects, list)`：摘旧条目前记下各 id 的时钟与 `rate`，新条目同 id 且时钟参数相同的接上，同 `carryOver` 的规则）、puppet 重建、文本 `layoutInCurrent`（新字体）、`refreshScripts` + `replayWritesFor`（运行中写过的字段留着）→ GPU `prepareObject` → `installObject`（L4 的替换路径：旧运行时 `teardown({ replacing })`）。
- **粒子不重来**：`installObject` 替换同一对象时，新旧图层的 `particle` 定义相同（编译产物深比较）就沿用旧的粒子树（模拟状态、脚本控制都在），不同才 `createParticleTree`。重编译粒子层的典型触发是它身上别的字段（如灯 / size 绑属性），粒子定义不变。
- **不支持项 / 翻转 / 失败**：片段带 `unsupported` → 对象不装 GPU（`removeObject` 卸掉旧的，不画）、`report.unsupported`、其余照替换（已定 4）；`sceneFlips` 非空、编失败、装失败 → 整场重载。
- 重编译出的片段**不进缓存**（它带覆盖，键对不上）。
- `stats` 加 `recompiledObjects: number`；对象级不再记进 `stats.recompiled`（那是整场的）。
- 首次加载 `init` 里的写入（`13608` / `15019` 的 `font`）：和 L5 的 `init` 里建层一样走 `loadingLive`，片段到齐、接进还没换上的 bundle 再建 GPU 场景，不再二次编译；重载进行中的写入照旧记覆盖，新场景按覆盖编。
- dev 探针走同一个 `LiveObjects.recompile`；`scriptCorpus` 的 `recompile` 里对象级路径消失。

**和 WPE 的差异（已定）**：`size` 在 WPE 运行中改了无效、`colorBlendMode` 只在普通 ↔ 加法之间切，我们照 3a 已定 5 生效，记为有意不同；`font` 在 WPE 当场生效，我们晚几帧（片段异步），已知差异。判据因此是：**替换上之后那一帧，和「带同样覆盖整场加载」的同一帧逐像素相同**。

## 现状锚点

**a. 重编译目标**（`compile/bindings.ts:64`、`:313`）
```ts
export type RecompileReason = "postprocess-hdr" | "layer-structure";   // 后者：colorBlendMode、size、灯的编译期字段、文本非运行中字段
| { kind: "recompile"; reason: RecompileReason; path: string };       // path：`objects/<i>/<key>` 或 `general/hdr`
```
发出处：`compile/bundle.ts:1453` 的 `recompile(reason, path)`、`compile/texts.ts:157`（`objects/${index}/${key}`）、`script/api.ts:613`（文本 API 的 `font` / `opaquebackground` / `backgroundbrightness` / `anchor`，`objects/${object}/${key}`）、`script/api.ts:2264`（`general/hdr`）。

**b. 宿主**（`host.ts`）
```ts
private overrideAndReload(path: string, value: ScriptValue): boolean {        // :695
  if (!recordRecompileWrite(this.scriptOverrides, …, path, value)) return true;   // 值没变不动
  this.stats.recompiled.push({ reason: `script（${path}）`, keys: [] });
  this.requestScriptReload();                                                   // 现状：一律整场
  return true;
}
private applyChanges(changes): void {                                          // :493
  … const blocked = plan.writes.filter((write) => state.needsRecompile(write.binding, write.value)) …
  if (plan.recompile.length || !applied) { … this.requestScriptReload(); }     // 现状：一律整场
}
```
整场重载时 `scriptOverrides` 原样交给会话（`:1985`），会话开场按路径套进 `scene.objects`（`compile/bundle.ts:1500`）。

**c. 会话**（`compile/bundle.ts:3313`）
```ts
if (at < scene.objects.length) throw new Error("单对象重编译在 L6");   // 现状：只收新下标
```
`FragmentRequest.overrides` 已有字段（L1 只透传、不用）。

**d. 替换的三方**：`SceneRegistry.replaceObject`（L3a）、`SceneState.replaceObject`（L3a）、`addCompiledObject(mode: "replace")`（L3b / L5：关键帧 `removeObjects` + `add`，时钟从 0 起）、`GpuScene.installObject` 替换（L4：`teardown({ replacing: true })`，粒子树重建后 `adoptScriptControl` 只接暂停 / 停止，模拟状态丢）。

## 点 1 — 会话：重编已有对象（`compile/bundle.ts`、`compile/fragment.ts`）
- **新增** 开会话时留每个对象的原文副本 `originals[at]`（深拷，套 `scriptOverrides` 与删除之前；`compileFragment` 新建对象时同样记下）。
- **修改** `compileFragment`：`at < scene.objects.length` 且 `request.overrides !== undefined` 时走重编：
  1. `objects[at] = 套了 overrides 的 originals[at] 深拷`（套法同开场的 `scriptOverrides`，相对路径去掉 `objects/<at>/` 前缀）；父 / 骨骼照请求；
  2. 从会话的 `bundle.layers`、`sounds`、`lightObjects` 摘掉 `object === at` 的旧条目；
  3. 之后同新对象。
  - `at < scene.objects.length` 而没有 `overrides` 仍抛错。
- **修改** `FragmentRequest.overrides` 的注释：路径相对对象（`<key>` 或 `effects/0/…`），不带 `objects/<i>/` 前缀。

## 点 2 — 变更队列与 `LiveObjects.recompile`（`changes.ts`、`script/createLayerChange.ts`）
- **新增** `SceneChange` 加 `{ kind: "recompile-object"; object: number; overrides: Record<string, …> }`。`LiveObjects.recompile(object, overrides)`：
  - 对象在编中 → 标脏，到达后用最新的覆盖再发一次；否则排队、当场向会话要片段；
  - 到达：`applyDelta` 进登记表、预热（同 `create`）；`drain` 时对象已删 → 丢弃；标脏的 → 丢弃这份、再发；否则 `land(delta, replace)`。
  - `land` 的替换形态：`adopt` → 不支持项（卸 GPU + 上报）→ GPU `prepareSync` + `install`（同 L5），不进缓存。
- `LiveTarget` 加 `removeGpu(object)`（不支持项时卸掉旧运行时）。

## 点 3 — 宿主分级（`host.ts`）
- **修改** `overrideAndReload(path, value)`：值变了之后，`objects/<i>/` 前缀 → 记覆盖 + `live.recompile(i, 该对象的全部覆盖)`，`stats.recompiledObjects++`；否则照旧整场。`live` 不在（没有会话）照旧整场。
- **修改** `applyChanges`：`plan.recompile` 与 `blocked` 按路径分两堆；对象级那堆每个对象 `live.recompile`（属性值会话自己按 `request.properties` 取，不进覆盖；`blocked` 的 effect 开关进覆盖，路径同 `targetPath`）；场景级那堆或 `!applied` 照旧整场。
- **修改** `addCompiledObject(replace)`：关键帧改调 `SceneAnimations.replaceObjects`（点 4）。
- `init` 期间的对象级写入走 `loadingLive.recompile`，收尾同 L5（`settled` → `drain` → 建 GPU 场景）。

## 点 4 — 关键帧时钟接回（`animation/player.ts`）
- **新增** `replaceObjects(objects: ReadonlySet<number>, list: readonly SceneAnimation[])`：先按 id 记下要摘的条目的 `clock.t` / `flags` / `rate` 与各通道（同 `carryOver` 的匹配规则：id 相同且 `sameClock`、`sameKeys`），`removeObjects` 后 `add(list)`，新条目接上记下的。

## 点 5 — GPU 替换沿用粒子树（`render/scene.ts`）
- **修改** `installCore` 替换路径：`previous.layer.particle` 与新图层的 `particle` 深比较相同（`JSON.stringify` 稳定键序即可，编译产物是纯数据）时，`buildLayer` 用旧树（不 `createParticleTree`、不预热），draw 重建；不同才重建并 `adoptScriptControl`。

## 点 6 — dev 探针（`dev/probeScripts.ts`）
- **修改** 脚本写重编译目标：对象级走探针的 `LiveObjects.recompile`（探针的 `liveTarget` 已有），不再记进 `recompile`；场景级照旧记。

## 验收
- **会话对照**（`ignore/live/l6/recompile.test.ts`，跑法同 L3）：全语料每张场景整场编完后，对每个对象（最多前 20 个）`compileFragment({ object: i, overrides: {} })`，片段与 `fragmentOf(整场, i)` 逐字段相同（`unsupported` 不比）；另对 `13608`、`15019` 用它们脚本写的 `font` 值做覆盖，片段与「带同样 `scriptOverrides` 整场编」的 `fragmentOf` 相同。判据 0 不同。
- **编译摘要**与基线全同（`originals` 不进 bundle）；L3 登记表、L3b 子系统对照不变。
- **`scriptCorpus`**：只有 `13608`、`15019` 变——`recompile` 里的 `objects/<i>/font` 消失、`stateDigest` 变（字体真的换了，`textFields.font` 是脚本写的值），其余 234 张不变。
- **全库画面哈希**不跑（加载路径没动）；改了 `render/scene.ts` 的替换路径，只有运行中替换才走到。
- **单测**：
  - 会话：已有下标无 `overrides` 仍抛；有 `overrides` 时旧条目摘掉、新片段的 `layer.object` 是它、`configs[at]` 不变、`overrides` 相对路径套到对象与 effect 常量上；
  - `LiveObjects.recompile`：同一对象连写 10 次只编 1–2 次（在编时再写 → 到达后再编一次）、最后一次胜出；到达前已删丢弃；不支持项卸 GPU + 上报；`sceneFlips` → 重载；不进缓存；
  - 宿主：`overrideAndReload` 对象级 / 场景级分流、`applyChanges` 的 `blocked` 分流、`init` 期间的写入不二次编译；
  - `replaceObjects` 接回时钟（同 id 续播、不同 id 从 0）；
  - `installObject` 替换：粒子定义相同沿用旧树（粒子数与年龄连续）、不同重建；
  - 替换保留运行中写过的字段（`replayWritesFor`）与 `order` 位置。
- **变异**：替换丢了运行中的写入；不合并（每次写都编）；场景级误走对象级（`general/hdr` 不重载）；时钟不接回；粒子树定义相同也重建；会话重编不摘旧图层（`find` 找到旧的）。
- **真机**（我做）：生成工程 `live-font`（文本层 T 的脚本第 60 帧写 `thisLayer.font` 换字体，旁边粒子 P 一直发射）：字体换了、只有一次「开始渲染」、P 的粒子不重来（`host.particles()` 的数量与年龄连续）；`scriptCorpus` 里 `13608` 的字体效果在预览里看一眼。

## 验收中的补充（2026-11-17）

**实现与本计划不同的几处**（复核后接受）：
- `scriptCorpus` 的预期写错了：它用一次性的 `compileSceneInWorker`、不给探针 `live`，没有会话可以重编，对象级写入仍记进它的 `recompile`（探针做不了的写入）。所以 `13608` / `15019` 的 `objects/<i>/font` 不会消失、`stateDigest` 不变，判据改成全库 236 张不变（主计划 L6 验收里本来就是「`scriptCorpus` 不变」）。探针走单对象重编译的是 `probe.ts`（`renderFrame`），由 `probe.scripts.test.ts` 的 4 条用例覆盖。
- `recompile(object, overrides, placement, config = "")` 比计划多两个入参：`placement` 带运行中的父与挂点骨骼（`placementBone`），`config` 是运行中建的对象的配置原文——L5 命中缓存当场接进场景的对象会话从没见过，没有它取不到原文。
- 原文按需取：第一次重编时才重新解析场景原文，之后逐个深拷，不在开会话时深拷全部对象；运行中建的对象记配置原文文本（`createdTexts`）。
- `blocked` 的 effect 开关不进覆盖：会话按请求里的属性全集取值，和整场重载同一来源。
- 几种情况保守走整场：被依赖的图层（GPU 替换会放掉独占 RT，引用方的 draw 不重绑，L5 定的）；带体积光的灯（片段一律带 `volumetrics` 翻转，语料 5 个对象）；整场重载进行中新场景还没换上的写入（`switchPending`，写入可能晚于那次编译取覆盖表的时刻），换上之后起（含换上时画的第一帧里脚本的写入）交给新场景。
- 实测发现的过期问题，计划外加的保护：在编期间属性就地写了这个对象的绑定，也算一次合并，到达后按当前属性再发；片段换上时 `rebindFragment` 有被挡下的绑定就再编一次（顺带修了 L5 排队建层的同类问题）；替换文本层时旧排版先留在状态里（旧运行时每帧读 `state.texts`，否则可能触发 `render:frame` 退回），新排版设进来时放掉；`sessionUseful` 也为「绑属性的 effect 在文本层上或自己带不支持项」留会话。
- `stats.recompiledObjects` 计合并之前的次数；合并之后真正向会话要片段的次数是 `LiveObjects.recompileRequests`。
- 原先拿 `objects/0/colorBlendMode` 当「触发整场重编译」开关的用例改用场景级的 `general/perspectiveoverridefov`；断言冻结图层 / 带不支持项的 effect / font 会整场重编译的用例改成断言走单对象重编译。

**我做的变异**（5 条，全部抓到，按原字节还原）：重编时覆盖套到场景根而不是对象原文（`fragment.test` 2 条）；原文取会话里已套过覆盖的对象（「每次从原文起套」）；对象级时挡下的写入也照写（`host.l6` 与 `host.script` 3 条）；整场重载开始时不标 `switchPending`；`init` 之后只排一轮队列。执行代理的 6 条（替换丢写入、不合并、场景级误走对象级、时钟不接回、粒子树相同也重建、会话重编不摘旧图层）也全部抓到。

**复核数字**：会话对照我重跑一遍，233 张 2572 个对象 0 不同（26 个带 `fragmentBlocker` 的用 `objectSlice` 比，0 不同），`font` 覆盖 23 个对象 0 不同，编译摘要 233 张与 L0 基线同哈希，`sceneFlips` 只有 5 个 `volumetrics`；登记表 / 子系统对照（执行代理跑）全 0；L6 相关 11 个测试文件 281 条通过，tsc 0 错误，prettier 通过。

**结果（2026-11-17）**：
- **`scriptCorpus`**：L6 产物（`index-Bx6kSMJU.js`）236 张与 L5 结果 236/236 相同（见上，判据改成不变）。
- **真机 `live-font`**：一次「开始渲染」；`stats.recompiledObjects: 1`、`recompiled: []`；第 61 帧起 `thisLayer.font` 读回 `systemfont_comicsans`，截图字形是 Comic Sans；粒子 P `alive 301 = highWater 301`、粒子条连续；帧时间 0.32 ms。
- **真机 15019**（`init` 里 5 处 `font`）：一次「开始渲染」（66 层，1760 ms），`recompiledObjects: 5`、`recompiled: []`，时钟文字照常。13608 因 `script:api:layer.getTextureAnimation` 本就退回预览图。
- 回归条目见 `versions/latest/regression.md`「场景壁纸运行中单对象重编译」；T4（属性面板改对象级设置）、T5（重载进行中的写入）只有单测，留给用户勾。
- 留给以后：探针 `prewarmFragments` 仍未接进 MCP；改组归属的删除与结构变化的重编译（L7）。

## 交付

opus 执行代理在主工作区实现。
- **只改**：`apps/wpe-scene/src/` 下的 `compile/bundle.ts`（`originals` 与 `compileFragment` 的重编分支）、`compile/fragment.ts`（只改注释 / 类型）、`changes.ts`、`script/createLayerChange.ts`、`host.ts`、`animation/player.ts`、`render/scene.ts`（只 `installCore` 的粒子树沿用）、`dev/probeScripts.ts`、各自测试、`ignore/live/l6/`。
- **不碰**：`compile/registry.ts`、`render/state.ts`、`report.ts`、文档与计划。
- **不跑**：`buildSceneHost.ts`、`hash_all.mjs`、`corpus_run.mjs`；不重启 dev；不做 git 写操作。
