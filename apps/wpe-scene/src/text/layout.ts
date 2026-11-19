/**
 * 文本对象的排版（P6b 1c）：照 WPE 2.8.42 的 `FUN_1401b0410`（排版与建网格，反编译
 * `ignore/p6/rea/text/raster/f_1401b0410.c`）、`FUN_140256f20` 尾部（对齐写进原点）、`FUN_140258900` / `FUN_140258ab0`
 * （图层尺寸与合成 RT 尺寸）逐段移植，规则说明见 rea-p6b-layout 2–3 节。全部浮点照 WPE 按 float32 逐步舍入。
 *
 * 和离线参考 `ignore/p6/b0/ft_layout.py` 不同、照反编译改的地方：
 * - 几何一律用字形框（`WpefontFace.box`，`FT_LOAD_NO_BITMAP` 的轮廓框），位图只进图集；
 * - 行的包围盒把零尺寸字形（空格）也算进去（它在笔位置上，可能撑大右沿）；
 * - 断行找空白时包括下标 0；每行开头（还没有段时）的空白、ZWJ 与找不到字体的码点在分段时被丢掉（见 fonts.ts）；
 * - 省略号回退量宽时不加 `spacing.x`（WPE 只累加 `x_advance >> 6`）。
 *
 * MSDF（P6f，`fields.msdf`）：字体键 `<路径>_msdf` 与字号无关、图集 RGBA8、格子 = `inner + 24`（见 atlas.ts）；每个四边形各边外扩
 * `pad = f32(max(y_ppem, 1)) · 12 · 0.03125`（`y_ppem` 取本对象字号下这个字形所在 face 的，不是生成字形时的那个；`FUN_1401b0410`
 * 第 958–963 行），UV 取整个格子。**文字框、行宽、`minX` / `minY` 都不含 `pad`**（rea-p6f-msdf 4.1），所以走合成路径时贴边的装饰会被
 * 合成 RT 裁掉，照 WPE。彩色 face 的字形（`text:msdf:color`）不画、不进图集，字距照排，键记在 `TextLayout.unsupported`。
 *
 * 字形进图集的时机（决定图集能不能和 WPE 逐字节相同）：逐行、逐段排字时**每个字形先栅格化进图集**，再判断越界——
 * 所以越界的那个字形进了图集、但不一定画；越界后这一段剩下的字形和后面的段都不再碰；省略号回退量宽只取字形框、
 * 不进图集；需要重排的行（折行后、加省略号后）再排一遍，已在图集里的字形直接复用。对象之间按场景里的顺序。
 *
 * 和 WPE 的实现差异（结果相同）：折行后 WPE 只在断点处「不能安全断开」（HarfBuzz 的 UNSAFE_TO_BREAK）时重排这一行，
 * 否则直接截掉排好的字形；这里一律重排。按 HarfBuzz 的约定，能安全断开时重排的结果和截掉的相同，重排时的字形都已在
 * 图集里，不改变图集。
 */
import { rasterizeGlyph, type AtlasGlyph, type FontAtlases, type GlyphAtlas, type TextAtlases } from "./atlas";
import {
  clampPointsize,
  fontKey,
  fontPath,
  isBreakSpace,
  type FaceList,
  type FontPath,
  type FontRun,
  type TextFonts,
} from "./fonts";
import type { TextFields } from "./fields";

// 字段与缺省值在 `fields.ts`（编译 Worker 也用，P6b 1d 拆出），这里原样再导出
export { TEXT_DEFAULTS, type TextFields } from "./fields";

/** 一个字形四边形：排版坐标（y 向上，第一行基线在 0），左、下、右、上（MSDF 时已含 `pad` 外扩）；UV 从 `glyph` 读（图集扩容后会变）。 */
export interface TextQuad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  glyph: AtlasGlyph;
}

