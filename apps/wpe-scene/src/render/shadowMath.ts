/**
 * 阴影的纯计算（P13d，rea-p13-passes 第 2 节、rea-p13-shadows R3、R4 与「点光阴影 pass 的 −0.00333」）：方块边长、点光六面的投影与视图、
 * 平行光三级联的视图投影、图集打包、每条条目的视口与方块变换；聚光（P13i）的视图投影复用体积光的 `spotViewProjection`。全部按 WPE 的 float32 逐步算，不碰 GPU，单测直接用抓帧的值核对。
 *
 * 矩阵约定同 `math.ts`：列主序、`M * v`。WPE 的行向量写法 `VP = V · P` 在这里是 `multiply(P, V)`（`multiply` 的累加顺序就是 WPE 的
 * `((t0 + t1) + t2) + t3`）；WPE 的 `VP[3][2]`（深度列的平移项）是这里的下标 14。
 */
import type { LightFrame, SceneLight, ShadowEntry } from "../compile/lights";
import { spotViewProjection } from "../compile/volumetrics";
import { perspectiveFov, perspectiveRH } from "./camera";
import { fastInverseSqrt, multiply, type Mat4 } from "./math";

const f = Math.fround;

/** 方块边长（`FUN_14025d3e0`）：档位 1、2 → 256，3 → 512，4 → 1024，其他 256。 */
export function shadowBlockSize(quality: number): number {
  return quality === 3 ? 512 : quality === 4 ? 1024 : 256;
}

/** 点光阴影投影的竖直 fov（度）：档位 1、2 → 94，3 → 92，4 及其他 → 91.2（`0x14025d9c1`）。 */
export function pointShadowFovDegrees(quality: number): number {
  return quality === 1 || quality === 2 ? 94 : quality === 3 ? 92 : 91.2;
}

/** 点光阴影 pass 画阴影时投影的深度偏移（`0x1404929a8`，位模式 `0xbb5a3c21`）：加在 `P32` 上，uniform 不带。 */
export const POINT_SHADOW_DEPTH_OFFSET = f(-0.00333);
/** 平行光 / 聚光阴影 pass 的 `VP[3][2] −= 0.0005`（`0x14019632a`），uniform 不带。 */
export const CASCADE_DEPTH_OFFSET = f(0.0005);

/**
 * 点光的阴影投影（`FUN_14025d420` 类型 0）：`PerspectiveFovRH(fov, 1, near, far)` 的反向深度，近平面正交场景 1、透视场景
 * `max(0.05, lightsourcesize)`，远平面 `max(radius, near + 0.01)`。`info` 是 `g_LFeature_ShadowPointProjection` = (P22, P32, P23, P33)，
 * `shadow` 是画阴影用的、`P32` 加了 {@link POINT_SHADOW_DEPTH_OFFSET} 的那份。
 */
export function pointShadowProjection(
  light: Pick<SceneLight, "radius" | "lightSourceSize">,
  quality: number,
  orthographic: boolean,
): { projection: Mat4; info: [number, number, number, number]; shadow: Mat4 } {
  const near = orthographic ? 1 : f(Math.max(0.05, f(light.lightSourceSize)));
  const far = f(Math.max(f(light.radius), f(near + f(0.01))));
  const projection = perspectiveRH(perspectiveFov(pointShadowFovDegrees(quality)), 1, near, far);
  const shadow = new Float32Array(projection);
  shadow[14] = f(projection[14] + POINT_SHADOW_DEPTH_OFFSET);
  return { projection, info: [projection[10], projection[14], projection[11], projection[15]], shadow };
}

/**
 * 点光六个面的视图（`common_pbr_2.h` 的 `CalculateProjectedCoordsPoint`，与 CPU 的面顺序、视口一致，rea-p13-passes 2.3）：
 * +X、−X、+Y、−Y、+Z、−Z。着色器里是行向量写法的 `mat4(...)`，16 个数原样就是这里的列主序。
 */
export function pointShadowViews(origin: readonly number[]): Mat4[] {
  const [x, y, z] = origin.map((v) => f(v));
  // `-0` 与 `0` 在乘法里只影响零的符号，照着色器的写法取反
  return [
    [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -z, -y, x, 1],
    [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, z, -y, -x, 1],
    [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -x, -z, y, 1],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, -x, z, -y, 1],
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, x, -y, z, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1],
  ].map((values) => new Float32Array(values));
}

