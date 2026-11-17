// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallpaperPointerOverlay from "./WallpaperPointerOverlay.vue";

const env = vi.hoisted(() => ({ native: true }));
vi.mock("./framePointer", () => ({
  get NATIVE_FRAME_POINTER() {
    return env.native;
  },
  WALLPAPER_CLICKABLE_SELECTOR: "[data-wallpaper-clickable]",
}));
const originalElementsFromPoint = document.elementsFromPoint;

const wrappers: ReturnType<typeof mount>[] = [];
let startPan: ReturnType<typeof vi.fn<(event: PointerEvent) => boolean>>;
let endPan: ReturnType<typeof vi.fn<(event: PointerEvent) => void>>;

function mountOverlay(pannable = true) {
  const wrapper = mount(WallpaperPointerOverlay, {
    attachTo: document.body,
    props: { pannable, startPan, endPan },
  });
  wrappers.push(wrapper);
  const element = wrapper.element as HTMLElement;
  const capture = vi.fn();
  element.setPointerCapture = capture;
  return { wrapper, element, capture };
}

function pointer(type: string, init: { button?: number; ctrlKey?: boolean } = {}) {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: -1, ...init });
}

beforeEach(() => {
  env.native = true;
  startPan = vi.fn(() => true);
  endPan = vi.fn();
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.elementsFromPoint = originalElementsFromPoint;
});

describe("WallpaperPointerOverlay 平移", () => {
  it("左键没按 Ctrl：按下就开始平移并捕获指针", () => {
    const { element, capture } = mountOverlay();
    const down = pointer("pointerdown", { button: 0 });
    element.dispatchEvent(down);
    expect(startPan).toHaveBeenCalledExactlyOnceWith(down);
    expect(capture).toHaveBeenCalledWith(1);
  });

  it("Ctrl+左键不平移；拖动中松开 Ctrl 就从那一点接着平移，再按下 Ctrl 停下", () => {
    const { element } = mountOverlay();
    element.dispatchEvent(pointer("pointerdown", { button: 0, ctrlKey: true }));
    element.dispatchEvent(pointer("pointermove", { ctrlKey: true }));
    expect(startPan).not.toHaveBeenCalled();
    const released = pointer("pointermove");
    element.dispatchEvent(released);
    expect(startPan).toHaveBeenCalledExactlyOnceWith(released);
    // 已在平移：之后不按 Ctrl 的移动交给 Panzoom，不再开始
    element.dispatchEvent(pointer("pointermove"));
    expect(startPan).toHaveBeenCalledOnce();
    const pressed = pointer("pointermove", { ctrlKey: true });
    element.dispatchEvent(pressed);
    expect(endPan).toHaveBeenCalledExactlyOnceWith(pressed);
    element.dispatchEvent(pointer("pointermove", { ctrlKey: true }));
    expect(endPan).toHaveBeenCalledOnce();
    element.dispatchEvent(pointer("pointermove"));
    expect(startPan).toHaveBeenCalledTimes(2);
  });

  it("中键按着 Ctrl 也平移，并阻止默认（中键自动滚动）", () => {
    const { element } = mountOverlay();
    const down = pointer("pointerdown", { button: 1, ctrlKey: true });
    element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(startPan).toHaveBeenCalledExactlyOnceWith(down);
    // 中键的移动不再判断 Ctrl
    element.dispatchEvent(pointer("pointermove", { ctrlKey: true }));
    expect(endPan).not.toHaveBeenCalled();
  });

  it("右键不处理、不阻止默认（冒泡到预览容器弹菜单）", () => {
    const { element, capture } = mountOverlay();
    const down = pointer("pointerdown", { button: 2 });
    element.dispatchEvent(down);
    element.dispatchEvent(pointer("pointermove"));
    expect(down.defaultPrevented).toBe(false);
    expect(startPan).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("拖不动（没放大）时都不开始，中键仍阻止默认", () => {
    const { element, capture } = mountOverlay(false);
    element.dispatchEvent(pointer("pointerdown", { button: 0 }));
    element.dispatchEvent(pointer("pointermove"));
    const middle = pointer("pointerdown", { button: 1 });
    element.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(startPan).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("松开、取消、丢失捕获之后，移动不再开始平移", () => {
    for (const end of ["pointerup", "pointercancel", "lostpointercapture"]) {
      startPan.mockClear();
      const { element } = mountOverlay();
      element.dispatchEvent(pointer("pointerdown", { button: 0, ctrlKey: true }));
      element.dispatchEvent(pointer(end, { button: 0 }));
      element.dispatchEvent(pointer("pointermove"));
      expect(startPan, end).not.toHaveBeenCalled();
    }
  });

  it("光标：拖得动时 grab，平移中 grabbing", async () => {
    const { wrapper, element } = mountOverlay(false);
    expect(element.className).not.toContain("cursor-grab");
    await wrapper.setProps({ pannable: true });
    expect(element.classList.contains("cursor-grab")).toBe(true);
    element.dispatchEvent(pointer("pointerdown", { button: 0 }));
    await wrapper.vm.$nextTick();
    expect(element.classList.contains("cursor-grabbing")).toBe(true);
    element.dispatchEvent(pointer("pointerup", { button: 0 }));
    await wrapper.vm.$nextTick();
    expect(element.classList.contains("cursor-grabbing")).toBe(false);
  });
});

describe("WallpaperPointerOverlay 转交点击", () => {
  it("左键落在带 data-wallpaper-clickable 的元素上：不平移，松开时还在它上面才 click 它；悬停是手形", async () => {
    const { element, capture } = mountOverlay();
    const link = document.createElement("button");
    link.setAttribute("data-wallpaper-clickable", "");
    const inner = document.createElement("span");
    link.append(inner);
    document.body.append(link);
    const click = vi.fn();
    link.addEventListener("click", click);
    // 覆盖层在最上面，下面是链接里的文字
    let under: Element[] = [element, inner, link];
    document.elementsFromPoint = vi.fn(() => under);

    element.dispatchEvent(pointer("pointermove"));
    await nextTick();
    expect(element.classList).toContain("cursor-pointer");
    element.dispatchEvent(pointer("pointerdown", { button: 0 }));
    expect(startPan).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    element.dispatchEvent(pointer("pointerup", { button: 0 }));
    expect(click).toHaveBeenCalledTimes(1);

    // 按下后移开再松开：不点
    element.dispatchEvent(pointer("pointerdown", { button: 0 }));
    under = [element];
    element.dispatchEvent(pointer("pointerup", { button: 0 }));
    expect(click).toHaveBeenCalledTimes(1);
    element.dispatchEvent(pointer("pointermove"));
    await nextTick();
    expect(element.classList).not.toContain("cursor-pointer");

    // 中键、右键不转交；不在链接上：左键照常平移
    under = [element, inner, link];
    element.dispatchEvent(pointer("pointerdown", { button: 2 }));
    element.dispatchEvent(pointer("pointerup", { button: 2 }));
    expect(click).toHaveBeenCalledTimes(1);
    under = [element];
    element.dispatchEvent(pointer("pointerdown", { button: 0 }));
    expect(startPan).toHaveBeenCalledTimes(1);
    link.remove();
  });
});

describe("WallpaperPointerOverlay Linux", () => {
  it("iframe 直接收真实鼠标时不盖覆盖层", () => {
    env.native = false;
    const wrapper = mount(WallpaperPointerOverlay, {
      attachTo: document.body,
      props: { pannable: true, startPan, endPan },
    });
    wrappers.push(wrapper);
    expect(document.querySelector("[data-wallpaper-pointer-overlay]")).toBeNull();
  });
});
