import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SceneBloom } from "../compile/bloom";
import {
  mergeProperties,
  pendingChanges,
  planApply,
  type LayerField,
  type SceneBinding,
  type UserProperty,
} from "../compile/bindings";
import { compileScene, type SceneBundle, type SceneLayer, type ScenePass } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneScalar } from "../compile/model";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { Wpesl2wgsl } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { planLayer, type TextureRef } from "./graph";
import { sceneTargetSize, sceneViewProjection } from "./layout";
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
    passes: [scenePass({ uniforms })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    ...extra,
  };
  return {
    general: {
      width: 64,
      height: 32,
      clearColor: [0, 0, 0],
      clearEnabled: true,
      camera: { eye: [0, 0, 1], center: [0, 0, 0], up: [0, 1, 0] },
      ambient: [0.1, 0.1, 0.1],
      skylight: [0.2, 0.2, 0.2],
      postprocess: { level: "disabled", bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layer],
    programs: [PROGRAM],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
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
        constants: state.constants.get(step.pass.key) ?? {},
        viewProjection,
        colorScale: bundle.general.postprocess.hdr ? layerState.brightness : 1,
        screenSize: [width, height],
        textures: Array.from({ length: slots }, (_, slot) => sizeOf(step.inputs[slot])),
        eye: bundle.general.camera.eye,
        ambient: bundle.general.ambient,
        skylight: bundle.general.skylight,
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
      constants: state.constants.get("objects/0/passthrough") ?? {},
      viewProjection: sceneViewProjection(bundle.general),
      colorScale: 1,
      screenSize: [64, 32],
      textures: [],
      eye: bundle.general.camera.eye,
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
    expect(state.takeDirty()).toEqual({ layers: new Set(), passes: new Set(), bloom: false });
    state.write({ property: "glow", target: { kind: "bloom", field: "hdrStrength" } }, 5);
    state.write({ property: "iters", target: { kind: "bloom", field: "hdrIterations" } }, 3.9);
    state.write({ property: "tint", target: { kind: "bloom", field: "tint" } }, "1 0 0");
    expect(state.bloom.hdrStrength).toBe(5);
    expect(state.bloom.hdrIterations).toBe(3);
    expect(state.bloom.tint).toEqual([1, 0, 0]);
    expect(state.takeDirty().bloom).toBe(true);
    expect(state.takeDirty().bloom).toBe(false);
    // 级数不变时 previewBloom 与写入结果一致（渲染器预检用）
    expect(
      state.previewBloom([{ binding: { property: "x", target: { kind: "bloom", field: "hdrStrength" } }, value: 7 }])
        .hdrStrength,
    ).toBe(7);
    expect(state.bloom.hdrStrength).toBe(5);
  });

  it("BloomChain：级数变了不能就地改；级数不变时 setParams 重写的常量与重新建链相同", async () => {
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

      const first = await create(fakeDevice().device, hdrBloom, defaults());
      expect(first.plan.levels).toBe(8);
      expect(first.sameLevels({ ...defaults(), hdrIterations: 3 })).toBe(false);
      expect(first.sameLevels({ ...defaults(), hdrStrength: 5 })).toBe(true);

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

      // LDR 链没有级数概念，参数怎么改都能就地
      const ldr = await create(fakeDevice().device, ldrBloom, defaults());
      expect(ldr.sameLevels({ ...defaults(), hdrIterations: 2 })).toBe(true);
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
