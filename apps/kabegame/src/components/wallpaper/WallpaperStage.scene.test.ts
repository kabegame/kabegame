// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WallpaperStage from "./WallpaperStage.vue";
import { isSceneTarget, isVideoTarget, isWebTarget, isWpeTarget, stageMediaOf } from "./targetKind";
import type { WallpaperTarget } from "./types";

/** WpeSceneView 的替身：记录挂载 / 卸载，测试里按需 emit ready / fallback。 */
const stub = vi.hoisted(() => ({
  scenes: [] as {
    id: string;
    aliveAtMount: number;
    unmounted: boolean;
    props: { styleMode?: string };
    emit: (event: "ready" | "fallback" | "alive", ...args: unknown[]) => void;
  }[],
}));

vi.mock("./WpeSceneView.vue", async () => {
  const { defineComponent, h, onBeforeUnmount } = await import("vue");
  return {
    default: defineComponent({
      props: {
        target: { type: Object, required: true },
        styleMode: String,
        paused: Boolean,
        volume: Number,
        interactive: Boolean,
      },
      emits: ["ready", "fallback", "alive"],
      setup(props, { emit }) {
        const record = {
          id: (props.target as WallpaperTarget).id,
          aliveAtMount: stub.scenes.filter((scene) => !scene.unmounted).length,
          unmounted: false,
          props,
          emit: emit as (event: "ready" | "fallback" | "alive", ...args: unknown[]) => void,
        };
        stub.scenes.push(record);
        onBeforeUnmount(() => {
          record.unmounted = true;
        });
        return () => h("canvas", { class: "scene-stub" });
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

const scene = (id: string, previewPath: string | null = `C:/wpe/${id}/preview.jpg`): WallpaperTarget => ({
  id,
  path: `C:/wpe/${id}`,
  type: "x-wpe/scene",
  sceneAssets: ["C:/wpe/assets"],
  previewPath,
});
const image = (id: string): WallpaperTarget => ({ id, path: `C:/media/${id}.jpg`, type: "image/jpg" });

function mountStage(target: WallpaperTarget | null) {
  const wrapper = mount(WallpaperStage, {
    props: { target, styleMode: "fill", transition: "none", volume: 1, playbackRate: 1 },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 等 Stage 的异步流程（两帧 rAF、Vue 渲染）走完。 */
async function settle() {
  for (let i = 0; i < 6; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function debugOf(wrapper: ReturnType<typeof mount>) {
  return (wrapper.vm as unknown as { debugState: () => { media: string; sceneFallback: string } }).debugState();
}

function sceneLayer(wrapper: ReturnType<typeof mount>): HTMLElement {
  return wrapper.find(".wallpaper-scene-layer").element as HTMLElement;
}

function previewImg(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('img[alt="wallpaper-scene-preview"]');
}

function loadPreview(wrapper: ReturnType<typeof mount>) {
  const img = previewImg(wrapper);
  expect(img.exists()).toBe(true);
  img.element.dispatchEvent(new Event("load"));
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  stub.scenes.splice(0);
});

describe("targetKind", () => {
  it("按类型分层", () => {
    expect(stageMediaOf(scene("s"))).toBe("scene");
    expect(stageMediaOf({ id: "w", path: "C:/w", type: "x-wpe/web" })).toBe("web");
    expect(stageMediaOf({ id: "v", path: "C:/v", type: "x-wpe/video" })).toBe("video");
    expect(stageMediaOf({ id: "m", path: "C:/m.mp4", type: "video/mp4" })).toBe("video");
    expect(stageMediaOf(image("i"))).toBe("image");
    // 类型缺失时回退扩展名
    expect(stageMediaOf({ id: "x", path: "C:/x.webm" })).toBe("video");
    expect(stageMediaOf({ id: "y", path: "C:/y.png" })).toBe("image");
  });

  it("大小写与首尾空白不影响判定", () => {
    const target = { id: "s", path: "C:/s", type: "  X-WPE/Scene " };
    expect(isSceneTarget(target)).toBe(true);
    expect(isWpeTarget(target)).toBe(true);
    expect(isWebTarget(target)).toBe(false);
    expect(isVideoTarget(target)).toBe(false);
  });
});

describe("WallpaperStage scene 层：loading → ready / fallback", () => {
  it("场景垫片请求音量后才委托 ping，切走时收回", async () => {
    const wrapper = mountStage(scene("a"));
    const delegatesPing = () => (wrapper.vm as unknown as { delegatesPing: () => boolean }).delegatesPing();
    await settle();
    expect(delegatesPing()).toBe(false);
    stub.scenes[0].emit("alive");
    await settle();
    expect(delegatesPing()).toBe(true);
    // 场景出结果之前 Stage 还在等它，切换会排队；先出首帧，切到图片时才真正卸载场景
    stub.scenes[0].emit("ready");
    await settle();
    await wrapper.setProps({ target: image("b") });
    await settle();
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(delegatesPing()).toBe(false);
  });

  it("结果出来前不显示预览图、不发 ready、不淡入", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    expect(stub.scenes.map((s) => s.id)).toEqual(["a"]);
    expect(previewImg(wrapper).exists()).toBe(false);
    expect(wrapper.emitted("ready")).toBeUndefined();
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(false);
    expect(debugOf(wrapper).media).not.toBe("scene");
  });

  it("能渲染：首帧出来直接淡入实时画面并发 ready，中间不出现预览图", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("ready");
    await settle();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(debugOf(wrapper).media).toBe("scene");
    expect(sceneLayer(wrapper).style.display).toBe("block");
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(true);
    expect(wrapper.find(".wallpaper-scene-live").classes()).toContain("live");
    expect(previewImg(wrapper).exists()).toBe(false);
    expect(wrapper.emitted("sceneLive")).toEqual([[true]]);
  });

  it("不能渲染：这时才挂预览图，加载完才发 ready；fallback 不是错误，原因记进调试快照", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("fallback", ["object:particle", "effect:scroll"]);
    await settle();
    expect(previewImg(wrapper).attributes("src")).toBe("thumb:///C:/wpe/a/preview.jpg");
    expect(wrapper.emitted("ready")).toBeUndefined();
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(false);

    loadPreview(wrapper);
    await settle();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(wrapper.emitted("sceneLive")).toBeUndefined();
    expect(wrapper.emitted("error")).toBeUndefined();
    expect(debugOf(wrapper).media).toBe("scene");
    expect(debugOf(wrapper).sceneFallback).toBe("object:particle; effect:scroll");
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(true);
    expect(wrapper.find(".wallpaper-scene-live").classes()).not.toContain("live");
    // 退回后 WpeSceneView 仍挂着：属性变化可能让场景重新可渲染
    expect(stub.scenes[0].unmounted).toBe(false);

    // 之后变得可渲染（改属性）：画布盖住预览图，ready 不重复发
    stub.scenes[0].emit("ready");
    await settle();
    expect(wrapper.find(".wallpaper-scene-live").classes()).toContain("live");
    expect(debugOf(wrapper).sceneFallback).toBe("");
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(wrapper.emitted("sceneLive")).toEqual([[true]]);
  });

  it("壁纸样式交给 WpeSceneView，改样式不重建", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    expect(stub.scenes[0].props.styleMode).toBe("fill");
    await wrapper.setProps({ styleMode: "center" });
    await settle();
    expect(stub.scenes).toHaveLength(1);
    expect(stub.scenes[0].props.styleMode).toBe("center");
  });

  it("退回的预览图按壁纸样式显示，tile 时重复", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("fallback", ["object:particle"]);
    await settle();
    const fit = () => (previewImg(wrapper).element as HTMLImageElement).style.objectFit;
    expect(fit()).toBe("cover");
    await wrapper.setProps({ styleMode: "center" });
    expect(fit()).toBe("none");
    await wrapper.setProps({ styleMode: "tile" });
    expect(fit()).toBe("contain");
    const backdrop = wrapper.find(".wallpaper-scene-layer > div").element as HTMLElement;
    expect(backdrop.style.backgroundRepeat).toBe("repeat");
  });

  it("迟迟没有结果：超时按退回显示预览图并发 ready，迟到的首帧照样切成实时画面", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const wrapper = mountStage(scene("a"));
    await settle();
    const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 10_000);
    setTimeoutSpy.mockRestore();
    expect(call).toBeDefined();
    (call![0] as () => void)();
    await settle();
    expect(debugOf(wrapper).sceneFallback).toBe("render:timeout");
    loadPreview(wrapper);
    await settle();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(true);

    stub.scenes[0].emit("ready");
    await settle();
    expect(wrapper.find(".wallpaper-scene-live").classes()).toContain("live");
    expect(wrapper.emitted("ready")).toHaveLength(1);
  });

  it("首帧之后超时回调到点不改变状态", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const wrapper = mountStage(scene("a"));
    await settle();
    const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 10_000);
    setTimeoutSpy.mockRestore();
    stub.scenes[0].emit("ready");
    await settle();
    (call![0] as () => void)();
    await settle();
    expect(debugOf(wrapper).sceneFallback).toBe("");
    expect(previewImg(wrapper).exists()).toBe(false);
  });

  it("没有预览图又不能渲染时上报错误（调用方据此结束加载态）", async () => {
    const wrapper = mountStage(scene("a", null));
    await settle();
    stub.scenes[0].emit("fallback", ["webgpu:unavailable"]);
    await settle();
    expect(previewImg(wrapper).exists()).toBe(false);
    expect(wrapper.emitted("error")?.[0]?.[0]).toContain("场景壁纸无法显示");
  });

  it("切到图片即卸载场景、收起 scene 层", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("ready");
    await settle();
    await wrapper.setProps({ target: image("b") });
    await settle();
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(sceneLayer(wrapper).style.display).toBe("none");
    expect(wrapper.find(".wallpaper-scene-live").exists()).toBe(false);
    expect(debugOf(wrapper).media).toBe("image");
    expect((wrapper.find("img.base").element as HTMLImageElement).getAttribute("src")).toBe("file:///C:/media/b.jpg");
  });

  it("场景换场景：先卸载旧的再挂新的，同一时间只有一个", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("fallback", ["x"]);
    await settle();
    loadPreview(wrapper);
    await settle();
    await wrapper.setProps({ target: scene("b") });
    await settle();
    expect(stub.scenes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(stub.scenes[1].aliveAtMount).toBe(0);
    expect(wrapper.findAll(".scene-stub")).toHaveLength(1);
    // 新场景重新从 loading 开始：旧预览图已撤
    expect(previewImg(wrapper).exists()).toBe(false);
  });

  it("图片切到场景：结果出来前保留图片，场景盖上来后才释放", async () => {
    const wrapper = mountStage(image("i"));
    await settle();
    const base = () => wrapper.find("img.base").element as HTMLImageElement;
    expect(base().getAttribute("src")).toBe("file:///C:/media/i.jpg");
    await wrapper.setProps({ target: scene("a") });
    await settle();
    expect(base().getAttribute("src")).toBe("file:///C:/media/i.jpg");
    stub.scenes[0].emit("ready");
    await settle();
    expect(debugOf(wrapper).media).toBe("scene");
    expect(base().hasAttribute("src")).toBe(false);
  });

  it("有过渡设置时：淡入场景后释放图片，切回图片时场景淡出再卸载", async () => {
    const wrapper = mountStage(image("i"));
    await wrapper.setProps({ transition: "fade" });
    await settle();
    await wrapper.setProps({ target: scene("a") });
    await settle();
    stub.scenes[0].emit("ready");
    await settle();
    expect(sceneLayer(wrapper).className).toBe("wallpaper-scene-layer animated fade visible");
    // 淡入兜底 1400ms 后提交：媒体层才释放
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await settle();
    expect(debugOf(wrapper).media).toBe("scene");
    expect((wrapper.find("img.base").element as HTMLImageElement).hasAttribute("src")).toBe(false);

    await wrapper.setProps({ target: image("j") });
    await settle();
    // 新图片已直设到 base，场景层在淡出
    expect((wrapper.find("img.base").element as HTMLImageElement).getAttribute("src")).toBe("file:///C:/media/j.jpg");
    expect(sceneLayer(wrapper).classList.contains("visible")).toBe(false);
    expect(stub.scenes[0].unmounted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await settle();
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(sceneLayer(wrapper).style.display).toBe("none");
  });

  it("target 置 null 时卸载场景", async () => {
    const wrapper = mountStage(scene("a"));
    await settle();
    stub.scenes[0].emit("ready");
    await settle();
    await wrapper.setProps({ target: null });
    await settle();
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(sceneLayer(wrapper).style.display).toBe("none");
  });
});
