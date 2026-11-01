import { fileToUrl } from "@/utils/fileUrl";
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

export class SceneFs {
  private pkg: Promise<ScenePkg | null> | null = null;
  private readonly pkgWindows = new Map<number, Promise<Uint8Array>>();
  private readonly resolved = new Map<string, Promise<SceneFile | null>>();
  private readonly contents = new Map<string, Promise<{ source: SceneSource; bytes: Uint8Array } | null>>();

  constructor(
    readonly projectDir: string,
    readonly sceneAssets: readonly string[],
    readonly reader: SceneReader,
  ) {}

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
    }
    try {
      return (await task).slice(start - windowStart, end - windowStart);
    } catch (error) {
      this.pkgWindows.delete(windowStart);
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
    }
    try {
      return await task;
    } catch (error) {
      this.resolved.delete(rel);
      throw error;
    }
  }

  private async resolveUncached(rel: string): Promise<SceneFile | null> {
    const projectPath = join(this.projectDir, rel);
    try {
      return this.loose("project", projectPath, await this.reader.readRange(projectPath, 0, 4096));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const pkg = await this.openPkg();
    const entry = pkg && this.fromPkg(pkg, rel);
    if (entry) return entry;
    for (const root of this.sceneAssets) {
      const path = join(root, rel);
      try {
        return this.loose("assets", path, await this.reader.readRange(path, 0, 4096));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return null;
  }

  /** JSON / shader 用：直接整读，命中与未命中都只请求一次，并缓存内容。 */
  async read(raw: string): Promise<{ source: SceneSource; bytes: Uint8Array } | null> {
    const rel = normalizeScenePath(raw);
    let task = this.contents.get(rel);
    if (!task) {
      task = this.readUncached(rel);
      this.contents.set(rel, task);
    }
    try {
      return await task;
    } catch (error) {
      this.contents.delete(rel);
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
    const projectPath = join(this.projectDir, rel);
    try {
      const bytes = await this.reader.readWhole(projectPath);
      this.resolved.set(rel, Promise.resolve(this.loose("project", projectPath)));
      return { source: "project", bytes };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const pkg = await this.openPkg();
    const entry = pkg && this.fromPkg(pkg, rel);
    if (entry) {
      const bytes = await entry.readRange(0, entry.size!);
      if (bytes.length !== entry.size) throw new Error(`文件被截断：${rel}`);
      this.resolved.set(rel, Promise.resolve(entry));
      return { source: "pkg", bytes };
    }
    for (const root of this.sceneAssets) {
      const path = join(root, rel);
      try {
        const bytes = await this.reader.readWhole(path);
        this.resolved.set(rel, Promise.resolve(this.loose("assets", path)));
        return { source: "assets", bytes };
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    this.resolved.set(rel, Promise.resolve(null));
    return null;
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
