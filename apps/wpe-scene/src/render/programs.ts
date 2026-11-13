/**
 * 由翻译结果（`TranslateResult`）建 WebGPU 程序：着色器模块、bind group layout、顶点布局与管线。
 *
 * - 绑定按翻译器约定（`src-tauri/wpesl2wgsl/README.md`「绑定布局」）：全部在 group 0，binding 0 是两阶段共用的
 *   uniform 块，纹理槽位 n 在 `textures[].binding`（1 + 2n）、采样器在 `samplerBinding`（2 + 2n）。
 * - 着色器模块建好后先看 `getCompilationInfo()`：翻译器只用 naga 回读过输出，浏览器的 Tint 校验在这里第一次真正生效，
 *   有 error 级消息就整张退回预览图。模块开头加 `diagnostic(off, derivative_uniformity)`：WGSL 要求 `textureSample`
 *   等隐式求导只在一致控制流里调用，HLSL / D3D 没有这条限制，WPE 着色器常在分支里采样（本机语料里
 *   `effects/depthparallax` 因此被 Tint 拒绝；naga 不做一致性分析，翻译器发现不了）。行号报告时扣回这一行。
 * - 混合照 linux-wallpaperengine（GPLv3）`CPass::setupRenderFramebuffer`：translucent = SRC_ALPHA / ONE_MINUS_SRC_ALPHA，
 *   additive = SRC_ALPHA / ONE，normal = ONE / ZERO（颜色与 alpha 相同）；其余关闭混合。
 *   画到场景目标的最后一个 pass 不写 alpha（LWE 在最后一个 pass 前 `glColorMask(…, false)`），场景目标的 alpha 一直是清屏时的 1。
 */
import type { InterfaceVariable, TextureBinding, TranslateResult } from "../wpesl2wgsl";
import { oneLine, SceneRenderError } from "./errors";
import type { QuadVertex } from "./layout";

export function blendState(mode: string): GPUBlendState | undefined {
  const component = (srcFactor: GPUBlendFactor, dstFactor: GPUBlendFactor): GPUBlendComponent => ({
    operation: "add",
    srcFactor,
    dstFactor,
  });
  switch (mode) {
    case "translucent":
      return {
        color: component("src-alpha", "one-minus-src-alpha"),
        alpha: component("src-alpha", "one-minus-src-alpha"),
      };
    case "additive":
      return { color: component("src-alpha", "one"), alpha: component("src-alpha", "one") };
    case "normal":
      return { color: component("one", "zero"), alpha: component("one", "zero") };
    default:
      return undefined;
  }
}

/**
 * `copyBackground` 为 false 的组里画到「场景」（组的合成 RT）的混合（P5b 步骤 4，rea-p5-modelflags §2.5 的 `FUN_140099f60`，
 * p5-REPORT `p5b-grp-cb0`）：alpha 通道 One / One / Max，颜色通道照绘制自己的混合；绘制本身不混合（null 或不认识的模式）时颜色用
 * One / Zero，等于直写。WebGPU 要求 max 的两个因子都是 one。
 */
export function groupBlendState(mode: string | null): GPUBlendState {
  const color: GPUBlendComponent = (mode ? blendState(mode)?.color : undefined) ?? {
    operation: "add",
    srcFactor: "one",
    dstFactor: "zero",
  };
  return { color, alpha: { operation: "max", srcFactor: "one", dstFactor: "one" } };
}

export interface AttributeFormat {
  format: GPUVertexFormat;
  components: number;
  kind: "f32" | "i32" | "u32";
}

