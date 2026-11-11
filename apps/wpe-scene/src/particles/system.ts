/**
 * 粒子系统（P4a 步骤 3）：纯 TS、不碰 GPU 的模拟器，照 WPE 的形状写（定长 float32 列、共用 `R`、operator 按 JSON 顺序、
 * 每遍开头重置 size / rgb / a）。依据：
 * - 帧内顺序 O1、积分与两遍 T4、模块顺序 O2：`p4-particles-REPORT.md`「框架结论」，`rea-framework.md` Q1、Q3；
 * - 发射、initializer、operator 的公式：`rea-p4a.md` B（执行函数在模块表上，`modules.ts`）；
 * - 预热 C1（**固定一遍**、步长按 float32 累加）、`instanceoverride` C5（`dt' = dt·rate`）：`rea-p4a.md` 开头的修正。
 *
 * 一帧（`step`）：
 * 1. 全部槽 `age += dt'`；`life ≠ 0 且 life < age`（严格大于）判死：`life = 0`，存活数减一；
 * 2. 序列帧（P4b 步骤 2，`sequenceFrames`）：帧表系统且不是 `randomframe` 时，全部槽 `frame = (1 / life)·age·sequencemultiplier`；
 * 3. 控制点更新一次（P4c 步骤 1，`ControlPointSet.update`，O1 第 5 步 `0x1402376fe`）：两遍模式也只一次；
 * 4. 按 JSON 顺序遍历 emitter：算本帧数量（周期发射的时长在这里从流 A 抽，`rea-p4b-modules.md` A3），逐个新粒子线性扫描
 *    第一个 `life == 0` 的槽 → emitter 写位置速度 → 抽 `R` → 写缺省值 → 按 JSON 顺序跑 initializer；新粒子当帧 `age = 0`；
 * 5. operator 一遍或两遍：每遍开头重置当前值，再按 JSON 顺序执行；
 * 6. 控制点 `previous ← current`（`0x140237798`）。
 * 噪声类模块（P4b 步骤 4）另读场景时间 `T`（`step` 的 `time`，一帧内不变，预热时为 0）。
 *
 * `instanceoverride.colorn`（P4b 步骤 6，`colorn.ts`）：重乘字段之后从基值重算颜色模块的平移与新粒子的颜色初值（`applyColorn`）。
 *
 * 生命周期（步骤 5）：`instanceoverride` 运行时改值走 `setInstance`（从基值重新乘，存活粒子不动）；不可见的帧走
 * `suspend`（不发射，有存活粒子就清空并复位 emitter 计时，重新可见时不重新预热；控制点照常更新、拷 `previous`，P4d 步骤 5）；
 * 暂停时渲染器不步进。
 *
 * 控制点（P4c 步骤 1、2）是系统的一份状态（`controlpoints.ts`）：建系统时按 JSON 的 `offset` 与静态 `instanceoverride` 定基准，
 * 每帧按对象世界矩阵 `W` 与指针的跟随点（`step` / `prewarm` 的 `inputs`，渲染器按父链与壁纸样式算）更新，模块经执行上下文读。
 * 同一个 `W` 也是模拟时的模型矩阵 `M`（执行上下文的 `model`，`movement` 的 `flags` bit0 用）。
 * 世界空间（系统 `flags` bit0，P4c 步骤 4，rea-p4c-sim.md 第 5 节）只是坐标系的切换：控制点是 `W·base`，出生点经控制点的 3×3
 * 进世界坐标（`origin` 不经 `W`），之后对象移动、旋转，已发出的粒子留在原地；绘制时模型矩阵是单位阵（渲染器负责）。
 * 子系统不在这里。
 * 表外模块（`skipped`）不执行：场景已因 `particle:<类别>:<名字>` 退回预览图。
 *
 * `rope`（P4d 步骤 1，rea-p4d-rope.md 第 2 节）：renderer 是 rope 的系统另维护 rope 表（`ropeOrder`，存槽号、表序就是出生序）
 * 和累计死亡数（`deaths`，`sys+0x350`，只给 `uvscrolling` 用）：出生时追加，每帧判死后保序删除当帧的死亡槽、死亡数累加（删除在
 * 发射之前），`clear` 时一起清零。两遍模式只影响 operator，预热照常维护（2.4）。段顶点见 `rope.ts`。
 *
 * `ropetrail`（P4d 步骤 2，rea-p4d-rope.md 第 5 节）：renderer 是 ropetrail 的系统另有历史（`trail`，`ropetrail.ts` 的
 * `TrailHistory`）：出生时在全部 initializer 之后写满出生位置（`born`），预热结束后塌缩到当前位置（`afterPrewarm`，预热不采样），
 * 每帧模拟之后按计时器采样（`sample`，和模拟同一个 `dt'`）。`clear` 不碰计时器，也不清历史（出生时覆盖）。
 *
 * 模块的运行状态（P4d 步骤 3，rea-p4d-modules.md 1.3）：模块表有 `createState` 的 initializer（`mapsequence*` 的序号与步长）每个
 * 系统一份，`run` 时传入；系统复位（`suspend`）时 `resetState`，周期发射进入新周期时 `newPeriod`（早于该 emitter 本帧的新粒子），
 * `setInstance` 重乘字段后 `instanceState`。`clear` 不碰它们（WPE 的清空不动记录）。
 *
 * 系统时间与图层时间（P4d 步骤 4a，rea-p4d-modules.md 2.2、5.3，remap 的输入 `particlesystemtime`（init）与 `layertime` 读）：`step` 在
 * 模拟之前各自 `+= dt′`（float32，乘过 `rate`），`suspend` 在有存活粒子时一起清零；系统时间在不可见的帧上（复位之后）照常累加，预热不
 * 累加（P4d 收尾 A 实测 st-hide、st-pre）。模拟时的
 * 对象原点 `W.t`（remap 的 `layerorigin`）和模型矩阵一起由 `advance` 按 `inputs.world` 写进执行上下文。
 */
