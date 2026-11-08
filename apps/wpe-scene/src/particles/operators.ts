/**
 * operator（P4a 步骤 3、P4b 步骤 3–4）。依据 `rea-p4a.md` B「operator」、`rea-p4b-modules.md` B4–B8（读码【确】）与
 * `p4-particles-REPORT.md` 的实测核对：drag 的 `k0`、`oscillateposition` 的 ω 不乘 2π、两遍模式、y 偏移 `2π·R`、
 * `sizechange` 乘 `instanceoverride.size`、`vortex` 的柱形 / 球形、`capvelocity` 的截速都实测过。
 *
 * 每个函数对 `[0, count)` 的全部槽跑一遍（死槽照常处理，写顶点时跳过，同 WPE）。这一遍的步长 `h`、drag 系数 `k`
 * 由模拟器给（两遍模式时是 `dt/2`、`k0/2`）。每遍开头 `size`、`rgb`、`a` 已重置为初始值，所以乘性模块跑两遍结果不变。
 */
import { clamp01, f32, lerp, orBits, rcp, rsqrt, TWO_PI } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
import { snoise3 } from "./noise";

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

/**
 * SSE 的 `minps(x, 1)` 再 `maxps(0, …)`：`minps` 在任一操作数是 NaN 时取第二个，所以 NaN 得 1（`rea-p4b-modules.md` B4
 * 「`x` 为 NaN 时得 1」）。和 `clamp01` 不同，那个让 NaN 原样通过。
 */
export function saturatePs(value: number): number {
  const low = value < 1 ? value : 1;
  return 0 > low ? 0 : low;
}

/**
 * `*change` 的生命比例（B4）：`t = maxps(0, minps(((1/life)·age − starttime)·(1/(endtime − starttime)), 1))`。
 * 倒数在 WPE 是 `rcpps`（`1/life` 每帧、`1/(endtime − starttime)` 解析期），按精确值算。`endtime = starttime` 时倒数是
 * inf：比例正好等于 `starttime` 时 `0·inf = NaN`，按 `minps` 得 1。
 */
function changeTime(fields: ParticleFields): (age: number, life: number) => number {
  const start = fields.starttime as number;
  const rcpEnd = rcp(f32((fields.endtime as number) - start));
  return (age, life) => saturatePs(f32(f32(f32(age * rcp(life)) - start) * rcpEnd));
}

/**
 * `sizechange`（operator 4，`0x14024033a`，B4【确】）：`size *= start + t·(end − start)`。`startvalue`、`endvalue` 都乘
 * `instanceoverride.size`（条目类型 7，实测：和 `sizerandom` 叠用时按 `size²` 放大）。不置列标志，不用 `h`、`k`、`R`，没有 blend。
 */
export function sizeChange(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const start = fields.startvalue as number;
  const range = f32((fields.endvalue as number) - start);
  const time = changeTime(fields);
  const { age, life, size } = columns;
  for (let i = 0; i < count; i++) size[i] = f32(size[i] * lerp(start, range, time(age[i], life[i])));
}

/** `alphachange`（operator 6，`0x140240457`，B4【确】，置列标志 bit4）：`a *= start + t·(end − start)`，乘当前值列。 */
export function alphaChange(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const start = fields.startvalue as number;
  const range = f32((fields.endvalue as number) - start);
  const time = changeTime(fields);
  const { age, life, alpha } = columns;
  for (let i = 0; i < count; i++) alpha[i] = f32(alpha[i] * lerp(start, range, time(age[i], life[i])));
}

/**
 * `colorchange`（operator 5，`0x1402403a2`，B4【确】，置列标志 bit3）：三通道各自 `rgb *= start + t·(end − start)`，共用一个 `t`。
 * 两个颜色是 0–1 的倍数，不除以 255。`colorn` 的 HSV 路径（条目类型 0xc）属 P4b 步骤 6，能力表按 `particle:instance:colorn` 拦住。
 */
