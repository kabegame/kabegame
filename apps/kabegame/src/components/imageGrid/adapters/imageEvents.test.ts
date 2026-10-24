import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGalleryAdapter } from "./gallery";
import { createAlbumDetailAdapter } from "./album";
import { createTaskDetailAdapter } from "./task";
import { createSurfImagesAdapter } from "./surf";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { GallerySort } from "@/utils/galleryPath";
import type { GalleryQuery } from "@/utils/galleryQuery";
import type { EventTrigger } from "@/services/kbEvents";

const state = vi.hoisted(() => ({
  id: "current",
  noAlbum: false,
  get effectiveNoAlbum() {
    return this.noAlbum;
  },
  hide: false,
  query: [] as GalleryQuery,
  sort: { field: "by-time", desc: false } as GallerySort,
}));
vi.mock("@/router", () => ({ default: { currentRoute: { value: { path: "/gallery" } } } }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock("@/stores/galleryRoute", () => ({
  useGalleryRouteStore: () => ({
    get query() {
      return state.query;
    },
    get sort() {
      return state.sort;
    },
    get hide() {
      return state.hide;
    },
    get effectiveNoAlbum() {
      return state.noAlbum;
    },
  }),
  resetGalleryRouteToDefault: vi.fn(),
}));
vi.mock("@/stores/albumDetailRoute", () => ({ useAlbumDetailRouteStore: () => state }));
vi.mock("@/stores/taskDetailRoute", () => ({ useTaskDetailRouteStore: () => state }));
vi.mock("@/stores/surfImagesRoute", () => ({ useSurfImagesRouteStore: () => state }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ values: {} }) }));
vi.mock("@/stores/failedImages", () => ({ useFailedImagesStore: () => ({ loadAll: vi.fn() }) }));
vi.mock("@/services/albums", () => ({
  HIDDEN_ALBUM_ID: "hidden",
  FAVORITE_ALBUM_ID: "favorite",
  removeImagesFromAlbum: vi.fn(),
}));

const analytics = {} as ImageAnalytics;
const adapters = {
  gallery: () => createGalleryAdapter({ analytics }),
  album: () =>
    createAlbumDetailAdapter({
      albumId: () => state.id,
      albumName: () => "album",
      isLocalFolder: () => false,
      analytics,
    }),
  task: () => createTaskDetailAdapter({ taskId: () => state.id }),
  surf: () => createSurfImagesAdapter({ recordId: () => state.id }),
};
function accepts(triggers: readonly EventTrigger[], event: string, payload: unknown) {
  return triggers.some((trigger) => trigger.event === event && trigger.relevant(payload));
}
beforeEach(() => {
  state.id = "current";
  state.noAlbum = false;
  state.hide = false;
  state.query = [];
  state.sort = { field: "by-time", desc: false };
});

