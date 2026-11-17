/**
 * P4g 步骤 1：`hsvcolorrandom`（initializer 4）与 `colorlist`（initializer 5）的解析、出生公式、`colorn` 重算（0xd / 0xe）。
 * 依据 rea-p4g-color.md 与 p4-particles-REPORT.md「P4g 语义的实测核对」（实测优先于读码）：每条实测对应一个用例，名字里带实测工程的组名
 * （`hsv-fixed`、`hsv-fwd`、`list-bad` 等）。
 *
 * 档位随机数（CRT `rand()`）不复刻：单元用例用脚本化的随机源逐值断言，系统用例用 `SeededRandom.hue = injectedHue([...])` / `fixedHue` 固定档位。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, particleColorSystem, type SceneParticle } from "../compile/particles";
import { ParticleColumns } from "./columns";
import { IDENTITY_BASIS, identityControlPoints } from "./controlpoints";
import { colorListHsv, colorListRgb, hsv2rgb, parseColorItem, recenterHsvRange, rgb2hsv } from "./colorn";
import { colorList, hsvColorRandom } from "./initializers";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { fixedHue, hueFromSeed, injectedHue, resetFallbackHue, SeededRandom, type ParticleRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;
const MULT = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

/** 脚本化随机源：`a()` 按序返回（用完报错），`hueRand()` 按序返回；记下各自抽了几次。 */
class Scripted implements ParticleRandom {
  aDraws = 0;
  hueDraws = 0;
  constructor(
    private readonly aValues: number[],
    private readonly hueValues: number[] = [],
  ) {}
  a(): number {
    this.aDraws++;
    const value = this.aValues.shift();
    if (value === undefined) throw new Error("a() 抽多了");
    return f32(value);
  }
  b(): number {
    throw new Error("不该抽 b()");
  }
  hueRand(): number {
    this.hueDraws++;
    const value = this.hueValues.shift();
    if (value === undefined) throw new Error("hueRand() 抽多了");
    return value;
  }
}

/** 读模块项并按模块表解析成模拟用的字段（不乘 `instanceoverride`）。 */
function fieldsOf(entry: JsonObject): ParticleFields {
  const reading = readParticleModule("initializer", entry, true);
  expect(reading.known).toBe(true);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("initializer", entry.name as string)!, reading.fields, MULT);
}

function contextOf(columns: ParticleColumns, random: ParticleRandom): ParticleRunContext {
  return {
    columns,
    random,
    slot: 0,
    count: 1,
    h: 0.5,
    k: 0.1,
    time: 0,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
  };
}

/** 直接跑一次出生：初值颜色列 (1, 1, 1)，返回乘完的 color0。 */
function birth(
  run: typeof hsvColorRandom,
  fields: ParticleFields,
  random: ParticleRandom,
  start: [number, number, number] = [1, 1, 1],
): number[] {
  const columns = new ParticleColumns(4, 0);
  for (let i = 0; i < 3; i++) columns.color0[i][0] = start[i];
  run(fields, contextOf(columns, random));
  return [0, 1, 2].map((i) => columns.color0[i][0]);
}

const hue = (color: readonly number[]) => rgb2hsv(color)[0];
const close = (actual: readonly number[], expected: readonly number[], digits = 5) =>
  expected.forEach((value, i) => expect(actual[i], `分量 ${i}`).toBeCloseTo(value, digits));

