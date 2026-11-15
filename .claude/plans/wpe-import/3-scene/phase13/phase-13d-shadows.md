# P13d — 阴影（子计划）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13d」。读码：[rea-p13-passes.md](rea-p13-passes.md) 第 2 节（图集、点光六面、平行光级联、阴影 pass、uniform 与宏、比较采样器、`disabled`）与第 5 节（一帧的顺序）。实测：[p13-REPORT.md](p13-REPORT.md) 第 8–10 行（图集边长、点光投影、比较采样器）。

## 总体设计思路

WPE 的阴影分两半。**投射**：每帧在灯光 uniform 那一步（脚本之后、反射与主 pass 之前），每盏 `castshadow` 的投影灯在图集 `_rt_shadowAtlas` 里占几块（点光一块，块内 2 × 3 放六个面；平行光三级级联、每级一块），只把不透明的模型按每个视图画进深度。**接收**：开了 `LIGHTING` 的材质由 `#require LightingV1` 现场生成的灯光循环对带阴影的灯多算一个 `shadowFactor`：世界坐标按灯的视图投影投到图集里，用比较采样器（GREATER、线性、边框 0）取样，交给 `common_pbr_2.h` 的 `ComputePBRLightShadow`。阴影灯数来自 `general.lightconfig` 的 `pointshadow` / `directionalshadow`，档位来自 WPE 的 `shadows` 设置（disabled / low / medium / high / ultra）：档位决定方块边长（256 / 256 / 512 / 1024）、点光的 fov 与面内补偿、着色器的采样次数（low 1 次，其余 9 次），`disabled` 时解析期就把阴影灯数丢掉。

我们照这个形状接三处：
- **翻译器**生成阴影分支。`library.rs` 的 `LightingV1` 现在遇到阴影宏就报 `LightingV1/shadow`；改成照 WPE 生成器（`FUN_140169140`，exe 里能读到生成的代码串，比如 `CalculateProjectedCoordsCascades`、三级联按 `.w` 混合 `uvTransforms`）生成点光与平行光的阴影循环。聚光阴影与 cookie 语料 0 张，继续报。
- **编译期**把阴影灯数、`LIGHTS_*_SHADOW` / `LIGHTS_SHADOW_MAPPING` / `_QUALITY` 宏、投射者名单（不透明且 `castshadow` 的模型，按材质选投射着色器）和图集这张运行时 RT 编进 bundle；`lightconfig:pointshadow` / `directionalshadow` 不再报。
- **渲染器**新增 `render/shadows.ts`：每帧按灯算阴影条目、打包图集、清深度、逐视图画投射者，再把 `g_LFeature_Shadow*` 写进读它们的绘制。WebGPU 没有视口数组，WPE 的「一次实例化画 6 个视图」改成每个视图设一次视口、画一遍，结果等价。阴影 pass 排在反射与主 pass 之前，复用 P13b2 的「场景视图」（目标、视图投影、名单），所以不另起一套绘制循环。

档位照「决定」3 加 Kabegame 设置「场景阴影」：缺省跟随 WPE 的 `config.json`，也可以固定档位或关掉，写法照「场景反射」（P13b1）。改了就整场重新加载（宏变了）。

关键决策：
- **矩阵按 WPE 逐步 float32 算**：P13c 走查查出透视相机在 double 里算就会差几个 ULP。点光六面的视图、平行光级联的中心与防抖、投影都照读码的顺序逐步舍入。
- **WPE 的怪行为照抄**：阴影 pass 在材质缺省剔除时实际不剔（光栅序号 4 漏改 CullMode），非点光视图的 VP 画阴影时另减 `m32` 0.0005、写进 uniform 的不减，`depthBiasSlopeScale = −4`。
- **投射者只认 WPE 实际会画的**：只有模型置不透明位，图像层、粒子、puppet 即使写了 `castshadow` 也不投射。投射着色器按材质片元着色器首行的 `// [PASS] shadow <名>` 注解选，没有注解用 `shadowcaster`。`chroma4` / `foliage4` / `fur4` 的专用投射着色器（`shadowcasterfoliage4` 等）语料 0 张，也照样支持（待定 3，用户：不因为本机没有样本留债），用确定性工程验。
- **灯仍是编译期常量**：P13f 才把灯改成运行时状态。点光的位置、半径在编译期定，平行光的级联要跟相机走，所以阴影条目每帧在渲染器里算，灯的字段取 bundle 里的值；P13f 接上运行时灯之后只换数据来源。

## 现状锚点

**a. 阴影灯数照报**（`compile/lights.ts:41`，`compile/bundle.ts:1255`）
```ts
/** 阴影与 cookie 的灯数键：要 `_rt_shadowAtlas` / `_alias_lightCookie`，渲染器没有。 */
const SHADOW_KEYS = ["spotshadowcookie", "spotshadow", "spotcookie", "directionalshadow", "pointshadow"];
export function lightConfigIssues(general: Record<string, unknown>): string[] {
  // …
  return SHADOW_KEYS.filter((key) => count(source[key]) > 0).map((key) => `lightconfig:${key}`); // 现状：有阴影灯数就报
}
// bundle.ts
  for (const issue of lightConfigIssues(general)) unsupported.add(issue);
```

