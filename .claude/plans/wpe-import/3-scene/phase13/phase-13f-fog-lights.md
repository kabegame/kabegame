# P13f — 雾与灯的运行时（子计划）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13f」。读码：[rea-p13-lights.md](rea-p13-lights.md) 第 1 节（遗留灯）、第 2 节（雾）、第 3 节（灯的运行时）；[rea-p6d1-matstate.md](../phase6/rea-p6d1-matstate.md) 第 4 节（`ADDITIVE`）。实测：[p13-REPORT.md](p13-REPORT.md) 第 16、17 行（雾的打包、灯字段的脚本与关键帧当帧生效），「P13a 的实测」（遗留灯槽位）。

## 总体设计思路

P13f 做两件互相独立的事。

**雾**是四个引擎 uniform 加两个引擎宏。`general.fog*` 的 14 个字段在 WPE 里都是普通的 general 描述符，改值回调整组重算 `g_FogDistanceColor`、`g_FogDistanceParams = (start, end − start, startdensity, enddensity − startdensity)`、`g_FogHeightColor`、`g_FogHeightParams`；宏 `FOG_DIST` / `FOG_HEIGHT` 只在材质加载时定，条件是 general 开关为真**且**材质组合表（并进着色器 `[COMBO]` 的缺省值之后）里 `FOG` 非 0。所以我们把 12 个数值 / 颜色字段和两个开关一起并进 `GENERAL_FIELDS`：数值每帧由渲染器从 `SceneState.general` 打包成四个 uniform（同 `ambientcolor` 的做法），属性、关键帧、字段脚本、`thisScene.fog*` 都走已有的 general 目标，就地生效；两个开关只在编译期决定宏，运行中改了只改状态、不重编（照 WPE，步骤 0 实测核对）。同时补上 P6d1b 发现的加载期组合键 `ADDITIVE = 1`（混合是 `additive` 的 pass），它只在雾分支里被读。

**灯的运行时**把灯从「编译期常量」换成「每帧由 `SceneState` 算」。灯对象本来就进 `bundle.layers` 与 `SceneState.layers`（P6d3a 的对象表），`origin` / `angles` / `scale` / `color` / `visible` / `parent` 已经是图层字段，脚本 `getLayer(灯).angles = …` 也已经写进状态；缺的是灯自己的字段（`intensity`、`radius`、`exponent`、`innercone`、`outercone`、`controlpoint`、`density`、`volumetricsexponent`、`cascadedistance0–2`、`lightsourcesize`）和「每帧从状态读」这一步。做法：
- 新增就地目标 `{ kind: "light"; object; field }`，`SceneState` 多一张 `lights` 表存这些字段；属性绑定、关键帧（P10a 运行时，去掉 `value:animation:light`）、字段脚本（`targetOf` 给灯字段出目标）、脚本对象上的同名成员都写这张表。
- 渲染器每帧按状态现组 `SceneLight` 记录：世界矩阵与可见性沿父链（`worldMatrixOf` / `effectiveVisible`，同图层；父是模型时取模型的 `W`，不含骨骼），排序键仍用**局部** origin（R2.3）。`lightFrame` 本身不改。
- 遗留灯（`"light": "point"`）的三个数组从材质常量搬到每帧 uniform；WPE 在动画与脚本**之前**写它们，所以用上一帧末的状态（晚一帧，步骤 0 核对）。
- 体积光（P13e）与阴影（P13d）改读每帧的记录：体积光为每盏 `castvolumetrics` 的点光 / 聚光预建绘制，每帧按当时的可见性重新分段（WPE 就是每帧在绘制循环里登记，`3453730450` 的三盏体积光灯挂在可见性绑属性、位置挂脚本的父对象下）；常量（位置、半径、强度、颜色、密度、指数、锥角）每帧写。
- WPE 运行中重建资源的字段（`light` 类型、`castshadow`、`usecookie`）与 `castvolumetrics` 绑属性 / 挂脚本 / 挂关键帧时照报（语料 0），能力表另报一个键，不再只在运行时打一条 warn。
- 能力表去掉灯上的 `object:parent`、`value:animation:light`、`general:fog*`。

关键决策：
- **雾字段并进 `GENERAL_FIELDS`，不另建一套**：它们在 WPE 里就是 general 描述符，`thisScene` 字段、关键帧、属性绑定都现成；`compile/scriptApi.ts` 缺失表里的 12 个 fog 字段随之删掉。
- **灯字段单独一张状态表，不塞进 `LayerState`**：`LayerState` 是所有对象共用的形状，灯的 11 个字段只有灯有；颜色仍是图层的 `color`（同一个描述符键，WPE 灯类表里的 `color` 覆盖基类的同名字段，取值规则相同，步骤 0 核对）。
- **按 P13f 拆两步验收**：雾（+ `ADDITIVE`）先做，解锁 `3115845558`；灯的运行时第二步做，和雾一起解锁 `3706286085`。

