import { WPESL2WGSL_WASM_URL } from "../wpesl2wgsl";
import { FetchSceneReader, type SceneReader } from "./fs";
import type { SceneBundle } from "./bundle";
import { decodeEncodedTextureList, decodeEncodedTextures, type TextureDecodeCache } from "./decode";
import type { FragmentDelta, FragmentRequest } from "./fragment";
import type {
  SceneReflectionSetting,
  ScenePostprocessSetting,
  SceneShadowSetting,
  SceneVolumetricsSetting,
} from "./postprocess";
import {
  encodeFileError,
  type OpenRequest,
  type SceneStructure,
  type SessionStats,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";

export interface WorkerCompileInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  scriptOverrides?: Record<string, number[] | boolean | string>;
  /** 运行中改过的场景结构（P6d3）；缺省空结构。 */
  structure?: SceneStructure;
  /** 设置「场景后处理」；缺省跟随 WPE。 */
  postprocess?: ScenePostprocessSetting;
  /** 设置「场景反射」（P13b1）；缺省跟随 WPE。 */
  reflection?: SceneReflectionSetting;
  /** 设置「场景阴影」（P13d）；缺省跟随 WPE。 */
  shadows?: SceneShadowSetting;
  /** 设置「场景体积光」（P13e）；缺省跟随 WPE。 */
  volumetrics?: SceneVolumetricsSetting;
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
  /** 加载进度（`progress.ts`）：Worker 编译报 `compile`，主线程解码报 `decode`。 */
  onProgress?: (stage: "compile" | "decode", done: number, total: number) => void;
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

/** 会话坏了、已关闭，或这个片段让会话变坏（L2）：宿主整场重载、换新会话。 */
export class SessionBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBrokenError";
  }
}

/** 常驻的编译会话（L2）：一个 Worker、一个场景。 */
export interface CompileSessionClient {
  /** 编一个对象。增量里的 FreeImage 新纹理已在主线程解好（同整场）。会话坏了或已关时 reject（`SessionBrokenError`）。 */
  compileFragment(request: FragmentRequest, signal?: AbortSignal): Promise<FragmentDelta>;
  /** 最近一次 opened / fragment-done 带回的统计 */
  readonly stats: SessionStats | null;
  readonly broken: boolean;
  close(): void;
}

const abortError = () => new DOMException("已取消", "AbortError");

