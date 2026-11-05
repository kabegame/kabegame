# P3c — 做到 WPE 程度的不重编译（effect 可见性单图层重算等）

> 上级：[PLAN.md](PLAN.md)「P3 — SceneScript」。前置：[phase-3a-bindings.md](phase-3a-bindings.md)、[phase-3b-script-runtime.md](phase-3b-script-runtime.md) 已验收。
> 依据：[p3-script-REPORT.md](p3-script-REPORT.md) I2（哪些会重建）、I3（逐类绑定与改值回调）、I7 第 3–5 条；[p2-REPORT.md](p2-REPORT.md) B5 / B11（合成次数、`FUN_1401e6300`）；PLAN P2a「effect」「合成 RT」、P2b「HDR 判定」。
> 修订（2026-11-05）：按 3b 步骤 6 的语料排行与用户决定，加「点 0」：
> - 脚本环境由遮蔽改为改写；
> - 持久化的 WPE `localStorage`；
> - `registerAudioBuffers` 占位；
> - 探针修正。
>
> 现状锚点按 3b 结束时（`7bfb9d30`）的代码重核。
>
> 修订（2026-11-06）：用户一度决定允许卡帧，effect 开关的单图层重建做成了后台异步（第一版，未提交）。用户随后说明那只是猜测，目标是对齐 WPE；查清 WPE 的实际行为后（[p3-script-REPORT.md](p3-script-REPORT.md) J 节）改成加载时备好、切换同步（已定 11）。总体设计第三段、点 3 与风险已按此改写，经过见实施记录「步骤 2」。

## 总体设计思路

3a 把材质常量、图层变换 / 颜色 / 可见性、泛光参数改成了就地写，3b 让脚本也写同一份状态；剩下仍要整场重编译的，是 effect 可见性、泛光开关、泛光级数、清屏色 / 环境光 / 相机、`colorBlendMode`、`hdr`、`size`。WPE 里这些大多也是就地处理的（I3）：effect `visible` 的改值回调 `FUN_1401e6300` 重算该图层的合成次数与 pass 数，数值变了才调图层虚函数 +0x110（`FUN_1402065e0`）重算尺寸、几何、合成 RT 与 passthrough 材质，别的图层与整场都不动；`bloom` 位每帧读；清屏色、环境光逐帧读或拷进渲染上下文；只有 `hdr`（运行中改不生效）、用户纹理（换纹理）、颜色校正（编新变体）例外（I2）。P3c 的目标是：WPE 就地处理的，我们也就地处理；重编译只剩 WPE 自己也要重建或不生效的情形，以及我们自己的设置变化（「场景后处理」档位）。

主体是 **effect 可见性的单图层重算**。现在编译期直接丢掉未启用的 effect（它们不进 bundle、不检查能力、不翻译着色器），所以运行时没法打开。P3c 改成：凡是可见性可能在运行时变化的 effect（`visible` 绑了用户属性，或有脚本挂在它的 `visible` 上），不论当前开关都编进 bundle，带上初始开关与**它自己的**不支持项；场景级的 `unsupported` 只算当前启用的 effect。写死 `visible: false`、没有任何绑定的 effect 照旧丢掉。运行时开关一个 effect，只对它所在的图层重新 `planLayer`（纯函数，已有）、按新步骤重建该图层的 draw、bind group 与 op 序列，换进 `GpuScene` 的图层表；要打开的 effect 带有不支持项时，退回整场重编译，结果照常退回预览图（与现在一致）。

单图层重建**同步**完成（已定 11），分两段，和 WPE 一样：加载时把可变图层可能用到的程序和管线全部建好；切换时在 `sync()` 里当场换上，不等待任何东西。脚本在 `sync()` 之前运行，所以脚本写的开关同一帧就画，属性改值后第一帧生效，这两点不需要额外处理。

WebGPU 的管线绑定了混合、目标格式与写掩码，而 WPE 的 D3D11 着色器不绑，这是我们要多做的部分。不需要枚举全部开关组合：管线键只取决于 pass 和角色，所以 n 个可变 effect 只要 n+2 份计划就覆盖全部键。全开覆盖每个 pass 的普通角色，全关覆盖基础 pass 直接上屏，「某个可变 effect 开、它后面的可变 effect 全关」覆盖它的上屏角色。枚举直接复用 `planLayer`，不写第二份规则。带 `unsupported` 的 effect 打开时整场重编译，不算可变。

切换时能失败的检查尽量提前到加载时，n+2 份覆盖不到的组合（全部开着的 effect 都没有绘制 pass）在切换时当场查，抛错走 `fail`。预建失败不影响当前画面，只把图层标成「不能就地切换」，之后切这一层走现有的整场重编译。这样切换路径上没有失败分支，没有后台任务、签名循环和重建失败回调；万一还有校验错误，走已有的 `onuncapturederror`，退回预览图。

`clear` 的触发看「开关真的变了」，不看计划签名：同一帧内关了又开，计划不变，但 WPE 仍然清。清的是 fbo 本身，不受 swap 影响，所以按初始对应取实体。

可变 effect 的纹理和 fbo 在加载时就建好（点 1），第二张合成 RT 和快照在预建时补齐。加载与切换共用 `buildLayer`，所以没有两套建图层的逻辑，这也是「就地 = 重编译」字节相等的保证。旧 draw 的缓冲换下时销毁，开关多少次都不累积。没有可变 effect 的场景不进入任何新路径，资源数与画面不变。

其余几类：**泛光开关**照 WPE 每帧读——`general.bloom` 可变时，只要档位不是关闭、场景有对象就把泛光链建好，开关只决定本帧跑不跑泛光那一步；HDR 仍只在加载时判定（P2b，WPE 的 HDR 渲染位与交换链格式只在加载时算），运行中打开泛光的 LDR 场景得到 LDR 泛光。**泛光级数**照 WPE 预建：`bloomhdriterations` 可变时按可用级数建满金字塔，每帧只用前 N 级。**清屏色、环境光 / 天光、相机 `eye`** 直接就地写（正交相机里 `eye` 只进 `g_EyePosition`）。`colorBlendMode`、`hdr`、`size` 的处理见待定。

关键决策：可变性按「有没有绑定」判定，而不是所有 effect 都编进 bundle——这样没有绑定的场景（目前本机能渲染的全部）在 P3c 前后 GPU 资源与画面逐字节相同，回归面最小；代价是绑定表成为可变范围的唯一依据，3a 的完整性单测因此更重要。

另有一组与渲染图无关的脚本侧改动（点 0），先做。

**环境对齐从「遮蔽」改成「改写」。** 3b 把 WPE 没有的 22 个浏览器全局逐个遮成 `undefined`。现在不再遮蔽，只把和 WPE 同名、但语义不同的两个全局改写成 WPE 的形状：`console`（只有 `log` / `error`，与 3b 相同）和 `localStorage`。其余浏览器全局照常留着。理由：
- 正确的样本不会用这些名字：3b 语料里没有任何报错来自它们；
- 环境对齐本来就不是安全边界（3b 已定 4）；
- 遮蔽表要维护，也挡不全（5 个名字不可配置）。

代价是，在 WPE 里会因为这些名字报错的脚本，在我们这里可能能跑。

**WPE `localStorage` 直接做成持久的。** 底下存进宿主所在 `file:` 来源的浏览器 `localStorage`：
- 键加前缀隔离：`kabegame:wpe-scene:ls:<图片 id>:<位置>:<键>`；
- 值按 JSON 存取；
- `clear` 只删本场景、本位置前缀下的键。

脚本看不到宿主、网页壁纸和别的场景存的东西，宿主的 dev 开关也不会被脚本改写。

**`engine.registerAudioBuffers` 直接接真实音频**，结构照 WPE：`{left, right, average}`，长度 16 / 32 / 64。数据源复用 Phase 8 的 `WpeMediaHub`：
- 场景宿主本身是子 frame，和网页壁纸的垫片走同一个命令 `wpe_web_media_subscribe`，只需让命令认识宿主（同 `wpe_web_pull_state` 的宿主分支）；
- 脚本第一次注册时才订阅，Hub 有订阅才开回环采集；
- Hub 每 33 ms 推一帧 64 段频谱，宿主按注册过的分辨率合并，原地写进脚本持有的缓冲；
- 拿不到音频时（壁纸没声明 `supportsaudioprocessing`、非 Windows、订阅失败）缓冲保持全零，不报错，相当于没有声音在放。

这样 3b 语料里 124 段在模块顶层就失败的脚本能正常求值。放行条件沿用 Phase 8：本机用脚本音频的 10 张场景全部声明了 `supportsaudioprocessing: true`。

同时把 dev 探针在步骤 6、7 里暴露的统计缺口补上。

**当前壁纸属性面板加「暂停」和「清空存储」**（点 0b）。面板 `WpeWebPropertiesPanel` 是预览详情与设置页共用的，所以面板只管显示，状态由父组件传入：预览控制预览这一份，设置页控制桌面。

暂停沿用 `WallpaperStage` 现成的 `paused`。桌面这边是新设置 `wallpaperPaused`，走设置架构，壁纸窗口从 `setting-change` 收到后传给 Stage；它只对网页和场景生效，切到普通图片或视频时不起作用，否则那些类型没有面板，用户没法恢复。

网页壁纸现在的暂停是隐藏 iframe、不冻结脚本，用户手动暂停时画面会消失。改成 iframe 保持可见，由垫片冻结 `requestAnimationFrame`、CSS 动画和媒体元素，并照旧调页面的 `setPaused`。靠计时器驱动的页面管不到。

清空存储只对场景提供：网页壁纸的 `localStorage` 没有前缀，所有网页壁纸共用一份，没法只清一张。应用页和这份存储不同来源，所以由后端发事件，同一张图的全部宿主收到后停脚本、删本场景的前缀、重建脚本环境。不重启脚本的话，内存里的值很快又会被写回去。

## 现状锚点

**a. 编译期丢掉未启用的 effect**（`apps/wpe-scene/src/compile/bundle.ts:575`）
```ts
    for (const [source, raw] of (Array.isArray(object.effects) ? object.effects : []).entries()) {
      if (settled()) break;
      const instance = (raw ?? {}) as SceneEffectInstance;
      // 未启用的 effect 整步跳过（B11），也不检查它的能力；但可见性绑定登记成重编译目标（P3a，3c 改为单图层重算）
      if (
        bindings.bind(
          instance.visible,
          properties,
          recompile("effect-visible", `objects/${index}/effects/${source}/visible`),   // 现状：用户绑定登记成重编译
        ) === false
      )
        continue;                                                                       // 现状：不进 bundle
      // …checkEffectFeatures(…, unsupported) —— 现状：不支持项直接进场景级 unsupported
```

**a2. 脚本挂在 effect `visible` 上也走重编译**（`compile/scripts.ts:62`、`host.ts:203`）
```ts
  if (owner.kind === "effect" && key === "visible") return { kind: "recompile", reason: "effect-visible", path };
```
```ts
  private writeScript(target: ScriptTarget, value: number[] | boolean): boolean {
    if (target.kind === "recompile") {
      const old = this.scriptOverrides.get(target.path);
      // …值没变就返回
      this.scriptOverrides.set(target.path, value);   // 现状：写进覆盖表，交给 Worker 重新编译（3b 待定 6）
      this.options.report.debug(`场景脚本重编译目标变化：${target.path}`);
      this.requestScriptReload();                     // 现状：同一时刻最多一个在途，结束后若又变了再来一次
      return true;
    }
```

