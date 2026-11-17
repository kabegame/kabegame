import type { ScriptModule } from "./script/moduleFactory";
import { fakeModule } from "./script/testing/fakeModule";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneSpectrum } from "./audio/spectrum";
import { builtinProperties } from "./compile/builtinProperties";
import type { SceneBundle } from "./compile/bundle";
import type { ScriptRealm } from "./script/runtime";
import type { VideoSink } from "./video/sceneVideos";

const subscribeAudio = vi.fn<(args: Record<string, unknown>) => Promise<void>>();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

// 宿主依赖 IPC、Worker 编译与 WebGPU：都换成替身，只核对加载状态机（P3a 退回路径）与音频订阅（3c 点 0）
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "wpe_scene_target") return { path: "P:/p", sceneAssets: [] };
    if (command === "wpe_web_media_subscribe") return subscribeAudio(args);
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  }),
}));

const compile = vi.fn<(input: { userProperties: Record<string, unknown> }) => Promise<SceneBundle>>();
/** 开出过的编译会话替身（L2）：宿主要关的会话都在这里，核对留 / 关 */
const sessions = vi.hoisted(() => ({
  list: [] as { close: ReturnType<typeof vi.fn>; stats: unknown; broken: boolean }[],
}));
vi.mock("./compile/client", () => ({
  openSceneSession: async (input: never) => {
    const bundle = await compile(input);
    const session = {
      close: vi.fn(),
      compileFragment: vi.fn(),
      stats: { cachedBytes: 2048, mdls: 0, files: 0, programs: 0, textures: 0, wasmBytes: 4096 },
      broken: false,
    };
    sessions.list.push(session);
    return { bundle, session, exactConfigs: [] };
  },
}));

const createRealm = vi.fn<() => Promise<ScriptRealm>>();
vi.mock("./script/realm", () => ({ createIframeRealm: () => createRealm(), getJsModuleIndex: () => ({}) }));

const rendererStyle = vi.hoisted(() => ({
  setStyle: vi.fn(),
  setBackground: vi.fn(),
  setDisplayScale: vi.fn(),
  setMaxFps: vi.fn((_fps: number) => {}),
  setPlaybackRate: vi.fn((_rate: number) => {}),
}));
/** `SceneRenderer.create` 收到的选项（核对建渲染器时带上显示缩放）。 */
const rendererCreate = vi.hoisted(() => vi.fn((_options: unknown) => {}));
/** 就地写的落点（P4a 步骤 5 核对 instanceoverride 走就地一侧）。 */
const rendererWrites = vi.hoisted(() => ({ applyBindings: vi.fn((_writes: unknown) => true) }));
/** 指针与加载（P5a 收尾核对开场指针先于加载交给渲染器）。 */
const rendererPointer = vi.hoisted(() => ({
  setPointer: vi.fn((_x: number, _y: number) => {}),
  load: vi.fn(async (_bundle: unknown, _options?: unknown) => {}),
}));
/** 场景频谱的开关（P4e 步骤 4：订阅被拒时关掉）。 */
const rendererAudio = vi.hoisted(() => ({ disableAudio: vi.fn() }));

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  const renderer = {
    adapterInfo: { vendor: "test", architecture: "", description: "", features: [] },
    warnings: [],
    sceneStats: null,
    load: (bundle: unknown, options?: unknown) => rendererPointer.load(bundle, options),
    setPointer: (x: number, y: number) => rendererPointer.setPointer(x, y),
    setPaused: () => {},
    ...rendererStyle,
    applyBindings: (writes: unknown) => rendererWrites.applyBindings(writes),
    disableAudio: () => rendererAudio.disableAudio(),
    redraw: () => {},
    destroy: () => {},
  };
  return {
    ...actual,
    SceneRenderer: {
      create: async (_canvas: unknown, options: unknown) => {
        rendererCreate(options);
        return renderer;
      },
    },
  };
});

/**
 * 视频纹理（P9a 步骤 2）：替身 `SceneVideos`，每个实例把调用记进 `log`。真的会建 `<video>`、按区间 `fetch(file:)`，Node 里没有。
 * `firstFrames` 交回的 Promise 由 `firstFrameGate` 控制（缺省立即 resolve）。
 */
const videoFakes = vi.hoisted(() => ({
  instances: [] as { log: string[]; disposed: boolean }[],
  firstFrameGate: null as Promise<void> | null,
}));
vi.mock("./video/sceneVideos", () => ({
  SceneVideos: class {
    readonly record = { log: [] as string[], disposed: false };
    constructor() {
      videoFakes.instances.push(this.record);
    }
    load(textures: { video?: unknown }[]) {
      this.record.log.push(`load ${textures.map((texture) => (texture.video ? "v" : "-")).join("")}`);
    }
    setPaused(paused: boolean) {
      this.record.log.push(`paused ${paused}`);
    }
    setHostRate(rate: number) {
      this.record.log.push(`rate ${rate}`);
    }
    firstFrames(textures: readonly number[], timeoutMs: number) {
      this.record.log.push(`firstFrames ${textures.join(",")} ${timeoutMs}`);
      return videoFakes.firstFrameGate ?? Promise.resolve();
    }
    beginFrame() {
      this.record.log.push("beginFrame");
    }
    drawn(texture: number) {
      this.record.log.push(`drawn ${texture}`);
      return null;
    }
    probe() {
      return [];
    }
    dispose() {
      this.record.disposed = true;
    }
  },
}));

const { SceneHost } = await import("./host");
const { Channel } = await import("@tauri-apps/api/core");

/** 打开 fx（绑在一个不支持的 effect 的可见性上）时退回预览图，关掉就能渲染。退回状态下改属性一律走重新编译。 */
function bundleFor(properties: Record<string, unknown>): SceneBundle {
  return {
    general: { postprocess: { level: "disabled" } },
    layers: [],
    programs: [],
    textures: [],
    bloom: null,
    bindings: [{ property: "fx", target: { kind: "effect", object: 0, effect: 0 } }],
    scripts: { list: [] },
    unsupported: properties.fx === true ? ["effect:unsupported"] : [],
  } as unknown as SceneBundle;
}

