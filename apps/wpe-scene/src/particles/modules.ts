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
 * 不在表里的字段一律按未知报。`audioprocessing*`（`rea-p4b-modules.md` D）在读它的六个模块里登记（`AUDIO_FIELDS`，P4e 步骤 1），
 * P4e 步骤 4 起任意 `mode` 都支持：系数见 `audio.ts`，乘在哪见各执行函数（rea-p4e-audio.md 第 5 节）。
 */
import { isKeyframedValue, isScriptValue, isUserBinding } from "../compile/bindings";
import { parseAudioBounds, type ParticleAudio } from "./audio";
import type { ParticleColumns } from "./columns";
import type { ControlPointSet } from "./controlpoints";
import {
  maintainDistanceBetweenControlPoints,
  maintainDistanceToControlPoint,
  reduceMovementNearControlPoint,
  vortexV2,
} from "./distance";
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
  aroundState,
  betweenInstanceState,
  betweenNewPeriod,
  betweenState,
  mapSequenceAround,
  mapSequenceBetween,
  resetSequence,
  type SequenceState,
} from "./mapsequence";
import {
  remapControlPointFlags,
  remapControlPointRefs,
  remapIndex,
  remapInitialValue,
  remapInputSupported,
  remapOutputSupported,
  remapTransformSupported,
  remapValue,
  REMAP_COMPONENTS,
  REMAP_OPERATIONS,
  REMAP_PROPERTIES,
  type RemapKind,
} from "./remap";
import {
  alphaChange,
  alphaFade,
  angularMovement,
  capVelocity,
  colorChange,
  controlPointAttract,
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
 * - `vec3splat`：字符串读三个数（少写的分量为 0、多写的忽略），写成数字时原样铺满三分量；缺省值写成数字同样铺满
 *   （remap 的 `inputrange*` / `outputrange*`，rea-p4d-modules.md 2.1「字符串读三个数，否则 `asFloat` 铺满三分量」，P4d 步骤 4a）；
 * - `string`：字符串；
 * - `bool`：jsoncpp `asBool`（rope 的 `uvscrolling`、`uvsmoothing`，rea-p4d-rope.md 3.1）：布尔原样，数字按非 0 为真，解析成
 *   1 / 0；字符串、对象 WPE 会抛异常，这里按形状不对报。
 * - `audiobounds`：`audioprocessingbounds`（P4e 步骤 4，rea-p4e-audio.md 第 2 节）：字符串按 WPE 的两次 `atof` 读成 `[lo, hi]`（第二个数
 *   缺省 0，`audio.ts` 的 `parseAudioBounds`）；数字 0 得 `[0, 0]`，其它形状报。缺省值同样解析。
 */
export type ParticleFieldType =
  "number" | "int" | "vec3" | "vec3z" | "vec3str" | "vec3splat" | "string" | "bool" | "audiobounds";

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
   * 按解析值（基值，没乘 `instanceoverride`）决定这一项乘不乘 `instance`；缺省总乘。只有 `mapsequencebetweencontrolpoints` 的
   * `count`：模块 `flags & 0x10` 时才登记覆盖条目 4（rea-p4d-modules.md 1.2）。
   */
  instanceIf?: (fields: Readonly<Record<string, ParticleFieldValue>>) => boolean;
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
  /**
   * 本系统的控制点（P4c 步骤 1，`particles/controlpoints.ts`）。模块读 `current`（本帧发射之前已更新）；P4d 的模块还读
   * `previous`。
   */
  controlPoints: ControlPointSet;
  /**
   * 系统 `flags` bit0（世界空间，P4c 步骤 4，rea-p4c-sim.md 第 5 节）：粒子存世界坐标。发射器据此决定出生点旋不旋，
   * `movement` 的 `flags` bit0 据此决定重力变不变换。
   */
  world: boolean;
  /**
   * 模拟用的模型矩阵 `M` 的 3×3（列主序，同 `ControlPoint.basis`），即本帧控制点输入的 `W`（rea-p4c-sim.md 1.4：顶层系统模拟时
   * 模型矩阵栈顶就是 `W`）。模拟器每帧（预热每步同样）从 `inputs.world` 的前三列取 xyz 写进来；`movement` 的 `flags` bit0
   * 用（P4c 步骤 4，`FUN_1400dd7d0` 取的就是这 9 个分量）。
   */
  model: Float32Array;
  /**
   * 发射这个粒子的 emitter 的控制点 3×3（`mat3(current)`，无条件，rea-p4c-sim.md 第 3 节）：emitter 写，initializer 当 `M`
   * 用（`velocityrandom`、`turbulentvelocityrandom`）。WPE 是 `FUN_14023b340` 的第三个参数，`sphererandom`、`boxrandom` 在进循环前
   * 从控制点抄出 9 个分量（`0x140237c42`、`0x1402384c8` 起），不看旋转条件。
   */
  basis: Float32Array;
  /**
   * 系统时间 `St`（`sys+0x3f0`，P4d 步骤 4a，rea-p4d-modules.md 2.2）：`remapinitialvalue` 的输入 `particlesystemtime` 读它（op 读的是
   * `time`）。模拟器每帧在模拟之前 `+= dt′`（乘过 `instanceoverride.rate`，float32，`FUN_1402308a0` 开头 `0x1402308c2`），系统复位
   * （`suspend`）清零，预热不累加。下面三项只有模拟器填；单测手写的上下文可以不给，按 0。
   */
  systemTime?: number;
  /**
   * 图层时间（`obj+0x770`，P4d 步骤 4a）：remap 的输入 `layertime`。可见时每帧 `+= dt′`（`FUN_140230650` 的 `0x140230810`，早于
   * 系统的模拟），不可见且有存活粒子时清零（同 `suspend`）。一个对象一个系统，所以存在系统上。
   */
  layerTime?: number;
  /** 对象原点 `W.t`（本帧控制点输入的世界矩阵的平移，P4d 步骤 4a）：remap 的输入 `layerorigin`，和系统空间无关。 */
  origin?: Float32Array;
  /**
   * 这一帧的 16 段归一化频谱（P4e 步骤 4，`audio.ts`，rea-p4e-audio.md 3.1）：全场景各系统共用的只读引用，渲染器在粒子步进之前写好，
   * 一帧里各系统、各遍读到的值相同（3.5）。读音频的模块在 `audioprocessingmode ≠ 0` 时按它取系数。模拟器总会给（缺省全 0）；单测手写的
   * 上下文可以不给，按全 0。
   */
  audio?: ParticleAudio;
}