/** WPE 的排版结果 `L`（`FUN_1401b0410` 返回的 0x108 字节）。 */
export interface TextMesh {
  /** 字体键（图集按它共享）：普通路径 `<路径>_<size26.6>`，MSDF 路径 `<路径>_msdf`。 */
  key: string;
  /** MSDF 画法：主图集是 RGBA8 距离场，`glyphs` 的四边形已按 `pad` 外扩，没有彩色字形。 */
  msdf: boolean;
  /** 普通字形（R8 主图集；MSDF 时是 RGBA8 距离场）与彩色字形（RGBA8 彩色图集），各按行、段、字形的顺序；零尺寸字形（空格）也在里面。 */
  glyphs: TextQuad[];
  colorGlyphs: TextQuad[];
  atlas: GlyphAtlas;
  colorAtlas: GlyphAtlas | null;
  /** 包围盒（`L + 0x90 … 0x9c`）：横向是各行墨迹（含原点 0，不含行内对齐），纵向至少「ascender 到 ascender − 行数 · 行高」。 */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  lineHeight: number;
  rows: number;
  pointsize: number;
  /**
   * 本次排版引用的图集字形（引用数各加了 1），{@link releaseTextLayout} 减回、{@link retainTextLayout} 再加回（P6b 1e）。列表本身不清：
   * 减没减过看 `released`。
   */
  refs: AtlasGlyph[];
  /** 引用已经减回（`releaseTextLayout`）；缺省（undefined）是还持有着。 */
  released?: boolean;
}

export interface TextLayout {
  /** 还没读进来的字体（主字体或回退链里的）：非空时没有排版，读完（`TextFonts.load`）再排，图集没有被改动。 */
  missingFonts: FontPath[];
  /** 空文字、全是丢掉的码点、字体都不可用时为 null（WPE 不画这一层）。 */
  mesh: TextMesh | null;
  /**
   * 排版中遇到的、这次画不出的特性键（现在只有 MSDF 下彩色 face 的字形 `text:msdf:color`），去重、已排序。场景不退回，那个字形不画；
   * 宿主（`SceneTexts`）排完交给运行期不支持项上报（看板娘提示、按键去重）。
   */
  unsupported: string[];
  /** 实际加上的 `padding`（不合成、没有背景时为 0，钳到 512）。 */
  padding: [number, number];
  /** 图层尺寸（`+0x2f0`）：包围盒 + 2 · padding；没有 mesh 时 2 + 2 · padding。 */
  size: [number, number];
  /** 合成 RT 尺寸（`FUN_140258ab0`）：`trunc(2 · padding + 包围盒)`；没有 mesh 时 1 × 1。 */
  compositeSize: [number, number];
  /** 对齐写进原点的偏移（`+0x2f8`、`+0x2fc`），加在对象原点上。 */
  offset: [number, number];
}

const f = Math.fround;

/** MSDF 四边形的外扩（`FUN_1401b0410` 第 958–963 行）：`f32(max(y_ppem, 1)) · 12 · 0.03125`，整数 `y_ppem` 下精确等于 `y_ppem · 12 / 32`。 */
export function msdfPad(yPpem: number): number {
  return f(f(Math.max(yPpem, 1) * 12) * 0.03125);
}

const ELLIPSIS = 0x2026;
/** 一行反复重排的上限（WPE 没有：`spacing.x` 让省略号行始终越界时它会死循环）。 */
const RESHAPE_LIMIT = 64;

/** 一个排好的字形（WPE 0x30 字节的字形记录）。 */
interface GlyphRecord {
  /** null = 这个字形画不出（`text:msdf:color`）：只占字距和取框，不画、不进引用。 */
  glyph: AtlasGlyph | null;
  cp: number;
  /** 在整行里的码点下标（段起点 + cluster）。 */
  charIndex: number;
  advance: number;
  yAdvance: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** MSDF 四边形各边的外扩（非 MSDF 为 0）。 */
  pad: number;
}

interface Run extends FontRun {
  records: GlyphRecord[];
}

interface Row {
  text: number[];
  /** 被折过（两端对齐只拉伸这种行）。 */
  wrapped: boolean;
}

interface FinishedRow {
  width: number;
  runs: Run[];
}

/** 去掉末尾空白；`ellipsis` 时末尾不是「…」就接一个（`FUN_1401b0360`）。 */
function trimAndEllipsize(text: number[], ellipsis: boolean): void {
  while (text.length && isBreakSpace(text[text.length - 1])) text.pop();
  if (ellipsis && (text.length === 0 || text[text.length - 1] !== ELLIPSIS)) text.push(ELLIPSIS);
}

