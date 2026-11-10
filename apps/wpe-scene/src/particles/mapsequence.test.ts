/**
 * P4d 步骤 3：`mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`。依据 rea-p4d-modules.md 1.1–1.3（读码【确】），
 * 实测见 `p4-particles-REPORT.md`「P4d 语义的实测核对」的 mapsequence 表；回放见 `ignore/p4/cases/d3.json`。
 *
 * 序号序列的参照值是 `ignore/p4/rea/p4d-mod/seq.py`（rea 1.1、1.2 的 float32 推演）的输出，`%.9g` 能唯一还原 float32，逐位比较。
 */
import { describe, expect, it } from "vitest";
import { checkParticleFeatures } from "../compile/features";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { ControlPointSet, controlPointCount, IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import { TWO_PI } from "./f32";
import {
  advanceSequence,
  aroundBasis,
  aroundStep,
  betweenStep,
  mapSequenceAround,
  mapSequenceBetween,
  type SequenceState,
} from "./mapsequence";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type InstanceMultipliers,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { SeededRandom, type ParticleRandom } from "./random";
import { instanceMultipliers, ParticleSystem } from "./system";

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };
const AROUND = "mapsequencearoundcontrolpoint";
const BETWEEN = "mapsequencebetweencontrolpoints";

class ScriptedRandom implements ParticleRandom {
  readonly calls: ("a" | "b")[] = [];
  constructor(private readonly values: number[] = []) {}
  a(): number {
    this.calls.push("a");
    return f32(this.values.shift() ?? 0.5);
  }
  b(): number {
    this.calls.push("b");
    return f32(this.values.shift() ?? 0.5);
  }
}

function fieldsOf(name: string, module: JsonObject = {}, multipliers = ONE): ParticleFields {
  const reading = readParticleModule("initializer", { name, ...module }, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("initializer", name)!, reading.fields, multipliers);
}

/** 只有平移（和可选的 z 角度）的控制点；8 个都存在。 */
function points(offsets: [number, number, number][], angles: (number[] | null)[] = []): ControlPointSet {
  return new ControlPointSet(
    {
      emitters: [],
      initializers: [],
      operators: [],
      flags: 0,
      controlpoints: offsets.map((offset) => ({ flags: 0, offset })),
      instance: { controlpoints: [], controlpointAngles: angles },
    },
    8,
  );
}

/** 槽 0 放在 `position`、速度 `velocity`、`size0 = 1` 的执行上下文。 */
function context(
  position: number[],
  extra: Partial<ParticleRunContext> = {},
  velocity: number[] = [0, 0, 0],
): ParticleRunContext {
  const columns = new ParticleColumns(4, 0);
  for (let i = 0; i < 3; i++) {
    columns.position[i][0] = position[i];
    columns.velocity[i][0] = velocity[i];
  }
  columns.size0[0] = 1;
  return {
    columns,
    random: new ScriptedRandom(),
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
  };
}

const position = (c: ParticleRunContext) => [0, 1, 2].map((i) => c.columns.position[i][0]);
const velocity = (c: ParticleRunContext) => [0, 1, 2].map((i) => c.columns.velocity[i][0]);

/** 按序号走 n 个：返回每个粒子用的 seq（先用后加）。 */
function sequence(state: SequenceState, n: number, mirror: boolean, wrapToZero: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(state.seq);
    advanceSequence(state, mirror, wrapToZero);
  }
  return out;
}
const values = (text: string) => text.split(" ").map((value) => f32(Number(value)));

