# P13k — 聚光 cookie 与体积光的聚光阴影

起因：语料新增 `3839619935`（2026-11-20 语料清扫转来），扫描只差 `lightconfig:spotshadowcookie`、`volumetrics:cookie`、`volumetrics:spot-shadow` 三个键。P13ij 总计划的决定 2（[phase-13ij-spot-prelighting.md](phase-13ij-spot-prelighting.md)，「语料 0 张，继续照报」）改定为做，表面着色的 cookie 一起做（2026-11-20 用户定）。读码：[rea-p13-shadows.md](rea-p13-shadows.md) R1（生成器的四段聚光）、R2（槽位与写入）、[rea-p13-volumetrics.md](rea-p13-volumetrics.md) V1.2 / V2 / V6 / V9（聚光投影、体积光的写入、`COOKIE` / `SHADOW`）、[rea-p13-lights.md](rea-p13-lights.md) 3.1（`usecookie` 与 `cookie` 字段）、[../phase8/rea-p8-render.md](../phase8/rea-p8-render.md) 2.1（全局别名 `_alias_lightCookie`）。

## 总体设计思路

cookie 是一张贴在聚光上的 2D 纹理：聚光的视图投影（P13e 已逐位对过的 `spotViewProjection`）把世界点投到灯的裁剪空间，xy 映射成 UV 去采这张图，结果乘到灯的颜色上，代替锥角衰减。WPE 里它出现在两处，用同一个投影、各自的映射：

- **体积光**（正面 pass）：`COOKIE = 1` ⇔ `usecookie`，槽 2 绑这盏灯自己的 cookie 纹理；沿视线步进时每个采样点 `uvs = (p · VP) / w`，`xy · (0.525, −0.525) + 0.5`（比表面略放大，着色器注释说是遮边），`cookieColor = texSample2D(g_Texture2, uvs.xy).rgb`，锥角衰减换成 1，累加量从标量变成 rgb，步数从 2 / 3 / 5 / 8 涨到 12 / 24 / 32 / 64。灯体网格也换：开 cookie 的聚光用 NDC 立方体（8 点 12 面）代替 32 段圆柱，相机在不在灯体内改用「`eye + 0.1·F` 在灯视锥六面内」判定。聚光开阴影时（`SHADOW` = `castshadow` ∧ 阴影档 ≠ 0），在同一个 `uvs` 上再套这盏灯阴影条目的方块变换（`g_RenderVar0`），对阴影图集做比较采样，起点加 `hash12` 抖动——P13i 已经给带阴影的聚光分了图集块与条目，体积光只是第二个读者。
- **表面着色**（`#require LightingV1`）：生成器的聚光四段里，「阴影 + cookie」「cookie」两段在 `CalculateProjectedCoords`（`xy · (0.5, −0.5) + 0.5`）的坐标上采 `COOKIE_SAMPLER`，颜色乘 cookie、**没有锥角衰减**，前者再乘阴影因子。取样器是材质的一个槽（`genericimage4` / `generic4` 等是 `g_Texture7`，`genericparticle` 是 `g_Texture5`），只在宏 `LIGHTS_COOKIE` 下声明，缺省名 `_alias_lightCookie`——**所有 cookie 聚光共用这一个槽**，别名在 WPE 里解析到哪张纹理是本节要读的关键之一。投影槽 P13i 已按段排好（cookie 段的 `ShadowProjection` 下标是 `SSC`），只差给只开 cookie 的灯写投影。

我们这边的形状：编译期把每盏 `usecookie` 聚光的 cookie 纹理当普通 `.tex` 进 `bundle.textures`（`SceneLightObject.cookie` 记下标）；体积光正面 pass 的槽 2 直接绑它；表面着色的 `_alias_lightCookie` 当成和 `_rt_*` 同类的运行时纹理（`TextureRef` 新增 `light-cookie`），渲染器按 WPE 的别名规则每帧解析到某盏灯的 cookie；翻译器生成两段 cookie 块并定义 `LIGHTS_COOKIE`。四个照报键（`lightconfig:spot*cookie`、`LightingV1/spot-cookie`、`volumetrics:cookie`、`volumetrics:spot-shadow`）全部去掉。