/** 预处理（`FUN_1401b0410` 开头）：到第一个 NUL 为止、删掉 `\r`、按 `\n` 分行（末尾的 `\n` 不成行），`maxrows` 截行。 */
function splitRows(text: string, maxRows: number, ellipsis: boolean): Row[] | null {
  const nul = text.indexOf("\0");
  const source = nul >= 0 ? text.slice(0, nul) : text;
  if (source.length === 0) return null;
  const cps: number[] = [];
  for (const ch of source) {
    const cp = ch.codePointAt(0)!;
    if (cp !== 0x0d) cps.push(cp);
  }
  const rows: Row[] = [];
  let start = 0;
  if (cps.length === 0) return rows;
  for (;;) {
    let end = start;
    while (end < cps.length && cps[end] !== 0x0a) end++;
    const segment = cps.slice(start, end);
    // 行数已满：最后一行收尾，后面的丢掉（这一段也丢）
    if (maxRows !== 0 && maxRows >>> 0 <= rows.length) {
      const last = rows[rows.length - 1];
      trimAndEllipsize(last.text, ellipsis);
      last.wrapped = false;
      break;
    }
    rows.push({ text: segment, wrapped: false });
    if (end >= cps.length || end + 1 >= cps.length) break;
    start = end + 1;
  }
  return rows;
}

/** 加不加 `padding`：有可见 effect、colorBlendMode 合成（0、31 以外）或开了背景（`FUN_140258900`）。 */
function padsText(fields: TextFields): boolean {
  return (
    fields.visibleEffects > 0 ||
    (fields.colorBlendMode !== 0 && fields.colorBlendMode !== 31) ||
    fields.opaquebackground
  );
}

/** 图层尺寸用的 `padding`：`512 ≤ p` 时取 512（`FUN_140258900`，NaN 原样）。 */
function appliedPadding(fields: TextFields): [number, number] {
  if (!padsText(fields)) return [0, 0];
  const clamp = (p: number) => {
    const v = f(p);
    return v >= 512 ? 512 : v;
  };
  return [clamp(fields.padding[0]), clamp(fields.padding[1])];
}

/** 合成 RT 尺寸用的 `padding`：`minss p, 512`（`FUN_140258ab0`，NaN 时取 512）。 */
function rtPadding(fields: TextFields): [number, number] {
  if (!padsText(fields)) return [0, 0];
  const clamp = (p: number) => {
    const v = f(p);
    return v < 512 ? v : 512;
  };
  return [clamp(fields.padding[0]), clamp(fields.padding[1])];
}

function emptyLayout(fields: TextFields, missingFonts: FontPath[] = []): TextLayout {
  const padding = appliedPadding(fields);
  return {
    missingFonts,
    mesh: null,
    unsupported: [],
    padding,
    size: [f(f(2 + padding[0]) + padding[0]), f(f(2 + padding[1]) + padding[1])],
    compositeSize: [1, 1],
    offset: [0, 0],
  };
}

/**
 * 释放排版结果对图集字形的引用（文字变了、对象销毁时）。重复调用无害。运行中重排（P6b 1e，`text/host.ts` 的重排器）先放旧的再排新的
 * （同 WPE「先放旧、再排新」，只被旧文字用的字形在新排版里可以被回收）。
 */
export function releaseTextLayout(layout: TextLayout): void {
  const mesh = layout.mesh;
  if (!mesh || mesh.released) return;
  for (const glyph of mesh.refs) glyph.refs--;
  mesh.released = true;
}

/**
 * {@link releaseTextLayout} 的反操作（P6b 1e）：把引用加回去。重排发现缺字体（没排成、图集没动）时旧排版照画，引用要复原，否则旧排版的
 * 字形可能被别的层回收、覆盖。没释放过时不做事，重复调用无害。
 */
export function retainTextLayout(layout: TextLayout): void {
  const mesh = layout.mesh;
  if (!mesh || !mesh.released) return;
  for (const glyph of mesh.refs) glyph.refs++;
  mesh.released = false;
}