function reporter() {
  return { ready: vi.fn(), fallback: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const fx = (value: boolean) => ({ fx: { type: "bool", value } });
/** 宿主首包补进全集的 WPE 内置项（P3a 修复）的裸值，`alignment` 按缺省样式 fill。 */
const builtinValues = () =>
  Object.fromEntries(Object.entries(builtinProperties()).map(([key, item]) => [key, item.value]));

describe("SceneHost：退回预览图后的属性变化", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("退回后改属性重新编译，能渲染就报 ready", async () => {
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledWith(["effect:unsupported"]));
    expect(report.ready).not.toHaveBeenCalled();

    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0].userProperties).toEqual({ ...builtinValues(), fx: false });
    host.dispose();
  });

  it("首次加载期间到达的增量：加载以退回告终时按新全集再编译", async () => {
    let finishFirst!: () => void;
    compile.mockImplementationOnce(
      ({ userProperties }) =>
        new Promise((resolve) => {
          finishFirst = () => resolve(bundleFor(userProperties));
        }),
    );
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    // 还在编译：增量只并进全集，不另起编译
    host.applyUserProperties(fx(false));
    expect(compile).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(report.fallback).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0].userProperties).toEqual({ ...builtinValues(), fx: false });
    host.dispose();
  });

  it("退回且编译期间属性没变：不重复编译", async () => {
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledTimes(1));
    // 同值再来一次：按值去重，没有变化
    host.applyUserProperties(fx(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});

describe("SceneHost：父页面下发的场景设置（后处理 / 反射 / 阴影 / 体积光）", () => {
  const compiledWith = () =>
    compile.mock.calls.map(([input]) => {
      const { postprocess, reflection, shadows, volumetrics } = input as {
        postprocess?: string;
        reflection?: string;
        shadows?: string;
        volumetrics?: string;
      };
      return [postprocess, reflection, shadows, volumetrics];
    });
  const FOLLOW = { postprocess: "follow", reflection: "follow", shadows: "follow", volumetrics: "follow" };

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load(settings?: Record<string, unknown>) {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    if (settings) host.setSceneSettings(settings as never);
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    return { host, report };
  }

  it("加载用父页面先给的值；不认识的值按跟随；没有父页面时不等、按跟随", async () => {
    const first = await load({ postprocess: "enabled", reflection: "disabled", shadows: "high", volumetrics: "low" });
    expect(compiledWith()).toEqual([["enabled", "disabled", "high", "low"]]);
    first.host.dispose();
    compile.mockClear();
    // 缺了的项（旧的父页面没有体积光）同不认识的值，按跟随
    const second = await load({ postprocess: 1, reflection: "bogus", shadows: null });
    expect(compiledWith()).toEqual([["follow", "follow", "follow", "follow"]]);
    second.host.dispose();
    compile.mockClear();
    const third = await load();
    expect(compiledWith()).toEqual([["follow", "follow", "follow", "follow"]]);
    third.host.dispose();
  });

  it("在 iframe 里：等父页面的第一条设置再编译", async () => {
    vi.stubGlobal("window", { parent: {} });
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).not.toHaveBeenCalled();
    host.setSceneSettings({ postprocess: "disabled", reflection: "enabled", shadows: "low", volumetrics: "ultra" });
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compiledWith()).toEqual([["disabled", "enabled", "low", "ultra"]]);
    expect(host.stats.recompiled).toEqual([]);
    host.dispose();
  });

  it("运行中值变了重新加载一次（编译带新值、探针记 settings），值不变不加载", async () => {
    const { host } = await load(FOLLOW);
    expect(compile).toHaveBeenCalledTimes(1);
    host.setSceneSettings(FOLLOW);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.setSceneSettings({ ...FOLLOW, reflection: "enabled" });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compiledWith().at(-1)).toEqual(["follow", "enabled", "follow", "follow"]);
    expect(host.stats.recompiled.at(-1)).toEqual({ reason: "settings", keys: ["reflection"] });
    host.setSceneSettings({ ...FOLLOW, reflection: "enabled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("四项一起变：只加载一次，键都记进探针", async () => {
    const { host } = await load(FOLLOW);
    host.setSceneSettings({ postprocess: "enabled", reflection: "disabled", shadows: "ultra", volumetrics: "high" });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compiledWith().at(-1)).toEqual(["enabled", "disabled", "ultra", "high"]);
    expect(host.stats.recompiled.at(-1)).toEqual({
      reason: "settings",
      keys: ["postprocess", "reflection", "shadows", "volumetrics"],
    });
    host.dispose();
  });

  /** 第 n 次编译带的 force（替身的参数类型里没有这个字段） */
  const forceOf = (call: number) => (compile.mock.calls[call][0] as { force?: unknown }).force;

  it("强制渲染：关着时有不支持项退回；打开后重新加载、带 force 编译并照常渲染；再关掉又退回", async () => {
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setSceneSettings({ ...FOLLOW, forceRender: false });
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledWith(["effect:unsupported"]));
    expect(forceOf(0)).toBe(false);
    expect(report.ready).not.toHaveBeenCalled();

    host.setSceneSettings({ ...FOLLOW, forceRender: true });
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(forceOf(1)).toBe(true);
    expect(host.stats.recompiled.at(-1)).toEqual({ reason: "settings", keys: ["forceRender"] });
    expect(report.warn).toHaveBeenCalledWith(expect.stringContaining("强制渲染（设置）"), ["effect:unsupported"]);

    host.setSceneSettings({ ...FOLLOW, forceRender: false });
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledTimes(2));
    expect(forceOf(2)).toBe(false);
    host.dispose();
  });

  it("强制渲染只认 true；dev 覆盖照旧生效", async () => {
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setSceneSettings({ ...FOLLOW, forceRender: "true" });
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledTimes(1));
    host.dispose();

    vi.stubGlobal("__SCENE_DEV__", true);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "kabegame-dev-scene-force-render" ? "1" : null),
    });
    const devReport = reporter();
    const devHost = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report: devReport });
    devHost.setSceneSettings(FOLLOW);
    devHost.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(devReport.ready).toHaveBeenCalledTimes(1));
    expect(devReport.warn).toHaveBeenCalledWith(expect.stringContaining("强制渲染（dev）"), ["effect:unsupported"]);
    devHost.dispose();
  });

  it("只改体积光：重新加载一次（P13e，档位决定 RT 与 QUALITY）", async () => {
    const { host } = await load(FOLLOW);
    host.setSceneSettings({ ...FOLLOW, volumetrics: "disabled" });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compiledWith().at(-1)).toEqual(["follow", "follow", "follow", "disabled"]);
    expect(host.stats.recompiled.at(-1)).toEqual({ reason: "settings", keys: ["volumetrics"] });
    host.dispose();
  });
});