拆两步：**P13k-1 体积光**（cookie 纹理、体积光的 `COOKIE` 与聚光 `SHADOW`、立方体灯体，解锁 `3839619935`）；**P13k-2 表面着色**（LightingV1 两段、`LIGHTS_COOKIE`、别名、cookie 灯的投影；语料 0 张，靠生成工程验证）。k-1 做完先报。

关键决策：
- cookie 纹理走现有的纹理加载（`compile/bundle.ts` 的 `getTexture`，同一个 `.tex` 解码、去重、`texture:*` 键），不另写；`cookie` 字段只在加载时读（rea-p13-lights 3.1：`FUN_14025d080` 加载时读、没有改值回调），运行中改照报 `light:runtime:cookie`（新键）。`usecookie` 运行中变仍照报（P13f2 已有 `light:runtime:usecookie`）。
- 体积光的聚光阴影复用 P13i 的条目与图集，不加新的打包规则；`g_RenderVar0` 取这盏灯的聚光条目的方块变换，同点光体积光取点光条目的做法。
- 别名做成运行时纹理引用，不在编译期定死某张：WPE 的别名是全局表里的一项，取值可能随灯变（待读码 R2）；做成运行时引用，读码结论是什么都只改解析函数。
- 先照 WPE 着色器原样（0.525 与 0.5 两种映射、cookie 时不乘锥角），不「修」。

## 现状锚点

**a. 翻译器遇到 cookie 宏整段照报**（`src-tauri/wpesl2wgsl/src/library.rs:61`）
```rust
    for cookie in SPOT_COOKIE_MACROS {               // LIGHTS_SPOT_COOKIE、LIGHTS_SPOT_SHADOW_COOKIE
        if value(cookie)? != 0 {
            return Ok(Expansion::Unsupported("LightingV1/spot-cookie".to_string()));   // 现状：不生成
        }
    }
```

**b. 宿主照报 lightconfig 的两个 cookie 键**（`compile/lights.ts:88`）
```ts
export function lightConfigIssues(general: Record<string, unknown>, quality = 0): string[] {
  const counts = lightCounts(general, quality);
  const values = { spotshadowcookie: counts.spotShadowCookie, spotcookie: counts.spotCookie };
  return SPOT_COOKIE_KEYS.filter((key) => values[key] > 0).map((key) => `lightconfig:${key}`);   // 现状：有就报
}
```

**c. 聚光写槽：只开 cookie 的灯占投影槽但不写投影**（`compile/lights.ts` 的 `lightFrame`）
```ts
      const cookie = (light.flags & 2) !== 0;
      if ((flag || cookie) && projectionsLeft > 0) {
        projectionsLeft--;
        const projection = spotProjectionSlots[segment]++;
        if (flag) entries.push({ kind: "spot", light, cascade: null, slot: projection });   // 现状：cookie 的投影没写
      }
```

**d. 体积光：cookie 与聚光阴影照报，组合键没有 `COOKIE`**（`compile/volumetrics.ts:397`、`:416`）
```ts
    if (light.flags & 2) issues.add("volumetrics:cookie");
    const shadow = (light.flags & 1) !== 0 && shadowQuality !== 0;
    if (kind === "spot") {
      if (shadow) issues.add("volumetrics:spot-shadow");          // 现状：聚光阴影照报
      ...
    const combos: Record<string, number> = {
      POINTLIGHT: kind === "point" ? 1 : 0,
      SHADOW: shadow ? 1 : 0,
      QUALITY: quality,
      ...(kind === "point" ? { LIGHTS_SHADOW_MAPPING_QUALITY: shadowQuality } : {}),
    };                                                             // 现状：没有 COOKIE
```

**e. 体积光的阴影输入只认点光条目**（`render/scene.ts` 体积光帧回调）
```ts
        const entry = lights?.entries.find((item) => item.kind === "point" && item.light.object === object);   // 现状：聚光取不到
        ...
          ...(entry ? { shadow: { transform: slice(layout.pointProjectionTransform), projection: slice(layout.pointProjection) } } : {}),
```

**f. 运行时纹理名的映射**（`render/graph.ts:146`；编译期 `compile/bundle.ts` 的 `bindRuntime` 同一组名字）
```ts
function runtimeInput(name: string): TextureRef | null {
  if (name === FRAMEBUFFER_RT) return { kind: "framebuffer" };
  if (name === REFLECTION_RT) return { kind: "reflection" };
  if (name === MIP_FRAMEBUFFER_RT) return { kind: "mip-framebuffer" };
  if (name === SHADOW_ATLAS_RT) return { kind: "shadow-atlas" };
  return null;                                                     // 现状：没有 _alias_lightCookie
}
```

