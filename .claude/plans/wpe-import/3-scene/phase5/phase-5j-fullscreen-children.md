# P5j：带子层的 fullscreenlayer（全屏组）与组内组合层 compose 的视差

> 起因（2026-11-20，用户）：myprojects/`3814353826` 只差 `model:fullscreen:children`。它的 id 74「时钟系统图层【用于校准时钟位置】」是
> 空的 fullscreenlayer（无 effect、`copybackground` 缺省），下面挂整个时钟：74 → 75 组合层（时钟系统【根目录】）→ 80 组合层（钟表，
> `copybackground: false`）→ 5 个文本，75 下另有文本 100、组合层 101。P5b 时这种用法读码有结论（rea-p5-modelflags §2.5「fullscreen 时
> 矩阵不变：子层按场景相机画进全屏 RT」）但没实测、语料 0 个，照报。

## 总体设计思路

全屏组（fullscreenlayer 带子层）在 WPE 里是「把一段子树按场景坐标画进一张屏幕大小的 RT，再整张贴回屏幕」：开头把当前画面拷进合成 RT
（和有 effect 的 fullscreenlayer 一样，不看 `copybackground`），子孙用**和顶层对象完全相同的场景相机**画进去（缩放、抖动都在，视差按根对象
——也就是全屏层自己——算，世界矩阵含全屏层的变换），最后不经 `effectpassthrough`，而是画**基础材质本身**（`fullscreenlayer.json` 的
`passthrough` 着色器，translucent，槽 0 换成合成 RT）的 2×2 NDC 四边形上屏；有 effect 时照现有 fullscreen 的 effect 链上屏。

我们的渲染图已经把全屏组排成「快照 → 拷贝进合成 RT 0 → 子树 → 上屏」，合成 RT 也已经按场景目标尺寸建；差的只有三处：编译期照报；
子孙的视图投影走了普通组的局部正交（`groupViewProjection(组 size, 组矩阵)`，全屏层的 size 是 2×2，完全不对）；没有 effect 时上屏用了
`groupUpload`（`effectpassthrough` 乘 `g_Color4`、`copybackground` 为真时关混合）。所以 P5j 只改这三处，组内的其它规则（子层写 RGBA、
`copybackground: false` 时 alpha 取 MAX、快照的组规则、嵌套组照旧局部正交）原样适用。

步骤 0 顺带发现一条**通用**差异：嵌套在组里的组合层（普通组与全屏组都一样），它的 compose 基础 pass 用的是**不带视差**的场景视图投影
（缩放、抖动照带）；顶层组合层的 compose 带视差（我们现在对）。我们现在给嵌套组的 compose 也乘了根对象的视差，P5b 的 `p5b-nest` 没开视差、
`p5b-grp-par` 的组在屏幕正中，都测不出来。P5j 一并改：组里（`layer.group != null`）的 compose 角色取 `view.viewProjection`。

关键决策：全屏组不新建图层种类、不新建渲染步骤，只在「取视图投影」和「组的上屏」两处按 `fullscreen` 分支；上屏复用基础 pass（它的程序
本来就编译），不新增编译产物。

## 步骤 0 结果（2026-11-20）

