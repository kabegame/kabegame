import { describe, expect, it } from "vitest";
import type { WpeVideoProps } from "./types";
import { wpeVideoFilter, wpeVideoPresentation } from "./wpeVideoStyle";

const props = (overrides: Partial<WpeVideoProps> = {}): WpeVideoProps => ({
  alignment: "cover",
  position: 0,
  offsetX: 0,
  offsetY: 0,
  zoom: 1,
  flipH: false,
  background: null,
  rate: null,
  volume: null,
  color: null,
  ...overrides,
});

describe("wpeVideoPresentation", () => {
  it("没有作者属性：只有铺放", () => {
    expect(wpeVideoPresentation(null, "cover")).toEqual({
      objectFit: "cover",
      objectPosition: "center",
      transform: "",
      filter: "",
      background: "",
    });
  });

  it("铺放看 fit、不看作者的 alignment；position 只在盖满 / 放进时沿溢出轴移", () => {
    const wpe = props({ alignment: "center", position: 0.5 });
    expect(wpeVideoPresentation(wpe, "cover")).toMatchObject({ objectFit: "cover", objectPosition: "75% 75%" });
    expect(wpeVideoPresentation(wpe, "contain")).toMatchObject({ objectFit: "contain", objectPosition: "75% 75%" });
    expect(wpeVideoPresentation(wpe, "fill")).toMatchObject({ objectFit: "fill", objectPosition: "center" });
    expect(wpeVideoPresentation(props({ position: 9 }), "cover").objectPosition).toBe("100% 100%");
  });

  it("翻转；居中时按 offset 整体位移（钳到 −1…1）", () => {
    const wpe = props({ flipH: true, offsetX: 0.25, offsetY: -2 });
    expect(wpeVideoPresentation(wpe, "cover").transform).toBe("scaleX(-1)");
    expect(wpeVideoPresentation(wpe, "none").transform).toBe("scaleX(-1) translate(25%, -100%)");
  });

  it("颜色 → filter，留边颜色 → background", () => {
    const wpe = props({
      color: { brightness: 0.5, contrast: -0.5, saturation: 0, hue: 0.5 },
      background: [10, 20, 30],
    });
    const presentation = wpeVideoPresentation(wpe, "contain");
    expect(presentation.filter).toBe("brightness(1.5) contrast(0.5) saturate(1) hue-rotate(90deg)");
    expect(presentation.background).toBe("rgb(10, 20, 30)");
    expect(wpeVideoFilter(props())).toBe("");
  });
});
