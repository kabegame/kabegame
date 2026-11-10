/**
 * `remapinitialvalue`（initializer 15）、`remapvalue`（operator 19，有 blend 键时是 0x27）（P4d 步骤 4a）：一条管线
 * 「读输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回」，两个模块共用这一份代码，按种类（`init` / `op`）在 18 处取变体。
 * 依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md` 第 2 节（读码【确】），4a 实施时又逐段对过汇编切片
 * `ignore/p4/rea/p4d-mod/init15.asm`（`0x14023ce53` 起）、`op19.asm`（`0x140244874` 起）、`op19b.asm`（blend 版），实测见
 * `p4-particles-REPORT.md`「P4d 语义的实测核对」的 remap 表。
 *
 * 18 处变体（编号同计划「4a」；其余逐位相同）：
 * 1. 输入 `lifetimefraction`：init 读 `frame` 列（出生时 0，`randomframe` 时是 `R`，WPE 的 bug，实测确认）；op 是 `rcp(life)·age`。
 * 2. 输入 `size` / `opacity` / `color`：init 读初始值列（`size0` / `alpha0` / `color0`），op 读当前值列。
 * 3. 输入 `speed`：init `sqrtss((x² + y²) + z²)`；op `sqrtps((y² + x²) + z²)`（加法可交换，两者逐位相同，照写）。
 * 4. 输入 `distancetocontrolpoint`：同上，加法顺序不同。
 * 5. 输入 `positionbetweentwocontrolpoints`：两边都读 `ocp0` / `ocp1`（不是 icp，实测）。init 是 `L > FLT_EPSILON` 时
 *    `dot(P − A, D/L)/L`、否则 0；op 是 `dot(P − A, D)·rcp(|D|²)`、`|D|² ≤ 0` 时 0，点积顺序 `(Py·Dy + Px·Dx) + Pz·Dz`。
 * 6. 输入 `particlesystemtime`：init 读系统时间 `St`（`sys+0x3f0`，乘过 `instanceoverride.rate`）；op 读场景时间 `T`，和 `runtime`
 *    相同（实测 rv-time / ri-time）。
 * 7. 输入 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint`：op 读 `C`、`C − P`、`(C − P)·(rsqrt(|C − P|²) & (0 <
 *    |C − P|²))`；init 的这三个输入会把控制点写成 0（WPE 的 bug），归 4b，4a 期间照报、不执行。
 * 8. 输入 `angularspeed`：两边都是有角速度列（列标志 bit1）时读 `angvz`，否则 0。
 * 9. 分量 `sum` / `average` / `max` / `min`：只在输入编号 > 12（向量输入）时生效；init `(x + y) + z`、`max(max(z, y), x)`，op
 *    `(y + x) + z`、`max(max(x, y), z)`（逐位相同，照写）。
 * 10. 归一化：init 三分量各自 `(in − min)/range`（`divss`）；op 的向量输入是 `(in − min)·rcp(range)`；op 的标量输入（编号 ≤ 12）只用
 *     x 分量的 min 和倒数，夹完再铺到 y、z。`range` 为 0 的分量换成 `FLT_EPSILON`。WPE 的 op 在解析期存 `rcpps(range)`，这里执行时
 *     现算（回放的近似运算包络才覆盖得到）。
 * 11. `sine`：init `sinf((v·π)·s − π/2)·0.5 + 0.5`；op `sin_ps(v·(s·π) − π/2)·0.5 + 0.5`，`s·π` 在执行段开头算（`0x14024498e`）。两边
 *     都用 `Math.sin`（CRT `sinf` / Cephes 型 `sin_ps` 不复刻，同 P4a）。
 * 12. `square` / `saw` / `triangle`：init 用 `floorf` 与 `roundf`（半数远离零）；op 用 `roundps` 0xb（截断）与 0x8（偶舍入）。
 *     `square` 的负号看缩放后的 `t`，`saw` 看缩放前的 `v`。
 * 13. 输出区间 `o = range·v + min`：init 三分量都算；op 只在输出是向量（编号 > 12）时算 y、z（变换也是），标量输出只用 x。
 * 14. 输出 `size` / `opacity` / `color`：init 写初始值列，op 写当前值列（每遍开头从初始值复制，两遍模式结果不变）。
 * 15. 输出 `speed`：`L = |v|`、`s = op(L, o.x)`；init 是 `L ≠ 0` 时 `s /= L`（`divss`），op 是 `L > 0` 时 `s = rcp(L)·s`；`vel *= s`。
 * 16. 输出 `distancetocontrolpoint` / `positionbetweentwocontrolpoints` / `directiontocontrolpoint`：init 精确 `sqrtss` 与除法，op
 *     `q = rsqrt(|d|²)`、`L = q·|d|²` 加掩码（rea 2.7 的表，逐条见 `writeOutput`）。
 * 17. 运算 `remap` → `o`、`multiply` → `o·old`、`add` → `o + old`、`subtract` → `old − o`，未知运算不改（WPE 不写；`speed` 等复合输出
 *     按 `op(old, o) = old` 照常走完，和 WPE 的分支一致）。op 有 blend 时是 `(op(old, o) − old)·b + old`（`op19b.asm`，`speed`
 *     等复合输出同样包在 `op(old, o)` 上），`b` 同其它 operator（`blendFactor`，`t = age·rcp(life)`）。标量输出用 `o.x`。
 * 18. 列标志：op 输出 `opacity` 置 alpha 当前值列（bit4）、输出 `color` 置颜色当前值列（bit3）；init 不置（`modules.ts` 的
 *     `columnFlagsOf`）。
 *
 * 4a 期间照报（能力表按字段报，执行函数整条不跑、不写任何列与控制点、不出 NaN），4b 放开：两种噪声变换（init `snoise1` / `fbm1`，
 * op 是 FastNoise2）、输出 `controlpoint`（`0x10000`、op 只写 lane 0）、init 的输入 16–18（把控制点写成 0）。`timeofday`（写入点没
 * 找到）与未知枚举值一直照报：输入按 0、输出不写、分量不变、变换不变。
 *
 * op 的输出 `maxlifetime` 一直照报、不执行（同上，整条不跑）：WPE 的 op 按 4 个一组写到组尾（循环上界 `sys+0x340`），会把死槽和
 * 高水位之外的槽的 `life` 写回非零，死粒子下一帧再被判死、存活数（无符号）连减下溢，之后不再发射（回放案例 `d4` 的 rv-out-maxlifetime：
 * 每帧一个活了十几秒的粒子加两个从没出生过的槽）。Kabegame 的 op 只处理 `[0, 高水位)`、存活数是有符号的，同样写死槽会让存活数变负、
 * 照常发射，和 WPE 两样，又复刻不了。init 的 `maxlifetime` 只写新粒子，照常支持。
 *
 * 全部逐步 float32、运算顺序照汇编；WPE 用近似指令（`rcpps` / `rsqrtps`）的地方调 `f32.ts` 的 `rcp` / `rsqrt`，并且在执行时现算。
 * op 对 `[0, count)` 全部槽跑（含死槽），同其它 operator（写死槽的其它输出出生时都会被覆盖，不影响结果）。
 */
