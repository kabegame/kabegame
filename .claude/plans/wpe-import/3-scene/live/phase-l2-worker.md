# L2 — 常驻 Worker 与增量协议（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L2」。前一步 L1 已提交 `1dbd479d`（编译会话、`compileFragment`、`fragmentOf` / `rekeyFragment`），之后合了 origin/main（`76fbfdc9`）。
> 主工作区里 `render/`（除合并已收的三文件外）、`dev/`、`particles/`、dev 工具仍有别人未提交的改动。本步要改的 `dev/` 文件动手前先看 `git status`，改到别人改过的文件时只加自己的块。

## 总体设计思路

L1 让会话能在一次整场编译之后继续编单个对象，但会话活在 `compileScene` 的一次调用里，Worker 编完整场就被 `terminate`。L2 让编译会话在 Worker 里**常驻**：打开时照旧整场编译、交回整场 bundle；之后主线程可以随时请求编一个对象的片段，直到关闭。

产品行为在本步**不变**：
- 宿主照旧一次编整场、照旧整场重载，不调片段。
- 只是编完不再杀 Worker，宿主按场景持有会话，L5 起用它。
- dev 探针、`scriptCorpus` 等一次性编译照旧用 `compileSceneInWorker`，它改成「开会话、取 bundle、马上关」，结果逐字节不变。

**协议**按请求 id 配对，一个 Worker 一个会话：
- `open` → `opened`（整场 bundle，同现在的 `done`）；
- `fragment` → `fragment-done`（增量）或 `fragment-error`；
- `close`；
- 读文件、进度两种消息不变。

Worker 里片段请求**串行处理**：`compileFragment` 改会话里共享的表、开关记录器，交错执行会互相污染。片段编失败时会话的表可能只追加了一半（L1 不回滚），所以 Worker 把会话标成坏的，之后的片段请求一律回 `fragment-error`（`broken`）。宿主收到就整场重载、换新会话。

**缓冲转移是本步唯一的实质风险。** 现在 `opened` 转移纹理 mip 与 mdl 文件缓冲（网格、puppet 的顶点 / 索引是 mdl 文件缓冲上的视图），以及编译期自有的动画帧、变形纹理等。转移之后，Worker 里同一个缓冲就成了已分离（detached）的空缓冲。会话常驻后，还有两处缓存持有它们：
- 会话的 `mdls`（解析过的 mdl）；
- `SceneFs.contents`（整读过的文件字节，mdl 就是经它读的）。

之后编一个用同一个 mdl 的对象，会拿到空视图，发回主线程时结构化克隆直接抛错。所以转移之后，Worker 让会话「忘掉」这批缓冲：
- 两处缓存里引用了它们的条目都删掉，再要就重读；
- 纹理 mip 不用管：纹理按路径缓存的只是下标与格式，片段按下标引用。

片段回传时**只转移新增纹理的 mip**，片段里的 mdl 视图、puppet 数据照常结构化克隆（复制）。运行中建模型对象很少，复制的代价可以接受，而且这样会话的缓存不受影响。

另加一道保险：Worker 发片段前查一遍增量里有没有已分离的缓冲，有就回 `fragment-error`（`detached`）并把会话标坏。这是缓存漏删的兜底，不应该发生，单测与真机冒烟都要求它为 0。

**FreeImage 纹理**（PNG / JPG）要在主线程解码（`decode.ts`）。整场的照旧在 `opened` 之后解；片段增量里的新纹理由客户端在交回之前解，宿主拿到的增量和整场 bundle 一样是解好的。

**宿主只在用得上时留着会话。** 常驻 Worker 一直占着翻译器 wasm 实例、着色器翻译缓存、文件缓存，桌面每块屏一个壁纸窗口，再加预览。L5 / L6 只有两种情况用得上会话：
- 脚本运行中建层或写对象级重编译字段，所以要求场景有脚本；
- 有对象级重编译绑定。L6 之前这类只有 `layer-structure`。

