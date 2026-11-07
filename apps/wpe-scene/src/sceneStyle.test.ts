import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listenSceneStyle,
  postSceneSize,
  schemeColor,
  SCENE_SIZE_MESSAGE,
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

  function install(apply: (style: string) => void) {
    vi.stubGlobal("window", {
      parent,
      addEventListener: (_: string, handler: (event: unknown) => void) => (listener = handler),
    });
    listenSceneStyle(apply);
  }

  it("启动时请求一次样式", () => {
    install(() => {});
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

  it("把场景分辨率发给父窗口", () => {
    install(() => {});
    postSceneSize(1920, 1080);
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: SCENE_SIZE_MESSAGE, width: 1920, height: 1080 }, "*");
  });
});
