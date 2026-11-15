# P12c 子计划 — puppet 动画层的脚本 API

> 总计划：[phase-12-puppet.md](phase-12-puppet.md)「P12c — 脚本」。
> 语义依据：
> - 读码：[rea-p12-attach-physics](rea-p12-attach-physics.md) 第 4 节、[rea-p12-runtime](rea-p12-runtime.md) 3.1–3.4、[rea-p12c-script](rea-p12c-script.md)（本节步骤 0 补查）；
> - 实测：[p12-REPORT](p12-REPORT.md) 第一部分用例 9（`p12-script`）；
> - 语料：`ignore/p12/c/corpus/report.txt`。

## 总体设计思路

P12c 的接法和 P10b 的关键帧动画脚本接口一样，分三层：

- **运行时**：动画层本来就在 puppet 运行时（`ScenePuppets`）里，每帧推进、采样、混合。P12c 给它加四样东西：
  - 一个按（对象，层下标）取的控制口 `PuppetLayerControl`；
  - 每层一张播完回调表；
  - MDLA 事件的收集；
  - 照 WPE 的「播完」检测与 `setFrame` 位。

  派发不进运行时：`frame` 多收一个钩子，事件按收集顺序交给钩子，播完回调直接调登记好的函数。这些函数在登记时已由脚本 API 包好，经运行时 `callFor` 进入登记它的那段脚本。
- **脚本 API**：
  - 每个图层对象上装 `getAnimationLayerCount` / `getAnimationLayer`，图像层与模型都装；不是 puppet 的返回 0 / `null`。
  - 返回的 `IAnimationLayer` 是按（对象，层下标）缓存的包装对象，自己不持有运行时，每次经宿主现取控制口。这样重编译换了 `ScenePuppets` 也接得上，做法同 `IAnimation`。
  - `rate` / `blend` / `visible` 是用户属性、字段脚本、API 三方共写的字段，仍放在 `SceneState.animationLayers`，写入走普通脚本写回（会记进重放表）。
  - `name`、`additive`、`blendin`、`blendout`、`blendtime` 只有 API 写，直接落在运行时的层上，重编译时随 `carryOver` 接回。
- **字段脚本**：动画层字段上挂的 `{script}` 变成一种新的属主 `animation-layer`。`thisObject` 是那个 `IAnimationLayer`，`thisLayer` 是所属图层。派发上按所属图层算，和读码 4 一致：收 `animationEvent`、光标回调、`applyUserProperties`。写回目标是已有的 `animation-layer` 目标。

**时序**：puppet 在对象更新循环里推进，排在脚本之前。WPE 在同一个更新里，等全部层推进、采样、混合完，再发事件和播完回调。所以回调里做的任何写入都是下一帧生效。我们的 `stepPuppets` 已在脚本前面，派发放在每个 puppet 的 `evaluate` 末尾即可，不改帧循环。

**首次加载**：首次加载时 `init` 先于 `beforeFirstFrame` 跑，而 puppet 运行时现在是在后者里新建的。语料里 50 处「相位偏移」脚本都在 `init` 里 `setFrame`，所以宿主要照 P10b 的 `pendingAnimations`，在跑 `init` 之前按新 bundle 先建好待用的 `ScenePuppets`。

**关键决定**：
- 不复刻 WPE 的崩溃路径（`addEndedCallback(非函数)` 存空指针）。我们抛 `TypeError`，同 `IVideoTexture`。
- 只在 `rate` / `blend` / `visible` 上接字段脚本（语料 65 处全在这三个上），其余五个可写字段挂脚本照报 `puppet:layer-script`。
- 建删层的三个方法（`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`）不做，见「待定」1。

## 步骤 0 结论（2026-11-15）

**读码**（[rea-p12c-script](rea-p12c-script.md)）：
1. **模型对象**：方法表只有 5 个方法，`getAnimationLayer` / `getAnimationLayerCount` 与图像层逐指令同形（层表换成 `S+0x78`），层对象是同一个类。所以模型上的 `IAnimationLayer` 与图像层完全一样；没有骨骼的模型计数 0、查找 `null`。模型**没有**骨骼、混合形状、物理方法。
2. **模型更新**：收事件、做同一套播完检测、每层推进后清 `setFrame` 位，顺序都与图像层相同（事件 → 播完回调 → 删单次层）。唯一差别是模型自身或父链不可见时整段不跑。权重为 0 的层照样推进、照样发事件和回调。
3. **播完回调**：
   - 调用时进入登记它的那段脚本：`thisObject` 与 `thisLayer` 取登记时的；`this` 是那段脚本的模块命名空间；不带参数。
   - 抛错只写日志，不禁用任何回调。
   - p12-REPORT 用例 9 的「`this` 为 undefined」更正为「`name` 为 undefined 的对象」，即命名空间。
