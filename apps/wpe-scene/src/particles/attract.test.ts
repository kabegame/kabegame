// P4c 步骤 3：controlpointattract（operators.ts 的 `controlPointAttract`）。依据 rea-p4c-sim.md 第 4 节（4.2 两段执行汇编、4.3 删除
// 判定汇编逐条核对过），实测见报告「P4c 语义的实测核对」，定量由 ignore/p4/c3 回放核对。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { identity } from "../render/math";
import { ParticleColumns } from "./columns";
import { ControlPointSet, controlPointCount, IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import {
  COLUMN_FLAGS,
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type InstanceMultipliers,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { blendFactor, controlPointAttract, readBlend } from "./operators";
import { SeededRandom } from "./random";
import { dragK0, instanceMultipliers, particleColumnFlags, ParticleSystem } from "./system";
import { particleSnapshot } from "./track";
import { writeVertices } from "./vertices";

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };
const FLT_MIN = 2 ** -126;

const read = (module: JsonObject = {}, orthographic = true) =>
  readParticleModule("operator", { name: "controlpointattract", ...module }, orthographic);

/** 模块表解析 + 乘覆盖 + 舍入（模拟器用的字段）。 */
function fieldsOf(module: JsonObject = {}, multipliers = ONE): ParticleFields {
  const reading = read(module);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("operator", "controlpointattract")!, reading.fields, multipliers);
}

const particle = (json: JsonObject, instanceoverride?: unknown) =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });

/** 一个粒子的列（槽 0），`flags` 是列标志；上一步位置缺省等于位置。 */
function one(
  position: number[],
  options: { velocity?: number[]; flags?: number; previous?: number[]; age?: number; life?: number } = {},
): ParticleColumns {
  const columns = new ParticleColumns(4, options.flags ?? 0);
  for (let i = 0; i < 3; i++) {
    columns.position[i][0] = position[i];
    columns.velocity[i][0] = options.velocity?.[i] ?? 0;
    if (columns.previousPosition) columns.previousPosition[i][0] = (options.previous ?? position)[i];
  }
  columns.age[0] = options.age ?? 0;
  columns.life[0] = options.life ?? 1;
  return columns;
}

/** 跑一次 operator：缺省 `k = 0.1`、`h = 0.5`（两者不同，用 `h` 的写法会对不上），控制点 8 个单位阵。 */
function run(fields: ParticleFields, columns: ParticleColumns, extra: Partial<ParticleRunContext> = {}): void {
  controlPointAttract(fields, {
    columns,
    random: new SeededRandom(1),
    slot: 0,
    count: 1,
    h: 0.5,
    k: 0.1,
    time: 0,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    ...extra,
  });
}

const velocityOf = (columns: ParticleColumns, slot = 0) => [0, 1, 2].map((i) => columns.velocity[i][slot]);

/**
 * 手算（4.2 逐步 float32）：`d` 是粒子减控制点平移，`v` 是原速度。`b` 给了时是 blend 版（钳制之后乘）。
 */
function expected(
  d: number[],
  v: number[],
  o: { scale: number; threshold: number; k: number; clamp: boolean; b?: number },
): number[] {
  const [dx, dy, dz] = d.map(f32);
  const length = f32(Math.sqrt(f32(f32(f32(dz * dz) + f32(dy * dy)) + f32(dx * dx))));
  if (!(length < f32(o.threshold) && FLT_MIN < length)) return v.map(f32);
  const inv = f32(1 / length);
  const ks = f32(f32(o.k) * f32(o.scale));
  let f = f32(f32(1 - f32(length * f32(1 / f32(o.threshold)))) * ks);
  if (o.clamp && length < f) f = length;
  if (o.b !== undefined) f = f32(f * o.b);
  return [dx, dy, dz].map((value, i) => f32(f32(v[i]) - f32(f32(inv * value) * f)));
}

