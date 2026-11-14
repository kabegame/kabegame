import { describe, expect, it } from "vitest";
import { cropRect, referenceRatio, roundf, textureKey } from "./crop";

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
