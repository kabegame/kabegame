/**
 * 场景几何：图层四边形、模型 / 视图投影矩阵、壁纸样式铺放与指针换算。纯函数，不碰 GPU。
 *
 * 图层四边形与纹理坐标的换算移植自 linux-wallpaperengine（GPLv3，与本项目同许可）
 * `src/WallpaperEngine/Render/Objects/CImage.cpp`（`CImage::CImage` / `uploadGeometryBuffers`）、
 * 正交相机移植自 `src/WallpaperEngine/Render/Camera.cpp`，做了以下改写：
 * - **坐标系**：WPE 场景坐标原点在左下、y 向上（`origin` 以像素计）。LWE 为配合 GL 帧缓冲把 y 翻过来再在输出时翻回；
 *   WebGPU 的 NDC 同样 y 向上、渲染目标与纹理的第 0 行都在上方（与 D3D 相同，翻译器按 `HLSL` 路径），
 *   所以这里直接用场景坐标，不做任何翻转。
 * - **模型空间**：顶点放在以图层中心为原点的模型空间（未缩放的 `size`），平移 / 旋转 / 缩放进 `g_ModelMatrix`，
 *   而不是像 LWE 那样把场景坐标烘进顶点；对 P1 着色器结果相同，`g_ModelMatrix` 也有了真实含义。
 *   P4a 起 `g_ModelMatrix` 是沿父链累乘的世界矩阵（`worldMatrixOf`），本地矩阵带完整的三轴旋转（`layerLocalMatrix`）。
 * - **相机**：WPE 在正交且没有 `paths` 时，加载末尾把 `eye` / `center` / `up` 重置成默认值，视图矩阵是单位阵，JSON 的值被丢弃
 *   （L2）；投影是 `ortho(0…w, 0…h)`，这里就用它，`general.zoom` 再绕场景中心缩放（P5a 步骤 4）。eagleflag 的 eye 是编辑器残留的
 *   偏移，画面不平移。
 *   透视粒子（P4a 步骤 4）另用一套透视相机（`particleViewProjection`），z = 0 平面和正交画面重合。
 */
import type { SceneGeneral, SceneTexture } from "../compile/bundle";
import {
  identity,
  multiply,
  orthographic,
  rotationX,
  rotationY,
  rotationZ,
  scaling,
  translation,
  type Mat4,
} from "./math";

/**
 * 正交场景的深度范围 ±2000，照 WPE（2026-11-07 RenderDoc 读到的 MVP，图像层与正交粒子相同）：深度 = 0.00025·z + 0.5，
 * 反向 Z（+z 朝相机、深度大），和透视粒子一致。图层 z 一般为 0，深度仍是 0.5；|z| > 2000 的被裁掉，WPE 同样如此。
 */
export const ORTHO_DEPTH = 2000;

/** 透视粒子的近平面与远平面下限（`particleViewProjection`，实测）。 */
const PARTICLE_NEAR = 5;
const PARTICLE_FAR_MIN = 15000;

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

/**
 * 图层在父对象空间里的本地矩阵：`T(origin) · Rz(az) · Ry(ay) · Rx(ax) · S(scale)`，角度是弧度（2026-11-07 对 WPE 实测，
 * 含三轴旋转与非均匀缩放，四角差 0.0001 像素）。`angles` 的 x、y 为 0 时 Ry、Rx 是单位阵，结果与只转 z 轴的旧矩阵逐位相同。
 * `scale.z` 为 0 时按 1：WPE 在这种输入下的行为没有测过，保留 P1 的兜底。
 */
export function layerLocalMatrix(layer: Pick<LayerTransform, "origin" | "angles" | "scale">): Mat4 {
  const [x = 0, y = 0, z = 0] = layer.origin;
  const [sx = 1, sy = 1, sz = 1] = layer.scale;
  const [ax = 0, ay = 0, az = 0] = layer.angles;
  const rotation = multiply(multiply(multiply(translation(x, y, z), rotationZ(az)), rotationY(ay)), rotationX(ax));
  return multiply(rotation, scaling(sx, sy, sz === 0 ? 1 : sz));
}

/** 层级里一个对象的变换与可见性：`SceneLayer` 与 `LayerState` 都满足。 */
export interface LayerTransform {
  origin: readonly number[];
  angles: readonly number[];
  scale: readonly number[];
  visible: boolean;
  /** 父对象的 `objects` 下标；根节点为 null。 */
  parent: number | null;
}

/**
 * 自身和父链上每个对象都满足 `test`。父对象不在表里时当根节点（编译中途停下时 `layers` 只是 `objects` 的前缀）；
 * 环在编译期已断开，这里再按走过的节点兜底，不会死循环。对象自己不在表里时为 false。
 */
