// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, inject, type Ref } from "vue";
import WallpaperPreviewCanvas, { intersectRect, type CoverRegion } from "./WallpaperPreviewCanvas.vue";
import { NATIVE_FRAME_POINTER } from "./framePointer";
import { WALLPAPER_PREVIEW_ZOOM } from "./wpeSceneStyle";

vi.mock("@tauri-apps/api/window", () => ({ primaryMonitor: async () => null }));

const ATTR = "data-kb-cover-capture";
const root = document.documentElement;
const wrappers: ReturnType<typeof mount>[] = [];

/** 画布里进行中的动画 */
let animations: Animation[] = [];
class CSSTransitionStub {
  constructor(readonly finished: Promise<unknown>) {}
}

function mountCanvas(
  rect: { x: number; y: number; width: number; height: number },
  props: { contentSize?: { width: number; height: number } | null } = {},
) {
  const wrapper = mount(WallpaperPreviewCanvas, { attachTo: document.body, props });
  wrappers.push(wrapper);
  const canvas = wrapper.element.firstElementChild as HTMLElement;
  canvas.getBoundingClientRect = () => rect as DOMRect;
  canvas.getAnimations = () => animations;
  return wrapper.vm as unknown as {
    withCaptureRegion<T>(run: (region: CoverRegion) => Promise<T>, viewport?: Element | null): Promise<T>;
  };
}

/** 可见区域（预览里 Panzoom 的父元素）：只量矩形 */
function viewportAt(rect: { x: number; y: number; width: number; height: number }): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => rect as DOMRect;
  return element;
}

const VISIBLE = { x: 100, y: 75, width: 500, height: 300 };

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("CSSTransition", CSSTransitionStub);
  animations = [];
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  root.removeAttribute(ATTR);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WallpaperPreviewCanvas 尺寸", () => {
  const canvasOf = (index = 0) => wrappers[index].element.firstElementChild as HTMLElement;

  it("有内容尺寸时画布就是这个尺寸，没有时按桌面", async () => {
    mountCanvas(VISIBLE, { contentSize: { width: 2560, height: 1600 } });
    expect(canvasOf().style.width).toBe("2560px");
    expect(canvasOf().style.height).toBe("1600px");
    mountCanvas(VISIBLE, { contentSize: null });
    expect(canvasOf(1).style.width).toBe(`${Math.round(window.screen.width || 1920)}px`);
  });

  it("内容尺寸到达后换成内容尺寸", async () => {
    mountCanvas(VISIBLE);
    await wrappers[0].setProps({ contentSize: { width: 800, height: 600 } });
    expect(canvasOf().style.width).toBe("800px");
    expect(canvasOf().style.height).toBe("600px");
  });
});

