import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol";

// 翻译器 wasm 地址：测试里没有，`getModule` 直接给 null
vi.mock("../wpesl2wgsl", () => ({ WPESL2WGSL_WASM_URL: "" }));

/** Worker 替身：收到 start 后按脚本发消息；记下主线程回给它的消息。 */
class FakeWorker {
  static script: WorkerResponse[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly received: WorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: WorkerRequest) {
    this.received.push(message);
    if (message.type !== "start") return;
    queueMicrotask(() => {
      for (const response of FakeWorker.script) this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    });
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.script = [];
  FakeWorker.last = null;
});

describe("compileSceneInWorker 的进度", () => {
  it("Worker 的 progress 消息转给 onProgress，不当成读文件请求", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const bundle = { unsupported: ["x"], textures: [] };
    FakeWorker.script = [
      { type: "progress", done: 0, total: 5 },
      { type: "progress", done: 5, total: 5 },
      { type: "done", bundle: bundle as never },
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