import { clamp01, f32, PI, rcp, rsqrt } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";
import { blendFactor, readBlend } from "./operators";

type Vec3 = [number, number, number];

/**
 * 属性名表（rea 2.1，`FUN_140260f50`、名字表 `0x140484e80`）：下标就是 WPE 的属性编号，`input`、`output` 共用。编号 ≤ 12 是标量
 * （读出来铺满三分量），> 12 是向量（`FUN_140229370`）。
 */
export const REMAP_PROPERTIES: readonly string[] = [
  "lifetimefraction", // 0
  "maxlifetime", // 1
  "size", // 2
  "opacity", // 3
  "speed", // 4
  "rotation", // 5
  "angularspeed", // 6
  "distancetocontrolpoint", // 7
  "positionbetweentwocontrolpoints", // 8
  "runtime", // 9
  "timeofday", // 10
  "particlesystemtime", // 11
  "layertime", // 12
  "color", // 13
  "position", // 14
  "velocity", // 15
  "controlpoint", // 16
  "deltatocontrolpoint", // 17
  "directiontocontrolpoint", // 18
  "layerorigin", // 19
];
/** `operation`（`FUN_140260fb0`）：其它字符串是 5，不写。 */
export const REMAP_OPERATIONS: readonly string[] = ["remap", "multiply", "add", "subtract"];
/** `inputcomponent` / `outputcomponent`（`FUN_140261030`）：其它字符串是 9，不变（输出时不写）。 */
export const REMAP_COMPONENTS: readonly string[] = ["all", "x", "y", "z", "sum", "average", "max", "min"];
/** `transformfunction`（`FUN_140261120`）：其它字符串是 8，不变。 */
export const REMAP_TRANSFORMS: readonly string[] = [
  "none",
  "sine",
  "square",
  "saw",
  "triangle",
  "simplexnoise",
  "fbmnoise",
];

export type RemapKind = "init" | "op";

/** 名字 → 表里的下标；不在表里（含不是字符串）时 -1。WPE 的名字比较区分大小写。 */
export function remapIndex(table: readonly string[], value: unknown): number {
  return typeof value === "string" ? table.indexOf(value) : -1;
}

/** 属性编号的分类（`FUN_140229370`：编号 > 12 是向量）。未知值（-1）按标量。 */
const isVector = (property: number) => property > 12;

const MAX_LIFETIME = 1;
const TIME_OF_DAY = 10;
const CONTROL_POINT = 16;
/** 两种噪声变换（`simplexnoise` 5、`fbmnoise` 6）。 */
const isNoise = (transform: number) => transform === 5 || transform === 6;
/** init 的输入 16–18：把 `cp[icp0].current.t` 写成 0 再当输入（rea 2.2，`0x14023d31d` 起），4b 做。 */
const isInitControlInput = (input: number) => input >= 16 && input <= 18;

/**
 * 能力表用（`modules.ts` 的 `supported`）：`input` 的取值。`timeofday` 与未知名字照报；4a 期间 init 的 16–18 也照报（4b 放开）。
 */
