# P14b — 组里的模型对象（3816948983 锦鲤水景）

> P14（脚本自定义几何，`phase-14-model-data.md`）的后续：模型数据层经 `createLayer` + `setParent` 挂进组合层（组）。起因是创意工坊
> `3816948983`（myprojects，「一片清澈的林间水景」，pixi.js 网页移植成场景）。它先缺 BC7 纹理（`.tex` 格式 12，归 P11f，已提交 `82176594`，
> 生成工程与 WPE 整帧逐像素相同，数据在 `ignore/p11/f/`），之后整场冒烟发现两个问题：运行中报 `model:passthrough:children:model`，水面
> 整体偏亮偏青、上边与左边拉丝。本计划处理这两个问题。数据在 `ignore/p14/b/`（这张场景的解包副本仍用 `ignore/p11/f/proj/3816948983-kbp`），
> WPE 抓帧在 `A:\p14b\`，读码见 `rea-p14b-group-models.md`。

## 总体设计思路

两个问题是同一个根因。这张场景的控制器脚本用 `createModelData` + `createLayer` 建模型层（P14），再 `setParent` 挂进组合层（组）：
224×126 的高度场网格挂进 `height-copy`，把水面高度按 RG / BA 两个 16 位整数画进组的合成 RT；一部分锦鲤批次挂进 `rain-copy`。水面
effect 的第一个 pass 读这两张组 RT（`_rt_imageLayerComposite_10_a` / `_20_a`）。我们对「组里的模型」照报 `model:passthrough:children:model`
（P5b 当时语料 0 个、没有实测），运行中进组的对象按 L7 的规则「不画 + 看板娘提示」，组 RT 就是全透明的 0，水面算出来的偏移与光照全错。
2026-11-21 用临时开关（`// DEBUG-P11F`，已删）让探针照画组里的模型，100 帧回放后水面和 WPE 的观感一致，偏亮与拉丝都消失。

所以本步只做一件事：**组里的模型对象照 WPE 画**，不再照报。渲染器里这条路其实已经有了（强制渲染时组里的模型就按组的局部正交画进组
RT），缺的是和 WPE 对齐的三处细节与一次实测：
- **矩阵**：WPE 画网格时模型矩阵是 `M = 栈顶 · W`（`FUN_1402222a0` 的 `FUN_14005ecb0`），组画子树时栈顶是 `inverse(W_组)`、视图单位阵、
  投影是组尺寸的局部正交（rea-p5-modelflags §2.5）。所以组里网格的 MVP 要照图像层已有的 `groupMvpParts` 结合顺序
  （`P ⊗ (inverse(W_组) ⊗ W)`），`g_ModelMatrix` 按读码是 `inverse(W_组) ⊗ W`，由第 0 点抓帧定。
- **视锥剔除（有意不同，D1）**：WPE 用世界矩阵 `W`（场景空间）把包围盒变换成外接球，拿 `ctx+0xec0` 的平面测；平面只在场景绘制
  `FUN_14018aac0` 与两个视图函数里算（`FUN_1401849e0` 的全部调用方），组画子树的 `FUN_140207b50` / `FUN_1401ecb20` / `FUN_1401eca70` 都
  不重算。所以 WPE 里组里的模型照样按**场景相机的平面**测**场景空间的外接球**，可它画进的是组 RT、用的是组的局部正交：组在画面外、
  它的 RT 又被别的图层读时，模型被错剔、引用方读到全空。这是缺陷，`3816948983` 在 WPE 里水面是对的、不依赖它，语料里组里放模型的也只有
  这一张，所以不复现：组里的模型**不按场景相机剔除**，保持现在的写法（`modelCulled` 见组就返回 false），记成和 WPE 有意不同。按组自己的
  视锥剔掉的只会是画不进组 RT 的东西，和不剔的画面完全相同，所以也不另写一套。
- **深度**：组的合成 RT 不挂深度（rea-p5-mesh 3.1，格式 0x1b），深度状态不起作用；我们的组 RT 同样没有深度附件，管线按目标有无深度
  各建一份，不用改。`copybackground: false` 的组 alpha 取 MAX（§2.5）是设备状态，对网格同样生效，第 0 点实测确认。

