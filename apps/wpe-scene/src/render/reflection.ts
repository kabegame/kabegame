/**
 * 反射用的两张 RT（P13b1 的「反射关」；P13b2 的反射 pass 在 `scene.ts`；P13g 的屏幕空间反射每帧更新在这里）。
 *
 * WPE 的用户设置 `reflection` 管两样东西（rea-p13-passes 第 1、4 节）：平面反射 pass（`_rt_Reflection`）与屏幕空间反射用的 mip 帧缓冲
 * （`_rt_MipMappedFrameBuffer`）。设置关着时两样都不画，只剩两张内容固定的纹理：
 * - `_rt_Reflection`：场景目标尺寸、RGBA8（HDR 下也是），每帧在主 pass 之前清成 `(clearcolor, 1)`，不看 `clearenabled`（步骤 0 R1、R4、R6）；
 *   采样器 Clamp + Linear。
 * - `_rt_MipMappedFrameBuffer`：场景目标尺寸、格式跟场景目标（HDR 时 RGBA16F）、
 *   `max(1, min(log2(npot(w) / 2), log2(npot(h) / 2)) − 2)` 级 mip（1920×1080 → 8、1280×720 → 7，步骤 0 R7），建好时各级清成
 *   `(0, 0, 0, 1)` 一次，之后不更新、不随清屏色；采样器 Clamp + 三线性。
 *
 * 设置开时（P13g，`bundle.mipFramebuffer.update`）mip 帧缓冲每帧在主 pass 之后、泛光之前更新（`encodeMipFramebuffer`）：场景目标整张拷进
 * 0 级，再逐级缩小。WPE 是 `ResolveSubresource` + D3D11 `GenerateMips`（p13g 抓帧：拷贝与主 pass 结束时的后备缓冲逐值相同；各级是在
 * 目标纹素中心对上一级做一次双线性采样，取整是硬件写 RGBA8 / 半精度时的规则），我们在同一块 GPU 上用同样的采样写同样的格式。
 * 开着时建好不清屏（WPE 只在关时清；新纹理两边都是 0，只影响第一帧）。
 *
 * 两张只在 bundle 里有读者时才建（`bundle.reflection.planar`、`bundle.mipFramebuffer`），没有反射的场景不经过这里。
 */
import type { SceneBundle } from "../compile/bundle";

/** 一张反射 RT；字段同 `scene.ts` 的 `RenderTarget`，渲染器直接把它当 RT 绑。 */
export interface ReflectionTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

/** `_rt_MipMappedFrameBuffer` 的 mip 级数（步骤 0 R7）：`npot` 是向上取 2 的幂；小尺寸至少 1 级。 */
export function mipLevelCountOf(width: number, height: number): number {
  const level = (size: number) => Math.log2(Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1, size)))) / 2);
  return Math.max(1, Math.min(level(width), level(height)) - 2);
}

/** 两张 RT 的格式：反射图固定 RGBA8；mip 帧缓冲跟场景目标。 */
const REFLECTION_FORMAT: GPUTextureFormat = "rgba8unorm";

function texelBytesOf(format: GPUTextureFormat): number {
  return format === "rgba16float" ? 8 : 4;
}

/**
 * 缩小坐标的定点系数（P13g 步骤 0）：每轴 `c = floor(s / d · 2²⁴)`，s 是上一级尺寸、d 是这一级尺寸。见 `MIP_DOWNSAMPLE_WGSL`。
 * `s · 2²⁴` 是 2 的幂倍的整数（s ≤ 16384 时不超过 2³⁸），double 除法再取整是精确的：商不是整数时离整数至少 1/d。
 */
export function mipDownsampleScale(source: number, target: number): number {
  return Math.floor((source * 2 ** 24) / target);
}

/**
 * `MIP_DOWNSAMPLE_WGSL` 的 `sourceCoord` 的同一算式（u32 运算，单测拿它和精确值逐个比）：目标纹素 j 在上一级的坐标，1/256 纹素为单位。
 * 改着色器里的算式时这里一起改。
 */
export function mipSourceCoord256(j: number, c: number): number {
  const n = (2 * j + 1) >>> 0;
  const units = (Math.imul(n, c >>> 17) + (Math.imul(n, c & 0x1ffff) >>> 17)) >>> 0;
  return units - 128;
}

/**
 * mip 帧缓冲的逐级缩小（P13g）：全屏三角形，片元对上一级（单级视图）做一次硬件双线性采样，采样位置照 WPE 的 D3D11 `GenerateMips`
 * （NVIDIA 驱动，p13g 抓帧逐级反推）：目标纹素 j 对应的上一级纹素坐标是 `(j + ½) · s/d − ½`，但缩放系数先向下截到 2⁻²⁴、乘积精确、
 * 坐标再向下截到 1/256（硬件采样器自己是就近取 1/256）。偶数边系数是 2，等于 2×2 平均；奇数边（1080 高时 135 → 67、67 → 33）上
 * 理论落在整数上的那一行会略小于整数，落到下一对纹素上——照做后 1920×1080 的 7 级逐位相同，只用就近或只截系数都有零星 1 级的差。
 * 定点乘法拆成高低两段免得超出 u32：`floor(n · c / 2¹⁷) = n · (c >> 17) + ((n · (c & 0x1ffff)) >> 17)`，n = 2j + 1 ≤ 2¹⁴
 * （尺寸 ≤ 8192），两项都不超出 32 位。结果是 1/256 纹素为单位的坐标，减掉 ½ 纹素（128）。
 * 目标尺寸 = 上一级尺寸 / 2 向下取整（至少 1），与 WebGPU / D3D 的 mip 尺寸相同。
 */
