/**
 * 用户纹理的 GIF 解码与推进（P11b 步骤 4，rea-p11b 第 2 节）：照 WPE `resourceutil64.dll` 里改过的 stb 派生解码器逐字节移植，
 * 和 WPE 逐像素、逐帧对得上（不用浏览器的 `ImageDecoder`：它按 GIF 规范合成，disposal 2 / 3 与背景色和 WPE 不同）。
 *
 * 一个 `GifAnimation` 对应 WPE 一张 GIF 纹理的解码状态（`OpenGIF` 建的 0x8978 字节状态）：同一个文件被几张纹理用到时各开一个、各自推进。
 * 只做解码与时序，不碰 GPU、不裁切：渲染器按裁切矩形从 `canvas` 取（rea-p11b 2.1）。
 *
 * 依据（Ghidra 反编译，`ignore/p11/rea/p11b/`）：
 * - `d3/f_180001be0.c` `OpenGIF`、`d3/f_1800021d0.c` `AdvanceGIF`；
 * - `d4/f_180007800.c` 逐帧解码（stb 的 `stbi__gif_load_next` + `stbi__process_gif_raster` 内联）、`d4/f_180006a90.c` 签名检查；
 * - `d5/f_180006d90.c` 读头、`d5/f_180006c40.c` 读调色板、`d5/f_180007230.c` 写像素。
 *
 * 与 stb 原版的差异（都照 WPE，不照 stb）：disposal 2 的填色是把调色板项（按 B、G、R、A 存）的 4 字节原样拷进画布（R、B 互换，
 * 且「上一帧不透明」时用 `bgindex`、透明时用 `transparent` 那一项）；`bgindex` 只在有全局调色板、非 0、不越界时保留；
 * 第一帧（或重新开始）结束时没写到的像素填 `pal[bgindex]`（本帧 GCE 不带透明位才填）；调色板 alpha `> 128` 才写像素。
 *
 * 与约定 `ignore/p11/b4/contract.md` 逐条对过反编译，无出入。几处约定没写、照反编译补的细节：
 * - 读到末尾时 `get8` 返回 0 且读指针不前进；而「跳过 n 字节」在内存缓冲下无条件前进（可越过末尾），之后读到的都是末尾，效果相同；
 * - 码流里读子块长度或读到末尾都算「这一帧的光栅结束」（正常收尾，不报错），只有标签读不到才是 `unknown code`；
 * - 失败时读指针停在出错处、画布保留已写入的部分（同 WPE 原地写），下次 `advance` 接着从那里解；
 * - 局部调色板 `lpal` 与全局调色板 `pal` 在状态里常驻（WPE 状态建时清零，之后不重置），索引超出已读项数时读到常驻内容（初值全 0、alpha 0）；
 * - 码表有 0x2004 项：`avail` 最多涨到 0x2000，超过报 `too many codes`；码值本身最多 12 位。
 */

/** `decode` 的结果：解出一帧 / 读到结束符 `;` / 失败。 */
const FAIL = 0;
const FRAME = 1;
const END = 2;

/** 解码调用的三种起点（`FUN_180007800` 的三条入口）。 */
const MODE_INITIAL = 0;
const MODE_NEXT = 1;
const MODE_RESTART = 2;

/** LZW 码表项数（`0x82c`–`0x8830`，每项 4 字节）。 */
const TABLE_SIZE = 0x2004;
/** `avail` 的上限（超过报 `too many codes`）。 */
const MAX_AVAIL = 0x2000;
/** 逻辑屏幕宽高上限（stb 的 `STBI_MAX_DIMENSIONS`）。 */
const MAX_DIMENSION = 0x1000000;

export class GifAnimation {
  private readonly data: Uint8Array;
  /** 读指针（WPE `+0xc0`）；原始起点恒为 0。 */
  private pos = 0;

  private w = 0;
  private h = 0;
  /** 头的 flags / bgindex（−1 = 不用）/ transparent（−1 = 无）/ 最近一个 GCE 的 flags / 延时（毫秒）。 */
  private headerFlags = 0;
  private bgIndex = -1;
  private transparent = -1;
  private eflags = 0;
  private delay = 0;

  /** 画布（RGBA 直通）与「本帧写过」表（每像素一字节）。 */
  private out: Uint8Array = new Uint8Array(0);
  private history: Uint8Array = new Uint8Array(0);
  /** disposal 3 用的上上帧，disposal 0 / 1 的帧之后才建与更新。 */
  private twoBack: Uint8Array | null = null;

