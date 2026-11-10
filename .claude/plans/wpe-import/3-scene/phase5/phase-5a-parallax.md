# P5a — 视差、抖动与缩放（子计划）

> 上级：[phase-5-camera-mesh.md](phase-5-camera-mesh.md)「P5a」与「前置」。读码见 [rea-p5-camera](rea-p5-camera.md) 5、6 节与 p3-script-REPORT L2（`zoom`），都没有实测。
> 语料是 P4c 收尾的扫描（`ignore/p4/c5/out/corpus-wsc.json`，152 个工程，能渲染 22 张）。现状锚点取自 `9d38c0f8` 之后的工作区；P4d 在别的会话进行，实现步骤动工前再核对一次共享文件。
> 分五步：步骤 0 只调研；步骤 1 是总计划的「前置」；步骤 2–4 每步能单独验收、单独提交。

## 总体设计思路

视差、抖动和缩放都只改相机，不碰几何，所以 P5a 不新增图层种类，只在每帧的相机求值和每次绘制的矩阵上加东西。

**视差分两半。** 一半是每帧一次的「视差点」P：它由指针、`mouseinfluence` 在场景中心和指针之间插值，再按 `delay` 做一阶平滑，同时写出 `g_ParallaxPosition`。另一半在绘制时：每个对象找到自己的根对象，按根的 `origin` 和 `parallaxDepth` 算出平移 `o = amount · depth ⊙ (origin.xy − P)`，把它乘到这次绘制的视图矩阵上。图像层、粒子、带 effect 的图层上屏都一样处理。P 和 `o` 都只依赖每帧已有的量，所以渲染器只要在帧开头、脚本之前算一次 P，绘制时按对象查表。

**抖动是确定性的正弦，缩放是投影上的一个比例。** 抖动按 `g_Time` 算出一个偏移，加到 eye 和 center 上，正交场景里等于整个画面平移。`zoom` 在正交投影上绕场景中心缩放。这两项都和 P4 的确定性回放天然兼容：给定 `g_Time` 就能复现。

**指针沿用 `g_PointerPosition` 的来源。** WPE 的视差点直接用窗口归一化的指针乘场景宽高，和 `g_PointerPosition` 同源，不是 P4c 控制点用的反投影。所以渲染器把已经按壁纸样式换算好的 `g_PointerPosition` 交给视差，`fill` 下就是 WPE 的行为，`fit` / `center` 下光标仍落在画面上。

**属性与脚本走已有通路。** `cameraparallax*` 和 `camerashake*` 已经在 P3c 的 general 字段表里，现在只存值；P5a 让渲染器每帧从 `SceneState` 读它们，属性和脚本写入就地生效。`parallaxDepth` 要补进图层字段：绑用户属性就地更新，挂 `{script}` 的字段脚本写回到它，`thisLayer.parallaxDepth` 从脚本 API 缺口表里删掉。

关键决策：读码已经给出公式，步骤 0 不再大规模读码，而是用确定性工程把每条公式和 WPE 对上。有两条和直觉不同，先测：静止时原点不在中心的层也有偏移；只用根对象的深度。抓帧时不移动用户的鼠标，指针从 CLK 层记下的 `g_PointerPosition` 读，回放时照样喂给我们这边。

## 范围与解锁

| 步骤 | 内容 | 累计能渲染 |
|---|---|---|
| 1 前置 | `cropoffset`、对象 `config` 中性；translucent / additive 或 `depthtest: disabled` 的 pass 上 `depthwrite` 中性；模型 JSON 布尔键只认 `true`；`parseWpeJson` 认 `//` 注释 | 22 → 23 |
| 2 视差 | 视差点与平滑、`g_ParallaxPosition`、对象平移；`parallaxDepth` 的属性与脚本；脚本写 `cameraparallax*` 生效 | 34 |
| 3 抖动 | `camerashake*` | 35 |
| 4 缩放 | 正交 `zoom`（含相机 zoom 的乘积） | 35 |

解锁明细：
- 步骤 1：`3778549173`。
- 步骤 2：`2272499163`、`2279259068`、`2381978484`、`2382002554`、`2382120706`、`2382121137`、`2570822804`、`2955749185`、`3000769374`、`3445915391`、`3818481122`。
  - 前 10 张来自同一类模板：1–2 个图像层，其中一个带 effect，`parallaxDepth` 是 `0 1` 或 `0 2`，只在纵向动；图层原点都在场景中心，静止时没有偏移。
  - `3818481122` 的唯一图层深度为 `0 0`，不动，但它的 `depthparallax` effect 读 `g_ParallaxPosition`。
- 步骤 3：`3830255100`。它有 14 个图像层和 3 个粒子，原点偏离中心几百像素、深度 0.44–1.87，是检验「静止偏移」的真实样本。
- 步骤 4 不单独解锁：`zoom ≠ 1` 的 6 张还被别的键挡着。`2887099508` 的 `zoom` 是关键帧（PLAN K），`3253330537` 的绑了用户属性。

语料里 P5a 相关的写法（`ignore/p5/a0/out/scan_a.txt`）：
- `cameraparallax` 开 41 张，其中 9 张绑用户属性；`amount`、`delay`、`mouseinfluence` 各有 1–4 张绑属性。
- `mouseinfluence` 有负值：−2、−0.21、−0.22。`delay` 最大 2.0。
- `parallaxDepth` 绑用户属性 65 处（最多的是 `hudparallax` 0.01），挂 `{script}` 10 处（2582765611、2896608544）。
- `camerashake` 开 9 张，其中 2 张绑属性；`roughness` 有 0.1、0.05 两个小值。

**P5a 不做：**
- 透视场景的视差（语料 0 张）。透视场景开视差时 WPE 不移动对象，这一点照读码实现。
- 命中测试的视差偏移：WPE 按对象自身而不是根对象算，归 W4 的按图层命中。
- 壁纸属性 `cameraparallax`（WPE 设置里给单张壁纸的开关，只把 `mouseinfluence` 归零）：Kabegame 没有这个开关，按缺省（开）处理。

## 现状锚点

**a. 视差、抖动、缩放整张退回**（`compile/features.ts:264`）
```ts
  if (!g.orthogonalprojection) unsupported.add("camera:perspective");
  for (const key of ["cameraparallax", "camerashake", "supportsaudioprocessing"])
    if (active(g[key])) unsupported.add(`general:${key}`); // 现状：打开就退回
  if (g.zoom !== undefined && g.zoom !== 1) unsupported.add("general:zoom");
```

**b. 对象的 `parallaxDepth` 当中性键放行**（`compile/features.ts:165`）
```ts
 * - `parallaxDepth`：只在 `general.cameraparallax` 打开时起作用，那时已报 `general:cameraparallax`。
// 现状：注释与读码一致；缺省值 (1, 1) 还没写进任何地方
```

**c. general 字段只存值**（`compile/bindings.ts:40` 起）
```ts
export const GENERAL_FIELDS = {
  // …
  camerashake: { type: "bool", fallback: false },
  camerashakespeed: { type: "float", fallback: 3 },
  // …
  cameraparallax: { type: "bool", fallback: false },
  cameraparallaxamount: { type: "float", fallback: 0.5 },
  cameraparallaxdelay: { type: "float", fallback: 0.1 },
  cameraparallaxmouseinfluence: { type: "float", fallback: 0.5 },
}; // 现状：属性与脚本写入只落进 SceneState，渲染器不读（3c 已定 13、14）
```

**d. 字段脚本只认这几个图层字段**（`compile/scripts.ts:36`）
```ts
const layerTypes: Record<string, ValueType> = {
  origin: "vec3",
  scale: "vec3",
  angles: "angles",
  alpha: "float",
  color: "vec3",
  brightness: "float",
  visible: "bool",
}; // 现状：没有 parallaxDepth，挂在它上面的 {script} 目标是 unsupported
```

**e. 绘制矩阵只用一个场景 VP**（`render/uniforms.ts:272`）
```ts
export function drawMatrices(step: Pick<DrawStep, "role">, world: Mat4, size: readonly number[], viewProjection: Mat4) {
  const model = world;
  const layerMvp = multiply(viewProjection, model); // 现状：每个图层同一个 VP，没有逐对象的视图平移
```

**f. `g_PointerPosition` 按样式换算**（`render/layout.ts:297`）
```ts
export function scenePointer(style, placement, canvasWidth, canvasHeight, x, y): [number, number] {
  if (style === "fill" || style === "stretch") return [x, y]; // 现状：WPE 的窗口归一化坐标
  return sceneCursor(style, placement, canvasWidth, canvasHeight, x, y);
}
```

## 步骤 0 — 调研

读码已经够实现（rea-p5-camera 5、6），步骤 0 的主体是实测。读码只补两处，Claude 自己查，不另派代理：
- **图层合成路径上的视差：** `0x1401ed27f` 起把保存的 `obj+0x178` 乘到 V 上。确认带 effect 图层的 effect pass 和末 pass 各用哪个矩阵。
- **`parallaxDepth` 的绑定：** p3-script-REPORT I3 的对象字段表里，`parallaxDepth` 是不是就地字段，运行中改属性会不会重算。