## 步骤 0：读码（P13k-1 之前做完 R1、R5、R6；k-2 之前做完其余）

| 编号 | 问题 | 线索 |
|---|---|---|
| R1 | 缺省 cookie 是哪个路径（`0x140491ad8`）；`cookie` 字段的写法（带不带 `materials/`、`.tex`）、加载的采样状态（钳制 / 重复、过滤、mip）、文件缺失时怎样 | `FUN_14025d080`；`assets/materials/cookie/flashlight1–4.tex` |
| R2 | `_alias_lightCookie` 解析到哪张纹理、谁在什么时候改它（第一盏 / 最后一盏 cookie 灯、每帧还是加载时），没有 cookie 灯时是什么 | `FUN_140002050` 初始化的别名表；`FUN_14014cf90` 的别名分支；灯光函数里写别名的点 |
| R3 | `LIGHTS_COOKIE` 由谁定义、条件（`SC + SSC > 0`？），和 `LIGHTS_SPOT_*COOKIE` 的关系 | 引擎宏生成器 `FUN_1401a5c40` |
| R4 | 生成器两段 cookie 块的原式：采样器名、乘法顺序、是否真的不乘锥角（R1 1.3 记的是公式） | `FUN_140169140` 聚光段（`0x140169d42` 之后） |
| R5 | 体积光聚光阴影：`light+0x310`（`g_RenderVar0`）在聚光条目上是哪一处写的、是不是这条条目的方块变换；`light+0x338` 与阴影 pass 的偏移（`vp[14] − 0.0005`）是什么关系 | `0x140196114` / `0x1401962d8`；P13i 的 `CASCADE_DEPTH_OFFSET` |
| R6 | 体积光 cookie 槽（材质 `+0xe0`）的采样状态；cookie 灯立方体网格的顶点 / 索引与正面 0.99 缩放；「在灯内」判定的六面 | rea-p13-volumetrics V3「cookie：NDC 立方体」、`0x1401979c3` |
| R7 | 只开 cookie 的灯：`ShadowProjection[SSC + k]` 写什么、`ShadowProjectionTransform` 写什么（不进图集） | `0x140192dbf` 之后的写入；P13i 点 2 |

每条读码结论配一个生成工程用例（双向验证）。

### 读码结论（2026-11-20，`wallpaper64.exe` 2.8.42，SHA-256 `40e2ce02…`，与安装目录一致；汇编片段在 `ignore/p13/k/rea/asm/`）

