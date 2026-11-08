/**
 * operator（P4a 步骤 3、P4b 步骤 3–4、P4c 步骤 3–4）。依据 `rea-p4a.md` B「operator」、`rea-p4b-modules.md` B4–B8、
 * `rea-p4c-sim.md` 第 4、5 节（读码【确】）与 `p4-particles-REPORT.md` 的实测核对：drag 的 `k0`、`oscillateposition` 的 ω 不乘 2π、
 * 两遍模式、y 偏移 `2π·R`、`sizechange` 乘 `instanceoverride.size`、`vortex` 的柱形 / 球形、`capvelocity` 的截速、
 * `controlpointattract` 的缺省钳制与 `threshold` 严格小于都实测过（乘 `k`、钳制、`speed` 的定量由 `ignore/p4/c3` 的回放与单步
 * 核对确认）。
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
 * 有上一步位置列（bit2）时开头把位置拷过去。
 *
 * `flags` bit0 且系统不是世界空间时，重力先变换成 `g = Mᵀ·g`（P4c 步骤 4，rea-p4c-sim.md 5.4，汇编核对过
 * `0x14023fde2`–`0x14023fe31`）：`M` 是模拟时的模型矩阵栈顶 `*(ctx+0x30)`，顶层系统就是 `W`（`context.model`，含缩放、不归一化），
 * `FUN_1400dd7d0` 取它前三列的 xyz，`FUN_1401f87e0` 逐步 float32 算
 * `x' = (g.y·m1 + g.x·m0) + g.z·m2`、`y' = (g.x·m3 + g.y·m4) + g.z·m5`、`z' = (g.x·m6 + g.y·m7) + g.z·m8`（列主序，即每列点乘
 * `g`），在乘 `h` 之前。变换在 operator 解释器 `FUN_14023fbc0` 里，两遍模式每遍都做。效果：本地系统把世界方向转进对象本地；
 * 世界系统不变换，`g` 直接是世界方向；`flags` 0 时两种系统都不变换（本地系统的重力随对象转）。
 */
