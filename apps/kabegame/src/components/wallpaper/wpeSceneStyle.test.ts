import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WPE_SCENE_DISPLAY,
  WPE_SCENE_STYLE,
  WPE_SCENE_STYLE_REQUEST,
  displayScaleOf,
  isWpeSceneStyleRequest,
  wpeSceneDisplayMessage,
  wpeSceneStyleMessage,
} from "./wpeSceneStyle";

describe("wpeSceneStyle", () => {
  it("宿主的字面量与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_STYLE_REQUEST = "${WPE_SCENE_STYLE_REQUEST}"`);
    expect(source).toContain(`SCENE_STYLE_MESSAGE = "${WPE_SCENE_STYLE}"`);
    expect(source).toContain(`SCENE_DISPLAY_MESSAGE = "${WPE_SCENE_DISPLAY}"`);
    // 宿主按字段名 scale 取值
    expect(source).toContain("data.scale");
  });

  it("识别样式请求", () => {
    expect(isWpeSceneStyleRequest({ type: WPE_SCENE_STYLE_REQUEST })).toBe(true);
    expect(isWpeSceneStyleRequest({ type: "other" })).toBe(false);
    expect(isWpeSceneStyleRequest(null)).toBe(false);
  });

  it("样式消息带样式", () => {
    expect(wpeSceneStyleMessage("center")).toEqual({ type: WPE_SCENE_STYLE, style: "center" });
  });

  it("显示缩放消息带缩放", () => {
    expect(wpeSceneDisplayMessage(0.25)).toEqual({ type: WPE_SCENE_DISPLAY, scale: 0.25 });
  });
});

describe("displayScaleOf", () => {
  const element = (offsetWidth: number, offsetHeight: number, width: number, height: number) =>
    ({ offsetWidth, offsetHeight, getBoundingClientRect: () => ({ width, height }) }) as unknown as HTMLElement;

  it("显示矩形 ÷ 布局尺寸", () => {
    expect(displayScaleOf(element(5760, 1080, 1034, 193.875))).toBeCloseTo(1034 / 5760, 9);
    expect(displayScaleOf(element(1920, 1080, 1920, 1080))).toBe(1);
    expect(displayScaleOf(element(1000, 500, 2000, 1000))).toBe(2);
  });

  it("不等比时取大的一边", () => {
    expect(displayScaleOf(element(1000, 1000, 500, 250))).toBe(0.5);
  });

  it("没有布局或量成 0 时为 null", () => {
    expect(displayScaleOf(element(0, 0, 0, 0))).toBeNull();
    expect(displayScaleOf(element(1000, 0, 100, 0))).toBeNull();
    expect(displayScaleOf(element(1000, 500, 0, 0))).toBeNull();
  });
});