- **R1**（`FUN_14025d080`）：基类加载之后，`usecookie`（`+0x2c4` bit1）为真才读 JSON 键 `cookie`，只认字符串（值类型 4，`{user}` 对象不认）；非空就按**纹理名**去纹理表取（`FUN_14014cf90(ctx+0x1520, 名, 1)`，同材质 `textures` 的名字，落在 `materials/<名>.tex`），写 `light+0x330`；仍为空（键缺、不是字符串、空串）才用缺省 `cookie/flashlight1`（`0x140491ad8`）。名字指向不存在的文件时纹理表照样新建文件纹理占位（rea-p8-render 2.1 的棋盘格），**不退回缺省**。采样状态取纹理自己的标志（`FUN_140099980(视图, 纹理标志 | 0x4000000, 1)`，同普通纹理）。
- **R2**（`FUN_140190c80` 灯光函数）：每帧排序之后把「当前 cookie」清成 null（`0x140191071` / `0x140191099`），遍历时**可见且分到聚光槽**的聚光写完槽位后，`usecookie` 就把它换成本灯的 `light+0x330`（`0x140192f04`），所以是**排序后最后一盏** cookie 聚光的图。循环后与上次设的值（`ctx+0x1220`）不同才更新别名：`FUN_14014cf90("_alias_lightCookie", 新建)`，再调别名对象的 `+0x58`（`0x1401935ab`–`0x1401935d8`）。别名对象（设备虚函数 `+0x68` = `FUN_14009acd0`，虚表 `0x140487018`）建时指向回退纹理 `error`；`+0x58` = `FUN_1400ef850`：非 null 就换绑定视图并记下，**null 只清记录、不清绑定视图**，所以没有 cookie 灯的那一帧着色器读到的是上一次绑的那张（一开始是 `error`）。场景析构 `FUN_140188860` 设 null。
- **R3**（`FUN_1401a5c40`，`0x1401a638c`）：`LIGHTS_COOKIE = 1` ⇔ `LIGHTS_SPOT_COOKIE + LIGHTS_SPOT_SHADOW_COOKIE ≠ 0`（bit18–19 + bit20–21，按档位解析之后）。
- **R4**（生成器字符串 `0x14048c2b0`–`0x14048c6e0`）：两段 cookie 块都是 `lightDelta = g_LSpot_Origin[i].xyz − worldPos`、`projectedCoords = CalculateProjectedCoords(worldPos, g_LFeature_ShadowProjection[i])`、（阴影段）`shadowFactor = PerformShadowMapping(projectedCoords, g_LFeature_ShadowProjectionTransform[i])`、`colorCookie = texSample2D(COOKIE_SAMPLER, projectedCoords.xy).rgb`，颜色参数 `g_LSpot_Color[i].rgb * colorCookie`，最后一个参数 `shadowFactor` / `1.0`；**不乘锥角**（锥角那两行 `spotCookie` 只在后两段）。
- **R5**（`0x1401962b5`–`0x14019632a`）：非点光的阴影条目把方块变换同时写进 `ShadowProjectionTransform[槽]` 与 `light+0x310`，所以体积光聚光的 `g_RenderVar0` 就是这盏灯阴影条目的方块变换（P13i 已算好）；阴影 pass 的 VP 另拷一份再 `[3][2] −= 0.0005`，`light+0x338`（体积光的 `g_AltModelMatrix`）是不偏的，同表面。
- **R6**（rea-p13-volumetrics V3、V4，本轮不再重读）：立方体 8 点 36 索引、在内判定 `eye + 0.1·F` 对六个视锥平面；体积光槽 2 绑 `light+0x330`、采样状态同 R1。补正：`COOKIE = 1` 只看 `usecookie`（`0x14019817e`），**不分类型**：点光开 cookie 时着色器用点光阴影投影的坐标采 cookie，没分到阴影条目时是残留值（V6），语料 0 张，照报 `volumetrics:cookie:point`。
- **R7**（`0x140192f1e`–`0x140193173`）：带阴影**或** cookie 的聚光在 N 有余量时都算 `light+0x338`（`FUN_14025d420`）、写 `ShadowProjection[段指针]`、两个段指针都推进；方块变换那一格不写（只开 cookie 的段不读它），只有带阴影的生成阴影条目（`0x140193164`）。

### 抓帧核对（`ignore/p13/k/gen_k.py`，`A:\p13k\<工程>\`，WPE 阴影 low、体积光 low、后处理 ultra，设置没改）

| 工程 | 核对 | 结果 |
|---|---|---|
| `p13k-vol` | 背面 / 正面画几个索引；正面 cookie 槽绑什么 | 36 / 36（立方体）；512×512 RGBA8、8 级 mip（`flashlight1`），钳边、8× 各向异性（纹理自己的采样状态）✓ R1、R6 |
| `p13k-vol-explicit` | cookie 槽 | `flashlight3`（与下面的别名逐字节相同）✓ R1 |
| `p13k-vol-bad` | 写了不存在的 `cookie/nope` | 6×6 点采样、重复寻址的棋盘格占位，不是 `flashlight1` ✓ R1 |
| `p13k-vol-shadow` | 正面 `g_RenderVar0` / `g_AltModelMatrix` | `(0, 0, 1, 1)`（低档图集里只有这一块，方块变换即整张）；聚光 VP ✓ R5 |
| `p13k-vol-inside` | 相机在灯视锥里 | 背面 36 个索引，正面换成 3 个顶点的全屏三角形 ✓ R6 |
| `p13k-surf-two` | 两盏 cookie 灯（A 缺省、B `flashlight3`，B 排后）照地面时 `COOKIE_SAMPLER` 绑什么 | `flashlight3`，两盏共用 ✓ R2；**采样器是钳到边框（黑边）+ 线性、没有各向异性**——别名建视图时带的 `| 0x4000000`（`FUN_140099980`），和体积光那边按纹理标志的不同 |

