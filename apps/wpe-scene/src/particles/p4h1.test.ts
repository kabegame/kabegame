/**
 * P4h 步骤 1：operator `boids`（boids.ts）。依据 rea-p4h-boids.md 第 1–3 节与 p4-particles-REPORT.md「P4h 语义的实测核对」（实测优先于读码），
 * 用例名里带实测工程 p4h-a / p4h-b 的组名（`sep50`、`order8`、`dead`、`thr-in` 等）。
 *
 * 期望值按读码公式手算，或用本文件的独立参考实现 `reference`（float64、按槽逐粒子，写法同 `ignore/p4/h0/model.py`，不调被测函数）。
 * `rsqrtps` / `rcpps` 不复刻（P4h 决定），所以和 float32 的被测实现只比到 1e-3 量级。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { boids, boidsStride } from "./boids";
import { ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const ONE = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

function fieldsOf(module: JsonObject = {}, orthographic = true): ParticleFields {
  const reading = readParticleModule("operator", { name: "boids", ...module }, orthographic);
  expect(reading.known).toBe(true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("operator", "boids")!, reading.fields, ONE);
}

/** 槽的初值：位置、速度；`alive` 缺省为真（life = 1）。 */
interface Slot {
  p: number[];
  v?: number[];
  alive?: boolean;
}

function columnsOf(slots: Slot[]): ParticleColumns {
  const columns = new ParticleColumns(slots.length, 0);
  slots.forEach((slot, i) => {
    for (let c = 0; c < 3; c++) {
      columns.position[c][i] = slot.p[c];
      columns.velocity[c][i] = slot.v?.[c] ?? 0;
    }
    columns.life[i] = slot.alive === false ? 0 : 1;
  });
  return columns;
}

/** 跑一遍：`count` 取到 4 的倍数（带 boids 的系统的 operator 上界），`highWater` 是槽数。 */
function run(
  fields: ParticleFields,
  columns: ParticleColumns,
  highWater: number,
  extra: Partial<ParticleRunContext> = {},
): void {
  boids(fields, {
    columns,
    random: new SeededRandom(1),
    slot: 0,
    count: Math.ceil(highWater / 4) * 4,
    highWater,
    h: 0.5,
    k: 1,
    time: 0,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
    ...extra,
  });
}

const velocityOf = (columns: ParticleColumns, slot: number) => [0, 1, 2].map((c) => columns.velocity[c][slot]);

/** 只开一项系数的字段：其余系数 0，`flags 0`（不限速），阈值给足够大的缺省。 */
const only = (module: JsonObject) =>
  fieldsOf({
    separationfactor: 0,
    alignmentfactor: 0,
    cohesionfactor: 0,
    neighborthreshold: 1000,
    separationthreshold: 1000,
    flags: 0,
    ...module,
  });

/**
 * 独立参考实现（float64）：照 rea-p4h-boids.md 2.2–2.6 逐槽写，`S > 1` 的分帧相位按 2.3 的字面写法（`j` 起点用槽下标 `i`）。
 * 返回新的速度（逐槽三个分量）。
 */
