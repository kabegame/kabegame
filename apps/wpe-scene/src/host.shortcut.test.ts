/**
 * P11d：宿主的快捷方式接线（`SceneHost.openUserShortcut` / 令牌 / 属性形状）。渲染器、realm 是替身（同 `host.script.test.ts` 的写法），
 * 渲染器替身按真渲染器 `stepCursor` 的顺序调 `cursor.input` → `cursor.events`（有派发时）→ `cursor.end`；其余用真的宿主、运行时、API、令牌。
 */
import { fakeModule } from "./script/testing/fakeModule";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./compile/bindings";
import type { SceneBundle } from "./compile/bundle";
import { SceneState } from "./render/state";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const compile = vi.fn<(input: unknown) => Promise<SceneBundle>>();
let renderer: FakeRenderer;
let activeGlobal: Record<string, unknown>;
/** 模块导出的光标回调（测试里按用例换）。 */
let cursorExports: Record<string, () => unknown> = {};
/** 脚本收到的 `applyUserProperties` 参数。 */
let applied: unknown[] = [];
/** 脚本读到的 `engine.userProperties`（`init` 时取）。 */
let initProps: unknown = null;
const invokes: { command: string; args: unknown }[] = [];
/** `wpe_scene_shortcut_icon` 的返回（ArrayBuffer）。 */
let iconBytes: ArrayBuffer = new ArrayBuffer(0);

class RealmSyntaxError extends SyntaxError {}

function createRealm() {
  activeGlobal = { Object, Array, JSON, SyntaxError: RealmSyntaxError };
  return {
    global: activeGlobal,
    prototypes: { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} },
    internal: {
      updateScriptProperties() {},
      convertUserProperties(json: string) {
        return JSON.parse(json);
      },
    },
    async prepareModule() {
      return fakeModule({
        init() {
          initProps = JSON.parse(JSON.stringify((activeGlobal.engine as { userProperties: unknown }).userProperties));
          return 0.8;
        },
        applyUserProperties(props: unknown) {
          applied.push(JSON.parse(JSON.stringify(props)));
        },
        ...cursorExports,
      });
    },
    dispose() {},
  };
}

interface CursorOptions {
  input(snapshot: { world: number[]; screen: number[]; leftDown: boolean }): void;
  events(dispatches: { object: number; callback: string; world: number[]; local: number[] }[]): void;
  end?(snapshot: { leftDown: boolean }): void;
  active(): boolean;
}