describe("模块表（rea-p4c-sim.md 4.1）", () => {
  it("正交、透视两套缺省（按二进制核对过）；flags 缺省 2；controlpoint 缺省 0", () => {
    expect(read().fields).toEqual({
      scale: 512,
      threshold: 512,
      deletethreshold: 15,
      flags: 2,
      controlpoint: 0,
      offset: [0, 0, 0],
      origin: [0, 0, 0],
      blendinstart: 0,
      blendinend: 0,
      blendoutstart: 1,
      blendoutend: 1,
    });
    expect(read({}, false).fields).toMatchObject({
      scale: 20,
      threshold: 5,
      deletethreshold: 0.5,
      flags: 2,
      controlpoint: 0,
    });
    expect(read().known).toBe(true);
  });

  it("写了 origin、offset 不报（WPE 不读 origin，offset 解析了但不读）；语料的写法没有问题；表外字段照报", () => {
    expect(read({ origin: "200 0 0", offset: "200 0 0" }).issues).toEqual([]);
    // origin 写成数字也不报（WPE 根本不读这个键）
    expect(read({ origin: 5 }).issues).toEqual([]);
    expect(read({ controlpoint: 1, origin: "1 1 0", scale: -500, threshold: 48 }).issues).toEqual([]);
    expect(read({ scale: 0, threshold: 9999, origin: "0 0 0" }).issues).toEqual([]);
    expect(read({ bogus: 1 }).issues).toEqual([{ field: "bogus", kind: "unknown" }]);
  });

  it("scale 乘 instanceoverride.speed，系统 flags bit4 时不乘；threshold、deletethreshold 不乘", () => {
    const values = { size: 3, speed: 2, count: 5, lifetime: 7, rate: 1 };
    const fields = fieldsOf({ scale: 100, threshold: 500, deletethreshold: 20 }, instanceMultipliers(values, 0));
    expect(fields).toMatchObject({ scale: 200, threshold: 500, deletethreshold: 20 });
    const disabled = fieldsOf({ scale: 100, threshold: 500, deletethreshold: 20 }, instanceMultipliers(values, 0x10));
    expect(disabled).toMatchObject({ scale: 100, threshold: 500, deletethreshold: 20 });
    // 系统里：speed 2 的吸引正好加倍（乘 2 不丢精度）
    const json = (extra: JsonObject = {}): JsonObject => ({
      maxcount: 1,
      emitter: [{ name: "sphererandom", distancemax: 0, origin: "300 0 0", rate: 0, instantaneous: 1 }],
      initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
      operator: [{ name: "controlpointattract", scale: 100, threshold: 500, flags: 0 }],
      ...extra,
    });
    const base = new ParticleSystem(particle(json()), new SeededRandom(1), 1);
    const fast = new ParticleSystem(particle(json(), { speed: 2 }), new SeededRandom(1), 1);
    const slow = new ParticleSystem(particle(json({ flags: 0x10 }), { speed: 2 }), new SeededRandom(1), 1);
    for (const system of [base, fast, slow]) system.step(0.016);
    expect(base.skipped).toEqual([]);
    expect(base.columns.velocity[0][0]).toBeLessThan(0);
    expect(fast.columns.velocity[0][0]).toBe(2 * base.columns.velocity[0][0]);
    expect(slow.columns.velocity[0][0]).toBe(base.columns.velocity[0][0]);
  });

  it("controlpoint 解析期钳到 0–7（无符号比较：−1 得 7，9 得 7）；controlPointCount 计入本模块的下标", () => {
    expect(read({ controlpoint: -1 }).fields.controlpoint).toBe(7);
    expect(read({ controlpoint: 9 }).fields.controlpoint).toBe(7);
    expect(read({ controlpoint: 3 }).fields.controlpoint).toBe(3);
    expect(read({ controlpoint: 2.7 }).fields.controlpoint).toBe(2);
    expect(controlPointCount(particle({ operator: [{ name: "controlpointattract", controlpoint: 6 }] }))).toBe(7);
    expect(controlPointCount(particle({ operator: [{ name: "controlpointattract", controlpoint: -1 }] }))).toBe(8);
  });

  it("列标志只在 flags bit0 时含上一步位置（flags 1、3 有，0、2、缺省没有）", () => {
    const flagsOf = (module: JsonObject) =>
      particleColumnFlags(particle({ operator: [{ name: "controlpointattract", ...module }] }));
    expect(flagsOf({ flags: 1 })).toBe(COLUMN_FLAGS.previousPosition);
    expect(flagsOf({ flags: 3 })).toBe(COLUMN_FLAGS.previousPosition);
    expect(flagsOf({ flags: 0 })).toBe(0);
    expect(flagsOf({ flags: 2 })).toBe(0);
    expect(flagsOf({})).toBe(0);
    // 和别的模块的静态标志按位或
    expect(
      particleColumnFlags(particle({ operator: [{ name: "alphafade" }, { name: "controlpointattract", flags: 1 }] })),
    ).toBe(COLUMN_FLAGS.previousPosition | COLUMN_FLAGS.alpha);
    const system = (flags: number) =>
      new ParticleSystem(
        particle({ maxcount: 4, operator: [{ name: "controlpointattract", flags }] }),
        new SeededRandom(1),
        1,
      );
    expect(system(1).columns.previousPosition).not.toBeNull();
    expect(system(2).columns.previousPosition).toBeNull();
  });
});

