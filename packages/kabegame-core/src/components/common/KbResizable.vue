<template>
  <component
    :is="tag"
    ref="rootRef"
    class="kb-resizable"
    :class="[`kb-resizable--${side}`, { 'is-resizing': resizing }]"
    :style="sizeStyle"
  >
    <slot />
    <!-- move/up 一律挂 window（见脚本注释），这里只起手 -->
    <div
      v-if="!disabled"
      class="kb-resizable-handle"
      :title="handleTitle"
      @pointerdown="handlePointerDown"
      @dblclick="handleReset"
    />
  </component>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

/**
 * 可拖拽改变尺寸的容器。
 *
 * 尺寸的**上下限一律由 CSS 决定**，组件不持有任何像素常量：宿主在本元素上给出
 * `--kb-resizable-min` / `--kb-resizable-max`（可以是 `min(560px, 45vw)`、`clamp()`、
 * `calc()` 等任意 CSS 长度），组件把当前尺寸写进 `--kb-resizable-size`，最终值由
 * `--kb-resizable-clamped` 这一层 `clamp()` 收口。
 *
 * ```scss
 * .my-drawer {
 *   --kb-resizable-min: 240px;
 *   --kb-resizable-max: min(560px, 45vw);
 *   // 默认已按 side 的轴向设好 width/height（低特异性，可随意覆盖）；
 *   // 需要参与 flex 布局时自己再用一次这个变量：
 *   flex: 0 0 var(--kb-resizable-clamped);
 * }
 * ```
 *
 * 拖拽仿 vscode 的 `Sash` + `SplitView`：按下时记一份「指针起点 + 尺寸快照」，之后每次
 * move 都算 `快照 + (当前指针 − 起点)`，**不是**把逐帧增量累加到当前渲染尺寸上。
 * 后者看着也是增量，实际会两头出问题：拖过 min/max 被 clamp 时越界的那段位移直接丢失，
 * 任何一次 move 丢帧同理，于是把手会**永久**偏离光标（甩得越快偏得越多）。锚在起点上则
 * 每个事件都能独立还原出正确尺寸，丢帧也自愈；越界期间保留意图值，反向拖回时把手恰好在
 * 光标回到边界的那一刻重新贴合。落盘的仍是 clamp 后的真实尺寸。
 *
 * 布局提示：当侧栏用时父级请用 flex 且给本组件 `flex-none`。grid 的 `auto` 列按
 * min/max-content 定尺寸，会把 clamp 出来的宽度压掉（拖到下限直接塌成 0）。
 */
const props = withDefaults(
  defineProps<{
    /** 把手贴在哪条边；也就是拖动这条边来改变尺寸。左侧栏用 right，右侧栏用 left */
    side?: "left" | "right" | "top" | "bottom";
    /** 双击把手复位到的尺寸（px）；不给则双击无动作 */
    defaultSize?: number | null;
    /** 不渲染把手（尺寸仍受 CSS 变量控制） */
    disabled?: boolean;
    /** 把手的原生 title 提示 */
    handleTitle?: string;
    /** 根元素标签，语义需要时可换成 aside / section */
    tag?: string;
  }>(),
  {
    side: "right",
    defaultSize: null,
    disabled: false,
    handleTitle: undefined,
    tag: "div",
  }
);

/** 当前尺寸（px）。宿主可接 useLocalStorage 直接持久化 */
const size = defineModel<number>();

