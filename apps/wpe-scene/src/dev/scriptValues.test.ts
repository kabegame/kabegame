/**
 * dev 探针的脚本值（kabegame-chromium 第 6 批，`scriptValues.ts`）：按下标、按名字解析出字段脚本的绑定目标，重名抛错，没挂脚本时报错或
 * `optional` 跳过，字段不同不匹配；写入经 `SceneState.write`，值的换算同宿主的脚本写回（`scriptWriteValue`）。
 * 探针本身要 GPU，这里用内存里编译的最小场景与真的 `SceneState` 核对。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { SceneState } from "../render/state";
import { applyScriptValues, resolveScriptValues } from "./scriptValues";

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
    const state = { write: (...args: unknown[]) => (writes.push(args), "applied" as const) };
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
    expect(applyScriptValues({ write }, bundle, undefined)).toEqual([]);
    expect(applyScriptValues({ write }, bundle, [])).toEqual([]);
    expect(() =>
      applyScriptValues({ write }, bundle, [
        { object: "FR", field: "color", value: [1, 1, 1] },
        { object: "CLK", field: "color", value: [1, 1, 1] },
      ]),
    ).toThrow(/没有挂字段脚本/);
    expect(write).not.toHaveBeenCalled();
  });
});
