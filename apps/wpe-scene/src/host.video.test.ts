/**
 * 宿主的 `IVideoTexture` 接线（P9b 点 4）：脚本拿到的落点就是这段视频区间的播放器；重编译期间（脚本还在用旧 bundle、`SceneVideos`
 * 已按新 bundle 重建下标表）按旧 bundle 仍取到同一个播放器，换上新场景之后照样；登记过的结束回调跟着播放器、在登记它的脚本上下文里调。
 * `SceneVideos` 与播放器是真的（P9d 步骤 2b：`CodecVideoPlayer`）：`VideoDecoder` 换成解码器替身，`fetch(file:)` 按 Range 回虚拟文件里手造的 MP4，
 * 墙钟由测试控制。
 */
import { fakeModule } from "./script/testing/fakeModule";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "./compile/bundle";
import { SceneState } from "./render/state";
import type { VideoSink } from "./video/sceneVideos";
import { buildMp4 } from "./video/demux/testMp4";
import { FakeDecoder, newFakeEnv } from "./video/fakeDecoder";
import type { SceneVideoSource } from "./video/player";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const compile = vi.fn<() => Promise<SceneBundle>>();
/** 脚本 `init` 里做的事。 */
let onInit: (() => void) | null = null;
/** 当前 realm 的全局（`thisLayer` 由 `ScriptApi` 装在上面）。 */
let activeGlobal: Record<string, unknown> = {};
/** 渲染器换场景（`beforeFirstFrame`）之前停在这里；null = 不停。 */
let loadGate: Promise<void> | null = null;
/** 渲染器拿到的 `videos`（宿主的 sink）：`beginFrame` 推进帧号、判定结束。 */
let sink: VideoSink | null = null;
/** 解码器替身的共享状态（打开的帧数等）。 */
const fake = newFakeEnv();
/** 播放器的墙钟（毫秒）：不推进就不走。 */
let nowMs = 0;

/** 8 帧、每帧 0.125 s、时长 1 s 的 MP4，放在虚拟文件的 100 与 900 处（两段视频的区间）。 */
const MP4 = buildMp4({
  sizes: Array.from({ length: 8 }, () => 10),
  perChunk: [8],
  stts: [[8, 125]],
  timescale: 1000,
  stss: [1, 5],
  movie: [1000, 1000],
}).bytes;
const FILE = new Uint8Array(2000);
FILE.set(MP4, 100);
FILE.set(MP4, 900);

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async (command: string) =>
    command === "wpe_scene_target" ? { path: "P:/p", sceneAssets: [] } : "disabled",
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("./compile/client", () => ({ compileSceneInWorker: () => compile() }));
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => {
    activeGlobal = { Object, Array };
    return {
      global: activeGlobal,
      prototypes: { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} },
      internal: {
        updateScriptProperties() {},
        convertUserProperties: (json: string) => JSON.parse(json),
      },
      async prepareModule() {
        return fakeModule({
          init() {
            onInit?.();
          },
        });
      },
      dispose() {},
    };
  },
}));

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    await loadGate;
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
  }
  setStyle() {}
  setBackground() {}
  setPaused() {}
  applyBindings() {
    return true;
  }
  redraw() {}
  destroy() {}
}
vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async (_canvas: unknown, options: { videos: VideoSink }) => {
      sink = options.videos;
      return new FakeRenderer();
    },
  },
}));

const { SceneHost } = await import("./host");

const A: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 100 + MP4.length, duration: 2.55 };
const B: SceneVideoSource = { path: "P:/p/scene.pkg", start: 900, end: 900 + MP4.length, duration: 1 };