describe("hsvcolorrandom：解析与步长（rea 1.1、1.2，实测 hsv-*）", () => {
  const read = (extra: JsonObject = {}) =>
    readParticleModule("initializer", { name: "hsvcolorrandom", ...extra }, true).fields;

  it("键与缺省：huemin 0、huemax 1、huesteps 6、S / V 0.5–1（hsv-default）；全缺省时区间 0..1 是整圈，step = 1/6", () => {
    const fields = read();
    expect(fields).toMatchObject({
      huemin: 0,
      huemax: 1,
      huesteps: 6,
      steps: 6,
      saturationmin: 0.5,
      saturationmax: 1,
      valuemin: 0.5,
      valuemax: 1,
      saturationrange: 0.5,
      valuerange: 0.5,
      span: 1,
    });
    expect(fields.step).toBe(f32(1 / 6));
  });

  it("huesteps 按整数截断、取 max(0, ·)（hsv-real：2.7 按 2）", () => {
    expect(read({ huesteps: 2.7 }).steps).toBe(2);
    expect(read({ huesteps: -3 }).steps).toBe(0);
    expect(read({ huesteps: 0.9 }).steps).toBe(0);
  });

  it("huesteps ≤ 1：步长与 span 都是 0，色相恒为 huemin（hsv-fixed、hsv-steps1），不管区间", () => {
    for (const huesteps of [0, 1, -2]) {
      const fields = read({ huesteps, huemin: 0.1, huemax: 0.9 });
      expect([fields.step, fields.span], String(huesteps)).toEqual([0, 0]);
    }
    // huemin = huemax 且 s ≤ 1 同样是 0（不是 1）：0xd 重算后色相才等于 colorn 的色相（hsv-colorn-fixed，见下）
    expect(read({ huesteps: 0, huemin: 0.25, huemax: 0.25 }).span).toBe(0);
  });

  it("非整圈：step = d / (s − 1)（hsv-fwd：0–0.5、3 档 → 0.25）", () => {
    const fields = read({ huemin: 0, huemax: 0.5, huesteps: 3 });
    expect([fields.span, fields.step]).toEqual([0.5, 0.25]);
  });

  it("反向区间（语料原样）：d 为负，非整圈，step = d / 3", () => {
    const fields = read({ huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 });
    const d = f32(f32(0.60130719) - f32(0.83660131));
    expect(fields.span).toBe(d);
    expect(fields.step).toBe(f32(d / 3));
  });

  it("d = 0 且 s > 1：span 换成 1、整圈 div = s（hsv-zero-span：0.3、4 档 → 步长 0.25）", () => {
    const fields = read({ huemin: 0.3, huemax: 0.3, huesteps: 4 });
    expect([fields.span, fields.step]).toEqual([1, 0.25]);
  });

  it("整圈判断：d 离 1 的整数倍不到 1/360 算整圈（除以 s），否则除以 s − 1；负的整圈也算", () => {
    expect(read({ huemin: 0, huemax: 1.002, huesteps: 4 }).step).toBe(f32(f32(1.002) / 4));
    expect(read({ huemin: 0, huemax: 1.01, huesteps: 4 }).step).toBe(f32(f32(1.01) / 3));
    expect(read({ huemin: 1, huemax: 0, huesteps: 4 }).step).toBe(f32(-1 / 4));
  });

  it("不钳制：min > max、超出 [0, 1]、负数原样（S / V 区间可以是负的）", () => {
    const fields = read({ saturationmin: 0.8, saturationmax: 0.2, valuemin: -1, valuemax: 3, huemin: -0.2 });
    expect(fields).toMatchObject({ huemin: -0.2, saturationmin: 0.8 });
    expect(fields.saturationrange).toBe(f32(f32(0.2) - f32(0.8)));
    expect(fields.valuerange).toBe(4);
  });

  it("huesteps 写成字符串：形状不对，读出一条 value 问题（jsoncpp 会断言）", () => {
    const reading = readParticleModule("initializer", { name: "hsvcolorrandom", huesteps: "4" }, true);
    expect(reading.issues).toEqual([{ field: "huesteps", kind: "value" }]);
  });
});

