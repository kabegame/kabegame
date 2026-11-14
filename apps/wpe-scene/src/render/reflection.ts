/**
 * 反射用的两张 RT（P13b1，只有「反射关」；P13b2 在这里加反射 pass）。
 *
 * WPE 的用户设置 `reflection` 管两样东西（rea-p13-passes 第 1、4 节）：平面反射 pass（`_rt_Reflection`）与屏幕空间反射用的 mip 帧缓冲
 * （`_rt_MipMappedFrameBuffer`）。设置关着时两样都不画，只剩两张内容固定的纹理：
 * - `_rt_Reflection`：场景目标尺寸、RGBA8（HDR 下也是），每帧在主 pass 之前清成 `(clearcolor, 1)`，不看 `clearenabled`（步骤 0 R1、R4、R6）；
 *   采样器 Clamp + Linear。
 * - `_rt_MipMappedFrameBuffer`：场景目标尺寸、格式跟场景目标（HDR 时 RGBA16F）、
 *   `max(1, min(log2(npot(w) / 2), log2(npot(h) / 2)) − 2)` 级 mip（1920×1080 → 8、1280×720 → 7，步骤 0 R7），建好时各级清成
 *   `(0, 0, 0, 1)` 一次，之后不更新、不随清屏色；采样器 Clamp + 三线性。
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

  private constructor(
    private readonly device: GPUDevice,
    private readonly wantReflection: boolean,
    private readonly wantMip: boolean,
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
    const mip = bundle.mipFramebuffer === true;
    if (!planar && !mip) return null;
    const targets = new ReflectionTargets(device, planar, mip, hdr);
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
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
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
  }
}
