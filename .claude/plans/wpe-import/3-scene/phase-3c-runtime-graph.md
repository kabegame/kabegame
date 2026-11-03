# P3c — 做到 WPE 程度的不重编译（effect 可见性单图层重算等）

> 上级：[PLAN.md](PLAN.md)「P3 — SceneScript」。前置：[phase-3a-bindings.md](phase-3a-bindings.md)、[phase-3b-script-runtime.md](phase-3b-script-runtime.md) 已验收。
> 依据：[p3-script-REPORT.md](p3-script-REPORT.md) I2（哪些会重建）、I3（逐类绑定与改值回调）、I7 第 3–5 条；[p2-REPORT.md](p2-REPORT.md) B5 / B11（合成次数、`FUN_1401e6300`）；PLAN P2a「effect」「合成 RT」、P2b「HDR 判定」。

## 总体设计思路

3a 把材质常量、图层变换 / 颜色 / 可见性、泛光参数改成了就地写，3b 让脚本也写同一份状态；剩下仍要整场重编译的，是 effect 可见性、泛光开关、泛光级数、清屏色 / 环境光 / 相机、`colorBlendMode`、`hdr`、`size`。WPE 里这些大多也是就地处理的（I3）：effect `visible` 的改值回调 `FUN_1401e6300` 重算该图层的合成次数与 pass 数，数值变了才调图层虚函数 +0x110（`FUN_1402065e0`）重算尺寸、几何、合成 RT 与 passthrough 材质，别的图层与整场都不动；`bloom` 位每帧读；清屏色、环境光逐帧读或拷进渲染上下文；只有 `hdr`（运行中改不生效）、用户纹理（换纹理）、颜色校正（编新变体）例外（I2）。P3c 的目标是：WPE 就地处理的，我们也就地处理；重编译只剩 WPE 自己也要重建或不生效的情形，以及我们自己的设置变化（「场景后处理」档位）。

主体是 **effect 可见性的单图层重算**。现在编译期直接丢掉未启用的 effect（它们不进 bundle、不检查能力、不翻译着色器），所以运行时没法打开。P3c 改成：凡是可见性可能在运行时变化的 effect（`visible` 绑了用户属性，或有脚本挂在它的 `visible` 上），不论当前开关都编进 bundle，带上初始开关与**它自己的**不支持项；场景级的 `unsupported` 只算当前启用的 effect。写死 `visible: false`、没有任何绑定的 effect 照旧丢掉。运行时开关一个 effect，只对它所在的图层重新 `planLayer`（纯函数，已有）、按新步骤重建该图层的 draw、bind group 与 op 序列，换进 `GpuScene` 的图层表；要打开的 effect 带有不支持项时，退回整场重编译，结果照常退回预览图（与现在一致）。

为了让单图层重建能在两帧之间**同步**完成（WPE 也是同步的），可能用到的 GPU 对象在加载时一次建好：可变 effect 的程序与 fbo；每个可变图层两张合成 RT；以及「角色会变」的步骤的两种管线——effect 的最后一个绘制 pass 可能是普通 effect 步骤（合成 RT 格式、自己的混合）或上屏步骤（场景格式、借基础材质的混合），基础 pass 可能直接上屏或画进合成 RT。uniform 值按角色由 3a 的纯函数 `drawUniformValues` 重算，bind group 是同步创建的。这样重建只剩 CPU 计算、`createBindGroup` 与 `writeBuffer`，量级在亚毫秒。

其余几类：**泛光开关**照 WPE 每帧读——`general.bloom` 可变时，只要档位不是关闭、场景有对象就把泛光链建好，开关只决定本帧跑不跑泛光那一步；HDR 仍只在加载时判定（P2b，WPE 的 HDR 渲染位与交换链格式只在加载时算），运行中打开泛光的 LDR 场景得到 LDR 泛光。**泛光级数**照 WPE 预建：`bloomhdriterations` 可变时按可用级数建满金字塔，每帧只用前 N 级。**清屏色、环境光 / 天光、相机 `eye`** 直接就地写（正交相机里 `eye` 只进 `g_EyePosition`）。`colorBlendMode`、`hdr`、`size` 的处理见待定。

关键决策：可变性按「有没有绑定」判定，而不是一律预建——这样没有绑定的场景（目前本机能渲染的全部）在 P3c 前后 GPU 资源与画面逐字节相同，回归面最小；代价是绑定表成为预建范围的唯一依据，3a 的完整性单测因此更重要。

## 现状锚点

