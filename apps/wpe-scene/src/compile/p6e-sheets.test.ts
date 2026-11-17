/**
 * P6e 点 1 的编译侧：`sheetFrames`（帧表进 bundle 的形状：格尺寸、f32 累加的 total、逐帧 Rotation / Translation）与 `autosize` 取格尺寸
 * （`imageLayerSize`）。`parseTex` 的帧表解析本身在 `sheet.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { imageLayerSize, sheetFrames } from "./bundle";
import type { TexFrame } from "./tex";

const f32 = Math.fround;
const frame = (image: number, frametime: number, x: number): TexFrame => ({
  image,
  frametime,
  x,
  y: 0,
  width: 0.5,
  widthY: 0.25,
  heightX: 0.125,
  height: 1,
});

describe("sheetFrames", () => {
  it("TEXS0003：格尺寸取头里的 gif 宽高；total 是 frametime 的 float32 逐帧累加；Rotation = (width, widthY, heightX, height)、Translation = (x, y)", () => {
    const frames = [frame(0, 0.1, 0), frame(0, 0.1, 0.5), frame(0, 0.1, 0.25)].map((item) => ({
      ...item,
      frametime: f32(item.frametime),
    }));
    const result = sheetFrames({ frames, animatedVersion: 3, gifWidth: 24, gifHeight: 12, width: 144, height: 24 })!;
    expect(result.version).toBe(3);
    expect(result.cell).toEqual([24, 12]);
    expect(result.total).toBe(f32(f32(f32(0.1) + f32(0.1)) + f32(0.1)));
    expect(result.frames[1]).toEqual({
      frametime: f32(0.1),
      image: 0,
      rotation: [0.5, 0.25, 0.125, 1],
      translation: [0.5, 0],
    });
  });

  it("版本 < 3 没有头里的格尺寸：取整张图像宽高（WPE `tex+0xb0/+0xb4`）", () => {
    const result = sheetFrames({ frames: [frame(0, 1, 0)], animatedVersion: 2, width: 144, height: 24 })!;
    expect(result.cell).toEqual([144, 24]);
    expect(result.version).toBe(2);
  });

  it("不是帧表或帧表为空：undefined", () => {
    expect(sheetFrames({ width: 1, height: 1 })).toBeUndefined();
    expect(sheetFrames({ frames: [], animatedVersion: 3, width: 1, height: 1 })).toBeUndefined();
  });
});

describe("imageLayerSize：autosize 与帧表", () => {
  const sheet = {
    width: 144,
    height: 24,
    frames: { version: 3, cell: [24, 24] as [number, number], total: 0, frames: [] },
  };

  it("autosize 且槽 0 是帧表：取格尺寸；不是帧表仍取图像尺寸；没有 autosize 照旧", () => {
    expect(imageLayerSize({ autosize: true } as never, [100, 100], sheet, [1920, 1080])).toEqual([24, 24]);
    expect(imageLayerSize({ autosize: true } as never, [100, 100], { width: 144, height: 24 }, [1920, 1080])).toEqual([
      144, 24,
    ]);
    expect(imageLayerSize({ width: 7, height: 8 } as never, [], sheet, [1920, 1080])).toEqual([7, 8]);
  });
});