export function movement(fields: ParticleFields, { columns, count, h, k, world, model }: ParticleRunContext): void {
  let gravity = fields.gravity as number[];
  if ((fields.flags as number) & 1 && !world) {
    const [gx, gy, gz] = gravity;
    gravity = [
      f32(f32(f32(gy * model[1]) + f32(gx * model[0])) + f32(gz * model[2])),
      f32(f32(f32(gx * model[3]) + f32(gy * model[4])) + f32(gz * model[5])),
      f32(f32(f32(gx * model[6]) + f32(gy * model[7])) + f32(gz * model[8])),
    ];
  }
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
 * 两个颜色是 0–1 的倍数，不除以 255。`colorn` 生效时两端已由模拟器平移过（条目类型 0xc，`ParticleSystem.applyColorn`，
 * rea-p4b-render.md 7.4）：WPE 写回 start = `A'`、Δ = `B' − A'`，这里按 `f32(end − start)` 现算 Δ，结果相同。
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
 * C    = cp[controlpoint].t + offset           （控制点的 current；offset、axis 不经控制点旋转，3×3 不用）
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
 * - 中心（P4c 步骤 1，`0x1402431be`–`0x14024322c`）：`FUN_14024f2d0` 拷出 `cp[controlpoint]` 的 current，`FUN_14022a120` 把
 *   平移的三个分量广播成三个寄存器，再 `addps` 上 `offset`。实测控制点带 `controlpointangle1 "1.5708 0 0"` 时粒子 z 一直为 0
 *   （3×3 不用）。
 * - 世界空间系统（P4c 步骤 4，rea-p4c-sim.md 5.5）：中心是世界坐标的 `cp.t`（`W·base`），轴不变换，所以轴固定在世界；本地系统里
 *   轴随对象转（绘制时乘 `W`）。
 * - `rsqrtps` 按精确值算。`L2 = 0`（粒子正好在中心或轴上）时 WPE 得 NaN，这里跳过这个粒子。不用 `R`。
 */
export function vortex(fields: ParticleFields, { columns, count, k, controlPoints }: ParticleRunContext): void {
  const raw = fields.axis as number[];
  const axisSquared = f32(f32(f32(raw[1] * raw[1]) + f32(raw[0] * raw[0])) + f32(raw[2] * raw[2]));
  const axisLength = f32(Math.sqrt(axisSquared));
  const a = axisSquared < AXIS_EPSILON ? [0, 0, 1] : raw.map((value) => f32(value / axisLength));
  const translation = controlPoints.current(fields.controlpoint as number).translation;
  const center = (fields.offset as number[]).map((offset, i) => f32(translation[i] + offset));
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
 * `FLT_MIN`（`0x00800000`）：`controlpointattract` 的 `L` 不大于它时这个粒子不受影响，避免 `rcp(0)`。两个执行段比较的是函数内
 * 静态 `0x1404e9960` / `0x1404e9980`，运行时由 `0x14024bafc` / `0x14024bb35` 从 `0x140492cd0` 拷入（四个分量都是 `0x00800000`，
 * `ignore/p4/c3/consts.py` 读过）。
 */
const FLT_MIN = 2 ** -126;

/**
 * `controlpointattract`（operator 10，`0x140241554`；blend 版 0x20，`0x14024172d`，rea-p4c-sim.md 4.2【确】，两段汇编逐条核对过）：
 * 按粒子到控制点的距离改速度，不改位置。
 * ```
 * C  = cp[controlpoint].current.t          （FUN_14024f2d0 拷出 current，FUN_14022a120 广播平移；offset 不读）
 * ks = k·scale                             （mulps xmm10 = k·[p+0x30]；scale 已乘 instanceoverride.speed）
 * rT = rcpps(threshold)
 * 每槽（[0, count)，死槽也算）：
 *   dx = x − Cx;  dy = y − Cy;  dz = z − Cz
 *   L  = sqrtps((dz² + dy²) + dx²);  inv = rcpps(L)
 *   active = (L < threshold) 且 (FLT_MIN < L)          （两个 cmpltps，都是严格小于）
 *   f  = (1 − L·rT)·ks
 *   flags & 2 且 L < f 时 f = L                         （cmpltps L, f；andps 钳制掩码；blendvps）
 *   [blend 版：f = f·b]                                 （钳制之后 mulps，b 由 FUN_14022a530 算，同其它模块的 blend）
 *   active 时 vy −= (inv·dy)·f，vz −= (inv·dz)·f，vx −= (inv·dx)·f
 * flags & 1：删除判定（attractDelete）
 * ```
 * - **乘的是 drag 系数 `k`，不是步长 `h`**（`xmm8` 每条 operator 开头装成 `k`，同 `vortex`）；两遍模式每遍 `k/2`，删除判定每遍都做。
 * - `scale < 0` 时 `f < 0`，`L < f` 永不成立，不钳（排斥）。`L` 为 NaN 时 `active` 为假，不受影响。
 * - `rcpps` 按精确值算（文件头「近似倒数不复刻」），回放按包络放宽。不用 `R`、不读控制点的 3×3 与 `previous`。
 */
export function controlPointAttract(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, count, k, controlPoints } = context;
  const center = controlPoints.current(fields.controlpoint as number).translation;
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];
  const threshold = fields.threshold as number;
  const ks = f32(k * (fields.scale as number));
  const rT = rcp(threshold);
  const flags = fields.flags as number;
  const clamp = (flags & 2) !== 0;
  const blend = readBlend(fields);
  const { age, life } = columns;
  const [px, py, pz] = columns.position;
  const [vx, vy, vz] = columns.velocity;
  for (let i = 0; i < count; i++) {
    const dx = f32(px[i] - cx);
    const dy = f32(py[i] - cy);
    const dz = f32(pz[i] - cz);
    const length = f32(Math.sqrt(f32(f32(f32(dz * dz) + f32(dy * dy)) + f32(dx * dx))));
    // 不生效的槽 WPE 减的是 +0（andps 掩掉），和不动相同
    if (!(length < threshold && FLT_MIN < length)) continue;
    const inv = rcp(length);
    let f = f32(f32(1 - f32(length * rT)) * ks);
    if (clamp && length < f) f = length;
    if (blend.active) f = f32(f * blendFactor(blend, f32(age[i] * rcp(life[i]))));
    vy[i] = f32(vy[i] - f32(f32(inv * dy) * f));
    vz[i] = f32(vz[i] - f32(f32(inv * dz) * f));
    vx[i] = f32(vx[i] - f32(f32(inv * dx) * f));
  }
  if (flags & 1) attractDelete(fields, context, cx, cy, cz);
}

