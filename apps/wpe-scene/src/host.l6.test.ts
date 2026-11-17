/**
 * 活的场景图 L6：宿主里的单对象重编译（`.claude/plans/wpe-import/3-scene/live/phase-l6-object-recompile.md` 点 2、3）。编译、会话、realm、渲染器换成
 * 替身（搭法同 `host.l5.test.ts`）：编译给三层场景（图层 0..2 各挂一段 alpha 脚本），会话的 `compileFragment` 由用例控制何时回；渲染器的 GPU 装卸只记调用。
 * - 分级：脚本写 `objects/<i>/…` 只编那个对象，`general/…` 整场；属性改对象级重编译绑定 / 打开挡下的 effect 只编那个对象，同批有场景级就整场；
 * - 替换：片段到了下一帧开头换上（登记表、状态、GPU），运行中写过的字段（`replayWritesFor`）与对象表的位置留着；不进缓存；
 * - 合并：在编时连写 10 次只编 2 次、最后一次胜出；在编期间属性改了这个对象的绑定同样合并；到达前已删丢弃；
 * - 不支持项卸 GPU 并上报；`sceneFlips` 整场重载；
 * - 首次加载 `init` 里写的不二次编译（建 GPU 场景时就带编好的）；整场重载进行中（新场景没换上）写的照旧整场；
 * - 运行中建的层到达时属性已变、绑定被挡下（片段过期）：再编一次，请求带它的配置原文。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeModule } from "./script/testing/fakeModule";
import type { SceneBundle, SceneEffect, SceneLayer } from "./compile/bundle";
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
/** 下一次 `compile` 先等它（测「重载进行中」） */
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

