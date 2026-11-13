/**
 * P5d 步骤 2（透视相机）的场景、视差与渲染器侧（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 2」点 4–6、9）：
 * - `GpuScene`（假设备）：透视场景的场景目标取 `size`、VP = P·V、`g_EyePosition` = eye、视图向量进全部 draw、粒子朝向用相机视线
 *   （dna_fragment 抓帧：`g_OrientationForward` = normalize(eye − center) = (0.691, 0.494, 0.528)、`Up` = (−0.392, 0.870, −0.299)）；
 *   正交场景的视图向量是常量；fullscreen 合成 RT 的 `"scene"` 取场景目标尺寸；
 * - 视差：透视场景 P 初值 0、eye (0, 0) 时 `g_ParallaxPosition` 是 NaN、eye.x ≠ 0 时钳成 0 / 1、不移动对象；
 * - 渲染器：透视场景铺满不看样式、路径在实时帧推进（补画帧不推进、重编译保留、新渲染器从头）、分辨率变化去抖后回调一次；正交场景不回调。
 * 假设备与渲染器的搭法照 `parallax.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues } from "../compile/bindings";
import type { SceneBundle, SceneGeneral, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import type { CameraPath, SceneCameraJson } from "../compile/camera";
import { parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { JsonObject } from "../compile/model";
import { frameCamera, probePerspective } from "../dev/particleCorners";
import type { TranslateResult } from "../wpesl2wgsl";
import {
  initialPerspectiveFrame,
  lookAtVectors,
  perspectiveCamera,
  replayCameraPath,
  stepCameraSource,
  type CameraPathState,
} from "./camera";
import { acquireGpu } from "./device";
import { compositeSize } from "./graph";
import {
  advanceParallax,
  drawParallax,
  initialParallaxPoint,
  initialParallaxState,
  parallaxInput,
  type ParallaxFields,
  type ParallaxState,
} from "./parallax";
import { RENDER_SIZE_SETTLE_MS, SceneRenderer } from "./renderer";
import { GpuScene, type SceneCamera } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备（同 parallax.test.ts） ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  writes: number;
  destroy(): void;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly textures: { label: string; size: unknown }[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
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
        this.textures.push({ label: descriptor.label ?? "", size: descriptor.size });
        return {
          label: descriptor.label ?? "",
          format: descriptor.format,
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy() {},
        };
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          writes: 0,
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
          buffer.writes++;
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

const mat4 = (name: string, offset: number) => ({
  name,
  type: "mat4x4<f32>",
  declared: "mat4",
  offset,
  size: 64,
});
const vec3 = (name: string, offset: number) => ({ name, type: "vec3<f32>", declared: "vec3", offset, size: 12 });

/** 图像程序：MVP、VP、眼位与三个视图向量。 */
const IMAGE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    mat4("g_ModelViewProjectionMatrix", 0),
    mat4("g_ViewProjectionMatrix", 64),
    vec3("g_EyePosition", 128),
    vec3("g_ViewForward", 144),
    vec3("g_ViewRight", 160),
    vec3("g_ViewUp", 176),
  ],
  uniformBlockSize: 192,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

