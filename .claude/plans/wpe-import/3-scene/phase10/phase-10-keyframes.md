# P10 — 关键帧动画（总计划）

> 上级：[PLAN.md](../PLAN.md)「P10 — 关键帧动画」。前置：步骤 0 只读码、只实测，可以和 P4–P9 并行（2026-11-13 用户：「其他地方在做 phase4、phase5，phase6，phase8，phase9，phase7 已完成，你趁这个时间开始 P10」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `ce8c22ca` 的语料扫描 `ignore/p10/out/corpus-head.json`（173 个工程，能渲染 47 张）。覆盖数：`ignore/p10/ana_p10.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`）。逐条关键帧清单：`ignore/p10/scan_kf.py` → `ignore/p10/out/kf.json`；切线字段：`tangent_keys.py`；脚本原文：`show_scripts.py`。
> 现状行号按 HEAD `ce8c22ca`。

## 总体设计思路

WPE 的属性关键帧是属性值的第三种绑定。`scene.json` 里一个值写成 `{animation: {c0, c1, …, options}, value}`，加载时和 `user`、`script` 一样登记进这个对象的「属性名 → 绑定列表」（P3 报告 I3：动画绑定的虚表是 `0x14048df78`，和用户绑定、脚本绑定挂在同一张表上）。我们推断它每帧推进自己的时间、按关键帧求出值，再经同一个描述符 setter 写进字段、调改值回调。如果是这样，关键帧对渲染器来说就和「用户每帧拖一次滑块」一样（步骤 0 确认）。

P3a 已经有这条路：编译期给每处 `{user}` 登记一个目标（`BindingTarget`），运行时由 `SceneState.write(binding, 值)` 就地写入，`GpuScene.sync` 下一次把它刷进 uniform。P10 把关键帧做成这条路上的第二个写入方：
- **编译期（Worker）**：每个关键帧值解析成一条轨道（`SceneAnimation`），带这些内容：
  - 目标：和脚本用同一套推导，另加 `instanceoverride`；
  - 值类型；
  - 各通道的关键帧：帧号、值、两侧切线；
  - `fps`、`length`、模式与标志、名字、联动与事件。

  `relative` 在这里换算成绝对值，WPE 也是在加载期换算。轨道是纯数据，随 bundle 结构化克隆到主线程。
- **主线程**：`src/animation/` 里一个播放器管全部轨道。每条轨道一份时钟（时间、速率、暂停 / 停止标志，照 WPE 的位），实时帧推进时间、求值，再经 `SceneState.write` 写进状态。求值函数是纯 TS（`curve.ts`），dev 探针、Node 单测和 kbp 回放共用一份。
- **帧里的位置照 WPE**：步骤 0 查清这几件事：
  - 动画在粒子模拟、`animationEvent`、`engine.Tick`、`update(value)` 之间排在哪里；
  - 和脚本写同一个属性时谁覆盖谁；
  - 脚本 `update(value)` 拿到的是不是动画值。
- **脚本**：`getAnimation()` 返回包装对象，直接调播放器。脚本 realm 和宿主同源，做法同 P9b 的 `IVideoTexture`。时间跨过 `events` 里的帧时，播放器把事件排进脚本运行时，由它调 `animationEvent`。

不选「编译期展开成逐帧值表」：语料一共 228 条，最长 900 帧，现场求值很便宜。而且脚本能 `setFrame`、改 `rate`，查表也得按时间插值，省不掉求值函数。

**没有就地路径的目标照报。** 关键帧每帧都写，不能落到重编译上。这样的目标有两类：
- 灯对象的字段是编译期常量（`compile/lights.ts`），改值要重编译；
- 相机对象归 P5d，还没有运行时状态。

这两类报细分键 `value:animation:<目标>`，等各自那一节建好就地路径时一起放开。语料各 1 张，它们本来也还差 P13 / P5d。

