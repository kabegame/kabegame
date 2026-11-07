# P4a — 层级、底座与档 1（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4a」。步骤 0 已完成，语义依据是 [p4-particles-REPORT.md](p4-particles-REPORT.md)、[rea-p4a.md](rea-p4a.md)、[rea-framework.md](rea-framework.md)，公式不在这里重抄。
> 分五步，每步能单独验收、单独提交。

## 总体设计思路

本节做两件事：让图层有父子关系，让粒子成为一种图层。

层级是纯变换问题。`SceneLayer` 加 `parent`，世界矩阵由父链累乘，本地矩阵改成完整的三轴旋转。`alpha`、`color` 不继承，只有 `visible` 沿链生效，绘制顺序仍是 `objects` 数组顺序。所以它基本不碰渲染图，只改矩阵和可见性。分组节点已经是 `layers` 里没有 pass 的图层，能力表不再拒绝就行。

粒子分三层，边界按「谁碰 GPU」划。编译期把 JSON 解析成纯数据放进 bundle。模拟器 `src/particles/` 是纯 TS，只有 TypedArray，所以能单测，也能离开渲染器直接和 WPE 的轨迹比。渲染层把列写成顶点，粒子是图层计划里一种新步骤。模块表是唯一事实来源：每个模块一条记录，含解析、执行和用到的列，能力表从它生成，表里没有的报 `particle:<类别>:<名字>`。

模拟器照 WPE 的形状写，不照 LWE：定长 float 列加标志开关，共用一列 `R`，operator 按 JSON 顺序逐条执行，每遍开头把 `size`、`rgb`、`a` 重置为初始值。这些都有实测或读码依据，LWE 在这几处都不同。

绘制统一走顶点展开，因为 WebGPU 没有几何着色器。每粒子 4 个顶点、6 个索引，每帧写一次缓冲。WPE 的 `genericparticle` 走几何着色器，真值是它的 `gs_out`，验收按四角比。

几个关键决定：

- **验收靠重放 dt。** 探针按 WPE 日志的 dt 序列步进，输出同格式轨迹，用现有的 `cmp_track.py` 逐帧比。发射量化取决于 dt，两边序列相同才能比。
- **float32 语义要跟。** 列用 `Float32Array`，累加器用 `Math.fround`。`starttime` 的步数就差在这里（51 步，不是 50 步）。
- **随机数用可设种子的 PRNG，不复刻 MT19937。** WPE 按时间做种，序列本来就不可复现，确定性工程也不依赖它。只保持两个区间：`[0, 1)` 和 `[1e-5, 1)`，以及抽取顺序。
- **两遍模式接帧上限：** `maxFps` 在 1–20 时两遍，否则一遍。Kabegame 默认 60，所以默认一遍。这是对应 WPE 的 `fps` 设置，判断条件相同。
- **重新编译时粒子重来（含预热）。** WPE 改 `instanceoverride` 不清粒子，这条走就地更新，保持一致。重编译只有 `general.hdr`、`colorBlendMode`、`size` 三种原因，都很少见。

## 现状锚点

**a. 只有 z 轴旋转，没有父链**（`render/layout.ts:78`）
```ts
/** 图层模型矩阵：`T(origin) · Rz(angles.z) · S(scale)`。P1 只处理 z 轴旋转（2D 图层）。 */
export function layerModelMatrix(layer: Pick<SceneLayer, "origin" | "angles" | "scale">): Mat4 {
  // 现状：angles.x、angles.y 被丢掉；sz === 0 时按 1
  return multiply(multiply(translation(x, y, z), rotationZ(layer.angles[2] ?? 0)), scaling(sx, sy, sz === 0 ? 1 : sz));
}
```

**b. 能力表**（`compile/features.ts`）
```ts
const OBJECT_FLAGS = ["parent", "perspective", "fullscreen", "passthrough", "instanceoverride", /* … */];
if (!kind) unsupported.add("object:empty");                         // 现状：分组节点直接退回
else if (kind !== "image" && kind !== "light") unsupported.add(`object:${kind}`);  // 现状：粒子只有一个键
```
`gravitydirection`、`gravitystrength`、`windenabled`、`winddirection`、`windstrength`、`perspectiveoverridefov` 不在 `NEUTRAL_GENERAL` 里，现在报 `general:<键>`。

