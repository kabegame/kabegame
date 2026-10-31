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
const video = (id: string, type = "video/mp4") =>
  ({ id, type, localPath: `C:/media/${id}.mp4`, thumbnailPath: "", localExists: true }) as ImageInfo;

function mountContent(image: ImageInfo) {
  const wrapper = mount(ImageContent, { props: { image, prefer: "original" } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 当前的 <video>，并监视它是否被释放（去掉 src 并 load）。 */
function currentVideo(wrapper: ReturnType<typeof mount>) {
  const el = wrapper.find("video").element as HTMLVideoElement;
  expect(el.getAttribute("src")).toBeTruthy();
  return { el, load: vi.spyOn(el, "load") };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("ImageContent 释放旧 <video>", () => {
  it("换源时释放被换掉的元素，新元素保留 src", async () => {
    const wrapper = mountContent(video("a"));
    const old = currentVideo(wrapper);
    await wrapper.setProps({ image: video("b") });
    await flushPromises();
    expect(old.el.isConnected).toBe(false);
    expect(old.el.hasAttribute("src")).toBe(false);
    expect(old.load).toHaveBeenCalled();
    const next = wrapper.find("video").element as HTMLVideoElement;
    expect(next).not.toBe(old.el);
    expect(next.getAttribute("src")).toContain("b.mp4");
  });

  it("切成图片形态时释放", async () => {
    const wrapper = mountContent(video("a"));
    const old = currentVideo(wrapper);
    await wrapper.setProps({ image: video("c", "image/jpg") });
    await flushPromises();
    expect(wrapper.find("video").exists()).toBe(false);
    expect(old.el.hasAttribute("src")).toBe(false);
    expect(old.load).toHaveBeenCalled();
  });

  it("卸载时释放", () => {
    const wrapper = mountContent(video("a"));
    const old = currentVideo(wrapper);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(old.el.hasAttribute("src")).toBe(false);
    expect(old.load).toHaveBeenCalled();
  });
});