/**
 * `controlpointattract` 的删除判定（`flags` bit0，`FUN_14022a150`，rea-p4c-sim.md 4.3【确】）：线段 `[上一步位置, 位置]`（这一遍
 * `movement` 的位移；没有 `movement` 时起点是出生位置）上离 `C` 最近的点到 `C` 的距离平方不大于 `deletethreshold²` 时
 * `age = life`：本帧照常画，下一帧 `age += dt'` 严格大于 `life` 才判死。运算顺序按汇编（`0x14022a1c0`–`0x14022a2fb`）逐条核对，
 * 和 rea 4.3 取自 Ghidra 的写法有两处不同（乘法结合）：
 * ```
 * d  = P1 − P0;  L = sqrtps((dz² + dy²) + dx²)
 * r  = (0 < L) ? rcpps(L) : 1                                    （cmpltps 0, L；andps / andnps 1.0 / orps）
 * u  = r·d                                                       （先算 r·dx、r·dy、r·dz，0x14022a264–0x14022a277）
 * s  = ((Cz − P0z)·uz + (Cy − P0y)·uy) + (Cx − P0x)·ux           （0x14022a27a–0x14022a287）
 * s  = (0 ≤ s) ? s : 0;  s = (s ≤ L) ? s : L                     （cmpleps；NaN 得 0；L 为 NaN 时得 L）
 * e  = C − (s·u + P0)                                            （s·ux 再加 P0x，0x14022a2aa–0x14022a2d3）
 * !(deletethreshold² < (ez² + ey²) + ex²) 时 age = life          （cmpltps；比较为假（含 NaN）就删）
 * ```
 * `deletethreshold²` 是 float 平方（解析期 `mulss`）。死槽也处理（命中时死槽的 `age` 被写成 0，出生时会重写，不影响结果）。
 * 上一步位置列在 `flags & 1` 时一定存在（`columnFlagsOf` 开列）；列为 null 时跳过只是防御，正常路径不会发生。
 */
function attractDelete(
  fields: ParticleFields,
  { columns, count }: ParticleRunContext,
  cx: number,
  cy: number,
  cz: number,
): void {
  const previous = columns.previousPosition;
  if (!previous) return;
  const threshold = fields.deletethreshold as number;
  const thresholdSquared = f32(threshold * threshold);
  const { age, life } = columns;
  const [px, py, pz] = columns.position;
  const [qx, qy, qz] = previous;
  for (let i = 0; i < count; i++) {
    const x0 = qx[i];
    const y0 = qy[i];
    const z0 = qz[i];
    const dx = f32(px[i] - x0);
    const dy = f32(py[i] - y0);
    const dz = f32(pz[i] - z0);
    const length = f32(Math.sqrt(f32(f32(f32(dz * dz) + f32(dy * dy)) + f32(dx * dx))));
    const r = 0 < length ? rcp(length) : 1;
    const ux = f32(r * dx);
    const uy = f32(r * dy);
    const uz = f32(r * dz);
    let s = f32(f32(f32(f32(cz - z0) * uz) + f32(f32(cy - y0) * uy)) + f32(f32(cx - x0) * ux));
    s = 0 <= s ? s : 0;
    s = s <= length ? s : length;
    const ex = f32(cx - f32(f32(s * ux) + x0));
    const ey = f32(cy - f32(f32(s * uy) + y0));
    const ez = f32(cz - f32(f32(s * uz) + z0));
    const distanceSquared = f32(f32(f32(ez * ez) + f32(ey * ey)) + f32(ex * ex));
    if (!(thresholdSquared < distanceSquared)) age[i] = life[i];
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
