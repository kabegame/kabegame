/**
 * P4j 步骤 3 的单测（`.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md`「步骤 3」）：`layerimage` 的发射。
 * 依据 `rea-p4j-layerimage.md` 3.2–3.10。
 * - `uniformIndex`：Lemire 乘法加拒绝（手造拒绝序列）、64 位乘法精确；
 * - 出生点公式的括号顺序（float32 非结合）；
 * - 颜色只在 `0x10000` 时乘像素；
 * - 速度用上一次取到表时的图层矩阵（第一次是单位阵）、没取到表的帧不写回；
 * - 抽取顺序与个数：每颗 下标 1、抖动 3、速率 1，再 `R`；
 * - `basis`：世界系统 `mat3(M)`、本地单位阵；
 * - 本地系统乘 `M⁻¹`。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { identity, type Mat4 } from "../render/math";
import { IDENTITY_BASIS } from "./controlpoints";
import { layerImage } from "./emitters";
import type { EmitterImageAcquired, EmitterImageSource, EmitterImageTable } from "./layerImage";
import type { ParticleRunContext } from "./modules";
import { SeededRandom, uniformIndex, type ParticleRandom } from "./random";
import { ParticleSystem } from "./system";

/** 按给定序列吐 u32 的随机源（`a()` 取同一个来源）。 */
function scripted(values: number[]): ParticleRandom & { taken: number } {
  const random = {
    taken: 0,
    u32() {
      return values[random.taken++] >>> 0;
    },
    a() {
      return (random.u32() >>> 8) * 2 ** -24;
    },
    b() {
      return random.a();
    },
  };
  return random;
}

describe("uniformIndex：MSVC uniform_int_distribution 的 Lemire 拒绝抽样（3.3）", () => {
  it("n 是 2 的幂时不拒绝：⌊u·n / 2³²⌋ 就是高位", () => {
    expect(uniformIndex(scripted([0x80000000]), 4)).toBe(2);
    expect(uniformIndex(scripted([0xffffffff]), 16)).toBe(15);
  });

  it("64 位乘法精确：u·n 的高 32 位", () => {
    // u、n 都超过 2²⁴，double 直接乘会丢低位
    expect(uniformIndex(scripted([0xfffffffe]), 0x12345678)).toBe(Number((0xfffffffen * 0x12345678n) >> 32n));
    expect(uniformIndex(scripted([0xdeadbeef]), 0x00ffffff)).toBe(Number((0xdeadbeefn * 0x00ffffffn) >> 32n));
  });

  it("低 32 位 < t 时重抽：n = 3，t = 2³² mod 3 = 1，u = 0 被拒绝", () => {
    const random = scripted([0, 0x80000000]);
    expect(uniformIndex(random, 3)).toBe(1); // 第二次 u = 2³¹：m = 3·2³¹，高位 1，低位 2³¹ ≥ n
    expect(random.taken).toBe(2);
  });

  it("低 32 位 < n 但不 < t 时接受（只有 lo < t 才重抽）", () => {
    // n = 3，u = 1431655766：m = 2³² + 2，lo = 2 < n，t = 1，lo ≥ t：接受，结果 1
    const random = scripted([1431655766]);
    expect(uniformIndex(random, 3)).toBe(1);
    expect(random.taken).toBe(1);
  });

  it("没实现 u32 的随机源退到 ⌊a()·2³²⌋", () => {
    const random: ParticleRandom = { a: () => 0.5, b: () => 0.5 };
    expect(uniformIndex(random, 4)).toBe(2);
  });

  it("SeededRandom 的 u32 与 a() 取自同一个来源", () => {
    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    const u = a.u32();
    expect(b.a()).toBe(Math.fround((u >>> 8) * 2 ** -24));
    expect(a.u32()).toBe(b.u32());
  });
});

// 直接调执行函数 ---------------------------------------------------------------------------------------------------------------------

function table(x: number[], y: number[], rgb: number[]): EmitterImageTable {
  return { count: x.length, x: Int16Array.from(x), y: Int16Array.from(y), rgb: Uint8Array.from(rgb) };
}

function context(options: {
  world: boolean;
  model?: Mat4;
  random: ParticleRandom;
  frame: ParticleRunContext["layerImage"];
}) {
  const columns = {
    position: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
    velocity: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
  };
  const m = options.model;
  const model = m
    ? new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    : new Float32Array(IDENTITY_BASIS);
  const ctx = {
    columns,
    random: options.random,
    slot: 0,
    world: options.world,
    model,
    basis: IDENTITY_BASIS,
    layerImage: options.frame,
  } as unknown as ParticleRunContext;
  return { ctx, columns };
}

const fields = (flags: number, extra: Record<string, unknown> = {}) =>
  ({ flags, offsetmin: [0, 0, 0], offsetmax: [0, 0, 0], speedmin: 1, speedmax: 1, ...extra }) as never;

