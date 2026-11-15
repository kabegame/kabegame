/**
 * `setParent(parent, attachment, adjust)` 的 adjust 数学（P6d3a，读码 `rea-p6d3-adjust.md` 第 1 节，exe `FUN_1401de750`；复算脚本
 * `ignore/p6/rea/layers/adjust/sim_adjust.py`，对步骤 0 日志的 s5 b / c 与 parent s2 逐位相同）。
 *
 * 全程 f32，每一步一次舍入，没有 FMA；矩阵列主序 `m[4c + r]`。逻辑：
 * - `L = inv(WP) · WO`：新父世界矩阵的逆乘旧世界矩阵，只取它的平移当新的 `origin`；
 * - 局部旋转 = 新父链「刚体」旋转的逆 × 自身链刚体旋转（每级只用 3×3 与 origin，过挂点，不乘 scale），按 glm `extractEulerAngleZYX` 反算角度；
 * - 缩放让新世界矩阵每列的长度等于旧的（`W1` 旧父下缩放为 1 的世界矩阵、`W2` 新父下缩放为 1 的世界矩阵，逐列按 len4）。
 * 所以保持的只有平移、每列长度与刚体意义下的旋转；新父链带非均匀缩放且相对角度不为 0 时剪切会丢。
 */
import { identity, multiply, type Mat4 } from "./math";
import { anglesRotation, worldMatrixOf, type LayerTransform } from "./layout";

const f = Math.fround;
const mul = (a: number, b: number): number => f(a * b);
const add = (a: number, b: number): number => f(a + b);
const sub = (a: number, b: number): number => f(a - b);
const cosf = (x: number): number => f(Math.cos(x));
const sinf = (x: number): number => f(Math.sin(x));
const atan2f = (y: number, x: number): number => f(Math.atan2(y, x));
const sqrtf = (x: number): number => (x >= 0 ? f(Math.sqrt(x)) : NaN);
/** `FLT_EPSILON`。 */
const EPS = f(1.1920929e-7);

/** glm `compute_inverse`（`FUN_14005f730`）：行列式按 `(x + y) + (z + w)` 成对相加，再 `1 / det` 逐元素相乘。 */
export function glmInverse(M: ArrayLike<number>): Mat4 {
  const m = (c: number, r: number): number => M[4 * c + r];
  const cf = (a: number, b: number, c: number, d: number): number => sub(mul(a, b), mul(c, d));
  const C0 = cf(m(2, 2), m(3, 3), m(3, 2), m(2, 3));
  const C2 = cf(m(1, 2), m(3, 3), m(3, 2), m(1, 3));
  const C3 = cf(m(1, 2), m(2, 3), m(2, 2), m(1, 3));
  const C4 = cf(m(2, 1), m(3, 3), m(3, 1), m(2, 3));
  const C6 = cf(m(1, 1), m(3, 3), m(3, 1), m(1, 3));
  const C7 = cf(m(1, 1), m(2, 3), m(2, 1), m(1, 3));
  const C8 = cf(m(2, 1), m(3, 2), m(3, 1), m(2, 2));
  const C10 = cf(m(1, 1), m(3, 2), m(3, 1), m(1, 2));
  const C11 = cf(m(1, 1), m(2, 2), m(2, 1), m(1, 2));
  const C12 = cf(m(2, 0), m(3, 3), m(3, 0), m(2, 3));
  const C14 = cf(m(1, 0), m(3, 3), m(3, 0), m(1, 3));
  const C15 = cf(m(1, 0), m(2, 3), m(2, 0), m(1, 3));
  const C16 = cf(m(2, 0), m(3, 2), m(3, 0), m(2, 2));
  const C18 = cf(m(1, 0), m(3, 2), m(3, 0), m(1, 2));
  const C19 = cf(m(1, 0), m(2, 2), m(2, 0), m(1, 2));
  const C20 = cf(m(2, 0), m(3, 1), m(3, 0), m(2, 1));
  const C22 = cf(m(1, 0), m(3, 1), m(3, 0), m(1, 1));
  const C23 = cf(m(1, 0), m(2, 1), m(2, 0), m(1, 1));
  const Fac0 = [C0, C0, C2, C3];
  const Fac1 = [C4, C4, C6, C7];
  const Fac2 = [C8, C8, C10, C11];
  const Fac3 = [C12, C12, C14, C15];
  const Fac4 = [C16, C16, C18, C19];
  const Fac5 = [C20, C20, C22, C23];
  const Vec0 = [m(1, 0), m(0, 0), m(0, 0), m(0, 0)];
  const Vec1 = [m(1, 1), m(0, 1), m(0, 1), m(0, 1)];
  const Vec2 = [m(1, 2), m(0, 2), m(0, 2), m(0, 2)];
  const Vec3 = [m(1, 3), m(0, 3), m(0, 3), m(0, 3)];
  // (A * FA - B * FB) + C * FC
  const comb = (A: number[], FA: number[], B: number[], FB: number[], C: number[], FC: number[]): number[] =>
    A.map((_, i) => add(sub(mul(A[i], FA[i]), mul(B[i], FB[i])), mul(C[i], FC[i])));
  const Inv0 = comb(Vec1, Fac0, Vec2, Fac1, Vec3, Fac2);
  const Inv1 = comb(Vec0, Fac0, Vec2, Fac3, Vec3, Fac4);
  const Inv2 = comb(Vec0, Fac1, Vec1, Fac3, Vec3, Fac5);
  const Inv3 = comb(Vec0, Fac2, Vec1, Fac4, Vec2, Fac5);
  const SA = [1, -1, 1, -1];
  const SB = [-1, 1, -1, 1];
  const I = [
    Inv0.map((v, i) => mul(v, SA[i])),
    Inv1.map((v, i) => mul(v, SB[i])),
    Inv2.map((v, i) => mul(v, SA[i])),
    Inv3.map((v, i) => mul(v, SB[i])),
  ];
  const row0 = [I[0][0], I[1][0], I[2][0], I[3][0]];
  const d = row0.map((v, i) => mul(m(0, i), v));
  const dot1 = add(add(d[0], d[1]), add(d[2], d[3]));
  const ood = f(1 / dot1);
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[4 * c + r] = mul(I[c][r], ood);
  return out;
}

