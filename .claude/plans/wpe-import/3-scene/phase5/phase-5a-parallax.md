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

### 思路

`general.zoom` 只改正交投影：投影绕场景中心乘 `zoom × 相机 zoom`（p3 L2：`FUN_14017fa70` 的 `0x14017fd50`）。P5a 没有相机对象和相机路径，基准相机的 zoom 恒为 1，所以只乘 `general.zoom`；P5d 接上相机来源后再乘相机的 zoom。

**动工前补测**（`p5a-zoom15`、`zoom08`、`zoompar` 按 1920×1080 重抓；新加 `p5a-zoomx15` / `zoomx08`：缩放加视差、抖动、离开 z = 0 平面的透视粒子和跟随指针的粒子，`ignore/p5/s4/ana_zoomx.py`、`follow_zoom.py`）：
- 方块的矩阵 = 绕中心缩放的正交投影 · `T(o − s)`，差 1e-7。视差偏移和抖动偏移都是场景单位，在缩放之前加。
- **透视粒子的相机距离随缩放变**：`d = (H/(2·zoom))/tan(fov/2)`，far 仍是 `max(15000, d + 1000)`。两档 3 帧和 WPE 逐项差 < 1e-4；不带缩放差上百。读码 7.2 写的是「d 取已含正交缩放的投影的可见高」，实测成立。
- 跟随指针的点按带缩放的投影反投影，同样用上一帧的抖动，误差 ≤ 3e-4；不带缩放差几百像素。
- 不随缩放变：`g_EyePosition`（只带抖动）、`g_ParallaxPosition` 与视差点（按场景宽高）、`g_PointerPosition`。

**`zoom` 进 general 字段。** 现在它不在 `GENERAL_FIELDS` 里：绑用户属性、脚本读写都动不了它，能力表看到不等于 1 就报。p3 I 节记「只改字段，正交投影每帧读」，所以按就地字段处理：加进 `GENERAL_FIELDS`（float，缺省 1），`thisScene.zoom` 从脚本 API 缺口表里删掉。语料里 `3253330537` 的 `zoom` 绑了属性，`2887099508` 是关键帧（照报 `value:animation`，属 PLAN K）。

**时机同抖动。** 缩放在相机更新之后、脚本之前读，粒子模拟在相机更新之前，所以模拟用上一帧的投影。渲染器把 zoom 和 s 一起在帧开头按脚本之前的字段取出，粒子步进之后才交给 `GpuScene`。静态缩放下看不出先后，这一点按读码和抖动的实测实现，记进未实测清单。

**接口。** 把步骤 3 的 `setShake(s)` 改成 `setCamera({ shake, zoom })`：zoom 变了时重算两份基准矩阵（正交与透视粒子），s 变了时照旧换平移；`cameraDirty` 与 `setParallax` 的整体刷新不变。

**边界。** zoom ≤ 0 时投影退化、反投影是 NaN，语料最小是 1.0，能力表对 ≤ 0 照报 `general:zoom`，不做别的处理。透视场景里 zoom 不起作用（读码 1.4），整张另报 `camera:perspective`。

### 现状锚点

**a. 能力表见 `zoom ≠ 1` 就报**（`compile/features.ts:294`）
```ts
  if (g.zoom !== undefined && g.zoom !== 1) unsupported.add("general:zoom"); // 现状：缩放没实现
```

**b. `zoom` 不在 general 字段表里**（`compile/bindings.ts:40`、`compile/scriptApi.ts:91`）
```ts
export const GENERAL_FIELDS = {
  // …
  camerashake: { type: "bool", fallback: false },
  // …
  cameraparallaxmouseinfluence: { type: "float", fallback: 0.5 },
}; // 现状：没有 zoom
// scriptApi.ts 的 MISSING_SCRIPT_API.thisScene 字段里有 "zoom"
```

