import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGalleryAdapter } from "./gallery";
import { createAlbumDetailAdapter } from "./album";
import { createTaskDetailAdapter } from "./task";
import { createSurfImagesAdapter } from "./surf";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { EventTrigger } from "@/services/kbEvents";

const state = vi.hoisted(() => ({ id: "current", noAlbum: false }));
vi.mock("@/router", () => ({ default: { currentRoute: { value: { path: "/gallery" } } } }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock("@/stores/galleryRoute", () => ({
  useGalleryRouteStore: () => ({
    query: [],
    get effectiveNoAlbum() {
      return state.noAlbum;
    },
  }),
  resetGalleryRouteToDefault: vi.fn(),
}));
vi.mock("@/stores/albumDetailRoute", () => ({ useAlbumDetailRouteStore: () => ({}) }));
vi.mock("@/stores/taskDetailRoute", () => ({ useTaskDetailRouteStore: () => ({}) }));
vi.mock("@/stores/surfImagesRoute", () => ({ useSurfImagesRouteStore: () => ({}) }));
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
});

describe("Phase A 四个 adapter 的图片事件迁移", () => {
  it.each(Object.entries(adapters))("%s：删除与单图 / 多图字段变化保留宽刷新", (_name, create) => {
    const filters = create().refreshOn;
    expect(accepts(filters, "images-deleted", { seq: 1, imageIds: ["other"] })).toBe(true);
    expect(accepts(filters, "images-change", { seq: 1, patches: [{ id: "other", width: 1 }] })).toBe(true);
    expect(accepts(filters, "image-changed", { seq: 1, patch: { id: "other", metadataId: 2 } })).toBe(true);
  });
  it.each(Object.entries(adapters))("%s：新增仅在任务 / 畅游视图按行归属判断", (name, create) => {
    const filters = create().refreshOn;
    expect(
      accepts(filters, "images-added", { seq: 1, images: [{ id: "new", taskId: "current", surfRecordId: "current" }] }),
    ).toBe(true);
    expect(
      accepts(filters, "images-added", { seq: 1, images: [{ id: "new", taskId: "other", surfRecordId: "other" }] }),
    ).toBe(name === "gallery" || name === "album");
  });
  it.each(Object.entries(adapters))("%s：隐藏与取消隐藏照旧刷新，无关画册成员不刷新", (_name, create) => {
    const filters = create().refreshOn;
    for (const reason of ["add-hidden", "delete-hidden"]) {
      expect(
        accepts(filters, "album-images-change", { seq: 1, reason, albumIds: ["hidden"], imageIds: ["other"] }),
      ).toBe(true);
    }
    expect(
      accepts(filters, "album-images-change", { seq: 1, reason: "add", albumIds: ["other"], imageIds: ["other"] }),
    ).toBe(false);
  });
  it("画廊无画册与当前画册仍响应原有成员变化", () => {
    state.noAlbum = true;
    const payload = { seq: 1, reason: "add", albumIds: ["current"], imageIds: ["other"] };
    expect(accepts(adapters.gallery().refreshOn, "album-images-change", payload)).toBe(true);
    expect(accepts(adapters.album().refreshOn, "album-images-change", payload)).toBe(true);
  });
});
