import type { DirectiveBinding, ObjectDirective } from "vue";

import "./pullToRefresh.scss";

const CIRCUMFERENCE = 2 * Math.PI * 10;

export type PullToRefreshValue =
  | (() => void)
  | {
      onRefresh: () => void;
      refreshing?: boolean;
      disabled?: boolean;
      threshold?: number;
      maxDistance?: number;
    };

const DEFAULT_OPTIONS = {
  onRefresh: () => {},
  refreshing: false,
  disabled: true,
  threshold: 80,
  maxDistance: 120,
};

function getOptions(value: PullToRefreshValue | undefined | null) {
  if (value == null) return DEFAULT_OPTIONS;
  if (typeof value === "function") {
    return {
      onRefresh: value,
      refreshing: false,
      disabled: false,
      threshold: 80,
      maxDistance: 120,
    };
  }
  return {
    onRefresh: value.onRefresh,
    refreshing: value.refreshing ?? false,
    disabled: value.disabled ?? false,
    threshold: value.threshold ?? 80,
    maxDistance: value.maxDistance ?? 120,
  };
}

/** 从 target 向上遍历到 boundary，找到最近的滚动容器 */
function findScrollable(target: Element, boundary: Element): HTMLElement | null {
  let current: Element | null = target;
  while (current && current !== boundary) {
    if (current instanceof HTMLElement) {
      const { scrollHeight, clientHeight } = current;
      if (scrollHeight > clientHeight) {
        const overflowY = window.getComputedStyle(current).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function createSpinnerHead(): {
  root: HTMLElement;
  indicator: HTMLElement;
  spinner: HTMLElement;
  circle: SVGCircleElement;
} {
  const root = document.createElement("div");
  root.className = "v-pull-to-refresh-head";

  const indicator = document.createElement("div");
  indicator.className = "v-pull-to-refresh-indicator";

  const spinnerWrapper = document.createElement("div");
  spinnerWrapper.className = "spinner-wrapper";

  const spinner = document.createElement("div");
  spinner.className = "spinner";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.classList.add("spinner-svg");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");
  circle.setAttribute("fill", "none");
  circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "2");
  circle.setAttribute("stroke-linecap", "round");
  circle.setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
  circle.classList.add("spinner-circle");

  svg.appendChild(circle);
  spinner.appendChild(svg);
  spinnerWrapper.appendChild(spinner);
  indicator.appendChild(spinnerWrapper);
  root.appendChild(indicator);

  return { root, indicator, spinner, circle };
}

interface State {
  head: ReturnType<typeof createSpinnerHead>;
  pullDistance: number;
  startY: number;
  isDragging: boolean;
  scrollable: HTMLElement | null;
  touchStartScrollTop: number;
}

function getState(el: HTMLElement): State | undefined {
  return (el as unknown as { _vPullToRefresh?: State })._vPullToRefresh;
}

function setState(el: HTMLElement, state: State) {
  (el as unknown as { _vPullToRefresh?: State })._vPullToRefresh = state;
}

function updateIndicator(state: State, opts: ReturnType<typeof getOptions>) {
  const { head, pullDistance } = state;
  const progress = opts.threshold <= 0 ? 0 : Math.min(pullDistance / opts.threshold, 1);
  head.indicator.style.transform = `translateX(-50%) translateY(${pullDistance}px)`;
  head.circle.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE - progress * CIRCUMFERENCE));
  head.root.classList.toggle("is-pulling", pullDistance > 10);
  head.root.classList.toggle("is-refreshing", opts.refreshing);
  head.spinner.classList.toggle("is-spinning", opts.refreshing);
  head.root.style.display = pullDistance > 0 || opts.refreshing ? "" : "none";
}

function resetPull(el: HTMLElement) {
  const state = getState(el);
  if (!state) return;
  state.pullDistance = 0;
  state.isDragging = false;
  const opts = getOptions(
    (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })._vPullToRefreshValue
  );
  updateIndicator(state, opts);
}

export const vPullToRefresh: ObjectDirective<HTMLElement, PullToRefreshValue> = {
  mounted(el, binding: DirectiveBinding<PullToRefreshValue>) {
    (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })._vPullToRefreshValue =
      binding.value;

    const head = createSpinnerHead();
    head.root.style.display = "none";
    document.body.appendChild(head.root);

    const state: State = {
      head,
      pullDistance: 0,
      startY: 0,
      isDragging: false,
      scrollable: null,
      touchStartScrollTop: 0,
    };
    setState(el, state);

    const handleTouchStart = (e: TouchEvent) => {
      const value = (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })
        ._vPullToRefreshValue;
      const opts = getOptions(value);
      if (opts.disabled || opts.refreshing) return;

      const touch = e.touches[0];
      if (!touch) return;

      const scrollable = findScrollable(e.target as Element, el);
      state.scrollable = scrollable;
      const scrollTop = scrollable ? scrollable.scrollTop : (el.scrollTop ?? 0);
      state.touchStartScrollTop = scrollTop;
      if (scrollTop > 1) return;

      state.startY = touch.clientY;
      state.isDragging = true;
      state.pullDistance = 0;
      updateIndicator(state, opts);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!state.isDragging) return;

      const value = (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })
        ._vPullToRefreshValue;
      const opts = getOptions(value);
      if (opts.disabled || opts.refreshing) return;

      const touch = e.touches[0];
      if (!touch) return;

      const deltaY = touch.clientY - state.startY;
      if (deltaY <= 0) return;

      e.preventDefault();

      let distance = deltaY;
      if (deltaY > opts.threshold) {
        const excess = deltaY - opts.threshold;
        distance = opts.threshold + excess * 0.3;
      }
      state.pullDistance = Math.min(distance, opts.maxDistance);
      updateIndicator(state, opts);
    };

    const handleTouchEnd = () => {
      if (!state.isDragging) return;

      const value = (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })
        ._vPullToRefreshValue;
      const opts = getOptions(value);

      state.isDragging = false;

      if (state.pullDistance >= opts.threshold && !opts.refreshing) {
        opts.onRefresh();
      } else {
        resetPull(el);
      }
    };

    const handlers = { handleTouchStart, handleTouchMove, handleTouchEnd };
    (el as unknown as { _vPullToRefreshHandlers?: typeof handlers })._vPullToRefreshHandlers =
      handlers;
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
  },

  updated(el, binding) {
    (el as unknown as { _vPullToRefreshValue?: PullToRefreshValue })._vPullToRefreshValue =
      binding.value;
    const state = getState(el);
    if (state) {
      const opts = getOptions(binding.value);
      updateIndicator(state, opts);
      if (!opts.refreshing && state.pullDistance > 0 && !state.isDragging) {
        setTimeout(() => resetPull(el), 300);
      }
    }
  },

  unmounted(el) {
    const state = getState(el);
    if (state?.head?.root?.parentNode) {
      state.head.root.parentNode.removeChild(state.head.root);
    }
    delete (el as unknown as { _vPullToRefresh?: State })._vPullToRefresh;
    const handlers = (el as unknown as {
      _vPullToRefreshHandlers?: {
        handleTouchStart: (e: TouchEvent) => void;
        handleTouchMove: (e: TouchEvent) => void;
        handleTouchEnd: () => void;
      };
    })._vPullToRefreshHandlers;
    if (handlers) {
      el.removeEventListener("touchstart", handlers.handleTouchStart);
      el.removeEventListener("touchmove", handlers.handleTouchMove);
      el.removeEventListener("touchend", handlers.handleTouchEnd);
    }
  },
};