### 0a — 语料（Claude，已做）

`ignore/p5/a0/scan_a.py`，结果在 `ignore/p5/a0/out/scan_a.txt`，结论见上「范围与解锁」。脚本源码里的读写另由 `scan_scripts.py` 扫（`out/scan_scripts.txt`），结论见报告。

### 0b — 确定性工程与实测（Claude）

工具：`wpe-renderdoc` MCP 抓帧与回放（`capture_wallpaper` / `capture_sweep`，抓帧放 `A:\p5a\<用途>\`）。工程生成器在 `ignore/p5/a0/` 新写，沿用 `ignore/p4/gen_c.py` 的 CLK 层，CLK 着色器另读 `g_ParallaxPosition`。每个对象的 MVP 平移从回放的常量缓冲读，指针从 CLK 层读。

| 工程 | 构造 | 核对 |
|---|---|---|
| `p5a-static` | 正交 1920×1080，`mouseinfluence 0`（P 恒为场景中心，和指针无关），`delay 0`，`amount 0.5`；方块原点 (960, 540) 深度 (1, 1)、(1460, 540) (1, 1)、(460, 540) (−0.7, −0.7)、(960, 840) (0, 1)，一个不写 `parallaxDepth` 的方块，一个父分组（深度 (1, 1)）下挂深度 (0, 0) 的子方块 | 静止偏移的公式与符号；缺省深度 (1, 1)；只看根对象 |
| `p5a-ptr` | 同上，`mouseinfluence` 分别取 1、0.5、−2 | 指针换算、钳制与 y 翻转、插值；`g_ParallaxPosition` |
| `p5a-delay` | `mouseinfluence 1`，`delay` 取 0.3、2.0；开窗后连续抓前若干帧，固定 fps 30 / 60 | 开场从中心滑向指针的过渡与平滑系数 k |
| `p5a-kinds` | 带 effect 的图层、粒子（含一个跟随指针的控制点）、子图层各一个 | 合成路径、粒子绘制的平移；跟随指针的控制点不含视差 |
| `p5a-shake` | `camerashake` 开，`speed` / `amplitude` / `roughness` 取几组，含 `roughness` 0.1、0.05 | 按 `g_Time` 复算偏移 |
| `p5a-zoom` | `zoom` 1.5、0.8；`zoom` 加视差 | 绕中心缩放；缩放与视差、指针的关系 |
| `p5a-pre` | 带 `//` 注释的材质；translucent 且 `depthwrite: enabled` 的 pass；模型 JSON 写 `cropoffset "100 100"`、对象写 `config`；模型 JSON 的布尔键写成 `1` | 前置的几条：注释能否加载、深度写掩码（回放读管线状态）、`cropoffset` 与 `config` 不改画面、布尔键写 `1` 不生效 |

指针：开窗时光标在哪里就是哪里，不移动用户的鼠标。光标若在窗口外，WPE 的指针超出 0…1，视差钳到边上，正好核对钳制。`p5a-static` 与指针无关，作为基准。

真实样本：抓 `2381978484`（模板）、`3445915391`、`3818481122`、`3830255100`，读各图层的 MVP 平移和 `g_ParallaxPosition`（`3818481122` 的 effect 读它），用记下的指针复算。

**验收：** 每条公式都有工程对上，或者写明被推翻的地方和改正后的公式；结论写进 [p5-REPORT.md](p5-REPORT.md)（新建，格式照 `p4-particles-REPORT.md`）；对步骤 1–4 的影响写进本文件的实施记录。

### 步骤 0 实施记录（2026-11-10）

结论全在 [p5-REPORT.md](p5-REPORT.md)「P5a 语义的实测核对」：读码的公式全部成立，没有被推翻的。16 个确定性工程加 4 张真实样本，图层偏移的误差都是 0，只有一张真实样本最大 0.12 像素，原因是那一帧平滑还没收敛。两处读码没写清的，实测补上了：
- `roughness` 的临界比较要按 float32 算；
- 视差点 P 本身不钳制，只有 `g_ParallaxPosition` 钳到 0…1。

读码只补的两处：
- 合成路径：上屏那一下乘偏移，画进合成 RT 的基础 pass 不乘，抓帧直接看到了，不用再读码。
- `parallaxDepth` 的绑定：I3 记「只改字段、没有回调」，视差每次绘制都重读，所以就地生效。

**对各步的影响：**
- **步骤 1（前置）：** 五条全部实测成立，按总计划做。
  - `parseWpeJson` 认 `//` 注释；
  - `depthwrite` 在 translucent / additive 或 `depthtest: disabled` 时中性；
  - `cropoffset`、`config` 中性；
  - 模型 JSON 的布尔键只认 `true`。
- **步骤 2（视差）：**
  - P 和 `g_ParallaxPosition` 分开存：P 不钳制，uniform 钳制。
  - 平滑用本帧的 dt，k 钳到 1，被钳过的帧时钟同样照用。
  - P 的初值是场景中心，加载时 `g_ParallaxPosition` 写 (0.5, 0.5)。
  - 偏移按根对象的 `origin` 字段（脚本、属性写回后的当前值）和深度算，缺省深度 (1, 1)。
  - 偏移只作用在绘制上：上屏 draw 与粒子 draw 乘，画进合成 RT 的 pass 不乘，粒子模拟和控制点的反投影也不乘。
  - 场景比例和画布不同时，P 用场景宽高；`fill` 下指针就是画布归一化坐标，和 WPE 相同。
- **步骤 3（抖动）：**
  - 偏移按 float32 算 `roughness³` 与阈值比较；
  - 偏移同时加到 eye（`g_EyePosition` 跟着变）和视差点上，图层整体平移 −偏移；
  - 时间用本帧 `g_Time`。
- **步骤 4（缩放）：** 绕场景中心缩放；视差偏移在缩放之前、按场景单位加。
- **给 P5b、P5d：** 正交 2D 场景也绑着深度目标（GREATER、`front_ccw`）；普通绘制的颜色写掩码是 7，不写 alpha。

**工具（留给步骤 2–4 的回放核对）：**
- 工程：`ignore/p5/a0/gen_a.py`。
- 导出：`rdc_dump.py`，在 `qrenderdoc --python` 下无界面跑，一次导出整批抓帧的常量。
- 核对：`ana_a.py`、`ana_pre.py`、`ana_real.py`。
- 抓帧：`A:\p5a\*`。

## 步骤 1 — 前置：能力表修正

### 思路

五条都由步骤 0 实测定论（p5-REPORT「P5a 语义的实测核对」最后五行），都是能力表和 JSON 读取的小改动，渲染器不动：
- **注释**：WPE 读 JSON 用 jsoncpp，缺省允许注释；`parseWpeJson` 严格解析失败时，先去掉注释再去尾逗号。
- **两个中性键**：`cropoffset` 是编辑器写的偏移，导入时已经加进了 `origin`；对象 `config` 只在托盘与播放列表代码里读。两者都放行。
- **深度写入**：translucent / additive 的 pass 一律不写深度，`depthtest: disabled` 也连带不写。这两种情况下 `depthwrite: enabled` 不改变画面，不报。其余情况照报，留给 P5d。
- **布尔键**：模型 JSON 的布尔键只认 JSON `true`。能力表和 `bundle.ts` 读 `solidlayer` 的地方用同一个判断，语料里这些键全写成 `true`（`ignore/p5/s1/scan_bool.py`），收紧后结果不变。

### 现状锚点

**a. 宽松 JSON 只去尾逗号**（`compile/model.ts:97`）
```ts
export function parseWpeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const relaxed = text.replace(
      /("(?:\\[\s\S]|[^"\\])*")|,(\s*[\]}])/g,
      (match, string: string | undefined, end) => string ?? end,
    ); // 现状：不认 `//`、`/* */` 注释，fantasticcar 的 materials/car/glass.json 解析失败、整张编译抛错
```

**b. 对象 `config`、模型 `cropoffset` 落进未知键**（`compile/features.ts:169`、`:210`、`:436`）
```ts
const SUPPORTED_OBJECT = new Set([/* … */ "parallaxDepth"]); // 现状：没有 config，报 object:config（14 张）
const SUPPORTED_MODEL = new Set(["material", "width", "height", "autosize", "solidlayer"]); // 现状：没有 cropoffset
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const key of ["puppet", "fullscreen", "passthrough"]) if (active(model[key])) unsupported.add(`model:${key}`);
  for (const [key, value] of Object.entries(model))
    if (!SUPPORTED_MODEL.has(key) && !["puppet", "fullscreen", "passthrough"].includes(key) && active(value))
      unsupported.add(`model:${key}`); // 现状：active() 把 1、"true"、"0 0" 都当真
