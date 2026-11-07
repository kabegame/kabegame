/**
 * 粒子系统（P4a 步骤 3）：纯 TS、不碰 GPU 的模拟器，照 WPE 的形状写（定长 float32 列、共用 `R`、operator 按 JSON 顺序、
 * 每遍开头重置 size / rgb / a）。依据：
 * - 帧内顺序 O1、积分与两遍 T4、模块顺序 O2：`p4-particles-REPORT.md`「框架结论」，`rea-framework.md` Q1、Q3；
 * - 发射、initializer、operator 的公式：`rea-p4a.md` B（执行函数在模块表上，`modules.ts`）；
 * - 预热 C1（**固定一遍**、步长按 float32 累加）、`instanceoverride` C5（`dt' = dt·rate`）：`rea-p4a.md` 开头的修正。
 *
 * 一帧（`step`）：
 * 1. 全部槽 `age += dt'`；`life ≠ 0 且 life < age`（严格大于）判死：`life = 0`，存活数减一；
 * 2. 按 JSON 顺序遍历 emitter：算本帧数量，逐个新粒子线性扫描第一个 `life == 0` 的槽 → emitter 写位置速度 → 抽 `R` →
 *    写缺省值 → 按 JSON 顺序跑 initializer；新粒子当帧 `age = 0`；
 * 3. operator 一遍或两遍：每遍开头重置当前值，再按 JSON 顺序执行。
 *
 * 序列帧（P4b）、控制点（P4c）、子系统、可见性与暂停（步骤 5）不在这里。表外模块（`skipped`）不执行：场景已因
 * `particle:<类别>:<名字>` 退回预览图。
 */
import type { ParticleInstance, SceneParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { emissionCount, emitterState, type EmitterState } from "./emitters";
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
  type ParticleModuleRun,
  type ParticleRunContext,
} from "./modules";
import type { ParticleRandom } from "./random";

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

/** 各项 `instanceoverride` 的乘数；系统 `flags` 的对应位禁用时为 1（C3）。 */
export function instanceMultipliers(instance: ParticleInstance, flags: number): InstanceMultipliers {
  const pick = (key: InstanceScale) => (flags & INSTANCE_DISABLE_FLAGS[key] ? 1 : instance[key]);
  return { size: pick("size"), speed: pick("speed"), count: pick("count"), lifetime: pick("lifetime") };
}

interface ResolvedModule {
  name: string;
  fields: ParticleFields;
  run: ParticleModuleRun;
}
interface ResolvedEmitter extends ResolvedModule {
  state: EmitterState;
}

/** 列标志：系统里全部表内模块的 `columnFlags` 按位或。 */
export function particleColumnFlags(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  let flags = 0;
  const add = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) flags |= particleModuleDef(category, module.name)?.columnFlags ?? 0;
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

  private readonly random: ParticleRandom;
  private readonly emitters: ResolvedEmitter[];
  private readonly initializers: ResolvedModule[];
  private readonly operators: ResolvedModule[];
  /** 新粒子的 `a0`（`instanceoverride.alpha`）。 */
  private readonly alpha0: number;
  /** `instanceoverride.rate`，下限 0.01。 */
  private readonly rate: number;
  /** 下一次找空槽的起点：它之前没有空槽。 */
  private searchFrom = 0;
  private readonly context: ParticleRunContext;

  constructor(def: SceneParticle, random: ParticleRandom, passes: 1 | 2) {
    this.def = def;
    this.random = random;
    this.passes = passes;
    this.columns = new ParticleColumns(def.maxcount, particleColumnFlags(def));
    // 从基值乘，不累乘（C5）。`colorn` / `color` / `brightness` 的 HSV 路径不做（能力表报 `object:instanceoverride`）
    const multipliers = instanceMultipliers(def.instance, def.flags);
    const resolve = (category: ParticleCategory, modules: readonly ParticleModule[]): ResolvedModule[] =>
      modules.flatMap((module) => {
        const known = particleModuleDef(category, module.name);
        if (!known?.run) {
          this.skipped.push(`${category}:${module.name}`);
          return [];
        }
        return [
          { name: module.name, fields: resolveParticleFields(known, module.fields, multipliers), run: known.run },
        ];
      });
    this.emitters = resolve("emitter", def.emitters).map((emitter) => ({
      ...emitter,
      state: emitterState(emitter.fields),
    }));
    this.initializers = resolve("initializer", def.initializers);
    this.operators = resolve("operator", def.operators);
    this.alpha0 = f32(def.instance.alpha);
    this.rate = f32(Math.max(0.01, def.instance.rate));
    this.context = { columns: this.columns, random, slot: 0, count: 0, h: 0, k: 0 };
  }

  /** 一帧。`frameDt` 是当帧的 `g_Frametime`（渲染器已钳到 `[0.0001, 0.25]`），这里乘 `instanceoverride.rate` 得 `dt'`。 */
  step(frameDt: number): void {
    this.advance(f32(f32(frameDt) * this.rate), frameDt, this.passes);
  }

  /**
   * 预热（C1）：加载时一次跑完 `while (t < starttime)`，步长按 `maxcount` 取 0.05 或 0.2，float32 累加，**固定一遍**
   * （加载时 `fps` 还是 0，实测推翻了读码的「受 fps 分支影响」），发射开启，`k0 = 步长`。步长不乘 `rate`（按读码直接传步长，
   * `rate ≠ 1` 的预热没有实测）。
   */
  prewarm(): void {
    const step = prewarmStep(this.def.maxcount);
    const end = f32(this.def.starttime);
    for (let t = 0; t < end; t = f32(t + step)) this.advance(step, 0, 1);
  }

  /** 清空全部粒子（不重置发射状态）。 */
  clear(): void {
    this.columns.clear();
    this.highWater = 0;
    this.alive = 0;
    this.searchFrom = 0;
  }

  private advance(dt: number, frameDt: number, passes: 1 | 2): void {
    if (!(dt > 0)) return;
    this.ageAndKill(dt);
    this.emit(dt);
    const { h, k } = operatorPass(dt, frameDt, passes);
    const context = this.context;
    context.count = this.highWater;
    context.h = h;
    context.k = k;
    for (let pass = 0; pass < passes; pass++) {
      this.columns.resetCurrent(this.highWater);
      for (const operator of this.operators) operator.run(operator.fields, context);
    }
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

  private emit(dt: number): void {
    const capacity = this.columns.capacity;
    for (const emitter of this.emitters) {
      const count = emissionCount(emitter.state, emitter.fields, dt, this.alive, capacity);
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
    const r = this.random.a();
    c.random[slot] = r;
    c.age[slot] = 0;
    c.life[slot] = 1;
    c.frame[slot] = this.def.animationMode === "randomframe" ? r : 0;
    c.size0[slot] = 0.5;
    for (let i = 0; i < 3; i++) {
      c.rotation[i][slot] = 0;
      if (c.angularVelocity) c.angularVelocity[i][slot] = 0;
      // 实例颜色：`colorn` 只在材质没有 `hascolor` 时直接用（`0x200000`），其余走 HSV 路径，都没做
      c.color0[i][slot] = 1;
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
