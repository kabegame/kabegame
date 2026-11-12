/**
 * P4e 步骤 2：事件实例池与 `eventfollow`（rea-p4e-children 第 4、5、6 节，3.4、3.6、7.3；实测见 p4-particles-REPORT.md
 * 「P4e 语义的实测核对」的事件子系统表）。纯 TS，不碰 GPU：实例矩阵四种组合、上限与 `probability` 的抽取、父粒子死亡时停跟随、回收与
 * 后进先出复用、预热期间不建、不可见时销毁、实例覆盖递归、绘制先序与轨迹的键。
 * P4e 步骤 3（文件末尾）：`eventspawn`（4.3）与 `eventdeath`（4.2）的触发点、`X` 的取值、`cap` 的上限与失守、抽取顺序、预热（4.8）与不可见。
 */
import { describe, expect, it, vi } from "vitest";
import {
  childLocalMatrix,
  parseParticle,
  type ParticleChildType,
  type SceneParticle,
  type SceneParticleChild,
} from "../compile/particles";
import type { JsonObject } from "../compile/model";
import { invert, multiply, translation, type Mat4 } from "../render/math";
import { SeededRandom, type ParticleRandom } from "./random";
import { ParticleSystem } from "./system";
import { drawnSystems, particleTrack } from "./track";

const parse = (json: JsonObject, instanceoverride?: unknown): SceneParticle =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });

/** 父系统：每秒 `rate` 个（`emitter` 覆盖发射器的键）、寿命 `life`、速度 `velocity`（`movement` 积分），从控制点 0 + `origin` 发射。 */
function parentJson(
  options: { emitter?: JsonObject; life?: number; velocity?: string; extra?: JsonObject } = {},
): JsonObject {
  const { emitter = {}, life = 100, velocity, extra = {} } = options;
  return {
    maxcount: 64,
    emitter: [{ name: "sphererandom", distancemax: 0, rate: 10, ...emitter }],
    initializer: [
      { name: "lifetimerandom", min: life, max: life },
      ...(velocity ? [{ name: "velocityrandom", min: velocity, max: velocity }] : []),
    ],
    operator: velocity ? [{ name: "movement" }] : [],
    ...extra,
  };
}

/** 子系统：每秒 `rate` 个、寿命 `life`、不动，从控制点 0 发射（`emitter` 覆盖发射器的键）。 */
function childJson(options: { emitter?: JsonObject; life?: number; extra?: JsonObject } = {}): JsonObject {
  const { emitter = {}, life = 100, extra = {} } = options;
  return {
    maxcount: 32,
    emitter: [{ name: "sphererandom", distancemax: 0, rate: 10, ...emitter }],
    initializer: [{ name: "lifetimerandom", min: life, max: life }],
    ...extra,
  };
}

/** 给 `parent` 挂一个子系统条目（缺省 eventfollow；局部矩阵按 `origin` / `angles` / `scale` 现算）。 */
function attach(
  parent: SceneParticle,
  system: SceneParticle,
  entry: Partial<Omit<SceneParticleChild, "system">> & { origin?: number[]; angles?: number[]; scale?: number[] } = {},
): SceneParticle {
  const { origin = [0, 0, 0], angles = [0, 0, 0], scale = [1, 1, 1], ...rest } = entry;
  parent.children.push({
    index: parent.children.length,
    type: "eventfollow" as ParticleChildType,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix(origin, angles, scale),
    ...rest,
    system,
  });
  return system;
}

const make = (def: SceneParticle, random: ParticleRandom = new SeededRandom(1)) => new ParticleSystem(def, random, 1);
const inputsAt = (world: Mat4) => ({ world, pointer: [0, 0] as const });
/** 按 dt 0.1 连走 `frames` 帧（场景时间从 `from` 帧接着算）。 */
function run(system: ParticleSystem, frames: number, world?: Mat4, from = 0): void {
  for (let i = 0; i < frames; i++) system.step(0.1, 0.1 * (from + i + 1), world ? inputsAt(world) : undefined);
}
const alive = (system: ParticleSystem) => system.alive;
/** −0 换成 +0，只比数值。 */
const z = (values: ArrayLike<number>) => Array.from(values, (value) => value + 0);

/** 只数 `a()` 的随机源（`probability` 抽的就是它，4.4）。 */
class CountingRandom implements ParticleRandom {
  private readonly inner = new SeededRandom(1);
  count = 0;
  a(): number {
    this.count++;
    return this.inner.a();
  }
  b(): number {
    return this.inner.b();
  }
}

