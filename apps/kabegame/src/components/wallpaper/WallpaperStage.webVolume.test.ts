// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WallpaperStage from "./WallpaperStage.vue";
import type { WallpaperTarget } from "./types";
import { WPE_VOLUME_MESSAGE, WPE_VOLUME_REQUEST } from "./wpeWebVolume";

vi.mock("./WpeSceneView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("canvas") }) };
});

vi.mock("@/utils/fileUrl", () => ({
  initHttpServerBaseUrl: async () => {},
  fileToUrl: (path: string) => `file:///${path}`,
  thumbnailToUrl: (path: string) => `thumb:///${path}`,
  compatibleToUrl: (path: string) => `comp:///${path}`,
}));

const wrappers: ReturnType<typeof mount>[] = [];

const web = (id: string): WallpaperTarget => ({
  id,
  path: `C:/wpe/${id}`,
  type: "x-wpe/web",
  webEntry: `about:blank#${id}`,
});

function mountStage(target: WallpaperTarget, volume = 0.6) {
  const wrapper = mount(WallpaperStage, {
    props: { target, styleMode: "fill", transition: "none", volume, playbackRate: 1 },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frameOf(wrapper: ReturnType<typeof mount>): HTMLIFrameElement {
  const frame = wrapper.element.querySelector("iframe.wallpaper-web-frame") as HTMLIFrameElement | null;
  expect(frame?.contentWindow).toBeTruthy();
  return frame!;
}

/** 截下发给 iframe 的音量消息。 */
function spyPosts(frame: HTMLIFrameElement) {
  return vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
}

function request(source: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source: source as Window, data: { type: WPE_VOLUME_REQUEST } }));
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WallpaperStage web 层的音量消息", () => {
  it("只回答自己 iframe 的请求，回复当前 volume", async () => {
    const wrapper = mountStage(web("a"));
    await settle();
    const frame = frameOf(wrapper);
    const posts = spyPosts(frame);

    request(window);
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "other" } }));
    expect(posts).not.toHaveBeenCalled();

    request(frame.contentWindow);
    expect(posts).toHaveBeenCalledTimes(1);
    expect(posts.mock.calls[0]).toEqual([{ type: WPE_VOLUME_MESSAGE, volume: 0.6, paused: false }, "*"]);
  });

  it("volume / paused 变化时主动推；paused 时为 0", async () => {
    const wrapper = mountStage(web("a"));
    await settle();
    const posts = spyPosts(frameOf(wrapper));

    await wrapper.setProps({ volume: 0.3 });
    await wrapper.setProps({ paused: true });
    await wrapper.setProps({ paused: false });
    expect(posts.mock.calls.map(([message]) => (message as { volume: number }).volume)).toEqual([0.3, 0, 0.3]);
    // 垫片据此调页面的 setPaused
    expect(posts.mock.calls.map(([message]) => (message as { paused: boolean }).paused)).toEqual([false, true, false]);
  });

  it("paused 时 web 层保持可见：暂停由垫片冻结页面，不隐藏 iframe", async () => {
    const wrapper = mountStage(web("a"));
    await settle();
    const layer = wrapper.element.querySelector(".wallpaper-web-layer") as HTMLElement;
    await wrapper.setProps({ paused: true });
    expect(layer.style.visibility).toBe("");
    expect(layer.style.display).toBe("block");
  });

  it("同一窗口里两个 Stage 各答各的 iframe", async () => {
    const background = mountStage(web("a"), 0);
    const preview = mountStage(web("b"), 0.8);
    await settle();
    const backgroundPosts = spyPosts(frameOf(background));
    const previewPosts = spyPosts(frameOf(preview));

    request(frameOf(background).contentWindow);
    request(frameOf(preview).contentWindow);
    expect(backgroundPosts.mock.calls.map(([message]) => message)).toEqual([
      { type: WPE_VOLUME_MESSAGE, volume: 0, paused: false },
    ]);
    expect(previewPosts.mock.calls.map(([message]) => message)).toEqual([
      { type: WPE_VOLUME_MESSAGE, volume: 0.8, paused: false },
    ]);
  });
});
