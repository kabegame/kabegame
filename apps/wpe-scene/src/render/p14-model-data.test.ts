/**
 * P14 步骤 3b：脚本模型数据层的 GPU 缓冲（假设备，搭法同 `l4.test.ts`）。
 * - 网格带 `source` 时缓冲按 `(token, 形状)` 建（`VERTEX | COPY_DST`，有索引时另有 `INDEX | COPY_DST`），建时写入数据仓当前字节；
 * - 每帧 `syncModelData` 比版本：变了才 `writeBuffer`（一帧多次 `applyData` 只写一次，当帧生效）、同版本不写；绘制数随数据仓更新；
 * - 多个图层共用一组缓冲（E9）：最后一个 draw 释放时才销毁；
 * - 无索引形状 `draw(顶点数)`、不绑索引缓冲；
 * - `replaceData` 换了容量：新图层另建一组，旧组留给旧 draw、旧 draw 摘掉后销毁；token 释放后绘制数归零；
 * - 读帧缓冲的模型图层画之前拷一次快照（E16），不读的不拷；
 * - 组里的投射者不进阴影 pass（P14b），按这一刻的组归属每帧筛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, SceneMesh, ScenePass } from "../compile/bundle";
import { mdlStride } from "../compile/mdl";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { ModelDataStore } from "../modeldata/store";
import type { TranslateResult } from "../wpesl2wgsl";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

interface FakeBuffer {
  label: string;
  usage: number;
  bytes: Uint8Array;
  destroyed: boolean;
  destroy(): void;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  /** 每次 `writeBuffer` 的目标缓冲 */
  readonly writes: FakeBuffer[] = [];
  /** 每次绘制：`draw` / `drawIndexed` 与数量 */
  readonly calls: string[] = [];
  copies = 0;
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer: () => this.calls.push("setIndexBuffer"),
      draw: (count: number) => this.calls.push(`draw ${count}`),
      drawIndexed: (count: number) => this.calls.push(`drawIndexed ${count}`),
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          usage: descriptor.usage,
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
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => ({
        label: descriptor.label ?? "",
        getBindGroupLayout: () => ({}),
      }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({
        label: descriptor.label ?? "",
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture: () => {
          this.copies++;
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBufferLike, dataOffset = 0, size?: number) => {
          this.writes.push(buffer);
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

  /** 模型数据的缓冲（标签带 `model data`），按建出的顺序 */
  modelBuffers(): FakeBuffer[] {
    return this.buffers.filter((buffer) => buffer.label.includes("model data"));
  }
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16, STORAGE: 32 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ———— 夹具 ————

/** 网格程序：属性 a_Position、a_TexCoord（格式 0x9，stride 20），纹理槽 0 用来读快照。 */
const MESH_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// mesh v", entryPoint: "main" },
  fragment: { wgsl: "// mesh f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 },
  ],
  uniformBlockSize: 80,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

const FORMAT = 0x9;
const STRIDE = mdlStride(FORMAT);

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
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

function meshOf(
  object: number,
  token: number,
  shape: number,
  vertexCount: number,
  indexCount: number,
  extra: Partial<ScenePass> = {},
): SceneMesh {
  return {
    format: FORMAT,
    stride: STRIDE,
    vertices: new Uint8Array(0),
    indices: new Uint8Array(0),
    vertexCount,
    indexFormat: "uint16",
    indexCount,
    material: "materials/m.json",
    passes: [pass(`objects/${object}/meshes/0/passes/0`, extra)],
    source: { token, shape },
  };
}

function modelLayer(object: number, mesh: SceneMesh): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `model ${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [0, 0],
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
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    model: {
      path: `modeldata/${mesh.source?.token}`,
      version: 23,
      meshes: [mesh],
      order: [0],
      bounds: [-131072, -131072, -131072, 131072, 131072, 131072],
    },
  } as SceneLayer;
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: { ...generalDefaults() },
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [MESH_PROGRAM],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const FRAME: FrameInput = {
  time: 1.5,
  frametime: 1 / 60,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0, 0],
  cursor: [0.5, 0.5],
};

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (seed + i) & 0xff);
const u16 = (...values: number[]) => new Uint8Array(new Uint16Array(values).buffer);

/** 数据仓里建一个 token：一个形状，有索引（`indexed`）时是 `indexValues`，否则无索引；顶点 `vertexCount` 个。 */
function createToken(store: ModelDataStore, vertexCount: number, indexValues: number[] | null, dynamic = true): number {
  return store.create(
    {
      shapes: [
        {
          vertices: bytes(vertexCount * STRIDE, 1),
          index: indexValues ? { format: "uint16", bytes: u16(...indexValues) } : null,
          format: FORMAT,
          material: "materials/m.json",
          dynamicVertex: dynamic,
          dynamicIndex: dynamic,
        },
      ],
      bounds: null,
    },
    () => 0,
  );
}

async function setup(layersOf: (store: ModelDataStore) => SceneLayer[], tweak?: (bundle: SceneBundle) => void) {
  const gpu = new FakeGpu();
  const store = new ModelDataStore();
  const layers = layersOf(store);
  const bundle = bundleOf(layers);
  tweak?.(bundle);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set<string>(), [], {
    particles: { seed: 7 },
    modelData: () => store,
  });
  return { gpu, store, bundle, state, scene };
}

/** 运行中删一个对象：状态 → 登记表摘掉 → `sync` 的 `releaseRemoved`（同 `l4.test.ts`）。 */
function destroyObject(state: SceneState, bundle: SceneBundle, scene: GpuScene, object: number): void {
  state.markDestroy(object);
  state.flushDestroy();
  state.dropObject(object);
  const at = bundle.layers.findIndex((layer) => layer.object === object);
  if (at >= 0) bundle.layers.splice(at, 1);
  scene.sync(state);
}

/** 一帧（同渲染器的顺序），返回这一帧的绘制调用。 */
function frame(gpu: FakeGpu, scene: GpuScene, state: SceneState): string[] {
  scene.sync(state);
  scene.stepParticles(0.5, FRAME.time, state, FRAME.cursor);
  scene.update(FRAME, state);
  gpu.calls.length = 0;
  scene.encode(gpu.device.createCommandEncoder(), state);
  return [...gpu.calls];
}

describe("脚本模型数据的 GPU 缓冲（P14 步骤 3b）", () => {
  it("建时按数据仓字节建缓冲（COPY_DST）、绘制数取数据仓", async () => {
    const { gpu, store, scene, state } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2, 2, 1, 3]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 6))];
    });
    const [vertices, indices] = gpu.modelBuffers();
    expect(vertices.usage & 1).toBe(1);
    expect(vertices.usage & 4).toBe(4);
    expect(indices.usage & 16).toBe(16);
    expect(indices.usage & 4).toBe(4);
    const record = store.shape(1, 0)!;
    expect(Buffer.from(vertices.bytes)).toEqual(Buffer.from(record.vertices));
    expect(Buffer.from(indices.bytes)).toEqual(Buffer.from(record.indices!));
    expect(frame(gpu, scene, state)).toContain("drawIndexed 6");
  });

  it("applyData 当帧生效：缓冲字节与绘制数都更新；同版本的帧不再写；一帧多次 applyData 只写一次", async () => {
    const { gpu, store, scene, state } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2, 2, 1, 3]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 6))];
    });
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 6"]);
    const [vertices, indices] = gpu.modelBuffers();
    // 第一帧版本没变：不写
    const writesBefore = gpu.writes.filter((buffer) => buffer === vertices || buffer === indices).length;
    frame(gpu, scene, state);
    expect(gpu.writes.filter((buffer) => buffer === vertices || buffer === indices).length).toBe(writesBefore);
    // 一帧里两次 apply：每个缓冲只写一次，绘制数是最后一次的索引个数
    const next = bytes(4 * STRIDE, 100);
    store.apply(1, [{ vertices: next, index: { format: "uint16", bytes: u16(0, 1, 2) } }]);
    store.apply(1, [{ vertices: next, index: { format: "uint16", bytes: u16(0, 1, 2) } }]);
    const calls = frame(gpu, scene, state);
    expect(calls).toEqual(["setIndexBuffer", "drawIndexed 3"]);
    expect(gpu.writes.filter((buffer) => buffer === vertices).length).toBe(writesBefore / 2 + 1);
    expect(gpu.writes.filter((buffer) => buffer === indices).length).toBe(writesBefore / 2 + 1);
    expect(Buffer.from(vertices.bytes)).toEqual(Buffer.from(next));
  });

  it("无索引形状：draw(顶点数)、不绑索引缓冲；applyData 后绘制数 = 这次的顶点数", async () => {
    const { gpu, store, scene, state } = await setup((s) => {
      const token = createToken(s, 6, null);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 6, 0))];
    });
    // 只有顶点缓冲
    expect(gpu.modelBuffers()).toHaveLength(1);
    expect(frame(gpu, scene, state)).toEqual(["draw 6"]);
    store.apply(1, [{ vertices: bytes(3 * STRIDE, 7) }]);
    expect(frame(gpu, scene, state)).toEqual(["draw 3"]);
  });

  it("多个图层共用一组缓冲（E9）：最后一个 draw 摘掉后才销毁", async () => {
    const { gpu, store, scene, state, bundle } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      s.retainLayer(token, 1);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3)), modelLayer(1, meshOf(1, token, 0, 4, 3))];
    });
    const buffers = gpu.modelBuffers();
    expect(buffers).toHaveLength(2); // 一份顶点 + 一份索引，两个图层共用
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 3", "setIndexBuffer", "drawIndexed 3"]);
    // applyData 一次、两个图层的绘制数都变，缓冲只写一次
    const before = gpu.writes.length;
    store.apply(1, [{ index: { format: "uint16", bytes: u16(0, 1) } }]);
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 2", "setIndexBuffer", "drawIndexed 2"]);
    expect(gpu.writes.length - before).toBeGreaterThanOrEqual(2);
    expect(gpu.writes.slice(before).filter((buffer) => buffer.label.includes("model data"))).toHaveLength(2);
    // 摘掉一个：还在用
    destroyObject(state, bundle, scene, 0);
    expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);
    destroyObject(state, bundle, scene, 1);
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("replaceData 换了容量：新图层另建一组缓冲，旧组留给旧 draw、旧 draw 摘掉后销毁", async () => {
    const { gpu, store, scene, state, bundle } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3))];
    });
    const old = gpu.modelBuffers();
    expect(old).toHaveLength(2);
    // 重建成 8 个顶点、6 个索引
    store.replace(
      1,
      [{ vertices: bytes(8 * STRIDE, 3), index: { format: "uint16", bytes: u16(0, 1, 2, 3, 4, 5) } }],
      () => 0,
    );
    // 旧 draw 还在时容量不符，先画旧的（不写、不崩）
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 3"]);
    // 宿主按新描述重拼：装同一对象的新图层（替换），旧 draw 摘掉
    const layer = modelLayer(0, meshOf(0, 1, 0, 8, 6));
    bundle.layers = [layer];
    state.replaceObject({ layer } as never);
    const prepared = scene.prepareObjectSync(layer, state)!;
    scene.installObject(prepared, state);
    const fresh = gpu.modelBuffers().filter((buffer) => !old.includes(buffer));
    expect(fresh).toHaveLength(2);
    expect(fresh[0].bytes.byteLength).toBe(8 * STRIDE);
    expect(old.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fresh.every((buffer) => !buffer.destroyed)).toBe(true);
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 6"]);
  });

  it("两个图层共用、replaceData 扩容后宿主逐个重拼：先换的拿新组，后换的仍画旧组；applyData 只写新组；都换完后旧组销毁", async () => {
    const { gpu, store, scene, state, bundle } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      s.retainLayer(token, 1);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3)), modelLayer(1, meshOf(1, token, 0, 4, 3))];
    });
    const old = gpu.modelBuffers();
    expect(old).toHaveLength(2);
    store.replace(
      1,
      [{ vertices: bytes(8 * STRIDE, 3), index: { format: "uint16", bytes: u16(0, 1, 2, 3, 4, 5) } }],
      () => 0,
    );
    const swap = (object: number) => {
      const layer = modelLayer(object, meshOf(object, 1, 0, 8, 6));
      bundle.layers = bundle.layers.map((item) => (item.object === object ? layer : item));
      state.replaceObject({ layer } as never);
      scene.installObject(scene.prepareObjectSync(layer, state)!, state);
    };
    // 只换图层 0：它拿到新容量的一组，旧组还被图层 1 引用、不销毁
    swap(0);
    const fresh = gpu.modelBuffers().filter((buffer) => !old.includes(buffer));
    expect(fresh).toHaveLength(2);
    expect(fresh[0].bytes.byteLength).toBe(8 * STRIDE);
    expect(old.every((buffer) => !buffer.destroyed)).toBe(true);
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 6", "setIndexBuffer", "drawIndexed 3"]);
    // applyData 只写新组：旧组容量不符、不在表里，字节保持
    const oldBytes = old.map((buffer) => Buffer.from(buffer.bytes));
    const next = bytes(8 * STRIDE, 200);
    store.apply(1, [{ vertices: next, index: { format: "uint16", bytes: u16(5, 4, 3, 2) } }]);
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 4", "setIndexBuffer", "drawIndexed 3"]);
    expect(Buffer.from(fresh[0].bytes)).toEqual(Buffer.from(next));
    old.forEach((buffer, i) => expect(Buffer.from(buffer.bytes)).toEqual(oldBytes[i]));
    // 再换图层 1：与图层 0 共用新组（不再建缓冲），旧组销毁
    const before = gpu.modelBuffers().length;
    swap(1);
    expect(gpu.modelBuffers()).toHaveLength(before);
    expect(old.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fresh.every((buffer) => !buffer.destroyed)).toBe(true);
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 4", "setIndexBuffer", "drawIndexed 4"]);
  });

  it("建场景时预建 usable 模板的 pass 与阴影变体程序，unusable 的不建（modelMaterials，同泛光 / 体积光的做法）", async () => {
    const variant = (name: string) =>
      ({ ...MESH_PROGRAM, vertex: { wgsl: `// ${name} v`, entryPoint: "main" } }) as TranslateResult;
    const { scene } = await setup(
      (s) => {
        const token = createToken(s, 4, [0, 1, 2]);
        s.retainLayer(token, 0);
        return [modelLayer(0, meshOf(0, token, 0, 4, 3))];
      },
      (bundle) => {
        bundle.programs = [MESH_PROGRAM, variant("pass"), variant("shadow"), variant("unusable")];
        bundle.modelMaterials = {
          "materials/a.json": {
            passes: [pass("modeldata/0/passes/0", { program: 1 })],
            shadow: pass("modeldata/0/shadow", { program: 2 }),
            usable: true,
          },
          "materials/b.json": { passes: [pass("modeldata/1/passes/0", { program: 3 })], usable: false },
        };
      },
    );
    const built = [...(scene as unknown as { programs: Map<number, unknown> }).programs.keys()].sort();
    expect(built).toContain(1);
    expect(built).toContain(2);
    expect(built).not.toContain(3);
  });

  it("阴影投射者：脚本模型数据的无索引形状 draw(顶点数, 1, 0, 视图号)、有索引的 drawIndexed(…, 视图号)", async () => {
    const lights = {
      counts: {
        point: 1,
        spot: 0,
        tube: 0,
        directional: 0,
        pointShadow: 1,
        directionalShadow: 0,
        spotShadow: 0,
        spotCookie: 0,
        spotShadowCookie: 0,
      },
      quality: 1,
    };
    const casting = (object: number, token: number, vertexCount: number, indexCount: number): SceneLayer => {
      const mesh = {
        ...meshOf(object, token, 0, vertexCount, indexCount),
        shadow: pass(`objects/${object}/meshes/0/shadow`),
      };
      const layer = modelLayer(object, mesh);
      layer.model!.castShadow = true;
      return layer;
    };
    const { scene, gpu } = await setup(
      (s) => {
        const flat = createToken(s, 6, null);
        const indexed = createToken(s, 4, [0, 1, 2]);
        s.retainLayer(flat, 0);
        s.retainLayer(indexed, 1);
        return [casting(0, flat, 6, 0), casting(1, indexed, 4, 3)];
      },
      (bundle) => {
        (bundle as { lights?: unknown }).lights = lights;
      },
    );
    const casters = (
      scene as unknown as { shadowCasters: { draw(pass: unknown, entry: number, view: number): void }[] }
    ).shadowCasters;
    // 无索引形状（indexCount 0）也有投射者（`shadowCasterSteps` 对 `source` 网格放宽）：阴影 pass 里 `draw(顶点数, 1, 0, 视图号)`
    expect(casters).toHaveLength(2);
    const calls: string[] = [];
    const fakePass = {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer: () => calls.push("setIndexBuffer"),
      draw: (...args: number[]) => calls.push(`draw ${args.join(",")}`),
      drawIndexed: (...args: number[]) => calls.push(`drawIndexed ${args.join(",")}`),
    };
    casters[0].draw(fakePass, 0, 5);
    casters[1].draw(fakePass, 0, 5);
    expect(calls).toEqual(["draw 6,1,0,5", "setIndexBuffer", "drawIndexed 3,1,0,0,5"]);
    void gpu;
  });

  it("组里的投射者不进阴影 pass（P14b，p14b-gm-shadow）：按这一刻的组归属每帧筛，运行中进组 / 出组当帧生效", async () => {
    const lights = {
      counts: {
        point: 1,
        spot: 0,
        tube: 0,
        directional: 0,
        pointShadow: 1,
        directionalShadow: 0,
        spotShadow: 0,
        spotCookie: 0,
        spotShadowCookie: 0,
      },
      quality: 1,
    };
    const casting = (object: number, token: number): SceneLayer => {
      const mesh = { ...meshOf(object, token, 0, 4, 3), shadow: pass(`objects/${object}/meshes/0/shadow`) };
      const layer = modelLayer(object, mesh);
      layer.model!.castShadow = true;
      return layer;
    };
    const { scene, gpu, bundle, state } = await setup(
      (s) => {
        const a = createToken(s, 4, [0, 1, 2]);
        const b = createToken(s, 4, [0, 1, 2]);
        s.retainLayer(a, 0);
        s.retainLayer(b, 1);
        return [casting(0, a), casting(1, b)];
      },
      (b) => {
        (b as { lights?: unknown }).lights = lights;
      },
    );
    const atlas = (scene as unknown as { shadowAtlas: { encode(encoder: unknown, casters: unknown[]): void } })
      .shadowAtlas;
    const encoded: number[] = [];
    const original = atlas.encode.bind(atlas);
    vi.spyOn(atlas, "encode").mockImplementation((encoder, casters) => {
      encoded.push(casters.length);
      original(encoder, casters);
    });
    frame(gpu, scene, state);
    // 进组（L7 换父后 `SceneLayer.group` 就是新值；99 是组的对象号，这里不需要它真的在场景里）
    bundle.layers[1].group = 99;
    frame(gpu, scene, state);
    // 出组
    bundle.layers[1].group = null;
    frame(gpu, scene, state);
    expect(encoded).toEqual([2, 1, 2]);
    // 投射者本身没删（按对象建、换父不重建）
    expect((scene as unknown as { shadowCasters: unknown[] }).shadowCasters).toHaveLength(2);
  });

  it("数据仓里查不到（token 已释放）时绘制数归零、不画", async () => {
    const { gpu, store, scene, state } = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3))];
    });
    expect(frame(gpu, scene, state)).toEqual(["setIndexBuffer", "drawIndexed 3"]);
    store.releaseLayer(1, 0);
    store.releaseScript(1);
    expect(store.shape(1, 0)).toBeNull();
    expect(frame(gpu, scene, state)).toEqual([]);
  });

  it("读 _rt_FullFrameBuffer 的模型图层画之前拷一次快照（E16），不读的不拷", async () => {
    const reading = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3, { runtime: { 0: "_rt_FullFrameBuffer" }, framebuffer: true }))];
    });
    reading.gpu.copies = 0;
    frame(reading.gpu, reading.scene, reading.state);
    expect(reading.gpu.copies).toBe(1);
    const plain = await setup((s) => {
      const token = createToken(s, 4, [0, 1, 2]);
      s.retainLayer(token, 0);
      return [modelLayer(0, meshOf(0, token, 0, 4, 3))];
    });
    plain.gpu.copies = 0;
    frame(plain.gpu, plain.scene, plain.state);
    expect(plain.gpu.copies).toBe(0);
  });
});