**a. 编译期丢掉未启用的 effect**（`apps/wpe-scene/src/compile/bundle.ts:480`）
```ts
    for (const raw of Array.isArray(object.effects) ? object.effects : []) {
      if (settled()) break;
      const instance = (raw ?? {}) as SceneEffectInstance;
      // 未启用的 effect 整步跳过（B11），也不检查它的能力
      if (resolveValue(instance.visible, properties) === false) continue;   // 现状：不进 bundle；3a 起登记 recompile("effect-visible")
      // …checkEffectFeatures(instance, effect, label, unsupported) —— 现状：不支持项直接进场景级 unsupported
```

**b. 渲染图只看 bundle 里的 effect**（`render/graph.ts:180`）
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

**c. GPU 资源按加载时的计划一次建好，之后不再变**（`render/scene.ts:307`）
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

**d. 泛光链只在 `general.bloom` 生效时编译与建立**（`compile/bundle.ts:577`、`render/bloom.ts:128`）
```ts
  // 泛光链：每帧在全部对象画完之后跑，前提是允许泛光、场景 bloom 生效且对象列表非空（A1）
  if (postprocess.bloom && scene.objects.length > 0 && !settled())
    bundle.bloom = await compileBloom({ fs, shader, unsupported, addProgram }, postprocess.hdr);   // 现状：bloom 为 false 时 null
```
```ts
  const levels = bloomIterations(params.hdrIterations, Math.max(1, bloomLevels(width, height)));   // 现状：只建 N 级
```

**e. 清屏色、环境光、相机在建场景时定死**（`render/scene.ts:225`、`:536`）
```ts
    const [r = 0, g = 0, b = 0] = general.clearEnabled ? general.clearColor : [];
    this.clear = { r, g, b, a: 1 };                    // 现状：之后不变
    // createDraw：
        eye: bundle.general.camera.eye,                // 现状：g_EyePosition 写一次
        ambient: bundle.general.ambient,
        skylight: bundle.general.skylight,
```

**f. 3a 结束时仍重编译的类别**（3a 点 1 计划中的形状，实施后以实际代码为准）
```ts
export type RecompileReason =
  | "effect-visible"      // 本阶段改成单图层重算
  | "postprocess"         // general.bloom（本阶段就地）/ general.hdr（待定 2）
  | "general"             // clearcolor / ambientcolor / skylightcolor / camera.*（本阶段就地）
  | "layer-structure";    // colorBlendMode（待定 1）、size（3a 已定 5）
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

## 点 1 — 编译可变 effect（`compile/bundle.ts`、`compile/features.ts`、`compile/bindings.ts`）

- **修改** effect 循环：
```ts
      const visibleBound = isUserBinding(instance.visible) || scripts.ownsEffectVisible(index, j);   // 新增：用户绑定或脚本挂在它的 visible 上
      const enabled = bindings.bind(instance.visible, properties, { kind: "effect", object: index, effect: j }) !== false;
      if (!enabled && !visibleBound) continue;            // 修改：只丢「写死关闭、没有绑定」的
      const effectUnsupported = new Set<string>();         // 新增：本 effect 自己的不支持项
      checkEffectFeatures(instance, effect, label, effectUnsupported);
      // …材质、着色器、纹理的不支持项也记进 effectUnsupported（compilePass 接受一个目标集合）
      if (enabled) for (const key of effectUnsupported) unsupported.add(key);   // 修改：只有启用的进场景级
      layer.effects.push({ /* … */, source: j, enabled, visibleBound, unsupported: [...effectUnsupported].sort() });   // 新增三个字段
```
  - 快速退回（`settled()`）照旧：场景已确定退回时不再编译后面的任何 effect，包括可变的。
  - 未启用的可变 effect 的 mip 照样解码（它随时可能打开）。
- **修改** 绑定目标：effect `visible` 从 `recompile("effect-visible")` 改成就地类目标：
```ts
  | { kind: "effect"; object: number; effect: number /* effects[] 下标（JSON 坐标）*/ }   // 新增