```

**c. `depthwrite` 不看混合模式**（`compile/features.ts:458`）
```ts
  if (pass.depthwrite && pass.depthwrite !== "disabled") unsupported.add(`depthwrite:${pass.depthwrite}`);
  // 现状：translucent、depthtest disabled 的 pass 写 enabled 也报，3778549173 只差这一个
```

**d. `solidLayer` 按真值判断**（`compile/bundle.ts:1024`）
```ts
    layer.solidLayer = !!model.solidlayer && !model.instanced; // 现状：写成 1 也算
```

### 点 1 — 注释（`compile/model.ts`）
- **修改** `parseWpeJson`：严格解析失败时，先去 `//` 行注释与 `/* */` 块注释，再去尾逗号；字符串里的内容都不动。
  > 说明：`//` 已实测；`/* */` 是 jsoncpp 同一个开关，推断，语料 0 处。

```ts
// 字符串（第一组）原样保留，其余匹配到的注释删掉
const JSON_COMMENT = /("(?:\\[\s\S]|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const JSON_TRAILING_COMMA = /("(?:\\[\s\S]|[^"\\])*")|,(\s*[\]}])/g;

export function parseWpeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const relaxed = text
      .replace(JSON_COMMENT, (_match, string: string | undefined) => string ?? "") // 新增：先去注释
      .replace(JSON_TRAILING_COMMA, (_match, string: string | undefined, end: string | undefined) => string ?? end ?? "");
    if (relaxed === text) throw error;
    // 以下不变
```

### 点 2 — 能力表（`compile/features.ts`）
- **修改** `SUPPORTED_OBJECT` 加 `config`，`SUPPORTED_MODEL` 加 `cropoffset`，注释写明依据。
- **新增** `MODEL_FLAGS` 与导出的 `modelFlag(model, key)`：布尔键只认 `=== true`。
- **修改** `checkModelFeatures`：合成一个循环，布尔键用 `modelFlag`，其余（`puppet` 是路径字符串）仍用 `active()`；报出的键名不变。
- **修改** `checkPassFeatures` 的 `depthwrite`：只在这个 pass 真会写深度时报。

```ts
/**
 * 模型 JSON 的布尔键（`FUN_1401fac50`，rea-p5-modelflags §7）：WPE 只认 JSON 的 `true`，写成 1、字符串等于没写
 * （P5a 步骤 0 实测 `fullscreen: 1` 不生效）。
 */
const MODEL_FLAGS = new Set(["fullscreen", "nopadding", "autosize", "passthrough", "solidlayer", "projectlayer", "instanced"]);
export function modelFlag(model: ModelJson, key: string): boolean {
  return model[key] === true;
}

export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const [key, value] of Object.entries(model)) {
    if (SUPPORTED_MODEL.has(key)) continue;
    if (MODEL_FLAGS.has(key) ? value === true : active(value)) unsupported.add(`model:${key}`);
  }
  scanValue(model, unsupported);
}

/**
 * 这个 pass 会不会写深度（`FUN_140099f60`，rea-p5-mesh 3.4，P5a 步骤 0 实测）：translucent / additive 一律不写，
 * `depthtest: disabled` 也不写。缺 `depthtest` 时 WPE 按 enabled（P5d 再改缺省），这里照 WPE 当作会写。
 */
function writesDepth(pass: MaterialPass): boolean {
  const blending = pass.blending ?? "normal";
  return pass.depthtest !== "disabled" && (blending === "normal" || blending === "alphatocoverage");
}
// checkPassFeatures 里：
  if (pass.depthwrite && pass.depthwrite !== "disabled" && writesDepth(pass))
    unsupported.add(`depthwrite:${pass.depthwrite}`);
```

### 点 3 — `bundle.ts` 读布尔键
- **修改** `layer.solidLayer = modelFlag(model, "solidlayer") && !modelFlag(model, "instanced")`。

### 点 4 — 单测（新增 `compile/p5a.test.ts`）
- `parseWpeJson`：`//` 行注释、`/* */` 块注释、字符串里的 `//`（如 `"http://x"`）原样保留、注释后紧跟尾逗号。
- `checkModelFeatures`：`cropoffset` 不报；`fullscreen: 1`、`nopadding: "true"` 不报，`fullscreen: true` 报 `model:fullscreen`。
- `checkObjectFeatures`：`config: {passthrough: true}` 不报。
- `checkPassFeatures` 的 `depthwrite: enabled`：translucent、additive、normal 加 `depthtest: disabled` 都不报；normal 加 `depthtest: enabled`、normal 缺 `depthtest` 报 `depthwrite:enabled`。

### 验收
- `apps/wpe-scene` 的 vitest（`KABEGAME_WPE_ROOT` 指向 WPE）、tsc、Prettier 通过。
- **语料**（`ignore/p5/s1/corpus.test.ts`，HEAD 导出 `ignore/p5/s1/head/src` 对工作区）：
  - 只少 `model:cropoffset`、`object:config` 和一部分 `depthwrite:enabled`，不新增键，没有编译出错；
  - 少掉 `depthwrite:enabled` 的场景，逐张核对它的 pass 都属于中性情况；
  - 能渲染 23 → 24，新解锁 `3778549173`。
- **`3778549173` 和 WPE 比画面**：WPE 抓帧用 `wpe-renderdoc` MCP，整帧与粒子统计用 `kbp rdc frame` / `stats`；我们这边用 `kabegame-dev` MCP 渲染同一时刻。粒子以外逐像素比，粒子比数量、尺寸、分布。
- 文档、changelog 与回归留到 P5a 收尾一起写。

### 步骤 1 实施记录（2026-11-10）

子代理按点 1–4 实现，Claude 独立验收。开工前 P4d 步骤 1 已提交（`b721f636`），共享文件是干净的。

**改动**（`apps/wpe-scene/src/compile/`）：
- `model.ts`：`JSON_COMMENT`、`JSON_TRAILING_COMMA`；`parseWpeJson` 先去注释、再去尾逗号。
- `features.ts`：`SUPPORTED_OBJECT` 加 `config`，`SUPPORTED_MODEL` 加 `cropoffset`；`MODEL_FLAGS` 与导出的 `modelFlag`；`checkModelFeatures` 合成一个循环；`writesDepth`。
- `bundle.ts`：`solidLayer` 用 `modelFlag`。
- `p5a.test.ts`（新增）：点 4 的用例，另有字符串里的 `/*` 与转义引号、去注释后仍不合法要抛错、`puppet` 与未知键照报、`modelFlag` 对 1 和 `"true"` 为假。

子代理报的两处细节，验收时确认无害：
- 一个模型报多个键时，Set 里的顺序改成按模型 JSON 的键序；能力表只当集合用。
- 混合模式不在支持表里时（如 `multiply`），`depthwrite` 不再单独报；这种 pass 照样报 `blend:<模式>`，整张退回不变。

**验收**：
- **类型、测试、格式**：tsc 通过；vitest 50 个文件、1343 个用例全部通过（带 `KABEGAME_WPE_ROOT`）；Prettier 通过。
- **语料**（`ignore/p5/s1/corpus.test.ts`，`corpus_diff.py`，结果 `out/corpus-diff.txt`）：
  - 能渲染 23 → 24，新解锁 `3778549173`，没有场景不再能渲染；
  - 去掉的键只有 `model:cropoffset`（34 张）、`object:config`（14 张）、`depthwrite:enabled`（5 张）；不新增键，没有编译出错；
  - 5 张去掉 `depthwrite:enabled` 的逐个材质核对（`check_depthwrite.py`，读法用 kbp-tools 的 `content` 库）：编译路径上的 pass 都是 translucent / additive 或 `depthtest: disabled`。3453730450 另有 4 个 normal 且写深度的材质，都在 `materials/models/` 下，是 mdl 网格的材质，现在不编译，归 P5c、P5d；
  - 语料里模型布尔键全写成 `true`，带注释的 JSON 只有 fantasticcar 一个（`scan_bool.py`），收紧和注释支持都不改变现有结果。
- **`3778549173` 和 WPE 比画面**：
  - WPE 用 `wpe-renderdoc` 开 2560×1440 窗口、fps 20 抓 3 帧（`A:\p5a\3778549173-fps20`）。整帧图、画完图像层时（事件 27）的渲染目标、粒子统计量都用 `kbp rdc frame` / `stats` 导出，放在 `ignore/p5/s1/out/`。这张场景没有着色器读 `g_Time`。
  - 静态部分（`cmp_static.py`）：WPE 取画完图像层时的渲染目标；我们这边 `render_scene` 不回放，带着预热的雪花、灰烬，两者都是 additive。结果是没有一个像素比 WPE 暗；96.86% 的像素完全相同；更亮的 2.65% 是粒子。
  - 粒子（`cmp_particles.py`，结果 `out/cmp-particles.txt`）：按 fps 20 的均匀帧时间（`make_log.py` 造的日志）用 `particle_track` 回放到第 286–288 帧。
    - 灰烬：2306 对 2306–2316，尺寸、透明度、颜色范围逐位相同；
    - 雪花：288–290 对 280–286（上限 300），尺寸、颜色范围几乎相同；
    - 光晕：25 对 25，尺寸、颜色、透明度相近；它跟随指针，WPE 抓帧时的指针读不到，位置不比。

