/**
 * dev 探针的脚本值（kabegame-chromium 第 6 批，`scriptValues.ts`）：按下标、按名字解析出字段脚本的绑定目标，重名抛错，没挂脚本时报错或
 * `optional` 跳过，字段不同不匹配；写入经 `SceneState.write`，值的换算同宿主的脚本写回（`scriptWriteValue`）。
 * 探针本身要 GPU，这里用内存里编译的最小场景与真的 `SceneState` 核对。
 * P6b 1e-3：文本层的运行中字段——按下标与名字解析到文本目标、没挂脚本时跳过或抛错、字符串只给文本字段、超长与宿主不会写的值抛错、
 * 经 `writeText` 写（按宿主的脚本侧规则规整）、`wroteTextValues`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { SceneState } from "../render/state";
import { TEXT_MATERIALS } from "../compile/texts";
import {
  applyScriptValues,
  MAX_SCRIPT_TEXT,
  resolveScriptValues,
  wroteTextValues,
  type ScriptValueResult,
} from "./scriptValues";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 同 kbp gen 的 FR_COLOR 的颜色部分（日志部分对本测试无关）。 */
const FR_SCRIPT = `'use strict';
let frame = 0;
export function update(value) {
  frame++;
  value.x = (frame % 256) / 255;
  value.y = (Math.floor(frame / 256) % 256) / 255;
  value.z = 1;
  return value;
}
`;
const ALPHA_SCRIPT = "export function update(value) { return value; }";

const image = (extra: Record<string, unknown>): SceneObject =>
  ({ image: "models/a.json", size: "40 60", ...extra }) as SceneObject;