4. **字段脚本的归属**：`thisObject` 来自动画层，作用域是所属图层。由派发条件推出（没实测）：会收到所属图层的光标回调、`applyUserProperties`、媒体回调；动画层析构时收 `destroy`。
5. **写入转换**：与 `IAnimation.rate` 是同一个函数。
   - `rate` / `blend` / `blendtime` 只收 number（含 `NaN`、`±Infinity`）；
   - 四个布尔字段只收 `true` / `false`；
   - `name` 忽略 `null` / `undefined`，其余先 `ToString`；
   - 别的类型静默忽略，不钳制、没有改值回调。
6. **`getAnimation`**：dll 通用的那个，按属主（动画层）找关键帧动画，语料下总是 `undefined`。
7. **`blendout`**：只在加载时对非 single 层清位；之后脚本写成真，循环层也会每轮末尾淡出（更正 rea-p12-runtime 3.2）。

**语料**（`ignore/p12/c/corpus/report.txt`，HEAD `3396ca04`，233 张，能渲染 160）：
- **规模**：带动画层的 skinned 图像层 puppet 194 个对象 / 304 层（40 张），模型 5 个对象 / 12 层（`3706286085`）。
  - JSON 下标与丢项后的下标处处相同；
  - 没有同对象重名层；
  - 没有 `index` / `autosort`。
- **入口**：静态报 `getAnimationLayer` 的 10 张。
  - 用法：多数是 `cursorClick` 里 `getAnimationLayer("…").play()`；`2887099508`（混淆）在 `cursorEnter` / `Leave` / `init` 里经 `thisScene.getLayer` 操作 12 个层。
  - 实际用到的成员：`play`、`isPlaying`、`setFrame`、`getFrame`、`frameCount`，写 `visible` / `blend` / `rate`，`addEndedCallback`。
  - 「NSL」脚本库里用到 `getAnimationLayerCount` 的函数是死代码。
- **字段脚本 65 处**：图像层 57（`visible` 44、`rate` 13），模型 8（`rate` 4、`blend` 4）。
  - 50 处是「相位偏移」：`init` 里对 `thisObject` `play()` + `setFrame(frameCount × 比例)`。
  - 要求 `'addEndedCallback' in thisObject` 为真：脚本靠它判断 `thisObject` 是不是动画层。
- **事件与 `hitBox`**：MDLA 事件实际派发 0 处，`hitBox` 0 处。
- **建删层与骨骼 API**：`playSingleAnimation` 2 张用到（`2916324703`，`2887099508` 混淆里藏的）。两张都还差别的键（精灵表、`destroyLayer`），不靠它解锁。骨骼 API 1 张（`3359451610`），不在 P12c。
- **解锁**：去掉 `puppet:layer-script` 与两个 `script:api:layer.getAnimationLayer*` 后多渲染 4 张：`3346715292`、`3361965869`、`3492627662`、`3830665420`，160 → 164。
- **推断、待走查**：
  - `3346715292` 缺 NSL，6 个 `init` 抛错；
  - `3361965869` 对象 5 按名字查不到层，点击抛 `TypeError`；
  - `3400241651` / `3492627662` 的 NSL 排在使用者后面：WPE 先全部求值、再逐个 `init`（我们也是这样），定义在模块顶层还是 `init` 里决定能不能用到。

## 现状锚点

**a. 动画层字段挂脚本一律报 `puppet:layer-script`**（`compile/puppet.ts:364`）
```ts
    if (LAYER_KEYS.some((key) => isScriptValue(json[key]))) issues.add("puppet:layer-script"); // 现状：图像层与模型共用 layerDefs，都报
    const value = (key: (typeof LAYER_KEYS)[number]) => resolveValue(json[key] as SceneValue | undefined, properties);
```

**b. 字段脚本的属主只有四种，`animationlayers` 下的脚本落在图层属主上**（`compile/scripts.ts:26`、`:143`）
```ts
export type ScriptOwner =
  | { kind: "layer"; object: number }
  | { kind: "material"; pass: TargetKey; layer: number }
  | { kind: "effect"; object: number; effect: number }
  | { kind: "general" };
// targetOf：`objects/<i>/animationlayers/<k>/visible` 的 key 是 visible，落进 layerTypes，现状会被当成图层自己的 visible（被 puppet:layer-script 盖着）
  if (owner.kind === "layer" && key in layerTypes)
    return { kind: "layer", object: owner.object, field: key as Extract<BindingTarget, { kind: "layer" }>["field"] };
```

