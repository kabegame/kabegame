/**
 * P6b 1e-3：dev 探针回放前结清运行中重排（`probeTexts.ts` 的 `settleTexts` / `ProbeTexts.settle`）。
 * - 假重排器：缺字体一轮 → 等读完 → 标脏再 `sync` 后排成；不缺字体时一次 `sync`；一直有在读的时读满上限抛错；
 * - 没有文本层时 `settle` 返回 0、不调 `sync`；
 * - 有 wasm 与 `KABEGAME_WPE_ROOT` 时，真 `SceneTexts` 经 `prepareProbeTexts`：把文字从「A」换成「A中」，沿回退链逐轮读字体，结清后
 *   排出两个字形（`onReady` → 下一轮 `touchText` 的接线）。
 * 没有文本值时 `renderFrame` 不调 `settle`（`wroteTextValues`，见 `scriptValues.test.ts`）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneText } from "../compile/texts";
import { MAX_FONT_ROUNDS } from "../text/host";
import { TEXT_DEFAULTS, type TextFields, type TextLayout } from "../text/layout";
import { prepareProbeTexts, settleTexts } from "./probeTexts";

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;

// 真 wasm 的用例：`prepareProbeTexts` 不收引擎，换掉 `loadWpefont`，用 Node 里编好的实例（同 `text/relayout.test.ts`）
vi.mock("../wpefont", async (original) => {
  const actual = await original<typeof import("../wpefont")>();
  let module: Promise<WebAssembly.Module> | null = null;
  return {
    ...actual,
    loadWpefont: async () => actual.Wpefont.fromModule(await (module ??= WebAssembly.compile(readFileSync(WASM)))),
  };
});

/** 假的状态：`touchText` 把文本层标脏，`dirty` 是还没被 `sync` 取走的。 */
interface FakeState {
  dirty: Set<number>;
  fields: Map<number, string>;
  touchText(object: number): void;
}
function fakeState(fields: Record<number, string>, dirty: number[]): FakeState {
  const state: FakeState = {
    dirty: new Set(dirty),
    fields: new Map(Object.entries(fields).map(([object, text]) => [Number(object), text])),
    touchText: (object) => void (state.fields.has(object) && state.dirty.add(object)),
  };
  return state;
}

/**
 * 假的重排器 + 场景：字体没读进来时重排返回 null、发起一次读取（`gate` 放行后读完，记进 `ready`，同 `SceneTexts` 的 `onReady`）；
 * `sync` 对脏的文本层重排，排成的记进 `layouts`。`idle()` 同 `SceneTexts.idle`。
 */
function fakeTexts(loaded = false) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const texts = {
    loaded,
    reading: null as Promise<void> | null,
    ready: new Set<number>(),
    layouts: new Map<number, string>(),
    syncs: 0,
    relayouts: 0,
    open,
    async idle() {
      if (!texts.reading) return false;
      await texts.reading;
      return true;
    },
  };
  const relayout = (object: number, text: string): string | null => {
    texts.relayouts++;
    if (texts.loaded) return `layout:${text}`;
    texts.reading ??= gate.then(() => {
      texts.loaded = true;
      texts.reading = null;
      texts.ready.add(object);
    });
    return null;
  };
  const scene = {
    sync(state: FakeState) {
      texts.syncs++;
      for (const object of state.dirty) {
        const layout = relayout(object, state.fields.get(object)!);
        if (layout) texts.layouts.set(object, layout);
      }
      state.dirty.clear();
    },
  };
  return { texts, scene };
}

