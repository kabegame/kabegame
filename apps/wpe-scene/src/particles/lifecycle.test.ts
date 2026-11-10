/**
 * P4a 步骤 5：`instanceoverride` 运行时改值（`ParticleSystem.setInstance`）与不可见时的清空（`suspend`）。
 *
 * 依据：`rea-p4a.md` C5「运行时改值」、C8（`FUN_140230650` / `FUN_14022bd40` / `FUN_14022f6c0`，读码），并经主会话实测确认
 * （2026-11-07 实测，p4a-life：工程 `ignore/p4/proj/p4a-life`，轨迹 `ignore/p4/tracks/rd-life-*.json`）：
 * - 运行中隐藏：存活粒子清空；重新显示后照常发射，**不重新预热**（starttime 10 的系统重新显示约 3 秒后只有 7 个新粒子）；
 * - 运行中改 size ×2、alpha 0.5、rate 3、count 2、speed 2：已有粒子保留尺寸、alpha 与出生时的速度；新粒子尺寸、alpha、
 *   速度用新值；`rate` 立刻作用于全部粒子；新粒子间距对应发射率 rate × count。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, type ParticleInstanceValues, type SceneParticle } from "../compile/particles";
import type { EmitterState } from "./emitters";
import type { ParticleFields } from "./modules";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;

/** 发射器在原点、不散开，寿命 / 尺寸 / 速度固定；`extra` 覆盖系统级键。 */
function system(extra: JsonObject = {}, instanceoverride?: unknown): SceneParticle {
  return parseParticle(
    {
      maxcount: 64,
      emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10, speedmin: 0, speedmax: 0 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 40, max: 40 },
        { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
        { name: "angularvelocityrandom", min: "0 0 1", max: "0 0 1" },
      ],
      operator: [
        { name: "movement", gravity: "0 10 0" },
        { name: "oscillateposition", frequencymin: 1, frequencymax: 1, scalemin: 0, scalemax: 0 },
      ],
      ...extra,
    },
    { file: "p.json", orthographic: true, instanceoverride },
  );
}

/** 模拟器内部：各类模块乘过之后的字段与 emitter 状态。 */
interface Internals {
  emitters: { fields: ParticleFields; state: EmitterState }[];
  initializers: { fields: ParticleFields }[];
  operators: { fields: ParticleFields }[];
  alpha0: number;
  rate: number;
}
const internals = (value: ParticleSystem) => value as unknown as Internals;
const fieldsOf = (value: ParticleSystem) => {
  const { emitters, initializers, operators, alpha0, rate } = internals(value);
  return {
    emitters: emitters.map((module) => module.fields),
    initializers: initializers.map((module) => module.fields),
    operators: operators.map((module) => module.fields),
    alpha0,
    rate,
  };
};

const ALL: ParticleInstanceValues = {
  alpha: 0.5,
  size: 2,
  count: 3,
  speed: 4,
  lifetime: 5,
  rate: 0.25,
  brightness: 7,
  colorn: null,
};

