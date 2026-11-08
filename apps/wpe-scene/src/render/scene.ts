/**
 * 一份 `SceneBundle` 在某个设备上的全部 GPU 资源与每帧编码。
 *
 * 每个可见图层先由 `graph.ts` 排成步骤：直接上屏（P1 路径）、合成链（基础 pass → 合成 RT → effect pass → 上屏）、
 * passthrough、`_rt_FullFrameBuffer` 快照、effect 的 `copy` / `swap`。这里照步骤建纹理、合成 RT、fbo、管线、
 * 每个绘制步骤的顶点 / uniform 缓冲与 bind group，每帧按顺序编码：画到场景目标的步骤合并进同一个 render pass，
 * 画进合成 RT / fbo、拷快照与 copy 时先结束场景 pass，之后再以 `load` 接着画。铺到画布由 `SceneRenderer` 负责。
 *
 * - 快照：`copyTextureToTexture` 把场景目标整张拷进独立纹理，绝不采样正在写的目标（LWE 的 GL 反馈环在 WebGPU 里是校验错误）。
 * - 合成 RT 按尺寸与采样方式跨图层共享（WPE `sc.<W>.<H>…`，p2-REPORT B5）：图层依次画，每层的基础 pass 先整张覆盖。
 *   非 unique 的 fbo 按名字、尺寸、格式、寻址共享，unique 的每层独占（B6）。
 * - `swap` 只改 fbo 名 → 实体的对应（`FboBindings`），跨帧保留；引用 fbo 的 bind group 按当前对应取（缓存）。
 * - 泛光（`bundle.bloom`，P2b）：全部图层之后拷一次快照、跑 `BloomChain`，combine 写回场景目标；没有泛光时不多任何拷贝或 pass。
 *   开关每帧读 `SceneState.bloomEnabled`（A1），关着时和没有链走同一段代码，画面逐字节相同。HDR 在加载时判定，读场景文件、和开关无关（K3），运行中关泛光，目标格式与 `brightness` 都保持 HDR。
 * - HDR：场景目标、快照、合成 RT 都是 `rgba16float`（`*_backbuffer` fbo 编译期已换算），图层颜色乘 `brightness`（B10）。
 * - effect 开关（3c，对齐 WPE，p3-script-REPORT J 节）：分两段。加载时 `prepareVariants` 把可变图层可能用到的程序与管线全部建好
 *   （关着的 effect 也一样）；切换时 `sync` 当场重排图层（`rebuildLayer`），不编译、不等待，返回时新结构已换上。脚本在 `sync` 之前运行，
 *   所以脚本写的开关同一帧就画。加载与切换共用 `buildLayer`，「就地 = 重编译」靠的就是这一点。
 *   每次切换清掉本图层全部带 `clear` 的 fbo，其余内容与 swap 状态保留（J6）。预建失败的图层切换时走整场重编译。
 * - 清屏（L4、L11）：`clearcolor` 与 `clearenabled` 每帧读，脚本写入同帧生效。`clearenabled: false` 是不清屏，不是清成黑色：
 *   WPE 画进两张交替的后备缓冲，第 N 帧的底图是第 N−2 帧的成品，两条链互不相交，所以这里同样用两张场景目标逐帧交替。
 *   泛光的 combine 写当前这张，底图含泛光（L20）。第二张只在清屏可能关掉时建（`SceneGeneral.clearVariable`），别的场景资源不变。
 *   HDR 下 WPE 的后备缓冲存 `lin(x)`，累加因此收敛（L21），我们的目标存 `x`，所以开画之前把底图过一次 `lin`（`linearizeBase`）。
 * - 层级（P4a 步骤 1）：模型矩阵是沿父链累乘的世界矩阵（`worldMatrixOf`），`visible` 沿父链继承（`visibleObjects`），
 *   绘制顺序仍是 `objects` 顺序。写死不可见的祖先下面的图层不建资源（`buildableLayers`）。
 * - 粒子（P4a 步骤 4）：粒子层是计划里的 `particles` 步骤，和图像步骤按 `objects` 顺序混排、画在同一个场景 pass 里。
 *   每个粒子层一个 `ParticleSystem`（种子默认随机，探针可固定；建场景时预热），顶点缓冲按 `maxcount` 分配，索引缓冲全场一份、
 *   只建一次。`update` 按帧时间步进，`encode` 把列写成顶点、`writeBuffer` 后 `drawIndexed`。
 *   MVP = 视图投影 × 对象世界矩阵，`flags & 4` 换透视粒子的视图投影。混合、纹理、材质常量走和图像 pass 相同的路径。
 *   帧表（P4b 步骤 2）：槽 0 的纹理带帧表时 `g_RenderVar1` 取它的 `sheet`，顶点多写 `a_TexCoordVec4C1`，帧数学在着色器里。
 * - 粒子生命周期（P4a 步骤 5）：`instanceoverride` 就地写由 `sync` 交给模拟器（从基值重新乘，不重建缓冲）；不可见（含祖先）
 *   的粒子层不发射，有存活粒子就清空，重新可见不重新预热（C8）；暂停 / 补画帧时间为 0，不步进；粒子缓冲随场景 `destroy`
 *   释放，换场景或重编译时新场景重新预热。
 */
import { HDR_BLOOM_MATERIALS, LDR_BLOOM_MATERIALS } from "../compile/bloom";
import type { TargetKey } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { FBO_FORMATS } from "../compile/tex";
import { pointerScenePoint } from "../particles/controlpoints";
import { SeededRandom, type ParticleROverride } from "../particles/random";
import { ParticleSystem } from "../particles/system";
import { summarizeParticles, type ParticleSummary } from "../particles/track";
import { particleVertexLayout, quadIndices, writeVertices, type ParticleVertexLayout } from "../particles/vertices";
import type { TextureBinding } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { oneLine, SceneRenderError } from "./errors";
import {
  compositeSize,
  FboBindings,
  fboSize,
  planLayer,
  planSignature,
  variantPlans,
  type DrawStep,
  type LayerPlan,
  type ParticleStep,
  type TargetRef,
  type TextureRef,
} from "./graph";
import {
  effectiveVisible,
  everyAncestor,
  eyePosition,
  layerQuad,
  particleViewProjection,
  sceneTargetSize,
  sceneViewProjection,
  worldMatrixOf,
} from "./layout";
import type { Mat4 } from "./math";
import { createPipeline, createProgram, vertexPacking, type GpuProgram } from "./programs";
import type { LayerState, SceneState } from "./state";
import { requiredFeatures, samplerDescriptor, uploadTexture } from "./textures";
import {
  drawUniformValues,
  frameBuiltins,
  layerRefreshNames,
  LIGHT_UNIFORMS,
  particleUniformValues,
  UniformBlock,
  type FrameInput,
  type UniformEntry,
} from "./uniforms";

export { drawMatrices } from "./uniforms";

/** 离屏目标格式：WPE 在 gamma 空间混合，用非 sRGB 格式。合成 RT 在 LDR 下也是它（B5）。 */
export const SCENE_TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";
/** HDR 下的场景目标、快照与合成 RT（A4，J5 抓帧：后备缓冲与合成 RT 都是 RGBA16F）。 */
export const HDR_TARGET_FORMAT: GPUTextureFormat = "rgba16float";

export function sceneTargetFormat(hdr: boolean): GPUTextureFormat {
  return hdr ? HDR_TARGET_FORMAT : SCENE_TARGET_FORMAT;
}

/** 底图逐像素过 `lin`（WPE `passthroughsrgb.frag`，公式不变）：见 `GpuScene.linearizeBase`。 */
const LINEAR_BASE_WGSL = /* wgsl */ `
@group(0) @binding(0) var base: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let value = textureLoad(base, vec2<i32>(position.xy), 0);
  let c = step(vec3<f32>(0.04045), value.rgb);
  let rgb = c * pow((value.rgb + 0.055) / 1.055, vec3<f32>(2.4)) + (1.0 - c) * (value.rgb / 12.92);
  return vec4<f32>(rgb, value.a);
}
`;

/** 每像素字节（显存估算用）。 */
function texelBytes(format: GPUTextureFormat): number {
  if (format === "rgba16float") return 8;
  if (format === "rg16float") return 4;
  if (format === "r16float" || format === "rg8unorm") return 2;
  if (format === "r8unorm") return 1;
  return 4;
}

/** 一张场景目标。 */
interface SceneTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

interface RenderTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

/**
 * 一个图层用到的合成 RT（可能来自共享池）与 fbo 名 → `targets` 下标的对应。
 * 跨单图层重建保留：合成 RT 只增不减，fbo 的 swap 状态不丢。
 */
interface LayerResources {
  composites: RenderTarget[];
  fbos: FboBindings;
}

/** 一个绘制步骤等齐的程序与管线（`prepareLayer`）。 */
interface PreparedDraw {
  program: GpuProgram;
  pipeline: GPURenderPipeline;
}

/** 图层的绘制步骤，或粒子层的绘制（`graph.ts`）：都画一次，共用 draw 的 uniform / bind group / 管线路径。 */
type DrawLike = DrawStep | ParticleStep;

