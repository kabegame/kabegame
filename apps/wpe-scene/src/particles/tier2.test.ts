// P4b 步骤 3：alpharandom 与 6 个确定性 operator。依据 rea-p4b-modules.md B1、B4、B5、B7、B8，实测见报告「P4b 语义的实测核对」。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import { alphaRandom } from "./initializers";
import {
  COLUMN_FLAGS,
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type InstanceMultipliers,
  type ParticleCategory,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { alphaChange, capVelocity, colorChange, oscillateSize, saturatePs, sizeChange, vortex } from "./operators";
import { SeededRandom, type ParticleRandom } from "./random";
import { particleColumnFlags, ParticleSystem } from "./system";

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

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

function fieldsOf(category: ParticleCategory, module: JsonObject, multipliers = ONE): ParticleFields {
  const reading = readParticleModule(category, module, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef(category, reading.name)!, reading.fields, multipliers);
}
const op = (name: string, module: JsonObject = {}, multipliers = ONE) =>
  fieldsOf("operator", { name, ...module }, multipliers);

function context(columns: ParticleColumns, extra: Partial<ParticleRunContext> = {}): ParticleRunContext {
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
    ...extra,
  };
}

/** 一个粒子的列：age / life 给定，size、颜色、alpha 的当前值与初值都是 1（size 是 `size`）。 */
function one(flags: number, age: number, life: number, size = 1): ParticleColumns {
  const columns = new ParticleColumns(4, flags);
  columns.age[0] = age;
  columns.life[0] = life;
  columns.size0[0] = size;
  columns.size[0] = size;
  columns.alpha0[0] = 1;
  columns.alpha[0] = 1;
  for (let i = 0; i < 3; i++) {
    columns.color0[i][0] = 1;
    columns.color[i][0] = 1;
  }
  return columns;
}

function particle(json: JsonObject, instanceoverride?: unknown) {
  return parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });
}

/** 静止的单粒子系统（第一帧发一个），给 operator 用。 */
function still(
  operators: JsonObject[],
  options: { initializers?: JsonObject[]; velocity?: string; life?: number } = {},
) {
  return {
    maxcount: 1,
    emitter: [{ name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1 }],
    initializer: [
      { name: "lifetimerandom", min: options.life ?? 10, max: options.life ?? 10 },
      { name: "sizerandom", min: 20, max: 20 },
      { name: "velocityrandom", min: options.velocity ?? "0 0 0", max: options.velocity ?? "0 0 0" },
      ...(options.initializers ?? []),
    ],
    operator: operators,
  } satisfies JsonObject;
}

describe("saturatePs（minps 再 maxps）", () => {
  it("钳到 [0, 1]；NaN 得 1（minps 取第二个操作数）", () => {
    expect([-1, 0, 0.25, 1, 3, -Infinity, Infinity].map(saturatePs)).toEqual([0, 0, 0.25, 1, 1, 0, 1]);
    expect(saturatePs(NaN)).toBe(1);
  });
});

