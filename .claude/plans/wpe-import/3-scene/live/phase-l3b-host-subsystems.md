# L3b — 宿主子系统按对象增删（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L3」。前一块：[phase-l3a-registry-state.md](phase-l3a-registry-state.md)（登记表、状态逐对象增删、组与挂点重算）。
> 依据：P6d4 盘点 `ignore/p6/d4/inventory.md` §5（运行时消费者）、§6（新建对象上的脚本）。L0 的 WPE 实测：`ignore/live/l0/wpe-results.md`。

## 总体设计思路

L3a 让登记表（bundle）与状态能逐个对象增删。宿主手里还有几样按整场 bundle 一次建好的运行时：
- 关键帧播放器 `SceneAnimations`；
- puppet 运行时 `ScenePuppets`；
- 文本排版 `SceneTexts`；
- 脚本运行时 `ScriptRuntime` 与脚本 API `ScriptApi`；
- 声音、用户纹理来源、媒体 / 音频订阅。

L3b 给它们各加按对象增删的入口，再由宿主的一个函数按固定顺序调一遍：

- **`SceneHost.addCompiledObject(delta, mode)`**（`mode`：`"add"` 新对象，或 `"replace"` 替换已有对象），按顺序：
  1. 登记表 → 状态 → 组与挂点重算（`registry.restructure(state, bones)`，骨骼名取配置原文的 `attachment`、`override` 取 `structure.parents` 是否带这个对象；返回的组内问题非空时按 L7 前的约定当不支持项处理）→ 关键帧 → puppet → 文本 → 脚本（换成定型后的条目，再重放这个对象建出以来的脚本写入）→ 脚本 API 收待编对象 → 声音 → 用户纹理来源 → 媒体 / 音频订阅；
  2. GPU 一步留给 L4，本步是空钩子。
- **`SceneHost.removeObjectEverywhere(objects)`**：删除生效（`flushDestroy`）之后，按相反顺序从同一批地方摘掉。

本步只提供这两个函数和各子系统的入口，**不接进 `createLayer`**（L5 接）。产品行为不变，只有一处例外：删除生效之后，各子系统顺带清掉被删对象的残留。这只少占内存，不改画面。

**几条要对齐 WPE 的规则**（L0 实测）：
- **关键帧**：新对象的关键帧时钟从 0 起，建出那一帧不求值，读到的是静态 `value`。状态 `addObject` 写的就是编译值，也就是 `value`；下一帧 `frame(dt)` 先推进再求值，自然对上。
- **属性绑定**：新对象保留属性绑定。绑定进了 `bundle.bindings`，宿主 `applyChanges` 现读，自动对上。
- **光标**：新对象收光标事件。光标的可拾取表现读 `bundle.layers` 与 `state.layers`，L3a 之后自动对上。

**判据是「逐个加等于整场一次」，和 L3a 一样。** 关键帧与 puppet 都是纯 TS，能在 Node 里跑全语料：
1. 用整场列表一次构造一个；
2. 从空开始，逐个对象 `add` 出另一个；
3. 两者跑同样的 120 帧（固定 dt、同一个假的写入目标），每帧写出的值逐位相同。

删除用「全加再逐个删，和只加剩下那些」比。文本排版要 wasm 与字体，只在单测（桩）和 L5 的真机里验。

## 现状锚点

**a. 关键帧**（`animation/player.ts`）
```ts
export class SceneAnimations {
  private readonly tracks: Track[];                 // 现状：按构造时的列表下标，owner（联动主人）也是下标
  private readonly byId = new Map<string, number>();
  private readonly controls = new Map<number, AnimationControl>();   // 现状：按下标缓存控制对象
  constructor(list: readonly SceneAnimation[]) { … }                 // 现状：只有整场构造，没有追加 / 删除
  carryOver(previous: SceneAnimations | null): void;                 // 重编译时按 id 接回时钟
}
```

**b. puppet**（`puppet/player.ts`）
```ts
export class ScenePuppets {
  private readonly runtimes: PuppetRuntime[] = [];
  private readonly byObject = new Map<number, PuppetRuntime>();
  constructor(list: readonly { object; puppet: PuppetRig; kind? }[]) { … 每项建 PuppetRuntime、evaluate 一次 … }   // 现状：只有整场
}
```