describe("Phase B 四个 adapter 的图片相关性", () => {
  it.each(Object.entries(adapters))("%s：删除交给 ImageGrid、字段按依赖判断", (_name, create) => {
    const adapter = create();
    const filters = adapter.refreshOn;
    expect(adapter.viewState()).toMatchObject({ query: [], sort: { field: "by-time" }, hide: false });
    expect(accepts(filters, "images-deleted", { seq: 1, imageIds: ["other"] })).toBe(false);
    expect(accepts(filters, "images-change", { seq: 1, patches: [{ id: "other", width: 1 }] })).toBe(true);
    expect(accepts(filters, "image-changed", { seq: 1, patch: { id: "other", metadataId: 2 } })).toBe(false);
    expect(accepts(filters, "image-changed", { seq: 1, patch: { id: "other", thumbnailPath: "new" } })).toBe(false);
  });
  it.each(Object.entries(adapters))("%s：新增按根归属与当前查询判断，画册不订阅新增", (name, create) => {
    const filters = create().refreshOn;
    const payload = (owner: string, pluginId = "x") => ({
      seq: 1,
      images: [{ id: "new", taskId: owner, surfRecordId: owner, pluginId }],
    });
    expect(accepts(filters, "images-added", payload("current"))).toBe(name !== "album");
    expect(accepts(filters, "images-added", payload("other"))).toBe(name === "gallery");
    state.query = [{ is: { plugin: { pluginId: "y" } } }];
    expect(accepts(filters, "images-added", payload("current"))).toBe(false);
    expect(accepts(filters, "images-added", payload("current", "y"))).toBe(name !== "album");
  });
  it.each(Object.entries(adapters))("%s：hide 关闭不响应隐藏画册（只打补丁），开启后一律响应", (_name, create) => {
    const filters = create().refreshOn;
    const payload = { seq: 1, albumId: "hidden", imageIds: ["other"] };
    for (const event of ["album-images-added", "album-images-deleted"]) {
      expect(accepts(filters, event, payload)).toBe(false);
    }
    state.hide = true;
    for (const event of ["album-images-added", "album-images-deleted"]) {
      expect(accepts(filters, event, payload)).toBe(true);
    }
    expect(accepts(filters, "album-images-added", { ...payload, albumId: "other" })).toBe(false);
  });
  it("taskId 置空只打补丁不刷新；畅游归属变化刷新（单图 / 批量）", () => {
    for (const [adapter, field, expected] of [
      [adapters.task(), "taskId", false],
      [adapters.gallery(), "taskId", false],
      [adapters.surf(), "surfRecordId", true],
    ] as const) {
      const patch = { id: "old", [field]: null };
      expect(accepts(adapter.refreshOn, "image-changed", { patch })).toBe(expected);
      expect(accepts(adapter.refreshOn, "images-change", { patches: [patch] })).toBe(expected);
    }
  });
  it("画廊无画册与当前画册仍响应原有成员变化", () => {
    state.noAlbum = true;
    const payload = { seq: 1, albumId: "current", imageIds: ["other"] };
    expect(accepts(adapters.gallery().refreshOn, "album-images-added", payload)).toBe(true);
    expect(accepts(adapters.album().refreshOn, "album-images-added", payload)).toBe(true);
  });
  it("画册改名、移动不刷新网格，排序只在 by-album-order 下刷新", () => {
    const album = adapters.album();
    const patch = { seq: 1, patch: { id: "current", name: "新名" } };
    expect(accepts(album.refreshOn, "album-changed", patch)).toBe(false);
    expect(accepts(album.refreshOn, "album-moved", { id: "current" })).toBe(false);
    const order = { albumId: "current", imageIds: ["x"] };
    expect(accepts(album.refreshOn, "album-images-change", order)).toBe(false);
    state.sort.field = "by-album-order";
    expect(accepts(album.refreshOn, "album-images-change", order)).toBe(true);
    expect(accepts(album.refreshOn, "album-images-change", { ...order, albumId: "other" })).toBe(false);
    expect(album.deletesViaMembership).toBe(true);
    expect(accepts(album.refreshOn, "albums-deleted", { albums: [{ id: "current" }] })).toBe(true);
  });
  it.each(["gallery", "task", "surf"] as const)(
    "%s：无画册时加入、收藏、删画册刷新，隐藏与删图删除不重复触发",
    (name) => {
      const filters = adapters[name]().refreshOn;
      expect(accepts(filters, "album-images-added", { albumId: "normal" })).toBe(false);
      expect(accepts(filters, "album-images-added", { albumId: "favorite" })).toBe(false);
      state.noAlbum = true;
      expect(accepts(filters, "album-images-added", { albumId: "normal" })).toBe(true);
      expect(accepts(filters, "album-images-added", { albumId: "favorite" })).toBe(true);
      expect(accepts(filters, "album-images-deleted", { albumId: "normal", imagesDeleted: true })).toBe(false);
      expect(accepts(filters, "album-images-added", { albumId: "hidden" })).toBe(false);
      expect(accepts(filters, "album-images-deleted", { albumId: "hidden" })).toBe(false);
      expect(accepts(filters, "albums-deleted", { albums: [{ id: "other" }] })).toBe(true);
      expect(accepts(filters, "album-images-change", { albumId: "normal" })).toBe(false);
    },
  );
  it("画廊不因任意画册改名、移动或收藏刷新，无画册时才响应画册字段", () => {
    const filters = adapters.gallery().refreshOn;
    expect(accepts(filters, "albums-change", { patches: [{ id: "other", name: "新名" }] })).toBe(false);
    expect(accepts(filters, "album-moved", { id: "other" })).toBe(false);
    state.noAlbum = true;
    expect(accepts(filters, "albums-change", { patches: [{ id: "other", name: "新名" }] })).toBe(true);
    expect(accepts(filters, "album-moved", { id: "other" })).toBe(false);
  });
  it.each(Object.entries(adapters))("%s：标签搜索响应挂标签、路径变更，不响应排序", (_name, create) => {
    const filters = create().refreshOn;
    state.query = [{ is: { search: { modes: ["label"], query: "tag" } } }];
    expect(accepts(filters, "album-images-added", { albumId: "label", imageIds: ["x"] })).toBe(true);
    expect(accepts(filters, "album-moved", { id: "label-dir" })).toBe(true);
    expect(accepts(filters, "albums-change", { patches: [{ id: "label", labelKey: "tag" }] })).toBe(true);
    expect(accepts(filters, "album-images-change", { albumId: "label" })).toBe(false);
  });
});