export function remapInputSupported(kind: RemapKind, value: unknown): boolean {
  const input = remapIndex(REMAP_PROPERTIES, value);
  return input >= 0 && input !== TIME_OF_DAY && !(kind === "init" && isInitControlInput(input));
}
/**
 * `output` 的取值：未知名字照报；`lifetimefraction`、9–12、`layerorigin` 读码确定不写，照常放行；4a 期间 `controlpoint` 照报（4b）；
 * op 的 `maxlifetime` 一直照报（WPE 写死槽的 life、存活数下溢，复刻不了，见文件头），init 的照常放行。
 */
export function remapOutputSupported(kind: RemapKind, value: unknown): boolean {
  const output = remapIndex(REMAP_PROPERTIES, value);
  return output >= 0 && output !== CONTROL_POINT && !(kind === "op" && output === MAX_LIFETIME);
}
/** `transformfunction` 的取值：未知照报；4a 期间两种噪声照报（4b）。 */
export function remapTransformSupported(value: unknown): boolean {
  const transform = remapIndex(REMAP_TRANSFORMS, value);
  return transform >= 0 && !isNoise(transform);
}

/**
 * 控制点个数要计的下标（rea 2.1【确】，`modules.ts` 的 `controlPointRefs`，`controlpoints.ts` 的 `controlPointCount` 用）：
 * - 输入或输出属于 {7, 8, 16, 17, 18} 时计 `icp0`、`ocp0`（`FUN_1401bc480`，两个都计，哪怕只用到其中一个）；
 * - 输入或输出是 8 时再计 `icp1`、`ocp1`（`FUN_1401bc4a0`）。`icp1` 两个执行段都不读，也计。
 * 字段已在解析期钳到 0–7（`clampControlPoint`）。
 */
export function remapControlPointRefs(fields: Readonly<Record<string, unknown>>): number[] {
  const input = remapIndex(REMAP_PROPERTIES, fields.input);
  const output = remapIndex(REMAP_PROPERTIES, fields.output);
  const uses = (set: readonly number[]) => set.includes(input) || set.includes(output);
  const refs: number[] = [];
  if (uses([7, 8, 16, 17, 18])) refs.push(fields.inputcontrolpoint0 as number, fields.outputcontrolpoint0 as number);
  if (uses([8])) refs.push(fields.inputcontrolpoint1 as number, fields.outputcontrolpoint1 as number);
  return refs;
}

/** `FLT_EPSILON`（`0x34000000`）：输入区间为 0 的分量换成它（解析期）；init 的线段长度下限（`xmm9`，`0x1404925e0`）。 */
const FLT_EPSILON = 2 ** -23;
/** `π/2`（`0x3fc90fdb`），正弦变换减去它。 */
const HALF_PI = f32(Math.PI / 2);
/** `average` 乘的 `0x3eaaaaab`。 */
const THIRD = f32(1 / 3);

/** 一次执行要用的解析结果（每次调用执行函数时现算一份：op 每遍一次，init 每个新粒子一次）。 */
interface RemapPlan {
  kind: RemapKind;
  operation: number;
  input: number;
  output: number;
  inputComponent: number;
  outputComponent: number;
  transform: number;
  /** op 的输出是向量：变换与输出区间才算 y、z（变体 13）。init 恒为 true。 */
  threeLanes: boolean;
  inMin: readonly number[];
  /** init：`range`（为 0 的分量换成 `FLT_EPSILON`）；op：`rcp(range)`（变体 10）。 */
  inScale: number[];
  outMin: readonly number[];
  outRange: readonly number[];
  /** `transforminputscale`。 */
  scale: number;
  /** op 的正弦用 `s·π`（变体 11）。 */
  sineScale: number;
  /** `flags` bit0：归一化后夹到 [0, 1]。 */
  clampInput: boolean;
  /** `flags` bit1：输出区间后夹到 [0, 1]。 */
  clampOutput: boolean;
  icp0: number;
  ocp0: number;
  ocp1: number;
}

function remapPlan(kind: RemapKind, fields: ParticleFields): RemapPlan {
  const output = remapIndex(REMAP_PROPERTIES, fields.output);
  const inMin = fields.inputrangemin as number[];
  const inMax = fields.inputrangemax as number[];
  const inScale = inMin.map((min, i) => {
    const range = f32(inMax[i] - min);
    const safe = range === 0 ? FLT_EPSILON : range;
    return kind === "op" ? rcp(safe) : safe;
  });
  const outMin = fields.outputrangemin as number[];
  const outMax = fields.outputrangemax as number[];
  const scale = fields.transforminputscale as number;
  const flags = fields.flags as number;
  return {
    kind,
    operation: remapIndex(REMAP_OPERATIONS, fields.operation),
    input: remapIndex(REMAP_PROPERTIES, fields.input),
    output,
    inputComponent: remapIndex(REMAP_COMPONENTS, fields.inputcomponent),
    outputComponent: remapIndex(REMAP_COMPONENTS, fields.outputcomponent),
    transform: remapIndex(REMAP_TRANSFORMS, fields.transformfunction),
    threeLanes: kind === "init" || isVector(output),
    inMin,
    inScale,
    outMin,
    // 输出区间存 `max − min`，不防 0（rea 2.1）
    outRange: outMin.map((min, i) => f32(outMax[i] - min)),
    scale,
    sineScale: f32(scale * PI),
    clampInput: (flags & 1) !== 0,
    clampOutput: (flags & 2) !== 0,
    icp0: fields.inputcontrolpoint0 as number,
    ocp0: fields.outputcontrolpoint0 as number,
    ocp1: fields.outputcontrolpoint1 as number,
  };
}