## 现状锚点

**a. 雾字段照报**（`compile/features.ts`，`NEUTRAL_GENERAL` 不含 `fog*`，`checkSceneFeatures` 末尾的循环对非中性、非解析的 general 键报 `general:<键>`）
```ts
const NEUTRAL_GENERAL = new Set([
  "orthogonalprojection", "clearcolor", "clearenabled", "ambientcolor", "skylightcolor", "lightconfig", …
  // 现状：没有 fogdistance / fogheight / fog*color / fog*start / end / density
]);
```
`genericparticle` 的 `FOG` 缺省 1 被放行，理由是「渲染器不定义 `FOG_DIST` / `FOG_HEIGHT`」（`features.ts:1475`）。引擎 uniform 表里没有 `g_Fog*`。

**b. `GENERAL_FIELDS`**（`compile/bindings.ts:82`）
```ts
export const GENERAL_FIELDS = {
  clearcolor: { type: "vec3", fallback: [0, 0, 0] },
  …
  zoom: { type: "float", fallback: 1 },
  // 现状：没有雾的 14 个字段；`scriptApi.ts:81` 把它们列在 thisScene 的缺失表里
} as const satisfies Record<string, GeneralField>;
```

**c. `ADDITIVE` 没加**（`compile/writeState.ts:31`）
```ts
export function materialCombos(pass: Pick<MaterialPass, "blending" | "combos">): Record<string, number | boolean> {
  const combos = pass.combos ?? {};
  if (pass.blending !== "alphatocoverage") return combos; // 现状：additive 原样返回，WPE 会加 ADDITIVE = 1
  …
}
```

**d. 灯是编译期常量**（`compile/bundle.ts:1393`）
```ts
const sceneLights = () => {
  bundle.lights ??= {
    records: collectSceneLights(
      scene.objects,
      // 现状：灯字段绑属性登记重编译；origin 取本地值（挂父对象的灯由能力表报 object:parent）
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ),
    counts,
    quality: shadowQuality,
  };
};
```
渲染器每帧只按当时的 `g_ViewForward` 重排这些记录（`render/scene.ts:4714` 的 `frameLightValues`，P6d3 起过滤掉删掉的灯）。遗留灯的三个数组是材质常量（`legacyLightUniforms`，P13a）。

**e. 灯上的关键帧照报、字段脚本没有目标**
```ts
// compile/animations.ts:222
if (isRecord(object) && isLightObject(object)) {
  if (parsed) unsupported.add("value:animation:light"); // 现状
  return;
}
// compile/scripts.ts：targetOf 对 intensity 等落到 { kind: "unsupported", path }；运行时 script/runtime.ts:325 只 warn 一次，编译期不报
```
```ts
// compile/features.ts:857
if (kind === "light" && parent !== null) unsupported.add("object:parent"); // 现状
```

**f. 体积光按编译期定的可见性选灯**（`compile/volumetrics.ts:319`，`volumetricKind` 读 `visible` 与 `castvolumetrics` 的编译期值；常量在编译期写进各灯的 pass）。

## 语料

本节开始前在当前工作区跑的扫描（`ignore/p13/f/corpus-before.json`，233 张、干净 189），用法摘要 `ignore/p13/f/scene_usage.py`：

| 场景 | P13f 的键 | 用法 | 做完 P13f |
|---|---|---|---|
| `3115845558` | `general:fog*`（8 个，开关都是 false） | 雾全关、数值是缺省 | 干净 |
| `3706286085` | `general:fog*`（10 个）、`object:parent` | 距离雾、高度雾都开，颜色与终点绑属性；平行光 `SunLight` 的 `intensity` 挂按左键过渡的字段脚本、颜色绑属性、`visible` 上的脚本用 `getLayer('SunLight').angles` 转方向；点光 `BoostLight` 挂在模型 `RioSonic` 下、`intensity` 挂同样的脚本 | 干净 |
| `3465215190` | `value:animation:light` | 带阴影的体积光点光 `雷` 的 `intensity` 关键帧 | 还差 `model:passthrough:children:framebuffer` |
| `2515018199` | `value:animation:light` | 三盏遗留灯的 `origin` / `intensity` / `radius` 关键帧 | 还差 `lighting:prelighting` |
| `3453730450` | `object:parent` | 三盏体积光点光，两盏挂在 `origin` 挂脚本、`visible` 绑属性的父对象下 | 还差 P13h |
| `3455121165` | `object:parent` | 三盏灯挂在变换挂脚本的组下，`color` / `visible` 绑属性 | 还差聚光阴影 |
| `3662790108` | `object:parent` | 点光挂在组下，`intensity`、`scale` 挂字段脚本 | 还差缺失材质与 PRELIGHTING |

