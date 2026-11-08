/**
 * initializer（P4a 步骤 3、P4b 步骤 3–4）。依据 `rea-p4a.md` B「initializer」、`rea-p4b-modules.md` B1–B3（读码【确】）。
 *
 * 模拟器给新粒子先抽 `R = uA`、写缺省值，再按 JSON 顺序调这里的函数。每个函数的 `t` 都是 `uA`，`exponent ≠ 1` 时
 * `t = pow(t, exponent)`（`powf` 是推断）。min / max 已乘 `instanceoverride`（`resolveParticleFields`）。
 * 噪声类（`turbulentvelocityrandom`、`positionoffsetrandom`）另读场景时间 `T`（`context.time`）。
 */
import { f32, lerp, mulBasis } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
import { snoise1, snoise2 } from "./noise";
import { PI } from "./noiseTables";
import type { ParticleRandom } from "./random";

const LIFE_MIN = f32(0.001);

/** 抽一个 `t`：`uA`，`exponent ≠ 1` 时取幂。 */
export function drawT(random: ParticleRandom, exponent: number): number {
  const t = random.a();
  return exponent === 1 ? t : f32(Math.pow(t, exponent));
}

/** `life = max(0.001, min + t·(max − min))`，绝对写入（两个 `lifetimerandom` 后写的生效，实测）。 */
export function lifetimeRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  const min = fields.min as number;
  const t = drawT(random, fields.exponent as number);
  columns.life[slot] = Math.max(LIFE_MIN, lerp(min, f32((fields.max as number) - min), t));
}

/** `size0 *= min + t·range`（`size0` 初值 0.5，所以 `sizerandom 40` 得 20）。 */
export function sizeRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  const min = fields.min as number;
  const t = drawT(random, fields.exponent as number);
  columns.size0[slot] = f32(columns.size0[slot] * lerp(min, f32((fields.max as number) - min), t));
}

/** `rgb0 *= min + t·range`，**三通道共用一个 `t`**（0–255 解析时已 ÷255）。 */
export function colorRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  const min = fields.min as number[];
  const max = fields.max as number[];
  const t = drawT(random, fields.exponent as number);
  for (let i = 0; i < 3; i++)
    columns.color0[i][slot] = f32(columns.color0[i][slot] * lerp(min[i], f32(max[i] - min[i]), t));
}

/**
 * `alpharandom`（initializer 6，`0x14023ba6f`，`rea-p4b-modules.md` B1【确】）：`a0 *= min + t·(max − min)`，`t = uA`
 * （`exponent ≠ 1` 时取幂），和 `sizerandom` 共用乘法尾巴（`0x14023b684`）。写的是 alpha **初值**列，不碰当前值列、不置
 * 列标志：当前值在出生时和每遍 operator 开头从初值复制，所以结果一样。用新抽的 `uA`，不用 `R`。
 */
export function alphaRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  const min = fields.min as number;
  const t = drawT(random, fields.exponent as number);
  columns.alpha0[slot] = f32(columns.alpha0[slot] * lerp(min, f32((fields.max as number) - min), t));
}

/**
 * 三轴独立，**抽取顺序 z、y、x**，`v += M·add`（`0x14023bac6`–`0x14023bc27`）：三个分量 `min + t·range` 写进栈上向量，
 * `FUN_140184440(out, M, add)`（`0x14023bbce`，`M` 是发射器传来的控制点 3×3，无条件，`mulBasis`）再逐分量加到速度上。
 * 控制点 0 无旋转时 `M` 是单位阵，乘上是精确的。
 */
export function velocityRandom(fields: ParticleFields, { columns, random, slot, basis }: ParticleRunContext): void {
  const min = fields.min as number[];
  const max = fields.max as number[];
  const exponent = fields.exponent as number;
  const t = [0, 0, 0];
  for (const axis of [2, 1, 0]) t[axis] = drawT(random, exponent);
  const add = mulBasis(
    basis,
    t.map((value, i) => lerp(min[i], f32(max[i] - min[i]), value)),
  );
  for (let i = 0; i < 3; i++) columns.velocity[i][slot] = f32(add[i] + columns.velocity[i][slot]);
}

/** 三轴独立，顺序 x、y、z，加到每个轴（`rotationrandom` 置列标志 bit0，三个轴是三列）。 */
function addPerAxis(target: readonly Float32Array[], fields: ParticleFields, random: ParticleRandom, slot: number) {
  const min = fields.min as number[];
  const max = fields.max as number[];
  const exponent = fields.exponent as number;
  for (let i = 0; i < 3; i++) {
    const t = drawT(random, exponent);
    target[i][slot] = f32(target[i][slot] + lerp(min[i], f32(max[i] - min[i]), t));
  }
}

