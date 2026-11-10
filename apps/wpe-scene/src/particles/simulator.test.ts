import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, type SceneParticle } from "../compile/particles";
import { sceneViewProjection } from "../render/layout";
import { identity, multiply, rotationX, rotationZ, scaling, translation } from "../render/math";
import { shakeOffset } from "../render/shake";
import { allocatedCount, BASE_COLUMNS, columnCount, ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints, pointerScenePoint } from "./controlpoints";
import { emissionCount, emitterState, sphereRandom } from "./emitters";
import { orBits } from "./f32";
import {
  angularVelocityRandom,
  colorRandom,
  lifetimeRandom,
  rotationRandom,
  sizeRandom,
  velocityRandom,
} from "./initializers";
import {
  COLUMN_FLAGS,
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleCategory,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { alphaFade, angularMovement, MAX_DAMPING, movement, oscillateAlpha, oscillatePosition } from "./operators";
import { intervalValue, SeededRandom, type ParticleRandom } from "./random";
import {
  dragK0,
  instanceMultipliers,
  operatorPass,
  particleColumnFlags,
  particlePasses,
  ParticleSystem,
  prewarmStep,
  prewarmSteps,
} from "./system";
import { particleTrack } from "./track";

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

/** 模块表解析 + 舍入，乘数为 1。 */
function fieldsOf(category: ParticleCategory, module: JsonObject): ParticleFields {
  const reading = readParticleModule(category, module, true);
  return resolveParticleFields(particleModuleDef(category, reading.name)!, reading.fields, ONE);
}

function contextOf(columns: ParticleColumns, random: ParticleRandom, extra: Partial<ParticleRunContext> = {}) {
  return {
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
    ...extra,
  } satisfies ParticleRunContext;
}

/** 和 `ignore/p4/gen.py` 的 `system()` 同形：随机范围收成 min = max。 */
function systemJson(options: {
  origin?: string;
  lifetime?: number;
  size?: number;
  velocity?: string;
  rate?: number;
  maxcount?: number;
  operators?: JsonObject[];
  initializers?: JsonObject[];
  emitter?: JsonObject;
  starttime?: number;
}): JsonObject {
  const fixed = (name: string, value: number | string) => ({ name, min: value, max: value });
  return {
    ...(options.starttime ? { starttime: options.starttime } : {}),
    emitter: [
      {
        name: "sphererandom",
        origin: options.origin ?? "0 0 0",
        distancemin: 0,
        distancemax: 0,
        rate: options.rate ?? 1,
        ...options.emitter,
      },
    ],
    initializer: options.initializers ?? [
      fixed("lifetimerandom", options.lifetime ?? 8),
      fixed("sizerandom", options.size ?? 40),
      fixed("velocityrandom", options.velocity ?? "100 0 0"),
    ],
    maxcount: options.maxcount ?? 1,
    operator: options.operators ?? [{ name: "movement" }],
  };
}

function particle(json: JsonObject, instanceoverride?: unknown): SceneParticle {
  return parseParticle(json, { file: "test.json", orthographic: true, instanceoverride });
}

/** 按 dt 序列步进，返回每帧之后的存活数。 */
function aliveAfter(system: ParticleSystem, dts: number[]): number[] {
  return dts.map((dt) => {
    system.step(dt);
    return system.alive;
  });
}

describe("随机数", () => {
  it("取值公式 (u32 >> 8)·2⁻²⁴·(hi − lo) + lo：低 8 位不用，结果是 float32", () => {
    expect(intervalValue(0, 0, 1)).toBe(0);
    expect(intervalValue(0xff, 0, 1)).toBe(0);
    expect(intervalValue(0x100, 0, 1)).toBe(2 ** -24);
    expect(intervalValue(0xffffffff, 0, 1)).toBe(1 - 2 ** -24);
    const lo = f32(1e-5);
    expect(intervalValue(0, lo, 1)).toBe(lo);
    const top = intervalValue(0xffffffff, lo, 1);
    expect(top).toBeLessThan(1);
    expect(f32(top)).toBe(top);
  });

  it("两个区间 A [0, 1)、B [1e-5, 1)；同一种子序列相同", () => {
    const random = new SeededRandom(42);
    for (let i = 0; i < 20000; i++) {
      const a = random.a();
      const b = random.b();
      expect(a >= 0 && a < 1).toBe(true);
      expect(b >= f32(1e-5) && b < 1).toBe(true);
    }
    const x = new SeededRandom(7);
    const y = new SeededRandom(7);
    expect(Array.from({ length: 5 }, () => x.a())).toEqual(Array.from({ length: 5 }, () => y.a()));
  });
});

describe("列", () => {
  it("容量 maxcount 向上取 4 的倍数分配，有效容量仍是 maxcount", () => {
    expect([0, 1, 4, 5, 499, 500].map(allocatedCount)).toEqual([0, 4, 4, 8, 500, 500]);
    const columns = new ParticleColumns(5, 0);
    expect(columns.capacity).toBe(5);
    expect(columns.allocated).toBe(8);
    expect(columns.age.length).toBe(8);
  });

  it("基础 17 列，五个标志各加 2、3、3、3、1 列", () => {
    expect(BASE_COLUMNS).toBe(17);
    expect(columnCount(0)).toBe(17);
    expect(columnCount(31)).toBe(29);
    expect(new ParticleColumns(4, 31).buffer.length).toBe(29 * 4);
    expect(new ParticleColumns(4, COLUMN_FLAGS.color).buffer.length).toBe(20 * 4);
  });

  it("别名照 WPE：没有 bit0 时旋转三轴同一列，没有 bit3 / bit4 时当前值就是初始值列", () => {
    const plain = new ParticleColumns(4, 0);
    expect(plain.rotation[1]).toBe(plain.rotation[0]);
    expect(plain.rotation[2]).toBe(plain.rotation[0]);
    expect(plain.color).toBe(plain.color0);
    expect(plain.alpha).toBe(plain.alpha0);
    expect(plain.angularVelocity).toBeNull();
    expect(plain.previousPosition).toBeNull();
    const full = new ParticleColumns(4, 31);
    expect(full.rotation[1]).not.toBe(full.rotation[0]);
    expect(full.color).not.toBe(full.color0);
    expect(full.alpha).not.toBe(full.alpha0);
    expect(full.angularVelocity).not.toBeNull();
    expect(full.previousPosition).not.toBeNull();
  });

  it("每遍开头 size ← size0，有对应列时 rgb ← rgb0、a ← a0", () => {
    const columns = new ParticleColumns(4, COLUMN_FLAGS.color | COLUMN_FLAGS.alpha);
    columns.size0[0] = 3;
    columns.color0[1][0] = 0.25;
    columns.alpha0[0] = 0.5;
    columns.size[0] = 9;
    columns.color[1][0] = 9;
    columns.alpha[0] = 9;
    columns.resetCurrent(1);
    expect([columns.size[0], columns.color[1][0], columns.alpha[0]]).toEqual([3, 0.25, 0.5]);
  });

  it("列标志是全部表内模块 columnFlags 的按位或", () => {
    const def = particle(
      systemJson({
        initializers: [{ name: "rotationrandom" }],
        operators: [{ name: "movement" }, { name: "alphafade" }],
      }),
    );
    expect(particleColumnFlags(def)).toBe(COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.alpha);
  });
});

describe("sphererandom", () => {
  const emitter = (module: JsonObject) => fieldsOf("emitter", { name: "sphererandom", ...module });

  it("抽取顺序：φ(B)、cosθ(A)、r(B)、距离为 0 时另抽 3 个方向(B)、速度(B)", () => {
    const columns = new ParticleColumns(4, 0);
    const zero = new ScriptedRandom();
    sphereRandom(emitter({ distancemin: 0, distancemax: 0 }), contextOf(columns, zero));
    expect(zero.calls).toEqual(["b", "a", "b", "b", "b", "b", "b"]);
    const away = new ScriptedRandom();
    sphereRandom(emitter({ distancemin: 10, distancemax: 10 }), contextOf(columns, away));
    expect(away.calls).toEqual(["b", "a", "b", "b"]);
  });

  it("距离用 |p| 不是 r：directions 1 1 0、φ = 0 时 |p| = r·cosθ", () => {
    const columns = new ParticleColumns(4, 0);
    // φ = 2π·0 = 0；cosθ = 0.75·2 − 1 = 0.5；r = cbrt(0.125) = 0.5 → p = (0.25, 0, 0)，|p| = 0.25
    const random = new ScriptedRandom([0, 0.75, 0.125, 0.5]);
    sphereRandom(emitter({ origin: "5 6 7", distancemin: 0, distancemax: 100 }), contextOf(columns, random));
    expect(columns.position[0][0]).toBeCloseTo(5 + 25, 4);
    expect(columns.position[1][0]).toBe(6);
    expect(columns.position[2][0]).toBe(7);
  });

  it("cone = 1 只剩 +X；sign 强制分量同号；速度按方向归一乘 speed", () => {
    const columns = new ParticleColumns(4, 0);
    sphereRandom(
      emitter({ cone: 1, distancemin: 10, distancemax: 10 }),
      contextOf(columns, new ScriptedRandom([0.3, 0.9, 0.7, 0.5])),
    );
    expect(columns.position[0][0]).toBeCloseTo(10, 4);
    expect(Math.abs(columns.position[1][0])).toBeLessThan(1e-5);

    // φ = π/2、cosθ = 0、r = 1 → p = (0, 1, 0)；sign y = −1 时朝下
    const fields = emitter({ sign: "0 -1 0", distancemin: 10, distancemax: 10, speedmin: 50, speedmax: 50 });
    expect(fields.flags).toBe(1);
    sphereRandom(fields, contextOf(columns, new ScriptedRandom([0.25, 0.5, 1, 0.5])));
    expect(columns.position[1][0]).toBeCloseTo(-10, 4);
    expect(columns.velocity[1][0]).toBeCloseTo(-50, 3);
    sphereRandom(
      emitter({ distancemin: 10, distancemax: 10 }),
      contextOf(columns, new ScriptedRandom([0.25, 0.5, 1, 0.5])),
    );
    expect(columns.position[1][0]).toBeCloseTo(10, 4);
  });

  it("距离为 0 时速度方向取 (2u − 1)·directions", () => {
    const columns = new ParticleColumns(4, 0);
    // 方向的 3 个 B：x = 1 → 1，y = 0.5 → 0，z 被 directions.z = 0 消掉
    const random = new ScriptedRandom([0.1, 0.2, 0.3, 1, 0.5, 0.9, 0.5]);
    sphereRandom(emitter({ distancemin: 0, distancemax: 0, speedmin: 50, speedmax: 50 }), contextOf(columns, random));
    expect([columns.velocity[0][0], columns.velocity[1][0], columns.velocity[2][0]]).toEqual([50, 0, 0]);
  });
});

describe("发射数量", () => {
  const fields = (module: JsonObject) => fieldsOf("emitter", { name: "sphererandom", ...module });
  // 非周期发射不抽随机数（周期发射的用例在 emission.test.ts）
  const none = new ScriptedRandom();

  it("累积余数：rate·dt + acc 满 1 才发，余数留到下一帧", () => {
    const f = fields({ rate: 3 });
    const state = emitterState(f);
    expect([0.25, 0.25, 0.25, 0.25, 0.25].map(() => emissionCount(state, f, 0.25, 0, 10, none))).toEqual([
      0, 1, 1, 1, 0,
    ]);
    expect(none.calls).toEqual([]);
  });

  it("instantaneous 从累积余数里扣，之后要等欠账还完：突发 3 个后停 (1 + 3) / rate 秒", () => {
    const f = fields({ rate: 2, instantaneous: 3 });
    const state = emitterState(f);
    const counts = Array.from({ length: 12 }, () => emissionCount(state, f, 0.25, 0, 64, none));
    expect(counts).toEqual([3, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1]);
  });

  it("满容量时不累积；rate ≤ 0 时第一帧后结束", () => {
    const f = fields({ rate: 4 });
    const state = emitterState(f);
    expect(emissionCount(state, f, 0.25, 1, 1, none)).toBe(0);
    expect(state.acc).toBe(0);
    const burst = fields({ rate: 0, instantaneous: 2 });
    const once = emitterState(burst);
    expect([1, 2, 3].map(() => emissionCount(once, burst, 0.1, 0, 10, none))).toEqual([2, 0, 0]);
    expect(once.ended).toBe(true);
  });

  it("满容量后先判死再发射：死的那一帧就补上，满着的帧不攒余数", () => {
    const system = new ParticleSystem(particle(systemJson({ lifetime: 0.6, rate: 2 })), new SeededRandom(1), 1);
    expect(aliveAfter(system, [0.25, 0.25, 0.25, 0.25, 0.25, 0.25])).toEqual([0, 1, 1, 1, 0, 1]);
  });

  it("新粒子填最小的空槽，输出按槽序而不是年龄", () => {
    const system = new ParticleSystem(
      particle(systemJson({ lifetime: 0.6, rate: 4, maxcount: 2, velocity: "100 0 0" })),
      new SeededRandom(1),
      1,
    );
    for (const dt of [0.25, 0.25, 0.25, 0.25]) system.step(dt);
    // 槽 0 的老粒子第 4 帧死掉，新粒子进槽 0（x = 25）；槽 1 是第 2 帧出生的（x = 75）
    const track = particleTrack({
      layers: [{ object: 0, name: "s", particle: system.def }],
      dts: [0.25, 0.25, 0.25, 0.25],
      frames: [4],
      passes: 1,
    });
    expect(track.frames[0].systems.s.map((p) => p.pos[0])).toEqual([25, 75]);
    expect(system.highWater).toBe(2);
  });
});

describe("initializer", () => {
  const init = (name: string, module: JsonObject = {}) => fieldsOf("initializer", { name, ...module });

  it("lifetimerandom 绝对写入，下限 0.001；exponent 取幂", () => {
    const columns = new ParticleColumns(4, 0);
    columns.life[0] = 7;
    lifetimeRandom(init("lifetimerandom", { min: 2, max: 4 }), contextOf(columns, new ScriptedRandom([0.5])));
    expect(columns.life[0]).toBe(3);
    lifetimeRandom(init("lifetimerandom", { min: 0, max: 0 }), contextOf(columns, new ScriptedRandom([0.5])));
    expect(columns.life[0]).toBe(f32(0.001));
    lifetimeRandom(
      init("lifetimerandom", { min: 0, max: 4, exponent: 2 }),
      contextOf(columns, new ScriptedRandom([0.5])),
    );
    expect(columns.life[0]).toBe(1);
  });

  it("sizerandom 乘到 size0（初值 0.5）：40 → 20", () => {
    const columns = new ParticleColumns(4, 0);
    columns.size0[0] = 0.5;
    sizeRandom(init("sizerandom", { min: 40, max: 40 }), contextOf(columns, new ScriptedRandom([0.3])));
    expect(columns.size0[0]).toBe(20);
  });

  it("colorrandom 三通道共用一个 t", () => {
    const columns = new ParticleColumns(4, 0);
    for (let i = 0; i < 3; i++) columns.color0[i][0] = 1;
    const random = new ScriptedRandom([0.5, 0.1, 0.9]);
    colorRandom(init("colorrandom", { min: "0 0 0", max: "255 51 102" }), contextOf(columns, random));
    expect(random.calls).toEqual(["a"]);
    expect([0, 1, 2].map((i) => columns.color0[i][0])).toEqual([0.5, f32(0.1), f32(0.2)]);
  });

  it("velocityrandom 三轴独立，抽取顺序 z、y、x，加到速度", () => {
    const columns = new ParticleColumns(4, 0);
    columns.velocity[0][0] = 1;
    const random = new ScriptedRandom([0.5, 0.25, 0.125]);
    velocityRandom(init("velocityrandom", { min: "0 0 0", max: "8 8 8" }), contextOf(columns, random));
    expect(random.calls).toEqual(["a", "a", "a"]);
    expect([0, 1, 2].map((i) => columns.velocity[i][0])).toEqual([1 + 1, 2, 4]);
  });

  it("rotationrandom、angularvelocityrandom 三轴独立，顺序 x、y、z", () => {
    const columns = new ParticleColumns(4, COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.angularVelocity);
    rotationRandom(
      init("rotationrandom", { min: "0 0 0", max: "8 8 8" }),
      contextOf(columns, new ScriptedRandom([0.5, 0.25, 0.125])),
    );
    expect([0, 1, 2].map((i) => columns.rotation[i][0])).toEqual([4, 2, 1]);
    angularVelocityRandom(
      init("angularvelocityrandom", { min: "0 0 0", max: "8 8 8" }),
      contextOf(columns, new ScriptedRandom([0.5, 0.25, 0.125])),
    );
    expect([0, 1, 2].map((i) => columns.angularVelocity![i][0])).toEqual([4, 2, 1]);
  });
});

describe("operator", () => {
  const op = (name: string, module: JsonObject = {}) => fieldsOf("operator", { name, ...module });

  it("movement：半隐式欧拉，drag 每遍乘 1 − min(drag·k, 0.99999988)", () => {
    const columns = new ParticleColumns(4, 0);
    columns.velocity[0][0] = 10;
    movement(
      op("movement", { gravity: "2 0 0", drag: 0.5 }),
      contextOf(columns, new SeededRandom(), { h: 0.5, k: 0.5 }),
    );
    expect(columns.position[0][0]).toBe(5.5);
    expect(columns.velocity[0][0]).toBe(8.25);
    columns.velocity[0][0] = 10;
    movement(op("movement", { drag: 1e6 }), contextOf(columns, new SeededRandom(), { h: 0.5, k: 0.5 }));
    expect(columns.velocity[0][0]).toBe(f32(10 * f32(1 - MAX_DAMPING)));
    expect(columns.velocity[0][0]).toBeGreaterThan(0);
  });

  describe("movement 的 flags bit0（P4c 步骤 4，rea-p4c-sim.md 5.4，汇编 0x14023fde2–0x14023fe31）", () => {
    /** 跑一次 movement（h = 1、drag 0、速度从 0 起）：速度就是这一遍用的重力。 */
    const gravityUsed = (module: JsonObject, world: boolean, model: Float32Array) => {
      const columns = new ParticleColumns(4, 0);
      movement(op("movement", module), contextOf(columns, new SeededRandom(), { h: 1, k: 0, world, model }));
      return [0, 1, 2].map((i) => columns.velocity[i][0]);
    };
    /** W = T(960, 540)·Rz(0.7)·S(2, 3, 1) 的 3×3（列主序，同 `ParticleRunContext.model`）。 */
    const W = multiply(translation(960, 540, 0), multiply(rotationZ(0.7), scaling(2, 3, 1)));
    const MODEL = new Float32Array([W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10]]);
    const close = (actual: number[], expected: number[]) =>
      actual.forEach((value, i) => expect(value, `第 ${i} 项`).toBeCloseTo(expected[i], 3));

    it("本地系统 flags 1：g = Mᵀ·g（每列点乘 g，含缩放、不归一化）；世界系统、flags 0 都不变换", () => {
      const gravity = "10 -100 5";
      const [c, s] = [Math.cos(0.7), Math.sin(0.7)];
      // 第 0 列 (2c, 2s, 0)、第 1 列 (−3s, 3c, 0)、第 2 列 (0, 0, 1)
      const transposed = [2 * c * 10 + 2 * s * -100, -3 * s * 10 + 3 * c * -100, 5];
      close(gravityUsed({ gravity, flags: 1 }, false, MODEL), transposed);
      // 对照：M·g（不转置）是另一个值
      const straight = [2 * c * 10 - 3 * s * -100, 2 * s * 10 + 3 * c * -100, 5];
      expect(Math.abs(straight[0] - transposed[0])).toBeGreaterThan(100);
      // 世界系统：g 直接是世界方向；flags 0：两种系统都不变换
      expect(gravityUsed({ gravity, flags: 1 }, true, MODEL)).toEqual([10, -100, 5]);
      expect(gravityUsed({ gravity, flags: 0 }, false, MODEL)).toEqual([10, -100, 5]);
      expect(gravityUsed({ gravity }, true, MODEL)).toEqual([10, -100, 5]);
    });

    it("加法顺序照 FUN_1401f87e0：x' = (g.y·m1 + g.x·m0) + g.z·m2，y'、z' 同理（逐步 float32，z 项最后加）", () => {
      // 1e8 与 −1e8 先相消再加 1 得 1；z 项先和其中一个相加会被 1e8 吞掉（float32 在 1e8 附近的间距是 8），得 0
      const model = new Float32Array([-1e8, 1e8, 1, 1e8, -1e8, 1, -1e8, 1e8, 1]);
      expect(gravityUsed({ gravity: "1 1 1", flags: 1 }, false, model)).toEqual([1, 1, 1]);
      // 同一个矩阵不转置（M·g）是 (−1e8, 1e8, 3)
      expect([0, 1, 2].map((r) => f32(f32(f32(model[r]) + f32(model[3 + r])) + f32(model[6 + r])))).toEqual([
        -1e8, 1e8, 3,
      ]);
    });

    it("模拟器：两遍模式每遍都变换；model 每帧按本帧的 W 更新（预热按加载时的）", () => {
      const json = (passes: 1 | 2) => ({
        system: new ParticleSystem(
          particle({
            maxcount: 8,
            emitter: [{ name: "sphererandom", distancemax: 0, rate: 20 }],
            initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
            operator: [{ name: "movement", gravity: "10 -100 5", flags: 1 }],
          }),
          new SeededRandom(1),
          passes,
        ),
      });
      const velocity = (system: ParticleSystem, slot: number) => [0, 1, 2].map((i) => system.columns.velocity[i][slot]);
      const [c, s] = [Math.cos(0.7), Math.sin(0.7)];
      const transposed = [2 * c * 10 + 2 * s * -100, -3 * s * 10 + 3 * c * -100, 5];
      for (const passes of [1, 2] as const) {
        const { system } = json(passes);
        system.prewarm({ world: identity(), pointer: [0, 0] });
        system.step(0.1, undefined, { world: W, pointer: [0, 0] });
        expect(system.highWater, `${passes} 遍`).toBe(2);
        // 两遍各走 h = 0.05：每遍都是 Mᵀ·g，合起来 Mᵀ·g·0.1（只变换第一遍时是 (Mᵀ·g + g)·0.05）
        close(
          velocity(system, 0),
          transposed.map((v) => v * 0.1),
        );
      }
      // 下一帧换一个 W：新出生的按新的 W，已出生的这一帧也按新的 W 加速
      const { system } = json(1);
      system.prewarm({ world: identity(), pointer: [0, 0] });
      system.step(0.1, undefined, { world: W, pointer: [0, 0] });
      const W2 = multiply(rotationZ(-1.2), scaling(0.5, 4, 1));
      system.step(0.1, undefined, { world: W2, pointer: [0, 0] });
      const [c2, s2] = [Math.cos(-1.2), Math.sin(-1.2)];
      const transposed2 = [0.5 * c2 * 10 + 0.5 * s2 * -100, -4 * s2 * 10 + 4 * c2 * -100, 5];
      expect(system.highWater).toBe(4);
      close(
        velocity(system, 2),
        transposed2.map((v) => v * 0.1),
      );
      close(
        velocity(system, 0),
        transposed.map((v, i) => (v + transposed2[i]) * 0.1),
      );
      // 预热也按加载时的 W 变换：starttime 0.1、步长 0.05 共两步，第一个粒子出生在第一步、两步各加 Mᵀ·g·0.05
      // （预热时 model 还是单位阵的话是 g·0.1）
      const warm = new ParticleSystem(
        particle({
          maxcount: 8,
          starttime: 0.1,
          emitter: [{ name: "sphererandom", distancemax: 0, rate: 20 }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
          operator: [{ name: "movement", gravity: "10 -100 5", flags: 1 }],
        }),
        new SeededRandom(1),
        1,
      );
      warm.prewarm({ world: W, pointer: [0, 0] });
      expect(warm.highWater).toBe(2);
      close(
        velocity(warm, 0),
        transposed.map((v) => v * 0.1),
      );
    });
  });

  it("angularmovement：无 blend 时 w' = w + f·h、rot += w'·h", () => {
    const columns = new ParticleColumns(4, COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.angularVelocity);
    columns.angularVelocity![2][0] = 1;
    angularMovement(op("angularmovement", { force: "0 0 2" }), contextOf(columns, new SeededRandom(), { h: 0.5 }));
    expect(columns.angularVelocity![2][0]).toBe(2);
    expect(columns.rotation[2][0]).toBe(1);
  });

  it("alphafade：in、out 是寿命比例；两段同时命中时取按位或", () => {
    const columns = new ParticleColumns(4, COLUMN_FLAGS.alpha);
    const run = (fields: ParticleFields, age: number) => {
      columns.age[0] = age;
      columns.life[0] = 1;
      columns.alpha[0] = 1;
      alphaFade(fields, contextOf(columns, new SeededRandom()));
      return columns.alpha[0];
    };
    const fade = op("alphafade", { fadeintime: 0.25, fadeouttime: 0.75 });
    expect(run(fade, 0.1)).toBeCloseTo(0.4, 6);
    expect(run(fade, 0.5)).toBe(1);
    expect(run(fade, 0.9)).toBeCloseTo(0.4, 6);
    const overlap = op("alphafade", { fadeintime: 0.6, fadeouttime: 0.4 });
    const expected = orBits(f32(f32(0.45) * f32(1 / f32(0.6))), f32(f32(1 - f32(0.45)) * f32(1 / f32(0.6))));
    expect(run(overlap, 0.45)).toBe(expected);
  });

  it("两遍时乘性模块结果不变：每遍开头重置为初始值", () => {
    const def = particle(
      systemJson({ lifetime: 1, operators: [{ name: "alphafade", fadeintime: 0.5, fadeouttime: 0.5 }] }),
    );
    const one = new ParticleSystem(def, new SeededRandom(1), 1);
    const two = new ParticleSystem(def, new SeededRandom(1), 2);
    for (const dt of [1.1, 0.1, 0.1]) {
      one.step(dt);
      two.step(dt);
    }
    expect(one.columns.alpha[0]).toBeCloseTo(0.4, 5);
    expect(two.columns.alpha[0]).toBe(one.columns.alpha[0]);
  });
});

describe("共用 R：oscillateposition、oscillatealpha", () => {
  // distance 0：sphererandom 抽 7 次，第 8 次是 R，之后是 lifetimerandom 的 t
  const R = 0.25;
  const draws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, R, 0.5];
  // rate 10：第一帧 dt 0.1 正好发一个
  const json = systemJson({
    rate: 10,
    initializers: [{ name: "lifetimerandom", min: 60, max: 60 }],
    operators: [
      {
        name: "oscillateposition",
        mask: "1 1 1",
        frequencymin: 1,
        frequencymax: 3,
        phasemin: 0,
        phasemax: 1,
        scalemin: 10,
        scalemax: 30,
      },
      {
        name: "oscillatealpha",
        frequencymin: 1,
        frequencymax: 3,
        phasemin: 0,
        phasemax: 1,
        scalemin: 0.2,
        scalemax: 1,
      },
    ],
  });

  it("R 在发射器之后、initializer 之前抽，写进共用列", () => {
    const random = new ScriptedRandom([...draws]);
    const system = new ParticleSystem(particle(json), random, 1);
    system.step(0.1);
    expect(system.columns.random[0]).toBe(R);
    expect(system.columns.life[0]).toBe(60);
    expect(random.calls).toEqual(["b", "a", "b", "b", "b", "b", "b", "a", "a"]);
  });

  it("给定 R 时位置是 D(τ) 的累加：ω 不乘 2π、相位加在时间上、y 多 2π·R；两个模块用同一个 R", () => {
    const dts = [0.1, 0.05, 0.2, 0.1];
    const system = new ParticleSystem(particle(json), new ScriptedRandom([...draws]), 1);
    for (const dt of dts) system.step(dt);
    const omega = 1 + R * 2;
    const phase = R * 1;
    const s = 10 + R * 20;
    const age = 0.05 + 0.2 + 0.1;
    // 逐帧 sin(ω·t) − sin(ω·(t − h)) 相加：出生帧 age = 0、h = 出生帧 dt，之后逐帧相消
    const closed = (offset: number) => s * (Math.sin(omega * (age + offset)) - Math.sin(omega * (offset - dts[0])));
    const c = system.columns;
    expect(c.position[0][0]).toBeCloseTo(closed(phase), 4);
    expect(c.position[2][0]).toBeCloseTo(closed(phase), 4);
    expect(c.position[1][0]).toBeCloseTo(closed(phase + 2 * Math.PI * R), 4);
    // oscillatealpha：V = smin + R·srange·(1 + sin(ω·t))/2，幅度里多乘一次 R
    const value = 0.2 + R * 0.8 * ((1 + Math.sin(omega * (age + phase))) / 2);
    expect(c.alpha[0]).toBeCloseTo(value, 5);
  });

  it("两遍模式：t 不变、h 减半，增量是两次 D(t; h/2)", () => {
    const dt = 0.2;
    const system = new ParticleSystem(particle(json), new ScriptedRandom([...draws]), 2);
    system.step(0.1);
    const before = system.columns.position[0][0];
    system.step(dt);
    const omega = 1 + R * 2;
    const t = dt + R;
    const half = Math.sin(omega * t) - Math.sin(omega * (t - dt / 2));
    expect(system.columns.position[0][0] - before).toBeCloseTo(2 * (10 + R * 20) * half, 4);
  });
});