function reference(
  slots: Slot[],
  params: { sepT: number; nbT: number; maxS: number; sep: number; align: number; coh: number; flags: number },
  k: number,
  frame = 0,
): number[][] {
  const hw = slots.length;
  const top = Math.ceil(hw / 4) * 4;
  const p = Array.from({ length: top }, (_, i) => [...(slots[i]?.p ?? [0, 0, 0])]);
  const v = Array.from({ length: top }, (_, i) => [...(slots[i]?.v ?? [0, 0, 0])]);
  const life = Array.from({ length: top }, (_, i) => (slots[i] && slots[i].alive !== false ? 1 : 0));
  const S = Math.floor(hw / 200) + 1;
  const sepK = S * params.sep * k;
  const alignK = S * params.align * k;
  const cohK = S * params.coh * k;
  for (let i = 4 * (frame % S); i < hw; i += 4 * S) {
    const next: number[][] = [];
    for (let l = 0; l < 4; l++) {
      const me = i + l;
      let nS = 0;
      let nN = 0;
      const sep = [0, 0, 0];
      const sV = [0, 0, 0];
      const sP = [0, 0, 0];
      for (let j = 4 * ((frame + i) % S); j < hw; j += 4 * S) {
        for (let k4 = 0; k4 < 4; k4++) {
          const o = j + ((l - k4 + 4) % 4);
          const alive = life[j + l] !== 0;
          const dv = [0, 1, 2].map((c) => p[me][c] - p[o][c]);
          const d2 = dv[1] * dv[1] + dv[0] * dv[0] + dv[2] * dv[2];
          if (d2 === 0) continue;
          const d = Math.sqrt(d2);
          if (alive && d < params.sepT) {
            nS++;
            for (let c = 0; c < 3; c++) sep[c] += (params.sepT / d - 1) * dv[c];
          }
          if (alive && d < params.nbT) {
            nN++;
            for (let c = 0; c < 3; c++) {
              sV[c] += v[o][c];
              sP[c] += p[o][c];
            }
          }
        }
      }
      const nv = [0, 1, 2].map((c) => {
        const a = nN ? (sV[c] / nN - v[me][c]) * alignK : 0;
        const s = nS ? (sep[c] / nS) * sepK : 0;
        const co = nN ? (sP[c] / nN - p[me][c]) * cohK : 0;
        return v[me][c] + (a + s + co);
      });
      if (params.flags & 1) {
        const old2 = v[me].reduce((sum, x) => sum + x * x, 0);
        const new2 = nv.reduce((sum, x) => sum + x * x, 0);
        if (new2 > Math.max(old2, params.maxS * params.maxS)) {
          const f = params.maxS / Math.sqrt(new2);
          for (let c = 0; c < 3; c++) nv[c] *= f;
        }
      }
      next.push(nv);
    }
    for (let l = 0; l < 4; l++) v[i + l] = next[l];
  }
  return v;
}

/** 四颗粒子：槽 0、1 在 `gap` 之内，槽 2、3 远在 1e5 之外（不进任何阈值）。 */
const pair = (gap: number, extra: Partial<Slot>[] = []): Slot[] => [
  { p: [1000, 0, 0], ...extra[0] },
  { p: [1000 + gap, 0, 0], ...extra[1] },
  { p: [1e5, 0, 0] },
  { p: [2e5, 0, 0] },
];

describe("解析与缺省（rea 1.2、1.3；实测 def30 / def15）", () => {
  it("正交缺省：sepT 20、nbT 50、maxspeed 500、separation 15、alignment 1、cohesion 2、flags 1", () => {
    expect(fieldsOf({})).toMatchObject({
      separationthreshold: 20,
      neighborthreshold: 50,
      maxspeed: 500,
      separationfactor: 15,
      alignmentfactor: 1,
      cohesionfactor: 2,
      flags: 1,
    });
  });

  it("透视缺省：三个阈值变成 0.02 / 0.2 / 1，系数与 flags 不变", () => {
    expect(fieldsOf({}, false)).toMatchObject({
      separationthreshold: Math.fround(0.02),
      neighborthreshold: Math.fround(0.2),
      maxspeed: 1,
      separationfactor: 15,
      alignmentfactor: 1,
      cohesionfactor: 2,
      flags: 1,
    });
  });

  it("写了的键原样取，不钳制（负数、阈值颠倒都不改）；不乘 instanceoverride.speed", () => {
    const reading = readParticleModule(
      "operator",
      { name: "boids", separationthreshold: 200, neighborthreshold: 10, alignmentfactor: -3, flags: 0 },
      true,
    );
    const fields = resolveParticleFields(particleModuleDef("operator", "boids")!, reading.fields, { ...ONE, speed: 5 });
    expect(fields).toMatchObject({ separationthreshold: 200, neighborthreshold: 10, alignmentfactor: -3, flags: 0 });
    expect(fields.maxspeed).toBe(500);
  });
});

