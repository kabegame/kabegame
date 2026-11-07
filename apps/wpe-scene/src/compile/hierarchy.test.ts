import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { checkObjectFeatures, checkSceneFeatures } from "./features";
import type { SceneReader } from "./fs";
import { resolveParents } from "./hierarchy";
import type { SceneObject } from "./model";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

describe("resolveParents", () => {
  it("按 id 找父，子在父前也成立", () => {
    const { parents, cycle } = resolveParents([{ id: 1, parent: 2 }, { id: 2 }, { id: 3, parent: 1 }]);
    expect(parents).toEqual([1, null, 0]);
    expect(cycle).toBe(false);
  });

  it("找不到、指向自己、不是有限数字时当根节点", () => {
    const objects: SceneObject[] = [
      { id: 1, parent: 9999 },
      { id: 2, parent: 2 },
      { id: 3, parent: "1" },
      { id: 4, parent: Number.NaN },
      { id: 5, parent: null },
      { id: 6, parent: { user: "p", value: 1 } },
      { id: 7 },
    ];
    expect(resolveParents(objects)).toEqual({ parents: [null, null, null, null, null, null, null], cycle: false });
  });

  it("id 重复时取第一个（没有实测的选择）", () => {
    expect(resolveParents([{ id: 5 }, { id: 5 }, { id: 6, parent: 5 }]).parents).toEqual([null, null, 0]);
  });

  it("成环时断开一条边并报告，不死循环", () => {
    const { parents, cycle } = resolveParents([
      { id: 1, parent: 3 },
      { id: 2, parent: 1 },
      { id: 3, parent: 2 },
      { id: 4, parent: 3 },
    ]);
    expect(cycle).toBe(true);
    // 从下标 0 走：0 → 2 → 1 → 0，指回 0 的那条边（下标 1 的父）断开
    expect(parents).toEqual([2, null, 1, 2]);
    // 断开之后每条父链都能走到根
    for (let start = 0; start < parents.length; start++) {
      let steps = 0;
      for (let current: number | null = start; current !== null; current = parents[current]) steps++;
      expect(steps).toBeLessThanOrEqual(parents.length);
    }
  });

  it("两个对象互指", () => {
    const { parents, cycle } = resolveParents([
      { id: 1, parent: 2 },
      { id: 2, parent: 1 },
    ]);
    expect(cycle).toBe(true);
    expect(parents).toEqual([1, null]);
  });
});

describe("能力表：层级", () => {
  it("分组节点不报 object:empty，它的 effects 不读", () => {
    const keys = new Set<string>();
    checkObjectFeatures(
      { id: 30, name: "g0", origin: "400 300 0", angles: "0 0 0.5", effects: [{ file: "effects/x/effect.json" }] },
      keys,
    );
    expect([...keys]).toEqual([]);
  });

  it("普通图层带 parent 不报；灯带有效 parent 仍报 object:parent", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: ORTHO,
        objects: [
          { id: 1, origin: "1 2 3" },
          { id: 2, image: "models/a.json", parent: 1 },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
    checkSceneFeatures(
      {
        general: ORTHO,
        objects: [
          { id: 1, origin: "1 2 3" },
          { id: 2, light: "lpoint", parent: 1 },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual(["object:parent"]);
  });

  it("灯的 parent 找不到时当根节点，不报", () => {
    const keys = new Set<string>();
    checkSceneFeatures({ general: ORTHO, objects: [{ id: 2, light: "lpoint", parent: 9 }] }, keys);
    expect([...keys]).toEqual([]);
  });

  it("成环报 object:parent-cycle", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: ORTHO,
        objects: [
          { id: 1, image: "models/a.json", parent: 2 },
          { id: 2, parent: 1 },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual(["object:parent-cycle"]);
  });
});

describe("compileScene：层级", () => {
  const memory = (files: Record<string, unknown>): SceneReader => {
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
  };
  const compile = (objects: SceneObject[]) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memory({
        "P:/p/project.json": { file: "scene.json" },
        "P:/p/scene.json": { general: ORTHO, objects },
        "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
        "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
      }),
      translator: null,
      postprocess: "disabled",
      exhaustive: true,
    });

  it("每个对象都进 layers，parent 是父的 objects 下标；分组节点的 effects 不编译", async () => {
    const bundle = await compile([
      { id: 33, image: "models/a.json", parent: 34 },
      { id: 34, image: "models/a.json" },
      { id: 30, origin: "400 300 0", effects: [{ file: "effects/missing/effect.json" }] },
      { id: 31, image: "models/a.json", parent: 30 },
    ]);
    expect(bundle.layers.map((layer) => [layer.object, layer.parent])).toEqual([
      [0, 1],
      [1, null],
      [2, null],
      [3, 2],
    ]);
    expect(bundle.layers[2].passes).toEqual([]);
    expect(bundle.layers[2].effects).toEqual([]);
    // 分组节点的 effect 文件不存在也不报（不读）；也没有 object:* 键
    expect(bundle.unsupported.filter((key) => key.startsWith("effect:") || key.startsWith("object:"))).toEqual([]);
  });

  it("成环的场景编译能结束，报 object:parent-cycle", async () => {
    const bundle = await compile([
      { id: 1, image: "models/a.json", parent: 2 },
      { id: 2, image: "models/a.json", parent: 1 },
    ]);
    expect(bundle.unsupported).toContain("object:parent-cycle");
    expect(bundle.layers.map((layer) => layer.parent)).toEqual([1, null]);
  });
});
