// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import Wallpaper from "./Wallpaper.vue";
import type { WallpaperTarget } from "./types";

/** ImageContent 的替身：记录挂载 / 卸载与 props，测试里按需 emit；displaySource、videoEl、delegatesPing 由测试给。 */
const stub = vi.hoisted(() => ({
  contents: [] as {
    id: string;
    unmounted: boolean;
    props: Record<string, unknown>;
    emit: (event: string, ...args: unknown[]) => void;
    source: { kind: "image" | "video"; url: string; width: number; height: number } | null;
    videoEl: HTMLVideoElement | null;
    pinged: boolean;
  }[],
}));

vi.mock("@/components/image/ImageContent.vue", async () => {
  const { defineComponent, h, onBeforeUnmount } = await import("vue");
  return {
    default: defineComponent({
      props: {
        image: { type: Object, required: true },
        prefer: String,
        fit: String,
        variant: String,
        wpeVideo: Object,
        wallpaperTarget: Object,
        videoPlaying: Boolean,
        playback: Object,
        interactive: Boolean,
      },
      emits: ["ready", "error", "videoPlayFail", "wallpaperFail", "wallpaperContextmenu", "displayChange"],
      setup(props, { emit, expose }) {
        const record = {
          id: (props.image as { id: string }).id,
          unmounted: false,
          props: props as Record<string, unknown>,
          emit: emit as (event: string, ...args: unknown[]) => void,
          source: null as (typeof stub.contents)[number]["source"],
          videoEl: null as HTMLVideoElement | null,
          pinged: false,
        };
        stub.contents.push(record);
        onBeforeUnmount(() => {
          record.unmounted = true;
        });
        expose({
          displaySource: () => record.source,
          delegatesPing: () => record.pinged,
          get videoEl() {
            return record.videoEl;
          },
        });
        return () => h("div", { class: "content-stub" });
      },
    }),
  };
});

const wrappers: ReturnType<typeof mount>[] = [];
const picture = (id: string): WallpaperTarget => ({ id, path: `C:/media/${id}.jpg`, type: "image/jpg" });
const clip = (id: string): WallpaperTarget => ({ id, path: `C:/media/${id}.mp4`, type: "video/mp4" });
const scene = (id: string): WallpaperTarget => ({
  id,
  path: `C:/wpe/${id}`,
  type: "x-wpe/scene",
  sceneAssets: ["C:/wpe/assets"],
  previewPath: `C:/wpe/${id}/preview.jpg`,
});

