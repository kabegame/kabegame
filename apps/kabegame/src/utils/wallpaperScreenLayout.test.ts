import { describe, expect, it } from "vitest";
import { layoutScreens, type ScreenRect } from "./wallpaperScreenLayout";

const rect = (id: string, x: number, y: number, width: number, height: number): ScreenRect => ({
  id,
  x,
  y,
  width,
  height,
});

/** 布局图里两块屏是否有重叠的面积。 */
function overlaps(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

describe("layoutScreens", () => {
  it("一块屏：按较紧的那个方向缩到刚好放下", () => {
    // 高度先到上限
    expect(layoutScreens([rect("a", 0, 0, 1512, 982)], 600, 140)).toEqual({
      width: 216,
      height: 140,
      scale: 140 / 982,
      boxes: [{ id: "a", left: 0, top: 0, width: 216, height: 140 }],
    });
    // 容器很窄：宽度先到上限
    const narrow = layoutScreens([rect("a", 0, 0, 1512, 982)], 120, 140);
    expect(narrow.width).toBe(120);
    expect(narrow.height).toBe(78);
  });

  it("两块屏左右并排：保持相对位置与大小比例，共用的边不重叠也不留缝", () => {
    // 主屏 1512×982，右边一块 1440×900、底边对齐（上边低 82）
    const layout = layoutScreens([rect("main", 0, 0, 1512, 982), rect("right", 1512, 82, 1440, 900)], 600, 140);
    expect(layout.width).toBe(421);
    expect(layout.height).toBe(140);
    const [main, right] = layout.boxes;
    expect(main).toEqual({ id: "main", left: 0, top: 0, width: 216, height: 140 });
    expect(right).toEqual({ id: "right", left: 216, top: 12, width: 205, height: 128 });
    expect(main.left + main.width).toBe(right.left);
    expect(right.top + right.height).toBe(layout.height);
  });

  it("主屏左边、上边的屏坐标为负：整体平移到原点", () => {
    const layout = layoutScreens(
      [rect("main", 0, 0, 1920, 1080), rect("left", -1920, 0, 1920, 1080), rect("above", 0, -1080, 1920, 1080)],
      400,
      200,
    );
    const byId = Object.fromEntries(layout.boxes.map((box) => [box.id, box]));
    expect(byId.left).toMatchObject({ left: 0, top: 100 });
    expect(byId.above).toMatchObject({ left: 178, top: 0 });
    expect(byId.main).toMatchObject({ left: 178, top: 100 });
    for (const box of layout.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.top + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("竖屏画成高块；上下叠放时按高度缩", () => {
    const layout = layoutScreens([rect("wide", 0, 0, 2560, 1440), rect("tall", 2560, -560, 1440, 2560)], 600, 128);
    const [wide, tall] = layout.boxes;
    expect(tall.height).toBeGreaterThan(tall.width);
    expect(tall.height).toBe(128);
    expect(wide.width).toBeGreaterThan(wide.height);
    expect(layout.height).toBe(128);
  });

  it("贴在一起的屏在图上互不重叠，输出顺序与输入一致", () => {
    const screens = [
      rect("b", 1512, 82, 1440, 900),
      rect("a", 0, 0, 1512, 982),
      rect("c", -1707, -300, 1707, 1067),
      rect("d", 0, 982, 1512, 982),
    ];
    for (const [width, height] of [
      [588, 132],
      [301, 132],
      [97, 61],
    ]) {
      const layout = layoutScreens(screens, width, height);
      expect(layout.boxes.map((box) => box.id)).toEqual(["b", "a", "c", "d"]);
      expect(layout.width).toBeLessThanOrEqual(width);
      expect(layout.height).toBeLessThanOrEqual(height);
      layout.boxes.forEach((box, index) => {
        for (const other of layout.boxes.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
      });
    }
  });

  it("没有可画的屏或没有可用区域：空布局", () => {
    const empty = { width: 0, height: 0, scale: 0, boxes: [] };
    expect(layoutScreens([], 600, 140)).toEqual(empty);
    expect(layoutScreens([rect("a", 0, 0, 1920, 1080)], 0, 140)).toEqual(empty);
    expect(layoutScreens([rect("a", 0, 0, 1920, 1080)], 600, Number.NaN)).toEqual(empty);
    // 尺寸不是正数的条目忽略，其余照画
    const layout = layoutScreens([rect("bad", 0, 0, 0, 1080), rect("ok", 100, 100, 1920, 1080)], 192, 108);
    expect(layout.boxes).toEqual([{ id: "ok", left: 0, top: 0, width: 192, height: 108 }]);
  });
});
