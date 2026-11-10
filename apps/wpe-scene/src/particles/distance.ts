/**
 * 距离类 operator 与 `vortex_v2`（P4d 步骤 5）：`maintaindistancetocontrolpoint`（op 11）、`maintaindistancebetweencontrolpoints`
 * （op 12）、`reducemovementnearcontrolpoint`（op 13）、`vortex_v2`（op 16）。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md`
 * 第 3、4、5 节（读码【确】），各段汇编（`ignore/p4/rea/p4d-mod/op11*.asm`、`op12*.asm`、`op13*.asm`、`op16*.asm`、`parse_op11_13.asm`、
 * `parse_op16.asm`）逐条核对过运算顺序；实测见 `p4-particles-REPORT.md`「P4d 语义的实测核对」的「距离类与 `vortex_v2`」表。
 *
 * - 每遍处理 `[0, count)` 的全部槽（含死槽），同其它 operator；逐步 float32，加法顺序照汇编（见各函数）。
 * - WPE 用 `rsqrtps` / `rcpps` 的位置调 `rsqrt` / `rcp`（「近似倒数不复刻」，回放挂近似运算包络）；解析期的 `rcpps` 这里执行时现算，
 *   结果相同，好让包络覆盖到。
 * - 两个 maintaindistance 读控制点的 `previous`：它只在帧尾更新（`ControlPointSet.endFrame`），两遍模式每遍都看到同一个
 *   `current − previous`，一帧平移两次（rea 3.1、3.2，实测 md-move 在 fps 10 下两倍速跟随）。
 * - `clamp01`（`FUN_1401d8df0`：`minss(1, maxss(0, x))`）让 NaN 原样通过；`saturatePs`（`minps(x, 1)` 再 `maxps(0, …)`）让 NaN 得 1。
 *   两者按汇编各用在各自的位置。
 * - blend 变体（记录类型 0x21 / 0x22 / 0x23 / 0x25）：`b` 由 `FUN_14022a530` 按 `age·rcpps(life)` 与四个键算（`blendFactor`），
 *   乘的位置见各函数。
 */
import { clamp01, f32, rcp, rsqrt } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
import { blendFactor, readBlend, saturatePs } from "./operators";

/**
 * `inverse(mat3(M))`（`FUN_140228b00`，glm 的写法，汇编逐条核对）。`m` 是列主序 3×3（`m[c·3 + r]`，同 `ControlPoint.basis`），返回同样
 * 布局的逆。逐步 float32：
 * ```
 * A  = m8·m4 − m7·m5;  B = m8·m1 − m7·m2;  Cc = m1·m5 − m4·m2
 * det = (A·m0 − B·m3) + Cc·m6;  i = 1/det                      （divss）
 * out0 = A·i              out3 = −(m8·m3 − m6·m5)·i    out6 = (m7·m3 − m6·m4)·i
 * out1 = −(m8·m1 − m7·m2)·i  out4 = (m8·m0 − m6·m2)·i  out7 = −(m7·m0 − m6·m1)·i
 * out2 = (m5·m1 − m4·m2)·i   out5 = −(m5·m0 − m3·m2)·i  out8 = (m4·m0 − m3·m1)·i
 * ```
 * 取反是 `xorps` 符号位（在乘 `i` 之前）。奇异时 `i = ±inf`，结果是 inf / NaN，同 WPE。
 */
export function inverseBasis(m: ArrayLike<number>): Float32Array {
  const A = f32(f32(m[8] * m[4]) - f32(m[7] * m[5]));
  const B = f32(f32(m[8] * m[1]) - f32(m[7] * m[2]));
  const Cc = f32(f32(m[1] * m[5]) - f32(m[4] * m[2]));
  const det = f32(f32(f32(A * m[0]) - f32(B * m[3])) + f32(Cc * m[6]));
  const i = f32(1 / det);
  const term = (a: number, b: number, c: number, d: number, negate: boolean) => {
    const v = f32(f32(a * b) - f32(c * d));
    return f32((negate ? -v : v) * i);
  };
  return new Float32Array([
    f32(A * i),
    term(m[8], m[1], m[7], m[2], true),
    term(m[5], m[1], m[4], m[2], false),
    term(m[8], m[3], m[6], m[5], true),
    term(m[8], m[0], m[6], m[2], false),
    term(m[5], m[0], m[3], m[2], true),
    term(m[7], m[3], m[6], m[4], false),
    term(m[7], m[0], m[6], m[1], true),
    term(m[4], m[0], m[3], m[1], false),
  ]);
}

