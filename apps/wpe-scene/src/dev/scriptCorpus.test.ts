/**
 * 语料扫描的状态摘要（`scriptCorpus.ts` 的 `stateSnapshot`）：同一份状态两次结果相同、Map 插入顺序无关、改一个字段会变。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { SceneState } from "../render/state";
import { stateSnapshot } from "./scriptCorpus";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

function compile(): Promise<SceneBundle> {
  const objects = [
    { id: 1, name: "A", image: "models/a.json", size: "40 60", origin: "10 20 0" },
    { id: 2, name: "B", image: "models/a.json", size: "40 60", origin: "30 40 0" },
  ] as SceneObject[];
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

describe("stateSnapshot", () => {
  it("同一份状态两次结果相同", async () => {
    const state = SceneState.fromBundle(await compile());
    expect(JSON.stringify(stateSnapshot(state))).toBe(JSON.stringify(stateSnapshot(state)));
    // 两份从同一 bundle 建出的状态也相同
    const bundle = await compile();
    expect(JSON.stringify(stateSnapshot(SceneState.fromBundle(bundle)))).toBe(
      JSON.stringify(stateSnapshot(SceneState.fromBundle(bundle))),
    );
  });

  it("Map 插入顺序不同、内容相同时结果相同", async () => {
    const state = SceneState.fromBundle(await compile());
    const before = JSON.stringify(stateSnapshot(state));
    const entries = [...state.layers.entries()];
    expect(entries.length).toBeGreaterThan(1);
    state.layers.clear();
    for (const [key, value] of entries.reverse()) state.layers.set(key, value);
    expect(JSON.stringify(stateSnapshot(state))).toBe(before);
  });

  it("改一个图层字段后结果不同", async () => {
    const state = SceneState.fromBundle(await compile());
    const before = JSON.stringify(stateSnapshot(state));
    const layer = [...state.layers.values()][0];
    layer.alpha = layer.alpha === 0.5 ? 0.25 : 0.5;
    expect(JSON.stringify(stateSnapshot(state))).not.toBe(before);
  });
});
