import { fileToUrl } from "../fileUrl";
import { sameSceneDir, SceneRootIndex, type SceneFileList } from "./fileIndex";
import { ScenePkg } from "./pkg";

export type SceneSource = "project" | "pkg" | "assets";
export interface SceneFile {
  source: SceneSource;
  path: string;
  /** pkg 条目有确切长度；散文件不预先探测大小。 */
  size: number | null;
  /** 散文件首个区间读的结果，供 .tex 解析器复用。 */
  head?: Uint8Array;
  /**
   * 文件内容在磁盘上的位置：`path` 是要读的真实文件（散文件本身或 `scene.pkg`），`offset` 是内容起点。
   * 主线程按它直接区间读（FreeImage `.tex` 的 PNG / JPG mip 由主线程解码，Worker 不读这段字节）。
   */
  location: { path: string; offset: number };
  readRange(start: number, end: number): Promise<Uint8Array>;
}
/** effect 资源的查找范围：`dir` 是 effect.json 所在目录（如 `effects/tint`），`first` = effect.json 来自 assets。 */
export interface ResourceScope {
  dir: string;
  first: boolean;
}
export interface SceneReader {
  readWhole(path: string): Promise<Uint8Array>;
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
}

/** CEF 的 file: 响应为 200，没有 Content-Length / Content-Range，以实际字节数为准。 */
export class FetchSceneReader implements SceneReader {
  async readWhole(path: string): Promise<Uint8Array> {
    const response = await fetch(fileToUrl(path));
    if (!response.ok) throw new TypeError("Failed to fetch");
    return new Uint8Array(await response.arrayBuffer());
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      throw new RangeError("无效区间");
    const response = await fetch(fileToUrl(path), { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!response.ok || !response.body) throw new TypeError("Failed to fetch");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > end - start) {
          await reader.cancel();
          throw new Error(`Range 被忽略：${path}`);
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      result.set(part, at);
      at += part.length;
    }
    return result;
  }
}

export function normalizeScenePath(path: string): string {
  if (/^(?:[a-z]:|\\\\|\/\/)/i.test(path)) throw new Error(`禁止绝对路径：${path}`);
  const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ""))
    throw new Error(`禁止越界路径：${path}`);
  return normalized;
}

function join(root: string, rel: string): string {
  const separator = /^[a-z]:/i.test(root) || root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]$/, "") + separator + rel.replace(/\//g, separator);
}

function missing(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes("Failed to fetch");
}

/** 一个磁盘上的根目录（工程目录或某个 assets 目录）与它的文件表；没有表时 `index` 为 null，照旧逐个探。 */
interface LooseRoot {
  source: "project" | "assets";
  dir: string;
  index: SceneRootIndex | null;
}

export class SceneFs {
  private pkg: Promise<ScenePkg | null> | null = null;
  private readonly pkgWindows = new Map<number, Promise<Uint8Array>>();
  private readonly resolved = new Map<string, Promise<SceneFile | null>>();
  private readonly contents = new Map<string, Promise<{ source: SceneSource; bytes: Uint8Array } | null>>();
  // 已完成的缓存条目的同步镜像（L2）：Promise 不能同步看值，`forgetBuffers` / `cacheStats` 要看字节落在哪个缓冲上、有多大。
  // 只在对应的 Map 里还是同一个 Promise 时才写入，被删 / 被换的条目不会复活。
  private readonly settledContents = new Map<string, { source: SceneSource; bytes: Uint8Array } | null>();
  private readonly settledResolved = new Map<string, SceneFile | null>();
  private readonly settledWindows = new Map<number, Uint8Array>();
  /**
   * 三处都没有的路径（相对路径原样）：整个会话都记着，`clearCaches` 不清。脚本按名字反复建层、对象级重编译都会再问同一批路径，
   * 有文件表时它们本来不发请求，没表或表过时时才会逐个探，记住它们免得每次都探一遍。
   */
  private readonly absent = new Set<string>();
  private readonly projectRoot: LooseRoot;
  private readonly assetRoots: LooseRoot[];