  /** 全局 / 局部调色板：256 项 × 4 字节，按 B、G、R、A 存。 */
  private readonly pal = new Uint8Array(256 * 4);
  private readonly lpal = new Uint8Array(256 * 4);

  /** LZW 码表（prefix 为 int16，−1 = 无）与展开用的栈。 */
  private readonly codePrefix = new Int16Array(TABLE_SIZE);
  private readonly codeFirst = new Uint8Array(TABLE_SIZE);
  private readonly codeSuffix = new Uint8Array(TABLE_SIZE);
  private readonly stack = new Uint8Array(TABLE_SIZE + 16);

  /** `AdvanceGIF` 的外层状态：剩余时间（float32）、首次标志、上次的尺寸。 */
  private remainValue = 0;
  private firstCall = true;
  private prevW = 0;
  private prevH = 0;
  private initial = true;
  private frames = 0;

  /** 最近一次失败的原因（stb 的 `failure_reason`），诊断用。 */
  lastError = "";

  private constructor(data: Uint8Array) {
    this.data = data;
    // `OpenGIF` 里的 `FUN_180006a90`：只检查签名，之后读指针回到文件开头。
    if (!this.signatureOk()) {
      throw new Error("GIF 解码失败：not GIF");
    }
    this.pos = 0;
    // 第一次解码的入口分支（`out` 为空）：读头、分配画布与「写过」表。
    if (!this.readHeader()) {
      throw new Error(`GIF 解码失败：${this.lastError}`);
    }
    const size = this.w * this.h * 4;
    if (size > 0x7fffffff) {
      throw new Error("GIF 解码失败：too large");
    }
    try {
      this.out = new Uint8Array(size);
      this.history = new Uint8Array(this.w * this.h);
    } catch {
      throw new Error("GIF 解码失败：outofmem");
    }
  }

  /**
   * WPE 建纹理时的 `OpenGIF` + 第一次 `AdvanceGIF(dt = 0)`：整份文件字节进状态，解出第 0 帧。文件不是 GIF、尺寸超限、第 0 帧解不出时抛错
   * （WPE 的纹理带失败位、退回缺省纹理）。不复制 `bytes`，调用方不再改它。
   */
  static open(bytes: Uint8Array): GifAnimation {
    const gif = new GifAnimation(bytes);
    if (!gif.advance(0)) {
      throw new Error(`GIF 解码失败：${gif.lastError || "no frame"}`);
    }
    return gif;
  }

  /** 逻辑屏幕宽（GIF 头），每帧相同。 */
  get width(): number {
    return this.w;
  }

  /** 逻辑屏幕高。 */
  get height(): number {
    return this.h;
  }

  /**
   * 当前画布：`width × height` 的 RGBA（直通 alpha，WPE 交给纹理的 `*bits`）。同一个对象，`advance` 换帧时原地改内容；调用方只读。
   */
  get canvas(): Uint8Array {
    return this.out;
  }

  /** 已解出的帧数（含重新开始后的），诊断用。 */
  get frameIndex(): number {
    return this.frames;
  }

  /** 剩余时间（秒，float32），诊断用；负数是带出的超出部分。 */
  get remain(): number {
    return this.remainValue;
  }

  /** 最近一帧的延时（毫秒），诊断用。 */
  get frameDelayMs(): number {
    return this.delay;
  }

  /**
   * WPE 的 `AdvanceGIF(s, dt)`（`0x1800021d0`）：剩余时间没到就只扣时间、返回 false；到了就解下一帧（读到结束符 `;` 时回到文件开头、
   * 按「重新开始」解第 0 帧），剩余时间加上这一帧的延时，返回 true。一次最多前进一帧；解码出错返回 false、画布不变。
   * `dt` 是当帧的 `g_Frametime`（秒）。
   */
  advance(dt: number): boolean {
    if (!this.firstCall && this.remainValue > 0) {
      this.remainValue = Math.fround(this.remainValue - Math.fround(dt));
      if (this.remainValue > 0) return false;
    }
    this.firstCall = false;
    let result = this.decode(this.initial ? MODE_INITIAL : MODE_NEXT);
    this.initial = false;
    if (result === END) {
      // 读到结束符：读指针回到文件开头，按「重新开始」再解一次（再读到 `;` 也算解出，同反编译：返回的状态指针非空）。
      this.pos = 0;
      result = this.decode(MODE_RESTART);
    }
    if (result === FAIL) return false;

    const w = this.w;
    const h = this.h;
    const same = !(this.prevW !== 0 && (this.prevW !== w || this.prevH !== h));
    this.prevW = w;
    this.prevH = h;
    // `(float)delay / 1000.0f + remain`：都是 float32。
    this.remainValue = Math.fround(Math.fround(this.delay / 1000) + this.remainValue);
    const dispose = this.eflags & 0x1c;
    if (dispose === 0 || dispose === 4) {
      if (this.twoBack === null) this.twoBack = new Uint8Array(w * h * 4);
      if (same) this.twoBack.set(this.out);
    }
    this.frames++;
    return true;
  }