describe("setInstance：从基值重新乘", () => {
  it("就地写 = 用新值新建系统：全部模块字段、a0、rate 逐项相同（resolveParticleFields 同一结果）", () => {
    for (const flags of [0, 0x10, 0x20, 0x40, 0x80, 0xf0, 4 | 8]) {
      const base = system({ flags }, { size: 1.5, count: 0.5 });
      const live = new ParticleSystem(base, new SeededRandom(1), 1);
      live.setInstance(ALL);
      const fresh = new ParticleSystem({ ...base, instance: { ...base.instance, ...ALL } }, new SeededRandom(1), 1);
      expect(fieldsOf(live), `flags ${flags}`).toEqual(fieldsOf(fresh));
      expect(live.instanceValues).toEqual(ALL);
    }
  });

  it("不累乘：连续写两次，结果只取决于最后一次的值", () => {
    const base = system({}, { size: 2 });
    const live = new ParticleSystem(base, new SeededRandom(1), 1);
    live.setInstance({ size: 3 });
    live.setInstance({ size: 3 });
    live.setInstance({ speed: 2 });
    const fresh = new ParticleSystem(
      { ...base, instance: { ...base.instance, size: 3, speed: 2 } },
      new SeededRandom(1),
      1,
    );
    expect(fieldsOf(live)).toEqual(fieldsOf(fresh));
    // 基值（编译结果）没被改
    expect(base.initializers[1].fields.min).toBe(40);
  });

  it("禁用位（C3）：flags bit4 speed、bit5 count、bit6 lifetime、bit7 size 改值不起作用", () => {
    const of = (flags: number, values: Partial<ParticleInstanceValues>) => {
      const live = new ParticleSystem(system({ flags }), new SeededRandom(1), 1);
      live.setInstance(values);
      return fieldsOf(live);
    };
    const plain = fieldsOf(new ParticleSystem(system(), new SeededRandom(1), 1));
    expect(of(0x10, { speed: 3 })).toEqual(plain);
    expect(of(0x20, { count: 3 })).toEqual(plain);
    expect(of(0x40, { lifetime: 3 })).toEqual(plain);
    expect(of(0x80, { size: 3 })).toEqual(plain);
    // 没有禁用位时确实会变
    expect(of(0, { speed: 3 })).not.toEqual(plain);
  });

  it("存活粒子保留出生时的 life、尺寸、a0、速度；新粒子用新值（2026-11-07 实测，p4a-life）", () => {
    const live = new ParticleSystem(system(), new SeededRandom(1), 1);
    live.step(0.1); // 1 个
    expect(live.alive).toBe(1);
    const c = live.columns;
    const born = { life: c.life[0], size0: c.size0[0], alpha0: c.alpha0[0], vx: c.velocity[0][0] };
    expect(born).toEqual({ life: 100, size0: 20, alpha0: 1, vx: 100 });
    live.setInstance({ size: 2, alpha: 0.5, lifetime: 2, speed: 2 });
    live.step(0.1); // 再 1 个
    expect(live.alive).toBe(2);
    expect({ life: c.life[0], size0: c.size0[0], alpha0: c.alpha0[0], vx: c.velocity[0][0] }).toEqual(born);
    expect(c.size[0]).toBe(20);
    expect(c.alpha[0]).toBe(1);
    expect({ life: c.life[1], size0: c.size0[1], alpha0: c.alpha0[1], vx: c.velocity[0][1] }).toEqual({
      life: 200,
      size0: 40,
      alpha0: 0.5,
      vx: 200,
    });
  });

  it("speed 乘的 operator 字段（重力）作用于全部粒子，从下一帧起", () => {
    const live = new ParticleSystem(system(), new SeededRandom(1), 1);
    live.step(0.1);
    const vy = live.columns.velocity[1][0];
    expect(vy).toBe(f32(10 * 0.1));
    live.setInstance({ speed: 3 });
    live.step(0.1);
    // 旧粒子这一帧按 30 的重力加速
    expect(live.columns.velocity[1][0]).toBe(f32(vy + f32(30 * 0.1)));
  });

  it("rate 下一帧生效，作用于全部粒子（dt' = dt·rate）；下限 0.01", () => {
    const live = new ParticleSystem(system({ operator: [{ name: "movement" }] }), new SeededRandom(1), 1);
    live.step(0.1);
    const x = live.columns.position[0][0];
    live.setInstance({ rate: 3 });
    live.step(0.1);
    expect(live.columns.position[0][0]).toBeCloseTo(x + 100 * 0.3, 4);
    // 出生那帧 age 为 0，下一帧按 dt' = 0.3 增长
    expect(live.columns.age[0]).toBeCloseTo(0.3, 6);
    live.setInstance({ rate: 0 });
    const before = live.columns.position[0][0];
    live.step(1);
    expect(live.columns.position[0][0]).toBeCloseTo(before + 100 * 0.01, 3);
  });

  it("count 乘发射 rate，不改容量、不重建列", () => {
    const live = new ParticleSystem(system({ maxcount: 16 }), new SeededRandom(1), 1);
    const buffer = live.columns.buffer;
    live.step(0.5); // 10/s → 5
    expect(live.alive).toBe(5);
    live.setInstance({ count: 2 });
    live.step(0.5); // 20/s → +10
    expect(live.alive).toBe(15);
    live.step(0.5); // 满了
    expect(live.alive).toBe(16);
    expect(live.columns.capacity).toBe(16);
    expect(live.columns.buffer).toBe(buffer);
  });

  it("已结束、新 rate > 0 的 emitter 重新打开（FUN_14022bd40 param_2 = 1）；rate 仍为 0 时保持结束", () => {
    const live = new ParticleSystem(system({}, { count: 0 }), new SeededRandom(1), 1);
    live.step(0.5);
    const state = internals(live).emitters[0].state;
    expect(state.ended).toBe(true);
    expect(live.alive).toBe(0);
    live.setInstance({ count: 0, size: 2 });
    expect(state.ended).toBe(true);
    live.setInstance({ count: 1 });
    expect(state.ended).toBe(false);
    live.step(0.5);
    expect(live.alive).toBe(5);
  });

  it("brightness 不影响模拟", () => {
    const live = new ParticleSystem(system(), new SeededRandom(1), 1);
    const before = fieldsOf(live);
    live.setInstance({ brightness: 9 });
    expect(fieldsOf(live)).toEqual(before);
  });
});

