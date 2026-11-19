/**
 * wpefont 的包装与字形基线。
 * - wasm 由 `deno task build:wpefont` 产出、kabegame 命令拷进本目录；没有就整组跳过。
 * - 用到字体的用例要 `KABEGAME_WPE_ROOT` 指向 WPE 安装目录（字体在它的 `assets/fonts/`），不碰系统字体。
 * - `fixtures/baseline.json`：1a 用发布包编出的 wasm 的结果（已和 WPE 图集核对），由
 *   `apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py` 生成，来源写在文件的 `source`。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import baseline from "./fixtures/baseline.json";
import { PIXEL_MODE_BGRA, PIXEL_MODE_GRAY, Wpefont, type GlyphBitmap } from "./index";

const WASM = fileURLToPath(new URL("./wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;

/** `FT_LOAD_FORCE_AUTOHINT`。 */
const FORCE_AUTOHINT = 1 << 5;

const codepoints = (text: string) => Array.from(text, (ch) => ch.codePointAt(0)!);
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

/** 位图框 `(left, top − rows, left + width, top)`，和 `WpefontFace.box` 同一形状。 */
const bitmapBox = (glyph: GlyphBitmap) => ({
  xMin: glyph.left,
  yMin: glyph.top - glyph.rows,
  xMax: glyph.left + glyph.width,
  yMax: glyph.top,
});

/**
 * MSDF 格子基线（P6f 步骤 0b）：WPE 抓帧里 `__font_atlas_`（RGBA8）的格子，SHA-1 取自 `ignore/p6/f0/out/rd/tex/p6f-atlas-*.png`
 * （p6f-atlas 工程，格子位置由 `ignore/p6/f0/msdf/cmp.mjs` 的装箱模拟与整图搜索定出，逐字节相同）。
 * 每项：字体（`assets/` 下或系统字体）、字号、字符、格子宽、高、是否生成（空包围盒不生成）、face 的 y_ppem、格子字节的 SHA-1。
 */
const WINDOWS_FONTS = "C:/Windows/Fonts";
const MSDF_CELLS: {
  name: string;
  font: string;
  system?: boolean;
  pointsize: number;
  char: string;
  width: number;
  height: number;
  generated: boolean;
  yPpem: number;
  sha1: string;
}[] = [
  {
    name: "RobotoMono A（TrueType 字节码）",
    font: "fonts/RobotoMono-Regular.ttf",
    pointsize: 32,
    char: "A",
    width: 41,
    height: 47,
    generated: true,
    yPpem: 133,
    sha1: "573f2a0dcc49b51dc904372f521d3f010735546c",
  },
  {
    name: "RobotoMono &",
    font: "fonts/RobotoMono-Regular.ttf",
    pointsize: 32,
    char: "&",
    width: 41,
    height: 47,
    generated: true,
    yPpem: 133,
    sha1: "3ec25df570819a1f3810ed308c98864ecbe9a4b3",
  },
  {
    name: "RobotoMono 空格（占 24×24、不生成）",
    font: "fonts/RobotoMono-Regular.ttf",
    pointsize: 32,
    char: " ",
    width: 24,
    height: 24,
    generated: false,
    yPpem: 133,
    sha1: "5a21b9c1bbe546da39986d2314aca97f14250155",
  },
  {
    name: "NotoSans 12 磅 H",
    font: "fonts/NotoSans-Regular.ttf",
    pointsize: 12,
    char: "H",
    width: 42,
    height: 46,
    generated: true,
    yPpem: 50,
    sha1: "522ad6e7aec630a595bd5d21ef761ab5966f93f6",
  },
  {
    name: "NotoSans 72 磅 x（格子大小按字号）",
    font: "fonts/NotoSans-Regular.ttf",
    pointsize: 72,
    char: "x",
    width: 39,
    height: 41,
    generated: true,
    yPpem: 300,
    sha1: "0e9e4b5663f99c4182c6bbb2e968c3644a343d36",
  },
  {
    name: "spincycle_3d（CFF 三次曲线）2",
    font: "fonts/spincycle_3d_ot.otf",
    pointsize: 36,
    char: "2",
    width: 43,
    height: 44,
    generated: true,
    yPpem: 150,
    sha1: "d4ee0146742a6fe1aa96ba16225c6c6fa74f045c",
  },
  {
    name: "Atami（CFF）Q",
    font: "fonts/Atami-Regular.otf",
    pointsize: 16,
    char: "Q",
    width: 47,
    height: 52,
    generated: true,
    yPpem: 67,
    sha1: "15ac522c129b9daf8a185db025f4cc239a134282",
  },
  {
    name: "opensticks（无指令 TrueType，强制自动 hinting）1",
    font: "fonts/opensticks.ttf",
    pointsize: 16,
    char: "1",
    width: 38,
    height: 46,
    generated: true,
    yPpem: 67,
    sha1: "1311ae8c279b19ab4e3e6454ba2d397916e24c85",
  },
  {
    name: "opensticks 空格（包围盒 1×1，仍生成）",
    font: "fonts/opensticks.ttf",
    pointsize: 16,
    char: " ",
    width: 25,
    height: 25,
    generated: true,
    yPpem: 67,
    sha1: "d53cc00216cc120d1a109900a8204c6517ba54af",
  },
  {
    name: "msyh 中（回退到系统字体的 CJK）",
    font: "msyh.ttc",
    system: true,
    pointsize: 32,
    char: "中",
    width: 51,
    height: 55,
    generated: true,
    yPpem: 133,
    sha1: "75d70bb943acafa94b343a8acf02a226bb53a446",
  },
  {
    name: "arial x（systemfont_arial）",
    font: "arial.ttf",
    system: true,
    pointsize: 32,
    char: "x",
    width: 39,
    height: 40,
    generated: true,
    yPpem: 133,
    sha1: "99b0540e583b711eb2675127d15a09ed52f2d018",
  },
];

