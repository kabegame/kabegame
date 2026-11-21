# 场景编译搬到宿主主线程 + 壁纸目录里的着色器翻译缓存

> 2026-11-20 立项。用户要求：编译结果缓存，放在壁纸项目目录里；编译能搬到主线程；编译期可以卡着，改设置整场重载时的卡顿当作「正在干活」的信号，运行中的卡顿也可以接受。
> 先用临时手段验证「搬到主线程」的效果（若干基线，最重的是「实时太阳系」15027），之后正式实现时不能留下收发消息模型的痕迹。

## 总体设计思路

场景的整场编译与运行中的片段编译（L5 建层、L6 单对象重编译）现在跑在每个宿主一个的编译 Worker 里。Worker 不能 `fetch(file:)`，每次读文件都经 `postMessage` 让主线程代读再传回，bundle 与片段增量再结构化克隆、转移回主线程。这一步把编译会话挪回宿主主线程，并给着色器翻译加一层存在壁纸目录里的持久缓存。

**先验证，再正式做。** 验证用最省事的办法：一个同线程的「假 Worker」（`postMessage` 改成同线程结构化克隆加微任务送达），把现有的 Worker 处理器原样接上，只换掉 `new Worker(...)` 这一行，在若干基线场景上比「编译」用时。这段代码标 `// DEBUG-compile-thread`，只在工作区里跑，不提交。验证通过后正式实现：编译会话直接是主线程上的一个对象，宿主直接调它的方法，没有消息类型、请求编号、文件代读、转移表与「忘掉已转移缓冲」这一整套；`worker.ts`、`workerHandler.ts` 与 `protocol.ts` 里的消息定义删掉，测试改写成直接测会话对象。

**正式版的隔离边界要先核对再定。** 今天 bundle 与片段增量是克隆出来的独立对象，宿主改它们不会碰到会话自己的表（会话据这些表算下一个片段的「只增的场景级增量」）。去掉消息之后要逐处核对宿主是否改写 bundle / 增量里与会话共享的对象（登记表 `SceneRegistry`、`addObject`、`rekeyFragment` 等）：不改就直接共享；改的地方要么在会话出口处显式深拷贝那一部分，要么让宿主改自己的副本。核对结论写进本文件再实现。

**卡顿的取舍（用户已确认）。** 编译期间不让出。首次加载期间只有缩略图与进度，卡着没关系；整场重新加载（改壁纸设置、场景级重编译属性、脚本写 `general/…`、清空脚本存储、设备丢失重试、重排失败）时旧场景会一顿一顿，作为「正在干活」的信号；运行中的片段大多命中会话里的翻译缓存，遇到新变体时每个约 20 ms。场景宿主是独立的渲染进程（CDP 里是单独的 `iframe` 目标），卡的只是这个场景，主窗口界面不受影响；同一窗口的两个宿主（应用背景 + 预览）大概率共进程，应用背景本来就强制暂停。

**翻译缓存只缓存着色器翻译**，存在壁纸目录的一个固定文件里。翻译（WPESL → WGSL，wasm）是输入的纯函数。键由「首个请求」算出：顶点 / 片元 / 几何源码、COMBO、纹理槽、合并后的宏、`litDefines`、`fogDefines`，加翻译器 wasm 字节的 SHA-256（翻译器一升级整份作废）；头文件第一次翻译时才知道，所以条目里记下最终用到的头文件名与内容哈希、注解缺省纹理的名字与格式，命中时逐个核对，不一致就重新翻译。翻译失败的结果也缓存（不支持项照样复现）。宿主在开会话前经现成的 `file:` 通路读缓存文件（场景目录本来就在宿主的放行范围里）；写经新的后端命令 `wpe_scene_cache_write`（只给场景宿主 capability：按图片 id 查库里的场景行、只写这个固定文件名、临时文件 + 改名、限大小，失败只记日志）。文件名加进 `wpe::dir_hash::list_files` 的忽略表，目录哈希、`/file` 文件清单（跨机器传壁纸）、整目录复制三处一起跳过。

**翻译缓存省不到的大头另立一项。** 15027 的 CPU profile（Node，热身后一次）：编译约 6.0 s，其中 `decodeLz4Block`（`compile/tex.ts:122`，纹理 LZ4 解压，纯 JS）3.0 s、翻译 1.1 s、脚本 API 扫描（`tokenizeScript` 等）0.5 s。LZ4 解压是另一个独立的优化点（更快的解码实现，或换成 wasm），不在本文件范围，结论报给用户另定。