/** 级联参数 `(a, b)`（`FUN_14025d370`）：c0 = (cd0, 4·cd1)，c1 = (cd1, 4·cd1)，c2 = (cd2, max(1.5·cd2, 4·cd1))。 */
export function cascadeExtents(distances: readonly number[], cascade: number): [number, number] {
  const [d0, d1, d2] = distances.map((v) => f(v));
  const far1 = f(4 * d1);
  if (cascade === 0) return [d0, far1];
  if (cascade === 1) return [d1, far1];
  return [d2, Math.max(f(1.5 * d2), far1)];
}

/** C 的 `fmodf`：向零截断，结果与被除数同号（`FUN_14041d0c0`，内部转 double，结果精确）。 */
function fmodf(x: number, y: number): number {
  return f(x % y);
}

/** `FUN_1400dc250`：三分量按快速倒数平方根归一化。 */
function qnorm(v: readonly number[]): number[] {
  const l2 = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  const r = fastInverseSqrt(l2);
  return [f(v[0] * r), f(v[1] * r), f(v[2] * r)];
}

/**
 * 平行光第 `cascade` 级的视图投影（不带偏移，uniform 用这份；rea-p13-shadows R3 的 1–8 步，全程 float32）：
 * 1. `M` 是灯的本地矩阵（列 0/1/2 = 局部 X/Y/Z 轴，列 3 = origin）；`(a, b)` 是这一级的范围，`ha = a/2`、`hb = b/2`；
 * 2. `L = normalize(列 0)`（`sqrtss`、`1/len`，长度含 w² = 0）；
 * 3. `F' = F − (L·(F·L))·0.5`（F 是 `g_ViewForward`）；
 * 4. 中心 `e = eye + F'·ha`，正交场景 `e.z = 0`；
 * 5. 防抖：`t = a / S`，`e −= Y·fmodf(dot(Y, e), t)`，再 `e −= Z·fmodf(dot(Z, e₀), t)`（dZ 用减 Y 之前的 e；Y、Z 不归一化）；
 * 6. 视图 V：三列（行向量写法）是快速倒数平方根归一化的 Z、Y、−X，平移 `−dot(n_j, e)`；
 * 7. 投影：正交 off-center，x、y ∈ [−ha, ha]，z ∈ [−hb, hb]，深度 = z_view / b + 0.5；
 * 8. `VP = V · P`。
 */
export function cascadeViewProjection(
  light: Pick<SceneLight, "matrix" | "cascades">,
  cascade: number,
  forward: readonly number[],
  eye: readonly number[],
  orthographic: boolean,
  blockSize: number,
): Mat4 {
  const m = light.matrix;
  const [a, b] = cascadeExtents(light.cascades, cascade);
  const ha = f(a * 0.5);
  const hb = f(b * 0.5);
  const X = [m[0], m[1], m[2], m[3]];
  const Y = [m[4], m[5], m[6]];
  const Z = [m[8], m[9], m[10]];
  // 2. normalize4(row0)
  const length = f(Math.sqrt(f(f(f(f(X[0] * X[0]) + f(X[1] * X[1])) + f(X[2] * X[2])) + f(X[3] * X[3]))));
  const inv = f(1 / length);
  const L = [f(X[0] * inv), f(X[1] * inv), f(X[2] * inv)];
  // 3.
  const F = forward.map((v) => f(v));
  const d = f(f(f(F[0] * L[0]) + f(F[1] * L[1])) + f(F[2] * L[2]));
  const Fp = [0, 1, 2].map((k) => f(F[k] - f(f(L[k] * d) * 0.5)));
  // 4.
  const e = [
    f(f(Fp[0] * ha) + f(eye[0])),
    f(f(Fp[1] * ha) + f(eye[1])),
    orthographic ? 0 : f(f(Fp[2] * ha) + f(eye[2])),
  ];
  // 5.
  const t = f(a / blockSize);
  const dot3 = (u: readonly number[], v: readonly number[]) => f(f(f(u[0] * v[0]) + f(u[1] * v[1])) + f(u[2] * v[2]));
  const dZ = dot3(Z, e);
  const dY = dot3(Y, e);
  const mY = fmodf(dY, t);
  for (let k = 0; k < 3; k++) e[k] = f(e[k] - f(Y[k] * mY));
  const mZ = fmodf(dZ, t);
  for (let k = 0; k < 3; k++) e[k] = f(e[k] - f(Z[k] * mZ));
  // 6.
  const n = [qnorm(Z), qnorm(Y), qnorm([-X[0], -X[1], -X[2]])];
  const view = new Float32Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) view[i * 4 + j] = n[j][i];
  for (let j = 0; j < 3; j++) view[12 + j] = f(-dot3(n[j], e));
  view[11] = -0;
  view[15] = 1;
  // 7.
  const width = f(ha - -ha);
  const depth = f(-hb - hb);
  const projection = new Float32Array(16);
  projection[0] = f(2 / width);
  projection[5] = f(2 / width);
  projection[10] = f(-1 / depth);
  projection[12] = -0;
  projection[13] = -0;
  projection[14] = f(-hb / depth);
  projection[15] = 1;
  // 8.
  return multiply(projection, view);
}