/** 对象绕 z 转 90°、平移到 (960, 540)：本地父与世界父的实例矩阵因此不同（4.5，实测 `ef-rotl` / `ef-rotw`）。 */
const W = multiply(translation(960, 540, 0), new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

describe("实例矩阵 X（4.5）", () => {
  /** 父发射一个不动的粒子（`origin "10 20 0"`），挂一个条目 `origin "50 0 0"` 的 eventfollow；走一帧。 */
  function tree(parentWorld: boolean, childWorld: boolean) {
    const root = parse(
      parentJson({ emitter: { rate: 0, instantaneous: 1, origin: "10 20 0" }, extra: { flags: parentWorld ? 1 : 0 } }),
    );
    attach(root, parse(childJson({ extra: { flags: childWorld ? 1 : 0 } })), { origin: [50, 0, 0] });
    const system = make(root);
    system.prewarm(inputsAt(W));
    run(system, 1, W);
    const instance = system.events[0].active[0];
    return { system, instance };
  }

  it("四种组合：X 与它推出的模拟矩阵、绘制模型矩阵；子粒子都在父粒子 + 转过（父本地）或没转过（父世界）的 L 处", () => {
    const L = translation(50, 0, 0);
    const placedLocal = multiply(translation(10, 20, 0), L);
    // 父世界：粒子存世界坐标，出生点 W·base + origin = (960, 540) + (10, 20)（`origin` 不经 W，P4c）
    const placedWorld = multiply(translation(970, 560, 0), L);
    const cases: [boolean, boolean, Mat4, number[]][] = [
      // [父世界, 子世界, X, 子粒子的场景坐标]
      [false, false, placedLocal, [940, 600]],
      [true, false, multiply(invert(W)!, placedWorld), [1020, 560]],
      [false, true, multiply(W, placedLocal), [940, 600]],
      [true, true, placedWorld, [1020, 560]],
    ];
    for (const [parentWorld, childWorld, X, scene] of cases) {
      const label = `父${parentWorld ? "世界" : "本地"} 子${childWorld ? "世界" : "本地"}`;
      const { system, instance } = tree(parentWorld, childWorld);
      expect(z(instance.instanceMatrix!), label).toEqual(z(X));
      expect(instance.followSlot, label).toBe(0);
      // 子粒子：本地存实例坐标（控制点 0 是 base = 0），世界存世界坐标 M·base = X 的平移
      const c = instance.columns.position;
      const position = [c[0][0], c[1][0], c[2][0]];
      let model: Mat4 | null = null;
      system.forEachDrawn((node, template, drawn) => {
        if (node === instance) {
          expect(template, label).toEqual([0]);
          model = drawn;
        }
      }, W);
      expect(model, label).not.toBeNull();
      const m = model! as Mat4;
      const world = [0, 1].map((r) => m[r] * position[0] + m[4 + r] * position[1] + m[8 + r] * position[2] + m[12 + r]);
      expect(world[0], label).toBeCloseTo(scene[0], 3);
      expect(world[1], label).toBeCloseTo(scene[1], 3);
      // 世界实例绘制用单位阵；本地实例 top·X，top 是父绘制栈顶（顶层恒为 W）
      if (childWorld)
        expect(z(m), label).toEqual(z(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
      else expect(z(m), label).toEqual(z(multiply(W, X)));
      expect(z(instance.drawTransform(W).model), label).toEqual(z(m));
    }
  });

  it("eventfollow 每帧按父粒子 operator 之后的位置重算 X；本地实例的已有粒子跟着走，世界实例的留在原地（实测 f-base、f-cw）", () => {
    for (const childWorld of [false, true]) {
      const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, velocity: "100 0 0" }));
      attach(root, parse(childJson({ extra: { flags: childWorld ? 1 : 0 } })));
      const system = make(root);
      run(system, 3);
      const instance = system.events[0].active[0];
      // 父粒子三帧后在 x = 30（每帧 +10，operator 之后）
      expect(z(instance.instanceMatrix!.slice(12, 15))).toEqual([30, 0, 0]);
      const c = instance.columns.position;
      const xs = Array.from({ length: instance.highWater }, (_, i) => c[0][i]);
      // 本地：三个子粒子都在实例原点（画出来都在父粒子上）；世界：出生在 10、20、30 并留在那里
      expect(xs).toEqual(childWorld ? [10, 20, 30] : [0, 0, 0]);
    }
  });
});