describe("advanceSequence：序号先用后加（rea 1.1、1.2 的 float32 推演，seq.py 逐位）", () => {
  it("around count 5 repeat：第一圈 6 个值（1.0 不大于 1，留着），之后 fmodf 得 0.20000005", () => {
    const state = { seq: 0, step: aroundStep(f32(5)) };
    expect(state.step).toBe(f32(0.2));
    expect(sequence(state, 12, false, false)).toEqual(
      values(
        "0 0.200000003 0.400000006 0.600000024 0.800000012 1 0.200000048 0.400000036 0.600000024 0.800000012 1 0.200000048",
      ),
    );
  });

  it("around count 2.2：repeat 不成周期；mirror 反射并把 step 取反", () => {
    const repeat = { seq: 0, step: aroundStep(f32(2.2)) };
    expect(repeat.step).toBe(f32(0.45454543828964233));
    expect(sequence(repeat, 12, false, false)).toEqual(
      values(
        "0 0.454545438 0.909090877 0.363636255 0.818181694 0.272727132 0.72727257 0.181818008 0.636363447 0.090908885 0.545454323 0.999999762",
      ),
    );
    const mirror = { seq: 0, step: aroundStep(f32(2.2)) };
    expect(sequence(mirror, 12, true, false)).toEqual(
      values(
        "0 0.454545438 0.909090877 0.636363745 0.181818306 0.272727132 0.72727257 0.818181992 0.363636553 0.090908885 0.545454323 0.999999762",
      ),
    );
    expect(mirror.step).toBe(-f32(0.45454543828964233));
  });

  it("between count 8 repeat：一圈 8 个点含两端（第 8 个恰好是 1.0），超过 1 归零", () => {
    const state = { seq: 0, step: betweenStep(f32(8)) };
    expect(state.step).toBe(f32(0.1428571492433548));
    expect(sequence(state, 20, false, true)).toEqual(
      values(
        "0 0.142857149 0.285714298 0.428571463 0.571428597 0.714285731 0.857142866 1 0 0.142857149 0.285714298 0.428571463 0.571428597 0.714285731 0.857142866 1 0 0.142857149 0.285714298 0.428571463",
      ),
    );
  });

  it("between count 4 mirror：两端反射，seq < 0 时取反（5.96e−8 之后）", () => {
    const state = { seq: 0, step: betweenStep(f32(4)) };
    expect(sequence(state, 12, true, true)).toEqual(
      values(
        "0 0.333333343 0.666666687 1 0.666666627 0.333333284 5.96046448e-08 0.333333403 0.666666746 0.999999881 0.666666508 0.333333164",
      ),
    );
    expect(state.step).toBe(f32(0.3333333432674408));
  });

  it("步长：count 的下限 1e-4（float 0x38d1b717），between 先减 1", () => {
    const min = f32(1e-4);
    expect(aroundStep(0)).toBe(f32(1 / min));
    expect(aroundStep(-3)).toBe(f32(1 / min));
    expect(betweenStep(1)).toBe(f32(1 / min));
    expect(betweenStep(f32(2.5))).toBe(f32(1 / f32(1.5)));
    expect(aroundStep(f32(1e-4))).toBe(f32(1 / min));
  });
});

describe("aroundBasis（FUN_1401c19e0）", () => {
  it("缺省轴、零向量、0 0 -1：B1 = (1,0,0)、B2 = (0,1,0)；轴归一化", () => {
    expect(aroundBasis([0, 0, 1])).toEqual({ axis: [0, 0, 1], b1: [1, 0, 0], b2: [0, 1, 0] });
    expect(aroundBasis([0, 0, 0])).toEqual({ axis: [0, 0, 1], b1: [1, 0, 0], b2: [0, 1, 0] });
    expect(aroundBasis([0, 0, -1])).toEqual({ axis: [0, 0, -1], b1: [1, 0, 0], b2: [0, 1, 0] });
    expect(aroundBasis([0, 0, 5])).toEqual({ axis: [0, 0, 1], b1: [1, 0, 0], b2: [0, 1, 0] });
  });

  it("0 1 0（语料 dna.json）：B1 = (1,0,0)、B2 = (0,0,−1)", () => {
    expect(aroundBasis([0, 1, 0])).toEqual({ axis: [0, 1, 0], b1: [1, 0, 0], b2: [0, 0, -1] });
  });

  it("一般方向：t = a × z、B2 = a × t 都归一化，三者两两正交", () => {
    const { axis, b1, b2 } = aroundBasis([1, 2, 2]);
    // |a| = 3：a·(1/3)，倒数先舍入
    const third = f32(1 / 3);
    expect(axis).toEqual([third, f32(2 * third), f32(2 * third)]);
    const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    expect(dot(axis, b1)).toBeCloseTo(0, 6);
    expect(dot(axis, b2)).toBeCloseTo(0, 6);
    expect(dot(b1, b2)).toBeCloseTo(0, 6);
    expect(b1[2]).toBe(0);
    // t = (a.y, −a.x, 0) 归一化
    expect(b1[0]).toBeCloseTo(2 / Math.sqrt(5), 6);
    expect(b1[1]).toBeCloseTo(-1 / Math.sqrt(5), 6);
  });
});

