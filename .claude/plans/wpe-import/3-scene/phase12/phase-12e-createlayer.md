# P12e 子计划 — 运行时建删动画层（`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`）

> 总计划：[phase-12-puppet.md](phase-12-puppet.md)。前一步：[phase-12c-script.md](phase-12c-script.md)（动画层脚本 API，待定 1 当时定为「不做建删层」）、[phase-12d-physics.md](phase-12d-physics.md)。
> 语义依据：
> - 读码：[rea-p12e-createlayer](rea-p12e-createlayer.md)（概括表、第 1–7 节、「对实现的含义」），沿用 [rea-p12c-script](rea-p12c-script.md) 第 3、5、7 节、[rea-p12-runtime](rea-p12-runtime.md) 3.1 / 6.1；
> - 实测：rea-p12e 末尾「实测」表，工程 `ignore/p12/e/proj/p12-create`（生成脚本 `ignore/p12/e/defs/p12e.py`），WPE 日志 `ignore/p12/e/logs/step0.log`（268 帧、545 行），抓帧 `A:\p12e\step0\`；
> - 作废与帧尾生效复用 P6d3a：[../phase6/phase-6d3-runtime-layers.md](../phase6/phase-6d3-runtime-layers.md) 点 4–6。
> 起因：工坊 `2887099508` 点书时 `objects/18/visible` 的 `cursorClick` 调 `thisScene.getLayer("hand book").playSingleAnimation("hand turn")`（解码见 `ignore/p6/d3/out/2887/s18-read.js` 第 291 行），`"hand turn"` 是 mdl 里没挂在任何 `animationlayers` 上的 single 动画，我们报 not a function。P6d3a 的全量解码说这张场景只剩这一个缺口。
> 现状锚点取自 HEAD `18dc5475` 的工作区（`apps/wpe-scene` 有大量别的会话没提交的改动，含 P6d3b 的 `createLayer`），动工前再核对一次共享文件。

## 总体设计思路

P12e 让脚本在运行中给 puppet 加层、删层。WPE 的做法很直接：`createAnimationLayer` 就是加载 `animationlayers` 时用的那个建层函数，外加「`config` 缺 `blendin` / `blendout` 键就补 `true`」和「按名字找动画」两步；`playSingleAnimation` 只是建完层再在时钟上置一个 `0x8000000` 位，让这一层第一次「播完」时被删掉；`destroyAnimationLayer` 当场把层从层表摘掉，等本帧全部脚本跑完才析构。我们照这个形状做：建层与删层都是 puppet 运行时（`ScenePuppets`）里的操作，参数的规整（dll 的实参转换、JSON 解析与合并、setter 的取值规则）是脚本 API 一侧的一个纯函数，宿主只负责在帧里两个固定的点调「派发」和「释放」。

这件事绕不开的前提有两个。第一，**动画要全编**：`createAnimationLayer("名字")` 能引用 mdl 里任何一条动画，而脚本调不调这三个方法在编译期认不出来（2887 的脚本是混淆的，字符串调用扫描是 0 处，P6d3a 已经在这张场景上吃过一次亏），所以每个 puppet（图像层与带骨骼的模型）的 MDLA 动画一律全部转好，`PuppetLayerDef.animation` 从此直接是 MDLA 顺序的下标。没被引用的动画如果用到我们不支持的特性，编译期不进 `unsupported`（不能因为一条可能永远不用的动画把整张场景退回），只记在这条动画上；运行时在它上面建层返回 `null` 并 `warn` 一条日志。第二，**层要有稳定身份**：P12c 的状态字段、包装对象缓存、字段脚本目标、`{user}` 绑定目标全都按「对象:层下标」找，运行中一插一删下标就漂了。P12e 给每层一个稳定 id：JSON 里的层用它在 `animationlayers` 数组里的下标（`PuppetLayerDef.entry`，编译期已有，而且这样重放表的键 `objects/<i>/animationlayers/<id>/<字段>` 恰好就是 `scene.json` 里的路径），运行时建的层用负数（每个 puppet 从 −1 起递减，不复用）。层表（顺序）另存在运行时里，「下标」只在 `getAnimationLayer(下标)`、`destroyAnimationLayer(下标)`、插入位置这几处出现。

帧里的数据流和 WPE 对齐：每个 puppet 推进时逐层采样混合（被删的单次层这一帧仍参与姿势），推进完先派发 MDLA 事件，再进播完回调循环——清 `ENDED`、单次层**先置删除位再调回调**、调过回调的层把循环下标复位成 0（`++` 后从 1 重扫，这就是实测用例 9 的漏扫），最后把带删除位的层当场删掉并作废包装，所以同一帧之后的脚本已经看到它无效。回调循环只在本帧确有层播完时才跑（WPE 的 `anyEnded`），漏扫的层带着 `ENDED` 位等到以后某一帧。脚本阶段建的层插进层表，下一帧的对象更新才第一次推进它；回调里给排在后面的 puppet 建的层，同一帧就被那个 puppet 推进——我们的 `frame` 本来就按对象顺序逐个推进再派发，写入直接落进运行时就自然一致。`destroyAnimationLayer` 把层从层表摘到一张「待释放」表里（包装这期间照常可读写、调方法，但层已不参与任何推进与混合），宿主在本帧全部脚本之后、P6d3a 的 `settleDestroyed` 之后调 `settle` 释放它们：从 id 表摘掉（包装从此作废）、删掉状态里的三方共写字段、给它的动画层字段脚本发 `destroy`、清重放表里它的项。作废沿用 P6d3a 的守卫：读字段 `undefined`、写忽略、方法返回 `undefined`、`engine.isObjectValid` 为假、作参数时转换失败。

**跨重编译用「接回」，不进编译输入。** 动画全编之后，建删层不再改变任何编译产物——层只是运行时对象（时钟、位、名字、回调表、三方共写的字段）。P6d3a 把 `destroyLayer` 放进 `SceneStructure`，是因为删对象会改整场的并集（灯、依赖、组）；动画层没有这种影响。更关键的是插入位置依赖运行时状态（`autosort` 看当时各层的加法位，脚本能改它），在编译期重演「操作序列」得不到同样的顺序；直接搬「结果」——上一份运行时的层表——才对。`ScenePuppets.carryOver` 本来就跨重编译接时钟、名字、可写位与回调表，P12e 把它从按下标改成按 id，再多接三样：层表顺序、运行时建的层（按新 bundle 里同一条动画重建）、删过的编译期层（记在每个 puppet 的 `destroyedEntries`）。`SceneState` 一侧在 `carryOver` 之后、重放脚本写入之前按运行时的层表对齐 `animationLayers`。建删层因此都不触发重编译，生效帧和 WPE 一样（P6d3b 的 `createLayer` 要晚一段，这里没有这个差异）；「清空脚本存储」时待用运行时不 `carryOver`，运行时建的层自然清掉。

**关键决策与理由**
- 动画对所有 puppet 全编（用户已定）：脚本调用在编译期认不出；代价是产物变大，实现后在语料上量体积与编译耗时（「验证」4）。没被引用、又用到不支持特性的动画不转帧数据，只留 `unsupported`（「待定」3）。
- 层 id = 编译期 `entry` / 运行时负数：编译期的 id 和 JSON 路径同形，字段脚本属主不用再回填下标；运行时 id 不和任何 JSON 下标撞（「待定」1）。
- 跨重编译走 `carryOver` 接回，不进 `SceneStructure`（「待定」2）。
- 参数规整做成纯函数 `script/animationLayerConfig.ts`（同 P6d3b 的 `script/createConfig.ts`），插入规则留在运行时（它要看当前各层的加法位）。
- 有意不同：图像层按名字删时，原层表最后一层匹配会让 WPE 崩溃（缓存了旧的 `end`、`memmove` 长度 −8）；我们照常删掉所有同名层（相邻同名都删，实测 8）。模型对象与图像层同一套代码。`addEndedCallback(非函数)` 抛 `TypeError` 是 P12c 已定的有意不同，保持。

## 步骤 0 结论（2026-11-16，读码与实测已完成）

读码见 rea-p12e 概括表 1–7，实测 1–4、6–9 全部和读码一致（WPE 全程没崩），这里只列对计划有影响的几条：
1. **参数**：两个参数的形参类型都是 `0x600`（字符串 | 对象），数字、布尔、`null`、`undefined`、缺参数都变成空串。第一参字符串按 MDLA 顺序逐字节找第一个同名动画（区分大小写），记录 id 为 0 也返回 `null`；对象第一参 `JSON.stringify` 后当作一项 `animationlayers`，`animation` 必须是数字（`900.5` 取整、`'900'` 为 `null`）。
2. **`config`**：缺 `blendin` 键补 `true`、缺 `blendout` 键补 `true`；对象路径里 `config` 的键覆盖第一参对象的同名键，所以第一参里的 `blendin: false` 总被盖掉。setter 只收 JSON 数（float）/ JSON 布尔（bool）/ JSON 字符串（`name`）：`rate: NaN`、`'3'`、`blend: true`、`visible: 0`、`additive: 'yes'`、`name: 5` 都不写。非 single 动画随后清 `blendout`。
3. **插入**：`index: 0` 插 0、`index: 2` 插 2，`-3` 与 `999` 插在最后一层之前；`autosort: true` 插在末尾的连续加法层之前；都没有就追加。
4. **生效帧**：`update` 里建的层当帧 `getFrame()` 0，下一帧 = 下一帧的 `dt × fps`。
5. **单次层**：single 到头、loop 第一次回绕、mirror 第一次换向那一帧调回调（层有效、计数未减、0 个参数），同一帧 `update` 里已作废、计数已减；隐藏的不推进永不删，暂停的不删，回调里 `play()` + `setFrame(0)` 救不回，没有回调也照删。
6. **删层**：下标 / 对象删当场摘表、同一帧旧包装可读、下一帧作废；`-1`、`99`、`1.5`、`''`、`'zzz'`、`{}`、已作废的包装、`null`、`'1'`、同帧再删同一对象都是 `false`；按名字删所有同名（相邻两个 `x` 都删）。
7. **回调循环**：A 的回调里删 A，B 的回调本轮漏掉，下一次有层回绕（4 s）才调，之后每 2 s；不删时 A、B 每次同帧都调。
8. **蒙皮**：删光（或剩下的都隐藏）走「没有可见层」分支取静止来源矩阵；骨骼透明度与变形每帧复位，`g_BlendMap` 帧首不复位、保持删层前最后的值。这些现有代码已经是这样，不用改。

## 现状锚点

**a. 编译期只转被引用的动画，`PuppetLayerDef.animation` 指向「用到的动画」列表**（`compile/puppet.ts:466`–`487`、`:618`–`631`）
```ts
  for (const [entryIndex, entry] of (Array.isArray(layers) ? layers : []).entries()) {
    // …
    const id = Math.trunc(json.animation);
    const index = file.animations.findIndex((animation) => animation.id === id);
    if (index < 0) continue;
    let slot = used.indexOf(index);
    if (slot < 0) slot = used.push(index) - 1;   // 现状：defs[i].animation 是 used 里的下标，不是 MDLA 下标
    // …
    defs.push({
      animation: slot,
      entry: entryIndex,                          // 现状：JSON 下标，只给字段脚本回填用
      // …
// buildPuppet
    animations: used.map((index) => {            // 现状：没被 animationlayers 引用的动画不转，脚本按名字建层找不到
      const converted = convertAnimation(file.animations[index], file, bones.length, skinned, withAlpha, morph?.targets ?? 0);
```

**b. 每条动画的不支持特性只对「用到的」查，查到就进 `unsupported`**（`compile/puppet.ts:520`–`524`、`:574`–`581`、`:916`–`923`）
```ts
  for (const index of used) {
    const animation = file.animations[index];
    if (animation.unsupported) issues.add("puppet:animation-ref");
    if (animation.tracks.length !== skeleton.bones.length) issues.add("mdl:animation:tracks");
  }
// buildPuppet（图像层）
    for (const index of used) {
      const animation = file.animations[index];
      if (animation.boneAlpha && !(mesh.flags & 4)) issues.add("puppet:alpha-track");
      if (animation.drawOrderTrack) issues.add(mesh.flags & 8 ? "puppet:draw-order" : "puppet:order-track");
    }
// buildModelSkeleton（模型）
    used.some((index) => file.animations[index].flags & 0x1f800)   // 现状：model:rootmotion 也只看用到的
```
`mdl:animation-id`（任一动画 id ≥ 2³²）本来就对全部动画查（`:554`、`:911`），不受影响。

**c. 字段脚本的属主先填 `layer: -1`，bundle 编完 puppet 再按 `entry` 回填成层下标**（`compile/scripts.ts:270`、`:288`；`compile/bundle.ts:3096`–`3104`）
```ts
                ? { kind: "animation-layer" as const, object: layer!, entry: index, layer: -1 }
// bundle.ts
  scripts.list = scripts.list.filter((script) => {
    const owner = script.owner;
    if (owner.kind !== "animation-layer") return true;
    const slot = animationLayerDefs.get(owner.object)?.findIndex((def) => def.entry === owner.entry) ?? -1;
    if (slot < 0) return false;
    owner.layer = slot;                                                        // 现状：目标按层下标
    if (script.target.kind === "animation-layer") script.target.layer = slot;
    return true;
  });
```

**d. `{user}` 绑定目标与状态初值都按层下标**（`compile/bundle.ts:2470`–`2477`、`:1895`–`1902`；`render/state.ts:555`–`562`）
```ts
          for (const [slot, def] of built.puppet.layers.entries())
            for (const { field, property, condition } of def.bindings)
              bindings.list.push({ property, /* … */ target: { kind: "animation-layer", object: index, layer: slot, field } });
// state.ts fromBundle
      (layer.puppet ?? layer.model?.skeleton)?.layers.forEach((def, slot) =>
        state.animationLayers.set(animationLayerKey(layer.object, slot), { rate: def.rate, blend: def.blend, visible: def.visible }),
      );   // 现状：只有加载时的层；没有增删入口
```

**e. 运行时的层是一个按下标访问的定长数组**（`puppet/player.ts:216`–`222`、`:388`–`407`、`:566`–`584`）
```ts
interface PuppetRuntime {
  // …
  readonly layers: LayerRuntime[];        // 现状：构造后不增不删，下标即身份
// constructor
      const layers = puppet.layers.map((def): LayerRuntime => { /* 时钟、flags、name、callbacks … */ });
// 控制口与查找都按下标
  layer(object: number, index: number): PuppetLayerControl | null {
    const layer = this.byObject.get(object)?.layers[index];
    // …
  findLayer(object: number, name: string): number {   // 现状：返回下标
```
`PuppetSink.animationLayer(object, layer)` 与 `animationLayerKey(object, layer)`（`:76`、`:113`）的 `layer` 也是下标。

**f. 派发：每帧扫全部 `ENDED` 层，不看本帧有没有层播完，不复位下标、不删层**（`puppet/player.ts:554`–`564`）
```ts
  private dispatch(runtime: PuppetRuntime, hooks: PuppetHooks | null): void {
    if (runtime.events.length) {
      const events = runtime.events.splice(0);
      if (hooks?.event) for (const event of events) hooks.event(runtime.object, event.json);
    }
    for (const layer of runtime.layers) {   // 现状：for…of，回调里改层表会乱；没有 anyEnded 门、没有 i = 0、没有删除位
      if (!(layer.clock.flags & ENDED)) continue;
      layer.clock.flags = (layer.clock.flags & ~ENDED) >>> 0;
      for (const callback of [...layer.callbacks]) callback();
    }
  }
```
播完检测本身（`evaluate` 的 `:780`–`791`）已经照 rea-p12-runtime 3.1：暂停 / 已结束 / `SETFRAME` 那一帧不判，隐藏的层整层跳过。

**g. `carryOver` 按下标接回，只拷部分时钟位**（`puppet/player.ts:684`–`700`）
```ts
      runtime.layers.forEach((layer, index) => {
        const old = before.layers[index];   // 现状：按下标配对；运行时建的层、删过的层都无从谈起
        // …
        a.flags = ((a.flags & ~(PAUSED | DONE | BACK | SETFRAME)) | (b.flags & (PAUSED | DONE | BACK | SETFRAME))) >>> 0;
        // … name、blendtime、callbacks、三个可写位
      });
```

**h. 包装按「对象:层下标」缓存；成员不过作废守卫；只读三项是数据属性**（`script/api.ts:1325`–`1347`、`:1377`–`1379`、`:1407`–`1422`）
```ts
  private animationLayerApi(object: number, index: number): ApiObject | null {
    const key = `${object}:${index}`;                         // 现状：下标作键
    // …
    const fields = () => this.access.state().animationLayers.get(animationLayerKey(object, index));
    const constant = (name: string, value: unknown) =>
      Obj.defineProperty(api, name, { value, enumerable: true, writable: false, configurable: false });   // 现状：作废后仍读出数
    const method = (name: string, run: (...args: unknown[]) => unknown) =>
      Obj.defineProperty(api, name, { value: run, enumerable: true, writable: true, configurable: true }); // 现状：不看作废
    // …
    constant("duration", first.duration);
    constant("frameCount", first.frameCount);
    constant("fps", first.fps);
```
字段用的 `this.define` 带 P6d3a 的 `dead()` 守卫，但包装没登记进 `ownerOf`（`:837`–`845`），所以守卫对它永远放行。

**i. `isObjectValid` 不认动画层包装**（`script/api.ts:1009`–`1025`）
```ts
      (value: unknown) =>
        [...this.layers.entries()].some(([index, layer]) => layer === value && !!this.findLayer(index) && this.alive(index)) ||
        value === this.general ||
        // … materials、effects；现状：IAnimationLayer 一律 false（实测 WPE 对活着的层是 true）
```

**j. 图层上只有查询两个方法，三个建删方法在缺口表里**（`script/api.ts:1300`–`1310`；`compile/scriptApi.ts:111`–`115`）
```ts
  private installAnimationLayers(api: ApiObject, object: number): void {
    this.method(api, "getAnimationLayerCount", () => this.puppetView(object).count());
    this.method(api, "getAnimationLayer", (x?: unknown) => { /* 下标或名字 → animationLayerApi(object, index) */ });
  }
// scriptApi.ts
    ...methods(
      "any",
      ["getTextureAnimation", "createAnimationLayer", "playSingleAnimation", "destroyAnimationLayer"],   // 现状：用到就整张退回
      UNIQUE,
    ),
```

**k. 宿主：帧里推进 puppet 只给事件钩子；脚本之后只结算对象的删除；换场景时 `carryOver` 后直接 `refresh`**（`host.ts:1432`–`1440`、`:1455` 一带、`:1774`–`1782`、`:1814`）
```ts
      stepPuppets: (dt) => {
        const drawn = this.drawnState;
        if (drawn)
          this.scenePuppets?.frame(dt, stateSink(drawn), {
            event: (object, json) => this.runtime?.animationEvent(object, json),   // 现状：没有 released 钩子
          });
      },
// beforeFrame
          this.runtime?.frame(dt);
          settleDestroyed(this.scriptState, { /* … */ });   // 现状：之后没有动画层的释放
// beforeFirstFrame
          if (this.scriptState && this.scriptState !== state) state.adoptStructure(this.scriptState);
          this.pendingPuppets = null;
          if (!pendingPuppets) puppets.carryOver(this.scenePuppets ?? stalePuppets?.puppets ?? null);
          puppets.refresh(stateSink(state));   // 现状：状态的动画层字段不随运行时的层表对齐
// …（:1814）
          this.runtime?.replayWrites();
```

**l. 脚本运行时只按对象发 `destroy`**（`script/runtime.ts:749`–`770`）
```ts
  destroyObjects(objects: ReadonlySet<number>): void {
    const owned = (record: ScriptRecord): boolean => {
      const object = scriptObject(record.script.owner);
      return object !== null && objects.has(object);   // 现状：单独删一个动画层时没有对应入口
    };
```

## 点 1 — 编译期：动画全编、不支持的动画只记不报、层 id = `entry`（`compile/puppet.ts`、`compile/scripts.ts`、`compile/bundle.ts`）

- **新增**
  - `PuppetAnimation.unsupported?: string[]`：
    ```ts
    /**
     * 这条动画用到、我们还不支持的用法（P12e）：键同编译期的细分键（`puppet:animation-ref`、`mdl:animation:tracks`、`puppet:alpha-track`、
     * `puppet:draw-order` / `puppet:order-track`、`model:rootmotion`）。被 `animationlayers` 引用的动画照旧报进 `unsupported`；没被引用的只记在这里，
     * 不转帧数据（`frames` / `alpha` / `morph` / `channels` / `meshMorph` 为空），运行时在它上面建层返回 null 并 warn。没有时不写这个键（bundle 字节同以前）。
     */
    unsupported?: string[];
    ```
  - `animationIssues(animation, file, ctx): string[]`：把 `skeletonIssues` 里逐动画的两条、`buildPuppet` 里逐动画的两条、`buildModelSkeleton` 的 `rootmotion` 收成一个函数，图像层与模型各按自己的规则（模型不查透明度 / 绘制顺序轨道，同现状）。
    ```ts
    /** 一条动画的不支持用法（P12e 从 skeletonIssues / buildPuppet / buildModelSkeleton 抽出，规则不变）。 */
    function animationIssues(
      animation: MdlAnimation,
      ctx: { bones: number; model: boolean; meshFlags: number; rootmotion: boolean },
    ): string[] {
      const out: string[] = [];
      if (animation.unsupported) out.push("puppet:animation-ref");
      if (animation.tracks.length !== ctx.bones) out.push("mdl:animation:tracks");
      if (!ctx.model) {
        if (animation.boneAlpha && !(ctx.meshFlags & 4)) out.push("puppet:alpha-track");
        if (animation.drawOrderTrack) out.push(ctx.meshFlags & 8 ? "puppet:draw-order" : "puppet:order-track");
      } else if (ctx.rootmotion && animation.flags & 0x1f800) out.push("model:rootmotion");
      return out;
    }
    ```
- **修改**
  - `layerDefs`：`defs[i].animation` 改成 MDLA 下标（`index`），`used` 仍返回（只用来决定哪些动画的问题报进 `issues`）。
    ```ts
    defs.push({
      animation: index,       // 修改：MDLA 顺序的下标（ScenePuppet.animations 全编后两者一致）
      entry: entryIndex,      // 注释改：也是这一层的 id（P12e，层 id = JSON 下标）
      // …
    ```
  - `buildPuppet` / `buildModelSkeleton`：`animations` 改成对 `file.animations` 全量 map；每条先算 `animationIssues`，被引用的并进 `issues`（同现状），没被引用的有问题就只写 `unsupported`、跳过 `convertAnimation`。只在 `skinned`（图像层）/ 有骨骼（模型）时全编，静态 puppet 同现状不转帧数据。
    ```ts
    const usedSet = new Set(used);
    animations: file.animations.map((animation, index) => {
      const problems = skinned ? animationIssues(animation, ctx) : [];
      if (usedSet.has(index)) for (const key of problems) issues.add(key);   // 被引用的：照旧报
      else if (problems.length) return stubAnimation(animation, problems);  // 新增：没被引用又不支持的，只留名字、id、模式、fps、长度、事件与 unsupported
      const converted = convertAnimation(animation, file, bones.length, skinned, withAlpha, morph?.targets ?? 0);
      // … channels 同现状
      return converted;
    }),
    ```
  - `skeletonIssues`：只留骨骼本身的检查（物理、IK、额外段），逐动画的两条移进 `animationIssues`。
  - `compile/scripts.ts`：动画层属主收集时直接填 `layer: index`（= `entry`，即层 id），不再填 −1。
  - `compile/bundle.ts`：
    - 两处 `{user}` 绑定目标的 `layer: slot` 改成 `layer: def.entry`；
    - 字段脚本的过滤只保留「这一项建出来了」的判断（`defs.some((def) => def.entry === owner.entry)`），删掉回填 `owner.layer` / `target.layer` 的两行；
    - `animationLayerDefs` 的注释同步。
  - `compile/bindings.ts:257` 与 `compile/scripts.ts:33` 的注释：`layer` 是层 id（编译期 = JSON 下标），不再是 `ScenePuppet.layers` 的下标。字段名不改（少动别人的行）。
- **不变**：`mdl:animation-id` 仍对全部动画查。被引用动画的报键集合逐张不变（「验证」4 的语料对照）。

## 点 2 — 运行时：层表按 id、建层、单次层、删层、派发、接回（`puppet/player.ts`）

- **新增**
  ```ts
  /** playSingleAnimation 的层（P12e，WPE `K.flags` 同位，`0x14020ef67`）：第一次播完时先置 DOOMED 再调回调。 */
  export const SINGLE_SHOT = 0x08000000;
  /** 本帧回调循环之后当场删除（WPE `0x10000000`，`0x140200371`）。play / setFrame / stop 都不清它（stop 的掩码 0x3fffffff 保留它）。 */
  export const DOOMED = 0x10000000;

  /** 运行时建层的规整结果（P12e，`script/animationLayerConfig.ts` 产出）：字段已按 WPE 的 JSON setter 取值。 */
  export interface AnimationLayerItem {
    /** `ScenePuppet.animations` 的下标（= MDLA 下标）。 */
    animation: number;
    name: string;
    rate: number;
    blend: number;
    visible: boolean;
    additive: boolean;
    blendin: boolean;
    blendout: boolean;
    blendtime: number;
    /** `config.autosort` 是 JSON `true`（`1`、`"true"` 都不算，rea-p12c 第 7 节）。 */
    autosort: boolean;
    /** `config.index` 是 JSON 数时的 `asInt`（向零取整）；不是数为 null。 */
    index: number | null;
  }
  ```
  - `LayerRuntime.id: number`：编译期的层 = `def.entry`，运行时建的 = 负数。运行时建的层的 `def` 是按 `AnimationLayerItem` 合成的 `PuppetLayerDef`（`entry = id`、`bindings: []`），`PuppetSink` 取不到状态时照旧回落到 `def`。
  - `PuppetRuntime` 加：
    ```ts
    /** 层表（顺序 = 采样混合顺序 = getAnimationLayer 的下标）。建删层原地改这个数组（splice），不换引用：回调循环在遍历它。 */
    layers: LayerRuntime[];
    /** 全部活着的层，按 id（含已从层表摘出、还没 settle 的：同一帧包装照常可用）。 */
    readonly byId: Map<number, LayerRuntime>;
    /** destroyAnimationLayer 摘出的层，`settle` 在脚本之后释放（WPE 的 `ctx+0x1478`）。 */
    readonly detached: LayerRuntime[];
    /** 删过的编译期层的 id（接回时不再建它们，跨重编译保留）。 */
    readonly destroyedEntries: Set<number>;
    /** 下一个运行时层 id（−1 起递减，接回时保留，不复用）。 */
    nextId: number;
    /** 本帧推进时有层播完（WPE 的 anyEnded）：只有它为真时才进回调与删层循环。 */
    anyEnded: boolean;
    ```
  - `PuppetHooks.released?(object, id)`：
    ```ts
    /**
     * 一层被释放（P12e）：单次层在派发里被删、或 `settle` 释放 destroyAnimationLayer 摘出的层。宿主删 SceneState 的三方共写字段、
     * 给它的动画层字段脚本发 destroy、去掉重放表里它的项。之后包装作废（`alive` 为假）。
     */
    released?(object: number, id: number): void;
    ```
  - `ScenePuppets` 的新方法：
    ```ts
    /** 层表的 id（顺序）；不是带骨骼的运行时为空数组。 */
    ids(object: number): readonly number[];
    /** 控制口（按 id，含摘出未释放的）；没有这个 id 为 null。 */
    control(object: number, id: number): PuppetLayerControl | null;
    /** 这个 id 的层还没被释放（包装是否有效）。 */
    alive(object: number, id: number): boolean;
    /** 按当前名字找，最后一个匹配，空串不匹配；返回 id，找不到 null（P12c 的规则不变，只是返回 id）。 */
    findLayer(object: number, name: string): number | null;
    /** 运行时的 rig（API 按名字找动画、查 unsupported 用；同一份 bundle）。 */
    rig(object: number): PuppetRig | null;
    /**
     * 运行时建层（WPE `FUN_1401fcc20` / 模型 `FUN_1402230c0` 的后半，rea-p12e 2.1）。不是带骨骼的运行时、动画下标越界返回 null（API 先挡掉不支持的动画）。
     * - 时钟按动画自己的模式（`layerClock`，带事件表），t = 0、在播放，没有 SETFRAME；`single` 为真（playSingleAnimation）时置 SINGLE_SHOT；
     * - 非 single 的动画清 blendout（`0x1401fd068`）；
     * - 插入（rea-p12c 第 7 节，实测 4）：autosort → 从尾往前跳过加法层，插在第一个非加法层之后；一个非加法层都没有（含空表）WPE 越界写，我们插到 0（有意不同）。
     *   index → 0 插 0；`1 ≤ index ≤ n − 1` 插 index；其余（负数、≥ n − 1、超出 int）插 n − 1（最后一层之前）；空表一律插 0（WPE 对非 0 越界，有意不同）。都没有 → 追加。
     * 插进层表就参与顺序相关的一切；分配 id = nextId--。
     */
    createLayer(object: number, item: AnimationLayerItem, single: boolean): number | null;
    /**
     * destroyAnimationLayer（rea-p12e 第 5 节）：`selector` 已由 API 规整。命中的层当场从层表摘掉（计数、下标、名字查找立刻看不到），进 `detached`、
     * 仍在 `byId`；编译期层的 id 记进 `destroyedEntries`。名字删全部同名（区分大小写；图像层 WPE 在最后一层匹配时崩溃，我们照删，有意不同）；
     * 下标要 `0 ≤ i < 层数`；id 要在当前层表里（摘出未释放的、别的 puppet 的都不算）。返回是否删了至少一个。
     */
    destroyLayers(object: number, selector: { name: string } | { index: number } | { id: number }): boolean;
    /** 释放全部 `detached`（WPE `FUN_14018b390` 尾调排空 `ctx+0x1478`）：全部脚本之后、渲染之前每帧调；逐个 `release`。 */
    settle(hooks?: PuppetHooks | null): void;
    ```
- **修改**
  - 构造：`layers` 由 `puppet.layers` 建，`id = def.entry`，同时填 `byId`；`nextId = -1`。
  - `evaluate`：`state?.animationLayer(runtime.object, layer.id)`（原来是 `index`）；播完检测成立时另置 `runtime.anyEnded = true`。`updateBounds` 同样按 id 读。
  - `dispatch`：
    ```ts
    private dispatch(runtime: PuppetRuntime, hooks: PuppetHooks | null): void {
      if (runtime.events.length) { /* 不变 */ }
      if (!runtime.anyEnded) return;                // 新增：本帧没有层播完不进循环（漏扫的层带着 ENDED 等以后某帧，实测 9）
      runtime.anyEnded = false;
      const layers = runtime.layers;
      for (let i = 0; i < layers.length; i++) {      // 修改：下标循环、每轮重读层数（回调里会建删层）
        const layer = layers[i];
        const clock = layer.clock;
        if (!(clock.flags & ENDED)) continue;
        clock.flags = (clock.flags & ~ENDED) >>> 0;
        if (clock.flags & SINGLE_SHOT) clock.flags = (clock.flags | DOOMED) >>> 0;   // 新增：先标删再调回调（回调里 play / setFrame 救不回）
        if (layer.callbacks.length) {
          for (const callback of [...layer.callbacks]) callback();
          i = 0;                                     // 新增：照 WPE 复位（`0x1402002f6` / 模型 `0x14021ce69`），++ 后从 1 重扫
        }
      }
      for (let i = 0; i < layers.length; i++)        // 新增：删 DOOMED 的层，当场释放（同一帧之后的脚本看到作废）
        if (layers[i].clock.flags & DOOMED) this.release(runtime, layers.splice(i--, 1)[0], hooks);
    }
    ```
    回调里 `destroyAnimationLayer(这层)` 时层已经摘出层表、进了 `detached`，删除循环看不到它，由 `settle` 释放一次，不会重复释放。
  - `release(runtime, layer, hooks)`（私有，新增）：`byId.delete(id)`、`control = null`、调 `hooks.released`。
  - `carryOver`：
    ```ts
    // 层表按 id 接回（P12e）：新表的顺序 = 上一份层表的顺序
    const fresh = new Map(runtime.layers.map((layer) => [layer.id, layer]));
    const table: LayerRuntime[] = [];
    for (const old of before.layers) {
      // 编译期层：新 bundle 里同 id 的；运行时层：按新 rig 里同一条动画（MDLA id 相同）重建，fps / 长度 / 模式变了就丢掉
      const layer = old.id >= 0 ? fresh.get(old.id) : this.rebuild(runtime, old);
      if (!layer) continue;
      adopt(layer, old);   // 修改：时钟 t 与整份 clock.flags（模式位相同时）、三个可写位、name、blendtime、回调表（同一个数组）
      table.push(layer);
      fresh.delete(old.id);
    }
    for (const id of before.destroyedEntries) {      // 新增：删过的编译期层不回来
      fresh.delete(id);
      runtime.destroyedEntries.add(id);
    }
    for (const layer of fresh.values()) table.push(layer);   // 上一份没有的编译期层（新 bundle 才有）按 bundle 顺序追加
    runtime.layers.splice(0, runtime.layers.length, ...table);
    // byId 按 table 重建；nextId = before.nextId
    ```
    - `clock.flags` 改成整份拷（模式位已比过相等），这样 `SINGLE_SHOT` / `DOOMED` / 漏扫留下的 `ENDED` 也接得上；原来的掩码是它的子集。
    - `detached`：换场景发生在帧与帧之间（`beforeFirstFrame`），上一帧的 `settle` 已跑过，按理为空；执行时核对，不空就照接（带进新 `detached`）。
  - `seek`（dev 探针定位）：遍历 `layers` 不变，按 `layer.def` 定位；运行时层同样处理。
- **删除**
  - `layer(object, index)` 与返回下标的 `findLayer`：调用方（`script/api.ts`、`host.ts` 的视图与 `puppetProbe`、`dev/probeScripts.ts`、测试）改用 `ids` / `control` / 返回 id 的 `findLayer`。
- **蒙皮不改**：层表空或全隐藏时已有「直接取静止来源矩阵」的分支，骨骼透明度 / 变形每帧复位，`g_BlendMap` 不复位（rea-p12e 第 6 节）。

## 点 3 — 状态：`SceneState.animationLayers` 按 id，增删与对齐（`render/state.ts`）

- **修改**
  - `fromBundle`：`animationLayerKey(layer.object, def.entry)`（原来是 `slot`）。`animationLayerKey` 的参数名与注释改成 id。
  - `write` 的 `animation-layer` 分支不改代码：键里的 `target.layer` 现在是 id，取不到（层已释放、删过的编译期层）就是空操作。
- **新增**
  ```ts
  /** 运行时建层（P12e）：写进三方共写字段的起始值（API 规整后的 rate / blend / visible）。 */
  addAnimationLayer(object: number, id: number, fields: PuppetLayerFields): void;
  /** 层释放（P12e）：删掉这一项；之后用户属性、脚本写入、重放对它都是空操作。 */
  removeAnimationLayer(object: number, id: number): void;
  /**
   * 重编译 / 换场景后按 puppet 运行时的层表对齐（P12e）：在 `puppets.carryOver` 之后、重放脚本写入之前调。运行时有、本状态没有的项（运行时建的层）
   * 从 `previous` 拷，`previous` 也没有就取层定义；本状态有、运行时没有的项（删过的编译期层）删掉。
   */
  syncAnimationLayers(layers: Iterable<{ object: number; id: number; def: PuppetLayerFields }>, previous: SceneState | null): void;
  ```
  `ScenePuppets` 给一个只读的遍历入口（`liveLayers(): Iterable<{ object; id; def }>`，含 `detached`）供它用。

## 点 4 — 脚本 API（新 `script/animationLayerConfig.ts`、`script/api.ts`、`compile/scriptApi.ts`）

- **新增**：纯函数模块 `script/animationLayerConfig.ts`（同 P6d3b 的 `createConfig.ts` 的写法）。
  ```ts
  /** dll 方法桩形参 0x600 的转换（rea-p12e 第 1 节）：字符串原样（按 C 串在第一个 NUL 处截断）；对象（含数组、函数）经 realm 的 JSON.stringify，
   *  得到 undefined 或抛错（循环引用、BigInt）为空串；其余（数字、布尔、null、undefined、缺参数）为空串。 */
  export function stubText(value: unknown, json: RealmJson): { text: string; kind: "string" | "object" | "empty" };

  /**
   * createAnimationLayer / playSingleAnimation 的参数规整（rea-p12e 第 2 节，实测 2、3）。返回 null 时 JS 得到 null；`warn` 是要记的一条日志。
   * 1. 第一参转换后为空串 → null；
   * 2. config：字符串按 JSON 文本解析、对象 stringify 后解析；解析失败或空串 → {}；解析成非对象（数、串、数组：WPE 未定义行为，语料 0）→ null + warn（有意不同）；
   * 3. 缺 `blendin` 键补 true、缺 `blendout` 键补 true（只看键在不在，值是 false / null 也不补）；
   * 4. 字符串第一参：在 `animations`（MDLA 顺序）里找第一个同名（区分大小写），找不到或它的 id 为 0 → null；item = { ...config, animation: id }（覆盖 config 里的 animation），
   *    之后按 id 再找第一条（同建层函数，两条动画 id 相同时可能不是按名字找到的那条）；
   * 5. 对象第一参：解析成非对象 → null；Object.assign(item, config)（config 覆盖第一参）；`animation` 不是 JSON 数、为负、≥ 2⁶⁴ → null，否则向零取整按 id 找第一条，找不到 → null；
   * 6. 找到的动画带 `unsupported` → null + warn（P12e：没被引用的动画用了不支持的特性）；
   * 7. 字段按 JSON setter：float（rate / blend / blendtime）只收 JSON 数（转 f32），bool（visible / additive / blendin / blendout）只收 JSON 布尔，
   *    name 只收 JSON 字符串；值是对象时取它的 `value` 按同样规则（带 `user` / `script` / `animation` 键时不登记绑定，warn 一次，「待定」7）；
   *    缺省 rate 1、blend 1、visible true、additive false、blendin false、blendout false、blendtime 0.5、name ""；
   * 8. autosort / index 照 `AnimationLayerItem` 的注释取；`id` 键忽略（WPE 只影响它的对象 id 计数器，已知差异）。
   */
  export function animationLayerItem(
    first: unknown,
    config: unknown,
    animations: readonly Pick<PuppetAnimation, "id" | "name" | "unsupported">[],
    json: RealmJson,
  ): { item: AnimationLayerItem | null; warn?: string };
  ```
- **修改**（`script/api.ts`）
  - `PuppetLayersView` 改成按 id：
    ```ts
    export interface PuppetLayersView {
      /** 层表的 id（顺序）。 */
      ids(): readonly number[];
      /** 按当前名字，最后一个匹配，空串不匹配；返回 id，找不到 null。 */
      find(name: string): number | null;
      control(id: number): PuppetLayerControl | null;
      /** 包装还有效（层没被释放）。 */
      alive(id: number): boolean;
      /** 新增（P12e）：运行时建层；`animations()` 给规整用的动画表（同一份 rig）。语料诊断的替身视图不给，三个方法返回 null / false。 */
      animations?(): readonly PuppetAnimation[];
      create?(item: AnimationLayerItem, single: boolean): number | null;
      destroy?(selector: { name: string } | { index: number } | { id: number }): boolean;
      // 骨骼方法（P12d-2）不变
    }
    ```
    没有宿主视图时的替身（`puppetView` / `fallbackControl`）同样按 id（编译期层的 `entry`），不支持建删。
  - 包装：缓存键改 `${object}:${id}`；新登记表 `animationLayerOf: WeakMap<ApiObject, { object: number; id: number }>`，`dead()` 先看 `ownerOf`，再看它：所属对象已删、或 `puppetView(object).alive(id)` 为假，都算作废。
    - 只读三项 `duration` / `frameCount` / `fps` 改成只有 getter 的访问器（`this.define` 不给 setter）：严格模式赋值照样抛 `TypeError`（rea-p12c 说 WPE 是「没有 setter」），作废后读 `undefined`（「待定」5）。值在建对象时取一次，同现状。
    - 方法（`play` … `getFrame`、`addEndedCallback`）仍是数据属性（成员顺序与描述符同 P12c），但值包一层守卫：作废时直接返回 `undefined`、不抛错（所以作废后 `addEndedCallback(非函数)` 也不抛，同 WPE「方法不调」）。
    - `getAnimation` 的属主路径用 id（`objects/<i>/animationlayers/<id>`；运行时层的负数路径找不到任何关键帧动画，返回 `undefined`）。
  - `installAnimationLayers`（所有图层都装，同 P12c 的 `getAnimationLayer`；不是带骨骼的运行时：建层 `null`、删层 `false`）：
    ```ts
    this.method(api, "getAnimationLayer", (x?: unknown) => {
      // 修改：下标 → ids()[x]，名字 → find(x)；拿到 id 再取包装
    });
    // 新增（P12e）
    this.method(api, "createAnimationLayer", (first?: unknown, config?: unknown) => this.createAnimationLayer(object, first, config, false));
    this.method(api, "playSingleAnimation", (first?: unknown, config?: unknown) => this.createAnimationLayer(object, first, config, true));
    this.method(api, "destroyAnimationLayer", (x?: unknown) => {
      // dll 形参 0xa08：字符串 → 名字（空串 false）；Int32（整数、在 int32 范围、不是 −0）→ 下标；有效的动画层包装 → 它的 id；
      // 包装属于别的对象 → false（WPE 按指针在本层表里找不到；层 id 是每个 puppet 各自的，entry 0 两边都有，不能把别人的 id 传给本层表）；
      // 其余（1.5、{}、作废的包装、null、缺参数）→ false
      return view.destroy?.(selector) ?? false;
    });
    ```
  - `createAnimationLayer(object, first, config, single)`（私有，新增）：取视图；没有 `create`（替身视图、静态 puppet、不是 puppet）→ `null`（静态 puppet 另 warn，「待定」6）；`animationLayerItem(…, view.animations(), realm 的 JSON)`，有 `warn` 经 `access.warn` 记；item 为 null → `null`；`view.create(item, single)` 得 id；`access.state().addAnimationLayer(object, id, { rate, blend, visible })`；返回 `animationLayerApi(object, id)`（之后 `getAnimationLayer(count − 1)` 拿到同一个对象）。
  - `engine.isObjectValid`：加一支——值在 `animationLayerOf` 里且 `!dead(value)` 为真（实测活着的层是 `true`）。
  - `owner()` 的 `animation-layer` 分支：`animationLayerApi(owner.object, owner.layer)` 不改代码，`owner.layer` 现在是 id。
- **修改**（`compile/scriptApi.ts`）：缺口表删掉 `createAnimationLayer`、`playSingleAnimation`、`destroyAnimationLayer`，只剩 `getTextureAnimation`；注释写「P12e 已实现」。`api.test.ts` 的双向核对跟着过。

## 点 5 — 脚本运行时：动画层的 `destroy` 与重放表（`script/runtime.ts`）

- **新增**
  ```ts
  /**
   * 一个动画层被释放（P12e，WPE 析构链 `FUN_140176f70(…, AL, 0)`）：属主是这个层的字段脚本（owner `animation-layer`、object 与 layer 都相同）先收 destroy
   * （已 init、导出了才调），再从 records / byId 摘掉，计时器去掉；重放表里 `objects/<o>/animationlayers/<id>/` 开头的项去掉。
   * 运行时建的层没有字段脚本（config 里的 `{script}` 不登记，「待定」7），只清重放表。
   */
  destroyAnimationLayer(object: number, id: number): void;
  ```
  和 `destroyObjects` 共用「摘条目、去计时器」的那一段（抽成私有 `dropRecords(predicate)`），不复制一份。

## 点 6 — 宿主与探针接线（`host.ts`、`dev/probeScripts.ts`、`dev/particleCorners.ts`、`dev/probe.ts`）

- **修改**（`host.ts`）
  - `puppetLayers` 视图按点 4 的形状给：`ids` / `find` / `control` / `alive` / `animations` / `create` / `destroy` 转到当前那份 `ScenePuppets`（待用的属于脚本当前 bundle 时取它，同 P12c）。
  - 一个共用的 `released` 钩子：
    ```ts
    private readonly puppetReleased = (object: number, id: number): void => {
      this.drawnState?.removeAnimationLayer(object, id);
      if (this.scriptState !== this.drawnState) this.scriptState?.removeAnimationLayer(object, id);
      this.runtime?.destroyAnimationLayer(object, id);
    };
    ```
  - `stepPuppets`：`frame(dt, stateSink(drawn), { event: …, released: this.puppetReleased })`。
  - `beforeFrame`：`settleDestroyed(…)` 之后加 `this.scenePuppets?.settle({ released: this.puppetReleased })`（WPE 先处理待删对象、再尾调排空 `ctx+0x1478`）。
  - `beforeFirstFrame`：`carryOver` 之后、`refresh` 之前加 `state.syncAnimationLayers(puppets.liveLayers(), this.scriptState !== state ? this.scriptState : null)`；`replayWrites`（`:1814`）在它之后，运行时层的脚本写入照常重放。
  - `puppetProbe`（`host.puppets()`）：每层多给 `id`，并给 `detached` 数（看「摘了还没释放」）。
- **修改**（dev 探针，保证 `p12-create` 能按 WPE 时间线回放）：
  - `dev/probeScripts.ts`：视图同宿主；`frame` 里 `settleDestroyed` 之后调 `puppets.settle({ released })`，`released` 删状态项、调 `runtime.destroyAnimationLayer`；`swap()` 之后对新状态 `syncAnimationLayers`。`puppets` 的 `Pick` 换成新方法名。
  - `dev/particleCorners.ts`：`puppetHooks` 多给 `released`（同上）。
  - `dev/probe.ts`：补编那一遍 `carryOver` 之后同样 `syncAnimationLayers`。

## 行为对照表

| # | 行为（rea-p12e / 实测） | 实现位置 | 测试 |
|---|---|---|---|
| 1 | 第一参转换：字符串原样，对象 stringify，`5` / `true` / `''` / `null` / `undefined` / 无参 → `null`（实测 2） | `animationLayerConfig.stubText` | `animationLayerConfig.test.ts`「查找」逐行；夹具 `t2.*` |
| 2 | 名字区分大小写、MDLA 第一条（`dup` → frameCount 10）、记录 id 0 → `null` | `animationLayerItem` 4 | 同上；`dup`、`id0` 两例 |
| 3 | 对象第一参：`animation` 只认数，`900.5` 取整，`'900'`、`'loopA'`、`12345` → `null`；对象里的 `name` / `rate` 生效 | `animationLayerItem` 5、7 | 同上；夹具 `t2.obj.*` |
| 4 | `config` 缺键补 `blendin` / `blendout` 为 `true`；config 覆盖第一参；字符串 config 按 JSON；数字 config 同缺省 | `animationLayerItem` 2、3、5 | 「config」逐行；夹具 `t3.*` |
| 5 | setter 类型：`NaN` / `'3'` / `true` / `0` / `'yes'` / `name: 5` 不写；`visible: false`、`additive: true`、`blend 0.5`、`blendtime 2` 生效 | `animationLayerItem` 7 | 同上；夹具 `t3.badTypes` / `t3.full` |
| 6 | 初值表（name `""`、rate 1 …、在播放、`getFrame()` 0、`isObjectValid` 真）；`IAnimationLayer.id` 为 `undefined` | `createLayer` + 包装 | `p12e.test.ts`「初值」；`createAnimationLayerApi.test.ts`；夹具 `t1.*` |
| 7 | single 动画 `blendout` 保留（`config` 可关），loop / mirror 清掉 | `createLayer` | `p12e.test.ts`；夹具 `t3.singleBlendout` / `t3.loopBlendout` |
| 8 | 插入：`index` 0 / 2 / −3 / 999、`autosort` 跳过末尾加法层；越界两种（有意不同） | `createLayer` | `p12e.test.ts` 复刻 `t4` 的序列与 `order` 串；空表、全加法层两例 |
| 9 | 包装同一性：返回值 `=== getAnimationLayer(count − 1)` | 包装按 id 缓存 | API 测试；夹具 `t1.same` |
| 10 | 生效帧：脚本阶段建、当帧 `getFrame()` 0，下一帧 `dt × fps` | 层表插入 + `frame` 顺序 | 夹具 `late,n=3..6` |
| 11 | 回调里给排在后面的 puppet 建层，同帧推进；给自己 / 前面的下一帧 | `frame` 按对象顺序 | `p12e.test.ts` 两个 puppet |
| 12 | 新层第一次推进就做播完检测（没有 SETFRAME） | `createLayer` 不置 SETFRAME | `p12e.test.ts`（大 rate 首帧回绕） |
| 13 | 单次层「播完」随模式：single 到头、loop 第一次回绕、mirror 第一次换向 | 现有检测 + `SINGLE_SHOT` | `p12e.test.ts`；夹具 `ended,*` |
| 14 | 删层那一帧层仍参与姿势，下一帧没了 | `dispatch` 在 `evaluate` 之后删 | `p12e.test.ts` 比姿势 |
| 15 | 回调里层有效、计数未减、0 个参数；同一帧 `update` 里作废、计数已减 | 先 DOOMED 后回调、`dispatch` 末尾释放 | 夹具 `ended,single,…count=7` 与 `f,32` |
| 16 | 隐藏的不推进永不删；暂停的不删 | 现有检测（隐藏跳过、`PAUSED` 不判） | `p12e.test.ts`；夹具 `hidden` / `paused` 列 |
| 17 | 回调里 `play()` + `setFrame(0)` 救不回 | `DOOMED` 只有删除时看，play / setFrame 不清 | `p12e.test.ts`；夹具 `save` |
| 18 | 没有回调的单次层照删（`psobj`） | 删除循环不看回调 | 夹具 `obj` 列 |
| 19 | `destroyAnimationLayer` 三种参数与返回值（`0` / 对象 / `-1` / `99` / `1.5` / `''` / `'zzz'` / `{}` / 作废包装 / `null` / `'1'` / 同帧再删）；别的 puppet 的层 → `false` | API 选择器 + `destroyLayers` | API 测试逐行（含两个 puppet 都有 id 0 的例子）；夹具 `destroy,*` |
| 20 | 摘表当场（计数、下标、名字），同帧包装可读写、调方法，下一帧作废 | `detached` + `settle` | 夹具 `same` / `next,n=4,5`；`p12e.test.ts` |
| 21 | 按名字删所有同名（相邻两个 `x` 都删，大小写不同 `false`） | `destroyLayers` | 夹具 `nameCase` / `nameX` / `same8` / `next9` |
| 22 | 图像层最后一层匹配时 WPE 崩溃 → 照删（有意不同） | `destroyLayers` | `p12e.test.ts`「末尾同名」 |
| 23 | 回调循环复位：A 的回调删 A，B 本轮漏掉、下次有层播完时才调 | `dispatch` 的 `anyEnded` 门与 `i = 0` | `p12e.test.ts` cb1 / cb2；夹具 `cb,*` |
| 24 | 回调里删自己（含单次层）只释放一次 | 摘出层表后删除循环看不到 | `p12e.test.ts` |
| 25 | 作废包装：读 `undefined`、写忽略、方法 `undefined`、`isObjectValid` 假、作参数 `false`；只读三项读 `undefined` | `dead()` + 访问器 | API 测试 |
| 26 | 删光 / 全隐藏回到静止；骨骼透明度 / 变形复位；`g_BlendMap` 不复位 | 现有 `evaluate` | `p12e.test.ts`（带通道轨道的小 rig） |
| 27 | 模型对象同一套；对象或父链不可见时冻结（不推进、不删、不发） | `evaluate` 的模型门 | `p12e.test.ts` 模型例 |
| 28 | 动画层字段脚本在层释放时收 `destroy` | `runtime.destroyAnimationLayer` | `structureRuntime` 风格的运行时测试 |
| 29 | 没被引用、用到不支持特性的动画：编译不报，运行时 `null` + warn | 点 1 + `animationLayerItem` 6 | `compile/p12e.test.ts`；API 测试 |
| 30 | 重编译保留运行时层、删过的编译期层、顺序、时钟、回调；清空脚本存储后回到 JSON 原样 | `carryOver` + `syncAnimationLayers` | `p12e.test.ts`「接回」；宿主测试 |
| 31 | 静态 puppet 上建层（WPE 建出不推进） | API 返回 `null` + warn（有意不同） | API 测试 |
| 32 | 对象 id 计数器前进 2 | 不复刻（P6d3b 的 id 规则不用计数器，已知差异） | — |

## 有意不同与已知差异（进 WPE_SCENE.md）

- 图像层按名字删、原表最后一层匹配：WPE 崩溃，我们删掉全部同名。
- `config` 解析成非对象、第一参对象是数组：WPE 未定义行为，我们返回 `null` 并 warn。
- `autosort` 没有非加法层、空表上 `index ≠ 0`：WPE 越界写，我们分别插到 0。
- 静态 puppet 上建层：WPE 建出一个永不推进的层（计数加一），我们返回 `null` 并 warn。
- 运行时 `config` 里的 `{user / script / animation}` 只取 `value`、不登记绑定。
- 对象 id：WPE 建层让共享计数器前进 2，影响之后 `createLayer` 的自动 id；我们不复刻（P6d3b 已知差异的一部分）。
- jsoncpp 解析失败时可能留下部分已解析的键（`'{"rate":2, x'`），我们整段当失败（`{}`）。
- `addEndedCallback(非函数)` 抛 `TypeError`（P12c 已定，保持）。

## 执行代理拆分

两个执行代理（sonnet），各自单独验收；每步之后我独立审查（先 `git status` 查越界）、跑 tsc 与相关测试、做变异检查。`puppet/player.ts`、`script/api.ts`、`host.ts`、`compile/bundle.ts`、`render/state.ts` 工作区里有别的会话没提交的改动，只加自己的块；按记忆里的做法在独立工作树里做、三方合并回主工作区。

- **P12e-1 — 编译期全编与层 id 化（点 1、点 2、点 3，外加调用方的机械改名）**
  - 改：`compile/puppet.ts`、`compile/scripts.ts`、`compile/bundle.ts`、`compile/bindings.ts`（注释）、`puppet/player.ts`、`render/state.ts`；调用方改用 id 视图但**不加**三个新方法：`script/api.ts`（`PuppetLayersView`、包装缓存键、替身视图、`getAnimationLayer`）、`host.ts`（视图、`puppetProbe`）、`dev/probeScripts.ts`。`createLayer` / `destroyLayers` / `settle` / `syncAnimationLayers` 在这一步实现并单测，但还没有脚本入口。
  - 测试：新 `compile/p12e.test.ts`（全编、`unsupported` 只记不报、被引用的照报、`defs.animation` 是 MDLA 下标、绑定与字段脚本目标用 `entry`、被丢的项删字段脚本）；新 `puppet/p12e.test.ts`（对照表 7、8、11–18、20–24、26、27、30 的运行时部分）；P12c 测试里按下标的地方改成 id（`compile/p12c.test.ts` 里 `entry ≠ layer` 的例子改断言 id）。
  - 验收：
    - `apps/wpe-scene` tsc 0 error；
    - 相关 vitest 全过：`puppet/`、`compile/p12*`、`script/animationLayerApi.test.ts`、`render/` 里读 puppet 的；
    - **不变**：`puppet/p12script.test.ts`（`p12-script` 642 行逐行、`g_Bones` 容差）、`p12bones` / `physics*` / P12a–P12b2 的夹具全过，断言不放宽；
    - 生成工程的编译结果里，被引用动画的报键与 HEAD 相同（`compile/p12*.test.ts` 的既有断言）。
- **P12e-2 — 脚本入口、作废、释放与接线（点 4、点 5、点 6）**
  - 改：新 `script/animationLayerConfig.ts`；`script/api.ts`（三个方法、`animationLayerOf` 与守卫、只读三项改访问器、`isObjectValid`）；`script/runtime.ts`（`destroyAnimationLayer`、`dropRecords`）；`compile/scriptApi.ts`（缺口表）；`host.ts`（`released` 钩子、`settle`、`syncAnimationLayers`）；`dev/probeScripts.ts`、`dev/particleCorners.ts`、`dev/probe.ts`。
  - 测试：新 `script/animationLayerConfig.test.ts`（对照表 1–5、29 的规整部分）；新 `script/createAnimationLayerApi.test.ts`（6、9、19、25、28、29、31）；`api.test.ts` 双向核对；新夹具回放 `puppet/p12create.test.ts`：夹具 `puppet/fixtures/p12-create.json` 由 `ignore/p12/e/impl/mkfix_create.py`（脚本文件，`python -X utf8 -I` 运行）从 `ignore/p12/e/proj/p12-create` 与 `step0.log` 抽取（工程文本、mdl、`@f64` 的 dt 与 `engine.runtime`、`[kbp]` 行），照 `p12script.test.ts` 的搭法（`createProbeScripts` + `stepPuppets` + `node:vm` realm）从第 1 帧回放 268 帧。
  - 验收：
    - tsc 0 error，上面的测试与 `script/`、`dev/probeScripts*` 全过；
    - `p12-create` 268 帧、WPE 日志 545 行中的 `[kbp]` 行**逐行相同**（含 `@f64` 行）；
    - P12e-1 的「不变」项仍全过。

主会话：两步之后的审查与变异、`g_Bones` 抓帧对照、语料与体积、真机、收尾文档（「验证」「文档」）。

## 验证

1. **单测**（只跑相关文件，`cd /D/Codes/kabegame`，`--config` 用大写盘符；全量 vitest 等用户说再跑）：上面两步列的文件，外加 `puppet/p12c.test.ts`、`puppet/p12script.test.ts`、`puppet/p12bones.test.ts`、`puppet/physics*.test.ts`、`script/animationLayerApi.test.ts`、`script/structureRuntime.test.ts`、`host.test.ts` 里 puppet 相关的用例。
2. **变异**（按原字节还原，每个都要被某个测试杀死）：
   - `dispatch` 去掉 `anyEnded` 门；去掉 `i = 0`；`i = 0` 改成 `i = -1`；
   - 先调回调再置 `DOOMED`；`play()` 清 `DOOMED`；
   - 删除循环放到 `evaluate` 之前（删层那一帧不参与姿势）；
   - `destroyLayers` 当场释放（不进 `detached`）；名字只删第一个；下标允许 `i == 层数`；
   - `createLayer` 不清非 single 的 `blendout`；`index` 越界插末尾；`autosort` 不跳加法层；
   - 规整：config 覆盖方向反过来；`blendin` 缺省不补；float 收布尔；名字不区分大小写；按名字找最后一条；
   - `carryOver` 丢运行时层；丢 `destroyedEntries`；
   - 编译：没被引用的不支持动画报进 `unsupported`；
   - API：作废后方法照调；`isObjectValid` 不认动画层。
3. **WPE 对照**（我自己做）：
   - **脚本日志**：`p12-create` 的夹具回放（P12e-2 的验收）之外，再在 dev 下用 `render_scene` 按 WPE 帧时间回放到第 200 帧，宿主路径的 console 与 WPE 日志逐行比（验宿主的 `settle` / `released` 接线，单测里探针与宿主是两份接线）。
   - **`g_Bones`**：`A:\p12e\step0\` 先看已有抓帧覆盖哪些帧；不够就用 wpe-renderdoc 对 `p12-create` 抓 `A:\p12e\bones\`（fps 20），覆盖 main 的 `late` 建层前后（n = 3、4、5）、single 的删层前后（n = 32、33、42、43）、destroy 的删层前后（n = 3、4、10、11）。和回放逐 draw 比，容差同 P12a（≤ 5 ulp 或 ≤ 2e-6）。重点：建层那一帧 `g_Bones` 不变、下一帧起有贡献；删层那一帧仍含该层、下一帧没了；删光后回到静止。
   - **2887099508**：dev 强制渲染下点一次书，看脚本不报错、`host.puppets()` 里 hand book 多出一层、播完后消失；预览里点书翻页由用户手动勾（回归 PE6）。
4. **语料**（`kbp corpus scan`，工作区快照对 HEAD）：
   - 键：只去掉 `script:api:layer.createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`，其余逐张不变（被引用动画的报键不变），`clean_lost` 0；看 `2887099508` 是否转为能渲染（`2916324703` 预计仍差精灵表与 `destroyLayer` 以外的键）。
   - **体积与耗时**：给 `kbp corpus scan` 加一个附加字段插件 `puppetBytes`（每张场景 puppet 与模型骨骼动画的 `frames` / `alpha` / `morph` / `channels` / `meshMorph` 字节总和、动画条数、其中 `unsupported` 条数）与编译耗时字段，前后两次 `kbp corpus diff`：报总量、增幅最大的 10 张、增幅中位数。增幅异常（单张超过 32 MB 或编译耗时翻倍）时回来讨论「待定」8 的退路。
   - `scriptCorpus`（P6d2 的工具）前后跑全库：只有用到这三个方法的场景诊断有变化。
5. **回归**：P12a / P12b1 / P12b2 / P12c / P12d 的生成工程重渲 22 帧，和之前我们的帧逐字节相同。
6. **检查**：`deno task check -c kabegame`（cargo 那半被 dev 占用失败时只看 vue-tsc 与 wpe-scene 的 tsc）、Prettier。

## 文档

- `cocs/wpe/WPE_SCENE.md`：
  - 新节「puppet 动画层的建删（P12e）」：动画全编与 `unsupported`、层 id（编译期 = JSON 下标、运行时负数）、建层规整规则表（对照表 1–8）、单次层与回调循环（含漏扫）、删层的摘表 / 释放两段、作废、跨重编译接回、「有意不同与已知差异」全部条目、走查结果与 2887。
  - P12c 一节同步：「包装对象按『对象:层下标』缓存」改成按层 id；派发顺序补「事件 → 回调循环（`anyEnded` 门、复位）→ 删单次层」；「建删层三个方法不做」删掉。
- `cocs/README.md`：WPE_SCENE 条目主题里加一条「puppet 动画层的建删（P12e）」摘要（动画全编、层 id、单次层、删层两段、接回）；适用场景加：脚本 `createAnimationLayer` / `playSingleAnimation` 返回 `null` 或建出的层不对（查找、config、插入位置）、单次层不删或删早了、回调漏调、`destroyAnimationLayer` 返回值或删后包装还能用、重编译后运行时建的层没了或删掉的层回来了、日志里「动画用到不支持的特性，不建层」、puppet 场景的 bundle 变大。
- `versions/latest/regression.md`：新节「场景壁纸 puppet 动画层的建删（P12e）」，格式同 P12c 一节：PE0 单测与检查、PE1 语料（键与体积）、PE2 `p12-create` 日志逐行、PE3 `g_Bones` 对照、PE4 P12a–d 生成工程不变、PE5 宿主 `settle` 接线（实时预览看 `host.puppets()` 的 `detached` 归零）、PE6 `2887099508` 预览里点书翻页（需要人点）、PE7 非 Windows（本机不能测）。
- `versions/latest/changelog.md`：一行，例如「场景壁纸：puppet 动画层支持脚本运行中建层、播一次就删的单次动画与删层（`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`），工坊 2887099508 点书翻页可以用了」。
- `PLAN.md` 与 [phase-12-puppet.md](phase-12-puppet.md) 的进度；P6d3 计划实施记录里 2887 点击那条补「P12e 已做」；本文件的实施记录。

## 待定（已定：2026-11-16 用户同意全部按推荐）

> 1–9 均按「推荐」做。4 的前提不变：先扫语料，`animationlayers` 里有布尔 / 字符串写的数、数字写的布尔时不改严，单列给用户看。

1. **层 id 的形式**：
   - **推荐**：编译期层 = JSON 下标（`entry`），运行时层 = 负数（每个 puppet 从 −1 起递减）。重放表与 `{user}` 绑定的键和 `scene.json` 路径同形，字段脚本不用再回填下标；`destroyObjects` 的 `^objects/(\d+)/` 正则照样认。
   - **另一种**：运行时层用字符串 id（如 `r3`），可读性好些，但 `PuppetSink`、状态键、目标类型要从 number 改成 `number | string`，改动面更大。
2. **跨重编译保留运行时建删的层**：
   - **推荐**：`carryOver` 按 id 接回层表（顺序、运行时层、删过的编译期层）+ 状态在 `carryOver` 之后对齐，不进编译输入。理由见「总体设计思路」：不改编译产物、插入位置依赖运行时状态、现成的接回机制、生效帧与 WPE 一致、清空脚本存储自然复位。
   - **另一种**：照 P6d3a 进 `SceneStructure`（编译期重演建删）。要在编译期模拟 `autosort` / `index`，而它们看的是当时各层的加法位（脚本可改），重演得不到同样的顺序；还要为不改产物的变化触发重编译。
3. **没被引用、又用到不支持特性的动画转不转帧数据**：
   - **推荐**：不转，只留名字 / id / 模式 / fps / 长度 / 事件与 `unsupported`（运行时反正不建层，省体积）。
   - **另一种**：照转，以后支持了这些特性不用改编译。
4. **编译期 `layerDefs` 的取值规则比实测宽**：`floatField` 收布尔与能解析的字符串、`boolField` 收数字（`compile/puppet.ts:219`–`230`），而 P12e 实测同一个 setter（加载 `animationlayers` 也走 `FUN_1401730d0`）只收 JSON 数 / JSON 布尔 / JSON 字符串。
   - **推荐**：P12e 一起改严，编译期与运行时共用一个取值函数；先用语料扫一遍 `animationlayers` 里有没有布尔 / 字符串写的数、数字写的布尔，0 处就改，有就单列给你看。
   - **另一种**：只对运行时建层用严规则，编译期保持现状（两套规则并存）。
5. **只读三项改成 getter-only 访问器**：
   - **推荐**：改（rea-p12c 说 WPE 是「没有 setter」，严格模式赋值照样抛 `TypeError`；作废后读 `undefined` 才和其余成员一致）。P12c 的测试只断言抛错与值，描述符形状会变。
   - **另一种**：保持数据属性，作废后仍读出数（已知差异）。
6. **静态 puppet 上 `createAnimationLayer`**（WPE 建出、计数加一、永不推进，语料 0）：
   - **推荐**：返回 `null` 并 warn（有意不同）；静态 puppet 不进运行时，P12c 起计数就是 0。
   - **另一种**：给静态 puppet 也建一个只有层表、不推进的运行时，照 WPE 计数。
7. **运行时 `config` 里的 `{user / script / animation}`**（WPE 会登记绑定，作用域与 `init` 时机没查，语料 0）：
   - **推荐**：只取 `value`、不登记、warn 一次。
   - **另一种**：先补读码 / 实测再做。
8. **产物体积的退路**（只在「验证」4 量出来异常时才需要）：未被引用的动画改成按需转换（bundle 带 mdl 原始轨道，运行时第一次建层时现转）。推荐先量再定，不预先做。
9. **步骤划分**：推荐按「执行代理拆分」分 P12e-1 / P12e-2 两个执行代理，每步之后我审查、变异、合并；夹具抽取脚本由 P12e-2 的执行代理写。

## 实施记录

- 2026-11-16 用户同意全部按推荐。语料扫描（「待定」4 的前提）：41 张场景、316 个 `animationlayers` 项，各字段类型全部符合严规则
  （`rate` 270 数 + 46 绑定对象的数、`blend` 300 + 16、`blendtime` 251 数；`visible` 233 布尔 + 83 绑定对象的布尔、`additive` / `blendin` /
  `blendout` 全是布尔；`name` 全是串；`animation` / `id` 全是数），0 处受影响 → 编译期改严、与运行时共用取值函数。
- 工作树 `ignore/p12/e/wt`（HEAD `f689d22f`，`node_modules` 两处联接）。注意计划的现状锚点取自较早的提交，`script/api.ts`、`script/runtime.ts`、
  `host.ts`、`dev/probe*.ts`、`compile/bundle.ts`、`compile/scripts.ts`、`render/state.ts` 之后又有 P6d3b 等改动，以工作树里的实际代码为准。
- 语料基线（HEAD 快照 `ignore/p12/e/head`，`kbp corpus scan --extra puppetBytes` → `ignore/p12/e/corpus/head.json`，插件本步新增）：233 张、
  194 张干净；带 puppet 动画的 41 张，动画 315 条、类型化数组共 36,364,771 字节，最大 `3808922316` 7.5 MB（64 条），编译总用时 91.4 s。
  `2887099508` 在 HEAD 已是干净（脚本里的调用编译期认不出，点击时才报错），`2916324703` 仍差 `combo:SPRITESHEET`、`tex:animation`。
- `g_Bones` 对照：步骤 0 的两张抓帧（`A:\p12e\step0`，`kbp rdc consts … --names g_Bones,g_ModelViewProjectionMatrix` →
  `ignore/p12/e/out/wpe-step0-consts.json`）是脚本帧 241、242（时间与 `@f64` 逐位相同），每帧五次带 `g_Bones`（48 个数）的绘制，event
  50 / 69 / 88 / 107 / 126 按 MVP 平移 x 从小到大即 main / single / destroy / cb1 / cb2。此时建删都已结束，验稳态姿势（新层有贡献、删掉的层
  没了、删光回到静止）；建删当帧的时机由日志逐行覆盖，不另抓。
- P12e-1 完成（执行代理，工作树内）：tsc 0；`src/puppet` 10 文件 167 例、加 compile / script / dev / host 共 47 文件 922 例全过；新测试
  `compile/p12e.test.ts` 15 例、`puppet/p12e.test.ts` 47 例；计划里属于本步的变异全部杀死（「删除循环挪到 evaluate 之前」原写法是等价变异，
  改成「去掉派发里的删除、下一帧 evaluate 前再删」后杀死）。偏差：`syncAnimationLayers` 多一个 `objects` 参数（静态 puppet 也有状态项，
  只对齐有运行时的对象，`ScenePuppets.objects()` 给）；`createLayer` 对 `unsupported` 动画也返回 null；对照表 12 的「大 rate 首帧回绕」做不到
  （loop 按 `t0 > t` 判，首帧 t0 = 0），改用 single / mirror 首帧到头 / 换向。用户属性写入路径 `animationLayerValue` 仍是 P12c 的宽规则（不在本步）。
- 主会话核对：改动只在计划列的文件；独立重跑 tsc 0、47 文件 922 例全过；语料（`corpus/e1.json` 对 `head.json`）键逐张不变、干净 194 → 194；
  体积 36.4 → 49.7 MB（+37%，带动画的场景 41 → 43 张、动画 315 → 473 条、`unsupported` 0 条），最大 `3706286085` 1.9 → 14.2 MB（133 条），
  编译总用时 91.4 → 94.2 s：远低于「待定」8 的门槛，不做按需转换。
- P12e-2 完成（执行代理，工作树内）：新增 `script/animationLayerConfig.ts`，三个脚本方法、作废守卫、`isObjectValid`、`runtime.destroyAnimationLayer`、
  宿主与三处探针接线；夹具 `puppet/p12create.test.ts`（抽取脚本 `ignore/p12/e/impl/mkfix_create.py`）268 帧 545 行与 WPE 逐行相同，`g_Bones`
  470 / 480 逐位、最大 4 ulp。偏差：只读三项没做成 getter-only——P12c 的 `p12-script` 日志里 WPE 赋值报的是
  `Cannot assign to read only property 'fps' …`（V8 原生只读属性的文字），getter-only 的报错文字不同；改成访问器 + 抛同一句 `TypeError` 的 setter，
  作废后读 `undefined` 照旧做到，只有 `getOwnPropertyDescriptor` 的形状和 WPE 不同（记进 WPE_SCENE 的已知差异）。静态 puppet 的检查挪到取视图之前（宿主视图对静态 puppet 也在）。
- 主会话核对与合并（2026-11-16）：工作树 66 文件 1137 例全过，自做两处变异（去掉 `i = 0` 由 `puppet/p12e.test.ts` 杀死，回放因为摘表本身就会漏扫而杀不死；
  去掉 `anyEnded` 门两边都杀死）。三方合并回主工作区（祖先 `f689d22f`），`render/state.ts` 一处相邻冲突（别的会话的 `cameraBase` 字段与本步的注释行）手工保留两边；
  主工作区 tsc 0、同一组 66 文件 1138 例与 render 里 3 个读 puppet 的文件全过。
- dev 走查：重建宿主产物后 dev 探针按 WPE 时间线回放 `p12-create`，545 行逐行相同；实时预览十几秒后各 puppet 层数同 WPE、`detached` 全 0；P12a–d 的 8 个
  生成工程 22 帧逐字节相同；测试工程都已 `projects_remove`。`2887099508` 的探针点击没点中（开场镜头推近、书不在算出的位置），翻页留给用户（PE6）。
- 文档：WPE_SCENE 新节与 P12c 一节同步、README、回归 PE0–PE7、changelog、PLAN、phase-12-puppet、P6d3 实施记录；`kbp corpus scan` 新增 `puppetBytes` 插件（SKILL.md 同步）。
- 2026-11-16 用户在预览里点 2887099508 的书，确认翻页正常（PE6），同意提交。
