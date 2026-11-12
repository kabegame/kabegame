/**
 * P4f 步骤 1 的模拟器单测：`instanceoverride.rate` 的单独路径（`ParticleSystem.setRate`）与重算时的钳制（`setInstance`）。
 * 依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4f-script.md` 5.2–5.4、6.1（读码），实测 `b-rate0`（p4-particles-REPORT.md
 * 「P4f 语义的实测核对」）：
 * - `rate` 没有改值回调：单写它只改步进率，不钳制（0 / 负数整棵树冻结）、不重乘模块字段（湍流类 `timescale` 不跟）、不重开发射器；
 * - 置脏重算时先把 `rate` 钳到 0.01 并写回，再从基值重乘（`timescale` 这时跟上）、重开 `rate > 0` 的已结束发射器；加载时同样钳一次；
 * - 冻结（`dt′ ≤ 0`）：系统时间、图层时间照样 `+= dt′`，模拟整段跳过，子孙共享同一个 `dt′`。
 */
import { describe, expect, it } from "vitest";
import { childLocalMatrix, parseParticle, type ParticleChildType, type SceneParticle } from "../compile/particles";
import type { JsonObject } from "../compile/model";
import { translation } from "../render/math";
import type { EmitterState } from "./emitters";
import type { ParticleFields } from "./modules";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;

const parse = (json: JsonObject, instanceoverride?: unknown): SceneParticle =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });

/** 每秒 10 个、寿命 100、速度 (100, 0, 0) 匀速移动的系统；`extra` 覆盖系统级键。 */
function movingJson(extra: JsonObject = {}): JsonObject {
  return {
    maxcount: 64,
    emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10 }],
    initializer: [
      { name: "lifetimerandom", min: 100, max: 100 },
      { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
    ],
    operator: [{ name: "movement" }],
    ...extra,
  };
}

function attach(parent: SceneParticle, child: SceneParticle, type: ParticleChildType): SceneParticle {
  parent.children.push({
    index: parent.children.length,
    type,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
    system: child,
  });
  return child;
}

/** 模拟器内部：模块字段、发射器状态与步进率（私有字段）。 */
interface Internals {
  emitters: { state: EmitterState }[];
  initializers: { name: string; fields: ParticleFields }[];
  operators: { name: string; fields: ParticleFields }[];
  rate: number;
}
const internals = (system: ParticleSystem) => system as unknown as Internals;
const timescaleOf = (system: ParticleSystem, name: string) =>
  [...internals(system).initializers, ...internals(system).operators].find((module) => module.name === name)!.fields
    .timescale as number;

/** 根（带 static 子系统与 eventfollow 条目）、static 子系统、全部活跃事件实例。 */
function nodes(system: ParticleSystem): ParticleSystem[] {
  return [system, ...system.statics.map((child) => child.system), ...system.events.flatMap((pool) => pool.active)];
}
/** 一个系统的可比快照：存活数、高水位、各列（位置、年龄、寿命）、系统时间。 */
function snapshot(system: ParticleSystem) {
  const { position, age, life } = system.columns;
  const n = system.highWater;
  return {
    alive: system.alive,
    highWater: n,
    position: position.map((column) => Array.from(column.subarray(0, n))),
    age: Array.from(age.subarray(0, n)),
    life: Array.from(life.subarray(0, n)),
    systemTime: system.systemTime,
  };
}

/** 根每秒 10 个，带一个 static 子系统与一个 eventfollow 条目（子系统都在动）。 */
function tree(): ParticleSystem {
  const root = parse(movingJson());
  attach(root, parse(movingJson({ maxcount: 32 })), "static");
  attach(root, parse(movingJson({ maxcount: 32 })), "eventfollow");
  return new ParticleSystem(root, new SeededRandom(1), 1);
}
const run = (system: ParticleSystem, frames: number, dt = 0.1) => {
  for (let i = 0; i < frames; i++) system.step(dt, undefined, { world: translation(0, 0, 0), pointer: [0, 0] });
};

