/**
 * P4d 步骤 4a：`remapinitialvalue`（init）、`remapvalue`（op）的管线与非噪声取值。依据 rea-p4d-modules.md 第 2 节（读码【确】）与
 * `ignore/p4/rea/p4d-mod/init15.asm`、`op19.asm`；实测见 `p4-particles-REPORT.md`「P4d 语义的实测核对」的 remap 表，回放见
 * `ignore/p4/cases/d4.json`。
 *
 * 18 处变体（`remap.ts` 文件头的编号）各至少一条：同一组输入喂给两个模块，给出不同结果；加法顺序不同、逐位相同的几处（3、4、9）只核对值。
 * 期望值按 rea 的式子逐步 float32 写出来（`f32`），不读产品代码的中间量。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { ControlPointSet, controlPointCount, IDENTITY_BASIS } from "./controlpoints";
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
import { snoise1 } from "./noise";
import { blendFactor, readBlend } from "./operators";
import { SeededRandom } from "./random";
import { remapControlPointRefs, remapInitialValue, remapParticle, remapValue, type RemapKind } from "./remap";
import { particleColumnFlags, ParticleSystem } from "./system";

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };
const NAME = { init: "remapinitialvalue", op: "remapvalue" } as const;
const CATEGORY = { init: "initializer", op: "operator" } as const;
const KINDS: RemapKind[] = ["init", "op"];
const ALL_COLUMNS = COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.angularVelocity | COLUMN_FLAGS.color | COLUMN_FLAGS.alpha;
const FLT_EPSILON = 2 ** -23;
const THIRD = f32(1 / 3);

/** 解析一个 remap 模块；`strict` 时要求没有照报的字段。 */
function fieldsOf(kind: RemapKind, module: JsonObject = {}, strict = true): ParticleFields {
  const reading = readParticleModule(CATEGORY[kind], { name: NAME[kind], ...module }, true);
  if (strict) expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef(CATEGORY[kind], NAME[kind])!, reading.fields, ONE);
}

function issuesOf(kind: RemapKind, module: JsonObject): string[] {
  return readParticleModule(CATEGORY[kind], { name: NAME[kind], ...module }, true).issues.map(
    (issue) => `${issue.kind}:${issue.field}`,
  );
}

/** 只有平移的控制点；8 个都存在。 */
function points(offsets: [number, number, number][]): ControlPointSet {
  return new ControlPointSet(
    {
      emitters: [],
      initializers: [],
      operators: [],
      flags: 0,
      controlpoints: offsets.map((offset) => ({ flags: 0, offset })),
      instance: { controlpoints: [], controlpointAngles: [] },
    },
    8,
  );
}

/** 控制点 0 在原点、1 在 (−200, 100)、2 在 (400, 0)、3 在 (−500, 300)、4 在 (500, 300)（gen_d.py 的 remap 工程）。 */
const CPS = () =>
  points([
    [0, 0, 0],
    [-200, 100, 0],
    [400, 0, 0],
    [-500, 300, 0],
    [500, 300, 0],
  ]);

/**
 * 槽 0 的执行上下文：life 6、age 1.5、frame 0.7、size0 2 / size 3、alpha0 0.5 / alpha 0.25、color0 (0.1, 0.2, 0.3) / color (0.4, 0.5,
 * 0.6)、位置 (100, 0, 0)、速度 (3, 4, 12)、旋转 z 1、角速度 z 0.5；T = 7、St = 3、图层时间 5、原点 (960, 540, 2)。
 */