const emit = defineEmits<{
  (e: "resize-start"): void;
  /** 拖拽结束 / 双击复位；载荷是 CSS clamp 之后的真实尺寸 */
  (e: "resize-end", size: number): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
const resizing = ref(false);
/** 拖拽锚点：按下时的指针坐标与当时的真实尺寸，整场拖拽期间不变 */
let startPos = 0;
let startSize = 0;
let activePointerId: number | null = null;
let captureEl: HTMLElement | null = null;
let dragStyleEl: HTMLStyleElement | null = null;

const isHorizontal = computed(() => props.side === "left" || props.side === "right");
/** 把手在 right/bottom 时，指针朝正方向移动等于变大；在 left/top 时相反 */
const sign = computed(() => (props.side === "right" || props.side === "bottom" ? 1 : -1));

const sizeStyle = computed(() =>
  size.value != null && Number.isFinite(size.value) ? { "--kb-resizable-size": `${size.value}px` } : undefined
);

/** 元素当前实际渲染尺寸（已经过 CSS clamp / flex 布局） */
function measure(): number {
  const el = rootRef.value;
  if (!el) return size.value ?? 0;
  const rect = el.getBoundingClientRect();
  return isHorizontal.value ? rect.width : rect.height;
}

function applySize(next: number) {
  const rounded = Math.round(next);
  size.value = rounded;
  // 同步写一次 DOM：pointermove 是高频事件，等 Vue 下一 tick 才落到 style 的话，
  // 松手时的 measure() 会读到旧尺寸，落盘的就不是这次拖出来的值
  rootRef.value?.style.setProperty("--kb-resizable-size", `${rounded}px`);
}

/**
 * 拖拽期间全局强制光标 + 禁选中（同 vscode sash 的做法：往 head 注入一张
 * `* { cursor: ... !important }`）。
 * 写在 documentElement 的 style 上不够用——指针虽然被把手捕获，光标形状仍由指针
 * 底下的元素决定，而图片项、树行都自带 cursor，拖过去就会一路跳。
 */
function setDragGuard(active: boolean) {
  if (!active) {
    dragStyleEl?.remove();
    dragStyleEl = null;
    return;
  }
  if (dragStyleEl) return;
  dragStyleEl = document.createElement("style");
  dragStyleEl.textContent =
    `*{cursor:${isHorizontal.value ? "col-resize" : "row-resize"}!important;user-select:none!important}`;
  document.head.appendChild(dragStyleEl);
}

/**
 * window 监听一律走**捕获阶段**：拖拽跨越整页，途中任何一个祖先/兄弟处理器
 * `stopPropagation()` 都会让冒泡阶段的 pointerup 永远到不了这里，拖拽态就此卡死。
 * 捕获阶段在派发链最前面，谁也拦不住。
 */
const WIN_LISTENER_OPTS = true;

/** 拆监听 / 放捕获 / 撤全局样式；不落盘、不发事件，供松手与卸载共用 */
function teardownDrag() {
  resizing.value = false;
  setDragGuard(false);
  window.removeEventListener("pointermove", onWindowPointerMove, WIN_LISTENER_OPTS);
  window.removeEventListener("pointerup", onWindowPointerUp, WIN_LISTENER_OPTS);
  window.removeEventListener("pointercancel", onWindowPointerUp, WIN_LISTENER_OPTS);
  if (captureEl && activePointerId != null && captureEl.hasPointerCapture(activePointerId)) {
    captureEl.releasePointerCapture(activePointerId);
  }
  captureEl = null;
  activePointerId = null;
}

function onWindowPointerMove(event: PointerEvent) {
  if (!resizing.value || event.pointerId !== activePointerId) return;
  const pos = isHorizontal.value ? event.clientX : event.clientY;
  // 相对起点的位移 → 尺寸；不读 measure()，所以既不受 clamp 影响也不逐帧漂移
  applySize(startSize + (pos - startPos) * sign.value);
  event.preventDefault();
}

function onWindowPointerUp(event: PointerEvent) {
  if (!resizing.value) return;
  // 这里不比对 pointerId：一个把手同时只可能有一场拖拽，宁可被别的指针误结束，
  // 也不要因为 id 对不上而永远收不了尾
  teardownDrag();
  // 落盘的是 clamp 之后的真实尺寸，避免把越界的意图值持久化下来
  applySize(measure());
  emit("resize-end", size.value ?? 0);
}

function handlePointerDown(event: PointerEvent) {
  if (props.disabled || event.button !== 0) return;
  // 上一次拖拽万一没收干净（比如 pointerup 落在了监听拆掉之后），这里先无条件复位，
  // 否则残留的 resizing/监听会让把手从此再也起不来
  teardownDrag();
  resizing.value = true;
  startPos = isHorizontal.value ? event.clientX : event.clientY;
  startSize = measure();
  activePointerId = event.pointerId;
  captureEl = event.currentTarget as HTMLElement;
  // 捕获是尽力而为：真正保证收得到后续事件的是下面挂在 window 上的监听
  // （同 vscode sash 把 move/up 挂到 window）。只靠捕获的话，任何在祖先上
  // 对同一 pointerId 再调一次 setPointerCapture 的手势识别器都会把它夺走，
  // 把手收到 lostpointercapture，拖拽在半路无声中断 —— 就是「拖着拖着脱手」。
  try {
    captureEl.setPointerCapture(event.pointerId);
  } catch {
    // 捕获失败不影响拖拽
  }
  window.addEventListener("pointermove", onWindowPointerMove, WIN_LISTENER_OPTS);
  window.addEventListener("pointerup", onWindowPointerUp, WIN_LISTENER_OPTS);
  window.addEventListener("pointercancel", onWindowPointerUp, WIN_LISTENER_OPTS);
  setDragGuard(true);
  emit("resize-start");
  event.preventDefault();
  // 把手上的手势由本组件独占：不拦冒泡，祖先的手势识别器（如 enableDragScroll
  // 的拖拽滚动）也会认下这次按下，一边抢捕获一边跟着滚动
  event.stopPropagation();
}

// 拖到一半被卸载（如切紧凑模式把树收进抽屉）时别把监听和全局样式留在页面上
onBeforeUnmount(teardownDrag);

function handleReset() {
  if (props.disabled || props.defaultSize == null) return;
  applySize(props.defaultSize);
  emit("resize-end", size.value ?? 0);
}
</script>

<style scoped lang="scss">
.kb-resizable {
  position: relative;
  box-sizing: border-box;
  /* 尺寸的唯一收口点：min/max 是宿主给的 CSS 长度，size 是组件写入的当前值 */
  --kb-resizable-clamped: clamp(
    var(--kb-resizable-min, 0px),
    var(--kb-resizable-size, var(--kb-resizable-min, 0px)),
    var(--kb-resizable-max, 100%)
  );
}

/* 侧栏预设（图片预览抽屉用的口径）。宿主加 `kb-side-pane` 即可；要别的限制就别加这个类，
   直接在自己或任一祖先元素上给这两个变量——变量会继承下来 */
.kb-resizable.kb-side-pane {
  --kb-resizable-min: 240px;
  --kb-resizable-max: min(560px, 45vw);
}

/* 默认尺寸用 :where() 压到零特异性，宿主一个类就能覆盖（如展开/收拢两态） */
:where(.kb-resizable--left, .kb-resizable--right) {
  width: var(--kb-resizable-clamped);
}

:where(.kb-resizable--top, .kb-resizable--bottom) {
  height: var(--kb-resizable-clamped);
}

.kb-resizable-handle {
  position: absolute;
  z-index: 2;
  touch-action: none;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--kb-resizable-handle-hover, color-mix(in srgb, var(--anime-primary) 58%, transparent));
  }
}

.kb-resizable.is-resizing > .kb-resizable-handle {
  background: var(--kb-resizable-handle-active, color-mix(in srgb, var(--anime-primary) 72%, transparent));
}

.kb-resizable--left > .kb-resizable-handle,
.kb-resizable--right > .kb-resizable-handle {
  top: 0;
  bottom: 0;
  width: var(--kb-resizable-handle-size, 6px);
  cursor: col-resize;
}

.kb-resizable--top > .kb-resizable-handle,
.kb-resizable--bottom > .kb-resizable-handle {
  left: 0;
  right: 0;
  height: var(--kb-resizable-handle-size, 6px);
  cursor: row-resize;
}

.kb-resizable--left > .kb-resizable-handle {
  left: 0;
}

.kb-resizable--right > .kb-resizable-handle {
  right: 0;
}

.kb-resizable--top > .kb-resizable-handle {
  top: 0;
}

.kb-resizable--bottom > .kb-resizable-handle {
  bottom: 0;
}
</style>
