// @vitest-environment happy-dom
import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageRange } from "@/components/wallpaper/wpeSceneProgress";
import { WPE_LOAD_PROGRESS_TICK_MS, useWpeLoadProgress } from "./useWpeLoadProgress";

let scope: ReturnType<typeof effectScope> | null = null;
function setup(activeInitially = true) {
  const active = ref(activeInitially);
  scope = effectScope();
  const progress = scope.run(() => useWpeLoadProgress(active))!;
  progress.start();
  return { active, ...progress };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
});
afterEach(() => {
  scope?.stop();
  scope = null;
  vi.useRealTimers();
});

describe("useWpeLoadProgress", () => {
  it("从 page 阶段的 0 开始；没有消息时在 page 区间里往前挪，到不了上沿", () => {
    const { value, stage } = setup();
    expect(value.value).toBe(0);
    expect(stage.value).toBe("page");
    vi.advanceTimersByTime(3_000);
    expect(value.value).toBeGreaterThan(0);
    expect(value.value).toBeLessThan(stageRange("page")[1]);
  });

  it("宿主进度按阶段换算；只增不减、阶段只往前走；记下当前阶段的计数", () => {
    const { value, stage, count, report } = setup();
    expect(count.value).toBeNull();
    report({ stage: "compile", done: 5, total: 10 });
    expect(count.value).toEqual({ done: 5, total: 10 });
    const half = value.value;
    expect(stage.value).toBe("compile");
    expect(half).toBeCloseTo(0.3);
    // 同阶段倒退（被取代的加载重新从头报）不让条倒退
    report({ stage: "compile", done: 1, total: 10 });
    expect(value.value).toBe(half);
    report({ stage: "gpu", done: 0, total: 1 });
    expect(stage.value).toBe("gpu");
    // 回到更早的阶段：忽略
    report({ stage: "decode", done: 1, total: 1 });
    expect(stage.value).toBe("gpu");
    expect(value.value).toBeCloseTo(stageRange("gpu")[0]);
  });

  it("宿主阻塞时按节奏逼近当前阶段上沿的 90%；不活动时不动", async () => {
    const { value, report, active } = setup();
    report({ stage: "gpu", done: 0, total: 1 });
    const start = value.value;
    vi.advanceTimersByTime(WPE_LOAD_PROGRESS_TICK_MS * 4);
    const moved = value.value;
    expect(moved).toBeGreaterThan(start);
    const [from, to] = stageRange("gpu");
    vi.advanceTimersByTime(600_000);
    expect(value.value).toBeLessThan(to);
    expect(value.value).toBeCloseTo(from + (to - from) * 0.9);
    active.value = false;
    // 计时器的启停跟着 active 的 watch（下一轮）
    await nextTick();
    report({ stage: "frame", done: 0, total: 1 });
    const frozen = value.value;
    vi.advanceTimersByTime(10_000);
    expect(value.value).toBe(frozen);
  });

  it("complete 走满；start 重来", () => {
    const { value, stage, complete, start, report } = setup();
    report({ stage: "decode", done: 1, total: 2 });
    complete();
    expect(value.value).toBe(1);
    start();
    expect(value.value).toBe(0);
    expect(stage.value).toBe("page");
  });
});