describe("存活位缺陷与槽范围（rea 2.3、2.4；实测 sep50 / dead）", () => {
  it("sep50：两颗粒子被原点上的未出生槽推开（槽 2、3 位置 0，life 0，同 lane 的活着就算邻居）", () => {
    // 只开聚合，C = 1、k = 1，nbT 1000。槽 0 (100, 0, 0)、槽 1 (200, 0, 0)，槽 2、3 未出生（位置 0）
    const columns = columnsOf([
      { p: [100, 0, 0] },
      { p: [200, 0, 0] },
      { p: [0, 0, 0], alive: false },
      { p: [0, 0, 0], alive: false },
    ]);
    run(only({ cohesionfactor: 1 }), columns, 2);
    // 槽 0 的邻居：槽 3（k4=1）、槽 2（k4=2）、槽 1（k4=3）：均值 (0 + 0 + 200)/3，Δ = 66.667 − 100；
    // 没有缺陷的读法（只算槽 1）是 +100，符号相反
    expect(velocityOf(columns, 0)[0]).toBeCloseTo(200 / 3 - 100, 3);
    // 槽 1 的邻居：槽 0、槽 3、槽 2：均值 100/3，Δ = 33.333 − 200
    expect(velocityOf(columns, 1)[0]).toBeCloseTo(100 / 3 - 200, 3);
    // 槽 2、3 自己是死槽：同 lane 的 life[j + l] 为 0，没有邻居，速度不变（但照写，不加门）
    expect(velocityOf(columns, 2)).toEqual([0, 0, 0]);
    expect(velocityOf(columns, 3)).toEqual([0, 0, 0]);
  });

  it("dead：槽 3 死后保留的位置仍被槽 0 当邻居（同 lane 判 life[0]）", () => {
    // 槽 0、1、2 活着，槽 3 死了但留在 (500, 0, 0)；聚合：槽 0 的邻居是槽 3（k4=1）、槽 2（k4=2）、槽 1（k4=3）
    const columns = columnsOf([
      { p: [0, 0, 0] },
      { p: [100, 0, 0] },
      { p: [200, 0, 0] },
      { p: [500, 0, 0], alive: false },
    ]);
    run(only({ cohesionfactor: 1 }), columns, 4);
    expect(velocityOf(columns, 0)[0]).toBeCloseTo((500 + 200 + 100) / 3 - 0, 3);
    // 死槽自己（槽 3）：life[3] = 0，没有邻居，速度不变
    expect(velocityOf(columns, 3)[0]).toBe(0);
  });

  it("带 boids 的系统里 operator 的 count 取到 ⌈高水位/4⌉·4：未出生的槽也被 movement 积分；别的系统不变", () => {
    const make = (operators: JsonObject[]) => {
      const def = parseParticle(
        {
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 1000 }],
          initializer: [
            { name: "lifetimerandom", min: 100, max: 100 },
            { name: "sizerandom", min: 10, max: 10 },
            { name: "velocityrandom", min: "0 0 0", max: "0 0 0" },
          ],
          maxcount: 2,
          operator: operators,
        },
        { file: "t.json", orthographic: true },
      );
      const system = new ParticleSystem(def, new SeededRandom(1), 1);
      system.step(0.1);
      return system;
    };
    const gravity = { name: "movement", gravity: "0 -1000 0", drag: 0 };
    const withBoids = make([gravity, { name: "boids", separationfactor: 0, alignmentfactor: 0, cohesionfactor: 0 }]);
    expect(withBoids.highWater).toBe(2);
    // 槽 2、3 没出生：有 boids 的系统里 movement 把它们的 y 积分了（重力 −1000，h = 0.1 → v = −100，y = −10）
    expect(withBoids.columns.position[1][2]).toBeCloseTo(-10, 4);
    expect(withBoids.columns.position[1][3]).toBeCloseTo(-10, 4);
    // 没有 boids 的系统保持 count = 高水位：未出生的槽不动
    const without = make([gravity, { name: "alphafade" }]);
    expect(without.columns.position[1][2]).toBe(0);
    expect(without.columns.position[1][3]).toBe(0);
    // 出生的槽照常（出生整列重写位置与速度，不累加）：两边相同
    expect(withBoids.columns.position[1][0]).toBeCloseTo(without.columns.position[1][0], 6);
  });
});

