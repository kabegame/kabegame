/**
 * P6d3a 点 1、点 3（`.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md`）：
 * - `SceneState`：对象表 `order`、`sortLayer`（u32 比较，越界与负数到末尾）、`markDestroy` / `flushDestroy`（待删不改代数、生效时子对象变根）、
 *   `setParent`（子表追加在尾、旧父摘除）、`adoptStructure`（重编译后接过结构）；
 * - 纯函数：`layerStructure`（顶层绘制顺序与位置表）、`byPosition`、`pickablesOf` 的命中顺序按 `state.order`；
 * - `GpuScene`（假设备）：顶层绘制按对象表顺序画、`sortLayer` 后顺序跟着变；对象被删后 `sync` 释放它的资源、不再画、不再刷。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { compileScene, type SceneBundle, type SceneGeneral, type SceneLayer, type ScenePass } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { pickablesOf, type PickLayer } from "./cursor";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { byPosition, layerStructure } from "./structure";
import type { FrameInput } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— SceneState（内存工程编出来的 bundle） ————

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

/** 0 = G（分组节点）；1 = A、2 = B 挂在 G 下；3 = C 根；4 = D 挂在 B 下。 */
const OBJECTS = [
  { id: 1, name: "G" },
  { id: 2, name: "A", image: "models/a.json", size: "40 60", parent: 1 },
  { id: 3, name: "B", image: "models/a.json", size: "40 60", parent: 1 },
  { id: 4, name: "C", image: "models/a.json", size: "40 60" },
  { id: 5, name: "D", image: "models/a.json", size: "40 60", parent: 3 },
];

function compile(destroyed: number[] = []): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: OBJECTS },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    structure: { destroyed, parents: [], created: [] },
  });
}

