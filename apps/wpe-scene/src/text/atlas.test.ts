/**
 * 装箱器的单项规则（合成位图，不要 wasm）。和 WPE 逐字节的核对在 layout.test.ts；这里钉住基线覆盖不到的分支：
 * 和下一格重叠的差一与它清掉的那一列、零尺寸字形、非最后一行的行高要求、开新行、回收、翻倍、宽到 4096 放弃、
 * BGRA 交换、单色展开、脏区。
 */
import { describe, expect, it } from "vitest";
import { PIXEL_MODE_BGRA, PIXEL_MODE_GRAY, PIXEL_MODE_MONO, type GlyphBitmap, type WpefontFace } from "../wpefont";
import { GlyphAtlas, TextAtlases, rasterizeGlyph, type AtlasGlyph } from "./atlas";

const gray = (width: number, rows: number, value = 255): GlyphBitmap => ({
  width,
  rows,
  left: 0,
  top: rows,
  mode: PIXEL_MODE_GRAY,
  color: false,
  pixels: new Uint8Array(width * rows).fill(value),
});

let nextKey = 1;
function put(atlas: GlyphAtlas, bitmap: GlyphBitmap): AtlasGlyph {
  const result = atlas.insert(nextKey, nextKey, bitmap);
  nextKey++;
  if ("full" in result) throw new Error("图集满");
  return result;
}
const rect = (g: AtlasGlyph) => [g.x0, g.y0, g.x1, g.y1];
const px = (atlas: GlyphAtlas, x: number, y: number) => atlas.pixels[y * atlas.width + x];