describe("setRate：只改步进率（rea-p4f-script.md 5.4）", () => {
  it("setRate(0) 冻结整棵树：根、static 子系统与事件实例都不增龄、不发射、不移动；系统时间与图层时间不变；恢复后照常", () => {
    const system = tree();
    run(system, 5);
    const before = nodes(system).map(snapshot);
    // 根、static 子系统、5 个 eventfollow 实例（各自出生先后）
    expect(before.map((item) => item.alive)).toEqual([5, 5, 5, 4, 3, 2, 1]);
    const layerTime = system.layerTime;
    system.setRate(0);
    run(system, 10);
    expect(nodes(system).map(snapshot)).toEqual(before);
    expect(system.layerTime).toBe(layerTime);
    // 冻结期间事件实例不回收、不新建
    expect([system.events[0].active.length, system.events[0].free.length]).toEqual([5, 0]);
    system.setRate(1);
    run(system, 1);
    expect(system.alive).toBe(6);
    expect(system.columns.position[0][0]).toBeCloseTo(before[0].position[0][0] + 10, 3);
    expect(system.statics[0].system.alive).toBe(6);
  });

  it("负的 rate：同样冻结，系统时间与图层时间按 dt′ 倒退（0x1402308c2、0x140230810 的 addss 不看正负）", () => {
    const system = tree();
    run(system, 3);
    const before = snapshot(system);
    const child = snapshot(system.statics[0].system);
    const layerTime = system.layerTime;
    system.setRate(-0.5);
    run(system, 2);
    const dt = f32(f32(0.1) * f32(-0.5));
    const after = snapshot(system);
    expect(after.systemTime).toBe(f32(f32(before.systemTime + dt) + dt));
    expect(system.layerTime).toBe(f32(f32(layerTime + dt) + dt));
    expect(system.statics[0].system.systemTime).toBe(f32(f32(child.systemTime + dt) + dt));
    expect({ ...after, systemTime: 0 }).toEqual({ ...before, systemTime: 0 });
  });

  it("不钳制、不重乘：rate 0.005 照用（dt′ = dt·0.005），湍流类 timescale 仍是上一次重算的值；写别的系数后才跟上、并钳到 0.01", () => {
    const json = movingJson({
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "turbulentvelocityrandom", timescale: 2 },
      ],
      operator: [{ name: "turbulence", timescale: 4 }],
    });
    const system = new ParticleSystem(parse(json, { rate: 0.5 }), new SeededRandom(1), 1);
    expect([timescaleOf(system, "turbulentvelocityrandom"), timescaleOf(system, "turbulence")]).toEqual([1, 2]);
    system.setRate(3);
    expect(internals(system).rate).toBe(3);
    expect(system.instanceScalar("rate")).toBe(3);
    expect([timescaleOf(system, "turbulentvelocityrandom"), timescaleOf(system, "turbulence")]).toEqual([1, 2]);
    // 别的系数被写（置脏重算）：timescale 按当前的 rate 跟上
    system.setInstance({ ...system.instanceValues, count: 2 });
    expect([timescaleOf(system, "turbulentvelocityrandom"), timescaleOf(system, "turbulence")]).toEqual([6, 12]);
    // 小于 0.01：单写照用
    system.setRate(0.005);
    expect(internals(system).rate).toBe(f32(0.005));
    const time = system.systemTime;
    run(system, 1);
    expect(system.systemTime).toBe(f32(time + f32(f32(0.1) * f32(0.005))));
    // 重算时钳到 0.01（写回实例值，调用方据此写回状态），timescale 用钳过的值
    system.setInstance(system.instanceValues);
    expect(system.instanceScalar("rate")).toBe(0.01);
    expect(internals(system).rate).toBe(f32(0.01));
    expect(timescaleOf(system, "turbulentvelocityrandom")).toBe(f32(2 * f32(0.01)));
  });

  it("同一帧先 setRate(0) 再 setInstance（sync 的顺序）：结果是钳过的 0.01，不冻结", () => {
    const system = tree();
    run(system, 2);
    system.setRate(0);
    system.setInstance({ ...system.instanceValues, rate: 0, count: 2 });
    expect(system.instanceScalar("rate")).toBe(0.01);
    expect(internals(system).rate).toBe(f32(0.01));
    // 子孙收到的实例值同样是钳过的
    expect(system.statics[0].system.instanceValues.rate).toBe(0.01);
    const time = system.systemTime;
    run(system, 1);
    expect(system.systemTime).toBe(f32(time + f32(f32(0.1) * f32(0.01))));
  });

  it("不重开已结束的发射器（重开在重算里）；每帧 setInstance 写同值照旧重开 rate > 0 的已结束发射器", () => {
    const system = new ParticleSystem(
      parse(movingJson({ emitter: [{ name: "sphererandom", distancemax: 0, rate: 10, duration: 0.2 }] })),
      new SeededRandom(1),
      1,
    );
    run(system, 4);
    const state = internals(system).emitters[0].state;
    expect(state.ended).toBe(true);
    system.setRate(1);
    expect(state.ended).toBe(true);
    // 每帧写同一个值（字段脚本每帧都写，WPE 不比较新旧值，6.2、6.4）：照旧重开；`duration` 已用完（−1），重开后不连续发射（5.3）
    system.setInstance(system.instanceValues);
    expect(state.ended).toBe(false);
    const alive = system.alive;
    run(system, 2);
    expect(system.alive).toBe(alive);
    system.setInstance(system.instanceValues);
    expect(state.ended).toBe(false);
  });

  it("每帧写同值的重开：count 切到 0 自然结束，再写回 rate > 0 的值就恢复发射（单写 rate 不行）", () => {
    const system = new ParticleSystem(parse(movingJson(), { count: 0 }), new SeededRandom(1), 1);
    run(system, 2);
    const state = internals(system).emitters[0].state;
    expect([state.ended, system.alive]).toEqual([true, 0]);
    system.setRate(2);
    run(system, 1);
    expect([state.ended, system.alive]).toEqual([true, 0]);
    system.setInstance({ ...system.instanceValues, count: 1 });
    expect(state.ended).toBe(false);
    run(system, 5);
    expect(system.alive).toBe(10);
  });
});