**b. 渲染图只看 bundle 里的 effect**（`render/graph.ts:180`、`:105`）
```ts
  // 上屏的那一步：最后一个启用 effect 的最后一个绘制 pass（passthrough 时没有）
  let finalEffect = -1,
    finalStep = -1;
  if (!passthrough)
    for (let e = layer.effects.length - 1; e >= 0 && finalEffect < 0; e--)   // 现状：layer.effects 即「启用的」
      for (let s = layer.effects[e].steps.length - 1; s >= 0; s--)
        if (layer.effects[e].steps[s].kind === "draw") { finalEffect = e; finalStep = s; break; }
```
```ts
// needsComposite：有启用的 effect，或 colorBlendMode 混合
export function needsComposite(layer: Pick<SceneLayer, "effects" | "colorBlendMode">): boolean {
  return layer.effects.length > 0 || isPassthroughBlend(layer.colorBlendMode);
}
```

**c. GPU 资源按加载时的计划一次建好，之后不再变**（`render/scene.ts:370`、`:661`）
```ts
    plans.forEach((plan, index) => {
      // …
      if (plan.composite) {
        const { width: cw, height: ch, count } = plan.composite;   // 现状：合成 RT 只按当前计划的张数取
        // …池里不够就建
      }
      const maps = layer.effects.map((effect) => /* fbo：按 bundle 里的 effect 建 */);
      for (const step of plan.steps) {
        // …每个绘制步骤 createDraw：管线按 step.role 决定的目标格式与混合建一种
      }
    });
```
```ts
    const toScene = step.target.kind === "scene";
    const format = toScene ? this.format : (this.resolveTarget(step.target, resources)?.format ?? this.format);
    return {
      // …
      pipeline: await pipelineFor(program, step.blending, format, !toScene),   // 现状：只有当前角色的一种管线（异步建）
```

**d. 泛光链只在 `general.bloom` 生效时编译与建立**（`compile/bundle.ts:688`、`render/bloom.ts:128`）
```ts
  // 泛光链：每帧在全部对象画完之后跑，前提是允许泛光、场景 bloom 生效且对象列表非空（A1）
  if (postprocess.bloom && scene.objects.length > 0 && !settled())
    bundle.bloom = await compileBloom({ fs, shader, unsupported, addProgram }, postprocess.hdr);   // 现状：bloom 为 false 时 null
```
```ts
  const levels = bloomIterations(params.hdrIterations, Math.max(1, bloomLevels(width, height)));   // 现状：只建 N 级
```

**e. 清屏色、环境光、相机在建场景时定死**（`render/scene.ts:276`；`createDraw` 里的 `eye` / `ambient` / `skylight`）
```ts
    const [r = 0, g = 0, b = 0] = general.clearEnabled ? general.clearColor : [];
    this.clear = { r, g, b, a: 1 };                    // 现状：之后不变
    // createDraw：
        eye: bundle.general.camera.eye,                // 现状：g_EyePosition 写一次
        ambient: bundle.general.ambient,
        skylight: bundle.general.skylight,
```

**f. 仍重编译的类别**（`compile/bindings.ts:23`，3b 结束时的实际代码）
```ts
export type RecompileReason =
  | "effect-visible" // effect 可见性：未启用的不进 bundle（3c 改为单图层重算）     ← 本阶段改成单图层重算
  | "postprocess" // general.bloom / general.hdr：泛光链有无、目标格式              ← bloom 本阶段就地；hdr 见待定 2
  | "general" // clearcolor / ambientcolor / skylightcolor / camera.*              ← 本阶段就地
  | "layer-structure"; // colorBlendMode（passthrough 有无）、size（已定 5：重编译生效）   ← 待定 1 / 3a 已定 5
```

**g. 脚本环境：遮蔽表**（`script/environment.ts:2`、`:34`）
```ts
/** WPE 脚本环境中没有的浏览器全局；仅在场景子 frame 上遮蔽。 */
export const SCRIPT_HIDDEN_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "Worker", "SharedWorker", "localStorage", "sessionStorage", "indexedDB", "caches",
  "Intl", "WebAssembly", "parent", "self", "frames",
  "__TAURI_INTERNALS__", "window", "document", "top", "location",   // 现状：这 5 个不可配置，遮不掉，只记 debug
] as const;

export function alignScriptEnvironment(child: Window, consoleOutput: { … }, debug = () => {}): void {
  for (const name of SCRIPT_HIDDEN_GLOBALS) {
    // 现状：deleteProperty，删不掉就 defineProperty(value: undefined)，再不行记 debug
  }
  global.console = { log: consoleOutput.log, error: consoleOutput.error };   // 现状：console 改写成 WPE 的两项
}
```
  另有使用者：`dev/realmProbe.ts:66` 按遮蔽表逐个读 `typeof`；`script/realm.test.ts:53` 断言遮蔽表内容。

**h. 脚本 API 的作用域检查**（`script/api.ts:160`、`:213`）
```ts
  private method(object: ApiObject, name: string, fn: (...args: never[]) => unknown, scoped = false): void {
    this.define(object, name, () => (...args: never[]) => {
      if (scoped) this.requireCallback(name);   // 现状：scoped 的方法在模块求值期间调用就抛错
      return fn(...args);
    });
  }
  private requireCallback(name: string): void {
    if (this.evaluating) throw new Error(`${name} 不能在模块求值期间访问`);
  }
  // installEngine()：现状没有 registerAudioBuffers、AUDIO_RESOLUTION_*；也没有反向检查「只能在模块顶层调」
```

**i. dev 探针 `scriptCorpus` 的统计缺口**（`dev/scriptCorpus.ts`，3b 步骤 6 / 7 实施记录）
- `remainingTestFrames` 是 120 帧循环的倒计数，`finally` 里总清零，恒为 0。
- `missingApis` 只认有限的报错前缀：
  - 漏了经变量调用的报错；
  - 连带错误没有归到根因；
  - 把样本伪代码里的 `scene` 算成缺失 API。
- 没有每段的写回目标类型，也不统计写到重编译目标的次数。
- 宿主探针没有暴露 `runtimeSeconds` 与计时器列表。
- 设置变化引起的重载不计入 `stats().recompiled`。

**j. 音频订阅只认网页壁纸目录**（`src-tauri/kabegame/src/commands/wpe_web.rs:376`）
```rust
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let id = WpeWebDirIndex::global()
        .image_id_of(&doc)
        .ok_or("not inside a web wallpaper")?;   // 现状：宿主文档在宿主目录里，这里被拒
    if kind == WpeMediaKind::Audio && !supports_audio_processing(&id).await? {
        return Err("this wallpaper does not process audio".to_string());
    }
```
同文件 `wpe_web_pull_state`（`:330`）已有宿主分支：`wpe_scene_host::is_host_document(&doc)` 时要求传 `imageId`，并用 `index.is_scene(&id)` 校验。

**k. 暂停的现有链路**
```ts
// components/wallpaper/WallpaperStage.vue:536 —— 网页层：现状只隐藏，不冻结脚本
function applyWebPaused() {
  if (webLayerEl) webLayerEl.style.visibility = props.paused ? "hidden" : "";
}
// views/WallpaperWindow.vue:246 —— 现状不传 paused，桌面恒在播放
<WallpaperStage ref="stage" :target="state.target" … :volume="state.volume" :playback-rate="state.playbackRate" interactive />
```
```html
<!-- components/common/ImagePreviewDialog.vue:277 —— 现状固定播放，预览没有暂停入口 -->
<ImageContent ref="previewContentRef" :image="previewImage" prefer="original" video-playing interactive … />
```
```js
// webview_js/wpe_shim.js:316 —— 现状只转告页面
var paused = data.paused === true;
if (hostPaused !== paused) { hostPaused = paused; if (delivered) call("setPaused", paused); }
```
```ts
// apps/wpe-scene/src/render/renderer.ts:233 —— load 的首帧不受暂停影响（render(true)），暂停时加载新场景照常 ready；
// 但就地写属性只在下一帧生效，暂停时画面不更新
```

## WPE 的就地处理与我们的对应（I3 逐类）

| 绑定目标 | WPE 运行时效果（I3） | 我们（3a / 3b 之后） | 本阶段 |
| --- | --- | --- | --- |
| `origin` / `scale` / `angles` | 写字段，变换缓存作废 | 3a 就地 | — |
| 图像层 `color` / `alpha` / `brightness` | 绘制时读，下一帧可见 | 3a 就地 | — |
| 图像层 `size` | 只改字段，不重建几何，画面不变 | 3a 登记重编译 | 跟随 3a 已定 5 |
| 图层 `visible`（含 condition） | 逐帧检查 | 3a 就地 | — |
| 材质常量 / `usershadervalues` | 标脏、重传常量，不重编着色器 | 3a 就地 | — |
| **effect `visible`** | `FUN_1401e6300` 重算合成次数与 pass 数，变了才 `FUN_1402065e0` 重建该图层 | 3a 重编译 | **点 1–3：单图层重算** |
| COMBO 绑用户属性 | 不能绑，写成对象时整个进程断言中止 | 3a 报 `combo:user-binding` | 不变 |
| `usertextures` | 槽名变了就换该槽纹理（延后） | 报 `material:usertextures` | 不在本阶段（随用户纹理支持，W5） |
| `general.bloom` | 每帧读，下一帧开 / 关 | 3a 重编译 | **点 4：就地** |
| `general.hdr` | 运行中改不生效 | 3a 重编译 | 待定 2 |
| `bloomstrength` 等调节项 | 脏位，下一帧开头重算 | 3a 就地（级数变化退回重编译） | **点 5：级数也就地** |
| `clearcolor`；`clearenabled` 等标志 | 只改字段，逐帧读 | 3a 重编译（`clearenabled` 未登记） | **点 6：就地，`clearenabled` 一并登记** |
| `ambientcolor` / `skylightcolor` | 拷进渲染上下文，即时 | 3a 重编译 | **点 6：就地** |
| 相机 `fov` / `zoom` / `nearz`… | 只改字段，逐帧读 | 透视相机未实现（`camera:perspective`） | 随 P5 直接按就地实现 |
| 相机 `eye` / `center` / `up`（正交） | 同上 | 3a 重编译 | **点 6：就地**（正交下只影响 `g_EyePosition`） |
| `colorBlendMode` | 未在 I3 列出（推断属图层结构，走 +0x110） | 3a 重编译 | 待定 1 |
| `fog*` | 回调即时 | 未实现 | 随 P8 |
| 粒子 `instanceoverride` | 脏标志，下次更新重算 | 未实现（`object:instanceoverride`） | 随 P4 直接按就地实现 |
| 文本 `text` / `font` / `pointsize`… | 重排文字 | 未实现 | 随 P6 |
| 声音 `volume` | 即时设音量 | 未实现 | 随 P6 |
| `parallaxDepth` / `cameraparallax` | 只改字段 / 置位 | 未实现 | 随 P5 / W6 |
| 伪属性 `rate` / `alignment*` / `schemecolor` 清屏 / `wec_*` / `wcc_*` | 实例与渲染器字段；颜色校正编新变体 | 不实现（I7 第 11 条） | 不做 |

