import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BindingCollector, generalDefaults } from "./compile/bindings";
import type { SceneBundle, ScenePass } from "./compile/bundle";
import type { SceneFs } from "./compile/fs";
import { compileText } from "./compile/texts";
import { applyScriptValues } from "./dev/scriptValues";
import { SceneState } from "./render/state";
import { createMemoryStorage, SCENE_STORAGE_PREFIX } from "./script/storage";
import { TEXT_DEFAULTS } from "./text/fields";

const events: string[] = [];
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const compile =
  vi.fn<
    (input: {
      userProperties: Record<string, unknown>;
      scriptOverrides: Record<string, number[] | boolean | string>;
    }) => Promise<SceneBundle>
  >();
let renderer: FakeRenderer;
let imports = 0;
let destroyed = 0;
let onError: ((reasons: string[]) => void) | undefined;
let onUpdate: (() => unknown) | null = null;
/** 脚本 `update` 每次收到的参数（写回目标的当前值）。 */
let updateArguments: unknown[] = [];
let onInit: (() => unknown) | null = null;
let activeGlobal: Record<string, unknown>;
/** 新场景里图层 0 的可变 effect 备不好（`GpuScene.prepareVariants` 冻结了它）。 */
let frozen = false;
/** 让 realm 创建 / 模块求值停在半路，用来测并发的重载。 */
let realmGate: Promise<void> | null = null;
let moduleGate: Promise<void> | null = null;
let realmsCreated = 0;
/** 假播放器收到的命令（`<命令>:<对象>:<文件或增益>`），P6a 步骤 2 的声音层用例读。 */
const soundCommands: string[] = [];
/** 渲染器替身的粒子层落点收到的调用（`<方法>:<对象>[:<参数>]`），P4f 步骤 3 的用例读。 */
const particleCalls: string[] = [];

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
function createRealm() {
  activeGlobal = { Object, Array };
  return {
    global: activeGlobal,
    prototypes: { Vec2: {}, Vec3: Vec3.prototype, Vec4: {}, Mat3: {}, Mat4: {} },
    internal: {
      updateScriptProperties(_exports: unknown, vars: string) {
        events.push(`properties:${vars}`);
      },
      convertUserProperties(json: string) {
        return JSON.parse(json);
      },
    },
    async importModule() {
      await moduleGate;
      imports++;
      events.push("evaluate");
      return {
        init() {
          events.push("init");
          return onInit ? onInit() : 0.8;
        },
        applyUserProperties() {
          events.push("apply");
        },
        update(value: unknown) {
          events.push("update");
          updateArguments.push(value);
          return onUpdate ? onUpdate() : 0.6;
        },
        destroy() {
          events.push("destroy");
        },
      };
    },
    dispose() {
      destroyed++;
    },
  };
}

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  paused = false;
  /** 最近一次 `load` 收到的重排器（P6b 1e：宿主交来的 `SceneTexts.relayouter()`）。 */
  relayout: unknown = undefined;
  constructor(private readonly beforeFrame?: (dt: number) => void) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void; relayout?: unknown }) {
    this.relayout = options.relayout;
    this.sceneState = SceneState.fromBundle(bundle);
    if (frozen) this.sceneState.freezeLayer(0);
    options.beforeFirstFrame?.(this.sceneState);
    this.tick();
    events.push("render");
  }
  tick() {
    if (!this.paused) this.beforeFrame?.(1 / 60);
  }
  setStyle() {}
  setBackground() {}
  setPaused(value: boolean) {
    this.paused = value;
  }
  applyBindings(writes: { binding: SceneBundle["bindings"][number]; value: unknown }[]) {
    if (writes.some((write) => this.sceneState?.needsRecompile(write.binding, write.value as number))) return false;
    for (const write of writes) {
      events.push("binding");
      this.sceneState?.write(write.binding, write.value as number);
    }
    return true;
  }
  redraw() {
    events.push("redraw");
  }
  /** 粒子层脚本方法的落点（P4f 步骤 3，`SceneRenderer.particleScript`）：记下每次调用。 */
  particleScript(object: number) {
    const log = (name: string, ...args: unknown[]) =>
      void particleCalls.push(args.length ? `${name}:${object}:${String(args[0])}` : `${name}:${object}`);
    return {
      play: () => log("play"),
      pause: () => log("pause"),
      stop: () => log("stop"),
      isPlaying: () => {
        log("isPlaying");
        return true;
      },
      emitParticles: (count?: unknown) => log("emit", count),
    };
  }
  destroy() {}
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "wpe_scene_target" ? { path: "P:/test", sceneAssets: [] } : "disabled",
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("./compile/client", () => ({ compileSceneInWorker: (input: never) => compile(input) }));
// 声音的播放后端换成记命令的假货：排期器（`audio/scheduler.ts`）与 `SceneSounds` 是真的
vi.mock("./audio/player", () => ({
  ScenePlayer: class {
    voice(object: number) {
      const log = (name: string, value: number) => void soundCommands.push(`${name}:${object}:${value}`);
      return {
        start: (file: number) => log("start", file),
        resume: (file: number) => log("resume", file),
        pause: (file: number) => log("pause", file),
        stop: (file: number) => log("stop", file),
        setGain: (gain: number) => log("gain", gain),
      };
    }
    release() {}
    setActive() {}
    dispose() {}
    probe() {
      return null;
    }
  },
}));
// 文本层（P6b 1e 的用例）：排版要 wasm 与字体，这里不排，渲染器替身不画。`textHost` 记下宿主交来的 `onReady` 与交给渲染器的重排器
const textHost: { onReady: ((object: number) => void) | null; relayouter: object } = { onReady: null, relayouter: {} };
vi.mock("./text/host", () => ({
  SceneTexts: class {
    constructor(options: { onReady?: (object: number) => void }) {
      textHost.onReady = options.onReady ?? null;
    }
    async prepare() {
      return new Map();
    }
    relayouter() {
      return textHost.relayouter;
    }
    dispose() {}
  },
}));
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => {
    realmsCreated++;
    await realmGate;
    return createRealm();
  },
}));
vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async (
      _canvas: unknown,
      options: {
        beforeFrame?: (dt: number) => void;
        onError?: (reasons: string[]) => void;
      },
    ) => {
      onError = options.onError;
      renderer = new FakeRenderer(options.beforeFrame);
      return renderer;
    },
  },
}));

const { SceneHost } = await import("./host");
function bundle(): SceneBundle {
  return {
    general: {
      width: 100,
      height: 100,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: {
        strength: 1,
        threshold: 1,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 1,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 1,
      },
    },
    layers: [
      {
        id: 1,
        object: 0,
        parent: null,
        name: "one",
        origin: [0, 0, 0],
        scale: [1, 1, 1],
        angles: [0, 0, 0],
        size: [1, 1],
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
        passes: [],
        effects: [],
        colorBlendMode: 0,
        passthrough: null,
        particle: null,
      },
    ],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [
      { property: "p", target: { kind: "layer", object: 0, field: "alpha" } },
      { property: "p", target: { kind: "script-property", script: "objects/0/alpha", key: "speed" } },
    ],
    scripts: {
      list: [
        {
          id: "objects/0/alpha",
          source: "script",
          target: { kind: "layer", object: 0, field: "alpha" },
          valueType: "float",
          initial: 1,
          owner: { kind: "layer", object: 0 },
          layer: 0,
          scriptProperties: { speed: 1 },
          imports: [],
          errors: [],
        },
      ],
    },
  } as SceneBundle;
}