describe("一帧", () => {
  it("新粒子出生当帧 age = 0，走完整个 dt：x = origin + v·dt", () => {
    const system = new ParticleSystem(
      particle(systemJson({ origin: "100 50 0", velocity: "100 0 0", rate: 10 })),
      new SeededRandom(1),
      1,
    );
    system.step(0.1);
    expect(system.alive).toBe(1);
    expect(system.columns.age[0]).toBe(0);
    expect(system.columns.position[0][0]).toBeCloseTo(110, 4);
    system.step(0.1);
    expect(system.columns.age[0]).toBe(f32(0.1));
  });

  it("判死是严格大于：age == life 时还活着，下一帧才死、同一帧补发进同一个槽", () => {
    const system = new ParticleSystem(particle(systemJson({ lifetime: 0.5, rate: 4 })), new SeededRandom(1), 1);
    system.step(0.25);
    system.step(0.25);
    system.step(0.25);
    expect(system.columns.age[0]).toBe(0.5);
    expect(system.alive).toBe(1);
    system.step(0.25);
    expect(system.columns.age[0]).toBe(0);
    expect(system.alive).toBe(1);
  });

  it("两遍：重力下第一帧 Δx = c·a·dt²，c = 0.75（两遍）、1（一遍）", () => {
    const def = particle(
      systemJson({ velocity: "0 0 0", rate: 10, operators: [{ name: "movement", gravity: "100 0 0" }] }),
    );
    const one = new ParticleSystem(def, new SeededRandom(1), 1);
    const two = new ParticleSystem(def, new SeededRandom(1), 2);
    one.step(0.1);
    two.step(0.1);
    expect(one.columns.position[0][0]).toBeCloseTo(1, 5);
    expect(two.columns.position[0][0]).toBeCloseTo(0.75, 5);
  });

  it("遍数：fps 1–20 两遍，0、21 以上一遍", () => {
    expect([0, 1, 10, 20, 21, 30, 60, 144].map(particlePasses)).toEqual([1, 2, 2, 2, 1, 1, 1, 1]);
  });

  it("drag 的 k：k0 = pow(min(1, 0.025/frameDt), 0.7)·dt'；两遍时 h、k 都减半", () => {
    expect(dragK0(0.05, 0.05)).toBeCloseTo(Math.pow(0.5, 0.7) * 0.05, 7);
    expect(dragK0(0.05, 0.01)).toBe(f32(0.05));
    expect(dragK0(0.2, 0)).toBe(f32(0.2));
    // instanceoverride.rate = 2：dt' = 0.1，frameDt 仍是 0.05
    expect(dragK0(0.1, 0.05)).toBeCloseTo(Math.pow(0.5, 0.7) * 0.1, 7);
    const one = operatorPass(f32(0.05), 0.05, 1);
    const two = operatorPass(f32(0.05), 0.05, 2);
    expect(one.h).toBe(f32(0.05));
    expect(two.h).toBe(f32(0.025));
    expect(two.k).toBe(f32(one.k / 2));

    const def = particle(systemJson({ velocity: "800 0 0", rate: 20, operators: [{ name: "movement", drag: 0.5 }] }));
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    system.step(0.05);
    expect(system.columns.position[0][0]).toBeCloseTo(40, 4);
    expect(system.columns.velocity[0][0]).toBeCloseTo(800 * (1 - 0.5 * Math.pow(0.5, 0.7) * 0.05), 3);
  });
});

