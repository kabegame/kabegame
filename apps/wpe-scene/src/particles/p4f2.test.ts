/**
 * P4f 步骤 2 的模拟器单测：HDR 下 `instanceoverride.brightness` 乘新粒子的颜色初值（`ParticleSystem.applyColorn`）。依据
 * `.claude/plans/wpe-import/3-scene/phase4/rea-p4f-script.md` 第 7 节（`FUN_1401d15a0` 开头），实测 `p4f-bright`（p4-particles-REPORT.md
 * 「P4f 语义的实测核对」：超高档 0.5 / 2 得 0.235 / 0.941，`colorn` 的 (0.25, 1, 0.25) 乘 2 得 (0.5, 2, 0.5)，`alpha` 不变，`flags 8`
 * 不变，关闭档全部不变）：
 * - `k = (HDR && !(flags & 8)) ? brightness : 1`，HDR 是编译期写进系统定义的 `def.hdr`；
 * - 实例颜色 = `colorn·k`（`colorn` 生效且 `0x200000`）或 `(k, k, k)`，逐通道 float32、不钳制，alpha 不乘；
 * - 改值置脏重算，只影响之后出生的粒子；static 子系统、事件实例各看自己的 `flags & 8`，值取对象（根）上的那一份。
 */
import { describe, expect, it } from "vitest";
import { childLocalMatrix, parseParticle, type ParticleChildType, type SceneParticle } from "../compile/particles";
import type { JsonObject } from "../compile/model";
import { lerp } from "./f32";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;

interface ParseOptions {
  hdr?: boolean;
  instanceoverride?: unknown;
  sceneVersion?: number;
}
const parse = (json: JsonObject, options: ParseOptions = {}): SceneParticle =>
  parseParticle(json, { file: "p.json", orthographic: true, ...options });

/** 每秒 4 个（步长 0.25 时一帧一个）、不动、寿命 `life` 的系统；`modules` 加颜色模块与 `flags`。 */
function systemJson(modules: { initializer?: JsonObject[]; operator?: JsonObject[]; flags?: number; life?: number }) {
  const life = modules.life ?? 4;
  return {
    maxcount: 8,
    flags: modules.flags ?? 0,
    emitter: [{ name: "sphererandom", origin: "100 100 0", distancemax: 0, rate: 4 }],
    initializer: [
      { name: "lifetimerandom", min: life, max: life },
      { name: "sizerandom", min: 10, max: 10 },
      { name: "velocityrandom", min: "0 0 0", max: "0 0 0" },
      ...(modules.initializer ?? []),
    ],
    operator: [{ name: "movement", gravity: "0 0 0" }, ...(modules.operator ?? [])],
  };
}

/** `colorrandom` 单色 120/255 ≈ 0.471（`p4f-bright` 的基色）。 */
const GREY = { initializer: [{ name: "colorrandom", min: "120 120 120", max: "120 120 120" }] };

/** 模拟器内部：新粒子的颜色初值（私有字段）。 */
const instanceColor = (system: ParticleSystem) => [...(system as unknown as { instanceColor: number[] }).instanceColor];

/** 一个槽的颜色当前值。 */
function colorOf(system: ParticleSystem, slot = 0): number[] {
  return [0, 1, 2].map((i) => system.columns.color[i][slot]);
}

/** 建系统、走一帧出生一个粒子。 */
function spawn(def: SceneParticle): ParticleSystem {
  const system = new ParticleSystem(def, new SeededRandom(1), 1);
  system.step(0.25);
  expect(system.alive).toBe(1);
  return system;
}

