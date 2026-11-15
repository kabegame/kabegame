// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import ImageContent from "../image/ImageContent.vue";
import WpeWebPropertiesPanel from "../wallpaper/WpeWebPropertiesPanel.vue";
import { createImageActions } from "@/actions/imageActions";
import type { ActionContext, ActionItem } from "@/actions/types";
import type { ImageInfo } from "@/types/image";

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
/** 缩放的桩：几个方法是共用的 spy，用例里读 */
const panzoom = vi.hoisted(() => ({
  handleWheel: vi.fn(),
  reset: vi.fn(),
  startPan: vi.fn(() => false),
  endPan: vi.fn(),
}));
vi.mock("@/composables/usePanzoomPreview", () => ({
  usePanzoomPreview: () => ({
    wrapperRef: ref(null),
    scale: ref(1),
    canPan: ref(false),
    handleWheel: panzoom.handleWheel,
    reset: panzoom.reset,
    destroy: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomTo: vi.fn(),
    startPan: panzoom.startPan,
    endPan: panzoom.endPan,
  }),
}));
const wrappers: ReturnType<typeof shallowMount>[] = [];
const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });
beforeEach(() => {
  vi.useFakeTimers();
  panzoom.handleWheel.mockReset();
  panzoom.reset.mockReset();
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
  /** 画布桩：截取区域固定，回调直接执行；记下调用方给的可见区域 */
  const viewports: unknown[] = [];
  const canvas = {
    template: "<div><slot /></div>",
    setup(_: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
      expose({
        withCaptureRegion: (run: (value: typeof region) => Promise<unknown>, viewport?: unknown) => {
          viewports.push(viewport);
          return run(region);
        },
      });
    },
  };
  async function sceneFixture() {
    viewports.splice(0);
    fetchImageById.mockImplementation(async (id: string) => ({ id, localPath: `/${id}`, type: "x-wpe/scene" }));
    return fixture(
      { KbResizable: slot, WallpaperPreviewCanvas: canvas, PreviewControlBar: slot },
      { actions: createImageActions() },
    );
  }
  type Wrapper = ReturnType<typeof shallowMount>;
  const button = (wrapper: Wrapper, label: string) => wrapper.find(`button.control-btn[aria-label="${label}"]`);
  const menu = (wrapper: Wrapper) =>
    wrapper.findAllComponents({ name: "ActionRenderer" }).find((item) => item.props("mode") === "contextmenu")!;
  /** 右键菜单里可见的项（按菜单给的上下文求值），带求好的文字与置灰 */
  const menuItems = (wrapper: Wrapper) => {
    const context = menu(wrapper).props("context") as ActionContext<ImageInfo>;
    return (menu(wrapper).props("actions") as ActionItem<ImageInfo>[])
      .filter((action) => action.visible === undefined || action.visible(context))
      .map((action) => ({
        key: action.key,
        label: typeof action.label === "function" ? action.label(context) : action.label,
        disabled: typeof action.disabled === "function" ? action.disabled(context) : !!action.disabled,
      }));
  };
  const item = (wrapper: Wrapper, key: string) => menuItems(wrapper).find((entry) => entry.key === key)!;
  /** 在右键菜单里点一项 */
  async function choose(wrapper: Wrapper, command: string) {
    menu(wrapper).vm.$emit("command", command);
    await flushPromises();
  }
  async function goLive(wrapper: Wrapper) {
    wrapper.findComponent(ImageContent).vm.$emit("wallpaperLive", true);
    await flushPromises();
  }

  it("工具条和图片一样：缩放组与全屏，没有右键菜单的映射", async () => {
    const wrapper = await sceneFixture();
    const labels = wrapper.findAll("button.control-btn").map((item) => item.attributes("aria-label"));
    expect(labels).toEqual(["gallery.zoomOut", "gallery.zoomIn", "gallery.fullscreen"]);
    expect(wrapper.findComponent({ name: "PreviewRangeSlider" }).exists()).toBe(true);
  });

  it("暂停在右键菜单里排第一，画面出来之前置灰；切换的是预览这一份，切图时复位", async () => {
    const wrapper = await sceneFixture();
    const playing = () => wrapper.findComponent(ImageContent).props("videoPlaying");
    expect(menuItems(wrapper)[0]).toEqual({ key: "pauseWallpaper", label: "gallery.wpePause", disabled: true });
    expect(item(wrapper, "setCover").disabled).toBe(true);
    await goLive(wrapper);
    expect(item(wrapper, "pauseWallpaper").disabled).toBe(false);
    await choose(wrapper, "pauseWallpaper");
    expect(playing()).toBe(false);
    expect(item(wrapper, "pauseWallpaper").label).toBe("gallery.wpeResume");
    await wrapper.setProps({ image: "next" });
    await flushPromises();
    expect(playing()).toBe(true);
    expect(item(wrapper, "pauseWallpaper").disabled).toBe(true);
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
    // 挂载时读这张的预览设置等调用不算
    invoke.mockClear();
    await choose(wrapper, "setCover");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("capture_wallpaper_cover", { imageId: "current", region });
    await choose(wrapper, "clearStorage");
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith("wpe_scene_clear_storage", { imageId: "current" });
    expect(wrapper.emitted("contextCommand")).toBeUndefined();
    await choose(wrapper, "wallpaper");
    expect(wrapper.emitted("contextCommand")).toEqual([
      [{ command: "wallpaper", image: expect.objectContaining({ id: "current" }) }],
    ]);
  });

  it("设为封面截看得见的那一块：把壁纸的可见区域（Panzoom 的父元素）交给画布求交，不复位缩放", async () => {
    const wrapper = await sceneFixture();
    await goLive(wrapper);
    panzoom.reset.mockClear();
    await choose(wrapper, "setCover");
    expect(viewports).toHaveLength(1);
    expect((viewports[0] as Element).classList.contains("preview-wallpaper-wrapper")).toBe(true);
    expect(panzoom.reset).not.toHaveBeenCalled();
  });

  it("设为封面进行中置灰、不重复触发", async () => {
    let finish = () => {};
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = await sceneFixture();
    await goLive(wrapper);
    invoke.mockClear();
    await choose(wrapper, "setCover");
    expect(item(wrapper, "setCover").disabled).toBe(true);
    await choose(wrapper, "setCover");
    finish();
    await flushPromises();
    expect(invoke).toHaveBeenCalledOnce();
    expect(item(wrapper, "setCover").disabled).toBe(false);
  });

  it("壁纸上的滚轮交给缩放（同图片：Ctrl+滚轮缩放、滚轮平移）", async () => {
    const wrapper = await sceneFixture();
    await wrapper.find(".preview-container").trigger("wheel", { deltaY: -100, ctrlKey: true });
    expect(panzoom.handleWheel).toHaveBeenCalledOnce();
  });

  it("切到另一张壁纸时复位缩放（画布元素没换，实例还在）", async () => {
    const wrapper = await sceneFixture();
    panzoom.reset.mockClear();
    await wrapper.setProps({ image: "next" });
    await flushPromises();
    expect(panzoom.reset).toHaveBeenCalled();
  });

  it("覆盖层拿缩放的平移起止", async () => {
    const wrapper = await sceneFixture();
    const overlay = wrapper.findComponent({ name: "WallpaperPointerOverlay" });
    expect(overlay.props("startPan")).toBe(panzoom.startPan);
    expect(overlay.props("endPan")).toBe(panzoom.endPan);
    expect(overlay.props("pannable")).toBe(false);
  });

  it("壁纸里转发的右键在那个位置弹出同一份菜单", async () => {
    const wrapper = await sceneFixture();
    expect(menu(wrapper).props("visible")).toBe(false);
    wrapper.findComponent(ImageContent).vm.$emit("wallpaperContextmenu", { x: 320, y: 180 });
    await flushPromises();
    expect(menu(wrapper).props("visible")).toBe(true);
    expect(menu(wrapper).props("position")).toEqual({ x: 320, y: 180 });
    expect(menu(wrapper).props("actions")).toBe(wrapper.props("actions"));
  });
});

describe("翻页箭头", () => {
  it("只有点箭头才切图，点两侧区域的别处不切", async () => {
    const wrapper = await fixture({}, { canPrev: true, canNext: true });
    const zone = (side: "left" | "right") => wrapper.find(`.preview-nav-zone.${side}`);
    await zone("right").trigger("click");
    await zone("left").trigger("click");
    expect(wrapper.emitted("switch")).toBeUndefined();
    await zone("right").find("button.preview-nav-btn").trigger("click");
    expect(wrapper.emitted("switch")).toEqual([[{ direction: "next", source: "manual" }]]);
  });
});