export function colorChange(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const start = fields.startvalue as number[];
  const end = fields.endvalue as number[];
  const range = start.map((value, channel) => f32(end[channel] - value));
  const time = changeTime(fields);
  const { age, life, color } = columns;
  for (let i = 0; i < count; i++) {
    const t = time(age[i], life[i]);
    for (let channel = 0; channel < 3; channel++)
      color[channel][i] = f32(color[channel][i] * lerp(start[channel], range[channel], t));
  }
}

/**
 * `oscillatesize`（operator 9，`0x14024123a`，blend `0x1402413a0`，B5【确】）：
 * ```
 * ω   = fmin + R·(fmax − fmin)        （不乘 2π，频率不乘 instanceoverride.speed）
 * τ   = (pmin + R·(pmax − pmin)) + age （相位加在时间上）
 * s   = sin(τ·ω)
 * amp = R·((smax − smin)·0.5)         （幅度也乘 R）
 * 无 blend：size *= (s + 1)·amp + smin
 * 有 blend：size *= ((s + 1)·amp + (smin − 1))·b + 1
 * ```
 * WPE 的 `sin` 是 `sse_mathfun` 的 `sin_ps`，这里用 `Math.sin`（同 P4a 的 `oscillate*`）。绝对式，两遍结果不变，不置列标志。
 */
export function oscillateSize(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const frequencyMin = fields.frequencymin as number;
  const frequencyRange = f32((fields.frequencymax as number) - frequencyMin);
  const phaseMin = fields.phasemin as number;
  const phaseRange = f32((fields.phasemax as number) - phaseMin);
  const scaleMin = fields.scalemin as number;
  const halfRange = f32(f32((fields.scalemax as number) - scaleMin) * 0.5);
  const offset = f32(scaleMin - 1);
  const blend = readBlend(fields);
  const { age, life, random, size } = columns;
  for (let i = 0; i < count; i++) {
    const r = random[i];
    const omega = lerp(frequencyMin, frequencyRange, r);
    const tau = f32(lerp(phaseMin, phaseRange, r) + age[i]);
    const wave = f32(f32(f32(Math.sin(f32(tau * omega))) + 1) * f32(r * halfRange));
    const factor = blend.active
      ? f32(f32(f32(wave + offset) * blendFactor(blend, f32(age[i] * rcp(life[i])))) + 1)
      : f32(wave + scaleMin);
    size[i] = f32(size[i] * factor);
  }
}

/** `vortex` 的 `axis` 判零阈值（`xmm11`，`rea-p4b-modules.md` B7【推】）。 */
const AXIS_EPSILON = f32(0.001);

/**
 * `vortex`（operator 15，`0x1402431be`，B7【确】，没有 blend）：
 * ```
 * C    = cp.t + offset                         （控制点 0 平移按 0；offset、axis 不经控制点旋转）
 * d    = pos − C
 * proj = (d.y·a.y + d.x·a.x) + d.z·a.z        （flags bit0 置位时；否则 0）
 * r    = d − proj·a;  L2 = (r.y² + r.x²) + r.z²
 * q    = rsqrtps(L2);  r̂ = q·r;  L = q·L2
 * t    = maxps(0, minps((L − inner)·rcpRange, 1))
 * v   += (r̂ × a)·(t·(speedouter − speedinner)·k + speedinner·k)
 * ```
 * - `flags` bit0：去掉沿轴分量，按到轴线的距离（柱形）；否则按到中心的距离（球形），实测核对过。
 * - **乘的是 drag 系数 `k`，不是步长 `h`**（`0x140240290` 每条 operator 开头把 `xmm8` 装成 `k`）：fps ≥ 40 时两者相等。
 * - 解析期：`axis` 精确归一化，`|axis|² < 0.001` 时取 `0 0 1`；`rcpRange = rcpps(outer − inner)`，两者相等时 1.0
 *   （两个常量是按寄存器赋值推的【推】）。`speedinner`、`speedouter` 已乘 `instanceoverride.speed`（条目类型 7）。
 *   这里每遍从模拟字段现算，和存在记录里的值相同。
 * - `rsqrtps` 按精确值算。`L2 = 0`（粒子正好在中心或轴上）时 WPE 得 NaN，这里跳过这个粒子。不用 `R`。
 */
