import type { Ref } from "vue";
import { nextTick, onUnmounted, ref, watch } from "vue";
import Panzoom from "@panzoom/panzoom";
import type { PanzoomObject } from "@panzoom/panzoom";

export interface UsePanzoomPreviewOptions {
  /** 可见时且 enabled 时创建实例；回调在 panzoomstart 时调用 */
  onPanzoomStart?: () => void;
  /** 回调在 panzoomend 时调用（如延迟关闭 interacting 状态） */
  onPanzoomEnd?: () => void;
  /** 覆盖默认的 Panzoom 选项 */
  panzoomOptions?: Partial<Parameters<typeof Panzoom>[1]>;
}

const DEFAULT_OPTIONS: Parameters<typeof Panzoom>[1] = {
  contain: "outside",
  panOnlyWhenZoomed: true,
  minScale: 1,
  maxScale: 10,
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
  let instance: PanzoomObject | null = null;
  let instanceEl: HTMLElement | null = null;

  const handlePanzoomStart = () => {
    options?.onPanzoomStart?.();
  };

  const handlePanzoomEnd = () => {
    options?.onPanzoomEnd?.();
  };

  const handlePanzoomChange = () => {
    if (!instance) return;
    const scale = instance.getScale();
    instance.setOptions({ cursor: scale > 1 ? "grab" : "default" });
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
  };

  const create = (el: HTMLElement) => {
    if (instance && instanceEl === el) return;
    destroy();
    instance = Panzoom(el, {
      ...DEFAULT_OPTIONS,
      ...options?.panzoomOptions,
    });
    instanceEl = el;
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

  const handleWheel = (event: WheelEvent) => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl || !visible.value || !enabled.value) return;
    options?.onPanzoomStart?.();
    instance.zoomWithWheel(event, { animate: false });
  };

  const reset = () => {
    if (!instance || !instanceEl || wrapperRef.value !== instanceEl) return;
    instance?.reset({ animate: false });
  };

  return {
    wrapperRef,
    handleWheel,
    reset,
    destroy,
  };
}
