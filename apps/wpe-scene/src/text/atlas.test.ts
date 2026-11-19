/**
 * 装箱器的单项规则（合成位图，不要 wasm）。和 WPE 逐字节的核对在 layout.test.ts；这里钉住基线覆盖不到的分支：
 * 和下一格重叠的差一与它清掉的那一列、零尺寸字形、非最后一行的行高要求、开新行、回收、翻倍、宽到 4096 放弃、
 * BGRA 交换、单色展开、脏区。
 */
import { describe, expect, it } from "vitest";
import { PIXEL_MODE_BGRA, PIXEL_MODE_GRAY, PIXEL_MODE_MONO, type GlyphBitmap, type WpefontFace } from "../wpefont";
import { GlyphAtlas, TextAtlases, rasterizeGlyph, type AtlasGlyph, type MsdfSource } from "./atlas";

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
function put(atlas: GlyphAtlas, bitmap: GlyphBitmap | MsdfSource): AtlasGlyph {
  const result = atlas.insert(nextKey, nextKey, bitmap);
  nextKey++;
  if ("full" in result) throw new Error("图集满");
  return result;
}
const rect = (g: AtlasGlyph) => [g.x0, g.y0, g.x1, g.y1];
const px = (atlas: GlyphAtlas, x: number, y: number) => atlas.pixels[y * atlas.width + x];