describe("触发：上限、probability 与随机数（4.3、4.4）", () => {
  /** 父每帧 5 个新粒子，走 4 帧；子系统容量 0（不发射、不抽随机数、永不结束）。返回 `a()` 的总次数与池。 */
  function draws(entry?: Partial<SceneParticleChild>) {
    const root = parse(parentJson({ emitter: { rate: 50 } }));
    if (entry) attach(root, parse(childJson({ extra: { maxcount: 0 } })), entry);
    const random = new CountingRandom();
    const system = make(root, random);
    system.prewarm();
    run(system, 4);
    expect(system.alive).toBe(20);
    return { count: random.count, pool: system.events[0] };
  }

  it("每个新粒子抽一次 uA（probability 1 也抽）；条目满了整条目不抽、不建；maxcount 0 与没有子系统逐位相同（实测 ef-draw-rng）", () => {
    const base = draws().count;
    const full = draws({ maxcount: 0 });
    expect(full.count).toBe(base);
    expect(full.pool.active).toHaveLength(0);
    // 第一帧抽两次就满了，之后不抽
    const two = draws({ maxcount: 2 });
    expect(two.count).toBe(base + 2);
    expect(two.pool.active.map((instance) => instance.followSlot)).toEqual([0, 1]);
    const all = draws({ maxcount: 100, probability: 1 });
    expect(all.count).toBe(base + 20);
    expect(all.pool.active).toHaveLength(20);
    // probability 0：照抽、不建（uA 恰为 0 的 2⁻²⁴ 不算）
    const never = draws({ maxcount: 100, probability: 0 });
    expect(never.count).toBe(base + 20);
    expect(never.pool.active).toHaveLength(0);
  });

  it("probability 0.5：大约一半（实测 f-prob 父 12 个、实例 8 个，只看统计）", () => {
    const half = draws({ maxcount: 100, probability: 0.5 });
    expect(half.pool.active.length).toBeGreaterThan(4);
    expect(half.pool.active.length).toBeLessThan(16);
  });

  it("嵌套是条目在外、新粒子在内：第一个条目先把本帧新粒子抽完，再轮到第二个", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 3 } }));
    attach(root, parse(childJson()), { maxcount: 2 });
    attach(root, parse(childJson()), { maxcount: 5 });
    const system = make(root);
    run(system, 1);
    expect(system.events.map((pool) => pool.active.map((instance) => instance.followSlot))).toEqual([
      [0, 1],
      [0, 1, 2],
    ]);
  });

  it("预热期间不建实例（sys+0x41 清零，4.8）；预热后的第一帧照常建", () => {
    const root = parse(parentJson({ extra: { starttime: 1 } }));
    attach(root, parse(childJson()));
    const system = make(root);
    system.prewarm();
    expect(system.alive).toBe(10);
    expect(system.events[0].active).toHaveLength(0);
    run(system, 1);
    expect(system.events[0].active).toHaveLength(1);
    expect(system.events[0].active[0].followSlot).toBe(10);
  });

  it("实例按自己的 starttime 预热，位置是父粒子出生点（实测 ef-start）；本帧新建的实例当帧再走一次完整的 dt′", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, velocity: "100 0 0" }));
    attach(root, parse(childJson({ extra: { flags: 1, starttime: 0.5 } })));
    const system = make(root);
    run(system, 1);
    const instance = system.events[0].active[0];
    // 预热 0.5 s（10 步 × 0.05，每秒 10 个 → 5 个），出生点是父粒子 operator 之前的 x = 0；当帧再发 1 个，在 operator 之后的 x = 10
    expect(instance.alive).toBe(6);
    const c = instance.columns.position;
    expect(Array.from({ length: 6 }, (_, i) => c[0][i])).toEqual([0, 0, 0, 0, 0, 10]);
  });
});