**c. 粒子对象是没有 pass 的空图层**（`compile/bundle.ts:667`）
```ts
bundle.layers.push(layer);
if (!object.image) continue; // 现状：粒子的 JSON、材质、着色器都不进编译
```

**d. 图层计划只有四种步骤**（`render/graph.ts:61`）
```ts
export type LayerStep =
  | DrawStep
  | { kind: "snapshot" }
  | { kind: "copy"; effect: number; source: TextureRef; target: TargetRef }
  | { kind: "swap"; effect: number; source: string; target: string };
```

**e. 帧时间没有上下限**（`render/renderer.ts:393`）
```ts
const seconds = this.clock.seconds();
const frametime = this.lastTime === null ? 0 : Math.max(0, seconds - this.lastTime); // 现状：WPE 钳到 [0.0001, 0.25]
```

**f. 粒子路径自己的宏还没有**（`compile/shader.ts:107`）
```ts
const key = JSON.stringify([shader, scope?.dir ?? null, scope?.first ?? null, /* combos */, textures.map((t) => [t.slot, t.format]).sort(/* … */)]);
// 现状：TEX0FORMAT 只由 formatcombo 槽位决定；粒子要无条件写，见 phase-4-particles.md
```

## 步骤 1 — 层级

独立提交，图像层直接受益。

- **修改** `SceneLayer` **新增** `parent: number | null`（`objects` 下标）。
  > 说明：`parent` 只认数字，按 id 找。找不到或指向自己时为 null。成环时断开并报 `object:parent-cycle`：WPE 的递归没有防环，这个输入本来就不该有。
- **修改** `layerModelMatrix`：完整旋转，改名 `layerLocalMatrix`。
- **新增** `worldMatrixOf(index, layers)`，惰性按父链算，子在父前也成立。
```ts
/** W = W_parent · T · Rz·Ry·Rx · S，角度是弧度（2026-11-07 实测，四角差 0.0001 像素）。 */
export function layerLocalMatrix(layer: Pick<SceneLayer, "origin" | "angles" | "scale">): Mat4;
export function worldMatrixOf(object: number, layers: ReadonlyMap<number, LayerTransform>, cache: Map<number, Mat4>): Mat4;
/** `visible` 沿父链：自身和所有祖先都可见才可见。alpha、color、brightness 不继承。 */
export function effectiveVisible(object: number, layers: ReadonlyMap<number, LayerTransform>): boolean;
```
- **修改** `drawMatrices` 和 `encode` 的可见性判断用上面两个函数。
- **修改** `SceneState` 的脏标记：父的 `origin`、`angles`、`scale`、`visible` 变化时，子孙一起刷新。
- **修改** 能力表：`OBJECT_FLAGS` 去掉 `parent`；不再报 `object:empty`（WPE 把它们建成基类对象，只有变换）。分组节点上的 `effects` 不读，所以不报。
  > 说明：`passthrough` 仍报：它是组合层，子孙由父绘制，这条路径没读。`parallaxDepth` 不动，`general:cameraparallax` 仍报。
- **修改** `sz === 0 按 1` 的兜底保留，WPE 的行为这轮没有测。

**验收：**
- `proj/p4a` 的 5 个图层四角和 RenderDoc 差不超过 0.01 像素，绘制顺序、`visible` 遮蔽一致。
- 现有基线逐张相同。`angles` x、y 非 0 的现有场景要单独列出来和 WPE 比，它们的画面应该变。
- 语料的变化只在 `object:parent`、`object:empty` 上。

## 步骤 2 — 编译与能力表

