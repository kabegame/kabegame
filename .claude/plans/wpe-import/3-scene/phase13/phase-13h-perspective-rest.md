# P13h — 透视场景的余项（文本、组、透明排序下的体积光）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13h」与「决定」2。读码：[rea-p13-lights.md](rea-p13-lights.md) 第 5 节（透视余项），[../phase5/rea-p5-mesh.md](../phase5/rea-p5-mesh.md) 4.2（两遍绘制与半透明集合），[rea-p13-volumetrics.md](rea-p13-volumetrics.md) V5 / V8（体积光的合成时机）。实测：[p13-REPORT.md](p13-REPORT.md)「P13h 的实测」。

## 总体设计思路

P5d 实现透视相机与透明排序时照报了透视场景里没测过的几种用法。P13 做完前几节后，语料里只剩三个键和 P13h 有关：`camera:perspective:text`（4 张）、`camera:perspective:group`（1 张）、`volumetrics:transparentsorting`（2 张），`3453730450` 三个都有，`3509243656` 只差第一个。透明排序本身 P5d 已经做了（`render/sortOrder.ts`），这一节只补这三处，读码都已经回答了做法，步骤 0 用确定性工程和 WPE 整帧比来确认。

- **文本**：WPE 在非正交场景里、对象 `depthtest` 没写或不是 disabled 时，给字形、彩色字形、背景换成带 `_depth` 后缀的同名材质。它们和原材质只差 `depthtest` / `depthwrite` 是 enabled；材质是 translucent，按 P5d 的光栅规则只测不写。我们在编译期按同一条件换材质（`compile/texts.ts` 的 `TEXT_DEPTH_MATERIALS`），渲染图不用改：直接上屏、背景各用自己的 pass，带 effect 的合成路径上屏本来就借基础材质（字形 pass）的深度键，跟着一起对。`composelayer_clearalpha` 画进合成 RT（没有深度），不换。
- **组**：WPE 画组的子树时没有按场景类型的分支：透视场景里子层同样按 `inverse(W_组)`、单位视图、`ortho(±w/2, ±h/2, ±1000)` 压平进组的合成 RT；组自己的基础 pass 和上屏用场景相机，上屏的深度借基础材质（`composelayer_depthtest` 测、不写）。我们的组本来就是这样画的（P5b 的局部正交与 P5d 的统一光栅规则），只去掉照报。
- **透明排序下的体积光**：灯对象构造时就置半透明位（`obj+0x120` bit8，rea-p5-mesh 4.2），所以透明排序时灯不在第一遍，而是和别的半透明对象一起在第二遍按局部 origin 排序。体积光合成的判定（下一个可见的非灯对象之前、或列表末尾）在 `FUN_14018aac0` 的两遍循环里各有一份，末尾一份。我们原来按对象表下标把灯插进顶层序列；透明排序时改成把可见的体积光灯与顶层图层合成一个序列（原顺序是对象表顺序），灯的类别取 `translucent`，交给同一个 `transparentDrawOrder`，排完逐项画灯或画图层。

关键决策：
- 文本按「`depthtest` 不是 disabled」判定（WPE 是枚举下标为 0，缺键与 enabled 都是 0）；绑了属性登记成重编译，按生效值重选材质；正交场景不读这个键、不登记绑定。
- `trackGroupIssues` / `groupSelfIssues` 只为透视组用的 `general` 参数一并去掉（调用方 `host.ts`、`dev/probe.ts` 各一处）。
- 灯的排序键用灯对象自己的局部 origin（`SceneState.layers` 里的当前值，含属性与脚本的写入），和半透明图层同一个函数。

## 现状锚点

**a. 文本照报**（`compile/features.ts` 的 `perspectiveObjectIssues`）
```ts
if (isTextObject(object)) keys.push("camera:perspective:text");   // 现状：透视场景里的文本对象一律照报
```

