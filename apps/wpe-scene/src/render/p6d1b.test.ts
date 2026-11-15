/**
 * P6d1b：脚本写材质的五个状态字段，运行中就地换管线（`.claude/plans/wpe-import/3-scene/phase6/phase-6d1-hierarchy-effects.md` 点 8，
 * 读码 `rea-p6d1-matstate.md`，实测 `ignore/p6/d0/out/p6d1-round2.log` 的 `p6d1-mat7` / `p6d1-a2c`）：
 * - `SceneState.writePassState`：规整、只存写过的字段、写入当场标脏、同值也标、不在 bundle 里的 pass 不收；脚本写入表的键与重放；
 * - `applyPassStates` + `planLayer`（规划取有效值）：中间 pass 的混合 / 剔除 / 深度跟着改；最后上屏 pass 的混合与深度仍借基础材质、剔除用自己
 *   （`p6d1-mat7` 的四个 pass）；translucent / additive 关深度写；没有覆盖时与原图层同一个对象；
 * - `GpuScene`（假设备）：写入后重建出的管线描述符与「把同样的值写进 bundle 整场编译」逐项相同；程序不换，`alphatocoverage` 用 A2C 入口；
 *   管线现建期间保持原状态、建好后下一次 `sync` 换上；不写就不重建，写过的不是每帧重建。
 * 假设备照 `render/p5d-depth.test.ts`。
 */
import { fakeModule } from "../script/testing/fakeModule";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type SceneBinding } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass } from "../compile/bundle";
import { PASS_STATE_FIELDS, type PassStateField } from "../compile/passState";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { ScriptRuntime, targetKey, type ScriptRealm, type ScriptTarget, type ScriptValue } from "../script/runtime";
import { writeScriptState } from "../script/stateWrite";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer, type DrawStep } from "./graph";
import { applyPassStates, withPassState } from "./passState";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写的图层 ————

const BASE = "objects/0/passes/0";
const E = (k: number) => `objects/0/effects/0/passes/${k}`;

function passOf(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}

/** 基础材质：translucent、测深度不写（`p6d1-mat7` 的实心层借给上屏 pass 的那份）。 */
const baseOf = (extra: Partial<ScenePass> = {}) =>
  passOf(BASE, { blending: "translucent", depthtest: "enabled", depthwrite: "disabled", ...extra });

/** `passCount` 个绘制 pass 的 effect（blur 是 4 个）；`extra` 按 pass 下标给出 bundle 里的写法。 */
function effectOf(passCount: number, extra: Record<number, Partial<ScenePass>> = {}): SceneEffect {
  return {
    source: 0,
    id: 50,
    name: "blur",
    file: "effects/blur/effect.json",
    fbos: [],
    steps: Array.from({ length: passCount }, (_, k) => ({
      kind: "draw" as const,
      pass: passOf(E(k), extra[k]),
      target: null,
      compose: false,
      binds: null,
    })),
    enabled: true,
    visibleBound: false,
    unsupported: [],
  } as SceneEffect;
}

function layerOf(base: ScenePass, effect: SceneEffect): SceneLayer {
  return {
    id: 10,
    object: 0,
    parent: null,
    name: "B",
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: true,
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
    passes: [base],
    colorBlendMode: 0,
    effects: [effect],
    passthrough: null,
    particle: null,
  } as unknown as SceneLayer;
}

const draws = (plan: ReturnType<typeof planLayer>) =>
  plan.steps.filter((step): step is DrawStep => step.kind === "draw");
const byKey = (plan: ReturnType<typeof planLayer>, key: string) => draws(plan).find((step) => step.pass.key === key)!;

// ———— SceneState ————

/** 状态用的最小 bundle：一个图层，基础 pass 与一个 4 pass 的 effect（常量表里要有这些 pass 才收写入）。 */
function stateBundle(layer: SceneLayer): SceneBundle {
  return bundleOf([layer]);
}

