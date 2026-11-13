/**
 * 宿主的 `IVideoTexture` 接线（P9b 点 4）：脚本拿到的落点就是这段视频区间的播放器；重编译期间（脚本还在用旧 bundle、`SceneVideos`
 * 已按新 bundle 重建下标表）按旧 bundle 仍取到同一个播放器，换上新场景之后照样；登记过的结束回调跟着播放器、在登记它的脚本上下文里调。
 * `SceneVideos` 与播放器是真的：`<video>` 换成 `FakeVideo`，`fetch(file:)` 按 Range 回对应长度。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "./compile/bundle";
import { SceneState } from "./render/state";
import type { VideoSink } from "./video/sceneVideos";
import { FakeVideo } from "./video/fakeVideo";
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
/** `document.createElement("video")` 建出的替身，按建的顺序。 */
let elements: FakeVideo[] = [];

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
      async importModule() {
        return {
          init() {
            onInit?.();
          },
        };
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

const A: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 164, duration: 2.55 };
const B: SceneVideoSource = { path: "P:/p/scene.pkg", start: 200, end: 232, duration: 1 };

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
    elements = [];
    sink = null;
    loadGate = null;
    onInit = null;
    listeners.clear();
    vi.stubGlobal("document", {
      createElement: () => {
        const element = new FakeVideo();
        elements.push(element);
        return element;
      },
    });
    // 按区间读：回 Range 对应的长度（CEF 的 `file:` 回 200、只给区间）
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!;
      return new Response(new Uint8Array(Number(range[2]) - Number(range[1]) + 1));
    });
    compile.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

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
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    const [a] = elements;
    a.loadData(2.516667);
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    const v = video!;
    expect(v).not.toBeNull();
    // 容器时长（float32），不是元素的 2.516667
    expect(v.duration).toBe(Math.fround(2.55));
    v.pause();
    expect(host.videos()[0]).toMatchObject({ start: 100, wantPlay: false, textures: [0] });
    expect(v.isPlaying()).toBe(false);
    v.play();
    v.rate = 2;
    v.setCurrentTime(1);
    expect([a.playbackRate, a.currentTime, host.videos()[0].wantPlay]).toEqual([2, 1, true]);

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
    listeners.get("setting-change")!({ payload: { wpeScenePostprocess: "enabled" } });
    await vi.waitFor(() => expect(elements).toHaveLength(2));
    const [, b] = elements;
    const probe = () => Object.fromEntries(host.videos().map((item) => [item.start, item]));
    // SceneVideos 已按新 bundle 重建下标表；脚本还在用旧 bundle（图层 0 槽 0 = 下标 0）
    expect(probe()[100].textures).toEqual([1]);
    expect(probe()[200].textures).toEqual([0]);
    expect((initLayer as Record<string, () => VideoApi>).getVideoTexture()).toBe(v);
    v.pause();
    v.rate = 0.5;
    expect([probe()[100].wantPlay, probe()[200].wantPlay]).toEqual([false, true]);
    expect([a.playbackRate, b.playbackRate]).toEqual([0.5, 1]);
    expect(v.duration).toBe(Math.fround(2.55));

    // 换上新场景：脚本看新 bundle（图层 0 槽 0 = 下标 1），照样是 A
    open();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(reporter.debug.mock.calls.some(([message]) => String(message).includes("重新加载"))).toBe(true),
    );
    v.play();
    expect([probe()[100].wantPlay, probe()[200].wantPlay]).toEqual([true, true]);
    v.pause();
    expect([probe()[100].wantPlay, probe()[200].wantPlay]).toEqual([false, true]);

    // 结束回调登记在 A 的播放器上，跨重编译还在；在登记它的脚本（图层 0）上下文里调
    v.play();
    v.loop = 0;
    sink!.beginFrame();
    a.ended = true;
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
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    elements[0].loadData(2.516667);
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
    listeners.get("setting-change")!({ payload: { wpeScenePostprocess: "enabled" } });
    await vi.waitFor(() => expect(elements).toHaveLength(2));
    const probe = () => Object.fromEntries(host.videos().map((item) => [item.start, item]));
    v.pause();
    expect([probe()[100].wantPlay, probe()[200].wantPlay]).toEqual([false, true]);
    expect(v.duration).toBe(Math.fround(2.55));

    open();
    await vi.waitFor(() =>
      expect(reporter.debug.mock.calls.some(([message]) => String(message).includes("重新加载"))).toBe(true),
    );
    v.play();
    v.pause();
    // 换上之后图层 0 是 B：暂停落在 B 上，A 保持之前的状态
    expect([probe()[100].wantPlay, probe()[200].wantPlay]).toEqual([false, false]);
    expect(v.duration).toBe(Math.fround(1));
    host.dispose();
  });
});