关键决策：不新开渲染路径，复用强制渲染时已有的「组里模型」画法，只改矩阵与报键。组里模型的**投射阴影**也做、不照报（2026-11-21
用户定）：WPE 的阴影 pass 在顶层跳过组的子孙（`+0x120 & 2`），组本身在阴影 pass 里画不画子树、画的话用什么矩阵还没读码，第 0 点先读码
再实测，按结论改阴影投射者的取舍（点 4）。透视模型（`perspective: true`）照旧由 `model:passthrough:children:perspective` 报。

## 现状锚点

**a. 组里的模型照报**（`compile/features.ts:1124`）
```ts
export function groupChildIssues(layer: Pick<SceneLayer, …>): string[] {
  const keys: string[] = [];
  if (layer.fullscreen) keys.push("model:passthrough:children:fullscreen");
  if (layer.perspective || …) keys.push("model:passthrough:children:perspective");
  // sprite（P13c）也挂着 `model`：组里它的遮挡测试读哪张深度、画在哪没测，单独照报
  if (layer.sprite) keys.push("model:passthrough:children:sprite");
  else if (layer.model) keys.push("model:passthrough:children:model");   // 现状：组里的模型一律照报
  if (layer.shape) keys.push("model:passthrough:children:shape");
  return keys;
}
```
编译期并进 `unsupported`（整张退回）；运行中由宿主 `applyRestructure` / 探针 `createProbeLive` 的 `trackGroupIssues` 拿掉那个对象（`removeObject` + `groupHidden`）并提示。

**b. 网格的矩阵**（`render/scene.ts:5246`）
```ts
    if (step.kind === "mesh")
      // … 组里的模型照报，强制渲染时用组的局部正交
      return drawUniformValues({
        ...common, colorScale: 1,
        step: { role: "direct", inputs: step.inputs },
        layer: { ...layerState, color: [1, 1, 1], alpha: 1, size: layer.size },
        viewProjection: groupOrCompose ?? this.viewProjectionOf(layer, state, view, persp),   // 现状：先拼 VP = P·inverse(W_组)，再乘 W
      });
```
图像层（`step.kind === "draw"`）在组里已经用 `groupMvp`（`render/layout.ts:747` 的 `groupMvpParts`，P8 步骤 7）：
```ts
export function groupMvpParts(size, world): { projection: Mat4; inverse: Mat4 } | null {
  if (!invert(world)) return null;
  …
  return { projection: orthographic(-hw, hw, -hh, hh, GROUP_DEPTH, -GROUP_DEPTH), inverse: invertF32(world) };
}
```

**c. 视锥剔除**（`render/scene.ts:7062`）
```ts
  private modelCulled(layer, state, worlds, viewProjection): boolean {
    const model = layer.model;
    if (!model || layer.group != null) return false;   // 现状：组里不剔
    …
  }
```
调用处 `runOps` 的 `op.kind === "model"`（顶层与组画子树共用 `runLayer`），传的是 `this.view.viewProjection`。

**d. 阴影投射者**（`render/scene.ts:6418`）：`if (!this.shadowAtlas || !model?.castShadow) return [];`，不看是不是在组里。

## 点 0 — WPE 实测（读码已给出预测）

**新增** `ignore/p14/defs/p14b.py` 的组内模型工程（`kbp gen`，1920×1080，屏外宿主对 WPE 测试窗口整帧比）。网格用脚本 `createModelData`
建（同这张场景的写法，运行时路径），另做一份 scene.json 里静态 `parent` 指向组的 mdl 模型（编译期路径）：
- `p14b-gm-basic`：`copybackground: false` 的组（缩放、旋转、平移都不是单位），里面一个 translucent 网格与一个 normal 网格互相重叠：
  预测 alpha 取 MAX、颜色按各自混合；RenderDoc 读网格 draw 的 `g_ModelMatrix`、`g_ModelViewProjectionMatrix`，预测前者是 `inverse(W_组)·W`、
  后者逐位等于 `P ⊗ (inverse(W_组) ⊗ W)`。