**b. 组照报**（`compile/bundle.ts` 的 `compileOne`；运行中成组的 `script/structure.ts` 的 `groupSelfIssues`）
```ts
const hasChildren = layer.passthroughModel && parents.includes(index);
// 组的局部正交在透视场景里没测过（P5d 步骤 2），照报
if (hasChildren && bundle.general.perspective) unsupported.add("camera:perspective:group");
```

**c. 体积光照报**（`compile/bundle.ts`，编完体积光之后）
```ts
if (!orthographic && bundle.general.transparentSorting) unsupported.add("volumetrics:transparentsorting");
```

**d. 灯按对象表下标插进顶层**（`render/scene.ts` 的 `encode`）
```ts
const runTop = (runtime: LayerRuntime) => {
  lightsBefore(runtime.object);              // 现状：下标比这个图层小的灯先画
  if (visible.has(runtime.object)) composite();
  runLayer(runtime);
};
if (perspective && transparentSorting) {
  const top = topLayers.map((runtime) => runtime.layer);
  for (const layer of transparentDrawOrder(top, state, this.view.viewVectors.forward))
    runTop(this.runtimeByObject.get(layer.object)!);   // 现状：重排后仍按下标插灯（照报，走不到）
} else for (const layer of topLayers) runTop(layer);
```

## 步骤 0：确定性工程（2026-11-18）