两者都没有的场景，编完就关会话。用不上时关掉不影响正确性：真要用时整场重载照样对。

## 现状锚点

**a. 协议**（`compile/protocol.ts`）
```ts
export type WorkerRequest =
  | { type: "start"; projectDir: string; sceneAssets: string[]; userProperties: …; scriptOverrides: …; structure: SceneStructure;
      postprocess: …; reflection: …; shadows: …; volumetrics: …; force: boolean; exhaustive: boolean; module: WebAssembly.Module | null }
  | { type: "file-result"; id: number; bytes?: Uint8Array; error?: FileError };
export type WorkerResponse =
  | { type: "file"; id: number; operation: "range" | "whole"; path: string; start?: number; end?: number }
  | { type: "done"; bundle: SceneBundle }          // 现状：编完就结束
  | { type: "error"; message: string }
  | { type: "progress"; done: number; total: number };
```

**b. Worker**（`compile/worker.ts`）：收到 `start` 调 `compileScene`，`postMessage({ type: "done", bundle }, { transfer: transferableBuffers(bundle) })`。

**c. 客户端**（`compile/client.ts`）
```ts
export async function compileSceneInWorker(input: WorkerCompileInput): Promise<SceneBundle> {
  const bundle = await compileInWorker(input);      // 现状：每次新建 Worker，done / error / abort 都 worker.terminate()
  if (input.textureCache && (input.force || !bundle.unsupported.length))
    await decodeEncodedTextures(bundle, input.textureCache, …);   // 主线程解 FreeImage
  return bundle;
}
```

**d. 宿主**（`host.ts` `reload`）：`const bundle = await compileSceneInWorker({ …, signal: abort.signal, onProgress })`，之后 `current.load(bundle, { beforeFirstFrame })`，换上时 `this.bundle = bundle`。退回走 `fallback()`（清 `this.bundle` 等），销毁走 `dispose()`。

**e. 会话里持有缓冲的缓存**（`compile/bundle.ts`、`compile/fs.ts`）
```ts
const mdls = new Map<string, MdlFile | null>();   // 现状：解析过的 mdl，视图在文件缓冲上
// SceneFs
private readonly contents = new Map<string, Promise<{ source; bytes: Uint8Array } | null>>();   // 现状：整读的文件字节（含 mdl）
```

## 点 1 — 会话忘掉已转移的缓冲（`compile/bundle.ts`、`compile/fs.ts`）

- **新增** `SceneCompileSession.forgetBuffers(buffers: ReadonlySet<ArrayBuffer>): void`。
  - `mdls` 里，解析结果的任一视图落在这批缓冲上的条目删掉。实现时在 `readMdl` 里记下每个键的文件缓冲，按它判，不要遍历视图。
  - 调 `fs.forgetBuffers(buffers)`。
- **新增** `SceneFs.forgetBuffers(buffers)`：`contents` 里已完成、字节的 `buffer` 在这批里的条目删掉。未完成的 Promise 不动，它们的字节还没被转移。
- **新增** `SceneCompileSession.stats(): { cachedBytes: number; mdls: number; files: number; programs: number; textures: number }`。
  - `cachedBytes` = `contents` 里已完成条目的字节数 + `pkgWindows` 已完成窗口的字节数。
  - 给宿主日志和冒烟看内存。wasm 线性内存由 Worker 另报（点 2）。

## 点 2 — 协议与 Worker（`compile/protocol.ts`、`compile/worker.ts`、新 `compile/workerHandler.ts`）

