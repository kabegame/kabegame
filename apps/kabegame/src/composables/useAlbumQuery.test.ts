// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref, watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAlbumQuery } from "./useAlbumQuery";
import type { PathqlQuery } from "@/services/pathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlAll = vi.hoisted(() => vi.fn<(queries: readonly PathqlQuery[]) => Promise<unknown[]>>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/api/rpc", () => ({ invoke: vi.fn() }));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn(), pathqlEntry: vi.fn() }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: vi.fn() }));
vi.mock("@kabegame/element-plus", () => ({ ElMessageBox: {} }));
vi.mock("@kabegame/i18n", () => ({ i18n: {} }));

function deferred() {
  let resolve!: (value: unknown[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlAll.mockReset();
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
const detailResult = (id = "self", type = "normal") => [
  [{ id, name: "当前画册", type, ancestor_path: `/root/${id}/` }],
  [{ id: "root", name: "根画册", ancestor_path: "/root/" }],
  { total: 3 },
];
function fixture(id: string | null = "self") {
  const albumId = ref(id);
  let model!: ReturnType<typeof useAlbumQuery>;
  const fallback = vi.fn();
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useAlbumQuery(albumId);
        watch([model.album, model.loading], ([album, loading]) => {
          if (!album && !loading) fallback();
        });
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { model, albumId, wrapper, fallback };
}
const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });
const paths = () => pathqlAll.mock.calls.map(([queries]) => queries[0].path);
const normalResponse = async (queries: readonly PathqlQuery[]) => (queries.length === 3 ? detailResult() : [12]);

describe("useAlbumQuery 两段 pathql 观察", () => {
  it("先观察后请求，首屏 loading 同步为 true；A 同批结构，B 等待 A 落地", async () => {
    const a = deferred();
    const b = deferred();
    pathqlAll.mockImplementation((queries) => (queries.length === 3 ? a.promise : b.promise));
    const { model, fallback } = fixture("a/b");
    expect(model.loading.value).toBe(true);
    expect(pathqlAll.mock.calls[0][0]).toEqual([
      { kind: "fetch", path: "albums://id_a%2Fb" },
      { kind: "fetch", path: "albums://ancestors_a%2Fb" },
      { kind: "entry", path: "albums://subtree_a%2Fb" },
    ]);
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    await nextTick();
    expect(fallback).not.toHaveBeenCalled();
    a.resolve(detailResult("a/b"));
    await flushPromises();
    expect(model.album.value?.ancestorPath).toBe("/root/a/b/");
    expect(model.ancestors.value[0].name).toBe("根画册");
    expect(model.descendantCount.value).toBe(3);
    expect(paths()[1]).toBe("images://gallery/album-tree/a%2Fb");
    expect(model.loading.value).toBe(true);
    b.resolve([8]);
    await flushPromises();
    expect(model.imageCount.value).toBe(8);
    expect(model.loading.value).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("refresh 同时请求 A 与当前 B，A 改变类型后继续等待新 B", async () => {
    pathqlAll.mockImplementation(normalResponse);
    const { model } = fixture();
    await flushPromises();
    const a = deferred(),
      oldB = deferred(),
      newB = deferred();
    pathqlAll.mockImplementation((queries) =>
      queries.length === 3 ? a.promise : queries[0].path.includes("album-tree") ? oldB.promise : newB.promise,
    );
    let done = false;
    const refresh = model.refresh().then(() => {
      done = true;
    });
    expect(model.loading.value).toBe(true);
    a.resolve(detailResult("self", "label_dir"));
    await flushPromises();
    expect(paths().at(-1)).toBe("albums://parent/self");
    oldB.resolve([99]);
    await flushPromises();
    expect(done).toBe(false);
    newB.resolve([4]);
    await refresh;
    expect(model.imageCount.value).toBe(4);
    expect(model.loading.value).toBe(false);
  });

  it("refresh 等待 A 与同 key B 都结束，并发 refresh 共同等待最新状态", async () => {
    pathqlAll.mockImplementation(normalResponse);
    const { model } = fixture();
    await flushPromises();
    const a = deferred(),
      b = deferred();
    pathqlAll.mockImplementation((queries) => (queries.length === 3 ? a.promise : b.promise));
    let done = 0;
    const first = model.refresh().then(() => {
      done++;
    });
    const second = model.refresh().then(() => {
      done++;
    });
    b.resolve([22]);
    await flushPromises();
    expect(done).toBe(0);
    a.resolve(detailResult());
    await Promise.all([first, second]);
    expect(done).toBe(2);
    expect(model.imageCount.value).toBe(22);
  });

  it("A / B 失败均释放等待，保留最后可得数据", async () => {
    pathqlAll.mockImplementation(normalResponse);
    const { model } = fixture();
    await flushPromises();
    pathqlAll.mockRejectedValue(new Error("读取失败"));
    await model.refresh();
    expect(model.loading.value).toBe(false);
    expect(model.album.value?.id).toBe("self");
    expect(model.imageCount.value).toBe(12);
    pathqlAll.mockImplementation(async (queries) => {
      if (queries.length === 3) return detailResult("self", "label");
      throw new Error("计数失败");
    });
    await model.refresh();
    expect(model.loading.value).toBe(false);
  });

  it("切换 id 丢弃旧结果、释放旧 refresh 等待，空画册清空其它字段", async () => {
    pathqlAll.mockImplementation(normalResponse);
    const { model, albumId } = fixture();
    await flushPromises();
    const old = deferred();
    pathqlAll.mockImplementation(() => old.promise);
    const refresh = model.refresh();
    pathqlAll.mockResolvedValue([[], [], { total: 999 }]);
    albumId.value = "missing";
    expect(model.loading.value).toBe(true);
    await refresh;
    await flushPromises();
    old.resolve(detailResult());
    await flushPromises();
    expect(model.album.value).toBeNull();
    expect(model.ancestors.value).toEqual([]);
    expect(model.imageCount.value).toBe(0);
    expect(model.descendantCount.value).toBe(0);
    albumId.value = null;
    await model.refresh();
    expect(model.loading.value).toBe(false);
  });

  it("卸载释放 refresh 等待并停止事件观察", async () => {
    pathqlAll.mockImplementation(normalResponse);
    const { model, wrapper } = fixture();
    await flushPromises();
    const pending = deferred();
    pathqlAll.mockImplementation(() => pending.promise);
    const refresh = model.refresh();
    wrapper.unmount();
    await refresh;
    pathqlAll.mockClear();
    emit("albums-added", { albums: [] });
    expect(pathqlAll).not.toHaveBeenCalled();
    pending.resolve(detailResult());
    await flushPromises();
  });

  it.each([
    ["album-changed", { patch: { id: "self", syncMode: "shallow" } }, ["A"]],
    ["album-changed", { patch: { id: "other", syncMode: "shallow" } }, []],
    ["album-changed", { patch: { id: "root", name: "改名" } }, ["A"]],
    ["albums-change", { patches: [{ id: "child", name: "改名" }] }, []],
    ["album-moved", { id: "child", oldAncestorPath: "/root/self/child/", newAncestorPath: "/else/child/" }, ["A", "B"]],
    ["albums-added", { albums: [{ id: "child", ancestorPath: "/root/self/child/" }] }, ["A"]],
    ["albums-deleted", { albums: [{ id: "child", ancestorPath: "/root/self/child/" }] }, ["A", "B"]],
    ["albums-added", { albums: [{ id: "sibling", ancestorPath: "/root/sibling/" }] }, []],
    ["album-images-added", { albumId: "self", ancestorPath: "/root/self/" }, ["B"]],
    ["album-images-deleted", { albumId: "child", ancestorPath: "/root/self/child/" }, ["B"]],
    ["album-images-change", { albumId: "sibling", ancestorPath: "/root/sibling/" }, []],
    // 计数路径不带 hide/，隐藏 / 取消隐藏不改变普通画册的计数
    [
      "album-images-added",
      { albumId: "00000000-0000-0000-0000-000000000000", ancestorPath: "/00000000-0000-0000-0000-000000000000/" },
      [],
    ],
    [
      "album-moved",
      { id: "child", oldAncestorPath: "/root/self/a/child/", newAncestorPath: "/root/self/b/child/" },
      ["A"],
    ],
    ["album-moved", { id: "child", oldAncestorPath: "/else/child/", newAncestorPath: "/root/self/child/" }, ["A", "B"]],
    ["albums-deleted", { albums: [{ id: "self", ancestorPath: "/root/self/" }] }, ["A"]],
    ["albums-deleted", { albums: [{ id: "root", ancestorPath: "/root/" }] }, ["A"]],
    ["albums-deleted", { albums: [{ id: "other", ancestorPath: "/other/" }] }, []],
    ["album-images-change", { albumId: "self", ancestorPath: "/root/self/" }, []],
    ["images-added", { seq: 1, images: [] }, []],
  ])("事件相关性 %s %j → %j", async (name, payload, expected) => {
    vi.useFakeTimers();
    pathqlAll.mockImplementation(normalResponse);
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    emit(name, payload);
    await flushPromises();
    expect(pathqlAll.mock.calls.map(([queries]) => (queries.length === 3 ? "A" : "B")).sort()).toEqual(expected);
  });

  it.each([
    ["label_dir", "album-images-added", { albumId: "self", ancestorPath: "/root/self/" }, false],
    ["label_dir", "albums-added", { albums: [{ id: "child", ancestorPath: "/root/self/child/" }] }, true],
    ["label_dir", "albums-added", { albums: [{ id: "deep", ancestorPath: "/root/self/child/deep/" }] }, false],
    ["label_dir", "albums-deleted", { albums: [{ id: "child", ancestorPath: "/root/self/child/" }] }, true],
    ["label_dir", "albums-deleted", { albums: [{ id: "self", ancestorPath: "/root/self/" }] }, false],
    [
      "label_dir",
      "album-moved",
      { id: "child", oldAncestorPath: "/other/child/", newAncestorPath: "/root/self/child/" },
      true,
    ],
    [
      "label_dir",
      "album-moved",
      { id: "deep", oldAncestorPath: "/root/self/child/deep/", newAncestorPath: "/root/self/else/deep/" },
      false,
    ],
    ["label", "album-images-added", { albumId: "self", ancestorPath: "/root/self/" }, true],
    ["label", "album-images-deleted", { albumId: "child", ancestorPath: "/root/self/child/" }, false],
    ["label", "albums-added", { albums: [{ id: "child", ancestorPath: "/root/self/child/" }] }, false],
    [
      "label",
      "album-moved",
      { id: "child", oldAncestorPath: "/other/child/", newAncestorPath: "/root/self/child/" },
      false,
    ],
  ] as const)("%s 类型计数：%s %j → %s", async (type, event, payload, expected) => {
    vi.useFakeTimers();
    pathqlAll.mockImplementation(async (queries) => (queries.length === 3 ? detailResult("self", type) : [12]));
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    emit(event, payload);
    await flushPromises();
    expect(pathqlAll.mock.calls.some(([queries]) => queries.length === 1)).toBe(expected);
  });

  it("移动祖先即刻改写自身与祖先持有路径，连续移动使用前一次的新路径", async () => {
    vi.useFakeTimers();
    pathqlAll.mockImplementation(normalResponse);
    const { model } = fixture();
    await flushPromises();
    const pending = deferred();
    pathqlAll.mockImplementation(() => pending.promise);
    emit("album-moved", { seq: 1, id: "root", oldAncestorPath: "/root/", newAncestorPath: "/else/root/" });
    expect(model.album.value?.ancestorPath).toBe("/else/root/self/");
    expect(model.ancestors.value[0]).toMatchObject({ ancestorPath: "/else/root/", parentId: "else" });
    emit("album-moved", { seq: 2, id: "self", oldAncestorPath: "/else/root/self/", newAncestorPath: "/self/" });
    expect(model.album.value).toMatchObject({ ancestorPath: "/self/", parentId: null });
    pending.resolve(detailResult());
    await flushPromises();
  });

  it("self 未知时路径事件保守刷新，B 尚未注册", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    pathqlAll.mockImplementation(() => pending.promise);
    fixture();
    await flushPromises();
    pathqlAll.mockClear();
    emit("albums-added", { albums: [] });
    emit("albums-deleted", { albums: [{ id: "other", ancestorPath: "/other/" }] });
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    pathqlAll.mockClear();
    vi.advanceTimersByTime(500);
    emit("albums-deleted", { albums: [{ id: "self", ancestorPath: "/self/" }] });
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    pending.resolve(detailResult());
    await flushPromises();
  });
});
