import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SceneBloom } from "../compile/bloom";
import {
  generalDefaults,
  mergeProperties,
  pendingChanges,
  planApply,
  type LayerField,
  type SceneBinding,
  type UserProperty,
} from "../compile/bindings";
import { compileScene, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneScalar } from "../compile/model";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { Wpesl2wgsl } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { planLayer, type TextureRef } from "./graph";
import { eyePosition, layerLocalMatrix, sceneTargetSize, sceneViewProjection, worldMatrixOf } from "./layout";
import type { Mat4 } from "./math";
import type { GpuProgram } from "./programs";
import { checkRenderable, visibleObjects } from "./scene";
import { SceneState, type LayerState } from "./state";
import { drawUniformValues, layerRefreshNames, UniformBlock, type UniformEntry } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const corpus = !!root && existsSync(wasm);

const reader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

const sample = (name: string) => join(root!, "projects", "defaultprojects", name);

async function compileCorpus(dir: string, options: Partial<Parameters<typeof compileScene>[0]> = {}) {
  return compileScene({
    projectDir: dir,
    sceneAssets: [join(root!, "assets")],
    reader,
    translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
    postprocess: "enabled",
    ...options,
  });
}

/** 一个只有基础材质（直接上屏）的合成场景：uniform 覆盖矩阵、颜色组与一个材质常量。 */
const PROGRAM = {
  ok: true,
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 },
    { name: "g_Alpha", type: "f32", declared: "float", offset: 80, size: 4 },
    { name: "g_Tint", type: "vec3<f32>", declared: "vec3", offset: 96, size: 12, meta: { material: "tint" } },
  ],
  uniformBlockSize: 112,
} as unknown as TranslateResult;

const BASE_LAYER: LayerState = {
  origin: [10, 20, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0.3],
  alpha: 0.5,
  color: [0.2, 0.4, 0.6],
  brightness: 1,
  visible: true,
  parallaxDepth: [1, 1],
  parent: null,
};

function scenePass(partial: Partial<ScenePass> = {}): ScenePass {
  return {
    key: "objects/0/passes/0",
    program: 0,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: { g_Tint: [1, 1, 1] },
    framebuffer: false,
    ...partial,
  };
}

