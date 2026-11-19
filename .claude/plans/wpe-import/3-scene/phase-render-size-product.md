# 产品按画布分辨率画（方案 A）

> 2026-11-18 用户反馈 dino_run 的文字比 WPE 糊很多，选了方案 A（产品按窗口分辨率画，2026-11-19「好，那就用方案A」）。
> 2026-11-19 实测：预览放大到 223% 时，dino_run 的场景目标仍是 343×193、上屏画布仍是 1512×851，放大不会提高渲染分辨率。
> 前身：[phase-render-size.md](phase-render-size.md)（2026-11-14 只给 dev 探针做了「按指定尺寸画」，产品维持场景分辨率 + 上屏缩放）。WPE 读码见 [rea-render-size.md](rea-render-size.md)。

## 总体设计思路

产品（图库预览、桌面壁纸窗口、应用背景）的正交场景现在先画进一张场景分辨率的离屏目标，再在上屏时按壁纸样式缩放、裁切、留白（`scenePlacement`）。
场景分辨率比显示小时（dino_run 是 343×193，在预览和桌面上都放大四五倍显示），
图层边缘、按 300 DPI 栅格化的字形、effect 的细节都在这张小图里丢了，上屏再拉大就是糊的。WPE 没有这一步：它的场景目标就是窗口，
壁纸样式只改正交投影的四个边距 `ortho(E0, W − E2, E3, H − E1)`，窗口一变就重建按窗口大小分配的 RT、场景接着跑（`FUN_14017f1b0`）。

方案 A 让产品也这样画：**场景目标 = 画布像素，样式进投影，上屏 1:1 拷贝**。这套画法 dev 探针在 render-size 时已经实现并一直用于走查
（`GpuScene.build` 的 `target: { size, edges, clear }`、`alignEdges`、裁切后的 `P·V` 反投影光标），所以产品侧主要是接线；真正新做的是
**原地换尺寸**：画布像素会随预览窗口、侧栏开关、预览放大、DPR 变化，不能每次都整场重新加载（脚本、粒子、关键帧都会从头来）。
`GpuScene` 新增 `resize(target)`：重建按场景目标尺寸分配的资源（场景目标与交替目标、深度、快照、泛光链、反射两张 RT 与 mip 帧缓冲、
裁切遮罩、体积光缓冲、fullscreen 合成 RT），再用现成的 `rebuildLayer(…, { force: true })` 整层重建 draw 与绑定组（`g_Screen` 等静态
uniform 跟着重写），状态、粒子树、脚本、关键帧、puppet、计时器都不动——和 WPE 一样。透视场景现在「画布分辨率变了就整场重载」的
已知差异同时消失。

数据流变成：应用页量出显示缩放 → 宿主按「布局 × DPR × 显示缩放」定画布像素（不再封顶到布局 × DPR，改成像素预算）→ 渲染器去抖后
调 `GpuScene.resize`，去抖期间旧目标先拉伸上屏（放大手势不卡顿、不闪）→ 每帧按同一份边距画、反投影光标、给文本 `anchor`。

关键决策：
- **复用探针的 `target` 选项，不另写一套**：探针走查的结论（任意窗口尺寸与 WPE 逐像素一致）直接覆盖到产品画法上，`FINAL_CHECK.md`
  里「产品先按场景分辨率画再缩」这条已知差异连同 fit / center 的两处不同（越界内容被裁、留白底色）一起删掉。
- **原地换尺寸先做、单独验收**：判据是「建在 A、换到 B 再画」与「直接建在 B」逐字节相同（确定性探针），和产品接线解耦。
- **`tile` 保留旧画法**：WPE 没有平铺，投影表达不了，仍按场景分辨率画再平铺上屏。
- **居中的单位**照现在的产品：1 场景单位 = 1 布局 CSS 像素（WPE 是 1 个客户区像素、不看 DPI）。只影响 `center`，见「待定」。

## 现状锚点

