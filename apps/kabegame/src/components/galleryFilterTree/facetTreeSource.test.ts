import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { usePluginStore } from "@/stores/plugins";
import { createGalleryFacetSource, type FacetNode } from "./facetTreeSource";
import type { GalleryFilterTreeContext } from "./context";

const pathqlList = vi.hoisted(() => vi.fn());
vi.mock("@/services/pathql", () => ({
  pathqlEntry: vi.fn(async () => ({ total: 0 })),
  pathqlList,
}));

function createSource(delta = false, prefix = "") {
  const ctx: GalleryFilterTreeContext = {
    filter: computed(() => ({ type: "all" as const })),
    filters: computed(() => ({})),
    dimension: computed(() => null),
    prefix: computed(() => prefix),
    countBaseline: delta ? computed(() => 0) : undefined,
    visible: computed(() => true),
    pathForSegment: (segment) => segment,
    registerRefreshTarget: () => () => {},
  };
  const pluginStore = {
    plugins: [{ id: "demo", version: "1.0.0" }],
    pluginLabel: (id: string) => id,
  } as unknown as ReturnType<typeof usePluginStore>;
  return createGalleryFacetSource(ctx, {
    t: ((key: string) => key) as never,
    locale: ref("zh"),
    pluginStore,
  });
}

afterEach(() => {
  pathqlList.mockReset();
});

describe("facetTreeSource 分组计数枚举", () => {
  it("侧栏维度在末尾追加 _kb_co，并把 meta.count 挂到子元素", async () => {
    pathqlList.mockResolvedValue([
      { name: "unknown", meta: { count: 0 }, total: null },
      { name: "1B-512KB", meta: { count: 17 }, total: null },
    ]);
    const source = createSource();

    const page = source.dataSource.page({ kind: "section", sectionId: "size" }, 1)!;
    const nodes = page.parse([await pathqlList(page.queries[0].path, false)]);

    expect(pathqlList).toHaveBeenCalledWith("gallery/size/_kb_co", false);
    expect(nodes).toEqual([
      { kind: "size", range: "unknown", count: 0 },
      { kind: "size", range: "1B-512KB", count: 17 },
    ]);
  });

  it("插件扩展只列举一次，计数读 meta.count / meta.image_count，缺失为 null", async () => {
    pathqlList.mockResolvedValue([
      { name: "rating", meta: { isLeaf: true, image_count: 9 }, total: 99 },
      { name: "score", meta: { count: 4 }, total: null },
      { name: "title", meta: { plain: true }, total: null },
    ]);
    const source = createSource();

    const page = source.dataSource.page(
      {
        kind: "children",
        parent: {
          kind: "plugin",
          pluginId: "demo",
          version: "1.0.0",
        } as FacetNode,
      },
      1,
    )!;
    const nodes = page.parse([await pathqlList(page.queries[0].path, false)]);

    expect(pathqlList).toHaveBeenCalledWith("gallery/plugin/demo/extend/_kb_co", false);
    const base = { kind: "plugin-extend", pluginId: "demo" };
    expect(nodes).toEqual([
      { ...base, name: "rating", extendPath: "rating", isLeaf: true, isPlain: false, count: 9 },
      { ...base, name: "score", extendPath: "score", isLeaf: false, isPlain: false, count: 4 },
      { ...base, name: "title", extendPath: "title", isLeaf: false, isPlain: true, count: null },
    ]);
  });
});

describe("facetTreeSource 查询描述与事件过滤", () => {
  it("数据源只描述查询；diff 模式同样列 _kb_co、没有事件刷新", () => {
    const source = createSource(true);
    const page = source.dataSource.page({ kind: "section", sectionId: "size" }, 1)!;
    expect(page.queries).toEqual([{ kind: "list", path: "gallery/size/_kb_co", withCount: false }]);
    expect(source.dataSource.refreshOn({ kind: "section", sectionId: "size" }, "page")).toEqual([]);
    expect(pathqlList).not.toHaveBeenCalled();
  });

  it("侧栏忽略无 reason 事件，只有画册敏感上下文响应成员与结构事件", () => {
    const triggers = (prefix: string) =>
      createSource(false, prefix).dataSource.refreshOn({ kind: "section", sectionId: "date" }, "page");
    const relevant = (prefix: string, event: string, payload: unknown) =>
      triggers(prefix)
        .find((trigger) => trigger.event === event)!
        .relevant(payload);
    expect(relevant("", "images-change", {})).toBe(false);
    expect(relevant("", "images-change", { reason: "import" })).toBe(true);
    expect(relevant("", "album-images-change", {})).toBe(false);
    expect(relevant("gallery/hide", "album-images-change", {})).toBe(true);
    expect(relevant("gallery/album/a", "album-changed", { changes: { name: "新名字" } })).toBe(true);
    expect(relevant("gallery/album/a", "album-changed", { changes: { syncMode: "none" } })).toBe(false);
    expect(relevant("gallery/no-album", "album-added", {})).toBe(true);
  });
});
