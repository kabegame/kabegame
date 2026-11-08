/**
 * 纹理上传：`compile/tex.ts` 的 `TEXTURE_FORMATS` 里的格式（RGBA8888、DXT5 / DXT3 / DXT1 → BC3 / BC2 / BC1、RG88、R8）
 * 连同全部 mip 按原格式直接交给 GPU，不做 CPU 解码、不改通道；格式表是编译期与渲染器共用的唯一来源。
 * FreeImage 形态（PNG / JPG）由主线程解成 `ImageBitmap`（`compile/decode.ts`），这里 `copyExternalImageToTexture`。
 * 采样方式照 linux-wallpaperengine（GPLv3）`src/WallpaperEngine/Render/CTexture.cpp` 的 `setupOpenGLParameters`：
 * ClampUVs → clamp，否则 repeat；NoInterpolation → nearest，否则线性 + 三线性 mip + 8 倍各向异性。
 *
 * 颜色空间：WPE 在 gamma 空间里混合，纹理、离屏目标与画布都用非 sRGB 格式，全程不做转换。
 */
import type { SceneTexture } from "../compile/bundle";
import { textureFormat } from "../compile/tex";
import { SceneRenderError } from "./errors";

export interface MipCopyLayout {
  bytesPerRow: number;
  rowsPerImage: number;
  /** 写入区域（物理尺寸：压缩格式按块向上取整，小于 4 的 mip 也写满一块）。 */
  width: number;
  height: number;
  byteLength: number;
}

/**
 * 一个 mip 的上传布局：BC 的行跨度按 4×4 块计，物理尺寸按块取整；非压缩格式按像素计（R8 每像素 1 字节、RG88 2 字节）。
 * 只用 `writeTexture`，行跨度不需要 256 对齐，按紧排给。
 */
export function mipCopyLayout(format: number, width: number, height: number): MipCopyLayout {
  const info = textureFormat(format);
  if (!info) throw new SceneRenderError([`webgpu:texture-format:${format}`]);
  const blocksX = Math.ceil(width / info.block),
    blocksY = Math.ceil(height / info.block);
  return {
    bytesPerRow: blocksX * info.bytesPerBlock,
    rowsPerImage: blocksY,
    width: blocksX * info.block,
    height: blocksY * info.block,
    byteLength: blocksX * blocksY * info.bytesPerBlock,
  };
}

/** 第 level 级 mip 的逻辑尺寸。 */
export function mipSize(base: number, level: number): number {
  return Math.max(1, Math.floor(base / 2 ** level));
}

/** 场景纹理所需的设备特性。 */
export function requiredFeatures(textures: readonly Pick<SceneTexture, "format">[]): GPUFeatureName[] {
  const features = new Set<GPUFeatureName>();
  for (const texture of textures) {
    const feature = textureFormat(texture.format)?.feature;
    if (feature) features.add(feature);
  }
  return [...features];
}

/** 校验 mip 链并返回每级的上传布局；任何不一致都按退回处理，而不是让 WebGPU 报校验错误。 */
export function planTextureUpload(texture: SceneTexture): MipCopyLayout[] {
  const info = textureFormat(texture.format);
  if (!info) throw new SceneRenderError([`webgpu:texture-format:${texture.format}:${texture.path}`]);
  const base = texture.mips[0];
  if (!base) throw new SceneRenderError([`webgpu:texture-empty:${texture.path}`]);
  if (base.width % info.block || base.height % info.block)
    throw new SceneRenderError([`webgpu:texture-size:${texture.path}:${base.width}x${base.height}`]);
  return texture.mips.map((mip, level) => {
    if (mip.width !== mipSize(base.width, level) || mip.height !== mipSize(base.height, level))
      throw new SceneRenderError([`webgpu:texture-mip:${texture.path}:${level}`]);
    const layout = mipCopyLayout(texture.format, mip.width, mip.height);
    if (!mip.bytes || mip.bytes.byteLength < layout.byteLength)
      throw new SceneRenderError([`webgpu:texture-data:${texture.path}:${level}`]);
    return layout;
  });
}

/**
 * 主线程解码的位图（FreeImage 形态）的上传计划：GPU 纹理按「纹理尺寸」（`textureWidth / textureHeight`）建，
 * 第 l 级位图拷到第 l 级 mip 的左上角，所以位图不能超过该级尺寸。返回 mip 级数。
 */
export function planBitmapUpload(
  texture: Pick<SceneTexture, "path" | "format" | "textureWidth" | "textureHeight" | "mips">,
): number {
  if (texture.format !== 0) throw new SceneRenderError([`webgpu:texture-format:${texture.format}:${texture.path}`]);
  if (!texture.mips.length) throw new SceneRenderError([`webgpu:texture-empty:${texture.path}`]);
  texture.mips.forEach((mip, level) => {
    if (
      !mip.bitmap ||
      mip.width > mipSize(texture.textureWidth, level) ||
      mip.height > mipSize(texture.textureHeight, level)
    )
      throw new SceneRenderError([`webgpu:texture-mip:${texture.path}:${level}`]);
  });
  return texture.mips.length;
}

export function samplerDescriptor(
  texture: Pick<SceneTexture, "clampUVs" | "noInterpolation">,
  mipmapped: boolean,
): GPUSamplerDescriptor {
  const address: GPUAddressMode = texture.clampUVs ? "clamp-to-edge" : "repeat";
  const filter: GPUFilterMode = texture.noInterpolation ? "nearest" : "linear";
  const mipmapFilter: GPUMipmapFilterMode = texture.noInterpolation || !mipmapped ? "nearest" : "linear";
  return {
    addressModeU: address,
    addressModeV: address,
    magFilter: filter,
    minFilter: filter,
    mipmapFilter,
    // 各向异性要求三个过滤都是 linear
    maxAnisotropy: filter === "linear" && mipmapFilter === "linear" ? 8 : 1,
  };
}

/** 建 GPU 纹理并写入全部 mip。 */
export function uploadTexture(device: GPUDevice, texture: SceneTexture): GPUTexture {
  if (texture.mips[0]?.bitmap) {
    const levels = planBitmapUpload(texture);
    const gpu = device.createTexture({
      label: texture.path,
      size: { width: texture.textureWidth, height: texture.textureHeight },
      format: "rgba8unorm",
      mipLevelCount: levels,
      // copyExternalImageToTexture 要求目标带 RENDER_ATTACHMENT
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    texture.mips.forEach((mip, level) =>
      device.queue.copyExternalImageToTexture(
        { source: mip.bitmap! },
        { texture: gpu, mipLevel: level, premultipliedAlpha: false },
        { width: mip.width, height: mip.height },
      ),
    );
    return gpu;
  }
  const plan = planTextureUpload(texture);
  const base = texture.mips[0];
  const gpu = device.createTexture({
    label: texture.path,
    size: { width: base.width, height: base.height },
    // planTextureUpload 已确认格式在表里
    format: textureFormat(texture.format)!.gpu,
    mipLevelCount: plan.length,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  plan.forEach((layout, level) => {
    const bytes = texture.mips[level].bytes!;
    device.queue.writeTexture(
      { texture: gpu, mipLevel: level },
      bytes as Uint8Array<ArrayBuffer>,
      { offset: 0, bytesPerRow: layout.bytesPerRow, rowsPerImage: layout.rowsPerImage },
      { width: layout.width, height: layout.height },
    );
  });
  return gpu;
}