describe("hsvcolorrandom：出生公式（rea 2.1，实测 hsv-*）", () => {
  const spec = (extra: JsonObject): ParticleFields => fieldsOf({ name: "hsvcolorrandom", ...extra });
  /** S = V = 1 固定，只看色相。 */
  const pure = (extra: JsonObject) => spec({ saturationmin: 1, saturationmax: 1, valuemin: 1, valuemax: 1, ...extra });
  const colorAt = (fields: ParticleFields, r: number) => birth(hsvColorRandom, fields, new Scripted([0, 0], [r]));

  it("hsv-fixed：huesteps 0、色相 0.25、S / V 固定 1 → (0.5, 1, 0)，档位随机数取什么都一样", () => {
    const fields = pure({ huesteps: 0, huemin: 0.25, huemax: 0.25 });
    for (const r of [0, 12345, 32767]) expect(colorAt(fields, r)).toEqual([0.5, 1, 0]);
  });

  it("hsv-steps1：huesteps 1、区间 0.1–0.9 → 色相恒为 0.1（不是两档）", () => {
    const fields = pure({ huesteps: 1, huemin: 0.1, huemax: 0.9 });
    const expected = hsv2rgb(f32(0.1), 1, 1);
    for (const r of [0, 20000, 32767]) expect(colorAt(fields, r)).toEqual(expected);
  });

  it("hsv-fwd：k = min(trunc(r / 32767 · (s + 1)), s)，共 s + 1 档，非整圈时最后一档越过 huemax（0 / 0.25 / 0.5 / 0.75）", () => {
    const fields = pure({ huemin: 0, huemax: 0.5, huesteps: 3 });
    const table: [number, number][] = [
      [0, 0],
      [8191, 0],
      [8192, 1],
      [16383, 1],
      [16384, 2],
      [24575, 2],
      [24576, 3],
      [32766, 3],
      [32767, 3], // r = 32767 时乘出 s + 1 = 4，被钳到 s
    ];
    for (const [r, k] of table) {
      const color = colorAt(fields, r);
      expect(color, `r = ${r}`).toEqual(hsv2rgb(f32(k * 0.25), 1, 1));
    }
  });

  it("hsv-rev（语料原样）：5 档 0.837 / 0.758 / 0.680 / 0.601 / 0.523，最后一档越过 huemax", () => {
    const fields = pure({ huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 });
    const hues = [0, 1, 2, 3, 4].map((k) => hue(colorAt(fields, Math.round((k / 5 + 0.05) * 32767))));
    close(hues, [0.8366, 0.7582, 0.6797, 0.6013, 0.5229], 3);
  });

  it("hsv-default：缺省 6 档，k = 6 的色相是 1，和 k = 0 同色（红约占 2/7）；S、V 落在 [0.5, 1]", () => {
    const fields = spec({});
    const first = birth(hsvColorRandom, fields, new Scripted([0.5, 0.5], [0]));
    const last = birth(hsvColorRandom, fields, new Scripted([0.5, 0.5], [32767]));
    // 同色相、同 S / V：红色在 k = 0 与 k = 6 各出现一次
    expect(last).toEqual(first);
    const middle = birth(hsvColorRandom, fields, new Scripted([0.5, 0.5], [32767 / 2]));
    expect(middle).not.toEqual(first);
    // S = V = 0.75：r = 最大、g = b = V − V·S
    expect(first[0]).toBeCloseTo(0.75, 6);
    expect(first[1]).toBeCloseTo(0.1875, 6);
  });

  it("hsv-zero-span：0.3、4 档 → 色相 0.3 / 0.55 / 0.8 / 0.05（1.05 回绕）/ 0.3", () => {
    const fields = pure({ huemin: 0.3, huemax: 0.3, huesteps: 4 });
    const hues = [0, 1, 2, 3, 4].map((k) => hue(colorAt(fields, Math.round((k / 5 + 0.05) * 32767))));
    close(hues, [0.3, 0.55, 0.8, 0.05, 0.3], 4);
  });

  it("hsv-neg：负色相不取模，落进 hsv2rgb 的「其它」分支得灰色 (v − v·s)；S = 1 时是黑（hsv-neg-s1）", () => {
    expect(
      birth(
        hsvColorRandom,
        spec({ huesteps: 0, huemin: -0.2, saturationmin: 0.5, saturationmax: 0.5, valuemin: 1, valuemax: 1 }),
        new Scripted([0, 0], [0]),
      ),
    ).toEqual([0.5, 0.5, 0.5]);
    expect(birth(hsvColorRandom, pure({ huesteps: 0, huemin: -0.2 }), new Scripted([0, 0], [0]))).toEqual([0, 0, 0]);
  });

  it("hsv-wrap：色相 1.25 与 0.25 同色（hsv2rgb 的 fmod(6h, 6) 回绕）", () => {
    const wrapped = birth(hsvColorRandom, pure({ huesteps: 0, huemin: 1.25 }), new Scripted([0, 0], [0]));
    const plain = birth(hsvColorRandom, pure({ huesteps: 0, huemin: 0.25 }), new Scripted([0, 0], [0]));
    close(wrapped, plain, 6);
  });

  it("hsv-sv：先抽 S 后抽 V，各一次 R，S = uA · range + min、均匀、不钳制", () => {
    const fields = spec({
      huesteps: 0,
      huemin: 0,
      saturationmin: 0.2,
      saturationmax: 0.8,
      valuemin: 0.3,
      valuemax: 0.9,
    });
    const random = new Scripted([0.25, 0.75], [0]);
    const color = birth(hsvColorRandom, fields, random);
    // 色相 0（红）：r = V、g = b = V − V·S；S = 0.2 + 0.25 · 0.6 = 0.35、V = 0.3 + 0.75 · 0.6 = 0.75
    close(color, [0.75, 0.75 - 0.75 * 0.35, 0.75 - 0.75 * 0.35], 6);
    expect([random.aDraws, random.hueDraws]).toEqual([2, 1]);
  });

  it("每粒子恒为 1 次档位随机数（s = 0 也抽）+ 2 次 R；档位随机数不占 R 的流", () => {
    const fields = spec({ huesteps: 0 });
    const random = new Scripted([0, 0, 0, 0], [0, 0]);
    birth(hsvColorRandom, fields, random);
    birth(hsvColorRandom, fields, random);
    expect([random.aDraws, random.hueDraws]).toEqual([4, 2]);
    // SeededRandom：抽档位随机数不推动 a() 的序列
    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    for (let i = 0; i < 5; i++) b.hueRand();
    expect([a.a(), a.a(), a.b()]).toEqual([b.a(), b.a(), b.b()]);
  });

  it("乘到初值颜色列上，不是覆盖（hsv-after-cr：红 × 青 = 黑）", () => {
    const cyan = pure({ huesteps: 0, huemin: 0.5, huemax: 0.5 });
    expect(birth(hsvColorRandom, cyan, new Scripted([0, 0], [0]), [1, 0, 0])).toEqual([0, 0, 0]);
    expect(birth(hsvColorRandom, cyan, new Scripted([0, 0], [0]), [0.5, 0.5, 0.5])).toEqual([0, 0.5, 0.5]);
  });
});

