/**
 * `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`（P4d 步骤 3）：按序号把新粒子放到控制点周围，或两个控制点
 * 之间。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md` 1.1–1.3（读码【确】），实测见 `p4-particles-REPORT.md`
 * 「P4d 语义的实测核对」的 mapsequence 表。
 *
 * 这是第一批有运行状态的 initializer：序号 `seq`（记录 `rec+8`）和步长 `step`（`rec+4`），WPE 存在流记录里、每个系统实例一份
 * （1.3，`FUN_1401c4220` 拷贝整条流）。模拟器（`system.ts`）经模块表的 `createState` / `resetState` / `newPeriod` /
 * `instanceState` 建、清、改它：
 * - 系统复位（`FUN_14022f6c0`，对象不可见且有存活粒子时）：两者都 `seq = 0`，`step` 不动（mirror 时它的符号也不复位）；
 * - 周期发射进入新周期（`FUN_14022f790`）：只有 `between` 在 `flags & 0x20` 时 `seq = 0`。`around` 读的是记录里没写过的
 *   `rec+0x58`，值不确定，按 0 实现（不清零），能力表对「`around` 配周期发射」照报（phase-4d-ropes.md「决定」3）；
 * - `instanceoverride` 重算（`FUN_1401d15a0`）：`between` 在 `flags & 0x10` 时登记了条目 4，`step` 直接重写成正的
 *   `1/max(count·ic − 1, 1e-4)`；`around` 不登记条目 3（`count` 不乘 `instanceoverride.count`，「决定」3 实测），不动。
 *
 * 全部逐步 float32、运算顺序照 rea 的括号；`sinf` / `cosf` 用 `Math.sin` / `Math.cos` 再舍入（可能差 1 ulp，同
 * `controlpoints.ts` 的 `eulerBasis`），`powf(x, 2)` 取 `f32(x·x)`（1.2【推】）。
 */
import { f32, mulBasis, TWO_PI } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";

type Vec3 = [number, number, number];

/** 序号状态（`rec+8` 的 `seq` 与 `rec+4` 的 `step`），每个系统实例一份。`step` 在 mirror 时会变号，复位不恢复它的符号（rea 1.3）。 */
export interface SequenceState {
  seq: number;
  step: number;
}

/** `count` 的下限（`0x38d1b717`，float 的 1e-4）：`c = x > 1e-4 ? x : 1e-4`（1.1、1.2）。 */
const COUNT_MIN = f32(1e-4);
/** `FLT_MIN`（`0x00800000`）：`between` 的线段长度下限（1.2 的 `maxss`）。 */
const FLT_MIN = 2 ** -126;

/** `step = 1/c`，`c = x > 1e-4 ? x : 1e-4`（`divss`）。比较是严格的，NaN 也取下限。 */
function reciprocalStep(x: number): number {
  return f32(1 / (x > COUNT_MIN ? x : COUNT_MIN));
}

/** `around` 的步长（1.1，解析段）：`1/max(count, 1e-4)`。`count` 已舍入成 float32（不乘 `instanceoverride.count`）。 */
export function aroundStep(count: number): number {
  return reciprocalStep(count);
}

/** `between` 的步长（1.2）：`1/max(count − 1, 1e-4)`，`count − 1` 先舍入。`count` 在 `flags & 0x10` 时已乘 `instanceoverride.count`。 */
export function betweenStep(count: number): number {
  return reciprocalStep(f32(count - 1));
}

/**
 * 用完一个序号之后推进（rea 1.1「序号更新」，`between` 同，1.2）：
 * ```
 * seq′ = step + seq
 * seq′ > 1（comiss，严格）：repeat：around 取 fmodf(seq′, 1)，between 归零（0x14023cdcc）；
 *                         mirror：seq = 1 − (seq′ − 1)，step 取反
 * seq′ < 0（只有 mirror 会出现）：seq = −seq′，step 取反
 * ```
 * 比较都是严格的，所以 `around` 的第一圈留着 1.0（`count 5`：`0 0.2 0.4 0.6 0.8 1 0.20000005 …`）。`fmodf` 转 double 算，
 * 结果精确，等于 JS 的 `%`。
 */