const EFFECT_PATH = "objects/0/effects/0/visible";

/** 档位开启的场景：`chain` 是有没有编泛光链，`flag` 是场景位；脚本挂在 general 上，`q` 绑重编译目标。 */
function bloomBundle(chain: boolean, flag: boolean): SceneBundle {
  const result = bundle();
  result.scripts.list[0].owner = { kind: "general" };
  result.general.postprocess = { level: "enabled", bloomFlag: flag, hdrFlag: false, bloom: flag, hdr: false };
  result.bloom = chain ? { hdr: false, passes: {} } : null;
  result.bindings.push({
    property: "q",
    target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" },
  });
  return result;
}

/** 图层 0 带一个可变 effect；脚本挂在它的 `visible` 上，`fx` 属性绑同一个开关，`q` 绑重编译目标。 */
function effectBundle(enabled: boolean, unsupported: string[] = []): SceneBundle {
  const result = bundle();
  result.scripts.list[0].owner = { kind: "effect", object: 0, effect: 0 };
  result.layers[0].effects = [
    {
      source: 0,
      id: 1,
      name: "",
      file: "effects/x/effect.json",
      fbos: [],
      steps: [],
      enabled,
      visibleBound: true,
      unsupported,
    },
  ];
  result.bindings.push(
    { property: "fx", target: { kind: "effect", object: 0, effect: 0 } },
    { property: "q", target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" } },
  );
  return result;
}

function report() {
  return {
    ready: vi.fn(() => events.push("ready")),
    fallback: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("SceneHost 脚本接线", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    events.length = 0;
    imports = 0;
    destroyed = 0;
    onUpdate = null;
    updateArguments = [];
    onInit = null;
    frozen = false;
    realmGate = null;
    moduleGate = null;
    realmsCreated = 0;
    compile.mockReset().mockImplementation(async () => bundle());
  });
  afterEach(() => vi.unstubAllGlobals());

  /** 第一次重载卡在 gate 上时，用「场景后处理」触发第二次重载，等它编译完再放行。 */
  async function overlappingReloads(gate: "realm" | "module") {
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    if (gate === "realm") realmGate = held;
    else moduleGate = held;
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(realmsCreated).toBe(1));
    await new Promise((resolve) => setTimeout(resolve));
    listeners.get("setting-change")!({ payload: { wpeScenePostprocess: "enabled" } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve));
    open();
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalled());
    return host;
  }

  it.each(["realm", "module"] as const)("%s 还在加载时再来一次重载，脚本环境只建一个、init 只跑一次", async (gate) => {
    const host = await overlappingReloads(gate);
    expect(realmsCreated).toBe(1);
    expect(imports).toBe(1);
    expect(events.filter((event) => event === "init")).toHaveLength(1);
    // init 在首帧之前：第二次重载没有抢在脚本加载完之前进入渲染
    expect(events.indexOf("init")).toBeLessThan(events.indexOf("render"));
    host.dispose();
    expect(destroyed).toBe(1);
  });

  it("加载、增量、暂停和销毁按生命周期执行", async () => {
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(events).toEqual([
      "evaluate",
      'properties:{"speed":1}',
      "init",
      'properties:{"speed":0.3}',
      "apply",
      "update",
      "render",
      "ready",
    ]);
    expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.6);
    events.length = 0;
    host.applyUserProperties({ p: { type: "slider", value: 0.4 } });
    expect(events).toEqual(["binding", 'properties:{"speed":0.4}', "apply"]);
    expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.4);
    renderer.tick();
    expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.6);
    host.setPaused(true);
    events.length = 0;
    renderer.tick();
    expect(events).toEqual([]);
    host.dispose();
    expect(events).toContain("destroy");
    expect(destroyed).toBe(1);
    expect(imports).toBe(1);
  });

  it("退回后停止脚本，恢复沿用 realm 并重放写入", async () => {
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    onError?.(["test:fallback"]);
    events.length = 0;
    renderer.tick();
    expect(events).toEqual([]);
    host.applyUserProperties({ p: { type: "slider", value: 0.4 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.devScene.renderer).not.toBeNull());
    expect(imports).toBe(1);
    expect(host.readTarget("objects/0/alpha")).toBe(0.6);
    host.dispose();
  });

  it("脚本重编译目标去重，并合并在途变化", async () => {
    let finishSecond!: () => void;
    let calls = 0;
    compile.mockImplementation(async () => {
      calls++;
      if (calls === 2)
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (calls > 3) await new Promise(() => {});
      const result = bundle();
      result.scripts.list[0].owner = { kind: "general" };
      return result;
    });
    let hdr = true;
    onUpdate = () => {
      (activeGlobal.thisObject as { hdr: boolean }).hdr = hdr;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    renderer.tick();
    expect(compile).toHaveBeenCalledTimes(2);
    hdr = false;
    renderer.tick();
    expect(compile).toHaveBeenCalledTimes(2);
    finishSecond();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect(compile.mock.calls[2][0].scriptOverrides["general/hdr"]).toBe(false);
    expect(imports).toBe(1);
    host.dispose();
  });

  it("effect 开关：脚本读写走状态，不重编译（3c）", async () => {
    compile.mockImplementation(async () => effectBundle(false));
    const seen: boolean[] = [];
    let value = true;
    onUpdate = () => {
      const object = activeGlobal.thisObject as { visible: boolean };
      seen.push(object.visible);
      object.visible = value;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(seen).toEqual([false]);
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(true);
    renderer.tick();
    expect(seen).toEqual([false, true]);
    value = false;
    renderer.tick();
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    host.dispose();
  });

  it("effect 开关：属性就地写，不重编译；用户值盖掉脚本写过的值（3c）", async () => {
    compile.mockImplementation(async () => effectBundle(true));
    onUpdate = () => {};
    onInit = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = false;
      return undefined;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({
      p: { type: "slider", value: 0.3 },
      fx: { type: "bool", value: true },
      q: { type: "bool", value: false },
    });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false);
    const applied = host.stats.applied;
    host.applyUserProperties({ fx: { type: "bool", value: false } });
    host.applyUserProperties({ fx: { type: "bool", value: true } });
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(true);
    expect(host.stats.applied).toBe(applied + 2);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    // 脚本的写入已被用户值盖掉：重编译之后不再重放
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(true));
    host.dispose();
  });

  it("重编译后 replayWrites 把脚本写过的开关放回新状态，覆盖表不记（3c）", async () => {
    compile.mockImplementation(async () => effectBundle(true));
    onUpdate = () => {};
    onInit = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = false;
      return undefined;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, q: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const first = renderer.sceneState;
    expect(first?.effectEnabled(0, 0)).toBe(false);
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renderer.sceneState).not.toBe(first));
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false);
    expect(compile.mock.calls[1][0].scriptOverrides).toEqual({});
    host.dispose();
  });

  it("脚本打开带不支持项的 effect：重编译一次，scriptOverrides 带脚本的值（3c）", async () => {
    compile.mockImplementation(async (input) => {
      const opened = input.scriptOverrides?.[EFFECT_PATH] === true;
      const result = effectBundle(opened, ["effect:custom:custom"]);
      return { ...result, unsupported: opened ? ["effect:custom:custom"] : [] };
    });
    const seen: boolean[] = [];
    onUpdate = () => {
      const object = activeGlobal.thisObject as { visible: boolean };
      seen.push(object.visible);
      object.visible = true;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(seen[0]).toBe(false);
    expect(compile.mock.calls[0][0].scriptOverrides).toEqual({});
    expect(compile.mock.calls[1][0].scriptOverrides[EFFECT_PATH]).toBe(true);
    await vi.waitFor(() => expect(reporter.fallback).toHaveBeenCalledWith(["effect:custom:custom"]));
    expect(compile).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("脚本每帧写带不支持项的 effect：编译还没回来时不重复请求（3c）", async () => {
    let finishSecond!: () => void;
    let calls = 0;
    compile.mockImplementation(async () => {
      calls++;
      if (calls === 2)
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (calls > 3) await new Promise(() => {});
      return effectBundle(false, ["effect:custom:custom"]);
    });
    onUpdate = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = true;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    renderer.tick();
    renderer.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(2);
    finishSecond();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("属性打开带不支持项的 effect：整场重编译，原因写明被挡下的路径与不支持项（3c）", async () => {
    compile.mockImplementation(async (input) => {
      const opened = input.userProperties.fx === true;
      const result = effectBundle(opened, ["effect:custom:custom"]);
      return { ...result, unsupported: opened ? ["effect:custom:custom"] : [] };
    });
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, fx: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    host.applyUserProperties({ fx: { type: "bool", value: true } });
    await vi.waitFor(() => expect(reporter.fallback).toHaveBeenCalledWith(["effect:custom:custom"]));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(host.stats.applied).toBe(0);
    expect(host.stats.recompiled).toEqual([{ reason: `effect-blocked（${EFFECT_PATH}）`, keys: ["fx"] }]);
    expect(reporter.debug).toHaveBeenCalledWith(expect.stringContaining("不支持项：effect:custom:custom"));
    host.dispose();
  });

  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("冻结的图层：属性开关走整场重编译，新值由编译给出（3c）", async () => {
    frozen = true;
    compile.mockImplementation(async (input) => effectBundle(input.userProperties.fx === true));
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, fx: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const first = renderer.sceneState;
    host.applyUserProperties({ fx: { type: "bool", value: true } });
    await vi.waitFor(() => expect(renderer.sceneState).not.toBe(first));
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(true);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(host.stats.applied).toBe(0);
    expect(host.stats.recompiled).toEqual([{ reason: `effect-blocked（${EFFECT_PATH}）`, keys: ["fx"] }]);
    // 关回去同样重编译：冻结的图层开和关都不走就地
    const second = renderer.sceneState;
    host.applyUserProperties({ fx: { type: "bool", value: false } });
    await vi.waitFor(() => expect(renderer.sceneState).not.toBe(second));
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false);
    expect(compile).toHaveBeenCalledTimes(3);
    await settled();
    expect(compile).toHaveBeenCalledTimes(3);
    expect(reporter.fallback).not.toHaveBeenCalled();
    host.dispose();
  });

  it("冻结的图层：脚本逐帧写同一个值只重编译一次，值变了再来一次（3c）", async () => {
    frozen = true;
    let calls = 0;
    compile.mockImplementation(async (input) => {
      calls++;
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (calls > 4) await new Promise(() => {});
      return effectBundle(input.scriptOverrides?.[EFFECT_PATH] === true);
    });
    let value = true;
    onUpdate = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = value;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[0][0].scriptOverrides).toEqual({});
    expect(compile.mock.calls[1][0].scriptOverrides[EFFECT_PATH]).toBe(true);
    await vi.waitFor(() => expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(true));
    renderer.tick();
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(2);
    value = false;
    renderer.tick();
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect(compile.mock.calls[2][0].scriptOverrides[EFFECT_PATH]).toBe(false);
    await vi.waitFor(() => expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false));
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(3);
    expect(reporter.fallback).not.toHaveBeenCalled();
    host.dispose();
  });

  it("冻结的图层：编译没采用脚本的值时（如开关绑了用户属性）也不循环（3c）", async () => {
    frozen = true;
    let calls = 0;
    compile.mockImplementation(async () => {
      calls++;
      if (calls > 4) await new Promise(() => {});
      return effectBundle(false);
    });
    onUpdate = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = true;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await settled();
    renderer.tick();
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(renderer.sceneState?.effectEnabled(0, 0)).toBe(false);
    expect(reporter.fallback).not.toHaveBeenCalled();
    host.dispose();
  });

  it("thisScene.bloom：有链时就地改位，不重新加载；readTarget 读到开关与各字段", async () => {
    compile.mockImplementation(async () => bloomBundle(true, true));
    const scene = () => activeGlobal.thisScene as { bloom: boolean };
    const seen: boolean[] = [];
    let value = false;
    onUpdate = () => {
      seen.push(scene().bloom);
      scene().bloom = value;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(seen).toEqual([true]);
    expect(renderer.sceneState?.bloomEnabled).toBe(false);
    expect(host.readTarget("general/bloom")).toBe(false);
    value = true;
    renderer.tick();
    expect(seen).toEqual([true, false]);
    expect(renderer.sceneState?.bloomEnabled).toBe(true);
    expect(host.readTarget("general/bloom")).toBe(true);
    await settled();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    host.dispose();
  });

  it("{script} 挂在 general.bloom 上：update 收到当前的位，返回值写回", async () => {
    compile.mockImplementation(async () => {
      const result = bloomBundle(true, false);
      result.bindings.push({ property: "b", target: { kind: "bloom-enabled" } });
      Object.assign(result.scripts.list[0], {
        id: "general/bloom",
        target: { kind: "bloom-enabled" },
        valueType: "bool",
        initial: false,
      });
      return result;
    });
    let returned: boolean | undefined;
    onUpdate = () => returned;
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, b: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    host.applyUserProperties({ b: { type: "bool", value: true } });
    updateArguments = [];
    renderer.tick();
    // 读的是状态，不是 JSON 里的初始值
    expect(updateArguments).toEqual([true]);
    returned = false;
    renderer.tick();
    expect(renderer.sceneState?.bloomEnabled).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("readTarget 按 general/bloom/<字段> 直接取值", async () => {
    compile.mockImplementation(async () => bloomBundle(true, true));
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const { bloom } = renderer.sceneState!;
    Object.assign(bloom, { hdrStrength: 3, hdrIterations: 5, tint: [1, 0, 0] });
    expect(host.readTarget("general/bloom/hdrStrength")).toBe(3);
    expect(host.readTarget("general/bloom/hdrIterations")).toBe(5);
    expect(host.readTarget("general/bloom/tint")).toEqual([1, 0, 0]);
    expect(host.readTarget("general/bloom/strength")).toBe(bloom.strength);
    expect(host.readTarget("general/bloom/nope")).toBeNull();
    host.dispose();
  });

  describe("general 字段", () => {
    /** 脚本挂在 general 上；`c` 绑清屏色（就地），`h` 绑 hdr（保留重编译）。 */
    function generalBundle(script: Partial<SceneBundle["scripts"]["list"][number]> = {}): SceneBundle {
      const result = bundle();
      Object.assign(result.scripts.list[0], { owner: { kind: "general" } }, script);
      result.bindings.push(
        { property: "c", target: { kind: "general", key: "clearcolor" } },
        { property: "h", target: { kind: "recompile", reason: "postprocess-hdr", path: "general.hdr" } },
      );
      return result;
    }
    const scene = () => activeGlobal.thisScene as Record<string, unknown>;

    async function start() {
      const reporter = report();
      const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
      host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
      await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
      return host;
    }
    /** 改 `h` 触发一次整场重编译，等新状态换上。 */
    async function recompile(host: InstanceType<typeof SceneHost>) {
      const compiles = compile.mock.calls.length;
      const renders = events.filter((event) => event === "render").length;
      host.applyUserProperties({ h: { type: "bool", value: true } });
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(compiles + 1));
      await vi.waitFor(() => expect(events.filter((event) => event === "render")).toHaveLength(renders + 1));
    }

    it("脚本写 thisScene：同一帧进状态，不重新加载，不算重编译写入；readTarget 读得到", async () => {
      compile.mockImplementation(async () => generalBundle());
      onUpdate = () => {
        Object.assign(scene(), { clearcolor: new Vec3(1, 0, 0), clearenabled: false, fov: 33 });
      };
      const host = await start();
      expect(renderer.sceneState?.general).toMatchObject({ clearcolor: [1, 0, 0], clearenabled: false, fov: 33 });
      expect(host.readTarget("general/clearcolor")).toEqual([1, 0, 0]);
      expect(host.readTarget("general/clearenabled")).toBe(false);
      expect(host.readTarget("general/fov")).toBe(33);
      expect(host.readTarget("general/nope")).toBeNull();
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      expect(host.stats.recompiled).toEqual([]);
      expect((host.scriptDiagnostics as { recompileWrites: number }[])[0].recompileWrites).toBe(0);
      host.dispose();
    });

    it("属性绑 general 字段：就地写，applied 增加，不重新加载", async () => {
      compile.mockImplementation(async () => generalBundle());
      onUpdate = () => undefined;
      const host = await start();
      const { applied } = host.stats;
      host.applyUserProperties({ c: { type: "color", value: "0 1 0" } });
      expect(renderer.sceneState?.general.clearcolor).toEqual([0, 1, 0]);
      expect(host.stats.applied).toBe(applied + 1);
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      host.dispose();
    });

    it.each<[string, Partial<SceneBundle["scripts"]["list"][number]>, unknown, string, unknown]>([
      ["vec3", { valueType: "vec3", initial: "0 0 0" }, new Vec3(1, 0.5, 0), "clearcolor", [1, 0.5, 0]],
      ["bool", { valueType: "bool", initial: true }, false, "clearenabled", false],
      ["float", { valueType: "float", initial: 50 }, 33, "fov", 33],
    ])("{script} 挂在字段上（%s）：update 收到当前值，返回值写回", async (_name, shape, returned, key, stored) => {
      compile.mockImplementation(async () =>
        generalBundle({
          ...shape,
          id: `general/${key}`,
          target: { kind: "general", key: key as "clearcolor" },
        }),
      );
      onUpdate = () => returned;
      const host = await start();
      expect(renderer.sceneState?.general[key as "clearcolor"]).toEqual(stored);
      updateArguments = [];
      renderer.tick();
      expect(updateArguments).toEqual([returned]);
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      host.dispose();
    });

    it("API 写过的字段在 hdr 重编译后重放", async () => {
      compile.mockImplementation(async () => generalBundle());
      onUpdate = () => {
        Object.assign(scene(), { ambientcolor: new Vec3(0.2, 0.3, 0.4), clearenabled: false, fov: 33 });
        onUpdate = () => undefined;
      };
      const host = await start();
      const before = renderer.sceneState;
      await recompile(host);
      expect(renderer.sceneState).not.toBe(before);
      expect(renderer.sceneState?.general).toMatchObject({
        ambientcolor: [0.2, 0.3, 0.4],
        clearenabled: false,
        fov: 33,
      });
      expect(imports).toBe(1);
      host.dispose();
    });

    it("{script} 的返回值在 hdr 重编译后重放", async () => {
      compile.mockImplementation(async () =>
        generalBundle({
          id: "general/clearcolor",
          target: { kind: "general", key: "clearcolor" },
          valueType: "vec3",
          initial: "0 0 0",
        }),
      );
      onUpdate = () => {
        onUpdate = () => undefined;
        return new Vec3(1, 0, 0);
      };
      const host = await start();
      await recompile(host);
      expect(renderer.sceneState?.general.clearcolor).toEqual([1, 0, 0]);
      host.dispose();
    });

    it("用户属性改过的字段：脚本的旧写入不再重放（`targetKey` 与 `targetPath` 一致）", async () => {
      compile.mockImplementation(async () => generalBundle());
      onUpdate = () => {
        Object.assign(scene(), { clearcolor: new Vec3(1, 0, 0), fov: 33 });
        onUpdate = () => undefined;
      };
      const host = await start();
      host.applyUserProperties({ c: { type: "color", value: "0 1 0" } });
      await recompile(host);
      // 编译结果由替身给出（缺省值）：重放了脚本的写入就会是 1 0 0。没被用户改过的 fov 照常重放
      expect(renderer.sceneState?.general.clearcolor).toEqual([0, 0, 0]);
      expect(renderer.sceneState?.general.fov).toBe(33);
      host.dispose();
    });
  });

  describe("文本字段（P6b 1e）", () => {
    /**
     * 图层 0 是文本层（编译期文字 "Song Title"），脚本挂在它的 `text` 上；`t` 绑同一个文本字段（手写：1e-2 才由 `compileText` 登记），
     * `h` 绑 hdr（重编译）。
     */
    function textBundle(script: Partial<SceneBundle["scripts"]["list"][number]> = {}): SceneBundle {
      const result = bundle();
      const pass = (key: string) => ({ key, program: null, uniforms: {} }) as unknown as ScenePass;
      result.layers[0].text = {
        fields: { ...TEXT_DEFAULTS, padding: [32, 32], spacing: [0, 0], text: "Song Title" },
        font: { path: "fonts/a.ttf", location: null, size: null },
        glyphPass: pass("objects/0/text/glyphs"),
        colorPass: pass("objects/0/text/color"),
        backgroundPass: null,
        clearAlphaPass: null,
        background: { key: "objects/0/text/background", color: [0, 0, 0] },
      };
      Object.assign(
        result.scripts.list[0],
        {
          id: "objects/0/text",
          target: { kind: "text", object: 0, field: "text" },
          valueType: "string",
          initial: "Song Title",
          scriptProperties: null,
        },
        script,
      );
      result.bindings.push(
        { property: "t", target: { kind: "text", object: 0, field: "text" } },
        { property: "h", target: { kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" } },
      );
      return result;
    }
    const fields = () => renderer.sceneState!.textFields.get(0)!;

    async function start() {
      onInit = () => undefined;
      const reporter = report();
      const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
      host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
      await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
      return host;
    }
    /** 改 `h` 触发一次整场重编译，等新状态换上。 */
    async function recompile(host: InstanceType<typeof SceneHost>) {
      const compiles = compile.mock.calls.length;
      const renders = events.filter((event) => event === "render").length;
      host.applyUserProperties({ h: { type: "bool", value: true } });
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(compiles + 1));
      await vi.waitFor(() => expect(events.filter((event) => event === "render")).toHaveLength(renders + 1));
    }

    it("字段脚本返回字符串：当帧进 textFields、标脏；update 收到当前文字（不是 Vec2）；不重编译", async () => {
      compile.mockImplementation(async () => textBundle());
      let n = 0;
      onUpdate = () => `F${++n}`;
      const host = await start();
      expect(updateArguments).toEqual(["Song Title"]);
      expect(fields().text).toBe("F1");
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set([0]));
      updateArguments = [];
      renderer.tick();
      expect(updateArguments).toEqual(["F1"]);
      expect(fields().text).toBe("F2");
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      expect(host.stats.recompiled).toEqual([]);
      host.dispose();
    });

    it("返回值按 ToString 写：数字转字符串，null 不写，同值不标脏", async () => {
      compile.mockImplementation(async () => textBundle());
      const results: unknown[] = [12, null, "12"];
      onUpdate = () => results.shift();
      const host = await start();
      expect(fields().text).toBe("12");
      renderer.sceneState!.takeDirty();
      renderer.tick();
      renderer.tick();
      expect(fields().text).toBe("12");
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set());
      host.dispose();
    });

    it("数字键（maxwidth）：update 收到当前值，返回值写回", async () => {
      compile.mockImplementation(async () =>
        textBundle({
          id: "objects/0/maxwidth",
          target: { kind: "text", object: 0, field: "maxwidth" },
          valueType: "float",
          initial: 300,
        }),
      );
      onUpdate = () => 250.5;
      const host = await start();
      expect(updateArguments).toEqual([TEXT_DEFAULTS.maxwidth]);
      expect(fields().maxwidth).toBe(250.5);
      host.dispose();
    });

    it("重编译后重放脚本写过的字符串", async () => {
      compile.mockImplementation(async () => textBundle());
      onUpdate = () => {
        onUpdate = () => undefined;
        return "Hello";
      };
      const host = await start();
      expect(fields().text).toBe("Hello");
      const before = renderer.sceneState;
      await recompile(host);
      expect(renderer.sceneState).not.toBe(before);
      expect(fields().text).toBe("Hello");
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set([0]));
      host.dispose();
    });

    it("属性写文本目标：就地写、不重编译；用户值盖掉脚本的旧写入，重编译后不再重放（键一致）", async () => {
      compile.mockImplementation(async () => textBundle());
      onUpdate = () => {
        onUpdate = () => undefined;
        return "Script";
      };
      const host = await start();
      const { applied } = host.stats;
      host.applyUserProperties({ t: { type: "textinput", value: "User" } });
      expect(fields().text).toBe("User");
      expect(host.stats.applied).toBe(applied + 1);
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      await recompile(host);
      // 编译结果由替身给出（"Song Title"）：重放了脚本的写入就会是 "Script"
      expect(fields().text).toBe("Song Title");
      host.dispose();
    });

    it("dev 探针的脚本值（P6b 1e-3）：同一个返回值经探针写进的文本字段与字段脚本写回的相同", async () => {
      const maxwidth = {
        id: "objects/0/maxwidth",
        target: { kind: "text", object: 0, field: "maxwidth" },
        valueType: "float",
        initial: 300,
      } as const;
      // [字段, 脚本返回值, 探针收的值]：字符串原样；`text` 收数时 ToString、收布尔转字符串（属性侧不写）；数字键原样
      const cases: ["text" | "maxwidth", unknown, string | boolean | number[], Partial<typeof maxwidth>][] = [
        ["text", "F183", "F183", {}],
        ["text", 12, [12], {}],
        ["text", true, true, {}],
        ["maxwidth", 250.5, [250.5], maxwidth],
      ];
      for (const [field, returned, probeValue, script] of cases) {
        compile.mockImplementation(async () => textBundle(script));
        onUpdate = () => returned;
        const host = await start();
        const viaHost = { ...fields() };
        host.dispose();
        const bundle = textBundle(script);
        const state = SceneState.fromBundle(bundle);
        const [result] = applyScriptValues(state, bundle, [{ object: 0, field, value: probeValue }]);
        expect(result.applied, `${field} ${JSON.stringify(returned)}`).toBe(true);
        expect(state.textFields.get(0), `${field} ${JSON.stringify(returned)}`).toEqual(viaHost);
        expect(viaHost[field], `${field} ${JSON.stringify(returned)}`).not.toEqual(
          textBundle(script).layers[0].text!.fields[field],
        );
      }
    });

    it("compileText 登记的绑定（P6b 1e-2）：属性改 text、pointsize 就地写、不重编译；改 font 照旧重编译", async () => {
      // 绑定由真 `compileText` 登记（宿主材质与字体位置用替身），换进替身 bundle
      const collector = new BindingCollector();
      await compileText(
        0,
        {
          text: { user: "t", value: "Song Title" },
          pointsize: { user: "s", value: 20 },
          font: { user: "f", value: "fonts/a.ttf" },
        },
        {
          fs: { resolve: async () => null } as unknown as SceneFs,
          properties: {},
          bindings: collector,
          hdr: false,
          visibleEffects: 0,
          colorBlendMode: 0,
          mayComposite: false,
          hostPass: async (_path, key) => ({ key, program: null, uniforms: {} }) as unknown as ScenePass,
          unsupported: new Set(),
        },
      );
      compile.mockImplementation(async () => {
        const result = textBundle();
        result.bindings = [...collector.list];
        return result;
      });
      onUpdate = () => undefined;
      const host = await start();
      const { applied } = host.stats;
      host.applyUserProperties({ t: { type: "textinput", value: "User" } });
      host.applyUserProperties({ s: { type: "slider", value: 48 } });
      expect([fields().text, fields().pointsize]).toEqual(["User", 48]);
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set([0]));
      expect(host.stats.applied).toBe(applied + 2);
      await settled();
      expect(compile).toHaveBeenCalledTimes(1);
      expect(host.stats.recompiled).toEqual([]);
      // font 照旧整场重编译（1e 已定 3）
      host.applyUserProperties({ f: { type: "combo", value: "fonts/b.ttf" } });
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
      expect(host.stats.recompiled).toHaveLength(1);
      host.dispose();
    });

    it("运行中重排的接线（P6b 1e-2）：重排器交给渲染器；字体读完（onReady）把那一层标脏，暂停时补画一帧", async () => {
      compile.mockImplementation(async () => textBundle());
      onUpdate = () => undefined;
      const host = await start();
      expect(renderer.relayout === textHost.relayouter).toBe(true);
      renderer.sceneState!.takeDirty();
      events.length = 0;
      textHost.onReady!(0);
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set([0]));
      expect(events).toEqual([]);
      host.setPaused(true);
      events.length = 0;
      textHost.onReady!(0);
      expect(events).toEqual(["redraw"]);
      // 不是文本层的对象（场景已换）：不标脏
      textHost.onReady!(7);
      expect(renderer.sceneState!.takeDirty().texts).toEqual(new Set([0]));
      host.dispose();
      // 销毁之后什么都不做
      events.length = 0;
      textHost.onReady!(0);
      expect(events).toEqual([]);
    });
  });

  it("被挡下的写入按 effect / 泛光分标签", async () => {
    compile.mockImplementation(async () => {
      const result = bloomBundle(false, false);
      result.bindings.push({ property: "b", target: { kind: "bloom-enabled" } });
      return result;
    });
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, b: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    host.applyUserProperties({ b: { type: "bool", value: true } });
    expect(host.stats.recompiled).toEqual([{ reason: "bloom-missing（general/bloom）", keys: ["b"] }]);
    expect(reporter.debug).toHaveBeenCalledWith(expect.stringContaining("bloom-missing（general/bloom）"));
    host.dispose();
  });

  it.each<[string, boolean, boolean, boolean, string]>([
    ["有链开着", true, true, false, "（泛光）"],
    ["有链关着", true, false, false, "（泛光（关））"],
    ["HDR 开着", true, true, true, "（泛光 + HDR）"],
    ["HDR 关着", true, false, true, "（泛光（关） + HDR）"],
    ["没有链", false, false, false, "（无泛光）"],
  ])("后处理日志：%s", async (_name, chain, flag, hdr, label) => {
    compile.mockImplementation(async () => {
      const result = bloomBundle(chain, flag);
      if (result.bloom) result.bloom.hdr = hdr;
      return result;
    });
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining(`后处理 enabled${label}`));
    host.dispose();
  });

  it("thisScene.bloom：档位允许但没有链时打开，只重新加载一次，新 bundle 有链且开着", async () => {
    let calls = 0;
    compile.mockImplementation(async (input) => {
      calls++;
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (calls > 3) await new Promise(() => {});
      const opened = input.scriptOverrides?.["general/bloom"] === true;
      return bloomBundle(opened, opened);
    });
    const readBack: boolean[] = [];
    onUpdate = () => {
      const scene = activeGlobal.thisScene as { bloom: boolean };
      scene.bloom = true;
      readBack.push(scene.bloom);
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[0][0].scriptOverrides).toEqual({});
    expect(compile.mock.calls[1][0].scriptOverrides).toEqual({ "general/bloom": true });
    await vi.waitFor(() => expect(renderer.sceneState?.bloomEnabled).toBe(true));
    renderer.tick();
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(host.stats.recompiled).toEqual([{ reason: "script（general/bloom）", keys: [] }]);
    // 写完当场读回，重编译完成之前也是（K5）
    expect(readBack.length).toBeGreaterThan(0);
    expect(readBack.every(Boolean)).toBe(true);
    expect(reporter.fallback).not.toHaveBeenCalled();
    host.dispose();
  });

  it("thisScene.bloom：没有链时写 false 是同值，不重新加载", async () => {
    compile.mockImplementation(async () => bloomBundle(false, false));
    onUpdate = () => {
      (activeGlobal.thisScene as { bloom: boolean }).bloom = false;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("重编译后 replayWrites 恢复脚本写的 bloom 位，覆盖表不记", async () => {
    compile.mockImplementation(async () => bloomBundle(true, true));
    onUpdate = () => {};
    onInit = () => {
      (activeGlobal.thisScene as { bloom: boolean }).bloom = false;
      return undefined;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, q: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const first = renderer.sceneState;
    expect(first?.bloomEnabled).toBe(false);
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renderer.sceneState).not.toBe(first));
    expect(renderer.sceneState?.bloomEnabled).toBe(false);
    expect(compile.mock.calls[1][0].scriptOverrides).toEqual({});
    host.dispose();
  });

  it("属性改 bloom：就地写，用户值盖掉脚本写过的值，重编译后不再重放", async () => {
    compile.mockImplementation(async () => {
      const result = bloomBundle(true, true);
      result.bindings.push({ property: "b", target: { kind: "bloom-enabled" } });
      return result;
    });
    onUpdate = () => {};
    onInit = () => {
      (activeGlobal.thisScene as { bloom: boolean }).bloom = false;
      return undefined;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({
      p: { type: "slider", value: 0.3 },
      b: { type: "bool", value: false },
      q: { type: "bool", value: false },
    });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(renderer.sceneState?.bloomEnabled).toBe(false);
    const applied = host.stats.applied;
    host.applyUserProperties({ b: { type: "bool", value: true } });
    expect(renderer.sceneState?.bloomEnabled).toBe(true);
    expect(host.stats.applied).toBe(applied + 1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    const first = renderer.sceneState;
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(renderer.sceneState).not.toBe(first));
    // bundle 的 bloomFlag 恒为 true：脚本的 false 不再重放
    expect(renderer.sceneState?.bloomEnabled).toBe(true);
    host.dispose();
  });

  it("thisScene.hdr：写的值等于场景位时不重新加载，不同才重新加载（渲染是 LDR 也一样）", async () => {
    let calls = 0;
    compile.mockImplementation(async (input) => {
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (++calls > 3) await new Promise(() => {});
      const result = bloomBundle(false, false);
      // ctl-nobloom：`bloom: false`、`hdr: true`，场景位 true，渲染是 LDR
      const hdrFlag = input.scriptOverrides?.["general/hdr"] !== false;
      result.general.postprocess = { level: "ultra", bloomFlag: false, hdrFlag, bloom: false, hdr: false };
      return result;
    });
    let value = true;
    onUpdate = () => {
      (activeGlobal.thisScene as { hdr: boolean }).hdr = value;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(1);
    value = false;
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[1][0].scriptOverrides).toEqual({ "general/hdr": false });
    await settled();
    renderer.tick();
    await settled();
    expect(compile).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("general/hdr 属性绑定与脚本写入都走整场重编译（已定，与 WPE 不同）", async () => {
    let calls = 0;
    compile.mockImplementation(async () => {
      if (++calls > 3) await new Promise(() => {});
      const result = bloomBundle(true, true);
      result.bindings.push({
        property: "h",
        target: { kind: "recompile", reason: "postprocess-hdr", path: "general.hdr" },
      });
      return result;
    });
    onUpdate = () => {
      (activeGlobal.thisObject as { hdr: boolean }).hdr = true;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, h: { type: "bool", value: false } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[1][0].scriptOverrides).toEqual({ "general/hdr": true });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalled());
    await settled();
    expect(compile).toHaveBeenCalledTimes(2);
    host.applyUserProperties({ h: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect(host.stats.recompiled).toEqual([
      { reason: "script（general/hdr）", keys: [] },
      { reason: "postprocess-hdr（general.hdr）", keys: ["h"] },
    ]);
    host.dispose();
  });

  it("重编译重放 API 直接写入，用户绑定覆盖后保留用户值", async () => {
    onUpdate = () => {};
    onInit = () => {
      (activeGlobal.thisLayer as { alpha: number }).alpha = 0.2;
      return undefined;
    };
    compile.mockImplementation(async (input: { userProperties: Record<string, unknown> }) => {
      const result = bundle();
      result.layers[0].alpha = Number(input.userProperties.p);
      result.bindings.push({
        property: "q",
        target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" },
      });
      return result;
    });
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, q: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.2);
    host.setPaused(true);
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.2));
    host.applyUserProperties({ p: { type: "slider", value: 0.4 } });
    host.applyUserProperties({ q: { type: "bool", value: false } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(renderer.sceneState?.layers.get(0)?.alpha).toBe(0.4));
    expect(events.filter((value) => value === "init")).toHaveLength(1);
    host.dispose();
  });

  describe("声音层（P6a 步骤 2）", () => {
    /** 图层 1 是声音对象（一个文件、loop、volume 1）；脚本挂在它的 `volume` 上（字段脚本写回到 sound 目标）。 */
    function soundBundle(): SceneBundle {
      const result = bundle();
      result.layers.push({ ...result.layers[0], id: 2, object: 1, name: "music" });
      result.sounds = [
        {
          object: 1,
          files: [{ path: "a.wav", location: { path: "P:/test/a.wav", offset: 0 }, size: null }],
          mode: "loop",
          mintime: 1,
          maxtime: 5,
          startSilent: false,
          volume: 1,
        },
      ];
      result.bindings = [{ property: "p", target: { kind: "layer", object: 0, field: "alpha" } }];
      result.scripts.list[0] = {
        ...result.scripts.list[0],
        id: "objects/1/volume",
        target: { kind: "sound", object: 1, field: "volume" },
        owner: { kind: "layer", object: 1 },
        layer: 1,
        scriptProperties: null,
      };
      return result;
    }
    type SoundLayer = { play(): void; pause(): void; stop(): void; isPlaying(): boolean; volume: number };

    async function start() {
      soundCommands.length = 0;
      compile.mockImplementation(async () => soundBundle());
      const reporter = report();
      const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
      host.setHostVolume(1);
      host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
      await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
      const volume = () => host.sounds().sounds[0].volume;
      return { host, volume };
    }

    it("volume 的字段脚本：init 与 update 的返回值写回、当场交给排期器（增益 = volume²）", async () => {
      onUpdate = () => 0.5;
      const { host, volume } = await start();
      expect(volume()).toBe(0.5);
      expect(host.readTarget("objects/1/volume")).toBe(0.5);
      // init 的 0.8 在首帧前就交给了排期器
      expect(soundCommands).toContain(`gain:1:${0.8 * 0.8}`);
      expect(soundCommands.at(-1)).toBe("gain:1:0.25");
      onUpdate = () => 0.25;
      renderer.tick();
      // 渲染器的对象步进在假渲染器里不跑：值只能是脚本写入当场同步过去的
      expect(volume()).toBe(0.25);
      expect(soundCommands.at(-1)).toBe(`gain:1:${0.25 * 0.25}`);
      host.dispose();
    });

    it("API：play / pause / stop / isPlaying 接到排期器，volume 写入当场生效，暂停时也生效", async () => {
      let music: SoundLayer | null = null;
      onInit = () => {
        music = activeGlobal.thisLayer as SoundLayer;
        return null;
      };
      onUpdate = () => null;
      const { host, volume } = await start();
      const layer = music! as SoundLayer;
      expect(soundCommands).toEqual(["gain:1:1", "start:1:0"]);
      expect(layer.isPlaying()).toBe(true);
      expect(layer.volume).toBe(1);
      // 脚本暂停 → 续播
      layer.pause();
      expect(layer.isPlaying()).toBe(false);
      layer.play();
      expect(soundCommands.slice(-2)).toEqual(["pause:1:0", "resume:1:0"]);
      // 宿主暂停（全局音量 0）时写 volume：值当场进排期器，不等帧
      host.setPaused(true);
      layer.volume = 0.5;
      expect(volume()).toBe(0.5);
      expect(layer.volume).toBe(0.5);
      // stop 停掉并回到开头；暂停中 play 不出声（音量为 0 的 P），恢复时从头开始
      layer.stop();
      expect(layer.isPlaying()).toBe(false);
      layer.play();
      expect(soundCommands.slice(-2)).toEqual(["gain:1:0", "stop:1:0"]);
      host.setPaused(false);
      expect(soundCommands.slice(-3)).toEqual(["gain:1:0.25", "start:1:0", "gain:1:0.25"]);
      expect(layer.isPlaying()).toBe(true);
      host.dispose();
    });
  });

  it("暂停时就地写属性补画一帧，排在脚本回调之后；不暂停或要重编译时不补画", async () => {
    compile.mockImplementation(async () => {
      const result = bundle();
      result.bindings.push({
        property: "q",
        target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" },
      });
      return result;
    });
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 }, q: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    events.length = 0;
    host.applyUserProperties({ p: { type: "slider", value: 0.4 } });
    expect(events).toEqual(["binding", 'properties:{"speed":0.4}', "apply"]);
    host.setPaused(true);
    events.length = 0;
    host.applyUserProperties({ p: { type: "slider", value: 0.5 } });
    expect(events).toEqual(["binding", 'properties:{"speed":0.5}', "apply", "redraw"]);
    events.length = 0;
    host.applyUserProperties({ q: { type: "bool", value: true } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(events).toContain("render"));
    expect(events).not.toContain("redraw");
    host.dispose();
  });
});

describe("SceneHost 清空脚本存储", () => {
  const key = (id: string) => `${SCENE_STORAGE_PREFIX}${id}:s:count`;
  const clear = (imageId: string) => listeners.get("wpe-scene-clear-storage")!({ payload: { imageId } });
  let backend: Storage;

  async function ready() {
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    return { host, reporter };
  }

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    backend = createMemoryStorage();
    const remove = backend.removeItem.bind(backend);
    backend.removeItem = (name) => {
      events.push("clear");
      remove(name);
    };
    backend.setItem(key("1"), "3");
    backend.setItem(key("2"), "4");
    vi.stubGlobal("localStorage", backend);
    events.length = 0;
    imports = 0;
    destroyed = 0;
    realmGate = null;
    moduleGate = null;
    realmsCreated = 0;
    onUpdate = null;
    onInit = null;
    compile.mockReset().mockImplementation(async () => bundle());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("别的图片的事件什么都不做", async () => {
    const { host } = await ready();
    clear("2");
    expect(backend.getItem(key("1"))).toBe("3");
    expect(backend.getItem(key("2"))).toBe("4");
    expect(destroyed).toBe(0);
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("先 destroy 再删存储，再重建 realm 并重跑 init", async () => {
    const { host } = await ready();
    events.length = 0;
    clear("1");
    expect(events).toEqual(["destroy", "clear"]);
    expect(backend.getItem(key("1"))).toBeNull();
    expect(backend.getItem(key("2"))).toBe("4");
    await vi.waitFor(() => expect(events).toContain("render"));
    expect(events).toEqual([
      "destroy",
      "clear",
      "evaluate",
      'properties:{"speed":1}',
      "init",
      'properties:{"speed":0.3}',
      "apply",
      "update",
      "render",
    ]);
    expect(imports).toBe(2);
    expect(destroyed).toBe(1);
    expect(host.stats.recompiled).toEqual([{ reason: "clear-storage", keys: [] }]);
    host.dispose();
  });

  it("脚本还在加载时清空：旧的作废后重建一次，init 只在新环境里跑", async () => {
    let open!: () => void;
    moduleGate = new Promise<void>((resolve) => (open = resolve));
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(realmsCreated).toBe(1));
    await new Promise((resolve) => setTimeout(resolve));
    clear("1");
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    open();
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalled());
    expect(realmsCreated).toBe(2);
    expect(events.filter((event) => event === "init")).toHaveLength(1);
    host.dispose();
  });

  it("脚本写过的重编译目标一并放弃", async () => {
    let calls = 0;
    compile.mockImplementation(async () => {
      // 上界：去重坏了时重载会一直链下去，这里卡住让断言干净地失败
      if (++calls > 3) await new Promise(() => {});
      const result = bundle();
      result.scripts.list[0].owner = { kind: "general" };
      return result;
    });
    onUpdate = () => {
      (activeGlobal.thisObject as { hdr: boolean }).hdr = true;
    };
    const { host } = await ready();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[1][0].scriptOverrides["general/hdr"]).toBe(true);
    await vi.waitFor(() => expect(events.filter((value) => value === "render")).toHaveLength(2));
    onUpdate = null;
    clear("1");
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect(compile.mock.calls[2][0].scriptOverrides).toEqual({});
    host.dispose();
  });

  it("没建过脚本环境的退回状态只删存储", async () => {
    compile.mockImplementation(async () => ({ ...bundle(), unsupported: ["effect:unsupported"] }));
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.fallback).toHaveBeenCalledOnce());
    clear("1");
    expect(backend.getItem(key("1"))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(imports).toBe(0);
    host.dispose();
  });

  it("建好脚本环境后才退回的：停脚本、删存储，不重新编译", async () => {
    const { host } = await ready();
    onError?.(["test:fallback"]);
    events.length = 0;
    clear("1");
    expect(events).toEqual(["destroy", "clear"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(imports).toBe(1);
    host.dispose();
  });
});

describe("SceneHost：粒子 instanceoverride 的字段脚本（P4f 步骤 1）", () => {
  const RATE = { kind: "particle-instance", object: 0, field: "rate" } as const;
  /** 图层 0 是粒子层（实例覆盖 `rate 0.5`），脚本挂在 `instanceoverride.rate` 上，属性 `r` 也绑它。 */
  function particleBundle(): SceneBundle {
    const result = bundle();
    // `SceneState.fromBundle` 只读实例值、pass 与子系统
    result.layers[0].particle = {
      instance: { alpha: 1, size: 1, count: 1, speed: 1, lifetime: 1, rate: 0.5, brightness: 1, colorn: null },
      passes: [],
      children: [],
    } as unknown as SceneBundle["layers"][number]["particle"];
    result.bindings = [{ property: "r", target: RATE }];
    Object.assign(result.scripts.list[0], {
      id: "objects/0/instanceoverride/rate",
      target: RATE,
      valueType: "float",
      initial: 0.5,
      scriptProperties: null,
    });
    return result;
  }

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    events.length = 0;
    imports = 0;
    destroyed = 0;
    onUpdate = null;
    updateArguments = [];
    onInit = null;
    frozen = false;
    realmGate = null;
    moduleGate = null;
    realmsCreated = 0;
    compile.mockReset().mockImplementation(async () => particleBundle());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("update 收到实例覆盖里的当前值；返回值写进状态，rate 只记 rates、不标脏；用户属性改 rate 同一条路", async () => {
    onUpdate = () => 0;
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ r: { type: "slider", value: 0.5 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const state = renderer.sceneState!;
    state.takeDirty();
    updateArguments = [];
    onUpdate = () => 0.25;
    renderer.tick();
    // 读的是状态里的值（首帧的 update 写了 0），不是 JSON 里的初值
    expect(updateArguments).toEqual([0]);
    expect(state.particleInstances.get(0)!.rate).toBe(0.25);
    expect(host.readTarget("objects/0/instanceoverride/rate")).toBe(0.25);
    let dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[0], []]);
    host.applyUserProperties({ r: { type: "slider", value: 0.75 } });
    expect(state.particleInstances.get(0)!.rate).toBe(0.75);
    dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[0], []]);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(reporter.warn).not.toHaveBeenCalled();
    host.dispose();
  });
});

