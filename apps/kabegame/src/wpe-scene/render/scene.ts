/**
 * 一份 `SceneBundle` 在某个设备上的全部 GPU 资源：纹理、程序与管线、每个图层 pass 的顶点 / uniform 缓冲与 bind group，
 * 以及场景分辨率的离屏目标。每帧按图层顺序把每个材质 pass 画进离屏目标；铺到画布由 `SceneRenderer` 负责。
 *
 * P1 的图层都只有一个材质 pass、没有 effect，所以 pass 直接画进场景目标（LWE 里「最后一个 pass 画到场景」的那条路径）；
 * 多 pass 材质需要每图层两张合成纹理做 ping-pong（P2），遇到时按 `render:multi-pass` 退回。
 */
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import type { TextureBinding } from "../wpesl2wgsl";
import { oneLine, SceneRenderError } from "./errors";
import { layerModelMatrix, layerQuad, sceneTargetSize, sceneViewProjection, textureUvExtent } from "./layout";
import { invert, multiply } from "./math";
import { createPipeline, createProgram, type GpuProgram } from "./programs";
import { requiredFeatures, samplerDescriptor, uploadTexture } from "./textures";
import { frameBuiltins, staticBuiltins, UniformBlock, type FrameInput, type UniformEntry } from "./uniforms";

/** 离屏目标格式：WPE 在 gamma 空间混合，用非 sRGB 格式。 */
export const SCENE_TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";

interface Draw {
  label: string;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer | null;
  block: UniformBlock | null;
  /** 需要每帧刷新的内置 uniform 名（被材质值覆盖的不刷）。 */
  frameNames: string[];
}

/** 渲染器能画的 bundle 结构；不能画的整理成原因键（编译期能力表之外的渲染器自查）。 */
export function checkRenderable(bundle: SceneBundle, features: ReadonlySet<string>): string[] {
  const reasons = new Set<string>(bundle.unsupported);
  for (const feature of requiredFeatures(bundle.textures))
    if (!features.has(feature))
      reasons.add(feature === "texture-compression-bc" ? "webgpu:no-bc" : `webgpu:${feature}`);
  for (const layer of bundle.layers) {
    if (!layer.visible || !layer.passes.length) continue;
    if (layer.passes.length > 1) reasons.add("render:multi-pass");
    for (const pass of layer.passes) {
      if (pass.program === null || !bundle.programs[pass.program]) reasons.add("render:no-program");
      for (const index of Object.values(pass.textures))
        if (!bundle.textures[index]?.mips.length) reasons.add(`render:texture-missing:${index}`);
    }
  }
  return [...reasons];
}

export class GpuScene {
  private readonly owned: { destroy(): void }[] = [];
  private readonly draws: Draw[] = [];
  private target: GPUTexture | null = null;
  targetView: GPUTextureView | null = null;
  width = 0;
  height = 0;
  private clear: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

  private constructor(private readonly device: GPUDevice) {}