/**
 * 照报、整条不跑的取值（见文件头）：4a 期间的两种噪声、输出 `controlpoint`、init 的输入 16–18（4b 放开），以及一直照报的 op 输出
 * `maxlifetime`。
 */
function notExecuted(plan: RemapPlan): boolean {
  return (
    isNoise(plan.transform) ||
    plan.output === CONTROL_POINT ||
    (plan.kind === "init" && isInitControlInput(plan.input)) ||
    (plan.kind === "op" && plan.output === MAX_LIFETIME)
  );
}

const sq = (x: number) => f32(x * x);
const sub = (u: ArrayLike<number>, v: ArrayLike<number>): Vec3 => [
  f32(u[0] - v[0]),
  f32(u[1] - v[1]),
  f32(u[2] - v[2]),
];
/** `(a·a′ + b·b′) + c·c′`（`FUN_14005f070`）。 */
const dot = (u: ArrayLike<number>, v: ArrayLike<number>): number =>
  f32(f32(f32(u[0] * v[0]) + f32(u[1] * v[1])) + f32(u[2] * v[2]));
/** `(x² + y²) + z²`（init 的 `FUN_14019e890` 根号里那一段）。 */
const norm2 = (v: ArrayLike<number>) => f32(f32(sq(v[0]) + sq(v[1])) + sq(v[2]));
/** `(y² + x²) + z²`（op 的 `mulps`/`addps` 顺序，`0x140244b5e` 等）。 */
const norm2yx = (v: ArrayLike<number>) => f32(f32(sq(v[1]) + sq(v[0])) + sq(v[2]));
/** `maxss` / `maxps` 的语义：`a > b ? a : b`（NaN 或相等时取第二个）。 */
const sseMax = (a: number, b: number) => (a > b ? a : b);
const sseMin = (a: number, b: number) => (a < b ? a : b);
/** op 的夹取：`max(0, min(v, 1))`（`minps` 再 `maxps`，`0x1402450c3`）。 */
const clampOp = (v: number) => sseMax(0, sseMin(v, 1));
/** `roundf`：半数远离零（`0x1402edef0`）。 */
const roundHalfAway = (x: number) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
/** `roundps` 0x8：偶舍入。 */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const translation = (context: ParticleRunContext, index: number) => context.controlPoints.current(index).translation;
const lane = (columns: readonly Float32Array[], slot: number): Vec3 => [
  columns[0][slot],
  columns[1][slot],
  columns[2][slot],
];

/** 读输入（rea 2.2）：标量铺满三分量，向量按分量。变体 1–8 在这里。 */
function readInput(plan: RemapPlan, context: ParticleRunContext, slot: number): Vec3 {
  const c = context.columns;
  const init = plan.kind === "init";
  let s: number;
  switch (plan.input) {
    case 0: // lifetimefraction（变体 1）
      s = init ? c.frame[slot] : f32(rcp(c.life[slot]) * c.age[slot]);
      break;
    case 1: // maxlifetime
      s = c.life[slot];
      break;
    case 2: // size（变体 2）
      s = init ? c.size0[slot] : c.size[slot];
      break;
    case 3: // opacity（变体 2）
      s = init ? c.alpha0[slot] : c.alpha[slot];
      break;
    case 4: {
      // speed（变体 3）
      const v = lane(c.velocity, slot);
      s = f32(Math.sqrt(init ? norm2(v) : norm2yx(v)));
      break;
    }
    case 5: // rotation：z 旋转（`+0x290`）
      s = c.rotation[2][slot];
      break;
    case 6: // angularspeed（变体 8）：列标志 bit1（`sys+0x24 & 2`）才有角速度列
      s = c.angularVelocity ? c.angularVelocity[2][slot] : 0;
      break;
    case 7: {
      // distancetocontrolpoint（变体 4）：`d = P − cp[icp0].t`
      const d = sub(lane(c.position, slot), translation(context, plan.icp0));
      s = f32(Math.sqrt(init ? norm2(d) : norm2yx(d)));
      break;
    }
    case 8: // positionbetweentwocontrolpoints（变体 5）
      s = init ? betweenInit(context, plan, slot) : betweenOp(context, plan, slot);
      break;
    case 9: // runtime：场景时间 T
      s = context.time;
      break;
    case 11: // particlesystemtime（变体 6）
      s = init ? (context.systemTime ?? 0) : context.time;
      break;
    case 12: // layertime（`obj+0x770`）
      s = context.layerTime ?? 0;
      break;
    case 13: // color（变体 2）
      return lane(init ? c.color0 : c.color, slot);
    case 14:
      return lane(c.position, slot);
    case 15:
      return lane(c.velocity, slot);
    case 16: {
      // controlpoint（变体 7，op；init 归 4b，走不到这里）
      const t = translation(context, plan.icp0);
      return [t[0], t[1], t[2]];
    }
    case 17: // deltatocontrolpoint（op）：`C − P`
      return sub(translation(context, plan.icp0), lane(c.position, slot));
    case 18: {
      // directiontocontrolpoint（op）：`(C − P)·(rsqrt(|C − P|²) & (0 < |C − P|²))`（`0x140244f59` 起）
      const d = sub(translation(context, plan.icp0), lane(c.position, slot));
      const d2 = norm2yx(d);
      const m = 0 < d2 ? rsqrt(d2) : 0;
      return [f32(m * d[0]), f32(m * d[1]), f32(m * d[2])];
    }
    case 19: {
      // layerorigin：对象世界矩阵的平移 `W.t`（和系统空间无关）
      const o = context.origin;
      return o ? [o[0], o[1], o[2]] : [0, 0, 0];
    }
    default:
      // timeofday（`ctx+0x140`，写入点没找到）与未知输入：照报，按 0
      s = 0;
  }
  return [s, s, s];
}

