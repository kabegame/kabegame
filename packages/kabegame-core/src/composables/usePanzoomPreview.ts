import type { Ref } from "vue";
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import Panzoom from "@panzoom/panzoom";
import type { PanzoomObject } from "@panzoom/panzoom";

type PanzoomOptions = NonNullable<Parameters<typeof Panzoom>[1]>;

export interface UsePanzoomPreviewOptions {
  /** 可见时且 enabled 时创建实例；回调在 panzoomstart 时调用 */
  onPanzoomStart?: () => void;
  /** 回调在 panzoomend 时调用（如延迟关闭 interacting 状态） */
  onPanzoomEnd?: () => void;
  /** 覆盖默认的 Panzoom 选项 */
  panzoomOptions?: Partial<Parameters<typeof Panzoom>[1]>;
}

const DEFAULT_MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 10;
const DEFAULT_START_SCALE = 1;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_HEIGHT = 16;

const DEFAULT_OPTIONS: PanzoomOptions = {
  contain: "outside",
  panOnlyWhenZoomed: true,
  minScale: DEFAULT_MIN_SCALE,
  maxScale: DEFAULT_MAX_SCALE,
  step: 0.3,
  animate: false,
  cursor: "default",
  noBind: false,
};

/**
 * 桌面端图片预览的 Panzoom 封装：根据 visible + enabled 创建/销毁实例，
 * 暴露 wrapperRef、handleWheel、reset、destroy，并驱动 onPanzoomStart/End 回调。
 */