describe("alpharandom（B1）", () => {
  it("乘到 alpha 初值列，不碰当前值列；t = uA，抽一次", () => {
    const columns = new ParticleColumns(4, COLUMN_FLAGS.alpha);
    columns.alpha0[0] = 0.5;
    columns.alpha[0] = 9;
    const random = new ScriptedRandom([0.5]);
    alphaRandom(fieldsOf("initializer", { name: "alpharandom", min: 0.2, max: 0.6 }), context(columns, { random }));
    expect(columns.alpha0[0]).toBe(f32(0.5 * f32(f32(0.2) + f32(0.5 * f32(f32(0.6) - f32(0.2))))));
    expect(columns.alpha[0]).toBe(9);
    expect(random.calls).toEqual(["a"]);
  });

  it("exponent ≠ 1 时 t 取幂；缺省 min 0.05、max 1", () => {
    const columns = new ParticleColumns(4, 0);
    columns.alpha0[0] = 1;
    alphaRandom(
      fieldsOf("initializer", { name: "alpharandom", min: 0, max: 1, exponent: 2 }),
      context(columns, { random: new ScriptedRandom([0.5]) }),
    );
    expect(columns.alpha0[0]).toBe(0.25);
    columns.alpha0[0] = 1;
    alphaRandom(
      fieldsOf("initializer", { name: "alpharandom" }),
      context(columns, { random: new ScriptedRandom([0]) }),
    );
    expect(columns.alpha0[0]).toBe(f32(0.05));
  });

  it("系统里：min = max = 0.4、实例 alpha 0.5 → 0.2；之后的 alphafade 乘在它上面（当前值每遍从初值复制）", () => {
    const def = particle(
      still([{ name: "alphafade", fadeintime: 0, fadeouttime: 0.5 }], {
        initializers: [{ name: "alpharandom", min: 0.4, max: 0.4 }],
        life: 1,
      }),
      { alpha: 0.5 },
    );
    const system = new ParticleSystem(def, new SeededRandom(1), 1);
    system.step(0.1);
    expect(system.columns.alpha0[0]).toBe(f32(0.4 * 0.5));
    system.step(0.65);
    // age 0.65、寿命 1：alphafade 系数 (1 − 0.65) / 0.5 = 0.7
    expect(system.columns.alpha[0]).toBeCloseTo(0.2 * 0.7, 6);
  });
});

describe("sizechange / alphachange / colorchange（B4）", () => {
  it("sizechange：t 是生命比例，starttime–endtime 之间线性，两头钳住", () => {
    const fields = op("sizechange", { startvalue: 1, endvalue: 3, starttime: 0.2, endtime: 0.8 });
    const size = (age: number) => {
      const columns = one(0, age, 2, 10);
      sizeChange(fields, context(columns));
      return columns.size[0];
    };
    expect(size(0.2)).toBe(10);
    expect(size(1)).toBeCloseTo(20, 5);
    expect(size(1.3)).toBeCloseTo(25, 4);
    expect(size(1.8)).toBe(30);
  });

  it("endtime = starttime：比例正好等于 starttime 时 0·inf = NaN，按 minps 得 1（取终值）", () => {
    const fields = op("sizechange", { startvalue: 1, endvalue: 3, starttime: 0.5, endtime: 0.5 });
    const size = (age: number) => {
      const columns = one(0, age, 2, 10);
      sizeChange(fields, context(columns));
      return columns.size[0];
    };
    expect(size(1)).toBe(30);
    expect(size(0.8)).toBe(10);
    expect(size(1.2)).toBe(30);
  });

  it("sizechange 的两个值乘 instanceoverride.size：和 sizerandom 叠用时按 size² 放大（实测 2 → 4 倍）", () => {
    expect(op("sizechange", { startvalue: 1, endvalue: 0.5 }, { ...ONE, size: 2 })).toMatchObject({
      startvalue: 2,
      endvalue: 1,
    });
    const run = (operators: JsonObject[]) => {
      const system = new ParticleSystem(particle(still(operators), { size: 2 }), new SeededRandom(1), 1);
      system.step(0.1);
      return system.columns.size[0];
    };
    expect(run([])).toBe(20);
    expect(run([{ name: "sizechange", startvalue: 1, endvalue: 1 }])).toBe(40);
    // 系统 flags bit7 禁用 size：两者都不乘
    const disabled = new ParticleSystem(
      particle({ ...still([{ name: "sizechange", startvalue: 1, endvalue: 1 }]), flags: 0x80 }, { size: 2 }),
      new SeededRandom(1),
      1,
    );
    disabled.step(0.1);
    expect(disabled.columns.size[0]).toBe(10);
  });

  it("alphachange：乘 alpha 当前值列（置 bit4），前半生命不变、后半线性降", () => {
    const fields = op("alphachange", { startvalue: 1, endvalue: 0, starttime: 0.5 });
    const alpha = (age: number) => {
      const columns = one(COLUMN_FLAGS.alpha, age, 2);
      columns.alpha0[0] = 7;
      alphaChange(fields, context(columns));
      expect(columns.alpha0[0]).toBe(7);
      return columns.alpha[0];
    };
    expect(alpha(0.5)).toBe(1);
    expect(alpha(1)).toBe(1);
    expect(alpha(1.5)).toBeCloseTo(0.5, 6);
    expect(alpha(2)).toBe(0);
    expect(particleModuleDef("operator", "alphachange")!.columnFlags).toBe(COLUMN_FLAGS.alpha);
  });

  it("colorchange：三通道共用 t，颜色是 0–1 的倍数（不 ÷255），乘颜色当前值列（置 bit3）", () => {
    const fields = op("colorchange", { startvalue: "1 0.5 0", endvalue: "0 1 1" });
    expect(fields).toMatchObject({ startvalue: [1, 0.5, 0], endvalue: [0, 1, 1] });
    const columns = one(COLUMN_FLAGS.color, 1, 2);
    columns.color[1][0] = 0.5;
    colorChange(fields, context(columns));
    expect([0, 1, 2].map((c) => columns.color[c][0])).toEqual([0.5, 0.375, 0.5]);
    expect(columns.color0[0][0]).toBe(1);
    expect(particleModuleDef("operator", "colorchange")!.columnFlags).toBe(COLUMN_FLAGS.color);
  });

  it("两遍模式结果不变：当前值每遍从初值复制", () => {
    const json = still([
      { name: "sizechange", startvalue: 1, endvalue: 3 },
      { name: "alphachange", startvalue: 1, endvalue: 0 },
      { name: "colorchange", startvalue: "1 1 1", endvalue: "0 0.5 1" },
    ]);
    const def = particle(json);
    expect(particleColumnFlags(def)).toBe(COLUMN_FLAGS.alpha | COLUMN_FLAGS.color);
    const single = new ParticleSystem(def, new SeededRandom(1), 1);
    const two = new ParticleSystem(def, new SeededRandom(1), 2);
    for (const dt of [0.1, 2, 3]) {
      single.step(dt);
      two.step(dt);
    }
    // age 5、寿命 10：t = 0.5
    expect(single.columns.size[0]).toBeCloseTo(20, 4);
    expect(single.columns.alpha[0]).toBeCloseTo(0.5, 6);
    expect(single.columns.color[1][0]).toBeCloseTo(0.75, 6);
    expect(two.columns.size[0]).toBe(single.columns.size[0]);
    expect(two.columns.alpha[0]).toBe(single.columns.alpha[0]);
    expect(two.columns.color[1][0]).toBe(single.columns.color[1][0]);
  });
});

