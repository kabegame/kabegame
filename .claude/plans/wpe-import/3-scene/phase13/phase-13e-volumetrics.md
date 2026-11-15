# P13e — 体积光（子计划）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13e」。读码：[rea-p13-passes.md](rea-p13-passes.md) 第 3 节（何时画、一盏灯的绘制、COMBO、uniform、合成）与第 5 节（一帧的顺序）；补充读码 [rea-p13-volumetrics.md](rea-p13-volumetrics.md)（步骤 0，V1–V11）。实测：[p13-REPORT.md](p13-REPORT.md) 第 11–13 行（档位的缩放与模糊次数、常量、合成时机）。

## 总体设计思路

WPE 的体积光是**灯对象自己的绘制**，插在主 pass 的对象序列里：画到 `objects` 里一盏 `castvolumetrics` 的灯时，先把当前场景深度拷进 `_rt_volumetricsBack`（全分辨率），在 1/d 分辨率的 `_rt_volumetricsSingle` 里画灯体的背面深度（光线步进的远端），再用 `volumetricsfront` 画灯体正面：每个像素从正面沿视线走到「背面与场景深度较近的那个」，按衰减（`radius·0.99`、`volumetricsexponent`）、聚光锥、阴影（带阴影时比较采样图集）累加，乘 `density · intensity · color · 0.1` 加进 `_rt_volumetricsLightBuffer`。连续的几盏灯共用一次清屏（清成 (0, 0, 0, 1)），到下一个不是灯的对象之前（或列表末尾）合成：低 / 中档先横竖各模糊一次（`blur_k3`），再用 `passthrough` 加法画回当前目标。d 是 8（low、medium）或 4（high、ultra），步数按档位（2 / 3 / 5 / 8，带阴影或 cookie 时 12 / 24 / 32 / 64），`volumetrics: disabled` 整段跳过。

我们照这个形状在渲染图里加一种 op：
- **编译期**（`compile/volumetrics.ts`，新文件）：从对象表找出会画体积光的灯（`castvolumetrics`、可见、类型能画），按 `objects` 顺序把「连续一段灯」分组，每组记录插入位置（它后面第一个非灯对象之前）与各灯的常量；灯体网格（点光 577 顶点的球、聚光 130 顶点的单位圆柱）按 WPE 的生成规则建；编 `volumetrics_back` / `volumetricsfront`（`POINTLIGHT`、`SHADOW`、`QUALITY`、`LIGHTS_SHADOW_MAPPING_QUALITY`、全屏变体）/ `blur_k3` / `passthrough` 四个 WPE 自带材质；能力表去掉 `object:castvolumetrics`，`density`、`volumetricsexponent` 从中性键改成真正读取。
- **渲染**（`render/volumetrics.ts`，新文件）：建四张 RT（Back 全分辨率、Single 与两张 LightBuffer 1/d），每组 op 执行「每盏灯：拷场景深度 → 清 Single、画背面 → （组内第一盏）清 LightBuffer → 画正面」与「合成：（低档）两次模糊 → 加法上屏」。场景目标是 `depth32float`，WebGPU 的深度纹理不能线性过滤，而 WPE 读 Back 用的是线性过滤（实测采样器 Linear + Wrap）；所以每次拷贝改成一个小 pass 把深度写进 `r32float`，读它的着色器用硬件线性过滤（设备已按需开 `float32-filterable`，没有时退回报 `render:volumetrics`），Single 同样画完转成 `r32float` 供 `texLoad2D`。
- **翻译器**：`sampler2DBackBuffer` 当成 `sampler2D`（WPE 不开 MSAA 时 `texSample2DBackBuffer(s, u, r)` 就是 `texSample2D(s, u)`，exe 里的两种宏定义都读到了；我们没有 MSAA）。这是本机 WPE 着色器 165/167 里剩下的 `volumetricsfront`。
- **档位**：「场景体积光」作为 WPE 设置字段组（`utils/wpeSettings.ts` / `WpeSettingsFields.vue`）的第 8 个字段 `volumetrics`，和后处理 / 反射 / 阴影同路：桌面读全局键 `wpeSceneVolumetrics`（缺省跟随 WPE 的 `volumetrics`），预览读这张壁纸的预览设置（缺省 `medium`，= WPE 缺键值），由父页面经 `kabegame:wpe-scene-settings` 下发给宿主。改了整场重新加载（COMBO 与 RT 尺寸都变）。

