/**
 * MSDF 文本的四边形与 WPE 抓帧逐位相同（P6f 点 3 的核对）。
 * - 基线 `fixtures/p6f-quads.json` 取自 `ignore/p6/f0/out/rd/dump.json`：p6f-deco 的 11 个对象（"Ag"，RobotoMono 32 磅 / 12 磅）与 p6f-atlas 的 8 个对象
 *   （轮廓种类、hinting、字号先到先得、回退字体）；每个字形 `[x0, y0, x1, y1, u0, v0, u1, v1]`，位置是 `FUN_1401b0410` 建好、乘矩阵之前的模型空间
 *   坐标（抓帧里顶点按索引展开 `v0 v2 v1 v1 v2 v3`，`v0 = (x0, y1)`、`v3 = (x1, y0)`），UV 是 float32。
 * - 对象的字段照 `ignore/p6/f0/defs/p6f.py`（`p6b.text` 的缺省：maxwidth 500、maxrows 1、padding 32、居中）；图集按对象顺序整个工程共享。
 * - 要 wasm 与 `KABEGAME_WPE_ROOT`；系统字体（a7 的 arial、回退链）读 `%WINDIR%\Fonts`，和抓帧机器不同时位置可能不同，只比不依赖系统字体的对象。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Wpefont } from "../wpefont";
import { TextAtlases } from "./atlas";
import { SYSTEM_FONT_PREFIX, TextFonts, type FontPath } from "./fonts";
import fixture from "./fixtures/p6f-quads.json";
import { textQuadVertices } from "../render/text";
import { TEXT_DEFAULTS, layoutText, type TextFields } from "./layout";
import { textIndices } from "./mesh";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;
const fontsDir = join(process.env.WINDIR ?? "C:\Windows", "Fonts");
const f = Math.fround;

const ROBOTO = "fonts/RobotoMono-Regular.ttf";
const NOTO = "fonts/NotoSans-Regular.ttf";

interface Spec {
  text: string;
  font?: string;
  pointsize?: number;
}

/** p6f-deco：十一个对象都是 "Ag"，只有 d10 是 12 磅。 */
const DECO: Spec[] = Array.from({ length: 11 }, (_, i) => ({ text: "Ag", pointsize: i === 9 ? 12 : 32 }));
/** p6f-atlas 的八个对象（`p6f_atlas`）。 */
const ATLAS: Spec[] = [
  { text: "AVAWay g|O.i@&%" },
  { text: "Hgo", font: NOTO, pointsize: 12 },
  { text: "Hgo xyz", font: NOTO, pointsize: 72 },
  { text: "12:34", font: "fonts/spincycle_3d_ot.otf", pointsize: 36 },
  { text: "Quick 0123", font: "fonts/Atami-Regular.otf", pointsize: 16 },
  { text: "12:34 AM", font: "fonts/opensticks.ttf", pointsize: 16 },
  { text: "xxxx", font: "systemfont_arial" },
  { text: "中文テスト", font: NOTO },
];

function fieldsOf(spec: Spec): TextFields {
  return {
    ...TEXT_DEFAULTS,
    text: spec.text,
    font: spec.font ?? ROBOTO,
    pointsize: spec.pointsize ?? 32,
    padding: [32, 32],
    spacing: [0, 0],
    maxwidth: 500,
    maxrows: 1,
    horizontalalign: "center",
    verticalalign: "center",
    msdf: true,
  };
}

async function readAsset(path: FontPath): Promise<Uint8Array | null> {
  const full = path.startsWith(SYSTEM_FONT_PREFIX)
    ? join(fontsDir, path.slice(SYSTEM_FONT_PREFIX.length))
    : join(root!, "assets", path);
  return existsSync(full) ? readFileSync(full) : null;
}

describe.skipIf(!existsSync(WASM) || !root)("MSDF 四边形与 WPE 抓帧逐位相同（p6f-deco、p6f-atlas）", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const engine = async () => {
    module ??= WebAssembly.compile(readFileSync(WASM));
    return Wpefont.fromModule(await module);
  };

  async function layoutAll(specs: Spec[]) {
    const fonts = new TextFonts(await engine(), readAsset);
    const atlases = new TextAtlases();
    const rows: number[][][] = [];
    for (const spec of specs) {
      const fields = fieldsOf(spec);
      let layout = layoutText(fields, fonts, atlases);
      for (let round = 0; layout.missingFonts.length && round < 16; round++) {
        await fonts.load(layout.missingFonts);
        layout = layoutText(fields, fonts, atlases);
      }
      expect(layout.missingFonts).toEqual([]);
      rows.push(
        layout.mesh!.glyphs.map((q) => [
          q.x0,
          q.y0,
          q.x1,
          q.y1,
          f(q.glyph.u0),
          f(q.glyph.v0),
          f(q.glyph.u1),
          f(q.glyph.v1),
        ]),
      );
    }
    fonts.dispose();
    return rows;
  }

  it("p6f-deco：十一个对象的字形坐标与 UV 逐位相同", async () => {
    const rows = await layoutAll(DECO);
    rows.forEach((row, i) => expect(row, `d${i + 1}`).toEqual(fixture.deco[i]));
  });

  // 前七个对象只用工程 / WPE 自带字体；a7 用系统 arial，a8 回退到系统 CJK 字体，换机器可能不同
  it("p6f-atlas：不依赖系统字体的对象（a1–a6）逐位相同；字号先到先得时别的字号亚像素拉伸也照 WPE", async () => {
    const rows = await layoutAll(ATLAS);
    for (let i = 0; i < 6; i++) expect(rows[i], `a${i + 1}`).toEqual(fixture.atlas[i]);
  });

  it("textQuadVertices 的顶点顺序（v0 左上、v1 右上、v2 左下、v3 右下）展开成抓帧里的 v0 v2 v1 v1 v2 v3", async () => {
    const fonts = new TextFonts(await engine(), readAsset);
    const atlases = new TextAtlases();
    let layout = layoutText(fieldsOf(DECO[0]), fonts, atlases);
    await fonts.load(layout.missingFonts);
    layout = layoutText(fieldsOf(DECO[0]), fonts, atlases);
    const vertices = textQuadVertices(layout.mesh!.glyphs);
    const indices = textIndices(layout.mesh!.glyphs.length);
    // 抓帧的 POSITION 就是按索引展开后的顶点；第一个字形的六个顶点
    const [x0, y0, x1, y1] = fixture.deco[0][0];
    const expanded = Array.from(indices.subarray(0, 6), (i) => vertices[i].position.slice(0, 2));
    expect(expanded).toEqual([
      [x0, y1],
      [x0, y0],
      [x1, y1],
      [x1, y1],
      [x0, y0],
      [x1, y0],
    ]);
    fonts.dispose();
  });
});