describe("layerImage：出生点（3.4、3.5）", () => {
  it("括号顺序：X = tx + ((a10·py + a00·px) + a20·pz)，float32 非结合", () => {
    // 列主序：a00 = A[0]、a10 = A[4]、a20 = A[8]。(1e8 − 1e8) + 1 = 1；换成 (a00·px + a20·pz) + a10·py 会得 0
    const A = identity();
    A[0] = -1e8;
    A[4] = 1e8;
    A[8] = 1;
    const frame = { table: table([1], [-1], [0, 0, 0]), A, prev: identity(), frameDt: 0.05 };
    // 表项 (1, −1) → ix = 1、iy = 1；抖动的 z 给 1（offsetmin / max 的 z 都是 1，范围 0）
    const { ctx, columns } = context({ world: true, random: scripted([0, 0, 0, 0]), frame });
    layerImage(fields(0x80000, { offsetmin: [0, 0, 1], offsetmax: [0, 0, 1] }), ctx);
    expect(columns.position[0][0]).toBe(1);
  });

  it("y 取负、抖动加在表坐标上（早于 A）：P = A·p", () => {
    const A = identity();
    A[0] = 2;
    A[5] = 3;
    A[12] = 100;
    A[13] = 200;
    A[14] = 7;
    const frame = { table: table([10], [4], [0, 0, 0]), A, prev: identity(), frameDt: 0.05 };
    // 抖动 u = 0.5：offsetmin −2、max 2 → j = −2 + 0.5·4 = 0；iy = −4
    const { ctx, columns } = context({
      world: true,
      random: scripted([0, 0x80000000, 0x80000000, 0x80000000]),
      frame,
    });
    layerImage(fields(0x80000, { offsetmin: [-2, -2, -2], offsetmax: [2, 2, 2] }), ctx);
    expect([columns.position[0][0], columns.position[1][0], columns.position[2][0]]).toEqual([120, 188, 7]);
  });

  it("没有 0x80000 不抽抖动：只抽下标 1 个 u32", () => {
    const frame = { table: table([1], [1], [0, 0, 0]), A: identity(), prev: identity(), frameDt: 0.05 };
    const random = scripted([0, 0, 0, 0, 0]);
    const { ctx } = context({ world: true, random, frame });
    layerImage(fields(0), ctx);
    expect(random.taken).toBe(1);
  });
});

describe("layerImage：颜色（3.6）", () => {
  const frame = () => ({ table: table([0], [0], [255, 51, 0]), A: identity(), prev: identity(), frameDt: 0.05 });

  it("0x10000：colorScale = 像素 / 255（float32 除法）", () => {
    const { ctx } = context({ world: true, random: scripted([0]), frame: frame() });
    layerImage(fields(0x10000), ctx);
    expect(ctx.colorScale).toEqual([1, Math.fround(51 / 255), 0]);
  });

  it("没有 0x10000：不写 colorScale", () => {
    const { ctx } = context({ world: true, random: scripted([0]), frame: frame() });
    layerImage(fields(0x40000), ctx);
    expect(ctx.colorScale).toBeUndefined();
  });
});

describe("layerImage：M3（3.2）", () => {
  const frame = () => ({ table: table([0], [0], [0, 0, 0]), A: identity(), prev: identity(), frameDt: 0.05 });
  const model = identity();
  model[0] = 2;
  model[5] = 3;
  model[10] = 4;

  it("世界系统 mat3(M)，本地系统单位阵", () => {
    const world = context({ world: true, model, random: scripted([0]), frame: frame() });
    layerImage(fields(0), world.ctx);
    expect(Array.from(world.ctx.basis)).toEqual([2, 0, 0, 0, 3, 0, 0, 0, 4]);
    const local = context({ world: false, model, random: scripted([0]), frame: frame() });
    layerImage(fields(0), local.ctx);
    expect(Array.from(local.ctx.basis)).toEqual(Array.from(IDENTITY_BASIS));
  });
});

// 经系统 -----------------------------------------------------------------------------------------------------------------------------

function layerSystem(emitter: JsonObject, options: { world?: boolean; random?: ParticleRandom } = {}) {
  const particle = parseParticle(
    {
      maxcount: 50,
      ...(options.world ? { flags: 1 } : {}),
      emitter: [{ name: "layerimage", rate: 20, ...emitter }],
      initializer: [],
    } as JsonObject,
    { file: "p.json", orthographic: true },
  );
  particle.emitterImages = [{ id: 2, mask: "", maskTexture: null }];
  return new ParticleSystem(particle, options.random ?? new SeededRandom(1), 1);
}

/** 按调用返回给定矩阵（null 表示这一次没取到表）的来源，表固定。 */
function source(matrices: (Mat4 | null)[], t: EmitterImageTable): EmitterImageSource {
  let call = 0;
  return {
    acquire: (): EmitterImageAcquired | null => {
      const matrix = matrices[call++];
      return matrix ? { table: t, matrix } : null;
    },
    refresh: () => {},
  };
}

const translate = (x: number, y = 0, z = 0): Mat4 => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const STEP = 0.05; // rate 20 → 每帧恰好一颗
const inputs = (world: Mat4) => ({ world, pointer: [0, 0] as [number, number] });
const positionOf = (system: ParticleSystem, slot: number) => system.columns.position.map((column) => column[slot]);
const velocityOf = (system: ParticleSystem, slot: number) => system.columns.velocity.map((column) => column[slot]);