/** 图集里的一块：左上角与边长（像素）。 */
export interface AtlasBlock {
  x: number;
  y: number;
  size: number;
}

/** 打包结果：各条目的块（与条目同序）与图集尺寸。 */
export interface AtlasLayout {
  blocks: AtlasBlock[];
  width: number;
  height: number;
}

/**
 * 图集打包（rea-p13-shadows R4）：条目按「点光在前、边长降序」稳定排序，依次放进一组空闲矩形（初值宽 8192 的空条带）：试一个矩形时先让它
 * 向下长到至少 S 高；放得下就放在它的左上角、它的 x0 右移 S、追加块下方的竖条；放不下就追加一条整宽条带、试下一个。
 * 图集尺寸 = `max(2, 最右)` × `max(2, 最下)`。上一帧布局在条目数相同、排序后逐个边长相同时原样复用。
 */
export function packShadowAtlas(
  entries: readonly { point: boolean; size: number }[],
  previous?: { sizes: number[]; positions: [number, number][] },
): AtlasLayout & { sizes: number[]; positions: [number, number][] } {
  const order = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (b.entry.point ? 1 << 15 : 0) + b.entry.size - ((a.entry.point ? 1 << 15 : 0) + a.entry.size) ||
        a.index - b.index,
    );
  const sizes = order.map((item) => item.entry.size);
  let positions: [number, number][];
  if (previous && previous.sizes.length === sizes.length && previous.sizes.every((size, i) => size === sizes[i]))
    positions = previous.positions;
  else {
    positions = [];
    const free: { x0: number; x1: number; y0: number; y1: number }[] = [{ x0: 0, x1: 8192, y0: 0, y1: 0 }];
    for (const size of sizes) {
      let placed = false;
      for (let i = 0; i < free.length && !placed; i++) {
        const rect = free[i];
        rect.y1 = Math.max(rect.y1, rect.y0 + size);
        if (rect.x1 - rect.x0 >= size && rect.y1 - rect.y0 >= size) {
          const x = rect.x0;
          positions.push([x, rect.y0]);
          rect.x0 += size;
          free.push({ x0: x, x1: x + size, y0: rect.y0 + size, y1: rect.y1 });
          placed = true;
        } else free.push({ x0: 0, x1: 8192, y0: rect.y1, y1: rect.y1 });
      }
    }
  }
  const blocks: AtlasBlock[] = new Array(entries.length);
  let width = 2;
  let height = 2;
  order.forEach((item, k) => {
    const [x, y] = positions[k];
    blocks[item.index] = { x, y, size: item.entry.size };
    width = Math.max(width, x + item.entry.size);
    height = Math.max(height, y + item.entry.size);
  });
  return { blocks, width, height, sizes, positions };
}

/** 方块变换 `(x / W, y / H, S / W, S / H)`（W、H 是图集 RT 的实际尺寸，R4.5）。 */
export function atlasTransform(block: AtlasBlock, width: number, height: number): [number, number, number, number] {
  return [f(block.x / width), f(block.y / height), f(block.size / width), f(block.size / height)];
}

