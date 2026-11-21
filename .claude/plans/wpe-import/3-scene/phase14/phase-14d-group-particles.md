# P14d — 组里的粒子：绘制模型矩阵用组内局部坐标（朝向、`g_ModelMatrix`、拖尾眼位）

> P14c（`phase-14c-group-image-matrices.md`）收尾时留下的一条：`p14c-gi` 里组带 x / y 旋转时，组里两颗粒子的形状和 WPE 不同（位置相同，
> 质心差 0.05 像素）。2026-11-21 查明原因、用户定：另开一步修。数据在 `ignore/p14/d/`，WPE 抓帧在 `A:\p14d\`。

## 总体设计思路

WPE 画组的子树时把模型栈换成 `inverse(W_组)`，同时把 `ctx+0xaf0`（世界空间粒子绘制时整个覆盖栈顶用的矩阵）临时设成当时的模型矩阵
（rea-p4c-sim 5.3：`0x1401ecd0a` / `0x1402083e4` 设、`0x1401ececb` / `0x14020858b` 复位）。所以组里粒子绘制的「当前栈顶」是组内局部的：
本地系统 `inverse(W_组) ⊗ W`（压栈的 glm 乘法），世界空间系统 `inverse(W_组)`，子系统与事件实例在这个栈顶上照 P4e 的规则继续乘。
`g_ModelMatrix`、`g_Orientation*`（`FUN_1402298b0` 取 `*(ctx+0x30)`）、拖尾着色器的 `eyeLocal`（`g_ModelMatrixInverse`）都从它来，
视图投影是组的局部正交 P，MVP = `P ⊗ M`。粒子的**位置**和以前一样（我们以前是 `M = W`、`VP = P · inverse(W_组)`，乘出来的 MVP 只差
结合顺序），变的是 sprite 四边形的朝向：WPE 里它正对组自己的相机，组 RT 斜着上屏时跟着斜；我们以前让它正对场景相机。`p14c-gi` 的事件
189 / 202 已经按这个规则用我们的函数算过，MVP 与三个朝向向量逐位相同（`ignore/p14/d/p14d-probe.test.ts.txt`）。

改法是给粒子树的绘制矩阵链加一个「起点」：`ParticleSystem.forEachDrawn` / `drawTransform` 收一个可选的 `base`，组里（非全屏组、组的世界
矩阵可逆）由渲染器传 `inverse(W_组)`（`groupMvpParts(...).inverse`，和组里图像层、网格同一份），本地根系统 `multiply(base, W)`、世界系统与
世界子系统取 `base` 本身；不在组里时不传，走原来的代码、逐字节不变。粒子分支的视图投影在组里换成 `groupMvp.projection`。朝向、
`g_ModelMatrix`、拖尾眼位、`hidden` 判断都吃同一个模型矩阵，不用逐项改。

关键决策：
- **世界空间根系统画完后的栈顶**：WPE 恢复成 `sys+0x3a0`（对象世界矩阵 W，不带组的逆，rea-p4e-children 第 6 节），挂在它下面的本地
  static 子系统在组里会按 `W ⊗ L` 配组的局部正交画到错的位置。语料里没有组里的粒子（`ignore/p14/d/scan_group_particles.py`：有父的粒子
  16 个，父都是粒子、puppet 或分组节点），按「壁纸不依赖的缺陷不复现」取 `multiply(base, W)`，记为有意不同；测试工程里放一个这种组合，
  抓帧核对读码。
- **视线、上方向不改**：`vf` / `vup` 是 `g_ViewForward` / `g_ViewUp`，WPE 每帧从场景视图矩阵抽一次，组画子树时不重算（rea-p4c-render 7.2），
  我们照旧传场景的视图向量。
- **乘法**：本地根系统 `multiply`（glm，`p14c-gi` 事件 189 逐位，仿射乘法差 1 ulp）。

## 现状锚点

**a. 绘制矩阵链**（`particles/system.ts`）
```ts
  forEachDrawn(callback: ParticleDrawnCallback, object: Mat4 = identity()): void {
    this.visitDrawn(callback, this.def.flags & 1 ? identity() : object, object, []);   // 现状：根的 model = 世界 ? I : W，top = W
  }
  private visitDrawn(callback, model, top, template): void {
    …
      const childModel = world ? identity() : multiply(top, child.local);                 // 现状：世界子系统是单位阵
      child.system.visitDrawn(callback, childModel, world ? child.local : childModel, …);
  }
  drawTransform(object: Mat4): { model: Mat4; top: Mat4 } {
    const world = (this.def.flags & 1) !== 0;
    const parent = this.parent;
    if (!parent) return { model: world ? identity() : object, top: object };
    const x = this.instanceMatrix ?? this.localMatrix!;
    const model = world ? identity() : multiply(parent.drawTransform(object).top, x);
    return { model, top: world ? x : model };
  }
