import { WPESL2WGSL_WASM_URL } from "../wpesl2wgsl";
import { FetchSceneReader, type SceneReader } from "./fs";
import type { SceneBundle } from "./bundle";
import { encodeFileError, type WorkerRequest, type WorkerResponse } from "./protocol";

export interface WorkerCompileInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  signal?: AbortSignal;
  reader?: SceneReader;
}
let modulePromise: Promise<WebAssembly.Module | null> | null = null;
async function getModule(): Promise<WebAssembly.Module | null> {
  if (!WPESL2WGSL_WASM_URL) return null;
  modulePromise ??= fetch(WPESL2WGSL_WASM_URL)
    .then((response) => (response.ok ? response.arrayBuffer() : null))
    .then((bytes) => (bytes ? WebAssembly.compile(bytes) : null))
    .catch(() => null);
  const current = modulePromise;
  const module = await current;
  if (!module && modulePromise === current) modulePromise = null;
  return module;
}

export async function compileSceneInWorker(input: WorkerCompileInput): Promise<SceneBundle> {
  if (input.signal?.aborted) throw new DOMException("已取消", "AbortError");
  const module = await getModule();
  if (input.signal?.aborted) throw new DOMException("已取消", "AbortError");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const reader = input.reader ?? new FetchSceneReader();
  return new Promise((resolve, reject) => {
    let ended = false;
    function finish(result?: SceneBundle, error?: Error) {
      if (ended) return;
      ended = true;
      input.signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
    }
    function abort() {
      finish(undefined, new DOMException("已取消", "AbortError"));
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    worker.onerror = (event) => finish(undefined, new Error(event.message));
    worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
      if (ended) return;
      const message = event.data;
      if (message.type === "done") return finish(message.bundle);
      if (message.type === "error") return finish(undefined, new Error(message.message));
      try {
        const bytes =
          message.operation === "whole"
            ? await reader.readWhole(message.path)
            : await reader.readRange(message.path, message.start!, message.end!);
        const result: WorkerRequest = { type: "file-result", id: message.id, bytes };
        if (!ended) worker.postMessage(result, [bytes.buffer]);
      } catch (error) {
        const result: WorkerRequest = { type: "file-result", id: message.id, error: encodeFileError(error) };
        if (!ended) worker.postMessage(result);
      }
    };
    const request: WorkerRequest = {
      type: "start",
      projectDir: input.projectDir,
      sceneAssets: input.sceneAssets,
      userProperties: input.userProperties ?? {},
      module,
    };
    worker.postMessage(request);
  });
}
