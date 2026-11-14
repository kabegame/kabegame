/**
 * 宿主的系统媒体集成接线（P11c 步骤 2）：
 * - `bundle.media` 时订阅 `kind: "media"`（只订一次），消息进 `MediaPending`，`windowupdaterate` 间隔的计时器切成事件推进场景队列；
 * - 每帧脚本阶段最开头取空：先封面换名（位图交来源表、增量走属性路径，导出了 `applyUserProperties` 的脚本收到 `{}`），再依次调五个回调；
 * - `init` 之后、首次 `applyUserProperties` 之前补发 `{ enabled: true }`；
 * - 订阅被拒时脚本收到 `{ enabled: false }`；没有脚本的场景（只有封面纹理）也派发、同帧换纹理。
 * 渲染器、realm 是替身（同 `host.script.test.ts`），封面解码用假的 `createImageBitmap`，来源表与 `MediaPending` 是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./compile/bindings";
import type { SceneBundle, SceneLayer } from "./compile/bundle";
import { SceneState } from "./render/state";

const log: string[] = [];
const compile = vi.fn<() => Promise<SceneBundle>>();
const channels = vi.hoisted(() => [] as { onmessage: (message: unknown) => void }[]);
const invokeMock = vi.hoisted(() => vi.fn());
let renderer: FakeRenderer;

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}

const json = (value: unknown) => JSON.stringify(value);

function createRealm() {
  return {
    global: { Object, Array, JSON },
    prototypes: { Vec2: {}, Vec3: Vec3.prototype, Vec4: {}, Mat3: {}, Mat4: {} },
    internal: { updateScriptProperties() {}, convertUserProperties: (text: string) => JSON.parse(text) },
    async importModule() {
      return {
        init: () => void log.push("init"),
        applyUserProperties: (properties: unknown) => void log.push(`apply ${json(properties)}`),
        mediaStatusChanged: (event: unknown) => void log.push(`status ${json(event)}`),
        mediaPlaybackChanged: (event: unknown) => void log.push(`playback ${json(event)}`),
        mediaPropertiesChanged: (event: Record<string, unknown>) => void log.push(`properties ${event.title}`),
        mediaThumbnailChanged: (event: Record<string, unknown>) =>
          void log.push(`thumbnail ${event.hasThumbnail} ${Math.round((event.primaryColor as Vec3).x * 255)}`),
        mediaTimelineChanged: (event: unknown) => void log.push(`timeline ${json(event)}`),
      };
    },
    dispose() {},
  };
}

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  constructor(private readonly beforeFrame?: (dt: number) => void) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
  }
  /** 一个实时帧：宿主的 `beforeFrame`（脚本阶段）。 */
  tick() {
    this.beforeFrame?.(1 / 60);
  }
  setStyle() {}
  setBackground() {}
  setPaused() {}
  applyBindings(writes: { binding: Parameters<SceneState["write"]>[0]; value: Parameters<SceneState["write"]>[1] }[]) {
    for (const write of writes) this.sceneState!.write(write.binding, write.value);
    return true;
  }
  redraw() {}
  destroy() {}
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./compile/client", () => ({ compileSceneInWorker: () => compile() }));
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => createRealm(),
}));
vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async (_canvas: unknown, options: { beforeFrame?: (dt: number) => void }) =>
      (renderer = new FakeRenderer(options.beforeFrame)),
  },
}));

const { SceneHost } = await import("./host");

const layer = () =>
  ({
    id: 1,
    object: 0,
    parent: null,
    name: "layer0",
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
    group: null,
    subtree: [],
    effects: [],
    passes: [],
    colorBlendMode: 0,
    passthrough: null,
    particle: null,
  }) as unknown as SceneLayer;

function bundle(options: { media: boolean; scripts: boolean; system: boolean }): SceneBundle {
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
    layers: [layer()],
    programs: [],
    textures: [],
    userTextures: options.system ? [{ kind: "system", name: "$mediaThumbnail" }] : [],
    bloom: null,
    unsupported: [],
    media: options.media,
    bindings: options.system
      ? [
          { property: "$mediaThumbnail", target: { kind: "user-texture", name: "$mediaThumbnail" } },
          { property: "$mediaPreviousThumbnail", target: { kind: "user-texture", name: "$mediaPreviousThumbnail" } },
        ]
      : [],
    scripts: {
      list: options.scripts
        ? [
            {
              id: "objects/0/alpha",
              source: "script",
              target: { kind: "layer", object: 0, field: "alpha" },
              valueType: "float",
              initial: 1,
              owner: { kind: "layer", object: 0 },
              layer: 0,
              scriptProperties: null,
              imports: [],
              errors: [],
            },
          ]
        : [],
    },
  } as unknown as SceneBundle;
}