const ATTRIBUTE_FORMATS: Record<string, AttributeFormat> = {
  float: { format: "float32", components: 1, kind: "f32" },
  vec2: { format: "float32x2", components: 2, kind: "f32" },
  vec3: { format: "float32x3", components: 3, kind: "f32" },
  vec4: { format: "float32x4", components: 4, kind: "f32" },
  int: { format: "sint32", components: 1, kind: "i32" },
  ivec2: { format: "sint32x2", components: 2, kind: "i32" },
  ivec3: { format: "sint32x3", components: 3, kind: "i32" },
  ivec4: { format: "sint32x4", components: 4, kind: "i32" },
  uint: { format: "uint32", components: 1, kind: "u32" },
  uvec2: { format: "uint32x2", components: 2, kind: "u32" },
  uvec3: { format: "uint32x3", components: 3, kind: "u32" },
  uvec4: { format: "uint32x4", components: 4, kind: "u32" },
};

interface PackedAttribute {
  name: string;
  location: number;
  offset: number;
  info: AttributeFormat;
  /** 矩阵的第几列（非矩阵为 0）。 */
  column: number;
}

/** 交错顶点里的一个输入（矩阵 / 数组按列展开成多项）：粒子顶点（`particles/vertices.ts`）按它写，不写死偏移。 */
export interface PackedVertexAttribute {
  name: string;
  location: number;
  /** 字节偏移。 */
  offset: number;
  components: number;
  kind: "f32" | "i32" | "u32";
  /** 矩阵的第几列（非矩阵为 0）。 */
  column: number;
}

/** 图层四边形能提供的顶点属性；着色器声明了其它属性时补默认值（多数是 0）。 */
function attributeValue(name: string, vertex: QuadVertex, column: number): number[] {
  if (column > 0) return [];
  switch (name) {
    case "a_Position":
      return vertex.position;
    case "a_TexCoord":
    case "a_TexCoordVec4":
      return vertex.texCoord;
    case "a_Color":
      return [1, 1, 1, 1];
    case "a_Normal":
      return [0, 0, 1];
    case "a_Tangent4":
      return [1, 0, 0, 1];
    default:
      return [];
  }
}

export interface VertexPacking {
  layout: GPUVertexBufferLayout;
  /** 各输入的位置，按 `attributes` 的顺序（即在顶点里的先后）。 */
  attributes: readonly PackedVertexAttribute[];
  /** 按布局把四边形的顶点写成一块交错缓冲。 */
  pack(vertices: readonly QuadVertex[]): ArrayBuffer;
}

/**
 * 一个属性占几个连续 location、每个的格式：矩阵 / 数组按列（元素）展开（`vertexPacking` 与网格的 `meshVertexLayout` 共用）。类型不认识时
 * 为 null（调用方报 `render:attribute:<名>:<类型>`）。
 */
export function attributeColumns(
  attribute: Pick<InterfaceVariable, "type" | "array">,
): { info: AttributeFormat; columns: number } | null {
  const mat = /^mat(\d)$/.exec(attribute.type);
  const info = mat ? ATTRIBUTE_FORMATS[`vec${mat[1]}`] : ATTRIBUTE_FORMATS[attribute.type];
  return info ? { info, columns: (mat ? Number(mat[1]) : 1) * (attribute.array ?? 1) } : null;
}

/**
 * 按 `attributes` 的 name → location 建交错顶点布局；矩阵 / 数组属性按列（元素）展开成连续 location。`stepMode`：翻译结果带
 * `geometry`（几何着色器展开，P4d 步骤 1）时按实例步进（每次几何着色器调用一个实例），其余按顶点。
 */
