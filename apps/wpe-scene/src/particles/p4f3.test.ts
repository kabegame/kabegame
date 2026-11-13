/**
 * P4f 步骤 3 的模拟器单测：脚本 `IParticleSystem` 落到根系统的五个入口（`scriptPause` / `scriptPlay` / `scriptStop` / `scriptIsPlaying` /
 * `emitParticles`）与实例覆盖控制点的运行时写入（`setInstance` → `ControlPointSet.applyOverrides`）。依据
 * `.claude/plans/wpe-import/3-scene/phase4/rea-p4f-script.md` 第 2–5 节（读码）与 p4-particles-REPORT.md「P4f 语义的实测核对」；
 * 已定 5–7 的三处不复刻 WPE：自然结束后 `play()` 复位计时重新发射、`stop()` 后改系数不重开、脚本发射建事件实例用对象的 `W`。
 */
import { describe, expect, it } from "vitest";
import {
  childLocalMatrix,
  FLT_MAX,
  parseParticle,
  type ParticleChildType,
  type ParticleInstanceValues,
  type SceneParticle,
} from "../compile/particles";
import type { JsonObject } from "../compile/model";
import { invert, multiply, translation, type Mat4 } from "../render/math";
import { eulerBasis, type ControlPointInputs } from "./controlpoints";
import { scriptEmitCount, type EmitterState } from "./emitters";
import { SeededRandom } from "./random";
import { writeRopeSegments, type RopeVertexLayout } from "./rope";
import { writeTrailSegments, type TrailVertexLayout } from "./ropetrail";
import { ParticleSystem } from "./system";
import { particleSnapshot } from "./track";
import { writeVertices, type ParticleVertexLayout } from "./vertices";

const f32 = Math.fround;
const DT = 0.1;

const parse = (json: JsonObject, instanceoverride?: unknown): SceneParticle =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });
const make = (def: SceneParticle) => new ParticleSystem(def, new SeededRandom(1), 1);

/** 从控制点 0 发射、寿命 `life`、速度 (100, 0, 0) 匀速移动的系统；`emitter` 覆盖发射器的键，`extra` 覆盖系统级键。 */
function json(
  options: { emitter?: JsonObject; life?: number; extra?: JsonObject; emitters?: number } = {},
): JsonObject {
  const { emitter = {}, life = 100, extra = {}, emitters = 1 } = options;
  return {
    maxcount: 64,
    emitter: Array.from({ length: emitters }, () => ({
      name: "sphererandom",
      distancemin: 0,
      distancemax: 0,
      rate: 10,
      ...emitter,
    })),
    initializer: [
      { name: "lifetimerandom", min: life, max: life },
      { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
    ],
    operator: [{ name: "movement" }],
    ...extra,
  };
}

function attach(parent: SceneParticle, child: SceneParticle, type: ParticleChildType, maxcount = 10): SceneParticle {
  parent.children.push({
    index: parent.children.length,
    type,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount,
    local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
    system: child,
  });
  return child;
}

/** 模拟器内部：发射器状态（私有字段）。 */
const emitters = (system: ParticleSystem) => (system as unknown as { emitters: { state: EmitterState }[] }).emitters;
const at = (world: Mat4): ControlPointInputs => ({ world, pointer: [0, 0] });

/** 走 `frames` 帧，返回每帧新增的存活数（寿命长、不死时就是每帧的出生数）；`after(i)` 在第 i 帧步进之后调（脚本阶段）。 */
function births(system: ParticleSystem, frames: number, after?: (frame: number) => void): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const before = system.alive;
    system.step(DT);
    out.push(system.alive - before);
    after?.(i);
  }
  return out;
}

/** 非 GS 的 sprite 顶点布局：位置、`a_TexCoordVec4`、颜色、`a_TexCoordC2`，步长 13。 */
const SPRITE: ParticleVertexLayout = { stride: 13, position: 0, texCoord: 3, color: 7, rotation: 11, thick: -1 };
const drawn = (system: ParticleSystem) => writeVertices(system, SPRITE, new Float32Array(64 * 4 * SPRITE.stride));