能渲染 189 → 191。另外 5 张的灯用法也走到新代码，作回归。

## 步骤 0 — 实测（Claude，实现之前）

**确定性工程**（`ignore/p13/f/gen_f0.py` → `ignore/p13/proj/p13f-*`，抓帧 `A:\p13f\<名>\`，常量 `kbp rdc consts --no-clock` → `ignore/p13/f/out/`）：

| # | 问题 | 工程 | 预测 |
|---|---|---|---|
| F1 | 四个 uniform 的打包、缺省 | `p13f-fog`：透视，`generic4` 地面 + 几个方块，距离雾、高度雾都开，值都不是缺省 | 按 2.2 打包，颜色原值 |
| F2 | 宏的条件 | 同工程：方块分别用 `FOG: 0`、不写 `FOG`、`generic2`（不声明 `FOG`）、`genericimage4` 图像层；另一个工程两个开关都关 | 只有组合表里 `FOG` 非 0 的上雾；开关关时都不上 |
| F3 | 运行中改开关 | `p13f-fog` 的 `fogdistance` 绑属性，`apply_properties` 改成 false | 画面不变（宏不变、uniform 照写） |
| F4 | 运行中改数值 | `fogdistanceend` 绑属性改值 | 下一帧 uniform 变，画面跟着变 |
| F5 | 正交场景 | `p13f-fog-ortho`：正交 1920×1080，`genericimage4` 图像层 | 距离按 `g_EyePosition`（z = 2000）算 |
| F6 | `ADDITIVE` | `p13f-fog` 加一个 `blending: additive` 的方块 | 雾颜色在 additive 下按着色器的 `#if ADDITIVE` 分支 |
| L1 | V1 与遗留灯的时序 | `p13f-light`：一盏 `lpoint` 与一盏 `point`，`intensity` 挂同一条关键帧，都挂在一个 `origin` 关键帧平移的模型下，`lightconfig { point: 1 }`；连续抓 5 帧 | V1 与关键帧同帧；遗留灯晚一帧；位置跟父对象 |
| L2 | 字段脚本、脚本对象 | 同工程：另一盏 `lpoint` 的 `radius` 挂字段脚本（返回随帧数变的值），一个图像层脚本每帧 `getLayer('灯').intensity = …`、读 `light`、`color`、`castshadow` 并打到日志 | 两种写入都进 uniform；记下读出的类型与值 |
| L3 | 超配排序 | `p13f-sort`：3 盏 `lpoint`、`lightconfig.point = 1`，一盏 `castshadow`，透视相机路径转动使另两盏的投影次序交换 | 留下的灯按 R2.3 换 |
| L4 | 体积光灯的可见性与位置在运行中变 | `p13f-vol`：两盏 `castvolumetrics` 点光之间夹一个立方体，中间那个立方体与第一盏灯的父对象 `visible` 绑属性，父对象 `origin` 关键帧平移 | 隐藏的灯不画、段随之合并 / 拆开；灯体跟父对象 |
| L5 | 灯挂在带骨骼的模型下 | 用 `p12-bones` 一类的工程加一盏子灯 | 位置是模型的 `W`，不跟骨骼 |

**语料**：`3706286085`、`3465215190` 的复制工程（`kbp content isolate`）作步骤 4 的走查，不在步骤 0 抓。

### 步骤 0 的结果（2026-11-15）

WPE 设置没动（反射关、阴影 low、体积光 low）。实际工程和上表有两处出入：F5 用 `generic4` 地面（`genericimage4` 只在 `FOG_COMPUTED` 下上雾，没有 PRELIGHTING 时不读雾）；L1 用 `lightconfig { point: 3 }`，另加 L2 的两盏灯。打印脚本 `ignore/p13/f/show_fog.py`、`show_lights.py`、`show_vol.py`，整帧比 `imgdiff.py`。