```
- **修改** 3b 的 `thisObject`（effect 对象）的 `visible` 写入改走同一个目标，不再按 3b 待定 6 合并重编译。

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

## 点 3 — 单图层同步重建（`render/scene.ts`、`render/state.ts`）

- **修改** 加载时为可变图层预建（「可变图层」= 有 `visibleBound` 的 effect 的图层）：
```ts
interface LayerRuntime {
  object: number;
  ops: Op[];
  draws: Draw[];
  /** 新增：可变图层的预建资源，重建时只从这里取，不再异步建任何东西。 */
  variants: {
    composites: RenderTarget[];                          // 按 2 张建（合成 RT 最多 2 张，B5）
    fbos: FboBindings;                                   // 全部编进 bundle 的 effect 的 fbo
    pipelines: Map<string, GPURenderPipeline>;           // 键：pass key | 角色（direct / base / effect / final）
  } | null;
  signature: string;                                     // 当前计划的签名
}
```
  - 需要两种管线的步骤：基础 pass（`direct` 与 `base`）、每个可变 effect 的最后一个绘制 pass 以及每个 effect 链末端可能成为上屏的绘制 pass（`effect` 与 `final`）；passthrough 图层的 effect 步骤只有 `effect` 一种。
- **新增** 同步重建：
```ts
  /** effect 开关后调用：重新计划；签名没变就只更新开关，变了就用预建资源重建本图层的 draw、bind group、op（同步）。 */
  rebuildLayer(object: number, state: SceneState): void {
    // planLayer(layer, textures, (e) => state.effectEnabled(object, e))
    // 对每个绘制步骤：管线取 variants.pipelines，uniform 由 drawUniformValues 按新角色算，bind group 同步建
    // 快照 op 按新计划的位置；旧 draw 的 uniform buffer 放回本图层的缓冲池复用（不 destroy 进行中的帧要用的资源）
  }
