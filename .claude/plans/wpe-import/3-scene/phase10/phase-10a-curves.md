# P10a — 曲线、时钟与自动播放（子计划）

> 上级：[P10 总计划](phase-10-keyframes.md)「P10a — 曲线与自动播放（含联动）」。WPE 语义以 [rea-p10-keyframes](rea-p10-keyframes.md) 与 [p10-REPORT](p10-REPORT.md) 为准，本节不另做步骤 0。
> 现状行号按 HEAD `ab1934d9`。语料口径同总计划（`ignore/p10/out/corpus-head.json`，173 张）。

## 总体设计思路

关键帧在 WPE 里是属性的第三种写入方：每帧在粒子与相机之后、脚本之前，按 float32 时钟求出值，经属性的 setter 写进字段。我们已经有一条一模一样的路：P3a 的绑定目标 `BindingTarget` 加 `SceneState.write`，用户属性和脚本写回都走它。P10a 只是给这条路加第三个写入方，不加新的 uniform、管线或重编译原因。

分成三块，边界清楚：
- **求值模块 `src/animation/`（纯 TS，不依赖 GPU 与编译管线）**：
  - `curve.ts`：关键帧解析、`wraploop` 预处理、整数帧采样（三次贝塞尔、步进搜索反解）与缓存、帧间插值；
  - `clock.ts`：float32 时钟的推进（`loop` / `mirror` / `single`、事件收集）和 `IAnimation` 要用的控制（`play` / `pause` / `stop` / `setFrame`）。

  全部照读码第 14 节逐位实现，float32 用 `Math.fround`。Node 单测、dev 探针、宿主共用这一份。
- **编译期**（Worker）：
  - `compile/animations.ts` 把 `scene.json` 里的每个关键帧值解析成一条 `SceneAnimation`。它是纯数据：目标、值类型、解析好的通道、时钟参数、父的下标、事件。
  - 目标推导和字段脚本共用一个函数。effect 常量的 uniform 名要等着色器编译完才知道，和脚本的常量目标在同一处补上。
  - 能力表据此去掉 `value:animation`，只对没有就地路径的目标报细分键。
- **运行时**（主线程）：
  - `animation/player.ts` 的 `SceneAnimations` 持有全部时钟。宿主在渲染器每个实时帧的 `beforeFrame` 里、脚本之前调一次 `frame(dt, state)`：推进时钟、求值、`SceneState.write`。
  - 渲染器已经保证这个回调在粒子、相机、声音之后。所以 `general.zoom`、`instanceoverride` 晚一帧生效这类 WPE 行为，不用特别处理就对上了，帧循环本身不改。
  - 重编译时按动画的稳定键（`scene.json` 路径）接回原来的时钟与缓存，动画不重新开始。WPE 改属性也不重载场景。

照 WPE 的几条规则直接决定了实现形状：
- **每帧照写**：暂停的、对象隐藏的动画也每帧写一次。脚本或用户写进的值只活一帧，下一帧被动画覆盖。
- **只写四种类型**：通道数必须等于分量数，属性必须是 float、vec2、vec3、vec4 之一，否则这条动画不写、字段保持 `value`。这类不报不支持，因为 WPE 也什么都不做。
- **联动**：子动画用父的时钟。父按属性名在同一个对象上找，只有一层；`children` 不读。
- **事件**：时钟照收事件，派发留给 P10b。P10a 不派发，导出了 `animationEvent` 的场景照报 `script:callback:animationEvent`。
- **初值**：编译期的初值取 `value`（WPE 加载时也是写 `value`），所以 `resolveValue` 对关键帧值返回 `value.value`，不再返回 `undefined`。

P10a 不碰脚本：`getAnimation` 仍照报 `script:api:object.getAnimation` / `thisScene.getAnimation`。播放器的控制接口按 P10b 的需要留好。

## 现状锚点

**a. 关键帧值一律报 `value:animation`**（`apps/wpe-scene/src/compile/features.ts:380`、`:1335`；`particles/modules.ts:1391`）
```ts
export function scanValue(value: unknown, unsupported: Set<string>): void {
  // …
  if (isKeyframedValue(value)) unsupported.add("value:animation"); // 现状：scene.json 任意深度、材质 pass 常量都走这里
  for (const v of Object.values(value)) scanValue(v, unsupported);
}
// 粒子 JSON 的系统级键与模块字段另由 checkParticleFeatures / readParticleModule 报 value:animation（语料 0 处，P10a 照报）
```