describe("SceneState 的对象表（点 1）", () => {
  it("fromBundle：order 是 bundle.layers 的顺序，子表取 bundle.children", async () => {
    const state = SceneState.fromBundle(await compile());
    expect(state.order).toEqual([0, 1, 2, 3, 4]);
    expect(state.childrenOf(0)).toEqual([1, 2]);
    expect(state.childrenOf(2)).toEqual([4]);
    expect(state.childrenOf(3)).toEqual([]);
    expect(state.structureVersion).toBe(0);
    expect(state.pendingDestroy.size).toBe(0);
  });

  it("sortLayer：先摘掉再插到 index；u32 比较，越界与负数到末尾；不在表里返回 false 且不动", async () => {
    const state = SceneState.fromBundle(await compile());
    expect(state.sortLayer(3, 0)).toBe(true);
    expect(state.order).toEqual([3, 0, 1, 2, 4]);
    expect(state.structureVersion).toBe(1);
    // 摘掉之后 n = 4：index 4 已越界 → 末尾
    expect(state.sortLayer(3, 4)).toBe(true);
    expect(state.order).toEqual([0, 1, 2, 4, 3]);
    expect(state.sortLayer(0, 99)).toBe(true);
    expect(state.order).toEqual([1, 2, 4, 3, 0]);
    // 负数（u32 回绕）到末尾
    expect(state.sortLayer(1, -1)).toBe(true);
    expect(state.order).toEqual([2, 4, 3, 0, 1]);
    // 恰好是最后一个合法位置
    expect(state.sortLayer(2, 3)).toBe(true);
    expect(state.order).toEqual([4, 3, 0, 2, 1]);
    const version = state.structureVersion;
    expect(state.sortLayer(99, 0)).toBe(false);
    expect(state.structureVersion).toBe(version);
    expect(state.order).toEqual([4, 3, 0, 2, 1]);
  });

  it("sortLayer 不改子表（组内顺序跟子表走）", async () => {
    const state = SceneState.fromBundle(await compile());
    state.sortLayer(2, 0);
    expect(state.childrenOf(0)).toEqual([1, 2]);
  });

  it("markDestroy：在表里就记（重复也是 true），不在表里 false；不改代数", async () => {
    const state = SceneState.fromBundle(await compile());
    expect(state.markDestroy(2)).toBe(true);
    expect(state.markDestroy(2)).toBe(true);
    expect(state.markDestroy(99)).toBe(false);
    expect([...state.pendingDestroy]).toEqual([2]);
    expect(state.structureVersion).toBe(0);
    // 待删的对象在生效前还在表里、还有状态
    expect(state.order).toContain(2);
    expect(state.layers.has(2)).toBe(true);
  });

  it("flushDestroy：按标记先后摘掉；子对象变根（本地字段不动）并标脏；摘出父的子表；递增代数", async () => {
    const state = SceneState.fromBundle(await compile());
    state.takeDirty();
    state.takeTransformWrites();
    state.layers.get(4)!.origin = [10, 20, 0];
    state.markDestroy(2);
    state.markDestroy(1);
    expect(state.flushDestroy()).toEqual([2, 1]);
    expect(state.order).toEqual([0, 3, 4]);
    expect([...state.layers.keys()].sort()).toEqual([0, 3, 4]);
    // B（2）被删：D（4）变根，本地 origin 不动；G 的子表里 A（1）、B（2）都摘掉了，B 自己的子表也删了
    expect(state.layers.get(4)!.parent).toBeNull();
    expect(state.layers.get(4)!.origin).toEqual([10, 20, 0]);
    expect(state.childrenOf(0)).toEqual([]);
    expect(state.childrenOf(2)).toEqual([]);
    expect(state.structureVersion).toBe(1);
    expect(state.pendingDestroy.size).toBe(0);
  });

  it("flushDestroy 的子对象与它的子树标成变换脏", async () => {
    const state = SceneState.fromBundle(await compile());
    state.takeDirty();
    state.takeTransformWrites();
    // 删 B（2）：D（4）变根
    state.markDestroy(2);
    expect(state.flushDestroy()).toEqual([2]);
    expect(state.layers.get(4)!.parent).toBeNull();
    expect(state.childrenOf(0)).toEqual([1]);
    expect(state.hasTransformWrites()).toBe(true);
    expect([...state.takeTransformWrites()]).toEqual([4]);
    expect([...state.takeDirty().layers]).toEqual([4]);
  });

  it("flushDestroy 没有待删时不动代数；重复标记只删一次", async () => {
    const state = SceneState.fromBundle(await compile());
    expect(state.flushDestroy()).toEqual([]);
    expect(state.structureVersion).toBe(0);
    state.markDestroy(3);
    state.markDestroy(3);
    expect(state.flushDestroy()).toEqual([3]);
    expect(state.structureVersion).toBe(1);
    // 已不在表里：再标返回 false，flush 为空
    expect(state.markDestroy(3)).toBe(false);
    expect(state.flushDestroy()).toEqual([]);
  });

  it("setParent：旧父摘除、新父追加在尾、标脏子树、递增代数；null 是根", async () => {
    const state = SceneState.fromBundle(await compile());
    state.takeDirty();
    state.takeTransformWrites();
    state.setParent(1, 3); // A 挂到 C 下
    expect(state.layers.get(1)!.parent).toBe(3);
    expect(state.childrenOf(0)).toEqual([2]);
    expect(state.childrenOf(3)).toEqual([1]);
    state.setParent(2, 3); // B 也挂到 C 下：追加在尾（连同它的子树 D 标脏）
    expect(state.childrenOf(3)).toEqual([1, 2]);
    expect(state.childrenOf(0)).toEqual([]);
    expect([...state.takeDirty().layers].sort()).toEqual([1, 2, 4]);
    state.setParent(1, null);
    expect(state.layers.get(1)!.parent).toBeNull();
    expect(state.childrenOf(3)).toEqual([2]);
    expect(state.structureVersion).toBe(3);
    // 子树随父：改 C 的 origin，新挂上来的 B 与 D 一起标脏
    state.takeDirty();
    state.write({ property: "p", target: { kind: "layer", object: 3, field: "origin" } }, "5 5 0");
    expect([...state.takeDirty().layers].sort()).toEqual([2, 3, 4]);
  });

  it("adoptStructure：order 滤掉不存在的、新增的追加在尾；待删集合滤掉不存在的；递增代数", async () => {
    const previous = SceneState.fromBundle(await compile([4]));
    previous.sortLayer(3, 0);
    previous.markDestroy(2);
    previous.markDestroy(1);
    expect(previous.order).toEqual([3, 0, 1, 2]);
    // 新状态多一个对象 4（旧表里没有）
    const next = SceneState.fromBundle(await compile());
    next.adoptStructure(previous);
    expect(next.order).toEqual([3, 0, 1, 2, 4]);
    expect([...next.pendingDestroy]).toEqual([2, 1]);
    expect(next.structureVersion).toBe(1);
    // 新状态里没有的（编译期删了）从 order 与待删里滤掉
    const smaller = SceneState.fromBundle(await compile([1, 2]));
    smaller.adoptStructure(next);
    expect(smaller.order).toEqual([3, 0, 4]);
    expect(smaller.pendingDestroy.size).toBe(0);
  });
});

