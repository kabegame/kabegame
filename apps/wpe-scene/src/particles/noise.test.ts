/**
 * 噪声类模块（P4b 步骤 4）的单测。真值来源：
 * - `fixtures/noise.json`：从 WPE 粒子位置反推的单点值（snoise1 / snoise2 / snoise3、turbulentvelocityrandom 的方向），来源写在
 *   文件的 `source`，由 `apps/wpe-scene/scripts/fixtures/make_noise_fixtures.py` 生成；
 * - `fixtures/p4b-turb.json`：turb* 连续 6 个抓帧，做短程强制回放（湍流场是混沌的，从加载起整段回放没有判别力，见文件 `source`）；
 * - 读码（`rea-p4b-modules.md` B2、B3、B6、C）确定、但 WPE 实测工程测不到的分支：坐标相等时的顶点顺序、两个 `uA` 的先后、
 *   `forward` 不归一化、速度是加不是覆盖、Z 轴时间取负、`octaves` 钳制。钉的值和
 *   `apps/wpe-scene/scripts/fixtures/noise_ref.py`（照读码独立写的 Python 参考）逐位一致（同目录的 `noise_equal_cases.py`、
 *   `noise_xcheck.py`）。
 * `positionoffsetrandom` 从加载起的整段回放在 `replay.test.ts`（`p4b-posoffset60` / `10`）。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import p4bTurb from "./fixtures/p4b-turb.json";
import noiseFixture from "./fixtures/noise.json";
import { positionOffsetRandom, turbulentVelocityRandom } from "./initializers";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleCategory,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { snoise1, snoise2, snoise3 } from "./noise";
import * as tables from "./noiseTables";
import { turbulence } from "./operators";
import { SeededRandom, type ParticleRandom } from "./random";
import { instanceMultipliers, ParticleSystem } from "./system";
import { particleTrack } from "./track";

const f32 = Math.fround;
const ONE = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

/** 32 位 FNV-1a，按小端 u32 逐字节（同 `apps/wpe-scene/scripts/fixtures/gen_noise_tables.py`）。 */
function fnv(values: ArrayLike<number>): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < values.length; i++)
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (values[i] >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return hash >>> 0;
}
const bitsOf = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0];

function fieldsOf(category: ParticleCategory, module: JsonObject, multipliers = ONE): ParticleFields {
  const reading = readParticleModule(category, module, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef(category, reading.name)!, reading.fields, multipliers);
}

/** 按顺序给出 `uA` 的随机源（`uB` 不该被调用）。 */
class ScriptedRandom implements ParticleRandom {
  constructor(private readonly values: number[]) {}
  a(): number {
    const value = this.values.shift();
    if (value === undefined) throw new Error("uA 抽多了");
    return value;
  }
  b(): number {
    throw new Error("不该抽 uB");
  }
}

function context(columns: ParticleColumns, random: ParticleRandom, time: number): ParticleRunContext {
  return {
    columns,
    random,
    slot: 0,
    count: 1,
    h: 0,
    k: 0,
    time,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
  };
}

