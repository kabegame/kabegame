import { describe, expect, it } from "vitest";
import {
  WPE_SETTING_DEFAULTS,
  wpeChoiceDisplay,
  wpeChoiceValues,
  wpePreviewSettingValues,
  wpeSceneSettingsOf,
  wpeSettingFieldsFor,
} from "./wpeSettings";

describe("wpeSettingFieldsFor", () => {
  it("按壁纸类型选字段，媒体集成只在 Windows", () => {
    expect(wpeSettingFieldsFor("x-wpe/video", true)).toEqual(["paused", "volume", "playbackRate"]);
    expect(wpeSettingFieldsFor("x-wpe/web", true)).toEqual(["paused", "volume", "mediaIntegration"]);
    expect(wpeSettingFieldsFor("x-wpe/web", false)).toEqual(["paused", "volume"]);
    expect(wpeSettingFieldsFor("x-wpe/scene", true)).toEqual([
      "paused",
      "volume",
      "mediaIntegration",
      "postprocess",
      "reflection",
      "shadows",
    ]);
    expect(wpeSettingFieldsFor("image/png", true)).toEqual([]);
  });

  it("不给类型时是全部字段（设置页）", () => {
    expect(wpeSettingFieldsFor(null, true)).toHaveLength(7);
    expect(wpeSettingFieldsFor(null, false)).not.toContain("mediaIntegration");
  });
});

describe("跟随 WPE", () => {
  it("不能跟随时选项里没有 follow，存着的 follow 显示默认值", () => {
    expect(wpeChoiceValues("reflection", true)).toEqual(["follow", "disabled", "enabled"]);
    expect(wpeChoiceValues("reflection", false)).toEqual(["disabled", "enabled"]);
    expect(wpeChoiceDisplay("shadows", "follow", false)).toBe("medium");
    expect(wpeChoiceDisplay("shadows", "follow", true)).toBe("follow");
    expect(wpeChoiceDisplay("postprocess", "bogus", true)).toBe("enabled");
  });

  it("推给场景宿主前把不能跟随的 follow 换成默认值", () => {
    const values = { postprocess: "follow", reflection: "disabled", shadows: "follow" };
    expect(wpeSceneSettingsOf(values, false)).toEqual({
      postprocess: "enabled",
      reflection: "disabled",
      shadows: "medium",
    });
    expect(wpeSceneSettingsOf(values, true)).toEqual(values);
  });
});

describe("wpePreviewSettingValues", () => {
  it("存了的键叠在默认值上，类型不对的忽略", () => {
    expect(wpePreviewSettingValues(null)).toEqual(WPE_SETTING_DEFAULTS);
    expect(wpePreviewSettingValues({ volume: 0.3, shadows: "high", mediaIntegration: "no" })).toEqual({
      ...WPE_SETTING_DEFAULTS,
      volume: 0.3,
      shadows: "high",
    });
  });
});