describe("色相随机源的注入（random.ts）", () => {
  it("injectedHue：按调用顺序返回、& 0x7fff，用完退回 fallback；fixedHue 恒定", () => {
    const next = injectedHue([0, 32767, 40000], () => 5);
    expect([next(), next(), next(), next(), next()]).toEqual([0, 32767, 40000 & 0x7fff, 5, 5]);
    const fixed = fixedHue(16384);
    expect([fixed(), fixed()]).toEqual([16384, 16384]);
  });

  it("SeededRandom：构造时或事后给 hue；缺省的流种子确定、值域 0..32767", () => {
    const injected = new SeededRandom(1, injectedHue([1, 2]));
    expect([injected.hueRand(), injected.hueRand()]).toEqual([1, 2]);
    const late = new SeededRandom(1);
    late.hue = fixedHue(9);
    expect(late.hueRand()).toBe(9);
    const x = new SeededRandom(3);
    const y = new SeededRandom(3);
    const drawn = Array.from({ length: 200 }, () => x.hueRand());
    expect(drawn).toEqual(Array.from({ length: 200 }, () => y.hueRand()));
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(32767);
    expect(hueFromSeed(1)()).toBeLessThanOrEqual(32767);
  });

  it("没有 hueRand 的随机源（手写的）退到全局缺省源，可重置成固定值", () => {
    resetFallbackHue(() => 0);
    const fields = fieldsOf({
      name: "hsvcolorrandom",
      huesteps: 3,
      huemin: 0,
      huemax: 0.5,
      saturationmin: 1,
      saturationmax: 1,
      valuemin: 1,
      valuemax: 1,
    });
    const bare: ParticleRandom = { a: () => 0, b: () => 0 };
    expect(birth(hsvColorRandom, fields, bare)).toEqual([1, 0, 0]);
    resetFallbackHue();
  });
});

describe("colorlist：解析（rea 1.3，实测 list-*）", () => {
  const read = (extra: JsonObject = {}) => readParticleModule("initializer", { name: "colorlist", ...extra }, true);
  const hsv = (rgb: number[]) => rgb2hsv(rgb);

  it("项的切法：只认空格，前三个数、不 ÷255、不钳制；切不出三个数的整项丢掉；空串是 (0, 0, 0)", () => {
    expect(parseColorItem("0 0.5 1")).toEqual([0, 0.5, 1]);
    expect(parseColorItem("255 0 0")).toEqual([255, 0, 0]);
    expect(parseColorItem("1 2 3 4")).toEqual([1, 2, 3]);
    expect(parseColorItem("1  2   3")).toEqual([1, 2, 3]);
    expect(parseColorItem("1 0")).toBeNull();
    expect(parseColorItem("1")).toBeNull();
    expect(parseColorItem("1\t0\t0")).toBeNull();
    expect(parseColorItem("")).toEqual([0, 0, 0]);
    // 第二个空格之后到串尾：atof("") 得 0
    expect(parseColorItem("1 2 ")).toEqual([1, 2, 0]);
    // atof 遇到非数字得 0
    expect(parseColorItem("a b c")).toEqual([0, 0, 0]);
  });

  it("list-bad：数组里非字符串项、切不出三个数的项丢掉，只剩绿色", () => {
    expect(colorListRgb(["1 0", 5, "0 1 0"])).toEqual([[0, 1, 0]]);
    expect(read({ colors: ["1 0", 5, "0 1 0"] }).fields.colors).toEqual(hsv([0, 1, 0]));
  });

  it("list-empty2：colors: [] 或没有有效项时补纯红 HSV (0, 1, 1)", () => {
    expect(read({ colors: [] }).fields.colors).toEqual([0, 1, 1]);
    expect(read({ colors: ["1 0", 7] }).fields.colors).toEqual([0, 1, 1]);
    expect(colorListHsv([])).toEqual([0, 1, 1]);
  });

  it('list-empty：缺 colors 键是一项白色（缺省字符串 "1 1 1"），不是补红【实测更正】', () => {
    expect(read().fields.colors).toEqual([0, 0, 1]);
    expect(colorListRgb(undefined, true)).toEqual([[1, 1, 1]]);
  });

  it("colors 写成单个字符串当一项【推】；写成数字等其它形状读出一条 value 问题", () => {
    expect(read({ colors: "0 1 0" }).fields.colors).toEqual(hsv([0, 1, 0]));
    expect(read({ colors: 5 }).issues).toEqual([{ field: "colors", kind: "value" }]);
  });

  it("list-255：255 0 0 存成 v = 255 的 HSV（不 ÷255），出生时 V 钳到 1 → 与 1 0 0 同色", () => {
    const big = read({ colors: ["255 0 0"] }).fields.colors as number[];
    expect(big).toEqual([0, 1, 255]);
    const spec = (colors: string[]) => fieldsOf({ name: "colorlist", colors });
    expect(birth(colorList, spec(["255 0 0"]), new Scripted([0, 0, 0, 0]))).toEqual(
      birth(colorList, spec(["1 0 0"]), new Scripted([0, 0, 0, 0])),
    );
  });

  it("三个 noise 缺省 0；字段只有 colors 与三个 noise", () => {
    const { fields } = read();
    expect([fields.huenoise, fields.saturationnoise, fields.valuenoise]).toEqual([0, 0, 0]);
    expect(read({ foo: 1 }).issues).toEqual([{ field: "foo", kind: "unknown" }]);
  });
});