describe("常量表（noiseTables.ts，由 noise-tables.json 生成）", () => {
  it("三张置换表、梯度表与 noise-tables.json 逐字节相同（FNV-1a 校验值来自 gen_tables.py）", () => {
    expect(tables.PERM.length).toBe(256);
    expect(tables.PERM512.length).toBe(512);
    expect(tables.PERM_MOD12.length).toBe(512);
    expect(fnv(tables.PERM)).toBe(0x368b6a25);
    expect(fnv(tables.PERM512)).toBe(0x7262dd85);
    expect(fnv(tables.PERM_MOD12)).toBe(0x7de12285);
    expect(fnv([...tables.GRAD_X, ...tables.GRAD_Y, ...tables.GRAD_Z].map(bitsOf))).toBe(0x7ecbf745);
  });

  it("结构：PERM 是 0–255 的排列，PERM512 是它重复两遍，PERM_MOD12 = PERM512 % 12，梯度表是 Gustavson grad3", () => {
    expect([...tables.PERM].sort((a, b) => a - b)).toEqual(Array.from({ length: 256 }, (_, i) => i));
    expect([...tables.PERM512]).toEqual([...tables.PERM, ...tables.PERM]);
    expect([...tables.PERM_MOD12]).toEqual([...tables.PERM512].map((value) => value % 12));
    const grad3 = [
      [1, 1, 0],
      [-1, 1, 0],
      [1, -1, 0],
      [-1, -1, 0],
      [1, 0, 1],
      [-1, 0, 1],
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, -1, 1],
      [0, 1, -1],
      [0, -1, -1],
    ];
    expect(grad3.map((g, i) => [tables.GRAD_X[i], tables.GRAD_Y[i], tables.GRAD_Z[i]])).toEqual(grad3);
  });

  it("标量常量的位模式（地址见 noiseTables.ts）", () => {
    expect(
      Object.fromEntries(
        (
          [
            "SNOISE1_SCALE",
            "F2",
            "G2",
            "G2_CORNER2",
            "SNOISE2_RADIUS",
            "SNOISE2_SCALE",
            "MINUS_TWO",
            "F3",
            "G3",
            "TWO_G3",
            "G3_CORNER3",
            "SNOISE3_RADIUS",
            "SNOISE3_SCALE",
            "PI",
            "ONE",
          ] as const
        ).map((name) => [name, bitsOf(tables[name]).toString(16)]),
      ),
    ).toEqual({
      SNOISE1_SCALE: "3eca3d71",
      F2: "3ebb67ae",
      G2: "3e58658c",
      G2_CORNER2: "3ed8658c",
      SNOISE2_RADIUS: "3f000000",
      SNOISE2_SCALE: "4234ec30",
      MINUS_TWO: "c0000000",
      F3: "3eaaaaab",
      G3: "3e2aaaab",
      TWO_G3: "3eaaaaab",
      G3_CORNER3: "3f000000",
      SNOISE3_RADIUS: "3f19999a",
      SNOISE3_SCALE: "42000000",
      PI: "40490fdb",
      ONE: "3f800000",
    });
  });
});

describe("噪声函数：WPE 真值（fixtures/noise.json）", () => {
  const worst = (rows: number[][], fn: (...args: number[]) => number) =>
    Math.max(...rows.map((row) => Math.abs(fn(...row.slice(0, -1)) - row[row.length - 1])));

  it("snoise1：turbvel 的出生方向，限 1e-5（日志 T 只有 6 位小数）", () => {
    expect(noiseFixture.snoise1.length).toBeGreaterThanOrEqual(40);
    expect(worst(noiseFixture.snoise1, snoise1)).toBeLessThanOrEqual(1e-5);
  });

  it("snoise2：posoffset-1 的出生偏移（X 是 (px·scale, T)、Y 是 (T, py·scale)），限 1e-5", () => {
    expect(noiseFixture.snoise2.length).toBeGreaterThanOrEqual(50);
    expect(worst(noiseFixture.snoise2, snoise2)).toBeLessThanOrEqual(1e-5);
  });

  it("snoise3：turb、turb-xyz（三个轴各自的参数顺序）、turb-ovr 由相邻三帧反推，限 1e-3（反推精度约 1e-4）", () => {
    expect(noiseFixture.snoise3.length).toBeGreaterThanOrEqual(150);
    expect(worst(noiseFixture.snoise3, snoise3)).toBeLessThanOrEqual(1e-3);
  });

  it("turbulentvelocityrandom：turbvel-axes（forward 1 0 0、scale 2、offset 0.5、timescale 0.5）的出生方向角，限 1e-5 rad", () => {
    const fields = fieldsOf("initializer", noiseFixture.turbvelAxes.module as JsonObject);
    let max = 0;
    for (const [time, angle] of noiseFixture.turbvelAxes.rows) {
      const columns = new ParticleColumns(1, 0);
      turbulentVelocityRandom(fields, context(columns, new ScriptedRandom([0, 0]), time));
      const ours = Math.atan2(columns.velocity[1][0], columns.velocity[0][0]);
      max = Math.max(max, Math.abs(Math.atan2(Math.sin(ours - angle), Math.cos(ours - angle))));
    }
    expect(noiseFixture.turbvelAxes.rows.length).toBeGreaterThanOrEqual(40);
    expect(max).toBeLessThanOrEqual(1e-5);
  });
});

