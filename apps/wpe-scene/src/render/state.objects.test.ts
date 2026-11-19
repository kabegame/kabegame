/**
 * 活的场景图 L3a：`SceneState` 的逐对象增删（`addObject` / `dropObject` / `replaceObject`），手写 bundle，无 GPU。
 * - `fromBundle` = 场景级构造 + 逐个 `install`：与「空 bundle 的状态 + 逐个 `addObject`」在全部表上相同；
 * - `dropObject` 清干净（建删 100 次后各表大小不涨），并清掉运行中写入的常量覆盖与脏集合；
 * - 结构归 `flushDestroy`：对象还在 `order` 里时 `dropObject` 不动 `order` 与子表，被摘掉后才清子表；
 * - `replaceObject` 留 `order` 位置、运行中的父、子表、冻结，运行中的写入回到新切片的初值。
 * 全语料对照在 `ignore/live/l3/registry.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass } from "../compile/bundle";
import type { SceneLightObject } from "../compile/lights";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { SceneSound } from "../compile/sounds";
import { SceneState, type ObjectStateSlice } from "./state";
import { TEXT_DECOR_DEFAULTS } from "../text/fields";

const passOf = (key: string, uniforms: Record<string, number[]> = { g_Alpha: [1] }): ScenePass =>
  ({ key, program: 0, uniforms }) as unknown as ScenePass;

/** 带基础 pass、一个 effect、粒子（含一个子系统）、模型网格与阴影变体、puppet 动画层、文本、对齐的「什么都有」的图层。 */
function fullLayer(object: number, partial: Partial<SceneLayer> = {}): SceneLayer {
  const k = (name: string) => `objects/${object}/${name}`;
  const effect = {
    source: 0,
    id: 1,
    name: "e",
    file: "e.json",
    fbos: [],
    steps: [{ kind: "draw", pass: passOf(k("effects/0/passes/0")) }],
    enabled: true,
    visibleBound: false,
    unsupported: [],
  } as unknown as SceneEffect;
  return {
    id: object + 10,
    object,
    parent: null,
    name: `L${object}`,
    origin: [1, 2, 3],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [200, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    passes: [passOf(k("passes/0"))],
    colorBlendMode: 0,
    effects: [effect],
    passthrough: passOf(k("passthrough")),
    particle: {
      passes: [passOf(k("particle/0"))],
      instance: { rate: 0.001 },
      children: [{ system: { passes: [passOf(k("particle/child/0"))], instance: { rate: 1 } } }],
    },
    model: { meshes: [{ passes: [passOf(k("meshes/0/passes/0"))], shadow: passOf(k("meshes/0/shadow")) }] },
    puppet: { layers: [{ entry: 0, rate: 1, blend: 1, visible: true }] },
    text: {
      glyphPass: passOf(k("text/glyphs")),
      colorPass: passOf(k("text/color")),
      backgroundPass: null,
      clearAlphaPass: null,
      background: { key: k("text/background"), color: [0, 0, 0] },
      fields: { padding: [1, 2], spacing: [3, 4], decor: TEXT_DECOR_DEFAULTS },
    },
    camera: { fov: 50, zoom: 1 },
    alignment: 4,
    ...partial,
  } as unknown as SceneLayer;
}

const soundOf = (object: number): SceneSound => ({ object, volume: 0.5 }) as unknown as SceneSound;
const lightOf = (object: number): SceneLightObject =>
  ({ object, light: "lpoint", values: { intensity: 2 } }) as unknown as SceneLightObject;

const sliceOf = (object: number, partial: Partial<SceneLayer> = {}): ObjectStateSlice => ({
  layer: fullLayer(object, partial),
  sound: soundOf(object),
  light: lightOf(object),
});

function bundleOf(layers: SceneLayer[], extra: Partial<SceneBundle> = {}): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    ...extra,
  } as unknown as SceneBundle;
}

/** 状态的全部表（私有的也比）：Map / Set 按键排序；不比 `structureVersion`。 */
function dump(state: SceneState): unknown {
  const sorted = (value: unknown): unknown => {
    if (value instanceof Map)
      return [...value.entries()]
        .map(([key, item]) => [key, sorted(item)] as const)
        .sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1));
    if (value instanceof Set) return [...value].sort();
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sorted(v)]));
    return value;
  };
  const raw = state as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) if (key !== "structureVersion") out[key] = sorted(raw[key]);
  return JSON.parse(
    JSON.stringify(out, (_key, value) =>
      typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
    ),
  );
}

