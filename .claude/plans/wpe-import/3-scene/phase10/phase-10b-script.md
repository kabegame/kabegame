# P10b — 脚本控制与动画事件（子计划）

> 上级：[P10 总计划](phase-10-keyframes.md)「P10b — 脚本与事件」。WPE 语义以 [rea-p10-keyframes](rea-p10-keyframes.md) 第 7、8、9、11 节与 [p10-REPORT](p10-REPORT.md)「脚本」一节为准；P10a 没测到、P10b 要用的几处在步骤 0 补测。
> 现状行号按 HEAD `b41ef433`。工作区里 P6b 步骤 2（`ITextLayer`）未提交，改着 `script/api.ts`、`compile/scriptApi.ts`、`script/api.test.ts`、`compile/scriptApi.test.ts`、`host.script.test.ts`，和本节同一批文件，见「和其它会话的交界」。
> 语料统计：`ignore/p10/b0/scan_getanim.py`（输出 `getanim.json`）、`callbacks.py`。

## 总体设计思路

P10a 已经把关键帧做成了每帧的第三种写入方：播放器 `SceneAnimations` 持有全部时钟，宿主每个实时帧在脚本之前调 `frame()`。时钟的控制方法（`play` / `pause` / `stop` / `setFrame` / `getFrame` / `isPlaying`）和每条的 `rate` 也都按 WPE 写好了，只是没有人调。P10b 只接两条线，不加新的写入通路：

- **脚本 → 播放器**：`getAnimation` 按名字在脚本看到的 bundle 里找到一条动画，返回一个 `IAnimation` 包装对象。包装对象只记动画的 `id`（`scene.json` 路径），每次调用都经宿主现取当前播放器上的那一条，做法同 P9b 的 `IVideoTexture`。WPE 的包装对象 W 按绑定缓存、`rate` 存在 W 上；我们按 `id` 缓存 JS 对象，`rate` 存在播放器的那一条上（P10a 的 `carryOver` 已经跨重编译接它）。
- **播放器 → 脚本**：时钟推进时收到的事件，在越过它的那一条写完之后、下一条之前，当场交给脚本运行时。运行时把它发给同一对象（或 `general`）上导出了 `animationEvent` 的全部脚本，参数是 `JSON.parse` 出的作者事件对象和接收脚本自己属性的当前值，返回值写回那个属性，同 `update`。派发是同步的，所以回调里对别的动画调 `stop()`，排在后面的那条本帧就生效，和 WPE 的循环一样。

查找与派发的范围不同（步骤 0 Q1、Q3 实测）：
- **`getAnimation` 按属主找**，属主和联动的相同：图层字段归图层，effect 常量归它所在的材质 pass，effect 的 `visible` 归 effect，`general` 的归 `general`。所以图层上找不到 effect 常量的动画，effect 常量上找到的是自己那条。
- **事件按图层发**：同一图层上的字段脚本和 effect 常量脚本都收到（读码第 8 节，P10 与本节步骤 0 都实测过）。

照 WPE 的几条规则直接决定了实现形状：
- **子动画有自己的时钟**：子画面上借父的时钟，但脚本对子调 `play` / `pause` / `setFrame` / `rate`，改的是子自己那个永远不推进的时钟，`getFrame` 也读它（读码第 7 节，实测吻合）。P10a 里子没有时钟（`clock: null`），这里给每条都建一个，推进与求值仍只用主人的。
- **丢弃的动画也找得到**：`options` 不合法的动画 WPE 照样登记、`getAnimation` 找得到，时钟不走（读码第 5 节，步骤 0 Q7：`fps` 读出 1、`duration` 0、`isPlaying()` 真）。P10a 的编译期不收它们，这里收进列表、标成惰性。反过来，材质常量在着色器里没有 uniform 的，WPE 不建绑定，找不到（P10a 的 `settleConstantAnimation` 已标出）。
- **`init` 里就能控制**：WPE 先登记全部动画再 `init`，所以 `init(){ thisObject.getAnimation().play() }`（`3336377291` 等）开场就播。我们首次加载时脚本 `init` 在 `beforeFirstFrame` 建播放器之前跑，所以要在跑 `init` 之前就按新 bundle 建好播放器，换上时直接用它。
- **`setFrame` 下一帧才写、脚本写回只活一帧**：写入在脚本之前，这两条自然成立，不用特别处理。
- **登记顺序**（步骤 0 Q3 与 `p10b-order`）：WPE 的脚本列表与动画列表都按「`general` 的字段 → 每个对象自己的字段 → 它的 effect（先 `visible`，再各 pass 的常量）」登记，同一层按键名字母序。我们按 JSON 书写顺序遍历；WPE 写的 `scene.json` 键本来就按字母序，差别只在 effect 写在 `origin`、`visible` 等字段之前。这个顺序决定事件派发给多个脚本的先后、`thisScene.getAnimation` 取到哪一条，也决定 `init` / `update` 的先后（语料 27 张不同），见「决定 3」。

P10b 不碰媒体回调（P11）和光标回调（P6c）：语料里 27 张用 `getAnimation` 的场景，23 张有调用在这两类回调里，这些场景照样因为 `script:callback:*` 退回，等那两节。

## 范围与覆盖

- **调用**（`getanim.json`）：128 处、27 张。
  - 接收者：`thisObject` 115、`thisScene.getLayer(…)` 10、`thisLayer` 3，语料里没有 `thisScene.getAnimation`；
  - 不带参数 115 处，全部取调用脚本所挂属性的动画；
  - 属主：图层字段 90、effect 常量 38；
  - 「按图层找」和「按属主找」第一条结果不同的：0 处。
  - 在本对象里找不到的 16 处：12 处挂在 `animationlayers/*` 上（puppet，归 P12）；`3219908811` 的 `objects/3` 按名字找别的层上的 `LogoShake`，WPE 里也拿到 `undefined`（在 `cursorClick` 里，P6c）。
- **回调**（`callbacks.py`）：
  - 调用全在已实现回调里的：`2887099508`（导出 `animationEvent`，`objects/17`、`objects/18`）、`3336377291`（`init`）、`3486806915`、`3830665420`（`init`，后两张的动画层归 P12）；
  - 部分在 `init`、其余在光标或媒体回调里的：`3219908811`、`3400241651`、`3427691867`、`3492627662`，复制工程只留 `init` 那部分的对象就能走查；
  - 其余 19 张只在光标或媒体回调里（18 张是 `media*Changed`，`3611425904` 是 `cursorClick`）。
