import type { GalleryFilterSet, GalleryBrowseDimension } from "@/utils/galleryQuery";
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

function createSource(
  delta = false,
  prefix = "",
  filters: GalleryFilterSet = {},
  dimension: GalleryBrowseDimension | null = null,
) {
  const ctx: GalleryFilterTreeContext = {
    filter: computed(() => ({ type: "all" as const })),
    filters: computed(() => filters),
    dimension: computed(() => dimension),
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

  it("侧栏按内容过滤图片事件，删除照常刷新，画册敏感上下文保留原有规则", () => {
    const triggers = (prefix: string) =>
      createSource(false, prefix).dataSource.refreshOn({ kind: "section", sectionId: "date" }, "page");
    const relevant = (prefix: string, event: string, payload: unknown) =>
      triggers(prefix).some((trigger) => trigger.event === event && trigger.relevant(payload));
    expect(relevant("", "images-change", { seq: 1, patches: [] })).toBe(false);
    expect(relevant("", "images-added", { images: [{ id: "new" }] })).toBe(true);
    expect(relevant("", "images-deleted", { imageIds: ["any"] })).toBe(true);
    expect(relevant("", "image-changed", { patch: { id: "a", thumbnailPath: "p" } })).toBe(false);
    expect(relevant("", "image-changed", { patch: { id: "a", width: 1 } })).toBe(true);
    expect(relevant("", "album-images-change", { albumIds: ["00000000-0000-0000-0000-000000000000"] })).toBe(false);
    expect(relevant("gallery/hide", "album-images-change", {})).toBe(true);
    expect(relevant("gallery/album/a", "album-changed", { changes: { name: "新名字" } })).toBe(true);
    expect(relevant("gallery/album/a", "album-changed", { changes: { syncMode: "none" } })).toBe(false);
    expect(relevant("gallery/no-album", "album-added", {})).toBe(true);
  });

  it("新增使用减格上下文，高级查询与搜索字段依赖也保留", () => {
    const filters: GalleryFilterSet = { plugin: { pluginId: "y" }, mediaType: { kind: "video" } };
    const triggers = createSource(
      false,
      "images://gallery/hide/task/t/no-album/_kb_fc/~not/search/metadata/foo/~end/_kb_fc/",
      filters,
      "mediaType",
    ).dataSource.refreshOn({ kind: "section", sectionId: "mediaType" }, "page");
    const accepts = (event: string, payload: unknown) =>
      triggers.some((trigger) => trigger.event === event && trigger.relevant(payload));
    expect(accepts("images-added", { images: [{ pluginId: "x", type: "video/mp4" }] })).toBe(false);
    // 正在浏览 mediaType，当前 video chip 被扣掉，图片仍可能改变此维度的计数。
    expect(accepts("images-added", { images: [{ pluginId: "y", type: "image/png" }] })).toBe(true);
    expect(accepts("image-changed", { patch: { id: "a", metadataId: 1 } })).toBe(true);
    const searchTriggers = createSource(
      false,
      "gallery/surf/site/~any/search/native-metadata/foo/~or/search/display-name/bar/~end/",
    ).dataSource.refreshOn({ kind: "section", sectionId: "date" }, "page");
    expect(
      searchTriggers.some(
        (trigger) => trigger.event === "image-changed" && trigger.relevant({ patch: { id: "a", imageMetadataId: 1 } }),
      ),
    ).toBe(true);
    const filtered = createSource(false, "gallery/media-type/video/").dataSource.refreshOn(
      { kind: "section", sectionId: "date" },
      "page",
    );
    expect(
      filtered.find((trigger) => trigger.event === "images-added")!.relevant({ images: [{ type: "image/png" }] }),
    ).toBe(false);
  });

  it("插件分面的分组与扩展依赖 pluginId / metadataId，即使减格上下文没有插件过滤", () => {
    const source = createSource();
    const branches = [
      { kind: "section" as const, sectionId: "plugin" },
      { kind: "children" as const, parent: { kind: "plugin" as const, pluginId: "x", version: "1" } },
    ];
    for (const branch of branches) {
      const triggers = source.dataSource.refreshOn(branch, "page");
      for (const field of ["pluginId", "metadataId"]) {
        expect(
          triggers
            .find((trigger) => trigger.event === "image-changed")!
            .relevant({ patch: { id: "a", [field]: null } }),
        ).toBe(true);
      }
      expect(
        triggers
          .find((trigger) => trigger.event === "image-changed")!
          .relevant({ patch: { id: "a", thumbnailPath: "new" } }),
      ).toBe(false);
    }
  });

  it("无法解析的前缀保守刷新", () => {
    const triggers = createSource(false, "gallery/new-provider/unknown").dataSource.refreshOn(
      { kind: "section", sectionId: "date" },
      "page",
    );
    expect(triggers.find((trigger) => trigger.event === "images-added")!.relevant({ images: [{ id: "a" }] })).toBe(
      true,
    );
    expect(
      triggers.find((trigger) => trigger.event === "image-changed")!.relevant({ patch: { id: "a", metadataId: 1 } }),
    ).toBe(true);
  });
});
