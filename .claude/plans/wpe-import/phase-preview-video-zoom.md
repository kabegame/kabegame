# 步骤 4：预览里的视频像图片一样放大

> 接 [phase-preview-zoom.md](phase-preview-zoom.md)（步骤 3，网页 / 场景壁纸放大，`2dd04c2b`）。用户最初的要求：「放大的意思是和图片一样
> 能放大，之后我想给视频也接入这种放大」。2026-11-15 定：缩放控件和音量一样，一个放大镜按钮、悬停弹出竖向滑块、按钮上显示百分比；
> 步骤 3 的两个「已知副作用」（放大后在侧栏上点击传进壁纸、光标出窗后跟随停在视野外）不算问题、不修。

## 总体设计思路

**视频分支也挂上同一个 Panzoom。** 预览弹窗只有一个 `usePanzoomPreview`，图片和网页 / 场景壁纸两支已经共用（`v-if` 互斥，换元素即重建）。
视频分支在 `ImageContent` 外面包一层 div 挂 `panzoomWrapperRef`，`VideoControls` 留在这层外面（控制条不能跟着放大）。这样下面这些和图片
完全一样，不另写：Ctrl+滚轮缩放、单独滚轮在放大后平移；抽屉开关 / 拖宽、全屏、容器尺寸变化时复位；交互期间通知上层暂停后台加载；
放大后关掉原生拖出（`native-drag="!panzoomCanPan"`）。普通视频和视频壁纸（`x-wpe/video` 在预览里按普通视频播放）走的是同一支，一起支持。

视频不用像场景那样调分辨率：`<video>` 是合成器里的视频层，CSS 缩放直接拿解码后的帧缩放，放到源分辨率之前都是真实像素。也不需要覆盖层：
`<video>` 收真实鼠标，Panzoom 自己的指针绑定就能平移（左、中、右键都会开始平移，Panzoom 不分按键，图片现在就是这样）。

**单击暂停和拖动平移的冲突，在 composable 里统一拦。** 视频上单击是播放 / 暂停（`VideoControls` 直接在 `<video>` 上听 `click`），放大后
拖动平移，松开时浏览器照样派发 `click`，视频就被暂停了。`usePanzoomPreview` 在 Panzoom 层上加一对捕获阶段的监听：按下时拖得动就记下
位置，随后的 `click` 离按下点超过 4 px 就在捕获阶段拦掉（`stopPropagation` + `preventDefault`），到不了 `<video>`。只拦「按下时拖得动、
确实拖过」的那次点击：没放大时单击照常暂停，放大后原地单击也照常。图片上的点击本来没有动作，壁纸分支的鼠标落在变换层外的覆盖层上，
这一拦对它们没有影响。

**去掉视频的双击全屏**（用户 2026-11-15 开工时追加）。`VideoControls` 在 `<video>` 上听 `dblclick` 切应用内全屏；去掉后双击就是两次单击
（播放 / 暂停各切一次），全屏只走控制条的按钮。安卓 photoswipe 的双击切播放 / 暂停（`video-double-tap`）不是这一支，不动。

**控制条加一个缩放按钮，和音量同一种悬停面板。** 视频控制条是 播放 / 进度条（占弹性宽度）/ 音量 / 全屏，放不下图片那样的横向滑块。
在音量和全屏之间加一个按钮：没放大时是放大镜图标，放大后显示百分比数字；悬停弹出竖向滑块（100–1000，和图片的横向滑块同一个范围与
步长），点按钮复位到 100%（同音量按钮点一下静音）。`VideoControls` 只管显示和发事件（`zoom` 百分比进、`zoom-drag-start` /
`zoom-input` / `zoom-commit` / `zoom-reset` 出），缩放仍由弹窗经 Panzoom 做，弹窗直接复用图片滑块的三个处理函数。不传 `zoom` 时不显示
按钮。音量面板和缩放面板的悬停计时是同一套，抽成组件内的一个小函数，样式共用一个类。拖缩放滑块期间控制条不自动隐藏（同拖进度条）。