describe("SceneState.writePassState：规整、只存写过的、写入当场标脏", () => {
  const layer = () => layerOf(baseOf(), effectOf(4));

  it("值按字段的表规整；只存写过的字段；规范名", () => {
    const state = SceneState.fromBundle(stateBundle(layer()));
    expect(state.writePassState(E(0), "blending", "additive")).toBe(true);
    expect(state.writePassState(E(0), "depthtest", "less")).toBe(true); // 非法 → disabled
    expect(state.writePassState(E(0), "alphawriting", "Enabled")).toBe(true); // 非法 → default
    expect(state.passStates.get(E(0))).toEqual({
      blending: "additive",
      depthtest: "disabled",
      alphawriting: "default",
    });
    expect(state.passStates.has(E(1))).toBe(false);
  });

  it("null / undefined 不写、不标脏；不在 bundle 里的 pass 不收", () => {
    const state = SceneState.fromBundle(stateBundle(layer()));
    state.takeDirty();
    expect(state.writePassState(E(0), "blending", null)).toBe(false);
    expect(state.writePassState(E(0), "blending", undefined)).toBe(false);
    expect(state.writePassState("objects/0/effects/9/passes/0", "blending", "additive")).toBe(false);
    expect(state.writePassState("bloom/downsample", "blending", "additive")).toBe(false);
    expect(state.passStates.size).toBe(0);
    expect(state.takeDirty().passStates.size).toBe(0);
  });

  it("写入当场把图层记进 dirty.passStates，取走即清；同值也记，只在写入时记（不是每次取走都有）", () => {
    const state = SceneState.fromBundle(stateBundle(layer()));
    state.writePassState(E(1), "cullmode", "normal");
    expect([...state.takeDirty().passStates]).toEqual([0]);
    expect(state.takeDirty().passStates.size).toBe(0);
    state.writePassState(E(1), "cullmode", "normal");
    expect([...state.takeDirty().passStates]).toEqual([0]);
    expect(state.takeDirty().passStates.size).toBe(0);
  });

  it("经 SceneState.write 的 pass-state 目标写入（脚本路径），条件不看", () => {
    const state = SceneState.fromBundle(stateBundle(layer()));
    const binding = (field: PassStateField): SceneBinding => ({
      property: "",
      condition: "ignored",
      target: { kind: "pass-state", pass: E(2), field },
    });
    expect(state.write(binding("blending"), "alphatocoverage")).toBe("applied");
    expect(state.passStates.get(E(2))).toEqual({ blending: "alphatocoverage" });
  });
});

describe("脚本写入表：键 <pass>/state/<字段>，重编译后重放", () => {
  it("targetKey；同键后写的覆盖先写的；重放对新状态再写一遍", () => {
    const target = { kind: "pass-state" as const, pass: E(0), field: "blending" as const };
    expect(targetKey(target)).toBe(`${E(0)}/state/blending`);
    expect(targetKey({ ...target, field: "cullmode" })).toBe(`${E(0)}/state/cullmode`);

    const writes: { target: unknown; value: unknown; source: string }[] = [];
    const realm = {
      global: {},
      prototypes: {},
      internal: {},
      async prepareModule() {
        return fakeModule({});
      },
      dispose() {},
    } as unknown as ScriptRealm;
    const runtime = new ScriptRuntime(realm, {
      report: { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} },
      read: () => null,
      write: (t: ScriptTarget, value: ScriptValue, source: string) => {
        writes.push({ target: t, value, source });
        return true;
      },
      enterScript() {},
      setProperties() {},
    } as never);
    runtime.rememberWrite(target, "additive");
    runtime.rememberWrite(target, "translucent");
    runtime.rememberWrite({ ...target, field: "cullmode" }, "nocull");
    runtime.replayWrites();
    expect(writes.map((item) => [targetKey(item.target as typeof target), item.value, item.source])).toEqual([
      [`${E(0)}/state/blending`, "translucent", "script-replay"],
      [`${E(0)}/state/cullmode`, "nocull", "script-replay"],
    ]);

    // 重编译后的新状态：重放的目标经 `writeScriptState` 写回覆盖
    const fresh = SceneState.fromBundle(stateBundle(layerOf(baseOf(), effectOf(4))));
    for (const item of writes) writeScriptState(fresh, item.target as typeof target, item.value as string);
    expect(fresh.passStates.get(E(0))).toEqual({ blending: "translucent", cullmode: "nocull" });
  });
});

// ———— 规划取有效值 ————