type AudioBuffers = Record<"left" | "right" | "average", Float32Array>;
type Register = (resolution: number) => AudioBuffers;

/** 替身 realm：求值模块时跑 `body`（相当于脚本的模块顶层），真实的 ScriptApi 与 ScriptRuntime 照常工作。 */
class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  constructor(private readonly body: (register: Register) => void) {}
  async prepareModule(): Promise<ScriptModule> {
    this.body((this.global.engine as { registerAudioBuffers: Register }).registerAudioBuffers);
    return fakeModule({});
  }
  dispose() {}
}

/** 带一段脚本的场景；`fx` 绑在场景级重编译目标上，用来触发整场重编译（L6 起对象级的目标只重编那个对象）。 */
function scriptedBundle(): SceneBundle {
  return {
    ...bundleFor({}),
    general: { postprocess: { level: "disabled" }, bloom: { tint: [1, 1, 1] } },
    bindings: [
      {
        property: "fx",
        target: { kind: "recompile", reason: "layer-structure", path: "general/perspectiveoverridefov" },
      },
    ],
    scripts: {
      list: [
        {
          id: "audio",
          source: "",
          target: { kind: "layer", object: 0, field: "alpha" },
          valueType: "float",
          initial: 1,
          owner: { kind: "general" },
          layer: null,
          scriptProperties: null,
          imports: [],
          errors: [],
        },
      ],
    },
  } as unknown as SceneBundle;
}

/** 加载一张带脚本的场景并等到 ready；`body` 是脚本的模块顶层。 */
async function loadScene(body: (register: Register) => void) {
  createRealm.mockImplementation(async () => new FakeRealm(body));
  compile.mockImplementation(async () => scriptedBundle());
  const report = reporter();
  const host = new SceneHost({ width: 800, height: 600 } as HTMLCanvasElement, { imageId: "7", report });
  host.applyUserProperties(fx(false));
  await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
  return { host, report };
}

/** 宿主第一次订阅时交给后端的 Channel。 */
function subscribedChannel(): { onmessage(message: unknown): void } {
  return subscribeAudio.mock.calls[0][0].channel as { onmessage(message: unknown): void };
}

/** Hub 的原值：左声道全 0.5、右声道全 0.25。 */
const audioFrame = [...Array<number>(64).fill(0.5), ...Array<number>(64).fill(0.25)];
const allZero = (buffers: AudioBuffers) =>
  [buffers.left, buffers.right, buffers.average].every((array) => array.every((value) => value === 0));

/** 宿主建渲染器时交的两个音频选项（P4e 步骤 4）。 */
interface RendererAudioOptions {
  audioFrame?: () => ArrayLike<number> | null;
  beforeFrame?: (dt: number, spectrum: SceneSpectrum) => void;
}

/**
 * 替身渲染器的一个实时帧（P4e 步骤 4）：按最近一次建渲染器的选项取宿主存的原值推进 `spectrum`，再走 `beforeFrame`（脚本缓冲在这里从
 * 频谱拷）。替身不画，频谱由调用方建、跨帧传入以保持状态。
 */
function liveFrame(spectrum: SceneSpectrum, dt = 0.05): SceneSpectrum {
  const options = rendererCreate.mock.calls.at(-1)![0] as RendererAudioOptions;
  spectrum.advance(options.audioFrame?.() ?? null, dt);
  options.beforeFrame?.(dt, spectrum);
  return spectrum;
}

/** 缓冲是否正好是频谱同分辨率的块（拷过来的归一化值）。 */
function copiedFrom(buffers: AudioBuffers, spectrum: SceneSpectrum): boolean {
  const block = spectrum.block(buffers.left.length as 16 | 32 | 64);
  return (["left", "right", "average"] as const).every((name) =>
    buffers[name].every((value, i) => value === block[name][i]),
  );
}

