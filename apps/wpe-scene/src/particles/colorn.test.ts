/**
 * P4b 步骤 6：`instanceoverride.colorn`（rea-p4b-render.md 7.1、7.3、7.4，计划 phase-4b-tier2.md「步骤 6」）。
 * - `fixtures/colorn.json`：独立参考实现（`apps/wpe-scene/scripts/fixtures/colorn_ref.py`，照 rea 伪代码、numpy float32、
 *   `fmod` 双精度）算出的逐位真值；
 * - 生效判断的每一条、`0x200000`（场景 `version` < 5 或没有颜色模块）、系统色的来源、两种颜色模块的平移、运行中改值从基值重算。
 * 和 WPE 抓帧的逐粒子回放是 kbp-tools 的案例 `b6`（`kbp replay b6`，案例在 `ignore/p4/cases/`）。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, particleColorSystem, sceneVersionOf, type SceneParticle } from "../compile/particles";
import { COLORN_NEAR, colornState, hsv2rgb, rgb2hsv, roundTrip5, shiftColor } from "./colorn";
import { lerp } from "./f32";
import fixture from "./fixtures/colorn.json";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;
const bits = (values: readonly number[]) => values.map((value) => (Object.is(value, -0) ? 0 : value));

/** 模拟器里的模块（只读几项，同 lifecycle.test.ts 的写法）。 */
interface Internals {
  initializers: { name: string; fields: Record<string, unknown> }[];
  operators: { name: string; fields: Record<string, unknown> }[];
  instanceColor: readonly number[];
}
const internals = (system: ParticleSystem) => system as unknown as Internals;
const colorFields = (system: ParticleSystem) => {
  const { initializers, operators, instanceColor } = internals(system);
  return {
    instanceColor: [...instanceColor],
    initializers: initializers.filter((m) => m.name === "colorrandom").map((m) => [m.fields.min, m.fields.max]),
    operators: operators.filter((m) => m.name === "colorchange").map((m) => [m.fields.startvalue, m.fields.endvalue]),
  };
};

/** 一个粒子系统：每秒 4 个（步长 0.25 时一帧一个）、不动、寿命 `life`，`modules` 加颜色模块；`instanceoverride` 与场景 `version` 另给。 */
function particle(
  modules: { initializer?: JsonObject[]; operator?: JsonObject[]; flags?: number; life?: number },
  instanceoverride: JsonObject | undefined,
  sceneVersion?: number,
): SceneParticle {
  const life = modules.life ?? 4;
  return parseParticle(
    {
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
    },
    { file: "p.json", orthographic: true, instanceoverride, sceneVersion },
  );
}
const RED_TO_GREEN = { initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }] };
const CHANGE = { operator: [{ name: "colorchange", startvalue: "1 0 0", endvalue: "0 0 1" }] };

/** 第一个存活槽的颜色当前值。 */
function colorOf(system: ParticleSystem, slot = 0): number[] {
  return [0, 1, 2].map((i) => system.columns.color[i][slot]);
}

describe("HSV 与平移：独立参考实现的逐位真值（fixtures/colorn.json）", () => {
  it("rgb2hsv：float32 逐步除法，d < 1e-5 或 mx ≤ 0 时 h = s = 0", () => {
    for (const { in: input, out } of fixture.rgb2hsv) expect(bits(rgb2hsv(input)), JSON.stringify(input)).toEqual(out);
  });

  it("hsv2rgb：两次 fmod 与 X 在双精度里算，各分量 float32", () => {
    for (const { in: input, out } of fixture.hsv2rgb)
      expect(bits(hsv2rgb(input[0], input[1], input[2])), JSON.stringify(input)).toEqual(out);
  });

  it("shiftColor：色相取小数、s / v 钳到 [0, 1]", () => {
    for (const { color, target, system, out } of fixture.shift)
      expect(bits(shiftColor(color, target, system)), JSON.stringify({ color, target, system })).toEqual(out);
  });

  it("roundTrip5：%.5f 往返", () => {
    for (const { in: input, out } of fixture.round5) expect(roundTrip5(input), String(input)).toBe(out);
  });

  it("系统色：同一组模块按参考实现（从原文算、后者覆盖前者、%.5f 往返）", () => {
    const toJson = (vector: unknown) => (Array.isArray(vector) ? vector.join(" ") : vector);
    for (const { initializers, operators, rgb, hasColor } of fixture.system) {
      const json = {
        initializer: initializers.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, toJson(v)]))),
        operator: operators.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, toJson(v)]))),
      } as JsonObject;
      const system = particleColorSystem(json, 5);
      expect(system.rgb, JSON.stringify(json)).toEqual(rgb);
      // version 5 时 0x200000 只由「没有颜色模块」置
      expect(system.instanceColor).toBe(!hasColor);
    }
  });
});

