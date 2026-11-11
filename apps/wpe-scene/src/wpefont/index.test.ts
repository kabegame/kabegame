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

/** cbox（`FT_GLYPH_BBOX_PIXELS`）就是位图框：字形已经栅格化，取到的是位图字形的框。 */
function expectCboxIsBitmapBox(glyph: GlyphBitmap) {
  expect(glyph.cbox).toEqual({
    xMin: glyph.left,
    yMin: glyph.top - glyph.rows,
    xMax: glyph.left + glyph.width,
    yMax: glyph.top,
  });
}

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
      expectCboxIsBitmapBox(h);

      // 空格：零尺寸位图
      const space = face.glyph(shaped[2].gid)!;
      expect([space.width, space.rows, space.pixels.length]).toEqual([0, 0, 0]);
      expectCboxIsBitmapBox(space);

      expect(face.glyph(0x7fffffff)).toBeNull(); // gid 越界

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
      expect(glyph.pixels.length).toBe(4 * glyph.width * glyph.rows);
      expectCboxIsBitmapBox(glyph);
      face.dispose();
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
        });
        const actual = face.shape(codepoints(object.text)).map((g) => {
          const glyph = face.glyph(g.gid)!;
          expectCboxIsBitmapBox(glyph);
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