describe("applyPassStates / withPassState", () => {
  it("没有覆盖：返回同一个对象（规划结果与签名和改前逐字节相同）", () => {
    const layer = layerOf(baseOf(), effectOf(4));
    expect(applyPassStates(layer, new Map())).toBe(layer);
    expect(applyPassStates(layer, new Map([["objects/0/effects/0/passes/9", { blending: "additive" }]]))).toBe(layer);
    const pass = layer.passes[0];
    expect(withPassState(pass, undefined)).toBe(pass);
    expect(withPassState(pass, {})).toBe(pass);
  });

  it("只替换被写过的 pass，其余的 pass / effect 对象保持原样；bundle 不被改动", () => {
    const layer = layerOf(baseOf(), effectOf(4));
    const next = applyPassStates(layer, new Map([[E(1), { cullmode: "normal" }]]));
    expect(next).not.toBe(layer);
    expect(next.passes[0]).toBe(layer.passes[0]);
    const [a, b, c] = [0, 1, 2].map((k) => next.effects[0].steps[k]);
    expect(a).toBe(layer.effects[0].steps[0]);
    expect(c).toBe(layer.effects[0].steps[2]);
    expect(b).not.toBe(layer.effects[0].steps[1]);
    expect(layer.effects[0].steps[1].kind === "draw" && layer.effects[0].steps[1].pass.cullmode).toBe("nocull");
  });

  it("alphawriting：enabled / disabled 写进 alphaWriting，default 与编译期一样不留这个键", () => {
    const pass = baseOf({ alphaWriting: "enabled" });
    expect(withPassState(pass, { alphawriting: "disabled" }).alphaWriting).toBe("disabled");
    expect("alphaWriting" in withPassState(pass, { alphawriting: "default" })).toBe(false);
    expect(withPassState(baseOf(), { alphawriting: "enabled" }).alphaWriting).toBe("enabled");
  });

  it("五个字段逐个落到 ScenePass 的对应字段", () => {
    const pass = withPassState(passOf("objects/0/passes/0"), {
      blending: "additive",
      cullmode: "normal",
      depthtest: "enabled",
      depthwrite: "enabled",
      alphawriting: "enabled",
    });
    expect(pass).toMatchObject({
      blending: "additive",
      cullmode: "normal",
      depthtest: "enabled",
      depthwrite: "enabled",
      alphaWriting: "enabled",
    });
    expect(PASS_STATE_FIELDS).toHaveLength(5);
  });
});

describe("规划取有效值（p6d1-mat7 的四个 pass：blur 的 pass 0–3，基础材质 translucent、测深度不写）", () => {
  const layer = () => layerOf(baseOf(), effectOf(4));
  const states = new Map([
    [E(0), { blending: "additive" }],
    [E(1), { blending: "normal", cullmode: "normal" }], // 'disabled' 写成 normal；cullmode normal
    [E(2), { alphawriting: "enabled", depthtest: "enabled", depthwrite: "enabled" }],
    [E(3), { blending: "additive", cullmode: "normal" }],
  ]);
  const before = planLayer(layer(), []);
  const after = planLayer(applyPassStates(layer(), states), []);

  it("基线：中间 pass normal、不剔除、不测深度；上屏 pass 的混合与深度借基础材质（translucent、测不写）", () => {
    expect(byKey(before, E(0)).blending).toBe("normal");
    expect(byKey(before, E(0)).raster).toEqual({ test: false, write: false, cull: false });
    expect(byKey(before, E(3)).blending).toBe("translucent");
    expect(byKey(before, E(3)).raster).toEqual({ test: true, write: false, cull: false });
  });

  it("pass 0 blending = additive：中间 pass 的混合当场改了", () => {
    expect(byKey(after, E(0)).blending).toBe("additive");
  });

  it("pass 1 cullmode = normal：剔除 Back", () => {
    expect(byKey(after, E(1)).raster.cull).toBe(true);
    expect(byKey(after, E(1)).blending).toBe("normal");
  });

  it("pass 2 alphawriting / depthtest / depthwrite = enabled：测、写深度，写 alpha 的覆盖进了 pass", () => {
    expect(byKey(after, E(2)).raster).toEqual({ test: true, write: true, cull: false });
    expect(byKey(after, E(2)).pass.alphaWriting).toBe("enabled");
  });

  it("pass 3（最后上屏）：blending 写入不进管线（借基础材质的 translucent），cullmode 用自己的", () => {
    expect(byKey(after, E(3)).blending).toBe("translucent");
    expect(byKey(after, E(3)).raster).toEqual({ test: true, write: false, cull: true });
  });

  it("上屏 pass 上写 depthtest / depthwrite 不影响深度（借基础材质）", () => {
    const next = planLayer(
      applyPassStates(layer(), new Map([[E(3), { depthtest: "disabled", depthwrite: "enabled" }]])),
      [],
    );
    expect(byKey(next, E(3)).raster).toEqual({ test: true, write: false, cull: false });
  });

  it("写基础材质的状态：上屏 pass 的混合与深度跟着变（借用取的是当前值）", () => {
    const next = planLayer(
      applyPassStates(layer(), new Map([[BASE, { blending: "additive", depthwrite: "enabled" }]])),
      [],
    );
    expect(byKey(next, E(3)).blending).toBe("additive");
    // additive 关深度写，即使 depthwrite enabled
    expect(byKey(next, E(3)).raster).toEqual({ test: true, write: false, cull: false });
    const opaque = planLayer(
      applyPassStates(layer(), new Map([[BASE, { blending: "normal", depthwrite: "enabled" }]])),
      [],
    );
    expect(byKey(opaque, E(3)).blending).toBe("normal");
    expect(byKey(opaque, E(3)).raster).toEqual({ test: true, write: true, cull: false });
  });

  it("translucent / additive 关深度写，alphatocoverage 同 normal 照写", () => {
    for (const [blending, write] of [
      ["normal", true],
      ["translucent", false],
      ["additive", false],
      ["alphatocoverage", true],
    ] as const) {
      const next = planLayer(
        applyPassStates(layer(), new Map([[E(0), { blending, depthtest: "enabled", depthwrite: "enabled" }]])),
        [],
      );
      expect(byKey(next, E(0)).raster.write, blending).toBe(write);
    }
  });

  it("与「把同样的值写进 bundle 整场编译」得到的计划逐项相同", () => {
    const compiled = layerOf(
      baseOf(),
      effectOf(4, {
        0: { blending: "additive" },
        1: { blending: "normal", cullmode: "normal" },
        2: { alphaWriting: "enabled", depthtest: "enabled", depthwrite: "enabled" },
        3: { blending: "additive", cullmode: "normal" },
      }),
    );
    expect(after).toEqual(planLayer(compiled, []));
  });
});