describe("oscillatesize（B5）", () => {
  const R = 0.25;
  const fields = op("oscillatesize", {
    frequencymin: 1,
    frequencymax: 3,
    phasemin: 0,
    phasemax: 1,
    scalemin: 0.2,
    scalemax: 1,
  });
  const at = (f: ParticleFields, age: number, life = 10) => {
    const columns = one(0, age, life, 10);
    columns.random[0] = R;
    oscillateSize(f, context(columns));
    return columns.size[0];
  };

  it("ω = fmin + R·frange（不乘 2π）、τ = 相位 + age、幅度 R·(smax − smin)/2：size *= (sin(τω) + 1)·amp + smin", () => {
    const omega = 1 + R * 2;
    const tau = R * 1 + 1.5;
    const amp = R * 0.4;
    expect(at(fields, 1.5)).toBeCloseTo(10 * ((Math.sin(tau * omega) + 1) * amp + 0.2), 5);
  });

  it("幅度乘 R：R 换成 1 时幅度不同", () => {
    const columns = one(0, 1.5, 10, 10);
    columns.random[0] = 1;
    oscillateSize(fields, context(columns));
    expect(columns.size[0]).toBeCloseTo(10 * ((Math.sin(2.5 * 3) + 1) * 0.4 + 0.2), 5);
    expect(columns.size[0]).not.toBeCloseTo(at(fields, 1.5), 2);
  });

  it("有 blend：size *= ((s + 1)·amp + (smin − 1))·b + 1；b = 0 时不变", () => {
    const blended = op("oscillatesize", {
      frequencymin: 1,
      frequencymax: 3,
      phasemin: 0,
      phasemax: 1,
      scalemin: 0.2,
      scalemax: 1,
      blendinstart: 0,
      blendinend: 0.5,
    });
    // age / life = 0.125 → b = 0.25
    const wave = (Math.sin((R + 1.25) * (1 + R * 2)) + 1) * R * 0.4;
    expect(at(blended, 1.25)).toBeCloseTo(10 * ((wave + 0.2 - 1) * 0.25 + 1), 5);
    expect(at(blended, 0)).toBe(10);
  });

  it("频率不乘 instanceoverride.speed；缺省频率 1 / 10、相位 0 / 2π、幅度 0.8 / 1.2", () => {
    expect(op("oscillatesize", { frequencymin: 2, frequencymax: 4 }, { ...ONE, speed: 3 })).toMatchObject({
      frequencymin: 2,
      frequencymax: 4,
    });
    expect(op("oscillatesize")).toMatchObject({
      frequencymin: 1,
      frequencymax: 10,
      phasemin: 0,
      phasemax: f32(2 * Math.PI),
      scalemin: f32(0.8),
      scalemax: f32(1.2),
    });
  });
});