**c. 文本**（`text/host.ts`）：`prepare(bundle, sources, cancelled)` 排全部文本层到一套新图集，记成当前加载；`relayouter()` 在当前加载的图集里重排单层。现状没有「在当前加载里排一个新层」的入口。

**d. 脚本**（`script/runtime.ts`、`script/api.ts`）：
- `addScripts(list)`：`createLayer` 时同步加未定型的条目，常量目标没补 uniform，也没有 `script-property` 绑定；
- `refreshScripts(list)`：按 id 换条目；
- `replayWrites()`：重放全部写入；
- `destroyObjects(objects)`：按对象清；
- `ScriptApi.adoptBundle()`：在 bundle 里找得到的待编对象从 `pending` 删掉。

**e. 声音**（`audio/sceneSounds.ts`）：`load(sounds)` 按对象做差，已有的保留、新的建排期器、不在表里的停掉。

## 点 1 — 关键帧（`animation/player.ts`）

- **新增**
```ts
/** 追加一个对象的关键帧（L3b）：`list` 的 `parent` 是 list 内下标（片段的形状）。时钟从 0 起，建出的这一帧不求值（`frame` 下一次调时先推进再求值，L0 实测）。 */
add(list: readonly SceneAnimation[]): void;
/** 删掉属于这些对象的全部条目（`def.object`）；之后它们的 `control(id)` 返回 null，已给出的控制对象作废（方法空操作，读值返回静态值）。 */
removeObjects(objects: ReadonlySet<number>): void;
```
- **修改** 内部按下标的引用改成按条目对象：
  - `owner` 记主人条目，不记下标；
  - `controls` 按 id 缓存。
  - 增删之后不用重排下标。
  - `frame` 的遍历顺序 = 条目登记顺序，追加的排在尾，同整场重编译时新对象排在最后。
- **构造** = 从空 `add(整场列表)`。`carryOver` 不变（按 id）。

## 点 2 — puppet（`puppet/player.ts`）

- **新增** `add(list)`：同构造里的单项，把建 `PuppetRuntime` 抽成函数，构造与 `add` 共用；建好按 t = 0 算一次姿势。
- **新增** `remove(objects)`：从 `runtimes`、`byObject` 摘掉。
- **对齐**：`puppetEntries(layers)` 现在按整场 layers 取 skinned 的，增加按单个图层取的版本（同一规则）。

## 点 3 — 文本（`text/host.ts`）

- **新增** `layoutInCurrent(layer: SceneLayer): Promise<TextLayout | null>`：在当前加载的图集里排这一层。
  - 读字体同 `prepare`，按加载代数，过期返回 null。
  - 排不出抛 `SceneRenderError(["text:engine"])`，同 `prepare`。
  - 新对象的文本走它，结果交状态 `setText`（GPU 在 L4）。
- **新增** `releaseLayout(layout)`：放回图集引用（`text/layout.ts` 已有 retain / release 的就用现成的）。删除对象时调。
- L5 缓存命中的同步路径要复用模板的排版：缓存里存一份 retain 过的 `TextLayout`，本步只提供 `retainLayout`。

## 点 4 — 脚本（`script/runtime.ts`、`script/api.ts`）

- **新增** `ScriptRuntime.replayWritesFor(objects: ReadonlySet<number>)`：只重放目标在这些对象上的写入（键 `objects/<i>/` 前缀），顺序同 `replayWrites`。
- **修改** 无。
  - 片段到达后，宿主用 `refreshScripts(fragment.scripts)` 换成定型后的条目；
  - `script-property` 绑定已进 `bundle.bindings`，`applyUserProperties` 现读；
  - 再调 `ScriptApi.adoptBundle()`。

## 点 5 — 声音、用户纹理、媒体 / 音频

- **声音**：`SceneSounds.load(bundle.sounds)` 本来就按对象做差，增删后照调。
- **用户纹理**：宿主的预解码 `primeUserTextures` 改成也能按来源列表调，增量里的新来源走它。
- **媒体 / 音频**：片段 `media` / `audio` 为真、而当前还没订阅时，补订阅；用现有的 `loadMedia` 与音频订阅入口，按「没订阅才订」。

