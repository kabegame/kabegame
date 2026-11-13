/**
 * 字形图集：照 WPE 2.8.42 `FUN_1401ae080`（反编译 `ignore/p6/rea/text/raster/f_1401ae080.c`）逐行移植的装箱器（P6b 1c）。
 * 不是自己设计的：要和 WPE 抓帧里的图集逐字节相同，连它的怪处也照抄（见下）。
 *
 * 结构：一个「字体 + 字号」一张 R8 主图集（`__font_atlas_`，`FUN_1401ac8d0(0, msdf, 1)`），第一次遇到彩色字形（FreeType
 * 出 BGRA 位图）时再建一张 RGBA8 彩色图集（`FUN_1401adf30`，非 MSDF 时只有一张）。都从 512×512、全 0 开始。
 * 字形按 `face 下标 << 24 | gid` 进表（JS `Map`，插入顺序代替 MSVC `unordered_map` 的链表顺序，只在回收时有区别）。
 *
 * 装箱（`0x1401ae5c0` 起的循环）：
 * - 格子 = 位图宽高 `w × h`（对位图字形取 `FT_Glyph_Get_CBox(PIXELS)`）。四边形用的是另一个框，见 layout.ts。
 * - 按行（shelf）。逐行看：不是最后一行时要求 `h + 1 ≤ 行高`，并且 `w + 1 ≤ 行的最大空隙`；累计高度加 `h + 1` 超出图集
 *   高时停止看后面的行。行内按 x 排好的格子逐个看：`w + 1 ≤ 格子.x0 − x` 就放在 `x`（x 起初为 0）；否则 `x = 格子.x1 + 1`，
 *   最后一格看 `w ≤ 图集宽 − x`，其余看 **`w ≤ 下一格.x0 − 格子.x1`**——比真正的空隙多算 1，放下后会和下一格的第一列重叠，
 *   之后清零右边一列还会清掉下一格的第二列。放下后行高取 `max(行高, h)`，重算行的最大空隙（相邻格子 `x0 − 上一格.x1`
 *   与末尾 `图集宽 − 末格.x1` 的最大值，小于 2 时记 0）。
 * - 都放不下就在已用高度（各行 `行高 + 1` 之和）下面开新行：要求 `h + 1 ≤ 剩余高度` 且 `w + 1 ≤ 图集宽`，格子在 `x = 0`，
 *   新行的最大空隙 `图集宽 − (w + 1)`。
 * - 还放不下：回收引用数为 0、没回收过、格子 `(x1 − x0 + 1) × (y1 − y0 + 1)` 够 `(w + 1) × (h + 1)` 的旧字形（从行里摘掉，
 *   行的最大空隙取 `max(原值, 格宽 + 1)`，像素不清），摘到一个就从头再放；都不行就宽高翻倍（宽已大于 4095 时放弃），
 *   旧像素拷到左上角，没回收的字形 UV × 0.5，**每行的最大空隙改成旧宽度**，再从头放。
 * - 零尺寸字形（空格）同样占位：`w + 1 = 1`，下一个格子从它的 `x1 + 1` 起算。
 *
 * 写像素（`LAB_1401aef50`）：灰度位图逐行拷 `width` 字节；BGRA 逐行拷再交换 R、B，**不反预乘**；其余格式 WPE 不拷。
 * 然后清零格子四周：上一行与下一行各 `w` 个像素（`y0 = 0` 时上一行是最后一行，下一行是 `y1 % 高`），左一列与右一列
 * 各 `y0 … y1 − 1` 行（`x0 = 0` 时左一列是最后一列，右一列是 `x1 % 宽`）；角不清。零尺寸字形什么也不清。
 *
 * 和 WPE 的已知差异：单色内嵌点阵（`pixel_mode 1`）WPE 不拷（格子保持原样，字形画不出来），这里展开成 0 / 255。
 */
import { PIXEL_MODE_BGRA, PIXEL_MODE_GRAY, PIXEL_MODE_MONO, type GlyphBitmap, type WpefontFace } from "../wpefont";

/** 初始尺寸（`FUN_1401ac8d0`）。 */
export const ATLAS_INITIAL_SIZE = 512;
/** 宽超过它就不再翻倍（`0xfff < 宽` 时返回 2）。 */
const ATLAS_GROW_LIMIT = 0xfff;

/** 图集里的一个字形（WPE 的 `G`，0x48 字节）。 */
export interface AtlasGlyph {
  /** `face 下标 << 24 | gid`（无符号）。 */
  readonly key: number;
  readonly gid: number;
  /** 格子的像素矩形，右、下不含。 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** UV（float32，= 像素 / 图集尺寸；扩容后乘 0.5）。 */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** 引用它的排版结果个数（每个排版结果最多算一次）。 */
  refs: number;
  /** 已被回收（格子已让出）；再遇到同一个键时重新栅格化，复用这个对象。 */
  recycled: boolean;
  /** 在彩色图集里（BGRA 字形）。 */
  color: boolean;
  atlas: GlyphAtlas;
}