import { instanceValues, type ParticleInstanceValues, type SceneParticle } from "../compile/particles";
import { identity } from "../render/math";
import { TIME_WRAP_SECONDS } from "../sceneTime";
import { colornState, type Rgb } from "./colorn";
import { ParticleColumns } from "./columns";
import { ControlPointSet, IDENTITY_BASIS, type ControlPointInputs } from "./controlpoints";
import { emissionCount, emitterState, resetEmitterTiming, type EmitterState } from "./emitters";
import { f32 } from "./f32";
import {
  INSTANCE_DISABLE_FLAGS,
  particleModuleDef,
  resolveParticleFields,
  type InstanceMultipliers,
  type InstanceScale,
  type ParticleCategory,
  type ParticleFields,
  type ParticleModule,
  type ParticleModuleDef,
  type ParticleModuleRun,
  type ParticleRunContext,
} from "./modules";
import type { ParticleRandom, ParticleROverride } from "./random";
import { RopeOrder } from "./rope";
import { TrailHistory } from "./ropetrail";

/** 没给控制点输入时用：对象世界矩阵按单位阵、指针的跟随点按 (0, 0)（单测；渲染器与 `particleTrack` 都显式传）。 */
const IDENTITY_INPUTS: ControlPointInputs = { world: identity(), pointer: [0, 0] };

/** 预热步长：`maxcount < 500` 时 0.05，否则 0.2（C1，实测两档都对上）。 */
export function prewarmStep(maxcount: number): number {
  return maxcount < 500 ? f32(0.05) : f32(0.2);
}

/** 预热的步数：`while (t < starttime) t += 步长`，float32 累加（`starttime 2.5`、步长 0.05 是 51 步，不是 `ceil` 的 50）。 */
export function prewarmSteps(starttime: number, maxcount: number): number {
  const step = prewarmStep(maxcount);
  const end = f32(starttime);
  let steps = 0;
  for (let t = 0; t < end; t = f32(t + step)) steps++;
  return steps;
}

const DRAG_REFERENCE = f32(0.025);
const DRAG_EXPONENT = f32(0.7);

/**
 * drag 系数 `k0 = pow(min(1, 0.025 / frameDt), 0.7)·dt'`（`FUN_140236cd0`，实测核对过）。`frameDt` 是当帧未乘 `rate` 的
 * `g_Frametime`；预热时它是 0，`min(1, ∞) = 1`，`k0 = dt'`。
 */
export function dragK0(dt: number, frameDt: number): number {
  const ratio = Math.min(1, f32(DRAG_REFERENCE / frameDt));
  return f32(f32(Math.pow(ratio, DRAG_EXPONENT)) * dt);
}

/**
 * operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍（T4，`dec eax; cmp eax, 0x13; ja`，无符号比较，`fps = 0` 是一遍）。
 * Kabegame 对应宿主帧上限 `maxFps`（缺省 60，一遍）。
 */
export function particlePasses(fps: number): 1 | 2 {
  return fps >= 1 && fps <= 20 ? 2 : 1;
}

/** 一遍 operator 的步长与 drag 系数：两遍模式时 `h = dt'/2`、`k = k0/2`，否则 `h = dt'`、`k = k0`（T4）。 */
export function operatorPass(dt: number, frameDt: number, passes: 1 | 2): { h: number; k: number } {
  const k0 = dragK0(dt, frameDt);
  return passes === 2 ? { h: f32(dt * 0.5), k: f32(k0 * 0.5) } : { h: dt, k: k0 };
}

/** `instanceoverride.rate` 的下限（`rea-framework.md` Q2 第 7 步）。 */
const MIN_RATE = 0.01;

