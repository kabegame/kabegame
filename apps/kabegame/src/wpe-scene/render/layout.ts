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
 * - **相机**：LWE 的正交投影是 `ortho(±w/2, ±h/2) * translate(eye)`，再乘 `lookAt(eye, center, up)` 后 eye 恰好抵消；
 *   这里直接用 `ortho(0…w, 0…h)`，与之等价（eagleflag 的 eye 是编辑器残留的偏移，WPE 预览图里画面并未平移）。
 */
import type { SceneGeneral, SceneLayer, SceneTexture } from "../compile/bundle";
import { multiply, orthographic, rotationZ, scaling, translation, type Mat4 } from "./math";

/** 正交场景的深度范围：图层 z 一般为 0，映射到深度 0.5。 */
const ORTHO_DEPTH = 10000;

export interface QuadVertex {
  position: [number, number, number];
  texCoord: [number, number];
}

/**
 * 纹理在填充尺寸里的有效区域（LWE：`getRealWidth() / getTextureWidth(0)`）。WPE 把非 2 的幂图像放进更大的纹理
 * （如 1920×1080 → 2048×2048），图层四边形只采样左上角的实际图像。
 */
export function textureUvExtent(
  texture: Pick<SceneTexture, "width" | "height" | "mips"> | undefined,
): [number, number] {
  const base = texture?.mips[0];
  if (!texture || !base || base.width <= 0 || base.height <= 0) return [1, 1];
  return [texture.width / base.width, texture.height / base.height];
}

/**
 * 图层四边形，三角形带顺序：左下、右下、左上、右上。顶点在模型空间（中心为原点，未缩放的 `size`），
 * 图像顶边对应 v = 0（纹理第 0 行），与 LWE 的 `texcoordCopy` 相同。
 */
export function layerQuad(size: readonly number[], uv: [number, number]): QuadVertex[] {
  const hw = (size[0] ?? 0) / 2,
    hh = (size[1] ?? 0) / 2;
  const [u, v] = uv;
  return [
    { position: [-hw, -hh, 0], texCoord: [0, v] },
    { position: [hw, -hh, 0], texCoord: [u, v] },
    { position: [-hw, hh, 0], texCoord: [0, 0] },
    { position: [hw, hh, 0], texCoord: [u, 0] },
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
