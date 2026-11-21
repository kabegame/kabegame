/**
 * 纹理上传：`compile/tex.ts` 的 `TEXTURE_FORMATS` 里的格式（RGBA8888、DXT5 / DXT3 / DXT1 → BC3 / BC2 / BC1、RG88、R8）
 * 连同全部 mip 按原格式直接交给 GPU，不做 CPU 解码、不改通道；格式表是编译期与渲染器共用的唯一来源。
 * FreeImage 形态（PNG / JPG）由主线程解成 `ImageBitmap`（`compile/decode.ts`），这里 `copyExternalImageToTexture`。
 * 视频纹理（P9a）只建空纹理，帧由 `GpuScene` 在画到它时拷进来。
 * 采样方式照 linux-wallpaperengine（GPLv3）`src/WallpaperEngine/Render/CTexture.cpp` 的 `setupOpenGLParameters`：
 * ClampUVs → clamp，否则 repeat；NoInterpolation → nearest，否则线性 + 三线性 mip + 8 倍各向异性。
 *
 * 颜色空间：WPE 在 gamma 空间里混合，纹理、离屏目标与画布都用非 sRGB 格式，全程不做转换。
 */
import type { SceneTexture } from "../compile/bundle";
import { textureFormat } from "../compile/tex";
import { selectVariants, VARIANT_FLAGS, variantPlan } from "../compile/textureVariants";
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

/**
 * 文件纹理（`.tex`，含视频）的采样器，同 WPE `FUN_140099980`（rea-p8-layer 3.2）：寻址看 ClampUVs，NoInterpolation 时点采样，
 * 否则 8 倍各向异性，不看 mip 级数（单级 mip 的 effect 遮罩、视频同样是各向异性，p12a 报告 B1、p9-REPORT）。WebGPU 的各向异性
 * 要求三个过滤都是 linear，单级 mip 时 mipmap 过滤不改变取样层级，只是让各向异性能开。
 */
export function samplerDescriptor(texture: Pick<SceneTexture, "clampUVs" | "noInterpolation">): GPUSamplerDescriptor {
  const address: GPUAddressMode = texture.clampUVs ? "clamp-to-edge" : "repeat";
  const filter: GPUFilterMode = texture.noInterpolation ? "nearest" : "linear";
  return {
    addressModeU: address,
    addressModeV: address,
    magFilter: filter,
    minFilter: filter,
    mipmapFilter: filter,
    maxAnisotropy: texture.noInterpolation ? 1 : 8,
  };
}

/**
 * 主线程解码的纹理（FreeImage 形态）写进 GPU 纹理的全部 mip：每级先写底图，再按纹理变体（P11e）的命中表贴变体（`variantPlan`：文件顺序、
 * 最后一条整张替换之前的丢掉）。贴图是 `copyExternalImageToTexture` 写到变体的矩形（位图按 `premultiplyAlpha: "none"` 解码、
 * `premultipliedAlpha: false` 写入，逐字节覆盖），等价于 WPE `FUN_14015c480` 的逐行拷；整张替换的解码后同样贴在它的矩形上（WPE 把编码后的
 * PNG 字节当像素上传，P11e 点 0 实测的缺陷，不复刻）。标志位 1（按 alpha 混合）照报 `tex:variant:alphablend`，强制渲染时不贴。
 * 换选择时（`GpuScene` 的 `syncTextureVariants`）对同一张 GPU 纹理再调一次：尺寸不变，绑定组与着色器都不动。
 */
export function writeBitmapMips(
  device: GPUDevice,
  gpu: GPUTexture,
  texture: SceneTexture,
  selected: ReadonlyMap<number, number>,
): void {
  texture.mips.forEach((mip, level) => {
    device.queue.copyExternalImageToTexture(
      { source: mip.bitmap! },
      { texture: gpu, mipLevel: level, premultipliedAlpha: false },
      { width: mip.width, height: mip.height },
    );
    const patches = texture.variants?.mips[level];
    if (!patches || !selected.size) return;
    for (const { patch, flags } of variantPlan(patches, selected, mip.width, mip.height)) {
      if (flags & VARIANT_FLAGS.alphaBlend && !(flags & VARIANT_FLAGS.replace)) continue;
      if (!patch.bitmap) continue;
      device.queue.copyExternalImageToTexture(
        { source: patch.bitmap },
        { texture: gpu, mipLevel: level, origin: { x: patch.x, y: patch.y }, premultipliedAlpha: false },
        { width: patch.width, height: patch.height },
      );
    }
  });
}

/** 纹理变体编译时的命中表：按 `variants.values`（条件属性编译时的值）选。没有变体时为空表。 */
export function initialVariantSelection(texture: SceneTexture): Map<number, number> {
  if (!texture.variants) return new Map();
  return selectVariants(texture.variants.conditions, new Map(Object.entries(texture.variants.values)));
}

/**
 * 建 GPU 纹理并写入全部 mip。`selected`：纹理变体（P11e）的命中表，缺省取编译时的选择（`initialVariantSelection`）；宿主运行中改过条件属性、
 * 纹理又是之后才上传的（运行中建层、片段），传当前状态的选择。
 */
export function uploadTexture(
  device: GPUDevice,
  texture: SceneTexture,
  selected: ReadonlyMap<number, number> = initialVariantSelection(texture),
): GPUTexture {
  // 视频纹理（P9a）：同 WPE 是一张普通纹理（rea-p9-video 第 2 节：R8G8B8A8_UNORM、一级 mip、尺寸取 `.tex` 头的纹理尺寸，语料 60 段
  // 都等于视频尺寸）。不写数据，初值全 0：第一帧之前与解不了时图层透明，同 WPE（第 8 节 memset 0、p9-REPORT「坏视频」）。之后由
  // GpuScene 画到它时 `copyExternalImageToTexture`（要 RENDER_ATTACHMENT）
  if (texture.video)
    return device.createTexture({
      label: texture.path,
      size: { width: texture.textureWidth, height: texture.textureHeight },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
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
    writeBitmapMips(device, gpu, texture, selected);
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