生成器 `ignore/p5/j/gen_j.py`（复用 `ignore/p5/b0/gen_b.py`），WPE 1920×1080 抓帧 `A:\p5j\a|b|cam3\`，对照帧 `ignore/p5/j/out/`，
日志 `ignore/p5/j/<标签>-log-1920x1080.txt`，轨迹 `ignore/p5/j/tracks/`，常量 `ignore/p5/j/<标签>-consts.json`（`consts.py` 打印）。

- `p5j-a`：F1（fullscreenlayer，origin 100 50、scale 0.8、angles z 0.2，无 effect）带子层 A（红方块，z 0.3）与 N（组合层带 kbfx，子层 NC）；
  F2（`copybackground: false`）带半透明蓝方块 B；F3（带 kbfx）带黄方块 C。
- `p5j-b`：F1 与 F2（`copybackground: false`）之间插顶层品红方块 S。
- `p5j-cam`（cam3）：zoom 1.25、相机抖动、视差（amount 1、mouseinfluence 0）；F1 + A + N/NC（F1 的 parallaxDepth 8 8）、顶层对照方块 R、
  顶层组合层 CLP（带 kbfx）、顶层普通组 G（偏离中心）里套组合层 M（带 kbfx、子层 MC），视差深度都是 8 8。

| 项 | 结论 | 依据 |
|---|---|---|
| 基础 pass | 两次 Resolve：屏幕 → `_rt_FullFrameBuffer`、→ 全屏 RT；**不看 `copybackground`**（F2 的 RT 里有 S，上屏后 S 还在） | `p5j-a` 事件 46/47、`p5j-b` 事件 93/94 取像素 |
| 合成 RT | 1920×1080（场景目标），F1 / F2 / F3 共用一张池化 RT | 事件 64、128、161 的绑定 |
| 子孙的矩阵 | MVP = 场景视图投影（缩放、抖动、视差按根对象 = 全屏层）· 子层完整世界矩阵（含全屏层的变换） | A：缩放 0.8、角度 0.5 = 0.2 + 0.3，平移 (444.35, 364.68) = (100, 50) + R(0.2)·0.8·(500, 300)；cam3 的 A / N 末 pass 带 F1 的视差，R 带自己的 |
| 子孙的混合 | 照自身混合、写 RGBA；`copybackground: false` 时 alpha 通道 One / One / Max | 事件 64（RGBA、SrcAlpha）、148（alpha Max） |
| 嵌套组 | 照旧：子层用嵌套组的局部正交（NC 2/400），末 pass 画回全屏 RT（矩阵同上）；compose 读全屏组开头的快照（直接父是组，层首不拷，P5f） | 事件 80、96、115 |
| 嵌套组的 compose | **不带视差**（缩放、抖动带）；普通组里的嵌套组同样不带；顶层组合层的 compose 带视差 | cam3：M compose (−0.5895, 0.6952) = 无视差 (−0.599, 0.718) + 抖动；N compose 同理；CLP compose 带视差 |
| 上屏（无 effect） | 基础材质：`passthrough` 着色器（顶点原样输出、像素只采样，不乘 `g_Color4`），2×2 NDC，槽 0 = 合成 RT，translucent（SrcAlpha / InvSrcAlpha），写掩码 RGB；F1 与 F2 相同 | 事件 128、161；`assets/materials/util/fullscreenlayer.json`（`passthrough`、translucent、槽 0 `_rt_FullFrameBuffer`），rea-p5-modelflags §2.6「无效果、有子层」画基础材质 |
| 上屏（有 effect） | 照现有 fullscreen：effect 末 pass，NDC 正交、translucent、RGB；`g_Color4` 是上一个设过颜色的层（C 的黄） | 事件 200 |

## 现状锚点

```ts
// compile/bundle.ts（组合层）
    if (layer.passthroughModel) {
      // 组合层 / 组带 `perspective: true`（P5h，`p5h-a` 实测）：…
      // fullscreenlayer 带子层：WPE 这时子层按场景相机画进全屏 RT（rea-p5-modelflags §2.5），没有实测，语料 0 个，照报
      if (layer.fullscreen && parents.includes(index)) unsupported.add("model:fullscreen:children");
    }
```
```ts
// render/scene.ts（uniformValues）：组里的绘制一律换成组的局部正交；嵌套组的 compose 例外，走 viewProjectionOf（带根对象的视差）
    const group = this.groupOf(layer);
    const groupVp =
      group && !(step.kind === "draw" && step.role === "compose")
        ? groupViewProjection(group.size, drawMatrixOf(group.object, state.layers, worlds, this.attachHook))
        : null;
    // …各分支 `viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, …)`
