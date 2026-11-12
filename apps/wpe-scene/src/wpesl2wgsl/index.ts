/**
 * wpesl2wgsl（Wallpaper Engine 着色器语言 → WGSL，Rust 编成的 wasm，源码 `src-tauri/wpesl2wgsl`）的 JS 胶水。
 *
 * - wasm 由 `deno task build:wpesl2wgsl` 产出到 `bin/wasm/wpesl2wgsl/`，kabegame 命令不带 `--skip vue` 时拷到本目录
 *   （git 忽略）。缺失时 {@link loadWpesl2wgsl} 返回 null，调用方把场景标成不支持。
 * - 一次翻译一个材质 pass 的着色器对：传顶点 / 片元源码原文，预处理与翻译都在 wasm 里做。头文件按需提供：
 *   结果是 `phase: "include"` 时按 `missing` 读文件再调一次（{@link translateWithIncludes} 封装了这个循环）。
 * - wasm 用 `panic = "abort"` 构建：panic 会让实例 trap，这里丢弃实例、下次调用前重建，本次返回 `phase: "trap"`。
 */

// 文件不存在时 glob 结果为空，构建不会失败
const wasmUrls = import.meta.glob<string>("./wpesl2wgsl.wasm", { query: "?url", import: "default", eager: true });
export const WPESL2WGSL_WASM_URL: string | null = Object.values(wasmUrls)[0] ?? null;

export type ShaderStage = "vertex" | "fragment";

export interface TranslateRequest {
  vertex: string;
  fragment: string;
  /**
   * 几何着色器（`.geom`）原文。给了就定义 `GS_ENABLED`，把顶点着色器的 GS 分支和几何着色器拼成一个顶点着色器：
   * 每次几何着色器调用是一个实例，`vertex_index` 是第几个输出顶点（第 N 次 `OUT.Append` 的顶点），拓扑三角形带。
   */
  geometry?: string;
  /** 头文件源码，键为 `#include` 里写的名字（相对 `shaders/` 根）。 */
  includes?: Record<string, string>;
  /** 材质 / effect 指定的 COMBO（名字不分大小写）。 */
  combos?: Record<string, number | boolean>;
  /** 已绑定的纹理槽位与 `.tex` 格式枚举：决定采样器注释里的 `combo` 与 `TEX<n>FORMAT`。 */
  textures?: { slot: number; format?: number }[];
  /** 额外的宏，最后应用。 */
  defines?: Record<string, string>;
  /** 只在最终 `LIGHTING` 非 0 时生效的宏：`LIGHTS_*` 与光照路径的 `HDR` / `SCENE_ORTHO`。 */
  litDefines?: Record<string, string>;
  /** 成功时也带上生成的 GLSL 450。 */
  debug?: boolean;
}

export interface StageOutput {
  wgsl?: string;
  entryPoint?: string;
  /** 失败时总有（诊断行号指向它），成功时只在 `debug` 下有。 */
  glsl?: string;
}

export interface UniformLayout {
  name: string;
  /** WGSL 写法，如 `vec4<f32>`、`mat4x4<f32>`、`array<f32, 4>`。 */
  type: string;
  /** WPESL 里声明的类型（`float`、`vec3`、`mat4`……）；翻译器总会给，手写的测试数据可能没有。 */
  declared?: string;
  offset: number;
  size: number;
  array?: number;
  stride?: number;
  /** 声明行尾的 JSON（`material`、`default`、`range`……）；引擎内建的 `g_*` 没有。 */
  meta?: Record<string, unknown>;
  /**
   * 两阶段同名、材质键或类型不同的 uniform 被拆成两格（同一个材质键在 WPE 里只有一份存储，同键同类型的合成一格）：
   * 这一格只给哪个阶段用，两半各标自己的阶段。合并的没有。
   */
  stage?: ShaderStage;
  /** 拆分后改了名的那一格（`kb_vs_<名字>` / `kb_fs_<名字>`，总带 `meta.material`）：着色器里写的原名。 */
  original?: string;
  /**
   * 两个阶段入口可达的代码都没读这一格（翻译器按 naga IR 的语法引用判断；拆开的两半只看自己的阶段）。WPE 只认反射里
   * 被使用的 uniform：没被使用的不进常量缓冲、不分配材质常量槽位，两阶段同键时合并类型取读到它的阶段（p7-REPORT
   * 「P7d 的实测」）。缺失当被读，手写的测试数据不用写。
   */
  unused?: true;
}

export interface TextureBinding {
  slot: number;
  name: string;
  kind: "2d" | "2d-comparison" | "3d" | "cube";
  binding: number;
  samplerBinding: number;
  meta?: Record<string, unknown>;
}

export interface InterfaceVariable {
  name: string;
  location: number;
  type: string;
  array?: number;
  /**
   * 只在属性上（P5c 步骤 1）：顶点阶段入口可达的代码没读它。WPE 的 fxc 把没读的输入从签名里去掉，网格缺这个属性也照常画
   * （p5-REPORT「P5c 语义的实测核对」，`p5c-attr` 的 M3）；判据同 uniform 的 `unused`，缺失当被读。
   */
  unused?: boolean;
}

