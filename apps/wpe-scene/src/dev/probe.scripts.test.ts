/**
 * dev 探针 `renderFrame` 跑场景脚本的接线（kabegame-chromium 第 7 批）：探针要 GPU，这里把编译、取设备、`GpuScene` 换成记录调用的替身，
 * 脚本环境换成记进同一串调用的替身（它本身由 `probeScripts.test.ts` 核对），核对：
 * - 脚本环境在建好场景、视频就绪之后才 `load`（`init`），每一回放帧（含读回帧）设好相机之后跑一帧，读回之后才取结果、释放；
 *   有回放时探针每一帧都画（`replayReadback` 的 `encodeFrame`，P10a 走查），前 n − 1 帧也是渲染器的完整顺序、各自编码提交；
 * - profile 帧不跑脚本；每一帧的 `g_Daytime` 跟着脚本的时钟；`screenResolution` 是 `canvas ?? window ?? [1920, 1080]`；
 * - 不给 `scripts` 时调用序列与加这一项之前相同（没有多的 `sync`、`g_Daytime` 0.5、结果没有 `scripts`）；
 * - `scripts` 与 `scriptValues` 同给、`scripts` 形状不对时编译之前就抛错；出错时也释放脚本环境；
 * - 运行中建层（L5）与单对象重编译（L6）：经同一份 `LiveObjects` 接进场景，重编译的片段替换状态与 GPU、带不支持项时卸掉旧的运行时。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import { openSceneSession, type CompileSessionClient } from "../compile/client";
import { normalizeConfig } from "../compile/config";
import {
  objectSlice,
  rekeyFragment,
  type FragmentDelta,
  type FragmentRequest,
  type ObjectFragment,
} from "../compile/fragment";
import { addShellObject } from "../script/structure";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { acquireGpu } from "../render/device";
import { GpuScene } from "../render/scene";
import { hostStats, renderFrame } from "./probe";
import type { SceneHost } from "../host";
import type { SceneState } from "../render/state";
import { createProbeScripts, DEFAULT_PROBE_CLOCK, probeDaytime, readProbeUserProperties } from "./probeScripts";
import { prepareProbeTexts } from "./probeTexts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));
// 探针经常驻编译会话拿 bundle（L5）：会话的片段请求由用例接管
vi.mock("../compile/client", () => ({ openSceneSession: vi.fn() }));
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

/** 会话替身（L5）收到的片段请求。 */
let fragmentRequests: FragmentRequest[] = [];
/** 单对象重编译（L6）的片段另加的字段（不支持项等）。 */
let recompileExtra: Partial<ObjectFragment> = {};
/**
 * 会话替身（L5）：片段请求按模板对象 0 现编（改键到请求的下标，配置按请求规整），增量为空（`from` 对齐当前表长）。单对象重编译（L6，带 `overrides`）
 * 给同一下标的整场片段，图层尺寸换成 96×48（看得出换上的是重编的）。
 */