**工具**：`ignore/p5/s1/`：`corpus.test.ts`、`vitest.config.ts`、`corpus_diff.py`、`check_depthwrite.py`、`scan_bool.py`、`cmp_static.py`、`cmp_particles.py`、`make_log.py`、`summary.py`；HEAD 源码 `head/src`。

## 步骤 2 — 视差

### 思路

视差分成「每帧一次的视差点」和「每次绘制的平移」两半。

**视差点归渲染器。** 渲染器在帧开头、粒子和脚本之前，用这一帧的 `g_PointerPosition`、帧时间和 `SceneState.general` 里的 `cameraparallax*` 算出视差点 P，并平滑，同时得到 `g_ParallaxPosition`。P 存在渲染器里，所以场景重编译时保留，加载新场景时回到场景中心。
- 补画帧的帧时间是 0，平滑系数 k 也是 0，P 不动；`delay ≤ 0` 时 P 直接取目标，和 WPE 一样。
- 开关关着时 P 不更新，`g_ParallaxPosition` 保留上一次的值（加载时是 (0.5, 0.5)），也不加平移。
- 公式全部写成纯函数，放在新文件 `render/parallax.ts`：dev 探针回放要逐帧推进同一个 P，渲染器和探针共用它。

**平移归 `GpuScene`。** 渲染器每帧把 P（开关关着时是 null）交给 `GpuScene.setParallax`。`GpuScene` 取 draw 矩阵的唯一入口是 `uniformValues`，在那里按 draw 所属对象的**根对象**算偏移 o，把视图投影换成 `VP·T(o)`。这个换法同时适用于：
- 图像层的直接上屏；
- 带 effect 图层的每个 pass：基础 pass 用自己的整面矩阵，本来就不读 VP；
- 正交与透视粒子。

依据是补测 `p5a-fx`：WPE 在画整个对象之前把视图换成带视差的，中间 pass 读的效果矩阵也带视差，透视粒子同样带（p5-REPORT）。粒子模拟和控制点反投影仍用不带视差的 `this.viewProjection`。

**矩阵每帧都可能变。** 现在矩阵属于「静态 uniform」，只在建 draw 或图层脏时写。改成：`setParallax` 收到的 P、开关或 `amount` 和上一帧不同时，把全部 draw 走一遍 `refreshLayer`。对象原点变、根的 `parallaxDepth` 变时，照旧经 `dirty.layers` 刷新，`parallaxDepth` 和 `origin` 一样整棵子树标脏。

**`parallaxDepth` 进图层字段。** 编译期按 WPE 的缺省 (1, 1) 取值并登记绑定，`LayerState` 多一个字段。用户属性就地更新，字段脚本写回到它，`thisLayer.parallaxDepth` 读写放开。

### 现状锚点

**a. 帧循环没有视差**（`render/renderer.ts:491`）
```ts
    if (live) this.frameClock.advance(this.clock.seconds());
    else this.frameClock.hold();
    const { time, frametime } = this.frameClock;
    // …
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor);
    // …
    if (live) this.options.beforeFrame?.(frametime); // 脚本
    // …
      scene.update({ time: wrapped, frametime, daytime: daytimeOf(new Date()), pointer: this.pointer, pointerLast: this.pointerLast, cursor }, state);
```

**b. 帧内置 uniform 没有 `g_ParallaxPosition`**（`render/uniforms.ts:484`、`compile/features.ts:51`）
```ts
export function frameBuiltins(frame: FrameInput): Record<string, number[]> {
  return { g_Time: [frame.time], g_Frametime: [frame.frametime], g_Daytime: [frame.daytime],
    g_PointerPosition: frame.pointer, g_PointerPositionLast: frame.pointerLast, g_PointerState: [0, 0, 0, 0] };
} // 现状：ENGINE_UNIFORMS 也没有它，着色器读它时报 uniform:g_ParallaxPosition（compile/p2a.test.ts 断言两边一致）
```

**c. 取矩阵只用场景 VP**（`render/scene.ts:1295` 的 `uniformValues`）
```ts
        viewProjection: step.perspective ? this.perspectiveViewProjection : this.viewProjection, // 粒子
    // …
    return drawUniformValues({ ...common, step, layer: { ...layerState, size: layer.size }, viewProjection: this.viewProjection });
```

**d. 矩阵只在建 draw 或图层脏时写**（`render/scene.ts:1515`）
```ts
  update(frame: FrameInput, _state?: SceneState): void {
    const values = frameBuiltins(frame);
    for (const draw of this.draws) {
      if (!draw.frameNames.length && !draw.dirty) continue; // 现状：每帧只写 frameNames
```

**e. 图层字段没有 `parallaxDepth`**（`compile/bindings.ts:23`、`render/state.ts:30`、`compile/scripts.ts:36`、`script/api.ts:76`）
```ts
export type LayerField = "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible";
// LayerState、layerTypes、LAYER_FIELDS 同样是这 7 个；scriptApi.ts 的 MISSING_SCRIPT_API.layer 里有 parallaxDepth
```

### 点 1 — 视差公式（新增 `render/parallax.ts`）
- **新增** 纯函数，常量照 p5-REPORT。

```ts
/** 视差的输入（`SceneState.general` 与帧量）。 */
export interface ParallaxInput {
  enabled: boolean;          // general.cameraparallax
  amount: number;            // cameraparallaxamount
  delay: number;             // cameraparallaxdelay
  mouseInfluence: number;    // cameraparallaxmouseinfluence，不钳制
  pointer: readonly [number, number]; // g_PointerPosition（左上原点、y 向下）
  eye: readonly [number, number];     // eye.xy（正交时为 0；步骤 3 起加抖动）
  width: number; height: number;      // 场景正交尺寸 W、H
  frametime: number;
}
/** 场景中心 = 加载时的 P（eye 为 0）。 */
export function initialParallaxPoint(width: number, height: number, eye = [0, 0]): [number, number];
/** 目标点：指针钳到 0…1、y 翻成向上，再在场景中心与指针之间按 mouseInfluence 插值，加 eye.xy。 */
export function parallaxTarget(input: ParallaxInput): [number, number];
/** 一帧：delay > 0 时 k = min(1, (1 − delay/3)·10·frametime)，P ← P + (目标 − P)·k；否则 P = 目标。P 不钳制。 */
export function stepParallaxPoint(previous: readonly [number, number], input: ParallaxInput): [number, number];
/** g_ParallaxPosition = clamp(P / (W, H), 0, 1)。 */
export function parallaxUniform(point: readonly [number, number], width: number, height: number): [number, number];
/** 对象偏移 o = amount · depth ⊙ (origin.xy − P)，用根对象的 origin 与 parallaxDepth。 */
export function parallaxOffset(amount: number, depth: readonly number[], origin: readonly number[], point: readonly [number, number]): [number, number];
```

### 点 2 — 渲染器（`render/renderer.ts`）
- **新增** 字段 `parallaxPoint`、`parallaxPosition`（初值 (0.5, 0.5)）。新场景加载时 `parallaxPoint` 取 `initialParallaxPoint`；重编译不重置。实现时找准「新场景」与「重编译」各自的入口。
- **修改** `render`：在 `frameClock` 之后、`scene.sync` 之前，开关开着时推进 P、更新 `parallaxPosition`，再调 `scene.setParallax(开着 ? { point, amount } : null)`；`scene.update` 的帧输入多传 `parallax: this.parallaxPosition`。

### 点 3 — 帧内置 uniform（`render/uniforms.ts`、`compile/features.ts`）
- **修改** `FrameInput` 加 `parallax: [number, number]`，`frameBuiltins` 输出 `g_ParallaxPosition`。
- **修改** `ENGINE_UNIFORMS` 加 `g_ParallaxPosition`。

### 点 4 — 绘制矩阵（`render/scene.ts`、`render/layout.ts`）
- **新增** `layout.ts` 的 `rootObject(object, layers)`：沿 `LayerState.parent` 走到根。父对象不在 `layers` 里时当根，和 `worldMatrixOf` 一致。
- **新增** `GpuScene.setParallax(next: { point; amount } | null)`：和上一次不同（null 与非 null 互换、P 或 `amount` 变）时记下，并对全部 draw 调 `refreshLayer`（共用一份 `worlds`）。
- **修改** `uniformValues`：有视差时算根对象的偏移，图层与粒子的 `viewProjection` 都换成 `multiply(VP, translation(o.x, o.y, 0))`；没有视差时照旧。
- **修改** `particleProbe` / 四角探针读到的就是 draw 的 uniform，自然带视差，不用改。

```ts
  private viewProjectionOf(layer: SceneLayer, state: SceneState, base: Mat4): Mat4 {
    const parallax = this.parallax;
    if (!parallax) return base;
    const root = state.layers.get(rootObject(layer.object, state.layers));
    if (!root) return base;
    const [x, y] = parallaxOffset(parallax.amount, root.parallaxDepth, root.origin, parallax.point);
    return x === 0 && y === 0 ? base : multiply(base, translation(x, y, 0));
  }
```

