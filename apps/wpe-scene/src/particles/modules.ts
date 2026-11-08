/**
 * 粒子模块表（P4a 步骤 2）：每个模块一条记录，是模块的**唯一事实来源**。
 *
 * - `compile/particles.ts` 按它把粒子 JSON 解析成纯数据（字段、缺省值、正交 / 透视两套）；
 * - `compile/features.ts` 按它生成能力表：表外模块报 `particle:<类别>:<名字>`，未知字段、本节不支持的取值报
 *   `particle:<类别>:<名字>:<字段>`，写成 `{user}` / `{script}` 的报 `particle:binding:<类别>:<名字>:<字段>`；
 * - 模拟器（`system.ts`，步骤 3）按 `columnFlags` 开列，按 `run` 执行（emitter 写新粒子的位置速度、initializer 写初值、
 *   operator 跑一遍），按字段的 `instance` 乘 `instanceoverride`。没有 `run` 的模块（表外模块、renderer）模拟器跳过。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4a.md` B 节、`rea-p4b-modules.md` A、B 节（WPE 2.8.42 读码【确】），
 * 列与标志见 `p4-particles-REPORT.md`「对 P4a 底座的要求」。公式不在这里重抄，见各执行函数。
 *
 * 不在表里的字段一律按未知报：包括 `audioprocessing*`（属 P4e；`boxrandom`、`vortex` 等模块带这组键，`rea-p4b-modules.md` D）。
 */
import { isKeyframedValue, isScriptValue, isUserBinding } from "../compile/bindings";
import type { ParticleColumns } from "./columns";
import { boxRandom, sphereRandom } from "./emitters";
import { f32 } from "./f32";
import {
  alphaRandom,
  angularVelocityRandom,
  colorRandom,
  lifetimeRandom,
  positionOffsetRandom,
  rotationRandom,
  sizeRandom,
  turbulentVelocityRandom,
  velocityRandom,
} from "./initializers";
import {
  alphaChange,
  alphaFade,
  angularMovement,
  capVelocity,
  colorChange,
  movement,
  oscillateAlpha,
  oscillatePosition,
  oscillateSize,
  sizeChange,
  turbulence,
  vortex,
} from "./operators";
import type { ParticleRandom } from "./random";

export type ParticleCategory = "emitter" | "initializer" | "operator" | "renderer";
/** JSON 里的数组键与类别同名（`emitter`、`initializer`、`operator`、`renderer`）。 */
export const PARTICLE_CATEGORIES: readonly ParticleCategory[] = ["emitter", "initializer", "operator", "renderer"];

/** 解析后的字段值：标量、向量（数字数组）或字符串。 */
export type ParticleFieldValue = number | number[] | string;

/**
 * 字段的 JSON 形状：
 * - `number`：标量，只认 JSON 数字；
 * - `int`：整数（位标志、下标），只认 JSON 数字，取整；
 * - `vec3`：`"x y z"` 字符串，少写的分量为 0、多写的忽略；写成数字时没读到 WPE 的处理，按不支持报；
 * - `vec3z`：同 `vec3`，写成数字时只作用于 z，x、y 保持缺省（`rotationrandom` 的 `min` / `max`，B【确】）；
 * - `vec3str`：同 `vec3`，只接受字符串，写成数字时保持缺省、不报（`angularvelocityrandom` 的 `min` / `max`，B【确】）；
 * - `string`：字符串。
 */
export type ParticleFieldType = "number" | "int" | "vec3" | "vec3z" | "vec3str" | "string";

/** JSON 单位的缺省值（未换算）。两套时按场景是否正交选（`rea-p4a.md`「基础」）。 */
export type ParticleFieldDefault =
  ParticleFieldValue | { orthographic: ParticleFieldValue; perspective: ParticleFieldValue };

export interface ParticleFieldDef {
  type: ParticleFieldType;
  default: ParticleFieldDefault;
  /** 解析时乘的系数（`colorrandom` 的 0–255 ÷255），缺省值同样换算。 */
  scale?: number;
  /**
   * 本节支持的取值；缺省为全部支持。只对 JSON 里写了的字段判断（缺省值总是支持的）。参数是解析后的值，以及同一模块
   * 全部字段的解析值（周期发射的字段要看 `flags`）。返回 false 时报 `particle:<类别>:<名字>:<字段>`。
   */
  supported?: (value: ParticleFieldValue, fields: Readonly<Record<string, ParticleFieldValue>>) => boolean;
  /** 乘哪一项 `instanceoverride`（`rea-p4a.md` C5）；系统 `flags` 的对应位禁用时不乘（C3，`rate` 没有禁用位）。 */
  instance?: InstanceScale;
  /**
   * 乘完 `instanceoverride` 再截断成整数（条目类型 1：`int(f32(value)·o)`，`rea-p4b-modules.md`「`instanceoverride` 写回的
   * 条目类型」）。只有 `maxtoemitperperiod`。
   */
  truncate?: boolean;
}