/** blend 的 `b`（`FUN_14022a530`）：`age·rcpps(life)` 代入四个键。没有 blend 时为 null。 */
function blendOf(fields: ParticleFields) {
  const blend = readBlend(fields);
  return blend.active ? blend : null;
}

/**
 * `maintaindistancetocontrolpoint`（op 11，`0x14024197a`；blend 0x21，`0x140241ccf`，rea 3.1【确】）：
 * ```
 * s  = (variablestrength == 0) ? 1 : clamp01(variablestrength·h)   （ucomiss 精确相等；FUN_1401d8df0，NaN 原样）
 * C  = cp.current.t;  Δ = cp.current.t − cp.previous.t            （0x140241a3f）
 * T  = inverse(mat3(cp.current))                                   （inverseBasis）
 * 每槽：
 *   p′ = Δ + p;  d = p′ − C
 *   u_k = (d.y·T[1][k] + d.x·T[0][k]) + d.z·T[2][k]                 （T[i] 第 i 列）
 *   q  = rsqrtps((u.x² + u.y²) + u.z²)
 *   f  = (q·distance − 1)·s           [blend：f·b]
 *   p  = f·d + p′
 * ```
 * - 平移 `Δ` 不受 blend 影响；粒子正好落在控制点上时 `q = inf`、`0·inf = NaN`，同 WPE。
 * - `T` 只在控制点有旋转、缩放时起作用（世界系统含 `W` 的缩放时，球变成椭球，实测 md-scale）。
 */
export function maintainDistanceToControlPoint(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, count, h, controlPoints } = context;
  const index = fields.controlpoint as number;
  const current = controlPoints.current(index);
  const previous = controlPoints.previous(index);
  const vs = fields.variablestrength as number;
  const s = vs === 0 ? 1 : clamp01(f32(vs * h));
  const C = current.translation;
  const cx = C[0];
  const cy = C[1];
  const cz = C[2];
  const dX = f32(cx - previous.translation[0]);
  const dY = f32(cy - previous.translation[1]);
  const dZ = f32(cz - previous.translation[2]);
  const T = inverseBasis(current.basis);
  const distance = fields.distance as number;
  const blend = blendOf(fields);
  const { age, life } = columns;
  const [px, py, pz] = columns.position;
  for (let i = 0; i < count; i++) {
    const x = f32(dX + px[i]);
    const y = f32(dY + py[i]);
    const z = f32(dZ + pz[i]);
    const dx = f32(x - cx);
    const dy = f32(y - cy);
    const dz = f32(z - cz);
    const ux = f32(f32(f32(dy * T[3]) + f32(dx * T[0])) + f32(dz * T[6]));
    const uy = f32(f32(f32(dy * T[4]) + f32(dx * T[1])) + f32(dz * T[7]));
    const uz = f32(f32(f32(dy * T[5]) + f32(dx * T[2])) + f32(dz * T[8]));
    const q = rsqrt(f32(f32(f32(ux * ux) + f32(uy * uy)) + f32(uz * uz)));
    let f = f32(f32(f32(q * distance) - 1) * s);
    if (blend) f = f32(f * blendFactor(blend, f32(age[i] * rcp(life[i]))));
    px[i] = f32(f32(f * dx) + x);
    py[i] = f32(f32(f * dy) + y);
    pz[i] = f32(f32(f * dz) + z);
  }
}

/** `maintaindistancebetweencontrolpoints` 的长度² 下限（`0x28800000` = 2⁻⁴⁶，`0x1402421ff`）：不大于它（或 NaN）时整条跳过。 */
const BETWEEN_MIN = 2 ** -46;

/**
 * `maintaindistancebetweencontrolpoints`（op 12，`0x140242058`；blend 0x22，`0x140242352`，rea 3.2【确】）：把粒子从上一帧的线段
 * `Ap → Bp` 映射到本帧的 `A → B`，比例夹到 [0, 1]，垂直偏移原样带过、不随线段旋转。
 * ```
 * A, B = cp[start], cp[end] 的 current.t;  Ap, Bp = 两者的 previous.t
 * D = B − A;  Dp = Bp − Ap;  ΔA = A − Ap
 * n = (D.y² + D.x²) + D.z²;  np = (Dp.y² + Dp.x²) + Dp.z²
 * n ≤ 2⁻⁴⁶ 或 np ≤ 2⁻⁴⁶（comiss，NaN 同样）：整条跳过
 * q = rsqrtps(n);  L = q·n;  D̂ = D·q;  qp = rsqrtps(np);  D̂p = Dp·qp
 * 每槽：
 *   Q = P − Ap;  t = (Q.y·D̂p.y + Q.x·D̂p.x) + Q.z·D̂p.z
 *   s = maxps(0, minps(t·qp, 1))·L                        （NaN 得 1）
 *   P_c = ((s·D̂_c − t·D̂p_c) + ΔA_c) + P_c     [blend：((s·D̂_c − t·D̂p_c) + ΔA_c)·b + P_c]
 * ```
 * 两个控制点重合（缺省 0、1 号点都没有 `offset`）时什么也不做（实测 mb2-same）。
 */