export function vertexPacking(
  attributes: readonly InterfaceVariable[],
  stepMode: GPUVertexStepMode = "vertex",
): VertexPacking {
  const packed: PackedAttribute[] = [];
  let offset = 0;
  for (const attribute of attributes) {
    const slots = attributeColumns(attribute);
    if (!slots) throw new SceneRenderError([`render:attribute:${attribute.name}:${attribute.type}`]);
    const { info, columns } = slots;
    for (let column = 0; column < columns; column++) {
      packed.push({ name: attribute.name, location: attribute.location + column, offset, info, column });
      offset += info.components * 4;
    }
  }
  const stride = Math.max(4, offset);
  return {
    layout: {
      arrayStride: stride,
      stepMode,
      attributes: packed.map((a) => ({ shaderLocation: a.location, offset: a.offset, format: a.info.format })),
    },
    attributes: packed.map((a) => ({
      name: a.name,
      location: a.location,
      offset: a.offset,
      components: a.info.components,
      kind: a.info.kind,
      column: a.column,
    })),
    pack(vertices) {
      const buffer = new ArrayBuffer(stride * vertices.length);
      const view = new DataView(buffer);
      vertices.forEach((vertex, index) => {
        for (const attribute of packed) {
          const values = attributeValue(attribute.name, vertex, attribute.column);
          for (let k = 0; k < attribute.info.components; k++) {
            const at = index * stride + attribute.offset + k * 4;
            const value = values[k] ?? 0;
            if (attribute.info.kind === "f32") view.setFloat32(at, value, true);
            else if (attribute.info.kind === "i32") view.setInt32(at, value, true);
            else view.setUint32(at, value, true);
          }
        }
      });
      return buffer;
    },
  };
}

/** 一个翻译结果的顶点布局：带 `geometry` 的按实例步进（`vertexPacking`），渲染器、自查与四角探针共用。 */
export function programVertexPacking(result: Pick<TranslateResult, "attributes" | "geometry">): VertexPacking {
  return vertexPacking(result.attributes ?? [], result.geometry ? "instance" : "vertex");
}

/**
 * bind group layout 的条目（纯数据，便于测试）。`visibility` 缺省是 VERTEX | FRAGMENT（`GPUShaderStage` 的位，Node 测试里
 * 没有这个全局）；dev 探针把顶点着色器改写成计算着色器时传 COMPUTE（4）。
 */
export function bindGroupLayoutEntries(program: TranslateResult, visibility = 0x1 | 0x2): GPUBindGroupLayoutEntry[] {
  const entries: GPUBindGroupLayoutEntry[] = [];
  if (program.uniforms?.length) entries.push({ binding: 0, visibility, buffer: { type: "uniform" } });
  for (const texture of program.textures ?? []) {
    const comparison = texture.kind === "2d-comparison";
    entries.push({
      binding: texture.binding,
      visibility,
      texture: {
        sampleType: comparison ? "depth" : "float",
        viewDimension: texture.kind === "3d" ? "3d" : texture.kind === "cube" ? "cube" : "2d",
      },
    });
    entries.push({
      binding: texture.samplerBinding,
      visibility,
      sampler: { type: comparison ? "comparison" : "filtering" },
    });
  }
  return entries;
}

export interface GpuProgram {
  index: number;
  result: TranslateResult;
  vertex: GPUShaderModule;
  fragment: GPUShaderModule;
  bindGroupLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  vertexPacking: VertexPacking;
  textures: readonly TextureBinding[];
  /** uniform 块大小（16 对齐）；没有普通 uniform 时为 0。 */
  uniformSize: number;
  /**
   * A2C 管线用的片元模块与入口（P8 步骤 5，`alphaToCoverageEntry`）：按程序缓存，第一次建 A2C 管线时才建（改写、建模块、检查 Tint 的
   * 编译消息），之后返回同一个 Promise；从不建 A2C 管线的程序一次都不调，着色器模块与改前相同。改写失败报
   * `render:program:<下标>:a2c`，Tint 报 error 时报 `webgpu:shader:<下标>:fragment-a2c:…`。
   */
  alphaToCoverage(): Promise<ShaderEntry>;
}

/** 一个着色器模块里的一个入口。 */
export interface ShaderEntry {
  module: GPUShaderModule;
  entryPoint: string;
}

/** 关掉导数一致性检查（见文件头），与 HLSL 的语义一致。 */
export const WGSL_PRELUDE = "diagnostic(off, derivative_uniformity);\n";
const PRELUDE_LINES = 1;

