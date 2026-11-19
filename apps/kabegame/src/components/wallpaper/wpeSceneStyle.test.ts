import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WPE_PLAYBACK_RATE_MAX, WPE_PLAYBACK_RATE_MIN } from "@/utils/wpeSettings";
import {
  SCENE_CANVAS_PIXEL_BUDGET,
  WPE_SCENE_DISPLAY,
  WPE_SCENE_POINTER,
  WPE_SCENE_RATE,
  WPE_SCENE_SETTINGS,
  WPE_SCENE_STYLE,
  WPE_SCENE_STYLE_REQUEST,
  displayScaleOf,
  isWpeSceneStyleRequest,
  sceneDisplayScale,
  wpeSceneRateMessage,
  scenePointerIn,
  wpeSceneDisplayMessage,
  wpeScenePointerMessage,
  wpeSceneSettingsMessage,
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

  it("宿主的开场指针字面量与这里一致（P5a 收尾）", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_POINTER_MESSAGE = "${WPE_SCENE_POINTER}"`);
  });

  it("宿主的播放速度字面量、字段与范围与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_RATE_MESSAGE = "${WPE_SCENE_RATE}"`);
    expect(source).toContain("data.rate");
    expect(source).toContain(`PLAYBACK_RATE_MIN = ${WPE_PLAYBACK_RATE_MIN};`);
    expect(source).toContain(`PLAYBACK_RATE_MAX = ${WPE_PLAYBACK_RATE_MAX};`);
    expect(wpeSceneRateMessage(2)).toEqual({ type: WPE_SCENE_RATE, rate: 2 });
  });

  it("宿主的场景设置字面量与字段名与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_SETTINGS_MESSAGE = "${WPE_SCENE_SETTINGS}"`);
    for (const field of ["postprocess", "reflection", "shadows", "volumetrics", "forceRender"])
      expect(source).toContain(`data.${field}`);
    expect(
      wpeSceneSettingsMessage({
        postprocess: "enabled",
        reflection: "disabled",
        shadows: "low",
        volumetrics: "high",
        forceRender: true,
      }),
    ).toEqual({
      type: WPE_SCENE_SETTINGS,
      postprocess: "enabled",
      reflection: "disabled",
      shadows: "low",
      volumetrics: "high",
      forceRender: true,
    });
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

  it("开场指针消息带坐标", () => {
    expect(wpeScenePointerMessage(0.25, -0.5)).toEqual({ type: WPE_SCENE_POINTER, x: 0.25, y: -0.5 });
  });
});

describe("scenePointerIn", () => {
  const element = (left: number, top: number, width: number, height: number) =>
    ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as HTMLElement;

  it("按显示矩形换算，不钳制", () => {
    expect(scenePointerIn(element(100, 50, 960, 540), { x: 340, y: 185 })).toEqual([0.25, 0.25]);
    expect(scenePointerIn(element(100, 50, 960, 540), { x: 100, y: 590 })).toEqual([0, 1]);
    // 光标在 iframe 外
    expect(scenePointerIn(element(100, 50, 960, 540), { x: 0, y: 1130 })).toEqual([-100 / 960, 2]);
  });

  it("显示矩形为空时为 null", () => {
    expect(scenePointerIn(element(0, 0, 0, 540), { x: 1, y: 1 })).toBeNull();
    expect(scenePointerIn(element(0, 0, 960, 0), { x: 1, y: 1 })).toBeNull();
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

describe("sceneDisplayScale", () => {
  const budget = SCENE_CANVAS_PIXEL_BUDGET;

  it("预算是 3840×2160 的等量像素", () => {
    expect(budget).toBe(8_294_400);
  });

  it("没超预算时就是实测值，放大到超过 1 也不封顶", () => {
    expect(sceneDisplayScale(0.4, { layout: [2560, 1440], dpr: 1, budget })).toBe(0.4);
    // 2560×1440 × 1.5² = 8.29M 正好等于预算
    expect(sceneDisplayScale(1.5, { layout: [2560, 1440], dpr: 1, budget })).toBeCloseTo(1.5, 12);
    expect(sceneDisplayScale(3, { layout: [1000, 500], dpr: 1, budget })).toBe(3);
  });

  it("超预算时等比缩到预算", () => {
    const scale = sceneDisplayScale(10, { layout: [1000, 563], dpr: 1.5, budget });
    const pixels = 1000 * 563 * 1.5 * 1.5 * scale * scale;
    expect(scale).toBeLessThan(10);
    expect(pixels).toBeCloseTo(budget, 3);
  });

  it("不设预算（桌面壁纸窗口）时原样返回", () => {
    expect(sceneDisplayScale(10, { layout: [1000, 563], dpr: 1.5, budget: null })).toBe(10);
  });

  it("布局或 DPR 非法时不封顶", () => {
    expect(sceneDisplayScale(10, { layout: [0, 500], dpr: 1, budget })).toBe(10);
    expect(sceneDisplayScale(10, { layout: [1000, 500], dpr: Number.NaN, budget })).toBe(10);
  });
});
