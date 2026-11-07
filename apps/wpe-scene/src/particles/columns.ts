/**
 * 粒子列（P4a 步骤 3）：定长 float32 列加标志开关，照 WPE 的形状（`rea-framework.md` Q5，`p4-particles-REPORT.md` F1 与
 * 「对 P4a 底座的要求」）：
 *
 * - 基础 17 列：age、life（0 表示空槽）、frame、size、size0、旋转 x、位置 xyz、速度 xyz、颜色初始值 rgb、alpha 初始值、`R`；
 * - bit0 +2（旋转 y、z；没有时三个分量别名到同一列）、bit1 +3（角速度）、bit2 +3（上一步位置）、bit3 +3（颜色当前值；
 *   没有时别名到初始值列）、bit4 +1（alpha 当前值；没有时别名到初始值列）。
 *
 * 别名的效果：没有 bit3 时「每遍开头把 rgb 重置为初始值」是空操作，乘性模块直接写在初始值列上（WPE 同样如此）。
 * 容量 `maxcount` 向上取到 4 的倍数分配（WPE 按 4 个一组 SIMD），有效容量仍是 `maxcount`。全部列放在一块缓冲里。
 */
import { COLUMN_FLAGS } from "./modules";

export type Vec3Columns = readonly [Float32Array, Float32Array, Float32Array];

/** 基础列数与每个标志加的列数。 */
export const BASE_COLUMNS = 17;
const FLAG_COLUMNS: readonly [number, number][] = [
  [COLUMN_FLAGS.rotationYZ, 2],
  [COLUMN_FLAGS.angularVelocity, 3],
  [COLUMN_FLAGS.previousPosition, 3],
  [COLUMN_FLAGS.color, 3],
  [COLUMN_FLAGS.alpha, 1],
];

export function columnCount(flags: number): number {
  return FLAG_COLUMNS.reduce((count, [bit, extra]) => count + (flags & bit ? extra : 0), BASE_COLUMNS);
}

/** `maxcount` 向上取到 4 的倍数。 */
export function allocatedCount(maxcount: number): number {
  return Math.ceil(Math.max(0, maxcount) / 4) * 4;
}

export class ParticleColumns {
  /** 有效容量（`maxcount`）。 */
  readonly capacity: number;
  /** 每列的长度：容量向上取到 4 的倍数。 */
  readonly allocated: number;
  /** 列标志（`COLUMN_FLAGS` 按位或）。 */
  readonly flags: number;
  readonly buffer: Float32Array;

  readonly age: Float32Array;
  /** 寿命；0 表示空槽。 */
  readonly life: Float32Array;
  readonly frame: Float32Array;
  /** 当前尺寸：每遍 operator 开头从 `size0` 复制。 */
  readonly size: Float32Array;
  readonly size0: Float32Array;
  /** 没有 bit0 时三个分量是同一列。 */
  readonly rotation: Vec3Columns;
  /** bit1。 */
  readonly angularVelocity: Vec3Columns | null;
  readonly position: Vec3Columns;
  readonly velocity: Vec3Columns;
  /** bit2。 */
  readonly previousPosition: Vec3Columns | null;
  /** 颜色当前值；没有 bit3 时就是 `color0`。 */
  readonly color: Vec3Columns;
  /** alpha 当前值；没有 bit4 时就是 `alpha0`。 */
  readonly alpha: Float32Array;
  readonly color0: Vec3Columns;
  readonly alpha0: Float32Array;
  /** 每粒子随机数 `R`：各模块共用（F2）。 */
  readonly random: Float32Array;

  constructor(maxcount: number, flags: number) {
    this.capacity = Math.max(0, Math.trunc(maxcount));
    this.allocated = allocatedCount(this.capacity);
    this.flags = flags;
    const n = this.allocated;
    this.buffer = new Float32Array(columnCount(flags) * n);
    let next = 0;
    const column = () => this.buffer.subarray(n * next, n * ++next);
    const vec3 = (): Vec3Columns => [column(), column(), column()];
    this.age = column();
    this.life = column();
    this.frame = column();
    this.size = column();
    this.size0 = column();
    const rotationX = column();
    this.rotation =
      flags & COLUMN_FLAGS.rotationYZ ? [rotationX, column(), column()] : [rotationX, rotationX, rotationX];
    this.angularVelocity = flags & COLUMN_FLAGS.angularVelocity ? vec3() : null;
    this.position = vec3();
    this.velocity = vec3();
    this.previousPosition = flags & COLUMN_FLAGS.previousPosition ? vec3() : null;
    this.color0 = vec3();
    this.alpha0 = column();
    this.color = flags & COLUMN_FLAGS.color ? vec3() : this.color0;
    this.alpha = flags & COLUMN_FLAGS.alpha ? column() : this.alpha0;
    this.random = column();
  }

  /** 每遍 operator 开头：`size ← size0`，有对应列时 `rgb ← rgb0`、`a ← a0`（Q1，`0x14023fc08` 起）。 */
  resetCurrent(count: number): void {
    this.size.set(this.size0.subarray(0, count));
    if (this.color !== this.color0) for (let i = 0; i < 3; i++) this.color[i].set(this.color0[i].subarray(0, count));
    if (this.alpha !== this.alpha0) this.alpha.set(this.alpha0.subarray(0, count));
  }

  /** 清空全部槽（life 置 0）。 */
  clear(): void {
    this.buffer.fill(0);
  }
}