- **修改** 协议：
```ts
export type WorkerRequest =
  | ({ type: "open" } & OpenRequest)                         // 修改：start 改名 open，字段不变
  | { type: "fragment"; id: number; request: FragmentRequest } // 新增
  | { type: "close" }                                          // 新增
  | { type: "file-result"; id: number; bytes?: Uint8Array; error?: FileError };
export type WorkerResponse =
  | { type: "file"; … }                                        // 不变
  | { type: "progress"; done: number; total: number }          // 不变
  | { type: "opened"; bundle: SceneBundle }                    // 修改：done 改名 opened
  | { type: "error"; message: string }                         // 不变：只用于 open 失败
  | { type: "fragment-done"; id: number; delta: FragmentDelta; stats: SessionStats }      // 新增
  | { type: "fragment-error"; id: number; message: string; broken: boolean };             // 新增
```
  - `SessionStats` = 点 1 的 `stats()` 加 `wasmBytes`，即翻译器 wasm 的线性内存字节数；`Wpesl2wgsl` 暴露一个只读的 `memoryBytes`。
  - `opened` 也带一份 `stats`。
- **新增**（`compile/workerHandler.ts`）：把 Worker 的逻辑做成可在 Node 里测的处理器。
```ts
/** Worker 的消息处理（L2）：`post` 是 postMessage（带转移表）。worker.ts 只做 `self.onmessage = handler`。 */
export function createWorkerHandler(post: (message: WorkerResponse, transfer: Transferable[]) => void): (message: WorkerRequest) => Promise<void>;
```
  处理规则：
  - **`open`**：
    - 只收一次，第二次回 `error`；
    - 开会话、逐个 `compileObject`、`finalize`；
    - `post({ type: "opened", bundle, stats }, transferableBuffers(bundle))` 之后，立刻 `session.forgetBuffers(new Set(转移表))`。
  - **`fragment`**：
    - 排进串行队列（一条 Promise 链），轮到时：会话坏了就回 `fragment-error`（`broken: true`）；
    - 否则 `compileFragment`，成功后查增量里有没有已分离的缓冲。判法：遍历增量里的类型化数组，`buffer.detached === true`，或 `byteLength === 0` 而视图长度非 0。有就回 `fragment-error`（`detached`、`broken: true`）。
    - 正常时 `post({ type: "fragment-done", id, delta, stats }, 增量新纹理的 mip 缓冲)`，再 `forgetBuffers` 这批（纹理不在两处缓存里，调用是为对称，无害）。
    - `compileFragment` 抛错时把会话标坏，回 `fragment-error`（`broken: true`）。
  - **`close`**：标记关闭，之后的请求都回错误；`worker.ts` 收到后 `self.close()`。
  - **`file-result`**：不变。
- **修改** `worker.ts`：只剩建 reader（不变）和 `self.onmessage = createWorkerHandler((m, t) => self.postMessage(m, { transfer: t }))`。

## 点 3 — 客户端（`compile/client.ts`、`compile/decode.ts`）

- **新增**
```ts
/** 常驻的编译会话（L2）：一个 Worker、一个场景。 */
export interface CompileSessionClient {
  /** 编一个对象。增量里的 FreeImage 新纹理已在主线程解好（同整场）。会话坏了或已关时 reject（`SessionBrokenError`）。 */
  compileFragment(request: FragmentRequest, signal?: AbortSignal): Promise<FragmentDelta>;
  /** 最近一次 opened / fragment-done 带回的统计 */
  readonly stats: SessionStats | null;
  readonly broken: boolean;
  close(): void;
}
export class SessionBrokenError extends Error {}
/** 开会话：整场编译 + 主线程解 FreeImage，返回 bundle 与常驻会话。`signal` 只管打开这一段：打开前 / 中取消就关 Worker。 */
export async function openSceneSession(input: WorkerCompileInput): Promise<{ bundle: SceneBundle; session: CompileSessionClient }>;
```
  - **`compileFragment` 的 `signal`**：取消只是不再等结果，Worker 照常编完，会话不受影响，结果丢掉。
  - **读文件**：读文件请求与现在一样由客户端代读，会话常驻期间一直接收。
  - **`close`**：发 `close` 再 `terminate`，幂等。
  - **Worker 出错**（`onerror`）：标坏，未完成的请求都 reject。