生成：`ignore/p13/h/gen_h.py`（透视，基准相机 eye (0, 0, 10)）；抓帧 `A:\p13h\{text,group,vol,vol-off}\`（1920×1080，WPE 设置 volumetrics low、reflection 开）；WPE 后备缓冲 `ignore/p13/h/wpe/`，我们的 `ignore/p13/h/ours/`。

- **H1 `p13h-text`**：不透明墙 z = −4、红色不透明方块 z = 0 挡住四行文本的左半，文本都在 z = −1：T1 `depthtest: enabled`、T2 disabled、T3 带 tint effect（合成路径）、T4 不透明背景；绿色不透明方块 z = −2 排在文本之后、盖住右半。读码预测：T1 / T3 / T4 被红块挡住，T2 盖在红块上，绿块盖过全部文本（文本不写深度）。RenderDoc：T1 字形、T3 的合成上屏（tint 末 pass）、T4 背景的深度状态都是 `depth_enable, !depth_writes, GREATER`。**和 WPE 整帧 0 差**。
- **H2 `p13h-group`**：两个组，G1 `composelayer`（`copybackground` 缺省）、G2 `composelayer_depthtest` 绕 y 转 0.5 弧度、`copybackground: false`，各挂一个纯色图像层与一个文本。WPE 的绘制序列和正交时同一形状（快照 → 组基础 pass → 子层 → 上屏）。**和 WPE 整帧 0 差**。
- **H3 `p13h-vol`**（透明排序开）/ `p13h-vol-off`（关）：lightconfig point 2，对象表顺序 BACK、NEAR、PARENT、L2、MID、L1、FAR；L2 挂在 PARENT (0, 0, −3) 下、局部 origin (1.5, 0, 0)（局部键 0、世界键 3），MID 在 z = −2、盖在 L2 前。预测（灯在半透明集合、用局部键）：第二遍 FAR、L1、MID、L2、NEAR，合成在 MID 之前、NEAR 之前各一次；若用世界键，L2 会排在 MID 之前、只合成一次，MID 会盖住 L2 的光。画面上 MID 带着 L2 的光，**两个工程都和 WPE 整帧 0 差**。

## 实施

### 点 1 — 透视场景里的文本选 `_depth` 材质（`compile/texts.ts`、`compile/bundle.ts`）
- **新增** `TEXT_DEPTH_MATERIALS`（`basefont_depth` / `basefontrgba_depth` / `fontbackground_depth`）；`TextCompileContext.perspective?`。
- **修改** `compileText`：`perspective && read("depthtest") !== "disabled"` 时三个 pass 用 `_depth` 材质；`compileOne` 传 `perspective: bundle.general.perspective`。
```ts
const materials = ctx.perspective && read("depthtest") !== "disabled" ? TEXT_DEPTH_MATERIALS : TEXT_MATERIALS;
const glyphPass = await ctx.hostPass(materials.glyphs, `objects/${index}/text/glyphs`, [{ slot: 0, format: R8_FORMAT }], { text: true });
```

### 点 2 — 去掉三个照报键（`compile/features.ts`、`compile/bundle.ts`、`script/structure.ts`）
- **删除** `perspectiveObjectIssues` 的 `camera:perspective:text`、`compileOne` 的 `camera:perspective:group`、体积光的 `volumetrics:transparentsorting`、`groupSelfIssues` 的 `camera:perspective:group`。
- **修改** `groupSelfIssues(layer)`、`trackGroupIssues(tracked, result, layers)` 去掉 `general` 参数（`host.ts` 两处、`dev/probe.ts` 一处调用跟着改）。

### 点 3 — 透明排序下灯进第二遍（`render/scene.ts` 的 `encode`）
- **修改** 透明排序分支：顶层图层与可见的体积光灯按对象表顺序合成一个序列（灯 `sortClass: "translucent"`），交给 `transparentDrawOrder`；逐项画灯（`drawLight`）或画图层（可见时先合成）。末尾照旧 `composite()`。
```ts
type Item = { object: number; sortClass?: SortClass; runtime?: LayerRuntime };
const items: Item[] = topLayers.map((runtime) => ({ object: runtime.object, sortClass: runtime.layer.sortClass, runtime }));
for (const object of lightObjects) items.push({ object, sortClass: "translucent" });
items.sort((a, b) => (position.get(a.object) ?? Infinity) - (position.get(b.object) ?? Infinity));
for (const item of transparentDrawOrder(items, state, this.view.viewVectors.forward)) {
  if (!item.runtime) drawLight(item.object);
  else { if (visible.has(item.object)) composite(); runLayer(item.runtime); }
}
```

### 点 4 — 单测
- **新增** `compile/p13h.test.ts`：透视文本三种 `depthtest` 的材质、正交不换、带 effect 的字形换而 clearalpha 不换、透视组成组且不报。
- **修改** `compile/p5d2.test.ts`（文本、组不再报）、`script/structureRuntime.test.ts`（`groupSelfIssues` / `trackGroupIssues` 新签名）。

## 实施记录（2026-11-18）

- 按上面四点实现；tsc 通过，相关 8 个测试文件 178 个用例通过。
- 语料（`ignore/p13/h/corpus-{head,wt}.json`，233 张）：干净 197 → 199（`3453730450`、`3509243656`），只去掉三个键（text 4 张、transparentsorting 2 张、group 1 张），没有新增键。`3455121165` 还差聚光阴影，`3662790108` 还差 PRELIGHTING 与缺材质。
- 走查（FINAL_CHECK）：
  - `3453730450` 复制工程（`ignore/p13/h/walk/make_iso_3453.py`）：P13g 那一套加三段顶层文本、组 253 与组里三段时钟文本（脚本换成固定值）、体积光灯 39。抓 10 帧（`A:\p13h\walk3453\`，脚本帧 269–278），按日志回放：**10 帧整帧逐像素相同**，画面里文本、组、体积光都在。
  - `3509243656` 复制工程（`make_iso_3509.py`）：地球模型、顶层两段文本、左菜单组与四段文本（脚本换成固定值）。这张开 HDR，后备缓冲是 RGBA16F，`kbp cmp` 读不了 Present 的 DDS；按 sRGB 编码后就近取整（`dds_f16_to_png.py … srgb`）比 5 帧，每帧最大差 1、4 万个像素，全在泛光光晕的渐变上（WPE 的 f16 存储量化），文字处相同。
