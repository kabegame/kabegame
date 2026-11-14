import { WPESL2WGSL_WASM_URL } from "../wpesl2wgsl";
import { FetchSceneReader, type SceneReader } from "./fs";
import type { SceneBundle } from "./bundle";
import { decodeEncodedTextures, type TextureDecodeCache } from "./decode";
import type { SceneReflectionSetting, ScenePostprocessSetting } from "./postprocess";
import { encodeFileError, type WorkerRequest, type WorkerResponse } from "./protocol";

export interface WorkerCompileInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  scriptOverrides?: Record<string, number[] | boolean | string>;
  /** 设置「场景后处理」；缺省跟随 WPE。 */
  postprocess?: ScenePostprocessSetting;
  /** 设置「场景反射」（P13b1）；缺省跟随 WPE。 */
  reflection?: SceneReflectionSetting;
  /** dev 强制渲染（D4）：有不支持项也解码纹理。 */
  force?: boolean;
  exhaustive?: boolean;
  /**
   * FreeImage 纹理的解码缓存（`decode.ts`）。给了就在主线程解码这些纹理：`unsupported` 为空或 `force` 时才解，
   * 否则渲染器不会用它们。
   */
  textureCache?: TextureDecodeCache;
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
  const bundle = await compileInWorker(input);
  if (input.signal?.aborted) throw new DOMException("已取消", "AbortError");
  if (input.textureCache && (input.force || !bundle.unsupported.length))
    await decodeEncodedTextures(bundle, input.textureCache);
  if (input.signal?.aborted) throw new DOMException("已取消", "AbortError");
  return bundle;
}

async function compileInWorker(input: WorkerCompileInput): Promise<SceneBundle> {
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
      scriptOverrides: input.scriptOverrides ?? {},
      postprocess: input.postprocess ?? "follow",
      reflection: input.reflection ?? "follow",
      force: input.force === true,
      exhaustive: input.exhaustive === true,
      module,
    };
    worker.postMessage(request);
  });
}