## 点 0 — 脚本环境改写、持久 `localStorage`、音频缓冲占位、探针修正（`script/environment.ts`、`script/api.ts`、`script/realm.ts`、`dev/`）

- **删除** `SCRIPT_HIDDEN_GLOBALS` 与遮蔽循环。
- **修改** `alignScriptEnvironment` 只做改写：
  > 说明：子 frame 自己的 `localStorage` 与宿主同一 `file:` 来源、同一份存储。存储一律经宿主传进来的 `Storage` 读写，子 frame 的全局名只用来挂 WPE 对象；`localStorage` 在 3b 步骤 0 已实测可删、可重定义。
```ts
/** 与 WPE 同名但语义不同的全局，改写成 WPE 的形状；其余浏览器全局照常保留（不是安全边界）。 */
export function alignScriptEnvironment(
  child: Window,
  consoleOutput: { log(text: string): void; error(text: string): void },
  localStorage: object,                      // 新增：ScriptApi 造好的 WPE localStorage 对象
): void {
  const global = child as unknown as Record<string, unknown>;
  global.console = { log: consoleOutput.log, error: consoleOutput.error };   // 不变
  Object.defineProperty(child, "localStorage", { value: localStorage, configurable: true, writable: false });   // 新增
}
```
- **新增** `script/storage.ts`：WPE `localStorage` 的存取。纯逻辑，接受一个 `Storage`，单测用内存实现。
```ts
export const LOCATION_GLOBAL = 0;          // 取值照 WPE 名字表；数值开工时用 WPE 文档或 REA 核对
export const LOCATION_SCREEN = 1;
/** 前缀：kabegame:wpe-scene:ls:<图片 id>:<g|s>: 。场景键见已定 7，位置见已定 8。 */
export class SceneScriptStorage {
  constructor(storage: Storage, sceneKey: string);
  get(key: string, location?: number): unknown;               // 没有的键返回 undefined；JSON.parse 失败返回 undefined、debug 日志
  set(key: string, value: unknown, location?: number): void;  // JSON.stringify；超配额抛错（同 Storage 的 QuotaExceededError）
  delete(key: string, location?: number): boolean;            // 官方文档返回 Boolean；取「键原本是否存在」，含义是推断
  clear(location?: number): void;                             // 只删本场景、本位置前缀下的键
}
```
- **修改** `ScriptApi` 造 WPE `localStorage` 对象，挂到 realm：
  - 成员只有 `get` / `set` / `delete` / `clear`，加上 `LOCATION_GLOBAL` / `LOCATION_SCREEN`。没有 `remove`：WPE 也没有（报告 A），样本调 `remove` 照样报 `TypeError`。
  - 四个方法都是 `scoped`：模块求值期间调用抛错，同 WPE（报告 D「顶层调用会报错」）。
  - `get` 返回的对象、数组用 realm 的 `JSON.parse` 造，这样脚本里的 `instanceof Array` 为真（3b 风险 2）。
- **修改** `ScriptApi.installEngine` 新增：
```ts
    this.engine.AUDIO_RESOLUTION_16 = 16;    // 新增：常量照 WPE（报告 A）
    this.engine.AUDIO_RESOLUTION_32 = 32;
    this.engine.AUDIO_RESOLUTION_64 = 64;
    // 新增：只能在模块顶层调（报告 D），回调里调用抛错；只收 16 / 32 / 64，其它值抛 TypeError
    this.method(this.engine, "registerAudioBuffers", (resolution: number) => {
      this.requireEvaluating("registerAudioBuffers");
      const buffers = this.audioBuffers(resolution);   // { left, right, average }：realm 的 Float32Array；同一分辨率返回同一个对象
      this.access.audioRegistered?.();                 // 新增：通知宿主订阅音频；语料与 realmCheck 不传，保持全零
      return buffers;
    });
```
  > 说明：`ScriptApi` 持有缓冲对象，脚本拿到的就是这几个数组，新数据原地写入，脚本不用改。
- **新增** `script/audio.ts`：把 Hub 的一帧合并进一组缓冲，纯函数。
```ts
/**
 * `frame`：Hub 一帧 128 个值（左声道 0–63、右声道 64–127，各自低频在前）。
 * 分辨率 n 的每一段取对应 64 / n 个原始段的最大值（`spectrum.rs` 的段内也取最大，含义是推断）；
 * `average[i] = (left[i] + right[i]) / 2`。长度不是 128 的帧忽略。
 */
export function fillAudioBuffers(
  frame: ArrayLike<number>,
  buffers: { left: Float32Array; right: Float32Array; average: Float32Array },
): void;
```
- **新增** `ScriptApi.applyAudioFrame(frame)`：把一帧写进全部已注册分辨率的缓冲。
- **修改** `commands/wpe_web.rs` 的 `wpe_web_media_subscribe`：加可选参数 `image_id`，认识场景宿主（见锚点 j）。放行条件不变。
```rust
    let index = WpeWebDirIndex::global();
    let id = match index.image_id_of(&doc) {
        Some(id) => id,
        None if wpe_scene_host::is_host_document(&doc) => {   // 新增：同 wpe_web_pull_state 的宿主分支
            let id = image_id.ok_or("the scene host must pass imageId")?;
            if !index.is_scene(&id) {
                return Err("not a scene wallpaper in the library".into());
            }
            id
        }
        None => return Err("not inside a web wallpaper".into()),
    };
```
- **修改** 宿主：`ScriptApi` 的 `audioRegistered` 触发订阅，只订一次；没有图片 id 时不订。
```ts
  private subscribeAudio(): void {
    const imageId = this.options.imageId;
    if (this.audioSubscribed || !imageId) return;
    this.audioSubscribed = true;
    const channel = new Channel<{ type: string; data?: number[] }>();
    channel.onmessage = (message) => {
      if (message.type === "audio" && message.data) this.scriptApi?.applyAudioFrame(message.data);
    };
    // 没声明 supportsaudioprocessing 或非 Windows 时被拒：缓冲保持全零，不报错（同 Phase 8 垫片），只记 debug
    invoke("wpe_web_media_subscribe", { kind: "audio", channel, imageId }).catch(/* report.debug */);
  }
```
  > 说明：订阅归属宿主 frame，frame 销毁时由 Phase 8 的 `SubframeDestroyed` 释放，没有退订命令；重编译保留 realm 与缓冲，也不用重订。退回预览图的场景不建 realm，不会开采集。
- **修改** 宿主建 realm 时把 `window.localStorage` 与场景键交给 `ScriptApi`：
  - 场景键取宿主已有的 `imageId`（地址参数 `kbScene`），见已定 7；为 null 时用内存 `Storage`；
  - 不改 Rust。
- **修改** dev 探针：
  - `scriptCorpus`：
    - `remainingTestFrames` 改成数 `iframe[data-kb-script-realm="1"]`（调用前后各一次）；
    - `missingApis` 改为按根因归类：把经变量调用的、读到 `undefined` 后的连带错误归到根因，样本伪代码里的 `scene` 单列为 sample；
    - 每段多报写回目标的类型，以及写到重编译目标的次数；
    - 用临时的存储前缀，跑完清掉，不碰真实场景存过的东西。
  - `host.clock()`：返回 `runtimeSeconds`、`frameSeconds` 与计时器列表（所属段、剩余时间、周期）。
  - `host.audio()`：返回是否已订阅、收到的帧数、已注册的分辨率，以及最近一帧的峰值。
  - `stats().recompiled` 计入设置变化引起的重载（原因记 `settings`）。
- **修改** `dev/realmProbe.ts` 与 `script/realm.test.ts`：
  - 删掉遮蔽表相关的检查；
  - 改成检查四项：
    - `console` 只有 `log` / `error`；
    - `localStorage` 是 WPE 形状；
    - 浏览器全局（如 `fetch`）保留；
    - 宿主自己的 `localStorage` 键脚本读不到。

## 点 0b — 当前壁纸控制：暂停与清空存储

> 面板在 `components/wallpaper/`，设置走 `kabegame-core/src/settings`，宿主在 `apps/wpe-scene`，垫片在 `webview_js/wpe_shim.js`。

**面板**
- **修改** `WpeWebPropertiesPanel.vue`：内容区最上面加一张控制卡片，样式同现有分组卡片。作者属性为空时也显示。
```ts
const props = defineProps<{
  imageId: string; imageType?: string | null; collapsible?: boolean; fillWhenExpanded?: boolean;
  /** 新增：壁纸正在实时运行时由父组件传入；undefined 表示没有实时实例，不显示暂停与清空存储 */
  paused?: boolean;
}>();
const emit = defineEmits<{ "update:paused": [value: boolean] }>();   // 新增
```
  - 「暂停」开关：`paused !== undefined` 时显示。
  - 「清空脚本存储」按钮：`paused !== undefined` 且是场景时显示。点击先 `ElMessageBox.confirm`，再调 `wpe_scene_clear_storage`，成功 toast。
  - i18n 加到 `packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/gallery.json`。
- **修改** `WpeWebPropertiesDialog.vue`：透传 `paused` 与 `update:paused`。

**预览**
- **修改** `ImagePreviewDialog.vue`：新增 `wallpaperPaused = ref(false)`，切图时复位。
```html
<ImageContent … :video-playing="!wallpaperPaused" interactive />                 <!-- 修改：只改 isPreviewWallpaper 那一处 -->
<WpeWebPropertiesPanel …
  :paused="isPreviewWallpaper ? wallpaperPaused : undefined"
  @update:paused="wallpaperPaused = $event" />                                    <!-- 新增 -->
```

**桌面**
- **新增** 设置 `wallpaperPaused: bool`，默认 false，持久化。照 `wpeMediaIntegration` 的全套写法：core `SettingKey`、读写方法、命令与 `generate_handler!`、`stores/settings.ts`、`settingsDescriptors.ts`（Web 为 readonly）。
- **修改** `Settings.vue`：用 `useSettingKeyState` 读写，传给对话框；不是窗口模式时传 undefined。
- **修改** `WallpaperWindow.vue`：`state.paused` 启动时读取，随 `setting-change` 更新。
```html
<WallpaperStage … :paused="state.paused && state.target !== null && isWpeLiveTarget(state.target)" interactive />
```
  > 说明：`isWpeLiveTarget` = `isWebTarget || isSceneTarget`（`targetKind.ts`）。普通图片、视频不受影响：它们没有面板，用户无法恢复。

**网页壁纸真暂停**
- **删除** `WallpaperStage.vue` 的 `applyWebPaused`（iframe 保持可见）；更新相关注释与 `WpeWallpaperContent.vue` 里「web 层只隐藏，不冻结脚本」。
- **修改** `wpe_shim.js`：`hostPaused` 变化时冻结 / 恢复。
```js
// 新增：在页面脚本之前包装。暂停期间 rAF 回调先存着（返回负数 id，cancelAnimationFrame 能取消），恢复时交还给原生 rAF
// 暂停：document.getAnimations() 里在播的 pause()、在播的 video / audio pause()，都记下；恢复时只恢复记下的
// 场景宿主不冻结（地址带 kbScene）：它有自己的 setPaused，渲染循环也要留给 load 用
```
  > 说明：`setTimeout` / `setInterval` 不冻结，靠它们驱动的页面暂停时还会动。Web Audio 沿用音量置 0，不 `suspend`（Phase 8）。