describe("mapsequencearoundcontrolpoint 执行（rea 1.1）", () => {
  const run = (module: JsonObject, at: number[], seq = 0, extra: Partial<ParticleRunContext> = {}, vel?: number[]) => {
    const fields = fieldsOf(AROUND, { count: 5, ...module });
    const c = context(at, extra, vel);
    const state = { seq, step: aroundStep(fields.count as number) };
    mapSequenceAround(fields, c, state);
    return { c, state };
  };

  it("θ = 0 在 +y（缺省轴，dirA = (sin θ, cos θ, 0)），随 θ 增大转向 +x；之后推进序号", () => {
    const { c, state } = run({}, [100, 0, 0]);
    expect(position(c)).toEqual([0, 100, 0]);
    expect(state.seq).toBe(f32(0.2));
    const second = run({}, [100, 0, 0], f32(0.2)).c;
    const theta = f32(f32(0.2) * TWO_PI);
    expect(position(second)).toEqual([f32(f32(Math.sin(theta)) * 100), f32(f32(Math.cos(theta)) * 100), 0]);
    expect(position(second)[0]).toBeCloseTo(95.1057, 3);
    expect(position(second)[1]).toBeCloseTo(30.9017, 3);
  });

  it("位置是覆盖：保留出生点到轴的距离 L 与沿轴分量，角度换成序号的", () => {
    const { c } = run({}, [30, 40, 7], f32(0.25));
    const [x, y, z] = position(c);
    expect(z).toBe(7);
    expect(Math.hypot(x, y)).toBeCloseTo(50, 4);
    expect(x).toBeCloseTo(50, 4);
    expect(y).toBeCloseTo(0, 4);
  });

  it("bounds：θ = 2π·(b0 + seq·(b1 − b0))", () => {
    const { c } = run({ bounds: "0.25 0.5" }, [0, 100, 0], 1);
    // seq 1 → 0.5 圈 → −y
    expect(position(c)[0]).toBeCloseTo(0, 4);
    expect(position(c)[1]).toBeCloseTo(-100, 4);
  });

  it("控制点：中心是 cp.t，轴与基向量乘 mat3(cp)（ma-cp：θ = 0 的点从 +y 逆时针转 30°）", () => {
    const controlPoints = points(
      [
        [0, 0, 0],
        [300, 0, 0],
      ],
      [null, [0, 0, 0.5236]],
    );
    const { c } = run({ controlpoint: 1 }, [400, 0, 0], 0, { controlPoints });
    const [x, y] = position(c);
    expect(x).toBeCloseTo(300 - 100 * Math.sin(0.5236), 3);
    expect(y).toBeCloseTo(100 * Math.cos(0.5236), 3);
  });

  it("axis 0 1 0：在 xz 平面里转，y 保留", () => {
    const { c } = run({ axis: "0 1 0" }, [100, 20, 0], f32(0.25));
    const [x, y, z] = position(c);
    expect(y).toBe(20);
    // θ = π/2：dirA = c·B2 + s·B1 = B1 = (1,0,0)
    expect(x).toBeCloseTo(100, 4);
    expect(z).toBeCloseTo(0, 4);
  });

  it("每个粒子正好抽 3 次 uA（speed 全 0 也抽），不抽 uB", () => {
    const random = new ScriptedRandom();
    run({}, [100, 0, 0], 0, { random });
    expect(random.calls).toEqual(["a", "a", "a"]);
  });

  it("speed：x 切向、y 径向、z 轴向，加到原有速度上", () => {
    const { c } = run({ speedmin: "10 100 5", speedmax: "10 100 5" }, [100, 0, 0], 0, {}, [1, 2, 3]);
    // θ = 0：dirA = (0,1,0)，dirB = (1,0,0)，A = (0,0,1)
    expect(velocity(c)).toEqual([11, 102, 8]);
  });

  it("speed 的随机：u1 乘轴向、u2 乘切向、u3 乘径向（抽取顺序 u1、u2、u3）；Δs 乘过 instanceoverride.speed", () => {
    const random = new ScriptedRandom([0.5, 0.25, 0.75]);
    const { c } = run({ speedmin: "0 0 0", speedmax: "10 20 30" }, [100, 0, 0], 0, { random });
    expect(velocity(c)).toEqual([2.5, 15, 15]);
    const fields = fieldsOf(AROUND, { speedmin: "1 1 1", speedmax: "3 3 3" }, { ...ONE, speed: 2 });
    expect(fields.speedmin).toEqual([2, 2, 2]);
    expect(fields.speedmax).toEqual([6, 6, 6]);
  });
});

