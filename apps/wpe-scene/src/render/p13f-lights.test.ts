/**
 * P13f2 灯的运行时（`.claude/plans/wpe-import/3-scene/phase13/phase-13f-fog-lights.md`，p13-REPORT「P13f 的实测」L1–L4）：
 * - 编译期：灯对象进 `bundle.lightObjects`，数值字段绑属性登记就地目标，静态字段挂属性照报 `light:runtime:*`，灯的 `color` 缺省黑；
 * - `lightRecords`：位置与方向取世界矩阵（沿父链），可见性沿父链，排序键取局部 origin，字段与颜色取状态；
 * - `legacyLightInputs`：遗留灯位置沿父链，槽按对象顺序；
 * - `volumetricGeometry`：位置取世界矩阵，字段取状态（float32）；
 * - 脚本 / 属性写入经 `SceneState.write` 落到 `lights`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { legacyLightFrame, sortLights } from "../compile/lights";
import { volumetricGeometry } from "../compile/volumetrics";
import type { Wpesl2wgsl } from "../wpesl2wgsl";
import { legacyLightInputs, lightRecords } from "./lights";
import { SceneState } from "./state";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

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
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

async function compile(objects: unknown[], properties: Record<string, unknown> = {}): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json", general: { properties } },
      "P:/p/scene.json": { general: ORTHO, objects },
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

/** 父对象（空对象）下挂一盏 lpoint、一盏遗留 point；另有一盏不挂的 lpoint。 */
const SCENE = [
  { id: 10, name: "P", origin: "100 0 0", angles: "0 0 0", scale: "1 1 1", visible: true },
  {
    id: 11,
    name: "V",
    light: "lpoint",
    parent: 10,
    origin: "0 5 0",
    color: "1 0.5 0.25",
    intensity: { user: "p_i", value: 2 },
    radius: 7,
  },
  { id: 12, name: "G", light: "point", parent: 10, origin: "0 6 0", color: "1 1 1", intensity: 1, radius: 4 },
  { id: 13, name: "W", light: "lpoint", origin: "-3 0 0", intensity: 1, radius: 2 },
];
const PROPERTIES = { p_i: { type: "slider", value: 2 } };

describe("灯对象的编译期记录（P13f2）", () => {
  it("每个灯对象一条，遗留槽按对象顺序；数值字段绑属性登记就地目标", async () => {
    const bundle = await compile(SCENE, PROPERTIES);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.lightObjects?.map((light) => [light.object, light.kind, light.legacy, light.legacySlot])).toEqual([
      [1, "point", false, 0],
      [2, null, true, 1],
      [3, "point", false, 2],
    ]);
    expect(bundle.bindings.find((binding) => binding.property === "p_i")?.target).toEqual({
      kind: "light",
      object: 1,
      field: "intensity",
    });
  });

  it("灯的 color 缺省黑（图层是白）", async () => {
    const bundle = await compile([{ id: 1, light: "lpoint", intensity: 1 }]);
    expect(SceneState.fromBundle(bundle).layers.get(0)?.color).toEqual([0, 0, 0]);
  });

  it("light / castshadow / usecookie / castvolumetrics 挂属性照报 light:runtime:*", async () => {
    const bundle = await compile([{ id: 1, light: "lpoint", castshadow: { user: "p", value: true } }], {
      p: { type: "bool", value: true },
    });
    expect(bundle.unsupported).toContain("light:runtime:castshadow");
  });
});

describe("每帧的灯记录（P13f2，L1、L2′、L4）", () => {
  it("位置沿父链、排序键取局部 origin、颜色乘强度；父对象挪动或隐藏，记录跟着变", async () => {
    const bundle = await compile(SCENE, PROPERTIES);
    const state = SceneState.fromBundle(bundle);
    const [v, w] = lightRecords(bundle.lightObjects!, state, new Map());
    expect(v.origin).toEqual([100, 5, 0]);
    expect(v.sortOrigin).toEqual([0, 5, 0]);
    expect(v.color).toEqual([2, 1, 0.5]);
    expect(v.radius).toBe(7);
    expect(w.origin).toEqual([-3, 0, 0]);
    state.write({ property: "o", target: { kind: "layer", object: 0, field: "origin" } }, "50 10 0");
    state.write({ property: "v", target: { kind: "layer", object: 0, field: "visible" } }, false);
    const [moved] = lightRecords(bundle.lightObjects!, state, new Map());
    expect(moved.origin).toEqual([50, 15, 0]);
    expect(moved.visible).toBe(false);
  });

  it("排序键用局部 origin：挂在远处父对象下的灯按本地位置排（L2′）", async () => {
    // V 挂在 x = 100 的父下、局部 x = 0；W 不挂、x = 50。视线 +X：按局部 V（0）在 W（50）前，按世界 W（50）在 V（100）前
    const scene = [SCENE[0], SCENE[1], { id: 13, name: "W", light: "lpoint", origin: "50 0 0", intensity: 1 }];
    const bundle = await compile(scene, PROPERTIES);
    const records = lightRecords(bundle.lightObjects!, SceneState.fromBundle(bundle), new Map());
    expect(sortLights(records, [1, 0, 0]).map((light) => light.object)).toEqual([1, 2]);
  });

  it("灯字段写入（属性 / 脚本 / 关键帧同一个 setter）落到状态，float32；布尔不收", async () => {
    const bundle = await compile(SCENE, PROPERTIES);
    const state = SceneState.fromBundle(bundle);
    state.write({ property: "p_i", target: { kind: "light", object: 1, field: "intensity" } }, 0.1);
    expect(state.lights.get(1)?.intensity).toBe(Math.fround(0.1));
    state.write({ property: "x", target: { kind: "light", object: 1, field: "intensity" } }, true);
    expect(state.lights.get(1)?.intensity).toBe(Math.fround(0.1));
    state.write({ property: "c", target: { kind: "light", object: 1, field: "controlpoint" } }, 3);
    expect(state.lights.get(1)?.controlpoint).toEqual([3, 3, 3]);
    const [v] = lightRecords(bundle.lightObjects!, state, new Map());
    expect(v.color[0]).toBe(Math.fround(0.1));
  });

  it("遗留灯：位置沿父链，按槽写", async () => {
    const bundle = await compile(SCENE, PROPERTIES);
    const state = SceneState.fromBundle(bundle);
    const inputs = legacyLightInputs(bundle.lightObjects!, state, new Map());
    expect(inputs.map((item) => [item.slot, item.legacy])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    const values = legacyLightFrame(inputs);
    expect(values.g_LightsPosition.slice(3, 6)).toEqual([100, 6, 0]);
    expect(values.g_LightsColorRadius.slice(4, 8)).toEqual([1, 1, 1, 4]);
  });

  it("体积光几何：位置取世界矩阵，字段取状态（L4）", async () => {
    const bundle = await compile(SCENE, PROPERTIES);
    const state = SceneState.fromBundle(bundle);
    const values = state.lights.get(1)!;
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 700, 300, 200, 1]);
    const geometry = volumetricGeometry("point", values, [1, 0.5, 0.25], world, true);
    expect(geometry.position).toEqual([700, 300, 200]);
    expect(geometry.constants.g_RenderVar2).toEqual([700, 300, 200, 2]);
    expect(geometry.constants.g_RenderVar1[3]).toBe(2);
    expect(geometry.constants.g_AltViewProjectionMatrix.slice(12, 15)).toEqual([700, 300, 200]);
  });
});