function fakeSession() {
  const empty = () => ({
    programs: { from: bundle.programs.length, list: [] },
    textures: { from: bundle.textures.length, list: [] },
    userTextures: { from: bundle.userTextures?.length ?? 0, list: [] },
    bindings: [],
    assetPaths: [],
  });
  return {
    close() {},
    stats: null,
    broken: false,
    exactConfigs: [],
    compileFragment: vi.fn(async (request: FragmentRequest): Promise<FragmentDelta> => {
      fragmentRequests.push(request);
      if (request.overrides !== undefined) {
        const slice = objectSlice(bundle, request.object)!;
        return { fragment: { ...slice, layer: { ...slice.layer, size: [96, 48] }, ...recompileExtra }, ...empty() };
      }
      const parsed = JSON.parse(request.config) as { id?: number };
      const fragment = rekeyFragment(objectSlice(bundle, 0)!, {
        object: request.object,
        id: parsed.id ?? 0,
        parent: null,
      });
      return {
        fragment: { ...fragment, config: normalizeConfig(parsed) },
        programs: { from: bundle.programs.length, list: [] },
        textures: { from: bundle.textures.length, list: [] },
        userTextures: { from: bundle.userTextures?.length ?? 0, list: [] },
        bindings: [],
        assetPaths: [],
      };
    }),
  } as unknown as CompileSessionClient;
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
    setSheetOverrides: () => {},
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
    // 发射图候选表的快照读回（P4j 步骤 2b）：没有发射图
    afterSubmit: () => {},
    emitterImagesSettled: async () => {},
    // sprite 的遮挡计数（P13c 走查）：没有 sprite
    spriteSamples: async () => [],
    profileParticles: () => {},
    particleProfile: () => [],
    particleStats: () => [],
    // 材质状态字段（P6d1b）：没有待换的图层，探针不补 sync
    settlePassStates: async () => false,
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
  fragmentRequests = [];
  recompileExtra = {};
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
  vi.mocked(openSceneSession).mockImplementation(async () => {
    log.push("compile");
    return { bundle, session: fakeSession(), exactConfigs: [] };
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

  it("读回前结清材质状态字段（P6d1b）：有备好待换的图层时补一次 sync，再用同一份帧输入 update；没有时什么都不调", async () => {
    vi.mocked(GpuScene.build).mockImplementationOnce(async () => {
      log.push("build");
      return {
        ...fakeScene(),
        settlePassStates: async () => {
          log.push("settlePassStates");
          return true;
        },
      } as unknown as GpuScene;
    });
    await renderFrame({ ...BASE, particles: PARTICLES, scripts: true });
    const tail = log.slice(log.lastIndexOf("parallax"));
    expect(tail.slice(0, 7)).toEqual(["parallax", "sync", "update", "settlePassStates", "sync", "update", "encode"]);
    // 三帧各一次，读回帧换上新管线之后用同一份帧输入再一次
    expect(updateFrames).toHaveLength(4);
    expect(updateFrames[3]).toBe(updateFrames[2]);
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

describe("renderFrame 的运行中建层（L5：会话、两条路、prewarmFragments）", () => {
  /** 新层的配置（和模板对象 0 不同：不预置缓存时没命中） */
  const CONFIG = JSON.stringify({ image: "models/b.json", name: "bar", id: 9 });

  /** 脚本替身：`load` 里像 `createLayer` 一样建壳、交给 `live`，再等 `live.settle()`（同真实现）；`firstObject` 给了就用它当下标。 */
  function scriptsCreatingAt(when: "init" | "frame", config: string = CONFIG) {
    const objects: number[] = [];
    vi.mocked(createProbeScripts).mockImplementation((input) => {
      let frames = 0;
      let made = 0;
      const create = () => {
        const object = (input.firstObject ?? 1) + made++;
        addShellObject(input.state, object, config, null);
        objects.push(object);
        input.live?.create(object, config, null);
      };
      return {
        load: async () => {
          log.push("load");
          if (when === "init") create();
          await input.live?.settle();
        },
        frame: (dt: number, time: number) => {
          input.live?.drain();
          log.push(`script ${dt} ${time}`);
          if (when === "frame" && frames === 0) create();
          frames++;
        },
        result: () => ({ frames }) as never,
        dispose: () => {},
      };
    });
    return objects;
  }

  /** GPU 装卸的替身记进 `log`。 */
  function withGpu() {
    vi.mocked(GpuScene.build).mockImplementation(async () => {
      log.push("build");
      return {
        ...fakeScene(),
        prepareObjectSync: (layer: { object: number }) => ({ layer }),
        prepareObject: async (layer: { object: number }) => {
          log.push(`prepare ${layer.object}`);
          return { layer };
        },
        installObject: (prepared: { layer: { object: number } }) => void log.push(`install ${prepared.layer.object}`),
        discardPrepared: () => {},
      } as unknown as GpuScene;
    });
  }

  it("init 里建的层（没命中）：不再整场补编，会话编片段、init 之后接上并装 GPU，再跑首帧；计数 async", async () => {
    withGpu();
    scriptsCreatingAt("init");
    const result = await renderFrame({ ...BASE, scripts: true });
    expect(openSceneSession).toHaveBeenCalledTimes(1);
    expect(fragmentRequests.map((request) => request.object)).toEqual([1]);
    // 片段到达时预热（prepare 一次再放弃），接上时同步备好、装上；都在第一帧之前
    expect(log.slice(0, log.indexOf("sync"))).toEqual([
      "compile",
      "build",
      "videoSink",
      "properties",
      "load",
      "prepare 1",
      "install 1",
    ]);
    expect(result.liveCreate).toMatchObject({
      sync: 0,
      async: 1,
      unsupported: 0,
      pending: 0,
      reloads: [],
      prewarmed: 0,
    });
  });

  it("回放中途建的层（没命中）：探针的回放是同步的，片段赶不上读回帧，记 pending；scripts.recompile 里没有 createLayer", async () => {
    withGpu();
    scriptsCreatingAt("frame");
    const result = await renderFrame({ ...BASE, scripts: true, particles: PARTICLES });
    expect(fragmentRequests).toHaveLength(1);
    expect(log.some((line) => line.startsWith("install"))).toBe(false);
    expect(result.liveCreate).toMatchObject({ sync: 0, async: 0, pending: 1 });
  });

  it("prewarmFragments：预跑一遍收集配置、经会话编进缓存，正式那一遍第一轮就命中、当场装上；新建下标排在预跑编的之后", async () => {
    withGpu();
    const objects = scriptsCreatingAt("frame");
    const result = await renderFrame({ ...BASE, scripts: true, particles: PARTICLES, prewarmFragments: true });
    // 编译只一次：预跑与正式共用会话；片段只要一次（预跑之后，下标从 bundle 的配置个数起）
    expect(openSceneSession).toHaveBeenCalledTimes(1);
    expect(fragmentRequests.map((request) => request.object)).toEqual([1]);
    // 两遍各建一次场景；正式那一遍先预热预跑编好的，第一帧建层就当场装上
    expect(log.filter((line) => line === "build")).toHaveLength(2);
    expect(log).toContain("prepare 1");
    expect(objects).toEqual([1, 2]);
    expect(log).toContain("install 2");
    expect(result.liveCreate).toMatchObject({ sync: 1, async: 0, pending: 0, prewarmed: 1 });
  });

  it("prewarmFragments 遇到数字 model（脚本模型数据层，P14）的配置跳过：预跑不请求片段，正式那一遍照常走会话（数字 model 不进片段缓存）", async () => {
    withGpu();
    scriptsCreatingAt("frame", JSON.stringify({ model: 5, name: "part", id: 9 }));
    const result = await renderFrame({ ...BASE, scripts: true, particles: PARTICLES, prewarmFragments: true });
    // 预跑（dry）不收集这类配置：只有正式那一遍的一次请求（回放同步、赶不上读回帧，同上一条）
    expect(fragmentRequests).toHaveLength(1);
    expect(result.liveCreate).toMatchObject({ sync: 0, prewarmed: 0 });
  });

  it("prewarmFragments 不和 scripts 一起给：编译之前就抛错", async () => {
    await expect(renderFrame({ ...BASE, prewarmFragments: true })).rejects.toThrow("prewarmFragments");
    expect(log).toEqual([]);
  });
});

describe("renderFrame 的单对象重编译（L6：探针同路）", () => {
  /** GPU 装卸的替身记进 `log`（含卸掉）。 */
  function withGpu() {
    vi.mocked(GpuScene.build).mockImplementation(async () => {
      log.push("build");
      return {
        ...fakeScene(),
        prepareObjectSync: (layer: { object: number }) => ({ layer }),
        prepareObject: async (layer: { object: number }) => {
          log.push(`prepare ${layer.object}`);
          return { layer };
        },
        installObject: (prepared: { layer: { object: number } }) => void log.push(`install ${prepared.layer.object}`),
        removeObject: (object: number) => void log.push(`remove ${object}`),
        discardPrepared: () => {},
      } as unknown as GpuScene;
    });
  }

  /**
   * 脚本替身：`load` 里（同 `init`）对对象 0 连写两次对象级重编译目标，交给 `live.recompile`，再等 `live.settle()`（同真实现）。返回探针的状态与
   * 写之前的图层状态。
   */
  function scriptsRecompiling() {
    const seen: { state: SceneState | null; before: unknown; hook: boolean } = {
      state: null,
      before: null,
      hook: false,
    };
    vi.mocked(createProbeScripts).mockImplementation((input) => {
      seen.state = input.state;
      seen.hook = typeof input.live?.recompile === "function";
      return {
        load: async () => {
          log.push("load");
          seen.before = input.state.layers.get(0);
          const at = { parent: null, bone: null };
          input.live?.recompile?.(0, { font: "a.ttf" }, at, "");
          input.live?.recompile?.(0, { font: "b.ttf" }, at, "");
          await input.live?.settle();
        },
        frame: () => void input.live?.drain(),
        result: () => ({ frames: 0 }) as never,
        dispose: () => {},
      };
    });
    return seen;
  }

  it("init 里写的对象级目标：交给 live.recompile（在编时合并、到达后按最新的再发），片段换上状态与 GPU，都在首帧之前；不整场补编", async () => {
    withGpu();
    const seen = scriptsRecompiling();
    const result = await renderFrame({ ...BASE, scripts: true });
    expect(seen.hook).toBe(true);
    expect(openSceneSession).toHaveBeenCalledTimes(1);
    expect(fragmentRequests.map((request) => [request.object, request.overrides])).toEqual([
      [0, { font: "a.ttf" }],
      [0, { font: "b.ttf" }],
    ]);
    // 过期的那份不预热、不装；最新的那份到达时预热，接上时同步备好、替换装上
    expect(log.slice(0, log.indexOf("sync"))).toEqual([
      "compile",
      "build",
      "videoSink",
      "properties",
      "load",
      "prepare 0",
      "install 0",
    ]);
    expect(bundle.layers.find((layer) => layer.object === 0)!.size).toEqual([96, 48]);
    expect(seen.state!.layers.get(0)).not.toBe(seen.before);
    expect(result.liveCreate).toMatchObject({
      sync: 0,
      async: 0,
      unsupported: 0,
      pending: 0,
      reloads: [],
      recompiles: 2,
    });
  });

  it("片段带不支持项：状态照替换，卸掉旧的 GPU 运行时（不画），记进 unsupportedKeys；场景不退回", async () => {
    withGpu();
    recompileExtra = { unsupported: ["text:x"] };
    scriptsRecompiling();
    const result = await renderFrame({ ...BASE, scripts: true });
    expect(log).toContain("remove 0");
    expect(log.some((line) => line.startsWith("install"))).toBe(false);
    expect(result.liveCreate).toMatchObject({ unsupportedKeys: ["text:x"], reloads: [], unsupported: 0 });
  });

  it("片段带 sceneFlips：记进 reloads（宿主会整场重载，探针做不了），不替换", async () => {
    withGpu();
    recompileExtra = { sceneFlips: ["volumetrics"] };
    scriptsRecompiling();
    const result = await renderFrame({ ...BASE, scripts: true });
    expect(result.liveCreate!.reloads).toEqual([
      expect.stringContaining("重编译对象 0 翻转了场景级不变量（volumetrics）"),
    ]);
    expect(bundle.layers.find((layer) => layer.object === 0)!.size).not.toEqual([96, 48]);
  });

  it("hostStats 带 recompiledObjects（宿主交给单对象重编译的次数）", () => {
    const host = {
      stats: { applied: 2, recompiled: [], created: { sync: 0, async: 0, unsupported: 0 }, recompiledObjects: 3 },
      devScene: { renderer: null },
    } as unknown as SceneHost;
    expect(hostStats(host)).toMatchObject({ applied: 2, recompiledObjects: 3 });
  });
});

describe("renderFrame 的结构变化（L7：探针同路）", () => {
  /** GPU 的重排与装卸记进 `log`。 */
  function withGpu() {
    vi.mocked(GpuScene.build).mockImplementation(async () => {
      log.push("build");
      return {
        ...fakeScene(),
        restructure: (objects: number[]) =>
          void log.push(`restructure ${[...objects].sort((a, b) => a - b).join(",")}`),
        hasObject: () => true,
        removeObject: (object: number) => void log.push(`remove ${object}`),
        prepareObjectSync: (layer: { object: number }) => ({ layer }),
        installObject: (prepared: { layer: { object: number } }) => void log.push(`install ${prepared.layer.object}`),
      } as unknown as GpuScene;
    });
  }

  /** 场景加一个组合层 G（对象 1）：0 FR 运行中挂进去、再删组。`fullscreen` 给了时 FR 是 fullscreen 层（组里不支持）。 */
  function withGroup(fullscreen = false) {
    const fr = bundle.layers[0];
    if (fullscreen) fr.fullscreen = true;
    bundle.layers.push({ ...fr, object: 1, id: 2, name: "G", passthroughModel: true, fullscreen: false });
  }

  /** 脚本替身：第 1 帧 FR 挂进 G（交给 `live.restructure()`），第 2 帧删 G（`live.restructure([1])`），第 3 帧不动。 */
  function scriptsRestructuring() {
    const seen: { hook: boolean } = { hook: false };
    vi.mocked(createProbeScripts).mockImplementation((input) => {
      seen.hook = typeof input.live?.restructure === "function";
      let frames = 0;
      return {
        load: async () => void log.push("load"),
        frame: () => {
          frames++;
          if (frames === 1) {
            input.state.setParent(0, 1);
            input.live?.restructure?.();
          }
          if (frames === 2) {
            input.state.markDestroy(1);
            input.live?.restructure?.(input.state.flushDestroy());
          }
        },
        result: () => ({ frames }) as never,
        dispose: () => {},
      };
    });
    return seen;
  }

  it("换父进组、删组：登记表当场重算，变了的交给 GpuScene.restructure（下一次 sync 重排），不整场补编；restructured 计数", async () => {
    withGpu();
    withGroup();
    const seen = scriptsRestructuring();
    const result = await renderFrame({ ...BASE, scripts: true, particles: PARTICLES });
    expect(seen.hook).toBe(true);
    expect(openSceneSession).toHaveBeenCalledTimes(1);
    expect(log.filter((line) => line.startsWith("restructure"))).toEqual(["restructure 0,1", "restructure 0"]);
    expect(result.restructured).toBe(2);
    expect(result.liveCreate).toMatchObject({ reloads: [], unsupportedKeys: [] });
    // 删组之后 FR 回顶层，登记表里没有 G
    expect(bundle.layers.map((layer) => [layer.object, layer.group])).toEqual([[0, null]]);
  });

  it("组内不支持组合：进组的 fullscreen 层卸 GPU、键记进 unsupportedKeys，不交给重排；删组之后问题消失，照常装回", async () => {
    withGpu();
    withGroup(true);
    scriptsRestructuring();
    const result = await renderFrame({ ...BASE, scripts: true, particles: PARTICLES });
    expect(log.filter((line) => /^(restructure|remove|install)/.test(line))).toEqual([
      "remove 0",
      "restructure 1",
      "install 0",
      "restructure 0",
    ]);
    expect(result.liveCreate).toMatchObject({
      unsupportedKeys: ["model:passthrough:children:fullscreen"],
      reloads: [],
    });
  });

  it("hostStats 带 restructured（宿主结构变化当场重排的次数）", () => {
    const host = {
      stats: {
        applied: 0,
        recompiled: [],
        created: { sync: 0, async: 0, unsupported: 0 },
        recompiledObjects: 0,
        restructured: 3,
      },
      devScene: { renderer: null },
    } as unknown as SceneHost;
    expect(hostStats(host)).toMatchObject({ restructured: 3 });
  });
});