describe("噪声函数：读码", () => {
  it("格点上为 0：snoise1 的整数、snoise2 的原点、snoise3 的 (n, n, n)", () => {
    for (let x = -5; x <= 5; x++) expect(Math.abs(snoise1(x))).toBe(0);
    expect(Math.abs(snoise2(0, 0))).toBe(0);
    for (const n of [0, 1, 2, -1]) expect(Math.abs(snoise3(n, n, n))).toBe(0);
  });

  it("snoise3 坐标相等时的顶点顺序（C3）：x0 < y0 = z0 时 i1 = j1 = k1 = 0（原版 j1 = 1），其余相等情形与原版相同", () => {
    // 值由 apps/wpe-scene/scripts/fixtures/noise_ref.py 算（同目录的 noise_equal_cases.py）；前一个括号内是原版顺序下的值
    const cases: [number, number, number, number][] = [
      [0.1, 0.3, 0.3, 0.2559826374053955], // 原版 0.24429291486740112
      [12.1, 12.5, 12.5, -0.48059701919555664], // 原版 -0.16989058256149292
      [0.3, 0.1, 0.3, 0.47009438276290894],
      [0.3, 0.3, 0.1, 0.5425504446029663],
      [0.3, 0.1, 0.1, 0.7668310403823853],
      [0.1, 0.3, 0.1, 0.7089581489562988],
      [0.1, 0.1, 0.3, 0.3689473867416382],
      [0.2, 0.2, 0.2, 0.6794772148132324],
    ];
    for (const [a, b, c, expected] of cases) expect(snoise3(f32(a), f32(b), f32(c)), `${a} ${b} ${c}`).toBe(expected);
  });
});