**b. 编译期把纯关键帧值解析成 `undefined`**（`compile/model.ts:188`）
```ts
  if (value && typeof value === "object") {
    if ("script" in value) return value.value;               // 关键帧 + 脚本：取 value
    if (!("user" in value) || !value.user) return undefined; // 现状：纯关键帧值走这里，调用方退回缺省值（WPE 加载时写的是 value）
```

**c. 字段脚本的目标推导，私有在 `scripts.ts`**（`compile/scripts.ts:65`）
```ts
function targetOf(path: string, owner: ScriptOwner, key: string, initial: SceneScalar, sound: boolean): SceneScript["target"] {
  // sound / layer 字段 / effect visible / bloom / general / material 常量（uniforms 先空着）各一支
  return { kind: "unsupported", path }; // 现状：instanceoverride 落到这里
}
```

**d. 常量目标的 uniform 名在编译 pass 时补上，只认脚本**（`compile/bundle.ts:1351`）
```ts
    if (result?.ok) {
      for (const script of scripts.list) {
        if (script.owner.kind !== "material" || script.owner.pass !== context.key || script.target.kind !== "constant")
          continue;
        const material = script.target.material;
        const slot = materialSlots(result.uniforms ?? []).find((item) => item.material === material);
        if (slot) Object.assign(script.target, constantTargetFields(slot)); // 现状：只给脚本补；关键帧要同样补
        else script.target.uniforms = [];
        script.valueType = script.target.type;
      }
    }
```

**e. 宿主每个实时帧在脚本之前的回调**（`host.ts:770`）
```ts
      stepObjects: (dt) => this.sceneSounds?.step(dt, this.soundVolumeOf), // 粒子、相机之后
      videos: this.videoSink,
      beforeFrame: (dt, spectrum) => {
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) this.runtime?.frame(dt); // 现状：只跑脚本；动画要插在这一句之前
      },
```
渲染器只在实时帧调 `stepObjects` / `beforeFrame`（`render/renderer.ts:594`、`:596`），补画帧不调。

## 步骤 1 — 求值模块（`src/animation/`，只新建文件）

不碰任何共享文件，现在就能做。

- **新增 `animation/curve.ts`**：
  - `parseChannel(arr)`：照读码第 14 节。`value` / `frame` 必须是数；`frame` 截断，不严格递增的丢掉；`step: true` 时 flags 4、不读切线；`back` / `front` 是对象且 `enabled !== false` 时算开。
  - `applyWraploop(keys, length)`：照读码第 3 节。注意首帧前切线关着时，末帧原来的 `bx` / `by` 保留。
  - `class Channel`：持有关键帧与整数帧值缓存（`Float32Array`，按需扩到 `length + 1`），`sample(i)` 照读码第 2 节。没有关键帧时取 0。
  - `frameValues(clock, channels, out)`：帧间插值写进 `out`，不分配内存。
- **新增 `animation/clock.ts`**：
  - `class AnimationClock { spf, t, D, flags, length, events }`，`advance(d, out)` 照读码第 3 节：事件按 `[t0, t1)` / `(t1, t0]` 收集，`loop` 回绕后再收，`mirror` 反射，`single` 置结束位。
  - 控制：`play()` / `pause()` / `stop()` / `isPlaying()` / `getFrame()` / `setFrame(f)`，P10b 用。
  - 常量 `PAUSED = 0x20000000`、`DONE = 0x40000000`、`BACK = 0x80000000`，flags 用无符号 32 位。
- **新增 `animation/types.ts`**：
  - `SceneAnimation`：编译期产出、渲染期消费的纯数据，结构化克隆安全：
    - `id`：`scene.json` 路径，稳定键；
    - `target`、`valueType`；
    - `channels`：解析好的关键帧；
    - `clock`：`fps`、`length`、`mode`、`startpaused`；
    - `parent`：父动画在列表里的下标；
    - `events`：`{ time, json }`；
    - `writes`：通道数与类型合法时为真。
  - `AnimationEventRecord`。
