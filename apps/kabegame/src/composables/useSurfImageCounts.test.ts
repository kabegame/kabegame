// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSurfImageCounts } from "./useSurfImageCounts";
import type { PathqlQuery } from "@/services/pathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlAll = vi.hoisted(() => vi.fn<(queries: readonly PathqlQuery[]) => Promise<unknown[]>>());
const stores = vi.hoisted(() => ({
  surf: {} as { records: { id: string; host: string }[] },
  route: {} as { hide: boolean },
}));
vi.mock("@/stores/surf", () => ({ useSurfStore: () => stores.surf }));
vi.mock("@/stores/pathRoute", () => ({ useGlobalPathRoute: () => stores.route }));
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  stores.surf = reactive({
    records: [
      { id: "one", host: "a.com" },
      { id: "two", host: "b.com" },
    ],
  });
  stores.route = reactive({ hide: false });
  pathqlAll.mockReset().mockImplementation(async (queries) => [queries[0].path.includes("a.com") ? 8 : 3]);
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
function fixture() {
  let counts!: ReturnType<typeof useSurfImageCounts>;
  const wrapper = mount(
    defineComponent({
      setup() {
        counts = useSurfImageCounts();
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { counts, wrapper };
}
const paths = () => pathqlAll.mock.calls.map(([queries]) => queries[0].path).sort();
const emit = (payload: unknown, name = "images-added") => listeners.get(name)?.({ payload });

describe("Surf 页内动态计数观察", () => {
  it("首次加载每记录一个 all key，countOf 保持站点接口并编码 host", async () => {
    stores.surf.records.push({ id: "encoded", host: "a/b 空" });
    const { counts } = fixture();
    await flushPromises();
    expect(paths()).toEqual(["gallery/surf/a%2Fb%20%E7%A9%BA", "gallery/surf/a.com", "gallery/surf/b.com"]);
    expect(pathqlAll.mock.calls.every(([queries]) => queries.length === 1 && queries[0].kind === "count")).toBe(true);
    expect(counts.countOf("a.com")).toBe(8);
    expect(counts.countOf("unknown")).toBe(0);
  });

  it("记录增删只请求新 key，hide 切换替换全部 key，空列表后来灌入也自动请求", async () => {
    stores.surf.records = [];
    fixture();
    expect(pathqlAll).not.toHaveBeenCalled();
    stores.surf.records = [{ id: "one", host: "a.com" }];
    await flushPromises();
    expect(paths()).toEqual(["gallery/surf/a.com"]);
    pathqlAll.mockClear();
    stores.surf.records.push({ id: "two", host: "b.com" });
    await flushPromises();
    expect(paths()).toEqual(["gallery/surf/b.com"]);
    pathqlAll.mockClear();
    stores.surf.records.shift();
    await flushPromises();
    expect(paths()).toEqual([]);
    stores.route.hide = true;
    await flushPromises();
    expect(paths()).toEqual(["gallery/hide/surf/b.com"]);
  });

  it.each([
    ["images-added", { images: [{ surfRecordId: "one" }] }, ["a.com"]],
    ["images-added", { images: [{ surfRecordId: "unknown" }] }, []],
    ["images-added", { images: [] }, []],
    ["image-changed", { patch: { id: "a", surfRecordId: null } }, ["a.com", "b.com"]],
    ["images-change", { patches: [{ id: "a", surfRecordId: "two" }] }, ["a.com", "b.com"]],
    ["images-deleted", { imageIds: ["a"] }, ["a.com", "b.com"]],
    ["images-change", { patches: [{ id: "a", width: 1 }] }, []],
    ["image-changed", { patch: { id: "a", width: 1 } }, []],
    ["album-images-change", { albumIds: ["00000000-0000-0000-0000-000000000000"] }, []],
    ["album-images-change", { albumIds: ["other"] }, []],
  ])("事件相关性 %s %j → %j", async (name, payload, hosts) => {
    vi.useFakeTimers();
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    emit(payload, name);
    await flushPromises();
    expect(paths()).toEqual(hosts.map((host) => `gallery/surf/${host}`));
  });

  it("hide 开启时隐藏画册变化刷新各站点计数", async () => {
    vi.useFakeTimers();
    stores.route.hide = true;
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    emit({ albumIds: ["00000000-0000-0000-0000-000000000000"] }, "album-images-change");
    await flushPromises();
    expect(paths()).toEqual(["gallery/hide/surf/a.com", "gallery/hide/surf/b.com"]);
  });

  it("相同 host 更换记录 id 不重读 key，过滤器读取最新 id", async () => {
    vi.useFakeTimers();
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    stores.surf.records[0] = { id: "replacement", host: "a.com" };
    await flushPromises();
    emit({ images: [{ surfRecordId: "one" }] });
    expect(paths()).toEqual([]);
    emit({ images: [{ surfRecordId: "replacement" }] });
    await flushPromises();
    expect(paths()).toEqual(["gallery/surf/a.com"]);
  });

  it("hide 切换换 key 时保留旧数，新结果到达再覆盖", async () => {
    const { counts } = fixture();
    await flushPromises();
    expect(counts.countOf("a.com")).toBe(8);
    let resolve!: (value: unknown[]) => void;
    pathqlAll.mockImplementation(() => new Promise<unknown[]>((yes) => (resolve = yes)));
    stores.route.hide = true;
    await flushPromises();
    expect(counts.countOf("a.com")).toBe(8);
    resolve([5]);
    await flushPromises();
    expect(counts.countOf("b.com")).toBe(5);
  });

  it("离开的 key 和页面卸载停止观察，旧 hide 结果迟到不会覆盖当前计数", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((yes) => {
      resolve = yes;
    });
    pathqlAll.mockImplementation(() => pending);
    const { counts, wrapper } = fixture();
    await flushPromises();
    pathqlAll.mockResolvedValue([6]);
    stores.route.hide = true;
    await flushPromises();
    resolve([999]);
    await flushPromises();
    expect(counts.countOf("a.com")).toBe(6);
    stores.surf.records.shift();
    await flushPromises();
    expect(counts.countOf("a.com")).toBe(0);
    pathqlAll.mockClear();
    emit({ images: [{ surfRecordId: "one" }] });
    expect(paths()).toEqual([]);
    wrapper.unmount();
    emit({ images: [] });
    expect(paths()).toEqual([]);
  });
});