describe("实例颜色乘 k（rea-p4f-script.md 第 7 节）", () => {
  it("HDR、没有 colorn：实例颜色 (k, k, k)，颜色模块乘在它上面（p4f-bright：0.5 / 2 得 0.235 / 0.941）", () => {
    const base = colorOf(spawn(parse(systemJson(GREY), { sceneVersion: 5 })));
    expect(base[0]).toBeCloseTo(0.4706, 4);
    for (const k of [0.5, 2]) {
      const system = spawn(
        parse(systemJson(GREY), { hdr: true, sceneVersion: 5, instanceoverride: { brightness: k } }),
      );
      expect(instanceColor(system), String(k)).toEqual([k, k, k]);
      // 出生先写 k，`colorrandom` 再乘上去（`rgb = 抽到的颜色 · rgb`）
      expect(colorOf(system), String(k)).toEqual(base.map((c) => f32(k * c)));
    }
    const half = spawn(parse(systemJson(GREY), { hdr: true, sceneVersion: 5, instanceoverride: { brightness: 0.5 } }));
    const double = spawn(parse(systemJson(GREY), { hdr: true, sceneVersion: 5, instanceoverride: { brightness: 2 } }));
    expect(colorOf(half)[0]).toBeCloseTo(0.235, 3);
    expect(colorOf(double)[0]).toBeCloseTo(0.941, 3);
  });

  it("没有颜色模块时也乘：新粒子颜色就是 (k, k, k)，不钳到 1", () => {
    const system = spawn(parse(systemJson({}), { hdr: true, instanceoverride: { brightness: 3 } }));
    expect(colorOf(system)).toEqual([3, 3, 3]);
  });

  it("colorn 生效（0x200000）时乘在 colorn 之后：(0.25, 1, 0.25) 乘 2 得 (0.5, 2, 0.5)", () => {
    const system = spawn(
      parse(systemJson({}), { hdr: true, instanceoverride: { colorn: "0.25 1 0.25", brightness: 2 } }),
    );
    expect(instanceColor(system)).toEqual([0.5, 2, 0.5]);
    expect(colorOf(system)).toEqual([0.5, 2, 0.5]);
  });

  it("逐通道 float32：colorn 与 k 各自先舍入成 float32，乘积再舍入（mulss）", () => {
    const system = spawn(
      parse(systemJson({}), { hdr: true, instanceoverride: { colorn: "0.1 0.3 0.7", brightness: 1.1 } }),
    );
    const expected = [0.1, 0.3, 0.7].map((c) => f32(f32(c) * f32(1.1)));
    expect(instanceColor(system)).toEqual(expected);
    expect(colorOf(system)).toEqual(expected);
  });

  it("colorn 生效但没有 0x200000（version 5 且有颜色模块）：平移照做，实例颜色是 (k, k, k)", () => {
    const red = { initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }] };
    const plain = spawn(parse(systemJson(red), { sceneVersion: 5, instanceoverride: { colorn: "0 1 0" } }));
    expect(colorOf(plain)).toEqual([0, 1, 0]);
    const lit = spawn(
      parse(systemJson(red), { hdr: true, sceneVersion: 5, instanceoverride: { colorn: "0 1 0", brightness: 2 } }),
    );
    expect(instanceColor(lit)).toEqual([2, 2, 2]);
    expect(colorOf(lit)).toEqual([0, 2, 0]);
  });

  it("flags & 8：k = 1（colorn 同样不生效），和不写 brightness 逐项相同", () => {
    const masked = (instanceoverride: JsonObject) =>
      spawn(parse(systemJson({ ...GREY, flags: 8 }), { hdr: true, instanceoverride }));
    const plain = masked({});
    const bright = masked({ brightness: 2, colorn: "0 1 0" });
    expect(instanceColor(bright)).toEqual([1, 1, 1]);
    expect(colorOf(bright)).toEqual(colorOf(plain));
    // 别的位不影响
    for (const flags of [1, 2, 4, 0x10, 0x80]) {
      const system = spawn(parse(systemJson({ flags }), { hdr: true, instanceoverride: { brightness: 2 } }));
      expect(instanceColor(system), String(flags)).toEqual([2, 2, 2]);
    }
  });

  it("LDR（关闭档）：brightness 不起作用，有无 colorn 都和 brightness 1 逐项相同", () => {
    for (const overrides of [{}, { colorn: "0.25 1 0.25" }]) {
      const plain = spawn(parse(systemJson({}), { instanceoverride: { ...overrides, brightness: 1 } }));
      const bright = spawn(parse(systemJson({}), { instanceoverride: { ...overrides, brightness: 5 } }));
      expect(instanceColor(bright), JSON.stringify(overrides)).toEqual(instanceColor(plain));
      expect(colorOf(bright), JSON.stringify(overrides)).toEqual(colorOf(plain));
    }
    // HDR 下 brightness 1 同样是恒等
    const one = spawn(parse(systemJson(GREY), { hdr: true, sceneVersion: 5, instanceoverride: { brightness: 1 } }));
    expect(colorOf(one)).toEqual(colorOf(spawn(parse(systemJson(GREY), { sceneVersion: 5 }))));
  });

  it("alpha 不乘 k：新粒子的 a0 仍是 instanceoverride.alpha", () => {
    const system = spawn(parse(systemJson({}), { hdr: true, instanceoverride: { alpha: 0.5, brightness: 2 } }));
    expect(colorOf(system)).toEqual([2, 2, 2]);
    expect(system.columns.alpha0[0]).toBe(0.5);
    expect(system.columns.alpha[0]).toBe(0.5);
  });

  it("colorchange 每遍从颜色初值复制再乘，k 一直带着", () => {
    const change = { operator: [{ name: "colorchange", startvalue: "1 0 0", endvalue: "0 0 1" }], life: 1 };
    const system = new ParticleSystem(
      parse(systemJson(change), { hdr: true, sceneVersion: 5, instanceoverride: { brightness: 2 } }),
      new SeededRandom(1),
      1,
    );
    system.step(0.25); // 出生，age 0
    expect(colorOf(system)).toEqual([2, 0, 0]);
    system.step(0.5); // age 0.5
    const t = f32(0.5);
    const lerped = [lerp(1, f32(0 - 1), t), lerp(0, 0, t), lerp(0, f32(1 - 0), t)];
    expect(colorOf(system)).toEqual(lerped.map((c) => f32(2 * c)));
  });
});