- **新增** `compile/particles.ts`：解析粒子 JSON，出纯数据。
```ts
export interface SceneParticle {
  maxcount: number;
  starttime: number;
  flags: number;
  emitters: ParticleModule[];
  initializers: ParticleModule[];
  operators: ParticleModule[];   // JSON 顺序，不排序
  renderer: { name: "sprite"; orientation: "screen" };
  /** 默认值分正交、透视两套（`rea-p4a.md` 基础一节）。 */
  orthographic: boolean;
  instance: ParticleInstance;
}
```
- **新增** `particles/modules.ts` 的模块表，档 1 共 12 项：`sphererandom`；`lifetimerandom`、`sizerandom`、`velocityrandom`、`colorrandom`、`rotationrandom`、`angularvelocityrandom`；`movement`、`angularmovement`、`alphafade`、`oscillateposition`、`oscillatealpha`。
- **修改** `checkObjectFeatures`：粒子不再报 `object:particle`，改成逐模块检查，表外报 `particle:<类别>:<名字>`。
  - `sprite` 的 `orientation` 不是 `screen` 时报 `particle:renderer:orientation`（`upright`、`fixed` 的几何没读）。
  - 带 `effects`、开 `LIGHTING` 的粒子自己报不支持。
  - `children`、`controlpoint` 的非默认用法报不支持，留给后面各节。
- **修改** `NEUTRAL_GENERAL` 加风、重力五个键和 `perspectiveoverridefov`。
  > 说明：读码没有找到消费点。验收用实验确认，因为有 6 张场景的解锁取决于这一项。
- **修改** `ShaderCompiler`：粒子材质无条件写 `TEX0FORMAT`，进缓存键。
- **修改** `bundle.ts`：粒子对象读 JSON、材质、纹理和着色器，结果放进 `layer.particle`。

**验收：**
- 语料重扫，粒子键细分后 70 张的覆盖数和总计划一致：档 1 完全覆盖 4 张。其余变化要逐条解释。
- 现有基线逐张相同。
- 风、重力实验：同一工程开关这几个键，`rd-*` 轨迹逐位相同。

## 步骤 3 — 模拟器

不碰 GPU，这一步结束时粒子还不显示。

- **新增** `particles/system.ts`
```ts
export class ParticleSystem {
  constructor(def: SceneParticle, random: Random, passes: 1 | 2);
  /** 一帧：年龄与判死 → 发射与 initializer → operator（passes 遍）。dt 已乘 rate。 */
  step(dt: number, frameDt: number): void;
  /** 加载时一次跑完：`while (t < starttime)`，步长按 maxcount 取 0.05 或 0.2，固定一遍，发射开启。 */
  prewarm(): void;
  readonly columns: ParticleColumns;
  readonly highWater: number;
  readonly alive: number;
}
```
- **新增** `particles/columns.ts`：定长列加标志开关，表见报告。
  > 说明：别名照 WPE：没有 bit3 时颜色当前值就是初始值列，这样重置是空操作。
- **新增** `particles/emitters.ts`、`initializers.ts`、`operators.ts`，按模块表分发。公式见 `rea-p4a.md`，要特别注意：
  - `sphererandom` 的距离用 `|p|` 不是 `r`；`cone`、`sign` 按读到的写。
  - `colorrandom` 三通道共用一个 `t`，`velocityrandom` 三轴独立，抽取顺序 z、y、x。
  - `oscillateposition` 的 ω 不乘 2π，相位加在时间上；y 多一个 `2π·R`。
  - `oscillatealpha` 的幅度里多乘一次 `R`。
  - drag 的 `k0`，发射的 `instantaneous` 欠账。
- **新增** `particles/random.ts`：可设种子，两个区间。
- **新增** 探针 `particleTrack`：按给定 dt 序列步进，输出 `cmp_track.py` 能读的轨迹。
```ts
particleTrack(options: { projectDir: string; dts: number[]; frames: number[]; passes: 1 | 2 }): Promise<TrackFile>;
```
- **新增** 单测和固定数据：`particles/fixtures/` 放从 `rd-*.json` 截出的短片段，不依赖 `ignore/`。

**验收：**
- 全部已抓的数据重放，和 WPE 逐帧比：`linear`、`gravity`、`birth`、`gfirst`、`drag`、`order-*`、`o2-*`、`pre-*`、`burst`、`osc-y`、`inst`。限 1e-3，位置大于 1000 时 float32 精度放宽到 2e-3。
- 变异自检：改掉帧内顺序、`R` 共用、`Math.fround`、两遍判断，各有测试失败。
- 新抓一组测 `oscillateposition` 的 y 偏移：`scalemin 0`、`scalemax 100`，用幅度反推 `R`，再比 `2π·R`。