function mountWallpaper(target: WallpaperTarget | null, props: Record<string, unknown> = {}) {
  const wrapper = mount(Wallpaper, {
    props: { target, styleMode: "fill", transition: "none", volume: 0.5, playbackRate: 1, ...props },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 等 Vue 渲染与两帧 rAF */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const layers = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll(".wallpaper-layer").map((layer) => layer.attributes("data-phase"));
const live = () => stub.contents.filter((content) => !content.unmounted);
const debugOf = (wrapper: ReturnType<typeof mount>) =>
  (wrapper.vm as unknown as { debugState: () => Record<string, unknown> }).debugState();

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  stub.contents.splice(0);
});

describe("Wallpaper 层的进出", () => {
  it("第一张：ready 之前不可见，ready 就直接成为当前层并发 ready", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "fade" });
    await settle();
    expect(layers(wrapper)).toEqual(["loading"]);
    expect(stub.contents[0].props).toMatchObject({ variant: "wallpaper", prefer: "original", fit: "cover" });
    stub.contents[0].emit("ready");
    await settle();
    expect(layers(wrapper)).toEqual(["shown"]);
    expect(wrapper.emitted("ready")).toHaveLength(1);
  });

  it("有过渡：新层 ready 后进入过渡，透明度过渡结束才卸载旧层", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "fade" });
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: picture("b") });
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "loading"]);
    stub.contents[1].emit("ready");
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "entering"]);
    const entering = wrapper.findAll(".wallpaper-layer")[1];
    expect(entering.classes()).toEqual(expect.arrayContaining(["animated", "fade", "is-entering"]));
    const end = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(end, "propertyName", { value: "opacity" });
    entering.element.dispatchEvent(end);
    await settle();
    expect(layers(wrapper)).toEqual(["shown"]);
    expect(stub.contents[0].unmounted).toBe(true);
  });

  it("过渡事件没来：兜底时间（时长 + 600 ms）到也提交", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "fade" });
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: picture("b") });
    await settle();
    // 假计时器（rAF 与兜底定时器都走它）：真实时间在并行跑很多测试文件时不稳
    vi.useFakeTimers();
    try {
      stub.contents[1].emit("ready");
      await vi.advanceTimersByTimeAsync(50); // 两帧 rAF 之后进入过渡、开始兜底计时
      expect(layers(wrapper)).toEqual(["shown", "entering"]);
      // fade 800 ms + 600 ms = 1.4 s
      await vi.advanceTimersByTimeAsync(1_300);
      expect(layers(wrapper)).toEqual(["shown", "entering"]);
      await vi.advanceTimersByTimeAsync(200);
      expect(layers(wrapper)).toEqual(["shown"]);
      expect(live().map((content) => content.id)).toEqual(["b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("滑入：时长 1.5 s；新层从右侧进来时旧层被推出（is-leaving），位移过渡结束就提交", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "slide" });
    expect((wrapper.element as HTMLElement).style.getPropertyValue("--wallpaper-transition-ms")).toBe("1500ms");
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: picture("b") });
    await settle();
    // 新层还在加载：旧层不动
    expect(wrapper.findAll(".wallpaper-layer")[0].classes()).not.toContain("is-leaving");
    stub.contents[1].emit("ready");
    await settle();
    const [old, entering] = wrapper.findAll(".wallpaper-layer");
    expect(old.classes()).toEqual(expect.arrayContaining(["is-shown", "slide", "is-leaving"]));
    expect(entering.classes()).toEqual(expect.arrayContaining(["is-entering", "slide"]));
    expect(entering.classes()).not.toContain("is-leaving");
    // 旧层自己的位移过渡结束不算
    const oldEnd = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(oldEnd, "propertyName", { value: "transform" });
    old.element.dispatchEvent(oldEnd);
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "entering"]);
    const end = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(end, "propertyName", { value: "transform" });
    entering.element.dispatchEvent(end);
    await settle();
    expect(layers(wrapper)).toEqual(["shown"]);
    expect(wrapper.find(".wallpaper-layer").classes()).not.toContain("is-leaving");
    expect(live().map((content) => content.id)).toEqual(["b"]);
  });

  it("淡入、缩放不推旧层", async () => {
    for (const transition of ["fade", "zoom"]) {
      const wrapper = mountWallpaper(picture("a"), { transition });
      await settle();
      stub.contents[stub.contents.length - 1].emit("ready");
      await wrapper.setProps({ target: picture("b") });
      await settle();
      stub.contents[stub.contents.length - 1].emit("ready");
      await settle();
      expect(layers(wrapper)).toEqual(["shown", "entering"]);
      expect(wrapper.findAll(".wallpaper-layer")[0].classes()).not.toContain("is-leaving");
    }
  });

  it("没有过渡：ready 就换上，旧层卸载", async () => {
    const wrapper = mountWallpaper(picture("a"));
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: clip("b") });
    await settle();
    stub.contents[1].emit("ready");
    await settle();
    expect(layers(wrapper)).toEqual(["shown"]);
    expect(live().map((content) => content.id)).toEqual(["b"]);
  });

  it("还在加载的那层被新目标直接换掉；正在过渡的先定下来再进新层", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "fade" });
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: picture("b") });
    await settle();
    await wrapper.setProps({ target: picture("c") });
    await settle();
    expect(stub.contents.find((content) => content.id === "b")!.unmounted).toBe(true);
    expect(layers(wrapper)).toEqual(["shown", "loading"]);
    stub.contents.find((content) => content.id === "c")!.emit("ready");
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "entering"]);
    await wrapper.setProps({ target: picture("d") });
    await settle();
    // c 定下来成为当前层（a 卸载），d 在加载
    expect(layers(wrapper)).toEqual(["shown", "loading"]);
    expect(live().map((content) => content.id)).toEqual(["c", "d"]);
  });

  it("场景 → 场景：过渡期间新旧两个宿主并存", async () => {
    const wrapper = mountWallpaper(scene("s1"), { transition: "fade" });
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: scene("s2") });
    await settle();
    stub.contents[1].emit("ready");
    await settle();
    expect(live().map((content) => content.id)).toEqual(["s1", "s2"]);
  });

  it("新层出错：同预览不丢层，照样过渡到它（丢失图由 ImageContent 画并 ready），记进调试快照", async () => {
    const wrapper = mountWallpaper(picture("a"), { transition: "fade" });
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: picture("b") });
    await settle();
    stub.contents[1].emit("error");
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "loading"]);
    expect(String(debugOf(wrapper).lastError)).toContain("C:/media/b.jpg");
    expect(wrapper.emitted("error")).toHaveLength(1);
    stub.contents[1].emit("ready");
    await settle();
    expect(layers(wrapper)).toEqual(["shown", "entering"]);
  });

  it("同一个目标不重挂；target 置 null 清空", async () => {
    const wrapper = mountWallpaper(picture("a"));
    await settle();
    stub.contents[0].emit("ready");
    await wrapper.setProps({ target: { ...picture("a") } });
    await settle();
    expect(stub.contents).toHaveLength(1);
    await wrapper.setProps({ target: null });
    await settle();
    expect(layers(wrapper)).toEqual([]);
    expect(stub.contents[0].unmounted).toBe(true);
  });
});

