/**
 * 泛光链：渲染图（纯函数 `planBloom`）与 GPU 执行（`BloomChain`）。规格来自对 WPE 2.8.42 的逆向，并用 RenderDoc 抓帧逐位核对
 * （`.claude/plans/wpe-import/3-scene/p2-REPORT.md` A1–A4、J5，PLAN P2b）。材质见 `compile/bloom.ts`。
 *
 * 每帧在全部图层画完之后：场景目标整张拷进 `_rt_FullFrameBuffer`（只拷这一次）→ 泛光链 → combine 读快照与泛光结果、
 * 写回场景目标（之后照常 cover 铺到画布）。所有 pass 画全屏四边形、只写 RGB（write mask 7），采样线性过滤 + clamp。
 *
 * - **LDR**（`rgba8unorm`）：快照 → `_rt_4FrameBuffer`（W/4）→ `_rt_8FrameBuffer`（W/8）→ `_rt_Bloom`（W/8）→ combine。
 *   `bloomstrength` / `bloomthreshold` / `bloomtint` 原值写进第一个下采样材质，不做换算。
 * - **HDR**（`rgba16float`）：金字塔 L0…L(N−1)，Li 名义尺寸 = 场景 / 2^(i+1)，RT 尺寸向下取整、至少 2。
 *   - 下采样：L0 = `hdr_downsample_bloom`（快照 → L0，soft-knee 阈值），之后 `hdr_downsample` 逐级减半；
 *   - 上采样：u 从 N−1 到 1，L(u) → L(u−1)，混合 SrcAlpha / One（着色器输出 a = 1，即加法）；u ≥ N−2 用 bicubic；
 *   - `g_RenderVar0` = (tx, ty, −tx, −ty)：下采样取**源**纹素、上采样取**目标**纹素，都按**名义**尺寸算（不随取整变）；
 *   - 级数：可用级数 = min(w, h) 逐次减半仍 ≥ 1 的次数（最多 8），N = clamp(min(`bloomhdriterations`, 可用级数), 1)；
 *   - 参数（`FUN_140184020`）：`bloomstrength` = (hdrstrength / (1 + scatter^(max(N, 2) − 2)), scatter)，
 *     `blend` = (t, t − k, 2k, 0.25 / (k + 1e−5))（k = t · feather），`scatter` 写给两个上采样材质，`bloomtint` 原样。
 *     按 float32 逐步计算（`Math.fround`），与抓帧里的常量逐位一致。
 */
import type { BloomPassName, SceneBloom } from "../compile/bloom";
import type { ScenePass } from "../compile/bundle";
import type { BloomParams } from "../compile/postprocess";
import { SceneRenderError } from "./errors";
import { layerQuad } from "./layout";
import type { GpuProgram } from "./programs";
import { screenBuiltins, textureBuiltins, UniformBlock, type UniformEntry } from "./uniforms";

/** 金字塔最多级数（WPE resize 时预建 8 级）。 */
export const BLOOM_MAX_LEVELS = 8;

/** 可用级数：min(w, h) 逐次减半仍 ≥ 1 的次数，最多 8（A1，3840×2160 为 8）。 */
export function bloomLevels(width: number, height: number): number {
  let d = Math.min(width, height);
  let count = 0;
  for (let i = 0; i < BLOOM_MAX_LEVELS; i++) {
    d = Math.floor(d / 2);
    if (d >= 1) count++;
  }
  return count;
}

/** 实际级数 N = min(`bloomhdriterations`, 可用级数)，小于 1 取 1（A2）。 */
export function bloomIterations(iterations: number, available: number): number {
  return Math.max(1, Math.min(Math.trunc(iterations), available));
}

/** RT 尺寸：整数除法、至少 2（RT 构造 `FUN_1400d2c60`）。 */
export function bloomTargetSize(width: number, height: number, divisor: number): [number, number] {
  return [Math.max(2, Math.floor(width / divisor)), Math.max(2, Math.floor(height / divisor))];
}

/** HDR 材质常量（按材质名，WPE 按名字写）：float32 逐步计算，与抓帧逐位一致。 */
export function hdrBloomConstants(params: BloomParams, levels: number): Record<string, number[]> {
  const f = Math.fround;
  const scatter = f(params.hdrScatter);
  const strength = f(f(params.hdrStrength) / f(f(scatter ** (Math.max(levels, 2) - 2)) + 1));
  const t = f(params.hdrThreshold);
  const k = f(t * f(params.hdrFeather));
  return {
    bloomstrength: [strength, scatter],
    blend: [t, f(t - k), f(k + k), f(0.25 / f(k + f(1e-5)))],
    bloomtint: params.tint.map(f),
    scatter: [scatter],
  };
}

