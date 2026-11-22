import { afterEach, describe, expect, it, vi } from "vitest";
import type { FragmentDelta } from "./fragment";
import { TextureDecodeCache } from "./decode";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import { createWorkerHandler } from "./workerHandler";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

// 翻译器 wasm 地址：测试里没有，`getModule` 直接给 null
vi.mock("../wpesl2wgsl", () => ({ WPESL2WGSL_WASM_URL: "" }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** Worker 替身：收到 open 后按脚本发消息（或交给 `respond`）；记下主线程回给它的消息。 */
class FakeWorker {
  static script: WorkerResponse[] = [];
  /** 收到 fragment 请求时的回复；缺省不回 */
  static respond: ((message: Extract<WorkerRequest, { type: "fragment" }>) => WorkerResponse) | null = null;
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly received: WorkerRequest[] = [];
  terminated = 0;
  constructor() {
    FakeWorker.last = this;
  }
  emit(response: WorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
  postMessage(message: WorkerRequest) {
    this.received.push(message);
    if (message.type === "open")
      queueMicrotask(() => {
        for (const response of FakeWorker.script) this.emit(response);
      });
    if (message.type === "fragment" && FakeWorker.respond) {
      const response = FakeWorker.respond(message);
      queueMicrotask(() => this.emit(response));
    }
  }
  terminate() {
    this.terminated++;
  }
}

const STATS = { cachedBytes: 0, mdls: 0, files: 0, programs: 0, textures: 0, wasmBytes: 0 };
const emptyDelta = (): FragmentDelta =>
  ({
    fragment: { object: 5 },
    programs: { from: 0, list: [] },
    textures: { from: 0, list: [] },
    userTextures: { from: 0, list: [] },
    bindings: [],
  }) as unknown as FragmentDelta;
const REQUEST = { object: 5, config: "{}", parent: null, bone: null, properties: {} };

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.script = [];
  FakeWorker.respond = null;
  FakeWorker.last = null;
});

describe("compileSceneInWorker 的进度", () => {
  it("Worker 的 progress 消息转给 onProgress，不当成读文件请求", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const bundle = { unsupported: ["x"], textures: [] };
    FakeWorker.script = [
      { type: "progress", done: 0, total: 5 },
      { type: "progress", done: 5, total: 5 },
      { type: "opened", bundle: bundle as never, stats: STATS, exactConfigs: [] },
    ];
    const { compileSceneInWorker } = await import("./client");
    const reader = { readWhole: vi.fn(), readRange: vi.fn() };
    const onProgress = vi.fn();
    const result = await compileSceneInWorker({ projectDir: "P:/p", sceneAssets: [], reader, onProgress });
    expect(result).toBe(bundle);
    expect(onProgress.mock.calls).toEqual([
      ["compile", 0, 5],
      ["compile", 5, 5],
    ]);
    expect(reader.readWhole).not.toHaveBeenCalled();
    expect(reader.readRange).not.toHaveBeenCalled();
    expect(FakeWorker.last!.received.filter((message) => message.type === "file-result")).toHaveLength(0);
  });
});

describe("compileSceneInWorker 开完即关", () => {
  it("发 open、收到 opened 后发 close 并 terminate；close 幂等", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.script = [
      { type: "opened", bundle: { unsupported: [], textures: [] } as never, stats: STATS, exactConfigs: [] },
    ];
    const { compileSceneInWorker } = await import("./client");
    await compileSceneInWorker({
      projectDir: "P:/p",
      sceneAssets: [],
      reader: { readWhole: vi.fn(), readRange: vi.fn() },
    });
    const worker = FakeWorker.last!;
    expect(worker.received.map((message) => message.type)).toEqual(["open", "close"]);
    expect(worker.terminated).toBe(1);
  });

  it("open 失败（error 消息）reject 并关掉 Worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.script = [{ type: "error", message: "缺少 project.json" }];
    const { compileSceneInWorker } = await import("./client");
    await expect(
      compileSceneInWorker({ projectDir: "P:/p", sceneAssets: [], reader: { readWhole: vi.fn(), readRange: vi.fn() } }),
    ).rejects.toThrow("缺少 project.json");
    expect(FakeWorker.last!.terminated).toBe(1);
  });

  it("打开途中取消：关 Worker，抛 AbortError", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { compileSceneInWorker } = await import("./client");
    const controller = new AbortController();
    const task = compileSceneInWorker({
      projectDir: "P:/p",
      sceneAssets: [],
      reader: { readWhole: vi.fn(), readRange: vi.fn() },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(FakeWorker.last).not.toBeNull());
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.last!.terminated).toBe(1);
  });
});

