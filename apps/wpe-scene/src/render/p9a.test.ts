/**
 * P9a 步骤 2 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase9/phase-9a-playback.md`「步骤 2」）：
 * - `uploadTexture` 的视频分支：`rgba8unorm`、纹理尺寸、一级 mip、能拷外部图像，不写数据（初值全 0，rea-p9-video 第 8 节）；
 * - `checkRenderable` 不把没有 mip 的视频纹理当缺；
 * - `GpuScene.encode`：画到绑定视频纹理的 draw 时问 `VideoSink.drawn`，交来元素就 `copyExternalImageToTexture`；不可见图层与着色器
 *   没绑定的槽不问（WPE 只逐槽更新程序用到的槽，rea 第 2 节第 4 条）；尺寸不同只拷重叠部分（决定 3）、`videoWidth` 为 0 跳过、
 *   拷贝抛错不让这一帧失败，warning 每张纹理每种一次；
 * - `SceneRenderer`：换上场景时接上 sink（第一帧就问），实时帧开头 `beginFrame`、在粒子步进之前，补画帧不调。
 * 假设备照 `render/particles.test.ts`，另记纹理描述与外部图像拷贝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { UserTextureProvider } from "../usertex/sources";
import type { VideoSink } from "../video/sceneVideos";
import type { TranslateResult } from "../wpesl2wgsl";
import { acquireGpu } from "./device";
import { SceneRenderer } from "./renderer";
import { checkRenderable, GpuScene } from "./scene";
import { SceneState } from "./state";
import { uploadTexture } from "./textures";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));

const USAGE = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 };

interface FakeTexture {
  label: string;
  descriptor: GPUTextureDescriptor;
  createView(): { label: string };
  destroy(): void;
}

interface ExternalCopy {
  source: unknown;
  texture: string;
  size: { width: number; height: number };
}

/** 假设备：记录建过的纹理（描述）、`writeTexture` 与外部图像拷贝；`copyError` 非空时外部图像拷贝抛它。 */
class FakeGpu {
  readonly textures: FakeTexture[] = [];
  readonly copies: ExternalCopy[] = [];
  readonly writes: string[] = [];
  copyError: Error | null = null;
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
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          descriptor,
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy() {},
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => ({
        label: descriptor.label ?? "",
        size: descriptor.size,
        destroy() {},
      }),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async () => ({}),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() {},
        writeTexture: (destination: GPUTexelCopyTextureInfo) =>
          this.writes.push((destination.texture as unknown as FakeTexture).label),
        copyExternalImageToTexture: (
          source: GPUCopyExternalImageSourceInfo,
          destination: GPUCopyExternalImageDestInfo,
          size: { width: number; height: number },
        ) => {
          if (this.copyError) throw this.copyError;
          this.copies.push({
            source: source.source,
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
  }

  texture(label: string): FakeTexture {
    const found = this.textures.find((texture) => texture.label === label);
    if (!found) throw new Error(`没有纹理 ${label}`);
    return found;
  }

  encode(scene: GpuScene, state: SceneState): void {
    scene.encode(this.device.createCommandEncoder(), state);
  }
}

// ———— bundle ————

/** 图像程序：只绑槽 0（`textures` 只有一项）。 */
const IMAGE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
  uniformBlockSize: 64,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

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

const image = (path: string, width: number, height: number): SceneTexture => ({
  path,
  source: "",
  format: 0,
  width,
  height,
  textureWidth: width,
  textureHeight: height,
  flags: 2,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width, height, bytes: new Uint8Array(width * height * 4) }],
});

/** 视频纹理：没有 mip，只有磁盘上的区间（`compile/tex.ts` 的 `video`），标志 34 = Video + ClampUVs。 */
const video = (path: string, width = 1280, height = 720): SceneTexture => ({
  path,
  source: "project",
  format: 0,
  width,
  height,
  textureWidth: width,
  textureHeight: height,
  flags: 34,
  clampUVs: true,
  noInterpolation: false,
  mips: [],
  video: { path: `P:/p/${path}`, start: 91, end: 91 + 1000 },
});