**c. 动画层的时钟不带事件，收集的事件丢掉，没有播完检测**（`puppet/player.ts:180`、`:426`）
```ts
function layerClock(fps: number, length: number, mode: AnimationMode): AnimationClock {
  // …
  return new AnimationClock({ fps, length, mode, startpaused: false }); // 现状：不传 events
}
// evaluate
      if (d !== null) {
        layer.clock.advance(f(d * f(fields.rate)), this.events);
        this.events.length = 0; // 现状：P12a 丢掉；没有「播完」检测、没有 setFrame 位
      }
```
MDLA 事件已由 `parseMdl` 读出（`compile/mdl.ts:793` 的 `events: { time, json }[]`），但 `PuppetAnimation` 没有这一项。

**d. 重编译只接回时钟与 blendin 清位**（`puppet/player.ts:336`）
```ts
  carryOver(previous: ScenePuppets | null): void {
    // …
        a.t = b.t;
        a.flags = ((a.flags & ~(PAUSED | DONE | BACK)) | (b.flags & (PAUSED | DONE | BACK))) >>> 0;
        if (!(old.flags & LAYER_BLENDIN)) layer.flags &= ~LAYER_BLENDIN; // 现状：名字、additive、blendout、blendtime 都不可写，不用接
  }
```

**e. 图层 API 对象上没有动画层方法；`thisObject` 只认四种属主**（`script/api.ts:378`、`:802`）
```ts
    this.method(api, "getVideoTexture", () => this.videoTexture(index));
    this.installGetAnimation(api, () => `objects/${index}`); // 现状：没有 getAnimationLayer / getAnimationLayerCount
    this.layers.set(object, api);
// …
  private owner(): ApiObject | null {
    const owner = this.current?.owner;
    if (!owner) return null;
    if (owner.kind === "layer") return this.layer(owner.object);
    if (owner.kind === "general") return this.general;
    if (owner.kind === "effect") return this.effect(owner.object, owner.effect);
    return this.material(owner.pass);
  }
```

**f. 缺失表里还有两个入口**（`compile/scriptApi.ts:128`）
```ts
    ...methods(
      "any",
      [
        "getTextureAnimation",
        "getAnimationLayerCount", // 现状：用到就报 script:api:layer.getAnimationLayerCount
        "getAnimationLayer",
        "createAnimationLayer",
        "playSingleAnimation",
        "destroyAnimationLayer",
      ],
      UNIQUE,
    ),
```

**g. 宿主在 `init` 之后才建 puppet 运行时，推进时不带钩子**（`host.ts:1293`、`:1515`–`1542`）
```ts
      stepPuppets: (dt) => {
        const drawn = this.drawnState;
        if (drawn) this.scenePuppets?.frame(dt, stateSink(drawn)); // 现状：不派发事件与播完回调
      },
// load
        const player = new SceneAnimations(bundle.animations ?? []);
        if (this.runtime && this.pendingAnimations) player.carryOver(this.pendingAnimations.player);
        this.pendingAnimations = { bundle, player };
        await this.ensureRuntime(bundle, target.sceneAssets); // `init` 在这里跑
      // …
      const puppets = new ScenePuppets(puppetEntries(bundle.layers)); // 现状：init 之后才建
      await current.load(bundle, {
        // …
        beforeFirstFrame: (state) => {
          puppets.carryOver(this.scenePuppets);
          puppets.refresh(stateSink(state));
          this.scenePuppets = puppets;
```

**h. 字段脚本读不到动画层字段**（`script/stateWrite.ts:38`）
```ts
export function readScriptState(state: SceneState, target: ScriptTarget): ScriptValue | null {
  if (target.kind === "layer") { /* … */ }
  // … 现状：没有 animation-layer 分支，update(value) 收到 null
  return null;
}
```

## 点 1 — 编译期：事件、字段脚本的属主与目标（`compile/puppet.ts`、`compile/scripts.ts`、`compile/bundle.ts`、`compile/features.ts`）