| # | 结果 |
|---|---|
| F1 | 成立：距离 (4, 14, 0.1, 0.7) = (start, end − start, startdensity, enddensity − startdensity)，高度 (2.5, −3, 0.05, 0.65)（end < start 时 `.y` 为负），颜色原值 |
| F2 | 成立：地面（不写 `FOG`，着色器缺省 1）、`FOG: 1`、additive 方块有四个雾 uniform；`FOG: 0`、`generic2` 没有；两个开关都关的工程里没有任何绘制带雾 uniform |
| F3 | 成立：运行中把 `fogdistance` 改成 false，着色器里距离雾 uniform 照写、整帧与改之前**逐像素相同** |
| F4 | 成立：改 `fogdistanceend` 为 9，下一次抓帧 `.y` = 5，整帧跟着变 |
| F5 | 成立：正交场景 `g_EyePosition` = (960, 540, 2000)，打包同上 |
| F6 | 抓到了（`CD`，additive + 雾），着色器的 `ADDITIVE` 分支留到实现后逐像素比 |
| L1 | 成立：挂在动的模型下的 `lpoint`，位置 = 本帧模型的世界平移 + 本地 (0, 1.5, 0)、强度 = 本帧关键帧值；遗留 `point` 的位置与强度都**等于上一帧**的值（5 帧逐帧对上，含关键帧循环回绕那一帧） |
| L2 | 成立：`radius` 的字段脚本第 n 帧返回 5 + 0.01n，uniform 当帧就是它；脚本 `getLayer('LS').intensity = …` 当帧生效，读回是 float32（1.0299999713897705）。灯的脚本对象：`light` 字符串（`lpoint`）、`color` / `controlpoint` / `origin` / `angles` / `scale` 是 Vec3、`castshadow` / `castvolumetrics` / `usecookie` / `visible` 布尔、其余数值、`name` 字符串，`alpha` / `brightness` 是 undefined |
| L2 | 排序键是**局部** origin：挂在父下的 LV 按本地 (0, 1.5, 0) 排在两盏 z = 2 的灯之后 |
| L3 | 成立，且和 P13d 已实现的 `lightFrame` 一致：`point: 2`、没有 `pointshadow` 时，带 `castshadow` 的 A 先写槽 0、又被后面 key 较小的普通灯覆盖，槽 1 空着；B 挪到相机前（key 变小）后留下的换成 B |
| L4 | 成立：隐藏夹在两盏灯之间的立方体后两段并成一段、只合成一次；隐藏 L1 的父对象后 L1 不画、也没有它那一段；挪动父对象后 L1 的 `g_RenderVar2` 位置 = 父 origin + 本地 (700, 300, 200) |
| L5 | 没抓，留给 `3706286085`（`BoostLight` 挂在 `RioSonic` 下）的走查 |
| F7 | 实现 P13f1 时补测（见下面「P13f1 实施记录」）：开雾时每个图像层与文本层都走合成 RT + passthrough 上屏，雾在上屏 pass 里算 |

## 点 1 — 雾（`compile/bindings.ts`、`compile/features.ts`、`compile/bundle.ts`、`render/scene.ts`）

- **修改** `GENERAL_FIELDS` 加 14 项，缺省照 2.1：
```ts
  fogdistance: { type: "bool", fallback: false },   // 新增：只在编译期定宏，运行中改只改状态（WPE 不重编，F3）
  fogheight: { type: "bool", fallback: false },
  fogdistancecolor: { type: "vec3", fallback: [0, 0, 0] },
  fogheightcolor: { type: "vec3", fallback: [0, 0, 0] },
  fogdistancestart: { type: "float", fallback: 1 },
  fogdistanceend: { type: "float", fallback: 5 },
  fogdistancestartdensity: { type: "float", fallback: 0 },
  fogdistanceenddensity: { type: "float", fallback: 1 },
  fogheightstart: { type: "float", fallback: 1 },
  fogheightend: { type: "float", fallback: -3 },
  fogheightstartdensity: { type: "float", fallback: 0 },
  fogheightenddensity: { type: "float", fallback: 1 },
```
- **新增** `compile/fog.ts`：`fogDefines(general, combos)`（开关与组合表里 `FOG` 非 0 → `FOG_DIST` / `FOG_HEIGHT`，组合表先并进着色器缺省，同翻译器的口径）与 `fogUniforms(values)`（四个 uniform，差值按 float32 减法）。
- **修改** `engineDefines` 的调用方：材质 pass 编译时把 `fogDefines` 并进去（只对组合表里有 `FOG` 的程序；passthrough 的 `FOG_COMPUTED` 不动）。
- **修改** 引擎 uniform 表加四个 `g_Fog*`；渲染器每帧从 `state.general` 打包（`frameBuiltins` 旁，`general` 目标写入时置 `lightsDirty` 同款的脏位）。
- **修改** `features.ts`：14 个键进 `PARSED_GENERAL`（不报）；`genericparticle` 的 `FOG` 注释改成「粒子的雾跟着宏走」，粒子光照路径仍报 `particle:lighting`。
- **修改** `writeState.ts` 的 `materialCombos`：`blending === "additive"` 时加 `ADDITIVE = 1`（先去掉大小写不同的同名键，同 A2C）；`p6d1-a2c` 的 C3 是对照。
- **删除** `scriptApi.ts` 缺失表里的 12 个 fog 字段（开关两个也删：脚本能读写，只是不改宏）。

## 点 2 — 灯的状态与写入（`compile/bindings.ts`、`compile/lights.ts`、`compile/scripts.ts`、`compile/animations.ts`、`render/state.ts`）