/** GPU 装卸的替身：`install` / `removeObject` 记对象；`applyBindings` 记收到的写入。 */
const gpu = {
  installed: [] as number[],
  removed: [] as number[],
  writes: [] as { binding: { target: unknown }; value: unknown }[][],
};

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  /** 最近一次 `load` 收到的 bundle 里的图层（建场景那一刻的拷贝） */
  loadedLayers: SceneLayer[] = [];
  constructor(private readonly beforeFrame?: (dt: number) => void) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    this.loadedLayers = [...bundle.layers];
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
    this.tick();
    events.push("render");
  }
  tick() {
    this.beforeFrame?.(1 / 60);
  }
  prepareObjectSync(layer: SceneLayer) {
    return { layer };
  }
  async prepareObject(layer: SceneLayer) {
    return { layer };
  }
  installObject(prepared: { layer: SceneLayer }) {
    gpu.installed.push(prepared.layer.object);
  }
  removeObject(object: number) {
    gpu.removed.push(object);
  }
  discardPrepared() {}
  setStyle() {}
  setBackground() {}
  setPaused() {}
  applyBindings(writes: { binding: { target: unknown }; value: unknown }[]) {
    gpu.writes.push([...writes]);
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

const CONFIG = (object: number) => ({ image: "models/a.json", name: `L${object}` });

/** 图层 2 的 effect：带不支持项、开关绑属性 `fx`（打开时被 `needsRecompile` 挡下）。 */
const effect = (enabled: boolean): SceneEffect =>
  ({
    source: 0,
    id: 1,
    name: "",
    file: "effects/x/effect.json",
    fbos: [],
    steps: [],
    enabled,
    visibleBound: true,
    unsupported: ["effect:x"],
  }) as SceneEffect;

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

const EFFECT_BINDING = { property: "fx", target: { kind: "effect", object: 2, effect: 0 } };

/**
 * 三层场景：图层 0..2 各挂一段 alpha 脚本；`s` 绑图层 1 的 `size`（对象级重编译目标），`h` 绑 `general/hdr`（场景级），`b` 绑图层 0 的 brightness
 * （就地），`fx` 绑图层 2 的带不支持项的 effect。
 */
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
    layers: [layer(0), layer(1), layer(2, { effects: [effect(false)] })],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [
      { property: "s", target: { kind: "recompile", reason: "layer-structure", path: "objects/1/size" } },
      { property: "h", target: { kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" } },
      { property: "b", target: { kind: "layer", object: 0, field: "brightness" } },
      EFFECT_BINDING,
    ],
    scripts: { list: [0, 1, 2].map(script) },
    configs: [0, 1, 2].map((object) => normalizeConfig(CONFIG(object))),
  } as unknown as SceneBundle;
}

/** 会话编出的片段：图层尺寸 96×48（和整场编的不同，看得出是谁编的）。 */
function deltaFor(request: FragmentRequest, extra: Partial<ObjectFragment> = {}): FragmentDelta {
  const object = request.object;
  return {
    fragment: {
      object,
      config: normalizeConfig(CONFIG(object)),
      layer: layer(object, { size: [96, 48] }),
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

type ScriptTargetLike = { kind: string; reason?: string; path?: string };
type Internals = {
  live: { cache: { size: number } } | null;
  registry: { bundle: SceneBundle } | null;
  scriptOverrides: Map<string, unknown>;
  writeScript(target: ScriptTargetLike, value: unknown): boolean;
};
/** 脚本写一个重编译类目标（同 API 的文本字段 `font` 写入：`{ kind: "recompile", path }`）。 */
const writeRecompile = (host: InstanceType<typeof SceneHost>, path: string, value: unknown) =>
  (host as unknown as Internals).writeScript({ kind: "recompile", reason: "layer-structure", path }, value);

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

async function open(properties: Record<string, { type: string; value: unknown }> = {}) {
  const reporter = report();
  const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
  host.applyUserProperties({ fx: { type: "bool", value: false }, ...properties });
  await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
  return { host, reporter, internals: host as unknown as Internals };
}

/** 从现在起第 `step` 次 `update`（三段脚本，每帧三次：对象 0、1、2）跑一次 `action`。 */
function atUpdate(step: number, action: () => void) {
  let count = 0;
  onUpdate = () => {
    if (++count === step) action();
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const registryLayer = (internals: Internals, object: number) =>
  internals.registry!.bundle.layers.find((item) => item.object === object);

beforeEach(() => {
  vi.stubGlobal("__SCENE_DEV__", false);
  vi.stubGlobal("document", {});
  events.length = 0;
  sessions.length = 0;
  onInit = null;
  onUpdate = null;
  compileGate = null;
  gpu.installed = [];
  gpu.removed = [];
  gpu.writes = [];
  compile.mockReset().mockImplementation(async () => sceneBundle());
});
afterEach(() => vi.unstubAllGlobals());

describe("分级与替换（L6 点 3）", () => {
  it("脚本写对象级目标：只编那个对象（累计覆盖、父、骨骼、属性），下一帧开头替换登记表 / 状态 / GPU；不整场重编译、不进缓存", async () => {
    const { host, internals } = await open();
    const cacheSize = internals.live!.cache.size;
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    writeRecompile(host, "objects/0/font", "fonts/c.ttf");
    const requests = sessions[0].requests.map((item) => item.request);
    expect(requests).toEqual([
      expect.objectContaining({ object: 1, overrides: { font: "fonts/b.ttf" }, parent: null, bone: null, config: "" }),
      expect.objectContaining({ object: 0, overrides: { font: "fonts/c.ttf" } }),
    ]);
    expect(requests[0].properties).toMatchObject({ fx: false });
    const stateBefore = renderer.sceneState!.layers.get(1);
    sessions[0].requests[0].resolve(deltaFor(requests[0]));
    await flush();
    // 到达不改状态：等下一帧开头
    expect(registryLayer(internals, 1)!.size).toEqual([64, 32]);
    expect(renderer.sceneState!.layers.get(1)).toBe(stateBefore);
    renderer.tick();
    expect(registryLayer(internals, 1)!.size).toEqual([96, 48]);
    // 状态里这个对象换成编好的（新的一份）
    expect(renderer.sceneState!.layers.get(1)).not.toBe(stateBefore);
    expect(gpu.installed).toEqual([1]);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    expect(host.stats.recompiledObjects).toBe(2);
    expect(internals.live!.cache.size).toBe(cacheSize);
    // 覆盖表照记（整场重载的兜底读它）
    expect(internals.scriptOverrides.get("objects/1/font")).toBe("fonts/b.ttf");
    host.dispose();
  });

  it("场景级（general/hdr）：照旧整场重编译，不向会话要片段", async () => {
    const { host } = await open();
    writeRecompile(host, "general/hdr", true);
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(sessions[0].requests).toEqual([]);
    expect(host.stats.recompiled).toEqual([{ reason: "script（general/hdr）", keys: [] }]);
    expect(host.stats.recompiledObjects).toBe(0);
    host.dispose();
  });

  it("被依赖的图层（别的图层绑它的独占合成 RT）也走单对象重编译（L6b）：不整场重编译，GPU 照常替换", async () => {
    compile.mockImplementation(async () => {
      const result = sceneBundle();
      result.layers[1].dependedOn = true;
      return result;
    });
    const { host, internals } = await open();
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    const requests = sessions[0].requests.map((item) => item.request);
    expect(requests).toEqual([expect.objectContaining({ object: 1, overrides: { font: "fonts/b.ttf" } })]);
    sessions[0].requests[0].resolve(deltaFor(requests[0]));
    await flush();
    renderer.tick();
    expect(registryLayer(internals, 1)!.size).toEqual([96, 48]);
    expect(gpu.installed).toEqual([1]);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiled).toEqual([]);
    expect(host.stats.recompiledObjects).toBe(1);
    host.dispose();
  });

  it("替换保留运行中写过的字段（replayWritesFor）与对象表里的位置", async () => {
    const { host } = await open();
    // 第 2 次 update 是对象 1 的脚本：API 写它的 origin
    atUpdate(2, () => {
      (activeGlobal.thisLayer as { origin: Vec }).origin = new Vec(5, 6, 7);
    });
    renderer.tick();
    onUpdate = null;
    expect(renderer.sceneState!.layers.get(1)!.origin).toEqual([5, 6, 7]);
    const order = [...renderer.sceneState!.order];
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    const { request, resolve } = sessions[0].requests[0];
    resolve(deltaFor(request));
    await flush();
    const stateBefore = renderer.sceneState!.layers.get(1);
    renderer.tick();
    expect(renderer.sceneState!.layers.get(1)).not.toBe(stateBefore);
    expect(renderer.sceneState!.layers.get(1)!.origin).toEqual([5, 6, 7]);
    expect(renderer.sceneState!.order).toEqual(order);
    host.dispose();
  });

  it("连写 10 次只编 2 次：在编时只记最新的，到达后丢掉这份按最新的再发；最后一次胜出", async () => {
    const { host, internals } = await open();
    for (let i = 0; i < 10; i++) writeRecompile(host, "objects/1/font", `fonts/${i}.ttf`);
    expect(sessions[0].requests.map((item) => item.request.overrides)).toEqual([{ font: "fonts/0.ttf" }]);
    sessions[0].requests[0].resolve(deltaFor(sessions[0].requests[0].request));
    await flush();
    renderer.tick();
    // 过期的那份没换上
    expect(registryLayer(internals, 1)!.size).toEqual([64, 32]);
    expect(sessions[0].requests.map((item) => item.request.overrides)).toEqual([
      { font: "fonts/0.ttf" },
      { font: "fonts/9.ttf" },
    ]);
    sessions[0].requests[1].resolve(deltaFor(sessions[0].requests[1].request));
    await flush();
    renderer.tick();
    expect(registryLayer(internals, 1)!.size).toEqual([96, 48]);
    expect(gpu.installed).toEqual([1]);
    expect(host.stats.recompiledObjects).toBe(10);
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("到达前对象已删：丢弃，不装", async () => {
    const { host } = await open();
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    atUpdate(1, () => {
      const scene = activeGlobal.thisScene as { getLayer(name: string): unknown; destroyLayer(layer: unknown): void };
      scene.destroyLayer(scene.getLayer("L1"));
    });
    renderer.tick();
    onUpdate = null;
    expect(renderer.sceneState!.layers.has(1)).toBe(false);
    sessions[0].requests[0].resolve(deltaFor(sessions[0].requests[0].request));
    await flush();
    renderer.tick();
    expect(gpu.installed).toEqual([]);
    expect(renderer.sceneState!.layers.has(1)).toBe(false);
    host.dispose();
  });

  it("不支持项：状态与登记表照替换，卸掉旧的 GPU 运行时、report.unsupported，场景不退回", async () => {
    const { host, reporter, internals } = await open();
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    const { request, resolve } = sessions[0].requests[0];
    resolve(deltaFor(request, { unsupported: ["text:x"] }));
    await flush();
    renderer.tick();
    expect(registryLayer(internals, 1)!.size).toEqual([96, 48]);
    expect(gpu.removed).toEqual([1]);
    expect(gpu.installed).toEqual([]);
    expect(reporter.unsupported).toHaveBeenCalledWith(["text:x"]);
    expect(reporter.fallback).not.toHaveBeenCalled();
    host.dispose();
  });

  it("sceneFlips：整场重载（覆盖表带着写入）", async () => {
    const { host } = await open();
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    const { request, resolve } = sessions[0].requests[0];
    resolve(deltaFor(request, { sceneFlips: ["lights"] }));
    await flush();
    renderer.tick();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect((compile.mock.calls[1][0] as { scriptOverrides: unknown }).scriptOverrides).toEqual({
      "objects/1/font": "fonts/b.ttf",
    });
    expect(host.stats.recompiled.some((item) => item.reason.includes("重编译对象 1 翻转了场景级不变量"))).toBe(true);
    host.dispose();
  });
});

describe("属性（applyChanges，L6 点 3）", () => {
  it("对象级重编译绑定（size）：只编那个对象，覆盖不带属性值（会话按属性取）", async () => {
    const { host } = await open({ s: { type: "slider", value: 1 } });
    host.applyUserProperties({ s: { type: "slider", value: 2 } });
    expect(sessions[0].requests.map((item) => item.request)).toEqual([
      expect.objectContaining({ object: 1, overrides: {}, properties: expect.objectContaining({ s: 2 }) }),
    ]);
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(host.stats.recompiledObjects).toBe(1);
    host.dispose();
  });

  it("打开带不支持项的 effect：挡下的那条不写、同批别的照常就地写，对象交给单对象重编译", async () => {
    const { host } = await open({ b: { type: "slider", value: 1 } });
    gpu.writes = [];
    host.applyUserProperties({ fx: { type: "bool", value: true }, b: { type: "slider", value: 0.5 } });
    expect(gpu.writes).toHaveLength(1);
    expect(gpu.writes[0].map((write) => write.binding.target)).toEqual([
      { kind: "layer", object: 0, field: "brightness" },
    ]);
    expect(sessions[0].requests.map((item) => item.request.object)).toEqual([2]);
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("同批有场景级（general/hdr）：整场重编译，不向会话要片段", async () => {
    const { host } = await open({ h: { type: "bool", value: false }, s: { type: "slider", value: 1 } });
    host.applyUserProperties({ h: { type: "bool", value: true }, s: { type: "slider", value: 2 } });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    expect(sessions[0].requests).toEqual([]);
    host.dispose();
  });

  it("在编期间属性又改了这个对象的绑定（就地写了）：合并，到达后按当前属性再发", async () => {
    const { host } = await open({ s: { type: "slider", value: 1 } });
    writeRecompile(host, "objects/2/font", "fonts/b.ttf");
    // 打开再关回去：开的那次被挡下（在编，合并），关的那次就地写（状态里本来就关着）——同样合并
    host.applyUserProperties({ fx: { type: "bool", value: true } });
    host.applyUserProperties({ fx: { type: "bool", value: false } });
    expect(sessions[0].requests).toHaveLength(1);
    sessions[0].requests[0].resolve(deltaFor(sessions[0].requests[0].request));
    await flush();
    renderer.tick();
    expect(sessions[0].requests).toHaveLength(2);
    expect(sessions[0].requests[1].request).toMatchObject({
      object: 2,
      overrides: { font: "fonts/b.ttf" },
      properties: expect.objectContaining({ fx: false }),
    });
    expect(gpu.installed).toEqual([]);
    host.dispose();
  });
});

describe("首次加载与重载进行中（L6 点 3）", () => {
  it("init 里写的对象级目标：不二次编译，片段到齐接进 bundle，建 GPU 场景时就带编好的；同一对象写两次等到队空", async () => {
    let first = true;
    onInit = () => {
      if (!first) return;
      first = false;
      const host = hostRef!;
      writeRecompile(host, "objects/1/font", "fonts/a.ttf");
      writeRecompile(host, "objects/1/font", "fonts/b.ttf");
      // init 期间会话就收到第一份；当场回（宿主在 init 之后等它）
      const { request, resolve } = sessions[0].requests[0];
      resolve(deltaFor(request, { layer: layer(1, { size: [10, 10] }) }));
    };
    // 第二份（合并后再发的）到了再回
    const answer = setInterval(() => {
      const second = sessions[0]?.requests[1];
      if (second) {
        clearInterval(answer);
        second.resolve(deltaFor(second.request));
      }
    }, 1);
    const reporter = report();
    let hostRef: InstanceType<typeof SceneHost> | null = null;
    const host = (hostRef = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, {
      imageId: "1",
      report: reporter,
    }));
    host.applyUserProperties({ fx: { type: "bool", value: false } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    clearInterval(answer);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(sessions[0].requests.map((item) => item.request.overrides)).toEqual([
      { font: "fonts/a.ttf" },
      { font: "fonts/b.ttf" },
    ]);
    expect(renderer.loadedLayers.find((item) => item.object === 1)!.size).toEqual([96, 48]);
    expect(events.filter((event) => event === "render")).toHaveLength(1);
    // GPU 场景从 bundle 一起建，不另装
    expect(gpu.installed).toEqual([]);
    host.dispose();
  });

  it("整场重载进行中（新场景还没换上）写的：照旧整场再重载一次；新场景换上之后写的交给新会话", async () => {
    const { host } = await open();
    let release!: () => void;
    compileGate = new Promise((resolve) => (release = resolve));
    host.setSceneSettings({ postprocess: "enabled", reflection: "follow", shadows: "follow" });
    await flush();
    writeRecompile(host, "objects/1/font", "fonts/b.ttf");
    expect(sessions[0].requests).toEqual([]);
    compileGate = null;
    release();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3));
    expect((compile.mock.calls[2][0] as { scriptOverrides: unknown }).scriptOverrides).toEqual({
      "objects/1/font": "fonts/b.ttf",
    });
    await vi.waitFor(() => expect(events.filter((event) => event === "render")).toHaveLength(3));
    writeRecompile(host, "objects/1/font", "fonts/c.ttf");
    expect(sessions.at(-1)!.requests.map((item) => item.request.overrides)).toEqual([{ font: "fonts/c.ttf" }]);
    host.dispose();
  });

  it("运行中建的层到达时属性已变、绑定被挡下（片段过期）：再编一次，请求带它的配置原文", async () => {
    const { host } = await open();
    const NEW = { image: "models/b.json", name: "new" };
    atUpdate(1, () => {
      (activeGlobal.thisScene as { createLayer(config: unknown): unknown }).createLayer(NEW);
    });
    renderer.tick();
    onUpdate = null;
    const create = sessions[0].requests[0];
    expect(create.request.object).toBe(3);
    // 片段在编期间打开 fx：新对象还不在登记表里，这次改动影响不到它
    host.applyUserProperties({ fx: { type: "bool", value: true } });
    sessions[0].requests.length = 0;
    // 编出来的片段按发请求那一刻的属性：effect 关着、带不支持项、开关绑 fx
    create.resolve(
      deltaFor(create.request, {
        layer: layer(3, { size: [96, 48], effects: [effect(false)] }),
        bindings: [{ property: "fx", target: { kind: "effect", object: 3, effect: 0 } }],
      } as Partial<ObjectFragment>),
    );
    await flush();
    renderer.tick();
    expect(sessions[0].requests.map((item) => item.request)).toEqual([
      expect.objectContaining({ object: 3, overrides: {}, properties: expect.objectContaining({ fx: true }) }),
    ]);
    expect(JSON.parse(sessions[0].requests[0].request.config)).toMatchObject(NEW);
    host.dispose();
  });
});