```
**b. 渲染器取模型矩阵**（`render/scene.ts`）
```ts
  private particleModel(particles: ParticleDraw, object: number, state: SceneState, worlds: Map<number, Mat4>): Mat4 {
    return particles.system.drawTransform(worldMatrixOf(object, state.layers, worlds, this.attachHook)).model;  // 现状：不看组
  }
  private arrangeParticles(tree, state, worlds) {
    const object = worldMatrixOf(tree.object, state.layers, worlds, this.attachHook);
    this.walkParticles(tree, object, (system, template, occurrence, model) => { … });    // walkParticles → forEachDrawn(cb, object)
  }
```
**c. 粒子分支的视图投影**（`render/scene.ts` 的 `uniformValues`）
```ts
      return particleUniformValues({
        ...common,
        world: model ?? identity(),                    // 现状：本地系统 W、世界系统单位阵
        viewProjection: groupOrCompose ?? this.viewProjectionOf(layer, state, view, step.perspective),  // 组里 P · inverse(W_组)
        …
      });
```
**d. uniform**（`render/uniforms.ts` 的 `particleUniformValues`）：`MVP = mulAffine(VP, world)`、`g_ModelMatrix = world`，朝向
`particleBuiltins(…, input.world, …)` 用同一个矩阵；不用改。

## 点 0 — 测试工程与 WPE 实测

- **新增** `ignore/p14/d/gen_p14d.py` 的 `p14d-gp`（正交 1920×1080，FR / CLK 在最前；组 G 同 `p14c-gi`：`origin 700 560 30`、`size 800 600`、
  `scale 1.25 0.8 1.1`、`angles 0.3 0.2 0.35`）。组里与顶层（平移 1250）各一份，每格一颗静止粒子（rate 0、instantaneous 1、速度不动、
  不死，不挂 movement，任意帧相同）：
  - `PS` 本地 sprite（screen）、`WS` 世界 sprite、`PU` 本地 `upright`、`PF` 本地 `fixed`（axis `0 0 1`）；
  - `PT` 本地 spritetrail（带初速、不挂 movement，拖尾按速度画）：看 GS 的 `g_EyePosition` / `g_ModelMatrixInverse`；
  - `PL` 本地 sprite + `LIGHTING`（点光一盏）：看 `g_ModelMatrix`；
  - `LC` 本地父 + 本地 static 子 + 世界 static 子；`WC` 世界父 + 本地 static 子（读码的 WPE 缺陷）。
- **修改** `kbp rdc consts` 加几何阶段（`gs`）：粒子的 MVP 与朝向都在几何着色器里读，P14c 因此没导出来。
- 抓帧 `A:\p14d\gp\`，`kbp rdc consts` 导出；对照脚本 `ignore/p14/d/cmp_consts.py` 逐 draw 逐常量比我们 `render_scene` 的逐 draw 轨迹。

### 点 0 结果（2026-11-21）

抓帧 `A:\p14d\gp\gp-frame198.rdc`，常量 `ignore/p14/d/out/wpe-gp-consts.json`（`kbp rdc consts`，含 `gs`），我们的
`ignore/p14/d/out/trace-gp-after/trace.json`，对照 `ignore/p14/d/cmp_consts.py`。

| 绘制（事件） | WPE | 改后的我们 |
|---|---|---|
| PS / PU / PF / PL / PT（125 / 151 / 164 / 194 / 177） | 本地系统 `M = inverse(W_组) · W`（glm），MVP = `P ⊗ M`，朝向、`g_ModelMatrix`、拖尾的 `g_ModelMatrixInverse` 从 M 来，`g_EyePosition` 是场景的 | 逐位相同 |
| WS、LCb（138 / 234） | 世界系统与本地父下的世界子系统 `M = inverse(W_组)` | 逐位相同 |
| LC → LCa（208 → 221） | 本地子系统 `M = 栈顶 · L` | 逐位相同 |
| WC → WCa（247 → 260） | 世界父逐位相同；它下面的本地子系统 `M = W · L`（栈顶恢复成不带组逆的 W，画到组 RT 外） | WC 相同；WCa 取 `inverse(W_组) · W · L`（有意不同） |
| 顶层对照（294–429） | — | 改动前后都相同 |

## 点 1 — 绘制矩阵链的起点（`particles/system.ts`）

- **修改** `forEachDrawn(callback, object, base?)`、`drawTransform(object, base?)`：
```ts
  /** `base`：绘制栈的起点（P14d）。组里是 `inverse(W_组)`（WPE 画组的子树时的模型栈，`ctx+0xaf0` 同值）；不给时同以前。 */
  forEachDrawn(callback: ParticleDrawnCallback, object: Mat4 = identity(), base?: Mat4): void {
    const top = base ? multiply(base, object) : object;                    // 新增：本地根 inverse(W_组) ⊗ W（glm）
    this.visitDrawn(callback, this.def.flags & 1 ? (base ?? identity()) : top, top, [], base);   // 世界根取 base
  }
  private visitDrawn(callback, model, top, template, base?: Mat4): void {
      const childModel = world ? (base ?? identity()) : multiply(top, child.local);   // 修改：世界子系统取 base
  }
  drawTransform(object: Mat4, base?: Mat4): { model: Mat4; top: Mat4 } {
    if (!parent) {
      const top = base ? multiply(base, object) : object;                  // 世界根画完的栈顶：WPE 是 W（缺陷，不复现）
      return { model: world ? (base ?? identity()) : top, top };
    }
    const model = world ? (base ?? identity()) : multiply(parent.drawTransform(object, base).top, x);
  }