// ———— GpuScene（假设备） ————

/**
 * 翻译器的片元 WGSL（同 `p8.test.ts` 的 `A2C_FRAGMENT`）：`alphaToCoverageEntry` 要认出入口与 `return`，所以假程序用一份真实形状的。
 */
const FRAGMENT = [
  "struct FragmentOutput {",
  "    @location(0) kb_FragColor: vec4<f32>,",
  "}",
  "",
  "@group(0) @binding(1) ",
  "var g_Texture0_: texture_2d<f32>;",
  "@group(0) @binding(2) ",
  "var kb_sampler_g_Texture0_: sampler;",
  "var<private> v_TexCoord_1: vec2<f32>;",
  "var<private> kb_FragColor: vec4<f32>;",
  "",
  "fn main_1() {",
  "    let _e18 = v_TexCoord_1;",
  "    let _e20 = textureSample(g_Texture0_, kb_sampler_g_Texture0_, _e18.xy);",
  "    kb_FragColor = _e20;",
  "    return;",
  "}",
  "",
  "@fragment ",
  "fn main(@location(0) v_TexCoord: vec2<f32>) -> FragmentOutput {",
  "    v_TexCoord_1 = v_TexCoord;",
  "    main_1();",
  "    let _e25 = kb_FragColor;",
  "    return FragmentOutput(_e25);",
  "}",
  "",
].join("\n");

function program(): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: "// v", entryPoint: "main" },
    fragment: { wgsl: FRAGMENT, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
    uniformBlockSize: 64,
    textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
  } as unknown as TranslateResult;
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
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
    programs: [program()],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface FakePipeline {
  label: string;
  descriptor: GPURenderPipelineDescriptor;
}

class FakeGpu {
  readonly pipelines: FakePipeline[] = [];
  readonly device: GPUDevice;