关键决策：
- **灯的值仍取编译期常量**（同 P13d）：灯挂父对象、关键帧、脚本照报，等 P13f 把灯改成运行时状态；体积光每帧要的只有相机相关的量（`g_ViewProjectionMatrix`、它的逆 `g_EffectModelMatrix`、相机是否在灯体内），每帧在渲染器里算。
- **矩阵按 WPE 逐步 float32 算**：`g_EffectModelMatrix` 是 VP 的逆（抓帧里 1080.0001220703125 这种舍入），照 V3 的求逆函数与顺序复现；聚光的灯体矩阵照 V2。
- **WPE 的怪行为照抄或照报**：管光、平行光开 `castvolumetrics` 也会建组、清屏、合成，但灯体矩阵是 NaN、什么都画不出（`p13e-kinds` 实测），我们照样建组（清屏色副作用照 V7）、不画灯体；灯开了 `castshadow` 却没分到阴影条目时 WPE 读的是未初始化的阴影变换（`p13e-pns` 实测的垃圾值）、图集槽绑 6×6 缺省纹理，结果不可复现，照报（待定 3）。

## 现状锚点

**a. `castvolumetrics` 按未知键照报**（`compile/features.ts`，灯的键表里没有它）
```ts
const LIGHT_KEYS = new Set([
  "light", "intensity", "radius", "exponent", "innercone", "outercone", "controlpoint",
  "density",              // 现状：中性键，不读
  "volumetricsexponent",  // 现状：中性键，不读
  "cascadedistance0", "cascadedistance1", "cascadedistance2", "lightsourcesize", "castshadow", "usecookie",
]);
// 现状：castvolumetrics 不在表里，checkObjectFeatures 报 object:castvolumetrics（lights.test.ts:194）
```

**b. 翻译器不认 `sampler2DBackBuffer`**（`src-tauri/wpesl2wgsl/src/rewrite.rs:94`）
```rust
fn parse(ty: &str) -> Option<Self> {
    match ty {
        "sampler2D" => Some(Self::D2),
        "sampler2DComparison" | "sampler2DShadow" => Some(Self::D2Comparison),
        "sampler3D" => Some(Self::D3),
        "samplerCube" => Some(Self::Cube),
        _ => None, // 现状：sampler2DBackBuffer 落到这里，报「不支持的采样器类型」
    }
}
// texSample2DBackBuffer 的调用改写已经有（rewrite.rs:1643，等同 texSample2D）
```

**c. 渲染图没有灯的位置**（`render/graph.ts`）：op 只有 `draw` / `particles` / `text` / `mesh` / `snapshot` / `copy` / `swap` / `clear` / `subtree` 等，灯对象在编译期就被跳过，不占渲染图的位置。

**d. 显式管线布局里非比较纹理一律 `float`**（`render/programs.ts:207`）
```ts
sampleType: comparison ? "depth" : "float", // 现状：r32float 要 float32-filterable 才能当 float 绑
```

## 步骤 0 — 读码补全与确定性工程（Claude，实现之前）

**读码**（代理，产出 [rea-p13-volumetrics.md](rea-p13-volumetrics.md)）：V1 灯体网格的生成（点光球、聚光、管光 / 平行光）；V2 各类灯的 `g_AltViewProjectionMatrix` / `g_AltModelMatrix` / `g_RenderVar0` / `g_RenderVar3`；V3 `g_EffectModelMatrix` 的求逆；V4 全屏变体的切换条件；V5 体积光开关与「可画」条件；V6 `SHADOW` 开但没分到阴影条目；V7 清屏色副作用影响的清屏；V8 合成的目标与嵌套（组、反射 pass）；V9 HDR；V10 雾；V11 运行中改灯的状态残留。

