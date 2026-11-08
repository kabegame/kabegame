/**
 * 发射（P4a 步骤 3、P4b 步骤 3）。依据 `rea-p4a.md` B「发射数量」「`sphererandom`」、`rea-p4b-modules.md` A0–A4（读码【确】），
 * `instantaneous` 欠账、`delay` / `duration`、bit1、周期发射、`boxrandom` 的形状都实测核对过（`p4-particles-REPORT.md`
 * 「P4b 语义的实测核对」）。
 *
 * - `emissionCount`：每个 emitter、每帧算本帧要发几个（`FUN_1402378a0`），emitter 类型共有；
 * - `sphereRandom`、`boxRandom`：模块表 `sphererandom`、`boxrandom` 的执行函数，给一个新粒子写位置、速度。
 *
 * 控制点（`controlpoint ≠ 0`、世界空间）属 P4c，能力表已拦住，这里控制点矩阵按单位阵、平移按 0。
 */
import { f32, lerp, PI, rcp, TWO_PI } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
import type { ParticleRandom } from "./random";

/** emitter 的模块级状态（WPE 存在流记录里，每实例一份，Q5；偏移见 `rea-p4b-modules.md` A0）。 */
export interface EmitterState {
  /** 累积余数（记录 `+0x24`）：`instantaneous` 从这里扣，所以会变负。 */
  acc: number;
  /** 待发的 `instantaneous`（`+0x44`）。 */
  pending: number;
  /** 剩余延迟（`delay`，倒数）。 */
  delay: number;
  /** 剩余时长（`duration`）；0 不限，−1 已用完。 */
  duration: number;
  /** 已结束（WPE 的 bit31）。 */
  ended: boolean;
  /** 本周期已连续发射数（`+0x3c`）：只数连续发射，不数 `instantaneous`，`maxtoemitperperiod` 按它限额。 */
  burst: number;
  /** 周期计时 P（`+0x40`）：正数是本周期剩余时长，负数是剩余间歇，初值 0（下一个发射帧就开始新周期）。 */
  period: number;
}

export function emitterState(fields: ParticleFields): EmitterState {
  return {
    acc: 0,
    pending: Number(fields.instantaneous) || 0,
    delay: f32(Number(fields.delay) || 0),
    duration: f32(Number(fields.duration) || 0),
    ended: false,
    burst: 0,
    period: 0,
  };
}

/**
 * 复位 emitter 计时（`FUN_14022f6c0`，`ignore/p4/rea/wp.asm` `0x14022f6c0` 起，每条 emitter 记录；`rea-p4b-modules.md` A3 末条）：
 * 当前延迟、当前时长、待发的 `instantaneous` 从各自的初值重抄（`+0x18 ← +0x20`、`+0x14 ← +0x1c`、`+0x44 ← +0x48`），累积余数
 * （`+0x24`）、连发计数与周期计时（`+0x3c`、`+0x40`）清零。`flags`（`+0x4c`，bit31 是已结束）不动，所以已结束的 emitter 仍是
 * 结束的。不可见时清空系统前调用（`FUN_140230650`，C8）。
 */
export function resetEmitterTiming(state: EmitterState, fields: ParticleFields): void {
  const initial = emitterState(fields);
  state.acc = initial.acc;
  state.pending = initial.pending;
  state.delay = initial.delay;
  state.duration = initial.duration;
  state.burst = initial.burst;
  state.period = initial.period;
}