/**
 * init 的 `positionbetweentwocontrolpoints` 输入（`0x14023d074` 起）：`D = B − A`，`L = sqrtss(|D|²)`；`L > FLT_EPSILON` 时
 * `D̂ = D/L`（`divss` ×3）、`v = dot(P − A, D̂)/L`，否则 0（输入累加器的初值）。`A = cp[ocp0]`、`B = cp[ocp1]`。
 */
function betweenInit(context: ParticleRunContext, plan: RemapPlan, slot: number): number {
  const A = translation(context, plan.ocp0);
  const D = sub(translation(context, plan.ocp1), A);
  const L = f32(Math.sqrt(norm2(D)));
  if (!(L > FLT_EPSILON)) return 0;
  const unit = [f32(D[0] / L), f32(D[1] / L), f32(D[2] / L)];
  return f32(dot(sub(lane(context.columns.position, slot), A), unit) / L);
}

/**
 * op 的 `positionbetweentwocontrolpoints` 输入（`0x140244c5e` 起）：`|D|² = (Dy² + Dx²) + Dz²`，
 * `v = ((PAy·Dy + PAx·Dx) + PAz·Dz)·rcp(|D|²)`，`0 < |D|²` 才保留（`cmpltps`）。
 */
function betweenOp(context: ParticleRunContext, plan: RemapPlan, slot: number): number {
  const A = translation(context, plan.ocp0);
  const D = sub(translation(context, plan.ocp1), A);
  const PA = sub(lane(context.columns.position, slot), A);
  const d2 = norm2yx(D);
  const along = f32(f32(f32(PA[1] * D[1]) + f32(PA[0] * D[0])) + f32(PA[2] * D[2]));
  return 0 < d2 ? f32(along * rcp(d2)) : 0;
}

/** 分量（rea 2.3，变体 9）：只在向量输入时调；`all` 与未知值不变。 */
function applyComponent(kind: RemapKind, component: number, v: Vec3): void {
  const [x, y, z] = v;
  const init = kind === "init";
  let s: number;
  switch (component) {
    case 1:
      s = x;
      break;
    case 2:
      s = y;
      break;
    case 3:
      s = z;
      break;
    case 4: // sum
    case 5: // average
      s = init ? f32(f32(x + y) + z) : f32(f32(y + x) + z);
      if (component === 5) s = f32(s * THIRD);
      break;
    case 6: // max
      s = init ? sseMax(sseMax(z, y), x) : sseMax(sseMax(x, y), z);
      break;
    case 7: // min
      s = init ? sseMin(sseMin(z, y), x) : sseMin(sseMin(x, y), z);
      break;
    default:
      return;
  }
  v[0] = v[1] = v[2] = s;
}

/** 归一化（rea 2.4，变体 10）。 */
function normalizeInput(plan: RemapPlan, v: Vec3): void {
  const { inMin, inScale } = plan;
  if (plan.kind === "init") {
    for (let i = 0; i < 3; i++) {
      const n = f32(f32(v[i] - inMin[i]) / inScale[i]);
      v[i] = plan.clampInput ? clamp01(n) : n;
    }
  } else if (isVector(plan.input)) {
    for (let i = 0; i < 3; i++) {
      const n = f32(f32(v[i] - inMin[i]) * inScale[i]);
      v[i] = plan.clampInput ? clampOp(n) : n;
    }
  } else {
    // 标量输入：只用 x 分量的 min 与倒数，夹完铺到 y、z（`0x1402450f5`）
    const n = f32(f32(v[0] - inMin[0]) * inScale[0]);
    v[0] = v[1] = v[2] = plan.clampInput ? clampOp(n) : n;
  }
}