/** 按对象的表的大小（`dropObject` 清干净的判据）。 */
function sizes(state: SceneState): Record<string, number> {
  const raw = state as unknown as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value instanceof Map || value instanceof Set) out[key] = value.size;
    else if (Array.isArray(value)) out[key] = value.length;
  }
  return out;
}

describe("fromBundle 与逐个 addObject", () => {
  it("全部表相同（有 bundle.children 与没有两种）", () => {
    const layers = [
      fullLayer(0),
      fullLayer(1, { parent: 0 }),
      fullLayer(2, { parent: 0 }),
      fullLayer(3, { parent: 1 }),
    ];
    const sounds = layers.map((layer) => soundOf(layer.object));
    const lights = layers.map((layer) => lightOf(layer.object));
    for (const children of [
      undefined,
      [
        [0, [1, 2]],
        [1, [3]],
      ] as [number, number[]][],
    ]) {
      const whole = SceneState.fromBundle(
        bundleOf(layers, { sounds, lightObjects: lights, ...(children ? { children } : {}) }),
      );
      const incremental = SceneState.fromBundle(bundleOf([], { sounds: [], ...(children ? { children: [] } : {}) }));
      for (const layer of layers)
        incremental.addObject({ layer, sound: soundOf(layer.object), light: lightOf(layer.object) });
      expect(dump(incremental)).toEqual(dump(whole));
      expect(incremental.structureVersion).toBe(layers.length);
      expect(whole.structureVersion).toBe(0);
    }
  });

  it("每类表都有内容（粒子 rate 钳 0.01、对齐尺寸、文本冻结、效果开关、阴影变体）", () => {
    const state = SceneState.fromBundle(bundleOf([fullLayer(0)], { sounds: [soundOf(0)], lightObjects: [lightOf(0)] }));
    const raw = state as unknown as Record<string, Map<unknown, unknown>> & { frozenLayers: Set<number> };
    expect(state.particleInstances.get(0)?.rate).toBe(0.01);
    expect(raw.alignmentSizes.get(0)).toEqual([200, 100]);
    expect(raw.frozenLayers.has(0)).toBe(true);
    expect(state.effectEnabled(0, 0)).toBe(true);
    expect(raw.shadowPasses.get("objects/0/meshes/0/passes/0")).toBe("objects/0/meshes/0/shadow");
    expect(state.constants.get("objects/0/meshes/0/shadow")).toEqual({ g_Alpha: [1] });
    expect(state.constants.has("objects/0/meshes/0/passes/0")).toBe(true);
    expect(state.constants.has("objects/0/particle/child/0")).toBe(true);
    expect(state.constants.has("objects/0/text/background")).toBe(true);
    expect(state.sounds.get(0)).toEqual({ volume: 0.5 });
    expect(state.lights.get(0)).toEqual({ intensity: 2 });
    expect(state.cameras.get(0)).toEqual({ fov: 50, zoom: 1 });
    expect(state.animationLayers.size).toBe(1);
  });

  it("没有图层的声音 / 灯照旧写自己的表；对象已在时 addObject 抛错", () => {
    const state = SceneState.fromBundle(bundleOf([], { sounds: [soundOf(5)], lightObjects: [lightOf(6)] }));
    expect(state.sounds.get(5)).toEqual({ volume: 0.5 });
    expect(state.lights.get(6)).toEqual({ intensity: 2 });
    state.addObject(sliceOf(1));
    expect(() => state.addObject(sliceOf(1))).toThrow();
  });
});