describe("装箱器（照 FUN_1401ae080）", () => {
  it("同一行从左往右、格子之间留 1 像素；UV 是 float32 的「像素 / 尺寸」", () => {
    const atlas = new GlyphAtlas(1);
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
    const atlas = new GlyphAtlas(1);
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
    const atlas = new GlyphAtlas(1);
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
    const atlas = new GlyphAtlas(1);
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
    const atlas = new GlyphAtlas(1);
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
    const atlas = new GlyphAtlas(1);
    const result = atlas.insert(1, 1, gray(4096, 1));
    expect("full" in result && result.full).toBe(atlas);
    expect(atlas.width).toBe(4096);
  });

  it("BGRA 交换 R、B 进 RGBA8（不反预乘）；单色点阵展开成 0 / 255；脏区", () => {
    const color = new GlyphAtlas(4);
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

    const mono = new GlyphAtlas(1);
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

/**
 * MSDF 图集（P6f）：同一个装箱器，格子 = `inner + 24`、每像素 4 字节。装箱位置取自 WPE 抓帧（p6f-grow，94 个可见 ASCII 字形、NotoSans 16 磅，
 * 格子宽高与最终位置由 `ignore/p6/f0/msdf/cmp.mjs` 对 WPE 图集逐字节核对得出，包括跨行回填：y = 315 那行放不下的「n」回填到 y = 259 那一行的末尾）。
 * 每项：宽、高、x0、y0。
 */
// prettier-ignore
const GROW_CELLS: [number, number, number, number][] = [[28,47,0,0],[33,32,29,0],[43,46,63,0],[38,50,107,0],[47,47,146,0],[45,47,194,0],[27,32,240,0],[31,52,268,0],[31,52,300,0],[39,38,332,0],[39,39,372,0],[29,32,412,0],[32,26,442,0],[28,28,475,0],[35,46,0,53],[39,47,36,53],[33,46,76,53],[39,47,110,53],[39,47,150,53],[41,46,190,53],[38,47,232,53],[39,47,271,53],[39,46,311,53],[39,47,351,53],[39,47,391,53],[28,42,431,53],[29,45,460,53],[39,40,0,101],[39,32,40,101],[39,40,80,101],[37,47,120,101],[49,50,158,101],[44,46,208,101],[40,46,253,101],[41,47,294,101],[42,46,336,101],[37,46,379,101],[37,46,417,101],[43,47,455,101],[41,46,0,152],[32,46,42,152],[33,53,75,152],[41,46,109,152],[37,46,151,152],[46,46,189,152],[42,46,236,152],[45,47,279,152],[38,46,325,152],[45,53,364,152],[40,46,410,152],[38,47,451,152],[41,46,0,206],[41,47,42,206],[43,46,84,206],[53,46,128,206],[42,46,182,206],[42,46,225,206],[40,46,268,206],[31,52,309,206],[35,46,341,206],[31,52,377,206],[40,38,409,206],[38,26,450,206],[31,29,0,259],[37,42,32,259],[39,48,70,259],[36,42,110,259],[39,48,147,259],[39,42,187,259],[35,48,227,259],[39,49,263,259],[38,48,303,259],[27,47,342,259],[32,55,370,259],[38,48,403,259],[27,48,442,259],[48,41,0,315],[38,41,470,259],[40,42,49,315],[39,49,90,315],[39,49,130,315],[34,41,170,315],[36,42,205,315],[34,45,242,315],[38,41,277,315],[40,41,316,315],[48,41,357,315],[40,41,406,315],[40,48,447,315],[36,41,0,365],[34,52,37,365],[26,56,72,365],[34,52,99,365],[39,28,134,365]];

const msdfSource = (width: number, height: number, value: number | null = 200) => ({
  width,
  height,
  rgba: value === null ? null : new Uint8Array(width * height * 4).fill(value),
});

/** 图集里 (x, y) 处一个像素的 4 个字节。 */
const pixel4 = (atlas: GlyphAtlas, x: number, y: number) =>
  Array.from(atlas.pixels.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4));

describe("MSDF 图集（RGBA8）", () => {
  it("p6f-grow 的 94 个格子：装箱位置与 WPE 抓帧逐个相同（含跨行回填），图集不扩容", () => {
    const atlas = new GlyphAtlas(4, false);
    const actual = GROW_CELLS.map(([w, h]) => {
      const g = put(atlas, msdfSource(w, h));
      return [w, h, g.x0, g.y0];
    });
    expect(actual).toEqual(GROW_CELLS);
    expect([atlas.width, atlas.height, atlas.generation]).toEqual([512, 512, 0]);
  });

  it("主图集 bpp = 4、不是彩色图集；整格逐行拷进去（每行 宽 · 4 字节），格子里的字形 color 为 false", () => {
    const atlas = new GlyphAtlas(4, false);
    expect([atlas.bpp, atlas.color]).toEqual([4, false]);
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => i + 1);
    const g = put(atlas, { width: 3, height: 2, rgba });
    expect(g.color).toBe(false);
    expect(rect(g)).toEqual([0, 0, 3, 2]);
    const row = (y: number) => Array.from(atlas.pixels.subarray(y * 512 * 4, (y * 512 + 3) * 4));
    expect(row(0)).toEqual(Array.from(rgba.subarray(0, 12)));
    expect(row(1)).toEqual(Array.from(rgba.subarray(12, 24)));
    // 彩色字形图集默认 color 为 true
    expect(new GlyphAtlas(4).color).toBe(true);
    expect(new GlyphAtlas(1).color).toBe(false);
  });

  it("清零四周写 4 字节（RGBA 全 0）：上、下各 w 个像素，左、右各一列", () => {
    const atlas = new GlyphAtlas(4, false);
    atlas.pixels.fill(9);
    put(atlas, msdfSource(2, 2, 200)); // (0, 0)：占住左上角
    const g = put(atlas, msdfSource(3, 2, 200)); // 同一行 (3, 0)
    expect(rect(g)).toEqual([3, 0, 6, 2]);
    // 格子内容
    expect(pixel4(atlas, 3, 0)).toEqual([200, 200, 200, 200]);
    expect(pixel4(atlas, 5, 1)).toEqual([200, 200, 200, 200]);
    const zero = [0, 0, 0, 0];
    // 左一列（x = 2）与右一列（x = 6）：每个像素 4 个字节都清零
    expect([pixel4(atlas, 2, 0), pixel4(atlas, 2, 1)]).toEqual([zero, zero]);
    expect([pixel4(atlas, 6, 0), pixel4(atlas, 6, 1)]).toEqual([zero, zero]);
    // 下一行（y = 2）：x = 3…5
    expect([pixel4(atlas, 3, 2), pixel4(atlas, 4, 2), pixel4(atlas, 5, 2)]).toEqual([zero, zero, zero]);
    // 上一行绕回最后一行（y0 = 0）
    expect([pixel4(atlas, 3, 511), pixel4(atlas, 5, 511)]).toEqual([zero, zero]);
    // x0 = 0 的格子（第一个）：左一列绕回最后一列，只有它自己的清零会碰到
    expect([pixel4(atlas, 511, 0), pixel4(atlas, 511, 1)]).toEqual([zero, zero]);
    // 清零范围之外不动
    const nine = [9, 9, 9, 9];
    expect([pixel4(atlas, 6, 2), pixel4(atlas, 2, 2), pixel4(atlas, 7, 0)]).toEqual([nine, nine, nine]);
  });

  it("空包围盒（空格）占 24×24 的格子、不写像素；格子里原有的内容保留（回收来的格子的残留照 WPE 不清）", () => {
    const atlas = new GlyphAtlas(4, false);
    atlas.pixels.fill(7);
    const a = put(atlas, msdfSource(30, 30, 100));
    const space = put(atlas, msdfSource(24, 24, null));
    expect(rect(a)).toEqual([0, 0, 30, 30]);
    expect(rect(space)).toEqual([31, 0, 55, 24]);
    expect(pixel4(atlas, 40, 10)).toEqual([7, 7, 7, 7]); // 格子里没被写
    expect(pixel4(atlas, 30, 10)).toEqual([0, 0, 0, 0]); // 左一列被清
    expect(pixel4(atlas, 55, 10)).toEqual([0, 0, 0, 0]); // 右一列被清
    expect(pixel4(atlas, 40, 24)).toEqual([0, 0, 0, 0]); // 下一行被清
  });

  it("没有生成的格子也进字形表，下次同键直接命中；清零算脏区", () => {
    const atlas = new GlyphAtlas(4, false);
    atlas.takeDirty();
    const space = atlas.insert(5, 5, msdfSource(24, 24, null)) as AtlasGlyph;
    expect(atlas.find(5)).toBe(space);
    expect(atlas.takeDirty()).not.toEqual([]);
  });
});

describe("rasterizeGlyph（MSDF）", () => {
  const cell = (generated = true) => ({
    x0: 0,
    y0: 0,
    x1: 10,
    y1: 10,
    width: 30,
    height: 28,
    generated,
    yPpem: 133,
    pixels: new Uint8Array(30 * 28 * 4).fill(5),
  });
  const stub = (options: { color?: boolean; result?: ReturnType<typeof cell> | null } = {}) => {
    const calls: number[] = [];
    const face = {
      isColor: () => options.color ?? false,
      msdf(gid: number) {
        calls.push(gid);
        return options.result === undefined ? cell() : options.result;
      },
      glyph() {
        throw new Error("MSDF 路径不栅格化位图");
      },
    } as unknown as WpefontFace;
    return { face, calls };
  };

  it("MSDF 图集：主图集 RGBA8、没有彩色图集；键仍是 face 下标 << 24 | gid；命中不再生成", () => {
    const entry = new TextAtlases().get("fonts/x.ttf_msdf", true);
    expect([entry.msdf, entry.main.bpp, entry.main.color, entry.color]).toEqual([true, 4, false, null]);
    const { face, calls } = stub();
    const a = rasterizeGlyph(entry, face, 2, 5) as AtlasGlyph;
    expect(a.key).toBe(0x02000005);
    expect(rect(a)).toEqual([0, 0, 30, 28]);
    expect(a.atlas).toBe(entry.main);
    expect(rasterizeGlyph(entry, face, 2, 5)).toBe(a);
    expect(calls).toEqual([5]); // 第二次命中，没有再生成（先到的字号胜出）
    expect(rasterizeGlyph(entry, face, 3, 5)).not.toBe(a);
    expect(entry.color).toBeNull();
  });

  it("空包围盒：格子 24×24 占位、不写像素", () => {
    const entry = new TextAtlases().get("k_msdf", true);
    const empty = { ...cell(false), width: 24, height: 24, pixels: new Uint8Array(24 * 24 * 4) };
    const g = rasterizeGlyph(entry, stub({ result: empty }).face, 0, 3) as AtlasGlyph;
    expect(rect(g)).toEqual([0, 0, 24, 24]);
  });

  it("彩色 face 的字形不生成，返回 text:msdf:color；生成失败返回 null", () => {
    const entry = new TextAtlases().get("k_msdf", true);
    const colored = stub({ color: true });
    expect(rasterizeGlyph(entry, colored.face, 0, 7)).toEqual({ unsupported: "text:msdf:color" });
    expect(colored.calls).toEqual([]);
    expect(entry.main.glyphs.size).toBe(0);
    expect(rasterizeGlyph(entry, stub({ result: null }).face, 0, 8)).toBeNull();
  });

  it("普通与 MSDF 是两种图集（普通 R8、MSDF RGBA8）", () => {
    const atlases = new TextAtlases();
    const plain = atlases.get("fonts/x.ttf_2048");
    const msdf = atlases.get("fonts/x.ttf_msdf", true);
    expect([plain.main.bpp, msdf.main.bpp]).toEqual([1, 4]);
    expect(plain.msdf).toBe(false);
  });
});
