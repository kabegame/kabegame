# P14c — 组里图像层的矩阵（g_ModelMatrix / g_ViewProjectionMatrix / 效果矩阵）

> P14b（`phase-14b-group-models.md`）的后续。P14b 的 `p14b-gm-basic` 抓帧里，组里的探针**图像层**（事件 84）`g_ModelMatrix` 是相对组的局部矩阵、
> `g_ViewProjectionMatrix` 是组的局部正交 P；我们给的是世界矩阵 W 与 `P · inverse(W_组)`（只有 MVP 在 P8 步骤 7 对齐过）。2026-11-21 用户定：
> 另开一步修。数据在 `ignore/p14/c/`，WPE 抓帧在 `A:\p14c\`。

## 总体设计思路

WPE 组画子树时把模型栈换成 `inverse(W_组)`、视图栈换成单位阵、投影栈换成组的局部正交（rea-p5-modelflags §2.5），子层画自己时把世界矩阵并进
模型栈，所以组里**一切从模型栈、视图投影栈读出来的矩阵**都是「组内局部」的：`g_ModelMatrix` = `inverse(W_组) ⊗ W`、`g_ViewProjectionMatrix` = P，
MVP 才是两者的乘积。我们 P5b 起的写法是把组的逆并进视图投影（`groupViewProjection` = `P · inverse(W_组)`），模型矩阵保持世界矩阵；P8 步骤 7
只把 MVP 换成 WPE 的结合顺序（`groupMvpParts`），其余矩阵没动。两种写法 MVP 一样（画面位置对），分开读模型矩阵或视图投影的着色器（光照的
`v_WorldPos`、法线、效果矩阵、`g_ModelMatrixInverse`）结果不同。

本步把组里各角色的矩阵改成「局部模型矩阵 + 局部正交」这一种表示：`drawMatrices` 收到的 `world` 换成局部矩阵、`viewProjection` 换成 P，
MVP 与效果矩阵由同一套公式自然得出，不再需要 `group` 那条特例分支（MVP 的结合顺序不变，P8 步骤 7 的抓帧照样逐位）。乘法照 WPE 分角色：图像层
画自己时是内联的仿射乘法（`FUN_1401e8aa0` 直接上屏段，k 2 → 0，同 `mulAffine`），网格是 glm 的 `multiply`（P14b）；其余角色（effect 中间 pass、
末 pass、passthrough、文本、粒子、预光照的 Alt 矩阵、嵌套组的 compose）由第 0 点读码加抓帧逐个定。全屏组的子孙用场景相机（P5j），不在本步。

关键决策：先拿抓帧定真值，再改。用一个工程把组里各角色的探针都放上（组带 x / y 旋转，分辨乘法），WPE 抓帧读常量，同一工程用探针的逐 draw
轨迹（`render_scene` 的 `trace`，uniform 按名字解码）读我们的，逐 draw 逐常量比，差异表就是要改的清单。

## 现状锚点

**a. 组里图像层的 uniform**（`render/scene.ts` 的 `uniformValues`）
```ts
    const groupVp =
      group && !group.fullscreen && !compose
        ? groupViewProjection(group.size, drawMatrixOf(group.object, state.layers, worlds, this.attachHook))  // P · inverse(W_组)
        : null;
    const groupMvp = groupVp && group ? groupMvpParts(group.size, drawMatrixOf(…)) : null;              // { projection, inverse }
    …
    return this.userWhiteout(step, layer, common.constants, drawUniformValues({
        ...common,                                   // world = W（世界矩阵 · 自身偏移）
        group: groupMvp,                             // 只换 MVP：P ⊗ (inverse(W_组) ⊗ W)
        viewProjection: groupOrCompose ?? …,         // g_ViewProjectionMatrix = P · inverse(W_组)
    }));
