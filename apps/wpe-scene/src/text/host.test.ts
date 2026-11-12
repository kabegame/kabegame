/**
 * 宿主的文本准备（P6b 1d，`text/host.ts` 的 `SceneTexts`）：
 * - 没有文本层时不碰 wasm；wasm 不在时抛 `text:engine`；
 * - 字体读取：主字体按编译期的位置（散文件整读、`scene.pkg` 条目按区间读），`system:` 有 `systemFonts` 表时只查表（查不到为 null、
 *   不回落到目录），没有表时读系统字体目录，回退链的引擎路径读 WPE assets；
 * - 有 wasm 与 `KABEGAME_WPE_ROOT` 时：把 1c 的基线（`fixtures/p6b.json`）的六个工程当 bundle 交给它，排版结果（四边形、尺寸、偏移、
 *   图集）和直接调 `layoutText` 逐项相同；字体字节跨两次加载保留（第二次不读文件），图集每次新建；加载代数变了时返回 null。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneFontFile, SceneText } from "../compile/texts";
import { SceneRenderError } from "../render/errors";
import { Wpefont } from "../wpefont";
import { TextAtlases } from "./atlas";
import fixture from "./fixtures/p6b.json";
import { SYSTEM_FONT_PREFIX, TextFonts } from "./fonts";
import { DEFAULT_SYSTEM_FONTS_DIR, SceneTexts } from "./host";
import { layoutText, TEXT_DEFAULTS, type TextFields, type TextLayout } from "./layout";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;
const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");

/** 一个只有文本表的图层（`SceneTexts` 只读 `object` 与 `text`）。 */
function textLayer(
  object: number,
  fields: Partial<TextFields>,
  font: SceneFontFile,
): Pick<SceneLayer, "object" | "text"> {
  return {
    object,
    text: { fields: { ...TEXT_DEFAULTS, ...fields }, font } as SceneText,
  };
}
const bundleOf = (layers: Pick<SceneLayer, "object" | "text">[]) => ({ layers: layers as SceneLayer[] });

/** 记录读取的读取器：`files` 里有的读内存，其余读磁盘；都没有时抛 `Failed to fetch`（同 `FetchSceneReader`）。 */
function recordingReader(files: Record<string, Uint8Array> = {}) {
  const reads: string[] = [];
  const whole = (path: string) => {
    const key = path.replace(/\\/g, "/");
    if (key in files) return files[key];
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  };
  const reader: SceneReader = {
    async readWhole(path) {
      reads.push(`whole ${path.replace(/\\/g, "/")}`);
      return whole(path);
    },
    async readRange(path, start, end) {
      reads.push(`range ${path.replace(/\\/g, "/")} ${start}-${end}`);
      return whole(path).slice(start, end);
    },
  };
  return { reader, reads };
}