describe("settleTexts（P6b 1e-3）", () => {
  it("缺字体：第一次 sync 没排成、等读完，下一轮把那一层标脏再 sync 后排成；返回 sync 的次数", async () => {
    const { texts, scene } = fakeTexts();
    const state = fakeState({ 0: "F183", 1: "static" }, [0]);
    const settled = settleTexts(texts, texts.ready, scene, state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 卡在等字体上：只 sync 了一次、还没排成
    expect([texts.syncs, texts.layouts.size]).toEqual([1, 0]);
    texts.open();
    expect(await settled).toBe(2);
    expect([...texts.layouts]).toEqual([[0, "layout:F183"]]);
    // 只重排了脏的那一层，两次
    expect(texts.relayouts).toBe(2);
    expect(texts.ready.size).toBe(0);
  });

  it("字体都在：一次 sync 就结清", async () => {
    const { texts, scene } = fakeTexts(true);
    const state = fakeState({ 0: "12:34" }, [0]);
    expect(await settleTexts(texts, texts.ready, scene, state)).toBe(1);
    expect(texts.layouts.get(0)).toBe("layout:12:34");
  });

  it("一直有在读的：读满 MAX_FONT_ROUNDS 轮后，第 MAX_FONT_ROUNDS + 1 次 sync 之后仍在读就抛错", async () => {
    const sync = vi.fn();
    const owner = { idle: vi.fn(async () => true) };
    await expect(settleTexts(owner, new Set([3]), { sync }, fakeState({ 3: "x" }, []))).rejects.toThrow(
      new RegExp(`字体读了 ${MAX_FONT_ROUNDS} 轮仍有在读的`),
    );
    expect(sync).toHaveBeenCalledTimes(MAX_FONT_ROUNDS + 1);
    expect(owner.idle).toHaveBeenCalledTimes(MAX_FONT_ROUNDS + 1);
  });

  it("没有文本层：settle 返回 0、不调 sync，也不碰 wasm", async () => {
    const reader = { readWhole: vi.fn(), readRange: vi.fn() } as unknown as SceneReader;
    const probe = await prepareProbeTexts({ layers: [{ object: 0, text: null } as SceneLayer] }, reader, []);
    expect([probe.texts, probe.relayout]).toEqual([undefined, undefined]);
    const sync = vi.fn();
    expect(await probe.settle({ sync }, fakeState({}, []))).toBe(0);
    expect(sync).not.toHaveBeenCalled();
    expect(reader.readWhole).not.toHaveBeenCalled();
    probe.dispose();
  });
});

/** 读磁盘的读取器（系统字体按 `C:\Windows\Fonts`，回退链里的 Twemoji 按 WPE `assets`）。 */
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    return (await diskReader.readWhole(path)).slice(start, end);
  },
};

describe.skipIf(!existsSync(WASM) || !root)("prepareProbeTexts + settle（P6b 1e-3，真 wasm）", () => {
  it("「A」换成「A中」：沿回退链逐轮读字体，onReady 记下的层下一轮标脏再排，结清后两个字形", async () => {
    const fields = (text: string): TextFields => ({ ...TEXT_DEFAULTS, text, font: "systemfont_arial" });
    const layer = {
      object: 5,
      name: "S1",
      text: { fields: fields("A"), font: { path: "system:arial.ttf", location: null, size: null } } as SceneText,
    } as SceneLayer;
    const probe = await prepareProbeTexts({ layers: [layer] }, diskReader, [join(root!, "assets")]);
    let current: TextLayout = probe.texts!.get(5)!;
    expect(current.mesh!.glyphs).toHaveLength(1);
    // 迷你 `GpuScene.syncTexts`：对脏的文本层调重排器，排成的换上
    const state = { ...fakeState({ 5: "A中" }, [5]) };
    let syncs = 0;
    const scene = {
      sync(s: FakeState) {
        syncs++;
        for (const object of s.dirty) {
          const next = probe.relayout!.relayout(object, fields(s.fields.get(object)!), current);
          if (next) current = next;
        }
        s.dirty.clear();
      },
    };
    const result = await probe.settle(scene, state);
    expect(result).toBe(syncs);
    // 中文要沿 seguiemj → arialuni → segoeui → Twemoji → seguisym → msyh 读几轮（本机有哪些字体决定轮数）
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThanOrEqual(MAX_FONT_ROUNDS + 1);
    expect(current.mesh!.glyphs.length + current.mesh!.colorGlyphs.length).toBe(2);
    probe.dispose();
  });
});
