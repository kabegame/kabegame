// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import ImageContent from "../image/ImageContent.vue";
import WpeWebPropertiesPanel from "../wallpaper/WpeWebPropertiesPanel.vue";
import { createImageActions } from "@/actions/imageActions";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const fetchImageById = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/utils/imageRow", () => ({ fetchImageById }));
vi.mock("@/api", () => ({
  invoke,
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/messageBox", () => ({ messageBox: { confirm } }));
vi.mock("@/services/pathql", () => ({ pathqlAll: vi.fn(), pathqlFetch: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
  i18n: { global: { t: (key: string) => key } },
}));
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
  invoke.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue("confirm");
});
afterEach(async () => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  await flushPromises();
  vi.useRealTimers();
});
async function fixture(stubs: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const wrapper = shallowMount(ImagePreviewDialog, {
    props: { image: "current", ...props },
    global: {
      // 桌面预览是 Reka 对话框：根、Portal、内容三层透传插槽，内容才渲染得出来
      stubs: {
        DialogRoot: { template: "<div><slot /></div>" },
        DialogPortal: { template: "<div><slot /></div>" },
        DialogContent: { template: "<div><slot /></div>" },
        ...stubs,
      },
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

describe("WPE 壁纸预览的右键菜单与工具条", () => {
  const region = { x: 0, y: 0, width: 1, height: 1 };
  const slot = { template: "<div><slot /></div>" };
  /** 画布桩：截取区域固定，回调直接执行 */
  const canvas = {
    template: "<div><slot /></div>",
    setup(_: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
      expose({ withCaptureRegion: (run: (value: typeof region) => Promise<unknown>) => run(region) });
    },
  };
  async function sceneFixture() {
    fetchImageById.mockImplementation(async (id: string) => ({ id, localPath: `/${id}`, type: "x-wpe/scene" }));
    return fixture(
      { KbResizable: slot, WallpaperPreviewCanvas: canvas, PreviewControlBar: slot },
      { actions: createImageActions() },
    );
  }
  const button = (wrapper: ReturnType<typeof shallowMount>, label: string) =>
    wrapper.find(`button.control-btn[aria-label="${label}"]`);
  async function goLive(wrapper: ReturnType<typeof shallowMount>) {
    wrapper.findComponent(ImageContent).vm.$emit("sceneLive", true);
    await flushPromises();
  }

  it("暂停排第一，画面出来之前置灰；切换的是预览这一份，切图时复位", async () => {
    const wrapper = await sceneFixture();
    const playing = () => wrapper.findComponent(ImageContent).props("videoPlaying");
    expect(wrapper.findAll("button.control-btn")[0].attributes("aria-label")).toBe("gallery.wpePause");
    expect(button(wrapper, "gallery.wpePause").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "gallery.wpeSetCover").attributes("disabled")).toBeDefined();
    await goLive(wrapper);
    expect(button(wrapper, "gallery.wpePause").attributes("disabled")).toBeUndefined();
    await button(wrapper, "gallery.wpePause").trigger("click");
    expect(playing()).toBe(false);
    expect(button(wrapper, "gallery.wpeResume").exists()).toBe(true);
    await wrapper.setProps({ image: "next" });
    await flushPromises();
    expect(playing()).toBe(true);
    expect(button(wrapper, "gallery.wpePause").attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("contextCommand")).toBeUndefined();
  });

  it("面板只拿恢复默认封面的开关", async () => {
    const wrapper = await sceneFixture();
    const panel = wrapper.findComponent(WpeWebPropertiesPanel);
    expect(panel.props("restorableCover")).toBe(true);
  });

  it("设为封面与清空脚本存储由弹窗处理，不交给上层；其它命令照常上报", async () => {
    const wrapper = await sceneFixture();
    await goLive(wrapper);
    await button(wrapper, "gallery.wpeSetCover").trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("capture_wallpaper_cover", { imageId: "current", region });
    await button(wrapper, "gallery.wpeClearStorage").trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith("wpe_scene_clear_storage", { imageId: "current" });
    expect(wrapper.emitted("contextCommand")).toBeUndefined();
    await button(wrapper, "contextMenu.wallpaper").trigger("click");
    expect(wrapper.emitted("contextCommand")).toEqual([
      [{ command: "wallpaper", image: expect.objectContaining({ id: "current" }) }],
    ]);
  });

  it("设为封面进行中置灰、不重复触发", async () => {
    let finish = () => {};
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = await sceneFixture();
    await goLive(wrapper);
    await button(wrapper, "gallery.wpeSetCover").trigger("click");
    await flushPromises();
    expect(button(wrapper, "gallery.wpeSetCover").attributes("disabled")).toBeDefined();
    finish();
    await flushPromises();
    expect(invoke).toHaveBeenCalledOnce();
    expect(button(wrapper, "gallery.wpeSetCover").attributes("disabled")).toBeUndefined();
  });

  it("壁纸里转发的右键在那个位置弹出同一份菜单", async () => {
    const wrapper = await sceneFixture();
    const menu = () =>
      wrapper.findAllComponents({ name: "ActionRenderer" }).find((item) => item.props("mode") === "contextmenu")!;
    expect(menu().props("visible")).toBe(false);
    wrapper.findComponent(ImageContent).vm.$emit("wallpaperContextmenu", { x: 320, y: 180 });
    await flushPromises();
    expect(menu().props("visible")).toBe(true);
    expect(menu().props("position")).toEqual({ x: 320, y: 180 });
    expect(menu().props("actions")).toBe(wrapper.props("actions"));
  });
});
