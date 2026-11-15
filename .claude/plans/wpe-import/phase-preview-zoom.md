# 步骤 3：预览里的网页 / 场景壁纸像图片一样放大

> 2026-11-15 批准。前置：[phase-preview-pointer.md](phase-preview-pointer.md)（步骤 1、2）。实施记录写在文末。

## 背景

步骤 1、2（覆盖层 + Rust 直接注入鼠标，`e68bb299`）是给放大铺路。用户最初的要求：「放大的意思是和图片一样能放大，之后我想给视频也接入这种放大」。

第一稿计划的反馈（2026-11-15）：
- 单独滚动滚轮不缩放，只有 Ctrl+滚轮缩放，同图片。
- 工具条现在是右键菜单的映射。当初那样做，是因为在 iframe 上右键用不了；现在右键能用了，工具条改成和图片一样。
- 左键拖动也平移，即使和壁纸交互冲突。只有 Ctrl+左键不平移，留给用户和壁纸交互。拖动中途松开 Ctrl，就接着平移。
- 设封面时不复位：放大后截到的就是看得见的那一块，用户可以借此定制封面。

视频放大不在本步。

## 总体设计思路

**和图片共用同一个 Panzoom 实例。**
- `ImagePreviewDialog` 里只有一个 `usePanzoomPreview`。图片分支和壁纸分支互斥（`v-if`），所以壁纸分支只要在包住画布的那层 div 上也挂 `ref="panzoomWrapperRef"`；composable 发现元素换了就重建实例。
- 下面这些都直接沿用图片的代码：
  - 工具条：−、+、滑块、百分比、全屏；
  - Ctrl+滚轮缩放，单独滚轮在放大后平移（`handleWheel`）；
  - 抽屉开关、拖宽、全屏、容器尺寸变化时复位；
  - 交互期间通知上层暂停后台加载。
- 壁纸分支要改的只有三处：
  - 预览容器的滚轮不再跳过壁纸，只跳过视频；
  - 换到另一张壁纸时复位，因为画布元素没换、实例还在；
  - 平移的起止由覆盖层决定（见下）。
- 工具条上右键菜单的映射（`wallpaperBarActions`）整个删掉。暂停、设封面、清空脚本存储都还在右键菜单里，暂停另外在预览设置面板里也有。

**覆盖层从画布里抽出来，放到 Panzoom 变换层外面，由它决定什么时候平移。**

为什么要抽出来：
- Panzoom 自己把 `pointerdown` 挂在被变换的元素上，任何按键、包括右键，都会开始平移，按下的那一刻就定了，没法做到「Ctrl+左键不平移、中途松开 Ctrl 再平移」。
- 覆盖层原来在画布根里，也会跟着放大。
- 抽成新组件 `WallpaperPointerOverlay.vue` 后，它和 Panzoom 层是兄弟、盖在上面、不跟着变换，Panzoom 自己的绑定碰不到它上面的事件。

平移的开始和结束都经 composable 新增的两个函数，也就是 Panzoom 公开的 `handleDown` / `handleUp`。平移过程中的移动由 Panzoom 挂在 `document` 上的监听处理，不另写拖动逻辑：
- `startPan(event)`：返回是否真的开始了，没放大时不开始；
- `endPan(event)`。

各个按键：
- **左键**：按下时，如果能平移就捕获指针。之后每次移动都看事件的 `ctrlKey`：没按 Ctrl 而还没在平移，就从这一点开始平移；按着 Ctrl 而正在平移，就停下。所以：
  - 按着 Ctrl 按下左键时不平移；
  - 途中松开 Ctrl，从当时的位置接着平移；
  - 途中再按下 Ctrl，平移又停下。

  只看移动事件上的修饰键，不监听键盘：拖动期间注入的点击可能把焦点切进了 iframe，`keepFocusOutOfFrames` 要等左键松开才还焦点，这段时间父页面收不到按键。光松开 Ctrl、不动鼠标时，下一次移动才开始平移，实际效果一样。左键同时照常注入进壁纸，冲突是接受的。
- **中键**：阻止默认（中键自动滚动），能平移就平移，不看 Ctrl。
- **右键**：不处理，冒泡到预览容器弹菜单。
- **滚轮**：冒泡到预览容器，走图片那套。
- **光标**：能平移时 `grab`，平移中 `grabbing`。

