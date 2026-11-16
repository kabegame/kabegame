# P6d3 — 运行时图层结构与建层（子计划）

> 上级：[phase-6d-dynamic-layers.md](phase-6d-dynamic-layers.md)（「已定」1–3、0c 实测、「后续步骤」3）。P6d1、P6d2 已提交（P6d2 `c08946a1`）。
> 依据：读码 [rea-p6d-layers.md](rea-p6d-layers.md)（exe 侧）、[rea-p6d-script.md](rea-p6d-script.md)（dll 侧）；0c 实测（P6d 总计划「0c 实测记录」）；2026-11-15 两个读码代理对现状的调研（结论摘进「现状锚点」）。
> 现状锚点取自 HEAD `c08946a1` 的工作区。`render/scene.ts`、`host.ts`、`script/api.ts`、`render/state.ts` 工作区里有别的会话没提交的改动，动工前再核对一次共享文件。

## 总体设计思路

WPE 有一张对象表（`G+0x158`）：场景里全部对象都在里面，包括灯、声音、相机、分组节点和子对象。它同时是绘制顺序，也是脚本 `getLayerIndex` / `getLayer(下标)` / `sortLayer` 的下标。我们今天把这张表拆进了三处，而且三处都在加载时定死：
- `bundle.layers`：编译期的 `objects` 顺序；
- `SceneState.layers`：按 `objects` 下标的 Map；
- `GpuScene.layers`：建场景时按 `buildableLayers` 排好。

P6d3 在 `SceneState` 上加一张运行时的对象表 `order`，它就是 WPE 的 `G+0x158`。读它的有：脚本的下标 API、顶层绘制、透明排序、反射 pass、体积光的插入点、相机对象的选择、光标命中。三个结构 API 都在这张表上做：
- `sortLayer` 改它；
- `destroyLayer` 记成待删，等脚本阶段结束后一次摘掉；
- 新建的对象追加在表尾。

**键不变。** 对象仍以 `objects` 下标为键。新建的对象占 `objects.length` 之后的新下标，只增不复用。这样 pass 键、绑定、脚本 id、写入重放表、`objects/<i>/…` 路径全部原样可用。对编译器来说，新建对象就是 `scene.json` 的 `objects` 在这个下标上多出一项，它不用学新的对象来源。

**运行中改结构分两类。**
- **只改顺序、存活集合、父链的**：排序、删除、不涉及组与挂点的换父。当场改 `SceneState`，渲染侧每帧从状态读，不重编译。
- **改编译产物的**：
  - 组归属变化：进出组合层组；组合层第一次有子层或失去最后一个子层；删掉一个组；
  - 换到骨骼挂点上；
  - 新建对象（P6d3b）。

  这些先当场改状态，再记进「结构」并重编译。

  结构是编译输入里的一个新字段，里面有删掉的对象、换过的父、新建对象的配置。编译按它改写 `scene.json` 的 `objects` 之后照常编。重编译期间旧场景照画（现有机制），所以这类变化要晚一段才在画面上生效，这是已知差异。语料里 `setParent` 是 0 处。

**重编译保持结构。** 每次编译（属性改动、设置变化、脚本写重编译目标）都带上当前的结构，所以删掉的对象不会回来，新建的对象一直在，换过的父也保留。新的渲染状态在首帧前从旧状态接过 `order` 与待删集合，再重放脚本写入。

**脚本侧。**
- 删除生效时，属主是这个对象的全部脚本条目（图层字段、它的 effect、材质常量、动画层）先收 `destroy`，再从运行时摘掉，它们的计时器一并去掉。
- 这个对象的脚本对象随之作废：读字段得 `undefined`、写入忽略、方法返回 `undefined`、`engine.isObjectValid` 为假。
- 同一帧里、生效之前，它照常可读写，排在后面的脚本照收 `update`（0c 实测）。

**建层（P6d3b）。** `createLayer` 当场做完以下几件事，然后返回：
- 分配下标；
- 按 WPE dll 的规则把参数整理成一段 JSON（缺省纯色层、`stringifyConfig`、路径分类、`__workshopId` 改写）；
- 建出一个「待编」对象：
  - 状态按配置里的字段值建；
  - 脚本对象建好，追加到对象表尾；
  - 配置里带的脚本（克隆）用 P6d2 的工厂同步实例化一份，并在返回前跑完 `init`。

之后带着它重编译：
- **`init` 里建的**：在首帧之前等第二次编译完，再建 GPU 资源，画面和 WPE 一样。
- **`update` 里建的**：P6d3b 先走同一条重编译，晚一段出现，而且每建一个就重编一次。P6d4 再改成「编过的配置同步实例化」（改键、GPU 同步加层），首次出现的配置异步编完再画（总计划「已定」3）。

**关键决策与理由。**
- **新对象沿用 `objects` 下标的键空间**，不另造键：所有表都不用改形状。
- **编译仍是整场一次性的**：编译端没有单对象入口（所有 `compileXxx` 都是 `compileScene` 里的闭包，依赖整场并集与「全部编完后」的整表步骤），P6d3 不重构它。代价是 `init` 里建层的场景加载时多编一次。
- **结构变化里改编译产物的那部分一律走重编译**，不在渲染侧增量改组。组、挂点、`groupUpload` pass 都是编译产物，增量改的面太大，语料又用不到。

## 分步

- **P6d3a 运行时对象表与结构 API（不含建层）**：点 1–8。
  - 内容：`order` 与下标 API、`sortLayer`、`destroyLayer`（含脚本 `destroy` 与作废）、`setParent`、`getParent` / `getChildren` 改读状态、`getInitialLayerConfig`、`registerAsset`、编译输入里的结构（删除与父覆盖）。
  - `createLayer` 不动，仍在缺口表里。
  - 可能解锁 `2887099508`（`destroyLayer`，`getAnimationLayer` 已由 P12c 实现）、`3570755196`（`registerAsset` 登记字体，快捷方式已由 P11d 实现），以动工后的扫描为准。
- **P6d3b `createLayer`**：参数整理、`__workshopId`、缺省纯色层、待编对象、克隆带脚本、结构里的新建对象、首帧前等第二次编译。解锁 4 张音频条。点在 P6d3a 提交后补写（见「P6d3b 概要」）。

两步各自单独验收、单独提交。

## 步骤 0 — 补测（Claude，wpe-renderdoc）

0c 已经测清下标、排序、删除时机、克隆与层级的主要行为。P6d3a 还缺几条，用 `kbp gen` 做两个不用 `createLayer` 的确定性工程，日志前缀 `[kbp6d3]`，抓帧看绘制顺序：
- **`p6d3-struct`**：
  - 有灯、声音、分组节点、组合层组（带两个子层）；
  - `sortLayer` 把组里的子层排到组前面、排到别的子层后面，看组内绘制顺序与 `getChildren`；
  - `destroyLayer` 删组里的一个子层、删整个组（子层是否改由顶层画、画在哪）、删声音（声音停不停）、删相机对象（当前相机换不换）、删灯（光照变不变）；
  - `getInitialLayerConfig` 对带长小数（`0.123456789123`）、整数、布尔、嵌套 `effects` 的对象的输出，核对键序与数字精度（读码说 jsoncpp writer 精度 8）。