export function vortex(fields: ParticleFields, { columns, count, k }: ParticleRunContext): void {
  const raw = fields.axis as number[];
  const axisSquared = f32(f32(f32(raw[1] * raw[1]) + f32(raw[0] * raw[0])) + f32(raw[2] * raw[2]));
  const axisLength = f32(Math.sqrt(axisSquared));
  const a = axisSquared < AXIS_EPSILON ? [0, 0, 1] : raw.map((value) => f32(value / axisLength));
  const center = fields.offset as number[];
  const inner = fields.distanceinner as number;
  const outer = fields.distanceouter as number;
  const rcpRange = outer === inner ? 1 : rcp(f32(outer - inner));
  const speedInner = f32((fields.speedinner as number) * k);
  const speedRange = f32(f32((fields.speedouter as number) - (fields.speedinner as number)) * k);
  const cylinder = ((fields.flags as number) & 1) !== 0;
  const { position, velocity } = columns;
  const d = [0, 0, 0];
  const r = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) d[axis] = f32(position[axis][i] - center[axis]);
    const proj = cylinder ? f32(f32(f32(d[1] * a[1]) + f32(d[0] * a[0])) + f32(d[2] * a[2])) : 0;
    for (let axis = 0; axis < 3; axis++) r[axis] = f32(d[axis] - f32(proj * a[axis]));
    const lengthSquared = f32(f32(f32(r[1] * r[1]) + f32(r[0] * r[0])) + f32(r[2] * r[2]));
    if (!(lengthSquared > 0)) continue;
    const q = rsqrt(lengthSquared);
    const ux = f32(q * r[0]);
    const uy = f32(q * r[1]);
    const uz = f32(q * r[2]);
    const t = saturatePs(f32(f32(f32(q * lengthSquared) - inner) * rcpRange));
    const speed = f32(f32(t * speedRange) + speedInner);
    velocity[0][i] = f32(velocity[0][i] + f32(f32(f32(uy * a[2]) - f32(uz * a[1])) * speed));
    velocity[1][i] = f32(velocity[1][i] + f32(f32(f32(uz * a[0]) - f32(ux * a[2])) * speed));
    velocity[2][i] = f32(velocity[2][i] + f32(f32(f32(ux * a[1]) - f32(uy * a[0])) * speed));
  }
}

/**
 * `turbulence`（operator 14，`0x14024295a`，blend `0x140242d6e`，`rea-p4b-modules.md` B6【确】）：三维噪声场加到速度上。
 * ```
 * Ts   = T·timescale                                  （timescale 已乘 instanceoverride.rate）
 * mk_i = k·mask_i                                     （乘 drag 系数 k，不是步长 h）
 * 每粒子：
 *   φ   = R·(phasemax − phasemin) + Ts                （phasemin 本身不参与，实测）
 *   spd = R·(speedmax − speedmin) + speedmin          （有 blend 时再乘 b；speedmin / max 已乘 instanceoverride.speed）
 *   X = (x + φ)·scale;  Y = (y + φ)·scale;  Z = (z + φ)·scale
 *   Nx = snoise3(X, Y, Z);  Ny = snoise3(Z, X, Y);  Nz = snoise3(Y, Z, X)     （只算掩码里的轴，其余为 0）
 *   v_i = (N_i·mk_i)·spd + v_i
 * ```
 * - **乘的是 `k`**：`xmm8` 每条 operator 开头装成 `k`（`0x140240290`）。fps ≥ 40（`dt ≤ 0.025`）时 `k = dt'`，看不出差别；
 *   两遍模式时每遍是 `k/2`，两遍之间位置被 `movement` 改过，噪声输入不同，照常处理。
 * - `mask` 每轴非 0 才算这一轴（解析期置 p+0xc4 的位），三轴全 0 时整条跳过。三个轴照汇编都做加法（没算的轴 `N = 0`）。
 * - 用 `R` 两处（相位、速度）；不置列标志，不用控制点。`audioprocessing*`（乘速度）属 P4e，能力表照报。
 */
