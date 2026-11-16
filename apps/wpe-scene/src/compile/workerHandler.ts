/**
 * 编译 Worker 的消息处理（L2，`.claude/plans/wpe-import/3-scene/live/phase-l2-worker.md`）：做成可在 Node 里测的处理器，
 * `worker.ts` 只剩 `self.onmessage = createWorkerHandler(...)`。
 *
 * 一个 Worker 一个会话：
 * - `open`：只收一次。开会话、整场编译、`finalize`，把 bundle 连同转移表一起发出去，然后立刻让会话忘掉被转移的缓冲；
 * - `fragment`：排进一条 Promise 链串行处理（`compileFragment` 改会话里共享的表、开关记录器，交错执行会互相污染）；
 *   编失败时会话的表可能只追加了一半（L1 不回滚），所以把会话标坏，之后的片段请求一律回 `broken`；
 * - `close`：标记关闭，之后的请求都回错误。
 *
 * **转移之后的缓冲**：`opened` 转移的纹理 mip 与 mdl 文件缓冲，在 Worker 里同一个缓冲就成了已分离的空缓冲，所以转移后让会话「忘掉」
 * 它们（`forgetBuffers`）；片段回传时只转移新增纹理的 mip，片段里的 mdl 视图与 puppet 数据照常结构化克隆（复制），会话的缓存不受影响。
 * 另加一道保险：发片段前查一遍增量里有没有已分离的缓冲，有就回 `fragment-error`（`detached`）并把会话标坏——这是缓存漏删的兜底，不应该发生。
 */