export function everyAncestor<T extends Pick<LayerTransform, "parent">>(
  object: number,
  layers: ReadonlyMap<number, T>,
  test: (layer: T) => boolean,
): boolean {
  if (!layers.has(object)) return false;
  const seen = new Set<number>();
  let current: number | null = object;
  while (current !== null && !seen.has(current)) {
    const layer = layers.get(current);
    if (!layer) break;
    if (!test(layer)) return false;
    seen.add(current);
    current = layer.parent;
  }
  return true;
}

/**
 * 沿父链走到根对象（视差的平移只看根，P5a 步骤 2，rea-p5-camera.md 6.3）。父对象不在表里时当根（同 `worldMatrixOf`）；环在编译期已断开，
 * 这里按走过的节点兜底。对象自己不在表里时返回它自己。
 */
export function rootObject(object: number, layers: ReadonlyMap<number, Pick<LayerTransform, "parent">>): number {
  const seen = new Set<number>();
  let current = object;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = layers.get(current)?.parent ?? null;
    if (parent === null || !layers.has(parent)) break;
    current = parent;
  }
  return current;
}

/** `visible` 沿父链：自身和所有祖先都可见才可见。`alpha`、`color`、`brightness` 不继承（P4a 实测）。 */
export function effectiveVisible(
  object: number,
  layers: ReadonlyMap<number, Pick<LayerTransform, "parent" | "visible">>,
): boolean {
  return everyAncestor(object, layers, (layer) => layer.visible);
}

/**
 * 世界矩阵 `W = W_parent · L`（L 见 {@link layerLocalMatrix}），惰性按父链算，结果记进 `cache`：子在父前也成立，
 * 一条链上的祖先只算一次。`cache` 跟随调用方的一次状态快照（一次建场景、一次 `sync`），状态变了要换新的。
 * 根节点直接是本地矩阵，不乘单位阵；父对象不在表里时当根节点；对象自己不在表里时为单位阵。
 */
export function worldMatrixOf(
  object: number,
  layers: ReadonlyMap<number, Pick<LayerTransform, "origin" | "angles" | "scale" | "parent">>,
  cache: Map<number, Mat4>,
): Mat4 {
  const cached = cache.get(object);
  if (cached) return cached;
  if (!layers.has(object)) return identity();
  // 往上收集还没算过的对象，直到根、已缓存的祖先或已走过的节点（环的兜底）
  const chain: number[] = [];
  const seen = new Set<number>();
  let base: Mat4 | null = null;
  let current: number | null = object;
  while (current !== null && !seen.has(current)) {
    const hit = cache.get(current);
    if (hit) {
      base = hit;
      break;
    }
    const layer = layers.get(current);
    if (!layer) break;
    seen.add(current);
    chain.push(current);
    current = layer.parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const local = layerLocalMatrix(layers.get(chain[i])!);
    base = base ? multiply(base, local) : local;
    cache.set(chain[i], base);
  }
  return base!;
}

/**
 * 正交场景的视图投影：场景 `[0, w] × [0, h]`（y 向上）铺满整个渲染目标，z ∈ [−2000, 2000] → 深度 [0, 1]（反向 Z，
 * 见 `ORTHO_DEPTH`）。1920×1080 时是 WPE 的 `[1/960, 0, 0, 0, 0, 1/540, 0, 0, 0, 0, 0.00025, 0, −1, −1, 0.5, 1]`。
 * `orthographic` 按 glm 的「视空间 z ∈ [−far, −near] → [0, 1]」，所以 near、far 反着传。
 *
 * `zoom` 是 `general.zoom`（P5a 步骤 4）：WPE 在 P 上绕场景中心乘它（p3-script-REPORT L2，`FUN_14017fa70` 的 `0x14017fd50`），即
 * `S(zoom, zoom, 1) · P`，x、y 的线性项与平移项都乘 zoom，场景中心仍落在 NDC 原点。按 float32 乘：步骤 4 补测 `p5a-zoomx15` / `zoomx08`
 * 读到的线性项正好是 `f32(zoom) · f32(2/W)`（换成 `2/(W/zoom)` 的取整对不上），视差与抖动的平移是场景单位、在缩放之前加
 * （`VP · T(o − s)`，实测差 1e-7）。zoom 为 1 时原样返回，字节同以前。
 */
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">, zoom = 1): Mat4 {
  const projection = orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH);
  // scaling 存成 float32，乘积在 double 里精确、写回时舍入一次，等于 float32 乘法
  return zoom === 1 ? projection : multiply(scaling(zoom, zoom, 1), projection);
}