describe("turbulence：WPE 短程强制回放（fixtures/p4b-turb.json）", () => {
  interface Run {
    tag: string;
    passes: 1 | 2;
    frames: { frame: number; dt: number; time: number; systems: Record<string, number[][]> }[];
  }
  const systems = p4bTurb.systems as unknown as Record<string, { particle: JsonObject; instanceoverride?: unknown }>;

  /** 从第 0 帧的位置、给定速度出发，按抓帧的精确 dt / g_Time 走 `steps` 帧，返回每帧槽 0..n−1 的位置。 */
  function simulate(
    name: string,
    particle: JsonObject,
    passes: 1 | 2,
    pos: number[][],
    vel: number[][],
    steps: Run["frames"],
  ) {
    const def = parseParticle(particle, {
      file: `${name}.json`,
      orthographic: true,
      instanceoverride: systems[name].instanceoverride,
    });
    const system = new ParticleSystem(def, new SeededRandom(1), passes);
    const c = system.columns;
    pos.forEach((p, i) => {
      c.life[i] = 1000;
      c.age[i] = 1;
      for (let k = 0; k < 3; k++) {
        c.position[k][i] = f32(p[k]);
        c.velocity[k][i] = f32(vel[i][k]);
      }
    });
    system.highWater = pos.length;
    system.alive = pos.length;
    return steps.map((step) => {
      system.step(step.dt, step.time);
      return pos.map((_, i) => [0, 1, 2].map((k) => c.position[k][i]));
    });
  }

  /** 反解第 0 帧末的速度（让走一帧正好落到 WPE 第 1 帧），再走 4 帧，返回最大位置差。 */
  function forced(name: string, run: Run, particle = systems[name].particle): number {
    const F = run.frames;
    const x0 = F[0].systems[name];
    const n = x0.length;
    const x1 = F[1].systems[name].slice(0, n);
    const rate = Math.max(0.01, Number((systems[name].instanceoverride as { rate?: number } | undefined)?.rate ?? 1));
    const dt1 = f32(F[1].dt * rate);
    let v = x0.map((p, i) => [0, 1, 2].map((k) => (x1[i][k] - p[k]) / dt1));
    for (let iter = 0; iter < 8; iter++) {
      const first = simulate(name, particle, run.passes, x0, v, F.slice(1, 2))[0];
      v = v.map((vi, i) => vi.map((value, k) => value + (x1[i][k] - first[i][k]) / dt1));
    }
    const sim = simulate(name, particle, run.passes, x0, v, F.slice(1));
    let worst = 0;
    sim.forEach((frame, j) => {
      if (j === 0) return;
      const wpe = F[j + 1].systems[name];
      for (let i = 0; i < n; i++)
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(frame[i][k] - wpe[i][k]));
    });
    return worst;
  }

  for (const run of p4bTurb.runs as Run[]) {
    it(`${run.tag}（${run.passes} 遍）：turb、turb-ph5、turb-xyz、turb-ovr 走 4 帧，位置限 1e-3（坐标 > 1000 时 2e-3）`, () => {
      for (const name of Object.keys(systems)) {
        const coordinate = Math.max(...run.frames.flatMap((f) => f.systems[name].flat().map(Math.abs)));
        expect(forced(name, run), `${name}`).toBeLessThanOrEqual(coordinate > 1000 ? 2e-3 : 1e-3);
      }
      // 灵敏度：去掉 turbulence（mask 0 0 0）后必须超限，否则这项测试测不到湍流
      const particle = structuredClone(systems.turb.particle) as { operator: JsonObject[] };
      particle.operator = particle.operator.map((op) => (op.name === "turbulence" ? { ...op, mask: "0 0 0" } : op));
      expect(forced("turb", run, particle as unknown as JsonObject)).toBeGreaterThan(0.1);
    });
  }
});

describe("turbulentvelocityrandom：读码（B2）", () => {
  const base = { name: "turbulentvelocityrandom", phasemin: 0, phasemax: 1, speedmin: 100, speedmax: 200 };
  const velocityOf = (module: JsonObject, draws: number[], time: number, initial = [0, 0, 0]) => {
    const columns = new ParticleColumns(1, 0);
    for (let k = 0; k < 3; k++) columns.velocity[k][0] = initial[k];
    turbulentVelocityRandom(fieldsOf("initializer", module), context(columns, new ScriptedRandom(draws), time));
    return [0, 1, 2].map((k) => columns.velocity[k][0]);
  };

  it("先抽相位、再抽速度：t = ((u1·prange + phasemin) + T)·timescale，spd = u2·srange + speedmin", () => {
    const time = f32(3.3);
    const v = velocityOf(base, [0.25, 0.75], time);
    const angle = f32(snoise1(f32(f32(0.25) + time)) * tables.PI);
    expect(Math.hypot(...v)).toBeCloseTo(175, 3);
    // 缺省 forward 0 1 0、right 0 0 1：dir = (−sin ang, cos ang, 0)
    expect(Math.atan2(-v[0], v[1])).toBeCloseTo(angle, 6);
    expect(v[2]).toBe(0);
  });

  it("forward 不归一化、right 归一化；速度加在已有速度上", () => {
    const v = velocityOf(base, [0.5, 0], 1.7);
    expect(Math.hypot(...velocityOf({ ...base, forward: "0 2 0" }, [0.5, 0], 1.7))).toBeCloseTo(
      2 * Math.hypot(...v),
      3,
    );
    const scaled = velocityOf({ ...base, right: "0 0 5" }, [0.5, 0], 1.7);
    scaled.forEach((value, k) => expect(value).toBeCloseTo(v[k], 4));
    const added = velocityOf(base, [0.5, 0], 1.7, [1, 2, 3]);
    added.forEach((value, k) => expect(value).toBeCloseTo(v[k] + [1, 2, 3][k], 4));
  });

  it("timescale 乘 instanceoverride.rate，speedmin / max 乘 speed；系统 flags 不禁用 rate", () => {
    const fields = fieldsOf("initializer", { ...base, timescale: 2 }, { ...ONE, rate: 0.5, speed: 3 });
    expect([fields.timescale, fields.speedmin, fields.speedmax]).toEqual([1, 300, 600]);
    const instance = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 0.25 };
    expect(instanceMultipliers(instance, 0xf0).rate).toBe(0.25);
    // P4f 步骤 1：钳到 0.01 在乘数之前（`setInstance` 与加载先钳实例值并写回，rea-p4f-script.md 5.2），乘数取实例值原样
    expect(instanceMultipliers({ ...instance, rate: 0.001 }, 0).rate).toBe(0.001);
  });
});