describe("vortex（B7）", () => {
  const VORTEX = { axis: "0 0 1", distanceinner: 100, distanceouter: 300, speedinner: 200, speedouter: 50 };
  const kick = (module: JsonObject, position: number[], extra: Partial<ParticleRunContext> = { h: 0.5, k: 0.1 }) => {
    const columns = new ParticleColumns(4, 0);
    for (let i = 0; i < 3; i++) columns.position[i][0] = position[i];
    vortex(op("vortex", { ...VORTEX, ...module }), context(columns, extra));
    return [0, 1, 2].map((i) => columns.velocity[i][0]);
  };

  it("球形：v += (r̂ × axis)·(t·(so − si) + si)·k；乘 k 不乘 h", () => {
    // L = 200 → t = 0.5 → spd = (0.5·(−150) + 200)·0.1 = 12.5；r̂ × z = (0, −1, 0)
    const v = kick({}, [200, 0, 0]);
    expect(v[0]).toBe(0);
    expect(v[1]).toBeCloseTo(-12.5, 5);
    expect(v[2]).toBe(0);
    expect(kick({}, [200, 0, 0], { h: 0.1, k: 0.5 })[1]).toBeCloseTo(-62.5, 4);
  });

  it("中心 = offset；t 钳在 [0, 1]：内圈以内是 speedinner，外圈以外是 speedouter", () => {
    expect(kick({ offset: "100 50 0" }, [100, 100, 0])[0]).toBeCloseTo(20, 5);
    expect(kick({}, [0, -1000, 0])[0]).toBeCloseTo(-5, 5);
  });

  it("flags bit0 柱形：去掉沿轴分量；否则球形按到中心的距离（实测：z 偏 100 时柱形与不偏相同）", () => {
    const flat = kick({}, [200, 0, 0]);
    const cylinder = kick({ flags: 1 }, [200, 0, 100]);
    expect(cylinder[1]).toBeCloseTo(flat[1], 5);
    expect(cylinder[2]).toBeCloseTo(0, 6);
    const sphere = kick({}, [200, 0, 100]);
    const length = Math.hypot(200, 100);
    const t = (length - 100) / 200;
    expect(sphere[1]).toBeCloseTo(-(200 / length) * (t * -150 + 200) * 0.1, 4);
    expect(sphere[1]).not.toBeCloseTo(flat[1], 1);
  });

  it("axis 精确归一化，|axis|² < 0.001 时取 0 0 1；inner = outer 时 rcpRange 取 1", () => {
    expect(kick({ axis: "0 0 2" }, [200, 0, 0])[1]).toBeCloseTo(-12.5, 5);
    expect(kick({ axis: "0 0.01 0.01" }, [200, 0, 0])[1]).toBeCloseTo(-12.5, 5);
    expect(kick({ axis: "0 1 0" }, [200, 0, 0])[2]).toBeCloseTo(12.5, 5);
    // inner = outer = 100：t = (100.25 − 100)·1 = 0.25 → spd = (0.25·(−150) + 200)·0.1
    expect(kick({ distanceinner: 100, distanceouter: 100 }, [100.25, 0, 0])[1]).toBeCloseTo(-16.25, 4);
  });

  it("粒子正好在中心（|r| = 0）时跳过，不写 NaN；speedinner / speedouter 乘 instanceoverride.speed", () => {
    expect(kick({}, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(op("vortex", VORTEX, { ...ONE, speed: 2 })).toMatchObject({ speedinner: 400, speedouter: 100 });
  });

  it("系统里乘的是 k：frameDt 0.1 时 k0 = 0.25^0.7·dt，切向速度只有按 h 的约 38%", () => {
    const json = {
      maxcount: 1,
      emitter: [{ name: "sphererandom", origin: "500 0 0", distancemax: 0, rate: 0, instantaneous: 1 }],
      initializer: [{ name: "lifetimerandom", min: 9, max: 9 }],
      operator: [{ name: "vortex", ...VORTEX, offset: "300 0 0" }],
    };
    const system = new ParticleSystem(particle(json), new SeededRandom(1), 1);
    system.step(0.1);
    expect(system.columns.velocity[1][0]).toBeCloseTo(-125 * Math.pow(0.25, 0.7) * 0.1, 4);
  });
});

describe("capvelocity（B8）", () => {
  const cap = (module: JsonObject, velocity: number[], age = 0, life = 1) => {
    const columns = one(0, age, life);
    for (let i = 0; i < 3; i++) columns.velocity[i][0] = velocity[i];
    capVelocity(op("capvelocity", module), context(columns));
    return [0, 1, 2].map((i) => columns.velocity[i][0]);
  };

  it("无 blend：|v| > maxspeed 时缩到 maxspeed，否则不变；v = 0 不变", () => {
    const v = cap({ maxspeed: 100 }, [300, 0, 0]);
    expect(v[0]).toBeCloseTo(100, 4);
    const w = cap({ maxspeed: 100 }, [-120, 160, 0]);
    expect(Math.hypot(...w)).toBeCloseTo(100, 4);
    expect(w[0] / w[1]).toBeCloseTo(-0.75, 6);
    expect(cap({ maxspeed: 100 }, [30, 40, 0])).toEqual([30, 40, 0]);
    expect(cap({ maxspeed: 0 }, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("有 blend：s = min(0, q − 1)·b + 1（b = 0.5 时 300 → 200）", () => {
    // age / life = 0.25，blend 0–0.5 → b = 0.5；q = 1/3 → s = 2/3
    const v = cap({ maxspeed: 100, blendinstart: 0, blendinend: 0.5 }, [300, 0, 0], 0.25, 1);
    expect(v[0]).toBeCloseTo(200, 3);
    expect(cap({ maxspeed: 100, blendinstart: 0, blendinend: 0.5 }, [80, 0, 0], 0.25, 1)).toEqual([80, 0, 0]);
  });

  it("maxspeed 没有覆盖项：instanceoverride.speed 不放大上限；缺省正交 100、透视 1", () => {
    expect(op("capvelocity", {}, { ...ONE, speed: 3 }).maxspeed).toBe(100);
    expect(readParticleModule("operator", { name: "capvelocity" }, false).fields.maxspeed).toBe(1);
  });

  it("两遍模式每遍都截；截过一次后稳定", () => {
    const def = particle(
      still([{ name: "movement" }, { name: "capvelocity", maxspeed: 100 }], { velocity: "300 0 0" }),
    );
    for (const passes of [1, 2] as const) {
      const system = new ParticleSystem(def, new SeededRandom(1), passes);
      system.step(0.1);
      expect(system.columns.velocity[0][0]).toBeCloseTo(100, 4);
      // 第一遍按 300 走，之后按 100：一遍 30，两遍 15 + 5
      expect(system.columns.position[0][0]).toBeCloseTo(passes === 1 ? 30 : 20, 3);
      system.step(0.1);
      expect(system.columns.velocity[0][0]).toBeCloseTo(100, 4);
    }
  });
});
