/**
 * 方案 A 点 2（`.claude/plans/wpe-import/3-scene/phase-render-size-product.md`）：渲染器按画布像素画。
 * - 建场景的 `target`（尺寸、边距、清屏色）与 dev 探针同输入（`planSizedTarget`）算出的一致；`tile` 不传 `target`；透视场景取画布像素（含显示缩放）；
 * - 画布尺寸变了：去抖 `RENDER_SIZE_SETTLE_MS` 后调一次 `GpuScene.resize`，期间上屏拉伸铺满；多次变化只换最后一次；换场景作废待办；
 * - 只有样式 / 留白色变（尺寸不变）：立即 `resize`、不建 RT；
 * - `resize` 抛错经 `onResizeFailed` 交宿主，之后不再换；透视场景画布变了不再整场重载；
 * - 光标：fit / center 下同一个画布指针在产品与探针（给 canvas）里反投影出同一个场景点。
 * 假设备与场景的搭法照 `p5d-camera.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues } from "../compile/bindings";
import type { SceneBundle, SceneGeneral, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import type { SceneCameraJson } from "../compile/camera";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { planSizedTarget, type ProbeStyle } from "../dev/renderTarget";
import { pointerScenePoint } from "../particles/controlpoints";
import type { TranslateResult } from "../wpesl2wgsl";
import { acquireGpu } from "./device";
import { alignEdges } from "./layout";
import { RENDER_SIZE_SETTLE_MS, SceneRenderer } from "./renderer";
import { GpuScene } from "./scene";
import { SceneState } from "./state";

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


// ———— 渲染器 ————

interface Harness {
  renderer: SceneRenderer;
  gpu: FakeGpu;
  rect: { width: number; height: number };
  win: { devicePixelRatio: number };
  frames: FrameRequestCallback[];
  canvas: HTMLCanvasElement;
}

async function start(
  options: {
    rect?: { width: number; height: number };
    dpr?: number;
    displayScale?: number;
    onResizeFailed?: (reasons: string[]) => void;
  } = {},
): Promise<Harness> {
  const frames: FrameRequestCallback[] = [];
  const gpu = new FakeGpu();
  vi.mocked(acquireGpu).mockResolvedValue({
    device: gpu.device,
    features: new Set(),
    info: { vendor: "", architecture: "", description: "", features: [] },
  } as unknown as Awaited<ReturnType<typeof acquireGpu>>);
  vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const win = { devicePixelRatio: options.dpr ?? 1 };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => ({ createView: () => ({ label: "canvas" }) }),
  };
  const rect = options.rect ?? { width: 1200, height: 600 };
  const canvas = {
    width: 100,
    height: 100,
    getContext: () => context,
    getBoundingClientRect: () => ({ ...rect }),
  } as unknown as HTMLCanvasElement;
  const renderer = await SceneRenderer.create(canvas, {
    maxFps: 0,
    displayScale: options.displayScale,
    onResizeFailed: options.onResizeFailed,
  });
  return { renderer, gpu, rect, win, frames, canvas };
}

const internals = (renderer: SceneRenderer) =>
  renderer as unknown as {
    resize(): void;
    placement: { rect: number[] };
    placementKey: string;
    blitBindGroups: Map<unknown, unknown>;
    applied: { size: number[]; edges: number[] | null; clear: number[] | null } | null;
    settleTimer: unknown;
  };

const ortho = () => bundleOf([layer(0)], false);
const persp = () => bundleOf([layer(0)], true);

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 只拦假时钟的 setTimeout：别的（微任务、promise）照常。 */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

