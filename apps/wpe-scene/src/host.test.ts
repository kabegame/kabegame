import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "./compile/bundle";
import type { ScriptRealm } from "./script/runtime";

const subscribeAudio = vi.fn<(args: Record<string, unknown>) => Promise<void>>();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

// 宿主依赖 IPC、Worker 编译与 WebGPU：都换成替身，只核对加载状态机（P3a 退回路径）与音频订阅（3c 点 0）
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "wpe_scene_target") return { path: "P:/p", sceneAssets: [] };
    if (command === "get_wpe_scene_postprocess") return "disabled";
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
vi.mock("./compile/client", () => ({ compileSceneInWorker: (input: never) => compile(input) }));

const createRealm = vi.fn<() => Promise<ScriptRealm>>();
vi.mock("./script/realm", () => ({ createIframeRealm: () => createRealm(), getJsModuleIndex: () => ({}) }));

const rendererStyle = vi.hoisted(() => ({ setStyle: vi.fn(), setBackground: vi.fn(), setDisplayScale: vi.fn() }));
/** `SceneRenderer.create` 收到的选项（核对建渲染器时带上显示缩放）。 */
const rendererCreate = vi.hoisted(() => vi.fn((_options: unknown) => {}));
/** 就地写的落点（P4a 步骤 5 核对 instanceoverride 走就地一侧）。 */
const rendererWrites = vi.hoisted(() => ({ applyBindings: vi.fn((_writes: unknown) => true) }));

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  const renderer = {
    adapterInfo: { vendor: "test", architecture: "", description: "", features: [] },
    warnings: [],
    sceneStats: null,
    load: async () => {},
    setPaused: () => {},
    ...rendererStyle,
    applyBindings: (writes: unknown) => rendererWrites.applyBindings(writes),
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
    expect(compile.mock.calls[1][0].userProperties).toEqual({ fx: false });
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
    expect(compile.mock.calls[1][0].userProperties).toEqual({ fx: false });
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

type AudioBuffers = Record<"left" | "right" | "average", Float32Array>;
type Register = (resolution: number) => AudioBuffers;

/** 替身 realm：求值模块时跑 `body`（相当于脚本的模块顶层），真实的 ScriptApi 与 ScriptRuntime 照常工作。 */
class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  constructor(private readonly body: (register: Register) => void) {}
  async importModule(): Promise<Record<string, unknown>> {
    this.body((this.global.engine as { registerAudioBuffers: Register }).registerAudioBuffers);
    return {};
  }
  dispose() {}
}

/** 带一段脚本的场景；`fx` 绑在重编译目标上，用来触发重编译。 */
function scriptedBundle(): SceneBundle {
  return {
    ...bundleFor({}),
    general: { postprocess: { level: "disabled" }, bloom: { tint: [1, 1, 1] } },
    bindings: [
      {
        property: "fx",
        target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" },
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

/** 左声道全 0.5、右声道全 0.25，任何分辨率合并出来都一样。 */
const audioFrame = [...Array<number>(64).fill(0.5), ...Array<number>(64).fill(0.25)];
const allZero = (buffers: AudioBuffers) =>
  [buffers.left, buffers.right, buffers.average].every((array) => array.every((value) => value === 0));

describe("SceneHost：壁纸样式与留白", () => {
  const scheme = (value: string) => ({ schemecolor: { type: "color", value } });
  const unbound = (properties: Record<string, unknown>) => ({ ...bundleFor(properties), bindings: [] });

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
    rendererStyle.setStyle.mockReset();
    rendererStyle.setBackground.mockReset();
    rendererStyle.setDisplayScale.mockReset();
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
});

describe("SceneHost：脚本音频订阅", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    compile.mockReset();
    createRealm.mockReset();
    subscribeAudio.mockReset();
    subscribeAudio.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("脚本不注册音频缓冲就不订阅", async () => {
    const { host } = await loadScene(() => {});
    expect(subscribeAudio).not.toHaveBeenCalled();
    expect(host.audio()).toEqual({ subscribed: false, error: null, frames: 0, resolutions: [], peak: 0 });
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

  it("Channel 的 audio 消息写进缓冲，其它类型的消息忽略", async () => {
    const registered: AudioBuffers[] = [];
    const { host } = await loadScene((register) => registered.push(register(16), register(64)));
    const channel = subscribedChannel();

    channel.onmessage({ type: "status", enabled: true });
    channel.onmessage({ type: "timeline", position: 1, duration: 2, data: audioFrame });
    channel.onmessage({ type: "audio" });
    expect(registered.every(allZero)).toBe(true);
    expect(host.audio()).toMatchObject({ frames: 0, peak: 0 });

    channel.onmessage({ type: "audio", data: audioFrame });
    for (const buffers of registered) {
      expect(buffers.left.every((value) => value === 0.5)).toBe(true);
      expect(buffers.right.every((value) => value === 0.25)).toBe(true);
      expect(buffers.average.every((value) => value === 0.375)).toBe(true);
    }
    expect(host.audio()).toMatchObject({ frames: 1, peak: 0.5 });
    host.dispose();
  });

  it("订阅被拒时不报错，缓冲保持全零", async () => {
    subscribeAudio.mockRejectedValue("this wallpaper does not process audio");
    const registered: AudioBuffers[] = [];
    const { host, report } = await loadScene((register) => registered.push(register(32)));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("音频订阅被拒")));
    expect(report.warn).not.toHaveBeenCalled();
    expect(report.error).not.toHaveBeenCalled();
    expect(report.fallback).not.toHaveBeenCalled();
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

  it("重编译保留 realm 与缓冲，不重订，新帧写进原来的数组", async () => {
    const registered: AudioBuffers[] = [];
    const { host, report } = await loadScene((register) => registered.push(register(16)));
    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("重新加载")));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(createRealm).toHaveBeenCalledTimes(1);
    expect(subscribeAudio).toHaveBeenCalledTimes(1);
    subscribedChannel().onmessage({ type: "audio", data: audioFrame });
    expect(registered).toHaveLength(1);
    expect(registered[0].left[0]).toBe(0.5);
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
    channel.onmessage({ type: "audio", data: audioFrame });
    expect(registered[1].left[0]).toBe(0.5);
    // 旧脚本持有的缓冲不再更新
    expect(allZero(registered[0])).toBe(true);
    host.dispose();
  });

  it("宿主销毁后到达的帧不再写缓冲", async () => {
    const registered: AudioBuffers[] = [];
    const { host } = await loadScene((register) => registered.push(register(16)));
    host.dispose();
    subscribedChannel().onmessage({ type: "audio", data: audioFrame });
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
    expect(host.stats).toEqual({ applied: 1, recompiled: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