**视频就绪时不复位。** 图片在 `ready` 时复位一次，视频的 `ready` 挂在 `canplay` 上，拖进度条、循环回到开头都会再触发，复位会把用户的放大
撤掉，所以 `handlePreviewReady` 对视频照旧跳过；换视频由换图的 watch 复位（视频换视频时 Panzoom 层没换、实例还在）。

**拖动范围含留白，和图片一样。** 被放大的是铺满预览区的那层，视频在里面按 `object-fit: contain` 居中，所以放大后能把上下或左右的黑边
拖进视野。图片（`.panzoom-wrapper` 铺满、`ic-img` 是 `object-contain`）和壁纸（画布在铺满的那层里居中）现在都是这样，本步保持一致、
不单改视频。

## 现状锚点

**a. 视频分支不走 Panzoom**（`ImagePreviewDialog.vue:333-348`）
```vue
<div v-if="previewImage && isPreviewVideo" class="preview-video-wrapper">
  <ImageContent ref="previewContentRef" :image="previewImage" prefer="original" video-playing video-loop
                @ready="handlePreviewReady" />   <!-- 现状：没有 Panzoom 层，native-drag 取默认 true -->
  <VideoControls :video="previewVideoEl" :show-play-pause="true" :is-fullscreen="isAppFullscreen"
                 @toggle-fullscreen="toggleAppFullscreen" />
</div>
```
```ts
// :1291 现状：视频的滚轮直接丢掉
const handlePreviewWheel = (event: WheelEvent) => {
  if (isPreviewVideo.value) return;
  handlePanzoomWheel(event);
};
// :1301 现状：视频、壁纸就绪时不复位
const handlePreviewReady = () => {
  …
  if (USE_PSWP || isPreviewVideo.value || isPreviewWallpaper.value) return;
  void measureContainerAfterRender().then(() => { panzoomReset(); });
};
// :1486 现状：换图时视频不复位
watch(() => previewImage.value?.id, (id) => {
  if (id && !USE_PSWP) {
    if (isPreviewVideo.value) return;
    panzoomReset();
  }
});
```

**b. 图片的缩放滑块处理**（`ImagePreviewDialog.vue:760-787`）：`zoomPercent`（`panzoomScale × 100` 取整）、`handleZoomSliderDragStart`、
`handleZoomSliderInput(percent)`、`handleZoomSliderCommit(percent)`（都调 `panzoomZoomTo(percent / 100)` 并通知交互状态）。

**c. 视频控制条**（`VideoControls.vue`）
```vue
<PreviewControlBar ref="barRef" :is-fullscreen="isFullscreen" :keep-visible="keepVisible">
  <button v-if="showPlayPause" …>播放 / 暂停</button>
  <div class="seek-wrap">…进度条 + 时间…</div>
  <div class="volume-wrap" @mouseenter="handleVolumeEnter" @mouseleave="handleVolumeLeave">
    <button … @click="toggleMute">…</button>
    <div class="volume-panel" :class="{ visible: volumePanelVisible }" …>   <!-- 现状：竖向 PreviewRangeSlider -->
      <PreviewRangeSlider :model-value="volume" :min="0" :max="1" :step="0.01" vertical … />
    </div>
  </div>
  <button … @click="toggleFullscreen">全屏</button>
</PreviewControlBar>
```
```ts
const keepVisible = computed(() => isSeekDragging.value || volumePanelActive.value);
const handleVideoClick = () => { if (!props.showPlayPause) return; void togglePlay(); };   // 挂在 <video> 的 click 上
const handleVolumeEnter = () => { clearVolumePanelTimer(); volumePanelActive.value = true; showControls(); };
const handleVolumeLeave = () => { clearVolumePanelTimer(); volumePanelTimer = setTimeout(() => { volumePanelActive.value = false; … }, 180); … };
```

