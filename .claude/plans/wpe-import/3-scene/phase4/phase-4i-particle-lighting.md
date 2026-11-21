# P4i — 粒子光照（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)。2026-11-21 用户指出 myprojects 的 `3823357259`（Talia Yang / Cyberpunk Edgerunners 2）只差一个不支持项 `particle:lighting`，让 P4 接手。语料里没有别的场景用到粒子光照。
> 步骤 0 只调研；之后每步能单独验收、单独提交。数据放 `ignore/p4/i0/` 起。

## 总体设计思路

WPE 的粒子光照全部在着色器里：`genericparticle` / `genericropeparticle` 的 `LIGHTING` 分支多输出世界坐标、视线与切向，片元把法线取成视线方向（有法线图时按 `v_WorldRight` 与视线搭出切空间），调 `#require LightingV1` 生成的 `PerformLighting_V1` 累加场景里的灯，再按 `color = CombineLighting(light, g_LightAmbientColor · color)` 合成。引擎侧要给的东西和图层、模型的光照完全一样：`g_ModelMatrix`、`g_EyePosition`、`g_LightAmbientColor`、整块灯光缓冲与 `LIGHTS_*` 宏，阴影灯在场时还有阴影图集。这些在我们这边都已经是共用路径：粒子绘制和图层走同一个 draw 构建函数，块里声明了灯光数组就每帧写（`frameNames`），`usesLighting` 的程序同样让 bundle 带上 `lights`，翻译器的 `LightingV1` 在 P13 已经完整。

所以 P4i 不新增渲染逻辑，核心是**拿掉能力表的门**：`checkParticleProgram` 不再因为 `LIGHTING` 报 `particle:lighting`，`DOUBLESIDEDLIGHTING` 进粒子允许的 COMBO 表。步骤 0 的任务是用确定性工程证明「去掉门就对」：在强制渲染下，11 组工程（环境光、换色环境光、点光、平行光 + 聚光、对象变换与世界空间、亮灯、HDR + 泛光、雾、绳、拖尾 + 法线图、阴影图集）和 WPE 整帧逐像素比，结论见下面的实施记录。

## 范围与解锁

- 场景：`D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\myprojects\3823357259`（`scene.pkg`，正交、`hdr: false`、`bloom: false`、环境光 0.3、没有灯）。18 个粒子对象用工坊 `3778352003` 的「Thunderbolt」预设，每个雷电系统挂同一个光晕子系统 `particles/workshop/3778352003/presets/thunderbolt_glow.json`，材质 `materials/workshop/3778352003/presets/thunderbolt_glow.json`：
  ```json
  {"passes":[{"alphawriting":"default","blending":"additive","combos":{"LIGHTING":1},"cullmode":"nocull",
    "depthtest":"disabled","depthwrite":"disabled","shader":"genericparticle","textures":["particle/halo"]}]}
  ```
- 扫描：`kbp corpus scan --project <目录> --only 3823357259` 只报 `particle:lighting`；做完预计能渲染 +1。
- WPE 自带的预设粒子没有用 `LIGHTING` 的（`assets/materials`、`assets/particles` 里搜不到）。

## 现状锚点

**a. 能力表的门**（`compile/features.ts` 的 `checkParticleProgram`）
```ts
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND", "REFRACT", "CUTOUT", "NORMALMAP", "ALPHATOCOVERAGE", "ADDITIVE"]);
export function checkParticleProgram(pass, result, unsupported): void {
  …
  for (const [name, value] of combos) {
    if (value === 0 || PARTICLE_COMBOS.has(name)) continue;
    // 现状：LIGHTING 报 particle:lighting，DOUBLESIDEDLIGHTING 报 particle:combo:DOUBLESIDEDLIGHTING
    unsupported.add(name === "LIGHTING" ? "particle:lighting" : `particle:combo:${name}`);
  }
  // 现状：最终开了光照（含着色器缺省值）也报
  if (result && usesLighting(result)) unsupported.add("particle:lighting");
}
```

**b. 灯光数组已经走共用路径**（`compile/bundle.ts` 编 pass 的函数，粒子 pass 也走这里）
```ts
uniforms: {
  ...shaderUniforms(result, pass, properties, context.key, bindings, issues),
  // 现状：任何开了光照的程序（含粒子）都让 bundle 带上 lights，渲染器每帧写整块灯光缓冲
  ...(result?.ok && usesLighting(result) ? (sceneLights(), {}) : {}),
  …
},
```
渲染器 `render/scene.ts` 建 draw 时把块里声明了的 `LIGHT_FRAME_UNIFORMS` 记进 `frameNames`，`update` 每帧写；粒子 draw 用同一个函数。