注入不受影响：`ConvertPointFromView` 用的是合成器的命中测试变换，本来就算进了父页面的缩放与平移。

**场景画布的分辨率跟着放大，到「布局 × DPR」为止。**

宿主的画布像素 = 布局 × DPR × 显示缩放。显示缩放由 `WpeSceneView` 用「`getBoundingClientRect` ÷ 布局」量出来，已经含了 Panzoom 的 `scale`。照原样上报的话，放大 10 倍画布就是 10 倍，但场景目标没有那么高的分辨率：
- 正交场景按场景分辨率画；
- 透视场景按布局 × DPR 画，见 `renderer.resize` 的 `full`。

所以上报值改为：

`sceneDisplayScale(实测, zoom) = zoom > 1 ? max(实测 ÷ zoom, min(实测, 1)) : 实测`

- 放大时画布跟着变大，最多到显示缩放 1；
- 没放大时本来就超过 1 的（小场景在大窗口里被放大显示）保持原值；
- zoom 为 1 时结果就是实测值，桌面和应用背景一点不变。

zoom 的来源：预览弹窗把 `panzoomScale` 传给 `WallpaperPreviewCanvas`，画布 `provide`，`WpeSceneView` 去 `inject`。桌面和应用背景没有提供方，按 1。

上报时机：祖先 transform 一变，现有的 250 ms 轮询本来就会补报；zoom 变了时再在下一帧合并补报一次（Panzoom 也是在 rAF 里写 transform），放大后不用等 250 ms 才变清楚。

宿主不用改：透视场景「分辨率变了就整场重载」看的是 `full`（显示缩放取 1），只改显示缩放不会触发重载。

**网页壁纸不做额外处理。** iframe 内容由 Chromium 按变换栅格化；页面自己的 canvas（比如 WebGL）分辨率是页面按 DPR 定的，放大后由浏览器拉伸，和放大一张图一样。这一项实测时看清晰度，记进文档。

**设封面：截看得见的那一块。**
- 不复位。截取区域 = 画布矩形 ∩ 壁纸视口（`.preview-wallpaper-wrapper`，也就是 Panzoom 的父元素，被它设成 `overflow: hidden`）。
- 没放大时画布就在视口里，结果和现在一样。
- 放大后：
  - 只截视口里那一块，宽高比跟视口走；
  - 不会截进侧栏（侧栏不在预览容器里，截图时不隐藏）。后端只按整张截图钳制，不知道侧栏在哪，所以这一步必须在前端做；
  - 场景画布此时分辨率更高，封面更清楚。

## 现状锚点

**a. 壁纸分支不走 Panzoom，工具条是右键菜单的映射**（`ImagePreviewDialog.vue:254-334`、`:1235-1253`）
```vue
<!-- 非视频 WPE 壁纸（web / scene）：……不走 Panzoom，也不挂 VideoControls -->
<div v-if="previewImage && isPreviewWallpaper" class="preview-wallpaper-wrapper absolute inset-0">
  <WallpaperPreviewCanvas ref="wallpaperCanvasRef" :content-size="previewWallpaperSize">
    <ImageContent … interactive @wallpaper-contextmenu="openPreviewContextMenuAt" />
  </WallpaperPreviewCanvas>
</div>
<div v-if="previewImage && isPreviewStatic" ref="panzoomWrapperRef" class="panzoom-wrapper">…</div>
<PreviewControlBar v-if="previewImage && !isPreviewVideo" …>
  <!-- 缩放只对 Panzoom 图片有意义；壁纸画布只保留全屏 -->
  <template v-if="isPreviewStatic"> −、+、PreviewRangeSlider、百分比 </template>
  <!-- 壁纸的右键菜单项按原顺序平铺成图标按钮 -->
  <template v-if="isPreviewWallpaper && wallpaperBarActions.length > 0"> … </template>
  <!-- 控制条定宽左对齐：普通图片靠缩放滑块撑开，壁纸没有弹性项，靠 ml-auto 贴到最右 -->
  <button class="control-btn ml-auto" …>全屏</button>
</PreviewControlBar>
```
```ts
const wallpaperBarActions = computed(() => { /* props.actions 过滤后映射成 { key, command, label, icon, disabled, divider } */ });
// :1300 现状：壁纸的滚轮直接丢掉
const handlePreviewWheel = (event: WheelEvent) => {
  if (isPreviewVideo.value || isPreviewWallpaper.value) return;
  handlePanzoomWheel(event);
};
// :1495 现状：换图只给图片复位
watch(() => previewImage.value?.id, (id) => {
  if (id && !USE_PSWP) {
    if (isPreviewVideo.value || isPreviewWallpaper.value) return;
    panzoomReset();
  }
});
// :599 现状：截画布整块
const previewCoverSource: CoverRegionScope = (run) => {
  const canvas = wallpaperCanvasRef.value;
  return canvas ? canvas.withCaptureRegion(run) : Promise.reject(new Error("wallpaper canvas is not mounted"));
};
```

