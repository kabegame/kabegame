// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeModel, type TreeModel } from "./useTreeModel";
import type { TreeQuerySource } from "./types";
import type { PathqlQuery } from "@/services/pathql";
import { on } from "@/services/kbEvents/events";

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
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));

interface Element {
  id: string;
  children?: boolean;
  count?: number | null;
  ancestorPath?: string;
}
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

function fixture(opts: { extra?: boolean; paged?: boolean; defaultExpanded?: boolean; shared?: boolean } = {}) {
  const prefix = ref("a");
  const active = ref(true);
  const data = new Map<string, Element[]>([
    ["roots/1", [{ id: "root", children: true }]],
    ["root/1", [{ id: "child", children: true, count: 1 }]],
    ["child/1", [{ id: "leaf" }]],
  ]);
  if (opts.shared) {
    data.set("roots/1", [
      { id: "root", children: true },
      { id: "second", children: true },
    ]);
    data.set("shared/1", [{ id: "item" }]);
  }
  const paths = () => pathqlAll.mock.calls.map(([queries]) => queries[0]?.path);
  pathqlAll.mockImplementation(async (queries) => {
    const path = queries[0].path.split("/").slice(1).join("/");
    return path.startsWith("extra/") ? [[{ id: "child", count: 9 }]] : [data.get(path) ?? []];
  });
  const source: TreeQuerySource<Element> = {
    getKey: (element) => element.id,
    hasChildren: (element) => !!element.children,
    page: (branch, page) => {
      if (!opts.paged && page > 1) return null;
      const id = branch.kind === "section" ? "roots" : opts.shared ? "shared" : branch.parent.id;
      return {
        queries: [{ kind: "fetch", path: `${prefix.value}/${id}/${page}` }],
        parse: (results) =>
          (results[0] as Element[]).map((element) =>
            opts.shared && branch.kind === "children"
              ? { ...element, id: `${branch.parent.id}-${element.id}` }
              : element,
          ),
        extra:
          opts.extra && id === "root"
            ? {
                queries: [{ kind: "fetch", path: `${prefix.value}/extra/${id}/${page}` }],
                parse: (results) =>
                  new Map((results[0] as Element[]).map((element) => [element.id, { count: element.count }])),
              }
            : undefined,
      };
    },
    refreshOn: (_branch, part) => [on(opts.extra && part === "extra" ? "album-images-added" : "images-change")],
    pageSize: opts.paged ? 1 : undefined,
  };
  let model!: TreeModel<Element>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useTreeModel({
          dataSource: source,
          sections: () => [{ id: "test" }],
          active: () => active.value,
          defaultExpanded: opts.defaultExpanded ? (element) => element.id === "root" : undefined,
        });
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { model, prefix, active, data, paths, wrapper };
}
const emitChange = () => listeners.get("images-change")?.({ payload: { seq: 1, patches: [{ id: "a", width: 1 }] } });

