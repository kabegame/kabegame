import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGalleryAdapter } from "./gallery";
import { createAlbumDetailAdapter } from "./album";
import { createTaskDetailAdapter } from "./task";
import { createSurfImagesAdapter } from "./surf";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { GalleryQuery } from "@/utils/galleryQuery";
import type { EventTrigger } from "@/services/kbEvents";

const state = vi.hoisted(() => ({
  id: "current",
  noAlbum: false,
  hide: false,
  query: [] as GalleryQuery,
  sort: { field: "by-time" as const, desc: false },
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
  it.each(Object.entries(adapters))("%s：hide 关闭不响应隐藏画册，开启后响应（画册等自身成员事件）", (name, create) => {
    const filters = create().refreshOn;
    const payload = { seq: 1, reason: "add-hidden", albumIds: ["hidden"], imageIds: ["other"] };
    expect(accepts(filters, "album-images-change", payload)).toBe(false);
    state.hide = true;
    expect(accepts(filters, "album-images-change", payload)).toBe(name !== "album");
    expect(accepts(filters, "album-images-change", { ...payload, albumIds: ["other"] })).toBe(false);
    if (name === "album") {
      expect(accepts(filters, "album-images-change", { ...payload, reason: "hide", albumIds: ["current"] })).toBe(true);
    }
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
    const payload = { seq: 1, reason: "add", albumIds: ["current"], imageIds: ["other"] };
    expect(accepts(adapters.gallery().refreshOn, "album-images-change", payload)).toBe(true);
    expect(accepts(adapters.album().refreshOn, "album-images-change", payload)).toBe(true);
  });
});