**场景**
- **新增** `SceneRenderer.redraw()`：暂停时补画一帧（`render(true)`）。
- **修改** 宿主 `applyChanges`：就地写之后，若 `this.paused` 就调 `redraw()`，否则暂停时改属性画面没反应。脚本不跑。

**清空存储**
- **新增** Rust 命令 `wpe_scene_clear_storage(image_id)`：校验 `WpeWebDirIndex::is_scene`，发事件 `wpe-scene-clear-storage { imageId }`。只给应用页用，注册进 `generate_handler!` 即可。
- **修改** `capabilities/wpe-web.json` 的 `allow-listen`：加这个事件。
- **新增** `script/storage.ts` 的 `clearSceneStorage(storage, sceneKey)`：删 `kabegame:wpe-scene:ls:<图片 id>:` 前缀（`g` 与 `s` 都删）。
- **修改** 宿主：`listen` 这个事件，`imageId` 相同时：
```ts
  private restartScriptsWithClearedStorage(): void {
    // 先停脚本再删：destroy 回调可能还会写；删完重建 realm，init 重跑
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
    this.scriptOverrides.clear();          // 字段名以实际代码为准：脚本写过的重编译目标一并放弃
    clearSceneStorage(backend, imageId);
    if (hadRuntime) void this.reload();    // ensureRuntime 重建；音频订阅保留，新 ScriptApi 的缓冲继续收到数据
  }
```
  > 说明：退回预览图的宿主没有 runtime，只删存储。没有任何宿主存活时事件没人收，这次清空不生效：面板只在有实时实例时显示按钮，预览与窗口模式下宿主都在，这种情况很少。

## 点 1 — 编译可变 effect（`compile/bundle.ts`、`compile/shader.ts`、`compile/bindings.ts`、`host.ts`、`script/api.ts`）

- **修改** effect 循环。绑定目标这一步**不改**，仍是 `recompile("effect-visible")`，改造放在点 3：
```ts
      const visibleBound = isUserBinding(instance.visible) || isScriptValue(instance.visible);   // 新增：用户绑定或脚本挂在它的 visible 上
      const enabled = bindings.bind(instance.visible, properties, recompile("effect-visible", …)) !== false;   // 目标不变
      if (!enabled && !visibleBound) continue;            // 修改：只丢「写死关闭、没有绑定」的
      const issues = new EffectIssues(enabled ? unsupported : null);   // 新增：本 effect 自己的不支持项，启用时同步写给场景级
      // …compileEffect：checkEffectFeatures 与材质、着色器、纹理的不支持项都记进 issues（compilePass 接受一个目标集合）
      layer.effects.push({ /* … */, source, enabled, visibleBound, unsupported: [...issues].sort() });   // 新增三个字段
```
  - 快速退回（`settled()`）照旧：场景已确定退回时不再编译后面的任何 effect，包括可变的。
  - 未启用的可变 effect 的 mip 照样解码（它随时可能打开）。
- **修改** 不支持项跟着缓存走。`ShaderCompiler` 只在第一次翻译时上报，`getTexture` 只在第一次解析时上报。不支持项分到 effect 之后，一个关着的 effect 先编译某个坏着色器，启用的 effect 再用同一份就命中缓存，场景级收不到，本该退回的场景会去渲染。所以缓存带着不支持项，命中时重新上报。翻译结果仍是同一个对象，`addProgram` 的去重不受影响。
- **修改** 区分「在 bundle 里」和「启用」。`host.ts` 的 `recompileValue` 与 `script/api.ts` 的 effect `visible` 读取都改看 `item.enabled`，否则脚本读到的 `visible` 永远是 true，写 `true` 也会被当成没变而不重编译。`isObjectValid` 不改：关着的可变 effect 算有效对象，更接近 WPE，它的对象本来就一直存在。
- **修改** 关着的 effect 出错。以前根本不解析它，它的 `effect.json` 坏了也没事；现在抛错要收进它自己的 `unsupported`（`effect:error:<file>`），进一个空 effect，不影响场景。启用的照旧抛。`effect:missing` 同理：启用时维持现状（不进 `layer.effects`），关着时进一个空 effect，打开时靠 `unsupported` 知道要整场重编译。

## 点 2 — 渲染图按开关重排（`render/graph.ts`）

- **修改** `planLayer` 只看启用的 effect；effect 下标仍是 `layer.effects` 里的位置（fbo 引用按它找），跳过的不占「最后一个」：
```ts
export function planLayer(layer: SceneLayer, textures: readonly TextureSize[],
  enabled: (effect: number) => boolean = (e) => layer.effects[e].enabled,   // 新增：运行时的开关
): LayerPlan {
  // needsComposite / finalEffect / 合成 RT 计数都只数 enabled 的 effect
}
/** 新增：渲染图的签名（步骤序列、角色、目标、合成 RT 张数），用来判断开关后要不要重建（同 WPE「数值变了才重建」）。 */
export function planSignature(plan: LayerPlan): string;
```
- 单测（`graph.test.ts`）：两个 effect 的图层，关掉后一个时前一个的最后一个绘制 pass 变成上屏、合成 RT 由 2 张变 1 张；全关时基础 pass 改成直接上屏；passthrough 图层开关 effect 时上屏仍是 passthrough；关掉的 effect 里的 fbo 引用不进步骤。

## 点 3 — 单图层同步切换（`render/graph.ts`、`render/scene.ts`、`render/state.ts`、`render/renderer.ts`、`compile/bindings.ts`、`compile/bundle.ts`、`compile/scripts.ts`、`script/api.ts`、`script/runtime.ts`、`host.ts`）

- **修改** 绑定目标：effect `visible` 从 `recompile("effect-visible")` 改成就地类目标，`RecompileReason` 删掉 `effect-visible`。放在这一步而不是点 1：`SceneState` 要到这里才会处理 effect 目标，提前改的话改属性没有反应，脚本也写不进去。
```ts
  | { kind: "effect"; object: number; effect: number /* effects[] 下标（JSON 坐标）*/ }   // 新增
```
- **修改** 脚本侧：
  - `scripts.ts` 的 `targetOf` 把 effect `visible` 改为同一个就地目标；
  - `ScriptApi` 里 effect 对象的 `visible` 写入走这个目标，读取改读 `state().effectEnabled(...)`；
  - `targetPath` 与 `targetKey` 加 effect 分支，路径同旧的 `objects/<i>/effects/<j>/visible`，`forgetWrite` 与 `replayWrites` 不变；
  - `host.ts` 的 `writeScript` 只在 `state.write` 返回 `"recompile"` 时写 `scriptOverrides`。

  `scriptOverrides` 只剩 general 字段、图层结构类目标、「打开带不支持项的 effect」与「切换冻结的图层」在用（见待定 1、2）。
- **修改** `SceneState`：effect 开关进状态。
```ts
  effectEnabled(object: number, effect: number): boolean;            // 按 scene.json 坐标
  needsRecompile(binding: SceneBinding, raw: SceneScalar): boolean;  // 不改状态：打开带不支持项的 effect、切换冻结的图层，或重编译类目标
  // write 的 effect 分支：值没变 "applied"；needsRecompile 为真时 "recompile"；否则改开关，记进结构脏集合
  // takeDirty 加 structures: Set<number>
```
- **修改** `populate` 里按图层的部分拆开，局部变量升到实例字段，加载与重建共用：
```ts
  private ensureProgram(index: number): Promise<GpuProgram>;     // 用到才建，失败抛错
  private ensureSnapshot(): void;
  private ensureComposites(runtime: LayerRuntime, plan: LayerPlan): void;   // 不够就从共享池补
  /** 等齐程序与管线（异步）；之后 buildLayer 是同步的 */
  private prepareLayer(plan: LayerPlan, resources: LayerResources): Promise<Map<DrawStep, PreparedDraw>>;
  /** 照计划生成 op 与 draw（开头调 checkPlanOps） */
  private buildLayer(runtime, plan, prepared, state): { ops: Op[]; draws: Draw[] };
```
  fbo 尺寸一律取 `compositeSize(layer, baseTexture)`，修掉步骤 1 留下的 `[4, 4]`。
- **新增** 加载时预建与同步切换：
```ts
  /** graph.ts：图层运行时可能用到的计划，n 个可变 effect 共 n + 2 份；没有可变 effect 时为空。带不支持项的不算可变 */
  export function variantPlans(layer: SceneLayer, textures: readonly TextureSize[]): LayerPlan[];
  /** 关着的 effect 也在加载时备好。逐图层进行，失败不影响当前画面，这一层之后走整场重编译 */
  private async prepareVariants(state: SceneState): Promise<void>;
  /** 从就绪表同步取，缺了抛 render:variant-missing */
  private preparedOf(plan: LayerPlan, resources: LayerResources): Map<DrawStep, PreparedDraw>;
  /** 切换当场做完：比较签名，变了就建 draw 并换上 */
  private rebuildLayer(runtime: LayerRuntime, state: SceneState): void;
  /** 清本图层全部 effect 带 clear 的 fbo，含没切的和关着的，实体按 FboBindings.initial 取 */
  private clearLayerFbos(encoder: GPUCommandEncoder, runtime: LayerRuntime): boolean;
```
  - 计划按 `(e) => state.effectEnabled(object, layer.effects[e].source)` 排：绑定目标与状态用 JSON 坐标，`planLayer` 的回调给 `layer.effects` 下标；
  - 换上时旧 draw 从索引摘掉，缓冲销毁并移出 `owned`（改成 `Set`）。已提交的帧不受影响；
  - `ensureProgram` / `pipelineFor` 完成时写进 `readyPrograms` / `readyPipelines`，切换时同步取。管线键由 `stepPipeline` + `pipelineKey` 算，`prepareLayer`、`preparedOf` 与单测共用；
  - `checkPlanOps`：`buildLayer` 里 swap、copy 的检查抽出来，`prepareVariants` 对每份计划先过一遍；
  - `GpuScene.build` 在 `populate` 的错误作用域弹出之后调 `prepareVariants`；每个可变图层一个 validation 作用域，失败调 `state.freezeLayer(object)` 并记进 `warnings`；
  - `SceneState` 新增 `frozenLayers` 与 `freezeLayer`；`needsRecompile` 对冻结图层的开关为真，开和关都算，同值写不算。
- **修改** `sync`：结构先处理，新 draw 按当前状态写 uniform，后面的刷新也落在新 draw 上。结构脏的图层 rebuild 之后清 fbo，签名没变也清（同一帧内关了又开）。
- **修改** `applyBindings`：写之前 `needsRecompile` 为真就一条都不写，返回 false。
- **修改** 渲染器 `render`：`scene.sync` 外包 `try/catch`，抛错走 `fail`。否则脏项已取走、下一帧已排好，这次切换丢失且没有任何报告。暂停时的补画沿用宿主 `applyChanges` 末尾的 `redraw`。
- **修改** 宿主：
  - 打开一个 `unsupported` 非空的 effect，或切换冻结的图层：`applyChanges` 的重编译原因写 `effect-blocked（路径）`，debug 日志带上不支持项，结果由整场编译决定（带不支持项的照常退回预览图）；
  - 脚本写同样的目标：`state.write` 返回 `"recompile"`，走 `overrideAndReload`，值没变不重复请求。

