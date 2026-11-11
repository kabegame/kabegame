/**
 * wpefont（FreeType 2.14.3 + HarfBuzz 15.0.0 编成的 wasm，C 胶水 `src-tauri/wpefont/wpefont.c`）的 JS 包装：
 * 文本对象的「加载字体、查字、度量、排字、取字形位图」。排版规则一条都不在这里（见 P6b 1c 的 `text/`）。
 *
 * - wasm 由 `deno task build:wpefont` 产出到 `bin/wasm/wpefont/`，kabegame 命令不带 `--skip vue` 时拷到本目录
 *   （git 忽略）。缺失时 {@link loadWpefont} 返回 null，{@link wpefontLoadError} 给出原因，调用方把文本对象标成不支持。
 * - wasm 是 wasm32-wasip1 reactor：实例化时给 `wasi_snapshot_preview1` 一组桩（不读文件、不写 stdout），再调
 *   `_initialize`。光栅化器的 setjmp / longjmp 走 wasm 异常处理（exnref），宿主要支持它。
 * - 单位：排字结果与字体度量是 26.6 定点（除以 64 得像素）；字形位图与像素框是整数像素。字号按 WPE：
 *   `trunc(pointsize · 64)`、300 DPI。
 * - 接口契约（导出、输出布局、两条 hinting 规则）见 `src-tauri/wpefont/README.md`。
 */

// 文件不存在时 glob 结果为空，构建不会失败
const wasmUrls = import.meta.glob<string>("./wpefont.wasm", { query: "?url", import: "default", eager: true });
export const WPEFONT_WASM_URL: string | null = Object.values(wasmUrls)[0] ?? null;

/** FreeType 的 `FT_Pixel_Mode`：文本对象只会遇到这三种（单色只来自字体内嵌的点阵）。 */
export const PIXEL_MODE_MONO = 1;
export const PIXEL_MODE_GRAY = 2;
export const PIXEL_MODE_BGRA = 7;

/** `FT_LOAD_FORCE_AUTOHINT`。 */
const LOAD_FORCE_AUTOHINT = 1 << 5;

/** 一个排好的字形（HarfBuzz 的 `hb_glyph_info_t` + `hb_glyph_position_t`），位置为 26.6。 */
export interface ShapedGlyph {
  gid: number;
  /** 对应输入码点的下标（`hb_buffer_add_utf32` 按码点计）。 */
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

/** 字号下的字体度量（`face->size->metrics`），26.6。 */
export interface FontMetrics {
  ascender: number;
  descender: number;
  height: number;
  unitsPerEm: number;
  /** 是否强制自动 hinting（TrueType 没有 `fpgm`）。 */
  forceAutohint: boolean;
}

/** `FT_Glyph_Get_CBox(FT_GLYPH_BBOX_PIXELS)` 的像素框，y 向上。 */
export interface GlyphBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** 栅格化后的字形（`FT_Load_Glyph(RENDER | COLOR …)` 的字形槽）。 */
export interface GlyphBitmap {
  width: number;
  rows: number;
  /** `bitmap_left`：笔位置到位图左边的像素数。 */
  left: number;
  /** `bitmap_top`：基线到位图上边的像素数，向上为正。 */
  top: number;
  /** FreeType 的像素格式，见 {@link PIXEL_MODE_GRAY} 等。 */
  mode: number;
  /** 彩色字形（BGRA，预乘 alpha）。 */
  color: boolean;
  /**
   * 位图，按行紧排、从上到下（拷贝，不引用 wasm 内存）：灰度 1 字节 / 像素，彩色 BGRA 4 字节 / 像素；
   * 单色 1 位 / 像素、每行 `ceil(width / 8)` 字节（高位在左）。
   */
  pixels: Uint8Array;
  /**
   * 本次加载（已栅格化）的字形框，等于位图框。WPE 定图集格子用的是另一次 `FT_LOAD_NO_BITMAP` 加载的轮廓框，
   * 彩色字形、内嵌点阵时和这个不同（见 `src-tauri/wpefont/README.md`）。
   */
  cbox: GlyphBox;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  wpefont_alloc(size: number): number;
  wpefont_free(ptr: number): void;
  wpefont_font_new(data: number, length: number, size26_6: number): number;
  wpefont_font_free(font: number): void;
  wpefont_font_has(font: number, codepoint: number): number;
  wpefont_font_metrics(font: number, out: number): void;
  wpefont_shape(font: number, text: number, length: number, out: number, cap: number): number;
  wpefont_glyph(font: number, gid: number, out: number): number;
}

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

/** wasm 调用了 `proc_exit`（C 侧 `abort` / `exit`）。 */
class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`wpefont 调用了 proc_exit(${code})`);
  }
}