**确定性回放。** 如果 WPE 的动画时间是逐帧累加 dt（步骤 0 查），确定性回放（dev 探针 `renderFrame`、kbp 回放）就要喂同一串帧时间；跳到某个场景时刻时，按时间直接定位。验收怎么和 WPE 逐帧比，取决于这一点。

关键决策沿用前几节：
- WPE 语义以读码加实测为准。
- 能力表是唯一事实来源，没实现的照报。
- 验收和 WPE 比，不和作者的预览图比。

P10 另有两条：
- **只加写入方，不加渲染通路**：关键帧值和用户属性、脚本写回走同一个 `SceneState.write`，不新增 uniform、管线或重编译原因。
- **新代码放进独立模块**：放 `apps/wpe-scene/src/animation/`，仿 `audio/`、`video/`。共享文件（`compile/bundle.ts`、`compile/features.ts`、`render/renderer.ts`、`host.ts`、`script/api.ts`）里只加接线。

## 范围与覆盖

语料（`ignore/p10/out/kf.json`）：
- **规模**：40 张场景、228 个关键帧值、1171 个关键帧。全语料 grep `"c0"` 只出现在入口 `scene.json` 里；粒子、材质、模型、effect 的 JSON 都是 0 处。
- **落点**：
  - 对象字段 118 条（27 张）：`alpha` 69、`origin` 27、`angles` 10、`scale` 5、`color` 5，另有相机对象的 `zoom`、灯的 `intensity` 各 1 条；
  - effect 实例常量 105 条（30 张）：`multiply` 36、`Brightness` 14、`scale` 11、`alpha` 11、`Opacity` 7、`Aperture` 5，其余是 `point0–3`、`tolerance`、`right`、`top` 等；
  - `instanceoverride` 3 条（2 张）：`alpha` 2、`count` 1；
  - `general` 2 条：`zoom`、`bloomstrength`；
  - effect 的 `visible` 和布尔值都没有。
- **对象**：图像层 164 条，文本对象 48 条（9 张），分组与组合层 4 条，粒子 4 条，模型 3 条，相机对象 2 条（`3554161528`），灯 1 条（`3465215190`）。
- **值**：
  - 数字 164 条（float 99、int 65），向量字符串 64 条（三分量 47、二分量 17）；
  - 通道数：1 个 163 条，3 个 47 条，2 个 17 条；`3837699827` 的常量 `R` 只有 `options`，没有通道。
- **播放**：
  - 模式：`single` 164 条、`loop` 63 条、`mirror` 1 条（`2974757317`，`fps` 1.2）；
  - `startpaused` 68 条（22 张）；不暂停、自动播放的 160 条（30 张），其中没挂脚本的 135 条（29 张）。
- **并存**：
  - 挂了脚本的 76 条（25 张）；和 `user` 并存的 0 条；
  - `relative` 41 条（15 张）；
  - `options.parent` / `children` 联动 35 条（8 张）；
  - `events` 2 条（`2887099508`，配导出的 `animationEvent`）；
  - 带 `name` 的 53 条（10 张）。
- **`options` 的键**：
  - `fps`、`length`、`mode` 每条都有；
  - `wraploop` 222 条，其中为真的 49 条（10 张），其余是 `null`；
  - `startpaused` 68、`name` 53、`smoothing` 34、`parent` 21、`children` 14、`stiffness` 12、`events` 2；
  - `smoothing` 非空的只有 2 张（`3611425904` 是 0.5，`3818053626` 是 0），`stiffness` 非空的 1 张；
  - `animation` 自己另有 `relative` 41 条、`previewvalue` 32 条。