  /**
   * `files`：场景文件表（`wpe_scene_files`）。给了就按表找：表里没有的位置不探、按表里的真实大小写读，三处都没有时才按原写法逐个探一次
   * （表可能过时）；目录写法对不上的根当没有表。不给（单测、语料扫描、取表失败）照旧逐个探。
   */
  constructor(
    readonly projectDir: string,
    readonly sceneAssets: readonly string[],
    readonly reader: SceneReader,
    files?: SceneFileList | null,
  ) {
    const indexOf = (dir: string, roots: readonly { dir: string; files: string[] }[]): SceneRootIndex | null => {
      const root = roots.find((item) => sameSceneDir(item.dir, dir));
      return root ? new SceneRootIndex(root.files) : null;
    };
    this.projectRoot = {
      source: "project",
      dir: projectDir,
      index: files ? indexOf(projectDir, [files.project]) : null,
    };
    this.assetRoots = sceneAssets.map((dir) => ({
      source: "assets" as const,
      dir,
      index: files ? indexOf(dir, files.assets) : null,
    }));
  }

  /** pkg 的小文件通常相邻；窗口合并 JSON / shader / 纹理头的请求，大 mip 直接区间读取。 */
  private async readPkgRange(start: number, end: number): Promise<Uint8Array> {
    const path = join(this.projectDir, "scene.pkg");
    const chunk = 64 * 1024;
    const windowStart = Math.floor(start / chunk) * chunk;
    if (end > windowStart + chunk) return this.reader.readRange(path, start, end);
    let task = this.pkgWindows.get(windowStart);
    if (!task) {
      task = this.reader.readRange(path, windowStart, windowStart + chunk);
      this.pkgWindows.set(windowStart, task);
      const created = task;
      void created.then(
        (bytes) => {
          if (this.pkgWindows.get(windowStart) === created) this.settledWindows.set(windowStart, bytes);
        },
        () => undefined,
      );
    }
    try {
      return (await task).slice(start - windowStart, end - windowStart);
    } catch (error) {
      this.pkgWindows.delete(windowStart);
      this.settledWindows.delete(windowStart);
      throw error;
    }
  }