describe("colorlist：出生公式（rea 2.2）", () => {
  const spec = (extra: JsonObject): ParticleFields => fieldsOf({ name: "colorlist", ...extra });
  /** 直接给 HSV（避开 RGB → HSV 的舍入）。 */
  const withHsv = (colors: number[], extra: Record<string, unknown> = {}): ParticleFields => ({
    ...spec({}),
    colors,
    ...extra,
  });

  it("每粒子 4 次 R，顺序：下标、H、S、V；下标 = min(trunc(unit · n), n − 1)", () => {
    const random = new Scripted([0, 0, 0, 0]);
    birth(colorList, spec({ colors: ["1 0 0", "0 1 0", "0 0 1"] }), random);
    expect(random.aDraws).toBe(4);
    expect(random.hueDraws).toBe(0); // 不用色相分档源
    // n = 1 也抽下标
    const single = new Scripted([0, 0, 0, 0]);
    birth(colorList, spec({ colors: ["1 0 0"] }), single);
    expect(single.aDraws).toBe(4);
  });

  it("list-many：三项按下标均匀挑（0 / 0.34 / 0.99 → 红 / 绿 / 蓝）", () => {
    const fields = spec({ colors: ["1 0 0", "0 1 0", "0 0 1"] });
    const pick = (unit: number) => birth(colorList, fields, new Scripted([unit, 0, 0, 0]));
    expect(pick(0)).toEqual([1, 0, 0]);
    expect(pick(0.34)).toEqual([0, 1, 0]);
    expect(pick(0.99)).toEqual([0, 0, 1]);
    // 边界：24 位 unit 乘 n 永远到不了 n，但自定义随机源返回 1 时下标仍钳到 n − 1（防越界）
    expect(pick(1)).toEqual([0, 0, 1]);
  });

  it("list-one：全部是那一个颜色（noise 0、没有平移时 H、S、V 都落在区间两端相同的点上）", () => {
    const fields = spec({ colors: ["0 0.5 1"] });
    for (const unit of [0, 0.5, 0.99])
      close(birth(colorList, fields, new Scripted([unit, unit, unit, unit])), [0, 0.5, 1], 6);
  });

  it("list-noise：区间 [max(x − n, 0), min(x + n, 1)]，下界钳到 0 不跨到 0.9 一侧；H、S、V 各抽一次", () => {
    // 色相 0、noise 0.1 → [0, 0.1]
    const hueOnly = withHsv([0, 1, 1], { huenoise: 0.1 });
    close([hue(birth(colorList, hueOnly, new Scripted([0, 0.5, 0, 0])))], [0.05], 6);
    close([hue(birth(colorList, hueOnly, new Scripted([0, 0.999, 0, 0])))], [0.0999], 3);
    // S、V ±0.2：S 0.5 → [0.3, 0.7]，V 0.5 → [0.3, 0.7]；先 H 再 S 再 V
    const fields = withHsv([0, 0.5, 0.5], { saturationnoise: 0.2, valuenoise: 0.2 });
    const color = birth(colorList, fields, new Scripted([0, 0, 0.25, 0.75]));
    // S = 0.3 + 0.25 · 0.4 = 0.4、V = 0.3 + 0.75 · 0.4 = 0.6，色相 0
    close(color, [0.6, 0.6 - 0.6 * 0.4, 0.6 - 0.6 * 0.4], 6);
    // 上界钳到 1：V 0.9 ± 0.2 → [0.7, 1]
    const high = withHsv([0, 1, 0.9], { valuenoise: 0.2 });
    close(birth(colorList, high, new Scripted([0, 0, 0, 1 - 2 ** -24])), [1, 0, 0], 6);
  });

  it("noise 为负时下界大于上界，uA 照常在两者之间", () => {
    const fields = withHsv([0, 1, 0.5], { valuenoise: -0.1 });
    // V：lo = max(0.6, 0) = 0.6、hi = min(0.4, 1) = 0.4；u = 0.5 → 0.5
    close(birth(colorList, fields, new Scripted([0, 0, 0, 0.5])), [0.5, 0, 0], 6);
  });

  it("平移：加上之后色相取小数、S / V 钳到 [0, 1]（list-colorn 的出生半边）", () => {
    // 色相 0.75 + 0.5 → 1.25 → 0.25；S 0.5 + 0.8 → 钳 1；V 0.5 − 0.9 → 钳 0
    const shifted = withHsv([0.75, 0.5, 0.5], { shift: [0.5, 0.8, -0.9] });
    expect(birth(colorList, shifted, new Scripted([0, 0, 0, 0]))).toEqual([0, 0, 0]);
    const wrap = withHsv([0.75, 1, 1], { shift: [0.5, 0, 0] });
    close(birth(colorList, wrap, new Scripted([0, 0, 0, 0])), hsv2rgb(0.25, 1, 1), 6);
    // 负的平移：色相 0.1 − 0.3 = −0.2 → 0.8
    const negative = withHsv([0.1, 1, 1], { shift: [-0.3, 0, 0] });
    close([hue(birth(colorList, negative, new Scripted([0, 0, 0, 0])))], [0.8], 5);
  });
});

