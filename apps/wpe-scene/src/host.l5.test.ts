/**
 * 活的场景图 L5a：宿主里运行中建层的两条路（`.claude/plans/wpe-import/3-scene/live/phase-l5-create-layer.md` 点 1–5）。编译、会话、realm、渲染器
 * 换成替身：编译给三层场景（图层 0..2 各挂一段 alpha 脚本），会话的 `compileFragment` 由用例控制何时回；渲染器的 GPU 装卸只记调用。
 * - 命中缓存：`createLayer` 返回之前登记表、状态、GPU 都装好，读到的 `size` 是编好的；绑定按当前属性重写；
 * - 没命中：壳 → 片段到达 → 下一帧开头状态换成编好的、写入重放、脚本条目换成定型的、GPU 装上、进缓存；到达前已删只进缓存；
 * - `sceneFlips` / 编失败 / 装失败 → 整场重载；不支持项：不装 GPU、`report.unsupported`、`stats.created.unsupported`；
 * - 首次加载 `init` 里建的层不再二次编译，建 GPU 场景之前已在 bundle 里；重载进行中建的在新场景建壳并排给新会话；换场景时旧缓存丢掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeModule } from "./script/testing/fakeModule";
import type { SceneBundle, SceneLayer } from "./compile/bundle";
import { generalDefaults } from "./compile/bindings";
import { normalizeConfig } from "./compile/config";
import type { FragmentDelta, FragmentRequest, ObjectFragment } from "./compile/fragment";
import { SceneState } from "./render/state";

let activeGlobal: Record<string, unknown>;
let onInit: (() => void) | null = null;
let onUpdate: (() => void) | null = null;
const events: string[] = [];
let renderer: FakeRenderer;

/** 编译替身：每次加载各开一个会话；`compileFragment` 的请求排在 `requests` 里，用例逐个回。 */
const compile = vi.fn<(input: unknown) => Promise<SceneBundle>>();
interface FakeSession {
  close: ReturnType<typeof vi.fn>;
  stats: null;
  broken: boolean;
  exactConfigs: number[];
  compileFragment: ReturnType<typeof vi.fn>;
  requests: { request: FragmentRequest; resolve(delta: FragmentDelta): void; reject(error: Error): void }[];
}
const sessions: FakeSession[] = [];
/** 下一次 `compile` 先等它（测「重载进行中建层」） */
let compileGate: Promise<void> | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async (command: string) =>
    command === "wpe_scene_target" ? { path: "P:/test", sceneAssets: [] } : "disabled",
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./compile/client", () => ({
  openSceneSession: async (input: unknown) => {
    await compileGate;
    const bundle = await compile(input);
    const session: FakeSession = {
      close: vi.fn(),
      stats: null,
      broken: false,
      exactConfigs: [0, 1, 2],
      requests: [],
      compileFragment: vi.fn(
        (request: FragmentRequest) =>
          new Promise<FragmentDelta>((resolve, reject) => session.requests.push({ request, resolve, reject })),
      ),
    };
    sessions.push(session);
    return { bundle, session, exactConfigs: session.exactConfigs };
  },
}));
class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
}
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => {
    activeGlobal = { Object, Array, JSON, SyntaxError };
    return {
      global: activeGlobal,
      prototypes: { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: {}, Mat3: {}, Mat4: {} },
      internal: { updateScriptProperties() {}, convertUserProperties: (json: string) => JSON.parse(json) },
      async prepareModule() {
        return fakeModule({
          init() {
            events.push("init");
            onInit?.();
            return 1;
          },
          update() {
            onUpdate?.();
            return 1;
          },
        });
      },
      dispose() {},
    };
  },
}));