## 点 4 — 泛光开关就地（`compile/bundle.ts`、`compile/postprocess.ts`、`render/scene.ts`）

- **修改** 编译：`general.bloom` 可变（有用户绑定或脚本）时，只要档位不是关闭、场景有对象，就编泛光链；`bundle.bloom` 多一个 `enabled`（当前生效值）。HDR 判定不变（加载时的生效值，P2b）。
```ts
  const bloomVariable = isUserBinding(general.bloom) || scripts.ownsGeneral("bloom");     // 新增
  if ((postprocess.bloom || (bloomVariable && postprocess.level !== "disabled")) && scene.objects.length > 0 && !settled())
    bundle.bloom = { ...(await compileBloom(/* … */, postprocess.hdr)), enabled: postprocess.bloom };   // 修改
```
- **修改** 渲染：快照纹理在有泛光链时就建；`encode` 里泛光那一步看 `state.bloomEnabled`，关着时整步跳过（不拷快照、不跑链），画面与没有泛光链时逐字节相同。
- 绑定目标 `general.bloom` 改成 `{ kind: "bloom-enabled" }`；`general.hdr` 见待定 2。

## 点 5 — 泛光级数就地（`render/bloom.ts`）

- **修改** `bloomhdriterations` 可变时按可用级数（`bloomLevels(width, height)`，最多 8）建满金字塔与各级 draw，`encode` 只跑前 N 级的下采样与对应的上采样；这时 `sameLevels` 恒为 true（3a 的退回重编译不再发生），`setParams` 同时改「用几级」。
  > 说明：WPE 在 resize 时预建全部可用级、每帧用 N 级（P2b「与规格的差异」第三条）。不可变时照旧只建 N 级，省显存。
- 单测（`bloom.test.ts`）：预建 8 级、用 5 级时的步骤序列与常量，和直接按 5 级规划的逐项相同。

## 点 6 — 清屏色、环境光、相机就地（`compile/bindings.ts`、`render/state.ts`、`render/scene.ts`）

- **修改** 目标：`clearcolor` → `{ kind: "general"; field: "clearColor" }`、`clearenabled` 新登记为 `{ kind: "general"; field: "clearEnabled" }`、`ambientcolor` / `skylightcolor` → `ambient` / `skylight`、`camera.eye` → `eye`；`camera.center` / `camera.up` 在正交相机里不影响任何 uniform（`layout.ts`：正交投影里 eye 被抵消，视图投影只看场景尺寸），登记为无操作。
- **修改** `GpuScene.sync`：`clearColor` / `clearEnabled` 改 `this.clear`；`ambient` / `skylight` / `eye` 改所有含 `g_LightAmbientColor` / `g_LightSkylightColor` / `g_EyePosition` 且未被材质值覆盖的 draw。
- 透视相机（P5）落地时，`fov` / `zoom` / `nearz` / `farz` 直接按这一类就地实现。

## 点 7 — 宿主收尾（`host.ts`、`compile/bindings.ts`）

- **修改** `RecompileReason` 收窄为：`"layer-structure"`（`colorBlendMode`，待定 1；`size`，3a 已定 5）、`"postprocess-hdr"`（待定 2）、`"effect-unsupported"`（打开带不支持项的 effect）。
- **修改** 宿主日志：
  - 单图层重建记 `debug`：图层、effect、签名是否变化、用时。
  - 重编译仍记 `debug` 并带原因（3a 已定 8；已定 9）。
- **修改** dev 探针 `stats()` 增加单图层重建次数与用时（均值 / 最大）。

## 点 8 — 文档、回归与 changelog

- `cocs/wpe/WPE_SCENE.md`：
  - 「场景脚本（P3b）」：
    - 环境表改成「改写」形态（`console`、`localStorage`；其余浏览器全局保留）；
    - 补持久 `localStorage`：前缀、位置、配额与网页壁纸共用；
    - 补 `registerAudioBuffers` 占位；
    - 「未提供」清单删掉这两项；
    - 探针一段同步点 0。
  - 「图层渲染图」补运行时开关与单图层同步切换、可变 effect 的编译规则与不支持项归属；「泛光与 HDR」补开关就地与级数预建、HDR 只在加载时判定；「场景宿主」的就地 / 重编译分类表改成最终形态（并附上本文件的对照表）；`cocs/README.md` 摘要同步。
- `versions/latest/regression.md` 新增「场景壁纸 P3c：运行时渲染图」小节，用例见验收。
- `versions/latest/changelog.md` 用户侧 Optimized 一行：「场景壁纸开关图层效果、泛光，以及改背景色等属性时也即时生效，不再重新加载」。
  另在 3b 那条 Added 后补半句：「场景脚本的存储（如记住的拖动位置）会保留到下次打开」。

## 实施步骤

每步都能单独验收；codex 只改仓库内文件，独立验收时先 `git status` 查越界，不采信自报。

**步骤 0 — 测试工程**（Claude）：本机默认样本里能实时渲染的场景都没有 effect visible、`general.bloom` 的用户绑定。把 I10 的测试工程 `kbprops-test`（已存到 `ignore/p3-userprops/dyn-test/kbprops-test`：四个纯色图层、tint effect 的可见性与常量、条件可见、位置 / 尺寸、脚本属性、只有 init 的脚本、泛光）拷到 `ignore/p3c/kbprops-test/`（gitignore，不进仓库），必要时补一个 `clearcolor` / `ambientcolor` 绑定与第二个 effect；在 Kabegame 里「添加壁纸目录」导入。WPE 一侧对它的现象见报告 I10（4b：关掉 effect 后 B 由绿变白、打开恢复）。

**步骤 0.5 — 脚本环境与 API**（点 0；与后面各步无依赖，先做。环境、存储、探针已由 codex 完成，真实音频交子代理，codex 暂不可用）
- 验收：
  - 单测（验收「单测」第 5–7 条）；`test-kabegame` 跑 `kabegame wpe_`，`check-kabegame` 0 error；
  - CDP 复跑 `realmCheck()`；
  - `scriptCorpus` 重跑全语料，与 3b 步骤 6 逐段对比：
    - `registerAudioBuffers` 引起的 124 段求值失败应消失；
    - `localStorage` 的 10 段 `init` 报错应消失。调 `remove` 的段改报 `remove` 不存在，这是样本自身的错，WPE 同样报。
    - 新出现的报错逐条解释。
  - `unsupported` 与 3b 逐张相同。

**步骤 0.6 — 当前壁纸控制**（子代理：点 0b；在真实音频完成并通过审查之后做，两者都改 `host.ts`）
- 验收：单测（验收「单测」第 8 条）；`check-kabegame` 与宿主 `typecheck` 0 error；`deno task test -c kabegame --skip cargo` 全过；真机见验收「真机」的「暂停」「清空存储」。

**步骤 1 — 编译与渲染图，不改绑定目标**（子代理：点 1、点 2）
- 运行时行为不变：改 effect 可见性仍走整场重编译，`scriptOverrides` 继续保证重编译时 `enabled` 正确。
- 验收：单测（点 2 列出的几例，以及「不可变的关闭 effect 照旧不进 bundle」「可变 effect 的不支持项不进场景级」、缓存命中重新上报、关着的 effect 出错）；语料测试的 `unsupported` 与 3b 结束时逐张相同（本机没有不可变 → 可变的变化会让结论改变的场景；如有，逐张解释）。

**步骤 2 — 单图层重建**（子代理：点 3，含绑定目标与脚本侧改成就地）
- 验收：单测——对测试工程的 bundle，「关掉 effect → 重建」得到的步骤与 uniform 字节，和「用 effect 关着的属性值整场编译」逐字节相同；再打开回到原样。没有可变 effect 的场景，`GpuScene` 建出的资源数与 3b 相同、基线哈希不变。

**步骤 3 — 泛光开关与级数**（codex：点 4、点 5）
- 验收：单测（点 5）；关着泛光时测试工程的哈希与没有泛光链时相同；bedroom（超高档）哈希与 P2b 基准相同（它的 `bloom` 不可变，走原路径）。

**步骤 4 — 清屏色、环境光、相机与宿主收尾**（codex：点 6、点 7）
- 验收：单测（就地 = 重编译的字节对比，覆盖 `clearcolor`、`ambientcolor`、`eye`）；`deno task test -c kabegame --skip cargo`、`check-kabegame`、宿主 `typecheck` 全过。

**步骤 5 — 真机验收**（Claude 经 CDP；Kabegame「场景后处理」临时改成「开启」看泛光，测完改回「跟随 WPE」；不改用户的壁纸设置）：见验收「真机」。

**步骤 6 — 文档**（codex：点 8；Claude 填实测数值并核对文档与代码一致）。

## 验收

**单测**
1. 渲染图：点 2 的四例；`planSignature` 在步骤或合成 RT 数变化时变化、只改开关但计划相同（例如关掉一个没有绘制 pass 的 effect）时不变。
2. 编译：可变 effect 进 bundle 并带 `enabled`、自己的 `unsupported`；关着的可变 effect 的不支持项不让场景退回；打开它时 `SceneState.write` 返回 `"recompile"`。
3. **就地 = 重编译（字节级）**：effect 开 / 关、泛光开 / 关（LDR）、`bloomhdriterations` 8 → 5 → 8（HDR）、`clearcolor`、`ambientcolor`、`eye`，就地结果与整场编译的 uniform 字节与步骤序列逐项相同。
4. 不回归：没有可变项的场景（本机能渲染的全部默认样本）在 3c 前后资源数与哈希相同。
5. **`localStorage` 存取**（`storage.test.ts`，内存 `Storage`）：
   - `set` / `get` 往返数字、字符串、布尔、对象、数组；没有的键返回 `undefined`；
   - 两个场景键、两个位置互不可见，`clear` 只删自己的前缀；
   - 前缀外的键（模拟宿主的 dev 开关）读不到、删不掉；
   - 坏 JSON 返回 `undefined`；
   - 模块求值期间调用抛错，`init` 里不抛；
   - 没有 `remove`。
6. **音频缓冲**：
   - 模块求值期间 `registerAudioBuffers(engine.AUDIO_RESOLUTION_32)` 返回 `left` / `right` / `average` 三个长度 32、初始全零的 realm `Float32Array`；
   - 同一分辨率两次调用返回同一个对象；
   - 在 `init` 里调用、或参数不是 16 / 32 / 64 时抛错；
   - `fillAudioBuffers`：64 / 32 / 16 三种分辨率的合并结果，左右声道不串，`average` 正确，长度不是 128 的帧不写入；
   - `applyAudioFrame` 写进脚本持有的同一个数组，所有已注册分辨率都更新；
   - 宿主（`host.test.ts`）：第一次注册才订阅，参数带 `kind` / `imageId`，再注册不重复订阅；Channel 的 `audio` 消息写进缓冲，其它类型的消息忽略；订阅被拒时不报错、缓冲保持全零；没有图片 id 时不订阅。
7. **环境**：
   - realm 里 `console` 只有 `log` / `error`；
   - `localStorage` 是 WPE 对象；
   - `typeof fetch === "function"`（不再遮蔽）；
   - 不再有遮蔽表。