export function usePanzoomPreview(
  visible: Ref<boolean>,
  enabled: Ref<boolean>,
  options?: UsePanzoomPreviewOptions
) {
  const wrapperRef = ref<HTMLElement | null>(null);
  const scale = ref(1);
  let instance: PanzoomObject | null = null;
  let instanceEl: HTMLElement | null = null;
  /** 当前实例真正生效的 options（含调用方覆盖），仅用于推导 canPan；无实例时为 null */
  const activeOptions = shallowRef<PanzoomOptions | null>(null);

  /**
   * 此刻按住拖动会不会真的产生位移。
   *
   * panzoom 的 `pan()` 在 `disablePan || (panOnlyWhenZoomed && scale === startScale)` 时
   * 直接 return（@panzoom/panzoom dist/panzoom.js:475），即未缩放时拖动是彻底的空操作。
   * 这段区间里 pointerdown 的默认行为对 panzoom 毫无价值，可以整个让给浏览器——
   * 见 handleStartEvent。
   */
  const canPan = computed(() => {
    const opts = activeOptions.value;
    if (!opts) return false;
    if (opts.disablePan) return false;
    if (!opts.panOnlyWhenZoomed) return true;
    return scale.value !== Number(opts.startScale ?? DEFAULT_START_SCALE);
  });

  /**
   * 替换 panzoom 默认的 handleStartEvent（默认实现无条件 preventDefault + stopPropagation）。
   *
   * pointerdown 上的 preventDefault 会让 Chromium 放弃原生 HTML5 拖拽——连拖拽残影都不会生成，
   * 于是图片在 webview 里完全拖不动。这里只在拖动确实会平移画面时才吞掉默认行为；
   * 未缩放时放行，图片便可像普通网页一样被拖出（`ImageContent` 的 nativeDrag 同步放开 draggable）。
   */
  const handleStartEvent = (event: Event) => {
    if (!canPan.value) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePanzoomStart = () => {
    options?.onPanzoomStart?.();
  };

  const handlePanzoomEnd = () => {
    options?.onPanzoomEnd?.();
  };

  const handlePanzoomChange = () => {
    if (!instance) return;
    scale.value = instance.getScale();
    instance.setOptions({ cursor: scale.value > 1 ? "grab" : "default" });
  };

  const destroy = () => {
    if (instanceEl) {
      instanceEl.removeEventListener("panzoomstart", handlePanzoomStart);
      instanceEl.removeEventListener("panzoomend", handlePanzoomEnd);
      instanceEl.removeEventListener("panzoomchange", handlePanzoomChange);
    }
    if (instance) {
      instance.destroy();
      instance = null;
    }
    instanceEl = null;
    activeOptions.value = null;
    scale.value = 1;
  };

  const create = (el: HTMLElement) => {
    if (instance && instanceEl === el) return;
    destroy();
    const resolved: PanzoomOptions = {
      ...DEFAULT_OPTIONS,
      ...options?.panzoomOptions,
    };
    // 调用方未显式覆盖时才接管，避免悄悄吃掉外部传入的 handleStartEvent
    resolved.handleStartEvent ??= handleStartEvent;
    instance = Panzoom(el, resolved);
    activeOptions.value = resolved;
    instanceEl = el;
    scale.value = instance.getScale();
    el.addEventListener("panzoomstart", handlePanzoomStart);
    el.addEventListener("panzoomend", handlePanzoomEnd);
    el.addEventListener("panzoomchange", handlePanzoomChange);
  };

  watch(
    () => [visible.value && enabled.value, wrapperRef.value] as const,
    ([shouldInit, wrapper]) => {
      if (!shouldInit || !wrapper) {
        destroy();
        return;
      }
      if (instanceEl && instanceEl !== wrapper) {
        destroy();
      }
      nextTick(() => {
        if (!visible.value || !enabled.value || wrapperRef.value !== wrapper) return;
        create(wrapper);
      });
    },
    { immediate: true }
  );

  onUnmounted(destroy);

  const getWheelDelta = (event: WheelEvent) => {
    if (event.deltaMode === WHEEL_DELTA_LINE) {
      return {
        x: event.deltaX * WHEEL_LINE_HEIGHT,
        y: event.deltaY * WHEEL_LINE_HEIGHT,
      };
    }
    if (event.deltaMode === WHEEL_DELTA_PAGE) {
      const rect = instanceEl?.parentElement?.getBoundingClientRect();
      return {
        x: event.deltaX * (rect?.width || window.innerWidth),
        y: event.deltaY * (rect?.height || window.innerHeight),
      };
    }
    return {
      x: event.deltaX,
      y: event.deltaY,
    };
  };

  const handleWheel = (event: WheelEvent) => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl || !visible.value || !enabled.value) return;
    let handled = false;
    if (event.ctrlKey) {
      options?.onPanzoomStart?.();
      instance.zoomWithWheel(event, { animate: false });
      handled = true;
    } else if (!event.altKey && !event.metaKey && !event.shiftKey) {
      options?.onPanzoomStart?.();
      const { x, y } = getWheelDelta(event);
      const currentScale = instance.getScale();
      instance.pan(-x / currentScale, -y / currentScale, { animate: false, relative: true });
      handled = true;
    }
    scale.value = instance.getScale();
    if (handled) options?.onPanzoomEnd?.();
  };

  const reset = () => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl) return;
    instance?.reset({ animate: false });
    scale.value = instance.getScale();
  };

  const zoomIn = () => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl) return;
    instance.zoomIn({ step: 0.2, animate: true });
    scale.value = instance.getScale();
  };

  const zoomOut = () => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl) return;
    instance.zoomOut({ step: 0.2, animate: true });
    scale.value = instance.getScale();
  };

  const zoomTo = (nextScale: number, animate = false) => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl) return;
    const minScale = Number(instance.getOptions().minScale ?? DEFAULT_MIN_SCALE);
    const maxScale = Number(instance.getOptions().maxScale ?? DEFAULT_MAX_SCALE);
    const safeScale = Math.min(maxScale, Math.max(minScale, Number.isFinite(nextScale) ? nextScale : minScale));
    instance.zoom(safeScale, { animate });
    scale.value = instance.getScale();
  };

  return {
    wrapperRef,
    scale,
    canPan,
    handleWheel,
    reset,
    destroy,
    zoomIn,
    zoomOut,
    zoomTo,
  };
}
