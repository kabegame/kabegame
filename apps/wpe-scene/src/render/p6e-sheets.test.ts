/**
 * P6e 点 2 的渲染侧单测：`GpuScene.bindSheets`——帧表纹理的共享计时器只在「真正画」的 draw 上推进，并把这一格的
 * `g_Texture<s>Rotation` / `Translation` 写进这个 draw 的 uniform（`.claude/plans/wpe-import/3-scene/phase6/phase-6e-sprite-sheets.md` 点 2）。
 * 假设备照 `render/p9a.test.ts`，另记每个缓冲最后一次 `writeBuffer` 的内容。
 * 期望值依据 WPE 实测 `p6e-shared`：同一张纹理两个图层一隐一显时，隐的回来与显的同格；两个都隐时回来接着隐藏前那格走、不补时间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneSheetFrames, SceneTexture } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { GpuScene } from "./scene";
import { textureAnimationOverride } from "./sheets";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

const USAGE = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 };

interface FakeBuffer {
  label: string;
  size: number;
  bytes: Uint8Array;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  /** 每次 createBindGroup 的描述；`set` 是每次 setBindGroup 交进去的那个（P6e 点 4 测换绑）。 */
  readonly groups: { descriptor: GPUBindGroupDescriptor }[] = [];
  readonly set: { descriptor: GPUBindGroupDescriptor }[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup: (_slot: number, group: { descriptor: GPUBindGroupDescriptor }) => {
        this.set.push(group);
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
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        descriptor,
        createView: () => ({ label: descriptor.label ?? "", size: descriptor.size }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer & { destroy(): void } = {
          label: descriptor.label ?? "",
          size: descriptor.size,
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
      createRenderPipelineAsync: async () => ({}),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
        const group = { descriptor };
        this.groups.push(group);
        return group;
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (target: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView) => {
          const view = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          target.bytes.set(view, offset);
        },
        writeTexture() {},
        copyExternalImageToTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  /** 某个图层的 draw 的 uniform 缓冲（标签 `layer <id> <name> <role>`）。 */
  uniformsOf(object: number): Float32Array {
    // 顶点缓冲与 uniform 缓冲同一个标签：uniform 块是 96 字节
    const found = this.buffers.find(
      (buffer) => buffer.size === 96 && buffer.label.startsWith(`layer ${object + 1} layer ${object} `),
    );
    if (!found) throw new Error(`没有图层 ${object} 的缓冲`);
    return new Float32Array(found.bytes.buffer);
  }
}

/** 帧表程序：槽 0 的采样 + `g_Texture0Rotation`（vec4，偏移 64）与 `Translation`（vec2，偏移 80）。 */
const SHEET_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Texture0Rotation", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 },
    { name: "g_Texture0Translation", type: "vec2<f32>", declared: "vec2", offset: 80, size: 8 },
  ],
  uniformBlockSize: 96,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

/** 4 格、每格 0.1 s 的帧表：第 k 格的 Translation.x = k / 4、Rotation = (1/4, 0, 0, 1)。 */
const SHEET: SceneSheetFrames = {
  version: 3,
  cell: [16, 64],
  total: Math.fround(0.4),
  frames: [0, 1, 2, 3].map((k) => ({
    frametime: Math.fround(0.1),
    image: 0,
    rotation: [0.25, 0, 0, 1],
    translation: [k / 4, 0],
  })),
};

const sheetTexture = (): SceneTexture => ({
  path: "materials/sheet.tex",
  source: "",
  format: 0,
  width: 64,
  height: 64,
  textureWidth: 64,
  textureHeight: 64,
  flags: 6,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width: 64, height: 64, bytes: new Uint8Array(64 * 64 * 4) }],
  frames: SHEET,
});

function pass(key: string, textures: Record<number, number>): ScenePass {
  return {
    key,
    program: 0,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures,
    runtime: {},
    uniforms: {},
    framebuffer: false,
  };
}

function layer(object: number): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [640, 360, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [64, 64],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    // 运行中要隐藏 / 显示：不绑属性的不可见图层不建资源，这里绑上（`buildableLayers`）
    visibleBound: true,
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
    passes: [pass(`objects/${object}/passes/0`, { 0: 0 })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
  };
}

