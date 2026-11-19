# P13i / P13j — 聚光阴影与预光照（总计划）

> 上级：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)。这两项原先按「决定」照报：聚光的阴影 / cookie 在 P13d 定为照报 `lightconfig:spot*`，`PRELIGHTING` 在「决定」4 定为照报并用 `TODO:[WPE_SCENE]` 标出。2026-11-18 全库扫描（233 张，能渲染 199）里归 P13 的只剩它们，用户：「都要做」，先写总计划再开工。
> 本文件只说明两个效果是什么、已知与未知、怎么拆和怎么验收；各节动工前另写子计划，步骤 0 先读码再实测。

## 总体设计思路

两项都是「已经有的光照能力在一种组合下还没接上」，不是新的渲染能力。

**P13i 聚光阴影**接在 P13d 的阴影管线上。P13d 已经有阴影图集 `_rt_shadowAtlas`、投射者 pass、比较采样 `kb_shadowCompare`，以及点光（每盏 6 面）与平行光（每盏 3 级联）的投影和打包；聚光只是每盏多一块图集、一个透视投影（从灯的位置朝灯的 +X 看，视角跟锥角走）。着色器一侧，WPE 的生成器给「聚光 · 阴影」段生成的代码和平行光一样，都是 `CalculateProjectedCoords` 加 `PerformShadowMapping`。所以改动集中在三处：翻译器展开这一段（现在报 `LightingV1/spot-shadow`）、宿主算聚光的阴影投影与图集位置、渲染器给聚光加一个阴影视图。读码还缺聚光投影本身（`FUN_14025d420` 的类型 1）和它在图集里怎么打包，步骤 0 补。cookie（聚光灯前加一张图案贴图）语料 0 张，继续照报。

**P13j 预光照（`PRELIGHTING`）**改的是「开了光照的图层带 effect」时光照算在哪一步。没有 effect 的图层直接画上屏，顶点就在场景坐标里，光照照常算（lighting-REPORT 已实现）。带 effect 的图层先把基础 pass 画进自己的离屏合成 RT，再让 effect 一个个处理，最后上屏。WPE 在这种情况下给基础 pass 开 `PRELIGHTING=1`，在离屏 RT 里就把光照算好；effect 处理的是已经打过光的画面，上屏 pass 不再算光。离屏 RT 里的顶点坐标是 RT 的像素坐标，不是场景坐标，所以着色器另收一套「图层在场景里真实位置」的矩阵 `g_AltModelMatrix` / `g_AltNormalModelMatrix` / `g_AltViewProjectionMatrix`，用它们算世界位置、法线和灯的方向。我们要做的是：基础 pass 加组合键、写这三个矩阵、上屏关光照，puppet 的蒙皮、雾（`FOG_COMPUTED`）和反射在这条路径上的取法照 WPE 补齐。三个矩阵的确切取值（含不含视差、puppet 时是什么）读码没到，步骤 0 补。

两节互不依赖。推荐先做 P13i：底座都在、改动面小。P13j 要碰图层渲染图与 puppet 的合成路径，放在后面。

## 两个效果是什么（给用户看）

### 聚光阴影（`lightconfig.spotshadow`）

- **聚光**（`lspot`）像舞台射灯或手电筒：从一点朝一个方向照出一个圆锥，内锥里全亮、到外锥渐暗，锥外不亮。我们已经支持聚光照明。
- **阴影**：灯开了 `castshadow` 且 `lightconfig` 里留了阴影名额时，WPE 先从灯的位置把会挡光的模型画进一张深度图（阴影图），再在正常画面里逐像素查「这一点和灯之间有没有东西挡着」，挡着的地方不接受这盏灯的光，于是物体在锥形光里投下影子。点光和平行光的影子 P13d 已经做了，聚光的还没有。
- **样本 `3455121165`（Solar system 太阳系）**：`lightconfig` 是 2 盏点光（1 盏带阴影）+ 1 盏聚光（带阴影）。聚光在 (0, 7, 0)、朝下（z 轴转 −90°），内锥 26.66°、外锥 63.18°、半径 30，挂在一个会转的父对象下。现在这张只差聚光阴影，整张退回封面。
- 步骤 0 会把这张在 WPE 里分别按「阴影 low」与「阴影关」抓一帧，并排给你看聚光阴影到底改了画面哪里。