describe("HSV 与平移：逐条规则", () => {
  it("hsv2rgb 的 X 在双精度里算：s = v = 1、H < 1 时 g 正好等于 H（float32 逐步算 1 − |H − 1| 会舍入）", () => {
    const h = f32(1 / 401);
    const H = f32(h * 6);
    const [r, g, b] = hsv2rgb(h, 1, 1);
    expect([r, b]).toEqual([1, 0]);
    expect(g).toBe(H);
    // 对照：float32 逐步算得到的不是 H
    expect(f32(1 - f32(Math.abs(f32(H - 1))))).not.toBe(H);
  });

  it("色相：和为负时取模到 [0, 1)，不取模会落进「其它」分支变黑", () => {
    // colorn 红（h = 0）、系统色绿（h = 1/3）：红的 h' = −1/3 → 2/3（float32 略小于 2/3），蓝
    const [r, g, b] = shiftColor([1, 0, 0], rgb2hsv([1, 0, 0]), rgb2hsv([0, 1, 0]));
    expect([r, b]).toEqual([0, 1]);
    expect(g).toBeLessThan(1e-6);
    // 不取模时 H < 0，落进「其它」分支
    expect(hsv2rgb(f32(-1 / 3), 1, 1)).toEqual([0, 0, 0]);
    // 和 ≥ 1：B = 蓝（4/6）+ 1/3 = 1.0 → 0，红（7.4 第 3 小节）
    expect(shiftColor([0, 0, 1], rgb2hsv([0, 1, 0]), rgb2hsv([1, 0, 0]))).toEqual([1, 0, 0]);
  });

  it("s、v 钳到 [0, 1]：v 抬过 1（7.4 实验 a）、s 降到负数", () => {
    // 系统色 (0.5, 0, 0) 的 v = 0.5，colorn 绿 v = 1：蓝 v = 1.5 → 1
    expect(shiftColor([0, 0, 1], rgb2hsv([0, 1, 0]), rgb2hsv([0.5, 0, 0]))).toEqual([1, 0, 0]);
    // colorn 灰 (0.5, 0.5, 0.5)（s = 0、v = 0.5）、系统色红（s = 1、v = 1）：粉 (1, 0.5, 0.5) 的 s = 0.5 → −0.5 → 0，v → 0.5，得灰
    expect(shiftColor([1, 0.5, 0.5], rgb2hsv([0.5, 0.5, 0.5]), rgb2hsv([1, 0, 0]))).toEqual([0.5, 0.5, 0.5]);
  });

  it("roundTrip5：系统色与 color 的 ÷255 都经 %.5f，100/255 读回 0.39216", () => {
    expect(roundTrip5(f32(100 / 255))).toBe(f32(0.39216));
    expect(roundTrip5(f32(100 / 255))).not.toBe(f32(100 / 255));
    expect(roundTrip5(1)).toBe(1);
  });
});

