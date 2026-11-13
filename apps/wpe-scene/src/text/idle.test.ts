/**
 * P6b 1e-3：`SceneTexts.idle()`（dev 探针结清运行中重排用）。
 * - 没有在读的字体时立即返回 false（prepare 之前、之后都一样）；
 * - 运行中重排缺字体发起的读取：结束之前不返回，结束时 `onReady` 已调过，返回 true；读完从表里删掉，再问返回 false；
 * - 几个读取同时在读时等全部结束；读取器抛错、重排器过期（读完的回调丢掉）也算结束。
 * 排版换成假的（`layoutText` 按 `missing` 给出缺哪些字体，不碰图集），字体读取用闸门卡住，不要 wasm。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneText } from "../compile/texts";
import type { Wpefont } from "../wpefont";
import { SceneTexts } from "./host";
import { TEXT_DEFAULTS, type TextLayout } from "./layout";

/** 假排版：缺 `missing` 里的字体（非空时不排、不碰图集），否则给一份空排版。 */
let missing: string[] = [];
vi.mock("./layout", async (original) => ({
  ...(await original<typeof import("./layout")>()),
  layoutText: (): TextLayout => ({
    missingFonts: [...missing],
    mesh: null,
    padding: [0, 0],
    size: [2, 2],
    compositeSize: [1, 1],
    offset: [0, 0],
  }),
}));

/** 闸门读取器：每个路径一道闸门，`open(path)` 放行（`fail` 时读取器抛错），之前一直卡着。 */
function gatedReader() {
  const gates = new Map<string, { promise: Promise<void>; open: () => void; fail: () => void }>();
  const gate = (path: string) => {
    let entry = gates.get(path);
    if (!entry) {
      let open!: () => void;
      let fail!: () => void;
      const promise = new Promise<void>((resolve, reject) => {
        open = resolve;
        fail = () => reject(new TypeError("Failed to fetch"));
      });
      entry = { promise, open, fail };
      gates.set(path, entry);
    }
    return entry;
  };
  const reader: SceneReader = {
    async readWhole(path) {
      await gate(path).promise;
      return new Uint8Array([1]);
    },
    async readRange(path) {
      return reader.readWhole(path);
    },
  };
  return { reader, open: (path: string) => gate(path).open(), fail: (path: string) => gate(path).fail() };
}

const layer = (object: number) =>
  ({
    object,
    text: {
      fields: { ...TEXT_DEFAULTS, text: "A" },
      font: { path: "system:arial.ttf", location: null, size: null },
    } as SceneText,
  }) as SceneLayer;

/** 让微任务与一次宏任务跑完（读完字体之后的回调链）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 排好两层（0、1），返回重排器、onReady 收到的对象与闸门。 */
async function prepared() {
  missing = [];
  const ready: number[] = [];
  const gates = gatedReader();
  const texts = new SceneTexts({
    reader: gates.reader,
    engine: async () => ({}) as Wpefont,
    onReady: (object) => ready.push(object),
  });
  expect(await texts.idle()).toBe(false);
  const layouts = (await texts.prepare({ layers: [layer(0), layer(1)] }, { sceneAssets: [], fontsDir: "C:\\F" }))!;
  return { texts, relayouter: texts.relayouter()!, layouts, ready, gates };
}

/** 发起 `idle()`，记下它返回时的结果与那一刻 `onReady` 收到的对象。 */
function watchIdle(texts: SceneTexts, ready: number[]) {
  const seen: { value: boolean; ready: number[] }[] = [];
  const done = texts.idle().then((value) => void seen.push({ value, ready: [...ready] }));
  return { seen, done };
}

describe("SceneTexts.idle（P6b 1e-3）", () => {
  it("没有在读的字体时立即返回 false：prepare 前后、重排排成时都一样", async () => {
    const { texts, relayouter, layouts, ready } = await prepared();
    expect(await texts.idle()).toBe(false);
    expect(relayouter.relayout(0, { ...TEXT_DEFAULTS, text: "B" }, layouts.get(0)!)).not.toBeNull();
    expect(await texts.idle()).toBe(false);
    expect(ready).toEqual([]);
    texts.dispose();
  });

  it("缺字体发起的读取：结束前不返回；结束时 onReady 已调过、返回 true；之后再问返回 false", async () => {
    const { texts, relayouter, layouts, ready, gates } = await prepared();
    missing = ["system:x.ttf"];
    expect(relayouter.relayout(0, { ...TEXT_DEFAULTS, text: "B" }, layouts.get(0)!)).toBeNull();
    const idle = watchIdle(texts, ready);
    await tick();
    expect(idle.seen).toEqual([]);
    gates.open("C:\\F\\x.ttf");
    await idle.done;
    expect(idle.seen).toEqual([{ value: true, ready: [0] }]);
    // 结束的读取从表里删掉
    expect(await texts.idle()).toBe(false);
    texts.dispose();
  });

  it("几个读取同时在读：等全部结束；读取器抛错也算结束（当读不到，onReady 照调）", async () => {
    const { texts, relayouter, layouts, ready, gates } = await prepared();
    missing = ["system:x.ttf"];
    expect(relayouter.relayout(0, { ...TEXT_DEFAULTS, text: "B" }, layouts.get(0)!)).toBeNull();
    missing = ["system:y.ttf"];
    expect(relayouter.relayout(1, { ...TEXT_DEFAULTS, text: "C" }, layouts.get(1)!)).toBeNull();
    const idle = watchIdle(texts, ready);
    gates.fail("C:\\F\\x.ttf");
    await tick();
    expect(ready).toEqual([0]);
    expect(idle.seen).toEqual([]);
    gates.open("C:\\F\\y.ttf");
    await idle.done;
    expect(idle.seen).toEqual([{ value: true, ready: [0, 1] }]);
    expect(await texts.idle()).toBe(false);
    texts.dispose();
  });

  it("重排器过期（更新的加载开始、dispose）：读完的回调丢掉，读取照样算结束", async () => {
    const { texts, relayouter, layouts, ready, gates } = await prepared();
    missing = ["system:x.ttf"];
    expect(relayouter.relayout(0, { ...TEXT_DEFAULTS, text: "B" }, layouts.get(0)!)).toBeNull();
    texts.dispose();
    const idle = watchIdle(texts, ready);
    await tick();
    expect(idle.seen).toEqual([]);
    gates.open("C:\\F\\x.ttf");
    await idle.done;
    expect(idle.seen).toEqual([{ value: true, ready: [] }]);
    expect(await texts.idle()).toBe(false);
  });
});