/** 粒子程序：MVP、朝向、视图向量。 */
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
  uniforms: [
    mat4("g_ModelViewProjectionMatrix", 0),
    vec3("g_OrientationForward", 64),
    vec3("g_OrientationUp", 80),
    vec3("g_ViewForward", 96),
    vec3("g_ViewRight", 112),
    vec3("g_ViewUp", 128),
  ],
  uniformBlockSize: 144,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function pass(key: string, program: number, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program,
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

const texture = (width: number, height: number): SceneTexture => ({
  path: `t${width}x${height}`,
  source: "",
  format: 0,
  width,
  height,
  textureWidth: width,
  textureHeight: height,
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width, height, bytes: new Uint8Array(width * height * 4) }],
});

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [0, 0, 0],
    scale: [0.01, 0.01, 1],
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
    passes: [pass(`objects/${object}/passes/0`, 0, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

function particleLayer(object: number, json: JsonObject = {}, orthographic = false): SceneLayer {
  const particle = parseParticle(
    {
      maxcount: 4,
      emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 1 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      ...json,
    },
    { file: `particles/${object}.json`, orthographic },
  );
  particle.passes = [pass(`objects/${object}/particle/passes/0`, 1, { blending: "additive" })];
  return layer(object, { name: `particles ${object}`, scale: [1, 1, 1], passes: [], size: [], particle });
}

function fields(extra: Partial<GeneralValues> = {}): GeneralValues {
  return { ...generalDefaults(), ...extra };
}

/** dna_fragment 抓帧的斜相机：eye − center 的单位向量是 (0.691, 0.494, 0.528)。 */
const TILTED: SceneCameraJson = { eye: [6.91, 4.94, 5.28], center: [0, 0, 0], up: [0, 1, 0], paths: [] };

function general(perspective: boolean, extra: Partial<GeneralValues> = {}, camera = TILTED): SceneGeneral {
  return {
    width: perspective ? 0 : 1920,
    height: perspective ? 0 : 1080,
    perspective,
    camera: perspective ? camera : null,
    fields: fields(extra),
    clearVariable: false,
    perspectiveOverrideFov: particleFov(95),
    postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
    bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
  };
}

function bundleOf(
  layers: SceneLayer[],
  perspective = true,
  extra: Partial<GeneralValues> = {},
  camera?: SceneCameraJson,
): SceneBundle {
  return {
    general: general(perspective, extra, camera),
    layers,
    programs: [IMAGE_PROGRAM, PARTICLE_PROGRAM],
    textures: [texture(64, 64)],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  step: { kind: string; role?: string };
  uniformBuffer: FakeBuffer | null;
}
const drawsOf = (scene: GpuScene): DrawView[] => [...(scene as unknown as { draws: Set<DrawView> }).draws];
const floats = (draw: DrawView, offset: number, count: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + count * 4)));
const f32s = (values: readonly number[]) => values.map((value) => Math.fround(value));
/** 三个 vec3（std140 每个占 16 字节）。 */
const vec3s = (draw: DrawView, offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => floats(draw, offset + 16 * i, 3)).flat();

async function open(bundle: SceneBundle, size?: [number, number]) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
    size,
  });
  return { gpu, state, scene };
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：透视相机（P5d 步骤 2 点 4、5）", () => {
  it("场景目标取 size（不看 general.width/height = 0）；没给时 1920×1080；正交场景照旧按场景尺寸", async () => {
    const { scene } = await open(bundleOf([layer(0)]), [1280, 720]);
    expect([scene.width, scene.height]).toEqual([1280, 720]);
    const fallback = await open(bundleOf([layer(0)]));
    expect([fallback.scene.width, fallback.scene.height]).toEqual([1920, 1080]);
    const ortho = await open(bundleOf([layer(0)], false), [1280, 720]);
    expect([ortho.scene.width, ortho.scene.height]).toEqual([1920, 1080]);
  });

  it("建场景时就是加载时的相机：VP = P·V（宽高比取场景目标）、g_EyePosition = eye、视图向量是相机的 f / s / u", async () => {
    const bundle = bundleOf([layer(0, { origin: [1, 2, -3] })]);
    const { scene } = await open(bundle, [1280, 720]);
    const expected = initialPerspectiveFrame(TILTED, bundle.general.fields, 1280, 720);
    const draw = drawsOf(scene).find((item) => item.object === 0)!;
    expect(floats(draw, 64, 16)).toEqual(Array.from(expected.viewProjection));
    expect(floats(draw, 128, 3)).toEqual(f32s(TILTED.eye));
    // 视图向量按 float 化之后的 eye 算（`perspectiveCamera`），和按 double 的只差舍入
    expect(floats(draw, 144, 3)).toEqual(expected.vectors.forward);
    expect(floats(draw, 160, 3)).toEqual(expected.vectors.right);
    expect(floats(draw, 176, 3)).toEqual(expected.vectors.up);
    const vectors = lookAtVectors(TILTED.eye, TILTED.center, TILTED.up);
    expected.vectors.forward.forEach((value, i) => expect(value).toBeCloseTo(vectors.forward[i], 6));
    // 普通图像层的 MVP = VP · W（p5d-persp：顶点按 size 摆、scale 0.01，按世界单位画）
    const mvp = floats(draw, 0, 16);
    expect(mvp[0]).toBeCloseTo(expected.viewProjection[0] * 0.01, 6);
    // 宽高比取场景目标（1280/720），不是 general 的 0/0
    expect(expected.projection[0]).toBeCloseTo(expected.projection[5] / (1280 / 720), 5);
  });

  it("粒子朝向用相机的视线与上方向：dna_fragment 的 g_OrientationForward / Up，g_ViewUp / Right 由引擎 uniform 写", async () => {
    const bundle = bundleOf([particleLayer(0)]);
    const { scene } = await open(bundle, [1920, 1080]);
    const draw = drawsOf(scene).find((item) => item.step.kind === "particles")!;
    const forward = floats(draw, 64, 3);
    const up = floats(draw, 80, 3);
    [0.691, 0.494, 0.528].forEach((value, i) => expect(forward[i]).toBeCloseTo(value, 3));
    // 抓帧读数只有三位，相机按它摆的 eye 也是近似：Up 放宽到两位
    [-0.392, 0.87, -0.299].forEach((value, i) => expect(up[i]).toBeCloseTo(value, 2));
    const { vectors } = initialPerspectiveFrame(TILTED, bundle.general.fields, 1920, 1080);
    expect(vec3s(draw, 96, 3)).toEqual([...vectors.forward, ...vectors.right, ...vectors.up]);
  });

  it("p5d-tilt（eye (6, 4, 10) 看原点）：screen 朝向 Forward = −视线、Up = g_ViewUp", async () => {
    const tilt: SceneCameraJson = { eye: [6, 4, 10], center: [0, 0, 0], up: [0, 1, 0], paths: [] };
    const { scene } = await open(bundleOf([particleLayer(0)], true, {}, tilt), [1920, 1080]);
    const draw = drawsOf(scene).find((item) => item.step.kind === "particles")!;
    const forward = floats(draw, 64, 3);
    const up = floats(draw, 80, 3);
    [0.48666, 0.32444, 0.81111].forEach((value, i) => expect(forward[i]).toBeCloseTo(value, 4));
    [-0.16692, 0.94591, -0.27821].forEach((value, i) => expect(up[i]).toBeCloseTo(value, 4));
    expect(floats(draw, 112, 3).map((value) => +value.toFixed(5))).toEqual([0.85749, 0, -0.5145]);
  });

  it("setCamera 透视：换 VP、眼位与视图向量，下一次 setParallax 刷全部 draw；同一帧再交一次不重写", async () => {
    const bundle = bundleOf([layer(0), particleLayer(1)]);
    const { scene, state } = await open(bundle, [1920, 1080]);
    const pose = { eye: [0, 0, 10] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
    const frame = perspectiveCamera({
      pose: { ...pose, up: [0, 1, 0], zoom: 1 },
      fields: state.general,
      time: 0,
      width: 1920,
      height: 1080,
    });
    scene.setCamera({ kind: "perspective", frame });
    scene.setParallax(null, state);
    scene.sync(state);
    scene.update(FRAME, state);
    const image = drawsOf(scene).find((item) => item.object === 0)!;
    const particle = drawsOf(scene).find((item) => item.object === 1)!;
    expect(floats(image, 64, 16)).toEqual(Array.from(frame.viewProjection));
    expect(floats(image, 128, 3)).toEqual([0, 0, 10]);
    expect(vec3s(image, 144, 3)).toEqual([0, 0, -1, 1, 0, 0, 0, 1, 0]);
    // 正对相机：朝向是单位基（p5d-ptc 的读数）
    expect(vec3s(particle, 64, 2)).toEqual([0, 0, 1, 0, 1, 0]);
    expect(vec3s(particle, 96, 3)).toEqual([0, 0, -1, 1, 0, 0, 0, 1, 0]);
    // 同一帧：不标脏，不重写
    const writes = drawsOf(scene).map((item) => item.uniformBuffer?.writes ?? 0);
    const again = perspectiveCamera({
      pose: { ...pose, up: [0, 1, 0], zoom: 1 },
      fields: state.general,
      time: 0,
      width: 1920,
      height: 1080,
    });
    scene.setCamera({ kind: "perspective", frame: again });
    scene.setParallax(null, state);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(drawsOf(scene).map((item) => item.uniformBuffer?.writes ?? 0)).toEqual(writes);
  });

  it("正交场景：视图向量是常量 (0, 0, −1) / (1, 0, 0) / (0, 1, 0)，眼位照旧 (W/2, H/2, 2000)", async () => {
    const { scene, state } = await open(bundleOf([layer(0), particleLayer(1, {}, true)], false));
    scene.setCamera({ shake: [3, 4], zoom: 1 });
    scene.setParallax(null, state);
    scene.sync(state);
    scene.update(FRAME, state);
    const image = drawsOf(scene).find((item) => item.object === 0)!;
    const particle = drawsOf(scene).find((item) => item.object === 1)!;
    expect(floats(image, 128, 3)).toEqual([963, 544, 2000]);
    expect(vec3s(image, 144, 3)).toEqual([0, 0, -1, 1, 0, 0, 0, 1, 0]);
    expect(vec3s(particle, 96, 3)).toEqual([0, 0, -1, 1, 0, 0, 0, 1, 0]);
    expect(vec3s(particle, 64, 2)).toEqual([0, 0, 1, 0, 1, 0]);
  });

  it('fullscreen 合成 RT 的 "scene" 取场景目标尺寸（编译期不再取 general 的宽高）', () => {
    const fullscreen = {
      size: [2, 2],
      solidLayer: false,
      instanced: false,
      passthroughModel: true,
      fullscreenSize: "scene" as const,
    };
    expect(compositeSize(fullscreen, undefined, [1280, 720])).toEqual([1280, 720]);
    expect(compositeSize(fullscreen, undefined)).toEqual([4, 4]);
    expect(compositeSize({ ...fullscreen, fullscreenSize: [48, 40] }, undefined, [1280, 720])).toEqual([48, 40]);
  });
});