/**
 * `turbulentvelocityrandom`（initializer 9，`0x14023bdbc`，`rea-p4b-modules.md` B2【确】）：方向只由出生时刻（场景时间 `T`）的
 * 一维噪声决定，同一时刻出生、`phasemin = phasemax` 的粒子方向完全相同。
 * ```
 * u1  = uA                                            （相位，先抽）
 * t   = ((u1·(phasemax − phasemin) + phasemin) + T)·timescale   （timescale 已乘 instanceoverride.rate）
 * ang = ((snoise1(t)·π)·scale) + offset               （π = 0x40490fdb）
 * dir = mat3(glm::rotate(I, ang, normalize(right)))·forward      （forward 不归一化）
 * u2  = uA                                            （速度，后抽）
 * v  += M·(dir·(u2·(speedmax − speedmin) + speedmin))  （speedmin / max 已乘 instanceoverride.speed；M 见下）
 * ```
 * - `glm::rotate`（`FUN_1401e2500`，`ignore/p4/rea/p4b-mod/rotate.asm`）：`a = right·(1/sqrtss((x² + y²) + z²))`，
 *   `temp = (1 − c)·a`，`R[i][i] = a_i·temp_i + c`，`R[0][1] = a1·temp0 + a2·s` 等（下面逐项照抄）；单位阵左乘是精确的，省掉。
 *   `cosf` / `sinf` 是 CRT 实现（`FUN_14041a2e0` / `FUN_14041a9c0`，没读），这里 `Math.cos` / `Math.sin` 再舍入，可能差 1 ulp。
 * - `mat3·v`（`FUN_140184440`）：`x = (v.y·m10 + v.x·m00) + v.z·m20`、`y = (v.x·m01 + v.y·m11) + v.z·m21`、
 *   `z = (v.x·m02 + v.y·m12) + v.z·m22`，`mij` 是第 i 列第 j 个分量。
 * - `M` 是发射器的控制点 3×3（`context.basis`，无条件，`0x14023bec7` 起第二次 `FUN_140184440` 的 `rdx = r15`），乘法同上
 *   （`mulBasis`）；控制点 0 无旋转时是单位阵，乘上是精确的。
 * - 不用 `R`，不置列标志，没有 blend。`audioprocessing*`（乘相位范围）属 P4e，能力表照报。
 */
export function turbulentVelocityRandom(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, random, slot, time } = context;
  const phaseMin = fields.phasemin as number;
  const phaseRange = f32((fields.phasemax as number) - phaseMin);
  const u1 = random.a();
  const t = f32(f32(f32(f32(u1 * phaseRange) + phaseMin) + time) * (fields.timescale as number));
  const angle = f32(f32(f32(snoise1(t) * PI) * (fields.scale as number)) + (fields.offset as number));
  const [rx, ry, rz] = fields.right as number[];
  const inverse = f32(1 / f32(Math.sqrt(f32(f32(f32(rx * rx) + f32(ry * ry)) + f32(rz * rz)))));
  const ax = f32(rx * inverse);
  const ay = f32(ry * inverse);
  const az = f32(rz * inverse);
  const c = f32(Math.cos(angle));
  const s = f32(Math.sin(angle));
  const oneMinusC = f32(1 - c);
  const temp0 = f32(ax * oneMinusC);
  const temp1 = f32(ay * oneMinusC);
  const temp2 = f32(az * oneMinusC);
  // 第 i 列（R[i][0..2]）
  const r00 = f32(f32(ax * temp0) + c);
  const r01 = f32(f32(ay * temp0) + f32(az * s));
  const r02 = f32(f32(az * temp0) - f32(ay * s));
  const r10 = f32(f32(ax * temp1) - f32(az * s));
  const r11 = f32(f32(ay * temp1) + c);
  const r12 = f32(f32(az * temp1) + f32(ax * s));
  const r20 = f32(f32(ax * temp2) + f32(ay * s));
  const r21 = f32(f32(ay * temp2) - f32(ax * s));
  const r22 = f32(f32(az * temp2) + c);
  const [fx, fy, fz] = fields.forward as number[];
  const dx = f32(f32(f32(fy * r10) + f32(fx * r00)) + f32(fz * r20));
  const dy = f32(f32(f32(fx * r01) + f32(fy * r11)) + f32(fz * r21));
  const dz = f32(f32(f32(fx * r02) + f32(fy * r12)) + f32(fz * r22));
  const speedMin = fields.speedmin as number;
  const speed = lerp(speedMin, f32((fields.speedmax as number) - speedMin), random.a());
  const add = mulBasis(context.basis, [f32(dx * speed), f32(dy * speed), f32(dz * speed)]);
  const { velocity } = columns;
  velocity[0][slot] = f32(add[0] + velocity[0][slot]);
  velocity[1][slot] = f32(add[1] + velocity[1][slot]);
  velocity[2][slot] = f32(add[2] + velocity[2][slot]);
}