describe("预热", () => {
  it("步长按 maxcount：< 500 时 0.05，否则 0.2；步数按 float32 累加（2.5 s 是 51 步、13 步）", () => {
    expect(prewarmStep(499)).toBe(f32(0.05));
    expect(prewarmStep(500)).toBe(f32(0.2));
    expect(prewarmSteps(2.5, 1)).toBe(51);
    expect(prewarmSteps(2.5, 500)).toBe(13);
    expect(prewarmSteps(0, 1)).toBe(0);
  });

  const pre = (maxcount: number) =>
    particle(
      systemJson({
        origin: "1000 690 0",
        lifetime: 60,
        velocity: "0 0 0",
        maxcount,
        starttime: 2.5,
        operators: [{ name: "movement", gravity: "100 0 0" }],
      }),
    );

  it("maxcount 1：第 20 步出生、受力 32 步（含出生那步），比 g_Time 多走 1.6 s", () => {
    const system = new ParticleSystem(pre(1), new SeededRandom(1), 1);
    system.prewarm();
    expect(system.alive).toBe(1);
    expect(system.columns.velocity[0][0]).toBeCloseTo(160, 3);
    expect(system.columns.position[0][0]).toBeCloseTo(1000 + 0.25 * ((32 * 33) / 2), 3);
    expect(system.columns.age[0]).toBeCloseTo(1.55, 5);
  });

  it("maxcount 500：步长 0.2，第 5 步出生、受力 9 步", () => {
    const system = new ParticleSystem(pre(500), new SeededRandom(1), 1);
    system.prewarm();
    expect(system.alive).toBe(2);
    expect(system.columns.velocity[0][0]).toBeCloseTo(180, 3);
    expect(system.columns.position[0][0]).toBeCloseTo(1000 + 4 * 45, 3);
    expect(system.columns.velocity[0][1]).toBeCloseTo(80, 3);
  });

  it("预热固定一遍：两遍模式的系统预热结果相同", () => {
    const one = new ParticleSystem(pre(1), new SeededRandom(1), 1);
    const two = new ParticleSystem(pre(1), new SeededRandom(1), 2);
    one.prewarm();
    two.prewarm();
    expect(two.columns.position[0][0]).toBe(one.columns.position[0][0]);
  });
});