  constructor() {
    const renderPass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      draw() {},
      drawIndexed() {},
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          size: descriptor.size,
          destroy() {},
        };
        return { ...texture, createView: () => ({ label: texture.label, texture }) };
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => ({
        label: descriptor.label ?? "",
        bytes: new Uint8Array(descriptor.size),
        destroy() {},
      }),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        const pipeline = { label: descriptor.label ?? "", descriptor };
        this.pipelines.push(pipeline);
        return pipeline;
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => renderPass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: { writeBuffer() {}, writeTexture() {}, submit() {}, onSubmittedWorkDone: async () => {} },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

async function open(layer: SceneLayer) {
  const gpu = new FakeGpu();
  const bundle = bundleOf([layer]);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(FRAME, state);
  return { gpu, scene, state };
}

interface InnerDraw {
  passKey: string;
  pipeline: FakePipeline;
  program: { index: number };
  step: { blending: string };
}
const drawsOf = (scene: GpuScene): InnerDraw[] => [...(scene as unknown as { draws: Set<InnerDraw> }).draws];
/**
 * 管线描述符里能比的部分（着色器模块、布局是每个场景自己建的对象，不比身份）：标签、顶点 / 片元入口、颜色目标（格式、混合、写掩码）、
 * 图元（拓扑、剔除、绕序）、深度状态。
 */
const summary = (d: GPURenderPipelineDescriptor) => ({
  label: d.label,
  vertex: d.vertex.entryPoint,
  fragment: d.fragment?.entryPoint,
  targets: d.fragment?.targets,
  primitive: d.primitive,
  depthStencil: d.depthStencil,
});
/** pass 键 → 管线描述符摘要（同一图层的全部 draw）。 */
const descriptors = (scene: GpuScene) =>
  Object.fromEntries(drawsOf(scene).map((draw) => [draw.passKey, summary(draw.pipeline.descriptor)]));
const drawFor = (scene: GpuScene, key: string) => drawsOf(scene).find((draw) => draw.passKey === key)!;

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：写入后重建出的管线与整场按新值编译相同（假设备）", () => {
  const fresh = () => layerOf(baseOf(), effectOf(3));
  /** 把写入的值直接写进 bundle 的同一个 pass（编译期的写法）。 */
  const compiledWith = (key: string, override: Partial<Record<PassStateField, string>>) => {
    const layer = fresh();
    const bump = (pass: ScenePass) => {
      Object.assign(pass, withPassState(pass, override));
      if (!("alphaWriting" in withPassState(pass, override))) delete pass.alphaWriting;
    };
    for (const pass of layer.passes) if (pass.key === key) bump(pass);
    for (const step of layer.effects[0].steps) if (step.kind === "draw" && step.pass.key === key) bump(step.pass);
    return layer;
  };

  // 中间 pass E(0)、E(1) 与最后上屏的 E(2)；每组都在三个 pass 上各写一次
  const CASES: [PassStateField, string][] = [
    ["blending", "additive"],
    ["blending", "translucent"],
    ["blending", "alphatocoverage"],
    ["cullmode", "normal"],
    ["depthtest", "enabled"],
    ["depthwrite", "enabled"],
    ["alphawriting", "enabled"],
    ["alphawriting", "disabled"],
  ];
  for (const [field, value] of CASES)
    for (const key of [E(0), E(1), E(2), BASE])
      it(`${key.replace("objects/0/", "")} ${field} = ${value}`, async () => {
        const { scene, state } = await open(fresh());
        const programBefore = drawFor(scene, key).program;
        state.writePassState(key, field, value);
        scene.sync(state);
        await scene.settlePassStates();
        scene.sync(state);
        const { scene: reference } = await open(compiledWith(key, { [field]: value }));
        expect(descriptors(scene)).toEqual(descriptors(reference));
        // 程序（着色器）不换
        expect(drawFor(scene, key).program).toBe(programBefore);
      });

  it("基础材质的深度与混合：上屏 pass 的管线深度状态跟着变（借用取当前值），与整场按新值编译相同", async () => {
    const override = { blending: "normal", depthwrite: "enabled", depthtest: "enabled" } as const;
    const { scene, state } = await open(fresh());
    const before = descriptors(scene);
    for (const field of ["blending", "depthwrite", "depthtest"] as const)
      state.writePassState(BASE, field, override[field]);
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    const { scene: reference } = await open(compiledWith(BASE, override));
    expect(descriptors(scene)).toEqual(descriptors(reference));
    // 确实变了：最后上屏 pass 在场景目标上，深度状态写 true、混合不再是 translucent
    expect(descriptors(scene)[E(2)]).not.toEqual(before[E(2)]);
    expect(descriptors(scene)[E(2)].depthStencil).toEqual({
      format: "depth32float",
      depthCompare: "greater",
      depthWriteEnabled: true,
    });
  });

  it("blending = alphatocoverage：用 A2C 入口（标签带 a2c、片元入口 kb_a2c_main），程序与加载时同一个", async () => {
    const { scene, state } = await open(fresh());
    const before = drawFor(scene, E(0));
    expect(before.pipeline.descriptor.fragment?.entryPoint).toBe("main");
    state.writePassState(E(0), "blending", "alphatocoverage");
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    const after = drawFor(scene, E(0));
    expect(after.program).toBe(before.program);
    expect(after.pipeline.descriptor.label).toMatch(/ a2c$/);
    expect(after.pipeline.descriptor.fragment?.entryPoint).toBe("kb_a2c_main");
    // 写回 normal：回到普通入口
    state.writePassState(E(0), "blending", "normal");
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    expect(drawFor(scene, E(0)).pipeline.descriptor.fragment?.entryPoint).toBe("main");
  });