describe("WallpaperPreviewCanvas.withCaptureRegion", () => {
  it("给出实际画布占窗口内容区的比例", async () => {
    const canvas = mountCanvas(VISIBLE);
    const region = await canvas.withCaptureRegion(async (value) => value);
    expect(region).toEqual({ x: 0.1, y: 0.125, width: 0.5, height: 0.5 });
  });

  it("给了可见区域时只截交集：放大后画布超出可见区域，不截进侧栏", async () => {
    // 画布放大到 (−200, −100) 起 1400×800，可见区域是左侧 800×600（右边 200 是侧栏）
    const canvas = mountCanvas({ x: -200, y: -100, width: 1400, height: 800 });
    const region = await canvas.withCaptureRegion(
      async (value) => value,
      viewportAt({ x: 0, y: 0, width: 800, height: 600 }),
    );
    expect(region).toEqual({ x: 0, y: 0, width: 0.8, height: 1 });
  });

  it("没放大时画布在可见区域里，交集就是画布", async () => {
    const canvas = mountCanvas(VISIBLE);
    const region = await canvas.withCaptureRegion(
      async (value) => value,
      viewportAt({ x: 0, y: 0, width: 800, height: 600 }),
    );
    expect(region).toEqual({ x: 0.1, y: 0.125, width: 0.5, height: 0.5 });
  });

  it("和可见区域不相交时报错，不调回调", async () => {
    const canvas = mountCanvas(VISIBLE);
    const run = vi.fn(async () => {});
    await expect(canvas.withCaptureRegion(run, viewportAt({ x: 700, y: 0, width: 100, height: 600 }))).rejects.toThrow(
      "not visible",
    );
    expect(run).not.toHaveBeenCalled();
    expect(root.hasAttribute(ATTR)).toBe(false);
  });

  it("回调期间隐藏，结束后恢复，并返回回调的结果", async () => {
    const canvas = mountCanvas(VISIBLE);
    const result = await canvas.withCaptureRegion(async () => {
      expect(root.hasAttribute(ATTR)).toBe(true);
      return "cover.jpg";
    });
    expect(result).toBe("cover.jpg");
    expect(root.hasAttribute(ATTR)).toBe(false);
  });

  it("回调抛错时也恢复", async () => {
    const canvas = mountCanvas(VISIBLE);
    await expect(
      canvas.withCaptureRegion(async () => {
        throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");
    expect(root.hasAttribute(ATTR)).toBe(false);
  });

  it("画布量成 0 时报错，不调回调，并恢复", async () => {
    const canvas = mountCanvas({ x: 0, y: 0, width: 0, height: 0 });
    const run = vi.fn(async () => {});
    await expect(canvas.withCaptureRegion(run)).rejects.toThrow("not visible");
    expect(run).not.toHaveBeenCalled();
    expect(root.hasAttribute(ATTR)).toBe(false);
  });

  it("窗口被完全遮挡时矩形量得出来也不截：截到的是残缺的画面", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const canvas = mountCanvas(VISIBLE);
    const run = vi.fn(async () => {});
    await expect(canvas.withCaptureRegion(run)).rejects.toThrow("not visible");
    expect(run).not.toHaveBeenCalled();
    expect(root.hasAttribute(ATTR)).toBe(false);
  });

  it("等淡入结束才截，被取消的过渡不算失败", async () => {
    let finish = () => {};
    const fade = new Promise<void>((resolve) => (finish = resolve));
    const cancelled = Promise.reject(new Error("cancelled"));
    cancelled.catch(() => {});
    animations = [
      new CSSTransitionStub(fade) as unknown as Animation,
      new CSSTransitionStub(cancelled) as unknown as Animation,
    ];
    const run = vi.fn(async () => "cover.jpg");
    const pending = mountCanvas(VISIBLE).withCaptureRegion(run);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(run).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toBe("cover.jpg");
  });

  it("不等循环动画：它们永远结束不了", async () => {
    animations = [{ finished: new Promise(() => {}) } as unknown as Animation];
    await expect(mountCanvas(VISIBLE).withCaptureRegion(async () => "ok")).resolves.toBe("ok");
  });

  it("rAF 不触发时按超时往下走，不会卡住", async () => {
    const stub = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 0);
    const canvas = mountCanvas(VISIBLE);
    await expect(canvas.withCaptureRegion(async () => "ok")).resolves.toBe("ok");
    stub.mockRestore();
  });
});

describe("WallpaperPreviewCanvas 放大倍数", () => {
  it("把 zoom 提供给画布里的场景，跟着 prop 变；不再自带覆盖层（在 Panzoom 变换层之外）", async () => {
    let injected: Readonly<Ref<number>> | null = null;
    const Probe = defineComponent({
      setup() {
        injected = inject(WALLPAPER_PREVIEW_ZOOM, null);
        return () => h("iframe", { class: "slot-frame" });
      },
    });
    const wrapper = mount(WallpaperPreviewCanvas, {
      attachTo: document.body,
      props: { zoom: 2.5 },
      slots: { default: () => h(Probe) },
    });
    wrappers.push(wrapper);
    expect(injected!.value).toBe(2.5);
    await wrapper.setProps({ zoom: 1 });
    expect(injected!.value).toBe(1);
    expect(wrapper.element.querySelector("[data-wallpaper-pointer-overlay]")).toBeNull();
    expect(wrapper.element.firstElementChild?.querySelector(".slot-frame")).not.toBeNull();
  });

  it("没传 zoom 时按 1", () => {
    let injected: Readonly<Ref<number>> | null = null;
    const Probe = defineComponent({
      setup() {
        injected = inject(WALLPAPER_PREVIEW_ZOOM, null);
        return () => null;
      },
    });
    wrappers.push(mount(WallpaperPreviewCanvas, { attachTo: document.body, slots: { default: () => h(Probe) } }));
    expect(injected!.value).toBe(1);
  });
});

describe("intersectRect", () => {
  it("相交时取重叠部分，不相交时宽高为 0", () => {
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 0,
      width: 5,
      height: 5,
    });
    const apart = intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 });
    expect(apart.width).toBe(0);
  });
});

describe("WallpaperPreviewCanvas 焦点", () => {
  it("画布里的 iframe 拿到焦点时还给父页面（注入时）；卸载后不再管", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(WallpaperPreviewCanvas, {
        attachTo: document.body,
        slots: { default: '<iframe class="slot-frame"></iframe>' },
      });
      const frame = wrapper.element.querySelector(".slot-frame") as HTMLIFrameElement;
      vi.spyOn(document, "activeElement", "get").mockImplementation(() => frame);
      const blur = vi.spyOn(frame, "blur");
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(0);
      expect(blur).toHaveBeenCalledTimes(NATIVE_FRAME_POINTER ? 1 : 0);
      wrapper.unmount();
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(0);
      expect(blur).toHaveBeenCalledTimes(NATIVE_FRAME_POINTER ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  });
});