- **事件**：`2887099508` 一张，`events` 2 条；三段脚本导出 `animationEvent`（`objects/17/visible`、`objects/18/visible`、`objects/18/…/constantshadervalues/point1`）。

能力键：去掉 `script:api:object.getAnimation`、`script:api:thisScene.getAnimation`、`script:callback:animationEvent`。解锁多少张在步骤 2 的语料扫描里算，预计很少：多数场景还差 P6c / P11 / P12。

## 现状锚点

**a. 编译期把两个 `getAnimation` 和 `animationEvent` 报成缺失**（`compile/scriptApi.ts:79`、`:189`、`:506`）
```ts
  thisScene: [
    ...methods("root", [
      // …
      "getAnimation", // 现状：thisScene.getAnimation 报 script:api:thisScene.getAnimation
    ]),
  ],
  object: methods("any", ["getAnimation"], UNIQUE), // 现状：任何接收者 .getAnimation 都报 script:api:object.getAnimation
// …
export const MISSING_SCRIPT_CALLBACKS: readonly string[] = [
  // 关键帧动画的事件 → P10
  "animationEvent", // 现状：导出了就报 script:callback:animationEvent
```

**b. 运行时只调四个回调，`call` 只带一个参数**（`script/runtime.ts:27`、`:192`）
```ts
export const RUNTIME_CALLBACKS = ["init", "update", "applyUserProperties", "destroy"] as const;
// …
  private call(record: ScriptRecord, callback: Callback, argument?: unknown): unknown {
    if (record.disabled.has(callback) || !record.exports || typeof record.exports[callback] !== "function")
      return undefined;
    return this.invoke(record, callback, () => (record.exports![callback] as (arg?: unknown) => unknown)(argument)); // 现状：一个参数
  }
```

**c. 子动画没有自己的时钟；事件只收不派发**（`animation/player.ts:82`、`:145`、`:159`、`:178`）
```ts
  rate: number; // 现状：P10a 恒为 1，注释写着「P10b 的 IAnimation 包装对象改它」
  // …
  readonly events: AnimationEventRecord[] = []; // 现状：每帧开头清空，只记不派发
  // …
        clock: owner === index ? new AnimationClock(def.clock, def.events) : null, // 现状：子为 null，借父的
  // …
  frame(dt: number, state: AnimationSink, onSound?: AnimationSoundHook): void {
      // …
      if (owner.advancedAt !== serial) {
        // …推进主人的时钟，事件追加到 this.events
      }
      if (track.active) this.writeTrack(track, clock, state, onSound); // 现状：写完不派发
```

**d. 编译期不收丢弃的动画，也没有名字与所属对象**（`compile/animations.ts` 的 `add`；`animation/types.ts` 的 `SceneAnimation`）
```ts
    const clock = clockOf(options);
    if (!clock || !isRecord(options)) return; // 现状：丢弃的不进列表（WPE 照样登记、getAnimation 找得到）
    // …
    list.push({ id: path, target, valueType, channels, clock, parent: null, events, writes }); // 现状：没有 options.name、没有场景对象
```

**e. 视频纹理的包装对象：按图层缓存、每次调用现取落点**（`script/api.ts:385`，HEAD）
```ts
    this.method(api, "getAnimation", () => undefined); // IVideoTexture 上的 getAnimation（WPE 有这个成员）
    this.videoTextures.set(object, api);
```
图层、effect、材质、`general` 四种 API 对象上都没有 `getAnimation`（`layer()` `:205`、`effect()` `:733`、`material()` `:690`、`installGeneral`）；`thisScene` 的方法在 `installScene`（`:659`）。

**f. 首次加载：脚本 `init` 先跑，播放器在首帧前才建**（`host.ts:1033`、`:1054`）
```ts
      if ((!this.runtime || this.runtimeTask) && bundle.scripts.list.length && !this.scriptUnavailable) {
        this.scriptBundle = bundle;
        this.scriptState = SceneState.fromBundle(bundle);
        await this.ensureRuntime(bundle, target.sceneAssets); // 现状：init 在这里跑，这时还没有这份 bundle 的播放器
      }
      // …
        beforeFirstFrame: (state) => {
          // …
          const animations = new SceneAnimations(bundle.animations ?? []); // 现状：首帧前才建
          animations.carryOver(this.sceneAnimations);
```

**g. 每帧：动画在脚本之前，事件没有出口**（`host.ts:870`）
```ts
      beforeFrame: (dt, spectrum) => {
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) {
          const drawn = this.drawnState;
          if (drawn) this.sceneAnimations?.frame(dt, drawn, this.pushSoundVolume); // 现状：事件收了不发
          this.runtime?.frame(dt);
        }
      },
```

**h. dev 探针跑脚本时同样只推进动画**（`dev/particleCorners.ts` 的 `replayReadback` / `replayEncoded`，`options.animations` 与 `options.scripts`；`dev/probeScripts.ts` 建 `ScriptApi` 时不给动画）

## 步骤 0 — 补测（WPE，只测不改产品代码）

P10 步骤 0 已经测过 `IAnimation` 的语义、查找规则和事件时机。下面几处 P10a 用不到、当时没测，P10b 要照着实现：