describe("ParticleSystem：layerimage 生粒子", () => {
  const t = table([0], [0], [10, 20, 30]);

  it("取到表才生：没取到的帧一颗不生、不欠账", () => {
    const system = layerSystem({ flags: 0x10000 });
    system.setEmitterImages(source([null, translate(100)], t));
    system.step(STEP);
    expect(system.alive).toBe(0);
    system.step(STEP);
    expect(system.alive).toBe(1);
    expect(positionOf(system, 0)[0]).toBe(100);
  });

  it("速度（0x40000）：用上一次取到表时的图层矩阵，第一次是单位阵；没取到表的帧不写回", () => {
    const system = layerSystem({ flags: 0x50000, speedmin: 1, speedmax: 1 });
    system.setEmitterImages(source([translate(100), null, translate(110), translate(110)], t));
    system.step(STEP);
    // 第一次取到表：prev 用单位阵，出生点 100 → 速度 100 / 0.05
    expect(velocityOf(system, 0)[0]).toBeCloseTo(100 / STEP, 3);
    system.step(STEP); // 没取到表：prevLayer 仍是 translate(100)
    system.step(STEP);
    // 110 − 100 = 10（用本帧 L 当 prev 会得 0，没写回会得 110）
    expect(velocityOf(system, 1)[0]).toBeCloseTo(10 / STEP, 3);
    system.step(STEP); // 取到表且 L 没变：速度 0
    expect(velocityOf(system, 2)[0]).toBeCloseTo(0, 6);
  });

  it("没有 0x40000：速度恒为 0（speedmin / speedmax 不起作用）", () => {
    const system = layerSystem({ flags: 0x10000, speedmin: 5, speedmax: 9 });
    system.setEmitterImages(source([translate(100)], t));
    system.step(STEP);
    expect(velocityOf(system, 0)).toEqual([0, 0, 0]);
  });

  it("颜色：0x10000 乘像素 / 255，之后是实例颜色；没有这一位是实例颜色（1）", () => {
    const withColor = layerSystem({ flags: 0x10000 });
    withColor.setEmitterImages(source([identity()], t));
    withColor.step(STEP);
    const colors = withColor.columns.color0.map((column) => column[0]);
    expect(colors).toEqual([Math.fround(10 / 255), Math.fround(20 / 255), Math.fround(30 / 255)]);
    const without = layerSystem({ flags: 0x40000 });
    without.setEmitterImages(source([identity()], t));
    without.step(STEP);
    expect(without.columns.color0.map((column) => column[0])).toEqual([1, 1, 1]);
  });

  it("本地系统出生点乘 M⁻¹：P = M⁻¹·L·p；世界系统不乘 M", () => {
    const local = layerSystem({ flags: 0x10000 });
    local.setEmitterImages(source([translate(100)], t));
    local.step(STEP, undefined, inputs(translate(30)));
    expect(positionOf(local, 0)[0]).toBe(70);
    const world = layerSystem({ flags: 0x10000 }, { world: true });
    world.setEmitterImages(source([translate(100)], t));
    world.step(STEP, undefined, inputs(translate(30)));
    expect(positionOf(world, 0)[0]).toBe(100);
  });

  it("本地系统的速度用本帧的 M⁻¹ 算 prev（粒子对象自己的移动不计入速度）", () => {
    const system = layerSystem({ flags: 0x50000, speedmin: 1, speedmax: 1 });
    system.setEmitterImages(source([translate(100), translate(100)], t));
    system.step(STEP, undefined, inputs(translate(30)));
    system.step(STEP, undefined, inputs(translate(50))); // M 变了，L 没变：prev 与 P 同用本帧的 M⁻¹ → 速度 0
    expect(velocityOf(system, 1)[0]).toBeCloseTo(0, 4);
  });

  it("每颗的抽取顺序与个数：下标 1、抖动 3、速率 1，再 R（3.10）", () => {
    const log: string[] = [];
    const random = new SeededRandom(3);
    const spy: ParticleRandom = {
      a: () => (log.push("a"), random.a()),
      b: () => (log.push("b"), random.b()),
      u32: () => (log.push("u"), random.u32()),
    };
    const system = layerSystem({ flags: 0xd0000, speedmin: 1, speedmax: 2 }, { random: spy });
    system.setEmitterImages(source([identity()], t));
    system.step(STEP);
    expect(log).toEqual(["u", "a", "a", "a", "a", "a"]);
  });

  it("抖动按 x、y、z 的顺序抽（不是 z、y、x）", () => {
    const random = scripted([0, 0x00000000, 0x80000000, 0xffffff00, 0]);
    const system = layerSystem({ flags: 0x90000, offsetmin: "0 0 0", offsetmax: "10 10 10" }, { random });
    system.setEmitterImages(source([identity()], t));
    system.step(STEP);
    const [x, y, z] = positionOf(system, 0);
    expect(x).toBe(0);
    expect(y).toBe(5);
    expect(z).toBeGreaterThan(9.99);
  });
});