describe("SceneHost：壁纸样式与留白", () => {
  const scheme = (value: string) => ({ schemecolor: { type: "color", value } });
  const unbound = (properties: Record<string, unknown>) => ({ ...bundleFor(properties), bindings: [] });

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererStyle.setStyle.mockReset();
    rendererStyle.setBackground.mockReset();
    rendererStyle.setDisplayScale.mockReset();
    rendererStyle.setMaxFps.mockReset();
    rendererStyle.setPlaybackRate.mockReset();
    rendererCreate.mockReset();
    compile.mockImplementation(async ({ userProperties }) => unbound(userProperties));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("渲染器建好时带上已收到的样式与 schemecolor", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setStyle("center");
    host.applyUserProperties(scheme("1 0.5 0"));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererStyle.setStyle).toHaveBeenLastCalledWith("center");
    expect(rendererStyle.setBackground).toHaveBeenLastCalledWith([1, 0.5, 0]);
    host.dispose();
  });

  it("运行时改样式与 schemecolor 就地生效，不重新编译", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    host.setStyle("fit");
    expect(rendererStyle.setStyle).toHaveBeenLastCalledWith("fit");
    host.applyUserProperties(scheme("0 1 0"));
    expect(rendererStyle.setBackground).toHaveBeenLastCalledWith([0, 1, 0]);
    await Promise.resolve();
    expect(compile).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("显示缩放：建渲染器时带上已收到的值，之后就地交给渲染器、不重新编译", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setDisplayScale(0.25);
    host.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayScale: 0.25 }));
    // 取设备期间没变：不用再设一次
    expect(rendererStyle.setDisplayScale).not.toHaveBeenCalled();
    host.setDisplayScale(0.5);
    expect(rendererStyle.setDisplayScale).toHaveBeenLastCalledWith(0.5);
    await Promise.resolve();
    expect(compile).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("播放速度（kabegame:wpe-scene-rate）：建渲染器时带上已收到的值，之后就地交给渲染器、不重新编译；钳进 0.25–4，非法值忽略", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setPlaybackRate(2);
    host.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererStyle.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(2);
    host.setPlaybackRate(9);
    expect(rendererStyle.setPlaybackRate).toHaveBeenLastCalledWith(4);
    host.setPlaybackRate(0.1);
    expect(rendererStyle.setPlaybackRate).toHaveBeenLastCalledWith(0.25);
    // 同值不再下发；非法值忽略
    for (const bad of [0.2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) host.setPlaybackRate(bad);
    expect(rendererStyle.setPlaybackRate).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(compile).toHaveBeenCalledOnce();
    host.dispose();

    // 缺省 1：建渲染器时不用设
    rendererStyle.setPlaybackRate.mockReset();
    const fresh = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report: reporter() });
    fresh.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(rendererCreate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(rendererStyle.setPlaybackRate).not.toHaveBeenCalled();
    fresh.dispose();
  });

  it("帧率（applyGeneralProperties 的 general.fps）：没收到时按 30 建渲染器，收到的值建时带上，之后就地交给渲染器、不重新编译", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setGeneral({ language: "zh", fps: 15 });
    host.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxFps: 15 }));
    // 取设备期间没变：不用再设一次
    expect(rendererStyle.setMaxFps).not.toHaveBeenCalled();
    // 取整；同值不再下发
    host.setGeneral({ language: "zh", fps: 59.6 });
    expect(rendererStyle.setMaxFps).toHaveBeenLastCalledWith(60);
    host.setGeneral({ language: "en", fps: 60 });
    expect(rendererStyle.setMaxFps).toHaveBeenCalledOnce();
    // 非法值忽略、保持当前帧率
    for (const general of [{ language: "zh" }, { fps: 0 }, { fps: -5 }, { fps: Number.NaN }, { fps: "30" }, null, 3])
      host.setGeneral(general);
    expect(rendererStyle.setMaxFps).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(compile).toHaveBeenCalledOnce();
    host.dispose();

    const fresh = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report: reporter() });
    fresh.applyUserProperties(scheme("0 0 0"));
    await vi.waitFor(() => expect(rendererCreate).toHaveBeenCalledTimes(2));
    expect(rendererCreate.mock.calls[1][0]).toEqual(expect.objectContaining({ maxFps: 30 }));
    fresh.dispose();
  });
});

describe("SceneHost：透视场景的分辨率变化（P5d 步骤 2）", () => {
  /** `SceneRenderer.create` 收到的回调（第 i 次建渲染器）。 */
  const optionsAt = (i: number) =>
    rendererCreate.mock.calls[i][0] as { onRenderSizeChange?: () => void; onLost?: (reasons: string[]) => void };

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererCreate.mockReset();
    rendererPointer.load.mockClear();
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("onRenderSizeChange：整场重新编译、再加载一次（同一个渲染器）；渲染器换掉之后旧回调不触发重载", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties({});
    await vi.waitFor(() => expect(rendererPointer.load).toHaveBeenCalledOnce());
    expect(compile).toHaveBeenCalledOnce();
    const first = optionsAt(0);
    first.onRenderSizeChange!();
    await vi.waitFor(() => expect(rendererPointer.load).toHaveBeenCalledTimes(2));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(rendererCreate).toHaveBeenCalledOnce();
    // 设备丢失：宿主丢掉这个渲染器、建新的并重新加载
    first.onLost!(["webgpu:device-lost:test"]);
    await vi.waitFor(() => expect(rendererPointer.load).toHaveBeenCalledTimes(3));
    expect(rendererCreate).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(3);
    // 旧渲染器的回调：rendererTask 已不是它，不重载
    first.onRenderSizeChange!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(3);
    expect(rendererPointer.load).toHaveBeenCalledTimes(3);
    // 新渲染器的回调照常重载
    optionsAt(1).onRenderSizeChange!();
    await vi.waitFor(() => expect(rendererPointer.load).toHaveBeenCalledTimes(4));
    expect(compile).toHaveBeenCalledTimes(4);
    host.dispose();
  });
});

