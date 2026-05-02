/**
 * trailing throttle（带尾触发）：在高频触发下，最多每 `waitMs` 执行一次，
 * 且保证“最后一次触发”不会丢（会在窗口结束后补执行一次）。
 *
 * - 第一次触发：立即执行（leading）
 * - 窗口内多次触发：只记住最后一次参数，窗口结束后执行（trailing）
 */
export function useTrailingThrottleFn<TArgs extends any[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  waitMs: number
) {
  let lastRunAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: TArgs | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = async (args: TArgs) => {
    lastRunAt = Date.now();
    await fn(...args);
  };

  const scheduleTrailing = (delayMs: number) => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!pendingArgs) return;
      const args = pendingArgs;
      pendingArgs = null;
      await run(args);
    }, Math.max(0, delayMs));
  };

  const trigger = async (...args: TArgs) => {
    pendingArgs = args;
    const now = Date.now();
    const elapsed = now - lastRunAt;

    // 第一次或超过窗口：立即执行，并清掉可能的 trailing 计划
    if (lastRunAt === 0 || elapsed >= waitMs) {
      clearTimer();
      const a = pendingArgs;
      pendingArgs = null;
      if (a) await run(a);
      return;
    }

    // 窗口内：安排一次 trailing（保证最后一次不丢）
    scheduleTrailing(waitMs - elapsed);
  };

  const cancel = () => {
    clearTimer();
    pendingArgs = null;
  };

  const flush = async () => {
    clearTimer();
    if (!pendingArgs) return;
    const a = pendingArgs;
    pendingArgs = null;
    await run(a);
  };

  return { trigger, cancel, flush };
}