describe("suspend：不可见的一帧（C8）", () => {
  it("有存活粒子：清空全部粒子，复位 emitter 计时（acc、待发 instantaneous），已结束标志不动", () => {
    const def = system({ emitter: [{ name: "sphererandom", distancemax: 0, rate: 3, instantaneous: 2 }] });
    const live = new ParticleSystem(def, new SeededRandom(1), 1);
    live.step(0.5); // 2 个瞬发 + 1.5 → 3 个，acc 0.5
    expect(live.alive).toBe(3);
    const state = internals(live).emitters[0].state;
    expect(state.pending).toBe(0);
    expect(state.acc).toBeCloseTo(-1.5, 5);
    expect(live.suspend()).toBe(true);
    expect(live.alive).toBe(0);
    expect(live.highWater).toBe(0);
    expect(live.columns.life.every((value) => value === 0)).toBe(true);
    expect(state).toEqual({
      acc: 0,
      pending: 2,
      delay: 0,
      duration: 0,
      ended: false,
      burst: 0,
      period: 0,
      periodStarted: false,
    });
    // 重新可见：照常发射（瞬发又来一次），不重新预热
    live.step(0.1);
    expect(live.alive).toBe(2);
  });

  it("没有存活粒子：什么都不做（不复位计时）", () => {
    const live = new ParticleSystem(system({ maxcount: 4 }), new SeededRandom(1), 1);
    live.step(0.05); // 0.5 个，acc 0.5
    expect(live.alive).toBe(0);
    const state = internals(live).emitters[0].state;
    const acc = state.acc;
    expect(acc).toBeCloseTo(0.5, 6);
    expect(live.suspend()).toBe(false);
    expect(state.acc).toBe(acc);
  });

  it("已结束的 emitter 清空后仍是结束的（flags 不在复位范围）", () => {
    const def = system({ emitter: [{ name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 3 }] });
    const live = new ParticleSystem(def, new SeededRandom(1), 1);
    live.step(0.1);
    expect(live.alive).toBe(3);
    const state = internals(live).emitters[0].state;
    expect(state.ended).toBe(true);
    live.suspend();
    expect(state).toMatchObject({ pending: 3, ended: true });
    live.step(0.1);
    expect(live.alive).toBe(0);
  });

  it("重新可见不重新预热：starttime 的系统清空后只按帧发射（2026-11-07 实测，p4a-life）", () => {
    const live = new ParticleSystem(system({ starttime: 10 }), new SeededRandom(1), 1);
    live.prewarm();
    expect(live.alive).toBe(64); // 10 s × 10/s，容量 64
    live.suspend();
    live.step(0.5);
    expect(live.alive).toBe(5);
  });
});