class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  constructor(readonly cursor: CursorOptions | undefined) {}
  async load(bundle: SceneBundle, options: { beforeFirstFrame?: (state: SceneState) => void }) {
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
  }
  /** 一个实时帧的光标：同 `stepCursor`（`input` → `events` 有派发才调 → `end`）。 */
  cursorFrame(down: boolean, callbacks: string[] = []) {
    const cursor = this.cursor!;
    const snapshot = { world: [0, 0, 0], screen: [0, 0], leftDown: down };
    cursor.input(snapshot);
    const dispatches = callbacks.map((callback) => ({ object: 0, callback, world: [0, 0, 0], local: [0, 0, 0] }));
    if (dispatches.length) cursor.events(dispatches);
    cursor.end?.(snapshot);
  }
  setPaused() {}
  setStyle() {}
  setBackground() {}
  applyBindings() {
    return true;
  }
  redraw() {}
  destroy() {}
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: unknown) => {
    invokes.push({ command, args });
    if (command === "wpe_scene_target") return { path: "P:/test", sceneAssets: [] };
    if (command === "wpe_scene_shortcut_icon") return iconBytes;
    return "disabled";
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  }),
}));
// 宿主经常驻编译会话拿 bundle（L2）：会话本身只用到 close 与 stats，这里是空壳
vi.mock("./compile/client", () => ({
  openSceneSession: async (input: never) => ({
    bundle: await compile(input),
    session: { close() {}, stats: null },
    exactConfigs: [],
  }),
}));
vi.mock("./script/realm", () => ({
  getJsModuleIndex: () => ({}),
  createIframeRealm: async () => createRealm(),
}));
vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async (_canvas: unknown, options: { cursor?: CursorOptions }) => {
      renderer = new FakeRenderer(options.cursor);
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

const BOUND = {
  type: "usershortcut",
  value: "0123456789abcdef",
  isbound: true,
  commandtype: "file",
  file: "notepad.exe",
};
const UNBOUND = { type: "usershortcut", value: "", isbound: false };

describe("SceneHost 快捷方式（P11d）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    vi.stubGlobal("document", {});
    applied = [];
    initProps = null;
    invokes.length = 0;
    cursorExports = {};
    iconBytes = new ArrayBuffer(0);
    compile.mockReset().mockImplementation(async () => bundle());
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load(properties: Record<string, unknown>) {
    const reporter = report();
    const posted: unknown[] = [];
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, {
      imageId: "img1",
      report: reporter,
      postToParent: (message) => posted.push(message),
    });
    host.applyUserProperties(properties as never);
    await vi.waitFor(() => expect(reporter.ready).toHaveBeenCalledOnce());
    return { host, posted };
  }

  /** 一次完整点击：按下 → 按住 → 松开，回调按名字挂在对应帧的派发里。 */
  function click(down: string[] = ["cursorDown"], up: string[] = ["cursorUp", "cursorClick"]) {
    renderer.cursorFrame(true, down);
    renderer.cursorFrame(true);
    renderer.cursorFrame(false, up);
  }

  it("engine.userProperties 里快捷方式项是 {type, value}（没有 isbound 等）；applyUserProperties 的增量带 isbound / commandtype / file", async () => {
    const { host } = await load({ s1: BOUND, empty: UNBOUND, speed: { type: "slider", value: 2 } });
    expect(initProps).toMatchObject({
      s1: { type: "usershortcut", value: BOUND.value },
      empty: { type: "usershortcut", value: "" },
      speed: { type: "slider", value: 2 },
    });
    expect(initProps as Record<string, unknown>).not.toHaveProperty("s1.isbound");
    expect(initProps as Record<string, unknown>).not.toHaveProperty("s1.file");
    // 首次整份交给脚本：convertUserProperties 替身原样回 JSON，所以能看到后端形状
    expect(applied[0]).toMatchObject({ s1: BOUND, empty: UNBOUND });
    // 之后的增量也原样带这三个字段
    applied.length = 0;
    host.applyUserProperties({ s1: { ...BOUND, value: "ffffffffffffffff", file: "calc.exe" } } as never);
    expect(applied.at(-1)).toEqual({
      s1: { ...BOUND, value: "ffffffffffffffff", file: "calc.exe" },
    });
    host.dispose();
  });

  it("按下沿的令牌在 cursorDown 派发之前就有：已配好的返回 true 并 postMessage {type, name}；同一次点击的 cursorClick 抛错", async () => {
    const log: string[] = [];
    const engine = () => activeGlobal.engine as { openUserShortcut(name: unknown): unknown };
    cursorExports = {
      cursorDown: () => void log.push(`down:${String(engine().openUserShortcut("s1"))}`),
      cursorClick: () => {
        try {
          engine().openUserShortcut("s1");
          log.push("click:returned");
        } catch (error) {
          log.push(`click:${(error as Error).message}`);
        }
      },
    };
    const { host, posted } = await load({ s1: BOUND });
    click();
    expect(log).toEqual(["down:true", "click:Cannot execute more than one user command per cursor click."]);
    expect(posted).toEqual([{ type: "kabegame:wpe-scene-shortcut", name: "s1" }]);
    host.dispose();
  });

  it("没有 cursorDown 时，松开那一帧的 cursorUp 用上令牌（令牌在松开帧的派发之后才收）；再下一次点击重新发", async () => {
    const log: string[] = [];
    const engine = () => activeGlobal.engine as { openUserShortcut(name: unknown): unknown };
    cursorExports = { cursorUp: () => void log.push(`up:${String(engine().openUserShortcut("s1"))}`) };
    const { host, posted } = await load({ s1: BOUND });
    click(["cursorDown"], ["cursorUp"]);
    click(["cursorDown"], ["cursorUp"]);
    expect(log).toEqual(["up:true", "up:true"]);
    expect(posted).toHaveLength(2);
    host.dispose();
  });

  it.each(["empty", "nope"])(
    "没配好的快捷方式 / 不存在的属性 %s：返回 false、不 postMessage，令牌照样消耗",
    async (name) => {
      const log: string[] = [];
      const engine = () => activeGlobal.engine as { openUserShortcut(name: unknown): unknown };
      cursorExports = {
        cursorDown: () => {
          log.push(String(engine().openUserShortcut(name)));
          try {
            engine().openUserShortcut("s1");
            log.push("returned");
          } catch {
            log.push("threw");
          }
        },
      };
      const { host, posted } = await load({ s1: BOUND, empty: UNBOUND });
      click();
      expect(log).toEqual(["false", "threw"]);
      expect(posted).toEqual([]);
      host.dispose();
    },
  );

  it("非 Windows（后端给 isbound: false）：已有键的快捷方式也返回 false", async () => {
    const log: string[] = [];
    const engine = () => activeGlobal.engine as { openUserShortcut(name: unknown): unknown };
    cursorExports = { cursorDown: () => void log.push(String(engine().openUserShortcut("s1"))) };
    const { host, posted } = await load({ s1: { type: "usershortcut", value: "abcdabcdabcdabcd", isbound: false } });
    click();
    expect(log).toEqual(["false"]);
    expect(posted).toEqual([]);
    host.dispose();
  });

  it("不在光标回调里（update）调：抛 SyntaxError，不动令牌", async () => {
    let thrown: unknown = null;
    const engine = () => activeGlobal.engine as { openUserShortcut(name: unknown): unknown };
    cursorExports = {
      update: () => {
        try {
          engine().openUserShortcut("s1");
        } catch (error) {
          thrown = error;
        }
        return 0.5;
      },
    };
    const { host, posted } = await load({ s1: BOUND });
    (host as unknown as { runtime: { frame(dt: number): void } }).runtime.frame(1 / 60);
    expect(thrown).toBeInstanceOf(RealmSyntaxError);
    expect((thrown as Error).message).toBe("Cannot execute user command outside of cursor callbacks.");
    expect(posted).toEqual([]);
    host.dispose();
  });

  it("图标：按 (图片 id, 属性名) 调 wpe_scene_shortcut_icon，0 字节当没有图标（empty）", async () => {
    const properties = { s1: BOUND };
    // 加一个会引用图标的 bundle：usertextures 来源 usershortcut
    compile.mockImplementation(async () => {
      const result = bundle();
      result.userTextures = [{ kind: "usershortcut", name: "s1" }];
      return result;
    });
    const { host } = await load(properties);
    expect(invokes.filter((item) => item.command === "wpe_scene_shortcut_icon")).toEqual([
      { command: "wpe_scene_shortcut_icon", args: { imageId: "img1", name: "s1" } },
    ]);
    expect(host.userTextureProbe()).toMatchObject([{ name: "s1", value: BOUND.value, status: "empty" }]);
    host.dispose();
  });

  it("图标字节解出来就是 ready（[宽][高][RGBA]）", async () => {
    const data = new Uint8Array(8 + 2 * 2 * 4);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setUint32(4, 2, true);
    iconBytes = data.buffer;
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
    vi.stubGlobal("createImageBitmap", async (source: { width: number; height: number }) => ({
      width: source.width,
      height: source.height,
      close() {},
    }));
    compile.mockImplementation(async () => {
      const result = bundle();
      result.userTextures = [{ kind: "usershortcut", name: "s1" }];
      return result;
    });
    const { host } = await load({ s1: BOUND });
    expect(host.userTextureProbe()).toMatchObject([{ name: "s1", status: "ready", width: 2, height: 2 }]);
    host.dispose();
  });
});
