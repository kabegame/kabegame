export interface DragScrollOptions {
  /**
   * 只对鼠标/触控笔生效；触摸设备（手机/安卓）默认走系统原生滚动与惯性，避免手势冲突。
   */
  enableForPointerTypes?: Array<"mouse" | "pen">;
  /**
   * 是否需要按住空格才能拖拽滚动（推荐：避免与图片点击/拖拽/选择冲突）。
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
  // 交互控件
  "a,button,input,textarea,select,label,summary,[contenteditable='true']," +
  // element-plus
  ".el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box";

/**
 * 为一个可滚动容器启用“按住空格 + 鼠标拖拽滚动 + 惯性”。
 * - 鼠标/触控笔：自定义惯性（更像手机）。
 * - 触摸（安卓/iOS）：默认不接管，保持 WebView 原生惯性与回弹。
 */
export function enableDragScroll(
  container: HTMLElement,
  opts: DragScrollOptions = {}
) {
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
      container.dispatchEvent(
        new CustomEvent("dragscroll-active-change", { detail: { active } })
      );
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
    // 只屏蔽很短的一段时间内的 click（一次性）
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
      // 同时阻断后续监听器
      ev.stopImmediatePropagation();
      cleanupClickCapture?.();
      cleanupClickCapture = null;
    };

    container.addEventListener("click", onClickCapture, true);
    cleanupClickCapture = () =>
      container.removeEventListener("click", onClickCapture, true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!requireSpaceKey) return;
    if (e.code !== "Space") return;

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target?.isContentEditable
    )
      return;

    // 避免空格触发页面滚动
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
    if (e.button !== 0) {
      return; // 只响应左键
    }
    if (!enableForPointerTypes.includes(e.pointerType as any)) {
      return;
    }
    if (requireSpaceKey && !spaceDown) {
      return;
    }
    if (shouldIgnoreTarget(e.target)) {
      return;
    }

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
    if (!isDown) {
      // console.log("[拖拽滚动调试] pointermove: isDown=false");
      return;
    }
    if (pointerId !== e.pointerId) {
      return;
    }

    const dy = e.clientY - startY;
    if (!moved) {
      // 还没超过阈值：不要滚动、不要 preventDefault，让"单击"正常触发
      if (Math.abs(dy) < dragThresholdPx) {
        // console.log("[拖拽滚动调试] pointermove: 未超过阈值", Math.abs(dy), dragThresholdPx);
        return;
      }
      // 超过阈值：从这一刻开始进入拖拽滚动模式
      moved = true;
      container.classList.add(classActive);
      emitActiveChange(true);
      if (!hasPointerCapture) {
        try {
          container.setPointerCapture(e.pointerId);
          hasPointerCapture = true;
        } catch (err) {}
      }
      lastY = e.clientY;
      lastT = performance.now();
      velocity = 0;
    }

    // 进入拖拽滚动后：阻止文本选择等默认行为
    e.preventDefault();

    const newScrollTop = startScrollTop - dy;
    container.scrollTop = newScrollTop;
    // console.log("[拖拽滚动调试] 滚动中", { startScrollTop, dy, newScrollTop });

    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    const deltaY = e.clientY - lastY;
    // scrollTop 方向：鼠标向下拖 => 内容向上 => scrollTop 变小（负），因此取反
    velocity = -deltaY / dt;
    lastY = e.clientY;
    lastT = now;
  };

  const endPointer = (e: PointerEvent) => {
    if (!isDown) return;
    if (pointerId !== e.pointerId) return;

    isDown = false;
    pointerId = null;

    // 没有发生明显移动就不做惯性
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

    // 拖拽过：避免 mouseup 后触发点击（图片打开/选择等）
    armSuppressClick();

    const minV = 0.02; // px/ms
    if (Math.abs(velocity) < minV) return;

    let v = velocity;
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      container.scrollTop += v * dt;

      // 按帧率归一化的指数衰减：dt=16ms 时约等于 friction
      const decay = Math.pow(friction, dt / 16);
      v *= decay;

      if (Math.abs(v) < minV) {
        raf = null;
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
  };

  // 绑定事件（pointermove 需要 non-passive 才能 preventDefault）
  // 使用 capture 阶段，避免子元素（图片/组件）吞掉事件导致“拖不动”
  container.addEventListener("pointerdown", onPointerDown, {
    passive: true,
    capture: true,
  });
  container.addEventListener("pointermove", onPointerMove, {
    passive: false,
    capture: true,
  });
  container.addEventListener("pointerup", endPointer, {
    passive: true,
    capture: true,
  });
  container.addEventListener("pointercancel", endPointer, {
    passive: true,
    capture: true,
  });

  if (requireSpaceKey) {
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: true });
  }

  return () => {
    stopInertia();
    cleanupClickCapture?.();
    cleanupClickCapture = null;
    container.classList.remove(classReady);
    container.classList.remove(classActive);
    emitActiveChange(false);
    container.removeEventListener("pointerdown", onPointerDown as any, true);
    container.removeEventListener("pointermove", onPointerMove as any, true);
    container.removeEventListener("pointerup", endPointer as any, true);
    container.removeEventListener("pointercancel", endPointer as any, true);
    if (requireSpaceKey) {
      window.removeEventListener("keydown", onKeyDown as any);
      window.removeEventListener("keyup", onKeyUp as any);
    }
  };
}