### 点 5 — `parallaxDepth` 字段（`compile/bindings.ts`、`compile/bundle.ts`、`render/state.ts`、`compile/scripts.ts`、`script/api.ts`、`compile/scriptApi.ts`、`host.ts`）
- **修改** `LayerField` 加 `parallaxDepth`。`SceneLayer` / `LayerState` 加 `parallaxDepth: number[]`（2 维）。
- **修改** `bundle.ts` 编译期取值：`numbers(bindings.bind(object.parallaxDepth, properties, at("parallaxDepth")), [1, 1])`，缺键是 (1, 1)。
- **修改** `state.ts`：`LAYER_DEFAULTS` 加 (1, 1)；`parallaxDepth` 进 `INHERITED_FIELDS`，整棵子树标脏，因为子孙的偏移看根。
- **修改** `scripts.ts` 的 `layerTypes` 加 `parallaxDepth: "vec2"`；`script/api.ts` 的 `LAYER_FIELDS` 加它，类型 vec2；`host.ts` 的 `readTarget` 正则加它。
- **删除** `scriptApi.ts` 里 `MISSING_SCRIPT_API.layer` 的 `parallaxDepth`，更新「已实现」注释；`script/api.test.ts`、`compile/scriptApi.test.ts` 的双向核对随之更新。

### 点 6 — 能力表与注释（`compile/features.ts`）
- **修改** `checkSceneFeatures`：`cameraparallax` 不再报，`camerashake`、`supportsaudioprocessing` 照报。
- **修改** `NEUTRAL_GENERAL` 上方与 `SUPPORTED_OBJECT` 里 `parallaxDepth` 的注释：视差已实现（P5a 步骤 2），透视场景不移动对象（读码，语料 0 张）。

### 点 7 — dev 探针（`dev/probe.ts`、`dev/particleCorners.ts`）
- **修改** `renderFrame` 与 `replayParticles`：从加载起逐帧推进 P，用同一个 `pointer`、同一套 `render/parallax.ts`；最后一帧把 P 交给 `setParallax`，`g_ParallaxPosition` 进帧输入。抓帧期间光标不动，固定 `pointer` 就能复现，不加逐帧指针。
- `hostRenderFrame`、`particleCorners` 照旧固定 (0.5, 0.5)，同样走推进，结果带视差。

### 点 8 — 单测
- `render/parallax.test.ts`（新增）：用 p5-REPORT 的实测值做断言。
  - `p5a-static` 7 个方块的偏移；
  - `mouseinfluence` 1、0.5、−2 的 P（−2 时 P 在场景外、uniform 钳制）；
  - `delay 2.7` 的 k；
  - `delay ≤ 0` 直接取目标。
- `uniformValues` / `drawMatrices`：
  - 带视差的图层，各 role 的矩阵等于 `VP·T(o)` 代入原公式；
  - 粒子（正交、透视）同样；
  - 没开视差时逐字节不变。
- `compile/p2a.test.ts`：`ENGINE_UNIFORMS` 与 builtins 一致（加 `g_ParallaxPosition`）；`cameraparallax` 不再报。
- 绑定与脚本：`parallaxDepth` 绑用户属性就地改、字段脚本写回、`thisLayer.parallaxDepth` 读写。

### 实施方式

P4d 正在改 `render/scene.ts`、`render/uniforms.ts`、`compile/bundle.ts`、`compile/features.ts`（ropetrail，未提交），和本步重叠。本步照 P4c 步骤 1 的办法：
- 在快照 `ignore/p5/s2/ov`（`95715c09` 的 `apps/wpe-scene`）里实现并做完单测与语料；
- P4d 提交后，用补丁三方合并进工作区，再做和 WPE 的端到端对比；
- 合并前不碰工作区。

### 验收
- 快照里 tsc、vitest、Prettier 通过。
- **语料**（HEAD 导出对快照）：只少 `general:cameraparallax` 与 `uniform:g_ParallaxPosition`，不新增键；能渲染 24 → 35，新解锁的是范围表里步骤 2 的 11 张。
- **合并进工作区之后，和 WPE 端到端比**：
  - 测试工程：`p5a-static`、`p5a-ptr*`、`p5a-delay*`、`p5a-kinds`、`p5a-fx`、`p5a-zoompar` 按 1920×1080 窗口重抓，`kbp-meta.json` 按 kbp 协议补成 `order` / `objects`；
  - 时间线：`kbp rdc track` 取 `g_Time`、dt、指针，`render_scene` 按时间线、用抓到的指针回放到同一帧；
  - 比法：和 `kbp rdc frame` 的整帧逐像素比。方块是纯色，位置差一个像素就看得出；CLK 图层的颜色含 `g_ParallaxPosition`，也一并比到；
  - 真实样本：`2381978484`、`3445915391`、`3818481122` 静态部分和 WPE 比，指针取抓帧时钳制后的 (1, 0)。
- 不开视差的场景（现有 24 张能渲染的），画面哈希逐张相同。

### 步骤 2 实施记录（2026-11-10）

**动工前补测**：`p5a-fx`。三个带 effect 的方块，effect 照编辑器的做法连材质、着色器一起打包进工程（cursorripple、depthparallax、godrays），外加一个透视粒子。结果：effect 的中间 pass 读到的效果矩阵也带视差，透视粒子也带，所以一个对象的每次绘制都换成 `VP·T(o)`（p5-REPORT 补了两行）。

**实现**：子代理在快照 `ignore/p5/s2/ov`（`95715c09`）里实现并验收，补丁 `ignore/p5/s2/step2.patch`。P4d 步骤 2 提交（`9f47e8fc`）后，Claude 用 `ignore/p5/s2/merge.sh` 逐文件三方合并进工作区（`git merge-file`，基准是 `ignore/p5/s2/base`）。只有 `render/scene.ts` 文件头注释冲突，两边都保留。
- **新增**
  - `render/parallax.ts`：纯函数与渲染器、探针共用的推进函数；
  - `render/parallax.test.ts`。
- **修改**
  - `render/renderer.ts`：帧开头推进 P；脚本之后按当时的开关与 `amount` 调 `setParallax`；P 在渲染器第一次 `load` 时取场景中心，重编译保留。
  - `render/scene.ts`：`viewProjectionOf`、`setParallax`。
  - `render/uniforms.ts`：`g_ParallaxPosition`；`FrameInput.parallax` 是可选的，缺省 (0.5, 0.5)，生产代码与探针都显式传值。
  - `render/layout.ts`：`rootObject`。
  - `render/state.ts`、`compile/{bindings,bundle,model,scripts,scriptApi,features}.ts`、`script/api.ts`、`host.ts`：`parallaxDepth` 字段、`g_ParallaxPosition`、能力表、脚本 API。
  - `dev/{probe,particleCorners}.ts`：回放逐帧推进 P。
  - 测试里手写的 `SceneLayer` / `LayerState` 补 `parallaxDepth`。
- **子代理补的一处**：`parallaxDepth` 绑了单个数字的用户属性时（语料 65 处里最多的 `hudparallax` 0.01），`numbers` 只存 `[0.01]`，`parallaxOffset` 按 WPE 向量 setter 的行为铺满两个分量。这一条是推断；用到它的场景还被文本等挡着，解锁时再核对。`origin` / `scale` 有同样的缺口，没动。

**验收**（合并后的工作区，Claude 独立跑）：
- **类型、测试、格式**：tsc 通过；vitest 52 个文件、1416 个用例全部通过（含 P4d 新加的）；Prettier 通过。
- **语料**（`ignore/p5/s2/corpus_diff.py`，HEAD `9f47e8fc` 导出对工作区）：
  - 能渲染 24 → 35，新解锁的正是范围表步骤 2 的 11 张；
  - 去掉的键只有 `general:cameraparallax`（41 张）、`uniform:g_ParallaxPosition`（16 张）、`script:api:layer.parallaxDepth`（1 张，3818053626，实现 API 后本该消失）；
  - 不新增键，没有场景不再能渲染。
- **端到端，测试工程**（`ignore/p5/s2/cmp_frames.py`，结果 `out/cmp-frames.txt`）：
  - 抓帧：8 个工程按 1920×1080 窗口重抓（`A:\p5a2`）。生成器 `kbp-meta.json` 改成 kbp 协议：带 effect 的图层按「基础 pass + 各 effect pass」补占位条目；CLK 补读 `g_PointerPositionLast`；分析脚本改读 `p5a-meta.json`。
  - 回放：`kbp rdc track` / `frame` 取轨迹和 WPE 整帧，导入 dev 库，`render_scene` 按时间线、用抓到的指针回放到同一帧，去掉 FR 帧号块逐像素比。
  - 结果：`static`、`ptr1`、`ptr05`、`ptrm2`、`delay27`、`kinds`、`fx` 7 组和 WPE **逐像素完全相同**（最大差 0）。
  - `delay29` 有 360 个像素不同（A、B 纵向差 1 像素）。用 WPE 自己的帧时间复算（`fit_delay.py`），P 和 WPE 差 (0.37, 0.37) 像素，两轴相等。公式或帧时间出错的话，误差应按两轴各自到目标的距离（960 对 −447）成比例，所以这是起点不同：开窗最初几帧光标相对窗口的位置抓不到，我们的回放假设光标从第一帧起不动。`delay 2.9` 衰减慢，到第 101 帧还剩约 19% 的初始差；`delay 2.7` 早已衰减干净，所以逐像素一致。逐帧的 k 已在步骤 0 对上（误差小于 1e-5）。
  - 用完 `projects_remove` 移除，核对过没有残留。
