/**
 * P5d 步骤 4 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 4」点 3、点 4）：`GpuScene.encode`
 * 顶层那一轮（假设备，按 bind group 的标签记下每次绘制属于哪个图层）。
 * - 透视场景开了 `transparentSorting`：先按原顺序画不在半透明名单里的，再把半透明的按「当帧状态的局部 origin · 当帧透视相机的视线方向」
 *   从远到近画，`last` 最后；组画子树不动（子层仍在组里、按 `subtree` 顺序，不进顶层排序）；`setCamera` 换相机、状态改 origin，下一帧
 *   顺序跟着变；
 * - 透视场景开关关着、正交场景开关开着：调用序列与不看开关时逐项相同，是 `objects` 顺序。
 * 假设备的搭法照 `p5d-depth.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type SceneBinding } from "../compile/bindings";
import {
  FRAMEBUFFER_RT,
  type SceneBundle,
  type SceneGeneral,
  type SceneLayer,
  type ScenePass,
  type SortClass,
} from "../compile/bundle";
import type { Vec3 } from "../compile/camera";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { perspectiveCamera } from "./camera";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写 bundle ————

const PROGRAM = { compose: 0, image: 1, upload: 2 } as const;

function pass(key: string, blending: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.image,
    blending,
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

/** 一个纯色图层（直接上屏），`sortClass` 照编译期的规则手写。 */
function layer(object: number, name: string, sortClass: SortClass | undefined, origin: number[]): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name,
    origin,
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
    passes: [pass(`objects/${object}/passes/0`, sortClass === "opaque" ? "normal" : "translucent")],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...(sortClass ? { sortClass } : {}),
  };
}
/** 组（带子层的组合层）：基础 pass 是 composelayer（采快照），上屏是 effectpassthrough；WPE 的 util 组合层是 translucent。 */
function group(object: number, name: string, subtree: number[], origin: number[]): SceneLayer {
  return {
    ...layer(object, name, "translucent", origin),
    passthroughModel: true,
    subtree,
    passes: [
      pass(`objects/${object}/passes/0`, "translucent", {
        program: PROGRAM.compose,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    groupUpload: pass(`objects/${object}/groupupload`, "normal", { program: PROGRAM.upload }),
  };
}
const child = (object: number, name: string, parent: number, origin: number[]): SceneLayer => ({
  ...layer(object, name, "translucent", origin),
  parent,
  group: parent,
});

/** 一个程序：MVP，声明 `slots` 这些纹理槽。 */
function program(name: string, slots: number[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
    uniformBlockSize: 64,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}

const BASE_CAMERA = { eye: [0, 0, 10] as Vec3, center: [0, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, paths: [] };

function general(perspective: boolean, transparentSorting: boolean): SceneGeneral {
  return {
    width: perspective ? 0 : 1920,
    height: perspective ? 0 : 1080,
    perspective,
    camera: perspective ? BASE_CAMERA : null,
    fields: generalDefaults(),
    clearVariable: false,
    perspectiveOverrideFov: particleFov(undefined),
    postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
    bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    transparentSorting,
  };
}

function bundleOf(layers: SceneLayer[], perspective: boolean, transparentSorting: boolean): SceneBundle {
  return {
    general: general(perspective, transparentSorting),
    layers,
    programs: [program("composelayer", [0]), program("image", []), program("effectpassthrough", [0])],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

// ———— 假设备：记 render pass、拷贝与每次绘制的 bind group 标签（`layer <id> <name> <角色>`） ————

class FakeGpu {
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const renderPass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup(_index: number, group: { label: string }) {
        trace.push(`  ${group.label}`);
      },
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
        const texture = { label: descriptor.label ?? "", format: descriptor.format, destroy() {} };
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
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label ?? "" }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const color = [...descriptor.colorAttachments][0]!;
          trace.push(`pass ${(color.view as unknown as { label: string }).label} ${color.loadOp}`);
          return renderPass();
        },
        copyTextureToTexture: (source: { texture: { label: string } }, target: { texture: { label: string } }) => {
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() {},
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
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

async function open(layers: SceneLayer[], perspective: boolean, transparentSorting: boolean) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(layers, perspective, transparentSorting);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
  });
  scene.update(FRAME, state);
  return { gpu, scene, state };
}

/** 每次绘制属于哪个图层（标签里的名字），连续相同的合成一个。 */
function layerNames(trace: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of trace) {
    const match = /^ {2}layer \d+ (\S+) /.exec(line);
    if (match && names.at(-1) !== match[1]) names.push(match[1]);
  }
  return names;
}

/** 透视相机的一帧（交给 `setCamera`），同渲染器。 */
const perspectiveFrame = (state: SceneState, eye: Vec3, center: Vec3 = [0, 0, 0]) => ({
  kind: "perspective" as const,
  frame: perspectiveCamera({
    pose: { eye, center, up: [0, 1, 0], zoom: 1 },
    fields: state.general,
    time: 0,
    width: 1920,
    height: 1080,
  }),
});

/**
 * 透视场景（基准相机 eye (0, 0, 10) 看向原点，前向 (0, 0, −1)，键 = −z）：
 * FR、D 不透明；B(−2)、C(8)、E(0) 半透明；FS 是 last（原点在最远处）；G 是组（键 1），子层 K1(z +3)、K2(z −9) 只在组里画。
 */
const sortLayers = () => [
  layer(0, "FR", "opaque", [0, 0, 0]),
  layer(1, "B", "translucent", [-0.5, 0, 2]),
  layer(2, "FS", "last", [0, 0, -20]),
  layer(3, "C", "translucent", [0, 0, -8]),
  layer(4, "D", "opaque", [0.5, 0, 3]),
  group(5, "G", [6, 7], [0, 0, -1]),
  child(6, "K1", 5, [0, 0, 3]),
  child(7, "K2", 5, [0, 0, -9]),
  layer(8, "E", "translucent", [1, 0, 0]),
];
/** `objects` 顺序（组的子层在组里）。 */
const OBJECTS_ORDER = ["FR", "B", "FS", "C", "D", "G", "K1", "K2", "G", "E"];

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene.encode：透视场景开了透明排序（P5d 步骤 4 点 3）", () => {
  it("先按原顺序画不透明的（FR、D），再按键从大到小画半透明的：C(8)、G(1，子层在组里)、E(0)、B(−2)，FS 最后", async () => {
    const { gpu, scene, state } = await open(sortLayers(), true, true);
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "D", "C", "G", "K1", "K2", "G", "E", "B", "FS"]);
  });

  it("只换图层的先后：绘制的集合和不排序时相同；组那一段（基础 pass → 子层 → 上屏，含中间的 pass）逐项相同", async () => {
    const sorted = await open(sortLayers(), true, true);
    const plain = await open(sortLayers(), true, false);
    const a = sorted.gpu.encode(sorted.scene, sorted.state);
    const b = plain.gpu.encode(plain.scene, plain.state);
    const draws = (trace: string[]) => trace.filter((line) => line.startsWith("  layer "));
    expect(draws(a).sort()).toEqual(draws(b).sort());
    // 7 个顶层图层各一次，组多一次（基础 pass 与上屏），两个子层各一次
    expect(draws(a)).toHaveLength(10);
    const groupSpan = (trace: string[]) => {
      const indices = trace.flatMap((line, index) => (/^ {2}layer \d+ G /.test(line) ? [index] : []));
      return trace.slice(indices[0], indices.at(-1)! + 1);
    };
    expect(groupSpan(a)).toEqual(groupSpan(b));
    expect(layerNames(groupSpan(a))).toEqual(["G", "K1", "K2", "G"]);
  });

  it("前向取 setCamera 交来的当帧透视相机：相机移到 +x 看向原点（前向 (−1, 0, 0)），键改成 −x", async () => {
    const { gpu, scene, state } = await open(sortLayers(), true, true);
    scene.setCamera(perspectiveFrame(state, [10, 0, 0]));
    // B(0.5)、C(0)、G(0)、E(−1)：C、G 并列保持原顺序；FS 照旧最后
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "D", "B", "C", "G", "K1", "K2", "G", "E", "FS"]);
    // 换回基准相机，顺序回到原来的
    scene.setCamera(perspectiveFrame(state, [0, 0, 10]));
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "D", "C", "G", "K1", "K2", "G", "E", "B", "FS"]);
  });

  it("读当帧状态里的局部 origin：E 的 origin 改到 z −20 后排到最前；改组的 origin 不影响子层在组里的顺序", async () => {
    const { gpu, scene, state } = await open(sortLayers(), true, true);
    const write = (object: number, value: string) =>
      state.write({ property: "", target: { kind: "layer", object, field: "origin" } } as SceneBinding, value);
    write(8, "1 0 -20");
    write(5, "0 0 5");
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "D", "E", "C", "B", "G", "K1", "K2", "G", "FS"]);
  });

  it("p5d-sort-par：挂在分组节点 G（z +5，没有 pass）下的 F（局部 z −6、世界 −1）按局部的键 6 排在 H（3）前面", async () => {
    const { gpu, scene, state } = await open(
      [
        layer(0, "FR", "opaque", [0, 0, 0]),
        { ...layer(1, "G", undefined, [0, 0, 5]), passes: [] },
        layer(2, "H", "translucent", [1, 0, -3]),
        { ...layer(3, "F", "translucent", [-1, 0, -6]), parent: 1 },
      ],
      true,
      true,
    );
    expect(state.layers.get(3)?.parent).toBe(1);
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "F", "H"]);
  });

  it("不可见的半透明图层照旧不画，其余顺序不变", async () => {
    const { gpu, scene, state } = await open(sortLayers(), true, true);
    state.write({ property: "", target: { kind: "layer", object: 3, field: "visible" } } as SceneBinding, false);
    expect(layerNames(gpu.encode(scene, state))).toEqual(["FR", "D", "G", "K1", "K2", "G", "E", "B", "FS"]);
  });
});

