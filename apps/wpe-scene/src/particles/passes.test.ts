// 帧率设置就地生效：operator 遍数运行中换（ParticleSystem.setPasses），整棵树一起换，之后新建的实例从父上取。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { childLocalMatrix, parseParticle, type ParticleChildType, type SceneParticle } from "../compile/particles";
import { SeededRandom } from "./random";
import { ParticleSystem, particlePasses } from "./system";

const f32 = Math.fround;
const parse = (json: JsonObject): SceneParticle => parseParticle(json, { file: "p.json", orthographic: true });

/** 根系统带一个 static 子系统与一个 eventspawn 子系统（父每出生一个粒子建一个实例）。 */
function tree(): SceneParticle {
  const root = parse({
    maxcount: 64,
    emitter: [{ name: "sphererandom", distancemax: 0, rate: 60 }],
    initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    operator: [{ name: "movement" }],
  });
  const child = parse({
    maxcount: 8,
    emitter: [{ name: "sphererandom", distancemax: 0, rate: 60 }],
    initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    operator: [{ name: "movement" }],
  });
  for (const type of ["static", "eventspawn"] as ParticleChildType[])
    root.children.push({
      index: root.children.length,
      type,
      flags: 0,
      controlPointStartIndex: 0,
      probability: 1,
      maxcount: 4,
      local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
      system: child,
    });
  return root;
}

describe("模拟器：运行中换 operator 遍数（ParticleSystem.setPasses）", () => {
  it("particlePasses：1–20 两遍，0、负数与 21 以上一遍", () => {
    expect([1, 10, 20].map(particlePasses)).toEqual([2, 2, 2]);
    expect([0, -5, 21, 30, 60, 144].map(particlePasses)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("整棵树一起换：根、static 子系统、事件池的活跃与空闲实例；之后新建的实例取父的新值", () => {
    const system = new ParticleSystem(tree(), new SeededRandom(1), 1);
    system.step(f32(0.05));
    const pool = system.events[0];
    expect(pool.active.length).toBeGreaterThan(1);
    // 挪一个到空闲表：只验证遍历覆盖两张表（真实回收由实例结束触发）
    pool.free.push(pool.active.pop()!);
    const instances = [...pool.active, ...pool.free];
    expect(instances.every((instance) => instance.passes === 1)).toBe(true);

    system.setPasses(2);
    expect(system.passes).toBe(2);
    expect(system.node([0])!.passes).toBe(2);
    for (const instance of instances) expect(instance.passes).toBe(2);

    // 之后新建或复用的实例都是新值（新建的构造时读父的 `this.passes`）
    system.step(f32(0.05));
    expect(pool.active.some((instance) => !instances.includes(instance))).toBe(true);
    for (const instance of [...pool.active, ...pool.free]) expect(instance.passes).toBe(2);

    system.setPasses(1);
    for (const instance of [system, system.node([0])!, ...pool.active, ...pool.free]) expect(instance.passes).toBe(1);
  });

  it("中途切遍数之后的步进与一开始就用新遍数的步进对得上存活数（遍数不留状态）", () => {
    const def = () =>
      parse({
        maxcount: 64,
        emitter: [{ name: "sphererandom", distancemax: 0, rate: 60 }],
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "velocityrandom", min: "-10 -10 0", max: "10 10 0" },
        ],
        operator: [{ name: "movement", drag: 0.5 }],
      });
    const switched = new ParticleSystem(def(), new SeededRandom(7), 1);
    switched.setPasses(2);
    const fixed = new ParticleSystem(def(), new SeededRandom(7), 2);
    for (let i = 0; i < 10; i++) {
      switched.step(f32(1 / 30));
      fixed.step(f32(1 / 30));
    }
    expect(switched.alive).toBe(fixed.alive);
    const columnsOf = (system: ParticleSystem) =>
      system.columns.position.map((lane) => Array.from(lane.subarray(0, system.highWater)));
    expect(columnsOf(switched)).toEqual(columnsOf(fixed));
  });
});