/** 图集里一行（shelf）。 */
interface AtlasRow {
  height: number;
  /** 行里最大空隙的估计（WPE 行结构的 `+4`），只用来跳过放不下的行；不总是准的（回收、翻倍后照 WPE 粗记）。 */
  maxFree: number;
  /** 按 x 排好的格子。 */
  cells: AtlasGlyph[];
}

/** 一块要重新上传的区域（像素，右、下不含）。 */
export interface AtlasRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 放不下（宽已到 4096）。`full` 是满了的那张。 */
export interface AtlasFull {
  full: GlyphAtlas;
}

const fround = Math.fround;

export class GlyphAtlas {
  width = ATLAS_INITIAL_SIZE;
  height = ATLAS_INITIAL_SIZE;
  /** 每像素字节数：R8 为 1，RGBA8 为 4。 */
  readonly bpp: number;
  pixels: Uint8Array;
  /** 字形表（键见 {@link AtlasGlyph.key}），按插入顺序。 */
  readonly glyphs = new Map<number, AtlasGlyph>();
  private readonly rows: AtlasRow[] = [];
  /** 扩容次数：变了说明尺寸与全部 UV 都变了，纹理要重建、用到它的网格要重写 UV。 */
  generation = 0;
  /**
   * 到 4096 还放不下、清空重排的次数（{@link resetForRelayout}，P6b 1e）：变了说明别的层正在用的字形也被标成回收、像素可能被覆盖，
   * 渲染器把用这张图集的层全部重排（1e 已定 5）。
   */
  resets = 0;
  /** 有改动没上传（WPE 的 `A + 0x20`，它每次整张上传）。 */
  dirty = false;
  private dirtyRects: AtlasRect[] = [];
  private dirtyAll = false;

  constructor(readonly color: boolean) {
    this.bpp = color ? 4 : 1;
    this.pixels = new Uint8Array(this.width * this.height * this.bpp);
  }

  /** 表里有、没回收的字形。 */
  find(key: number): AtlasGlyph | null {
    const glyph = this.glyphs.get(key);
    return glyph && !glyph.recycled ? glyph : null;
  }

  /**
   * 取走脏区：`"all"` 表示整张（新建或扩容后），否则是一组矩形（可能重叠）。取走后清空。
   * WPE 每次整张上传，这里给渲染层做增量上传用，内容一样。
   */
  takeDirty(): AtlasRect[] | "all" {
    const result = this.dirtyAll ? "all" : this.dirtyRects;
    this.dirtyRects = [];
    this.dirtyAll = false;
    this.dirty = false;
    return result;
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number): void {
    this.dirty = true;
    if (!this.dirtyAll && x1 > x0 && y1 > y0) this.dirtyRects.push({ x0, y0, x1, y1 });
  }

  /**
   * 放一个字形（`FUN_1401ae080` 栅格化之后的部分）：先找格子，再写像素、清四周。`reuse` 是表里同键、已回收的旧对象。
   * 宽到 4096 还放不下时返回 {@link AtlasFull}。
   */
  insert(key: number, gid: number, bitmap: GlyphBitmap): AtlasGlyph | AtlasFull {
    const reuse = this.glyphs.get(key) ?? null;
    const glyph = this.place(bitmap.width, bitmap.rows, reuse, key, gid);
    if (!glyph) return { full: this };
    glyph.color = bitmap.mode === PIXEL_MODE_BGRA;
    glyph.atlas = this;
    glyph.recycled = false;
    if (!reuse) this.glyphs.set(key, glyph);
    this.write(glyph, bitmap);
    this.clearAround(glyph, bitmap.width);
    return glyph;
  }

