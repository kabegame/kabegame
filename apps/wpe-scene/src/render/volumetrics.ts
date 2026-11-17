/**
 * 体积光的 GPU 执行（P13e，`.claude/plans/wpe-import/3-scene/phase13/phase-13e-volumetrics.md`；读码 rea-p13-volumetrics，编译见
 * `compile/volumetrics.ts`）。一盏灯（`encodeLight`）：
 * 1. 场景深度 → `_rt_volumetricsBack`（全分辨率）。WPE 是 `CopyResource` 到 R32，正面着色器用 **Linear + Wrap** 采样它；WebGPU 的深度纹理
 *    不能线性过滤，这里用一个小 pass 把深度写进 `r32float`（要 `float32-filterable`，没有时 `checkRenderable` 报 `render:volumetrics`）；
 * 2. 1/d 的 Single 深度清 0，画灯体背面（GREATER、写深度、剔正面，反向深度下留下最近的背面）；再同样转成 `r32float` 供 `texLoad2D`；
 * 3. 组内第一盏把 LightBuffer 清成 (0, 0, 0, 1)；画灯体正面（剔背面、不测深度、SrcAlpha / One、只写 RGB），相机在灯体内时换全屏三角形
 *    （`FULLSCREEN = 1`，背面照画，V4）。
 * 合成（`encodeComposite`）：低 / 中档 `blur_h`（LightBuffer → B）、`blur_v`（B → LightBuffer），再 `passthrough` 加法画回场景目标、只写 RGB。
 * 什么时候合成由 `render/scene.ts` 按 WPE 的规则定（下一个可见的非灯对象之前，或列表末尾，V5）。
 */
import type { ScenePass } from "../compile/bundle";
import {
  glmInverse,
  pointLightSphere,
  spotLightCylinder,
  volumetricsBlurs,
  volumetricsTargetSize,
  type SceneVolumetrics,
  type VolumetricGeometry,
  type VolumetricLight,
  type VolumetricMesh,
} from "../compile/volumetrics";
import { SceneRenderError } from "./errors";
import { fullscreenTriangle } from "./layout";
import type { Mat4 } from "./math";
import { createPipeline, SCENE_DEPTH_FORMAT, type GpuProgram } from "./programs";
import { textureBuiltins, UniformBlock, type UniformEntry } from "./uniforms";

const f = Math.fround;

/** 转换后的深度格式：要线性过滤（`float32-filterable`）。 */
export const VOLUMETRICS_DEPTH_COPY_FORMAT: GPUTextureFormat = "r32float";

/**
 * 相机是否在灯体内（V4，`0x1401979bd`–`0x1401980e5`，全程 float32）。`p = eye + F·0.2`（逐分量 `F·0.2 + eye`）：
 * - 点光：`r·r > (dx² + dy²) + dz²`（严格大于，r 是原始 radius）；
 * - 聚光：沿灯轴投影 `t = (a.y·d.y + a.z·d.z) + a.x·d.x`、离轴距离 `perp = |d − a·t|`，`t > 0 ∧ radius ≥ t ∧ (t / radius)·R_far ≥ perp`。
 * 正交场景照样判（eye 是 `g_EyePosition`，F = (0, 0, −1)）。
 */
export function insideLightVolume(
  light: Pick<VolumetricLight, "kind" | "radius" | "position" | "spot">,
  eye: readonly number[],
  forward: readonly number[],
): boolean {
  const p = [0, 1, 2].map((k) => f(f(f(forward[k]) * f(0.2)) + f(eye[k])));
  const d = [0, 1, 2].map((k) => f(p[k] - f(light.position[k])));
  const r = f(light.radius);
  if (light.kind === "point") return f(r * r) > f(f(f(d[0] * d[0]) + f(d[1] * d[1])) + f(d[2] * d[2]));
  if (!light.spot) return false;
  const a = light.spot.axis;
  const t = f(f(f(a[1] * d[1]) + f(a[2] * d[2])) + f(a[0] * d[0]));
  const q = [0, 1, 2].map((k) => f(d[k] - f(a[k] * t)));
  const perp = f(Math.sqrt(f(f(f(q[0] * q[0]) + f(q[1] * q[1])) + f(q[2] * q[2]))));
  return t > 0 && r >= t && f(f(t / r) * f(light.spot.farRadius)) >= perp;
}