## 步骤 4 — 绘制

- **新增** `LayerStep` 的 `{ kind: "particles" }`，和图像步骤同样按 `objects` 顺序执行。
- **新增** `particles/vertices.ts`：把列写成交错顶点，步长 52，跳过 `life == 0`，按槽序。
```ts
// POSITION 12、TEXCOORD0 16（u, v, rot.z, size）、TEXCOORD2 8（rot.x, rot.y）、COLOR 16
export function writeVertices(system: ParticleSystem, into: Float32Array): number;
```
- **修改** 建管线：`vertexPacking` 按着色器的 `attributes` 排，顶点写入要按它给的偏移，不写死。
- **修改** `GpuScene`：粒子层建顶点缓冲（`COPY_DST`）和只建一次的索引缓冲，`update` 里步进，`encode` 里 `writeBuffer` 后绘制。
- **新增** 透视粒子：`flags & 4` 时换一套 view、projection：
```ts
const d = (height / 2) / Math.tan(fov / 2);     // fov = radians(perspectiveoverridefov ?? 95)，钳到 [0.1, 179.9] 度
// 相机在 (w/2, h/2, d) 看向 -z，near 5，far max(15000, d + 1000)
```
- **修改** `renderer.ts`：`frametime` 钳到 `[0.0001, 0.25]`，`g_Time` 改成累加钳后的值，和 WPE 一致。
  > 说明：这会改现有场景的时钟，但只在单帧超过 0.25 s 时才有差别。基线走探针，不受影响。
- **修改** uniform：粒子要的 `g_OrientationUp/Right/Forward`、`g_ViewUp/Right`、`g_EyePosition`、`g_RenderVar0/1`、`g_Texture0Resolution`。
- 接入泛光和双缓冲不清屏：粒子是场景目标上的普通绘制，走现有路径。

**验收：**
- 我们翻译的 `genericparticle` 顶点路径和 WPE 的 `gs_out` 四角比，含三轴旋转（`rot-gs`），差不超过 0.01 像素。这是风险 7。
- 项目自定义 `particle`（`rot-vs`）和 WPE 的 `vs_out` 比。
- 透视粒子四角和 WPE 比（`persp`、`persp-z`，两种 `fov`）。
- 确定性工程逐像素比：硬边、无抗锯齿，差异只能在 ±1 像素的边缘。
- `util/white` 的 249/255 要自然得到：纹理 mip 和采样对上才行。对不上时查清楚再放宽。
- 现有基线逐张相同。

## 步骤 5 — `instanceoverride`、生命周期与解锁

- **修改** `BindingTarget` 新增 `{ kind: "particle-instance"; object: number; field: InstanceField }`，就地写，下一帧重算。
  > 说明：从基值重新乘，不累乘。存活粒子保留已有的 life、颜色、尺寸；`rate` 每帧现算，立即生效。
- **修改** `OBJECT_FLAGS` 去掉 `instanceoverride`。`color`、`colorn` 的 HSV 路径读得不完整，只有样本用到时才测，否则报 `particle:instance:colorn`。
- **修改** 可见性：不可见时不发射，还有存活粒子就清空。重新可见时重新发射，不重新预热。这条只读到代码，要测。
- **修改** 暂停和切换壁纸：时钟冻结时不步进，切走时释放缓冲。
- **新增** 帧时间记录，给 `maxcount` 上限的结论。

**验收：**
- `shimmering_particles`、`3062029089` 解锁，统计量和 WPE 一致：粒子数、位置范围、尺寸分布。
- 改 `count`、`glow`、`style` 不重编译。
- 预览、桌面、暂停、切换壁纸没有残留和泄漏。
- 记录这两张的帧时间，定 `maxcount` 上限（最大的 62.5 万、其次 12.8 万）。
- 语料覆盖数达到 4，基线逐张相同。
- 能解锁的场景交用户在真机上确认。

