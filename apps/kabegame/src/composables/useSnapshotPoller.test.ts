import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshotPoller } from "./useSnapshotPoller";

const listeners = new Map<string, () => void>();

vi.mock("@/api/rpc", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    listeners.set(event, callback);
    return () => listeners.delete(event);
  }),
}));

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("useSnapshotPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("不活跃时只拉一次", async () => {
    const fetch = vi.fn(async () => ({ active: false }));
    const poller = useSnapshotPoller({
      key: "poller-inactive",
      fetch,
      apply: vi.fn(),
      isActive: (snapshot) => snapshot.active,
      wakeEvents: ["wake-inactive"],
    });
    await poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.polling.value).toBe(false);
    poller.dispose();
  });

  it("wake 后按 500ms 轮询并在不活跃时停止", async () => {
    const snapshots = [{ active: false }, { active: true }, { active: false }];
    const fetch = vi.fn(async () => snapshots.shift() ?? { active: false });
    const poller = useSnapshotPoller({
      key: "poller-wake",
      fetch,
      apply: vi.fn(),
      isActive: (snapshot) => snapshot.active,
      wakeEvents: ["wake-active"],
    });
    await poller.start();
    listeners.get("wake-active")?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.polling.value).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(poller.polling.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("invalidate 丢弃过期响应", async () => {
    let resolveFirst!: (value: { value: number; active: boolean }) => void;
    const fetch = vi
      .fn<() => Promise<{ value: number; active: boolean }>>()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ value: 2, active: false });
    const apply = vi.fn();
    const poller = useSnapshotPoller({
      key: "poller-invalidate",
      fetch,
      apply,
      isActive: (snapshot) => snapshot.active,
      wakeEvents: [],
    });
    const starting = poller.start();
    await flush();
    poller.invalidate();
    resolveFirst({ value: 1, active: true });
    await starting;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ value: 2, active: false });
    poller.dispose();
  });

  it("慢请求期间不重叠，且同 key 返回同一实例", async () => {
    let resolve!: (value: { active: boolean }) => void;
    const fetch = vi.fn(() => new Promise<{ active: boolean }>((done) => (resolve = done)));
    const options = {
      key: "poller-singleton",
      fetch,
      apply: vi.fn(),
      isActive: (snapshot: { active: boolean }) => snapshot.active,
      wakeEvents: [] as string[],
    };
    const poller = useSnapshotPoller(options);
    expect(useSnapshotPoller(options)).toBe(poller);
    const starting = poller.start();
    await flush();
    poller.wake();
    poller.wake();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve({ active: false });
    await starting;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve({ active: false });
    await flush();
    poller.dispose();
  });
  it("周期内的 wake 不额外加拉，保持 500ms 节奏", async () => {
    const fetch = vi.fn(async () => ({ active: true }));
    const poller = useSnapshotPoller({
      key: "poller-cadence",
      fetch,
      apply: vi.fn(),
      isActive: (snapshot) => snapshot.active,
      wakeEvents: [],
    });
    await poller.start();
    expect(fetch).toHaveBeenCalledTimes(1);
    poller.wake();
    poller.wake();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("轮询中的瞬时失败不停表", async () => {
    const fetch = vi
      .fn<() => Promise<{ active: boolean }>>()
      .mockResolvedValueOnce({ active: true })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ active: false });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const poller = useSnapshotPoller({
      key: "poller-error",
      fetch,
      apply: vi.fn(),
      isActive: (snapshot) => snapshot.active,
      wakeEvents: [],
    });
    await poller.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.polling.value).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(poller.polling.value).toBe(false);
    poller.dispose();
  });
});