describe("SceneState.adoptStructure 接父与子表（P6d3a 点 4）", () => {
  it("双方都有的对象照搬旧状态的父与子表（首次加载时 init 里的 setParent 落在旧状态上）；改了父的子树标脏", async () => {
    const previous = SceneState.fromBundle(await compile());
    previous.setParent(3, 0);
    previous.setParent(1, null);
    const next = SceneState.fromBundle(await compile());
    next.takeDirty();
    next.adoptStructure(previous);
    expect(next.layers.get(3)!.parent).toBe(0);
    expect(next.layers.get(1)!.parent).toBeNull();
    // 子表：旧状态的顺序（2 在前、换父挂上的 3 追加在尾），没改的子表不变
    expect(next.childrenOf(0)).toEqual([2, 3]);
    expect(next.childrenOf(2)).toEqual([4]);
    expect(next.hasTransformWrites()).toBe(true);
    expect([...next.takeDirty().layers].sort()).toEqual(expect.arrayContaining([1, 3]));
  });

  it("幂等：编译输入已带结构时再接一次不变", async () => {
    const previous = SceneState.fromBundle(await compile());
    previous.setParent(1, null);
    const next = SceneState.fromBundle(await compile());
    next.adoptStructure(previous);
    const again = SceneState.fromBundle(await compile());
    again.adoptStructure(next);
    expect(again.childrenOf(0)).toEqual(next.childrenOf(0));
    expect(again.layers.get(1)!.parent).toBeNull();
  });

  it("旧父不在新状态里（编译期已删）当根；新状态新增的对象保留自己的父", async () => {
    const previous = SceneState.fromBundle(await compile());
    previous.setParent(3, 0);
    const smaller = SceneState.fromBundle(await compile([0]));
    smaller.adoptStructure(previous);
    expect(smaller.layers.get(3)!.parent).toBeNull();
    expect(smaller.childrenOf(0)).toEqual([]);
    // 对象 4（D，父 B）在旧状态里也有，仍挂在 B 下
    expect(smaller.layers.get(4)!.parent).toBe(2);
    expect(smaller.childrenOf(2)).toEqual([4]);
  });
});

// ———— 纯函数 ————

describe("layerStructure / byPosition", () => {
  const runtime = (object: number, group: number | null) => ({ object, layer: { group } });
  it("top 按对象表顺序，只取有运行时且不由组代画的；位置表是对象 → 下标", () => {
    const runtimes = new Map([
      [0, runtime(0, null)],
      [1, runtime(1, 0)],
      [2, runtime(2, null)],
      [4, runtime(4, null)],
    ]);
    const { top, position } = layerStructure([4, 3, 0, 1, 2], runtimes);
    expect(top.map((item) => item.object)).toEqual([4, 0, 2]);
    expect(position.get(4)).toBe(0);
    expect(position.get(2)).toBe(4);
    expect(position.has(9)).toBe(false);
  });

  it("缺 group 字段也当顶层", () => {
    const { top } = layerStructure([0], new Map([[0, { object: 0, layer: {} }]]));
    expect(top).toHaveLength(1);
  });

  it("byPosition：不在表里的排最后，并列按下标", () => {
    const position = new Map([
      [5, 0],
      [2, 1],
    ]);
    expect([2, 9, 5, 7, 1].sort(byPosition(position))).toEqual([5, 2, 1, 7, 9]);
  });
});

describe("pickablesOf：命中顺序按 state.order（点 3）", () => {
  const pick = (object: number): PickLayer => ({
    object,
    pick: "image",
    perspective: false,
    fullscreen: false,
    size: [10, 10],
    disablePropagation: false,
    sortClass: "opaque",
  });
  const layerState = (parent: number | null = null) => ({
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    parallaxDepth: [1, 1],
    parent,
  });
  const layers = new Map([0, 1, 2].map((object) => [object, layerState()]));
  const bundleLayers = [pick(0), pick(1), pick(2)];

  it("没有 order 时按传入顺序倒序（最上面的在前）", () => {
    const out = pickablesOf(bundleLayers, { layers, texts: new Map() }, false);
    expect(out.map((item) => item.object)).toEqual([2, 1, 0]);
  });

  it("有 order 时按它的顺序倒序；不在表里的排在最底下", () => {
    const state = { layers, texts: new Map(), order: [1, 2, 0] };
    expect(pickablesOf(bundleLayers, state, false).map((item) => item.object)).toEqual([0, 2, 1]);
    const partial = { layers, texts: new Map(), order: [2, 1] };
    // 0 不在表里：排最后（最上面），倒序后在最前
    expect(pickablesOf(bundleLayers, partial, false).map((item) => item.object)).toEqual([0, 1, 2]);
  });
});

// ———— GpuScene（假设备，搭法同 p5d3-camera.test.ts） ————

const mat4 = (name: string, offset: number) => ({ name, type: "mat4x4<f32>", declared: "mat4", offset, size: 64 });