**d. Panzoom 封装**（`composables/usePanzoomPreview.ts`）：`create(el)` 建实例、挂 `panzoomstart` / `panzoomend` / `panzoomchange`；
`destroy()` 摘掉；Panzoom 4.6.1 的 `handleDown` 不分按键（`dist/panzoom.es.js:677`）。没有「拖过之后的点击」的处理。

## 点 1 — 拖过之后的点击不算数（`composables/usePanzoomPreview.ts`）

- **新增**
```ts
/** 平移过的拖动松开时不再算一次点击：离按下点超过这个距离（CSS px）就拦 */
const CLICK_AFTER_PAN_SLOP = 4;

/** 按下时拖得动才记下位置（没放大时单击照常） */
let panDownPoint: { x: number; y: number } | null = null;
const handlePointerDownCapture = (event: PointerEvent) => {
  panDownPoint = canPan.value ? { x: event.clientX, y: event.clientY } : null;
};
/**
 * 视频上单击是播放 / 暂停（`VideoControls` 听 `<video>` 的 click），放大后拖动平移、松开时浏览器照样派发 click。
 * 在 Panzoom 层的捕获阶段拦掉，到不了里面的元素。原地单击（≤ 阈值）照常。
 */
const handleClickCapture = (event: MouseEvent) => {
  const start = panDownPoint;
  panDownPoint = null;
  if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) <= CLICK_AFTER_PAN_SLOP) return;
  event.preventDefault();
  event.stopPropagation();
};
```
- **修改** `create`：`el.addEventListener("pointerdown", handlePointerDownCapture, true)`、`el.addEventListener("click", handleClickCapture, true)`；
  `destroy` 对应摘掉并清 `panDownPoint`。文件头注释补一句视频也用、拖过的点击被拦。

## 点 2 — 控制条的缩放按钮（`components/common/VideoControls.vue`）

- **新增** props / emits
```ts
/** 当前缩放百分比（100–1000）；不传不显示缩放按钮 */
zoom?: number | null;
```
```ts
(e: "zoom-drag-start"): void;
(e: "zoom-input", percent: number): void;
(e: "zoom-commit", percent: number): void;
/** 点缩放按钮：复位到 100% */
(e: "zoom-reset"): void;
```
- **新增** 模板（音量与全屏之间）
```vue
<div v-if="zoom != null" class="hover-panel-wrap" @mouseenter="zoomPanel.enter" @mouseleave="zoomPanel.leave">
  <button class="control-btn zoom-btn" type="button" :aria-label="t('gallery.zoomRatio')" @click="emit('zoom-reset')">
    <ZoomIn v-if="zoomPercent === 100" />
    <span v-else class="zoom-btn-text">{{ zoomPercent }}%</span>
  </button>
  <div class="slider-panel" :class="{ visible: zoomPanel.active.value }" @mouseenter="zoomPanel.enter" @mouseleave="zoomPanel.leave" @click.stop>
    <PreviewRangeSlider :model-value="zoomPercent" :min="100" :max="1000" :step="1" :aria-label="t('gallery.zoomRatio')" vertical
                        @drag-start="handleZoomDragStart" @update:model-value="handleZoomInput" @change="handleZoomCommit" />
  </div>
</div>
```
- **新增** 脚本
```ts
/** 悬停面板（音量、缩放共用）：进入即显示，离开 180 ms 后收起 */
function useHoverPanel() { const active = ref(false); let timer …; const enter = () => {…}; const leave = () => {…}; const clear = () => {…}; return { active, enter, leave, clear }; }
const zoomPanel = useHoverPanel();
const zoomDragging = ref(false);
const zoomPercent = computed(() => Math.min(1000, Math.max(100, Math.round(props.zoom ?? 100))));
const handleZoomDragStart = () => { zoomDragging.value = true; showControls(); emit("zoom-drag-start"); };
const handleZoomInput = (percent: number) => { emit("zoom-input", percent); showControls(); };
const handleZoomCommit = (percent: number) => { zoomDragging.value = false; emit("zoom-commit", percent); };
```
- **修改**
  - 音量面板改用 `useHoverPanel()`（`volumePanel.active` 替换 `volumePanelActive`，删 `volumePanelTimer` / `clearVolumePanelTimer` / `handleVolumeEnter` / `handleVolumeLeave`），
    行为不变；`.volume-wrap` / `.volume-panel` 改名 `.hover-panel-wrap` / `.slider-panel`，两个面板共用。
  - `keepVisible` 加上 `zoomDragging || zoomPanel.active`。
  - 文档级 `mouseup` / `touchend`（`handleDocumentPointerUp`）也收 `zoomDragging`（滑块在面板外松开时）。
  - 引入 `useI18n` 与 `ZoomIn`（`@lucide/vue`）；词条用现有的 `gallery.zoomRatio`，不加新键。
