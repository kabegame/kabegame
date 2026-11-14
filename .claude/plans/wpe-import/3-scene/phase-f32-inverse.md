# uniform 求逆照 WPE 用单精度（`invertF32`）

2026-11-15，用户：「好」（phase-render-size 步骤 2 报告后问「要现在做吗」）。

## 总体设计思路

内置 uniform 里的逆矩阵（`g_ModelViewProjectionMatrixInverse`、`g_ModelMatrixInverse`、`g_EffectModelViewProjectionMatrixInverse`、
`g_EffectTextureProjectionMatrixInverse`，以及非内置的 `g_EffectModelMatrixInverse`）现在用 `math.ts` 的 `invert` 算：余子式在 double 里展开、
最后存成 float32。WPE 写常量缓冲时一律现算 `FUN_14005f730`（rea-matrix-order 2.5【确】），是逐条 `mulss` / `subss` / `divss` 的单精度余子式，
两者在末位常差 1 ulp。P6c 已经照反汇编搬运了一份 `render/inverseF32.ts` 的 `invertF32`，光标反投影在用，和 WPE 日志逐位相同。

这次把 uniform 的求逆统一换成它：在 `inverseF32.ts` 加一个 `uniformInverse`，`uniforms.ts` 里四处求逆和粒子拖尾在 CPU 上模拟
`g_ModelMatrixInverse` 的 `eyeLocal`（`particles/vertices.ts`，注释写明要和 uniform 同一个逆）都调它。奇异矩阵照以前取单位阵：
`invertF32` 这时得到 inf / NaN，WPE 会原样写进常量缓冲，语料里没有这种样本，不跟。

不在这次范围（`phase-f32-matrix.md` 列为「不改」的其余项照旧）：粒子模拟里的求逆（`controlpoints.ts`、`system.ts`，WPE 那边有的是
`FUN_1402290d0`，rea-p4c-sim）、组的局部正交（`groupViewProjection`）、光标以外的 `pointerScenePoint`。

依据（phase-render-size「步骤 2」）：
- `sun`（P10a 复制工程）第 161 帧镜头光晕上屏那次绘制，MVP 0 ulp，`g_ModelViewProjectionMatrixInverse` 5 个分量差 1 ulp、6 个 ±0 符号不同；
- `tmpl2`（P5d 复制工程）第 278 帧地板 effect 上屏，`g_EffectTextureProjectionMatrixInverse` 差 1 ulp；
- 两处 `invertF32` 对同一个矩阵求逆都和 WPE 逐位相同。

## 现状锚点

**a. `staticBuiltins` 的求逆**（`render/uniforms.ts:227`）
```ts
const inverse = (m: Mat4) => Array.from(invert(m) ?? identity); // 现状：double 余子式
// g_ModelMatrixInverse / g_EffectModelMatrixInverse / g_EffectModelViewProjectionMatrixInverse / g_EffectTextureProjectionMatrixInverse 用它
```

**b. 三处 `modelViewProjectionInverse`**（`uniforms.ts:446`、`:528`、`:639`）
```ts
modelViewProjectionInverse: invert(matrices.modelViewProjection), // 现状：drawUniformValues / textUniformValues / particleUniformValues
```

**c. 粒子拖尾的眼位**（`particles/vertices.ts:116`）
```ts
const m = invert(model) ?? identity(); // 现状：注释说「和 uniform 里写的同一个」
```

## 点 1 — `uniformInverse`（`render/inverseF32.ts`）
- **新增**
```ts
/** 内置 uniform 的求逆（WPE 写常量缓冲时现算 FUN_14005f730，rea-matrix-order 2.5）：invertF32，结果有 inf / NaN（奇异）时返回 null。 */
export function uniformInverse(m: Float32Array): Float32Array | null;
```

## 点 2 — 调用方（`render/uniforms.ts`、`particles/vertices.ts`）
- **修改** 上面锚点 a、b、c 的五处 `invert(…)` 换成 `uniformInverse(…)`，`?? identity` 的兜底不变；`uniforms.ts` 不再用 `invert` 就删掉导入。

## 点 3 — 文档
- `phase-f32-matrix.md` 的「求逆」一项注明已改；`WPE_SCENE.md` 里归到「求逆」的已知差异（P10a `sun`、P5d `3462279189`）按重跑结果改写；
  `FINAL_CHECK.md` 的剩余差异分类同步；回归一节；changelog 一行（画面会变，用户可见但极小）。
  - 实际（见实施记录）：`sun`、`tmpl2` 的像素没变，改的是归因；`WPE_SCENE.md` 内置 uniform 一节加「逆矩阵」一条，P13a 的计划「待定」补结论。

## 验收

1. **单测**（新 `render/uniformInverse.test.ts` + 夹具 `uniformInverse.fixture.json`）：
   - 夹具 4 个 WPE 样本（3 个 MVP 的逆来自抓帧里同一次绘制同时读了矩阵与逆、1 个 effect 纹理投影的逆），`uniformInverse` 逐位相同、`invert` 都不同；
   - `staticBuiltins` 的四个逆、`drawUniformValues` / `textUniformValues` / `particleUniformValues` 的 MVP 逆都等于 `uniformInverse` 的结果
     （输入选成 `invert` 与 `invertF32` 不同的矩阵，任一处改回 `invert` 都会失败）；
   - 奇异矩阵返回 null，uniform 是单位阵（同以前）。
   - 宿主 tsc 0 error、相关 vitest、Prettier。