/**
 * 各项 `instanceoverride` 的乘数；系统 `flags` 的对应位禁用时为 1（C3）。`rate` 没有禁用位，取模拟用的同一个值（下限 0.01，
 * 见 `applyScalars`）：WPE 的钳制写回 `instanceoverride.rate` 本身（`obj+0x854` 即 `+0xdc`），和 `timescale` 的条目重写在
 * 同一次重算里，先后没读；`rate < 0.01` 没有实测【推】。
 */
export function instanceMultipliers(
  instance: Pick<ParticleInstanceValues, InstanceScale>,
  flags: number,
): InstanceMultipliers {
  const pick = (key: InstanceScale) => (flags & INSTANCE_DISABLE_FLAGS[key] ? 1 : instance[key]);
  return {
    size: pick("size"),
    speed: pick("speed"),
    count: pick("count"),
    lifetime: pick("lifetime"),
    rate: Math.max(MIN_RATE, instance.rate),
  };
}

interface ResolvedModule {
  name: string;
  def: ParticleModuleDef;
  /** 解析后的基值（没乘 `instanceoverride`）：改值时从这里重新乘。 */
  base: ParticleFields;
  /** 模拟用的字段（已乘、已舍入）。 */
  fields: ParticleFields;
  run: ParticleModuleRun;
  /**
   * 模块的运行状态（P4d 步骤 3）：模块表有 `createState` 的才有（`mapsequence*` 的序号与步长），按建系统时的字段建一份，
   * 传给 `run`；其余为 undefined。
   */
  state: unknown;
}
interface ResolvedEmitter extends ResolvedModule {
  /** emitter 的状态是发射计时（`emitters.ts`），模块表的 emitter 都没有 `createState`。 */
  state: EmitterState;
}

/**
 * 列标志：系统里全部表内模块的 `columnFlags`，加上按字段算的 `columnFlagsOf`（P4c 步骤 3，`controlpointattract` 的 `flags` bit0
 * 开上一步位置列），按位或。`module.fields` 是解析值（没乘 `instanceoverride`）；按字段算的只看 `flags`，不受覆盖影响。
 */
export function particleColumnFlags(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  let flags = 0;
  const add = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) {
      const known = particleModuleDef(category, module.name);
      if (known) flags |= known.columnFlags | (known.columnFlagsOf?.(module.fields) ?? 0);
    }
  };
  add("emitter", def.emitters);
  add("initializer", def.initializers);
  add("operator", def.operators);
  return flags;
}

export class ParticleSystem {
  readonly def: SceneParticle;
  readonly columns: ParticleColumns;
  readonly passes: 1 | 2;
  /** 槽号上界（只增不减，循环上界）。 */
  highWater = 0;
  /** 存活数。 */
  alive = 0;
  /** 没有执行函数、模拟器跳过的模块（`<类别>:<名字>`）。 */
  readonly skipped: string[] = [];
  /** 控制点（P4c 步骤 1）。 */
  readonly controlPoints: ControlPointSet;
  /** rope 表（P4d 步骤 1，`sys+0x218`）：renderer 是 rope 的系统才有，其余为 null。 */
  readonly ropeOrder: RopeOrder | null;
  /** 累计死亡数（`sys+0x350`，rope `uvscrolling` 的 `TP0`）：rope 系统才累加，`clear` 时清零。 */
  deaths = 0;
  /** 当帧判死的槽号（升序，`ageAndKill` 收集，rope 系统才用），复用同一个数组。 */
  private readonly dead: number[] = [];
  /**
   * ropetrail 的历史与计时器（P4d 步骤 2，`sys+0x230`…`0x24c`）：renderer 是 ropetrail 的系统才有，其余为 null。间隔取
   * `def.renderer.ropetrail.interval`。
   */
  readonly trail: TrailHistory | null;
  /**
   * 系统时间 `St`（`sys+0x3f0`，P4d 步骤 4a）：每帧模拟之前 `+= dt′`（`FUN_1402308a0` 开头 `0x1402308c2`，float32），系统复位
   * （`FUN_14022f6c0`，`suspend`）清零；不可见的帧上 `suspend` 照样累加，预热不累加（P4d 收尾 A 实测）。`remapinitialvalue` 的
   * `particlesystemtime` 读它（经执行上下文）。
   */
  systemTime = 0;
  /**
   * 图层时间（`obj+0x770`，P4d 步骤 4a）：可见时每帧 `+= dt′`（`FUN_140230650` 的 `0x140230810`，早于系统的模拟），不可见且有存活粒子
   * 时清零。WPE 存在对象上，Kabegame 一个粒子对象一个系统，所以放在这里。remap 的 `layertime` 读它。
   */
  layerTime = 0;