```
```ts
// render/graph.ts（planImageLayer 的合成路径尾部）：没有 effect 的组用 groupUpload（effectpassthrough），混合按 copyBackground
  } else if (finalEffect < 0 && group) {
    const pass = layer.groupUpload;
    …
      const upload = additive ? "additive" : layer.copyBackground ? pass.blending : "translucent";
      steps.push({ kind: "draw", role: "final", pass, …, geometry: screenGeometry, uv: [1, 1], inset: finalInset, blending: upload, … });
```
基础 pass 已对：`} else if (layer.fullscreen) { snapshot(); steps.push({ kind: "copy", … source: framebuffer, target: nextComposite() }); }`
排在 `copybackground` 判断之前；合成 RT 尺寸 `fullscreenSize === "scene"` 取场景目标。

## 点 1 — 编译期（`compile/bundle.ts`、`compile/features.ts`）

- **删除** `model:fullscreen:children` 的照报，换成注释（P5j，`p5j-a` 实测：基础 pass 拷屏幕、子孙按场景相机画进全屏 RT、上屏画基础材质）。
- **修改** `features.ts` 里提到「它带子层报 `model:fullscreen:children`」的注释；`groupChildIssues` 不动（全屏组里的透视 / 读快照等仍按组规则照报）。

## 点 2 — 视图投影（`render/scene.ts`）

```ts
    const group = this.groupOf(layer);
    const compose = step.kind === "draw" && step.role === "compose";   // 文本的 clearalpha 也是 compose 角色
    // 全屏组（P5j）：子孙用和顶层相同的场景相机（视差按根对象），不换局部正交
    const groupVp =
      group && !group.fullscreen && !compose
        ? groupViewProjection(group.size, drawMatrixOf(group.object, state.layers, worlds, this.attachHook))
        : null;
    // 组里的组合层的 compose（P5j，cam3 的 M、N）：不带视差的场景视图投影（缩放、抖动照带）；顶层的照旧带视差
    const composeVp = group && compose ? (persp ? view.perspectiveViewProjection : view.viewProjection) : null;
    // 各分支：viewProjection: groupVp ?? composeVp ?? this.viewProjectionOf(…)