- 边框寻址 WebGPU 没有：内置两张 cookie 的 0–2 级 mip 最外一圈都是 0、第 3 级最大 0.25/255（`ignore/p13/k/edge_check.py`），表面 cookie 用钳边 + 线性代替，结果最多差一级，记为已知差异；作者自己的 cookie 边缘不黑时会不同（语料 0）。
- cookie 文件不存在：WPE 画棋盘格；我们照材质纹理的规矩报 `texture:missing:<路径>`，不另画棋盘格。

## 步骤 0：确定性工程（`ignore/p13/k/gen_k.py`，抓帧放 `A:\p13k\`）

正交 1920×1080，一盏 `lspot` 照向画面中央，`lightconfig` 按用例给。

| 工程 | 内容 | 验什么 |
|---|---|---|
| `p13k-vol` | `usecookie` + `castvolumetrics`，无阴影，缺省 cookie，没有光照材质 | R1、体积光 `COOKIE`、立方体、0.525 映射 |
| `p13k-vol-shadow` | `castshadow` + `castvolumetrics`（无 cookie），一个投射模型挡在光柱里 | R5、体积光聚光阴影 |
| `p13k-vol-both` | 两者都开（同 `3839619935` 的灯） | `SHADOW` 与 `COOKIE` 叠加 |
| `p13k-vol-explicit` | `cookie` 写成 `flashlight3` 的几种写法 | R1 字段写法 |
| `p13k-vol-inside` | 相机进到 cookie 灯视锥里 | R6 全屏判定 |
| `p13k-surf` | `generic4` 模型与 `genericimage4` 图层（`LIGHTING`）受 cookie 聚光照，分「cookie」「阴影 + cookie」两种 | R3、R4、R7 |
| `p13k-surf-two` | 两盏 cookie 聚光、不同 cookie | R2 别名取哪张 |
| `p13k-particle` | `genericparticle`（`LIGHTING`）受 cookie 聚光照 | 粒子的 `g_Texture5` |
| 阴影档 disabled 各跑一遍（`capture_sweep` 临时改、跑完改回） | `spotshadowcookie` 并进 `spotcookie` | 档位 0 的分段 |

## 实施（P13k-1 体积光）

### 点 1 — 灯的 cookie 纹理（`compile/lights.ts`、`compile/bundle.ts`）
- **新增** `SceneLightObject.cookie: number | null`：`usecookie` 的聚光按 R1 取 `cookie` 字段（缺就用缺省路径），经 `getTexture` 进 `bundle.textures`，下标记在这里；其它灯 null。
- **新增** `cookie` 挂属性 / 脚本 / 关键帧照报 `light:runtime:cookie`（`LIGHT_STATIC_KEYS` 加一项）。
```ts
export interface SceneLightObject {
  ...
  /** usecookie 的聚光（P13k）：cookie 纹理在 `bundle.textures` 里的下标（`cookie` 字段，缺省 R1 的路径）；其它为 null */
  cookie: number | null;   // 新增
}
```

### 点 2 — 体积光的 `COOKIE` 与聚光 `SHADOW`（`compile/volumetrics.ts`）
- **删除** `volumetrics:cookie`、`volumetrics:spot-shadow` 两个键。
- **修改** 组合键加 `COOKIE`（⇔ `usecookie`），`VOLUMETRICS_COMBOS` 加 `COOKIE`；正面 pass 的槽 2 绑这盏灯的 cookie（`FRONT_SLOTS` 加槽 2，`ScenePass.textures[2]` = `light.cookie`）。
- **修改** `VolumetricLight` 加 `cookie: boolean`，渲染器据此选网格与「在内」判定。
```ts
    const cookie = kind === "spot" && (light.flags & 2) !== 0;
    const combos: Record<string, number> = {
      POINTLIGHT: kind === "point" ? 1 : 0,
      SHADOW: shadow ? 1 : 0,
      QUALITY: quality,
      ...(cookie ? { COOKIE: 1 } : {}),                         // 新增（0x14019817e）
      ...(kind === "point" ? { LIGHTS_SHADOW_MAPPING_QUALITY: shadowQuality } : {}),
    };
```

