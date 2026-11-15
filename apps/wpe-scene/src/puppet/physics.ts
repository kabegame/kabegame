/**
 * 骨骼物理求解（P12d-1，WPE 图像层更新 `FUN_1401fdf90` 里 `0x14020136e`–`0x14020364e` 那一段）。纯 TS、不依赖 GPU 与编译管线。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/rea-p12-attach-physics.md` 2.3–2.6（读码），`p12-REPORT.md` 用例 10 与第二部分第 1 节（实测），
 * 参考实现 `ignore/p12/rea/attach/physmodel.py` 的 `solve`（numpy float32，运算顺序照汇编）。
 * - 全程 float32：每一步运算都 `Math.fround`（没有 FMA）；`sin` / `cos` / `atan2` / `acos` / `fmod` 等在 double 里算、结果舍入到 float
 *   （WPE 的 CRT 同样是双精度实现再转 float）；矩阵是列主序、列向量约定（同 `puppet/math.ts`），16 个数，第 c 列在 `[4c .. 4c+3]`；
 *   内部的 3×3 一律列主序 9 个数（第 c 列在 `[3c .. 3c+2]`）。
 * - 逐位一致做不到：`rotTo` 的点积阈值（`0.999999881`）附近差 1 ulp 就翻转判定，`re` 又不回弹，翻转会一直留着；上游动画采样里有 `rsqrtps`，
 *   `A⁻¹` 在 WPE 是 SIMD 叉积、这里用双精度伴随矩阵再舍入。验收按 p12-REPORT 第二部分 1.3 的误差包络。
 * - 语料 0 处、没实测，只照读码实现的：`lt`（每轴角速度限幅）、平移轴锁、`t + re`（读码 2.4 有公式，p12d 子计划「决定」）。
 */
import type { BonePhysics } from "../compile/puppet";

const f = Math.fround;

const DEG = f(0.017453292);
const RAD = f(57.29578);
const PI = f(3.141592741);
const TWO_PI = f(6.283185482);
/** `slerp` 改线性插值与 `rotTo` 判单位的阈值（`0x140492700`）。 */
const SLERP_LIN = f(0.999999881);
/** `1 / 60`（`0x1404926..`）：角速度四元数「每 1/60 s 转一个」。 */
const STEP = f(0.016666668);

/** 一根骨骼的物理状态（WPE `P+0x3b8` 每骨骼 0x50 字节，rea-AP 2.3）。 */
export interface BoneState {
  /** 角速度四元数 w x y z（每 1/60 s 转多少）。 */
  q: Float32Array;
  /** 相对本帧动画姿势的欧拉角 x y z（弧度），`R = Rz·Ry·Rx`。 */
  ang: Float32Array;
  /** 平移偏移（世界坐标）。 */
  off: Float32Array;
  /** 平移速度（世界坐标）。 */
  vel: Float32Array;
}

/** 初值（`FUN_140215ba0`）：`q = (1, 0, 0, 0)`，其余 0。 */
export function createBoneState(): BoneState {
  const state: BoneState = {
    q: new Float32Array(4),
    ang: new Float32Array(3),
    off: new Float32Array(3),
    vel: new Float32Array(3),
  };
  resetBoneState(state);
  return state;
}

/** 复位成初值（`resetBonePhysicsSimulation`、首次更新）。 */
export function resetBoneState(state: BoneState): void {
  state.q.set([1, 0, 0, 0]);
  state.ang.fill(0);
  state.off.fill(0);
  state.vel.fill(0);
}

// ———— 数学（float32） ————

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
  f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));

function norm3(v: ArrayLike<number>): V3 {
  const length = f(Math.sqrt(dot3(v, v)));
  return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
}

/** 3×3（列主序）乘 3 维向量。 */
function mulVec(m: ArrayLike<number>, v: ArrayLike<number>): V3 {
  const row = (r: number) => f(f(f(m[r] * v[0]) + f(m[3 + r] * v[1])) + f(m[6 + r] * v[2]));
  return [row(0), row(1), row(2)];
}

/** 3×3 乘 3×3（都是列主序）。 */
function mulMat(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      out[3 * c + r] = f(f(f(a[r] * b[3 * c]) + f(a[3 + r] * b[3 * c + 1])) + f(a[6 + r] * b[3 * c + 2]));
  return out;
}