  private readonly random: ParticleRandom;
  private readonly emitters: ResolvedEmitter[];
  private readonly initializers: ResolvedModule[];
  private readonly operators: ResolvedModule[];
  /** 当前的 `instanceoverride` 标量与 `colorn`（起始值 = `def.instance`，`setInstance` 改）。 */
  private instance: ParticleInstanceValues;
  /** 新粒子的 `a0`（`instanceoverride.alpha`）。 */
  private alpha0 = 1;
  /** 新粒子的 rgb 初值（WPE 的 `sys+0x3e0..0x3e8`，`colornState` 的 `instanceColor`），颜色 initializer 乘在它上面。 */
  private instanceColor: Rgb = [1, 1, 1];
  /** `instanceoverride.rate`，下限 0.01。 */
  private rate = 1;
  /** 下一次找空槽的起点：它之前没有空槽。 */
  private searchFrom = 0;
  /** `step` 没给场景时间时用的时钟：收到的帧时间之和（秒，double，按 432000 回绕）。 */
  private elapsed = 0;
  private readonly context: ParticleRunContext;
  /** 出生时 `R` 的替换（dev 探针按出生顺序注入 WPE 的值，`random.ts` 的 `injectedR`）；缺省照常用抽到的值。 */
  private readonly rOverride: ParticleROverride | undefined;

  constructor(def: SceneParticle, random: ParticleRandom, passes: 1 | 2, rOverride?: ParticleROverride) {
    this.def = def;
    this.random = random;
    this.passes = passes;
    this.rOverride = rOverride;
    this.columns = new ParticleColumns(def.maxcount, particleColumnFlags(def));
    // WPE 在 rope 的段缓冲（`sys+0x208`）存在时才维护表（2.2、2.3），即 renderer 是 rope
    this.ropeOrder = def.renderer?.kind === "rope" ? new RopeOrder(this.columns.capacity) : null;
    // WPE 在 ropetrail 的 `sys+0x248`（segments）非零时分配历史（rea-p4d-rope.md 3.5），即 renderer 是 ropetrail
    const ropetrail = def.renderer?.ropetrail;
    this.trail = ropetrail ? new TrailHistory(this.columns.capacity, ropetrail.segments, ropetrail.scrolling) : null;
    this.instance = instanceValues(def.instance);
    // 从基值乘，不累乘（C5）；颜色模块的字段乘完再按 `colorn` 平移（`applyColorn`）。`brightness` 不做（能力表按
    // `checkParticleInstance` 报）
    const multipliers = instanceMultipliers(this.instance, def.flags);
    const resolve = (category: ParticleCategory, modules: readonly ParticleModule[]): ResolvedModule[] =>
      modules.flatMap((module) => {
        const known = particleModuleDef(category, module.name);
        if (!known?.run) {
          this.skipped.push(`${category}:${module.name}`);
          return [];
        }
        const fields = resolveParticleFields(known, module.fields, multipliers);
        const state = known.createState?.(fields);
        return [{ name: module.name, def: known, base: module.fields, fields, run: known.run, state }];
      });
    this.emitters = resolve("emitter", def.emitters).map((emitter) => ({
      ...emitter,
      state: emitterState(emitter.fields),
    }));
    this.initializers = resolve("initializer", def.initializers);
    this.operators = resolve("operator", def.operators);
    this.applyScalars();
    this.applyColorn();
    this.controlPoints = new ControlPointSet(def);
    this.context = {
      columns: this.columns,
      random,
      slot: 0,
      count: 0,
      h: 0,
      k: 0,
      time: 0,
      controlPoints: this.controlPoints,
      world: (def.flags & 1) !== 0,
      basis: IDENTITY_BASIS,
      // 每帧由 `advance` 按 `inputs.world` 写（本系统独占一份，不和别的系统共用）
      model: new Float32Array(IDENTITY_BASIS),
      // P4d 步骤 4a：`step` 写两个时间，`advance` 写原点
      systemTime: 0,
      layerTime: 0,
      origin: new Float32Array(3),
    };
  }

  /** 当前的 `instanceoverride` 标量与 `colorn`（一份拷贝）。 */
  get instanceValues(): ParticleInstanceValues {
    return instanceValues(this.instance);
  }

  /**
   * 当前的一项 `instanceoverride` 标量原值（不看系统 flags 的禁用位、不钳制）：rope 的 `R`、`L` 乘 `count`、`lifetime`
   * （rea-p4d-rope.md 1.2，`io+0xd0`、`io+0xd8`），每帧写段顶点时读，不拷贝。
   */
  instanceScalar(field: "count" | "lifetime"): number {
    return this.instance[field];
  }