- `p14b-gm-copybg`：同上，`copybackground: true`。
- `p14b-gm-depth`：两个网格材质开深度测试与写入、后画的在「后面」：预测组 RT 无深度，后画的盖住先画的。
- ~~`p14b-gm-cull`~~：D1 定为有意不同（组里不按场景相机剔除），不做。
- `p14b-gm-shadow`（阴影，先读码）：
  - 读码：阴影 pass（`FUN_14018aac0` 的阴影模式，`ctx+0x12eb == 0`）里组（组合层，图像对象 `vfunc+0x50`）画不画子树；画的话模型栈
    是不是 `inverse(W_组)`、视图投影是不是灯的；阴影多视图（`ctx+0x1c8`）下组里网格的逐视图剔除用的世界矩阵。顺带认出 `0x140196530` /
    `0x140196ce0`（`FUN_1401849e0` 的另两个调用方）。
  - 实测：一盏投阴影的平行光（再做一份点光），顶层一块接收阴影的地面模型，组里一个 `castshadow` 的网格悬在它上方；变体：组
    `copybackground` 开 / 关、组里网格 `castshadow: false`、同一个网格放在顶层作对照。RenderDoc 读 `_rt_shadowAtlas` 的投射 draw 数与内容、
    整帧比。
- 每份用 `capture_sweep` 抓 2 帧；`kbp rdc frame` 取整帧，矩阵读 `get_draw_call_details` / `get_buffer_contents`。

### 点 0 结果（2026-11-21）

生成器 `ignore/p14/b/gen_p14b.py`（复用 `ignore/p5/d0` 的骨架与 `mdl_enc`），工程在 `ignore/p14/b/proj/`，抓帧在 `A:\p14b\<工程>\`，WPE 日志
`ignore/p14/b/wpe-logs/`。脚本建的模型层在 WPE 里都 `setParent` 成功（`[kbp14b] … ok G`）。

| 工程 | 实测 | 和预测 |
|---|---|---|
| `gm-basic` | 静态 S1（事件 71）与脚本 T1（事件 97）：`g_ModelMatrix` 是相对组的局部矩阵，T1 的平移 y 是 19.999969…（真的乘了 `inverse(W_组)·W`，不是直接取局部）；`g_ViewProjectionMatrix` 是组的局部正交 `ortho(±400, ±300, ±1000)`、视图单位阵；`g_EyePosition` 仍是场景的 (960, 540, 2000)；MVP = `P ⊗ M`。`mulAffine(invertF32(W_组), W)` 与 `mulAffine(P, M)` 和抓帧 32 个分量逐位相同 | 成立 |
| `gm-basic` 的探针图像层 IMG（事件 84） | 组里的**图像层**同样是 `g_ModelMatrix` = 局部、`g_ViewProjectionMatrix` = P；我们给图像层的是世界矩阵与 `P·inverse(W_组)`（MVP 已对，P8 步骤 7） | 另记，见下 |
| `gm-depth` | 组里后画的 D2 / E2（z −100）盖住先画的 D1 / E1（z +100），顶层对照 C1 在前 | 成立：组 RT 没有深度 |
| `gm-shadow` | 阴影 pass 只有 3 个投射 draw：地面、顶层 CTRL、顶层脚本 CTRLS；组里的 GC、GS 没有；画面上组里两个立方体没有影子，光照按局部坐标算（更暗） | 成立 |
| `gm-shadow-cb` | 组 `copybackground: true`、组本身 `castshadow: true`：同样 3 个投射 draw | 成立 |

**另记（不在本步）**：组里图像层的 `g_ModelMatrix` / `g_ViewProjectionMatrix`（`layout.ts` 的 `groupMvpParts` 注释里「读码所得、没有抓帧验证」那一条）
现在有抓帧了：WPE 是局部矩阵与 P。只影响分开读这两个矩阵的着色器（光照、效果矩阵），效果矩阵的形状没测，留给用户定要不要另开一步。

## 点 1 — 不再照报（`compile/features.ts`）
- **修改** `groupChildIssues`
```ts
  // sprite（P13c）也挂着 `model`：组里它的遮挡测试读哪张深度、画在哪没测，单独照报
  if (layer.sprite) keys.push("model:passthrough:children:sprite");
  // 删除：`else if (layer.model) keys.push("model:passthrough:children:model")`。组里的模型（P14b）按组的局部正交画进组 RT、
  // 按场景相机剔除（rea-p14b-group-models 1–2 节），投射阴影按点 0 的结论（点 4）