- **`fps`**：30 有 167 条、60 有 32 条、15 有 19 条，另有 14.5 / 18 / 20 / 6；非整数 3 条（0.9、0.967、1.2，2 张）。
- **关键帧**：
  - 字段只有 `frame`、`value`、`back`、`front`、`lockangle`、`locklength`，没有 `step`；
  - 切线对象是 `{enabled, x, y, magic}`，`magic` 为真的 694 对；
  - 关掉一侧切线的：`back` 122 个、`front` 114 个（12 张）；
  - `frame` 全部严格递增；首帧不在 0 的 17 条（9 张）；
  - 末帧等于 `length` 的 120 条，小于的 107 条，大于的 1 条（`3554161528` 的相机 `zoom`，末帧 118、`length` 90）。
- **脚本**（粗扫，以 `compile/scriptApi.ts` 的编译期扫描为准）：
  - `getAnimation` 27 张，接收者多是 `thisObject`（无参取本属性的动画），13 处按名字取；`thisScene.getAnimation` 1 张；
  - 调到的成员：`play` 最多，其次 `stop`、`rate`、`setFrame`、`frameCount`、`duration`、`pause`、`getFrame`；
  - 常见写法是在光标或媒体回调里 `stop()` 再 `play()`，例如 `2932157836` 的 `mediaThumbnailChanged`；
  - `3486806915`、`3830665420` 只在执行不到的分支里写了 `getAnimation`，编译期按名字扫到就报，P10b 之后自然去掉。

| 节 | 内容 | 只做 P10 时累计能渲染 | P4–P9 先做完时累计 |
|---|---|---|---|
| P10a 曲线与自动播放 | 编译轨道、求值、三种模式与 `wraploop`、`relative`、`startpaused`、写进状态、确定性回放；去掉 `value:animation`，没有就地路径的照报细分键 | 47 → 47 | 82 → 84 |
| P10b 脚本与事件 | `getAnimation`（本属性、按名字、`thisScene`）、`IAnimation` 全部成员、脚本和动画写同一属性、`events` 与 `animationEvent` | 47 | 84 |
| P10c 联动 | `options.parent` / `children`；`smoothing` / `stiffness`（若运行时读） | 47 | 84 |

口径：
- **只做 P10**：40 张关键帧场景都还差别的节，0 张解锁。
- **P4–P9 先做完**：
  - P4–P6 的键沿用 `ana_phases.py`，另把进行中的 P4f（`script:api:particle.*`）、P5c（`model:pending`）、P6b（`text:script*`、`text:anchor:*`）算作做完，能渲染 61 张；
  - P8 之后 68 张，P9 之后 82 张；
  - P10 再解锁 2 张，到 84 张：`2251857160`、`3146703458`。两张都只用到 effect 常量的关键帧，没有脚本控制（`2251857160` 另有两条 `startpaused`），P10a 就够。
- **P10 主要是前置**：42 张用到 P10 键的场景，P4–P10 都做完之后，17 张只差 P11，2 张只差 P12，15 张差 P11 + P12。P11 那一步累计 +40 里，有 17 张要 P10 先做。
- PLAN 的表是 165 张口径（用到 40、只差它 0、累计 92），这里按 173 张重算，累计的假设也不同。

**P10 不做，继续报不支持：**
- **灯对象字段的关键帧**：`3465215190` 点光源的 `intensity`。灯字段是编译期常量，就地写归 P13（这张本来还差 P13 的体积光），报 `value:animation:light`。
- **相机对象的关键帧**：`3554161528` 相机的 `origin`、`zoom`，随相机对象归 P5d，报 `value:animation:camera`。
- **粒子 / 材质 / 模型 JSON 里的关键帧**：语料 0 处，照报原来的 `value:animation`。
- **puppet 与帧表**：`animationlayers` 与 `getAnimationLayer*` 归 P12；图像层帧表的 `getTextureAnimation` 归 P6e。

## 现状锚点