describe("positionoffsetrandom：读码（B3）", () => {
  const module = { name: "positionoffsetrandom", scale: 0.001, distance: 100, timescale: 1, octaves: 1 };
  const offsetOf = (fields: ParticleFields, origin: number[], time: number) => {
    const columns = new ParticleColumns(1, 0);
    for (let k = 0; k < 3; k++) columns.position[k][0] = origin[k];
    positionOffsetRandom(fields, context(columns, new ScriptedRandom([]), time));
    return [0, 1, 2].map((k) => columns.position[k][0] - origin[k]);
  };

  it("Z 轴是 snoise2(pz·scale, −Ts)（时间取负），X、Y 参数顺序相反；不抽随机数", () => {
    const time = f32(2.5);
    const fields = fieldsOf("initializer", { ...module, directions: "1 1 1" });
    const offset = offsetOf(fields, [1500, 950, 500], time);
    const sx = f32(1500 * f32(0.001));
    const sy = f32(950 * f32(0.001));
    const sz = f32(500 * f32(0.001));
    const expected = [snoise2(sx, time), snoise2(time, sy), snoise2(sz, -time)];
    offset.forEach((value, k) => expect(value).toBeCloseTo(expected[k] * 100, 3));
    expect(Math.abs(snoise2(sz, time) - snoise2(sz, -time))).toBeGreaterThan(0.01);
  });

  it("octaves 解析期钳到 [1, 8]（无符号比较：0 → 1，负数 → 8）；timescale 不乘 rate", () => {
    const octaves = (value: number) =>
      readParticleModule("initializer", { ...module, octaves: value }, true).fields.octaves;
    expect([0, 1, 3, 8, 9, 100, -1].map(octaves)).toEqual([1, 1, 3, 8, 8, 8, 8]);
    expect(fieldsOf("initializer", module, { ...ONE, rate: 0.5 }).timescale).toBe(1);
  });

  it("|sign|² ≤ 1.19e-7 时不做符号处理", () => {
    const plain = offsetOf(fieldsOf("initializer", module), [1500, 950, 0], 4.25);
    expect(offsetOf(fieldsOf("initializer", { ...module, sign: "0.0001 0 0" }), [1500, 950, 0], 4.25)).toEqual(plain);
    const forced = offsetOf(fieldsOf("initializer", { ...module, sign: "0 -1 0" }), [1500, 950, 0], 4.25);
    expect(forced[1]).toBeCloseTo(-Math.abs(plain[1]), 4);
  });
});