/** A2C 入口的名字前缀：翻译器自己的名字以 `kb_` 开头（`kb_FragColor`、`kb_sampler_*`），再加一段避开。 */
const A2C_PREFIX = "kb_a2c_";

/** 从 `open` 处的开括号（`(` 或 `{`）找到匹配的闭括号。 */
function matchBracket(source: string, open: number): number {
  const opening = source[open];
  const closing = opening === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opening) depth++;
    else if (source[i] === closing && --depth === 0) return i;
  }
  throw new Error(`片元入口的 ${opening} 不匹配`);
}

/** 按顶层逗号切开（跳过 `<…>` 与 `(…)` 里的逗号），去掉空项。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 一段声明前面的属性（`@location(0)`、`@builtin(frag_depth)`……）与去掉属性后的正文。 */
function takeAttributes(text: string): { attributes: Map<string, string>; rest: string } {
  const attributes = new Map<string, string>();
  const rest = text.replace(/@(\w+)\s*(?:\(([^)]*)\))?\s*/g, (_, name: string, value: string | undefined) => {
    attributes.set(name, (value ?? "").trim());
    return "";
  });
  return { attributes, rest: rest.trim() };
}

/** 位置 0 的输出：带 `@location(0)`、不带 `@builtin`，类型是 vec4<f32>（要取 `.a`）。 */
function isColorOutput(attributes: Map<string, string>, type: string): boolean {
  const compact = type.replace(/\s+/g, "");
  return (
    attributes.get("location") === "0" && !attributes.has("builtin") && (compact === "vec4<f32>" || compact === "vec4f")
  );
}

/**
 * 给翻译出的片元 WGSL 追加 A2C 入口 `kb_a2c_<入口>`（rea-p8-render 第 5 节，p8-REPORT 结论 11）：原入口的逐字副本，每个 `return X;`
 * 换成「X 的位置 0 输出的 alpha 不大于 0.5（含 NaN）就 discard，否则返回 X」。原入口与主体不动。
 *
 * - 返回只认两种（翻译器 naga GLSL 前端的输出，`ignore/p8/s5/dump-entry.txt`）：结构（取带 `@location(0)` 的成员，跳过 `@builtin`），
 *   或直接 `-> @location(0) vec4<f32>`；位置 0 的类型要是 vec4<f32>。
 * - 丢弃条件写成 `!(a > 0.5)`：`p8-a2c` 实测 alpha 0.4995 不画、0.5005 画，对象 alpha 0.5（锐化后最大正好 0.5）一列都没画；NaN 也丢。
 * - 丢弃在入口里、主体（`main_1()`）之后，导数不受影响；WebGPU 的 alpha-to-coverage 只能用在多重采样目标上，WPE 的 `msaa: none`
 *   单采样下 A2C 实测就是这个硬阈值。
 * - 每处 `return` 换成一个块（`{ let kb_a2c_out = X; if … { discard; } return kb_a2c_out; }`），多个 `return` 互不冲突。
 * 返回的 `code` 是原 WGSL 加新入口（不含 `WGSL_PRELUDE`）。结构认不出时抛错（找不到入口、没有位置 0 的 vec4 输出、已经有 `kb_a2c_`
 * 开头的名字、`return` 没带值），说明翻译器输出变了，要重看改写规则。
 */
