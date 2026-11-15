import { describe, expect, it } from "vitest";
import { cropRect, padRect, referenceRatio, roundf, textureKey } from "./crop";

/** 按参考尺寸 `rw × rh` 裁 `w × h`。 */
const crop = (w: number, h: number, rw: number, rh: number) => cropRect(w, h, referenceRatio(rw, rh));

describe("cropRect：FUN_1401702f0 的裁切（p11-REPORT 属性纹理、P11b 补测的实测数）", () => {
  it.each([
    ["300×200 在 1:1 → 200×200，取 x∈[50,250)", 300, 200, 1, 1, { x: 50, y: 0, width: 200, height: 200 }],
    ["640×360 在 1:1 → 360×360，取 x∈[140,500)", 640, 360, 1, 1, { x: 140, y: 0, width: 360, height: 360 }],
    ["640×360 在 1:4（32×128）→ 90×360", 640, 360, 32, 128, { x: 275, y: 0, width: 90, height: 360 }],
    ["100×400 在 1:1 → 100×100，取 y∈[150,250)", 100, 400, 1, 1, { x: 0, y: 150, width: 100, height: 100 }],
    ["300×200 在 3:2 → 整张", 300, 200, 3, 2, { x: 0, y: 0, width: 300, height: 200 }],
    ["100×400 在 3:2 → 100×66", 100, 400, 3, 2, { x: 0, y: 167, width: 100, height: 66 }],
    [
      "640×360 在 5:3 → 600×360（float32 的 360·(5/3) 落在 600）",
      640,
      360,
      500,
      300,
      { x: 20, y: 0, width: 600, height: 360 },
    ],
    ["6000×3000 在 1:1 → 3000×3000，没有缩小", 6000, 3000, 1, 1, { x: 1500, y: 0, width: 3000, height: 3000 }],
  ])("%s", (_name, w, h, rw, rh, expected) => {
    expect(crop(w, h, rw, rh)).toEqual(expected);
  });

  it("比例 0（keepaspect、没有参考尺寸）整张", () => {
    expect(cropRect(321, 123, 0)).toEqual({ x: 0, y: 0, width: 321, height: 123 });
    expect(referenceRatio(0, 10)).toBe(0);
    expect(referenceRatio(10, 0)).toBe(0);
    expect(referenceRatio(Number.NaN, 10)).toBe(0);
  });

  it("起始行 / 列用整数右移（奇数差向下取整），裁出的尺寸至少 1", () => {
    // 301×200 在 1:1：宽裁成 200，起始列 (301 − 200)>>1 = 50
    expect(crop(301, 200, 1, 1)).toEqual({ x: 50, y: 0, width: 200, height: 200 });
    // 极扁的图在 1:4 的槽里：trunc(1·0.25) = 0，夹到 1
    expect(crop(4000, 1, 32, 128).width).toBe(1);
  });
});

describe("textureKey：WPE 的纹理名 = 值 + x + round(比例·10)", () => {
  it("四舍五入远离 0，比例相近的槽共用一个名字", () => {
    expect(roundf(2.5)).toBe(3);
    expect(roundf(1.49)).toBe(1);
    expect(roundf(-2.5)).toBe(-3);
    expect(textureKey("D:/a/b.png", referenceRatio(1, 1))).toBe("D:/a/b.pngx10");
    // 1.77 与 1.78 都是 18（rea-p11b 留给实测的 14：两槽共用一张）
    expect(textureKey("p", referenceRatio(177, 100))).toBe("px18");
    expect(textureKey("p", referenceRatio(178, 100))).toBe("px18");
    expect(textureKey("p", referenceRatio(5, 3))).toBe("px17");
    expect(textureKey("p", 0)).toBe("px0");
  });
});

describe("padRect（P11d：快捷方式图标补透明边，p11-REPORT「P11d 补测」图标纹理）", () => {
  it("1:1 槽原样", () => {
    expect(padRect(256, 256, 1)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it("2:1 槽：256×256 → 512×256，左右各补 128（WPE 实测）", () => {
    expect(padRect(256, 256, 2)).toEqual({ x: 128, y: 0, width: 512, height: 256 });
  });

  it("精灵表帧比例 1.66668：426×256、左右各补 85（WPE 实测 leaves5）", () => {
    const ratio = referenceRatio(85.334, 51.2);
    expect(padRect(256, 256, ratio)).toEqual({ x: 85, y: 0, width: 426, height: 256 });
  });

  it("1:4 槽：256×1024、上下各补 384（WPE 实测 drop）", () => {
    expect(padRect(256, 256, 0.25)).toEqual({ x: 0, y: 384, width: 256, height: 1024 });
  });

  it("网站图标 160×160、300×300 同理（宽高比 1 的图标放进 2:1 与 1:2 的槽）", () => {
    expect(padRect(160, 160, 2)).toEqual({ x: 80, y: 0, width: 320, height: 160 });
    expect(padRect(160, 160, 0.5)).toEqual({ x: 0, y: 80, width: 160, height: 320 });
    expect(padRect(300, 300, 2)).toEqual({ x: 150, y: 0, width: 600, height: 300 });
    expect(padRect(300, 300, 0.5)).toEqual({ x: 0, y: 150, width: 300, height: 600 });
  });

  it("取整照 WPE：宽高用截断、偏移用右移（奇数差向下取）", () => {
    // 100×100 配 1.5 → 宽 150、偏移 25；配 1.55 → 宽 155、偏移 27（(155−100)>>1）
    expect(padRect(100, 100, 1.5)).toEqual({ x: 25, y: 0, width: 150, height: 100 });
    expect(padRect(100, 100, Math.fround(1.55))).toEqual({ x: 27, y: 0, width: 155, height: 100 });
  });

  it("图标本身就比槽宽：补高、不裁（256×128 配 1:1 → 256×256，上下各 64）", () => {
    expect(padRect(256, 128, 1)).toEqual({ x: 0, y: 64, width: 256, height: 256 });
  });

  it("比例 0（keepaspect / 没有参考尺寸）原样；float32 截断落在图标边之下时取图标的边，不裁", () => {
    expect(padRect(256, 256, 0)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
    const result = padRect(7, 7, Math.fround(1.0000001));
    expect(result.width).toBeGreaterThanOrEqual(7);
    expect(result.x).toBeGreaterThanOrEqual(0);
  });
});