- **新增 `animation/curve.test.ts`、`clock.test.ts`**：
  - 逐条覆盖读码第 2–5 节的规则：平切线、长切线（x 不单调时的搜索路线）、只开一侧、`step` 在右端、首帧前末帧后、`wraploop` 两种、`loop` 回绕跳变、`mirror` 反射、`single` 末值；
  - fps 14.5 / 1.2 停在第 `length − 1` 帧，fps 30 停在第 `length` 帧；
  - 负 `rate` 越过 0 后的锯齿、`setFrame` 不钳制、`stop` 清方向位；
  - 事件的四种边界：第 0 帧、第 `length` 帧、带小数、`mirror` 两次。

  期望值是读码模型 `ignore/p10/rea/kfmodel.py` 算出的 float32 数，写进测试（不依赖 `ignore/`）。
- **新增 `ignore/p10/c1/`（对照，不进仓库代码）**：vitest 配置加一个测试，用 `src/animation/` 对四个工程的 WPE 抓帧值逐帧求值。
  - 时钟取抓帧的 `g_Time`，loop 取 `fmod`，mirror 取三角波，single 取 `min`（同读码第 13 节）。
  - 和 `p10-curves-values.json`、`wpe-p10-script2-fps20-values.json`（只用不受脚本控制的用例）、`wpe-p10-edge-fps20-values.json` 逐帧比，残差写进报告。

```ts
// animation/types.ts（新增）
export interface SceneAnimation {
  id: string;                          // scene.json 路径，如 "objects/12/origin"、"objects/3/effects/0/passes/0/constantshadervalues/multiply"
  target: BindingTarget;               // 与字段脚本同一套推导；常量目标在编译 pass 时补 uniforms
  valueType: "float" | "vec2" | "vec3" | "vec4" | "angles" | "other";
  channels: ParsedKey[][];             // parseChannel + applyWraploop 之后
  clock: { fps: number; length: number; mode: 0 | 1 | 2; startpaused: boolean };
  parent: number | null;               // 父动画在 bundle.animations 里的下标（同一对象、按属性名找到的那条）
  events: { time: number; json: string }[]; // time = f(frame) × spf；json 照 jsoncpp（键排序、8 位有效数字）
  writes: boolean;                     // 通道数 == 分量数，且类型是 float / vec2 / vec3 / vec4
}
```

**验收：**
- 单测全部通过；
- `ignore/p10/c1` 的对照：每条用例的残差不大于读码模型的（≤ 0.001 像素，陡段 ≤ 0.03 像素，后者是拿 `g_Time` 近似 float32 时钟带来的）；
- tsc、Prettier 干净。

## 步骤 2 — 编译期（`compile/animations.ts` + 能力表 + bundle）

要改 `scripts.ts`、`bundle.ts`、`features.ts`、`model.ts`。前三个现在被 P6b 1e 的会话改着（未提交），等它提交后再动手；等不及就在 HEAD 快照里做，再三方合并（见「和其它会话的交界」）。

- **修改 `compile/scripts.ts`**：
  - 把 `targetOf` 和 `layerTypes` 提成导出的 `propertyTarget(path, owner, key, initial, object)`，字段脚本与关键帧共用；
  - 补一支：`objects/<i>/instanceoverride/<键>`，且键是 `InstanceKey` 时，返回 `{ kind: "particle-instance", object, field }`。
  - 字段脚本对 `instanceoverride` 的行为不变（仍是 `unsupported`）：只有关键帧走这一支，脚本的放开留给以后。办法是给函数加一个参数区分调用方。
- **新增 `compile/animations.ts`**：
  - `collectAnimations(scene)`：坐标遍历同 `collectScripts`，覆盖 `general`、`objects`、effect 实例常量、`instanceoverride`。
  - 每处 `{animation: {…}, value}` 依次处理：
    1. 丢弃条件照读码第 5 节，丢弃的不进列表；
    2. `relative` 只对三段字符串的 `value` 生效；
    3. 解析通道（步骤 1 的 `parseChannel`），`wraploop`；
    4. 求目标与值类型：灯对象的字段给 `{ kind: "recompile", reason: "layer-structure" }`，相机对象给 `unsupported`；
    5. 事件序列化：键按字母序，数字保留 8 位有效数字，同 jsoncpp `precision 8`；
    6. 联动：按属性名在同一对象的条目里找父，父自己不能再有 parent。
  - 常量目标的 `writes` 要等着色器编译后才知道类型，先记下通道数。