```
- **修改** 文件头注释：删掉 `model:passthrough:children:model` 那一条。

## 点 2 — 网格矩阵照 WPE 的结合顺序（`render/scene.ts`）
- **修改** `step.kind === "mesh"` 分支：点 0 定了 `g_ModelMatrix` = `inverse(W_组) ⊗ W`、`g_ViewProjectionMatrix` = 局部正交 P，所以组里
  （`groupMvp` 非空）直接把模型矩阵换成局部的、视图投影换成 P，`direct` 角色的 MVP = `mulAffine(P, M)` 正好是图像层 `groupMvp` 的结合顺序。
```ts
    if (step.kind === "mesh")
      return drawUniformValues({
        ...common,
        ...(groupMvp ? { world: mulAffine(groupMvp.inverse, common.world) } : {}),            // 新增：组里的模型矩阵是局部的
        …
        viewProjection: groupMvp?.projection ?? groupOrCompose ?? this.viewProjectionOf(layer, state, view, persp),  // 修改
      });
```

## 点 3 — 组里的模型不按场景相机剔除（`render/scene.ts`，D1）
- 不改逻辑，只改 `modelCulled` 早退处的注释：说明 WPE 组里用场景相机平面测场景空间外接球是缺陷（组在画面外、RT 被读时错剔），
  不复现，见 `rea-p14b-group-models` 2 节。
```ts
  private modelCulled(layer, state, worlds, viewProjection): boolean {
    const model = layer.model;
    // 组里的模型画进组 RT、用组的局部正交，不按场景相机剔除。WPE 照样拿场景相机的平面测场景空间外接球（组画子树不重算平面），
    // 组在画面外而 RT 被别的图层读时会把模型错剔：缺陷，不复现（P14b D1）
    if (!model || layer.group != null) return false;
```

## 点 4 — 组里模型不投射阴影（`render/scene.ts`）
- 点 0 的结论是「组在阴影 pass 里不画子树」（rea-p14b-group-models 4 节 + `gm-shadow` 实测）。
- **修改** `encode`：投射者照旧按对象建（换父不重建），交给图集前按这一刻的组归属筛（WPE 每帧看 `0x2`，同样是动态的）：
```ts
    // 组的子孙不投射（P14b）……投射者按对象建、换父不重建，所以每帧按当前的组归属（`SceneLayer.group`，L7 换父后就是新值）筛
    if (this.shadowAtlas) this.shadowAtlas.encode(encoder, this.shadowCasters.filter((caster) => !this.casterInGroup(caster)));
```
- **新增** `casterInGroup(caster)`：`shadowCasterRecords` 取对象，`layerByObject.get(object)?.group != null`。
- 平面反射里组内图层照旧报 `reflection:planar:group`，不在本步。

## 点 4b — 组里读帧缓冲的模型（`render/graph.ts` 的 `planModelLayer`）
- P14 的 E16（模型读帧缓冲前拷快照）原来写着「模型在组里照报，不用管组的特例」。现在组里有模型了，照图像层的层首拷贝（P5f）：
  直接父是组时不拷（读到上一次拷下的内容，同 WPE），隔着分组节点的孙子照拷（拷组的合成 RT）。参数加可选的 `group` / `parent`。

## 点 5 — 测试
- `compile/features.test.ts` 或 `p5b` 相关测试：组里的模型（含 `castShadow`）不报，sprite 照旧。
- 渲染器单测（借 `render/p11b.test.ts` 的假设备，或新的 `render/p14b.test.ts`）：组里网格的 MVP 与图像层同一结合顺序；组里网格在
  场景视锥外照画（D1）；组里 `castShadow` 的网格的投射者按点 4（含运行中进组 / 出组）。
- 宿主 / 探针：运行中 `setParent` 把模型层挂进组，不再 `removeObject`（`host.l7` 一类测试加一条）。
- 变异：去掉 `group: groupMvp`、组里也按场景相机剔、恢复照报、投射者不随换父更新。

## 点 6 — 文档与回归
- `cocs/wpe/WPE_SCENE.md`：组（P5b）一节的不支持清单与「脚本自定义几何（P14）」里组内模型的说法；`cocs/README.md` 适用场景加「组里的
  模型（高度场、模型数据层）不画 / 水面读组 RT 全错」。
- `versions/latest/regression.md` 新节、`changelog.md` 一行（用户侧：3816948983 的水面）。

## 验证
- 单测、tsc、Prettier；`kbp regress --corpus --no-cases` 缺省语料不变；myprojects 扫一遍看 `model:passthrough:children:*` 的变化。
- 点 0 的生成工程在我们这边和 WPE 整帧逐像素相同。
- 最终走查（FINAL_CHECK）`3816948983`：`kbp content unpack --instrument` 得到带 FR 的复制工程，脚本里的 `Math.random` 换成固定种子的
  伪随机（两边跑同一份，锦鲤与涟漪才一致，待定 D3），WPE 抓几帧，`renderFrames.ts --scripts --timeline-log` 按日志回放，`kbp cmp frames`；
  另外用探针的 `trace.readback` 读 `height-copy` 组 RT 和 WPE 抓帧里同一张纹理逐像素比（不受锦鲤影响）。

## 已定（2026-11-21 用户）
- **D2 组里模型的投射阴影也做**，不报 `model:passthrough:children:shadow`（点 0 读码 + 实测，点 4 实现）。
- 本步归 P14（P14b），由做 P14 的会话接手。
- **D1 组里的模型不按场景相机剔除**：WPE 的做法在「组在画面外、组 RT 被别的图层读」时把模型错剔，是缺陷；`3816948983` 不依赖它，
  不复现，记为有意不同（点 3）。点 0 不做 `cull` 工程。
- **D3 走查时改写复制工程的 `Math.random`**：只改 `ignore/` 下的复制工程，换成固定种子的伪随机，WPE 与 Kabegame 跑同一份脚本。

## 执行记录（2026-11-21）

- 点 0：见上面「点 0 结果」，另加了 `p14b-gm-rot3d`（组与子层都带 x / y 旋转）：变异发现「局部矩阵用仿射乘法还是 glm 乘法」在只绕 z 轴时
  分不出来，读码 `FUN_14005ecb0` 是 glm 的完整乘法（我们的 `multiply`），`-rot3d` 抓帧确认 `multiply` 逐位相同、`mulAffine` 差 5 个分量。
- 点 1–4b 已实现（`compile/features.ts`、`render/scene.ts`、`render/graph.ts`）。
- 测试：`render/p14b.test.ts`（新，矩阵与 E16）、`render/p5b-group.test.ts`（GpuScene 组里网格的三个矩阵、三维旋转、画进组 RT、D1 不剔）、
  `render/p14-model-data.test.ts`（组里的投射者按当前组归属每帧筛）、`render/l7.test.ts`（模型层运行中进组 / 出组）、`compile/p5c.test.ts`（不再报）。
- 变异 8 / 8 检出（`ignore/p14/b/mutate.py`）；语料 233 / 233 逐场景相同（`ignore/p14/b/regress/`）。
- D3：`ignore/p14/b/seed_random.py` 把复制工程控制脚本的 16 处 `Math.random()` 换成 mulberry32（种子 20261121）；WPE 抓帧
  `A:\p14b\3816948983-kbp-fps20-1920x1080\`（第 312–314 帧，WPE fps 20、后处理 ultra），整帧 `ignore/p14/b/out/wpe-*.png`，`height-copy`
  组 RT（事件 90，224×126 高度场画进去之后）`ignore/p14/b/out/wpe-height-copy-f313-e90.png`。
- 真机（dev 用的是 `target-dev/`，宿主产物用 `buildSceneHost.ts --out-dir target-dev/debug/resources/wpe-scene` 换进去）：
  - PB3：`p14b-gm-basic` / `-copybg` / `-rot3d` / `-depth` 整帧 0 差异（除 FR / CLK），`-shadow` / `-shadow-cb` 各 3 个像素差 1；
  - PB4（FINAL_CHECK）：3816948983 复制工程按 WPE 日志回放到第 313 帧，32 个脚本建的层当帧同步装上、没有不支持项，两边都是 40 个 draw；
    整帧只有 37 个像素差 1；`height-copy` 组 RT（224×126）的 RGBA 和 WPE 抓帧逐位相同（`ignore/p14/b/out/trace-f313/pass-2.png`）。
  - 测试工程已 `projects_remove`。
- 待做：PB5（预览里看 3816948983 本体）给用户看。