/** `R = Rz(a.z)·Ry(a.y)·Rx(a.x)`（列照 rea-p4a A1，与对象 `angles` 同一公式）。 */
function eulerR(a: ArrayLike<number>): number[] {
  const sx = f(Math.sin(a[0]));
  const cx = f(Math.cos(a[0]));
  const sy = f(Math.sin(a[1]));
  const cy = f(Math.cos(a[1]));
  const sz = f(Math.sin(a[2]));
  const cz = f(Math.cos(a[2]));
  return [
    f(cy * cz),
    f(cy * sz),
    -sy,
    f(f(f(sx * sy) * cz) - f(cx * sz)),
    f(f(f(sx * sy) * sz) + f(cx * cz)),
    f(sx * cy),
    f(f(f(cx * sy) * cz) + f(sx * sz)),
    f(f(f(cx * sy) * sz) - f(sx * cz)),
    f(cx * cy),
  ];
}

/** 半角 h 对应 `Rz·Ry·Rx` 的四元数 w x y z（`0x140202108` / `0x140202b25`）。 */
function eulerQuat(h: ArrayLike<number>): Q4 {
  const cx = f(Math.cos(h[0]));
  const sx = f(Math.sin(h[0]));
  const cy = f(Math.cos(h[1]));
  const sy = f(Math.sin(h[1]));
  const cz = f(Math.cos(h[2]));
  const sz = f(Math.sin(h[2]));
  return [
    f(f(f(sx * sy) * sz) + f(f(cx * cy) * cz)),
    f(f(f(sx * cy) * cz) - f(f(cx * sy) * sz)),
    f(f(f(sx * cy) * sz) + f(f(cx * sy) * cz)),
    f(f(f(cx * cy) * sz) - f(f(sx * sy) * cz)),
  ];
}

/** `a ⊗ b`（`FUN_140215380`，Hamilton，w x y z）。 */
function qmul(a: ArrayLike<number>, b: ArrayLike<number>): Q4 {
  const [w1, x1, y1, z1] = [a[0], a[1], a[2], a[3]];
  const [w2, x2, y2, z2] = [b[0], b[1], b[2], b[3]];
  return [
    f(f(f(f(w2 * w1) - f(x2 * x1)) - f(y2 * y1)) - f(z2 * z1)),
    f(f(f(f(x2 * w1) + f(x1 * w2)) + f(z2 * y1)) - f(z1 * y2)),
    f(f(f(f(y2 * w1) + f(y1 * w2)) + f(z1 * x2)) - f(z2 * x1)),
    f(f(f(f(z2 * w1) + f(z1 * w2)) + f(x1 * y2)) - f(y1 * x2)),
  ];
}

/**
 * 脚本的 `applyBonePhysicsImpulse(bone, dir, ang)`（`0x140210990`，rea-p12d-bones 5）：`vel += dir`（float32），`q = q ⊗ eulerQuat(ang·DEG·0.5)`。
 * 不看物理开关（调用方只对有状态的骨骼调）；`ang` 全 0 时四元数是精确单位，`q` 不变。
 */
export function applyBoneImpulse(state: BoneState, dir: ArrayLike<number>, ang: ArrayLike<number>): void {
  for (let k = 0; k < 3; k++) state.vel[k] = f(state.vel[k] + dir[k]);
  const half: V3 = [f(f(ang[0] * DEG) * 0.5), f(f(ang[1] * DEG) * 0.5), f(f(ang[2] * DEG) * 0.5)];
  state.q.set(qmul(state.q, eulerQuat(half)));
}

const QI: Q4 = [1, 0, 0, 0];

/** `FUN_140216070`：点积为负时翻转 b；> 阈值时线性插值（不归一）；否则 `acos` / `sin` 标准式。 */
function slerp(a: ArrayLike<number>, b0: ArrayLike<number>, t0: number): Q4 {
  const t = f(t0);
  let b: Q4 = [b0[0], b0[1], b0[2], b0[3]];
  let d = f(f(f(a[0] * b[0]) + f(a[2] * b[2])) + f(f(a[1] * b[1]) + f(a[3] * b[3])));
  if (d < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > SLERP_LIN) {
    const k = f(1 - t);
    return [0, 1, 2, 3].map((i) => f(f(k * a[i]) + f(t * b[i]))) as Q4;
  }
  const theta = f(Math.acos(d));
  const s = f(Math.sin(theta));
  const wa = f(Math.sin(f(f(1 - t) * theta)));
  const wb = f(Math.sin(f(theta * t)));
  return [0, 1, 2, 3].map((i) => f(f(f(a[i] * wa) + f(b[i] * wb)) / s)) as Q4;
}