const IMAGE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [mat4("g_ModelViewProjectionMatrix", 0)],
  uniformBlockSize: 64,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function pass(key: string): ScenePass {
  return {
    key,
    program: 0,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: { 0: 0 },
    runtime: {},
    uniforms: {},
    framebuffer: false,
  };
}

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [256, 256],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
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
    passes: [pass(`objects/${object}/passes/0`)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

const GENERAL: SceneGeneral = {
  width: 1920,
  height: 1080,
  perspective: false,
  camera: null,
  fields: { ...generalDefaults() },
  clearVariable: false,
  perspectiveOverrideFov: particleFov(95),
  postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
  bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
};

function handBundle(layers: SceneLayer[]): SceneBundle {
  return {
    general: GENERAL,
    layers,
    programs: [IMAGE_PROGRAM],
    textures: [
      {
        path: "t",
        source: "",
        format: 0,
        width: 64,
        height: 64,
        textureWidth: 64,
        textureHeight: 64,
        flags: 0,
        clampUVs: true,
        noInterpolation: false,
        mips: [{ width: 64, height: 64, bytes: new Uint8Array(64 * 64 * 4) }],
      },
    ],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroyed: boolean;
  destroy(): void;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  /** 每个 pass 里 `setVertexBuffer` 的缓冲标签，按画的先后。 */
  drawn: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const owner = this;
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer(_slot: number, buffer: FakeBuffer) {
        owner.drawn.push(buffer.label);
      },
      setIndexBuffer() {},
      draw() {},
      drawIndexed() {},
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        format: descriptor.format,
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          destroyed: false,
          destroy() {
            buffer.destroyed = true;
          },
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
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
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

interface DrawView {
  object: number;
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer | null;
}
const drawsOf = (scene: GpuScene): DrawView[] => [...(scene as unknown as { draws: Set<DrawView> }).draws];

async function open(layers: SceneLayer[]) {
  const gpu = new FakeGpu();
  const bundle = handBundle(layers);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
  });
  return { gpu, state, scene };
}

/** 画一帧，返回按先后画的图层顺序（顶点缓冲的标签带图层 id，这里换回 objects 下标）。 */
function frameOrder(gpu: FakeGpu, scene: GpuScene, state: SceneState, objects: number[]): number[] {
  gpu.drawn = [];
  scene.encode(gpu.device.createCommandEncoder(), state);
  return gpu.drawn.flatMap((label) => {
    // 标签是 `layer <id> <name> <role>`，id = objects 下标 + 1（`layer()` 的夹具）
    const id = Number(/^layer (\d+) /.exec(label)?.[1]);
    return objects.includes(id - 1) ? [id - 1] : [];
  });
}

describe("GpuScene：对象表与删除（点 3、点 4 的渲染侧）", () => {
  const three = () => [layer(0), layer(1), layer(2)];

  it("顶层按 state.order 画；sortLayer 之后顺序跟着变，不重建资源", async () => {
    const { gpu, state, scene } = await open(three());
    scene.sync(state);
    scene.update(FRAME, state);
    expect(frameOrder(gpu, scene, state, [0, 1, 2])).toEqual([0, 1, 2]);
    const before = drawsOf(scene).map((draw) => draw.vertexBuffer);
    state.sortLayer(0, 99);
    scene.sync(state);
    expect(frameOrder(gpu, scene, state, [0, 1, 2])).toEqual([1, 2, 0]);
    expect(drawsOf(scene).map((draw) => draw.vertexBuffer)).toEqual(before);
  });

  it("对象被删：sync 释放它的顶点 / uniform 缓冲，不再画、不再刷；其余图层照常", async () => {
    const { gpu, state, scene } = await open(three());
    scene.sync(state);
    scene.update(FRAME, state);
    const doomed = drawsOf(scene).filter((draw) => draw.object === 1);
    expect(doomed.length).toBeGreaterThan(0);
    state.markDestroy(1);
    expect(state.flushDestroy()).toEqual([1]);
    // 同帧里先 encode 再 sync（脚本阶段之后、sync 之前）也不能崩
    scene.encode(gpu.device.createCommandEncoder(), state);
    scene.sync(state);
    scene.update(FRAME, state);
    for (const draw of doomed) {
      expect(draw.vertexBuffer.destroyed).toBe(true);
      expect(draw.uniformBuffer!.destroyed).toBe(true);
    }
    expect(drawsOf(scene).map((draw) => draw.object)).toEqual([0, 2]);
    expect(frameOrder(gpu, scene, state, [0, 1, 2])).toEqual([0, 2]);
    // 没删的图层的缓冲还在
    expect(drawsOf(scene).every((draw) => !draw.vertexBuffer.destroyed)).toBe(true);
    // 再 sync 一次（代数没变）不重复释放、不抛错
    scene.sync(state);
  });

  it("删掉的对象还在 dirty 里（删之前写过）也不抛错", async () => {
    const { state, scene } = await open(three());
    state.write({ property: "p", target: { kind: "layer", object: 2, field: "origin" } }, "1 2 3");
    state.markDestroy(2);
    state.flushDestroy();
    expect(() => scene.sync(state)).not.toThrow();
  });
});