**c. 场景投影与透视粒子投影不收缩放**（`render/layout.ts:208`、`:218`）
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">): Mat4 {
  return orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH); // 现状：没有 zoom
}
export function particleViewProjection(general): Mat4 {
  const focal = 1 / Math.tan(general.perspectiveOverrideFov / 2);
  const d = (height / 2) * focal; // 现状：相机距离按不缩放的可见高
```

**d. 相机只有抖动**（`render/scene.ts` 的 `setShake`，`render/renderer.ts` 粒子步进之后的 `scene.setShake(shake)`）
```ts
  setShake(offset: readonly [number, number]): void {
    // 现状：只换平移 T(−s)，基准矩阵建场景时算一次
```

### 点 1 — 字段与能力表（`compile/bindings.ts`、`compile/scriptApi.ts`、`compile/features.ts`）
- **修改** `GENERAL_FIELDS` 加 `zoom: { type: "float", fallback: 1 }`；`MISSING_SCRIPT_API` 删 `zoom`，更新两边的双向核对测试。
- **修改** `checkSceneFeatures`：只在 zoom 解析出的值 ≤ 0 时报 `general:zoom`；绑属性、等于 1、大于 0 都不报。注释写明依据与透视场景不起作用。

### 点 2 — 投影（`render/layout.ts`）
- **修改** `sceneViewProjection(general, zoom = 1)`：正交投影绕场景中心乘 zoom，即 x、y 的线性项乘 zoom、平移项保持中心不动。zoom 为 1 时逐字节同现在。
- **修改** `particleViewProjection(general, zoom = 1)`：`d = (height/(2·zoom))·focal`，far 用新的 d。zoom 为 1 时逐字节同现在。

### 点 3 — 相机（`render/scene.ts`、`render/renderer.ts`）
- **修改** `setShake` 改成 `setCamera({ shake, zoom })`：zoom 变了时按新 zoom 重算 `baseViewProjection`、`basePerspectiveViewProjection`，再乘 `T(−s)`；任何一项变了都标 `cameraDirty`。初值 zoom 取编译期的值，建场景时的基准矩阵就带上它。
- **修改** 渲染器：帧开头和 s 一起取 `state.general.zoom`（脚本之前的值），粒子步进之后 `setCamera`。

### 点 4 — 探针与轨迹回放（`dev/probe.ts`、`dev/particleCorners.ts`、`particles/track.ts`）
- **修改** 回放与读回帧同样 `setCamera`，zoom 取 `state.general.zoom`。
- **修改** `particleTrack`：反投影用 `sceneViewProjection(size, zoom)`，zoom 取 `shake` 同一份 general 字段（改名为 `camera` 或另加 `zoom`，由实现定）；没给时为 1。

### 点 5 — 单测
- `sceneViewProjection` / `particleViewProjection` 带 zoom：zoom 1 逐字节不变；zoom 1.5、0.8 的线性项与 d。
- 跟随点（`p5a-zoomx*` 实测，场景 1920×1080，抖动 speed 1 / amplitude 1 / roughness 1，上一帧 s 由上一帧 `g_Time` 算）：

| 工程 | zoom | 指针 | 上一帧 `g_Time` | WPE 出生点 |
|---|---|---|---|---|
| `zoomx15` 第 118 帧 | 1.5 | (1.1276041269302368, 1.1129629611968994) | 5.870555877685547 | (1773.226806640625, 109.46224975585938) |
| `zoomx08` 第 119 帧 | 0.8 | (1.0906250476837158, 1.0361111164093018) | 5.914529800415039 | (2387.57421875, −172.95489501953125) |

- `setCamera`：zoom 变了重算基准、标脏；全部 draw 的矩阵等于 `base(zoom) · T(o − s)`（图层、正交与透视粒子）；`g_EyePosition` 不随 zoom 变。
- 绑属性改 zoom 就地生效、不重编译；脚本写 `thisScene.zoom` 下一帧生效。
- 能力表：zoom 1.01、1.5 不报，绑属性不报，≤ 0 报。

### 实施方式

照步骤 3：快照 `ignore/p5/s4/head`、`ignore/p5/s4/ov`（HEAD `ff100954`），子代理只改 `ov/src`。P4 会话正在改 `particles/` 下的噪声与回放测试，合并前逐个核对要拷的文件在工作区里仍等于 HEAD。

### 验收
- 快照里 tsc、vitest、Prettier 通过。
- **语料**（`kbp regress … --corpus`）：回放案例逐字节相同；只少 `general:zoom`，不新增键。按 0a 的扫描，这 6 张都还被别的键挡着，能渲染数不变（36）。
- **端到端**（方法同步骤 3）：
  - `p5a-zoom15`、`zoom08`、`zoompar`、`zoomx15`、`zoomx08` 按时间线回放，和 WPE 整帧逐像素比；
  - `zoomx*` 里的跟随粒子另用 `particle_track` 逐帧光标比。
- 不开缩放的场景，画面哈希逐张相同。

### 步骤 4 实施记录（2026-11-10）

**实现**：子代理在快照 `ignore/p5/s4/ov`（HEAD `ff100954`）里实现，Claude 独立验收后拷进工作区。这期间 P4 会话提交了 `50d2e9c0`（P4d 步骤 4a，改 `particles/` 下的 remap、噪声等），和本步的 18 个文件没有重叠；拷入前核对过这 18 个文件在工作区里仍等于 `ff100954`。
- **新增** `render/zoom.test.ts`：zoom 为 1 时两份投影逐字节同改动前；线性项与 WPE 逐位相等；d、far、z = 0 平面重合。
- **修改**
  - `compile/bindings.ts`：`GENERAL_FIELDS` 加 `zoom`。
  - `compile/scriptApi.ts`：`thisScene` 缺口表删 `zoom`（`layer` 组的 `zoom` 是相机对象的字段，保留）。
  - `compile/features.ts`：只在正交场景、不绑属性、解析值 ≤ 0 时报 `general:zoom`。
  - `render/layout.ts`：`sceneViewProjection(general, zoom)` 是 float32 的 `S(zoom)·P`（实测线性项正好等于 `f32(zoom)·f32(2/W)`）；`particleViewProjection(general, zoom)` 的 d 带缩放。
  - `render/scene.ts`：`setShake` 换成 `setCamera({ shake, zoom })`；建场景时取编译期的 zoom。
  - `render/renderer.ts`：帧开头和 s 一起取脚本之前的 zoom，粒子步进之后 `setCamera`。
  - `dev/probe.ts`、`dev/particleCorners.ts`、`particles/track.ts`：回放与轨迹同样带 zoom。
  - 测试：`parallax.test.ts` 加「缩放」一节（方块与透视粒子的 MVP、眼位、`g_ParallaxPosition` 对 WPE 抓帧逐项比；换 zoom 一帧只刷一次；跟随点两组实测；绑属性就地写等于重编译；脚本写 zoom 绘制晚一帧、粒子再晚一帧），以及 `simulator`、`p2a`、`p3c`、`scriptApi`、`script/api`、`particleCorners` 的同步更新。
- **和计划不同的两处**（验收时认可）：
  - 透视场景里 zoom ≤ 0 也不报：zoom 的读取点都在正交分支（读码 1.4），透视场景整张另报 `camera:perspective`。
  - 探针的 `frameShake` 改名 `frameCamera`；`particleTrack` 另加 `zoom` 参数，没有把 `shake` 改名。
- 子代理另做了一次变异检查：把 d 改回不带缩放，8 个用例失败。

**验收**（Claude 独立跑）：
- **类型、测试、格式**：快照里 tsc 0 错误，vitest 55 个文件 1499 个用例全部通过；拷进工作区（含 P4 的新提交）后 tsc 0 错误，vitest 56 个文件 1543 个用例全部通过；Prettier 通过。
- **回归与语料**（`kbp regress --src s4/head/src --src s4/ov/src --corpus`）：回放案例逐字节相同（`d4` 两边同样失败，原因同步骤 3）；语料只少 6 张的 `general:zoom`，不新增键，能渲染仍是 36。
- **端到端**（`ignore/p5/s4/cmp_frames.py`、`follow_cmp.py`，结果 `out/cmp-frames.txt`）：
  - `p5a-zoom15`、`zoom08`、`zoompar`、`zoomx15`、`zoomx08` 按时间线回放，和 WPE 整帧逐像素比，**5 组全部 0 差异**。FR 帧号块的屏蔽框按缩放与抖动现算（1.5 倍时它在画面外）。
  - `zoomx*` 的跟随粒子用 `particle_track` 逐帧光标回放，两档各帧新生粒子和 WPE 差 ≤ 1e-4。
- **画面哈希**：对步骤 3 的基线 10 张场景 × 3 档全部相同（`ignore/p5/s4/out/hash-after.json`）。
- 测试工程已从 dev 库移除；dev 宿主已按工作区重新构建。

## 收尾前：回放逐帧光标（工具，2026-11-11 用户）

### 总体设计思路

回放现在只有一个固定光标。WPE 开窗后光标在动，跟随指针的粒子、视差点都复现不了：`p5a-shakepar` 第 120 帧 WPE 多出的 7 块，就是光标在第 1–118 帧划过时生下的粒子，沿一条斜线排开。RenderDoc 轨迹只有被抓的那几帧有指针，所以只让 `render_scene` 收 `cursors: "track"` 也修不好，要的是**每一帧**的光标。

数据从测试工程自己来：FR 脚本每帧把 `input.cursorScreenPosition` 和帧号、时间一起写进 `[kbp]` 日志。时间线新增 `cursors: "log"`，每帧光标取日志。光标的单位统一成 WPE 的 `g_PointerPosition`（窗口归一化、不钳制），窗口坐标换算到场景坐标由探针用产品的 `sceneCursor("fill", …)` 做，窗口尺寸从标签的 `-<宽>x<高>` 读，和 kbp replay 现在的做法一致，调用方不再自己算。三个回放接口（`render_scene`、`particle_track`、`particle_corners`）收同一套。

关键决策：
- **为什么从脚本日志取，不让 MCP 轮询系统光标**：脚本按帧号写，和 WPE 的帧天然对齐；轮询要按时间戳对帧，对不准。
- **光标列做成可选**（生成库 `write_project(…, cursor=True)`），缺省不变：别的会话跑着的 kabegame-dev MCP 是旧的解析器，见到多出的列会报错。等各会话都换上新 MCP 再考虑改缺省。
- **插件改动最后合**：`scripts/kabegame-dev/` 一改，vite 会自己重启一次，所有会话的宿主句柄、任务都会丢，应用页面整页刷新。探针在快照里先用 `host_eval` 直接调来验收，插件与 MCP 最后一起合进工作区，合之前先告诉用户。

### 实测（动工前，`ignore/p5/cur/`）

工程 `p5a-cur` / `p5a-cur2` 由 `gen_cur.py` 生成：FR 脚本每帧记 `cursorScreenPosition` 和 `cursorWorldPosition`，每 10 帧刷一次。场景里只有一个跟随指针的系统 `pf`（速度 0；`cur2` 的寿命 1000 s、上限 6000，开窗以来每次发射的出生点都留到抓帧那一刻）。抓帧在 `A:\p5a2\p5a-cur*`，读数是 `ana_cur.py` 和 `replay_cur.ts`。

| 问题 | 实测 | 结论 |
|---|---|---|
| 脚本里的「屏幕」是什么 | `engine.screenResolution`、`canvasSize` 都报 1920x1080，是测试窗口的尺寸，不是 3840 的显示器 | 壁纸窗口 |
| `cursorScreenPosition` 的坐标 | `p5a-cur` 8 帧、`p5a-cur3` 4 帧：`g_PointerPosition` 逐位等于 float32(屏幕光标 / 窗口尺寸)；光标在窗口外时是负数或超出尺寸，不钳制 | 窗口内像素、y 朝下，整数 |
| 脚本第 f 帧的光标，粒子在哪一帧用 | `p5a-cur3`（用户在测试窗口上晃了鼠标，日志第 2–53 帧光标逐帧在变）：按日志组时间线，第 f 帧用日志第 f 帧的光标回放，491–495 个粒子逐个吻合，最大差 2.4e-4；用第 f − 1 帧或第 f + 1 帧的，各有 421 个不同、最大差 340 像素 | **同一帧**。日志可以作为逐帧光标的唯一来源 |
| `cursorWorldPosition` | 等于 (屏幕 x, H − 屏幕 y)，带 float32 误差（1440.000244）；误差和粒子出生点的同量级 | 经相机反投影，同控制点跟随指针的那一步。留给 P6 实现 `input.*` |

### 现状锚点

**a. 日志只认三列**（`apps/kabegame-dev-mcp/src/timeline.ts:112`）
```ts
const match = /^(\d+),(\d+\.\d{6}),(\d+\.\d{6})$/.exec(token);   // 现状：帧号,帧时间,累计时间，多一列就报「读不懂」
```

**b. 渲染与四角拒收逐帧光标**（`tools.ts:417`）
```ts
if (source.cursors !== undefined || source.cursor !== undefined) {
  throw new ToolError("local", `${tool} 不收逐帧光标：…逐帧光标只有 particle_track 收`);   // 现状
}
```

**c. 探针 `renderFrame` 一个光标用到底**（`apps/wpe-scene/src/dev/probe.ts:228`、`:291`、`:297`）
```ts
const pointer = options.pointer ?? [0.5, 0.5];   // 现状：预热、回放每一帧、读回帧都用它
const { time, frametime } = replayParticles(scene, state, options.particles, startTime, pointer, shake.apply);
parallax = replayParallax(parallax, state.general, parallaxFrame, [...replayed.slice(0, -1), frametime], shake.eyes);   // 现状：parallaxFrame 里是固定的 pointer
```

**d. `particleTrack` 的 `cursors` 是场景纹理坐标，换算交给调用方**（`dev/probe.ts:496`）
```ts
/** 每帧光标下的场景纹理坐标……抓帧窗口和场景同尺寸时两者相同 */
cursors?: [number, number][];   // 现状：MCP 原样转进来，窗口和场景不同尺寸时不换算（kbp replay 换算）
```

**e. FR 脚本只记时间**（`.claude/skills/kbp-tools/py/gen.py:96`）
```js
buffer.push(frame + ',' + engine.frametime.toFixed(6) + ',' + engine.runtime.toFixed(6));   // 现状：每 50 帧刷一次
```

### 点 1 — 日志协议（`kbp-tools/py/gen.py`、`SKILL.md`）
- **新增** `FR_CURSOR`：在 `FR_COLOR` 的三列后加 `屏幕x,屏幕y`（`String()` 原样），每 10 帧刷一次。取光标包 `try`，失败写 `nan`，不让整个 `update` 被禁用。
- **新增** `write_project(…, cursor=False)`：为真时 FR 用 `FR_CURSOR`；缺省不变，旧工程逐字节相同。
- **修改** `SKILL.md` 的协议节：`[kbp]` 条目是三列或五列，同一个文件里不能混用；五列的单位与实测依据。

### 点 2 — 时间线（`apps/kabegame-dev-mcp/src/timeline.ts`）
- **修改** `parseKbpLog` 收三列或五列，回帧号 → 累计时间，另回帧号 → 屏幕光标（五列时）。
- **新增** `cursors: "log"`：第 f 帧光标 = float32(屏幕光标 / 窗口尺寸)。日志里缺的帧沿用前一个已知帧（开头缺就用后一个），结果里列出是哪几帧。日志没有光标列时报错。
- **新增** `window?: [宽, 高]`：缺省从轨迹或日志的标签读 `-<宽>x<高>`；`"log"` 模式推不出就报错。`Timeline` 多回 `window`。
- **新增** 抓到的帧上核对：日志光标与轨迹的 `pointer` 逐帧比，结果里报帧数与最大差；不为 0 时写一行警告，不报错。
- **修改** 光标单位：`"track"`、整串、`cursor` 都是 `g_PointerPosition`（窗口归一化），描述改过来；同尺寸窗口下与现在相同。

### 点 3 — 探针（`apps/wpe-scene/src/dev/`）
- **新增** `renderFrame` 的 `pointers?: [x, y][]`（和 `particles.dts` 等长，不能和 `pointer` 同给）与 `window?: [宽, 高]`：
  - 第 i 帧的 `g_PointerPosition` 取 `pointers[i]`，`g_PointerPositionLast` 取 `pointers[i − 1]`（第一帧取自己）；视差点逐帧用 `pointers[i]`；
  - 控制点光标 = `pointers[i]` 换到场景上；预热用 `pointers[0]` 换算后的值；
  - 换算：`window` 与场景尺寸相同或没给时原样用，不同时 `sceneCursor("fill", scenePlacement("fill", …), …)`，同 kbp replay。
- **修改** `replayParticles` 的 `cursor` 收单个或逐帧；`replayParallax` 收逐帧指针。
- **新增** `particleTrack`、`particleCorners` 的 `window`：`cursors` 照上面换到场景上；`particleCorners` 另收 `pointers`，规则同 `renderFrame`。
- 不给新字段时，三个接口逐字节同现在。

### 点 4 — 插件与 MCP（`scripts/kabegame-dev/`、`apps/kabegame-dev-mcp/src/tools.ts`）
- **修改** 插件的请求校验与转发：render、particle-track、particle-corners 收 `pointers` / `cursors` 与 `window`；`types.ts` 同步。
- **修改** `resolveReplay` 不再拒收逐帧光标：`render_scene`、`particle_corners` 把时间线的光标作 `pointers` 连同 `window` 交给探针，`particle_track` 交 `cursors` + `window`。
- **修改** schema：`cursors: "log" | "track" | [[x, y], …]`，新增 `window`；`pointer` 与逐帧光标不能同给。工具描述里「回放不收逐帧光标」改掉。
- **修改** `describeTimeline`：写清每帧光标从哪来（日志 / 轨迹 / 沿用）、抓到的帧上的核对结果，以及日志带光标列、却没传 `cursors` 时提示一句。

### 点 5 — kbp replay（`kbp-tools/ts/replayLib.ts`）
- **新增** 案例的 `inputs.cursors: "log"`，换算沿用 `"track"` 现成的那段。

### 点 6 — 文档
- `kabegame-chromium/SKILL.md` 的回放参数；`cocs/wpe/WPE_SCENE.md` 粒子节里 dev 探针一句；本节实施记录；未实测清单「工具与边角」第一条划掉。

### 实施方式
子代理在 `ignore/p5/cur/ws/` 的 HEAD 快照里改（`apps/wpe-scene` 用 `kbp snapshot export`，其余目录按原布局 `git archive`，`node_modules` 用目录联接）。Claude 独立验收后三方合并：探针、时间线、kbp-tools 先合；插件与 MCP 的合并要等用户点头（会触发 vite 重启），合完由用户重连 kabegame-dev MCP。

### 验收
1. 单测：时间线（三列 / 五列 / 混用报错、`"log"`、沿用、窗口推断、核对行）、插件校验、探针（同尺寸逐字节同现在、不同尺寸的换算、`pointerLast`）、kbp replay 的 `"log"`。宿主 tsc、vitest、Prettier，`deno test` 两个目录。
2. 不给新字段时：`kbp regress --corpus` 逐字节相同；画面哈希基线 10×3 相同。
3. 端到端：
   - `p5a-cur3` 的 `particle_track`（`cursors: "log"`）与 WPE 逐个比，差 ≤ 2.4e-4，和动工前脚本的结果相同；
   - 用 `cursor=True` 重新生成 `p5a-shakepar` 再抓一次（请用户在窗口上晃鼠标），`render_scene` 带 `cursors: "log"` 整帧和 WPE 比，FR 块之外 0 差异。
4. 变异：`"log"` 取第 f − 1 帧、换算不看 `window`、`pointerLast` 取当帧，各自要有单测或端到端失败。

### 实施记录

子代理在 `ignore/p5/cur/ws/`（HEAD 3d0dc4e9 快照）里实现，基线副本在 `ignore/p5/cur/head/`。

**和计划的偏离（子代理报告，Claude 核对过）：**
- 光标列不止整数：真实日志里有 `1007.9999389648438` 这样的值，按「有限数（含小数、指数）或 `nan`」解析。
- 探针新增 `dev/replayPointers.ts`（窗口指针 → `g_PointerPosition` 与 cursor），`particleCorners.ts` 新增 `replayReadback`，把 `renderFrame` 和 `particleCorners` 各写一遍的「回放到读回帧」合成一处。
- `window` 只跟着逐帧光标交，没给光标的老调用请求体不变。经 MCP 用 `cursors: "track"` 且标签带 `-WxH` 时，现在由探针换算（以前原样交，计划要求的单位统一）。
- 插件现在校验 `pointer` 的形状，格式不对回 400（以前不查）。
- `cursor=True` 生成的工程在 Kabegame 里编译报 `script:api:input.cursorScreenPosition`（`input` 留给 P6）；dev 探针强制渲染不受影响，kbp replay 的案例要放行。已写进生成库与 kbp-tools 的 SKILL.md。

**Claude 独立验收：**
- 越界：真实目录里没有子代理的改动；生成库里一处多余的空格改动（`CLK_VERT =r"""`）已改回。
- 测试（快照）：插件 26 个、MCP 19 个、宿主 tsc 0、vitest 59 个文件 1601 个用例。
- 变异：`"log"` 取第 f − 1 帧 → 时间线单测失败；`pointerLast` 取当帧 → 2 个探针单测失败。子代理另报：换算不看 `window` 3 个、预热取最后一项 1 个单测失败。
- **第一批合进工作区**（三方合并，无冲突）：探针与视差（`dev/probe.ts`、`dev/particleCorners.ts`、`dev/replayPointers.ts` 及测试、`render/parallax.ts` 及测试）、`timeline.ts` 及测试、kbp-tools（`gen.py`、`replayLib.ts`、`SKILL.md`）、`WPE_SCENE.md`。工作区：宿主 tsc 0、vitest 63 个文件 1661 个用例（含 P6 会话正在改的）、MCP 19 个、Prettier 通过；dev 宿主按工作区重建。
- 端到端（插件还没合，`ignore/p5/cur/e2e_probe.ts` 经 `host_eval` 直接调探针，`p5a-cur3` 五列日志在 `ignore/p5/cur/e2e/`）：
  - `particleTrack`（`cursors` + `window`）4 帧 491–495 个粒子，最大差 2.4e-4，同动工前；
  - `renderFrame`（`pointers` + `window`）第 494 帧整帧对 WPE 上屏帧：FR 块外 0 差异，跟随粒子画出的光标轨迹 72826 个白色像素全部相同（`cmp_cur3.py`）；
  - 固定 `pointer` 与「每帧同一个点」的 `pointers` 渲染逐字节相同。
- 不给新字段时：画面哈希 10 张 × 3 档与步骤 4 的基线全部相同；`kbp regress --corpus`（head 对 ws）`same: true`，语料没有变化。
- **第二批**（`scripts/kabegame-dev/*`、MCP `tools.ts` 与 `particles.test.ts`、kabegame-chromium `SKILL.md`）2026-11-11 用户点头后合进去：先在临时目录备好再一次拷入，vite 随之重启一次；用 REST 打 `particle-track` 带 `cursors` + `window` 核对新插件已生效（`check_b2.ts`，结果同上）。工作区：插件 26 个、MCP 19 个测试通过，Prettier 通过。
- **最后一项验收**：`gen_shakepar2.py` 生成 `p5a-shakepar2`（同 `p5a-shakepar`，FR 换成 `FR_CURSOR`），用户在窗口上画圈时抓第 938–941 帧（读回帧前每帧光标移动 40–120 像素）。日志光标与抓到 4 帧的 `pointer` 核对差 0。`render_shakepar2.ts` 经新插件的 render 接口（`pointers` + `window`）渲染第 941 帧，`cmp_shakepar2.py` 对 WPE 上屏帧：FR 块外 0 差异，跟随粒子与透视粒子 1800 个白色像素全部相同，方块位置差 0（C 的中心被我们没跑脚本的纯蓝 FR 块带偏，整帧差为 0，不算）。步骤 3 时 `p5a-shakepar` 的 7 个差异块没有了。用户重连 kabegame-dev MCP 后，`render_scene`（`replay.timeline.cursors: "log"`）复跑：PNG 与脚本那次逐字节相同，时间线说明写出光标来源与核对结果。测试工程 14298、14299 已用 `projects_remove` 移除（图片与任务都确认没了）。
- **提交**：随 `7811d87a` 进了仓库（和 P7a 步骤 3 同一个提交），内容核对过就是验收的版本。

## 未实测清单（P5a 收尾统一走查）

各步按读码或推断实现、还没有实测核对的项，都汇总在这里，P5a 收尾时统一走查（2026-11-10 用户，照 P4d）。每项写清现状、为什么没测到、怎么补；后面的步骤补测了，就挪到「已测」。

**要重新抓 WPE 才能补：**

| 项 | 来源 | 现状与原因 | 怎么补 |
|---|---|---|---|
| `delay > 3` 时 k 为负、P 越走越远 | 步骤 2 | 照公式实现；语料最大 2.0 | 一个 `delay 3.2` 的工程连抓几帧；语料 0 张，可以不补 |
| 预热时相机带不带抖动（跟随指针的粒子预热位置） | 步骤 3 | 我们预热与加载后第一帧的模拟都用 s = (0, 0)。依据是推断：步骤 3 实测粒子模拟用上一帧的相机，加载时还没有更新过相机。t = 0 时抖动偏移是 (amp, 0)，不是 0 | 开抖动、控制点跟随指针、有 `starttime` 的工程，抓开窗后头几帧的粒子位置；语料里同时开抖动和跟随指针的场景很少，可以只记不补 |

**只能在 Kabegame 里真机走查（需要用户看）：** 2026-11-11 用户走查：除「开场」外都和预期一致。「开场」不一致：WPE 打开就在光标位置（delay 0.1 几帧内追上）；我们打开后停在中间，鼠标动一下才滑过去——宿主只在收到 pointermove 时更新指针，预览 iframe 开场收不到，桌面转发只在光标位置变化时注入（`input_forward.rs` 的 `last_move`），跟随指针的粒子同样受影响，待定修法；桌面壁纸光标停在别的窗口上移动时我们也跟随，和 WPE 相同（Windows 的鼠标转发是轮询光标，不只在桌面收到事件时更新）。

| 项 | 看什么 |
|---|---|
| 预览里移动鼠标 | 9 张深度 (0, 1) 的场景（X-Ray 模板 8 张：`2272499163` Rem & Yui、`2279259068` Striped bikini Girl、`2381978484` Celestial Method、`2382002554` Alice 1、`2382120706` Sachiko、`2382121137` CINDERELLA GIRLS、`2570822804` Mona、`2955749185` Nabari；另 `3000769374` 魔女之旅 伊蕾娜）只在纵向动、左右移鼠标不动，方向和光标相反（光标往上、图层往下）；`3445915391` 史尔特尔 同样纵向、iris 照常；`3818481122` 八奈见 图层不动，`depthparallax` 的效果跟着变；`3830255100` AQUAMARINE 的 mouseinfluence 只有 0.04，几乎不跟鼠标，只有静止偏移和抖动 |
| 壁纸样式 | `2381978484`（8192×5479，比 16:9 高）切 `fit`、`center`、`tile`：光标在画面上的位置决定视差点，光标在留白处时图层停在最远处（钳到边），不乱跳 |
| 桌面壁纸 | 设为桌面后（如 `3000769374`），在桌面上移鼠标图层跟着动。WPE 每帧读光标，光标停在别的窗口上移动时照样跟随；我们只在收到桌面的鼠标移动时更新，记下两边是否不同 |
| 开场 | 能渲染的视差场景 `delay` 全是 0.1（`ignore/p5/wk/delays.py`），开场滑动只有零点几秒；看加载时没有跳一下。计划原写的「`delay 2.0` 的 5 张」目前都渲染不了 |
| 重编译保留视差点 | 预览里改一个会整场重编译的属性，画面不跳回中心；换到另一张再换回来，回到中心。上面这些场景没有明显会重编译的属性时可以跳过（渲染器单测已覆盖：`parallax.test.ts`「重编译保留 P」） |
| 暂停与应用背景 | 预览里右键「暂停」后移鼠标图层不动，恢复后接着跟；设成应用背景时不跟鼠标，只有静止偏移 |

**步骤 4 留下的：**

| 项 | 现状与原因 | 怎么补 |
|---|---|---|
| 重编译时状态里的 zoom 和编译期不同 | 预热与第一帧的模拟用编译期的值；属性改 zoom 是就地写，不重编译，只有别的原因整场重编译时才碰得到 | 只记不补 |
| 运行中把 zoom 改成 ≤ 0 | 投影退化、出现 NaN，照计划不处理；语料最小 1.0 | 只记不补 |

**接受、不补：**
- P 用 double 算、WPE 存 float32：`fit_delay.py` 按 float32 复算，差为 0。

**工具与边角：**
- 命中测试的视差偏移（WPE 按对象自身、不按根算）没做，归 W4。
- 透视场景开视差不移动对象（读码，语料 0 张）：P5d 实现透视时，连同透视场景里 `g_ParallaxPosition` 除以 0 再钳制的结果一起核对。
- `alignmentfliph` 水平镜像（`mx = 1 − mx`、`g_ParallaxPosition.x` 翻转）没实现，语料 0 张。

**已测（从清单里划掉）：**
- effect 的中间 pass、透视粒子都带视差：步骤 2 动工前补测 `p5a-fx`。
- 跟随指针的控制点不含视差：步骤 0。
- 场景比例和窗口不同时，视差点用场景宽高：步骤 0 的 `2381978484`，步骤 2 端到端再确认。
- 抖动把 eye 推开后，视差点跟着移：步骤 3 端到端，`p5a-shakepar` 逐像素、`3830255100` 同一 `g_Time` 整帧比。
- 粒子模拟用上一帧的相机：步骤 3 端到端补测 `p5a-shakepar`。
- 缩放与视差、抖动叠加，缩放时透视粒子的相机距离与跟随点：步骤 4 补测与端到端（`p5a-zoompar`、`zoomx15`、`zoomx08`）。
- 回放只收一个固定指针、开窗期间光标动过的抓帧复现不了：收尾前「回放逐帧光标」，`p5a-shakepar2` 整帧 0 差异。
- 收尾走查（2026-11-11，p5-REPORT「收尾走查」）：
  - `parallaxDepth` 绑单个数字的用户属性时铺满两个分量（`p5a-wk-prop`，(0.6, 0.6)）；
  - 运行中改 `parallaxDepth` 属性就地生效（WPE 侧实测；Kabegame 侧由单测锁住：绑定登记成图层字段 `parallax.test.ts`「就地改根的 parallaxDepth」，就地改与整场编译逐字节相同；一个分量时铺满两个也有单测。屏外宿主不加载场景、读不到 applied 计数，开主窗口预览会占用户的图库界面，没做真机计数）；
  - 运行中开关 `cameraparallax`：关时 P 冻结、`g_ParallaxPosition` 留旧值、偏移撤掉，再开时 P 接着走；
  - 脚本写 `cameraparallaxamount`、`parallaxDepth` 同帧生效，读写都通（`p5a-wk-script`）；
  - 没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5)（`p5a-wk-noplx`）；
  - 材质 `/* */` 块注释照常加载；
  - 运行中改 zoom：画面用上一帧写的、粒子模拟用两帧前写的（`p5a-wk-zoom3`），和实现相同；
  - 视差点初值是 (W/2 + 2, H/2 + 2)（相机缺省 eye），已对齐，见「P5a 收尾」的实施记录。步骤 2 记的「`delay 2.9` 回放差 1 像素」就是它，不是光标抓不到。

## P5a 收尾

先按「未实测清单」逐项走查（2026-11-10 用户）。

**实施记录：**
- **WPE 走查（2026-11-11）**：四个工程 `p5a-wk-prop` / `script` / `zoom3` / `noplx`（`ignore/p5/wk/gen_wk.py`），清单里要抓 WPE 的 7 项全部成立，结果在 p5-REPORT「收尾走查」。另查出视差点初值多 (2, 2)。
- **视差点初值对齐（2026-11-11 用户「对齐吧」）**：REA 查清初值是 (W/2 + 2, H/2 + 2)（相机缺省 eye），Claude 直接改 `render/parallax.ts` 的 `initialParallaxPoint`（加常量 `LOAD_EYE = 2`，去掉没人用的 `eye` 参数），`parallax.test.ts` 的初值期望改成 (962, 542)。
  - 测试：宿主 tsc 0、vitest 64 个文件 1701 个用例（含 P6 会话正在改的），Prettier 通过。
  - 数值核对（`ignore/p5/wk/p_product.ts`，产品的 `replayParallax` 按日志逐帧光标推进）：`p5a-wk-prop` 第 176、177、345、346 帧 P 和 WPE 反推值差 ≤ 0.001（改之前差 0.46、0.11）。步骤 2 的 `delay 2.9` 复算（`ignore/p5/s2/fit_delay.py` 起点加 (2, 2)）残差从 (0.37, 0.37) 归零。
  - 端到端：`render_scene`（`cursors: "log"`）回放 `p5a-wk-prop` 到第 177 帧，FR 块外 0 差异。0.46 像素的 P 差落到画面上只有 0.14 像素，这一项只能说明没改坏，对不对靠上面的数值核对。
  - 画面哈希 10 张 × 3 档与步骤 4 的基线全部相同（基线里没有开视差的场景）。测试工程 14308 已移除。

### 收尾：开场指针（2026-11-11 用户「现在修」）

**总体设计思路。** 真机走查发现开场和 WPE 不一致：WPE 每帧 `GetCursorPos`，加载第一帧就用真实光标；我们的宿主只在收到 `pointermove` 时更新指针，预览 iframe 开场收不到，桌面转发只在光标位置变化时注入，所以打开后视差点、`g_ParallaxPosition`、跟随指针的粒子都按场景中心算，鼠标动一下才跳过去。修法是让宿主一开始就拿到一次真实光标：应用页（`WpeSceneView`，预览与桌面共用）在 `interactive` 时向 Rust 问光标在本窗口客户区的位置，按 iframe 的显示矩形换成 iframe 内的归一化坐标，经 `postMessage` 交给宿主；宿主把它当一次 `setPointer`，渲染器还没建好就先存着、建好时带进去（加载时的预热也用上）。之后真正的 `pointermove` 照常覆盖。关键决策：问 Rust 而不是只用父页面记的鼠标位置，因为桌面壁纸窗口的页面收不到鼠标事件、只有注入给 iframe 的；Rust 侧用和鼠标转发同一套映射（`ScreenToClient` + DPI），Windows 之外返回空、退回父页面最近一次收到的鼠标位置。非 `interactive`（应用背景、不交互的预览）照旧不给指针。

**点：**
1. **Rust**（`src-tauri/kabegame/src/commands/wpe_scene.rs`、`lib.rs` 注册）：新增命令，返回调用方窗口里光标的客户区坐标（CSS 像素，`{ x, y }` 或 `null`）。Windows 按 `input_forward.rs` 的映射，其他平台 `null`。主窗口与壁纸窗口免 ACL，只注册。
2. **应用页**（`WpeSceneView.vue`）：`interactive` 时，iframe 建好后（以及宿主报 ready 时再补一次）调命令，用 iframe 的 `getBoundingClientRect` 换算成归一化坐标（不钳制），发新消息 `kabegame:wpe-scene-pointer`；命令返回 `null` 时用本页最近一次 `pointermove` / `pointerdown` 的位置，也没有就不发。
3. **宿主**（`sceneStyle.ts` 的父页面监听、`main.ts`、`host.ts`）：认这条消息（同现有消息只认父窗口、`isTrusted`），收到后 `setPointer`；已经收到过真实 `pointermove` 的就忽略这条初值。`SceneHost` 记住最近的指针，渲染器创建、加载新场景时先带上，预热与第一帧用它。
4. **文档**：`cocs/wpe/WPE_SCENE.md` 里「只在收到 `pointermove` 时更新」的说法改掉；本节实施记录。

**实施记录：** 子代理实现。宿主部分在 `ignore/p5/ptr/ws`（HEAD c22b66a2 快照）里改、Claude 三方合并（7 个文件与基线相同，直接替换）；应用页与 Rust 直接在工作区改。
- Rust：`commands/wpe_scene.rs` 新增异步命令 `wpe_scene_cursor`（取窗口句柄要等主线程回执）与纯函数 `client_to_css`（除以 `dpi/96`，不取整），`lib.rs` 在 `wpe` feature 下注册。
- 应用页：`wpeSceneStyle.ts` 新增消息与按显示矩形换算的 `scenePointerIn`；`WpeSceneView.vue` 在 `interactive` 时于 iframe load 与 ready 各发一次，命令返回 null、出错或在 Web / Android 时退回本页最近一次 `pointermove` / `pointerdown`，等命令期间换了宿主就不发。
- 宿主：`sceneStyle.ts` 认 `kabegame:wpe-scene-pointer`，`scenePointerFeed` 让收到真实 `pointermove` 之后的初值作废；`SceneHost` 记住指针、建渲染器时先于 `load` 带上；`renderer.load` 把先前的原始指针按新场景铺放换成 `g_PointerPosition`。
- 文档：`cocs/wpe/WPE_SCENE.md`、`cocs/README.md` 里「只在收到 `pointermove` 时更新」改掉。
- 检查（Claude 复跑）：宿主 tsc 0、vitest 1708 过 / 1 败（`pipeline.test.ts` 的 `3830255100: 219 次请求`，HEAD 基线上同样失败，与本次无关）；应用 `src/components/wallpaper` 8 个文件 86 个用例过；Prettier 过；Rust `wpe_scene` 10 个单测过（`CARGO_TARGET_DIR=target-check`，dev 占着默认目录），子代理另报 vue-tsc 0、cargo check 0。
- 运行中的应用：Rust 改动后 tauri dev 自己重编、重启了应用；`invoke wpe_scene_cursor` 在主窗口返回 CSS 像素坐标。dev 宿主已按工作区重建。
- 拿不准的：首帧 `g_PointerPositionLast` 仍是 (0.5, 0.5)，和初值之间有一次跳变（WPE 首帧没核对）。
- **真机核对主窗口坐标**（用户同意由我们控制鼠标，`ignore/p5/ptr/cursor_probe.ps1`：per-monitor DPI 感知下 `ClientToScreen` 找客户区、`SetCursorPos` 移到客户区 (0.3, 0.6)）：主窗口带系统边框（外框比页面宽 14、高 37 CSS 像素），客户区 1778 × 1090 物理像素 = 1185.3 × 726.7 CSS，页面 `innerWidth/innerHeight` 1186 × 727；页面收到的最后一次 `pointermove` 是 (355.3333, 436)，`wpe_scene_cursor` 返回 (355.3333, 436)，一致。注意：不开 DPI 感知时 `SetCursorPos` 的坐标被系统按 1.5 倍虚拟化，光标落点不对。当时主页面里只有应用背景的场景宿主（不交互、`pointer-events: none`），预览里的 iframe 换算留到预览打开时再核。
- **真机核对预览换算**（用户打开「超市冰箱八奈见」预览）：预览 iframe 显示矩形 736 × 503.6，宿主文档 7296 × 4992（预览画布缩放）。用户光标在预览上方外面时，父页面算出的初值是 (0.702, −0.137)，不钳制、同 WPE。把光标移到预览中间：宿主收到的真实 `pointermove` 归一化为 (0.499999, 0.499092)，按初值算法（`wpe_scene_cursor` + 显示矩形）算出 (0.500042, 0.499611)，差 < 0.4 物理像素（鼠标坐标量化）。临时监听已停掉。

**验收：** 单测（宿主收初值、早于渲染器的初值被带进加载、真实事件之后的初值被忽略；`WpeSceneView` 在 `interactive` 时发、不交互时不发、换算按显示矩形；Rust 映射的纯函数部分）；宿主 tsc、vitest，应用 vue-tsc 与 vitest，`cargo check`；真机由用户看「超市冰箱八奈见」与一张 X-Ray 场景在预览、桌面的开场不再停在中间。

再和 P4 各节一样统一写文档：
- `cocs/wpe/WPE_SCENE.md`：视差、抖动、缩放与前置几条；
- `cocs/README.md` 的场景文档条目；
- changelog、回归文档；
- 总计划 P5a 节补上完成情况。

## 补修：视差点 float32 与布尔字段绑属性（2026-11-14 用户「好，开始」）

两处问题都是别的阶段走查时发现、转给 P5 的：
- **视差点 float32**：P10b 全屏走查（`phase-10b-script.md`「步骤 4b 补录：全屏窗口」）。
- **视差开关绑数值属性**：P11b 走查 3253330537。

### 总体设计思路

视差点 P 是跨帧累积的状态，WPE 每一步都在 float32 里算、存成 float32；我们的 `parallaxTarget` / `parallaxSmoothing` / `stepParallaxPoint` 还在 double 里算，平滑跟随途中会差 1 ulp，落到画面上是 ±1 像素（P10b 第 76 帧 181 个像素）。`phase-f32-matrix.md` 点 3 只改了 `parallaxOffset`。这次把三个函数按汇编 `0x140189b67`–`0x140189cea` 的结合顺序逐步 `Math.fround`，输入（指针、`1 − ptr.y`、dt、eye、W、H、mi、delay）进来先转 float32。`g_ParallaxPosition` 不改：P 是 float32 时 double 除再存成 float32 等于 float32 除。

布尔类 general 字段（`cameraparallax` 等）写成 `{user, value}` 时，WPE 的 JSON 读取函数（`0x14019b4e0` 一族，各位同一套写法）先按 `value` 的布尔设位，再登记属性绑定；我们直接拿属性当前值取布尔，属性是滑块数字时判成不合法、字段停在缺省 false，`value` 丢了。修法分两半：加载时先取 `value`（同 WPE），属性值再按 WPE 的转换规则改位。转换规则读码没追完（属性写回走的绑定对象虚函数），用步骤 0 的实验定：(A) 不是布尔不改位；(B) 数字非 0 为真。

### 现状锚点

**a. 视差点在 double 里算**（`render/parallax.ts:106`）
```ts
const base = 0.5 * (1 - mi);   // 现状：分配律合并后的写法，WPE 是展开的 (W·0.5)·(1−mi) + (W·mx)·mi
return [input.eye[0] + input.width * (base + mx * mi), input.eye[1] + input.height * (base + my * mi)];
// parallaxSmoothing / stepParallaxPoint 同样全 double
```

**b. 布尔字段取属性当前值**（`compile/bundle.ts:1084`、`compile/bindings.ts:127`）
```ts
const raw = GENERAL_FIELDS[key].type === "bool"
  ? flagValue(general[key], properties, bindings, target)   // 现状：绑属性时返回属性当前值（如 −0.22）
  : bindings.bind(...);
const value = generalValue(key, raw);                       // 现状：bool 只认 boolean，−0.22 → undefined，字段留缺省 false
```

### 步骤 0 — WPE 实验（`ignore/p5/pb/`）

正交 1920×1080，骨架用 `ignore/p5/a0/gen_a.py`（`base_objects`，amount 0.5、delay 0、mouseinfluence 0：P 恒为场景中心，方块 B 在 1460 处开视差时右移 250 像素，不看光标）。判读：抓一帧，按 B 的上屏位置判视差开没开。

| # | `cameraparallax` | 属性 `p` | 区分 |
|---|---|---|---|
| E1 | `{user: p, value: true}` | 滑块 −0.22 | 复现 3253330537（两种规则都开） |
| E2 | `{user: p, value: true}` | 滑块 0 | (A) 开、(B) 关 |
| E3 | `{user: p, value: false}` | 滑块 0.5 | (A) 关、(B) 开 |
| E4 | `{user: p, value: true}` | 复选框 false | 属性布尔能关（对照） |
| E5 | `{user: p, value: false}` | 下拉 `"1"` | 字符串怎么转 |
| E6 | E2 的工程运行中 `apply_properties` p → 0.5 → 0 | | 运行中的转换与加载时是否同一规则 |

**步骤 0 结果（2026-11-14，`ignore/p5/pb/gen_pb.py`，抓帧 `A:\p5a\pb\`，1920×1080，读 B 的 vs_out 中心）：**

| # | 结果 | B 中心 |
|---|---|---|
| E1 | 开 | 1710 |
| E2 | **开** | 1710 |
| E3 | **关** | 1460 |
| E4 | 关 | 1460 |
| E5 | 关 | 1460 |
| E6 | p → 0.5 开、→ 布尔 false 关、→ 1 **仍关** | 1710 / 1460 / 1460 |

结论是 (A)：加载时先按 `value` 的布尔设位；属性值只有布尔才改位，数字、字符串加载与运行中都不改（运行中保持上一次的位）。读码佐证：JSON 读取函数 `0x14019b4e0`（bit1，各位同一写法）对 jsoncpp 类型 5（布尔）直接设位，类型 7（对象）只读 `value` 且是布尔才设位，之后调 `0x1401a4db0` 登记绑定。我们运行中的写入（`generalValue` 非布尔返回 undefined）已经符合，只有加载丢了 `value`；`flagValue` 一处改动覆盖全部布尔 general 字段与 `bloom` / `hdr`。顺带：E6 说明属性值是数字时运行中改值不会让位回到 `value`。

图层 `visible` 绑非布尔属性走的是 `bindingValue` 的 `value !== false`（数字算真），和这里的规则不同，没有实测，不在本次范围。

### 点 1 — 视差点 float32（`render/parallax.ts`）
- **修改** `parallaxTarget`、`parallaxSmoothing`、`stepParallaxPoint`：照汇编顺序逐步 `Math.fround`（目标 `f(f(f(f(W·0.5)·f(1−mi)) + f(f(W·mx)·mi)) + eye.x)`，y 项是 `f(my·H)`；`k = min(1, f(f(f(1 − f(delay/3))·10)·dt))`；`P = f(f(f(目标 − P)·k) + P)`）。
- 文件头的公式说明补一句 float32 与出处。

### 点 2 — 布尔字段绑属性（`compile/bundle.ts`、`compile/bindings.ts`、`render/state.ts`，范围按步骤 0 定）
- 加载：`{user, value}` 先取 `value` 的布尔，再按属性值的转换规则覆盖。
- 运行中：`SceneState.write` 的 general 布尔分支用同一个转换函数（「就地 = 重编译」）。
- `flagValue`（`bloom` / `hdr`）共用同一转换。

### 验收
- 单测：`parallax.test.ts` 加逐步 float32 的对照；`p3c.test.ts` / `p3a.test.ts` 加布尔字段绑滑块 / 复选框 / 下拉的加载与就地写。
- 数值：P10b 录像 `A:\p10b\s4b\clk61-w0-fps20-3840x2160\` 第 76–78 帧逐像素 0 差（`ignore/p10/b4b/draws_at.py`、`walk.py`）。
- 3253330537：wpe p11 的复制工程 `ignore/p11/proj/3253330537-iso-ut-blend` 改回绑定写法，和 `A:\p11b\s5\3253330537-iso-ut-blend-fps20-3840x2160` 比。
- E1–E6 工程在 Kabegame 渲染，结论与 WPE 相同。

### 实施记录（2026-11-14）

子代理（Sonnet）直接在工作区改（`parallax.ts`、`parallax.test.ts` 没有别人的改动；`postprocess.ts` 只动 `flagValue` 一个函数，别的会话的未提交块不在附近），Claude 独立验收。
- **`render/parallax.ts`**：三个函数按汇编顺序逐步 `fround`；`parallaxSmoothing` 的 min 照 WPE 写 `1 > x ? x : 1`（x 为 NaN 得 1）。
- **`compile/postprocess.ts` 的 `flagValue`**：`{user}` 先照旧调 `bindings.bind`（登记绑定），解析结果是布尔就用，否则退回对象自己的 `value`（是布尔才用）。
- **测试**：`parallax.test.ts` 加独立的逐步 f32 参考实现与 108 组输入、9 帧链；Claude 补一条写死期望值的结合顺序用例（mi −0.22，合并写法与「y 项不先取 f」各差 1 ulp）。两个旧用例因 P 变成 float32 放宽到 `toBeCloseTo(…, 3)` / 按 f32 算期望。新建 `compile/p5a-flag.test.ts`（E1–E5、条件绑定、绑定照登记、经 `compileScene` 的 `cameraparallax`）。`p2b.test.ts` 第 113 行（P3c `75293ab1` 按静态推断写的「`hdr` 绑字符串属性、`value: true` → `hdrFlag` false」）按本次实测改成 true，另加一条 `value: false` + 数字 → false。
- **检查（Claude 复跑）**：宿主 tsc 0；vitest `parallax` / `p5a-flag` / `p3c` / `p3a`（compile、render）/ `p2b` / `replayEncoded` / `replayPointers` / `p5d-camera` / `p5d3-camera` / `renderer` / `host` 全过；Prettier（改动的 5 个文件；`postprocess.ts` 只检查、没整文件格式化）。
- **变异**（`ignore/p5/pb/mutate_pb.py`，按原字节还原）：目标 x 改回合并写法、y 项不先取 f、k 去掉 fround、平滑步去掉 fround、`flagValue` 退回旧逻辑，5 个全被抓住（补那条写死期望值的用例之前，前两个没抓住）。
- **端到端**（`buildSceneHost.ts` 重建 dev 宿主产物 `index-0KeAvZOE.js`）：
  - P10b `clk61-w0`（3840×2160，`ignore/p5/pb/walk10.py`，读 `ignore/p10/b4b/out` 已导出的 WPE 帧）：第 76–78 帧逐像素相同（改之前第 76 帧 181 个像素 ±1），读回帧逐 draw 0 ulp；`clk61-w2` 第 64–66 帧同样相同。
  - E1–E5：E1、E2 画面相同、B 在 1710；E3、E4、E5 画面相同、B 在 1460。和 WPE 一致。
  - 3253330537：p11 的复制工程拷到 `ignore/p5/pb/3253330537-plx`，`cameraparallax` 改回 `{user: newproperty16, value: true}`、用户纹理路径改到副本自己的 `kbp-ut.png`；和 `A:\p11b\s5\3253330537-iso-ut-blend-fps20-3840x2160` 第 220、221 帧（日志逐帧光标、ultra）逐像素 0 差。这张场景的鼠标影响是 −0.22、画面随光标动，0 差也说明这次录制的日志光标（144 DPI、无边框 3840×2160）按「屏幕光标 ÷ 窗口尺寸」换算是对的。
  - 测试工程 14835–14842 已用 `projects_remove` 移除。
- **已知差异**：运行中属性在布尔与非布尔之间换类型（只有 `apply_properties` 这类外部写法能做到）之后再遇到整场重编译，我们按「当前属性值 → 否则 `value`」重新求值，WPE 保留运行中的位。语料不会出现。

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