/** `rotTo(a, b)`（`FUN_1402167c0`）：把 a 转到 b 的最短弧，点积不低于阈值时是单位四元数。 */
function rotTo(a: ArrayLike<number>, b: ArrayLike<number>): Q4 {
  const d = dot3(a, b);
  if (d >= SLERP_LIN) return [1, 0, 0, 0];
  if (d < -SLERP_LIN) {
    // 反向：绕与 a 垂直的轴转 180°（`0x140216860` 起，语料与实测都碰不到，按常规写法，同 python 模型）
    const cross = (u: V3, v: ArrayLike<number>): V3 => [
      f(f(u[1] * v[2]) - f(u[2] * v[1])),
      f(f(u[2] * v[0]) - f(u[0] * v[2])),
      f(f(u[0] * v[1]) - f(u[1] * v[0])),
    ];
    let axis = cross([1, 0, 0], a);
    if (dot3(axis, axis) < 1e-6) axis = cross([0, 1, 0], a);
    const unit = norm3(axis);
    return [0, unit[0], unit[1], unit[2]];
  }
  const s = f(Math.sqrt(f(f(1 + d) * 2)));
  const inverse = f(1 / s);
  const c: V3 = [
    f(f(a[1] * b[2]) - f(a[2] * b[1])),
    f(f(a[2] * b[0]) - f(a[0] * b[2])),
    f(f(a[0] * b[1]) - f(a[1] * b[0])),
  ];
  return [f(s * 0.5), f(c[0] * inverse), f(c[1] * inverse), f(c[2] * inverse)];
}

/** `FUN_140216280`：四元数 → 3×3（列主序）。 */
function quatMat(q: ArrayLike<number>): number[] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  const e = (a: number, b: number, c: number, d: number) => f(2 * f(f(a * b) - f(c * d)));
  const p = (a: number, b: number, c: number, d: number) => f(2 * f(f(a * b) + f(c * d)));
  const m00 = f(1 - f(2 * f(f(z * z) + f(y * y))));
  const m11 = f(1 - f(2 * f(f(z * z) + f(x * x))));
  const m22 = f(1 - f(2 * f(f(y * y) + f(x * x))));
  // 行主序写成 python 的样子，再转列主序
  const row = [
    [m00, e(x, y, w, z), p(w, y, x, z)],
    [p(w, z, x, y), m11, e(y, z, w, x)],
    [e(x, z, w, y), p(w, x, y, z), m22],
  ];
  return [row[0][0], row[1][0], row[2][0], row[0][1], row[1][1], row[2][1], row[0][2], row[1][2], row[2][2]];
}

/** `0x140201e04`–`0x140201fd5`：从 `Rz·Ry·Rx` 形式的 3×3（列主序）读回 x y z。 */
function matEuler(m: ArrayLike<number>): V3 {
  const at = (row: number, col: number) => m[3 * col + row];
  const z = f(Math.atan2(at(1, 0), at(0, 0)));
  const cy = f(Math.sqrt(f(f(at(2, 2) * at(2, 2)) + f(at(2, 1) * at(2, 1)))));
  const y = f(Math.atan2(-at(2, 0), cy));
  const sz = f(Math.sin(z));
  const cz = f(Math.cos(z));
  const x = f(Math.atan2(f(f(sz * at(0, 2)) - f(cz * at(1, 2))), f(f(cz * at(1, 1)) - f(sz * at(0, 1)))));
  return [x, y, z];
}

/** 3×3（取 `m` 左上，列主序 4×4 的前三列）的逆：双精度伴随矩阵 / 行列式再舍入（WPE 是 SIMD 叉积，舍入级不逐位）。 */
function inverse3(m: ArrayLike<number>): number[] {
  const a = m[0];
  const b = m[4];
  const c = m[8];
  const d = m[1];
  const e = m[5];
  const g = m[9];
  const h = m[2];
  const i = m[6];
  const k = m[10];
  // 行主序元素：[a b c; d e g; h i k]
  const c00 = e * k - g * i;
  const c01 = g * h - d * k;
  const c02 = d * i - e * h;
  const det = a * c00 + b * c01 + c * c02;
  const r = 1 / det;
  const row = [
    [c00 * r, (c * i - b * k) * r, (b * g - c * e) * r],
    [c01 * r, (a * k - c * h) * r, (c * d - a * g) * r],
    [c02 * r, (b * h - a * i) * r, (a * e - b * d) * r],
  ];
  return [row[0][0], row[1][0], row[2][0], row[0][1], row[1][1], row[2][1], row[0][2], row[1][2], row[2][2]].map(f);
}

// ———— 求解 ————