/** 一个粒子层的模拟器与 CPU 侧顶点（P4a 步骤 4）。 */
interface ParticleDraw {
  system: ParticleSystem;
  layout: ParticleVertexLayout;
  /** CPU 侧交错顶点，按 `maxcount` 个粒子（每个 4 个顶点）分配。 */
  vertices: Float32Array;
  /** 上次写进缓冲的粒子数，`drawIndexed` 画 6 倍的索引。 */
  count: number;
  /** 步进过、还没写成顶点：`encode` 里写 `vertices` 并 `writeBuffer`。 */
  stale: boolean;
  /**
   * 加载时对象的世界矩阵（`worldMatrixOf`，控制点的输入，P4c 步骤 1）：`stepParticles` 没给 `state`（dev 探针按 dt 回放）时
   * 每帧用它。
   */
  world: Mat4;
}

/** 一个粒子层最近若干帧的开销样本（dev 探针，`GpuScene.profileParticles`）。 */
interface ParticleTiming {
  /** `ParticleSystem.step` 的用时（毫秒）。 */
  simulate: number[];
  /** `writeVertices` 的用时（毫秒）。 */
  vertices: number[];
  /** `queue.writeBuffer` 的用时（毫秒，只是排队，不含 GPU 拷贝）。 */
  upload: number[];
  /** 步进后的存活数。 */
  alive: number[];
}

/** 粒子开销记录每层最多留的帧数。 */
const PARTICLE_TIMING_FRAMES = 600;

function recordSample(list: number[], value: number): void {
  list.push(value);
  if (list.length > PARTICLE_TIMING_FRAMES) list.splice(0, list.length - PARTICLE_TIMING_FRAMES);
}

/** 一组样本的均值、p95 与最大值（保留两位小数）；没有样本时都是 0。 */
export function timingStats(samples: readonly number[]): { mean: number; p95: number; max: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!samples.length) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    mean: round(mean),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    max: round(sorted[sorted.length - 1]),
  };
}

/** 一个粒子层的开销统计（`GpuScene.particleProfile`）。 */
export interface ParticleProfile {
  object: number;
  name: string;
  capacity: number;
  /** 记录到的模拟帧数（最多 600）。 */
  frames: number;
  alive: ReturnType<typeof timingStats>;
  simulateMs: ReturnType<typeof timingStats>;
  verticesMs: ReturnType<typeof timingStats>;
  uploadMs: ReturnType<typeof timingStats>;
}

/** 粒子层的运行时选项（`GpuScene.build`）。 */
export interface ParticleOptions {
  /** operator 遍数（`particlePasses(maxFps)`）；缺省 1。 */
  passes?: 1 | 2;
  /** 随机种子：第 i 个粒子层（`bundle.layers` 里带 `particle` 的，按顺序）用 `seed + i`，同 `particles/track.ts`。缺省随机。 */
  seed?: number;
  /**
   * 按粒子层（`objects` 下标）给出生时 `R` 的替换（`ParticleROverride`），每建一个模拟器调一次。只给 dev 探针用（`renderFrame` 的
   * `particles.random`，替换的实现在探针侧），产品路径不传。
   */
  rOverride?: (object: number) => ParticleROverride | undefined;
  /**
   * 加载时刻光标下的场景纹理坐标（`render/layout.ts` 的 `sceneCursor`，P4c 步骤 2），加载时的控制点更新和预热按它算指针的
   * 跟随点（WPE 加载时也读当时的指针，rea-p4c-sim.md 1.3、1.7）。缺省场景中心 `(0.5, 0.5)`。
   */
  cursor?: readonly [number, number];
}

interface Draw {
  label: string;
  step: DrawLike;
  /** 粒子层的模拟器与顶点；图像层为 null。 */
  particles: ParticleDraw | null;
  /** 本 draw 的程序（dev 探针改写顶点着色器用）。 */
  program: GpuProgram;
  /** 所属图层（`objects` 下标与 bundle 里的图层，就地刷新用）。 */
  object: number;
  layer: SceneLayer;
  /** 本 pass 的稳定键（材质常量绑定按它找回 draw）。 */
  passKey: TargetKey;
  resources: LayerResources;
  pipeline: GPURenderPipeline;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer | null;
  block: UniformBlock | null;
  /** 需要每帧刷新的内置 uniform 名（被材质值覆盖的不刷）。 */
  frameNames: string[];
  /** 按槽位的纹理尺寸（就地刷新时复用，纹理不随属性变化）。 */
  textureSizes: readonly (TextureSize | undefined)[];
  /** 静态 uniform 被就地改过：下一次 `update` 要整块重写。 */
  dirty: boolean;
  /** 不引用 fbo 时建一次；引用 fbo 时按当前 swap 状态取（`bindGroups` 缓存）。 */
  bindGroup: GPUBindGroup | null;
  bindGroups: Map<string, GPUBindGroup>;
  entries: (resolveFbo: (effect: number, name: string) => RenderTarget) => GPUBindGroupEntry[];
  layout: GPUBindGroupLayout;
}

/** 纹理尺寸（与 `render/uniforms.ts` 的 `TextureSize` 同形）。 */
type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">;

/** 一个图层的全部步骤与 draw：不可见时整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
interface LayerRuntime {
  object: number;
  layer: SceneLayer;
  ops: Op[];
  draws: Draw[];
  resources: LayerResources;
  /** 当前 `ops` 的计划签名（`planSignature`）；重建时比较，相同就不动。 */
  signature: string;
}

type Op =
  | { kind: "draw"; draw: Draw }
  | { kind: "snapshot" }
  | { kind: "copy"; resources: LayerResources; effect: number; source: TextureRef; target: TargetRef }
  | { kind: "swap"; resources: LayerResources; effect: number; source: string; target: string };

/**
 * 决定一条管线的五项：WebGPU 的管线绑定了混合、目标格式、写掩码与图元拓扑（WPE 的 D3D11 着色器不绑），同一个程序要按它们
 * 各建一份。`list`：粒子的带索引三角形列表；图层四边形是三角形带。
 */
export interface PipelineSpec {
  program: number;
  blending: string | null;
  format: GPUTextureFormat;
  alpha: boolean;
  list: boolean;
}

export function pipelineKey({ program, blending, format, alpha, list }: PipelineSpec): string {
  return `${program}|${blending}|${format}|${alpha}${list ? "|list" : ""}`;
}

/** 绘制步骤的管线：合成 RT 与场景目标同格式，只有 fbo 有自己的格式；画到场景目标时不写 alpha。粒子只画到场景目标。 */
export function stepPipeline(
  step: DrawLike,
  format: GPUTextureFormat,
  fboFormat: (effect: number, name: string) => GPUTextureFormat,
): PipelineSpec {
  const { pass, blending, target } = step;
  return {
    program: pass.program!,
    blending,
    format: target.kind === "fbo" ? fboFormat(target.effect, target.name) : format,
    alpha: target.kind !== "scene",
    list: step.kind === "particles",
  };
}

/** 粒子程序的顶点输入能不能由 `writeVertices` 写（`particles/vertices.ts`）。 */
function particleAttributeProblems(program: SceneBundle["programs"][number]): string[] {
  try {
    return particleVertexLayout(vertexPacking(program.attributes ?? [])).problems;
  } catch (error) {
    return error instanceof SceneRenderError ? error.reasons : [`render:particle-attribute:${String(error)}`];
  }
}

/** 一份计划里渲染器画不了的项（加载时的自查与 `prepareVariants` 共用）。 */
function planProblems(plan: LayerPlan, bundle: SceneBundle): string[] {
  const problems = [...plan.reasons];
  for (const step of plan.steps) {
    if (step.kind !== "draw" && step.kind !== "particles") continue;
    const program = step.pass.program === null ? undefined : bundle.programs[step.pass.program];
    if (!program) problems.push("render:no-program");
    else if (step.kind === "particles") problems.push(...particleAttributeProblems(program));
    for (const ref of Object.values(step.inputs))
      if (ref.kind === "texture" && !bundle.textures[ref.index]?.mips.length)
        problems.push(`render:texture-missing:${ref.index}`);
  }
  return problems;
}

/** 计划要不要 `_rt_FullFrameBuffer`。 */
function wantsSnapshot(plan: LayerPlan): boolean {
  return plan.steps.some(
    (step) =>
      step.kind === "snapshot" ||
      ((step.kind === "draw" || step.kind === "particles") &&
        Object.values(step.inputs).some((ref) => ref.kind === "framebuffer")),
  );
}

/** 渲染器能画的 bundle 结构；不能画的整理成原因键（编译期能力表之外的渲染器自查）。 */
export function checkRenderable(
  bundle: SceneBundle,
  features: ReadonlySet<string>,
  options: { ignoreUnsupported?: boolean } = {},
): string[] {
  const reasons = new Set<string>(options.ignoreUnsupported ? [] : bundle.unsupported);
  for (const feature of requiredFeatures(bundle.textures))
    if (!features.has(feature))
      reasons.add(feature === "texture-compression-bc" ? "webgpu:no-bc" : `webgpu:${feature}`);
  if (bundle.bloom)
    for (const name of Object.keys(bundle.bloom.hdr ? HDR_BLOOM_MATERIALS : LDR_BLOOM_MATERIALS)) {
      const pass = bundle.bloom.passes[name as keyof typeof bundle.bloom.passes];
      if (!pass || pass.program === null || !bundle.programs[pass.program]) reasons.add(`render:bloom:${name}`);
    }
  for (const layer of buildableLayers(bundle))
    for (const reason of planProblems(planLayer(layer, bundle.textures), bundle)) reasons.add(reason);
  return [...reasons];
}

