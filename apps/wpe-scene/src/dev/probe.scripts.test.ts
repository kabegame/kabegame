/**
 * dev 探针 `renderFrame` 跑场景脚本的接线（kabegame-chromium 第 7 批）：探针要 GPU，这里把编译、取设备、`GpuScene` 换成记录调用的替身，
 * 脚本环境换成记进同一串调用的替身（它本身由 `probeScripts.test.ts` 核对），核对：
 * - 脚本环境在建好场景、视频就绪之后才 `load`（`init`），每一回放帧（含读回帧）设好相机之后跑一帧，读回之后才取结果、释放；
 *   有回放时探针每一帧都画（`replayReadback` 的 `encodeFrame`，P10a 走查），前 n − 1 帧也是渲染器的完整顺序、各自编码提交；
 * - profile 帧不跑脚本；每一帧的 `g_Daytime` 跟着脚本的时钟；`screenResolution` 是 `canvas ?? window ?? [1920, 1080]`；
 * - 不给 `scripts` 时调用序列与加这一项之前相同（没有多的 `sync`、`g_Daytime` 0.5、结果没有 `scripts`）；
 * - `scripts` 与 `scriptValues` 同给、`scripts` 形状不对时编译之前就抛错；出错时也释放脚本环境。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { acquireGpu } from "../render/device";
import { GpuScene } from "../render/scene";
import { renderFrame } from "./probe";
import { createProbeScripts, DEFAULT_PROBE_CLOCK, probeDaytime, readProbeUserProperties } from "./probeScripts";
import { prepareProbeTexts } from "./probeTexts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));
vi.mock("../compile/client", () => ({ compileSceneInWorker: vi.fn() }));
vi.mock("../render/device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../render/scene", async (original) => ({
  ...(await original<typeof import("../render/scene")>()),
  GpuScene: { build: vi.fn() },
}));
vi.mock("./probeScripts", async (original) => ({
  ...(await original<typeof import("./probeScripts")>()),
  createProbeScripts: vi.fn(),
  readProbeUserProperties: vi.fn(),
}));
// 文本层的准备照常走真的（场景没有文本层，`settle` 返回 0、不调 sync）；结清重排的用例换成替身，让 `settle` 返回给定的次数
vi.mock("./probeTexts", async (original) => {
  const actual = await original<typeof import("./probeTexts")>();
  return { ...actual, prepareProbeTexts: vi.fn(actual.prepareProbeTexts) };
});

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

/** objects：0 FR（颜色挂脚本）。 */
function compile(): Promise<SceneBundle> {
  const objects: SceneObject[] = [
    {
      id: 1,
      name: "FR",
      image: "models/a.json",
      origin: "1820 40 0",
      color: { script: "export function update(value) { return value; }", value: "0 0 1" },
    } as SceneObject,
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

/** 一串调用：场景、设备与脚本替身都记进来。 */
let log: string[] = [];
/** 每次 `update` 收到的帧输入。 */
let updates: { time: number; daytime: number }[] = [];
/** 每次 `update` 收到的帧输入对象本身（核对结清之后再写的是同一份）。 */
let updateFrames: unknown[] = [];
/** 让脚本替身的某一帧抛错（核对出错时也释放）。 */
let failAt: number | null = null;

function fakeScene() {
  return {
    width: 4,
    height: 2,
    targetBytes: 0,
    bloomChain: null,
    targetTexture: { format: "rgba8unorm" },
    targetView: {},
    setVideoSink: () => void log.push("videoSink"),
    sync: () => void log.push("sync"),
    stepParticles: (dt: number, time: number) => void log.push(`step ${dt} ${time}`),
    setCamera: () => void log.push("camera"),
    setParallax: () => void log.push("parallax"),
    update: (frame: { time: number; daytime: number }) => {
      log.push("update");
      updates.push({ time: frame.time, daytime: frame.daytime });
      updateFrames.push(frame);
    },
    encode: () => void log.push("encode"),
    profileParticles: () => {},
    particleProfile: () => [],
    particleStats: () => [],
    destroy: () => void log.push("destroy"),
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
    queue: { submit: () => void log.push("submit"), writeBuffer: () => {}, onSubmittedWorkDone: async () => {} },
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    destroy: () => {},
  };
}

let bundle: SceneBundle;

beforeEach(async () => {
  log = [];
  updates = [];
  updateFrames = [];
  failAt = null;
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
  vi.mocked(GpuScene.build).mockImplementation(async () => {
    log.push("build");
    return fakeScene() as unknown as GpuScene;
  });
  vi.mocked(readProbeUserProperties).mockImplementation(async () => {
    log.push("properties");
    return new Map();
  });
  vi.mocked(createProbeScripts).mockImplementation(() => {
    let frames = 0;
    return {
      load: async () => void log.push("load"),
      frame: (dt: number, time: number) => {
        log.push(`script ${dt} ${time}`);
        if (++frames === failAt) throw new Error("脚本替身出错");
      },
      result: () => {
        log.push("result");
        return { frames } as never;
      },
      dispose: () => void log.push("dispose"),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const BASE = { projectDir: "P:/p", sceneAssets: ["A:/assets"], key: "k" };
const PARTICLES = { dts: [0.25, 0.5, 0.25], times: [0.25, 0.75, 1] };

describe("renderFrame 跑场景脚本的接线（第 7 批）", () => {
  it("init 在建好场景、视频就绪之后；每一回放帧（含读回帧）设好相机之后跑一帧；读回之后取结果、释放", async () => {
    const result = await renderFrame({ ...BASE, particles: PARTICLES, scripts: { clock: 5000, seed: 3 } });
    // 每一帧都画：sync → 步进 → 相机 → 脚本 → 视差 → sync → update → 编码、提交（前 n − 1 帧由 `encodeFrame`，读回帧由探针自己）
    const frame = (dt: number, time: number) => [
      "sync",
      `step ${dt} ${time}`,
      "camera",
      `script ${dt} ${time}`,
      "parallax",
      "sync",
      "update",
      "encode",
      "submit",
    ];
    expect(log).toEqual([
      "compile",
      "build",
      "videoSink",
      "properties",
      "load",
      ...frame(0.25, 0.25),
      ...frame(0.5, 0.75),
      ...frame(0.25, 1),
      "result",
      "dispose",
      "destroy",
    ]);
    // 每一帧的 g_Daytime 都跟着脚本的时钟（起点 + 这一帧的 g_Time）
    expect(updates).toEqual(PARTICLES.times.map((time) => ({ time, daytime: probeDaytime(5000, time) })));
    expect(result.scripts).toEqual({ frames: 3 });
    // 交给脚本环境的：时钟与种子、screenResolution（没给 canvas / window 时 1920×1080）、用的就是建场景的那份状态
    const input = vi.mocked(createProbeScripts).mock.calls[0][0];
    expect(input.options).toEqual({ clock: 5000, clockDefault: false, seed: 3, seedDefault: false });
    expect(input.screen).toEqual([1920, 1080]);
    expect(input.bundle).toBe(bundle);
    expect(vi.mocked(GpuScene.build).mock.calls[0][2]).toBe(input.state);
  });

  it("screenResolution 是 canvas ?? window ?? [1920, 1080]；scripts: true 用缺省时钟", async () => {
    // 替身设备没有读回画布要的纹理与管线，读回时失败；脚本环境在那之前已经建好（失败时照样释放）。
    // 给了 canvas 缺省按指定尺寸画、直接读回场景目标（不失败），要走读回画布得给 renderMode: scene
    await expect(renderFrame({ ...BASE, scripts: true, canvas: [1280, 720], renderMode: "scene" })).rejects.toThrow();
    expect(log.slice(-2)).toEqual(["dispose", "destroy"]);
    await renderFrame({ ...BASE, scripts: true, window: [800, 600] });
    const inputs = vi.mocked(createProbeScripts).mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.screen)).toEqual([
      [1280, 720],
      [800, 600],
    ]);
    expect(inputs[0].options).toMatchObject({ clock: DEFAULT_PROBE_CLOCK, clockDefault: true });
  });

  it("不回放时只有读回那一帧跑脚本：帧时间 0、g_Time 取 time", async () => {
    await renderFrame({ ...BASE, time: 2, scripts: true });
    expect(log.filter((line) => line.startsWith("script"))).toEqual(["script 0 2"]);
    expect(updates).toEqual([{ time: 2, daytime: probeDaytime(DEFAULT_PROBE_CLOCK, 2) }]);
  });

  it("profile 帧不跑脚本", async () => {
    await renderFrame({ ...BASE, time: 1, profile: 2, scripts: true });
    const load = log.indexOf("load");
    const scripts = log.filter((line) => line.startsWith("script"));
    expect(scripts).toEqual(["script 0 1"]);
    // profile 的两帧（各一次 update）在 load 之后、读回帧之前，中间没有脚本
    const profile = log.slice(load + 1, log.indexOf("script 0 1"));
    expect(profile.filter((line) => line === "update")).toHaveLength(2);
    expect(profile.some((line) => line.startsWith("script"))).toBe(false);
  });

  it("不给 scripts：不建脚本环境，调用序列同以前（没有多的 sync），g_Daytime 0.5，结果没有 scripts", async () => {
    const result = await renderFrame({ ...BASE, particles: PARTICLES });
    // 每一帧都画（P10a 走查）的原样序列：没有脚本、没有动画时两次 sync 之间没有改动，只有每帧开头那次
    const frame = (dt: number, time: number) => [
      "sync",
      `step ${dt} ${time}`,
      "camera",
      "parallax",
      "update",
      "encode",
      "submit",
    ];
    expect(log).toEqual([
      "compile",
      "build",
      "videoSink",
      ...frame(0.25, 0.25),
      ...frame(0.5, 0.75),
      ...frame(0.25, 1),
      "destroy",
    ]);
    expect(updates).toEqual(PARTICLES.times.map((time) => ({ time, daytime: 0.5 })));
    expect("scripts" in result).toBe(false);
    expect(createProbeScripts).not.toHaveBeenCalled();
    expect(readProbeUserProperties).not.toHaveBeenCalled();
  });

  it("scripts 与 scriptValues 同给、scripts 形状不对：编译之前就抛错", async () => {
    await expect(
      renderFrame({ ...BASE, scripts: true, scriptValues: [{ object: "FR", field: "color", value: [1, 0, 1] }] }),
    ).rejects.toThrow("scripts 与 scriptValues 不能同时给");
    await expect(renderFrame({ ...BASE, scripts: true, scriptValues: [] })).rejects.toThrow("不能同时给");
    await expect(renderFrame({ ...BASE, scripts: { seed: -1 } })).rejects.toThrow("scripts.seed");
    await expect(renderFrame({ ...BASE, scripts: false as never })).rejects.toThrow("scripts 要是 true");
    expect(log).toEqual([]);
  });

  it("读回后结清文本重排：settle 返回大于 1 时用同一份帧输入再 update 一次；返回 0 或 1 时不再调；textSyncs 回它（0 时不给）", async () => {
    const run = async (syncs: number) => {
      log = [];
      updates = [];
      updateFrames = [];
      // 只换这一次渲染的文本层：settle 记进调用串、返回给定的次数
      vi.mocked(prepareProbeTexts).mockResolvedValueOnce({
        texts: undefined,
        relayout: undefined,
        settle: async () => {
          log.push("settle");
          return syncs;
        },
        dispose: () => {},
      });
      const result = await renderFrame({ ...BASE, particles: PARTICLES, scripts: true });
      // 读回帧（最后一个 parallax 起）
      return { result, tail: log.slice(log.lastIndexOf("parallax")) };
    };

    const twice = await run(2);
    expect(twice.tail).toEqual([
      "parallax",
      "sync",
      "update",
      "settle",
      "update",
      "encode",
      "submit",
      "result",
      "dispose",
      "destroy",
    ]);
    // 三帧各一次，读回帧结清之后用同一份帧输入再一次
    expect(updateFrames).toHaveLength(4);
    expect(updateFrames[3]).toBe(updateFrames[2]);
    expect(twice.result.textSyncs).toBe(2);

    for (const syncs of [0, 1]) {
      const once = await run(syncs);
      expect(once.tail, `settle 返回 ${syncs}`).toEqual([
        "parallax",
        "sync",
        "update",
        "settle",
        "encode",
        "submit",
        "result",
        "dispose",
        "destroy",
      ]);
      expect(updateFrames).toHaveLength(3);
      if (syncs) expect(once.result.textSyncs).toBe(1);
      else expect("textSyncs" in once.result).toBe(false);
    }
  });

  it("回放中途抛错（真的脚本出错由运行时接住，这里让替身直接抛）：renderFrame 失败，脚本环境照样释放、场景照样销毁", async () => {
    failAt = 2;
    await expect(renderFrame({ ...BASE, particles: PARTICLES, scripts: true })).rejects.toThrow("脚本替身出错");
    expect(log.slice(-2)).toEqual(["dispose", "destroy"]);
    // 第 1 帧已经画完；第 2 帧在脚本处出错，之后的帧与读回都没有
    expect(log.filter((line) => line === "encode")).toHaveLength(1);
    expect(log).not.toContain("result");
  });
});