- **新增** 目标与字段表：
```ts
/** 灯对象自己的数值字段（rea-p13-lights 3.1）：都没有改值回调，逐帧读。颜色、变换、可见性是图层字段。 */
export const LIGHT_FIELDS = {
  intensity: { type: "float", fallback: 0 },
  radius: { type: "float", fallback: 1 },
  exponent: { type: "float", fallback: 2 },
  innercone: { type: "float", fallback: 20 },
  outercone: { type: "float", fallback: 30 },
  controlpoint: { type: "vec3", fallback: [2, 0, 0] },
  density: { type: "float", fallback: 2 },
  volumetricsexponent: { type: "float", fallback: 1 },
  cascadedistance0: { type: "float", fallback: 3 },
  cascadedistance1: { type: "float", fallback: 10 },
  cascadedistance2: { type: "float", fallback: 100 },
  lightsourcesize: { type: "float", fallback: 0 },
} as const;
// BindingTarget 新增
| { kind: "light"; object: number; field: LightField }
```
- **修改** `collectSceneLights` 改成两段：编译期 `compileSceneLights` 只收类型、`flags`（castshadow / usecookie）与各字段的初值（绑属性登记 `light` 目标，不再登记重编译）；渲染器每帧 `lightRecords(lights, state, worlds)` 组 `SceneLight`。`light`、`castshadow`、`usecookie`、`castvolumetrics` 绑属性 / 挂脚本 / 挂关键帧报 `light:runtime:<键>`。
- **修改** `SceneState`：`lights: Map<number, LightValues>`，`write` 认 `light` 目标（float 不收布尔，同图层标量；vec3 照向量 setter），写完置 `dirty.lights`。
- **修改** `targetOf`：灯对象顶层的 `objects/<i>/<LIGHT_FIELDS 之一>` 出 `light` 目标；`collectAnimations` 去掉灯的特判，走同一个 `targetOf`（相机的特判保留）。
- **修改** 脚本 API：灯对象的图层代理加 `LIGHT_FIELDS` 的成员（读写形状按 L2 的实测）。

## 点 3 — 每帧的灯（`render/lights.ts` 新文件，`render/scene.ts` 接线）

```ts
/**
 * 一帧的灯记录：世界矩阵与可见性沿父链（同图层，父是模型时取模型的 W），排序键用局部 origin（R2.3）。V1 用本帧（动画、脚本之后）的状态；
 * 遗留灯在 `GpuScene.update` 开头按上一帧末的状态算好留着（WPE 在动画与脚本之前写，L1）。
 */
export function lightRecords(lights: SceneLights, state: SceneState, worlds: Map<number, Mat4>): SceneLight[];
export function legacyLightFrame(lights: SceneLights, state: SceneState, worlds: Map<number, Mat4>): Record<string, number[]>;
```
- `frameLightValues` 改用 `lightRecords`；遗留灯的三个数组进每帧 uniform（`LEGACY_LIGHT_UNIFORMS` 从材质常量里拿掉）。
- 阴影：`ShadowAtlas.frame` 本来就每帧收条目，只是加载时按编译期条目定尺寸；改成加载时按「全部带阴影的灯都可见」定尺寸（够就不动的规则不变，步骤 0 的 L4 一并看图集）。

## 点 4 — 体积光读每帧的灯（`compile/volumetrics.ts`、`render/volumetrics.ts`）

- 编译期：每盏 `castvolumetrics` 的点光 / 聚光都建绘制（不看当时的可见性）；`VolumetricLight` 去掉编译期常量，只留对象下标、类型、`SHADOW` 变体与 pass。
- 渲染：每帧按 `lightRecords` 的可见性与 `castvolumetrics` 定哪些灯画、重新分段（不可见的非灯对象不打断一段，V5）；常量（`g_RenderVar1..4`、`g_AltViewProjectionMatrix`、`g_AltModelMatrix`）每帧写。
- 残留值配置（聚光超槽、带阴影的点光没分到阴影条目）的处理见待定 3。

## 点 5 — 能力表与文档

- 去掉：灯上的 `object:parent`、`value:animation:light`、`general:fog*`；新增 `light:runtime:<键>`。
- `cocs/wpe/WPE_SCENE.md`：「光照」一条补运行时；新增「雾」一条；README 摘要同步。
- 回归、changelog。

## 验收

- 步骤 0 的确定性工程各自和 WPE 逐像素 / 逐 uniform 比（雾逐像素；灯逐帧比 uniform 与整帧）。
- `3706286085`、`3465215190` 的复制工程按日志逐帧回放和 WPE 比（按 `FINAL_CHECK.md` 走查）。
- 语料 189 → 191，没有掉出；变异检查。

## 待定（2026-11-15 用户：「同意」，五条按推荐）