export function alphaToCoverageEntry(wgsl: string, entryPoint: string): { code: string; entryPoint: string } {
  if (wgsl.includes(A2C_PREFIX)) throw new Error(`片元着色器里已经有 ${A2C_PREFIX} 开头的名字`);
  const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heads = [
    ...wgsl.matchAll(new RegExp(String.raw`@fragment\b(?:\s*@\w+\s*(?:\([^)]*\))?)*\s*fn\s+${escaped}\s*\(`, "g")),
  ];
  if (heads.length !== 1) throw new Error(`找不到片元入口 ${entryPoint}（${heads.length} 处）`);
  const head = heads[0];
  const open = head.index + head[0].length - 1;
  const close = matchBracket(wgsl, open);
  const brace = wgsl.indexOf("{", close);
  if (brace < 0) throw new Error("片元入口没有函数体");
  const between = wgsl.slice(close + 1, brace).trim();
  if (!between.startsWith("->")) throw new Error("片元入口没有返回类型");
  const returns = takeAttributes(between.slice(2));

  // 位置 0 的输出：返回值本身，或返回结构里带 `@location(0)` 的成员
  let alpha: string;
  if (returns.attributes.size) {
    if (!isColorOutput(returns.attributes, returns.rest))
      throw new Error(`片元入口的返回 ${between} 不是位置 0 的 vec4`);
    alpha = `${A2C_PREFIX}out.a`;
  } else {
    if (!/^\w+$/.test(returns.rest)) throw new Error(`读不懂片元入口的返回类型 ${returns.rest}`);
    const struct = new RegExp(String.raw`struct\s+${returns.rest}\s*\{([^}]*)\}`).exec(wgsl);
    if (!struct) throw new Error(`找不到返回结构 ${returns.rest}`);
    const member = splitTopLevel(struct[1])
      .map(takeAttributes)
      .find(({ attributes, rest }) => isColorOutput(attributes, rest.slice(rest.indexOf(":") + 1)));
    if (!member) throw new Error(`返回结构 ${returns.rest} 里没有位置 0 的 vec4 成员`);
    alpha = `${A2C_PREFIX}out.${member.rest.slice(0, member.rest.indexOf(":")).trim()}.a`;
  }

  // 函数体：逐个 `return X;` 换成先判断再返回（`X` 到顶层的 `;` 为止）
  const end = matchBracket(wgsl, brace);
  const body = wgsl.slice(brace, end + 1);
  let rewritten = "";
  let at = 0;
  for (const found of body.matchAll(/\breturn\b/g)) {
    const start = found.index;
    if (start < at) continue;
    let depth = 0;
    let semicolon = -1;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ";" && depth === 0) {
        semicolon = i;
        break;
      }
    }
    if (semicolon < 0) throw new Error("片元入口的 return 没有结束");
    const value = body.slice(start + "return".length, semicolon).trim();
    if (!value) throw new Error("片元入口的 return 没有值");
    rewritten +=
      body.slice(at, start) +
      `{ let ${A2C_PREFIX}out = ${value}; if !(${alpha} > 0.5) { discard; } return ${A2C_PREFIX}out; }`;
    at = semicolon + 1;
  }
  if (!at) throw new Error("片元入口里没有 return");
  rewritten += body.slice(at);

  // 入口头逐字照抄（属性、参数与 IO 属性、返回类型），只换名字
  const name = `${A2C_PREFIX}${entryPoint}`;
  const header = wgsl
    .slice(head.index, brace)
    .replace(new RegExp(String.raw`(\bfn\s+)${escaped}(\s*\()`), `$1${name}$2`);
  return { code: `${wgsl}\n${header}${rewritten}\n`, entryPoint: name };
}

/** 检查 Tint 的编译消息；error 级的整理成原因键抛出，warning 交给调用方记日志。行号扣掉前言。 */
async function checkModule(module: GPUShaderModule, index: number, stage: string, warnings: string[]): Promise<void> {
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  const line = (m: GPUCompilationMessage) => Math.max(0, m.lineNum - PRELUDE_LINES);
  for (const m of info.messages)
    if (m.type !== "error") warnings.push(`程序 ${index} ${stage} ${m.type} ${line(m)}:${m.linePos} ${m.message}`);
  if (errors.length) {
    const first = errors[0];
    throw new SceneRenderError([`webgpu:shader:${index}:${stage}:${line(first)}:${oneLine(first.message)}`]);
  }
}