export function maintainDistanceBetweenControlPoints(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, count, controlPoints } = context;
  const start = fields.controlpointstart as number;
  const end = fields.controlpointend as number;
  const A = controlPoints.current(start).translation;
  const B = controlPoints.current(end).translation;
  const Ap = controlPoints.previous(start).translation;
  const Bp = controlPoints.previous(end).translation;
  const D = [f32(B[0] - A[0]), f32(B[1] - A[1]), f32(B[2] - A[2])];
  const Dp = [f32(Bp[0] - Ap[0]), f32(Bp[1] - Ap[1]), f32(Bp[2] - Ap[2])];
  const dA = [f32(A[0] - Ap[0]), f32(A[1] - Ap[1]), f32(A[2] - Ap[2])];
  const n = f32(f32(f32(D[1] * D[1]) + f32(D[0] * D[0])) + f32(D[2] * D[2]));
  const np = f32(f32(f32(Dp[1] * Dp[1]) + f32(Dp[0] * Dp[0])) + f32(Dp[2] * Dp[2]));
  if (!(n > BETWEEN_MIN) || !(np > BETWEEN_MIN)) return;
  const q = rsqrt(n);
  const L = f32(q * n);
  const unit = D.map((value) => f32(q * value));
  const qp = rsqrt(np);
  const unitPrev = Dp.map((value) => f32(qp * value));
  const blend = blendOf(fields);
  const { age, life } = columns;
  const position = columns.position;
  const [px, py, pz] = position;
  const apx = Ap[0];
  const apy = Ap[1];
  const apz = Ap[2];
  for (let i = 0; i < count; i++) {
    const qx = f32(px[i] - apx);
    const qy = f32(py[i] - apy);
    const qz = f32(pz[i] - apz);
    const t = f32(f32(f32(qy * unitPrev[1]) + f32(qx * unitPrev[0])) + f32(qz * unitPrev[2]));
    const s = f32(saturatePs(f32(t * qp)) * L);
    const b = blend ? blendFactor(blend, f32(age[i] * rcp(life[i]))) : 1;
    for (let c = 0; c < 3; c++) {
      let delta = f32(f32(f32(s * unit[c]) - f32(t * unitPrev[c])) + dA[c]);
      if (blend) delta = f32(delta * b);
      position[c][i] = f32(delta + position[c][i]);
    }
  }
}

/**
 * `reducemovementnearcontrolpoint`（op 13，`0x14024268f`；blend 0x23，`0x1402427b8`，rea 3.3【确】）：只改速度。
 * ```
 * 解析期：rcpD = (distanceouter == distanceinner) ? 1 : rcpps(outer − inner)
 *         Δred = (reductionouter == reductioninner) ? 1 : reductionouter − reductioninner   （相等时存 1.0 是 WPE 的 bug，0x1401cd3d1）
 * C = cp.current.t
 * 每槽：
 *   n = ((y − Cy)² + (x − Cx)²) + (z − Cz)²;  L = rsqrtps(n)·n
 *   t = maxps(0, minps((L − inner)·rcpD, 1))                （n = 0 时 L 为 NaN，t = 1）
 *   r = t·Δred + reductioninner
 *   f = maxps(0, minps(r·h, 1))       [blend：f·b]
 *   vel *= 1 − f
 * ```
 * 相等比较是 `ucomiss`（NaN 不相等）。`Δred` 的 bug 照做：`rinner == router` 时 `r = rinner + t`，不是常数。
 */