/** GPU 装卸的替身：`prepareObjectSync` 缺省同步备好；`install` 记对象。 */
const gpu = {
  sync: true as boolean,
  installThrows: false,
  installed: [] as number[],
  log: [] as string[],
};

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  /** 最近一次 `load` 收到的 bundle 里的图层（建场景那一刻的拷贝） */
  loadedLayers: number[] = [];
  constructor(private readonly beforeFrame?: (dt: number) => void) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    this.loadedLayers = bundle.layers.map((layer) => layer.object);
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
    this.tick();
    events.push("render");
  }
  tick() {
    this.beforeFrame?.(1 / 60);
  }
  prepareObjectSync(layer: SceneLayer) {
    gpu.log.push(`prepareSync ${layer.object}`);
    return gpu.sync ? { layer, tag: "sync" } : null;
  }
  async prepareObject(layer: SceneLayer) {
    gpu.log.push(`prepare ${layer.object}`);
    return { layer, tag: "async" };
  }
  installObject(prepared: { layer: SceneLayer }) {
    gpu.log.push(`install ${prepared.layer.object}`);
    if (gpu.installThrows) throw new Error("装不上");
    gpu.installed.push(prepared.layer.object);
  }
  discardPrepared(prepared: { layer: SceneLayer }) {
    gpu.log.push(`discard ${prepared.layer.object}`);
  }
  setStyle() {}
  setBackground() {}
  setPaused() {}
  applyBindings() {
    return true;
  }
  redraw() {}
  particleScript() {
    return null;
  }
  forgetObjects() {}
  attachMatrix() {
    return null;
  }
  destroy() {}
}

vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async (_canvas: unknown, options: { beforeFrame?: (dt: number) => void }) => {
      renderer = new FakeRenderer(options.beforeFrame);
      return renderer;
    },
  },
}));

const { SceneHost } = await import("./host");