**b. 覆盖层在画布根里，截取区域就是画布矩形**（`WallpaperPreviewCanvas.vue:148-184`）
```vue
<div ref="containerRef" class="relative w-full h-full overflow-hidden">
  <div ref="canvasRef" class="absolute origin-top-left overflow-hidden" :style="canvasStyle"><slot /></div>
  <div v-if="NATIVE_FRAME_POINTER" class="absolute inset-0" data-wallpaper-pointer-overlay />  <!-- 现状：会跟着外层变换 -->
</div>
```
```ts
const withCaptureRegion: CoverRegionScope = async (run) => {
  …
  const rect = canvas?.getBoundingClientRect();   // 现状：放大后会超出视口、盖到侧栏
  if (document.visibilityState !== "visible" || !rect || rect.width <= 0 || rect.height <= 0) throw …;
  return await run({ x: rect.x / innerWidth, y: rect.y / innerHeight, width: rect.width / innerWidth, height: rect.height / innerHeight });
};
```
后端 `crop_cover`（`kabegame-core/src/crawler/downloader/compress.rs:648`）只把区域钳进整张截图。

**c. Panzoom 封装**（`composables/usePanzoomPreview.ts`）：
- 选项 `contain: "outside"`、`panOnlyWhenZoomed`、缩放范围 1–10；
- `handleStartEvent` 只在 `canPan` 时阻止默认；
- 对外有 `wrapperRef`、`scale`、`canPan`、`handleWheel`（Ctrl+滚轮缩放，否则平移）、`reset`、`destroy`、`zoomIn`、`zoomOut`、`zoomTo`；
- 没有「从外部开始 / 结束平移」。

Panzoom 4.6.1 公开了 `handleDown` / `handleUp`，`move` / `up` 挂在 `document` 上（`dist/panzoom.es.js:677-757`）。

**d. 显示缩放**（`WpeSceneView.vue:121-130`）
```ts
function postDisplay(force = false) {
  …
  const scale = displayScaleOf(element);   // 现状：含全部祖先 transform，原样上报
  if (scale === null) return;
  if (!force && postedScale !== null && Math.abs(scale - postedScale) <= postedScale * DISPLAY_SCALE_EPSILON) return;
  postedScale = scale;
  target.postMessage(wpeSceneDisplayMessage(scale), "*");
}
```
宿主 `renderer.resize`（`apps/wpe-scene/src/render/renderer.ts:618-637`）：`full` 按显示缩放 1 算，透视场景的重载只看它。

## 点 1 — composable 加平移的起止（`composables/usePanzoomPreview.ts`）

- **新增**
```ts
/**
 * 从外部开始一次平移（壁纸预览：覆盖层按自己的规则决定何时平移，左键同时还注入进了壁纸）。之后的移动由 Panzoom 挂在
 * document 上的监听处理，松开时它自己结束。拖不动（未放大）时不开始。返回是否开始了。
 */
const startPan = (event: PointerEvent): boolean => {
  if (!instance || !instanceEl || wrapperRef.value !== instanceEl || !canPan.value) return false;
  instance.handleDown(event);
  return true;
};

/** 提前结束平移（壁纸预览：拖动中按下了 Ctrl）。没在平移时 Panzoom 什么都不做。 */
const endPan = (event: PointerEvent) => {
  instance?.handleUp(event);
};
```
- **修改**：返回值加 `startPan`、`endPan`；文件头注释补一句壁纸也用。

