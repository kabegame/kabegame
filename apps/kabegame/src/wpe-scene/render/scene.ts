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
 * - HDR：场景目标、快照、合成 RT 都是 `rgba16float`（`*_backbuffer` fbo 编译期已换算），图层颜色乘 `brightness`（B10）。
 */
import { HDR_BLOOM_MATERIALS, LDR_BLOOM_MATERIALS } from "../compile/bloom";
import type { SceneBundle, SceneLayer, SceneTexture } from "../compile/bundle";
import { FBO_FORMATS } from "../compile/tex";
import type { TextureBinding } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { oneLine, SceneRenderError } from "./errors";
import { FboBindings, fboSize, planLayer, type DrawStep, type TargetRef, type TextureRef } from "./graph";
import { layerModelMatrix, layerQuad, sceneTargetSize, sceneViewProjection } from "./layout";
import { identity, invert, multiply, orthographic, scaling } from "./math";
import { createPipeline, createProgram, type GpuProgram } from "./programs";
import { requiredFeatures, samplerDescriptor, uploadTexture } from "./textures";
import { frameBuiltins, staticBuiltins, UniformBlock, type FrameInput, type UniformEntry } from "./uniforms";

/** 离屏目标格式：WPE 在 gamma 空间混合，用非 sRGB 格式。合成 RT 在 LDR 下也是它（B5）。 */
export const SCENE_TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";
/** HDR 下的场景目标、快照与合成 RT（A4，J5 抓帧：后备缓冲与合成 RT 都是 RGBA16F）。 */
export const HDR_TARGET_FORMAT: GPUTextureFormat = "rgba16float";

export function sceneTargetFormat(hdr: boolean): GPUTextureFormat {
  return hdr ? HDR_TARGET_FORMAT : SCENE_TARGET_FORMAT;
}

/** 每像素字节（显存估算用）。 */
function texelBytes(format: GPUTextureFormat): number {
  if (format === "rgba16float") return 8;
  if (format === "rg16float") return 4;
  if (format === "r16float" || format === "rg8unorm") return 2;
  if (format === "r8unorm") return 1;
  return 4;
}

/** 画进合成 RT 的基础 pass 用的正交深度范围（图层 z 为 0）。 */
const FILL_DEPTH = 10000;

interface RenderTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

/** 一个图层用到的合成 RT（可能来自共享池）与 fbo 名 → `targets` 下标的对应。 */
interface LayerResources {
  composites: RenderTarget[];
  fbos: FboBindings;
}

interface Draw {
  label: string;
  step: DrawStep;
  resources: LayerResources;
  pipeline: GPURenderPipeline;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer | null;
  block: UniformBlock | null;
  /** 需要每帧刷新的内置 uniform 名（被材质值覆盖的不刷）。 */
  frameNames: string[];
  /** 不引用 fbo 时建一次；引用 fbo 时按当前 swap 状态取（`bindGroups` 缓存）。 */
  bindGroup: GPUBindGroup | null;
  bindGroups: Map<string, GPUBindGroup>;
  entries: (resolveFbo: (effect: number, name: string) => RenderTarget) => GPUBindGroupEntry[];
  layout: GPUBindGroupLayout;
}

type Op =
  | { kind: "draw"; draw: Draw }
  | { kind: "snapshot" }
  | { kind: "copy"; resources: LayerResources; effect: number; source: TextureRef; target: TargetRef }
  | { kind: "swap"; resources: LayerResources; effect: number; source: string; target: string }
  | { kind: "bloom"; chain: BloomChain };

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
  for (const layer of bundle.layers) {
    if (!layer.visible || !layer.passes.length) continue;
    const plan = planLayer(layer, bundle.textures);
    for (const reason of plan.reasons) reasons.add(reason);
    for (const step of plan.steps) {
      if (step.kind !== "draw") continue;
      if (step.pass.program === null || !bundle.programs[step.pass.program]) reasons.add("render:no-program");
      for (const ref of Object.values(step.inputs))
        if (ref.kind === "texture" && !bundle.textures[ref.index]?.mips.length)
          reasons.add(`render:texture-missing:${ref.index}`);
    }
  }
  return [...reasons];
}