## 步骤 0 — 调研（2026-11-21）

不改产品代码。

### 0a 读码

- **着色器**（WPE `assets/shaders/genericparticle.vert/.frag`、`genericropeparticle.*`、`common_pbr_2.h`）：
  - 顶点：`FOG_DIST || FOG_HEIGHT || LIGHTING` 时 `worldPos = mul(vec4(position, 1), g_ModelMatrix)`、`v_ViewDir = (g_EyePosition − worldPos, worldPos.y)`；`LIGHTING` 时另输出 `v_WorldPos`、`v_WorldRight = mul(right, CAST3X3(g_ModelMatrix))`（拖尾的 `right` 来自 `ComputeParticleTrailTangents`）。
  - 片元：`N = normalize(v_ViewDir)`，有 `NORMALMAP` 时 `N = V·n.z + R·n.x + cross(R, V)·n.y`；没有法线图时强制 `DOUBLESIDEDLIGHTING 1`；`light = PerformLighting_V1(v_WorldPos, color.rgb, N, V, 1, 0.04, 0, 0)`，`color.rgb = CombineLighting(light, g_LightAmbientColor · color.rgb)`，之后才乘 `g_Overbright`、走折射 / 雾。`g_LightSkylightColor`、`g_ViewRight`、`g_ViewUp` 声明了但不读。
  - `CombineLighting`：非 HDR 是 `ambient + light`；HDR 是 `saturate(ambient + light) + light · overbright`。
  - `#require LightingV1` 在翻译器里已完整（P13d / P13i / P13k）；没有灯时 `sum = 0`，结果就是环境光 × 颜色。
  - 阴影灯在场时着色器读 `_rt_shadowAtlas`（`LIGHTS_SHADOW_MAPPING`）；粒子不投射阴影。
- **我们的路径**：见现状锚点 b。粒子 draw 的 `g_ModelMatrix` 是 P4c 的规则（本地系统 = 对象世界矩阵，世界空间系统 = 单位阵），`g_EyePosition`、环境光、雾 uniform 是全部 pass 共用的引擎 uniform。
- 不派 REA：引擎侧没有粒子专属的光照逻辑要读，着色器原文就是读码依据；引擎给的 uniform 用整帧比对验证。

### 0b 确定性工程与实测

- **工程**：`ignore/p4/defs/p4i0.py`（`kbp gen p4i0`），每格一个对象、一颗静止粒子（`rate 0`、`instantaneous 1`、速度 0、不死），任何一帧都相同。11 个工程：

  | 工程 | 内容 |
  |---|---|
  | `p4i-amb` | 无灯，环境光 0.3；12 格：不打光对照、白 / 橙、半透明、additive、显式双面、`g_Overbright 2.5`、Talia 的光晕材质原样、不打光光晕、法线图、法线图 + 双面、大尺寸 |
  | `p4i-amb2` | 同上，环境光 `0.8 0.4 0.1`、天光 `0 0.5 1` |
  | `p4i-point` | 同上 + 两盏 `lpoint`（不同颜色、强度、半径、`exponent`） |
  | `p4i-spot` | 同上 + `ldirectional` + `lspot`（朝 −z） |
  | `p4i-xform` | 本地 / 世界空间系统各 4 种对象变换（缩放、z 旋转、x 旋转、三轴）、法线图旋转、z = −400 的粒子；一盏点光 |
  | `p4i-hdr` | `hdr: true`、`bloom: false`（WPE 规则下 HDR 不生效，等于亮灯组） |
  | `p4i-hdrb` | `hdr: true`、`bloom: true`：`CombineLighting` 的 HDR 分支 + 泛光 |
  | `p4i-fog` | p13f-fog-ortho 的雾参数 + 点光（雾与光照共用 `v_ViewDir`） |
  | `p4i-rope` | 6 颗粒子的静止 rope，打光 / 不打光各一条，一盏点光 |
  | `p4i-trail` | spritetrail（不挂 `movement`：带速度但不动，拖尾整段静止），白 / 法线图、三种速度方向、对象旋转、世界空间 |
  | `p4i-shadow` | `lpoint` + `castshadow`、`lightconfig.pointshadow 1`（读阴影图集），场景里没有投射者 |
