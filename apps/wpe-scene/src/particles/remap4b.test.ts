/**
 * P4d 步骤 4b：remap 的噪声变换与写控制点（`remap.ts`，rea-p4d-modules.md 2.2、2.5、2.7、2.8；汇编 `ignore/p4/rea/p4d-mod/init15.asm`、
 * `op19.asm`、`op19b.asm`）。噪声函数本身的已知值在 `fastnoise2.test.ts`。
 *
 * 噪声函数换成透传的 spy，只为数「y、z 分量算没算」：标量输出时 y、z 不会被读，结果上看不出来，只能数调用次数。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { CONTROL_POINT_FLAGS, ControlPointSet, controlPointModuleFlags, IDENTITY_BASIS } from "./controlpoints";
import { fbm2, simplex2 } from "./fastnoise2";
import {
  COLUMN_FLAGS,
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type InstanceMultipliers,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { fbm1, snoise1 } from "./noise";
import { SeededRandom } from "./random";
import {
  REMAP_CONTROL_POINT_FLAG,
  remapControlPointFlags,
  remapInitialValue,
  remapValue,
  type RemapKind,
} from "./remap";
import { ParticleSystem } from "./system";

vi.mock("./fastnoise2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fastnoise2")>();
  return { ...actual, simplex2: vi.fn(actual.simplex2), fbm2: vi.fn(actual.fbm2) };
});
vi.mock("./noise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./noise")>();
  return { ...actual, snoise1: vi.fn(actual.snoise1), fbm1: vi.fn(actual.fbm1) };
});

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };
const NAME = { init: "remapinitialvalue", op: "remapvalue" } as const;
const CATEGORY = { init: "initializer", op: "operator" } as const;
const ALL_COLUMNS = COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.angularVelocity | COLUMN_FLAGS.color | COLUMN_FLAGS.alpha;
const bitsOf = (x: number) => new Int32Array(new Float32Array([x]).buffer)[0];
const half = (n: number) => f32(f32(n * 0.5) + 0.5);
/** rv-noise 第 921 帧第一个粒子的 `R`（`fastnoise2.test.ts` 的已知值用的同一个）。 */
const R = 0.1783294677734375;

function fieldsOf(kind: RemapKind, module: JsonObject): ParticleFields {
  const reading = readParticleModule(CATEGORY[kind], { name: NAME[kind], ...module }, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef(CATEGORY[kind], NAME[kind])!, reading.fields, ONE);
}

/** 8 个控制点，只有平移（1 号在 (−200, 100, 0)）。 */
function points(): ControlPointSet {
  return new ControlPointSet(
    {
      emitters: [],
      initializers: [],
      operators: [],
      flags: 0,
      controlpoints: [
        { flags: 0, offset: [0, 0, 0] },
        { flags: 0, offset: [-200, 100, 0] },
      ],
      instance: { controlpoints: [], controlpointAngles: [] },
    },
    8,
  );
}

/** `n` 个槽：life 6、age 1.5、位置 (100, 50, 25)；T = 1（runtime）、St = 3。 */
function context(n = 1, extra: Partial<ParticleRunContext> = {}): ParticleRunContext {
  const c = new ParticleColumns(Math.max(n, 4), ALL_COLUMNS);
  for (let slot = 0; slot < n; slot++) {
    c.life[slot] = 6;
    c.age[slot] = 1.5;
    [100, 50, 25].forEach((v, i) => (c.position[i][slot] = v));
  }
  return {
    columns: c,
    random: new SeededRandom(1),
    slot: 0,
    count: n,
    h: 0.1,
    k: 0.1,
    time: 1,
    controlPoints: points(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
    systemTime: 3,
    layerTime: 0,
    origin: new Float32Array(3),
    ...extra,
  };
}

function run(kind: RemapKind, module: JsonObject, ctx: ParticleRunContext): ParticleRunContext {
  const fields = fieldsOf(kind, module);
  if (kind === "init") remapInitialValue(fields, ctx);
  else remapValue(fields, ctx);
  return ctx;
}

const lane = (columns: readonly Float32Array[], slot = 0) => [columns[0][slot], columns[1][slot], columns[2][slot]];
const spy = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const fn of [simplex2, fbm2, snoise1, fbm1]) spy(fn).mockClear();
});