/** 一盏灯这一帧的输入（`GpuScene` 给）。 */
export interface VolumetricLightFrame {
  /** 本次绘制的 `g_ViewProjectionMatrix`（正交 + 视差时含这盏灯根对象的视差偏移，V3）。 */
  viewProjection: Mat4;
  eye: readonly number[];
  forward: readonly number[];
  /** 带阴影的点光：这一帧阴影条目的方块变换（`g_RenderVar0`）与点光阴影投影（`g_RenderVar3`）。 */
  shadow?: { transform: ArrayLike<number>; projection: ArrayLike<number> };
  /** 这一帧的几何与常量（P13f2，按 `SceneState` 现算的 `volumetricGeometry`）；缺省用编译期的初值。 */
  geometry?: VolumetricGeometry;
}

interface VolumetricsDraw {
  label: string;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null;
  count: number;
  block: UniformBlock | null;
  uniformBuffer: GPUBuffer | null;
  pass: ScenePass;
}

interface LightDraws {
  light: VolumetricLight;
  back: VolumetricsDraw;
  front: VolumetricsDraw;
  fullscreen: VolumetricsDraw;
  /** 这一帧相机是否在灯体内（`frame` 写）。 */
  inside: boolean;
}

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

export interface VolumetricsInput {
  device: GPUDevice;
  volumetrics: SceneVolumetrics;
  programs: ReadonlyMap<number, GpuProgram>;
  /** 场景目标尺寸（WPE 的后备缓冲）。 */
  width: number;
  height: number;
  /** HDR：LightBuffer `rgba16float`，否则 `rgba8unorm`（LDR 下累加在合成前就钳到 1，V9）。 */
  hdr: boolean;
  sceneFormat: GPUTextureFormat;
  /** 场景深度（要 `TEXTURE_BINDING`）。 */
  depth: GPUTexture;
  /** 阴影图集（带阴影的点光读它，P13d）。 */
  shadowAtlas: { view: GPUTextureView; sampler: GPUSampler } | null;
  own<T extends { destroy(): void }>(resource: T): T;
}

/** 深度 → `r32float`：全屏三角形，按像素 `textureLoad`（两边同尺寸）。 */
const DEPTH_COPY_WGSL = `
@group(0) @binding(0) var source: texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, 1.0), vec2f(-1.0, -3.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(source, vec2i(position.xy), 0), 0.0, 0.0, 1.0);
}
`;

export class VolumetricsRenderer {
  private readonly lights: LightDraws[] = [];
  private readonly byObject = new Map<number, LightDraws>();
  private blurH: VolumetricsDraw | null = null;
  private blurV: VolumetricsDraw | null = null;
  private combine: VolumetricsDraw | null = null;
  private copyPipeline: GPURenderPipeline | null = null;
  private copyScene: GPUBindGroup | null = null;
  private copySingle: GPUBindGroup | null = null;

  private constructor(
    private readonly device: GPUDevice,
    readonly quality: number,
    private readonly back: Target,
    private readonly singleDepth: Target,
    private readonly single: Target,
    private readonly lightBuffer: Target,
    private readonly lightBufferB: Target | null,
  ) {}

  /** 体积光占的显存（字节）。 */
  get bytes(): number {
    const lb = this.lightBuffer.texture.format === "rgba16float" ? 8 : 4;
    const small = this.single.width * this.single.height;
    return this.back.width * this.back.height * 4 + small * 8 + small * lb * (this.lightBufferB ? 2 : 1);
  }

  /** 按 `objects` 下标排的灯（渲染器归并进图层序列）。 */
  get objects(): number[] {
    return this.lights.map((draws) => draws.light.object);
  }

  static async create(input: VolumetricsInput): Promise<VolumetricsRenderer> {
    const { device, volumetrics, width, height } = input;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const target = (label: string, w: number, h: number, format: GPUTextureFormat): Target => {
      const texture = input.own(device.createTexture({ label, size: { width: w, height: h }, format, usage }));
      return { texture, view: texture.createView(), width: w, height: h };
    };
    const [w, h] = volumetricsTargetSize(width, height, volumetrics.quality);
    const lbFormat: GPUTextureFormat = input.hdr ? "rgba16float" : "rgba8unorm";
    const renderer = new VolumetricsRenderer(
      device,
      volumetrics.quality,
      target("_rt_volumetricsBack", width, height, VOLUMETRICS_DEPTH_COPY_FORMAT),
      target("_rt_volumetricsSingle depth", w, h, SCENE_DEPTH_FORMAT),
      target("_rt_volumetricsSingle", w, h, VOLUMETRICS_DEPTH_COPY_FORMAT),
      target("_rt_volumetricsLightBuffer", w, h, lbFormat),
      volumetricsBlurs(volumetrics.quality) ? target("_rt_volumetricsLightBufferB", w, h, lbFormat) : null,
    );
    await renderer.build(input, lbFormat);
    return renderer;
  }