describe("mapsequencebetweencontrolpoints 执行（rea 1.2）", () => {
  const line = () =>
    points([
      [-300, 0, 0],
      [300, 0, 0],
    ]);
  const run = (
    module: JsonObject,
    at: number[],
    seq: number,
    extra: Partial<ParticleRunContext> = {},
    vel?: number[],
  ) => {
    const fields = fieldsOf(BETWEEN, module);
    const c = context(at, { controlPoints: line(), ...extra }, vel);
    const state = { seq, step: betweenStep(fields.count as number) };
    mapSequenceBetween(fields, c, state);
    return { c, state };
  };

  it("count 5：出生 x 依次 −300、−150、0、150、300、−300（mb-basic）；不抽随机数", () => {
    const fields = fieldsOf(BETWEEN, { count: 5 });
    const state = { seq: 0, step: betweenStep(fields.count as number) };
    const random = new ScriptedRandom();
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const c = context([0, 0, 0], { controlPoints: line(), random });
      mapSequenceBetween(fields, c, state);
      xs.push(position(c)[0]);
    }
    expect(xs).toEqual([-300, -150, 0, 150, 300, -300]);
    expect(random.calls).toEqual([]);
  });

  it("本地系统按系统原点量垂直分量、世界系统按起点量（mb-perp：线段在 y = −200，发射点 y = 100）", () => {
    const controlPoints = points([
      [-300, -200, 0],
      [300, -200, 0],
    ]);
    const local = run({ count: 5 }, [0, 100, 0], 0, { controlPoints }).c;
    const world = run({ count: 5 }, [0, 100, 0], 0, { controlPoints, world: true }).c;
    expect(position(local)).toEqual([-300, -100, 0]);
    expect(position(world)).toEqual([-300, 100, 0]);
  });

  it("flags 0：保留垂直分量，速度、尺寸不动", () => {
    const { c } = run({ count: 3 }, [0, 100, 0], 0, {}, [0, 50, 0]);
    expect(position(c)).toEqual([-300, 100, 0]);
    expect(velocity(c)).toEqual([0, 50, 0]);
    expect(c.columns.size0[0]).toBe(1);
  });

  it("w = 1 − (2·seq − 1)²：flags 1 垂直偏移 ×w、2 速度 ×w、4 size0 ×(1 − srm) + srm·w、8 加弧", () => {
    const w = (seq: number) => f32(1 - f32(f32(f32(seq + seq) - 1) ** 2));
    for (const seq of [0, f32(0.25), f32(0.5)]) {
      const f1 = run({ count: 9, flags: 1 }, [0, 100, 0], seq).c;
      expect(position(f1)[1], `flags 1 seq ${seq}`).toBe(f32(100 * w(seq)));
      const f2 = run({ count: 9, flags: 2 }, [0, 100, 0], seq, {}, [0, 50, 0]).c;
      expect(velocity(f2)[1], `flags 2 seq ${seq}`).toBe(f32(50 * w(seq)));
      expect(position(f2)[1]).toBe(100);
      const f4 = run({ count: 9, flags: 4 }, [0, 100, 0], seq).c;
      expect(f4.columns.size0[0], `flags 4 seq ${seq}`).toBe(f32(f32(1 - f32(0.9)) + f32(f32(0.9) * w(seq))));
      const f8 = run({ count: 9, flags: 8, arcamount: 0.3 }, [0, 100, 0], seq).c;
      expect(position(f8)[1], `flags 8 seq ${seq}`).toBe(f32(100 + f32(1 * f32(f32(w(seq) * 600) * f32(0.3)))));
    }
    // 中点 w = 1、两端 w = 0
    expect(w(0)).toBe(0);
    expect(w(f32(0.5))).toBe(1);
  });

  it("w 用的是 seq，不是 t：bounds 0.5 1 时第一个粒子 t = 0.5、w = 0", () => {
    const { c } = run({ count: 5, flags: 1, bounds: "0.5 1" }, [0, 100, 0], 0);
    expect(position(c)).toEqual([0, 0, 0]);
    const mid = run({ count: 5, flags: 1, bounds: "0.5 1" }, [0, 100, 0], f32(0.5)).c;
    expect(position(mid)).toEqual([150, 100, 0]);
  });

  it("arcdirection 不归一化、不乘控制点矩阵；端点重合时 Lc = FLT_MIN、不出 NaN", () => {
    const { c } = run({ count: 3, flags: 8, arcamount: 0.5, arcdirection: "0 2 0" }, [0, 0, 0], f32(0.5));
    expect(position(c)).toEqual([0, 600, 0]);
    const same = points([
      [10, 20, 0],
      [10, 20, 0],
    ]);
    const degenerate = run({ count: 3, flags: 1 }, [0, 100, 0], f32(0.5), { controlPoints: same }).c;
    expect(position(degenerate)).toEqual([10, 120, 0]);
  });

  it("controlpointstart / end 选控制点，下标钳到 7", () => {
    const controlPoints = points([
      [0, 0, 0],
      [0, 0, 0],
      [-100, 0, 0],
      [100, 0, 0],
    ]);
    const { c } = run({ count: 3, controlpointstart: 3, controlpointend: 2 }, [0, 0, 0], 0, { controlPoints });
    expect(position(c)).toEqual([100, 0, 0]);
    const fields = fieldsOf(BETWEEN, { controlpointstart: 9, controlpointend: -1 });
    expect([fields.controlpointstart, fields.controlpointend]).toEqual([7, 7]);
  });
});