/** 模板对象 `i` 的配置原文（不带 id）。 */
const CONFIG = (object: number) => ({ image: "models/a.json", name: `L${object}` });

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `L${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [64, 32],
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
    ...extra,
  } as SceneLayer;
}

const script = (object: number) => ({
  id: `objects/${object}/alpha`,
  source: "script",
  target: { kind: "layer" as const, object, field: "alpha" as const },
  valueType: "float" as const,
  initial: 1,
  owner: { kind: "layer" as const, object },
  layer: object,
  scriptProperties: null,
  imports: [],
  errors: [],
});

/** 三层场景：图层 0..2，各挂一段 alpha 脚本；`b` 属性绑图层 0 的 brightness（不挂脚本的目标）。 */
function sceneBundle(): SceneBundle {
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
    layers: [0, 1, 2].map((object) => layer(object)),
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [{ property: "b", target: { kind: "layer", object: 0, field: "brightness" } }],
    scripts: { list: [0, 1, 2].map(script) },
    configs: [0, 1, 2].map((object) => normalizeConfig(CONFIG(object))),
  } as unknown as SceneBundle;
}

/**
 * 整场编译的替身：照结构把新建对象编进来（尺寸 96×48、配置是规整的原文），删掉的不编（同真实编译）。
 */
function compiledWithStructure(input: unknown): SceneBundle {
  const result = sceneBundle();
  const { destroyed, created } = (
    input as { structure: { destroyed: number[]; created: { object: number; config: string }[] } }
  ).structure;
  for (const { object, config } of created) {
    if (destroyed.includes(object)) continue;
    result.layers.push(layer(object, { size: [96, 48] }));
    while (result.configs!.length <= object) result.configs!.push(null);
    result.configs![object] = normalizeConfig(JSON.parse(config) as object);
  }
  return result;
}

/** 会话编出的片段：图层尺寸 96×48（和模板不同，看得出是谁编的）。 */
function deltaFor(request: FragmentRequest, extra: Partial<ObjectFragment> = {}): FragmentDelta {
  const object = request.object;
  const parsed = JSON.parse(request.config) as { id?: number };
  return {
    fragment: {
      object,
      config: normalizeConfig(JSON.parse(request.config) as object),
      layer: layer(object, { id: parsed.id ?? 0, size: [96, 48] }),
      bindings: [],
      scripts: [script(object)],
      animations: [],
      reflected: false,
      sceneFlips: [],
      audio: false,
      media: false,
      unsupported: [],
      ...extra,
    } as ObjectFragment,
    programs: { from: 0, list: [] },
    textures: { from: 0, list: [] },
    userTextures: { from: 0, list: [] },
    bindings: [],
    assetPaths: [],
  };
}

type Layer = { size: { x: number; y: number }; alpha: number };
type Scene = { createLayer(...args: unknown[]): Layer | null; destroyLayer(value: unknown): boolean };
const scene = () => activeGlobal.thisScene as unknown as Scene;

function report() {
  return {
    ready: vi.fn(),
    fallback: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    unsupported: vi.fn(),
  };
}

type Internals = {
  live: { cache: { size: number; has(key: string): boolean } } | null;
  registry: { bundle: SceneBundle } | null;
  structure: { created: { object: number; config: string }[]; destroyed: number[] };
  runtime: { byId: Map<string, { script: unknown }> };
};

async function open(properties: Record<string, { type: string; value: unknown }> = {}) {
  const reporter = report();
  const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
  host.applyUserProperties(properties);
  await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
  return { host, reporter, internals: host as unknown as Internals };
}

/** 从现在起第 `step` 次 `update`（三段脚本，每帧三次）跑一次 `action`。 */
function atUpdate(step: number, action: () => void) {
  let count = 0;
  onUpdate = () => {
    if (++count === step) action();
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal("__SCENE_DEV__", false);
  vi.stubGlobal("document", {});
  events.length = 0;
  sessions.length = 0;
  onInit = null;
  onUpdate = null;
  compileGate = null;
  gpu.sync = true;
  gpu.installThrows = false;
  gpu.installed = [];
  gpu.log = [];
  compile.mockReset().mockImplementation(async (input) => compiledWithStructure(input));
});
afterEach(() => vi.unstubAllGlobals());

describe("运行中建层：命中缓存（L5 点 3）", () => {
  it("createLayer 返回之前登记表、状态、GPU 都装好；读到编好的 size；不重编译；计数 sync", async () => {
    const { host, internals } = await open();
    let made: Layer | null = null;
    let installedAtReturn: number[] = [];
    atUpdate(1, () => {
      made = scene().createLayer(CONFIG(1));
      installedAtReturn = [...gpu.installed];
    });
    renderer.tick();
    expect(made).not.toBeNull();
    expect([made!.size.x, made!.size.y]).toEqual([64, 32]);
    expect(installedAtReturn).toEqual([3]);
    expect(internals.registry!.bundle.layers.map((item) => item.object)).toEqual([0, 1, 2, 3]);
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(sessions[0].compileFragment).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.created).toEqual({ sync: 1, async: 0, unsupported: 0 });
    expect(host.stats.recompiled).toEqual([]);
    host.dispose();
  });

  it("绑定按当前属性全集重写：模板图层 0 的 brightness 绑 b，克隆建出时就是 b 的当前值", async () => {
    const { host } = await open({ b: { type: "slider", value: 0.25 } });
    // 模板（预置时按编译那一刻的属性取的片段）的 brightness 是 1；之后 b 改成 0.75
    host.applyUserProperties({ b: { type: "slider", value: 0.75 } });
    atUpdate(1, () => void scene().createLayer(CONFIG(0)));
    renderer.tick();
    expect(renderer.sceneState!.layers.get(3)!.brightness).toBe(0.75);
    host.dispose();
  });

  it("同步备不好（缺程序）：先接进状态，GPU 异步备，之后某一帧开头装上；计数 async", async () => {
    const { host } = await open();
    gpu.sync = false;
    atUpdate(1, () => void scene().createLayer(CONFIG(2)));
    renderer.tick();
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(gpu.installed).toEqual([]);
    await flush();
    renderer.tick();
    expect(gpu.installed).toEqual([3]);
    expect(host.stats.created).toEqual({ sync: 0, async: 1, unsupported: 0 });
    host.dispose();
  });

  it("装 GPU 出错：整场重载", async () => {
    const { host } = await open();
    gpu.installThrows = true;
    atUpdate(1, () => void scene().createLayer(CONFIG(1)));
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(host.stats.recompiled.some((item) => item.reason.includes("装 GPU 失败"))).toBe(true);
    host.dispose();
  });
});

describe("运行中建层：没命中（L5 点 3）", () => {
  const NEW = { image: "models/b.json", name: "new" };
  /** 新对象的 color 挂字段脚本（alpha 留给 API 写入，看重放） */
  const SCRIPTED_COLOR = { script: "export function update(value) { return value; }", value: "1 1 1" };

  it("壳 → 片段到达 → 下一帧开头：状态换成编好的、写入重放、脚本条目换成定型的、GPU 装上、进缓存；计数 async", async () => {
    const { host, internals } = await open();
    atUpdate(1, () => {
      const made = scene().createLayer({ ...NEW, color: SCRIPTED_COLOR });
      made!.alpha = 0.3;
    });
    renderer.tick();
    // 壳：状态里有、登记表里没有，尺寸未知
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(internals.registry!.bundle.layers.some((item) => item.object === 3)).toBe(false);
    const { request, resolve } = sessions[0].requests[0];
    expect(request.object).toBe(3);
    expect(JSON.parse(request.config)).toMatchObject(NEW);
    const delta = deltaFor(request, {
      scripts: [{ ...script(3), id: "objects/3/color", target: { kind: "layer", object: 3, field: "color" } }],
    } as Partial<ObjectFragment>);
    resolve(delta);
    await flush();
    // 到达不改状态：等下一帧开头
    expect(gpu.installed).toEqual([]);
    renderer.tick();
    expect(gpu.installed).toEqual([3]);
    expect(internals.registry!.bundle.layers.find((item) => item.object === 3)!.size).toEqual([96, 48]);
    // 脚本写入重放到编好的状态上
    expect(renderer.sceneState!.layers.get(3)!.alpha).toBe(0.3);
    expect(internals.runtime.byId.get("objects/3/color")!.script).toBe(delta.fragment.scripts[0]);
    expect(internals.live!.cache.has(normalizeConfig({ ...NEW, color: SCRIPTED_COLOR }))).toBe(true);
    expect(host.stats.created).toEqual({ sync: 0, async: 1, unsupported: 0 });
    // 同一配置再建：命中
    atUpdate(1, () => void scene().createLayer({ ...NEW, color: SCRIPTED_COLOR }));
    renderer.tick();
    expect(sessions[0].requests).toHaveLength(1);
    expect(gpu.installed).toEqual([3, 4]);
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("到达前对象已删：只进缓存，不装", async () => {
    const { host, internals } = await open();
    atUpdate(1, () => {
      const made = scene().createLayer(NEW);
      scene().destroyLayer(made);
    });
    renderer.tick();
    expect(renderer.sceneState!.layers.has(3)).toBe(false);
    sessions[0].requests[0].resolve(deltaFor(sessions[0].requests[0].request));
    await flush();
    renderer.tick();
    expect(gpu.installed).toEqual([]);
    expect(internals.live!.cache.has(normalizeConfig(NEW))).toBe(true);
    host.dispose();
  });

  it("片段带 sceneFlips：整场重载，结构里记着新对象", async () => {
    const { host, internals } = await open();
    atUpdate(1, () => void scene().createLayer(NEW));
    renderer.tick();
    const { request, resolve } = sessions[0].requests[0];
    resolve(deltaFor(request, { sceneFlips: ["lights"] }));
    await flush();
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(internals.structure.created.map((item) => item.object)).toEqual([3]);
    host.dispose();
  });

  it("编片段失败：整场重载", async () => {
    const { host } = await open();
    atUpdate(1, () => void scene().createLayer(NEW));
    renderer.tick();
    sessions[0].requests[0].reject(new Error("会话坏了"));
    await flush();
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    host.dispose();
  });

  it("不支持项：接进状态与登记表、不装 GPU、report.unsupported 调到、计数 unsupported，场景不退回", async () => {
    const { host, reporter, internals } = await open();
    atUpdate(1, () => void scene().createLayer(NEW));
    renderer.tick();
    const { request, resolve } = sessions[0].requests[0];
    resolve(deltaFor(request, { unsupported: ["effect:missing"] }));
    await flush();
    renderer.tick();
    expect(gpu.installed).toEqual([]);
    expect(internals.registry!.bundle.layers.some((item) => item.object === 3)).toBe(true);
    expect(reporter.unsupported).toHaveBeenCalledWith(["effect:missing"]);
    expect(reporter.fallback).not.toHaveBeenCalled();
    expect(host.stats.created).toEqual({ sync: 0, async: 0, unsupported: 1 });
    host.dispose();
  });
});

describe("首次加载与重载进行中（L5 点 4）", () => {
  it("init 里建的层（没命中）：不再二次编译，片段到齐后接进 bundle，建 GPU 场景时就带它，首帧只画一次", async () => {
    let first = true;
    onInit = () => {
      if (!first) return;
      first = false;
      scene().createLayer({ image: "models/b.json", name: "bar" });
      // init 期间会话就收到请求；当场回（宿主在 init 之后等它）
      const { request, resolve } = sessions[0].requests[0];
      resolve(deltaFor(request));
    };
    const { host, internals } = await open();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(renderer.loadedLayers).toEqual([0, 1, 2, 3]);
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(internals.registry!.bundle.layers.find((item) => item.object === 3)!.size).toEqual([96, 48]);
    expect(events.filter((event) => event === "render")).toHaveLength(1);
    // GPU 场景从 bundle 一起建，不另装
    expect(gpu.installed).toEqual([]);
    host.dispose();
  });

  it("init 里建的层（命中缓存）：不经会话，init 当场读到编好的 size", async () => {
    let size: number[] = [];
    let first = true;
    onInit = () => {
      if (!first) return;
      first = false;
      const made = scene().createLayer(CONFIG(1));
      size = [made!.size.x, made!.size.y];
    };
    const { host } = await open();
    expect(size).toEqual([64, 32]);
    expect(sessions[0].compileFragment).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(renderer.loadedLayers).toEqual([0, 1, 2, 3]);
    host.dispose();
  });

  it("init 里建的层编失败：照旧放弃本次、带结构整场重编", async () => {
    let first = true;
    onInit = () => {
      if (!first) return;
      first = false;
      scene().createLayer({ image: "models/b.json" });
      sessions[0].requests[0].reject(new Error("坏了"));
    };
    const { host } = await open();
    expect(compile).toHaveBeenCalledTimes(2);
    expect((compile.mock.calls[1][0] as { structure: { created: unknown[] } }).structure.created).toHaveLength(1);
    expect(renderer.loadedLayers).toEqual([0, 1, 2, 3]);
    host.dispose();
  });

  it("重载进行中建的层：当前场景照常建（排给旧会话）；新场景换上时照旧下标建壳、排给新会话；旧缓存丢掉", async () => {
    const { host, internals } = await open();
    const oldLive = internals.live!;
    expect(oldLive.cache.size).toBeGreaterThan(0);
    // 第二次编译挡住，期间旧场景照常跑帧
    let release!: () => void;
    compileGate = new Promise((resolve) => (release = resolve));
    host.setSceneSettings({ postprocess: "enabled", reflection: "follow", shadows: "follow" });
    await flush();
    atUpdate(1, () => void scene().createLayer({ image: "models/b.json", name: "late" }));
    renderer.tick();
    expect(sessions[0].requests.map((item) => item.request.object)).toEqual([3]);
    compileGate = null;
    release();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    await vi.waitFor(() => expect(events.filter((event) => event === "render")).toHaveLength(2));
    // 新状态里有壳（下标照旧），新会话收到请求；旧缓存清空
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(sessions[1].requests.map((item) => item.request.object)).toEqual([3]);
    expect(internals.live).not.toBe(oldLive);
    expect(oldLive.cache.size).toBe(0);
    host.dispose();
  });
});