export async function createProgram(
  device: GPUDevice,
  result: TranslateResult,
  index: number,
  warnings: string[],
): Promise<GpuProgram> {
  if (!result.ok || !result.vertex?.wgsl || !result.fragment?.wgsl)
    throw new SceneRenderError([`render:program:${index}:not-translated`]);
  const vertex = device.createShaderModule({
    label: `scene program ${index} vertex`,
    code: WGSL_PRELUDE + result.vertex.wgsl,
  });
  const fragment = device.createShaderModule({
    label: `scene program ${index} fragment`,
    code: WGSL_PRELUDE + result.fragment.wgsl,
  });
  await Promise.all([
    checkModule(vertex, index, "vertex", warnings),
    checkModule(fragment, index, "fragment", warnings),
  ]);
  const bindGroupLayout = device.createBindGroupLayout({
    label: `scene program ${index}`,
    entries: bindGroupLayoutEntries(result),
  });
  const fragmentWgsl = result.fragment.wgsl;
  let a2c: Promise<ShaderEntry> | null = null;
  return {
    index,
    result,
    vertex,
    fragment,
    bindGroupLayout,
    pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertexPacking: programVertexPacking(result),
    textures: result.textures ?? [],
    uniformSize: result.uniforms?.length ? Math.max(16, Math.ceil((result.uniformBlockSize ?? 0) / 16) * 16) : 0,
    alphaToCoverage: () => (a2c ??= alphaToCoverageModule(device, fragmentWgsl, result, index, warnings)),
  };
}

/** A2C 片元模块（`GpuProgram.alphaToCoverage`）：`WGSL_PRELUDE + 原片元 WGSL + 新入口`，编译消息同原模块检查。 */
async function alphaToCoverageModule(
  device: GPUDevice,
  wgsl: string,
  result: TranslateResult,
  index: number,
  warnings: string[],
): Promise<ShaderEntry> {
  let entry: { code: string; entryPoint: string };
  try {
    entry = alphaToCoverageEntry(wgsl, result.fragment?.entryPoint ?? "main");
  } catch (error) {
    warnings.push(`程序 ${index} 的 A2C 入口改写失败：${error instanceof Error ? error.message : String(error)}`);
    throw new SceneRenderError([`render:program:${index}:a2c`]);
  }
  const module = device.createShaderModule({
    label: `scene program ${index} fragment a2c`,
    code: WGSL_PRELUDE + entry.code,
  });
  await checkModule(module, index, "fragment-a2c", warnings);
  return { module, entryPoint: entry.entryPoint };
}

/**
 * 场景目标深度附件的格式（P5d 步骤 1）：WPE 后备缓冲的深度是 D32F（p5-REPORT「P5d 语义的实测核对」的深度一行）。管线的 `depthStencil` 与
 * render pass 的深度附件都用它（WebGPU 要求两者一致）。
 */
export const SCENE_DEPTH_FORMAT: GPUTextureFormat = "depth32float";

/** 深度状态的两位标记（管线键与标签共用）：测 `t` / 不测 `-`，写 `w` / 不写 `-`。 */
export function depthFlags(depth: { test: boolean; write: boolean }): string {
  return `${depth.test ? "t" : "-"}${depth.write ? "w" : "-"}`;
}

