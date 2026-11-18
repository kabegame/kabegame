# P5h：脚本 `layer.perspective` 与组合层 / 组的 perspective

> 起因（2026-11-19，wpe p6 d/e 的语料清扫转来，用户让转给 P5）：`3808922316`（工坊）只差 `script:api:layer.perspective`。它的
> `objects/181`（组合层「主题2 3D」）的 `visible` 字段脚本在 `init` 里写 `thisLayer.perspective = true`，并 `createLayer({ image: 组合层,
> perspective: true, … })` 建一个影子层。父分组 2075 写死不可见，所以这张场景里看不见效果，但建层时组合层 + `perspective` 会报
> `object:perspective`（L5：那个对象不画、看板娘提示），所以组合层 / 组的 `perspective` 也要一起做。

## 总体设计思路

`perspective` 是 WPE 图像层属性表（`FUN_1401ee520`，`0x1401ee9a4`）里的一项，读写对象标志 `+0x120` 的 bit7；文本层继承图像层的表，所以
**图像层（含组合层）与文本层**的脚本对象有这个键，粒子、分组节点没有（步骤 0 实测键序）。渲染每次画都现读这一位（`FUN_1401e8aa0`），
所以脚本写了**当帧生效**。我们把它做成运行时状态：`LayerState` 加 `perspective`（初值 = 编译期的 `layer.perspective`），脚本对象按
`solid` 那一套读写（读回布尔、只收布尔），渲染器取视图投影时读状态而不是编译期字段，光标命中同样读状态。

组合层与组加 `perspective`（步骤 0 实测）：组合层的 compose 基础 pass 仍用正交场景相机（它画进合成 RT），末 pass 与组的上屏换透视，
组里的子层仍用组的局部正交——正好是图像层现有的规则（「画到场景目标的绘制换透视」）。所以只要去掉编译期对「组合层 + perspective」
的照报，渲染器不用改。

关键决策：状态字段只给图像 / 文本层（和 WPE 的键一致）；组里的图层运行中改 `perspective` 仍按组的局部正交画（`groupChildIssues` 照报
JSON 写死的透视，运行中写入语料 0 处，记为已知差异）；反射名单（`reflection:planar:perspective`）照旧按编译期值判（运行中改语料 0 处）。

## 步骤 0 结果（2026-11-19）