## 点 6 — 宿主的两个函数（`host.ts`）

```ts
/**
 * 把一个编好的对象接进当前场景（L3b）。mode "add"：新对象；"replace"：替换已有对象（L5 没命中缓存时由壳换成编好的、L6 单对象重编译）。
 * 顺序：登记表 → 状态 → restructure → 关键帧 → puppet → 文本 → 脚本（refreshScripts + replayWritesFor）→ ScriptApi.adoptBundle → 声音 → 用户纹理 → 媒体 / 音频 → GPU（L4 前空钩子）。
 * 返回要等的异步部分（文本排版、用户纹理解码），宿主在下一帧开头前等它（L5 定时机）。
 */
private addCompiledObject(delta: FragmentDelta | { fragment: ObjectFragment }, mode: "add" | "replace"): Promise<void>;
/** 删除生效之后（`flushDestroy` 返回的对象）：登记表、状态（dropObject）、关键帧、puppet、文本、声音按对象摘掉，最后 `restructure` 一次（被删对象的子对象已成根，组与挂点要重算）。脚本已由 `runtime.destroyObjects` 清。 */
private removeObjectEverywhere(objects: readonly number[]): void;
```
- **修改** 现有删除生效的地方（宿主调 `flushDestroy` 之后）接上 `removeObjectEverywhere`。只清残留，不改画面。GPU 的 `releaseRemoved` 照旧由渲染器按状态做。

## 验收

- **全语料对照**（`ignore/live/l3b/subsystems.test.ts`，跑法同 L3a）：每张场景整场编完。
  - **关键帧**：整场构造 vs 逐对象 `add`，120 帧（dt 1/60）每帧写出的值逐位相同。关键帧事件的派发序列也比。
  - **puppet**：整场构造 vs 逐对象 `add`，120 帧蒙皮矩阵、骨骼透明度、变形权重逐位相同。
  - **删除**：全加再按固定种子随机删一半，与只加剩下那些的跑 120 帧比。
  - 判据：全部为 0 差异。
- **单测**：
  - `SceneAnimations`：
    - 联动主人跨增删；
    - 删除后控制对象作废；
    - 新加的条目建出那帧不写、下一帧写 `dt` 处的值（对照 L0 的 K2：f=90 读 0.5，f=91 读 dt/2）。
  - `ScenePuppets.add` / `remove`。
  - `SceneTexts.layoutInCurrent`：桩掉字体与 wasm，验代数过期返回 null、排进当前图集。
  - `replayWritesFor` 只重放该对象的写入。
  - 宿主两个函数的调用顺序（桩掉各子系统）。
  - 删除后各子系统残留清零（建删 100 次）。
- 相关测试照过（`animation/`、`puppet/`、`text/`、`script/`、`host.test.ts`），wpe-scene `tsc` 0 错误，prettier。
- **变异**：
  - `add` 里联动主人仍按下标；
  - `removeObjects` 漏删控制对象缓存；
  - puppet `add` 不算 t = 0 姿势；
  - `replayWritesFor` 重放了全部；
  - 删除后不调 `removeObjectEverywhere`。
- **真机**：本步宿主只多了删除后的清理。用 `scriptCorpus` 全库前后比，除了内存，脚本行为与状态摘要不变。基线按当时的代码先取一遍，因为 L0 的基线在合并之后已不对应。

## 验收中的补充（2026-11-17）

**删除路径只接了一半。**
- `removeObjectEverywhere(objects, { structural })` 多了一个选项。
  - 缺省为真，即本计划写的完整形态，有单测验调用顺序。
  - 删除生效处（`onDestroyed`）实际接的是 `structural: false`：声音、文本排版引用、puppet、关键帧、状态 `dropObject`。登记表 `removeObject` 和 `restructure` 不接。