  /** 格子定位（`LAB_1401ae5c0` 的循环）；放不下返回 null。 */
  private place(w: number, h: number, reuse: AtlasGlyph | null, key: number, gid: number): AtlasGlyph | null {
    for (;;) {
      const rows = this.rows;
      // 1) 已有的行
      let y = 0;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if ((r >= rows.length - 1 || h + 1 <= row.height) && w + 1 <= row.maxFree) {
          if (this.height < y + h + 1) break;
          const cells = row.cells;
          let x = 0;
          for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            let at = -1;
            if (w + 1 <= cell.x0 - x) {
              at = c;
            } else {
              x = cell.x1 + 1;
              const last = c === cells.length - 1;
              // 照抄：不是最后一格时比的是 `下一格.x0 − 本格.x1`，比放得下的空隙多 1
              if ((last && w <= this.width - x) || (!last && w <= cells[c + 1].x0 - cell.x1)) at = c + 1;
            }
            if (at >= 0) {
              if (row.height < h) row.height = h;
              const glyph = this.cell(reuse, key, gid, x, y, w, h);
              cells.splice(at, 0, glyph);
              row.maxFree = maxGap(cells, this.width);
              return glyph;
            }
          }
        }
        y += row.height + 1;
      }
      // 2) 新行
      let used = 0;
      for (const row of rows) used += row.height + 1;
      if (h + 1 <= this.height - used && w + 1 <= this.width) {
        const glyph = this.cell(reuse, key, gid, 0, used, w, h);
        rows.push({ height: h, maxFree: this.width - (w + 1), cells: [glyph] });
        return glyph;
      }
      // 3) 回收：引用数为 0、没回收过、格子够大的旧字形，摘到一个就从头再放
      if (this.recycleFor(w, h)) continue;
      // 4) 翻倍
      if (this.width > ATLAS_GROW_LIMIT) return null;
      this.grow();
    }
  }

  private recycleFor(w: number, h: number): boolean {
    for (const old of this.glyphs.values()) {
      if (old.refs !== 0 || old.recycled) continue;
      const cellW = old.x1 - old.x0 + 1;
      if (!(w + 1 <= cellW && h + 1 <= old.y1 - old.y0 + 1)) continue;
      let removed = false;
      for (const row of this.rows) {
        const index = row.cells.indexOf(old);
        if (index < 0) continue;
        row.cells.splice(index, 1);
        removed = true;
        // 无符号比较（行的最大空隙不会为负）
        if (row.maxFree >>> 0 < cellW >>> 0) row.maxFree = cellW;
      }
      old.recycled = true;
      if (removed) return true;
    }
    return false;
  }

  private grow(): void {
    const oldWidth = this.width;
    const oldHeight = this.height;
    const old = this.pixels;
    this.width *= 2;
    this.height *= 2;
    this.pixels = new Uint8Array(this.width * this.height * this.bpp);
    const rowBytes = oldWidth * this.bpp;
    for (let y = 0; y < oldHeight; y++) {
      this.pixels.set(old.subarray(y * rowBytes, (y + 1) * rowBytes), y * this.width * this.bpp);
    }
    for (const glyph of this.glyphs.values()) {
      if (glyph.recycled) continue;
      glyph.u0 = fround(glyph.u0 * 0.5);
      glyph.v0 = fround(glyph.v0 * 0.5);
      glyph.u1 = fround(glyph.u1 * 0.5);
      glyph.v1 = fround(glyph.v1 * 0.5);
    }
    // 照抄：不按实际空隙重算，一律记成旧宽度
    for (const row of this.rows) row.maxFree = oldWidth;
    this.generation++;
    this.dirty = true;
    this.dirtyAll = true;
    this.dirtyRects = [];
  }

  /** 设格子与 UV（UV 是 float32 的「像素 / 尺寸」）。 */
  private cell(reuse: AtlasGlyph | null, key: number, gid: number, x: number, y: number, w: number, h: number) {
    const glyph: AtlasGlyph = reuse ?? {
      key,
      gid,
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
      u0: 0,
      v0: 0,
      u1: 0,
      v1: 0,
      refs: 0,
      recycled: false,
      color: false,
      atlas: this,
    };
    glyph.x0 = x;
    glyph.y0 = y;
    glyph.x1 = x + w;
    glyph.y1 = y + h;
    glyph.u0 = fround(glyph.x0 / this.width);
    glyph.v0 = fround(glyph.y0 / this.height);
    glyph.u1 = fround(glyph.x1 / this.width);
    glyph.v1 = fround(glyph.y1 / this.height);
    return glyph;
  }

  private write(glyph: AtlasGlyph, bitmap: GlyphBitmap): void {
    const { width, rows, pixels } = bitmap;
    const bpp = this.bpp;
    const stride = this.width * bpp;
    const base = (glyph.y0 * this.width + glyph.x0) * bpp;
    if (bitmap.mode === PIXEL_MODE_GRAY && bpp === 1) {
      for (let r = 0; r < rows; r++) {
        this.pixels.set(pixels.subarray(r * width, (r + 1) * width), base + r * stride);
      }
    } else if (bitmap.mode === PIXEL_MODE_BGRA && bpp === 4) {
      // BGRA → RGBA：交换 R、B，不反预乘
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < width; c++) {
          const s = (r * width + c) * 4;
          const d = base + r * stride + c * 4;
          this.pixels[d] = pixels[s + 2];
          this.pixels[d + 1] = pixels[s + 1];
          this.pixels[d + 2] = pixels[s];
          this.pixels[d + 3] = pixels[s + 3];
        }
      }
    } else if (bitmap.mode === PIXEL_MODE_MONO && bpp === 1) {
      // 和 WPE 的已知差异：WPE 不拷单色点阵，这里展开成 0 / 255
      const rowBytes = Math.ceil(width / 8);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < width; c++) {
          const bit = (pixels[r * rowBytes + (c >> 3)] >> (7 - (c & 7))) & 1;
          this.pixels[base + r * stride + c] = bit ? 255 : 0;
        }
      }
    } else {
      return;
    }
    this.markDirty(glyph.x0, glyph.y0, glyph.x0 + width, glyph.y0 + rows);
  }

  /** 清零格子四周（`0x1401aef50` 之后）：上、下各 `w` 个像素，左、右各一列（`y0 … y1 − 1`），越过边的绕回。 */
  private clearAround(glyph: AtlasGlyph, w: number): void {
    const W = this.width;
    const H = this.height;
    const bpp = this.bpp;
    const above = (glyph.y0 === 0 ? H : glyph.y0) - 1;
    const below = glyph.y1 % H;
    if (w > 0) {
      this.pixels.fill(0, (above * W + glyph.x0) * bpp, (above * W + glyph.x0 + w) * bpp);
      this.pixels.fill(0, (below * W + glyph.x0) * bpp, (below * W + glyph.x0 + w) * bpp);
      this.markDirty(glyph.x0, above, glyph.x0 + w, above + 1);
      this.markDirty(glyph.x0, below, glyph.x0 + w, below + 1);
    }
    const left = (glyph.x0 === 0 ? W : glyph.x0) - 1;
    const right = glyph.x1 % W;
    for (let y = glyph.y0; y < glyph.y1; y++) {
      this.pixels.fill(0, (y * W + left) * bpp, (y * W + left + 1) * bpp);
      this.pixels.fill(0, (y * W + right) * bpp, (y * W + right + 1) * bpp);
    }
    if (glyph.y1 > glyph.y0) {
      this.markDirty(left, glyph.y0, left + 1, glyph.y1);
      this.markDirty(right, glyph.y0, right + 1, glyph.y1);
    }
    this.dirty = true;
  }

  /**
   * 排版因图集满而作废、从头重排之前（`FUN_1401b0410` 的 `LAB_1401b0f1c`）：清空每行的格子（行高、最大空隙不动，
   * 像素不清），全部字形标成已回收。照抄 WPE，之后这张图集基本放不进新东西。
   */
  resetForRelayout(): void {
    for (const row of this.rows) row.cells = [];
    for (const glyph of this.glyphs.values()) glyph.recycled = true;
    this.resets++;
  }
}

