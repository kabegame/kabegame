// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import ImageContent from "../image/ImageContent.vue";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const fetchImageById = vi.hoisted(() => vi.fn());
vi.mock("@/utils/imageRow", () => ({ fetchImageById }));
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll: vi.fn(), pathqlFetch: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ isCompact: false }) }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ values: {} }) }));
vi.mock("@/stores/kameMessage", () => ({ useKameMessageStore: () => ({ setKamechanHidden: vi.fn() }) }));
vi.mock("@/composables/useAudioKeepAlive", () => ({ useAudioKeepAlive: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock("@/composables/useModal", () => ({
  useModal: () => {
    const isOpen = ref(false);
    return {
      isOpen,
      zIndex: ref(1),
      open: () => {
        isOpen.value = true;
      },
      close: () => {
        isOpen.value = false;
      },
    };
  },
}));
vi.mock("@vueuse/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vueuse/core")>()),
  useLocalStorage: (_key: string, value: unknown) => ref(value),
}));
vi.mock("@/composables/usePanzoomPreview", () => ({
  usePanzoomPreview: () => ({
    wrapperRef: ref(null),
    scale: ref(1),
    canPan: ref(false),
    handleWheel: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomTo: vi.fn(),
  }),
}));
const wrappers: ReturnType<typeof shallowMount>[] = [];
const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });
beforeEach(() => {
  vi.useFakeTimers();
  fetchImageById.mockReset().mockImplementation(async (id: string) => ({ id, localPath: `/${id}.jpg` }));
});
afterEach(async () => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  await flushPromises();
  vi.useRealTimers();
});
async function fixture() {
  const wrapper = shallowMount(ImagePreviewDialog, {
    props: { image: "current" },
    global: {
      stubs: { "el-dialog": { template: "<div><slot /></div>" }, "el-icon": true },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  expect(fetchImageById).toHaveBeenCalledExactlyOnceWith("current");
  fetchImageById.mockClear();
  return wrapper;
}

describe("裸 id 预览的事件保鲜", () => {
  it("新增、其它图片删除、单图 / 批量字段变化不重解析，只有当前图删除重解析", async () => {
    const wrapper = await fixture();
    emit("images-added", { images: [{ id: "new" }] });
    emit("images-deleted", { imageIds: ["other"] });
    emit("image-changed", { patch: { id: "current", displayName: "renamed" } });
    emit("images-change", { patches: [{ id: "current", thumbnailPath: "/new.jpg" }] });
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(fetchImageById).not.toHaveBeenCalled();
    // 字段已经打到预览自己持有的对象。
    expect(wrapper.findComponent(ImageContent).props("image")).toMatchObject({
      id: "current",
      displayName: "renamed",
      thumbnailPath: "/new.jpg",
    });
    emit("images-deleted", { imageIds: ["other", "current"] });
    await flushPromises();
    expect(fetchImageById).toHaveBeenCalledExactlyOnceWith("current");
    fetchImageById.mockResolvedValueOnce(null);
    emit("images-deleted", { imageIds: ["current"] });
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.emitted("resolve-failed")).toEqual([[{ id: "current", reason: "missing" }]]);
  });
  it("切换 id 后旧图删除不重解析，新图删除才重解析；相关画册成员仍重解析", async () => {
    const wrapper = await fixture();
    await wrapper.setProps({ image: "next" });
    await flushPromises();
    fetchImageById.mockClear();
    emit("images-deleted", { imageIds: ["current"] });
    expect(fetchImageById).not.toHaveBeenCalled();
    emit("images-deleted", { imageIds: ["next"] });
    await flushPromises();
    expect(fetchImageById).toHaveBeenCalledExactlyOnceWith("next");
    fetchImageById.mockClear();
    emit("album-images-added", { albumId: "other", imageIds: ["current"] });
    vi.advanceTimersByTime(300);
    expect(fetchImageById).not.toHaveBeenCalled();
    emit("album-images-added", { albumId: "other", imageIds: ["next"] });
    await flushPromises();
    expect(fetchImageById).toHaveBeenCalledExactlyOnceWith("next");
  });
  it("收藏与隐藏成员只补丁，不重解析；整行删图标记不推导取消隐藏，排序不重解析", async () => {
    const wrapper = await fixture();
    const row = () => wrapper.findComponent(ImageContent).props("image");
    for (const [albumId, field] of [
      [FAVORITE_ALBUM_ID, "favorite"],
      [HIDDEN_ALBUM_ID, "isHidden"],
    ] as const) {
      emit("album-images-added", { albumId, imageIds: ["current"] });
      vi.advanceTimersByTime(300);
      await flushPromises();
      expect(row()).toMatchObject({ [field]: true });
      if (field === "isHidden") {
        emit("album-images-deleted", { albumId, imageIds: ["current"], imagesDeleted: true });
        vi.advanceTimersByTime(300);
        await flushPromises();
        expect(row()).toMatchObject({ isHidden: true });
      }
      emit("album-images-deleted", { albumId, imageIds: ["current"] });
      vi.advanceTimersByTime(300);
      await flushPromises();
      expect(row()).toMatchObject({ [field]: false });
    }
    emit("album-images-change", { albumId: "other", imageIds: ["current"] });
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(fetchImageById).not.toHaveBeenCalled();
  });
  it("传入完整行时由上层保鲜，不自行解析或订阅", async () => {
    const wrapper = shallowMount(ImagePreviewDialog, {
      props: { image: { id: "current", localPath: "/current.jpg" } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    emit("images-deleted", { imageIds: ["current"] });
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(fetchImageById).not.toHaveBeenCalled();
  });
});