describe("模块表与能力表", () => {
  it("缺省值（rea 1.1、1.2 的字段表）", () => {
    expect(fieldsOf(AROUND)).toEqual({
      count: 32,
      bounds: [0, 1, 0],
      limitbehavior: "repeat",
      speedmin: [0, 0, 0],
      speedmax: [0, 0, 0],
      axis: [0, 0, 1],
      controlpoint: 0,
      flags: 0,
    });
    expect(fieldsOf(BETWEEN)).toEqual({
      count: 32,
      bounds: [0, 1, 0],
      limitbehavior: "repeat",
      controlpointstart: 0,
      controlpointend: 1,
      flags: 0,
      arcamount: f32(0.3),
      arcdirection: [0, 1, 0],
      sizereductionamount: f32(0.9),
    });
  });

  it("只有精确的 mirror 才是 mirror", () => {
    const state = () => ({ seq: f32(0.8), step: f32(0.5) });
    for (const [value, mirror] of [
      ["mirror", true],
      ["Mirror", false],
      ["repeat", false],
      ["clamp", false],
    ] as const) {
      const s = state();
      const fields = fieldsOf(BETWEEN, { limitbehavior: value });
      mapSequenceBetween(
        fields,
        context([0, 0, 0], {
          controlPoints: points([
            [-1, 0, 0],
            [1, 0, 0],
          ]),
        }),
        s,
      );
      expect(s.step < 0, value).toBe(mirror);
    }
  });

  it("instanceIf：between 只在 flags & 0x10 时乘 instanceoverride.count；around 的 count 不乘（决定 3）", () => {
    const twice = { ...ONE, count: 2 };
    expect(fieldsOf(BETWEEN, { count: 5, flags: 0x10 }, twice).count).toBe(10);
    expect(fieldsOf(BETWEEN, { count: 5, flags: 0x13 }, twice).count).toBe(10);
    expect(fieldsOf(BETWEEN, { count: 5, flags: 3 }, twice).count).toBe(5);
    expect(fieldsOf(AROUND, { count: 5, flags: 1 }, twice).count).toBe(5);
    // 系统 flags bit5 禁用 count（C3）：不乘
    expect(fieldsOf(BETWEEN, { count: 5, flags: 0x10 }, instanceMultipliers({ ...ONE, count: 2 }, 0x20)).count).toBe(5);
  });

  it("能力表：between 的 flags 只认 1/2/4/8/0x10/0x20；around 的 flags 任何数值都不报；around 配周期发射报 periodic", () => {
    const keys = (initializer: JsonObject[], emitterFlags = 0) => {
      const set = new Set<string>();
      checkParticleFeatures(
        {
          maxcount: 8,
          emitter: [{ name: "sphererandom", flags: emitterFlags }],
          initializer,
          operator: [],
          renderer: [{ name: "sprite" }],
        },
        true,
        set,
      );
      return [...set].sort();
    };
    expect(
      keys([
        { name: AROUND, count: 5, flags: 7 },
        { name: BETWEEN, flags: 63 },
      ]),
    ).toEqual([]);
    expect(
      keys([
        { name: BETWEEN, flags: 23 },
        { name: BETWEEN, flags: 19 },
        { name: BETWEEN, flags: 15 },
      ]),
    ).toEqual([]);
    expect(keys([{ name: BETWEEN, flags: 0x40 }])).toEqual([`particle:initializer:${BETWEEN}:flags`]);
    expect(keys([{ name: BETWEEN, flags: -1 }])).toEqual([`particle:initializer:${BETWEEN}:flags`]);
    expect(keys([{ name: AROUND }], 4)).toEqual([`particle:initializer:${AROUND}:periodic`]);
    expect(keys([{ name: AROUND }], 2)).toEqual([]);
    expect(keys([{ name: BETWEEN, flags: 0x20 }], 4)).toEqual([]);
  });

  it("controlPointCount 数 controlpointstart / end：between 不写字段时得 2（end 缺省 1）", () => {
    const def = (initializer: JsonObject[]) =>
      parseParticle({ maxcount: 4, emitter: [], initializer, operator: [] }, { file: "p.json", orthographic: true });
    expect(controlPointCount(def([{ name: BETWEEN }]))).toBe(2);
    expect(controlPointCount(def([{ name: BETWEEN, controlpointstart: 3, controlpointend: 0 }]))).toBe(4);
    expect(controlPointCount(def([{ name: BETWEEN, controlpointend: 9 }]))).toBe(8);
    expect(controlPointCount(def([{ name: AROUND, controlpoint: 2 }]))).toBe(3);
    expect(controlPointCount(def([{ name: AROUND }]))).toBe(1);
  });
});