/**
 * 透视粒子（系统 `flags & 4`，P4a 步骤 4）的视图投影，2026-11-07 对 WPE 实测（fov 95、60 两档，MVP 逐项对上）：
 * - 相机在 `(w/2, h/2, d)` 看向 −z、上方 +y，`d = (h/2) / tan(fov/2)`，所以 z = 0 平面和正交画面重合；
 * - 投影的纵向视角是 `fov`（`SceneGeneral.perspectiveOverrideFov`，弧度），宽高比 w/h；
 * - 反向 Z：near 5 → 深度 1，far `max(15000, d + 1000)` → 深度 0，z 系数 `n / (f − n)`。
 *
 * `zoom` 是 `general.zoom`（P5a 步骤 4）：d 取已含正交缩放的投影的可见高，`d = (h/(2·zoom)) / tan(fov/2)`（rea-p5-camera.md 7.2 的
 * `(1/P11)/tan(fov/2)`），far 用新的 d；投影本身（fov、宽高比）与相机的 x、y 不变。步骤 4 补测 `p5a-zoomx15` / `zoomx08` 两档 3 帧和 WPE
 * 逐项差 < 1e-4，按不缩放的 d 差上百。zoom 为 1 时字节同以前。
 */
export function particleViewProjection(
  general: Pick<SceneGeneral, "width" | "height" | "perspectiveOverrideFov">,
  zoom = 1,
): Mat4 {
  const { width, height } = general;
  const focal = 1 / Math.tan(general.perspectiveOverrideFov / 2);
  const d = (height / (2 * zoom)) * focal;
  const near = PARTICLE_NEAR;
  const far = Math.max(PARTICLE_FAR_MIN, d + 1000);
  const projection = new Float32Array(16);
  projection[0] = (focal * height) / width;
  projection[5] = focal;
  projection[10] = near / (far - near);
  projection[11] = -1;
  projection[14] = (far * near) / (far - near);
  return multiply(projection, translation(-width / 2, -height / 2, -d));
}

/**
 * 正交场景的 `g_EyePosition`：`(W/2 + ox, H/2 + oy, 2000)`，不取 JSON 的 `eye`（L2、L13）。W、H 是投影尺寸，不随渲染目标缩小。
 * `offset` 是本帧的抖动偏移 s（P5a 步骤 3，`shake.ts`）：WPE 先抖动 eye、再写 `g_EyePosition`（rea-p5-camera.md 第 5 节），缺省 (0, 0)。
 */
export function eyePosition(
  general: Pick<SceneGeneral, "width" | "height">,
  offset: readonly [number, number] = [0, 0],
): number[] {
  return [general.width / 2 + offset[0], general.height / 2 + offset[1], 2000];
}

/** 壁纸样式：与壁纸目标的样式（窗口模式）同义，几何照 `WallpaperStage` 的图片层。 */
export type SceneStyle = "fill" | "fit" | "stretch" | "center" | "tile";

/** 场景目标铺到画布的方式。 */
export interface ScenePlacement {
  /** 画布上画场景的矩形（x、y、宽、高，整数像素，左上为原点），矩形外是留白。 */
  rect: [number, number, number, number];
  /** 矩形左上角对应的场景纹理坐标。 */
  offset: [number, number];
  /** 矩形从左上到右下跨过的场景纹理坐标长度。`tile` 时大于 1，要重复采样。 */
  scale: [number, number];
}

/**
 * 按壁纸样式算铺放：`fill` 等比盖满（裁溢出）、`fit` 等比放进（留白）、`stretch` 拉满、`center` 一个场景像素对一个
 * 布局 CSS 像素（`pixelRatio` 换算成画布像素，见 {@link CanvasSize}；放不下就裁），`tile` 等比放进后居中重复。
 * 显示不下的部分都居中裁。
 * 矩形取整：`setViewport` 超出附件尺寸是校验错误，小数加回去可能多出一点。
 */