export function advanceSequence(state: SequenceState, mirror: boolean, wrapToZero: boolean): void {
  const next = f32(state.step + state.seq);
  if (next > 1) {
    if (mirror) {
      state.seq = f32(1 - f32(next - 1));
      state.step = -state.step;
    } else state.seq = wrapToZero ? 0 : next % 1;
  } else if (next < 0) {
    state.seq = -next;
    state.step = -state.step;
  } else state.seq = next;
}

/** `|v|` 的倒数归一化（`FUN_14005eb80`：`v·(1/sqrtss((x² + y²) + z²))`，精确 `sqrtss`、`divss`）。 */
function normalize(v: ArrayLike<number>): Vec3 {
  const length = f32(Math.sqrt(f32(f32(f32(v[0] * v[0]) + f32(v[1] * v[1])) + f32(v[2] * v[2]))));
  const inverse = f32(1 / length);
  return [f32(v[0] * inverse), f32(v[1] * inverse), f32(v[2] * inverse)];
}

/** 叉积 `u × v`：`(u.y·v.z − u.z·v.y, u.z·v.x − u.x·v.z, u.x·v.y − u.y·v.x)`，乘 0 照写（1.1 的 `t`）。 */
function cross(u: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  return [
    f32(f32(u[1] * v[2]) - f32(u[2] * v[1])),
    f32(f32(u[2] * v[0]) - f32(u[0] * v[2])),
    f32(f32(u[0] * v[1]) - f32(u[1] * v[0])),
  ];
}

const Z_AXIS: Vec3 = [0, 0, 1];

/**
 * `around` 的基向量（rea 1.1 的 `FUN_1401c19e0(axis, B1, B2)`，解析期算一次，全部精确 `sqrtss` / `divss`）：
 * ```
 * a = axis == (0,0,0)（逐分量精确比较）? (0,0,1) : a·(1/|a|)
 * a.x == 0 且 a.y == 0：B1 = (1,0,0)，B2 = (0,1,0)        // axis "0 0 -1" 也走这一支
 * 否则：t = a × (0,0,1)；B1 = t·(1/|t|)；B2 = c·(1/|c|)，c = a × t（用未归一化的 t）
 * ```
 * `axis "0 1 0"`：`B1 = (1,0,0)`、`B2 = (0,0,−1)`。
 */
export function aroundBasis(axis: readonly number[]): { axis: Vec3; b1: Vec3; b2: Vec3 } {
  const zero = axis[0] === 0 && axis[1] === 0 && axis[2] === 0;
  const a: Vec3 = zero ? [...Z_AXIS] : normalize(axis);
  if (a[0] === 0 && a[1] === 0) return { axis: a, b1: [1, 0, 0], b2: [0, 1, 0] };
  const t = cross(a, Z_AXIS);
  return { axis: a, b1: normalize(t), b2: normalize(cross(a, t)) };
}

const scale = (v: ArrayLike<number>, s: number): Vec3 => [f32(v[0] * s), f32(v[1] * s), f32(v[2] * s)];
const add = (u: ArrayLike<number>, v: ArrayLike<number>): Vec3 => [
  f32(u[0] + v[0]),
  f32(u[1] + v[1]),
  f32(u[2] + v[2]),
];
const sub = (u: ArrayLike<number>, v: ArrayLike<number>): Vec3 => [
  f32(u[0] - v[0]),
  f32(u[1] - v[1]),
  f32(u[2] - v[2]),
];
/** `(a.x·b.x + a.y·b.y) + a.z·b.z`（`FUN_14005f070`）。 */
const dot = (u: ArrayLike<number>, v: ArrayLike<number>): number =>
  f32(f32(f32(u[0] * v[0]) + f32(u[1] * v[1])) + f32(u[2] * v[2]));