## 待定

1. `maxcount` 上限和超限处理：等步骤 5 的实测。
2. ~~`angles` x、y 非 0 的现有场景~~：步骤 1 列出 9 张（见实施记录），都还有别的不支持项，现在能渲染的场景不受影响。等它们解锁时再和 WPE 比画面。

## 风险

1. **主线程预算：** 模拟和脚本共用一帧。62.5 万粒子每帧要写 1.3 亿字节顶点（4 个顶点 × 52 字节），要靠上限或降级。
2. **`colorn` 的 HSV 路径没读全：** `shimmering_particles` 的 `instanceoverride` 只有 `id`，但用户属性可能绑到它。
3. **透视场景的默认值另一套：** `camera:perspective` 仍报不支持，这套默认值这节用不到，但解析要留开关，避免以后错用正交值。
4. **`rcpps` 近似：** `alphafade`、发射方向用近似倒数，相对误差约 3.7e-4。透明度验收的 0.004 够宽，位置比较要留余量。
5. **读码结论出过错：** 预热的遍数就是读码错了。没有实测的项不要当成已确认，步骤 3 的测试要覆盖到。

## 实施记录

### 步骤 1 — 层级（2026-11-07）

子代理实现，Claude 独立验收。

- **新增** `compile/hierarchy.ts` 的 `resolveParents`：按 id 解析成 `objects` 下标。
  - 不是有限数字、找不到、指向自己时当根节点；id 重复取第一个（没有实测）。
  - 成环从下标小的对象开始走，断掉指回本轮走过节点的边，报 `object:parent-cycle`。
- **修改** `render/layout.ts`：`layerLocalMatrix` 带完整三轴旋转；新增 `worldMatrixOf`、`effectiveVisible`、`everyAncestor`。
  世界矩阵缓存不放进 `SceneState`，每次建场景、每次 `sync` 各建一份，状态变了不会读到旧值。
- **修改** `render/scene.ts`：新增 `buildableLayers`，自身和每个祖先都可能可见才建资源，`checkRenderable` 同一口径。`visibleObjects` 用继承后的可见性。
- **修改** `render/state.ts`：写 `origin`、`angles`、`scale`、`visible` 时自身和子孙一起标脏。
- **修改** 能力表：去掉 `parent`、`object:empty`。灯带有效父对象时仍报 `object:parent`：`lights.ts` 用的是本地 `origin`，灯在父链下的位置没和 WPE 比过。分组节点上的其它键照报。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；24 个文件、690 个用例全过（原 666 个）；格式通过 |
| 真值：`proj/p4a` 从磁盘编译，按渲染器的路径算四角，对 RenderDoc | 5 个图层最大差 6.1e-5 像素；可见顺序 h3、h4、h1、h2、h7，h6 不画；alpha 不继承 |
| 变异检查 | 旋转顺序、世界矩阵不走父链、可见性不继承、建资源不看祖先、子孙不标脏、成环不报、灯带父不报、父不存在误处理，各有用例失败 |
| 语料 149 个工程（Node 侧编译） | 66 张变化：只去掉 `object:parent` 27 张、只去掉 `object:empty` 10 张、两者都去掉 29 张，没有新增项和其它差异。仍报 `object:parent` 的是灯带父对象的 `3453730450`、`3706286085`。干净的仍是 11 张，没有新解锁 |
| 真机哈希（dev 库重新导入过，按目录对应新 id） | 10 张干净场景 × 三档，30 组画面哈希、显存统计、格式改动前后全部相同 |

`angles` x、y 非 0 的图像层所在场景有 9 张：1923929928、3219908811、3308867900、3453730450、3462279189、3516174947、3600630828、3823859141、3823864170。

工具在 `ignore/p4/step1/`：`corpus.test.ts`（语料）、`truth.test.ts`（真值）、`compare.py`、`hash-before.json`、`hash-after.json`。

`cocs/`、changelog、回归文档放到 P4a 收尾时一起写。

### 步骤 2 — 编译与能力表（2026-11-07）

子代理实现，Claude 独立验收。

