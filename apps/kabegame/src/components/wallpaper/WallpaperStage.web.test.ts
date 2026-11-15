// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WallpaperStage from "./WallpaperStage.vue";
import type { WallpaperTarget } from "./types";

/**
 * WpeWallpaperContent 的替身：Stage 只看它的 live / fail 与 delegatesPing（iframe、音量协议、右键的用例在
 * `WpeWallpaperContent.test.ts`）。
 */
const stub = vi.hoisted(() => ({
  contents: [] as {
    imageId: string;
    unmounted: boolean;
    props: Record<string, unknown>;
    emit: (event: "live" | "fail", ...args: unknown[]) => void;
  }[],
  pinged: false,
}));

vi.mock("./WpeWallpaperContent.vue", async () => {
  const { defineComponent, h, onBeforeUnmount } = await import("vue");
  return {
    default: defineComponent({
      props: {
        imageId: { type: String, required: true },
        target: Object,
        styleMode: String,
        volume: Number,
        paused: Boolean,
        interactive: Boolean,
        sceneSettings: Object,
      },
      emits: ["live", "fail", "error", "contextmenu"],
      setup(props, { emit, expose }) {
        const record = {
          imageId: props.imageId,
          unmounted: false,
          props: props as Record<string, unknown>,
          emit: emit as (event: "live" | "fail", ...args: unknown[]) => void,
        };
        stub.contents.push(record);
        onBeforeUnmount(() => {
          record.unmounted = true;
        });
        expose({ delegatesPing: () => stub.pinged });
        return () => h("div", { class: "content-stub" });
      },
    }),
  };
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
  webEntry: `file:///${id}`,
});
const image = (id: string): WallpaperTarget => ({ id, path: `C:/media/${id}.jpg`, type: "image/jpg" });

function mountStage(target: WallpaperTarget | null) {
  const wrapper = mount(WallpaperStage, {
    props: { target, styleMode: "fill", transition: "none", volume: 0.6, playbackRate: 1, interactive: true },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function debugOf(wrapper: ReturnType<typeof mount>) {
  return (wrapper.vm as unknown as { debugState: () => { media: string; lastError: string } }).debugState();
}

function webLayer(wrapper: ReturnType<typeof mount>): HTMLElement {
  return wrapper.find(".wallpaper-web-layer").element as HTMLElement;
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  stub.contents.splice(0);
  stub.pinged = false;
});

describe("WallpaperStage web 层", () => {
  it("挂一个 WpeWallpaperContent，音量 / 暂停 / 可交互原样下传；live 后淡入并发 ready，ping 转问它", async () => {
    const wrapper = mountStage(web("a"));
    const delegatesPing = () => (wrapper.vm as unknown as { delegatesPing: () => boolean }).delegatesPing();
    await settle();
    expect(stub.contents).toHaveLength(1);
    expect(stub.contents[0].props).toMatchObject({ imageId: "a", volume: 0.6, paused: false, interactive: true });
    expect(wrapper.emitted("ready")).toBeUndefined();
    expect(webLayer(wrapper).classList.contains("visible")).toBe(false);

    stub.contents[0].emit("live");
    await settle();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(webLayer(wrapper).classList.contains("visible")).toBe(true);
    expect(debugOf(wrapper).media).toBe("web");

    expect(delegatesPing()).toBe(false);
    stub.pinged = true;
    expect(delegatesPing()).toBe(true);

    await wrapper.setProps({ paused: true, volume: 0.2 });
    expect(stub.contents[0].props).toMatchObject({ paused: true, volume: 0.2 });
  });

  it("fail：放弃切入、保留上一张并上报错误，网页随之卸载", async () => {
    const wrapper = mountStage(image("i"));
    await settle();
    await wrapper.setProps({ target: web("a") });
    await settle();
    stub.contents[0].emit("fail", ["web:not-navigated"]);
    await settle();
    expect(stub.contents[0].unmounted).toBe(true);
    expect(webLayer(wrapper).style.display).toBe("none");
    expect(debugOf(wrapper).media).toBe("image");
    expect((wrapper.find("img.base").element as HTMLImageElement).getAttribute("src")).toBe("file:///C:/media/i.jpg");
    expect(wrapper.emitted("error")?.at(-1)?.[0]).toContain("web:not-navigated");

    // 之后的目标照常处理
    await wrapper.setProps({ target: image("j") });
    await settle();
    expect((wrapper.find("img.base").element as HTMLImageElement).getAttribute("src")).toBe("file:///C:/media/j.jpg");
  });

  it("网页切到图片：图片直设到 base，网页卸载", async () => {
    const wrapper = mountStage(web("a"));
    await settle();
    stub.contents[0].emit("live");
    await settle();
    await wrapper.setProps({ target: image("b") });
    await settle();
    expect(stub.contents[0].unmounted).toBe(true);
    expect(webLayer(wrapper).style.display).toBe("none");
    expect(debugOf(wrapper).media).toBe("image");
  });
});
