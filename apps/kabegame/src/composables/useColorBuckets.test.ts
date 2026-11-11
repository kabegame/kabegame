// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useColorBuckets } from "./useColorBuckets";
import { PATHQL_REFRESH_WAIT_MS } from "@/services/kbEvents";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn<(path: string) => Promise<Record<string, unknown>[]>>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll: vi.fn(), pathqlFetch }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const red = { rgb: 0xff0000, key: "red", position: 0 };
const black = { rgb: 0, key: "black", position: 9 };
const custom = { rgb: 0x32fe98, key: null, position: 12 };

const cleanups: (() => void)[] = [];
// 带花括号：钩子返回函数会被当成清理函数，在用例结束后再调一次
beforeEach(() => {
  pathqlFetch.mockReset();
});
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});

function fixture(enabled?: () => boolean) {
  let model!: ReturnType<typeof useColorBuckets>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = enabled ? useColorBuckets(enabled) : useColorBuckets();
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return model;
}
const emitChange = () => listeners.get("color-buckets-change")?.({ payload: { seq: 1 } });

describe("useColorBuckets", () => {
  it("观察 color_buckets://：读到前 loaded 为 false，读到后给出色桶与 hex 集合", async () => {
    pathqlFetch.mockResolvedValue([red, black, custom]);
    const model = fixture();
    expect(model.loaded.value).toBe(false);
    expect(model.bucketHexes.value.size).toBe(0);
    expect(model.loading.value).toBe(true);
    await flushPromises();

    expect(pathqlFetch).toHaveBeenCalledExactlyOnceWith("color_buckets://");
    expect(model.loaded.value).toBe(true);
    expect(model.loading.value).toBe(false);
    expect(model.buckets.value).toEqual([
      { rgb: 0xff0000, hex: "ff0000", key: "red", position: 0 },
      { rgb: 0, hex: "000000", key: "black", position: 9 },
      { rgb: 0x32fe98, hex: "32fe98", key: null, position: 12 },
    ]);
    expect([...model.bucketHexes.value]).toEqual(["ff0000", "000000", "32fe98"]);
  });

  it("后来的观察方直接拿到已有的列表，不再请求", async () => {
    pathqlFetch.mockResolvedValue([red]);
    fixture();
    await flushPromises();
    const second = fixture();
    expect(second.loaded.value).toBe(true);
    expect(second.buckets.value.map((bucket) => bucket.hex)).toEqual(["ff0000"]);
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
  });

  it("已有请求在途时，后来的观察方不重复请求，结果到了两边都有", async () => {
    let resolve!: (rows: Record<string, unknown>[]) => void;
    pathqlFetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = fixture();
    const second = fixture();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    resolve([red]);
    await flushPromises();
    expect(first.loaded.value && second.loaded.value).toBe(true);
    expect(second.bucketHexes.value.has("ff0000")).toBe(true);
  });

  it("color-buckets-change 重读整张表", async () => {
    vi.useFakeTimers();
    pathqlFetch.mockResolvedValueOnce([red]).mockResolvedValueOnce([red, custom]);
    const model = fixture();
    await flushPromises();
    expect(model.bucketHexes.value.has("32fe98")).toBe(false);

    emitChange();
    await vi.advanceTimersByTimeAsync(PATHQL_REFRESH_WAIT_MS);
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
    expect(model.bucketHexes.value.has("32fe98")).toBe(true);
  });

  it("读取失败：loaded 保持 false，不清掉已有列表", async () => {
    vi.useFakeTimers();
    pathqlFetch.mockRejectedValueOnce(new Error("path not found"));
    const model = fixture();
    await flushPromises();
    expect(model.loaded.value).toBe(false);
    expect(model.buckets.value).toEqual([]);

    pathqlFetch.mockResolvedValueOnce([red]).mockRejectedValueOnce(new Error("busy"));
    emitChange();
    await vi.advanceTimersByTimeAsync(PATHQL_REFRESH_WAIT_MS);
    await flushPromises();
    expect(model.loaded.value).toBe(true);
    emitChange();
    await vi.advanceTimersByTimeAsync(PATHQL_REFRESH_WAIT_MS);
    await flushPromises();
    expect(model.buckets.value.map((bucket) => bucket.hex)).toEqual(["ff0000"]);
    expect(model.loaded.value).toBe(true);
  });

  it("enabled 为 false 时不观察不请求；启用后才读，停用后 loaded 复位、再启用重读", async () => {
    vi.useFakeTimers();
    pathqlFetch.mockResolvedValue([red]);
    const enabled = ref(false);
    const model = fixture(() => enabled.value);
    await flushPromises();
    expect(pathqlFetch).not.toHaveBeenCalled();
    expect(model.loaded.value).toBe(false);

    enabled.value = true;
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    expect(model.loaded.value).toBe(true);

    enabled.value = false;
    await flushPromises();
    expect(model.loaded.value).toBe(false);
    // 停用期间的事件不触发读取
    emitChange();
    await vi.advanceTimersByTimeAsync(PATHQL_REFRESH_WAIT_MS);
    expect(pathqlFetch).toHaveBeenCalledTimes(1);

    pathqlFetch.mockResolvedValue([red, custom]);
    enabled.value = true;
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
    expect(model.loaded.value).toBe(true);
    expect(model.bucketHexes.value.has("32fe98")).toBe(true);
  });
});