export function reduceMovementNearControlPoint(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, count, h, controlPoints } = context;
  const C = controlPoints.current(fields.controlpoint as number).translation;
  const cx = C[0];
  const cy = C[1];
  const cz = C[2];
  const inner = fields.distanceinner as number;
  const outer = fields.distanceouter as number;
  const rcpD = outer === inner ? 1 : rcp(f32(outer - inner));
  const rInner = fields.reductioninner as number;
  const rOuter = fields.reductionouter as number;
  const dRed = rOuter === rInner ? 1 : f32(rOuter - rInner);
  const blend = blendOf(fields);
  const { age, life } = columns;
  const [px, py, pz] = columns.position;
  const [vx, vy, vz] = columns.velocity;
  for (let i = 0; i < count; i++) {
    const dx = f32(px[i] - cx);
    const dy = f32(py[i] - cy);
    const dz = f32(pz[i] - cz);
    const n = f32(f32(f32(dy * dy) + f32(dx * dx)) + f32(dz * dz));
    const L = f32(rsqrt(n) * n);
    const t = saturatePs(f32(f32(L - inner) * rcpD));
    const r = f32(f32(t * dRed) + rInner);
    let f = saturatePs(f32(r * h));
    if (blend) f = f32(f * blendFactor(blend, f32(age[i] * rcp(life[i]))));
    const g = f32(1 - f);
    vx[i] = f32(g * vx[i]);
    vy[i] = f32(g * vy[i]);
    vz[i] = f32(g * vz[i]);
  }
}

/** `vortex_v2` 的 `axis` 判零阈值（`0x140492608`，float 的 0.001，`0x1401ce1cb`）。 */
const AXIS_EPSILON = f32(0.001);

/** `orps` 符号位：`e` 的符号位为 1 时把 `m` 的符号位置 1（`m` 是 `[0, 1]` 或 NaN）。 */
function orSign(m: number, e: number): number {
  return e < 0 || Object.is(e, -0) ? -Math.abs(m) : m;
}

/**
 * `vortex_v2`（op 16，`0x1402433ea`；blend 0x25，`0x140243a17`，rea 第 4 节【确】，两段汇编逐条核对）：
 * ```
 * 解析期：a₀ = |axis|² < 0.001 ? (0, 0, 1) : axis·(1/sqrtss(|axis|²))      （|axis|² = (x² + y²) + z²；FUN_14005eb80 先求倒数再乘）
 *         slot0 = 环形 ? ringwidth : distanceinner
 *         rcp1  = 环形 ? (ringpulldistance == 0 ? 1 : rcpps(ringpulldistance)) : (outer == inner ? 1 : rcpps(outer − inner))
 *         centerforce 只在 flags & 2 时读，否则 0；flags 只存低 8 位
 * SI = speedinner·k;  DS = (speedouter − speedinner)·k        （k = 本条 operator 的 drag 系数；两个速度已乘 instanceoverride.speed）
 * CF = (1/h)·centerforce                                         （divps，精确）
 * C  = cp.current.t;  a = (c0·a₀.x + c1·a₀.y) + (c2·a₀.z + t·0)   （FUN_14024f080，cp.current 的 4×4，不重新归一化）
 * 每槽：
 *   d = p − C;  proj = ((d.y·a.y + d.x·a.x) + d.z·a.z) & mask    （flags bit0：柱形；否则 proj = 0，球形）
 *   r = d − proj·a;  n = (r.y² + r.x²) + r.z²;  q = rsqrtps(n);  r̂ = r·q;  L = q·n
 *   P′ = ((vel·h + p) − C) − proj·a                               （按当前速度走 h 后的径向偏移）
 *   c₀ = (rsqrtps((P′.y² + P′.x²) + P′.z²)·L − 1)·CF
 *   非环形：t = saturate((L − slot0)·rcp1);  spd = t·DS + SI;  c = c₀              [blend：spd·b，c₀·b]
 *   环形（flags bit2）：e = ringradius − L;  t = saturate((|e| − slot0)·rcp1);  spd = t·DS + SI
 *                     w = 1 − t;  m = (w ≠ 1) ? w : 0;  pull = (m 或上 e 的符号位)·(h·ringpullforce)
 *                     c = c₀ + pull                                              [blend：spd·b，(c₀ + pull)·b]
 *   T = r̂ × a = (r̂y·az − r̂z·ay, r̂z·ax − r̂x·az, r̂x·ay − r̂y·ax)
 *   vel_c = (T_c·spd + P′_c·c) + vel_c
 * ```
 * - **切向乘 `k`，不是 `h`**（实测：v2-sphere、v2-cyl 逐粒子差 ≤ 1.4e-3，换成 `h` 差 2.1–2.7）；方向是 `r̂ × a`。
 * - 轴乘控制点 current 的 3×3（含缩放、不重新归一化，实测 v2-axis）；`audioprocessingmode ≠ 0` 时乘两个速度的音频系数不做（P4e，
 *   能力表照报 `…:audioprocessingmode`）。
 * - `n = 0`（粒子在轴上）时 `r̂`、`L` 是 NaN；`|P′| = 0` 时 `c₀` 是 inf / NaN（`centerforce` 关时 `inf·0 = NaN`），都照 WPE 写进速度，
 *   不跳过（和 `vortex` 不同）。
 */
