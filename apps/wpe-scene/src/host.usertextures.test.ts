/**
 * 宿主的用户纹理接线（P11b 步骤 2）：
 * - 加载时对 bundle 的属性来源按当前属性值预先解码，全部完成才建场景（渲染器 `load` 被调时已经 `ready`）；
 * - 运行中属性经绑定表就地写进状态（`SceneState.write` 的 `user-texture` 目标）→ 状态的监听把值交给来源表 → 解码完成把来源标进状态的脏集合，
 *   不整场重编译；
 * - 清空（空串）与非字符串的值回到缺省纹理（来源表记成无图）；
 * - 来源表跨重编译保留（同一个值不重读文件），销毁时释放；
 * - 探针 `userTextureProbe` 与 `settleUserTextures`。
 * 渲染器是替身（只接 `load` 的选项与 `applyBindings`），来源表是真的：`fetch(file:)` 回路径文本，`createImageBitmap` 按路径给尺寸。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass } from "./compile/bundle";
import { SceneState } from "./render/state";
import { UserTextureSources, type UserTextureProvider } from "./usertex/sources";

const compile = vi.fn<() => Promise<SceneBundle>>();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async (command: string) =>
    command === "wpe_scene_target" ? { path: "P:/p", sceneAssets: [] } : "disabled",
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./compile/client", () => ({ compileSceneInWorker: () => compile() }));

/** 渲染器替身：`load` 记下收到的选项与调用那一刻的来源状态，`applyBindings` 照真实现逐条 `state.write`。 */
const loads: { userTextures: UserTextureProvider | undefined; status: string }[] = [];
let probeAtLoad: () => string = () => "";
class FakeRenderer {
  adapterInfo = { vendor: "test", architecture: "", description: "", features: [] as string[] };
  warnings: string[] = [];
  sceneStats = null;
  sceneState: SceneState | null = null;
  redraws = 0;
  async load(
    bundle: SceneBundle,
    options: { userTextures?: UserTextureProvider; beforeFirstFrame?: (state: SceneState) => void },
  ) {
    loads.push({ userTextures: options.userTextures, status: probeAtLoad() });
    this.sceneState = SceneState.fromBundle(bundle);
    options.beforeFirstFrame?.(this.sceneState);
  }
  setStyle() {}
  setBackground() {}
  setPaused() {}
  applyBindings(writes: { binding: Parameters<SceneState["write"]>[0]; value: Parameters<SceneState["write"]>[1] }[]) {
    for (const write of writes) this.sceneState!.write(write.binding, write.value);
    return true;
  }
  redraw() {
    this.redraws++;
  }
  destroy() {}
}
let renderer: FakeRenderer | null = null;
vi.mock("./render", async (original) => ({
  ...(await original<typeof import("./render")>()),
  SceneRenderer: {
    create: async () => (renderer = new FakeRenderer()),
  },
}));

const { SceneHost } = await import("./host");

const layer = (): SceneLayer =>
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
    passes: [
      {
        key: "objects/0/passes/0",
        program: null,
        blending: "normal",
        textures: {},
        runtime: {},
        uniforms: {},
        framebuffer: false,
      } as unknown as ScenePass,
    ],
    colorBlendMode: 0,
    passthrough: null,
    particle: null,
  }) as unknown as SceneLayer;

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
    layers: [layer()],
    programs: [],
    textures: [],
    userTextures: [
      { kind: "property", name: "ut" },
      // P11c 的封面来源：宿主不处理
      { kind: "system", name: "$mediaThumbnail" },
    ],
    bloom: null,
    unsupported: [],
    bindings: [{ property: "ut", target: { kind: "user-texture", name: "ut" } }],
    scripts: { list: [] },
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
const SIZES: Record<string, [number, number]> = { "b.png": [540, 360], "c.png": [100, 400] };
const fetched: string[] = [];