/** 让已兑现 promise 的 then 回调跑完。 */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("渲染器：建场景的 target（与探针同输入）", () => {
  const SCENE = [1920, 1080] as const;
  const SCHEME: [number, number, number] = [0.2, 0.4, 0.6];

  it.each(["fill", "fit", "stretch", "center"] as ProbeStyle[])(
    "%s：尺寸、边距、清屏色同 planSizedTarget(场景, 画布, 样式, schemecolor)",
    async (style) => {
      const { renderer } = await start({ rect: { width: 1200, height: 600 } });
      renderer.setBackground(SCHEME);
      renderer.setStyle(style);
      const build = vi.spyOn(GpuScene, "build");
      await renderer.load(ortho());
      const options = build.mock.calls[0][5]!;
      const expected = planSizedTarget(SCENE, [1200, 600], style, SCHEME).target;
      expect(options.target).toEqual(expected);
      expect(options.size).toBeUndefined();
      expect(renderer.sceneStats).toMatchObject({ width: 1200, height: 600 });
      // 按画布画：上屏 1:1（铺满整块画布）
      expect(internals(renderer).placement.rect).toEqual([0, 0, 1200, 600]);
      renderer.destroy();
    },
  );

  it("fill / stretch 的清屏色为 null（用 clearcolor），fit / center 取 schemecolor", async () => {
    const targets: Record<string, unknown> = {};
    for (const style of ["fill", "stretch", "fit", "center"] as const) {
      const { renderer } = await start();
      renderer.setBackground(SCHEME);
      renderer.setStyle(style);
      const build = vi.spyOn(GpuScene, "build");
      await renderer.load(ortho());
      targets[style] = build.mock.calls[0][5]!.target!.clear;
      build.mockRestore();
      renderer.destroy();
    }
    expect(targets).toEqual({ fill: null, stretch: null, fit: SCHEME, center: SCHEME });
  });

  it("center 的边距按画布 CSS 尺寸（画布像素 / pixelRatio）算：dpr 2 下一个场景单位对一个布局 CSS 像素", async () => {
    const { renderer } = await start({ rect: { width: 600, height: 300 }, dpr: 2 });
    renderer.setStyle("center");
    renderer.setBackground(SCHEME);
    const build = vi.spyOn(GpuScene, "build");
    await renderer.load(ortho());
    const target = build.mock.calls[0][5]!.target!;
    expect(target.size).toEqual([1200, 600]);
    expect(target.edges).toEqual(alignEdges(3, 1920, 1080, 600, 300));
    renderer.destroy();
  });

  it("tile：不传 target、不传 size，仍按场景分辨率画再平铺上屏", async () => {
    const { renderer } = await start();
    renderer.setStyle("tile");
    const build = vi.spyOn(GpuScene, "build");
    await renderer.load(ortho());
    const options = build.mock.calls[0][5]!;
    expect(options.target).toBeUndefined();
    expect(options.size).toBeUndefined();
    expect(renderer.sceneStats).toMatchObject({ width: 1920, height: 1080 });
    renderer.destroy();
  });

  it("透视场景：场景目标取画布像素（含显示缩放），不传 target；screenResolution 仍是显示缩放为 1 的画布尺寸", async () => {
    const { renderer } = await start({ rect: { width: 160, height: 90 }, displayScale: 2 });
    const build = vi.spyOn(GpuScene, "build");
    await renderer.load(persp());
    const options = build.mock.calls[0][5]!;
    expect(options.size).toEqual([320, 180]);
    expect(options.target).toBeUndefined();
    expect(renderer.sceneStats).toMatchObject({ width: 320, height: 180 });
    expect(renderer.screenResolution).toEqual([160, 90]);
    renderer.destroy();
  });
});