  // ---------------------------------------------------------------- 读字节

  private get8(): number {
    return this.pos < this.data.length ? this.data[this.pos++]! : 0;
  }

  private get16(): number {
    const lo = this.get8();
    return lo | (this.get8() << 8);
  }

  /** 跳过后续的子块，直到长度 0 或读到末尾。 */
  private skipSubblocks(): void {
    const data = this.data;
    for (;;) {
      if (this.pos >= data.length) return;
      const len = data[this.pos++]!;
      if (len === 0) return;
      this.pos += len;
    }
  }

  // ---------------------------------------------------------------- 头与调色板

  /** `FUN_180006a90`：`GIF8` + `7` / `9` + `a`。 */
  private signatureOk(): boolean {
    const d = this.data;
    if (d.length < 6) return false;
    return (
      d[0] === 0x47 &&
      d[1] === 0x49 &&
      d[2] === 0x46 &&
      d[3] === 0x38 &&
      (d[4] === 0x37 || d[4] === 0x39) &&
      d[5] === 0x61
    );
  }

  /** `FUN_180006c40`：读 `count` 项，依次 r、g、b，存成 `[b, g, r, a]`，`a = (i == transparent) ? 0 : 255`。 */
  private readPalette(target: Uint8Array, count: number, transparent: number): void {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      target[o + 2] = this.get8();
      target[o + 1] = this.get8();
      target[o] = this.get8();
      target[o + 3] = i === transparent ? 0 : 255;
    }
  }

  /** `FUN_180006d90`（`stbi__gif_header` 改版）。 */
  private readHeader(): boolean {
    if (
      this.get8() !== 0x47 ||
      this.get8() !== 0x49 ||
      this.get8() !== 0x46 ||
      this.get8() !== 0x38 ||
      ((this.get8() - 0x37) & 0xfd) !== 0 || // '7' / '9'
      this.get8() !== 0x61
    ) {
      this.lastError = "not GIF";
      return false;
    }
    this.w = this.get16();
    this.h = this.get16();
    this.headerFlags = this.get8();
    this.bgIndex = this.get8();
    this.get8(); // ratio
    this.transparent = -1;
    if (this.w > MAX_DIMENSION || this.h > MAX_DIMENSION) {
      this.lastError = "too large";
      return false;
    }
    let keepBg = false;
    if ((this.headerFlags & 0x80) !== 0) {
      const count = 2 << (this.headerFlags & 7);
      this.readPalette(this.pal, count, -1);
      // bgindex 只在「有全局调色板、非 0、不越界」时保留（对 stb 原版的修改）。
      if (this.bgIndex !== 0 && this.bgIndex < count) keepBg = true;
    }
    if (!keepBg) this.bgIndex = -1;
    // 这里（读头）之后 stb 原版还会检查 w * h * 4 不溢出，在 `FUN_180007800` 的分配分支里做，见构造函数。
    return true;
  }

  // ---------------------------------------------------------------- 解一帧

  /** `FUN_180007800`：解一帧（或读到结束符）。 */
  private decode(mode: number): number {
    const w = this.w;
    const h = this.h;
    const out = this.out;
    const history = this.history;
    const pixelCount = w * h;
    let first = false;

    if (mode === MODE_INITIAL) {
      first = true;
    } else if (mode === MODE_RESTART) {
      // 再读一遍头（重读全局调色板、transparent 置 −1、重判 bgindex；eflags 不重置），画布清 0。
      if (!this.readHeader()) return FAIL;
      out.fill(0);
      first = true;
    } else {
      // 按上一帧的 eflags 处理 disposal，只作用于「写过」表里的像素。
      let dispose = (this.eflags >> 2) & 7;
      const twoBack = this.twoBack;
      if ((this.eflags & 0x1c) === 0xc && twoBack === null) dispose = 2;
      if (dispose === 3) {
        if (twoBack !== null) {
          for (let i = 0; i < pixelCount; i++) {
            if (history[i] !== 0) {
              const o = i * 4;
              out[o] = twoBack[o]!;
              out[o + 1] = twoBack[o + 1]!;
              out[o + 2] = twoBack[o + 2]!;
              out[o + 3] = twoBack[o + 3]!;
            }
          }
        }
      } else if (dispose === 2) {
        let c0 = 0;
        let c1 = 0;
        let c2 = 0;
        let c3 = 0;
        if (this.bgIndex >= 0) {
          // 调色板项的 4 字节（B、G、R、A）原样当 RGBA 用：R、B 互换。
          const src = (this.transparent < 0 ? this.bgIndex : this.transparent) * 4;
          c0 = this.pal[src]!;
          c1 = this.pal[src + 1]!;
          c2 = this.pal[src + 2]!;
          c3 = this.pal[src + 3]!;
        }
        for (let i = 0; i < pixelCount; i++) {
          if (history[i] !== 0) {
            const o = i * 4;
            out[o] = c0;
            out[o + 1] = c1;
            out[o + 2] = c2;
            out[o + 3] = c3;
          }
        }
      }
    }
    history.fill(0);

    // 块循环
    const data = this.data;
    for (;;) {
      if (this.pos >= data.length) {
        this.lastError = "unknown code";
        return FAIL;
      }
      const tag = data[this.pos++]!;
      if (tag === 0x21) {
        // 扩展
        if (this.pos >= data.length) {
          this.lastError = "unknown code";
          return FAIL;
        }
        const label = data[this.pos++]!;
        if (label !== 0xf9) {
          this.skipSubblocks();
          continue;
        }
        if (this.pos >= data.length) {
          this.lastError = "unknown code";
          return FAIL;
        }
        const len = data[this.pos++]!;
        if (len === 4) {
          this.eflags = this.get8();
          this.delay = this.get16() * 10;
          if (this.transparent >= 0) this.pal[this.transparent * 4 + 3] = 255;
          if ((this.eflags & 1) === 0) {
            this.pos += 1;
            this.transparent = -1;
          } else {
            this.transparent = this.get8();
            this.pal[this.transparent * 4 + 3] = 0;
          }
          this.skipSubblocks();
        } else if (len !== 0) {
          // 长度不是 4：只跳过 len 字节就回块循环（不跳子块，同反编译）。
          this.pos += len;
        }
        continue;
      }
      if (tag === 0x3b) return END;
      if (tag !== 0x2c) {
        this.lastError = "unknown code";
        return FAIL;
      }

      // 图像描述
      const x = this.get16();
      const y = this.get16();
      const iw = this.get16();
      const ih = this.get16();
      if (x + iw > w || y + ih > h) {
        this.lastError = "bad Image Descriptor";
        return FAIL;
      }
      const lineSize = w * 4;
      const startX = x * 4;
      const startY = y * w * 4;
      const maxX = (x + iw) * 4;
      const maxY = (y + ih) * w * 4;
      const curY = iw === 0 ? maxY : startY;
      const lflags = this.get8();
      const interlaced = (lflags & 0x40) !== 0;
      let colorTable: Uint8Array;
      if ((lflags & 0x80) !== 0) {
        this.readPalette(this.lpal, 2 << (lflags & 7), (this.eflags & 1) !== 0 ? this.transparent : -1);
        colorTable = this.lpal;
      } else if ((this.headerFlags & 0x80) !== 0) {
        colorTable = this.pal;
      } else {
        this.lastError = "missing color table";
        return FAIL;
      }
      if (!this.raster(colorTable, lineSize, startX, startY, maxX, maxY, curY, interlaced)) return FAIL;

      // 一帧结束（`LAB_1800082e7`）：首帧、bgindex 有效、本帧不带透明位时，没写到的像素填 pal[bgindex]。
      if (first && this.bgIndex >= 0 && (this.eflags & 1) === 0) {
        const src = this.bgIndex * 4;
        const c0 = this.pal[src]!;
        const c1 = this.pal[src + 1]!;
        const c2 = this.pal[src + 2]!;
        const c3 = this.pal[src + 3]!;
        for (let i = 0; i < pixelCount; i++) {
          if (history[i] === 0) {
            const o = i * 4;
            out[o] = c0;
            out[o + 1] = c1;
            out[o + 2] = c2;
            out[o + 3] = c3;
          }
        }
      }
      return FRAME;
    }
  }

  /**
   * LZW 光栅（内联在 `FUN_180007800`）+ 写像素（`FUN_180007230`，prefix 递归改成栈展开、输出顺序不变）。
   * 返回 false = 失败（`lastError` 已填）；光栅结束（结束码、子块长度 0、读到末尾）都返回 true。
   */
  private raster(
    colorTable: Uint8Array,
    lineSize: number,
    startX: number,
    startY: number,
    maxX: number,
    maxY: number,
    startCurY: number,
    interlaced: boolean,
  ): boolean {
    const data = this.data;
    const end = data.length;
    let pos = this.pos;
    const out = this.out;
    const history = this.history;
    const prefix = this.codePrefix;
    const first = this.codeFirst;
    const suffix = this.codeSuffix;
    const stack = this.stack;

    // 写像素的状态（`+0x8838` 起）
    let parse = interlaced ? 3 : 0;
    let step = interlaced ? lineSize * 8 : lineSize;
    let curX = startX;
    let curY = startCurY;

    // lzw_cs：读到末尾时为 0、不检查。
    const lzwCs = pos < end ? data[pos++]! : 0;
    if (lzwCs > 12) {
      this.pos = pos;
      this.lastError = "bad code size";
      return false;
    }
    const clear = 1 << lzwCs;
    for (let i = 0; i < clear; i++) {
      prefix[i] = -1;
      first[i] = i;
      suffix[i] = i;
    }

    let noClear = true;
    let bits = 0;
    let nbits = 0;
    let blockLeft = 0;
    let error: string | null = null;

    outer: for (;;) {
      let oldcode = -1;
      let codeSize = lzwCs + 1;
      let codeMask = (1 << codeSize) - 1;
      let avail = clear + 2;
      for (;;) {
        while (nbits < codeSize) {
          if (blockLeft === 0) {
            if (pos >= end) break outer;
            blockLeft = data[pos++]!;
            if (blockLeft === 0) break outer;
          }
          blockLeft--;
          const b = pos < end ? data[pos++]! : 0;
          bits |= b << nbits;
          nbits += 8;
        }
        const code = bits & codeMask;
        bits >>= codeSize;
        nbits -= codeSize;

        if (code === clear) {
          noClear = false;
          continue outer;
        }
        if (code === clear + 1) {
          // 结束码：跳过本子块剩余与之后的子块。
          if (blockLeft !== 0) pos += blockLeft;
          for (;;) {
            if (pos >= end) break;
            const len = data[pos++]!;
            if (len === 0) break;
            pos += len;
          }
          break outer;
        }
        if (code > avail) {
          error = "illegal code in raster";
          break outer;
        }
        if (noClear) {
          error = "no clear code";
          break outer;
        }
        if (oldcode < 0) {
          if (code === avail) {
            error = "illegal code in raster";
            break outer;
          }
        } else {
          const next = avail + 1;
          if (next > MAX_AVAIL) {
            error = "too many codes";
            break outer;
          }
          prefix[avail] = oldcode;
          const f = first[oldcode]!;
          first[avail] = f;
          // `code == avail + 1` 实际不会发生（已经检查过 code <= avail）；KwKwK（code == avail）读到的正是刚写的 first。
          suffix[avail] = code !== next ? first[code]! : f;
          avail = next;
        }
        oldcode = code;

        // 写像素：沿 prefix 链收集 suffix，再从链根开始输出。
        if (curY < maxY) {
          let sp = 0;
          let c = code;
          while (c >= 0) {
            stack[sp++] = suffix[c]!;
            c = prefix[c]!;
          }
          while (sp > 0 && curY < maxY) {
            const ci = stack[--sp]! * 4;
            const o = curX + curY;
            history[o >> 2] = 1;
            const a = colorTable[ci + 3]!;
            if (a > 128) {
              out[o] = colorTable[ci + 2]!;
              out[o + 1] = colorTable[ci + 1]!;
              out[o + 2] = colorTable[ci]!;
              out[o + 3] = a;
            }
            curX += 4;
            if (curX >= maxX) {
              curX = startX;
              curY += step;
              while (curY >= maxY && parse > 0) {
                step = lineSize << parse;
                parse--;
                curY = startY + (step >> 1);
              }
            }
          }
        }

        if ((avail & codeMask) === 0 && avail < 0x1000) {
          codeSize++;
          codeMask = (1 << codeSize) - 1;
        }
      }
    }

    this.pos = pos;
    if (error !== null) {
      this.lastError = error;
      return false;
    }
    return true;
  }
}
