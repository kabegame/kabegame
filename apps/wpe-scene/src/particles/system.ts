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
 * `suspend`（不发射，有存活粒子就清空并复位 emitter 计时，重新可见时不重新预热）；暂停时渲染器不步进。
 *
 * 控制点（P4c 步骤 1、2）是系统的一份状态（`controlpoints.ts`）：建系统时按 JSON 的 `offset` 与静态 `instanceoverride` 定基准，
 * 每帧按对象世界矩阵 `W` 与指针的跟随点（`step` / `prewarm` 的 `inputs`，渲染器按父链与壁纸样式算）更新，模块经执行上下文读。
 * 同一个 `W` 也是模拟时的模型矩阵 `M`（执行上下文的 `model`，`movement` 的 `flags` bit0 用）。
 * 世界空间（系统 `flags` bit0，P4c 步骤 4，rea-p4c-sim.md 第 5 节）只是坐标系的切换：控制点是 `W·base`，出生点经控制点的 3×3
 * 进世界坐标（`origin` 不经 `W`），之后对象移动、旋转，已发出的粒子留在原地；绘制时模型矩阵是单位阵（渲染器负责）。
 * 子系统不在这里。
 * 表外模块（`skipped`）不执行：场景已因 `particle:<类别>:<名字>` 退回预览图。
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
}
interface ResolvedEmitter extends ResolvedModule {
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
        return [{ name: module.name, def: known, base: module.fields, fields, run: known.run }];
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
    };
  }

  /** 当前的 `instanceoverride` 标量与 `colorn`（一份拷贝）。 */
  get instanceValues(): ParticleInstanceValues {
    return instanceValues(this.instance);
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
   */
  setInstance(values: Partial<ParticleInstanceValues>): void {
    this.instance = { ...this.instance, ...values };
    const multipliers = instanceMultipliers(this.instance, this.def.flags);
    for (const module of [...this.emitters, ...this.initializers, ...this.operators])
      module.fields = resolveParticleFields(module.def, module.base, multipliers);
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
   * 不可见的一帧（C8，`FUN_140230650` 的不可见分支，读码、未实测）：不发射、不步进；还有存活粒子就清空全部粒子，并复位每个
   * emitter 的计时（`resetEmitterTiming`，`FUN_14022f6c0`）。返回这次有没有清空。重新可见后照常 `step`，**不重新预热**。
   * WPE 不可见时控制点照常更新（rea-p4c-sim.md 5.6），这里不更新：可见后第一帧发射前会按当帧的 `W` 重算 `current`，差别只在
   * `previous`（那一帧的 `previous` 是不可见之前最后一帧的值），本步没有读 `previous` 的模块，只影响 P4d。
   */
  suspend(): boolean {
    if (this.alive === 0) return false;
    for (const emitter of this.emitters) resetEmitterTiming(emitter.state, emitter.fields);
    this.clear();
    return true;
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
    this.advance(f32(f32(frameDt) * this.rate), frameDt, this.passes, inputs);
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
  }

  /** 清空全部粒子（不重置发射状态）。 */
  clear(): void {
    this.columns.clear();
    this.highWater = 0;
    this.alive = 0;
    this.searchFrom = 0;
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

  private ageAndKill(dt: number): void {
    const { age, life } = this.columns;
    for (let i = 0; i < this.highWater; i++) {
      age[i] = f32(age[i] + dt);
      if (life[i] !== 0 && life[i] < age[i]) {
        life[i] = 0;
        this.alive--;
        if (i < this.searchFrom) this.searchFrom = i;
      }
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

  /** 按 JSON 顺序逐个 emitter：先算数量（周期发射在这里抽时长，早于本 emitter 的新粒子，A3），再逐个出生。 */
  private emit(dt: number): void {
    const capacity = this.columns.capacity;
    for (const emitter of this.emitters) {
      const count = emissionCount(emitter.state, emitter.fields, dt, this.alive, capacity, this.random);
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
    for (const initializer of this.initializers) initializer.run(initializer.fields, context);
    // 当前值与上一步位置（拖尾初值）
    c.size[slot] = c.size0[slot];
    for (let i = 0; i < 3; i++) {
      c.color[i][slot] = c.color0[i][slot];
      if (c.previousPosition) c.previousPosition[i][slot] = c.position[i][slot];
    }
    c.alpha[slot] = c.alpha0[slot];
    this.alive++;
    if (slot >= this.highWater) this.highWater = slot + 1;
  }
}