describe("加载与子系统的实例值", () => {
  it("加载时 rate 钳到 0.01（6.1），static 子系统拿到的也是钳过的值", () => {
    const root = parse(movingJson(), { rate: 0 });
    attach(root, parse(movingJson({ maxcount: 32 })), "static");
    const system = new ParticleSystem(root, new SeededRandom(1), 1);
    expect(system.instanceScalar("rate")).toBe(0.01);
    expect(internals(system).rate).toBe(f32(0.01));
    expect(system.statics[0].system.instanceValues.rate).toBe(0.01);
  });

  it("setRate 之后新建的事件实例读对象当前的 rate（FUN_14022f890 读 io），timescale 按它乘；已有的 static 子系统等重算才跟上", () => {
    const root = parse(movingJson({ maxcount: 8 }));
    attach(root, parse(movingJson({ maxcount: 8 })), "static");
    attach(
      root,
      parse(
        movingJson({
          maxcount: 8,
          initializer: [
            { name: "lifetimerandom", min: 100, max: 100 },
            { name: "turbulentvelocityrandom", timescale: 2 },
          ],
        }),
      ),
      "eventspawn",
    );
    const system = new ParticleSystem(root, new SeededRandom(1), 1);
    run(system, 1);
    const first = system.events[0].active[0];
    expect(timescaleOf(first, "turbulentvelocityrandom")).toBe(2);
    system.setRate(0.5);
    run(system, 2);
    const second = system.events[0].active[1];
    expect(second.instanceValues.rate).toBe(0.5);
    expect(timescaleOf(second, "turbulentvelocityrandom")).toBe(1);
    expect(timescaleOf(first, "turbulentvelocityrandom")).toBe(2);
    expect(system.statics[0].system.instanceValues.rate).toBe(1);
    system.setInstance(system.instanceValues);
    expect(timescaleOf(first, "turbulentvelocityrandom")).toBe(1);
    expect(system.statics[0].system.instanceValues.rate).toBe(0.5);
  });
});

describe("suspend 的冻结帧", () => {
  it("rate 0：不可见的帧照样复位，但控制点不更新（WPE 的更新在被跳过的模拟里），系统时间不变", () => {
    // 世界空间系统（控制点是 W·base）；引用控制点 0 的 operator（scale 0，不改粒子）让控制点存在
    const json = movingJson({
      flags: 1,
      operator: [{ name: "movement" }, { name: "controlpointattract", controlpoint: 0, scale: 0 }],
    });
    const system = new ParticleSystem(parse(json), new SeededRandom(1), 1);
    system.prewarm();
    run(system, 2);
    expect(system.alive).toBe(2);
    const current = Array.from(system.controlPoints.current(0).translation);
    system.setRate(0);
    const moved = { world: translation(50, 0, 0), pointer: [0, 0] as const };
    expect(system.suspend(moved, 0.1)).toBe(true);
    expect(system.alive).toBe(0);
    expect(Array.from(system.controlPoints.current(0).translation)).toEqual(current);
    expect(system.systemTime).toBe(0);
    // 解冻后的不可见帧照常更新
    system.setRate(1);
    system.suspend(moved, 0.1);
    expect(Array.from(system.controlPoints.current(0).translation)).toEqual([50, 0, 0]);
    expect(system.systemTime).toBe(f32(0.1));
  });
});