/**
 * 排一个文本对象。字体都在时同步完成：栅格化新字形进图集、给用到的图集字形加引用（换掉旧结果时调
 * {@link releaseTextLayout}）。要用到还没读的字体时返回 `missingFonts`，图集不变。
 */
export function layoutText(fields: TextFields, fonts: TextFonts, atlases: TextAtlases): TextLayout {
  const size = clampPointsize(fields.pointsize);
  const path = fontPath(fields.font);
  const maxWidth = fields.limitwidth ? f(fields.maxwidth) : 0;
  const maxRows = fields.limitrows ? fields.maxrows | 0 : 0;
  const ellipsis = fields.limituseellipsis;

  // 预查：整段文字（截行之后的，加上可能接的省略号）用到的字体都读进来了，才动图集
  const missing = new Set<FontPath>();
  const probeRows = splitRows(fields.text, maxRows, ellipsis);
  if (!probeRows) return emptyLayout(fields);
  const list = fonts.faceList(path, size, missing);
  if (list === undefined) return emptyLayout(fields, [...missing]);
  if (list === null) return emptyLayout(fields);
  const probe = probeRows.flatMap((row) => row.text);
  if (ellipsis) probe.push(ELLIPSIS);
  for (const cp of probe) if (fonts.lookup(list, cp, missing) === undefined) break;
  if (missing.size) return emptyLayout(fields, [...missing]);

  const entry = atlases.get(fontKey(path, size, fields.msdf), fields.msdf);
  let attempt = run(fields, fonts, list, entry, size, maxWidth, maxRows, false);
  if (attempt && "full" in attempt) {
    // 图集满（宽已到 4096）：清掉这张图集的格子、全部标成已回收，从头再排一次；再满就跳过放不下的字形
    attempt.full.resetForRelayout();
    attempt = run(fields, fonts, list, entry, size, maxWidth, maxRows, true);
  }
  if (!attempt || "full" in attempt) return emptyLayout(fields);
  return finish(fields, attempt, list);
}