  /**
   * `instanceoverride` 运行时改值（C5「运行时改值」，`FUN_140230650` 脏时调 `FUN_14022bd40(sys, 1)`）：从基值重新乘、不累乘，
   * 不清粒子、不改容量（`count` 只乘 emitter 的 `rate` 与 `maxtoemitperperiod`）。
   * - 存活粒子保留出生时写进列的 life、颜色、尺寸、`a0`；`size`、`lifetime`、`alpha`、发射速度与 `velocityrandom` 等只影响之后出生的。
   * - 每帧现算的参数下一帧就用新值：`rate`（dt' = dt·rate，下限 0.01）、`count`（发射数量）、`speed` 乘的 operator 字段
   *   （重力、角力、振荡频率，存活粒子也用）。
   * - 系统 `flags` bit4–7 禁用的项照旧不乘（C3）。`brightness` 不影响模拟。
   * - `colorn`（P4b 步骤 6）：颜色模块的平移与新粒子的颜色初值从基值重算（`applyColorn`）。`colorrandom` 是出生时的
   *   initializer，只影响之后出生的粒子；`colorchange` 每帧读字段，存活粒子下一帧就跟着变（rea-p4b-render.md 7.3【推】）。
   * - 已结束、新 `rate > 0` 的 emitter 重新打开（`param_2 = 1` 的尾段，`0x14022c1f0` 起）；累积余数等计时保留。
   * - 有运行状态的模块（P4d 步骤 3）按登记的覆盖条目改状态（`instanceState`）：`mapsequencebetweencontrolpoints` 在 `flags & 0x10`
   *   时 `step` 重写成正的新值（条目 4），序号不动；`mapsequencearoundcontrolpoint` 不登记，不动。
   */
  setInstance(values: Partial<ParticleInstanceValues>): void {
    this.instance = { ...this.instance, ...values };
    const multipliers = instanceMultipliers(this.instance, this.def.flags);
    for (const module of [...this.emitters, ...this.initializers, ...this.operators])
      module.fields = resolveParticleFields(module.def, module.base, multipliers);
    for (const module of this.initializers)
      if (module.state !== undefined) module.def.instanceState?.(module.state, module.fields, this.def.flags);
    this.applyScalars();
    this.applyColorn();
    for (const emitter of this.emitters)
      if (emitter.state.ended && (emitter.fields.rate as number) > 0) emitter.state.ended = false;
  }

  /**
   * 从基值重算颜色模块的字段和新粒子颜色（rea-p4b-render.md 7.3、7.4）。重乘字段之后调，平移的输入是 `module.base`，
   * 所以不会在上一次的结果上累加；不生效时写回基值（float32）。
   * - 0xb `colorrandom`：`min' = shift(min)`、`max' = shift(max)`，两端各自平移后再插值（`colorRandom` 每次按 `max − min` 算区间）。
   * - 0xc `colorchange`：写回 start = `A'`、Δ = `B' − A'`；`colorChange` 每帧按 `f32(end − start)` 算 Δ，和 WPE 的 `subss`
   *   相同，所以换两端即可（7.4）。
   */
  private applyColorn(): void {
    const state = colornState(this.def, this.instance.colorn);
    this.instanceColor = state.instanceColor;
    for (const module of this.initializers)
      if (module.name === "colorrandom")
        module.fields = {
          ...module.fields,
          min: state.shift(module.base.min as number[]),
          max: state.shift(module.base.max as number[]),
        };
    for (const module of this.operators)
      if (module.name === "colorchange")
        module.fields = {
          ...module.fields,
          startvalue: state.shift(module.base.startvalue as number[]),
          endvalue: state.shift(module.base.endvalue as number[]),
        };
  }

  /** 不乘字段、由模拟器自己用的两项：新粒子的 `a0` 与时间缩放 `rate`（下限 0.01）。 */
  private applyScalars(): void {
    this.alpha0 = f32(this.instance.alpha);
    this.rate = f32(Math.max(MIN_RATE, this.instance.rate));
  }

