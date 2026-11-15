// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageContent from "./ImageContent.vue";
import type { ImageInfo } from "@/types/image";

vi.mock("@/stores/ui", async () => {
  const { ref } = await import("vue");
  return { useUiStore: () => ({ isCompact: ref(false) }) };
});

vi.mock("@/utils/fileUrl", () => ({
  fileToUrl: (path: string) => `file:///${path}`,
  compatibleToUrl: (path: string) => `comp:///${path}`,
  thumbnailToUrl: (path: string) => `thumb:///${path}`,
  fileNameFromUrlOrPath: (path: string) => path.split("/").pop() ?? "",
}));

/** 壁纸组件桩：记录挂载次数与 props，live / fail / error 由测试手动发 */
let mounts = 0;
const WallpaperStub = defineComponent({
  name: "WpeWallpaperContent",
  props: {
    imageId: String,
    styleMode: String,
    volume: Number,
    paused: Boolean,
    interactive: Boolean,
    sceneSettings: Object,
  },
  emits: ["live", "fail", "error", "contextmenu", "progress"],
  setup() {
    mounts += 1;
    return () => h("div", { class: "wallpaper-stub" });
  },
});

/** 进度覆盖层桩（真件要 i18n 插件）：只看 props */
const OverlayStub = defineComponent({
  name: "WpeLoadingOverlay",
  props: { scene: Boolean, value: Number, stage: String, failure: Array, placement: String, count: Object },
  setup: () => () => h("div", { class: "overlay-stub" }),
});

const wrappers: ReturnType<typeof mount>[] = [];
const wallpaper = (id: string, type: string, thumbnailPath: string) =>
  ({ id, type, localPath: `C:/workshop/${id}`, thumbnailPath, localExists: true }) as ImageInfo;