- **新增**
  - `PuppetAnimation.events: { time: number; json: string }[]`：照搬 `parseMdl` 读出的这条动画的事件（时间单位是秒，同 P10）。图像层与模型都填。
  - `PuppetLayerDef.entry: number`：这一层在 JSON `animationlayers` 里的下标。字段脚本按它找层：语料里两种下标处处相同，但 `layerDefs` 会丢项，所以不假设相同。
  - `ScriptOwner` 加 `{ kind: "animation-layer"; object: number; entry: number; layer: number }`。`collectScripts` 遇到路径 `objects/<i>/animationlayers/<k>/<字段>` 时用它（先填 `layer: -1`）。
    ```ts
    export type ScriptOwner =
      | { kind: "layer"; object: number }
      | { kind: "animation-layer"; object: number; entry: number; layer: number } // 新增：layer 是 ScenePuppet.layers 的下标，bundle 定
      | { kind: "material"; pass: TargetKey; layer: number }
      | { kind: "effect"; object: number; effect: number }
      | { kind: "general" };
    ```
  - `targetOf`：属主为 `animation-layer` 且字段是 `rate` / `blend` / `visible` 时，目标是 `{ kind: "animation-layer", object, layer, field }`，值类型 float / float / bool。别的字段是 `unsupported`。脚本的 `layer`（`thisLayer` 用）照旧是对象下标。
- **修改**
  - `compile/bundle.ts`：图像层 puppet 与模型的层整理完之后，按 `entry → layer` 回填这类脚本的属主与目标。下面两种情况把脚本从 `scripts.list` 删掉（WPE 不建这一层，字段脚本不会登记），并在代码注释里写明：
    - 对象没有 skinned puppet / 骨骼；
    - 这一项被 `layerDefs` 丢了。
  - `layerDefs`：`rate` / `blend` / `visible` 挂脚本不再报；`name`、`additive`、`blendin`、`blendout`、`blendtime` 挂脚本仍报 `puppet:layer-script`（语料 0 处）。
    ```ts
    // 字段脚本（P12c）：rate / blend / visible 接 `animation-layer` 目标；其余五个可写字段语料 0 处，照报
    if (UNSCRIPTED_LAYER_KEYS.some((key) => isScriptValue(json[key]))) issues.add("puppet:layer-script"); // 修改
    ```
  - 能力表：`script:api:layer.getAnimationLayer` / `…Count` 随缺失表删除（点 3），不另改。

## 点 2 — 运行时：控制口、事件、播完（`puppet/player.ts`，必要时 `puppet/pose.ts`）

- **新增**
  - 控制口：
    ```ts
    /** IAnimationLayer 的落点（P12c）：一个动画层的运行时，读写都直接作用在层上。rate / blend / visible 不在这里（在 SceneState）。 */
    export interface PuppetLayerControl {
      readonly fps: number;        // f32(1 / spf)
      readonly frameCount: number; // length
      readonly duration: number;   // D
      name: string;
      additive: boolean;
      blendin: boolean;
      blendout: boolean;
      blendtime: number;
      play(): void;
      pause(): void;
      stop(): void;
      isPlaying(): boolean;
      setFrame(frame: number): void; // t = f32(spf × f32(frame))，另置 SETFRAME
      getFrame(): number;
      addEndedCallback(callback: () => void): void;
    }
    export interface PuppetHooks {
      /** 本帧越过的 MDLA 事件：每个 puppet 推进完全部层之后，按收集顺序（层序 × 事件表顺序）调。 */
      event?(object: number, json: string): void;
    }
    ```
  - `ScenePuppets`：
    - `layerCount(object)`：skinned puppet / 带骨骼模型的层数，别的为 0；
    - `layer(object, index)`：返回控制口；index 越界、不是 puppet 时为 null；
    - `findLayer(object, name)`：按**当前**名字找，最后一个匹配，空串不匹配，找不到 −1。
  - `LayerRuntime` 加 `name`（可写）、`callbacks: (() => void)[]`；`blendtime` 改成可写。
  - 位常量：`SETFRAME = 0x02000000`、`ENDED = 0x04000000`，放在 `clock.flags` 上，同 WPE。
