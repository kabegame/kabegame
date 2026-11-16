# L3a — 登记表、状态的逐对象增删、组与挂点的运行时重算（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L3」。L3 拆成两块：
> - L3a：纯逻辑，Node 里能跑全语料对照，本文；
> - L3b：宿主子系统，关键帧 / puppet / 文本 / 脚本 / 声音按对象增删，另写子计划。
>
> 依据：P6d4 盘点 `ignore/p6/d4/inventory.md` §2（bundle 级表）、§3（`SceneState`）、§5（消费者）、§7.1–7.4（父、组、子、挂点）。

## 总体设计思路

整场加载时，「bundle → 状态」是一次性的：`SceneState.fromBundle(bundle)` 遍历全部图层建状态，组、子树、挂点在编译收尾（`finalize`）里定死。L3a 把这条路换成逐对象的、可以运行中重复走的路，加载与运行中走同一套代码。

**登记表**（`compile/registry.ts` 的 `SceneRegistry`）包住宿主手里那份活的 bundle，是运行中增删对象的唯一入口：
- `applyDelta`：只增的场景级表（程序、纹理、用户纹理来源、场景级绑定、资源路径）；
- `addObject(fragment)`：一个对象的全部条目（图层、绑定、脚本、关键帧、声音、灯、配置原文）；
- `removeObject(object)`：删掉它们；
- `replaceObject(fragment)`：换成新编的同一对象，L5 没命中缓存时与 L6 用。

消费者照旧读 `bundle.layers` 等数组，因为登记表改的就是这几个数组本身，「现读」的消费者自动接上（盘点 §5）。

关键帧表的 `parent` 是数组下标：增删时由登记表重排下标，不让消费者自己处理。灯的 `legacySlot` 由登记表分配，规则同 `compileLightObjects`：取第一个没被占的槽，满了取 0。

**状态**（`render/state.ts`）：`fromBundle` 拆成场景级构造加逐个 `addObject(slice)`，`slice` 就是片段里和状态有关的部分（图层、声音、灯）。另加两个方法：
- `dropObject(object)`：清掉这个对象的全部按对象的表，补上 `flushDestroy` 之后残留的常量、effect 开关等；
- `replaceObject(slice)`：留着对象表的位置、父与子表，其余按新的重建，之后由宿主重放这个对象的脚本写入（L3b）。

**组与挂点的运行时重算**（`SceneRegistry.restructure(state, bones)`）：
- 先把登记表里每个图层的 `parent` 同步成状态里运行中的父；
- 再按状态的子表调现成的 `assignGroups`，写回各图层的 `group` / `subtree`；
- 按当前的父与骨骼名调 `resolveAttachment` 写 `attachment`；
- 再按编译收尾的规则给组内图层的 effect 标 `GROUP_CHILD_FRAMEBUFFER`，算出 `groupChildIssues`（只返回，由调用方处理，L7）。

这样 L4 读 `layer.group` / `subtree` / `attachment` 的代码一行不改。反射名单、相机图层、粒子序号同理，由登记表现算现给。

**判据是「从空开始逐个加」等于「整场一次」。** 全语料每张场景做三件事：
1. 从整场 bundle 里只取场景级部分，得到一个空登记表；
2. 按 `objects` 顺序把每个对象的切片 `addObject` 进去，`restructure` 一次；
3. 登记表里的 bundle 与整场 bundle 逐字段相同，`fromBundle(空)` 加逐个 `addObject` 的状态与 `fromBundle(整场)` 相同。

删除用「全加再按随机顺序逐个删，每删一个就和只编剩下那些的结果比」来验。

## 现状锚点

**a. `fromBundle`**（`render/state.ts` `SceneState.fromBundle`，约 460–580 行）：一个循环里对每个图层写 `layers`（`layerStateOf`）、`constants`（基础 pass、粒子含子系统与多 renderer、网格与阴影变体、effect 绘制 pass、texchan、passthrough、groupUpload、文本四个 pass 与背景键）、`shadowPasses`、`effects`、`particleInstances`（`rate` 钳 0.01）、子表，再循环写 `order`、`alignmentSizes`、`sounds`、`lights`、`cameras`、`animationLayers`、`textObjects` / `textFields` / 冻结。