### 预光照（`PRELIGHTING`）

- **图层光照**：2D 图层可以配一张法线图，让平面的立绘像有体积一样受光，灯在场景里移动时明暗跟着变。没有 effect 的图层我们已经支持。
- **预光照**是「打了光的图层还叠了 effect」时 WPE 的画法：先在图层自己的离屏画布上把光照算好，再让 effect（水波扭曲、透明度遮罩等）处理带光的结果，最后上屏不再算光。效果上，光影会跟着水波一起被扭曲、被遮罩一起裁掉，而不是光照浮在 effect 之上。
- 为什么麻烦：离屏画布上顶点的坐标是画布像素，不是场景里的位置，算光照要知道图层在场景里的真实位置和朝向，所以 WPE 多传一套矩阵（`g_Alt*`）。
- **样本 `2515018199`（Artorias 4k）**：4K 正交场景，人物拆成 5 个部件图层，都用 `genericimage2` + 法线图 + `LIGHTING` + `REFLECTION`，被 3 盏位置、强度、半径都挂关键帧的遗留点光照亮（光在人物身上游走）。5 个部件都是 puppet（骨骼动画），其中 3 个带 opacity / waterwaves 等 effect，这 3 个就走预光照。现在只差这一项，整张退回封面。
- **`3662790108`（哈勃）**也用到预光照，但工坊内容缺 9 个材质文件，做完 P13j 仍不能渲染。

## 现状锚点

**a. 聚光阴影：宿主照报**（`apps/wpe-scene/src/compile/lights.ts:78`）
```ts
/** `lightconfig` 里聚光的阴影 / cookie（按档位解析之后）：照报，不生成缺阴影的画面。点光、平行光的阴影 P13d 起支持。 */
export function lightConfigIssues(general: Record<string, unknown>, quality = 0): string[] {
  const counts = lightCounts(general, quality);
  const values = { spotshadowcookie: counts.spotShadowCookie, spotshadow: counts.spotShadow, spotcookie: counts.spotCookie };
  return SPOT_SHADOW_KEYS.filter((key) => values[key] > 0).map((key) => `lightconfig:${key}`);   // 现状：三种都照报
}
```

**b. 聚光阴影：翻译器展开不了**（`src-tauri/wpesl2wgsl/src/library.rs:60`）
```rust
for shadow in SPOT_SHADOW_MACROS {            // LIGHTS_SPOT_SHADOW / _COOKIE / _SHADOW_COOKIE
    if macro_nonzero(shadow) {
        return Ok(Expansion::Unsupported("LightingV1/spot-shadow".to_string()));   // 现状：整段不展开
    }
}
```

**c. 预光照：宿主照报**（`apps/wpe-scene/src/compile/bundle.ts:3105`）
```ts
// 带 effect 或走 passthrough 时，WPE 把光照挪到基础 pass（PRELIGHTING=1，世界坐标改用 g_Alt*），上屏 pass 关光照（FUN_140209540）
const lit = layer.passes.some((pass) => pass.program !== null && usesLighting(bundle.programs[pass.program]));
// TODO:[WPE_SCENE] PRELIGHTING 没实现，照报 …
if (lit && (layer.effects.length > 0 || blended || depended || fogged)) unsupported.add("lighting:prelighting");
```

**d. 预光照：三个矩阵放行但不写**（`apps/wpe-scene/src/compile/features.ts:144`）
```ts
/** 光照路径声明了、只有 PRELIGHTING 才读的 uniform（`genericimage4.vert`）：渲染器不写，PRELIGHTING 另报。 */
const UNREAD_UNIFORMS = new Set(["g_AltModelMatrix", "g_AltNormalModelMatrix", "g_AltViewProjectionMatrix"]);
```