/**
 * `blending` 为 null 时关闭混合（基础 pass 画进合成 RT，B7）。`writeAlpha`：画到场景目标时为 false（见文件头），
 * 画进合成 RT / fbo 时为 true（合成链要带着 alpha 走到上屏那一步）。`topology`：图层四边形是三角形带，
 * 粒子是带索引的三角形列表（每粒子 `0 1 2 0 2 3`，P4a 步骤 4）；rope（几何着色器展开，P4d 步骤 1）是三角形带，每段一个实例，
 * 实例之间本来就断开，和 WPE 每次几何着色器调用输出一条带等价。
 * 模型网格（P5c 步骤 2）另给两项：`vertexBuffers` 是按网格格式建的顶点布局（`render/mesh.ts` 的 `meshVertexLayout`，代替程序自己的
 * `vertexPacking`）；`cull` 为 `"back"` 时剔背面、屏幕上逆时针为正面（D3D11 光栅状态 `CullMode BACK`、`FrontCounterClockwise 1`，
 * rea-p5-mesh 3.4，p5-REPORT `p5c-cull`），标签各多一个 ` mesh`、` cull`。都不给时管线与以前逐项相同。
 * `cull` 自 P5d 步骤 1 起对所有步骤生效（图像层、粒子、文本、形状同一套，`p5d-cull`）。`depth`（P5d 步骤 1）：画进带深度附件的场景目标
 * 时给，`depthStencil` 是 `SCENE_DEPTH_FORMAT`，测深度时 `greater`（反向 Z，清 0，WPE 的 GREATER），不测时 `always`，`write` 开写入；
 * 标签多一个 ` depth:<t|-><w|->`。不给时没有 `depthStencil`，管线与以前逐项相同。
 * `alphaToCoverage`（P8 步骤 5）：为真时片元用程序的 A2C 模块与入口（`GpuProgram.alphaToCoverage`，第一次用到时才建），标签多一个
 * ` a2c`；混合照 `blending`（`alphatocoverage` 在 `blendState` 里是不混合）。为假时与改前逐项相同。
 */
export async function createPipeline(
  device: GPUDevice,
  program: GpuProgram,
  blending: string | null,
  format: GPUTextureFormat,
  writeAlpha = false,
  topology: "triangle-strip" | "triangle-list" = "triangle-strip",
  /** alpha 通道 One / One / Max（P5b 步骤 4，`groupBlendState`）；为 true 时标签多一个 ` max`。 */
  alphaMax = false,
  vertexBuffers?: GPUVertexBufferLayout[],
  cull?: "back",
  depth?: { test: boolean; write: boolean },
  alphaToCoverage = false,
): Promise<GPURenderPipeline> {
  const blend = alphaMax ? groupBlendState(blending) : blending ? blendState(blending) : undefined;
  // A2C 模块的改写或 Tint 检查失败时抛的是自己的原因键，不包成 `webgpu:pipeline`
  const fragment: ShaderEntry = alphaToCoverage
    ? await program.alphaToCoverage()
    : { module: program.fragment, entryPoint: program.result.fragment?.entryPoint ?? "main" };
  try {
    return await device.createRenderPipelineAsync({
      label: `scene program ${program.index} ${blending ?? "opaque"} ${format}${topology === "triangle-list" ? " list" : ""}${alphaMax ? " max" : ""}${vertexBuffers ? " mesh" : ""}${cull ? " cull" : ""}${depth ? ` depth:${depthFlags(depth)}` : ""}${alphaToCoverage ? " a2c" : ""}`,
      layout: program.pipelineLayout,
      vertex: {
        module: program.vertex,
        entryPoint: program.result.vertex?.entryPoint ?? "main",
        buffers: vertexBuffers ?? [program.vertexPacking.layout],
      },
      fragment: {
        module: fragment.module,
        entryPoint: fragment.entryPoint,
        // 0x7 = RED | GREEN | BLUE，0xf 再加 ALPHA
        targets: [{ format, blend, writeMask: writeAlpha ? 0xf : 0x7 }],
      },
      primitive: cull ? { topology, cullMode: cull, frontFace: "ccw" } : { topology, cullMode: "none" },
      ...(depth
        ? {
            depthStencil: {
              format: SCENE_DEPTH_FORMAT,
              depthCompare: depth.test ? "greater" : "always",
              depthWriteEnabled: depth.write,
            },
          }
        : {}),
    });
  } catch (error) {
    throw new SceneRenderError([
      `webgpu:pipeline:${program.index}:${oneLine(error instanceof Error ? error.message : String(error))}`,
    ]);
  }
}