**a. 渲染器加载：正交场景按场景尺寸建，透视场景按 `fullResolution`**（`render/renderer.ts:489-525`）
```ts
// 透视场景按画布尺寸渲染（P5d 步骤 2，已定 6）：场景目标取显示缩放为 1 的画布尺寸，铺放与指针按 `stretch`
const perspective = !!bundle.general.perspective;
const size: [number, number] | undefined = perspective ? [...this.fullResolution] : undefined; // 现状：正交场景不传 size
…
const scene = await GpuScene.build(this.gpu.device, bundle, state, this.gpu.features, this.warnings, {
  …
  size,            // 现状：产品从不传 `target`（只有探针传）
  …
});
```

**b. `GpuScene` 建场景目标**（`render/scene.ts:3156-3186`）
```ts
// 按指定尺寸画（dev 探针）：正交场景的场景目标 = 指定尺寸，超设备上限直接报错、不缩
const sized = !general.perspective && target ? target : null;
if (sized) { …; this.crop = { edges: sized.edges, window: [sized.size[0], sized.size[1]] }; this.targetClear = sized.clear; }
const [width, height] = sized ? [sized.size[0], sized.size[1]]
  : general.perspective ? sceneTargetSize(size?.[0] ?? 1920, size?.[1] ?? 1080, …)
  : sceneTargetSize(general.width, general.height, …);           // 现状：产品走这里，场景分辨率
this.width = width; this.height = height;
this.current = this.createSceneTarget("scene target");          // 现状：尺寸相关的资源只在建场景时建一次，没有换尺寸的入口
this.reflectionTargets = ReflectionTargets.create(device, bundle, width, height, hdr);
```

**c. 画布像素与透视场景的整场重载**（`render/renderer.ts:735-781`）
```ts
private resize(): void {
  const full = canvasSize(rect.width, rect.height, dpr, 1, max);
  this.fullResolution = [full.width, full.height];
  this.checkRenderSize();                                       // 现状：透视场景尺寸变了 300 ms 后 onRenderSizeChange
  const { width, height, pixelRatio } =
    this.displayScale === 1 ? full : canvasSize(rect.width, rect.height, dpr, this.displayScale, max);
  …
}
```
宿主（`host.ts:2074`）：`onRenderSizeChange: () => { if (this.rendererTask === task) void this.reload(); }` —— 现状：整场重新加载。

**d. 上屏铺放、光标、锚点按场景分辨率 + 铺放算**（`render/renderer.ts:803-830`、`881-890`）
```ts
private syncPlacement(scene: GpuScene): void {
  …
  this.placement = scenePlacement(style, scene.width, scene.height, this.canvas.width, this.canvas.height, ratio); // 现状：上屏缩放裁切留白
}
private cursorOf(placement, style, crop) {
  if (crop) return [pointer[0], pointer[1]];                     // 现状：只有 fill 且比例不同时走裁切反投影（P6c 修复 2）
  return sceneCursor(style, placement, …);                       // 其余按铺放反算
}
scene.setAnchorEdges(anchorEdgesFor(this.placementStyle, scene.width, scene.height, this.canvas.width, this.canvas.height, this.pixelRatio));
```

**e. 预览放大时画布封顶**（`apps/kabegame/src/components/wallpaper/wpeSceneStyle.ts:96`）
```ts
export function sceneDisplayScale(measured: number, zoom: number): number {
  return zoom > 1 ? Math.max(measured / zoom, Math.min(measured, 1)) : measured; // 现状：放大时画布最多到「布局 × DPR」
}
```
画布像素上限（`render/layout.ts:859` 的 `canvasSize`）：只按设备的 `maxTextureDimension2D` 等比缩，没有像素预算。

## 点 1 — `GpuScene` 原地换尺寸（`render/scene.ts`，可能拆出 `render/targets.ts`）

