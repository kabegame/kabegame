/**
 * P11b 步骤 2 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase11/phase-11b-usertextures.md`「步骤 2」，p11-REPORT M1–M9）：
 * - 槽 0 换图：整层重建，UV 上界变 1、内缩按新纹理（M1）；清空后与没有用户纹理时逐字节相同；
 * - 其它槽换图：只换 bind group 与 `g_Texture<n>Resolution`，不重建图层；
 * - instanced：合成 RT 与 effect fbo 跟着变尺寸，`g_Color4` / `g_Alpha` 变成 1，回缺省时恢复（M2、rea-p11b 4.3）；
 * - RT 参考的槽：加载时就有值不生效，第一次写入后按 RT 的比例裁（M3、M8）；
 * - 被依赖图层槽 0 换图：独占 RT 重建，引用它的 draw 重绑；
 * - 没有槽引用的用户纹理销毁；超出设备上限、拷贝失败回缺省并记 warning；
 * - `SceneState.write` 的 `user-texture` 目标。
 * 假设备照 `render/rebuild.test.ts`，另记外部图像拷贝、纹理尺寸与销毁。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, mergeProperties, planApply } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { UserTextureSlot } from "../compile/usertextures";
import { UserTextureSources, type UserTextureDeps } from "../usertex/sources";
import type { TranslateResult } from "../wpesl2wgsl";
import { layerQuad, uvInset } from "./layout";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

interface FakeTexture {
  label: string;
  width: number;
  height: number;
  destroyed: boolean;
  createView(): { label: string };
  destroy(): void;
}
interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}

class FakeGpu {
  readonly textures: FakeTexture[] = [];
  readonly copies: { source: unknown; texture: string; origin: unknown; size: { width: number; height: number } }[] =
    [];
  readonly trace: string[] = [];
  /** 渲染 pass 的标签（gamma 校正画的那次叫 `user texture gamma`）与建过的缓冲。 */
  readonly passes: string[] = [];
  readonly buffers: FakeBuffer[] = [];
  copyError: Error | null = null;
  maxTexture = 8192;
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline: (pipeline: { label: string }) => this.trace.push(`pipeline ${pipeline.label}`),
      setBindGroup: (_index: number, group: { key: string }) => this.trace.push(`bind ${group.key}`),
      setVertexBuffer() {},
      draw() {},
      end() {},
    });
    this.device = {
      limits: {
        get maxTextureDimension2D() {
          return gpu.maxTexture;
        },
      },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const { width, height } = descriptor.size as { width: number; height: number };
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          width,
          height,
          destroyed: false,
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy: () => {
            texture.destroyed = true;
          },
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: (descriptor: GPUSamplerDescriptor = {}) => ({ key: JSON.stringify(descriptor) }),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({
        entries: [...descriptor.entries],
        key: [...descriptor.entries]
          .map(({ binding, resource }) => {
            const item = resource as { label?: string; key?: string; buffer?: unknown };
            return `${binding}:${item.buffer ? "uniform" : (item.label ?? item.key)}`;
          })
          .join(","),
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          this.passes.push(descriptor.label ?? "");
          return pass();
        },
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
          buffer.bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
            : new Uint8Array(data.slice(0));
        },
        writeTexture() {},
        copyExternalImageToTexture: (
          source: GPUCopyExternalImageSourceInfo,
          destination: GPUCopyExternalImageDestInfo,
          size: { width: number; height: number },
        ) => {
          if (this.copyError) throw this.copyError;
          this.copies.push({
            source: source.source,
            origin: source.origin,
            texture: (destination.texture as unknown as FakeTexture).label,
            size,
          });
        },
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const gpu = this;
  }

  /** 所有同名纹理（按创建顺序）。 */
  named(prefix: string): FakeTexture[] {
    return this.textures.filter((texture) => texture.label.startsWith(prefix));
  }
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());

/** 程序：槽 0、1，块里有颜色组与两个 `g_Texture<n>Resolution`。 */
const PROGRAM = {
  ok: true,
  vertex: { wgsl: "// v", entryPoint: "main" },
  fragment: { wgsl: "// f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Time", type: "f32", declared: "float", offset: 64, size: 4 },
    { name: "g_Alpha", type: "f32", declared: "float", offset: 68, size: 4 },
    { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 80, size: 16 },
    { name: "g_Texture0Resolution", type: "vec4<f32>", declared: "vec4", offset: 96, size: 16 },
    { name: "g_Texture1Resolution", type: "vec4<f32>", declared: "vec4", offset: 112, size: 16 },
  ],
  uniformBlockSize: 128,
  textures: [0, 1].map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
} as unknown as TranslateResult;

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

/** 纹理：`image` 是图像尺寸，`size` 是纹理尺寸（NPOT 时更大）。 */
const texture = (path: string, image: [number, number], size: [number, number] = image): SceneTexture => ({
  path,
  source: "",
  format: 0,
  width: image[0],
  height: image[1],
  textureWidth: size[0],
  textureHeight: size[1],
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width: size[0], height: size[1], bytes: new Uint8Array(size[0] * size[1] * 4) }],
});