- **修改** `compileSceneInWorker` = `openSceneSession` 之后立刻 `session.close()`，返回 bundle。签名与行为不变。
- **修改** `decode.ts`：抽出按纹理列表解码的入口，例如 `decodeEncodedTextureList(textures, cache, onProgress)`。整场版改成调它，供片段增量复用。

## 点 4 — 宿主持有会话（`host.ts`）

- **修改** `reload`：`compileSceneInWorker` 换成 `openSceneSession`，拿到 `{ bundle, session }`。
  - 本次加载期间会话归这个局部变量，`try / finally` 保证没交出去就关：被新的加载取代、退回、出错、`init` 里建层导致放弃这一次时都关掉。
  - 场景换上（`this.bundle = bundle` 那里）时：
    - 关掉旧的 `this.compileSession`；
    - 新会话**用得上**就交给 `this.compileSession`，否则关掉。

    用得上 = `bundle.scripts.list.length > 0`，或 `bundle.bindings` 里有 `kind === "recompile" && reason === "layer-structure"` 的条目。
  - 「开始渲染」的日志里加一段会话统计：留没留、`cachedBytes`、`wasmBytes`。
- **修改** `fallback()`、`dispose()`：关掉 `this.compileSession`、置 null。
- **不做**：本步不调 `compileFragment`。L5 起才用。

## 点 5 — dev 探针的会话冒烟（`dev/sessionSmoke.ts` 新增，挂进 `dev/install.ts`）

```ts
/**
 * 开会话编整场，再对每个可取片段的对象（`fragmentBlocker` 为 null、配置不是数组）在新下标上请求片段，
 * 和主线程 `rekeyFragment(fragmentOf(bundle, i))` 逐字段比（同 L1 的 `ignore/live/l1/fragments.test.ts`，`unsupported`、`sceneFlips` 不比）。
 * 配置取会话打开前读的 scene.json 原文（加新 id），同 L1 对照测试的缺省。另报：增量是否为空、已分离缓冲次数、
 * 每个片段的耗时、opened / 最后一次的 stats、bundle 摘要（sha256，和同一场景 compileSceneInWorker 的摘要比）。
 */
export async function sessionSmoke(imageIds: string[], options?: { maxObjects?: number }): Promise<unknown>;
```
- 规范化与比较函数从 L1 的对照测试拷进来，放在 `dev/` 下，生产构建摇掉。

## 验收

- **全库编译产物**：`ignore/live/l0/bundlehash.test.ts` 跑改后源码，233 张与 `bundle-base-1.json` 相同。合并没动 `compile/`，基线仍有效；动手前先重跑一次确认。
- **单测**（只跑相关文件）：
  - `compile/workerHandler.test.ts`：用 L1 `fragment.test.ts` 的内存工程与假翻译器，处理器的 `post` 记到数组里，读文件请求由测试按内存表回 `file-result`。
    - `opened` 的 bundle 与 `compileScene` 相同；
    - 把 `opened` 的转移表用 `structuredClone(x, { transfer })` 真转走之后，再编一个**模型对象**和一个用同一 mdl 的新对象，片段正常、没有已分离缓冲；
    - 不调 `forgetBuffers` 时同一用例报 `detached`（证明这条判据有效）；
    - 两个片段请求并发发出，按顺序完成，结果与串行相同；
    - `compileFragment` 抛错后会话变坏，之后的请求回 `broken`；
    - `close` 之后的请求回错误；
    - 第二次 `open` 回错误。
  - `compile/fs.test.ts`（已有就加用例）：`forgetBuffers` 只删落在这批缓冲上的已完成条目。
  - `compile/client.test.ts`（新）：桩掉全局 `Worker`，用同一个处理器在进程内跑。
    - `compileSceneInWorker` 开完即关，结果同前；
    - `compileFragment` 的 `signal` 取消只丢结果，会话照常；
    - Worker `onerror` 让会话变坏、挂起的请求 reject；
    - 增量里的 FreeImage 纹理被解码；
    - `close` 幂等。
  - `src/compile` 全部测试照过。宿主相关的 `host.test.ts` 照过。
