import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "./compile/bundle";
import { SceneState } from "./render/state";

const events: string[] = [];
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
  destroy() {}
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "wpe_scene_target" ? { path: "P:/test", sceneAssets: [] } : "disabled",
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./compile/client", () => ({ compileSceneInWorker: (input: never) => compile(input) }));
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => createRealm(),
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
    compile.mockReset().mockImplementation(async () => bundle());
  });
  afterEach(() => vi.unstubAllGlobals());

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
});