describe("instanceoverride", () => {
  it("乘数：系统 flags bit4–7 分别禁用 speed、count、lifetime、size", () => {
    const instance = particle(systemJson({}), { size: 2, speed: 3, count: 4, lifetime: 5 }).instance;
    expect(instanceMultipliers(instance, 0)).toEqual({ size: 2, speed: 3, count: 4, lifetime: 5, rate: 1 });
    expect(instanceMultipliers(instance, 0x10)).toEqual({ size: 2, speed: 1, count: 4, lifetime: 5, rate: 1 });
    expect(instanceMultipliers(instance, 0x20)).toEqual({ size: 2, speed: 3, count: 1, lifetime: 5, rate: 1 });
    expect(instanceMultipliers(instance, 0x40)).toEqual({ size: 2, speed: 3, count: 4, lifetime: 1, rate: 1 });
    expect(instanceMultipliers(instance, 0x80)).toEqual({ size: 1, speed: 3, count: 4, lifetime: 5, rate: 1 });
  });

  it("size、alpha、lifetime、speed、count、rate 乘到对应位置，从基值乘", () => {
    const override = { rate: 2, speed: 3, size: 2, alpha: 0.5, lifetime: 2, count: 4 };
    const def = particle(
      systemJson({
        lifetime: 3,
        size: 40,
        velocity: "100 0 0",
        rate: 2,
        maxcount: 64,
        operators: [{ name: "movement", gravity: "10 0 0" }],
      }),
      override,
    );
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    // dt' = 0.25·2 = 0.5；rate 2·4 = 8 → 每帧 4 个
    system.step(0.25);
    expect(system.alive).toBe(4);
    const c = system.columns;
    expect(c.size[0]).toBe(40);
    expect(c.alpha[0]).toBe(0.5);
    expect(c.life[0]).toBe(6);
    // 速度 300，重力 30：v = 300 + 30·0.5，x = v·0.5
    expect(c.velocity[0][0]).toBe(315);
    expect(c.position[0][0]).toBe(157.5);
    // 基值没被改：再建一个系统结果相同
    expect(def.initializers[1].fields.min).toBe(40);
    const again = new ParticleSystem(def, new SeededRandom(1), 1);
    again.step(0.25);
    expect(again.columns.size[0]).toBe(40);
  });

  it("rate 下限 0.01", () => {
    const def = particle(systemJson({ velocity: "100 0 0", rate: 1000 }), { rate: 0 });
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    system.step(1);
    expect(system.columns.position[0][0]).toBeCloseTo(1, 4);
  });

  it("oscillateposition 的频率、发射速度乘 speed", () => {
    const def = particle(
      systemJson({
        emitter: { distancemin: 10, distancemax: 10, speedmin: 5, speedmax: 5 },
        initializers: [{ name: "lifetimerandom", min: 9, max: 9 }],
        operators: [{ name: "oscillateposition", frequencymin: 1, frequencymax: 1 }],
      }),
      { speed: 2 },
    );
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    const resolved = (system as unknown as { operators: { fields: ParticleFields }[] }).operators[0].fields;
    expect(resolved.frequencymin).toBe(2);
    const emitter = (system as unknown as { emitters: { fields: ParticleFields }[] }).emitters[0].fields;
    expect(emitter.speedmax).toBe(10);
  });
});

