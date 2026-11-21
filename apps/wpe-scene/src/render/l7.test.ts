/**
 * 活的场景图 L7（`.claude/plans/wpe-import/3-scene/live/phase-l7-restructure.md` 点 4）：`GpuScene.restructure` 按「谁变了」当帧重排。
 * 登记表（`SceneRegistry`）与渲染器共用同一份 `SceneLayer`：用例改状态里的父 → `registry.restructure` → `scene.restructure(changed)` → `sync` /
 * `flushRestructure` → 编码一帧，看绘制落在哪张目标、用哪条管线：
 * - 进组：子层的绘制画进组的合成 RT、管线换成组里的（写 alpha、没有深度，同步建），顶层不再画它；
 * - 没有子层的组合层成了组：借到合成 RT、子树画进去、`groupUpload` 上屏（它的程序加载时另外备好）；
 * - 出组：回到顶层，管线换回带深度的；
 * - 删组：当帧剩下的子层由顶层画；
 * - 嵌套组换归属：组里子孙的合成 RT 换到按层数分开的池；
 * - 挂点表随 `layer.attachment` 更新；组的子表只换顺序时不重建（`rebuildStats` 不增），子树按新顺序画；
 * - 重排失败（回到顶层而场景没有深度附件）抛错并卸掉那个对象；粒子层进组沿用粒子树；模型层进组（P14b）网格画进组 RT、管线换成没有深度的。
 * 假设备照 `p5b-group.test.ts`：模拟 WebGPU 会拒绝的情况（拷贝用途、pass 嵌套、在已结束的 pass 上编码、管线格式 / 深度和 pass 不符、同一张纹理既是
 * 目标又被采样），任何一条都抛错；同步与异步建管线都记下来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
import { parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { SceneRegistry } from "../compile/registry";
import type { TranslateResult } from "../wpesl2wgsl";
import { SceneRenderError } from "./errors";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备 ————

interface FakeTexture {
  label: string;
  format: string;
  usage: number;
  destroy(): void;
}
interface FakeView {
  label: string;
  texture: FakeTexture;
}
interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}
interface FakePipeline {
  label: string;
  format: string;
  depth: boolean;
  writeMask: number | undefined;
}

class FakeGpu {
  readonly trace: string[] = [];
  readonly counts = { sync: 0, async: 0 };
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const fail = (message: string): never => {
      throw new Error(`WebGPU 校验：${message}`);
    };
    let open: { ended: boolean } | null = null;
    const renderPass = (attachment: FakeTexture, depth: boolean) => {
      const state = { ended: false };
      const live = () => {
        if (state.ended) fail(`在已结束的 pass（${attachment.label}）上编码`);
      };
      open = state;
      return {
        setViewport: live,
        setPipeline(pipeline: FakePipeline) {
          live();
          if (pipeline.format !== attachment.format)
            fail(`管线格式 ${pipeline.format} 和目标 ${attachment.label}（${attachment.format}）不符`);
          if (pipeline.depth !== depth)
            fail(`管线 ${pipeline.label} 的深度状态和 pass（${attachment.label}）的深度附件不符`);
          trace.push(`  pipeline ${pipeline.label}`);
        },
        setBindGroup(_index: number, group: { views: FakeView[] }) {
          live();
          for (const view of group.views)
            if (view.texture === attachment) fail(`${attachment.label} 在同一个 pass 里既是目标又被采样`);
        },
        setVertexBuffer(_slot: number, buffer: FakeBuffer) {
          live();
          trace.push(`  draw ${buffer.label}`);
        },
        setIndexBuffer: live,
        draw: live,
        drawIndexed: live,
        end() {
          live();
          state.ended = true;
          open = null;
        },
      };
    };
    const pipeline = (descriptor: GPURenderPipelineDescriptor): FakePipeline => {
      const target = [...descriptor.fragment!.targets][0]!;
      return {
        label: `${descriptor.label} mask ${target.writeMask}`,
        format: target.format,
        depth: !!descriptor.depthStencil,
        writeMask: target.writeMask,
      };
    };
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          usage: descriptor.usage,
          destroy() {},
          createView: (): FakeView => ({ label: texture.label, texture }),
        };
        return texture;
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
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
        this.counts.sync++;
        return pipeline(descriptor);
      },
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        this.counts.async++;
        return pipeline(descriptor);
      },
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({
        views: [...descriptor.entries]
          .map((entry) => entry.resource as unknown as Partial<FakeView>)
          .filter((resource): resource is FakeView => !!resource && "texture" in resource),
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          if (open) fail("上一个 render pass 还没结束");
          const attachment = [...descriptor.colorAttachments][0]!;
          const view = attachment.view as unknown as FakeView;
          if (!(view.texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)) fail(`${view.label} 没有 RENDER_ATTACHMENT`);
          trace.push(`pass ${view.label} ${attachment.loadOp}`);
          return renderPass(view.texture, !!descriptor.depthStencilAttachment);
        },
        copyTextureToTexture: (source: { texture: FakeTexture }, target: { texture: FakeTexture }) => {
          if (open) fail("render pass 开着时拷贝");
          if (!(source.texture.usage & GPUTextureUsage.COPY_SRC)) fail(`${source.texture.label} 没有 COPY_SRC`);
          if (!(target.texture.usage & GPUTextureUsage.COPY_DST)) fail(`${target.texture.label} 没有 COPY_DST`);
          if (source.texture === target.texture) fail(`${source.texture.label} 拷给自己`);
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
        },
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  /** 编码一帧，返回这一帧的轨迹。 */
  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