  private async build(input: VolumetricsInput, lbFormat: GPUTextureFormat): Promise<void> {
    const { device, volumetrics } = input;
    const programOf = (pass: ScenePass, name: string): GpuProgram => {
      const program = pass.program === null ? undefined : input.programs.get(pass.program);
      if (!program) throw new SceneRenderError([`render:volumetrics:${name}`]);
      return program;
    };
    // Back：WPE 的正面着色器用 Linear + Wrap 采样（D1 实测）；Single 用 texLoad2D，采样器不起作用
    const backSampler = device.createSampler({
      label: "_rt_volumetricsBack",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    const clampSampler = device.createSampler({
      label: "volumetrics composite",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const module = device.createShaderModule({ label: "volumetrics depth copy", code: DEPTH_COPY_WGSL });
    this.copyPipeline = await device.createRenderPipelineAsync({
      label: "volumetrics depth copy",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: VOLUMETRICS_DEPTH_COPY_FORMAT }] },
      primitive: { topology: "triangle-list" },
    });
    const copyGroup = (view: GPUTextureView, label: string) =>
      device.createBindGroup({
        label,
        layout: this.copyPipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view }],
      });
    this.copyScene = copyGroup(input.depth.createView(), "volumetrics copy scene depth");
    this.copySingle = copyGroup(this.singleDepth.view, "volumetrics copy single depth");

