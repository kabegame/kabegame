/**
 * dev 探针 `renderFrame` 按指定尺寸画的接线（phase-render-size 点 3）：探针要 GPU，这里把编译、取设备、`GpuScene` 换成记录调用的替身，核对：
 * - 正交场景给了 `canvas`（缺省）时交给 `GpuScene.build` 的 `target`：尺寸 = canvas、边距 = `alignEdges(对齐方式, 场景, canvas)`、对齐方式 1 / 3 的
 *   清屏色取属性全集的 `schemecolor`（0 / 2 不读属性、为 null）；读回场景目标本身（替身设备没有上屏要的纹理，走了上屏会失败）；
 * - 光标：`g_PointerPosition` 与控制点跟随点的 cursor 都是窗口坐标原样（反投影交给带裁切的 VP）；`renderMode: "scene"` 仍按 fill 换算；
 * - `renderMode: "scene"` 与不给 `canvas` 时不交 `target`，读回路径同以前；透视场景不交 `target`；
 * - 参数校验：tile、未知样式 / 画法、`target` 没有 `canvas`、非 fill 的样式用在别的画法上，编译之前或之后抛错；结果的 `render` 说明这次的画法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { acquireGpu } from "../render/device";
import { alignEdges } from "../render/layout";
import { GpuScene } from "../render/scene";
import { renderFrame } from "./probe";
import { readProbeUserProperties } from "./probeScripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));
vi.mock("../compile/client", () => ({ compileSceneInWorker: vi.fn() }));
vi.mock("../render/device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../render/scene", async (original) => ({
  ...(await original<typeof import("../render/scene")>()),
  GpuScene: { build: vi.fn() },
}));
vi.mock("./probeScripts", async (original) => ({
  ...(await original<typeof import("./probeScripts")>()),
  readProbeUserProperties: vi.fn(),
}));

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

function compile(): Promise<SceneBundle> {
  const objects: SceneObject[] = [
    { id: 1, name: "a", image: "models/a.json", origin: "100 100 0", size: "40 60" } as SceneObject,
  ];
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

/** 一串调用与每次 `stepParticles` 收到的 cursor。 */
let log: string[] = [];
let cursors: [number, number][] = [];
let updatePointers: [number, number][] = [];

/** 替身场景：宽高取 `target` 的尺寸（真场景的场景目标就是它），没有时是 4×2。 */
function fakeScene(size: readonly [number, number] | undefined) {
  return {
    width: size?.[0] ?? 4,
    height: size?.[1] ?? 2,
    targetBytes: 0,
    bloomChain: null,
    targetTexture: { format: "rgba8unorm" },
    targetView: {},
    setVideoSink: () => {},
    sync: () => {},
    stepParticles: (_dt: number, _time: number, _state: unknown, cursor: [number, number]) => void cursors.push(cursor),
    setCamera: () => {},
    setParallax: () => {},
    update: (frame: { pointer: [number, number] }) => void updatePointers.push(frame.pointer),
    encode: () => {},
    profileParticles: () => {},
    particleProfile: () => [],
    particleStats: () => [],
    destroy: () => {},
  };
}

function fakeDevice() {
  return {
    limits: { maxTextureDimension2D: 8192 },
    createCommandEncoder: () => ({ copyTextureToBuffer: () => {}, finish: () => ({}) }),
    createBuffer: ({ size }: { size: number }) => ({
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(size),
      unmap: () => {},
      destroy: () => {},
    }),
    queue: { submit: () => {}, writeBuffer: () => {}, onSubmittedWorkDone: async () => {} },
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    destroy: () => {},
  };
}

let bundle: SceneBundle;
/** 每次 `GpuScene.build` 收到的选项。 */
const buildOptions = () => vi.mocked(GpuScene.build).mock.calls.map((call) => call[5] as Record<string, unknown>);