**b. `addLayer` / `flushDestroy`**：`addLayer` 只写 `layers` / `alignmentSizes` / `order` / 子表（P6d3b 的待编对象用）；`flushDestroy` 只摘 `order` / `layers` / 子表，**不清** `constants`、`effects`、`particleInstances` 等。建删循环的场景里它们只增不减。

**c. 收尾里的位置相关部分**（`compile/bundle.ts` `finalize`）：`resolveAttachment`（挂点）、`childLists` + `assignGroups`（子表、组、子树）、组内 `groupChildIssues` 与 `GROUP_CHILD_FRAMEBUFFER`、`reflectionList`（反射名单）。

**d. 加载时派生、之后固定的表**（盘点 §4.1、§5）：`GpuScene` 构造时的 `particleOrdinals` / `layerByObject` / `reflectionList`，`SceneRenderer.load` 的 `cameraLayers = cameraObjectLayers(bundle)`。L3a 只提供算法与登记表上的现算接口，消费者换过来在 L4。

## 点 1 — 片段的切片（`compile/fragment.ts`）

- **新增** `objectSlice(bundle, object): ObjectFragment | null`：`fragmentOf` 去掉 blocker 检查的那部分（取各表、清位置字段），对象不在 `bundle.layers` 时返回 null。
- **修改** `fragmentOf` = `fragmentBlocker` 检查 + `objectSlice`，行为不变。

## 点 2 — 登记表（`compile/registry.ts` 新增）

```ts
/** 宿主手里那份活的 bundle 的增删入口（L3a）。改的就是 bundle 自己的数组，现读的消费者自动接上。 */
export class SceneRegistry {
  constructor(readonly bundle: SceneBundle);
  /** 整场 bundle 去掉全部对象条目（图层、对象级绑定、脚本、关键帧、声音、灯）后的空登记表；对照测试与 L4 的 `populate` 用 */
  static emptyOf(bundle: SceneBundle): SceneRegistry;
  /** 场景级只增表：`from` 必须等于当前长度，否则抛错（增量错位说明会话与主线程不同步） */
  applyDelta(delta: Omit<FragmentDelta, "fragment">): void;
  /** 加一个对象，追加在各表尾。灯的 `legacySlot` 按规则分配；关键帧 `parent` 从片段内下标换成表内下标；`configs[object]` 写入；对象已在时抛错 */
  addObject(fragment: ObjectFragment): void;
  /** 删掉一个对象的全部条目（`configs` 保留：已删对象的 `getInitialLayerConfig` 由 API 层拦）；关键帧表重排下标；不在时返回 false */
  removeObject(object: number): boolean;
  /** 换成新编的同一对象：先 removeObject 再 addObject，图层留在原位置（`bundle.layers` 的下标不变），其余表追加 */
  replaceObject(fragment: ObjectFragment): void;
  /** 反射名单（`fragment.reflected` 的对象，按 `objects` 顺序）；场景没开平面反射时 null */
  reflectionList(): readonly number[] | null;
  /** 粒子序号：对象 → 第几个粒子图层（按加进来的先后，删掉的不回收），`createParticleTree` 定种子用 */
  particleOrdinal(object: number): number;
  /** 相机图层（同 `cameraObjectLayers`，现算并按版本缓存） */
  cameraLayers(): SceneLayer[];
  /** 增删改一次加一 */
  readonly version: number;
  /**
   * 组与挂点的运行时重算：图层 `parent` 同步成 state 的；`assignGroups(layers, state 的子表)`；`attachment` 按 `bones(object)`
   * （当前骨骼名，`override` 为真时允许父排在后面，同 `structure.parents`）重算；组内图层的 effect 标 `GROUP_CHILD_FRAMEBUFFER`、
   * 不在组里的去掉。返回组内用法的不支持项（对象 → 键，`groupChildIssues`），由调用方处理。
   */
  restructure(
    state: Pick<SceneState, "layers" | "childrenOf">,
    bones: (object: number) => { name: string | null; override: boolean },
  ): Map<number, string[]>;
}
```