/** 模拟器里的模块状态（`ResolvedModule.state`）。 */
const states = (system: ParticleSystem) =>
  (system as unknown as { initializers: { state: unknown }[] }).initializers.map(
    (module) => module.state as SequenceState,
  );

/** 控制点 0 在 (−300, 0)、1 在 (300, 0)（between 的线段；around 的中心是控制点 0）。 */
const LINE: JsonObject = { controlpoint: [{ offset: "-300 0 0" }, { offset: "300 0 0" }] };

/**
 * 发射器在控制点 0，沿 x 偏 `distance`（`directions "1 0 0"`，符号随机），每帧 0.1 s 时 `rate 10` 发 1 个；寿命 100。
 * `initializer` 之前加 `lifetimerandom`，所以模块状态在 `states(…)[1]`。
 */
function seqSystem(
  initializer: JsonObject[],
  {
    distance = 0,
    emitter = {},
    extra = {},
    instanceoverride,
  }: {
    distance?: number;
    emitter?: JsonObject;
    extra?: JsonObject;
    instanceoverride?: unknown;
  } = {},
) {
  return new ParticleSystem(
    parseParticle(
      {
        maxcount: 64,
        emitter: [
          {
            name: "sphererandom",
            distancemin: distance,
            distancemax: distance,
            directions: "1 0 0",
            rate: 10,
            ...emitter,
          },
        ],
        initializer: [{ name: "lifetimerandom", min: 100, max: 100 }, ...initializer],
        operator: [],
        ...LINE,
        ...extra,
      },
      { file: "p.json", orthographic: true, instanceoverride },
    ),
    new SeededRandom(1),
    1,
  );
}

