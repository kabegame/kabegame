# P13i — 聚光阴影

总计划：[phase-13ij-spot-prelighting.md](phase-13ij-spot-prelighting.md)。读码：[rea-p13-shadows.md](rea-p13-shadows.md) R1（生成器段顺序与下标）、R2（槽位与写入）、R4（打包），[rea-p13-volumetrics.md](rea-p13-volumetrics.md) V1.2（聚光投影）；本节补读的汇编在 `ignore/p13/i/rea/asm/`（`proj_14025d420.asm`、`spot_write.asm`）。

## 总体设计思路

聚光阴影接在 P13d 的阴影管线上，不加新的 pass 种类。每条聚光阴影是图集里的一块（边长同点光、平行光，按阴影档 256 / 512 / 1024），视图投影就是 P13e 已经逐位对过的聚光 VP（`spotViewProjection`：灯的世界矩阵做视图、外锥 ×2 当竖直 fov、宽高比 1、近平面正交 1 / 透视 0.05、远平面取半径），阴影 pass 里同平行光把 `VP[3][2]` 减 0.0005。着色器一侧，WPE 生成器的「聚光 · 阴影」段先按锥角衰减，再 `CalculateProjectedCoords`（不判越界）加 `PerformShadowMapping`，所以翻译器只多展开一段。

槽位规则照 WPE：聚光按 `castshadow / usecookie` 两位（阴影档为 0 时掩掉 `castshadow`）选段写 `LSpot_*`，四段依次是「阴影 + cookie」「cookie」「阴影」「普通」；带阴影（或 cookie）且 N 还有余量时生成投影，投影下标是本段的段指针，N 余量与平行光共用（灯按类型排序，聚光先用）。打包时聚光条目不是点光，与平行光的级联同边长，按生成顺序排在级联之前。平行光级联的下标基址跟着变成 `SSC + SC + SS`。cookie 两段仍照报（决定 2），报的键改名 `lightconfig:spotcookie` / `spotshadowcookie` 与 `LightingV1/spot-cookie`。

关键决策：
- 聚光投影复用 `compile/volumetrics.ts` 的 `spotViewProjection`，不另写一份；`SceneLight` 加原始的 `outercone`（度），投影要它，`outer` 仍是余弦。
- `ShadowEntry` 用 `kind: "point" | "cascade" | "spot"` 区分三种条目，代替「`cascade` 为 null 就是点光」。

## 步骤 0：读码（2026-11-18）

- **投影**（`FUN_14025d420` 类型 1，`0x14025d451`–`0x14025d9c0`）：与 V1.2 相同（快速倒数平方根归一化三轴、`PerspectiveFovRH((outer + outer)·0.017453292, 1, near, far)`，near 看 `ctx+0x118 & 0x400`），结果存灯的 `+0x338`。P13e 的 `spotViewProjection` 已按它实现并与抓帧逐位相同。
- **写入**（`0x140192dbf`–`0x140193178`）：段下标 `= light+0x2c4 & (阴影档 ≠ 0 ? 3 : 2)`，取 `[rbp + 8·下标 + 0x5f0]` 的段指针写 `Color(rgb·intensity, radius)`、`Origin(位置, cos inner)`、`Direction(+X, cos outer)`、`Exponent`；之后 `castshadow`（档 ≠ 0）或 `usecookie`（`FUN_140185940` = bit1）为真、且 N 余量 `[rbp+0xd98]` 非 0 时余量 −1、算投影，按同一段下标写 `ShadowProjection`（`[rbp+8·下标+0x530]`）、记下 `…Transform` 的位置（打包后写）；只有带阴影的才进阴影条目表（`0x140193173`）。元素顺序按 `ctx+0x118 & 1` 选，和平行光（`0x14019289d`）同一套。
- **边长**：`FUN_14025d3e0` 三种灯共用，档 1/2 → 256、3 → 512、4 → 1024。
- **偏移**：阴影 pass 的 VP 同平行光 `[3][2] − 0.0005`，uniform 不偏（rea-p13-shadows「补充」表）。
- **着色器**（`common_pbr_2.h`）：`CalculateProjectedCoords` = 透视除法、`xy·(0.5, −0.5) + 0.5`、`w ≤ 0` 时 `y = 2`，没有越界判定（平行光的 `…Cascades` 有）。

## 步骤 0：确定性工程（抓帧）