/**
 * 本帧要发射的数量（`FUN_1402378a0`，`0x1402379c0`–`0x140237b74`，`rea-p4b-modules.md` A1–A3）。`dt` 是 `dt'`（已乘
 * `instanceoverride.rate`），发射不受两遍模式影响。`random` 只给周期发射抽时长（流 A）：抽取时机在本 emitter 算数量时，
 * 早于它本帧的新粒子、晚于流顺序在它之前的 emitter 的新粒子（A3）。
 *
 * ```
 * 只有 存活 < 容量 且 未结束 且 delay ≤ 0 才进（否则整段跳过：acc、周期计时、pending 都不动）：
 *   flags bit2（周期）：
 *     P > 0（周期内）：P −= dt；P < 0 时 P = −(uA·(maxdelay − mindelay) + mindelay)，进入间歇，本帧照常发
 *     否则（间歇，含初值 0）：P += dt；P < 0 时 rate ·= 0；
 *       否则新周期：pending = instantaneous 初值，burst = 0，P = uA·(maxduration − minduration) + minduration（不补零头）
 *   n0 = pending; pending = 0
 *   x  = rate·dt + acc
 *   x < 1 或 duration < 0：acc = x − n0
 *   否则：k = floor(x); acc = x − (k + n0)（先扣全部 k，限额砍掉的不退回）
 *         bit1：k = min(1, k)；bit2 且 maxtoemit ≠ 0：k = min(k, max(0, maxtoemit − burst)), burst += k
 *         n0 += k
 * 实际发射 = min(n0, 容量 − 存活)
 * 帧尾（A2）：delay > 0 → delay −= dt；否则 duration > 0 → duration −= dt，≤ 0 时置 −1 并结束；
 *       否则 rate ≤ 0 且（instantaneous == 0 或非周期）→ 结束
 * ```
 * - bit1 不限 `instantaneous`（`n0` 不受约束）；`burst` 只数连续发射。
 * - `duration < 0` 只在 JSON 写了负的 `duration` 时出现（用完时同时置结束）：之后只发 `instantaneous`，余数一直累积。
 * - 帧尾读的 `rate` 是记录里的值（已乘 `count`），不是间歇里乘了 0 的那个。
 * - `maxtoemitperperiod` 已乘 `count` 并截断成整数（条目类型 1，`resolveParticleFields`）；`instantaneous` 不乘 `count`（实测）。
 * 脚本数量（`n0` 里的另一项）没实现。
 */
export function emissionCount(
  state: EmitterState,
  fields: ParticleFields,
  dt: number,
  alive: number,
  capacity: number,
  random: ParticleRandom,
): number {
  const flags = fields.flags as number;
  let rate = fields.rate as number;
  let emit = 0;
  if (alive < capacity && !state.ended && state.delay <= 0) {
    if (flags & 4) {
      if (state.period > 0) {
        state.period = f32(state.period - dt);
        if (state.period < 0) {
          const min = fields.minperiodicdelay as number;
          state.period = -lerp(min, f32((fields.maxperiodicdelay as number) - min), random.a());
        }
      } else {
        state.period = f32(state.period + dt);
        if (state.period < 0) rate = f32(rate * 0);
        else {
          const u = random.a();
          state.pending = Number(fields.instantaneous) || 0;
          state.burst = 0;
          const min = fields.minperiodicduration as number;
          state.period = lerp(min, f32((fields.maxperiodicduration as number) - min), u);
        }
      }
    }
    let n0 = state.pending;
    state.pending = 0;
    const x = f32(f32(rate * dt) + state.acc);
    if (x < 1 || state.duration < 0) state.acc = f32(x - n0);
    else {
      let k = Math.floor(x);
      state.acc = f32(x - (k + n0));
      if (flags & 2) k = Math.min(1, k);
      const limit = fields.maxtoemitperperiod as number;
      if (flags & 4 && limit !== 0) {
        k = Math.min(k, Math.max(0, limit - state.burst));
        state.burst += k;
      }
      n0 += k;
    }
    emit = Math.max(0, Math.min(Math.trunc(n0), capacity - alive));
  }
  if (state.delay > 0) state.delay = f32(state.delay - dt);
  else if (state.duration > 0) {
    state.duration = f32(state.duration - dt);
    if (state.duration <= 0) {
      state.duration = -1;
      state.ended = true;
    }
  } else if ((fields.rate as number) <= 0 && ((fields.instantaneous as number) === 0 || (flags & 4) === 0))
    state.ended = true;
  return emit;
}

