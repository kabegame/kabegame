/**
 * 文本对象的字体：字体文件的位置约定、按「字体 + 字号」的 face 列表与 WPE 的回退链、逐码点分段（P6b 1c）。
 *
 * 照 WPE 2.8.42 的读码（`.claude/plans/wpe-import/3-scene/phase6/rea-p6b-raster.md` 2 节，汇编 `FUN_1401ad670`）：
 * - face 列表按「字体文件 + 字号」各一份，第 0 个是主字体（读不到时换成 `arial.ttf`），回退字体按 {@link FALLBACK_CHAIN}
 *   的顺序**按需**追加、永久留下；读不到或不是字体的文件跳过，以后也不再试（WPE 的计数器 `列表 + 0x18`）。
 * - 查一个码点：在已加载的 face 里按顺序找 `FT_Get_Char_Index ≠ 0`，都没有就沿回退链加载下一项再查。
 *   所以结果只取决于「主字体 + 回退链里存在的文件」这个顺序，和加载的先后无关。
 * - 分段：相邻码点的 face 不同就切段；ZWJ 与空白（`\t \n \r` 空格）找到的 face 不同也不切；哪个 face 都没有的码点
 *   留在当前段（排出 `.notdef`）。还没有段时（文字开头）空白、ZWJ 与找不到的码点**不进任何段**，等于被丢掉。
 *
 * 字体字节由宿主注入的异步读取器提供（{@link FontReader}），这里只同步地用已经读到的字节：某个回退字体还没读进来时，
 * 记进 `missing`、不推进回退链，调用方读完再排（{@link TextFonts.load}）。
 */
import type { FontMetrics, Wpefont, WpefontFace } from "../wpefont";

/**
 * 字体文件的位置（读取器的参数），两种：
 * - `system:<文件>`：`%WINDIR%\Fonts\<文件>`（`systemfont_*` 与回退链里的系统字体，WPE 用 `SHGetFolderPathW(CSIDL_FONTS)`）；
 * - 其余：引擎文件系统里的相对路径（先工程目录、再 WPE 的 `assets/`），如 `fonts/RobotoMono-Regular.ttf`、
 *   回退链里的 `fonts/TwemojiMozilla.ttf`。
 */
export type FontPath = string;

/** 读字体文件；读不到返回 null（不抛错）。 */
export type FontReader = (path: FontPath) => Promise<Uint8Array | null>;

export const SYSTEM_FONT_PREFIX = "system:";

/** `systemfont_*` → `%WINDIR%\Fonts` 下的文件，取 face 0（rea-p6b-raster 2.2，表 `0x140484cc0`）。 */
export const SYSTEM_FONTS: Readonly<Record<string, string>> = {
  systemfont_arial: "arial.ttf",
  systemfont_calibri: "calibri.ttf",
  systemfont_cambria: "cambria.ttc",
  systemfont_comicsans: "comic.ttf",
  systemfont_consolas: "consola.ttf",
  systemfont_sansserif: "micross.ttf",
  systemfont_segoe: "segoeui.ttf",
  systemfont_verdana: "verdana.ttf",
};

/** 主字体读不到时换成它（`FUN_1401ad400`）。 */
export const MAIN_FONT_FALLBACK: FontPath = `${SYSTEM_FONT_PREFIX}arial.ttf`;

/** 回退链（rea-p6b-raster 2.3，表 `0x140484c40`）。`NotoSans-Regular.ttf` 不在链里。 */
export const FALLBACK_CHAIN: readonly FontPath[] = [
  `${SYSTEM_FONT_PREFIX}arial.ttf`,
  `${SYSTEM_FONT_PREFIX}seguiemj.ttf`,
  `${SYSTEM_FONT_PREFIX}arialuni.ttf`,
  `${SYSTEM_FONT_PREFIX}segoeui.ttf`,
  "fonts/TwemojiMozilla.ttf",
  `${SYSTEM_FONT_PREFIX}seguisym.ttf`,
  `${SYSTEM_FONT_PREFIX}msyh.ttc`,
  `${SYSTEM_FONT_PREFIX}Malgun.ttf`,
];

/** 文本对象 `font` 字段 → 字体文件位置：`systemfont_*` 查表（只认这 8 个，WPE 逐个比字符串），其余原样当引擎路径。 */
export function fontPath(font: string): FontPath {
  const system = Object.hasOwn(SYSTEM_FONTS, font) ? SYSTEM_FONTS[font] : undefined;
  return system ? `${SYSTEM_FONT_PREFIX}${system}` : font;
}

/** 排版用的字号：float32、钳到 [1, 256]（`FUN_1401b0410` 开头）。 */
export function clampPointsize(pointsize: number): number {
  let size = Math.fround(pointsize);
  if (size >= 256) size = 256;
  if (!(size >= 1)) size = 1;
  return size;
}

/** 字号的 26.6：`trunc(size · 64)`，`FT_Set_Char_Size` 与字体键都用它。 */
export const size26_6 = (size: number) => Math.trunc(size * 64);

/** 字体键（WPE 的 `<路径>_<trunc(size · 64)>`）：图集与 face 列表都按它共享。 */
export const fontKey = (path: FontPath, size: number) => `${path}_${size26_6(size)}`;

/** 空白：`\t`、`\r`、空格（掩码 `0x100002200`，断行、省略号、两端对齐都用它）。 */
export function isBreakSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0d;
}