/**
 * 要建 GPU 资源的图层（有 pass 的，含粒子材质的 pass，P4a 步骤 4）：自身和每个祖先都可能可见，即当前可见、`visible`
 * 绑了用户属性，或场景带脚本。`visibleBound` 的图层当前可能不可见，但随时可能显示，同样要能画（P3a）。写死不可见的分组
 * 下面的子孙永远画不出来（`visible` 沿父链继承，P4a 步骤 1）：不建资源，它们的问题也不让整场退回。
 */
export function buildableLayers(bundle: Pick<SceneBundle, "layers" | "scripts">): SceneLayer[] {
  const scripted = bundle.scripts.list.length > 0;
  const byObject = new Map(bundle.layers.map((layer) => [layer.object, layer]));
  return bundle.layers.filter(
    (layer) =>
      (layer.passes.length > 0 || (layer.particle?.passes.length ?? 0) > 0) &&
      everyAncestor(layer.object, byObject, (item) => item.visible || item.visibleBound || scripted),
  );
}

/**
 * 要上传的纹理：除了只被「关着且带不支持项」的 effect 用到的，其余全部上传。这种 effect 打开时整场重编译，用不到这份
 * GPU 纹理；它的纹理可能没有 mip 或格式不认识，上传会抛错，让本来能画的场景退回（3c）。关着的 effect 编译到一半出错时
 * 步骤不留，已解析的纹理同样不被引用。没有可变 effect 的场景，bundle 里的纹理都有 pass 引用，结果是全集。
 * 粒子材质的纹理同样上传（P4a 步骤 4）。
 */
export function uploadableTextures(bundle: Pick<SceneBundle, "layers">): Set<number> {
  const used = new Set<number>();
  const add = (pass: ScenePass) => {
    for (const index of Object.values(pass.textures)) used.add(index);
  };
  for (const layer of bundle.layers) {
    layer.passes.forEach(add);
    layer.particle?.passes.forEach(add);
    if (layer.passthrough) add(layer.passthrough);
    for (const effect of layer.effects) {
      if (!effect.enabled && effect.unsupported.length) continue;
      for (const step of effect.steps) if (step.kind === "draw") add(step.pass);
    }
  }
  return used;
}

/**
 * 本帧要执行的图层（`objects` 下标）：不可见图层整段跳过（含它的快照、copy 与 swap）。可见性沿父链继承：
 * 自身和所有祖先都可见才画（P4a 步骤 1），祖先按 `state.layers` 查，不要求祖先有 GPU 资源。
 * 纯函数，单测核对可见性的跳过规则（P3a）。
 */
export function visibleObjects(layers: readonly { object: number }[], state: SceneState): number[] {
  return layers.filter((layer) => effectiveVisible(layer.object, state.layers)).map((layer) => layer.object);
}

export class GpuScene {
  private readonly owned = new Set<{ destroy(): void }>();
  /** 按图层分组的步骤：不可见图层整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
  private readonly layers: LayerRuntime[] = [];
  private readonly draws = new Set<Draw>();
  private readonly drawsByLayer = new Map<number, Draw[]>();
  private readonly drawsByPass = new Map<TargetKey, Draw[]>();
  /** fbo 实体（`FboBindings` 的下标指向这里）。 */
  private readonly targets: RenderTarget[] = [];
  /** 场景目标：`current` 是这一帧画的那张，`alternate` 只在清屏可能关掉时有（L11）。 */
  private current: SceneTarget | null = null;
  private alternate: SceneTarget | null = null;
  /** `linearizeBase` 的管线，第一次用时才建。 */
  private linearBase: { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup } | null = null;
  private snapshot: RenderTarget | null = null;
  width = 0;
  height = 0;
  /** 场景目标、快照与合成 RT 的格式（HDR 为 `rgba16float`）。 */
  format: GPUTextureFormat = SCENE_TARGET_FORMAT;
  /** 渲染目标类资源（场景目标、快照、合成 RT、fbo、泛光 RT）的显存估算，字节；不含场景纹理。 */
  targetBytes = 0;
  /** 真正重建图层的次数与用时（毫秒）：计划签名没变的切换不算。dev 探针读。 */
  readonly rebuildStats = { count: 0, totalMs: 0, maxMs: 0 };
  private bloom: BloomChain | null = null;
  /** 就地刷新 uniform 时复用的场景级常量（建场景时算一次）。 */
  private viewProjection: Float32Array = new Float32Array(16);
  /** 透视粒子（`flags & 4`）的视图投影（`particleViewProjection`）。 */
  private perspectiveViewProjection: Float32Array = new Float32Array(16);
  /** 粒子层全场共用的索引缓冲（`quadIndices`），按最大的 `maxcount` 建一次；没有粒子层时为 null。 */
  private particleIndices: { buffer: GPUBuffer; format: GPUIndexFormat; particles: number } | null = null;
  /** 粒子层（`objects` 下标）→ 第几个粒子层（`bundle.layers` 里带 `particle` 的顺序），定种子用。 */
  private readonly particleOrdinals = new Map<number, number>();
  private readonly particlePasses: 1 | 2;
  private readonly particleSeed: number;
  private readonly particleROverride: ParticleOptions["rOverride"];
  /**
   * 最近的光标下场景纹理坐标（P4c 步骤 2）：建场景时取 `ParticleOptions.cursor`，之后每次 `stepParticles` 更新。新建粒子系统
   * 预热时用它。现在只有加载时会新建：粒子层编译期没有 effect、`planParticleLayer` 也不看 effect，计划签名不变，不会单独重建；
   * 以后能单独重建时，新系统按最近的指针预热（`render/particles.test.ts` 用内部字段强制重建守着这一点）。
   */
  private particleCursor: readonly [number, number];
  /** 粒子开销记录（dev 探针，`profileParticles` 打开时才有）。 */
  private particleTimings: Map<Draw, ParticleTiming> | null = null;
  /** HDR 下图层颜色乘 `brightness`（B10），就地刷新时按状态里的 brightness 现算。 */
  private hdr = false;
  private eye: readonly number[] = [];
  /** 上传后的场景纹理，下标同 `bundle.textures`；没上传的为 null（`uploadableTextures`）。 */
  private textures: (GPUTexture | null)[] = [];
  private dummies!: ReturnType<GpuScene["createDummies"]>;
  private readonly samplers = new Map<string, GPUSampler>();
  private readonly programs = new Map<number, Promise<GpuProgram>>();
  private readonly pipelines = new Map<string, Promise<GPURenderPipeline>>();
  /** 已建好的程序与管线：切换时同步取（`preparedOf`）。 */
  private readonly readyPrograms = new Map<number, GpuProgram>();
  private readonly readyPipelines = new Map<string, GPURenderPipeline>();
  /** 合成 RT 的共享池，键是尺寸与采样方式；重建时不够也从这里补。 */
  private readonly compositePool = new Map<string, RenderTarget[]>();

  private constructor(
    private readonly device: GPUDevice,
    private readonly bundle: SceneBundle,
    private readonly warnings: string[],
    particles: ParticleOptions,
  ) {
    this.particlePasses = particles.passes ?? 1;
    this.particleSeed = particles.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.particleROverride = particles.rOverride;
    this.particleCursor = particles.cursor ?? [0.5, 0.5];
    let ordinal = 0;
    for (const layer of bundle.layers) if (layer.particle) this.particleOrdinals.set(layer.object, ordinal++);
  }

  /** 这一帧画的那张场景目标（dev 探针同步读回用）。有两张时 `encode` 开头才换，要在它之后取。 */
  get targetTexture(): GPUTexture | null {
    return this.current?.texture ?? null;
  }

  /** 这一帧画的那张场景目标的视图，取用时机同 `targetTexture`。 */
  get targetView(): GPUTextureView | null {
    return this.current?.view ?? null;
  }

  /**
   * 建全部资源。失败时已建的资源都会释放，抛 `SceneRenderError`；`warnings` 收集 Tint 的非错误消息。
   * `state` 是本次场景的 CPU 侧状态（`render/state.ts`），建 draw 时按它的初始值写 uniform；
   * `ignoreUnsupported`：dev 强制渲染（D4），不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。
   * `particles`：粒子的遍数与种子（`ParticleOptions`）；粒子系统建好就预热。
   */
  static async build(
    device: GPUDevice,
    bundle: SceneBundle,
    state: SceneState,
    features: ReadonlySet<string>,
    warnings: string[],
    options: { ignoreUnsupported?: boolean; particles?: ParticleOptions } = {},
  ): Promise<GpuScene> {
    const reasons = checkRenderable(bundle, features, options);
    if (reasons.length) throw new SceneRenderError(reasons);
    const scene = new GpuScene(device, bundle, warnings, options.particles ?? {});
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let failure: unknown = null;
    try {
      await scene.populate(state);
    } catch (error) {
      failure = error;
    }
    const validation = await device.popErrorScope();
    const memory = await device.popErrorScope();
    if (!failure && validation) failure = new SceneRenderError([`webgpu:validation:${oneLine(validation.message)}`]);
    if (!failure && memory) failure = new SceneRenderError([`webgpu:out-of-memory:${oneLine(memory.message)}`]);
    if (failure) {
      scene.destroy();
      throw failure instanceof SceneRenderError
        ? failure
        : new SceneRenderError([`webgpu:build:${oneLine(String(failure))}`]);
    }
    // 必须在上面的错误作用域之外：`createShaderModule` 遇到坏 WGSL 会报校验错误，留在里面会让整场失败
    await scene.prepareVariants(state);
    return scene;
  }