- **新增** `GpuScene.resize(next: { size: readonly [number, number]; edges: Edges | null; clear: readonly [number, number, number] | null }): void`
  ```ts
  /**
   * 换场景目标尺寸（WPE `FUN_14017f1b0`：只重建按窗口分配的 RT、改 g_Screen，场景接着跑）。状态、粒子树、脚本、关键帧、puppet、
   * 帧表计时器、视频播放器都不动。正交场景同时换投影边距与清屏色；透视场景只换尺寸（投影的宽高比随之变）。
   */
  resize(next): void {
    // 1. 释放并按新尺寸重建：场景目标（+ 交替目标，clearenabled: false 时新目标清成黑、同 WPE 重建后的内容【待步骤 0 实测】）、
    //    深度、快照、泛光链、反射两张 RT 与 mip 帧缓冲、裁切遮罩、体积光缓冲；targetBytes 重算
    // 2. this.width / height / crop / targetClear 换新；视图投影重算（setCamera 的缓存清掉）
    // 3. 全部图层 rebuildLayer(…, { force: true })：fullscreen 合成 RT、读快照 / 反射 / mip 帧缓冲的绑定组、g_Screen 等静态 uniform 跟着重建
    // 4. 管线不变（格式不变），不重新预热、不重跑 init
  }
  ```
- **修改** `populate`：把「按尺寸建资源」收成一个函数，建场景与 `resize` 共用（同一份代码，保证「建在 B」和「换到 B」一致）。

## 点 2 — 渲染器按画布像素画（`render/renderer.ts`、`render/layout.ts`）

- **修改** `load`：正交场景、样式不是 `tile` 时传 `target`：
  ```ts
  const target = this.canvasTarget(bundle.general); // 新增：{ size: 画布像素, edges: alignEdges(ALIGNMENT_OF_STYLE[style], W, H, 画布 CSS 宽高), clear }
  const scene = await GpuScene.build(…, { …, size: perspective ? canvasPixels : undefined, target }); // 修改：透视场景的 size 也取画布像素（含显示缩放）
  ```
  - 边距用画布的 **CSS 尺寸**算（画布像素 / pixelRatio），场景目标用画布像素：fill / fit / stretch 只看宽高比，不受影响；`center` 保持
    「1 场景单位 = 1 布局 CSS 像素」（见待定 2）。
  - `clear`：fit / center 时取 `schemecolor`（`clearsWithSchemeColor`），同探针。
- **修改** 上屏：`target` 尺寸等于画布时 1:1 拷贝；去抖期间（尺寸已变、还没 `resize`）把旧目标拉伸到整块画布。`tile` 照旧。
- **修改** `resize` / `checkRenderSize`：画布像素（含显示缩放）和场景目标不同、稳定 `RENDER_SIZE_SETTLE_MS`（现在 300 ms，待定 4）后调
  `scene.resize(…)`，**不再**调 `onRenderSizeChange` 整场重载；正交与透视同一条路。
- **修改** 样式或 DPR 变了：边距 / 清屏色变化走同一个 `scene.resize`（尺寸不变时只换边距与清屏色，不重建 RT）。
- **修改** 光标：正交非 `tile` 一律按裁切后的 `P·V` 反投影窗口坐标（探针同款，`pointerScenePoint`），`sceneCursor` 只留给 `tile`。
- **修改** 文本 `anchor`：边距直接取投影用的那份（和 WPE 完全相同）；`anchorEdgesFor` 只留给 `tile`（为 0）。
- **删除** 宿主 `onRenderSizeChange` 的整场重载（`host.ts:2074`）与选项本身。

## 点 3 — 画布像素随显示放大（`apps/kabegame/.../wpeSceneStyle.ts`、`WpeSceneView.vue`、`render/layout.ts`）

- **修改** `sceneDisplayScale`：不再封顶到布局 × DPR，放大多少画布就跟到多少，由像素预算兜住：
  ```ts
  export function sceneDisplayScale(measured: number): number { return measured; } // 修改：预算在宿主的 canvasSize 里
  ```
- **修改** `canvasSize`：除设备上限外加像素预算（待定 3，推荐 3840×2160 = 829 万像素），超了等比缩；桌面窗口不受预算（按窗口像素，
  只受设备上限）。
- 预览、桌面、应用背景三处取同一套规则；应用背景暂停时也按画布像素画（只画一帧）。