const reporter = () => ({
  ready: vi.fn(),
  fallback: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

const COLORS = [
  [200, 39, 39],
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [255, 255, 255],
];

describe("SceneHost 的媒体集成（P11c 步骤 2）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    // 脚本 realm 是假的，`document` 只是传给它的参数
    vi.stubGlobal("document", {});
    log.length = 0;
    channels.length = 0;
    compile.mockReset();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "wpe_scene_target") return { path: "P:/p", sceneAssets: ["P:/we/assets"] };
      if (command === "wpe_web_media_subscribe") return undefined;
      return "disabled";
    });
    // WPE 的 config.json：刷新间隔 50 ms（读得到才用它，不用等 1 s）；封面解码按 PNG 位图给 20×10
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/we/config.json")
        ? new Response(json({ "?install": {}, user: { general: { user: { windowupdaterate: 50 } } } }))
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("createImageBitmap", async () => ({ width: 20, height: 10, close() {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function open(options: { media?: boolean; scripts?: boolean; system?: boolean } = {}) {
    const full = { media: true, scripts: true, system: false, ...options };
    compile.mockImplementation(async () => bundle(full));
    const report = reporter();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report });
    host.applyUserProperties({});
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    return { host, report };
  }

  const props = {
    type: "properties",
    title: "Song",
    artist: "A",
    albumArtist: "",
    albumTitle: "",
    subTitle: "",
    genres: "x,y",
    contentType: "music",
  };

  it("订阅 kind: media 只订一次；读 config.json 的 windowupdaterate 当刷新间隔；init 之后、首次 applyUserProperties 之前补发 { enabled: true }", async () => {
    const { host } = await open();
    expect(invokeMock.mock.calls.filter(([command]) => command === "wpe_web_media_subscribe")).toEqual([
      ["wpe_web_media_subscribe", { kind: "media", channel: channels[0], imageId: "1" }],
    ]);
    expect(host.media()).toMatchObject({ active: true, subscribed: true, error: null, intervalMs: 50 });
    // init → 补发状态 → 首次 applyUserProperties（全集，含 WPE 内置属性）
    expect(log.slice(0, 2)).toEqual(["init", 'status {"enabled":true}']);
    expect(log[2]).toMatch(/^apply \{"alignment":/);
  });

  it("消息经合并与计时器进队列，每帧取空：状态 → 播放 → 属性 → 时间轴，然后封面（先换名当属性增量 apply {}，再封面回调）", async () => {
    const { host } = await open();
    log.length = 0;
    const channel = channels[0];
    channel.onmessage({ type: "playback", state: 2 });
    channel.onmessage({ type: "playback", state: 1 });
    channel.onmessage(props);
    channel.onmessage({ type: "timeline", position: 37, duration: 200 });
    channel.onmessage({ type: "sceneThumbnail", png: "AAAA", colors: COLORS });
    channel.onmessage({ type: "status", enabled: true });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(2));
    // 还没取：脚本没收到
    expect(log).toEqual([]);
    renderer.tick();
    expect(log).toEqual([
      'status {"enabled":true}',
      'playback {"state":1}',
      "properties Song",
      'timeline {"position":37,"duration":200}',
      "apply {}",
      "thumbnail true 200",
    ]);
    expect(host.media().scene).toMatchObject({
      queued: 0,
      name: "mediaThumbnail_1.system",
      counter: 2,
      state: 1,
      position: 37,
    });
    // 一次刷新给每个场景至多两个事件：先 0x1d 合成的、再封面（注意上面的顺序已经体现：封面在最后）
    expect(host.media().messages.map((item) => (item.message as { type: string }).type)).toEqual([
      "playback",
      "playback",
      "properties",
      "timeline",
      "sceneThumbnail",
      "status",
    ]);
  });

  it("封面同帧换纹理：位图交来源表、$mediaThumbnail 经绑定表写进状态，第二张时 $mediaPreviousThumbnail 是上一张的名字", async () => {
    const { host } = await open({ system: true });
    const channel = channels[0];
    log.length = 0;
    channel.onmessage({ type: "sceneThumbnail", png: "AAAA", colors: COLORS });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(1));
    renderer.tick();
    expect(renderer.sceneState!.userTextures.get("$mediaThumbnail")).toBe("mediaThumbnail_1.system");
    expect(host.userTextureProbe().find((item) => item.name === "$mediaThumbnail")).toMatchObject({
      value: "mediaThumbnail_1.system",
      status: "ready",
      width: 20,
      height: 10,
    });
    // 第一张没有 previous 键
    expect(renderer.sceneState!.userTextures.has("$mediaPreviousThumbnail")).toBe(false);
    channel.onmessage({ type: "sceneThumbnail", png: "BBBB", colors: COLORS });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(1));
    renderer.tick();
    expect(renderer.sceneState!.userTextures.get("$mediaThumbnail")).toBe("mediaThumbnail_2.system");
    expect(renderer.sceneState!.userTextures.get("$mediaPreviousThumbnail")).toBe("mediaThumbnail_1.system");
    expect(host.userTextureProbe().find((item) => item.name === "$mediaPreviousThumbnail")).toMatchObject({
      value: "mediaThumbnail_1.system",
      status: "ready",
    });
  });

  it("没有脚本的场景（只有封面纹理）也派发：换纹理照常，回调是空操作", async () => {
    const { host } = await open({ scripts: false, system: true });
    channels[0].onmessage({ type: "sceneThumbnail", png: "AAAA", colors: COLORS });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(1));
    renderer.tick();
    expect(host.userTextureProbe().find((item) => item.name === "$mediaThumbnail")?.status).toBe("ready");
    expect(log).toEqual([]);
  });

  it("没有封面（png 为空）也换名、封面槽回缺省（status empty）；回调里 hasThumbnail 为假", async () => {
    const { host } = await open({ system: true });
    log.length = 0;
    channels[0].onmessage({ type: "sceneThumbnail", png: "", colors: [] });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(1));
    renderer.tick();
    expect(host.userTextureProbe().find((item) => item.name === "$mediaThumbnail")).toMatchObject({
      value: "mediaThumbnail_1.system",
      status: "empty",
    });
    expect(log).toEqual(["apply {}", "thumbnail false 0"]);
  });

  it("订阅被拒：当场把 { enabled: false } 推进队列（不经合并），下一帧脚本收到；记 debug", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "wpe_scene_target") return { path: "P:/p", sceneAssets: ["P:/we/assets"] };
      if (command === "wpe_web_media_subscribe") throw new Error("需要 Windows");
      return "disabled";
    });
    const { host, report } = await open();
    await vi.waitFor(() => expect(host.media().error).toContain("需要 Windows"));
    log.length = 0;
    renderer.tick();
    expect(log).toEqual(['status {"enabled":false}']);
    expect(host.media().subscribed).toBe(false);
    expect(report.debug.mock.calls.some(([text]) => String(text).includes("媒体订阅被拒"))).toBe(true);
  });

  it("没有接入媒体集成（bundle.media 为假）：不订阅、不建状态", async () => {
    const { host } = await open({ media: false });
    expect(invokeMock.mock.calls.some(([command]) => command === "wpe_web_media_subscribe")).toBe(false);
    expect(host.media()).toMatchObject({ active: false, scene: null });
  });

  it("读不到 windowupdaterate：用 1000 ms 并记一条 debug", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const { host, report } = await open();
    expect(host.media().intervalMs).toBe(1000);
    expect(report.debug.mock.calls.some(([text]) => String(text).includes("windowupdaterate"))).toBe(true);
  });

  it("暂停积压：不调 tick 期间事件留在队列，恢复后第一帧按先后全部派发，封面每条各换一次名字", async () => {
    const { host } = await open({ system: true });
    const channel = channels[0];
    log.length = 0;
    channel.onmessage({ type: "sceneThumbnail", png: "AAAA", colors: COLORS });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(1));
    channel.onmessage({ type: "sceneThumbnail", png: "BBBB", colors: COLORS });
    await vi.waitFor(() => expect(host.media().scene!.queued).toBe(2));
    expect(host.media().scene!.counter).toBe(1);
    renderer.tick();
    expect(log.filter((line) => line.startsWith("apply"))).toEqual(["apply {}", "apply {}"]);
    expect(host.media().scene).toMatchObject({
      counter: 3,
      name: "mediaThumbnail_2.system",
      previousName: "mediaThumbnail_1.system",
    });
  });
});