工程 `ignore/p5/proj/p5h-a`（生成器 `ignore/p5/h/gen_h.py`），WPE 1920×1080：`A:\p5h\a\a-frame199/200.rdc`（帧号 200 / 201）、`A:\p5h\a2\`（键序）。

| 项 | 结果 |
|---|---|
| 读 | 总是布尔；JSON 没写时 false |
| 写 | 只收 JS 布尔；`1`、`0`、`'true'`、`''`、`null`、`undefined`、`{}`、`[1]`、`2.5`、`-1`、`'false'` 都**不写、不抛错**，保留原值 |
| 生效 | 当帧：`update` 里按帧号奇偶写，帧号 200（偶）这一帧 SP 的 MVP 是正交、201（奇）是透视 |
| 键 | 图像层、组合层：`…,castshadow,perspective,visible,…`；文本层同样有；粒子、分组节点**没有** `perspective`（`typeof` 为 undefined） |
| 组合层（无子层，带 effect） | compose 基础 pass（事件 62）MVP 是正交场景相机；末 pass（82）是透视 |
| 组（组合层带子层，无 effect） | 组的上屏（135）是透视；子层画在组的局部正交 |

键序全文见 `A:\p5h\a2` 那次的日志（本文件末尾附）。

## 现状锚点

```ts
// compile/bundle.ts（组合层）
    if (layer.passthroughModel) {
      // 组合层又 `perspective: true`：基础 pass 与上屏各用哪套相机没测过（语料 0 个），照报
      if (layer.perspective) unsupported.add("object:perspective");
```
```ts
// render/scene.ts：视图投影读编译期字段
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, !!layer.perspective && step.target.kind === "scene"),
// 文本、模型同样 `!!layer.perspective`；render/cursor.ts 的 pickable `perspective: layer.perspective`
```
```ts
// compile/scriptApi.ts：MISSING_SCRIPT_API 的 layer 字段 ["perspective", "rootmotion", "fov", "zoom"]
```

## 点 1 — 状态与脚本 API

- `render/state.ts`：`LayerState` 加 `perspective: boolean`（`fromBundle` 取 `layer.perspective`；运行时建层同取配置）；`SceneState.write` 的 layer 字段
  支持 `perspective`（同 `solid`：只认布尔），不标脏（渲染每次现读）。`compile/bindings.ts` 的 `LayerField` 加 `perspective`（若绑定 / 字段脚本
  已有落点就复用；JSON 绑属性、挂脚本仍由能力表照报，本步只开脚本 API）。
- `script/api.ts`：图像层（含组合层）与文本层的脚本对象加 `perspective` 键（不加到 `LAYER_FIELDS` 全体，粒子、分组节点没有），读回布尔、只收布尔，
  写进状态。键在对象上的位置照 WPE 键序放在 `castshadow` 之后、`visible` 之前（我们的键序若不是逐键对齐 WPE，就放在合理位置并在注释说明）。
- `compile/scriptApi.ts`：`MISSING_SCRIPT_API` 删 `perspective`，注释写 P5h。

## 点 2 — 渲染与命中读状态

- `render/scene.ts`：图像层、文本层、模型取视图投影时用状态里的 `perspective`（模型若没有状态字段就保持编译期值）；组里的图层不变（`groupVp` 优先）。
- `render/cursor.ts`：pickable 的 `perspective` 读状态。

## 点 3 — 组合层 / 组的 perspective

- `compile/bundle.ts`：删掉组合层 + `perspective` 的照报（`p5h-a` 实测：compose 基础 pass 正交、上屏透视，与现有规则一致）。相关注释、文档锚点更新。

## 点 4 — 测试

- 状态写入（布尔才收）、脚本对象读写（各类型）、键只在图像 / 文本层上、写入当帧生效（渲染 uniform 用状态值）、组合层 + perspective 不报、组合层计划里
  compose 用正交 / 末 pass 用透视。只跑相关测试文件。

## 验收

- tsc、相关测试、变异（写入不过滤类型、渲染读编译期值、组合层照报留着）。
- `p5h-a` 导入 dev，`render_scene`（跑脚本、按 WPE 帧号回放到 200 与 201）与 WPE 逐像素比；语料 `3808922316` 变干净。

## 附：键序（WPE 日志原文）

```
SP（图像层）alignment,colorBlendMode,ledsource,nointerpolation,castshadow,perspective,visible,brightness,alpha,color,copybackground,size,clampuvs,solid,name,parallaxDepth,sortorder,scale,angles,origin,disablepropagation,getChildren,…
TX（文本层）anchor,verticalalign,…,padding,backgroundbrightness,colorBlendMode,ledsource,nointerpolation,castshadow,perspective,visible,…
PT（粒子）instance,visible,solid,name,parallaxDepth,sortorder,scale,angles,origin,disablepropagation,…（无 perspective）
GN（分组节点）visible,solid,name,parallaxDepth,sortorder,scale,angles,origin,disablepropagation,…（无 perspective）
```

## 实施记录（2026-11-19）

执行代理（sonnet）按本计划实现，Claude 独立验收并补了三处。

**改动**（`apps/wpe-scene/src/`）
- `compile/bindings.ts`：`LayerField` 加 `perspective`，`bindingValue` 当布尔。
- `render/state.ts`：`LayerState.perspective?: boolean`（`undefined` = 取编译期值，所以 `layerStateOf` 不变）；`SceneState.write` 的 layer 分支收 `perspective`，**标这一个图层脏**（不带子孙）。
- `script/api.ts`：`installPerspective`，只装在图像层（`alignment` 有值或待编 `image`）与文本层上；读：状态 → 编译期值 → 待编对象配置里的 `perspective === true`；写：`write(…, "bool")`。
- `compile/scriptApi.ts`：`MISSING_SCRIPT_API` 删 `perspective`。
- `compile/bundle.ts`：删组合层 + `perspective` 的 `object:perspective`。
- `render/scene.ts`：`persp = layerState.perspective ?? !!layer.perspective`，文本、图像层上屏、预光照 `alt`、passthrough 上屏 4 处读它；`render/cursor.ts` 的 pickable 读状态。
- 测试：`script/api.test.ts`（读写与类型过滤、键在哪些对象上、只标一个图层脏）、`script/createLayerApi.test.ts`（待编对象读配置）、`render/p5b.test.ts`（写入当帧生效）、`render/p5b-compose.test.ts`（compose 正交、末 pass 透视）、`render/cursor.test.ts`、`compile/p5b.test.ts`、`compile/scriptApi.test.ts`。

**和计划不同**
- 计划写「不标脏，渲染每次现读」。不行：我们的 uniform 只在图层标脏时由 `GpuScene.sync` 重写，所以写入标该图层脏，当帧生效靠这一条。
- 键序没有逐键对齐 WPE 的 `castshadow,perspective,visible`，装在 `alignment` 之后（注释写明）。
- 验收时补：待编对象（`createLayer` 建出、还没编译）读配置里的 `perspective`（执行代理的版本读回 false）；`installPerspective` 的 JSDoc 插在了对齐的 JSDoc 与 `installAlignment` 之间，挪开；`LayerState` 注释与「标脏」对齐。

**验收**
- tsc 0 错；相关 16 个测试文件 540 通过。
- 变异（`ignore/p5/h/mutate_h.py`，工作区模式）8 处全部由本步的用例检出、还原逐字节一致：写入不过滤类型、渲染读编译期值、命中读编译期值、写入不标脏、组合层照报留着、所有图层都装键、缺口表仍列、待编对象不读配置。基线上 `compile/scriptApi.test.ts` 的两条本机语料用例（`KABEGAME_WPE_ROOT` 设了才跑）失败：断言 3304642534 还报 `createModelData` / `sortLayer`，实际已是 `[]`，是更早的步骤留下的过时断言，与本步无关、未改。
- 画面：`p5h-a` 跑脚本回放到第 199 帧（合成日志 `ignore/p5/h/p5h-a-synth-log-1920x1080.txt`，dt 0.05），对 WPE `a2-frame198.rdc` 的上屏帧整帧 0 差（屏蔽 FR / CLK）；脚本日志的读写结果与键序和步骤 0 一致。
- 语料：全库 233 张对 P5f 时的扫描，`3808922316` 变干净，新增的键 0；组合层 + `perspective: true` 语料 0 处（`3348595482` 去掉的 `object:perspective` 来自文本层，属 P5g）。