describe("openSceneSession 与片段请求", () => {
  async function open(options: { textureCache?: TextureDecodeCache; unsupported?: string[] } = {}) {
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.script = [
      {
        type: "opened",
        bundle: { unsupported: options.unsupported ?? [], textures: [] } as never,
        stats: STATS,
        exactConfigs: [0, 2],
      },
    ];
    const { openSceneSession } = await import("./client");
    return openSceneSession({
      projectDir: "P:/p",
      sceneAssets: [],
      reader: { readWhole: vi.fn(), readRange: vi.fn() },
      textureCache: options.textureCache,
    });
  }

  it("opened 带回的 exactConfigs（L5）：openSceneSession 的返回值与会话上都有，不进 bundle", async () => {
    const opened = await open();
    expect(opened.exactConfigs).toEqual([0, 2]);
    expect(opened.session.exactConfigs).toEqual([0, 2]);
    expect("exactConfigs" in opened.bundle).toBe(false);
  });

  it("按请求 id 配对：两个请求乱序回复，各自拿到自己的增量；stats 取最近一次", async () => {
    const { session } = await open();
    const worker = FakeWorker.last!;
    const first = session.compileFragment({ ...REQUEST, object: 5 });
    const second = session.compileFragment({ ...REQUEST, object: 6 });
    const ids = worker.received.filter((message) => message.type === "fragment").map((message) => message.id);
    expect(ids).toHaveLength(2);
    worker.emit({
      type: "fragment-done",
      id: ids[1],
      delta: { ...emptyDelta(), fragment: { object: 6 } as never },
      stats: { ...STATS, wasmBytes: 2 },
    });
    worker.emit({
      type: "fragment-done",
      id: ids[0],
      delta: { ...emptyDelta(), fragment: { object: 5 } as never },
      stats: { ...STATS, wasmBytes: 1 },
    });
    expect((await first).fragment.object).toBe(5);
    expect((await second).fragment.object).toBe(6);
    expect(session.stats?.wasmBytes).toBe(1);
  });

  it("signal 取消只是不再等结果：请求 reject AbortError、会话不受影响，迟到的结果丢掉", async () => {
    const { session } = await open();
    const worker = FakeWorker.last!;
    const controller = new AbortController();
    const cancelled = session.compileFragment(REQUEST, controller.signal);
    const id = worker.received.find((message) => message.type === "fragment")!.id;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(session.broken).toBe(false);
    // Worker 照常编完：迟到的回复被吞掉，不抛
    worker.emit({ type: "fragment-done", id, delta: emptyDelta(), stats: STATS });
    // 之后的请求照常
    FakeWorker.respond = (message) => ({ type: "fragment-done", id: message.id, delta: emptyDelta(), stats: STATS });
    await expect(session.compileFragment(REQUEST)).resolves.toBeDefined();
    expect(worker.terminated).toBe(0);
    // 取消时已经 aborted 的 signal：直接 reject，不发请求
    const before = worker.received.length;
    await expect(session.compileFragment(REQUEST, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.received.length).toBe(before);
  });

  it("fragment-error（broken）：该请求 reject SessionBrokenError，会话变坏，之后的请求直接 reject 不发出", async () => {
    const { session } = await open();
    const worker = FakeWorker.last!;
    const failing = session.compileFragment(REQUEST);
    const id = worker.received.find((message) => message.type === "fragment")!.id;
    worker.emit({ type: "fragment-error", id, message: "boom", broken: true });
    const { SessionBrokenError } = await import("./client");
    await expect(failing).rejects.toBeInstanceOf(SessionBrokenError);
    expect(session.broken).toBe(true);
    const sent = worker.received.length;
    await expect(session.compileFragment(REQUEST)).rejects.toBeInstanceOf(SessionBrokenError);
    expect(worker.received.length).toBe(sent);
  });

  it("Worker onerror：会话变坏，挂起的请求 reject，之后的请求 reject", async () => {
    const { session } = await open();
    const worker = FakeWorker.last!;
    const hanging = session.compileFragment(REQUEST);
    worker.onerror?.({ message: "worker 崩了" } as ErrorEvent);
    const { SessionBrokenError } = await import("./client");
    await expect(hanging).rejects.toBeInstanceOf(SessionBrokenError);
    expect(session.broken).toBe(true);
    await expect(session.compileFragment(REQUEST)).rejects.toBeInstanceOf(SessionBrokenError);
  });

  it("close 幂等：只发一次 close、terminate 一次；挂起的请求 reject，之后的请求 reject", async () => {
    const { session } = await open();
    const worker = FakeWorker.last!;
    const hanging = session.compileFragment(REQUEST);
    session.close();
    session.close();
    expect(worker.received.filter((message) => message.type === "close")).toHaveLength(1);
    expect(worker.terminated).toBe(1);
    const { SessionBrokenError } = await import("./client");
    await expect(hanging).rejects.toBeInstanceOf(SessionBrokenError);
    await expect(session.compileFragment(REQUEST)).rejects.toBeInstanceOf(SessionBrokenError);
  });

  it("增量里的 FreeImage 纹理在交回之前解码（同整场）", async () => {
    const decoded: string[] = [];
    const cache = new TextureDecodeCache(
      { readWhole: vi.fn(), readRange: async (_path, start, end) => new Uint8Array(end - start) },
      async (bytes, mime) => {
        decoded.push(`${mime}:${bytes.length}`);
        return { width: 7, height: 9, close() {} } as unknown as ImageBitmap;
      },
    );
    const { session } = await open({ textureCache: cache });
    const worker = FakeWorker.last!;
    FakeWorker.respond = (message) => ({
      type: "fragment-done",
      id: message.id,
      stats: STATS,
      delta: {
        ...emptyDelta(),
        textures: {
          from: 3,
          list: [{ mips: [], encoded: { mime: "image/png", path: "x.png", mips: [{ start: 10, end: 30 }] } }],
        },
      } as unknown as FragmentDelta,
    });
    const delta = await session.compileFragment(REQUEST);
    expect(decoded).toEqual(["image/png:20"]);
    expect(delta.textures.list[0].mips).toMatchObject([{ width: 7, height: 9 }]);
    expect(worker.terminated).toBe(0);
  });

  it("整场不支持（unsupported 非空且未强制）时不解码增量里的纹理，同整场", async () => {
    const decoded: string[] = [];
    const cache = new TextureDecodeCache(
      { readWhole: vi.fn(), readRange: async (_path, start, end) => new Uint8Array(end - start) },
      async (bytes, mime) => {
        decoded.push(`${mime}:${bytes.length}`);
        return { width: 1, height: 1, close() {} } as unknown as ImageBitmap;
      },
    );
    const { session } = await open({ textureCache: cache, unsupported: ["x"] });
    FakeWorker.respond = (message) => ({
      type: "fragment-done",
      id: message.id,
      stats: STATS,
      delta: {
        ...emptyDelta(),
        textures: {
          from: 0,
          list: [{ mips: [], encoded: { mime: "image/png", path: "x.png", mips: [{ start: 0, end: 4 }] } }],
        },
      } as unknown as FragmentDelta,
    });
    const delta = await session.compileFragment(REQUEST);
    expect(decoded).toEqual([]);
    expect(delta.textures.list[0].mips).toEqual([]);
  });
});

describe("真实处理器在进程内跑（Worker 替身接 createWorkerHandler）", () => {
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/scene.json": {
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 1, name: "sound", sound: "sounds/a.mp3" }],
    },
    "P:/p/sounds/a.mp3": "a",
  };
  const bytesOf = (path: string): Uint8Array => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  };
  const reader: SceneReader = {
    readWhole: async (path) => bytesOf(path),
    readRange: async (path, start, end) => bytesOf(path).slice(start, end),
  };
  const translator = { memoryBytes: 7, translate: async () => ({ ok: true }) } as unknown as Wpesl2wgsl;

  /** 和真 Worker 一样：消息经结构化克隆（带转移表），两边各一份 */
  class InProcessWorker {
    onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = 0;
    private readonly handler = createWorkerHandler(
      (message, transfer) => {
        const cloned = structuredClone(message, { transfer });
        setTimeout(() => this.onmessage?.({ data: cloned } as MessageEvent<WorkerResponse>), 0);
      },
      { loadTranslator: async () => translator },
    );
    postMessage(message: WorkerRequest, transfer: Transferable[] = []) {
      const cloned = structuredClone(message, { transfer });
      setTimeout(() => void this.handler(cloned), 0);
    }
    terminate() {
      this.terminated++;
    }
  }

  it("compileSceneInWorker 的结果与 compileScene 相同；openSceneSession 之后编片段、再关闭", async () => {
    vi.stubGlobal("Worker", InProcessWorker);
    const { compileSceneInWorker, openSceneSession, SessionBrokenError } = await import("./client");
    const input = { projectDir: "P:/p", sceneAssets: [], reader, postprocess: "disabled" as const, exhaustive: true };
    const viaWorker = await compileSceneInWorker(input);
    const direct = await compileScene({
      ...input,
      translator,
      reflection: "follow",
      shadows: "follow",
      volumetrics: "follow",
    });
    expect(JSON.stringify(viaWorker.layers.map((layer) => layer.object))).toBe(
      JSON.stringify(direct.layers.map((layer) => layer.object)),
    );
    expect(viaWorker.sounds?.length).toBe(direct.sounds?.length);

    const { bundle, session } = await openSceneSession(input);
    expect(bundle.layers.length).toBe(direct.layers.length);
    expect(session.stats?.wasmBytes).toBe(7);
    const delta = await session.compileFragment({
      object: 1,
      config: JSON.stringify({ id: 2, name: "again", sound: "sounds/a.mp3" }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.object).toBe(1);
    expect(delta.fragment.layer.object).toBe(1);
    session.close();
    await expect(
      session.compileFragment({ object: 2, config: "{}", parent: null, bone: null, properties: {} }),
    ).rejects.toBeInstanceOf(SessionBrokenError);
  });
});