2. **变异**：五处各改回 `invert`，单测都要抓到。
3. **画面**：重建宿主产物前后 `hash_baseline` / `hash_compare`（10 张 × 3 档），变化的只能是着色器读了 `g_*Inverse` 的场景，逐张说明。
4. **和 WPE 比**：重跑 `sun`（P10a）与 `tmpl2`（P5d）的按窗口尺寸对照，差 1 的像素应当消失或减少，剩下的另有归因。

## 风险
1. 改变所有读逆矩阵 uniform 的场景的输出（末位舍入），产品的预览与桌面也会变；方向是向 WPE 靠拢。
2. 奇异时的行为没跟 WPE（我们单位阵、WPE inf / NaN），没有样本。

## 实施记录

### 2026-11-15（Claude 实现与验收）
- **改动**：
  - `render/inverseF32.ts`：新增 `uniformInverse`（`invertF32`，结果有 inf / NaN 时返回 null）。
  - `render/uniforms.ts`：`staticBuiltins` 的 `inverse` 与三处 `modelViewProjectionInverse` 改用它，不再导入 `invert`。
  - `particles/vertices.ts`：`trailEye` 改用它（和 uniform 同一个逆）。
  - 测试：新 `render/uniformInverse.test.ts` + `uniformInverse.fixture.json`（4 个 WPE 样本，按位存十六进制，JSON 会把 −0 写成 0；
    提取脚本 `ignore/prs/rerun/inv_fixture.ts`、`inv_fixture_add.ts`）；`p8.test.ts`、`particles.test.ts` 里单位阵逆的断言改成
    `[1, −0, 0, −0, −0, 1, −0, 0, 0, −0, 1, −0, −0, 0, −0, 1]`（WPE 的 `FUN_14005f730` 正负号乘 −1.0，单位阵的逆非对角有 −0）。
- **检查**：tsc 0 error；`uniformInverse` 9 条、读逆矩阵与粒子拖尾的相关测试全过（`compile/p5d.test.ts` 有 1 条失败，P13c 的提交
  `34e27ed8` 本身就有，和本节无关）。变异 6 / 6（`ignore/prs/inv/mutations.py`：五处调用方各改回 `invert`、去掉奇异兜底）。
- **画面哈希**：改动前后 `hash_baseline` 10 张 × 3 档 30 组全部相同（`ignore/prs/inv/hash-before.json`、`hash-after.json`）。这期间别的会话也
  重建过产物（`scene.ts`、`camera.ts`、`sprite.ts` 有改动），两份基线之间不只有本节，但结果相同，不影响结论。
- **和 WPE 比**（用当时的录制重跑，按窗口尺寸画）：
  - `sun`（P10a）：光晕上屏那次绘制（WPE 事件 45）的 14 个常量现在全部和 WPE 相同（`g_ModelViewProjectionMatrixInverse` 只剩轨迹 JSON 丢掉的 −0），
    像素差和改前逐帧一样（161 帧 1013 个……）。**更正步骤 2 的归因**：这里的 ±1 不是求逆，是着色器求值的舍入，同 `gradt`、`frostp`。
  - `tmpl2` 四组（P5d）：117 / 100 / 49 / 50 个，和改前一样，同上更正。`whale` 三段、`3822495444`（P7c，PNG 逐字节相同）也不变。
  - `3498150384`（P13a 第二轮，3840×2130 窗口）：229、230 帧逐像素相同（改前 2、32 个），231–233 帧 289 / 1 / 1 个、最大 1（改前 309 / 14 / 6、
    最大 3 / 2 / 2）。A/B：临时只把 `uniformInverse` 换回 double 求逆（`// DEBUG-inv-ab`），重建产物重跑，数字和步骤 2 一模一样；验完恢复、重建、
    确认产物回到同一份（`index-CIjvFYbC`）。读逆矩阵的是 `layer 87` 的 effect（`g_EffectTextureProjectionMatrixInverse`），跨帧反馈的 8 位 RT 把
    末位差放大，这是本节唯一看得到的效果。
- **测试行**：导入的 5 个（`ignore/prs/inv/import.json`、`import-p13a.json`）都已用 `projects_remove` 移除并核实。
- **文档**：`WPE_SCENE.md` 内置 uniform 加「逆矩阵」一条，P5d、P10a 的已知差异改正归因；`FINAL_CHECK.md` 剩余差异分类；`phase-f32-matrix.md`
  的「求逆」标已改；`phase13/phase-13a-legacy-lights.md` 的「待定」补结论；`phase-render-size.md` 步骤 2 的「求逆的写法」加更正；
  回归「uniform 的逆矩阵照 WPE 用单精度」FI1–FI5（FI5 实时预览没做，不接管图库）；changelog 用户侧 Fixed 一行。
- **没做**：粒子模拟里的求逆（`controlpoints.ts`、`system.ts`）、组的局部正交、`pointerScenePoint`，同计划。