/**
 * 乘到模块字段上的 `instanceoverride` 项（C5）。`alpha` 不乘字段，由模拟器自己用；`rate` 除了作模拟的时间缩放（模拟器自己用），
 * 还乘 `turbulence`、`turbulentvelocityrandom` 的 `timescale`（条目类型 2，`rea-p4b-modules.md`「`instanceoverride` 写回的条目类型」）。
 */
export type InstanceScale = "size" | "speed" | "count" | "lifetime" | "rate";
/**
 * 系统 `flags` 里禁用对应 `instanceoverride` 的位（C3【确】）：bit4 speed、bit5 count、bit6 lifetime、bit7 size。`rate` 的条目
 * 无条件登记（同上节），没有禁用位。
 */
export const INSTANCE_DISABLE_FLAGS: Readonly<Record<InstanceScale, number>> = {
  speed: 0x10,
  count: 0x20,
  lifetime: 0x40,
  size: 0x80,
  rate: 0,
};

/**
 * 粒子列（报告 F1：定长 float 列）。`random` 是共用的每粒子随机数 `R`；`color` / `alpha` 是当前值，`color0` / `alpha0`
 * 是初始值；`previousPosition` 只在列标志 bit2 时存在。
 */
export type ParticleColumn =
  | "age"
  | "life"
  | "frame"
  | "size"
  | "size0"
  | "rotation"
  | "angularVelocity"
  | "position"
  | "velocity"
  | "previousPosition"
  | "color"
  | "alpha"
  | "color0"
  | "alpha0"
  | "random";

/**
 * 按标志开关的列组（报告「标志来源」）：模块置位后这些列才单独分配，否则别名到基础列
 * （没有 bit3 时颜色当前值就是初始值列，重置是空操作）。
 */
export const COLUMN_FLAGS = {
  /** 旋转 y、z（没有时别名到 x）。 */
  rotationYZ: 1,
  angularVelocity: 2,
  previousPosition: 4,
  /** 颜色当前值。 */
  color: 8,
  /** alpha 当前值。 */
  alpha: 16,
} as const;

/** 模拟时的字段：已乘 `instanceoverride`、数值已舍入成 float32（`resolveParticleFields`）。 */
export type ParticleFields = Readonly<Record<string, ParticleFieldValue>>;

/** 执行函数的上下文。模拟器复用同一个对象，按类别填对应的项。 */
export interface ParticleRunContext {
  columns: ParticleColumns;
  random: ParticleRandom;
  /** emitter / initializer：新粒子的槽。 */
  slot: number;
  /** operator：处理 `[0, count)` 的槽（高水位；死槽照常处理，写顶点时跳过，同 WPE）。 */
  count: number;
  /** operator 这一遍的步长（两遍模式时是 dt/2）。 */
  h: number;
  /** operator 这一遍的 drag 系数 k（两遍模式时是 k0/2）。 */
  k: number;
  /**
   * 场景时间 `T`（float32，P4b 步骤 4）：`ctx+0x130`，和着色器的 `g_Time` 同源（`rea-p4b-modules.md`「命名」【推】）——钳过的
   * 帧时间累加、超过 432000 回绕。一帧内各模块读同一个值（本帧的 `g_Time`）；预热时为 0（B2 末条，实测确认）。噪声类模块用。
   */
  time: number;
}

/**
 * 执行函数：
 * - emitter：给 `slot` 写位置、速度（发射数量是 emitter 共有的逻辑，在 `emitters.ts` 的 `emissionCount`）；
 * - initializer：给 `slot` 写初值（`R` 与缺省值已由模拟器写好）；
 * - operator：对 `[0, count)` 跑一遍，步长 `h`、drag 系数 `k`。
 */
export type ParticleModuleRun = (fields: ParticleFields, context: ParticleRunContext) => void;