**a. 带关键帧的值一律报 `value:animation`**（`apps/wpe-scene/src/compile/bindings.ts:170`、`compile/features.ts:368`）
```ts
export function isKeyframedValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const animation = (value as { animation?: unknown }).animation;
  return !!animation && typeof animation === "object" && !Array.isArray(animation); // 现状：puppet 的 animation 是整数 id，不算
}
// features.ts
export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) scanValue(v, unsupported);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isKeyframedValue(value)) unsupported.add("value:animation"); // 现状：整张退回；粒子模块字段另由 readParticleModule 报
  for (const v of Object.values(value)) scanValue(v, unsupported);
}
```

**b. 编译期把关键帧值解析成 `undefined`**（`compile/model.ts:188`）
```ts
export function resolveValue(
  value: SceneValue | undefined,
  properties: Record<string, SceneScalar>,
): SceneScalar | undefined {
  if (value && typeof value === "object") {
    // 脚本求值前的编译期初值；运行时写回会覆盖它。
    if ("script" in value) return value.value; // 现状：关键帧 + 脚本的值走这里，取编辑器里的 value
    if (!("user" in value) || !value.user) return undefined; // 现状：纯关键帧值走这里，调用方退回缺省值
```

**c. 脚本 API 检查把 `getAnimation` 和 `animationEvent` 列为缺失**（`compile/scriptApi.ts:203`、`:541`）
```ts
  /** `IObject`：所有对象（图层、effect、材质、动画层、模型数据）都有。`thisScene.getAnimation` 另在 `thisScene` 组。 */
  object: methods("any", ["getAnimation"], UNIQUE), // 现状：用到就报 script:api:object.getAnimation，整张退回
// …
export const MISSING_SCRIPT_CALLBACKS: readonly string[] = [
  // …
  // 关键帧动画的事件 → P10
  "animationEvent", // 现状：导出了就报 script:callback:animationEvent
```

**d. 就地写只有一个入口**（`render/state.ts:366`）
```ts
  write(binding: SceneBinding, raw: SceneScalar): WriteResult {
    const { target } = binding;
    if (target.kind === "recompile") return "recompile"; // 现状：灯字段等走这里，关键帧不能用
    // … effect / bloom / general / particle-instance / sound 各一支
    if (target.kind === "layer") {
      const layer = this.layers.get(target.object);
      if (layer) {
        writeLayer(layer, target.field, bindingValue(raw, binding.condition, target.field)); // 现状：用户属性与脚本写回都到这里
```

**e. 帧循环：粒子 → 声音 → 脚本 → `sync` → `update` → `encode`**（`render/renderer.ts:578`）
```ts
    try {
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor); // 现状：粒子先于脚本（P4c 步骤 4）
    } catch (error) {
      // …
    }
    scene.setCamera(camera);
    if (live) this.options.stepObjects?.(frametime); // 声音（P6a）
    if (live) this.options.beforeFrame?.(frametime, this.spectrum); // 脚本：计时器与 update(value)
    // …
      scene.sync(state); // 现状：脚本写回在这里刷进 uniform；关键帧要插在哪一步由步骤 0 定
      scene.update({ time: wrapped, frametime, … }, state);
      scene.encode(encoder, state);
```

**f. 脚本的写回目标推导，不认 `instanceoverride`**（`compile/scripts.ts:65`）
```ts
function targetOf(
  path: string,
  owner: ScriptOwner,
  key: string,
  initial: SceneScalar,
  sound: boolean,
): SceneScript["target"] {
  // … sound / layer / effect visible / bloom / general / material 各一支
  return { kind: "unsupported", path }; // 现状：instanceoverride 上的脚本落到这里；关键帧要补 particle-instance
}
```

## 与 PLAN.md 的差异

1. **语料**：PLAN 写「32 张、169 处」（2026-11-07），现在是 40 张、228 处；能力表报 `value:animation` 的从 38 张变成 40 张。
2. **`options` 的键**：PLAN 和 sample-gaps 没提 `smoothing`、`stiffness`、`previewvalue`，步骤 0 查运行时读不读。
3. **落点**：多了文本对象（9 张 48 条，P6b 的文本层）、粒子的 `instanceoverride.count`、灯的 `intensity` 和相机对象。后两类照报，见上。
4. **解锁数**：PLAN 写「只差它 0」，这里按 P4–P9 做完重算，P10 解锁 2 张，并写明它是 P11 / P12 的前置。
5. **分节**：PLAN 没分节，这里按「自动播放 → 脚本 → 联动」分三节。