export type BloomSource = { kind: "framebuffer" } | { kind: "target"; index: number };
export type BloomDestination = { kind: "target"; index: number } | { kind: "scene" };

export interface BloomStep {
  pass: BloomPassName;
  /** 槽位 → 来源（槽 0 是上一步 / 快照，combine 的槽 1 是泛光结果）。 */
  inputs: BloomSource[];
  target: BloomDestination;
  /** 材质常量，按材质名（`bloomstrength`、`blend`、`scatter`…）。 */
  constants: Record<string, number[]>;
  /** `g_RenderVar0`；LDR 的 pass 不用。 */
  renderVar0: [number, number, number, number] | null;
  /** 混合：上采样 additive，其余关闭。 */
  additive: boolean;
}

export interface BloomPlan {
  hdr: boolean;
  /** HDR 的级数 N；LDR 为 0。 */
  levels: number;
  /** 中间 RT：LDR 依次是 `_rt_4FrameBuffer`、`_rt_8FrameBuffer`、`_rt_Bloom`；HDR 是 L0…L(N−1)。 */
  targets: { name: string; width: number; height: number }[];
  /** 与 WPE 对照时比的那张中间结果：LDR `_rt_Bloom`、HDR L0（上采样累加之后）。 */
  result: number;
  steps: BloomStep[];
}

/** 按场景目标尺寸（WPE 是窗口尺寸）排出泛光链。 */
export function planBloom(hdr: boolean, params: BloomParams, width: number, height: number): BloomPlan {
  const framebuffer: BloomSource = { kind: "framebuffer" };
  const target = (index: number): BloomSource & BloomDestination => ({ kind: "target", index });
  if (!hdr) {
    const sized = (name: string, divisor: number) => {
      const [w, h] = bloomTargetSize(width, height, divisor);
      return { name, width: w, height: h };
    };
    const ldr = (pass: BloomPassName, inputs: BloomSource[], to: BloomDestination, constants = {}): BloomStep => ({
      pass,
      inputs,
      target: to,
      constants,
      renderVar0: null,
      additive: false,
    });
    return {
      hdr,
      levels: 0,
      targets: [sized("_rt_4FrameBuffer", 4), sized("_rt_8FrameBuffer", 8), sized("_rt_Bloom", 8)],
      result: 2,
      steps: [
        ldr("quarter", [framebuffer], target(0), {
          bloomstrength: [params.strength],
          bloomthreshold: [params.threshold],
          bloomtint: [...params.tint],
        }),
        ldr("eighth", [target(0)], target(1)),
        ldr("blur", [target(1)], target(2)),
        ldr("combine", [framebuffer, target(2)], { kind: "scene" }),
      ],
    };
  }

  const levels = bloomIterations(params.hdrIterations, Math.max(1, bloomLevels(width, height)));
  const constants = hdrBloomConstants(params, levels);
  const f = Math.fround;
  // 第 i 级（名义尺寸 W / 2^(i+1)）的纹素偏移 = 2^(i+1) / W；下采样第 i 步取源（L(i−1)）纹素 2^i / W
  const texel = (scale: number): [number, number, number, number] => {
    const x = f(scale / width),
      y = f(scale / height);
    return [x, y, -x, -y];
  };
  const steps: BloomStep[] = [
    {
      pass: "downsampleBloom",
      inputs: [framebuffer],
      target: target(0),
      constants: { bloomstrength: constants.bloomstrength, blend: constants.blend, bloomtint: constants.bloomtint },
      renderVar0: texel(1),
      additive: false,
    },
  ];
  for (let i = 1; i < levels; i++)
    steps.push({
      pass: "downsample",
      inputs: [target(i - 1)],
      target: target(i),
      constants: {},
      renderVar0: texel(2 ** i),
      additive: false,
    });
  for (let u = levels - 1; u > 0; u--)
    steps.push({
      pass: u >= levels - 2 ? "upsampleCubic" : "upsample",
      inputs: [target(u)],
      target: target(u - 1),
      constants: { scatter: constants.scatter },
      renderVar0: texel(2 ** u),
      additive: true,
    });
  // 收尾：WPE 合成前由设备写 RV0.xy（SDR 为 1, 1，G5），zw 保留上一步的值；LINEAR 变体不读它
  const last = steps.at(-1)!.renderVar0!;
  steps.push({
    pass: "combine",
    inputs: [framebuffer, target(0)],
    target: { kind: "scene" },
    constants: {},
    renderVar0: [1, 1, last[2], last[3]],
    additive: false,
  });
  return {
    hdr,
    levels,
    targets: Array.from({ length: levels }, (_, i) => {
      const [w, h] = bloomTargetSize(width, height, 2 ** (i + 1));
      return { name: `_rt_${2 ** (i + 1)}FrameBuffer`, width: w, height: h };
    }),
    result: 0,
    steps,
  };
}