## 现状锚点

**a. 宿主开会话：每次 `new Worker`**（`apps/wpe-scene/src/compile/client.ts:251`）
```ts
export async function openSceneSession(input: WorkerCompileInput) {
  if (input.signal?.aborted) throw abortError();
  const module = await getModule();                 // 现状：主线程 fetch + WebAssembly.compile，模块交给 Worker 实例化
  if (input.signal?.aborted) throw abortError();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });   // 现状：每个会话一个 Worker
  const session = new WorkerSession(worker, input.reader ?? new FetchSceneReader(), input.textureCache);
  ...
}
```

**b. Worker 端读文件：经主线程代读**（`apps/wpe-scene/src/compile/workerHandler.ts:96`）
```ts
function ask(operation, path, start?, end?) {
  const id = nextId++;
  post({ type: "file", id, operation, path, start, end }, []);   // 现状：每次读都发给主线程，等 file-result
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
```

**c. 打开与片段：克隆 + 转移 + 忘掉已转移的缓冲**（`workerHandler.ts:168`、`:216`）
```ts
const transfer = transferableBuffers(bundle);
post({ type: "opened", bundle, stats: stats(opened), exactConfigs: opened.exactConfigs() }, transfer);   // 现状：结构化克隆，宿主拿到独立副本
if (options.forgetAfterTransfer !== false) opened.forgetBuffers(new Set(transfer));                    // 现状：会话忘掉已分离的缓冲
```

**d. 翻译：每个会话一个 `ShaderCompiler`，内存缓存随会话消失**（`apps/wpe-scene/src/compile/shader.ts:146`、`bundle.ts:1732`）
```ts
export class ShaderCompiler {
  private readonly cache = new Map<string, Promise<TranslateOutcome>>();   // 现状：只在本会话内去重
  private async translate(shader, combos, textures, scope, defines, geometry) {
    const result = await translateWithIncludes(this.translator, { vertex, fragment, ..., litDefines, fogDefines }, readInclude, undefined, readFormat);
    // 现状：每次加载都从头翻译
  }
}
```

**e. 目录枚举的忽略表**（`src-tauri/kabegame-core/src/wpe/dir_hash.rs:17`）
```rust
/// 访达、资源管理器会自己往目录里写的文件，不算壁纸内容（文件名不分大小写）。
const IGNORED_FILE_NAMES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];   // 现状：没有缓存文件
```

**f. 场景宿主能调的命令**（`src-tauri/kabegame/permissions/wpe-scene-host.toml:4`）
```toml
commands.allow = ["wpe_scene_target", "wpe_scene_report", "wpe_scene_shortcut_icon"]   # 现状：没有写入类命令
```

## 基线

| 场景 | 图片 id | 工坊 id | 规模 | 应用里「编译」（Worker 版，已有日志） | Node 编译（热身后） |
| --- | --- | --- | --- | --- | --- |
| 实时太阳系 Live Solar System（最重） | 15027 | 3662790108 | 847 层、58–62 程序、读 484 MiB | 10648 / 11302 / 12145 / 10733 ms | 5981–7264 ms（LZ4 3.0 s、翻译 1.1–1.3 s） |
| Solar system 太阳系 | 15013 | 3455121165 | 115 层、29 程序 | 1129 ms | 1608–1644 ms（翻译 1.1–1.3 s） |
| （着色器多） | 16045 | 3842750517 | 150 层、60 程序 | 3188 ms | 1225–1581 ms（翻译 0.8–1.0 s） |
| （puppet 大） | 16046 | 3840931677 | 16 层、8 程序、读 51 MiB | 1517 ms | 536–605 ms |
| 全屏组 | 15881 | 3814353826 | 15 层、11 程序 | 316–689 ms | 142–161 ms |

每张在 dev 预览里各测冷启动 3 次（同一窗口尺寸、同样设置），取「开始渲染」日志里的「编译」与「用时」。Node 数据来自 `ignore/compile-cache/probe.test.ts` 与 `profile.test.ts`。

## 步骤 1 — 临时验证：同线程「假 Worker」（不提交）