**e. WPE 着色器里 `PRELIGHTING` 的含义**（`assets/shaders/genericimage2.vert`，`genericimage4` 同形）
```glsl
#if PRELIGHTING
#define M_MDL g_AltModelMatrix          // 世界位置用「图层在场景里」的模型矩阵
#define M_NML g_AltNormalModelMatrix
#define M_VP  g_AltViewProjectionMatrix
#else
#define M_MDL g_ModelMatrix             // 直接上屏时就是图层自己的矩阵
#define M_NML g_NormalModelMatrix
#define M_VP  g_ViewProjectionMatrix
#endif
vec4 worldPos = mul(vec4(localPos, 1.0), M_MDL);   // 光照、反射都从这里取世界坐标
```

## 已知与未知

| 项 | 已知（来源） | 步骤 0 要补 |
|---|---|---|
| 聚光阴影的着色器段 | 生成器段顺序与公式：`pc = CalculateProjectedCoords(worldPos, ShadowProjection[i])`、`sf = PerformShadowMapping(pc, ShadowProjectionTransform[i])`、乘锥角衰减；投影槽 = 聚光自己的下标（rea-p13-shadows 1.3） | 翻译器按这一段展开；cookie 两段照报 |
| 灯排序与槽位 | 类型升序、`castshadow` / `usecookie` 降序、局部 origin · `g_ViewForward` 升序；聚光槽 `[0, SSC+SC+SS)` 在平行光之前（rea-p13-shadows 2.3、1.3） | — |
| 阴影 pass 的偏移 | 聚光与平行光一样 `VP[3][2] −= 0.0005f`，uniform 不偏（rea-p13-shadows） | 抓帧核对 |
| 聚光投影 | 未读（`FUN_14025d420` 类型 1） | fov（外锥？两倍？）、宽高比、近远平面（半径？`lightsourcesize`？）、朝向与 up |
| 图集打包 | 点光 2×3 面、平行光三级，方块 256 / 512 / 1024，点光优先（P13d） | 聚光一块多大、排在哪 |
| 投射者 | 不透明、`castshadow` 不为 false 的模型（P13d） | 聚光视图是否另做视锥剔除 |
| 预光照的条件 | 材质带 `LIGHTING` 或 `REFLECTION` 且走合成路径（rea-p12-mdl 预光照一行）；现在只看 `LIGHTING` | 只开 `REFLECTION` 的图层是否也开 `PRELIGHTING`（会多出受影响的场景） |
| `g_Alt*` 三个矩阵 | 名字与用法（着色器原文） | 取值：模型矩阵是不是图层的世界矩阵、带不带视差 / 对齐偏移；VP 是不是场景 VP；puppet 时怎么配骨骼 |
| 基础 pass 的其它状态 | 上屏 pass 关光照（`FUN_140209540`）；雾走 `FOG_COMPUTED`（rea-p13-lights 2.4【推】） | 基础 pass 的雾、反射的屏幕坐标、混合 |
| puppet + 预光照 | `puppet:texture-channels:prelighting` 照报（P12b2） | 蒙皮矩阵与 `g_Alt*` 的关系；Artorias 的 3 个部件要用到 |

## 分节

### P13i — 聚光阴影

- **步骤 0**
  - 读码：聚光投影（`FUN_14025d420` 类型 1）、图集里聚光块的大小与位置、投射者与剔除。
  - 确定性工程（kbp gen，同 P13d 的 `gen_d0.py`）：
    - 一盏带阴影的聚光照地面与立方体，预测阴影 pass 的 VP 与图集矩形；
    - 聚光 + 点光 + 平行光各带阴影，看打包顺序；
    - 改外锥角与半径，看投影跟着怎么变。
  - 给用户看：`3455121165` 在 WPE 里阴影 low / 关各抓一帧，并排对比。
- **实现**
  - 翻译器：展开「聚光 · 阴影」段，cookie 两段仍报 `LightingV1/spot-shadow`（改名区分）。
  - 宿主：`lightConfigIssues` 只报 cookie；`lightFrame` 写聚光的 `ShadowProjection` / `…Transform`。
  - 渲染器：`render/shadows.ts` 给聚光分配图集块、建一个阴影视图。