| # | 问题 | 写法 | 读码 / 推断 |
|---|---|---|---|
| Q1 | `getAnimation` 的对象范围 | 同一图层两个 effect，常量 `multiply` 都有动画、都不写 `name`；第二个 effect 常量上的脚本调 `thisObject.getAnimation()`，`play()` 后看哪条动；图层脚本调 `thisLayer.getAnimation('multiply')` | `vfunc8()` 没读透。按图层：前者拿到第一个 effect 的，后者找得到；按属主：前者拿到自己的，后者找不到 |
| Q2 | 联动的属主 | 一个 effect 的 pass 0 写父 `Opacity`（`startpaused`），pass 1 写子 `Aperture`（`parent.key: "Opacity"`）；另一组父、子分在同一图层的两个 effect 上 | P10a 的 TODO（`compile/animations.ts`）：按 pass 算子用自己的时钟，按 effect / 图层算子跟父停住 |
| Q3 | 多个接收者的派发顺序 | 同一图层 `origin`、`visible`、effect 常量上的脚本都导出 `animationEvent`，各自记一行 | 读码只说遍历全部脚本绑定（`P+0xd8` 链表），没说顺序 |
| Q4 | 包装对象的形状 | `Object.keys(a)`、每个成员的 `typeof`、`a === thisObject.getAnimation()`；严格模式下写 `fps` / `frameCount` / `duration` / `name` 抛不抛、读回；`rate` 写 `'2'`、`{x: 2}`、`NaN`、`true` 后读回与推进速度；`setFrame('30')`、`setFrame()` | 成员顺序按属性表再方法表（读码第 11 节）；`rate` 的 setter 只拷 4 字节，类型转换在 dll，没读 |
| Q5 | 模块顶层调用 | 模块顶层 `thisScene.getAnimation('x')`，`try` 记结果 | `getLayer` 等在模块求值期间抛错（P3 报告 D），`getAnimation` 没核对 |
| Q6 | 空名字 | `thisScene.getAnimation('')`、`thisObject.getAnimation('')` | 前者推断返回第一条没写 `name` 的动画；后者有字符串参数但为空，取属性名 |
| Q7 | 丢弃的动画 | `fps: 0` 的一条带 `name`，`thisScene.getAnimation(name)` 记 `fps` / `frameCount` / `duration` / `getFrame()`，`play()` 后看画面 | 读码：找得到、时钟 `D = 0` 不走，字段值没读 |
| Q8 | 回调里控制排在后面的动画 | 图层 A 的 `animationEvent` 里对图层 B（排在后面）的动画 `stop()`，B 的 `update` 记本帧收到的 `value` | 同步派发：B 本帧就是第 0 帧的值 |

- **工程**：`ignore/p10/defs/p10.py` 加 `p10b-api`（沿用 `script()`、`kf_layer()` 等写法与 `[kf]` 日志，FR 用精确日志 `@f64`）。
- **录制**：`wpe-renderdoc` 测试窗口 1920×1080，fps 20，抓 `capture_sweep` 的日志与 3 段各 3 帧（Q1、Q2、Q8 要看画面），落 `A:\p10b\s0\`。
- **产出**：`p10-REPORT.md` 新增「P10b 补测」一节（每问一行：写法、WPE 结果、和读码是否一致）；读码文档对应处补注。结果和上表的推断不同的，改本计划后再实现。

**验收**：8 问都有结论；推翻推断的，在本计划「实施记录」写明改了哪里。

## 步骤 1 — 播放器与编译期（`animation/`、`compile/animations.ts`）

只改 P10a 的文件，不碰共享文件。

- **修改 `animation/types.ts`**：`SceneAnimation` **新增**：
```ts
  /** `options.name`：不是字符串时为空串（WPE `B+0x68`）。`getAnimation` 按它或属性名找。 */
  name: string;
  /** 所属场景对象：`objects` 下标，`general` 的为 null。事件的接收范围（读码第 8 节；步骤 0 Q3）。 */
  object: number | null;
  /**
   * 属主路径：`id` 去掉最后一段（图层字段 `objects/3`、effect 常量 `…/passes/0/constantshadervalues`、effect 的 `visible`
   * `objects/3/effects/1`、`general`）。`getAnimation` 的查找范围与联动的父都在同一属主内（步骤 0 Q1、Q2）。
   */
  owner: string;
  /** 整条丢弃（`clockOf` 为 null）：WPE 照样登记、`getAnimation` 找得到，时钟不走、不写（读码第 5 节第 1 条，步骤 0 Q7）。 */
  inert: boolean;
```
- **修改 `compile/animations.ts`**：
  - **修改** `add`：丢弃的不再 `return`，收进列表：`inert: true`、`writes: false`、`channels: []`、`events: []`，时钟照步骤 0 Q7：`spf` 1、`D` 0、`flags` 0（不看 `startpaused`），`length` 是数时截断、否则 0（后者推断）。灯 / 相机 / 没有就地目标的照旧不进列表、照报（场景本来就退回）。
  - **新增** 填 `name`、`object`、`owner`；联动改用 `owner` 比较（和现在的 `ownerOf` 相同）。
  - **删除** 联动属主的 TODO：步骤 0 Q2 实测按 pass（同一 effect 的两个 pass、两个 effect、图层字段对 effect 常量，子都不跟父）。
  - **修改** 遍历顺序照 WPE 的登记顺序（决定 3）：对象里先遍历除 `effects` 以外的键，再 `effects`；effect 里先 `visible` 再 `passes`；同一层按键名字节序（`compareKeys`）。`collectScripts` 同样改（`compile/scripts.ts`），两份遍历共用一个排序函数。
  - 语料：丢弃的条数在步骤 2 的扫描里报出（总计划的统计是 0）。
- **修改 `animation/clock.ts`**：
  - **新增** 惰性时钟：`inert` 时 `spf` 1、`D` 0、`flags` 0、`length` 照收，`advance` 因 `D ≤ 0` 直接返回；`getFrame` 恒为 0（Q7）。
- **修改 `animation/player.ts`**：
  - **修改** `Track.clock`：每条都有自己的时钟，子的永远不推进；推进、求值、`carryOver` 的「接时钟」仍只用主人的，子的时钟也接（脚本可能改过它）。
  - **修改** `frame(dt, state, hooks?)`：钩子收拢成一个对象。时钟推进时收到的事件，在这一条写完（或不写）之后、下一条之前逐个交给 `hooks.event`；事件属于主人的时钟，接收范围取主人的 `object`。
  - **新增** `control(id)`：返回这一条的控制对象（`AnimationControl`），没有这一条时返回 null。
  - **新增** `seek` / `probe` 不变；`probe` 的每条加 `name`、`rate`。
  - **删除** `events` 字段（派发后不再需要留着）；探针要看事件时另记最近 N 条（`probe().events`，dev 用）。

```ts
// animation/player.ts（修改）
export interface AnimationHooks {
  /** 写过声音对象 `volume` 之后（P10a）。 */
  sound?: AnimationSoundHook;
  /** 主人的时钟本帧越过的一个事件：在越过它的那一条处理完之后、下一条之前同步调用（读码第 1 节第 3 条、第 8 节）。 */
  event?: (event: { animation: number; object: number | null; json: string }) => void;
}