- **修改 `compile/bundle.ts`**：
  - `SceneBundle.animations: SceneAnimation[]`；
  - 编译 pass 时（锚点 d）对脚本和关键帧一并补常量目标，补完按类型算 `writes`；
  - 类型只认 float / vec2 / vec3 / vec4，`angles` 按 vec3。
- **修改 `compile/features.ts`**：
  - `scanValue` 不再报 `value:animation`；
  - 由 `collectAnimations` 的结果报：目标是 `recompile` / `unsupported` 的，报 `value:animation:<light|camera|其它>`；
  - 材质 JSON（`checkPassFeatures`）、模型 JSON、effect.json 里的关键帧照报 `value:animation`（WPE 的这些 JSON 不经属性框架，语料 0 处）；
  - 粒子的两处不动。
- **修改 `compile/model.ts`**：`resolveValue` 对关键帧值（`isKeyframedValue`）返回 `value.value`。

```ts
// compile/features.ts（修改）
export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) scanValue(v, unsupported); return; }
  if (!value || typeof value !== "object") return;
  // 删除：if (isKeyframedValue(value)) unsupported.add("value:animation");
  for (const v of Object.values(value)) scanValue(v, unsupported);
}
// 新增：scene.json 的关键帧由 checkAnimationFeatures(bundle.animations) 按目标报细分键；材质 / 模型 / effect.json 另走 scanJsonKeyframes 照报原键
```

**验收：**
- 单测：
  - `collectAnimations` 对每类落点（图层字段、文本对象字段、effect 常量、`general.zoom` / `bloomstrength`、`instanceoverride`、灯、相机）给出对的目标；
  - 丢弃、`relative`、联动、事件的 JSON 串与读码一致；
  - 布尔、通道数不对的 `writes` 为假。
- 语料：173 张跑一遍 `kbp corpus scan`，`kbp corpus diff`：
  - `value:animation` 从 40 张消失，只新增 `value:animation:light`（`3465215190`）、`value:animation:camera`（`3554161528`）；
  - 别的键逐张不变；
  - 能渲染张数不变，这 40 张都还差别的节。
- tsc、vitest、Prettier 干净。

## 步骤 3 — 运行时（播放器 + 宿主 + dev 探针）

- **新增 `animation/player.ts`**：
  - `class SceneAnimations`：由 `bundle.animations` 建，每条一个 `Channel[]`；没有父的每条一个 `AnimationClock`，有父的用父的。
  - `frame(dt, state)`：
    1. 每个时钟每帧推进一次，`rate` 缺省 1；P10b 加包装对象后取它的 `rate`；
    2. `writes` 为真的逐条求值，经 `SceneState.write({ property: "", target }, raw)` 写入，`raw` 用 `scriptWriteValue`，同脚本写回；
    3. 收到的事件放进队列，P10a 丢弃。
  - `carryOver(previous)`：重编译时按 `id` 接回时钟、整数帧缓存。曲线变了（同一路径但关键帧不同）的不接缓存。
  - `seek(time)`：dev 探针用，把每个没暂停的时钟直接设到 `time` 对应的位置（`loop` 取 `fmod`、`mirror` 三角波、`single` 钳到 D）。
- **修改 `host.ts`**：
  - 加载时建 `SceneAnimations`，重编译时 `carryOver`，换场景 / 销毁时丢掉；
  - `beforeFrame` 里在 `runtime.frame(dt)` 之前调 `animations.frame(dt, scriptState)`；
  - 不受脚本状态门控，只要场景不在 fallback 就跑；
  - 探针接口加 `host.animations()`：每条的 `id`、`t`、`getFrame()`、`isPlaying()`、上次写入的值。
- **修改 `dev/probe.ts`**：
  - `renderFrame` 有 `particles.dts` 时，动画沿同一串 dt 推进，每一帧推进后写入；
  - 没有 `dts` 时按 `time` 调 `seek`，再写一次；
  - 结果里带每条动画最后写入的值（`animations`），对照用。

```ts
// host.ts（修改，锚点 e）
      beforeFrame: (dt, spectrum) => {
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) {
          this.sceneAnimations?.frame(dt, this.scriptState); // 新增：动画在脚本之前写（rea-p10-keyframes 第 1、9 节）
          this.runtime?.frame(dt);
        }
      },
```

**验收：**
- 单测：
  - 播放器在假 `SceneState` 上按帧写入；
  - 联动的子借父时钟；
  - 暂停的照写；
  - `carryOver` 后时钟连续；
  - `writes` 为假的不写。
