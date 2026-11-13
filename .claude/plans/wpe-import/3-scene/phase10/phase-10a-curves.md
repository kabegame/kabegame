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

### 步骤 1 — 求值模块（2026-11-14）

代理实现，主会话独立验收。新建 `apps/wpe-scene/src/animation/` 的 `curve.ts`、`clock.ts`、`types.ts` 与两个测试，不改任何已有文件。

- **实现**：照读码第 14 节逐位写，float32 用 `Math.fround`，括号即汇编的运算顺序。
  - `curve.ts`：`parseChannel`、`applyWraploop`、`Channel`（整数帧缓存）、`frameValues`；
  - `clock.ts`：`AnimationClock` 的 `advance`（事件收集）与 `play` / `pause` / `stop` / `isPlaying` / `getFrame` / `setFrame`；
  - `types.ts`：`SceneAnimation` 及时钟参数、事件的类型。
- **单测**：50 个用例。期望值由读码模型算出，硬编码成 float32 数、逐位比。代理把 `fround` 换成恒等函数时 40 个失败。
- **对照**：`ignore/p10/c1/`（`cases.json`、`kfbase.py`、`wpe.test.ts`）。46 条用例逐帧对 WPE 抓帧求值，每一行的预测值都和读码模型 `kfmodel.py` 逐位相同，残差也一样大（最大的是陡段的 `oneside` 0.021 像素、`three` 0.015 像素，来自拿 `g_Time` 近似 float32 时钟）。
- **主会话验收**：
  - tsc 退出码 0；vitest 50/50；Prettier 干净；换行符 LF；`git status` 只有新目录；
  - 对照重跑通过；
  - 逐行对读码第 2、3、14 节审了代码；
  - 自做三处变异：反解容差 0.01 → 0.001 有 23 个失败，`wraploop` 清掉残留切线有 1 个失败，`mirror` 反射方向写反有 2 个失败；还原后逐字节相同。
- **和读码不同的实现取舍**（代理报告，语义不变）：
  - `advance` 入口先 `fround(d)`；
  - `setFrame` 的参数先转 float32 再乘（由 `mulss` 推出，P10b 拿 `ctl` 日志核）；
  - 缓存扩容按「至少到 i + 1、否则翻倍」；
  - `AnimationEventRecord` 定为 `{ animation, json }`，`animation` 是时钟主人的下标。