describe("Wallpaper 的样式与参数", () => {
  it("样式换成 fit；播放参数、作者属性、目标原样下传；暂停反过来给 videoPlaying", async () => {
    const settings = { postprocess: "ultra", reflection: "enabled", shadows: "low", volumetrics: "high" };
    const target: WallpaperTarget = { ...clip("v"), type: "x-wpe/video", wpeVideo: null, compatiblePath: "C:/x.mp4" };
    const wrapper = mountWallpaper(target, {
      styleMode: "center",
      paused: true,
      sceneSettings: settings,
      interactive: true,
    });
    await settle();
    expect(stub.contents[0].props).toMatchObject({
      fit: "none",
      videoPlaying: false,
      interactive: true,
      playback: { volume: 0.5, playbackRate: 1, sceneSettings: settings, style: "center" },
      wallpaperTarget: target,
    });
    expect(stub.contents[0].props.image).toMatchObject({
      id: "v",
      type: "x-wpe/video",
      localPath: "C:/media/v.mp4",
      compatiblePath: "C:/x.mp4",
    });
    for (const [style, fit] of [
      ["fill", "cover"],
      ["fit", "contain"],
      ["stretch", "fill"],
      ["tile", "contain"],
    ] as const) {
      await wrapper.setProps({ styleMode: style });
      expect(stub.contents[0].props.fit).toBe(fit);
    }
  });

  it("没有类型的旧目标按扩展名定类型；场景的预览图当缩略图", async () => {
    mountWallpaper({ id: "x", path: "C:/media/x.webm" });
    mountWallpaper(scene("s"));
    await settle();
    expect(stub.contents[0].props.image).toMatchObject({ type: "video/mp4" });
    expect(stub.contents[1].props.image).toMatchObject({ thumbnailPath: "C:/wpe/s/preview.jpg" });
  });

  it("平铺：图片 ready 后用当前图源画重复背景，ImageContent 隐藏；换走平铺就撤掉", async () => {
    const wrapper = mountWallpaper(picture("a"), { styleMode: "tile" });
    await settle();
    stub.contents[0].source = { kind: "image", url: "file:///a.jpg", width: 100, height: 50 };
    stub.contents[0].emit("ready");
    await settle();
    const tile = wrapper.find(".wallpaper-tile");
    expect(tile.exists()).toBe(true);
    expect((tile.element as HTMLElement).style.backgroundImage).toContain("file:///a.jpg");
    expect((tile.element as HTMLElement).style.backgroundRepeat).toBe("repeat");
    expect(wrapper.find(".content-stub").classes()).toContain("opacity-0");
    // 原图盖上缩略图：平铺换成原图
    stub.contents[0].source = { kind: "image", url: "file:///a-original.jpg", width: 1000, height: 500 };
    stub.contents[0].emit("displayChange");
    await settle();
    expect((wrapper.find(".wallpaper-tile").element as HTMLElement).style.backgroundImage).toContain("a-original.jpg");
    await wrapper.setProps({ styleMode: "fit" });
    await settle();
    expect(wrapper.find(".wallpaper-tile").exists()).toBe(false);
    expect(stub.contents[0].props.fit).toBe("contain");
  });

  it("平铺：视频 ready 后盖一层画布逐帧重复，ImageContent 照常显示；WPE 的颜色与翻转带到画布上；换走平铺就撤掉", async () => {
    const target: WallpaperTarget = {
      ...clip("v"),
      type: "x-wpe/video",
      wpeVideo: {
        alignment: "cover",
        position: 0,
        offsetX: 0,
        offsetY: 0,
        zoom: 1,
        flipH: true,
        background: null,
        rate: null,
        volume: null,
        color: { brightness: 0.5, contrast: 0, saturation: 0, hue: 0 },
      },
    };
    const wrapper = mountWallpaper(target, { styleMode: "tile" });
    await settle();
    const video = document.createElement("video");
    stub.contents[0].videoEl = video;
    stub.contents[0].source = { kind: "video", url: "file:///v.mp4", width: 960, height: 960 };
    stub.contents[0].emit("ready");
    await settle();
    expect(wrapper.find(".wallpaper-tile").exists()).toBe(false);
    const canvas = wrapper.find("canvas.wallpaper-video-tile");
    expect(canvas.exists()).toBe(true);
    expect((canvas.element as HTMLElement).style.transform).toBe("scaleX(-1)");
    expect((canvas.element as HTMLElement).style.filter).toContain("brightness(1.5)");
    expect(wrapper.find(".content-stub").classes()).not.toContain("opacity-0");
    expect(stub.contents[0].props.fit).toBe("contain");
    await wrapper.setProps({ styleMode: "fill" });
    await settle();
    expect(wrapper.find("canvas.wallpaper-video-tile").exists()).toBe(false);
    expect(stub.contents[0].props.fit).toBe("cover");
  });

  it("ping 转问任一层；调试快照给当前层的类型、路径与显示不了的原因", async () => {
    const wrapper = mountWallpaper(scene("s"));
    const delegatesPing = () => (wrapper.vm as unknown as { delegatesPing: () => boolean }).delegatesPing();
    await settle();
    expect(delegatesPing()).toBe(false);
    stub.contents[0].pinged = true;
    expect(delegatesPing()).toBe(true);
    stub.contents[0].emit("ready");
    stub.contents[0].emit("wallpaperFail", ["object:particle", "effect:x"]);
    await settle();
    expect(debugOf(wrapper)).toMatchObject({
      media: "scene",
      currentPath: "C:/wpe/s",
      phase: "idle",
      sceneFallback: "object:particle; effect:x",
    });
  });

  it("网页 / 场景壁纸里的右键往上抛", async () => {
    const wrapper = mountWallpaper(scene("s"));
    await settle();
    stub.contents[0].emit("wallpaperContextmenu", { x: 1, y: 2 });
    expect(wrapper.emitted("contextmenu")).toEqual([[{ x: 1, y: 2 }]]);
  });
});