- 开销：`3400241651`（23 条，语料最多）在 dev 强制渲染下量 `frame()` 每帧耗时，写进实施记录（预期远小于 0.1 ms）。
- tsc、vitest、Prettier 干净。

## 步骤 4 — 真机对照（dev app + WPE 抓帧）

- `kabegame-dev` MCP 导入四个测试工程（`ignore/p10/proj/p10-{curves,script,edge,zoom}`，`projects_import`）。
- `render_scene` / 探针 `renderFrame`：
  - 按 WPE 抓帧的时间线（`[kbp]` 日志的帧时间作 `dts`），读每帧的 `animations` 值与离屏目标；
  - 和 `kbp rdc consts` 的 WPE 值逐帧比：`origin` 由我们的 MVP 反算，或直接比状态值。
  - 脚本相关的用例要 dev 强制渲染（`kabegame-dev-scene-force-render`），且只比不受脚本控制的那些。
- `p10-zoom`：我们这边 zoom 也正好晚一帧。
- 语料两张（`2251857160`、`3146703458`）：
  - P8、P9、P4f 都合入后，按 `A:\p10\corpus\` 的真值比整帧；
  - 到 P10a 收尾时如果还没合入，记成待办，挂到 P10 收尾。
- 测试工程用完 `projects_remove` 移除。

**验收：**
- 不受脚本控制的用例，状态值和 WPE 的差不超过步骤 1 的对照；
- 整帧和 WPE 一致，只差关键帧以外的已知差异；
- 两张语料场景的结论写进实施记录。

## 步骤 5 — 收尾

- `cocs/wpe/WPE_SCENE.md` 新增「关键帧动画（P10a）」一节，`cocs/README.md` 的场景条目同步。
- `versions/latest/regression.md` 加用例，`changelog.md` 加一行。
- PLAN.md 的 P10 记进度；本文件写实施记录。

## 和其它会话的交界

- **P6b 1e（文本运行时字段，未提交）**：正在改 `compile/scripts.ts` 的 `targetOf`、`bindings.ts`、`render/state.ts`、`host.ts`、`script/runtime.ts` / `api.ts`。
  - 步骤 1 不碰这些文件；
  - 步骤 2、3 等它提交后在新 HEAD 上做；
  - 等不及就用 `kbp snapshot export HEAD` 在快照里实现，再按块三方合并。
- **P4f（粒子脚本 API）**：改 `script/api.ts`。P10a 不碰脚本 API。
- **P8 / P9**：两张解锁场景还差它们（以及 P4f）。P10a 的语料验收只看 `value:animation` 的去留。
- **P5d**：相机对象的关键帧照报 `value:animation:camera`，由 P5d 一起做。
- **P13**：灯字段的关键帧照报 `value:animation:light`。
- 共享文件只加接线，按块暂存；提交前看暂存区，别人的块不带。

## 决定（2026-11-13 用户：四条按推荐）

1. **每帧照写还是只在变化时写**：推荐每帧照写。这是 WPE 的语义：脚本写进的值下一帧被动画覆盖，只在变化时写就复刻不了这一点。代价是有动画的图层每帧标脏，步骤 3 量开销，语料最多 23 条。
2. **float32 逐位还是 float64**：推荐 float32 逐位（`Math.fround`）。`single` 停在哪一帧、`mirror` 反射点都取决于 float32 舍入，float64 会在这些边界上和 WPE 不同；代价是求值慢一点，整数帧有缓存，影响很小。
3. **事件**：推荐 P10a 的时钟照收事件但不派发，派发留给 P10b，接口一次定好。
4. **顺序**：推荐步骤 1 现在做；步骤 2、3 等 P6b 1e 提交后做，必要时在快照里做再合并；步骤 4、5 随后。

## 风险

1. **共享文件冲突**：`scripts.ts`、`bundle.ts`、`state.ts`、`host.ts` 同时有别的会话在改。按「交界」一节的顺序做，提交时按块暂存。
2. **每帧标脏的开销**：有动画的图层每帧重算世界矩阵、重写 uniform。语料最多 23 条，预期可以忽略，步骤 3 实测。
3. **重编译接回时钟**：重编译后动画的路径不变但目标可能变（例如 effect 被删）。按 `id` 接回，找不到的从 0 开始，和 WPE 重开壁纸的行为一致。

## 实施记录

（空）