describe("SceneHost：音频订阅与脚本音频缓冲", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    compile.mockReset();
    createRealm.mockReset();
    subscribeAudio.mockReset();
    subscribeAudio.mockResolvedValue(undefined);
    rendererCreate.mockClear();
    rendererAudio.disableAudio.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("脚本不注册音频缓冲、场景也不用音频就不订阅", async () => {
    const { host } = await loadScene(() => {});
    expect(subscribeAudio).not.toHaveBeenCalled();
    // 替身渲染器没有场景频谱：spectrum16 为 null
    expect(host.audio()).toEqual({
      subscribed: false,
      error: null,
      frames: 0,
      resolutions: [],
      peak: 0,
      raw: null,
      spectrum16: null,
    });
    host.dispose();
  });

  it("场景用音频（bundle.audio，P4e 步骤 4）：没有脚本也在加载时订阅，只订一次；重编译不重订", async () => {
    compile.mockImplementation(async ({ userProperties }) => ({
      ...bundleFor(userProperties),
      bindings: [{ property: "fx", target: { kind: "recompile", reason: "layer-structure", path: "objects/0/x" } }],
      unsupported: [],
      audio: true,
    }));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "5", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(createRealm).not.toHaveBeenCalled();
    expect(subscribeAudio).toHaveBeenCalledExactlyOnceWith({
      kind: "audio",
      channel: expect.any(Channel),
      imageId: "5",
    });
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("重新加载")));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(subscribeAudio).toHaveBeenCalledTimes(1);
    // 原值只存最近一份，渲染器每帧开头经 audioFrame 取
    subscribedChannel().onmessage({ type: "audio", data: [], raw: audioFrame });
    const options = rendererCreate.mock.calls.at(-1)![0] as RendererAudioOptions;
    expect(options.audioFrame?.()).toBe(audioFrame);
    host.dispose();
  });

  it("第一次注册才订阅，参数带 kind / imageId；再注册不重复订阅", async () => {
    const calls: number[] = [];
    const { host } = await loadScene((register) => {
      calls.push(subscribeAudio.mock.calls.length);
      register(16);
      calls.push(subscribeAudio.mock.calls.length);
      register(32);
      register(16);
    });
    expect(calls).toEqual([0, 1]);
    expect(subscribeAudio).toHaveBeenCalledTimes(1);
    expect(subscribeAudio).toHaveBeenCalledWith({ kind: "audio", channel: expect.any(Channel), imageId: "7" });
    expect(host.audio()).toMatchObject({ subscribed: true, resolutions: [16, 32] });
    host.dispose();
  });

  it("Channel 的 audio 消息只存原值，缓冲在渲染器推进频谱之后拷归一化值（P4e 步骤 4）；其它类型的消息忽略", async () => {
    const registered: AudioBuffers[] = [];
    const { host } = await loadScene((register) => registered.push(register(16), register(64)));
    const channel = subscribedChannel();
    const spectrum = new SceneSpectrum();

    channel.onmessage({ type: "status", enabled: true });
    channel.onmessage({ type: "timeline", position: 1, duration: 2, data: audioFrame });
    channel.onmessage({ type: "audio" });
    // 只有网页壁纸用的 data、没有 raw 的消息不算（场景只读 WPE 原始频谱）
    channel.onmessage({ type: "audio", data: audioFrame });
    liveFrame(spectrum);
    expect(registered.every(allZero)).toBe(true);
    expect(host.audio()).toMatchObject({ frames: 0, peak: 0 });

    channel.onmessage({ type: "audio", data: [], raw: audioFrame });
    // 消息本身不写缓冲（以前段内取最大后直接写）
    expect(registered.every(allZero)).toBe(true);
    liveFrame(spectrum);
    for (const buffers of registered) expect(copiedFrom(buffers, spectrum)).toBe(true);
    // 归一化过：第一个有声帧峰值重置为 1、同帧降 0.5·dt，读数是原值 / 0.975，不是原值
    expect(registered[0].left[0]).toBeGreaterThan(0.5);
    expect(registered[0].left[0]).toBe(spectrum.L16[0]);
    expect(registered[1].average[0]).toBe(spectrum.A64[0]);
    expect(host.audio()).toMatchObject({ frames: 1, peak: 0.5 });
    host.dispose();
  });

  it("订阅被拒时不报错，场景频谱关掉，缓冲保持全零", async () => {
    subscribeAudio.mockRejectedValue("this wallpaper does not process audio");
    const registered: AudioBuffers[] = [];
    const { host, report } = await loadScene((register) => registered.push(register(32)));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("音频订阅被拒")));
    // 渲染器建好之前或之后被拒都关一次
    await vi.waitFor(() => expect(rendererAudio.disableAudio).toHaveBeenCalledTimes(1));
    expect(report.warn).not.toHaveBeenCalled();
    expect(report.error).not.toHaveBeenCalled();
    expect(report.fallback).not.toHaveBeenCalled();
    const spectrum = new SceneSpectrum();
    spectrum.disable();
    liveFrame(spectrum);
    expect(allZero(registered[0])).toBe(true);
    expect(host.audio()).toMatchObject({
      subscribed: false,
      error: "this wallpaper does not process audio",
      frames: 0,
      resolutions: [32],
    });
    host.dispose();
  });

  it("没有图片 id 时不订阅", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: null, report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledWith(["host:missing-image-id"]));
    expect(createRealm).not.toHaveBeenCalled();
    // 加载路径走不到脚本；订阅函数自己的判断也要挡住
    (host as unknown as { subscribeAudio(): void }).subscribeAudio();
    expect(subscribeAudio).not.toHaveBeenCalled();
    expect(host.audio().subscribed).toBe(false);
    host.dispose();
  });

  it("重编译保留 realm 与缓冲，不重订，之后的帧写进原来的数组", async () => {
    const registered: AudioBuffers[] = [];
    const { host, report } = await loadScene((register) => registered.push(register(16)));
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("重新加载")));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(createRealm).toHaveBeenCalledTimes(1);
    expect(subscribeAudio).toHaveBeenCalledTimes(1);
    subscribedChannel().onmessage({ type: "audio", data: [], raw: audioFrame });
    const spectrum = liveFrame(new SceneSpectrum());
    expect(registered).toHaveLength(1);
    expect(copiedFrom(registered[0], spectrum)).toBe(true);
    expect(registered[0].left[0]).not.toBe(0);
    host.dispose();
  });

  it("清空存储重启脚本：音频订阅保留，新脚本的缓冲继续收到数据", async () => {
    const registered: AudioBuffers[] = [];
    const { host } = await loadScene((register) => registered.push(register(16)));
    const channel = subscribedChannel();
    listeners.get("wpe-scene-clear-storage")!({ payload: { imageId: "7" } });
    await vi.waitFor(() => expect(registered).toHaveLength(2));
    expect(subscribeAudio).toHaveBeenCalledTimes(1);
    expect(host.audio()).toMatchObject({ subscribed: true, resolutions: [16] });
    channel.onmessage({ type: "audio", data: [], raw: audioFrame });
    const spectrum = liveFrame(new SceneSpectrum());
    expect(copiedFrom(registered[1], spectrum)).toBe(true);
    expect(registered[1].left[0]).not.toBe(0);
    // 旧脚本持有的缓冲不再更新
    expect(allZero(registered[0])).toBe(true);
    host.dispose();
  });

  it("宿主销毁后的帧不再写缓冲", async () => {
    const registered: AudioBuffers[] = [];
    const { host } = await loadScene((register) => registered.push(register(16)));
    host.dispose();
    subscribedChannel().onmessage({ type: "audio", data: [], raw: audioFrame });
    liveFrame(new SceneSpectrum());
    expect(allZero(registered[0])).toBe(true);
  });
});

