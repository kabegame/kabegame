import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listenSceneParent,
  schemeColor,
  scenePointerFeed,
  SCENE_DISPLAY_MESSAGE,
  SCENE_POINTER_MESSAGE,
  SCENE_STYLE_MESSAGE,
  SCENE_STYLE_REQUEST,
} from "./sceneStyle";

const color = (value: unknown) => schemeColor(new Map([["schemecolor", { type: "color", value }]]));

describe("schemeColor", () => {
  it("把 r g b 原样当 0…1 的颜色", () => {
    expect(color("1 0.8 0.25")).toEqual([1, 0.8, 0.25]);
    expect(color("  0 0   0 ")).toEqual([0, 0, 0]);
  });
  it("没有或解析不了时用 WPE 的灰色", () => {
    expect(schemeColor(new Map())).toEqual([0.5, 0.5, 0.5]);
    expect(color("")).toEqual([0.5, 0.5, 0.5]);
    expect(color("1 0")).toEqual([0.5, 0.5, 0.5]);
    expect(color("red green blue")).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("父页面通路", () => {
  const parent = { postMessage: vi.fn() };
  let listener: (event: unknown) => void = () => {};

  afterEach(() => {
    vi.unstubAllGlobals();
    parent.postMessage.mockReset();
  });

  function install(
    style: (style: string) => void = () => {},
    displayScale: (scale: number) => void = () => {},
    pointer: (x: number, y: number) => void = () => {},
  ) {
    vi.stubGlobal("window", {
      parent,
      addEventListener: (_: string, handler: (event: unknown) => void) => (listener = handler),
    });
    listenSceneParent({ style, displayScale, pointer });
  }

  it("启动时请求一次（样式与显示缩放共用这一条请求）", () => {
    install();
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: SCENE_STYLE_REQUEST }, "*");
  });

  it("只认父窗口发来的可信消息与已知样式", () => {
    const apply = vi.fn();
    install(apply);
    const message = (style: unknown) => ({ type: SCENE_STYLE_MESSAGE, style });
    listener({ isTrusted: true, source: parent, data: message("fit") });
    expect(apply).toHaveBeenCalledExactlyOnceWith("fit");
    listener({ isTrusted: false, source: parent, data: message("center") });
    listener({ isTrusted: true, source: {}, data: message("center") });
    listener({ isTrusted: true, source: parent, data: message("free") });
    listener({ isTrusted: true, source: parent, data: { type: "other", style: "center" } });
    listener({ isTrusted: true, source: parent, data: null });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("显示缩放：只认父窗口发来的可信消息，只收有限正数", () => {
    const style = vi.fn();
    const displayScale = vi.fn();
    install(style, displayScale);
    const message = (scale: unknown) => ({ type: SCENE_DISPLAY_MESSAGE, scale });
    listener({ isTrusted: true, source: parent, data: message(0.18) });
    expect(displayScale).toHaveBeenCalledExactlyOnceWith(0.18);
    listener({ isTrusted: false, source: parent, data: message(0.5) });
    listener({ isTrusted: true, source: {}, data: message(0.5) });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined])
      listener({ isTrusted: true, source: parent, data: message(bad) });
    // 样式消息里带 scale 不算显示缩放
    listener({ isTrusted: true, source: parent, data: { type: SCENE_STYLE_MESSAGE, style: "fit", scale: 0.5 } });
    expect(displayScale).toHaveBeenCalledOnce();
    expect(style).toHaveBeenCalledExactlyOnceWith("fit");
  });

  it("开场指针：只认父窗口发来的可信消息，两个都是有限数才收，不钳制", () => {
    const style = vi.fn();
    const displayScale = vi.fn();
    const pointer = vi.fn();
    install(style, displayScale, pointer);
    const message = (x: unknown, y: unknown) => ({ type: SCENE_POINTER_MESSAGE, x, y });
    listener({ isTrusted: true, source: parent, data: message(0.25, 0.75) });
    expect(pointer).toHaveBeenCalledExactlyOnceWith(0.25, 0.75);
    // 光标在 iframe 外：越界照收
    listener({ isTrusted: true, source: parent, data: message(-0.5, 1.5) });
    expect(pointer).toHaveBeenLastCalledWith(-0.5, 1.5);
    listener({ isTrusted: false, source: parent, data: message(0.1, 0.1) });
    listener({ isTrusted: true, source: {}, data: message(0.1, 0.1) });
    for (const [x, y] of [
      [Number.NaN, 0.5],
      [0.5, Number.POSITIVE_INFINITY],
      ["0.5", 0.5],
      [0.5, null],
      [undefined, undefined],
    ])
      listener({ isTrusted: true, source: parent, data: message(x, y) });
    // 别的消息带 x / y 不算指针
    listener({ isTrusted: true, source: parent, data: { type: SCENE_DISPLAY_MESSAGE, scale: 1, x: 0.1, y: 0.1 } });
    expect(pointer).toHaveBeenCalledTimes(2);
    expect(style).not.toHaveBeenCalled();
    expect(displayScale).toHaveBeenCalledExactlyOnceWith(1);
    // 指针消息不触发请求（只有启动时那一次）
    expect(parent.postMessage).toHaveBeenCalledOnce();
  });
});

describe("scenePointerFeed", () => {
  it("没收到真实 pointermove 时初值生效，可多次（load、ready 各一次）", () => {
    const setPointer = vi.fn();
    const feed = scenePointerFeed(setPointer);
    feed.initial(0.2, 0.3);
    feed.initial(0.4, 0.5);
    expect(setPointer.mock.calls).toEqual([
      [0.2, 0.3],
      [0.4, 0.5],
    ]);
  });

  it("收到过真实 pointermove 后，之后的初值一律忽略", () => {
    const setPointer = vi.fn();
    const feed = scenePointerFeed(setPointer);
    feed.initial(0.2, 0.3);
    feed.move(0.6, 0.7);
    feed.initial(0.4, 0.5);
    feed.move(0.8, 0.9);
    expect(setPointer.mock.calls).toEqual([
      [0.2, 0.3],
      [0.6, 0.7],
      [0.8, 0.9],
    ]);
  });
});