- **端到端，真实样本**（`cmp_real.py`）：`2381978484`、`3445915391`、`3818481122` 用步骤 0 的抓帧（1344×756），我们按回放渲染整幅场景、按 WPE 的居中裁切缩到同一尺寸，相位相关估计的平移都是 (0, 0)，平均像素差 0.6–2.3（缩放重采样）。`2381978484` 照公式的视差偏移在这个尺寸下约 67 像素，所以这个比较能检出视差错误。
- **画面哈希**：`hash_baseline` 对 P4d 步骤 2 的基线（`ignore/p4/d2/out/hash-after.json`）10 张场景 × 3 档全部相同（`ignore/p5/s2/out/hash-after.json`）。
- dev 宿主已按合并后的工作区重新构建。

## 步骤 3 — 抖动

### 思路

抖动是**每帧一次的 eye 偏移 s**，只由本帧的 `g_Time` 和四个 `camerashake*` 字段决定，没有随机源，也没有跨帧状态。WPE 在帧开头更新相机时算它：在 lookAt 之前、视差点之前、粒子模拟之前，脚本之后才跑（rea-p5-camera 5，一帧里的顺序表）。所以渲染器在帧开头、推进视差点之前算 s，脚本写 `camerashake*` 要到下一帧才生效，和 WPE 相同。

**s 同时进四个地方：**
- **视图。** eye 和 center 加同一个偏移，正交场景的视图就是平移 `T(−s)`，所有绘制都跟着平移，包括透视粒子：它的覆盖矩阵是在「当前 V」上改平移分量，而当前 V 已经带了抖动（7.2）。视差的 `T(o)` 也是纯平移，两者可以交换，所以每次绘制的视图投影是 `VP · T(o − s)`；没开视差时是 `VP · T(−s)`。
- **`g_EyePosition`。** 变成 `(W/2 + sx, H/2 + sy, 2000)`。拖尾判退化用的眼位（`trailEye`）读同一个值。
- **视差点。** 目标点里的 eye.xy 就是 s，步骤 0 在 `3830255100` 上按 uniform 核对过。加载时的初值仍是场景中心：WPE 在加载末尾按基准 eye 写初值，那时还没有抖动。
- **粒子的指针反投影。** 模拟时用的视图带抖动、不带视差（视差只在绘制时乘）。所以跟随指针的控制点会随抖动整体平移 s。

**公式按 float32 算。** 步骤 0 实测：`roughness 0.1` 时 `0.1f³` 正好等于 `0.001f`，「`e > 0.001`」为假，不改长度；按 double 算会进改长度的分支，偏移差 2.5 像素。其余几步也照 WPE 的 float 逐步取整（`Math.fround`）。差别只在 `g_Time` 很大时才显出来，但取整的代价很小，和 WPE 对齐更省事。

**透视场景的抖动不在本步。** 透视下幅度是 `0.1·amplitude` 个世界单位、偏移是三维的，要和透视相机一起做（P5d）。透视场景整张报 `camera:perspective`，能力表在透视场景里照报 `general:camerashake`，提醒 P5d 补上。

**状态与刷新。** s 不跨帧，`GpuScene` 只记本帧的值：`setShake` 在帧开头收下 s，改掉场景级的视图投影、透视粒子的视图投影和眼位，粒子模拟就用新的；所有 draw 的矩阵重写和视差共用一次，在脚本之后的 `setParallax` 里做（s 或视差有一个变了就整体刷一遍）。关着时 s 恒为 (0, 0)，矩阵与眼位逐字节同现在。

### 现状锚点

**a. 帧开头只推进视差点，eye 恒为 0**（`render/renderer.ts:520`）
```ts
    const [width, height] = this.projection;
    this.parallax = advanceParallax(
      this.parallax,
      parallaxInput(state.general, { pointer: this.pointer, frametime, width, height }), // 现状：没传 eye，parallaxInput 取 (0, 0)
    );
    // …
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor); // 现状：模拟用 populate 时算好的 this.viewProjection
    // …
    if (live) this.options.beforeFrame?.(frametime); // 脚本
    // …
      scene.setParallax(drawParallax(this.parallax, state.general), state); // 现状：视差变了才整体刷一遍矩阵
```

**b. 场景级视图投影与眼位只在建场景时算一次**（`render/scene.ts:920`、`:956`）
```ts
    this.eye = eyePosition(general);                                  // 现状：恒为 (W/2, H/2, 2000)
    // …
    this.viewProjection = sceneViewProjection(general);               // 现状：正交投影，视图是单位阵
    this.perspectiveViewProjection = particleViewProjection(general); // 现状：透视粒子的覆盖矩阵，不带 eye 偏移
```

**c. 每次绘制只乘视差平移**（`render/scene.ts:1402`）
```ts
  private viewProjectionOf(layer: SceneLayer, state: SceneState, base: Mat4): Mat4 {
    const parallax = this.parallax;
    if (!parallax) return base; // 现状：没有视差就原样返回
    // …
    return x === 0 && y === 0 ? base : multiply(base, translation(x, y, 0));
  }
```

**d. 眼位函数不收偏移**（`render/layout.ts:236`）
```ts
export function eyePosition(general: Pick<SceneGeneral, "width" | "height">): number[] {
  return [general.width / 2, general.height / 2, 2000];
}
```

**e. 能力表整张报抖动**（`compile/features.ts:289`）
```ts
  for (const key of ["camerashake", "supportsaudioprocessing"]) if (active(g[key])) unsupported.add(`general:${key}`);
```

**f. 探针回放的视差不带 eye**（`dev/probe.ts:281`、`dev/particleCorners.ts:373`）
```ts
      parallax = replayParallax(parallax, state.general, parallaxFrame, [...replayed.slice(0, -1), frametime]);
      // 现状：parallaxFrame 没有 eye；replayParallax 只收帧时间序列，不收每帧的 g_Time
```

### 点 1 — 抖动公式（新增 `render/shake.ts`）
- **新增** 纯函数，常量照 rea-p5-camera 5 与 p5-REPORT。

```ts
/** 抖动用到的四个 general 字段（`SceneState.general` 满足）。 */
export type ShakeFields = Pick<GeneralValues, "camerashake" | "camerashakespeed" | "camerashakeamplitude" | "camerashakeroughness">;

/**
 * 正交场景一帧的抖动偏移 s（场景单位，加到 eye 与 center 上）；关着时 (0, 0)。按 WPE 的 float 逐步取整：
 * e = powf(roughness, 3)；amp = 0.01·amplitude·H；T = speed²·time；v = (cos T, sin(1.333·T))（正交时 z 清零）；
 * 0.001f < e 且 e ≠ 1 时把 v 的长度 L 换成 L^e、方向不变；s = v·amp。
 */
export function shakeOffset(fields: ShakeFields, time: number, height: number): [number, number];
```

### 点 2 — 渲染器（`render/renderer.ts`）
- **修改** `render`：`frameClock` 之后、推进视差点之前，用 `wrapped`（就是本帧的 `g_Time`）和**脚本之前**的 `state.general` 算 s；先 `scene.setShake(s, state)`，再推进视差点（`parallaxInput` 的帧量带 `eye: s`），然后照旧 `sync` → `stepParticles`。
- 补画帧的时间不变，s 也不变，不用特殊处理。

### 点 3 — `GpuScene`（`render/scene.ts`、`render/layout.ts`）
- **修改** `layout.ts`：`eyePosition(general, offset = [0, 0])` 返回 `(W/2 + ox, H/2 + oy, 2000)`。
- **新增** 字段 `baseViewProjection`、`basePerspectiveViewProjection`（`populate` 里算，就是现在的两个值）、`shake: [number, number]`（初值 (0, 0)）。
- **新增** `setShake(offset, state)`：和上一帧不同时，记下 s，`viewProjection = base · T(−s)`，`perspectiveViewProjection = basePersp · T(−s)`，`eye = eyePosition(general, s)`，并标记「相机变了」。只改场景级的值，不刷 draw。
- **修改** `setParallax`：视差变了，或者「相机变了」时，整体刷一遍（一帧至多一次），刷完清标记。
- **修改** `viewProjectionOf`：`base` 已带 `T(−s)`（来自上面两个字段），视差照旧右乘 `T(o)`；不用再改。
- 粒子的指针反投影（`pointerScenePoint(this.viewProjection, …)`）自然用上带抖动、不带视差的矩阵，不用改。预热时 s 还是 (0, 0)：WPE 加载期的预热用哪一帧的相机没查过，和 P4 的现状一致，记进未实测清单。