### 点 3 — cookie 灯的灯体与「在内」判定（`compile/volumetrics.ts`、`render/volumetrics.ts`）
- **新增** `spotLightCube()`：NDC `[−1, 1]² × [0, 1]` 的 8 点 12 面（索引顺序照 R6），和 `spotLightCylinder()` 同一个接口。
- **修改** 判定：cookie 灯用 `p = eye + 0.1·F`、灯 VP 的六个视锥平面都在内侧（`0x1401979c3`），非 cookie 照旧。

### 点 4 — 体积光取聚光阴影条目（`render/scene.ts`、`render/volumetrics.ts`）
- **修改** 帧回调按灯的种类取条目：聚光取 `kind === "spot"` 的条目，`g_RenderVar0` = 它的 `ShadowProjectionTransform`（R5 定），图集绑槽 0；点光照旧。
```ts
        const entry = lights?.entries.find(
          (item) => (item.kind === "point" || item.kind === "spot") && item.light.object === object,   // 修改：聚光也取
        );
        ...
          ...(entry ? { shadow: shadowInputOf(entry, lights!) } : {}),   // 修改：聚光只要方块变换，点光照旧带投影四元组
```

### 点 5 — 单测、语料、走查
- **新增** `render/p13k-vol.test.ts`：抓帧的体积光常量（`g_RenderVar0`、`g_AltModelMatrix`）、立方体网格、判定逐位对 WPE；`compile/volumetrics` 的组合键与槽。
- 语料「HEAD」与「HEAD + P13k-1」两份快照：`3839619935` 去掉 `volumetrics:*` 两键（`lightconfig:spotshadowcookie` 要等 k-2）。
- 走查：`3839619935` 的复制工程（留灯 321 与背景，脚本驱动的时钟 / 媒体文本层与雨粒子去掉或换成固定值），WPE 与我们整帧比。

## 实施（P13k-2 表面着色）

### 点 6 — 翻译器生成两段 cookie（`src-tauri/wpesl2wgsl/src/library.rs`）
- **删除** `SPOT_COOKIE_MACROS` 的照报与对应单测。
- **新增** 聚光段前两段：`SSC` 个「阴影 + cookie」、`SC` 个「cookie」，投影下标同本灯（段指针 0、`SSC`），式子照 R4；段顺序与浮点累加顺序同 WPE。`Counts` 加 `spot_cookie`、`spot_shadow_cookie`，投影个数 `N = SSC + SC + SS + 3·DS`、级联基址 `SSC + SC + SS`。
```rust
    // 聚光·阴影 + cookie（R1 1.3）：投影同下标，没有锥角衰减，颜色乘 cookie、传阴影因子
    for i in 0..c.spot_shadow_cookie {
        write!(out, "\t{{\n\t\tvec3 toLight = g_LSpot_Origin[{i}].xyz - pos;\n\t\tvec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[{i}]);\n\t\tfloat shadowFactor = PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[{i}]);\n\t\tvec3 cookie = texSample2D(COOKIE_SAMPLER, shadowCoords.xy).rgb;\n\t\tsum += ComputePBRLightShadow(n, toLight, v, albedo, g_LSpot_Color[{i}].rgb * cookie, ...);\n\t}}\n")?;
    }
    // 聚光·cookie：同上去掉阴影，传 1.0
```

### 点 7 — `LIGHTS_COOKIE` 与别名（`compile/lights.ts`、`compile/bundle.ts`、`render/graph.ts`、`render/scene.ts`）
- **新增** `litDefines` 按 R3 写 `LIGHTS_COOKIE`。
- **新增** `bindRuntime` 认 `_alias_lightCookie`；`TextureRef` 加 `{ kind: "light-cookie" }`，`runtimeInput` 映射它；渲染器按 R2 的规则解析到某盏灯的 cookie GPU 纹理（没有时按 R2 的结论），绑定随帧变就走和反射图同样的「按帧换 bind group」。
- **修改** `lightFrame`：只开 cookie 的聚光写 `ShadowProjection[SSC + k]` 与变换（R7）。
- **删除** `lightConfigIssues` 的两个 cookie 键与 `SPOT_COOKIE_KEYS`；`lightConfigIssues` 若因此不再报任何键，就删掉它与 `bundle.ts` 的调用。