- **抓帧**：`A:\p4i\<工程>\`（1920×1080，2 帧，WPE 设置 fps 20、postprocessing ultra、shadows low，没改设置），导出 `ignore/p4/i0/wpe/`；HDR 组的后备缓冲是 RGBA16F，按 P13 的办法 sRGB 编码后就近取整（`ignore/p13/h/walk/dds_f16_to_png.py … srgb`，输出 `ignore/p4/i0/hdrpng/`）。
- **我们**：dev 应用强制渲染（`render_scene`，`canvas` 1920×1080、`postprocess ultra`、10 帧 0.05 s 回放），`ignore/p4/i0/ours/`；导入清单 `ignore/p4/i0/import.json`、`import2.json`。
- **结果**（`kbp cmp frame --meta`，排除 FR / CLK）：

  | 工程 | 不同像素 | 最大差 | 说明 |
  |---|---|---|---|
  | `p4i-amb`、`p4i-amb2`、`p4i-point` | 0 | 0 | 逐像素相同 |
  | `p4i-spot` | 4 | 1 | 浮点舍入 |
  | `p4i-xform` | 1 | 1 | 同上 |
  | `p4i-hdr` | 2 | 1 | 同上 |
  | `p4i-shadow` | 1 | 1 | 同上 |
  | `p4i-fog` | 4 | 1 | 同上 |
  | `p4i-trail` | 1867 | 1 | 法线图拖尾的切向归一化舍入，集中在旋转 / 斜向的格子 |
  | `p4i-hdrb` | 80276 | 2 | 泛光光晕渐变上的 f16 存储量化（同 P13h 的 `3509243656`） |
  | `p4i-rope` | 5 | 143 | 1 个三角形边缘像素的覆盖不同（WPE 那格没画，顶点舍入，见下），另 4 个差 1；光照颜色本身相同 |

- **`p4i-rope` 那个边缘像素的解释**（2026-11-21，按 [FINAL_CHECK.md](../FINAL_CHECK.md) 落到 draw；脚本在 scratchpad，数据 `ignore/p4/i0/rope/`）：
  - 像素 (1114, 114) 贴着 WPE event 54（打光的绳）第 3 段三角形 32 的外边 v98→v96。
  - 照 gs_5_0 反汇编逐条模拟：FMA 的 float32 结果和 RenderDoc gs_out 逐位相同（公式一致）。float64 精确值下，像素中心在边外 0.00085 px。
  - 这比光栅化的 1/256 px 吸附网格还小。v96 的 x 离吸附边界只有 1 个 float32 ulp，v98 差 3～6 ulp；任一顶点换一格，边就会挪 0.0005～0.0023 px，像素中心随之翻到另一侧。
  - 我们把几何着色器展开进顶点着色器（Tint → D3D12，指令顺序与 FMA 融合和 fxc 不同），顶点末位差几个 ulp 就决定这一格。归为顶点舍入的已知差异，不复刻。
  - 我们这边的顶点值没有直接测到：`trace` 只记顶点输入，没有顶点着色器输出（`TODO:[WPE_SCENE_MCP]` 走查工具缺口：逐 draw 轨迹带上裁剪空间位置）。

- **读码 ↔ 实测**：环境光 × 颜色（amb、amb2，天光不读）、灯的累加与 `ComputePBRLight*`（point、spot）、没有法线图时强制双面 / 法线图的切空间与 `v_WorldRight`（nm、nmds、xform 的 nmr / nmx / nmw、trail）、`g_ModelMatrix` 的本地 / 世界规则（xform）、`g_Overbright` 在光照之后（ob）、HDR 分支（hdrb）、雾与光照共用视线（fog）、rope 着色器（rope）、阴影图集（shadow）都有用例，全部对上，没有更正。
- 现有渲染器在强制渲染下已经全部画对，所以步骤 1 只改能力表。
- 顺带发现：`DOUBLESIDEDLIGHTING`（`LIGHTING` 的子开关，只在 `common_pbr_2.h` 里读）会被单独报成 `particle:combo:DOUBLESIDEDLIGHTING`，步骤 1 一起放行。
- 真实场景参照：`A:\p4i\talia\`（1920×1080，3 帧），步骤 1 走查用。

## 步骤 1 — 放行（2026-11-21 用户确认开始）

### 点 1 — 能力表（`compile/features.ts`）

- **修改** `PARTICLE_COMBOS` 加 `LIGHTING`、`DOUBLESIDEDLIGHTING`；`checkParticleProgram` 删掉最后一行的 `usesLighting` 判断与循环里的 `LIGHTING` 特判；头注释把「报 `particle:lighting`」改成 P4i 的依据（着色器 + 共用的灯光路径 + 11 组整帧对照）。
```ts
const PARTICLE_COMBOS = new Set([
  "WORLDBLUR", "USERCOLORBLEND", "REFRACT", "CUTOUT", "NORMALMAP", "ALPHATOCOVERAGE", "ADDITIVE",
  "LIGHTING",             // 新增：P4i
  "DOUBLESIDEDLIGHTING",  // 新增：P4i，LIGHTING 的子开关
]);
export function checkParticleProgram(pass, result, unsupported): void {
  …
  for (const [name, value] of combos) {
    if (value === 0 || PARTICLE_COMBOS.has(name)) continue;
    unsupported.add(`particle:combo:${name}`);   // 修改：不再特判 LIGHTING
  }
  // 删除：if (result && usesLighting(result)) unsupported.add("particle:lighting");
}
```

### 点 2 — 测试

- **修改** `compile/particles.test.ts`「LIGHTING 非 0 报 particle:lighting」、`compile/refract.test.ts`「LIGHTING 仍报 particle:lighting」改成不报。
- **新增** `compile/p4i1.test.ts`：开了 `LIGHTING` 的粒子材质（材质写的、着色器缺省值两种）不报不支持项、bundle 带 `lights`（只有粒子开光照时也带）、`DOUBLESIDEDLIGHTING` 不报、别的未知 COMBO 照报。
- **变异**：恢复 `particle:lighting`；`PARTICLE_COMBOS` 去掉 `DOUBLESIDEDLIGHTING`；粒子 pass 不调 `sceneLights()`（点光组画面应当变）。

### 点 3 — 回归与走查

- `kbp corpus scan` 全库与 myprojects：缺省语料 233 张结果不变；myprojects `3823357259` 从 1 项到 0 项。
- 确定性工程去掉强制渲染再画一遍（`render_scene` 的 `unsupported` 为空），和 `ignore/p4/i0/ours/` 逐字节相同。
- `3823357259` 在 dev 应用里预览，和 `A:\p4i\talia` 目视比（雷电粒子有随机，只看光晕的颜色与亮度）。

### 收尾

`cocs/wpe/WPE_SCENE.md`「粒子（P4i）」、`cocs/README.md`、回归文档、changelog、`phase-4-particles.md` 补遗；可以和步骤 1 一起提交。

### 步骤 1 实施记录（2026-11-21）

- **代码**：`compile/features.ts` 照点 1 改（`PARTICLE_COMBOS` 加两项、去掉 `particle:lighting`，注释写依据）；`compile/particles.test.ts`、`refract.test.ts` 的旧用例改成不报，别的 COMBO 的例子换成 `SPECULARMAP`；新增 `compile/p4i1.test.ts`（假翻译器 3 条：只有粒子开光照时 bundle 带 `lights`、没灯也不报、没开光照不带；真翻译器 3 条：`3823357259` 的光晕材质原样、两盏点光的 `LIGHTS_POINT` 与点光数组、rope）。三个文件 142 条通过（`KABEGAME_WPE_ROOT` 指向 WPE，真翻译器的用例没有跳过）。
- **变异**（`ignore/p4/i1/mutate_i1.py`，工作区模式，`bundle.ts` 里有别的会话没提交的改动）：恢复门、`DOUBLESIDEDLIGHTING` / `LIGHTING` 不在放行表、粒子 pass 不调 `sceneLights` 4 处全部检出，按原字节还原，源码树哈希前后相同。
- **放行后画面**：重建 dev 宿主（`CARGO_TARGET_DIR=target-dev`，dev 读这里；不设时写 `target`），不开强制渲染画 `p4i-amb` / `amb2` / `point` / `spot`：`unsupported` 为空、像素摘要和步骤 0 逐字节相同；11 个工程编译扫描全部干净（`ignore/p4/i1/p4i-scan.json`）。
- **语料**：缺省语料 233 张全部干净（`ignore/p4/i1/default.json`）；myprojects 现在 437 张（`ignore/p4/i1/my.json`），`3823357259` 干净；另有 6 张新下载的不干净（`3834803915` 的 `particle:dependencies` / `particle:emitter:layerimage`、`3798696286` 的声音 min/max time 绑定、`3816948983` 纹理格式 12、`3817265356` 纹理越界、两张缺场景入口），和 P4i 无关；上次转给 P7、P14 的 `3784410673`、`3834692798` 已经干净。
- **走查 `3823357259`**：
  - 解包成 `ignore/p4/proj/3823357259-kbp`（`--instrument`），WPE 抓 `A:\p4i\3823357259-kbp-fps20-1920x1080\`。按日志时间线回放第 222 帧不报不支持项，但 17 个雷电系统一颗都没发：雷电预设按音频发射（`audioprocessingmode 3`），WPE 抓帧时本机在放声音，探针没给频谱。
  - 于是做复制工程 `3823357259-noaudio`（16 个雷电粒子文件的 `audioprocessingmode` 改 0，两边同一份），WPE 抓 `A:\p4i\3823357259-noaudio-fps20-1920x1080\`，回放第 248 帧（`ignore/p4/i1/ours/talia-noaudio-f248.png` 对 `ignore/p4/i1/wpe/…-f248.png`）：雷电的颜色、光晕亮度、分布区域一致；雷电随机发射，只目视比，光照的逐像素证明在步骤 0（`halo` 格就是这张的光晕材质，0 差异）。顶部 / 底部文字是脚本写的日期时间，探针没跑脚本。**这一条按 FINAL_CHECK 不算结论（目视比），由下面的「最终走查」取代。**
  - 测试工程全部 `projects_remove`。

## 最终走查（2026-11-21，用户「按 FINAL_CHECK 验收」）

按 [FINAL_CHECK.md](../FINAL_CHECK.md) 原则 1–5 重做 `3823357259`，并把步骤 0 里归成「浮点舍入」的残差落到值上。脚本与数据在 `ignore/p4/i2/`。

### 复制工程 `3823357259-iso`

- **复制**：`kbp content isolate 3823357259 --keep 259 --instrument`（只留雷电 259 与插桩 FR；259 是根，没有父链；它下面挂的 16 个子雷电删掉）。再用 `ignore/p4/i2/make_iso_fixed.py` 换固定值（WPE 粒子随机数按时间做种、不可复现，同 P11b2）：
  - 雷电本体：发射器 `audioprocessingmode` 3 → 0（随系统音频发射，录不下整段历史）；`sizerandom` / `colorrandom` / `velocityrandom` 收成一个值；`oscillatealpha` 频率、幅度收成一个值、相位 0；去掉 `oscillateposition`（y 方向无条件加 `2π·R`，收不掉）和 eventfollow 分叉子系统（`probability 0.2`，分叉全是随机项，和光晕无关）；
  - 光晕：`sphererandom` 距离 0，寿命 / 尺寸 / 颜色 / alpha 收成区间中点。
  - 不动：光晕材质（`genericparticle` + `LIGHTING`、additive、halo）、eventspawn 结构、renderer、对象 259 的变换与 `instanceoverride`（`colorn`、控制点）。`turbulence`（速度 min = max、相位区间缺省 0）、`positionoffsetrandom`（只看时间）、`mapsequencebetweencontrolpoints`（不抽随机数）、周期发射（min = max）本来就确定。
- **WPE**：`capture_sweep` 24 帧，1920×1080、fps 20、后处理 ultra（WPE 当前设置，没改），`A:\p4i\3823357259-iso-fps20-1920x1080\`，日志 `ignore/p4/out/`，整帧图 `ignore/p4/i2/wpe/`。一个发射周期里光晕只在第 240 帧（10 个 eventspawn 实例、各 1 颗，尺寸随 `sizechange` 涨到铺满全屏）；第 240 帧 rdc 的光晕片元着色器就是 `纹理 × 顶点色 × g_LightAmbientColor(0.3) × g_Overbright`（没有灯时编译器把灯光累加消掉了），和读码一致。
- **Kabegame**：导入后 `renderFrames.ts` 按日志时间线回放 232–255 帧（`--cursors log`、`--canvas 1920x1080`、ultra），`kbp cmp frames`。

| 帧 | 结果 | 定位 | 结论 |
|---|---|---|---|
| 232–239、251–255（13 帧，没有雷电） | 逐像素相同 | — | 相同 |
| 240（光晕铺满全屏 + 绳） | 1423 像素不同，最大 61 | 光晕区（离绳 > 30 px）11.6 万个染色像素里 673 个差 1，全是我们偏亮（只在 R、B；G 被 `colorn` 乘成 0）；其余在绳上 | 见下 |
| 241–250（只有绳） | 482–4237 像素不同，最大 13–52 | 全在绳周围 30 px 内 | 见下 |

**逐粒子**（`kbp rdc track … --log`，scene 认法；我们 `particle_track` 同一时间线；`ignore/p4/i2/tracks/`）：
- 光晕 10 个实例每帧都配上：位置、颜色差 0，alpha 最大差 1.74e-5、尺寸 0.10。
- 绳在 WPE 里按段画（几何着色器输入 N−1 段），scene 认法把段当粒子，所以每帧「少 1 颗」；按段起点对（`rope_cmp`，脚本在 scratchpad）：颜色差 0，位置差沿控制点 0 → 1 的连线线性增长（第 k 颗 ≈ k·(−0.019, +0.082)，相对 1.1e-3），第 240 帧 0.74 → 第 250 帧 15.9 像素。
- **根因**：`maintaindistancebetweencontrolpoints` 的 `q = rsqrtps(n)`（rea 3.2）。控制点静止时每做一次，粒子沿连线的分量乘 (1 + 2e)，e = rsqrtps 的相对误差；我们按精确值，e = 0。本机 CPU 的 `rsqrtps(n = 5456919) = 4.2802095e-4`（`0x39e06800`），e = −1.409e-4，和从轨迹反推的 −1.45e-4 一致（两遍模式每帧两次）。光晕的 alpha / 尺寸差是 `alphafade` / `sizechange` 的 `age · rcpps(life)`。
- **验证**：临时把 `rcp` / `rsqrt` 对 5 个常数输入换成本机硬件值（`rsqrt(5456919)`、`rcp(0.15)`、`rcp(1)`、`rcp(0.5)`、`rcp(30)`，`// DEBUG-p4i-hw`，已删、宿主重建回原产物）：光晕 10 个实例位置 / 尺寸 / alpha / 颜色**逐位相同**；绳位置最大差 3e-5（float32 末位，余下的是逐粒子长度的 `rsqrtps`，`reducemovementnearcontrolpoint`）、alpha 3e-8、尺寸 0；**整帧 240–250 逐像素相同**（`ignore/p4/i2/ours-hw/`）。
- **结论**：24 帧在产品下 13 帧逐像素相同，11 帧的差异全部来自 `rcpps` / `rsqrtps` 不复刻（已知差异，P4a 起的决定，P4d「maintaindistance 的 rsqrtps」、P11b2 走查同类）；换上硬件值后 24 帧全部逐像素相同。被测的光晕光照没有差异。

