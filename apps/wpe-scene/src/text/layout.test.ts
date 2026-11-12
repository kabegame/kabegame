/**
 * 排版与图集和 WPE 抓帧逐坐标、逐字节相同（P6b 1c）。
 * - 基线 `fixtures/p6b.json` 由 `apps/wpe-scene/scripts/fixtures/make_text_fixture.py` 从 WPE 2.8.42 的抓帧生成：`p6b-*`
 *   六个静态工程、44 个文本对象、21 张图集。
 * - 要 wasm（`deno task build:wpefont`，kabegame 命令拷进 `src/wpefont/`）与 `KABEGAME_WPE_ROOT`（WPE 安装目录，字体在
 *   `assets/fonts/`）；`systemfont_*` 与回退链读 `%WINDIR%\Fonts`，和抓帧那台机器的字体（文件有无、SHA-256 前 16 位）
 *   不同时跳过这个工程。
 * - 图集按「字体 + 字号」跨对象共享，所以每个工程按场景里的对象顺序整个排一遍，再逐个比对象、比图集。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Wpefont } from "../wpefont";
import { TextAtlases, type GlyphAtlas } from "./atlas";
import { SYSTEM_FONT_PREFIX, TextFonts, type FontPath } from "./fonts";
import fixture from "./fixtures/p6b.json";
import {
  TEXT_DEFAULTS,
  compositeTranslation,
  directTranslation,
  layoutText,
  type TextFields,
  type TextLayout,
  type TextQuad,
} from "./layout";
import { textIndices, textVertices } from "./mesh";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;
const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const f = Math.fround;
/** 和基线一样保留 3 位小数（基线是从 float32 的 MVP 反推的）。 */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

type FixtureObject = (typeof fixture.projects)["p6b-geom"]["objects"][number] & {
  origin?: number[];
  background?: number[];
  rt?: number[];
  rtOrigin?: number[];
  center?: number[];
  size?: number[];
};

/** 基线里规整过的字段（生成脚本已按 WPE 的 JSON 写法转好）→ TextFields。 */
function fieldsOf(object: FixtureObject): TextFields {
  const { origin: _origin, padding, spacing, horizontalalign, verticalalign, ...rest } = object.fields;
  return {
    ...TEXT_DEFAULTS,
    ...rest,
    padding: [padding[0], padding[1]],
    spacing: [spacing[0], spacing[1]],
    horizontalalign: horizontalalign as TextFields["horizontalalign"],
    verticalalign: verticalalign as TextFields["verticalalign"],
  };
}

/** 字形四边形 → 基线的写法：排版坐标的左、下、右、上 + 图集像素的 u0、v0、u1、v1。 */
function quadRows(quads: readonly TextQuad[]): number[][] {
  return quads.map((q) => {
    const { u0, v0, u1, v1, atlas } = q.glyph;
    return [q.x0, q.y0, q.x1, q.y1, u0 * atlas.width, v0 * atlas.height, u1 * atlas.width, v1 * atlas.height];
  });
}

/** 字体读取器：工程字体与 Twemoji 读 WPE 的 assets（p6b 工程不带字体），系统字体读 Fonts 目录并核对抓帧机器上的环境。 */
function reader(mismatched: Set<string>) {
  const expected = fixture.systemFonts as Record<string, string | null>;
  return async (path: FontPath): Promise<Uint8Array | null> => {
    if (path.startsWith(SYSTEM_FONT_PREFIX)) {
      const file = path.slice(SYSTEM_FONT_PREFIX.length);
      const full = join(fontsDir, file);
      const data = existsSync(full) ? readFileSync(full) : null;
      const actual = data ? sha256(data).slice(0, 16) : null;
      if ((expected[file] ?? null) !== actual) mismatched.add(file);
      return data;
    }
    const full = join(root!, "assets", path);
    return existsSync(full) ? readFileSync(full) : null;
  };
}