**b. 灯数与宏不含阴影**（`compile/lights.ts`）
```ts
export interface LightCounts {
  point: number;
  spot: number;
  tube: number;
  directional: number; // 现状：没有 pointshadow / directionalshadow，也不看档位
}
export function litDefines(counts: LightCounts): Record<string, string> {
  return { LIGHTS_POINT: …, LIGHTS_SPOT: …, LIGHTS_TUBE: …, LIGHTS_DIRECTIONAL: … }; // 现状：没有 LIGHTS_*_SHADOW、LIGHTS_SHADOW_MAPPING
}
```

**c. 翻译器遇到阴影宏就报**（`src-tauri/wpesl2wgsl/src/library.rs:45`）
```rust
    for shadow in SHADOW_MACROS {
        if value(shadow)? != 0 {
            return Ok(Expansion::Unsupported("LightingV1/shadow".to_string())); // 现状：不生成阴影分支
        }
    }
// lighting_v1：每盏灯都传 shadowFactor 1.0
            "\t\tsum += ComputePBRLightShadow(n, {light}, v, albedo, {color}, {exponent}, tint, f0, rough, metal, 1.0);\n"
```

**d. 比较采样已能翻译、绑定布局已有，但只有占位**（`rewrite.rs:1639`，`render/programs.ts:202`，`render/scene.ts:2718`）
```rust
            "texSample2DCompare" => format!("texture({combined}, vec3({}, {}))", arg(1)?, arg(2)?),
```
```ts
    const comparison = texture.kind === "2d-comparison";        // programs.ts：深度采样类型 + comparison 采样器
// scene.ts：占位纹理与采样器
        "2d-comparison": depth.createView(),
      comparison: device.createSampler({ compare: "less-equal" }), // 现状：只有占位，没有 GREATER、没有图集
```

**e. 模型上的 `castshadow` 中性，因为消费者照报**（`compile/features.ts:291`）
```ts
 * - `castshadow`、`reflected`：只决定是不是阴影 pass 的投射者、在不在反射 pass 的名单里。没有消费者时不改变画面，而消费者现在都照报
 *   （投影灯报 `lightconfig:*`）；
const MODEL_NEUTRAL_FLAGS = ["skin", "castshadow", "reflected"];
```

**f. 语料**（`ignore/p13/out/scan.json`）

| 场景 | `lightconfig` | 投射者 | 还差 |
|---|---|---|---|
| `3287715210` | `point 1, pointshadow 1`，正交 | 没有模型 | `object:castvolumetrics`（P13e） |
| `3465215190` | `point 2, pointshadow 2` | 没有模型（puppet 是图像层） | P12、P10、P11、`model:passthrough:children:framebuffer` 等 |
| `3706286085` | `directional 1, directionalshadow 1, point 1` | 带骨骼的 FBX 模型 | P12 骨骼、雾、`transparentsorting`、屏幕空间反射等 |

真正投出阴影的只有 `3706286085`，而它还差好几节；前两张图集里什么都不画，但着色器照样按阴影采样（超出远平面的点 `z < 0`，比较不通过，`shadowFactor` 为 0，进半兰伯特那一支）。所以本节的验收主要靠确定性工程。

## 步骤 0 — 读码补全与确定性工程（Claude，实现之前）

**读码**（切 `ignore/p4/rea/wp.asm`，REA 导入期限内超时的话照 P13 步骤 0 的做法）：
- R1 **生成器的阴影分支**（`FUN_140169140`）：循环结构；带阴影的灯占 `g_LPoint_*` 的前几槽还是后几槽，和 `g_LFeature_ShadowPointProjection[i]` 的下标怎么对应；平行光三级联的 `p1` / `p2` / `p3` 怎么算、`shadowFactor` 怎么合；`worldPos` 从哪来。exe 里的代码串（`vec4 projectedCoords = CalculateProjectedCoordsPoint(worldPos, g_LPoint_Origin[i].xyz, …)` 等）照公式另写，不搬运。
- R2 **灯光 uniform 缓冲里阴影段的先后**（`0x140190ff8` 一带）：带阴影的灯与普通灯在 `g_LPoint_Color` 等数组里的槽位顺序。
- R3 **平行光级联的视图矩阵**（`FUN_14005f650` 的朝向与 up）、防抖 `fmod` 的符号、`FUN_14017e910` 是不是「正交场景」。
- R4 **图集打包**（`FUN_14019e690` / `FUN_14019e830`）：多块时的排布；只扩不缩。
- R5 **投射着色器表**（`ctx+0x15a8`，`FUN_140156…` 的查表）：是不是就是片元着色器首行的 `// [PASS] shadow <名>` 注解；投射变体从基础材质继承哪些 COMBO、纹理槽（`foliage4` / `fur4` 的风、毛发参数）与常量。

**确定性工程**（kbp gen + `ignore/p5/c0/mdl_enc.py` 的立方体与平面网格，`generic4` 开 `LIGHTING`，地面接收、立方体投射；`capture_sweep` 扫 `shadows` 五档，扫完自动改回用户的 `low`）：