describe("视差在透视场景（P5d 步骤 2 点 6，rea-p5-camera 6.1、6.2）", () => {
  const on: ParallaxFields = {
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxdelay: 0,
    cameraparallaxmouseinfluence: 1,
  };
  const step = (state: ParallaxState, eye: [number, number]) =>
    advanceParallax(state, parallaxInput(on, { pointer: [0.8, 0.2], frametime: 0.05, width: 0, height: 0, eye }));

  it("P 初值 (0, 0)；g_ParallaxPosition 初值仍是 (0.5, 0.5)；正交场景不变", () => {
    expect(initialParallaxPoint(0, 0, true)).toEqual([0, 0]);
    expect(initialParallaxState(0, 0, true)).toEqual({ point: [0, 0], position: [0.5, 0.5] });
    expect(initialParallaxPoint(1920, 1080)).toEqual([962, 542]);
  });

  it("W = H = 0：目标点就是 eye.xy；eye (0, 0) 时 g_ParallaxPosition 是 NaN（不钳成 0），eye.x ≠ 0 时钳成 0 / 1", () => {
    const zero = step(initialParallaxState(0, 0, true), [0, 0]);
    expect(zero.point).toEqual([0, 0]);
    expect(zero.position.every(Number.isNaN)).toBe(true);
    const off = step(initialParallaxState(0, 0, true), [3, -2]);
    expect(off.point).toEqual([3, -2]);
    expect(off.position).toEqual([1, 0]);
  });

  it("不移动对象：drawParallax 在透视场景恒为 null，正交场景照旧", () => {
    const state = initialParallaxState(0, 0, true);
    expect(drawParallax(state, on, true)).toBeNull();
    expect(drawParallax(state, on)).toEqual({ point: [0, 0], amount: 0.5 });
  });
});