- **修改**
  - `layerClock(..., events)`：时钟带上这条动画的事件。
  - `frame(dt, state, hooks?)`；`evaluate` 在推进时（`d !== null`、层可见，模型过了更新门）照读码 3.1 做：
    ```ts
    const old = clock.flags >>> 0;
    const t0 = clock.t;
    clock.advance(f(d * f(fields.rate)), runtime.events); // 新增：事件收进本 puppet 的列表，不再清掉
    if (!(old & (PAUSED | DONE | SETFRAME))) {
      const ended = clock.flags & SINGLE ? (clock.flags & DONE) !== 0     // single：本帧刚结束
        : clock.flags & MIRROR ? ((old ^ clock.flags) & BACK) !== 0         // mirror：换向
        : t0 > clock.t;                                                     // loop：回绕（负 rate 每帧都成立，照抄）
      if (ended) clock.flags = (clock.flags | ENDED) >>> 0;
    }
    clock.flags = (clock.flags & ~SETFRAME) >>> 0; // 只在可见、推进的层上清（不可见的层保留到下次推进）
    ```
    - 模型里权重为 0 的层照样推进、收事件、做播完检测（检测放在 `w === 0` 的 `continue` 之前）。
    - `evaluate` 末尾（这个 puppet 的层全部做完）派发：
      - 先把收集的事件逐个交给 `hooks.event(object, json)`，然后清空列表；
      - 再按层序处理带 `ENDED` 的层：清掉这一位，拷一份回调表逐个调。
      - 调用由登记方包好，这里只调。`refresh`（`d === null`）不派发、不检测。
  - `carryOver`：在接回时钟的同一条件下，再接回：
    - `name`；
    - `additive` / `blendin` / `blendout` 三位（替换原来只接 blendin 清位的那一行）；
    - `blendtime`；
    - 回调表（同一个数组引用）；
    - 时钟的 `SETFRAME`。

    WPE 改属性不重载，这些都还在。条件不满足（动画变了）时这些也不接，从定义重来。
  - 控制口的方法照 `AnimationClock`：`play` / `pause` / `stop` / `isPlaying` / `getFrame` 直接转调；`stop` 的掩码 `0x3fffffff` 不清 `SETFRAME`，同 WPE。
  - `blendout` 写成真时不看模式（读码 5.3），`layerWeight` 本来就不看模式，不用改。
- **删除**
  - `ScenePuppets.events` 字段：改成每个 puppet 运行时一份（`PuppetRuntime.events`）。

## 点 3 — 脚本 API（`script/api.ts`、`script/runtime.ts`、`script/stateWrite.ts`、`compile/scriptApi.ts`）

- **新增**
  - `ScriptApiState.puppetLayers?(object): PuppetLayersView | null`。宿主现取（点 4）；不传或返回 null（语料诊断、`realmCheck`）时退回按 bundle 的层定义回答：计数、按定义名字查找、只读三项照算，方法空操作，`isPlaying()` 为假，`getFrame()` 为 0。
    ```ts
    export interface PuppetLayersView {
      count(): number;
      find(name: string): number;
      control(index: number): PuppetLayerControl | null;
    }
    ```
  - 每个图层 API 对象上（`layer(index)` 里，所有图层都装）：
    - `getAnimationLayerCount()`：返回计数，不是 puppet 的为 0。
    - `getAnimationLayer(x)` 按 x 的类型决定（p12-REPORT 用例 9）：
      - `typeof x === "number"`，且 `Number.isInteger(x) && 0 ≤ x < count` → 下标；
      - 非空字符串 → `find`；
      - 其余（含 `1.5`、`"1"` 按名字查不到、空串、无参）→ `null`。
  - `IAnimationLayer` 包装对象：按 `${object}:${index}` 缓存（`get(0) === get("walk")`）。不持有运行时，每次经 `puppetLayers(object)?.control(index)` 现取。自有可枚举成员，顺序照实测：
    `duration、frameCount、fps、blend、name、blendout、blendin、rate、additive、visible、blendtime、addEndedCallback、play、isPlaying、stop、pause、setFrame、getFrame、getAnimation`。
    - **只读三项**：`duration` / `frameCount` / `fps` 是不可写的数据属性，值在建对象时取，严格模式赋值抛 V8 的 `TypeError`（同 `IAnimation`）。
    - **`rate` / `blend` / `visible`**：访问器。
      - 读：`SceneState.animationLayers` 的当前值，float32。
      - 写：只收 number / 只收布尔，其余静默忽略（读码 5）；收下的经 `access.write({ kind: "animation-layer", object, layer, field }, …)` 写进状态，和字段脚本、用户属性是同一个字段，下一帧生效。
    - **`name` / `additive` / `blendin` / `blendout` / `blendtime`**：访问器，直接读写控制口。转换照读码 5：
      - `name`：`null` / `undefined` 忽略，其余 `String(x)`；
      - 三个布尔只收布尔；
      - `blendtime` 只收 number。
    - **方法**：
      - `play` / `pause` / `stop` / `isPlaying` / `setFrame` / `getFrame` 转调控制口；`setFrame` 的参数不是 number 时按 0（同 `IAnimation`）。
      - `addEndedCallback(fn)`：参数不是函数抛 `TypeError`。WPE 会存空指针、播完时崩溃，我们不复刻（有意不同，写进文档）。登记的是 `() => runtime.callFor(当前脚本 id, (exports) => fn.call(exports))`：进入登记它的那段脚本，`this` 是它的模块命名空间。没有当前脚本或没有控制口时不登记。
      - `getAnimation`：用 `installGetAnimation`，属主路径 `objects/<i>/animationlayers/<entry>`（语料下总是 `undefined`，读码 6）。
  - `owner()` 认 `animation-layer`：返回这个包装对象；`thisLayer` 照旧取 `current.layer`（所属图层）。
  - 运行时 `scriptObject(owner)` 对 `animation-layer` 返回 `object`：`animationEvent`、光标回调、`applyUserProperties` 都按所属图层派发（读码 4）。
  - `readScriptState` 加 `animation-layer` 分支：`update(value)` 收到状态里的当前值（`rate` / `blend` 为 `[x]`，`visible` 为布尔）。