    const sphere = pointLightSphere();
    const cylinder = spotLightCylinder();
    const size = (t: Target) => ({ width: t.width, height: t.height, textureWidth: t.width, textureHeight: t.height });
    const atlas = input.shadowAtlas;
    for (const light of volumetrics.lights) {
      const mesh = light.kind === "point" ? sphere : cylinder;
      const backProgram = programOf(light.back, "back");
      const back = this.createDraw(
        input,
        `volumetrics ${light.object} back`,
        backProgram,
        light.back,
        await this.backPipeline(backProgram),
        mesh,
        [],
      );
      const textures = (program: GpuProgram): GPUBindGroupEntry[] =>
        program.textures.flatMap((binding) => {
          const view =
            binding.slot === 0
              ? atlas?.view
              : binding.slot === 1
                ? this.back.view
                : binding.slot === 3
                  ? this.single.view
                  : null;
          const sampler = binding.slot === 0 ? atlas?.sampler : backSampler;
          if (!view || !sampler) throw new SceneRenderError([`render:volumetrics-slot:${binding.slot}`]);
          return [
            { binding: binding.binding, resource: view },
            { binding: binding.samplerBinding, resource: sampler },
          ];
        });
      const frontProgram = programOf(light.front, "front");
      const front = this.createDraw(
        input,
        `volumetrics ${light.object} front`,
        frontProgram,
        light.front,
        await createPipeline(
          device,
          frontProgram,
          "additive",
          lbFormat,
          false,
          "triangle-list",
          false,
          undefined,
          "back",
        ),
        mesh,
        textures(frontProgram),
      );
      const fullscreenProgram = programOf(light.fullscreen, "fullscreen");
      const fullscreen = this.createDraw(
        input,
        `volumetrics ${light.object} fullscreen`,
        fullscreenProgram,
        light.fullscreen,
        await createPipeline(device, fullscreenProgram, "additive", lbFormat),
        null,
        textures(fullscreenProgram),
      );
      // 纹理分辨率与灯的常量不随帧变，建时写一次
      const statics = {
        ...textureBuiltins([undefined, size(this.back), undefined, size(this.single)]),
        ...light.constants,
      };
      for (const draw of [back, front, fullscreen]) this.write(draw, statics);
      const draws: LightDraws = { light, back, front, fullscreen, inside: false };
      this.lights.push(draws);
      this.byObject.set(light.object, draws);
    }
    const composite = (
      pass: ScenePass,
      name: string,
      source: Target,
      blending: string | null,
      format: GPUTextureFormat,
    ) =>
      (async () => {
        const program = programOf(pass, name);
        const draw = this.createDraw(
          input,
          `volumetrics ${name}`,
          program,
          pass,
          await createPipeline(device, program, blending, format, blending === null),
          null,
          program.textures.flatMap((binding) => [
            { binding: binding.binding, resource: source.view },
            { binding: binding.samplerBinding, resource: clampSampler },
          ]),
        );
        this.write(draw, textureBuiltins([size(source)]));
        return draw;
      })();
    if (this.lightBufferB && volumetrics.blurH && volumetrics.blurV) {
      this.blurH = await composite(volumetrics.blurH, "blur_h", this.lightBuffer, null, lbFormat);
      this.blurV = await composite(volumetrics.blurV, "blur_v", this.lightBufferB, null, lbFormat);
    }
    this.combine = await composite(volumetrics.combine, "combine", this.lightBuffer, "additive", input.sceneFormat);
  }

  /** 背面 pass：没有颜色附件（Single 只有深度），GREATER、写深度、剔正面（屏幕上逆时针为正面，同模型网格）。 */
  private async backPipeline(program: GpuProgram): Promise<GPURenderPipeline> {
    try {
      return await this.device.createRenderPipelineAsync({
        label: `volumetrics back ${program.index}`,
        layout: program.pipelineLayout,
        vertex: {
          module: program.vertex,
          entryPoint: program.result.vertex?.entryPoint ?? "main",
          buffers: [program.vertexPacking.layout],
        },
        primitive: { topology: "triangle-list", cullMode: "front", frontFace: "ccw" },
        depthStencil: { format: SCENE_DEPTH_FORMAT, depthCompare: "greater", depthWriteEnabled: true },
      });
    } catch (error) {
      throw new SceneRenderError([`webgpu:pipeline:${program.index}:volumetrics-back:${String(error).split("\n")[0]}`]);
    }
  }

  private createDraw(
    input: VolumetricsInput,
    label: string,
    program: GpuProgram,
    pass: ScenePass,
    pipeline: GPURenderPipeline,
    mesh: VolumetricMesh | null,
    textures: GPUBindGroupEntry[],
  ): VolumetricsDraw {
    const { device } = input;
    const vertices = mesh
      ? Array.from({ length: mesh.positions.length / 3 }, (_, i) => ({
          position: [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]] as [
            number,
            number,
            number,
          ],
          texCoord: [0, 0] as [number, number],
        }))
      : fullscreenTriangle();
    const vertexData = program.vertexPacking.pack(vertices);
    const vertexBuffer = input.own(
      device.createBuffer({
        label,
        size: Math.max(4, vertexData.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    let indexBuffer: GPUBuffer | null = null;
    if (mesh) {
      // 索引缓冲按 4 字节对齐（u16 个数为奇数时补一个）
      const indices = new Uint16Array(mesh.indices.length + (mesh.indices.length % 2));
      indices.set(mesh.indices);
      indexBuffer = input.own(
        device.createBuffer({ label, size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
      );
      device.queue.writeBuffer(indexBuffer, 0, indices);
    }
    const entries: GPUBindGroupEntry[] = [];
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    if (program.uniformSize) {
      // TODO:[WPE_SCENE_MCP] 这块 uniform 缓冲没调 `traceUniforms` 登记反射（`scene.ts`、`bloom.ts` 都登记了），逐 draw 轨迹
      // （render_scene 的 trace）对体积光的 draw 只给 `rawUniforms`、没有按名字解出 `g_RenderVar*` 等，走查时没法和 WPE 逐 draw 对常量
      // （P13f 走查 3465215190 时遇到，只能靠整帧逐像素比兜住）。补法：建缓冲后 `traceUniforms(uniformBuffer, program.result.uniforms)`
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      uniformBuffer = input.own(
        device.createBuffer({
          label,
          size: block.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      for (const [name, value] of Object.entries(pass.uniforms)) block.set(name, value);
      entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
    }
    entries.push(...textures);
    return {
      label,
      pipeline,
      bindGroup: device.createBindGroup({ label, layout: program.bindGroupLayout, entries }),
      vertexBuffer,
      indexBuffer,
      count: mesh ? mesh.indices.length : 3,
      block,
      uniformBuffer,
      pass,
    };
  }

  private write(draw: VolumetricsDraw, values: Record<string, ArrayLike<number>>): void {
    if (!draw.block || !draw.uniformBuffer) return;
    for (const [name, value] of Object.entries(values)) draw.block.set(name, value);
    this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
  }

  /**
   * 这一帧（相机与脚本之后）：每盏灯的 `g_ViewProjectionMatrix`、`g_EffectModelMatrix`（它的 GLM 逆，V3）、`g_EyePosition`，带阴影的点光
   * 写 `g_RenderVar0` / `g_RenderVar3`；灯的几何与常量按这一帧的状态写（P13f2，`geometry`）；判相机是否在灯体内。`frameOf` 返回 null 的灯
   * 跳过（这一帧不画的灯，渲染器另外不把它插进序列）。
   */
  frame(frameOf: (object: number) => VolumetricLightFrame | null): void {
    for (const draws of this.lights) {
      const input = frameOf(draws.light.object);
      if (!input) continue;
      const values: Record<string, ArrayLike<number>> = {
        g_ViewProjectionMatrix: input.viewProjection,
        g_EffectModelMatrix: glmInverse(input.viewProjection),
        g_EyePosition: input.eye,
      };
      // 灯字段、颜色、位置都是运行时状态（P13f2）：常量每帧写；点光的 `g_RenderVar3` 下面换成阴影投影
      const geometry = input.geometry ?? draws.light;
      Object.assign(values, geometry.constants);
      if (input.shadow) {
        values.g_RenderVar0 = input.shadow.transform;
        values.g_RenderVar3 = input.shadow.projection;
      }
      draws.inside = insideLightVolume({ kind: draws.light.kind, ...geometry }, input.eye, input.forward);
      this.write(draws.back, values);
      this.write(draws.inside ? draws.fullscreen : draws.front, values);
    }
  }

  /** 场景深度 → 一张 `r32float`（`copyScene` / `copySingle`）。 */
  private copyDepth(encoder: GPUCommandEncoder, bindGroup: GPUBindGroup, target: Target, label: string): void {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        { view: target.view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" },
      ],
    });
    pass.setPipeline(this.copyPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private draw(pass: GPURenderPassEncoder, draw: VolumetricsDraw): void {
    pass.setPipeline(draw.pipeline);
    pass.setBindGroup(0, draw.bindGroup);
    pass.setVertexBuffer(0, draw.vertexBuffer);
    if (draw.indexBuffer) {
      pass.setIndexBuffer(draw.indexBuffer, "uint16");
      pass.drawIndexed(draw.count);
    } else pass.draw(draw.count);
  }

  /**
   * 一盏灯（`objects` 下标 `object`）：拷场景深度、画背面、转 Single、（`first` 时清 LightBuffer）画正面。调用前场景目标的 pass 要结束
   * （读场景深度）。
   */
  encodeLight(encoder: GPUCommandEncoder, object: number, first: boolean): void {
    const draws = this.byObject.get(object);
    if (!draws) return;
    this.copyDepth(encoder, this.copyScene!, this.back, "_rt_volumetricsBack");
    const backPass = encoder.beginRenderPass({
      label: "_rt_volumetricsSingle",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.singleDepth.view,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    this.draw(backPass, draws.back);
    backPass.end();
    this.copyDepth(encoder, this.copySingle!, this.single, "_rt_volumetricsSingle r32");
    const frontPass = encoder.beginRenderPass({
      label: "_rt_volumetricsLightBuffer",
      colorAttachments: [
        {
          view: this.lightBuffer.view,
          loadOp: first ? "clear" : "load",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    this.draw(frontPass, draws.inside ? draws.fullscreen : draws.front);
    frontPass.end();
  }

  /** 合成：（低 / 中档）横竖模糊，再加法画进 `sceneView`（只写 RGB）。调用前场景目标的 pass 要结束。 */
  encodeComposite(encoder: GPUCommandEncoder, sceneView: GPUTextureView): void {
    const run = (draw: VolumetricsDraw, view: GPUTextureView) => {
      const pass = encoder.beginRenderPass({
        label: draw.label,
        colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
      });
      this.draw(pass, draw);
      pass.end();
    };
    if (this.blurH && this.blurV && this.lightBufferB) {
      run(this.blurH, this.lightBufferB.view);
      run(this.blurV, this.lightBuffer.view);
    }
    run(this.combine!, sceneView);
  }

  /** dev 探针读回：LightBuffer（合成前）。 */
  get lightBufferTexture(): GPUTexture {
    return this.lightBuffer.texture;
  }
}