- 编译收尾里的组 / 挂点 / 标记三段，改成调和 `restructure` 共用的纯函数（`compile/structureRules.ts` 新增，或放在 `bundle.ts` 导出），不复制代码。整场产物逐字节不变。
- 反射名单的分配规则同编译：只在 `bundle.reflection?.enabled` 时有名单，名单按 `objects` 顺序、去掉读反射图的模型。片段的 `reflected` 已按这条算好，登记表只是按顺序收集。

## 点 3 — 状态的逐对象增删（`render/state.ts`）

- **修改** `fromBundle(bundle)` = 场景级构造（`bloom`、`general`、相机基准、子表初值）+ 对每个图层 `addObject(sliceOf(bundle, layer), { childrenFromBundle })`。
  - 子表：有 `bundle.children` 时照旧用它，此时 `addObject` 不追加子表；手写 bundle 没有时，由 `addObject` 按父追加。
  - 结果逐字段与改前相同。
- **新增**
```ts
/** 状态需要的对象切片：图层、声音、灯（片段的子集）。 */
export interface ObjectStateSlice { layer: SceneLayer; sound?: SceneSound; light?: SceneLightObject }
/** 加一个对象的全部按对象的表（同 fromBundle 循环体），追加到 order 尾与父的子表尾，structureVersion 加一 */
addObject(slice: ObjectStateSlice): void;
/** 清掉一个对象的全部按对象的表（不动 order / 子表：结构由 flushDestroy 管；不在 order 里时同时确保不在任何子表里） */
dropObject(object: number): void;
/** 换成新编的同一对象：order 位置、parent、子表、冻结以外的运行中结构不动，其余表按新切片重建；之后由宿主重放这个对象的脚本写入 */
replaceObject(slice: ObjectStateSlice): void;
```
- **修改** `flushDestroy` 返回之后，调用方（宿主，L3b）对删掉的对象调 `dropObject`。本步只提供方法，加上单测。

## 点 4 — 全语料对照（`ignore/live/l3/registry.test.ts`，跑法同 `ignore/live/l1/fragments.test.ts`）

每张场景整场编完（`compileScene` exhaustive、postprocess ultra，摘要必须等于 L0 基线），然后：

1. **逐个加**：`SceneRegistry.emptyOf(bundle)`。按 `bundle.layers` 的顺序对每个对象 `addObject(objectSlice(bundle, i))`；状态从 `fromBundle(空)` 起逐个 `addObject`；最后 `restructure(state, 按配置的骨骼名)`。比较：
   - 登记表的 bundle 与整场 bundle 规范化后逐字段相同（同 bundlehash 的 `normalize`）；
   - 状态与 `fromBundle(整场)` 相同。比全部表，包括私有的：`constants`、`effects`、`shadowPasses`、`alignmentSizes`、`textObjects`、`frozenLayers`、`particleInstances`、`sounds`、`lights`、`cameras`、`animationLayers`、`order`、子表。私有的经 `as unknown as` 读，不为测试改可见性；
   - `restructure` 返回的组内问题与整场 `unsupported` 里的 `group:*` / `GROUP_CHILD_*` 类键一致。
2. **逐个删**：全加之后按固定种子的随机顺序逐个 `removeObject` + `dropObject`。每删一个，登记表的各表与「只加剩下那些对象」的登记表相同，关键帧 `parent` 的重排要对。删完各表为空，状态里除场景级字段外为空。
3. **替换**：对每个对象 `replaceObject(同一切片)` 之后，登记表与状态和替换前相同，图层在 `bundle.layers` 的位置不变。

输出每张场景的对象数、不同的字段路径。判据：全部为 0。

## 验收