// ———— 夹具（同 `p5b-group.test.ts`） ————

/** 程序下标：composelayer、effect（kbfx）、图像、组的上屏（effectpassthrough）、粒子。 */
const PROGRAM = { compose: 0, effect: 1, image: 2, upload: 3, particle: 4 } as const;

function program(name: string, slots: number[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [
      { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
      { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
    ],
    uniformBlockSize: 128,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}
const PARTICLE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// particle v", entryPoint: "main" },
  fragment: { wgsl: "// particle f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", location: 0, type: "vec3" },
    { name: "a_TexCoordVec4", location: 1, type: "vec4" },
    { name: "a_Color", location: 2, type: "vec4" },
    { name: "a_TexCoordC2", location: 3, type: "vec2" },
  ],
  uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
  uniformBlockSize: 64,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.image,
    blending: "translucent",
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

function kbfx(object: number): SceneEffect {
  return {
    source: 0,
    id: 50,
    name: "kbfx",
    file: "effects/kbfx/effect.json",
    fbos: [],
    steps: [
      {
        kind: "draw",
        pass: pass(`objects/${object}/effects/0/passes/0`, { program: PROGRAM.effect, blending: "normal" }),
        target: null,
        compose: false,
        binds: null,
      },
    ],
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
}

function image(object: number, name: string, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name,
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
    passes: [pass(`objects/${object}/passes/0`)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** 组合层（composelayer，槽 0 读快照），带 `groupUpload`；`size` 给了合成 RT 的尺寸。 */
function compose(object: number, name: string, size: number[], extra: Partial<SceneLayer> = {}): SceneLayer {
  return image(object, name, {
    size,
    solidLayer: false,
    passthroughModel: true,
    passes: [
      pass(`objects/${object}/passes/0`, {
        program: PROGRAM.compose,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    groupUpload: pass(`objects/${object}/groupupload`, {
      program: PROGRAM.upload,
      blending: "normal",
      uniforms: { g_Color4: [1, 1, 1, 1] },
    }),
    ...extra,
  });
}

/** 深度测试开着、additive 混合的 pass（场景有它在顶层时建深度附件；组里的管线加载时没有，进组时要同步建）。 */
const depthPass = (object: number) =>
  pass(`objects/${object}/passes/0`, { depthtest: "enabled", blending: "additive" });

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
    programs: [
      program("composelayer", [0]),
      program("kbfx", [0]),
      program("image", [0]),
      program("effectpassthrough", [0]),
      PARTICLE_PROGRAM,
    ],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    // 场景带脚本：写死可见之外的图层也建资源（同真实运行中会换父的场景）
    scripts: { list: [{ id: "objects/0/x" }] } as unknown as SceneBundle["scripts"],
  };
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};
const NO_BONES = () => ({ name: null, override: false });

async function open(layers: SceneLayer[]) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(layers);
  const registry = new SceneRegistry(bundle);
  const state = SceneState.fromBundle(bundle);
  registry.restructure(state, NO_BONES);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(FRAME, state);
  /** 脚本换父 / 删除之后宿主做的：登记表重算，变了的交给渲染器，帧里脚本之后重排。 */
  const restructure = (flush = true) => {
    const { changed } = registry.restructure(state, NO_BONES);
    scene.restructure(changed);
    if (flush) scene.flushRestructure(state);
    scene.sync(state);
    scene.update(FRAME, state);
    return [...changed].sort((a, b) => a - b);
  };
  return { gpu, bundle, registry, state, scene, restructure };
}

/** 一帧里画了哪些图层的哪一步、画在哪张目标上（`pass` 行之后的 `draw` 行归到那张目标）。 */
function drawTargets(trace: readonly string[]): string[] {
  const out: string[] = [];
  let target = "";
  for (const line of trace) {
    if (line.startsWith("pass ")) target = line.slice(5).replace(/ (load|clear)$/, "");
    else if (line.startsWith("  draw ")) out.push(`${line.slice(7)} @ ${target}`);
  }
  return out;
}

/** 某一步绘制前设的那条管线。 */
function pipelineBefore(trace: readonly string[], draw: string): string {
  const at = trace.findIndex((line) => line === `  draw ${draw}`);
  for (let i = at; i >= 0; i--) if (trace[i].startsWith("  pipeline ")) return trace[i].slice(11);
  throw new Error(`没有 ${draw}`);
}

interface Internals {
  rebuildStats: { count: number };
  attachments: Map<number, unknown>;
  layerByObject: Map<number, unknown>;
  runtimeByObject: Map<number, { resources: { composites: { texture: { label: string } }[] } }>;
  trees: Map<number, { system: unknown }>;
}
const internals = (scene: GpuScene) => scene as unknown as Internals;

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SCENE = "scene target";
const G_RT = "composite 800x400|true|false #0";
const H_RT = "composite 600x300|true|false #0";

/** 0 背景、1 组 G（带 kbfx，子层 2 = B）、3 顶层 R（测深度）、4 没有子层的组合层 H（不带 effect）。 */
function sceneLayers(): SceneLayer[] {
  return [
    image(0, "BG", { size: [1920, 1080] }),
    compose(1, "G", [800, 400], { effects: [kbfx(1)] }),
    image(2, "B", { parent: 1 }),
    image(3, "R", { passes: [depthPass(3)] }),
    compose(4, "H", [600, 300]),
  ];
}

describe("GpuScene.restructure（L7）", () => {
  it("进组：R 的绘制画进组的合成 RT、管线换成组里的（写 alpha、没有深度，同步建），顶层不再画它；出组回顶层、管线换回带深度的", async () => {
    const { gpu, state, scene, restructure } = await open(sceneLayers());
    let trace = gpu.encode(scene, state);
    expect(drawTargets(trace)).toEqual([
      `layer 10 BG direct @ ${SCENE}`,
      `layer 11 G compose @ ${G_RT}`,
      `layer 12 B direct @ ${G_RT}`,
      `layer 11 G final @ ${SCENE}`,
      `layer 13 R direct @ ${SCENE}`,
    ]);
    const top = pipelineBefore(trace, "layer 13 R direct");
    expect(top).toContain("depth:");
    expect(top).toMatch(/mask 7$/);
    const sync = gpu.counts.sync;
    state.setParent(3, 1);
    expect(restructure()).toEqual([1, 3]);
    trace = gpu.encode(scene, state);
    expect(drawTargets(trace)).toEqual([
      `layer 10 BG direct @ ${SCENE}`,
      `layer 11 G compose @ ${G_RT}`,
      `layer 12 B direct @ ${G_RT}`,
      `layer 13 R direct @ ${G_RT}`,
      `layer 11 G final @ ${SCENE}`,
    ]);
    const inGroup = pipelineBefore(trace, "layer 13 R direct");
    expect(inGroup).not.toContain("depth:");
    expect(inGroup).toMatch(/mask 15$/);
    // 组里的管线加载时没有：当帧同步建
    expect(gpu.counts.sync).toBeGreaterThan(sync);
    // 出组
    state.setParent(3, null);
    expect(restructure()).toEqual([1, 3]);
    trace = gpu.encode(scene, state);
    expect(drawTargets(trace).at(-1)).toBe(`layer 13 R direct @ ${SCENE}`);
    expect(pipelineBefore(trace, "layer 13 R direct")).toBe(top);
  });

  it("没有子层的组合层成了组：借到合成 RT、子树画进去、groupUpload 上屏（它的程序加载时另外备好）；子层再出组时旧组回到整层不画", async () => {
    const { gpu, state, scene, restructure } = await open(sceneLayers());
    // 加载时 H 整层不画
    expect(drawTargets(gpu.encode(scene, state)).some((line) => line.includes("H"))).toBe(false);
    state.setParent(3, 4);
    expect(restructure()).toEqual([3, 4]);
    const trace = gpu.encode(scene, state);
    expect(drawTargets(trace).slice(-3)).toEqual([
      `layer 14 H compose @ ${H_RT}`,
      `layer 13 R direct @ ${H_RT}`,
      `layer 14 H final @ ${SCENE}`,
    ]);
    // 上屏用 effectpassthrough（程序 3），画在场景目标上、带深度状态（顶层）
    expect(pipelineBefore(trace, "layer 14 H final")).toMatch(/^scene program 3 normal rgba8unorm.* depth:/);
    expect(trace).toContain(`copy ${SCENE} -> _rt_FullFrameBuffer`);
    // 出组：旧组 H 的子树空了，计划回到空计划（整层不画），R 回顶层
    state.setParent(3, null);
    expect(restructure()).toEqual([3, 4]);
    const after = drawTargets(gpu.encode(scene, state));
    expect(after.some((line) => line.includes("H"))).toBe(false);
    expect(after.at(-1)).toBe(`layer 13 R direct @ ${SCENE}`);
  });

  it("删组：当帧剩下的子层由顶层画（先释放组，再按顶层重排）", async () => {
    const { gpu, registry, state, scene, restructure } = await open(sceneLayers());
    state.markDestroy(1);
    state.flushDestroy();
    state.dropObject(1);
    registry.removeObject(1);
    expect(restructure()).toEqual([2]);
    const trace = gpu.encode(scene, state);
    expect(drawTargets(trace)).toEqual([
      `layer 10 BG direct @ ${SCENE}`,
      `layer 12 B direct @ ${SCENE}`,
      `layer 13 R direct @ ${SCENE}`,
    ]);
    expect(pipelineBefore(trace, "layer 12 B direct")).toMatch(/mask 7$/);
    expect(scene.hasObject(1)).toBe(false);
    // 删掉的组不再留在图层表里（L4 为「改组归属的删除整场重载之前」留的特例 L7 去掉了）
    expect(internals(scene).layerByObject.has(1)).toBe(false);
  });

  it("没交给 flushRestructure 时下一次 sync 照做（暂停时的补画帧）", async () => {
    const { gpu, state, scene, restructure } = await open(sceneLayers());
    state.setParent(3, 1);
    restructure(false);
    expect(drawTargets(gpu.encode(scene, state))).toContain(`layer 13 R direct @ ${G_RT}`);
  });

  it("嵌套组换归属：组里子孙的合成 RT 换到按层数分开的池（k2），不和内组自己的（k1）共用", async () => {
    const layers = [
      image(0, "BG", { size: [1920, 1080] }),
      compose(1, "O", [1200, 600], { effects: [kbfx(1)] }),
      compose(3, "I", [300, 300], { effects: [kbfx(3)] }),
      image(4, "T", { parent: 3, size: [300, 300], effects: [kbfx(4)] }),
    ];
    const { gpu, state, scene, restructure } = await open(layers);
    const compositesOf = (object: number) =>
      internals(scene)
        .runtimeByObject.get(object)!
        .resources.composites.map((target) => target.texture.label);
    expect(compositesOf(4)).toEqual(["composite 300x300|true|false|k1 #0"]);
    state.setParent(3, 1);
    expect(restructure()).toEqual([1, 3, 4]);
    expect(compositesOf(3)).toEqual(["composite 300x300|true|false|k1 #0"]);
    expect(compositesOf(4)).toEqual(["composite 300x300|true|false|k2 #0"]);
    // 假设备的「既是目标又被采样」检查不报：T 的 effect 读自己的 RT、画进 I 的 RT
    expect(drawTargets(gpu.encode(scene, state))).toContain("layer 14 T final @ composite 300x300|true|false|k1 #0");
  });

  it("挂点表随 layer.attachment 更新（没有 GPU 运行时的对象也更新）", async () => {
    const { bundle, state, scene } = await open(sceneLayers());
    const attachment = { parent: 0, bone: 1, matrix: new Float32Array(16) };
    bundle.layers[3].attachment = attachment;
    scene.restructure([3]);
    scene.sync(state);
    expect(internals(scene).attachments.get(3)).toBe(attachment);
    delete bundle.layers[3].attachment;
    scene.restructure([3]);
    scene.sync(state);
    expect(internals(scene).attachments.has(3)).toBe(false);
  });

  it("组的子表只换顺序：组不重建（rebuildStats 不增），子树按新顺序画", async () => {
    const layers = sceneLayers();
    layers.push(image(5, "C", { parent: 1 }));
    const { gpu, state, scene, restructure } = await open(layers);
    const before = internals(scene).rebuildStats.count;
    state.setParent(2, null);
    state.setParent(2, 1);
    expect(restructure()).toEqual([1]);
    expect(internals(scene).rebuildStats.count).toBe(before);
    const order = drawTargets(gpu.encode(scene, state)).filter((line) => line.endsWith(G_RT));
    expect(order).toEqual([
      `layer 11 G compose @ ${G_RT}`,
      `layer 15 C direct @ ${G_RT}`,
      `layer 12 B direct @ ${G_RT}`,
    ]);
    // 子层进组算一次重建
    state.setParent(3, 1);
    restructure();
    expect(internals(scene).rebuildStats.count).toBe(before + 1);
  });

  it("重排失败：回到顶层而场景没有深度附件、它的计划要测深度时抛 render:restructure-depth，卸掉它", async () => {
    // 顶层都不测深度（不建深度附件），组里的 R 测深度
    const layers = [
      image(0, "BG", { size: [1920, 1080] }),
      compose(1, "G", [800, 400]),
      image(3, "R", { parent: 1, passes: [depthPass(3)] }),
    ];
    const { registry, state, scene } = await open(layers);
    state.setParent(3, null);
    scene.restructure(registry.restructure(state, NO_BONES).changed);
    let error: unknown = null;
    try {
      scene.flushRestructure(state);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SceneRenderError);
    expect((error as SceneRenderError).reasons).toEqual(["render:restructure-depth"]);
    expect(scene.hasObject(3)).toBe(false);
    // 组照常重排（另一个对象不受影响）
    expect(scene.hasObject(1)).toBe(true);
  });

  it("模型层进组（P14b）：网格画进组的合成 RT、管线换成没有深度的（同步建）；出组回顶层、管线换回带深度的", async () => {
    const mesh = {
      format: 0x9,
      stride: 20,
      vertices: new Uint8Array(4 * 20),
      indices: new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer),
      vertexCount: 4,
      indexFormat: "uint16" as const,
      indexCount: 6,
      material: "materials/m.json",
      passes: [
        pass("objects/3/meshes/0/passes/0", { depthtest: "enabled", depthwrite: "enabled", blending: "normal" }),
      ],
    };
    const layers = [
      image(0, "BG", { size: [1920, 1080] }),
      compose(1, "G", [800, 400], { effects: [kbfx(1)] }),
      image(3, "M", {
        size: [0, 0],
        passes: [],
        model: {
          path: "models/m.mdl",
          version: 23,
          meshes: [mesh],
          order: [0],
          bounds: [-131072, -131072, -131072, 131072, 131072, 131072],
        },
      }),
    ];
    const { gpu, state, scene, restructure } = await open(layers);
    const meshLine = (trace: readonly string[]) => drawTargets(trace).filter((line) => line.includes("models/m.mdl"));
    const pipelineOfMesh = (trace: readonly string[]) => {
      const at = trace.findIndex((line) => line.includes("models/m.mdl"));
      for (let i = at; i >= 0; i--) if (trace[i].startsWith("  pipeline ")) return trace[i].slice(11);
      throw new Error("没有 M 的网格");
    };
    let trace = gpu.encode(scene, state);
    expect(meshLine(trace)).toEqual([expect.stringContaining(`@ ${SCENE}`)]);
    const top = pipelineOfMesh(trace);
    expect(top).toContain("depth:");
    state.setParent(3, 1);
    expect(restructure()).toEqual([1, 3]);
    trace = gpu.encode(scene, state);
    expect(meshLine(trace)).toEqual([expect.stringContaining(`@ ${G_RT}`)]);
    expect(pipelineOfMesh(trace)).not.toContain("depth:");
    state.setParent(3, null);
    expect(restructure()).toEqual([1, 3]);
    trace = gpu.encode(scene, state);
    expect(meshLine(trace)).toEqual([expect.stringContaining(`@ ${SCENE}`)]);
    expect(pipelineOfMesh(trace)).toBe(top);
  });

  it("粒子层进组：沿用粒子树（模拟不重来），绘制画进组的合成 RT", async () => {
    const particle = parseParticle(
      {
        maxcount: 8,
        emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 100 }],
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "sizerandom", min: 20, max: 20 },
        ],
      },
      { file: "particles/p.json", orthographic: true },
    );
    particle.passes = [pass("objects/3/particle/passes/0", { program: PROGRAM.particle })];
    const layers = [
      image(0, "BG", { size: [1920, 1080] }),
      compose(1, "G", [800, 400], { effects: [kbfx(1)] }),
      image(3, "P", { passes: [], particle }),
    ];
    const { gpu, state, scene, restructure } = await open(layers);
    scene.stepParticles(0.1, 1, state, [0.5, 0.5]);
    const system = internals(scene).trees.get(3)!.system;
    state.setParent(3, 1);
    expect(restructure()).toEqual([1, 3]);
    expect(internals(scene).trees.get(3)!.system).toBe(system);
    expect(drawTargets(gpu.encode(scene, state)).filter((line) => line.includes("P "))).toEqual([
      expect.stringContaining(`@ ${G_RT}`),
    ]);
  });
});
