import { defineStore } from "pinia";
import { IS_DEV } from "@kabegame/core/env";

export const FRAME_MONITOR_SAMPLE_MS = 300;
export const FRAME_MONITOR_LOW_FPS = 20;

export type FrameMonitorLevel = "ok" | "warn" | "bad";

export type FrameMonitorSnapshot = {
  minFps: number;
  avgFps: number;
  sampledAt: number;
  sampleMs: number;
  frameCount: number;
};

export type FrameMonitorHookOptions = {
  // 间隔时间
  intervalMs: number;
  // 该时间段内小于最小fps时触发回调
  thresholdMinFps?: number;
  // 该时间段内小于平均fps时触发回调
  thresholdAvgFps?: number;
  // 当间隔时间到达，只要小于某值或者平均值，就调用
  callback: (snapshot: FrameMonitorSnapshot) => void;
};

// 一个钩子对象
type RegisteredHook = FrameMonitorHookOptions & {
  id: number;
  // 积累的帧数
  accFrames: number;
  // 当前窗口最慢fps
  minFPS?: number;
  // 最后一次触发时间
  lastTriggerred: number;
  // 最后一次记录时间
  lastRecorded: number;
};

export const getFrameMonitorLevel = (value: number | null): FrameMonitorLevel => {
  if (value === null || value >= 30) return "ok";
  if (value >= FRAME_MONITOR_LOW_FPS) return "warn";
  return "bad";
};

export const useFrameMonitorStore = defineStore("frameMonitor", () => {
  let lastFrame: number | null = null;
  let rafHandle: number | null = null;
  let nextHookId = 1;
  let latestSnapshot: FrameMonitorSnapshot | null = null;

  // id -> hook映射
  const hooks = new Map<number, RegisteredHook>();

  const shouldTrigger = (hook: RegisteredHook, minFps: number, avgFps: number) => {
    const hasAvg = hook.thresholdAvgFps != null;
    const hasMin = hook.thresholdMinFps != null;
    if (!hasAvg && !hasMin) return true;
    return (
      (hasAvg && hasMin && avgFps <= hook.thresholdAvgFps! && minFps <= hook.thresholdMinFps!) ||
      (hasAvg && avgFps <= hook.thresholdAvgFps!) ||
      (hasMin && minFps <= hook.thresholdMinFps!)
    );
  };

  const tick = (ts: number) => {
    if (!lastFrame) {
      lastFrame = ts;
      rafHandle = requestAnimationFrame(tick);
      return;
    }

    const frameMs = ts - lastFrame;
    const crtFPS = frameMs > 0 ? 1000 / frameMs : Number.POSITIVE_INFINITY;

    for (const [, hook] of hooks) {
      hook.accFrames++;
      hook.minFPS = hook.minFPS ? Math.min(hook.minFPS, crtFPS) : crtFPS;

      if (ts >= hook.lastRecorded + hook.intervalMs) {
        const sampleMs = Math.max(1, ts - hook.lastRecorded);
        const avgFPS = (hook.accFrames / sampleMs) * 1000;
        const minFPS = Number.isFinite(hook.minFPS) ? hook.minFPS : avgFPS;
        const snapshot: FrameMonitorSnapshot = {
          minFps: Math.max(0, Math.round(minFPS)),
          avgFps: Math.max(0, Math.round(avgFPS)),
          sampledAt: ts,
          sampleMs,
          frameCount: hook.accFrames,
        };
        latestSnapshot = snapshot;

        if (shouldTrigger(hook, snapshot.minFps, snapshot.avgFps)) {
          try {
            hook.callback(snapshot);
          } catch (e) {
            console.error("[FrameMonitor] hook triggerred error", hook.id, e);
          }
          hook.lastTriggerred = ts;
        }

        hook.accFrames = 0;
        hook.minFPS = undefined;
        hook.lastRecorded = ts;
      }
    }

    lastFrame = ts;
    rafHandle = requestAnimationFrame(tick);
  };

  const ensureRunning = () => {
    if (!IS_DEV || rafHandle !== null) return;
    rafHandle = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    lastFrame = null;
  };

  const getSnapshot = () => latestSnapshot;

  const registerHook = (options: FrameMonitorHookOptions) => {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const id = nextHookId++;
    hooks.set(id, {
      id,
      intervalMs: Math.max(1, options.intervalMs ?? FRAME_MONITOR_SAMPLE_MS),
      thresholdMinFps: options.thresholdMinFps,
      thresholdAvgFps: options.thresholdAvgFps,
      callback: options.callback,
      accFrames: 0,
      minFPS: undefined,
      lastTriggerred: 0,
      lastRecorded: lastFrame ?? now,
    });
    ensureRunning();
    return id;
  };

  const unregisterHook = (id: number) => {
    hooks.delete(id);
    if (hooks.size === 0) {
      stop();
    }
  };

  return {
    getSnapshot,
    registerHook,
    unregisterHook,
  };
});