describe("SceneTexts：没有 wasm 也能跑的", () => {
  it("没有文本层：返回空表，不取 wasm", async () => {
    let asked = 0;
    const texts = new SceneTexts({
      reader: recordingReader().reader,
      engine: async () => {
        asked++;
        return null;
      },
    });
    expect(await texts.prepare({ layers: [] }, { sceneAssets: [] })).toEqual(new Map());
    expect(asked).toBe(0);
  });

  it("wasm 不在：抛 text:engine（宿主退回预览图）", async () => {
    const texts = new SceneTexts({ reader: recordingReader().reader, engine: async () => null });
    const layer = textLayer(0, { text: "a" }, { path: "system:arial.ttf", location: null, size: null });
    const error = await texts.prepare(bundleOf([layer]), { sceneAssets: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SceneRenderError);
    expect((error as SceneRenderError).reasons).toEqual(["text:engine"]);
  });

  it("系统字体目录缺省是 C:\\Windows\\Fonts", () => {
    expect(DEFAULT_SYSTEM_FONTS_DIR).toBe("C:\\Windows\\Fonts");
  });
});

describe("SceneTexts：系统字体的读取位置（不排版，直接调读取器）", () => {
  /**
   * `readFont` 与 `sources` 是私有的，平时只在 `prepare` 里排版缺字体时经 `TextFonts.load` 走到，要 wasm；这里不排版，
   * 直接写入这次的来源、取出读取器调，看它读了哪些路径。
   */
  function readerOf(sources: Parameters<SceneTexts["prepare"]>[1]) {
    const { reader, reads } = recordingReader({
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf": new Uint8Array([1]),
      "C:/Windows/Fonts/arial.ttf": new Uint8Array([2]),
      "D:/Win/Fonts/Malgun.ttf": new Uint8Array([3]),
    });
    const texts = new SceneTexts({ reader });
    (texts as unknown as { sources: typeof sources }).sources = sources;
    const read = (path: string) =>
      (texts as unknown as { readFont: (path: string) => Promise<Uint8Array | null> }).readFont(path);
    return { read, reads };
  }

  it("有表：按表读后端解析好的本机文件，键是 system: 后面的名字原样", async () => {
    const { read, reads } = readerOf({
      sceneAssets: [],
      systemFonts: {
        "arial.ttf": "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "Malgun.ttf": "D:\\Win\\Fonts\\Malgun.ttf",
      },
      fontsDir: "E:\\不该用的目录",
    });
    expect(await read(`${SYSTEM_FONT_PREFIX}arial.ttf`)).toEqual(new Uint8Array([1]));
    expect(await read(`${SYSTEM_FONT_PREFIX}Malgun.ttf`)).toEqual(new Uint8Array([3]));
    expect(reads).toEqual([
      "whole /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "whole D:/Win/Fonts/Malgun.ttf",
    ]);
  });

  it("有表：表里没有的名字返回 null，不去读 C:\\Windows\\Fonts 或 fontsDir", async () => {
    const { read, reads } = readerOf({
      sceneAssets: ["W:/assets"],
      systemFonts: { "arial.ttf": "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf" },
    });
    expect(await read(`${SYSTEM_FONT_PREFIX}seguiemj.ttf`)).toBeNull();
    // 名字按原样查，大小写不同算没有；原型链上的名字也不算
    expect(await read(`${SYSTEM_FONT_PREFIX}Arial.ttf`)).toBeNull();
    expect(await read(`${SYSTEM_FONT_PREFIX}toString`)).toBeNull();
    // 空表同样只查表
    const empty = readerOf({ sceneAssets: [], systemFonts: {} });
    expect(await empty.read(`${SYSTEM_FONT_PREFIX}arial.ttf`)).toBeNull();
    expect([...reads, ...empty.reads]).toEqual([]);
  });

  it("没有表：按 fontsDir 拼，缺省 C:\\Windows\\Fonts", async () => {
    const { read, reads } = readerOf({ sceneAssets: [], systemFonts: null });
    expect(await read(`${SYSTEM_FONT_PREFIX}arial.ttf`)).toEqual(new Uint8Array([2]));
    const custom = readerOf({ sceneAssets: [], fontsDir: "D:\\Win\\Fonts" });
    expect(await custom.read(`${SYSTEM_FONT_PREFIX}Malgun.ttf`)).toEqual(new Uint8Array([3]));
    expect([...reads, ...custom.reads]).toEqual(["whole C:/Windows/Fonts/arial.ttf", "whole D:/Win/Fonts/Malgun.ttf"]);
  });
});

type FixtureObject = (typeof fixture.projects)["p6b-geom"]["objects"][number];

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

/** 排版结果里能比的部分：四边形（排版坐标 + 图集像素格子）、尺寸、偏移。 */
function summary(layout: TextLayout) {
  const quads = (list: NonNullable<TextLayout["mesh"]>["glyphs"]) =>
    list.map((q) => [q.x0, q.y0, q.x1, q.y1, q.glyph.x0, q.glyph.y0, q.glyph.x1, q.glyph.y1]);
  return {
    glyphs: layout.mesh ? quads(layout.mesh.glyphs) : null,
    colorGlyphs: layout.mesh ? quads(layout.mesh.colorGlyphs) : null,
    size: layout.size,
    compositeSize: layout.compositeSize,
    offset: layout.offset,
  };
}

describe.skipIf(!existsSync(WASM) || !root)("SceneTexts：p6b 基线（真 wasm）", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const engine = async () => Wpefont.fromModule(await (module ??= WebAssembly.compile(readFileSync(WASM))));
  const assets = root ? join(root, "assets") : "";
  /** 工程的字体都在 WPE assets（p6b 工程不带字体）：编译期会定位到 `<assets>/<路径>` 的散文件。 */
  const fontOf = (font: string): SceneFontFile =>
    font.startsWith("systemfont_")
      ? { path: `system:${{ systemfont_arial: "arial.ttf" }[font] ?? font}`, location: null, size: null }
      : { path: font, location: { path: join(assets, font), offset: 0 }, size: null };

  // 两边读同一组字体文件、不和抓帧比，不用核对系统字体的版本
  for (const [name, project] of Object.entries(fixture.projects)) {
    it(`${name}：和直接排版逐项相同（四边形、尺寸、偏移、图集共享）`, async () => {
      const objects = project.objects as FixtureObject[];
      const layers = objects.map((object, i) => textLayer(i * 2, fieldsOf(object), fontOf(object.fields.font)));
      const { reader, reads } = recordingReader();
      const texts = new SceneTexts({ reader, engine });
      const layouts = (await texts.prepare(bundleOf(layers), { sceneAssets: [assets], fontsDir }))!;
      expect([...layouts.keys()]).toEqual(layers.map((layer) => layer.object));
      // 对照：1c 的写法（同一组字体、新图集，按对象顺序排）
      const fonts = new TextFonts(await engine(), async (path) => {
        const full = path.startsWith(SYSTEM_FONT_PREFIX)
          ? join(fontsDir, path.slice(SYSTEM_FONT_PREFIX.length))
          : join(assets, path);
        return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
      });
      const atlases = new TextAtlases();
      const direct: TextLayout[] = [];
      for (const object of objects) {
        let layout = layoutText(fieldsOf(object), fonts, atlases);
        for (let round = 0; layout.missingFonts.length && round < 16; round++) {
          await fonts.load(layout.missingFonts);
          layout = layoutText(fieldsOf(object), fonts, atlases);
        }
        direct.push(layout);
      }
      // 全部排完再比（图集按字体共享，排到一半时后面对象的字形还没进去）；图集比像素的哈希，不让大数组进断言
      const hash = (pixels: Uint8Array) => createHash("sha256").update(pixels).digest("hex");
      objects.forEach((object, i) => {
        const ours = layouts.get(layers[i].object)!;
        expect(summary(ours), `${name}/${object.name}`).toEqual(summary(direct[i]));
        expect(hash(ours.mesh!.atlas.pixels), `${name}/${object.name} 图集`).toBe(hash(direct[i].mesh!.atlas.pixels));
      });
      // 同一字体 + 字号的对象共用一张图集（同 WPE）
      const atlasOf = (i: number) => layouts.get(layers[i].object)!.mesh!.atlas;
      objects.forEach((object, i) =>
        objects.forEach((other, j) => {
          const same = object.atlas === other.atlas;
          expect(atlasOf(i) === atlasOf(j), `${object.name} / ${other.name}`).toBe(same);
        }),
      );
      // 字体读取：系统字体读字体目录，工程（assets）字体整读，Twemoji 只在回退链用到时读 assets
      expect(reads.every((line) => line.startsWith("whole "))).toBe(true);
      if (name === "p6b-fallback")
        expect(reads).toContain(`whole ${join(assets, "fonts/TwemojiMozilla.ttf").replace(/\\/g, "/")}`);

      // 第二次加载：字体字节保留，不再读文件；图集是新的
      reads.length = 0;
      const again = (await texts.prepare(bundleOf(layers), { sceneAssets: [assets], fontsDir }))!;
      expect(reads).toEqual([]);
      // 比布尔值：`not.toBe` 落空时 vitest 会对两张图集做深比较（找 toEqual 的提示），图集带 256 KiB 的像素与环引用，很慢
      expect(again.get(layers[0].object)!.mesh!.atlas === atlasOf(0)).toBe(false);
      expect(summary(again.get(layers[0].object)!)).toEqual(summary(layouts.get(layers[0].object)!));
      texts.dispose();
      fonts.dispose();
    });
  }

  it("scene.pkg 里的主字体按区间读；读完之前代数变了返回 null", async () => {
    const font = readFileSync(join(assets, "fonts/RobotoMono-Regular.ttf"));
    const pkg = new Uint8Array(100 + font.length + 7);
    pkg.set(font, 100);
    const { reader, reads } = recordingReader({ "P:/p/scene.pkg": pkg });
    const layer = textLayer(
      0,
      { text: "Ag", font: "fonts/packed.ttf" },
      { path: "fonts/packed.ttf", location: { path: "P:/p/scene.pkg", offset: 100 }, size: font.length },
    );
    const texts = new SceneTexts({ reader, engine });
    const layouts = (await texts.prepare(bundleOf([layer]), { sceneAssets: [assets], fontsDir }))!;
    expect(reads).toEqual([`range P:/p/scene.pkg 100-${100 + font.length}`]);
    expect(layouts.get(0)!.mesh!.glyphs.length).toBe(2);
    // 新的一个宿主：第一次读字体的 await 之后就被取代
    const fresh = new SceneTexts({ reader, engine });
    let generation = 0;
    const pending = fresh.prepare(bundleOf([layer]), { sceneAssets: [assets] }, () => generation !== 0);
    generation++;
    expect(await pending).toBeNull();
    texts.dispose();
    fresh.dispose();
  });
});