describe("运行中改 brightness（setInstance 置脏重算）", () => {
  it("只影响之后出生的粒子：已有粒子的颜色不变", () => {
    const system = spawn(parse(systemJson({}), { hdr: true, instanceoverride: { brightness: 2 } }));
    expect(colorOf(system, 0)).toEqual([2, 2, 2]);
    system.setInstance({ brightness: 3 });
    expect(instanceColor(system)).toEqual([3, 3, 3]);
    expect(colorOf(system, 0)).toEqual([2, 2, 2]);
    system.step(0.25);
    expect(system.alive).toBe(2);
    expect(colorOf(system, 0)).toEqual([2, 2, 2]);
    expect(colorOf(system, 1)).toEqual([3, 3, 3]);
  });

  it("从基值重算、不累乘：改两次只看最后的值；和 colorn 一起改时同样乘在 colorn 之后", () => {
    const system = spawn(parse(systemJson({}), { hdr: true, instanceoverride: { brightness: 2 } }));
    system.setInstance({ brightness: 3 });
    system.setInstance({ brightness: 0.5 });
    expect(instanceColor(system)).toEqual([0.5, 0.5, 0.5]);
    system.setInstance({ colorn: [0.25, 1, 0.25], brightness: 4 });
    expect(instanceColor(system)).toEqual([1, 4, 1]);
  });

  it("LDR、flags & 8：改 brightness 实例颜色不变", () => {
    for (const [hdr, flags] of [
      [false, 0],
      [true, 8],
    ] as const) {
      const system = spawn(parse(systemJson({ flags }), { hdr, instanceoverride: { brightness: 2 } }));
      system.setInstance({ brightness: 7 });
      expect(instanceColor(system), `${hdr} ${flags}`).toEqual([1, 1, 1]);
    }
  });
});

