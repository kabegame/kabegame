import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "./compile/bundle";

// 宿主依赖 IPC、Worker 编译与 WebGPU：都换成替身，只核对加载状态机（P3a 退回路径）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "wpe_scene_target") return { path: "P:/p", sceneAssets: [] };
    if (command === "get_wpe_scene_postprocess") return "disabled";
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const compile = vi.fn<(input: { userProperties: Record<string, unknown> }) => Promise<SceneBundle>>();
vi.mock("./compile/client", () => ({ compileSceneInWorker: (input: never) => compile(input) }));

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  const renderer = {
    adapterInfo: { vendor: "test", architecture: "", description: "", features: [] },
    warnings: [],
    sceneStats: null,
    load: async () => {},
    setPaused: () => {},
    applyBindings: () => true,
    destroy: () => {},
  };
  return { ...actual, SceneRenderer: { create: async () => renderer } };
});

const { SceneHost } = await import("./host");

/** 打开 fx（绑在一个不支持的 effect 的可见性上）时退回预览图，关掉就能渲染。 */
function bundleFor(properties: Record<string, unknown>): SceneBundle {
  return {
    general: { postprocess: { level: "disabled" } },
    layers: [],
    programs: [],
    textures: [],
    bloom: null,
    bindings: [
      { property: "fx", target: { kind: "recompile", reason: "effect-visible", path: "objects/0/effects/0/visible" } },
    ],
    unsupported: properties.fx === true ? ["effect:unsupported"] : [],
  } as unknown as SceneBundle;
}

function reporter() {
  return { ready: vi.fn(), fallback: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const fx = (value: boolean) => ({ fx: { type: "bool", value } });

describe("SceneHost：退回预览图后的属性变化", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCENE_DEV__", false);
    compile.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("退回后改属性重新编译，能渲染就报 ready", async () => {
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledWith(["effect:unsupported"]));
    expect(report.ready).not.toHaveBeenCalled();

    host.applyUserProperties(fx(false));
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0].userProperties).toEqual({ fx: false });
    host.dispose();
  });

  it("首次加载期间到达的增量：加载以退回告终时按新全集再编译", async () => {
    let finishFirst!: () => void;
    compile.mockImplementationOnce(
      ({ userProperties }) =>
        new Promise((resolve) => {
          finishFirst = () => resolve(bundleFor(userProperties));
        }),
    );
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    // 还在编译：增量只并进全集，不另起编译
    host.applyUserProperties(fx(false));
    expect(compile).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.waitFor(() => expect(report.ready).toHaveBeenCalledTimes(1));
    expect(report.fallback).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0].userProperties).toEqual({ fx: false });
    host.dispose();
  });

  it("退回且编译期间属性没变：不重复编译", async () => {
    compile.mockImplementation(async ({ userProperties }) => bundleFor(userProperties));
    const report = reporter();
    const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report });

    host.applyUserProperties(fx(true));
    await vi.waitFor(() => expect(report.fallback).toHaveBeenCalledTimes(1));
    // 同值再来一次：按值去重，没有变化
    host.applyUserProperties(fx(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compile).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
