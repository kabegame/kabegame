/**
 * 字体位置、face 列表与回退、分段（照 `FUN_1401ad670`）。要 wasm 与 `KABEGAME_WPE_ROOT`；系统字体一律当作读不到，
 * 回退链只剩 WPE 自带的 `fonts/TwemojiMozilla.ttf`，所以不依赖本机字体。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Wpefont } from "../wpefont";
import {
  FALLBACK_CHAIN,
  SYSTEM_FONT_PREFIX,
  TextFonts,
  clampPointsize,
  fontKey,
  fontPath,
  type FontPath,
} from "./fonts";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;

describe("字体位置", () => {
  it("systemfont_* 查表，其余原样；字号 float32 钳到 [1, 256]；字体键带 26.6 字号", () => {
    expect(fontPath("systemfont_cambria")).toBe("system:cambria.ttc");
    expect(fontPath("systemfont_sansserif")).toBe("system:micross.ttf");
    expect(fontPath("systemfont_nope")).toBe("systemfont_nope");
    expect(fontPath("fonts/A.otf")).toBe("fonts/A.otf");
    expect([clampPointsize(0.5), clampPointsize(300), clampPointsize(12.3), clampPointsize(NaN)]).toEqual([
      1,
      256,
      Math.fround(12.3),
      1,
    ]);
    expect(fontKey("fonts/A.otf", Math.fround(12.3))).toBe("fonts/A.otf_787");
    expect(FALLBACK_CHAIN.filter((p) => !p.startsWith(SYSTEM_FONT_PREFIX))).toEqual(["fonts/TwemojiMozilla.ttf"]);
  });
});

describe.skipIf(!existsSync(WASM) || !root)("face 列表与分段", () => {
  const load = async () => Wpefont.fromBytes(readFileSync(WASM));
  /** 系统字体读不到，其余读 WPE 的 assets；记下读了哪些。 */
  const reader = (reads: FontPath[]) => async (path: FontPath) => {
    reads.push(path);
    if (path.startsWith(SYSTEM_FONT_PREFIX)) return null;
    const full = join(root!, "assets", path);
    return existsSync(full) ? readFileSync(full) : null;
  };

  it("缺字体时记缺、不推进回退链，读完再查；回退字体按链的顺序追加", async () => {
    const reads: FontPath[] = [];
    const fonts = new TextFonts(await load(), reader(reads));
    const missing = new Set<FontPath>();
    expect(fonts.faceList("fonts/RobotoMono-Regular.ttf", 32, missing)).toBeUndefined();
    expect([...missing]).toEqual(["fonts/RobotoMono-Regular.ttf"]);
    await fonts.load(missing);
    missing.clear();
    const list = fonts.faceList("fonts/RobotoMono-Regular.ttf", 32, missing)!;
    expect(list.faces.map((f) => f.path)).toEqual(["fonts/RobotoMono-Regular.ttf"]);
    expect(fonts.lookup(list, 0x41, missing)).toBe(0);

    // 😀：主字体没有，沿回退链一项一项读（系统字体都读不到），读到 Twemoji
    let found: number | undefined;
    for (let round = 0; round < 10; round++) {
      missing.clear();
      found = fonts.lookup(list, 0x1f600, missing);
      if (found !== undefined) break;
      expect(missing.size).toBe(1);
      await fonts.load(missing);
    }
    expect(found).toBe(1);
    expect(list.faces.map((f) => f.path)).toEqual(["fonts/RobotoMono-Regular.ttf", "fonts/TwemojiMozilla.ttf"]);
    expect(list.chainNext).toBe(5);
    // 哪个都没有：试完整条链，返回 -1；试过的不再试
    missing.clear();
    for (let round = 0; round < 10 && fonts.lookup(list, 0x10fffd, missing) === undefined; round++) {
      await fonts.load(missing);
      missing.clear();
    }
    expect(fonts.lookup(list, 0x10fffd, missing)).toBe(-1);
    expect(list.chainNext).toBe(FALLBACK_CHAIN.length);
    expect(new Set(reads).size).toBe(reads.length); // 每个文件只读一次
    fonts.dispose();
  });

  it("分段：换 face 才切段；空白与 ZWJ 不切；开头的空白不进任何段；哪个都没有的码点留在当前段", async () => {
    const fonts = new TextFonts(await load(), reader([]));
    await fonts.load(["fonts/RobotoMono-Regular.ttf", ...FALLBACK_CHAIN]);
    const missing = new Set<FontPath>();
    const list = fonts.faceList("fonts/RobotoMono-Regular.ttf", 32, missing)!;
    const text = Array.from(" A\u{1f600} ‍B\u{10fffd}C", (ch) => ch.codePointAt(0)!);
    const runs = fonts.segment(list, text, missing)!;
    expect(missing.size).toBe(0);
    expect(runs).toEqual([
      { start: 1, text: [0x41], faceIndex: 0 },
      { start: 2, text: [0x1f600, 0x20, 0x200d], faceIndex: 1 },
      { start: 5, text: [0x42, 0x10fffd, 0x43], faceIndex: 0 },
    ]);
    // 全是找不到的码点：没有段
    expect(fonts.segment(list, [0x10fffd, 0x10fffd], missing)).toEqual([]);
    fonts.dispose();
  });

  it("主字体读不到时换成 arial；arial 也读不到时没有 face 列表", async () => {
    const fonts = new TextFonts(await load(), reader([]));
    const missing = new Set<FontPath>();
    expect(fonts.faceList("fonts/none.ttf", 32, missing)).toBeUndefined();
    await fonts.load(missing);
    missing.clear();
    expect(fonts.faceList("fonts/none.ttf", 32, missing)).toBeUndefined();
    expect([...missing]).toEqual(["system:arial.ttf"]);
    await fonts.load(missing);
    missing.clear();
    expect(fonts.faceList("fonts/none.ttf", 32, missing)).toBeNull();
    fonts.dispose();
  });
});