- **`p6d3-parent`**：
  - `setParent` 进组合层组、出组、让组合层第一次有子层；
  - 组深度超限（三层嵌套组再挂一层）的报错文字与之后的父；
  - 换父造成环（`a.setParent(b)` 而 `b` 是 `a` 的子）WPE 怎样（可能崩测试窗口，照 0c 的先例可以接受）；
  - `getChildren` 在换父、删除之后的顺序；
  - 带挂点的 `setParent`（用 P12 生成的带骨骼 puppet 工程）不带 / 带 `adjust` 的世界矩阵（读码「未查清 6」）。

`p6d-tree` 不用 `createLayer`，重抓一份 WPE 日志直接当 P6d3a 的验收夹具（0c 当时只摘了结论，全文没存）。

### 步骤 0 实测记录（2026-11-15）

工程 `ignore/p6/d3/make_step0.py` → `ignore/p6/d3/proj/`；抓帧在 `A:\p6d3\{struct,parent,attach,tree}\`；日志夹具 `ignore/p6/d3/out/wpe-{struct,parent,attach,tree}.log`（`cut_log.py` 按字节区间从 WPE `log.txt` 截出）；画面 `ignore/p6/d3/out/wpe-*.png`。

**组与排序（p6d3-struct）**
- **组内顺序跟子表走**，不跟对象表：`sortLayer(G2, idx(G1))` 之后表是 `…,G,G2,G1,…`，组的合成 RT 里仍是先 G1 后 G2；把 G1 排到表头（组 G 前面），它照样由组画。`getChildren` 不随 `sortLayer` 变（同读码）。
- **删组里的子层**：同一帧 `getChildren` 还有它（待删），下一帧没了。
- **删组**：剩下的子层下一帧变成根，当帧就改由顶层画，画在它自己在表里的位置（G1 在表头就最先画），世界矩阵 = 本地（`M[…,900,540,…]` → `M[…,-60,0,…]`）。
- **相机对象**：`sortLayer(CamA, 999)` 之后当前相机换成 CamA（相机表随对象表重排，取最后一个可见的）；删 CamA 之后回到 CamB。都是当帧。
- **删过的对象再删**返回 `false`（已不在表里）；删灯返回 `true`。
- **`getInitialLayerConfig`**：去掉 `id`，键按字典序；浮点按 8 位有效数字（`0.123456789123` → `0.12345679`，`1234.56789123` → `1234.5679`，`-0.000012345678912` → `-0.000012345679`），整数原样（`123456789012`），`1e21` 经 JSON.parse 后是 `1e+21`；没写的键不补。

**换父（p6d3-parent，最后一步造环让整个 WPE 崩溃，桌面壁纸也停了，已由 `ensure_running` 拉起）**
- `setParent` 返回 `undefined`；第一参收对象、名字、`getLayerIndex` 的下标、id 字符串（`'10'`）；`null`、`undefined`、找不到的名字都是解除父子。
- **不 adjust**：本地字段不动，世界矩阵按新父重算（R 挂进组 G 后世界 `1150,540` → `2110,1080`）。
- **adjust**：平移逐位保持；新父没有非均匀缩放与旋转差时整个世界矩阵保持（R2 挂进 H 后 origin 变成 `100,0,0`）；新父有非均匀缩放时剪切丢失，世界旋转缩放部分会变。规则见读码 [rea-p6d3-adjust.md](rea-p6d3-adjust.md)：
  - 局部旋转取「父链刚体旋转的逆 × 自身链刚体旋转」，祖先缩放不计；
  - 缩放让新世界矩阵每列长度等于旧的；
  - 复算与日志逐位相同。
- **进组当帧生效**：R 挂进组 G 的同一帧就画进 G 的合成 RT（被裁掉，看不见）；R2 挂进没有子层的组合层 H，当帧 H 就有了合成 RT（成了组）。我们走重编译、晚一段生效（「已定」2）。
- **组深度**：K1 ⊃ K2 ⊃ K3 三层组合层，普通层挂到 K3 下可以；**没有子层的组合层** Z0 挂到 K3 下也抛 `Error: Invalid parent configuration.`（组合层不管有没有子层都算组），之后它的父是 `null`；带子层的组合层 Z 挂到 K2 下可以（2 + 1 = 3）。
- **子表顺序**：换父挂上的追加在尾（`P kids Q,S1,S2,S3` 按调用顺序）；解除父子与删除从子表摘掉。
- **成环**（`P.setParent(P 的子 S1)`）：WPE 整个进程崩溃（日志停在调用前）。我们拒绝这个调用、记 warn，不改结构。

**挂点（p6d3-attach，拷 P12 的 p12-att）**
- `setParent(parent, 'tipA')` 与 `setParent(parent, 0)`（整数下标）都挂上，本地字段不动。
- 带 adjust（`'tipB', true` 或 `1, true`）：origin 与 angles 读出全 0、scale `(1,1,1)`，世界旋转保持、平移落在挂点上。细节交给同一份读码。
- 从挂点改挂到同一个父（`setParent(parent, true)`）：挂点清掉，世界矩阵保持（f32 末位差），origin 改成相对父。

**对计划的影响**
- 点 2 的结构里，父覆盖要带顺序（子表顺序 = 加载时的 `objects` 顺序，之后按挂上的先后追加），编译的 `assignGroups` 按它排组内顺序，不再一律按 `objects` 下标。
- 点 3 不用改组内顺序；删组之后子层由顶层画这一段，在重编译完之前我们不画它们（见点 4），已知差异。
- 点 6 的组判定改成「组合层（passthrough 模型）」，不看有没有子层；环一律拒绝。

## 现状锚点

**a. 状态里的父是只读的，没有对象表**（`render/state.ts:108`、`:275`）
```ts
  /** 父对象的 `objects` 下标（`SceneLayer.parent`），根节点为 null。运行中不变。 */
  readonly parent: number | null;   // 现状：加载时定死