/**
 * `sphererandom`（`FUN_1401b9100` 缺省值，B【确】）。每个新粒子按这个顺序抽随机：
 * 1. `φ = 2π·uB`；2. `cosθ = uA·(1−c)+c`，`c = −cos(π·cone)`；3. `r = cbrt(uB)`；
 * 4. `p = (r·cosθ, sinφ·r·sinθ, cosφ·r·sinθ)·directions`，`û = p / |p|`；5. `sign` 非零的分量强制同号；
 * 6. `q = (distancemin + (distancemax − distancemin)·|p|)·û`——**用 `|p|` 不是 `r`**；
 * 8. 位置 `q + origin`；9. 方向：`|q|² < 1e-4` 时另抽 3 个 uB 取 `(2u−1)·directions`，否则就是 `q`；
 * 10. 速度 `(speedmin + (speedmax − speedmin)·uB)·dir / |dir|`，三轴共用一个随机。
 *
 * 第 9 步另抽的 3 个按 x、y、z 顺序（读码没写，推断）。`|p| = 0`、`|dir| = 0` 时 WPE 的 `rcpps` / `rsqrtps` 得到无穷、
 * 乘出 NaN；这里按 0 处理（只在随机数恰好落在 0.5 之类的点上才会遇到）。
 */
export function sphereRandom(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, random, slot } = context;
  const origin = fields.origin as number[];
  const directions = fields.directions as number[];
  const sign = fields.sign as number[];
  const useSign = ((fields.flags as number) & 1) !== 0;
  const distanceMin = fields.distancemin as number;
  const distanceRange = f32((fields.distancemax as number) - distanceMin);
  const speedMin = fields.speedmin as number;
  const speedRange = f32((fields.speedmax as number) - speedMin);

  const phi = f32(TWO_PI * random.b());
  const c = f32(-Math.cos(f32(PI * (fields.cone as number))));
  const cosTheta = f32(f32(random.a() * f32(1 - c)) + c);
  const r = f32(Math.cbrt(random.b()));
  const sinTheta = f32(Math.sqrt(Math.max(0, f32(1 - f32(cosTheta * cosTheta)))));
  const rSin = f32(r * sinTheta);
  const p = [
    f32(f32(r * cosTheta) * directions[0]),
    f32(f32(f32(Math.sin(phi)) * rSin) * directions[1]),
    f32(f32(f32(Math.cos(phi)) * rSin) * directions[2]),
  ];
  const length = f32(Math.sqrt(f32(f32(f32(p[0] * p[0]) + f32(p[1] * p[1])) + f32(p[2] * p[2]))));
  const inverse = length > 0 ? rcp(length) : 0;
  const unit = p.map((value) => f32(value * inverse));
  if (useSign)
    for (let i = 0; i < 3; i++) if (sign[i] !== 0) unit[i] = sign[i] > 0 ? Math.abs(unit[i]) : -Math.abs(unit[i]);
  const distance = lerp(distanceMin, distanceRange, length);
  const q = unit.map((value) => f32(distance * value));
  for (let i = 0; i < 3; i++) columns.position[i][slot] = f32(q[i] + origin[i]);

  const q2 = f32(f32(f32(q[0] * q[0]) + f32(q[1] * q[1])) + f32(q[2] * q[2]));
  let direction = q;
  if (q2 < 1e-4) direction = directions.map((axis) => f32(f32(f32(2 * random.b()) - 1) * axis));
  const speed = lerp(speedMin, speedRange, random.b());
  const d2 = f32(
    f32(f32(direction[0] * direction[0]) + f32(direction[1] * direction[1])) + f32(direction[2] * direction[2]),
  );
  const scale = d2 > 0 ? f32(speed * f32(1 / Math.sqrt(d2))) : 0;
  for (let i = 0; i < 3; i++) columns.velocity[i][slot] = f32(scale * direction[i]);
}

/** `boxrandom` 回退判断的阈值（`0x14023896e` 比较的常量）。 */
const BOX_FALLBACK = f32(0.0001);
const fastFloat = new Float32Array(1);
const fastInt = new Int32Array(fastFloat.buffer);