| # | 问题 | 工程 | 预测 |
|---|---|---|---|
| D1 | 点光六面：图集内容、6 个视图的 VP、`g_LFeature_ShadowPoint*`、整帧 | 正交、透视各一，一盏 `lpoint` + `pointshadow: 1`，五档 | 方块 256 / 256 / 512 / 1024，面 `S/2 × S/3`；fov 94 / 94 / 92 / 91.2°；正交近平面 1，透视 `max(0.05, lightsourcesize)` |
| D2 | 平行光三级联 | 透视，一盏 `ldirectional` + `directionalshadow: 1`；相机微移两次；改三个 `cascadedistance` 再测 | `(a, b)` = `(3, 40)`、`(10, 40)`、`(100, 150)`；中心只按纹素跳；uniform 里的 VP 不带 0.0005，阴影 pass 用的带 |
| D3 | 剔除 | 单面平面当投射者，从背面打光 | 照样投影（CullMode NONE） |
| D4 | 谁能投射 | 图像层、粒子写 `castshadow: true`；模型写 `castshadow: false`；半透明（`blending: translucent`）的模型 | 都不进阴影 pass |
| D5 | 两盏投影灯 | 两盏点光 + 一盏平行光 | 图集尺寸与各块位置（R4） |
| D6 | 没有投射者 | 同 `3287715210`：只有图像层接收 | 图集清成 0，半径内全受光、远平面外 `shadowFactor` 0 |
| D7 | `disabled` | D1 的工程，`shadows: disabled` | 不建图集、宏全 0，画面和没写阴影灯数时相同 |
| D8 | 专用投射着色器 | 三个投射者分别用 `chroma4`、`foliage4`、`fur4` 材质（带 alpha 纹理、风 / 毛发参数非缺省） | 阴影 pass 里分别用 `shadowcaster` / `shadowcasterfoliage4` / `shadowcasterfur4`，形状随 alpha 与形变 |

### 步骤 0 的结果（2026-11-15）

**读码**：代理产出 [rea-p13-shadows.md](rea-p13-shadows.md)（R1–R6 与点光偏移），切 `ignore/p4/rea/wp.asm`，脚本在 `ignore/p13/rea/shadows/`。点光偏移与平行光级联用抓帧按 float32 复算，`chk_pt.py` 我独立重跑逐位相同；`chk_dir.py` 余 1–2 ULP 只在由角度算的灯轴上（脚本里三角函数是 double）。