describe("父粒子死亡与回收（4.6、4.7）", () => {
  it("父粒子死亡那一帧停跟随（X 冻结）、停发射，已有粒子活完后回收进空闲表（实测 f-death、ef-death）", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.25, velocity: "100 0 0" }));
    attach(root, parse(childJson({ life: 0.35 })));
    const system = make(root);
    const pool = system.events[0];
    run(system, 3);
    const instance = pool.active[0];
    expect([instance.followSlot, alive(instance)]).toEqual([0, 3]);
    expect(z(instance.instanceMatrix!.slice(12, 15))).toEqual([30, 0, 0]);
    // 第 4 帧父粒子死（age 0.3 > 0.25）：停跟随、不再发射，X 停在最后的位置
    run(system, 1, undefined, 3);
    expect(system.alive).toBe(0);
    expect([instance.followSlot, alive(instance)]).toEqual([-1, 3]);
    expect(z(instance.instanceMatrix!.slice(12, 15))).toEqual([30, 0, 0]);
    expect(instance.isActive()).toBe(true);
    // 子粒子寿命 0.35：第 5、6、7 帧各死一个，第 7 帧步进后不活跃、回收
    run(system, 2, undefined, 4);
    expect([pool.active.length, alive(instance)]).toEqual([1, 1]);
    run(system, 1, undefined, 6);
    expect(pool.active).toHaveLength(0);
    expect(pool.free).toEqual([instance]);
  });

  it("持续发射的实例不回收：发射器没结束就活跃，存活数为 0 也一样（4.6）", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 } }));
    attach(root, parse(childJson({ emitter: { delay: 1 } })));
    const system = make(root);
    run(system, 5);
    const instance = system.events[0].active[0];
    expect(alive(instance)).toBe(0);
    expect(instance.isActive()).toBe(true);
    expect(system.events[0].free).toHaveLength(0);
  });

  it("回收后后进先出复用：系统时间与发射器从头开始（instantaneous 重新发），不重新初始化控制点（实测 es-recycle 的复位）", () => {
    // 父：开头一次 2 个，0.35 s 后再 1 个；子：一次发 1 个、寿命 0.15，第 3 帧两个实例先后回收（空闲表 A、B），第 5 帧取 B
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2 }, extra: { maxcount: 8 } }));
    (root.emitters as unknown[]).push(
      parse(parentJson({ emitter: { rate: 0, instantaneous: 1, delay: 0.35 } })).emitters[0],
    );
    attach(root, parse(childJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 })), { maxcount: 4 });
    const system = make(root);
    const pool = system.events[0];
    run(system, 1);
    const [a, b] = pool.active;
    expect([a.followSlot, b.followSlot]).toEqual([0, 1]);
    run(system, 3, undefined, 1);
    expect(pool.active).toHaveLength(0);
    expect(pool.free).toEqual([a, b]);
    // 第 3 帧步进后回收，空闲期间不步进
    expect(b.systemTime).toBeCloseTo(0.3, 5);
    const update = vi.spyOn(b.controlPoints, "update");
    run(system, 1, undefined, 4);
    // 复用的是后回收的 B：系统时间从 0 起再加这一帧，发射器重开、instantaneous 又发了 1 个；控制点只在这一帧的模拟里更新一次
    expect(pool.active).toEqual([b]);
    expect(pool.free).toEqual([a]);
    expect(b.followSlot).toBe(2);
    expect(b.systemTime).toBeCloseTo(0.1, 5);
    expect(alive(b)).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("不可见（3.6）：顶层有存活粒子时，顶层与 static 子孙的活跃实例销毁，空闲表不动；顶层没有存活时照常模拟到回收", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2 } }));
    attach(root, parse(childJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 })));
    const holder = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 } }));
    attach(holder, parse(childJson()));
    attach(root, holder, { type: "static" });
    const system = make(root);
    run(system, 3);
    const pool = system.events[0];
    const inner = system.statics[0].system.events[0];
    expect([pool.active.length, pool.free.length, inner.active.length]).toEqual([0, 2, 1]);
    run(system, 1, undefined, 3);
    // 重新建：父粒子还活着，但它们早就出生过了，不会再触发
    expect(pool.active).toHaveLength(0);
    expect(system.suspend(inputsAt(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])), 0.1, 0.5)).toBe(
      true,
    );
    expect([pool.active.length, pool.free.length, inner.active.length, inner.free.length]).toEqual([0, 2, 0, 0]);

    // 顶层没有存活：停了跟随的实例照常模拟（不发射）到回收
    const quiet = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 }));
    attach(quiet, parse(childJson({ life: 0.25 })));
    const q = make(quiet);
    run(q, 2);
    expect(q.alive).toBe(1);
    run(q, 1, undefined, 2);
    expect(q.alive).toBe(0);
    const instance = q.events[0].active[0];
    expect([instance.followSlot, alive(instance)]).toEqual([-1, 2]);
    expect(q.suspend(undefined, 0.1, 0.4)).toBe(false);
    expect(q.events[0].active).toEqual([instance]);
    expect(alive(instance)).toBe(1);
    q.suspend(undefined, 0.1, 0.5);
    expect(q.events[0].active).toHaveLength(0);
    expect(q.events[0].free).toEqual([instance]);
  });

  it("不可见（3.6 第 4 步）：顶层自己的活跃实例（父粒子还活着、持续发射）同样销毁，不进空闲表", () => {
    // Claude 验收补：上一条隐藏时顶层池已经回收空了，去掉顶层的销毁也看不出来（变异 hide-keeps-instances）
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2 } }));
    attach(root, parse(childJson()));
    const system = make(root);
    run(system, 2);
    const pool = system.events[0];
    const destroyed = [...pool.active];
    expect([destroyed.length, pool.free.length, destroyed.every((instance) => instance.alive > 0)]).toEqual([
      2,
      0,
      true,
    ]);
    expect(system.suspend(undefined, 0.1, 0.3)).toBe(true);
    expect([pool.active.length, pool.free.length]).toEqual([0, 0]);
    // 再走一帧也不会回来（销毁不是回收，空闲表里没有它们）
    system.suspend(undefined, 0.1, 0.4);
    expect(pool.active.concat(pool.free).some((instance) => destroyed.includes(instance))).toBe(false);
  });
});