  /**
   * 不可见的一帧（C8，`FUN_140230650` 的不可见分支）：不发射、不步进；还有存活粒子就清空全部粒子，并复位每个 emitter 的计时
   * （`resetEmitterTiming`，`FUN_14022f6c0`）。返回这次有没有清空。重新可见后照常 `step`，**不重新预热**。
   * 控制点照常更新（rea-p4c-sim.md 5.6、rea-p4d-modules.md 5.3，P4d 步骤 5）：每个不可见的帧按当帧的 `inputs`（`W` 与跟随点，渲染器照
   * 可见时的算法算）`update`，再 `previous ← current`，没有粒子时也做。这样重新可见的第一帧，读 `previous` 的 maintaindistance* 看到的
   * `current − previous` 只是一帧的位移，不会把粒子一次拽过整段隐藏期间的位移（实测 p4d-dist2 的 hide-r）。
   * 同一处（`FUN_14022f6c0`）还复位有运行状态的模块（P4d 步骤 3，`resetState`）：`mapsequence*` 无条件 `seq = 0`、`step` 的符号不
   * 复位（rea-p4d-modules.md 1.3、5.3），并清零系统时间 `sys+0x3f0`；`FUN_140230650` 同时清零图层时间 `obj+0x770`（P4d 步骤 4a）。
   * 系统时间不看可见性（P4d 收尾 A 实测 p4d-close 的 st-hide，两种 fps 都对上；rea-p4d-modules.md 5.3 原是【推】）：不可见的每一帧在
   * 复位（有存活粒子时）之后照常 `+= dt′`（`frameDt` 乘 `instanceoverride.rate`，同 `step`），所以重新可见后新粒子读到的 St 从隐藏的第一
   * 帧算起、含那一帧的 dt′；「不累加」与「先累加再复位」都超限。图层时间只在可见时累加，这里不动。其余照旧：不发射、不模拟（步骤 5
   * 实测不可见期间不发射）。子系统的复位归 P4e。`inputs` 缺省（单位阵、(0, 0)）、`frameDt` 缺省 0 只给单测用。
   */
  suspend(inputs: ControlPointInputs = IDENTITY_INPUTS, frameDt = 0): boolean {
    this.controlPoints.update(inputs);
    this.controlPoints.endFrame();
    const cleared = this.alive !== 0;
    if (cleared) {
      for (const emitter of this.emitters) resetEmitterTiming(emitter.state, emitter.fields);
      for (const module of this.initializers) if (module.state !== undefined) module.def.resetState?.(module.state);
      this.systemTime = 0;
      this.layerTime = 0;
      this.context.layerTime = 0;
      this.clear();
    }
    // 系统时间（`FUN_1402308a0` 开头 `sys+0x3f0 += dt′`，不可见时照样调）：复位之后累加本帧
    this.systemTime = f32(this.systemTime + f32(f32(frameDt) * this.rate));
    this.context.systemTime = this.systemTime;
    return cleared;
  }

  /**
   * 一帧。`frameDt` 是当帧的 `g_Frametime`（渲染器已钳到 `[0.0001, 0.25]`），这里乘 `instanceoverride.rate` 得 `dt'`。
   * `time` 是本帧的 `g_Time`（已加上本帧钳过的帧时间、已按 432000 回绕，P4b 步骤 4 的场景时间 `T`），舍入成 float32 给噪声类
   * 模块（WPE 的 `ctx+0x130` 是场景时间的 float 副本）；`T` **不乘** `rate`（`rate` 只缩放 `dt'` 与 `timescale`）。
   * 不给时用本系统收到的帧时间之和（double 累加、同样回绕），即从 0 起步的 `FrameClock`：渲染器、`particleTrack` 都显式传，
   * 缺省只给单测用。`inputs` 是本帧控制点更新的输入：对象世界矩阵 `W`（P4c 步骤 1，渲染器每帧按 `SceneState` 沿父链算，
   * 取的是本帧脚本运行之前的状态，P4c 步骤 4；同时是模拟用的模型矩阵，`movement` 的 `flags` bit0 用）和指针的跟随点
   * （P4c 步骤 2，场景坐标，渲染器每帧按本帧的光标反投影，用的是本帧的指针）；缺省（单位阵、(0, 0)）只给单测用。
   */
  step(frameDt: number, time?: number, inputs: ControlPointInputs = IDENTITY_INPUTS): void {
    this.elapsed = (this.elapsed + frameDt) % TIME_WRAP_SECONDS;
    this.context.time = f32(time ?? this.elapsed);
    const dt = f32(f32(frameDt) * this.rate);
    // P4d 步骤 4a：图层时间（`obj+0x770`，`0x140230810`）与系统时间（`sys+0x3f0`，`0x1402308c2`）都在模拟之前 `+= dt′`，float32
    this.layerTime = f32(this.layerTime + dt);
    this.systemTime = f32(this.systemTime + dt);
    this.context.layerTime = this.layerTime;
    this.context.systemTime = this.systemTime;
    this.advance(dt, frameDt, this.passes, inputs);
    // ropetrail 的历史采样（P4d 步骤 2）：WPE 的顶点函数先模拟、再在存活数非零时采样（`FUN_1402308a0`，rea-p4d-rope.md 1.1、5.2），
    // 用同一个 `dt'`；位置是本帧模拟后的
    const trail = this.trail;
    if (trail) trail.sample(dt, this.def.renderer.ropetrail!.interval, this.columns, this.highWater, this.alive);
  }

