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

动工前写细。内容见总计划「前置」与上表。验收：`3778549173` 解锁并和 WPE 比画面；语料的变化只在这几个键上，现有基线逐张相同。

## 步骤 2 — 视差

动工前写细。要点：
- 帧开头（脚本之前）算 P 与 `g_ParallaxPosition`，状态跨帧保留；重编译保留 P。
- 每次绘制按根对象算 `o`，乘到视图上；图像层、粒子、带 effect 图层的上屏都经过。
- `g_PointerPosition` 交给视差；没收到过指针时取场景中心。
- `parallaxDepth` 进图层字段：用户属性就地、字段脚本写回、脚本 API 放开。
- 能力表放开 `general:cameraparallax` 与 `uniform:g_ParallaxPosition`。
- 确定性回放：dev 探针接受一串指针，和 WPE 的抓帧逐帧比。

验收：11 张解锁；`p5a-*` 工程逐 uniform 一致；`3830255100` 的静止偏移和 WPE 一致（步骤 3 后整张比）。

## 步骤 3 — 抖动

动工前写细。纯函数 `shakeOffset`，加到 eye 与 center 上。验收：`3830255100` 解锁，和 WPE 同一 `g_Time` 的画面比；`p5a-shake` 逐帧一致。

## 步骤 4 — 缩放

动工前写细。正交投影绕场景中心乘 `zoom ×` 相机 zoom。验收：`p5a-zoom` 和 WPE 一致；`general:zoom` 只在关键帧等别的原因下继续报。

## 决定

**已定：**
1. 前置并进本子计划的步骤 1（2026-11-10，用户进入 P5a）。
2. 抓帧不移动用户的鼠标，指针从 CLK 层读（总计划 P5a「指针怎么控」）。

**待定：** 无。

## 风险

1. **静止偏移若被推翻：** 公式要重查，`3830255100` 的验收跟着变。
2. **平滑与帧率相关：** k 含 dt，确定性对比要固定 fps，回放也要按 WPE 的 dt 走。
3. **光标位置不可控：** 若开窗时光标恰好在窗口中心，`p5a-ptr` 区分不了插值；那时换 `mouseinfluence` 的取值放大差别，或者请用户把光标挪开。