function layer(object: number, textures: Record<number, number>, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [640, 360, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1280, 720],
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
    passes: [pass(`objects/${object}/passes/0`, textures)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/**
 * 纹理：0 视频、1 普通图像、2 视频（只给不可见图层用）、3 视频（只放在着色器不绑定的槽 1）。图层：0 画视频 0；1 画图像；
 * 2 不可见、画视频 2；3 槽 0 是图像、槽 1 是视频 3；4 又画视频 0（同一张纹理两个图层）。
 */
function bundle(layers?: SceneLayer[]): SceneBundle {
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
    layers: layers ?? [
      layer(0, { 0: 0 }),
      layer(1, { 0: 1 }),
      layer(2, { 0: 2 }, { visible: false }),
      layer(3, { 0: 1, 1: 3 }),
      layer(4, { 0: 0 }),
    ],
    programs: [IMAGE_PROGRAM],
    textures: [
      video("materials/v0.tex"),
      image("materials/i.tex", 64, 64),
      video("materials/v2.tex"),
      video("materials/v3.tex"),
    ],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

/** 不可见图层（`visible: false`、没绑属性、没有脚本）不建资源（`buildableLayers`），所以视频 2 不会被问到。 */
async function open(source = bundle()) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(source);
  const warnings: string[] = [];
  const scene = await GpuScene.build(gpu.device, source, state, new Set(), warnings, { particles: { seed: 1 } });
  return { gpu, state, scene, warnings };
}

/** 替身视频元素：只有 `copyVideo` 读的两个尺寸。 */
const element = (videoWidth = 1280, videoHeight = 720) => ({ videoWidth, videoHeight }) as unknown as HTMLVideoElement;

/** 记录调用的 sink：`frames` 给出每个下标交出的元素（没有就 null）。 */
function sink(frames: Map<number, HTMLVideoElement | null> = new Map()) {
  const drawn: number[] = [];
  const value: VideoSink & { drawn: (texture: number) => HTMLVideoElement | null } = {
    beginFrame: vi.fn(),
    drawn: (texture) => {
      drawn.push(texture);
      return frames.get(texture) ?? null;
    },
  };
  return { sink: value, drawn, frames };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", USAGE);
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadTexture：视频纹理（P9a 步骤 2）", () => {
  it("rgba8unorm、纹理尺寸、一级 mip、能拷外部图像；不写数据（初值全 0）", () => {
    const gpu = new FakeGpu();
    const texture = { ...video("materials/v.tex", 1920, 1080), textureWidth: 2048, textureHeight: 1024 };
    uploadTexture(gpu.device, texture);
    expect(gpu.textures.map((item) => item.descriptor)).toEqual([
      {
        label: "materials/v.tex",
        // 取纹理尺寸（`textureWidth` / `textureHeight`），不取图像尺寸；没有 mipLevelCount（缺省 1）
        size: { width: 2048, height: 1024 },
        format: "rgba8unorm",
        usage: USAGE.TEXTURE_BINDING | USAGE.COPY_DST | USAGE.RENDER_ATTACHMENT,
      },
    ]);
    expect(gpu.writes).toEqual([]);
    expect(gpu.copies).toEqual([]);
  });

  it("checkRenderable 不把没有 mip 的视频纹理当缺；普通纹理没有 mip 照报", () => {
    expect(checkRenderable(bundle(), new Set())).toEqual([]);
    const broken = bundle();
    broken.textures[1] = { ...broken.textures[1], mips: [] };
    expect(checkRenderable(broken, new Set())).toEqual(["render:texture-missing:1"]);
  });
});

describe("GpuScene：画到视频纹理时拷帧（P9a 步骤 2）", () => {
  it("建场景：视频纹理建成空纹理（经 uploadTexture 的视频分支），不写数据", async () => {
    const { gpu } = await open();
    expect(gpu.texture("materials/v0.tex").descriptor).toMatchObject({
      size: { width: 1280, height: 720 },
      format: "rgba8unorm",
    });
    // 只有普通图像写了数据
    expect(gpu.writes).toEqual(["materials/i.tex"]);
  });

  it("问 drawn 的顺序就是绘制顺序：同一张视频被两个图层画到问两次；不可见图层、没绑定的槽不问；交来元素才拷", async () => {
    const { gpu, state, scene } = await open();
    const { sink: videos, drawn, frames } = sink();
    scene.setVideoSink(videos);
    gpu.encode(scene, state);
    expect(drawn).toEqual([0, 0]);
    expect(gpu.copies).toEqual([]);

    // 有新帧：第一次问交出元素（交出即清标志由 SceneVideos 负责，这里替身只交一次）
    const frame = element();
    frames.set(0, frame);
    drawn.length = 0;
    gpu.encode(scene, state);
    expect(drawn).toEqual([0, 0]);
    expect(gpu.copies).toEqual([
      { source: frame, texture: "materials/v0.tex", size: { width: 1280, height: 720 } },
      { source: frame, texture: "materials/v0.tex", size: { width: 1280, height: 720 } },
    ]);
  });

  it("图层隐藏后不问（播放器据此 30 帧后暂停），重新显示后接着问", async () => {
    const source = bundle([layer(0, { 0: 0 }, { visibleBound: true })]);
    const { gpu, state, scene } = await open(source);
    const { sink: videos, drawn } = sink();
    scene.setVideoSink(videos);
    gpu.encode(scene, state);
    expect(drawn).toEqual([0]);
    state.layers.get(0)!.visible = false;
    gpu.encode(scene, state);
    expect(drawn).toEqual([0]);
    state.layers.get(0)!.visible = true;
    gpu.encode(scene, state);
    expect(drawn).toEqual([0, 0]);
  });

  it("没有 sink：照常编码，不拷", async () => {
    const { gpu, state, scene } = await open();
    gpu.encode(scene, state);
    scene.setVideoSink(null);
    gpu.encode(scene, state);
    expect(gpu.copies).toEqual([]);
  });

  it("视频与纹理尺寸不同：只拷重叠部分，warning 每张纹理只记一次（决定 3）", async () => {
    const { gpu, state, scene, warnings } = await open(bundle([layer(0, { 0: 0 })]));
    const { sink: videos, frames } = sink(new Map([[0, element(1920, 540)]]));
    scene.setVideoSink(videos);
    gpu.encode(scene, state);
    gpu.encode(scene, state);
    expect(gpu.copies.map((copy) => copy.size)).toEqual([
      { width: 1280, height: 540 },
      { width: 1280, height: 540 },
    ]);
    expect(warnings).toEqual(["场景视频 materials/v0.tex 的尺寸 1920×540 和纹理 1280×720 不同，只拷重叠部分"]);
    // 还没有尺寸（元数据之前）：跳过，不记
    frames.set(0, element(0, 0));
    gpu.encode(scene, state);
    expect(gpu.copies).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it("拷贝抛错：这一帧照常编完，warning 每张纹理只记一次", async () => {
    const { gpu, state, scene, warnings } = await open(bundle([layer(0, { 0: 0 })]));
    scene.setVideoSink(sink(new Map([[0, element()]])).sink);
    gpu.copyError = new DOMException("The video element has no frame", "InvalidStateError");
    expect(() => gpu.encode(scene, state)).not.toThrow();
    expect(() => gpu.encode(scene, state)).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("场景视频 materials/v0.tex 拷进纹理失败");
    gpu.copyError = null;
    gpu.encode(scene, state);
    expect(gpu.copies).toHaveLength(1);
  });
});

describe("SceneRenderer：视频的帧号与 sink（P9a 步骤 2）", () => {
  async function start(videos: VideoSink, userTextures?: UserTextureProvider) {
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
    const canvas = {
      width: 100,
      height: 100,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement;
    const renderer = await SceneRenderer.create(canvas, { maxFps: 0, videos });
    await renderer.load(bundle([layer(0, { 0: 0 })]), userTextures ? { userTextures } : {});
    return { renderer, frames };
  }

  it("换上场景就接上 sink：加载的第一帧（实时帧）先 beginFrame、再问 drawn", async () => {
    const order: string[] = [];
    const videos: VideoSink = {
      beginFrame: () => order.push("begin"),
      drawn: (texture) => {
        order.push(`drawn ${texture}`);
        return null;
      },
    };
    const { renderer } = await start(videos);
    expect(order).toEqual(["begin", "drawn 0"]);
    renderer.destroy();
  });

  it("实时帧开头 beginFrame、在粒子步进之前；暂停后的补画帧只问 drawn、不推进帧号", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const videos = { beginFrame: vi.fn(), drawn: vi.fn((_texture: number) => null) };
    const { renderer, frames } = await start(videos);
    const scene = renderer.currentScene!;
    const step = vi.spyOn(scene, "stepParticles");
    videos.beginFrame.mockClear();
    videos.drawn.mockClear();

    now += 20;
    frames.at(-1)!(now);
    expect(videos.beginFrame).toHaveBeenCalledOnce();
    expect(videos.drawn).toHaveBeenCalledExactlyOnceWith(0);
    expect(videos.beginFrame.mock.invocationCallOrder[0]).toBeLessThan(step.mock.invocationCallOrder[0]);

    renderer.setPaused(true);
    renderer.redraw();
    expect(videos.beginFrame).toHaveBeenCalledOnce();
    expect(videos.drawn).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it("用户纹理来源（P11b 步骤 4）：实时帧在视频帧号之后调 beginFrame(本帧 frametime)，补画帧不调", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const order: string[] = [];
    const videos = { beginFrame: () => order.push("videos"), drawn: () => null };
    const frametimes: number[] = [];
    const userTextures: UserTextureProvider = {
      crop: () => null,
      beginFrame: (frametime) => {
        order.push("user");
        frametimes.push(frametime);
      },
    };
    const { renderer, frames } = await start(videos, userTextures);
    // 加载的第一帧也是实时帧
    expect(order).toEqual(["videos", "user"]);
    order.length = 0;
    frametimes.length = 0;
    now += 20;
    frames.at(-1)!(now);
    expect(order).toEqual(["videos", "user"]);
    expect(frametimes).toHaveLength(1);
    expect(frametimes[0]).toBe(renderer.frameSeconds);
    expect(frametimes[0]).toBeGreaterThan(0);
    renderer.setPaused(true);
    renderer.redraw();
    expect(order).toEqual(["videos", "user"]);
    renderer.destroy();
  });
});