**实测**：工程 `ignore/p13/d/gen_d0.py`（D1–D7）、`gen_d8.py`（D8）、`gen_d9.py`（补测）→ `ignore/p13/proj/p13d-*`；抓帧 `A:\p13d\sweep\`（五档 21 组，`capture_sweep` 重启 WPE 4 次后改回 `low`，`config.json` 哈希回到 `cc5081…`）、`A:\p13d\spec\`、`A:\p13d\sweep2\`；常量 `ignore/p13/out/wpe-p13d-*-consts.json`（打印 `ignore/p13/d/ana/show.py`）。

| # | 结果 |
|---|---|
| D1 | 成立：方块 256 / 256 / 512 / 1024，fov 94 / 94 / 92 / 91.2°（`P11` 0.93252 / 0.97927 …），正交近平面 1、透视 `max(0.05, lightsourcesize)`。**推翻一处读码**：点光阴影 pass 的投影 `P32` 另加 `−0.00333f`（`0x1404929a8`），uniform 不带；三组逐位复算相同 |
| D2 | 成立：三级 `(3, 40)`、`(10, 40)`、`(100, 150)`，防抖 `fmodf` 截断；阴影 pass 的 VP `m32 − 0.0005f`、uniform 不带；三块横排（low 768×256） |
| D3 | 成立：主 pass 剔掉的单面平面照样投影（阴影 pass CullMode NONE） |
| D4 | 成立：不透明模型缺省就投射（**地面也是投射者**）；`castshadow: false` 的模型、半透明模型、图像层、粒子都不进阴影 pass |
| D5 | 成立：5 块排成一行（ultra 5120×1024，变换 x = 0, 0.2 … 0.8） |
| D6 | 成立：没有投射者时图集照清、不画；接收者照样采样 |
| D7 | 成立：`disabled` 没有阴影 pass |
| D8 | 成立：`chroma4` 的棋盘格 alpha 在阴影里挖出孔（阴影 pass 没有颜色附件，A2C 仍按 alpha 生效）；`foliage4` 的影子随风动（`LEAVESUVMODE` 与常量被继承）；`fur4` 主 pass 9 个实例、阴影 pass 只投基础网格 |
| 补测 | 两盏平行光阴影：6 级 6 块（生成器下标 `p = B0 + k + c` 的错照 R1 预测，画面待实现后逐像素比）；`point 3, pointshadow 1` 两盏投射：多出来的投射灯写进槽 1 后被普通灯覆盖；运行中隐藏一盏投影灯：图集不缩、变换分母仍是大图；`fur4` 5 / 21 层的阴影 pass 相同 |
| 视图压紧 | WPE 对每个模型只给通过视锥测试的视图发实例，视口数组也一起压紧（`who-low` event 30 的视口 0 是 −X 面）。我们逐视图画、跳过剔除的视图，结果相同 |

**对上文的修正**：
- **点 3（翻译器）**：生成器不是循环，是每盏灯一个 `{ const uint i = n; … }` 块，顺序「点光阴影 → 点光 → 聚光四段 → 管光 → 平行光阴影 → 平行光」；带阴影的灯占本类前 PS / DS 槽；平行光三级下标照抄 WPE 的 `B0 + k + c`；声明顺序照 R1 1.2。
- **点 4（编译期）**：灯光 uniform 照 WPE 的整块缓冲写（R2 的段与写入指针），包括投射灯多于配置时的覆盖与平行光条目越界写（见待定 4）。投射变体：COMBO 只取投射着色器声明的几个（值取基础材质），基础 blending 为 alphatocoverage 时加 `ALPHATOCOVERAGE = 1` 并带 A2C；纹理按 `material` 键配对（`morph` 换槽）；常量按名字拷；剔除、深度不继承。`castshadow` 在图像层、粒子等非模型对象上中性（WPE 不投射）。
- **点 5（渲染）**：点光阴影 pass 的投影 `P32 − 0.00333f`；平行光级联照 R3 的 float32 步骤（快速倒数平方根归一化、`fmodf`）；灯按 R2.3 的键每帧排序（见待定 5）；图集打包照 R4（点光优先、按边长降序、8192 宽条带），RT 尺寸「够就不动、不够改成恰好」，变换按 RT 实际尺寸除。
- **新增点 8 — `fur4` 主 pass**：语料扫描报 `shader:fur4:parse:Unknown variable: TEX8FORMAT`（`g_Texture8` 声明了 `formatcombo`，我们没给 `TEX8FORMAT`），而且 `INSTANCECOUNT` 的实例化（程序标志 0x20，每层一个实例）我们没有。按「不留债」并进本节：补 `TEX8FORMAT`，`INSTANCECOUNT` 非 0 的程序主 pass 画 N 个实例，D8 的工程和 WPE 逐像素比。`chroma4`、`foliage4` 的主 pass 现在已经能编（扫描没报键）。

## 点 1 — 设置「场景阴影」（Rust、前端、i18n）

- **新增** `kabegame-core/src/settings/mod.rs`：键 `wpeSceneShadows`，取值 `follow` / `disabled` / `low` / `medium` / `high` / `ultra`，缺省 `follow`；`get_wpe_scene_shadows`、`set_wpe_scene_shadows`，写法照 `wpeSceneReflection`（含 `get_settings` 快照与单测）。
- **新增** `kabegame/src/commands/settings.rs` 两个命令并注册；`permissions/wpe-scene-host.toml` 加 `get_wpe_scene_shadows`。
- **新增** 前端 `stores/settings.ts` 类型、`settingsDescriptors.ts` 的 descriptor、`Settings.vue` 里「场景反射」下面一项下拉，五种语言的词条。

## 点 2 — 解析档位（`compile/postprocess.ts`）

- **新增**
```ts
export type SceneShadowSetting = "follow" | "disabled" | "low" | "medium" | "high" | "ultra";
/** 阴影档位 0–4（rea-p13-passes 2.2：0 disabled，1 low …）。跟随时读 WPE `general.user.shadows`，读不到按 WPE 的缺省（步骤 0 核对）。 */
export function resolveShadows(setting: string | null | undefined, wpeValue: unknown): ShadowQuality;
export async function readWpeShadows(reader: SceneReader, sceneAssets: readonly string[]): Promise<unknown>;
```

## 点 3 — 翻译器（`src-tauri/wpesl2wgsl/src/library.rs`）

- **修改** `expand`：`LIGHTS_POINT_SHADOW` / `LIGHTS_DIRECTIONAL_SHADOW` 不再报；`LIGHTS_SPOT_SHADOW` / `LIGHTS_SPOT_COOKIE` / `LIGHTS_SPOT_SHADOW_COOKIE` 照报（改名 `LightingV1/spot-shadow`）。
- **修改** `lighting_v1` 带上两个阴影计数，按 R1 生成：
```rust
fn lighting_v1(counts: Counts) -> String {
    // 新增：LIGHTS_SHADOW_MAPPING 时声明 g_LFeature_ShadowPointProjection[M] / …Transform[M]、
    //       g_LFeature_ShadowProjection[N] / …Transform[N]（N = 3·directionalshadow，M = pointshadow），照 2.8 的声明规则
    // 修改：带阴影的点光一盏一个 shadowFactor（CalculateProjectedCoordsPoint → PerformPointShadowMapping），
    //       带阴影的平行光三级联按 .w 混合（R1），普通灯仍传 1.0
}
```
- **新增** 单测：阴影宏组合的生成结果；语料请求夹具加 `generic4` / `genericimage4` 带阴影宏的请求；README 补规则。

## 点 4 — 编译期（`compile/lights.ts`、`compile/bundle.ts`、`compile/features.ts`、新文件 `compile/shadows.ts`）

- **修改** `LightCounts` 加 `pointShadow`、`directionalShadow`、`spotCookie`（只为照报）；`lightCounts(general, quality)`：档位 0 时阴影计数为 0、`spotshadowcookie` 按位或进 `spotcookie`（2.10）。
- **修改** `litDefines` 加 `LIGHTS_POINT_SHADOW`、`LIGHTS_DIRECTIONAL_SHADOW`（及三个聚光宏，值照计数），阴影计数和非 0 时 `LIGHTS_SHADOW_MAPPING = 1`、`LIGHTS_SHADOW_MAPPING_QUALITY = 档位`。
- **修改** `lightConfigIssues` 只报聚光的三项。
- **新增** `compile/shadows.ts`：
```ts
/** 阴影灯（编译期）：按 R2 的槽位顺序，每盏给类型、世界位置 / 方向、半径、lightsourcesize、cascadedistance0–2。 */
export interface SceneShadowLight { kind: "point" | "directional"; slot: number; /* … */ }
/** 投射者：不透明（任一网格 blending 为 normal / alphatocoverage）且 castshadow 的模型；每个网格一份投射材质（注解或 shadowcaster）。 */
export interface SceneShadowCaster { layer: number; meshes: { pass: ScenePass }[] }
export interface SceneShadows { quality: 1 | 2 | 3 | 4; lights: SceneShadowLight[]; casters: SceneShadowCaster[] }
```
- **修改** `bundle.ts`：`_rt_shadowAtlas` 进运行时 RT 表（`depth32float`），`g_Texture<n>Texel` 在绑图集的槽是引擎 uniform；`SceneBundle.shadows?: SceneShadows`（有阴影灯时才有）；`CompileSceneInput` 加 `shadows?: SceneShadowSetting`，在反射旁边解析。
- **修改** `features.ts`：`castshadow` 的注释更新（消费者有了）。
- **新增** 投射材质：按 R5 查注解，`shadowcaster` / `shadowcasterfoliage4` / `shadowcasterfur4` 都走同一条编译路径（翻译、COMBO、纹理槽照 R5 从基础材质继承），找不到注解的着色器用 `shadowcaster`。

## 点 5 — 渲染（新文件 `render/shadows.ts`，`render/scene.ts`、`render/programs.ts` 接线）

- **新增** `render/shadows.ts`：
```ts
/** 方块边长（2.2）、点光 fov 与近远平面（2.3）、平行光级联参数与防抖（2.4），float32 逐步。 */
export function shadowBlockSize(quality: number): number;
export function pointShadowProjection(light: SceneShadowLight, quality: number, ortho: boolean): { proj: Mat4; info: Vec4 };
export function cascadeViewProjections(light: SceneShadowLight, camera: SceneView, size: number, ortho: boolean): Mat4[];
/** 打包（R4）：条目 → 各块左上角与图集尺寸（≥ 2，只扩不缩）。 */
export function packShadowAtlas(entries: readonly number[], previous?: AtlasLayout): AtlasLayout;
/** 每帧：算条目 → 必要时扩图集 → 清深度为 0（一次）→ 逐视图设视口、写该视图 VP（非点光 m32 − 0.0005）、画投射者 → 给读阴影的绘制写 g_LFeature_*。 */
export class ShadowAtlas { encode(encoder: GPUCommandEncoder, frame: ShadowFrame): void; uniforms(): Record<string, number[]> }
```
- **修改** 投射者的管线：深度 `depth32float`、GREATER、写深度，`depthBiasSlopeScale: −4`、`depthBias: 0`，剔除照 2.6 的表（材质缺省剔除 → `"none"`，`alignmentfliph` → `"front"`，`nocull` → `"none"`），无颜色附件。
- **修改** `render/scene.ts` 的 `encode`：脚本之后、反射 pass 之前调 `shadows.encode`；`resolveTexture` 认 `_rt_shadowAtlas`；比较采样器改成 `compare: "greater"`、线性（待定 2 定边框的做法）；读阴影的绘制每帧刷 `g_LFeature_*` 与 `g_Texture<n>Texel`。
- **修改** dev 探针：`renderFrame` 可读回图集（和 WPE 抓帧的图集逐纹素比）。

## 点 6 — 宿主（`host.ts`）

- **修改** `setting-change` 认 `wpeSceneShadows`，变了就 `reload()`；`reload` 一并读它，`compileSceneInWorker` 带上 `shadows`；测试替身认 `get_wpe_scene_shadows`。

## 点 7 — 测试

- `render/shadows.test.ts`：方块边长、点光投影（`3287715210` 抓帧的 `(0.00143, 1.00143, −1, 0)` 逐位）、级联参数与防抖（D2 抓帧原值）、打包（D5）、非点光 VP 的 0.0005 只进阴影 pass。
- 假设备：阴影 pass 在反射与主 pass 之前、每帧清一次、每视图一次视口、管线的偏移与剔除；没有阴影灯时不建图集、编码轨迹不变。
- 编译期：`disabled` 时宏全 0、`spotshadowcookie` 并进 `spotcookie`；投射者名单（D4 的各种情况）；三种基础着色器各选对投射着色器、继承的 COMBO 与纹理（D8）。
- 翻译器：`cargo test -p wpesl2wgsl`（生成结果、夹具、语料）。

## 验收

1. tsc、本节相关的 vitest、`cargo test -p wpesl2wgsl`、Prettier；变异（fov 按档、近平面正交 / 透视、级联 `(a, b)`、0.0005 进了 uniform、剔除改回 back、比较方向、打包坐标）。
2. 语料（跟随、关、超高三档）：只去掉 `lightconfig:pointshadow` / `directionalshadow`，没有阴影灯的场景逐张不变；没有阴影的场景编码轨迹与基线逐字节相同。
3. 步骤 0 的确定性工程和 WPE 逐纹素比图集、逐像素比整帧（五档；D8 三种投射着色器）。
4. `3287715210`：dev 强制渲染（体积光照报），除体积光之外的部分和 WPE 比。
5. 设置页切换五档与跟随，场景重新加载、画面变化。
6. 恢复测试行与 WPE 设置（`capture_sweep` 自动改回，`config.json` 哈希核对）。

## 风险

1. **一帧多出好几个 pass**：点光 6 个视图、平行光 3 个，每个视图画一遍全部投射者；只在有阴影灯的场景。
2. **比较采样的过滤精度**：WPE 的硬件线性比较过滤和 Dawn 的可能差几级，9 次采样的软阴影边缘按误差包络比。
3. **真实场景验收不到投出的阴影**：语料里只有 `3706286085` 有投射者，它还差 P12 骨骼等几节；投射路径只靠确定性工程验收。
4. **灯是编译期常量**：灯字段绑属性仍整场重编译，灯挂父对象、关键帧照报，等 P13f。

## 待定（1、2 用户没有异议，按推荐；3 已定；4、5 2026-11-15 用户：「同意」，按推荐）

1. **设置「场景阴影」的取值**：推荐六项：跟随 WPE（缺省）、关、低、中、高、超高，和 WPE 的 `shadows` 一一对应，跟随时读 `config.json`。另一种是只给跟随 / 关 / 开三项，开时用固定档位（少一个下拉，但没法在集显上选低档）。
2. **比较采样器的边框**：WebGPU 没有 BORDER 寻址。推荐着色器里包一层：采样的 2 × 2 范围全在图集内时用硬件 `textureSampleCompareLevel`（和 WPE 同一种硬件过滤）；越出图集时用 `textureGatherCompare` 取四个比较结果、手算双线性权重，越界的纹素按边框 0 比较。语料里只有「投影在灯背后」（`proj.y = 2`）这一种会整块越界，点光的面内补偿与级联的 0.99 裁剪都让正常采样留在块内。另两种：只用 clamp（越界时取到边缘纹素，结果和 WPE 不同）；给图集外加一圈 0 纹素（`AtlasTransform` 等 uniform 的值就和 WPE 不同了）。
3. **专用投射着色器**（`chroma4` / `foliage4` / `fur4` 的 `[PASS] shadow` 注解）：~~推荐照报~~ **已定（2026-11-15 用户：「chroma4 / foliage4 / fur4 现在就支持，最好不要因为本机没有留债」）：现在就支持**，步骤 0 加 R5 与 D8。
4. **配置不一致时照不照抄 WPE**（R2.4、补测）：`castshadow` 的灯多于 `lightconfig` 的阴影数时，多出来的写进普通段后被覆盖；两盏以上带阴影的平行光，生成器下标 `B0 + k + c` 让第 2 盏起读错级联；平行光条目按 N 的余量生成、可能写越过 `ShadowProjection[N]` 进 `…Transform` 段。推荐照抄：灯光 uniform 按 WPE 的整块缓冲布局写（一份 float 数组、各名字是它的切片），这三种行为自然就一样，补测的工程逐像素比。语料没有这种配置。另一种是这几种配置照报不渲染。
5. **灯的排序做到哪**（R2.3）：WPE 每帧按「类型、castshadow / usecookie 降序、局部 origin 在 `g_ViewForward` 上的投影升序」重排灯，决定槽位与图集块的位置。推荐本节就每帧排（阴影本来就要每帧按相机算），排序之后的槽位、阴影条目、图集块都照 WPE；灯的字段仍取编译期的值，P13f 再换成运行时状态。另一种是只保证带阴影的灯在前、同类按 `objects` 顺序，留给 P13f（像素一样，只有 uniform 里的槽位与图集块的位置可能和 WPE 不同）。

## 实施步骤（2026-11-15，各步单独验收）

1. **设置**（点 1）：Rust 键与命令、权限、前端设置项、五种语言词条。机械改动，交执行代理（sonnet），文件和后面几步不重叠。
2. **翻译器**（点 3）：`library.rs` 照 R1 逐灯展开、段顺序、阴影块、平行光 `B0 + k + c`；`cargo test -p wpesl2wgsl`、重编 wasm。
3. **`fur4` 主 pass**（点 8）：`TEX8FORMAT`、`INSTANCECOUNT` 实例化；`p13d-spec` 的主 pass 和 WPE 比（此时阴影还没有，比较时用 `shadows: disabled` 档的抓帧）。
4. **编译期**（点 2、点 4）：档位解析、灯数与宏、灯光整块缓冲的布局、投射者名单与投射变体、`_rt_shadowAtlas`、能力表。
5. **渲染**（点 5、点 6）：`render/shadows.ts`（每帧排灯、写整块缓冲、阴影条目、点光投影与级联、打包、阴影 pass）、比较采样、宿主接线、dev 探针读回图集。
6. **验收**：确定性工程五档与 WPE 逐纹素比图集、逐像素比整帧；语料；文档。


## 实施记录（进行中，2026-11-15）

**已做**（都未提交）：
- 步骤 1 设置：执行代理（sonnet）加了 `wpeSceneShadows`（Rust 键与命令、`wpe-scene-host.toml` 只放 getter、前端六项下拉 `WpeSceneShadowsSetting.vue`、五种语言词条）；它那边 `link.exe` 0xc0000142 跑不了测试，我重跑 `driver.sh kabegame-core --lib wpe_scene` 3 个用例通过。`host.ts` 的读设置与重新加载还没接。
- 步骤 2 翻译器：`library.rs` 照 R1 生成点光 / 平行光阴影块（平行光下标照抄 `B0 + k + c`），聚光阴影 / cookie 报 `LightingV1/spot-shadow`；`rewrite.rs` 去掉 `gl_ViewportIndex` 的赋值；`texSample2DCompare` 改调 `kb_shadowCompare`（足迹在图内用硬件比较，越界四个纹素中心各比一次、越界的按边框 0；naga 的 GLSL 前端不认 `textureGather`）；新增 `phase: "texture"`：`formatcombo` 槽的注解缺省纹理先问调用方要格式（`fur4` 的 `TEX8FORMAT`），语料测试照前端读 `.tex` 头回答。单测 106 个通过，本机语料 161 → 165/167（剩 `volumetricsfront` 归 P13e、`puppettexturechannels`）。
- 步骤 3 `fur4` 主 pass：`ShaderCompiler` 回答注解缺省纹理的格式；模型网格按 `INSTANCECOUNT` 画实例（`programInstances`）。`p13d-spec-ns`（三种着色器、不带阴影）对 WPE：54 个像素不同，43 个 > 32，都是 chroma4 / foliage4 的 A2C 边缘（我们画、WPE 不画），待定位。
- 步骤 4 编译期：`lightCounts(general, 档位)` 带阴影计数、档位 0 时照 WPE 丢掉；`litDefines` 写阴影宏与 `LIGHTS_SHADOW_MAPPING(_QUALITY)`；`resolveShadows` / `readWpeShadows`（缺键按 medium）；灯光数组不再进材质常量，改成 `bundle.lights`（记录 + 计数 + 档位），渲染器每帧 `lightFrame` 排序、照 WPE 写整块缓冲（R2，含覆盖与越界）；`_rt_shadowAtlas` 进运行时 RT；投射变体 `SceneMesh.shadow`（注解选着色器、COMBO 取投射着色器声明的、A2C、纹理按 `material` 键、常量按名字从基础 pass 拷）；`SceneModel.castShadow`；能力表：`g_LFeature_*` 与 `g_ViewportViewProjectionMatrices` 是引擎 uniform，`castshadow` 在任何对象上中性。
- 步骤 5 渲染：`render/shadowMath.ts`（方块边长、点光投影与六面视图、P32 −0.00333、级联 R3、打包 R4、方块变换、`planShadows`）、`render/shadows.ts`（`ShadowAtlas`：depth32float、比较采样器 greater + 线性 + clamp，每帧清 0、逐条目逐视图设视口画投射者）、`scene.ts`（`frameLightValues` 每帧写灯光数组、图集作纹理来源、`buildShadowCasters` 用 `createDraw` + `createShadowPipeline` 建投射者、逐条目 uniform 副本、`firstInstance` 取视图号），`state.ts` 投射变体的常量与基础常量同步。dev 轨迹能读回只有深度附件的 pass（`.f32`）。
- 单测：`p13d-shadows.test.ts` 14 个（点光六面 VP 与抓帧逐位相同、级联 ≤ 2 ulp、打包与方块变换、整块缓冲的覆盖）通过；`lights.test.ts` 30/31（剩下的是「照报 pointshadow」那条，要改成不报）。

**对 WPE（low 档，按抓帧的 `g_Time` 渲染一帧，`kbp cmp frame --kbp-layers`）**：

| 工程 | 结果 |
|---|---|
| p13d-none（只有接收者） | 0 差异 |
| p13d-po（正交点光） | 3 个像素差 1 |
| p13d-pp（透视点光） | 3 个像素差 1 |
| p13d-dir（平行光三级联） | 4 个像素差 1 |
| p13d-spec（三种专用投射者） | 12342 个像素不同：图集逐纹素比只差 chroma4 的一整行与 foliage 的零星纹素，都是 A2C 在 alpha 正好 0.5 的格子边界上取舍不同（我们画、WPE 不画）；主 pass 同样有 A2C 边缘的 43 个像素。待定位到值 |

**还没做**：`host.ts` 接设置；`lights.test.ts` 那条与别的受影响的测试（p2a 引擎 uniform 表、p13a 等）、本节相关的 vitest 全跑；语料扫描对比；中、高、超高三档（9 次采样）、multi / who / cull / dir-cd / dir-b / dir2 / over / hide / fur 各工程对 WPE；A2C 取舍的定位；变异检查；翻译器 README、WPE_SCENE、回归、changelog；测试行移除（`ignore/p13/d/manifest-d.json`、`manifest-specns.json`）。

### 实施记录（续，2026-11-15）

上面「还没做」里的各项：

- **A2C 取舍**：根因是单采样 A2C 的阈值是 0.5 + 2⁻¹²，不是 `> 0.5`（`p13d-a2cth*` 逐段细分实测，p13-REPORT「单采样 A2C 的阈值」）。已单独提交（`970ae645`，被 `08db9ec7` 的快照覆盖后 `978998b5` 重新套用，`baa6a591` 补 `compile/p8.test.ts`）。改后 `p13d-spec` 12342 → 14、`p13d-spec-ns` 54 → 11，图集 0 差。
- **点 6 宿主**：`host.ts` 加载时读 `get_wpe_scene_shadows`，经 `compileSceneInWorker`（`client.ts` / `protocol.ts` / `worker.ts` 多一个 `shadows`）交给编译；`setting-change` 带 `wpeSceneShadows` 且值变了才重载，和后处理、反射同一条只重载一次；`host.test.ts` 三条。dev 覆盖 `dev/shadowsOverride.ts`（`localStorage["kabegame-dev-scene-shadows"]`），宿主与探针都读；探针结果带 `shadows`（实际档位与计数）。
- **测试**：`lights.test.ts` 四条按新语义改（`castshadow` 中性、`g_LFeature_*` 是引擎 uniform、灯光数组每帧写、点光 / 平行光阴影不报）；`g_ViewportViewProjectionMatrices` 单列 `SHADOW_CASTER_UNIFORM`（不在 `ENGINE_UNIFORMS` 那张与 `staticBuiltins` 一一对应的表里），`p2a` 的表测试照旧；`p5c` 一条。顺手修了 HEAD 上就失败的 16 条（P13c 留下：探针替身缺 `spriteSamples`、`sheet` 的宏缺 `REVERSEDEPTH`、`p5d` 拼错的深度键）与 `pipeline.test.ts` 的 ricepod 解锁名单。新增 `compile/p13d.test.ts`（投射变体的编译规则 4 条），`p13d-shadows.test.ts` 补级联阴影 pass 的 VP 对抓帧、打包的点光优先两条。
- **验证**：tsc 0 error；直接导入改动模块的 106 个测试文件里，剩下的失败在 HEAD 快照上同样失败（`pipeline.test.ts` 两张工坊场景的请求 / 字节上限；`p3a` 的语料绑定表测试超时，HEAD 快照上单独跑同样超时，668 s）；翻译器 108 个单测、语料 165/167、几何 27/27；语料扫描（HEAD 对工作区，233 张）P13d 只去掉 `lightconfig:pointshadow` 3 张、`directionalshadow` 1 张。变异检查 20 处检出 19，剩下的 `casts-ignore-quality` 是等价变异（`ignore/p13/d/mut/`）。
- **对 WPE**：29 次抓帧（五档 × 点光正交 / 透视 / 平行光，multi、who、cull、dir-cd、dir-b、dir2、over、hide、fur5 / fur21、spec、spec-gen、pp-ls），档位用 dev 覆盖，按抓帧时刻渲染：每张最多 32 个孤立像素、都只差 1 级；`who` 的粒子方块是探针不步进粒子。表在 p13-REPORT「五个档位与全部补测工程对照 WPE」。
- **空槽 NaN**（`hide` 发现）：WPE 给没有灯的阴影槽写全 0，投影 `w` 为 0，坐标 0/0；`kb_shadowCompare` 越界分支的手算权重把 NaN 带进整个光照和，画面全黑。权重改成 `w >= 0 ? w : 0`（`rewrite.rs`，单测 `shadow_compare_weights_ignore_nan`），修后 2 个像素差 1。
- **文档**：翻译器 README（`defaultFormats` / `missingTextures` / `phase: "texture"`、`kb_shadowCompare`、`gl_ViewportIndex`、`LightingV1/spot-shadow`）、`cocs/wpe/WPE_SCENE.md`「阴影（P13d）」与光照一节、`cocs/README.md`、changelog、回归「场景壁纸阴影（P13d）」。

**还没做**：设置页切换六档的真机观感（回归 SH4）；非 Windows（SH5）；测试行移除（`ignore/p13/d/manifest-d.json`、`manifest-specns.json`、`manifest-d2.json`）放在提交之后。