describe("SceneHost：粒子 instanceoverride（P4a 步骤 5）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererWrites.applyBindings.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("instanceoverride 绑定的属性增量走就地写，不重新编译", async () => {
    const binding = { property: "count", target: { kind: "particle-instance", object: 2, field: "count" } };
    compile.mockImplementation(async () => ({ ...bundleFor({}), bindings: [binding] }) as unknown as SceneBundle);
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties({ count: { type: "slider", value: 1 } });
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    host.applyUserProperties({ count: { type: "slider", value: 2 } });
    expect(rendererWrites.applyBindings).toHaveBeenCalledWith([{ binding, value: 2 }]);
    expect(host.stats).toEqual({
      applied: 1,
      recompiled: [],
      created: { sync: 0, async: 0, unsupported: 0 },
      recompiledObjects: 0,
      restructured: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});

describe("SceneHost：WPE 内置属性（P3a 修复）", () => {
  const binding = { property: "alignment", condition: "1", target: { kind: "layer", object: 0, field: "visible" } };
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererWrites.applyBindings.mockClear();
    compile.mockImplementation(async () => ({ ...bundleFor({}), bindings: [binding] }) as unknown as SceneBundle);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("首包补上 14 个内置项（alignment 按首包前收到的样式），工程声明的同名属性以工程的为准", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setStyle("fit");
    host.applyUserProperties({ wec_hue: { type: "slider", value: 7 }, mine: { type: "slider", value: 1 } });
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compile.mock.calls[0][0].userProperties).toEqual({ ...builtinValues(), alignment: 1, wec_hue: 7, mine: 1 });
    host.dispose();
  });

  it("运行中改样式：alignment 作为一条增量就地写（绑了它的目标跟着变），值没变不发；不重新编译", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties({});
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    host.setStyle("fit");
    expect(rendererWrites.applyBindings).toHaveBeenCalledExactlyOnceWith([{ binding, value: 1 }]);
    // tile 与 fill 同是 0：fill → tile 只发一次
    host.setStyle("fill");
    host.setStyle("tile");
    expect(rendererWrites.applyBindings).toHaveBeenCalledTimes(2);
    expect(rendererWrites.applyBindings).toHaveBeenLastCalledWith([{ binding, value: 0 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("工程自己声明了 alignment：样式不动它", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties({ alignment: { type: "combo", value: 3 } });
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compile.mock.calls[0][0].userProperties.alignment).toBe(3);
    host.setStyle("fit");
    expect(rendererWrites.applyBindings).not.toHaveBeenCalled();
    host.dispose();
  });
});

describe("SceneHost：开场指针（P5a 收尾）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererPointer.setPointer.mockClear();
    rendererPointer.load.mockClear();
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("渲染器建好前收到的指针：建好时、加载之前带进去（只带最近的一次）；之后就地交", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.setPointer(0.2, 0.8);
    host.setPointer(0.3, 0.7);
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererPointer.setPointer).toHaveBeenCalledExactlyOnceWith(0.3, 0.7);
    // 先于第一次 load：渲染器加载时的预热与第一帧用它
    expect(rendererPointer.setPointer.mock.invocationCallOrder[0]).toBeLessThan(
      rendererPointer.load.mock.invocationCallOrder[0],
    );
    host.setPointer(0.9, 0.1);
    expect(rendererPointer.setPointer).toHaveBeenLastCalledWith(0.9, 0.1);
    host.dispose();
  });

  it("没收到过指针就不设，渲染器保持场景中心", async () => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(rendererPointer.load).toHaveBeenCalled();
    expect(rendererPointer.setPointer).not.toHaveBeenCalled();
    host.dispose();
  });
});