### 点 4 — 能力表（`compile/features.ts`）
- **修改** `checkSceneFeatures`：`camerashake` 只在透视场景（没有 `orthogonalprojection`）报 `general:camerashake`；正交场景不再报。注释写明透视的抖动归 P5d。

### 点 5 — dev 探针（`dev/probe.ts`、`dev/particleCorners.ts`、`render/parallax.ts`）
- **修改** 回放：每一帧按这一帧的 `g_Time`（`times[i]`，没给时是 dt 的累计值）算 s，视差点带着同一帧的 s 推进；读回的那一帧先 `setShake(s)`，再 `setParallax`，帧输入里的眼位跟着变。
- **修改** `replayParallax`：收每帧的 eye（与帧时间等长的数组，或按帧号取的函数），渲染器和探针仍共用同一套推进。

### 点 6 — 单测
- `render/shake.test.ts`（新增），用步骤 0 的实测值（`ignore/p5/a0/shake_table.py` 导出，`g_EyePosition` 是 float32，容差 2e-3）：

| 工程 | speed / amplitude / roughness | `g_Time` | 实测 s |
|---|---|---|---|
| `shake1` | 1 / 1 / 1 | 5.152159690856934 | (4.597900390625, 5.96051025390625) |
| `shake1` | 1 / 1 / 1 | 5.315052509307861 | (6.12188720703125, 7.76080322265625) |
| `shaker2` | 1 / 1 / 2 | 5.149637699127197 | (0.35247802734375, 0.45709228515625) |
| `shaker2` | 1 / 1 / 2 | 5.340617656707764 | (4.318115234375, 5.45074462890625) |
| `shaker01` | 1 / 1 / 0.1 | 5.100968837738037 | (4.09185791015625, 5.33258056640625) |
| `shaker005` | 1 / 1 / 0.05 | 5.100132942199707 | (4.08349609375, 5.3221435546875) |
| `shakes3` | 3 / 0.5 / 1 | 5.165701389312744 | (−4.35516357421875, −4.08856201171875) |
| `shakes3` | 3 / 0.5 / 1 | 5.336287498474121 | (−3.34527587890625, 5.00836181640625) |

  另测：关着时 (0, 0)；`roughness 0.1` 走「不改长度」（按 double 会差约 2.5 像素，断言能区分）。
- `uniformValues` / `drawMatrices`：抖动开着时图层与粒子（正交、透视）的矩阵等于 `base · T(o − s)`；`g_EyePosition` 带 s；关着时逐字节不变。
- 粒子的指针反投影带 s、不带视差。
- `compile/p2a.test.ts` 或 `p5a.test.ts`：正交场景开 `camerashake` 不再报，透视场景照报。

### 实施方式

照步骤 2：在快照里实现，补丁三方合并进工作区。
- 快照：`kbp snapshot export HEAD ignore/p5/s3/head` 与 `… ignore/p5/s3/ov`（HEAD 是 `4c088ddd` 之后的最新提交），子代理只改 `ov/src`。
- 补丁：`kbp snapshot diff ignore/p5/s3/head ignore/p5/s3/ov --out ignore/p5/s3/step3.patch`，`git apply --check` 后 `--3way` 进工作区；合并前看一次 P4 的工作区。

### 验收
- 快照里 tsc、vitest、Prettier 通过。
- **语料**（`kbp regress --src head/src --src ov/src --corpus`）：
  - 回放案例逐字节相同；
  - 只少正交场景的 `general:camerashake`，不新增键；能渲染 35 → 36，新解锁 `3830255100`；ricepod、3706286085 照报。
- **合并进工作区之后，和 WPE 端到端比**（方法同步骤 2）：
  - 测试工程：`p5a-shake1`、`shaker2`、`shaker01`、`shaker005`、`shakes3` 按 1920×1080 窗口重抓，`kbp rdc track` 取时间线，`render_scene` 按时间线回放到同一帧，和 `kbp rdc frame` 的整帧逐像素比；
  - 再加一个视差加抖动的工程（`mouseinfluence 1`、`delay 0`）：同一帧里视差点、方块位置、CLK 读到的 `g_EyePosition` 与 `g_ParallaxPosition` 一起对上；
  - `3830255100`：和 WPE 同一 `g_Time` 的整帧比，按图层核对位置；粒子带随机，只比统计量。
- 不开抖动的场景（现有 35 张能渲染的），画面哈希逐张相同。

### 步骤 3 实施记录（2026-11-10）

**实现**：子代理在快照 `ignore/p5/s3/ov`（HEAD `4c088ddd`）里实现，Claude 独立验收后整份拷进工作区（期间工作区里 `apps/wpe-scene` 没有别人的改动，核对过逐字节）。
- **新增**
  - `render/shake.ts`：`shakeOffset`，各步按 float32 取整，比较常量用 `0.001f`；
  - `render/shake.test.ts`：点 6 的实测表，实际误差不超过 3e-5；`roughness 0.1` 和 1 逐位相同，按 double 算差 2.48 像素。
- **修改**
  - `render/renderer.ts`：帧开头算 s，视差点带 s 推进；**粒子步进之后**才 `setShake`（见下）。
  - `render/scene.ts`：基准视图投影两份、`setShake`、`cameraDirty`；`setParallax` 在视差或相机变了时整体刷一遍，一帧至多一次。
  - `render/uniforms.ts`：`g_EyePosition` 进 `LAYER_UNIFORMS`。计划没写这一条，但不加的话刷新不重写眼位，眼位就不跟抖动；不开抖动时重写的值不变。
  - `render/layout.ts`：`eyePosition(general, offset)`。
  - `render/parallax.ts`：`replayParallax` 收每帧的 eye。
  - `compile/features.ts`：`general:camerashake` 只在透视场景报。
  - `dev/probe.ts`、`dev/particleCorners.ts`：回放每帧先用上一帧的 s 步进粒子、再设本帧的 s，读回帧同样。
  - `particles/track.ts`、`dev/probe.ts`：轨迹回放（`particle_track` 走它）的跟随点同样带上一帧的 s。
- **端到端补测推翻了计划的一处**：计划写「粒子模拟用带抖动的当帧视图」。`p5a-shakepar` 第 119、120 帧跟随指针的新生粒子，按「当帧指针 + 上一帧 s」两帧误差都是 0，按当帧 s 差 0.3 像素左右（p5-REPORT 补了一行）。原因在读码的帧顺序：`FUN_1401891a0` 先更新对象（粒子模拟），之后才更新相机。所以 `setShake` 挪到粒子步进之后；加载后第一帧的模拟用加载时的相机（s 为 0），和预热一致。未实测清单里「预热时相机带不带抖动」随之有了依据（推断为 0），仍留在清单里。

**验收**（Claude 独立跑）：
- **类型、测试、格式**：快照里 tsc 0 错误、vitest 54 个文件 1477 个用例全部通过（HEAD 导出 53 个文件 1451 个）、Prettier 通过；第二版拷进工作区后在工作区也跑过一次（1474 个，当时还没有轨迹回放那几个用例）。最后一版拷进工作区时，P4 会话已开始改 `particles/` 下的噪声与回放测试，所以最后一次只在快照里跑；我们的文件和它们不重叠，拷入前逐个核对过工作区里这几个文件仍等于 HEAD 或我们的上一版。
- **回归与语料**（`kbp regress --src s3/head/src --src s3/ov/src --corpus`）：
  - 回放案例逐字节相同。`d4` 两边都失败、逐字节相同：它是 P4d 步骤 4 的案例，那一步还没实现；
  - 语料只少 7 张正交场景的 `general:camerashake`（2251857160、3340707146、3498150384、3560756264、3570560686、3818053626、3830255100），不新增键；能渲染 35 → 36，新解锁 `3830255100`；ricepod、3706286085 两张透视场景照报。
- **端到端，测试工程**（`ignore/p5/s3/cmp_frames.py`，结果 `out/cmp-frames.txt`）：
  - 抓帧：`p5a-shake1`、`shaker2`、`shaker01`、`shaker005`、`shakes3`、`shakepar` 按 1920×1080 窗口抓（`A:\p5a2`），`kbp rdc track` / `frame` 取轨迹和 WPE 整帧，导入 dev 库后 `render_scene` 按时间线回放到同一帧；
  - 5 组纯抖动工程**整帧 0 差异**，包括颜色里含 `g_EyePosition` 的 CLK 方块；FR 帧号块随抖动平移，屏蔽框放宽到抖动幅度；
  - `shakepar`：方块位置和 CLK 方块 0 差异；整帧的差异只在跟随指针的粒子上。这次抓帧时光标在动，WPE 的这些粒子沿光标历史出生，`render_scene` 只收一个固定指针，复现不了。
  - 跟随粒子另用 `particle_track`（逐帧光标取轨迹）回放、和 WPE 轨迹逐个比（`follow_cmp.py`）：第 119、120 帧新生的各 2 个粒子，位置差都在 1e-4 像素以内。
