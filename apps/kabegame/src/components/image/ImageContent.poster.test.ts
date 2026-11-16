// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageContent from "./ImageContent.vue";
import type { ImageInfo } from "@/types/image";

vi.mock("@/stores/ui", async () => {
  const { ref } = await import("vue");
  return { useUiStore: () => ({ isCompact: ref(false) }) };
});

const wrappers: ReturnType<typeof mount>[] = [];

const clip = (thumbnailPath: string, extra: Partial<ImageInfo> = {}) =>
  ({
    id: "v",
    type: "video/mp4",
    localPath: "C:/media/v.mp4",
    thumbnailPath,
    localExists: true,
    ...extra,
  }) as ImageInfo;

const wpeClip = (thumbnailPath: string) =>
  clip(thumbnailPath, {
    type: "x-wpe/video",
    localPath: "C:/workshop/1",
    compatiblePath: "C:/workshop/1/v.mp4",
  });

function mountGrid(image: ImageInfo, videoPlaying = false) {
  const wrapper = mount(ImageContent, {
    props: { image, prefer: "thumbnail", videoPlaying },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("ImageContent 视频缩略位按缩略图本身决定放什么", () => {
  it("首帧静图：只显示图，播放时才挂原视频、停了卸载", async () => {
    const wrapper = mountGrid(clip("C:/thumbs/v.jpg"));
    expect(wrapper.find("img").attributes("src")).toContain("v.jpg");
    expect(wrapper.find("video").exists()).toBe(false);

    await wrapper.setProps({ videoPlaying: true });
    await flushPromises();
    const video = wrapper.find("video");
    expect(video.attributes("src")).toContain("media/v.mp4");
    // 出第一帧之前透明，缩略图还在下面
    expect(video.classes()).toContain("opacity-0");
    expect(wrapper.find("img").exists()).toBe(true);

    await video.trigger("loadeddata");
    expect(wrapper.find("video").classes()).toContain("opacity-100");

    await wrapper.setProps({ videoPlaying: false });
    await flushPromises();
    expect(wrapper.find("video").exists()).toBe(false);
  });

  it("gif 动图缩略图（如从 Android 同步来的库）同样当图显示", () => {
    const wrapper = mountGrid(clip("C:/thumbs/v.gif"));
    expect(wrapper.find("img").attributes("src")).toContain("v.gif");
    expect(wrapper.find("video").exists()).toBe(false);
  });

  it("旧版本的 mp4 短片缩略图直接当视频放", () => {
    const wrapper = mountGrid(clip("C:/thumbs/v-preview.mp4"));
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("video").attributes("src")).toContain("v-preview.mp4");
  });

  it("没有独立缩略图时放原视频", () => {
    const wrapper = mountGrid(clip(""));
    expect(wrapper.find("video").attributes("src")).toContain("media/v.mp4");
  });

  it("WPE 视频：缩略图打底，播放时挂入口视频（不碰壁纸目录）", async () => {
    const wrapper = mountGrid(wpeClip("C:/workshop/1/preview.gif"));
    expect(wrapper.find("img").attributes("src")).toContain("preview.gif");
    expect(wrapper.find("video").exists()).toBe(false);

    await wrapper.setProps({ videoPlaying: true });
    await flushPromises();
    expect(wrapper.find("video").attributes("src")).toContain("workshop/1/v.mp4");
  });

  it("缩略图坏了：挂原视频停在首帧当缩略图", async () => {
    const wrapper = mountGrid(clip("C:/thumbs/v.jpg"));
    await wrapper.find("img").trigger("error");
    await flushPromises();
    expect(wrapper.find("video").attributes("src")).toContain("media/v.mp4");
  });

  it("预览里设封面：缩略图换了，正在播的视频不重置、不回到加载态", async () => {
    const wrapper = mount(ImageContent, {
      props: { image: clip("C:/thumbs/old.jpg"), prefer: "original", videoPlaying: true },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    const video = wrapper.find("video");
    await video.trigger("loadeddata");
    await wrapper.setProps({ image: clip("C:/thumbs/cover.jpg") });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(wrapper.find("video").element).toBe(video.element);
    expect(wrapper.find(".ic-loading-overlay").exists()).toBe(false);
  });
});