describe("GpuScene.encode：开关关着、正交场景时调用序列逐项同以前（P5d 步骤 4 点 3）", () => {
  it("透视场景开关关：objects 顺序；和「开关开、全都不在半透明名单」的调用序列逐项相同", async () => {
    const off = await open(sortLayers(), true, false);
    const trace = off.gpu.encode(off.scene, off.state);
    expect(layerNames(trace)).toEqual(OBJECTS_ORDER);
    const plain = sortLayers().map((item) => ({ ...item, sortClass: undefined }));
    const identity = await open(plain, true, true);
    expect(identity.gpu.encode(identity.scene, identity.state)).toEqual(trace);
  });

  it("正交场景开关开：不排，调用序列和开关关逐项相同", async () => {
    const orthoLayers = () =>
      sortLayers().map((item) => ({ ...item, origin: [960 + item.origin[0] * 100, 540, item.origin[2]] }));
    const on = await open(orthoLayers(), false, true);
    const off = await open(orthoLayers(), false, false);
    const trace = on.gpu.encode(on.scene, on.state);
    expect(trace).toEqual(off.gpu.encode(off.scene, off.state));
    expect(layerNames(trace)).toEqual(OBJECTS_ORDER);
  });

  it("缺 transparentSorting 字段（手写的 bundle）按关", async () => {
    const gpu = new FakeGpu();
    const bundle = bundleOf(sortLayers(), true, false);
    delete bundle.general.transparentSorting;
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
      ignoreUnsupported: true,
      particles: { seed: 1 },
    });
    scene.update(FRAME, state);
    expect(layerNames(gpu.encode(scene, state))).toEqual(OBJECTS_ORDER);
  });
});