beforeEach(async () => {
  log = [];
  cursors = [];
  updatePointers = [];
  bundle = await compile();
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { putImageData: () => {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([1, 2, 3])]);
      }
    },
  );
  vi.stubGlobal("ImageData", class {});
  vi.mocked(compileSceneInWorker).mockImplementation(async () => {
    log.push("compile");
    return bundle;
  });
  vi.mocked(acquireGpu).mockImplementation(
    async () => ({ device: fakeDevice(), features: [] }) as unknown as Awaited<ReturnType<typeof acquireGpu>>,
  );
  vi.mocked(GpuScene.build).mockImplementation(async (...args: unknown[]) => {
    const options = args[5] as { target?: { size: [number, number] } } | undefined;
    return fakeScene(options?.target?.size) as unknown as GpuScene;
  });
  vi.mocked(readProbeUserProperties).mockImplementation(async () => {
    log.push("properties");
    return new Map([["schemecolor", { value: "0.1 0.2 0.3" } as never]]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const BASE = { projectDir: "P:/p", sceneAssets: ["A:/assets"], key: "k" };

describe("renderFrame 按指定尺寸画的接线", () => {
  it("给了 canvas 缺省按这个尺寸画：target = 尺寸 + 边距（fill），读回场景目标本身，不读属性", async () => {
    const result = await renderFrame({ ...BASE, canvas: [1920, 800] });
    const [options] = buildOptions();
    expect(options.target).toEqual({
      size: [1920, 800],
      edges: alignEdges(0, 1920, 1080, 1920, 800),
      clear: null,
    });
    expect(log).not.toContain("properties");
    expect(result.render).toEqual({
      mode: "target",
      style: "fill",
      alignment: 0,
      edges: [0, 140, 0, 140],
      clear: null,
    });
    // 读回的是场景目标（替身场景的宽高 = target 尺寸），不经上屏
    expect([result.width, result.height]).toEqual([1920, 800]);
    expect(result.canvas).toEqual([1920, 800]);
    expect(result.sceneTarget).toEqual([1920, 800]);
  });

  it("样式 fit / center 清屏用属性全集里的 schemecolor；stretch 与 fill 不读属性", async () => {
    const fit = await renderFrame({ ...BASE, canvas: [1920, 800], style: "fit" });
    expect(buildOptions()[0].target).toEqual({
      size: [1920, 800],
      edges: alignEdges(1, 1920, 1080, 1920, 800),
      clear: [0.1, 0.2, 0.3],
    });
    expect(fit.render).toMatchObject({ mode: "target", style: "fit", alignment: 1, clear: [0.1, 0.2, 0.3] });
    expect(vi.mocked(readProbeUserProperties)).toHaveBeenCalledTimes(1);

    const center = await renderFrame({ ...BASE, canvas: [1280, 720], style: "center" });
    expect(center.render).toMatchObject({ alignment: 3, edges: [320, 180, 320, 180], clear: [0.1, 0.2, 0.3] });

    vi.mocked(readProbeUserProperties).mockClear();
    const stretch = await renderFrame({ ...BASE, canvas: [1280, 720], style: "stretch" });
    expect(stretch.render).toMatchObject({ alignment: 2, edges: [0, 0, 0, 0], clear: null });
    await renderFrame({ ...BASE, canvas: [1280, 720], style: "fill" });
    expect(vi.mocked(readProbeUserProperties)).not.toHaveBeenCalled();
  });

  it("光标按窗口坐标：g_PointerPosition 与跟随点的 cursor 原样（场景 1920×1080、窗口 1920×800）", async () => {
    const particles = { dts: [0.1, 0.1] };
    await renderFrame({
      ...BASE,
      canvas: [1920, 800],
      particles,
      pointers: [
        [0.25, 0.75],
        [0.5, 0.25],
      ],
    });
    // 回放第 i 帧用第 i 项，读回帧是最后一项；窗口就是场景目标，不再经 sceneCursor
    expect(cursors.at(-1)).toEqual([0.5, 0.25]);
    expect(updatePointers.at(-1)).toEqual([0.5, 0.25]);
    expect(cursors[0]).toEqual([0.25, 0.75]);
  });

  it("renderMode: scene：不交 target，光标照旧按 fill 换到场景上（旧画法，字节同以前），读回走上屏（替身设备做不了，失败）", async () => {
    const particles = { dts: [0.1] };
    await expect(
      renderFrame({ ...BASE, canvas: [1920, 800], renderMode: "scene", particles, pointers: [[0.5, 0.25]] }),
    ).rejects.toThrow();
    expect(buildOptions()[0].target).toBeUndefined();
    // fill：1920×800 窗口的 y = 0.25 对应场景 y = (0.25·800 + 140) / 1080，不等于窗口坐标
    expect(cursors[0][0]).toBeCloseTo(0.5, 6);
    expect(cursors[0][1]).toBeCloseTo((0.25 * 800 + 140) / 1080, 6);
    // g_PointerPosition 在 fill 下本来就是窗口坐标原样
    expect(updatePointers).toEqual([[0.5, 0.25]]);
  });

  it("不给 canvas：不交 target，读回场景目标，render 是 scene，样式缺省不报错", async () => {
    const result = await renderFrame({ ...BASE, time: 1 });
    expect(buildOptions()[0].target).toBeUndefined();
    expect(result.render).toEqual({ mode: "scene", style: null, alignment: null, edges: null, clear: null });
    expect(result.canvas).toBeNull();
    // 明说 fill 也不报（缺省值）
    await renderFrame({ ...BASE, time: 1, style: "fill" });
  });

  it("透视场景本来就按画布画：不交 target，render 是 perspective；非 fill 的样式报错", async () => {
    bundle = { ...bundle, general: { ...bundle.general, perspective: true } } as SceneBundle;
    // 透视场景的场景目标本来就是 canvas，读回仍走上屏的恒等铺放（替身设备做不了，失败）；要看的是交给 build 的参数
    await expect(renderFrame({ ...BASE, canvas: [1920, 800] })).rejects.toThrow();
    expect(buildOptions()[0].target).toBeUndefined();
    expect(buildOptions()[0].size).toEqual([1920, 800]);
    await expect(renderFrame({ ...BASE, canvas: [1920, 800], style: "fit" })).rejects.toThrow(
      /只在按指定尺寸画时有效.*perspective/,
    );
  });
});

describe("renderFrame 的 style / renderMode 校验", () => {
  it("tile、未知样式、未知画法在编译之前就抛错", async () => {
    await expect(renderFrame({ ...BASE, canvas: [1920, 800], style: "tile" as never })).rejects.toThrow(/不收 tile/);
    await expect(renderFrame({ ...BASE, canvas: [1920, 800], style: "cover" as never })).rejects.toThrow(
      /style 要是 fill/,
    );
    await expect(renderFrame({ ...BASE, canvas: [1920, 800], renderMode: "both" as never })).rejects.toThrow(
      /renderMode 要是 target/,
    );
    expect(log).not.toContain("compile");
  });

  it("renderMode: target 要有 canvas（编译之前）", async () => {
    await expect(renderFrame({ ...BASE, renderMode: "target" })).rejects.toThrow(/要同时给 canvas/);
    expect(log).not.toContain("compile");
  });

  it("非 fill 的样式用在 scene 画法或不给 canvas 时报错，不静默忽略", async () => {
    await expect(renderFrame({ ...BASE, canvas: [1920, 800], renderMode: "scene", style: "center" })).rejects.toThrow(
      /只在按指定尺寸画时有效.*scene/,
    );
    await expect(renderFrame({ ...BASE, style: "fit" })).rejects.toThrow(/只在按指定尺寸画时有效/);
  });
});