- **修改**
  - `ScriptRuntime.callFor(owner, fn)` 的 `fn` 多收一个参数：那段脚本的模块命名空间（`record.exports`）。现有调用（`IVideoTexture`）不用它，不受影响。
  - `MISSING_SCRIPT_API.layer`：删掉 `getAnimationLayerCount`、`getAnimationLayer`。`api.test.ts` 的双向核对要跟着过。
  - `runtime.ts` `targetKey` 的注释：`animation-layer` 目标现在用户属性、字段脚本、API 都会写。
- **注意**：`api.ts`、`runtime.ts`、`scriptApi.ts`、`host.ts` 里有 P11d（快捷方式）会话没提交的改动，只加自己的块，不动别人的行。

## 点 4 — 宿主与 dev 探针接线（`host.ts`、`dev/probe.ts`、`dev/probeScripts.ts`、`dev/particleCorners.ts`）

- **修改**
  - **待用运行时**：照 `pendingAnimations` 的做法，在 `ensureRuntime` 之前按新 bundle 建 `ScenePuppets`，记成 `pendingPuppets = { bundle, puppets }`。`init` 里的 `setFrame` / `play` 就有落点。
    - 正在加载时又来一次重编译：接上一份待用的（`carryOver`），同 P10b 的那一行。
    - `beforeFirstFrame`：待用的属于这份 bundle 时直接用它，不 `carryOver`（首次加载与清空脚本存储后从头来，同 P10b 决定 1）；否则照现在新建并 `carryOver(this.scenePuppets)`。两种情况之后都 `refresh`。
  - `ScriptApiState.puppetLayers`：待用的属于脚本当前看到的 bundle 时取它，否则取 `scenePuppets`；每次现取（同 `animation`）。
  - `stepPuppets`：`frame(dt, stateSink(drawn), { event: (object, json) => this.runtime?.animationEvent(object, json) })`。
  - dev 探针：确定性回放带脚本时，`puppets.frame` 同样传事件钩子；探针的 `ScriptApiState` 给 `puppetLayers`。目的是让 `p12-script` 能按 WPE 的帧时间逐帧回放、比日志。

## 点 5 — 测试

- **`puppet/`**：
  - 播完检测：loop 回绕、mirror 两次换向、single 一次、负 rate 每帧、`setFrame` 那一帧不判、隐藏期间不判且 `SETFRAME` 保留；
  - 事件按层序收集、只在推进时收、每个 puppet 推进完才派发、事件先于播完回调；
  - 模型：权重 0 照发，不可见冻结时不发；
  - `carryOver` 接回五个可写字段与回调表；
  - `findLayer` 取最后一个匹配，改名后按新名字找。
- **`script/`**：
  - 查找规则（用例 9 那张表逐行），以及同一性；
  - 成员顺序与可枚举性；只读三项赋值抛错；
  - 各字段的类型转换（读码 5 的表）；
  - 回调的 `this` 与上下文，回调抛错不禁用；
  - 字段脚本的 `thisObject` / `thisLayer`、`'addEndedCallback' in thisObject`、`update(value)` 的值与写回；
  - 非 puppet / 静态 puppet 的计数 0 与 `null`。
- **`compile/`**：
  - 字段脚本属主回填（含 `entry ≠ layer` 与被丢项的情况）；
  - 键：`rate` / `blend` / `visible` 不报，其余五个报；
  - 缺失表与运行时的双向核对。
- **夹具**：用 `p12-script` 的 WPE 日志与 `g_Bones` 做逐帧夹具（`ignore/p12/out/p12-script-fps20-1856x1044-log.txt`、`wpe-p12-script-consts.json`）。从第 1 帧起按日志的 dt 回放，每帧的 `getFrame:isPlaying`、回调与事件的日志行、`g_Bones` 与 WPE 逐位相同。

## 点 6 — 真机对照与语料（我自己做，不交执行代理）