describe("轨迹", () => {
  it("只输出指定帧；没有存活粒子的系统不出现；字段与 RenderDoc 轨迹同义", () => {
    // 只在第一帧发一个（rate 0 + instantaneous 1）
    const def = particle(
      systemJson({
        origin: "10 20 0",
        emitter: { rate: 0, instantaneous: 1 },
        initializers: [
          { name: "lifetimerandom", min: 0.15, max: 0.15 },
          { name: "sizerandom", min: 40, max: 40 },
          { name: "colorrandom", min: "255 0 0", max: "255 0 0" },
          { name: "rotationrandom", min: "0.1 0.2 0.3", max: "0.1 0.2 0.3" },
        ],
      }),
    );
    const track = particleTrack({
      layers: [
        { object: 3, name: "p", particle: def },
        { object: 4, name: "image", particle: null },
      ],
      dts: [0.1, 0.1, 0.1],
      frames: [1, 3],
      passes: 1,
      project: "x",
      tag: "t",
    });
    expect(track).toMatchObject({ source: "sim", project: "x", tag: "t", skipped: {} });
    expect(track.frames.map((frame) => frame.frame)).toEqual([1, 3]);
    expect(track.frames[0].systems.p).toEqual([
      { pos: [10, 20, 0], size: 20, color: [1, 0, 0], alpha: 1, rot: [f32(0.1), f32(0.2), f32(0.3)] },
    ]);
    // 第 1 帧出生，第 3 帧 age 0.2 > 0.15 死掉；emitter 第一帧后就结束了
    expect(track.frames[1].systems).toEqual({});
    expect(() => particleTrack({ layers: [], dts: [0.1], frames: [2], passes: 1 })).toThrow();
  });

  it("表外模块不执行，记在 skipped", () => {
    const def = particle(
      systemJson({ operators: [{ name: "movement" }, { name: "reducemovementnearcontrolpoint", controlpoint: 0 }] }),
    );
    const track = particleTrack({
      layers: [{ object: 0, name: "p", particle: def }],
      dts: [0.1],
      frames: [1],
      passes: 1,
    });
    expect(track.skipped).toEqual({ p: ["operator:reducemovementnearcontrolpoint"] });
  });
});