describe("实例覆盖与写控制点（3.4、第 5 节）", () => {
  it("setInstance 递归到活跃与空闲实例（p2 = 0：已结束的发射器不重开）；static 子系统照旧重开", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 }));
    attach(root, parse(childJson({ life: 0.25 })));
    attach(root, parse(childJson({ emitter: { duration: 0.1 } })), { type: "static" });
    const system = make(root);
    run(system, 3);
    const instance = system.events[0].active[0];
    const statik = system.statics[0].system;
    /** 发射器的结束位（`sys+0x3f4` 那一组，私有字段）。 */
    const ended = (node: ParticleSystem) =>
      (node as unknown as { emitters: { state: { ended: boolean } }[] }).emitters.map((emitter) => emitter.state.ended);
    // 父粒子第 3 帧已死：实例停了跟随、发射器全部结束；static 子系统的 duration 也用完了
    expect(instance.followSlot).toBe(-1);
    expect([ended(instance), ended(statik)]).toEqual([[true], [true]]);
    system.setInstance({ count: 3 });
    expect(instance.instanceValues.count).toBe(3);
    expect(statik.instanceValues.count).toBe(3);
    // 实例按 p2 = 0 不重开；static 按 p2 = 1、新 rate > 0 重开（3.4 `0x14022c1d0`–`0x14022c26d`）
    expect([ended(instance), ended(statik)]).toEqual([[true], [false]]);
    // 实例的粒子死光后回收；空闲实例同样跟着改值
    run(system, 3, undefined, 3);
    expect(system.events[0].free).toEqual([instance]);
    system.setInstance({ count: 5 });
    expect(instance.instanceValues.count).toBe(5);
  });

  it("条目 flags bit0：父的存活粒子写实例控制点，不补偿 T(p)·L（实测 ef-cpw）", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2, origin: "30 0 0" } }));
    attach(root, parse(childJson({ emitter: { controlpoint: 2 } })), {
      flags: 1,
      controlPointStartIndex: 2,
      maxcount: 1,
      origin: [0, 100, 0],
    });
    const system = make(root);
    run(system, 1);
    const instance = system.events[0].active[0];
    expect(instance.controlPoints.count).toBe(8);
    // cp2 = 父的第一个存活粒子 (30, 0)（父本地、子本地：原样），实例坐标里；画出来再叠一个 T(p)·L
    expect(z(instance.controlPoints.current(2).translation)).toEqual([30, 0, 0]);
    const c = instance.columns.position;
    expect([c[0][0], c[1][0]]).toEqual([30, 0]);
    expect(z(instance.instanceMatrix!.slice(12, 15))).toEqual([30, 100, 0]);
  });
});

describe("绘制先序与轨迹（第 6 节）", () => {
  it("父 → static（不管 JSON 先后）→ 实例 1 → 它的子孙 → 实例 2；模型矩阵与 drawTransform 逐位相同", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2, origin: "10 0 0" } }));
    const event = attach(root, parse(childJson()), { origin: [0, 5, 0] });
    attach(event, parse(childJson()), { type: "static", origin: [1, 0, 0] });
    attach(root, parse(childJson()), { type: "static" });
    const system = make(root);
    run(system, 1, W);
    const [first, second] = system.events[0].active;
    const order: [string, ParticleSystem][] = [];
    system.forEachDrawn((node, template, model) => {
      order.push([template.join("/"), node]);
      expect(z(node.drawTransform(W).model)).toEqual(z(model));
    }, W);
    expect(order).toEqual([
      ["", system],
      ["1", system.statics[0].system],
      ["0", first],
      ["0/0", first.statics[0].system],
      ["0", second],
      ["0/0", second.statics[0].system],
    ]);
  });

  it("轨迹：同一模板第 k 次出现（k ≥ 2）记 `#k`，只数有存活粒子的", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 3 } }));
    attach(root, parse(childJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 })));
    const system = make(root);
    run(system, 1);
    expect(drawnSystems("p", system).map((item) => [item.key, item.template])).toEqual([
      ["p", "p"],
      ["p/0", "p/0"],
      ["p/0#2", "p/0"],
      ["p/0#3", "p/0"],
    ]);
    // 第一个实例的粒子死光（但还没回收时）不占序号
    system.events[0].active[0].columns.life.fill(0);
    system.events[0].active[0].alive = 0;
    expect(drawnSystems("p", system).map((item) => item.key)).toEqual(["p", "p/0", "p/0#2"]);
    const track = particleTrack({
      layers: [{ object: 0, name: "p", particle: root }],
      dts: [0.1],
      frames: [1],
      passes: 1,
    });
    expect(Object.keys(track.frames[0].systems)).toEqual(["p", "p/0", "p/0#2", "p/0#3"]);
  });
});

// ———— P4e 步骤 3：eventspawn 与 eventdeath ————

