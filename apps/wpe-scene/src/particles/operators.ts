/**
 * operator（P4a 步骤 3）。依据 `rea-p4a.md` B「operator」（读码【确】）与 `p4-particles-REPORT.md` 的实测核对：
 * drag 的 `k0`、`oscillateposition` 的 ω 不乘 2π、两遍模式、y 偏移 `2π·R` 都实测过。
 *
 * 每个函数对 `[0, count)` 的全部槽跑一遍（死槽照常处理，写顶点时跳过，同 WPE）。这一遍的步长 `h`、drag 系数 `k`
 * 由模拟器给（两遍模式时是 `dt/2`、`k0/2`）。每遍开头 `size`、`rgb`、`a` 已重置为初始值，所以乘性模块跑两遍结果不变。
 */
import { clamp01, f32, lerp, orBits, rcp, TWO_PI } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";

/** drag 衰减的上限（`0x140492700`，`feff7f3f`）：drag 再大也保留约 1.19e-7 的速度。 */
export const MAX_DAMPING = f32(0.99999988);

/** 共用 blend 的四个键解析后的形状（B「operator」）。 */
export interface Blend {
  /** 参数实质非默认时才生效（WPE 切到带 blend 的记录类型）。 */
  active: boolean;
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

/**
 * `in_end > 0.01` 或 `out_start < 0.99`，并且三个间距（`ie − is`、`os − ie`、`oe − os`）里至少一个 > 0.01 时生效；
 * 解析时 `is ≤ ie − 0.0001`、`oe ≥ os + 0.0001`。「三个间距」具体是哪三个读码没写清，这里的取法是推断，没有实测。
 */
export function readBlend(fields: ParticleFields): Blend {
  const inStart = fields.blendinstart as number;
  const inEnd = fields.blendinend as number;
  const outStart = fields.blendoutstart as number;
  const outEnd = fields.blendoutend as number;
  const active =
    (inEnd > 0.01 || outStart < 0.99) &&
    (inEnd - inStart > 0.01 || outStart - inEnd > 0.01 || outEnd - outStart > 0.01);
  return {
    active,
    inStart: Math.min(inStart, f32(inEnd - 0.0001)),
    inEnd,
    outStart,
    outEnd: Math.max(outEnd, f32(outStart + 0.0001)),
  };
}

/** `b = clamp((t − is)/(ie − is), 0, 1) · clamp((oe − t)/(oe − os), 0, 1)`，`t = age / life`。 */
export function blendFactor(blend: Blend, t: number): number {
  const rise = clamp01(f32(f32(t - blend.inStart) * rcp(f32(blend.inEnd - blend.inStart))));
  const fall = clamp01(f32(f32(blend.outEnd - t) * rcp(f32(blend.outEnd - blend.outStart))));
  return f32(rise * fall);
}

/**
 * `movement`：半隐式欧拉。`v' = v + g·h`，`x' = x + v'·h`，`v'' = v'·(1 − min(drag·k, 0.99999988))`。
 * 有上一步位置列（bit2）时开头把位置拷过去。`flags` bit0（重力按模型矩阵变换）能力表拦住。
 */
export function movement(fields: ParticleFields, { columns, count, h, k }: ParticleRunContext): void {
  const gravity = fields.gravity as number[];
  const damping = f32(1 - Math.min(f32((fields.drag as number) * k), MAX_DAMPING));
  if (columns.previousPosition)
    for (let i = 0; i < 3; i++) columns.previousPosition[i].set(columns.position[i].subarray(0, count));
  for (let axis = 0; axis < 3; axis++) {
    const x = columns.position[axis];
    const v = columns.velocity[axis];
    const gh = f32(gravity[axis] * h);
    for (let i = 0; i < count; i++) {
      const velocity = f32(v[i] + gh);
      x[i] = f32(x[i] + f32(velocity * h));
      v[i] = f32(velocity * damping);
    }
  }
}

/**
 * `angularmovement`（置列标志 bit0、bit1）：
 * - 无 blend：`w' = w + f·h`；`rot += w'·h`；`w'' = w'·(1 − min(drag·k, 0.99999988))`
 * - 有 blend：`w' = w + f·h·b`；`rot += w'·h·b`；`w'' = w'·(1 − b·min(drag·k, 0.99999988))`
 */
export function angularMovement(fields: ParticleFields, { columns, count, h, k }: ParticleRunContext): void {
  const angular = columns.angularVelocity;
  if (!angular) return;
  const force = fields.force as number[];
  const drag = Math.min(f32((fields.drag as number) * k), MAX_DAMPING);
  const blend = readBlend(fields);
  for (let i = 0; i < count; i++) {
    const b = blend.active ? blendFactor(blend, f32(columns.age[i] * rcp(columns.life[i]))) : 1;
    const hb = blend.active ? f32(h * b) : h;
    const damping = blend.active ? f32(1 - f32(b * drag)) : f32(1 - drag);
    for (let axis = 0; axis < 3; axis++) {
      const w = f32(angular[axis][i] + f32(force[axis] * hb));
      columns.rotation[axis][i] = f32(columns.rotation[axis][i] + f32(w * hb));
      angular[axis][i] = f32(w * damping);
    }
  }
}

/**
 * `alphafade`（置列标志 bit4）：`t = age / life`；`t < in` 时 `a *= t / in`；`t > out` 时 `a *= (1 − t) / (1 − out)`；
 * 其余 `a *= 1`。`in`、`out` 是 `fadeintime`、`fadeouttime` 本身（寿命的比例）。WPE 用掩码按位或选值，`in > out` 且
 * 两段同时命中时结果是两个浮点数按位或，照做。
 */
export function alphaFade(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const fadeIn = fields.fadeintime as number;
  const fadeOut = fields.fadeouttime as number;
  const inverseIn = rcp(fadeIn);
  const inverseOut = rcp(f32(1 - fadeOut));
  const { age, life, alpha } = columns;
  for (let i = 0; i < count; i++) {
    const t = f32(age[i] * rcp(life[i]));
    const fadingIn = t < fadeIn;
    const fadingOut = t > fadeOut;
    let factor = 1;
    if (fadingIn && fadingOut) factor = orBits(f32(t * inverseIn), f32(f32(1 - t) * inverseOut));
    else if (fadingIn) factor = f32(t * inverseIn);
    else if (fadingOut) factor = f32(f32(1 - t) * inverseOut);
    alpha[i] = f32(alpha[i] * factor);
  }
}

/**
 * `oscillateposition`：频率、相位、幅度都由共用的 `R` 现算（F2）。
 * ```
 * ω = fmin + R·frange         （不乘 2π；fmin / fmax 已乘 instanceoverride.speed）
 * t = age + (pmin + R·prange)  （相位加在时间上）
 * s = smin + R·srange          （有 blend 时 s *= b）
 * D(τ) = sin(ω·τ) − sin(ω·(τ − h))
 * x += s·mask.x·D(t)；z += s·mask.z·D(t)；y += s·mask.y·D(t + 2π·R)
 * ```
 * 不读速度。两遍模式时 `t` 不变、`h` 减半。
 */
export function oscillatePosition(fields: ParticleFields, { columns, count, h }: ParticleRunContext): void {
  const mask = fields.mask as number[];
  const frequencyMin = fields.frequencymin as number;
  const frequencyRange = f32((fields.frequencymax as number) - frequencyMin);
  const scaleMin = fields.scalemin as number;
  const scaleRange = f32((fields.scalemax as number) - scaleMin);
  const phaseMin = fields.phasemin as number;
  const phaseRange = f32((fields.phasemax as number) - phaseMin);
  const blend = readBlend(fields);
  const { age, life, random, position } = columns;
  for (let i = 0; i < count; i++) {
    const r = random[i];
    const omega = lerp(frequencyMin, frequencyRange, r);
    const t = f32(age[i] + lerp(phaseMin, phaseRange, r));
    let s = lerp(scaleMin, scaleRange, r);
    if (blend.active) s = f32(s * blendFactor(blend, f32(age[i] * rcp(life[i]))));
    const delta = (tau: number) => f32(f32(Math.sin(f32(omega * tau))) - f32(Math.sin(f32(omega * f32(tau - h)))));
    if (mask[0] !== 0 || mask[2] !== 0) {
      const d = delta(t);
      if (mask[0] !== 0) position[0][i] = f32(position[0][i] + f32(f32(s * mask[0]) * d));
      if (mask[2] !== 0) position[2][i] = f32(position[2][i] + f32(f32(s * mask[2]) * d));
    }
    if (mask[1] !== 0) {
      const d = delta(f32(t + f32(TWO_PI * r)));
      position[1][i] = f32(position[1][i] + f32(f32(s * mask[1]) * d));
    }
  }
}

/**
 * `oscillatealpha`（置列标志 bit4）：ω、t 同 `oscillateposition`（频率不乘 instanceoverride.speed）；
 * `V = smin + R·srange·(1 + sin(ω·t))/2`——幅度里**多乘一次 `R`**；无 blend 时 `a *= V`，有 blend 时 `a *= 1 − (1 − V)·b`。
 */
export function oscillateAlpha(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const frequencyMin = fields.frequencymin as number;
  const frequencyRange = f32((fields.frequencymax as number) - frequencyMin);
  const scaleMin = fields.scalemin as number;
  const scaleRange = f32((fields.scalemax as number) - scaleMin);
  const phaseMin = fields.phasemin as number;
  const phaseRange = f32((fields.phasemax as number) - phaseMin);
  const blend = readBlend(fields);
  const { age, life, random, alpha } = columns;
  for (let i = 0; i < count; i++) {
    const r = random[i];
    const omega = lerp(frequencyMin, frequencyRange, r);
    const t = f32(age[i] + lerp(phaseMin, phaseRange, r));
    const wave = f32(f32(1 + f32(Math.sin(f32(omega * t)))) * 0.5);
    const value = f32(scaleMin + f32(f32(r * scaleRange) * wave));
    const factor = blend.active ? f32(1 - f32(f32(1 - value) * blendFactor(blend, f32(age[i] * rcp(life[i]))))) : value;
    alpha[i] = f32(alpha[i] * factor);
  }
}