8. **当前壁纸控制**：
   - 面板：`paused` 为 undefined 时不显示控制项；网页壁纸不显示清空按钮；开关发 `update:paused`；取消确认时不调命令；
   - `WallpaperWindow` 的判定：网页、场景受 `wallpaperPaused` 影响，普通图片与视频不受；
   - `clearSceneStorage`：`g` 与 `s` 都删，别的场景与前缀外的键不动；
   - 宿主：同 id 的事件才处理；顺序是先 `destroy` 再删存储；有 runtime 时重建并重跑 `init`，退回状态只删存储；暂停时就地写属性会补画一帧，不暂停时不补画；
   - 垫片：暂停期间 rAF 不回调、恢复后回调；暂停时取消 rAF 有效；恢复只恢复暂停前在播的媒体与动画；带 `kbScene` 时不冻结。

**真机**（Windows dev，主窗口预览；壁纸窗口为窗口模式时一并验，不是就记未测）
- **`localStorage` 持久与隔离**（点 0）：在测试工程里加一段脚本，`init` 里读一个计数键、加 1 后写回，`update` 把计数写进某个图层的 `alpha` 或颜色，用来目视。
  - 关预览再开：计数接着涨；
  - 预览与壁纸窗口（窗口模式时）读到同一份；
  - 宿主 `localStorage` 里只多出带 `kabegame:wpe-scene:ls:` 前缀的键；
  - dev 强制渲染开关等其它键不受影响；
  - 测完清掉测试前缀下的键。
- **真实音频**（点 0）：
  - 本机用脚本音频的场景都还退回预览图，所以在测试工程里加一段脚本：模块顶层 `registerAudioBuffers(16)`，`update` 把 `average[0]` 写进某个图层的 `alpha`。工程声明 `supportsaudioprocessing: true`。
  - 系统放音乐时图层随低频变化，探针 `host.audio()` 的帧数约 30 次/秒、峰值大于 0；停止后回落到 0。
  - 预览、应用背景与壁纸窗口（窗口模式时）各订一份，互不影响；关预览后 Hub 的订阅数下降，没有订阅时采集停止（日志或 Phase 8 的既有手段确认）。
  - 把声明改成 `false` 的副本：订阅被拒、缓冲保持全零、没有报错。
- **暂停**（点 0b）：
  - 预览：场景与网页壁纸各切一次，画面停在最后一帧、不消失，恢复后接着动；切到下一张时恢复播放；桌面不受影响。
  - 桌面（窗口模式）：设置页切换，场景与网页壁纸同上；重启应用后仍是暂停；暂停时切到另一张场景能显示首帧、切到普通视频照常播放。
  - 暂停时改颜色，场景画面立即更新、时钟不动。
  - 暂停期间 ping 看门狗不误判。
- **清空存储**（点 0b）：测试工程的计数脚本涨到几次后点清空，确认后计数回到 1，`init` 重跑一次；别的场景的键、dev 开关不受影响；预览与壁纸窗口同时开着同一张时都重启。
- **测试工程 effect 开关**：属性面板切 `p_effvis`，B 层由绿变白、再变回绿（同 WPE I10 4b）；应用日志没有「重新编译」，探针 `stats()` 的单图层重建次数增加；关 / 开之后 `host.renderFrame(t)` 的哈希分别等于用同一属性值整场编译的 `renderFrame(t)` 哈希。
- **逐帧开关**：CDP 在宿主 frame 里以 rAF 频率交替推 `p_effvis` 10 s，记录单图层重建的均值 / 最大用时、`stats().frameMs` 的均值与 p95、宿主 rAF 与 `GPUQueue.submit` 次数（预期与不切换时相同），无重编译、无 WebGPU 校验错误。测完推回原值。
- **泛光开关**（「场景后处理」= 开启）：切 `p_bloom`，泛光随之出现 / 消失、不重编译；`p_bloomstr` 改强度即时生效。测完设置改回「跟随 WPE」。
- **清屏色 / 环境光**：测试工程补的 `clearcolor` 绑定改值后背景即时变色、不重编译。
- **脚本写 effect visible**（如本机有可渲染的样本；没有就在测试工程里加一段 `update` 按时间切 effect 可见性的脚本）：切换按脚本节奏发生，无重编译。
- 不回归：vortex、bedroom（三档）、P1 三张画面与 3b 相同；显存（日志的渲染目标估算）记进回归表，说明可变 effect 多出的部分。

## 风险

1. **可变 effect 的显存与加载时间**：可变 effect 的 fbo、合成 RT 与快照都在加载时建，之后不还；程序与管线也在加载时建，可变图层的加载因此变长（管线按键去重）。`bloomhdriterations` 可变时建满 8 级金字塔（4K HDR 约 21 MiB，P2b）。只有带绑定的场景才多，记进回归表。
2. **重建与在途帧**：切换在 `render` 里、编码这一帧之前同步完成，旧 draw 的缓冲换下时销毁。WebGPU 允许销毁已提交的帧用过的缓冲，那一帧不受影响。
3. **切换开销**：切换不编译，但要建 draw 的缓冲与 bind group，有 `clear` 时再提交一次清屏，都在帧内同步做。脚本逐帧切换时每帧都有这份开销。WPE 的同类开销是 0.7 ms（J1，纯色层）；我们的数字等验收。预建失败的图层切换走整场重编译，这时会有明显延迟。
4. **WPE 语义的推断部分**：`FUN_1402065e0` 只在「数值变了」才重建；我们按计划签名判定，覆盖范围略大（结果相同）。`colorBlendMode` 的运行时行为 I3 没有列出（待定 1）。
5. **样本不足**：本机能实时渲染的场景都没有这几类绑定，主要靠测试工程与单测；工坊里有 effect visible 绑定的场景（如 2932157836 的 `wink`）要等它们的其它阻塞解除后才能真机看到。
6. **存储配额共用**：脚本存储与宿主、所有网页壁纸同在 `file:` 来源的一份 `localStorage` 里，Chromium 每来源约 5 MiB。写得多的脚本可能挤占网页壁纸的空间，超了 `set` 抛错，只禁用那个回调。本机样本存的都是几个小值。
7. **不再遮蔽的代价**：在 WPE 里会报错的脚本在我们这里可能能跑。比如用了全局 `setTimeout` 的脚本，计时器按墙钟走、暂停时不停；用了 `fetch` 的可以读宿主 `file:` 范围内的文件。这类行为与 WPE 不同，只出现在 WPE 下本来就坏掉的脚本里。安全性不变：3b 已定 4 本来就写明不是安全边界。
8. **音频数值只是近似**：频谱算法是 Phase 8 自定的（WPE 没有公开），64 段到 32 / 16 段的合并方式也是推断。脚本的阈值按 WPE 的数值调出来，观感可能和 WPE 有差别。本机能实时渲染的场景都不用音频，要到它们的渲染阻塞解除后才能和 WPE 对照。全零时某些脚本的除法可能写出 `NaN`，与 WPE 静音时的行为一致与否未核实。
9. **反馈型 fbo 的旧内容**（已查清，J6）：effect 关掉再打开时，fbo 内容与 swap 状态保留，带 `clear` 的除外（每次重建都清，且是同图层全部 effect 的 fbo）。我们照此实现，与 WPE 一致。整场重编译是清空的，所以这一点上「就地 = 重编译」本来就不成立，单测只比步骤序列、uniform 字节与编码轨迹。

## 已定（2026-11-03 用户）

1. 属性快速路径的第二步：做到 WPE 的程度（报告 I3 / I7），effect 可见性只重算该图层渲染图（合成次数、合成 RT、passthrough，对应 `FUN_1401e6300`），其余能就地改的都不重编译。
2. 重编译时保留脚本 realm 与脚本状态（3b 起），不重跑 `init`。
3. 默认照 WPE（报告 D / I 节）；COMBO 绑用户属性按不支持；快速路径要扛得住逐帧调用。
4. **脚本环境不再遮蔽，改写**（2026-11-05 用户）：
   - 22 个全局的遮蔽表去掉，因为太多；
   - 只把与 WPE 同名、语义不同的改写成 WPE 的形状（`console`、`localStorage`）。

   改掉 3b 已定 4 的「遮掉 WPE 没有的东西」。
5. **WPE `localStorage` 直接做持久化**（2026-11-05 用户）：存进浏览器 `localStorage`，加前缀隔离。
6. **API 阶段**（2026-11-05 用户同意 3b 步骤 6 的建议）：
   - 3c 先补 `registerAudioBuffers` 与 `localStorage`，并修探针；`registerAudioBuffers` 直接接 Phase 8 的真实音频，不做全零占位（2026-11-05 用户）；
   - 层级、输入、纹理动画 / 视频、声音 / 文本随各自的渲染阶段做。
7. **`localStorage` 的场景键用图片 id**（2026-11-05 用户），即宿主地址里的 `kbScene`。
   - 删掉再导入、图片 id 变了以后，存储不再对应。
   - 没有图片 id 的宿主（`imageId` 为 null）不读写持久存储，改用只存在内存里的一份。
8. **`LOCATION_SCREEN` 的「屏幕」**（按推荐，用户未提异议）：
   - 先全部记作同一块屏（前缀 `s`），预览、应用背景与桌面共用；
   - `LOCATION_GLOBAL` 用前缀 `g`，两者互不可见；
   - 多显示器壁纸落地时再按显示器分。
9. **重编译日志保持 `debug`**（2026-11-05 用户）：只进宿主 DevTools 控制台，不进应用日志。验收靠探针的 `stats().recompiled`；点 0 起它也计入设置引起的重载。
10. **暂停与清空存储单独放进当前壁纸属性面板**（2026-11-05 用户）：设置页与预览详情共用；不和「全部重置」绑在一起。不做 100 KB 上限。
11. **对齐 WPE 行为，加载时备好、切换同步**（2026-11-06 用户，撤销「允许卡帧」）：依据 [p3-script-REPORT.md](p3-script-REPORT.md) J 节。

## 待定（附推荐）

1. **`colorBlendMode` 绑了用户属性**：I3 没有列出它的改值回调；值在 {0, 31} 与其它值之间切换会改变 passthrough 有无，passthrough 材质的 COMBO 又随值变（`BLENDMODE = cbm`），要按值翻译着色器。本机 binding-scan 0 处。**推荐保持重编译**，有样本再议。
2. **`general.hdr` 绑了用户属性**：WPE 运行中改了不生效，要重载（I3，HDR 渲染位与交换链格式只在加载时判定）。选项：(a) 照 WPE，运行时忽略，下次加载（含任何一次重编译）才用新值；(b) 重编译。**推荐 (a)**，与已定「默认照 WPE」一致；代价是用户在面板里改了看不到变化，直到下一次加载。本机 `hdr` 写成属性对象的样本 0 个（P2b），`bloom` 写成属性对象的 3 个。
3. **可变图层的判定范围**：只看绑定表与脚本表（本文件的做法），还是像 WPE 一样所有 effect 都编进 bundle。**推荐只看绑定**：没有绑定的场景零变化、零额外显存；脚本目前没有 `getEffect`（3b API 不含），不会在运行时打开未登记的 effect。等 `thisLayer.getEffect` 进入 API 阶段时，再把「有脚本的场景全部 effect 可变」加进判定。

## 后续