describe("SceneHost：粒子层的脚本方法与 instance（P4f 步骤 3）", () => {
  /** 图层 0 是粒子层（实例覆盖缺省），脚本挂在它自己的 `alpha` 上（`thisLayer` 就是粒子层的代理）。 */
  function particleBundle(): SceneBundle {
    const result = bundle();
    result.layers[0].particle = {
      instance: { alpha: 1, size: 1, count: 1, speed: 1, lifetime: 1, rate: 1, brightness: 1, colorn: null },
      passes: [],
      children: [],
    } as unknown as SceneBundle["layers"][number]["particle"];
    return result;
  }
  type ParticleLayer = Record<string, (...args: unknown[]) => unknown> & { instance: Record<string, unknown> };

  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    events.length = 0;
    particleCalls.length = 0;
    imports = 0;
    destroyed = 0;
    onUpdate = null;
    updateArguments = [];
    onInit = null;
    frozen = false;
    realmGate = null;
    moduleGate = null;
    realmsCreated = 0;
    compile.mockReset().mockImplementation(async () => particleBundle());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("首次加载的 init 先于渲染器建场景：方法先记下，场景换上时按顺序补调；这期间 isPlaying 按记下的暂停 / 停止回答", async () => {
    let layer: ParticleLayer | null = null;
    const playing: unknown[] = [];
    onInit = () => {
      layer = activeGlobal.thisLayer as ParticleLayer;
      layer.pause();
      playing.push(layer.isPlaying());
      layer.play();
      playing.push(layer.isPlaying());
      layer.emitParticles(3);
      layer.stop();
      playing.push(layer.isPlaying());
      return 0.8;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({});
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    expect(playing).toEqual([false, true, false]);
    // 补调发生在首帧之前（beforeFirstFrame），渲染器替身的 isPlaying 没被问过
    expect(particleCalls).toEqual(["pause:0", "play:0", "emit:0:3", "stop:0"]);
    // 场景换上之后直接接到渲染器的场景
    layer!.play();
    expect(layer!.isPlaying()).toBe(true);
    layer!.emitParticles();
    expect(particleCalls.slice(4)).toEqual(["play:0", "isPlaying:0", "emit:0:undefined"]);
    host.dispose();
  });

  it("instance 的控制点：写进状态、置脏，readTarget 读到覆盖值（没设为 null），脚本读回 (FLT_MAX, 0, 0)", async () => {
    let layer: ParticleLayer | null = null;
    onInit = () => {
      layer = activeGlobal.thisLayer as ParticleLayer;
      return 0.8;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({});
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const state = renderer.sceneState!;
    state.takeDirty();
    expect(host.readTarget("objects/0/instanceoverride/controlpoint2")).toBeNull();
    const unset = layer!.instance.controlpoint2 as { x: number; y: number; z: number };
    expect([unset.x, unset.y, unset.z]).toEqual([3.4028234663852886e38, 0, 0]);
    layer!.instance.controlpoint2 = 5;
    expect(host.readTarget("objects/0/instanceoverride/controlpoint2")).toEqual([5, 5, 5]);
    expect([...state.takeDirty().particles]).toEqual([0]);
    expect(host.readTarget("objects/0/instanceoverride/alpha")).toBe(1);
    host.dispose();
  });
});