/** 一次完整的排版（`LAB_1401b0520` 到建网格之前）；图集满时返回满了的那张，调用方重置后再来一次。 */
function run(
  fields: TextFields,
  fonts: TextFonts,
  list: FaceList,
  atlases: FontAtlases,
  size: number,
  maxWidth: number,
  maxRows: number,
  relayout: boolean,
): { mesh: TextMesh; unsupported: string[] } | { full: GlyphAtlas } | null {
  const ellipsis = fields.limituseellipsis;
  const spacingX = f(fields.spacing[0]);
  const spacingY = f(fields.spacing[1]);
  const rows = splitRows(fields.text, maxRows, ellipsis)!;
  const main = list.main.metrics;
  const lineHeight = f(f(main.height >> 6) + spacingY);
  const missing = new Set<FontPath>();
  const segment = (text: readonly number[]) => {
    const runs = fonts.segment(list, text, missing);
    if (!runs) throw new Error(`排版中缺字体（预查漏了）：${[...missing].join(", ")}`);
    return runs;
  };

  const refs = new Set<AtlasGlyph>();
  const unsupported = new Set<string>();
  const release = () => {
    for (const glyph of refs) glyph.refs--;
    refs.clear();
  };
  const finished: FinishedRow[] = [];
  let total = 0;
  let widest = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  // 取框失败时 WPE 沿用上一个字形的框（栈上的旧值）
  let lastBox = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

  let rowIndex = 0;
  let reshapes = 0;
  while (rowIndex < rows.length) {
    const row = rows[rowIndex];
    const text = row.text.slice();
    const runs: Run[] = segment(text).map((r) => ({ ...r, records: [] }));
    let reshape = false;
    let next = rowIndex;
    let count = 0;
    let previousChar = -1;
    let pen = 0;

    shaping: for (let r = 0; r < runs.length; r++) {
      const segmentRun = runs[r];
      const listed = list.faces[segmentRun.faceIndex];
      for (const shaped of listed.face.shape(segmentRun.text)) {
        const glyph = rasterizeGlyph(atlases, listed.face, segmentRun.faceIndex, shaped.gid);
        if (glyph && "full" in glyph) {
          if (relayout) continue;
          release();
          return { full: glyph.full };
        }
        if (!glyph) continue;
        // MSDF 下彩色 face 的字形：不画、不进图集，字距与取框照排（记一个不支持项）
        const drawable = "unsupported" in glyph ? null : glyph;
        if (!drawable) unsupported.add((glyph as { unsupported: string }).unsupported);
        const box = listed.face.box(shaped.gid) ?? lastBox;
        lastBox = box;
        const xOffset = shaped.xOffset >> 6;
        const yOffset = shaped.yOffset >> 6;
        const record: GlyphRecord = {
          glyph: drawable,
          cp: segmentRun.text[shaped.cluster],
          charIndex: segmentRun.start + shaped.cluster,
          advance: f((shaped.xAdvance >> 6) + spacingX),
          yAdvance: f(shaped.yAdvance >> 6),
          x0: f(box.xMin + xOffset),
          y0: f(box.yMin + yOffset),
          x1: f(box.xMax + xOffset),
          y1: f(box.yMax + yOffset),
          pad: fields.msdf ? msdfPad(listed.metrics.yPpem) : 0,
        };
        // 越界：墨迹右沿 + 笔位置 > maxwidth，本行已有字形、不是空白、不和上一个字形同簇
        if (
          maxWidth > 0 &&
          count !== 0 &&
          !isBreakSpace(record.cp) &&
          record.charIndex !== previousChar &&
          maxWidth < f(record.x1 + pen)
        ) {
          runs.length = r + 1;
          if (maxRows < 1 || finished.length + 1 < maxRows >>> 0) {
            wrapRow(rows, rowIndex, text, record.charIndex);
            reshape = true;
            if (maxRows >= 1) dropRowsBeyond(rows, maxRows, ellipsis);
          } else {
            if (ellipsis) reshape = ellipsizeRow(row, text, record.charIndex, maxWidth, list, segment);
            row.wrapped = false;
            if (!reshape) next = rows.length;
            dropRowsBeyond(rows, maxRows, ellipsis);
          }
          break shaping;
        }
        segmentRun.records.push(record);
        previousChar = record.charIndex;
        pen = f(pen + record.advance);
        count++;
        if (drawable && !refs.has(drawable)) {
          drawable.refs++;
          refs.add(drawable);
        }
      }
    }

    if (reshape && ++reshapes <= RESHAPE_LIMIT) continue;
    reshapes = 0;

    // 收尾一行（`LAB_1401b215d`）：墨迹包围盒（初值 0，零尺寸字形也算），两端对齐
    let rowMinX = 0;
    let rowMinY = 0;
    let rowMaxX = 0;
    let rowMaxY = 0;
    let x = 0;
    let y = 0;
    for (const segmentRun of runs) {
      for (const record of segmentRun.records) {
        const left = f(x + record.x0);
        if (left < rowMinX) rowMinX = left;
        const bottom = f(y + record.y0);
        if (bottom < rowMinY) rowMinY = bottom;
        const right = f(x + record.x1);
        if (rowMaxX < right) rowMaxX = right;
        const top = f(y + record.y1);
        if (rowMaxY < top) rowMaxY = top;
        x = f(x + record.advance);
        y = f(y + record.yAdvance);
      }
    }
    if (fields.blockalign && row.wrapped && row.text.length !== 0) {
      const spaces = row.text.filter(isBreakSpace).length;
      if (spaces > 0) {
        for (const segmentRun of runs) {
          for (const record of segmentRun.records) {
            if (!isBreakSpace(record.cp)) continue;
            record.advance = f(f(f(maxWidth - f(rowMaxX - rowMinX)) / spaces) + record.advance);
          }
        }
        rowMaxX = f(rowMinX + maxWidth);
      }
    }
    const width = f(rowMaxX - rowMinX);
    const baseline = f(finished.length * -lineHeight);
    const low = f(baseline + rowMinY);
    if (low < minY) minY = low;
    const high = f(baseline + rowMaxY);
    if (maxY < high) maxY = high;
    finished.push({ width, runs });
    if (rowMinX < minX) minX = rowMinX;
    if (maxX < rowMaxX) maxX = rowMaxX;
    if (widest < width) widest = width;
    total += count;
    rowIndex = next + 1;
  }

  if (finished.length === 0 || total === 0) {
    release();
    return null;
  }

  // 建网格（`0x1401b0b..` 起）：行内对齐、逐字四边形
  const ascender = f(main.ascender >> 6);
  const boxMaxY = ascender <= maxY ? maxY : ascender;
  let boxMinY = f(ascender - f(finished.length * lineHeight));
  if (minY <= boxMinY) boxMinY = minY;
  const glyphs: TextQuad[] = [];
  const colorGlyphs: TextQuad[] = [];
  let baseline = 0;
  for (const finishedRow of finished) {
    const shift =
      fields.horizontalalign === "center"
        ? f(f(widest - finishedRow.width) * 0.5)
        : fields.horizontalalign === "right"
          ? f(widest - finishedRow.width)
          : 0;
    let x = 0;
    for (const segmentRun of finishedRow.runs) {
      for (const record of segmentRun.records) {
        const drawn = record.glyph;
        if (drawn) {
          // 非 MSDF 的 pad 是 0，`f(v - 0)` 与原结果相同
          const quad: TextQuad = {
            x0: f(f(f(x + record.x0) - record.pad) + shift),
            y0: f(f(baseline + record.y0) - record.pad),
            x1: f(f(f(x + record.x1) + record.pad) + shift),
            y1: f(f(baseline + record.y1) + record.pad),
            glyph: drawn,
          };
          (drawn.color ? colorGlyphs : glyphs).push(quad);
        }
        x = f(x + record.advance);
      }
    }
    baseline = f(baseline - lineHeight);
  }
  return {
    unsupported: [...unsupported].sort(),
    mesh: {
      key: atlases.key,
      msdf: atlases.msdf,
      glyphs,
      colorGlyphs,
      atlas: atlases.main,
      colorAtlas: atlases.color,
      box: { minX, minY: boxMinY, maxX, maxY: boxMaxY },
      lineHeight,
      rows: finished.length,
      pointsize: size,
      refs: [...refs],
    },
  };
}