/** 一个阴影视图：视口（像素）与画阴影用的视图投影（已带深度偏移）。 */
export interface ShadowView {
  viewport: [number, number, number, number];
  viewProjection: Mat4;
}

/** 一帧的阴影：图集尺寸与逐条目的视图（点光 6 个、聚光与平行光 1 个）。 */
export interface ShadowPlan {
  width: number;
  height: number;
  views: ShadowView[][];
  layout: ReturnType<typeof packShadowAtlas>;
}

/**
 * 给一帧的阴影条目打包、算视图投影，并把 uniform（投影与方块变换）写进灯光整块缓冲（`LightFrame.buffer`）：
 * - 点光：`g_LFeature_ShadowPointProjection[slot]` = 不偏的 (P22, P32, P23, P33)，方块变换写 `…PointProjectionTransform[slot]`；六个面的视口是
 *   `(x + {0, S/2}, y + {0, S/3, 2S/3})`、大小 `(S/2, S/3)`（整数除），视图投影 `V_面 · P'`（P' 带 −0.00333）；
 * - 平行光：`g_LFeature_ShadowProjection[slot]` = 不偏的 VP，方块变换写 `…ProjectionTransform[slot]`；视口整块，阴影 pass 用 `VP[3][2] − 0.0005`；
 * - 聚光（P13i）：同平行光的一级，VP 是 `spotViewProjection(世界矩阵, outercone, radius, 正交)`（`FUN_14025d420` 类型 1，存灯的 `+0x338`），
 *   不是点光，打包时和级联同边长、按生成顺序排在它们前面。
 * `atlas` 给出现有 RT 的尺寸（R4.5：两边都够就不动，任一边不够改成恰好需要的），返回值的 `width` / `height` 是这一帧要用的 RT 尺寸。
 */
export function planShadows(
  frame: LightFrame,
  quality: number,
  forward: readonly number[],
  eye: readonly number[],
  orthographic: boolean,
  atlas: { width: number; height: number } | null,
  previous?: ShadowPlan["layout"],
): ShadowPlan {
  const size = shadowBlockSize(quality);
  const layout = packShadowAtlas(
    frame.entries.map((entry: ShadowEntry) => ({ point: entry.kind === "point", size })),
    previous,
  );
  const fits = atlas && atlas.width >= layout.width && atlas.height >= layout.height;
  const width = fits ? atlas.width : layout.width;
  const height = fits ? atlas.height : layout.height;
  const write = (at: number, values: ArrayLike<number>) => {
    for (let k = 0; k < values.length; k++) if (at + k < frame.buffer.length) frame.buffer[at + k] = values[k];
  };
  const views = frame.entries.map((entry, index): ShadowView[] => {
    const block = layout.blocks[index];
    const transform = atlasTransform(block, width, height);
    if (entry.kind === "point") {
      const { info, shadow } = pointShadowProjection(entry.light, quality, orthographic);
      write(frame.layout.pointProjection + entry.slot * 4, info);
      write(frame.layout.pointProjectionTransform + entry.slot * 4, transform);
      const half = Math.trunc(size / 2);
      const third = Math.trunc(size / 3);
      return pointShadowViews(entry.light.origin).map((view, face) => ({
        viewport: [block.x + (face % 2) * half, block.y + Math.trunc(face / 2) * third, half, third],
        viewProjection: multiply(shadow, view),
      }));
    }
    const vp =
      entry.kind === "spot"
        ? spotViewProjection(entry.light.matrix, entry.light.outercone, entry.light.radius, orthographic)
        : cascadeViewProjection(entry.light, entry.cascade ?? 0, forward, eye, orthographic, size);
    write(frame.layout.projection + entry.slot * 16, vp);
    write(frame.layout.projectionTransform + entry.slot * 4, transform);
    const biased = new Float32Array(vp);
    biased[14] = f(vp[14] - CASCADE_DEPTH_OFFSET);
    return [{ viewport: [block.x, block.y, size, size], viewProjection: biased }];
  });
  return { width, height, views, layout };
}