function slot(slotIndex: number, extra: Partial<UserTextureSlot> = {}): UserTextureSlot {
  return {
    slot: slotIndex,
    source: { kind: "property", name: "ut" },
    keepAspect: false,
    reference: { kind: "size", width: 1, height: 1 },
    nearest: false,
    clamp: true,
    ...extra,
  };
}

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [10, 20, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [300, 200],
    alpha: 0.5,
    color: [0.2, 0.4, 0.6],
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
    passes: [pass(`objects/${object}/passes/0`, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** 被依赖图层的上屏 pass（编译期按 BLENDMODE 0 编好的 `effectpassthrough`）。 */
const PASSTHROUGH = (object: number): ScenePass =>
  pass(`objects/${object}/passthrough`, { blending: "normal", uniforms: { g_Color4: [1, 1, 1, 1] } });

function effect(source: number, steps: SceneEffect["steps"], extra: Partial<SceneEffect> = {}): SceneEffect {
  return {
    source,
    id: 100 + source,
    name: `effect ${source}`,
    file: `effects/${source}/effect.json`,
    fbos: [],
    steps,
    enabled: true,
    visibleBound: false,
    unsupported: [],
    ...extra,
  };
}

const effectDraw = (scenePass: ScenePass, target: string | null = null): SceneEffect["steps"][number] => ({
  kind: "draw",
  pass: scenePass,
  target,
  compose: false,
  binds: null,
});

function bundleOf(layers: SceneLayer[], textures: SceneTexture[], sources: string[] = ["ut"]): SceneBundle {
  return {
    general: {
      width: 640,
      height: 360,
      fields: { ...generalDefaults(), ambientcolor: [0.1, 0.1, 0.1], skylightcolor: [0.2, 0.2, 0.2] },
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [PROGRAM],
    textures,
    userTextures: sources.map((name) => ({ kind: "property", name })),
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
  pointer: [0.25, 0.75],
  pointerLast: [0, 0],
  cursor: [0.25, 0.75],
};

/** 下一帧：`sync` 换图，再 `update` 把静态 uniform 的改动写进缓冲（宿主每帧的顺序）。 */
function advance(scene: GpuScene, state: SceneState): void {
  scene.sync(state);
  scene.update(FRAME);
}

/** 带 `gAMA` = 1.0 的最小 PNG 字节流（块只有 IHDR、gAMA、IDAT，CRC 不校验）。 */
function gammaPng(): Uint8Array {
  const chunk = (type: string, data: number[]) => [
    0,
    0,
    0,
    data.length,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
  const v = 100000;
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", new Array(13).fill(0)),
    ...chunk("gAMA", [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]),
    ...chunk("IDAT", [0]),
  ]);
}

/** 假来源表：文件内容就是路径，图像尺寸按路径表。 */
function makeSources(images: Record<string, [number, number]>) {
  const reads: string[] = [];
  const deps: Partial<UserTextureDeps> = {
    async read(path) {
      reads.push(path);
      return path.startsWith("g") ? gammaPng() : new TextEncoder().encode(path);
    },
    async decode(bytes) {
      const size = images[bytes[0] === 0x89 ? "g.png" : new TextDecoder().decode(bytes)];
      if (!size) throw new Error("解不出");
      return { width: size[0], height: size[1], close() {} } as unknown as ImageBitmap;
    },
  };
  return { sources: new UserTextureSources(async () => new Uint8Array(), deps), reads };
}

const IMAGES: Record<string, [number, number]> = {
  "a.png": [300, 200],
  "b.png": [540, 360],
  "c.png": [100, 400],
  "x.png": [640, 360],
  "g.png": [100, 80],
};

interface Live {
  gpu: FakeGpu;
  state: SceneState;
  scene: GpuScene;
  sources: UserTextureSources;
  reads: string[];
  warnings: string[];
  /** 属性来源 `ut` 换值：同宿主的路径（写进状态 → 来源表解码 → 完成标脏），等解码完成，再 `sync`。 */
  set(value: string): Promise<void>;
}

/** 建场景。`initial` 是加载时的属性值（预先解码）；没给就是空。 */
async function open(bundle: SceneBundle, initial: Record<string, string> = {}): Promise<Live> {
  const gpu = new FakeGpu();
  const { sources, reads } = makeSources(IMAGES);
  await sources.prime((bundle.userTextures ?? []).map((source) => [source.name, initial[source.name] ?? ""] as const));
  const state = SceneState.fromBundle(bundle);
  const warnings: string[] = [];
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), warnings, { userTextures: sources });
  scene.update(FRAME);
  state.onUserTexture = (name, value) => sources.setValue(name, value);
  sources.onReady = (name) => state.touchUserTexture(name);
  const set = async (value: string) => {
    state.write({ property: "ut", target: { kind: "user-texture", name: "ut" } }, value);
    await sources.settled();
    advance(scene, state);
  };
  return { gpu, state, scene, sources, reads, warnings, set };
}

interface DrawView {
  label: string;
  bindGroup: { key: string; entries: { binding: number; resource: unknown }[] } | null;
  bindGroups: Map<string, unknown>;
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer;
  textureSizes: ({ width: number; height: number } | undefined)[];
  step: { role: string };
}
interface RuntimeView {
  object: number;
  signature: string;
  draws: DrawView[];
  resources: { composites: { texture: FakeTexture; width: number; height: number }[] };
}
const internals = (scene: GpuScene) =>
  scene as unknown as {
    layers: RuntimeView[];
    layerTargets: Map<number, { texture: FakeTexture; width: number; height: number }>;
    userGpu: Map<string, { texture: FakeTexture }>;
  };

const f32 = (bytes: Uint8Array) =>
  new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
/** 顶点缓冲里第 i 个顶点的 [x, y, z, u, v]。 */
const vertex = (draw: DrawView, i: number) => [...f32(draw.vertexBuffer.bytes).slice(i * 5, i * 5 + 5)];
/** uniform 块里某个 float 成员（偏移按 `PROGRAM`）。 */
const uniform = (draw: DrawView, offset: number, count: number) => [
  ...f32(draw.uniformBuffer.bytes).slice(offset / 4, offset / 4 + count),
];
const ALPHA = 68;
const COLOR4 = 80;
const RES0 = 96;
const RES1 = 112;
const draws = (live: Live, object = 0) => internals(live.scene).layers.find((item) => item.object === object)!.draws;

/** 一帧的编码轨迹与每个 draw 的顶点 / uniform 字节。 */
function capture(live: Live, withSignature = true) {
  live.gpu.trace.length = 0;
  live.scene.update(FRAME);
  live.scene.encode(live.gpu.device.createCommandEncoder(), live.state);
  const layers = internals(live.scene).layers.map(({ object, signature, draws: list }) => ({
    object,
    ...(withSignature ? { signature } : {}),
    draws: list.map((draw) => ({
      label: draw.label,
      vertex: Buffer.from(draw.vertexBuffer.bytes).toString("hex"),
      uniform: Buffer.from(draw.uniformBuffer.bytes).toString("hex"),
    })),
  }));
  return { layers, trace: [...live.gpu.trace] };
}

// ———— 槽 0：图像层基础 pass ————

/** NPOT 缺省：300×200 的图放在 512×256 的纹理里；参考尺寸取图像尺寸 300×200（3:2）。 */
function npotBundle(): SceneBundle {
  return bundleOf(
    [
      layer(0, {
        passes: [
          pass("objects/0/passes/0", {
            textures: { 0: 0 },
            userTextures: [slot(0, { reference: { kind: "size", width: 300, height: 200 } })],
          }),
        ],
      }),
    ],
    [texture("npot", [300, 200], [512, 256])],
  );
}

describe("槽 0 换图：整层重建，UV 上界与内缩按新纹理（M1）", () => {
  it("缺省纹理 NPOT 时 UV 上界 < 1；换成用户图后上界为 1、内缩按用户图尺寸，g_Texture0Resolution 是裁后尺寸", async () => {
    const live = await open(npotBundle());
    const before = draws(live)[0];
    const defaultTexture = npotBundle().textures[0];
    // 缺省：UV = 图像 / 纹理，内缩按纹理尺寸 512×256
    const expectDefault = layerQuad([300, 200], [300 / 512, 200 / 256], uvInset([300, 200], defaultTexture));
    expect(vertex(before, 0)).toEqual([-150, 100, 0, ...expectDefault[0].texCoord]);
    expect(vertex(before, 3)).toEqual([150, -100, 0, ...expectDefault[3].texCoord]);
    expect(before.bindGroup!.key).toContain("1:npot");
    expect(uniform(before, RES0, 4)).toEqual([512, 256, 300, 200]);

    await live.set("b.png"); // 540×360，3:2 → 整张
    const after = draws(live)[0];
    // 整层重建：新的 draw 对象
    expect(after).not.toBe(before);
    const left = Math.fround(Math.fround(0.15) / 540);
    const top = Math.fround(Math.fround(0.15) / 360);
    expect(vertex(after, 0)).toEqual([-150, 100, 0, left, top]);
    expect(vertex(after, 3)).toEqual([150, -100, 0, Math.fround(1 - left), Math.fround(1 - top)]);
    // 采样用户纹理：名字是 WPE 的 `值 x round(比例·10)`，比例 3:2 → 15；尺寸 = 裁后宽高
    expect(after.bindGroup!.key).toContain("1:user b.pngx15");
    expect(uniform(after, RES0, 4)).toEqual([540, 360, 540, 360]);
    expect(live.gpu.copies.at(-1)).toMatchObject({
      texture: "user b.pngx15",
      size: { width: 540, height: 360 },
      origin: { x: 0, y: 0 },
    });
    // 图层尺寸不变（autosize 取参考尺寸，换图前后不变）
    expect(vertex(after, 0).slice(0, 2)).toEqual([-150, 100]);
  });

  it("裁切写在拷贝的源矩形上：100×400 的图在 3:2 的槽里取 100×66，起始行 167", async () => {
    const live = await open(npotBundle());
    await live.set("c.png");
    expect(live.gpu.copies.at(-1)).toMatchObject({
      texture: "user c.pngx15",
      size: { width: 100, height: 66 },
      origin: { x: 0, y: 167 },
    });
    expect(uniform(draws(live)[0], RES0, 4)).toEqual([100, 66, 100, 66]);
  });

  it("加载时就有值：第一帧就是用户图（预先解码）", async () => {
    const live = await open(npotBundle(), { ut: "b.png" });
    expect(draws(live)[0].bindGroup!.key).toContain("1:user b.pngx15");
    const left = Math.fround(Math.fround(0.15) / 540);
    expect(vertex(draws(live)[0], 0)).toEqual([-150, 100, 0, left, Math.fround(Math.fround(0.15) / 360)]);
  });

  it("清空 / 读不出回到缺省：顶点、uniform 与编码轨迹和没有用户纹理的场景逐字节相同", async () => {
    const live = await open(npotBundle());
    await live.set("b.png");
    await live.set("");
    await live.set("a.png");
    await live.set("missing.png"); // 读不出
    const plain = npotBundle();
    plain.layers[0].passes[0].userTextures = undefined;
    plain.userTextures = [];
    const reference = await open(plain);
    // 签名不比：用户引用本来就进步骤的输入；回缺省后画出来的东西（顶点、uniform、管线与 bind group 的轨迹）必须一样
    expect(capture(live, false)).toEqual(capture(reference, false));
  });

  it("用户纹理的采样：线性或点、夹取或重复、无各向异性、1 级 mip", async () => {
    const bundle = npotBundle();
    bundle.layers[0].passes[0].userTextures = [
      slot(0, { reference: { kind: "size", width: 300, height: 200 }, nearest: true, clamp: false }),
    ];
    const live = await open(bundle);
    await live.set("b.png");
    const entry = draws(live)[0].bindGroup!.entries.find((item) => item.binding === 2)!;
    expect(JSON.parse((entry.resource as { key: string }).key)).toEqual({
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      maxAnisotropy: 1,
    });
  });
});

// ———— 其它槽：effect 实例 pass 的槽 1 ————

/** 一个 effect 的最后一个 pass 读槽 1，缺省是 64×64 的纹理；参考尺寸 1:1。 */
function effectSlotBundle(): SceneBundle {
  const layers = [
    layer(0, {
      effects: [
        effect(0, [
          effectDraw(
            pass("objects/0/effects/0/passes/0", {
              textures: { 1: 1 },
              userTextures: [slot(1, { reference: { kind: "size", width: 64, height: 64 } })],
            }),
          ),
        ]),
      ],
    }),
  ];
  return bundleOf(layers, [texture("base", [300, 200]), texture("tint", [64, 64])]);
}

describe("其它槽换图：只换 bind group 与 g_Texture<n>Resolution，不重建图层", () => {
  it("用到这个来源的 draw 换了纹理与尺寸，draw 对象、顶点缓冲、图层签名都不变", async () => {
    const live = await open(effectSlotBundle());
    const runtime = internals(live.scene).layers[0];
    const signature = runtime.signature;
    const before = runtime.draws.map((draw) => ({
      draw,
      vertex: draw.vertexBuffer,
      group: draw.bindGroup,
      key: draw.bindGroup!.key,
    }));
    const effectBefore = before.find((item) => item.draw.step.role === "final")!;
    expect(effectBefore.key).toContain("3:tint");
    expect(uniform(effectBefore.draw, RES1, 4)).toEqual([64, 64, 64, 64]);

    await live.set("c.png"); // 100×400 → 1:1 → 100×100
    const runtimeAfter = internals(live.scene).layers[0];
    expect(runtimeAfter.signature).toBe(signature);
    runtimeAfter.draws.forEach((draw, i) => {
      expect(draw).toBe(before[i].draw);
      expect(draw.vertexBuffer).toBe(before[i].vertex);
    });
    const effectAfter = before.find((item) => item.draw.step.role === "final")!.draw;
    expect(effectAfter.bindGroup!.key).toContain("3:user c.pngx10");
    expect(effectAfter.bindGroup).not.toBe(effectBefore.group);
    expect(uniform(effectAfter, RES1, 4)).toEqual([100, 100, 100, 100]);
    // 没用到这个来源的基础 pass 不动
    const base = before.find((item) => item.draw.step.role === "base")!;
    expect(base.draw.bindGroup).toBe(base.group);
    expect(live.gpu.copies.at(-1)).toMatchObject({
      texture: "user c.pngx10",
      origin: { x: 0, y: 150 },
      size: { width: 100, height: 100 },
    });

    // 清空回缺省：尺寸与 bind group 都回来
    await live.set("");
    expect(effectAfter.bindGroup!.key).toContain("3:tint");
    expect(uniform(effectAfter, RES1, 4)).toEqual([64, 64, 64, 64]);
  });

  it("没有槽引用的用户纹理在 sync 末尾销毁；切回时重新上传但不重新读文件", async () => {
    const live = await open(effectSlotBundle());
    await live.set("a.png");
    const first = live.gpu.named("user a.png")[0];
    expect(first.destroyed).toBe(false);
    await live.set("c.png");
    expect(first.destroyed).toBe(true);
    expect(internals(live.scene).userGpu.has("a.pngx10")).toBe(false);
    live.reads.length = 0;
    await live.set("a.png");
    expect(live.reads).toEqual([]); // 解码结果在来源表里缓存着
    expect(live.gpu.named("user a.png")).toHaveLength(2);
  });

  it("多个槽共用同一个纹理名时只上传一次", async () => {
    const bundle = effectSlotBundle();
    bundle.layers[0].effects[0].steps.push(
      effectDraw(
        pass("objects/0/effects/0/passes/1", {
          textures: { 1: 1 },
          userTextures: [slot(1, { reference: { kind: "size", width: 64, height: 64 } })],
        }),
      ),
    );
    const live = await open(bundle);
    await live.set("a.png");
    expect(live.gpu.named("user a.png")).toHaveLength(1);
  });
});

// ———— instanced ————

/** instanced 纯色层 + 一个 effect：对象 `size` 600×400、`color` (1, 0.5, 0.25)、alpha 0.8，槽 0 缺省是 `util/white`（32×32）。 */
function instancedBundle(withEffect = true): SceneBundle {
  const white = pass("objects/0/passes/0", {
    textures: { 0: 0 },
    userTextures: [slot(0, { reference: { kind: "size", width: 600, height: 400 } })],
  });
  const effects = withEffect
    ? [
        effect(0, [effectDraw(pass("objects/0/effects/0/passes/0"))], {
          fbos: [{ name: "blur", format: "rgba8888", scale: 1, unique: false, repeat: false }],
        }),
      ]
    : [];
  return bundleOf(
    [
      layer(0, {
        solidLayer: true,
        instanced: true,
        size: [600, 400],
        alpha: 0.8,
        color: [1, 0.5, 0.25],
        passes: [white],
        effects,
      }),
    ],
    [texture("white", [32, 32])],
  );
}

describe("instanced：合成 RT 与 effect fbo 跟着用户图变尺寸，g_Color4 / g_Alpha 变成 1（M2、rea-p11b 4.2、4.3）", () => {
  it("合成 RT 从 32×32 变成裁后用户图尺寸（对象 size 的 1.5 比例裁）", async () => {
    const live = await open(instancedBundle());
    expect(live.gpu.named("composite")[0].label).toContain("composite 32x32|");
    await live.set("a.png"); // 300×200
    const sizes = internals(live.scene).layers[0].resources.composites.map((target) => [target.width, target.height]);
    expect(sizes.every(([w, h]) => w === 300 && h === 200)).toBe(true);
    // c.png（100×400）在 1.5 比例下裁成 100×66（M2）
    await live.set("c.png");
    const after = internals(live.scene).layers[0].resources.composites;
    expect(after.every((target) => target.width === 100 && target.height === 66)).toBe(true);
    // 回缺省：32×32
    await live.set("");
    expect(
      internals(live.scene).layers[0].resources.composites.every(
        (target) => target.width === 32 && target.height === 32,
      ),
    ).toBe(true);
  });

  it("effect 的独占 fbo 按新的合成尺寸换，清空后换回", async () => {
    const live = await open(instancedBundle());
    expect(
      live.gpu.named("fbo owned").length + live.gpu.textures.filter((t) => t.label.startsWith("fbo owned")).length,
    ).toBeGreaterThan(0);
    await live.set("a.png");
    const owned = live.gpu.textures.filter((texture) => texture.label.startsWith("fbo owned"));
    const last = owned.at(-1)!;
    expect([last.width, last.height]).toEqual([300, 200]);
    expect(owned[0].destroyed).toBe(true);
  });

  it("用户纹理生效时基础 pass 的 g_Color4 = (1, 1, 1, 1)、g_Alpha = 1；回到缺省恢复对象的颜色与 alpha", async () => {
    const live = await open(instancedBundle());
    const base = () => draws(live).find((draw) => draw.step.role === "base")!;
    const effectPass = () => draws(live).find((draw) => draw.step.role === "final")!;
    const objectColor = [1, 0.5, 0.25, Math.fround(0.8)];
    expect(uniform(base(), COLOR4, 4)).toEqual(objectColor);
    expect(uniform(base(), ALPHA, 1)).toEqual([Math.fround(0.8)]);

    await live.set("a.png");
    expect(uniform(base(), COLOR4, 4)).toEqual([1, 1, 1, 1]);
    expect(uniform(base(), ALPHA, 1)).toEqual([1]);
    // 这个 pass 之外（effect 的 pass 没有用户纹理）不动
    expect(uniform(effectPass(), COLOR4, 4)).toEqual(objectColor);

    await live.set("");
    expect(uniform(base(), COLOR4, 4)).toEqual(objectColor);
    expect(uniform(base(), ALPHA, 1)).toEqual([Math.fround(0.8)]);
  });

  it("没有 effect 的 instanced 直接上屏同样强制为白；对象的 alpha 一起换成 1", async () => {
    const live = await open(instancedBundle(false));
    expect(uniform(draws(live)[0], COLOR4, 4)[3]).toBeCloseTo(0.8, 6);
    await live.set("b.png");
    expect(uniform(draws(live)[0], COLOR4, 4)).toEqual([1, 1, 1, 1]);
    expect(uniform(draws(live)[0], ALPHA, 1)).toEqual([1]);
    // 直接上屏：solidlayer 不内缩，UV 上界取 1（用户纹理 540×360 的图像 / 纹理 = 1）
    expect(vertex(draws(live)[0], 3).slice(3)).toEqual([1, 1]);
  });

  it("不是组合层也不是 instanced 的图层颜色不强制", async () => {
    const live = await open(npotBundle());
    await live.set("b.png");
    expect(uniform(draws(live)[0], ALPHA, 1)).toEqual([Math.fround(0.5)]);
    expect(uniform(draws(live)[0], COLOR4, 4)[3]).toBeCloseTo(0.5, 6);
  });

  it("组合层（passthrough 模型）的任一槽有用户纹理就强制为白，不限槽 0", async () => {
    const bundle = effectSlotBundle();
    bundle.layers[0].passthroughModel = true;
    // 组合层基础 pass 不画（没有启用的 effect 才不画）；有 effect 时照画合成链
    const live = await open(bundle);
    const effectPass = () => draws(live).find((draw) => draw.step.role === "final")!;
    expect(uniform(effectPass(), COLOR4, 4)[3]).toBeCloseTo(0.5, 6);
    await live.set("a.png");
    expect(uniform(effectPass(), COLOR4, 4)).toEqual([1, 1, 1, 1]);
    expect(uniform(effectPass(), ALPHA, 1)).toEqual([1]);
  });
});

// ———— RT 参考 ————

/**
 * 被依赖图层 0（500×300，独占 RT）；图层 1 的 effect 槽 1 缺省是它的 RT，`usertextures` 绑 `ut`，参考尺寸取那张 RT（`reference.kind: "layer"`）。
 * 槽 0 另绑一张缺省纹理，保证 effect 的 pass 里有可画的基础输入。
 */
function rtBundle(): SceneBundle {
  const dependency = layer(0, {
    size: [500, 300],
    dependedOn: true,
    passes: [pass("objects/0/passes/0", { textures: { 0: 0 } })],
    passthrough: PASSTHROUGH(0),
  });
  const user = layer(1, {
    effects: [
      effect(0, [
        effectDraw(
          pass("objects/1/effects/0/passes/0", {
            textures: { 0: 0 },
            layerComposites: { 1: 0 },
            userTextures: [slot(1, { reference: { kind: "layer", object: 0 } })],
          }),
        ),
      ]),
    ],
  });
  return bundleOf([dependency, user], [texture("dep", [500, 300])]);
}

describe("RT 参考的槽：加载时就有值不生效，第一次写入后按 RT 的比例裁（M3、M8）", () => {
  const final = (live: Live) => draws(live, 1).find((draw) => draw.step.role === "final")!;

  it("加载时属性就有值：仍绑那张 RT，g_Texture1Resolution 是 RT 尺寸，没有上传用户图", async () => {
    const live = await open(rtBundle(), { ut: "x.png" });
    expect(final(live).bindGroup!.key).toContain("_rt_imageLayerComposite_1_a");
    expect(uniform(final(live), RES1, 4)).toEqual([500, 300, 500, 300]);
    expect(live.gpu.named("user ")).toHaveLength(0);
  });

  it("第一次写入之后生效：640×360 按 RT 的 5:3 裁成 600×360，名字 x17，采样器夹取、线性", async () => {
    const live = await open(rtBundle(), { ut: "x.png" });
    await live.set("x.png"); // 同值再写：状态标脏，M8 的「运行中第一次改值」
    expect(final(live).bindGroup!.key).toContain("user x.pngx17");
    expect(uniform(final(live), RES1, 4)).toEqual([600, 360, 600, 360]);
    expect(live.gpu.copies.at(-1)).toMatchObject({
      texture: "user x.pngx17",
      size: { width: 600, height: 360 },
      origin: { x: 20, y: 0 },
    });
    const entry = final(live).bindGroup!.entries.find((item) => item.binding === 4)!;
    expect(JSON.parse((entry.resource as { key: string }).key)).toMatchObject({
      addressModeU: "clamp-to-edge",
      magFilter: "linear",
      maxAnisotropy: 1,
    });
    // 清空：回到 RT
    await live.set("");
    expect(final(live).bindGroup!.key).toContain("_rt_imageLayerComposite_1_a");
    expect(uniform(final(live), RES1, 4)).toEqual([500, 300, 500, 300]);
  });

  it("加载期解码晚到（超时后才完成）只标脏、不算写过：RT 参考的槽仍不生效；之后真写一次才生效", async () => {
    const live = await open(rtBundle());
    // 加载时没解完：来源表之后才有值，只经 onReady 标脏
    live.sources.setValue("ut", "x.png");
    await live.sources.settled();
    advance(live.scene, live.state);
    expect(final(live).bindGroup!.key).toContain("_rt_imageLayerComposite_1_a");
    expect(uniform(final(live), RES1, 4)).toEqual([500, 300, 500, 300]);
    expect(live.state.userWritten.has("ut")).toBe(false);
    await live.set("x.png");
    expect(final(live).bindGroup!.key).toContain("user x.pngx17");
  });

  it("加载时为空、运行中选图：照样按 RT 尺寸裁", async () => {
    const live = await open(rtBundle());
    await live.set("a.png"); // 300×200 → w/h 1.5 ≤ 5/3 → 高裁成 trunc(300 / 1.6666666) = 180
    expect(uniform(final(live), RES1, 4)).toEqual([300, 180, 300, 180]);
  });
});

// ———— 被依赖图层的槽 0 ————

describe("被依赖图层槽 0 换图：独占 RT 重建，引用它的 draw 重绑（rea-p11b 4.2）", () => {
  it("RT 尺寸跟着用户图变，旧的释放，别的图层引用它的 bind group 换成新 RT", async () => {
    const dependency = layer(0, {
      size: [300, 200],
      dependedOn: true,
      passthrough: PASSTHROUGH(0),
      passes: [
        pass("objects/0/passes/0", {
          textures: { 0: 0 },
          userTextures: [slot(0, { reference: { kind: "size", width: 300, height: 200 } })],
        }),
      ],
    });
    const reader = layer(1, {
      passes: [pass("objects/1/passes/0", { textures: { 0: 0 }, layerComposites: { 1: 0 } })],
    });
    const live = await open(bundleOf([dependency, reader], [texture("dep", [300, 200])]));
    const before = internals(live.scene).layerTargets.get(0)!;
    expect([before.width, before.height]).toEqual([300, 200]);
    const readerDraw = () => draws(live, 1)[0];
    const groupBefore = readerDraw().bindGroup;
    expect(uniform(readerDraw(), RES1, 4)).toEqual([300, 200, 300, 200]);

    await live.set("b.png"); // 540×360
    const after = internals(live.scene).layerTargets.get(0)!;
    expect(after).not.toBe(before);
    expect([after.width, after.height]).toEqual([540, 360]);
    expect(before.texture.destroyed).toBe(true);
    // 引用方：新 bind group、新的 g_Texture1Resolution；独占 RT 仍是被依赖图层合成链的第 0 张
    expect(readerDraw().bindGroup).not.toBe(groupBefore);
    expect(uniform(readerDraw(), RES1, 4)).toEqual([540, 360, 540, 360]);
    expect(internals(live.scene).layers[0].resources.composites[0]).toBe(after);
  });
});

// ———— 边界 ————

describe("PNG gamma 校正在 GPU 上传时查表（M9，不读回像素）", () => {
  it("带表：先拷进同尺寸临时纹理，再用一次渲染 pass 画进最终纹理，uniform 就是那张 256 项的表；临时纹理与缓冲用完释放", async () => {
    const live = await open(npotBundle());
    await live.set("g.png"); // 100×80，3:2 → 高裁成 66
    const copy = live.gpu.copies.at(-1)!;
    expect(copy.texture).toBe("user g.pngx15 gamma source");
    expect(copy.size).toEqual({ width: 100, height: 66 });
    expect(live.gpu.passes.filter((label) => label === "user texture gamma")).toHaveLength(1);
    const lut = live.gpu.buffers.find((buffer) => buffer.label === "user texture gamma lut")!;
    const entries = [...new Uint32Array(lut.bytes.buffer, lut.bytes.byteOffset, 256)];
    expect(entries.slice(0, 8)).toEqual([0, 21, 28, 34, 39, 43, 46, 50]);
    expect(entries[255]).toBe(255);
    const temp = live.gpu.textures.find((texture) => texture.label === "user g.pngx15 gamma source")!;
    expect(temp.destroyed).toBe(true);
    const final = live.gpu.textures.find((texture) => texture.label === "user g.pngx15")!;
    expect([final.width, final.height, final.destroyed]).toEqual([100, 66, false]);
    expect(draws(live)[0].bindGroup!.key).toContain("1:user g.pngx15");
  });

  it("不带表（没有 gAMA、sRGB 一族）：直接拷进最终纹理，不建临时纹理、不跑校正 pass", async () => {
    const live = await open(npotBundle());
    await live.set("b.png");
    expect(live.gpu.passes).not.toContain("user texture gamma");
    expect(live.gpu.textures.some((texture) => texture.label.includes("gamma"))).toBe(false);
    expect(live.gpu.copies.at(-1)!.texture).toBe("user b.pngx15");
  });
});

describe("用户纹理的边界", () => {
  it("尺寸超过设备上限：用缺省纹理，记一条 warning（每个纹理名一次）", async () => {
    const live = await open(npotBundle());
    live.gpu.maxTexture = 400;
    await live.set("b.png"); // 540 > 400
    expect(draws(live)[0].bindGroup!.key).toContain("1:npot");
    expect(live.warnings.filter((message) => message.includes("超过设备上限"))).toHaveLength(1);
    expect(live.gpu.named("user ")).toHaveLength(0);
  });

  it("拷贝抛错：释放这张纹理、回缺省、记 warning，不让这一帧失败", async () => {
    const live = await open(npotBundle());
    live.gpu.copyError = new Error("拷贝坏了");
    await live.set("b.png");
    expect(draws(live)[0].bindGroup!.key).toContain("1:npot");
    expect(live.warnings.some((message) => message.includes("拷进纹理失败"))).toBe(true);
    expect(live.gpu.named("user ")[0].destroyed).toBe(true);
  });

  it("没有来源表（不给 userTextures）时所有槽都用缺省纹理", async () => {
    const gpu = new FakeGpu();
    const bundle = npotBundle();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), []);
    state.write({ property: "ut", target: { kind: "user-texture", name: "ut" } }, "a.png");
    scene.sync(state);
    expect(internals(scene).layers[0].draws[0].bindGroup!.key).toContain("1:npot");
  });

  it("GIF / 视频先当无图：槽用缺省纹理", async () => {
    const live = await open(npotBundle());
    await live.set("b.png");
    await live.set("D:/a/anim.GIF");
    expect(draws(live)[0].bindGroup!.key).toContain("1:npot");
    expect(uniform(draws(live)[0], RES0, 4)).toEqual([512, 256, 300, 200]);
  });

  it("槽的来源不是属性（封面 / 快捷方式，P11c / P11d）时忽略，不影响缺省", async () => {
    const bundle = npotBundle();
    bundle.layers[0].passes[0].userTextures = [
      slot(0, {
        source: { kind: "system", name: "$mediaThumbnail" },
        reference: { kind: "size", width: 300, height: 200 },
      }),
    ];
    const live = await open(bundle);
    expect(draws(live)[0].bindGroup!.key).toContain("1:npot");
  });
});