/** 行的最大空隙：`x0 − 上一格.x1`（第一格减 0）与末尾 `图集宽 − 末格.x1` 的最大值，小于 2 记 0。 */
function maxGap(cells: readonly AtlasGlyph[], width: number): number {
  let best = 0;
  let prev = 0;
  for (let i = 0; i < cells.length; i++) {
    const gap = cells[i].x0 - prev;
    if (best < gap) best = gap;
    prev = cells[i].x1;
    if (i === cells.length - 1 && best < width - prev) best = width - prev;
  }
  return best < 2 ? 0 : best;
}

/** 一个「字体 + 字号」的两张图集。 */
export interface FontAtlases {
  readonly key: string;
  readonly main: GlyphAtlas;
  color: GlyphAtlas | null;
}

/** 一个场景的全部图集，按字体键（`fontKey`）共享。 */
export class TextAtlases {
  private readonly entries = new Map<string, FontAtlases>();

  get(key: string): FontAtlases {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, main: new GlyphAtlas(false), color: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** 已有的全部图集（建的先后）。 */
  all(): FontAtlases[] {
    return [...this.entries.values()];
  }
}

/**
 * 取一个字形在图集里的位置，没有就栅格化放进去（`FUN_1401ae080` 的非 MSDF 路径）。
 * 先查主图集、再查彩色图集；栅格化失败（`FT_Load_Glyph` / `FT_Get_Glyph` 出错）返回 null，排版跳过这个字形。
 */
export function rasterizeGlyph(
  atlases: FontAtlases,
  face: WpefontFace,
  faceIndex: number,
  gid: number,
): AtlasGlyph | AtlasFull | null {
  const key = ((faceIndex << 24) | gid) >>> 0;
  const hit = atlases.main.find(key) ?? atlases.color?.find(key) ?? null;
  if (hit) return hit;
  const bitmap = face.glyph(gid);
  if (!bitmap) return null;
  const atlas = bitmap.mode === PIXEL_MODE_BGRA ? (atlases.color ??= new GlyphAtlas(true)) : atlases.main;
  const again = atlas.find(key);
  if (again) return again;
  return atlas.insert(key, gid, bitmap);
}