import { openCompileSession, transferableBuffers, type SceneCompileSession } from "./bundle";
import type { FragmentDelta, FragmentRequest } from "./fragment";
import type { SceneReader } from "./fs";
import {
  decodeFileError,
  type OpenRequest,
  type SessionStats,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { Wpesl2wgsl } from "../wpesl2wgsl";

export type PostToMain = (message: WorkerResponse, transfer: Transferable[]) => void;

export interface WorkerHandlerOptions {
  /** `close` 收到后调（worker.ts 里是 `self.close()`） */
  onClose?: () => void;
  /** 翻译器的取得方式；缺省按 `module` 实例化 wasm（`module` 为 null 时没有翻译器）。测试注入假翻译器用。 */
  loadTranslator?: (module: WebAssembly.Module | null) => Promise<Wpesl2wgsl | null>;
  /** 测试开关：为 false 时转移之后不调 `forgetBuffers`，用来证明「已分离」判据有效。产品恒为真。 */
  forgetAfterTransfer?: boolean;
  /** 测试开关：为 false 时打开与每个片段之后都不清文件与 mdl 缓存（`trimCaches`），配合上一项证明「已分离」判据有效。产品恒为真。 */
  trimCaches?: boolean;
}

type Detachable = { detached?: boolean };

/** 值里（深度遍历普通对象 / 数组 / Map / Set）第一个已分离缓冲上的类型化数组的路径；没有返回 null。 */
export function findDetached(value: unknown): string | null {
  const seen = new Set<object>();
  const visit = (item: unknown, at: string): string | null => {
    if (!item || typeof item !== "object") return null;
    if (ArrayBuffer.isView(item)) return (item.buffer as Detachable).detached === true ? at : null;
    if (item instanceof ArrayBuffer) return (item as Detachable).detached === true ? at : null;
    if (seen.has(item)) return null;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const found = visit(item[i], `${at}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    if (item instanceof Map) {
      for (const [key, entry] of item) {
        const found = visit(entry, `${at}.get(${String(key)})`);
        if (found) return found;
      }
      return null;
    }
    if (item instanceof Set) {
      let i = 0;
      for (const entry of item) {
        const found = visit(entry, `${at}{${i++}}`);
        if (found) return found;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(item)) {
      const found = visit(entry, `${at}.${key}`);
      if (found) return found;
    }
    return null;
  };
  return visit(value, "");
}

/** 片段增量里新增纹理的 mip 缓冲（去重）：回传时只转移这些。 */
export function deltaTransferables(delta: FragmentDelta): ArrayBuffer[] {
  const buffers = delta.textures.list.flatMap((texture) => texture.mips.map((mip) => mip.bytes?.buffer));
  return [...new Set(buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}

/** Worker 的消息处理：`post` 是 postMessage（带转移表）。返回的函数每条消息调一次，返回的 Promise 在这条消息处理完时完成。 */
export function createWorkerHandler(
  post: PostToMain,
  options: WorkerHandlerOptions = {},
): (message: WorkerRequest) => Promise<void> {
  const loadTranslator =
    options.loadTranslator ??
    ((module: WebAssembly.Module | null) => (module ? Wpesl2wgsl.fromModule(module) : Promise.resolve(null)));
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: { bytes?: Uint8Array }) => void; reject: (error: Error) => void }
  >();
  function ask(
    operation: "range" | "whole",
    path: string,
    start?: number,
    end?: number,
  ): Promise<{ bytes?: Uint8Array }> {
    const id = nextId++;
    post({ type: "file", id, operation, path, start, end }, []);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  const reader: SceneReader = {
    async readRange(path, start, end) {
      const result = await ask("range", path, start, end);
      if (!result.bytes) throw new Error("缺少文件区间响应");
      return result.bytes;
    },
    async readWhole(path) {
      const result = await ask("whole", path);
      if (!result.bytes) throw new Error("缺少整文件响应");
      return result.bytes;
    },
  };

  let openStarted = false;
  let closed = false;
  let broken = false;
  let session: SceneCompileSession | null = null;
  let translator: Wpesl2wgsl | null = null;
  /** 打开这一段（不会 reject）；片段请求先等它 */
  let openTask: Promise<void> = Promise.resolve();
  /** 片段请求的串行队列 */
  let queue: Promise<void> = Promise.resolve();

  const stats = (current: SceneCompileSession): SessionStats => ({
    ...current.stats(),
    wasmBytes: translator?.memoryBytes ?? 0,
  });

  async function open(request: OpenRequest): Promise<void> {
    if (openStarted || closed) {
      post({ type: "error", message: closed ? "会话已关闭" : "会话已打开，只能 open 一次" }, []);
      return;
    }
    openStarted = true;
    openTask = (async () => {
      try {
        translator = await loadTranslator(request.module);
        const opened = await openCompileSession({
          projectDir: request.projectDir,
          sceneAssets: request.sceneAssets,
          userProperties: request.userProperties,
          scriptOverrides: request.scriptOverrides,
          structure: request.structure,
          postprocess: request.postprocess,
          reflection: request.reflection,
          shadows: request.shadows,
          volumetrics: request.volumetrics,
          force: request.force,
          exhaustive: request.exhaustive,
          reader,
          translator,
          onProgress: (done, total) => post({ type: "progress", done, total }, []),
        });
        for (let index = 0; index < opened.objectCount; index++) {
          if (opened.settled()) break;
          await opened.compileObject(index);
        }
        const bundle = await opened.finalize();
        session = opened;
        // 整场编完之后文件与 mdl 缓存是重复数据（全库冒烟里少数场景常驻 80–290 MB），常驻会话只留着色器翻译缓存；在发回之前清，
        // `opened` 带回的统计就是常驻的规模。清缓存不碰 bundle，转移照常
        if (options.trimCaches !== false) opened.trimCaches();
        const transfer = transferableBuffers(bundle);
        post({ type: "opened", bundle, stats: stats(opened) }, transfer);
        // 转移之后这些缓冲在这里已分离：会话的缓存不能再持有它们
        if (options.forgetAfterTransfer !== false) opened.forgetBuffers(new Set(transfer));
      } catch (error) {
        broken = true;
        post({ type: "error", message: String(error) }, []);
      }
    })();
    await openTask;
  }

  function fragment(id: number, request: FragmentRequest): Promise<void> {
    const task = queue.then(async () => {
      await openTask;
      if (closed || broken || !session) {
        post(
          {
            type: "fragment-error",
            id,
            message: closed ? "会话已关闭" : !openStarted ? "会话还没有打开" : "会话已不可用（broken）",
            broken: true,
          },
          [],
        );
        return;
      }
      const current = session;
      let delta: FragmentDelta;
      try {
        delta = await current.compileFragment(request);
      } catch (error) {
        // 编译失败时会话的表可能只追加了一半（L1 不回滚）
        broken = true;
        post({ type: "fragment-error", id, message: String(error), broken: true }, []);
        return;
      }
      const detached = findDetached(delta);
      if (detached !== null) {
        broken = true;
        post(
          { type: "fragment-error", id, message: `detached：增量里有已分离的缓冲（${detached}）`, broken: true },
          [],
        );
        return;
      }
      // 编片段把要用的文件又读进了缓存：编完照样清，常驻时只留着色器翻译缓存（片段只编运行中第一次出现的配置，重读的代价可以接受）。
      // 在发回之前清（同 open），带回的统计就是常驻的规模；清缓存只断开缓存对缓冲的引用，增量照样完整
      if (options.trimCaches !== false) current.trimCaches();
      const transfer = deltaTransferables(delta);
      post({ type: "fragment-done", id, delta, stats: stats(current) }, transfer);
      if (options.forgetAfterTransfer !== false) current.forgetBuffers(new Set(transfer));
    });
    // 意外的异常（例如发回时结构化克隆失败）：会话标坏、这个请求照样有回复；队列只接已兜住的 Promise，
    // 否则链上一个 rejected 之后，后面的 `queue.then(回调)` 不再执行，之后的请求永远没有回复
    const settled = task.catch((error: unknown) => {
      broken = true;
      try {
        post({ type: "fragment-error", id, message: String(error), broken: true }, []);
      } catch {
        // 连错误都发不出去：Worker 的通道已不可用，主线程会在 onerror / close 里收尾
      }
    });
    queue = settled;
    return settled;
  }

  return async (message) => {
    switch (message.type) {
      case "file-result": {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(decodeFileError(message.error));
        else waiter.resolve(message);
        return;
      }
      case "open":
        return open(message);
      case "fragment":
        return fragment(message.id, message.request);
      case "close":
        closed = true;
        for (const waiter of pending.values()) waiter.reject(new Error("会话已关闭"));
        pending.clear();
        options.onClose?.();
        return;
    }
  };
}