describe("op 的噪声：FastNoise2，种子取每粒子 R 的位（rea 2.5、2.9）", () => {
  // 输入 runtime（T = 1）、区间 0..1、不夹 → v = 1；s = 1.234 → x = f32(1.234)，正是 fastnoise2.test.ts 的已知值的坐标
  const module = {
    input: "runtime",
    flags: 0,
    transformfunction: "simplexnoise",
    transforminputscale: 1.234,
    output: "velocity",
    operation: "remap",
  };

  it("x 分量的种子是 R 的位，y 异或 0x0b3924ad、z 异或 0x493a8e83（取 Python 移植的已知值）", () => {
    const ctx = context();
    ctx.columns.random[0] = R;
    run("op", module, ctx);
    // fn2_values.py：simplex2(bits(R), 1.234, 0) 与两种异或种子
    expect(lane(ctx.columns.velocity)).toEqual(
      [0.6131976246833801, -0.6665222644805908, 0.38788095116615295].map(half),
    );
  });

  it("R 不同结果不同；输出区间照常（o = range·n′ + min）", () => {
    const a = context();
    const b = context();
    a.columns.random[0] = R;
    b.columns.random[0] = 0.5;
    run("op", { ...module, outputrangemin: -100, outputrangemax: 100 }, a);
    run("op", { ...module, outputrangemin: -100, outputrangemax: 100 }, b);
    expect(lane(a.columns.velocity)).not.toEqual(lane(b.columns.velocity));
    const seed = bitsOf(0.5);
    expect(b.columns.velocity[1][0]).toBe(f32(f32(half(simplex2(seed ^ 0x0b3924ad, f32(1.234), 0)) * 200) - 100));
  });

  it("fbmnoise：fbm2(seed, v·s, 0, octaves)·0.5 + 0.5，种子同上", () => {
    const ctx = context();
    ctx.columns.random[0] = R;
    run("op", { ...module, transformfunction: "fbmnoise", transformoctaves: 3 }, ctx);
    // fn2_values.py：fbm2(bits(R), 1.234, 0, 3)
    expect(ctx.columns.velocity[0][0]).toBe(half(0.3329288363456726));
    const bits = bitsOf(R);
    expect(ctx.columns.velocity[2][0]).toBe(half(fbm2(bits ^ 0x493a8e83, f32(1.234), 0, 3)));
    // octaves 1 就是 simplex2
    const one = context();
    one.columns.random[0] = R;
    run("op", { ...module, transformfunction: "fbmnoise", transformoctaves: 1 }, one);
    expect(lane(one.columns.velocity)).toEqual(
      [0.6131976246833801, -0.6665222644805908, 0.38788095116615295].map(half),
    );
  });

  it("y、z 只在输出是向量时算：标量输出每槽调一次，向量输出三次", () => {
    run("op", { ...module, output: "size" }, context(3));
    expect(spy(simplex2).mock.calls.length).toBe(3);
    spy(simplex2).mockClear();
    run("op", module, context(3));
    expect(spy(simplex2).mock.calls.length).toBe(9);
    run("op", { ...module, transformfunction: "fbmnoise", output: "speed" }, context(2));
    expect(spy(fbm2).mock.calls.length).toBe(2);
    spy(fbm2).mockClear();
    run("op", { ...module, transformfunction: "fbmnoise", output: "position" }, context(2));
    expect(spy(fbm2).mock.calls.length).toBe(6);
    expect(spy(snoise1).mock.calls.length + spy(fbm1).mock.calls.length).toBe(0);
  });
});