  private own<T extends { destroy(): void }>(resource: T): T {
    this.owned.add(resource);
    return resource;
  }

  /** 提前释放一个资源（换下的 draw 的缓冲），开关多少次都不累积。 */
  private release(resource: { destroy(): void }): void {
    this.owned.delete(resource);
    resource.destroy();
  }

  private createSceneTarget(label: string, extraUsage = 0): SceneTarget {
    const { width, height, format } = this;
    const texture = this.own(
      this.device.createTexture({
        label,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | extraUsage,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    return { texture, view: texture.createView() };
  }

  private createTarget(
    label: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampler: GPUSampler,
  ): RenderTarget {
    const texture = this.own(
      this.device.createTexture({
        label,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    return { texture, view: texture.createView(), width, height, format, sampler };
  }

  private sampler(descriptor: GPUSamplerDescriptor): GPUSampler {
    const key = JSON.stringify(descriptor);
    let found = this.samplers.get(key);
    if (!found) this.samplers.set(key, (found = this.device.createSampler(descriptor)));
    return found;
  }

  private samplerFor(texture: SceneTexture): GPUSampler {
    return this.sampler(samplerDescriptor(texture, texture.mips.length > 1));
  }

  private pipelineFor(
    program: GpuProgram,
    blending: string | null,
    format: GPUTextureFormat,
    alpha: boolean,
    list = false,
  ): Promise<GPURenderPipeline> {
    const key = pipelineKey({ program: program.index, blending, format, alpha, list });
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const topology = list ? "triangle-list" : "triangle-strip";
      pipeline = createPipeline(this.device, program, blending, format, alpha, topology).then((ready) => {
        this.readyPipelines.set(key, ready);
        return ready;
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** 用到才建，只在加载时走到。失败抛错，由调用方决定退回还是冻结图层。 */
  private ensureProgram(index: number): Promise<GpuProgram> {
    let program = this.programs.get(index);
    if (!program) {
      program = createProgram(this.device, this.bundle.programs[index], index, this.warnings).then((ready) => {
        this.readyPrograms.set(index, ready);
        return ready;
      });
      this.programs.set(index, program);
    }
    return program;
  }

  /** `_rt_FullFrameBuffer`：有图层要读、或要跑泛光链才建（两者共用一张，泛光在全部图层之后再拷一次）。 */
  private ensureSnapshot(): void {
    if (this.snapshot) return;
    const { width, height, format } = this;
    const texture = this.own(
      this.device.createTexture({
        label: "_rt_FullFrameBuffer",
        size: { width, height },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    this.snapshot = {
      texture,
      view: texture.createView(),
      width,
      height,
      format,
      sampler: this.sampler({ magFilter: "linear", minFilter: "linear" }),
    };
  }

  /** 基础材质槽 0 的纹理：合成 RT 的尺寸与采样都跟随它。粒子层没有基础材质，为 undefined。 */
  private baseTexture(layer: SceneLayer): SceneTexture | undefined {
    const base = layer.passes[0]?.textures[0];
    return base === undefined ? undefined : this.bundle.textures[base];
  }

  /** 本图层的合成 RT 至少 `plan.composite.count` 张，不够就从共享池补。 */
  private ensureComposites(runtime: LayerRuntime, plan: LayerPlan): void {
    if (!plan.composite) return;
    const { width, height, count } = plan.composite;
    const baseTexture = this.baseTexture(runtime.layer);
    // 合成 RT 的采样跟随基础纹理（WPE 用图层的 nointerpolation / clampuvs，LWE 用基础纹理的 flags）
    const clamp = baseTexture ? baseTexture.clampUVs : true;
    const nearest = baseTexture?.noInterpolation ?? false;
    const key = `${width}x${height}|${clamp}|${nearest}`;
    const pool = this.compositePool.get(key) ?? [];
    this.compositePool.set(key, pool);
    const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
    const filter: GPUFilterMode = nearest ? "nearest" : "linear";
    while (pool.length < count)
      pool.push(
        this.createTarget(
          `composite ${key} #${pool.length}`,
          width,
          height,
          this.format,
          this.sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
        ),
      );
    const { composites } = runtime.resources;
    composites.push(...pool.slice(composites.length, count));
  }

  /** 这个图层在当前开关下的计划：`planLayer` 的回调给 `layer.effects` 下标，状态按 scene.json 坐标（`source`）存。 */
  private planOf(layer: SceneLayer, state: SceneState): LayerPlan {
    return planLayer(layer, this.bundle.textures, (e) => state.effectEnabled(layer.object, layer.effects[e].source));
  }

  private pipelineOf(step: DrawLike, resources: LayerResources): PipelineSpec {
    return stepPipeline(step, this.format, (effect, name) => this.targets[resources.fbos.resolve(effect, name)].format);
  }

  /** 等齐一份计划要用的程序与管线，之后 `buildLayer` 就是同步的。 */
  private async prepareLayer(plan: LayerPlan, resources: LayerResources): Promise<Map<DrawLike, PreparedDraw>> {
    const prepared = new Map<DrawLike, PreparedDraw>();
    await Promise.all(
      plan.steps.map(async (step) => {
        if (step.kind !== "draw" && step.kind !== "particles") return;
        const program = await this.ensureProgram(step.pass.program!);
        const { blending, format, alpha, list } = this.pipelineOf(step, resources);
        prepared.set(step, { program, pipeline: await this.pipelineFor(program, blending, format, alpha, list) });
      }),
    );
    return prepared;
  }

  /** 从就绪表同步取一份计划的程序与管线。`prepareVariants` 都备好了，缺了说明枚举漏了。 */
  private preparedOf(plan: LayerPlan, resources: LayerResources): Map<DrawLike, PreparedDraw> {
    const prepared = new Map<DrawLike, PreparedDraw>();
    for (const step of plan.steps) {
      if (step.kind !== "draw" && step.kind !== "particles") continue;
      const spec = this.pipelineOf(step, resources);
      const program = this.readyPrograms.get(spec.program);
      const pipeline = this.readyPipelines.get(pipelineKey(spec));
      if (!program || !pipeline) throw new SceneRenderError(["render:variant-missing"]);
      prepared.set(step, { program, pipeline });
    }
    return prepared;
  }

  /** 关着的 effect 也在加载时备好（WPE 同样）。逐图层进行，失败不影响当前画面，这一层之后走整场重编译。 */
  private async prepareVariants(state: SceneState): Promise<void> {
    for (const runtime of this.layers) {
      const plans = variantPlans(runtime.layer, this.bundle.textures);
      if (!plans.length) continue;
      this.device.pushErrorScope("out-of-memory");
      this.device.pushErrorScope("validation");
      let failure: unknown = null;
      try {
        for (const plan of plans) {
          const problems = planProblems(plan, this.bundle);
          if (problems.length) throw new SceneRenderError(problems);
          this.ensureComposites(runtime, plan);
          if (wantsSnapshot(plan)) this.ensureSnapshot();
          this.checkPlanOps(plan, runtime);
          await this.prepareLayer(plan, runtime.resources);
        }
      } catch (error) {
        failure = error;
      }
      const validation = await this.device.popErrorScope();
      const memory = await this.device.popErrorScope();
      const error = validation ?? memory;
      if (failure || error) {
        state.freezeLayer(runtime.object);
        this.warnings.push(
          `图层 ${runtime.object} 的可变 effect 备不好，切换时整场重新加载：${String(failure ?? error!.message)}`,
        );
      }
    }
  }

  /** copy / swap 的检查：切换时不能再失败，所以 `prepareVariants` 对每份计划先过一遍。 */
  private checkPlanOps(plan: LayerPlan, { layer, resources }: LayerRuntime): void {
    for (const step of plan.steps) {
      if (step.kind === "swap") {
        const a = this.targets[resources.fbos.resolve(step.effect, step.source)];
        const b = this.targets[resources.fbos.resolve(step.effect, step.target)];
        if (a.format !== b.format || a.width !== b.width || a.height !== b.height)
          throw new SceneRenderError([`render:swap-mismatch:${step.source}:${step.target}`]);
      } else if (step.kind === "copy") {
        const source = this.resolveTexture(step.source, resources);
        const target = this.resolveTarget(step.target, resources);
        if (!source || !target || source.format !== target.format)
          throw new SceneRenderError([`render:copy-format:${layer.name}`]);
      }
    }
  }

  /**
   * 照计划生成 op 与 draw。全程同步：新 draw 的 uniform 按这一刻的状态写。`worlds` 是这一刻状态下的世界矩阵缓存
   * （`worldMatrixOf`），由调用方按一次状态快照建一份。
   */
  private buildLayer(
    runtime: LayerRuntime,
    plan: LayerPlan,
    prepared: ReadonlyMap<DrawLike, PreparedDraw>,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): { ops: Op[]; draws: Draw[] } {
    const { layer, resources } = runtime;
    this.ensureComposites(runtime, plan);
    if (wantsSnapshot(plan)) this.ensureSnapshot();
    this.checkPlanOps(plan, runtime);
    const ops: Op[] = [];
    const draws: Draw[] = [];
    for (const step of plan.steps) {
      if (step.kind === "snapshot") ops.push({ kind: "snapshot" });
      else if (step.kind === "swap")
        ops.push({ kind: "swap", resources, effect: step.effect, source: step.source, target: step.target });
      else if (step.kind === "copy")
        ops.push({ kind: "copy", resources, effect: step.effect, source: step.source, target: step.target });
      else {
        const draw = this.createDraw(layer, step, resources, prepared.get(step)!, state, worlds);
        ops.push({ kind: "draw", draw });
        draws.push(draw);
      }
    }
    return { ops, draws };
  }

  /** 把建好的 op 与 draw 接进图层和索引。 */
  private install(runtime: LayerRuntime, built: { ops: Op[]; draws: Draw[] }): void {
    runtime.ops = built.ops;
    runtime.draws = built.draws;
    this.drawsByLayer.set(runtime.object, built.draws);
    for (const draw of built.draws) {
      this.draws.add(draw);
      const byPass = this.drawsByPass.get(draw.passKey);
      if (byPass) byPass.push(draw);
      else this.drawsByPass.set(draw.passKey, [draw]);
    }
  }

  private async populate(state: SceneState): Promise<void> {
    const { device, bundle } = this;
    const { general } = bundle;
    const [width, height] = sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D);
    const hdr = (this.hdr = general.postprocess.hdr);
    const format = (this.format = sceneTargetFormat(hdr));
    this.width = width;
    this.height = height;
    this.eye = eyePosition(general);
    this.current = this.createSceneTarget("scene target");
    // 两张都是空的：不清屏时初始底色就是黑，`clearcolor` 不出现（L11）
    if (general.clearVariable) this.alternate = this.createAlternateTarget();

    const uploadable = uploadableTextures(bundle);
    this.textures = bundle.textures.map((texture, index) =>
      uploadable.has(index) ? this.own(uploadTexture(device, texture)) : null,
    );
    this.dummies = this.createDummies();

    const built = buildableLayers(bundle);
    const plans = built.map((layer) => this.planOf(layer, state));

    // 程序：全部建完再汇总失败，Tint 报告一次列全
    const used = new Set<number>();
    for (const plan of plans)
      for (const step of plan.steps)
        if ((step.kind === "draw" || step.kind === "particles") && step.pass.program !== null)
          used.add(step.pass.program);
    for (const pass of Object.values(bundle.bloom?.passes ?? {}))
      if (pass?.program !== null && pass?.program !== undefined) used.add(pass.program);
    const settled = await Promise.allSettled([...used].map((index) => this.ensureProgram(index)));
    const failed = settled.flatMap((result) =>
      result.status === "rejected"
        ? result.reason instanceof SceneRenderError
          ? result.reason.reasons
          : [`webgpu:shader:${oneLine(String(result.reason))}`]
        : [],
    );
    if (failed.length) throw new SceneRenderError(failed);
    const programs = new Map<number, GpuProgram>();
    for (const result of settled) if (result.status === "fulfilled") programs.set(result.value.index, result.value);

    const fboPool = new Map<string, number>();
    const setup = device.createCommandEncoder({ label: "scene setup" });
    this.viewProjection = sceneViewProjection(general);
    this.perspectiveViewProjection = particleViewProjection(general);
    // 粒子的索引缓冲：全场一份，按最大的 maxcount 建
    const particleCapacity = plans.reduce(
      (max, plan, index) =>
        plan.steps.some((step) => step.kind === "particles")
          ? Math.max(max, built[index].particle?.maxcount ?? 0)
          : max,
      -1,
    );
    if (particleCapacity >= 0) this.createParticleIndices(particleCapacity);

    const runtimes = plans.map((plan, index) => {
      const layer = built[index];
      // fbo 一律按真实合成尺寸：全部 effect 关着时也是，打开时不用重建
      const size = compositeSize(layer, this.baseTexture(layer));
      const maps = layer.effects.map(
        (effect) =>
          new Map(
            effect.fbos.map((fbo) => {
              const [fw, fh] = fboSize(fbo, size);
              const fboFormat = (FBO_FORMATS[fbo.format]?.gpu ?? "rgba8unorm") as GPUTextureFormat;
              const key = fbo.unique
                ? `unique|${layer.id}|${effect.id}|${fbo.name}`
                : `${fbo.name}|${fw}x${fh}|${fboFormat}|${fbo.repeat}`;
              let id = fboPool.get(key);
              if (id === undefined) {
                const address: GPUAddressMode = fbo.repeat ? "repeat" : "clamp-to-edge";
                const target = this.createTarget(
                  `fbo ${key}`,
                  fw,
                  fh,
                  fboFormat,
                  this.sampler({
                    addressModeU: address,
                    addressModeV: address,
                    magFilter: "linear",
                    minFilter: "linear",
                  }),
                );
                id = this.targets.length;
                this.targets.push(target);
                fboPool.set(key, id);
                // 创建后清成 `clear` 色；没写时 WebGPU 纹理本来就是全 0
                if (fbo.clear) this.clearTarget(setup, target, fbo.clear, `clear ${key}`);
              }
              return [fbo.name, id] as const;
            }),
          ),
      );
      const runtime: LayerRuntime = {
        object: layer.object,
        layer,
        ops: [],
        draws: [],
        resources: { composites: [], fbos: new FboBindings(maps) },
        signature: planSignature(plan),
      };
      this.layers.push(runtime);
      return runtime;
    });
    const prepared = await Promise.all(plans.map((plan, index) => this.prepareLayer(plan, runtimes[index].resources)));
    // 泛光：全部图层之后（A1 / A3）
    if (bundle.bloom) {
      this.ensureSnapshot();
      const chain = await BloomChain.create({
        device,
        bloom: bundle.bloom,
        params: general.bloom,
        programs,
        format,
        width,
        height,
        source: this.snapshot!.view,
        pipelineFor: (program, blending, target) => this.pipelineFor(program, blending, target, false),
        own: (resource) => this.own(resource),
      });
      this.bloom = chain;
      this.targetBytes += chain.bytes;
    }
    // 世界矩阵按这一刻的状态算，全部图层共用一份缓存
    const worlds = new Map<number, Mat4>();
    runtimes.forEach((runtime, index) =>
      this.install(runtime, this.buildLayer(runtime, plans[index], prepared[index], state, worlds)),
    );
    device.queue.submit([setup.finish()]);
  }

  private clearTarget(encoder: GPUCommandEncoder, target: RenderTarget, color: readonly number[], label: string): void {
    const [r, g, b, a] = color;
    encoder
      .beginRenderPass({
        label,
        colorAttachments: [{ view: target.view, clearValue: { r, g, b, a }, loadOp: "clear", storeOp: "store" }],
      })
      .end();
  }

  /** 泛光链（dev 探针用）；没有泛光时为 null。 */
  get bloomChain(): BloomChain | null {
    return this.bloom;
  }

  /** 着色器声明了、材质没绑的槽位用的占位纹理（全 0，同 D3D 空 SRV 的读数）与默认采样器。 */
  private createDummies() {
    const device = this.device;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const flat = this.own(device.createTexture({ label: "dummy 2d", size: [1, 1], format: "rgba8unorm", usage }));
    const volume = this.own(
      device.createTexture({ label: "dummy 3d", size: [1, 1, 1], dimension: "3d", format: "rgba8unorm", usage }),
    );
    const cube = this.own(device.createTexture({ label: "dummy cube", size: [1, 1, 6], format: "rgba8unorm", usage }));
    const depth = this.own(
      device.createTexture({
        label: "dummy depth",
        size: [1, 1],
        format: "depth32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    return {
      views: {
        "2d": flat.createView(),
        "3d": volume.createView({ dimension: "3d" }),
        cube: cube.createView({ dimension: "cube" }),
        "2d-comparison": depth.createView(),
      } as Record<TextureBinding["kind"], GPUTextureView>,
      sampler: device.createSampler({ addressModeU: "repeat", addressModeV: "repeat" }),
      comparison: device.createSampler({ compare: "less-equal" }),
    };
  }

  private resolveTexture(ref: TextureRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "composite") return resources.composites[ref.index] ?? null;
    if (ref.kind === "fbo") return this.targets[resources.fbos.resolve(ref.effect, ref.name)] ?? null;
    if (ref.kind === "framebuffer") return this.snapshot;
    return null;
  }

  private resolveTarget(ref: TargetRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "scene") return null;
    return this.resolveTexture(ref, resources);
  }

  /** 全场一份的粒子索引缓冲（`quadIndices`）：每粒子 `0 1 2 0 2 3`，建场景时写一次。 */
  private createParticleIndices(capacity: number): void {
    const particles = Math.max(1, capacity);
    const indices = quadIndices(particles);
    const buffer = this.own(
      this.device.createBuffer({
        label: "particle indices",
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      }),
    );
    this.device.queue.writeBuffer(buffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    this.particleIndices = { buffer, format: indices instanceof Uint32Array ? "uint32" : "uint16", particles };
  }

  /**
   * 一个粒子层的模拟器：种子 = `particleSeed` + 第几个粒子层，建好就预热（C1）。顶点按 `maxcount` 分配，
   * 第一次 `encode` 时写（`stale`）。布局的问题 `checkRenderable` 已经查过。
   * `instanceoverride` 取状态里的当前值（建场景时与编译期相同；万一单图层重建，用的也是就地写过的值）。
   * 预热按状态里对象当前的世界矩阵更新控制点（P4c 步骤 1，rea-p4c-sim.md 1.3）；指针点的跟随点按最近的 cursor
   * （`particleCursor`，加载时是 `ParticleOptions.cursor`）反投影（P4c 步骤 2）。
   */
  private createParticles(layer: SceneLayer, program: GpuProgram, state: SceneState): ParticleDraw {
    const compiled = layer.particle!;
    const def = { ...compiled, instance: { ...compiled.instance, ...state.particleInstances.get(layer.object) } };
    const ordinal = this.particleOrdinals.get(layer.object) ?? 0;
    const system = new ParticleSystem(
      def,
      new SeededRandom((this.particleSeed + ordinal) >>> 0),
      this.particlePasses,
      this.particleROverride?.(layer.object),
    );
    const world = worldMatrixOf(layer.object, state.layers, new Map());
    system.prewarm({ world, pointer: pointerScenePoint(this.viewProjection, this.particleCursor) });
    const { layout } = particleVertexLayout(program.vertexPacking);
    const vertices = new Float32Array(Math.max(1, system.columns.capacity) * 4 * Math.max(1, layout.stride));
    return { system, layout, vertices, count: 0, stale: true, world };
  }

  private createDraw(
    layer: SceneLayer,
    step: DrawLike,
    resources: LayerResources,
    { program, pipeline }: PreparedDraw,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): Draw {
    const { device, bundle } = this;
    const { pass } = step;
    const label = `layer ${layer.id} ${layer.name} ${step.kind === "particles" ? "particles" : step.role}`;

    let vertexBuffer: GPUBuffer;
    let particles: ParticleDraw | null = null;
    if (step.kind === "particles") {
      // 粒子：每帧由 `encode` 写，按容量分配
      particles = this.createParticles(layer, program, state);
      vertexBuffer = this.own(
        device.createBuffer({
          label,
          size: particles.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
    } else {
      // 几何：图层四边形（模型空间、未缩放的 size），或 NDC 全屏四边形
      const vertices =
        step.geometry === "fullscreen" ? layerQuad([2, 2], [1, 1]) : layerQuad(layer.size, step.uv, step.inset);
      const vertexData = program.vertexPacking.pack(vertices);
      vertexBuffer = this.own(
        device.createBuffer({
          label,
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    }

    const sizeOf = (ref: TextureRef | undefined) => {
      if (!ref) return undefined;
      if (ref.kind === "texture") return bundle.textures[ref.index];
      const target = this.resolveTexture(ref, resources);
      return target
        ? { width: target.width, height: target.height, textureWidth: target.width, textureHeight: target.height }
        : undefined;
    };

    // uniform：内置值打底，材质常量 / 用户属性覆盖（与就地刷新共用 `drawUniformValues`）
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let frameNames: string[] = [];
    const slots = Math.max(10, ...program.textures.map((t) => t.slot + 1));
    const textureSizes = Array.from({ length: slots }, (_, slot) => sizeOf(step.inputs[slot]));
    if (program.uniformSize) {
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const layerState = state.layers.get(layer.object);
      if (layerState)
        for (const [name, values] of Object.entries(
          this.uniformValues(step, layer, layerState, textureSizes, state, worlds),
        ))
          block.set(name, values);
      frameNames = Object.keys(
        frameBuiltins({ time: 0, frametime: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0], cursor: [0, 0] }),
      ).filter((name) => block!.has(name) && !(name in pass.uniforms));
      uniformBuffer = this.own(
        device.createBuffer({
          label,
          size: block.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
    }

    const entries = (resolveFbo: (effect: number, name: string) => RenderTarget): GPUBindGroupEntry[] => {
      const list: GPUBindGroupEntry[] = [];
      if (uniformBuffer) list.push({ binding: 0, resource: { buffer: uniformBuffer } });
      for (const binding of program.textures) {
        const ref = step.inputs[binding.slot];
        let view: GPUTextureView;
        let sampler: GPUSampler;
        if (!ref) {
          view = this.dummies.views[binding.kind];
          sampler = binding.kind === "2d-comparison" ? this.dummies.comparison : this.dummies.sampler;
        } else {
          if (binding.kind !== "2d")
            throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
          if (ref.kind === "texture") {
            view = this.textures[ref.index]!.createView();
            sampler = this.samplerFor(bundle.textures[ref.index]);
          } else {
            const target = ref.kind === "fbo" ? resolveFbo(ref.effect, ref.name) : this.resolveTexture(ref, resources);
            if (!target) throw new SceneRenderError([`render:texture-rt:${ref.kind}`]);
            view = target.view;
            sampler = target.sampler;
          }
        }
        list.push({ binding: binding.binding, resource: view });
        list.push({ binding: binding.samplerBinding, resource: sampler });
      }
      return list;
    };
    const dynamic = Object.values(step.inputs).some((ref) => ref.kind === "fbo");
    const resolveNow = (effect: number, name: string) => this.targets[resources.fbos.resolve(effect, name)];
    const bindGroup = dynamic
      ? null
      : device.createBindGroup({ label, layout: program.bindGroupLayout, entries: entries(resolveNow) });

    return {
      label,
      step,
      particles,
      program,
      object: layer.object,
      layer,
      passKey: pass.key,
      resources,
      pipeline,
      vertexBuffer,
      uniformBuffer,
      block,
      frameNames,
      textureSizes,
      dirty: false,
      bindGroup,
      bindGroups: new Map(),
      entries,
      layout: program.bindGroupLayout,
    };
  }

  /** 引用 fbo 的 bind group 按当前 swap 状态取（各状态各建一次）。 */
  private bindGroupOf(draw: Draw): GPUBindGroup {
    if (draw.bindGroup) return draw.bindGroup;
    const ids: number[] = [];
    const resolve = (effect: number, name: string) => {
      const id = draw.resources.fbos.resolve(effect, name);
      ids.push(id);
      return this.targets[id];
    };
    const entries = draw.entries(resolve);
    const key = ids.join(",");
    let group = draw.bindGroups.get(key);
    if (!group) {
      group = this.device.createBindGroup({ label: draw.label, layout: draw.layout, entries });
      draw.bindGroups.set(key, group);
    }
    return group;
  }

  /**
   * 一个 draw 的全部静态 uniform（建 draw 与就地刷新共用）：图层状态、按父链算的世界矩阵 + 场景级常量（建场景时算一次）。
   * 图层走 `drawUniformValues`，粒子走 `particleUniformValues`（透视粒子换视图投影）。
   */
  private uniformValues(
    step: DrawLike,
    layer: SceneLayer,
    layerState: LayerState,
    textures: readonly (TextureSize | undefined)[],
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): Record<string, number[]> {
    const common = {
      world: worldMatrixOf(layer.object, state.layers, worlds),
      constants: state.constants.get(step.pass.key) ?? {},
      // HDR 下颜色乘 brightness（B10）；passthrough 的 g_Color4 由材质值覆盖成 (1, 1, 1, 1)
      colorScale: this.hdr ? layerState.brightness : 1,
      screenSize: [this.width, this.height] as [number, number],
      textures,
      eye: this.eye,
      // 读状态，不读编译结果：单图层重建新建的 draw 要拿到当前值
      ambient: state.general.ambientcolor,
      skylight: state.general.skylightcolor,
    };
    if (step.kind === "particles") {
      // 帧表（P4b 步骤 2）：槽 0 的纹理带帧表时写 `g_RenderVar1`
      const base = step.inputs[0];
      return particleUniformValues({
        ...common,
        layer: layerState,
        viewProjection: step.perspective ? this.perspectiveViewProjection : this.viewProjection,
        sheet: base?.kind === "texture" ? this.bundle.textures[base.index]?.sheet : undefined,
      });
    }
    return drawUniformValues({
      ...common,
      step,
      layer: { ...layerState, size: layer.size },
      viewProjection: this.viewProjection,
    });
  }

  /**
   * 把 `SceneState` 的脏项刷进 uniform 块 / 泛光链（在 `update` 之前调用）。
   * 脏 draw 由 `update` 整块重写。结构脏当场处理，返回时新结构已换上。
   */
  sync(state: SceneState): void {
    const dirty = state.takeDirty();
    // 本次的状态快照下的世界矩阵：重建与刷新共用，一条父链只算一次。父的变换写过时子孙已在 `dirty.layers` 里（`SceneState.write`）
    const worlds = new Map<number, Mat4>();
    // 结构先处理：新 draw 按当前状态写 uniform，后面的刷新也落在新 draw 上
    this.rebuildStructures(dirty.structures, state, worlds);
    for (const object of dirty.layers)
      for (const draw of this.drawsByLayer.get(object) ?? []) this.refreshLayer(draw, state, worlds);
    for (const key of dirty.passes) for (const draw of this.drawsByPass.get(key) ?? []) this.refreshPass(draw, state);
    if (dirty.lights) for (const draw of this.draws) this.refreshLights(draw, state);
    // `instanceoverride` 改值：模拟器从基值重新乘，不重建缓冲、不清粒子（P4a 步骤 5，C5）
    for (const object of dirty.particles) {
      const values = state.particleInstances.get(object);
      if (values) for (const draw of this.drawsByLayer.get(object) ?? []) draw.particles?.system.setInstance(values);
    }
    if (dirty.bloom) this.bloom?.setParams(state.bloom);
    if (!state.general.clearenabled && !this.alternate) this.addAlternateTarget();
  }

  private createAlternateTarget(): SceneTarget {
    return this.createSceneTarget("scene target 2", GPUTextureUsage.COPY_DST);
  }

  /** 没有声明的脚本第一次关掉清屏：当场建第二张，把当前画面拷过去。这一帧的底图是 N−1，静止内容相同。 */
  private addAlternateTarget(): void {
    if (!this.current) return;
    const alternate = this.createAlternateTarget();
    const encoder = this.device.createCommandEncoder({ label: "scene target copy" });
    encoder.copyTextureToTexture(
      { texture: this.current.texture },
      { texture: alternate.texture },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([encoder.finish()]);
    this.alternate = alternate;
  }

  /**
   * HDR 不清屏时把底图换回 WPE 的空间。WPE 收尾写 `lin(x)`（`combine_hdr`、`passthroughsrgb`），下一轮底图是线性值，累加因此收敛；
   * 我们的目标存 `x`（画布是 8 位 sRGB 编码，单帧逐值相等，P2b），不补这一步就一直涨（L21）。
   * 快照当中转：这一帧要读它之前总有 `snapshot` 操作重新拷。
   */
  private linearizeBase(encoder: GPUCommandEncoder, { texture, view }: SceneTarget): void {
    this.ensureSnapshot();
    const snapshot = this.snapshot!;
    if (!this.linearBase) {
      const module = this.device.createShaderModule({ label: "scene base linear", code: LINEAR_BASE_WGSL });
      const pipeline = this.device.createRenderPipeline({
        label: "scene base linear",
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      });
      const bindGroup = this.device.createBindGroup({
        label: "scene base linear",
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: snapshot.view }],
      });
      this.linearBase = { pipeline, bindGroup };
    }
    encoder.copyTextureToTexture(
      { texture },
      { texture: snapshot.texture },
      { width: this.width, height: this.height },
    );
    const pass = encoder.beginRenderPass({
      label: "scene base linear",
      colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(this.linearBase.pipeline);
    pass.setBindGroup(0, this.linearBase.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** effect 开关真的变了的图层：重排，再清 fbo。清屏提交在这一帧的绘制之前。 */
  private rebuildStructures(objects: ReadonlySet<number>, state: SceneState, worlds: Map<number, Mat4>): void {
    if (!objects.size) return;
    const encoder = this.device.createCommandEncoder({ label: "effect clear" });
    let cleared = false;
    for (const object of objects) {
      const runtime = this.layers.find((layer) => layer.object === object);
      if (!runtime) continue;
      this.rebuildLayer(runtime, state, worlds);
      // 签名没变也要清：同一帧内关了又开，WPE 仍然重建
      cleared = this.clearLayerFbos(encoder, runtime) || cleared;
    }
    if (cleared) this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 切换当场做完：程序与管线都是加载时备好的，这里不编译、不等待。copy / swap 与程序的检查已提前到 `prepareVariants`，n + 2 份之外的组合由 `planProblems` 当场查，
   * 万一还有校验错误，走 `onuncapturederror`。旧 draw 的缓冲换下时销毁：已提交的帧不受影响，之后的帧只用新 draw。
   */
  private rebuildLayer(runtime: LayerRuntime, state: SceneState, worlds: Map<number, Mat4>): void {
    const plan = this.planOf(runtime.layer, state);
    const signature = planSignature(plan);
    if (signature === runtime.signature) return;
    const started = performance.now();
    // 开关组合太多，`prepareVariants` 只查 n + 2 份；全部开着的 effect 都没有绘制 pass 这类组合在这里才查得到
    const problems = planProblems(plan, this.bundle);
    if (problems.length) throw new SceneRenderError(problems);
    const built = this.buildLayer(runtime, plan, this.preparedOf(plan, runtime.resources), state, worlds);
    for (const draw of runtime.draws) {
      this.draws.delete(draw);
      this.drawsByPass.delete(draw.passKey);
      this.release(draw.vertexBuffer);
      if (draw.uniformBuffer) this.release(draw.uniformBuffer);
    }
    this.install(runtime, built);
    runtime.signature = signature;
    const elapsed = performance.now() - started;
    this.rebuildStats.count++;
    this.rebuildStats.totalMs += elapsed;
    this.rebuildStats.maxMs = Math.max(this.rebuildStats.maxMs, elapsed);
  }

  /**
   * 清本图层全部 effect 带 `clear` 的 fbo，含没切的和关着的（J6），返回有没有清。
   * 实体按初始对应取：swap 只改 pass 下标，清的是 fbo 本身。
   */
  private clearLayerFbos(encoder: GPUCommandEncoder, { layer, resources }: LayerRuntime): boolean {
    let cleared = false;
    layer.effects.forEach((effect, e) => {
      for (const fbo of effect.fbos) {
        if (!fbo.clear) continue;
        this.clearTarget(encoder, this.targets[resources.fbos.initial(e, fbo.name)], fbo.clear, `clear ${fbo.name}`);
        cleared = true;
      }
    });
    return cleared;
  }

  /** 图层（或它某个祖先）状态变化：只重写由图层算出的那组内置 uniform（材质值优先，不覆盖）。 */
  private refreshLayer(draw: Draw, state: SceneState, worlds: Map<number, Mat4>): void {
    const layerState = state.layers.get(draw.object);
    if (!draw.block || !layerState) return;
    const values = this.uniformValues(draw.step, draw.layer, layerState, draw.textureSizes, state, worlds);
    for (const name of layerRefreshNames(draw.step.pass.uniforms)) {
      const value = values[name];
      if (value) draw.block.set(name, value);
    }
    draw.dirty = true;
  }

  /** 材质常量变化：重写本 pass 的全部材质常量（含用户属性写进 `constantshadervalues` 的那些）。 */
  private refreshPass(draw: Draw, state: SceneState): void {
    const constants = state.constants.get(draw.passKey);
    if (!draw.block || !constants) return;
    for (const [name, values] of Object.entries(constants)) draw.block.set(name, values);
    draw.dirty = true;
  }

  /** 环境光变化：只写块里有、材质没覆盖的名字；都没有时不标脏，脚本逐帧写时不重传无关的缓冲。 */
  private refreshLights(draw: Draw, state: SceneState): void {
    const { block, step } = draw;
    if (!block) return;
    for (const [name, key] of Object.entries(LIGHT_UNIFORMS)) {
      if (!block.has(name) || name in step.pass.uniforms) continue;
      block.set(name, state.general[key]);
      draw.dirty = true;
    }
  }

  /**
   * 写每帧变化的 uniform（`g_Time` 等）；被就地改过的 draw 整块重写一次。粒子按 `frame.frametime` 步进一帧
   * （`stepParticles`）：`state` 给出时不可见的粒子层走 `suspend`（不发射、有存活粒子就清空），不给（只核对 uniform 的单测）
   * 时全部步进。
   */
  update(frame: FrameInput, state?: SceneState): void {
    this.stepParticles(frame.frametime, frame.time, state, frame.cursor);
    const values = frameBuiltins(frame);
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer) continue;
      if (!draw.frameNames.length && !draw.dirty) continue;
      for (const name of draw.frameNames) draw.block.set(name, values[name]);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
      draw.dirty = false;
    }
  }

  /**
   * 全部粒子层按帧时间步进一帧（`ParticleSystem.step` 乘 `instanceoverride.rate`）；帧时间不是正数（补画帧、暂停）时不动。
   * `state` 给出时，不可见（含祖先，`effectiveVisible`）的粒子层不发射、不步进，还有存活粒子就清空并复位 emitter 计时
   * （`ParticleSystem.suspend`，C8 读码）；重新可见时照常步进，不重新预热。清空后标 `stale`：之后哪一帧再画，都先写成 0 个。
   * `time` 是这一帧的 `g_Time`（和 uniform 同一个值，已回绕），作噪声类模块的场景时间 `T`（P4b 步骤 4）。
   * 控制点的输入是对象的世界矩阵（P4c 步骤 1）：给了 `state` 时每帧按它沿父链算（脚本改变换、父链变化下一帧就跟上，一次调用
   * 共用一份缓存），没给时用加载时的（`ParticleDraw.world`）。
   * 指针点的跟随点（P4c 步骤 2）：`cursor` 是这一帧光标下的场景纹理坐标（`FrameInput.cursor`，缺省场景中心），按场景的正交
   * `P·V` 反投影到 z = 0（`pointerScenePoint`），每次调用只算一次、交给每个系统（没有粒子层时不算）；透视粒子不另算（WPE 模拟时
   * 栈上是正交投影，透视投影只在绘制时压栈，rea-p4c-sim.md 1.6）。
   * dev 探针按 dt 序列回放时直接调它。
   */
  stepParticles(
    frametime: number,
    time: number,
    state?: SceneState,
    cursor: readonly [number, number] = [0.5, 0.5],
  ): void {
    this.particleCursor = cursor;
    if (!(frametime > 0)) return;
    const worlds = new Map<number, Mat4>();
    let pointer: [number, number] | null = null;
    for (const draw of this.draws) {
      const particles = draw.particles;
      if (!particles) continue;
      if (state && !effectiveVisible(draw.object, state.layers)) {
        if (particles.system.suspend()) particles.stale = true;
        continue;
      }
      const timing = this.particleTimings?.get(draw);
      const started = timing ? performance.now() : 0;
      const world = state ? worldMatrixOf(draw.object, state.layers, worlds) : particles.world;
      pointer ??= pointerScenePoint(this.viewProjection, cursor);
      particles.system.step(frametime, time, { world, pointer });
      if (timing) {
        recordSample(timing.simulate, performance.now() - started);
        recordSample(timing.alive, particles.system.alive);
      }
      particles.stale = true;
    }
  }

  /** 步进过的粒子层：把列写成顶点，再整段传上去（只传存活的那部分）。 */
  private uploadParticles(draw: Draw, particles: ParticleDraw): void {
    if (!particles.stale) return;
    particles.stale = false;
    const timing = this.particleTimings?.get(draw);
    const started = timing ? performance.now() : 0;
    particles.count = writeVertices(particles.system, particles.layout, particles.vertices);
    const written = timing ? performance.now() : 0;
    if (particles.count) {
      const bytes = particles.count * 4 * particles.layout.stride * 4;
      this.device.queue.writeBuffer(
        draw.vertexBuffer,
        0,
        particles.vertices.buffer,
        particles.vertices.byteOffset,
        bytes,
      );
    }
    if (timing) {
      recordSample(timing.vertices, written - started);
      recordSample(timing.upload, performance.now() - written);
    }
  }

  /**
   * 各粒子层当前的数量（dev 探针用）：存活数、高水位与容量。`detail` 时加上存活粒子的分布（位置范围、尺寸、alpha），
   * 供和 WPE 比统计量（`summarizeParticles`）。
   */
  particleStats(detail = false): {
    object: number;
    name: string;
    alive: number;
    highWater: number;
    capacity: number;
    summary?: ParticleSummary;
  }[] {
    return [...this.draws].flatMap((draw) =>
      draw.particles
        ? [
            {
              object: draw.object,
              name: draw.layer.name,
              alive: draw.particles.system.alive,
              highWater: draw.particles.system.highWater,
              capacity: draw.particles.system.columns.capacity,
              ...(detail ? { summary: summarizeParticles(draw.particles.system) } : {}),
            },
          ]
        : [],
    );
  }

  /**
   * dev 探针：开始（`true`）或停止（`false`，同时清空）记录粒子开销。打开后每个粒子层记最近 600 帧的模拟、写顶点与上传
   * 用时（`stepParticles` / `uploadParticles`），由 `particleProfile` 汇总。关着时只多一次 null 判断。
   */
  profileParticles(enabled: boolean): void {
    if (!enabled) {
      this.particleTimings = null;
      return;
    }
    this.particleTimings ??= new Map();
    for (const draw of this.draws)
      if (draw.particles && !this.particleTimings.has(draw))
        this.particleTimings.set(draw, { simulate: [], vertices: [], upload: [], alive: [] });
  }

  /** dev 探针：各粒子层的开销统计（毫秒）；没打开记录时为空。 */
  particleProfile(): ParticleProfile[] {
    if (!this.particleTimings) return [];
    return [...this.particleTimings].map(([draw, timing]) => ({
      object: draw.object,
      name: draw.layer.name,
      capacity: draw.particles!.system.columns.capacity,
      frames: timing.simulate.length,
      alive: timingStats(timing.alive),
      simulateMs: timingStats(timing.simulate),
      verticesMs: timingStats(timing.vertices),
      uploadMs: timingStats(timing.upload),
    }));
  }

  /**
   * dev 探针（`particleCorners`）：一个粒子层的程序、uniform 缓冲、bind group 条目，以及按当前状态写好的顶点
   * （存活粒子按槽序，`count` 个，每个 4 个顶点）。不是粒子层时为 null。
   */
  particleProbe(object: number): {
    program: GpuProgram;
    uniformBuffer: GPUBuffer | null;
    entries: GPUBindGroupEntry[];
    vertices: Float32Array;
    count: number;
    layout: ParticleVertexLayout;
    perspective: boolean;
    system: ParticleSystem;
  } | null {
    const draw = [...this.draws].find((item) => item.object === object && item.particles);
    if (!draw?.particles || draw.step.kind !== "particles") return null;
    const { system, layout } = draw.particles;
    const vertices = new Float32Array(draw.particles.vertices.length);
    const count = writeVertices(system, layout, vertices);
    const resources = draw.resources;
    return {
      program: draw.program,
      uniformBuffer: draw.uniformBuffer,
      entries: draw.entries((effect, name) => this.targets[resources.fbos.resolve(effect, name)]),
      vertices: vertices.subarray(0, count * 4 * layout.stride),
      count,
      layout,
      perspective: draw.step.perspective,
      system,
    };
  }

  /**
   * 按图层顺序执行全部步骤，结果在离屏场景目标里。不可见图层整段跳过（含它的快照），泛光关着时不拷快照、不跑链。
   * `afterBloomStep`：泛光链每步之后调用（dev 探针读回中间结果用）。
   */
  encode(encoder: GPUCommandEncoder, state: SceneState, afterBloomStep?: Parameters<BloomChain["encode"]>[2]): void {
    // 两张时每帧都换，清屏开着也换：运行中关掉时手上正好是 N−2（L11）
    if (this.alternate) [this.current, this.alternate] = [this.alternate, this.current];
    if (!this.current) return;
    const { view: sceneView, texture: sceneTexture } = this.current;
    const { clearcolor, clearenabled } = state.general;
    const [r, g, b] = clearcolor;
    if (this.hdr && !clearenabled) this.linearizeBase(encoder, this.current);
    const snapshot = () => {
      if (this.snapshot)
        encoder.copyTextureToTexture(
          { texture: sceneTexture },
          { texture: this.snapshot.texture },
          { width: this.width, height: this.height },
        );
    };
    let open: GPURenderPassEncoder | null = null;
    let started = false;
    const begin = (): GPURenderPassEncoder => {
      if (!open) {
        open = encoder.beginRenderPass({
          label: "scene",
          colorAttachments: [
            {
              view: sceneView,
              clearValue: { r, g, b, a: 1 },
              // 第一个 pass：开着清成 clearcolor，关着接着这张目标上次的成品画
              loadOp: started || !clearenabled ? "load" : "clear",
              storeOp: "store",
            },
          ],
        });
        started = true;
      }
      return open;
    };
    const end = () => {
      open?.end();
      open = null;
    };
    const draw = (pass: GPURenderPassEncoder, item: Draw) => {
      const particles = item.particles;
      if (particles) {
        // 粒子：先把这一帧的顶点传上去（队列写入排在本帧提交之前），没有存活粒子就不画
        this.uploadParticles(item, particles);
        if (!particles.count || !this.particleIndices) return;
      }
      pass.setPipeline(item.pipeline);
      pass.setBindGroup(0, this.bindGroupOf(item));
      pass.setVertexBuffer(0, item.vertexBuffer);
      if (particles) {
        pass.setIndexBuffer(this.particleIndices!.buffer, this.particleIndices!.format);
        pass.drawIndexed(particles.count * 6);
      } else pass.draw(4);
    };
    const runOps = (ops: readonly Op[]) => {
      for (const op of ops) {
        if (op.kind === "draw") {
          const { draw: item } = op;
          if (item.step.target.kind === "scene") {
            draw(begin(), item);
            continue;
          }
          end();
          const target = this.resolveTarget(item.step.target, item.resources);
          if (!target) continue;
          const pass = encoder.beginRenderPass({
            label: item.label,
            colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }],
          });
          draw(pass, item);
          pass.end();
        } else if (op.kind === "snapshot") {
          // 快照要包含清屏色：本帧还没画过场景就先清一次
          if (!started) begin();
          end();
          snapshot();
        } else if (op.kind === "copy") {
          end();
          const source = this.resolveTexture(op.source, op.resources);
          const target = this.resolveTarget(op.target, op.resources);
          if (source && target && source !== target)
            encoder.copyTextureToTexture(
              { texture: source.texture },
              { texture: target.texture },
              { width: Math.min(source.width, target.width), height: Math.min(source.height, target.height) },
            );
        } else op.resources.fbos.swap(op.effect, op.source, op.target);
      }
    };
    // 不可见图层整段跳过（含它的快照与 copy / swap）；运行时可见性由 `SceneState` 决定（P3a）
    const visible = new Set(visibleObjects(this.layers, state));
    for (const layer of this.layers) if (visible.has(layer.object)) runOps(layer.ops);
    if (this.bloom && state.bloomEnabled) {
      // 全部图层画完：整帧快照（只拷这一次）→ 泛光链 → combine 写回场景目标
      if (!started) begin();
      end();
      snapshot();
      this.bloom.encode(encoder, sceneView, afterBloomStep);
    }
    if (!started) begin();
    end();
  }

  destroy(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned.clear();
    this.draws.clear();
    this.layers.length = 0;
    this.drawsByLayer.clear();
    this.drawsByPass.clear();
    this.targets.length = 0;
    this.current = null;
    this.alternate = null;
    this.linearBase = null;
    this.snapshot = null;
    this.bloom = null;
    this.particleIndices = null;
    this.particleTimings = null;
  }
}