describe("turbulence：读码（B6）", () => {
  it("mask 三轴全 0 时整条跳过；只有一轴时其余轴的速度不变", () => {
    const columns = new ParticleColumns(1, 0);
    columns.position[0][0] = 300;
    columns.position[1][0] = 200;
    columns.velocity[1][0] = 7;
    const run = (mask: string) =>
      turbulence(fieldsOf("operator", { name: "turbulence", mask, speedmin: 100, speedmax: 100 }), {
        ...context(columns, new ScriptedRandom([]), 2),
        k: 0.1,
      });
    run("0 0 0");
    expect([0, 1, 2].map((k) => columns.velocity[k][0])).toEqual([0, 7, 0]);
    run("1 0 0");
    expect(columns.velocity[0][0]).not.toBe(0);
    expect([columns.velocity[1][0], columns.velocity[2][0]]).toEqual([7, 0]);
  });

  it("blend（B6，blend 记录 0x24）：spd 再乘 b，b 同 rea-p4a 的 blend 公式；参数实质是默认值时不切到 blend 记录", () => {
    /** 一个粒子（寿命 4、给定年龄）走一遍 turbulence，返回 x 轴的速度增量。 */
    const delta = (blend: JsonObject, age: number) => {
      const columns = new ParticleColumns(1, 0);
      columns.position[0][0] = 300;
      columns.position[1][0] = 200;
      columns.age[0] = age;
      columns.life[0] = 4;
      const fields = fieldsOf("operator", {
        name: "turbulence",
        mask: "1 0 0",
        speedmin: 100,
        speedmax: 100,
        ...blend,
      });
      turbulence(fields, { ...context(columns, new ScriptedRandom([]), 2), k: 0.1 });
      return columns.velocity[0][0];
    };
    const plain = delta({}, 1);
    expect(Math.abs(plain)).toBeGreaterThan(0.01);
    // 淡入 0 → 0.5：t = age/life = 0.25 时 b = 0.25/0.5 = 0.5（乘 0.5 在 float32 下精确）；t = 0 时 b = 0；t ≥ 0.5 时 b = 1
    const fadeIn = { blendinstart: 0, blendinend: 0.5 };
    expect(delta(fadeIn, 1)).toBe(plain / 2);
    expect(delta(fadeIn, 0)).toBe(0);
    expect(delta(fadeIn, 3)).toBe(delta({}, 3));
    // 淡出 0.5 → 1：t = 0.75 时 b = (1 − 0.75)/(1 − 0.5) = 0.5
    expect(delta({ blendoutstart: 0.5, blendoutend: 1 }, 3)).toBe(delta({}, 3) / 2);
    // blendinend ≤ 0.01 且 blendoutstart ≥ 0.99：不切到 blend 记录，t = 0.0025 < blendinend 也照满速
    expect(delta({ blendinstart: 0, blendinend: 0.005 }, 0.01)).toBe(delta({}, 0.01));
  });
});

describe("能力表：三个噪声类模块的字段", () => {
  const issues = (category: ParticleCategory, module: JsonObject) => readParticleModule(category, module, true).issues;

  it("audioprocessingmode 任意值都支持（P4e 步骤 4）；向量字段写成数字报不支持；turbulentvelocityrandom 的 up WPE 不读，不报", () => {
    expect(issues("operator", { name: "turbulence", audioprocessingmode: 3 })).toEqual([]);
    expect(issues("initializer", { name: "turbulentvelocityrandom", audioprocessingbounds: "0.8 1" })).toEqual([]);
    expect(issues("initializer", { name: "turbulentvelocityrandom", forward: 1, right: 0 })).toEqual([
      { field: "forward", kind: "value" },
      { field: "right", kind: "value" },
    ]);
    expect(issues("operator", { name: "turbulence", mask: 1 })).toEqual([{ field: "mask", kind: "value" }]);
    expect(issues("initializer", { name: "positionoffsetrandom", directions: 1, sign: 0 })).toEqual([
      { field: "directions", kind: "value" },
      { field: "sign", kind: "value" },
    ]);
    expect(issues("initializer", { name: "turbulentvelocityrandom", up: "0.2 0.2 0" })).toEqual([]);
    expect(issues("initializer", { name: "positionoffsetrandom", audioprocessingmode: 1 })).toEqual([
      { field: "audioprocessingmode", kind: "unknown" },
    ]);
  });
});