## 点 4 — 文档与走查

- `cocs/wpe/WPE_SCENE.md`：「铺放与帧循环」「预览画布尺寸」「透视相机」（去掉整场重载的已知差异）、「文本 anchor」（去掉 fit / center 的差异）、
  render-size 一节的「产品不变」改成方案 A；`cocs/README.md` 对应条目。
- `FINAL_CHECK.md`：删掉「按窗口分辨率画（不计入走查）」里关于产品的那段；产品画法 = 探针画法。
- 回归、真机：dino_run 预览与桌面和 WPE 窗口截图对照；4K 桌面的帧时间。

## 分步

0. **调研与测量**（Claude）：
   - 列全按场景目标尺寸分配的资源与引用它们的绑定（读码，逐个对 `this.width` / `this.height`、`ReflectionTargets`、体积光、裁切遮罩）；
   - WPE 换窗口尺寸后 RT 的内容（清不清、`clearenabled: false` 的累加画面怎样）、粒子与时间是否连续（wpe-renderdoc 测试窗口改尺寸前后抓帧）；
   - 成本：用探针按 1920×1080 / 2560×1440 / 3840×2160 画语料里最重的十几张（HDR 泛光、体积光、粒子多的），记帧时间与目标显存，定预算。
1. 点 1（原地换尺寸）：执行代理实现，验收「建 A 换 B」=「建 B」全语料逐字节（探针，正交与透视各一组尺寸），之后每帧仍相同；提交。
2. 点 2（渲染器接线）：真机预览、桌面、应用背景；光标与 anchor 对 WPE；提交。
3. 点 3（放大与预算）：预览放大后变清楚、像素预算生效；提交。
4. 点 4（文档、走查、回归）；提交。

## 验收

- 单测：点 1 的等价性（假设备上「建 A 换 B」与「建 B」的资源、绑定、uniform 字节相同）、`canvasSize` 预算、光标反投影、`sceneDisplayScale`。
- 探针全语料：「建 A 换 B」=「建 B」逐字节；正交场景按产品画法（target）与探针现有画法逐字节相同（同一条路）。
- 真机：dino_run 在预览（100% / 放大）与桌面上和 WPE 同尺寸窗口截图逐像素比（文字区域）；改窗口尺寸、开关侧栏、放大缩小时场景不重来
  （脚本状态、粒子、关键帧连续）、画面不闪；fit / center 的留白与越界内容同 WPE。
- 性能：4K 桌面上重场景的帧时间在预算内（数值步骤 0 定）。

## 待定（要用户定）

1. **2026-11-14 桌面那次的问题是什么？**（当时「桌面确实有点问题，还是改成和预览一样」，计划里没记原因）方案 A 会让桌面重新按窗口尺寸画，
   要先知道当时卡在哪（卡顿 / 显存 / 画面不对 / 别的）。
2. **`center` 的单位**：推荐保持现在的「1 场景单位 = 1 布局 CSS 像素」（预览与桌面构图一致、和现在相同）；照 WPE 则是 1 个物理像素，
   在 150% 缩放的屏上场景会显示得更小。
3. **像素预算**：推荐预览与应用背景不超过 3840×2160 等量像素（放大到这以后再放大只是拉伸），桌面按窗口实际像素、只受设备上限。
4. **去抖时长**：推荐沿用 300 ms；期间旧画面拉伸显示。
5. **`tile`**：推荐保留旧画法（WPE 没有平铺）。

## 步骤 0 记录（2026-11-19）

**按场景目标尺寸分配的资源**（读码，`render/scene.ts`；都经 `this.own()` 登记、场景销毁时才释放，`resize` 要主动释放并从登记里摘掉）：
- 场景级：场景目标 `current`（`createSceneTarget`，3185）与交替目标 `alternate`（`createAlternateTarget` / `addAlternateTarget`，5207–5222，
  只在 `clearVariable` 时）；深度 `depthTarget`（`createDepthTarget`，3230）；快照 `_rt_FullFrameBuffer`（`ensureSnapshot`，2309）；
  `ReflectionTargets`（`_rt_Reflection` 与 mip 帧缓冲，3193，mip 数随尺寸变）；泛光链 `BloomChain.create`（3302，`source` 是快照视图）；
  体积光 `VolumetricsRenderer.create`（3319，绑深度纹理与阴影图集）；puppet 裁切遮罩 `clipMask`（`clipMaskSize` = 目标一半，3099）；
  sprite 计数目标 `spriteCountTarget`（5458）；`linearBase`（缓存着快照视图的绑定组，5240 一带）。