describe("公式（4.2，单粒子单步和手算比）", () => {
  const basic = { scale: 100, threshold: 500, flags: 0 };

  it("吸引：速度朝控制点减 (inv·d)·f，f = (1 − L·rT)·k·scale；三个轴都有分量；不改位置", () => {
    const columns = one([300, 0, 0]);
    run(fieldsOf(basic), columns);
    const v = velocityOf(columns);
    expect(v).toEqual(expected([300, 0, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: false }));
    expect(v[0]).toBeCloseTo(-(1 - 300 / 500) * 100 * 0.1, 4);
    expect(v[1]).toBe(0);
    expect(columns.position[0][0]).toBe(300);
    // 三维位移、原速度非零
    const d = [123.5, -78.25, 33.75];
    const moving = one(d, { velocity: [5, -6, 7] });
    run(fieldsOf(basic), moving);
    expect(velocityOf(moving)).toEqual(expected(d, [5, -6, 7], { scale: 100, threshold: 500, k: 0.1, clamp: false }));
  });

  it("排斥：scale 为负时速度背离控制点", () => {
    const columns = one([300, 0, 0]);
    run(fieldsOf({ ...basic, scale: -100 }), columns);
    const v = velocityOf(columns);
    expect(v).toEqual(expected([300, 0, 0], [0, 0, 0], { scale: -100, threshold: 500, k: 0.1, clamp: false }));
    expect(v[0]).toBeGreaterThan(0);
  });

  it("阈值外不动", () => {
    const columns = one([300, 0, 0], { velocity: [1, 2, 3] });
    run(fieldsOf({ ...basic, threshold: 250 }), columns);
    expect(velocityOf(columns)).toEqual([1, 2, 3]);
    const far = one([0, -600, 0]);
    run(fieldsOf(basic), far);
    expect(velocityOf(far)).toEqual([0, 0, 0]);
  });

  it("恰在阈值上不动（L < threshold 严格小于）：T = 41 时 f32(T·f32(1/T)) < 1，f 不为 0，写成 <= 会动", () => {
    const T = 41;
    const ks = f32(f32(0.1) * f32(1e9));
    const f = f32(f32(1 - f32(T * f32(1 / T))) * ks);
    // 前提：L = T 时 f 明显非零，若按 <= 生效，速度会变
    expect(f32(T * f32(1 / T))).toBeLessThan(1);
    expect(f).toBeGreaterThan(1);
    const columns = one([T, 0, 0]);
    run(fieldsOf({ scale: 1e9, threshold: T, flags: 0 }), columns);
    expect(velocityOf(columns)).toEqual([0, 0, 0]);
  });

  it("L = 0（粒子正好在控制点上）不产生 NaN：FLT_MIN < L 不成立，不受影响", () => {
    const columns = one([0, 0, 0], { velocity: [4, 5, 6] });
    run(fieldsOf(basic), columns);
    expect(velocityOf(columns)).toEqual([4, 5, 6]);
    // 正好在 FLT_MIN 上也不受影响（严格小于）
    const tiny = one([FLT_MIN, 0, 0]);
    run(fieldsOf({ ...basic, flags: 2 }), tiny);
    expect(velocityOf(tiny)).toEqual([0, 0, 0]);
  });

  it("钳制开（缺省 flags 2）且 L < f 时 f = L：速度变化就是 −d", () => {
    const columns = one([300, 0, 0]);
    run(fieldsOf({ scale: 1e6, threshold: 500 }), columns);
    const v = velocityOf(columns);
    expect(v).toEqual(expected([300, 0, 0], [0, 0, 0], { scale: 1e6, threshold: 500, k: 0.1, clamp: true }));
    expect(v[0]).toBeCloseTo(-300, 3);
    // flags 0 不钳：冲得远得多
    const free = one([300, 0, 0]);
    run(fieldsOf({ scale: 1e6, threshold: 500, flags: 0 }), free);
    expect(velocityOf(free)[0]).toBeLessThan(-30000);
    // 钳制开但 f < L 时照常用 f
    const weak = one([300, 0, 0]);
    run(fieldsOf({ scale: 100, threshold: 500 }), weak);
    expect(velocityOf(weak)).toEqual(
      expected([300, 0, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: false }),
    );
  });

  it("scale < 0 时 f < 0，钳制开也不钳（排斥照样按 f）", () => {
    const columns = one([300, 0, 0]);
    run(fieldsOf({ scale: -1e6, threshold: 500, flags: 2 }), columns);
    const v = velocityOf(columns);
    expect(v).toEqual(expected([300, 0, 0], [0, 0, 0], { scale: -1e6, threshold: 500, k: 0.1, clamp: false }));
    expect(v[0]).toBeGreaterThan(30000);
  });

  it("blend 版：b 乘在钳制之后（钳制开、b < 1 时结果是 L·b）", () => {
    const fields = fieldsOf({ scale: 1e6, threshold: 500, blendinstart: 0, blendinend: 0.5 });
    const blend = readBlend(fields);
    expect(blend.active).toBe(true);
    const b = blendFactor(blend, f32(f32(0.1) * f32(1 / 1)));
    expect(b).toBeCloseTo(0.2, 5);
    const columns = one([300, 0, 0], { age: 0.1, life: 1 });
    run(fields, columns);
    const v = velocityOf(columns);
    expect(v).toEqual(expected([300, 0, 0], [0, 0, 0], { scale: 1e6, threshold: 500, k: 0.1, clamp: true, b }));
    expect(v[0]).toBeCloseTo(-60, 3);
    // 不钳的 blend：f·b
    const free = one([300, 0, 0], { age: 0.1, life: 1 });
    run(fieldsOf({ ...basic, blendinstart: 0, blendinend: 0.5 }), free);
    expect(velocityOf(free)).toEqual(
      expected([300, 0, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: false, b }),
    );
  });

  it("乘 drag 系数 k，不乘步长 h", () => {
    const columns = one([300, 0, 0]);
    run(fieldsOf(basic), columns, { k: 0.02, h: 0.05 });
    expect(velocityOf(columns)).toEqual(
      expected([300, 0, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.02, clamp: false }),
    );
    expect(velocityOf(columns)).not.toEqual(
      expected([300, 0, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.05, clamp: false }),
    );
  });

  it("中心是控制点 current 的平移：控制点的 offset 算进去；模块自己的 offset、origin 不算", () => {
    const set = new ControlPointSet(
      particle({
        operator: [{ name: "controlpointattract", controlpoint: 1 }],
        controlpoint: [{}, { offset: "50 -20 10" }],
      }),
    );
    const center = [50, -20, 10];
    const d = [200, 100, -40];
    const at = d.map((value, i) => value + center[i]);
    const plain = one(at);
    run(fieldsOf({ ...basic, controlpoint: 1 }), plain, { controlPoints: set });
    const want = expected(d, [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: false });
    expect(velocityOf(plain)).toEqual(want);
    const extra = one(at);
    run(fieldsOf({ ...basic, controlpoint: 1, offset: "200 0 0", origin: "200 0 0" }), extra, { controlPoints: set });
    expect(velocityOf(extra)).toEqual(want);
  });

  it("读 current 不读 previous：跟随指针的控制点在本帧更新之后、帧尾之前，previous 还是基准", () => {
    const set = new ControlPointSet(
      particle({
        operator: [{ name: "controlpointattract", controlpoint: 1 }],
        controlpoint: [{}, { flags: 1, offset: "10 20 30" }],
      }),
    );
    set.update({ world: identity(), pointer: [500, 600] });
    expect(Array.from(set.current(1).translation)).toEqual([500, 600, 0]);
    expect(Array.from(set.previous(1).translation)).toEqual([10, 20, 30]);
    const d = [150, -100, 20];
    const columns = one([500 + d[0], 600 + d[1], d[2]]);
    run(fieldsOf({ ...basic, controlpoint: 1 }), columns, { controlPoints: set });
    expect(velocityOf(columns)).toEqual(expected(d, [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: false }));
  });

  it("死槽照常处理、只处理 [0, count)", () => {
    const columns = one([300, 0, 0], { life: 0 });
    columns.position[0][1] = 300;
    run(fieldsOf(basic), columns);
    expect(velocityOf(columns)[0]).toBeLessThan(0);
    expect(velocityOf(columns, 1)).toEqual([0, 0, 0]);
  });
});