/** 一个分量的变换（rea 2.5，变体 11、12）；`none` 与未知值不变。噪声归 4b（走不到这里）。 */
function transformLane(plan: RemapPlan, v: number): number {
  const init = plan.kind === "init";
  switch (plan.transform) {
    case 1: {
      // sine：init `sinf((v·π)·s − π/2)`，op `sin_ps(v·(s·π) − π/2)`；再 `·0.5 + 0.5`
      const phase = init ? f32(f32(v * PI) * plan.scale) : f32(v * plan.sineScale);
      return f32(f32(f32(Math.sin(f32(phase - HALF_PI))) * 0.5) + 0.5);
    }
    case 2: {
      // square：`round(t − ⌊t⌋) + (t < 0)`，init floorf + roundf，op 截断 + 偶舍入
      const t = f32(v * plan.scale);
      const negative = t < 0 ? 1 : 0;
      return init
        ? f32(roundHalfAway(f32(t - Math.floor(t))) + negative)
        : f32(roundHalfEven(f32(t - Math.trunc(t))) + negative);
    }
    case 3: {
      // saw：`(t − ⌊t⌋) + (v < 0)`，负号看缩放前的 v
      const negative = v < 0 ? 1 : 0;
      const t = f32(v * plan.scale);
      return f32(f32(t - (init ? Math.floor(t) : Math.trunc(t))) + negative);
    }
    case 4: {
      // triangle：`1 − |2·(|t| − ⌊|t|⌋) − 1|`（|t| ≥ 0，两边的取整结果相同）
      const a = Math.abs(f32(v * plan.scale));
      const fraction = f32(a - (init ? Math.floor(a) : Math.trunc(a)));
      return f32(1 - Math.abs(f32(f32(fraction * 2) - 1)));
    }
    default:
      return v;
  }
}

/** 变换与输出区间（rea 2.5、2.6，变体 13）：init 三分量；op 标量输出只算 x（y、z 保持归一化的值，不会被读）。 */
function mapOutput(plan: RemapPlan, v: Vec3): void {
  const lanes = plan.threeLanes ? 3 : 1;
  for (let i = 0; i < lanes; i++) {
    const t = transformLane(plan, v[i]);
    const o = f32(f32(t * plan.outRange[i]) + plan.outMin[i]);
    v[i] = !plan.clampOutput ? o : plan.kind === "init" ? clamp01(o) : clampOp(o);
  }
}

/**
 * 运算（rea 2.7，变体 17）：`remap` → `o`、`multiply` → `o·old`、`add` → `o + old`、`subtract` → `old − o`；未知运算返回 `old`
 * （WPE 跳过写入；复合输出沿用 `old` 往下算，同 WPE 的分支）。`b` 非 null 时（op 的 blend 记录）是 `(op − old)·b + old`。
 */
function operate(operation: number, old: number, o: number, b: number | null): number {
  let r: number;
  switch (operation) {
    case 0:
      r = o;
      break;
    case 1:
      r = f32(o * old);
      break;
    case 2:
      r = f32(o + old);
      break;
    case 3:
      r = f32(old - o);
      break;
    default:
      return old;
  }
  return b === null ? r : f32(f32(f32(r - old) * b) + old);
}

/** 写回（rea 2.7 的表，变体 14–16）。`o` 是输出区间之后的值。 */
function writeOutput(plan: RemapPlan, context: ParticleRunContext, slot: number, o: Vec3, b: number | null): void {
  const c = context.columns;
  const init = plan.kind === "init";
  const apply = (old: number, value: number) => operate(plan.operation, old, value, b);
  /** 按 `outputcomponent` 写一组三分量列：`all` 三个都写，`x` / `y` / `z` 只写一个，其余不写。 */
  const byComponent = (columns: readonly Float32Array[]) => {
    const k = plan.outputComponent;
    if (k === 0) for (let i = 0; i < 3; i++) columns[i][slot] = apply(columns[i][slot], o[i]);
    else if (k >= 1 && k <= 3) columns[k - 1][slot] = apply(columns[k - 1][slot], o[k - 1]);
  };
  switch (plan.output) {
    case 1: // maxlifetime：只有 init 走到这里（op 照报、不执行，见文件头）
      c.life[slot] = apply(c.life[slot], o[0]);
      return;
    case 2: {
      // size（变体 14）
      const column = init ? c.size0 : c.size;
      column[slot] = apply(column[slot], o[0]);
      return;
    }
    case 3: {
      // opacity（变体 14）
      const column = init ? c.alpha0 : c.alpha;
      column[slot] = apply(column[slot], o[0]);
      return;
    }
    case 4: {
      const L = speedOf(plan, context, slot);
      writeSpeed(plan, context, slot, L, apply(L, o[0]));
      return;
    }
    case 5: // rotation：z 旋转，持久
      c.rotation[2][slot] = apply(c.rotation[2][slot], o[0]);
      return;
    case 6: // angularspeed：要有角速度列
      if (c.angularVelocity) c.angularVelocity[2][slot] = apply(c.angularVelocity[2][slot], o[0]);
      return;
    case 7:
      writeDistance(plan, context, slot, o[0], apply);
      return;
    case 8:
      writeBetween(plan, context, slot, o[0], apply);
      return;
    case 13: // color（变体 14）
      byComponent(init ? c.color0 : c.color);
      return;
    case 14:
      byComponent(c.position);
      return;
    case 15:
      byComponent(c.velocity);
      return;
    case 17: {
      // deltatocontrolpoint：`Δ = C − P`，按分量运算，再无条件写回三分量 `P = C − Δ′`（init `0x14023f086`、op `0x140246bd1`）
      const C = translation(context, plan.ocp0);
      const P = c.position;
      const delta = sub(C, lane(P, slot));
      const k = plan.outputComponent;
      if (k === 0) for (let i = 0; i < 3; i++) delta[i] = apply(delta[i], o[i]);
      else if (k >= 1 && k <= 3) delta[k - 1] = apply(delta[k - 1], o[k - 1]);
      for (let i = 0; i < 3; i++) P[i][slot] = f32(C[i] - delta[i]);
      return;
    }
    case 18:
      writeDirection(plan, context, slot, o, apply);
      return;
    // 0、9–12、19 读码确定不写；16 归 4b（4a 照报，走不到这里）；未知输出不写
  }
}