describe("0xd 重算（hsvcolorrandom 遇到 colorn，rea 3.2，hsv-colorn*）", () => {
  const COLORN = [0.50196, 0, 0.50196];
  const centered = (extra: JsonObject, colorn: number[] | null) => {
    const reading = readParticleModule("initializer", { name: "hsvcolorrandom", ...extra }, true).fields;
    return recenterHsvRange(
      {
        huemin: reading.huemin as number,
        span: reading.span as number,
        saturationmin: reading.saturationmin as number,
        saturationrange: reading.saturationrange as number,
        valuemin: reading.valuemin as number,
        valuerange: reading.valuerange as number,
      },
      colorn ? rgb2hsv(colorn) : null,
    );
  };

  it("语料 + colorn 紫：huemin' = hc − span/2 = 0.951；S ∈ [0.75, 1]（range 截成 0.25）；V ∈ [0.252, 0.752]", () => {
    const out = centered({ huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 }, COLORN);
    expect(out.huemin).toBeCloseTo(0.95098, 4);
    expect(out.saturationmin).toBeCloseTo(0.75, 6);
    expect(out.saturationrange).toBeCloseTo(0.25, 6);
    expect(out.valuemin).toBeCloseTo(0.25196, 5);
    expect(out.valuerange).toBeCloseTo(0.5, 6);
  });

  it("不生效（colorn 为 null）：原样写回基值", () => {
    const base = { huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 };
    const out = centered(base, null);
    expect(out.huemin).toBeCloseTo(0.83660131, 7);
    expect(out.saturationmin).toBe(0.5);
    expect(out.saturationrange).toBe(0.5);
  });

  it("hsv-colorn-fixed：huesteps 0、huemin = huemax = 0.25 → span 0，huemin' = colorn 的色相 0.8333（不偏半圈）", () => {
    const out = centered(
      { huesteps: 0, huemin: 0.25, huemax: 0.25, saturationmin: 0.5, saturationmax: 0.5, valuemin: 0.5, valuemax: 0.5 },
      COLORN,
    );
    expect(out.span).toBe(0);
    expect(out.huemin).toBeCloseTo(0.83333, 4);
  });

  it("hsv-colorn-neg：huemin 0、huemax 0.4、2 档，colorn 红（hc = 0）→ huemin' = −0.2（负色相，出生时是灰）", () => {
    const out = centered({ huemin: 0, huemax: 0.4, huesteps: 2 }, [1, 0, 0]);
    expect(out.huemin).toBeCloseTo(-0.2, 6);
  });

  it("S / V：min 居中后钳 [0, 1]；超出 1 时截短 range，没超时 range 不变", () => {
    const wide = centered({ saturationmin: 0, saturationmax: 0.4 }, hsv2rgb(0, 0.1, 0.5));
    // 中心 0.2 → 搬到 0.1：min = 0.1 − 0.2 + 0 = −0.1 → 钳到 0，range 0.4 不变
    expect(wide.saturationmin).toBe(0);
    expect(wide.saturationrange).toBe(f32(0.4));
    const over = centered({ saturationmin: 0, saturationmax: 0.6 }, hsv2rgb(0, 1, 0.5));
    // 中心 0.3 → 搬到 1：min = 0.7、0.7 + 0.6 > 1 → range = 0.3
    expect(over.saturationmin).toBeCloseTo(0.7, 6);
    expect(over.saturationrange).toBeCloseTo(0.3, 6);
  });
});

/** 一个粒子系统：每秒 4 个（步长 0.25 时一帧一个）、不动、寿命 4 s，`initializer` 加颜色模块。 */
function particle(
  initializer: JsonObject[],
  instanceoverride: JsonObject | undefined,
  options: { flags?: number; sceneVersion?: number } = {},
): SceneParticle {
  return parseParticle(
    {
      maxcount: 8,
      flags: options.flags ?? 0,
      emitter: [{ name: "sphererandom", origin: "100 100 0", distancemax: 0, rate: 4 }],
      initializer: [
        { name: "lifetimerandom", min: 4, max: 4 },
        { name: "sizerandom", min: 10, max: 10 },
        { name: "velocityrandom", min: "0 0 0", max: "0 0 0" },
        ...initializer,
      ],
      operator: [{ name: "movement", gravity: "0 0 0" }],
    },
    { file: "p.json", orthographic: true, instanceoverride, sceneVersion: options.sceneVersion ?? 5 },
  );
}

interface Internals {
  initializers: { name: string; fields: Record<string, unknown> }[];
}
const fieldsInSystem = (system: ParticleSystem, name: string) =>
  (system as unknown as Internals).initializers.find((m) => m.name === name)!.fields;
const colorOf = (system: ParticleSystem, slot: number): number[] => [0, 1, 2].map((i) => system.columns.color[i][slot]);
const makeSystem = (def: SceneParticle, hue = fixedHue(0)) => new ParticleSystem(def, new SeededRandom(1, hue), 1);