- **新增** 样式：`.zoom-btn` 宽度随内容（百分比最长「1000%」），`.zoom-btn-text` 11px、等宽数字。
- **删除** `handleVideoDblClick` 及 `attachVideo` 里 `dblclick` 的挂 / 摘。

## 点 3 — 预览弹窗（`components/common/ImagePreviewDialog.vue`）

- **修改** 视频分支
```vue
<div v-if="previewImage && isPreviewVideo" class="preview-video-wrapper">
  <!-- Panzoom 变换这一层（和图片、壁纸分支共用 panzoomWrapperRef，三支互斥）；控制条在外面，不跟着放大 -->
  <div ref="panzoomWrapperRef" class="w-full h-full">
    <ImageContent … :native-drag="!panzoomCanPan" @ready="handlePreviewReady" />   <!-- 新增 native-drag，同图片 -->
  </div>
  <VideoControls …
    :zoom="zoomPercent"
    @zoom-drag-start="handleZoomSliderDragStart"
    @zoom-input="handleZoomSliderInput"
    @zoom-commit="handleZoomSliderCommit"
    @zoom-reset="panzoomReset" />
</div>
```
- **修改** `handlePreviewWheel`：去掉对视频的跳过（三支都交给 `handlePanzoomWheel`），注释改成「图片、网页 / 场景壁纸、视频同一套」。
- **修改** 换图的 watch：去掉对视频的跳过，注释改成「视频换视频、壁纸换壁纸时 Panzoom 层没换、实例还在，同样要复位」。
- **修改** `handlePreviewReady` 只补注释：视频的 `ready` 挂在 `canplay` 上，拖进度条、循环都会再触发，就绪时复位会撤掉放大，所以视频照旧跳过。
- **修改** `isPreviewStatic` 等处讲「壁纸分支也走同一个 Panzoom」的注释，补上视频。

## 不在本步

- Android（photoswipe）不动；它的视频本来就由 photoswipe 管缩放。
- 拖动范围含留白（见总体设计），三支一致，要改另起一步。
- 中键按下时是否出现自动滚动图标：图片现在靠 `handleStartEvent` 在拖得动时 `preventDefault`，没单测过；真机看，若出现就在点 1 的捕获监听里对中键
  一律 `preventDefault`（图片、视频一起修）。

## 验证

**单测**（vitest，只跑相关文件；`cd /D/Codes/kabegame`，`--config` 用大写盘符）
- `usePanzoomPreview.test.ts`：放大后按下、移动超过 4 px 再 `click`，里面元素的 click 监听不调、事件被 `preventDefault`；没放大时、移动 ≤ 4 px
  时照常；没有 `pointerdown` 的孤立 `click` 照常；`destroy` 之后不再拦。
- `VideoControls.test.ts`：不传 `zoom` 没有缩放按钮；`zoom` 100 显示图标、250 显示「250%」；拖滑块依次发 `zoom-drag-start` / `zoom-input` /
  `zoom-commit`；点按钮发 `zoom-reset`；`<video>` 上的 `dblclick` 不发 `toggle-fullscreen`；拖动期间与面板展开时控制条不隐藏，松开后照常隐藏；音量面板悬停显示、离开 180 ms 后收起（改名后不回退）。