/** 4 个分量平方按给定的加法结合顺序求和再开方（`FUN_1401e24b0` 与 adjust 里几处内联的写法各不相同，逐列照 `sim_adjust.py`）。 */
function len4(W: ArrayLike<number>, column: number, order: "a" | "b" | "c"): number {
  const sq = [0, 1, 2, 3].map((r) => mul(W[4 * column + r], W[4 * column + r]));
  let s: number;
  // a：(v0² + v1²) + (v2² + v3²)；b：(v3² + v2²) + (v1² + v0²)；c：(v0² + v1²) + (v3² + v2²)
  if (order === "a") s = add(add(sq[0], sq[1]), add(sq[2], sq[3]));
  else if (order === "b") s = add(add(sq[3], sq[2]), add(sq[1], sq[0]));
  else s = add(add(sq[0], sq[1]), add(sq[3], sq[2]));
  return sqrtf(s);
}

/** 参与 adjust 的图层字段（`LayerState` 满足）。 */
export type AdjustLayer = Pick<LayerTransform, "origin" | "angles" | "scale" | "rotation" | "parent">;

/** adjust 的结果：写回 `origin` / `angles`（弧度）/ `scale`；`angles` 写入后 3×3 由角度重建。 */
export interface AdjustResult {
  origin: [number, number, number];
  angles: [number, number, number];
  scale: [number, number, number];
}

/**
 * adjust 为真、没有挂点：`object` 换到 `parent`（null 是根）下，返回新的本地字段。`layers` 是换父之前的状态（`object` 的 `parent` 仍是旧父）；
 * `attach` 是挂点钩子（同 `worldMatrixOf`，父 puppet 骨骼的 `Pose · Att`，没有时 null）。不改传入的任何东西。
 */
export function adjustReparent(
  object: number,
  parent: number | null,
  layers: ReadonlyMap<number, AdjustLayer>,
  attach?: (object: number) => Mat4 | null,
): AdjustResult | null {
  const self = layers.get(object);
  if (!self) return null;
  const world = (map: ReadonlyMap<number, AdjustLayer>, target: number): Mat4 =>
    worldMatrixOf(target, map, new Map(), attach);
  const WP = parent !== null && layers.has(parent) ? world(layers, parent) : identity();
  const WO = world(layers, object);
  const L = multiply(glmInverse(WP), WO);
  // 刚体链：每级只取 3×3 与 origin（缩放全当 1）
  const unit = new Map<number, AdjustLayer>();
  for (const [key, value] of layers) unit.set(key, { ...value, scale: [1, 1, 1] });
  const RP = parent !== null && layers.has(parent) ? world(unit, parent) : identity();
  const RO = world(unit, object);
  const Rr = multiply(glmInverse(RP), RO);
  const sOld = [self.scale[0] ?? 1, self.scale[1] ?? 1, self.scale[2] ?? 1];
  // W1：旧父、旧 3×3、旧 origin、自身缩放 1
  const W1 = world(new Map(layers).set(object, { ...self, scale: [1, 1, 1] }), object);
  // glm extractEulerAngleZYX
  const z = atan2f(Rr[1], Rr[0]);
  const y = atan2f(-Rr[2], sqrtf(add(mul(Rr[6], Rr[6]), mul(Rr[10], Rr[10]))));
  const sz = sinf(z);
  const cz = cosf(z);
  const x = atan2f(sub(mul(Rr[8], sz), mul(Rr[9], cz)), sub(mul(Rr[5], cz), mul(sz, Rr[4])));
  const origin: [number, number, number] = [L[12], L[13], L[14]];
  const angles: [number, number, number] = [x, y, z];
  // W2：新父、新 3×3（按角度重建）、新 origin、缩放 1
  const next = new Map(layers);
  next.set(object, { origin, angles, scale: [1, 1, 1], rotation: anglesRotation(angles), parent });
  const W2 = world(next, object);
  const lo = [len4(W1, 0, "a"), len4(W1, 1, "b"), len4(W1, 2, "b")];
  const ln = [len4(W2, 0, "a"), len4(W2, 1, "c"), len4(W2, 2, "c")];
  const inv = ln.map((length) => (length > EPS ? f(1 / length) : 1));
  const scale: [number, number, number] = [
    mul(mul(sOld[0], lo[0]), inv[0]),
    mul(mul(lo[1], sOld[1]), inv[1]),
    mul(mul(lo[2], sOld[2]), inv[2]),
  ];
  return { origin, angles, scale };
}