- 不接的原因，渲染侧与脚本 API 还按整场 bundle 现读：
  - **组字段**：`render/structure.ts` 按 `layer.group == null` 选顶层，`groupOf` / `groupDepth` 找组的 RT。删组之后 `restructure` 把子层的 `group` 改成 null，子层会被当成顶层画，而它们的 op 指向已释放的组合成 RT。
  - **新 id**：`ScriptApi.newLayerId` 取 `bundle.layers` 最大 id 加 1，摘掉最大 id 的层会让这个 id 再发一次（WPE 的 id 不回收）。`findLayer` / `getLayerByID` 也按 `bundle.layers` 找。
  - 这两件挪到 L4（总计划 L4 点 3）。
- 接上的那一半是安全的，有两条依据：
  - `flushDestroy` 本来就删了 `state.layers` 的项；
  - 渲染侧在同一帧下一次 `sync` 开头的 `releaseRemoved`，先于任何按对象的读取。

  复核时另外核过两类访问：
  - **读取**：各表都带空值保护；
  - **写入**：常量、effect、粒子实例、灯、声音、相机、动画层、文本字段、材质状态，缺项时一律返回 applied、不做事。删除后改属性不会抛错。
- **唯一的行为差别**：被删对象上的 effect 开关绑了属性时，原来改这个属性会多触发一次整场重编译，现在不会，因为 effect 开关表清掉了。画面不变。

**文本**：加载时没有文本层的场景，运行中新建文本层时，`layoutInCurrent` 为当前代数开一套新图集（`preparing` 标志区分「`prepare` 正在跑」）。这条路径只有桩单测，真字体与 wasm 留到 L5 真机验。

**组内问题**：`addCompiledObject` 里 `restructure` 返回的组内问题，先并进 `bundle.unsupported` 并 warn。L5 / L7 再定最终做法。

**覆盖缺口**：语料里关键帧事件实际派发数为 0（有事件定义的动画只有 1 张场景，长跑也没触发）。事件派发序列的对照只有单测在管。

**复核时补的两条测试**：
- `animation/playerAdd.test.ts`：暂停中被摘掉的条目，作废的控制对象 `play()` 也不播。原用例调 `play` 时时钟本来就在播，变异「不拦 play」抓不到。
- `render/p6d3.test.ts`：假设备 `GpuScene` 上，删除生效后再 `dropObject`，同帧先 update / encode 再 sync 不崩，释放与其余图层照常；删后写它的常量返回 applied。这条代替真机：语料里三张会删层的场景跑 120 帧都不删层；探针跑脚本也不经宿主的 `onDestroyed`；屏外宿主不真正加载场景；主窗口预览被占用时不能接管。

**真机**：`scriptCorpus` 在当前代码上重取基线，两遍 236 张逐张相同，没有排除项（`ignore/live/l3b/corpus-base-1`、`-2`）。L3b 产物（`index-C_MyNBdA.js`）跑完与基线 236/236 相同。

**真机删层**（提交后补做）：
- 做法：测试工程 `ignore/p6/d3/proj/p6d3-struct` 在主窗口预览里实时跑 90 多秒，带 dev 强制渲染，因为工程里的 `kbcustom` 是给 WPE 对照用的标记。
- 覆盖：它依次删了组里的子层、组、相机对象、灯。
- 结果：
  - 最终剩下的 6 个对象与 P6d3 记下的 WPE 日志（`ignore/p6/d3/out/wpe-struct.log` 的 `s7+1`）相同；
  - 删组两次触发整场重编译，是原有行为；
  - 帧时间均值 0.45 ms，脚本没有报错，应用日志没有异常；
  - 画面上组被删后子层成了根图层，照常画。
- 注意：宿主转发脚本 `console.error` 每段脚本每分钟最多 10 条，这个工程第 3 阶段起的日志被限流省掉了，所以按最终状态核对，没有逐行比日志。

## 交付

sonnet 执行代理在主工作区实现。
- **只改**：
  - `animation/player.ts`；
  - `puppet/player.ts`；
  - `text/host.ts`（`text/layout.ts` 如需导出）；
  - `script/runtime.ts`；
  - `audio/sceneSounds.ts`（如需）；
  - `host.ts`；
  - 各自的测试；
  - `ignore/live/l3b/`。
- **不碰**：`render/` 下有别人未提交改动的文件。L3a 之后状态的接口以 L3a 交付为准。