**确定性工程**（`ignore/p13/e/gen_e0.py` → `ignore/p13/proj/p13e-*`，抓帧 `A:\p13e\<档位>\`，常量 `ignore/p13/out/wpe-p13e-*-consts.json`，打印 `ignore/p13/e/show_consts.py`）：

| # | 问题 | 工程 | 预测 |
|---|---|---|---|
| D1 | 基本形状：LightBuffer、各 pass、整帧，五档 | `p13e-po`（正交）、`p13e-pp`（透视，球被立方体与地面挡住一部分） | low / medium 1/8 + 两次模糊，high / ultra 1/4；步数 2 / 3 / 5 / 8 |
| D2 | 灯的缩放、旋转进不进灯体 | `p13e-scale`：点光 scale (2, 0.5, 1)、angles 非 0 | 待测 |
| D3 | 带阴影 | `p13e-ps`：castshadow + pointshadow 1，立方体投射 | `SHADOW = 1`，步数 12 / 24 / 32 / 64，`hash12` 抖动 |
| D4 | castshadow 但没分到阴影条目 | `p13e-pns` | 待测 |
| D5 | 合成时机 | `p13e-seq`：灯 A、B 相邻，立方体，灯 C，立方体 | 两次清屏、两次合成，各落在立方体之前 |
| D6 | 相机在灯体内 | `p13e-in` | 正面换全屏变体 |
| D7 | 聚光 | `p13e-spot`：innercone 15、outercone 25 | 灯体与锥参数待测 |
| D8 | 清屏色副作用 | 待 V7 / V8 定工程 | — |
| D9 | HDR | `p13e-hdr` | LightBuffer RGBA16F |
| D10 | 谁画 | `p13e-kinds`：ltube、ldirectional、隐藏的 lpoint、可见的 lpoint | 待测 |

### 步骤 0 的结果（2026-11-15，low 档）

**实测**（10 个工程各抓 2 帧，当前设置不变、没有重启 WPE）：

| # | 结果 |
|---|---|
| D1 | 成立（low）：每盏灯 `CopyResource`（场景深度 → Back 1920×1080 R32）→ 清 Single 深度（240×135）→ 背面（GREATER、写深度、剔正面）→ （组内第一盏）清 LightBuffer → 正面（SrcAlpha / One、只写 RGB、剔背面、不测深度）；合成 `blur_h`、`blur_v`、`passthrough`（SrcAlpha / One、只写 RGB）三个全屏三角形。正面读 Back 的采样器是 **Linear + Wrap**，Single 用 `texLoad2D`。点光灯体是单位球：两极 + 23 圈纬线（82.5° 到 −82.5°，步长 7.5°）× 每圈 25 个顶点（经度 0°–360°，步长 15°，接缝重复），577 顶点、1104 个三角形；`g_AltViewProjectionMatrix` = 缩放 r（**不乘系数**）+ 平移到灯心，`g_RenderVar1.x` = r × 0.99；`g_EffectModelMatrix` 是 VP 的逆 |
| D2 | 灯的 scale、angles 都不进点光灯体：`g_AltViewProjectionMatrix` = diag(400, 400, 400) + 平移，`radius·0.99` = 396 |
| D3 | 有阴影 pass、正面带 `SHADOW` 变体（常量待比） |
| D4 | `SHADOW` 照开；`g_RenderVar0` / `g_RenderVar3` 是未初始化的垃圾值（如 (2.0e−19, 8.2e23, 2.0e31, 7.0e22)），`g_Texture0` 绑 6×6 R32_FLOAT 缺省纹理，结果不可复现 |
| D5 | 成立：A、B 共用一次清屏，合成在 CUBEA 之前；C 自己清屏，合成在 CUBEB 之前；每盏灯各拷一次场景深度 |
| D6 | 背面照画，正面不读 `g_AltViewProjectionMatrix`（全屏变体） |
| D7 | 聚光会画：灯体是 32 段的单位圆柱（xy 单位圆、z ∈ {0, 1}，130 顶点、128 个三角形），`g_AltViewProjectionMatrix` 带透视（w = 19.875·z + 0.125），把圆柱投成圆锥；`g_RenderVar1` = (r × 0.99, cos 15°, cos 25°, intensity)，`g_RenderVar3` = 聚光方向 |
| D9 | 待比 |
| D10 | 隐藏的点光不画；ltube、ldirectional **也建组、清屏、合成**，正面与背面照画，但 `g_AltViewProjectionMatrix` 全是 NaN、画不出东西（平行光的 `g_RenderVar1.x` = 9.9 = 缺省半径 10 × 0.99） |

**读码**（[rea-p13-volumetrics.md](rea-p13-volumetrics.md)，切 `ignore/p4/rea/wp.asm`，脚本 `ignore/p13/rea/volumetrics/`）：
- V1：点光球写死 24 × 24（`a = f32(i)·0.130899698f`、`b = f32(j)·0.261799395f`，逐个乘、`sinf` / `cosf` 是 double 求值后舍入）；聚光不开 cookie 时是 NDC 里的 32 段圆柱（盖心在 (0.5, 0.5)），开 cookie 时是 NDC 立方体，都用 `inverse(聚光 VP)` 变回世界；管光、平行光不排除，但聚光 VP 那个字段从不为它们计算（残留值）。
- V2：点光 `g_AltViewProjectionMatrix` = diag(r) + 世界位置（r 是原始 `radius`，不乘世界缩放）；非点光 = `inverse(聚光 VP)`（看向局部 +X，fov = 2·outercone，近平面透视 0.05、正交 1，**不读** `lightsourcesize`），`g_AltModelMatrix` = 聚光 VP；非点光 `g_RenderVar3` = 世界矩阵第 0 行原值（不归一化）。聚光 VP 只在 `lightconfig` 有聚光槽时算。
- V3：`g_EffectModelMatrix` = GLM `compute_inverse`（float32 标量）作用于本次绘制的 VP（正交带视差时含该灯根对象的视差偏移）。
- V4：全屏判定 —— 点光 `p = eye + 0.2·g_ViewForward`、`r² > |p − 灯心|²`；聚光沿轴投影 `0 < t ≤ radius` 且 `t / radius · R_far ≥` 离轴距离；cookie 是 `eye + 0.1·F` 在视锥六面内。正交照判；只换正面。
- V5：灯「可画」= 自己与父链可见 ∧ `castvolumetrics`，不看 `lightconfig`；不可见的非灯对象不打断一段灯。
- V6：没分到阴影条目时 `g_RenderVar0/3` 是上一次的值或未初始化（同 D4）。
- V7：清屏色改成 (0, 0, 0, 1) 的副作用本帧没有可见影响（之后的清屏都显式设色）。
- V8：灯在组里时由组的子树画，深度从组的合成 RT（没有深度）拷，合成却落在主列表组之后、画进主目标。
- V9：没有 HDR 系数；LDR 时 LightBuffer 是 RGBA8，一段灯的累加合成前就钳到 1；`LIGHTS_SHADOW_MAPPING_QUALITY` 只给点光；另有 `COOKIE`。
- V10：雾的规则同普通材质（P13f 的事）；着色器里 `shadowSample *= ApplyFogAlpha(shadowSample, …)` 等于平方，照抄。
- V11：网格与材质只在类型、`castshadow`、`usecookie` 变化时重建，其余字段每帧取。

**抽查**（我独立复算，`ignore/p13/e/chk_mesh_inv.py`，不用代理的脚本）：点光球 577 点、聚光圆柱 130 点与抓帧逐位相同；`g_EffectModelMatrix` 用 GLM 公式 float32 复算，`p13e-spot`（透视）、`p13e-po`（正交）、`3287715210` 三张抓帧逐位相同（含正负零）。

**语料**：开体积光的灯全是点光；`castshadow` 的体积光灯（`3287715210` 1 盏、`3465215190` 2 盏）都分到了阴影条目，没有 D4 / V6 的情况；`3453730450` 的三盏挂父对象（`object:parent` 照报，P13f）。

## 点 1 — 设置「场景体积光」（Rust、前端、i18n）

接进预览设置字段组（前置：那份改动进 HEAD，见待定 1），处处照 `shadows` 那一项抄，取值 `follow` / `disabled` / `low` / `medium` / `high` / `ultra`：

- **新增**
  - 全局键 `wpeSceneVolumetrics`（`kabegame-core/src/settings/mod.rs`：枚举、默认 `follow`、校验 `is_wpe_scene_volumetrics`、getter / setter、测试；`commands/settings.rs` 两个命令、`lib.rs` 注册；`stores/settings.ts` 类型、`settingsDescriptors.ts` 一行）。getter 不进 `wpe-scene-host.toml`：宿主不再自己读，值由父页面下发。
  - 预览设置 `volumetrics`（`wpe/preview_settings.rs`：键、默认 `medium`、`normalize` 用 `is_wpe_scene_volumetrics`、测试）。
  - 字段组（`utils/wpeSettings.ts`）：`WpeSettingKey`、`WPE_SETTING_KEYS`（排在 `shadows` 后）、默认 `medium`、全局键、词条、`WPE_SETTING_CHOICES`、`wpeSettingFieldsFor` 的场景字段、`wpePreviewSettingValues`、`WpeSceneSettings` / `WPE_FOLLOW_SCENE_SETTINGS` / `wpeSceneSettingsOf`；附 vitest。
  - 五种语言词条 `settings.wpeSceneVolumetrics*`。
- **修改**
  - `WallpaperWindow.vue` 的 `SCENE_SETTING_KEYS` / `SCENE_SETTING_GETTERS` 加一项；`WpeSceneView.vue` 推送与比较的键加一项；`scripts/kabegame-dev/scene.ts` 屏外宿主补读并下发。

## 点 2 — 翻译器（`src-tauri/wpesl2wgsl/src/rewrite.rs`）

- **修改**
  - `TextureKind::parse` 认 `sampler2DBackBuffer` 为 `D2`。
    > 说明：WPE 不开 MSAA 时 `texSample2DBackBuffer` 就是 `texSample2D`；调用改写已有。
```rust
"sampler2D" | "sampler2DBackBuffer" => Some(Self::D2), // 修改
```
  - 语料 `installed` 的预期 165 → 166；README 同步。

## 点 3 — 编译期（新文件 `compile/volumetrics.ts`，`compile/postprocess.ts`、`compile/bundle.ts`、`compile/features.ts` 接线）

- **新增**
  - `resolveVolumetrics` / `readWpeVolumetrics`：同 `resolveShadows`，缺键按 WPE 缺省（V9 定）。
  - `compileVolumetrics(objects, …)`：找出会画的灯（V5），按 `objects` 顺序分组（组 = 连续的体积光灯，插在下一个非灯对象之前，末尾一组插在列表末尾）；每盏灯的常量（`g_RenderVar1/2/4`、点光 / 聚光的灯体矩阵、聚光方向）与材质变体（`POINTLIGHT`、`SHADOW`、`QUALITY`、`LIGHTS_SHADOW_MAPPING_QUALITY`、`FULLSCREEN` 两种都编）；灯体网格（V1）。
  - bundle 字段 `volumetrics: { tier, scale, groups, meshes, programs }`。
- **修改**
  - `features.ts`：`castvolumetrics` 进灯的键表；灯开了 `castvolumetrics` + `castshadow` 但没分到阴影条目时报 `volumetrics:shadow-unassigned`（待定 3）；聚光的阴影 / cookie 仍报 `lightconfig:spot*`。
  - `bundle.ts`：组的插入位置交给渲染图。
- **删除**
  - 能力表里 `object:castvolumetrics` 的来源（`lights.test.ts` 那条改成不报）。

## 点 4 — 渲染（新文件 `render/volumetrics.ts`，`render/graph.ts`、`render/scene.ts`、`render/programs.ts` 接线）

- **新增**
  - `VolumetricsTargets`：Back（画布尺寸 `r32float`，供线性采样）、Single（1/d `depth32float` 画背面 + 1/d `r32float` 供 `texLoad2D`）、LightBuffer / LightBufferB（1/d，HDR 时 `rgba16float`，否则 `rgba8unorm`）。
  - 渲染图 op `{ kind: "volumetrics-light", group, light }` 与 `{ kind: "volumetrics-composite", group }`。
  - 每帧：`g_EffectModelMatrix`（V3）、相机是否在灯体内（V4）。
- **修改**
  - `programs.ts`：`r32float` 纹理的绑定按 `float32-filterable` 走 `float`；设备没有这个特性时编译报 `render:volumetrics`。

## 点 5 — 宿主（`host.ts`）

`SceneSettings` 加 `volumetrics`，`setSceneSettings` 收它、和最近一次加载用的值比，变了整场重载（`recompiled.reason` 仍是 `settings`）；跟随时读 `config.json` 的 `volumetrics`，档位表同阴影（`FUN_14010dad0`，不认识的值与缺键按 medium，p2-REPORT G1），解析函数放 `compile/postprocess.ts` 与 `resolveShadows` 并列。dev 覆盖 `localStorage["kabegame-dev-scene-volumetrics"]`，探针结果带 `volumetrics`。

## 点 6 — 测试

`compile/p13e.test.ts`（分组、变体、能力表、网格逐位或 ULP 内对抓帧）、`render/p13e-volumetrics.test.ts`（`g_EffectModelMatrix` 对抓帧、聚光灯体矩阵对抓帧）、`lights.test.ts` 改一条、`host.test.ts` 加设置。

## 验收

- 确定性工程五档（`capture_sweep` 扫 `volumetrics`，扫完自动改回）和 WPE 比 LightBuffer 与整帧。
- `3287715210`、`3837478759` 和 WPE 整帧比；语料能渲染 +2（`3837478759` 要 P6d1a 的 `getParent`，已合入）。
- 变异检查；文档（翻译器 README、`cocs/wpe/WPE_SCENE.md`、`cocs/README.md`、changelog、回归）。

## 风险

1. **深度拷贝多一个 pass**：WebGPU 不能把深度直接拷进颜色格式，每盏灯多一个全屏小 pass；只在有体积光的场景。
2. **线性过滤的精度**：WPE 在 R32 深度上做的硬件线性过滤和我们在 `r32float` 上的应一致，但 1/d 采样点正好落在全分辨率纹素边界（8i + 4），过滤权重 0.5 的舍入可能差一点，按误差包络比。
3. **灯是编译期常量**：灯字段绑属性整场重编译，挂父对象、关键帧照报，等 P13f。

## 待定（2026-11-15 全部已定：1 接进预览设置字段组；2、3 用户：「好」，按推荐）

1. **设置「场景体积光」**（已定，2026-11-15）：接进新的预览设置字段组（点 1），桌面全局键 + 预览逐壁纸两份，缺省分别是跟随 WPE 与 `medium`。**前置**：预览设置那份改动（`wpeSettings.ts`、`preview_settings.rs`、`WpeSettingsFields.vue` 等）现在还是别的会话的未提交改动，点 1 要等它进 HEAD；在它之前先做不碰这些文件的点 2–4、6。
2. **聚光体积光**（语料 0 张）：推荐现在就支持（不带阴影 / cookie；聚光阴影本来就照报），灯体与矩阵照 V1 / V2，`p13e-spot` 逐像素比。另一种是照报 `volumetrics:spot`。
3. **WPE 用残留 / 未初始化值的几种配置**（语料都是 0 张）：
   - `castshadow` 却没分到阴影条目（`p13e-pns` 实测垃圾值）；
   - 聚光体积光但 `lightconfig` 没有聚光槽（灯体矩阵是残留值）；
   - 灯在组（带子层的组合层）里（深度从没有深度的 RT 拷）。

   推荐这三种照报（`volumetrics:shadow-unassigned`、`volumetrics:spot-unassigned`、`volumetrics:group`）。管光、平行光开 `castvolumetrics` 例外：实测灯体矩阵是 NaN、什么都不画，推荐照样建组、清屏、合成，不画灯体（画面与 WPE 相同）。另一种是前三种按「不带阴影 / 不画 / 画进主目标」处理（画面合理，但和 WPE 不保证一致）。

## 实施步骤（2026-11-15，各步单独验收）

1. **翻译器**（点 2）：`sampler2DBackBuffer`；`cargo test -p wpesl2wgsl`、语料 166/167、重编 wasm。
2. **编译期**（点 3 + 点 5 的档位解析）：`compile/volumetrics.ts`（可画的灯、分组、常量、变体、灯体网格）、`postprocess.ts` 的 `resolveVolumetrics` / `readWpeVolumetrics`、编译选项多一个 `volumetrics`（缺省 `follow`，宿主接设置之前按 WPE `config.json`）、能力表；`compile/p13e.test.ts`。
3. **渲染**（点 4）：`render/volumetrics.ts`（RT、深度转 `r32float`、背面 / 正面 / 模糊 / 合成）、渲染图 op、每帧 `g_EffectModelMatrix` 与全屏判定；`render/p13e-volumetrics.test.ts`；确定性工程 low 档对 WPE。
4. **设置与宿主**（点 1、点 5）：等预览设置的改动进 HEAD 再做。
5. **验收**：五档对 WPE（`capture_sweep`）、两张语料场景、语料扫描、变异检查、文档。

## 实施记录（2026-11-15，未提交）

- **步骤 1 翻译器**：`TextureKind::parse` 认 `sampler2DBackBuffer`（单测 `back_buffer_sampler_is_plain_2d`），单测 109 个，语料 165 → 166/167，wasm 已重编；README 同步。
- **步骤 2 编译期**：`compile/volumetrics.ts`（谁画、灯体网格、GLM 求逆、聚光 VP、常量、三份 pass 与模糊 / 合成材质、照报规则）、`postprocess.ts` 的 `resolveVolumetrics` / `readWpeVolumetrics`、编译选项 `volumetrics`（`bundle` / `client` / `protocol` / `worker`）、`features.ts` 的 `castvolumetrics` 进灯的键表。实测改了一处读码结论：`SHADOW` 与 `LIGHTS_SHADOW_MAPPING_QUALITY` 取用户的阴影档、不看 `lightconfig` 有没有阴影计数（`p13e-pns` 上 WPE 照开），bundle 单独解析一次阴影档。管光、平行光不收（WPE 的合成是一片 0）；透视场景开透明排序时照报 `volumetrics:transparentsorting`（没测灯在两轮里的位置）。`compile/p13e.test.ts` 22 例。
- **步骤 3 渲染**：`render/volumetrics.ts`（`VolumetricsRenderer`：Back / Single 用一个小 pass 从深度转 `r32float`、背面管线没有片元阶段、正面 / 全屏 / 模糊 / 合成复用 `createPipeline`；`insideLightVolume`）；`render/scene.ts` 接线（`checkRenderable` 报 `render:volumetrics`、有体积光时总建深度附件并带 `TEXTURE_BINDING`、`frameLightValues` 缓存灯光帧给带阴影的点光取条目、主 pass 顶层循环按 `objects` 下标归并灯与图层，可见图层之前与列表末尾合成）；dev 覆盖 `dev/volumetricsOverride.ts`（宿主与探针都读，探针结果带 `volumetrics`）。`render/p13e-volumetrics.test.ts` 2 例。
- **对 WPE**：low 档 9 个确定性工程、四档扫描 21 次（`A:\p13e\sweep`，扫完自动改回 low，`config.json` 回到扫描前的 sha）每张最多 66 个像素、只差 1 级；`3837478759` 隔离工程五档逐像素相同；`3287715210`（HDR）隔离工程屏蔽随时间变化的眼睛后最大差 4 级，与不带灯的底图同量级。对照脚本 `ignore/p13/e/plan_cmp.py`、`cmp.py`、`plan_sweep.py`、`cmp_sweep.py`、`cmp_real.py`（DDS 按 sRGB 编码）。
- **语料**：185 → 187（`3287715210`、`3837478759`），没有掉出。变异 18 / 20（两处等价，见回归 VL1）。
- **还没做**：步骤 4（设置项接进预览设置字段组、宿主收父页面下发的 `volumetrics`），等那份改动进 HEAD；测试行（`ignore/p13/e/manifest-e.json`、`manifest-real.json`、`manifest-real2.json`、`manifest-full.json`）提交之后用 `projects_remove` 移除。

## 步骤 4 实施记录（2026-11-15，预览设置的改动 `49499ddb` 进 HEAD 之后）

上节「还没做」里的测试行已在 P13e 提交后移除。步骤 4 照「阴影」一项逐处抄：

- **Rust**：`settings/mod.rs` 新键 `WpeSceneVolumetrics`（默认 `follow`，`is_wpe_scene_volumetrics` 同阴影的档位，getter / setter、单测）；
  `commands/settings.rs` 两个命令、`lib.rs` 注册（不进宿主权限，值由父页面下发）；`wpe/preview_settings.rs` 键 `volumetrics`（默认 `medium`、单测）。
- **前端**：`stores/settings.ts` 类型、`settingsDescriptors.ts` 一行；`utils/wpeSettings.ts` 字段表（排在阴影后）、默认、全局键、词条、
  六档选项、场景字段、`WpeSceneSettings` 四项；设置页里体积光同阴影用下拉（`WpeSettingControl.vue`）；`WpeWallpaperSettings.vue`、
  `WallpaperWindow.vue`（全局键与 getter）、`WpeSceneView.vue`（比较键）、`wpeSceneStyle.ts`（消息字段）；`scripts/kabegame-dev/scene.ts`
  屏外宿主补读并下发；五种语言 `settings.wpeSceneVolumetrics*`（选项文案同各语言阴影）。
- **宿主**：`sceneStyle.ts` 收 `volumetrics`；`host.ts` 的 `SceneSettings` 四项、`setSceneSettings` 比较并整场重载（键 `volumetrics`）、
  缺了的项按跟随、dev 覆盖叠在父页面值上，编译输入改用下发值（去掉只看 dev 覆盖的临时写法）。
- **验证**：vue-tsc、宿主 tsc 0 error；前端 4 个文件 47 例、宿主 2 个文件 41 例全过（新增「只改体积光重载一次」等）；
  `kabegame-core` 名字含 `wpe` 的单测里设置 4 个、预览设置 5 个全过，同一过滤带出的 `wpe_import::tests::ingest` 与
  `local_folder::tests::wpe_*` 失败是既有的（单线程照样失败，用例在 Windows 上 `canonicalize` 出 `\?\` 路径查不到行），与本步无关；
  `deno task check -c kabegame` 的 cargo 一半被 dev 占着的 CEF dll 卡住（os error 32），主 app crate 没能检查。
  真机：屏外宿主 `p13e-po` 推 `disabled`、同值、`ultra`，`recompiled` 与画面哈希都符合（回归 VL4 备注）；设置页与预览要重启 dev。

## 走查（2026-11-15，按 `FINAL_CHECK.md`）

用户：「按军规比一下像素」。之前的「每张最多 66 个像素、只差 1 级」与 `3287715210`「屏蔽眼睛后最大差 4 级」都没落到 draw 和值，按原则第 4 条不算通过，重做。

**方法**：两边逐 pass 读回（我们用 `render_scene` 的 `trace.readback`，WPE 用 `save_texture`）：合成前场景、LightBuffer 正面、`blur_h`、`blur_v`、合成；第一处不同落在哪个 draw，就按 WPE 那个 draw 的 DXBC 用 float64 复算整张 RT，测两边在各整数级的取整门槛，看差异像素在不在门槛上。追踪工具原来不读 `r32float`（体积光的 Back / Single），补上（`render/trace.ts`，单测一条），用它逐位比了 `in-low` 的 Back（2073600 个）与 Single（32400 个，`r32float` 拷贝与 `depth32float` 原值都比）：全部相同；`in-low` 正面 draw 的 uniform 在轨迹 `rawUniforms` 里与 WPE 逐位相同。脚本都在 `ignore/p13/e/fc_*.py`，读回与抓帧导出在 `ignore/p13/e/fc/<样本>/`。

**发现**：本机硬件把浮点写进 RGBA8（带混合）不是 ×255 就近取整：第 n 级往上取的门槛 `n + t(n)`，t(n) 每升 1 级降约 1/256、约每 16 级跳回 .56（`fc_front_threshold.py`、`fc_ground*.py` 在三种画法上测的同一组门槛）；两边的门槛相同（只差一两个分量），差异全是着色器输出的 float32 微小不同（fxc DXBC 与 Tint / DXC）把值放在门槛两侧。登记进 `WPE_SCENE.md`「片元的零星舍入差」。

| 样本 | 差异 | 第一处不同 | 精确值与门槛 | 结论 |
|---|---|---|---|---|
| `po-low` / `hdr-low`（同场景） | 3 像素 | 合成前：地面（WPE 事件 49，`generic4` + 点光） | (1580, 318) B 72.52807、(1203, 338) B 101.53933、(1099, 617) R 76.51244，各自正是 n = 72 / 101 / 76 那一级两边门槛的端点 | 门槛像素；体积光链 RGB 逐位相同 |
| `in-low`（相机在灯内） | 66 像素 | LightBuffer 正面全屏变体，纹素 (202, 11) R 15 / 16 | 输入（Back、Single、uniform）逐位相同；R 精确 15.501708，n = 15 门槛 .50171（WPE 往上的最小值 = 我们往下的最大值 = 这个纹素）；另 2 个像素在合成前 | 门槛纹素，经模糊与 8 倍上采样成 64 像素 |
| `pp-low` / `ps-low` | 1 像素 | 合成前：透视地面 | (1324, 784) G 78.5048，n = 78 门槛带 .50431–.50481（透视插值使两边门槛重叠） | 门槛像素；`ps` 的阴影变体体积光链逐位相同 |
| `seq-low`（两段灯、两次合成） | 1 像素 | 合成前：地面（三盏点光） | (1244, 500) R/G 61.50879，n = 61 门槛 .50879 | 门槛像素；两段体积光链逐位相同 |
| `spot-low` | 4 像素 | 合成前：地面 3 个、立方体 1 个（聚光） | 地面 B 67.54783 / R 86.53698 / B 62.50526 在各级门槛带里；立方体 (937, 436) R 89.5277，离 WPE 门槛 .5243 高 0.0034 级：在聚光锥边（每像素 1.8 级），相当于 1/526 像素，归透视插值的位置误差（推断：顶点按 1/256 像素对齐，没逐位证实） | 门槛像素；聚光体积光链逐位相同 |
| `kinds-low` / `scale-low` | 0 | — | — | 逐像素相同 |
| 四档 21 张 | 除 `po-high` 外的差异全是上面 low 档已证实的同一批场景像素 | — | — | 同上 |
| `po-high` | 多 32 像素 | LightBuffer 正面（480×270、不模糊）纹素 (303 / 346, 37) | 按 577 点球网格求交复算整张：R 精确 11.51739，n = 11 门槛 .51739 | 门槛纹素，4×4 上采样成 32 像素 |
| `3837478759-iso` 五档 | 0 | — | — | 逐像素相同 |
| `3287715210-iso2`（HDR，新复制工程：只留渐变背景 259 与灯 85） | 最终 8 位 104481 像素、最大 3 | 合成前场景 54509 像素（背景图层） | 背景是渐进式 JPEG 4:2:0（`fc_tex_kind.py`），已登记的「JPEG 色度上采样」；LightBuffer 正面 1 个纹素差 1 个半精度 ulp（SHADOW 变体，没逐值复算），合成前逐位相同的 201.9 万像素里合成后只有 9 个差 1 ulp，全在这个纹素的上采样范围；最终帧的差异是背景差异经泛光摊开 | 体积光部分：一个半精度舍入纹素；其余是别的阶段的已登记差异 |

**另记**：
- `blur_h` 输出的 alpha 两边不同（WPE 0、我们 1），`blur_v` 输出的 alpha 两边都是 1、合成按它 SrcAlpha，画面不受影响。
- 旧的 `3287715210-iso` 留了人物层，`iris_follow_cursor` 跟光标转、抓帧时光标没录，状态还原不了；图像层不写深度、不投影，不影响体积光，按原则第 5 条去掉。
- 没做到的：`3287715210-iso2` 那个半精度纹素与 `spot` 立方体像素没逐位证实（前者要复算阴影图集采样，后者要复现顶点对齐）；只比了每次抓帧的第一帧（场景静止）。
- 测试行导入后都已用 `projects_remove` 移除（`manifest-fc.json`、`manifest-fc-iso2.json`）；`po-high` 用 dev 覆盖切档，用完已清除。