describe("模拟器：hsvcolorrandom 与 colorn（实测 hsv-colorn*、p4g-live）", () => {
  // 语料原样的 hsvcolorrandom（反向区间、4 档），S = V 缺省
  const CORPUS = { name: "hsvcolorrandom", huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 };
  const PURPLE = { colorn: "0.50196 0 0.50196" };

  it("hsv-colorn：套 colorn 紫后档位 0.951 / 0.873 / 0.794 / 0.716 / 0.637，S ∈ [0.75, 1]、V ∈ [0.252, 0.752]，步长不变", () => {
    const plain = makeSystem(particle([CORPUS], undefined));
    const system = makeSystem(particle([CORPUS], PURPLE));
    const fields = fieldsInSystem(system, "hsvcolorrandom");
    expect(fields.huemin).toBeCloseTo(0.95098, 4);
    expect(fields.step).toBe(fieldsInSystem(plain, "hsvcolorrandom").step);
    expect(fields.steps).toBe(4);
    expect(fields.saturationmin).toBeCloseTo(0.75, 5);
    expect(fields.saturationrange).toBeCloseTo(0.25, 5);
    // 5 个档位逐个出生：S = V 取区间中点附近只看色相，用满量程的 S / V = 区间上界会更直观，这里直接读 rgb → hsv
    const born = makeSystem(particle([CORPUS], PURPLE), injectedHue([0, 6554, 13108, 19661, 26214]));
    for (let i = 0; i < 5; i++) born.step(0.25);
    expect(born.alive).toBe(5);
    const hues = [0, 1, 2, 3, 4].map((slot) => hue(colorOf(born, slot)));
    close(hues, [0.951, 0.873, 0.794, 0.716, 0.637], 2);
    for (let slot = 0; slot < 5; slot++) {
      const [, s, v] = rgb2hsv(colorOf(born, slot));
      expect(s).toBeGreaterThanOrEqual(0.74);
      expect(s).toBeLessThanOrEqual(1.0001);
      expect(v).toBeGreaterThanOrEqual(0.25);
      expect(v).toBeLessThanOrEqual(0.7521);
    }
  });

  it("hsv-colorn-fixed：huesteps 0 的固定色相套 colorn 后就是 colorn 的色相 0.8333 → (0.502, 0, 0.502)", () => {
    const fixed = {
      name: "hsvcolorrandom",
      huesteps: 0,
      huemin: 0.25,
      huemax: 0.25,
      saturationmin: 0.5,
      saturationmax: 0.5,
      valuemin: 0.5,
      valuemax: 0.5,
    };
    const system = makeSystem(particle([fixed], PURPLE));
    system.step(0.25);
    close(colorOf(system, 0), [0.50196, 0, 0.50196], 3);
  });

  it("hsv-colorn-neg：套 colorn 红后 k = 0 的色相 −0.2 是灰，k = 1、2 是 0.2、0.6；步长 0.4 不变", () => {
    const def = particle(
      [
        {
          name: "hsvcolorrandom",
          huemin: 0,
          huemax: 0.4,
          huesteps: 2,
          saturationmin: 1,
          saturationmax: 1,
          valuemin: 1,
          valuemax: 1,
        },
      ],
      { colorn: "1 0 0" },
    );
    // 系统色 hsv2rgb(0.2, 1, 1) 与红不同，所以生效
    const born = makeSystem(def, injectedHue([0, 16383 + 1, 32767]));
    expect(fieldsInSystem(born, "hsvcolorrandom").huemin).toBeCloseTo(-0.2, 6);
    for (let i = 0; i < 3; i++) born.step(0.25);
    const [k0, k1, k2] = [0, 1, 2].map((slot) => colorOf(born, slot));
    // S、V 居中后分别是 [1, 1] 区间被搬到 colorn（红：s = 1、v = 1）仍是 1：灰色是 (0, 0, 0)
    expect(k0).toEqual([0, 0, 0]);
    close([hue(k1), hue(k2)], [0.2, 0.6], 5);
  });

  it("hsv-flags8：系统 flags 带 8 时和不写 colorn 的系统相同（不重算）", () => {
    const plain = fieldsInSystem(makeSystem(particle([CORPUS], undefined)), "hsvcolorrandom");
    const masked = fieldsInSystem(makeSystem(particle([CORPUS], PURPLE, { flags: 8 })), "hsvcolorrandom");
    expect(masked).toEqual(plain);
  });

  it("colorn 与系统色几乎相同时不生效；没写 colorn 时字段是基值", () => {
    const plain = fieldsInSystem(makeSystem(particle([CORPUS], undefined)), "hsvcolorrandom");
    const system = particleColorSystem({ initializer: [CORPUS] } as JsonObject, 5).rgb;
    const near = fieldsInSystem(makeSystem(particle([CORPUS], { colorn: system.join(" ") })), "hsvcolorrandom");
    expect(near).toEqual(plain);
  });

  it("p4g-live：运行中改 colorn 只影响之后出生的粒子，存活粒子保留出生时的颜色；改回基值与直接建系统相同", () => {
    const fixed = {
      name: "hsvcolorrandom",
      huesteps: 0,
      huemin: 0.25,
      huemax: 0.25,
      saturationmin: 1,
      saturationmax: 1,
      valuemin: 1,
      valuemax: 1,
    };
    const system = makeSystem(particle([fixed], { colorn: "0.5 0 1" }));
    system.step(0.25);
    const old = colorOf(system, 0);
    close([hue(old)], [rgb2hsv([0.5, 0, 1])[0]], 3);
    system.setInstance({ colorn: [0, 1, 0] });
    system.step(0.25);
    expect(colorOf(system, 0)).toEqual(old); // 老粒子不变
    close([hue(colorOf(system, 1))], [1 / 3], 3); // 新粒子按新 colorn
    // 再改成未设：新粒子回到基值色相 0.25
    system.setInstance({ colorn: null });
    system.step(0.25);
    close(colorOf(system, 2), hsv2rgb(0.25, 1, 1), 5);
    expect(fieldsInSystem(system, "hsvcolorrandom")).toEqual(
      fieldsInSystem(makeSystem(particle([fixed], undefined)), "hsvcolorrandom"),
    );
  });

  it("档位来自独立的色相源：同一个 SeededRandom 种子下，注入不同档位不改变 S / V 的序列", () => {
    const def = particle([{ name: "hsvcolorrandom", huemin: 0, huemax: 1, huesteps: 6 }], undefined);
    const a = makeSystem(def, fixedHue(0));
    const b = makeSystem(def, fixedHue(20000));
    a.step(0.25);
    b.step(0.25);
    const [, sa, va] = rgb2hsv(colorOf(a, 0));
    const [, sb, vb] = rgb2hsv(colorOf(b, 0));
    expect([sa, va]).toEqual([sb, vb]);
    expect(hue(colorOf(a, 0))).not.toBeCloseTo(hue(colorOf(b, 0)), 3);
  });
});