/**
 * `mapsequencearoundcontrolpoint`（init 13，执行 `0x14023c4cf`，rea 1.1【确】），每个新粒子：
 * ```
 * P = pos；M = mat3(cp.current)；C = cp.current.t
 * A = M·axis；B1′ = M·B1；B2′ = M·B2                     // FUN_140184440，乘完不再归一化
 * d = P − C；proj = (d.x·A.x + d.y·A.y) + d.z·A.z；r = d − proj·A；L = sqrtss((r.x² + r.y²) + r.z²)
 * θ = ((Δb·seq) + b0)·2π；s = sinf(θ)；c = cosf(θ)
 * dirA = (c·B2′) + (s·B1′)；dirB = ((−s)·B2′) + (c·B1′)   // θ = 0 在 B2′（缺省轴时是 +y），往 B1′ 转
 * u1 = uA；u2 = uA；u3 = uA                              // 无条件抽 3 次，speed 全 0 也照抽
 * pos = (dirA·L) + ((proj·A) + C)                        // 覆盖
 * vel += (((((dirA·smin.y) + u3·(dirA·Δs.y)) + smin.x·dirB) + u2·(Δs.x·dirB)) + smin.z·A) + u1·(Δs.z·A)
 * ```
 * 之后推进序号（repeat 取模）。`speed` 的 x 切向、y 径向、z 轴向；`Δs = speedmax − speedmin` 在乘过 `instanceoverride.speed` 之后
 * 求差（条目 0xa）。不用 `R`、`h`、`k`，不置列标志。
 */
export function mapSequenceAround(fields: ParticleFields, context: ParticleRunContext, state: SequenceState): void {
  const { columns, random, slot } = context;
  const cp = context.controlPoints.current(fields.controlpoint as number);
  const basis = aroundBasis(fields.axis as number[]);
  const A = mulBasis(cp.basis, basis.axis);
  const B1 = mulBasis(cp.basis, basis.b1);
  const B2 = mulBasis(cp.basis, basis.b2);
  const C = cp.translation;
  const [px, py, pz] = columns.position;
  const d = sub([px[slot], py[slot], pz[slot]], C);
  const proj = dot(d, A);
  const r = sub(d, scale(A, proj));
  const L = f32(Math.sqrt(dot(r, r)));
  const bounds = fields.bounds as number[];
  const b0 = bounds[0];
  const db = f32(bounds[1] - b0);
  const theta = f32(f32(f32(db * state.seq) + b0) * TWO_PI);
  const s = f32(Math.sin(theta));
  const c = f32(Math.cos(theta));
  const dirA = add(scale(B2, c), scale(B1, s));
  const dirB = add(scale(B2, -s), scale(B1, c));
  const u1 = random.a();
  const u2 = random.a();
  const u3 = random.a();
  const position = add(scale(dirA, L), add(scale(A, proj), C));
  for (let i = 0; i < 3; i++) columns.position[i][slot] = position[i];
  const smin = fields.speedmin as number[];
  const smax = fields.speedmax as number[];
  const ds = sub(smax, smin);
  let v = add(scale(dirA, smin[1]), scale(scale(dirA, ds[1]), u3));
  v = add(v, scale(dirB, smin[0]));
  v = add(v, scale(scale(dirB, ds[0]), u2));
  v = add(v, scale(A, smin[2]));
  v = add(v, scale(scale(A, ds[2]), u1));
  for (let i = 0; i < 3; i++) columns.velocity[i][slot] = f32(columns.velocity[i][slot] + v[i]);
  advanceSequence(state, fields.limitbehavior === "mirror", false);
}

/**
 * `mapsequencebetweencontrolpoints`（init 14，执行 `0x14023ca93`，rea 1.2【确】），每个新粒子：
 * ```
 * P = pos；S = cp[start].current.t；E = cp[end].current.t；D = E − S
 * L = sqrtss((D.x² + D.y²) + D.z²)；Lc = L > FLT_MIN ? L : FLT_MIN（NaN 也取 FLT_MIN）；û = D / Lc（divss ×3）
 * 世界系统（sys.flags & 1）：P = P − S                      // 本地系统按系统原点量垂直分量（0x14023cb55）
 * proj = (P.x·û.x + P.y·û.y) + P.z·û.z；r = P − proj·û
 * t = (seq·Δb) + b0；w = 1 − powf(|seq + seq − 1|, 2)       // w 用的是 seq，不是 t
 * flags & 1：r = r·w
 * pos = r + (((t·û)·Lc) + S)
 * flags & 8：pos += arcdirection·((w·Lc)·arcamount)        // arcdirection 不归一化、不乘控制点矩阵
 * flags & 2：vel *= w
 * flags & 4：size0 *= (1 − srm) + srm·w
 * ```
 * 不抽随机数，不用 `R`、`h`、`k`。之后推进序号（repeat 超过 1 时归零）。
 */