/** `IAnimation` 的落点：成员照读码第 11 节，读写的都是这一条自己的时钟（子动画的脚本控制不影响画面）。 */
export interface AnimationControl {
  rate: number;              // 存在这一条上，推进用主人的（WPE W+0xd0）
  readonly fps: number;      // f(1 / spf)
  readonly frameCount: number;
  readonly duration: number; // D
  readonly name: string;
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  getFrame(): number;
  setFrame(frame: number): void;
}

  frame(dt: number, state: AnimationSink, hooks: AnimationHooks = {}): void {
    // …
    for (let i = 0; i < tracks.length; i++) {
      // … 主人本帧第一次用到时推进，事件收进 scratch（P10a）
      if (track.active) this.writeTrack(track, clock, state, hooks.sound);
      // 新增：本条推进出的事件，在下一条之前派发；回调里对排在后面的动画调 stop() 本帧就生效
      for (const event of pending) hooks.event?.({ animation: track.owner, object: tracks[track.owner].def.object, json: event.json });
      pending.length = 0;
    }
  }
```

**单测**（`player.test.ts`、`clock.test.ts`）：
- 子动画：`control(子).pause()` / `setFrame(0)` / `rate = 0` 后写入的值照父走，`control(子).getFrame()` 一直 0（`p10-edge` 的同一用例）；父 `rate = 2` 子跟着加速；
- 事件派发：越过事件的那一条写完后、下一条写之前调用（替身记调用序列）；`loop` 回绕帧的顺序；子排在父前面时父的事件在子那一条之后派发；`writes` 为假的照派发；
- 钩子里对排在后面的一条 `stop()`，那一条本帧写第 0 帧的值；
- 惰性：不推进、不写、`play()` 无效，`control` 照常返回；
- `carryOver` 接回子的时钟与 `rate`；
- 编译：`name` / `object` / `inert` 三种来源（图层字段、effect 常量、`instanceoverride`、`general`）。

## 步骤 2 — 脚本 API 与运行时（`script/api.ts`、`script/runtime.ts`、`compile/scriptApi.ts`）

- **修改 `compile/scriptApi.ts`**：
  - **删除** `thisScene` 组的 `getAnimation`、`object` 组整组（只有它一个成员），注释同步；
  - **删除** `MISSING_SCRIPT_CALLBACKS` 里的 `animationEvent`。
- **修改 `script/runtime.ts`**：
  - **修改** `RUNTIME_CALLBACKS` 加 `animationEvent`；`call` 改成带参数表。
  - **新增** `animationEvent(object, json)`：按记录顺序遍历（决定 3 之后就是 WPE 的登记顺序，步骤 0 Q3），只发给 `inited`、导出了 `animationEvent`、没禁用、接收范围相同的脚本。`event` 在 realm 里 `JSON.parse`，`value` 同 `update` 现读接收脚本自己的属性，返回值经 `writeReturn` 写回。出错只禁用这个回调（同其它导出回调）。

```ts
// script/runtime.ts（新增）
/** 脚本的接收范围：图层字段、effect、材质常量（`owner.layer`）归图层，`general` 的归场景（null），同动画的 `object`（读码第 8 节）。 */
export function scriptObject(owner: ScriptOwner): number | null {
  return owner.kind === "general" ? null : owner.kind === "material" ? owner.layer : owner.object;
}

  animationEvent(object: number | null, json: string): void {
    if (this.halted) return;
    for (const record of this.records) {
      if (record.state !== "inited" || scriptObject(record.script.owner) !== object) continue;
      const parse = (this.realm.global.JSON as JSON).parse;
      const result = this.call(record, "animationEvent", parse(json), this.value(record));
      this.writeReturn(record, result);
      if (this.halted) break;
    }
  }
```
- **修改 `script/api.ts`**：
  - **新增** `ScriptApiState.animation?(id: string): AnimationControl | null`：宿主按脚本当前看到的 bundle 取播放器的那一条。
  - **新增** `getAnimation` 装到图层、effect、材质、`general` 四种对象上（`installObject`），以及 `thisScene`：
    - 查找只在脚本看到的 bundle 的 `animations` 里，按列表顺序取第一条 `def.name === 名字 || 属性名(def.id) === 名字`；跳过 WPE 不建绑定的（常量目标 `uniforms` 为空）。
    - 对象上：范围是这个 API 对象的属主（图层 `objects/<i>`，材质 `<pass>/constantshadervalues`，effect `objects/<i>/effects/<e>`，`general`；步骤 0 Q1）；参数是非空字符串时用它，否则（空串、非字符串、不带参数）用当前脚本的属性名（`script.id` 的最后一段，Q6），没有当前脚本时是空串；找不到返回 `undefined`。
    - `thisScene` 上：全场景；参数不是字符串返回 `null`，找不到返回 `null`；空串照常查，取到第一条没写 `name` 的动画（Q6）。
    - 两种都不能在模块求值期间调：抛 realm 的 `SyntaxError`，消息照 WPE 写 `getAnimation cannot be called from global scope.`（Q5）。
  - **新增** `animationApi(id)`：`IAnimation` 包装对象，按 `id` 缓存（同一条每次拿到同一个对象，Q4）。照 Q4：
    - 12 个自有、可枚举的成员，按 `name`、`frameCount`、`duration`、`fps`、`rate`、`play`、`isPlaying`、`stop`、`pause`、`setFrame`、`getFrame`、`getAnimation` 的顺序定义；
    - `name` / `frameCount` / `duration` / `fps` 是不可写的数据属性，值在建对象时按这一条的时钟定（它们不会变），严格模式下赋值抛 V8 自己的 `TypeError`，和 WPE 同一条消息；
    - 方法也是数据属性（同一个函数对象），每次调用经 `access.animation(id)` 现取落点，没有落点时空操作、`isPlaying()` 假、`getFrame()` 0；`getAnimation` 返回 `undefined`（同 `IVideoTexture`）；
    - `rate` 是访问器（读写要过落点）：只收 `typeof` 为 number 的值（`NaN` 也收），别的忽略；描述符和 WPE 的原生数据属性不同，记为已知差异；
    - `setFrame(f)`：`f` 不是数时按 0；
    - 原型是普通的 `Object.prototype`（WPE 是只有 `constructor` 的原型），记为已知差异。

```ts
// script/api.ts（新增，形状；成员顺序与转换以步骤 0 Q4 为准）
  private animationApi(id: string): ApiObject {
    let api = this.animationApis.get(id);
    if (api) return api;
    api = this.object();
    const target = () => this.access.animation?.(id) ?? null;
    const info = target(); // 建对象时取一次只读成员（它们按这一条的时钟定，不会变）
    const constant = (name: string, value: unknown) => defineValue(api, name, value, { writable: false });
    const fn = (name: string, run: (...args: unknown[]) => unknown) => defineValue(api, name, run, { writable: true });
    constant("name", info?.name ?? "");
    constant("frameCount", info?.frameCount ?? 0);
    constant("duration", info?.duration ?? 0);
    constant("fps", info?.fps ?? 1);
    this.define(api, "rate", () => target()?.rate ?? 1, (value) => {
      const control = target();
      if (typeof value === "number" && control) control.rate = Math.fround(value); // 只收数字，NaN 也收（Q4）
    });
    fn("play", () => void target()?.play());
    fn("isPlaying", () => target()?.isPlaying() ?? false);
    fn("stop", () => void target()?.stop());
    fn("pause", () => void target()?.pause());
    fn("setFrame", (frame) => void target()?.setFrame(typeof frame === "number" ? frame : 0)); // 不是数按 0（Q4）
    fn("getFrame", () => target()?.getFrame() ?? 0);
    fn("getAnimation", () => undefined);
    this.animationApis.set(id, api);
    return api;
  }