function synthetic(
  overrides: Partial<LayerState> = {},
  uniforms: Record<string, number[]> = { g_Tint: [1, 1, 1] },
  extra: Partial<SceneLayer> = {},
): SceneBundle {
  const state: LayerState = { ...BASE_LAYER, ...overrides };
  const layer: SceneLayer = {
    id: 1,
    object: 0,
    name: "a",
    ...state,
    size: [64, 32],
    visibleBound: true,
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [scenePass({ uniforms })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
  return {
    general: {
      width: 64,
      height: 32,
      fields: { ...generalDefaults(), ambientcolor: [0.1, 0.1, 0.1], skylightcolor: [0.2, 0.2, 0.2] },
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layer],
    programs: [PROGRAM],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

/**
 * 按渲染器的规则算出每个 draw 的 uniform 块字节：`planLayer` 排步骤、`drawUniformValues` 组装、`UniformBlock` 打包。
 * 纹理尺寸按槽位来源取（纹理 / 合成 RT），fbo 与快照两侧同一套规则即可（比较的是同构 bundle）。
 */
function uniformBytes(bundle: SceneBundle, state: SceneState): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const viewProjection = sceneViewProjection(bundle.general);
  const [width, height] = sceneTargetSize(bundle.general.width, bundle.general.height, 8192);
  // 世界矩阵按这份状态沿父链算（同 `GpuScene` 一次快照一份缓存）
  const worlds = new Map<number, Mat4>();
  for (const layer of bundle.layers) {
    if (!(layer.visible || layer.visibleBound) || !layer.passes.length) continue;
    const plan = planLayer(layer, bundle.textures);
    const layerState = state.layers.get(layer.object);
    if (!layerState) continue;
    const sizeOf = (ref: TextureRef | undefined) => {
      if (!ref) return undefined;
      if (ref.kind === "texture") return bundle.textures[ref.index];
      if (ref.kind === "composite" && plan.composite) {
        const { width: cw, height: ch } = plan.composite;
        return { width: cw, height: ch, textureWidth: cw, textureHeight: ch };
      }
      return undefined;
    };
    for (const step of plan.steps) {
      if (step.kind !== "draw" || step.pass.program === null) continue;
      const program = bundle.programs[step.pass.program];
      if (!program) continue;
      const slots = Math.max(10, ...(program.textures ?? []).map((texture) => texture.slot + 1));
      const values = drawUniformValues({
        step,
        layer: { ...layerState, size: layer.size },
        world: worldMatrixOf(layer.object, state.layers, worlds),
        constants: state.constants.get(step.pass.key) ?? {},
        viewProjection,
        colorScale: bundle.general.postprocess.hdr ? layerState.brightness : 1,
        screenSize: [width, height],
        textures: Array.from({ length: slots }, (_, slot) => sizeOf(step.inputs[slot])),
        eye: eyePosition(bundle.general),
        ambient: state.general.ambientcolor,
        skylight: state.general.skylightcolor,
      });
      const block = new UniformBlock((program.uniforms ?? []) as UniformEntry[], program.uniformBlockSize ?? 0);
      for (const [name, value] of Object.entries(values)) block.set(name, value);
      out.set(`${step.pass.key}|${step.role}`, new Uint8Array(block.data.slice(0)));
    }
  }
  return out;
}

describe("就地 = 重编译（字节级，合成用例）", () => {
  it("origin / angles / color / alpha 与材质常量写入后与整场重编译一致", () => {
    const bundle = synthetic();
    const state = SceneState.fromBundle(bundle);
    const at = (field: LayerField): SceneBinding["target"] => ({ kind: "layer", object: 0, field });
    const writes: [LayerField, SceneScalar][] = [
      ["origin", "30 40 0"],
      ["angles", "0 0 0.9"],
      ["color", "1 0 0"],
      ["alpha", 0.25],
    ];
    for (const [field, value] of writes) state.write({ property: field, target: at(field) }, value);
    state.write(
      {
        property: "tint",
        target: {
          kind: "constant",
          pass: "objects/0/passes/0",
          material: "tint",
          uniforms: ["g_Tint"],
          type: "vec3",
        },
      },
      "0 1 0",
    );
    const freshBundle = synthetic(
      { origin: [30, 40, 0], angles: [0, 0, 0.9], color: [1, 0, 0], alpha: 0.25 },
      { g_Tint: [0, 1, 0] },
    );
    const fresh = SceneState.fromBundle(freshBundle);
    expect(state.layers.get(0)).toEqual(fresh.layers.get(0));
    expect(state.constants).toEqual(fresh.constants);
    expect(uniformBytes(bundle, state)).toEqual(uniformBytes(freshBundle, fresh));
  });

  it("passthrough 的 g_Color4 与材质自带的 g_UserAlpha 不被图层刷新覆盖", () => {
    const bundle = synthetic(
      {},
      {},
      {
        passthrough: scenePass({
          key: "objects/0/passthrough",
          uniforms: { g_Color4: [1, 1, 1, 1], g_UserAlpha: [0.5] },
        }),
      },
    );
    const state = SceneState.fromBundle(bundle);
    state.write({ property: "alpha", target: { kind: "layer", object: 0, field: "alpha" } }, 0.9);
    expect(state.layers.get(0)?.alpha).toBe(0.9);
    // 刷新时跳过材质值：passthrough 的 g_Color4 / g_UserAlpha 留给材质
    const names = layerRefreshNames(bundle.layers[0].passthrough!.uniforms);
    expect(names).not.toContain("g_Color4");
    expect(names).not.toContain("g_UserAlpha");
    expect(names).toContain("g_Alpha");
    expect(names).toContain("g_ModelViewProjectionMatrix");
    // 组装函数里材质值仍然优先（g_Color4 不会被内置值盖掉）
    const values = drawUniformValues({
      step: { role: "passthrough", inputs: {} },
      layer: { ...state.layers.get(0)!, size: [64, 32] },
      world: layerLocalMatrix(state.layers.get(0)!),
      constants: state.constants.get("objects/0/passthrough") ?? {},
      viewProjection: sceneViewProjection(bundle.general),
      colorScale: 1,
      screenSize: [64, 32],
      textures: [],
      eye: eyePosition(bundle.general),
    });
    expect(values.g_Color4).toEqual([1, 1, 1, 1]);
    expect(values.g_UserAlpha).toEqual([0.5]);
  });
});

describe.skipIf(!corpus)("就地 = 重编译（字节级，本机语料）", () => {
  it("razer_vortex：亮度常量", async () => {
    const before = await compileCorpus(sample("razer_vortex"));
    const state = SceneState.fromBundle(before);
    for (const binding of before.bindings.filter((item) => item.property === "ui_editor_properties_brightness"))
      state.write(binding, 0.6);
    const after = await compileCorpus(sample("razer_vortex"), {
      userProperties: { ui_editor_properties_brightness: 0.6 },
    });
    const fresh = SceneState.fromBundle(after);
    expect(state.constants).toEqual(fresh.constants);
    expect(uniformBytes(before, state)).toEqual(uniformBytes(after, fresh));
  }, 120000);

  it("eagleflag：usershadervalues 的 flagcolor1 → color2", async () => {
    const before = await compileCorpus(sample("eagleflag"));
    const state = SceneState.fromBundle(before);
    for (const binding of before.bindings.filter((item) => item.property === "flagcolor1"))
      state.write(binding, "0 0 1");
    const after = await compileCorpus(sample("eagleflag"), { userProperties: { flagcolor1: "0 0 1" } });
    const fresh = SceneState.fromBundle(after);
    expect(state.constants.get("objects/0/passes/0")?.g_Color2).toEqual([0, 0, 1]);
    expect(state.constants).toEqual(fresh.constants);
    expect(uniformBytes(before, state)).toEqual(uniformBytes(after, fresh));
  }, 120000);
});

describe.skipIf(!corpus)("条件可见（本机语料）", () => {
  it("shimmering_particles：style 由 0 切到 1，object 0 隐藏、1–4 显示；改回复原", async () => {
    const bundle = await compileCorpus(sample("shimmering_particles"), { exhaustive: true });
    const state = SceneState.fromBundle(bundle);
    const style = bundle.bindings.filter((binding) => binding.property === "style");
    expect(style).toHaveLength(5);
    for (const binding of style) state.write(binding, "1");
    expect([0, 1, 2, 3, 4].map((object) => state.layers.get(object)?.visible)).toEqual([false, true, true, true, true]);
    // 5 个图层都绑了可见性：即使当前不可见也要建 GPU 资源
    expect(bundle.layers.filter((layer) => layer.visibleBound)).toHaveLength(5);
    for (const binding of style) state.write(binding, "0");
    expect([0, 1, 2, 3, 4].map((object) => state.layers.get(object)?.visible)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  }, 120000);
});

describe("effect 开关（3c）", () => {
  const closed: SceneEffect = {
    source: 2, // JSON 下标，不是 layer.effects 下标
    id: 1,
    name: "",
    file: "effects/x/effect.json",
    fbos: [],
    steps: [],
    enabled: false,
    visibleBound: true,
    unsupported: [],
  };
  const stateOf = (effect: Partial<SceneEffect>) =>
    SceneState.fromBundle(synthetic({}, undefined, { effects: [{ ...closed, ...effect }] }));
  const binding = (condition?: string): SceneBinding => ({
    property: "fx",
    ...(condition === undefined ? {} : { condition }),
    target: { kind: "effect", object: 0, effect: 2 },
  });

  it("按 scene.json 坐标取开关，不在 bundle 里的算关着", () => {
    const state = stateOf({ enabled: true });
    expect(state.effectEnabled(0, 2)).toBe(true);
    expect(state.effectEnabled(0, 0)).toBe(false);
    expect(state.effectEnabled(1, 2)).toBe(false);
  });

  it("写入记结构脏，值没变不记", () => {
    const state = stateOf({});
    expect(state.write(binding(), false)).toBe("applied");
    expect(state.takeDirty().structures.size).toBe(0);
    expect(state.write(binding(), true)).toBe("applied");
    expect(state.effectEnabled(0, 2)).toBe(true);
    expect(state.takeDirty().structures).toEqual(new Set([0]));
    expect(state.takeDirty().structures.size).toBe(0);
  });

  it("目标不在 bundle 里：什么都不做", () => {
    const state = stateOf({});
    expect(state.write({ property: "x", target: { kind: "effect", object: 0, effect: 0 } }, true)).toBe("applied");
    expect(state.takeDirty().structures.size).toBe(0);
  });

  it("值换算同编译期：有条件比字符串，没条件只有 false 算关", () => {
    const state = stateOf({});
    state.write(binding("1"), 1);
    expect(state.effectEnabled(0, 2)).toBe(true);
    state.write(binding("1"), 0);
    expect(state.effectEnabled(0, 2)).toBe(false);
    state.write(binding("1"), "1");
    expect(state.effectEnabled(0, 2)).toBe(true);
    state.write(binding(), false);
    expect(state.effectEnabled(0, 2)).toBe(false);
    state.write(binding(), 0);
    expect(state.effectEnabled(0, 2)).toBe(true);
  });

  it("打开带不支持项的 effect 返回 recompile，状态不变、不记脏", () => {
    const state = stateOf({ unsupported: ["effect:custom:custom"] });
    expect(state.write(binding(), true)).toBe("recompile");
    expect(state.effectEnabled(0, 2)).toBe(false);
    expect(state.takeDirty().structures.size).toBe(0);
  });

  it("关掉带不支持项的 effect 可以就地（dev 强制渲染才会走到）", () => {
    const state = stateOf({ enabled: true, unsupported: ["effect:custom:custom"] });
    expect(state.needsRecompile(binding(), false)).toBe(false);
    expect(state.write(binding(), false)).toBe("applied");
    expect(state.effectEnabled(0, 2)).toBe(false);
    expect(state.takeDirty().structures).toEqual(new Set([0]));
    // 再打开就要重编译
    expect(state.write(binding(), true)).toBe("recompile");
  });

  it("冻结的图层：开和关都要重编译，同值写不算，别的图层不受影响", () => {
    const state = stateOf({});
    state.freezeLayer(0);
    expect(state.needsRecompile(binding(), true)).toBe(true);
    expect(state.needsRecompile(binding(), false)).toBe(false);
    expect(state.write(binding(), false)).toBe("applied");
    expect(state.write(binding(), true)).toBe("recompile");
    expect(state.effectEnabled(0, 2)).toBe(false);
    expect(state.takeDirty().structures.size).toBe(0);

    const opened = stateOf({ enabled: true });
    opened.freezeLayer(0);
    expect(opened.needsRecompile(binding(), false)).toBe(true);
    expect(opened.needsRecompile(binding(), true)).toBe(false);
    expect(opened.write(binding(), false)).toBe("recompile");
    expect(opened.effectEnabled(0, 2)).toBe(true);

    const other = stateOf({});
    other.freezeLayer(1);
    expect(other.needsRecompile(binding(), true)).toBe(false);
    expect(other.write(binding(), true)).toBe("applied");
    expect(other.takeDirty().structures).toEqual(new Set([0]));
  });

  it("needsRecompile 不改状态：重编译类目标为真，其余按开关判断", () => {
    const state = stateOf({ unsupported: ["effect:custom:custom"] });
    expect(state.needsRecompile(binding(), true)).toBe(true);
    expect(state.needsRecompile(binding(), false)).toBe(false);
    expect(state.needsRecompile(binding("1"), 0)).toBe(false);
    expect(state.needsRecompile(binding("1"), 1)).toBe(true);
    expect(state.effectEnabled(0, 2)).toBe(false);
    expect(state.takeDirty().structures.size).toBe(0);
    expect(
      state.needsRecompile(
        { property: "cbm", target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" } },
        1,
      ),
    ).toBe(true);
    expect(state.needsRecompile({ property: "a", target: { kind: "layer", object: 0, field: "alpha" } }, 1)).toBe(
      false,
    );
  });
});

describe("可见性、泛光与加载期间增量", () => {
  it("visibleObjects：不可见图层整段跳过（含它的快照）", () => {
    const bundle = synthetic();
    bundle.layers.push({
      ...bundle.layers[0],
      id: 2,
      object: 1,
      visible: false,
      visibleBound: true,
    });
    const state = SceneState.fromBundle(bundle);
    expect(visibleObjects(bundle.layers, state)).toEqual([0]);
    state.write({ property: "hide", target: { kind: "layer", object: 0, field: "visible" } }, false);
    expect(visibleObjects(bundle.layers, state)).toEqual([]);
    state.write({ property: "show", target: { kind: "layer", object: 1, field: "visible" } }, true);
    expect(visibleObjects(bundle.layers, state)).toEqual([1]);
  });

  it("checkRenderable 检查 visibleBound 的不可见图层（随时可能显示）", () => {
    const bundle = synthetic();
    bundle.layers[0].visible = false;
    bundle.layers[0].visibleBound = true;
    bundle.layers[0].passes = [{ ...bundle.layers[0].passes[0], program: null }];
    expect(checkRenderable(bundle, new Set(["texture-compression-bc"]))).toEqual(["render:no-program"]);
    // 没有绑定、写死 false 的图层照旧不建
    bundle.layers[0].visibleBound = false;
    expect(checkRenderable(bundle, new Set(["texture-compression-bc"]))).toEqual([]);
  });

  it("SceneState：泛光写入标记脏项，级数取整与编译期一致", () => {
    const state = SceneState.fromBundle(synthetic());
    expect(state.takeDirty()).toEqual({
      layers: new Set(),
      passes: new Set(),
      bloom: false,
      structures: new Set(),
      lights: false,
      particles: new Set(),
      texts: new Set(),
    });
    state.write({ property: "glow", target: { kind: "bloom", field: "hdrStrength" } }, 5);
    state.write({ property: "iters", target: { kind: "bloom", field: "hdrIterations" } }, 3.9);
    state.write({ property: "tint", target: { kind: "bloom", field: "tint" } }, "1 0 0");
    expect(state.bloom.hdrStrength).toBe(5);
    expect(state.bloom.hdrIterations).toBe(3);
    expect(state.bloom.tint).toEqual([1, 0, 0]);
    expect(state.takeDirty().bloom).toBe(true);
    expect(state.takeDirty().bloom).toBe(false);
  });

  describe("SceneState：泛光开关（场景位）", () => {
    const BLOOM_ENABLED: SceneBinding = { property: "b", target: { kind: "bloom-enabled" } };
    /** `chain`：bundle 里有没有泛光链；`flag`：场景位。 */
    function stateOf(level: "disabled" | "enabled" | "ultra", chain: boolean, flag: boolean): SceneState {
      const bundle = synthetic();
      bundle.general.postprocess = {
        level,
        bloomFlag: flag,
        hdrFlag: false,
        bloom: level !== "disabled" && flag,
        hdr: false,
      };
      bundle.bloom = chain ? { hdr: false, passes: {} } : null;
      return SceneState.fromBundle(bundle);
    }

    it("初始值取 bloomFlag，不含档位", () => {
      expect(stateOf("disabled", false, true).bloomEnabled).toBe(true);
      expect(stateOf("enabled", true, false).bloomEnabled).toBe(false);
    });

    it("写入改位、不标脏（encode 每帧读）", () => {
      const state = stateOf("enabled", true, true);
      expect(state.write(BLOOM_ENABLED, false)).toBe("applied");
      expect(state.bloomEnabled).toBe(false);
      expect(state.write(BLOOM_ENABLED, true)).toBe("applied");
      expect(state.bloomEnabled).toBe(true);
      expect(state.takeDirty()).toEqual({
        layers: new Set(),
        passes: new Set(),
        bloom: false,
        structures: new Set(),
        lights: false,
        particles: new Set(),
        texts: new Set(),
      });
    });

    it("condition：按字符串比出布尔", () => {
      const state = stateOf("enabled", true, false);
      const binding: SceneBinding = { ...BLOOM_ENABLED, condition: "2" };
      expect(state.write(binding, 2)).toBe("applied");
      expect(state.bloomEnabled).toBe(true);
      expect(state.write(binding, 1)).toBe("applied");
      expect(state.bloomEnabled).toBe(false);
    });

    it("不是 bool 的值不改位（G4），两个方向都是，也不算要重编译", () => {
      for (const flag of [true, false])
        for (const chain of [true, false]) {
          const state = stateOf("enabled", chain, flag);
          for (const raw of [1, 0, "true", ""]) {
            expect(state.needsRecompile(BLOOM_ENABLED, raw)).toBe(false);
            expect(state.write(BLOOM_ENABLED, raw)).toBe("applied");
            expect(state.bloomEnabled).toBe(flag);
          }
        }
    });

    it("同值不算：没有链时重复写 false、开着时写 true 都不要重编译", () => {
      const off = stateOf("enabled", false, false);
      expect(off.needsRecompile(BLOOM_ENABLED, false)).toBe(false);
      expect(off.write(BLOOM_ENABLED, false)).toBe("applied");
      const on = stateOf("enabled", false, true);
      expect(on.needsRecompile(BLOOM_ENABLED, true)).toBe(false);
      expect(on.write(BLOOM_ENABLED, true)).toBe("applied");
    });

    it("档位允许但没有链：打开要重编译，位当场改（脚本要能读回，K5）；关掉照常改位", () => {
      const state = stateOf("enabled", false, false);
      expect(state.needsRecompile(BLOOM_ENABLED, true)).toBe(true);
      expect(state.write(BLOOM_ENABLED, true)).toBe("recompile");
      expect(state.bloomEnabled).toBe(true);
      // 已经请求过重编译：同值再写不算打开
      expect(state.write(BLOOM_ENABLED, true)).toBe("applied");
      // 场景没有对象时 bloomFlag 为 true 也没有链：关掉不用重编译，再打开要
      const empty = stateOf("enabled", false, true);
      expect(empty.write(BLOOM_ENABLED, false)).toBe("applied");
      expect(empty.bloomEnabled).toBe(false);
      expect(empty.write(BLOOM_ENABLED, true)).toBe("recompile");
    });

    it("档位关闭：没有链也直接改位", () => {
      const state = stateOf("disabled", false, false);
      expect(state.needsRecompile(BLOOM_ENABLED, true)).toBe(false);
      expect(state.write(BLOOM_ENABLED, true)).toBe("applied");
      expect(state.bloomEnabled).toBe(true);
    });

    it("有链：打开不要重编译", () => {
      const state = stateOf("enabled", true, false);
      expect(state.needsRecompile(BLOOM_ENABLED, true)).toBe(false);
      expect(state.write(BLOOM_ENABLED, true)).toBe("applied");
      expect(state.bloomEnabled).toBe(true);
    });
  });

  it("BloomChain：setParams 重写的常量与重新建链相同，级数变了也一样", async () => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4 });
    try {
      const defaults = (): BloomParams => ({ ...BLOOM_DEFAULTS, tint: [1, 1, 1] });
      const bloomPass = (key: string, program: number): ScenePass => ({
        key,
        program,
        blending: "normal",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: {},
        runtime: {},
        uniforms: {},
        framebuffer: false,
      });
      const hdrBloom: SceneBloom = {
        hdr: true,
        passes: {
          downsampleBloom: bloomPass("bloom/downsampleBloom", 0),
          downsample: bloomPass("bloom/downsample", 1),
          upsample: bloomPass("bloom/upsample", 2),
          upsampleCubic: bloomPass("bloom/upsampleCubic", 3),
          combine: bloomPass("bloom/combine", 4),
        },
      };
      const ldrBloom: SceneBloom = {
        hdr: false,
        passes: {
          quarter: bloomPass("bloom/quarter", 0),
          eighth: bloomPass("bloom/eighth", 1),
          blur: bloomPass("bloom/blur", 2),
          combine: bloomPass("bloom/combine", 3),
        },
      };
      const uniforms: UniformEntry[] = [
        { name: "g_RenderVar0", type: "vec4<f32>", offset: 0, size: 16 },
        {
          name: "g_BloomStrength",
          type: "vec2<f32>",
          declared: "vec2",
          offset: 16,
          size: 8,
          meta: { material: "bloomstrength" },
        },
        {
          name: "g_BloomBlend",
          type: "vec4<f32>",
          declared: "vec4",
          offset: 32,
          size: 16,
          meta: { material: "blend" },
        },
        {
          name: "g_BloomTint",
          type: "vec3<f32>",
          declared: "vec3",
          offset: 48,
          size: 12,
          meta: { material: "bloomtint" },
        },
        {
          name: "g_BloomScatter",
          type: "f32",
          declared: "float",
          offset: 60,
          size: 4,
          meta: { material: "scatter" },
        },
      ];
      const program = (index: number) =>
        ({
          index,
          result: { ok: true, uniforms, uniformBlockSize: 64 },
          vertexPacking: { pack: () => new ArrayBuffer(0) },
          textures: [],
          uniformSize: 64,
        }) as unknown as GpuProgram;
      const programs = new Map(Array.from({ length: 5 }, (_, index) => [index, program(index)]));
      const fakeDevice = () => {
        const writes = new Map<string, Uint8Array>();
        let uniform = 0;
        let vertex = 0;
        const device = {
          createTexture: (descriptor: GPUTextureDescriptor) => ({
            label: descriptor.label,
            createView: () => ({}),
          }),
          createSampler: () => ({}),
          createBuffer: (descriptor: GPUBufferDescriptor) => {
            // 桩的 UNIFORM 位：区分 uniform 缓冲与顶点缓冲，两边按创建顺序对齐
            const isUniform = (descriptor.usage & 2) !== 0;
            return { key: `${isUniform ? "uniform" : "vertex"}:${isUniform ? uniform++ : vertex++}` };
          },
          createBindGroup: () => ({}),
          queue: {
            writeBuffer: (buffer: { key: string }, _offset: number, data: ArrayBuffer) => {
              writes.set(buffer.key, new Uint8Array(data.slice(0)));
            },
          },
        } as unknown as GPUDevice;
        return { device, writes };
      };
      const create = (device: GPUDevice, bloom: SceneBloom, params: BloomParams) =>
        BloomChain.create({
          device,
          bloom,
          params,
          programs,
          format: "rgba16float",
          width: 3840,
          height: 2160,
          source: {} as GPUTextureView,
          pipelineFor: async () => ({}) as GPURenderPipeline,
          own: (resource) => resource,
        });
      const uniformWrites = (writes: Map<string, Uint8Array>) =>
        [...writes.entries()].filter(([key]) => key.startsWith("uniform:")).sort(([a], [b]) => a.localeCompare(b));

      const updated: BloomParams = {
        ...defaults(),
        hdrStrength: 5,
        hdrThreshold: 0.7,
        hdrScatter: 1.3,
        tint: [1, 0, 0],
      };
      const other = fakeDevice();
      const fresh = await create(other.device, hdrBloom, updated);
      const before = fakeDevice();
      const applied = await create(before.device, hdrBloom, defaults());
      expect(applied.plan.levels).toBe(8);
      before.writes.clear();
      applied.setParams(updated);
      // 重写的 uniform 缓冲按创建顺序对齐，字节逐一相同
      expect(uniformWrites(before.writes)).toEqual(uniformWrites(other.writes));
      expect(applied.plan.steps.map((step) => step.constants)).toEqual(fresh.plan.steps.map((step) => step.constants));

      // 级数变了：只重写这一级数用到的绘制，字节同样等于按这个级数建链
      const fewer: BloomParams = { ...updated, hdrIterations: 3 };
      const three = fakeDevice();
      const freshThree = await create(three.device, hdrBloom, fewer);
      before.writes.clear();
      applied.setParams(fewer);
      expect(applied.plan.levels).toBe(3);
      expect(uniformWrites(before.writes)).toEqual(uniformWrites(three.writes));
      expect(applied.plan).toEqual(freshThree.plan);

      // LDR 链没有级数概念：改 HDR 的级数什么都不变
      const ldr = await create(fakeDevice().device, ldrBloom, defaults());
      ldr.setParams({ ...defaults(), hdrIterations: 2 });
      expect(ldr.plan.levels).toBe(0);
      expect(ldr.plan.steps.map((step) => step.pass)).toEqual(["quarter", "eighth", "blur", "combine"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("加载期间到达的增量：换上场景后补差，最终状态与一次用全集编译相同", async () => {
    const files: Record<string, string> = {
      "P:/p/project.json": JSON.stringify({
        file: "scene.json",
        general: { properties: { color: { type: "color", value: "1 0 0" }, cbm: { type: "combo", value: 0 } } },
      }),
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 64, height: 32 } },
        objects: [
          {
            id: 1,
            name: "a",
            image: "models/a.json",
            color: { user: "color", value: "1 0 0" },
            colorBlendMode: { user: "cbm", value: 0 },
          },
        ],
      }),
      "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json", width: 64, height: 32 }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "simple" }] }),
    };
    const memory: SceneReader = {
      async readWhole(path) {
        const value = files[path.replace(/\\/g, "/")];
        if (value === undefined) throw new TypeError("Failed to fetch");
        return new TextEncoder().encode(value);
      },
      async readRange(path, start, end) {
        const bytes = await memory.readWhole(path);
        return bytes.slice(start, end);
      },
    };
    const compile = (userProperties: Record<string, unknown>) =>
      compileScene({
        projectDir: "P:/p",
        sceneAssets: ["A:/assets"],
        reader: memory,
        translator: null,
        postprocess: "disabled",
        force: true,
        userProperties,
      });
    const compiledWith = { color: "1 0 0", cbm: 0 };
    const old = await compile(compiledWith);
    const state = SceneState.fromBundle(old);
    // 首包还在编译时又来了两条增量（一条就地、一条要重编译）
    const properties = new Map<string, UserProperty>([
      ["color", { type: "color", value: "1 0 0" }],
      ["cbm", { type: "combo", value: 0 }],
    ]);
    mergeProperties(properties, { color: { type: "color", value: "0 1 0" } });
    mergeProperties(properties, { cbm: { type: "combo", value: 12 } });
    const pending = pendingChanges(properties, compiledWith);
    expect([...pending.keys()].sort()).toEqual(["cbm", "color"]);
    const plan = planApply(old.bindings, pending);
    expect(plan.recompile.map((item) => item.reason)).toEqual(["layer-structure"]);
    expect(plan.writes.map((write) => write.binding.property)).toEqual(["color"]);
    for (const write of plan.writes) state.write(write.binding, write.value);
    const final = await compile({ color: "0 1 0", cbm: 12 });
    const fresh = SceneState.fromBundle(final);
    expect(state.layers.get(0)?.color).toEqual(fresh.layers.get(0)?.color);
    expect(final.layers[0].colorBlendMode).toBe(12);
    // 补差之后没有遗留的差异
    expect(pendingChanges(properties, { color: "0 1 0", cbm: 12 }).size).toBe(0);
  });
});