/** 分段时不切段的码点：ZWJ 与 `\t \n \r` 空格（掩码 `0x100002600`）。 */
function keepsSegment(cp: number): boolean {
  return cp === 0x200d || cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

/** face 列表里的一个字体。 */
export interface ListedFace {
  path: FontPath;
  face: WpefontFace;
  metrics: FontMetrics;
}

/** 一个「字体文件 + 字号」的 face 列表（WPE 字体管理器里的那份，跨对象共享）。 */
export class FaceList {
  /** 第 0 个是主字体（或替代它的 arial），之后是加载过的回退字体，按回退链顺序。 */
  readonly faces: ListedFace[] = [];
  /** 回退链下一个要试的下标；试过的（不管成没成）不再试。 */
  chainNext = 0;

  constructor(
    readonly key: string,
    readonly path: FontPath,
    readonly size: number,
  ) {}

  /** 主字体（行高、ascender、descender 都取它）。列表为空时抛错，调用方先判 `faces.length`。 */
  get main(): ListedFace {
    const face = this.faces[0];
    if (!face) throw new Error(`字体 ${this.path} 没有可用的 face`);
    return face;
  }
}

/** 分好的一段：同一个 face 排字。`start` 是这段第一个码点在整行里的下标。 */
export interface FontRun {
  start: number;
  text: number[];
  faceIndex: number;
}

/**
 * 字体字节与 face 列表，跨重新编译保留（宿主主线程，同 wpefont 实例）。查字、分段都是同步的；
 * 用到还没读进来的字体时记进 `missing`，由调用方 {@link load} 之后重排。
 */
export class TextFonts {
  /** 已读的字体字节：null = 读不到。没有这个键 = 还没读。 */
  private readonly bytes = new Map<FontPath, Uint8Array | null>();
  private readonly pending = new Map<FontPath, Promise<void>>();
  /** 「字体 + 字号」→ face 列表；null = 主字体和 arial 都不可用（排不出任何东西）。 */
  private readonly lists = new Map<string, FaceList | null>();

  constructor(
    readonly engine: Wpefont,
    private readonly read: FontReader,
  ) {}

  /** 读进这些字体（已读或正在读的不重复读）。读取器抛错按读不到处理。 */
  async load(paths: Iterable<FontPath>): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const path of paths) {
      if (this.bytes.has(path)) continue;
      let job = this.pending.get(path);
      if (!job) {
        job = this.read(path)
          .catch(() => null)
          .then((data) => {
            this.bytes.set(path, data && data.byteLength > 0 ? data : null);
            this.pending.delete(path);
          });
        this.pending.set(path, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  /** 加载一个字体文件为 face；字节还没读返回 undefined（记缺），读不到或不是字体返回 null。 */
  private open(path: FontPath, size: number, missing: Set<FontPath>): ListedFace | null | undefined {
    if (!this.bytes.has(path)) {
      missing.add(path);
      return undefined;
    }
    const data = this.bytes.get(path);
    if (!data) return null;
    const face = this.engine.face(data, size);
    return face ? { path, face, metrics: face.metrics() } : null;
  }

  /**
   * 「字体 + 字号」的 face 列表，第一次用时加载主字体（读不到换 arial）。字节还没读时返回 undefined 并记缺；
   * 主字体和 arial 都不可用时返回 null（WPE 排版直接失败，不画）。
   */
  faceList(path: FontPath, size: number, missing: Set<FontPath>): FaceList | null | undefined {
    const key = fontKey(path, size);
    const cached = this.lists.get(key);
    if (cached !== undefined) return cached;
    let main = this.open(path, size, missing);
    if (main === undefined) return undefined;
    if (main === null && path !== MAIN_FONT_FALLBACK) {
      main = this.open(MAIN_FONT_FALLBACK, size, missing);
      if (main === undefined) return undefined;
    }
    if (!main) {
      this.lists.set(key, null);
      return null;
    }
    const list = new FaceList(key, path, size);
    list.faces.push(main);
    this.lists.set(key, list);
    return list;
  }

  /**
   * 码点用列表里的哪个 face：已加载的按顺序找，没有就沿回退链加载下一项再找。返回下标，-1 = 哪个都没有；
   * 回退链的下一项还没读时返回 undefined 并记缺（不推进回退链）。
   */
  lookup(list: FaceList, cp: number, missing: Set<FontPath>): number | undefined {
    for (let i = 0; i < list.faces.length; i++) if (list.faces[i].face.has(cp)) return i;
    while (list.chainNext < FALLBACK_CHAIN.length) {
      const face = this.open(FALLBACK_CHAIN[list.chainNext], list.size, missing);
      if (face === undefined) return undefined;
      list.chainNext++;
      if (!face) continue;
      list.faces.push(face);
      if (face.face.has(cp)) return list.faces.length - 1;
    }
    return -1;
  }

  /**
   * 照 `FUN_1401ad670` 把一行码点分段（见文件头）。要用到还没读的字体时返回 undefined 并记缺。
   * 排版先用 {@link lookup} 把整段文字查一遍（预查），确认不缺字体后再排，所以排版过程中这里不会返回 undefined。
   */
  segment(list: FaceList, text: readonly number[], missing: Set<FontPath>): FontRun[] | undefined {
    const runs: FontRun[] = [];
    let current = -1;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const cp = text[i];
      const found = this.lookup(list, cp, missing);
      if (found === undefined) return undefined;
      // 哪个都没有：留在当前段
      if (found < 0 || found === current || keepsSegment(cp)) continue;
      // 换 face：当前段非空就收下（还没有段时，前面的码点不进任何段）
      if (current >= 0 && i > start) runs.push({ start, text: text.slice(start, i), faceIndex: current });
      current = found;
      start = i;
    }
    if (current >= 0 && text.length > start) runs.push({ start, text: text.slice(start), faceIndex: current });
    return runs;
  }

  /** 释放全部 face（字节缓存一起丢掉）。 */
  dispose(): void {
    for (const list of this.lists.values()) for (const face of list?.faces ?? []) face.face.dispose();
    this.lists.clear();
    this.bytes.clear();
  }
}