describe("每对的计算（rea 2.4、2.5）", () => {
  it("align：平均邻居速度减自己的速度，乘 A·k，不看距离", () => {
    const columns = columnsOf(pair(50, [{ v: [10, 0, 0] }, { v: [30, 4, 0] }]));
    run(only({ alignmentfactor: 2, neighborthreshold: 100 }), columns, 4, { k: 0.1 });
    const [x, y] = velocityOf(columns, 0);
    expect(x).toBeCloseTo(10 + (30 - 10) * 0.2, 5);
    expect(y).toBeCloseTo(4 * 0.2, 5);
    expect(velocityOf(columns, 1)[0]).toBeCloseTo(30 + (10 - 30) * 0.2, 5);
  });

  it("系数乘 k、不乘 h（h = 0.5、k = 0.1 取不同值）", () => {
    const columns = columnsOf(pair(100));
    run(only({ cohesionfactor: 3, neighborthreshold: 500 }), columns, 4, { h: 0.5, k: 0.1 });
    expect(velocityOf(columns, 0)[0]).toBeCloseTo(100 * 0.3, 4);
  });

  it("coh100 / coh50：聚合与距离成正比，不归一化方向", () => {
    for (const gap of [100, 50]) {
      const columns = columnsOf(pair(gap));
      run(only({ cohesionfactor: 1, neighborthreshold: 500 }), columns, 4);
      expect(velocityOf(columns, 0)[0]).toBeCloseTo(gap, 4);
      expect(velocityOf(columns, 1)[0]).toBeCloseTo(-gap, 4);
    }
  });

  it("sep50 / sep25：分离 Δv = Sep·k·(sepT/d − 1)·(p − pj)（n 个分离邻居取平均）", () => {
    for (const [gap, weight] of [
      [50, 1],
      [25, 3],
    ]) {
      const columns = columnsOf(pair(gap));
      run(only({ separationfactor: 1, separationthreshold: 100, neighborthreshold: 1 }), columns, 4);
      expect(velocityOf(columns, 0)[0]).toBeCloseTo(-gap * weight, 3);
      expect(velocityOf(columns, 1)[0]).toBeCloseTo(gap * weight, 3);
    }
  });

  it("三项全开：和参考实现逐槽一致（有限速以外的混合）", () => {
    const slots: Slot[] = [
      { p: [100, 20, 0], v: [5, 0, 0] },
      { p: [110, 30, 0], v: [0, 7, 0] },
      { p: [130, 10, 0], v: [-3, 2, 0] },
      { p: [90, 40, 0], v: [1, 1, 0] },
      { p: [95, 25, 0], v: [0, 0, 4] },
    ];
    const columns = columnsOf(slots);
    run(
      fieldsOf({
        separationthreshold: 30,
        neighborthreshold: 60,
        flags: 0,
        alignmentfactor: 2,
        cohesionfactor: 1.5,
        separationfactor: 4,
      }),
      columns,
      5,
      { k: 0.2 },
    );
    const expected = reference(slots, { sepT: 30, nbT: 60, maxS: 500, sep: 4, align: 2, coh: 1.5, flags: 0 }, 0.2);
    for (let i = 0; i < 5; i++)
      for (let c = 0; c < 3; c++) expect(columns.velocity[c][i]).toBeCloseTo(expected[i][c], 3);
  });

  it("thr-in / thr-out / thr-eq：阈值严格 <（距离正好等于阈值不算邻居）", () => {
    const at = (gap: number, nbT: number) => {
      const columns = columnsOf(pair(gap));
      run(only({ cohesionfactor: 1, neighborthreshold: nbT }), columns, 4);
      return columns.velocity[0][0];
    };
    expect(at(149.5, 150)).toBeCloseTo(149.5, 3);
    expect(at(150.5, 150)).toBe(0);
    expect(at(150, 150)).toBe(0);
    expect(at(150, 150.5)).toBeCloseTo(150, 3);
    // 分离同样严格：d = sepT 时不进分离集合
    const columns = columnsOf(pair(100));
    run(only({ separationfactor: 1, separationthreshold: 100, neighborthreshold: 1 }), columns, 4);
    expect(columns.velocity[0][0]).toBe(0);
  });

  it("same：位置重合的两颗互不影响（d² = 0 两项都不算），自己也不算", () => {
    const columns = columnsOf([
      { p: [100, 0, 0], v: [1, 0, 0] },
      { p: [100, 0, 0], v: [9, 0, 0] },
      { p: [1e5, 0, 0] },
      { p: [2e5, 0, 0] },
    ]);
    run(
      only({
        alignmentfactor: 1,
        cohesionfactor: 1,
        separationfactor: 1,
        neighborthreshold: 50,
        separationthreshold: 50,
      }),
      columns,
      4,
    );
    expect(velocityOf(columns, 0)).toEqual([1, 0, 0]);
    expect(velocityOf(columns, 1)).toEqual([9, 0, 0]);
  });

  it("位置不改，只写速度；不读 h", () => {
    const columns = columnsOf(pair(100));
    const before = [...columns.position[0]];
    run(only({ cohesionfactor: 1, neighborthreshold: 500 }), columns, 4, { h: 123 });
    expect([...columns.position[0]]).toEqual(before);
    expect(columns.velocity[0][0]).toBeCloseTo(100, 4);
  });
});