- **验收**
  - 确定性工程与 WPE 整帧逐像素比；
  - 语料只去掉 `lightconfig:spotshadow` 与 `shader:generic4:require:LightingV1/spot-shadow`，能渲染 199 → 200（`3455121165`）；
  - 走查 `3455121165` 复制工程。

### P13j — 预光照

- **步骤 0**
  - 读码：`g_Alt*` 三个矩阵在哪写、取值；预光照的触发条件（`LIGHTING` / `REFLECTION`）；基础 pass 的雾、反射、混合；puppet 时的蒙皮。
  - 语料扫描：只开 `REFLECTION` 且走合成的图层有多少（决定条件放宽后会不会新增受影响的场景）。
  - 确定性工程：
    - 法线图图层 + 一个 effect + 一盏会动的点光；
    - 带父对象、旋转、缩放、视差的同一图层；
    - colorBlendMode 混合 / 被依赖 / 开雾三种走合成的情形；
    - puppet 图层带 effect；
    - 以上和「去掉 effect 的同一图层」对照，确认光照落在 effect 之前。
  - 给用户看：`2515018199` 去掉 effect 与带 effect 各抓一帧，看光影是否随水波扭曲。
- **实现**
  - 编译期：基础 pass 加 `PRELIGHTING=1`（和需要的 `FOG_COMPUTED`），上屏 pass 关光照；去掉 `lighting:prelighting` 与 `puppet:texture-channels:prelighting`。
  - 渲染器：按步骤 0 的规则写 `g_AltModelMatrix` / `g_AltNormalModelMatrix` / `g_AltViewProjectionMatrix`，从 `UNREAD_UNIFORMS` 移进引擎 uniform 表。
  - 删掉 `bundle.ts` 那条 `TODO:[WPE_SCENE]`。
- **验收**
  - 确定性工程与 WPE 整帧逐像素比；
  - 语料只去掉 `lighting:prelighting`（和条件放宽后应去掉的键），能渲染 → 201（`2515018199`）；
  - 走查 `2515018199` 复制工程（遗留灯按关键帧回放）。

## 决定（2026-11-18 用户：「好，现在p13i」，四条按推荐）

1. 先 P13i 再 P13j。
2. 聚光 cookie 与体积光的聚光阴影继续照报。
3. `lighting:effect` 继续照报。
4. 预光照的触发条件照 WPE 改成 `LIGHTING` 或 `REFLECTION`，P13j 步骤 0 先扫语料。

子计划：P13i 见 [phase-13i-spot-shadow.md](phase-13i-spot-shadow.md)（2026-11-18 完成：语料 205 → 206，`3455121165`）。

## 待定（原文，已按上面定）

1. **顺序**：推荐先 P13i 再 P13j（理由见「总体设计思路」）。
2. **聚光 cookie**（`spotcookie` / `spotshadowcookie`，要 `_alias_lightCookie` 贴图）**与体积光的聚光阴影**（`volumetrics:spot-shadow`）：语料都是 0 张，推荐继续照报，P13i 只做聚光阴影。
3. **effect 自己开光照**（`lighting:effect`，effect 材质里的 `LIGHTING`）：语料 0 张，和预光照是两回事。推荐继续照报。
4. **预光照的触发条件**：读码说「`LIGHTING` 或 `REFLECTION`」，我们现在只看 `LIGHTING`。推荐照 WPE 改成两者都算；如果步骤 0 的扫描发现因此多出受影响又暂时做不到的场景，再报给你。

> 更正（2026-11-20）：`3662790108` 的 9 个缺材质不是工坊内容缺文件，是 `scene.pkg` 查找区分大小写（场景写 `HUBBLE`、包里是 `hubble`），WPE 查找不分 ASCII 大小写；照 WPE 改了之后语料干净，见 `cocs/wpe/WPE_SCENE.md`「`scene.pkg`」。