`ignore/p13/i/gen_i.py` → `ignore/p13/proj/p13i-*`；抓帧 `A:\p13i\`（`capture_sweep`，阴影 low 与 high，跑完改回 low），导出 `ignore/p13/i/wpe/`。

| # | 工程 | 看什么 |
|---|---|---|
| I1 | `p13i-spot`（朝下）、`p13i-tilt`（斜照、一个立方体半在锥外） | 投影、朝向与 up、锥外与灯后的采样 |
| I2 | 同上的阴影 pass | `VP[3][2] − 0.0005` |
| I3 | `spot-low` / `spot-high` | 单次采样与 9 次采样、块边长 |
| I4 | `p13i-mix`：带阴影点光、普通聚光（objects 在前）、带阴影聚光、带阴影平行光 | 选段与排序、打包顺序、级联基址 1 |
| I5 | `p13i-ortho` | 正交场景近平面 1 |

另抓 `3455121165` 阴影 low / 关各一帧（给用户看）：两次抓帧隔了几帧，行星与频谱都在动，差异图看不出影子；影子的样子看 `p13i-tilt`。

## 实施

### 点 1 — 翻译器展开「聚光 · 阴影」（`src-tauri/wpesl2wgsl/src/library.rs`）
- **修改** `Counts` 加 `spot_shadow`、`spot_cookie`、`spot_shadow_cookie`；cookie 两项非 0 时报 `LightingV1/spot-cookie`（原 `spot-shadow`）。
- **修改** `ShadowProjection[N]` 的 `N = SC + 3·DS + SS + SSC`；聚光先展开 SS 个阴影块（下标从 `SSC + SC` 起、投影同下标），普通聚光从 `SSC + SC + SS` 起；平行光级联基址 `SSC + SC + SS`。
```glsl
{
	vec3 toLight = g_LSpot_Origin[i].xyz - pos;
	float cone = smoothstep(g_LSpot_Direction[i].w, g_LSpot_Origin[i].w, dot(normalize(-toLight), g_LSpot_Direction[i].xyz));
	vec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[i]);
	float shadowFactor = PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[i]);
	sum += ComputePBRLightShadow(n, toLight, v, albedo, g_LSpot_Color[i].rgb * cone, g_LSpot_Color[i].w, g_LSpot_Exponent[i].x, tint, f0, rough, metal, shadowFactor);
}
```

### 点 2 — 宿主写聚光的槽与条目（`compile/lights.ts`）
- **修改** `lightConfigIssues` 只报 `spotcookie` / `spotshadowcookie`。
- **修改** `lightFrame` 的聚光分支：按段选指针；带阴影 / cookie 且 N 有余量时生成投影槽，带阴影的进条目（`kind: "spot"`）。
- **新增** `SceneLight.outercone`；`ShadowEntry.kind`。

### 点 3 — 打包与视图（`render/shadowMath.ts` 的 `planShadows`）
- **新增** 聚光分支：`vp = spotViewProjection(matrix, outercone, radius, orthographic)` 写 `ShadowProjection[slot]`、方块变换写 `…Transform[slot]`，视图整块、`[14] − 0.0005`。

### 点 4 — 单测与语料
- 翻译器：段顺序、下标、cookie 照报；宿主：选段、条目、打包顺序、`planShadows` 的聚光视图。
- 语料只去掉 `lightconfig:spotshadow` 与 `shader:generic4:require:LightingV1/spot-shadow`，能渲染 199 → 200（`3455121165`）。

## 实施记录（2026-11-18）

- 按四点实现，另有三处跟着改：
  - 锥角余弦照 WPE 的单精度（`compile/lights.ts` 的 `coneCos`）：抓帧的 `LSpot_Origin.w` 和双精度直接算差 1 ulp；
  - 「场景有阴影」的条件（`bundle.ts` 的 `castsShadows`、`ShadowAtlas.create`）改成 `shadowCount(counts)`，算上聚光阴影：只有聚光阴影的场景原来不建图集，渲染报 `render:texture-rt:shadow-atlas`；
  - dev 探针的 `shadows` 元数据加 `spotShadow`。
- 单测：`render/p13i-spot.test.ts` 用六组抓帧的常量（`spotShadow.fixture.json`）逐位核对 `lightFrame` + `planShadows`：`LSpot_*`、`ShadowProjection` / `…Transform`、点光投影、阴影视图的集合（WPE 每个投射者一次 draw、压紧视图，按集合比）、图集尺寸。翻译器加段顺序、级联基址、cookie 照报三个用例。
- 翻译器 wasm：工作区里另一个会话正在改 `rewrite.rs` / `lib.rs`，语料用的 wasm 在草稿目录里按「HEAD + 我的 `library.rs` 与 `lib.rs` 块」单独编（独立工作树缺 `third/` 子模块，cargo 解析不了工作区，改用只含这个 crate 的最小工作区）。
- 语料与 WPE 对照、走查见 `p13-REPORT.md`「P13i 的实测」：语料干净 205 → 206（`3455121165`），只去掉两个键；确定性工程整帧同 P13d 的水平；走查每帧 1 个像素差 1。