## 点 2 — 覆盖层组件（`components/wallpaper/WallpaperPointerOverlay.vue`，新增）

```vue
<script setup lang="ts">
/**
 * 预览里盖在壁纸画布之上的透明覆盖层：放在 Panzoom 变换层之外（兄弟、在上），不跟着放大；只拦截真实鼠标、不转发，
 * 壁纸里的鼠标由 Rust 直接注入 iframe（framePointer.ts），覆盖层挡不住。平移由这里决定：
 * - 左键：每次移动看 `ctrlKey`，没按 Ctrl 就平移、按着就不平移（留给壁纸交互），所以途中松开 / 按下 Ctrl 会接着 / 停下平移。
 *   只看指针事件的修饰键、不听键盘：拖动中焦点可能在 iframe 里（keepFocusOutOfFrames 等左键松开才还）。
 * - 中键：平移，不看 Ctrl；阻止默认（中键自动滚动）。
 * - 右键：冒泡到预览容器弹菜单；滚轮：冒泡到预览容器，同图片（Ctrl+滚轮缩放、滚轮平移）。
 * Linux 不盖：iframe 直接收真实鼠标（`NATIVE_FRAME_POINTER`）。
 */
// TODO:[WPE_SCENE] Linux 未实测：没有覆盖层，壁纸上的滚轮、拖动进了 iframe，只有留白处（Panzoom 自己的左键平移）与工具条能缩放 / 平移
const props = defineProps<{
  /** 现在拖得动（已放大） */
  pannable: boolean;
  startPan: (event: PointerEvent) => boolean;
  endPan: (event: PointerEvent) => void;
}>();
const panning = ref(false);
/** 按住的是左键、且按下时拖得动：之后每次移动按 Ctrl 决定平移与否 */
let leftDrag = false;

function onPointerDown(event: PointerEvent) {
  if (event.button === 1) event.preventDefault();
  if ((event.button !== 0 && event.button !== 1) || !props.pannable) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  leftDrag = event.button === 0;
  panning.value = event.button === 1 || !event.ctrlKey ? props.startPan(event) : false;
}
function onPointerMove(event: PointerEvent) {
  if (!leftDrag) return;
  if (!event.ctrlKey && !panning.value) panning.value = props.startPan(event);
  else if (event.ctrlKey && panning.value) {
    props.endPan(event);
    panning.value = false;
  }
}
function onPointerEnd() {
  leftDrag = false;
  panning.value = false;
}
</script>
<template>
  <div v-if="NATIVE_FRAME_POINTER" class="absolute inset-0"
       :class="panning ? 'cursor-grabbing' : pannable ? 'cursor-grab' : ''"
       data-wallpaper-pointer-overlay
       @pointerdown="onPointerDown" @pointermove="onPointerMove"
       @pointerup="onPointerEnd" @pointercancel="onPointerEnd" @lostpointercapture="onPointerEnd" />
</template>
```

## 点 3 — 画布：去掉覆盖层，提供 zoom，截取区域按视口裁（`WallpaperPreviewCanvas.vue`）

- **删除**：模板里的覆盖层 div。头注释里讲覆盖层的那一段改成「覆盖层在外面，见 `WallpaperPointerOverlay`」。`keepFocusOutOfFrames` 不动，它挂在 window 上。
- **新增**
```ts
const props = withDefaults(defineProps<{ contentSize?: …; zoom?: number }>(), { zoom: 1 });   // 新增 zoom：预览的 Panzoom 缩放
provide(WALLPAPER_PREVIEW_ZOOM, computed(() => props.zoom));   // 画布里的场景按它定画布分辨率（sceneDisplayScale）

/** 两个矩形的交集；不相交时宽高为 0。 */
export function intersectRect(a: DOMRectReadOnly, b: DOMRectReadOnly): { x: number; y: number; width: number; height: number };
```
- **修改** `withCaptureRegion(run, viewport?: Element | null)`：给了 `viewport` 时，区域取「画布矩形 ∩ 视口矩形」，交集为空同样报错。头注释改成「截看得见的那一块：放大后只截视口里的部分，不截进侧栏」。`CoverRegionScope` 类型不变，视口由调用方在闭包里传。

