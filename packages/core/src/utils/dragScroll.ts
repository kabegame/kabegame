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
   * 拖拽滚动时的惯性减速系数（越接近 1 越"滑"）。
   */
  friction?: number; // per ~16ms
  /**
   * 触发"认为是在拖拽滚动"的最小移动距离（px）
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
   * 拖拽过后拦截紧随其后的 click（防止"拖动时误触发点击打开图片"等）
   */
  suppressClickAfterDrag?: boolean;

  /**
   * 当拖拽滚动"太快且仍在加速"时派发事件：
   * `new CustomEvent(overspeedEventName, { detail: { velocity, absVelocity, absAccel } })`
   *
   * - velocity: px/ms（scrollTop 方向：正=向下滚）
   * - absVelocity: |velocity|
   * - absAccel: d(|v|)/dt，单位 px/ms^2（仅用于判断"是否在加速"）
   */
  overspeedEventName?: string;
  /**
   * 触发 overspeed 的最小瞬时速度阈值（px/ms）
   */
  overspeedVelocityThresholdPxPerMs?: number;
  /**
   * 触发 overspeed 的最小加速度阈值（px/ms^2）
   */
  overspeedAccelThresholdPxPerMs2?: number;

  /**
   * 限制拖拽滚动的最大速度（px/ms）。
   * - 可以是固定数值，也可以是返回数值的函数（支持动态行高等场景）
   * - 例如：每 0.2 秒滚动一行 => maxVelocityPxPerMs = rowHeight / 200
   */
  maxVelocityPxPerMs?: number | (() => number);
}

const DEFAULT_IGNORE_SELECTOR =
  "a,button,input,textarea,select,label,summary,[contenteditable='true']," +
  ".el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box";

/**
 * 为一个可滚动容器启用“按住空格 + 鼠标拖拽滚动 + 惯性”。
 * - 鼠标/触控笔：自定义惯性
 * - 触摸（安卓/iOS）：默认不接管
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
  const overspeedEventName = opts.overspeedEventName ?? "dragscroll-overspeed";
  const overspeedVelocityThresholdPxPerMs =
    opts.overspeedVelocityThresholdPxPerMs ?? 10;
  const overspeedAccelThresholdPxPerMs2 =
    opts.overspeedAccelThresholdPxPerMs2 ?? 0.05;
  const maxVelocityOpt = opts.maxVelocityPxPerMs;

  // 获取当前最大速度（支持动态值）
  const getMaxVelocity = (): number | null => {
    if (maxVelocityOpt == null) return null;
    return typeof maxVelocityOpt === "function"
      ? maxVelocityOpt()
      : maxVelocityOpt;
  };

  // 截断速度到最大值
  const clampVelocity = (v: number): number => {
    const maxV = getMaxVelocity();
    if (maxV == null || maxV <= 0) return v;
    return Math.max(-maxV, Math.min(maxV, v));
  };

  let spaceDown = false;
  let isDown = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  // px/ms。正 vx = 向右滚；正 vy = 向下滚。
  let velocityX = 0;
  let velocityY = 0;
  let prevAbsVelocity = 0; // 用于计算“加速”（d|v|/dt），取 |v| 模长
  // “一次拖拽（按下到松开）内只提示一次”
  let overspeedShownThisDrag = false;
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
    startX = e.clientX;
    startY = e.clientY;
    startScrollLeft = container.scrollLeft;
    startScrollTop = container.scrollTop;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = performance.now();
    velocityX = 0;
    velocityY = 0;
    prevAbsVelocity = 0;
    overspeedShownThisDrag = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDown) return;
    if (pointerId !== e.pointerId) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);
    if (!moved) {
      if (dist < dragThresholdPx) return;
      moved = true;
      container.classList.add(classActive);
      emitActiveChange(true);
      if (!hasPointerCapture) {
        try {
          container.setPointerCapture(e.pointerId);
          hasPointerCapture = true;
        } catch {}
      }
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = performance.now();
      velocityX = 0;
      velocityY = 0;
      prevAbsVelocity = 0;
      overspeedShownThisDrag = false;
    }

    e.preventDefault();
    // “抓取拖动”：按下位置跟随手指，scrollLeft/Top 与 dx/dy 反向移动。
    // 不可滚动的轴浏览器会忽略写入，无需额外判断。
    container.scrollLeft = startScrollLeft - dx;
    container.scrollTop = startScrollTop - dy;

    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;
    velocityX = clampVelocity(-deltaX / dt);
    velocityY = clampVelocity(-deltaY / dt);

    // “太快且仍在加速”提示：按 |v| 模长 和 d|v|/dt 判断
    // - 用户需求：只在加速状态弹（absAccel > 0），且速度足够大
    // - 且：一次拖拽（按下到松开）内只提示一次
    try {
      const absV = Math.hypot(velocityX, velocityY);
      const absAccel = (absV - prevAbsVelocity) / dt; // px/ms^2
      const isAccelerating = absAccel >= overspeedAccelThresholdPxPerMs2;
      const isTooFast = absV >= overspeedVelocityThresholdPxPerMs;
      if (isTooFast && isAccelerating && !overspeedShownThisDrag) {
        container.dispatchEvent(
          new CustomEvent(overspeedEventName, {
            detail: { velocity: velocityY, absVelocity: absV, absAccel },
          })
        );
        overspeedShownThisDrag = true;
      }
      prevAbsVelocity = absV;
    } catch {
      // ignore
    }

    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
  };

  const endPointer = (e: PointerEvent) => {
    if (!isDown) return;
    if (pointerId !== e.pointerId) return;

    isDown = false;
    pointerId = null;
    overspeedShownThisDrag = false;

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
    if (Math.hypot(velocityX, velocityY) < minV) return;

    // 惯性阶段开始时也截断速度
    let vx = clampVelocity(velocityX);
    let vy = clampVelocity(velocityY);
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      container.scrollLeft += vx * dt;
      container.scrollTop += vy * dt;
      const decay = Math.pow(friction, dt / 16.0);
      vx *= decay;
      vy *= decay;

      if (Math.hypot(vx, vy) < minV) {
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
  container.addEventListener("pointerdown", onPointerDown, { capture: true });
  container.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  container.addEventListener("pointerup", onPointerUp, { capture: true });
  container.addEventListener("pointercancel", onPointerCancel, { capture: true });

  return () => {
    stopInertia();
    cleanupClickCapture?.();
    cleanupClickCapture = null;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    container.removeEventListener("pointerdown", onPointerDown, { capture: true } as any);
    container.removeEventListener("pointermove", onPointerMove, { capture: true } as any);
    container.removeEventListener("pointerup", onPointerUp, { capture: true } as any);
    container.removeEventListener("pointercancel", onPointerCancel, { capture: true } as any);
    container.classList.remove(classReady);
    container.classList.remove(classActive);
  };
}