/**
 * `wasi_snapshot_preview1` 的桩：没有文件、没有预打开目录（`fd_prestat_get` 返回 EBADF）、没有环境变量与参数，
 * 写 stdout / stderr 的内容丢弃但报告写完；模块导入了这里没有的函数时，`fd_*` / `path_*` 返回 EBADF，其余 ENOSYS。
 */
function wasiImports(module: WebAssembly.Module, memory: () => WebAssembly.Memory): Record<string, Function> {
  const view = () => new DataView(memory().buffer);
  const zeroSizes = (count: number, size: number) => {
    const v = view();
    v.setUint32(count, 0, true);
    v.setUint32(size, 0, true);
    return ERRNO_SUCCESS;
  };
  const stubs: Record<string, Function> = {
    args_get: () => ERRNO_SUCCESS,
    args_sizes_get: zeroSizes,
    environ_get: () => ERRNO_SUCCESS,
    environ_sizes_get: zeroSizes,
    clock_res_get: (_id: number, out: number) => {
      view().setBigUint64(out, 1000n, true);
      return ERRNO_SUCCESS;
    },
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      // 0 = 实时时钟，其余按单调时钟
      const ns = id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1e6));
      view().setBigUint64(out, ns, true);
      return ERRNO_SUCCESS;
    },
    fd_write: (_fd: number, iovs: number, count: number, written: number) => {
      const v = view();
      let total = 0;
      for (let i = 0; i < count; i++) total += v.getUint32(iovs + 8 * i + 4, true);
      v.setUint32(written, total, true);
      return ERRNO_SUCCESS;
    },
    proc_exit: (code: number) => {
      throw new WasiExit(code);
    },
    random_get: (ptr: number, length: number) => {
      // getRandomValues 一次最多 65536 字节
      for (let offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(new Uint8Array(memory().buffer, ptr + offset, Math.min(65536, length - offset)));
      }
      return ERRNO_SUCCESS;
    },
    sched_yield: () => ERRNO_SUCCESS,
  };
  const imports: Record<string, Function> = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module !== "wasi_snapshot_preview1" || entry.kind !== "function") continue;
    const fileOp = entry.name.startsWith("fd_") || entry.name.startsWith("path_");
    imports[entry.name] = stubs[entry.name] ?? (fileOp ? () => ERRNO_BADF : () => ERRNO_NOSYS);
  }
  return imports;
}

/** 每行字节数（紧排）。 */
function rowBytes(mode: number, width: number, pitch: number): number {
  switch (mode) {
    case PIXEL_MODE_MONO:
      return Math.ceil(width / 8);
    case 3: // GRAY2
      return Math.ceil(width / 4);
    case 4: // GRAY4
      return Math.ceil(width / 2);
    case PIXEL_MODE_BGRA:
      return 4 * width;
    case PIXEL_MODE_GRAY:
    case 5: // LCD（width 已是 3 倍）
    case 6: // LCD_V
      return width;
    default:
      return Math.abs(pitch);
  }
}

/** 一个实例：wasm 导出、可增长的暂存区，以及 trap 后的作废标记。 */
class Engine {
  private scratchPtr = 0;
  private scratchSize = 0;
  private broken: unknown = null;

  constructor(readonly exports: Exports) {}

  /** 每次都重新取：wasm 内存增长后旧的 `buffer` 会失效。 */
  get buffer(): ArrayBuffer {
    return this.exports.memory.buffer;
  }

