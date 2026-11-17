// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageContent from "./ImageContent.vue";
import type { ImageInfo } from "@/types/image";
import type { WpeVideoProps } from "../wallpaper/types";
import { WPE_FOLLOW_SCENE_SETTINGS } from "@/utils/wpeSettings";

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
const rpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/api/rpc", () => ({ invoke: rpc.invoke }));

const wrappers: ReturnType<typeof mount>[] = [];
const picture = (id: string) =>
  ({
    id,
    type: "image/jpg",
    localPath: `C:/media/${id}.jpg`,
    thumbnailPath: `C:/thumbs/${id}.jpg`,
    localExists: true,
  }) as ImageInfo;
const video = (id: string, type = "video/mp4") =>
  ({
    id,
    type,
    localPath: type === "x-wpe/video" ? `C:/workshop/${id}` : `C:/media/${id}.mp4`,
    compatiblePath: type === "x-wpe/video" ? `C:/workshop/${id}/video.mp4` : "",
    thumbnailPath: "",
    localExists: true,
  }) as ImageInfo;

function mountContent(image: ImageInfo, props: Record<string, unknown> = {}) {
  const wrapper = mount(ImageContent, {
    props: { image, prefer: "original", variant: "wallpaper", ...props },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function fire(el: Element, type: string) {
  el.dispatchEvent(new Event(type));
  await flushPromises();
}

let play: ReturnType<typeof vi.fn>;
beforeEach(() => {
  play = vi.fn(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  rpc.invoke.mockReset();
});

describe("ImageContent 的壁纸变体（桌面）", () => {
  it("图片：同预览先出缩略图，缩略层出来就 ready、只发一次；原图出来报 displayChange；不能拖出", async () => {
    const wrapper = mountContent(picture("a"));
    const thumb = wrapper.find("img.thumbnail-layer");
    const orig = wrapper.find("img.original-layer");
    expect(orig.attributes("draggable")).toBe("false");
    await fire(thumb.element, "load");
    expect(wrapper.emitted("ready")).toHaveLength(1);
    await fire(orig.element, "load");
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(wrapper.emitted("displayChange")).toHaveLength(2);
  });

  it("加载：同预览，超过 300 ms 没有画面就显示骨架，骨架出来就 ready", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountContent(picture("a"));
      vi.advanceTimersByTime(250);
      await flushPromises();
      expect(wrapper.find(".ic-loading-overlay").exists()).toBe(false);
      expect(wrapper.emitted("ready")).toBeUndefined();
      vi.advanceTimersByTime(100);
      await flushPromises();
      expect(wrapper.find(".ic-loading-overlay").exists()).toBe(true);
      expect(wrapper.emitted("ready")).toHaveLength(1);
      await fire(wrapper.find("img.thumbnail-layer").element, "load");
      expect(wrapper.find(".ic-loading-overlay").exists()).toBe(false);
      expect(wrapper.emitted("ready")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("图片：立即加载，不懒加载（桌面新层 ready 前不可见，当前层是视频时懒加载一直不开始）；网格照旧懒加载", async () => {
    const wrapper = mountContent(picture("a"));
    expect(wrapper.find("img.thumbnail-layer").attributes("loading")).toBe("eager");
    expect(wrapper.find("img.original-layer").attributes("loading")).toBe("eager");
    const grid = mountContent(picture("b"), { variant: undefined, prefer: "thumbnail" });
    expect(grid.find("img.thumbnail-layer").attributes("loading")).toBe("lazy");
  });

  it("丢失：同预览画丢失图，报 error 并 ready（桌面照样过渡到丢失图）", async () => {
    const wrapper = mountContent({ ...picture("a"), thumbnailPath: "" } as ImageInfo);
    expect(wrapper.emitted("ready")).toBeUndefined();
    await fire(wrapper.find("img.original-layer").element, "error");
    expect(wrapper.find(".ic-lost").exists()).toBe(true);
    expect(wrapper.emitted("error")).toHaveLength(1);
    expect(wrapper.emitted("ready")).toHaveLength(1);
  });

  it("预览（默认变体）丢失时不 ready、骨架出来也不 ready", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(ImageContent, {
        props: { image: { ...picture("a"), thumbnailPath: "" } as ImageInfo, prefer: "original" },
        attachTo: document.body,
      });
      wrappers.push(wrapper);
      vi.advanceTimersByTime(400);
      await flushPromises();
      expect(wrapper.find(".ic-loading-overlay").exists()).toBe(true);
      await fire(wrapper.find("img.original-layer").element, "error");
      expect(wrapper.find(".ic-lost").exists()).toBe(true);
      expect(wrapper.emitted("ready")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("视频：静音起播，成功后按 playback 的音量出声；音量变了跟着改；videoMuted 时为 0；倍速钳到 0.25…4", async () => {
    const wrapper = mountContent(video("v"), {
      videoPlaying: true,
      playback: { volume: 0.4, playbackRate: 9, sceneSettings: WPE_FOLLOW_SCENE_SETTINGS },
    });
    await flushPromises();
    const el = wrapper.find("video").element as HTMLVideoElement;
    expect(play).toHaveBeenCalled();
    expect(el.volume).toBeCloseTo(0.4);
    expect(el.muted).toBe(false);
    expect(el.playbackRate).toBe(4);
    Object.defineProperty(el, "paused", { configurable: true, value: false });
    await wrapper.setProps({ playback: { volume: 0.7, playbackRate: 1, sceneSettings: WPE_FOLLOW_SCENE_SETTINGS } });
    expect(el.volume).toBeCloseTo(0.7);
    expect(el.playbackRate).toBe(1);
    await wrapper.setProps({ videoMuted: true });
    expect(el.muted).toBe(true);
    await fire(el, "loadeddata");
    await fire(el, "canplay");
    expect(wrapper.emitted("ready")).toHaveLength(1);
  });

  it("WPE 视频：给了作者属性就用；翻转、滤镜落在 <video> 上，留边色在根上", async () => {
    const wpeVideo: WpeVideoProps = {
      alignment: "cover",
      position: 0,
      offsetX: 0,
      offsetY: 0,
      zoom: 1,
      flipH: true,
      background: [1, 2, 3],
      rate: null,
      volume: null,
      color: { brightness: 0, contrast: 0, saturation: 0, hue: 0 },
    };
    const wrapper = mountContent(video("w", "x-wpe/video"), { wpeVideo, fit: "contain" });
    await flushPromises();
    const el = wrapper.find("video").element as HTMLVideoElement;
    expect(el.style.transform).toBe("scaleX(-1)");
    expect(el.style.objectFit).toBe("contain");
    expect(el.style.filter).toContain("brightness(1)");
    expect((wrapper.element as HTMLElement).style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(rpc.invoke).not.toHaveBeenCalled();
  });
});

describe("ImageContent 的 WPE 视频作者属性（图库）", () => {
  it("没给作者属性时按图片 id 取壁纸目标里的", async () => {
    rpc.invoke.mockResolvedValue({
      id: "w",
      path: "C:/workshop/w",
      wpeVideo: { flipH: true, position: 0, offsetX: 0, offsetY: 0 },
    });
    const wrapper = mount(ImageContent, { props: { image: video("w", "x-wpe/video"), prefer: "original" } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(rpc.invoke).toHaveBeenCalledWith("get_wallpaper_target_for_image", { imageId: "w" });
    expect((wrapper.find("video").element as HTMLVideoElement).style.transform).toBe("scaleX(-1)");
  });

  it("普通视频不取", async () => {
    const wrapper = mount(ImageContent, { props: { image: video("v"), prefer: "original" } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(rpc.invoke).not.toHaveBeenCalled();
  });
});

describe("displaySource", () => {
  it("取已经出来的原图，没有就取缩略图；都没出来是 null", async () => {
    const wrapper = mountContent(picture("a"));
    const source = () => (wrapper.vm as unknown as { displaySource: () => unknown }).displaySource();
    expect(source()).toBeNull();
    const thumb = wrapper.find("img.thumbnail-layer").element as HTMLImageElement;
    Object.defineProperty(thumb, "complete", { configurable: true, value: true });
    Object.defineProperty(thumb, "naturalWidth", { configurable: true, value: 320 });
    Object.defineProperty(thumb, "naturalHeight", { configurable: true, value: 180 });
    expect(source()).toMatchObject({ kind: "image", width: 320, height: 180 });
    const orig = wrapper.find("img.original-layer").element as HTMLImageElement;
    Object.defineProperty(orig, "complete", { configurable: true, value: true });
    Object.defineProperty(orig, "naturalWidth", { configurable: true, value: 3840 });
    Object.defineProperty(orig, "naturalHeight", { configurable: true, value: 2160 });
    expect(source()).toMatchObject({ kind: "image", width: 3840, height: 2160 });
  });
});