describe("删除判定（4.3，flags bit0）", () => {
  const remove = (deletethreshold: number, extra: JsonObject = {}) =>
    fieldsOf({ scale: 0, threshold: 500, flags: 1, deletethreshold, ...extra });
  /** 跑一次，返回 age（0.3 表示保留，等于 life 1 表示删）。 */
  const ageAfter = (fields: ParticleFields, previous: number[], position: number[]) => {
    const columns = one(position, { flags: COLUMN_FLAGS.previousPosition, previous, age: 0.3, life: 1 });
    run(fields, columns);
    expect(columns.life[0]).toBe(1);
    return columns.age[0];
  };

  it("线段扫过控制点时删：两端离控制点都比阈值远", () => {
    expect(ageAfter(remove(20), [-100, 5, 0], [100, 5, 0])).toBe(1);
    // 斜着扫过
    expect(ageAfter(remove(20), [-100, -90, 3], [100, 110, 3])).toBe(1);
  });

  it("端点在阈值内删（终点、起点各一组）；偏离大于阈值不删", () => {
    expect(ageAfter(remove(20), [-100, 0, 0], [-10, 0, 0])).toBe(1);
    expect(ageAfter(remove(20), [10, 0, 0], [100, 0, 0])).toBe(1);
    expect(ageAfter(remove(20), [-100, 30, 0], [100, 30, 0])).toBe(f32(0.3));
    expect(ageAfter(remove(20), [-100, 0, 0], [-30, 0, 0])).toBe(f32(0.3));
    // 线段在控制点同侧、延长线才经过它：不删
    expect(ageAfter(remove(20), [40, 0, 0], [100, 0, 0])).toBe(f32(0.3));
  });

  it("按平方比较：偏离 10、阈值 20 删；偏离 19.9 删、20.1 不删", () => {
    expect(ageAfter(remove(20), [-100, 10, 0], [100, 10, 0])).toBe(1);
    expect(ageAfter(remove(20), [-100, 19.9, 0], [100, 19.9, 0])).toBe(1);
    expect(ageAfter(remove(20), [-100, 20.1, 0], [100, 20.1, 0])).toBe(f32(0.3));
  });

  it("|e|² 为 NaN 时删（比较 deletethreshold² < |e|² 为假）", () => {
    expect(ageAfter(remove(20), [-100, 0, 0], [Number.NaN, 0, 0])).toBe(1);
  });

  it("乘法结合照汇编（u = r·d 先算，s·u 再加 P0），不照 Ghidra 的 (C − P0)·r·d、(s·r)·d：两组边界用例判法相反", () => {
    // 搜出来的边界（各量都是 float32 精确值）：|e|² 按汇编顺序和按 Ghidra 顺序差 1 ulp，deletethreshold² 落在两者之间或等于其一。
    // e 的写法（s·u 对 (s·r)·d）：汇编 |e|² = 59.2165412902832 = deletethreshold²（不大于，删），Ghidra 大 1 ulp（不删）
    expect(ageAfter(remove(7.695228576660156), [-117.25, -11.75, 0], [131.625, 29.75, 0])).toBe(1);
    // e 的写法：汇编 134.02874755859375 > deletethreshold² 134.0287322998047（不删），Ghidra 正好相等（会删）
    expect(ageAfter(remove(11.577077865600586), [-129, -4.25, 0], [141, -19.625, 0])).toBe(f32(0.3));
    // s 的写法（(C − P0)·u 对 ((C − P0)·r)·d）：汇编删、Ghidra 不删；汇编不删、Ghidra 删
    expect(ageAfter(remove(13.193707466125488), [-123, -21, 0], [116.125, -5.875, 0])).toBe(1);
    expect(ageAfter(remove(5.915223598480225), [-112.375, 13.5, 0], [134.375, -3.125, 0])).toBe(f32(0.3));
  });

  it("flags 没有 bit0 时不判（即使列存在）；scale 非 0 时吸引照做、再判删除", () => {
    expect(
      ageAfter(fieldsOf({ scale: 0, threshold: 500, flags: 2, deletethreshold: 20 }), [-100, 5, 0], [100, 5, 0]),
    ).toBe(f32(0.3));
    const columns = one([100, 5, 0], {
      flags: COLUMN_FLAGS.previousPosition,
      previous: [-100, 5, 0],
      age: 0.3,
      life: 1,
    });
    run(remove(20, { scale: 100, flags: 3 }), columns);
    expect(columns.age[0]).toBe(1);
    expect(velocityOf(columns)).toEqual(
      expected([100, 5, 0], [0, 0, 0], { scale: 100, threshold: 500, k: 0.1, clamp: true }),
    );
  });

  /** 一个粒子沿 +x 穿过控制点 0（原点）附近：出生在 `(x0, 5, 0)`，速度 `(v, 0, 0)`，movement 积分。 */
  const crossing = (x0: number, v: number, deletethreshold: number, operators?: JsonObject[]): JsonObject => ({
    maxcount: 1,
    emitter: [{ name: "sphererandom", distancemax: 0, origin: `${x0} 5 0`, rate: 0, instantaneous: 1 }],
    initializer: [
      { name: "lifetimerandom", min: 10, max: 10 },
      { name: "velocityrandom", min: `${v} 0 0`, max: `${v} 0 0` },
    ],
    operator: operators ?? [{ name: "movement" }, { name: "controlpointattract", scale: 0, flags: 1, deletethreshold }],
  });
  const LAYOUT = { stride: 3, position: 0, texCoord: -1, rotation: -1, color: -1, thick: -1 };

  it("删的那一帧粒子仍存活（alive 不变、age = life、当帧照写顶点），下一帧才判死", () => {
    const system = new ParticleSystem(particle(crossing(-30, 600, 10)), new SeededRandom(1), 1);
    system.step(0.1);
    expect(system.alive).toBe(1);
    expect(system.columns.life[0]).toBe(10);
    expect(system.columns.age[0]).toBe(10);
    expect(particleSnapshot(system).map((p) => p.pos)).toEqual([[30, 5, 0]]);
    expect(writeVertices(system, LAYOUT, new Float32Array(12))).toBe(1);
    system.step(0.1);
    expect(system.alive).toBe(0);
    expect(particleSnapshot(system)).toEqual([]);
    // 偏离 5 > 阈值 4：不删，照常活着
    const kept = new ParticleSystem(particle(crossing(-30, 600, 4)), new SeededRandom(1), 1);
    kept.step(0.1);
    expect(kept.columns.age[0]).toBe(0);
    kept.step(0.1);
    expect(kept.alive).toBe(1);
  });

  it("两遍模式每遍都判：第一遍的半段扫过控制点、第二遍的半段离得远，照样删", () => {
    // 两遍：h = 0.05，第一遍 −30 → 30（经过 (0, 5)），第二遍 30 → 90（最近 30.4 > 10）
    const twice = new ParticleSystem(particle(crossing(-30, 1200, 10)), new SeededRandom(1), 2);
    twice.step(0.1);
    expect(twice.columns.position[0][0]).toBe(90);
    expect(twice.columns.previousPosition![0][0]).toBe(30);
    expect(twice.columns.age[0]).toBe(10);
    twice.step(0.1);
    expect(twice.alive).toBe(0);
  });

  it("没有 movement 时线段起点是出生位置（上一步位置在出生时写成出生位置，之后没人刷新）", () => {
    // 控制点 1 在 (0, 50, 0)；出生在 (−100, 50, 0)，第一帧没有位移、离控制点 100，不删
    const json: JsonObject = {
      maxcount: 1,
      emitter: [{ name: "sphererandom", distancemax: 0, origin: "-100 50 0", rate: 0, instantaneous: 1 }],
      initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
      operator: [{ name: "controlpointattract", controlpoint: 1, scale: 0, flags: 1, deletethreshold: 10 }],
      controlpoint: [{}, { offset: "0 50 0" }],
    };
    const system = new ParticleSystem(particle(json), new SeededRandom(1), 1);
    system.step(0.1);
    expect(system.columns.age[0]).toBe(0);
    expect(Array.from(system.columns.previousPosition!, (column) => column[0])).toEqual([-100, 50, 0]);
    // 模拟一个只改位置、不刷新上一步位置的模块：线段 [(−100, 50), (100, 50)] 正好穿过控制点 1，删
    // （起点若是 (0, 0, 0)，线段离控制点 1 有 44.7，不会删）
    system.columns.position[0][0] = 100;
    system.step(0.1);
    expect(system.columns.age[0]).toBe(10);
  });
});

