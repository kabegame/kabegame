export interface DragScrollOptions {
  /**
   * 只对鼠标/触控笔生效；触摸设备默认走系统原生滚动与惯性，避免手势冲突。
   */
  enableForPointerTypes?: Array<"mouse" | "pen">;
  /**
   * 是否需要按住空格才能拖拽滚动。
   */
  requireSpaceKey?: boolean;
  /**
   * 拖拽滚动时的惯性减速系数（越接近 1 越“滑”）。
   */
  friction?: number; // per ~16ms
  /**
   * 触发“认为是在拖拽滚动”的最小移动距离（px）
   */
  dragThresholdPx?: number;
  /**
   * 忽略拖拽滚动的目标选择器（命中则不启动拖拽滚动）
   */
  ignoreSelector?: string;
  /**
   * 给容器加的样式类：按住空格提示态 / 正在拖拽态
   */
  classReady?: string;
  classActive?: string;
  /**
   * 拖拽过后拦截紧随其后的 click（防止“拖动时误触发点击打开图片”等）
   */
  suppressClickAfterDrag?: boolean;
}

const DEFAULT_IGNORE_SELECTOR =
  "a,button,input,textarea,select,label,summary,[contenteditable='true']," +
  ".el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box";

/**
 * 为一个可滚动容器启用“按住空格 + 鼠标拖拽滚动 + 惯性”。
 * - 鼠标/触控笔：自定义惯性
 * - 触摸（安卓/iOS）：默认不接管
 */
export function enableDragScroll(container: HTMLElement, opts: DragScrollOptions = {}) {
  const enableForPointerTypes = opts.enableForPointerTypes ?? ["mouse", "pen"];
  const requireSpaceKey = opts.requireSpaceKey ?? true;
  const friction = opts.friction ?? 0.92;
  const dragThresholdPx = opts.dragThresholdPx ?? 6;
  const ignoreSelector = opts.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR;
  const classReady = opts.classReady ?? "drag-scroll-ready";
  const classActive = opts.classActive ?? "drag-scroll-active";
  const suppressClickAfterDrag = opts.suppressClickAfterDrag ?? true;

  let spaceDown = false;
  let isDown = false;
  let pointerId: number | null = null;
  let startY = 0;
  let startScrollTop = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px/ms (scrollTop 方向：正=向下滚)
  let raf: number | null = null;
  let moved = false;
  let hasPointerCapture = false;
  let suppressClickUntil = 0;
  let cleanupClickCapture: (() => void) | null = null;

  const emitActiveChange = (active: boolean) => {
    try {
      container.dispatchEvent(new CustomEvent("dragscroll-active-change", { detail: { active } }));
    } catch {
      // ignore
    }
  };

  const stopInertia = () => {
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  };

  const shouldIgnoreTarget = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    if (!el) return true;
    if (!ignoreSelector) return false;
    return !!el.closest(ignoreSelector);
  };

  const armSuppressClick = () => {
    if (!suppressClickAfterDrag) return;
    suppressClickUntil = performance.now() + 350;
    if (cleanupClickCapture) return;

    const onClickCapture = (ev: MouseEvent) => {
      if (performance.now() > suppressClickUntil) {
        cleanupClickCapture?.();
        cleanupClickCapture = null;
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      cleanupClickCapture?.();
      cleanupClickCapture = null;
    };

    container.addEventListener("click", onClickCapture, true);
    cleanupClickCapture = () => container.removeEventListener("click", onClickCapture, true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!requireSpaceKey) return;
    if (e.code !== "Space") return;

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      container.classList.add(classReady);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!requireSpaceKey) return;
    if (e.code !== "Space") return;
    if (spaceDown) {
      spaceDown = false;
      container.classList.remove(classReady);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (!enableForPointerTypes.includes(e.pointerType as any)) return;
    if (requireSpaceKey && !spaceDown) return;
    if (shouldIgnoreTarget(e.target)) return;

    stopInertia();
    cleanupClickCapture?.();
    cleanupClickCapture = null;
    isDown = true;
    moved = false;
    hasPointerCapture = false;
    pointerId = e.pointerId;
    startY = e.clientY;
    startScrollTop = container.scrollTop;
    lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDown) return;
    if (pointerId !== e.pointerId) return;

    const dy = e.clientY - startY;
    if (!moved) {
      if (Math.abs(dy) < dragThresholdPx) return;
      moved = true;
      container.classList.add(classActive);
      emitActiveChange(true);
      if (!hasPointerCapture) {
        try {
          container.setPointerCapture(e.pointerId);
          hasPointerCapture = true;
        } catch { }
      }
      lastY = e.clientY;
      lastT = performance.now();
      velocity = 0;
    }

    e.preventDefault();
    container.scrollTop = startScrollTop - dy;

    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    const deltaY = e.clientY - lastY;
    velocity = -deltaY / dt;
    lastY = e.clientY;
    lastT = now;
  };

  const endPointer = (e: PointerEvent) => {
    if (!isDown) return;
    if (pointerId !== e.pointerId) return;

    isDown = false;
    pointerId = null;

    if (!moved) return;

    container.classList.remove(classActive);
    emitActiveChange(false);
    if (hasPointerCapture) {
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      } finally {
        hasPointerCapture = false;
      }
    }

    armSuppressClick();

    const minV = 0.02;
    if (Math.abs(velocity) < minV) return;

    let v = velocity;
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      container.scrollTop += v * dt;
      v *= Math.pow(friction, dt / 16.0);

      if (Math.abs(v) < minV) {
        raf = null;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const onPointerUp = (e: PointerEvent) => endPointer(e);
  const onPointerCancel = (e: PointerEvent) => endPointer(e);

  const onBlur = () => {
    if (spaceDown) {
      spaceDown = false;
      container.classList.remove(classReady);
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerCancel);

  return () => {
    stopInertia();
    cleanupClickCapture?.();
    cleanupClickCapture = null;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerCancel);
    container.classList.remove(classReady);
    container.classList.remove(classActive);
  };
}