/** `positionoffsetrandom` 启用 `sign` 的门限：`|sign|² > 1.19e-7`（FLT_EPSILON，`0x1401c93ac`，B3）。 */
const SIGN_EPSILON = 2 ** -23;

/**
 * fbm（B3）：`f = 1, a = 1`，重复 `octaves` 次 `n = noise(f)`、`sum += n·a`、`norm += a`、`a = a·0.5`、`f = f + f`，结果
 * `sum / norm`（`divss`）。`octaves` 解析期已钳到 [1, 8]。
 */
function fbm(octaves: number, noise: (frequency: number) => number): number {
  let frequency = 1;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const n = f32(noise(frequency) * amplitude);
    norm = f32(norm + amplitude);
    amplitude = f32(amplitude * 0.5);
    frequency = f32(frequency + frequency);
    sum = f32(sum + n);
  }
  return f32(sum / norm);
}

/**
 * `positionoffsetrandom`（initializer 11，`0x14023c09a`，`rea-p4b-modules.md` B3【确】）：完全确定，不用 `R`、不抽随机数。
 * ```
 * Ts = timescale·T                                    （timescale 不乘 instanceoverride.rate）
 * (px, py, pz) = 当前位置                             （发射器与排在前面的 initializer 已写，所以 JSON 顺序有影响）
 * X = fbm(f ↦ snoise2(f·(px·scale), f·Ts))
 * Y = fbm(f ↦ snoise2(f·Ts, f·(py·scale)))            （参数顺序和 X 相反）
 * Z = fbm(f ↦ snoise2(f·(pz·scale), f·(−Ts)))         （时间取负）
 * o = (X·directions.x, Y·directions.y, Z·directions.z)
 * |sign|² > 1.19e-7 时：o_i = |o_i|·sign_i + o_i·(1 − |sign_i|)
 * pos_i = o_i·distance + p_i
 * ```
 * `sign` 的 ±1 强制该轴符号，0 不变，中间值是两者线性混合。没有覆盖项、没有音频、不置标志。
 */
export function positionOffsetRandom(fields: ParticleFields, { columns, slot, time }: ParticleRunContext): void {
  const { position } = columns;
  const px = position[0][slot];
  const py = position[1][slot];
  const pz = position[2][slot];
  const scale = fields.scale as number;
  const octaves = fields.octaves as number;
  const ts = f32((fields.timescale as number) * time);
  const sx = f32(px * scale);
  const sy = f32(py * scale);
  const sz = f32(pz * scale);
  const negative = -ts;
  const directions = fields.directions as number[];
  const offset = [
    f32(fbm(octaves, (f) => snoise2(f32(f * sx), f32(f * ts))) * directions[0]),
    f32(fbm(octaves, (f) => snoise2(f32(f * ts), f32(f * sy))) * directions[1]),
    f32(fbm(octaves, (f) => snoise2(f32(f * sz), f32(f * negative))) * directions[2]),
  ];
  const sign = fields.sign as number[];
  if (f32(f32(f32(sign[0] * sign[0]) + f32(sign[1] * sign[1])) + f32(sign[2] * sign[2])) > SIGN_EPSILON)
    for (let i = 0; i < 3; i++)
      offset[i] = f32(f32(Math.abs(offset[i]) * sign[i]) + f32(offset[i] * f32(1 - Math.abs(sign[i]))));
  const distance = fields.distance as number;
  for (let i = 0; i < 3; i++) position[i][slot] = f32(f32(offset[i] * distance) + position[i][slot]);
}

/** `rot[i] += min + t·range`，三轴独立，顺序 x、y、z。 */
export function rotationRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  addPerAxis(columns.rotation, fields, random, slot);
}

/** 同 `rotationrandom`，加到角速度（置列标志 bit1）。 */
export function angularVelocityRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  if (columns.angularVelocity) addPerAxis(columns.angularVelocity, fields, random, slot);
}