/** 实例的平移（`X` 的第 4 列）。 */
const at = (instance: ParticleSystem) => z(instance.instanceMatrix!.slice(12, 15));
/** 各池活跃实例的父粒子槽号。 */
const slots = (system: ParticleSystem) =>
  system.events.map((pool) => pool.active.map((instance) => instance.followSlot));

/** 先按队列给 `a()`，队列空了用 `SeededRandom(1)`（核对抽取顺序用）。 */
class QueuedRandom implements ParticleRandom {
  private readonly inner = new SeededRandom(1);
  readonly queue: number[] = [];
  a(): number {
    return this.queue.length ? this.queue.shift()! : this.inner.a();
  }
  b(): number {
    return this.inner.b();
  }
}

describe("eventspawn（4.3，P4e 步骤 3）", () => {
  it("X 用新粒子 operator 之前的出生位置，只写一次、不跟父粒子；父粒子死了不停，实例照常发射（实测 es-pos）", () => {
    // 同一个父粒子另挂一个 eventfollow 作对照：有了它系统才收集死亡表（`sys+0x41 & 0x14`），只挂 eventspawn 时根本没有死亡表、
    // 看不出「父死时停不停」
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.25, velocity: "100 0 0" }));
    attach(root, parse(childJson()), { type: "eventspawn" });
    attach(root, parse(childJson()));
    const system = make(root);
    const [pool, followPool] = system.events;
    run(system, 1);
    const [instance, follower] = [pool.active[0], followPool.active[0]];
    // 出生点 x = 0（operator 之前）；eventfollow 这一帧步进前改成 operator 之后的 10，eventspawn 不改
    expect([instance.followSlot, at(instance), alive(instance)]).toEqual([0, [0, 0, 0], 1]);
    expect(at(follower)).toEqual([10, 0, 0]);
    run(system, 2, undefined, 1);
    expect(system.columns.position[0][0]).toBe(30);
    expect([at(instance), at(follower)]).toEqual([
      [0, 0, 0],
      [30, 0, 0],
    ]);
    // 第 4 帧父粒子死（age 0.3 > 0.25）：eventfollow 停跟随、停发射；eventspawn 的 followSlot 不改回 −1、发射器不停（4.2 只看类型 2）
    run(system, 3, undefined, 3);
    expect(system.alive).toBe(0);
    expect(pool.active).toEqual([instance]);
    expect([instance.followSlot, at(instance), alive(instance)]).toEqual([0, [0, 0, 0], 6]);
    expect([follower.followSlot, alive(follower)]).toEqual([-1, 3]);
  });

  it("条目满了整条目不抽、不建；持续发射的实例永不回收，池满后这个条目再也没有事件（实测 es-max）", () => {
    /** 父每帧 5 个新粒子，走 `frames` 帧；子系统容量 0（不发射、不抽随机数、永不结束）。返回 `a()` 的总次数与池。 */
    function draws(frames: number, entry?: Partial<SceneParticleChild>) {
      const root = parse(parentJson({ emitter: { rate: 50 } }));
      if (entry) attach(root, parse(childJson({ extra: { maxcount: 0 } })), { type: "eventspawn", ...entry });
      const random = new CountingRandom();
      const system = make(root, random);
      run(system, frames);
      expect(system.alive).toBe(5 * frames);
      return { count: random.count, pool: system.events[0] };
    }
    const base = draws(6).count;
    // 第一帧抽 3 次就满了，之后 5 帧一次都不抽；实例永不结束，不回收
    const three = draws(6, { maxcount: 3 });
    expect(three.count).toBe(base + 3);
    expect(three.pool.active.map((instance) => instance.followSlot)).toEqual([0, 1, 2]);
    expect(three.pool.free).toHaveLength(0);
    expect(draws(6, { maxcount: 0 }).count).toBe(base);
    // 不满时每个新粒子抽一次（probability 1 也抽）；probability 0 照抽、不建
    const all = draws(2, { maxcount: 100 });
    expect([all.count, all.pool.active.length]).toEqual([draws(2).count + 10, 10]);
    const never = draws(2, { maxcount: 100, probability: 0 });
    expect([never.count, never.pool.active.length]).toEqual([draws(2).count + 10, 0]);
  });

  it("复用实例时 mapsequence 序号归零：第 3 批复用第 1 个实例，5 个粒子的角度和第 1 批相同（es-recycle）", () => {
    // 父每 2 帧出生 1 个（rate 5）；子：一次 5 个、在控制点 0 外 100 处、寿命 0.15。第 2 帧建 A，第 4 帧建 B（A 这一帧步进后才回收），
    // 第 6 帧从空闲表取 A
    const root = parse(parentJson({ emitter: { rate: 5 } }));
    const child = parse({
      maxcount: 16,
      emitter: [
        { name: "sphererandom", distancemin: 100, distancemax: 100, directions: "1 0 0", rate: 0, instantaneous: 5 },
      ],
      initializer: [
        { name: "lifetimerandom", min: 0.15, max: 0.15 },
        { name: "mapsequencearoundcontrolpoint", count: 7 },
      ],
    });
    attach(root, child, { type: "eventspawn" });
    const system = make(root);
    const pool = system.events[0];
    /** 实例里存活粒子绕控制点 0 的角度（度，θ = 0 在 +y、往 +x 转），槽序。 */
    const angles = (instance: ParticleSystem) => {
      const { life, position } = instance.columns;
      const out: number[] = [];
      for (let i = 0; i < instance.highWater; i++)
        if (life[i] !== 0) out.push(Math.round((Math.atan2(position[0][i], position[1][i]) * 180) / Math.PI) + 0);
      return out;
    };
    run(system, 2);
    const [a] = pool.active;
    const first = angles(a);
    expect(first).toEqual([0, 51, 103, 154, -154]);
    run(system, 2, undefined, 2);
    const [b] = pool.active;
    expect(b).not.toBe(a);
    expect(pool.free).toEqual([a]);
    run(system, 2, undefined, 4);
    // B 这一帧步进后回收；A 复用：序号从 0 起（不复位会从 5/7 接着排）
    expect(pool.active).toEqual([a]);
    expect(pool.free).toEqual([b]);
    expect(angles(a)).toEqual(first);
  });
});