// …
export class SceneState {
  /** 按 `objects` 下标（稳定键）；只含进了 bundle 的图层。 */
  readonly layers = new Map<number, LayerState>();   // 现状：只在 fromBundle 里 set；没有顺序表、没有增删方法
```

**b. 顶层绘制按建场景时的顺序**（`render/scene.ts:5501-5508`）
```ts
    if (perspective && transparentSorting) {
      const top = this.layers.filter((layer) => layer.layer.group == null).map((runtime) => runtime.layer);
      for (const layer of transparentDrawOrder(top, state, this.view.viewVectors.forward))
        runTop(this.runtimeByObject.get(layer.object)!);
    } else for (const layer of this.layers) if (layer.layer.group == null) runTop(layer);   // 现状：this.layers 只在 populate 里 push
```
同样按 `objects` 下标排序或比较大小的还有：
- 体积光插入点：`lightObjects[nextLight] < object`（`:5484`）；
- 反射 pass：遍历 `this.layers`（`:5437`）；
- 两处按下标排序：`stepParticles`（`:4695`）、`drawPhase`（`:4762`）；
- 相机对象选择：`layer.object < best.object`（`render/camera.ts:455`）；
- 光标命中：`bundle.layers` 倒序（`render/cursor.ts:420`、`render/renderer.ts:453`）。

**c. 脚本的下标 API 读 bundle**（`script/api.ts:1357-1371`、`:427-437`）
```ts
    this.method(this.thisScene, "getLayerCount", () => this.access.bundle().layers.length, true);   // 现状：不扣待删
    // enumerateLayers：bundle.layers 的顺序；getLayerIndex：返回 .object（objects 下标）
    this.method(api, "getParent", () => {
      const parent = this.findLayer(object)?.parent ?? null;   // 现状：读 SceneLayer.parent（编译期）
    // getChildren：bundle.layers.filter(parent === object)，objects 顺序
```

**d. 脚本条目只在加载时一次建成，`destroy` 只在整个运行时销毁时派发**（`script/runtime.ts:370`、`:609`）
```ts
    this.records = scripts.list.map((script) => ({ script, module: null, … }));   // 现状：没有追加 / 摘除
  destroy(): void {
    for (const record of this.records) if (record.state === "inited" && !this.halted) this.call(record, "destroy");   // 现状：只有整场销毁
```

**e. 存活判断按 bundle**（`script/api.ts:909`）
```ts
        [...this.layers.entries()].some(([index, layer]) => layer === value && !!this.findLayer(index)) ||   // 现状：bundle 里有就算有效
```

**f. 编译输入没有结构，`objects` 每次从 `scene.json` 从头编**（`compile/protocol.ts:15`、`compile/bundle.ts:2558`）
```ts
      type: "start"; projectDir: string; …; scriptOverrides: Record<string, number[] | boolean | string>; …   // 现状：只有按路径的写入覆盖
  for (const [index, object] of scene.objects.entries()) {   // 现状：每一项都当对象编，没有「这一项已删」
```

**g. 脚本阶段在宿主 `beforeFrame` 的末尾**（`host.ts:1356`）
```ts
          this.runtime?.frame(dt);   // 现状：之后就回到渲染器的 drawPhase / sync / encode，没有「删除生效」这一步
```

**h. 结构 API 都在缺口表里**（`compile/scriptApi.ts:70-80`、`:107`、`:121`）：`createLayer`、`destroyLayer`、`sortLayer`、`getInitialLayerConfig`、`registerAsset`、`setParent`，用到就整张退回。

## P6d3a 的点

### 点 1 — 状态里的对象表、待删与可变的父（`render/state.ts`）

- **新增**
```ts
export class SceneState {
  /**
   * WPE 的对象表（G+0x158）：全部对象键（含灯、声音、相机、分组节点、子对象），顺序 = 绘制顺序 = 脚本的原始下标。
   * 加载时 = bundle.layers 的顺序。sortLayer 改它；destroyLayer 生效时摘掉；P6d3b 起新建的追加在尾。
   */
  readonly order: number[] = [];
  /** destroyLayer 标记、还没生效的对象（rea-p6d-layers 第 5 节）。下标 API 按它扣减（见点 5）。 */
  readonly pendingDestroy = new Set<number>();
  /** 结构代数：order、父子、存活每变一次加一。渲染侧按它重建派生表（绘制顺序、位置表、命中表）。 */
  structureVersion = 0;

  /** WPE 宿主 +0x38：先摘掉再插到 index（u32 比较，越界与负数到末尾）。不在表里返回 false。 */
  sortLayer(object: number, index: number): boolean;
  /** WPE 宿主 +0x28：在表里就记待删（重复也是 true），否则 false。 */
  markDestroy(object: number): boolean;
  /**
   * 待删生效（脚本阶段之后）：从 order、layers、待删集合摘掉；子对象只取消父子关系（本地字段不动，世界变换随之跳变）；
   * 从父的子表摘掉自己。返回生效的对象（按标记先后），交给运行时与渲染侧清理。
   */
  flushDestroy(): number[];
  /** 换父（不含 adjust 的数学，那在 API 一侧）：改 parent、旧父与新父的子表，标脏整棵子树（世界矩阵、影子缓存）。 */
  setParent(object: number, parent: number | null): void;
  /** 子表（WPE O+0x198）：加载时按 objects 顺序；换父挂上的追加在尾（0c 实测）；sortLayer 不改它。 */
  childrenOf(object: number): readonly number[];
  /** 重编译后新状态接过旧状态的结构：order（滤掉新 bundle 里没有的）、待删集合。父与删除已经由编译输入带进 bundle。 */
  adoptStructure(previous: SceneState): void;
}
```
- **修改**
  - `LayerState.parent` 去掉 `readonly`，注释改成「运行中由 `setParent` / 删父改」。
  - `fromBundle` 按 `bundle.layers` 填 `order`。
  - 私有的 `children` 改成可变的子表，`subtree()` 照旧读它。

### 点 2 — 编译输入里的结构（`compile/protocol.ts`、`compile/bundle.ts`、`compile/hierarchy.ts`、`host.ts`）

- **新增**（`compile/protocol.ts`）
```ts
/** 运行中改过的场景结构（P6d3）：每次编译都带全量，重编译后结构不丢。 */
export interface SceneStructure {
  /** 删掉的对象（objects 下标）：编译时当作这一项不存在，不进 bundle.layers，也不参与父链、依赖、灯等整场并集。 */
  destroyed: number[];
  /**
   * 运行中的换父，按发生的先后：[对象, 新父的 objects 下标（null 是根）, 挂点（骨骼名，没有是 null）]。在 resolveParents 之后依次套用，
   * 子表 = 加载时按 objects 顺序、之后按这里的先后追加（步骤 0：组内绘制顺序跟子表走），组、挂点、groupUpload 按新父算。
   * 同一个对象多次换父只留最后一次（它在子表里的位置按最后一次挂上的时刻）。
   */
  parents: [number, number | null, string | null][];
  // P6d3b：created —— 新建对象的下标与配置 JSON
}
```
- **修改**
  - `start` 请求加 `structure: SceneStructure`。`compileScene` 在套用 `scriptOverrides` 之后，把 `destroyed` 里的项置成 `null`。
  - 对象循环跳过不是对象的项（同 WPE 场景加载「非对象元素跳过」），`bundle.layers` 从此不保证 `layers[i].object === i`。
  - `resolveParents` 之后套 `parents` 覆盖。覆盖成环时（理论上 API 已挡住，见点 6）照现有规则断边。
  - 宿主维护一份 `structure`：
    - 删除生效时记进 `destroyed`；
    - 换父时记进 `parents`；
    - 每次 `reload()` 照 `scriptOverrides` 一样交给编译。
  - 「清空脚本存储」时清空结构，回到 `scene.json` 原样。

### 点 3 — 渲染侧按对象表画（`render/scene.ts`、`render/camera.ts`、`render/cursor.ts`、`render/renderer.ts`）

- **新增**（`render/scene.ts`）
```ts
  /** 按 structureVersion 缓存的派生表：顶层绘制顺序（state.order 里有 LayerRuntime、且不由组代画的）、对象 → 表内位置。 */
  private structure(state: SceneState): { top: LayerRuntime[]; position: Map<number, number> };
```
- **修改**
  - 顶层绘制与透明排序的输入改用 `structure(state).top`。组的 `subtree` op 不变（组内顺序编译期定，见步骤 0 的核对）。
  - 反射 pass 改按 `top` 的顺序。体积光插入点从 `lightObjects[i] < object` 改成按 `position` 比较。
  - `stepParticles`、`drawPhase` 的按下标排序改按 `position`。
  - 相机对象选择（`render/camera.ts`）改成遍历 `state.order`，取最后一个可见的（同 WPE 相机表倒序第一个可见，相机表随 `sortLayer` 重排）。
  - 光标命中表（`render/cursor.ts`、`renderer.ts` 的 `pickLayers`）改按 `state.order` 倒序。透视场景照旧先排序再倒序。
- **删除**：不删函数，只换输入。

### 点 4 — 删除生效与渲染侧清理（`host.ts`、`render/scene.ts`、`render/renderer.ts`）

- **新增**（`host.ts`，`beforeFrame` 里 `this.runtime?.frame(dt)` 之后）
```ts
          // 删除生效（rea-p6d-layers 4.2 第 7.5 步）：全部脚本（含计时器、update）之后、绘制之前。先摘表、再让脚本收 destroy
          const removed = drawn.flushDestroy();
          if (removed.length > 0) this.destroyObjects(removed);   // 运行时派发 destroy 并摘条目、结构里记 destroyed、需要时请求重编译
```
- **修改**
  - **`GpuScene.sync`**：发现 `structureVersion` 变了，就释放 `state.layers` 里已经没有的对象的 `LayerRuntime`，具体是：
    - draw 的顶点 / uniform 缓冲；
    - 被依赖层的独占 RT；
    - 粒子树；
    - 挂点缓存 `attachedLayers`；
    - 阴影投射者表里的项。

    共享的程序、管线、纹理、池化合成 RT 不动。
  - **宿主侧子系统**：按对象跳过或停掉被删的对象：
    - 声音排期器停播（步骤 0 核对 WPE 删声音时停不停）；
    - `ScenePuppets`、`SceneAnimations` 里属主是它的条目去掉（rea-p6d-layers 6.3 第 4 条：删对象时连带删它的动画绑定）；
    - 文本重排器、光标的悬停 / 按下集合摘掉它，不发 `cursorLeave` / `cursorUp`（rea-p6d-layers 6.2）。
  - **删的是组、组的子层，或组合层失去最后一个子层时**：组归属变了，宿主请求一次重编译（结构里已记 `destroyed`）。这次重编译之前，被删的组照现有逻辑不画（状态里没有它），它的子层仍挂在组的 `subtree` op 上，跟着不画，等重编译完改由顶层画。这一段差异写进文档。

### 点 5 — 脚本运行时的 `destroy`（`script/runtime.ts`）

- **新增**
```ts
  /**
   * destroyLayer 生效（rea-p6d-layers 6.3 第 4 条）：属主是这些对象的条目（scriptObject(owner) 在集合里：图层字段、effect、
   * 材质常量、动画层）按条目顺序先收 destroy（导出了、已 init 才调），再从 records / byId 摘掉；它们的计时器去掉；
   * 写入重放表里以 objects/<i>/ 开头的项去掉（重编译后不重放到不存在的对象上）。
   */
  destroyObjects(objects: ReadonlySet<number>): void;
```
- **修改**
  - `frame` 遍历 `this.records` 的方式不变：数组迭代器每步重看长度，P6d3b 追加的条目同一轮能遍历到。
  - 摘条目时用新数组替换（`this.records = this.records.filter(…)`）。这只发生在脚本阶段之后，不影响正在进行的遍历。

### 点 6 — 脚本 API（`script/api.ts`）

- **新增**
```ts
  /** 对象还在（没有生效删除）。图层、它的 effect 与材质对象的读写与方法都先过它（作废后读 undefined、写忽略、方法返回 undefined）。 */
  private alive(object: number): boolean;   // state().layers.has(object)
  /**
   * WPE dll 的图层参数解析 R（rea-p6d-script 4.1）：字符串先按名字（第一个同名的，它待删就 null），找不到再 strtol 当 id；
   * 数字 ToInt32 按原始下标（待删或越界 null）；图层对象取它的下标（作废的旧对象当作找不到）。
   */
  private resolveLayer(value: unknown): number | null;
```
- **修改**：thisScene 的下标与结构 API，照 WPE 的表（rea-p6d-layers 3.3、rea-p6d-script 5.1）：
  - `getLayerCount` = `order.length − pendingDestroy.size`；
  - `enumerateLayers` 按 `order`，跳过待删；
  - `getLayerIndex(x)` 是 `order` 里的原始下标，含待删，找不到 −1，参数不是对象 / 数字 / 字符串也是 −1；
  - `getLayer(数字)` 按原始下标，待删返回 `null`；
  - `getLayer(名字)`、`getLayerByID` 遇到待删返回 `null`；
  - **`sortLayer(x, i)`**：少于两个参数返回 `false`；第二参不是 Number 返回 `false`（`'3'` 也是）；之后 `ToInt32`，`resolveLayer` 解析不到返回 `false`，否则调 `state.sortLayer`；
  - **`destroyLayer(x)`**：`resolveLayer` 后调 `state.markDestroy`，`null` 与解析不到返回 `false`。它和 `sortLayer` 一样，在模块顶层调抛 `SyntaxError`（同其余 thisScene 方法的作用域门；文案照 dll，包括 `getLayerByID` / `getInitialLayerConfig` 两处抄错的名字）。
- **修改**：图层对象。
  - **`getParent`、`getChildren`**：改读状态里的父与子表，`getChildren` 每次新数组。
  - **`setParent(parent, attachment | adjust, adjust)`**（rea-p6d-layers 9.4、rea-p6d-script 概括 7）：
    - 第一参照 WPE 的 `D[3]` 解析：名字再 id、下标、对象。解析不到（`undefined`、找不到、待删、作废）就解除父子。
    - `adjust` = 第二参或第三参是布尔真。第二参是整数或字符串时当挂点。
    - 父与挂点都没变，直接返回（在一切检查之前）。
    - 成环（新父是自己或自己的子孙）：不改、记 warn、返回。WPE 没有成环检测、实测整个进程崩溃，不复刻。
    - 先从旧父的子表摘掉自己，再做组深度检查（[rea-p6d3-adjust.md](rea-p6d3-adjust.md) 第 3 节）：
      - 「组」是模型 JSON `passthrough: true` 的图像层（`SceneLayer.passthroughModel`），不看有没有子层；
      - `up(新父) + down(自己) ≥ 4` 时失败：父置空、挂点清掉、本地字段不动，抛 `Error("Invalid parent configuration.")`。
    - `adjust` 为假：只换父，本地字段不动。
    - `adjust` 为真、没有挂点：照读码第 1 节逐步复刻（f32、列主序、glm 求逆、刚体链、`extractEulerAngleZYX`、先写角度再重建 3×3、按列长修缩放），P6d1 的 `rotation` 清掉。
    - `adjust` 为真、带挂点：本地变换归零（origin、angles 为 0，3×3 为单位阵，缩放不变），见读码第 2 节。
    - 改完调 `state.setParent`，记进宿主的 `structure.parents`。组归属或挂点变了时请求重编译。
  - `engine.isObjectValid` 的图层、effect、材质三支都改用 `alive`。
- **删除**：`findLayer` 不再用来判断存在，只用来取编译期的 `SceneLayer` 数据。

### 点 7 — `getInitialLayerConfig` 与 `registerAsset`（`compile/bundle.ts`、`script/api.ts`）

- **新增**
  - bundle 带每个对象加载时的配置原文：`configs: Map<number, string>`（objects 下标 → JSON 文本）。规则如下：
    - 去掉顶层 `id`；
    - 键按字典序（jsoncpp 的对象键序）；
    - 数字按步骤 0 核对的 writer 精度；
    - `script`、`user`、`animation`、`effects`、`parent` 都保留（0c 实测）。

    `scriptOverrides` 不影响它：它是加载时的原文，不反映运行中的改动。
  - `thisScene.getInitialLayerConfig(x)`：`resolveLayer` 后返回 `JSON.parse(configs.get(x))`，每次一个新对象。解析不到返回 `null`，不看待删。
  - `engine.registerAsset(path, precache?)`（rea-p6d-script 第 3 节）：
    - 不在模块顶层调用时，抛 `SyntaxError("registerAsset can only be called from global scope.")`（沿用 `requireEvaluating`）；
    - 参数不是字符串返回 `null`；
    - 同一段脚本第二次登记同一路径返回 `null`；
    - 否则返回这个路径字符串本身。

    登记表只记在脚本条目上，留给 P6d3b 的 `__workshopId` 改写。WPE 的 exe 不读这张表（读码「没找到调用者」），所以 precache 什么都不做。
- **修改**：文本层 `font` 收到登记返回的字符串，就是原路径（dll 不改写），走现有的整场重编译。

### 点 8 — 能力表（`compile/scriptApi.ts`、`compile/features.ts`）

- **删除**：缺口表里的 `destroyLayer`、`sortLayer`、`getInitialLayerConfig`、`setParent`、`registerAsset`。
- **保留**：`createLayer`（P6d3b），`createModelData` / `destroyModelData`、`getCameraTransforms` / `setCameraTransforms`（语料 0 处，照报）。
- **修改**：文档与能力表注释同步。

## P6d3b — `createLayer`（2026-11-15 补写，P6d3a 已提交 `423122d4`）

### 设计

`createLayer` 当场把参数整理成一段配置 JSON、分到一个新下标，建出一个**待编对象**并返回它的脚本对象：
- 状态、对象表里的位置、脚本对象都当场就有；
- 配置里带的脚本当场实例化、跑 `init`；
- 只是还没有编译产物（`SceneLayer`、pass、GPU 资源）。

新建对象记进结构（`SceneStructure.created`），之后的编译把它当成 `scene.json` 的 `objects` 在这个下标上多出的一项，和场景对象走同一条编译路径：
- 模型、材质、effect、属性绑定、关键帧、脚本常量目标都按 `objects/<新下标>/…` 登记；
- 所以 `bar.json` 材质的颜色绑用户属性，63 根条每根各有一个就地目标，不用另写「逐实例」的代码。

**什么时候编**：

| 建层的时机 | 怎么编 | 和 WPE 比 |
|---|---|---|
| 首次加载的 `init` 里 | 这次加载在 `init` 跑完之后发现结构多了新建对象，就放弃本次、带着结构重新加载。脚本环境保留（`ensureRuntime` 发现已有运行时就跳过），第二次编译完才建 GPU 资源、画第一帧 | 画面相同，代价是加载时多一次整场编译。四张音频条都是这种 |
| `update`、回调、计时器里 | 请求一次重编译，多次请求合并 | 晚一段才画出来，是已知差异。P6d4 改成「编过的配置同步实例化」 |

**编译前读到的编译期字段**与 WPE 不同，是已知差异：自动尺寸的 `size`、`getEffectCount` / `getEffect`、材质。图层字段（`origin`、`scale`、`alignment` 等）照常读写；写进状态与写入重放表，编完重放到新状态上。

### 现状锚点（P6d3a 之后）

**i. 首次加载：脚本 `init` 跑完就建 GPU 资源**（`host.ts` 约 1684–1717 行）
```ts
      if ((!this.runtime || this.runtimeTask) && bundle.scripts.list.length && !this.scriptUnavailable) {
        this.scriptBundle = bundle;
        this.scriptState = SceneState.fromBundle(bundle);
        // …
        await this.ensureRuntime(bundle, target.sceneAssets);   // 现状：init 在这里跑
        // …
      }
      // …
      await current.load(bundle, { … });   // 现状：init 里建的层这时还没有编译产物
```

**ii. 编译输入的结构只有删除与换父**（`compile/protocol.ts`）
```ts
export interface SceneStructure {
  destroyed: number[];
  parents: [number, number | null, string | null][];
  // 现状：没有新建对象
}
```

**iii. 脚本条目只从 `scene.json` 收集**（`compile/scripts.ts:198`）
```ts
export async function collectScripts(scene: SceneJson, properties: …, bindings: SceneBinding[]): Promise<SceneScripts> {
  // 现状：遍历 scene.general 与 scene.objects；没有「只收一个对象」的入口
```

### 点 9 — 参数整理与 `__workshopId`（新 `script/createConfig.ts`、`script/api.ts`）

- **新增**：纯函数 `createLayerConfig(args, ctx): Record<string, unknown> | null`。照 dll 的流程（rea-p6d-script 1.2、1.3，0c 的 p6d-asset 实测），逐条：
  - 参数个数不是 1：`{ image: 缺省模型 }`。
  - 对象：
    - 经 realm 的 `_Internal.stringifyConfig`（`Vec` → `"x y z"`），再 `JSON.parse`；
    - 结果不是对象返回 `null`，所以 `Vec3` 作参数是 `null`；
    - 数组按 0c 实测建出一个空名对象（照抄实测，类型待步骤 0 再核）；
    - 抛异常吞掉，返回 `null`。
  - 字符串：先当 JSON，是对象同上；否则当资源路径：
    - 去掉开头的 `/` `\`；
    - 按第一段目录（区分大小写）与小写扩展名定键：`models/*.json` → `image`，`models/` 其它 → `model`，`particles/` → `particle`，`materials/` → `sprite`，`sounds/` → `sound`；
    - 别的目录返回 `null`；
    - 路径先经 `RP`（键为空，一般规则）。
  - 其它类型返回 `null`。
  - 整理（对象与 JSON 字符串分支）：
    - 有 `color` 却没有 `model`、`particle`、`sprite`、`image`、`text`、`light`、`sound`、`camera` 任何一个键时，补 `image: 缺省模型`；
    - 再对 `particle`、`sprite`、`image`、`font`、`path`（字符串）、`sound`（字符串或字符串数组）、`effects[].file`、`effects[].passes[].textures[]`（textures 规则）做 `RP`。
- **缺省模型**：正交场景 `models/util/solidlayer_depthtest.json`，透视 `models/util/solidlayer.json`。读码说宿主 `+0x90` 是场景 `G+0xe0` bit3（正交），0c 在正交场景实测是 depthtest。透视那一半由步骤 0 实测。
- **`RP(path, key)`**（rea-p6d-script 2.2）：
  - 「当前脚本」（运行时正在调用的条目）没有字符串 `__workshopId` 就不改；
  - 路径在 WPE `assets` 里存在就不改；
  - 否则改写。一般规则是 `第一段/workshop/<id>/其余`，第二段已经是 `workshop` 时先去掉旧的 `workshop/<旧 id>`；`textures` 规则是 `workshop/<id>/<路径>`；最后 `\` 换成 `/`、合并 `//`。
- **`__workshopId` 的读取**：运行时在每段模块求值完（`instantiate` 之后）读一次导出的 `__workshopId`，只认字符串，记在条目上；之后再改导出变量不生效。
- **「在不在 `assets` 里」**：编译期在 Worker 里做。
  - 扫全部脚本源码里形如资源路径的字符串字面量：以 `models/`、`particles/`、`materials/`、`sounds/`、`fonts/`、`effects/`、`shaders/`、`textures/` 开头。
  - 逐个只在 `sceneAssets` 根目录下查存在（`SceneFs` 新增一个只查 assets 的入口）。
  - 存在的随 bundle 带回（`bundle.assetPaths: string[]`）。
  - 不在名单里的按「不在」处理（拼出来的路径会被改写；只有拼出的恰好是 WPE 自带资源时与 WPE 不同）。
- **作用域门**：模块顶层调用抛 `SyntaxError: createLayer cannot be called from global scope.`。

### 点 10 — 待编对象（`render/state.ts`、`script/api.ts`、`host.ts`）

- **下标**：宿主分配，从 `max(objects.length, 已建的最大下标 + 1)` 起，只增不复用。记进 `structure.created`，每项是 `{ object, config }`，`config` 是整理后的 JSON 文本。
- **状态**：`SceneState.addLayer(object, layerState, parent)` 追加到 `order` 尾、写 `layers`，挂到父的子表尾。
  - 父按配置的 `parent`（数字 id）在**当时存在**的对象里找；找不到、待删的当根（rea-p6d-layers 3.2：`createLayer` 不跑加载末的补挂）。
  - 图层壳的取值和编译期同一个函数：从 `bundle.ts` 建 `SceneLayer` 的那段抽出纯函数 `layerShellValues(object)`，只取值；绑定对象取它的 `value`。
  - `structureVersion++`。
- **脚本对象**：API 维护一张 `pending: Map<下标, PendingLayer>`，编进 bundle 之后就不再用。
  - 内容：`name`、`id`、类型键、配置；
  - 用途：给 `layer(object)` 判存在和装按类型的成员（声音、粒子、对齐、文本按配置的类型键；骨骼一类编译期才知道的不装）。
- **`id`**：配置里有非 0 的数字 `id` 就照用（不查重），否则取「现有最大 id + 1」起第一个没被占的。WPE 用的是渲染器级计数器（effect、动画层也从它发号），具体值没法复刻，是已知差异。语料里没有对新建层用 `getLayerByID` 的。
- **`getInitialLayerConfig(新层)`**：返回整理后的配置，经 `normalizeConfig`（去 `id`、键排序、8 位有效数字），编译前后相同。

### 点 11 — 新建对象上的脚本（`compile/scripts.ts`、`script/runtime.ts`）

- **收集**：新增 `collectObjectScripts(config, object, properties)`，和 `collectScripts` 同一套遍历、键序（`registrationKeys`）、属主与写回目标，只收这一个对象，路径 `objects/<下标>/…`。从 `collectScripts` 抽出共用的单对象遍历，不复制一份。
- **运行时**：新增 `addScripts(scripts)`，在 `createLayer` 返回前按条目顺序做：
  1. 取 realm 里同源码已备好的模块（`prepareModule` 的缓存），同步 `instantiate`；
  2. 读 `__workshopId`；
  3. 追加进 `records` / `byId`；
  4. `updateScriptProperties`；
  5. 调 `init`，写回返回值。

  效果是 0c 实测的 `before` → 新层 `init` → `after`，新条目同一轮 `update` 能遍历到（数组迭代器每步看长度）。
  - 源码没备过的：异步 `prepareModule`，备好之后补跑 `init`（晚一段，已知差异，语料 0 处）。
  - 导入的库必须已在 import map 里，克隆的源码就是现有的，不会缺；缺的照现有的「说明符无效」处理。
- **编完之后**：新 bundle 换上时（`beforeFirstFrame`），按 id 用新 bundle 的 `scripts.list` 刷新这些条目的 `script`，常量目标的 uniform 信息由 `compilePass` 填好。

### 点 12 — 结构里的新建对象与首帧（`compile/protocol.ts`、`compile/bundle.ts`、`host.ts`）

- **修改**：`SceneStructure` 加 `created: { object: number; config: string }[]`。
- **编译**：
  - 套用 `scriptOverrides` 之前，把每个新建对象的配置放到 `scene.objects[object]`，中间的空位补 `null`；
  - `destroyed` 照旧在之后置空，所以建了又删的不编；
  - `configs[object]` 取这份配置的规整；
  - **依赖标记**（`dependencies` → 被依赖层）只看加载时的对象（rea-p6d-layers 11：新建层不重算依赖标记）。灯、反射名单照常收新对象，因为 WPE 工厂会把它们放进灯表与反射表。
- **宿主，首次加载**：`ensureRuntime` 跑完 `init` 之后比较 `structure.created` 与这次编译用的结构；多了就放弃本次加载、立刻重新加载。见锚点 i。
  - 重新加载时：脚本环境已在，`init` 不重跑；`pendingAnimations` / `pendingPuppets` 按现有的「加载期间又来一次加载」接过来；
  - 首帧前 `adoptStructure` 接过对象表（新建对象在原来的位置）、待删、父子，再重放写入。
- **宿主，运行中**：建层后请求重编译（`requestScriptReload`），同一轮的多次建层合并成一次；编译期间又有新建的，编完再来一次。
- **能力表**：删 `createLayer`。`createModelData` / `destroyModelData` 照报，所以 `{ model: IModelData }` 走不到。

### 步骤 0（P6d3b）— 补测与夹具

- **`p6d3b-default`**：透视场景里 `createLayer()`、`createLayer({ color })` 的配置用哪个缺省模型。
- **`p6d3b-bars`**：照音频条的写法，用正交场景，`__workshopId = '123'`：
  - 模型放 `models/workshop/123/kbbar.json`，在 `init` 里 `createLayer('models/kbbar.json')` 建 8 根；
  - 每根 `sortLayer(bar, getLayerIndex(thisLayer))`，再设 `alignment` / `origin` / `scale` / `color`；
  - 材质颜色绑一个用户属性（逐实例绑定）。

  记 `enumerateLayers`、每根的下标与 `getInitialLayerConfig`；抓帧看绘制顺序与位置。
- **`p6d3b-clone`**：带两段字段脚本的模板层 T（模块级计数器、`init` / `update` 记日志），在 `init` 里克隆两次、在第 60 帧的 `update` 里再克隆一次。记：
  - `before` / `init` / `after` 的顺序；
  - 各实例的模块状态互不相干；
  - 同一帧的 `update` 顺序；
  - 克隆的 `getInitialLayerConfig`。
- **重抓 0c 的 `p6d-order`、`p6d-asset` 的 WPE 日志全文**当夹具。0c 只摘了结论；这两个工程用 `createLayer` 的各种参数形态与 `__workshopId`。
- **`p6d-frame` / `p6d-cycle`**：运行中建删，要等 P6d4 的同步实例化才能逐帧对上。这一步只核对日志里结构类的行（计数、下标、作废）。

### 步骤 0（P6d3b）实测记录（2026-11-15）

工程 `ignore/p6/d3/make_step0b.py` → `proj/p6d3b-{default,bars,clone}`。`p6d3b-bars` 拷了工坊 3304642534 的 bar 模型、材质、tint 着色器、纹理，只读工坊。日志夹具 `out/wpe-{bars,clone,default,asset,order}.log`（后两个是 0c 工程的全文），抓帧 `A:\p6d3\{bars,clone,default,asset,order}\`，画面 `out/wpe-bars.png`。

- **缺省模型**：透视场景 `createLayer()`、`createLayer(1, 2)`、`{ color }` 都是 `models/util/solidlayer.json`；正交场景是 `solidlayer_depthtest.json`（`p6d-asset` 重测同 0c）。确认宿主 `+0x90` 就是「正交」。
- **音频条写法（`p6d3b-bars`）**：
  - 新层追加在表尾、名字为空串；每次 `sortLayer(bar, thisIndex)` 后新层在 `thisIndex`、自己的下标 +1；
  - 新层的配置原文是改写后的 `{"image":"models/workshop/2652493753/bar.json"}`；
  - **`init` 里当场读到 `bar.size` 为 `{4, 4}`**（自动尺寸 = 纹理尺寸），我们编译前读不到，是已知差异；
  - 新层图层对象有 59 个自有键（P6d1 起的键集合差异）；
  - 画面：7 根新条与 SV 都是用户属性的红色（逐实例绑定生效）、底边对齐，排在 TOP 之前画。
- **克隆（`p6d3b-clone`）**：
  - A 的 `init` 里克隆，是 `before` → 新层 `T.alpha init` → `T.origin init` → `after`。同一对象内的字段脚本按登记键序（alpha 在 origin 前），新层 `init` 里读到的名字是原名 `T`、下标是表尾。
  - 原来的 T 的 `init` 在 A 的 `init` 之后才跑（条目顺序）。
  - 每个实例的模块计数器各自从头开始。
  - 第 1 帧 `update` 顺序：T、C1、C2，每个对象 alpha 在前、origin 在后。
  - 第 60 帧在 A 的 `update` 里克隆的 C3，同一帧收到第一次 `update`，排在已有条目之后。
  - 克隆的配置原文带着两段字段脚本对象、没有 `id`、键按字典序。
- **数组参数**：
  - 正交场景 `createLayer([1])` 建出一个对象（名字空）；
  - 透视场景的 `p6d3b-default` 里，对它取 `getInitialLayerConfig` 让这段 `init` 静默中止（多半是 jsoncpp 对数组 `removeMember` 出错）。
  - 语料 0 处。我们按「建出分组节点、配置原文是这个数组」处理，`getInitialLayerConfig` 返回数组；中止不复刻，是边角差异。
- **路径不存在**的模型（`models/nothere.json`）：WPE 日志一条 `Material error … Syntax error`，层照样建出（不画）。

## 验收

- **单测**（只跑相关文件，`cd /D/Codes/kabegame`，`--config` 用大写盘符）：
  - `SceneState` 的 `sortLayer` / `markDestroy` / `flushDestroy` / `setParent` / `adoptStructure`；
  - 编译输入的结构：删掉的项不进 bundle，父覆盖后组与挂点重算；
  - 渲染侧：顺序与位置表、体积光插入、相机选择、命中顺序；
  - 运行时的 `destroyObjects`：派发顺序、摘条目、计时器、重放表；
  - API：
    - 下标表的全部行；
    - `sortLayer` 与 `destroyLayer` 的参数规则；
    - 作废后的读、写、方法与 `isObjectValid`；
    - `setParent` 的解析、`adjust` 数学、组深度报错、环；
    - `getInitialLayerConfig` 的键序与数字；
    - `registerAsset` 的作用域与重复。
- **和 WPE 逐行对照**：`p6d-tree` 与步骤 0 的两个工程，用 dev 探针或 `render_scene` 跑我们的宿主，console 输出与 WPE 日志逐行比较；绘制顺序与删除当帧用抓帧和我们的帧逐像素比。
- **变异**：按原字节还原，覆盖以下几处：
  - 排序越界不钳；
  - 删除当场生效（不等脚本阶段后）；
  - 待删不扣计数；
  - 作废后仍可读；
  - `adjust` 不反算；
  - 组深度不检查；
  - 重编译丢结构。
- **语料**：
  - 扫描的能渲染数与改前比，看 `2887099508`、`3570755196`；
  - `scriptCorpus` 前后跑全库，脚本诊断、状态与 console 逐张不变（P6d2 的工具）。
- **检查**：`deno task check -c kabegame`（cargo 那半被 dev 占用而失败时只看 vue-tsc 与 wpe-scene 的 tsc）、Prettier。
- **回归文档**：解锁的场景在预览与桌面看一眼（留给用户勾）。

## 已定（2026-11-15 用户：「同意，按推荐」）

1. **P6d3 拆成 P6d3a / P6d3b**，各自单独验收、单独提交；`getInitialLayerConfig` 与 `registerAsset` 放进 P6d3a。（推荐）
2. **改编译产物的结构变化走重编译**：组归属变化、删组、换到挂点上，在重编译完之前画面不变，晚一段生效；语料里 `setParent` 是 0 处。不选这条，就要在渲染侧增量重建组的合成 RT、`groupUpload` pass 与子树 op。（推荐重编译）
3. **P6d3b 的建层走「结构里的新建对象 + 重编译」**：
   - `init` 里建的，首帧前多编一次，画面与 WPE 相同；
   - `update` 里建的，在 P6d3b 里每建一个就重编一次（正确但慢），由 P6d4 改成同步实例化。

   这样 P6d4 的内容是：`update` 里建层的同步实例化（改键、GPU 同步加层）、首次出现的配置异步编完再画。原计划 P6d4 里的「文本层与粒子模板」不用另做，编译器本来就会编这些类型。（推荐）

## 实施记录

### P6d3a（2026-11-15）

- **执行**：在独立工作树 `ignore/p6/d1/wt`（detached `49499ddb`）里，两个 sonnet 执行代理分两段做：
  - 前一半：点 1–3、点 4 的渲染侧、点 7 的 `configs`；
  - 后一半：点 4 的宿主侧、点 5、点 6、点 7 的 API、点 8。
- **执行代理自己定的**：
  - **bundle 字段**：`SceneBundle.children` / `configs` 做成可选（手写测试 bundle 没有时按 `layers` 的 parent 现推）。
  - **未删的表**：`layerByObject` 不随删除摘掉（bundle 的静态数据，被删组的子层还指向它）。
  - **排序**：反射 pass 与粒子树的步进也按对象表顺序。
  - **`adoptStructure` 照搬父与子表**：首次加载时 `init` 里的换父落在宿主自建的脚本状态上，bundle 是 `init` 之前编的。
  - **挂点名**：整数挂点按新父挂点表的下标取名；旧挂点名先取结构里最后一条，再取编译期的配置原文。
  - **组深度失败**：也通知宿主一次（父为 null）。
  - **挂点放宽**：`resolveAttachment` 对带挂点覆盖的对象不要求父在前。
  - **新增的入口**：`SceneSounds.remove`、`CursorTracker.forget`、`SceneRenderer.forgetObjects` / `attachMatrix`。
- **我改的**：对象参数的待删规则。执行代理让 `resolveLayer` 对待删的图层对象也返回 null，同帧用对象再删就成了 `false`；0c 实测是 `true`，因为 dll 的对象分支直接取指针、不看待删。我改成对象参数不看待删（`getLayer` / `sortLayer` / `destroyLayer` / `getInitialLayerConfig` 照常认它），`setParent` 的父另外拒绝待删（exe 侧 `D[3]`），并改了相应用例。
- **合并**：`ignore/p6/d3/merge_into_main.py` 把工作树改动三方合并进主工作区（备份 `ignore/p6/d3/merge/pre1`）：
  - 32 个文件直接拷入；
  - 6 个三方合并（`host.ts`、`host.test.ts`、`render/camera.ts`、`cursor.ts`、`renderer.ts`、`scene.ts`，主工作区有别的会话没提交的改动），没有冲突。
  - 之后用 `buildSceneHost.ts` 重建 dev 宿主产物。
- **验证**：结果见回归文档「场景壁纸 P6d3a」I1–I6：
  - 逐行比：`p6d3-struct` 27/27；`p6d3-parent` 只差成环那一步；`p6d-tree` 只差 P6d1 起就有的三行；`p6d3-attach` 只差挂点与姿势。
  - 逐像素比：组内排序两阶段 0 像素不同；相机两阶段只差删组后的子层（已知差异）。
  - 语料：解锁 `2887099508`、`3570755196`，其余变化只来自去掉的四个缺口键。
  - 变异检查：12/12。
- **用户验收 `2887099508` 不通过**（缺开场镜头滑动）：
  - **原因**：`objects/52/visible` 是混淆脚本（解码工具 `ignore/p6/d3/deobf_write.mjs`，可读版 `ignore/p6/d3/out/2887/s52-read.js`），每帧用 `thisScene.getCameraTransforms()` / `setCameraTransforms()` 让相机 eye / center 跟着 52 号对象 `origin` 的关键帧走，叠加 `general.zoom` 从 3 到 1 的动画。
  - **为什么漏判**：这两个 API 在缺口表里，但语料按词法扫描是 0 处，混淆后的字符串调用扫描认不出。
  - **影响面**：全库运行时撞到没实现 API、又判为能渲染的只有这一张。
  - **WPE 对照**：抓帧 `A:\p6d3\2887\`，整帧图与我们的回放在 `ignore/p6/d3/out/2887/`。
  - **处理**：用户定为 P5（相机）的范围，已转交 `wpe p5 d/d` 会话（2026-11-15）。P6d 这边不做。
  - **点击报错**：用户又报点书时 `objects/18/visible` 的 `cursorClick` 出错。解码后是 `thisScene.getLayer("hand book").playSingleAnimation("hand turn")`，puppet 动画层 API，没实现。
    - 用户定为 P12 的范围，已转交 `wpe p12 d/d (fork)` 会话（2026-11-15）。
    - 全部脚本解码（`ignore/p6/d3/scene_missing.py`，结果 `ignore/p6/d3/out/2887/all/`）后对照缺口表，这张场景没实现的只剩它一个。
    - 2026-11-16 P12e 已实现（[phase-12e-createlayer.md](../phase12/phase-12e-createlayer.md)），用户在预览里点书确认翻页正常（回归 PE6）。
- **测试工程**：`p6d3-struct` / `p6d3-parent` / `p6d3-attach` / `p6d-tree`（清单 `ignore/p6/d3/import.json`，图片 15299–15302）用户看过后，2026-11-16 用 `projects_remove` 移除。

### P6d3b（2026-11-16）

- **执行**：同一个工作树（基点 `18dc5475`），两个 sonnet 执行代理分两段做：
  - **C**：点 9 的纯函数（`createConfig.ts`）、图层壳取值（`layerShell.ts`）、assets 名单（`assetPaths.ts`）、点 11 的脚本收集、点 12 的编译侧；
  - **D**：运行时（`addScripts`、`__workshopId`）、API（`createLayer`、待编对象、id）、宿主（`init` 里建层放弃重编、运行中建层重编）、dev 探针的两遍渲染。
- **执行代理自己定的**：
  - **`createdIds`**：建出时发的 id 整个会话保留，编进 bundle 后 `getLayerByID` 仍找得到；
  - **父的解析位置**：API 先按 JSON id 解析出父的下标，再交给宿主；
  - **`alignmentSizes`**：待编图像层也登记，否则脚本写 `alignment` 不生效；
  - **探针写入**：API 写入也进重放表（`apiWrite`），补编后 `swap` 才有可重放的写入。
- **我审阅时改的**：
  - **重编条件**：宿主只在 `init` 在跑（`runtimeTask`）时只记结构，原来是「状态不是 ready」。首帧之后、ready 之前（等视频首帧最多 2 s）的 `update` 里建的层原来会一直不编；
  - **id 进配置原文**：编译按 `object.id ?? 图层个数` 发号，不写进去就和已有图层撞号（bars 工程里 BG 是 3），重编译前后按字符串 id 查也不一致。`normalizeConfig` 去掉顶层 `id`，`getInitialLayerConfig` 不受影响。
- **对照后改的**（WPE 日志逐行比时发现）：
  - **图层 `name` 可写**（`wpe-clone`）：原来只有 getter，`c1.name = 'C1'` 在严格模式下抛错，整段 `init` 中止。现在同 effect 的 `name`：存在 API 这边、跨重编译保留；
  - **待编图像层装骨骼方法**（`wpe-bars` 的键数）：原来只看已编译的 `alignment`，少 5 个方法；
  - **缺省模型不过 RP**（`wpe-asset` 的 `arg color`）：assets 名单只收脚本里的路径字面量、查不到缺省模型，原来被改写成 `models/workshop/123/util/…`。单测之前把缺省模型放进了 `inAssets`，所以没发现；
  - **effect 键序 `name`、`visible`**（`wpe-asset` 的 `fx name write`）；
  - **删掉冗余**：`objectById` 里遍历待编对象的循环（`createdIds` 已覆盖），变异检查查出来的。
- **合并**：`merge_into_main.py` 三方合并（备份 `ignore/p6/d3/merge/pre2`）：
  - 22 个文件直接拷入，6 个三方合并；
  - 4 个冲突是 P5 会话未提交的 P5e（`getCameraTransforms` / `setCameraTransforms`、`beginScriptInit` / `finishScriptInit`），手工合并成两边都留：
    - 缺口表两边删的都删；
    - 探针在 `finishScriptInit` 后把被 `scene.json` 覆盖的相机基准写入从重放表去掉，同宿主（补编后 `swap` 重放时不复活）。这一行依赖 P5e，所以只在主工作区里，不进 P6d3b 的提交；
  - 合并后在主工作区改的（上面「对照后改的」）同步回工作树，`ignore/p6/d3/check_sync.py` 核对：工作树（HEAD + 本步）与主工作区只差这 4 个手工合并的文件。
- **验证**：结果见回归文档「场景壁纸 P6d3b」J1–J8：
  - 逐行比：clone 42/42、order 48/48；bars、asset 只差图层对象的自有键数（已编译图层同样如此）与编译前的自动尺寸；default 只差 WPE 中止的那段；
  - 逐像素比：`p6d3b-bars` 0 像素不同；
  - 语料：解锁 4 张音频条，没有新增的键；编译产物在没有结构变化时与 HEAD 逐字节相同（差别只在去掉缺口键的 14 张的 `unsupported` 及其连带的纹理解码）；
  - 变异检查：13/13；
  - 首次加载多编一次约 0.2 s。
- **留下的已知差异**：
  - 编译前读不到自动尺寸、effect、材质、骨骼；
  - 运行中建的层晚一段才画（P6d4）；
  - WPE 对数组配置取 `getInitialLayerConfig` 时中止 `init`，不复刻。
- **另记**：图层对象的自有键数 WPE 比我们多（图像层 59 / 30，普通对象 21 / 24），P6d1 起就有、和建层无关，要补得先在 WPE 里列出键名。
- **提交**：`88be89b3`（2026-11-16，用户：「可以」），在 `74cf58c6` 之上，`host.ts` 三方合并；三份共享文档只带本步的段落。
- **测试工程**：`p6d3b-bars` / `p6d3b-clone` / `p6d3b-default` / `p6d-order` / `p6d-asset`（清单 `ignore/p6/d3/import-b.json`，图片 15315–15319）用户看过 J10 后，2026-11-16 用 `projects_remove` 移除。