- 后续各 Phase 新增的可绑定属性按本文件对照表直接实现就地处理：粒子 `instanceoverride`（P4）、透视相机参数（P5）、文本重排与声音音量（P6）、用户纹理换槽（W5）、雾（P8）。
- `thisLayer.getEffect(…)` 进入脚本 API 时（见 3b「后续」），effect 可变性的判定扩到「有脚本的场景全部 effect」（待定 3）。
- **`g_AudioSpectrum*` uniform**：随 W2 做，数据直接用点 0 宿主收到的同一帧。本机报这项的场景都另有 25 项以上阻塞，现在做解锁不了什么。
- **网页壁纸暂停的计时器**：垫片只冻结 rAF、CSS 动画与媒体元素，靠 `setTimeout` / `setInterval` 驱动的页面还会动。遇到实际样本再看要不要包装计时器。
- **建好 realm 后才退回的场景**：渲染失败时 realm 与音频订阅都保留，frame 不销毁，Hub 会继续采集到 iframe 消失。没有退订命令，影响小，先不处理。
- **`model:solidlayer`**：本机 41 个场景里 17 个报这项，影响图层几何与尺寸（`p2-REPORT`），测试工程 `kbprops-test` 也是靠本地覆盖 `models/util/solidlayer.json` 才绕开（见「步骤 0.6 真机」）。放在 3c 之后单独做。

## 实施记录

### 步骤 0.5（2026-11-05）

**实现。** 环境、`localStorage`、探针由 codex 完成，主会话审查后改了三处：`delete` 按文档返回 `Boolean`；`localStorage.remove` 与 `console.*` 归为样本自身的错；注释写明 `location` 的实际类型未核实。真实音频由子代理完成。

**与计划不一致的地方。**
- WPE `localStorage` 由 `createWpeLocalStorage` 造，不在 `ScriptApi` 里：它要早于 `baseclasses.js` 挂上，那时 `ScriptApi` 还不存在。
- `remainingTestFrames` 改成 `{ before, after }`，`missingApis` 改成条目数组。
- 连带错误按属性名列出（`consequential:scale` 等），没有归到根因，要归根因得分析源码。
- 音频缓冲存 `{ api, arrays }` 两份：脚本能改写 `buffer.left`，写入只认 `arrays`。
- `recompileWrites` 统计写入尝试次数，同值重复写也算，不等于实际重编译次数。

**CDP（dev 宿主，端口 58100）。**
- `realmCheck()`（bedroom）：`console` 只有 `error` / `log`；`localStorage` 成员只有 4 个方法加 2 个常量，没有 `remove`；`fetch` 是函数；宿主的键读不到；模块顶层调 `localStorage` 抛错；`console.warn` 抛 `TypeError`；语法错误 `(line 1, col 18)`；测后只剩宿主自己的 frame。
- 全语料 41 张、695 段（比 3b 多 3 张 57 段，都是新订阅的工坊场景）。开跑前按上次的办法扫了全部循环，条件看不出有界的仍只有 13108 那处 `while`；它在 `getChildren` 缺失时走不到，走到时每轮重新取随机数。
  - 求值失败 127 → 3：`registerAudioBuffers` 124 段、`localStorage` 10 段的报错全部消失。剩下 `engine.registerAsset` 1 段，以及样本伪代码 `scene` 2 段。
  - 原有 38 张的 `unsupported` 逐张相同；能完整渲染的仍是 beach、deep_space、eagleflag、razer_vortex、razer_bedroom。
  - 新出现 9 条报错，都在旧场景里：这些段以前卡在模块顶层，现在才往下走到。`getTransformMatrix` 4 段、`getEffect` 2 段、`input` 1 段、`createLayer` 1 段，其余 1 条是 `createLayer` 的连带错误（`alignment`）。
  - 计划原先写「2 段连带错误随之消失」，**这是错的**：写这些 `shared` 值的段现在卡在 `getTransformMatrix`（`12902` 的 `shared.miTextContainerScale` 就在那一行之后），`multiply` 那两条要等这个 API。
  - 13 段挂在重编译目标上，120 帧内写入次数都是 0：它们只导出 `mediaThumbnailChanged` 或 `applyUserProperties`，前者本阶段不调用。
  - 每张 frame 前后都是 1，`kabegame:wpe-scene:ls:` 前缀下没有残留的键。
- 音频冒烟（dev 强制渲染，预览 13110）：订阅成功，帧数 91 → 181（3 s 内 90 帧，30 帧/秒），已注册分辨率 `[64]`，峰值 0（当时机器没有声音）。对照 12889 不注册、不订阅。子 frame 的 `Channel` 与 Rust 宿主分支都实际走通。

**测试工程注意。** `supportsaudioprocessing` 有两个来源，含义相反：Rust 放行读 `project.json` 的 `general`；`features.ts:211` 读 `scene.json` 的 `general`，写了 true 就报 `general:supportsaudioprocessing`、整张退回。测试工程只能写在 `project.json`。

### 步骤 0.6 真机（2026-11-05）

验收暂停、清空存储、音频与 `localStorage`，逐项数字见回归表 P3c 小节 D4、D5、D9–D16。脚本和截图在 `ignore/p3c/step05/`。用户在验收途中放开了「改壁纸」和「让 `tauri dev` 重启」，范围只限这次。

**测试工程。** 图片 id 13114，目录 `ignore/p3c/kbprops-test/`，行保留。在原工程上加了 `COUNT`、`AUDIO` 两层，`project.json` 声明 `supportsaudioprocessing: true`。

**与计划不一致的地方。**
- 原工程不能实时渲染。四个纯色图层用的 `models/util/solidlayer.json` 带 `solidlayer: true`，`features.ts` 报 `model:solidlayer`，整张退回预览图。处理办法是在工程里放同路径的本地文件 `models/util/solidlayer.json`，只保留 `material`，`scene.json` 不动。这样 6 层都按图层 `size` 画对，`unsupported` 为空。计划后面用这个工程的验收（`p_effvis`、泛光、清屏色）都依赖这个覆盖。WPE 是否也读这份本地文件没有验证，和 I10 对照时要先确认。
- 只选自定义目录导入会失败。`WallpaperImportDialog` 在没勾任何来源时 `canSubmit` 为真，提交的 `sources` 全是 `false`，`start_task` 返回 `sources: 至少选择一项`。这次带上待导入数为 0 的 `defaultprojects` 绕过。已由 `origin/main` 的 `40219e03` 修复：没勾来源时前端发 `sources: null`，本分支合并后生效。
- `average[0]` 只覆盖约 30–44 Hz，`chimes.wav` 在这个频段没有能量，`alpha` 全程 0。计划写的「随低频变化」要用很低的信号验证，这次生成了 40 Hz、-18 dBFS 的 14 s 信号。

**结论。** 测试项全部通过，下面几点没有覆盖或留有疑点：
- 预览的 `alpha` 跟声音未量到：放低音时主窗口被遮挡，只量了预览宿主的峰值与帧数；`alpha` 是在壁纸窗口上量的，脚本与写入路径相同。
- 真实在播的视频没有验证到时间冻结：这次用的三张样本都没有在放视频，12097 的两个媒体元素一直是暂停状态。往 12097 注入的 `<video>` 12 s 内 `readyState` 一直是 0，只确认了 `paused` 的切换，原因未查。
- 峰值回落后停在 `3e-45`，不是严格的 0。
- 多宿主同时清空时，17 轮里有 1 轮存储值比宿主数少 1，没有看到晚到的一方删掉别人写的值。

**恢复。** 当前壁纸 12888、模式 window、`wallpaperPaused` false，都已实测读回，`settings.json` 已落盘。「场景后处理」`disabled`、音量 1、dev 强制渲染开关 null、vortex 属性与测前相同（metadata id 20077 → 20081）。预览已关，路由 `/gallery`。副本 13115 的行与计数键已删，13114 的计数键已删。`settings.rs` 只改了 mtime，内容没动。

### 步骤 1

**实现。** 点 1、点 2 按上文落地，绑定目标没有改。effect 循环体抽成 `compileEffect`，它拿到一个预先填好 `source` / `id` / `enabled` 等字段的空 effect，出错或缺文件时关着的 effect 就用这个空壳进 bundle。

**与计划不一致的地方。**
- 计划写 `render/scene.ts` 不用改，**实际改了一处**。`populate` 把 `bundle.textures` 全部上传，`uploadTexture` 遇到没有 mip 或格式不认识的纹理会抛错。可变 effect 进 bundle 之后，关着的 effect 带的这种纹理（如 `tex:video`）会让本来能画的场景退回，和「运行时行为不变」冲突，编译单测看不出来。新增纯函数 `uploadableTextures`：只跳过仅被「关着且带不支持项」的 effect 用到的纹理。这种 effect 打开时走整场重编译，用不到这份纹理。没有可变 effect 的场景结果是全集。
- `p2a.test.ts` 没有 `SceneEffect` 夹具，不用补字段；只改了 `graph.test.ts`。

**留给步骤 2。**
- `scene.ts` 建 fbo 时，直接上屏的图层用的合成尺寸是 `[4, 4]`：全部 effect 关着时，关着的 effect 的 fbo 按 4×4 建。打开时要按真实合成尺寸（`compositeSize`），点 3 预建时要改。
- 关着且带不支持项的 effect，它的纹理与程序都没有 GPU 资源，打开时只能整场重编译，与点 3 的「`SceneState.write` 返回 `"recompile"`」一致。

**语料与真机**（2026-11-05 Claude 验收，脚本 `ignore/p3c/step1/effect.mjs`，基线 `ignore/p3c/corpus-05/`）。
- 语料 41 张、695 段：`unsupported` 逐张相同，脚本诊断逐段相同。这份语料不覆盖「关着的可变 effect 带不支持项」的样本，`uploadableTextures` 只有单测。
- 测试工程 13114：关掉 effect 走一次 `effect-visible` 重编译，固定时刻的 hash 变化，`state` 里仍有该 effect 的 pass；关着时改 `p_tintcolor` 就地写（applied +1，不重编译，hash 不变）；打开再走一次重编译，hash 回到开始的值。属性已恢复默认。
- bedroom、vortex 预览 `recompiled` 为空，按钮正常。
- 变异检查：着色器、纹理缓存改回只报一次，都有对应单测失败，已还原。

### 步骤 2

**第一版（异步重建，未提交，已被下面的修订取代）。** 当时按「允许卡帧」落地。加载与重建共用 `prepareLayer` + `buildLayer`，`rebuildLayer` 用 `runtime.rebuilding` 保证同一图层只跑一次。`createDraw` 改成同步，程序和管线由 `prepareLayer` 等齐后传进来。新增单测 `render/rebuild.test.ts`（假 `GPUDevice`），按「开着建 → 关 → `sync` → `rebuildsSettled` → `update`」与「关着直接建」比步骤序列、缓冲字节和一帧的编码轨迹。