describe("渲染器：原地换尺寸的状态机", () => {
  /** 换掉 `resize` 的实现：记参数、返回给定的 promise（默认立即兑现），不真的重建。 */
  function stubResize(renderer: SceneRenderer, result: () => Promise<void> = () => Promise.resolve()) {
    return vi.spyOn(renderer.currentScene!, "resize").mockImplementation(() => result());
  }

  it(`画布变尺寸：${RENDER_SIZE_SETTLE_MS} ms 后调一次 resize，期间上屏拉伸铺满旧目标`, async () => {
    const { renderer, rect } = await start();
    await renderer.load(ortho());
    fakeTimers();
    const resize = stubResize(renderer);
    rect.width = 1400;
    internals(renderer).resize();
    // 画布已变、场景目标还是旧的：暂停补画一帧，上屏铺满整块画布（拉伸），不是旧尺寸的矩形
    renderer.setPaused(true);
    renderer.redraw();
    expect(renderer.sceneStats).toMatchObject({ width: 1200, height: 600 });
    expect(internals(renderer).placement.rect).toEqual([0, 0, 1400, 600]);
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS - 1);
    expect(resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resize).toHaveBeenCalledTimes(1);
    const next = planSizedTarget([1920, 1080], [1400, 600], "fill").target;
    expect(resize.mock.calls[0][0]).toEqual(next);
    // 兑现后换上：已换上的目标记新值
    await flush();
    expect(internals(renderer).applied).toEqual(next);
    expect(internals(renderer).settleTimer).toBeNull();
    renderer.destroy();
  });

  it("去抖期间再变重新计时；多次变化只换最后一次；回到已请求的尺寸取消", async () => {
    const { renderer, rect } = await start();
    await renderer.load(ortho());
    fakeTimers();
    const resize = stubResize(renderer);
    const apply = () => internals(renderer).resize();
    rect.width = 1300;
    apply();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS - 1);
    rect.width = 1400;
    apply();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS - 1);
    // 同一个尺寸再量一次不重新计时
    apply();
    expect(resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls[0][0].size).toEqual([1400, 600]);
    // 回到已请求（= 当前）的尺寸：取消
    rect.width = 1500;
    apply();
    rect.width = 1400;
    apply();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(resize).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("只换样式 / 留白色（尺寸不变）：立即 resize、不建 RT；fill 下留白色不进 target 所以不换", async () => {
    const { renderer, gpu } = await start();
    await renderer.load(ortho());
    const scene = renderer.currentScene!;
    const resize = vi.spyOn(scene, "resize");
    const textures = gpu.textures.length;
    const buffers = gpu.buffers.length;
    renderer.setBackground([0.1, 0.2, 0.3]); // fill 的清屏色为 null：期望没变，不调
    expect(resize).not.toHaveBeenCalled();
    // fill → fit：边距与清屏色（schemecolor）变，尺寸 1200×600 不变
    renderer.setStyle("fit");
    expect(resize).toHaveBeenCalledTimes(1);
    const fit = planSizedTarget([1920, 1080], [1200, 600], "fit", [0.1, 0.2, 0.3]).target;
    expect(resize.mock.calls[0][0]).toEqual(fit);
    await resize.mock.results[0].value;
    await flush();
    expect(internals(renderer).applied).toEqual(fit);
    // fit 下改留白色：只换清屏色
    renderer.setBackground([0.5, 0.5, 0.5]);
    expect(resize).toHaveBeenCalledTimes(2);
    await resize.mock.results[1].value;
    expect(resize.mock.calls[1][0].clear).toEqual([0.5, 0.5, 0.5]);
    // 没建任何纹理（RT）与缓冲
    expect(gpu.textures.length).toBe(textures);
    expect(gpu.buffers.length).toBe(buffers);
    expect(renderer.sceneStats).toMatchObject({ width: 1200, height: 600 });
    renderer.destroy();
  });

  it("按画布画与 tile 之间切换：立即 resize（不等去抖）", async () => {
    const { renderer } = await start();
    await renderer.load(ortho());
    fakeTimers();
    const resize = stubResize(renderer);
    renderer.setStyle("tile");
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls[0][0]).toEqual({ size: [1920, 1080], edges: null, clear: null });
    renderer.destroy();
  });

  it("DPR 变了、画布像素不变：立即 resize，center 的边距按新的 CSS 尺寸重算", async () => {
    const { renderer, rect, win } = await start({ rect: { width: 1200, height: 600 } });
    renderer.setStyle("center");
    await renderer.load(ortho());
    const resize = stubResize(renderer);
    // 画布 1200×600 不变，但 DPR 1 → 2、布局尺寸减半：像素比变了，center 的边距按 CSS 尺寸 600×300 重算
    win.devicePixelRatio = 2;
    rect.width = 600;
    rect.height = 300;
    internals(renderer).resize();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls[0][0].size).toEqual([1200, 600]);
    expect(resize.mock.calls[0][0].edges).toEqual(alignEdges(3, 1920, 1080, 600, 300));
    renderer.destroy();
  });

  it("换场景（load）作废待办：旧场景的去抖计时器不会去换新场景", async () => {
    const { renderer, rect } = await start();
    await renderer.load(ortho());
    fakeTimers();
    rect.width = 1400;
    internals(renderer).resize();
    expect(internals(renderer).settleTimer).not.toBeNull();
    // 重新加载：按当前画布（1400×600）建，旧待办作废
    await renderer.load(ortho());
    expect(internals(renderer).settleTimer).toBeNull();
    expect(renderer.sceneStats).toMatchObject({ width: 1400, height: 600 });
    const resize = stubResize(renderer);
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(resize).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("透视场景画布变了：原地 resize（size 取画布、无边距），不再整场重载；样式与留白色不触发", async () => {
    const onResizeFailed = vi.fn();
    const { renderer, rect } = await start({ rect: { width: 160, height: 90 }, onResizeFailed });
    await renderer.load(persp());
    fakeTimers();
    const resize = stubResize(renderer);
    rect.width = 240;
    internals(renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls[0][0]).toEqual({ size: [240, 90], edges: null, clear: null });
    await flush();
    expect(onResizeFailed).not.toHaveBeenCalled();
    renderer.setStyle("fit");
    renderer.setBackground([1, 0, 0]);
    expect(resize).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("resize 抛错：onResizeFailed 交出原因，之后不再换尺寸（等宿主整场重载）；重新加载后恢复", async () => {
    const onResizeFailed = vi.fn();
    const { renderer, rect } = await start({ onResizeFailed });
    await renderer.load(ortho());
    fakeTimers();
    const resize = stubResize(renderer, () => Promise.reject(new Error("rebuild failed")));
    rect.width = 1400;
    internals(renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS);
    await flush();
    expect(onResizeFailed).toHaveBeenCalledTimes(1);
    expect(onResizeFailed.mock.calls[0][0][0]).toContain("render:resize");
    rect.width = 1500;
    internals(renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS * 2);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(onResizeFailed).toHaveBeenCalledTimes(1);
    // 宿主整场重载：按当前画布建，重新可以换
    await renderer.load(ortho());
    expect(renderer.sceneStats).toMatchObject({ width: 1500, height: 600 });
    const again = stubResize(renderer);
    rect.width = 1600;
    internals(renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS);
    expect(again).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });
});

describe("渲染器：光标与相机（按画布画 = 探针给了 canvas）", () => {
  it.each(["fit", "center"] as ProbeStyle[])(
    "%s：同一个画布指针在产品与探针里反投影出同一个场景点（光标原样、裁过的 P·V、windowCursor 同）",
    async (style) => {
      const { renderer, gpu } = await start({ rect: { width: 1200, height: 600 } });
      renderer.setBackground([0.2, 0.4, 0.6]);
      renderer.setStyle(style);
      await renderer.load(ortho());
      const scene = renderer.currentScene!;
      // 探针：同一设备上按 planSizedTarget 的 target 建同一张场景，窗口 = 画布
      const probeBundle = ortho();
      const plan = planSizedTarget([1920, 1080], [1200, 600], style, [0.2, 0.4, 0.6]);
      const probe = await GpuScene.build(gpu.device, probeBundle, SceneState.fromBundle(probeBundle), new Set(), [], {
        target: plan.target,
      });
      const productCamera = scene.cursorCamera([1200, 600]);
      const probeCamera = probe.cursorCamera([1200, 600]);
      expect(Array.from(productCamera.viewProjection)).toEqual(Array.from(probeCamera.viewProjection));
      expect(productCamera.windowCursor).toBe(probeCamera.windowCursor);
      expect(productCamera.anchorEdges).toEqual(probeCamera.anchorEdges);
      expect(productCamera.anchorEdges).toEqual(plan.target.edges);
      // 渲染器交给粒子 / 命中的光标就是窗口指针原样（探针的 `windowPointer` 同尺寸分支同样原样）
      const stepParticles = vi.spyOn(scene, "stepParticles");
      for (const pointer of [
        [0.5, 0.5],
        [0.1, 0.9],
        [0.97, 0.03],
      ] as [number, number][]) {
        renderer.setPointer(...pointer);
        renderer.setPaused(true);
        renderer.redraw();
        const cursor = stepParticles.mock.lastCall![3] as [number, number];
        expect(cursor).toEqual(pointer);
        const fromProduct = pointerScenePoint(productCamera.viewProjection, cursor);
        const fromProbe = pointerScenePoint(probeCamera.viewProjection, pointer);
        expect(fromProduct).toEqual(fromProbe);
      }
      // 窗口中心落在场景中心（fit / center 的边距左右、上下对称）
      const [x, y] = pointerScenePoint(productCamera.viewProjection, [0.5, 0.5]);
      expect(x).toBeCloseTo(960, 3);
      expect(y).toBeCloseTo(540, 3);
      probe.destroy();
      renderer.destroy();
    },
  );

  it("g_PointerPosition：按画布画时是窗口指针原样（样式不再换算到场景坐标）", async () => {
    const { renderer } = await start({ rect: { width: 1200, height: 600 } });
    renderer.setStyle("fit");
    await renderer.load(ortho());
    const update = vi.spyOn(renderer.currentScene!, "update");
    renderer.setPointer(0.2, 0.7);
    renderer.setPaused(true);
    renderer.redraw();
    expect(update.mock.lastCall![0].pointer).toEqual([0.2, 0.7]);
    renderer.destroy();
  });

  it("正交带相机对象：换样式 / 换尺寸兑现之后，下一帧相机对象帧带新裁切（applyCrop 把它留给渲染器）", async () => {
    const { renderer, rect } = await start({ rect: { width: 1200, height: 600 } });
    renderer.setBackground([0, 0, 0]);
    const camera = layer(1, { name: "camera 1", origin: [200, 100, 0], size: [], passes: [], camera: { fov: 50, zoom: 1 } });
    await renderer.load(bundleOf([layer(0), camera], false));
    const scene = renderer.currentScene!;
    const setCamera = vi.spyOn(scene, "setCamera");
    const frameOf = () => (setCamera.mock.lastCall![0] as { cameraObject?: { viewProjection: Float32Array } }).cameraObject!;
    const draw = () => {
      renderer.setPaused(true);
      renderer.redraw();
    };
    draw();
    const fill = Array.from(frameOf().viewProjection);
    // 换样式（立即、同尺寸）：兑现之后下一帧的相机对象帧换成 fit 的边距
    const resize = vi.spyOn(scene, "resize");
    renderer.setStyle("fit");
    await resize.mock.results[0].value;
    await flush();
    draw();
    const fit = Array.from(frameOf().viewProjection);
    expect(fit).not.toEqual(fill);
    expect(internals(renderer).applied!.edges).toEqual(planSizedTarget([1920, 1080], [1200, 600], "fit", [0, 0, 0]).target.edges);
    // 换尺寸（去抖后）：宽高比变了，相机对象帧再变
    fakeTimers();
    rect.width = 1500;
    internals(renderer).resize();
    vi.advanceTimersByTime(RENDER_SIZE_SETTLE_MS);
    await resize.mock.results[1].value;
    await flush();
    draw();
    expect(Array.from(frameOf().viewProjection)).not.toEqual(fit);
    expect(internals(renderer).applied!.size).toEqual([1500, 600]);
    renderer.destroy();
  });
});