export function scenePlacement(
  style: SceneStyle,
  sceneWidth: number,
  sceneHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  pixelRatio = 1,
): ScenePlacement {
  const whole: ScenePlacement = { rect: [0, 0, canvasWidth, canvasHeight], offset: [0, 0], scale: [1, 1] };
  if (style === "stretch" || sceneWidth <= 0 || sceneHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return whole;
  const contain = Math.min(canvasWidth / sceneWidth, canvasHeight / sceneHeight);
  const cover = Math.max(canvasWidth / sceneWidth, canvasHeight / sceneHeight);
  const zoom = style === "fill" ? cover : style === "center" ? pixelRatio : contain;
  const shownWidth = sceneWidth * zoom;
  const shownHeight = sceneHeight * zoom;
  const width = style === "tile" ? canvasWidth : Math.min(canvasWidth, Math.max(1, Math.round(shownWidth)));
  const height = style === "tile" ? canvasHeight : Math.min(canvasHeight, Math.max(1, Math.round(shownHeight)));
  const scale: [number, number] = [width / shownWidth, height / shownHeight];
  return {
    rect: [Math.floor((canvasWidth - width) / 2), Math.floor((canvasHeight - height) / 2), width, height],
    offset: [(1 - scale[0]) / 2, (1 - scale[1]) / 2],
    scale,
  };
}

/**
 * 画布上的指针（0…1，左上为原点）→ 光标下的场景纹理坐标（0…1，左上原点、y 向下；P4c 步骤 2，控制点跟随指针用，见
 * `particles/controlpoints.ts` 的 `pointerScenePoint`）。所有样式都按铺放反算，即「光标下的那个场景点」：
 * - `fill`：等于 WPE 把居中盖满裁切做进投影 `P·V` 的结果（报告「步骤 2 补测」：1920×800、1440×1080 窗口下跟随点都是
 *   `inverse(P·V)` 作用在窗口指针上，即光标下的场景点）；
 * - `fit` / `center`：Kabegame 自己的样式，按同一原则，留白处线性外推（0…1 之外，不钳制，同 WPE 窗口外的外推）；
 * - `stretch`：铺放是恒等，原样返回；
 * - `tile`：取所在那一块（取小数部分）。
 */
export function sceneCursor(
  style: SceneStyle,
  placement: ScenePlacement,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
): [number, number] {
  if (style === "stretch") return [x, y];
  const [left, top, width, height] = placement.rect;
  const u = placement.offset[0] + ((x * canvasWidth - left) / width) * placement.scale[0];
  const v = placement.offset[1] + ((y * canvasHeight - top) / height) * placement.scale[1];
  return style === "tile" ? [u - Math.floor(u), v - Math.floor(v)] : [u, v];
}

/**
 * 画布上的指针（0…1，左上为原点）换算成 `g_PointerPosition`。`fill` / `stretch` 铺满窗口，原样（WPE 取窗口归一化坐标，
 * P2a；步骤 2 补测确认裁切时 WPE 的 `g_PointerPosition` 仍是窗口坐标）；其余样式画面不跟窗口对齐，换算到场景上（`sceneCursor`），
 * 光标效果才落在画面上，留白处的值在 0…1 之外，`tile` 按所在那一块算。和控制点的跟随点（`sceneCursor`）只在 `fill` 下不同。
 */
export function scenePointer(
  style: SceneStyle,
  placement: ScenePlacement,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
): [number, number] {
  if (style === "fill" || style === "stretch") return [x, y];
  return sceneCursor(style, placement, canvasWidth, canvasHeight, x, y);
}

/** 离屏目标尺寸：场景分辨率，超过设备上限时等比缩小。 */
export function sceneTargetSize(width: number, height: number, maxDimension: number): [number, number] {
  const w = Math.max(1, Math.round(width)),
    h = Math.max(1, Math.round(height));
  const k = Math.min(1, maxDimension / Math.max(w, h));
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}

/** 画布（上屏目标）的像素尺寸。 */
export interface CanvasSize {
  width: number;
  height: number;
  /**
   * 一个布局 CSS 像素（iframe 里的 CSS 像素，桌面上就是桌面的 CSS 像素）对多少画布像素：DPR × 显示缩放，超上限时
   * 再乘等比缩小的比例。`center` 样式按它铺放（`scenePlacement` 的 `pixelRatio`），预览里的构图才和桌面相同。
   */
  pixelRatio: number;
}

/**
 * 画布像素尺寸 = 布局尺寸 × DPR × 显示缩放，各边取整、至少 1。显示缩放是父页面把 iframe 缩小显示的比例（预览画布
 * 按内容尺寸布局、再整体 `scale`），iframe 里量不到，由父页面量好交来，缺省 1。超过设备上限时宽高按同一比例缩
 * （同 {@link sceneTargetSize}），宽高比不变，不会因为只钳了一边而在「适应」下多出留白。
 * 没超上限时就是 `round(布局 × DPR × 显示缩放)`；显示缩放为 1 时与只按 DPR 算的结果逐位相同。
 */
export function canvasSize(
  layoutWidth: number,
  layoutHeight: number,
  devicePixelRatio: number,
  displayScale: number,
  maxDimension: number,
): CanvasSize {
  const ratio = devicePixelRatio * displayScale;
  const w = layoutWidth * ratio,
    h = layoutHeight * ratio;
  const width = Math.max(1, Math.round(w)),
    height = Math.max(1, Math.round(h));
  if (width <= maxDimension && height <= maxDimension) return { width, height, pixelRatio: ratio };
  const k = maxDimension / Math.max(w, h);
  return {
    width: Math.min(maxDimension, Math.max(1, Math.round(w * k))),
    height: Math.min(maxDimension, Math.max(1, Math.round(h * k))),
    pixelRatio: ratio * k,
  };
}