describe.skipIf(!existsSync(WASM))("wpefont wasm", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const load = async () => {
    module ??= WebAssembly.compile(readFileSync(WASM));
    return Wpefont.fromModule(await module);
  };
  const font = (name: string) => readFileSync(join(root!, "assets", name));

  it("实例化；不是字体的数据返回 null", async () => {
    const engine = await load();
    expect(engine.face(new Uint8Array(0), 32)).toBeNull();
    expect(engine.face(new Uint8Array(4096).fill(7), 32)).toBeNull();
    expect(engine.face(new ArrayBuffer(16), 32)).toBeNull();
  });

  describe.skipIf(!root)("WPE 自带字体", () => {
    it("查字、度量、排字、取字形、释放", async () => {
      const face = (await load()).face(font("fonts/NotoSans-Regular.ttf"), 32)!;
      expect(face).not.toBeNull();
      expect(face.has(0x48)).toBe(true);
      expect(face.has(0x4e2d)).toBe(false); // NotoSans-Regular 没有汉字

      // 32 磅 × 300 DPI = 133.33 像素 / em；度量是 26.6，FreeType 已把它们取整到整像素
      const metrics = face.metrics();
      expect(metrics.unitsPerEm).toBe(1000);
      expect(metrics.ascender).toBeGreaterThan(0);
      expect(metrics.descender).toBeLessThan(0);
      expect([metrics.ascender, metrics.descender, metrics.height].map((v) => v & 63)).toEqual([0, 0, 0]);
      expect(metrics.forceAutohint).toBe(false); // 有 fpgm

      const shaped = face.shape(codepoints("Hi g"));
      expect(shaped.map((g) => g.cluster)).toEqual([0, 1, 2, 3]);
      expect(shaped.every((g) => g.xAdvance > 0 && g.yAdvance === 0)).toBe(true);
      expect(face.shape([])).toEqual([]);

      const h = face.glyph(shaped[0].gid)!;
      expect(h.mode).toBe(PIXEL_MODE_GRAY);
      expect(h.color).toBe(false);
      expect(h.width).toBeGreaterThan(0);
      expect(h.pixels.length).toBe(h.width * h.rows);
      expect(Math.max(...h.pixels)).toBe(255);
      // 普通灰度字形：轮廓框向外取整就是位图框；取框会覆盖字形槽，先取位图再取框、反过来都一样
      expect(face.box(shaped[0].gid)).toEqual(bitmapBox(h));
      expect(face.box(shaped[0].gid)).toBe(face.box(shaped[0].gid)); // 按 gid 缓存
      expect(face.glyph(shaped[0].gid)!.pixels).toEqual(h.pixels);

      // 空格：零尺寸位图，框为空
      const space = face.glyph(shaped[2].gid)!;
      expect([space.width, space.rows, space.pixels.length]).toEqual([0, 0, 0]);
      expect(face.box(shaped[2].gid)).toEqual({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 });

      expect(face.glyph(0x7fffffff)).toBeNull(); // gid 越界
      expect(face.box(0x7fffffff)).toBeNull();

      face.dispose();
      expect(face.disposed).toBe(true);
      expect(() => face.has(0x48)).toThrow("已释放");
      face.dispose(); // 重复释放无害
    });

    it("长文本：暂存区扩容后结果不变", async () => {
      const face = (await load()).face(font("fonts/RobotoMono-Regular.ttf"), 32)!;
      const short = face.shape(codepoints("AVAW"));
      const long = face.shape(codepoints("AVAW".repeat(5000)));
      expect(long).toHaveLength(20000);
      expect(long.slice(-4).map((g) => [g.gid, g.xAdvance])).toEqual(short.map((g) => [g.gid, g.xAdvance]));
      expect(long.at(-1)!.cluster).toBe(19999);
      face.dispose();
    });

    it("多个字体同时存活，wasm 内存增长后旧字体照常可用", async () => {
      const engine = await load();
      const noto = engine.face(font("fonts/NotoSans-Regular.ttf"), 48)!;
      const before = noto.glyph(noto.shape(codepoints("Q"))[0].gid)!;
      const others = Array.from({ length: 8 }, () => engine.face(font("fonts/TwemojiMozilla.ttf"), 48)!);
      expect(others.every((face) => face !== null)).toBe(true);
      const after = noto.glyph(noto.shape(codepoints("Q"))[0].gid)!;
      expect(sha1(after.pixels)).toBe(sha1(before.pixels));
      for (const face of [noto, ...others]) face.dispose();
    });

    it("彩色字形：BGRA，4 字节 / 像素", async () => {
      const face = (await load()).face(font("fonts/TwemojiMozilla.ttf"), 32)!;
      expect(face.has(0x1f600)).toBe(true);
      const glyph = face.glyph(face.shape([0x1f600])[0].gid)!;
      expect(glyph.mode).toBe(PIXEL_MODE_BGRA);
      expect(glyph.color).toBe(true);
      expect(face.isColor()).toBe(true); // COLR / CPAL：MSDF 路径不走 msdfgen
      expect(glyph.pixels.length).toBe(4 * glyph.width * glyph.rows);
      // 框 ≠ 位图框：Twemoji 是 COLR 字体，基础字形没有轮廓，NO_BITMAP 加载的框为空，而位图是图层合成出来的。
      // WPE 照框画四边形，所以回退到 Twemoji 的 emoji 在 WPE 里是零尺寸四边形（看不见）
      expect(face.box(face.shape([0x1f600])[0].gid)).toEqual({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
      expect(bitmapBox(glyph)).toEqual({ xMin: 0, yMin: -17, xMax: 134, yMax: 117 });
      face.dispose();
    });
  });

  describe.skipIf(!root)("MSDF 格子和 WPE 图集逐字节相同（msdfgen v1.13 + WPE 外围流程）", () => {
    for (const cell of MSDF_CELLS) {
      // skipIf 时用例体照样收集：没有 root 不能 join（收集阶段就会抛）
      const file = cell.system ? join(WINDOWS_FONTS, cell.font) : root ? join(root, "assets", cell.font) : "";
      it.skipIf(!existsSync(file))(cell.name, async () => {
        const face = (await load()).face(readFileSync(file), cell.pointsize)!;
        expect(face).not.toBeNull();
        const gid = face.shape(codepoints(cell.char))[0].gid;
        const msdf = face.msdf(gid)!;
        expect(msdf).not.toBeNull();
        expect([msdf.width, msdf.height, msdf.generated, msdf.yPpem]).toEqual([
          cell.width,
          cell.height,
          cell.generated,
          cell.yPpem,
        ]);
        expect(face.metrics().yPpem).toBe(cell.yPpem);
        expect(msdf.pixels.length).toBe(cell.width * cell.height * 4);
        expect(sha1(msdf.pixels)).toBe(cell.sha1);
        // 没生成的格子是全 0；生成的格子 alpha 恒 255
        if (!cell.generated) expect(msdf.pixels.every((v) => v === 0)).toBe(true);
        else expect(msdf.pixels.filter((_, i) => i % 4 === 3).every((v) => v === 255)).toBe(true);
        // 取框与 box() 一致
        expect({ xMin: msdf.x0, yMin: msdf.y0, xMax: msdf.x1, yMax: msdf.y1 }).toEqual(face.box(gid));
        face.dispose();
      });
    }

    it("gid 越界返回 null", async () => {
      const engine = await load();
      const noto = engine.face(font("fonts/NotoSans-Regular.ttf"), 32)!;
      expect(noto.msdf(0x7fffffff)).toBeNull();
      expect(noto.isColor()).toBe(false);
      noto.dispose();
    });
  });

  describe.skipIf(!root)("和 1a 发布包的字形逐项相同（fixtures/baseline.json）", () => {
    for (const object of baseline.objects) {
      it(`${object.key}（${object.font} ${object.pointsize} 磅）`, async () => {
        const face = (await load()).face(font(object.font), object.pointsize)!;
        expect(face).not.toBeNull();
        const metrics = face.metrics();
        const [ascender, descender, height, unitsPerEm, loadFlags] = object.metrics;
        expect(metrics).toEqual({
          ascender,
          descender,
          height,
          unitsPerEm,
          forceAutohint: (loadFlags & FORCE_AUTOHINT) !== 0,
          yPpem: expect.any(Number),
          color: false,
        });
        const actual = face.shape(codepoints(object.text)).map((g) => {
          const glyph = face.glyph(g.gid)!;
          // 这些字体都是普通灰度字形：框等于位图框（WPE 抓帧里四边形尺寸 = 图集格子尺寸）
          expect(face.box(g.gid)).toEqual(bitmapBox(glyph));
          return [
            g.gid,
            g.cluster,
            g.xAdvance,
            g.yAdvance,
            g.xOffset,
            g.yOffset,
            glyph.width,
            glyph.rows,
            glyph.left,
            glyph.top,
            glyph.mode,
            sha1(glyph.pixels),
          ];
        });
        expect(actual).toEqual(object.glyphs);
        face.dispose();
      });
    }
  });
});