- **真机冒烟**（dev 应用，`buildSceneHost.ts` 重建宿主产物后用 `host_eval` 跑 `sessionSmoke`）：
  - 场景：语料里 puppet、带骨骼模型、静态模型、文本、粒子树、带脚本的各取 1–2 张，加 14294（运行中建层）、13608（脚本写 font）。
  - 判据：
    - 片段与改键逐字段相同；
    - 增量为空；
    - 已分离缓冲 0 次；
    - opened 的摘要与 `compileSceneInWorker` 相同；
    - stats 记进报告：cachedBytes、wasmBytes、每张场景片段的平均耗时。
- **宿主**：换几张场景、预览开关、桌面壁纸窗口重载，看日志里会话「留 / 关」与统计，没有报错。按 memory 不开图库预览，用 `host_open` 开屏外宿主。
- **变异**（按原字节还原）：
  - Worker 不串行（直接并发调 `compileFragment`）；
  - 转移后不 `forgetBuffers`；
  - `SceneFs.forgetBuffers` 删全部条目（应被统计或命中率用例抓到；抓不到就在报告里说明）；
  - 宿主换场景不关旧会话（单测或日志里会话数）；
  - 坏会话仍接受请求。
- **检查**：wpe-scene `tsc` 0 错误，改过的文件 prettier。
- **文档**：`cocs/wpe/WPE_SCENE.md`「编译会话与对象片段」补「常驻 Worker」一段（协议、串行、转移后遗忘、会话留与关的规则）；`cocs/README.md` 对应一句。不写 changelog。

## 验收中的补充（2026-11-17）

- **打开后清缓存**：全库冒烟（236 张、6425 个对象，片段与改键 0 不同、已分离 0）发现，会话打开后常驻的文件缓存中位数 0.9 MB、p90 5 MB，但 15027 / 13610 / 15336 分别 288 / 85 / 77 MB。大头是大 mdl 的原始文件字节：解析结果不指向它们，`forgetBuffers` 释放不到。
  - 处理：会话加 `trimCaches()`。Worker 在发回 `opened` 之前与每个片段发回之前，清掉 `mdls` 与 `SceneFs` 的 `contents` / `pkgWindows` / `resolved`，之后编片段的文件经主线程重读。
    - 只在打开时清不够：第二轮冒烟每个对象都编片段，缓存又涨回原规模。
    - `trimCaches` 测试开关同 `forgetAfterTransfer`。
- **队列卡死**：片段任务里意外抛错（发回时结构化克隆失败）会让串行队列变成 rejected，之后的请求永远没有回复。改成队列只接已兜住的 Promise，意外异常也标坏并回 `fragment-error`，补了用例并做了变异。

## 交付

sonnet 执行代理在主工作区实现。
- **只改**：
  - `apps/wpe-scene/src/compile/` 下的 `protocol.ts`、`worker.ts`、`workerHandler.ts`（新）、`client.ts`、`decode.ts`、`fs.ts`、`bundle.ts`（只加 `forgetBuffers` / `stats` 与 `readMdl` 记缓冲）、`wpesl2wgsl` 的 `memoryBytes`、对应测试；
  - `apps/wpe-scene/src/host.ts`；
  - `apps/wpe-scene/src/dev/sessionSmoke.ts`、`dev/install.ts`。
- **不碰**：`render/`、`particles/`、dev 工具，以及别人未提交的文件。
- **dev 应用相关**：`buildSceneHost.ts` 重建宿主产物与真机冒烟由我来做，执行代理不碰 dev 应用。