// ———— 渲染器 ————

/** `gen_d.py` 的 KBCAM：第一条 eye.x 0 → 2 → 6（duration 4），第二条 eye (0, 3, 10)（duration 2）。 */
const KBCAM: CameraPath[] = [
  {
    duration: 4,
    keys: [0, 2, 4].map((t, i) => ({
      t,
      eye: [[0, 2, 6][i], 0, 10],
      center: [[0, 2, 6][i], 0, 0],
      up: [0, 1, 0],
      zoom: 1,
    })),
  },
  { duration: 2, keys: [{ t: 0, eye: [0, 3, 10], center: [0, 3, 0], up: [0, 1, 0], zoom: 1 }] },
];
const PATH_CAMERA: SceneCameraJson = { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], paths: KBCAM };

describe("渲染器：透视场景（P5d 步骤 2 点 4、5）", () => {
  async function start(options: { onRenderSizeChange?: () => void; dts?: number[] } = {}) {
    const frames: FrameRequestCallback[] = [];
    const gpu = new FakeGpu();
    vi.mocked(acquireGpu).mockResolvedValue({
      device: gpu.device,
      features: new Set(),
      info: { vendor: "", architecture: "", description: "", features: [] },
    } as unknown as Awaited<ReturnType<typeof acquireGpu>>);
    vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const context = {
      configure() {},
      unconfigure() {},
      getCurrentTexture: () => ({ createView: () => ({ label: "canvas" }) }),
    };
    const rect = { width: 160, height: 90 };
    const canvas = {
      width: 100,
      height: 100,
      getContext: () => context,
      getBoundingClientRect: () => ({ ...rect }),
    } as unknown as HTMLCanvasElement;
    const renderer: SceneRenderer = await SceneRenderer.create(canvas, {
      maxFps: 0,
      beforeFrame: (dt) => options.dts?.push(dt),
      onRenderSizeChange: options.onRenderSizeChange,
    });
    return { renderer, frames, rect, gpu };
  }
  const internals = (renderer: SceneRenderer) =>
    renderer as unknown as {
      cameraPath: CameraPathState;
      parallax: ParallaxState;
      placement: { rect: number[] };
      resize(): void;
    };

  it("场景目标取 fullResolution；铺放与指针按 stretch（样式不起作用）；视差点初值 (0, 0)", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { renderer, rect } = await start();
    renderer.setStyle("center");
    await renderer.load(bundleOf([layer(0)]));
    expect(renderer.sceneStats).toMatchObject({ width: 160, height: 90 });
    expect(internals(renderer).placement.rect).toEqual([0, 0, 160, 90]);
    renderer.setPointer(0.25, 0.75);
    const update = vi.spyOn(renderer.currentScene!, "update");
    renderer.setPaused(true);
    renderer.redraw();
    expect(update.mock.lastCall![0].pointer).toEqual([0.25, 0.75]);
    expect(internals(renderer).parallax.point).toEqual([0, 0]);
    renderer.setStyle("fit");
    renderer.redraw();
    expect(internals(renderer).placement.rect).toEqual([0, 0, 160, 90]);
    // 画布变了、还没重新加载时（场景目标仍是 160×90）：照样铺满整块画布，指针原样（按样式会留边、换算）
    rect.width = 240;
    internals(renderer).resize();
    renderer.redraw();
    expect(internals(renderer).placement.rect).toEqual([0, 0, 240, 90]);
    renderer.setPointer(0.1, 0.9);
    renderer.redraw();
    expect(update.mock.lastCall![0].pointer).toEqual([0.1, 0.9]);
    renderer.destroy();
  });

  it("路径在实时帧求值后推进（同 replayCameraPath），补画帧不推进；粒子步进之后交给 setCamera；重编译保留、新渲染器从头", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const dts: number[] = [];
    const { renderer, frames } = await start({ dts });
    const bundle = () => bundleOf([layer(0)], true, {}, PATH_CAMERA);
    await renderer.load(bundle());
    const scene = renderer.currentScene!;
    const order: string[] = [];
    const stepParticles = vi.spyOn(scene, "stepParticles").mockImplementation(() => void order.push("step"));
    const setCamera = vi.spyOn(scene, "setCamera");
    setCamera.mockImplementation(function (this: GpuScene, ...args) {
      order.push("camera");
      return GpuScene.prototype.setCamera.apply(this, args);
    });
    for (let i = 0; i < 12; i++) {
      now += 250;
      frames.at(-1)!(now);
    }
    expect(order.slice(0, 2)).toEqual(["step", "camera"]);
    expect(internals(renderer).cameraPath).toEqual(replayCameraPath(KBCAM, dts));
    // 交给场景的是推进之前的状态求出的姿态
    const before = replayCameraPath(KBCAM, dts.slice(0, -1));
    const expected = stepCameraSource(PATH_CAMERA, before, dts.at(-1)!).pose;
    const last = setCamera.mock.lastCall![0];
    expect(last.kind).toBe("perspective");
    if (last.kind === "perspective") {
      expect(last.frame.eye).toEqual(f32s(expected.eye));
      // 宽高比取场景目标（160×90），不是 general 的 0 / 0
      expect(last.frame.projection[5] / last.frame.projection[0]).toBeCloseTo(160 / 90, 5);
    }
    // 补画帧：不推进
    const path = internals(renderer).cameraPath;
    renderer.setPaused(true);
    renderer.redraw();
    expect(internals(renderer).cameraPath).toEqual(path);
    expect(stepParticles).toHaveBeenCalled();
    // 重编译（同一渲染器再 load）保留
    renderer.setPaused(false);
    await renderer.load(bundle());
    // 接着推（加载时画的第一帧也是实时帧，帧时间记在 dts 里）；重置的话只剩最后一帧
    expect(internals(renderer).cameraPath).toEqual(replayCameraPath(KBCAM, dts));
    expect(internals(renderer).cameraPath).not.toEqual(replayCameraPath(KBCAM, dts.slice(-1)));
    renderer.destroy();
    const second = await start();
    await second.renderer.load(bundle());
    expect(internals(second.renderer).cameraPath.path).toBe(0);
    expect(internals(second.renderer).cameraPath.key).toBe(0);
    second.renderer.destroy();
  });

  it(`分辨率变了：稳定 ${RENDER_SIZE_SETTLE_MS} ms 后回调一次，期间再变重新计时，回到原尺寸取消；正交场景不回调`, async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const onRenderSizeChange = vi.fn();
    const { renderer, rect } = await start({ onRenderSizeChange });
    await renderer.load(bundleOf([layer(0)]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const resize = () => internals(renderer).resize();
    rect.width = 200;
    resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS - 1);
    rect.width = 240;
    resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS - 1);
    expect(onRenderSizeChange).not.toHaveBeenCalled();
    // 同一尺寸再量一次不重新计时
    resize();
    vi.advanceTimersByTime(1);
    expect(onRenderSizeChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 4);
    expect(onRenderSizeChange).toHaveBeenCalledTimes(1);
    // 回到建场景时的尺寸：取消
    rect.width = 300;
    resize();
    rect.width = 160;
    resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(onRenderSizeChange).toHaveBeenCalledTimes(1);
    // 宿主重新加载之后按新尺寸建，不再回调
    vi.useRealTimers();
    rect.width = 240;
    resize();
    await renderer.load(bundleOf([layer(0)]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(renderer.sceneStats).toMatchObject({ width: 240, height: 90 });
    expect(onRenderSizeChange).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    renderer.destroy();

    const ortho = vi.fn();
    const second = await start({ onRenderSizeChange: ortho });
    await second.renderer.load(bundleOf([layer(0)], false));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    second.rect.width = 400;
    internals(second.renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(ortho).not.toHaveBeenCalled();
    second.renderer.destroy();
  });
});