describe.skipIf(!existsSync(WASM) || !root)("p6b 排版与图集（fixtures/p6b.json）", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const engine = async () => {
    module ??= WebAssembly.compile(readFileSync(WASM));
    return Wpefont.fromModule(await module);
  };

  for (const [name, project] of Object.entries(fixture.projects)) {
    it(name, async (ctx) => {
      const mismatched = new Set<string>();
      const fonts = new TextFonts(await engine(), reader(mismatched));
      const atlases = new TextAtlases();
      const layouts: TextLayout[] = [];
      for (const object of project.objects) {
        const fields = fieldsOf(object as FixtureObject);
        let layout = layoutText(fields, fonts, atlases);
        // 缺的字体读进来再排（每轮最多补一个回退字体）
        for (let round = 0; layout.missingFonts.length && round < 16; round++) {
          await fonts.load(layout.missingFonts);
          layout = layoutText(fields, fonts, atlases);
        }
        expect(layout.missingFonts, object.name).toEqual([]);
        layouts.push(layout);
      }
      if (mismatched.size) ctx.skip(`系统字体和抓帧机器上的不同：${[...mismatched].join(", ")}`);

      // 对象：四边形（排版坐标与 UV）、排版原点在场景 / RT 里的位置、文字框（图层 size、背景）、合成 RT 尺寸
      const atlasOf = new Map<string, GlyphAtlas>();
      const bind = (id: string | null, atlas: GlyphAtlas | null | undefined, what: string) => {
        if (id === null) return;
        expect(atlas, what).toBeTruthy();
        const bound = atlasOf.get(id);
        if (bound) expect(bound === atlas, `${what}：WPE 同一张图集 ${id} 在我们这边是两张`).toBe(true);
        else atlasOf.set(id, atlas!);
      };
      project.objects.forEach((raw, i) => {
        const object = raw as FixtureObject;
        const layout = layouts[i];
        const mesh = layout.mesh!;
        const what = `${name}/${object.name}`;
        expect(mesh, what).not.toBeNull();
        expect(quadRows(mesh.glyphs), `${what} 普通字形`).toEqual(object.glyphs);
        expect(quadRows(mesh.colorGlyphs), `${what} 彩色字形`).toEqual(object.colorGlyphs);
        bind(object.atlas, mesh.atlas, `${what} 主图集`);
        bind(object.colorAtlas, mesh.colorAtlas, `${what} 彩色图集`);
        const [ox, oy] = object.fields.origin;
        const centerX = f(ox + layout.offset[0]);
        const centerY = f(oy + layout.offset[1]);
        if (object.rt) {
          expect(layout.compositeSize, `${what} 合成 RT`).toEqual(object.rt);
          expect(compositeTranslation(layout).map(round3), `${what} RT 里的原点`).toEqual(object.rtOrigin);
          expect([centerX, centerY].map(round3), `${what} 合成四边形中心`).toEqual(object.center);
          expect(layout.size, `${what} 图层 size`).toEqual(object.size);
        } else {
          const [tx, ty] = directTranslation(mesh);
          expect([f(centerX + tx), f(centerY + ty)].map(round3), `${what} 排版原点`).toEqual(object.origin);
          if (object.background) expect(layout.compositeSize, `${what} 背景`).toEqual(object.background);
        }
      });

      // 图集：解码后像素逐字节（SHA-256）
      for (const [id, expected] of Object.entries(project.atlases)) {
        const atlas = atlasOf.get(id);
        expect(atlas, `${name} 图集 ${id} 没有对象用到`).toBeTruthy();
        expect([atlas!.width, atlas!.height], `${name} 图集 ${id} 尺寸`).toEqual(expected.size);
        expect(atlas!.bpp, `${name} 图集 ${id} 格式`).toBe(expected.format === "R8" ? 1 : 4);
        expect(sha256(atlas!.pixels), `${name} 图集 ${id} 像素`).toBe(expected.sha256);
      }
      fonts.dispose();
    });
  }

  it("网格顶点与索引照 WPE 的布局（0c 抓帧的顶点顺序）", async () => {
    const fonts = new TextFonts(await engine(), reader(new Set()));
    const atlases = new TextAtlases();
    const object = fixture.projects["p6b-geom"].objects[0] as FixtureObject;
    const layout = layoutText(fieldsOf(object), fonts, atlases);
    const missing = layout.missingFonts;
    await fonts.load(missing);
    const mesh = layoutText(fieldsOf(object), fonts, atlases).mesh!;
    const vertices = textVertices(mesh.glyphs);
    const [x0, y0, x1, y1, u0, v0, u1, v1] = object.glyphs[0];
    // v0 左上、v1 右上、v2 左下、v3 右下
    expect(Array.from(vertices.subarray(0, 20))).toEqual([
      x0,
      y1,
      0,
      u0 / 512,
      v0 / 512,
      x1,
      y1,
      0,
      u1 / 512,
      v0 / 512,
      x0,
      y0,
      0,
      u0 / 512,
      v1 / 512,
      x1,
      y0,
      0,
      u1 / 512,
      v1 / 512,
    ]);
    expect(Array.from(textIndices(2))).toEqual([0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7]);
    fonts.dispose();
  });

  // 下面两条 p6b 抓帧覆盖不到，只照反编译（FUN_1401ad670、FUN_1401b0410 的 LAB_1401b215d），没有 WPE 真值
  it("照读码：开头的空白不进任何段（不排、不占步进）；行末的空格虽然零尺寸，也把行的右沿撑到它的笔位置", async () => {
    const fonts = new TextFonts(await engine(), reader(new Set()));
    const atlases = new TextAtlases();
    const base = { ...TEXT_DEFAULTS, font: "fonts/RobotoMono-Regular.ttf" };
    const layout = async (text: string) => {
      let result = layoutText({ ...base, text }, fonts, atlases);
      while (result.missingFonts.length) {
        await fonts.load(result.missingFonts);
        result = layoutText({ ...base, text }, fonts, atlases);
      }
      return result.mesh!;
    };
    const plain = await layout("A");
    const leading = await layout("  A");
    expect(quadRows(leading.glyphs)).toEqual(quadRows(plain.glyphs));
    expect(leading.box).toEqual(plain.box);
    const trailing = await layout("A ");
    const advance = f(trailing.glyphs[1].x0); // 空格的框为空，四边形落在它的笔位置上
    expect(trailing.glyphs[1].x1).toBe(advance);
    expect(advance).toBeGreaterThan(plain.box.maxX);
    expect(trailing.box.maxX).toBe(advance);
    fonts.dispose();
  });
});
