# 场景壁纸：关键帧动画

> [场景壁纸文档](../WPE_SCENE.md) 的一章：关键帧动画与脚本 `IAnimation`（P10）。总体形态、各阶段状态与全部章节的索引在总览里。

## 关键帧动画（P10a、P10b）

`scene.json` 里写成 `{animation: {…}, value}` 的属性在 WPE 里是第三种写入方（另两种是用户属性和脚本写回）：每帧在粒子与相机之后、脚本 `update` 之前，按每条动画自己的 float32 时钟求值，经属性的 setter 写进字段。我们走同一条路：P3a 的绑定目标 `BindingTarget` 加 `SceneState.write`，不加新的 uniform、管线或重编译原因。P10b 接上脚本：`getAnimation` 返回的 `IAnimation` 直接调播放器，时钟越过的事件当场派发给脚本的 `animationEvent`。依据：读码 [rea-p10-keyframes](../../../.claude/plans/wpe-import/3-scene/phase10/rea-p10-keyframes.md)，实测 [p10-REPORT](../../../.claude/plans/wpe-import/3-scene/phase10/p10-REPORT.md)（含「P10b 补测」），计划、实施记录与走查见 [phase-10a-curves.md](../../../.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md)、[phase-10b-script.md](../../../.claude/plans/wpe-import/3-scene/phase10/phase-10b-script.md)。

| 层 | 位置 | 做什么 |
|---|---|---|
| 求值 | `animation/curve.ts`、`animation/clock.ts`、`animation/types.ts` | 纯 TS，照读码第 14 节逐位写、float32 用 `Math.fround`：关键帧解析与 `wraploop`、整数帧上的三次贝塞尔（步进搜索反解）带缓存、整数帧之间线性插值；时钟的 `loop` / `mirror` / `single` 推进与事件收集，`play` / `pause` / `stop` / `setFrame` 等控制；丢弃的动画用惰性时钟（`AnimationClock.inert`） |
| 编译 | `compile/animations.ts` → `SceneBundle.animations` | 每个关键帧值一条纯数据：目标（和字段脚本共用 `targetOf`）、值类型与 `writes`、通道、时钟参数、父的下标、事件 JSON，以及 `name`（`options.name`）、`object`（事件的接收范围）、`owner`（查找与联动的属主）、`inert`（丢弃的照样登记）；按 WPE 的登记顺序（`compile/registration.ts`）；effect 常量的 uniform 名等着色器编完再补（`settleConstantAnimation`，同字段脚本）；没有就地目标的报细分键（见 [COMPILE.md](COMPILE.md)「能力表」） |
| 播放 | `animation/player.ts`（`SceneAnimations`） | `frame(dt, state, hooks)`：按登记顺序走，时钟主人本帧第一次用到时推进一次（子排在父前面也不晚一帧），推进量 `f(f(rate)·f(dt))`；会写的按主人的时钟求值，经 `SceneState.write` 写入（返回值不看，所以动画不触发重编译），`recompile` / `unsupported` / `script-property` 目标不写；暂停的照写；这一条推进出的事件在它处理完、下一条之前同步交给 `hooks.event`。每条都有自己的时钟（子的从不推进）；`control(id)` 给 `IAnimation` 的落点。`write`（不推进写一次）、`carryOver`（重编译时按 `id` 接回时钟、`rate` 与通道）、`seek`（dev 近似）、`probe`（含最近 100 个事件） |
| 脚本 | `script/api.ts`、`script/runtime.ts` | `getAnimation` 装在图层、effect、材质、`general` 与 `thisScene` 上，`IAnimation` 包装对象按 `id` 缓存、每次调用现取落点；`ScriptRuntime.animationEvent(object, json)` 发给同一图层上跑完 `init` 的脚本 |
| 宿主 | `host.ts` | 要跑 `init` 的加载先按新 bundle 建待用播放器（`pendingAnimations`，`init` 里的控制才有落点），换上时直接用、不接旧时钟；其余换场景时新建播放器、`carryOver`；都先写一次，再重放脚本写入（暂停中重编译首帧不跑 `beforeFrame`，不写会先闪编译期的 `value`）；每个实时帧在脚本之前 `frame`，写进渲染器正在画的状态（只在「清空脚本存储」重建脚本时和 `scriptState` 不同）；声音目标当场推给排期器；事件钩子接到 `runtime.animationEvent`；退回预览图与销毁时丢掉 |