/** 本帧新出生（age 0）的粒子的位置，按槽序。 */
function newborn(system: ParticleSystem): number[][] {
  const c = system.columns;
  const out: number[][] = [];
  for (let slot = 0; slot < system.highWater; slot++)
    if (c.life[slot] !== 0 && c.age[slot] === 0) out.push([0, 1, 2].map((i) => c.position[i][slot]));
  return out;
}

/** around 的粒子在控制点 0 周围的角度（度，`θ = 0` 在 +y、往 +x 转），−0 归成 0。 */
const angleOf = ([x, y]: number[]) => Math.round((Math.atan2(x + 300, y) * 180) / Math.PI) + 0;

/** 周期发射：时长、间歇都是 0.3 s，每帧 0.1 s（约 8 帧一个周期）；返回 30 帧里每个新粒子的位置与帧号。 */
function periodic(initializer: JsonObject[], distance = 0): { frame: number; pos: number[] }[] {
  const system = seqSystem(initializer, {
    distance,
    emitter: {
      flags: 4,
      minperiodicduration: 0.3,
      maxperiodicduration: 0.3,
      minperiodicdelay: 0.3,
      maxperiodicdelay: 0.3,
    },
  });
  const out: { frame: number; pos: number[] }[] = [];
  for (let frame = 1; frame <= 30; frame++) {
    system.step(0.1);
    for (const pos of newborn(system)) out.push({ frame, pos });
  }
  return out;
}

/** 每个周期的第一个粒子（和上一个新粒子隔了不止一帧）的下标。 */
const periodStarts = (born: { frame: number }[]) =>
  born.flatMap((p, i) => (i === 0 || p.frame - born[i - 1].frame > 1 ? [i] : []));