function mountContent(image: ImageInfo, props: Record<string, unknown> = {}) {
  const wrapper = mount(ImageContent, {
    props: { image, prefer: "original", ...props },
    global: { stubs: { WpeWallpaperContent: WallpaperStub, WpeLoadingOverlay: OverlayStub } },
    // 挂进文档：媒体事件按 isConnected 判断是不是过期元素的迟到事件
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}
const overlay = (wrapper: ReturnType<typeof mount>) => wrapper.find(".ic-loading-overlay").exists();
const thumb = (wrapper: ReturnType<typeof mount>) => wrapper.find("img.thumbnail-layer");
const live = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent(WallpaperStub);
const shown = (wrapper: ReturnType<typeof mount>) => live(wrapper).classes().includes("opacity-100");
async function emitLive(
  wrapper: ReturnType<typeof mount>,
  event: "live" | "fail" | "error" | "progress",
  ...args: unknown[]
) {
  live(wrapper).vm.$emit(event, ...args);
  await flushPromises();
}
async function thumbEvent(wrapper: ReturnType<typeof mount>, type: "load" | "error") {
  thumb(wrapper).element.dispatchEvent(new Event(type));
  await flushPromises();
}
async function advance(ms: number) {
  vi.advanceTimersByTime(ms);
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  mounts = 0;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe("ImageContent 的壁纸形态：缩略层打底，实时画面当原图", () => {
  it.each(["x-wpe/web", "x-wpe/scene"])("%s 缩略层一开始就在，ready 在它加载完发", async (type) => {
    const wrapper = mountContent(wallpaper("7", type, "C:/workshop/7/preview.jpg"));
    expect(thumb(wrapper).attributes("src")).toBe("thumb:///C:/workshop/7/preview.jpg");
    expect(shown(wrapper)).toBe(false);
    await thumbEvent(wrapper, "load");
    expect(wrapper.emitted("ready")).toHaveLength(1);
    await advance(400);
    expect(overlay(wrapper)).toBe(false);
  });

  it("实时画面 live 且满 300 ms 才揭开；揭开不再发 ready，告诉上层 wallpaperLive", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    await thumbEvent(wrapper, "load");
    await advance(100);
    await emitLive(wrapper, "live");
    expect(shown(wrapper)).toBe(false);
    await advance(250);
    expect(shown(wrapper)).toBe(true);
    expect(wrapper.emitted("wallpaperLive")).toEqual([[true]]);
    expect(wrapper.emitted("ready")).toHaveLength(1);
    // 缩略层留着垫底（实时画面盖在上面）
    expect(thumb(wrapper).exists()).toBe(true);
  });

  it("没有缩略图时 ready 等实时画面揭开", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/web", ""));
    expect(thumb(wrapper).exists()).toBe(false);
    await advance(400);
    expect(overlay(wrapper)).toBe(true);
    await emitLive(wrapper, "live");
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(overlay(wrapper)).toBe(false);
  });

  it("fail 当原图加载失败：缩略层是最终画面，不丢失；之后重新 live 照样揭开", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    await thumbEvent(wrapper, "load");
    await advance(400);
    await emitLive(wrapper, "fail", ["object:particle"]);
    expect(wrapper.find(".ic-lost").exists()).toBe(false);
    expect(thumb(wrapper).exists()).toBe(true);
    expect(wrapper.emitted("error")).toBeUndefined();
    await emitLive(wrapper, "live");
    expect(shown(wrapper)).toBe(true);
    await emitLive(wrapper, "fail", ["device:lost"]);
    expect(shown(wrapper)).toBe(false);
    expect(wrapper.emitted("wallpaperLive")).toEqual([[true], [false]]);
  });

  it("缩略层与实时画面都显示不了才丢失；只是缩略坏了、实时画面还在等不丢失", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    await thumbEvent(wrapper, "error");
    expect(wrapper.find(".ic-lost").exists()).toBe(false);
    await emitLive(wrapper, "fail", ["render:timeout"]);
    expect(wrapper.find(".ic-lost").exists()).toBe(true);
    expect(wrapper.emitted("error")).toHaveLength(1);
  });

  it("目标取不到（error）直接丢失", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/web", "C:/workshop/7/preview.jpg"));
    await emitLive(wrapper, "error", "wallpaper target not found");
    expect(wrapper.find(".ic-lost").exists()).toBe(true);
    expect(wrapper.emitted("error")).toHaveLength(1);
  });

  it.each(["x-wpe/web", "x-wpe/scene"])("%s 换封面（thumbnailPath 变）只换缩略层，实时画面不重来", async (type) => {
    const wrapper = mountContent(wallpaper("7", type, "C:/workshop/7/preview.jpg"));
    await thumbEvent(wrapper, "load");
    await advance(400);
    await emitLive(wrapper, "live");
    expect(shown(wrapper)).toBe(true);

    await wrapper.setProps({ image: wallpaper("7", type, "C:/data/thumbnails/7-cover.jpg") });
    await advance(400);
    expect(thumb(wrapper).attributes("src")).toBe("thumb:///C:/data/thumbnails/7-cover.jpg");
    expect(shown(wrapper)).toBe(true);
    expect(overlay(wrapper)).toBe(false);
    expect(mounts).toBe(1);
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(wrapper.emitted("wallpaperLive")).toEqual([[true]]);
  });

  it("换成另一张壁纸：实时画面重挂、收起，ready 照常再发", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/web", "C:/workshop/7/preview.jpg"));
    await thumbEvent(wrapper, "load");
    await advance(400);
    await emitLive(wrapper, "live");
    await wrapper.setProps({ image: wallpaper("8", "x-wpe/web", "C:/workshop/8/preview.jpg") });
    await flushPromises();
    expect(mounts).toBe(2);
    expect(shown(wrapper)).toBe(false);
    expect(wrapper.emitted("wallpaperLive")).toEqual([[true], [false]]);
    await thumbEvent(wrapper, "load");
    expect(wrapper.emitted("ready")).toHaveLength(2);
  });

  it("播放参数下传：音量与场景设置取 playback，静音时音量 0，暂停看 videoPlaying，样式按 fit", async () => {
    const sceneSettings = { postprocess: "ultra", reflection: "enabled", shadows: "low", volumetrics: "high" };
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"), {
      playback: { volume: 0.4, sceneSettings },
      videoPlaying: true,
      interactive: true,
    });
    expect(live(wrapper).props()).toMatchObject({
      imageId: "7",
      styleMode: "fit",
      volume: 0.4,
      paused: false,
      interactive: true,
      sceneSettings,
    });
    await wrapper.setProps({ videoMuted: true, videoPlaying: false, fit: "cover" });
    expect(live(wrapper).props()).toMatchObject({ volume: 0, paused: true, styleMode: "fill" });
  });

  it("进度覆盖层：挂上就在；场景按宿主进度走，live 后走满、停一下再收起", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    const overlay = () => wrapper.findComponent(OverlayStub);
    expect(overlay().exists()).toBe(true);
    expect(overlay().props()).toMatchObject({ scene: true, stage: "page" });
    await emitLive(wrapper, "progress", { stage: "compile", done: 1, total: 2 });
    expect(overlay().props("stage")).toBe("compile");
    expect(overlay().props("value")).toBeCloseTo(0.3);
    expect(overlay().props("count")).toEqual({ done: 1, total: 2 });
    await advance(400);
    await emitLive(wrapper, "live");
    expect(overlay().props("value")).toBe(1);
    await advance(250);
    expect(overlay().exists()).toBe(false);
  });

  it("fail：覆盖层带上原因走满、停一下收起，原因换到缩略图底部留着；之后能渲染了收起；网页壁纸是不定进度", async () => {
    const scene = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    await emitLive(scene, "fail", ["object:particle"]);
    const overlays = () => scene.findAllComponents(OverlayStub);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0].props()).toMatchObject({ value: 1, failure: ["object:particle"] });
    await advance(250);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0].props()).toMatchObject({ placement: "bottom", failure: ["object:particle"] });
    expect(thumb(scene).exists()).toBe(true);
    // 改属性后能渲染了：底部的原因收起
    await emitLive(scene, "live");
    expect(overlays()).toHaveLength(0);

    const web = mountContent(wallpaper("8", "x-wpe/web", "C:/workshop/8/preview.jpg"));
    expect(web.findComponent(OverlayStub).props("scene")).toBe(false);
  });

  it("换成另一张壁纸：覆盖层从头再来", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/scene", "C:/workshop/7/preview.jpg"));
    await emitLive(wrapper, "progress", { stage: "gpu", done: 1, total: 1 });
    await advance(400);
    await emitLive(wrapper, "live");
    await advance(250);
    await wrapper.setProps({ image: wallpaper("9", "x-wpe/scene", "C:/workshop/9/preview.jpg") });
    await flushPromises();
    const overlay = wrapper.findComponent(OverlayStub);
    expect(overlay.exists()).toBe(true);
    expect(overlay.props()).toMatchObject({ stage: "page", value: 0 });
  });
});
