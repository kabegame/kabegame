<template>
  <component
    :is="tag"
    ref="rootRef"
    class="kb-resizable"
    :class="[`kb-resizable--${side}`, { 'is-resizing': resizing }]"
    :style="sizeStyle"
  >
    <slot />
    <div
      v-if="!disabled"
      class="kb-resizable-handle"
      :title="handleTitle"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
      @lostpointercapture="handlePointerUp"
      @dblclick="handleReset"
    />
  </component>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

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
 * 拖拽时以「当前真实渲染尺寸」为增量基准（而不是累加意图值），所以拖到 min/max
 * 之外不会积累看不见的偏移，反向拖动立刻跟手。
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
let lastPos = 0;

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
  // 本次移动后的 measure() 会读到旧尺寸，增量基准就会漂移
  rootRef.value?.style.setProperty("--kb-resizable-size", `${rounded}px`);
}

function handlePointerDown(event: PointerEvent) {
  if (props.disabled || event.button !== 0) return;
  resizing.value = true;
  lastPos = isHorizontal.value ? event.clientX : event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit("resize-start");
  event.preventDefault();
}

function handlePointerMove(event: PointerEvent) {
  if (!resizing.value) return;
  const pos = isHorizontal.value ? event.clientX : event.clientY;
  const delta = (pos - lastPos) * sign.value;
  if (delta === 0) return;
  lastPos = pos;
  applySize(measure() + delta);
}

function handlePointerUp(event: PointerEvent) {
  if (!resizing.value) return;
  resizing.value = false;
  const handle = event.currentTarget as HTMLElement;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  // 落盘的是 clamp 之后的真实尺寸，避免把越界的意图值持久化下来
  applySize(measure());
  emit("resize-end", size.value ?? 0);
}

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