const W: Mat4 = multiply(translation(100, 50, 0), new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

describe("scriptPause（rea-p4f-script.md 2.1，实测 a-pause、b-pause-dur）", () => {
  it("暂停冻结 duration：发射序列等于没暂停的那份中间插进暂停的帧（帧尾不走）", () => {
    const def = parse(json({ emitter: { duration: 2 } }));
    const reference = births(make(def), 40);
    const system = make(def);
    const got = births(system, 50, (frame) => {
      if (frame === 4) system.scriptPause();
      if (frame === 14) system.scriptPlay();
    });
    expect(got).toEqual([...reference.slice(0, 5), ...Array(10).fill(0), ...reference.slice(5)]);
    // 没暂停时 duration 用完就结束；暂停期间没有倒数，结束晚了 10 帧
    expect(reference.reduce((a, b) => a + b, 0)).toBe(got.reduce((a, b) => a + b, 0));
  });

  it("暂停冻结周期计时与余数：周期发射的序列同样只是平移", () => {
    const def = parse(
      json({
        emitter: {
          rate: 20,
          flags: 4,
          minperiodicduration: 0.3,
          maxperiodicduration: 0.3,
          minperiodicdelay: 0.5,
          maxperiodicdelay: 0.5,
        },
      }),
    );
    const reference = births(make(def), 30);
    const system = make(def);
    const got = births(system, 37, (frame) => {
      if (frame === 2) system.scriptPause();
      if (frame === 9) system.scriptPlay();
    });
    expect(got).toEqual([...reference.slice(0, 3), ...Array(7).fill(0), ...reference.slice(3)]);
  });

  it("暂停时模拟照常：已有粒子继续运动、到寿命就死；暂停位传给 static 子系统", () => {
    const root = parse(json({ life: 0.35 }));
    attach(root, parse(json()), "static");
    const system = make(root);
    births(system, 3);
    const child = system.statics[0].system;
    const childAlive = child.alive;
    const x = system.columns.position[0][0];
    system.scriptPause();
    expect(system.scriptPaused).toBe(true);
    expect(child.scriptPaused).toBe(true);
    system.step(DT);
    expect(system.columns.position[0][0]).toBeGreaterThan(x);
    expect(child.alive).toBe(childAlive);
    births(system, 5);
    expect(system.alive).toBe(0);
    expect(child.alive).toBe(childAlive);
  });

  it("暂停中 eventdeath 照建；建出的实例带着暂停位（不发射），play 之后才发", () => {
    const root = parse(json({ life: 0.25 }));
    attach(root, parse(json({ extra: { maxcount: 32 } })), "eventdeath");
    const system = make(root);
    births(system, 3);
    system.scriptPause();
    births(system, 5);
    const pool = system.events[0];
    expect(pool.active.length).toBeGreaterThan(0);
    for (const instance of pool.active) expect(instance.alive).toBe(0);
    system.scriptPlay();
    system.step(DT);
    for (const instance of pool.active) expect(instance.alive).toBeGreaterThan(0);
  });
});

describe("scriptStop（2.3，实测 a-stop、a-tree；已定 6）", () => {
  function tree() {
    const root = parse(json());
    attach(root, parse(json()), "static");
    attach(root, parse(json({ extra: { maxcount: 32 } })), "eventspawn");
    const system = make(root);
    system.prewarm();
    births(system, 5);
    return system;
  }

  it("全部发射器标结束（递归 static）、计时与系统时间复位、图层时间清零、清全部粒子（递归 static）、销毁活跃实例（空闲池保留）", () => {
    const system = tree();
    const child = system.statics[0].system;
    const pool = system.events[0];
    expect([system.alive > 0, child.alive > 0, pool.active.length > 0]).toEqual([true, true, true]);
    pool.free.push(pool.active.pop()!);
    const free = pool.free.length;
    system.scriptStop();
    expect([system.alive, system.highWater, child.alive, child.highWater, pool.active.length]).toEqual([0, 0, 0, 0, 0]);
    expect(pool.free.length).toBe(free);
    for (const node of [system, child]) {
      for (const { state } of emitters(node)) expect(state).toMatchObject({ ended: true, acc: 0, period: 0 });
      expect(node.systemTime).toBe(0);
    }
    expect(system.layerTime).toBe(0);
    expect(system.scriptStopped).toBe(true);
    expect(system.scriptIsPlaying()).toBe(false);
    // 之后不再发：存活数一直是 0（static 子系统同样）
    births(system, 5);
    expect([system.alive, child.alive]).toEqual([0, 0]);
  });

  it("不清暂停位", () => {
    const system = tree();
    system.scriptPause();
    system.scriptStop();
    expect(system.scriptPaused).toBe(true);
  });

  it("stop 之后改实例系数不重开（已定 6，不复刻 WPE 的 b-stop-write）；自然结束的（rate·count 变成 0）照常重开", () => {
    const system = tree();
    system.scriptStop();
    system.setInstance({ count: 1 });
    system.setInstance({ alpha: 0.5 });
    expect(births(system, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(emitters(system.statics[0].system).every(({ state }) => state.ended)).toBe(true);
    // 对照：count 切到 0 自然结束，再切回 1 照常恢复（i-count0）
    const natural = make(parse(json()));
    natural.setInstance({ count: 0 });
    births(natural, 2);
    expect(emitters(natural)[0].state.ended).toBe(true);
    natural.setInstance({ count: 1 });
    expect(births(natural, 3).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

describe("scriptPlay（2.2，已定 5）", () => {
  it("自然结束、整棵树不活跃后 play：复位计时重新发射（duration 从头算），和刚加载时的发射序列相同", () => {
    const def = parse(json({ emitter: { duration: 0.5 }, life: 0.3 }));
    const reference = births(make(def), 10);
    const system = make(def);
    births(system, 15);
    expect([system.alive, system.isActive(), system.scriptIsPlaying()]).toEqual([0, false, false]);
    system.scriptPlay();
    expect(system.scriptIsPlaying()).toBe(true);
    expect(births(system, 10)).toEqual(reference);
  });

  it("自然结束后 play：instantaneous 再爆发一次", () => {
    const def = parse(json({ emitter: { rate: 0, instantaneous: 3 }, life: 0.3 }));
    const system = make(def);
    expect(births(system, 1)).toEqual([3]);
    births(system, 5);
    expect(system.isActive()).toBe(false);
    system.scriptPlay();
    expect(births(system, 2)).toEqual([3, 0]);
  });

  it("stop → play：从头开始（instantaneous 再爆发，实测 b-stop-inst），解除「被 stop 停下」", () => {
    const def = parse(json({ emitter: { rate: 0, instantaneous: 5 } }));
    const system = make(def);
    expect(births(system, 2)).toEqual([5, 0]);
    system.scriptStop();
    system.scriptPlay();
    expect(system.scriptStopped).toBe(false);
    expect(births(system, 2)).toEqual([5, 0]);
  });

  it("play 解除「被 stop 停下」之后，置脏重算照常重开自然结束的发射器", () => {
    const system = make(parse(json()));
    births(system, 2);
    system.scriptStop();
    system.scriptPlay();
    system.setInstance({ count: 0 });
    births(system, 2);
    expect(emitters(system)[0].state.ended).toBe(true);
    system.setInstance({ count: 1 });
    expect(births(system, 3).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("整棵树还活跃时 play 只清暂停位、不复位计时（发射序列同只暂停）", () => {
    const def = parse(json({ emitter: { duration: 2 } }));
    const reference = births(make(def), 40);
    const system = make(def);
    const got = births(system, 33, (frame) => {
      if (frame === 4) system.scriptPause();
      if (frame === 6) system.scriptPlay();
      if (frame === 7) system.scriptPlay();
    });
    expect(got).toEqual([...reference.slice(0, 5), 0, 0, ...reference.slice(5, 31)]);
  });
});

describe("scriptIsPlaying（第 3 节）", () => {
  it("没暂停且活跃才为真：暂停时有粒子也为假；stop 后为假；自然结束、全部死光后为假", () => {
    const system = make(parse(json({ emitter: { duration: 0.3 }, life: 0.3 })));
    expect(system.scriptIsPlaying()).toBe(true);
    births(system, 2);
    system.scriptPause();
    expect([system.alive > 0, system.scriptIsPlaying()]).toEqual([true, false]);
    system.scriptPlay();
    expect(system.scriptIsPlaying()).toBe(true);
    // 发射器结束、粒子还活着：仍为真（实测 a-done）
    births(system, 2);
    expect([emitters(system)[0].state.ended, system.alive > 0, system.scriptIsPlaying()]).toEqual([true, true, true]);
    births(system, 5);
    expect([system.alive, system.scriptIsPlaying()]).toEqual([0, false]);
    const stopped = make(parse(json()));
    births(stopped, 2);
    stopped.scriptStop();
    expect(stopped.scriptIsPlaying()).toBe(false);
  });

  it("根结束且死光，但 static 子系统或事件实例还活跃时为真", () => {
    const root = parse(json({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 }));
    attach(root, parse(json()), "static");
    const withStatic = make(root);
    births(withStatic, 4);
    expect([withStatic.alive, emitters(withStatic)[0].state.ended]).toEqual([0, true]);
    expect(withStatic.scriptIsPlaying()).toBe(true);

    const parent = parse(json({ emitter: { rate: 0, instantaneous: 1 }, life: 0.15 }));
    attach(parent, parse(json({ extra: { maxcount: 32 } })), "eventdeath");
    const withEvents = make(parent);
    births(withEvents, 4);
    expect([withEvents.alive, withEvents.events[0].active.length]).toEqual([0, 1]);
    expect(withEvents.scriptIsPlaying()).toBe(true);
  });
});

describe("emitParticles（第 4 节，实测 a-emit*、b-args、b-debt）", () => {
  it("参数归一化：int32 整数原样、0 当 1、负数不发；缺参数、非整数、不是数字都当 0 → 1", () => {
    expect(
      [3, 0, -0, undefined, 2.7, -3, -2.5, Number.NaN, "3", 2 ** 31, 7].map((value) => scriptEmitCount(value)),
    ).toEqual([3, 1, 1, 1, 1, 0, 1, 1, 1, 1, 7]);
    const system = make(parse(json({ emitter: { rate: 0 } })));
    const counts = [undefined, 0, 2.7, -3, 4].map((value) => {
      const before = system.alive;
      system.emitParticles(value);
      return system.alive - before;
    });
    expect(counts).toEqual([1, 1, 1, 0, 4]);
  });

  it("每条发射器各发 n 个，不乘 instanceoverride.count（实测 a-emit-count）", () => {
    const two = make(parse(json({ emitter: { rate: 0 }, emitters: 2 })));
    two.emitParticles(3);
    expect(two.alive).toBe(6);
    const counted = make(parse(json({ emitter: { rate: 0 } }), { count: 2 }));
    counted.emitParticles(3);
    expect(counted.alive).toBe(3);
  });

  it("不越过容量：每条现算 容量 − 存活，满了丢弃；门内的欠账按 n 全额记，满了的发射器不记（实测 a-emit-cap）", () => {
    const system = make(parse(json({ emitter: { rate: 0 }, emitters: 2, extra: { maxcount: 8 } })));
    system.emitParticles(20);
    expect(system.alive).toBe(8);
    const [first, second] = emitters(system).map(({ state }) => state);
    expect([first.acc, second.acc]).toEqual([-20, 0]);
  });

  it("连续发射的系统上是欠账（acc −= n），总数不变：之后要等 n / rate 秒才补回（实测 b-debt）", () => {
    const def = parse(json({ emitter: { rate: 5 } }));
    const reference = births(make(def), 12);
    expect(reference).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    const system = make(def);
    const got = births(system, 12, (frame) => {
      if (frame === 3) system.emitParticles(3);
    });
    // 第 4 帧之后的脚本阶段发了 3 个（births 只数步进里的），之后 7 帧都在还账
    expect(got).toEqual([0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(system.alive).toBe(reference.reduce((a, b) => a + b, 0));
  });

  it("越过暂停位、结束位（stop 之后）与 delay：照发 n 个，计时不动（实测 a-emit-paused、a-emit-stopped）", () => {
    const paused = make(parse(json({ emitter: { rate: 5 } })));
    births(paused, 3);
    paused.scriptPause();
    const acc = emitters(paused)[0].state.acc;
    paused.emitParticles(2);
    expect([paused.alive, emitters(paused)[0].state.acc]).toEqual([3, acc]);

    const stopped = make(parse(json()));
    births(stopped, 3);
    stopped.scriptStop();
    stopped.emitParticles(2);
    expect([stopped.alive, emitters(stopped)[0].state.ended, emitters(stopped)[0].state.acc]).toEqual([2, true, 0]);

    const delayed = make(parse(json({ emitter: { delay: 1 } })));
    delayed.emitParticles(2);
    expect([delayed.alive, emitters(delayed)[0].state.delay, emitters(delayed)[0].state.acc]).toEqual([2, 1, 0]);
  });

  it("触发 eventspawn，建实例的 top 用对象的 W（已定 7，不复刻 WPE 的单位阵）；新实例本帧不画、下一帧第一次步进", () => {
    const root = parse(json({ emitter: { rate: 0 } }));
    attach(root, parse(json({ extra: { flags: 1, maxcount: 32 } })), "eventspawn");
    const system = make(root);
    system.prewarm(at(W));
    system.step(DT, undefined, at(W));
    system.emitParticles(1, at(W));
    const [instance] = system.events[0].active;
    // 子世界、父本地：X = W·T(p)·L，p 是控制点 0 的出生点 (0, 0, 0)、L 是单位阵
    expect(Array.from(instance.instanceMatrix!)).toEqual(Array.from(W));
    expect(instance.createdByScript).toBe(true);
    const visited: ParticleSystem[] = [];
    system.forEachDrawn((node) => void visited.push(node));
    expect(visited).toEqual([system]);
    system.step(DT, undefined, at(W));
    expect(instance.createdByScript).toBe(false);
    expect(instance.systemTime).toBe(f32(DT));
    visited.length = 0;
    system.forEachDrawn((node) => void visited.push(node));
    expect(visited).toEqual([system, instance]);
  });

  it("新粒子本帧不画（写顶点、轨迹快照都跳过）；下一帧先增龄 dt′ 再画（rea-p4f-script.md 4.4）", () => {
    const system = make(parse(json({ emitter: { rate: 0, instantaneous: 1 } })));
    system.step(DT);
    expect([system.alive, drawn(system), particleSnapshot(system).length]).toEqual([1, 1, 1]);
    system.emitParticles(2);
    expect([system.alive, drawn(system), particleSnapshot(system).length, system.scriptBornCount]).toEqual([
      3, 1, 1, 2,
    ]);
    const born = [1, 2].filter((slot) => system.scriptBorn![slot] === 1);
    expect(born).toEqual([1, 2]);
    expect(born.map((slot) => system.columns.age[slot])).toEqual([0, 0]);
    system.step(DT);
    expect([drawn(system), particleSnapshot(system).length, system.scriptBornCount]).toEqual([3, 3, 0]);
    expect(born.map((slot) => system.columns.age[slot])).toEqual([f32(DT), f32(DT)]);
  });

  it("rope 表尾部与 ropetrail 的脚本粒子本帧同样不写段", () => {
    const rope = make(parse(json({ extra: { renderer: [{ name: "rope" }] } })));
    births(rope, 3);
    const ropeLayout: RopeVertexLayout = { stride: 24, color: 0, start: 4, end: 8, cp0: 12, cp1: 16, endColor: 20 };
    const segments = () => writeRopeSegments(rope, ropeLayout, new Float32Array(64 * 24), 60);
    expect(segments()).toBe(2);
    rope.emitParticles(2);
    expect(segments()).toBe(2);
    // 下一帧：脚本的 2 个照画；连续发射在还账（acc −= 2），这一帧不出生，所以 5 个粒子 4 段
    rope.step(DT);
    expect(segments()).toBe(4);

    const trail = make(parse(json({ extra: { renderer: [{ name: "ropetrail" }] } })));
    births(trail, 2);
    const trailLayout: TrailVertexLayout = { stride: 19, start: 0, end: 4, cp0: 8, cp1: 12, color: 15 };
    const written = () => writeTrailSegments(trail, trailLayout, new Float32Array(64 * 64 * 19));
    const per = written() / 2;
    trail.emitParticles(1);
    expect(written()).toBe(2 * per);
    trail.step(DT);
    expect(written()).toBe(3 * per);
  });

  it("同一段脚本里先写的系数对这批不生效：emitParticles 用的是当前（重算过的）字段，置脏重算在下一帧（实测 b-emit-alpha）", () => {
    const system = make(parse(json({ emitter: { rate: 0 } })));
    system.emitParticles(1);
    expect(system.columns.alpha0[0]).toBe(1);
    system.setInstance({ alpha: 0.3 });
    system.emitParticles(1);
    expect(system.columns.alpha0[1]).toBe(f32(0.3));
  });

  it("stop 之后清掉本帧的脚本粒子标记；重建时沿用旧树的暂停 / 停止（adoptScriptControl）", () => {
    const system = make(parse(json({ emitter: { rate: 0 } })));
    system.emitParticles(2);
    system.scriptStop();
    expect([system.scriptBornCount, system.alive]).toEqual([0, 0]);
    system.scriptPause();
    const rebuilt = make(parse(json()));
    rebuilt.prewarm();
    births(rebuilt, 2);
    rebuilt.adoptScriptControl(system);
    expect([rebuilt.alive, rebuilt.scriptPaused, rebuilt.scriptStopped]).toEqual([0, true, true]);
    expect(emitters(rebuilt)[0].state.ended).toBe(true);
  });
});

describe("实例覆盖控制点的运行时写入（rea-p4f-script.md 5.5、rea-p4c-sim.md 第 2 节）", () => {
  const none = () => Array(8).fill(null) as (number[] | null)[];
  function overrides(points: Record<number, number[]>, angles: Record<number, number[]> = {}) {
    const controlpoints = none();
    const controlpointAngles = none();
    for (const [i, value] of Object.entries(points)) controlpoints[Number(i)] = value;
    for (const [i, value] of Object.entries(angles)) controlpointAngles[Number(i)] = value;
    return { controlpoints, controlpointAngles } satisfies Partial<ParticleInstanceValues>;
  }
  const translationOf = (system: ParticleSystem, i: number) => Array.from(system.controlPoints.current(i).translation);
  const basisOf = (system: ParticleSystem, i: number) => Array.from(system.controlPoints.current(i).basis);

  it("本地、没有 bit1 的点：平移替换（不加 offset）、角度换 3×3，当场写进 current；之后出生的粒子从新位置出", () => {
    const system = make(parse(json({ emitter: { rate: 0 }, extra: { controlpoint: [{ offset: "5 5 0" }] } })));
    system.prewarm(at(W));
    system.setInstance(overrides({ 0: [10, 20, 0] }, { 0: [0, 0, Math.PI / 2] }));
    expect(translationOf(system, 0)).toEqual([10, 20, 0]);
    expect(basisOf(system, 0)).toEqual(Array.from(eulerBasis([0, 0, Math.PI / 2])));
    system.emitParticles(1);
    expect([system.columns.position[0][0], system.columns.position[1][0]]).toEqual([10, 20]);
  });

  it("世界系统：current = M·base（M 是上一次步进的对象矩阵）；本地带 bit1 的点：current = inverse(M)·base", () => {
    const world = make(parse(json({ extra: { flags: 1 } })));
    world.prewarm(at(W));
    world.setInstance(overrides({ 0: [10, 0, 0] }));
    const expected = multiply(W, translation(10, 0, 0));
    expect(translationOf(world, 0)).toEqual([expected[12], expected[13], expected[14]]);

    const local = make(
      parse(
        json({
          emitter: { controlpoint: 1 },
          extra: { controlpoint: [{}, { flags: 2 }] },
        }),
      ),
    );
    local.prewarm(at(W));
    local.setInstance(overrides({ 1: [10, 0, 0] }));
    const inverse = multiply(invert(W)!, translation(10, 0, 0));
    expect(translationOf(local, 1)).toEqual([inverse[12], inverse[13], inverse[14]]);
  });

  it("跳过指针点（0x10005 的 bit0）；x 为 FLT_MAX 视为未设（之前写进 base 的值保持）；下标 ≥ 控制点数的覆盖不起作用", () => {
    const system = make(
      parse(json({ emitter: { controlpoint: 1 }, extra: { controlpoint: [{ flags: 1, offset: "7 7 0" }, {}] } })),
    );
    system.prewarm(at(W));
    const pointer = translationOf(system, 0);
    system.setInstance(overrides({ 0: [10, 20, 0], 1: [3, 4, 0], 5: [9, 9, 9] }));
    expect(translationOf(system, 0)).toEqual(pointer);
    expect(translationOf(system, 1)).toEqual([3, 4, 0]);
    system.setInstance(overrides({ 1: [FLT_MAX, 50, 50] }));
    expect(translationOf(system, 1)).toEqual([3, 4, 0]);
    expect(system.controlPoints.count).toBe(2);
  });

  it("递归：static 子系统加载时不带对象的覆盖，第一次置脏重算才写进去；池里的事件实例（活跃与空闲）同样", () => {
    const root = parse(json(), { controlpoint0: "10 20 0" });
    attach(root, parse(json()), "static");
    attach(root, parse(json({ extra: { maxcount: 32 } })), "eventspawn");
    const system = make(root);
    system.prewarm();
    births(system, 3);
    const child = system.statics[0].system;
    const pool = system.events[0];
    pool.free.push(pool.active.pop()!);
    expect(translationOf(system, 0)).toEqual([10, 20, 0]);
    expect(translationOf(child, 0)).toEqual([0, 0, 0]);
    expect(translationOf(pool.active[0], 0)).toEqual([0, 0, 0]);
    // 改任一系数都置脏重算：对象当前的控制点覆盖一并写进子孙
    system.setInstance({ alpha: 0.5 });
    for (const node of [child, ...pool.active, ...pool.free]) expect(translationOf(node, 0)).toEqual([10, 20, 0]);
  });
});
