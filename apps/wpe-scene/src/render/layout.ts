/**
 * 场景几何：图层四边形、模型 / 视图投影矩阵、cover 铺放与指针换算。纯函数，不碰 GPU。
 *
 * 图层四边形与纹理坐标的换算移植自 linux-wallpaperengine（GPLv3，与本项目同许可）
 * `src/WallpaperEngine/Render/Objects/CImage.cpp`（`CImage::CImage` / `uploadGeometryBuffers`）、
 * 正交相机移植自 `src/WallpaperEngine/Render/Camera.cpp`，做了以下改写：
 * - **坐标系**：WPE 场景坐标原点在左下、y 向上（`origin` 以像素计）。LWE 为配合 GL 帧缓冲把 y 翻过来再在输出时翻回；
 *   WebGPU 的 NDC 同样 y 向上、渲染目标与纹理的第 0 行都在上方（与 D3D 相同，翻译器按 `HLSL` 路径），
 *   所以这里直接用场景坐标，不做任何翻转。
 * - **模型空间**：顶点放在以图层中心为原点的模型空间（未缩放的 `size`），平移 / 旋转 / 缩放进 `g_ModelMatrix`，
 *   而不是像 LWE 那样把场景坐标烘进顶点；对 P1 着色器结果相同，`g_ModelMatrix` 也有了真实含义。
 * - **相机**：WPE 在正交且没有 `paths` 时，加载末尾把 `eye` / `center` / `up` 重置成默认值，视图矩阵是单位阵，JSON 的值被丢弃
 *   （L2）；投影是 `ortho(0…w, 0…h)`，这里就用它。eagleflag 的 eye 是编辑器残留的偏移，画面不平移。
 */
import type { SceneGeneral, SceneLayer, SceneTexture } from "../compile/bundle";
import { multiply, orthographic, rotationZ, scaling, translation, type Mat4 } from "./math";

/** 正交场景的深度范围：图层 z 一般为 0，映射到深度 0.5。 */
const ORTHO_DEPTH = 10000;

/** 不内缩。 */
export const NO_INSET: readonly [number, number] = [0, 0];

export interface QuadVertex {
  position: [number, number, number];
  texCoord: [number, number];
}

/**
 * 纹理在填充尺寸里的有效区域 = 图像尺寸 / 纹理尺寸（WPE `FUN_1402091e0` 的 UV 缩放，p2-REPORT B5 / B12；
 * LWE：`getRealWidth() / getTextureWidth(0)`）。WPE 把非 2 的幂图像放进更大的纹理（如 1920×1080 → 2048×2048），
 * 图层四边形只采样左上角的实际图像。FreeImage 形态的「纹理尺寸」取哪个字段见 `compile/tex.ts` 的 `freeImageTextureSize`。
 */
export function textureUvExtent(
  texture: Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight"> | undefined,
): [number, number] {
  if (!texture || texture.textureWidth <= 0 || texture.textureHeight <= 0) return [1, 1];
  return [texture.width / texture.textureWidth, texture.height / texture.textureHeight];
}

/**
 * 上屏四边形的 UV 内缩（WPE `FUN_1401ede30` 的位 2）：两端各缩 `0.15 / 尺寸`，float32 逐步算。分母是基础纹理的纹理尺寸，
 * 走合成路径时也是，不是合成 RT；没有纹理时是图层 size 的整数部分。
 */
export function uvInset(
  size: readonly number[],
  texture: Pick<SceneTexture, "textureWidth" | "textureHeight"> | undefined,
): [number, number] {
  const denominators = texture
    ? [texture.textureWidth, texture.textureHeight]
    : [Math.trunc(size[0] ?? 0), Math.trunc(size[1] ?? 0)];
  const [u, v] = denominators.map((value) => (value > 0 ? Math.fround(Math.fround(0.15) / value) : 0));
  return [u, v];
}