## 步骤 0 — 调研（整节一次）

**读码**（交给代理，REA 看 `wallpaper64.exe` 2.8.42；sample-gaps §3.4 已读到的部分只复核）：
- **每帧更新**：
  - 找动画绑定（虚表 `0x14048df78`）的每帧更新函数，以及它在帧里的位置：相对粒子模拟、`animationEvent`、`engine.Tick`、`update(value)`、属性面板排队的改值；
  - 时间怎么推进：`+= dt`、是否乘 `rate`、用不用场景时间；
  - 帧号是不是 `时间 × fps`；
  - 写字段是否走描述符 setter 和改值回调。
- **插值**：
  - 切线 `x`、`y` 的单位（帧、值）和坐标系；
  - 两侧都开时，是三次贝塞尔按 x 反解，还是 Hermite；
  - 只开一侧、两侧都关时怎么算；
  - `magic`、`lockangle`、`locklength` 运行时不读（sample-gaps 已读到），复核；
  - 首帧之前、末帧之后取什么值：首帧不在 0 的 17 条、末帧小于 `length` 的 107 条、大于的 1 条。
- **模式**：
  - `loop` 怎么回绕：第 `length` 帧和第 0 帧怎么接；
  - `wraploop` 的加载期预处理（`FUN_1401a98b0`）做了什么；
  - `mirror` 的往返周期；
  - `single` 播完的状态：停在末值，还是置 0x40000000；
  - `random`：语料 0 处，只记结论。
- **`startpaused`**：加载后显示什么，是第 0 帧的值还是 `value`；`previewvalue` 读不读。
- **边界与丢弃**：非整数 `fps`（0.9 等）、没有通道的轨道（`3837699827` 的 `R`）、`length` 为 0，以及丢弃一条动画之后属性取什么值。
- **`smoothing` / `stiffness`**：二进制里有没有这两个字符串，运行时读不读。
- **联动**：
  - `options.parent.key` 和 `children[].key` 的语义：共用时钟，还是子跟着父的时间；
  - `name` 的作用域。
- **事件**：
  - `events[]` 的 `frame`、`name`，时间跨过时怎么排进 `animationEvent`；
  - `AnimationEvent` 的字段；
  - `loop` 下每一轮是否再触发。
- **和 `user`、`script` 并存**：
  - 每帧谁最后写；
  - 脚本 `update(value)` 拿到的 `value` 是什么；
  - 脚本写回之后，下一帧动画会不会再覆盖；
  - 用户改属性对动画的影响（语料 0 处，只记结论）。
- **通道到分量**：标量、vec2、vec3（`origin`、`scale`、`color`）、`angles` 的单位（关键帧值是不是和 `scene.json` 一样用弧度）、布尔（语料 0 处）。
- **脚本 API**：
  - `getAnimation()` 无参与按名字各找谁（本对象、全场景），`thisScene.getAnimation` 找谁，找不到返回什么；
  - `IAnimation` 每个成员的原生实现：`fps`、`frameCount`、`duration`、`name`、`rate` 的范围，`play` / `pause` / `stop` / `isPlaying`（sample-gaps 已读到这四个），`getFrame` 带不带小数，`setFrame` 在暂停时是否立即写值。
- **暂停与重载**：壁纸暂停、对象不可见时动画推不推进；属性改动触发重编译时（我们保留 realm），动画时间要不要保留。