describe("系统色与 0x200000（particleColorSystem，7.1、7.4）", () => {
  const sys = (json: JsonObject, version = 5) => particleColorSystem(json, version);

  it("没有颜色模块：(1, 1, 1)，0x200000 置（不看 version）", () => {
    for (const version of [0, 3, 5, 9]) expect(sys({}, version)).toEqual({ rgb: [1, 1, 1], instanceColor: true });
  });

  it("colorrandom：((max − min)·0.5 + min)·0.003921569，原文 0–255；后面的覆盖前面的", () => {
    expect(sys({ initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 255 0" }] }).rgb).toEqual([1, 0.5, 0]);
    expect(
      sys({
        initializer: [
          { name: "colorrandom", min: "255 255 255", max: "255 255 255" },
          { name: "sizerandom", min: 1, max: 1 },
          { name: "colorrandom", min: "0 255 0", max: "0 255 0" },
        ],
      }).rgb,
    ).toEqual([0, 1, 0]);
    // 缺省 0 0 0 / 255 255 255：中点 127.5·c，%.5f
    expect(sys({ initializer: [{ name: "colorrandom" }] }).rgb).toEqual([f32(0.5), f32(0.5), f32(0.5)]);
    // %.5f：100·c = 0.39215689 → 0.39216
    expect(sys({ initializer: [{ name: "colorrandom", min: "100 100 100", max: "100 100 100" }] }).rgb).toEqual([
      f32(0.39216),
      f32(0.39216),
      f32(0.39216),
    ]);
    // 少写的分量为 0
    expect(sys({ initializer: [{ name: "colorrandom", min: "255", max: "255" }] }).rgb).toEqual([1, 0, 0]);
  });

  it("没有颜色 initializer 时才取第一个 colorchange 的 startvalue（不 ÷255，缺省 1 1 1）", () => {
    expect(sys({ operator: [{ name: "colorchange", startvalue: "1 0 0", endvalue: "0 0 1" }] }).rgb).toEqual([1, 0, 0]);
    expect(
      sys({
        operator: [
          { name: "colorchange", startvalue: "0 0 1" },
          { name: "colorchange", startvalue: "0 1 0" },
        ],
      }).rgb,
    ).toEqual([0, 0, 1]);
    expect(sys({ operator: [{ name: "colorchange", endvalue: "0 0 1" }] })).toEqual({
      rgb: [1, 1, 1],
      instanceColor: false,
    });
    // 有 colorrandom 时不看 colorchange
    expect(
      sys({
        initializer: [{ name: "colorrandom", min: "0 255 0", max: "0 255 0" }],
        operator: [{ name: "colorchange", startvalue: "1 0 0" }],
      }).rgb,
    ).toEqual([0, 1, 0]);
  });

  it("hsvcolorrandom / colorlist 也算颜色模块（本身报不支持）", () => {
    expect(sys({ initializer: [{ name: "hsvcolorrandom" }] }).instanceColor).toBe(false);
    expect(sys({ initializer: [{ name: "colorlist" }] }).instanceColor).toBe(false);
  });

  it("有颜色模块时 0x200000 = version < 5：3、4、4.5 置，5、6 不置", () => {
    const json = { initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }] };
    for (const version of [0, 1, 3, 4, 4.5]) expect(sys(json, version).instanceColor, String(version)).toBe(true);
    for (const version of [5, 6]) expect(sys(json, version).instanceColor, String(version)).toBe(false);
  });

  it("sceneVersionOf：缺键、非数字、非有限数按 0", () => {
    expect(sceneVersionOf(5)).toBe(5);
    expect(sceneVersionOf(3)).toBe(3);
    for (const raw of [undefined, null, "5", true, Number.NaN, Infinity, {}]) expect(sceneVersionOf(raw)).toBe(0);
  });

  it("parseParticle 缺省 sceneVersion 按 0（置 0x200000）", () => {
    expect(particle(RED_TO_GREEN, undefined).colorSystem.instanceColor).toBe(true);
    expect(particle(RED_TO_GREEN, undefined, 5).colorSystem.instanceColor).toBe(false);
  });
});

describe("生效判断（colornState，7.3）", () => {
  const def = (rgb: [number, number, number], flags = 0, instanceColor = true) => ({
    colorSystem: { rgb, instanceColor },
    flags,
  });

  it("未设（null）或 r < 0：不生效，实例颜色 1，shift 原样（float32）", () => {
    for (const colorn of [null, [-1, -1, -1], [-0.5, 1, 1]]) {
      const state = colornState(def([1, 0, 0]), colorn);
      expect(state.active, JSON.stringify(colorn)).toBe(false);
      expect(state.instanceColor).toEqual([1, 1, 1]);
      expect(state.shift([0.1, 0.2, 0.3])).toEqual([f32(0.1), f32(0.2), f32(0.3)]);
    }
    // 只看 r：g、b 为负照样生效
    expect(colornState(def([1, 0, 0]), [0, -1, 0]).active).toBe(true);
  });

  it("三个分量都和系统色差 < 0.9/255 才算相同；正好等于阈值、或只有 r 接近，都生效", () => {
    expect(colornState(def([1, 0, 0]), [0.998, 0.002, 0]).active).toBe(false);
    expect(colornState(def([0, 0, 0]), [COLORN_NEAR, COLORN_NEAR, COLORN_NEAR]).active).toBe(true);
    const below = f32(COLORN_NEAR * (1 - 2 ** -20));
    expect(colornState(def([0, 0, 0]), [below, below, below]).active).toBe(false);
    expect(colornState(def([1, 0, 0]), [1, 1, 0]).active).toBe(true);
    expect(colornState(def([1, 0, 0]), [0, 0.001, 0.001]).active).toBe(true);
    expect(colornState(def([1, 0, 0]), [0.999, 0.5, 0]).active).toBe(true);
  });

  it("系统 flags bit3 禁用；其它位不影响", () => {
    expect(colornState(def([1, 0, 0], 8), [0, 1, 0]).active).toBe(false);
    expect(colornState(def([1, 0, 0], 8 | 4 | 0x10), [0, 1, 0]).active).toBe(false);
    for (const flags of [1, 2, 4, 0x10, 0x80]) expect(colornState(def([1, 0, 0], flags), [0, 1, 0]).active).toBe(true);
  });

  it("实例颜色：0x200000 且生效时是 colorn（float32），否则 1", () => {
    expect(colornState(def([1, 0, 0], 0, true), [0.1, 1, 0]).instanceColor).toEqual([f32(0.1), 1, 0]);
    expect(colornState(def([1, 0, 0], 0, false), [0.1, 1, 0]).instanceColor).toEqual([1, 1, 1]);
    expect(colornState(def([1, 0, 0], 8, true), [0.1, 1, 0]).instanceColor).toEqual([1, 1, 1]);
  });

  it("生效时按 colorn 与系统色的 HSV 差平移", () => {
    expect(colornState(def([1, 0, 0]), [0, 1, 0]).shift([1, 0, 0])).toEqual([0, 1, 0]);
  });
});

describe("模拟器：实例颜色与两种颜色模块（ParticleSystem）", () => {
  const spawn = (def: SceneParticle) => {
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    system.step(0.25);
    expect(system.alive).toBe(1);
    return system;
  };

  it("没有颜色模块：新粒子颜色就是 colorn（0x200000 由没有颜色模块置，version 5 也是）", () => {
    for (const version of [3, 5, undefined]) {
      const system = spawn(particle({}, { colorn: "0 1 0" }, version));
      expect(colorOf(system), String(version)).toEqual([0, 1, 0]);
    }
    expect(colorOf(spawn(particle({}, undefined, 5)))).toEqual([1, 1, 1]);
    // 和系统色 (1, 1, 1) 相同：不生效
    expect(colorOf(spawn(particle({}, { colorn: "1 1 1" }, 3)))).toEqual([1, 1, 1]);
  });

  it("colorrandom 单色红平移成绿：version 3 平移后再乘 colorn，结果相同（c-red-green）", () => {
    for (const version of [3, 5]) {
      const system = spawn(particle(RED_TO_GREEN, { colorn: "0 1 0" }, version));
      expect(colorOf(system), String(version)).toEqual([0, 1, 0]);
      expect(colorFields(system).initializers).toEqual([
        [
          [0, 1, 0],
          [0, 1, 0],
        ],
      ]);
    }
    // color（0–255）写法等价（c-255）
    expect(colorOf(spawn(particle(RED_TO_GREEN, { color: "0 255 0" }, 3)))).toEqual([0, 1, 0]);
  });

  it("不生效（c-near、c-flag8）：字段与不写 colorn 的系统逐项相同", () => {
    const plain = colorFields(new ParticleSystem(particle(RED_TO_GREEN, undefined, 3), new SeededRandom(1), 1));
    const near = new ParticleSystem(particle(RED_TO_GREEN, { colorn: "0.998 0.002 0" }, 3), new SeededRandom(1), 1);
    const masked = new ParticleSystem(
      particle({ ...RED_TO_GREEN, flags: 8 }, { colorn: "0 1 0" }, 3),
      new SeededRandom(1),
      1,
    );
    expect(colorFields(near)).toEqual(plain);
    expect(colorFields(masked)).toEqual(plain);
    expect(plain.instanceColor).toEqual([1, 1, 1]);
  });

  it("两个 colorrandom：系统色取后一个（绿），白不变、绿变蓝，乘积蓝（c-two）", () => {
    const def = particle(
      {
        initializer: [
          { name: "colorrandom", min: "255 255 255", max: "255 255 255" },
          { name: "colorrandom", min: "0 255 0", max: "0 255 0" },
        ],
      },
      { colorn: "0 0 1" },
      5,
    );
    expect(def.colorSystem.rgb).toEqual([0, 1, 0]);
    expect(colorOf(spawn(def))).toEqual([0, 0, 1]);
  });

  it("colorchange 两端各自平移：version 5 为 (t, 1 − t, 0)，version 3 再乘 colorn 得 (0, 1 − t, 0)（c-change，7.4）", () => {
    for (const version of [5, 3]) {
      const system = new ParticleSystem(
        particle({ ...CHANGE, life: 1 }, { colorn: "0 1 0" }, version),
        new SeededRandom(1),
        1,
      );
      expect(colorFields(system).operators).toEqual([
        [
          [0, 1, 0],
          [1, 0, 0],
        ],
      ]);
      expect(colorFields(system).instanceColor).toEqual(version === 3 ? [0, 1, 0] : [1, 1, 1]);
      system.step(0.25); // 出生，age 0
      expect(colorOf(system), `${version} t=0`).toEqual(version === 3 ? [0, 1, 0] : [0, 1, 0]);
      system.step(0.5); // age 0.5
      const t = f32(0.5);
      const lerped = [lerp(0, f32(1 - 0), t), lerp(1, f32(0 - 1), t), 0];
      expect(colorOf(system), `${version} t=0.5`).toEqual(version === 3 ? [0, lerped[1], 0] : lerped);
    }
  });

  it("7.4 实验 (b)：1 0 0 → 0 0.5 1、colorn 0 0.5 0；t = 0 时 g 在 version 3 为 0.25、version 5 为 0.5", () => {
    const json = { operator: [{ name: "colorchange", startvalue: "1 0 0", endvalue: "0 0.5 1" }], life: 1 };
    const fields = (version: number) =>
      colorFields(new ParticleSystem(particle(json, { colorn: "0 0.5 0" }, version), new SeededRandom(1), 1));
    const [[start, end]] = fields(5).operators as number[][][];
    expect(start).toEqual([0, 0.5, 0]);
    expect(end[0]).toBeCloseTo(0.5, 6);
    expect(end[1]).toBe(0);
    expect(end[2]).toBeCloseTo(0.25, 6);
    for (const [version, g] of [
      [3, 0.25],
      [5, 0.5],
    ]) {
      const system = new ParticleSystem(particle(json, { colorn: "0 0.5 0" }, version), new SeededRandom(1), 1);
      system.step(0.25);
      expect(colorOf(system)[1], String(version)).toBeCloseTo(g, 7);
    }
  });
});

describe("模拟器：运行中改 colorn（setInstance，从基值重算）", () => {
  const systems = (colorn: string | undefined, version = 5) =>
    new ParticleSystem(
      particle({ ...RED_TO_GREEN, ...CHANGE }, colorn === undefined ? undefined : { colorn }, version),
      new SeededRandom(1),
      1,
    );

  it("改两次再改回 = 直接按该值建系统；改成未设 = 没写 colorn", () => {
    for (const version of [3, 5]) {
      const live = systems("0 1 0", version);
      live.setInstance({ colorn: [0, 0, 1] });
      live.setInstance({ colorn: [1, 0, 1] });
      live.setInstance({ colorn: [0, 1, 0] });
      expect(colorFields(live), String(version)).toEqual(colorFields(systems("0 1 0", version)));
      live.setInstance({ colorn: [0, 0, 1] });
      expect(colorFields(live)).toEqual(colorFields(systems("0 0 1", version)));
      live.setInstance({ colorn: null });
      expect(colorFields(live)).toEqual(colorFields(systems(undefined, version)));
    }
  });

  it("改标量不丢平移：setInstance({ size }) 之后颜色字段仍按当前 colorn", () => {
    const live = systems("0 1 0");
    live.setInstance({ size: 2 });
    expect(colorFields(live)).toEqual(colorFields(systems("0 1 0")));
  });

  it("colorrandom 只影响之后出生的粒子；colorchange 的存活粒子下一帧跟着变（rea 7.3【推】，待补抓核对）", () => {
    // 只有 colorrandom：存活粒子保留出生时的颜色
    const random = new ParticleSystem(particle(RED_TO_GREEN, { colorn: "0 1 0" }, 5), new SeededRandom(1), 1);
    random.step(0.25);
    expect(colorOf(random, 0)).toEqual([0, 1, 0]);
    random.setInstance({ colorn: [0, 0, 1] });
    random.step(1);
    expect(colorOf(random, 0)).toEqual([0, 1, 0]);
    expect(colorOf(random, 1)).toEqual([0, 0, 1]);
    // colorchange：每遍从初值复制再乘，字段换了存活粒子也变
    const change = new ParticleSystem(
      particle({ ...CHANGE, life: 100 }, { colorn: "0 1 0" }, 5),
      new SeededRandom(1),
      1,
    );
    change.step(0.25);
    const before = colorOf(change, 0);
    change.setInstance({ colorn: null });
    change.step(0.01);
    expect(colorOf(change, 0)).not.toEqual(before);
    expect(colorOf(change, 0)[0]).toBeGreaterThan(0.99); // 回到红 → 蓝的起点附近
  });
});