describe("装箱器（照 FUN_1401ae080）", () => {
  it("同一行从左往右、格子之间留 1 像素；UV 是 float32 的「像素 / 尺寸」", () => {
    const atlas = new GlyphAtlas(false);
    const a = put(atlas, gray(10, 10));
    const b = put(atlas, gray(5, 8));
    const c = put(atlas, gray(4, 12)); // 最后一行：比行高还高也照放，行高变成 12
    expect([rect(a), rect(b), rect(c)]).toEqual([
      [0, 0, 10, 10],
      [11, 0, 16, 8],
      [17, 0, 21, 12],
    ]);
    expect([b.u0, b.v0, b.u1, b.v1]).toEqual([Math.fround(11 / 512), 0, Math.fround(16 / 512), Math.fround(8 / 512)]);
  });

  it("差一：「放在上一格之后」比的是 `下一格.x0 − 上一格.x1`，放下后和下一格重叠一列，清零还会清掉下一格的第二列（1a 那 1 个像素）", () => {
    const atlas = new GlyphAtlas(false);
    const one = put(atlas, gray(31, 47));
    const two = put(atlas, gray(38, 49));
    expect(rect(two)).toEqual([32, 0, 70, 49]);
    atlas.pixels[511 * 512 + 32] = 9; // 上一行（y0 = 0 时是最后一行）
    const space = put(atlas, gray(1, 1, 7)); // opensticks 的空格：1×1
    expect(rect(space)).toEqual([32, 0, 33, 1]); // 放进「1」和「2」之间只有 1 列宽的空隙，压在「2」的第一列上
    expect(px(atlas, 32, 0)).toBe(7); // 写进了「2」的格子
    expect(px(atlas, 32, 1)).toBe(0); // 下一行清零：「2」的 (32, 1)
    expect(px(atlas, 33, 0)).toBe(0); // 右一列清零：「2」的第二列
    expect(px(atlas, 31, 0)).toBe(0); // 左一列（空隙）
    expect(px(atlas, 32, 511)).toBe(0); // 上一行绕回最后一行
    expect([px(atlas, 34, 0), px(atlas, 32, 2), px(atlas, 33, 1)]).toEqual([255, 255, 255]);
    expect(rect(one)).toEqual([0, 0, 31, 47]);
  });

  it("零尺寸字形（空格）占一列、什么也不清", () => {
    const atlas = new GlyphAtlas(false);
    const a = put(atlas, gray(10, 10));
    atlas.pixels[511 * 512 + 11] = 9;
    atlas.pixels[10] = 8;
    const space = put(atlas, gray(0, 0));
    expect(rect(space)).toEqual([11, 0, 11, 0]);
    expect([px(atlas, 11, 511), px(atlas, 10, 0)]).toEqual([9, 8]);
    const b = put(atlas, gray(5, 5));
    expect(rect(b)).toEqual([12, 0, 17, 5]); // 从空格的 x1 + 1 起
    expect(rect(a)).toEqual([0, 0, 10, 10]);
  });

  it("新行；不是最后一行时要 h + 1 ≤ 行高", () => {
    const atlas = new GlyphAtlas(false);
    put(atlas, gray(500, 20));
    const b = put(atlas, gray(20, 10)); // 第 0 行末尾只剩 11 列
    expect(rect(b)).toEqual([0, 21, 20, 31]);
    const c = put(atlas, gray(5, 10)); // 第 0 行不是最后一行，10 + 1 ≤ 20，放得下
    expect(rect(c)).toEqual([501, 0, 506, 10]);
    const d = put(atlas, gray(5, 20)); // 20 + 1 > 20，落到第 1 行，第 1 行的行高长到 20
    expect(rect(d)).toEqual([21, 21, 26, 41]);
    const e = put(atlas, gray(4, 4));
    expect(rect(e)).toEqual([507, 0, 511, 4]);
  });

  it("满了先回收引用数为 0 的旧字形（复用它的格子），都在用时宽高翻倍、旧 UV × 0.5、行的最大空隙记成旧宽度", () => {
    const atlas = new GlyphAtlas(false);
    const cells: AtlasGlyph[] = [];
    for (let i = 0; i < 25; i++) {
      const g = put(atlas, gray(100, 100, i + 1));
      g.refs = 1;
      cells.push(g);
    }
    expect(rect(cells[24])).toEqual([404, 404, 504, 504]);
    cells[2].refs = 0;
    // 让出的格子在第 0 行，不是最后一行，要 h + 1 ≤ 行高（100），所以只有矮一点的字形用得上它
    const reused = put(atlas, gray(90, 90, 99));
    expect(rect(reused)).toEqual([202, 0, 292, 90]);
    expect(cells[2].recycled).toBe(true);
    expect(atlas.find(cells[2].key)).toBeNull();
    expect(atlas.width).toBe(512);
    reused.refs = 1;

    // 同样 100 高的字形进不了前四行（101 > 100），最后一行满了、没有可回收的 → 翻倍
    const before = { ...cells[1] };
    const grown = put(atlas, gray(100, 100, 77));
    expect([atlas.width, atlas.height, atlas.generation]).toEqual([1024, 1024, 1]);
    expect([cells[1].u0, cells[1].u1]).toEqual([Math.fround(before.u0 * 0.5), Math.fround(before.u1 * 0.5)]);
    expect([px(atlas, 150, 50), px(atlas, 50, 450)]).toEqual([2, 21]); // 旧像素在左上角
    expect(rect(grown)).toEqual([505, 404, 605, 504]); // 最后一行的末尾，接在旧宽度后面
    expect(atlas.takeDirty()).toBe("all");
  });

  it("宽到 4096 还放不下就放弃", () => {
    const atlas = new GlyphAtlas(false);
    const result = atlas.insert(1, 1, gray(4096, 1));
    expect("full" in result && result.full).toBe(atlas);
    expect(atlas.width).toBe(4096);
  });

  it("BGRA 交换 R、B 进 RGBA8（不反预乘）；单色点阵展开成 0 / 255；脏区", () => {
    const color = new GlyphAtlas(true);
    const bgra: GlyphBitmap = {
      width: 2,
      rows: 1,
      left: 0,
      top: 1,
      mode: PIXEL_MODE_BGRA,
      color: true,
      pixels: Uint8Array.of(10, 20, 30, 40, 50, 60, 70, 80),
    };
    const g = color.insert(1, 1, bgra) as AtlasGlyph;
    expect(g.color).toBe(true);
    expect(Array.from(color.pixels.subarray(0, 8))).toEqual([30, 20, 10, 40, 70, 60, 50, 80]);

    const mono = new GlyphAtlas(false);
    mono.takeDirty();
    mono.insert(1, 1, {
      width: 10,
      rows: 1,
      left: 0,
      top: 1,
      mode: PIXEL_MODE_MONO,
      color: false,
      pixels: Uint8Array.of(0b10100000, 0b01000000),
    });
    expect(Array.from(mono.pixels.subarray(0, 10))).toEqual([255, 0, 255, 0, 0, 0, 0, 0, 0, 255]);
    const dirty = mono.takeDirty();
    expect(dirty).not.toBe("all");
    expect(dirty).toContainEqual({ x0: 0, y0: 0, x1: 10, y1: 1 });
    expect(mono.takeDirty()).toEqual([]);
  });
});

describe("rasterizeGlyph", () => {
  it("键是 face 下标 << 24 | gid；先查主图集再查彩色图集；彩色字形进另一张 RGBA8；栅格化失败返回 null", () => {
    const calls: number[] = [];
    const face = {
      glyph(gid: number): GlyphBitmap | null {
        calls.push(gid);
        if (gid === 404) return null;
        if (gid === 7)
          return { width: 1, rows: 1, left: 0, top: 1, mode: PIXEL_MODE_BGRA, color: true, pixels: new Uint8Array(4) };
        return gray(3, 3);
      },
    } as unknown as WpefontFace;
    const entry = new TextAtlases().get("fonts/x.ttf_2048");
    const a = rasterizeGlyph(entry, face, 2, 5) as AtlasGlyph;
    expect(a.key).toBe(0x02000005);
    expect(rasterizeGlyph(entry, face, 2, 5)).toBe(a); // 缓存，不再栅格化
    expect(rasterizeGlyph(entry, face, 3, 5)).not.toBe(a); // 不同 face 下标是不同字形
    const c = rasterizeGlyph(entry, face, 0, 7) as AtlasGlyph;
    expect(c.color).toBe(true);
    expect(c.atlas).toBe(entry.color);
    expect(rasterizeGlyph(entry, face, 0, 7)).toBe(c);
    expect(rasterizeGlyph(entry, face, 0, 404)).toBeNull();
    expect(calls).toEqual([5, 5, 7, 404]);
  });
});