export function vortexV2(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, count, h, k, controlPoints } = context;
  const flags = fields.flags as number;
  const ring = (flags & 4) !== 0;
  const cylinder = (flags & 1) !== 0;
  const raw = fields.axis as number[];
  const axisSquared = f32(f32(f32(raw[0] * raw[0]) + f32(raw[1] * raw[1])) + f32(raw[2] * raw[2]));
  let a0: number[];
  if (axisSquared < AXIS_EPSILON) a0 = [0, 0, 1];
  else {
    const inv = f32(1 / f32(Math.sqrt(axisSquared)));
    a0 = raw.map((value) => f32(value * inv));
  }
  const current = controlPoints.current(fields.controlpoint as number);
  const m = current.basis;
  const t3 = current.translation;
  const a = [0, 1, 2].map((r) =>
    f32(f32(f32(m[r] * a0[0]) + f32(m[3 + r] * a0[1])) + f32(f32(m[6 + r] * a0[2]) + f32(t3[r] * 0))),
  );
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const cx = t3[0];
  const cy = t3[1];
  const cz = t3[2];
  const inner = fields.distanceinner as number;
  const outer = fields.distanceouter as number;
  const pullDistance = fields.ringpulldistance as number;
  const slot0 = ring ? (fields.ringwidth as number) : inner;
  const rcp1 = ring ? (pullDistance === 0 ? 1 : rcp(pullDistance)) : outer === inner ? 1 : rcp(f32(outer - inner));
  const speedInner = fields.speedinner as number;
  const SI = f32(speedInner * k);
  const DS = f32(f32((fields.speedouter as number) - speedInner) * k);
  const centerforce = flags & 2 ? (fields.centerforce as number) : 0;
  const CF = f32(f32(1 / h) * centerforce);
  const radius = fields.ringradius as number;
  const hPull = f32(h * (fields.ringpullforce as number));
  const blend = blendOf(fields);
  const { age, life } = columns;
  const [px, py, pz] = columns.position;
  const [vx, vy, vz] = columns.velocity;
  for (let i = 0; i < count; i++) {
    const x = px[i];
    const y = py[i];
    const z = pz[i];
    const dx = f32(x - cx);
    const dy = f32(y - cy);
    const dz = f32(z - cz);
    const proj = cylinder ? f32(f32(f32(dy * ay) + f32(dx * ax)) + f32(dz * az)) : 0;
    const pax = f32(proj * ax);
    const pay = f32(proj * ay);
    const paz = f32(proj * az);
    const rx = f32(dx - pax);
    const ry = f32(dy - pay);
    const rz = f32(dz - paz);
    const n = f32(f32(f32(ry * ry) + f32(rx * rx)) + f32(rz * rz));
    const q = rsqrt(n);
    const ux = f32(q * rx);
    const uy = f32(q * ry);
    const uz = f32(q * rz);
    const L = f32(q * n);
    const v0 = vx[i];
    const v1 = vy[i];
    const v2 = vz[i];
    const ppx = f32(f32(f32(f32(v0 * h) + x) - cx) - pax);
    const ppy = f32(f32(f32(f32(v1 * h) + y) - cy) - pay);
    const ppz = f32(f32(f32(f32(v2 * h) + z) - cz) - paz);
    const pn = f32(f32(f32(ppy * ppy) + f32(ppx * ppx)) + f32(ppz * ppz));
    const c0 = f32(f32(f32(rsqrt(pn) * L) - 1) * CF);
    let spd: number;
    let c: number;
    if (ring) {
      const e = f32(radius - L);
      const t = saturatePs(f32(f32(Math.abs(e) - slot0) * rcp1));
      spd = f32(f32(t * DS) + SI);
      const w = f32(1 - t);
      const mw = w !== 1 ? w : 0;
      c = f32(c0 + f32(orSign(mw, e) * hPull));
    } else {
      const t = saturatePs(f32(f32(L - slot0) * rcp1));
      spd = f32(f32(t * DS) + SI);
      c = c0;
    }
    if (blend) {
      const b = blendFactor(blend, f32(age[i] * rcp(life[i])));
      spd = f32(spd * b);
      c = f32(c * b);
    }
    const tx = f32(f32(uy * az) - f32(uz * ay));
    const ty = f32(f32(uz * ax) - f32(ux * az));
    const tz = f32(f32(ux * ay) - f32(uy * ax));
    vx[i] = f32(f32(f32(tx * spd) + f32(ppx * c)) + v0);
    vy[i] = f32(f32(f32(ty * spd) + f32(ppy * c)) + v1);
    vz[i] = f32(f32(f32(tz * spd) + f32(ppz * c)) + v2);
  }
}