**实测（WPE + RenderDoc）：**
- **测试工程**：kbp gen 加关键帧值的生成。一个小图像层，`origin` 的 x 写已知关键帧，每种情形一条：
  - 两侧切线开（平的、斜的）、只开一侧、两侧都关；
  - 首帧不在 0、末帧在 `length` 之前；
  - `loop`（`wraploop` 开 / 关）、`mirror`、`single`；
  - `relative`、非整数 `fps`；
  - 另外 `alpha` 与一个 effect 常量各一条看标量路径，`color` 一条看 vec3。
- **读值**：每帧从抓帧里读图层四角（`origin`）和常量缓冲（`alpha`、effect 常量），配上 CLK 图层的场景时间与帧时间。由此定下时间推进、插值公式、各模式与边界。
- **脚本工程**：
  - 挂了脚本的关键帧值：`update(value)` 把收到的 `value` 打进日志；
  - 按时间调 `play` / `pause` / `stop` / `setFrame` / `rate`，`getFrame` 打日志；
  - `events` 配 `animationEvent` 打日志。
- **联动工程**：父、子各一条，长度不同，看子跟谁的时间。
- **暂停**：WPE 测试窗口能暂停就测暂停前后动画时间是否连续，做不到就只读码。
- **语料**：只差 P10 的两张（`2251857160`、`3146703458`）和 `kabegame-sample` 各抓一组，作为 P10a 语料验收的真值。

**产出：** `rea-p10-keyframes.md`（读码）、`p10-REPORT.md`（实测）、本文件的步骤 0 实施记录；kbp-tools 的关键帧生成，以及按名字读每帧常量的提取（现有 `rdc track` / 四角不够时加）。

## P10a — 曲线与自动播放

**实现**（按步骤 0 的结论细化）：
- **编译期**：
  - `compile/animations.ts` 按 `collectScripts` 的坐标遍历 `scene.json`，把关键帧值解析成 `SceneAnimation`；
  - 目标推导和脚本共用：把 `scripts.ts` 的 `targetOf` 提出来，补上 `instanceoverride` → `particle-instance`；
  - `relative` 换算成绝对值；丢弃条件照 WPE，丢掉的动画按静态值处理；
  - `resolveValue` 对关键帧值给出编译期初值（取 `value` 还是第 0 帧的值，按步骤 0）。
- **能力表**：去掉 `value:animation`；目标没有就地路径的报 `value:animation:<目标>`（灯、相机对象）；粒子、材质、模型 JSON 里的照报原键。
- **主线程**：
  - `animation/curve.ts` 是纯求值函数，`animation/player.ts` 管轨道时钟与每帧写入；
  - 宿主建场景时建播放器；重编译时动画时间保留与否按步骤 0；
  - 渲染器在步骤 0 定的位置调 `animations.frame(dt, state)`，补画帧不推进。
- **确定性回放**：dev 探针的 `renderFrame` 与 kbp 回放按帧时间序列推进动画时钟。

**验收：**
- 确定性工程逐帧和 WPE 比四角与常量值，误差写进实施记录；
- 解锁的两张在 P8、P9（以及 `2251857160` 要的 P4f）合入后，和 WPE 同一时刻比整帧；
- 语料：去掉 `value:animation` 后只剩两个细分键各 1 张，其余场景逐张不变。

## P10b — 脚本与事件

- **`getAnimation`**：无参取本属性的动画，按名字和 `thisScene.getAnimation` 照步骤 0 查找。`IAnimation` 的 11 个成员是包装对象直接调播放器，`getAnimation` 从 `scriptApi.ts` 的缺失表删掉。
- **脚本与动画并存**：写同一个属性时的先后、`update(value)` 的参数，照步骤 0。
- **事件**：`options.events` 由播放器在时间跨过时排给脚本运行时；`animationEvent` 从 `MISSING_SCRIPT_CALLBACKS` 移到 `RUNTIME_CALLBACKS`，返回值写回照 P3 报告（只有 init、update、animationEvent 的返回值写回）。