1. **拆两步**：推荐 P13f1 雾（+ `ADDITIVE`）、P13f2 灯的运行时，各自验收、各自提交。雾的改动小，马上解锁 `3115845558`；灯的运行时要动体积光与阴影。另一种是一起做。
2. **雾开关在运行中改**：F3 实测 WPE 画面逐像素不变。推荐照 WPE：宏只在加载时定，运行中改开关只改状态、不重编。另一种是开关绑属性时重编译（和 WPE 不同）。
3. **WPE 读残留值的体积光配置**（P13e 照报的 `volumetrics:*`）：灯的可见性变成运行时之后，「可见的聚光数超过聚光槽」「带阴影的点光没分到阴影条目」编译期判断不了。推荐：编译期按「全部可见」判断，能超就照报（语料 0 张）；另一种是运行时遇到就不画那盏灯。
4. **`light` / `castshadow` / `usecookie` / `castvolumetrics` 在运行中变**（WPE 释放并重建灯的阴影 / cookie 资源）：语料 0，推荐照报 `light:runtime:<键>`。
5. **灯的脚本对象成员**：语料只用到 `angles`（图层字段，已支持）与字段脚本。推荐按 L2 实测的形状把灯字段也挂到灯的脚本对象上（数值字段写入走同一个 setter、读回 float32；`light` 读出类型字符串，`castshadow` 等布尔只读出、写入照报，同待定 4），成本小。另一种是只做字段脚本，脚本对象上的灯字段照报。

## P13f1 实施记录（2026-11-15，雾 + `ADDITIVE`，未提交）

**实现中补测出的新事实 F7**（p13-REPORT「P13f 的实测」）：第一次对照透视雾工程整帧差 25 级，追下去是 WPE 在任一雾开关为真时给**每个**图像层与文本层置 passthrough 标志（p2-REPORT 记过「渲染标志 `0x1800000` 强制所有图层走 passthrough」，`0x1800000` 就是两个雾开关），全部走「基础 pass → 合成 RT → passthrough 上屏」，雾在上屏 pass 里算。补了 `p13f-fog-ptc`（粒子）、`p13f-fog-img`（各种图像层与文本层）、`p13f-fog-fs` / `-off`（组合层、全屏层，3706286085 的 12 个图像层都是 `fullscreenlayer`）三组工程实测：
- 上屏 pass 的 `FOG_COMPUTED`：图像层取基础材质最终的 `FOG`（`FOG: 0`、不声明 `FOG` 的着色器都不上雾）；文本层是 1（`font` 不声明 `FOG` 也上雾）。
- 带子层的组、形状层、puppet 没测（语料 0），照报 `fog:<种类>`。

**改动**
- 翻译器（`src-tauri/wpesl2wgsl`）：请求加 `fogDefines`，最终组合表里 `FOG` 非 0 才并进（单测 `fog_defines_follow_final_fog_combo`）；README；wasm 重编并拷进宿主源码目录。
- `compile/bindings.ts`：`GENERAL_FIELDS` 加雾的 14 个字段（属性、关键帧、字段脚本、`thisScene.fog*` 都走已有的 general 目标）；`compile/scriptApi.ts` 缺失表删掉它们。
- 新文件 `compile/fog.ts`：`fogDefines`、`fogUniforms`（float32 减法）、`FOG_UNIFORMS`、`isFogUniformField`。
- `compile/shader.ts`：`ShaderCompiler` 收 `fogDefines`，不开雾时请求不带这个键。
- `compile/bundle.ts`：`fogForced`（加载时的开关）；`SceneLayer.fogPassthrough`（图像层与文本层，组 / 形状 / puppet 照报）；passthrough 上屏挪到文本编译之后，`passthroughCombos(cbm, fogComputed)` 与 `programFog`；开雾的图层带光照照报 `lighting:prelighting`（同 effect）；开雾又有体积光照报 `volumetrics:fog`（`volumetricsfront` 读雾 uniform，体积光的 uniform 没接雾）。
- `compile/features.ts`：雾字段进 `PARSED_GENERAL`、四个雾 uniform 进 `ENGINE_UNIFORMS`；粒子组合键白名单加 `ADDITIVE`。
- `compile/writeState.ts`：additive 加 `ADDITIVE = 1`（`ADDITIVE_COMBO`）。
- `render/uniforms.ts`、`render/scene.ts`、`render/state.ts`：四个雾 uniform 进 `staticBuiltins`（图层、文本、粒子共用），雾的数值字段写入置灯光脏位，`refreshLights` 一并刷新。
- `render/graph.ts`：`fogPassthrough` 并进合成路径的条件。

**中途的误报**（用户发现）：加 `ADDITIVE` 后 additive 粒子报 `particle:combo:ADDITIVE`（如 `3347978935`、`3354830590`）：粒子组合键白名单只放行了 `ALPHATOCOVERAGE`。WPE 加载时同样给它们加这个键，粒子着色器与这两张的工坊着色器都不读，以前的画面没有问题；白名单加 `ADDITIVE`，单测记这两张。