- **工具注意**：`ignore/p10/c1` 的 vitest 要在 `D:\` 开头的工作目录里跑（PowerShell，或 `cd D:/Codes/kabegame`）。Git Bash 的工作目录是小写 `d:`，vitest 会把 `vitest` 加载成两份，报 `Cannot read properties of undefined (reading 'config')`。

### 步骤 2 — 编译期（2026-11-14）

P4f 步骤 1 当时正在改 `scripts.ts`（未提交），所以在快照里做：
- 把工作区（含 P4f 的改动）冻结成 `ignore/p10/c2/base` 与 `ov`，代理在 `ov` 里实现，`kbp snapshot diff` 出补丁 `ignore/p10/c2/c2.patch`；
- P4f 提交（`ef16dcf1`）后，补丁对新 HEAD 干净打上；提交前 HEAD 又到了 `ef452f49`（P5d 步骤 0–1、P8 步骤 3），三方合并（`bundle.ts` 3 处、`features.ts` 1 处冲突，按 P5d 删掉 `PassContext.model` 与 `checkPassFeatures` 的 `model` 参数解决）后重跑 tsc、产品测试（2448 = HEAD 2421 + 27）与语料，结果同上；
- P4f 步骤 2（工作区、未提交）把 `instanceoverride.brightness` 加进就地目标表，所以测试里「没有就地目标」的例子由 `brightness` 换成 `color`；工作区里 P4f 的改动与本步的改动三方合并，两边都保留。

**改动：**
- **新增 `compile/animations.ts`**：
  - `collectAnimations`：丢弃、灯 / 相机 / 没有就地目标的细分键、`relative`（照汇编逐字扫：只认空格分隔、只看键在不在）、通道与 `wraploop`、值类型与 `writes`、事件 JSON（键按码点序递归排序、实数 8 位有效数字）、联动（同一属主 + 属性名）；
  - `settleConstantAnimation`：编译 pass 后补常量目标；
  - 过渡键 `value:animation:pending`。
- **修改**：
  - `scripts.ts`：`targetOf` 加 `export`；值类型推导原样提成 `targetValueType`，字段脚本调用不变；
  - `bundle.ts`：`SceneBundle.animations`；常量目标与脚本一起补；`PassContext.sceneConstants`；
  - `features.ts`：`scene.json` 不再 `scanValue`；`checkPassFeatures` 跳过从 `scene.json` 并进来的实例常量，材质 JSON 自己的关键帧照报 `value:animation`；
  - `model.ts`：`isKeyframedValue` 搬来（`bindings.ts` 转导出），`resolveValue` 对关键帧取 `value`；
  - `p4a5.test.ts`：两个断言改成新语义。
- **新增 `compile/animations.test.ts`**：27 个用例。

**验收（主会话在 `ef16dcf1` 的快照上重跑）：**
- tsc 0；产品测试 2353 通过（HEAD 2326，多的 27 个是新测试）。
- 语料 173 张：`value:animation` 40 张 → `value:animation:pending` 40 张，另 `value:animation:light`（`3465215190`）、`value:animation:camera`（`3554161528`）各 1 张；别的键逐张不变，能渲染 57 → 57。
  - 40 张共 225 条动画，220 条会写。不写的 5 条：4 条常量在着色器里没有 uniform，1 条没有通道（`3837699827` 的 `R`）。
  - 联动 17 处，事件 2 个。
- 四个测试工程只剩 `value:animation:pending`。`p10-script`、`p10-edge` 另有 `getAnimation` / `animationEvent` 的键（P10b）。
- 主会话逐段审了 `animations.ts` 与共享文件的改动。代理做的 9 处变异全部检出。

**和子计划不同的地方：**
- 过渡键改成一开始就报：非常量的在 `collectAnimations` 之后报，常量的在补齐时报，和原来一样早退回、不白解码纹理；
- `maxrows`（整数）、`bloomhdriterations`（整数）不写，`bloomtint` 按 vec3；
- `scene.json` 其余顶层键与 `scriptproperties` 里的关键帧报 `other`。

**没确认的**（第二条在代码里标了 `TODO:[WPE_SCENE]`）：
- 父被丢弃时子用自己的时钟（WPE 里子借一个永远不走的时钟），语料 0 处；
- effect 常量联动的属主按 pass 算：`3577990983` 的三个 `Aperture` 和别的 pass 的 `Opacity` 参数相同，画面无差；
- 登记顺序取 JSON 遍历顺序，只影响 P10b 按名字查找；
- 整数值的实数字面量在事件 JSON 里按整数写，语料 0 处。

**工具注意**：Prettier 对 `ignore/` 下的文件要加 `--ignore-path .prettierignore` 才真的检查。缺省会读 `.gitignore`，跳过 `/ignore`，显示「全部通过」。

### 步骤 3 — 运行时（2026-11-13）

代理在快照里实现，主会话独立验收：
- 快照：工作区冻结成 `ignore/p10/c3/base`（只读）与 `ov`（代理改），出补丁 `c3.patch`。
- 合入：先合进 `62de2c03`（P9b 步骤 2、3，快照 `h3p`，无冲突），走查期间 HEAD 又到了 `5889b490`（`h4p`）与 `1e90d381`（P5d 步骤 3、P11a、P8 步骤 5，`h5p`）。后两次在 `bundle.ts`、`features.ts`、`particleCorners.ts`、`probe.ts` 上有冲突，都是两边各加了内容，按并集解决。提交的补丁是 `c3-h5.patch`。
- 工作区：`bundle.ts`、`features.ts` 有 P8 会话未提交的改动，三方合并，两边都保留。
- 合入新 HEAD 后 `2251857160` 剩下的不支持项只有过渡键，删掉后能整张渲染（语料干净 78 → 79），编完整张 553 次请求（252 次未命中）、读 82,208,839 字节；`pipeline.test.ts` 的请求上限 450 → 600，字节上限 80 MiB 不动（余量约 2%）。

**改动：**
- **新增 `animation/player.ts`（`SceneAnimations`）**：
  - `frame(dt, state, onSound?)`：按列表顺序走，时钟主人本帧第一次用到时推进一次（子排在父前面也不晚一帧），推进量 `f(f(rate)·f(dt))`。会写的按主人的时钟求值，经 `SceneState.write` 写入，返回值不看。`recompile` / `unsupported` / `script-property` 目标不写。暂停的照写。事件每帧开头清空。
  - `write`：不推进，写一次。
  - `carryOver`：按 `id` 接回。时钟参数相同时接时钟（`t`、整个 `flags`、`rate`）；关键帧相同时复用 `Channel`。
  - `seek`：dev 近似。
  - `probe`：每条的时钟与最后写入的值，加最近 600 次 `frame()` 的耗时。
- **`host.ts`**：
  - 换场景的 `beforeFirstFrame` 里新建播放器、`carryOver`、写一次，都在 `replayWrites` 之前；
  - `beforeFrame` 里动画在脚本之前，不受脚本运行时门控；
  - 退回与销毁时丢掉；
  - 声音目标当场推给排期器；
  - 新增 `animations()`。
- **删掉过渡键 `value:animation:pending`**（`animations.ts`、`bundle.ts`），注释同步。
- **dev 探针**：
  - `replayReadback` 收 `animations`：每帧在粒子、相机之后推进、写入、`sync`，读回帧同样；
  - `renderFrame` 有 `dts` 时走它，没有时 `seek(time)` 再写；`profile` 帧另用一份；结果加 `animations`；
  - `particleCorners` 同一串 dt；`install.ts` 加 `host.animations`。
- **测试**：新增 `player.test.ts`（18 个）、`dev/replayAnimations.test.ts`（3 个），`host.script.test.ts` 加 7 个。最后一个由主会话补，见变异。

**和子计划不同的地方：**
- **动画写进渲染器正在画的状态**（`renderer.sceneState ?? scriptState`），不是 `scriptState`。平时两者是同一份。只在「清空脚本存储」重建脚本的加载期间不同：那时 `scriptState` 是给新脚本 `init` 用的新状态，写进去会让 `init(value)` 收到动画值（WPE 收到的是 `value`），旧场景的动画也会停住。
- 换场景时先按当前时钟写一次：暂停中重编译时首帧不跑 `beforeFrame`，不写的话会先闪一下编译期的 `value`。
- `carryOver` 连 `rate` 一起接（WPE 改属性时包装对象还在，P10b 用）。
- `renderFrame` 的 `profile` 帧另用一份动画，读回值不受 `profile` 帧数影响。`particleCorners` 也接了动画。

**验收：**
- tsc 0。
- vitest（带 WPE 根）：`62de2c03` 上 2779 → 2807（+28），两边各有同一个 HEAD 上本来就有的失败（`pipeline.test.ts`「`3830255100: 219 次请求`」）；最终在 `1e90d381` 上 3040 → 3068（+28），全部通过。Prettier 干净。
- 语料（183 张）：`value:animation:pending` 从 40 张消失，别的键逐张不变，能渲染 66 → 66（这 40 张都还差别的节）。
- 变异：
  - 代理做了 23 处，全部检出；
  - 主会话另做 5 处，漏了「换场景时先重放脚本、后写动画」。补了用例「暂停中重编译：先写动画、再重放脚本写入，字段是脚本最后写的值」后检出。
- 真机（dev 宿主产物按工作区重建）：
  - 屏外宿主首帧 21 条动画推进到 0.0001 s 并写入，`writes` 为假的 3 条（工程里故意做坏的通道）不写。
  - `render_scene` 按 30 帧 × 1/60 回放 `p10-curves`：float32 时钟到 0.5000002 s，`startpaused` 那条停在第 0 帧照写，画面上方块位置、45° 旋转、颜色都对；不回放、`time` 0.5 时只差 float32 尾数。
  - `p10-curves` 不再有不支持项。
- 开销：在 Node 里编译 `3400241651`（23 条，全会写：15 条常量 float、3 条 angles、3 条图层 vec3、2 条图层 float），`frame()` 每帧均值 0.053 ms，p95 0.074 ms。不写入时 0.027 ms：写入一半的时间在向量拼字符串再解析，要压就让写入不经字符串。浏览器里没量：屏外宿主不跑帧循环，可见预览会占用画廊界面。

**留给 P10b：**
- 派发事件：WPE 在推进时钟的那一条写完之后、下一条写之前派发。现在 `events` 只按收集顺序记，P10b 要给 `frame` 加按条的派发钩子。
- 探针的 `scriptValues` 仍在回放前写一次：同一目标上有动画时探针里动画赢，WPE 里脚本赢。kbp 的 FR 块不受影响。