  /**
   * 预热（C1）：加载时一次跑完 `while (t < starttime)`，步长按 `maxcount` 取 0.05 或 0.2，float32 累加，**固定一遍**
   * （加载时 `fps` 还是 0，实测推翻了读码的「受 fps 分支影响」），发射开启，`k0 = 步长`。步长不乘 `rate`（按读码直接传步长，
   * `rate ≠ 1` 的预热没有实测）。预热不走帧函数，场景时间 `T` 保持加载期的初值 0（`rea-p4b-modules.md` B2 末条；实测
   * `ignore/p4/tracks/rd-p4b-pre-fps60.json`：预热里出生的 `turbulentvelocityrandom` 粒子方向全是 90°，`positionoffsetrandom`
   * 粒子偏移完全相同）。
   *
   * 控制点（P4c 步骤 1，rea-p4c-sim.md 1.3）：加载时 `FUN_14022feb0` 先写好 `W`，压模型矩阵，`FUN_14022e3e0` 更新一次、全部
   * 控制点 `previous ← current`，再预热，预热的每一步照常更新、照常拷 `previous`。`starttime` 为 0 时也做前两步。
   * `inputs` 是加载时的 `W` 与加载时刻光标的跟随点（P4c 步骤 2；预热不走帧函数，指针不变）。
   */
  prewarm(inputs: ControlPointInputs = IDENTITY_INPUTS): void {
    this.controlPoints.update(inputs);
    this.controlPoints.endFrame();
    const step = prewarmStep(this.def.maxcount);
    const end = f32(this.def.starttime);
    this.context.time = 0;
    for (let t = 0; t < end; t = f32(t + step)) this.advance(step, 0, 1, inputs);
    // ropetrail（P4d 步骤 2）：预热的步进不调顶点函数、不采样，结束后历史塌缩到当前位置（rea-p4d-rope.md 5.1，`0x14022f2fc`）
    this.trail?.afterPrewarm(this.columns, this.highWater);
  }

  /**
   * 清空全部粒子（不重置发射状态）。rope 表与累计死亡数一起清零（`FUN_14022fd90` / `FUN_14022f990` 在高水位 > 0 时同时清零
   * 高水位、存活数、`sys+0x350` 并清空表，rea-p4d-rope.md 2.4；累计死亡数非零时高水位一定非零，所以无条件清零结果相同）。
   * ropetrail 的计时器不重置、历史不清（5.1：计时器只有采样写；历史出生时覆盖）。
   */
  clear(): void {
    this.columns.clear();
    this.highWater = 0;
    this.alive = 0;
    this.searchFrom = 0;
    this.ropeOrder?.clear();
    this.deaths = 0;
  }

  private advance(dt: number, frameDt: number, passes: 1 | 2, inputs: ControlPointInputs): void {
    if (!(dt > 0)) return;
    this.ageAndKill(dt);
    this.sequenceFrames();
    // O1 第 5 步（`0x1402376fe`）：序列帧（`0x140237022`）之后、发射之前，两遍模式也只一次
    this.controlPoints.update(inputs);
    const context = this.context;
    // 模拟时的模型矩阵 `M`（rea-p4c-sim.md 1.4，顶层系统就是 `W`）：取前三列的 xyz，同 `FUN_1400dd7d0`（P4c 步骤 4）
    const w = inputs.world;
    context.model.set([w[0], w[1], w[2], w[4], w[5], w[6], w[8], w[9], w[10]]);
    // 对象原点 `W.t`（P4d 步骤 4a，remap 的 `layerorigin`：对象虚函数 +0x80 的第 3 列）
    context.origin!.set([w[12], w[13], w[14]]);
    this.emit(dt);
    const { h, k } = operatorPass(dt, frameDt, passes);
    context.count = this.highWater;
    context.h = h;
    context.k = k;
    for (let pass = 0; pass < passes; pass++) {
      this.columns.resetCurrent(this.highWater);
      for (const operator of this.operators) operator.run(operator.fields, context);
    }
    // 帧尾，全部 operator 之后（`0x140237798`）
    this.controlPoints.endFrame();
  }

  /**
   * 判死（O1 第 1 步）。rope 系统另收集当帧的死亡槽号（槽号升序，`FUN_140236cd0` 的死亡列表 `sys+0x420`），循环后从 rope 表里
   * 保序删除（`0x140237082`），死亡数累加进 `deaths`（`0x140237146`，rea-p4d-rope.md 2.3）。都在发射之前：同一帧先删死的、再追加新的。
   */
  private ageAndKill(dt: number): void {
    const { age, life } = this.columns;
    const order = this.ropeOrder;
    const dead = this.dead;
    dead.length = 0;
    for (let i = 0; i < this.highWater; i++) {
      age[i] = f32(age[i] + dt);
      if (life[i] !== 0 && life[i] < age[i]) {
        life[i] = 0;
        this.alive--;
        if (i < this.searchFrom) this.searchFrom = i;
        if (order) dead.push(i);
      }
    }
    if (order && dead.length) {
      order.removeDead(dead);
      this.deaths += dead.length;
    }
  }