- **`p12-script`**：在 dev 下按 WPE 帧时间回放（探针跑脚本），脚本日志逐行与 WPE 日志比，`g_Bones` 逐帧比。生成工程再整帧比一组。
- **解锁的 4 张**：`3346715292`、`3361965869`、`3492627662`、`3830665420`。
  - 和 WPE 同一时刻比整帧：语料带用户脚本和音频，按以往做法用 `kbp content isolate` 做复制工程，把音频 / 随机项换成固定值。
  - 顺便核三处推断：缺 NSL 时的 `init` 抛错、对象 5 点击抛 `TypeError`、NSL 排在后面时 `init` 的结果。
  - `3361965869` 的 rate 跟音频，用固定频谱回放。
- **点击路径**：5 张 `cursorClick` 场景在 dev 强制渲染下点一次 puppet，看脚本不报错、动画层下一帧开始播。
- **语料**：`kbp corpus scan` 在实现后的快照上跑，和 HEAD 比：只有上面 4 张从退回变成能渲染，别的场景键集合不变。
- **回归**：P12a / P12b1 / P12b2 的生成工程重渲与之前逐字节相同。

## 点 7 — 收尾

- `cocs/wpe/WPE_SCENE.md`：P12c 一节（规则表、有意不同、走查结果）、cocs 索引一行、`versions/latest/regression.md` 一节、changelog 一行、PLAN.md 与 P12 总计划的进度、本文件的实施记录。

## 待定（向用户确认）

1. **建删层三个方法**：`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`。
   - 用到的场景：语料里 `playSingleAnimation` 用在 `2916324703` 与 `2887099508`。两张都还差别的键（精灵表帧动画、`destroyLayer`），做了也不解锁。
   - 推荐：P12c 不做，照报 `script:api:layer.*`。
   - 另一种：P12c 一起做。工作量：插层位置（`index` / `autosort`）、播完自动删层（`0x08000000` / `0x10000000`）、删层时对字段脚本发 `destroy`、包装对象失效、`setFrame` / 回调表随层销毁，外加生成工程实测。
2. **步骤划分**：
   - 推荐分两个执行代理：
     - **P12c-1**：点 1 + 点 2，纯编译期与运行时，带单测；
     - **P12c-2**：点 3 + 点 4，脚本 API 与宿主接线。
   - 每步之后我独立审查、跑 tsc 与相关测试、做变异检查，然后做点 6 的对照与点 7 的收尾。

## 实施记录

### 决定（2026-11-15 用户：按推荐开始）
- 建删层三个方法不做，照报 `script:api:layer.*`；分 P12c-1 / P12c-2 两个执行代理。

### P12c-1 — 编译期与运行时（2026-11-15）
- 执行代理（sonnet）按点 1、点 2 实现，新测试 `puppet/p12c.test.ts`、`compile/p12c.test.ts`。
- 主会话审查：播完判据、`SETFRAME` 只在可见并推进的层上清、事件先于播完回调、属主按 `entry` 回填，都与读码一致。
- 变异 15 个，第一轮存活 1 个（loop 判据 `>` 改 `>=`，只在 rate 0 时有区别），补「rate 0 不触发」后 15 个全杀。

### P12c-2 — 脚本 API 与接线（2026-11-15）
- 执行代理（sonnet）按点 3、点 4 实现，新测试 `script/animationLayerApi.test.ts`、`puppet/p12script.test.ts`（夹具 `puppet/fixtures/p12-script.json`，抽取 `ignore/p12/c/impl2/mkfix_script.py`）。
- 执行代理自己拿主意的几处（审查后保留）：
  - `animationLayerValue` 对 number 原样收（含 `NaN` / `Infinity`），否则状态层会丢掉 `rate = NaN`；
  - `IAnimationLayer` 的原型只有一个不可枚举 `constructor`（WPE 实测）；
  - 探针回放有 puppet 时先 `enterFrame` 再推进 puppet，回调读到本帧的 `engine.runtime`。
- `p12-script` 夹具：266 帧、WPE 日志 642 行逐行相同。
  - `g_Bones` 100 帧最大 4 ulp（5.96e-8），来源是 P12a 记录的 `rsqrtps`；执行代理照要求没放宽断言，主会话把这一条改成 P12a 的容差（≤ 5 ulp 或 ≤ 2e-6），注释写明理由。
- 主会话审查与变异：17 个变异杀死 14 个、跳过 1 个（双处匹配）。
  - 「空串照查」是等价变异：两条查找路径本来就对空串返回 −1。
  - 宿主的「不建待用运行时」「不派发事件」两处单测覆盖不到，归真机验证（下）。