**规则**（WPE 读码与实测）：
- **时钟**：每条动画（联动的子用父的）一个 float32 时间，每帧 `t += rate × dt`，`dt` 就是 `g_Frametime` 用的那个，`rate` 缺省 1，不读 `g_Time`；帧号 `t / (1/fps)`（float32）。
- **插值**：先按整数帧求三次贝塞尔（切线 x 以半个段长为单位、y 是值的绝对偏移，关掉的一侧按 (0, 0)，`step` 看段的右端关键帧），x 用步进搜索反解（步长 0.999 先减半再走，`|x − f| < 0.01` 帧或 1000 次停），再在相邻整数帧之间线性插值；首帧之前取首帧值，末帧及之后取末帧值。
- **模式**：`loop` 回绕取 `fmodf`、第 length 帧不画；`mirror` 周期 2·length；`single` 停在 length 处（部分 fps 如 14.5、1.2 因 float32 停在第 length − 1 帧的值）；`wraploop` 加载时在 length 处补首帧的值。
- **写入**：通道数必须等于分量数，属性必须是 float、vec2、vec3、vec4 之一，否则整条不写、保持 `value`（不报不支持，WPE 也什么都不做）；`startpaused` 时钟不走、每帧照写第 0 帧的值；对象隐藏时照常推进与写入；`angles` 的关键帧是弧度；`relative` 只对三段字符串的 `value` 生效。
- **一帧里的顺序**：粒子、相机 → 动画 → 脚本 `update` → 渲染。所以动画写的 `general.zoom` 晚一帧生效；脚本本帧写的值下一帧被动画覆盖；`init(value)` 收到的是静态 `value`。
- **联动**：`options.parent.key` 是同一对象上另一个属性的名字，子完全用父的时钟（时间、模式、暂停、`rate`），`children` 不读。
- **重编译**：改属性不重载场景，按 `id` 接回时钟（`t`、标志、`rate`），时钟参数变了才从 0 开始。「清空脚本存储」重建脚本时动画一起从头来（P10b 决定 1，等于重开壁纸）。
- **丢弃**：`options` 不合法（不是对象、`fps` / `length` 不是数或不为正）的动画照样登记、`getAnimation` 找得到：`fps` 读出 1、`duration` 0、时钟不走、不写。材质常量在着色器里没有 uniform 的不建绑定、找不到。
- **查找**（P10b）：`getAnimation(名字)` 按 `options.name` 或属性名找，取登记顺序里第一条。对象上的只在这个对象的属主里找（图层字段归图层，effect 常量归它所在的材质 pass，effect 的 `visible` 归 effect，`general` 的归 `general`；所以图层上找不到 effect 常量的动画），参数不是非空字符串时用当前脚本所挂属性的名字，找不到返回 `undefined`；`thisScene.getAnimation` 找全场景，参数不是字符串、找不到都是 `null`，空串取第一条没写 `name` 的。模块顶层调用抛 `SyntaxError: getAnimation cannot be called from global scope.`。
- **`IAnimation`**（P10b）：12 个自有可枚举成员，顺序 `name`、`frameCount`、`duration`、`fps`、`rate`、`play`、`isPlaying`、`stop`、`pause`、`setFrame`、`getFrame`、`getAnimation`；前四个只读（严格模式下赋值抛 `TypeError`）；同一条每次是同一个对象。`rate` 缺省 1、不钳制、只收数字（`NaN` 也收）；`setFrame(f)` 只改时间、下一帧才写值，`f` 不是数按 0；`play` 在 `single` 播完后先归零；`stop` 归零并暂停。子动画上的控制改的是子自己从不推进的时钟，不影响画面。
- **事件**（P10b）：时钟越过事件帧的那一帧，在越过它的那一条写完之后、下一条之前派发，`loop` 的回绕帧先发回绕前的、再发回绕后的，`mirror` 正反向各一次。接收者是动画所在图层（或 `general`）上导出了 `animationEvent` 且跑完 `init` 的全部脚本，按登记顺序；回调 `animationEvent(event, value)`，`event` 是作者写的整个事件对象（键排序、数字 8 位有效数字），`value` 是接收脚本自己属性的当前值，返回值写回。派发是同步的：回调里对排在后面的动画 `stop()`，那一条本帧就写第 0 帧的值。

**能力表**：没有就地目标的照报 `value:animation:other`。灯对象（P13f2）与相机对象（P5i：变换走图层、`fov` / `zoom` 走 `camera`）按字段有就地目标，原来的 `value:animation:light` / `value:animation:camera` 不再报。P10b 起 `script:api:object.getAnimation` / `thisScene.getAnimation`、`script:callback:animationEvent` 不再报。