describe("模拟器：colorlist 与 colorn（实测 list-colorn）", () => {
  it("list-colorn：红、绿 + colorn 蓝 → 平移 = 蓝 − 红的 HSV 差：红 → 蓝，绿 → 红", () => {
    const def = particle([{ name: "colorlist", colors: ["1 0 0", "0 1 0"] }], { colorn: "0 0 1" });
    const system = makeSystem(def);
    for (let i = 0; i < 8; i++) system.step(0.25);
    expect(system.alive).toBe(8);
    const seen = new Set<string>();
    for (let slot = 0; slot < 8; slot++) {
      const color = colorOf(system, slot);
      const isBlue = color[2] > 0.99 && color[0] < 0.01 && color[1] < 0.01;
      const isRed = color[0] > 0.99 && color[1] < 0.01 && color[2] < 0.01;
      expect(isBlue || isRed, JSON.stringify(color)).toBe(true);
      seen.add(isBlue ? "blue" : "red");
    }
    expect(seen.size).toBe(2);
  });

  it("shift 在加载时就是 colorn 的 HSV 减第一项的 HSV；不生效 / flags 8 / colorn 与第一项同色时是 0", () => {
    const colors = ["1 0 0", "0 1 0"];
    const shiftOf = (colorn: string | undefined, flags = 0) =>
      fieldsInSystem(
        makeSystem(particle([{ name: "colorlist", colors }], colorn === undefined ? undefined : { colorn }, { flags })),
        "colorlist",
      ).shift as number[];
    close(shiftOf("0 0 1"), [2 / 3, 0, 0], 6);
    expect(shiftOf(undefined)).toEqual([0, 0, 0]);
    expect(shiftOf("0 0 1", 8)).toEqual([0, 0, 0]);
    expect(shiftOf("1 0 0")).toEqual([0, 0, 0]); // 与系统色（第一项）同色，不生效
  });

  it("运行中改 colorn 只影响之后出生的粒子（p4g-live 同理）", () => {
    const system = makeSystem(particle([{ name: "colorlist", colors: ["1 0 0"] }], { colorn: "0 0 1" }));
    system.step(0.25);
    const old = colorOf(system, 0);
    close(old, [0, 0, 1], 5);
    system.setInstance({ colorn: [0, 1, 0] });
    system.step(0.25);
    expect(colorOf(system, 0)).toEqual(old);
    close(colorOf(system, 1), [0, 1, 0], 5);
  });

  it("缺 colors 键：白色（list-empty）；colors: []：红（list-empty2）", () => {
    const white = makeSystem(particle([{ name: "colorlist" }], undefined));
    white.step(0.25);
    expect(colorOf(white, 0)).toEqual([1, 1, 1]);
    const red = makeSystem(particle([{ name: "colorlist", colors: [] }], undefined));
    red.step(0.25);
    expect(colorOf(red, 0)).toEqual([1, 0, 0]);
  });
});

describe("旧的颜色模块行为不变", () => {
  it("colorrandom 单色仍乘到初值颜色列，不抽色相分档源", () => {
    const random = new SeededRandom(1, () => {
      throw new Error("colorrandom 不该抽色相分档源");
    });
    const system = new ParticleSystem(
      particle([{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }], undefined),
      random,
      1,
    );
    system.step(0.25);
    expect(colorOf(system, 0)).toEqual([1, 0, 0]);
  });
});