- 随目标尺寸算的 CPU 值：`this.width / height`；`this.crop`、`targetClear`（3168）；`uniformValues` 的 `screenSize`（`g_Screen` /
  `g_TexelSize`，4485，写进每个 draw 的静态块）；sprite 的 k 用 `height²`（5421）；`targetBytes`；计划 `planOf` / `variantPlans` 带
  `[width, height]`（fullscreen 图层的合成 RT 尺寸 `compositeSizeOf(layer, sceneSize)`，2771），fbo 池按尺寸取。
- 现成可借的模式：文本层与槽 0 用户纹理图层的「独占合成 RT 原地换尺寸」（`ownsSizing` / `ensureUserSizing`）与 `rebuildLayer(…, { force: true })`。
- 渲染器：上屏绑定组按视图缓存（`blitBindGroups`），目标换了要清；透视相机的宽高比随画布。
- 阴影图集与目标尺寸无关（按灯打包）。

**WPE 换窗口尺寸**（rea-render-size「resize」节，读码）：`WM_SIZE` → `FUN_14017f1b0` 改 `g_Screen` 尺寸（下限 2，`WM_SIZE` 给下限 8）、
设视口、重建 RT 与泛光三角形，场景不重载；`engine.screenResolution` 读的也是它。新 RT 里的初始内容没测（MCP 没有运行中改测试窗口尺寸的工具，
记 `TODO:[WPE_SCENE_MCP]`）。

**语料**（`kbp content grep --pkg`，233 张）：`clearenabled: false` 0 张（换尺寸后累加画面怎样没有画面依赖，新目标清成透明黑）；导出
`resizeScreen` 0 张（它仍在 `MISSING_SCRIPT_CALLBACKS`）；读 `engine.screenResolution` 3 张（3509243656、3662790108、3706286085）。
`screenResolution` 照旧取「显示缩放为 1」的画布像素（预览放大不改它），和现在的产品相同。

**成本**（`ignore/render-size-a/step0/cost.mjs`，探针 `profile` 20 帧 = 编码 + 提交 + 等 GPU 完成，ultra 档；均值 ms）：

| 场景 | 场景分辨率 | 1920×1080 | 2560×1440 | 3840×2160 |
|---|---|---|---|---|
| dino_run（343×193） | 4.5 | 5.6 | 6.2 | 7.8 |
| beach / techno / audiophile（1080p） | 4.1 / 4.6 / 4.9 | 3.8 / 5.4 / 4.6 | 3.8 / 5.9 / 5.2 | 3.9 / 7.0 / 5.8 |
| 3455121165 / 3453730450（体积光，1080p） | 9.2 / 7.9 | 8.4 / 7.6 | 9.1 / 9.6 | 11.0 / 10.2 |
| razer_bedroom（4K，HDR 泛光） | 9.5 | 6.5 | 7.2 | 9.1 |
| 3287715210（4K，阴影 + 体积光） | 12.7 | 6.4 | 10.9 | 15.0 |
| 2833017810（4K，泛光） | 13.9 | 14.8 | 6.7 | 10.9 |
| 3286859278（4K，流体） | 25.4 | 23.1 | 25.4 | 27.7 |
| 3706286085（puppet） | 29.0 | 26.7 | 25.2 | 30.3 |
| 3253330537（4K，显存最大） | 35.4 | 33.4 | 33.6 | 31.7 |
| 2887099508（6080×3420） | 23.4 | 20.1 | 17.8 | 20.9 |
| 3815289650（8192×4608） | 10.5 | 9.7 | 8.6 | 11.7 |