  /**
   * 建全部资源。失败时已建的资源都会释放，抛 `SceneRenderError`；`warnings` 收集 Tint 的非错误消息。
   */
  static async build(
    device: GPUDevice,
    bundle: SceneBundle,
    features: ReadonlySet<string>,
    warnings: string[],
  ): Promise<GpuScene> {
    const reasons = checkRenderable(bundle, features);
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

  private async populate(bundle: SceneBundle, warnings: string[]): Promise<void> {
    const device = this.device;
    const { general } = bundle;
    const textures = bundle.textures.map((texture) => this.own(uploadTexture(device, texture)));
    const samplers = new Map<string, GPUSampler>();
    const samplerFor = (texture: SceneTexture): GPUSampler => {
      const descriptor = samplerDescriptor(texture, texture.mips.length > 1);
      const key = JSON.stringify(descriptor);
      let sampler = samplers.get(key);
      if (!sampler) samplers.set(key, (sampler = device.createSampler(descriptor)));
      return sampler;
    };
    const dummies = this.createDummies();

    // 程序：全部建完再汇总失败，Tint 报告一次列全
    const visible = bundle.layers.filter((layer) => layer.visible);
    const used = new Set(visible.flatMap((layer) => layer.passes.map((pass) => pass.program!)));
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
    const pipelineFor = (program: GpuProgram, blending: string) => {
      const key = `${program.index}|${blending}`;
      let pipeline = pipelines.get(key);
      if (!pipeline) pipelines.set(key, (pipeline = createPipeline(device, program, blending, SCENE_TARGET_FORMAT)));
      return pipeline;
    };

    const viewProjection = sceneViewProjection(general);
    const drawTasks: Promise<Draw>[] = [];
    for (const layer of visible) {
      for (const pass of layer.passes) {
        const program = programs.get(pass.program!)!;
        drawTasks.push(
          this.createDraw(bundle, layer, pass, program, viewProjection, textures, dummies, samplerFor, pipelineFor),
        );
      }
    }
    this.draws.push(...(await Promise.all(drawTasks)));

    const [width, height] = sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D);
    this.width = width;
    this.height = height;
    this.target = this.own(
      device.createTexture({
        label: "scene target",
        size: { width, height },
        format: SCENE_TARGET_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.targetView = this.target.createView();
    const [r = 0, g = 0, b = 0] = general.clearEnabled ? general.clearColor : [];
    this.clear = { r, g, b, a: 1 };
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

  private async createDraw(
    bundle: SceneBundle,
    layer: SceneLayer,
    pass: ScenePass,
    program: GpuProgram,
    viewProjection: Float32Array,
    textures: GPUTexture[],
    dummies: ReturnType<GpuScene["createDummies"]>,
    samplerFor: (texture: SceneTexture) => GPUSampler,
    pipelineFor: (program: GpuProgram, blending: string) => Promise<GPURenderPipeline>,
  ): Promise<Draw> {
    const device = this.device;
    const label = `layer ${layer.id} ${layer.name}`;
    const bound = (slot: number): SceneTexture | undefined =>
      pass.textures[slot] === undefined ? undefined : bundle.textures[pass.textures[slot]];

    // 几何：纹理坐标按图层主纹理（第一个 pass 的槽位 0，同 LWE `detectTexture`）的填充比例收缩
    const vertices = layerQuad(layer.size, textureUvExtent(bound(0)));
    const vertexData = program.vertexPacking.pack(vertices);
    const vertexBuffer = this.own(
      device.createBuffer({
        label,
        size: vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);

    // uniform：内置值打底，材质常量 / 用户属性覆盖
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let frameNames: string[] = [];
    if (program.uniformSize) {
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const model = layerModelMatrix(layer);
      const mvp = multiply(viewProjection, model);
      const slots = Math.max(8, ...program.textures.map((t) => t.slot + 1));
      const builtins = staticBuiltins({
        modelViewProjection: mvp,
        modelViewProjectionInverse: invert(mvp),
        model,
        viewProjection,
        layer,
        textures: Array.from({ length: slots }, (_, slot) => bound(slot)),
        sceneSize: [bundle.general.width, bundle.general.height],
        eye: bundle.general.camera.eye,
      });
      for (const [name, values] of Object.entries(builtins)) block.set(name, values);
      for (const [name, values] of Object.entries(pass.uniforms)) block.set(name, values);
      frameNames = Object.keys(frameBuiltins({ time: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0] })).filter(
        (name) => block!.has(name) && !(name in pass.uniforms),
      );
      uniformBuffer = this.own(
        device.createBuffer({
          label,
          size: block.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
    }

    const entries: GPUBindGroupEntry[] = [];
    if (uniformBuffer) entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
    for (const binding of program.textures) {
      const index = pass.textures[binding.slot];
      const texture = index === undefined ? undefined : bundle.textures[index];
      if (texture && binding.kind !== "2d")
        throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
      entries.push({
        binding: binding.binding,
        resource: texture ? textures[index!].createView() : dummies.views[binding.kind],
      });
      entries.push({
        binding: binding.samplerBinding,
        resource:
          binding.kind === "2d-comparison" ? dummies.comparison : texture ? samplerFor(texture) : dummies.sampler,
      });
    }
    const bindGroup = device.createBindGroup({ label, layout: program.bindGroupLayout, entries });
    return {
      label,
      pipeline: await pipelineFor(program, pass.blending),
      bindGroup,
      vertexBuffer,
      uniformBuffer,
      block,
      frameNames,
    };
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

  /** 按图层顺序画进离屏目标。 */
  encode(encoder: GPUCommandEncoder): void {
    if (!this.targetView) return;
    const pass = encoder.beginRenderPass({
      label: "scene",
      colorAttachments: [{ view: this.targetView, clearValue: this.clear, loadOp: "clear", storeOp: "store" }],
    });
    for (const draw of this.draws) {
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(0, draw.bindGroup);
      pass.setVertexBuffer(0, draw.vertexBuffer);
      pass.draw(4);
    }
    pass.end();
  }

  destroy(): void {
    for (const resource of this.owned.splice(0)) resource.destroy();
    this.draws.length = 0;
    this.target = null;
    this.targetView = null;
  }
}