## 点 4 — 显示缩放（`wpeSceneStyle.ts`、`WpeSceneView.vue`）

- **新增**（`wpeSceneStyle.ts`，放在 `displayScaleOf` 之后）
```ts
/** 预览画布向画布里的场景提供的 Panzoom 缩放；桌面、应用背景没有提供方，按 1。 */
export const WALLPAPER_PREVIEW_ZOOM: InjectionKey<Readonly<Ref<number>>> = Symbol("wallpaperPreviewZoom");

/**
 * 交给宿主的显示缩放。预览放大（zoom > 1）时画布跟着放大，到 1（布局 × DPR）为止：场景目标的分辨率到这里已用满
 * （正交按场景分辨率、透视按布局 × DPR），再大只是浏览器放大。没放大前就超过 1 的（小场景放大显示）保持原值。
 * zoom 为 1 时就是实测值。
 */
export function sceneDisplayScale(measured: number, zoom: number): number {
  return zoom > 1 ? Math.max(measured / zoom, Math.min(measured, 1)) : measured;
}
```
- **修改**（`WpeSceneView.vue`）
```ts
const previewZoom = inject(WALLPAPER_PREVIEW_ZOOM, null);   // 新增
function postDisplay(force = false) {
  …
  const measured = displayScaleOf(element);                  // 修改：先量
  if (measured === null) return;
  const scale = sceneDisplayScale(measured, previewZoom?.value ?? 1);   // 新增：按预览缩放封顶
  …   // 其余不变
}
// 新增：缩放变了下一帧补报一次（Panzoom 也在 rAF 里写 transform，这一帧之后量得到新值），合并成一次；卸载时取消
let displayFrame = 0;
watch(() => previewZoom?.value, () => {
  if (displayFrame) return;
  displayFrame = requestAnimationFrame(() => { displayFrame = 0; postDisplay(); });
});
```
- 头注释「显示缩放」一条补上预览放大的规则。

## 点 5 — 预览弹窗（`ImagePreviewDialog.vue`）

- **修改** 壁纸分支：
```vue
<div v-if="previewImage && isPreviewWallpaper" ref="wallpaperViewportRef" class="preview-wallpaper-wrapper absolute inset-0">
  <!-- Panzoom 变换这一层（和图片分支共用 panzoomWrapperRef，两支互斥） -->
  <div ref="panzoomWrapperRef" class="w-full h-full">
    <WallpaperPreviewCanvas ref="wallpaperCanvasRef" :content-size="previewWallpaperSize" :zoom="panzoomScale">
      <ImageContent … />   <!-- 不变 -->
    </WallpaperPreviewCanvas>
  </div>
  <!-- 覆盖层在变换层之外：左键与中键平移（Ctrl+左键不平移，留给壁纸），右键弹菜单 -->
  <WallpaperPointerOverlay :pannable="panzoomCanPan" :start-pan="panzoomStartPan" :end-pan="panzoomEndPan" />
</div>
```
- **修改** 工具条和图片一样：
  - 缩放组去掉 `v-if="isPreviewStatic"`（整条工具条本来就只在非视频时出现）；
  - 注释「缩放只对 Panzoom 图片有意义」「壁纸没有弹性项，靠 ml-auto」同步改。
- **删除**
  - 工具条里 `wallpaperBarActions` 的那段模板与 `wallpaperBarActions` computed；
  - 之后用不到的导入（`resolveActionIcon` 等，按 vue-tsc / 编辑器报的删）。
- **修改** `handlePreviewWheel`、换图的 `watch`：只跳过视频。
- **修改** `previewCoverSource`：
```ts
/** 预览的封面截取来源：主窗口里的画布，截看得见的那一块（放大后就是放大的那部分，可以借此定制封面）。点击时才取画布，区域也是那时才量 */
const previewCoverSource: CoverRegionScope = (run) => {
  const canvas = wallpaperCanvasRef.value;
  return canvas
    ? canvas.withCaptureRegion(run, wallpaperViewportRef.value)
    : Promise.reject(new Error("wallpaper canvas is not mounted"));
};
```
- **修改** 解构 `usePanzoomPreview` 时多取 `startPan: panzoomStartPan`、`endPan: panzoomEndPan`（`let` 声明同现有写法）。
- 注释同步：`:254-255` 删「不走 Panzoom」，`:308` 删右键映射的说明。