export interface ComboValue {
  name: string;
  value: number;
  source: "default" | "texture" | "request";
}

export interface Diagnostic {
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export type TranslatePhase =
  "request" | "include" | "require" | "preprocess" | "rewrite" | "parse" | "validate" | "write" | "trap";

export interface TranslateResult {
  ok: boolean;
  vertex?: StageOutput;
  fragment?: StageOutput;
  /** uniform 块（group 0 / binding 0，两阶段共用一块缓冲）。 */
  uniforms?: UniformLayout[];
  uniformBlockSize?: number;
  textures?: TextureBinding[];
  attributes?: InterfaceVariable[];
  varyings?: InterfaceVariable[];
  combos?: ComboValue[];
  /**
   * 只在请求带 `geometry` 时有：顶点输入全部按实例步进（每次几何着色器调用一个实例），每个实例画 `maxVertices` 个顶点，
   * 拓扑三角形带。
   */
  geometry?: {
    /** `[maxvertexcount(...)]` 展开后的常量，如 `4 + TRAILSUBDIVISION * 2`。 */
    maxVertices: number;
  };
  phase?: TranslatePhase;
  /** 出错的阶段；几何段的预处理与展开错误是 `"geometry"`。 */
  stage?: ShaderStage | "geometry";
  errors?: Diagnostic[];
  missing?: string[];
  requires?: string[];
}

interface Exports {
  memory: WebAssembly.Memory;
  wpesl_alloc(len: number): number;
  wpesl_free(ptr: number, len: number): void;
  wpesl_translate(ptr: number, len: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Wpesl2wgsl {
  private exports: Exports | null;

  private constructor(
    private readonly module: WebAssembly.Module,
    instance: WebAssembly.Instance,
  ) {
    this.exports = instance.exports as unknown as Exports;
  }

  static async fromModule(module: WebAssembly.Module): Promise<Wpesl2wgsl> {
    return new Wpesl2wgsl(module, await WebAssembly.instantiate(module, {}));
  }

  static async fromBytes(bytes: BufferSource): Promise<Wpesl2wgsl> {
    return Wpesl2wgsl.fromModule(await WebAssembly.compile(bytes));
  }

  /** 翻译一个着色器对；头文件缺失时返回 `phase: "include"`，见 {@link translateWithIncludes}。 */
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    if (!this.exports) {
      this.exports = (await WebAssembly.instantiate(this.module, {})).exports as unknown as Exports;
    }
    try {
      return this.call(this.exports, request);
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      // trap 后实例内存可能已损坏：丢弃，下次调用前重建
      this.exports = null;
      return { ok: false, phase: "trap", errors: [{ message: String(error) }] };
    }
  }

  private call(exports: Exports, request: TranslateRequest): TranslateResult {
    const input = encoder.encode(JSON.stringify(request));
    const inputPtr = exports.wpesl_alloc(input.length);
    new Uint8Array(exports.memory.buffer, inputPtr, input.length).set(input);
    const outPtr = exports.wpesl_translate(inputPtr, input.length);
    exports.wpesl_free(inputPtr, input.length);
    // memory.buffer 可能在调用中扩容，必须重新取视图
    const len = new DataView(exports.memory.buffer).getUint32(outPtr, true);
    const json = decoder.decode(new Uint8Array(exports.memory.buffer, outPtr + 4, len));
    exports.wpesl_free(outPtr, 4 + len);
    return JSON.parse(json) as TranslateResult;
  }
}

/**
 * 翻译并按需补头文件：每次结果缺头文件就调 `readInclude` 读出来再翻译，读不到（返回 null）时原样返回缺失结果。
 */
export async function translateWithIncludes(
  translator: Wpesl2wgsl,
  request: TranslateRequest,
  readInclude: (name: string) => Promise<string | null>,
  maxRounds = 16,
): Promise<TranslateResult> {
  const includes = { ...request.includes };
  for (let round = 0; round < maxRounds; round++) {
    const result = await translator.translate({ ...request, includes });
    if (result.phase !== "include") return result;
    for (const name of result.missing ?? []) {
      const source = await readInclude(name);
      if (source == null) return result;
      includes[name] = source;
    }
  }
  return translator.translate({ ...request, includes });
}

let loading: Promise<Wpesl2wgsl | null> | null = null;

/** 加载并缓存翻译器；wasm 没有拷进前端时返回 null。 */
export function loadWpesl2wgsl(): Promise<Wpesl2wgsl | null> {
  if (!WPESL2WGSL_WASM_URL) return Promise.resolve(null);
  loading ??= (async () => {
    const response = await fetch(WPESL2WGSL_WASM_URL);
    if (!response.ok) throw new Error(`加载 wpesl2wgsl.wasm 失败：${response.status}`);
    return Wpesl2wgsl.fromBytes(await response.arrayBuffer());
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}