/**
 * 图层四边形，三角形带顺序：左下、右下、左上、右上。顶点在模型空间（中心为原点，未缩放的 `size`），
 * 图像顶边对应 v = 0（纹理第 0 行），与 LWE 的 `texcoordCopy` 相同。`inset` 见 {@link uvInset}。
 */
export function layerQuad(
  size: readonly number[],
  uv: [number, number],
  [left, top]: readonly [number, number] = NO_INSET,
): QuadVertex[] {
  const hw = (size[0] ?? 0) / 2,
    hh = (size[1] ?? 0) / 2;
  const right = Math.fround(Math.fround(uv[0]) - left);
  const bottom = Math.fround(Math.fround(uv[1]) - top);
  return [
    { position: [-hw, -hh, 0], texCoord: [left, bottom] },
    { position: [hw, -hh, 0], texCoord: [right, bottom] },
    { position: [-hw, hh, 0], texCoord: [left, top] },
    { position: [hw, hh, 0], texCoord: [right, top] },
  ];
}

/** 图层模型矩阵：`T(origin) · Rz(angles.z) · S(scale)`。P1 只处理 z 轴旋转（2D 图层）。 */
export function layerModelMatrix(layer: Pick<SceneLayer, "origin" | "angles" | "scale">): Mat4 {
  const [x = 0, y = 0, z = 0] = layer.origin;
  const [sx = 1, sy = 1, sz = 1] = layer.scale;
  return multiply(multiply(translation(x, y, z), rotationZ(layer.angles[2] ?? 0)), scaling(sx, sy, sz === 0 ? 1 : sz));
}

/** 正交场景的视图投影：场景 `[0, w] × [0, h]`（y 向上）铺满整个渲染目标。 */
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">): Mat4 {
  return orthographic(0, general.width, 0, general.height, -ORTHO_DEPTH, ORTHO_DEPTH);
}

/** 正交场景的 `g_EyePosition`：`(W/2, H/2, 2000)`，不取 JSON 的 `eye`（L2、L13）。W、H 是投影尺寸，不随渲染目标缩小。 */
export function eyePosition(general: Pick<SceneGeneral, "width" | "height">): number[] {
  return [general.width / 2, general.height / 2, 2000];
}

export interface CoverUv {
  /** 画布左上角对应的场景纹理坐标。 */
  offset: [number, number];
  /** 画布从左上到右下跨过的场景纹理坐标长度（≤ 1）。 */
  scale: [number, number];
}

/** cover：等比放大到盖满画布、居中裁掉溢出部分，返回画布 → 场景纹理的坐标变换。 */
export function coverUv(sceneWidth: number, sceneHeight: number, canvasWidth: number, canvasHeight: number): CoverUv {
  if (sceneWidth <= 0 || sceneHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0)
    return { offset: [0, 0], scale: [1, 1] };
  const zoom = Math.max(canvasWidth / sceneWidth, canvasHeight / sceneHeight);
  const scale: [number, number] = [canvasWidth / (zoom * sceneWidth), canvasHeight / (zoom * sceneHeight)];
  return { offset: [(1 - scale[0]) / 2, (1 - scale[1]) / 2], scale };
}

/**
 * 画布上的指针（0…1，左上为原点）换算成场景上的归一化位置（0…1，左下为原点，与 LWE `g_PointerPosition` 相同）。
 */
export function canvasToScenePointer(cover: CoverUv, x: number, y: number): [number, number] {
  return [cover.offset[0] + x * cover.scale[0], 1 - (cover.offset[1] + y * cover.scale[1])];
}

/** 离屏目标尺寸：场景分辨率，超过设备上限时等比缩小。 */
export function sceneTargetSize(width: number, height: number, maxDimension: number): [number, number] {
  const w = Math.max(1, Math.round(width)),
    h = Math.max(1, Math.round(height));
  const k = Math.min(1, maxDimension / Math.max(w, h));
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}
