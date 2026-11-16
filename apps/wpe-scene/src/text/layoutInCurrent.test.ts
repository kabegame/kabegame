/**
 * L3b 点 3：`SceneTexts.layoutInCurrent` / `releaseLayout` / `retainLayout`（`.claude/plans/wpe-import/3-scene/live/phase-l3b-host-subsystems.md`）。
 * 字体与 wasm 都桩掉（排版函数与 `TextFonts` 换替身），只验调度：
 * - 排进当前加载的图集（和 `prepare` 同一套）；缺字体读完再排，每轮至少读一次；
 * - 代数过期（更新的加载开始、`dispose`）返回 null、不动图集；读字体的 await 期间过期同样返回 null；
 * - `prepare` 在跑时没有「当前加载」，返回 null；场景加载时没有文本层、没排过时为当前代数开一套新图集；
 * - 排版出错抛 `SceneRenderError(["text:engine"])`；不是文本层返回 null；
 * - `releaseLayout` / `retainLayout` 是 `releaseTextLayout` / `retainTextLayout` 的转接。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { SceneText } from "../compile/texts";
import type { SceneReader } from "../compile/fs";
import { SceneRenderError } from "../render/errors";
import type { Wpefont } from "../wpefont";
import type { TextAtlases } from "./atlas";
import type { TextFields, TextLayout } from "./layout";

const stubs = vi.hoisted(() => ({
  /** `layoutText` 的返回队列：每次调用取一个，空了取最后一个；元素 `Error` 当抛错 */
  results: [] as (string[] | Error)[],
  /** 每次 `layoutText` 收到的图集 */
  atlases: [] as unknown[],
  loads: [] as string[][],
  /** 设了就让 `TextFonts.load` 等它 */
  gate: null as Promise<void> | null,
}));

vi.mock("./layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout")>();
  return {
    ...actual,
    layoutText: (fields: { text: string }, _fonts: unknown, atlases: unknown): TextLayout => {
      stubs.atlases.push(atlases);
      const next = stubs.results.length > 1 ? stubs.results.shift()! : stubs.results[0];
      if (next instanceof Error) throw next;
      return {
        missingFonts: next ?? [],
        mesh: null,
        padding: [0, 0],
        size: [fields.text.length, 1],
        compositeSize: [1, 1],
        offset: [0, 0],
      };
    },
  };
});
vi.mock("./fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fonts")>();
  return {
    ...actual,
    TextFonts: class {
      async load(paths: string[]): Promise<void> {
        stubs.loads.push([...paths]);
        if (stubs.gate) await stubs.gate;
      }
      dispose(): void {}
    },
  };
});

const { SceneTexts } = await import("./host");

const reader: SceneReader = {
  async readWhole() {
    throw new TypeError("Failed to fetch");
  },
  async readRange() {
    throw new TypeError("Failed to fetch");
  },
};
const engine = async () => ({}) as Wpefont;

function textLayer(object: number, text: string): SceneLayer {
  return {
    object,
    text: {
      fields: { text } as unknown as TextFields,
      font: { path: "system:arial.ttf", location: null, size: null },
    } as unknown as SceneText,
  } as unknown as SceneLayer;
}
const bundleOf = (layers: SceneLayer[]) => ({ layers });

function reset(results: (string[] | Error)[] = [[]]): void {
  stubs.results = results;
  stubs.atlases.length = 0;
  stubs.loads.length = 0;
  stubs.gate = null;
}