export interface ParticleModuleDef {
  category: ParticleCategory;
  name: string;
  /** 字段表：字段名 → 形状、缺省值、本节支持的取值。`name`、`id` 是结构键，不在这里。 */
  fields: Readonly<Record<string, ParticleFieldDef>>;
  /** 读写的列（步骤 3 开列用）。 */
  columns: readonly ParticleColumn[];
  /** 置的列标志（`COLUMN_FLAGS` 按位或）。 */
  columnFlags: number;
  /** 字段全部读完后的修正（WPE 解析期的副作用，如 `sign` 非零时置 `flags` bit0）。 */
  normalize?: (fields: Record<string, ParticleFieldValue>) => void;
  run: ParticleModuleRun | null;
}

const num = (value: ParticleFieldDefault, supported?: ParticleFieldDef["supported"]): ParticleFieldDef => ({
  type: "number",
  default: value,
  supported,
});
const int = (value: number, supported?: ParticleFieldDef["supported"]): ParticleFieldDef => ({
  type: "int",
  default: value,
  supported,
});
const vec3 = (value: ParticleFieldDefault, type: "vec3" | "vec3z" | "vec3str" = "vec3"): ParticleFieldDef => ({
  type,
  default: value,
});
/** 字段乘 `instanceoverride` 的哪一项（C5）。 */
const by = (instance: InstanceScale, def: ParticleFieldDef): ParticleFieldDef => ({ ...def, instance });
const zeroOnly = (value: ParticleFieldValue) => value === 0;
const TWO_PI = 2 * Math.PI;

/**
 * emitter 共有的发射字段（`FUN_1401c1c70` 解析、`FUN_1401b8df0` 缺省，`rea-p4b-modules.md` A0【确】），`sphererandom` 与
 * `boxrandom` 共用；数量逻辑见 `emitters.ts` 的 `emissionCount`（A1–A3，实测核对过）。
 */
const EMITTER_FIELDS: Record<string, ParticleFieldDef> = {
  // 乘 `count`（条目类型 2，不截断）
  rate: by("count", num(10)),
  // 帧尾倒数（A2）；JSON 写负值时只发 `instantaneous`（A1 的 `duration < 0` 分支）
  duration: num(0),
  delay: num(0),
  // 从累积余数里扣，之后要还债；不乘 `count`（两条都实测核对过）
  instantaneous: num(0),
  // bit0 用 `sign`（只有 `sphererandom` 读，`sign` 非零时自动置位），bit1 每帧至多 1 个，bit2 周期发射；其余位
  // （bit31 是内部的「已结束」）没读到含义
  flags: int(0, (value) => (Number(value) & ~7) === 0),
  minperiodicduration: num(2),
  maxperiodicduration: num(3),
  minperiodicdelay: num(1),
  maxperiodicdelay: num(2),
  // 乘 `count` 后截断成整数（条目类型 1；实测 `count 2`、`instantaneous 3`、本值 4 时每周期 3 + 8 = 11 个）
  maxtoemitperperiod: { ...by("count", num(0)), truncate: true },
};

/** 解析期的周期字段修正（A0）：`min = min(min, max)`，时长、间歇各一对。 */
function normalizeEmitter(fields: Record<string, ParticleFieldValue>): void {
  for (const kind of ["duration", "delay"]) {
    const min = fields[`minperiodic${kind}`] as number;
    const max = fields[`maxperiodic${kind}`] as number;
    fields[`minperiodic${kind}`] = Math.min(min, max);
  }
}

/**
 * 共用 blend 的四个键（B「operator」【确】）。解析期的修正（`is ≤ ie−0.0001`、`oe ≥ os+0.0001`）与「参数实质非默认才切到带
 * blend 的记录」由步骤 3 做，这里存 JSON 原值。
 */
const BLEND: Record<string, ParticleFieldDef> = {
  blendinstart: num(0),
  blendinend: num(0),
  blendoutstart: num(1),
  blendoutend: num(1),
};

/**
 * `positionoffsetrandom` 的 `octaves` 解析期钳制（`0x1401c9387`，`rea-p4b-modules.md` B3【确】）：按**无符号**比较，`≥ 8` 得 8
 * （负数当很大的无符号数，也是 8），`0` 得 1。
 */
export function clampOctaves(value: number): number {
  const octaves = value >>> 0;
  return octaves >= 8 ? 8 : octaves < 1 ? 1 : octaves;
}