describe("SceneHost 的用户纹理（P11b 步骤 2）", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    loads.length = 0;
    fetched.length = 0;
    renderer = null;
    compile.mockReset();
    compile.mockImplementation(async () => bundle());
    // `file:` 读：回 URL 文本；解码：按文本里的文件名给尺寸
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      return new Response(new TextEncoder().encode(String(url)));
    });
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      const text = await blob.text();
      const name = Object.keys(SIZES).find((key) => text.endsWith(key));
      if (!name) throw new Error("解不出");
      return { width: SIZES[name][0], height: SIZES[name][1], close() {} };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function open(properties: Record<string, { type: string; value: unknown }>, timeoutMs?: number) {
    const report = reporter();
    const host = new SceneHost({ width: 100, height: 100 } as HTMLCanvasElement, {
      imageId: "1",
      report,
      userTexturePrimeTimeoutMs: timeoutMs,
    });
    probeAtLoad = () => host.userTextureProbe().find((item) => item.name === "ut")?.status ?? "none";
    host.applyUserProperties(properties);
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledOnce());
    return { host, report, state: renderer!.sceneState! };
  }

  it("加载时对属性来源的当前值预先解码，建场景之前就读完；路径转成 file: 并编码空格与中文", async () => {
    const { host } = await open({ ut: { type: "scenetexture", value: "D:/图 片/b.png" } });
    expect(loads).toHaveLength(1);
    expect(loads[0].status).toBe("ready");
    expect(loads[0].userTextures).toBeDefined();
    expect(fetched).toEqual(["file:///D:/%E5%9B%BE%20%E7%89%87/b.png"]);
    expect(host.userTextureProbe()).toMatchObject([
      { name: "ut", value: "D:/图 片/b.png", status: "ready", width: 540, height: 360 },
    ]);
  });

  it("属性没有值（缺省空串）或不是字符串：记成无图，缺省纹理；非属性来源（封面）不碰", async () => {
    const { host } = await open({ ut: { type: "slider", value: 0.3 } });
    expect(loads[0].status).toBe("empty");
    expect(host.userTextureProbe().map((item) => item.name)).toEqual(["ut"]);
    expect(fetched).toEqual([]);
  });

  it("运行中改值：就地写进状态、不重编译；解码完成把来源标进状态的脏集合，暂停时补画一帧", async () => {
    const { host, state } = await open({ ut: { type: "scenetexture", value: "" } });
    host.setPaused(true);
    expect(state.takeDirty().userTextures.size).toBe(0);
    host.applyUserProperties({ ut: { type: "scenetexture", value: "D:/a/c.png" } });
    // 写入当场标脏（RT 参考的槽据此生效），解码还没完成
    expect(state.userTextures.get("ut")).toBe("D:/a/c.png");
    expect([...state.takeDirty().userTextures]).toEqual(["ut"]);
    expect(host.userTextureProbe()[0].status).toBe("loading");
    await host.settleUserTextures();
    expect(host.userTextureProbe()[0]).toMatchObject({ value: "D:/a/c.png", status: "ready", width: 100, height: 400 });
    // 解码完成再标一次
    expect([...state.takeDirty().userTextures]).toEqual(["ut"]);
    expect(renderer!.redraws).toBeGreaterThan(0);
    expect(host.stats.recompiled).toEqual([]);
    expect(host.stats.applied).toBe(1);
    expect(compile).toHaveBeenCalledOnce();
  });

  it("清空 scenetexture（空串）能生效：回到缺省，不保留上一张", async () => {
    const { host, state } = await open({ ut: { type: "scenetexture", value: "D:/a/b.png" } });
    expect(host.userTextureProbe()[0].status).toBe("ready");
    host.applyUserProperties({ ut: { type: "scenetexture", value: "" } });
    expect(host.userTextureProbe()[0]).toMatchObject({ value: "", status: "empty" });
    expect(state.userTextures.get("ut")).toBe("");
    expect(state.takeDirty().userTextures.has("ut")).toBe(true);
  });

  it("读不出的文件：无图（failed），记一条 debug，不报错、不退回预览图", async () => {
    const { host, report } = await open({ ut: { type: "scenetexture", value: "" } });
    host.applyUserProperties({ ut: { type: "scenetexture", value: "D:/a/missing.png" } });
    await host.settleUserTextures();
    expect(host.userTextureProbe()[0].status).toBe("failed");
    expect(report.debug).toHaveBeenCalledWith(expect.stringContaining("missing.png"));
    expect(report.fallback).not.toHaveBeenCalled();
    expect(report.warn).not.toHaveBeenCalled();
  });

  it("来源表跨重编译保留：重编译后同一个值不重新读文件", async () => {
    const { host, report } = await open({ ut: { type: "scenetexture", value: "D:/a/b.png" } });
    expect(fetched).toHaveLength(1);
    // 直接触发一次重新加载（真实路径是属性 / 设置变化的整场重编译）
    compile.mockImplementation(async () => bundle());
    await (host as unknown as { reload(): Promise<void> }).reload();
    await vi.waitFor(() => expect(loads).toHaveLength(2));
    expect(fetched).toHaveLength(1);
    expect(loads[1].status).toBe("ready");
    expect(report.fallback).not.toHaveBeenCalled();
  });

  it("预解码有上限：读文件卡住时超时照常建场景（槽先用缺省），晚到的解码完成后标脏、走运行时换图", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      await gate;
      return new Response(new TextEncoder().encode(String(url)));
    });
    const { host, report, state } = await open({ ut: { type: "scenetexture", value: "D:/a/b.png" } }, 30);
    // 超时后建了场景：加载那一刻来源还没就绪，记了一条 warn，没有退回预览图
    expect(loads[0].status).toBe("loading");
    expect(report.warn).toHaveBeenCalledWith(expect.stringContaining("30 ms"));
    expect(report.fallback).not.toHaveBeenCalled();
    expect(state.takeDirty().userTextures.size).toBe(0);
    release();
    await host.settleUserTextures();
    // 晚到的解码完成：只标脏（不是属性写入，M8 的门闸不动）
    expect([...state.takeDirty().userTextures]).toEqual(["ut"]);
    expect(state.userWritten.size).toBe(0);
    expect(host.userTextureProbe()[0].status).toBe("ready");
  });

  it("暂停 / 隐藏传给来源表（P11b 步骤 4，用户视频与 GIF 的时钟）：建好时设一次，两处都按 paused || hidden", async () => {
    const spy = vi.spyOn(UserTextureSources.prototype, "setPaused");
    try {
      const { host } = await open({ ut: { type: "scenetexture", value: "" } });
      // 构造时按当前状态设一次
      expect(spy.mock.calls.at(0)).toEqual([false]);
      spy.mockClear();
      host.setPaused(true);
      expect(spy).toHaveBeenLastCalledWith(true);
      host.setPaused(false);
      expect(spy).toHaveBeenLastCalledWith(false);
      host.setHidden(true);
      expect(spy).toHaveBeenLastCalledWith(true);
      // 隐藏期间取消暂停：仍按暂停
      host.setPaused(true);
      host.setPaused(false);
      expect(spy).toHaveBeenLastCalledWith(true);
      host.setHidden(false);
      expect(spy).toHaveBeenLastCalledWith(false);
    } finally {
      spy.mockRestore();
    }
  });
});