describe("init 的噪声：snoise1 / fbm1，不用 R（rea 2.5）", () => {
  // 输入 particlesystemtime（St = 3）、区间 0..10、不夹 → v = 0.3；s = 10 → x = f32(0.3·10)
  const module = {
    input: "particlesystemtime",
    inputrangemax: 10,
    flags: 0,
    transformfunction: "simplexnoise",
    transforminputscale: 10,
    output: "size",
    operation: "remap",
  };
  const v = f32(3 / 10);

  it("simplexnoise = snoise1(v·s)·0.5 + 0.5，R 不同结果相同", () => {
    const a = context();
    const b = context();
    a.columns.random[0] = 0.1;
    b.columns.random[0] = 0.9;
    run("init", module, a);
    run("init", module, b);
    expect(a.columns.size0[0]).toBe(half(snoise1(f32(v * 10))));
    expect(b.columns.size0[0]).toBe(a.columns.size0[0]);
    expect(spy(simplex2).mock.calls.length + spy(fbm2).mock.calls.length).toBe(0);
  });

  it("fbmnoise = fbm1(v; s, octaves)·0.5 + 0.5（频率在 fbm1 里乘），R 不同结果相同；octaves 0 得 NaN", () => {
    const a = context();
    const b = context();
    a.columns.random[0] = 0.1;
    b.columns.random[0] = 0.9;
    run("init", { ...module, transformfunction: "fbmnoise", transformoctaves: 3 }, a);
    run("init", { ...module, transformfunction: "fbmnoise", transformoctaves: 3 }, b);
    expect(a.columns.size0[0]).toBe(half(fbm1(v, 10, 3)));
    expect(b.columns.size0[0]).toBe(a.columns.size0[0]);
    const zero = run("init", { ...module, transformfunction: "fbmnoise", transformoctaves: 0 }, context());
    expect(Number.isNaN(zero.columns.size0[0])).toBe(true);
  });

  it("输出是向量时 y、z 各自算（各用自己的分量），标量输出只算 x", () => {
    // 输入 position (100, 50, 25)、区间 0..1000 → v = (0.1, 0.05, 0.025)
    const vec = { ...module, input: "position", inputrangemax: 1000, output: "velocity" };
    const ctx = run("init", vec, context());
    expect(spy(snoise1).mock.calls.length).toBe(3);
    expect(lane(ctx.columns.velocity)).toEqual([100, 50, 25].map((p) => half(snoise1(f32(f32(p / 1000) * 10)))));
    spy(snoise1).mockClear();
    run("init", { ...vec, output: "size" }, context());
    expect(spy(snoise1).mock.calls.length).toBe(1);
    run("init", { ...vec, transformfunction: "fbmnoise", output: "color" }, context());
    expect(spy(fbm1).mock.calls.length).toBe(3);
    spy(fbm1).mockClear();
    run("init", { ...vec, transformfunction: "fbmnoise", output: "opacity" }, context());
    expect(spy(fbm1).mock.calls.length).toBe(1);
  });
});

describe("输出 controlpoint（rea 2.7、2.8）", () => {
  /** 输入 size（op 读当前值、init 读 size0）、区间恒等、不夹：o = 尺寸（三分量相同）。 */
  const toCp = (operation: string, extra: JsonObject = {}) => ({
    input: "size",
    flags: 0,
    output: "controlpoint",
    outputcontrolpoint0: 1,
    operation,
    ...extra,
  });

  it("op：每 4 个槽一组只有 lane 0（槽 4g，含死槽）生效；remap 时最后一组胜出", () => {
    const ctx = context(6);
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].forEach((s, i) => (ctx.columns.size[i] = s));
    ctx.columns.life[4] = 0; // 槽 4 是死槽，照样是第二组的 lane 0
    run("op", toCp("remap"), ctx);
    expect([...ctx.controlPoints.current(1).translation]).toEqual([0.5, 0.5, 0.5].map(f32));
    // count = 4：只有一组，lane 0 是槽 0
    const four = context(4);
    [0.1, 0.2, 0.3, 0.4].forEach((s, i) => (four.columns.size[i] = s));
    run("op", toCp("remap"), four);
    expect([...four.controlPoints.current(1).translation]).toEqual([0.1, 0.1, 0.1].map(f32));
  });

  it("op：add 时每组累加一次（逐组读当前的 C）；outputcomponent 只写选中的分量", () => {
    const ctx = context(9);
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].forEach((s, i) => (ctx.columns.size[i] = s));
    run("op", toCp("add"), ctx);
    // 槽 0、4、8
    const add = (base: number) => f32(f32(f32(base + f32(0.1)) + f32(0.5)) + f32(0.9));
    expect([...ctx.controlPoints.current(1).translation]).toEqual([add(-200), add(100), add(0)]);
    const y = context(5);
    [0.1, 0.2, 0.3, 0.4, 0.5].forEach((s, i) => (y.columns.size[i] = s));
    run("op", toCp("add", { outputcomponent: "y" }), y);
    expect([...y.controlPoints.current(1).translation]).toEqual([-200, f32(f32(100 + f32(0.1)) + f32(0.5)), 0]);
  });

  it("op 的 blend：(op(C, o) − C)·b + C，b 取 lane 0 的粒子", () => {
    const ctx = context(1);
    ctx.columns.size[0] = 0.5;
    ctx.columns.age[0] = 0; // t = 0 < blendinstart 0.5 → b = 0：C 不变
    run("op", toCp("remap", { blendinstart: 0.5, blendinend: 0.6 }), ctx);
    expect([...ctx.controlPoints.current(1).translation]).toEqual([-200, 100, 0]);
    ctx.columns.age[0] = 6; // t = 1 → b = 1：C = o
    run("op", toCp("remap", { blendinstart: 0.5, blendinend: 0.6 }), ctx);
    expect([...ctx.controlPoints.current(1).translation]).toEqual([0.5, 0.5, 0.5]);
  });

  it("init：每个新粒子按出生顺序写一次（remap 时最后出生的胜出，add 时逐个累加），读的是 size0", () => {
    const ctx = context(3);
    [0.25, 0.5, 0.75].forEach((s, i) => (ctx.columns.size0[i] = s));
    const remap = fieldsOf("init", toCp("remap"));
    const add = fieldsOf("init", toCp("add"));
    for (const slot of [0, 1]) remapInitialValue(remap, { ...ctx, slot });
    expect([...ctx.controlPoints.current(1).translation]).toEqual([0.5, 0.5, 0.5]);
    for (const slot of [0, 2]) remapInitialValue(add, { ...ctx, slot });
    expect([...ctx.controlPoints.current(1).translation]).toEqual([1.5, 1.5, 1.5]);
  });
});