describe("场景时间 T（P4b 步骤 4）", () => {
  const json = (initializers: JsonObject[], extra: JsonObject = {}): JsonObject => ({
    emitter: [{ name: "sphererandom", origin: "100 200 0", distancemin: 0, distancemax: 0, rate: 10 }],
    initializer: [
      { name: "lifetimerandom", min: 30, max: 30 },
      { name: "velocityrandom", min: "0 0 0", max: "0 0 0" },
      ...initializers,
    ],
    operator: [{ name: "movement", gravity: "0 0 0" }],
    maxcount: 64,
    ...extra,
  });
  const turbvel = { name: "turbulentvelocityrandom", phasemin: 0, phasemax: 0, speedmin: 100, speedmax: 100 };
  const posoffset = { name: "positionoffsetrandom", scale: 0.001, distance: 100, timescale: 1, octaves: 1 };
  const system = (spec: JsonObject) =>
    new ParticleSystem(parseParticle(spec, { file: "p.json", orthographic: true }), new SeededRandom(1), 1);

  it("预热时 T = 0：预热里出生的 turbulentvelocityrandom 粒子方向都是 90°（WPE 实测 rd-p4b-pre-fps60）", () => {
    // starttime 取非整数：T 若错拿成 starttime 等非 0 值，snoise1 不在整数点上、方向就不是 90°
    const s = system(json([turbvel], { starttime: 1.3 }));
    expect(Math.abs(snoise1(f32(1.3)))).toBeGreaterThan(0.01);
    s.prewarm();
    expect(s.alive).toBeGreaterThan(5);
    for (let i = 0; i < s.highWater; i++) {
      expect(s.columns.velocity[0][i]).toBe(0);
      expect(s.columns.velocity[1][i]).toBe(100);
    }
  });

  it("step(dt, time)：新粒子用本帧传进来的 T；不传时按收到的帧时间累加", () => {
    const withTime = system(json([posoffset]));
    withTime.step(0.1, 7.5);
    const expected = f32(f32(snoise2(f32(100 * f32(0.001)), f32(7.5)) * 100) + 100);
    expect(withTime.columns.position[0][0]).toBe(expected);
    const implicit = system(json([posoffset]));
    implicit.step(0.25);
    implicit.step(0.25);
    const born = [...Array(implicit.highWater).keys()].filter((i) => implicit.columns.age[i] === 0);
    expect(born.length).toBeGreaterThan(0);
    expect(implicit.columns.position[0][born[0]]).toBe(f32(f32(snoise2(f32(100 * f32(0.001)), f32(0.5)) * 100) + 100));
  });

  it("particleTrack 的 times：第 n 帧的 T 是 times[n − 1]；不给时按 dts 累加；长度不同报错", () => {
    const layers = [
      { object: 0, name: "p", particle: parseParticle(json([posoffset]), { file: "p.json", orthographic: true }) },
    ];
    const dts = [0.1, 0.1, 0.1];
    const given = particleTrack({ layers, dts, times: [3, 3.1, 3.2], frames: [3], passes: 1 });
    const manual = system(json([posoffset]));
    manual.prewarm();
    [3, 3.1, 3.2].forEach((time, i) => manual.step(dts[i], time));
    expect(given.frames[0].systems.p.map((p) => p.pos)).toEqual(
      [...Array(manual.highWater).keys()].map((i) => [0, 1, 2].map((k) => manual.columns.position[k][i])),
    );
    const implicit = particleTrack({ layers, dts, frames: [3], passes: 1 });
    const summed = particleTrack({ layers, dts, times: [0.1, 0.1 + 0.1, 0.1 + 0.1 + 0.1], frames: [3], passes: 1 });
    expect(implicit.frames).toEqual(summed.frames);
    expect(() => particleTrack({ layers, dts, times: [1, 2], frames: [3], passes: 1 })).toThrow();
  });
});