**对 WPE**（`render_scene`，画布 1920×1080；掩掉 FR / CLK）

| 工程 | 差异像素 | 最大差 |
|---|---|---|
| `p13f-fog`（`p_fe` 18） | 11 | 1 |
| `p13f-fog-off` | 0 | 0 |
| `p13f-fog-ortho` | 12 | 1 |
| `p13f-fog-ptc`（粒子回放 10 帧） | 10 | 1 |
| `p13f-fog-img` | 3 | 1 |
| `p13f-fog-fs` | 1 | 1 |
| `p13f-fog-fs-off` | 0 | 0 |

**语料**（`ignore/p13/f/corpus-f1.json` 对 `corpus-before.json`）：189 → 190（`3115845558`），没有新增键、没有掉出；`3706286085` 只剩 `object:parent`（P13f2）。

**测试**：`compile/p13f-fog.test.ts` 13 例（含真翻译器编 5 个确定性工程），`render/p8.test.ts` 加「开雾强制 passthrough」的计划用例，`render/rebuild.test.ts` 加「雾的数值字段」就地 = 重编译；改了 `p2a`、`p8`、`scriptApi`、`script/api` 里拿雾当「没实现」例子的断言。变异检查 15 / 15（`ignore/p13/f/mut/mutations.py`）。整批 `src/compile` + `src/render` 的 6 个失败都与本节无关：`scriptApi` 的 `3304642534` 两例来自别的会话的 `sortLayer`；`mdl` / `puppet` 单独跑通过（整批时超时）；`p3a` 的语料用例跑满 600 s 超时；`pipeline` 的上限超标里四条 HEAD 快照（`18dc5475`）上就有，多出的「`3570755196` 单字节探测」来自别的会话 P6d3b 的 `SceneFs.existsInAssets`。

## P13f2 实施记录（2026-11-16，灯的运行时）

**改动**
- `compile/bindings.ts`：`LIGHT_FIELDS`（12 个数值字段与构造缺省）、`lightFieldValue`（float32）、目标 `{ kind: "light" }`。
- `compile/lights.ts`：`SceneLightObject` / `compileLightObjects`（类型、遗留槽、开关、数值字段初值，静态字段挂属性 / 脚本 / 关键帧照报 `light:runtime:*`）、`sceneLightOf`（世界矩阵、`sortOrigin`）、`legacyLightFrame`；`collectSceneLights` / `legacyLightUniforms` 保留成按 JSON 算的测试入口；`sortLights` 用局部 origin。
- 新文件 `render/lights.ts`：`lightRecords` / `legacyLightInputs`（世界矩阵与可见性沿父链）。
- `compile/bundle.ts`：`bundle.lightObjects`、`bundle.legacyLights`，`bundle.lights` 只剩计数与档位；灯字段不再登记重编译；遗留灯三个数组不进材质常量；选灯的阴影档在有 `castshadow` 的 V1 灯时照样解析（L3 补出的 P13d 缺陷，见 p13-REPORT）；体积光改用灯对象。
- `compile/layerShell.ts`：灯对象的 `color` 缺省黑。
- `compile/volumetrics.ts`：`volumetricGeometry`（几何与常量，位置与聚光方向取世界矩阵）；`castvolumetrics` 的点光 / 聚光都编，不看可见性；残留值照报按全部可见判。
- `render/scene.ts`：`frameLightValues` 每帧按状态组记录；遗留灯按上一帧末的状态写（按帧时刻换代）；阴影图集按加载时的记录建；体积光按可见性分段、每帧按状态算几何。`render/shadows.ts`、`render/volumetrics.ts` 跟着改接口。
- `render/state.ts`：`SceneState.lights` 与写入；`script/stateWrite.ts`、`script/runtime.ts`、`host.ts` 认新目标。
- `compile/scripts.ts`：`targetOf` 给灯字段出目标、`targetValueType`；`compile/animations.ts` 去掉灯对象的特判（`value:animation:light` 不再报）。
- `script/api.ts`：`installLight`（12 个数值字段可读写，`light` 与三个开关只读、写入告警一次）。
- `compile/features.ts`：灯挂父对象不再报 `object:parent`。

**对 WPE**：`p13f-light` 按 WPE 日志回放第 153 帧，灯光数组与遗留灯数组最大差 2e-6（日志只记 6 位小数）；`p13f-vol` 四种状态 0 差异；`p13f-sort` 两种状态各 2 个像素 1 级（修 L3 之前差 82 级）。

**语料**（`corpus-f2.json` 对 `corpus-f1.json`）：灯的 `object:parent` 4 张、`value:animation:light` 2 张全部去掉，`3706286085` 变干净；`3455121165` 多 `volumetrics:transparentsorting`（太阳灯可见性绑属性，现在运行时可见就会画体积光；这张本来就因聚光阴影不能渲染）。同期别的会话的 `createLayer` 解锁 4 张，不归本节。