```

**单测**：
- `script/api.test.ts`：
  - 查找：对象上不带参数取属性名、按 `name`、按属性名、找不到 `undefined`；`thisScene` 不带参数 `null`、找不到 `null`；登记顺序取第一条；别的对象上的找不到；常量没有 uniform 的找不到；丢弃的找得到；
  - 包装对象：同一条同一个对象；11 个成员落到 `AnimationControl`；没有落点时空操作；
  - 双向核对（已有）：`RUNTIME_CALLBACKS` 与 `MISSING_SCRIPT_CALLBACKS` 合起来仍是 WPE 的 19 个。
- `script/runtime.test.ts`：
  - `animationEvent` 只发给同一对象、`inited`、导出了的脚本；`general` 的发给 `general` 的脚本；参数是 realm 对象与接收脚本自己的值；返回值写回；抛错后禁用、别的照发；停止后不发。
- `compile/scriptApi.test.ts`：三个键不再报；`getAnimationLayer` 等 P12 的照报。

## 步骤 3 — 宿主与 dev 探针（`host.ts`、`dev/`）

- **修改 `host.ts`**：
  - **新增** `pendingAnimations: { bundle, player } | null`：加载路径里要跑 `init` 时（锚点 f 的分支），先按新 bundle 建好播放器，`init` 里的控制有落点。
  - **修改** `beforeFirstFrame`：这份 bundle 有待用的播放器就直接用（不再 `carryOver`），否则照旧新建并 `carryOver`。
  - **新增** `ScriptApi` 的 `animation(id)`：待用的播放器属于脚本当前看到的 bundle 时取它，否则取 `sceneAnimations`。
  - **修改** `beforeFrame`：`frame` 带上事件钩子，交给 `this.runtime?.animationEvent(object, json)`。
  - **修改** 「清空脚本存储」：动画一起从头来（决定 1）：新脚本 `init` 之前建的待用播放器不接旧时钟。

```ts
// host.ts（修改，锚点 g）
          if (drawn)
            this.sceneAnimations?.frame(dt, drawn, {
              sound: this.pushSoundVolume,
              // 新增：越过事件的那一条写完就派发，在 update 之前（rea-p10-keyframes 第 1、8 节）
              event: ({ object, json }) => this.runtime?.animationEvent(object, json),
            });
          this.runtime?.frame(dt);
