/**
 * 图层转向的纯函数（P6d1a 点 1，读码 `rea-p6d1-xform.md` 1.3 / 1.4 / 3.2–3.4；对 WPE 2.8.42 的实测见 `rotation.test.ts`）。
 *
 * 全部照 WPE 的单精度顺序：每个运算一次 f32 舍入（`Math.fround`），括号即运算顺序，没有 FMA；`cosf` / `sinf` / `atan2f` 用 `Math.*`
 * 再舍入，`sqrtf` 用 `Math.sqrt` 再舍入（`sqrtss` 与它逐位相同）。3×3 一律列主序 `R[3c + r]`（同 `layerLocalMatrix` 的 `R`）。
 * 角度都是弧度；脚本侧的度 ↔ 弧度换算在 `script/f32.ts`。
 */

const f = Math.fround;
const mul = (a: number, b: number): number => f(a * b);
const add = (a: number, b: number): number => f(a + b);
const sub = (a: number, b: number): number => f(a - b);
const cosf = (x: number): number => f(Math.cos(x));
const sinf = (x: number): number => f(Math.sin(x));
const atan2f = (y: number, x: number): number => f(Math.atan2(y, x));
/** `x ≥ 0` 是 `sqrtss`；负数与 NaN 走 CRT 的出错分支，结果是 NaN。 */
const sqrtf = (x: number): number => (x >= 0 ? f(Math.sqrt(x)) : NaN);

/** `FLT_EPSILON`（`lookAt` 的退化阈值，exe `0x1404925e0`）。 */
const FLT_EPSILON = f(1.1920929e-7);

type Vec3 = readonly [number, number, number];

/**
 * `R ← R · Rz(v.z) · Ry(v.y) · Rx(v.x)`（`FUN_1401df620`，绕物体自己的轴转）：每一步是 glm `rotate(M, a, e_i)` 的通式，轴向对角元是
 * `(1 − c) + c`（`c < 0.5` 时 `1 − c` 有舍入，和不一定正好是 1），所以不手写 `Rz` / `Ry` / `Rx`。`v` 是弧度。返回新的 9 元素数组。
 */
export function rotateObjectSpace(R: readonly number[], v: Vec3): number[] {
  // M[c][r] = m[3c + r]
  let m = Array.from(R, f);
  const angles = [f(v[0]), f(v[1]), f(v[2])];
  for (const i of [2, 1, 0]) {
    const a = angles[i];
    const c = cosf(a);
    const s = sinf(a);
    const e = [0, 0, 0];
    e[i] = 1;
    const l2 = add(add(mul(e[0], e[0]), mul(e[1], e[1])), mul(e[2], e[2]));
    const inv = f(1 / sqrtf(l2));
    const nz = mul(e[2], inv);
    const nx = mul(inv, e[0]);
    const ny = mul(inv, e[1]);
    const k = sub(1, c);
    const tz = mul(nz, k);
    const tx = mul(nx, k);
    const ty = mul(ny, k);
    // 轴向旋转 R[j][r]（列 j）
    const r = [
      [add(mul(tx, nx), c), add(mul(nz, s), mul(tx, ny)), sub(mul(tx, nz), mul(ny, s))],
      [sub(mul(ty, nx), mul(nz, s)), add(mul(ty, ny), c), add(mul(ty, nz), mul(nx, s))],
      [add(mul(nx, tz), mul(ny, s)), sub(mul(ny, tz), mul(nx, s)), add(mul(tz, nz), c)],
    ];
    const next = new Array<number>(9);
    for (let j = 0; j < 3; j++)
      for (let row = 0; row < 3; row++)
        next[3 * j + row] = add(add(mul(m[row], r[j][0]), mul(m[3 + row], r[j][1])), mul(m[6 + row], r[j][2]));
    m = next;
  }
  return m;
}

/**
 * 3×3 → 角度（弧度，`[x, y, z]`；glm `extractEulerAngleZYX`，`FUN_1401df620` 尾部，读码 1.4）：`x`、`z` 在 `(−π, π]`，`y` 在
 * `[−π/2, π/2]`，所以 `rotateObjectSpace` 之后读回的角度是归一化的。
 */
export function extractEulerZYX(R: readonly number[]): [number, number, number] {
  const z = atan2f(R[1], R[0]);
  const s1 = sinf(z);
  const c1 = cosf(z);
  const x = atan2f(sub(mul(s1, R[6]), mul(c1, R[7])), sub(mul(c1, R[4]), mul(s1, R[3])));
  const q = add(mul(R[8], R[8]), mul(R[5], R[5]));
  const y = atan2f(-R[2], sqrtf(q));
  return [x, y, z];
}

