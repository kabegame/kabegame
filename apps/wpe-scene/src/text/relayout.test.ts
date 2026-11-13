/**
 * P6b 1e-2 的排版侧单测（`.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1e」点 3）：
 * - `releaseTextLayout` / `retainTextLayout` 互为反操作、都可重复调用；
 * - `GlyphAtlas.resets`：到 4096 清空重排时加一（渲染器据此把用这张图集的层全部重排）；
 * - 有 wasm 与 `KABEGAME_WPE_ROOT` 时，`SceneTexts` 的重排器：排进这次加载的图集、先放旧引用再排；缺字体时返回 null、旧排版的引用复原、
 *   后台读完调 `onReady`；更新的加载开始或 `dispose` 之后旧重排器不再动图集、读完字体的回调丢掉。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneText } from "../compile/texts";
import { PIXEL_MODE_GRAY, Wpefont } from "../wpefont";
import { GlyphAtlas, type AtlasGlyph } from "./atlas";
import { SceneTexts } from "./host";
import { releaseTextLayout, retainTextLayout, TEXT_DEFAULTS, type TextFields, type TextLayout } from "./layout";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;
const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");

/** 一份只有引用表的排版（不排字，只测引用计数）。 */
function layoutWith(glyphs: AtlasGlyph[]): TextLayout {
  return {
    missingFonts: [],
    mesh: {
      key: "k",
      glyphs: [],
      colorGlyphs: [],
      atlas: glyphs[0].atlas,
      colorAtlas: null,
      box: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      lineHeight: 1,
      rows: 1,
      pointsize: 32,
      refs: glyphs,
    },
    padding: [0, 0],
    size: [1, 1],
    compositeSize: [1, 1],
    offset: [0, 0],
  };
}

function insert(atlas: GlyphAtlas, key: number, width: number): AtlasGlyph {
  const glyph = atlas.insert(key, key, {
    width,
    rows: 8,
    left: 0,
    top: 8,
    mode: PIXEL_MODE_GRAY,
    color: false,
    pixels: new Uint8Array(width * 8).fill(7),
  });
  if ("full" in glyph) throw new Error("图集满");
  return glyph;
}

describe("releaseTextLayout / retainTextLayout（P6b 1e）", () => {
  it("释放减引用、复原加回去，各自重复调用无害；空排版什么都不做", () => {
    const atlas = new GlyphAtlas(false);
    const a = insert(atlas, 1, 4);
    const b = insert(atlas, 2, 4);
    a.refs = 1;
    b.refs = 2;
    const layout = layoutWith([a, b]);
    releaseTextLayout(layout);
    releaseTextLayout(layout);
    expect([a.refs, b.refs, layout.mesh!.released]).toEqual([0, 1, true]);
    // 列表不清：复原时知道加回哪些
    expect(layout.mesh!.refs).toHaveLength(2);
    retainTextLayout(layout);
    retainTextLayout(layout);
    expect([a.refs, b.refs, layout.mesh!.released]).toEqual([1, 2, false]);
    const empty: TextLayout = { ...layout, mesh: null };
    releaseTextLayout(empty);
    retainTextLayout(empty);
    expect([a.refs, b.refs]).toEqual([1, 2]);
  });
});

describe("GlyphAtlas.resets（P6b 1e 已定 5）", () => {
  it("清空重排时加一；扩容、放字形不算", () => {
    const atlas = new GlyphAtlas(false);
    insert(atlas, 1, 4);
    insert(atlas, 2, 600);
    expect([atlas.width, atlas.generation, atlas.resets]).toEqual([1024, 1, 0]);
    atlas.resetForRelayout();
    atlas.resetForRelayout();
    expect(atlas.resets).toBe(2);
  });
});

/** 一个只有文本表的图层（`SceneTexts` 只读 `object` 与 `text`），主字体是 arial（`system:`）。 */
function arialLayer(object: number, text: string): Pick<SceneLayer, "object" | "text"> {
  return {
    object,
    text: {
      fields: { ...TEXT_DEFAULTS, text, font: "systemfont_arial" },
      font: { path: "system:arial.ttf", location: null, size: null },
    } as SceneText,
  };
}
const bundleOf = (layers: Pick<SceneLayer, "object" | "text">[]) => ({ layers: layers as SceneLayer[] });

/** 读磁盘的读取器；`gate` 给出时，`seguiemj.ttf` 要等它放行才返回，`released` 在读完返回之后兑现。 */
function diskReader(gate?: Promise<void>) {
  let markRead!: () => void;
  const released = new Promise<void>((resolve) => (markRead = resolve));
  const whole = async (path: string) => {
    const gated = /seguiemj\.ttf$/i.test(path);
    if (gated && gate) await gate;
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    } finally {
      if (gated) markRead();
    }
  };
  const reader: SceneReader = {
    readWhole: whole,
    async readRange(path, start, end) {
      return (await whole(path)).slice(start, end);
    },
  };
  return { reader, released };
}

/** 让读完字体之后的微任务链（`TextFonts.load` → 重排器的回调）都跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 一份排版引用的字形各自的引用数。 */
const refCounts = (layout: TextLayout) => layout.mesh!.refs.map((glyph) => glyph.refs);