/**
 * 解一根骨骼（rea-AP 2.4）。`mw = W·Pose[i]`（本帧动画、物理之前，列主序 4×4），`mp` = 上一帧物理之后的世界骨骼矩阵（`P+0x348[i]`），
 * `s` = `W` 三列长度的平均，`dt` = 帧时间。改写 `state`，把增量 `D = T(offl)·R(ang)`（模型空间里右乘到骨骼姿势上）写进 `out`（16 个 f32），
 * 返回 `true`（开了物理的骨骼每次都有增量，哪怕全是单位）。
 */
export function solveBone(
  params: BonePhysics,
  state: BoneState,
  mw: ArrayLike<number>,
  mp: ArrayLike<number>,
  s: number,
  dt0: number,
  out: Float32Array,
): boolean {
  const dt = f(dt0);
  const o: V3 = [mw[12], mw[13], mw[14]];
  const inverse = inverse3(mw);
  const tp = params.tp;
  // 上一帧的尖端，表达在本帧动画骨骼里
  const mpLinear = [mp[0], mp[1], mp[2], mp[4], mp[5], mp[6], mp[8], mp[9], mp[10]];
  const tipPrev = mulVec(mpLinear, tp);
  const pp: V3 = [f(tipPrev[0] + mp[12]), f(tipPrev[1] + mp[13]), f(tipPrev[2] + mp[14])];
  const dl = mulVec(inverse, [f(pp[0] - o[0]), f(pp[1] - o[1]), f(pp[2] - o[2])]);
  const dln = norm3(dl);
  const vel: V3 = [state.vel[0], state.vel[1], state.vel[2]];
  let offl = mulVec(inverse, state.off);
  const tip = mulVec(eulerR(state.ang), tp);
  let tgt: V3 = [f(tip[0] + offl[0]), f(tip[1] + offl[1]), f(tip[2] + offl[2])];
  if (params.gravity) {
    // 重力只取垂直于骨骼的分量；转动部分强度乘 s、平移部分不乘
    const gl = mulVec(inverse, params.gd);
    const k = f(params.m * s);
    let g: V3 = [f(gl[0] * k), f(gl[1] * k), f(gl[2] * k)];
    const n = norm3(tip);
    const along = dot3(n, g);
    g = [f(g[0] - f(along * n[0])), f(g[1] - f(along * n[1])), f(g[2] - f(along * n[2]))];
    tgt = [f(tgt[0] - g[0]), f(tgt[1] - g[1]), f(tgt[2] - g[2])];
    if (params.translate) {
      const k2 = f(f(params.m * dt) * 1000);
      for (let i = 0; i < 3; i++) vel[i] = f(vel[i] + f(params.gd[i] * k2));
    }
  }
  const diff: V3 = [f(tgt[0] - dl[0]), f(tgt[1] - dl[1]), f(tgt[2] - dl[2])];
  const length = f(Math.sqrt(dot3(diff, diff)));
  const limit = f(dt * 900);
  const dist = limit < length ? limit : length;
  const qa = rotTo(norm3(tgt), dln);
  const spring = params.spring;

  const q = state.q;
  const ang = state.ang;
  if (params.rotate) {
    // 惯性 + 重力：距离（像素）当作度数折成插值比例
    const a = Math.min(f(f(dist * params.ri) * DEG), 1);
    let next = qmul(q, slerp(QI, qa, a));
    if (spring) {
      // 弹簧：拉回 ang = 0
      const half: V3 = [f(-ang[0] * 0.5), f(-ang[1] * 0.5), f(-ang[2] * 0.5)];
      const b = Math.min(f(f(params.rs * DEG) * dt), 1);
      next = qmul(next, slerp(QI, eulerQuat(half), b));
    }
    if (params.limitTurn !== null) {
      // 每轴角速度限幅 ±ltmax 度（语料 0 处）
      const max = params.limitTurn;
      const out4: Q4 = [1, 0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const c = f(next[1 + i] / next[0]);
        let deg = f(f(f(Math.atan(c)) * RAD) * 2);
        deg = max < deg ? max : deg;
        if (-max > deg) deg = -max;
        out4[1 + i] = f(Math.tan(f(f(deg * DEG) * 0.5)));
      }
      // 四项平方和按顺序累加（numpy `np.dot` 的求和顺序不可知，差只在 ulp 级）
      const s2 = f(f(f(f(out4[0] * out4[0]) + f(out4[1] * out4[1])) + f(out4[2] * out4[2])) + f(out4[3] * out4[3]));
      if (s2 > 0) {
        const root = f(Math.sqrt(s2));
        next = [f(out4[0] / root), f(out4[1] / root), f(out4[2] / root), f(out4[3] / root)];
      } else next = [1, 0, 0, 0];
    }
    // 积分：每 1/60 s 转一个 q，60 fps 以下每帧最多转一个 q
    const k = Math.min(f(dt / STEP), 1);
    const qs = slerp(QI, next, k);
    const eulered = matEuler(mulMat(quatMat(qs), eulerR(ang)));
    ang.set(eulered);
    const lock = params.lockRotate;
    if (spring) {
      // 折回 (−π, π]；锁住的轴清 0
      for (let i = 0; i < 3; i++) {
        if (lock[i]) ang[i] = 0;
        else if (ang[i] < 0) ang[i] = f(f(f(f(ang[i] - PI) % TWO_PI)) + PI);
        else ang[i] = f(f(f(ang[i] + PI) % TWO_PI) - PI);
      }
    }
    if (params.limitAngles) {
      // 角度钳制，并扣掉角速度里越界的那一份
      const lim = params.limitAngles;
      const old = [ang[0], ang[1], ang[2]];
      for (let i = 0; i < 3; i++) {
        const clamped = ang[i] > lim[i] ? ang[i] : lim[i]; // maximum(ang, lamin)
        ang[i] = clamped < lim[3 + i] ? clamped : lim[3 + i]; // minimum(·, lamax)
      }
      const excess: V3 = [f(f(old[0] - ang[0]) * 0.5), f(f(old[1] - ang[1]) * 0.5), f(f(old[2] - ang[2]) * 0.5)];
      const qc = eulerQuat(excess);
      next = qmul([qc[0], -qc[1], -qc[2], -qc[3]], next);
    }
    if (!spring) for (let i = 0; i < 3; i++) if (lock[i]) ang[i] = 0;
    // 阻尼
    const damped = slerp(next, QI, Math.min(f(dt * params.rf), 1));
    q.set(damped);
  }

  if (params.translate) {
    const off = state.off;
    const base: V3 = [f(f(off[0] + o[0]) - mp[12]), f(f(off[1] + o[1]) - mp[13]), f(f(off[2] + o[2]) - mp[14])];
    // 动画骨骼本帧的位移 × (1 − ti/100)
    const e: V3 = [f(params.ti * base[0]), f(params.ti * base[1]), f(params.ti * base[2])];
    let next: V3;
    if (!spring) {
      // re：只有惯性滞后，没有弹簧（读码 2.4，语料 0 处）
      next = [0, 1, 2].map((i) => f(f(off[i] - e[i]) + f(dt * vel[i]))) as V3;
    } else {
      const off1: V3 = [f(off[0] - e[0]), f(off[1] - e[1]), f(off[2] - e[2])];
      const k = f(dt * params.ts);
      for (let i = 0; i < 3; i++) vel[i] = f(vel[i] - f(k * off1[i]));
      next = [0, 1, 2].map((i) => f(f(dt * vel[i]) + off1[i])) as V3;
    }
    // 沿 Mw 某一列的分量去掉（平移轴锁，语料 0 处）
    for (let axis = 0; axis < 3; axis++) {
      if (!params.lockTranslate[axis]) continue;
      const column: V3 = [mw[4 * axis], mw[4 * axis + 1], mw[4 * axis + 2]];
      const k = f(dot3(next, column) / dot3(column, column));
      next = [f(next[0] - f(k * column[0])), f(next[1] - f(k * column[1])), f(next[2] - f(k * column[2]))];
    }
    const max = f(s * params.tm);
    if (max > 0 && f(max * max) < dot3(next, next)) {
      const k = f(max / f(Math.sqrt(dot3(next, next))));
      next = [f(next[0] * k), f(next[1] * k), f(next[2] * k)];
    }
    const damp = Math.min(f(dt * params.tf), 1);
    for (let i = 0; i < 3; i++) vel[i] = f(vel[i] - f(damp * vel[i]));
    state.off.set(next);
    state.vel.set(vel);
    offl = mulVec(inverse, state.off);
  }

  // D = T(offl) · R(ang)
  const r = eulerR(ang);
  out[0] = r[0];
  out[1] = r[1];
  out[2] = r[2];
  out[3] = 0;
  out[4] = r[3];
  out[5] = r[4];
  out[6] = r[5];
  out[7] = 0;
  out[8] = r[6];
  out[9] = r[7];
  out[10] = r[8];
  out[11] = 0;
  out[12] = offl[0];
  out[13] = offl[1];
  out[14] = offl[2];
  out[15] = 1;
  return true;
}