到 4K 时多数场景只多 1–3 ms，重场景的瓶颈不在像素数；原生 4K 以上的场景在 1080p 下更省（显存 2887099508 730 → 402 MiB）。像素预算按已定的 4K 等量。

## 已定（2026-11-19 用户：「我记得11-14那次没有你说的这些问题，就是计算逻辑上感觉有点复杂，可能就是tile的问题。可以开始」）

1. 11-14 桌面改回去不是因为性能或画面，是计算逻辑复杂（多半是 `tile`）。方案 A 里 `tile` 保留旧画法，绕开。
2. `center` 保持「1 场景单位 = 1 布局 CSS 像素」。
3. 像素预算：预览与应用背景不超过 3840×2160 等量像素；桌面按窗口实际像素、只受设备上限。
4. 去抖沿用 300 ms，期间旧画面拉伸显示。
5. `tile` 保留旧画法。

## 实施记录

- **第 1 步：原地换尺寸**（2026-11-19，sonnet 执行代理在 `ignore/p6/d1/wt` 实现，Claude 复核）：
  - **改动**：`render/scene.ts` 新增 `resize(next, state): Promise<void>`（多次调用串行）。新资源先在旁边建好（`targetPlan` 与 `populate` 共用；
    `createSceneTarget` / `createAlternateTarget` / `createDepthTarget` 收尺寸参数，拆出 `createSnapshot`、`createClipMask`、`createSpriteTarget`；
    泛光与体积光建在新的快照 / 深度上，各自登记到 `bloomOwned` / `volumetricsOwned` 以便整批释放），再在一次同步调用里换上：记账、释放旧的、
    `applyCrop`（重算两份基准投影）、透视场景换初始相机、全部图层 `rebuildLayer(…, { force: true, syncPipelines: true })`，fullscreen 图层的借用合成 RT
    与 fbo 由 `resizeBorrowed` 换（`unique` fbo 的池键不含尺寸，原地换），共享合成 RT 池里不再被借的旧尺寸条目释放。只换边距 / 清屏色时只
    `applyCrop` + `setParallax`，不建 RT。`dev/probe.ts` 的 `renderFrame` 加 `resizeFrom`。新增 `render/resize.test.ts`（12 例）。
  - **与计划不同**：`resize` 是 async（泛光链与体积光要建管线），但换的那一刻同步，等待期间照旧画旧尺寸——渲染器接线（第 2 步）就用这个去抖期间拉伸旧画面。
    多了 `state` 参数。
  - **代理补出的清单项**：`unique` fbo 池键不含尺寸；共享合成 RT 池只增不减会随拖窗口泄漏；`basePerspectiveViewProjection` 也要随裁切重算。
  - **复核**：改动只在声明的 3 个文件；12 个文件 293 条通过、tsc 0 错误；变异 10 处全部抓到（`ignore/render-size-a/step1/mutate1.py`）；合并进主工作区、
    重建宿主后全库探针对比 285 张 1116 组「建 A 换 B」=「建 B」逐字节相同（`ignore/render-size-a/step1/equiv.mjs`）。
  - **留给第 2 步**：正交场景带相机对象时 `applyCrop` 只更新基准，视图投影要渲染器下一帧按新裁切交；透视场景依赖渲染器每帧 `setCamera`。
    `rebuildLayer` 中途抛错时场景已是新尺寸，调用方整场重载兜底。
  - 提交 `59ee7e06`。