  /** 至少 `size` 字节的暂存区（16 字节对齐），下一次调用 `scratch` 之前有效。 */
  scratch(size: number): number {
    if (size > this.scratchSize) {
      if (this.scratchPtr) this.exports.wpefont_free(this.scratchPtr);
      const next = Math.max(size, 2 * this.scratchSize, 4096);
      this.scratchPtr = this.exports.wpefont_alloc(next) >>> 0;
      this.scratchSize = this.scratchPtr ? next : 0;
      if (!this.scratchPtr) throw new Error("wpefont 内存不足");
    }
    return this.scratchPtr;
  }

  /** 调 wasm：trap 后实例状态（堆、字形槽）不可信，之后的调用一律报错，调用方应重新加载。 */
  run<T>(call: (exports: Exports) => T): T {
    if (this.broken) throw new Error(`wpefont 实例已作废：${String(this.broken)}`);
    try {
      return call(this.exports);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError || error instanceof WasiExit) this.broken = error;
      throw error;
    }
  }
}

/** 一个字号下的一个字体（`FT_Face` + `hb_font_t`）。用完调 {@link dispose}。 */
export class WpefontFace {
  private handle: number;

  /** @internal 由 {@link Wpefont.face} 创建。 */
  constructor(
    private readonly engine: Engine,
    handle: number,
  ) {
    this.handle = handle;
  }

  get disposed(): boolean {
    return this.handle === 0;
  }

  private live(): number {
    if (!this.handle) throw new Error("WpefontFace 已释放");
    return this.handle;
  }

  /** 字体有没有这个码点（`FT_Get_Char_Index != 0`），回退链逐码点查。 */
  has(codepoint: number): boolean {
    const handle = this.live();
    return this.engine.run((e) => e.wpefont_font_has(handle, codepoint) !== 0);
  }

  metrics(): FontMetrics {
    const handle = this.live();
    return this.engine.run((e) => {
      const out = this.engine.scratch(20);
      e.wpefont_font_metrics(handle, out);
      const [ascender, descender, height, unitsPerEm, loadFlags] = new Int32Array(this.engine.buffer, out, 5);
      return { ascender, descender, height, unitsPerEm, forceAutohint: (loadFlags & LOAD_FORCE_AUTOHINT) !== 0 };
    });
  }

  /** 排一段码点（同一字体、不跨行）：`hb_buffer_guess_segment_properties` + `hb_shape`，不带 features。 */
  shape(codepoints: readonly number[]): ShapedGlyph[] {
    const handle = this.live();
    const length = codepoints.length;
    if (length === 0) return [];
    return this.engine.run((e) => {
      let cap = length + 8;
      for (;;) {
        const text = this.engine.scratch(4 * length + 24 * cap);
        const out = text + 4 * length;
        new Uint32Array(this.engine.buffer, text, length).set(codepoints);
        const count = e.wpefont_shape(handle, text, length, out, cap);
        // 字形比码点多（分解、重排）且超出缓冲：按实际个数重排一次
        if (count > cap) {
          cap = count;
          continue;
        }
        const raw = new Int32Array(this.engine.buffer, out, 6 * count);
        const glyphs: ShapedGlyph[] = new Array(count);
        for (let i = 0; i < count; i++) {
          const o = 6 * i;
          glyphs[i] = {
            gid: raw[o],
            cluster: raw[o + 1],
            xAdvance: raw[o + 2],
            yAdvance: raw[o + 3],
            xOffset: raw[o + 4],
            yOffset: raw[o + 5],
          };
        }
        return glyphs;
      }
    });
  }