/**
 * 折行（`joined_r0x0001401b1a43` 起）：从越界的码点往前找空格 / 制表 / 回车（含下标 0），找到就在那里断，找不到在越界
 * 处按字断；后半段去掉开头空白、插成下一行，本行截断、去掉末尾空白、标成被折过。
 */
function wrapRow(rows: Row[], rowIndex: number, text: readonly number[], overflowChar: number): void {
  let index = overflowChar;
  let anchor = index;
  for (;;) {
    anchor = index;
    if (index < 2 || !isBreakSpace(text[index])) break;
    index--;
  }
  let cut = anchor;
  for (let i = index - 1; i >= 0; i--) {
    if (isBreakSpace(text[i])) {
      cut = i;
      break;
    }
  }
  const tail = text.slice(cut);
  while (tail.length && isBreakSpace(tail[0])) tail.shift();
  const row = rows[rowIndex];
  row.text = text.slice(0, cut);
  row.wrapped = true;
  rows.splice(rowIndex + 1, 0, { text: tail, wrapped: false });
  while (row.text.length && isBreakSpace(row.text[row.text.length - 1])) row.text.pop();
}

/** 行数超过 `maxrows` 时丢掉后面的行，最后一行收尾（`LAB_1401b205c`）。 */
function dropRowsBeyond(rows: Row[], maxRows: number, ellipsis: boolean): void {
  if (!(maxRows >>> 0 < rows.length)) return;
  rows.length = maxRows;
  const last = rows[rows.length - 1];
  trimAndEllipsize(last.text, ellipsis);
  last.wrapped = false;
}