// ———— SceneState 与属性管线 ————

describe("SceneState.write 的 user-texture 目标", () => {
  const binding = { property: "ut", target: { kind: "user-texture" as const, name: "ut" } };

  it("值只认字符串，别的类型当空串；同步交给监听、标脏、记进 userTextures", () => {
    const state = SceneState.fromBundle(bundleOf([], []));
    const seen: [string, string][] = [];
    state.onUserTexture = (name, value) => seen.push([name, value]);
    expect(state.write(binding, "D:/a/b.png")).toBe("applied");
    expect(state.userTextures.get("ut")).toBe("D:/a/b.png");
    expect([...state.takeDirty().userTextures]).toEqual(["ut"]);
    state.write(binding, 3);
    state.write(binding, true);
    expect(seen).toEqual([
      ["ut", "D:/a/b.png"],
      ["ut", ""],
      ["ut", ""],
    ]);
    expect(state.userTextures.get("ut")).toBe("");
    // 取走即清空
    expect(state.takeDirty().userTextures.size).toBe(1);
    expect(state.takeDirty().userTextures.size).toBe(0);
  });

  it("解码完成时的 touchUserTexture 也进脏集合；不需要重编译", () => {
    const state = SceneState.fromBundle(bundleOf([], []));
    state.touchUserTexture("ut");
    expect([...state.takeDirty().userTextures]).toEqual(["ut"]);
    expect(state.needsRecompile({ property: "ut", target: { kind: "user-texture", name: "ut" } }, "x")).toBe(false);
  });

  it("属性合并不把空串当空值跳过：清空 scenetexture 能生效；绑定表就地写、不重编译", () => {
    const properties = new Map<string, { type: string; value: unknown }>();
    expect([...mergeProperties(properties, { ut: { type: "scenetexture", value: "D:/a/b.png" } })]).toEqual([
      ["ut", "D:/a/b.png"],
    ]);
    const cleared = mergeProperties(properties, { ut: { type: "scenetexture", value: "" } });
    expect([...cleared]).toEqual([["ut", ""]]);
    expect(properties.get("ut")).toEqual({ type: "scenetexture", value: "" });
    const plan = planApply([binding], cleared);
    expect(plan.recompile).toEqual([]);
    expect(plan.writes).toEqual([{ binding, value: "" }]);
  });
});