**与计划不一致的地方。**
- `buildLayer` 拆成两段。原来写的是一个返回 Promise 的 `buildLayer`，那样错误作用域只能跨 `await`，新 draw 也拿不到等待期间的写入。现在 `prepareLayer` 异步等程序和管线，`buildLayer` 全程同步，`commitLayer` 把它和换上包在一起。
- 宿主多了 `rebuildRetried`。原来只写「重建失败整场重新加载」，但脚本打开的开关不进编译输入：重新加载后 `replayWrites` 又打开它，再失败，无限循环。现在第二次失败直接退回预览图，退回时复位。用户属性打开的 effect 不走到第二次，重新加载时 `GpuScene.build` 就失败了。
- 新增 `planProblems`（`checkRenderable` 与重建共用）：关着的 effect 加载时没过自查，重建前要补一次，否则 `program: null` 会在 `prepareLayer` 里出错。
- `applyChanges` 把被挡下的路径和 `plan.recompile` 一样处理（`forgetWrite` 等），否则用户值之后重放脚本的旧写入。
- `overrideAndReload` 从 `writeScript` 里抽出来，effect 与重编译目标共用去重。`ScriptApi` 的 `recompileValues` 只管 `recompile` 目标，effect 目标靠这里的去重，否则脚本每帧写就每帧重新加载。
- 改了计划没列的两个 dev 文件：`hostRenderFrame` 先 `sync` 再等 `rebuildsSettled`，否则读回的是旧计划；`scriptCorpus` 的 `read` 加 effect 分支，和 `host.ts` 一致。

**语料诊断会变。** 挂在 effect `visible` 上的脚本，`targetKind` 从 `recompile` 变成 `effect`，`recompileWrites` 归零。这是目标改造的直接结果，和步骤 1 的语料结果比较时要排除这两项。

**留的疑点。**
- 校验错误的结果在换上之后才回来：作用域只包同步段，要立刻换上才拿得到最新状态，等结果再换就要跨 `await`。校验失败时新 draw 已经在用，下一帧可能走 `onuncapturederror` 退回预览图，而不是重新加载。`GpuScene.build` 对同一份计划也会失败，最后都是退回预览图，只是原因键可能不同。
- 假设备不验证 WebGPU 的实际规则（bind group 与管线布局的兼容性、缓冲销毁时机），这些要真机确认。

**第一版的验收**（2026-11-06 Claude，脚本 `ignore/p3c/step2/`，基线 `ignore/p3c/step2/baseline-before.json`、`ignore/p3c/corpus-s1/`）。
- tsc 0 error，vitest 20 个文件、330 个用例。变异检查：循环尾加 `break`（不再比较签名）、去掉旧 draw 缓冲销毁，都有用例失败，已还原。
- 语料 41 张、695 段：`unsupported` 逐张相同，脚本状态与报错逐张相同；挂在 effect `visible` 上的 13 段 `targetKind` 变成 `effect`。
- 基线：bedroom、vortex、beach、deep space、eagleflag、13114 的 `host.renderFrame(1.5)` 哈希与动手前相同。
- 真机 13114：
  - 切 `p_effvis`：`applied` +1，没有新增重编译，78–155 ms 读到新画面；
  - 就地关的哈希 = 关着状态整场加载的哈希（`0bdbe4a69e95`），也等于步骤 1 整场重编译的值；打开回到开始的哈希；
  - 关着时改 `p_tintcolor`，哈希不变，再打开是新颜色，改回后回到开始的哈希；
  - 连切 21 次：没有重编译，最终状态正确；
  - 暂停时切换：屏幕截图开 / 关差 3.648、开 / 再开差 0.043，补画生效；
  - 控制台没有 WebGPU 错误或警告，6 条输出都是测试工程脚本自己的日志。
- 没有测到：校验错误的实际时序（只有单测，真机上构造不出来）；脚本逐帧切换带可变 effect 的真实场景（语料里能渲染的场景没有这种绑定，只有单测）。
- 坑：`kabegame-chromium` 驱动经 playwright 连接时，`document.visibilityState` 会读成 `visible`，判断窗口是否真的可见要用裸 CDP。

**修订：对齐 WPE（2026-11-06）。** 用户说明「允许卡帧」只是猜测，目标是对齐 WPE。查清 J 节之后，在第一版上修改，不重做：`planOf`、`prepareLayer`、`buildLayer`、`install`、`planProblems`、`SceneState` 的开关状态、绑定目标、脚本侧、`overrideAndReload` 都保留。下面「新增」「删除」是相对第一版。
- 新增：`variantPlans`、`FboBindings.initial`、`prepareVariants`、`preparedOf`、就绪表、`checkPlanOps`、`clearTarget`、`clearLayerFbos`、`SceneState.freezeLayer`，`render` 接住一帧 CPU 部分（`sync` / `update` / `encode`）的异常。
- 删除：`startRebuild`、`commitLayer`、`rebuildsSettled`、`LayerRuntime.rebuilding`、`rebuildTasks`、`GpuScene.destroyed`、`onRebuilt`、`onRebuildFailed`、宿主的 `rebuildRetried` 与 `rebuildFailed`；dev 按钮「下次切换重建失败」（`failNextRebuild`、`fail-rebuild`）。「整场重新加载」保留。
- 第一版留的「校验错误的结果在换上之后才回来」不再存在：切换路径上没有错误作用域，校验错误走 `onuncapturederror`。

**修订与计划不一致的地方。**
- `GpuSceneOptions` 删完两个回调只剩 `ignoreUnsupported`，接口和构造参数一起去掉，`build` 的参数回到内联类型，与第一版之前相同。
- `checkPlanOps` 的第二个参数是 `runtime`，不是 `runtime.resources`：`render:copy-format` 的原因键要图层名。
- 管线键拆成导出的 `stepPipeline` + `pipelineKey`：`graph.test.ts` 的覆盖单测要用真实的键，不能在测试里再写一遍。
- `sync` 里结构那段抽成 `rebuildStructures`，没有结构脏时直接返回，否则每帧多建一个 encoder。
- `dev/probe.ts` 回到第一版之前：原来就有一处 `scene.sync(state)`，只删掉第一版加的 `sync` + `rebuildsSettled`。
- 一帧 CPU 部分抛的非 `SceneRenderError` 归到原因键 `render:frame:…`。单测放在 `render/rebuild.test.ts`，它已有假设备。

**修订时查到的两点。**
- 计划写 `prepareVariants` 留在 `populate` 的作用域里会让整场失败，**按这份代码不成立**：`prepareVariants` 自己压了 validation 作用域，错误落到最内层匹配的作用域，到不了 `populate`。调用顺序仍照计划放在外面，用例按校验错误报出时的作用域栈钉住。真正的差别在 out-of-memory：见下面疑点。
- `plan(e <= 最后一个可变)` 与全开相同，不同的计划实际是 n+1 份。变异 `e < v` 的键集合也相同（等价变异）：管线按键去重，没有额外开销，代码照计划。

**子代理留的疑点，验收时已修（Claude，2026-11-06）。**
- `render:texture-kind` 在 `encode` 抛错（引用 fbo 的 draw 到 `encode` 才建 bind group）：`try` 只包 `sync` 时接不住，下一帧已排好，每帧抛一次，画面停住也不退回。`try` 扩到 `sync` / `update` / `encode`，走 `fail`。
- `render:no-final-pass`：全部开着的 effect 都没有绘制 pass 的组合不在 n+2 份里，`rebuildLayer` 补 `planProblems`，抛错走 `fail`，结果和整场加载相同。
- dev 强制渲染：开着且带不支持项的 effect 能就地关掉，`variantPlans` 把它算可变，否则关掉后抛 `render:variant-missing`。
- `prepareVariants` 加 out-of-memory 作用域：预建时显存不足只冻结图层，不影响当前画面。

**还留着的。**
- `prepareLayer` 用 `Promise.all`：一个程序先失败时作用域就弹出了，别的程序之后的 `createBindGroupLayout` 落在作用域之外。要两处同时出错才碰得到，没有改。
- 关着的 effect 的 FreeImage 解码失败、BC 纹理计入设备特性要求（步骤 1 留的两个小缺口）没有动。
- 合成 RT 只增不减，WPE 每次释放再取。两边每帧都整张重画，只差显存，不改。
- 最后一个启用 effect 的中间 pass 的矩阵（J7）和切换无关，单独查。

**修订的验收**（2026-11-06 Claude，脚本 `ignore/p3c/step2/`，图片 13114，实验工程 `ignore/p3c/wpe-sync/`）。
- 单测：宿主 tsc 0 error，vitest 20 个文件、367 项全过。变异七条全被抓到（不清 fbo、按 swap 后的实体清、去掉冻结判断、重建不查计划、`try` 只包 `sync`、签名没变就不清、去掉 OOM 作用域）。
- 语料 41 张、695 段：`unsupported` 与脚本诊断逐张相同（基线 `ignore/p3c/corpus-s1/`）。
- 没有可变 effect 的 5 张（12888、12889、12880、12881、12885）固定时刻哈希和动手前逐张相同。
- 13114：
  - 切换不重编译（applied 增加、`recompiled` 不变），连切 21 次最终状态正确，开回与开始的哈希相同；
  - 关着时改 `p_tintcolor`，哈希不变，打开是新颜色，改回后回到开始的哈希；
  - 就地关的哈希 = 关着状态整场加载的哈希（`1edc19038502`，比较时把持久计数钉回去，见下面的坑）；
  - 暂停时切换：屏幕截图开 / 关差 5.557，开 / 再开差 0.161；
  - 关着加载后第一次打开：帧间隔 p50 6.9 ms、最大 7.1 ms，与空闲相同，没有卡顿；打开预览到按钮出现 364 ms（含预建）。
- **和 WPE 同一套实验对比**（同样的工程，判读方式对齐 J5 / J6）：

| 实验 | WPE | Kabegame |
|---|---|---|
| 脚本写 effect `visible`，K0 与 B 同相 | 181 / 181 | 181 / 181 |
| 晚一帧的对照 K1 | 102 / 181 | 88 / 181 |
| L1 关自己，无 `clear` | 接着关之前的值走 | 接着走（如 101 → 109） |
| L2 关自己，带 `clear` | 回到 8 或 16 | 8 次都回到 8 |
| L3 切同层 tint，无 `clear` | 连续 | 连续，每步 +8 |
| L4 切同层 tint，带 `clear` | 开关两个方向都清 | 两个方向都回到 8 |
| swap 奇偶，开关 10 轮共停 20 帧 | 差值恒为 20 | 差值恒为 20（40 个样本，按 255 周期算） |

  脚本同帧用 `script-long`（把切换窗口放长，判定逻辑不变，我们帧率高，原工程的窗口不够采样）。`clear` 用暂停后逐帧步进，比连续采样确定。
- 没有测到：`script-api`（我们的脚本 API 没有 `getEffect`）；校验错误只有 `onuncapturederror` 这条既有路径；预建失败、冻结图层、`texture-kind` 只有单测，真机上构造不出来。
- 测试行 13118–13121 与对应任务已删除。当前壁纸 12888、窗口模式、未暂停。用户在 13114 上设的 `p_alpha` / `p_mode` 测试时临时改回默认，测完已放回。
- **坑**：13114 的哈希依赖窗口是否可见。隐藏时脚本不跑，`COUNT` 图层 alpha 停在初始值，所以之前几轮的 `a70e9f8a` 看起来跨加载稳定；窗口可见时它按持久计数每次加载都变，`AUDIO` 图层还跟着系统音频变。比较时要钉住计数并看状态差异，第一版验收里「就地关 = 整场加载」是在隐藏时测的。