describe("dropObject", () => {
  it("建删 100 次后各表大小不涨", () => {
    const state = SceneState.fromBundle(bundleOf([fullLayer(0)], { sounds: [soundOf(0)], lightObjects: [lightOf(0)] }));
    const before = sizes(state);
    for (let i = 1; i <= 100; i++) {
      state.addObject(sliceOf(i, { parent: i % 2 === 0 ? 0 : i - 1 }));
      // 运行中的写入也不能留下残渣：常量覆盖、脏集合、动画层字段
      state.markDestroy(i);
      expect(state.flushDestroy()).toEqual([i]);
      state.dropObject(i);
    }
    expect(sizes(state)).toEqual(before);
    expect(state.order).toEqual([0]);
  });

  it("清掉常量、effect 开关、阴影变体、动画层、文本字段，也清脏集合与运行中写的材质状态", () => {
    const state = SceneState.fromBundle(bundleOf([fullLayer(0), fullLayer(1)]));
    const raw = state as unknown as Record<string, Map<unknown, unknown> | Set<unknown>>;
    state.passStates.set("objects/1/passes/0", { blending: "additive" });
    (raw.dirtyPasses as Set<unknown>).add("objects/1/passes/0");
    (raw.dirtyLayers as Set<unknown>).add(1);
    (raw.dirtyParticles as Set<unknown>).add(1);
    state.markDestroy(1);
    state.flushDestroy();
    state.dropObject(1);
    for (const key of [
      "constants",
      "passStates",
      "effects",
      "shadowPasses",
      "dirtyPasses",
      "dirtyLayers",
      "dirtyParticles",
      "textFields",
      "frozenLayers",
      "owned",
    ])
      for (const entry of raw[key]) {
        const text = JSON.stringify(Array.isArray(entry) ? entry[0] : entry);
        expect(text).not.toMatch(/objects\/1\/|^"1\/|^1$/);
      }
    expect([...state.layers.keys()]).toEqual([0]);
    // 对象 0 的表原样
    expect(state.constants.has("objects/0/passes/0")).toBe(true);
    expect(state.effectEnabled(0, 0)).toBe(true);
  });

  it("还在 order 里时不动 order 与子表；被 flushDestroy 摘掉后才清子表；没有 flushDestroy 的游离对象也清", () => {
    const state = SceneState.fromBundle(
      bundleOf([fullLayer(0), fullLayer(1, { parent: 0 }), fullLayer(2, { parent: 1 })]),
    );
    state.dropObject(1);
    expect(state.order).toEqual([0, 1, 2]);
    expect(state.childrenOf(0)).toEqual([1]);
    expect(state.childrenOf(1)).toEqual([2]);
    // 已不在 order 里：确保不在任何子表里、没有自己的子表
    state.order.splice(1, 1);
    state.dropObject(1);
    expect(state.childrenOf(0)).toEqual([]);
    expect(state.childrenOf(1)).toEqual([]);
    expect(state.childrenOf(2)).toEqual([]);
  });
});

describe("replaceObject", () => {
  it("留 order 位置、运行中的父、子表与冻结，运行中的写入回到新切片的初值", () => {
    const state = SceneState.fromBundle(
      bundleOf([fullLayer(0), fullLayer(1, { parent: 0, text: undefined }), fullLayer(2, { parent: 1 })], {
        sounds: [soundOf(1)],
      }),
    );
    // 运行中：1 换到根下、改常量、冻结
    state.setParent(1, null);
    state.constants.get("objects/1/passes/0")!.g_Alpha = [0.25];
    state.freezeLayer(1);
    const orderBefore = [...state.order];
    const versionBefore = state.structureVersion;
    state.replaceObject({
      layer: fullLayer(1, { parent: 0, text: undefined, passes: [passOf("objects/1/passes/9", { g_Alpha: [0.75] })] }),
      sound: soundOf(1),
    });
    expect(state.order).toEqual(orderBefore);
    expect(state.layers.get(1)!.parent).toBeNull();
    expect(state.childrenOf(0)).toEqual([]);
    expect(state.childrenOf(1)).toEqual([2]);
    expect((state as unknown as { frozenLayers: Set<number> }).frozenLayers.has(1)).toBe(true);
    // 新切片的初值：旧 pass 键消失、新的进来
    expect(state.constants.has("objects/1/passes/0")).toBe(false);
    expect(state.constants.get("objects/1/passes/9")).toEqual({ g_Alpha: [0.75] });
    expect(state.structureVersion).toBeGreaterThan(versionBefore);
    expect(() => state.replaceObject(sliceOf(9))).toThrow();
  });

  it("同一切片替换后全部表与替换前相同（运行中没写过的前提下）", () => {
    const layers = [fullLayer(0), fullLayer(1, { parent: 0 }), fullLayer(2, { parent: 0 })];
    const sounds = layers.map((layer) => soundOf(layer.object));
    const lights = layers.map((layer) => lightOf(layer.object));
    const state = SceneState.fromBundle(bundleOf(layers, { sounds, lightObjects: lights }));
    const before = dump(state);
    for (const layer of layers)
      state.replaceObject({
        layer: fullLayer(layer.object, { parent: layer.parent }),
        sound: soundOf(layer.object),
        light: lightOf(layer.object),
      });
    expect(dump(state)).toEqual(before);
  });
});