export class GpuScene {
  private readonly owned: { destroy(): void }[] = [];
  private readonly ops: Op[] = [];
  private readonly draws: Draw[] = [];
  /** fbo 实体（`FboBindings` 的下标指向这里）。 */
  private readonly targets: RenderTarget[] = [];
  private target: GPUTexture | null = null;
  private snapshot: RenderTarget | null = null;
  targetView: GPUTextureView | null = null;
  width = 0;
  height = 0;
  /** 场景目标、快照与合成 RT 的格式（HDR 为 `rgba16float`）。 */
  format: GPUTextureFormat = SCENE_TARGET_FORMAT;
  /** 渲染目标类资源（场景目标、快照、合成 RT、fbo、泛光 RT）的显存估算，字节；不含场景纹理。 */
  targetBytes = 0;
  private bloom: BloomChain | null = null;
  private clear: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

  private constructor(private readonly device: GPUDevice) {}

  /** 离屏场景目标（dev 探针同步读回用）。 */
  get targetTexture(): GPUTexture | null {
    return this.target;
  }

  /**
   * 建全部资源。失败时已建的资源都会释放，抛 `SceneRenderError`；`warnings` 收集 Tint 的非错误消息。
   * `ignoreUnsupported`：dev 强制渲染（D4），不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。
   */
  static async build(
    device: GPUDevice,
    bundle: SceneBundle,
    features: ReadonlySet<string>,
    warnings: string[],
    options: { ignoreUnsupported?: boolean } = {},
  ): Promise<GpuScene> {
    const reasons = checkRenderable(bundle, features, options);
    if (reasons.length) throw new SceneRenderError(reasons);
    const scene = new GpuScene(device);
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let failure: unknown = null;
    try {
      await scene.populate(bundle, warnings);
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
    return scene;
  }

  private own<T extends { destroy(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
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

  private async populate(bundle: SceneBundle, warnings: string[]): Promise<void> {
    const device = this.device;
    const { general } = bundle;
    const [width, height] = sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D);
    const hdr = general.postprocess.hdr;
    const format = (this.format = sceneTargetFormat(hdr));
    this.width = width;
    this.height = height;
    this.target = this.own(
      device.createTexture({
        label: "scene target",
        size: { width, height },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    this.targetView = this.target.createView();
    const [r = 0, g = 0, b = 0] = general.clearEnabled ? general.clearColor : [];
    this.clear = { r, g, b, a: 1 };

    const textures = bundle.textures.map((texture) => this.own(uploadTexture(device, texture)));
    const samplers = new Map<string, GPUSampler>();
    const sampler = (descriptor: GPUSamplerDescriptor): GPUSampler => {
      const key = JSON.stringify(descriptor);
      let found = samplers.get(key);
      if (!found) samplers.set(key, (found = device.createSampler(descriptor)));
      return found;
    };
    const samplerFor = (texture: SceneTexture) => sampler(samplerDescriptor(texture, texture.mips.length > 1));
    const dummies = this.createDummies();

    const visible = bundle.layers.filter((layer) => layer.visible && layer.passes.length);
    const plans = visible.map((layer) => planLayer(layer, bundle.textures));

    // 程序：全部建完再汇总失败，Tint 报告一次列全
    const used = new Set<number>();
    for (const plan of plans)
      for (const step of plan.steps)
        if (step.kind === "draw" && step.pass.program !== null) used.add(step.pass.program);
    for (const pass of Object.values(bundle.bloom?.passes ?? {}))
      if (pass?.program !== null && pass?.program !== undefined) used.add(pass.program);
    const settled = await Promise.allSettled(
      [...used].map((index) => createProgram(device, bundle.programs[index], index, warnings)),
    );
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

    const pipelines = new Map<string, Promise<GPURenderPipeline>>();
    const pipelineFor = (program: GpuProgram, blending: string | null, format: GPUTextureFormat, alpha: boolean) => {
      const key = `${program.index}|${blending}|${format}|${alpha}`;
      let pipeline = pipelines.get(key);
      if (!pipeline) pipelines.set(key, (pipeline = createPipeline(device, program, blending, format, alpha)));
      return pipeline;
    };

    // 快照：有图层要 `_rt_FullFrameBuffer`、或要跑泛光链才建（两者共用一张，泛光在全部图层之后再拷一次）
    const wantsSnapshot =
      !!bundle.bloom ||
      plans.some((plan) =>
        plan.steps.some(
          (step) =>
            step.kind === "snapshot" ||
            (step.kind === "draw" && Object.values(step.inputs).some((ref) => ref.kind === "framebuffer")),
        ),
      );
    if (wantsSnapshot) {
      const texture = this.own(
        device.createTexture({
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
        sampler: sampler({ magFilter: "linear", minFilter: "linear" }),
      };
    }

    const compositePool = new Map<string, RenderTarget[]>();
    const fboPool = new Map<string, number>();
    const setup = device.createCommandEncoder({ label: "scene setup" });
    const viewProjection = sceneViewProjection(general);
    const drawTasks: Promise<void>[] = [];

    plans.forEach((plan, index) => {
      const layer = visible[index];
      const base = layer.passes[0].textures[0];
      const baseTexture = base === undefined ? undefined : bundle.textures[base];
      // 合成 RT 的采样跟随基础纹理（WPE 用图层的 nointerpolation / clampuvs，LWE 用基础纹理的 flags）
      const clamp = baseTexture ? baseTexture.clampUVs : true;
      const nearest = baseTexture?.noInterpolation ?? false;
      const composites: RenderTarget[] = [];
      if (plan.composite) {
        const { width: cw, height: ch, count } = plan.composite;
        const key = `${cw}x${ch}|${clamp}|${nearest}`;
        const pool = compositePool.get(key) ?? [];
        compositePool.set(key, pool);
        const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
        const filter: GPUFilterMode = nearest ? "nearest" : "linear";
        while (pool.length < count)
          pool.push(
            this.createTarget(
              `composite ${key} #${pool.length}`,
              cw,
              ch,
              format,
              sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
            ),
          );
        composites.push(...pool.slice(0, count));
      }
      const compositeSize: [number, number] = plan.composite ? [plan.composite.width, plan.composite.height] : [4, 4];
      const maps = layer.effects.map(
        (effect) =>
          new Map(
            effect.fbos.map((fbo) => {
              const [fw, fh] = fboSize(fbo, compositeSize);
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
                  sampler({ addressModeU: address, addressModeV: address, magFilter: "linear", minFilter: "linear" }),
                );
                id = this.targets.length;
                this.targets.push(target);
                fboPool.set(key, id);
                // 创建后清成 `clear` 色；没写时 WebGPU 纹理本来就是全 0
                if (fbo.clear) {
                  const [cr, cg, cb, ca] = fbo.clear;
                  setup
                    .beginRenderPass({
                      label: `clear ${key}`,
                      colorAttachments: [
                        {
                          view: target.view,
                          clearValue: { r: cr, g: cg, b: cb, a: ca },
                          loadOp: "clear",
                          storeOp: "store",
                        },
                      ],
                    })
                    .end();
                }
              }
              return [fbo.name, id] as const;
            }),
          ),
      );
      const resources: LayerResources = { composites, fbos: new FboBindings(maps) };
      for (const step of plan.steps) {
        if (step.kind === "snapshot") this.ops.push({ kind: "snapshot" });
        else if (step.kind === "swap") {
          const a = this.targets[resources.fbos.resolve(step.effect, step.source)];
          const b = this.targets[resources.fbos.resolve(step.effect, step.target)];
          if (a.format !== b.format || a.width !== b.width || a.height !== b.height)
            throw new SceneRenderError([`render:swap-mismatch:${step.source}:${step.target}`]);
          this.ops.push({ kind: "swap", resources, effect: step.effect, source: step.source, target: step.target });
        } else if (step.kind === "copy") {
          const source = this.resolveTexture(step.source, resources);
          const target = this.resolveTarget(step.target, resources);
          if (!source || !target || source.format !== target.format)
            throw new SceneRenderError([`render:copy-format:${layer.name}`]);
          this.ops.push({ kind: "copy", resources, effect: step.effect, source: step.source, target: step.target });
        } else {
          const program = programs.get(step.pass.program!)!;
          const op: Op = { kind: "draw", draw: null as unknown as Draw };
          this.ops.push(op);
          drawTasks.push(
            this.createDraw(
              bundle,
              layer,
              step,
              resources,
              program,
              viewProjection,
              textures,
              dummies,
              samplerFor,
              pipelineFor,
            ).then((draw) => {
              op.draw = draw;
              this.draws.push(draw);
            }),
          );
        }
      }
    });
    // 泛光：全部图层之后（A1 / A3）
    if (bundle.bloom && this.snapshot) {
      const chain = await BloomChain.create({
        device,
        bloom: bundle.bloom,
        params: general.bloom,
        programs,
        format,
        width,
        height,
        source: this.snapshot.view,
        pipelineFor: (program, blending, target) => pipelineFor(program, blending, target, false),
        own: (resource) => this.own(resource),
      });
      this.bloom = chain;
      this.targetBytes += chain.bytes;
      this.ops.push({ kind: "bloom", chain });
    }
    await Promise.all(drawTasks);
    device.queue.submit([setup.finish()]);
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

  private async createDraw(
    bundle: SceneBundle,
    layer: SceneLayer,
    step: DrawStep,
    resources: LayerResources,
    program: GpuProgram,
    viewProjection: Float32Array,
    textures: GPUTexture[],
    dummies: ReturnType<GpuScene["createDummies"]>,
    samplerFor: (texture: SceneTexture) => GPUSampler,
    pipelineFor: (
      program: GpuProgram,
      blending: string | null,
      format: GPUTextureFormat,
      alpha: boolean,
    ) => Promise<GPURenderPipeline>,
  ): Promise<Draw> {
    const device = this.device;
    const { pass } = step;
    const label = `layer ${layer.id} ${layer.name} ${step.role}`;

    // 几何：图层四边形（模型空间、未缩放的 size），或 NDC 全屏四边形
    const vertices = step.geometry === "fullscreen" ? layerQuad([2, 2], [1, 1]) : layerQuad(layer.size, step.uv);
    const vertexData = program.vertexPacking.pack(vertices);
    const vertexBuffer = this.own(
      device.createBuffer({
        label,
        size: vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);

    const sizeOf = (ref: TextureRef | undefined) => {
      if (!ref) return undefined;
      if (ref.kind === "texture") return bundle.textures[ref.index];
      const target = this.resolveTexture(ref, resources);
      return target
        ? { width: target.width, height: target.height, textureWidth: target.width, textureHeight: target.height }
        : undefined;
    };

    // uniform：内置值打底，材质常量 / 用户属性覆盖
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let frameNames: string[] = [];
    if (program.uniformSize) {
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const slots = Math.max(10, ...program.textures.map((t) => t.slot + 1));
      const matrices = drawMatrices(step, layer, viewProjection);
      const builtins = staticBuiltins({
        ...matrices,
        modelViewProjectionInverse: invert(matrices.modelViewProjection),
        layer,
        // HDR 下颜色乘 brightness（B10）；passthrough 的 g_Color4 由材质值覆盖成 (1, 1, 1, 1)
        colorScale: bundle.general.postprocess.hdr ? layer.brightness : 1,
        textures: Array.from({ length: slots }, (_, slot) => sizeOf(step.inputs[slot])),
        screenSize: [this.width, this.height],
        eye: bundle.general.camera.eye,
        ambient: bundle.general.ambient,
        skylight: bundle.general.skylight,
      });
      for (const [name, values] of Object.entries(builtins)) block.set(name, values);
      for (const [name, values] of Object.entries(pass.uniforms)) block.set(name, values);
      frameNames = Object.keys(
        frameBuiltins({ time: 0, frametime: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0] }),
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
          view = dummies.views[binding.kind];
          sampler = binding.kind === "2d-comparison" ? dummies.comparison : dummies.sampler;
        } else {
          if (binding.kind !== "2d")
            throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
          if (ref.kind === "texture") {
            view = textures[ref.index].createView();
            sampler = samplerFor(bundle.textures[ref.index]);
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

    const toScene = step.target.kind === "scene";
    const format = toScene ? this.format : (this.resolveTarget(step.target, resources)?.format ?? this.format);
    return {
      label,
      step,
      resources,
      pipeline: await pipelineFor(program, step.blending, format, !toScene),
      vertexBuffer,
      uniformBuffer,
      block,
      frameNames,
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

  /** 写每帧变化的 uniform（`g_Time` 等）。 */
  update(frame: FrameInput): void {
    const values = frameBuiltins(frame);
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer || !draw.frameNames.length) continue;
      for (const name of draw.frameNames) draw.block.set(name, values[name]);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
    }
  }

  /**
   * 按图层顺序执行全部步骤，结果在离屏场景目标里。`afterBloomStep`：泛光链每步之后调用（dev 探针读回中间结果用）。
   */
  encode(encoder: GPUCommandEncoder, afterBloomStep?: Parameters<BloomChain["encode"]>[2]): void {
    if (!this.targetView || !this.target) return;
    const sceneView = this.targetView;
    const sceneTexture = this.target;
    const snapshot = () => {
      if (this.snapshot)
        encoder.copyTextureToTexture(
          { texture: sceneTexture },
          { texture: this.snapshot.texture },
          { width: this.width, height: this.height },
        );
    };
    let open: GPURenderPassEncoder | null = null;
    let cleared = false;
    const begin = (): GPURenderPassEncoder => {
      if (!open) {
        open = encoder.beginRenderPass({
          label: "scene",
          colorAttachments: [
            { view: sceneView, clearValue: this.clear, loadOp: cleared ? "load" : "clear", storeOp: "store" },
          ],
        });
        cleared = true;
      }
      return open;
    };
    const end = () => {
      open?.end();
      open = null;
    };
    const draw = (pass: GPURenderPassEncoder, item: Draw) => {
      pass.setPipeline(item.pipeline);
      pass.setBindGroup(0, this.bindGroupOf(item));
      pass.setVertexBuffer(0, item.vertexBuffer);
      pass.draw(4);
    };
    for (const op of this.ops) {
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
        if (!cleared) begin();
        end();
        snapshot();
      } else if (op.kind === "bloom") {
        // 全部图层画完：整帧快照（只拷这一次）→ 泛光链 → combine 写回场景目标
        if (!cleared) begin();
        end();
        snapshot();
        op.chain.encode(encoder, sceneView, afterBloomStep);
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
    if (!cleared) begin();
    end();
  }

  destroy(): void {
    for (const resource of this.owned.splice(0)) resource.destroy();
    this.draws.length = 0;
    this.ops.length = 0;
    this.targets.length = 0;
    this.target = null;
    this.targetView = null;
    this.snapshot = null;
    this.bloom = null;
  }
}

/**
 * 各角色的变换（PLAN P2a「内置 uniform」，w、h 取图层 `size`）：
 * - `direct`：P1 原样，`g_ModelViewProjectionMatrix` = 场景视图投影 × 图层模型矩阵；
 * - `base`：正交投影把图层四边形画满合成 RT，单位模型矩阵（B7）；
 * - `effect`：NDC 全屏四边形、MVP 为单位阵；`g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)，
 *   `g_EffectModelViewProjectionMatrix` = 图层 MVP × 同一缩放，纹理投影与后者相同；
 * - `final` / `passthrough`：图层四边形用图层 MVP 上屏；效果矩阵不缩放，纹理投影 = MVP × scale(w/2, h/2)。
 */
export function drawMatrices(
  step: Pick<DrawStep, "role">,
  layer: Pick<SceneLayer, "origin" | "angles" | "scale" | "size">,
  viewProjection: Float32Array,
) {
  const model = layerModelMatrix(layer);
  const layerMvp = multiply(viewProjection, model);
  const hw = (layer.size[0] ?? 0) / 2,
    hh = (layer.size[1] ?? 0) / 2;
  const half = scaling(hw, hh, 1);
  switch (step.role) {
    case "base": {
      const fill = orthographic(-(hw || 1), hw || 1, -(hh || 1), hh || 1, -FILL_DEPTH, FILL_DEPTH);
      return { modelViewProjection: fill, model: identity(), viewProjection: fill };
    }
    case "effect": {
      const effectMvp = multiply(layerMvp, half);
      return {
        modelViewProjection: identity(),
        model: identity(),
        viewProjection,
        effectModel: multiply(model, half),
        effectModelViewProjection: effectMvp,
        effectTextureProjection: effectMvp,
      };
    }
    case "final":
    case "passthrough":
      return {
        modelViewProjection: layerMvp,
        model,
        viewProjection,
        effectModel: model,
        effectModelViewProjection: layerMvp,
        effectTextureProjection: multiply(layerMvp, half),
      };
    default:
      return { modelViewProjection: layerMvp, model, viewProjection };
  }
}