- **新增** `particles/modules.ts`：模块表 13 项（档 1 的 12 个加 `sprite`）。每项有字段表（形状、正交 / 透视缺省值、本节支持的取值）、列、列标志和 `run` 槽位（步骤 3 填）。解析和能力表共用 `readParticleModule`。
- **新增** `compile/particles.ts`：`SceneParticle`、正交判定、`particleFov`、系统级键、`instanceoverride` 的静态值。
- **修改** `compile/bundle.ts`：粒子对象读 JSON、检查、解析、编材质，pass 放在 `layer.particle.passes`，不进 `layer.passes`。
- **修改** `compile/features.ts`：
  - 不再报 `object:particle`，每个粒子对象报临时键 `particle:pending`，**步骤 4 接上绘制后删掉**。
  - 能力表按模块表生成。
  - 风、重力 5 个键进中性表（实测见报告）；`perspectiveoverridefov` 解析进 `SceneGeneral.perspectiveOverrideFov`。
- **修改** `compile/shader.ts`：`compile` 多一个 `defines` 参数，进缓存键；粒子材质经它无条件写 `TEX0FORMAT`。图层材质的缓存键逐字不变。

和委托字面要求不同的三处，按证据定：
1. **`renderer: []` 不补 `sprite`。** WPE 只在缺键或不是数组时补（`0x1401c58af` 前的 `isArray`）。语料里写成 `[]` 的 5 个都是带 `children` 的发射器，本来就被挡住。
2. **COMBO 检查不算着色器注解的缺省值。** `genericparticle` 的 `FOG` 缺省 1，只在引擎宏 `FOG_DIST` / `FOG_HEIGHT` 下起作用。纹理槽带出的 COMBO 照算，所以 `2903412088` 多报一个 `NORMALMAP`，那张本来就被别的键挡住。
3. **`PARTICLE_UNIFORMS` 在粒子 pass 里暂按引擎 uniform 放行：** `g_OrientationUp/Right/Forward`、`g_ViewUp/Right`、`g_RenderVar0/1`。**步骤 4 必须真的写这 7 个。**

步骤 4 要注意：
- 粒子纹理现在进了 `bundle.textures`，但 `uploadableTextures` 只看图层 pass，不上传；`requiredFeatures` 已经算上它们。
- `particle:pending` 删掉时，粒子纹理的上传、`checkRenderable` 的粒子程序检查要一起接上。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；25 个文件、750 个用例全过（新增 60 个）；格式通过 |
| 变异检查（代理 5 处、Claude 12 处） | 不报 `pending`、周期字段不看 bit2、正交缺省值、世界空间、控制点 `offset`、风键、fov 钳制、COMBO 放行、发射器控制点、朝向、`TEX0FORMAT`、粒子 pass 混进图层 pass，各有用例失败 |
| `shimmering_particles` | 4 个粒子层都编出程序，不支持项只剩 `particle:pending`、`object:instanceoverride` |
| 语料 149 个工程（和步骤 1 比） | 去掉的只有 `object:particle`、风和重力键、`perspectiveoverridefov`。新增的非粒子键全在带粒子的场景上，是粒子材质和纹理第一次进编译带出的：`tex:animation` 49 张、`tex:alpha-priority` 20、`tex:format` 15、`material:alphawriting` 14、`depthwrite:enabled` 4、`cull:normal` 3、`material:usertextures` 2、`depthtest:enabled` 1。干净场景仍是那 11 张 |
| 档 1 覆盖 | 旧统计的 117 张里正好是 `demon_core`、`dna_fragment`、`shimmering_particles`、`3062029089`。全语料 7 张，多出的 `2854083091`、`3173418061`、`3453730450` 是之后下载的 |
| 全部不支持项都是粒子类 | 只差 `pending` 和 `instanceoverride` 的：`shimmering_particles`、`3062029089`；再加 `1838478131`（还差控制点、`sizechange`）、`2254685070`（还差控制点、发射器 `flags`、`rope`） |
| 真机哈希 | 10 张干净场景 × 三档，30 组和改动前全部相同 |