- 另加 dev 探针 `host.puppets()`（`host.puppetProbe`）：每个 puppet 每层的名字、帧号、是否在播，用来在屏外宿主里看 `init` 的控制落没落到运行时。

### 真机对照（2026-11-15）
- **`p12-script`**：dev 按 WPE 帧时间回放到第 201 帧、跑脚本，和 WPE 抓帧比整帧：最大差 1 级，> 0 的像素 0.23%（边缘，`rsqrtps` 差）。5 段脚本 0 出错，字段脚本收到 13 次事件、主脚本 24 次播完回调。
- **解锁的 4 张**：`content unpack --instrument` 复制工程，WPE 各抓 1 帧（fps 20、后处理 ultra），dev 回放到同一帧（脚本时钟设到 WPE 开窗时刻）。
  - `3346715292`：
    - WPE 与我们都是 6 段 `init` 因缺 NSL 抛 `TypeError`（推断成立）；
    - `g_Bones` 1 个 draw / 384 个数：超出 P12a 容差的 15 个全在平移分量，差 ≈ 1e-5（数值 8–30，`rsqrtps` 被平移放大，同 P12a）；
    - 整帧差在光束、音频条与时钟文字，不在 puppet 上。
  - `3492627662`：
    - 230 段脚本 0 出错，NSL 排在使用者后面不影响；
    - `g_Bones` 3 个 draw 一一对上，超出容差的 5 个同样全在平移分量（≈ 7.6e-6）；
    - NSL 在 `init` 里设的起始帧与 WPE 一致。
  - `3361965869`（用户同意后显示主窗口再渲）：
    - 95 段脚本 0 出错；
    - 4 个 puppet 里，点击才播的两个（对象 50、51）`g_Bones` 与 WPE 逐位相同；
    - 另两个（对象 5「鼓点光环」、46「鼓点方框」）的 `rate` 字段脚本是 `(audioBuffer.average[0] || 0.1) × 5`，跟系统声音走。抓帧时 WPE 的音频值无法复现（探针缓冲全 0），不做确定性对照。
  - `3830665420`：
    - 起先建 GPU 资源时，文本层的合成 RT 9787×199 超过设备上限 8192，画不出来（F2）；
    - 修 F2 后 94 段脚本 0 出错，26 个 puppet draw 的 `g_Bones` 对上，超出容差的同样全在平移分量（≈ 1e-5，跨零处 ulp 数大但绝对差 6e-5）；
    - 整帧差只在粒子（蝙蝠、亮点，随机种子）。
- **宿主路径**（用户同意接管主窗口预览后做，做完恢复了用户原来的预览）：
  - **帧循环**：`p12-script` 实时预览 6 秒，MDLA 事件经宿主钩子派发 10 次、播完回调 19 次、0 出错，4 层帧号各自推进。
  - **待用运行时**：`3492627662` 开场 1.85 s 时同一 puppet 三层帧号 55.42 / 43.42 / 24.22。第 1 层 = 1.847 s × 30 fps，第 2 层不可能由取余得到，所以 `init` 里 NSL 的 `setFrame` 落到了待用运行时上。
  - 隐藏宿主在主窗口隐藏或预览被占用时只跑 1 帧，不适合验帧循环。
- **语料**（工作区快照，含别的会话未提交的改动，HEAD `fb9c2bc2`）：
  - 能渲染 160 → 182，`clean_lost` 0；
  - P12c 的三个键全部消失（`getAnimationLayer` 10、`puppet:layer-script` 8、`getAnimationLayerCount` 3）；
  - 新增键只有 P13d 的 `spot-shadow`；
  - 解锁的 22 张里含预期的 4 张，`3276911872`、`3308867900` 是 P12c 加光束修复一起才解锁。
- **回归**：P12a / P12b1 / P12b2 的 8 个生成工程 22 帧重渲，和 P12b2 check2 逐字节相同；修 F2 之后再渲一遍，仍全部相同。

**F2（走查发现，用户定：随 P12c 修）**：
- **问题**：`acquireGpu`（`render/device.ts`）申请设备时不带 `requiredLimits`，`maxTextureDimension2D` 是 WebGPU 缺省的 8192；WPE（D3D11）是 16384。`3830665420` 的一个文本层 `size` 9787×199、带 effect，合成 RT 建不出，场景在产品里同样会失败退回。
- **修法**：`requiredLimits.maxTextureDimension2D` 取适配器支持的最大值。按 `device.limits` 钳的地方（场景目标、用户纹理、探针画布）随之放宽到同一个值。
