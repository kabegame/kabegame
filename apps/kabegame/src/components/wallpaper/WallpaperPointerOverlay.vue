<script setup lang="ts">
/**
 * 预览里盖在壁纸画布之上的透明覆盖层：放在 Panzoom 变换层之外（兄弟、在上），不跟着放大；只拦截真实鼠标、不转发，
 * 壁纸里的鼠标由 Rust 直接注入 iframe（`framePointer.ts`），覆盖层挡不住。有了它，鼠标在壁纸上移动时预览容器照常收到
 * `mousemove`（翻页箭头）。透明、不写 z-index，箭头与工具条照常在它上面。
 *
 * 放大后的平移由这里决定（Panzoom 自己的绑定按下那一刻就定了，也不分按键，所以不用它的）：
 * - 左键：每次移动看 `ctrlKey`，没按 Ctrl 就平移、按着就不平移（留给壁纸交互），所以途中松开 / 按下 Ctrl 会接着 / 停下平移。
 *   只看指针事件的修饰键、不听键盘：拖动中焦点可能在 iframe 里（`keepFocusOutOfFrames` 等左键松开才还），父页面收不到按键。
 *   平移时同一次拖动也照常注入进了壁纸（接受）。
 * - 中键：平移，不看 Ctrl；一律阻止默认（中键自动滚动）。
 * - 右键：冒泡到预览容器弹菜单；滚轮：冒泡到预览容器，同图片（Ctrl+滚轮缩放、滚轮平移）。
 * 平移开始后的移动与松开由 Panzoom 挂在 document 上的监听处理；这里捕获指针，拖出覆盖层也不断。
 *
 * 画布里要能点的元素（带 `data-wallpaper-clickable`，如缩略图底部的「我就要看」）在覆盖层下面收不到点击：左键按下时按位置
 * （`document.elementsFromPoint`）找到它就不平移，松开时还在同一个元素上就 `click()` 它；悬停时光标为手形。
 */
import { ref } from "vue";
import { WALLPAPER_CLICKABLE_SELECTOR } from "./framePointer";

const props = defineProps<{
  /** 现在拖得动（已放大） */
  pannable: boolean;
  /** 从这个事件开始平移，返回是否开始了 */
  startPan: (event: PointerEvent) => boolean;
  /** 提前结束平移 */
  endPan: (event: PointerEvent) => void;
}>();

const panning = ref(false);
/** 光标下有能点的元素 */
const overClickable = ref(false);
/** 按住的是左键、且按下时拖得动：之后每次移动按 Ctrl 决定平移与否 */
let leftDrag = false;
/** 左键按下时光标下那个能点的元素：松开时还在它上面才转交点击 */
let pressed: HTMLElement | null = null;

/** 光标下能点的元素：覆盖层自己在最上面，按从上到下找第一个落在带属性的元素里的 */
function clickableAt(event: PointerEvent): HTMLElement | null {
  const elements = document.elementsFromPoint?.(event.clientX, event.clientY) ?? [];
  for (const element of elements) {
    const hit = element.closest<HTMLElement>(WALLPAPER_CLICKABLE_SELECTOR);
    if (hit) return hit;
  }
  return null;
}

function onPointerDown(event: PointerEvent) {
  if (event.button === 1) event.preventDefault();
  if (event.button === 0) {
    pressed = clickableAt(event);
    if (pressed) return;
  }
  if ((event.button !== 0 && event.button !== 1) || !props.pannable) return;
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  leftDrag = event.button === 0;
  panning.value = event.button === 1 || !event.ctrlKey ? props.startPan(event) : false;
}

function onPointerMove(event: PointerEvent) {
  if (!leftDrag) {
    overClickable.value = clickableAt(event) !== null;
    return;
  }
  if (!event.ctrlKey && !panning.value) {
    panning.value = props.startPan(event);
  } else if (event.ctrlKey && panning.value) {
    props.endPan(event);
    panning.value = false;
  }
}

function onPointerUp(event: PointerEvent) {
  const target = pressed;
  pressed = null;
  if (target && event.button === 0 && clickableAt(event) === target) target.click();
  onPointerEnd();
}

function onPointerEnd() {
  leftDrag = false;
  panning.value = false;
}

function onPointerCancel() {
  pressed = null;
  onPointerEnd();
}
</script>

<template>
  <div
    class="absolute inset-0"
    :class="panning ? 'cursor-grabbing' : overClickable ? 'cursor-pointer' : pannable ? 'cursor-grab' : ''"
    data-wallpaper-pointer-overlay
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerEnd"
  />
</template>