/**
 * 行数已满、加省略号（`LAB_1401b14a0`）：「越界处之前的前缀 + …」量宽（只取字形框、不进图集、不加 `spacing.x`，宽度是
 * 最后一个字形的右沿），宽于 maxwidth 就少一个码点再量，直到放得下或前缀为空。前缀为空或已以「…」结尾时不改（返回
 * false：本行就截在越界处）；否则去掉前缀末尾空白、接「…」写回本行，返回 true（重排这一行）。
 */
function ellipsizeRow(
  row: Row,
  text: readonly number[],
  overflowChar: number,
  maxWidth: number,
  list: FaceList,
  segment: (text: readonly number[]) => FontRun[],
): boolean {
  let length = overflowChar;
  for (;;) {
    const prefix = text.slice(0, Math.min(length, text.length));
    prefix.push(ELLIPSIS);
    let width = 0;
    let pen = 0;
    for (const segmentRun of segment(prefix)) {
      const face = list.faces[segmentRun.faceIndex].face;
      for (const shaped of face.shape(segmentRun.text)) {
        const box = face.box(shaped.gid);
        if (!box) continue;
        width = f(f(f(shaped.xOffset >> 6) + pen) + box.xMax);
        pen = f(pen + (shaped.xAdvance >> 6));
      }
    }
    if (width <= maxWidth || length === 0) break;
    length--;
  }
  const kept = text.slice(0, Math.min(length, text.length));
  if (kept.length === 0 || kept[kept.length - 1] === ELLIPSIS) return false;
  while (kept.length && isBreakSpace(kept[kept.length - 1])) kept.pop();
  kept.push(ELLIPSIS);
  row.text = kept;
  return true;
}

/** 文字框、对齐偏移、图层与合成 RT 尺寸（`FUN_140256f20` 尾部、`FUN_140258900`、`FUN_140258ab0`）。 */
function finish(fields: TextFields, result: { mesh: TextMesh; unsupported: string[] }, list: FaceList): TextLayout {
  const mesh = result.mesh;
  const { minX, minY, maxX, maxY } = mesh.box;
  const metrics = list.main.metrics;
  const ascender = f(metrics.ascender >> 6);
  const descender = f(metrics.descender >> 6);
  const w = f(maxX - minX);
  const h = f(maxY - minY);
  const half = f(w * 0.5);
  const offsetX = fields.horizontalalign === "left" ? half : fields.horizontalalign === "right" ? f(0 - half) : 0;
  let offsetY = f(maxY - f(h * 0.5));
  const above = f(f(mesh.rows - 1) * mesh.lineHeight);
  if (fields.verticalalign === "bottom") offsetY = f(offsetY - f(descender - above));
  else if (fields.verticalalign === "center") offsetY = f(offsetY - f(f(ascender - above) * 0.5));
  else offsetY = f(offsetY - ascender);
  const padding = appliedPadding(fields);
  const rtPad = rtPadding(fields);
  return {
    missingFonts: [],
    mesh,
    unsupported: result.unsupported,
    padding,
    size: [f(f(w + padding[0]) + padding[0]), f(f(h + padding[1]) + padding[1])],
    compositeSize: [Math.trunc(f(f(rtPad[0] + rtPad[0]) + w)), Math.trunc(f(f(rtPad[1] + rtPad[1]) + h))],
    offset: [offsetX, offsetY],
  };
}

/** 直接上屏时字形网格相对「对象原点 + 偏移」的平移（`FUN_140258050`）：`(−w/2 − min(minX, 0), h/2 − maxY)`。 */
export function directTranslation(mesh: TextMesh): [number, number] {
  const { minX, minY, maxX, maxY } = mesh.box;
  let x = f(f(maxX - minX) * -0.5);
  if (minX < 0) x = f(x - minX);
  return [x, f(f(f(maxY - minY) * 0.5) - maxY)];
}

/** 画进合成 RT 时字形网格在 RT 像素里的平移（`FUN_140257d70`）：`(pad.x − min(minX, 0), pad.y − minY)`。 */
export function compositeTranslation(layout: TextLayout): [number, number] {
  const mesh = layout.mesh;
  if (!mesh) return [0, 0];
  let x = layout.padding[0];
  if (mesh.box.minX < 0) x = f(x - mesh.box.minX);
  return [x, f(layout.padding[1] - mesh.box.minY)];
}