### 点 8 — 单测、语料、文档
- **新增** 翻译器单测（两段的下标、级联基址、`N`）；`compile/p13k.test.ts`（cookie 下标、`LIGHTS_COOKIE`、别名的输入种类）；抓帧的 `g_LFeature_ShadowProjection` / 变换逐位对 WPE。
- 语料：`3839619935` 变干净（能渲染 +1），没有新增键。
- 文档：`WPE_SCENE.md` 光照 / 体积光 / 阴影三条、`cocs/README.md`、`p13-REPORT.md`「P13k 的实测」、changelog、回归节。

## 验证

- 每一步：`apps/wpe-scene` 的 tsc；相关测试文件（`lights.test.ts`、`p13i-spot.test.ts`、`p13e` 系、`p13j.test.ts`、新增的 `p13k*`）；翻译器 `cargo test --lib` 并重编 wasm（k-2）。
- 生成工程与 WPE 整帧比，目标逐像素相同或只有零星取整差；体积光带阴影时有 `hash12` 抖动，像素差按误差包络看。
- 变异：k-1 去掉 `COOKIE`、cookie 灯仍用圆柱、聚光阴影不取条目；k-2 cookie 段乘锥角、别名取错灯。
- 「HEAD」与「HEAD + 本步」两份快照（同一个翻译器 wasm）跑语料。
- 真机：预览 `3839619935`，回归里写成待用户看。

## 待定

- ~~别名在多盏 cookie 灯时取哪张~~：R2 读清，是排序后最后一盏可见、分到聚光槽的 cookie 聚光的图，确定、不用照报（`p13k-surf-two` 实测）。
- ~~`cookie` 字段指向不存在的文件~~：R1 读清，WPE 绑 6×6 棋盘格；我们报 `texture:missing:*` 并同样绑棋盘格。
- ~~运行中建的 cookie 聚光（脚本 `createLayer`，片段路径）~~：k-2 在片段路径里同整场加载 cookie（纹理随片段的纹理增量带出，会话里的纹理下标通用、不用改键），别名按帧解析时就认得它。

## 实施记录

### P13k-1 体积光（2026-11-20）

- 按点 1–4 实现，和计划的出入：
  - `cookie` 字段只在加载时读、`{user}` 不认（R1），运行中改不了，**不加** `light:runtime:cookie`；能力表的灯字段表加 `cookie`（否则写了 `cookie` 的灯报 `object:cookie`，`p13k-vol-explicit` 发现）。
  - cookie 在 `bundle.ts` 体积光那一段之前按 `lightCookieName` 加载（`getTexture` 要等纹理表建好），只给聚光；缺文件绑棋盘格（`checkerIndex`）并报 `texture:missing:*`。
  - 渲染器的 cookie 纹理不经图层的 pass：`uploadableTextures` 把 `lightObjects` 的 cookie 算进去，`GpuScene.cookieTextureOf` 取视图与纹理自己的采样器（没上传就当场传）。
  - 点光开 cookie 改报 `volumetrics:cookie:point`（R6 补正：WPE 不分类型）；`volumetrics:cookie`、`volumetrics:spot-shadow` 删掉。
- 确定性工程（`ignore/p13/k/gen_k.py`，WPE 阴影 low、体积光 low、后处理 ultra，设置没改）与 WPE 整帧比，排除 FR / CLK 角之后：`p13k-vol-shadow`、`-both`、`-explicit`、`-bad`、`-inside` **逐像素相同**，`p13k-vol` 64 个像素差 1（没带 meta 比，含 FR 块）。日志只刷到第 200 帧的几个按第 200 帧回放（画面不随时间变，FR 块另算）。
- 变异：聚光不取阴影条目 → `p13k-vol-shadow` 80 万个像素不同（最大 7）；不加 `COOKIE` → `p13k-vol` 107 万个不同（最大 18）；还原后画面哈希回到原值。
- 走查（`ignore/p13/k/walk/make_iso_3839.py`：背景 17、猫 153、puppet 23、聚光 321，去掉随机粒子、时钟、媒体组、视频层）：WPE 2278×1280 抓 3 帧，按日志与光标回放第 283 帧，最大差 5、没有成块差异，差异是背景纹理解码的 8×8 块纹路（已知差异，人物与光柱处同样）；用 dev 覆盖临时关体积光再比，差到最大 67、121 万个像素，说明光柱在画面里有分量、且画对了（覆盖用完已删）。
- 单测 `compile/p13k.test.ts`（`lightCookieName`、立方体、cookie 的在内判定含 0.1 / 0.2 的区分、组合键与槽、点光照报、`uploadableTextures`、真翻译器编 `p13k-vol` / `-both` / `-explicit` / `-bad`）；`p13e.test.ts` 的旧照报用例改成新规则。「HEAD + P13k-1」快照里 tsc 0 error、相关 7 个文件 100 例全过。
- 语料（`ignore/p13/k/corpus-{head1,mine1}.json`，233 张）：两份都全部干净、没有变化；`3839619935`（myprojects，单独扫）去掉 `volumetrics:cookie` 与 `volumetrics:spot-shadow`，剩 `lightconfig:spotshadowcookie` 等 k-2。