- **第 2 步：渲染器接线**（2026-11-19，sonnet 执行代理实现，Claude 复核）：
  - **改动**：`render/renderer.ts`：`desiredTarget`（透视：画布像素；正交非 `tile`：画布像素 + `alignEdges(对齐方式, 场景宽高, 画布像素 / pixelRatio)` +
    `clearsWithSchemeColor` 时的 `background`；`tile`：场景分辨率、`edges: null`），`load` 按它传 `target` / `size`；`syncTarget` / `startResize` 状态机
    （`requested` 交给场景的、`applied` 兑现后换上的；尺寸变了去抖 300 ms，只换边距 / 清屏色或在画布画法与 `tile` 之间切换立即；失败置 `resizeBroken`、
    经新选项 `onResizeFailed` 交宿主整场重载）；`placementStyle` 按已换上的目标：按画布画时 `stretch`；光标去掉 `cursorCropOf` 分支（`GpuScene` 有 `crop`
    时自己用裁过的投影）、不再 `setCursorCrop` / `setAnchorEdges`；`sceneCameraFrame` 带 `crop`（正交相机对象按新边距）。删掉 `checkRenderSize` /
    `renderSize` / `onRenderSizeChange`。`host.ts` 换成 `onResizeFailed`。新增 `render/productSize.test.ts`（20 例），改了 `p5d-camera`、`p5d3-camera`、
    `parallax`、`particles`、`host` 测试里按旧画法写的期望。
  - **代理拿不准、Claude 定的**：光标命中的 `window` 保持「显示缩放为 1」（`input.cursorScreenPosition` 与 `engine.screenResolution` 同量纲，透视覆盖只取宽高比）；
    `tile` 与画布画法之间切换立即换；resize 失败到宿主重载之间不停帧（只是不再换尺寸）。
  - **复核**：改动只在 8 个文件；19 个文件 645 条通过、tsc 0 错误；变异 9 处全部抓到（`ignore/render-size-a/step2/mutate2.py`）；合并进主工作区、重建宿主后真机：
    dino_run 预览场景目标 = 画布像素（976×549），开侧栏原地换到 696×392、没有整场重载；eagleflag 产品画面与探针逐字节相同。
  - `fillCropEdges` / `anchorEdgesFor` 渲染器不再用，只剩探针旧画法与 `replayPointers`，第 4 步写文档时注明。
  - 提交 `1d8eef6d`。
- **第 3 步：预览放大与像素预算**（2026-11-19，sonnet 执行代理实现，Claude 复核）：
  - **改动**（`apps/kabegame/src/components/wallpaper/`）：`wpeSceneStyle.ts` 新增 `SCENE_CANVAS_PIXEL_BUDGET = 3840 × 2160`，`sceneDisplayScale(measured,
    { layout, dpr, budget })` 不再按放大倍数封顶，给了预算时 `min(measured, √(budget / (布局宽 × 布局高 × DPR²)))`，预算为 null 原样；`WpeSceneView.vue`
    按 `WINDOW_KIND`（URL `?window=wallpaper`）壁纸窗口不给预算、主窗口给；`WALLPAPER_PREVIEW_ZOOM` 保留给「zoom 变了下一帧补报」。测试改了按旧封顶写的用例。
  - 宿主侧不改（`canvasSize` 仍只按设备纹理上限兜底）。
  - **复核**：只改了 4 个文件；4 个文件 79 条通过、`vue-tsc` 0 错误；变异 4 处全部检出（`kbp mutate` 只认场景宿主源码，应用页用 `ignore/render-size-a/step3/mutate_app.py`）；
    合并进主工作区（HMR）后真机：dino_run 预览 100% 976×549 → 223% 2172×1222 → 1000% 3839×2160（停在预算），不重编译。

## 风险

1. **性能**：小场景在大屏上开销成倍增加（dino_run 343×193 → 3840×2160 是 125 倍像素）；重 effect / HDR 泛光 / 体积光的场景在 4K 上可能掉帧。
   WPE 同样按窗口画，量级可比，但我们的 WebGPU + Tint 不一定和它一样快。步骤 0 先量。
2. **原地换尺寸漏资源**：哪个按尺寸分配的 RT 没重建，换尺寸后画面就错（尺寸不对或读到旧内容）。用「建 A 换 B」=「建 B」全语料兜。
3. **`clearenabled: false` 的场景**：累加画面在换尺寸后要从头累加，WPE 的行为步骤 0 实测后照做。
4. **用户纹理、视频、文本图集**：和目标尺寸无关，但强制重建图层时要确认不触发重新解码、不丢视频播放位置。