/**
 * `boxrandom` 判断 `|d|` 太小用的整数位平方根倒数（`0x14023896e` 前：`0x5f375a86 − (bits >> 1)` 加一次牛顿迭代），
 * 逐位照抄。只用在 1e-4 的判断上，速度用精确的 `sqrtss` / `divss`。
 */
export function fastInvSqrt(x: number): number {
  fastFloat[0] = x;
  fastInt[0] = 0x5f375a86 - (fastInt[0] >> 1);
  const y = fastFloat[0];
  return f32(y * f32(1.5 - f32(f32(f32(0.5 * x) * y) * y)));
}

/** `(2·uB − 1)·directions`，三轴按 z、y、x 的顺序抽（A4；`2u` 是 `addss u, u`，精确）。 */
function boxDirections(random: ParticleRandom, directions: readonly number[]): number[] {
  const out = [0, 0, 0];
  for (const axis of [2, 1, 0]) out[axis] = f32(f32(f32(2 * random.b()) - 1) * directions[axis]);
  return out;
}

/** `(d.y·d.y + d.x·d.x) + d.z·d.z`（A4 的求和顺序）。 */
function lengthSquared(d: readonly number[]): number {
  return f32(f32(f32(d[1] * d[1]) + f32(d[0] * d[0])) + f32(d[2] * d[2]));
}

/**
 * `boxrandom`（`FUN_1401b9520` 缺省值，执行 `0x140238563`–`0x140238c3a`，`rea-p4b-modules.md` A4【确】）：逐轴独立的「空心盒」。
 * 1. 三轴按 z、y、x 各抽一个 uB：`r_i = (2u − 1)·directions_i`，`s_i` 是 `r_i` 的符号（0 时为 0）；
 * 2. `q_i = s_i·((s_i·r_i)·(max_i − min_i) + min_i)`：`|q_i| ∈ [min_i, min_i + |directions_i|·(max_i − min_i)]`，
 *    `distancemin` 三轴都大于 0 时落在 8 个角块里，不是盒壳（实测核对过）；
 * 3. 位置 `q + origin`；方向 `d` 用写进列的 float 重新减 `origin`，不是 `q` 本身；
 * 4. `1 / fastInvSqrt(|d|²) < 1e-4` 时回退：再按 z、y、x 抽 3 个 uB，`d = (2u − 1)·directions`；
 * 5. 速度 `(speedmin + (speedmax − speedmin)·uB)·(d / |d|)`，精确 `sqrt`、精确除法。
 *
 * 没有 `sign`、`cone`；`flags` 只有 bit1、bit2 有用（发射数量），bit0 不读。控制点 0 按单位阵、平移 0（`origin + cp.t` 就是
 * `origin`，不旋转）。`|d| = 0`（`directions "0 0 0"`）时 WPE 乘出 NaN，这里按速度 0 处理，同 `sphererandom`。
 */
export function boxRandom(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, random, slot } = context;
  const origin = fields.origin as number[];
  const directions = fields.directions as number[];
  const min = fields.distancemin as number[];
  const max = fields.distancemax as number[];
  const speedMin = fields.speedmin as number;
  const speedRange = f32((fields.speedmax as number) - speedMin);

  const r = boxDirections(random, directions);
  for (let i = 0; i < 3; i++) {
    const s = r[i] > 0 ? 1 : r[i] < 0 ? -1 : 0;
    const q = f32(s * f32(f32(f32(s * r[i]) * f32(max[i] - min[i])) + min[i]));
    columns.position[i][slot] = f32(q + origin[i]);
  }
  let d = [0, 1, 2].map((i) => f32(columns.position[i][slot] - origin[i]));
  if (f32(1 / fastInvSqrt(lengthSquared(d))) < BOX_FALLBACK) d = boxDirections(random, directions);
  const length = f32(Math.sqrt(lengthSquared(d)));
  const inverse = length > 0 ? f32(1 / length) : 0;
  const speed = lerp(speedMin, speedRange, random.b());
  for (let i = 0; i < 3; i++) columns.velocity[i][slot] = f32(speed * f32(inverse * d[i]));
}
