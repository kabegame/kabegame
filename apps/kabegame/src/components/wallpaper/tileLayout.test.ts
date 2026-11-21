import { describe, expect, it } from "vitest";
import { tileRects } from "./tileLayout";

describe("tileRects", () => {
  it("比例和画布相同：只有一格，正好铺满", () => {
    expect(tileRects(1920, 1080, 3840, 2160)).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }]);
  });

  it("方形视频放进横屏：高度放满，居中一格，左右各补一格", () => {
    const rects = tileRects(3840, 2161, 960, 960);
    expect(rects).toEqual([
      { x: -1321, y: 0, width: 2161, height: 2161 },
      { x: 840, y: 0, width: 2161, height: 2161 },
      { x: 3001, y: 0, width: 2161, height: 2161 },
    ]);
    // 居中那格的中心就是画布中心（边取整，最多差半个像素）
    expect(Math.abs(rects[1].x + rects[1].width / 2 - 3840 / 2)).toBeLessThanOrEqual(0.5);
  });

  it("宽视频放进竖屏：宽度放满，上下重复", () => {
    const rects = tileRects(1000, 2000, 400, 300);
    expect(rects.every((r) => r.x === 0 && r.width === 1000)).toBe(true);
    // 中间一格居中，上下各补格子直到盖住整个画布
    expect(rects[0].y).toBeLessThanOrEqual(0);
    const last = rects[rects.length - 1];
    expect(last.y + last.height).toBeGreaterThanOrEqual(2000);
    expect(rects.some((r) => r.y + r.height / 2 === 1000)).toBe(true);
  });

  it("相邻格子共用一条边：没有缝也不重叠", () => {
    const rects = tileRects(2648, 1490, 681, 1000);
    for (let i = 0; i + 1 < rects.length; i++) expect(rects[i].x + rects[i].width).toBe(rects[i + 1].x);
  });

  it("尺寸未知时没有格子", () => {
    expect(tileRects(0, 1080, 100, 100)).toEqual([]);
    expect(tileRects(1920, 1080, 0, 100)).toEqual([]);
  });
});