describe("eventdeath（4.2，P4e 步骤 3）", () => {
  it("判死那一帧建实例，X 用死粒子上一帧末的位置（判死帧父粒子不再前进，实测 ed-pos），之后不重算", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 1 }, life: 0.25, velocity: "100 0 0" }));
    attach(root, parse(childJson({ emitter: { rate: 0, instantaneous: 5 } })), { type: "eventdeath" });
    const system = make(root);
    const pool = system.events[0];
    run(system, 3);
    expect(pool.active).toHaveLength(0);
    // 第 4 帧判死（age 0.3 > 0.25）：位置列还是第 3 帧末的 x = 30；这一帧的 movement 照样把死槽推到 40，X 不受影响
    run(system, 1, undefined, 3);
    expect([system.alive, system.columns.position[0][0]]).toEqual([0, 40]);
    const instance = pool.active[0];
    expect([pool.active.length, instance.followSlot, at(instance), alive(instance)]).toEqual([1, 0, [30, 0, 0], 5]);
    run(system, 1, undefined, 4);
    expect(at(instance)).toEqual([30, 0, 0]);
  });

  /**
   * 父每帧 1 个、寿命 0.25：第 4 帧起每帧死 1 个（槽 0、1、2、0、1…）。挂 `entries` 个 eventdeath 条目（`maxcount` 各 1，子系统容量 0：
   * 不发射、不抽随机数、永不结束），走 8 帧。返回 `a()` 比没有条目时多的次数（就是 `probability` 的抽取次数）与各池的槽号。
   */
  function deaths(entries: number) {
    const build = (n: number) => {
      const root = parse(parentJson({ emitter: { rate: 10 }, life: 0.25 }));
      for (let i = 0; i < n; i++)
        attach(root, parse(childJson({ extra: { maxcount: 0 } })), { type: "eventdeath", maxcount: 1 });
      const random = new CountingRandom();
      const system = make(root, random);
      run(system, 8);
      return { count: random.count, system };
    };
    const { count, system } = build(entries);
    return { draws: count - build(0).count, slots: slots(system) };
  }

  it("单条目：上限严格成立；cap 为 0 时整个死粒子不抽", () => {
    // 第 4 帧抽 1 次、建 1 个就满了（cap 1 → 0），之后 4 个死粒子都不抽
    expect(deaths(1)).toEqual({ draws: 1, slots: [[0]] });
  });

  it("两个条目时上限失守（「决定」4，照 WPE）：cap 是剩余量之和、循环里只判 cap == 0，满了的条目照样建，之后每个死粒子在两个条目各建一个（实测 ed-max2 60、59 个）", () => {
    // 第 4 帧：cap 2，条目 1 建（满，break）→ 条目 2 不抽；第 5 帧：cap 1，条目 1 再建（2 ≠ 1 不 break，cap 0 也不再判）、条目 2 建（cap −1）；
    // 之后 cap 一直为负、非零，每个死粒子两个条目各抽一次、各建一个
    expect(deaths(2)).toEqual({
      draws: 1 + 2 + 2 + 2 + 2,
      slots: [
        [0, 1, 2, 0, 1],
        [1, 2, 0, 1],
      ],
    });
  });

  it("嵌套是死粒子在外、条目在内（和 4.3 相反），每个（死粒子，条目）抽一次：抽取顺序 A-1、A-2、B-1、B-2（ed-order）", () => {
    const root = parse(parentJson({ emitter: { rate: 0, instantaneous: 2 }, life: 0.25 }));
    attach(root, parse(childJson({ extra: { maxcount: 0 } })), { type: "eventdeath", probability: 0.5 });
    attach(root, parse(childJson({ extra: { maxcount: 0 } })), { type: "eventdeath", probability: 0.5 });
    const random = new QueuedRandom();
    const system = make(root, random);
    run(system, 3);
    expect(slots(system)).toEqual([[], []]);
    // 第 4 帧槽 0（A）、槽 1（B）同时死，判死之前这一帧没有别的抽取：依次给 (A,1) (A,2) 建、(B,1) (B,2) 不建。条目在外的话是
    // (1,A) (1,B) 建、(2,A) (2,B) 不建，得 [[0, 1], []]
    random.queue.push(0.1, 0.1, 0.9, 0.9);
    run(system, 1, undefined, 3);
    expect(random.queue).toHaveLength(0);
    expect(slots(system)).toEqual([[0], [0]]);
  });

  it("不可见：子系统以 emit = false 步进时判死照常，eventdeath 照常建；新实例同样不发射，重新可见后才发", () => {
    // 顶层不发射（存活数 0，不可见时不复位子孙）；static 子系统一次 2 个、寿命 0.15，挂 eventdeath（子系统持续发射）
    const root = parse(parentJson({ emitter: { rate: 0 } }));
    const holder = parse(parentJson({ emitter: { rate: 0, instantaneous: 2 }, life: 0.15 }));
    attach(holder, parse(childJson()), { type: "eventdeath" });
    attach(root, holder, { type: "static" });
    const system = make(root);
    run(system, 1);
    const statik = system.statics[0].system;
    const pool = statik.events[0];
    expect([system.alive, statik.alive]).toEqual([0, 2]);
    expect(system.suspend(undefined, 0.1, 0.2)).toBe(false);
    expect(pool.active).toHaveLength(0);
    // 第 3 帧（不可见）两个都死（age 0.2 > 0.15）：两个实例，父粒子槽号 0、1；发射器没结束，照样活跃
    expect(system.suspend(undefined, 0.1, 0.3)).toBe(false);
    expect(statik.alive).toBe(0);
    expect(pool.active.map((instance) => [instance.followSlot, alive(instance), instance.isActive()])).toEqual([
      [0, 0, true],
      [1, 0, true],
    ]);
    run(system, 1, undefined, 3);
    expect(pool.active.map(alive)).toEqual([1, 1]);
  });
});