### 步骤 0 残差的定位

- **差 1 的零星像素**（spot 4、xform 1、hdr 2、shadow 1、fog 4）：每个只有一个通道差 1。照 `common_pbr_2.h` 与 WPE 抓帧的灯光常量用 float64 算精确值，差的那个通道离 0.5 级边界 0.002–0.047 级，没差的通道远（0.09–0.46）。整格对照（`p4i-spot` 的 `big` 格 76800 个分量）：float64 模型和 WPE、和我们各差约 3770 个，WPE 和我们之间只差 2 个，即两块 GPU 的 float 结果几乎一致，翻 2 个对应平均约 2.6e-5 级（约 1e-7，1–2 个 float32 ulp）的差：fxc 与 Tint / DXC 编出的指令顺序、FMA 不同。已知差异（着色器舍入）。
- **`p4i-trail` 的 1867 像素**：全在带法线图的拖尾上（`tnm` 0.21%、`tnmd` 0.68%、`tnmr` 1.04%、`tnmw` 0.33%，按格子分时伸进 `tu` 格的 395 个也是它们的；纯白 255 的 `tu` 不可能差 1），白色带光照的 `tw` / `twd` 0 差异。拖尾四角 WPE 在几何着色器、我们在顶点着色器里算，末位不同；白色粒子的光照随位置平滑变化，翻不过整数级；`drop_normal` 梯度陡，uv 的末位差被放大成光照值的差。已知差异（着色器舍入经法线图放大）。
- **`p4i-hdrb` 的 8 万像素、最大差 2**：不打光的 `unlit`（1448）、`halou`（398）格同样有差，和光照无关；全在泛光渐变，是 WPE 后备缓冲 RGBA16F 的存储量化（同 P13h `3509243656`）。
- **`p4i-rope` 的 143**：见步骤 0「`p4i-rope` 那个边缘像素的解释」（顶点吸附 1/256 px 的舍入）。