describe("SceneHost：视频纹理（P9a 步骤 2）", () => {
  /** `names` 里 `-` 是普通纹理，其余是视频（区间按名字区分）；`fx` 绑在重编译目标上，改它就整场重编译。 */
  function videoBundle(names: string[]): SceneBundle {
    return {
      ...bundleFor({}),
      bindings: [
        {
          property: "fx",
          target: { kind: "recompile", reason: "layer-structure", path: "general/perspectiveoverridefov" },
        },
      ],
      textures: names.map((name) =>
        name === "-"
          ? { path: "materials/i.tex" }
          : { path: `materials/${name}.tex`, video: { path: `P:/p/materials/${name}.tex`, start: 91, end: 1091 } },
      ),
    } as unknown as SceneBundle;
  }
  /** 渲染器拿到的 `videos` 选项（宿主的 sink）。 */
  const rendererSink = () => (rendererCreate.mock.calls[0][0] as { videos: VideoSink }).videos;

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererCreate.mockClear();
    videoFakes.instances.length = 0;
    videoFakes.firstFrameGate = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rendererPointer.load.mockImplementation(async () => {});
  });

  it("没有视频纹理的 bundle 不建 SceneVideos；没有纹理表的手写 bundle 也一样", async () => {
    compile.mockImplementationOnce(async () => videoBundle(["-"]));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    host.dispose();

    compile.mockImplementationOnce(async () => ({ ...bundleFor({}), textures: undefined }) as unknown as SceneBundle);
    const bare = reporter();
    const other = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report: bare });
    other.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(bare.ready).toHaveBeenCalledOnce());
    expect(videoFakes.instances).toEqual([]);
    expect(other.videos()).toEqual([]);
    other.dispose();
  });

  it("建好先按宿主暂停定状态再 load；之后暂停 / 隐藏都转给 setPaused(paused || hidden)；销毁时释放", async () => {
    compile.mockImplementation(async () => videoBundle(["v0", "-"]));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    // 建之前暂停：只记下，建的时候带上
    host.setPaused(true);
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect(videoFakes.instances).toHaveLength(1);
    const [videos] = videoFakes.instances;
    // 渲染器替身没有状态，可见性取不到：等全部视频纹理
    expect(videos.log).toEqual(["paused true", "load v-", "firstFrames 0 2000"]);
    expect(rendererCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        videos: expect.objectContaining({ beginFrame: expect.any(Function), drawn: expect.any(Function) }),
      }),
    );
    videos.log.length = 0;
    host.setHidden(true);
    host.setPaused(false);
    host.setHidden(false);
    expect(videos.log).toEqual(["paused true", "paused true", "paused false"]);
    host.dispose();
    expect(videos.disposed).toBe(true);
  });

  it("第一次 ready 等可见视频的第一帧；重编译不等，沿用同一个 SceneVideos", async () => {
    let release!: () => void;
    videoFakes.firstFrameGate = new Promise((resolve) => (release = resolve));
    compile.mockImplementation(async () => videoBundle(["-", "v1"]));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(videoFakes.instances[0]?.log).toContain("firstFrames 1 2000"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(report.ready).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("重新加载")));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(videoFakes.instances).toHaveLength(1);
    const log = videoFakes.instances[0].log;
    expect(log.filter((line) => line.startsWith("load"))).toEqual(["load -v", "load -v"]);
    expect(log.filter((line) => line.startsWith("firstFrames"))).toHaveLength(1);
    host.dispose();
  });

  it("渲染器运行期失败退回预览图时释放", async () => {
    compile.mockImplementation(async () => videoBundle(["v0"]));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    (rendererCreate.mock.calls[0][0] as { onError(reasons: string[]): void }).onError(["webgpu:validation:x"]);
    expect(report.fallback).toHaveBeenCalledWith(["webgpu:validation:x"]);
    expect(videoFakes.instances[0].disposed).toBe(true);
    expect(rendererSink().drawn(0)).toBeNull();
    host.dispose();
  });

  it("sink：新场景换上之前，旧场景问的旧下标按视频区间换算成新下标；新 bundle 里没有的视频不交帧", async () => {
    const first = videoBundle(["vx", "vy", "vz"]);
    const second = videoBundle(["vy", "-", "vx"]);
    compile.mockImplementationOnce(async () => first).mockImplementation(async () => second);
    // 渲染器替身在换场景那一刻调 beforeFirstFrame（同 `SceneRenderer.load`）；`gate` 挡住第二次换场景
    let gate: Promise<void> = Promise.resolve();
    rendererPointer.load.mockImplementation(async (_bundle: unknown, options?: unknown) => {
      await gate;
      // 替身状态要有 `adoptStructure`（P6d3a：宿主在首帧前接旧状态的结构）与 `syncAnimationLayers`（P12e：按运行时的层表对齐动画层字段）
      (options as { beforeFirstFrame?: (state: unknown) => void }).beforeFirstFrame?.({
        adoptStructure() {},
        syncAnimationLayers() {},
      });
    });
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    const sink = rendererSink();
    const log = videoFakes.instances[0].log;
    sink.beginFrame();
    sink.drawn(1);
    expect(log.slice(-2)).toEqual(["beginFrame", "drawn 1"]);

    let swap!: () => void;
    gate = new Promise((resolve) => (swap = resolve));
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(log).toContain("load v-v"));
    log.length = 0;
    // 旧场景还在画：vx 0 → 2、vy 1 → 0，vz 新 bundle 里没有
    expect([sink.drawn(0), sink.drawn(1), sink.drawn(2)]).toEqual([null, null, null]);
    expect(log).toEqual(["drawn 2", "drawn 0"]);

    swap();
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("重新加载")));
    log.length = 0;
    sink.drawn(0);
    expect(log).toEqual(["drawn 0"]);
    host.dispose();
  });
});

describe("SceneHost：加载进度（壁纸显示重构步骤 2）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    compile.mockImplementation(async (input) => {
      const { onProgress } = input as { onProgress?: (stage: string, done: number, total: number) => void };
      onProgress?.("compile", 0, 3);
      onProgress?.("compile", 3, 3);
      onProgress?.("decode", 0, 0);
      return { ...bundleFor(input.userProperties), bindings: [] };
    });
    rendererPointer.load.mockImplementation(async (_bundle, options) => {
      const { onProgress } = options as { onProgress?: (stage: string, done: number, total: number) => void };
      onProgress?.("gpu", 0, 2);
      onProgress?.("gpu", 2, 2);
      onProgress?.("frame", 0, 1);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rendererPointer.load.mockReset();
    rendererPointer.load.mockImplementation(async () => {});
  });

  it("首次加载按阶段报进度、最后报首帧；开始渲染的日志带分段用时；之后的重新加载不报", async () => {
    const report = { ...reporter(), progress: vi.fn() };
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(report.progress.mock.calls).toEqual([
      ["compile", 0, 3],
      ["compile", 3, 3],
      ["decode", 0, 0],
      ["prepare", 0, 1],
      ["gpu", 0, 2],
      ["gpu", 2, 2],
      ["frame", 0, 1],
      ["frame", 1, 1],
    ]);
    const started = report.info.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("开始渲染"));
    expect(started).toMatch(
      /（等目标与设置 \d+ ms、编译 \d+ ms、解码 \d+ ms、准备 \d+ ms、取设备 \d+ ms、建 GPU 场景 \d+ ms、首帧 \d+ ms）/,
    );

    report.progress.mockClear();
    host.setSceneSettings({ postprocess: "disabled", reflection: "follow", shadows: "follow", volumetrics: "follow" });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(report.progress).not.toHaveBeenCalled();
    host.dispose();
  });

  it("被新的加载取代后，旧加载的进度不再报", async () => {
    let release!: () => void;
    compile.mockImplementationOnce(async (input) => {
      const { onProgress } = input as { onProgress?: (stage: string, done: number, total: number) => void };
      onProgress?.("compile", 0, 4);
      await new Promise<void>((resolve) => (release = resolve));
      onProgress?.("compile", 4, 4);
      return { ...bundleFor(input.userProperties), bindings: [] };
    });
    const report = { ...reporter(), progress: vi.fn() };
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    // 加载中设置变了：起第二次加载，第一次作废
    host.setSceneSettings({ postprocess: "disabled", reflection: "follow", shadows: "follow", volumetrics: "follow" });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    const before = report.progress.mock.calls.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(report.progress.mock.calls.length).toBe(before);
    expect(report.progress.mock.calls).not.toContainEqual(["compile", 4, 4]);
    host.dispose();
  });
});