/**
 * 执行函数：
 * - emitter：给 `slot` 写位置、速度（发射数量是 emitter 共有的逻辑，在 `emitters.ts` 的 `emissionCount`）；
 * - initializer：给 `slot` 写初值（`R` 与缺省值已由模拟器写好）；
 * - operator：对 `[0, count)` 跑一遍，步长 `h`、drag 系数 `k`。
 * `state` 是模块的运行状态（有 `createState` 的模块才有，P4d 步骤 3 的 `mapsequence*`），其余模块不传。
 */
export type ParticleModuleRun = (fields: ParticleFields, context: ParticleRunContext, state?: unknown) => void;

export interface ParticleModuleDef {
  category: ParticleCategory;
  name: string;
  /** 字段表：字段名 → 形状、缺省值、本节支持的取值。`name`、`id` 是结构键，不在这里。 */
  fields: Readonly<Record<string, ParticleFieldDef>>;
  /** 读写的列（步骤 3 开列用）。 */
  columns: readonly ParticleColumn[];
  /** 置的列标志（`COLUMN_FLAGS` 按位或）。 */
  columnFlags: number;
  /**
   * 按字段追加的列标志（和 `columnFlags` 按位或，`particleColumnFlags` 用；参数是解析值，没乘 `instanceoverride`）。只有
   * `controlpointattract`：`flags` bit0 时置 bit2（上一步位置），rea-p4c-sim.md 4.1「`flags & 1` 时 `def+0xc |= 4`」
   * （`0x1401ccd9d`–`0x1401ccda6`）。
   */
  columnFlagsOf?: (fields: Readonly<Record<string, ParticleFieldValue>>) => number;
  /** 字段全部读完后的修正（WPE 解析期的副作用，如 `sign` 非零时置 `flags` bit0）。 */
  normalize?: (fields: Record<string, ParticleFieldValue>) => void;
  run: ParticleModuleRun | null;
  /**
   * 模块的运行状态（WPE 存在流记录里、每个系统实例一份，rea-p4d-modules.md 1.3）。有它的模块，模拟器建系统时按模拟用的字段
   * （已乘 `instanceoverride`）建一份、传给 `run`。P4d 步骤 3 的 `mapsequence*`（序号与步长）。
   */
  createState?: (fields: ParticleFields) => unknown;
  /** 系统复位（`FUN_14022f6c0`，对象不可见且有存活粒子时）时调。 */
  resetState?: (state: unknown) => void;
  /** 周期发射进入新周期（`FUN_14022f790`）时调，早于这个 emitter 本帧的新粒子；按字段决定清不清零。 */
  newPeriod?: (state: unknown, fields: ParticleFields) => void;
  /**
   * `instanceoverride` 运行时改值（`setInstance`，`FUN_1401d15a0` 按登记的覆盖条目重写记录）后调：`fields` 是重乘后的字段，
   * `systemFlags` 是系统 `flags`（禁用位决定条目登没登记）。
   */
  instanceState?: (state: unknown, fields: ParticleFields, systemFlags: number) => void;
  /**
   * 字段名不是 `controlpoint` / `controlpointstart` / `controlpointend` 的控制点引用（P4d 步骤 4a，参数是解析值）：返回要计入控制点
   * 个数的下标（`controlpoints.ts` 的 `controlPointCount`）。只有 remap 两个模块（`remap.ts` 的 `remapControlPointRefs`，按输入、输出
   * 的种类计 `inputcontrolpoint*` / `outputcontrolpoint*`，rea-p4d-modules.md 2.1）。
   */
  controlPointRefs?: (fields: Readonly<Record<string, ParticleFieldValue>>) => number[];
  /**
   * 要并进控制点 `flags` 的位（P4d 步骤 4b，参数是解析值）：返回 `[下标, 位]`，`controlpoints.ts` 建系统时按位或进对应控制点。只有
   * remap 两个模块（`remap.ts` 的 `remapControlPointFlags`：输出是 `controlpoint` 时 `[[ocp0, 0x10000]]`，rea-p4d-modules.md 2.8）。
   */
  controlPointFlags?: (fields: Readonly<Record<string, ParticleFieldValue>>) => [number, number][];
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
const TWO_PI = 2 * Math.PI;

/**
 * jsoncpp 取无符号整数（`FUN_140085f70`，`0x140085f70`–`0x140085fc2`）对数字的结果：整数取低 32 位，实数 `cvttsd2si` 截断成
 * 64 位再取低 32 位（超出 64 位范围得 `0x8000000000000000`，低 32 位是 0）。JS 的 `>>> 0` 就是按 2³² 取模。
 */
export function asUInt32(value: number): number {
  return Math.abs(value) >= 2 ** 63 ? 0 : value >>> 0;
}

/**
 * 模块的 `controlpoint` 下标（P4c 步骤 1）：解析期按 `FUN_140085f70` 取整，再和 7 **按无符号**取小（`cmp eax, 7; cmovb`），
 * 负数当很大的无符号数，得 7。汇编核对过三处：`sphererandom` `0x1401c5ff7`–`0x1401c600d`（存 `p+0xe0`，执行读记录 `+0xf0`）、
 * `boxrandom` `0x1401c6903`–`0x1401c6915`（`p+0x98`，执行读 `+0xa8`）、`vortex` `0x1401cdc0c`–`0x1401cdc1c`（同
 * `controlpointattract` 的写法，rea-p4c-sim.md 4.1）。执行时不再钳制（`imul …, 0xd0` 直接取址）。
 */
export function clampControlPoint(value: number): number {
  return Math.min(asUInt32(value), 7);
}
/**
 * 读控制点的模块共用（`sphererandom`、`boxrandom`、`vortex`，P4c 步骤 3 起加上 `controlpointattract`）：取整，钳制在
 * `normalize` 里做（`clampControlPoint`）。
 */
const CONTROL_POINT_FIELD = int(0);

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

/**
 * 音频的五个键（`FUN_1401c1e20`，rea-p4b-modules.md D、rea-p4e-audio.md 第 2 节【确】），读它的六个模块共用同一个解析函数、同一套
 * 缺省：`sphererandom`、`boxrandom`（乘 `rate`）、`turbulentvelocityrandom`（乘相位范围）、`turbulence`、`vortex`、`vortex_v2`（乘速度）。
 * `mode ≠ 0` 时才取系数、乘上去（P4e 步骤 4，`audio.ts`，作用点见各执行函数），`mode` 为 0 时其余四个键没有读者（P4e 步骤 1 放开，语料
 * `3233141951` 等写了字段、`mode` 为 0）。取值都支持：
 * - `audioprocessingmode`：`asInt`，缺省 0；1 左、2 右、3 左右和，其它非 0 值（4 及以上、负数）取值为 0（`audio.ts` 第 1 节）；
 * - `audioprocessingexponent`：`asFloat`，缺省 2；
 * - `audioprocessingbounds`：字符串读两个数（`audiobounds`，缺省 `"0.8 1.0"`）；
 * - `audioprocessingfrequencystart` / `end`：`asInt`，缺省 0 / 1；解析期按无符号钳到 ≤ 15、`end < start` 时交换（`normalizeAudio`）。
 */
const AUDIO_FIELDS: Record<string, ParticleFieldDef> = {
  audioprocessingmode: int(0),
  audioprocessingexponent: num(2),
  audioprocessingbounds: { type: "audiobounds", default: "0.8 1.0" },
  audioprocessingfrequencystart: int(0),
  audioprocessingfrequencyend: int(1),
};

/**
 * 音频频段的解析期修正（rea-p4e-audio.md 第 2 节【确】）：两者按无符号取 `min(·, 15)`（负数当很大的无符号数，得 15；语料的
 * `frequencyend 16` 实际是 15），`end < start` 时交换。六个读音频的模块都在 `normalize` 里调。
 */
export function normalizeAudio(fields: Record<string, ParticleFieldValue>): void {
  const start = Math.min(asUInt32(fields.audioprocessingfrequencystart as number), 15);
  const end = Math.min(asUInt32(fields.audioprocessingfrequencyend as number), 15);
  fields.audioprocessingfrequencystart = Math.min(start, end);
  fields.audioprocessingfrequencyend = Math.max(start, end);
}

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
 * renderer 共用的朝向字段（`FUN_1401c22e0`，rea-p4c-render.md 7.1，`sprite`、`spritetrail`、rope 两类都调它）：缺键时往 JSON 里补
 * `orientation "screen"`、`axis "0 0 0"`、`flags 0`。取值全部支持（P4c 步骤 5，`orientation.ts` 的 `readOrientation`）：
 * - `orientation`：只认精确的 `"upright"`、`"fixed"`，其它字符串都是 screen；
 * - `axis`：WPE 按空格切三段、各自 `atof`。这里沿用模块表的 vec3 解析，对非数字分量报字段问题，比 WPE 严（语料里没有这种写法）；
 * - `flags`：`FUN_140085f70` 取无符号整数后只存低 8 位（`mov byte ptr [rdi + 0x30], al`，`0x1401c29b2`），只有 bit0 有读者（7.6，
 *   `FUN_1402298b0` 的 `0x1402298c2`），其余 7 位中性。
 */
const RENDERER_FIELDS: Record<string, ParticleFieldDef> = {
  orientation: { type: "string", default: "screen" },
  axis: vec3("0 0 0"),
  flags: int(0),
};

/** renderer 的 `flags` 取无符号整数的低 8 位（见 `RENDERER_FIELDS`）。 */
function normalizeRenderer(fields: Record<string, ParticleFieldValue>): void {
  fields.flags = asUInt32(fields.flags as number) & 0xff;
}

/**
 * rope 两类的 `subdivision` 解析期钳制（rea-p4d-rope.md 3.1，rope `0x1401cffcf`、ropetrail `0x1401d01de`）：`asInt` 后按有符号钳到
 * `[0, 32]`，即每段最多 `4 + 2·32 = 68` 个输出顶点。
 */
export function clampRopeSubdivision(value: number): number {
  return Math.min(32, Math.max(0, value));
}

/**
 * `ropetrail` 的 `segments` 解析期钳制（rea-p4d-rope.md 3.1，`0x1401d01a0`，`r15d = 2`）：`asInt` 后按有符号钳到 `[2, 32]`，即每粒子
 * 写 n 段、历史存 n 个位置。实测 `segments` 0 / 40 → 2 / 32 段（p4-particles-REPORT.md「P4d 语义的实测核对」）。
 */
export function clampTrailSegments(value: number): number {
  return Math.min(32, Math.max(2, value));
}

/**
 * `ropetrail` 的 `length` 解析期钳制（rea-p4d-rope.md 3.1，`0x1401d015f`）：`asFloat` 取 float 后和 `0.001f` 取大，存 float32。
 * 实测 `length 0` 每帧都采样（间隔 `0.001 / segments`）。
 */
export function clampTrailLength(value: number): number {
  return Math.max(f32(value), f32(0.001));
}

/**
 * `positionoffsetrandom` 的 `octaves` 解析期钳制（`0x1401c9387`，`rea-p4b-modules.md` B3【确】）：按**无符号**比较，`≥ 8` 得 8
 * （负数当很大的无符号数，也是 8），`0` 得 1。
 */
export function clampOctaves(value: number): number {
  const octaves = value >>> 0;
  return octaves >= 8 ? 8 : octaves < 1 ? 1 : octaves;
}

/**
 * `mapsequence*` 两者共用的字段（rea-p4d-modules.md 1.1、1.2 的字段表）：
 * - `bounds`：两个数，缺的分量是 0、不钳制，执行时取 `b0 = x`、`Δb = y − x`；
 * - `limitbehavior`：只有精确等于 `"mirror"` 才是 mirror（`rec+0x50` / `rec+0x14`），其余都是 repeat。
 */
const SEQUENCE_FIELDS: Record<string, ParticleFieldDef> = {
  bounds: vec3("0 1"),
  limitbehavior: { type: "string", default: "repeat" },
};

/** `mapsequencebetweencontrolpoints` 的 `flags` 里有读者的位（rea-p4d-modules.md 1.2【确】）：1、2、4、8、0x10、0x20。 */
const BETWEEN_FLAGS = 0x3f;

/** 只认表里名字的字符串字段（remap 的枚举）：不在表里的照报。 */
const named = (value: string, table: readonly string[]): ParticleFieldDef => ({
  type: "string",
  default: value,
  supported: (v) => remapIndex(table, v) >= 0,
});

/**
 * `remapinitialvalue` / `remapvalue` 的字段（rea-p4d-modules.md 2.1 的字段表，P4d 步骤 4a、4b）：缺省不分正交 / 透视，两个模块只有
 * `input` 的缺省不同，blend 四键只有 op 有。枚举的名字表、照报的取值与执行见 `remap.ts`：
 * - `operation`：`remap` / `multiply` / `add` / `subtract`，其它字符串照报（WPE 存 5，不写）；
 * - `input` / `output`：20 个属性名，`timeofday`（写入点没找到）与未知名字照报；输出的 `lifetimefraction`、9–12、`layerorigin` 读码
 *   确定不写，放行；op 的输出 `maxlifetime` 一直照报（WPE 按 4 个一组写死槽的 life、存活数下溢，复刻不了），init 的放行。init 的输入
 *   `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint` 与两边的输出 `controlpoint` 4a 期间照报，4b 放开；
 * - `inputcomponent` / `outputcomponent`：8 个名字，未知照报；输出分量写出时只认 `all`–`z`，其余不写（读码确定，放行）；
 * - `transformfunction`：7 个名字，未知照报（两种噪声 4a 期间照报，4b 放开）；
 * - `inputrange*` / `outputrange*`：`vec3splat`；输入区间为 0 的分量执行时换成 `FLT_EPSILON`，输出区间不防 0；
 * - 四个控制点下标：解析期 `min(·, 7)`（`clampControlPoint`），`inputcontrolpoint1` 两个执行段都不读、只计数；
 * - `transformoctaves`：`asUInt`、不钳制（`fbmnoise` 读；很大时噪声函数有界地提前停下，见 `fastnoise2.ts`、`noise.ts`）；
 * - `flags`：bit0 归一化后夹到 [0, 1]，bit1 输出区间后夹到 [0, 1]，别的位没有读者，中性。
 */
function remapFields(kind: RemapKind): Record<string, ParticleFieldDef> {
  const property = (value: string, supported: (v: ParticleFieldValue) => boolean): ParticleFieldDef => ({
    type: "string",
    default: value,
    supported,
  });
  return {
    operation: named("multiply", REMAP_OPERATIONS),
    input: property(kind === "init" ? "maxlifetime" : "lifetimefraction", remapInputSupported),
    output: property("size", (v) => remapOutputSupported(kind, v)),
    inputcomponent: named("all", REMAP_COMPONENTS),
    outputcomponent: named("all", REMAP_COMPONENTS),
    transformfunction: property("none", remapTransformSupported),
    inputrangemin: { type: "vec3splat", default: 0 },
    inputrangemax: { type: "vec3splat", default: 1 },
    outputrangemin: { type: "vec3splat", default: 0 },
    outputrangemax: { type: "vec3splat", default: 1 },
    inputcontrolpoint0: int(0),
    outputcontrolpoint0: int(0),
    inputcontrolpoint1: int(1),
    outputcontrolpoint1: int(1),
    transforminputscale: num(2),
    transformoctaves: int(3),
    flags: int(1),
    ...(kind === "op" ? BLEND : {}),
  };
}

/** remap 解析期的修正：四个控制点下标 `min(·, 7)`（无符号），`transformoctaves` 取无符号整数。 */
function normalizeRemap(fields: Record<string, ParticleFieldValue>): void {
  for (const key of ["inputcontrolpoint0", "outputcontrolpoint0", "inputcontrolpoint1", "outputcontrolpoint1"])
    fields[key] = clampControlPoint(fields[key] as number);
  fields.transformoctaves = asUInt32(fields.transformoctaves as number);
}

/** remap 读写的列（输入、输出可能碰到的全部列）。 */
const REMAP_COLUMNS: readonly ParticleColumn[] = [
  "age",
  "life",
  "frame",
  "size",
  "size0",
  "rotation",
  "angularVelocity",
  "position",
  "velocity",
  "color",
  "alpha",
  "color0",
  "alpha0",
  // op 噪声的种子（P4d 步骤 4b）
  "random",
];

/**
 * 档 1 的 12 个模块、P4b 步骤 3 的 8 个（emitter `boxrandom`，initializer `alpharandom`，operator `sizechange`、`alphachange`、
 * `colorchange`、`oscillatesize`、`vortex`、`capvelocity`）、步骤 4 的 3 个噪声类模块（initializer `turbulentvelocityrandom`、
 * `positionoffsetrandom`，operator `turbulence`）、P4c 步骤 3 的 operator `controlpointattract`，加 renderer `sprite`、`spritetrail`
 * （P4c 步骤 5）与 rope 两类（`rope` P4d 步骤 1，`ropetrail` P4d 步骤 2），P4d 步骤 3 的 initializer
 * `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`（第一批有运行状态的模块，`mapsequence.ts`），以及 P4d 步骤 4a 的
 * initializer `remapinitialvalue`、operator `remapvalue`（同一条管线，`remap.ts`；噪声与写控制点是步骤 4b），以及 P4d 步骤 5 的
 * operator `maintaindistancetocontrolpoint`、`maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint`、`vortex_v2`
 * （`distance.ts`）。
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
      // 读这个控制点的平移与 3×3（P4c 步骤 1，`emitters.ts`）；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      cone: num(0),
      ...EMITTER_FIELDS,
      ...AUDIO_FIELDS,
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      if ((fields.sign as number[]).some((value) => value !== 0)) fields.flags = Number(fields.flags) | 1;
      normalizeEmitter(fields);
      normalizeAudio(fields);
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
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
      // 读这个控制点的平移与 3×3（P4c 步骤 1，`emitters.ts`）；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      ...EMITTER_FIELDS,
      ...AUDIO_FIELDS,
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      normalizeEmitter(fields);
      normalizeAudio(fields);
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
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
    // 速度**加**上去。`audioprocessing*`（乘相位范围，D、rea-p4e-audio.md 第 5 节）见 `AUDIO_FIELDS`
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
      ...AUDIO_FIELDS,
    },
    columns: ["velocity"],
    columnFlags: 0,
    normalize: normalizeAudio,
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
    // rea-p4d-modules.md 1.1（initializer 13，记录 `FUN_1401d88f0`，解析 `0x1401c9928`–`0x1401ca1cf`，缺省 `FUN_1401bbc90`，正交透视
    // 一套，执行 `0x14023c4cf`）：按序号把粒子转到控制点轴线周围，保留到轴的距离与沿轴分量。执行与序号见 `mapsequence.ts`
    category: "initializer",
    name: "mapsequencearoundcontrolpoint",
    fields: {
      // 解析期存 `step = 1/max(count, 1e-4)`（`rec+4`）。**不乘** `instanceoverride.count`：WPE 是否登记条目 3 取决于暂存区里没写过的
      // `rec+0x58`，实测三种先行解析都是不乘（phase-4d-ropes.md「决定」3）
      count: num(32),
      ...SEQUENCE_FIELDS,
      // 乘 `instanceoverride.speed`（条目 0xa，系统 flags bit4 时不登记）；x 切向、y 径向、z 轴向，执行时求 `Δs = max − min`
      speedmin: by("speed", vec3("0 0 0")),
      speedmax: by("speed", vec3("0 0 0")),
      // 基向量照 `FUN_1401c19e0`（`aroundBasis`）
      axis: vec3("0 0 1"),
      // 读这个控制点 current 的 3×3 与平移（无条件乘 3×3）；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      // WPE 不解析（`parse13.asm` 全段没有读 `"flags"`，只写回 JSON），任何数值都不起作用
      flags: int(0),
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: (fields, context, state) => mapSequenceAround(fields, context, state as SequenceState),
    createState: aroundState,
    resetState: (state) => resetSequence(state as SequenceState),
    // `FUN_14022f790` 读 `rec+0x58 & 2`（残留值），按 0 实现：不清零；配周期发射时能力表照报（`compile/features.ts`）
  },
  {
    // rea-p4d-modules.md 1.2（initializer 14，记录 `FUN_1401d8930`，解析 `0x1401ca1da`–`0x1401ca6c2`，缺省 `FUN_1401bc080`，正交透视
    // 一套，执行 `0x14023ca93`）：按序号把粒子放到两个控制点的连线上，保留垂直分量。执行与序号见 `mapsequence.ts`
    category: "initializer",
    name: "mapsequencebetweencontrolpoints",
    fields: {
      // 解析期存 `step = 1/max(count − 1, 1e-4)`；`flags & 0x10` 时乘 `instanceoverride.count`（条目 4，系统 flags bit5 时不登记）
      count: { ...by("count", num(32)), instanceIf: (fields) => ((fields.flags as number) & 0x10) !== 0 },
      ...SEQUENCE_FIELDS,
      // 两个控制点只取 current 的平移；解析期各自钳到 0–7（`normalize`）
      controlpointstart: int(0),
      controlpointend: int(1),
      // 1 垂直偏移 ×w；2 速度 ×w；4 `size0` ×`(1 − srm) + srm·w`；8 加弧；0x10 `count` 乘 `instanceoverride.count`；0x20 周期发射的
      // 新周期清零序号。别的位没找到读者，保守报
      flags: int(0, (value) => ((value as number) & ~BETWEEN_FLAGS) === 0),
      // `0x3e99999a`
      arcamount: num(0.3),
      // 不归一化，执行时也不乘控制点矩阵
      arcdirection: vec3("0 1 0"),
      // `0x3f666666`
      sizereductionamount: num(0.9),
    },
    columns: ["position", "velocity", "size0"],
    columnFlags: 0,
    normalize(fields) {
      fields.controlpointstart = clampControlPoint(fields.controlpointstart as number);
      fields.controlpointend = clampControlPoint(fields.controlpointend as number);
    },
    run: (fields, context, state) => mapSequenceBetween(fields, context, state as SequenceState),
    createState: betweenState,
    resetState: (state) => resetSequence(state as SequenceState),
    newPeriod: (state, fields) => betweenNewPeriod(state as SequenceState, fields),
    instanceState: (state, fields, systemFlags) => betweenInstanceState(state as SequenceState, fields, systemFlags),
  },
  {
    // rea-p4d-modules.md 2.1（initializer 15，记录 `FUN_1401d8970` 类型 0xf，解析 `0x1401ca6cd`–`0x1401cb052`，缺省 `FUN_1401bc4b0` +
    // `FUN_1401d8040`，执行 `0x14023ce53`）：出生时对新粒子走一遍 remap 管线，写初始值列（`remap.ts`，P4d 步骤 4a）。不置列标志、
    // 没有 `instanceoverride` 条目、不用音频、不抽随机数
    category: "initializer",
    name: "remapinitialvalue",
    fields: remapFields("init"),
    columns: REMAP_COLUMNS,
    columnFlags: 0,
    normalize: normalizeRemap,
    run: remapInitialValue,
    controlPointRefs: remapControlPointRefs,
    controlPointFlags: remapControlPointFlags,
  },
  {
    // 半隐式欧拉，drag 按 k0 衰减（实测核对过）。`previousPosition` 只在列标志 bit2 时开头拷一次
    category: "operator",
    name: "movement",
    fields: {
      gravity: by("speed", vec3("0 0 0")),
      drag: num(0),
      // bit0（P4c 步骤 4）：系统非世界空间时重力按模型矩阵转置变换（`movement`）。解析是 jsoncpp 无符号整数
      // （`FUN_140085f70`，`0x1401cb3ce`，存记录 `+0x1c`），执行段只 `test byte ptr [r14 + 0x1c], 0x1`（`0x14023fde2`），
      // 其余位没找到读者，保守报
      flags: int(0, (value) => (Number(value) & ~1) === 0),
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
    // `rea-p4b-modules.md` B7：乘 `k`；中心 = 控制点平移 + `offset`（控制点的 3×3 不用）
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
      // 中心取这个控制点的平移（P4c 步骤 1，不用 3×3）；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      ...AUDIO_FIELDS,
    },
    columns: ["position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      normalizeAudio(fields);
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: vortex,
  },
  {
    // rea-p4c-sim.md 4.1（operator 10，blend 0x20）：解析 `0x1401cc9c8`–`0x1401ccdb5`，缺省 `FUN_1401bdee0`（只在键不存在时往
    // JSON 里写缺省值，`FUN_140087490` 是 jsoncpp 的 `find`；解析段之后无条件读全部键）。缺省值按二进制核对过
    // （`ignore/p4/c3/consts.py`）。键在而值为 null 时 WPE 读成 0（`find` 认它存在，null 取数是 0），这里照模块表的统一规则当缺键
    // （`readParticleModule`），语料 0 处。执行函数见 `operators.ts` 的 `controlPointAttract`
    category: "operator",
    name: "controlpointattract",
    fields: {
      // 乘 `speed`（覆盖条目只登记这一项，系统 flags bit4 时不登记，`0x1401ccd0c`）；`FUN_140086220` 取 float
      scale: by("speed", num({ orthographic: 512, perspective: 20 })),
      threshold: num({ orthographic: 512, perspective: 5 }),
      // 解析期按 float 平方存（`0x1401ccbef` `mulss xmm6, xmm6`），执行函数里现算平方，结果相同
      deletethreshold: num({ orthographic: 15, perspective: 0.5 }),
      // 缺省 2（钳制开，jsoncpp 整数，`0x1401be245`）；`FUN_140085f70` 取无符号整数。bit0 删除，bit1 钳制，其余位没有读者
      flags: int(2),
      // 读这个控制点 current 的平移；解析期钳到 0–7（`0x1401ccc65`–`0x1401ccd06`，无符号比较）
      controlpoint: CONTROL_POINT_FIELD,
      // 解析了（`0x1401cca18` 起，存 p+0x00..0x20），两个执行段和删除判定都不读
      offset: vec3("0 0 0"),
      // WPE 不读这个键（解析段与缺省函数都没有它），中性：登记成不参与计算的字段，免得按表外字段报（语料 50 处）；写成数字也
      // 不报（同 `turbulentvelocityrandom` 的 `up`）
      origin: vec3("0 0 0", "vec3str"),
      ...BLEND,
    },
    columns: ["age", "life", "position", "velocity", "previousPosition"],
    columnFlags: 0,
    columnFlagsOf: (fields) => ((fields.flags as number) & 1 ? COLUMN_FLAGS.previousPosition : 0),
    normalize(fields) {
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: controlPointAttract,
  },
  {
    // rea-p4d-modules.md 3.1（operator 11，记录 `FUN_1401d8b70` 类型 0xb，有 blend 键时 0x21；解析 `0x1401ccdc5`–`0x1401ccf6b`，缺省
    // `FUN_1401be2a0`）：先跟着控制点平移 `current − previous`，再拉回半径 `distance`（`distance.ts`，P4d 步骤 5）。没有
    // `instanceoverride` 条目
    category: "operator",
    name: "maintaindistancetocontrolpoint",
    fields: {
      distance: num({ orthographic: 200, perspective: 1 }),
      // 精确等于 0 时硬约束（强度 1），否则 `clamp01(variablestrength·h)`
      variablestrength: num(0),
      // 读这个控制点的 current 与 previous；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      ...BLEND,
    },
    columns: ["age", "life", "position"],
    columnFlags: 0,
    normalize(fields) {
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: maintainDistanceToControlPoint,
  },
  {
    // rea-p4d-modules.md 3.2（operator 12，记录 `FUN_1401d8b90` 类型 0xc，blend 0x22；解析 `0x1401ccf7b`–`0x1401cd199`，缺省
    // `FUN_1401be5d0`）：没有别的字段。两个点的 current 与 previous 都读；`controlPointCount` 不写字段时也按缺省计 0、1 两个点
    category: "operator",
    name: "maintaindistancebetweencontrolpoints",
    fields: {
      controlpointstart: CONTROL_POINT_FIELD,
      controlpointend: int(1),
      ...BLEND,
    },
    columns: ["age", "life", "position"],
    columnFlags: 0,
    normalize(fields) {
      fields.controlpointstart = clampControlPoint(fields.controlpointstart as number);
      fields.controlpointend = clampControlPoint(fields.controlpointend as number);
    },
    run: maintainDistanceBetweenControlPoints,
  },
  {
    // rea-p4d-modules.md 3.3（operator 13，记录 `FUN_1401d8bb0` 类型 0xd，blend 0x23；解析 `0x1401cd1a9`–`0x1401cd40c`，缺省
    // `FUN_1401be810`）：只改速度。两个差在解析期算（相等时存 1.0，`reductionouter == reductioninner` 那个是 WPE 的 bug），这里执行时
    // 现算（`distance.ts`）
    category: "operator",
    name: "reducemovementnearcontrolpoint",
    fields: {
      distanceinner: num({ orthographic: 100, perspective: 0.5 }),
      distanceouter: num({ orthographic: 350, perspective: 1 }),
      reductioninner: num(100),
      reductionouter: num(0),
      controlpoint: CONTROL_POINT_FIELD,
      ...BLEND,
    },
    columns: ["age", "life", "position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: reduceMovementNearControlPoint,
  },
  {
    // rea-p4d-modules.md 第 4 节（operator 16，记录 `FUN_1401d8c10` 类型 0x10，blend 0x25；解析 `0x1401cde39`–`0x1401ce3eb`，缺省
    // `FUN_1401bf2d0`）：和 `vortex`（P4b）是两个模块，公式不同（读控制点 3×3、预测偏移的 `centerforce`、环形）。切向乘 `k`
    category: "operator",
    name: "vortex_v2",
    fields: {
      // 环形（flags bit2）时这两个槽被 `ringwidth`、`ringpulldistance` 占用，不读
      distanceinner: num({ orthographic: 500, perspective: 1 }),
      distanceouter: num({ orthographic: 650, perspective: 2 }),
      // 乘 `speed`（条目类型 7，系统 flags bit4 时不登记，`0x1401ce2f1`）
      speedinner: by("speed", num({ orthographic: 2500, perspective: 1 })),
      speedouter: by("speed", num(0)),
      // 只在 flags bit1 时读（`0x1401ce074`），否则按 0
      centerforce: num(1),
      ringradius: num({ orthographic: 300, perspective: 1 }),
      ringwidth: num({ orthographic: 50, perspective: 0.2 }),
      ringpulldistance: num({ orthographic: 50, perspective: 0.25 }),
      ringpullforce: num({ orthographic: 10, perspective: 0.05 }),
      // 只接受字符串（`asCString` 后按空格切），`|axis|² < 0.001` 时取 0 0 1，否则 `axis·(1/sqrt)`
      axis: vec3("0 0 1"),
      // 取无符号整数后只存低 8 位（`movzx eax, r14b`，`normalize`）：bit0 柱形，bit1 `centerforce`，bit2 环形；其余位没有读者
      flags: int(0),
      controlpoint: CONTROL_POINT_FIELD,
      // 音频（`AUDIO_FIELDS`）：`mode ≠ 0` 时乘两个速度（P4e 步骤 4，`distance.ts` 的 `vortexV2`）
      ...AUDIO_FIELDS,
      ...BLEND,
    },
    columns: ["age", "life", "position", "velocity"],
    columnFlags: 0,
    normalize(fields) {
      fields.flags = asUInt32(fields.flags as number) & 0xff;
      normalizeAudio(fields);
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: vortexV2,
  },
  {
    // `rea-p4b-modules.md` B6（operator 14，blend 0x24，缺省值 `FUN_1401beb80`，执行 `0x14024295a` / `0x140242d6e`）：乘 `k`；
    // 三维噪声场。`audioprocessing*`（乘速度，D、rea-p4e-audio.md 第 5 节）见 `AUDIO_FIELDS`
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
      ...AUDIO_FIELDS,
      ...BLEND,
    },
    columns: ["age", "life", "random", "position", "velocity"],
    columnFlags: 0,
    normalize: normalizeAudio,
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
    // rea-p4d-modules.md 2.1（operator 19，记录 `FUN_1401d8c70` 类型 0x13，有 blend 键时 0x27；解析 `0x1401ce660`–`0x1401cf140`，缺省
    // `FUN_1401bfbb0` + `FUN_1401d8040`，执行非 blend `0x140244874`、blend `0x140246ec0`）：每遍对 `[0, count)` 走一遍 remap 管线，写当前
    // 值列与持久列（`remap.ts`，P4d 步骤 4a）。不用 `h`、`k`；没有 `instanceoverride` 条目、不用音频
    category: "operator",
    name: "remapvalue",
    fields: remapFields("op"),
    columns: REMAP_COLUMNS,
    columnFlags: 0,
    // 输出 opacity 时 `def+0xc |= 0x10`（alpha 当前值列），输出 color 时 `|= 0x08`（颜色当前值列）（rea 2.1【确】）
    columnFlagsOf: (fields) => {
      const output = remapIndex(REMAP_PROPERTIES, fields.output);
      return output === 3 ? COLUMN_FLAGS.alpha : output === 13 ? COLUMN_FLAGS.color : 0;
    },
    normalize: normalizeRemap,
    run: remapValue,
    controlPointRefs: remapControlPointRefs,
    controlPointFlags: remapControlPointFlags,
  },
  {
    // rea-p4c-render.md 7.1（renderer 类型 1，分支 `0x1401cc5b5`）：只调 `FUN_1401c22e0`，没有别的键。朝向的解析与几何见
    // `orientation.ts`（P4c 步骤 5）
    category: "renderer",
    name: "sprite",
    fields: RENDERER_FIELDS,
    // 写顶点：按槽序、跳过 `life == 0`
    columns: ["life", "position", "size", "rotation", "color", "alpha"],
    columnFlags: 0,
    normalize: normalizeRenderer,
    run: null,
  },
  {
    // rea-p4c-render.md 6.1（renderer 类型 2，分支 `0x1401cfe16`）：缺省 `FUN_1401c0af0`，正交透视一套（第二个参数没用到），
    // 三个值原样存，不钳制、不排序（`minlength > maxlength` 时着色器的 `max` 在外层，`minlength` 胜；负值也原样传）。绘制前写
    // `g_RenderVar0 = (length, maxlength, minlength)`，宏 `THICKFORMAT`、`TRAILRENDERER`（6.2、6.3，`compile/bundle.ts`、
    // `render/uniforms.ts`）。模拟侧不为拖尾多做任何事（6.4）：速度列照常写进厚格式顶点
    category: "renderer",
    name: "spritetrail",
    fields: {
      // `asFloat`（`FUN_140086220`）取 float：写回 JSON 的缺省是 float 0.05 提升成的 double
      length: num(0.05),
      maxlength: num(10),
      // 缺省函数不补这个键，`asFloat(null)` 得 0
      minlength: num(0),
      // 和 sprite 共用的解析（`FUN_1401c22e0`）；拖尾的几何不读朝向（`TRAILRENDERER` 分支不调 `ComputeParticleTangents`，6.4、7.7）
      ...RENDERER_FIELDS,
    },
    // 写顶点同 sprite，另有速度（厚格式的 `a_TexCoordVec4C1.xyz`）
    columns: ["life", "position", "size", "rotation", "color", "alpha", "velocity"],
    columnFlags: 0,
    normalize: normalizeRenderer,
    run: null,
  },
  {
    // rea-p4d-rope.md 3.1（renderer 类型 3，分支 `0x1401cff33`，缺省 `FUN_1401c0c90`，正交透视一套）。绘制：每段一个点、几何着色器
    // 展开成三角形带，着色器无条件换成 `genericropeparticle`（第 6 节，`compile/bundle.ts`）；段顶点见 `particles/rope.ts`，
    // 运行时用的派生量（`K`、`L`、`R`、两个系统 flags 位）在 `compile/particles.ts` 的 `particleRenderer`
    category: "renderer",
    name: "rope",
    fields: {
      // 缺省 4（`0x1401c0d00`，实测 R2 `maxout 12`）；`asInt` 后钳到 [0, 32]（`normalize`），即宏 `TRAILSUBDIVISION`
      subdivision: int(4),
      // `asFloat`；存成倒数 `K = 1/uvscale`（`sys+0x30`），写 0 时不改、保持 1（`0x1401d0026`，`particleRenderer`）
      uvscale: num(1),
      // 系统 flags `0x20000`（`0x1401d0060`）；为真时不读 `uvsmoothing`
      uvscrolling: { type: "bool", default: 0 },
      // 系统 flags `0x40000`（`0x1401d00a4`），缺省 true（`0x1401c0dd3`，实测 R2）
      uvsmoothing: { type: "bool", default: 1 },
      // 和 sprite 共用的解析（`FUN_1401c22e0`）：`ORIENTATION ≠ 0` 时几何着色器用 `g_OrientationForward`（rea-p4d-rope.md 1.5）
      ...RENDERER_FIELDS,
    },
    // 写段顶点：按 rope 表（出生序）取存活粒子的位置、当前尺寸、当前颜色与 alpha，以及年龄（`uvsmoothing`）
    columns: ["age", "life", "position", "size", "color", "alpha"],
    columnFlags: 0,
    normalize(fields) {
      normalizeRenderer(fields);
      fields.subdivision = clampRopeSubdivision(fields.subdivision as number);
    },
    run: null,
  },
  {
    // rea-p4d-rope.md 3.1（renderer 类型 4，分支 `0x1401d00bf`，缺省 `FUN_1401c1070`，正交透视一套）。每个粒子拖一条带子，由它的
    // 历史位置连成：模拟器每系统一个计时器、每粒子一份历史（`particles/ropetrail.ts` 的 `TrailHistory`，第 5 节），段顶点同样
    // 每段一个点、几何着色器展开（着色器换成 `genericropeparticle`，宏见 `compile/bundle.ts`，3.4）；运行时用的派生量（间隔、`K`、
    // 系统 flags `0x80000`）在 `compile/particles.ts` 的 `particleRenderer`
    category: "renderer",
    name: "ropetrail",
    fields: {
      // `asFloat` 后至少 0.001（`0x1401d015f`，`normalize`）：采样间隔是 `length / segments`（`sys+0x250`，3.4 `0x1401d29ae`）
      length: num(1),
      // `asInt` 后钳到 [2, 32]（`0x1401d01a0`，`normalize`）：每粒子恒写 n 段、历史 n 个位置
      segments: int(4),
      // 缺省 1（实测 T1 `maxout 6`）；`asInt` 后钳到 [0, 32]（`0x1401d01de`，`normalize`），即宏 `TRAILSUBDIVISION`
      subdivision: int(1),
      // `rec+0x48` bit0 / bit1：宏 `TRAILFADEALPHA` / `TRAILFADESIZE`，着色器只在 `TRAILSCROLLALPHA` 分支读（5.4，实测 T3）
      fadealpha: { type: "bool", default: 0 },
      fadesize: { type: "bool", default: 0 },
      // 同 rope：存成倒数 `K = 1/uvscale`（和 rope 共用 `sys+0x30`），写 0 时不改、保持 1
      uvscale: num(1),
      // 系统 flags `0x80000`（`0x1401d02d1`）：宏 `TRAILSCROLLALPHA`、`U` 计数、`g_RenderVar0` 的另一种写法（rea-p4b-render 记作
      // 「rope uvscrolling」，应为 ropetrail，步骤 0 更正）
      uvscrolling: { type: "bool", default: 0 },
      // 和 sprite 共用的解析（`FUN_1401c22e0`）：`ORIENTATION ≠ 0` 时几何着色器用 `g_OrientationForward`（rea-p4d-rope.md 1.5）
      ...RENDERER_FIELDS,
    },
    // 写段顶点：按槽序、跳过 `life == 0`，取当前位置、当前尺寸、当前颜色与 alpha（非厚格式只有一份，5.3）；历史在 `TrailHistory`
    columns: ["life", "position", "size", "color", "alpha"],
    columnFlags: 0,
    normalize(fields) {
      normalizeRenderer(fields);
      fields.length = clampTrailLength(fields.length as number);
      fields.segments = clampTrailSegments(fields.segments as number);
      fields.subdivision = clampRopeSubdivision(fields.subdivision as number);
    },
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
  const parsed =
    def.type === "number" || def.type === "int" || def.type === "string" || def.type === "bool"
      ? raw
      : def.type === "audiobounds"
        ? parseAudioBounds(raw)
        : def.type === "vec3splat" && typeof raw === "number"
          ? [raw, raw, raw]
          : vector(raw);
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
    case "bool":
      // jsoncpp `asBool`：布尔原样，int / real 按非 0（`ParticleFieldType` 的 `bool`）
      if (typeof raw === "boolean") return raw ? 1 : 0;
      return typeof raw === "number" && Number.isFinite(raw) ? (raw !== 0 ? 1 : 0) : undefined;
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
    case "vec3splat": {
      // 数字铺满三分量（WPE `asFloat`），字符串读三个数（P4d 步骤 4a，这类字段没有 scale）
      if (typeof raw === "number" && Number.isFinite(raw)) return [raw, raw, raw];
      return typeof raw === "string" ? vector(raw) : undefined;
    }
    case "audiobounds":
      // 字符串两次 `atof`、数字 0 得 [0, 0]，其它形状报（P4e 步骤 4，`audio.ts` 的 `parseAudioBounds`）
      return parseAudioBounds(raw);
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
 * 的乘完截断成整数（条目类型 1）。每次都从解析值（基值）乘，不累乘（C5「运行时改值」）。字符串原样。带 `instanceIf` 的字段按
 * 基值决定乘不乘（`mapsequencebetweencontrolpoints` 的 `count` 看 `flags & 0x10`）。
 */
export function resolveParticleFields(
  def: ParticleModuleDef,
  fields: ParticleFields,
  multipliers: InstanceMultipliers,
): ParticleFields {
  const out: Record<string, ParticleFieldValue> = {};
  for (const [field, value] of Object.entries(fields)) {
    const spec = def.fields[field];
    const applies = spec?.instance !== undefined && (spec.instanceIf?.(fields) ?? true);
    const scale = applies ? f32(multipliers[spec.instance!]) : 1;
    const resolve = (part: number) => {
      const scaled = f32(f32(part) * scale);
      return spec?.truncate ? Math.trunc(scaled) : scaled;
    };
    out[field] = typeof value === "number" ? resolve(value) : Array.isArray(value) ? value.map(resolve) : value;
  }
  return out;
}