  /**
   * 序列帧（模拟第 3 步，`0x140237022`，rea-p4b-render.md 2.5）：系统有 `0x1000000`（`def.spriteSheet`）且不是 `randomframe`
   * 时，对 `[0, highWater)` 全部槽 `frame = (1 / life)·age·sequencemultiplier`，先乘 age 再乘倍数，float32。引擎不取小数，
   * frame 可以大于 1（倍数 2 时一生循环两遍），小数由着色器取。
   * - 在判死之后、发射之前：出生当帧 `frame = 0`（序列）或 `R`（`randomframe`，之后不更新），下一帧才按年龄更新。
   * - WPE 用 `rcpps(life)`（相对误差约 3.7e-4），不复刻（总体设计「近似倒数不复刻」）：混帧开着时只让混帧系数差约 1%，
   *   关着时帧号正好落在帧边界附近的粒子可能差一帧。
   * - 死槽（`life = 0`）得 inf / NaN：写顶点时跳过、出生时覆盖，和 WPE 一样不影响结果。
   */
  private sequenceFrames(): void {
    if (!this.def.spriteSheet || this.def.animationMode !== "sequence") return;
    const { frame, age, life } = this.columns;
    const multiplier = f32(this.def.sequenceMultiplier);
    for (let i = 0; i < this.highWater; i++) frame[i] = f32(f32(f32(1 / life[i]) * age[i]) * multiplier);
  }

  /**
   * 按 JSON 顺序逐个 emitter：先算数量（周期发射在这里抽时长，早于本 emitter 的新粒子，A3），再逐个出生。
   * 周期发射进入新周期时（`emissionCount` 置 `periodStarted`），先对全部有状态的 initializer 调 `newPeriod`（P4d 步骤 3，
   * `FUN_14022f790`，在 `FUN_1402378a0` 的新周期分支里 `0x140237ac1`，早于本 emitter 本帧的新粒子），再出生。
   */
  private emit(dt: number): void {
    const capacity = this.columns.capacity;
    for (const emitter of this.emitters) {
      const count = emissionCount(emitter.state, emitter.fields, dt, this.alive, capacity, this.random);
      if (emitter.state.periodStarted) {
        emitter.state.periodStarted = false;
        for (const module of this.initializers)
          if (module.state !== undefined) module.def.newPeriod?.(module.state, module.fields);
      }
      for (let n = 0; n < count; n++) this.spawn(emitter);
    }
  }

  /** 一个新粒子：第一个空槽 → emitter 写位置速度 → 抽 `R` → 缺省值 → initializer（JSON 顺序）。 */
  private spawn(emitter: ResolvedEmitter): void {
    const c = this.columns;
    let slot = this.searchFrom;
    while (slot < c.capacity && c.life[slot] !== 0) slot++;
    if (slot >= c.capacity) return;
    this.searchFrom = slot + 1;
    const context = this.context;
    context.slot = slot;
    emitter.run(emitter.fields, context);
    // 照常抽一次再替换：注入只改 `R` 本身，后面各模块抽到的随机数和不注入时相同
    const drawn = this.random.a();
    const r = this.rOverride ? this.rOverride(drawn) : drawn;
    c.random[slot] = r;
    c.age[slot] = 0;
    c.life[slot] = 1;
    // 出生时 frame（`0x14023b4e9`）：`randomframe` 写 `R`，否则 0（rea-p4b-render.md 2.5）
    c.frame[slot] = this.def.animationMode === "randomframe" ? r : 0;
    c.size0[slot] = 0.5;
    for (let i = 0; i < 3; i++) {
      c.rotation[i][slot] = 0;
      if (c.angularVelocity) c.angularVelocity[i][slot] = 0;
      // 实例颜色（`FUN_14023b340` 在 initializer 之前拷 `sys+0x3e0..0x3e8`，rea-p4b-render.md 7.4 第 4 小节）：`0x200000`
      // 且 `colorn` 生效时是 `colorn`，否则 1；颜色 initializer 乘在它上面，`colorchange` 每遍从这里复制后再乘
      c.color0[i][slot] = this.instanceColor[i];
    }
    c.alpha0[slot] = this.alpha0;
    for (const initializer of this.initializers) initializer.run(initializer.fields, context, initializer.state);
    // ropetrail（P4d 步骤 2）：全部 initializer 之后历史写满出生位置、`C = 1`、`U = 0`（rea-p4d-rope.md 5.1，`0x14023f953`）
    this.trail?.born(slot, c);
    // 当前值与上一步位置（拖尾初值）
    c.size[slot] = c.size0[slot];
    for (let i = 0; i < 3; i++) {
      c.color[i][slot] = c.color0[i][slot];
      if (c.previousPosition) c.previousPosition[i][slot] = c.position[i][slot];
    }
    c.alpha[slot] = c.alpha0[slot];
    this.alive++;
    if (slot >= this.highWater) this.highWater = slot + 1;
    // 「存活数 + 1、高水位更新」之后追加到 rope 表尾（rea-p4d-rope.md 2.2）：同一帧按 emitter 顺序、逐个出生的顺序
    this.ropeOrder?.push(slot);
  }
}