/**
 * 档 1 的 12 个模块、P4b 步骤 3 的 8 个（emitter `boxrandom`，initializer `alpharandom`，operator `sizechange`、`alphachange`、
 * `colorchange`、`oscillatesize`、`vortex`、`capvelocity`）、步骤 4 的 3 个噪声类模块（initializer `turbulentvelocityrandom`、
 * `positionoffsetrandom`，operator `turbulence`），加 renderer `sprite`。
 */
export const PARTICLE_MODULES: readonly ParticleModuleDef[] = [
  {
    // `FUN_1401b9100` 缺省值；发射数量 `FUN_1402378a0`
    category: "emitter",
    name: "sphererandom",
    fields: {
      origin: vec3("0 0 0"),
      directions: vec3("1 1 0"),
      sign: vec3("0 0 0"),
      distancemin: num(0),
      distancemax: num({ orthographic: 256, perspective: 1 }),
      speedmin: by("speed", num(0)),
      speedmax: by("speed", num(0)),
      // 控制点（上限 7）属 P4c：非 0 时发射位置过控制点矩阵
      controlpoint: int(0, zeroOnly),
      cone: num(0),
      ...EMITTER_FIELDS,
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      if ((fields.sign as number[]).some((value) => value !== 0)) fields.flags = Number(fields.flags) | 1;
      normalizeEmitter(fields);
    },
    run: sphereRandom,
  },
  {
    // `FUN_1401b9520` 缺省值（含公共 `FUN_1401b8df0`），解析 `0x1401c6390`，`rea-p4b-modules.md` A4。没有 `sign`、`cone`
    category: "emitter",
    name: "boxrandom",
    fields: {
      origin: vec3("0 0 0"),
      directions: vec3({ orthographic: "1 1 0", perspective: "1 1 1" }),
      // 两个距离是**向量**（每轴独立），只接受字符串
      distancemin: vec3("0 0 0"),
      distancemax: vec3({ orthographic: "256 256 0", perspective: "1 1 1" }),
      // 乘 `speed`（条目类型 6）
      speedmin: by("speed", num(0)),
      speedmax: by("speed", num(0)),
      // 控制点（上限 7）属 P4c：非 0 时出生位置和速度方向过控制点矩阵
      controlpoint: int(0, zeroOnly),
      ...EMITTER_FIELDS,
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize: normalizeEmitter,
    run: boxRandom,
  },
  {
    // 绝对写入 `life = max(0.001, …)`
    category: "initializer",
    name: "lifetimerandom",
    fields: { min: by("lifetime", num(0)), max: by("lifetime", num(1)), exponent: num(1) },
    columns: ["life"],
    columnFlags: 0,
    run: lifetimeRandom,
  },
  {
    // 乘到 `size0`（初值 0.5）
    category: "initializer",
    name: "sizerandom",
    fields: {
      min: by("size", num({ orthographic: 5, perspective: 0.001 })),
      max: by("size", num({ orthographic: 50, perspective: 1 })),
      exponent: num(1),
    },
    columns: ["size0"],
    columnFlags: 0,
    run: sizeRandom,
  },
  {
    // 三通道共用一个 t；0–255 解析时 ÷255
    category: "initializer",
    name: "colorrandom",
    fields: {
      min: { type: "vec3", default: "0 0 0", scale: 1 / 255 },
      max: { type: "vec3", default: "255 255 255", scale: 1 / 255 },
      exponent: num(1),
    },
    columns: ["color0"],
    columnFlags: 0,
    run: colorRandom,
  },
  {
    // 三轴独立，抽取顺序 z、y、x，经控制点矩阵后加到速度
    category: "initializer",
    name: "velocityrandom",
    fields: {
      min: by("speed", vec3({ orthographic: "-32 -32 0", perspective: "-1 -1 -1" })),
      max: by("speed", vec3({ orthographic: "32 32 0", perspective: "1 1 1" })),
      exponent: num(1),
    },
    columns: ["velocity"],
    columnFlags: 0,
    run: velocityRandom,
  },
  {
    // 三轴独立，顺序 x、y、z，加到旋转
    category: "initializer",
    name: "rotationrandom",
    fields: {
      min: vec3("0 0 0", "vec3z"),
      max: vec3("0 0 6.28318530717", "vec3z"),
      exponent: num(1),
    },
    columns: ["rotation"],
    columnFlags: COLUMN_FLAGS.rotationYZ,
    run: rotationRandom,
  },
  {
    category: "initializer",
    name: "angularvelocityrandom",
    fields: {
      min: by("speed", vec3("0 0 -5", "vec3str")),
      max: by("speed", vec3("0 0 5", "vec3str")),
      exponent: num(1),
    },
    columns: ["angularVelocity"],
    columnFlags: COLUMN_FLAGS.angularVelocity,
    run: angularVelocityRandom,
  },
  {
    // 乘到 alpha 初值（`rea-p4b-modules.md` B1）；缺省 `min` 是 float `0x3d4ccccd`，两套相同，没有覆盖项
    category: "initializer",
    name: "alpharandom",
    fields: { min: num(0.05), max: num(1), exponent: num(1) },
    columns: ["alpha0"],
    columnFlags: 0,
    run: alphaRandom,
  },
  {
    // `rea-p4b-modules.md` B2（initializer 9，缺省值 `FUN_1401bb030`，执行 `0x14023bdbc`）：方向由出生时刻的一维噪声决定，
    // 速度**加**上去。`audioprocessing*`（乘相位范围，D）属 P4e，表外照报
    category: "initializer",
    name: "turbulentvelocityrandom",
    fields: {
      // 乘 `speed`（条目类型 6）
      speedmin: by("speed", num({ orthographic: 100, perspective: 0.5 })),
      speedmax: by("speed", num({ orthographic: 250, perspective: 1 })),
      phasemin: num(0),
      phasemax: num(0.1),
      // 乘 `rate`（条目类型 2，无条件登记，不受系统 `flags` 禁用位影响）
      timescale: by("rate", num(1)),
      scale: num(1),
      // 弧度，加在角度上
      offset: num(0),
      // 两个向量只接受字符串（写成数字 WPE 会把它当指针用，B「向量字段」，报不支持）；`forward` 不归一化，`right` 执行时归一化
      forward: vec3("0 1 0"),
      right: vec3("0 0 1"),
      // WPE 不读 `up`（解析段 `0x1401c8748` 起只读 scale、timescale、offset、phasemin/max、speedmin/max、forward、right），
      // 中性：登记成不参与计算的字段，免得按表外字段报（语料 2 张写了 "0.2 0.2 0"）
      up: vec3("0 0 0", "vec3str"),
    },
    columns: ["velocity"],
    columnFlags: 0,
    run: turbulentVelocityRandom,
  },
  {
    // `rea-p4b-modules.md` B3（initializer 11，缺省值 `FUN_1401bb660`，解析 `0x1401c903a`，执行 `0x14023c09a`）：完全确定，
    // 不抽随机数。没有覆盖项、没有音频
    category: "initializer",
    name: "positionoffsetrandom",
    fields: {
      directions: vec3({ orthographic: "1 1 0", perspective: "1 1 1" }),
      // `|sign|² > 1.19e-7` 时才做符号处理（解析期置 p+0x28 bit0，执行函数现算）
      sign: vec3("0 0 0"),
      scale: num({ orthographic: 0.001, perspective: 1 }),
      distance: num({ orthographic: 100, perspective: 0.1 }),
      // **不乘** `instanceoverride.rate`
      timescale: num(1),
      // 解析期钳到 [1, 8]（`normalize`）
      octaves: int(6),
    },
    columns: ["position"],
    columnFlags: 0,
    normalize(fields) {
      fields.octaves = clampOctaves(fields.octaves as number);
    },
    run: positionOffsetRandom,
  },
  {
    // 半隐式欧拉，drag 按 k0 衰减（实测核对过）。`previousPosition` 只在列标志 bit2 时开头拷一次
    category: "operator",
    name: "movement",
    fields: {
      gravity: by("speed", vec3("0 0 0")),
      drag: num(0),
      // bit0：系统非世界空间时重力按模型矩阵转置变换，没实测
      flags: int(0, zeroOnly),
    },
    columns: ["position", "velocity", "previousPosition"],
    columnFlags: 0,
    run: movement,
  },
  {
    category: "operator",
    name: "angularmovement",
    fields: { force: by("speed", vec3("0 0 0")), drag: num(0), ...BLEND },
    columns: ["age", "life", "rotation", "angularVelocity"],
    columnFlags: COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.angularVelocity,
    run: angularMovement,
  },
  {
    category: "operator",
    name: "alphafade",
    fields: { fadeintime: num(0.5), fadeouttime: num(0.5) },
    columns: ["age", "life", "alpha"],
    columnFlags: COLUMN_FLAGS.alpha,
    run: alphaFade,
  },
  {
    // ω 不乘 2π，相位加在时间上，y 多一个 2π·R（实测核对过 ω 与 y 偏移）
    category: "operator",
    name: "oscillateposition",
    fields: {
      mask: vec3("1 1 0"),
      frequencymin: by("speed", num(1)),
      frequencymax: by("speed", num(5)),
      scalemin: num(0),
      scalemax: num({ orthographic: 10, perspective: 0.5 }),
      phasemin: num(0),
      phasemax: num(TWO_PI),
      ...BLEND,
    },
    columns: ["age", "life", "random", "position"],
    columnFlags: 0,
    run: oscillatePosition,
  },
  {
    // 幅度里多乘一次 R
    category: "operator",
    name: "oscillatealpha",
    fields: {
      frequencymin: num(1),
      frequencymax: num(10),
      scalemin: num(0),
      scalemax: num(1),
      phasemin: num(0),
      phasemax: num(TWO_PI),
      ...BLEND,
    },
    columns: ["age", "life", "random", "alpha"],
    columnFlags: COLUMN_FLAGS.alpha,
    run: oscillateAlpha,
  },
  {
    // `rea-p4b-modules.md` B4：两个值都乘 `size`（条目类型 7，实测）；`t` 是生命比例
    category: "operator",
    name: "sizechange",
    fields: {
      startvalue: by("size", num(1)),
      endvalue: by("size", num(0)),
      starttime: num(0),
      endtime: num(1),
    },
    columns: ["age", "life", "size"],
    columnFlags: 0,
    run: sizeChange,
  },
  {
    category: "operator",
    name: "alphachange",
    fields: { startvalue: num(1), endvalue: num(0), starttime: num(0), endtime: num(1) },
    columns: ["age", "life", "alpha"],
    columnFlags: COLUMN_FLAGS.alpha,
    run: alphaChange,
  },
  {
    // 两个颜色是 0–1 的倍数（不 ÷255），只接受字符串
    category: "operator",
    name: "colorchange",
    fields: { startvalue: vec3("1 1 1"), endvalue: vec3("0 0 0"), starttime: num(0), endtime: num(1) },
    columns: ["age", "life", "color"],
    columnFlags: COLUMN_FLAGS.color,
    run: colorChange,
  },
  {
    // `rea-p4b-modules.md` B5：R 进 ω、相位、幅度三处；频率不乘 `speed`
    category: "operator",
    name: "oscillatesize",
    fields: {
      frequencymin: num(1),
      frequencymax: num(10),
      phasemin: num(0),
      phasemax: num(TWO_PI),
      scalemin: num(0.8),
      scalemax: num(1.2),
      ...BLEND,
    },
    columns: ["age", "life", "random", "size"],
    columnFlags: 0,
    run: oscillateSize,
  },
  {
    // `rea-p4b-modules.md` B7：乘 `k`；中心 = 控制点平移 + `offset`
    category: "operator",
    name: "vortex",
    fields: {
      offset: vec3("0 0 0"),
      axis: vec3("0 0 1"),
      distanceinner: num({ orthographic: 500, perspective: 1 }),
      distanceouter: num({ orthographic: 650, perspective: 2 }),
      // 乘 `speed`（条目类型 7）
      speedinner: by("speed", num({ orthographic: 2500, perspective: 1 })),
      speedouter: by("speed", num(0)),
      // bit0：柱形（按到轴线的距离）；其余位没读到含义
      flags: int(0, (value) => (Number(value) & ~1) === 0),
      // 控制点（上限 7）属 P4c：非 0 时中心取那个控制点的平移
      controlpoint: int(0, zeroOnly),
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    run: vortex,
  },
  {
    // `rea-p4b-modules.md` B6（operator 14，blend 0x24，缺省值 `FUN_1401beb80`，执行 `0x14024295a` / `0x140242d6e`）：乘 `k`；
    // 三维噪声场。`audioprocessing*`（乘速度，D）属 P4e，表外照报
    category: "operator",
    name: "turbulence",
    fields: {
      // 每轴非 0 才算这一轴，三轴全 0 时整个模块跳过；只接受字符串
      mask: vec3({ orthographic: "1 1 0", perspective: "1 1 1" }),
      scale: num({ orthographic: 0.01, perspective: 0.5 }),
      // 乘 `speed`（条目类型 7）
      speedmin: by("speed", num({ orthographic: 500, perspective: 1 })),
      speedmax: by("speed", num({ orthographic: 1000, perspective: 5 })),
      // 解析但执行时不读（只用 `phasemax − phasemin`，实测：`phasemin` 0 与 5 逐位相同）
      phasemin: num(0),
      phasemax: num(0),
      // 乘 `rate`（条目类型 2，无条件登记）
      timescale: by("rate", num({ orthographic: 20, perspective: 1 })),
      ...BLEND,
    },
    columns: ["age", "life", "random", "position", "velocity"],
    columnFlags: 0,
    run: turbulence,
  },
  {
    // `rea-p4b-modules.md` B8：`maxspeed` 没有覆盖项
    category: "operator",
    name: "capvelocity",
    fields: { maxspeed: num({ orthographic: 100, perspective: 1 }), ...BLEND },
    columns: ["age", "life", "velocity"],
    columnFlags: 0,
    run: capVelocity,
  },
  {
    // `FUN_1401c22e0`（trail、rope 共用）：缺省 `orientation "screen"`、`axis "0 0 0"`、`flags 0`。
    // 非 `screen` 朝向（upright = 1、fixed = 2）的几何没读；`axis`、`flags` 的作用没读
    category: "renderer",
    name: "sprite",
    fields: {
      orientation: { type: "string", default: "screen", supported: (value) => value === "screen" },
      axis: { type: "vec3", default: "0 0 0", supported: (value) => (value as number[]).every((v) => v === 0) },
      flags: int(0, zeroOnly),
    },
    // 写顶点：按槽序、跳过 `life == 0`
    columns: ["life", "position", "size", "rotation", "color", "alpha"],
    columnFlags: 0,
    run: null,
  },
];

const byKey = new Map(PARTICLE_MODULES.map((def) => [`${def.category}:${def.name}`, def]));

export function particleModuleDef(category: ParticleCategory, name: string): ParticleModuleDef | undefined {
  return byKey.get(`${category}:${name}`);
}

/** 解析后的一个模块。 */
export interface ParticleModule {
  name: string;
  /** JSON 的 `id`（编辑器用）；没有时为 null。 */
  id: number | null;
  /**
   * 字段表里每个字段的值：缺键已补缺省（按正交 / 透视选），向量是数字数组，`colorrandom` 已 ÷255。值是 double，
   * float32 舍入由模拟器做。表外模块为空对象（场景已因 `particle:<类别>:<名字>` 退回）。
   */
  fields: Record<string, ParticleFieldValue>;
}

export interface ParticleModuleIssue {
  field: string;
  /**
   * `unknown` 表外字段；`value` 形状不对或本节不支持的取值；`binding` 写成 `{user}` / `{script}`；`animation` 写成属性
   * 关键帧 `{animation: {…}, value}`（能力表报 `value:animation`，和绑定分开报，P4a 步骤 5）。
   */
  kind: "unknown" | "value" | "binding" | "animation";
}

export interface ParticleModuleReading extends ParticleModule {
  /** 模块在表里。 */
  known: boolean;
  issues: ParticleModuleIssue[];
}

function defaultValue(def: ParticleFieldDef, orthographic: boolean): ParticleFieldValue {
  const raw =
    typeof def.default === "object" && !Array.isArray(def.default)
      ? orthographic
        ? def.default.orthographic
        : def.default.perspective
      : def.default;
  const parsed = def.type === "number" || def.type === "int" || def.type === "string" ? raw : vector(raw);
  return applyScale(def, parsed ?? raw);
}

function applyScale(def: ParticleFieldDef, value: ParticleFieldValue): ParticleFieldValue {
  if (def.scale === undefined) return value;
  return Array.isArray(value)
    ? value.map((v) => v * def.scale!)
    : typeof value === "number"
      ? value * def.scale
      : value;
}

/** `"x y z"` → 3 个分量（少写的为 0，多写的忽略）；有不是数字的分量、或没有分量时为 undefined。 */
function vector(raw: ParticleFieldValue): number[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const parts = raw.trim().split(/\s+/).filter(Boolean).map(Number);
  if (!parts.length || !parts.every(Number.isFinite)) return undefined;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** 一个字段的 JSON 值 → 解析值；形状不对时 undefined。`previous` 是缺省值（`vec3z` / `vec3str` 写成数字时用）。 */
function parseField(def: ParticleFieldDef, raw: unknown, previous: ParticleFieldValue): ParticleFieldValue | undefined {
  switch (def.type) {
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "int":
      return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "vec3":
    case "vec3z":
    case "vec3str": {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        // 只作用于 z（这类字段没有 scale）
        if (def.type === "vec3z") return [(previous as number[])[0], (previous as number[])[1], raw];
        // 只接受字符串：数字被忽略，保持缺省（已换算）
        if (def.type === "vec3str") return previous;
        return undefined;
      }
      const parsed = typeof raw === "string" ? vector(raw) : undefined;
      return parsed && applyScale(def, parsed);
    }
  }
}

/**
 * 绑定与关键帧的静态值（`{user, value}` / `{script, value}` / `{animation, value}` 的 `value`），不读用户属性：
 * 模块字段的绑定、关键帧整张退回，不登记。
 */
function staticValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
}

/**
 * 按模块表读一个模块项：解析与能力表共用这一个函数。表外模块 `known: false`、字段为空；表内模块的每个字段都有值。
 * `null` 当作缺键（WPE 的 `isNumeric` / `isString` 对 null 为假，取缺省）。
 * 关键帧和绑定分开报：字段写成关键帧报 `animation`，同时挂了 `user` / `script` 再报 `binding`；两者都按 `value` 解析，
 * 解析不出来时不另报形状问题（已经整张退回）。
 */
export function readParticleModule(
  category: ParticleCategory,
  raw: unknown,
  orthographic: boolean,
): ParticleModuleReading {
  const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = typeof entry.name === "string" ? entry.name : "";
  const id = typeof entry.id === "number" ? entry.id : null;
  const def = particleModuleDef(category, name);
  if (!def) return { name, id, fields: {}, known: false, issues: [] };
  const fields: Record<string, ParticleFieldValue> = {};
  for (const [field, spec] of Object.entries(def.fields)) fields[field] = defaultValue(spec, orthographic);
  const issues: ParticleModuleIssue[] = [];
  const present: string[] = [];
  for (const [field, value] of Object.entries(entry)) {
    if (field === "name" || field === "id" || value === null || value === undefined) continue;
    const keyframed = isKeyframedValue(value);
    if (keyframed) issues.push({ field, kind: "animation" });
    if (isUserBinding(value) || isScriptValue(value)) issues.push({ field, kind: "binding" });
    const bound = keyframed || isUserBinding(value) || isScriptValue(value);
    const spec = def.fields[field];
    if (!spec) {
      issues.push({ field, kind: "unknown" });
      continue;
    }
    const parsed = parseField(spec, bound ? staticValue(value) : value, fields[field]);
    if (parsed === undefined) {
      if (!bound) issues.push({ field, kind: "value" });
      continue;
    }
    fields[field] = parsed;
    present.push(field);
  }
  def.normalize?.(fields);
  for (const field of present) {
    const supported = def.fields[field].supported;
    if (supported && !supported(fields[field], fields)) issues.push({ field, kind: "value" });
  }
  return { name, id, fields, known: true, issues };
}

/** 每项 `instanceoverride` 的乘数（已按系统 `flags` 去掉被禁用的项）。 */
export type InstanceMultipliers = Readonly<Record<InstanceScale, number>>;

/**
 * 模拟用的字段：数值舍入成 float32（WPE 的模块记录是 float），带 `instance` 的字段乘对应的 `instanceoverride`，带 `truncate`
 * 的乘完截断成整数（条目类型 1）。每次都从解析值（基值）乘，不累乘（C5「运行时改值」）。字符串原样。
 */
export function resolveParticleFields(
  def: ParticleModuleDef,
  fields: ParticleFields,
  multipliers: InstanceMultipliers,
): ParticleFields {
  const out: Record<string, ParticleFieldValue> = {};
  for (const [field, value] of Object.entries(fields)) {
    const spec = def.fields[field];
    const scale = spec?.instance ? f32(multipliers[spec.instance]) : 1;
    const resolve = (part: number) => {
      const scaled = f32(f32(part) * scale);
      return spec?.truncate ? Math.trunc(scaled) : scaled;
    };
    out[field] = typeof value === "number" ? resolve(value) : Array.isArray(value) ? value.map(resolve) : value;
  }
  return out;
}
