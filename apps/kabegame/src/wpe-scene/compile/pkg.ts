/**
 * Wallpaper Engine `scene.pkg` 读取：创意工坊发布的场景壁纸把 `scene.json`、模型、材质、着色器、`.tex` 等资源打进这一个文件。
 *
 * 格式与解析流程移植自 linux-wallpaperengine（https://github.com/Almamu/linux-wallpaperengine，GPLv3，与本项目同许可）的
 * `src/WallpaperEngine/Data/Parsers/PackageParser.cpp`（目录表）与 `src/WallpaperEngine/FileSystem/Adapters/Package.cpp`（按条目读取）：
 *
 * ```text
 * sizedString header        // "PKGV00xx"；sizedString = u32 小端长度 + 字节（无结尾 NUL）
 * u32         count
 * count × { sizedString name, u32 offset, u32 length }
 * <数据区>                   // 条目数据位于「目录表结束处 + offset」，长度 length
 * ```
 *
 * 本机 5 张工坊样本（`PKGV0018`、`0021`、`0022`、`0024`）的布局相同，条目首尾相接，最后一条正好结束在文件末尾；
 * 条目名是 UTF-8、正斜杠分隔的相对路径（有中文，也有末尾带空格的）。
 *
 * 与原实现的差别：
 * - 不整包读入：包可达数百 MB（含视频纹理），目录表与条目都经 {@link RangeRead} 按区间读。
 *   目录表长度事先未知，先读一段，不够再加倍重读。
 * - 加了越界与长度校验（原实现信任文件内容）；条目名按原样精确匹配，同名时取第一条（同原实现的 `find_if`）。
 */

/**
 * 按字节区间读同一个文件，返回 `[start, end)`。跨过文件末尾时截短；`start` 不在文件内时抛错。
 * 主线程用带 `Range` 头的 `fetch(file:)` 实现，测试用内存或 Node `fs`。
 */
export type RangeRead = (start: number, end: number) => Promise<Uint8Array>;

export interface PkgEntry {
  /** 包内相对路径，如 `materials/foo.tex`。 */
  name: string;
  /** 相对数据区起点的偏移。 */
  offset: number;
  length: number;
}

export interface OpenPkgOptions {
  /** 第一次读目录表的字节数；不够时加倍。只在测试里调小。 */
  initialChunk?: number;
}

const DEFAULT_CHUNK = 64 * 1024;
/** 目录表上限：本机样本最大不到 7 KB，这里留足余量，防止损坏文件把读取放大到整包。 */
const MAX_TABLE_BYTES = 16 * 1024 * 1024;
/** 单个 sizedString 上限（头部与条目名）。 */
const MAX_STRING_BYTES = 64 * 1024;

export class PkgFormatError extends Error {
  override name = "PkgFormatError";
}

/** 目录表还没读完时由游标抛出，外层据此加大读取量重来。 */
class NeedMore extends Error {}

class Cursor {
  private pos = 0;
  private readonly view: DataView;
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.pos;
  }

  u32(): number {
    if (this.pos + 4 > this.bytes.length) throw new NeedMore();
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  sizedString(): string {
    const length = this.u32();
    if (length > MAX_STRING_BYTES) throw new PkgFormatError(`字符串长度异常：${length}`);
    if (this.pos + length > this.bytes.length) throw new NeedMore();
    const text = this.decoder.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }
}

interface ParsedTable {
  version: string;
  entries: PkgEntry[];
  baseOffset: number;
}

function parseTable(bytes: Uint8Array): ParsedTable {
  const cursor = new Cursor(bytes);
  const version = cursor.sizedString();
  if (!version.startsWith("PKGV"))
    throw new PkgFormatError(`不是 scene.pkg：头部为 ${JSON.stringify(version.slice(0, 16))}`);
  const count = cursor.u32();
  // 每条至少 12 字节（空名字 + offset + length），条目数不可能超过目录表上限能容纳的量
  if (count > MAX_TABLE_BYTES / 12) throw new PkgFormatError(`条目数异常：${count}`);
  const entries: PkgEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = cursor.sizedString();
    const offset = cursor.u32();
    const length = cursor.u32();
    entries.push({ name, offset, length });
  }
  return { version, entries, baseOffset: cursor.position };
}

export class ScenePkg {
  private readonly byName = new Map<string, PkgEntry>();

  private constructor(
    private readonly read: RangeRead,
    /** 头部版本串，如 `PKGV0024`。 */
    readonly version: string,
    /** 按包内顺序。 */
    readonly entries: readonly PkgEntry[],
    /** 数据区起点（目录表结束处）。 */
    readonly baseOffset: number,
  ) {
    for (const entry of entries) {
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
    }
  }

  /** 读目录表；格式不对抛 {@link PkgFormatError}。 */
  static async open(read: RangeRead, options: OpenPkgOptions = {}): Promise<ScenePkg> {
    let chunk = options.initialChunk ?? DEFAULT_CHUNK;
    for (;;) {
      const bytes = await read(0, chunk);
      try {
        const table = parseTable(bytes);
        return new ScenePkg(read, table.version, table.entries, table.baseOffset);
      } catch (error) {
        if (!(error instanceof NeedMore)) throw error;
        // 读到的比要的少，说明已到文件末尾，目录表本身不完整
        if (bytes.length < chunk) throw new PkgFormatError("目录表被截断");
        if (chunk >= MAX_TABLE_BYTES) throw new PkgFormatError("目录表过大");
        chunk = Math.min(chunk * 2, MAX_TABLE_BYTES);
      }
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): PkgEntry | undefined {
    return this.byName.get(name);
  }

  /** 读一个条目的完整字节；包里没有这个名字时返回 null，交给下一个资源来源。 */
  async readEntry(name: string): Promise<Uint8Array | null> {
    const entry = this.byName.get(name);
    if (!entry) return null;
    if (entry.length === 0) return new Uint8Array(0);
    const start = this.baseOffset + entry.offset;
    const bytes = await this.read(start, start + entry.length);
    // 短了说明包被截断；长了说明读取方没有按区间返回（例如 Range 头被忽略）
    if (bytes.length !== entry.length) {
      throw new PkgFormatError(`条目 ${entry.name} 应为 ${entry.length} 字节，实际读到 ${bytes.length}`);
    }
    return bytes;
  }
}