```

## 点 2 — 渲染器（`render/scene.ts`）

- **新增** `particleBase(object, state, worlds): Mat4 | null`：对象所在的组是非全屏组、组的世界矩阵可逆时取 `groupMvpParts(...).inverse`，否则 null。
- **修改** `particleModel` 传 `base`；`arrangeParticles` / `walkParticles` 把 `base` 交给 `forEachDrawn`。
- **修改** 粒子分支 `viewProjection: groupMvp?.projection ?? groupOrCompose ?? …`。

## 点 3 — 文档与回归

- `cocs/wpe/WPE_SCENE.md`：P5b 组的视图投影一行、P14 节「组里图像层的矩阵（P14c）」的「没覆盖的」改写，新增「组里的粒子（P14d）」；
  `cocs/README.md` 的 P14 条目；`versions/latest/regression.md` 新节；`changelog.md` 一行。

## 验证

- 单测 `render/p14d.test.ts`：`p14d-gp` 抓帧常量逐位（MVP、`g_Orientation*`、`g_ModelMatrix`、拖尾的 `g_ModelMatrixInverse`），`p14c-gi`
  事件 189 / 202；`forEachDrawn` 与 `drawTransform` 给 `base` 时逐字节一致、不给时与改前一致；世界父的本地子是有意不同的那一处。
- 变异：去掉 `base`、世界根 / 世界子不取 `base`、视图投影不换 P、本地根改成 `mulAffine`。
- 生成工程整帧和 WPE 对照；`p14c-gi` 重渲染；语料 `regress --corpus` 不变（语料里没有组里的粒子）。

## 执行记录（2026-11-21）

- 点 0：`gen_p14d.py`、`kbp rdc consts` 加几何阶段；抓帧与对照见上表。
- 点 1、2 已实现；`p5b-group.test.ts` 的世界空间粒子 MVP 断言按实测改成 `P ⊗ inverse(W_组)`，新增 GpuScene 层的三条（组里本地 / 世界粒子、全屏组不换、
  组里的事件实例与「不动时不刷新」）；新测试 `render/p14d.test.ts`（`p14d-gp` 抓帧常量逐位，含 WCa 的 WPE 值逐位等于 `P ⊗ (W · L)`）。
- 变异 13 / 13 检出（第一轮漏了「世界事件实例」与「每帧现排不给起点」：后者只让实例每帧多刷新一次、画面不变，补了「不动时不刷新」的断言）。
- 整帧：`p14d-gp` 只有 WCa 一颗（173 个像素）；`p14c-gi` 0 差异（改动前 308 个像素）。`render/`、`particles/` 全部测试除 HEAD 上就失败的 3 条外全过。