```
- 图像层、文本、模型、预光照 `alt` 各处的 `groupVp ?? this.viewProjectionOf(...)` 都要经过 `composeVp`（只有 compose 角色会命中；文本的
  clearalpha 也算）。`persp` 在组里本来就照报，用不用透视那一份按现有 `persp && step.target.kind === "scene"` 的写法对齐即可。
- 头注释（89 行起「矩阵：组里图层的绘制…」）补全屏组与嵌套 compose 的规则。

## 点 3 — 全屏组的上屏（`render/graph.ts`）

```ts
  } else if (finalEffect < 0 && group && layer.fullscreen) {
    // 全屏组（P5j，`p5j-a` 事件 128 / 161）：画基础材质本身（`fullscreenlayer.json`：passthrough 着色器、translucent），槽 0 换成合成 RT，
    // 2×2 NDC；不看 copybackground；colorBlendMode 31 改 additive（读码 §2.6，未实测）。上屏不拷快照（槽 0 已换成合成 RT）
    const inputs = staticInputs(base, null);
    inputs[0] = { kind: "composite", index: current };
    const upload = additive ? "additive" : base.blending;
    steps.push({ kind: "draw", role: "final", pass: base, effect: null, target: { kind: "scene" }, inputs,
                 geometry: "fullscreen", uv: [1, 1], inset: NO_INSET, blending: upload, raster: rasterState(base, base, upload) });
  } else if (finalEffect < 0 && group) {
    …现有普通组的 groupUpload 不变
```
- 写掩码：顶层上屏照现有规则（场景目标）。全屏组嵌在别的组里（组里的 fullscreen 照报 `model:passthrough:children:fullscreen`）不考虑。
- 确认基础 pass 的程序在没有 effect 时也建（L7 的 `groupPrograms` 已含 `layer.passes`）；`scene.ts` 里 fullscreen 非 `direct` 角色的矩阵
  已是单位阵 + NDC 正交，passthrough 着色器本来就不乘。
- 文件头「组」「fullscreen」两段注释同步（删「fullscreenlayer 带子层照报，这里照拷贝」）。

## 点 4 — 测试

- 编译：fullscreenlayer 带子层不报（`compile/p5b.test.ts` 或新文件）。
- 渲染图：全屏组无 effect 的计划 = 快照 → 拷贝 → 子树 → 基础 pass 上屏（`fullscreen` 几何、槽 0 合成 RT、translucent；cbm 31 additive；
  `copybackground: false` 计划相同）；有 effect 的不变。
- uniform：全屏组子孙的 MVP = 场景 VP（带根视差）· W（含全屏层变换）；嵌套组的 compose 不带视差（全屏组里、普通组里各一条）；顶层组合层的
  compose 仍带视差；普通组子孙仍是局部正交。
- 只跑相关测试文件。

## 验收

- tsc、相关测试；变异：照报留着、全屏组子孙仍用局部正交、嵌套 compose 仍带视差、上屏仍用 groupUpload / 按 copybackground 定混合。
- 画面：`p5j-a`（209 / 210 帧）、`p5j-b`（164）、`p5j-cam`（cam3 的 204 / 205）导入 dev，按日志与轨迹回放，和 WPE 逐像素比（屏蔽 FR / CLK）。
- 语料：`3814353826`（myprojects）变干净；全库扫描没有新增键。
- 文档：WPE_SCENE.md（P5b 组一节的「嵌套组的 compose」、fullscreen 一节、新节「全屏组（P5j）」）、README、changelog、回归。

## 实施记录（2026-11-20）

执行代理（sonnet）按本计划实现，Claude 独立验收（重新折了 `scene.ts` 里两段过长的注释）。

**改动**（`apps/wpe-scene/src/`）
- `compile/bundle.ts`：删 `model:fullscreen:children` 照报；`compile/features.ts` 注释同步。
- `render/scene.ts`：`groupVp` 要求 `!group.fullscreen`；新增 `composeVp`（组里的 compose 角色取 `view.viewProjection`）与 `groupOrCompose`，
  原来 5 处 `groupVp ?? this.viewProjectionOf(…)` 换成它；头注释同步。
- `render/graph.ts`：没有 effect 的全屏组上屏画基础 pass（槽 0 合成 RT、`fullscreen` 几何、混合 = cbm 31 additive 否则基础材质的），排在
  普通组的 `groupUpload` 分支之前；头注释同步。基础 pass 程序本来就建（`groupPrograms` 含 `layer.passes`）。
- 测试：`compile/p5b.test.ts`（全屏组不报）；`render/p5b-group.test.ts` 新增 8 个用例（计划、混合、cbm 31、有 effect、全屏组子孙的视图投影、
  全屏组 / 普通组里嵌套组的 compose 不带视差、顶层 compose 带视差、上屏是基础 pass）。

**和计划不同**：`composeVp` 不分透视（compose 画进合成 RT，原写法的 `persp && target === scene` 对它恒为假），行为相同。

**验收**
- tsc 0 错；相关 20 个测试文件全过（538 + 141 个用例）。
- 变异（`ignore/p5/j/mutate_j.py`）6 处全部检出、还原一致：照报留着、子孙仍用局部正交、嵌套 compose 仍带视差、上屏仍走 `groupUpload`、
  上屏混合按 `copybackground`、cbm 31 不换 additive。
- 画面（宿主 `index-BrLecq9r.js`）：`p5j-b` 164 帧、`p5j-cam` 204 / 205 帧和 WPE 0 差；`p5j-a` 209 / 210 帧 2.6% 像素差 1：
  - 蓝色 53600 个来自 F3 末 pass，红色 7 个来自 N 末 pass；
  - 我们那里 `g_Color4` 是 (1, 1, 1, 1)，WPE 是上一个设过颜色的层（C 的黄、NC 的绿），`kbfx` 加了 `g_Color4 × 0.0001`；
  - 逐 draw 轨迹（`ignore/p5/j/trace-a/`）与 WPE 取像素核对：F1 之前逐位相同，差在 N 末 pass 之后出现；
  - 属于 P5b `p5b-fs` 起的已知差异。
- 语料：myprojects/`3814353826` 干净；全库 233 张全部干净、没有新增的键；`nested_par.py` 扫过语料，没有「组里套组合层又开视差」的场景，
  嵌套 compose 的更正不改现有画面。