function bundle(count: number, texture: SceneTexture = sheetTexture()): SceneBundle {
  return {
    general: {
      width: 1280,
      height: 720,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: Array.from({ length: count }, (_, i) => layer(i)),
    programs: [SHEET_PROGRAM],
    textures: [texture],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

async function open(count: number, texture?: SceneTexture) {
  const gpu = new FakeGpu();
  const source = bundle(count, texture);
  const state = SceneState.fromBundle(source);
  const scene = await GpuScene.build(gpu.device, source, state, new Set(), [], { particles: { seed: 1 } });
  return { gpu, state, scene };
}

/** 渲染器一帧的顺序：stepParticles（帧号加一）→ update（带本帧 g_Frametime）→ encode。返回每个图层这一帧写进 uniform 的格（Translation.x · 4）。 */
function frame(gpu: FakeGpu, scene: GpuScene, state: SceneState, dt: number, objects: readonly number[]): number[] {
  const input: FrameInput = {
    time: 1,
    frametime: dt,
    daytime: 0.5,
    pointer: [0.5, 0.5],
    pointerLast: [0.5, 0.5],
    cursor: [0.5, 0.5],
  };
  scene.stepParticles(dt, 1, state);
  scene.update(input, state);
  scene.encode(gpu.device.createCommandEncoder(), state);
  return objects.map((object) => Math.round(gpu.uniformsOf(object)[20] * 4));
}

const hide = (state: SceneState, ...objects: number[]) => {
  for (const object of objects) state.layers.get(object)!.visible = false;
};
const show = (state: SceneState, ...objects: number[]) => {
  for (const object of objects) state.layers.get(object)!.visible = true;
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", USAGE);
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：帧表共享计时器（P6e 点 2）", () => {
  it("每个渲染帧最多进一格：dt 远大于帧时长也是一格，同一帧里两个图层画同一格、只推进一次", async () => {
    const { gpu, state, scene } = await open(2);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([1, 1]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([2, 2]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([3, 3]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([0, 0]);
    // Rotation 也写了这一格的值
    expect(Array.from(gpu.uniformsOf(0).subarray(16, 20))).toEqual([0.25, 0, 0, 1]);
    expect(scene.sheetClockOf(0)).toMatchObject({ frame: 0 });
  });

  it("dt 不够一格时只累加（余数累积），不进格", async () => {
    const { gpu, state, scene } = await open(1);
    expect(frame(gpu, scene, state, 0.06, [0])).toEqual([0]);
    expect(frame(gpu, scene, state, 0.06, [0])).toEqual([1]);
    expect(frame(gpu, scene, state, 0.06, [0])).toEqual([1]);
    expect(frame(gpu, scene, state, 0.06, [0])).toEqual([2]);
  });

  it("一隐一显：隐的回来与显的同格，且没有多推进一次（p6e-shared）", async () => {
    const { gpu, state, scene } = await open(2);
    hide(state, 1);
    expect(frame(gpu, scene, state, 0.25, [0])).toEqual([1]);
    expect(frame(gpu, scene, state, 0.25, [0])).toEqual([2]);
    show(state, 1);
    // 同一帧里先画 0（推进到 3），1 的 dt 为 0，同一格
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([3, 3]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([0, 0]);
  });

  it("两个都隐藏：计时器不动、回来接着隐藏前那一格走，不补时间（p6e-shared 的 E / F）", async () => {
    const { gpu, state, scene } = await open(2);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([1, 1]);
    hide(state, 0, 1);
    for (let i = 0; i < 5; i++) frame(gpu, scene, state, 0.25, []);
    expect(scene.sheetClockOf(0)).toMatchObject({ frame: 1 });
    show(state, 0, 1);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([2, 2]);
  });

  it("脱离帧号（sheetOverride ≥ 0）：这个图层画那一格、越界取 0，不推进共享计时器；< 0 走共享计时器", async () => {
    const { gpu, state, scene } = await open(2);
    scene.setSheetOverrides((object) => (object === 1 ? 3 : -1));
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([1, 3]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([2, 3]);
    scene.setSheetOverrides((object) => (object === 1 ? 99 : -1));
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([3, 0]);
    // 只有脱离的图层在画：共享计时器停着
    hide(state, 0);
    const before = { ...scene.sheetClockOf(0)! };
    expect(frame(gpu, scene, state, 0.25, [1])).toEqual([0]);
    expect(scene.sheetClockOf(0)).toEqual(before);
    scene.setSheetOverrides(null);
    show(state, 0);
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([0, 0]);
  });
});

describe("GpuScene：脱离的纹理动画（P6e 点 3）", () => {
  it("脱离且在播的图层按自己的 rate 私有推进（stepParticles 里）、画自己的格；不碰共享计时器；隐藏时照常推进", async () => {
    const { gpu, state, scene } = await open(2);
    scene.setSheetOverrides((object) => textureAnimationOverride(state.textureAnimations.get(object)));
    // 图层 1 脱离：私有 {0, 0}、在播、rate 2；帧时长 0.1，dt 0.06 × 2 = 0.12 每帧进一格
    state.textureAnimations.set(1, { detached: true, playing: true, rate: 2, frame: 0, time: 0 });
    expect(frame(gpu, scene, state, 0.06, [0, 1])).toEqual([0, 1]);
    expect(frame(gpu, scene, state, 0.06, [0, 1])).toEqual([1, 2]);
    // 隐藏图层 1：不画，但私有推进照常（rea-p6e-sheet 3.3，不看可见性）
    hide(state, 1);
    frame(gpu, scene, state, 0.06, [0]);
    frame(gpu, scene, state, 0.06, [0]);
    expect(state.textureAnimations.get(1)!.frame).toBe(0);
    show(state, 1);
    // 暂停：不推进；画当前私有格；共享计时器仍走自己的
    state.textureAnimations.get(1)!.playing = false;
    const shared = scene.sheetClockOf(0)!.frame;
    expect(frame(gpu, scene, state, 0.25, [1])).toEqual([0]);
    expect(frame(gpu, scene, state, 0.25, [0, 1])[1]).toBe(0);
    expect(scene.sheetClockOf(0)!.frame).not.toBe(shared);
  });

  it("越界的私有帧号画第 0 格、负的走共享计时器（setFrame(99) / setFrame(-1)，p6e-api X2 / X3）", async () => {
    const { gpu, state, scene } = await open(2);
    scene.setSheetOverrides((object) => textureAnimationOverride(state.textureAnimations.get(object)));
    state.textureAnimations.set(1, { detached: true, playing: false, rate: 1, frame: 99, time: 0 });
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([1, 0]);
    state.textureAnimations.get(1)!.frame = -1;
    expect(frame(gpu, scene, state, 0.25, [0, 1])).toEqual([2, 2]);
  });
});

/** 多图像帧表（P6e 点 4）：图像 0 是 64²，图像 1 是 32²；4 格，第 0、1 格在图像 0，第 2、3 格在图像 1。 */
const multiTexture = (): SceneTexture => ({
  ...sheetTexture(),
  images: [[{ width: 32, height: 32, bytes: new Uint8Array(32 * 32 * 4) }]],
  frames: { ...SHEET, frames: SHEET.frames.map((f, k) => ({ ...f, image: k >= 2 ? 1 : 0 })) },
});

/** 一帧之后，这一帧里每次 setBindGroup 交进去的、绑着槽 0 纹理（binding 1）的那些组，各自纹理视图的宽。 */
function boundWidths(gpu: FakeGpu, from: number): number[] {
  return gpu.set.slice(from).flatMap((group) => {
    const entry = (group.descriptor.entries as GPUBindGroupEntry[]).find((e) => e.binding === 1);
    return entry ? [(entry.resource as unknown as { size: { width: number } }).size.width] : [];
  });
}

describe("GpuScene：多图像帧表换绑图像（P6e 点 4）", () => {
  it("跨图像的帧换绑那张图像的纹理，同帧里多个 draw 一致；回到图像 0 换回来", async () => {
    const { gpu, state, scene } = await open(2, multiTexture());
    const widths: number[][] = [];
    for (let i = 0; i < 5; i++) {
      const from = gpu.set.length;
      frame(gpu, scene, state, 0.25, [0, 1]);
      widths.push(boundWidths(gpu, from));
    }
    // 第 1、2、3、0、1 格 → 图像 0、1、1、0、0
    expect(widths).toEqual([
      [64, 64],
      [32, 32],
      [32, 32],
      [64, 64],
      [64, 64],
    ]);
  });

  it("bind group 按「各槽图像号」缓存：转一圈之后再转不再新建；单图像帧表不多建", async () => {
    const multi = await open(1, multiTexture());
    for (let i = 0; i < 4; i++) frame(multi.gpu, multi.scene, multi.state, 0.25, [0]);
    const built = multi.gpu.groups.length;
    for (let i = 0; i < 8; i++) frame(multi.gpu, multi.scene, multi.state, 0.25, [0]);
    expect(multi.gpu.groups.length).toBe(built);
    // 单图像帧表：全程只有建 draw 时那一个静态 bind group
    const single = await open(1);
    const before = single.gpu.groups.length;
    for (let i = 0; i < 8; i++) frame(single.gpu, single.scene, single.state, 0.25, [0]);
    expect(single.gpu.groups.length).toBe(before);
    expect(new Set(single.gpu.set).size).toBe(1);
  });

  it("image 越界（≥ 图像数）按 0 处理", async () => {
    const texture = multiTexture();
    texture.frames!.frames[2].image = 7;
    const { gpu, state, scene } = await open(1, texture);
    frame(gpu, scene, state, 0.25, [0]);
    const from = gpu.set.length;
    frame(gpu, scene, state, 0.25, [0]);
    expect(boundWidths(gpu, from)).toEqual([64]);
  });
});