describe("dev 探针的透视相机（P5d 步骤 2 点 8）", () => {
  it("frameCamera：第 k 次按 dts[k] 推路径（同渲染器），交的是透视那一种、eyes 记 eye.xy；没给 dts 时停在 t = 0；正交场景照旧", () => {
    const calls: SceneCamera[] = [];
    const scene = { setCamera: (camera: SceneCamera) => void calls.push(camera) };
    const bundle = bundleOf([layer(0)], true, {}, PATH_CAMERA);
    const state = SceneState.fromBundle(bundle);
    const perspective = probePerspective(bundle, [1920, 1080])!;
    const dts = [0.25, 0.25, 0.5, 0.25];
    const cameras = frameCamera(scene, state, 0, perspective, dts);
    for (let i = 0; i < dts.length; i++) cameras.apply(i);
    expect(cameras.path).toEqual(replayCameraPath(KBCAM, dts));
    // 第 3 次求值用前两帧推过的状态
    const third = stepCameraSource(PATH_CAMERA, replayCameraPath(KBCAM, dts.slice(0, 2)), dts[2]).pose;
    const camera = calls[2];
    expect(camera.kind).toBe("perspective");
    if (camera.kind === "perspective") expect(camera.frame.eye).toEqual(f32s(third.eye));
    expect(cameras.eyes[2]).toEqual([Math.fround(third.eye[0]), Math.fround(third.eye[1])]);
    // 没给 dts：路径不动
    const still = frameCamera(scene, state, 0, perspective);
    still.apply(5);
    expect(still.path).toEqual({ path: 0, key: 0, t: 0 });
    // 正交场景：s 与 zoom
    expect(probePerspective(bundleOf([layer(0)], false), [1920, 1080])).toBeUndefined();
    const ortho = frameCamera(scene, SceneState.fromBundle(bundleOf([layer(0)], false)), 1080);
    expect(ortho.apply(1)).toEqual([0, 0]);
    expect(calls.at(-1)).toEqual({ shake: [0, 0], zoom: 1 });
  });
});