**走查**（FINAL_CHECK，2026-11-14）：
- 四个生成测试工程（`ignore/p10/proj/`，窗口与场景同为 1920×1080）：不受脚本控制的动画整帧逐像素相同（`p10-curves`、`p10-zoom` 18 帧含 FR、CLK）；`p10-zoom` 的缩放和 WPE 一样晚一帧。
- 真实壁纸的复制工程（`kbp content isolate`）7 张：`3577990983`（转场 effect）15 帧逐像素相同；其余动画写进的值（effect 常量、`alpha`、`color`、`angles`、`origin`、组缩放、文本层 alpha 与 `origin`）和 WPE 逐位相同。当时的像素差归「窗口与场景不同高」（WPE 按窗口分辨率画）；按窗口尺寸重跑（[phase-render-size](../../../.claude/plans/wpe-import/3-scene/phase-render-size.md)「步骤 2」）后 `intro`（7680×2160，场景比窗口大）、`rings` 全部逐像素相同，`frostp` / `sun` / `gradt` / `whale` 每帧剩 0–3507 个 ±1，逐 draw 查过都和尺寸无关：`sun`、`gradt`、`frostp` 都出在输入与常量都和 WPE 相同的那一次绘制里（着色器求值的舍入；`sun` 那次绘制的 `g_ModelViewProjectionMatrixInverse` 原先差 1 ulp，2026-11-15 改成 WPE 的单精度求逆后 14 个常量全部相同、像素差不变，[phase-f32-inverse](../../../.claude/plans/wpe-import/3-scene/phase-f32-inverse.md)）。
- 依据与逐 draw 对照见子计划「步骤 3 走查」「步骤 4」。
- P10b：`p10-script`、`p10-edge`（不再排除受脚本控制的对象）与补测工程 `p10b-api` 共 23 段 69 帧，带脚本回放后全部逐像素相同，`[kf]` 日志的逐帧条目与事件条目（含回调里读到的 `engine.runtime`）和 WPE 相同。真实壁纸 `3336377291`、`3427691867` 的时钟（`init` 里 `play()`）复制工程 8 段：逐 draw 的 MVP 与 alpha 0 ulp，动画中途那帧两边 alpha 都是 0.7435418367385864；当时像素差只在文字上，顶点与图集两边相同，归「按窗口分辨率画」，按窗口尺寸重跑后 24 帧逐像素相同。走查里修了两处：经字符串写回的 `NaN` 被读成 0（`atof` 补上 UCRT 的 `inf` / `nan`）、dev 探针里事件回调读到的 `engine.runtime` 晚一帧（`ProbeScripts.enterFrame`）。
- P10b 补走查（P6c 之后）：`2887099508` 的翻页复制工程。WPE 用 `input_play` 点击，我们用探针 `inputTimeline` 按同一串帧时间与光标回放。
  - 事件链：点击 → `900` → `houye` → `111` → `yeshu`。逐帧日志（两条动画的帧号与是否在播、两层可见）1220 帧逐项相同；
  - 播完的 `single` 再 `play()` 从头播，事件每轮都派发；
  - 抓帧上书页那次绘制的 `g_Point0–3` 与 MVP 0 ulp，当时的像素差归「按窗口分辨率画」；按窗口尺寸重跑（6080×3420 场景、1920×1080 窗口、`ultra`）5 帧逐像素相同。
  - 27 张用 `getAnimation` 的场景按网格点击跑脚本，没有 `getAnimation` / `IAnimation` 相关的错误（回归 K11）。

**已知差异与只记不补**：
- `IAnimation` 的 `rate` 是访问器、原型是 `Object.prototype`（WPE 是原生数据属性、只有 `constructor` 的原型），只在脚本检查描述符或原型时看得出。
- 媒体回调里的 `getAnimation`（如 `2932157836` 的 `mediaThumbnailChanged`）等 P11 接上回调后再走查。P11c 走查了 `2932157836` 的复制工程（含这个回调）：等事件后的动画收敛再抓，除挂 `spin` 的圆形封面外整帧逐像素相同；动画播放过程中的逐帧对照没做。
- 每帧照写的开销：语料最多的 `3400241651`（23 条）`frame()` 每帧均值 0.053 ms，一半在向量拼字符串再解析。
- dev 探针 `scriptValues` 仍在回放前写一次：同一目标上有动画时探针里动画赢，WPE 里脚本赢（kbp 的 FR 块不受影响）。

**语料**（183 张）：P10b 去掉 `script:api:object.getAnimation`（27 张）、`thisScene.getAnimation`、`script:callback:animationEvent`（各 1 张），没有新增键；这 27 张都还差光标回调、媒体回调或人偶，能渲染数不变。P10a：`scene.json` 里的关键帧在 40 张场景里报过 `value:animation`，全部去掉；`2251857160`（P8、P4f 之后只差这一项）能整张渲染。40 张共 225 条动画、220 条会写（不写的 5 条：4 条常量在着色器里没有 uniform，1 条没有通道），联动 17 处，事件 2 个；其余场景还差脚本的回调与 API、人偶、相机路径等别的节。

**dev 探针**：`renderFrame` 有 `particles.dts` 时动画沿同一串 dt 逐帧推进（每帧在粒子与相机之后、第二次 `sync` 之前），没有时 `seek(time)` 再写一次；结果的 `animations` 给每条的 `id`、时钟主人、`t`、帧号、`playing`、标志与最后写入的值；`host.animations()` 报宿主正在播的那份与最近 600 次 `frame()` 的耗时。跑脚本（`scripts`）时播放器在 `init` 之前建好、交给探针的脚本环境，事件派发给探针的脚本；每帧推进动画之前先 `enterFrame` 把本帧时间交给脚本时钟，事件回调读到本帧的 `engine.runtime`。