- **全库编译产物**：bundlehash 233 张与基线相同（收尾的三段改成调共用函数，必须不变）。
- **全语料对照**：点 4 三项全为 0。
- **单测**（`compile/registry.test.ts`、`render/state.test.ts` 已有就加用例；只跑相关文件）：
  - `applyDelta` 错位抛错；
  - 灯槽分配：删一盏后新灯拿到空出的槽；
  - 关键帧联动跨增删的 `parent`；
  - `replaceObject` 留位置；
  - `dropObject` 清干净（建删 100 次后各表大小不涨）；
  - `restructure`：
    - 运行中换父进组、出组；
    - 带骨骼的挂点（`override` 真 / 假）；
    - 组内 effect 标记加上与去掉；
  - `particleOrdinal` 按加入先后、删后不回收；
  - `cameraLayers` 随增删变。
- `src/compile`、`src/render/state*` 相关测试照过；wpe-scene `tsc` 0 错误；prettier。
- **变异**（按原字节还原，每条都要被判据抓到）：
  - `addObject` 漏写一类常量（例：网格阴影变体）；
  - `removeObject` 不重排关键帧 `parent`；
  - `restructure` 不同步 `parent`；
  - `dropObject` 漏清 `effects`；
  - 灯槽不复用；
  - `replaceObject` 把图层追加到尾。
- **不碰**：宿主、`GpuScene`、渲染器（L3b / L4）。产品行为不变，除了收尾改成调共用函数（产物不变）。

## 验收中的补充（2026-11-17）

**实现与本计划不同的几处**（复核后接受）：
- `replaceObject` 不把其余表追加到尾，而是插回「按所属对象排序的位置」：脚本和关键帧的 `init` / `update` 顺序由表顺序决定，追加会改变被替换对象的执行顺序。加新对象时这个位置就是表尾。
- `restructure` 顺带按状态的子表重写 `bundle.children`，免得它和活的父子关系脱节。
- 共用函数没有另建 `structureRules.ts`，放在 `bundle.ts` 导出（`applyAttachments`、`applyGroupRules`），避免循环 import。
- `applyGroupRules` 对 effect 写时复制，不原地改，所以登记表的图层可以和整场 bundle 共用 effect。产物哈希不变。
- 状态加了私有表 `owned`，记每个对象占的常量 / effect / 阴影变体的键，`dropObject` 按它清，不依赖键的写法。
- 灯全删光时删掉 `bundle.lightObjects` 键，和编译期「没有灯就不写」一致。
- 「逐个加」对绑定只能按所属对象稳定排序后比：整场里场景级绑定与收尾登记的反射重编译绑定穿插在各处。脚本与关键帧严格同序。

**补上的漏项：状态的 effect 开关跟着组规则走。**
- 现象：`restructure` 给组内关着且读快照的 effect 加 / 去 `GROUP_CHILD_FRAMEBUFFER`，只改了登记表里的 effect。状态的 effect 开关表在 `addObject` 时就按 `unsupported.length > 0` 定了值，`needsRecompile` 读的是这份。
- 后果：运行中建的对象进了组、之后脚本打开那个 effect，不会整场重编译；出组时反过来多编一次。
- 为什么对照没抓到：语料里这类 effect 为 0。
- 修法：状态加 `syncEffectSupport(layer)`，只改 `unsupported`、不动运行中写的 `enabled`。`restructure` 在组规则之后对状态里有的每个图层调一次。补了单测和变异。

**L2 的回归顺带修了**：五个 `host.*.test.ts` 的 mock 还是旧入口，见 [phase-l2-worker.md](phase-l2-worker.md)「验收中的补充」。

## 交付

sonnet 执行代理在主工作区实现。
- **只改**：
  - `apps/wpe-scene/src/compile/` 下的 `fragment.ts`、`registry.ts`（新）、`registry.test.ts`（新）、`bundle.ts`（只把收尾三段换成共用函数）、`structureRules.ts`（若新建）；
  - `apps/wpe-scene/src/render/state.ts` 与它的测试；
  - `ignore/live/l3/`。
- 不碰 `render/` 其它文件（有别人未提交的改动）。