挡住场景最多的粒子键：`controlpoint` 48、`turbulentvelocityrandom` 41、`animationmode` 38、`boxrandom` 37、`sizechange` 34、`sequencemultiplier` 34、`children` 31、`alpharandom` 31。完整清单在 `ignore/p4/step2/out/compare.txt`。

工具在 `ignore/p4/step2/`。

### 步骤 3 — 模拟器（2026-11-07）

子代理实现，Claude 独立验收。

- **新增** `particles/` 下的模拟器：
  - `f32.ts`、`random.ts`（mulberry32，两个区间）；
  - `columns.ts`（一块 `Float32Array`，基础 17 列加 5 组标志列，别名照 WPE）；
  - `emitters.ts`、`initializers.ts`、`operators.ts`（档 1 全部 12 个模块）；
  - `system.ts`（`ParticleSystem`）；
  - `track.ts`（输出 RenderDoc 同格式的轨迹）。
- **修改** `modules.ts`：执行函数挂在模块表的 `run` 上，分发只走这张表。新增 `resolveParticleFields`，按 `instanceoverride` 从基值乘。
- **修改** dev 探针：加 `particleTrack`，只过了类型检查，在应用里没跑过。
- **固定数据** `particles/fixtures/`：fps60、fps10、s15、s60、p4a2，共 64 KB，单测不依赖 `ignore/`。

和计划不同、或读码没写由代理推断的：
- `step(frameDt)` 只收帧时间，内部乘 `rate`。drag 的 `k0` 要用没乘 `rate` 的帧时间。
- 判死是严格大于（`life < age`）。新粒子填编号最小的空槽，高水位只增不减。
- `sphererandom` 距离为 0 时另抽的 3 个方向随机数按 x、y、z 顺序，是推断。`|p| = 0` 时按 0 处理，不复刻 WPE 乘出的 NaN。
- blend 的「三个间距」取 `ie−is`、`os−ie`、`oe−os`，是推断，档 1 的数据里没有 blend。
- `rcpps` 近似不复刻，alpha 因此差 2.4e-4。
- `instanceoverride` 在构造时乘进字段，所以预热也用乘过的值；预热步长不乘 `rate`。这两点都没实测。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；27 个文件、801 个用例全过（新增 51 个）；格式通过 |
| 回放 8 个 tag + p4a2（dt 用日志累计时间差分，抓帧用 float32 原值） | 档 1 的全部系统在限内：`linear`、`custom` ≤ 9.2e-5，`birth` ≤ 3.5e-4，`gravity` ≤ 4.9e-4，`order-*` ≤ 6.1e-4，`o2-init` ≤ 1.5e-4，`drag`、`rot` ≤ 1.2e-4，`inst` 9.2e-4，`burst` 1.1e-3（坐标过 1000，限 2e-3）。尺寸、颜色、旋转差 0，alpha ≤ 2.4e-4，粒子数和出现的系统逐帧一致 |
| `pre-*`（s15、s60，坐标约 1.1e4） | 2e-3–9.8e-3，超限。判定为输入精度：float32 在这个坐标上一个 ulp 是 9.8e-4；dt 在日志精度内扰动后，两个 tag 都出现和 WPE 逐位相同的结果，基准残差在扰动分布中间（`ignore/p4/step3/out/jitter.txt`）。s60 的 `pre-small` 在 8 帧上恒差 7 个 ulp，不随帧增长 |
| `o2-cap-*` | 2.1e-3–2.6e-3。`capvelocity` 属 P4b，是回放工具临时补的；WPE 截后的速度是 99.9927 的固定比例（近似倒数），乘上这个系数后 ≤ 2.1e-4，说明 operator 顺序和两遍模式是对的。**P4b 实现 `capvelocity` 时要处理这个近似** |
| `osc-r`、`osc-y` | `R` 随机，不逐位比。产品模拟器注入反推的 `R` 后，`osc-r` 4 个粒子 x、y 残差 ≤ 6.1e-4，`osc-y` 6.1e-5 |
| dt 两种取法 | 日志 dt 列逐帧累加时，`gravity`、`inst`、`pre-small` 都会超限；累计时间差分没有这个问题 |
| 变异检查（代理 14 处、Claude 10 处） | 帧内顺序、`R` 共用、`Math.fround`、两遍判断、`|p|`、抽取顺序、预热步数、ω、y 偏移、实例 alpha、`rate`、空槽回收、判死边界、预热遍数、每遍重置、`size0` 初值、`R` 与发射器的先后、预热 `k0`、新粒子当帧走 operator，各有用例失败 |