/** 一个 Worker 一个会话的客户端实现。读文件请求由这里代读，会话常驻期间一直接收。 */
class WorkerSession implements CompileSessionClient {
  stats: SessionStats | null = null;
  broken = false;
  /** 增量里的 FreeImage 纹理要不要在主线程解（同整场：`unsupported` 为空或强制渲染） */
  decodeFragments = false;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (delta: FragmentDelta) => void; reject: (error: Error) => void; discarded: boolean }
  >();
  /** 打开这一段还没完成时的回调 */
  private opening: {
    resolve: (bundle: SceneBundle) => void;
    reject: (error: Error) => void;
    onProgress?: WorkerCompileInput["onProgress"];
  } | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly reader: SceneReader,
    private readonly textureCache: TextureDecodeCache | undefined,
  ) {
    worker.onerror = (event) => this.fail(new Error(event.message));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => void this.onMessage(event.data);
  }

  /** 发 `open`，等整场 bundle（解码之前）。 */
  open(request: OpenRequest, onProgress: WorkerCompileInput["onProgress"]): Promise<SceneBundle> {
    return new Promise((resolve, reject) => {
      this.opening = { resolve, reject, onProgress };
      this.worker.postMessage({ type: "open", ...request } satisfies WorkerRequest);
    });
  }

  /** Worker 出错（`onerror`）：标坏，打开中与未完成的请求都 reject。 */
  private fail(error: Error): void {
    this.broken = true;
    const opening = this.opening;
    this.opening = null;
    opening?.reject(error);
    this.rejectPending(new SessionBrokenError(error.message));
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private async onMessage(message: WorkerResponse): Promise<void> {
    if (this.closed) return;
    switch (message.type) {
      case "progress":
        this.opening?.onProgress?.("compile", message.done, message.total);
        return;
      case "opened": {
        this.stats = message.stats;
        const opening = this.opening;
        this.opening = null;
        opening?.resolve(message.bundle);
        return;
      }
      case "error": {
        this.broken = true;
        const opening = this.opening;
        this.opening = null;
        opening?.reject(new Error(message.message));
        return;
      }
      case "fragment-done": {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.stats = message.stats;
        try {
          if (!waiter.discarded && this.decodeFragments && this.textureCache)
            await decodeEncodedTextureList(message.delta.textures.list, this.textureCache);
        } catch (error) {
          this.pending.delete(message.id);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.pending.delete(message.id);
        waiter.resolve(message.delta);
        return;
      }
      case "fragment-error": {
        const waiter = this.pending.get(message.id);
        if (message.broken) this.broken = true;
        if (!waiter) return;
        this.pending.delete(message.id);
        waiter.reject(message.broken ? new SessionBrokenError(message.message) : new Error(message.message));
        return;
      }
      case "file": {
        try {
          const bytes =
            message.operation === "whole"
              ? await this.reader.readWhole(message.path)
              : await this.reader.readRange(message.path, message.start!, message.end!);
          const result: WorkerRequest = { type: "file-result", id: message.id, bytes };
          if (!this.closed) this.worker.postMessage(result, [bytes.buffer as ArrayBuffer]);
        } catch (error) {
          const result: WorkerRequest = { type: "file-result", id: message.id, error: encodeFileError(error) };
          if (!this.closed) this.worker.postMessage(result);
        }
        return;
      }
    }
  }

  compileFragment(request: FragmentRequest, signal?: AbortSignal): Promise<FragmentDelta> {
    if (this.closed) return Promise.reject(new SessionBrokenError("会话已关闭"));
    if (this.broken) return Promise.reject(new SessionBrokenError("会话已不可用"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<FragmentDelta>((resolve, reject) => {
      const entry = { resolve, reject, discarded: false };
      this.pending.set(id, entry);
      // 取消只是不再等结果：Worker 照常编完，会话不受影响，结果丢掉（条目留在表里，Worker 的回复到了再删）
      signal?.addEventListener(
        "abort",
        () => {
          entry.discarded = true;
          reject(abortError());
        },
        { once: true },
      );
      this.worker.postMessage({ type: "fragment", id, request } satisfies WorkerRequest);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage({ type: "close" } satisfies WorkerRequest);
    } catch {
      // Worker 已经不在了
    }
    this.worker.terminate();
    const opening = this.opening;
    this.opening = null;
    opening?.reject(abortError());
    this.rejectPending(new SessionBrokenError("会话已关闭"));
  }
}

/**
 * 开会话：整场编译 + 主线程解 FreeImage，返回 bundle 与常驻会话。`signal` 只管打开这一段（含解码）：打开前 / 中取消就关 Worker 并抛
 * AbortError，之后会话不再受它影响。出错一律关掉 Worker。
 */
export async function openSceneSession(
  input: WorkerCompileInput,
): Promise<{ bundle: SceneBundle; session: CompileSessionClient }> {
  if (input.signal?.aborted) throw abortError();
  const module = await getModule();
  if (input.signal?.aborted) throw abortError();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const session = new WorkerSession(worker, input.reader ?? new FetchSceneReader(), input.textureCache);
  const abort = () => session.close();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const bundle = await session.open(
      {
        projectDir: input.projectDir,
        sceneAssets: input.sceneAssets,
        userProperties: input.userProperties ?? {},
        scriptOverrides: input.scriptOverrides ?? {},
        structure: input.structure ?? { destroyed: [], parents: [], created: [] },
        postprocess: input.postprocess ?? "follow",
        reflection: input.reflection ?? "follow",
        shadows: input.shadows ?? "follow",
        volumetrics: input.volumetrics ?? "follow",
        force: input.force === true,
        exhaustive: input.exhaustive === true,
        module,
      },
      input.onProgress,
    );
    if (input.signal?.aborted) throw abortError();
    session.decodeFragments = input.force === true || !bundle.unsupported.length;
    if (input.textureCache && session.decodeFragments)
      await decodeEncodedTextures(bundle, input.textureCache, (done, total) =>
        input.onProgress?.("decode", done, total),
      );
    if (input.signal?.aborted) throw abortError();
    return { bundle, session };
  } catch (error) {
    session.close();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

/** 一次性整场编译：开会话、取 bundle、马上关（dev 探针、语料扫描等不需要常驻会话的调用方）。 */
export async function compileSceneInWorker(input: WorkerCompileInput): Promise<SceneBundle> {
  const { bundle, session } = await openSceneSession(input);
  session.close();
  return bundle;
}
