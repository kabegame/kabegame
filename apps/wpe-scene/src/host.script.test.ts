import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "./compile/bundle";
import { SceneState } from "./render/state";
import { createMemoryStorage, SCENE_STORAGE_PREFIX } from "./script/storage";

const events: string[] = [];
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const compile =
  vi.fn<
    (input: {
      userProperties: Record<string, unknown>;
      scriptOverrides: Record<string, number[] | boolean>;
    }) => Promise<SceneBundle>
  >();
let renderer: FakeRenderer;
let imports = 0;
let destroyed = 0;
let onError: ((reasons: string[]) => void) | undefined;
let onUpdate: (() => void) | null = null;
let onInit: (() => unknown) | null = null;
let activeGlobal: Record<string, unknown>;
/** 让 realm 创建 / 模块求值停在半路，用来测并发的重载。 */
let realmGate: Promise<void> | null = null;
let moduleGate: Promise<void> | null = null;
let realmsCreated = 0;

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
        update() {
          events.push("update");
          onUpdate?.();
          return onUpdate ? undefined : 0.6;
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
  constructor(private readonly beforeFrame?: (dt: number) => void) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
    this.tick();
    events.push("render");
  }
  tick() {
    if (!this.paused) this.beforeFrame?.(1 / 60);
  }
  setPaused(value: boolean) {
    this.paused = value;
  }
  applyBindings(writes: { binding: SceneBundle["bindings"][number]; value: unknown }[]) {
    for (const write of writes) {
      events.push("binding");
      this.sceneState?.write(write.binding, write.value as number);
    }
    return true;
  }
  redraw() {
    events.push("redraw");
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
      options: { beforeFrame?: (dt: number) => void; onError?: (reasons: string[]) => void },
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
      clearColor: [0, 0, 0],
      clearEnabled: true,
      ambient: [0, 0, 0],
      skylight: [0, 0, 0],
      camera: { eye: [0, 0, 1], center: [0, 0, 0], up: [0, 1, 0] },
      postprocess: { level: "disabled", bloom: false, hdr: false },
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
        passes: [],
        effects: [],
        colorBlendMode: 0,
        passthrough: null,
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
    onInit = null;
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
      const result = bundle();
      result.scripts.list[0].owner = { kind: "effect", object: 0, effect: 0 };
      return result;
    });
    let visible = true;
    onUpdate = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = visible;
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    renderer.tick();
    expect(compile).toHaveBeenCalledTimes(2);
    visible = false;
    renderer.tick();
    expect(compile).toHaveBeenCalledTimes(2);
    finishSecond();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect(compile.mock.calls[2][0].scriptOverrides["objects/0/effects/0/visible"]).toBe(false);
    expect(imports).toBe(1);
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
        target: { kind: "recompile", reason: "effect-visible", path: "objects/0/effects/0/visible" },
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

  it("暂停时就地写属性补画一帧，排在脚本回调之后；不暂停或要重编译时不补画", async () => {
    compile.mockImplementation(async () => {
      const result = bundle();
      result.bindings.push({
        property: "q",
        target: { kind: "recompile", reason: "effect-visible", path: "objects/0/effects/0/visible" },
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
    compile.mockImplementation(async () => {
      const result = bundle();
      result.scripts.list[0].owner = { kind: "effect", object: 0, effect: 0 };
      return result;
    });
    onUpdate = () => {
      (activeGlobal.thisObject as { visible: boolean }).visible = true;
    };
    const { host } = await ready();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(compile.mock.calls[1][0].scriptOverrides["objects/0/effects/0/visible"]).toBe(true);
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
