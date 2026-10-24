// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageLabelsPanel from "./ImageLabelsPanel.vue";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));
vi.mock("@/api/rpc", () => ({ invoke: vi.fn() }));
vi.mock("@/services/pathql", () => ({ pathqlFetch, pathqlAll: vi.fn(), pathqlEntry: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }), i18n: {} }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ values: {} }) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/composables/useAlbumIdPathState", () => ({ useAlbumIdPathState: () => ({ set: vi.fn() }) }));
vi.mock("@/components/albums/AlbumPicker.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/common/CollapsibleDrawerPanel.vue", () => ({ default: { template: "<div><slot /></div>" } }));
vi.mock("@/composables/useModal", () => ({
  useModal: () => ({ isOpen: ref(false), zIndex: ref(1), open: vi.fn(), close: vi.fn() }),
}));
const wrappers: ReturnType<typeof shallowMount>[] = [];
const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });
beforeEach(() => {
  vi.useFakeTimers();
  pathqlFetch
    .mockReset()
    .mockResolvedValue([
      { id: "tag", name: "标签", type: "label", ancestor_path: "/dir/tag/", label_path: "目录/标签" },
    ]);
});
afterEach(async () => {
  wrappers.splice(0).forEach((w) => w.unmount());
  await flushPromises();
  vi.useRealTimers();
});
async function fixture() {
  wrappers.push(shallowMount(ImageLabelsPanel, { props: { image: { id: "image", localPath: "/image.jpg" } } }));
  await flushPromises();
  expect(pathqlFetch).toHaveBeenCalledTimes(1);
  pathqlFetch.mockClear();
}
async function settle() {
  vi.advanceTimersByTime(500);
  await flushPromises();
}

describe("Phase F 标签面板", () => {
  it("系统画册增删、排序和无关删除不重读；挂标签与删除标签目录会重读", async () => {
    await fixture();
    for (const albumId of [FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID]) {
      emit("album-images-added", { albumId, imageIds: ["image"] });
      emit("album-images-deleted", { albumId, imageIds: ["image"] });
    }
    emit("album-images-change", { albumId: "tag", imageIds: ["image"] });
    emit("albums-deleted", { albums: [{ id: "other", ancestorPath: "/other/" }] });
    await settle();
    expect(pathqlFetch).not.toHaveBeenCalled();
    emit("album-images-added", { albumId: "tag", imageIds: ["image"] });
    await settle();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    pathqlFetch.mockClear();
    emit("albums-deleted", { albums: [{ id: "dir", ancestorPath: "/dir/" }] });
    await settle();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
  });
  it("移动上级目录会重读并立即改写持有路径，后续按新路径判断删除", async () => {
    await fixture();
    emit("album-moved", { id: "dir", oldAncestorPath: "/dir/", newAncestorPath: "/new/dir/" });
    // 查询尚未落地，先按移动事件更新本地路径。
    emit("albums-deleted", { albums: [{ id: "new", ancestorPath: "/new/" }] });
    await settle();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
  });
});