/** 一份 bundle 的泛光链要用的 pass 名（`checkRenderable` 核对是否都编出来了）。 */
export function bloomPassesOf(plan: Pick<BloomPlan, "steps">): BloomPassName[] {
  return [...new Set(plan.steps.map((step) => step.pass))];
}

interface BloomTarget {
  name: string;
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

interface BloomDraw {
  step: BloomStep;
  label: string;
  pipeline: GPURenderPipeline;
  vertexBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  /** 保留 uniform 块与缓冲：泛光参数就地改时按新参数重写（P3a）。 */
  block: UniformBlock | null;
  uniformBuffer: GPUBuffer | null;
  program: GpuProgram;
  pass: ScenePass;
  /** 各输入槽的尺寸（参数重算时复用）。 */
  sizes: readonly BloomInputSize[];
}

/** 一个输入槽的尺寸（场景目标 / 泛光 RT 都是纹理 = 图像）。 */
interface BloomInputSize {
  width: number;
  height: number;
  textureWidth: number;
  textureHeight: number;
}

export interface BloomChainInput {
  device: GPUDevice;
  bloom: SceneBloom;
  params: BloomParams;
  programs: ReadonlyMap<number, GpuProgram>;
  /** 中间 RT 的格式，也就是场景目标的格式：LDR `rgba8unorm`，HDR `rgba16float`。 */
  format: GPUTextureFormat;
  /** 场景目标（也是屏幕）尺寸：RT 尺寸、`g_RenderVar0`、`g_TexelSize` 都按它。 */
  width: number;
  height: number;
  /** `_rt_FullFrameBuffer`：调用方在 `encode` 之前拷好。 */
  source: GPUTextureView;
  pipelineFor(program: GpuProgram, blending: string | null, format: GPUTextureFormat): Promise<GPURenderPipeline>;
  /** 资源归属（随场景一起销毁）。 */
  own<T extends { destroy(): void }>(resource: T): T;
}

/** 材质名 → uniform 名：WPE 按材质名写常量，着色器注解 `{"material": …}` 给出对应的 uniform。 */
function materialUniforms(program: GpuProgram, constants: Record<string, number[]>): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  for (const uniform of program.result.uniforms ?? []) {
    const material = uniform.meta?.material;
    if (typeof material === "string" && constants[material]) values[uniform.name] = constants[material];
  }
  return values;
}

/** 一步泛光 pass 的全部 uniform：屏幕、纹理尺寸、材质注解默认值与按材质名的参数。 */
function bloomValues(
  program: GpuProgram,
  pass: ScenePass,
  step: BloomStep,
  sizes: readonly BloomInputSize[],
  width: number,
  height: number,
): Record<string, number[]> {
  const values: Record<string, number[]> = {
    ...screenBuiltins([width, height]),
    ...textureBuiltins(sizes),
    ...pass.uniforms,
    ...materialUniforms(program, step.constants),
  };
  if (step.renderVar0) values.g_RenderVar0 = step.renderVar0;
  return values;
}

export class BloomChain {
  readonly targets: BloomTarget[];
  private readonly draws: BloomDraw[] = [];
  /** 当前的渲染图（就地改参数时按新参数重算，级数不变所以结构相同）。 */
  private currentPlan: BloomPlan;

  private constructor(
    private readonly device: GPUDevice,
    plan: BloomPlan,
    targets: BloomTarget[],
    private readonly width: number,
    private readonly height: number,
  ) {
    this.currentPlan = plan;
    this.targets = targets;
  }

  get plan(): BloomPlan {
    return this.currentPlan;
  }

  /** 中间 RT 与快照之外这条链另外占的显存（字节）。 */
  get bytes(): number {
    const texel = this.plan.hdr ? 8 : 4;
    return this.targets.reduce((sum, target) => sum + target.width * target.height * texel, 0);
  }

  /** HDR 级数（`bloomhdriterations` 换算出的金字塔级数）是否不变；级数变了要重排金字塔，只能整场重编译。 */
  sameLevels(params: BloomParams): boolean {
    if (!this.currentPlan.hdr) return true;
    const available = Math.max(1, bloomLevels(this.width, this.height));
    return bloomIterations(params.hdrIterations, available) === this.currentPlan.levels;
  }