export function turbulence(fields: ParticleFields, { columns, count, k, time }: ParticleRunContext): void {
  const mask = fields.mask as number[];
  const useX = mask[0] !== 0;
  const useY = mask[1] !== 0;
  const useZ = mask[2] !== 0;
  if (!useX && !useY && !useZ) return;
  const phaseTime = f32(time * (fields.timescale as number));
  const speedMin = fields.speedmin as number;
  const speedRange = f32((fields.speedmax as number) - speedMin);
  const phaseRange = f32((fields.phasemax as number) - (fields.phasemin as number));
  const mkx = f32(k * mask[0]);
  const mky = f32(k * mask[1]);
  const mkz = f32(k * mask[2]);
  const scale = fields.scale as number;
  const blend = readBlend(fields);
  const { age, life, random, position, velocity } = columns;
  const [px, py, pz] = position;
  const [vx, vy, vz] = velocity;
  for (let i = 0; i < count; i++) {
    const r = random[i];
    const phase = f32(f32(r * phaseRange) + phaseTime);
    let speed = f32(f32(r * speedRange) + speedMin);
    if (blend.active) speed = f32(speed * blendFactor(blend, f32(age[i] * rcp(life[i]))));
    const x = f32(f32(px[i] + phase) * scale);
    const y = f32(f32(py[i] + phase) * scale);
    const z = f32(f32(pz[i] + phase) * scale);
    const nx = useX ? snoise3(x, y, z) : 0;
    const ny = useY ? snoise3(z, x, y) : 0;
    const nz = useZ ? snoise3(y, z, x) : 0;
    vx[i] = f32(f32(f32(nx * mkx) * speed) + vx[i]);
    vy[i] = f32(f32(f32(ny * mky) * speed) + vy[i]);
    vz[i] = f32(f32(f32(nz * mkz) * speed) + vz[i]);
  }
}

/**
 * `capvelocity`（operator 18，`0x1402446fd`，blend `0x140244790`，B8【确】）：
 * ```
 * q = rsqrtps((v.y² + v.x²) + v.z²)·maxspeed
 * 无 blend：s = min(1, q)；有 blend：s = min(0, q − 1)·b + 1
 * v *= s
 * ```
 * `maxspeed` 没有覆盖项：`instanceoverride.speed` 放大速度但不放大上限。两遍模式每遍都截。`rsqrtps` 按精确值算（WPE 截 300 到
 * 99.9927 就是它的近似，实测）。`v = 0` 时 `q = inf`、`s = 1`，这里直接跳过（`maxspeed = 0` 时 WPE 是 `inf·0 = NaN`【推】，
 * 速度本来就是 0）。
 */
export function capVelocity(fields: ParticleFields, { columns, count }: ParticleRunContext): void {
  const maxSpeed = fields.maxspeed as number;
  const blend = readBlend(fields);
  const { age, life, velocity } = columns;
  const [vx, vy, vz] = velocity;
  for (let i = 0; i < count; i++) {
    const lengthSquared = f32(f32(f32(vy[i] * vy[i]) + f32(vx[i] * vx[i])) + f32(vz[i] * vz[i]));
    if (!(lengthSquared > 0)) continue;
    const q = f32(rsqrt(lengthSquared) * maxSpeed);
    let scale: number;
    if (blend.active) {
      const over = f32(q - 1);
      scale = f32(f32((over < 0 ? over : 0) * blendFactor(blend, f32(age[i] * rcp(life[i])))) + 1);
    } else scale = q < 1 ? q : 1;
    vx[i] = f32(vx[i] * scale);
    vy[i] = f32(vy[i] * scale);
    vz[i] = f32(vz[i] * scale);
  }
}