export function mapSequenceBetween(fields: ParticleFields, context: ParticleRunContext, state: SequenceState): void {
  const { columns, slot } = context;
  const flags = fields.flags as number;
  const S = context.controlPoints.current(fields.controlpointstart as number).translation;
  const E = context.controlPoints.current(fields.controlpointend as number).translation;
  const D = sub(E, S);
  const L = f32(Math.sqrt(dot(D, D)));
  const Lc = L > FLT_MIN ? L : FLT_MIN;
  const u: Vec3 = [f32(D[0] / Lc), f32(D[1] / Lc), f32(D[2] / Lc)];
  const [px, py, pz] = columns.position;
  let P: Vec3 = [px[slot], py[slot], pz[slot]];
  if (context.world) P = sub(P, S);
  const proj = dot(P, u);
  let r = sub(P, scale(u, proj));
  const seq = state.seq;
  const bounds = fields.bounds as number[];
  const b0 = bounds[0];
  const db = f32(bounds[1] - b0);
  const t = f32(f32(seq * db) + b0);
  const x = Math.abs(f32(f32(seq + seq) - 1));
  const w = f32(1 - f32(x * x));
  if (flags & 1) r = scale(r, w);
  let position = add(r, add(scale(scale(u, t), Lc), S));
  if (flags & 8)
    position = add(position, scale(fields.arcdirection as number[], f32(f32(w * Lc) * (fields.arcamount as number))));
  for (let i = 0; i < 3; i++) columns.position[i][slot] = position[i];
  if (flags & 2) for (let i = 0; i < 3; i++) columns.velocity[i][slot] = f32(columns.velocity[i][slot] * w);
  if (flags & 4) {
    const srm = fields.sizereductionamount as number;
    columns.size0[slot] = f32(columns.size0[slot] * f32(f32(1 - srm) + f32(srm * w)));
  }
  advanceSequence(state, fields.limitbehavior === "mirror", true);
}

/** 两者的 `createState`：`{ seq: 0, step }`（解析期写 `rec+4`，`rec+8` 初值 0）。 */
export function aroundState(fields: ParticleFields): SequenceState {
  return { seq: 0, step: aroundStep(fields.count as number) };
}
export function betweenState(fields: ParticleFields): SequenceState {
  return { seq: 0, step: betweenStep(fields.count as number) };
}

/** 系统复位（`FUN_14022f6c0`，`0x14022f735`–`0x14022f750`）：对类型 13、14 无条件 `seq = 0`，`step` 不动（符号也不复位）。 */
export function resetSequence(state: SequenceState): void {
  state.seq = 0;
}

/** 周期发射的新周期（`FUN_14022f790`，唯一调用点 `0x140237ac1`）：`between` 只在 `flags & 0x20` 时 `seq = 0`（1.3）。 */
export function betweenNewPeriod(state: SequenceState, fields: ParticleFields): void {
  if ((fields.flags as number) & 0x20) state.seq = 0;
}

/**
 * `instanceoverride` 重算（`FUN_1401d15a0` 条目 4，`ignore/p4/rea/p4a/o_1401d15a0.c` 的 `case 4`）：`between` 在 `flags & 0x10`、
 * 且系统 `flags` 没禁用 `count`（bit5）时登记了这一条，重算时把 `step` 直接写成 `1/max(count·ic − 1, 1e-4)`，是正数，所以 mirror
 * 走到一半的方向会回到正向（rea 1.2「登记条目 4」）；`seq` 不动。没登记时 `step` 不变。`fields.count` 已按 `instanceIf` 乘过。
 */
export function betweenInstanceState(state: SequenceState, fields: ParticleFields, systemFlags: number): void {
  // 0x20 即 `modules.ts` 的 `INSTANCE_DISABLE_FLAGS.count`（不从那里取值：`modules.ts` 引用本文件的执行函数，免得循环取值）
  if ((fields.flags as number) & 0x10 && !(systemFlags & 0x20)) state.step = betweenStep(fields.count as number);
}
