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

interface AttributeFormat {
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
    const mat = /^mat(\d)$/.exec(attribute.type);
    const info = mat ? ATTRIBUTE_FORMATS[`vec${mat[1]}`] : ATTRIBUTE_FORMATS[attribute.type];
    if (!info) throw new SceneRenderError([`render:attribute:${attribute.name}:${attribute.type}`]);
    const columns = (mat ? Number(mat[1]) : 1) * (attribute.array ?? 1);
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
}

/** 关掉导数一致性检查（见文件头），与 HLSL 的语义一致。 */
export const WGSL_PRELUDE = "diagnostic(off, derivative_uniformity);\n";
const PRELUDE_LINES = 1;

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
  };
}

/**
 * `blending` 为 null 时关闭混合（基础 pass 画进合成 RT，B7）。`writeAlpha`：画到场景目标时为 false（见文件头），
 * 画进合成 RT / fbo 时为 true（合成链要带着 alpha 走到上屏那一步）。`topology`：图层四边形是三角形带，
 * 粒子是带索引的三角形列表（每粒子 `0 1 2 0 2 3`，P4a 步骤 4）；rope（几何着色器展开，P4d 步骤 1）是三角形带，每段一个实例，
 * 实例之间本来就断开，和 WPE 每次几何着色器调用输出一条带等价。
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
): Promise<GPURenderPipeline> {
  const blend = alphaMax ? groupBlendState(blending) : blending ? blendState(blending) : undefined;
  try {
    return await device.createRenderPipelineAsync({
      label: `scene program ${program.index} ${blending ?? "opaque"} ${format}${topology === "triangle-list" ? " list" : ""}${alphaMax ? " max" : ""}`,
      layout: program.pipelineLayout,
      vertex: {
        module: program.vertex,
        entryPoint: program.result.vertex?.entryPoint ?? "main",
        buffers: [program.vertexPacking.layout],
      },
      fragment: {
        module: program.fragment,
        entryPoint: program.result.fragment?.entryPoint ?? "main",
        // 0x7 = RED | GREEN | BLUE，0xf 再加 ALPHA
        targets: [{ format, blend, writeMask: writeAlpha ? 0xf : 0x7 }],
      },
      primitive: { topology, cullMode: "none" },
    });
  } catch (error) {
    throw new SceneRenderError([
      `webgpu:pipeline:${program.index}:${oneLine(error instanceof Error ? error.message : String(error))}`,
    ]);
  }
}