  /** 按新参数重算常量并重写各 pass 的 uniform（调用方已确认 `sameLevels`）。 */
  setParams(params: BloomParams): void {
    const plan = planBloom(this.currentPlan.hdr, params, this.width, this.height);
    this.draws.forEach((draw, index) => {
      const step = plan.steps[index];
      if (!draw.block || !draw.uniformBuffer || !step) return;
      const values = bloomValues(draw.program, draw.pass, step, draw.sizes, this.width, this.height);
      for (const [name, value] of Object.entries(values)) draw.block.set(name, value);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
    });
    this.currentPlan = plan;
  }

  static async create(input: BloomChainInput): Promise<BloomChain> {
    const { device, bloom, width, height } = input;
    const plan = planBloom(bloom.hdr, input.params, width, height);
    const targets = plan.targets.map(({ name, width: w, height: h }) => {
      const texture = input.own(
        device.createTexture({
          label: name,
          size: { width: w, height: h },
          format: input.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
      return { name, texture, view: texture.createView(), width: w, height: h };
    });
    const chain = new BloomChain(device, plan, targets, width, height);
    const sampler = device.createSampler({
      label: "bloom",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const quad = layerQuad([2, 2], [1, 1]);
    const sizeOf = (source: BloomSource): BloomInputSize =>
      source.kind === "framebuffer"
        ? { width, height, textureWidth: width, textureHeight: height }
        : {
            width: targets[source.index].width,
            height: targets[source.index].height,
            textureWidth: targets[source.index].width,
            textureHeight: targets[source.index].height,
          };
    chain.draws.push(
      ...(await Promise.all(
        plan.steps.map(async (step, index): Promise<BloomDraw> => {
          const pass: ScenePass | undefined = bloom.passes[step.pass];
          const program = pass?.program === null || pass === undefined ? undefined : input.programs.get(pass.program);
          if (!pass || !program) throw new SceneRenderError([`render:bloom:${step.pass}`]);
          const label = `bloom ${index} ${step.pass}`;
          const vertexData = program.vertexPacking.pack(quad);
          const vertexBuffer = input.own(
            device.createBuffer({
              label,
              size: vertexData.byteLength,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            }),
          );
          device.queue.writeBuffer(vertexBuffer, 0, vertexData);
          const sizes = step.inputs.map(sizeOf);
          const entries: GPUBindGroupEntry[] = [];
          let block: UniformBlock | null = null;
          let uniformBuffer: GPUBuffer | null = null;
          if (program.uniformSize) {
            block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
            const values = bloomValues(program, pass, step, sizes, width, height);
            for (const [name, value] of Object.entries(values)) block.set(name, value);
            uniformBuffer = input.own(
              device.createBuffer({
                label,
                size: block.data.byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              }),
            );
            device.queue.writeBuffer(uniformBuffer, 0, block.data);
            entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
          }
          for (const binding of program.textures) {
            const source = step.inputs[binding.slot];
            if (!source || binding.kind !== "2d")
              throw new SceneRenderError([`render:bloom-slot:${step.pass}:${binding.slot}`]);
            const view = source.kind === "framebuffer" ? input.source : targets[source.index].view;
            entries.push({ binding: binding.binding, resource: view });
            entries.push({ binding: binding.samplerBinding, resource: sampler });
          }
          return {
            step,
            label,
            // 场景目标与中间 RT 同格式；全部只写 RGB（write mask 7，J5）；上采样 SrcAlpha / One，其余关闭混合
            pipeline: await input.pipelineFor(program, step.additive ? "additive" : null, input.format),
            vertexBuffer,
            bindGroup: device.createBindGroup({ label, layout: program.bindGroupLayout, entries }),
            block,
            uniformBuffer,
            program,
            pass,
            sizes,
          };
        }),
      )),
    );
    return chain;
  }

  /**
   * 按步骤编码；`sceneView` 是场景目标（combine 写它）。`after` 在每步之后调用（dev 探针读回中间结果用）。
   * 每步一个 render pass、`load`：下采样整张覆盖，上采样加在本帧的下采样结果上。
   */
  encode(
    encoder: GPUCommandEncoder,
    sceneView: GPUTextureView,
    after?: (index: number, step: BloomStep, encoder: GPUCommandEncoder) => void,
  ): void {
    this.draws.forEach((draw, index) => {
      const view = draw.step.target.kind === "scene" ? sceneView : this.targets[draw.step.target.index].view;
      const pass = encoder.beginRenderPass({
        label: draw.label,
        colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
      });
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(0, draw.bindGroup);
      pass.setVertexBuffer(0, draw.vertexBuffer);
      pass.draw(4);
      pass.end();
      after?.(index, draw.step, encoder);
    });
  }
}