describe("子系统与事件实例各看自己的 flags & 8（rea-p4f-script.md 第 7 节「运行中改值」）", () => {
  /** 父发射器每秒 10 个、寿命 `life`，从原点发射。 */
  function parentJson(flags: number, life = 100): JsonObject {
    return {
      maxcount: 32,
      flags,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 10 }],
      initializer: [{ name: "lifetimerandom", min: life, max: life }],
    };
  }
  /** 子系统：一出生就爆发 1 个、寿命 `life`（之后发射器结束，粒子死了实例就不再活跃）。 */
  function childJson(flags: number, life = 100): JsonObject {
    return {
      maxcount: 8,
      flags,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1 }],
      initializer: [{ name: "lifetimerandom", min: life, max: life }],
    };
  }
  function attach(parent: SceneParticle, child: SceneParticle, type: ParticleChildType): void {
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
  }
  /** 根 + 一个 static 子系统 + 一个 eventspawn 条目；全部 HDR，实例覆盖只在根上（子系统从根取）。 */
  function tree(flags: { root: number; static: number; event: number }, eventLife = 100): ParticleSystem {
    const root = parse(parentJson(flags.root), { hdr: true, instanceoverride: { brightness: 2 } });
    attach(root, parse(childJson(flags.static), { hdr: true }), "static");
    attach(root, parse(childJson(flags.event, eventLife), { hdr: true }), "eventspawn");
    return new ParticleSystem(root, new SeededRandom(1), 1);
  }
  const run = (system: ParticleSystem, frames: number) => {
    for (let i = 0; i < frames; i++) system.step(0.1);
  };

  it("static 子系统与事件实例按自己的 flags & 8 定 k，值是对象上的 brightness；根的 flags 不影响子孙", () => {
    const system = tree({ root: 0, static: 8, event: 0 });
    run(system, 2);
    const instances = system.events[0].active;
    expect(instances.length).toBe(2);
    expect(instanceColor(system)).toEqual([2, 2, 2]);
    expect(instanceColor(system.statics[0].system)).toEqual([1, 1, 1]);
    for (const instance of instances) {
      expect(instanceColor(instance)).toEqual([2, 2, 2]);
      expect(colorOf(instance)).toEqual([2, 2, 2]);
    }
    expect(colorOf(system.statics[0].system)).toEqual([1, 1, 1]);

    const flipped = tree({ root: 8, static: 0, event: 8 });
    run(flipped, 1);
    expect(instanceColor(flipped)).toEqual([1, 1, 1]);
    expect(instanceColor(flipped.statics[0].system)).toEqual([2, 2, 2]);
    expect(colorOf(flipped.statics[0].system)).toEqual([2, 2, 2]);
    expect(instanceColor(flipped.events[0].active[0])).toEqual([1, 1, 1]);
  });

  it("改值递归重算：static 子孙、活跃与空闲的事件实例都跟上，已有粒子不变；复用空闲实例时用的是重算过的值", () => {
    // 事件实例寿命 0.15：爆发的粒子两帧后死，实例回到空闲表
    const system = tree({ root: 0, static: 0, event: 0 }, 0.15);
    run(system, 4);
    const pool = system.events[0];
    expect(pool.free.length).toBeGreaterThan(0);
    expect(pool.active.length).toBeGreaterThan(0);
    const active = [...pool.active];
    const free = [...pool.free];
    const before = active.map((instance) => colorOf(instance));
    expect(before.every((color) => color.every((c) => c === 2))).toBe(true);
    system.setInstance({ brightness: 4 });
    for (const node of [system, system.statics[0].system, ...active, ...free])
      expect(instanceColor(node)).toEqual([4, 4, 4]);
    // 已有粒子的颜色不变
    expect(active.map((instance) => colorOf(instance))).toEqual(before);
    // 下一帧从空闲表尾部取出复用（4.7），爆发的新粒子是 4
    const reused = free[free.length - 1];
    run(system, 1);
    expect(pool.active).toContain(reused);
    expect(colorOf(reused)).toEqual([4, 4, 4]);
  });

  it("改值之后新建的事件实例读对象当前的 brightness（构造时从根取）", () => {
    // 实例永不回收：每帧都新建
    const system = tree({ root: 0, static: 0, event: 0 });
    run(system, 2);
    const pool = system.events[0];
    const existing = new Set(pool.active);
    expect(pool.free).toEqual([]);
    system.setInstance({ brightness: 0.5 });
    run(system, 1);
    const created = pool.active.filter((instance) => !existing.has(instance));
    expect(created.length).toBe(1);
    expect(instanceColor(created[0])).toEqual([0.5, 0.5, 0.5]);
    expect(colorOf(created[0])).toEqual([0.5, 0.5, 0.5]);
    // 之前建的实例里的粒子仍是 2
    for (const instance of existing) expect(colorOf(instance)).toEqual([2, 2, 2]);
  });
});
