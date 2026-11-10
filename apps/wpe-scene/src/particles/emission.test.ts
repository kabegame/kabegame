// P4b 步骤 3：发射时序（周期、bit1、delay / duration、duration < 0）与 boxrandom。依据 rea-p4b-modules.md A0–A4。
// P4c 步骤 1：读控制点的模块（两个发射器、velocityrandom、turbulentvelocityrandom、vortex），rea-p4c-sim.md 第 3 节。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { scaling } from "../render/math";
import { ControlPointSet, eulerBasis, IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import { boxRandom, emissionCount, emitterState, fastInvSqrt, resetEmitterTiming, sphereRandom } from "./emitters";
import { turbulentVelocityRandom, velocityRandom } from "./initializers";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { vortex } from "./operators";
import { SeededRandom, type ParticleRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;
const ONE = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

/** 按给定序列返回随机数，记录每次用的是哪个区间；序列用完后返回 `fallback`。 */
class ScriptedRandom implements ParticleRandom {
  readonly calls: ("a" | "b")[] = [];
  constructor(
    private readonly values: number[] = [],
    private readonly fallback = 0.5,
  ) {}
  a(): number {
    this.calls.push("a");
    return f32(this.values.shift() ?? this.fallback);
  }
  b(): number {
    this.calls.push("b");
    return f32(this.values.shift() ?? this.fallback);
  }
}

function emitter(module: JsonObject, name = "sphererandom", multipliers = ONE): ParticleFields {
  const reading = readParticleModule("emitter", { name, ...module }, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("emitter", name)!, reading.fields, multipliers);
}

/** 按帧调 `emissionCount`，返回每帧数量；`afterFrame` 每帧之后看一眼状态。 */
function counts(
  fields: ParticleFields,
  frames: number,
  options: { dt?: number; random?: ParticleRandom; alive?: (frame: number) => number; capacity?: number } = {},
  afterFrame?: (state: ReturnType<typeof emitterState>, frame: number) => void,
): number[] {
  const state = emitterState(fields);
  const random = options.random ?? new ScriptedRandom();
  return Array.from({ length: frames }, (_, frame) => {
    const n = emissionCount(
      state,
      fields,
      options.dt ?? 0.25,
      options.alive?.(frame) ?? 0,
      options.capacity ?? 1000,
      random,
    );
    afterFrame?.(state, frame);
    return n;
  });
}

describe("发射数量：delay / duration（A2）", () => {
  it("delay 走完的帧起发射，duration 从第一个发射帧的帧尾开始减；Σdt ≥ duration 那帧照常发射后结束", () => {
    const fields = emitter({ rate: 4, delay: 0.5, duration: 0.6 });
    const ended: boolean[] = [];
    expect(counts(fields, 7, {}, (state) => ended.push(state.ended))).toEqual([0, 0, 1, 1, 1, 0, 0]);
    expect(ended).toEqual([false, false, false, false, true, true, true]);
    // delay 没走完时 pending 不动，留到第一个发射帧
    expect(counts(emitter({ rate: 4, delay: 0.5, instantaneous: 2 }), 4)).toEqual([0, 0, 3, 0]);
  });

  it("duration < 0（JSON 写了负值）：只发 instantaneous，连续发射的余数一直累积、不结束", () => {
    const fields = emitter({ rate: 4, duration: -1, instantaneous: 2 });
    const accs: number[] = [];
    expect(counts(fields, 4, {}, (state) => accs.push(state.acc))).toEqual([2, 0, 0, 0]);
    expect(accs).toEqual([-1, 0, 1, 2]);
    // 周期发射时每个新周期重发 instantaneous
    const periodic = emitter({
      rate: 4,
      duration: -1,
      instantaneous: 2,
      flags: 4,
      minperiodicduration: 0.3,
      maxperiodicduration: 0.3,
      minperiodicdelay: 0.3,
      maxperiodicdelay: 0.3,
    });
    expect(counts(periodic, 6)).toEqual([2, 0, 0, 0, 2, 0]);
  });
});

describe("发射数量：flags bit1（A1）", () => {
  it("每帧至多 1 个；acc 先扣掉全部 k，限额砍掉的不退回", () => {
    const fields = emitter({ rate: 10, flags: 2 });
    const accs: number[] = [];
    expect(counts(fields, 4, {}, (state) => accs.push(state.acc))).toEqual([1, 1, 1, 1]);
    // x = 2.5、3.0、2.5、3.0：acc 只留小数
    expect(accs).toEqual([0.5, 0, 0.5, 0]);
  });

  it("不限 instantaneous：第一帧 5 + 1，之后还完欠账再每帧 1 个", () => {
    const fields = emitter({ rate: 10, flags: 2, instantaneous: 5 });
    expect(counts(fields, 6)).toEqual([6, 0, 0, 1, 1, 1]);
  });
});

describe("发射数量：周期发射（flags bit2，A3）", () => {
  const PERIODIC = {
    flags: 4,
    rate: 6,
    instantaneous: 2,
    minperiodicduration: 0.6,
    maxperiodicduration: 1.0,
    minperiodicdelay: 0.2,
    maxperiodicdelay: 0.6,
  };

  it("两态计时：第一帧开周期、重装 instantaneous；周期最后一帧与间歇最后一帧都发；间歇里 acc 保留", () => {
    // 抽到 0.5 → 时长 0.8；0.25 → 间歇 0.3；0.5 → 时长 0.8
    const random = new ScriptedRandom([0.5, 0.25, 0.5]);
    const periods: number[] = [];
    const accs: number[] = [];
    const frames = counts(emitter(PERIODIC), 7, { random }, (state) => {
      periods.push(state.period);
      accs.push(state.acc);
    });
    // 每帧 x 增 1.5
    expect(frames).toEqual([3, 0, 1, 2, 1, 0, 4]);
    // 不补零头：新周期直接设成抽到的时长，进入间歇直接设成 −间歇
    const duration = f32(f32(0.6) + f32(0.5 * f32(1 - f32(0.6))));
    const gap = f32(f32(0.2) + f32(0.25 * f32(f32(0.6) - f32(0.2))));
    expect(duration).toBe(f32(0.8));
    expect(periods).toEqual([
      duration,
      f32(duration - 0.25),
      f32(f32(duration - 0.25) - 0.25),
      f32(f32(f32(duration - 0.25) - 0.25) - 0.25),
      -gap,
      f32(-gap + 0.25),
      duration,
    ]);
    // 第 6 帧在间歇里：rate·0，acc 原样带过
    expect(accs[5]).toBe(accs[4]);
    expect(random.calls).toEqual(["a", "a", "a"]);
  });

  it("随机数从流 A 抽，时长 = min + u·(max − min)，min 已按 min(min, max) 修正", () => {
    const first = (fields: ParticleFields) => {
      const state = emitterState(fields);
      const random = new ScriptedRandom([0.25]);
      emissionCount(state, fields, 0.25, 0, 10, random);
      expect(random.calls).toEqual(["a"]);
      return state.period;
    };
    expect(first(emitter({ ...PERIODIC, minperiodicduration: 5, maxperiodicduration: 2 }))).toBe(2);
    expect(first(emitter(PERIODIC))).toBe(f32(f32(0.6) + f32(0.25 * f32(1 - f32(0.6)))));
  });

  it("maxtoemitperperiod：只限连续发射，按本周期已发数扣，新周期清零；instantaneous 不计入", () => {
    const fields = emitter({
      flags: 4,
      rate: 8,
      maxtoemitperperiod: 2,
      minperiodicduration: 0.9,
      maxperiodicduration: 0.9,
      minperiodicdelay: 0.3,
      maxperiodicdelay: 0.3,
    });
    const bursts: number[] = [];
    expect(counts(fields, 7, {}, (state) => bursts.push(state.burst))).toEqual([2, 0, 0, 0, 0, 0, 2]);
    expect(bursts).toEqual([2, 2, 2, 2, 2, 2, 2]);
    const withBurst = emitter({ ...PERIODIC, rate: 8, maxtoemitperperiod: 2, instantaneous: 3 });
    expect(counts(withBurst, 1)).toEqual([5]);
  });

  it("满容量时整段跳过：周期计时、acc、pending 都不动，也不抽随机数", () => {
    const random = new ScriptedRandom([0.5, 0.25, 0.5]);
    const periods: number[] = [];
    // 第 2–4 帧满容量
    const frames = counts(
      emitter(PERIODIC),
      6,
      { random, capacity: 4, alive: (frame) => (frame >= 1 && frame <= 3 ? 4 : 0) },
      (state) => periods.push(state.period),
    );
    expect(frames).toEqual([3, 0, 0, 0, 0, 1]);
    expect(periods.slice(0, 4)).toEqual([f32(0.8), f32(0.8), f32(0.8), f32(0.8)]);
    expect(random.calls).toEqual(["a"]);
  });

  it("满容量时第一帧不开周期：instantaneous 留着，第一个有空位的帧才开", () => {
    const random = new ScriptedRandom([0.5]);
    const frames = counts(emitter(PERIODIC), 3, { random, capacity: 4, alive: (frame) => (frame === 0 ? 4 : 0) });
    expect(frames).toEqual([0, 3, 0]);
  });

  it("instantaneous 不乘 count；rate 乘 count 不截断；maxtoemitperperiod 乘 count 后截断（条目类型 1）", () => {
    const fields = emitter({ ...PERIODIC, rate: 3, maxtoemitperperiod: 3 }, "sphererandom", { ...ONE, count: 2.5 });
    expect(fields).toMatchObject({ instantaneous: 2, rate: 7.5, maxtoemitperperiod: 7 });
    const half = emitter({ maxtoemitperperiod: 3 }, "boxrandom", { ...ONE, count: 1.5 });
    expect(half.maxtoemitperperiod).toBe(4);
  });

  it("流顺序：周期时长在本 emitter 算数量时抽，晚于前一个 emitter 的新粒子、早于本 emitter 的新粒子", () => {
    const json: JsonObject = {
      maxcount: 10,
      emitter: [
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1 },
        // 第二个是周期发射，instantaneous 2
        { name: "sphererandom", distancemax: 0, ...PERIODIC, rate: 0 },
      ],
      initializer: [{ name: "lifetimerandom", min: 5, max: 5 }],
      operator: [],
    };
    const random = new ScriptedRandom();
    const system = new ParticleSystem(parseParticle(json, { file: "p.json", orthographic: true }), random, 1);
    system.step(0.1);
    expect(system.alive).toBe(3);
    // 每个粒子：sphererandom 7 次（距离 0 走回退）+ R + lifetimerandom
    const particle = ["b", "a", "b", "b", "b", "b", "b", "a", "a"];
    expect(random.calls).toEqual([...particle, "a", ...particle, ...particle]);
  });

  it("复位计时（不可见时）：acc、burst、周期计时清零，pending、delay、duration 回初值", () => {
    const fields = emitter({ ...PERIODIC, maxtoemitperperiod: 5, delay: 0, duration: 3 });
    const state = emitterState(fields);
    const random = new SeededRandom(1);
    for (let i = 0; i < 3; i++) emissionCount(state, fields, 0.25, 0, 100, random);
    expect(state.burst).toBeGreaterThan(0);
    expect(state.period).not.toBe(0);
    resetEmitterTiming(state, fields);
    expect(state).toEqual({
      acc: 0,
      pending: 2,
      delay: 0,
      duration: 3,
      ended: false,
      burst: 0,
      period: 0,
      periodStarted: false,
    });
  });
});

describe("boxrandom（A4）", () => {
  const box = (module: JsonObject) => emitter(module, "boxrandom");
  const run = (fields: ParticleFields, random: ParticleRandom, columns = new ParticleColumns(4, 0)) => {
    const context: ParticleRunContext = {
      columns,
      random,
      slot: 0,
      count: 1,
      h: 0,
      k: 0,
      time: 0,
      controlPoints: identityControlPoints(),
      world: false,
      basis: IDENTITY_BASIS,
      model: IDENTITY_BASIS,
    };
    boxRandom(fields, context);
    return {
      pos: [0, 1, 2].map((i) => columns.position[i][0]),
      vel: [0, 1, 2].map((i) => columns.velocity[i][0]),
    };
  };

  it("抽取顺序 z、y、x：r = (2u − 1)·directions，q = r·(max − min) + sign·min，再加 origin", () => {
    const random = new ScriptedRandom([1, 0.25, 0.75, 0.5]);
    const fields = box({ origin: "100 200 300", directions: "1 1 1", distancemax: "10 20 30" });
    const { pos } = run(fields, random);
    expect(pos).toEqual([105, 190, 330]);
    expect(random.calls).toEqual(["b", "b", "b", "b"]);
  });

  it("distancemin 三轴都大于 0：落在 8 个角块里（逐轴空心），不是盒壳", () => {
    const fields = box({ origin: "1400 700 0", directions: "1 1 0", distancemin: "50 50 0", distancemax: "100 100 0" });
    const random = new SeededRandom(3);
    const quadrants = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { pos } = run(fields, random);
      const dx = pos[0] - 1400;
      const dy = pos[1] - 700;
      expect(Math.abs(dx)).toBeGreaterThanOrEqual(50);
      expect(Math.abs(dx)).toBeLessThanOrEqual(100);
      expect(Math.abs(dy)).toBeGreaterThanOrEqual(50);
      expect(Math.abs(dy)).toBeLessThanOrEqual(100);
      expect(pos[2]).toBe(0);
      quadrants.add(`${Math.sign(dx)},${Math.sign(dy)}`);
    }
    expect(quadrants.size).toBe(4);
  });

  it("速度沿出生点相对 origin 的方向：|v| = speedmin + u·(speedmax − speedmin)", () => {
    const random = new ScriptedRandom([0.5, 0, 1, 0.5]);
    // z：r = 0；y：r = −1 → −4；x：r = 1 → 3
    const fields = box({ directions: "1 1 1", distancemin: "3 4 7", distancemax: "3 4 7", speedmin: 5, speedmax: 15 });
    const { pos, vel } = run(fields, random);
    expect(pos).toEqual([3, -4, 0]);
    expect(vel[0]).toBeCloseTo(6, 5);
    expect(vel[1]).toBeCloseTo(-8, 5);
    expect(vel[2]).toBe(0);
  });

  it("|d| 太小时回退：再按 z、y、x 抽 3 个当方向，最后抽速度（共 7 个）", () => {
    // 位置的 3 个：x 用 0.75（正）；回退的 3 个：x 用 0.25（负）
    const random = new ScriptedRandom([0.5, 0.5, 0.75, 0.9, 0.9, 0.25, 0.5]);
    const fields = box({ origin: "900 250 0", directions: "1 0 0", distancemax: "0 0 0", speedmin: 50, speedmax: 50 });
    const { pos, vel } = run(fields, random);
    expect(pos).toEqual([900, 250, 0]);
    expect(vel).toEqual([-50, 0, 0]);
    expect(random.calls).toEqual(["b", "b", "b", "b", "b", "b", "b"]);
  });

  it("回退判断：1 / fastInvSqrt(|d|²) < 1e-4；|d| 用写进列的 float 重新减 origin", () => {
    const draws = () => new ScriptedRandom([0.5, 0.5, 1]);
    const tiny = box({ directions: "1 0 0", distancemin: "0.00003 0 0", distancemax: "0.00003 0 0" });
    const tinyRandom = draws();
    run(tiny, tinyRandom);
    expect(tinyRandom.calls).toHaveLength(7);
    const small = box({ directions: "1 0 0", distancemin: "0.0002 0 0", distancemax: "0.0002 0 0" });
    const smallRandom = draws();
    run(small, smallRandom);
    expect(smallRandom.calls).toHaveLength(4);
    // q = 0.001 不小，但 100000 + 0.001 舍入回 100000，写进列后 d = 0，照样回退
    const far = box({ origin: "100000 0 0", directions: "1 0 0", distancemin: "0.001 0 0", distancemax: "0.001 0 0" });
    const farRandom = draws();
    run(far, farRandom);
    expect(farRandom.calls).toHaveLength(7);
  });

  it("回退判断用的是 fastInvSqrt 的近似值：|d| = 0.9995e-4 时精确平方根小于 1e-4，近似值算出来不小于，不回退", () => {
    const d = "0.00009995 0 0";
    expect(Math.sqrt(Math.fround(Math.fround(0.00009995) ** 2))).toBeLessThan(1e-4);
    const random = new ScriptedRandom([0.5, 0.5, 1]);
    run(box({ directions: "1 0 0", distancemin: d, distancemax: d }), random);
    expect(random.calls).toHaveLength(4);
  });

  it("fastInvSqrt：0x5f375a86 加一次牛顿迭代（误差约 0.2%），0 得到大数", () => {
    for (const x of [4, 0.01, 2, 12345]) expect(Math.abs(fastInvSqrt(x) * Math.sqrt(x) - 1)).toBeLessThan(2e-3);
    expect(fastInvSqrt(4)).not.toBe(0.5);
    expect(fastInvSqrt(0)).toBeGreaterThan(1e18);
  });

  it("directions 0 0 0：回退后仍为 0，速度按 0（WPE 是 NaN）", () => {
    const random = new ScriptedRandom([0.2, 0.7, 0.9]);
    const { pos, vel } = run(box({ directions: "0 0 0", speedmin: 50, speedmax: 50 }), random);
    expect(random.calls).toHaveLength(7);
    expect(pos).toEqual([0, 0, 0]);
    expect(vel).toEqual([0, 0, 0]);
  });

  it("透视缺省 directions 1 1 1、distancemax 1 1 1；speedmin / max 乘 instanceoverride.speed", () => {
    const reading = readParticleModule("emitter", { name: "boxrandom" }, false);
    expect(reading.fields).toMatchObject({ directions: [1, 1, 1], distancemax: [1, 1, 1] });
    const fields = emitter({ speedmin: 2, speedmax: 3 }, "boxrandom", { ...ONE, speed: 2 });
    expect(fields).toMatchObject({ speedmin: 4, speedmax: 6 });
  });

  it("系统里：boxrandom 与 sphererandom 共用发射逻辑（周期、bit1）", () => {
    const def = parseParticle(
      {
        maxcount: 100,
        emitter: [{ name: "boxrandom", distancemax: "10 10 0", rate: 10, flags: 2, instantaneous: 3 }],
        initializer: [{ name: "lifetimerandom", min: 9, max: 9 }],
      },
      { file: "p.json", orthographic: true },
    );
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    const alive = [0.25, 0.25, 0.25, 0.25].map((dt) => {
      system.step(dt);
      return system.alive;
    });
    // 每帧 x 增 2.5：第一帧 3 + 1（acc = 2.5 − 5），第二帧 x = 0 还欠账，之后每帧 1 个
    expect(alive).toEqual([4, 4, 5, 6]);
  });
});

