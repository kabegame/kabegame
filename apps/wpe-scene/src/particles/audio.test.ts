// P4e 步骤 4：粒子的音频系数。依据 rea-p4e-audio.md 第 1 节（取值函数）、第 2 节（字段解析）、第 5 节（作用点）。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { childLocalMatrix, parseParticle, type ParticleChildType, type SceneParticle } from "../compile/particles";
import {
  audioCoefficient,
  moduleAudio,
  parseAudioBounds,
  particleUsesAudio,
  silentParticleAudio,
  writeParticleAudio,
  type AudioParams,
  type ParticleAudio,
} from "./audio";
import { ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import { vortexV2 } from "./distance";
import { emissionCount, emitterState } from "./emitters";
import { turbulentVelocityRandom } from "./initializers";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleCategory,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { turbulence, vortex } from "./operators";
import { SeededRandom, type ParticleRandom } from "./random";
import { ParticleSystem } from "./system";
import { particleTrack } from "./track";

const f32 = Math.fround;
const ONE = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

function fieldsOf(category: ParticleCategory, module: JsonObject): ParticleFields {
  const reading = readParticleModule(category, module, true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef(category, module.name as string)!, reading.fields, ONE);
}

/** 取值参数（`bounds` 按 WPE 的规则解析、舍入成 float32）。 */
function params(bounds: string, exponent: number, mode = 1, start = 0, end = 0): AudioParams {
  const [lo, hi] = parseAudioBounds(bounds)!;
  return { mode, exponent: f32(exponent), lo: f32(lo), hi: f32(hi), start, end };
}

/** 只有左声道第 0 段是 `v` 的频谱（mode 1、频段 0–0 读的就是它）。 */
function single(v: number): ParticleAudio {
  const audio = silentParticleAudio();
  audio.left[0] = v;
  return audio;
}

/** 记录取值函数读了几次的频谱（`audioCoefficient` 每次调用读一次 `left`）。 */
class CountingAudio implements ParticleAudio {
  reads = 0;
  constructor(private readonly source: ParticleAudio) {}
  get left(): Float32Array {
    this.reads++;
    return this.source.left;
  }
  get right(): Float32Array {
    return this.source.right;
  }
}
const countingAudio = (source: ParticleAudio = silentParticleAudio()) => new CountingAudio(source);

/** 按给定序列返回 uA 的随机数（用完报错），不该抽 uB。 */
class FixedRandom implements ParticleRandom {
  constructor(private readonly values: number[]) {}
  a(): number {
    const value = this.values.shift();
    if (value === undefined) throw new Error("uA 抽多了");
    return f32(value);
  }
  b(): number {
    throw new Error("不该抽 uB");
  }
}

function context(columns: ParticleColumns, extra: Partial<ParticleRunContext> = {}): ParticleRunContext {
  return {
    columns,
    random: new SeededRandom(1),
    slot: 0,
    count: 1,
    h: 0.5,
    k: 0.1,
    time: 0.25,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
    ...extra,
  };
}

/** 槽 0 的位置、速度、随机数 R。 */
function one(position: number[], velocity: number[] = [0, 0, 0], random = 0.375): ParticleColumns {
  const columns = new ParticleColumns(4, 0);
  for (let i = 0; i < 3; i++) {
    columns.position[i][0] = position[i];
    columns.velocity[i][0] = velocity[i];
  }
  columns.random[0] = random;
  columns.age[0] = 0;
  columns.life[0] = 1;
  return columns;
}

const velocityOf = (columns: ParticleColumns) => [0, 1, 2].map((axis) => columns.velocity[axis][0]);

describe("取值函数（FUN_14022a8a0，rea 第 1 节）", () => {
  it("系数表逐格（rea 第 1 节，coef.py 在 float32 下复算，表里四位小数）", () => {
    const vs = [0, 0.25, 0.5, 0.8, 0.9, 1, 1.5];
    const table: [string, number, number[]][] = [
      ["0.8 1", 2, [0, 0, 0, 0, 0.25, 1, 1]],
      ["0 1", 1, [0, 0.1562, 0.5, 0.896, 0.972, 1, 1]],
      ["0 1", 2, [0, 0.0244, 0.25, 0.8028, 0.9448, 1, 1]],
      ["0.5 1", 2, [0, 0, 0, 0.4199, 0.8028, 1, 1]],
      ["0.9 1", 2, [0, 0, 0, 0, 0, 1, 1]],
      ["1 1", 2, [0, 0, 0, 0, 0, 1, 1]],
      ["0 2", 1, [0, 0.043, 0.1562, 0.352, 0.4252, 0.5, 0.8438]],
      ["0 2", 2, [0, 0.0018, 0.0244, 0.1239, 0.1808, 0.25, 0.7119]],
      ["0 0", 2, [1, 1, 1, 1, 1, 1, 1]],
      ["-1 1", 2, [0.25, 0.4673, 0.7119, 0.9448, 0.9856, 1, 1]],
    ];
    for (const [bounds, exponent, row] of table)
      row.forEach((expected, i) => {
        const actual = audioCoefficient(single(vs[i]), params(bounds, exponent));
        expect(Math.abs(actual - expected), `${bounds} / ${exponent} / v=${vs[i]}`).toBeLessThanOrEqual(6e-5);
        expect(actual).toBe(f32(actual));
      });
    // float32 下能精确表示的几格逐位核对
    expect(audioCoefficient(single(0.25), params("0 1", 1))).toBe(0.15625);
    expect(audioCoefficient(single(0.25), params("0 1", 2))).toBe(0.0244140625);
    expect(audioCoefficient(single(0.5), params("0 1", 2))).toBe(0.25);
    expect(audioCoefficient(single(1), params("0 2", 1))).toBe(0.5);
    expect(audioCoefficient(single(1.5), params("0 2", 1))).toBe(0.84375);
  });

  it("mode 1 左、2 右、3 是 0.5·max(L + R)（不是两边各取最大再平均），4 及以上、负数 v = 0；区间两端都含", () => {
    const audio = silentParticleAudio();
    audio.left.set([0.25, 0.75, 0.3, 0.6, 1]);
    audio.right.set([0.75, 0, 0, 0, 0]);
    const at = (mode: number, start = 0, end = 1, bounds = "0 1") =>
      audioCoefficient(audio, params(bounds, 1, mode, start, end));
    const smooth = (t: number) => f32(f32(3 - f32(t + t)) * f32(t * t));
    expect(at(1)).toBe(smooth(0.75));
    expect(at(2)).toBe(smooth(0.75));
    // L + R：1、0.75 → 最大 1，乘 0.5；分别取最大再平均是 0.75
    expect(at(3)).toBe(0.5);
    // v = 0：bounds "-1 1" 下 t = 0.5、系数 0.5（读到别的值就不是 0.5）
    for (const mode of [4, 5, -1, -3]) expect(at(mode, 0, 4, "-1 1"), String(mode)).toBe(0.5);
    // 两端都含：2–3 段读到 0.6，不读第 4 段的 1
    expect(at(1, 2, 3)).toBe(smooth(f32(0.6)));
    expect(at(1, 4, 4)).toBe(1);
  });

  it('hi = lo：v > lo 为 1、v = lo 是 NaN 当 1、v < lo 为 0；"0 0" 恒为 1', () => {
    expect(audioCoefficient(single(1.5), params("1 1", 2))).toBe(1);
    expect(audioCoefficient(single(1), params("1 1", 2))).toBe(1);
    expect(audioCoefficient(single(0.99), params("1 1", 2))).toBe(0);
    expect(audioCoefficient(single(0), params("0 0", 2))).toBe(1);
    expect(audioCoefficient(single(0.5), params("0 0", 2))).toBe(1);
  });

  it("exponent 0 恒为 1；exponent < 0 时 x = 0 得 inf → 1，x ∈ (0, 1) 得 > 1 → 1", () => {
    expect(audioCoefficient(single(0), params("0 1", 0))).toBe(1);
    expect(audioCoefficient(single(0.5), params("0 1", 0))).toBe(1);
    expect(audioCoefficient(single(0), params("0 1", -1))).toBe(1);
    expect(audioCoefficient(single(0.5), params("0 1", -1))).toBe(1);
  });

  it("没有音频（全 0）时语料参数下系数为 0（rea 4.4）", () => {
    for (const bounds of ["0 1", "0.5 1", "0.8 1", "0.9 1", "1 1"])
      for (const exponent of [0.5, 1, 2, 3])
        for (const mode of [1, 2, 3])
          expect(audioCoefficient(silentParticleAudio(), params(bounds, exponent, mode, 0, 15))).toBe(0);
  });

  it("moduleAudio：mode 0（或字段表里没有 mode）时 null（不乘），否则按频谱取值，没给频谱按全 0", () => {
    const fields = fieldsOf("operator", {
      name: "turbulence",
      audioprocessingmode: 1,
      audioprocessingbounds: "0 1",
      audioprocessingexponent: 1,
    });
    expect(moduleAudio(fields, single(0.5))).toBe(0.5);
    expect(moduleAudio(fields, undefined)).toBe(0);
    expect(moduleAudio(fieldsOf("operator", { name: "turbulence" }), single(0.5))).toBeNull();
    expect(moduleAudio({ mask: [1, 1, 1] }, single(0.5))).toBeNull();
  });
});

describe("字段解析（FUN_1401c1e20，rea 第 2 节）", () => {
  it("bounds：第一个 atof 得 lo；跳到第一个空格、跳过连续空格再读 hi；没有空格 hi = 0；数字 0 得 (0, 0)，其它非字符串 undefined", () => {
    expect(parseAudioBounds("0.8 1.0")).toEqual([0.8, 1]);
    expect(parseAudioBounds("0.5    2")).toEqual([0.5, 2]);
    expect(parseAudioBounds("1")).toEqual([1, 0]);
    expect(parseAudioBounds("")).toEqual([0, 0]);
    expect(parseAudioBounds("abc 0.5")).toEqual([0, 0.5]);
    expect(parseAudioBounds("1e1 -2.5x")).toEqual([10, -2.5]);
    expect(parseAudioBounds("inf 1")).toEqual([Infinity, 1]);
    expect(parseAudioBounds(0)).toEqual([0, 0]);
    for (const raw of [1, -0.5, true, false, [0, 1], { value: "0 1" }, null])
      expect(parseAudioBounds(raw)).toBeUndefined();
  });

  it("模拟用的字段：bounds 是 float32 的 [lo, hi]，频段钳过、交换过", () => {
    const fields = fieldsOf("emitter", {
      name: "boxrandom",
      audioprocessingmode: 3,
      audioprocessingbounds: "0.3 0.7",
      audioprocessingfrequencystart: 20,
      audioprocessingfrequencyend: 4,
    });
    expect(fields).toMatchObject({
      audioprocessingbounds: [f32(0.3), f32(0.7)],
      audioprocessingfrequencystart: 4,
      audioprocessingfrequencyend: 15,
    });
  });

  it("particleUsesAudio：任一模块（含子系统）mode ≠ 0", () => {
    const parse = (json: JsonObject): SceneParticle => parseParticle(json, { file: "p.json", orthographic: true });
    const quiet = parse({ emitter: [{ name: "sphererandom" }], operator: [{ name: "turbulence" }] });
    expect(particleUsesAudio(quiet)).toBe(false);
    expect(particleUsesAudio(parse({ operator: [{ name: "vortex", audioprocessingmode: 2 }] }))).toBe(true);
    const child = parse({ initializer: [{ name: "turbulentvelocityrandom", audioprocessingmode: -1 }] });
    quiet.children.push({
      index: 0,
      type: "static" as ParticleChildType,
      flags: 0,
      controlPointStartIndex: 0,
      probability: 1,
      maxcount: 10,
      local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
      system: child,
    });
    expect(particleUsesAudio(quiet)).toBe(true);
  });

  it("writeParticleAudio：原样写进（舍入成 float32），引用不变；不是 16 个时抛错", () => {
    const target = silentParticleAudio();
    const { left, right } = target;
    writeParticleAudio(target, { left: Array.from({ length: 16 }, (_, i) => i / 10), right: Array(16).fill(0.3) });
    expect(target.left).toBe(left);
    expect(target.right).toBe(right);
    expect(left[1]).toBe(f32(0.1));
    expect(right[15]).toBe(f32(0.3));
    expect(() => writeParticleAudio(target, { left: [1], right: Array(16).fill(0) })).toThrow("16");
  });
});

describe("作用点（rea 第 5 节）", () => {
  const emitterFields = (extra: JsonObject = {}) =>
    fieldsOf("emitter", {
      name: "sphererandom",
      rate: 100,
      audioprocessingmode: 1,
      audioprocessingbounds: "0 1",
      audioprocessingexponent: 1,
      ...extra,
    });

  it("发射器：rate·f 乘在加余数之前；f = 0 时余数原样保留、不结束，恢复后接着累积；instantaneous 不乘", () => {
    const fields = emitterFields();
    const state = emitterState(fields);
    const random = new SeededRandom(1);
    const frame = (v: number) => emissionCount(state, fields, f32(0.05), 0, 1000, random, single(v));
    // f = 0.5：100·0.5·0.05 = 2.5 → 发 2，余 0.5
    expect(frame(0.5)).toBe(2);
    expect(state.acc).toBe(0.5);
    // 静音三帧：不发，余数不动，发射器不结束（帧尾判结束读的是记录里没乘的 rate）
    for (let i = 0; i < 3; i++) expect(frame(0)).toBe(0);
    expect(state.acc).toBe(0.5);
    expect(state.ended).toBe(false);
    // 恢复：2.5 + 0.5 = 3
    expect(frame(0.5)).toBe(3);
    expect(state.acc).toBe(0);
    // instantaneous 不乘：静音时照发
    const burst = emitterFields({ instantaneous: 3 });
    expect(emissionCount(emitterState(burst), burst, f32(0.05), 0, 1000, random, single(0))).toBe(3);
    // mode 0：不取值、不乘（频谱怎样都满速）
    const plain = emitterFields({ audioprocessingmode: 0 });
    expect(emissionCount(emitterState(plain), plain, f32(0.05), 0, 1000, random, single(0))).toBe(5);
  });

  it("发射器：只有进门（存活 < 容量、没结束、delay ≤ 0）才取值", () => {
    const fields = emitterFields({ delay: 1 });
    const audio = countingAudio(single(1));
    const state = emitterState(fields);
    emissionCount(state, fields, f32(0.05), 0, 1000, new SeededRandom(1), audio);
    expect(audio.reads).toBe(0);
    emissionCount(emitterState(emitterFields()), emitterFields(), f32(0.05), 4, 4, new SeededRandom(1), audio);
    expect(audio.reads).toBe(0);
    emissionCount(emitterState(emitterFields()), emitterFields(), f32(0.05), 0, 4, new SeededRandom(1), audio);
    expect(audio.reads).toBe(1);
  });

  it("turbulentvelocityrandom：f 乘在相位范围上（等于把 phasemax − phasemin 缩成 f 倍）；f = 0 时方向与 u1 无关", () => {
    const base = { name: "turbulentvelocityrandom", phasemin: 0.125, phasemax: 1.125, speedmin: 10, speedmax: 10 };
    const audioFields = fieldsOf("initializer", {
      ...base,
      audioprocessingmode: 2,
      audioprocessingbounds: "0 1",
      audioprocessingexponent: 1,
    });
    const run = (fields: ParticleFields, u1: number, audio?: ParticleAudio) => {
      const columns = one([0, 0, 0]);
      turbulentVelocityRandom(fields, context(columns, { random: new FixedRandom([u1, 0.5]), audio }));
      return velocityOf(columns);
    };
    const right = (v: number) => {
      const audio = silentParticleAudio();
      audio.right[0] = v;
      return audio;
    };
    // f = 0.5（v = 0.5）：同 mode 0、phasemax = phasemin + 0.5
    const halved = fieldsOf("initializer", { ...base, phasemax: 0.625 });
    expect(run(audioFields, 0.75, right(0.5))).toEqual(run(halved, 0.75));
    // f = 0：u1 不影响方向（同一帧出生的粒子方向完全相同）
    expect(run(audioFields, 0.1, right(0))).toEqual(run(audioFields, 0.9, right(0)));
    expect(run(audioFields, 0.1, right(1))).not.toEqual(run(audioFields, 0.9, right(1)));
  });

  it("turbulence：f·speedmin、f·range（等于把两个速度都缩成 f 倍）；掩码全 0 时不取值", () => {
    const base = { name: "turbulence", mask: "1 1 0", speedmin: 100, speedmax: 300 };
    const audioFields = fieldsOf("operator", {
      ...base,
      audioprocessingmode: 1,
      audioprocessingbounds: "0 1",
      audioprocessingexponent: 1,
    });
    const halved = fieldsOf("operator", { ...base, speedmin: 50, speedmax: 150 });
    const run = (fields: ParticleFields, audio?: ParticleAudio) => {
      const columns = one([300, 200, 0], [1, 2, 3]);
      turbulence(fields, context(columns, { audio }));
      return velocityOf(columns);
    };
    expect(run(audioFields, single(0.5))).toEqual(run(halved));
    expect(run(audioFields, single(0))).toEqual([1, 2, 3]);
    const audio = countingAudio(single(0.5));
    run(fieldsOf("operator", { ...base, mask: "0 0 0", audioprocessingmode: 1 }), audio);
    expect(audio.reads).toBe(0);
    run(audioFields, audio);
    expect(audio.reads).toBe(1);
  });

  it("vortex：(f·speedinner)·k、(f·Δspeed)·k；vortex_v2：(speedinner·f)·k、(Δspeed·f)·k（都等于把两个速度缩成 f 倍）", () => {
    const audioKeys = { audioprocessingmode: 3, audioprocessingbounds: "0 1", audioprocessingexponent: 1 };
    // mode 3：0.5·max(L + R) = 0.5 → f = 0.5
    const audio = silentParticleAudio();
    audio.left[0] = 0.25;
    audio.right[0] = 0.75;
    for (const [name, run] of [
      ["vortex", vortex],
      ["vortex_v2", vortexV2],
    ] as const) {
      const base = { name, distanceinner: 50, distanceouter: 150, speedinner: 2500, speedouter: 500 };
      const velocity = (fields: ParticleFields, spectrum?: ParticleAudio) => {
        const columns = one([100, 20, 0], [1, 2, 3]);
        run(fields, context(columns, { audio: spectrum }));
        return velocityOf(columns);
      };
      const halved = fieldsOf("operator", { ...base, speedinner: 1250, speedouter: 250 });
      expect(velocity(fieldsOf("operator", { ...base, ...audioKeys }), audio), name).toEqual(velocity(halved));
      expect(velocity(fieldsOf("operator", { ...base, ...audioKeys }), silentParticleAudio()), name).not.toEqual(
        velocity(fieldsOf("operator", base)),
      );
    }
    // vortex 的速度项为 0 时速度不变（vortex_v2 另有 centerforce 项，缺省关着，同样不变）
    const columns = one([100, 20, 0], [1, 2, 3]);
    vortex(fieldsOf("operator", { name: "vortex", ...audioKeys }), context(columns, { audio: silentParticleAudio() }));
    expect(velocityOf(columns)).toEqual([1, 2, 3]);
  });

  it("vortex / vortex_v2 先乘 f 再乘 k（f 不是 2 的幂、k = 0.3 时和先乘 k 的舍入不同）", () => {
    // v = 0.25、bounds "0 1"、exponent 1：f = smoothstep(0.25) = 0.15625；2500·f、−2000·f 都是精确值
    const audioKeys = { audioprocessingmode: 1, audioprocessingbounds: "0 1", audioprocessingexponent: 1 };
    const k = f32(0.3);
    // 前提：先乘 k 的写法会得到不同的 float32（不然这条测不出顺序）
    expect(f32(f32(2500 * 0.15625) * k)).not.toBe(f32(f32(2500 * k) * 0.15625));
    for (const [name, run] of [
      ["vortex", vortex],
      ["vortex_v2", vortexV2],
    ] as const) {
      const base = { name, distanceinner: 50, distanceouter: 150, speedinner: 2500, speedouter: 500 };
      const velocity = (fields: ParticleFields, spectrum?: ParticleAudio) => {
        const columns = one([100, 20, 0], [1, 2, 3]);
        run(fields, context(columns, { k, audio: spectrum }));
        return velocityOf(columns);
      };
      // 等价的 mode 0：两个速度预先乘好 f（390.625、78.125，差 −312.5 都精确）
      const scaled = fieldsOf("operator", { ...base, speedinner: 390.625, speedouter: 78.125 });
      expect(velocity(fieldsOf("operator", { ...base, ...audioKeys }), single(0.25)), name).toEqual(velocity(scaled));
    }
  });
});

describe("模拟器：全树共用的频谱（ParticleSystem.setAudio）", () => {
  const parse = (json: JsonObject): SceneParticle => parseParticle(json, { file: "p.json", orthographic: true });
  const audioKeys = { audioprocessingmode: 1, audioprocessingbounds: "0 1", audioprocessingexponent: 1 };

  it("operator 两遍模式每遍各取一次（值相同）；发射器每帧一次；initializer 每个新粒子一次", () => {
    const def = () =>
      parse({
        maxcount: 64,
        emitter: [{ name: "sphererandom", distancemax: 0, rate: 60, ...audioKeys }],
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "turbulentvelocityrandom", ...audioKeys },
        ],
        operator: [{ name: "movement" }, { name: "turbulence", mask: "1 0 0", ...audioKeys }],
      });
    for (const passes of [1, 2] as const) {
      const system = new ParticleSystem(def(), new SeededRandom(1), passes);
      const audio = countingAudio(single(1));
      system.setAudio(audio);
      system.step(f32(0.05));
      // 60·1·0.05 = 3 个新粒子：发射器 1 次 + initializer 3 次 + operator 每遍 1 次
      expect(system.alive).toBe(3);
      expect(audio.reads, `passes ${passes}`).toBe(1 + 3 + passes);
    }
  });

  it("没换频谱时全 0：带音频的发射器不发；换上之后整棵树（static 子系统、之后建的事件实例）读同一份", () => {
    const loud = parse({
      maxcount: 64,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 60, ...audioKeys }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    });
    const child = parse({
      maxcount: 8,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 60 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    });
    for (const type of ["static", "eventspawn"] as ParticleChildType[])
      loud.children.push({
        index: loud.children.length,
        type,
        flags: 0,
        controlPointStartIndex: 0,
        probability: 1,
        maxcount: 4,
        local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
        system: child,
      });
    const silent = new ParticleSystem(loud, new SeededRandom(1), 1);
    silent.step(f32(0.05));
    expect(silent.alive).toBe(0);

    const system = new ParticleSystem(loud, new SeededRandom(1), 1);
    const audio = single(1);
    system.setAudio(audio);
    expect(system.audio).toBe(audio);
    expect(system.node([0])!.audio).toBe(audio);
    system.step(f32(0.05));
    expect(system.alive).toBe(3);
    const instances = system.events[0].active;
    expect(instances.length).toBeGreaterThan(0);
    for (const instance of instances) expect(instance.audio).toBe(audio);
    // 再换一份：已有的实例跟着换
    const next = silentParticleAudio();
    system.setAudio(next);
    for (const instance of instances) expect(instance.audio).toBe(next);
    expect(system.node([0])!.audio).toBe(next);
  });

  it("particleTrack 的 audio：每帧步进之前原样写进共用的频谱，null 沿用前一帧；不给时全 0；和 dts 不等长报错", () => {
    const layers = [
      {
        object: 0,
        name: "a",
        particle: parse({
          maxcount: 64,
          emitter: [{ name: "sphererandom", distancemax: 0, rate: 60, ...audioKeys }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
        }),
      },
    ];
    const dts = [f32(0.05), f32(0.05), f32(0.05)];
    const loud = { left: Array(16).fill(1), right: Array(16).fill(0) };
    const quiet = { left: Array(16).fill(0), right: Array(16).fill(0) };
    const alive = (audio?: (typeof loud | null)[]) =>
      particleTrack({ layers, dts, frames: [1, 2, 3], passes: 1, audio }).frames.map(
        (frame) => frame.systems.a?.length ?? 0,
      );
    expect(alive([loud, null, quiet])).toEqual([3, 6, 6]);
    expect(alive()).toEqual([0, 0, 0]);
    expect(() => alive([loud])).toThrow("应等长");
  });
});
