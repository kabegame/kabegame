// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_RETURN_DELAY_MS,
  keepFocusOutOfFrames,
  startWindowPointerFeed,
  type WindowPointer,
} from "./framePointer";

describe("startWindowPointerFeed", () => {
  let frames: FrameRequestCallback[] = [];
  let sent: WindowPointer[] = [];
  let stop: () => void = () => {};

  function start() {
    frames = [];
    sent = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames[id - 1] = () => {};
    });
    stop = startWindowPointerFeed((pointer) => sent.push(pointer));
    // 启动时报的视口（见下面的用例），其余用例从空开始
    sent = [];
  }

  function runFrames() {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  }

  function pointer(type: string, init: MouseEventInit) {
    window.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  }

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
  });

  it("光标不在窗口里时，启动与窗口变大小时以离开报上视口；光标在窗口里时不报", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    sent = [];
    stop = startWindowPointerFeed((pointer) => sent.push(pointer));
    expect(sent).toEqual([
      { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, leftDown: false, present: false },
    ]);
    window.dispatchEvent(new Event("resize"));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ width: window.innerWidth, height: window.innerHeight, present: false });
    pointer("pointerdown", { clientX: 5, clientY: 6, button: 0, buttons: 1 });
    window.dispatchEvent(new Event("resize"));
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ x: 5, present: true });
  });

  it("一帧里的移动合并成最后一个，按下 / 抬起当场发并先补上没发的移动", () => {
    start();
    pointer("pointermove", { clientX: 10, clientY: 20 });
    pointer("pointermove", { clientX: 30, clientY: 40 });
    expect(sent).toEqual([]);
    runFrames();
    expect(sent.map((p) => [p.x, p.y])).toEqual([[30, 40]]);
    pointer("pointermove", { clientX: 31, clientY: 40 });
    pointer("pointerdown", { clientX: 31, clientY: 40, button: 0, buttons: 1 });
    pointer("pointerup", { clientX: 32, clientY: 40, button: 0, buttons: 0 });
    expect(sent.map((p) => [p.x, p.leftDown])).toEqual([
      [30, false],
      [31, false],
      [31, true],
      [32, false],
    ]);
    // 补发过的移动不会在下一帧再发一次
    runFrames();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatchObject({ width: window.innerWidth, height: window.innerHeight, present: true });
  });

  it("右键不算一次按下；离开窗口发一次离开，回来照常移动", () => {
    start();
    pointer("pointermove", { clientX: 5, clientY: 5 });
    runFrames();
    pointer("pointerdown", { clientX: 5, clientY: 5, button: 2, buttons: 2 });
    expect(sent).toHaveLength(1);
    pointer("mouseout", { clientX: -1, clientY: 5, relatedTarget: null });
    pointer("mouseout", { clientX: -1, clientY: 5, relatedTarget: null });
    expect(sent.map((p) => p.present)).toEqual([true, false]);
    // 在页面里从一个元素移到另一个（有 relatedTarget）不算离开
    pointer("mouseout", { clientX: 6, clientY: 5, relatedTarget: document.body });
    expect(sent).toHaveLength(2);
    pointer("pointermove", { clientX: 7, clientY: 5 });
    runFrames();
    expect(sent.at(-1)).toMatchObject({ x: 7, present: true });
  });

  it("停止后不再发", () => {
    start();
    pointer("pointermove", { clientX: 1, clientY: 1 });
    stop();
    runFrames();
    pointer("pointerdown", { clientX: 1, clientY: 1, button: 0, buttons: 1 });
    expect(sent).toEqual([]);
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
