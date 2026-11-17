import { describe, expect, it } from "vitest";
import {
  WPE_FPS_DEFAULT,
  WPE_FPS_MIN,
  WPE_SETTING_DEFAULTS,
  clampWpeFps,
  wpeChoiceDisplay,
  wpeChoiceValues,
  wpeFpsDisplay,
  wpeFpsValueOf,
  wpePreviewFieldsFor,
  wpePreviewSettingValues,
  wpeSceneSettingsOf,
  wpeSettingFieldsFor,
} from "./wpeSettings";

describe("wpeSettingFieldsFor", () => {
  it("按壁纸类型选字段，媒体集成只在 Windows，帧率给网页与场景", () => {
    expect(wpeSettingFieldsFor("x-wpe/video", true)).toEqual(["paused", "volume", "playbackRate"]);
    expect(wpeSettingFieldsFor("x-wpe/web", true)).toEqual(["paused", "volume", "mediaIntegration", "fps"]);
    expect(wpeSettingFieldsFor("x-wpe/web", false)).toEqual(["paused", "volume", "fps"]);
    expect(wpeSettingFieldsFor("x-wpe/scene", true)).toEqual([
      "paused",
      "volume",
      "mediaIntegration",
      "fps",
      "postprocess",
      "reflection",
      "shadows",
      "volumetrics",
      "forceRender",
    ]);
    // 强制渲染只有场景
    expect(wpeSettingFieldsFor("x-wpe/web", true)).not.toContain("forceRender");
    expect(wpeSettingFieldsFor("image/png", true)).toEqual([]);
  });

  it("不给类型时是全部字段（设置页）", () => {
    expect(wpeSettingFieldsFor(null, true)).toHaveLength(10);
    expect(wpeSettingFieldsFor(null, true)).toContain("forceRender");
    expect(wpeSettingFieldsFor(null, true)).toContain("fps");
    expect(wpeSettingFieldsFor(null, false)).not.toContain("mediaIntegration");
  });

  it("预览：视频壁纸只有倍速（没有帧率），网页 / 场景同设置页", () => {
    expect(wpePreviewFieldsFor("x-wpe/video", true)).toEqual(["playbackRate"]);
    expect(wpePreviewFieldsFor("x-wpe/web", false)).toEqual(["paused", "volume", "fps"]);
    expect(wpePreviewFieldsFor("x-wpe/scene", false)).toContain("fps");
    expect(wpePreviewFieldsFor(null, true)).toEqual([]);
  });
});

describe("帧率", () => {
  it("存着的值：有限数值或 follow，其余取默认 30", () => {
    expect(WPE_SETTING_DEFAULTS.fps).toBe(WPE_FPS_DEFAULT);
    expect(WPE_FPS_DEFAULT).toBe(30);
    expect(WPE_FPS_MIN).toBe(10);
    expect(wpeFpsValueOf(144)).toBe(144);
    expect(wpeFpsValueOf("follow")).toBe("follow");
    expect(wpeFpsValueOf(undefined)).toBe(30);
    expect(wpeFpsValueOf("60")).toBe(30);
    expect(wpeFpsValueOf(Number.NaN)).toBe(30);
  });

  it("取整钳到 [10, 上限]，上限低于 10 时按 10", () => {
    expect(clampWpeFps(29.6, 60)).toBe(30);
    expect(clampWpeFps(5.4, 60)).toBe(10);
    expect(clampWpeFps(200, 60)).toBe(60);
    expect(clampWpeFps(120, 119.88)).toBe(120);
    expect(clampWpeFps(30, 5)).toBe(10);
  });

  it("显示值：能跟随时保持 follow，不能跟随时按 30；数值钳到显示器上限", () => {
    expect(wpeFpsDisplay("follow", true, 144)).toBe("follow");
    expect(wpeFpsDisplay("follow", false, 144)).toBe(30);
    // 上限低于默认值时，不能跟随的 follow 也钳到上限
    expect(wpeFpsDisplay("follow", false, 24)).toBe(24);
    expect(wpeFpsDisplay(200, false, 60)).toBe(60);
    expect(wpeFpsDisplay(200, true, 240)).toBe(200);
    expect(wpeFpsDisplay(5.4, false, 60)).toBe(10);
    expect(wpeFpsDisplay("bogus", true, 60)).toBe(30);
  });
});

describe("跟随 WPE", () => {
  it("不能跟随时选项里没有 follow，存着的 follow 显示默认值", () => {
    expect(wpeChoiceValues("reflection", true)).toEqual(["follow", "disabled", "enabled"]);
    expect(wpeChoiceValues("reflection", false)).toEqual(["disabled", "enabled"]);
    expect(wpeChoiceDisplay("shadows", "follow", false)).toBe("medium");
    expect(wpeChoiceDisplay("shadows", "follow", true)).toBe("follow");
    // 体积光与阴影同一套档位，默认 medium（P13e）
    expect(wpeChoiceValues("volumetrics", false)).toEqual(["disabled", "low", "medium", "high", "ultra"]);
    expect(wpeChoiceDisplay("volumetrics", "follow", false)).toBe("medium");
    expect(wpeChoiceDisplay("volumetrics", "enabled", true)).toBe("medium");
    expect(wpeChoiceDisplay("postprocess", "bogus", true)).toBe("enabled");
  });

  it("推给场景宿主前把不能跟随的 follow 换成默认值；强制渲染原样带上", () => {
    const values = {
      postprocess: "follow",
      reflection: "disabled",
      shadows: "follow",
      volumetrics: "follow",
      forceRender: true,
    };
    expect(wpeSceneSettingsOf(values, false)).toEqual({
      postprocess: "enabled",
      reflection: "disabled",
      shadows: "medium",
      volumetrics: "medium",
      forceRender: true,
    });
    expect(wpeSceneSettingsOf(values, true)).toEqual(values);
  });
});

describe("wpePreviewSettingValues", () => {
  it("存了的键叠在默认值上，类型不对的忽略", () => {
    expect(wpePreviewSettingValues(null)).toEqual(WPE_SETTING_DEFAULTS);
    expect(
      wpePreviewSettingValues({ volume: 0.3, shadows: "high", volumetrics: "low", mediaIntegration: "no" }),
    ).toEqual({
      ...WPE_SETTING_DEFAULTS,
      volume: 0.3,
      shadows: "high",
      volumetrics: "low",
    });
  });

  it("强制渲染：只认布尔值，默认关", () => {
    expect(WPE_SETTING_DEFAULTS.forceRender).toBe(false);
    expect(wpePreviewSettingValues({ forceRender: true }).forceRender).toBe(true);
    expect(wpePreviewSettingValues({ forceRender: "yes" }).forceRender).toBe(false);
  });

  it("帧率：数值与 follow 都认，其它取默认值", () => {
    expect(wpePreviewSettingValues({ fps: 60 }).fps).toBe(60);
    expect(wpePreviewSettingValues({ fps: "follow" }).fps).toBe("follow");
    expect(wpePreviewSettingValues({ fps: "fast" }).fps).toBe(30);
    expect(wpePreviewSettingValues({ fps: null }).fps).toBe(30);
  });
});