- `client.ts` 里加 `InThreadWorker`（标 `// DEBUG-compile-thread`）：`postMessage` → `structuredClone(message, { transfer })` + `queueMicrotask` 交给 `createWorkerHandler`；`terminate` 之后丢消息；`openSceneSession` 里 `new Worker(...)` 换成它。
- 重建宿主（`buildSceneHost.ts`），五张基线各测 3 次，和 Worker 版比「编译」与总用时。
- 结论写进本文件；还原 `client.ts`（`DEBUG-compile-thread` 全部删掉）。

### 步骤 1 结果（2026-11-21）

测法：dev 屏外宿主（主窗口在前台，`visibilityState` visible），开关改成页面全局 `__kbCompileInThread`（只由验证宿主设，默认仍是真 Worker），同一宿主里 W（Worker）/ T（同线程）交替各 3 次。每次 `renderFrame({ profile: 120 })`：`compileMs` = 开编译会话 + 主线程解 FreeImage；帧耗时 = 120 帧（1/60 s 推进）每帧「编码 + 提交 + 等 GPU 完成」的均值 / p95 / 最大，此时编译会话还开着；`sha` 是读回帧的 SHA-256 前 12 位。当时机器上有 7 个空转的 `wpe-renderdoc` MCP 进程（各占约 1 核，总 CPU 60–70%），交替测量抵消了这部分噪声。

| 场景 | W 编译（3 次，ms） | T 编译（3 次，ms） | 均值变化 | 帧耗时均值 W / T（ms） | 画面 |
| --- | --- | --- | --- | --- | --- |
| 15881 | 226 / 273 / 254 | 243 / 213 / 226 | 251 → 227（−10%） | 4.50 / 4.34 | 6 次相同 |
| 16046 | 1063 / 906 / 1012 | 920 / 875 / 1086 | 994 → 960（−3%） | 3.34 / 3.32 | 6 次相同 |
| 16045 | 3237 / 2985 / 3016 | 2873 / 2792 / 2783 | 3079 → 2816（−9%） | 14.33 / 14.39 | 6 次相同 |
| 15013 | 1235 / 1055 / 1058 | 894 / 926 / 997 | 1116 → 939（−16%） | 5.46 / 5.08 | 6 次相同 |
| 15027 | 9372 / 8323 / 8448 | 8347 / 8159 / 7839 | 8714 → 8115（−7%） | 13.40 / 13.03 | 6 次相同 |

结论：
- 搬到主线程编译快 3%–16%（绝对值 0.03–0.6 s），运行时帧耗时不变，画面逐字节相同。
- 收益小于预期：应用里比 Node 慢的部分大多不在 Worker 的代读与消息上；编译本身的大头（15027 的 LZ4 解压约 3 s、着色器翻译约 1.1 s）在哪个线程上都一样慢。
- 前一天的 Worker 基线（15027 15–17 s）是在 15 个空转进程下测的，和本表不可直接比；本表内部的 W / T 是同一时段交替测的，可比。
- 帧耗时是探针的离屏逐帧计时（不跑脚本、不走 rAF），产品帧循环里的帧率没测（屏外宿主不跑帧循环）。

**决定（2026-11-21，用户）：收益不大，不做步骤 2，编译仍留在 Worker。** 临时代码已还原（`client.ts` 回到 HEAD，dev 宿主产物按 `CARGO_TARGET_DIR=target-dev` 重建，产物里不再有 `__kbCompileInThread`）。步骤 3（翻译缓存）同时搁置。要提速时优先看 LZ4 解压（15027 约 3 s）。Node 探针留在 `ignore/compile-cache/`（`probe.test.ts`、`profile.test.ts`）。

**顺带查明**：测量期间 15013 / 16045 的画面哈希变了，不是 P13k / P14 的回归，而是 dev 换到 `target-dev` 后 `target-dev/debug` 缺 `dxil.dll`（`bin/windows/x86_64/cef-build` 的导出里没有它），Dawn 退回 FXC 编译着色器；放回旧的 `dxil.dll` 重启 dev 后哈希回到原值（15013 `6d6c90b501ae`、16045 `32d83eb1e5fe`）。CEF 导出缺 `dxil.dll` 是待修的问题。

## 步骤 2 — 正式：主线程编译会话，不用消息