describe.skipIf(!existsSync(WASM) || !root)("SceneTexts 的重排器（P6b 1e，真 wasm）", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const engine = async () => Wpefont.fromModule(await (module ??= WebAssembly.compile(readFileSync(WASM))));
  const assets = root ? join(root, "assets") : "";
  const sources = { sceneAssets: [assets], fontsDir };
  const fieldsOf = (text: string): TextFields => ({ ...TEXT_DEFAULTS, text, font: "systemfont_arial" });

  it("prepare 之前没有重排器；排进这次加载的图集，先放旧引用再排（只被旧文字用的字形归 0）", async () => {
    const texts = new SceneTexts({ reader: diskReader().reader, engine });
    expect(texts.relayouter()).toBeNull();
    const prepared = (await texts.prepare(bundleOf([arialLayer(0, "AB")]), sources))!;
    const relayouter = texts.relayouter()!;
    const previous = prepared.get(0)!;
    const [a, b] = previous.mesh!.glyphs.map((quad) => quad.glyph);
    expect([a.refs, b.refs]).toEqual([1, 1]);
    const next = relayouter.relayout(0, fieldsOf("BC"), previous)!;
    expect(next.mesh!.glyphs).toHaveLength(2);
    expect(next.mesh!.atlas === previous.mesh!.atlas).toBe(true);
    expect([a.refs, b.refs, next.mesh!.glyphs[1].glyph.refs]).toEqual([0, 1, 1]);
    expect(previous.mesh!.released).toBe(true);
    texts.dispose();
  });

  it("缺字体：返回 null、旧排版的引用复原、图集不动；后台读完调 onReady，再排一轮缺一个，排成后是新文字", async () => {
    const ready: number[] = [];
    const texts = new SceneTexts({ reader: diskReader().reader, engine, onReady: (object) => ready.push(object) });
    const previous = (await texts.prepare(bundleOf([arialLayer(3, "A")]), sources))!.get(3)!;
    const relayouter = texts.relayouter()!;
    const atlas = previous.mesh!.atlas;
    const glyphs = atlas.glyphs.size;
    expect(relayouter.relayout(3, fieldsOf("A中"), previous)).toBeNull();
    expect([refCounts(previous), previous.mesh!.released, atlas.glyphs.size]).toEqual([[1], false, glyphs]);
    // 中文沿回退链（seguiemj → arialuni → segoeui → Twemoji → seguisym → msyh），每轮读进一个；轮数有上限，不会一直等
    let layout: TextLayout | null = null;
    for (let round = 0; round < 12 && !layout; round++) {
      await vi.waitFor(() => expect(ready).toHaveLength(round + 1), { timeout: 5000, interval: 10 });
      expect(ready[round]).toBe(3);
      layout = relayouter.relayout(3, fieldsOf("A中"), previous);
    }
    expect(layout).not.toBeNull();
    expect(layout!.mesh!.glyphs.length + layout!.mesh!.colorGlyphs.length).toBe(2);
    expect(previous.mesh!.released).toBe(true);
    texts.dispose();
  });

  it("过期：更新的加载开始后旧重排器返回 null、不动图集与引用，读完字体的回调丢掉；dispose 之后同样", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { reader, released } = diskReader(gate);
    const ready: number[] = [];
    const texts = new SceneTexts({ reader, engine, onReady: (object) => ready.push(object) });
    const previous = (await texts.prepare(bundleOf([arialLayer(0, "A")]), sources))!.get(0)!;
    const stale = texts.relayouter()!;
    // 缺 seguiemj：读取卡在闸门上
    expect(stale.relayout(0, fieldsOf("A中"), previous)).toBeNull();
    // 更新的加载开始（同一张场景重编译）：旧重排器过期
    await texts.prepare(bundleOf([arialLayer(0, "A")]), sources);
    const atlas = previous.mesh!.atlas;
    const glyphs = atlas.glyphs.size;
    expect(stale.relayout(0, fieldsOf("B"), previous)).toBeNull();
    expect([atlas.glyphs.size, refCounts(previous), previous.mesh!.released]).toEqual([glyphs, [1], false]);
    open();
    await released;
    await settle();
    expect(ready).toEqual([]);

    // dispose：之后没有重排器，旧的返回 null，读完的回调丢掉
    let open2!: () => void;
    const gate2 = new Promise<void>((resolve) => (open2 = resolve));
    const second = diskReader(gate2);
    const other = new SceneTexts({ reader: second.reader, engine, onReady: (object) => ready.push(object) });
    const kept = (await other.prepare(bundleOf([arialLayer(1, "A")]), sources))!.get(1)!;
    const relayouter = other.relayouter()!;
    expect(relayouter.relayout(1, fieldsOf("A中"), kept)).toBeNull();
    other.dispose();
    expect(other.relayouter()).toBeNull();
    expect(relayouter.relayout(1, fieldsOf("B"), kept)).toBeNull();
    open2();
    await second.released;
    await settle();
    expect(ready).toEqual([]);
    texts.dispose();
  });
});
