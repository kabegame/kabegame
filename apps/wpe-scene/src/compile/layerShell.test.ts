/**
 * P6d3b 点 10：`layerShellValues` 与 `compileScene` 对象循环里建出的 `SceneLayer` 逐字段相同（同一份取值规则）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { layerShellValues } from "./layerShell";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";

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

function compile(objects: unknown[], userProperties: Record<string, unknown> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

const FIELDS = [
  "name",
  "origin",
  "scale",
  "angles",
  "size",
  "alpha",
  "color",
  "brightness",
  "visible",
  "visibleBound",
  "parallaxDepth",
] as const;

const OBJECTS: Record<string, unknown>[] = [
  // 纯色层式的朴素对象
  { id: 1, name: "plain", image: "models/a.json", origin: "10 20 0", size: "40 60", color: "1 0 0" },
  // 绑定对象缺省取 `value`（没有属性值时）：脚本、关键帧、属性
  {
    id: 2,
    name: "bound",
    image: "models/a.json",
    origin: { user: "p", value: "1 2 3" },
    alpha: { script: "export function update(v) { return v; }", value: 0.5 },
    scale: { animation: { c0: [] }, value: "2 2 2" },
    visible: { user: "v", value: false },
    brightness: 2,
    parallaxDepth: "0.5 0.25",
  },
  // 数字铺满向量、字符串少写分量
  { id: 3, name: "setter", image: "models/a.json", scale: 0.72, color: "1 0.5", angles: "0 0 90", alpha: true },
  // 分组节点（没有 image）
  { id: 4, name: "group", origin: "5 5 0", visible: false },
  // 没有任何字段
  { image: "models/a.json" },
];

describe("layerShellValues", () => {
  it("缺省取值：没写的字段是构造缺省", () => {
    expect(layerShellValues({} as SceneObject)).toEqual({
      id: null,
      name: "",
      origin: [0, 0, 0],
      scale: [1, 1, 1],
      angles: [0, 0, 0],
      size: [],
      alpha: 1,
      color: [1, 1, 1],
      brightness: 1,
      visible: true,
      visibleBound: false,
      parallaxDepth: [1, 1],
      solid: true,
      alignment: 0,
    });
  });

  it("绑定对象取它的 value；solid 为 false、alignment 取下标、id 只认数字", () => {
    const shell = layerShellValues({
      id: 7,
      origin: { user: "p", value: "1 2 3" },
      solid: { user: "s", value: false },
      alignment: "bottom",
      visible: { user: "v", value: false },
    } as unknown as SceneObject);
    expect(shell.id).toBe(7);
    expect(shell.origin).toEqual([1, 2, 3]);
    expect(shell.solid).toBe(false);
    expect(shell.alignment).toBeGreaterThan(0);
    expect(shell.visible).toBe(false);
    expect(shell.visibleBound).toBe(true);
    expect(layerShellValues({ id: "x" } as unknown as SceneObject).id).toBeNull();
  });

  it("bind 钩子：结果替代 value，并按字段名调用", () => {
    const seen: string[] = [];
    const shell = layerShellValues(
      { origin: { user: "p", value: "1 2 3" }, alpha: { user: "a", value: 1 } } as never,
      (field, raw) => {
        seen.push(field);
        return field === "origin" ? "9 9 9" : field === "alpha" ? 0.25 : (raw as never);
      },
    );
    expect(shell.origin).toEqual([9, 9, 9]);
    expect(shell.alpha).toBe(0.25);
    // 调用顺序同编译期的登记顺序
    expect(seen.slice(0, 9)).toEqual([
      "origin",
      "scale",
      "angles",
      "size",
      "alpha",
      "color",
      "brightness",
      "visible",
      "parallaxDepth",
    ]);
  });

  it("与 compileScene 建出的 SceneLayer 逐字段相同（含绑定、setter 规则、分组节点）", async () => {
    const bundle = await compile(OBJECTS);
    expect(bundle.layers.length).toBe(OBJECTS.length);
    for (const [index, object] of OBJECTS.entries()) {
      const layer = bundle.layers.find((item) => item.object === index)!;
      const shell = layerShellValues(object as SceneObject);
      for (const field of FIELDS) {
        // `size`：编译期会按图像 / 纹理尺寸再补，没写时是空数组由调用方补；写了的两边相同
        if (field === "size" && shell.size.length === 0) continue;
        expect(layer[field], `${index}.${field}`).toEqual(shell[field]);
      }
      expect(layer.solid !== false).toBe(shell.solid);
    }
  });

  it("有属性值时编译期经 bind 取解析值（shell 默认只取 value）", async () => {
    const bundle = await compile([OBJECTS[1]], { p: "7 8 9" });
    expect(bundle.layers[0].origin).toEqual([7, 8, 9]);
    expect(layerShellValues(OBJECTS[1] as SceneObject).origin).toEqual([1, 2, 3]);
  });
});