describe("0x10000（rea 2.8）", () => {
  it("输出 controlpoint 的 ocp0 置 0x10000，两个模块都是；输入 16–18、输出 17、18 不置", () => {
    expect(REMAP_CONTROL_POINT_FLAG).toBe(CONTROL_POINT_FLAGS.remap);
    for (const kind of ["init", "op"] as const) {
      expect(remapControlPointFlags(fieldsOf(kind, { output: "controlpoint", outputcontrolpoint0: 3 }))).toEqual([
        [3, 0x10000],
      ]);
      for (const module of [
        { input: "controlpoint", inputcontrolpoint0: 3, outputcontrolpoint0: 3 },
        { output: "deltatocontrolpoint", outputcontrolpoint0: 3 },
        { output: "directiontocontrolpoint", outputcontrolpoint0: 3 },
      ])
        expect(remapControlPointFlags(fieldsOf(kind, module)), JSON.stringify(module)).toEqual([]);
    }
    const particle = parseParticle(
      {
        maxcount: 4,
        initializer: [{ name: NAME.init, output: "controlpoint", outputcontrolpoint0: 2 }],
        operator: [{ name: NAME.op, output: "controlpoint", outputcontrolpoint0: 5 }],
      },
      { file: "p.json", orthographic: true },
    );
    expect(controlPointModuleFlags(particle)).toEqual([0, 0, 0x10000, 0, 0, 0x10000, 0, 0]);
  });

  /** 1 号点 offset (300, 0, 0)、实例覆盖 controlpoint1 = (50, 60, 0)；`output` 是 remap 写的输出。 */
  function cpSet(output: string, world: boolean) {
    const particle = parseParticle(
      {
        maxcount: 4,
        flags: world ? 1 : 0,
        controlpoint: [{}, { offset: "300 0 0" }],
        operator: [{ name: NAME.op, output, outputcontrolpoint0: 1 }],
      },
      { file: "p.json", orthographic: true, instanceoverride: { controlpoint1: "50 60 0" } },
    );
    return new ControlPointSet(particle);
  }

  it("不吃实例覆盖、update 跳过（本地、世界都是）：current 一直是 base = I + offset，直到 remap 改写", () => {
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]);
    for (const isWorld of [false, true]) {
      const set = cpSet("controlpoint", isWorld);
      expect([...set.current(1).translation]).toEqual([300, 0, 0]);
      set.update({ world, pointer: [0, 0] });
      expect([...set.current(1).translation], `world ${isWorld}`).toEqual([300, 0, 0]);
      // 对照：输出 deltatocontrolpoint 的同一个点不置位，照常吃覆盖、世界系统照常 W·base
      const plain = cpSet("deltatocontrolpoint", isWorld);
      expect([...plain.current(1).translation]).toEqual([50, 60, 0]);
      plain.update({ world, pointer: [0, 0] });
      expect([...plain.current(1).translation]).toEqual(isWorld ? [57, 68, 9] : [50, 60, 0]);
    }
  });

  it("offset 不再起作用：remap 写过之后，update 不按 base 重算，发射器读到的是 remap 的值（rv-cpout）", () => {
    // 发射器在 1 号点（offset (300, 0, 0)）；remapvalue 把 1 号点写成 (10, 20, 0)。世界系统也一样（update 跳过）
    for (const world of [false, true]) {
      const s = new ParticleSystem(
        parseParticle(
          {
            maxcount: 16,
            flags: world ? 1 : 0,
            controlpoint: [{}, { offset: "300 0 0" }],
            emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, controlpoint: 1, rate: 10 }],
            initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
            operator: [
              {
                name: NAME.op,
                input: "runtime",
                output: "controlpoint",
                outputcontrolpoint0: 1,
                operation: "remap",
                outputrangemin: "10 20 0",
                outputrangemax: "10 20 0",
              },
            ],
          },
          { file: "p.json", orthographic: true },
        ),
        new SeededRandom(1),
        1,
      );
      const W = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1]);
      s.step(0.1, 0.1, { world: W, pointer: [0, 0] });
      // 第一帧发射在 op 之前：出生点是 base（世界系统也不乘 W：update 跳过）
      expect(lane(s.columns.position, 0), `world ${world}`).toEqual([300, 0, 0]);
      s.step(0.1, 0.2, { world: W, pointer: [0, 0] });
      expect(lane(s.columns.position, 1), `world ${world}`).toEqual([10, 20, 0]);
    }
  });
});

