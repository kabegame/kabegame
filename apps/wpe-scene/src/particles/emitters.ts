/**
 * 发射（P4a 步骤 3）。依据 `rea-p4a.md` B「发射数量」「`sphererandom`」（读码【确】），`instantaneous` 欠账实测核对过。
 *
 * - `emissionCount`：每个 emitter、每帧算本帧要发几个（`FUN_1402378a0`），emitter 类型共有；
 * - `sphereRandom`：模块表 `sphererandom` 的执行函数，给一个新粒子写位置、速度。
 *
 * 控制点（`controlpoint ≠ 0`、世界空间）属 P4c，能力表已拦住，这里控制点矩阵按单位阵、平移按 0。
 */
import { f32, lerp, PI, rcp, TWO_PI } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";

/** emitter 的模块级状态（WPE 存在流记录里，每实例一份，Q5）。 */
export interface EmitterState {
  /** 累积余数（记录 `+0x24`）：`instantaneous` 从这里扣，所以会变负。 */
  acc: number;
  /** 待发的 `instantaneous`。 */
  pending: number;
  /** 剩余延迟（`delay`，倒数）。 */
  delay: number;
  /** 剩余时长（`duration`）；0 不限，−1 已用完。 */
  duration: number;
  /** 已结束（WPE 的 bit31）。 */
  ended: boolean;
}

export function emitterState(fields: ParticleFields): EmitterState {
  return {
    acc: 0,
    pending: Number(fields.instantaneous) || 0,
    delay: f32(Number(fields.delay) || 0),
    duration: f32(Number(fields.duration) || 0),
    ended: false,
  };
}

/**
 * 本帧要发射的数量（`FUN_1402378a0`）。`dt` 是 `dt'`（已乘 `instanceoverride.rate`），发射不受两遍模式影响。
 *
 * ```
 * 只有 存活 < 容量 且 未结束 且 delay ≤ 0 才进：
 *   n0 = pending_instantaneous; pending = 0
 *   x  = rate·dt + acc
 *   x < 1：  acc = x − n0
 *   否则：   k = floor(x); acc = x − (k + n0); n0 += k
 * 实际发射 = min(n0, 容量 − 存活)
 * 帧尾：delay > 0 → delay −= dt；否则 duration > 0 → duration −= dt，≤ 0 时置 −1 并结束；
 *       否则 rate ≤ 0 且（instantaneous == 0 或非周期）→ 结束
 * ```
 * 满容量时不进第一段，`acc` 不累积；溢出容量的数量不退回。bit1（每帧至多 1 个）、周期发射、脚本数量没实现
 * （能力表拦住）。
 */
export function emissionCount(
  state: EmitterState,
  fields: ParticleFields,
  dt: number,
  alive: number,
  capacity: number,
): number {
  const rate = fields.rate as number;
  let emit = 0;
  if (alive < capacity && !state.ended && state.delay <= 0) {
    let n0 = state.pending;
    state.pending = 0;
    const x = f32(f32(rate * dt) + state.acc);
    if (x < 1) state.acc = f32(x - n0);
    else {
      const k = Math.floor(x);
      state.acc = f32(x - (k + n0));
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
  } else if (rate <= 0 && ((fields.instantaneous as number) === 0 || ((fields.flags as number) & 4) === 0))
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