- **端到端，`3830255100`**（`ana_real3.py`、`cmp-real-3830255100.txt`、`region_shift.py`）：
  - 按 WPE 抓帧（1920×1080）各层的偏移反推，17 个对象给出的视差点一致（离散 0.001 像素），抖动 s 和 `g_EyePosition` 差 1e-4；由此反推指针 (0.928, 0.967)；
  - 我们按同一 `g_Time` 回放渲染、缩到 1920×1080 比：平均差 0.96，大于 32 的像素 0.038%，热图只有轮廓线；按区域相位相关，5 块区域的平移都在 0.08 像素以内。
- **画面哈希**：`hash_baseline` 对步骤 2 的基线（`ignore/p5/s2/out/hash-after.json`）10 张场景 × 3 档全部相同（`ignore/p5/s3/out/hash-after.json`）。
- dev 宿主已按工作区重新构建（`--mode development`）。

## 步骤 4 — 缩放

动工前写细。正交投影绕场景中心乘 `zoom ×` 相机 zoom。验收：`p5a-zoom` 和 WPE 一致；`general:zoom` 只在关键帧等别的原因下继续报。

## 未实测清单（P5a 收尾统一走查）

各步按读码或推断实现、还没有实测核对的项，都汇总在这里，P5a 收尾时统一走查（2026-11-10 用户，照 P4d）。每项写清现状、为什么没测到、怎么补；后面的步骤补测了，就挪到「已测」。

**要重新抓 WPE 才能补：**

| 项 | 来源 | 现状与原因 | 怎么补 |
|---|---|---|---|
| `parallaxDepth` 绑单个数字的用户属性时，铺满两个分量 | 步骤 2 | 子代理按 WPE 向量 setter 推断；语料 65 处（最多的是 `hudparallax` 0.01），这些场景还被文本等挡着，现在看不到效果 | 测试工程在 `project.json` 加一个滑块属性，绑到方块的 `parallaxDepth`，看偏移 |
| 运行中改 `parallaxDepth`（用户属性）就地生效 | 步骤 2 | p3 I3 记「只改字段、没有回调」，视差每次绘制都重读；我们按就地字段实现，没和 WPE 比 | 同一工程开窗后 `apply_properties` 改值再抓，比偏移；Kabegame 里改属性确认不整场重编译 |
| 运行中开关 `cameraparallax`：关时 P 冻结、`g_ParallaxPosition` 留旧值、偏移撤掉，再开时 P 从旧值续 | 步骤 2 | 读码；语料 9 张的开关绑了用户属性 | `apply_properties` 切开关，前后各抓几帧，读 CLK 的 `g_ParallaxPosition` 和方块位置 |
| 脚本写 `thisScene.cameraparallax*` 同帧生效；脚本读写 `thisLayer.parallaxDepth` | 步骤 2 | 读码（P 在脚本之前推进、绘制时读 `amount`）；语料只有 2887099508 的混淆脚本和 3304642534 等音频条脚本，后者还要 `createLayer` | 脚本按 `g_Time` 在某一帧改 `amount` 和某层的 `parallaxDepth`，抓那一帧前后 |
| 没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5) | 步骤 0 读码 | 步骤 0 只在开视差、`mouseinfluence 0` 时读到过 (0.5, 0.5)；语料 3351072238、3643916956 读它但没开视差，两张都还被别的挡着 | CLK 读它、视差关着的工程抓一帧 |
| `/* */` 块注释 | 步骤 1 | 推断：和 `//` 是 jsoncpp 的同一个开关；语料 0 处 | `p5a-pre` 加一个带块注释的材质，看能否加载 |
| `delay > 3` 时 k 为负、P 越走越远 | 步骤 2 | 照公式实现；语料最大 2.0 | 一个 `delay 3.2` 的工程连抓几帧；语料 0 张，可以不补 |
| 预热时相机带不带抖动（跟随指针的粒子预热位置） | 步骤 3 | 我们预热与加载后第一帧的模拟都用 s = (0, 0)。依据是推断：步骤 3 实测粒子模拟用上一帧的相机，加载时还没有更新过相机。t = 0 时抖动偏移是 (amp, 0)，不是 0 | 开抖动、控制点跟随指针、有 `starttime` 的工程，抓开窗后头几帧的粒子位置；语料里同时开抖动和跟随指针的场景很少，可以只记不补 |

**只能在 Kabegame 里真机走查（需要用户看）：**

| 项 | 看什么 |
|---|---|
| 预览里移动鼠标 | 11 张新解锁场景的图层跟随方向、幅度和 WPE 一致：10 张模板场景只在纵向动，`3445915391` 纵向动且 iris 照常；`3818481122` 图层不动，`depthparallax` 跟着变 |
| 壁纸样式 | `fill` 之外的 `fit`、`center`、`tile` 下，光标在画面上的位置决定视差点（沿用 `g_PointerPosition` 的样式换算），留白处外推、钳到边 |
| 桌面壁纸 | 设为桌面后，Windows 鼠标转发下视差跟随光标。WPE 每帧用 `GetCursorPos`，光标在别的窗口上时照样跟随；我们只在收到 `pointermove` 时更新，记下两边是否不同 |
| 开场滑动 | 加载后视差点从场景中心滑向光标；`delay 2.0` 的 5 张场景能看出这段过渡 |
| 重编译保留视差点 | 预览里改一个会整场重编译的属性，画面不跳回中心；换到另一张再换回来，回到中心 |
| 暂停与隐藏 | 暂停时视差点不动，恢复后接着平滑；应用背景、不交互的预览收不到指针，停在场景中心（只有静止偏移） |

**等步骤 3、4 覆盖：**

| 项 | 现状 | 怎么补 |
|---|---|---|
| 缩放与视差叠加 | 步骤 0 在 `p5a-zoompar` 上按 uniform 核对过 | 步骤 4 端到端：`p5a-zoompar` 按步骤 2 的方法逐像素比 |

**接受、不补：**
- `delay 2.9` 的回放差 1 像素：开窗最初几帧光标相对窗口的位置抓不到，回放只能假设光标从第一帧起不动；逐帧的 k 已在步骤 0 对上（步骤 2 实施记录）。
- P 用 double 算、WPE 存 float32：`fit_delay.py` 按 float32 复算，差为 0。

**工具与边角：**
- kabegame-dev 的 `render_scene` 回放只收一个固定指针，开窗期间光标动过的抓帧复现不了；需要时给探针加逐帧指针（步骤 2 点 7 当时没做）。
- 命中测试的视差偏移（WPE 按对象自身、不按根算）没做，归 W4。
- 透视场景开视差不移动对象（读码，语料 0 张）：P5d 实现透视时，连同透视场景里 `g_ParallaxPosition` 除以 0 再钳制的结果一起核对。
- `alignmentfliph` 水平镜像（`mx = 1 − mx`、`g_ParallaxPosition.x` 翻转）没实现，语料 0 张。

**已测（从清单里划掉）：**
- effect 的中间 pass、透视粒子都带视差：步骤 2 动工前补测 `p5a-fx`。
- 跟随指针的控制点不含视差：步骤 0。
- 场景比例和窗口不同时，视差点用场景宽高：步骤 0 的 `2381978484`，步骤 2 端到端再确认。
- 抖动把 eye 推开后，视差点跟着移：步骤 3 端到端，`p5a-shakepar` 逐像素、`3830255100` 同一 `g_Time` 整帧比。
- 粒子模拟用上一帧的相机：步骤 3 端到端补测 `p5a-shakepar`。

## P5a 收尾

先按「未实测清单」逐项走查（2026-11-10 用户）。再和 P4 各节一样统一写文档：
- `cocs/wpe/WPE_SCENE.md`：视差、抖动、缩放与前置几条；
- `cocs/README.md` 的场景文档条目；
- changelog、回归文档；
- 总计划 P5a 节补上完成情况。

## 决定

**已定：**
1. 前置并进本子计划的步骤 1（2026-11-10，用户进入 P5a）。
2. 抓帧不移动用户的鼠标，指针从 CLK 层读（总计划 P5a「指针怎么控」）。
3. 读码或推断实现、还没实测的项汇总进「未实测清单」，P5a 收尾统一走查（2026-11-10 用户，照 P4d）。

**待定：** 无。

## 风险

1. **静止偏移若被推翻：** 公式要重查，`3830255100` 的验收跟着变。
2. **平滑与帧率相关：** k 含 dt，确定性对比要固定 fps，回放也要按 WPE 的 dt 走。
3. **光标位置不可控：** 若开窗时光标恰好在窗口中心，`p5a-ptr` 区分不了插值；那时换 `mouseinfluence` 的取值放大差别，或者请用户把光标挪开。