describe("组级写回（rea 2.6、第 3 节；实测 order8）", () => {
  it("组内互相读旧值，后面的组读到前面组已写的速度（不是全快照）", () => {
    // 8 颗全活，位置 x = 10·槽号（互不重合），组 0 速度 0，组 1 速度 10；只开对齐，A = 1、k = 1，nbT 足够大
    const slots: Slot[] = Array.from({ length: 8 }, (_, i) => ({ p: [10 * i, 0, 0], v: [i < 4 ? 0 : 10, 0, 0] }));
    const columns = columnsOf(slots);
    run(only({ alignmentfactor: 1 }), columns, 8);
    // 组 0：邻居是其余 7 颗，均值 (0·3 + 10·4)/7，新速度 = 均值（A·k = 1，v 之前为 0）
    const g0 = 40 / 7;
    for (let i = 0; i < 4; i++) expect(columns.velocity[0][i]).toBeCloseTo(g0, 4);
    // 组 1 读到的是组 0 的新速度：邻居 = 组 1 其余 3 颗（10）+ 组 0 的 4 颗（g0），v' = 均值
    const g1 = (30 + 4 * g0) / 7;
    for (let i = 4; i < 8; i++) expect(columns.velocity[0][i]).toBeCloseTo(g1, 4);
    // 全快照读法（组 1 读旧速度 0）会得 30/7，和上面差得很远
    expect(Math.abs(g1 - 30 / 7)).toBeGreaterThan(1);
  });

  it("随机布局（含死槽、未出生槽）：和参考实现逐槽一致", () => {
    const random = new SeededRandom(7);
    for (const hw of [2, 5, 8, 11, 16]) {
      const slots: Slot[] = Array.from({ length: hw }, () => ({
        p: [random.a() * 120, random.a() * 120, random.a() * 40],
        v: [random.a() * 20 - 10, random.a() * 20 - 10, 0],
        alive: random.a() > 0.3,
      }));
      const columns = columnsOf(slots);
      run(fieldsOf({ neighborthreshold: 70, separationthreshold: 25, flags: 0 }), columns, hw, { k: 0.05 });
      const expected = reference(slots, { sepT: 25, nbT: 70, maxS: 500, sep: 15, align: 1, coh: 2, flags: 0 }, 0.05);
      for (let i = 0; i < hw; i++)
        for (let c = 0; c < 3; c++)
          expect(columns.velocity[c][i], `hw=${hw} 槽 ${i} 分量 ${c}`).toBeCloseTo(expected[i][c], 2);
    }
  });
});