  /** 栅格化一个字形；加载失败（gid 越界、字形数据坏）返回 null。 */
  glyph(gid: number): GlyphBitmap | null {
    const handle = this.live();
    return this.engine.run((e) => {
      const out = this.engine.scratch(40);
      const buffer = e.wpefont_glyph(handle, gid, out) >>> 0;
      const [width, rows, pitch, left, top, mode, xMin, yMin, xMax, yMax] = new Int32Array(this.engine.buffer, out, 10);
      if (mode < 0) return null;
      const stride = rowBytes(mode, width, pitch);
      const pixels = new Uint8Array(stride * rows);
      if (buffer && stride > 0) {
        const heap = new Uint8Array(this.engine.buffer);
        for (let r = 0; r < rows; r++) {
          // pitch 为负时第一行在缓冲末尾（FreeType 的「向上」位图）
          const start = pitch >= 0 ? buffer + r * pitch : buffer + (rows - 1 - r) * -pitch;
          pixels.set(heap.subarray(start, start + stride), r * stride);
        }
      }
      return {
        width,
        rows,
        left,
        top,
        mode,
        color: mode === PIXEL_MODE_BGRA,
        pixels,
        cbox: { xMin, yMin, xMax, yMax },
      };
    });
  }

  /** 释放字体（连同交给它的字体数据）。重复调用无害。 */
  dispose(): void {
    const handle = this.handle;
    if (!handle) return;
    this.handle = 0;
    this.engine.run((e) => e.wpefont_font_free(handle));
  }
}

/** 一个 wasm 实例。字体都建在它的堆上，实例跨重新编译保留（宿主主线程）。 */
export class Wpefont {
  private constructor(private readonly engine: Engine) {}

  static async fromModule(module: WebAssembly.Module): Promise<Wpefont> {
    let memory: WebAssembly.Memory | null = null;
    const wasi = wasiImports(module, () => memory!);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const exports = instance.exports as unknown as Exports;
    memory = exports.memory;
    exports._initialize?.();
    return new Wpefont(new Engine(exports));
  }

  /** 从 wasm 字节建实例（Node 测试用；宿主走 {@link loadWpefont}）。 */
  static async fromBytes(bytes: BufferSource): Promise<Wpefont> {
    return Wpefont.fromModule(await WebAssembly.compile(bytes));
  }

  /**
   * 加载字体（字体文件第 0 个 face、Unicode 字符表、`FT_Set_Char_Size(0, trunc(pointsize · 64), 300, 300)`）。
   * 字体数据拷进 wasm 堆、归字体所有。不是能识别的字体返回 null。
   */
  face(bytes: Uint8Array | ArrayBuffer, pointsize: number): WpefontFace | null {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const engine = this.engine;
    return engine.run((e) => {
      const ptr = e.wpefont_alloc(data.byteLength) >>> 0;
      if (!ptr) return null;
      new Uint8Array(engine.buffer, ptr, data.byteLength).set(data);
      // 失败时 C 侧已经释放 ptr
      const handle = e.wpefont_font_new(ptr, data.byteLength, Math.trunc(pointsize * 64)) >>> 0;
      return handle ? new WpefontFace(engine, handle) : null;
    });
  }
}

let loading: Promise<Wpefont | null> | null = null;
let loadError: string | null = null;

/** 最近一次 {@link loadWpefont} 失败的原因（成功后清空），给宿主上报。 */
export function wpefontLoadError(): string | null {
  return loadError;
}

/**
 * 加载并缓存字体引擎（主线程 `fetch` → `WebAssembly.compile` → 带 WASI 桩实例化 → `_initialize`）。
 * 不抛错：wasm 没拷进宿主或加载失败时返回 null，原因见 {@link wpefontLoadError}；失败后下次调用重试。
 */
export function loadWpefont(): Promise<Wpefont | null> {
  const url = WPEFONT_WASM_URL;
  if (!url) {
    loadError = "wpefont.wasm 没有拷进场景宿主：先运行 deno task build:wpefont";
    return Promise.resolve(null);
  }
  loading ??= (async () => {
    // file: 响应没有 Content-Type，不能用 compileStreaming
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Wpefont.fromModule(await WebAssembly.compile(await response.arrayBuffer()));
  })().then(
    (font) => {
      loadError = null;
      return font;
    },
    (error: unknown) => {
      loading = null;
      loadError = `加载 wpefont.wasm 失败：${error instanceof Error ? error.message : String(error)}`;
      return null;
    },
  );
  return loading;
}