  private openPkg(): Promise<ScenePkg | null> {
    return (this.pkg ??= ScenePkg.open((start, end) => this.readPkgRange(start, end)).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    }));
  }

  private loose(source: "project" | "assets", path: string, head?: Uint8Array): SceneFile {
    return {
      source,
      path,
      size: null,
      head,
      location: { path, offset: 0 },
      readRange: (start, end) => this.reader.readRange(path, start, end),
    };
  }

  private fromPkg(pkg: ScenePkg, rel: string): SceneFile | null {
    const entry = pkg.entry(rel);
    if (!entry) return null;
    const path = join(this.projectDir, "scene.pkg"),
      offset = pkg.baseOffset + entry.offset;
    return {
      source: "pkg",
      path: `${path}:${rel}`,
      size: entry.length,
      location: { path, offset },
      readRange: (start, end) => this.readPkgRange(offset + start, offset + end),
    };
  }

  /** .tex 用：第一次 4 KiB 区间读取同时判断散文件是否存在，解析器复用返回的 head。 */
  async resolve(raw: string): Promise<SceneFile | null> {
    const rel = normalizeScenePath(raw);
    let task = this.resolved.get(rel);
    if (!task) {
      task = this.resolveUncached(rel);
      this.resolved.set(rel, task);
      this.mirror(this.resolved, this.settledResolved, rel, task);
    }
    try {
      return await task;
    } catch (error) {
      this.resolved.delete(rel);
      this.settledResolved.delete(rel);
      throw error;
    }
  }

  private async resolveUncached(rel: string): Promise<SceneFile | null> {
    return this.locate(
      rel,
      async (source, path) => {
        try {
          return this.loose(source, path, await this.reader.readRange(path, 0, 4096));
        } catch (error) {
          if (!missing(error)) throw error;
          return null;
        }
      },
      async (pkg) => this.fromPkg(pkg, rel),
    );
  }

  /**
   * 按查找顺序（工程散文件 → `scene.pkg` → 各 assets）找 `rel`，`loose` / `packed` 是在一处读的办法（读不到返回 null）。
   * 有文件表的根：表里有就按表里的真实写法读，没有就跳过、留到最后；没有表的根照旧按原写法探。三处都没找到时，把表说没有的位置
   * 按原写法补探一遍（表可能过时：运行中新增的文件）。结果为 null 时记进 `absent`，之后同一路径不再找。
   */
  private async locate<T>(
    rel: string,
    loose: (source: LooseRoot["source"], path: string) => Promise<T | null>,
    packed: (pkg: ScenePkg) => Promise<T | null>,
  ): Promise<T | null> {
    if (this.absent.has(rel)) return null;
    // 表说没有、留到最后补探的位置（按查找顺序）
    const deferred: [LooseRoot["source"], string][] = [];
    const inRoot = async (root: LooseRoot): Promise<T | null> => {
      const exact = join(root.dir, rel);
      if (!root.index) return loose(root.source, exact);
      const real = root.index.find(rel);
      if (real !== null) {
        const hit = await loose(root.source, real === rel ? exact : join(root.dir, real));
        if (hit !== null || real === rel) return hit;
      }
      deferred.push([root.source, exact]);
      return null;
    };
    const project = await inRoot(this.projectRoot);
    if (project !== null) return project;
    const pkg = await this.openPkg();
    if (pkg) {
      const hit = await packed(pkg);
      if (hit !== null) return hit;
    }
    for (const root of this.assetRoots) {
      const hit = await inRoot(root);
      if (hit !== null) return hit;
    }
    for (const [source, path] of deferred) {
      const hit = await loose(source, path);
      if (hit !== null) return hit;
    }
    this.absent.add(rel);
    return null;
  }

  /** 任务完成时把值记进镜像（条目还是这个 Promise 才记）。 */
  private mirror<K, V>(live: Map<K, Promise<V>>, settled: Map<K, V>, key: K, task: Promise<V>): void {
    void task.then(
      (value) => {
        if (live.get(key) === task) settled.set(key, value);
      },
      () => undefined,
    );
  }

  /**
   * 忘掉字节落在这批缓冲上的缓存条目（L2：Worker 把缓冲转移给主线程之后，这里的视图就成了已分离的空缓冲，再读到会出错）。
   * - `contents`：只删已完成的条目（未完成的 Promise 字节还没被转移，由它们自己的调用方持有）；
   * - `resolved`：散文件首个区间读的 `head` 在这批里的条目（`.tex` 解析器复用它）；
   * - `pkgWindows`：窗口读出来后都是 `slice` 拷贝再用，从不转移，但窗口本身也检查一遍，保持对称。
   * 被删的下次再要就重读。
   */
  forgetBuffers(buffers: ReadonlySet<ArrayBuffer>): void {
    for (const [key, entry] of this.settledContents) {
      if (entry && buffers.has(entry.bytes.buffer as ArrayBuffer)) {
        this.contents.delete(key);
        this.settledContents.delete(key);
      }
    }
    for (const [key, entry] of this.settledResolved) {
      if (entry?.head && buffers.has(entry.head.buffer as ArrayBuffer)) {
        this.resolved.delete(key);
        this.settledResolved.delete(key);
      }
    }
    for (const [start, bytes] of this.settledWindows) {
      if (buffers.has(bytes.buffer as ArrayBuffer)) {
        this.pkgWindows.delete(start);
        this.settledWindows.delete(start);
      }
    }
  }

  /**
   * 清空文件缓存（L2，会话打开之后调）：`contents`、`pkgWindows`、`resolved` 连同同步镜像全部清掉，pkg 目录表与 `absent` 保留。整场编完之后它们是重复
   * 数据——全库冒烟里少数场景常驻 80–290 MB（大 mdl 的原始文件字节，解析结果不再指向它们，`forgetBuffers` 释放不到）。之后编片段要用的文件
   * 再经主线程重读。只在没有读取在途时调（打开结束、片段之间）。
   */
  clearCaches(): void {
    this.contents.clear();
    this.settledContents.clear();
    this.resolved.clear();
    this.settledResolved.clear();
    this.pkgWindows.clear();
    this.settledWindows.clear();
  }

  /** 缓存里已完成条目的字节数（`contents` 的文件内容 + `pkgWindows` 的窗口 + `resolved` 的 head）与整读文件数，给会话统计。 */
  cacheStats(): { bytes: number; files: number } {
    let bytes = 0;
    for (const entry of this.settledContents.values()) bytes += entry?.bytes.byteLength ?? 0;
    for (const window of this.settledWindows.values()) bytes += window.byteLength;
    for (const entry of this.settledResolved.values()) bytes += entry?.head?.byteLength ?? 0;
    return { bytes, files: this.settledContents.size };
  }

  /** JSON / shader 用：直接整读，命中与未命中都只请求一次，并缓存内容。 */
  async read(raw: string): Promise<{ source: SceneSource; bytes: Uint8Array } | null> {
    const rel = normalizeScenePath(raw);
    let task = this.contents.get(rel);
    if (!task) {
      task = this.readUncached(rel);
      this.contents.set(rel, task);
      this.mirror(this.contents, this.settledContents, rel, task);
    }
    try {
      return await task;
    } catch (error) {
      this.contents.delete(rel);
      this.settledContents.delete(rel);
      throw error;
    }
  }

  private async readUncached(rel: string): Promise<{ source: SceneSource; bytes: Uint8Array } | null> {
    const prior = this.resolved.get(rel);
    const known = prior ? await prior : undefined;
    if (known) {
      const bytes =
        known.source === "pkg" ? await known.readRange(0, known.size!) : await this.reader.readWhole(known.path);
      if (known.size !== null && bytes.length !== known.size) throw new Error(`文件被截断：${rel}`);
      return { source: known.source, bytes };
    }
    if (known === null) return null;
    const found = await this.locate<{ source: SceneSource; bytes: Uint8Array }>(
      rel,
      async (source, path) => {
        try {
          const bytes = await this.reader.readWhole(path);
          this.resolved.set(rel, Promise.resolve(this.loose(source, path)));
          return { source, bytes };
        } catch (error) {
          if (!missing(error)) throw error;
          return null;
        }
      },
      async (pkg) => {
        const entry = this.fromPkg(pkg, rel);
        if (!entry) return null;
        const bytes = await entry.readRange(0, entry.size!);
        if (bytes.length !== entry.size) throw new Error(`文件被截断：${rel}`);
        this.resolved.set(rel, Promise.resolve(entry));
        return { source: "pkg", bytes };
      },
    );
    if (!found) this.resolved.set(rel, Promise.resolve(null));
    return found;
  }

  async readRange(rel: string, start: number, end: number): Promise<{ source: SceneSource; bytes: Uint8Array } | null> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      throw new RangeError("无效区间");
    const file = await this.resolve(rel);
    if (!file) return null;
    if (file.size !== null && start >= file.size) throw new RangeError(`起点越界：${rel}`);
    const bytes = await file.readRange(start, file.size === null ? end : Math.min(end, file.size));
    if (file.size !== null && bytes.length !== Math.min(end, file.size) - start) throw new Error(`区间被截断：${rel}`);
    return { source: file.source, bytes };
  }

  async text(rel: string, scope?: ResourceScope | null): Promise<string | null> {
    const file = scope ? await this.readScoped(rel, scope) : await this.read(rel);
    return file ? new TextDecoder().decode(file.bytes).replace(/^\uFEFF/, "") : null;
  }

  /**
   * effect \u5185\u5F15\u7528\u7684\u76F8\u5BF9\u8DEF\u5F84\u3002WPE \u5185\u7F6E effect \u7684\u8D44\u6E90\u653E\u5728 effect.json \u6240\u5728\u76EE\u5F55\u4E0B\uFF08`assets/effects/tint/materials/\u2026`\u3001
   * `\u2026/shaders/\u2026`\uFF09\uFF1B\u9879\u76EE\u81EA\u5E26\u7684 effect\uFF08\u5982 razer \u7CFB\u7684 `effects/tint/effect.json`\uFF09\u5219\u628A\u6750\u8D28\u4E0E\u7740\u8272\u5668\u653E\u5728\u9879\u76EE\u6839\uFF0C
   * \u800C assets \u7684\u540C\u540D effect \u76EE\u5F55\u91CC\u53C8\u6709\u4E00\u4EFD\u5185\u7F6E\u7248\u672C\u3002
   * - effect.json \u6765\u81EA assets\uFF08`scope.first`\uFF09\uFF1A\u5148\u67E5 effect \u76EE\u5F55\uFF0C\u518D\u67E5\u6839\uFF1B
   * - \u6765\u81EA\u9879\u76EE / pkg\uFF1A\u5148\u67E5\u6839\u4E0B\u7684\u9879\u76EE / pkg \u6587\u4EF6\uFF0C\u518D\u67E5 effect \u76EE\u5F55\uFF0C\u6700\u540E\u624D\u662F\u6839\u4E0B\u7684 assets \u6587\u4EF6\u3002
   */
  async readScoped(rel: string, scope: ResourceScope): Promise<{ source: SceneSource; bytes: Uint8Array } | null> {
    if (scope.first) return (await this.read(`${scope.dir}/${rel}`)) ?? (await this.read(rel));
    const direct = await this.read(rel);
    if (direct && direct.source !== "assets") return direct;
    return (await this.read(`${scope.dir}/${rel}`)) ?? direct;
  }

  async resolveScoped(rel: string, scope: ResourceScope | null | undefined): Promise<SceneFile | null> {
    if (!scope) return this.resolve(rel);
    if (scope.first) return (await this.resolve(`${scope.dir}/${rel}`)) ?? (await this.resolve(rel));
    const direct = await this.resolve(rel);
    if (direct && direct.source !== "assets") return direct;
    return (await this.resolve(`${scope.dir}/${rel}`)) ?? direct;
  }
}