## 已知副作用（写进文档，本步不处理）

1. **左键拖动平移时，同一次拖动也注入进了壁纸。**想只和壁纸交互，就按住 Ctrl。
2. **放大后壁纸会延伸到侧栏下面**（被裁掉、看不见）。真实光标在侧栏上时，注入的点仍落在 frame 里：
   - 移动照常；
   - 在侧栏上点击也会注入进壁纸，对应位置在视野之外。

   这属于「点击不加闸门、允许重叠」的延伸。要避免，可以加窗口级点击区域（插件命令，预览按容器矩形设），本步不做。
3. **光标出了窗口**时，注入点钳到 frame 的边界。放大后这条边界可能在视野之外，视差、跟随鼠标的粒子会停在视野外那条边上。
4. **网页壁纸的清晰度看 Chromium 怎么栅格化**，页面自己的 canvas 由浏览器拉伸。
5. **放大后设的封面**，宽高比跟视口走，不一定是壁纸的比例。
6. **Linux 没有覆盖层**：壁纸上的滚轮、拖动都进了 iframe（点 2 的 TODO）。

## 验证

**单测**（vitest，只跑相关文件；`cd /D/Codes/kabegame`，`--config` 用大写盘符）
- `usePanzoomPreview.test.ts`（新增，`vi.mock("@panzoom/panzoom")` 换成记录调用的假实例）：
  - `startPan` 只在 `canPan` 时调 `handleDown` 并返回 true；
  - `endPan` 调 `handleUp`；
  - 实例换了之后不调。
- `WallpaperPointerOverlay.test.ts`（新增，props 传 spy）：
  - 左键、没按 Ctrl：开始平移，捕获指针；
  - Ctrl+左键：不开始；移动时松开 Ctrl 就开始，再按下 Ctrl 调 `endPan`；
  - 中键：按着 Ctrl 也平移，并阻止默认；
  - 右键：不处理、不阻止默认；
  - 拖不动时左右中键都不开始，中键仍阻止默认；
  - 松开或取消后，移动不再开始平移；
  - Linux 不渲染。
- `WallpaperPreviewCanvas.test.ts`：
  - 覆盖层那条用例删掉；
  - 插槽里的子组件 inject 到的 zoom 等于 prop；
  - `withCaptureRegion` 给了视口时，区域是交集；交集为空时报错。
- `wpeSceneStyle.test.ts`：`sceneDisplayScale` 的几种情况：
  - zoom 1 原样；
  - 基准 0.4、放大 2 倍得 0.8；
  - 放大 5 倍封顶到 1；
  - 基准 1.5、放大 2 倍保持 1.5。
- `WpeSceneView.test.ts`：
  - 提供 zoom 时，上报值按公式封顶；
  - zoom 变化后下一帧补报，同一帧内多次变化只报一次；
  - 没有提供方时照旧。
- `ImagePreviewDialog.events.test.ts`：
  - mock 补上 `startPan`、`endPan`；
  - 新增：壁纸上的滚轮交给 `handleWheel`；切到另一张壁纸时复位；壁纸的工具条有缩放组、没有动作按钮；设封面传了视口。

**变异**（按原字节还原）
- 公式去掉封顶；
- `startPan` 不看 `canPan`；
- 覆盖层不看 Ctrl；
- 移动时不重新判断 Ctrl；
- 截取不和视口求交；
- 滚轮恢复对壁纸的跳过。

**检查**
- `deno task check -c kabegame`：本步只改前端；cargo 那一半如果被 dev 占用而失败，只看 vue-tsc。
- Prettier。

**真机**（dev 的 HMR 直接生效，Rust 不改，dev 不会重启）

要打开预览，我不接管图库界面，下面写进回归，由你来勾：
- 场景和网页壁纸都能放大：Ctrl+滚轮、工具条 −、+、滑块都能用；单独滚轮在放大后平移、不缩放。
- 左键、中键拖动都能平移；Ctrl+左键只和壁纸交互；拖动中途松开 Ctrl 就接着平移。
- 放大后点击、跟随都对得上位置；场景画面变清楚，放到 1 之后不再变。
- 放大后设封面，截到的是看得见的那一块，不带侧栏。
- 切图、开关抽屉、全屏时复位。
- 工具条和图片一样，右键菜单里各项照常。
- 中键按下时没有出现自动滚动的图标。

