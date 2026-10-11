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

function createSource() {
  const ctx: GalleryFilterTreeContext = {
    filter: computed(() => ({ type: "all" as const })),
    filters: computed(() => ({})),
    dimension: computed(() => null),
    prefix: computed(() => ""),
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

    const nodes = await source.roots("size");

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

    const nodes = await source.dataSource.getChildren({
      kind: "plugin",
      pluginId: "demo",
      version: "1.0.0",
    } as FacetNode);

    expect(pathqlList).toHaveBeenCalledWith("gallery/plugin/demo/extend/_kb_co", false);
    const base = { kind: "plugin-extend", pluginId: "demo" };
    expect(nodes).toEqual([
      { ...base, name: "rating", extendPath: "rating", isLeaf: true, isPlain: false, count: 9 },
      { ...base, name: "score", extendPath: "score", isLeaf: false, isPlain: false, count: 4 },
      { ...base, name: "title", extendPath: "title", isLeaf: false, isPlain: true, count: null },
    ]);
  });
});