export const MIP_DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
/** 每轴的定点系数 c = floor(s / d · 2^24)（mipDownsampleScale） */
@group(0) @binding(2) var<uniform> scale: vec2u;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

/** 目标纹素 j 在上一级的坐标（1/256 纹素为单位，向下截）。 */
fn sourceCoord(j: u32, c: u32) -> f32 {
  let n = 2u * j + 1u;
  let units = n * (c >> 17u) + ((n * (c & 0x1ffffu)) >> 17u);
  return f32(i32(units) - 128) / 256.0;
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let j = vec2u(position.xy);
  let texel = vec2f(sourceCoord(j.x, scale.x), sourceCoord(j.y, scale.y));
  return textureSampleLevel(source, sourceSampler, (texel + 0.5) / size, 0.0);
}
`;

export class ReflectionTargets {
  /** `_rt_Reflection`；没有模型读它时不建。 */
  reflection: ReflectionTarget | null = null;
  /** `_rt_MipMappedFrameBuffer`；没有对象读它时不建。 */
  mipFramebuffer: ReflectionTarget | null = null;
  /** `mipFramebuffer` 的 mip 级数（给 `g_Texture<n>MipMapInfo`）；没建时为 0。 */
  mipLevelCount = 0;
  /** 两张 RT 占的显存估算（字节，mip 链按 4/3 倍）。 */
  bytes = 0;

  private readonly owned: GPUTexture[] = [];
  /** 逐级缩小的定点系数缓冲（P13g，每级一个）。 */
  private readonly ownedBuffers: GPUBuffer[] = [];
  /** 逐级缩小的管线（P13g，只在 `updatesMip` 时建；格式固定，换尺寸不重建）。 */
  private downsample: GPURenderPipeline | null = null;
  /** 第 k 级（k ≥ 1）的颜色附件视图；下标 0 不用。 */
  private levelTargets: GPUTextureView[] = [];
  /** 第 k 级（k ≥ 1）的缩小 pass 读的 bind group（第 k − 1 级的单级视图）；下标 0 不用。 */
  private levelSources: GPUBindGroup[] = [];

  private constructor(
    private readonly device: GPUDevice,
    private readonly wantReflection: boolean,
    private readonly wantMip: boolean,
    /** 反射开（P13g）：mip 帧缓冲每帧更新。 */
    readonly updatesMip: boolean,
    private readonly hdr: boolean,
  ) {}

  /** 要建的东西都没有时返回 null（渲染器不持有、不经过 `encode`）。 */
  static create(
    device: GPUDevice,
    bundle: Pick<SceneBundle, "reflection" | "mipFramebuffer">,
    width: number,
    height: number,
    hdr: boolean,
  ): ReflectionTargets | null {
    const planar = bundle.reflection?.planar === true;
    const mip = bundle.mipFramebuffer !== undefined;
    if (!planar && !mip) return null;
    const targets = new ReflectionTargets(device, planar, mip, bundle.mipFramebuffer?.update === true, hdr);
    targets.build(width, height);
    return targets;
  }

  private build(width: number, height: number): void {
    const { device } = this;
    this.bytes = 0;
    if (this.wantReflection) {
      const texture = device.createTexture({
        label: "_rt_Reflection",
        size: { width, height },
        format: REFLECTION_FORMAT,
        // COPY_SRC 同场景目标、合成 RT、泛光 RT：dev 探针按标签读回反射 pass 的目标（P13b2，`trace.readback`）
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.owned.push(texture);
      this.reflection = {
        texture,
        view: texture.createView(),
        width,
        height,
        format: REFLECTION_FORMAT,
        sampler: device.createSampler({
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
        }),
      };
      this.bytes += width * height * texelBytesOf(REFLECTION_FORMAT);
    }
    if (this.wantMip) {
      const format: GPUTextureFormat = this.hdr ? "rgba16float" : "rgba8unorm";
      const levels = (this.mipLevelCount = mipLevelCountOf(width, height));
      const texture = device.createTexture({
        label: "_rt_MipMappedFrameBuffer",
        size: { width, height },
        format,
        mipLevelCount: levels,
        // COPY_DST：反射开时每帧把场景目标拷进 0 级（P13g）
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          (this.updatesMip ? GPUTextureUsage.COPY_DST : 0),
      });
      this.owned.push(texture);
      this.mipFramebuffer = {
        texture,
        view: texture.createView(),
        width,
        height,
        format,
        sampler: device.createSampler({
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
          mipmapFilter: "linear",
        }),
      };
      this.bytes += Math.ceil((width * height * texelBytesOf(format) * 4) / 3);
      if (this.updatesMip) {
        // 反射开（P13g）：建好不清屏；每级一个附件视图、一个读上一级的 bind group
        this.downsample ??= this.createDownsample(format);
        const layout = this.downsample.getBindGroupLayout(0);
        const sampler = device.createSampler({
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
        });
        this.levelTargets = [];
        this.levelSources = [];
        const sizeAt = (size: number, level: number) => Math.max(1, size >> level);
        for (let level = 1; level < levels; level++) {
          this.levelTargets[level] = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
          // 这一级的定点缩放系数（MIP_DOWNSAMPLE_WGSL）
          const scale = device.createBuffer({
            label: `_rt_MipMappedFrameBuffer mip ${level} scale`,
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(
            scale,
            0,
            new Uint32Array([
              mipDownsampleScale(sizeAt(width, level - 1), sizeAt(width, level)),
              mipDownsampleScale(sizeAt(height, level - 1), sizeAt(height, level)),
            ]),
          );
          this.ownedBuffers.push(scale);
          this.levelSources[level] = device.createBindGroup({
            label: `_rt_MipMappedFrameBuffer mip ${level} source`,
            layout,
            entries: [
              { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
              { binding: 1, resource: sampler },
              { binding: 2, resource: { buffer: scale } },
            ],
          });
        }
        return;
      }
      // 反射关：各级清成 (0, 0, 0, 1) 一次，之后不再碰（WPE 不更新它，步骤 0 R7）
      const encoder = device.createCommandEncoder({ label: "_rt_MipMappedFrameBuffer clear" });
      for (let level = 0; level < levels; level++)
        encoder
          .beginRenderPass({
            label: `_rt_MipMappedFrameBuffer mip ${level}`,
            colorAttachments: [
              {
                view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
              },
            ],
          })
          .end();
      device.queue.submit([encoder.finish()]);
    }
  }

  private createDownsample(format: GPUTextureFormat): GPURenderPipeline {
    const module = this.device.createShaderModule({
      label: "_rt_MipMappedFrameBuffer downsample",
      code: MIP_DOWNSAMPLE_WGSL,
    });
    return this.device.createRenderPipeline({
      label: "_rt_MipMappedFrameBuffer downsample",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * 反射开（P13g）：主 pass 之后、泛光之前（rea-p13-passes 4.2，帧函数 `0x140180aa0` / `0x140180b87`）。场景目标整张拷进 0 级
   * （同尺寸同格式，WPE 是 `ResolveSubresource`），再逐级各一个 pass 从上一级缩小（WPE 是 `GenerateMips`）。读它的对象在下一帧的
   * 主 pass 里读到这一帧（第一帧是新纹理的 0）。反射关或没建时什么都不做。
   */
  encodeMipFramebuffer(encoder: GPUCommandEncoder, source: GPUTexture): void {
    const target = this.mipFramebuffer;
    if (!target || !this.updatesMip || !this.downsample) return;
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: target.texture, mipLevel: 0 },
      { width: target.width, height: target.height },
    );
    for (let level = 1; level < this.mipLevelCount; level++) {
      const pass = encoder.beginRenderPass({
        label: `_rt_MipMappedFrameBuffer mip ${level}`,
        colorAttachments: [
          {
            view: this.levelTargets[level],
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.downsample);
      pass.setBindGroup(0, this.levelSources[level]);
      pass.draw(3);
      pass.end();
    }
  }

  /**
   * 每帧主 pass 之前：`_rt_Reflection` 清成 `(clearcolor, 1)`，不看 `clearenabled`（WPE 每帧都清，步骤 0 R4）。
   * 8 位换算由 GPU 做（步骤 0 R5：同一块 GPU 上的清屏走同样的换算）；HDR 的大于 1 的清屏色在 unorm 上钳到 1（R6）。
   */
  encode(encoder: GPUCommandEncoder, clearcolor: readonly [number, number, number] | readonly number[]): void {
    if (!this.reflection) return;
    const [r, g, b] = clearcolor;
    encoder
      .beginRenderPass({
        label: "_rt_Reflection clear",
        colorAttachments: [
          { view: this.reflection.view, clearValue: { r, g, b, a: 1 }, loadOp: "clear", storeOp: "store" },
        ],
      })
      .end();
  }

  /**
   * 换尺寸（透视场景随画布变，P5d 步骤 2）：按新尺寸重建两张 RT。绑了旧视图的 bind group 要调用方重建；
   * 渲染器现在整场重新加载而不原地换尺寸（场景目标与快照同样不换），P13b2 的反射 pass 需要时再接。
   */
  resize(width: number, height: number): void {
    // 两张同尺寸（都按场景目标建），取建了的那一张比
    const current = this.reflection ?? this.mipFramebuffer;
    if (current?.width === width && current.height === height) return;
    this.destroy();
    this.reflection = null;
    this.mipFramebuffer = null;
    this.mipLevelCount = 0;
    this.build(width, height);
  }

  destroy(): void {
    for (const texture of this.owned) texture.destroy();
    this.owned.length = 0;
    for (const buffer of this.ownedBuffers) buffer.destroy();
    this.ownedBuffers.length = 0;
  }
}