/** objects：0 FR（颜色挂脚本）、1 CLK（没挂脚本）、2 / 3 重名 dup、4 A（alpha 挂脚本、颜色没挂）。 */
function compile(): Promise<SceneBundle> {
  const objects: SceneObject[] = [
    image({ id: 1, name: "FR", origin: "1820 40 0", color: { script: FR_SCRIPT, value: "0 0 1" } }),
    image({ id: 2, name: "CLK", origin: "1700 40 0" }),
    image({ id: 3, name: "dup", origin: "100 100 0", color: { script: FR_SCRIPT, value: "1 1 1" } }),
    image({ id: 4, name: "dup", origin: "200 100 0" }),
    image({ id: 5, name: "A", origin: "300 100 0", alpha: { script: ALPHA_SCRIPT, value: 0.5 } }),
  ];
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("脚本值：解析", () => {
  it("按名字、按下标都解析到字段脚本的绑定目标", async () => {
    const bundle = await compile();
    const value = [941 % 256, Math.floor(941 / 256) % 256, 255].map((v) => v / 255);
    for (const object of ["FR", 0] as const) {
      const [resolved] = resolveScriptValues(bundle, [{ object, field: "color", value }]);
      expect(resolved.target).toEqual({ kind: "layer", object: 0, field: "color" });
      expect(resolved.result).toEqual({ object: 0, name: "FR", field: "color", value, applied: true });
    }
  });

  it("重名抛错（不论 optional：那是认不出，不是缺）", async () => {
    const bundle = await compile();
    expect(() => resolveScriptValues(bundle, [{ object: "dup", field: "color", value: [1, 1, 1] }])).toThrow(
      /叫 "dup" 的图层有 2 个（objects\[2\]、objects\[3\]）/,
    );
    expect(() =>
      resolveScriptValues(bundle, [{ object: "dup", field: "color", value: [1, 1, 1], optional: true }]),
    ).toThrow(/有 2 个/);
    // 按下标能认出
    expect(resolveScriptValues(bundle, [{ object: 2, field: "color", value: [1, 1, 1] }])[0].result.applied).toBe(true);
  });

  it("没挂字段脚本：缺省抛错，optional 跳过并写明原因", async () => {
    const bundle = await compile();
    expect(() => resolveScriptValues(bundle, [{ object: "CLK", field: "color", value: [0, 0, 1] }])).toThrow(
      /scriptValues\[0\]：objects\[1\]（CLK）的 color 没有挂字段脚本/,
    );
    const [skipped] = resolveScriptValues(bundle, [
      { object: "CLK", field: "color", value: [0, 0, 1], optional: true },
    ]);
    expect(skipped.target).toBeNull();
    expect(skipped.result).toEqual({
      object: 1,
      name: "CLK",
      field: "color",
      value: [0, 0, 1],
      applied: false,
      reason: "objects[1]（CLK）的 color 没有挂字段脚本",
    });
  });

  it("字段不同不匹配：A 的 alpha 挂了脚本，color 没挂", async () => {
    const bundle = await compile();
    const [color, alpha] = resolveScriptValues(bundle, [
      { object: "A", field: "color", value: [1, 0, 0], optional: true },
      { object: "A", field: "alpha", value: [0.25] },
    ]);
    expect(color.result.applied).toBe(false);
    expect(alpha.target).toEqual({ kind: "layer", object: 4, field: "alpha" });
    // FR 的颜色脚本不会被当成别的字段
    expect(() => resolveScriptValues(bundle, [{ object: "FR", field: "alpha", value: [1] }])).toThrow(
      /objects\[0\]（FR）的 alpha 没有挂字段脚本/,
    );
  });

  it("找不到对象：名字不存在或下标不在图层里，optional 跳过（object / name 为 null），否则抛错", async () => {
    const bundle = await compile();
    const [byName, byIndex] = resolveScriptValues(bundle, [
      { object: "kbp-FR", field: "color", value: [0, 0, 1], optional: true },
      { object: 99, field: "color", value: [0, 0, 1], optional: true },
    ]);
    expect(byName.result).toMatchObject({ object: null, name: null, applied: false, reason: '没有叫 "kbp-FR" 的图层' });
    expect(byIndex.result).toMatchObject({ object: null, name: null, applied: false });
    expect(byIndex.result.reason).toMatch(/objects\[99\] 不在 bundle 的图层里/);
    expect(() => resolveScriptValues(bundle, [{ object: 99, field: "color", value: [0, 0, 1] }])).toThrow(
      /objects\[99\]/,
    );
  });

  it("值、字段、对象的形状不对时抛错", async () => {
    const bundle = await compile();
    for (const value of [[], [1, 2, 3, 4, 5], [Number.NaN], ["1"], "0 0 1", null]) {
      expect(() => resolveScriptValues(bundle, [{ object: "FR", field: "color", value: value as never }])).toThrow(
        /value 要是 1–4 个有限数或布尔/,
      );
    }
    expect(() => resolveScriptValues(bundle, [{ object: "FR", field: "size" as never, value: [1] }])).toThrow(
      /field 要是图层字段/,
    );
    for (const object of [-1, 1.5, ""]) {
      expect(() => resolveScriptValues(bundle, [{ object, field: "color", value: [1] }])).toThrow(/object 要是/);
    }
  });
});

describe("脚本值：写进状态", () => {
  it("经 SceneState.write 写到绑定目标：颜色进状态并标脏；跳过的不写", async () => {
    const bundle = await compile();
    const state = SceneState.fromBundle(bundle);
    expect(state.layers.get(0)!.color).toEqual([0, 0, 1]);
    state.takeDirty();
    const value = [173 / 255, 3 / 255, 1];
    const results = applyScriptValues(state, bundle, [
      { object: "FR", field: "color", value },
      { object: "CLK", field: "color", value: [1, 0, 0], optional: true },
    ]);
    expect(results.map((r) => r.applied)).toEqual([true, false]);
    expect(state.layers.get(0)!.color).toEqual(value);
    expect(state.layers.get(1)!.color).toEqual([1, 1, 1]);
    expect([...state.takeDirty().layers]).toEqual([0]);
  });

  it("写入值的换算同宿主的脚本写回：多分量拼成空格分隔、单分量传数字、布尔原样", async () => {
    const bundle = await compile();
    const writes: unknown[][] = [];
    const state = { write: (...args: unknown[]) => (writes.push(args), "applied" as const), writeText: vi.fn() };
    applyScriptValues(state, bundle, [
      { object: 0, field: "color", value: [0.25, 0.5, 1] },
      { object: "A", field: "alpha", value: [0.75] },
    ]);
    expect(writes).toEqual([
      [{ property: "", target: { kind: "layer", object: 0, field: "color" } }, "0.25 0.5 1"],
      [{ property: "", target: { kind: "layer", object: 4, field: "alpha" } }, 0.75],
    ]);
  });

  it("不给或空数组时返回空数组、不写；有一项要抛错时一项也不写", async () => {
    const bundle = await compile();
    const write = vi.fn();
    const writeText = vi.fn();
    expect(applyScriptValues({ write, writeText }, bundle, undefined)).toEqual([]);
    expect(applyScriptValues({ write, writeText }, bundle, [])).toEqual([]);
    expect(() =>
      applyScriptValues({ write, writeText }, bundle, [
        { object: "FR", field: "color", value: [1, 1, 1] },
        { object: "CLK", field: "color", value: [1, 1, 1] },
      ]),
    ).toThrow(/没有挂字段脚本/);
    expect(write).not.toHaveBeenCalled();
  });
});

/** WPE 自带的四个字体材质（只要编得出 pass；内容同 `compile/texts.test.ts`）。 */
const ASSETS = "A:/assets";
const TEXT_FILES: Record<string, unknown> = {
  [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: { passes: [{ shader: "font", blending: "translucent" }] },
  [`${ASSETS}/${TEXT_MATERIALS.color}`]: {
    passes: [{ shader: "font", blending: "translucent", combos: { COLORFONT: 1 } }],
  },
  [`${ASSETS}/${TEXT_MATERIALS.background}`]: { passes: [{ shader: "flat", blending: "translucent" }] },
  [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: {
    passes: [{ shader: "composelayer", textures: ["_rt_FullFrameBuffer"], combos: { CLEARALPHA: 1 } }],
  },
};
const CLOCK_SCRIPT = "export function update(value) { return '12:34'; }";
const SIZE_SCRIPT = "export function update(value) { return value; }";

/** objects：0 S1（文本，`text` 与 `pointsize` 挂脚本）、1 T2（文本，没挂脚本）、2 FR（图像，颜色挂脚本）。 */
function compileText(): Promise<SceneBundle> {
  const objects: SceneObject[] = [
    {
      id: 10,
      name: "S1",
      origin: "100 100 0",
      text: { script: CLOCK_SCRIPT, value: "F0" },
      pointsize: { script: SIZE_SCRIPT, value: 32 },
    } as SceneObject,
    { id: 11, name: "T2", origin: "300 100 0", text: "static" } as SceneObject,
    image({ id: 12, name: "FR", origin: "1820 40 0", color: { script: FR_SCRIPT, value: "0 0 1" } }),
  ];
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
      ...TEXT_FILES,
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("脚本值：文本字段（P6b 1e-3）", () => {
  it("编译出的文本层与字段脚本：S1 的 text / pointsize 是文本目标，能力表不报", async () => {
    const bundle = await compileText();
    expect(bundle.layers.map((layer) => [layer.object, layer.name, !!layer.text])).toEqual([
      [0, "S1", true],
      [1, "T2", true],
      [2, "FR", false],
    ]);
    expect(bundle.scripts.list.map((script) => script.target)).toEqual([
      { kind: "text", object: 0, field: "text" },
      { kind: "text", object: 0, field: "pointsize" },
      { kind: "layer", object: 2, field: "color" },
    ]);
    expect(bundle.unsupported.filter((key) => key.startsWith("text:"))).toEqual([]);
  });

  it("按名字、按下标都解析到文本目标；字符串原样，pointsize 收数", async () => {
    const bundle = await compileText();
    for (const object of ["S1", 0] as const) {
      const [text, size] = resolveScriptValues(bundle, [
        { object, field: "text", value: "F183" },
        { object, field: "pointsize", value: [48] },
      ]);
      expect(text).toEqual({
        result: { object: 0, name: "S1", field: "text", value: "F183", applied: true },
        target: { kind: "text", object: 0, field: "text" },
        text: "F183",
      });
      expect(size).toMatchObject({ target: { kind: "text", object: 0, field: "pointsize" }, text: 48 });
    }
    // 空串也是值（清空文字）
    expect(resolveScriptValues(bundle, [{ object: "S1", field: "text", value: "" }])[0]).toMatchObject({ text: "" });
  });

  it("值按宿主脚本写回规整：text 收数时 ToString、布尔转字符串；pointsize 收数串", async () => {
    const bundle = await compileText();
    const texts = resolveScriptValues(bundle, [
      { object: "S1", field: "text", value: [12] },
      { object: "S1", field: "text", value: true },
      { object: "S1", field: "pointsize", value: "40" },
    ]).map((item) => ("text" in item ? item.text : null));
    expect(texts).toEqual(["12", "true", 40]);
  });

  it("没挂字段脚本：optional 跳过，否则抛错；图层字段与文本字段的脚本不互认", async () => {
    const bundle = await compileText();
    expect(() => resolveScriptValues(bundle, [{ object: "T2", field: "text", value: "x" }])).toThrow(
      /scriptValues\[0\]：objects\[1\]（T2）的 text 没有挂字段脚本/,
    );
    const [skipped] = resolveScriptValues(bundle, [{ object: "T2", field: "text", value: "x", optional: true }]);
    expect(skipped).toEqual({
      result: {
        object: 1,
        name: "T2",
        field: "text",
        value: "x",
        applied: false,
        reason: "objects[1]（T2）的 text 没有挂字段脚本",
      },
      target: null,
    });
    // S1 没在 maxwidth 上挂脚本；FR 是图像层、没有文本字段；S1 的颜色没挂脚本
    expect(() => resolveScriptValues(bundle, [{ object: "S1", field: "maxwidth", value: [300] }])).toThrow(
      /S1）的 maxwidth 没有挂字段脚本/,
    );
    expect(() => resolveScriptValues(bundle, [{ object: "FR", field: "text", value: "x" }])).toThrow(
      /FR）的 text 没有挂字段脚本/,
    );
    expect(() => resolveScriptValues(bundle, [{ object: "S1", field: "color", value: [1, 1, 1] }])).toThrow(
      /S1）的 color 没有挂字段脚本/,
    );
  });

  it("字符串只给文本字段；超长、形状不对、按宿主规则不会写的值，以及不是运行中字段的文本键都抛错", async () => {
    const bundle = await compileText();
    const resolve = (item: Record<string, unknown>) => () =>
      resolveScriptValues(bundle, [{ object: "S1", field: "text", value: "x", ...item } as never]);
    expect(resolve({ object: "FR", field: "color", value: "0 0 1" })).toThrow(
      /value 要是 1–4 个有限数或布尔（color 是图层字段，字符串只给文本字段）/,
    );
    expect(resolve({ value: "x".repeat(MAX_SCRIPT_TEXT) })).not.toThrow();
    expect(resolve({ value: "x".repeat(MAX_SCRIPT_TEXT + 1) })).toThrow(
      new RegExp(`value 长 ${MAX_SCRIPT_TEXT + 1} 个 UTF-16 单元，最长 ${MAX_SCRIPT_TEXT}`),
    );
    for (const value of [[], [1, 2, 3, 4, 5], [Number.NaN], ["1"], null, { text: "x" }]) {
      expect(resolve({ value }), JSON.stringify(value)).toThrow(
        /value 要是字符串（最长 4096 个 UTF-16 单元）、1–4 个有限数或布尔/,
      );
    }
    expect(resolve({ field: "pointsize", value: "abc" })).toThrow(/按宿主的脚本写回规则不会写进 pointsize/);
    expect(resolve({ field: "pointsize", value: [1, 2] })).toThrow(/不会写进 pointsize/);
    // 布尔位只收布尔（WPE 类型 6）
    expect(resolve({ field: "limitwidth", value: [1] })).toThrow(/不会写进 limitwidth/);
    for (const field of ["font", "opaquebackground", "backgroundcolor", "Text"]) {
      expect(resolve({ field }), field).toThrow(/field 要是图层字段（.*）或文本字段（text \/ pointsize \/ /);
    }
  });

  it("写进状态经 writeText：文本层的字段变了、标 dirtyTexts；图层字段照旧经 write", async () => {
    const bundle = await compileText();
    const state = SceneState.fromBundle(bundle);
    state.takeDirty();
    const frColor = [173 / 255, 3 / 255, 1];
    const results = applyScriptValues(state, bundle, [
      { object: "S1", field: "text", value: "F183" },
      { object: "S1", field: "pointsize", value: [48] },
      { object: "FR", field: "color", value: frColor },
      { object: "T2", field: "text", value: "x", optional: true },
    ]);
    expect(results.map((r) => r.applied)).toEqual([true, true, true, false]);
    expect([state.textFields.get(0)!.text, state.textFields.get(0)!.pointsize]).toEqual(["F183", 48]);
    expect(state.textFields.get(1)!.text).toBe("static");
    expect(state.layers.get(2)!.color).toEqual(frColor);
    const dirty = state.takeDirty();
    expect([...dirty.texts]).toEqual([0]);
    expect([...dirty.layers]).toEqual([2]);
    // 文本字段不经 write 的属性侧规则：`text` 给数时脚本侧 ToString（属性侧不写）
    applyScriptValues(state, bundle, [{ object: "S1", field: "text", value: [7] }]);
    expect(state.textFields.get(0)!.text).toBe("7");
  });

  it("写入的调用：文本目标调 writeText(对象, 字段, 规整后的值)，不调 write", async () => {
    const bundle = await compileText();
    const write = vi.fn();
    const writeText = vi.fn();
    applyScriptValues({ write, writeText }, bundle, [
      { object: 0, field: "text", value: [12] },
      { object: "S1", field: "pointsize", value: "40" },
    ]);
    expect(writeText.mock.calls).toEqual([
      [0, "text", "12"],
      [0, "pointsize", 40],
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("wroteTextValues：有文本字段写进了状态才为真（跳过的、只有图层字段的不算）", () => {
    const result = (field: string, applied: boolean) =>
      ({ object: 0, name: "x", field, value: "x", applied }) as ScriptValueResult;
    expect(wroteTextValues([])).toBe(false);
    expect(wroteTextValues([result("color", true), result("alpha", true)])).toBe(false);
    expect(wroteTextValues([result("color", true), result("text", false)])).toBe(false);
    expect(wroteTextValues([result("color", true), result("maxwidth", true)])).toBe(true);
  });
});