describe("限速（rea 2.6；实测 lim-a / lim-c）", () => {
  /** 槽 0、1 互为邻居（A = 1、k = 1：新速度互换），槽 2、3 远离。 */
  const swap = (v0: number, v1: number, module: JsonObject) => {
    const columns = columnsOf(pair(50, [{ v: [v0, 0, 0] }, { v: [v1, 0, 0] }]));
    run(only({ alignmentfactor: 1, neighborthreshold: 100, maxspeed: 100, ...module }), columns, 4);
    return [columns.velocity[0][0], columns.velocity[0][1]];
  };

  it("旧速度已超过上限、新速度没有更快：不压（lim-a 的 200 → 150）；另一颗 150 → 200 压到 maxspeed", () => {
    const [a, b] = swap(200, 150, { flags: 1 });
    expect(a).toBeCloseTo(150, 3);
    // new² = 40000 > max(22500, 10000)
    expect(b).toBeCloseTo(100, 2);
  });

  it("旧速度已超过上限、新速度更快：直接压到 maxspeed（骤降）", () => {
    const [a] = swap(200, 250, { flags: 1 });
    expect(a).toBeCloseTo(100, 2);
  });

  it("旧速度低于上限、新速度超过：压到 maxspeed（lim-c 的 50 → 300）；300 → 50 不压", () => {
    const [a, b] = swap(50, 300, { flags: 1 });
    expect(a).toBeCloseTo(100, 2);
    expect(b).toBeCloseTo(50, 3);
  });

  it("flags 0 不限速", () => {
    const [a, b] = swap(50, 300, { flags: 0 });
    expect(a).toBeCloseTo(300, 3);
    expect(b).toBeCloseTo(50, 3);
  });

  it("flags 只看 bit0：2 不限速、3 限速", () => {
    expect(swap(50, 300, { flags: 2 })[0]).toBeCloseTo(300, 3);
    expect(swap(50, 300, { flags: 3 })[0]).toBeCloseTo(100, 2);
  });
});

describe("两遍模式与分帧（rea 2.2、2.7、第 3 节）", () => {
  it("系数用传入的 k：两遍模式每遍 k 减半，各跑一次（速度逐遍累加）", () => {
    const columns = columnsOf(pair(100));
    const fields = only({ cohesionfactor: 1, neighborthreshold: 500 });
    // 只调 boids（位置不动），k = 0.05：每遍 Δ = (p̄ − p)·C·k = ±5
    run(fields, columns, 4, { k: 0.05 });
    run(fields, columns, 4, { k: 0.05 });
    expect(columns.velocity[0][0]).toBeCloseTo(10, 4);
    expect(columns.velocity[0][1]).toBeCloseTo(-10, 4);
  });

  it("S = floor(hw / 200) + 1", () => {
    expect([0, 16, 199, 200, 399, 400, 1000].map(boidsStride)).toEqual([1, 1, 1, 2, 2, 3, 6]);
  });

  it("hw ≥ 200：一帧只更新 1/S 的组、每组只看 1/S 的组，系数乘 S；相位随帧计数", () => {
    const hw = 200;
    const random = new SeededRandom(3);
    const slots: Slot[] = Array.from({ length: hw }, () => ({
      p: [random.a() * 400, random.a() * 400, 0],
      v: [random.a() * 10, random.a() * 10, 0],
    }));
    const params = { sepT: 30, nbT: 120, maxS: 500, sep: 15, align: 1, coh: 2, flags: 0 };
    for (const frame of [0, 1, 2, 3]) {
      const columns = columnsOf(slots);
      run(fieldsOf({ separationthreshold: 30, neighborthreshold: 120, flags: 0 }), columns, hw, { k: 0.01, frame });
      const expected = reference(slots, params, 0.01, frame);
      for (let i = 0; i < hw; i++)
        for (let c = 0; c < 2; c++)
          expect(columns.velocity[c][i], `frame ${frame} 槽 ${i}`).toBeCloseTo(expected[i][c], 2);
      // S = 2：偶数帧更新组起点 0, 8, …，奇数帧 4, 12, …；其余组速度不变
      const start = 4 * (frame % 2);
      for (let g = 0; g < hw / 4; g++) {
        const updated = 4 * g >= start && (4 * g - start) % 8 === 0;
        if (!updated)
          for (let l = 0; l < 4; l++) expect(columns.velocity[0][4 * g + l]).toBe(Math.fround(slots[4 * g + l].v![0]));
      }
    }
  });
});