describe("模拟器里的 k（两遍模式每遍 k/2）", () => {
  const json: JsonObject = {
    maxcount: 1,
    emitter: [{ name: "sphererandom", distancemax: 0, origin: "300 0 0", rate: 0, instantaneous: 1 }],
    initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
    operator: [{ name: "controlpointattract", scale: 100, threshold: 500, flags: 0 }],
  };
  const options = { scale: 100, threshold: 500, clamp: false };
  /** 发射器速度为 0 时方向带符号，出生速度可能是 −0：系统级比较把 ±0 当成一样（`+ 0`）。 */
  const unsigned = (values: number[]) => values.map((value) => value + 0);

  it("一遍：帧时间 0.1 时 k0 = pow(0.25, 0.7)·dt'，和步长不同", () => {
    const k0 = dragK0(f32(0.1), 0.1);
    expect(k0).not.toBe(f32(0.1));
    const system = new ParticleSystem(particle(json), new SeededRandom(1), 1);
    system.step(0.1);
    expect(unsigned(velocityOf(system.columns))).toEqual(
      unsigned(expected([300, 0, 0], [0, 0, 0], { ...options, k: k0 })),
    );
  });

  it("两遍：每遍 k0/2，位置不变（没有 movement）时第二遍在第一遍的速度上再减一次", () => {
    const half = f32(dragK0(f32(0.1), 0.1) * 0.5);
    const system = new ParticleSystem(particle(json), new SeededRandom(1), 2);
    system.step(0.1);
    const first = expected([300, 0, 0], [0, 0, 0], { ...options, k: half });
    expect(unsigned(velocityOf(system.columns))).toEqual(
      unsigned(expected([300, 0, 0], first, { ...options, k: half })),
    );
  });
});