```
**b. `drawMatrices`**（`render/uniforms.ts`）：`layerMvp = group ? mulAffine(P, mulAffine(inverse, W)) : mulAffine(VP, W)`；`model` 一律是 W，
effect 角色的 `effectModel = W · half`、`layerModel = W`。

**c. 网格（P14b，已对）**：组里 `world = multiply(inverse, W)`、`viewProjection = P`。

## 点 0 — 读码与 WPE 实测

- 读码：`FUN_1401e8aa0`（图像层绘制）的直接上屏、合成 RT 基础 pass、`this+0x344` / `+0x384`（效果矩阵的来源，`0x1401e95b5`–`0x1401e961a`）、
  末 pass（`FUN_1401ebf60`）与 passthrough 上屏各自压栈与乘法的写法；文本（`FUN_140256…`）、粒子、预光照（`ctx+0xa70`）各自的模型矩阵。
- 工程 `p14c-gi-*`（`ignore/p14/c/gen_p14c.py`，正交 1920×1080，组带 x / y 旋转）：组里放直接上屏图层、带一个 effect 的图层（中间 pass 与末 pass
  都读全部矩阵）、colorBlendMode 混合（passthrough 上屏）、文本层、本地 / 世界空间粒子、带 effect 的嵌套组；探针着色器读 `g_ModelMatrix`、
  `g_ModelMatrixInverse`、`g_ViewProjectionMatrix`、`g_ModelViewProjectionMatrix`、`g_EffectModelMatrix`、`g_EffectModelViewProjectionMatrix`、
  `g_EffectTextureProjectionMatrix`、`g_LayerModelMatrix`、`g_NormalModelMatrix`。
- 对照：WPE 抓帧读常量；`render_scene` 的 `trace` 读我们的；逐 draw 逐常量比，出差异表。

### 点 0 结果（2026-11-21）

工程 `ignore/p14/c/gen_p14c.py` 的 `p14c-gi`，抓帧 `A:\p14c\gi\gi-frame153.rdc`，常量 `ignore/p14/c/out/wpe-gi-consts.json`（`kbp rdc consts`），我们的
`ignore/p14/c/out/trace-gi*/trace.json`，对照 `ignore/p14/c/cmp_consts.py`（WPE 的导出不含 FR / CLK，其余按绘制顺序配对）。

| 角色 | WPE | 改前的我们 |
|---|---|---|
| 组里直接上屏（A20，事件 88） | `g_ModelMatrix` = `mulAffine(inverse(W_组), W)`（仿射，`FUN_1401e8aa0` 直接上屏段的内联乘法；glm 乘法差 1 ulp）、`g_ViewProjectionMatrix` = P；效果矩阵不写（残留值） | W、`P · inverse(W_组)` |
| 组里 effect 的末 pass（B20 / L20，事件 135 / 173） | 模型矩阵、视图投影同上；`g_EffectModelMatrix` = `g_LayerModelMatrix` = W；`g_EffectModelViewProjectionMatrix` = `mulAffine(P, W)`（漏了组的逆），`g_EffectTextureProjectionMatrix` = 它 · 半尺寸 | 模型矩阵、视图投影同上一行；效果矩阵 W（对）；效果投影 = 图层 MVP |
| 组里 effect 的中间 pass（事件 118） | `g_EffectModelMatrix` = W · 半尺寸、`g_LayerModelMatrix` = W；效果投影同末 pass | 前两项对；效果投影 = 图层 MVP · 半尺寸 |
| 预光照（L20 基础 pass，事件 157） | Alt 三个矩阵 | 相同 |
| 组的 compose / 上屏、顶层 | — | 相同（顶层中间 pass 的视图投影、基础 pass 的深度项、各角色不写的残留值本来就不同，不在本步） |
| 粒子（事件 189 / 202） | `kbp rdc consts` 没导出常量（在几何阶段读） | 整帧两颗粒子差几个像素：朝向用的模型矩阵不同，P14d（`phase-14d-group-particles.md`）修了 |

决定：效果投影矩阵是缺陷（铺满全屏、居中不转的组差半个屏幕，读它采屏幕或换算光标的 effect 在组里错位），语料里组里没有读它的 effect
（`ignore/p14/c/scan_group_fx.py`），按「壁纸不依赖的缺陷不复现」保持我们的写法。

## 点 1 — `drawMatrices` 的组内表示（`render/uniforms.ts`）

- **修改** 收到 `group` 时 `model = mulAffine(group.inverse, world)`、`layerMvp = mulAffine(group.projection, model)`（数值同以前）；effect / final 的
  `effectModel`、`layerModel` 改取 `world`（不跟着变成局部的）。

## 点 2 — 组里图像层的视图投影（`render/scene.ts`）

- **修改** 图像层那次 `drawUniformValues` 的 `viewProjection`：`groupMvp?.projection ?? groupOrCompose ?? …`；预光照的 Alt 视图投影不动（已同 WPE）。

## 执行记录（2026-11-21）

- 点 1、2 已实现；`layout.ts` 的 `groupMvpParts` 注释、`p8.test.ts` 与 `p5b-group.test.ts` 的旧断言按实测改；新测试 `render/p14c.test.ts`（抓帧常量逐位）。
- 变异 7 / 7 检出；`render/` 全部测试除 HEAD 上就失败的 3 条外全过；逐常量对照见上表的结果全部对上；语料受影响 0 张（见 cocs）。

## 验证

- 单测（抓帧常量逐位）、变异、语料扫描（组里图像层读这些矩阵的场景名单，看画面变化）、生成工程整帧对照、受影响的真实场景走查。