describe("SceneTexts.layoutInCurrent（L3b）", () => {
  it("排进当前加载的图集（和 prepare 同一套），结果交调用方", async () => {
    reset();
    const texts = new SceneTexts({ reader, engine });
    const prepared = await texts.prepare(bundleOf([textLayer(0, "ab")]), { sceneAssets: [] });
    expect(prepared!.get(0)!.size).toEqual([2, 1]);
    const layout = await texts.layoutInCurrent(textLayer(1, "abc"));
    expect(layout!.size).toEqual([3, 1]);
    // 两次排版用的是同一套图集
    expect(stubs.atlases).toHaveLength(2);
    expect(stubs.atlases[1]).toBe(stubs.atlases[0]);
  });

  it("缺字体：读完再排，每轮读一次；不是文本层返回 null", async () => {
    reset([["fonts/a.ttf"], ["fonts/b.ttf"], []]);
    const texts = new SceneTexts({ reader, engine });
    await texts.prepare(bundleOf([]), { sceneAssets: [] });
    const layout = await texts.layoutInCurrent(textLayer(0, "x"));
    expect(layout).not.toBeNull();
    expect(stubs.loads).toEqual([["fonts/a.ttf"], ["fonts/b.ttf"]]);
    expect(await texts.layoutInCurrent({ object: 2 } as SceneLayer)).toBeNull();
  });

  it("过期：更新的加载开始（prepare 加了代数）、dispose 之后返回 null，不动图集", async () => {
    reset();
    const texts = new SceneTexts({ reader, engine });
    await texts.prepare(bundleOf([textLayer(0, "a")]), { sceneAssets: [] });
    const before = stubs.atlases.length;
    // 读字体的 await 期间有更新的加载：当次排版返回 null
    reset([["fonts/a.ttf"], []]);
    let release!: () => void;
    stubs.gate = new Promise<void>((resolve) => (release = resolve));
    const pending = texts.layoutInCurrent(textLayer(1, "b"));
    await Promise.resolve();
    const next = texts.prepare(bundleOf([]), { sceneAssets: [] });
    release();
    expect(await pending).toBeNull();
    await next;
    // 只排过缺字体的那一次（第二次因为过期没排）
    expect(stubs.atlases).toHaveLength(1);
    expect(before).toBe(1);
    // dispose 之后同样 null
    texts.dispose();
    stubs.gate = null;
    expect(await texts.layoutInCurrent(textLayer(2, "c"))).toBeNull();
  });

  it("prepare 在跑时没有当前加载：返回 null；跑完（没有文本层）后为当前代数开新图集", async () => {
    reset();
    const texts = new SceneTexts({ reader, engine });
    const running = texts.prepare(bundleOf([textLayer(0, "a")]), { sceneAssets: [] });
    expect(await texts.layoutInCurrent(textLayer(1, "b"))).toBeNull();
    await running;
    reset();
    const bare = new SceneTexts({ reader, engine });
    await bare.prepare(bundleOf([]), { sceneAssets: [] });
    const first = await bare.layoutInCurrent(textLayer(0, "a"));
    const second = await bare.layoutInCurrent(textLayer(1, "bb"));
    expect([first!.size, second!.size]).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(stubs.atlases[1]).toBe(stubs.atlases[0]);
    expect((stubs.atlases[0] as TextAtlases).all).toBeTypeOf("function");
  });

  it("排版出错抛 text:engine", async () => {
    reset([new Error("wasm 坏了")]);
    const warn = vi.fn();
    const texts = new SceneTexts({ reader, engine, report: { warn, debug: vi.fn() } });
    await texts.prepare(bundleOf([]), { sceneAssets: [] });
    await expect(texts.layoutInCurrent(textLayer(0, "a"))).rejects.toBeInstanceOf(SceneRenderError);
    expect(warn).toHaveBeenCalled();
  });

  it("releaseLayout / retainLayout 转接引用计数，重复调用无害", () => {
    const refs = { value: 1 };
    const glyph = { refs: 1 };
    const layout = { mesh: { refs: [glyph], released: false } } as unknown as TextLayout;
    const texts = new SceneTexts({ reader, engine });
    texts.releaseLayout(layout);
    texts.releaseLayout(layout);
    expect(glyph.refs).toBe(0);
    texts.retainLayout(layout);
    texts.retainLayout(layout);
    expect(glyph.refs).toBe(refs.value);
  });
});