/** `|v|`：init `sqrtss((x² + y²) + z²)`，op `sqrtps((y² + x²) + z²)`（输入 `speed` 与输出 `speed` 共用）。 */
function speedOf(plan: RemapPlan, context: ParticleRunContext, slot: number): number {
  const v = lane(context.columns.velocity, slot);
  return f32(Math.sqrt(plan.kind === "init" ? norm2(v) : norm2yx(v)));
}

/**
 * 输出 `speed`（变体 15）：`s = op(L, o.x)`；init `L ≠ 0` 时 `s /= L`（`ucomiss`，NaN 也除）；op `0 < L` 时 `s = rcp(L)·s`
 * （`blendvps`）；`vel *= s`。
 */
function writeSpeed(plan: RemapPlan, context: ParticleRunContext, slot: number, L: number, value: number): void {
  let s = value;
  if (plan.kind === "init") {
    if (L !== 0) s = f32(s / L);
  } else if (0 < L) s = f32(rcp(L) * s);
  const v = context.columns.velocity;
  for (let i = 0; i < 3; i++) v[i][slot] = f32(s * v[i][slot]);
}

type Apply = (old: number, value: number) => number;

/**
 * 输出 `distancetocontrolpoint`（变体 16），`C = cp[ocp0].t`、`d = P − C`：
 * - init（`0x14023de79`）：`L = sqrtss`，`L ≠ 0` 时 `d /= L`；`P = C + d·op(L, o.x)`；
 * - op（`0x140245c9e`）：`q = rsqrt(|d|²)`（`(dy² + dx²) + dz²`），`L = q·|d|²`，`d̂ = d·(q & (L ≠ 0))`（`cmpneqps`，NaN 也算不等）；
 *   `P = d̂·op(L, o.x) + C`。
 */
function writeDistance(plan: RemapPlan, context: ParticleRunContext, slot: number, ox: number, apply: Apply): void {
  const C = translation(context, plan.ocp0);
  const P = context.columns.position;
  const d = sub(lane(P, slot), C);
  if (plan.kind === "init") {
    const L = f32(Math.sqrt(norm2(d)));
    if (L !== 0) for (let i = 0; i < 3; i++) d[i] = f32(d[i] / L);
    const value = apply(L, ox);
    for (let i = 0; i < 3; i++) P[i][slot] = f32(C[i] + f32(d[i] * value));
    return;
  }
  const d2 = norm2yx(d);
  const q = rsqrt(d2);
  const L = f32(q * d2);
  const m = L !== 0 ? q : 0;
  const value = apply(L, ox);
  for (let i = 0; i < 3; i++) P[i][slot] = f32(f32(value * f32(m * d[i])) + C[i]);
}

/**
 * 输出 `positionbetweentwocontrolpoints`（变体 16），`A = cp[ocp0].t`、`B = cp[ocp1].t`、`D = B − A`、`PA = P − A`：
 * - init（`0x14023dfe9`）：`L = sqrtss`；`L > FLT_EPSILON` 时 `D̂ = D/L`（否则 `D̂ = D`）；`tp = dot(PA, D̂)`，`perp = PA − D̂·tp`，
 *   `frac = L > FLT_EPSILON ? tp/L : tp`；`P = (A + perp) + (D̂·op(frac, o.x))·L`；
 * - op（`0x140245dba`）：`q = rsqrt(|D|²)`，`L = q·|D|²`，`mask = L ≠ 0`，`D̂ = D·(q & mask)`；`tp = (PAy·D̂y + PAx·D̂x) + PAz·D̂z`，
 *   `perp = PA − tp·D̂`，`frac = (tp·q) & mask`；`P = ((op(frac, o.x)·L)·D̂ + perp) + A`。
 */
function writeBetween(plan: RemapPlan, context: ParticleRunContext, slot: number, ox: number, apply: Apply): void {
  const A = translation(context, plan.ocp0);
  const D = sub(translation(context, plan.ocp1), A);
  const P = context.columns.position;
  const PA = sub(lane(P, slot), A);
  if (plan.kind === "init") {
    const L = f32(Math.sqrt(norm2(D)));
    const long = L > FLT_EPSILON;
    const unit = long ? D.map((x) => f32(x / L)) : D;
    const tp = dot(PA, unit);
    const value = apply(long ? f32(tp / L) : tp, ox);
    for (let i = 0; i < 3; i++) {
      const perp = f32(PA[i] - f32(unit[i] * tp));
      P[i][slot] = f32(f32(A[i] + perp) + f32(f32(unit[i] * value) * L));
    }
    return;
  }
  const d2 = norm2yx(D);
  const q = rsqrt(d2);
  const L = f32(q * d2);
  const mask = L !== 0;
  const m = mask ? q : 0;
  const unit = D.map((x) => f32(m * x));
  const tp = f32(f32(f32(PA[1] * unit[1]) + f32(PA[0] * unit[0])) + f32(PA[2] * unit[2]));
  const value = apply(mask ? f32(tp * q) : 0, ox);
  const scaled = f32(value * L);
  for (let i = 0; i < 3; i++) {
    const perp = f32(PA[i] - f32(tp * unit[i]));
    P[i][slot] = f32(f32(f32(scaled * unit[i]) + perp) + A[i]);
  }
}