/** `glm::lookAtRH` 的旋转部分（`FUN_14019d920`）：返回 `s`、`u`、`f`（物体本地 X、Y 与视线），零向量 `normalize` 得 NaN / inf 照算。 */
function lookAtBasis(eye: Vec3, center: Vec3, up: Vec3): { s: Vec3; u: Vec3; f: Vec3 } {
  let fx = sub(center[0], eye[0]);
  let fy = sub(center[1], eye[1]);
  let fz = sub(center[2], eye[2]);
  let inv = f(1 / sqrtf(add(add(mul(fx, fx), mul(fy, fy)), mul(fz, fz))));
  fx = mul(fx, inv);
  fy = mul(fy, inv);
  fz = mul(fz, inv);
  let sx = sub(mul(up[2], fy), mul(up[1], fz));
  let sy = sub(mul(up[0], fz), mul(up[2], fx));
  let sz = sub(mul(up[1], fx), mul(up[0], fy));
  inv = f(1 / sqrtf(add(add(mul(sx, sx), mul(sy, sy)), mul(sz, sz))));
  sx = mul(sx, inv);
  sy = mul(sy, inv);
  sz = mul(sz, inv);
  const ux = sub(mul(fz, sy), mul(fy, sz));
  const uy = sub(mul(fx, sz), mul(fz, sx));
  const uz = sub(mul(fy, sx), mul(fx, sy));
  return { s: [sx, sy, sz], u: [ux, uy, uz], f: [fx, fy, fz] };
}

/** 从视图矩阵 V 取 ZYX 角度（`0x1401dfd3e`–`0x1401dfdfa`），`V[0] = (s.x, u.x, −f.x)`、`V[1] = (s.y, u.y, −f.y)`、`V[2] = (s.z, u.z, −f.z)`。 */
function anglesFromBasis(b: { s: Vec3; u: Vec3; f: Vec3 }): [number, number, number] {
  const { s, u, f: fw } = b;
  const z = atan2f(s[1], s[0]);
  const s1 = sinf(z);
  const c1 = cosf(z);
  const y = atan2f(-s[2], sqrtf(add(mul(-fw[2], -fw[2]), mul(u[2], u[2]))));
  const x = atan2f(sub(mul(s1, -fw[0]), mul(c1, -fw[1])), sub(mul(c1, u[1]), mul(s1, u[0])));
  return [x, y, z];
}

/**
 * 朝向目标的角度（弧度 `[x, y, z]`），`null` = 什么也不做（`|d|² ≤ FLT_EPSILON` 或含 NaN，`FUN_1401dfc00`，读码 3.3）。
 * `eye` 与 `target` 同在父对象的本地空间（不读父链）；非相机对象把目标镜像到 `eye − d`（本地 +Z 对着目标），相机用目标本身（−Z）。
 * 视线与 `up` 平行时 `normalize` 得 NaN，角度全 NaN（WPE 没有防护，照算）。结果交给普通的 `angles` 写入。
 */
export function lookAtAngles(eye: Vec3, target: Vec3, up: Vec3, camera: boolean): [number, number, number] | null {
  const o = [f(eye[0]), f(eye[1]), f(eye[2])] as const;
  const t = [f(target[0]), f(target[1]), f(target[2])] as const;
  const u = [f(up[0]), f(up[1]), f(up[2])] as const;
  const dx = sub(t[0], o[0]);
  const dy = sub(t[1], o[1]);
  const dz = sub(t[2], o[2]);
  const center: Vec3 = camera ? t : [sub(o[0], dx), sub(o[1], dy), sub(o[2], dz)];
  if (!(add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz)) > FLT_EPSILON)) return null;
  return anglesFromBasis(lookAtBasis(o, center, u));
}

/**
 * `lookAt` 的偏航版（`FUN_1401dfe30`，读码 3.4）：先把视线里沿 `up` 的分量减掉 `d′ = d − up·(up·d)`（`up` 不归一化），其余同
 * {@link lookAtAngles}；`|d′|² ≤ FLT_EPSILON`（目标正好在 `up` 方向上）返回 `null`。
 */
export function lookAtYawAngles(eye: Vec3, target: Vec3, up: Vec3, camera: boolean): [number, number, number] | null {
  const o = [f(eye[0]), f(eye[1]), f(eye[2])] as const;
  const t = [f(target[0]), f(target[1]), f(target[2])] as const;
  const u = [f(up[0]), f(up[1]), f(up[2])] as const;
  const d = [sub(t[0], o[0]), sub(t[1], o[1]), sub(t[2], o[2])];
  const k = add(add(mul(u[0], d[0]), mul(u[1], d[1])), mul(u[2], d[2]));
  const dx = sub(d[0], mul(u[0], k));
  const dy = sub(d[1], mul(u[1], k));
  const dz = sub(d[2], mul(u[2], k));
  const center: Vec3 = camera
    ? [add(o[0], dx), add(o[1], dy), add(o[2], dz)]
    : [sub(o[0], dx), sub(o[1], dy), sub(o[2], dz)];
  if (!(add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz)) > FLT_EPSILON)) return null;
  return anglesFromBasis(lookAtBasis(o, center, u));
}