**测试**：新 `render/p13f-lights.test.ts` 8 例；`compile/lights.test.ts` 按新模型改写编译用例、加 L3；`compile/p13e.test.ts`、`compile/animations.test.ts` 按新规则改期望；`render/rebuild.test.ts` 加「遗留灯晚一帧」；`render/p13e-volumetrics.test.ts` 加 `frame` 逐帧常量。变异 13 / 13（`ignore/p13/f/mut/mutations-f2.py`）。

**还没做**：回归 LR4 真机预览；`3465215190` 的走查（`3706286085` 的见下一节）。

## 走查：`3706286085`（2026-11-16，按 `FINAL_CHECK.md`）

**复制工程**（`ignore/p13/f/walk/make_iso.py` → `ignore/p13/f/walk/proj/3706286085-iso-p13f`）：
- 留：雾（距离 + 高度）、方向光阴影、`SunLight` 的强度脚本（按左键过渡）与转方向脚本、挂在 `RioSonic` 下的 `BoostLight` 及其强度脚本、按光标移动 `RioSonic` 的 `SonicRunCodeBase`、`Camera_0` 与跟随支架；
- 换成固定值：`RioSonic` 五个动画层的 rate / blend、`FBX_Stage` 的层 rate 与 scale、`Sky` 的旋转脚本、`BoostModel` 材质里挂脚本的常量；
- 去：粒子、声音、全屏后处理层、默认不可见的相机。

**录制**：WPE 1920×1080、fps 20，`input_start` 按时间线喂光标与左键（`ignore/p13/f/walk/timeline.json`：40 段、每段 12 帧，段间光标 x 不同，按住时 y 换成 0.56，从日志的光标就能逐帧对齐、还原左键），抓 24 帧 `A:\p13f\walk3706\`（脚本帧 379–402：381 按下沿、393 松开沿）。回放按 `[kbp]` 日志与 `buttons.json`，探针打出的 `[kbp]` 行与 WPE 逐字相同。

**结果**（`ignore/p13/f/walk/cmp/frames.txt`，uniform 对照 `pair_globals.py`，18 帧 379–396）：
- **P13f 的 uniform 逐位相同**：雾的四个常量、`g_LDirectional_Color`（按下 / 松开的过渡 3.34 → 2.81 → 2.8 … → 3.33 → 3.34）与方向、`g_LPoint_Color` / `g_LPoint_Origin`（L5：灯挂在随光标移动的模型下，成立）、环境光与天光；方向光的阴影投影在奇数帧逐位相同。
- **389 帧整帧只剩 53 个像素 ≤ 2**：相机与城市骨骼恰好都逐位相同的一帧，雾、灯、阴影的像素都对。
- **其余帧的差，不在 P13f**：
  - 城市骨骼 K2（P12b2 已知差异）：每帧同样 6 个平移分量差 0.02–0.04，城市边缘亚像素差；389 帧逐位相同（`city_bones.py`）。
  - **偶数帧相机滞后（有意不同）**：奇数帧视点与 VP 逐位相同；偶数帧不同（视点差 0.003–0.006，`eye_lag.py`、`vp_lag.py`）。P5 会话查清是 WPE 的世界矩阵缓存戳（规则同 `render/worldStamps.ts`）：相机自己不被画、只在帧开头（脚本之前）求一次；支架每帧被脚本写、又在脚本之后被画一次重算，两者的戳会落在同一个帧号上，下一帧开头相机「戳 ≥ 父戳」判命中，返回上一次算的整份矩阵，所以相机每两帧刷新一次。核对：奇数帧 WPE 视点 = 第 f−1 帧末的支架 + 抖动，偶数帧 = 第 f−2 帧末的支架 + 抖动，380–396 帧 6 位小数全同（P5 的 `p13cam/lag.py`）。我的 `stamp_sim.py` 漏了「相机只在帧开头求、支架在脚本之后被画」这一点。触发条件：相机父链上有对象每帧被脚本 / 关键帧移动且每帧被画。2026-11-16 用户定：不修，记为有意不同（WPE 缺陷，效果是镜头半帧率顿挫，语料画面不依赖）。
  - 支架是退化网格（108 个索引都指向同一个顶点），我们在阴影 pass 发了 3 个空 draw、WPE 剔掉了，无像素影响。

**判定**：通过。P13f 的 uniform 逐位相同，389 帧整帧几乎 0 差；其余差异都已解释：城市骨骼 K2（已知差异）、偶数帧相机滞后（有意不同）、退化网格的空 draw（无像素影响）。测试行 15336（`ignore/p13/f/walk/manifest.json`）还在库里。`3465215190` 的复制工程还没走。