describe("init 的输入 16–18：把 cp[icp0].current 的平移写成 0（rea 2.2，WPE 的 bug）", () => {
  it("输入是 0、0 − P、normalize(0 − P)，控制点写成 0", () => {
    const base = { inputcontrolpoint0: 1, flags: 0, inputrangemin: -1000, inputrangemax: 1000, operation: "remap" };
    const cp = run("init", { ...base, input: "controlpoint", inputcomponent: "y", output: "size" }, context());
    expect([...cp.controlPoints.current(1).translation]).toEqual([0, 0, 0]);
    expect(cp.columns.size0[0]).toBe(f32(f32(0 + 1000) / 2000));
    const delta = run("init", { ...base, input: "deltatocontrolpoint", output: "velocity" }, context());
    expect([...delta.controlPoints.current(1).translation]).toEqual([0, 0, 0]);
    expect(lane(delta.columns.velocity)).toEqual([-100, -50, -25].map((d) => f32(f32(d + 1000) / 2000)));
    const dir = run(
      "init",
      { ...base, input: "directiontocontrolpoint", inputrangemin: -1, inputrangemax: 1, output: "velocity" },
      context(),
    );
    const n2 = f32(f32(f32(100 * 100) + f32(50 * 50)) + f32(25 * 25));
    const inverse = f32(1 / f32(Math.sqrt(n2)));
    expect(lane(dir.columns.velocity)).toEqual([-100, -50, -25].map((d) => f32(f32(f32(d * inverse) + 1) / 2)));
  });

  it("P 在原点时 directiontocontrolpoint 是 0·inf = NaN（同 WPE 的 ri-in-directiontocontrolpoint）", () => {
    const ctx = context();
    [0, 1, 2].forEach((i) => (ctx.columns.position[i][0] = 0));
    run(
      "init",
      { input: "directiontocontrolpoint", inputcontrolpoint0: 1, inputcomponent: "min", output: "size" },
      ctx,
    );
    expect(Number.isNaN(ctx.columns.size0[0])).toBe(true);
  });

  /** 发射器在 1 号点（offset (300, 0, 0)），rate 20（dt 0.1 一帧两个），initializer 读 1 号点。 */
  function cpBug(world: boolean) {
    return new ParticleSystem(
      parseParticle(
        {
          maxcount: 64,
          flags: world ? 1 : 0,
          controlpoint: [{}, { offset: "300 0 0" }],
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, controlpoint: 1, rate: 20 }],
          initializer: [
            { name: "lifetimerandom", min: 100, max: 100 },
            { name: NAME.init, input: "controlpoint", inputcontrolpoint0: 1, output: "size", operation: "remap" },
          ],
        },
        { file: "p.json", orthographic: true },
      ),
      new SeededRandom(1),
      1,
    );
  }
  const W = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]);
  /** 本帧出生的粒子的 x（按槽序）。 */
  const newbornX = (s: ParticleSystem) => {
    const xs: number[] = [];
    for (let slot = 0; slot < s.highWater; slot++)
      if (s.columns.life[slot] !== 0 && s.columns.age[slot] === 0) xs.push(s.columns.position[0][slot]);
    return xs;
  };

  it("本地系统：第一个粒子之后控制点一直是 0（update 不重算没有 bit1 的点）", () => {
    const s = cpBug(false);
    s.step(0.1, 0.1, { world: W, pointer: [0, 0] });
    expect(newbornX(s)).toEqual([300, 0]);
    for (let f = 2; f <= 4; f++) {
      s.step(0.1, 0.1 * f, { world: W, pointer: [0, 0] });
      expect(newbornX(s)).toEqual([0, 0]);
    }
    expect([...s.controlPoints.current(1).translation]).toEqual([0, 0, 0]);
  });

  it("世界系统：每帧发射前按 W·base 重算，同一帧只有第一个粒子读到它，之后读到 0", () => {
    const s = cpBug(true);
    for (let f = 1; f <= 3; f++) {
      s.step(0.1, 0.1 * f, { world: W, pointer: [0, 0] });
      expect(newbornX(s), `frame ${f}`).toEqual([305, 0]);
    }
  });
});
