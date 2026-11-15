// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_RETURN_DELAY_MS,
  framePointerEvents,
  keepFocusOutOfFrames,
  NATIVE_FRAME_POINTER,
} from "./framePointer";

describe("framePointerEvents", () => {
  it("注入时 iframe 一律不收真实鼠标；退回（Linux）时可交互才收", () => {
    if (NATIVE_FRAME_POINTER) {
      expect(framePointerEvents(true)).toBe("none");
    } else {
      expect(framePointerEvents(true)).toBe("auto");
    }
    expect(framePointerEvents(false)).toBe("none");
  });
});

describe("keepFocusOutOfFrames", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function setup() {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    const other = document.createElement("iframe");
    document.body.append(frame, other);
    let active: Element | null = document.body;
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => active);
    const blur = vi.spyOn(frame, "blur").mockImplementation(() => {
      active = document.body;
    });
    const otherBlur = vi.spyOn(other, "blur");
    const stop = keepFocusOutOfFrames((candidate) => candidate === frame);
    /** 注入的按下把焦点切进 iframe：父窗口失焦。 */
    const focus = (target: Element = frame) => {
      active = target;
      window.dispatchEvent(new Event("blur"));
    };
    const pointer = (type: "pointerdown" | "pointerup" | "pointercancel", button = 0) =>
      window.dispatchEvent(new PointerEvent(type, { button }));
    return { blur, otherBlur, stop, focus, pointer, leaveApp: () => focus(document.body) };
  }

  it("左键按着时不还：iframe 失焦会被页面当成松开，拖动会断", () => {
    const { blur, stop, focus, pointer } = setup();
    pointer("pointerdown");
    focus();
    vi.advanceTimersByTime(1000);
    expect(blur).not.toHaveBeenCalled();
    // 松开后等注入的抬起先到再还
    pointer("pointerup");
    vi.advanceTimersByTime(FOCUS_RETURN_DELAY_MS - 1);
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blur).toHaveBeenCalledOnce();
    stop();
  });

  it("没按着时焦点进了 iframe（Tab 等）就在这一轮事件之后还", () => {
    const { blur, stop, focus } = setup();
    focus();
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(blur).toHaveBeenCalledOnce();
    stop();
  });

  it("中键、右键不算按着；pointercancel 当松开", () => {
    const { blur, stop, focus, pointer } = setup();
    pointer("pointerdown", 2);
    focus();
    vi.advanceTimersByTime(0);
    expect(blur).toHaveBeenCalledOnce();

    pointer("pointerdown");
    focus();
    vi.advanceTimersByTime(1000);
    expect(blur).toHaveBeenCalledOnce();
    pointer("pointercancel");
    vi.advanceTimersByTime(FOCUS_RETURN_DELAY_MS);
    expect(blur).toHaveBeenCalledTimes(2);
    stop();
  });

  it("焦点不在 iframe 里（切到别的应用）、或是别处的 iframe 时不动；解除后不动", () => {
    const { blur, otherBlur, stop, focus, leaveApp, pointer } = setup();
    leaveApp();
    vi.advanceTimersByTime(0);
    focus(document.querySelectorAll("iframe")[1]);
    vi.advanceTimersByTime(0);
    expect(blur).not.toHaveBeenCalled();
    expect(otherBlur).not.toHaveBeenCalled();

    pointer("pointerdown");
    focus();
    pointer("pointerup");
    // 解除时连还没跑的检查一起取消
    stop();
    vi.advanceTimersByTime(FOCUS_RETURN_DELAY_MS);
    expect(blur).not.toHaveBeenCalled();
  });
});