```
- **修改 dev 探针**：
  - `dev/probeScripts.ts`：建 `ScriptApi` 时给 `animation`（探针自己的播放器）；暴露 `animationEvent` 给回放。
  - `dev/particleCorners.ts`：`replayReadback` / `replayEncoded` 推进动画时把事件钩子接到 `scripts`；首帧前（`init` 之前）建好播放器，`init` 里的 `play()` 有落点。
  - `dev/probe.ts`：`renderFrame` 跑脚本时同上；结果的 `animations` 带上 `events`。

**单测**：
- `host.script.test.ts`：
  - 首次加载 `init` 里 `getAnimation().play()`，第一帧就推进（`startpaused` 的动画）；
  - 重编译后同一个包装对象仍控制同一条，`rate` 保留；
  - 事件：`animationEvent` 在 `update` 之前、返回值写回；
  - 清空脚本存储后动画从头来，新 `init` 里的 `play()` 生效（决定 1）。
- `dev/replayAnimations.test.ts`：跑脚本的回放里 `init` 播放、事件派发和宿主同一个序列。

## 步骤 4 — 走查（按 `FINAL_CHECK.md`）

- **4a 生成工程**（子代理，Sonnet）：
  - `p10-script`、`p10-edge` 里 P10a 步骤 4a 按 bbox 排除的 P10b 对象（`ctl`、`ctls`、`ovr`、`ovrinit`、`names`、`ev`、`evn`、`evp`、`evother`、`link`、`link2`、`byprop` 等），用同一份 WPE 录制，`renderFrames.ts --scripts` 单开宿主逐帧回放（脚本按录制的 `runtime` 与帧时间走），`kbp cmp frames --meta` 逐帧比，目标逐像素相同；
  - 步骤 0 的 `p10b-api` 同样录制、回放、比较；
  - 两边的 `[kf]` 日志逐行比（帧号、`getFrame`、`isPlaying`、事件名与参数），不同的逐条解释。
- **4b 真实壁纸的复制工程**（主会话）：`kbp content isolate`，只留调用全在已实现回调里的对象及其父链、依赖与脚本：
  - `2887099508` 的 `objects/17`、`objects/18`（事件）；
  - `3336377291`（`init` 里播放）；
  - `3427691867` 的 `objects/4`、`objects/5`（`init` 里播放；光标回调在别的对象上，不留）；
  - `3219908811`、`3400241651` 的 `init` 部分，能渲染就做。

  每张录 WPE、确定性回放、逐帧比，差异逐处落到 draw 与值。
- **语料**：`kbp corpus scan` 和 HEAD 比，只少了三个键；解锁的场景列出来，各开一次强制渲染看脚本诊断没有错误。27 张用 `getAnimation` 的场景在 dev 强制渲染下脚本不报错（总计划的验收），光标、媒体回调里的调用要等 P6c / P11。

## 步骤 5 — 收尾

- `cocs/wpe/WPE_SCENE.md` 的「关键帧动画」一节加 P10b，能力表与 `cocs/README.md` 同步；
- `versions/latest/regression.md` 加用例、`changelog.md` 一行；
- `PLAN.md` 与总计划记进度；本文件写实施记录。

## 和其它会话的交界

- **P6b 步骤 2（未提交）**：改着 `script/api.ts`（`installText`）、`compile/scriptApi.ts`（删文本字段）、`script/api.test.ts`、`compile/scriptApi.test.ts`、`host.script.test.ts`。步骤 2、3 要改同一批文件：
  - 它提交了就在新 HEAD 上做；
  - 没提交就照 P10a 步骤 3：`kbp snapshot export HEAD` 在快照里实现，按块三方合并进工作区，提交时只暂存自己的块。
- **P6c（光标回调）/ P11（媒体回调）**：语料里多数 `getAnimation` 在这两类回调里。P10b 只保证落点正确，那两节接上回调后用同一套包装对象。
- **P12（puppet）**：`animationlayers/*` 上的脚本（`thisObject` 是动画层）和 `getAnimationLayer*` 归 P12；puppet 动画也发 `animationEvent`（`lib.sceneScript.d.ts` 的注释），P12 接到同一个 `ScriptRuntime.animationEvent`。
- **kabegame-chromium 第 7 批（已提交 `446a1a5a`）**：dev 探针跑脚本的那套代码，步骤 3 给它接动画控制与事件。
- **P5d / P13**：相机、灯对象的关键帧照报，不在本节。

## 决定（2026-11-14 用户：同意，第 1 条选 (a)）

1. **「清空脚本存储」时动画怎么办**。脚本重建、`init` 重跑：
   - **(a) 动画一起从头来（推荐，已定）**：新播放器不接旧时钟，`init` 里的 `play()` 落在新播放器上。和视频纹理一样（清空时复位脚本状态，P9b），也等于 WPE 重开壁纸。
   - (b) 接回旧时钟（P10a 现在的做法）：新 `init` 里的 `play()` 会被接回覆盖掉，旧脚本改过的暂停、速率也留着。
2. **顺序**：
   - 步骤 0 现在就做（只测，不改代码）；
   - 步骤 1 只改 P10a 的文件，接着做；
   - 步骤 2、3 如果那时 P6b 步骤 2 还没提交，在 HEAD 快照里做，再按块三方合并；
   - 子代理用 Sonnet，主会话独立验收。

## 决定 3（2026-11-14 用户：选 (a)）

3. **脚本与动画的登记顺序要不要照 WPE 改**：
   - **(a) 改（推荐，已定）**：`collectScripts` 与 `collectAnimations` 都按 WPE 的顺序遍历（对象字段在前、effect 在后，同层按键名排序）。事件派发的先后、`thisScene.getAnimation` 取到哪条、`init` / `update` 的先后都和 WPE 一致。影响语料 27 张场景里脚本执行的先后，只有脚本之间共享状态时才看得出来；步骤 2 的语料扫描比对每张的脚本诊断，列出顺序变了的场景。
   - (b) 只让事件派发与 `getAnimation` 用 WPE 的顺序，`init` / `update` 不动：两套顺序并存，和 WPE 仍不同。
   - (c) 都不改，记为已知差异。

## 风险

1. ~~**对象范围**~~：步骤 0 Q1 实测按属主，已改进计划。
2. **首次加载的时序**：为了让 `init` 里的控制有落点，播放器提前到 `init` 之前建，换上时不再 `carryOver`。如果加载期间（`init` 之后、首帧之前）又来一次重编译，待用的播放器要跟着作废，否则会拿错 bundle：按 `bundle` 身份比对，单测覆盖。
3. **同步派发的重入**：`animationEvent` 回调里可以 `play` / `stop` / `setFrame` 任意动画、写任意属性，这些都发生在播放器循环中间。播放器在派发时不能持有会被改掉的中间状态（`scratch` 先拷出来再派发）。
4. **共享文件**：和 P6b 的未提交改动同一批文件，按「交界」一节处理。
5. **走查样本少**：事件只有 `2887099508` 一张，`init` 播放的 3–5 张；光标、媒体回调里的大头要等 P6c / P11 合入后再走一遍。

## 实施记录

### 步骤 0 — 补测（2026-11-14）

主会话做，结果写在 [p10-REPORT](p10-REPORT.md)「P10b 补测」。两个生成工程 `p10b-api`、`p10b-order`，WPE 测试窗口只看日志，没有抓帧（走查时另录）。

推翻或补充推断的地方，已改进本计划：
- **Q1 对象范围**：`getAnimation` 不按图层找，按属主（同联动），推断是错的；事件仍按图层发。改了「总体设计思路」、步骤 1 的 `owner` 字段、步骤 2 的查找。
- **Q3 登记顺序**：WPE 的脚本列表和动画列表都是「`general` → 对象字段 → effect」、同层按键名排序，和我们的书写顺序在 effect 的位置上不同，语料 27 张的 `update` 先后受影响。新增「决定 3」，用户选 (a)：照 WPE 改。
- **Q4 包装对象**：成员是 12 个可枚举的数据属性（多一个 `getAnimation`），只读的赋值抛 `TypeError`；`rate` 只收数字、`setFrame` 不是数按 0。改了步骤 2 的包装对象。
- **Q5**：模块顶层调用抛 `SyntaxError: getAnimation cannot be called from global scope.`。
- **Q7 丢弃的动画**：`fps` 读出 1、`duration` 0、`isPlaying()` 真。改了步骤 1 的惰性时钟。
- **Q2、Q6、Q8** 和推断一致；Q2 让 P10a 留下的联动属主 TODO 可以删掉。

工具上的坑：`open_wallpaper` 返回的日志游标里 `created` 超过 JSON 数的精度，传回 `log_since` 被判成「日志被重写」，改为按开窗前的字节偏移直接读日志文件。

### 步骤 1 — 播放器与编译期（2026-11-14）

Sonnet 子代理实现，主会话独立验收。

**改动：**
- **`animation/types.ts`**：`SceneAnimation` 加 `name`、`object`、`owner`、`inert`；`AnimationEventRecord` 改成派发的内容 `{ animation, object, json }`。
- **`animation/clock.ts`**：新增 `AnimationClock.inert(length)`（`spf` 1、`D` 0、`flags` 0）。
- **`animation/player.ts`**：
  - 每条都有自己的时钟；子的从不推进，推进与求值仍只用主人的；
  - `frame(dt, state, hooks)`，`hooks = { sound, event }`；事件在触发推进的那一条写完之后、下一条之前同步派发，先拷出来再派发；
  - 新增 `control(id)`（`AnimationControl`，同一条同一个对象）；
  - `carryOver` 每条都接时钟与 `rate`；`probe()` 加 `name`、`rate` 与最近 100 个事件；
  - 删除公有的 `events`。
- **`compile/registration.ts`（新建）**：`compareKeys`（从 `animations.ts` 挪来）与 `registrationKeys`，`collectAnimations`、`collectScripts` 共用（决定 3）。
- **`compile/animations.ts`**：丢弃的动画收进列表（`inert`）；填 `name` / `object` / `owner`；联动按 `owner` 比较，删掉联动属主的 TODO。
- **`host.ts`**：`frame` 的调用改成 `{ sound }`。
- **测试**：
  - `player.test.ts`、`clock.test.ts`、`animations.test.ts` 补用例；
  - 新建 `registration.test.ts`：倒序书写的场景，两份列表的顺序都等于实测的登记顺序；
  - 因顺序改期望的现有用例：`animations.test.ts` 5 个、`p4f1.test.ts` 1 个、`dev/scriptValues.test.ts` 1 个，都只是键名序；
  - `replayAnimations.test.ts`、`host.script.test.ts` 的夹具补四个新字段。

**和子代理交回的不同：** 子代理让丢弃的动画不能当父，理由是「有效的子会借到不走的时钟」。读码第 7 节写明登记无条件、找父不看有效位，这正是 WPE 的行为（子停在第 0 帧，推断，语料 0 处），主会话改回可以当父，用例改成期望联动。

**验收（主会话）：**
- `git status`：子代理只改了允许的文件（另有两个测试文件只改了顺序期望）。`script/api.ts`、`runtime.ts`、`render/scene.ts` 上的未提交改动属于别的会话（f32 那一步，新建了 `script/f32.ts`），不是本步的。
- tsc 0；vitest（带 WPE 根）138 个文件、3269 个用例全过（基线 137 / 3234，新增 `registration.test.ts`）；Prettier 干净。
- 变异：
  - 子代理做了 6 处，都检出；
  - 主会话另做 4 处，都检出：写入挪到事件派发之后 13 个失败；有效动画的 `object` 置 null 1 个；`name` 不判字符串 1 个；`rate` 不转 float32 1 个。

### 步骤 2、3 — 脚本 API、运行时、宿主与 dev 探针（2026-11-14）

Sonnet 子代理实现，主会话独立验收。

**改动：**
- **`compile/scriptApi.ts`**：`thisScene` 组删 `getAnimation`，`object` 组改成空数组；`MISSING_SCRIPT_CALLBACKS` 删 `animationEvent`。`scriptApi.test.ts` 三处期望改成不再报。
- **`script/runtime.ts`**：`RUNTIME_CALLBACKS` 加 `animationEvent`；`call` 带参数表；新增 `scriptObject`、`animationEvent(object, json)`。
- **`script/api.ts`**：
  - `ScriptApiState.animation`；
  - `getAnimation` 装到图层、effect、材质、`general` 四种对象（按属主找）与 `thisScene`（全场景）；模块求值期间抛 realm 的 `SyntaxError`；
  - 包装对象 `animationApi`：12 个成员照 Q4。`rate` 是访问器、原型是 `Object.prototype`，两处与 WPE 不同，注释里记为已知差异。
- **`host.ts`**：
  - `pendingAnimations`：要跑 `init` 的加载分支里先建待用播放器；
  - `beforeFirstFrame` 同一份 bundle 直接用、不接旧时钟（决定 1），否则新建并接 `sceneAnimations ?? 过期的待用播放器`；
  - `ScriptApi.animation` 先认待用播放器；`beforeFrame` 接事件钩子；退回与销毁时清掉。
- **dev 探针**：`probeScripts.ts` 给 `animation`、出 `animationEvent`；`particleCorners.ts` 的两种回放带事件钩子；`probe.ts` 把播放器提前到脚本环境之前建。
- **测试**：
  - 新建 `script/animationApi.test.ts`（14 个）、`script/animationEvent.test.ts`（6 个）；
  - `host.script.test.ts` 加 4 个；
  - `dev/replayAnimations.test.ts` 加 2 个；
  - P10a 的「清空脚本存储重建期间」用例按决定 1 改成从头来。

**主会话补的：**
- **加载期间又来一次加载**（风险 2）：第二次加载新建待用播放器时，`runtime` 已赋值就从上一份待用播放器 `carryOver`（`init` 已经在它上面控制过、不会再跑）。补了两个用例（卡在建 realm、卡在模块求值），都要求 `init` 里的 `play()` 不丢。
- **事件只发给跑完 `init` 的脚本**：子代理的用例没覆盖「模块已求值、`init` 还没跑」时来事件（宿主在脚本加载期间照常跑帧）。补了用例，变异「也发给没跑完 `init` 的」由它检出。

**验收（主会话）：**
- `git status`：子代理改的都在允许范围内。`host.ts`、`dev/probe.ts`、`script/runtime.ts` 里另有别的会话未提交的块（P11b 用户纹理），原样在。
- tsc 0；vitest（带 WPE 根）149 个文件、3458 个全过；Prettier 干净。
- 变异：
  - 子代理做了 7 处，都检出；
  - 主会话另做 4 处：包装对象不缓存（7 个失败）、没有 uniform 的常量也找得到（2 个）、`init` 时不认待用播放器（6 个）、事件也发给没跑完 `init` 的脚本（补用例前漏掉，补后检出）。

### 步骤 4a — 生成工程的走查（2026-11-14，Sonnet 子代理做、主会话验收）

- **录制**：
  - `p10-script`、`p10-edge` 复用 P10a 的录制（`A:\p10s4\`），并补录覆盖 10.0–13.6 s 脚本动作的段；
  - `p10b-api` 新录 6 段；
  - 补录都在 `A:\p10b\s4\`，窗口 1920×1080、fps 20，WPE 当时是 `ultra` 档（别的会话改的，没改回）。
- **回放**：`ignore/p10/b4a/walk.py`，`renderFrames.ts --scripts` 单开宿主，**不排除任何对象**；`kbp cmp frames --meta` 逐帧比；`[kf]` 日志用 `kfcmp.py` / `evcmp*.py` 对照（我们这边只有每段最后约 50 条控制台输出）。
- **结果**：23 段 69 帧里 66 帧逐像素相同。覆盖的对象：
  - `ctl`、`ctls`、`ovr`、`ovrinit`、`nameA` / `nameB`、`ev` / `evn` / `evp`、`link`、`kid`、`neg`、`pass`、`byprop` 等；
  - q1–q8。
- **找到两处差异，都已修**：
  1. **`rate = NaN` 之后动画写进去的是 0，WPE 是 NaN**（`p10b-api-w12` 第 267–269 帧，`q4` 画到了左下角）：
     - 播放器和脚本写回的向量都经 `scriptWriteValue` 拼成字符串，再由 `atof` 读回；我们的 `atof` 不认 `NaN`，读成 0。WPE 那两条走类型化 setter，NaN 原样存下、不画。
     - 修法：`compile/materialValues.ts` 的 `atof` 照 UCRT 认带符号的 `inf` / `infinity` / `nan`（不分大小写），WPE 用的 `common_atof_l` 本来就认。这也让用户属性里的同类字符串跟 WPE 一致。补了用例。
  2. **dev 探针里 `animationEvent` 回调读到的 `engine.runtime` 晚一帧**（只在探针，不影响画面）：
     - 探针的脚本时钟在 `scripts.frame` 里才更新，事件在它之前派发。宿主没有这个问题：渲染器在 `beforeFrame` 之前就推进了 `frameClock`。
     - 修法：`ProbeScripts.enterFrame(dt, time)`，两种回放在推进动画之前调，同 WPE 先加 `g_Time` 再跑动画循环（读码第 1 节）。补了用例，去掉调用后它失败。
- **修后复核**（主会话，宿主产物 `index-GTdYHbia.js`）：重导入、重跑 `p10b-api-w12` 与 `p10-script-w10`。两段都 3 帧逐像素相同；`[kf]` 日志里逐帧条目、事件条目（含 `engine.runtime`）、`q4` 的 NaN 条目全部和 WPE 相同。测试工程已移除。
- **验收的其它项**：
  - tsc 0；vitest 3591 个通过；
  - 有 1 个失败：`pipeline.test.ts` 的「`3293687972`：读取 125501007 字节」超出 80 MiB 上限。撤回 `atof` 的改动照样失败，来自工作区里别的会话未提交的改动，不是本步的。
- **没覆盖到**：
  - 只比了每段最后约 50 条控制台输出，不是全程；
  - `p10-script` 13.3–13.6 s 的两个动作靠前后两段夹着，没有专门抓。

### 步骤 4b — 真实壁纸的复制工程（2026-11-14，主会话）

- **选样**：调用全在已实现回调里的只有 4 张。
  - `2887099508` 的两条带事件的动画是 `startpaused`，脚本混淆过，靠 `cursorClick` 播放；测试窗口里没有点击，事件不会触发，走查不到，等 P6c。
  - 另外两张的动画层归 P12。
  - 剩下的是两张碧蓝航线壁纸的时钟：`init(){ thisObject.getAnimation().play() }`，60 fps、120 帧的 `single`，淡入加上移。
- **复制工程**（`kbp content isolate --instrument`，`ignore/p10/b4b/proj/`）：
  - `3336377291-iso-61`：`Clock` 与父 `Clock Shadow`，加 FR；
  - `3427691867-iso-164`：`Clock`、`Clock Shadow`、父 `纯色`，加 FR；
  - 两层文字的 `text` 换成固定的 `{"value": "12:34"}`：原来由脚本按 `Date` 算，两边对不上，它也不是被测的属性。动画、`init` 脚本、父链、`Clock Shadow` 的 `origin` 上的拖拽脚本、`scale` / `visible` 脚本都原样保留。
- **录制**：`A:\p10b\s4b\`，1920×1080 窗口（和 3840×2160 的场景同为 16:9，投影两边相同），fps 20，WPE `ultra` 档。
  - 每张 4 段，各 3 帧：等待 0 s 的那段落在动画中途（脚本帧 23–26，约 1.2 s），1 / 2 / 5 s 的在播完之后；
  - 日志 `ignore/p10/b4b/out/`。
- **回放与比较**（`ignore/p10/b4b/walk.py`）：`renderFrames.ts --scripts --cursors log` 单开宿主；`kbp cmp frames` 逐帧比；每段中间那帧用 `kbp rdc consts --no-clock` 对我们的 `--trace-frames` 逐 draw 比 MVP 与 `g_Color4`。
- **结果**：
  - **逐 draw 常量**：8 段全部 0 ulp，两层文字的 MVP（`origin` 动画与父链）、`g_Color4`（alpha 动画）都对上。动画中途那帧的 alpha 两边都是 0.7435418367385864：`init` 里的 `play()` 和 WPE 同一帧开播，时钟逐位相同。
  - **整帧**：文字还没显出来的那帧（`clk61` 第 23 帧，alpha 仍是第 70 帧之前的 0）逐像素相同。文字可见的帧都有差：1500–2400 个像素、最大 47，外接框只在两层文字上（约 150×80 像素）。`3427691867` 的纯色图层 0 差异。
  - **差异的归因**：抓帧里文字那次绘制（事件 36）的 30 个顶点，位置与纹理坐标和我们的轨迹逐项相同；字形图集都是 512×512 R8，常量 0 ulp。差别只在渲染分辨率：WPE 直接往 1920×1080 的目标里画（视口 1920×1080），对没有 mip 的图集做 0.5 倍缩小采样；我们按 3840×2160 的场景分辨率画再缩到画布。归「按窗口分辨率画」这一类已知差异（P10a 走查、`FINAL_CHECK.md` 的已知差异举例），不复刻。
- 测试工程已移除。

### 步骤 5 — 收尾（2026-11-14）

- `cocs/wpe/WPE_SCENE.md`：
  - 「关键帧动画」一节改成 P10a、P10b 合写：表里加脚本一行；规则加丢弃、查找、`IAnimation`、事件；能力表、走查、已知差异、语料、dev 探针同步；
  - 脚本一节：导出回调表、`object` 分组、登记顺序；
  - 材质取值一节：`atof` 认 `inf` / `nan`。
- `cocs/README.md`：场景条目的关键帧一项与适用场景。
- `versions/latest/regression.md`：新增 K7–K13，勾了 4 项。K11（27 张强制渲染跑脚本）没做，随 P6c / P11；K12（清空脚本存储）要动图库界面，待用户看；K13 非 Windows 本机测不了。
- `versions/latest/changelog.md`：用户侧那一行改写，开发侧加一条。
- `PLAN.md` 与总计划记进度。