describe("模拟器：状态的建立、复位、新周期与 setInstance", () => {
  it("每个系统一份状态，按 count 建；每个新粒子先用后加（第一个在 θ = 0），跨帧连续", () => {
    const system = seqSystem([{ name: AROUND, count: 5 }], { distance: 100 });
    expect(states(system)).toEqual([undefined, { seq: 0, step: f32(0.2) }]);
    const angles: number[] = [];
    for (let i = 0; i < 6; i++) {
      system.step(0.1);
      for (const pos of newborn(system)) angles.push(angleOf(pos));
    }
    expect(angles).toEqual([0, 72, 144, -144, -72, 0]);
    expect(states(system)[1].seq).toBe(f32(0.200000048));
    // 两个系统各自一份
    const other = seqSystem([{ name: AROUND, count: 5 }], { distance: 100 });
    expect(states(other)[1].seq).toBe(0);
  });

  it("suspend：有存活粒子时清零 seq，step（含 mirror 的符号）保留；之后第一个粒子回到起点", () => {
    const system = seqSystem([{ name: BETWEEN, count: 4, limitbehavior: "mirror" }]);
    for (let i = 0; i < 5; i++) system.step(0.1);
    const state = states(system)[1];
    expect(state.step).toBe(-f32(1 / 3));
    expect(state.seq).toBe(f32(0.333333284));
    expect(system.suspend()).toBe(true);
    expect(state).toEqual({ seq: 0, step: -f32(1 / 3) });
    system.step(0.1);
    expect(newborn(system)).toEqual([[-300, 0, 0]]);
    // 没有存活粒子时 suspend 什么都不做（不清零）
    const idle = seqSystem([{ name: AROUND, count: 5 }], { emitter: { rate: 0 } });
    states(idle)[1].seq = f32(0.4);
    expect(idle.suspend()).toBe(false);
    expect(states(idle)[1].seq).toBe(f32(0.4));
  });

  it("around 也在 suspend 时清零，重新可见后第一个粒子在 θ = 0", () => {
    const system = seqSystem([{ name: AROUND, count: 5 }], { distance: 100 });
    for (let i = 0; i < 3; i++) system.step(0.1);
    expect(states(system)[1].seq).toBe(f32(0.600000024));
    system.suspend();
    expect(states(system)[1]).toEqual({ seq: 0, step: f32(0.2) });
    system.step(0.1);
    expect(newborn(system).map(angleOf)).toEqual([0]);
  });

  it("周期发射的新周期：between flags & 0x20 时清零，早于本帧的新粒子；flags 0 不清零", () => {
    const cleared = periodic([{ name: BETWEEN, count: 9, flags: 0x20 }]);
    const starts = periodStarts(cleared);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    // 每个周期从起点（seq 0）开始、每个粒子前进 1/8
    let k = 0;
    cleared.forEach((p, i) => {
      if (starts.includes(i)) k = 0;
      expect(p.pos[0], `第 ${i} 个`).toBe(-300 + 75 * k++);
    });
    const kept = periodic([{ name: BETWEEN, count: 9, flags: 0 }]);
    expect(kept.map((p) => p.pos[0])).toEqual(kept.map((_, i) => -300 + 75 * (i % 9)));
    expect(periodStarts(kept).some((i) => i % 9 !== 0)).toBe(true);
  });

  it("周期发射的新周期：around 不清零（rec+0x58 按 0，决定 3）", () => {
    // count 7：周期长度（每周期 4–5 个）和序号的周期错开，清零与否看得出来
    const born = periodic([{ name: AROUND, count: 7 }], 100);
    expect(periodStarts(born).slice(1).length).toBeGreaterThanOrEqual(2);
    const state = { seq: 0, step: aroundStep(f32(7)) };
    const expected = born.map(() => {
      const theta = f32(f32(state.seq) * TWO_PI);
      advanceSequence(state, false, false);
      return angleOf([-300 + Math.sin(theta) * 100, Math.cos(theta) * 100]);
    });
    expect(born.map((p) => angleOf(p.pos))).toEqual(expected);
    expect(periodStarts(born).some((i) => expected[i] !== 0)).toBe(true);
  });

  it("setInstance：between flags & 0x10 时按条目 4 把 step 重写成正的新值（mirror 回到正向），seq 不动；没登记时不变", () => {
    const mirror = { name: BETWEEN, count: 4, limitbehavior: "mirror" };
    const registered = seqSystem([{ ...mirror, flags: 0x10 }]);
    for (let i = 0; i < 5; i++) registered.step(0.1);
    const state = states(registered)[1];
    expect(state.step).toBe(-f32(1 / 3));
    const seq = state.seq;
    registered.setInstance({ count: 2 });
    expect(state).toEqual({ seq, step: betweenStep(8) });
    // 不带 0x10：count 不乘，step 不重写（符号与大小都保留）
    const plain = seqSystem([mirror]);
    for (let i = 0; i < 5; i++) plain.step(0.1);
    const before = { ...states(plain)[1] };
    plain.setInstance({ count: 2 });
    expect(states(plain)[1]).toEqual(before);
    // 系统 flags bit5 禁用 count：不登记
    const disabled = seqSystem([{ ...mirror, flags: 0x10 }], { extra: { flags: 0x20 } });
    for (let i = 0; i < 5; i++) disabled.step(0.1);
    const kept = { ...states(disabled)[1] };
    expect(kept.step).toBe(-f32(1 / 3));
    disabled.setInstance({ count: 2 });
    expect(states(disabled)[1]).toEqual(kept);
    // around：不登记条目 3
    const around = seqSystem([{ name: AROUND, count: 5 }]);
    around.step(0.1);
    around.setInstance({ count: 0.02, speed: 2 });
    expect(states(around)[1]).toEqual({ seq: f32(0.2), step: f32(0.2) });
  });

  it("加载时的 instanceoverride.count：between flags & 0x10 的初始 step 按乘过的 count；around 不乘", () => {
    const system = seqSystem([{ name: BETWEEN, count: 5, flags: 0x10 }], { instanceoverride: { count: 2 } });
    expect(states(system)[1].step).toBe(betweenStep(10));
    const around = seqSystem([{ name: AROUND, count: 5 }], { instanceoverride: { count: 0.02 } });
    expect(states(around)[1].step).toBe(f32(0.2));
  });
});