describe("预热（4.8，P4e 步骤 3）", () => {
  /**
   * 父 `starttime 1`（20 步 × 0.05）、每秒 10 个、寿命 0.25，预热里死很多个；挂 eventdeath 与 eventspawn 各一个（`maxcount 1`，子系统
   * 持续发射、永不回收）。
   */
  function warmed(renderer: string) {
    const root = parse(parentJson({ life: 0.25, extra: { starttime: 1, renderer: [{ name: renderer }] } }));
    attach(root, parse(childJson()), { type: "eventdeath", maxcount: 1 });
    attach(root, parse(childJson()), { type: "eventspawn", maxcount: 1 });
    const system = make(root);
    system.prewarm();
    expect(system.alive).toBeGreaterThan(0);
    return system;
  }

  it("父不带 rope：预热里不为事件收集死亡、不记新粒子，eventdeath / eventspawn 都不建；预热后的第一帧照常建", () => {
    const system = warmed("sprite");
    expect(system.ropeOrder).toBeNull();
    expect(slots(system)).toEqual([[], []]);
    run(system, 1);
    expect(system.events.map((pool) => pool.active.length)).toEqual([1, 1]);
  });

  it("父带 rope：判死照样收集（rope 表要用），预热里建 eventdeath 实例（实测 ed-rope 比 ed-sprite 多 1 个），eventspawn 不建；预热里建的实例预热期间不步进", () => {
    const system = warmed("rope");
    expect(system.ropeOrder).not.toBeNull();
    const [death, spawn] = system.events;
    expect([death.active.length, spawn.active.length]).toEqual([1, 0]);
    const instance = death.active[0];
    // 建的时候初始化（子系统 starttime 0，不预热），之后父的预热循环不步进子系统
    expect([instance.systemTime, alive(instance)]).toEqual([0, 0]);
    run(system, 1);
    // 预热之后的第一个正常帧才步进；条目已满（cap 0），不再建
    expect(death.active).toEqual([instance]);
    expect(instance.systemTime).toBeCloseTo(0.1, 5);
    expect(alive(instance)).toBe(1);
    expect(spawn.active).toHaveLength(1);
  });
});