function layer(object: number, slot0: number): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer${object}`,
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
    passes: [
      {
        key: `objects/${object}/passes/0`,
        program: null,
        blending: "normal",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: { 0: slot0 },
        runtime: {},
        uniforms: {},
        framebuffer: false,
      } as ScenePass,
    ],
    effects: [],
    colorBlendMode: 0,
    passthrough: null,
    particle: null,
  } as SceneLayer;
}

/** `layers`：每项 `[对象下标, 槽 0 的纹理下标]`；`videos`：纹理表（全是视频）。脚本挂在图层 0 上。 */
function bundle(layers: [number, number][], videos: SceneVideoSource[]): SceneBundle {
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
    layers: layers.map(([object, slot0]) => layer(object, slot0)),
    programs: [],
    textures: videos.map((video, index) => ({ path: `materials/v${index}.tex`, video: { ...video } }) as SceneTexture),
    bloom: null,
    unsupported: [],
    bindings: [],
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
          scriptProperties: null,
          imports: [],
          errors: [],
        },
      ],
    },
  } as SceneBundle;
}

function report() {
  return { ready: vi.fn(), fallback: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

type VideoApi = Record<string, unknown> & {
  play(): void;
  pause(): void;
  setCurrentTime(time: number): void;
  isPlaying(): boolean;
  addEndedCallback(callback: () => void): void;
};

describe("SceneHost 的 IVideoTexture（P9b）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    sink = null;
    nowMs = 0;
    fake.opened = 0;
    fake.decoders = [];
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    loadGate = null;
    onInit = null;
    listeners.clear();
    vi.stubGlobal("document", {});
    // WebCodecs 替身：解码器按喂入顺序吐出假帧，配置都支持
    vi.stubGlobal(
      "VideoDecoder",
      class {
        static isConfigSupported = async () => ({ supported: true });
        private readonly inner: FakeDecoder;
        constructor(init: { output(frame: VideoFrame): void; error(error: unknown): void }) {
          this.inner = new FakeDecoder(fake, init, 0);
          fake.decoders.push(this.inner);
        }
        get decodeQueueSize() {
          return this.inner.decodeQueueSize;
        }
        configure = () => this.inner.configure();
        decode = (chunk: EncodedVideoChunkInit) => this.inner.decode(chunk);
        flush = () => this.inner.flush();
        reset = () => this.inner.reset();
        close = () => this.inner.close();
      },
    );
    vi.stubGlobal(
      "EncodedVideoChunk",
      class {
        constructor(init: EncodedVideoChunkInit) {
          Object.assign(this, init);
        }
      },
    );
    // 按区间读：回虚拟文件里 Range 对应的字节（CEF 的 `file:` 回 200、只给区间）
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!;
      return new Response(FILE.slice(Number(range[1]), Number(range[2]) + 1));
    });
    compile.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("落点是该区间的播放器；重编译换了下标，换场景前后都落到同一个播放器，结束回调跟着它走", async () => {
    compile.mockImplementation(async () => bundle([[0, 0]], [A]));
    let video: VideoApi | null = null;
    let initLayer: unknown = null;
    const ended: unknown[] = [];
    onInit = () => {
      initLayer = activeGlobal.thisLayer;
      video = (initLayer as Record<string, () => VideoApi>).getVideoTexture();
      video.addEndedCallback(() => ended.push(activeGlobal.thisLayer));
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    // 第一次 ready 等可见视频的第一帧
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const v = video!;
    expect(v).not.toBeNull();
    // 容器时长（float32），不是帧表里的 1 s
    expect(v.duration).toBe(Math.fround(2.55));
    v.pause();
    expect(host.videos()[0]).toMatchObject({ start: 100, wantPlay: false, textures: [0] });
    expect(v.isPlaying()).toBe(false);
    v.play();
    v.rate = 2;
    v.setCurrentTime(1);
    expect([host.videos()[0].currentTime, host.videos()[0].wantPlay]).toEqual([1, true]);

    // 重编译：新 bundle 里 A 挪到下标 1，下标 0 成了另一段视频 B（图层 1）。渲染器换场景之前停住
    let open!: () => void;
    loadGate = new Promise<void>((resolve) => (open = resolve));
    compile.mockImplementation(async () =>
      bundle(
        [
          [0, 1],
          [1, 0],
        ],
        [B, A],
      ),
    );
    host.setSceneSettings({ postprocess: "enabled", reflection: "follow", shadows: "follow" });
    await vi.waitFor(() => expect(host.videos()).toHaveLength(2));
    const probe = () => Object.fromEntries(host.videos().map((item) => [item.start, item]));
    // SceneVideos 已按新 bundle 重建下标表；脚本还在用旧 bundle（图层 0 槽 0 = 下标 0）
    expect(probe()[100].textures).toEqual([1]);
    expect(probe()[900].textures).toEqual([0]);
    expect((initLayer as Record<string, () => VideoApi>).getVideoTexture()).toBe(v);
    v.pause();
    v.rate = 0.5;
    expect([probe()[100].wantPlay, probe()[900].wantPlay]).toEqual([false, true]);
    expect(v.duration).toBe(Math.fround(2.55));

    // 换上新场景：脚本看新 bundle（图层 0 槽 0 = 下标 1），照样是 A
    open();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(reporter.debug.mock.calls.some(([message]) => String(message).includes("重新加载"))).toBe(true),
    );
    v.play();
    expect([probe()[100].wantPlay, probe()[900].wantPlay]).toEqual([true, true]);
    v.pause();
    expect([probe()[100].wantPlay, probe()[900].wantPlay]).toEqual([false, true]);

    // 结束回调登记在 A 的播放器上，跨重编译还在；在登记它的脚本（图层 0）上下文里调
    v.play();
    v.loop = 0;
    v.rate = 1;
    // 画到 A（新 bundle 里是下标 1）之后时钟起步；一步走过时长（2.55 s），下一个 beginFrame 的判定看到结束
    sink!.beginFrame();
    sink!.drawn(1);
    nowMs += 3000;
    sink!.beginFrame();
    sink!.beginFrame();
    expect(ended).toEqual([initLayer]);
    expect(activeGlobal.thisLayer).toBeNull();
    expect(v.isPlaying()).toBe(false);
    host.dispose();
  });

  it("重编译让图层换了视频：换上新场景之前脚本仍落在旧视频上（它还在画），之后落到新视频", async () => {
    compile.mockImplementation(async () => bundle([[0, 0]], [A]));
    let video: VideoApi | null = null;
    onInit = () => {
      video = (activeGlobal.thisLayer as Record<string, () => VideoApi>).getVideoTexture();
    };
    const reporter = report();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, { imageId: "1", report: reporter });
    host.applyUserProperties({ p: { type: "slider", value: 0.3 } });
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const v = video!;

    // 新 bundle：图层 0 的槽 0 换成 B（下标 1），A 仍在（给图层 1 用，所以不被释放）
    let open!: () => void;
    loadGate = new Promise<void>((resolve) => (open = resolve));
    compile.mockImplementation(async () =>
      bundle(
        [
          [0, 1],
          [1, 0],
        ],
        [A, B],
      ),
    );
    host.setSceneSettings({ postprocess: "enabled", reflection: "follow", shadows: "follow" });
    await vi.waitFor(() => expect(host.videos()).toHaveLength(2));
    const probe = () => Object.fromEntries(host.videos().map((item) => [item.start, item]));
    v.pause();
    expect([probe()[100].wantPlay, probe()[900].wantPlay]).toEqual([false, true]);
    expect(v.duration).toBe(Math.fround(2.55));

    open();
    await vi.waitFor(() =>
      expect(reporter.debug.mock.calls.some(([message]) => String(message).includes("重新加载"))).toBe(true),
    );
    v.play();
    v.pause();
    // 换上之后图层 0 是 B：暂停落在 B 上，A 保持之前的状态
    expect([probe()[100].wantPlay, probe()[900].wantPlay]).toEqual([false, false]);
    expect(v.duration).toBe(Math.fround(1));
    host.dispose();
  });
});
