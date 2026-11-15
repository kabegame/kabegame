/**
 * P6d3b 点 10：`layerStateFromShell` 与编译产物经 `SceneState.fromBundle`（`layerStateOf`）得到的图层状态相同；`SceneState.addLayer`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { layerShellValues } from "../compile/layerShell";
import type { SceneObject } from "../compile/model";
import { layerStateFromShell, SceneState } from "./state";

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

function compile(objects: unknown[]) {
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
  });
}

const OBJECTS: Record<string, unknown>[] = [
  {
    id: 1,
    name: "full",
    image: "models/a.json",
    origin: "10 20 0",
    size: "40 60",
    scale: 0.5,
    angles: "0 0 90",
    alpha: 0.3,
    color: "1 0.5 0.25",
    brightness: 2,
    visible: false,
    parallaxDepth: "0.5 0.25",
    solid: false,
    alignment: "bottom",
  },
  { id: 2, name: "plain", image: "models/a.json", size: "40 60" },
  { id: 3, name: "bound", image: "models/a.json", size: "40 60", origin: { user: "p", value: "1 2 3" } },
  { id: 4, name: "center", image: "models/a.json", size: "40 60", alignment: "center" },
];

describe("layerStateFromShell", () => {
  it("与编译产物的图层状态相同（含对齐与偏移）", async () => {
    const bundle = await compile(OBJECTS);
    const state = SceneState.fromBundle(bundle);
    OBJECTS.forEach((object, index) => {
      const shell = layerShellValues(object as SceneObject);
      // 尺寸编译前未知：测试里给出 JSON 的 size，等价于编译后的尺寸
      shell.size = [40, 60];
      expect(layerStateFromShell(shell, null, { imageLayer: true })).toEqual(state.layers.get(index));
    });
  });

  it("分组节点（没有 image）不带 alignment；父原样保留", async () => {
    const bundle = await compile([{ id: 1, name: "g", origin: "5 5 0" }]);
    const state = SceneState.fromBundle(bundle);
    const shell = layerShellValues({ id: 1, name: "g", origin: "5 5 0" } as SceneObject);
    expect(layerStateFromShell(shell, null)).toEqual(state.layers.get(0));
    expect(layerStateFromShell(shell, 7).parent).toBe(7);
  });

  it("尺寸未知时不写偏移", () => {
    const shell = layerShellValues({ alignment: "bottom" } as unknown as SceneObject);
    const layer = layerStateFromShell(shell, null, { imageLayer: true });
    expect(layer.alignment).toBe(shell.alignment);
    expect(layer.offset).toBeUndefined();
  });
});

describe("SceneState.addLayer", () => {
  it("写 layers、追加 order 尾、挂到父的子表尾、structureVersion 加一", async () => {
    const bundle = await compile(OBJECTS);
    const state = SceneState.fromBundle(bundle);
    const before = state.structureVersion;
    const order = [...state.order];
    state.addLayer(10, layerStateFromShell(layerShellValues({} as SceneObject), null));
    state.addLayer(11, layerStateFromShell(layerShellValues({} as SceneObject), 10));
    expect(state.order).toEqual([...order, 10, 11]);
    expect(state.layers.get(11)?.parent).toBe(10);
    expect(state.childrenOf(10)).toEqual([11]);
    expect(state.structureVersion).toBe(before + 2);
  });
});