### P13k-2 表面着色（2026-11-21）

- 按点 6–8 实现，和计划的出入：
  - **翻译器**（点 6）：两段 cookie 照 R4，投影个数与级联基址按宏原值（`SSC + SC + SS`）、生成块时按 `LIGHTS_SPOT` 截，同阴影段原来的规则；变量名 `cookieColor`（另写的）。`lib.rs` 的照报用例改成「两段能翻译、cookie 槽是缺省 `_alias_lightCookie` 的 2d 槽」。WPE 自带的 7 个光照着色器都在 `LIGHTS_COOKIE` 下定义了 `COOKIE_SAMPLER`。
  - **别名**（点 7）：`LightFrame.cookie` 记排序后最后一盏可见、分到聚光槽的 cookie 聚光（不看投影余量，R2）；渲染器 `GpuScene.lightCookie` 在它非空时换成那盏灯的 cookie，空时保持；绑它的 draw 是动态 bind group，缓存键并进别名当前的纹理。WPE 一开始绑 `error` 棋盘格，那时 cookie 段的灯颜色都是 0、读到什么都一样，我们给空纹理（不为它往纹理表里加棋盘格）。采样器固定钳边 + 三线性、无各向异性。
  - **投影**（点 7）：`LightFrame.cookieProjections` 记只开 cookie、占了投影槽的灯，`render/shadowMath.ts` 的 `writeCookieProjections` 每帧写不偏的 `spotViewProjection`（不经 `planShadows`：档位 0 时没有图集也要写）。
  - **照报**：`lightConfigIssues` 与 `SPOT_COOKIE_KEYS` 删掉，`bundle.ts` 不再调；能力表 `lightconfig` 的注释同步。
  - **片段**：运行中建的 cookie 聚光同整场加载 cookie（见「待定」第 3 条）。
- 生成工程与 WPE 整帧比（排除 FR / CLK 角）：`p13k-surf` 1 个像素差 1，`-surf-shadow` low 1 个、disabled（`capture_sweep` 临时改档、跑完改回 low，`spotshadowcookie` 并进 cookie 段）1 个，`-surf-two` 3 个（两盏都采 `flashlight3`）。
- 变异：cookie 段乘锥角 → `p13k-surf` 37 万个像素不同（最大 30）；别名取排在前面的灯 → `p13k-surf-two` 79 万个不同（最大 156）；还原后宿主产物哈希回到变异前。
- `3839619935` 的复制工程按最终代码重渲染，和 k-1 的图逐字节相同（对 WPE 最大差 5）。
- 单测：翻译器 124 例（新增 `spot_segments_follow_wpe_order`、`spot_cookies_shift_the_cascade_base`、`spot_segments_are_cut_at_the_array_length`、`lighting_spot_cookies_translate`）；`compile/p13k.test.ts` 加 `lightFrame` 的别名与 cookie 投影槽（R2、R7、档位 0）、`writeCookieProjections`、真翻译器编 `p13k-surf*`（键清零、`LIGHTS_COOKIE`、槽 7 绑别名、渲染图输入 `light-cookie`）、片段路径加载 cookie；`lights.test.ts` 的旧照报用例改成不报。
- 「HEAD + P13k」快照（`ignore/p13/k/mine2`，HEAD `a47b9aea`）里 tsc 0 error、相关 13 个文件 228 例全过；语料默认 233 张前后一致、全部干净，`3839619935` 变干净。