describe("控制点：帧内顺序与世界矩阵（P4c 步骤 1，rea-p4c-sim.md 1.3、1.5）", () => {
  /**
   * 控制点 1 带 flags 2、offset (100, 100, 0)：本地系统里 current = inverse(W)·base。发射器读控制点 1、距离 0、速度 0，出生点就是
   * 控制点的平移。
   */
  const json = (extra: JsonObject = {}): JsonObject => ({
    maxcount: 32,
    emitter: [{ name: "sphererandom", controlpoint: 1, distancemax: 0, rate: 10 }],
    initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    controlpoint: [{}, { offset: "100 100 0", flags: 2 }],
    ...extra,
  });
  const born = (system: ParticleSystem, slot: number) => [0, 1, 2].map((i) => system.columns.position[i][slot]);
  const at = (x: number) => translation(x, 0, 0);

  it("更新在发射之前：本帧 W 变了，本帧出生的粒子已经用本帧的 inverse(W)", () => {
    const system = new ParticleSystem(particle(json()), new SeededRandom(1), 1);
    system.prewarm({ world: identity(), pointer: [0, 0] });
    system.step(0.25, undefined, { world: at(1000), pointer: [0, 0] });
    expect(system.alive).toBe(2);
    expect(born(system, 0)).toEqual([-900, 100, 0]);
    expect(born(system, 1)).toEqual([-900, 100, 0]);
    system.step(0.25, undefined, { world: at(2000), pointer: [0, 0] });
    expect(born(system, 2)).toEqual([-1900, 100, 0]);
    // 已出生的不动（速度 0）
    expect(born(system, 0)).toEqual([-900, 100, 0]);
  });

  it("预热前按加载时的 W 更新一次、previous ← current；预热的每一步照常更新；starttime 0 也做", () => {
    const zero = new ParticleSystem(particle(json()), new SeededRandom(1), 1);
    zero.prewarm({ world: at(500), pointer: [0, 0] });
    expect(Array.from(zero.controlPoints.current(1).translation)).toEqual([-400, 100, 0]);
    expect(Array.from(zero.controlPoints.previous(1).translation)).toEqual([-400, 100, 0]);
    const warm = new ParticleSystem(particle(json({ starttime: 0.5 })), new SeededRandom(1), 1);
    warm.prewarm({ world: at(500), pointer: [0, 0] });
    expect(warm.alive).toBeGreaterThan(0);
    for (let slot = 0; slot < warm.highWater; slot++) expect(born(warm, slot)).toEqual([-400, 100, 0]);
    // 不传 W（单测）时按单位阵
    const plain = new ParticleSystem(particle(json({ starttime: 0.5 })), new SeededRandom(1), 1);
    plain.prewarm();
    expect(born(plain, 0)).toEqual([100, 100, 0]);
  });

  it("endFrame 在全部 operator 之后：operator 里读到的 previous 是上一帧的 current，帧尾才拷", () => {
    const system = new ParticleSystem(particle(json({ operator: [{ name: "movement" }] })), new SeededRandom(1), 2);
    const seen: number[][] = [];
    const spy = {
      name: "spy",
      def: particleModuleDef("operator", "movement")!,
      base: {},
      fields: {},
      run: (_: ParticleFields, context: ParticleRunContext) =>
        seen.push([context.controlPoints.previous(1).translation[0], context.controlPoints.current(1).translation[0]]),
    };
    (system as unknown as { operators: (typeof spy)[] }).operators.push(spy);
    system.prewarm({ world: identity(), pointer: [0, 0] });
    system.step(0.1, undefined, { world: at(1000), pointer: [0, 0] });
    system.step(0.1, undefined, { world: at(2000), pointer: [0, 0] });
    system.step(0.1, undefined, { world: at(3000), pointer: [0, 0] });
    // 两遍模式：每帧 operator 跑两遍，控制点只更新一次
    expect(seen).toEqual([
      [100, -900],
      [100, -900],
      [-900, -1900],
      [-900, -1900],
      [-1900, -2900],
      [-1900, -2900],
    ]);
    expect(Array.from(system.controlPoints.previous(1).translation)).toEqual([-2900, 100, 0]);
  });

  it("两遍模式也只更新一次；不步进的帧（dt 不是正数）不更新", () => {
    const system = new ParticleSystem(particle(json()), new SeededRandom(1), 2);
    let updates = 0;
    const update = system.controlPoints.update.bind(system.controlPoints);
    system.controlPoints.update = (inputs) => {
      updates++;
      update(inputs);
    };
    system.prewarm();
    expect(updates).toBe(1);
    system.step(0.1);
    system.step(0.1);
    expect(updates).toBe(3);
    system.step(0);
    expect(updates).toBe(3);
  });

  it("particleTrack：W 按全部图层的编译期变换沿父链算（静态），预热与每帧都传", () => {
    const def = particle(json());
    const layers = [
      {
        object: 0,
        name: "group",
        particle: null,
        origin: [1000, 0, 0],
        angles: [0, 0, 0],
        scale: [1, 1, 1],
        parent: null,
      },
      { object: 1, name: "p", particle: def, origin: [0, 50, 0], angles: [0, 0, 0], scale: [2, 2, 1], parent: 0 },
    ];
    const track = particleTrack({ layers, dts: [0.25], frames: [1], passes: 1 });
    // inverse(T(1000, 50)·S(2))·(100, 100) = ((100 − 1000)/2, (100 − 50)/2)
    expect(track.frames[0].systems.p[0].pos).toEqual([-450, 25, 0]);
    // 没给变换（手写的图层）按单位变换
    const bare = particleTrack({
      layers: [{ object: 1, name: "p", particle: def }],
      dts: [0.25],
      frames: [1],
      passes: 1,
    });
    expect(bare.frames[0].systems.p[0].pos).toEqual([100, 100, 0]);
  });

  it("particleTrack（P4c 步骤 2）：cursors 每帧反投影成跟随点，第 1 项也给预热；不给时是场景中心；给 cursors 要给 size、等长", () => {
    const def = particle({
      maxcount: 32,
      starttime: 0.3,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 4 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      controlpoint: [{ flags: 1, offset: "100 100 0" }],
    });
    const layers = [
      { object: 1, name: "p", particle: def, origin: [960, 540, 0], angles: [0, 0, 0], scale: [1, 1, 1] },
    ];
    const options = { layers, dts: [0.25, 0.25, 0.25], frames: [3], passes: 1 as const, size: [1920, 1080] as const };
    const track = particleTrack({
      ...options,
      cursors: [
        [0.25, 0.75],
        [0.5, 0.25],
        [1.25, 0],
      ],
    });
    const positions = track.frames[0].systems.p.map((particle) => particle.pos.slice(0, 2));
    // 预热与第 1 帧：(480, 270)；第 2 帧 (960, 810)；第 3 帧（窗口外）(2400, 1080)；本地再减对象原点
    const expected = new Set(["-480,-270", "0,270", "1440,540"]);
    expect(new Set(positions.map((pos) => pos.map((v) => Math.round(v * 1000) / 1000).join(",")))).toEqual(expected);
    expect(positions.length).toBeGreaterThanOrEqual(4);
    const center = particleTrack(options);
    // 场景中心 (960, 540) 正好是对象原点（反投影的逆矩阵差 1 ulp，按 1e-3 比）
    for (const pos of center.frames[0].systems.p.map((particle) => particle.pos))
      pos.forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-3));
    expect(() =>
      particleTrack({
        ...options,
        size: undefined,
        cursors: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      }),
    ).toThrow();
    expect(() => particleTrack({ ...options, cursors: [[0, 0]] })).toThrow();
  });

  describe("particleTrack 的抖动（P5a 步骤 3）：第 n 帧的跟随点按第 n − 1 帧的 s 反投影，第 1 帧与预热用 0", () => {
    const def = particle({
      maxcount: 32,
      starttime: 0.3,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 4 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      controlpoint: [{ flags: 1 }],
    });
    // 对象在原点：粒子位置就是跟随点（场景坐标）
    const layers = [{ object: 1, name: "p", particle: def, origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1] }];
    const size = [1920, 1080] as const;
    const SHAKE = { camerashake: true, camerashakespeed: 1, camerashakeamplitude: 1, camerashakeroughness: 1 };
    const base = sceneViewProjection({ width: 1920, height: 1080 });
    const follow = (cursor: readonly [number, number], s: readonly [number, number] = [0, 0]) =>
      pointerScenePoint(multiply(base, translation(-s[0], -s[1], 0)), cursor);
    /** 离 `point` 最近的粒子与它的距离。 */
    const nearest = (track: ReturnType<typeof particleTrack>, point: readonly number[]) =>
      Math.min(...track.frames[0].systems.p.map((item) => Math.hypot(item.pos[0] - point[0], item.pos[1] - point[1])));

    it.each([
      // p5a-shakepar（speed 1 / amplitude 1 / roughness 1）：第 n − 1 帧的指针没用到（那一帧的出生点不比）
      {
        frame: 119,
        pointer: [0.8807291388511658, 0.8916666507720947] as const,
        times: [5.913329601287842, 6.000349998474121],
        born: [1701.07, 127.796],
      },
      {
        frame: 120,
        pointer: [0.8947916626930237, 0.979629635810852] as const,
        times: [6.000349998474121, 6.115821838378906],
        born: [1728.371, 32.687],
      },
    ])("WPE 实测第 $frame 帧：新生粒子在「当帧指针 + 上一帧 s」，和 WPE 差 < 1e-2；不给 shake 时差十几像素", (item) => {
      const options = {
        layers,
        dts: [0.25, 0.25],
        times: item.times,
        frames: [2],
        passes: 1 as const,
        size,
        cursors: [[0.5, 0.5] as const, item.pointer],
      };
      expect(nearest(particleTrack({ ...options, shake: SHAKE }), item.born)).toBeLessThan(1e-2);
      expect(nearest(particleTrack(options), item.born)).toBeGreaterThan(10);
    });

    it("没给 times 时按累加的场景时间；第 1 帧（和预热）不带抖动；关着时与不给逐字节相同", () => {
      const cursors = [[0.25, 0.75] as const, [0.5, 0.25] as const, [0.75, 0.5] as const];
      const options = { layers, dts: [0.25, 0.25, 0.25], frames: [3], passes: 1 as const, size, cursors };
      const track = particleTrack({ ...options, shake: SHAKE });
      const s = (time: number) => shakeOffset(SHAKE, time, 1080);
      expect(nearest(track, follow(cursors[0]))).toBeLessThan(1e-3);
      expect(nearest(track, follow(cursors[1], s(0.25)))).toBeLessThan(1e-3);
      expect(nearest(track, follow(cursors[2], s(0.5)))).toBeLessThan(1e-3);
      // 当帧 s 对不上：s(0.5) 与 s(0.75) 差几像素
      expect(nearest(track, follow(cursors[2], s(0.75)))).toBeGreaterThan(0.5);
      const plain = particleTrack(options);
      expect(particleTrack({ ...options, shake: { ...SHAKE, camerashake: false } })).toEqual(plain);
      expect(JSON.stringify(particleTrack({ ...options, shake: { ...SHAKE, camerashake: false } }))).toBe(
        JSON.stringify(plain),
      );
    });
  });

  describe("particleTrack 的缩放（P5a 步骤 4）：跟随点按带缩放的正交投影反投影，叠加上一帧的抖动", () => {
    const def = particle({
      maxcount: 32,
      starttime: 0.3,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 4 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      controlpoint: [{ flags: 1 }],
    });
    // 对象在原点：粒子位置就是跟随点（场景坐标）
    const layers = [{ object: 1, name: "p", particle: def, origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1] }];
    const size = [1920, 1080] as const;
    const SHAKE = { camerashake: true, camerashakespeed: 1, camerashakeamplitude: 1, camerashakeroughness: 1 };
    const nearest = (track: ReturnType<typeof particleTrack>, point: readonly number[]) =>
      Math.min(...track.frames[0].systems.p.map((item) => Math.hypot(item.pos[0] - point[0], item.pos[1] - point[1])));

    it.each([
      // 计划「步骤 4」补测（`ignore/p5/s4/fixtures.py`，`p5a-zoomx*`，抖动 speed 1 / amplitude 1 / roughness 1）：第 n − 1 帧的指针没用到
      {
        tag: "zoomx15 第 118 帧",
        zoom: 1.5,
        pointer: [1.1276041269302368, 1.1129629611968994] as const,
        times: [5.870555877685547, 5.948989391326904],
        born: [1773.226806640625, 109.46224975585938],
      },
      {
        tag: "zoomx08 第 119 帧",
        zoom: 0.8,
        pointer: [1.0906250476837158, 1.0361111164093018] as const,
        times: [5.914529800415039, 5.995542049407959],
        born: [2387.57421875, -172.95489501953125],
      },
    ])("WPE 实测（$tag）：新生粒子和 WPE 差 < 1e-2；不给 zoom 时差上百", (item) => {
      const options = {
        layers,
        dts: [0.25, 0.25],
        times: item.times,
        frames: [2],
        passes: 1 as const,
        size,
        cursors: [[0.5, 0.5] as const, item.pointer],
        shake: SHAKE,
      };
      expect(nearest(particleTrack({ ...options, zoom: item.zoom }), item.born)).toBeLessThan(1e-2);
      expect(nearest(particleTrack(options), item.born)).toBeGreaterThan(100);
    });

    it("预热也按带缩放的投影（场景中心不动）；zoom 1 与不给逐字节相同", () => {
      const cursors = [[0.25, 0.75] as const, [0.75, 0.5] as const];
      const options = { layers, dts: [0.25, 0.25], frames: [2], passes: 1 as const, size, cursors };
      const zoomed = particleTrack({ ...options, zoom: 2 });
      const view = sceneViewProjection({ width: 1920, height: 1080 }, 2);
      // 第 1 帧（和预热）的指针是 (0.25, 0.75)：带缩放时落在 (720, 405)，不带缩放是 (480, 270)
      const loaded = pointerScenePoint(view, cursors[0]);
      expect(loaded[0]).toBeCloseTo(720, 3);
      expect(loaded[1]).toBeCloseTo(405, 3);
      expect(nearest(zoomed, [720, 405])).toBeLessThan(1e-3);
      expect(nearest(zoomed, pointerScenePoint(view, cursors[1]))).toBeLessThan(1e-3);
      const plain = particleTrack(options);
      expect(JSON.stringify(particleTrack({ ...options, zoom: 1 }))).toBe(JSON.stringify(plain));
    });
  });
});