我能做的：在 `app_log` 里确认没有新的告警。

**文档**
- `cocs/wpe/WPE_IMPORT.md`：
  - 「鼠标」一节补放大：覆盖层在变换层外，左键、中键平移，Ctrl+左键留给壁纸；
  - 工具条改成和图片一样；
  - 封面截看得见的那一块；
  - 已知副作用 1–6。
- `cocs/wpe/WPE_SCENE.md`：「预览画布尺寸」补 `sceneDisplayScale`。
- `cocs/README.md`：两条主题与适用场景各补一句。
- `versions/latest/regression.md`：新增一节。
- `changelog.md`：Added 一行，Changed 一行（工具条）。

**提交**
- `ImagePreviewDialog.vue`、`WpeSceneView.vue`、`wpeSceneStyle.ts` 及它们的测试里，有别的会话还没提交的逐壁纸设置改动；
- 照旧用临时索引按块挑自己的改动，等你说提交再提。

## 实施记录

### 2026-11-15（Claude，直接实现）
- 照点 1–5 实现，计划里的代码基本原样落地。和计划的小出入：
  - `WallpaperPreviewCanvas` 的 `withCaptureRegion` 不再标注成 `CoverRegionScope` 类型（多了第二个参数 `viewport`），`CoverRegionScope` 类型本身不变，调用方仍按它传。
  - 工具条没有加分隔线：动作按钮整段删了，只剩缩放组和全屏。
  - `ImagePreviewDialog` 里 `Component` 类型导入在 HEAD 就没用到，没动。
- **检查**：
  - vitest 六个文件 82 条全过：`usePanzoomPreview`（新增，假 Panzoom）、`WallpaperPointerOverlay`（新增）、`WallpaperPreviewCanvas`、`wpeSceneStyle`、`WpeSceneView`、`ImagePreviewDialog.events`。
  - `ImagePreviewDialog.events` 里原来点工具条按钮的用例改成经右键菜单（`ActionRenderer` 的 `command`），置灰按菜单给的上下文求值。
  - vue-tsc 0 error；Prettier 通过（画布两个文件格式化过）。
- **变异** 9 / 9（`scratchpad/mutate_zoom.py`，原地改、按原字节还原，还原前核对文件没被别人改过；sha1 核对一致）。
- **真机**：要打开预览，我不接管图库界面，回归 PZ3–PZ9 留给用户。`app_log` 在我开始改之后没有新告警。
- **文档**：
  - `WPE_IMPORT.md`：新增「预览放大」；改了「右键」「鼠标 / 预览」、预览画布那段、「封面」、文件清单。
  - `WPE_SCENE.md`：「画布尺寸」补预览放大。
  - `cocs/README.md`：两条主题、一条适用场景。
  - 回归：PZ1–PZ11。
  - changelog：Added、Changed 各一行。
- **混在别的会话未提交段落里的改动**（提交时不带，留给那个会话一起提交）：
  - `WPE_IMPORT.md`「预览设置」节的「和右键菜单 / 工具条的「暂停」」；
  - `ImagePreviewDialog.vue` 预览设置面板与属性面板上方两条注释里的「工具条」。
- **封面截进右键菜单**（用户反馈）：
  - 原因：菜单面板关掉时有 100 ms 淡出（`kb-menu-panel` 的 `data-[state=closed]:animate-[kb-pop-out_100ms]`），Reka 的 Presence 等退场动画放完才移除；`withCaptureRegion` 只等两帧，会截到淡出中的菜单。文档原来写的「右键菜单是 `v-if`，命令发出时已经移除」不对。
  - 修法：不靠等，截图期间直接藏。`WallpaperPreviewCanvas.vue` 加一段全局样式 `html[data-kb-cover-capture] [data-reka-popper-content-wrapper] { visibility: hidden }`，菜单、提示、气泡一起藏。
  - 验证：主窗口样式表里已有这条规则（eval 只读 `document.styleSheets`）；截图效果见回归 PZ12，待用户。