- `ImagePreviewDialog.events.test.ts`：视频上的滚轮交给 `handleWheel`；视频换视频时复位；视频的 `ready` 不复位；视频的 `ImageContent` 拿到
  `native-drag = !canPan`；`VideoControls` 拿到 `zoom` 百分比，四个事件分别接到 `zoomTo` / 交互状态 / `reset`。

**变异**（按原字节还原）：拦点击不看距离；拦点击不看按下时拖不拖得动；滚轮恢复跳过视频；换视频不复位；视频就绪时复位；`keepVisible` 不含缩放拖动；
按钮点击不发 `zoom-reset`。

**检查**：vue-tsc（`deno task check -c kabegame` 的 cargo 一半被 dev 占着失败就只看 vue-tsc）；Prettier。

**真机**（dev 的 HMR 直接生效，只改前端；我不接管图库界面，写进回归由你来勾）
- 普通视频、视频壁纸各一个：悬停放大按钮出滑块、拖滑块缩放、按钮上的百分比跟着变，点按钮回到 100%；Ctrl+滚轮缩放，单独滚轮在放大后平移。
- 放大后左键拖动平移，松开不暂停；原地单击仍是播放 / 暂停，双击不再全屏；中键拖动平移，看有没有自动滚动图标。
- 拖进度条、视频循环回到开头时不复位；切到下一个视频 / 图片、开关侧栏、全屏时复位。
- 4K 视频放大 3 倍以上能看清源像素（不糊成低分辨率）。
- 拖缩放滑块、面板展开期间控制条不隐藏。

**文档**
- `cocs/wpe/WPE_IMPORT.md`「预览放大」：开头那句「视频壁纸…放大以后再做」改成视频（普通视频与视频壁纸）也接入，补一条「视频」：同一个
  Panzoom、控制条的缩放按钮、拖过的点击被拦、就绪不复位、清晰度；「已知副作用」里侧栏点击与光标出窗两条改成「预期行为」（用户 2026-11-15
  定为不算问题）。预览放大没有单独的文档，普通视频也写在这一节（共用 Panzoom 的说明都在这里）。
- `cocs/README.md`：WPE_IMPORT 条目的主题补「视频」，适用场景补「预览里的视频放大不了、拖动后被暂停」，「放大后在侧栏上点击传进了壁纸（已知）」
  改「（预期）」。
- `versions/latest/regression.md`：新增一节「预览里的视频放大」。
- `versions/latest/changelog.md`：Added 一行。

**提交**：`ImagePreviewDialog.vue`、文档里有别的会话还没提交的改动，照旧用临时索引按块挑自己的，等你说提交再提。

## 实施记录（2026-11-15）

- 按计划实现，外加用户开工时追加的「去掉视频的双击全屏」。和计划的出入：
  - `handleZoomCommit` 松开后也排一次隐藏（同文档级 mouseup 的收尾），否则拖完停在可见状态、要等光标离开控制条才藏。
  - 换视频（`attachVideo`）时音量、缩放两个面板一起收起（原来只收音量）。
  - 测试桩：`ImagePreviewDialog.events.test.ts` 的 Panzoom 桩把 `scale` / `canPan` 改成每个用例新建的共享 ref，`zoomTo` 改成共享 spy。
- 验证：三个 vitest 文件 35 条全过；变异 13 / 13（第一轮「换层时不摘点击监听」存活：换层时按下点一起清空，旧监听不会误拦；用例加了
  「在新层上按下、在旧元素上点」才杀死）；vue-tsc 0 error；Prettier 通过；dev 热更新后 `app_log` 没有新告警。
- 真机项写进回归「预览里的视频放大」VZ3–VZ8，待用户。