describe("世界空间（P4c 步骤 4，rea-p4c-sim.md 5.2、5.5）", () => {
  /** W = T(960, 540)·Rz(π/2)·S(2, 2, 1)：第 0 列 (0, 2, 0)，第 1 列 (−2, 0, 0)。 */
  const W = multiply(translation(960, 540, 0), multiply(rotationZ(Math.PI / 2), scaling(2, 2, 1)));
  const pos = (system: ParticleSystem, slot: number) => [0, 1, 2].map((i) => system.columns.position[i][slot]);
  const vel = (system: ParticleSystem, slot: number) => [0, 1, 2].map((i) => system.columns.velocity[i][slot]);
  const close = (actual: number[], expected: number[]) =>
    actual.forEach((value, i) => expect(value, `第 ${i} 项`).toBeCloseTo(expected[i], 2));
  /**
   * 控制点 0 的 offset (10, 20, 0)；发射器 origin (100, 0, 0)、方向 +x、距离 100（q = (100, 0, 0)）、速度 0；velocityrandom (50, 0, 0)。
   * 没有 operator：位置只由出生决定。
   */
  const system = (flags: number, extra: JsonObject = {}) =>
    new ParticleSystem(
      particle({
        flags,
        maxcount: 8,
        controlpoint: [{ offset: "10 20 0" }],
        emitter: [
          {
            name: "sphererandom",
            origin: "100 0 0",
            directions: "1 0 0",
            sign: "1 0 0",
            distancemin: 100,
            distancemax: 100,
            rate: 20,
          },
        ],
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "velocityrandom", min: "50 0 0", max: "50 0 0" },
        ],
        operator: [],
        ...extra,
      }),
      new SeededRandom(1),
      1,
    );

  it("出生点 = mat3(W·base)·q + (W·base.t + origin)，origin 不经 W；velocityrandom 乘 mat3(W·base)（含缩放）", () => {
    const world = system(1);
    world.prewarm({ world: W, pointer: [0, 0] });
    world.step(0.1, undefined, { world: W, pointer: [0, 0] });
    expect(world.highWater).toBe(2);
    // mat3(W)·(100, 0, 0) = (0, 200, 0)；W·(10, 20, 0) = (960 − 40, 540 + 20)；origin 直接加 (100, 0, 0)
    close(pos(world, 0), [920 + 100, 560 + 200, 0]);
    close(vel(world, 0), [0, 100, 0]);
    // 本地系统同样的设置：控制点 0 不旋出生点，位置在对象空间（绘制时再乘 W）；速度仍乘控制点的 3×3（单位阵）
    const local = system(0);
    local.prewarm({ world: W, pointer: [0, 0] });
    local.step(0.1, undefined, { world: W, pointer: [0, 0] });
    close(pos(local, 0), [100 + 10 + 100, 20, 0]);
    close(vel(local, 0), [50, 0, 0]);
  });

  it("已发出的粒子存世界坐标：W 变了不动，之后出生的按新的 W", () => {
    const world = system(1);
    world.prewarm({ world: W, pointer: [0, 0] });
    world.step(0.1, undefined, { world: W, pointer: [0, 0] });
    const before = pos(world, 0);
    world.step(0.1, undefined, { world: translation(-500, 300, 0), pointer: [0, 0] });
    expect(pos(world, 0)).toEqual(before);
    expect(world.highWater).toBe(4);
    close(pos(world, 2), [-500 + 10 + 100 + 100, 300 + 20, 0]);
  });

  it("vortex：世界系统里中心是 W·base.t、轴不变换（固定在世界）", () => {
    // 对象绕 x 转 0.5：轴若随对象转，切向速度会带 z 分量
    const tilted = multiply(translation(960, 540, 0), rotationX(0.5));
    const world = system(1, {
      controlpoint: [],
      emitter: [
        { name: "sphererandom", directions: "1 0 0", sign: "1 0 0", distancemin: 100, distancemax: 100, rate: 20 },
      ],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      operator: [
        { name: "vortex", axis: "0 0 1", distanceinner: 50, distanceouter: 300, speedinner: 200, speedouter: 50 },
      ],
    });
    world.prewarm({ world: tilted, pointer: [0, 0] });
    world.step(0.1, undefined, { world: tilted, pointer: [0, 0] });
    // Rx 不动 x 轴：出生在 (1060, 540, 0)，离中心 (960, 540, 0) 100，切向是 r̂ × z = −y
    close(pos(world, 0), [1060, 540, 0]);
    const [vx, vy, vz] = vel(world, 0);
    expect(vz).toBe(0);
    expect(Math.abs(vx)).toBeLessThan(1e-3);
    expect(vy).toBeLessThan(-1);
  });
});