/**
 * 输出 `directiontocontrolpoint`（变体 16），`C = cp[ocp0].t`、`Δ = C − P`，按 `outputcomponent` 对方向运算，再沿新方向放回原距离：
 * - init（`0x14023f0da`）：`L = sqrtss`，`L > FLT_EPSILON` 时 `n = Δ/L`（否则 `n = Δ`）；`P = C − normalize(n′)·L`，`normalize` 是
 *   `v·(1/sqrtss(…))`（`FUN_14005eb80`）；
 * - op（`0x140246c0e`）：`q = rsqrt(|Δ|²)`（`(Δx² + Δy²) + Δz²`），`L = q·|Δ|²`，`n = Δ·(q & (0 < L))`；
 *   `P = C − n′·((rsqrt(|n′|²) & (0 < rsqrt(|n′|²)·|n′|²))·L)`。
 * 未知分量不运算，仍按上式写回。
 */
function writeDirection(plan: RemapPlan, context: ParticleRunContext, slot: number, o: Vec3, apply: Apply): void {
  const C = translation(context, plan.ocp0);
  const P = context.columns.position;
  const delta = sub(C, lane(P, slot));
  const k = plan.outputComponent;
  const operateOn = (n: number[]) => {
    if (k === 0) for (let i = 0; i < 3; i++) n[i] = apply(n[i], o[i]);
    else if (k >= 1 && k <= 3) n[k - 1] = apply(n[k - 1], o[k - 1]);
  };
  if (plan.kind === "init") {
    const L = f32(Math.sqrt(norm2(delta)));
    const n = L > FLT_EPSILON ? delta.map((x) => f32(x / L)) : [...delta];
    operateOn(n);
    const inverse = f32(1 / f32(Math.sqrt(norm2(n))));
    for (let i = 0; i < 3; i++) P[i][slot] = f32(C[i] - f32(f32(n[i] * inverse) * L));
    return;
  }
  const d2 = norm2(delta);
  const q = rsqrt(d2);
  const L = f32(q * d2);
  const m = 0 < L ? q : 0;
  const n = delta.map((x) => f32(m * x));
  operateOn(n);
  const n2 = norm2(n);
  const q2 = rsqrt(n2);
  const s = f32((0 < f32(q2 * n2) ? q2 : 0) * L);
  for (let i = 0; i < 3; i++) P[i][slot] = f32(C[i] - f32(s * n[i]));
}

/** 一个粒子走一遍管线（不含 4a 的检查）。 */
function remapSlot(plan: RemapPlan, context: ParticleRunContext, slot: number, b: number | null): void {
  const v = readInput(plan, context, slot);
  if (isVector(plan.input)) applyComponent(plan.kind, plan.inputComponent, v);
  normalizeInput(plan, v);
  mapOutput(plan, v);
  writeOutput(plan, context, slot, v, b);
}

/**
 * 一个粒子走一遍管线：读输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回。init 的 `slot` 是新粒子，op 的是 `[0, count)` 里的每个槽。
 * `blend` 是这个粒子的 blend 系数 `b`（op 的 blend 记录才有，否则 null）。照报的取值（4a 期间的几项与 op 的输出 maxlifetime）整条不跑（见文件头）。
 */
export function remapParticle(
  kind: RemapKind,
  fields: ParticleFields,
  context: ParticleRunContext,
  slot: number,
  blend: number | null,
): void {
  const plan = remapPlan(kind, fields);
  if (!notExecuted(plan)) remapSlot(plan, context, slot, blend);
}

/** `remapinitialvalue`（init 15，执行 `0x14023ce53`）：对新粒子（`context.slot`）走一遍，写初始值列。不抽随机数。 */
export function remapInitialValue(fields: ParticleFields, context: ParticleRunContext): void {
  remapParticle("init", fields, context, context.slot, null);
}

/**
 * `remapvalue`（op 19，非 blend `0x140244874`、blend `0x140246ec0`）：对 `[0, count)` 每个槽（含死槽）走一遍。有 blend 时每个粒子按
 * `t = age·rcp(life)` 算 `b`（`FUN_14022a530`，同其它 operator）。不用 `h`、`k`：两遍模式下两遍都完整执行，持久列（life、rotation、
 * 角速度、位置、速度）上的 `multiply` / `add` / `subtract` 一帧叠两次（实测 rv-ops）。
 */
export function remapValue(fields: ParticleFields, context: ParticleRunContext): void {
  const plan = remapPlan("op", fields);
  if (notExecuted(plan)) return;
  const blend = readBlend(fields);
  const { age, life } = context.columns;
  for (let i = 0; i < context.count; i++)
    remapSlot(plan, context, i, blend.active ? blendFactor(blend, f32(age[i] * rcp(life[i]))) : null);
}