function context(extra: Partial<ParticleRunContext> = {}, flags = ALL_COLUMNS): ParticleRunContext {
  const c = new ParticleColumns(4, flags);
  c.life[0] = 6;
  c.age[0] = 1.5;
  c.frame[0] = 0.7;
  c.size0[0] = 2;
  c.size[0] = 3;
  c.alpha0[0] = 0.5;
  c.alpha[0] = 0.25;
  [0.1, 0.2, 0.3].forEach((v, i) => (c.color0[i][0] = v));
  if (c.color !== c.color0) [0.4, 0.5, 0.6].forEach((v, i) => (c.color[i][0] = v));
  [100, 0, 0].forEach((v, i) => (c.position[i][0] = v));
  [3, 4, 12].forEach((v, i) => (c.velocity[i][0] = v));
  c.rotation[2][0] = 1;
  if (c.angularVelocity) c.angularVelocity[2][0] = 0.5;
  return {
    columns: c,
    random: new SeededRandom(1),
    slot: 0,
    count: 1,
    h: 0.1,
    k: 0.1,
    time: 7,
    controlPoints: CPS(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
    systemTime: 3,
    layerTime: 5,
    origin: new Float32Array([960, 540, 2]),
    ...extra,
  };
}

const lane = (columns: readonly Float32Array[]) => [columns[0][0], columns[1][0], columns[2][0]];

/** 跑一次：init 走 `remapInitialValue`（槽 0），op 走 `remapValue`（`[0, count)`）。 */
function run(kind: RemapKind, module: JsonObject, ctx: ParticleRunContext, strict = true): ParticleRunContext {
  const fields = fieldsOf(kind, module, strict);
  if (kind === "init") remapInitialValue(fields, ctx);
  else remapValue(fields, ctx);
  return ctx;
}

/** 写到 size（remap、输出区间 0..1、不夹）：返回写进去的值（init 是 size0，op 是 size）。输出区间恒等，值就是变换后的 v.x。 */
function probe(kind: RemapKind, module: JsonObject, ctx = context(), strict = true): number {
  run(kind, { output: "size", operation: "remap", flags: 0, ...module }, ctx, strict);
  return kind === "init" ? ctx.columns.size0[0] : ctx.columns.size[0];
}

describe("字段表（rea 2.1）", () => {
  it("缺省值两套相同，只有 input 不同；blend 四键只有 op", () => {
    const init = fieldsOf("init");
    const op = fieldsOf("op");
    expect(init.input).toBe("maxlifetime");
    expect(op.input).toBe("lifetimefraction");
    for (const fields of [init, op]) {
      expect(fields).toMatchObject({
        operation: "multiply",
        output: "size",
        inputcomponent: "all",
        outputcomponent: "all",
        transformfunction: "none",
        inputrangemin: [0, 0, 0],
        inputrangemax: [1, 1, 1],
        outputrangemin: [0, 0, 0],
        outputrangemax: [1, 1, 1],
        inputcontrolpoint0: 0,
        outputcontrolpoint0: 0,
        inputcontrolpoint1: 1,
        outputcontrolpoint1: 1,
        transforminputscale: 2,
        transformoctaves: 3,
        flags: 1,
      });
    }
    expect(op.blendinstart).toBe(0);
    expect(init.blendinstart).toBeUndefined();
    expect(issuesOf("init", { blendinstart: 0.5 })).toEqual(["unknown:blendinstart"]);
  });

  it("vec3splat：数字铺满三分量，字符串读三个数（少写的是 0），别的形状照报", () => {
    expect(fieldsOf("op", { inputrangemin: 5 }).inputrangemin).toEqual([5, 5, 5]);
    expect(fieldsOf("op", { outputrangemax: "1 2" }).outputrangemax).toEqual([1, 2, 0]);
    expect(fieldsOf("init", { outputrangemin: "-500 -300 0" }).outputrangemin).toEqual([-500, -300, 0]);
    expect(issuesOf("op", { inputrangemax: "a b" })).toEqual(["value:inputrangemax"]);
    expect(issuesOf("op", { inputrangemax: true })).toEqual(["value:inputrangemax"]);
  });

  it("照报的取值：timeofday 与未知名字；4b 起 init 的输入 16–18、两边的输出 controlpoint、两种噪声放行", () => {
    for (const kind of KINDS) {
      expect(issuesOf(kind, { input: "timeofday" })).toEqual(["value:input"]);
      expect(issuesOf(kind, { input: "Runtime" })).toEqual(["value:input"]);
      expect(issuesOf(kind, { output: "controlpoint" })).toEqual([]);
      expect(issuesOf(kind, { output: "foo" })).toEqual(["value:output"]);
      expect(issuesOf(kind, { transformfunction: "simplexnoise" })).toEqual([]);
      expect(issuesOf(kind, { transformfunction: "fbmnoise" })).toEqual([]);
      expect(issuesOf(kind, { transformfunction: "cosine" })).toEqual(["value:transformfunction"]);
      expect(issuesOf(kind, { operation: "divide" })).toEqual(["value:operation"]);
      expect(issuesOf(kind, { inputcomponent: "w", outputcomponent: "w" })).toEqual([
        "value:inputcomponent",
        "value:outputcomponent",
      ]);
      // 读码确定不写的输出、`flags` 的其它位、`average` 之类的输出分量：放行
      for (const output of [
        "lifetimefraction",
        "runtime",
        "timeofday",
        "particlesystemtime",
        "layertime",
        "layerorigin",
      ])
        expect(issuesOf(kind, { output }), output).toEqual([]);
      expect(issuesOf(kind, { flags: 255, outputcomponent: "average", transformfunction: "triangle" })).toEqual([]);
    }
    for (const input of ["controlpoint", "deltatocontrolpoint", "directiontocontrolpoint"]) {
      expect(issuesOf("init", { input }), input).toEqual([]);
      expect(issuesOf("op", { input }), input).toEqual([]);
    }
    // 输出 maxlifetime：op 一直照报，init 放行
    expect(issuesOf("op", { output: "maxlifetime" })).toEqual(["value:output"]);
    expect(issuesOf("init", { output: "maxlifetime" })).toEqual([]);
  });

  it("解析期修正：四个控制点下标 min(·, 7)（无符号），transformoctaves 取无符号整数、不钳制", () => {
    const fields = fieldsOf("op", {
      inputcontrolpoint0: 9,
      outputcontrolpoint0: -1,
      inputcontrolpoint1: 3,
      outputcontrolpoint1: 7,
      transformoctaves: -1,
    });
    expect([
      fields.inputcontrolpoint0,
      fields.outputcontrolpoint0,
      fields.inputcontrolpoint1,
      fields.outputcontrolpoint1,
    ]).toEqual([7, 7, 3, 7]);
    // 解析值是无符号整数（模拟用的字段统一舍入成 float32，2³² − 1 会变成 2³²；octaves 只有 4b 的噪声读）
    expect(readParticleModule("operator", { name: NAME.op, transformoctaves: -1 }, true).fields.transformoctaves).toBe(
      4294967295,
    );
    expect(fields.transformoctaves).toBe(2 ** 32);
    expect(fieldsOf("init", { transformoctaves: 40 }).transformoctaves).toBe(40);
  });

  it("列标志（变体 18）：op 输出 opacity 置 alpha 当前值列、color 置颜色当前值列；init 不置", () => {
    const flagsOf = (kind: RemapKind, output: string) =>
      particleColumnFlags({
        emitters: [],
        initializers: kind === "init" ? [{ name: NAME.init, id: null, fields: { output } }] : [],
        operators: kind === "op" ? [{ name: NAME.op, id: null, fields: { output } }] : [],
      });
    expect(flagsOf("op", "opacity")).toBe(COLUMN_FLAGS.alpha);
    expect(flagsOf("op", "color")).toBe(COLUMN_FLAGS.color);
    expect(flagsOf("op", "size")).toBe(0);
    expect(flagsOf("init", "opacity")).toBe(0);
    expect(flagsOf("init", "color")).toBe(0);
  });

  it("控制点个数：输入或输出属于 {7, 8, 16, 17, 18} 时计 icp0、ocp0，是 8 时再计 icp1、ocp1（icp1 不读也计）", () => {
    const refs = (module: JsonObject) => remapControlPointRefs(fieldsOf("op", module, false));
    const cps = { inputcontrolpoint0: 2, outputcontrolpoint0: 3, inputcontrolpoint1: 5, outputcontrolpoint1: 6 };
    expect(refs({ input: "size", output: "size", ...cps })).toEqual([]);
    expect(refs({ input: "distancetocontrolpoint", ...cps })).toEqual([2, 3]);
    expect(refs({ output: "deltatocontrolpoint", ...cps })).toEqual([2, 3]);
    expect(refs({ output: "controlpoint", ...cps })).toEqual([2, 3]);
    expect(refs({ input: "positionbetweentwocontrolpoints", ...cps })).toEqual([2, 3, 5, 6]);
    expect(refs({ output: "positionbetweentwocontrolpoints", ...cps })).toEqual([2, 3, 5, 6]);
    // rv-between：icp0/1 = 2/3、ocp0/1 = 0/1 → 4 个
    const particle = parseParticle(
      {
        maxcount: 4,
        operator: [
          {
            name: NAME.op,
            input: "positionbetweentwocontrolpoints",
            inputcontrolpoint0: 2,
            inputcontrolpoint1: 3,
            outputcontrolpoint0: 0,
            outputcontrolpoint1: 1,
          },
        ],
      },
      { file: "p.json", orthographic: true },
    );
    expect(controlPointCount(particle)).toBe(4);
    expect(
      controlPointCount(
        parseParticle({ maxcount: 4, initializer: [{ name: NAME.init }] }, { file: "p.json", orthographic: true }),
      ),
    ).toBe(0);
  });
});

describe("输入（rea 2.2，变体 1–8）", () => {
  it("变体 1 lifetimefraction：init 读 frame 列，op 是 rcp(life)·age", () => {
    expect(probe("init", { input: "lifetimefraction" })).toBe(f32(0.7));
    expect(probe("op", { input: "lifetimefraction" })).toBe(f32(f32(1 / 6) * 1.5));
  });

  it("变体 2 size / opacity / color：init 读初始值列，op 读当前值列", () => {
    expect(probe("init", { input: "size", inputrangemax: 4 })).toBe(0.5);
    expect(probe("op", { input: "size", inputrangemax: 4 })).toBe(f32(3 * f32(1 / 4)));
    expect(probe("init", { input: "opacity" })).toBe(0.5);
    expect(probe("op", { input: "opacity" })).toBe(0.25);
    const sum = (a: number, b: number, c: number) => f32(f32(f32(a) + f32(b)) + f32(c));
    expect(probe("init", { input: "color", inputcomponent: "sum", inputrangemax: 3 })).toBe(
      f32(sum(0.1, 0.2, 0.3) / 3),
    );
    expect(probe("op", { input: "color", inputcomponent: "sum", inputrangemax: 3 })).toBe(
      f32(sum(0.5, 0.4, 0.6) * f32(1 / 3)),
    );
  });

  it("变体 3、4 speed / distancetocontrolpoint：两边只是加法顺序不同，逐位相同", () => {
    for (const kind of KINDS) {
      expect(probe(kind, { input: "speed" }), kind).toBe(13);
      expect(probe(kind, { input: "distancetocontrolpoint", inputcontrolpoint0: 1 }), kind).toBe(
        f32(Math.sqrt(100000)),
      );
    }
  });

  it("变体 5 positionbetweentwocontrolpoints：两边都读 ocp0 / ocp1（不是 icp）", () => {
    const module = {
      input: "positionbetweentwocontrolpoints",
      inputcontrolpoint0: 3,
      inputcontrolpoint1: 4,
      outputcontrolpoint0: 0,
      outputcontrolpoint1: 2,
    };
    // 按 ocp：P = (100, 0)、线段 (0, 0)→(400, 0)，0.25；按 icp 是 (100 + 500)/1000 = 0.6
    for (const kind of KINDS) expect(probe(kind, module), kind).toBe(0.25);
  });

  it("变体 5 两端几乎重合：init 在 L ≤ FLT_EPSILON 时为 0，op 只要 |D|² > 0 就是 dot·rcp(|D|²)", () => {
    const ctx = () => {
      const c = context({
        controlPoints: points([
          [0, 0, 0],
          [1e-8, 0, 0],
        ]),
      });
      c.columns.position[0][0] = f32(1e-8);
      return c;
    };
    const module = { input: "positionbetweentwocontrolpoints", outputcontrolpoint0: 0, outputcontrolpoint1: 1 };
    expect(probe("init", module, ctx())).toBe(0);
    expect(probe("op", module, ctx())).toBeCloseTo(1, 6);
  });

  it("变体 6 particlesystemtime：init 读系统时间 St，op 读场景时间 T（同 runtime）；layertime、layerorigin", () => {
    expect(probe("init", { input: "particlesystemtime", inputrangemax: 10 })).toBe(f32(3 / 10));
    expect(probe("op", { input: "particlesystemtime", inputrangemax: 10 })).toBe(f32(7 * f32(1 / 10)));
    expect(probe("init", { input: "runtime", inputrangemax: 10 })).toBe(f32(7 / 10));
    expect(probe("op", { input: "runtime", inputrangemax: 10 })).toBe(f32(7 * f32(1 / 10)));
    expect(probe("init", { input: "layertime", inputrangemax: 10 })).toBe(f32(5 / 10));
    expect(probe("op", { input: "layertime", inputrangemax: 10 })).toBe(f32(5 * f32(1 / 10)));
    for (const kind of KINDS) expect(probe(kind, { input: "layerorigin", inputcomponent: "z" }), kind).toBe(2);
    // 上下文没给时间与原点（单测手写的上下文）：按 0
    const bare = context({ systemTime: undefined, layerTime: undefined, origin: undefined });
    expect(probe("init", { input: "particlesystemtime" }, bare)).toBe(0);
    expect(probe("op", { input: "layerorigin", inputcomponent: "y" }, context({ origin: undefined }))).toBe(0);
  });

  it("变体 7 op 的 controlpoint / deltatocontrolpoint / directiontocontrolpoint", () => {
    // C = (−200, 100, 0)、P = (100, 0, 0)
    expect(probe("op", { input: "controlpoint", inputcontrolpoint0: 1, inputcomponent: "y", inputrangemax: 200 })).toBe(
      f32(100 * f32(1 / 200)),
    );
    const average = f32(f32(f32(100 + -300) + 0) * THIRD);
    expect(
      probe("op", {
        input: "deltatocontrolpoint",
        inputcontrolpoint0: 1,
        inputcomponent: "average",
        inputrangemin: -1000,
        inputrangemax: 0,
      }),
    ).toBe(f32(f32(average + 1000) * f32(1 / 1000)));
    const m = f32(1 / Math.sqrt(100000));
    expect(
      probe("op", {
        input: "directiontocontrolpoint",
        inputcontrolpoint0: 1,
        inputcomponent: "min",
        inputrangemin: -1,
      }),
    ).toBe(f32(f32(f32(m * -300) + 1) * f32(1 / 2)));
    // P 就在控制点上：掩码 0 < |C − P|² 不成立，方向是 0
    const on = context();
    [-200, 100, 0].forEach((v, i) => (on.columns.position[i][0] = v));
    expect(probe("op", { input: "directiontocontrolpoint", inputcontrolpoint0: 1, inputcomponent: "x" }, on)).toBe(0);
  });

  it("变体 8 angularspeed：有角速度列（列标志 bit1）时读 angvz，否则 0", () => {
    for (const kind of KINDS) {
      expect(probe(kind, { input: "angularspeed" }), kind).toBe(0.5);
      expect(probe(kind, { input: "angularspeed" }, context({}, 0)), kind).toBe(0);
    }
  });

  it("timeofday 与未知输入（照报）：按 0，不出 NaN", () => {
    for (const kind of KINDS) {
      expect(probe(kind, { input: "timeofday", inputrangemin: -1, inputrangemax: 0 }, context(), false), kind).toBe(1);
      expect(probe(kind, { input: "foo", inputrangemin: -1, inputrangemax: 0 }, context(), false), kind).toBe(1);
    }
  });
});

describe("分量（rea 2.3，变体 9）", () => {
  it("向量输入：x / y / z 取一个，sum / average / max / min 合成，all 不变（标量输出读 x）", () => {
    const ctx = () => {
      const c = context();
      [1, 2, 4].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    const cases: [string, number][] = [
      ["all", 1],
      ["x", 1],
      ["y", 2],
      ["z", 4],
      ["sum", 7],
      ["average", f32(7 * THIRD)],
      ["max", 4],
      ["min", 1],
    ];
    for (const kind of KINDS)
      for (const [inputcomponent, want] of cases)
        expect(probe(kind, { input: "position", inputcomponent }, ctx()), `${kind} ${inputcomponent}`).toBe(want);
  });

  it("标量输入（编号 ≤ 12）不看分量", () => {
    expect(probe("init", { input: "size", inputcomponent: "z" })).toBe(2);
    expect(probe("op", { input: "size", inputcomponent: "sum" })).toBe(3);
  });
});

describe("归一化（rea 2.4，变体 10）", () => {
  const vector = { inputrangemin: "0 5 0", inputrangemax: "10 6 1", output: "velocity", operation: "remap", flags: 0 };

  it("标量输入：init 先铺满再按各自分量 (in − min)/range；op 只用 x 分量的 min 与 rcp，再铺到 y、z", () => {
    const t = 3;
    const init = run("init", { input: "runtime", ...vector }, context({ time: t }));
    expect(lane(init.columns.velocity)).toEqual([f32(3 / 10), -2, 3]);
    const op = run("op", { input: "runtime", ...vector }, context({ time: t }));
    const x = f32(3 * f32(1 / 10));
    expect(lane(op.columns.velocity)).toEqual([x, x, x]);
  });

  it("向量输入：两边都按分量，init 用除法、op 用 rcp(range)", () => {
    const ctx = () => {
      const c = context();
      [1, 2, 4].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    const module = {
      input: "position",
      inputrangemin: "0 1 2",
      inputrangemax: "10 4 7",
      output: "velocity",
      operation: "remap",
      flags: 0,
    };
    expect(lane(run("init", module, ctx()).columns.velocity)).toEqual([f32(1 / 10), f32(1 / 3), f32(2 / 5)]);
    expect(lane(run("op", module, ctx()).columns.velocity)).toEqual([
      f32(1 * f32(1 / 10)),
      f32(1 * f32(1 / 3)),
      f32(2 * f32(1 / 5)),
    ]);
  });

  it("区间为 0 的分量换成 FLT_EPSILON；flags bit0 把归一化的值夹到 [0, 1]", () => {
    for (const kind of KINDS) {
      expect(probe(kind, { input: "runtime", inputrangemin: 1, inputrangemax: 1 }, context({ time: 1.5 })), kind).toBe(
        0.5 / FLT_EPSILON,
      );
      expect(probe(kind, { input: "runtime", flags: 1 }, context({ time: 7 })), kind).toBe(1);
      expect(probe(kind, { input: "runtime", flags: 1 }, context({ time: -2 })), kind).toBe(0);
    }
  });
});

describe("变换（rea 2.5，变体 11、12）", () => {
  /** 输入 runtime（T = v）、区间 0..1、不夹：归一化后就是 v。 */
  const wave = (kind: RemapKind, transformfunction: string, v: number, transforminputscale: number) =>
    probe(kind, { input: "runtime", transformfunction, transforminputscale }, context({ time: f32(v) }));

  it("变体 11 sine：init sinf((v·π)·s − π/2)，op sin_ps(v·(s·π) − π/2)，乘法顺序不同（s = 3、v = 0.08 时差 1 ulp）", () => {
    expect(wave("init", "sine", 0.08, 3)).toBe(0.13551568984985352);
    expect(wave("op", "sine", 0.08, 3)).toBe(0.13551566004753113);
    // s = 2 时 2π 是 π 的精确两倍，两边逐位相同：v = 0 → 0，v = 0.5 → 1
    for (const kind of KINDS) {
      expect(wave(kind, "sine", 0, 2), kind).toBe(0);
      expect(wave(kind, "sine", 0.5, 2), kind).toBe(1);
    }
  });

  it("变体 12 square：init floorf + roundf（半数远离零），op 截断 + 偶舍入；负号看缩放后的 t", () => {
    // t = −0.3：init (−0.3 − (−1)) = 0.7 → 1，+1 = 2；op (−0.3 − (−0)) = −0.3 → −0，+1 = 1
    expect(wave("init", "square", -0.1, 3)).toBe(2);
    expect(wave("op", "square", -0.1, 3)).toBe(1);
    // t = 2.5：小数 0.5，init 远离零得 1，op 偶舍入得 0
    expect(wave("init", "square", 0.5, 5)).toBe(1);
    expect(wave("op", "square", 0.5, 5)).toBe(0);
    // s 为负、v 为正：t = −0.3 < 0，square 加 1
    expect(wave("init", "square", 0.1, -3)).toBe(2);
  });

  it("变体 12 saw：(t − ⌊t⌋) + (v < 0)，init floorf、op 截断；负号看缩放前的 v", () => {
    const t = f32(f32(-0.1) * 3);
    expect(wave("init", "saw", -0.1, 3)).toBe(f32(f32(t - Math.floor(t)) + 1));
    expect(wave("op", "saw", -0.1, 3)).toBe(f32(f32(t - Math.trunc(t)) + 1));
    // v = 0.1、s = −3：t 是负的，但 v ≥ 0 不加 1
    const u = f32(f32(0.1) * -3);
    expect(wave("init", "saw", 0.1, -3)).toBe(f32(u - Math.floor(u)));
  });

  it("变体 12 triangle：1 − |2·(|t| − ⌊|t|⌋) − 1|（|t| ≥ 0，两边相同）", () => {
    const a = Math.abs(f32(f32(-0.1) * 3));
    const want = f32(1 - Math.abs(f32(f32(f32(a - Math.floor(a)) * 2) - 1)));
    for (const kind of KINDS) {
      expect(wave(kind, "triangle", -0.1, 3), kind).toBe(want);
      expect(wave(kind, "triangle", 0.5, 5), kind).toBe(1);
    }
  });
});

describe("输出区间与写回（rea 2.6、2.7，变体 13–17）", () => {
  it("变体 13 输出是向量时两边都算 y、z（o = range·v + min）；flags bit1 把输出夹到 [0, 1]", () => {
    const module = {
      input: "runtime",
      output: "velocity",
      operation: "remap",
      flags: 0,
      outputrangemin: "0 10 20",
      outputrangemax: "1 12 24",
    };
    for (const kind of KINDS)
      expect(lane(run(kind, module, context({ time: 0.5 })).columns.velocity), kind).toEqual([0.5, 11, 22]);
    for (const kind of KINDS)
      expect(probe(kind, { input: "runtime", outputrangemax: 10, flags: 2 }, context({ time: 0.5 })), kind).toBe(1);
  });

  it("变体 14 size / opacity / color：init 写初始值列，op 写当前值列", () => {
    const init = run(
      "init",
      { input: "runtime", output: "opacity", operation: "remap", flags: 0 },
      context({ time: 0.75 }),
    );
    expect([init.columns.alpha0[0], init.columns.alpha[0]]).toEqual([0.75, 0.25]);
    const op = run(
      "op",
      { input: "runtime", output: "opacity", operation: "remap", flags: 0 },
      context({ time: 0.75 }),
    );
    expect([op.columns.alpha0[0], op.columns.alpha[0]]).toEqual([0.5, 0.75]);
    const color = { input: "runtime", output: "color", outputcomponent: "y", operation: "remap", flags: 0 };
    expect(lane(run("init", color, context({ time: 0.75 })).columns.color0)).toEqual([f32(0.1), 0.75, f32(0.3)]);
    const opColor = run("op", color, context({ time: 0.75 }));
    expect(lane(opColor.columns.color)).toEqual([f32(0.4), 0.75, f32(0.6)]);
    expect(lane(opColor.columns.color0)).toEqual([f32(0.1), f32(0.2), f32(0.3)]);
  });

  it("变体 15 speed：init L ≠ 0 时 s/L（divss），op L > 0 时 rcp(L)·s；L = 0 时不除、不出 NaN", () => {
    // v = (3, 0, 0)、remap 到 7：init 7/3·3 = 7，op rcp(3)·7·3 = 7.0000005
    const ctx = () => {
      const c = context();
      [3, 0, 0].forEach((v, i) => (c.columns.velocity[i][0] = v));
      return c;
    };
    const module = { input: "runtime", output: "speed", operation: "remap", outputrangemin: 7, outputrangemax: 7 };
    expect(lane(run("init", module, ctx()).columns.velocity)).toEqual([f32(f32(7 / 3) * 3), 0, 0]);
    expect(lane(run("op", module, ctx()).columns.velocity)).toEqual([f32(f32(f32(1 / 3) * 7) * 3), 0, 0]);
    expect(f32(f32(7 / 3) * 3)).not.toBe(f32(f32(f32(1 / 3) * 7) * 3));
    // add：s = L + o
    expect(
      lane(
        run(
          "init",
          { input: "runtime", output: "speed", operation: "add", outputrangemin: 2, outputrangemax: 2 },
          ctx(),
        ).columns.velocity,
      ),
    ).toEqual([5, 0, 0]);
    for (const kind of KINDS) {
      const still = context();
      [0, 0, 0].forEach((v, i) => (still.columns.velocity[i][0] = v));
      expect(lane(run(kind, module, still).columns.velocity), kind).toEqual([0, 0, 0]);
    }
  });

  it("变体 16 distancetocontrolpoint：沿原方向放到离 ocp0 op(L, o) 处；init L = 0 时不除（P = C），op 的掩码 L ≠ 0 对 NaN 也成立", () => {
    const module = {
      output: "distancetocontrolpoint",
      outputcontrolpoint0: 1,
      operation: "remap",
      outputrangemin: 150,
      outputrangemax: 150,
    };
    const ctx = () => {
      const c = context();
      [100, 100, 0].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    for (const kind of KINDS) expect(lane(run(kind, module, ctx()).columns.position), kind).toEqual([-50, 100, 0]);
    // multiply：距离 300 × 0.5
    for (const kind of KINDS)
      expect(
        lane(
          run(kind, { ...module, operation: "multiply", outputrangemin: 0.5, outputrangemax: 0.5 }, ctx()).columns
            .position,
        ),
        kind,
      ).toEqual([-50, 100, 0]);
    const on = () => {
      const c = context();
      [-200, 100, 0].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    expect(lane(run("init", module, on()).columns.position)).toEqual([-200, 100, 0]);
    // rsqrt(0) = inf，L = inf·0 = NaN，cmpneqps 认它不等于 0：d̂ = 0·inf = NaN（WPE 同样画不出来）
    expect(lane(run("op", module, on()).columns.position).every(Number.isNaN)).toBe(true);
  });

  it("变体 16 positionbetweentwocontrolpoints：保留垂直分量，沿 ocp0→ocp1 放到 op(frac, o) 处", () => {
    const module = {
      output: "positionbetweentwocontrolpoints",
      outputcontrolpoint0: 0,
      outputcontrolpoint1: 2,
      operation: "remap",
      outputrangemin: 0.5,
      outputrangemax: 0.5,
    };
    const ctx = () => {
      const c = context();
      [100, 50, 0].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    expect(lane(run("init", module, ctx()).columns.position)).toEqual([200, 50, 0]);
    const op = lane(run("op", module, ctx()).columns.position);
    expect(op[0]).toBeCloseTo(200, 3);
    expect(op[1]).toBeCloseTo(50, 4);
    // add 0.25：比例 0.25 + 0.25
    expect(
      lane(
        run("init", { ...module, operation: "add", outputrangemin: 0.25, outputrangemax: 0.25 }, ctx()).columns
          .position,
      ),
    ).toEqual([200, 50, 0]);
  });

  it("变体 16 directiontocontrolpoint：方向按分量运算后归一化，沿新方向放回原距离", () => {
    const ctx = () => {
      const c = context();
      [100, 100, 0].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    // Δ = C − P = (−300, 0, 0)；方向换成 (0, 1, 0) → P = C − (0, 300, 0)
    const up = {
      output: "directiontocontrolpoint",
      outputcontrolpoint0: 1,
      operation: "remap",
      outputrangemin: "0 1 0",
      outputrangemax: "0 1 0",
    };
    for (const kind of KINDS) {
      const p = lane(run(kind, up, ctx()).columns.position);
      expect(p[0], kind).toBeCloseTo(-200, 3);
      expect(p[1], kind).toBeCloseTo(-200, 3);
    }
    // 只运算 x：n = (−1, 0, 0) → (0.6, 0, 0)，归一化后 (1, 0, 0) → P = C − (300, 0, 0)
    const x = { ...up, outputcomponent: "x", outputrangemin: 0.6, outputrangemax: 0.6 };
    expect(lane(run("init", x, ctx()).columns.position)).toEqual([-500, 100, 0]);
    const p = lane(run("op", x, ctx()).columns.position);
    expect(p[0]).toBeCloseTo(-500, 2);
    expect(p[1]).toBe(100);
  });

  it("deltatocontrolpoint：Δ = C − P 按分量运算，再无条件写回三分量 P = C − Δ′", () => {
    const ctx = () => {
      const c = context();
      [100, 100, 0].forEach((v, i) => (c.columns.position[i][0] = v));
      return c;
    };
    const module = {
      output: "deltatocontrolpoint",
      outputcontrolpoint0: 1,
      operation: "subtract",
      outputrangemin: 1,
      outputrangemax: 1,
    };
    for (const kind of KINDS) {
      expect(lane(run(kind, module, ctx()).columns.position), kind).toEqual([101, 101, 1]);
      expect(lane(run(kind, { ...module, outputcomponent: "y" }, ctx()).columns.position), kind).toEqual([100, 101, 0]);
      // 分量 sum：不运算，照样写回（C − (C − P)，这里逐位等于 P）
      expect(lane(run(kind, { ...module, outputcomponent: "sum" }, ctx(), false).columns.position), kind).toEqual([
        100, 100, 0,
      ]);
    }
  });

  it("maxlifetime：init 照常写新粒子的 life；op 照报（WPE 写死槽、存活数下溢，复刻不了），执行时整条不跑、不写 life", () => {
    const life = { input: "runtime", output: "maxlifetime", operation: "remap", outputrangemin: 2, outputrangemax: 2 };
    expect(issuesOf("init", life)).toEqual([]);
    expect(run("init", life, context()).columns.life[0]).toBe(2);
    expect(issuesOf("op", life)).toEqual(["value:output"]);
    // op 的 [0, count) 含死槽（life 0）：照报的取值不写任何列，死槽不会被写回非零 life
    const ctx = context({ count: 3 });
    ctx.columns.life[1] = 0;
    const before = ctx.columns.buffer.slice();
    expect(() => run("op", life, ctx, false)).not.toThrow();
    expect(ctx.columns.buffer).toEqual(before);
    expect([0, 1, 2].map((slot) => ctx.columns.life[slot])).toEqual([6, 0, 0]);
    // blend 记录也一样不跑
    const blended = context();
    remapParticle("op", fieldsOf("op", { ...life, blendinstart: 0.5, blendinend: 0.6 }, false), blended, 0, 0.5);
    expect(blended.columns.life[0]).toBe(6);
  });

  it("持久列：rotation 写 z 旋转，angularspeed 要有角速度列，position / velocity / color 按分量（其余分量不写）", () => {
    for (const kind of KINDS) {
      const k = kind;
      expect(
        run(
          k,
          { input: "runtime", output: "rotation", operation: "add", outputrangemin: 0.5, outputrangemax: 0.5 },
          context(),
        ).columns.rotation[2][0],
        k,
      ).toBe(1.5);
      const spin = {
        input: "runtime",
        output: "angularspeed",
        operation: "remap",
        outputrangemin: 2,
        outputrangemax: 2,
      };
      expect(run(k, spin, context()).columns.angularVelocity![2][0], k).toBe(2);
      expect(() => run(k, spin, context({}, 0)), k).not.toThrow();
      const add = { input: "runtime", operation: "add", outputrangemin: 1, outputrangemax: 1 };
      expect(lane(run(k, { ...add, output: "position", outputcomponent: "x" }, context()).columns.position), k).toEqual(
        [101, 0, 0],
      );
      expect(lane(run(k, { ...add, output: "velocity", outputcomponent: "z" }, context()).columns.velocity), k).toEqual(
        [3, 4, 13],
      );
      expect(lane(run(k, { ...add, output: "velocity" }, context()).columns.velocity), k).toEqual([4, 5, 13]);
      expect(
        lane(run(k, { ...add, output: "velocity", outputcomponent: "max" }, context()).columns.velocity),
        k,
      ).toEqual([3, 4, 12]);
    }
  });

  it("变体 17 运算：remap → o、multiply → o·old、add → o + old、subtract → old − o；未知运算不写", () => {
    const cases: [string, number, number][] = [
      ["remap", 0.5, 0.5],
      ["multiply", 1, 1.5],
      ["add", 2.5, 3.5],
      ["subtract", 1.5, 2.5],
    ];
    for (const [operation, init, op] of cases) {
      const module = { input: "runtime", output: "size", operation, outputrangemin: 0.5, outputrangemax: 0.5 };
      expect(run("init", module, context()).columns.size0[0], operation).toBe(init);
      expect(run("op", module, context()).columns.size[0], operation).toBe(op);
    }
    const unknown = { input: "runtime", output: "size", operation: "divide", outputrangemin: 0.5, outputrangemax: 0.5 };
    expect(run("init", unknown, context(), false).columns.size0[0]).toBe(2);
    expect(run("op", unknown, context(), false).columns.size[0]).toBe(3);
  });

  it("变体 17 blend（op）：(op(old, o) − old)·b + old，b 按 t = age·rcp(life)", () => {
    const module = {
      input: "runtime",
      output: "size",
      operation: "remap",
      outputrangemin: 0.5,
      outputrangemax: 0.5,
      blendinstart: 0.5,
      blendinend: 0.6,
    };
    const fields = fieldsOf("op", module);
    const ctx = context();
    ctx.columns.age[0] = 3.3;
    remapValue(fields, ctx);
    const b = blendFactor(readBlend(fields), f32(f32(3.3) * f32(1 / 6)));
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(1);
    expect(ctx.columns.size[0]).toBe(f32(f32(f32(0.5 - 3) * b) + 3));
    // 直接给 b：subtract 是 ((old − o) − old)·b + old
    const direct = context();
    remapParticle("op", fieldsOf("op", { ...module, operation: "subtract" }), direct, 0, 0.25);
    expect(direct.columns.size[0]).toBe(f32(f32(f32(f32(3 - 0.5) - 3) * 0.25) + 3));
  });

  it("读码确定不写的输出：lifetimefraction、runtime、timeofday、particlesystemtime、layertime、layerorigin", () => {
    for (const kind of KINDS)
      for (const output of [
        "lifetimefraction",
        "runtime",
        "timeofday",
        "particlesystemtime",
        "layertime",
        "layerorigin",
      ]) {
        const ctx = context();
        const before = ctx.columns.buffer.slice();
        run(kind, { input: "runtime", output, operation: "remap" }, ctx);
        expect(ctx.columns.buffer, `${kind} ${output}`).toEqual(before);
      }
  });

  it("op 对 [0, count) 每个槽都跑（含死槽）", () => {
    const ctx = context({ count: 3 });
    ctx.columns.life[1] = 0;
    run(
      "op",
      { input: "runtime", output: "rotation", operation: "add", outputrangemin: 0.5, outputrangemax: 0.5 },
      ctx,
    );
    expect([0, 1, 2, 3].map((slot) => ctx.columns.rotation[2][slot])).toEqual([1.5, 0.5, 0.5, 0]);
  });
});

describe("4a 期间照报的取值：4b 起照常执行", () => {
  it("两种噪声、输出 controlpoint、init 的输入 controlpoint / deltatocontrolpoint / directiontocontrolpoint：只写尺寸列或控制点，不抛", () => {
    // 期望（4b）：第三项是写进尺寸列的值（init 写 size0、op 写 size；null 表示不写列），第四项是 1 号控制点的平移。槽 0 的 R 是 0。
    // init 的缺省输入 maxlifetime = 6 夹成 1，op 的 lifetimefraction = rcp(6)·1.5 = 0.25；s = 2。
    const half = (n: number) => f32(f32(n * 0.5) + 0.5);
    const modules: [RemapKind, JsonObject, number | null, number[]][] = [
      ["init", { transformfunction: "simplexnoise" }, half(snoise1(2)), [-200, 100, 0]],
      ["init", { transformfunction: "fbmnoise", transformoctaves: 0 }, NaN, [-200, 100, 0]],
      ["op", { transformfunction: "simplexnoise" }, half(simplex2(0, 0.5, 0)), [-200, 100, 0]],
      ["op", { transformfunction: "fbmnoise" }, half(fbm2(0, 0.5, 0, 3)), [-200, 100, 0]],
      ["init", { output: "controlpoint", outputcontrolpoint0: 1 }, null, [1, 1, 1]],
      ["op", { output: "controlpoint", outputcontrolpoint0: 1 }, null, [0.25, 0.25, 0.25]],
      ["init", { input: "controlpoint", inputcontrolpoint0: 1 }, 0, [0, 0, 0]],
      ["init", { input: "deltatocontrolpoint", inputcontrolpoint0: 1 }, 0, [0, 0, 0]],
      ["init", { input: "directiontocontrolpoint", inputcontrolpoint0: 1 }, 0, [0, 0, 0]],
    ];
    for (const [kind, module, size, cp1] of modules) {
      const ctx = context();
      const before = ctx.columns.buffer.slice();
      expect(() => run(kind, { output: "size", operation: "remap", ...module }, ctx, false)).not.toThrow();
      const column = kind === "init" ? ctx.columns.size0 : ctx.columns.size;
      if (size !== null) {
        expect(column[0], `${kind} ${JSON.stringify(module)}`).toBe(size);
        column[0] = kind === "init" ? 2 : 3;
      }
      expect(ctx.columns.buffer, `${kind} ${JSON.stringify(module)}`).toEqual(before);
      expect([...ctx.controlPoints.current(1).translation], `${kind} ${JSON.stringify(module)}`).toEqual(cp1);
    }
  });
});

describe("模拟器：系统时间、图层时间、对象原点（P4d 步骤 4a）", () => {
  /** 发射器在原点、rate 10、寿命 100；initializer 是给定的 remapinitialvalue（输出 size，区间恒等、不夹）。 */
  function system(
    remap: JsonObject,
    { instanceoverride, starttime }: { instanceoverride?: unknown; starttime?: number } = {},
  ) {
    return new ParticleSystem(
      parseParticle(
        {
          maxcount: 64,
          ...(starttime ? { starttime } : {}),
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, directions: "1 0 0", rate: 10 }],
          initializer: [
            { name: "lifetimerandom", min: 100, max: 100 },
            { name: NAME.init, output: "size", operation: "remap", flags: 0, ...remap },
          ],
          operator: [],
        },
        { file: "p.json", orthographic: true, instanceoverride },
      ),
      new SeededRandom(1),
      1,
    );
  }
  const newborn = (s: ParticleSystem) => {
    for (let slot = 0; slot < s.highWater; slot++)
      if (s.columns.life[slot] !== 0 && s.columns.age[slot] === 0) return slot;
    return -1;
  };

  it("St 与图层时间在模拟之前 += dt′（乘 rate、float32）；新粒子的 particlesystemtime 是含本帧的 St", () => {
    const s = system({ input: "particlesystemtime" }, { instanceoverride: { rate: 2 } });
    s.prewarm();
    let st = 0;
    for (const dt of [0.1, 0.05, 0.2, 0.033]) {
      s.step(dt, 99);
      st = f32(st + f32(f32(dt) * 2));
      expect(s.systemTime).toBe(st);
      expect(s.layerTime).toBe(st);
      const slot = newborn(s);
      if (slot >= 0) expect(s.columns.size0[slot]).toBe(st);
    }
    expect(s.alive).toBeGreaterThan(0);
  });

  it("op 的 particlesystemtime 读场景时间 T（step 的 time），不是 St", () => {
    const op = new ParticleSystem(
      parseParticle(
        {
          maxcount: 8,
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, directions: "1 0 0", rate: 10 }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
          operator: [
            {
              name: NAME.op,
              input: "particlesystemtime",
              output: "size",
              operation: "remap",
              flags: 0,
              inputrangemax: 100,
            },
          ],
        },
        { file: "p.json", orthographic: true, instanceoverride: { rate: 2 } },
      ),
      new SeededRandom(1),
      1,
    );
    op.step(0.1, 42);
    expect(op.columns.size[0]).toBe(f32(42 * f32(1 / 100)));
  });

  it("suspend：有存活粒子时两个时间清零；没有存活粒子时不动；预热不累加", () => {
    const s = system({ input: "layertime" });
    s.step(0.1, 0.1);
    s.step(0.1, 0.2);
    expect(s.systemTime).toBeGreaterThan(0);
    expect(s.suspend()).toBe(true);
    expect([s.systemTime, s.layerTime]).toEqual([0, 0]);
    s.step(0.1, 0.3);
    expect(s.systemTime).toBe(f32(0.1));
    // 清零之后新粒子读到的图层时间从 0 重新累加
    expect(s.columns.size0[newborn(s)]).toBe(f32(0.1));
    const empty = system({ input: "layertime" });
    expect(empty.suspend()).toBe(false);
    const warm = system({ input: "particlesystemtime" }, { starttime: 1 });
    warm.prewarm();
    expect(warm.alive).toBeGreaterThan(0);
    expect([warm.systemTime, warm.layerTime]).toEqual([0, 0]);
  });

  it("layerorigin 读本帧控制点输入的世界矩阵平移", () => {
    const s = system({ input: "layerorigin", inputcomponent: "y" });
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    s.step(0.1, 0.1, { world, pointer: [0, 0] });
    expect(s.columns.size0[newborn(s)]).toBe(20);
  });

  it("两遍模式：op 的持久列一帧叠两次（rv-ops），每遍重置的 size 只算一遍", () => {
    const make = (passes: 1 | 2) =>
      new ParticleSystem(
        parseParticle(
          {
            maxcount: 8,
            emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, directions: "1 0 0", rate: 10 }],
            initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
            operator: [
              {
                name: NAME.op,
                input: "runtime",
                output: "rotation",
                operation: "add",
                outputrangemin: 0.1,
                outputrangemax: 0.1,
              },
              {
                name: NAME.op,
                input: "runtime",
                output: "size",
                operation: "add",
                outputrangemin: 0.1,
                outputrangemax: 0.1,
              },
            ],
          },
          { file: "p.json", orthographic: true },
        ),
        new SeededRandom(1),
        passes,
      );
    const one = make(1);
    const two = make(2);
    one.step(0.1, 0.1);
    two.step(0.1, 0.1);
    expect(one.columns.rotation[2][0]).toBe(f32(0.1));
    expect(two.columns.rotation[2][0]).toBe(f32(f32(0.1) + f32(0.1)));
    expect(two.columns.size[0]).toBe(one.columns.size[0]);
  });

  it("op 输出 opacity 时 alpha 当前值单独成列（每遍从 alpha0 复制）", () => {
    const s = new ParticleSystem(
      parseParticle(
        {
          maxcount: 8,
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, directions: "1 0 0", rate: 10 }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
          operator: [
            {
              name: NAME.op,
              input: "runtime",
              output: "opacity",
              operation: "multiply",
              outputrangemin: 0.5,
              outputrangemax: 0.5,
            },
          ],
        },
        { file: "p.json", orthographic: true },
      ),
      new SeededRandom(1),
      2,
    );
    s.step(0.1, 0.1);
    expect(s.columns.alpha).not.toBe(s.columns.alpha0);
    expect([s.columns.alpha0[0], s.columns.alpha[0]]).toEqual([1, 0.5]);
  });
});
