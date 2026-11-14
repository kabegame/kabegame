/**
 * P5a 补修：布尔 general 字段写成 `{user, value}`、属性值不是布尔时，按对象自己的 `value` 设位（WPE 实测 `ignore/p5/pb/` E1–E6）。
 */
import { describe, expect, it } from "vitest";
import { BindingCollector } from "./bindings";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import type { SceneScalar } from "./model";
import { flagValue } from "./postprocess";

const target = { kind: "bloom-enabled" } as const;
const flag = (value: unknown, properties: Record<string, SceneScalar> = {}, bindings?: BindingCollector) =>
  flagValue(value, properties, bindings, target);

describe("flagValue：属性值非布尔时退回 value（E1–E5）", () => {
  it("E1：value true + 属性 −0.22 → true", () => {
    expect(flag({ user: "p", value: true }, { p: -0.22 })).toBe(true);
  });
  it("E2：value true + 属性 0 → true", () => {
    expect(flag({ user: "p", value: true }, { p: 0 })).toBe(true);
  });
  it("E3：value false + 属性 0.5 → false", () => {
    expect(flag({ user: "p", value: false }, { p: 0.5 })).toBe(false);
  });
  it("E4：value true + 属性 false → false（属性布尔能改位）；value false + 属性 true → true", () => {
    expect(flag({ user: "p", value: true }, { p: false })).toBe(false);
    expect(flag({ user: "p", value: false }, { p: true })).toBe(true);
  });
  it('E5：value false + 属性 "1" → false', () => {
    expect(flag({ user: "p", value: false }, { p: "1" })).toBe(false);
  });
  it("属性缺失时用 value；value 也不是布尔时 undefined", () => {
    expect(flag({ user: "p", value: true })).toBe(true);
    expect(flag({ user: "p", value: false })).toBe(false);
    expect(flag({ user: "p", value: 1 })).toBeUndefined();
    expect(flag({ user: "p", value: 1 }, { p: 1 })).toBeUndefined();
  });
  it("JSON 直接是布尔 / 无 user 的对象", () => {
    expect(flag(true)).toBe(true);
    expect(flag(false)).toBe(false);
    expect(flag({ value: true })).toBe(true);
    expect(flag({ value: 1 })).toBeUndefined();
    expect(flag(undefined)).toBeUndefined();
    expect(flag(null)).toBeUndefined();
  });
  it("带 condition 的仍按条件（结果恒为布尔）", () => {
    const value = { user: { name: "m", condition: "a" }, value: true };
    expect(flag(value, { m: "a" })).toBe(true);
    expect(flag(value, { m: "b" })).toBe(false);
  });
  it("带 bindings 时照旧登记绑定，结果同上", () => {
    const bindings = new BindingCollector();
    expect(flag({ user: "p", value: true }, { p: -0.22 }, bindings)).toBe(true);
    expect(bindings.list).toHaveLength(1);
    expect(bindings.list[0]).toMatchObject({ property: "p", target });
  });
});

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

async function compileGeneral(general: Record<string, unknown>, userProperties: Record<string, SceneScalar>) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": {
        general: { orthogonalprojection: { width: 64, height: 32 }, ...general },
        objects: [{ id: 1, name: "a", image: "models/a.json", size: "10 10" }],
      },
      "P:/p/models/a.json": { material: "materials/a.json", width: 10, height: 10 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    userProperties,
  });
}

describe("general.cameraparallax 绑滑块", () => {
  it("value true + 滑块 −0.22：bundle 里 cameraparallax 为 true，且登记了绑定", async () => {
    const bundle = await compileGeneral({ cameraparallax: { user: "p", value: true } }, { p: -0.22 });
    expect(bundle.general.fields.cameraparallax).toBe(true);
    expect(bundle.bindings.some((item) => item.property === "p")).toBe(true);
  });
  it("value false + 滑块 0.5：false", async () => {
    const bundle = await compileGeneral({ cameraparallax: { user: "p", value: false } }, { p: 0.5 });
    expect(bundle.general.fields.cameraparallax).toBe(false);
  });
});
