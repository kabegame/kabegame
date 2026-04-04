import { computed, onUnmounted, ref, watch, type Ref } from "vue";

type UseImageGridAutoLoadParams = {
  /**
   * `ImageGrid` 的真实滚动容器（通过 `gridRef.getContainerEl()` 获取）。
   */
  containerRef: Ref<HTMLElement | null>;
  /**
   * 每次需要"实时加载"时调用（通常传入 `loadImageUrls`）。
   *
   * 注意：这里会做 rAF 节流，且在 dragScroll 交互期间会暂停触发。
   */
  onLoad: () => void;
  /**
   * 是否启用实时滚动触发（默认 true）。
   * - 有些页面只想用 scroll-stable（停下来才加载），可关掉。
   */
  enabled?: Ref<boolean>;
  /**
   * 滚动速度超过阈值时触发（用于俏皮提示）。
   * - 检测普通滚动速度，当速度持续过快时触发。
   */
  onOverspeed?: () => void;
  /**
   * 滚动超速阈值（像素/秒），默认 8000。
   * - 超过此速度连续多次会触发 onOverspeed。
   */
  overspeedThreshold?: number;
  /**
   * 加载触发的速度阈值（像素/秒），默认 3000。
   * - 滚动速度低于此值时才会触发加载。
   * - 设为 0 或负数则禁用速度检测，始终触发加载。
   */
  loadSpeedThreshold?: number;
  /**
   * 速度低于阈值后的防抖时间（毫秒），默认 80。
   * - 速度持续低于阈值达到此时间后才真正触发加载。
   */
  loadDebounceMs?: number;
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
  const overspeedThreshold = params.overspeedThreshold ?? 8000; // 像素/秒（俏皮提示阈值）
  const loadSpeedThreshold = params.loadSpeedThreshold ?? 3000; // 像素/秒（加载触发阈值）
  const loadDebounceMs = params.loadDebounceMs ?? 80; // 防抖时间

  let cleanupContainerScrollListener: null | (() => void) = null;
  let cleanupDragScrollListener: null | (() => void) = null;
  let cleanupPreviewInteractingListener: null | (() => void) = null;

  let rafScrollScheduled = false;

  // 滚动速度检测相关变量
  let lastScrollTop = 0;
  let lastScrollTime = 0;
  let currentSpeed = 0; // 当前滚动速度
  let overspeedCount = 0; // 连续超速次数
  const OVERSPEED_TRIGGER_COUNT = 3; // 连续超速几次才触发提示
  let lastOverspeedTriggerTime = 0;
  const OVERSPEED_COOLDOWN = 5000; // 触发后冷却时间（毫秒）

  // 加载防抖相关
  let loadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // 滚动结束兜底：用于“滚太快 -> 速度阈值拦截 -> 停住后不再有低速 scroll 事件”的场景
  let scrollEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let skippedDueToSpeed = false;

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
    if (loadDebounceTimer) {
      clearTimeout(loadDebounceTimer);
      loadDebounceTimer = null;
    }
    if (scrollEndFallbackTimer) {
      clearTimeout(scrollEndFallbackTimer);
      scrollEndFallbackTimer = null;
    }
    skippedDueToSpeed = false;
    if (!el) return;

    // 初始化滚动检测
    lastScrollTop = el.scrollTop;
    lastScrollTime = performance.now();
    currentSpeed = 0;
    overspeedCount = 0;

    const scheduleLoad = () => {
      // 清除旧的防抖定时器
      if (loadDebounceTimer) {
        clearTimeout(loadDebounceTimer);
        loadDebounceTimer = null;
      }

      // 速度检测禁用时（阈值 <= 0），直接用 rAF 触发
      if (loadSpeedThreshold <= 0) {
        skippedDueToSpeed = false;
        if (rafScrollScheduled) return;
        rafScrollScheduled = true;
        requestAnimationFrame(() => {
          rafScrollScheduled = false;
          if (isDragScrolling.value) return;
          params.onLoad();
        });
        return;
      }

      // 速度高于阈值时，不触发加载，等速度降下来
      if (currentSpeed > loadSpeedThreshold) {
        skippedDueToSpeed = true;
        return;
      }

      // 速度低于阈值，启动防抖定时器
      loadDebounceTimer = setTimeout(() => {
        loadDebounceTimer = null;
        if (!enabled.value) return;
        if (isDragScrolling.value) return;
        skippedDueToSpeed = false;
        params.onLoad();
      }, loadDebounceMs);
    };

    const onScroll = () => {
      if (!enabled.value) return;

      // 计算滚动速度
      const now = performance.now();
      const dt = now - lastScrollTime;
      if (dt > 0) {
        const dy = Math.abs(el.scrollTop - lastScrollTop);
        currentSpeed = (dy / dt) * 1000; // 像素/秒

        // 俏皮提示：超速检测
        if (params.onOverspeed) {
          if (currentSpeed > overspeedThreshold) {
            overspeedCount++;
            if (
              overspeedCount >= OVERSPEED_TRIGGER_COUNT &&
              now - lastOverspeedTriggerTime > OVERSPEED_COOLDOWN
            ) {
              params.onOverspeed();
              lastOverspeedTriggerTime = now;
              overspeedCount = 0;
            }
          } else {
            // 速度降下来就重置计数
            overspeedCount = 0;
          }
        }
      }
      lastScrollTop = el.scrollTop;
      lastScrollTime = now;

      // 触发加载（带速度防抖）
      scheduleLoad();

      // 兜底：当“速度阈值拦截”导致 scheduleLoad 没有设置定时器时，
      // 若用户高速滚动后直接停住，可能不会再产生低速 scroll 事件，从而一直不触发加载。
      // 用“滚动结束（短时间无 scroll 事件）”来补一次。
      if (scrollEndFallbackTimer) {
        clearTimeout(scrollEndFallbackTimer);
        scrollEndFallbackTimer = null;
      }
      scrollEndFallbackTimer = setTimeout(() => {
        scrollEndFallbackTimer = null;
        if (!enabled.value) return;
        if (isDragScrolling.value) return;
        if (!skippedDueToSpeed) return;
        skippedDueToSpeed = false;
        params.onLoad();
      }, Math.max(80, loadDebounceMs));
    };

    const onDragScrollActiveChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { active?: boolean }
        | undefined;
      isDragScrolling.value = !!detail?.active;
    };

    const onPreviewInteractingChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { active?: boolean }
        | undefined;
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
    if (loadDebounceTimer) {
      clearTimeout(loadDebounceTimer);
      loadDebounceTimer = null;
    }
    if (scrollEndFallbackTimer) {
      clearTimeout(scrollEndFallbackTimer);
      scrollEndFallbackTimer = null;
    }
  });

  return {
    isDragScrolling,
    isPreviewInteracting,
    isInteracting,
  };
}
