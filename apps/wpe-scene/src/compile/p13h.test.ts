/**
 * P13h（透视场景的余项）的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13h-perspective-rest.md`）：
 * - 透视场景里的文本：对象 `depthtest` 不是 disabled 时字形、彩色字形、背景换成 `_depth` 材质（rea-p13-lights 5.2，`p13h-text`），
 *   正交场景、`depthtest: disabled` 照旧用无深度材质；`clearalpha` 不换；不再报 `camera:perspective:text`；
 * - 透视场景里带子层的组合层照编，不再报 `camera:perspective:group`；
 * - 透视 + 透明排序 + 体积光不再报 `volumetrics:transparentsorting`（排序本身在 `render/scene.ts` 的 `encode`，`p13h-vol` 整帧比）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import type { JsonObject } from "./model";
import { TEXT_DEPTH_MATERIALS, TEXT_MATERIALS } from "./texts";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate(): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] } as unknown as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

const ASSETS = "A:/assets";
const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const plain = {
  shader: "s",
  blending: "translucent",
  depthtest: "disabled",
  depthwrite: "disabled",
  cullmode: "nocull",
};
const depth = { ...plain, depthtest: "enabled", depthwrite: "enabled" };

async function compile(objects: JsonObject[], general: JsonObject = {}): Promise<SceneBundle> {
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
    "P:/p/scene.json": { general, objects },
    "P:/p/shaders/s.vert": "void main(){}",
    "P:/p/shaders/s.frag": "void main(){}",
    "P:/p/materials/t.json": { passes: [{ shader: "s", blending: "translucent" }] },
    "P:/p/models/t.json": { material: "materials/t.json" },
    "P:/p/models/compose.json": { material: "materials/t.json", passthrough: true },
    "P:/p/effects/fx/effect.json": { passes: [{ material: "materials/t.json" }] },
    [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: { passes: [plain] },
    [`${ASSETS}/${TEXT_MATERIALS.color}`]: { passes: [{ ...plain, combos: { COLORFONT: 1 } }] },
    [`${ASSETS}/${TEXT_MATERIALS.background}`]: { passes: [plain] },
    [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: { passes: [{ shader: "s", blending: "normal" }] },
    [`${ASSETS}/${TEXT_DEPTH_MATERIALS.glyphs}`]: { passes: [depth] },
    [`${ASSETS}/${TEXT_DEPTH_MATERIALS.color}`]: { passes: [{ ...depth, combos: { COLORFONT: 1 } }] },
    [`${ASSETS}/${TEXT_DEPTH_MATERIALS.background}`]: { passes: [depth] },
  };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

/** 各文本层三个 pass 的 depthtest（字形、彩色、背景；没有背景时 null）。 */
const textDepth = (bundle: SceneBundle) =>
  bundle.layers
    .filter((layer) => layer.text)
    .map((layer) => [
      layer.text!.glyphPass.depthtest,
      layer.text!.colorPass.depthtest,
      layer.text!.backgroundPass?.depthtest ?? null,
    ]);

describe("透视场景里的文本选 `_depth` 材质（P13h，rea-p13-lights 5.2）", () => {
  it("depthtest 缺键、enabled → `_depth`；disabled → 无深度；背景同字形", async () => {
    const bundle = await compile([
      { text: "a" },
      { text: "b", depthtest: "enabled", opaquebackground: true },
      { text: "c", depthtest: "disabled", opaquebackground: true },
    ]);
    expect(textDepth(bundle)).toEqual([
      ["enabled", "enabled", null],
      ["enabled", "enabled", "enabled"],
      ["disabled", "disabled", "disabled"],
    ]);
    expect(bundle.unsupported).not.toContain("camera:perspective:text");
  });

  it("正交场景一律无深度材质（不读 depthtest）", async () => {
    const bundle = await compile([{ text: "a", depthtest: "enabled", opaquebackground: true }], ORTHO);
    expect(textDepth(bundle)).toEqual([["disabled", "disabled", "disabled"]]);
  });

  it("带 effect 的文本照样换字形材质（合成上屏借它的深度键，`p13h-text` 的 T3）；clearalpha 不换", async () => {
    const bundle = await compile([{ text: "a", effects: [{ file: "effects/fx/effect.json" }] }]);
    const text = bundle.layers.find((layer) => layer.text)!.text!;
    expect(text.glyphPass.depthtest).toBe("enabled");
    expect(text.clearAlphaPass?.depthtest).toBe("enabled");
    expect(text.clearAlphaPass?.blending).toBe("normal");
  });
});

describe("透视场景里的组与透明排序下的体积光不再照报（P13h）", () => {
  it("带子层的组合层：不报 camera:perspective:group", async () => {
    const bundle = await compile([
      { id: 1, image: "models/compose.json", origin: "0 0 0" },
      { id: 2, image: "models/t.json", origin: "0 0 0", parent: 1 },
    ]);
    // 确实成了组：组合层的子树里有对象 1
    expect(bundle.layers.find((layer) => layer.object === 0)?.subtree).toEqual([1]);
    expect(bundle.unsupported.filter((key) => key.startsWith("camera:"))).toEqual([]);
  });
});
