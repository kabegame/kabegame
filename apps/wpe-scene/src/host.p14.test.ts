/**
 * P14 步骤 3a：脚本模型数据层在宿主里的接线（`.claude/plans/wpe-import/3-scene/phase14/phase-14-model-data.md` 点 6）。harness 同 `host.l5.test.ts`
 * （编译、会话、realm、渲染器换成替身）：
 * - 同步路：材质有预编模板时 `createLayer({ model: token })` 返回之前图层已在 bundle 里、GPU 已装，不问会话；
 * - Worker 路：没预编的材质 / 白名单外的键，请求带描述；查不到的 token 不带；
 * - 引用计数：建壳时 `retainLayer`，`destroyLayer` 帧尾 `releaseLayer`，引用归零数据释放；
 * - 整场重载：开会话的输入带描述，层重载后仍在；
 * - `replaceData` 改结构：同步重拼替换 / 拼不了走单对象重编译（带新描述）/ 片段到达前改的在到达后补。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeModule } from "./script/testing/fakeModule";
import type { SceneBundle, SceneLayer } from "./compile/bundle";
import { generalDefaults } from "./compile/bindings";
import { normalizeConfig } from "./compile/config";
import type { FragmentDelta, FragmentRequest, ObjectFragment } from "./compile/fragment";
import { mdlStride } from "./compile/mdl";
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
  /** 最近一次 `load` 收到的 `modelData`（脚本模型数据来源，P14 步骤 3b） */
  loadModelData: (() => unknown) | undefined;
  async load(
    bundle: SceneBundle,
    options: { beforeFirstFrame?: (state: SceneState) => void; modelData?: () => unknown },
  ) {
    this.loadModelData = options.modelData;
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
  /** 结构变化（L7）：记下交来的对象与重排。 */
  restructure(objects: number[]) {
    gpu.log.push(`restructure ${[...objects].sort((a, b) => a - b).join(",")}`);
  }
  flushRestructure() {
    gpu.log.push("flush");
  }
  hasObject(object: number) {
    return gpu.installed.includes(object);
  }
  removeObject(object: number) {
    gpu.log.push(`remove ${object}`);
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

/** 模型材质模板（`SceneBundle.modelMaterials`）：一个 pass，程序 0（读位置与 uv）。 */
const template = (material: string) => ({
  passes: [
    {
      key: "modeldata/0/passes/0",
      material,
      program: 0,
      blending: "normal",
      uniforms: {},
      textures: {},
      runtime: {},
    },
  ],
  usable: true,
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
    programs: [
      {
        attributes: [
          { name: "a_Position", type: "vec3", location: 0 },
          { name: "a_TexCoord", type: "vec2", location: 1 },
        ],
      },
    ],
    modelMaterials: {
      "materials/mesh_0.json": template("materials/mesh_0.json"),
      "materials/mesh_t.json": template("materials/mesh_t.json"),
    },
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

// ———— P14 步骤 3a ————

const PBR = 0x1 | 0x2 | 0x8 | 0x8000;

type StoreLike = {
  create(input: unknown, check: () => 0): number;
  replace(token: number, updates: unknown[], check: () => 0): void;
  releaseScript(token: number): void;
  layersOf(token: number): number[];
  desc(token: number): {
    token: number;
    shapes: { format: number; vertexCount: number; indexFormat: string | null; indexCount: number; material: string }[];
  } | null;
};
const storeOf = (internals: Internals) => (internals as unknown as { modelData: StoreLike }).modelData;

/** 建一份 4 顶点 + 6 索引的模型数据。 */
function newToken(store: StoreLike, material = "materials/mesh_0.json"): number {
  return store.create(
    {
      shapes: [
        {
          vertices: new Uint8Array(mdlStride(PBR) * 4),
          index: { format: "uint16", bytes: new Uint8Array(12) },
          format: PBR,
          material,
          dynamicVertex: true,
          dynamicIndex: false,
        },
      ],
      bounds: null,
    },
    () => 0,
  );
}

/** 场景级增量的 `from` 对上 bundle 里已有的程序表长（这个 harness 的 bundle 有一个程序）。 */
function aligned(delta: FragmentDelta): FragmentDelta {
  delta.programs = { from: 1, list: [] };
  return delta;
}

/** 假会话编出的模型数据层片段：网格字段照描述（和真实编译一致，`modelFragmentStale` 核对用）。 */
function modelDelta(request: FragmentRequest, token: number): FragmentDelta {
  const modelDesc = request.modelData?.[token];
  const base = aligned(deltaFor(request));
  base.fragment.scripts = [];
  base.fragment.layer.model = {
    path: "",
    version: 0,
    order: [],
    bounds: [],
    meshes: (modelDesc?.shapes ?? []).map((shape, i) => ({
      format: shape.format,
      stride: mdlStride(shape.format),
      vertices: new Uint8Array(0),
      indices: new Uint8Array(0),
      vertexCount: shape.vertexCount,
      indexFormat: shape.indexFormat ?? "uint16",
      indexCount: shape.indexFormat ? shape.indexCount : 0,
      material: shape.material,
      passes: [],
      source: { token, shape: i },
    })),
  } as SceneLayer["model"];
  return base;
}

type ModelScene = { createLayer(...args: unknown[]): Layer | null; destroyLayer(value: unknown): boolean };
const modelScene = () => activeGlobal.thisScene as unknown as ModelScene;

describe("脚本模型数据层（P14 步骤 3a）", () => {
  it("同步路：材质有模板，createLayer 返回之前图层已在 bundle 里、GPU 已装、不问会话；引用计数 +1；片段不进缓存", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    const cached = internals.live!.cache.size;
    let token = 0;
    let atReturn: { layers: number[]; installed: number[] } | null = null;
    atUpdate(1, () => {
      token = newToken(store);
      modelScene().createLayer({ name: "part", model: token, origin: "1 2 3", perspective: false });
      atReturn = {
        layers: internals.registry!.bundle.layers.map((item) => item.object),
        installed: [...gpu.installed],
      };
    });
    renderer.tick();
    expect(atReturn).toEqual({ layers: [0, 1, 2, 3], installed: [3] });
    const made = internals.registry!.bundle.layers.find((item) => item.object === 3)!;
    expect(made.model!.meshes[0].source).toEqual({ token, shape: 0 });
    expect(made.model!.meshes[0].passes[0].key).toBe("objects/3/meshes/0/passes/0");
    expect(made.origin).toEqual([1, 2, 3]);
    expect(renderer.sceneState!.layers.has(3)).toBe(true);
    expect(sessions[0].compileFragment).not.toHaveBeenCalled();
    expect(host.stats.created).toEqual({ sync: 1, async: 0, unsupported: 0 });
    expect(store.layersOf(token)).toEqual([3]);
    // 模型数据层不进片段缓存（配置键里没有描述）
    expect(internals.live!.cache.size).toBe(cached);
    host.dispose();
  });

  it("没预编的材质走 Worker 路：请求带描述、片段到达后下一帧装上；查不到的 token 请求不带描述", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    atUpdate(1, () => {
      token = newToken(store, "materials/plain.json");
      modelScene().createLayer({ name: "late", model: token });
      modelScene().createLayer({ name: "unknown", model: 99999 });
    });
    renderer.tick();
    expect(sessions[0].requests).toHaveLength(2);
    const [first, second] = sessions[0].requests;
    expect(first.request.modelData).toEqual({ [token]: store.desc(token) });
    expect(first.request.modelData![token].shapes[0].material).toBe("materials/plain.json");
    expect(second.request.modelData).toBeUndefined();
    // 图层引用在壳建好时就记了
    expect(store.layersOf(token)).toEqual([3]);
    expect(gpu.installed).toEqual([]);
    first.resolve(modelDelta(first.request, token));
    second.resolve(aligned(deltaFor(second.request)));
    await flush();
    renderer.tick();
    expect(gpu.installed).toEqual([3, 4]);
    expect(host.stats.created).toEqual({ sync: 0, async: 2, unsupported: 0 });
    // 描述不一致（到达前 replaceData 又改了）不在这里测；此处不应再请求
    expect(sessions[0].requests).toHaveLength(2);
    host.dispose();
  });

  it("配置带白名单外的键（effects）也走 Worker 路", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    atUpdate(1, () => {
      const token = newToken(store);
      modelScene().createLayer({ name: "fx", model: token, effects: [] });
    });
    renderer.tick();
    expect(sessions[0].requests).toHaveLength(1);
    expect(gpu.installed).toEqual([]);
    host.dispose();
  });

  it("加载时把数据仓来源交给渲染器（P14 步骤 3b）：取当前值的函数，返回宿主现在的数据仓；脚本运行时丢掉后返回 null", async () => {
    const { host, internals } = await open();
    expect(typeof renderer.loadModelData).toBe("function");
    expect(renderer.loadModelData!()).toBe(storeOf(internals));
    expect(renderer.loadModelData!()).not.toBeNull();
    // 清空脚本存储会把数据仓丢掉再重建：来源是每次现取的，不是加载时的那一份
    (internals as unknown as { modelData: unknown }).modelData = null;
    expect(renderer.loadModelData!()).toBeNull();
    host.dispose();
  });

  it("destroyLayer：帧尾放掉图层引用；脚本那份也放掉后数据释放", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    let made: Layer | null = null;
    atUpdate(1, () => {
      token = newToken(store);
      made = modelScene().createLayer({ name: "part", model: token });
    });
    renderer.tick();
    expect(store.layersOf(token)).toEqual([3]);
    // 脚本那份先放：还有图层引用，数据在
    store.releaseScript(token);
    expect(store.desc(token)).not.toBeNull();
    atUpdate(1, () => void modelScene().destroyLayer(made));
    renderer.tick();
    expect(renderer.sceneState!.layers.has(3)).toBe(false);
    expect(store.layersOf(token)).toEqual([]);
    expect(store.desc(token)).toBeNull();
    host.dispose();
  });

  it("整场重载：开会话的输入带 structure.created 里引用到的 token 的描述；层在重载后仍在", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    atUpdate(1, () => {
      token = newToken(store);
      modelScene().createLayer({ name: "part", model: token });
    });
    renderer.tick();
    const expected = store.desc(token);
    expect(expected).not.toBeNull();
    (internals as unknown as { requestScriptReload(): void }).requestScriptReload();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    const input = compile.mock.calls[1][0] as { modelData?: Record<number, unknown> };
    expect(input.modelData).toEqual({ [token]: expected });
    await vi.waitFor(() => expect(renderer.loadedLayers).toContain(3));
    // 重载没有释放引用
    expect(store.layersOf(token)).toEqual([3]);
    host.dispose();
  });

  it("replaceData 改了材质：对每个引用它的图层重拼并替换（同步路），GPU 重新装", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    atUpdate(1, () => {
      token = newToken(store);
      modelScene().createLayer({ name: "part", model: token });
    });
    renderer.tick();
    expect(gpu.installed).toEqual([3]);
    // 带模板的另一个材质
    store.replace(token, [{ material: "materials/mesh_t.json" }], () => 0);
    const meshes = internals.registry!.bundle.layers.find((item) => item.object === 3)!.model!.meshes;
    expect(meshes[0].material).toBe("materials/mesh_t.json");
    expect(meshes[0].passes[0].key).toBe("objects/3/meshes/0/passes/0");
    expect(gpu.installed).toEqual([3, 3]);
    expect(sessions[0].compileFragment).not.toHaveBeenCalled();
    host.dispose();
  });

  it("replaceData 换成没预编的材质：拼不了，走单对象重编译（请求带新描述）", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    atUpdate(1, () => {
      token = newToken(store);
      modelScene().createLayer({ name: "part", model: token });
    });
    renderer.tick();
    store.replace(token, [{ material: "materials/plain.json" }], () => 0);
    expect(sessions[0].requests).toHaveLength(1);
    const { request, resolve } = sessions[0].requests[0];
    expect(request.overrides).toEqual({});
    expect(request.config).not.toBe("");
    expect(request.modelData![token].shapes[0].material).toBe("materials/plain.json");
    // 到达后按替换装上
    resolve(modelDelta(request, token));
    await flush();
    renderer.tick();
    expect(internals.registry!.bundle.layers.find((item) => item.object === 3)!.model!.meshes[0].material).toBe(
      "materials/plain.json",
    );
    expect(gpu.installed).toEqual([3, 3]);
    host.dispose();
  });

  it("Worker 路的片段到达前 replaceData 又改了结构：到达装上之后按新描述再来一次", async () => {
    const { host, internals } = await open();
    const store = storeOf(internals);
    let token = 0;
    atUpdate(1, () => {
      token = newToken(store, "materials/plain.json");
      modelScene().createLayer({ name: "late", model: token });
    });
    renderer.tick();
    const first = sessions[0].requests[0];
    // 图层还是壳（登记表里没有）：改结构时不做事
    store.replace(token, [{ material: "materials/mesh_t.json" }], () => 0);
    expect(sessions[0].requests).toHaveLength(1);
    // 旧描述（plain）的片段到达：核对发现过期，按新描述（mesh_t 有模板）重拼并替换
    first.resolve(modelDelta(first.request, token));
    await flush();
    renderer.tick();
    await flush();
    const meshes = internals.registry!.bundle.layers.find((item) => item.object === 3)!.model!.meshes;
    expect(meshes[0].material).toBe("materials/mesh_t.json");
    expect(meshes[0].passes.length).toBe(1);
    host.dispose();
  });
});