工具在 `ignore/p4/step3/`（`replay.test.ts`、`jitter.test.ts`、`rfit.test.ts`、`make_fixtures.py`）。

### 步骤 4 — 绘制（2026-11-07）

子代理实现，Claude 独立验收。`particle:pending` 保留，解锁在步骤 5。

- **新增** `render/graph.ts` 的 `ParticleStep`：粒子层按 `objects` 顺序和图像层混排，同一个场景 render pass。
- **新增** `particles/vertices.ts`：顶点偏移按翻译器反射出的 `attributes` 排；UV 依次 (0,0)(0,1)(1,1)(1,0)，索引 `0 1 2 0 2 3`，步长 52。
- **修改** `GpuScene`：每个粒子层一个模拟器，建场景时预热；顶点缓冲按容量建，索引缓冲全场一份；每帧步进、写存活部分、`drawIndexed`。粒子纹理上传，粒子程序进 `checkRenderable`。
- **新增** `particleViewProjection`：透视粒子相机，反向 Z，near 5、far `max(15000, d + 1000)`。
- **修改** `ORTHO_DEPTH` 10000 → 2000，和 WPE 一致（图像层与粒子都是 `0.00025·z + 0.5`）。
- **新增** `FrameClock`：帧时间钳到 `[0.0001, 0.25]`，`g_Time` 累加钳后的值；补画帧时间为 0。脚本的 `engine.runtime` / `engine.frametime` 也随之改用钳过的时钟。
- **修改** 能力表：粒子对象的 `alpha`、`color`、`brightness` 取非默认值时报 `particle:object:<键>`（语料 0 张）。
- **新增** dev 探针：`renderFrame` 的确定性粒子回放（`particles: { dts, seed, passes }`）；`particleCorners` 把翻译后的顶点 WGSL 改写成计算着色器，取我们实际算出的四角。

未定、留给步骤 5：不可见时现在是不步进也不画（WPE 是停发射、清空）。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；30 个文件、842 个用例全过（新增 41 个）；格式通过 |
| 变异检查（代理 14 处、Claude 6 处） | 透视位、透视 `d`、跳过空槽、帧时间上限、正交深度、近平面等，各有用例失败 |
| 风险 7：我们翻译的顶点路径对 WPE（真机 Tint，s60 第 725、718 帧） | `linear`（内置 `genericparticle`，WPE 走几何着色器）、`rot-gs`（同上，三轴旋转）、`custom`、`rot-vs`（项目 `particle`）：第 725 帧四角逐位相同，第 718 帧最大差 5.7e-5 像素 |
| 透视粒子四角（真机） | fov 95、fov 60，z = 0 和 z = 300：最大差 1.7e-4 像素，`w` 一致 |
| 整帧像素（s60 两帧，回放 WPE 日志的 dt） | WPE 有内容的 6382 个像素里 6214 个逐字节相同，`util/white` 自然得到 249。其余 168–186 个全在 `o2-cap-ab`、`o2-cap-ba` 两行，它们的 `capvelocity` 属 P4b、没实现；除这两个系统外整帧逐像素相同 |
| 真机哈希 | 10 张干净场景 × 三档，30 组和步骤 1 之前全部相同（含 `ORTHO_DEPTH`、帧时钟的改动） |
| 语料 | 和步骤 2 共有的 149 张没有变化 |

测试行 13814–13817（`p4-0`、`p4a`、`p4a-fov60`、`p4a2`）导入后已用 `batch_remove_images` 移除，导入任务已删，图库行数复原。

工具在 `ignore/p4/step4/`：`real.mjs`（真机回放、读图、四角）、`cmp_real.py`、`wpe_rt.py`（导出 WPE 参照图）、`import.mjs` / `cleanup.mjs`、`hash-after.json`。