describe("useTreeModel pathql 观察方", () => {
  it("展开发请求并等待结果；同 key 保留句柄、替换 element", async () => {
    const { model, data } = fixture();
    await flushPromises();
    const pending = deferred();
    pathqlAll.mockImplementationOnce(() => pending.promise);
    let done = false;
    const expanded = model.expand("root").then(() => {
      done = true;
    });
    await nextTick();
    expect(model.nodeByKey("root")?.loading).toBe(true);
    expect(done).toBe(false);
    pending.resolve([[{ id: "child", count: 3 }]]);
    await expanded;
    const original = model.nodeByKey("child");
    data.set("root/1", [{ id: "child", count: 8 }]);
    await model.refresh();
    expect(model.nodeByKey("child")).toBe(original);
    expect(original?.element.count).toBe(8);
  });

  it("事件只刷新可见分支；收起保留后代，再展开请求可见展开链", async () => {
    vi.useFakeTimers();
    const { model, paths } = fixture();
    await flushPromises();
    await model.expand("root");
    await model.expand("child");
    const leaf = model.nodeByKey("leaf");
    model.collapse("root");
    await nextTick();
    pathqlAll.mockClear();
    emitChange();
    await flushPromises();
    expect(paths()).toEqual(["a/roots/1"]);
    expect(model.nodeByKey("leaf")).toBe(leaf);
    pathqlAll.mockClear();
    await model.expand("root");
    await flushPromises();
    expect(paths().sort()).toEqual(["a/child/1", "a/root/1"]);
  });

  it("换 key 时保留旧子项，丢弃旧 key 迟到结果", async () => {
    const { model, prefix } = fixture();
    await flushPromises();
    await model.expand("root");
    const old = deferred();
    pathqlAll.mockImplementationOnce(() => old.promise);
    const refresh = model.refresh();
    await nextTick();
    const latest = deferred();
    pathqlAll.mockImplementation((queries) =>
      queries[0].path.includes("roots") ? Promise.resolve([[{ id: "root", children: true }]]) : latest.promise,
    );
    prefix.value = "b";
    await nextTick();
    expect(model.nodeByKey("child")?.element.count).toBe(1);
    old.resolve([[{ id: "stale" }]]);
    await refresh;
    await flushPromises();
    expect(model.nodeByKey("stale")).toBeUndefined();
    latest.resolve([[{ id: "new" }]]);
    await flushPromises();
    expect(model.nodeByKey("new")).toBeDefined();
    expect(model.nodeByKey("child")).toBeUndefined();
  });

  it("加载更多只请求新页，跨页按 key 去重", async () => {
    const { model, data, paths } = fixture({ paged: true });
    await flushPromises();
    data.set("root/2", [{ id: "child", count: 2 }, { id: "other" }]);
    await model.expand("root");
    pathqlAll.mockClear();
    await model.loadMore("root");
    expect(paths()).toEqual(["a/root/2"]);
    expect(model.nodeByKey("root")?.children?.map((handle) => handle.key)).toEqual(["child", "other"]);
    expect(model.nodeByKey("child")?.element.count).toBe(2);
  });

  it("根列表也按页加载，refresh 等待全部当前查询", async () => {
    const { model, data, paths } = fixture({ paged: true });
    await flushPromises();
    data.set("roots/2", [{ id: "second" }]);
    pathqlAll.mockClear();
    await model.loadMore({ sectionId: "test" });
    expect(paths()).toEqual(["a/roots/2"]);
    const pending = deferred();
    pathqlAll.mockImplementation((queries) =>
      queries[0].path.endsWith("/2") ? pending.promise : Promise.resolve([data.get("roots/1")]),
    );
    let done = false;
    const refresh = model.refresh().then(() => {
      done = true;
    });
    await flushPromises();
    expect(done).toBe(false);
    pending.resolve([[{ id: "second" }]]);
    await refresh;
    expect(done).toBe(true);
  });

  it("补充查询不挡结构，补丁先到也生效且在结构刷新后保留", async () => {
    const { model } = fixture({ extra: true });
    await flushPromises();
    const page = deferred();
    const extra = deferred();
    pathqlAll.mockImplementation((queries) => (queries[0].path.includes("extra") ? extra.promise : page.promise));
    const expanded = model.expand("root");
    await nextTick();
    extra.resolve([[{ id: "child", count: 12 }]]);
    await flushPromises();
    expect(model.nodeByKey("child")).toBeUndefined();
    page.resolve([[{ id: "child", count: null }]]);
    await expanded;
    expect(model.nodeByKey("child")?.element.count).toBe(12);
    const late = deferred();
    pathqlAll.mockImplementation((queries) =>
      queries[0].path.includes("extra")
        ? late.promise
        : Promise.resolve([
            [{ id: queries[0].path.includes("roots") ? "root" : "child", children: true, count: null }],
          ]),
    );
    const refresh = model.refresh();
    await flushPromises();
    expect(model.nodeByKey("child")?.element.count).toBe(12);
    late.resolve([[{ id: "child", count: 18 }]]);
    await refresh;
    expect(model.nodeByKey("child")?.element.count).toBe(18);
  });

  it("active=false 停观察、释放等待，恢复请求全部可见页", async () => {
    const { model, active, paths } = fixture({ defaultExpanded: true });
    await flushPromises();
    const child = model.nodeByKey("child");
    const pending = deferred();
    pathqlAll.mockImplementation(() => pending.promise);
    const refresh = model.refresh();
    await nextTick();
    active.value = false;
    await refresh;
    pathqlAll.mockClear();
    emitChange();
    await flushPromises();
    expect(paths()).toEqual([]);
    expect(model.nodeByKey("child")).toBe(child);
    pathqlAll.mockImplementation(async (queries) => [
      queries[0].path.includes("roots") ? [{ id: "root", children: true }] : [{ id: "child" }],
    ]);
    active.value = true;
    await nextTick();
    expect(paths().sort()).toEqual(["a/root/1", "a/roots/1"]);
    pending.resolve([[]]);
    await flushPromises();
  });

  it("读取失败保留旧子项、根与计数，释放 refresh / expand 等待", async () => {
    const { model } = fixture();
    await flushPromises();
    await model.expand("root");
    const child = model.nodeByKey("child");
    pathqlAll.mockRejectedValue(new Error("读取失败"));
    await model.refresh();
    await nextTick();
    expect(model.nodeByKey("child")).toBe(child);
    expect(model.nodeByKey("root")?.loading).toBe(false);
    model.collapse("root");
    await nextTick();
    await model.expand("root");
    expect(model.nodeByKey("child")).toBe(child);
  });

  it("成员事件只请求补充计数，不重读结构；共享 key 的实例合用一次事件请求", async () => {
    vi.useFakeTimers();
    const first = fixture({ extra: true, defaultExpanded: true });
    const second = fixture({ extra: true, defaultExpanded: true });
    await flushPromises();
    pathqlAll.mockClear();
    listeners.get("album-images-added")!({
      payload: { albumId: "child", ancestorPath: "/root/child/", imageIds: ["x"] },
    });
    await flushPromises();
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(first.paths()).toEqual(["a/extra/root/1"]);
    expect(first.model.nodeByKey("child")?.element.count).toBe(9);
    expect(second.model.nodeByKey("child")?.element.count).toBe(9);
  });

  it("移动路径映射覆盖收起分支的持有节点，补充计数不恢复旧路径", async () => {
    const { model } = fixture({ extra: true });
    await flushPromises();
    await model.expand("root");
    await model.expand("child");
    model.collapse("child");
    await nextTick();
    model.mapElements((element) => ({ ...element, ancestorPath: `/old/${element.id}/` }));
    pathqlAll.mockClear();
    model.mapElements((element) => ({ ...element, ancestorPath: element.ancestorPath?.replace("/old/", "/new/") }));
    expect(model.nodeByKey("leaf")?.element.ancestorPath).toBe("/new/leaf/");
    expect(pathqlAll).not.toHaveBeenCalled();
    listeners.get("album-images-added")?.({
      payload: { albumId: "child", imageIds: ["x"], ancestorPath: "/new/child/" },
    });
    await flushPromises();
    expect(model.nodeByKey("child")?.element).toMatchObject({ ancestorPath: "/new/child/", count: 9 });
    expect(model.nodeByKey("leaf")?.element.ancestorPath).toBe("/new/leaf/");
  });

  it("新增分支复用已有 key 时应用最近结果并释放展开等待", async () => {
    const { model, paths } = fixture({ shared: true });
    await flushPromises();
    await model.expand("root");
    expect(model.nodeByKey("root-item")).toBeDefined();
    pathqlAll.mockClear();
    await model.expand("second");
    expect(paths()).toEqual([]);
    expect(model.nodeByKey("second-item")).toBeDefined();
  });

  it("重复展开与加载更多等待实际在途页，不等待已经完成的页", async () => {
    const { model, data, paths } = fixture({ paged: true });
    await flushPromises();
    await model.expand("root");
    const second = deferred();
    pathqlAll.mockImplementationOnce(() => second.promise);
    const more = model.loadMore("root");
    await nextTick();
    const expand = model.expand("root");
    second.resolve([[{ id: "second-child" }]]);
    await Promise.all([more, expand]);

    const first = deferred();
    pathqlAll.mockImplementation((queries) =>
      queries[0].path === "a/root/1" ? first.promise : Promise.resolve([data.get(queries[0].path.slice(2)) ?? []]),
    );
    const refresh = model.refresh();
    await flushPromises();
    const loading = model.loadMore("root");
    first.resolve([[{ id: "child" }]]);
    await Promise.all([refresh, loading]);
    expect(paths()).not.toContain("a/root/3");
  });

  it("加载新页失败后再次加载重试该页，保留旧子项且不跳页", async () => {
    const { model, paths } = fixture({ paged: true });
    await flushPromises();
    await model.expand("root");
    pathqlAll.mockClear();
    pathqlAll.mockRejectedValueOnce(new Error("分页失败"));
    await model.loadMore("root");
    expect(model.nodeByKey("child")).toBeDefined();
    pathqlAll.mockResolvedValueOnce([[{ id: "retry" }]]);
    await model.loadMore("root");
    expect(paths()).toEqual(["a/root/2", "a/root/2"]);
    expect(model.nodeByKey("retry")).toBeDefined();
  });

  it("同一轮同步收起再展开也重新请求，不漏掉观察集合的短暂退订", async () => {
    const { model, paths } = fixture();
    await flushPromises();
    await model.expand("root");
    pathqlAll.mockClear();
    model.collapse("root");
    await model.expand("root");
    expect(paths()).toEqual(["a/root/1"]);
  });

  it("卸载释放仍未返回的操作等待", async () => {
    const { model, wrapper } = fixture();
    await flushPromises();
    const pending = deferred();
    pathqlAll.mockImplementation(() => pending.promise);
    const expanded = model.expand("root");
    await nextTick();
    wrapper.unmount();
    await expanded;
    pending.resolve([[]]);
    await flushPromises();
  });
});
