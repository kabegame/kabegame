/**
 * initializer（P4a 步骤 3、P4b 步骤 3）。依据 `rea-p4a.md` B「initializer」、`rea-p4b-modules.md` B1（读码【确】）。
 *
 * 模拟器给新粒子先抽 `R = uA`、写缺省值，再按 JSON 顺序调这里的函数。每个函数的 `t` 都是 `uA`，`exponent ≠ 1` 时
 * `t = pow(t, exponent)`（`powf` 是推断）。min / max 已乘 `instanceoverride`（`resolveParticleFields`）。
 */
import { f32, lerp } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
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

/** 三轴独立，**抽取顺序 z、y、x**，经控制点矩阵（P4a 为单位阵）后加到速度。 */
export function velocityRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  const min = fields.min as number[];
  const max = fields.max as number[];
  const exponent = fields.exponent as number;
  const t = [0, 0, 0];
  for (const axis of [2, 1, 0]) t[axis] = drawT(random, exponent);
  for (let i = 0; i < 3; i++)
    columns.velocity[i][slot] = f32(columns.velocity[i][slot] + lerp(min[i], f32(max[i] - min[i]), t[i]));
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

/** `rot[i] += min + t·range`，三轴独立，顺序 x、y、z。 */
export function rotationRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  addPerAxis(columns.rotation, fields, random, slot);
}

/** 同 `rotationrandom`，加到角速度（置列标志 bit1）。 */
export function angularVelocityRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  if (columns.angularVelocity) addPerAxis(columns.angularVelocity, fields, random, slot);
}