**验收：** 脚本工程的每一步和 WPE 的日志、抓帧一致；27 张用到 `getAnimation` 的场景在 dev 强制渲染（`kabegame-dev-scene-force-render`）下脚本不报错。很多场景在光标回调里调 `play`，要等 P6c 之后才能完整验收。

## P10c — 联动

- `options.parent` / `children`（8 张 35 条）照步骤 0 实现。
- `smoothing` / `stiffness`：运行时不读就按中性放开；读的话在这里做。
- 步骤 0 如果证明联动只是编辑器的分组、运行时各走各的，P10c 并进 P10a，本节取消。

**验收：** 联动工程和 WPE 逐帧一致。

## 和其它节的交界

- **共享文件**：P4–P9 的会话都在改 `compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`render/renderer.ts`、`host.ts`、`script/api.ts`。
  - P10 的新代码放 `src/animation/`；
  - 共享文件只加接线，按块暂存；
  - 改帧循环前先看一次别的会话的状态，同 P6、P7、P9 的约定。
- **P3a / P3b**：复用绑定目标与 `SceneState.write`；脚本 realm 同源，`IAnimation` 的包装直接调播放器。
- **P4**：`instanceoverride` 的 `alpha` / `count`（3 条、2 张）走 P4a 的就地路径；粒子对象的 `angles` 走图层字段。
- **P5**：`general.zoom`（1 张）每帧读，动画写进去即可（P5a）；相机对象的关键帧随相机对象一起做（P5d）。
- **P6**：
  - 文本对象的 `alpha` / `origin` 与文本 effect 常量（9 张 48 条）走同一条图层 / 常量路径，文本层的就地字段以 P6b 合入后为准；
  - 用 `getAnimation` 的脚本多在光标回调里调 `play`，归 P6c。
- **P11**：`mediaThumbnailChanged` 等媒体回调里的 `getAnimation().play()`（如 `2932157836`），媒体回调归 P11。
- **P12**：`AnimationEvent` 也由 puppet 动画发（`lib.sceneScript.d.ts` 的注释）。P10 只做属性动画的事件；`getAnimationLayer*` 归 P12。
- **P13**：灯字段的就地写。
- **工具**：kbp-tools 的关键帧生成与提取是它的新子功能，按它的协议加（在 SKILL 里登记）。

## 决定（2026-11-13 用户：同意，四条按推荐）

1. **实现方式**：推荐编译期解析成曲线，运行时每帧求值写进 `SceneState`（PLAN 的做法），不展开逐帧值表。理由见「总体设计思路」。
2. **灯与相机对象的关键帧**：推荐 P10 只报细分键，就地路径分别随 P13 / P5d 做，不在 P10 给灯加就地路径（只 1 张，而且还差 P13）。
3. **分节**：推荐 P10a → P10b → P10c；P10c 视步骤 0 可能并进 P10a。
4. **顺序**：步骤 0 现在就做（只读码、只实测）。P10a 的实现要改帧循环和能力表，和 P4–P9 的会话错开；P10a 的语料验收要等 P8、P9 合入。

## 风险

1. **插值公式**：切线的单位或贝塞尔的反解对不上时，误差随曲线形状变化，只能靠测试工程覆盖各种切线组合。
2. **时间基准**：如果 WPE 逐帧累加 dt（带 float32 累加误差），长时间后会和按场景时间求的值漂开。照 WPE 累加，确定性回放喂同一串 dt。
3. **和脚本的先后**：76 条挂了脚本，先后错了画面会差一帧或被覆盖。步骤 0 的脚本工程定。
4. **共享文件**：和 P4–P9 的会话同时改帧循环、能力表与脚本 API。按块暂存，必要时在 HEAD 快照里实现再三方合并。
5. **验收样本**：只差 P10 的两张要等 P8 / P9 / P4f 合入才能整帧比，在那之前靠确定性工程。

## 实施记录

（空）