  it("管线现建期间保持原状态，建好后的下一次 sync 换上；换上后不再每帧重建", async () => {
    const { scene, state } = await open(fresh());
    const before = drawFor(scene, E(0));
    state.writePassState(E(0), "blending", "additive");
    scene.sync(state);
    // 新组合的管线加载时没备，建好之前画面不变
    expect(drawFor(scene, E(0))).toBe(before);
    await scene.settlePassStates();
    scene.sync(state);
    const after = drawFor(scene, E(0));
    expect(after).not.toBe(before);
    scene.sync(state);
    scene.sync(state);
    expect(drawFor(scene, E(0))).toBe(after);
  });

  it("管线已经备好的组合（写回加载时的值）当帧就换上", async () => {
    const { scene, state } = await open(fresh());
    state.writePassState(E(0), "blending", "additive");
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    const additive = drawFor(scene, E(0));
    // 写回 normal：加载时备过 normal 的管线，不用等
    state.writePassState(E(0), "blending", "normal");
    scene.sync(state);
    expect(drawFor(scene, E(0))).not.toBe(additive);
    const reference = await open(fresh());
    expect(summary(drawFor(scene, E(0)).pipeline.descriptor)).toEqual(
      summary(drawFor(reference.scene, E(0)).pipeline.descriptor),
    );
  });

  it("没写过状态时 sync 不重建任何 draw", async () => {
    const { scene, state } = await open(fresh());
    const before = drawsOf(scene);
    scene.sync(state);
    scene.sync(state);
    expect(drawsOf(scene).every((draw, i) => draw === before[i])).toBe(true);
  });

  it("只重建被写的图层：同一场景里别的图层的 draw 不动", async () => {
    const other = { ...layerOf(baseOf(), effectOf(2)), object: 1, id: 11 } as SceneLayer;
    // 第二个图层的 pass 键用 objects/1/
    other.passes = [passOf("objects/1/passes/0", { blending: "translucent", depthtest: "enabled" })];
    other.effects = [
      {
        ...effectOf(2),
        steps: effectOf(2).steps.map((step, k) =>
          step.kind === "draw" ? { ...step, pass: passOf(`objects/1/effects/0/passes/${k}`) } : step,
        ),
      } as SceneEffect,
    ];
    const gpu = new FakeGpu();
    const bundle = bundleOf([layerOf(baseOf(), effectOf(2)), other]);
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    scene.update(FRAME, state);
    const kept = drawsOf(scene).filter((draw) => draw.passKey.startsWith("objects/1/"));
    state.writePassState(E(0), "cullmode", "normal");
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    for (const draw of kept) expect(drawsOf(scene)).toContain(draw);
  });
});

describe("深度附件：脚本拿得到材质对象（用到 getEffect）时加载就建", () => {
  /** 没有一个 pass 测深度的图层：基础材质 translucent、不测不写。 */
  const flat = () => layerOf(baseOf({ depthtest: "disabled" }), effectOf(3));
  const build = async (usesEffectAccess: boolean) => {
    const gpu = new FakeGpu();
    const bundle = { ...bundleOf([flat()]), scripts: { list: [], usesEffectAccess } };
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    scene.update(FRAME, state);
    return { scene, state };
  };
  const depthOf = (scene: GpuScene) => (scene as unknown as { depthTarget: unknown }).depthTarget;

  it("不用 getEffect：不建（同以前）；用了就建，加载时上屏管线比较恒为 always、不写深度", async () => {
    expect(depthOf((await build(false)).scene)).toBeNull();
    const { scene } = await build(true);
    expect(depthOf(scene)).not.toBeNull();
    expect(descriptors(scene)[E(2)].depthStencil).toEqual({
      format: "depth32float",
      depthCompare: "always",
      depthWriteEnabled: false,
    });
  });

  it("运行中写基础材质 depthtest = enabled：上屏 pass 测深度（借基础材质，GREATER），translucent 仍不写", async () => {
    const { scene, state } = await build(true);
    state.writePassState(BASE, "depthtest", "enabled");
    scene.sync(state);
    await scene.settlePassStates();
    scene.sync(state);
    expect(descriptors(scene)[E(2)].depthStencil).toEqual({
      format: "depth32float",
      depthCompare: "greater",
      depthWriteEnabled: false,
    });
  });
});