- **核对**：宿主（`host.ts`、`render/`、`script/`、`registry.ts`）有没有改写 bundle / 片段增量里与会话共享的对象；结论与对应处理写在这里再动手。
- **新增** `compile/session.ts`：`SceneSession` 直接持有 `SceneCompileSession` 与翻译器；`open()` 整场编译 + `finalize` + `trimCaches` + 主线程解 FreeImage；`compileFragment()` 串行（Promise 链）、出错标 `broken`、编完 `trimCaches`；`close()`。对外接口与现在的 `CompileSessionClient` 相同（`stats`、`exactConfigs`、`broken`），宿主不改调用。
- **修改** `client.ts`：`openSceneSession` 直接建 `SceneSession`；翻译器实例每个宿主一份。
- **删除** `compile/worker.ts`、`compile/workerHandler.ts`、`protocol.ts` 里的消息类型（`WorkerRequest`、`WorkerResponse`、`encodeFileError` / `decodeFileError` 等只为消息服务的部分）、`bundle.ts` 里只为转移服务的 `transferableBuffers` / `forgetBuffers`（若核对后不再需要）。
- **测试**：`workerHandler.test.ts` 改写成 `session.test.ts`，覆盖打开、片段串行、出错标坏、关闭后拒绝、`trimCaches` 后片段仍完整、（按核对结论）宿主改 bundle 不影响下一个片段。

## 步骤 3 — 壁纸目录里的翻译缓存

- **新增** `compile/translationCache.ts`：
```ts
export interface TranslationCacheEntry {
  includes: Record<string, string>;                    // 头文件名 → 内容 SHA-256
  formats: Record<number, [string, number | null]>;    // 槽 → [缺省纹理名, 格式]
  result: TranslateResult;
  usedAt: number;
}
/** 一个场景的翻译缓存：键 = 首个请求 + 翻译器版本的 SHA-256。命中时由调用方核对头文件与格式。 */
export class TranslationCache {
  constructor(readonly translatorHash: string, entries?: Record<string, TranslationCacheEntry>);
  key(request: TranslateRequest): Promise<string>;
  get(key: string): TranslationCacheEntry | undefined;
  put(key: string, entry: TranslationCacheEntry): void;    // 记 dirty
  readonly dirty: boolean;
  serialize(limitBytes: number): Promise<Uint8Array>;       // JSON → gzip，按 usedAt 截到上限
  static parse(bytes: Uint8Array, translatorHash: string): Promise<TranslationCache>;   // 版本不符 / 坏文件 → 空缓存
}
```
- **修改** `ShaderCompiler.translate`：先查缓存，命中且头文件、格式核对一致就直接用；否则照旧翻译，并把最终的头文件与格式记进条目（`translateWithIncludes` 多返回这两项）。
- **修改** `CompileSceneInput` 加可选 `translationCache`，经 `openCompileSession` 交给 `ShaderCompiler`。语料扫描、dev 探针不传，行为不变。
- **修改** `host.ts` 的 `reload()`：开会话前读 `<场景目录>/kabegame_scene_cache.json.gz`（读不到当空）；整场编完若 dirty 调 `wpe_scene_cache_write`；运行中片段带来新条目时去抖 5 s 再写。「开始渲染」日志加「翻译缓存 命中 N / 共 M」。
- **新增**（Rust）`wpe_scene_cache_write(image_id, bytes)`：校验同 `wpe_scene_target`，写固定文件名（临时文件 + `rename`），超过 8 MiB 拒绝；`wpe-scene-host.toml` 放行、注册进 `generate_handler!`。
- **修改**（Rust）`dir_hash.rs` 的忽略表加上缓存文件名（常量在 `wpe` 下共用），补测试：有缓存文件时目录哈希与文件清单不变。
- **测试**：命中不调翻译器、头文件改了重新翻译、翻译器版本不同整份作废、失败结果也命中、截断保留最近使用的。

## 验证

- wpe-scene：`session.test.ts`、`translationCache.test.ts`、`shader` 相关；`tsc`。Rust：`wpe::dir_hash` 与新命令。
- `kbp corpus scan` 前后比：全语料 unsupported 不变。
- dev：五张基线冷启动（删缓存文件）与热启动各 3 次，对照上表；缓存文件生成在壁纸目录；重新导入同一张壁纸，目录哈希不变。
- 变异：缓存不核对头文件、不带翻译器版本、忽略表漏掉缓存文件。
- 回归文档一节、changelog 一行；`cocs/wpe/WPE_SCENE.md`「编译会话」（Worker 的描述全部改掉）与 `WPE_IMPORT.md`（目录哈希的忽略项）同步。
