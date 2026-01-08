import { computed, onUnmounted, ref, watch, type Ref } from "vue";

type UseImageGridAutoLoadParams = {
  /**
   * `ImageGrid` 的真实滚动容器（通过 `gridRef.getContainerEl()` 获取）。
   */
  containerRef: Ref<HTMLElement | null>;
  /**
   * 每次需要“实时加载”时调用（通常传入 `loadImageUrls`）。
   *
   * 注意：这里会做 rAF 节流，且在 dragScroll 交互期间会暂停触发。
   */
  onLoad: () => void;
  /**
   * 是否启用实时滚动触发（默认 true）。
   * - 有些页面只想用 scroll-stable（停下来才加载），可关掉。
   */
  enabled?: Ref<boolean>;
};

/**
 * 抽取自 Gallery：在滚动时用 rAF 节流“实时触发”图片 URL 加载，
 * 并在 dragScroll/预览交互期间暂停后台加载，优先保证交互帧率。
 *
 * 依赖的事件：
 * - 容器上的 `dragscroll-active-change`（`useDragScroll` 会派发）
 * - window 上的 `preview-interacting-change`（预览组件会派发）
 */
export function useImageGridAutoLoad(params: UseImageGridAutoLoadParams) {
  const isDragScrolling = ref(false);
  const isPreviewInteracting = ref(false);
  const isInteracting = computed(
    () => isDragScrolling.value || isPreviewInteracting.value
  );

  const enabled = params.enabled ?? ref(true);

  let cleanupContainerScrollListener: null | (() => void) = null;
  let cleanupDragScrollListener: null | (() => void) = null;
  let cleanupPreviewInteractingListener: null | (() => void) = null;

  let rafScrollScheduled = false;

  const bindContainerScrollListener = (el: HTMLElement | null) => {
    if (cleanupContainerScrollListener) {
      cleanupContainerScrollListener();
      cleanupContainerScrollListener = null;
    }
    if (cleanupDragScrollListener) {
      cleanupDragScrollListener();
      cleanupDragScrollListener = null;
    }
    if (cleanupPreviewInteractingListener) {
      cleanupPreviewInteractingListener();
      cleanupPreviewInteractingListener = null;
    }
    if (!el) return;

    const onScroll = () => {
      if (!enabled.value) return;
      if (rafScrollScheduled) return;
      rafScrollScheduled = true;
      requestAnimationFrame(() => {
        rafScrollScheduled = false;
        // dragScroll 期间不做“实时加载”，避免 readFile/Blob 创建抢主线程导致掉帧
        // 交互结束后会由 scroll-stable 再补齐
        if (isDragScrolling.value) return;
        params.onLoad();
      });
    };

    const onDragScrollActiveChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { active?: boolean } | undefined;
      isDragScrolling.value = !!detail?.active;
    };

    const onPreviewInteractingChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { active?: boolean } | undefined;
      isPreviewInteracting.value = !!detail?.active;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener(
      "dragscroll-active-change",
      onDragScrollActiveChange as any
    );
    window.addEventListener(
      "preview-interacting-change",
      onPreviewInteractingChange as any
    );

    cleanupContainerScrollListener = () => {
      el.removeEventListener("scroll", onScroll as any);
    };
    cleanupDragScrollListener = () => {
      el.removeEventListener(
        "dragscroll-active-change",
        onDragScrollActiveChange as any
      );
    };
    cleanupPreviewInteractingListener = () => {
      window.removeEventListener(
        "preview-interacting-change",
        onPreviewInteractingChange as any
      );
    };
  };

  watch(
    () => params.containerRef.value,
    (el) => bindContainerScrollListener(el),
    { immediate: true }
  );

  // enabled 切换时，主动触发一次，避免“开关恢复后要等用户滚动”
  watch(
    () => enabled.value,
    (v) => {
      if (!v) return;
      if (!params.containerRef.value) return;
      requestAnimationFrame(() => params.onLoad());
    }
  );

  onUnmounted(() => {
    if (cleanupContainerScrollListener) cleanupContainerScrollListener();
    cleanupContainerScrollListener = null;
    if (cleanupDragScrollListener) cleanupDragScrollListener();
    cleanupDragScrollListener = null;
    if (cleanupPreviewInteractingListener) cleanupPreviewInteractingListener();
    cleanupPreviewInteractingListener = null;
  });

  return {
    isDragScrolling,
    isPreviewInteracting,
    isInteracting,
  };
}