describe("SceneHost：编译会话的留与关（L2）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    sessions.list.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (imageId = "1") => {
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId, report });
    host.applyUserProperties({});
    return { host, report };
  };

  it("没有脚本、没有 layer-structure 绑定的场景：编完就关会话", async () => {
    compile.mockImplementation(async ({ userProperties }) => ({ ...bundleFor(userProperties), bindings: [] }));
    const { host, report } = open();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(sessions.list).toHaveLength(1);
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
  });

  it("有脚本的场景：会话留着，日志带统计；销毁时关", async () => {
    createRealm.mockImplementation(async () => new FakeRealm(() => {}));
    compile.mockImplementation(async () => scriptedBundle());
    const { host, report } = open("7");
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(sessions.list[0].close).not.toHaveBeenCalled();
    const line = report.info.mock.calls.map((call) => String(call[0])).find((text) => text.includes("开始渲染"))!;
    expect(line).toContain("编译会话：留（缓存 2 KiB、wasm 4 KiB）");
    host.dispose();
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
  });

  it("只有对象级的 layer-structure 绑定（没有脚本）：留着（L6 单对象重编译要用）", async () => {
    compile.mockImplementation(
      async () =>
        ({
          ...scriptedBundle(),
          bindings: [
            { property: "fx", target: { kind: "recompile", reason: "layer-structure", path: "objects/0/size" } },
          ],
          scripts: { list: [] },
        }) as unknown as SceneBundle,
    );
    const { host, report } = open();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(sessions.list[0].close).not.toHaveBeenCalled();
    host.dispose();
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
  });

  it("只有场景级的 layer-structure 绑定（没有脚本）：编完就关（L7：它整场重载，用不着会话）", async () => {
    compile.mockImplementation(
      async () =>
        ({
          ...scriptedBundle(),
          scripts: { list: [] },
        }) as unknown as SceneBundle,
    );
    const { host, report } = open();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
  });

  it("换场景（重新加载）：旧会话关掉，新会话留着", async () => {
    createRealm.mockImplementation(async () => new FakeRealm(() => {}));
    compile.mockImplementation(async () => scriptedBundle());
    const { host, report } = open("7");
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    host.applyUserProperties(fx(true));
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(sessions.list.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(sessions.list[0].close).toHaveBeenCalledTimes(1));
    const alive = sessions.list.filter((session) => session.close.mock.calls.length === 0);
    expect(alive).toHaveLength(1);
    host.dispose();
    expect(sessions.list.filter((session) => session.close.mock.calls.length === 0)).toHaveLength(0);
  });

  it("加载以退回告终：会话关掉，没有留下", async () => {
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalled());
    expect(sessions.list).toHaveLength(1);
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("留着会话的场景退回预览图：会话关掉", async () => {
    createRealm.mockImplementation(async () => new FakeRealm(() => {}));
    let unsupported = false;
    compile.mockImplementation(
      async () => ({ ...scriptedBundle(), unsupported: unsupported ? ["effect:unsupported"] : [] }) as SceneBundle,
    );
    const { host, report } = open("7");
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(sessions.list[0].close).not.toHaveBeenCalled();
    unsupported = true;
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalled());
    expect(sessions.list[0].close).toHaveBeenCalledTimes(1);
    expect(sessions.list.every((session) => session.close.mock.calls.length >= 1)).toBe(true);
    host.dispose();
  });
});

describe("SceneHost：登记表在建 GPU 场景之前建（L4）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rendererPointer.load.mockReset();
    rendererPointer.load.mockImplementation(async () => {});
  });

  it("load 收到登记表的 particleOrdinal（按 bundle 里带粒子的图层顺序），换上场景时同一个登记表成为当前的", async () => {
    const layer = (object: number, particle: boolean) => ({
      object,
      id: object + 1,
      parent: null,
      effects: [],
      passes: [],
      ...(particle ? { particle: {} } : {}),
    });
    compile.mockImplementation(async ({ userProperties }) => ({
      ...bundleFor(userProperties),
      bindings: [],
      layers: [layer(0, false), layer(1, true), layer(2, false), layer(3, true)] as unknown as SceneBundle["layers"],
    }));
    let ordinal: ((object: number) => number) | undefined;
    rendererPointer.load.mockImplementation(async (_bundle: unknown, options?: unknown) => {
      ordinal = (options as { particleOrdinal?: (object: number) => number }).particleOrdinal;
      (options as { beforeFirstFrame?: (state: unknown) => void }).beforeFirstFrame?.({
        adoptStructure() {},
        syncAnimationLayers() {},
      });
    });
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    expect([0, 1, 2, 3].map((object) => ordinal!(object))).toEqual([0, 0, 0, 1]);
    const registry = (host as unknown as { registry: { particleOrdinal(object: number): number } }).registry;
    expect(registry.particleOrdinal(3)).toBe(1);
    // 换上的登记表就是交给渲染器的那一个：在它上面摘掉对象，渲染器拿到的回调跟着变（序号不回收）
    (registry as unknown as { removeObject(object: number): boolean }).removeObject(1);
    expect(ordinal!(1)).toBe(0);
    expect(ordinal!(3)).toBe(1);
    host.dispose();
  });
});