describe("控制点（P4c 步骤 1，rea-p4c-sim.md 第 3 节）", () => {
  const moduleOf = (category: "initializer" | "operator", module: JsonObject) => {
    const reading = readParticleModule(category, module, true);
    expect(reading.issues).toEqual([]);
    return resolveParticleFields(particleModuleDef(category, reading.name)!, reading.fields, ONE);
  };
  const initializer = (module: JsonObject) => moduleOf("initializer", module);
  const operator = (module: JsonObject) => moduleOf("operator", module);
  const HALF_PI = "0 0 1.5707964";
  /** 8 个控制点（emitter 写 controlpoint 7 撑满 n）；控制点 1 的 offset 是 (10, 20, 0)。 */
  const points = (instanceoverride: Record<string, string> = {}, extra: JsonObject = {}) =>
    new ControlPointSet(
      parseParticle(
        { emitter: [{ name: "sphererandom", controlpoint: 7 }], controlpoint: [{}, { offset: "10 20 0" }], ...extra },
        { file: "p.json", orthographic: true, instanceoverride },
      ),
    );
  const cpContext = (
    columns: ParticleColumns,
    random: ParticleRandom,
    controlPoints: ControlPointSet,
    world = false,
  ): ParticleRunContext => ({
    columns,
    random,
    slot: 0,
    count: 1,
    h: 0.1,
    k: 0.1,
    time: 0.3,
    controlPoints,
    world,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
  });
  const read = (columns: ParticleColumns) => ({
    pos: [0, 1, 2].map((i) => columns.position[i][0]),
    vel: [0, 1, 2].map((i) => columns.velocity[i][0]),
  });
  const close = (actual: number[], expected: number[]) =>
    actual.forEach((value, i) => expect(value, `第 ${i} 项`).toBeCloseTo(expected[i], 3));

  describe("sphererandom", () => {
    const fields = (module: JsonObject) =>
      emitter({
        origin: "1 2 3",
        directions: "1 0 0",
        sign: "1 0 0",
        distancemin: 100,
        distancemax: 100,
        speedmin: 50,
        speedmax: 50,
        ...module,
      });
    /** φ、cosθ（uA = 1 → cosθ = 1）、r，之后的都是 0.5。 */
    const draws = (more: number[] = []) => new ScriptedRandom([0.5, 1, 0.5, ...more]);
    const spawn = (module: JsonObject, controlPoints: ControlPointSet, world = false, random = draws()) => {
      const columns = new ParticleColumns(4, 0);
      const context = cpContext(columns, random, controlPoints, world);
      sphereRandom(fields(module), context);
      return { ...read(columns), context, random };
    };

    it("controlpoint ≠ 0：出生点与速度方向过 3×3；中心 = cp.t + origin，origin 不旋转；basis 交给 initializer", () => {
      const cp = points({ controlpointangle1: HALF_PI });
      const { pos, vel, context } = spawn({ controlpoint: 1 }, cp);
      close(pos, [0 + 10 + 1, 100 + 20 + 2, 3]);
      close(vel, [0, 50, 0]);
      expect(context.basis).toBe(cp.current(1).basis);
      // 没有角度：只平移
      const plain = spawn({ controlpoint: 1 }, points());
      close(plain.pos, [100 + 11, 22, 3]);
      close(plain.vel, [50, 0, 0]);
    });

    it("本地系统的控制点 0 带角度：出生点不旋，velocityrandom 的速度旋了（M 无条件）；世界空间时出生点也旋", () => {
      const cp = points({ controlpointangle0: HALF_PI });
      const local = spawn({}, cp);
      close(local.pos, [101, 2, 3]);
      close(local.vel, [50, 0, 0]);
      expect(local.context.basis).toBe(cp.current(0).basis);
      velocityRandom(initializer({ name: "velocityrandom", min: "50 0 0", max: "50 0 0" }), local.context);
      close(read(local.context.columns).vel, [50, 50, 0]);
      const world = spawn({}, cp, true);
      close(world.pos, [1, 102, 3]);
      close(world.vel, [0, 50, 0]);
    });

    it("回退方向（|q|² < 1e-4，另抽 3 个 uB）同样过 3×3", () => {
      const cp = points({ controlpointangle1: HALF_PI });
      // x 抽 1（方向 +x），y、z 抽 0.5（乘 directions 的 0）
      const rotated = spawn({ controlpoint: 1, distancemin: 0, distancemax: 0 }, cp, false, draws([1, 0.5, 0.5, 0.5]));
      expect(rotated.random.calls).toHaveLength(7);
      close(rotated.pos, [11, 22, 3]);
      close(rotated.vel, [0, 50, 0]);
      const plain = spawn(
        { controlpoint: 1, distancemin: 0, distancemax: 0 },
        points(),
        false,
        draws([1, 0.5, 0.5, 0.5]),
      );
      close(plain.vel, [50, 0, 0]);
    });

    it("|q|² 判的是旋转后的 q（汇编 0x140237f76 起对旋转结果求平方和）：3×3 把 q 缩小到 1e-2 以下就回退", () => {
      // 控制点 1 带 flags 2：本地系统 current = inverse(W)·base，W 放大 1000 倍时 3×3 是 0.001
      const cp = points({}, { controlpoint: [{}, { flags: 2 }] });
      cp.update({ world: scaling(1000, 1000, 1), pointer: [0, 0] });
      const small = spawn(
        { controlpoint: 1, distancemin: 0.5, distancemax: 0.5 },
        cp,
        false,
        draws([1, 0.5, 0.5, 0.5]),
      );
      expect(small.random.calls).toHaveLength(7);
      // 同样的 q 不缩小：|q|² = 0.25，不回退
      const plain = spawn({ controlpoint: 1, distancemin: 0.5, distancemax: 0.5 }, points(), false, draws());
      expect(plain.random.calls).toHaveLength(4);
    });
  });

  describe("boxrandom", () => {
    const fields = (module: JsonObject) =>
      emitter(
        { origin: "1 2 3", directions: "1 1 1", distancemax: "10 20 30", speedmin: 5, speedmax: 5, ...module },
        "boxrandom",
      );
    const spawn = (module: JsonObject, controlPoints: ControlPointSet, values: number[], world = false) => {
      const columns = new ParticleColumns(4, 0);
      const random = new ScriptedRandom([...values]);
      const context = cpContext(columns, random, controlPoints, world);
      boxRandom(fields(module), context);
      return { ...read(columns), context, random };
    };

    it("controlpoint ≠ 0：q 过 3×3 后加 origin + cp.t；方向用写进列的 float 减中心", () => {
      const cp = points({ controlpointangle1: HALF_PI });
      // z、y 抽 0.5（r = 0），x 抽 1（q = 10）
      const { pos, vel, context } = spawn({ controlpoint: 1 }, cp, [0.5, 0.5, 1, 0.5]);
      close(pos, [11, 10 + 22, 3]);
      close(vel, [0, 5, 0]);
      expect(context.basis).toBe(cp.current(1).basis);
      const plain = spawn({ controlpoint: 1 }, points(), [0.5, 0.5, 1, 0.5]);
      close(plain.pos, [21, 22, 3]);
    });

    it("回退方向同样过 3×3；控制点 0 本地不旋（basis 照样交出去），世界空间时旋", () => {
      const zero = { distancemax: "0 0 0" };
      const fallback = [0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5];
      const rotated = spawn({ controlpoint: 1, ...zero }, points({ controlpointangle1: HALF_PI }), fallback);
      expect(rotated.random.calls).toHaveLength(7);
      close(rotated.vel, [0, 5, 0]);
      const cp0 = points({ controlpointangle0: HALF_PI });
      const local = spawn(zero, cp0, fallback);
      close(local.vel, [5, 0, 0]);
      expect(local.context.basis).toBe(cp0.current(0).basis);
      close(spawn(zero, cp0, fallback, true).vel, [0, 5, 0]);
      close(spawn({}, cp0, [0.5, 0.5, 1, 0.5]).pos, [11, 2, 3]);
      close(spawn({}, cp0, [0.5, 0.5, 1, 0.5], true).pos, [1, 12, 3]);
    });
  });

  it("turbulentvelocityrandom：v += M·(dir·speed)，M 是发射器交来的 3×3", () => {
    const fields = initializer({ name: "turbulentvelocityrandom", speedmin: 100, speedmax: 100 });
    const run = (basis: Float32Array) => {
      const columns = new ParticleColumns(4, 0);
      columns.velocity[0][0] = 1;
      const context = { ...cpContext(columns, new ScriptedRandom([0.5, 0.5]), identityControlPoints()), basis };
      turbulentVelocityRandom(fields, context);
      return read(columns).vel;
    };
    const plain = run(IDENTITY_BASIS);
    const rotated = run(eulerBasis([0, 0, Math.PI / 2]));
    // 加上去的部分转了 90°，原有的速度 (1, 0, 0) 不转
    close(rotated, [-(plain[1] - 0) + 1, plain[0] - 1, plain[2]]);
    expect(Math.hypot(plain[0] - 1, plain[1])).toBeGreaterThan(50);
  });

  it("vortex：中心 = cp[controlpoint].t + offset，轴和 offset 不经 3×3", () => {
    const module = { name: "vortex", distanceinner: 50, distanceouter: 300, speedinner: 200, speedouter: 50 };
    const kick = (extra: JsonObject, position: number[], controlPoints: ControlPointSet) => {
      const columns = new ParticleColumns(4, 0);
      for (let i = 0; i < 3; i++) columns.position[i][0] = position[i];
      vortex(operator({ ...module, ...extra }), cpContext(columns, new ScriptedRandom(), controlPoints));
      return read(columns).vel;
    };
    // 距中心 100：t = 0.2，速度 (0.2·(50 − 200) + 200)·k = 17，方向 r̂ × z = −y
    close(kick({}, [100, 0, 0], identityControlPoints()), [0, -17, 0]);
    const cp = points({ controlpointangle1: "1.5707964 0 0", controlpoint1: "200 0 0" });
    close(kick({ controlpoint: 1 }, [300, 0, 0], cp), [0, -17, 0]);
    close(kick({ controlpoint: 1, offset: "5 0 0" }, [305, 0, 0], cp), [0, -17, 0]);
    // 不读控制点 0 以外的平移时（controlpoint 0），同一位置离中心 300：t = 1，速度 50·0.1
    close(kick({}, [300, 0, 0], cp), [0, -5, 0]);
  });
});