```
- **修改** `SceneState`：effect 开关进状态（`effectEnabled(object, effect)`），写入时把图层记进「结构脏」集合；`GpuScene.sync` 先处理结构脏（`rebuildLayer`），再处理 uniform 脏。
- **修改** 打开一个 `unsupported` 非空的 effect：`SceneState.write` 返回 `"recompile"`，宿主整场重编译（结果是退回预览图，与现在一致），日志写明是哪个 effect、哪些不支持项。

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
- **修改** 宿主日志：单图层重建记 `debug`（图层、effect、签名是否变化、用时）；重编译仍记 `debug` 并带原因（3a 已定 8）。
- **修改** dev 探针 `stats()` 增加单图层重建次数与用时（均值 / 最大）。

## 点 8 — 文档、回归与 changelog

- `cocs/wpe/WPE_SCENE.md`：「图层渲染图」补运行时开关与单图层重建、可变 effect 的编译规则与不支持项归属、预建资源；「泛光与 HDR」补开关就地与级数预建、HDR 只在加载时判定；「场景宿主」的就地 / 重编译分类表改成最终形态（并附上本文件的对照表）；`cocs/README.md` 摘要同步。
- `versions/latest/regression.md` 新增「场景壁纸 P3c：运行时渲染图」小节，用例见验收。
- `versions/latest/changelog.md` 用户侧 Optimized 一行：「场景壁纸开关图层效果、泛光，以及改背景色等属性时也即时生效，不再重新加载」。

## 实施步骤

每步都能单独验收；codex 只改仓库内文件，独立验收时先 `git status` 查越界，不采信自报。

**步骤 0 — 测试工程**（Claude）：本机默认样本里能实时渲染的场景都没有 effect visible、`general.bloom` 的用户绑定。把 I10 的测试工程 `kbprops-test`（已存到 `ignore/p3-userprops/dyn-test/kbprops-test`：四个纯色图层、tint effect 的可见性与常量、条件可见、位置 / 尺寸、脚本属性、只有 init 的脚本、泛光）拷到 `ignore/p3c/kbprops-test/`（gitignore，不进仓库），必要时补一个 `clearcolor` / `ambientcolor` 绑定与第二个 effect；在 Kabegame 里「添加壁纸目录」导入。WPE 一侧对它的现象见报告 I10（4b：关掉 effect 后 B 由绿变白、打开恢复）。

**步骤 1 — 编译与渲染图**（codex：点 1、点 2）
- 验收：单测（点 2 列出的几例，以及「不可变的关闭 effect 照旧不进 bundle」「可变 effect 的不支持项不进场景级」）；语料测试的 `unsupported` 与 3b 结束时逐张相同（本机没有不可变 → 可变的变化会让结论改变的场景；如有，逐张解释）。

**步骤 2 — 单图层重建**（codex：点 3）
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

**真机**（Windows dev，主窗口预览；壁纸窗口为窗口模式时一并验，不是就记未测）
- **测试工程 effect 开关**：属性面板切 `p_effvis`，B 层由绿变白、再变回绿（同 WPE I10 4b）；应用日志没有「重新编译」，探针 `stats()` 的单图层重建次数增加；关 / 开之后 `host.renderFrame(t)` 的哈希分别等于用同一属性值整场编译的 `renderFrame(t)` 哈希。
- **逐帧开关**：CDP 在宿主 frame 里以 rAF 频率交替推 `p_effvis` 10 s，记录单图层重建的均值 / 最大用时、`stats().frameMs` 的均值与 p95、宿主 rAF 与 `GPUQueue.submit` 次数（预期与不切换时相同），无重编译、无 WebGPU 校验错误。测完推回原值。
- **泛光开关**（「场景后处理」= 开启）：切 `p_bloom`，泛光随之出现 / 消失、不重编译；`p_bloomstr` 改强度即时生效。测完设置改回「跟随 WPE」。
- **清屏色 / 环境光**：测试工程补的 `clearcolor` 绑定改值后背景即时变色、不重编译。
- **脚本写 effect visible**（如本机有可渲染的样本；没有就在测试工程里加一段 `update` 按时间切 effect 可见性的脚本）：切换按脚本节奏发生，无重编译。
- 不回归：vortex、bedroom（三档）、P1 三张画面与 3b 相同；显存（日志的渲染目标估算）记进回归表，说明可变图层预建多出的部分。

## 风险

1. **预建资源的显存**：可变图层多两张合成 RT、全部可变 effect 的 fbo，`bloomhdriterations` 可变时建满 8 级金字塔（4K HDR 约 21 MiB，P2b）。只有带绑定的场景才多，记进回归表。
2. **重建与在途帧**：单图层重建发生在两帧之间（属性消息、脚本 `update` 都在帧前同步跑），旧 draw 的 GPU 对象可能仍被已提交未完成的帧引用；WebGPU 允许释放已提交的资源（会等用完），但为稳妥起见复用而不是立即 `destroy`。
3. **管线变体遗漏**：重建要求所有可能用到的管线已经建好；遗漏任何一种就只能异步补建（画面晚一帧）或报错。单测按「每个可变图层的全部开关组合」枚举需要的变体（effect 数小，组合数可控；超过 8 个可变 effect 时只枚举到角色层面）。
4. **WPE 语义的推断部分**：`FUN_1402065e0` 只在「数值变了」才重建；我们按计划签名判定，覆盖范围略大（结果相同）。`colorBlendMode` 的运行时行为 I3 没有列出（待定 1）。
5. **样本不足**：本机能实时渲染的场景都没有这几类绑定，主要靠测试工程与单测；工坊里有 effect visible 绑定的场景（如 2932157836 的 `wink`）要等它们的其它阻塞解除后才能真机看到。

## 已定（2026-11-03 用户）

1. 属性快速路径的第二步：做到 WPE 的程度（报告 I3 / I7），effect 可见性只重算该图层渲染图（合成次数、合成 RT、passthrough，对应 `FUN_1401e6300`），其余能就地改的都不重编译。
2. 重编译时保留脚本 realm 与脚本状态（3b 起），不重跑 `init`。
3. 默认照 WPE（报告 D / I 节）；COMBO 绑用户属性按不支持；快速路径要扛得住逐帧调用。

## 待定（附推荐）

1. **`colorBlendMode` 绑了用户属性**：I3 没有列出它的改值回调；值在 {0, 31} 与其它值之间切换会改变 passthrough 有无，passthrough 材质的 COMBO 又随值变（`BLENDMODE = cbm`），要按值翻译着色器。本机 binding-scan 0 处。**推荐保持重编译**，有样本再议。
2. **`general.hdr` 绑了用户属性**：WPE 运行中改了不生效，要重载（I3，HDR 渲染位与交换链格式只在加载时判定）。选项：(a) 照 WPE，运行时忽略，下次加载（含任何一次重编译）才用新值；(b) 重编译。**推荐 (a)**，与已定「默认照 WPE」一致；代价是用户在面板里改了看不到变化，直到下一次加载。本机 `hdr` 写成属性对象的样本 0 个（P2b），`bloom` 写成属性对象的 3 个。
3. **可变图层的判定范围**：只看绑定表与脚本表（本文件的做法），还是像 WPE 一样所有 effect 都编进 bundle。**推荐只看绑定**：没有绑定的场景零变化、零额外显存；脚本目前没有 `getEffect`（3b API 不含），不会在运行时打开未登记的 effect。等 `thisLayer.getEffect` 进入 API 阶段时，再把「有脚本的场景全部 effect 可变」加进判定。

## 后续

- 后续各 Phase 新增的可绑定属性按本文件对照表直接实现就地处理：粒子 `instanceoverride`（P4）、透视相机参数（P5）、文本重排与声音音量（P6）、用户纹理换槽（W5）、雾（P8）。
- `thisLayer.getEffect(…)` 进入脚本 API 时（见 3b「后续」），effect 可变性的判定扩到「有脚本的场景全部 effect」（待定 3）。
