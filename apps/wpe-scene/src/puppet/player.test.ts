/**
 * P12a 步骤 2 点 3 的 puppet 运行时单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「步骤 2」）。
 *
 * - `fixtures/*.json`：从 `ignore/p12/` 的实测抄来的小样本（生成脚本 `ignore/p12/a/fix/mkfix.py`）：mdl（gzip + base64）、动画层原值、
 *   从第 1 帧起的 dt、WPE 在若干帧的 `g_Bones`，以及读码模型 `posemodel.py` 在同样帧的输出。生成工程 `p12-modes`（12 个模式 / 帧率 / rate
 *   组合，p12-REPORT 用例 1）、`p12-fade`（淡入淡出，用例 2）、`p12-mix`（覆盖、混合、加法、层序、隐藏的层、缺轨道、找不到的动画，
 *   用例 3），语料 `3203778110`（三个 puppet，`posemodel.py check3203`）。
 * - 按 dt 序列从第 1 帧推进，和 WPE 的 `g_Bones` 比：容差 5 ulp 或绝对差 2e-6（二者取宽）。差来自 `rsqrtps` 的硬件近似（模型与实现都
 *   用精确的倒数平方根，rea-RT 7）。和 python 模型比：两边是同一套 float32 运算，只有 `sin` / `cos` 的 double 末位可能不同，要求逐位相同。
 * - 其余：静态 puppet、状态覆盖字段、隐藏的层不推进、重编译接回、`seek`、fps 不合法的早退。
 * P12b1 步骤 2：`fixtures/p12-am.json`（生成脚本 `ignore/p12/b/fix/mkfix_b.py`，p12-REPORT 用例 5、6）：骨骼透明度三种叠法、变形权重与 uniform 排序
 * （含权重超过 0.5 后的换序帧、没有 bit12 的 puppet、没有层的 puppet）按 dt 序列推进后逐位对 WPE；变形纹理等于 `case-p12-am-morphtex.txt`。
 * `pose.ts` 的标量函数按 clip-morph-attach 5 逐条核对。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import corpus3203 from "./fixtures/3203778110.json";
import fade from "./fixtures/p12-fade.json";
import mix from "./fixtures/p12-mix.json";
import modes from "./fixtures/p12-modes.json";
import am from "./fixtures/p12-am.json";
import { ScenePuppets, type PuppetLayerFields, type PuppetSink } from "./player";
import { blendMorphWeights, blendScalarAlpha, morphUniforms, type MorphUniforms } from "./pose";

interface Fixture {
  source: string;
  project: string;
  dt: number[];
  frames: number[];
  puppets: {
    name: string;
    object: number;
    path: string;
    mdlGzip: string;
    layers: unknown[];
    wpe: Record<string, number[]>;
    model: Record<string, number[]>;
  }[];
}

const fixtures: [string, Fixture][] = [
  ["p12-modes", modes],
  ["p12-fade", fade],
  ["p12-mix", mix],
  ["3203778110", corpus3203],
];

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function load(item: Fixture["puppets"][number]): ScenePuppet {
  const { puppet, issues } = buildPuppet(parseMdl(mdlBytes(item.mdlGzip)), item.layers, item.path);
  expect([...issues], item.name).toEqual([]);
  return puppet!;
}

const bitsF = new Float32Array(1);
const bitsI = new Int32Array(bitsF.buffer);
/** float32 的有序整数（+0 与 −0 都是 0），相减就是相差几个 ulp。 */
function ordered(value: number): number {
  bitsF[0] = value;
  const i = bitsI[0];
  return i < 0 ? -(i & 0x7fffffff) : i;
}

interface Residual {
  abs: number;
  ulp: number;
  same: number;
  count: number;
}

function compare(got: Float32Array, want: readonly number[], into: Residual): void {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    const ref = Math.fround(want[i]);
    const abs = Math.abs(got[i] - ref);
    const ulp = Math.abs(ordered(got[i]) - ordered(ref));
    into.abs = Math.max(into.abs, abs);
    into.ulp = Math.max(into.ulp, ulp);
    into.same += Object.is(got[i], ref) || got[i] === ref ? 1 : 0;
    into.count++;
  }
}

describe.each(fixtures)("和 WPE 的 g_Bones 逐帧比：%s", (name, fixture) => {
  it("从第 1 帧起按日志的 dt 推进，≤ 5 ulp 或 ≤ 2e-6；和 python 模型逐位相同", () => {
    const list = fixture.puppets.map((item) => ({ object: item.object, puppet: load(item) }));
    const puppets = new ScenePuppets(list);
    const last = fixture.frames[fixture.frames.length - 1];
    const wanted = new Set(fixture.frames);
    const wpe: Residual = { abs: 0, ulp: 0, same: 0, count: 0 };
    const model: Residual = { abs: 0, ulp: 0, same: 0, count: 0 };
    const worst = new Map<string, Residual>();
    for (let k = 1; k <= last; k++) {
      puppets.frame(fixture.dt[k - 1]);
      if (!wanted.has(k)) continue;
      for (const item of fixture.puppets) {
        const skin = puppets.skin(item.object)!;
        expect(skin, item.name).not.toBeNull();
        const own = worst.get(item.name) ?? { abs: 0, ulp: 0, same: 0, count: 0 };
        worst.set(item.name, own);
        const before = { ...own };
        compare(skin, item.wpe[String(k)], own);
        compare(skin, item.wpe[String(k)], wpe);
        compare(skin, item.model[String(k)], model);
        // 单个数的容差：5 ulp 或 2e-6
        if (own.ulp > 5 && own.abs > 2e-6)
          expect.fail(`${item.name} 帧 ${k}：差 ${own.abs}（${own.ulp} ulp），之前最大 ${before.abs}`);
      }
    }
    const rows = [...worst].map(
      ([puppet, r]) =>
        `  ${puppet.padEnd(14)} 最大差 ${r.abs.toExponential(3)}  ${r.ulp} ulp  逐位相同 ${r.same}/${r.count}`,
    );
    console.log(
      `[${name}] WPE：最大差 ${wpe.abs.toExponential(3)}，最大 ${wpe.ulp} ulp，逐位相同 ${wpe.same}/${wpe.count}；` +
        `python 模型：最大差 ${model.abs.toExponential(3)}，最大 ${model.ulp} ulp，逐位相同 ${model.same}/${model.count}\n` +
        rows.join("\n"),
    );
    expect(model.same).toBe(model.count);
  });
});

// ———— 其余行为（用 p12-modes 的 loop10：1 根骨骼，绑定姿势单位阵，帧值 T.x = 帧号、rz = 0.02·帧，loop fps 10、长度 20） ————

const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const single95 = modes.puppets.find((item) => item.name === "single95")!;
const mdlLoop10 = parseMdl(mdlBytes(loop10.mdlGzip));
const loop10Id = (loop10.layers[0] as { animation: number }).animation;

/** 用 loop10 的 mdl 配自定的动画层。 */
function puppetWith(layers: unknown[]): ScenePuppet {
  return buildPuppet(mdlLoop10, layers, loop10.path).puppet!;
}

/** g_Bones[0] 的平移 x：等于采样出的帧号（lo + frac）。 */
const frameOf = (puppets: ScenePuppets, object = 0) => puppets.skin(object)![9];

/** 记录调用并按表给值的状态。 */
function sink(values: Record<string, PuppetLayerFields | undefined>): PuppetSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    animationLayer(object, layer) {
      calls.push(`${object}:${layer}`);
      return values[`${object}:${layer}`];
    },
  };
}

describe("ScenePuppets：运行时行为", () => {
  it("静态 puppet 不进运行时，skin 为 null；没有的对象也是 null", () => {
    const static0 = buildPuppet({ ...mdlLoop10, skeleton: null }, loop10.layers, "p").puppet!;
    const puppets = new ScenePuppets([{ object: 3, puppet: static0 }]);
    puppets.frame(0.1);
    expect(puppets.skin(3)).toBeNull();
    expect(puppets.skin(4)).toBeNull();
  });

  it("建好后按 t = 0 算一次姿势；每帧推进 dt × rate（float32）", () => {
    const puppets = new ScenePuppets([{ object: 0, puppet: puppetWith([{ animation: loop10Id, rate: 2 }]) }]);
    expect(frameOf(puppets)).toBe(0);
    puppets.frame(0.23);
    // t = 0.46 s → 第 4.6 帧（整数帧的边界上 float32 的 `t / spf` 与 `fmodf` 会落到相邻两帧之间，测试避开边界）
    expect(frameOf(puppets)).toBeCloseTo(4.6, 4);
  });

  it("没有动画层（或全部不可见）：蒙皮是单位阵（绑定姿势 = 静止姿势，rea-RT 6.2）", () => {
    for (const layers of [[], [{ animation: loop10Id, visible: false }]]) {
      const puppets = new ScenePuppets([{ object: 0, puppet: puppetWith(layers) }]);
      puppets.frame(0.3);
      expect(Array.from(puppets.skin(0)!)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    }
  });

  it("状态覆盖 rate / blend / visible；取不到时用定义里的值；不可见的层时钟不走，重新可见时接着走", () => {
    const puppets = new ScenePuppets([{ object: 7, puppet: puppetWith([{ animation: loop10Id }]) }]);
    const state = sink({ "7:0": { rate: 0.5, blend: 1, visible: true } });
    puppets.frame(0.2, state);
    expect(state.calls).toEqual(["7:0"]);
    expect(frameOf(puppets, 7)).toBeCloseTo(1, 5);
    // 隐藏两帧：时钟不走，姿势回到单位阵（没有可见层）
    const hidden = sink({ "7:0": { rate: 1, blend: 1, visible: false } });
    puppets.frame(0.5, hidden);
    puppets.frame(0.5, hidden);
    expect(frameOf(puppets, 7)).toBe(0);
    // 取不到：定义里的 rate 1
    puppets.frame(0.1, sink({}));
    expect(frameOf(puppets, 7)).toBeCloseTo(2, 5);
  });

  it("carryOver：按 (对象, 层) 接回时钟；refresh 不推进", () => {
    const first = new ScenePuppets([{ object: 2, puppet: puppetWith([{ animation: loop10Id }]) }]);
    first.frame(0.25);
    first.frame(0.25);
    const second = new ScenePuppets([
      { object: 2, puppet: puppetWith([{ animation: loop10Id }]) },
      { object: 5, puppet: puppetWith([{ animation: loop10Id }]) },
    ]);
    second.carryOver(first);
    second.refresh();
    expect(frameOf(second, 2)).toBe(frameOf(first, 2));
    expect(frameOf(second, 5)).toBe(0);
    second.refresh();
    expect(frameOf(second, 2)).toBe(frameOf(first, 2));
  });

  it("seek：loop 取余、single 钳到末帧、mirror 三角波，rate 计入", () => {
    const singleMdl = parseMdl(mdlBytes(single95.mdlGzip));
    const singleId = (single95.layers[0] as { animation: number }).animation;
    const puppets = new ScenePuppets([
      { object: 0, puppet: puppetWith([{ animation: loop10Id }]) },
      { object: 1, puppet: puppetWith([{ animation: loop10Id, rate: -0.5 }]) },
      { object: 2, puppet: buildPuppet(singleMdl, [{ animation: singleId }], single95.path).puppet! },
    ]);
    puppets.seek(2.43);
    // loop D = 2 s：2.43 → 0.43 s = 第 4.3 帧
    expect(frameOf(puppets, 0)).toBeCloseTo(4.3, 4);
    // rate −0.5：−1.215 s 绕回 0.785 s = 第 7.85 帧
    expect(frameOf(puppets, 1)).toBeCloseTo(7.85, 4);
    puppets.seek(100);
    const singleAnim = singleMdl.animations.find((item) => item.id === singleId)!;
    expect(frameOf(puppets, 2)).toBeCloseTo(singleAnim.length, 4);
  });

  it("fps 不是正数时照 FUN_1401a8c10 早退：时钟不走，停在第 0 帧", () => {
    const puppet = puppetWith([{ animation: loop10Id }]);
    puppet.animations[0] = { ...puppet.animations[0], fps: 0 };
    const puppets = new ScenePuppets([{ object: 0, puppet }]);
    puppets.frame(0.25);
    expect(frameOf(puppets)).toBe(0);
  });
});

// ———— P12b1：骨骼透明度与变形权重（p12-am） ————

const amPuppets = am.puppets.map((item) => {
  const { puppet, issues } = buildPuppet(parseMdl(mdlBytes(item.mdlGzip)), item.layers, item.path);
  expect([...issues], item.name).toEqual([]);
  return { ...item, puppet: puppet! };
});

/** float32 逐位相同（+0 与 −0 算不同）。 */
function same(got: number, want: number): boolean {
  return Object.is(got, Math.fround(want));
}

describe("p12-am：g_BonesAlpha、g_MorphOffsets / g_MorphWeights 逐帧对 WPE（逐位相同）", () => {
  it("40 帧：覆盖 / 混合 / 加法三种叠法、没有透明度轨道、没有层；变形含换序帧、层 blend 0.5、没有 bit12、没有层", () => {
    const puppets = new ScenePuppets(amPuppets.map((item) => ({ object: item.object, puppet: item.puppet })));
    const wanted = new Set(am.frames);
    let reordered = 0;
    let checked = 0;
    for (let k = 1; k <= am.frames[am.frames.length - 1]; k++) {
      puppets.frame(am.dt[k - 1]);
      if (!wanted.has(k)) continue;
      for (const item of amPuppets) {
        const want = (item.wpe as Record<string, { alpha?: number[]; offsets?: number[]; weights?: number[] }>)[
          String(k)
        ];
        const alpha = puppets.boneAlpha(item.object);
        const morph = puppets.morph(item.object);
        if (item.name.startsWith("alpha")) {
          expect(morph, item.name).toBeNull();
          expect(alpha, item.name).not.toBeNull();
          want.alpha!.forEach((value, b) => {
            if (!same(alpha![b], value)) expect.fail(`${item.name} 帧 ${k} 骨骼 ${b}：${alpha![b]} ≠ ${value}`);
          });
        } else {
          expect(alpha, item.name).toBeNull();
          expect(morph, item.name).not.toBeNull();
          const count = want.offsets![0];
          expect(morph!.offsets[0], `${item.name} 帧 ${k}`).toBe(count);
          for (let i = 1; i <= count; i++)
            expect(morph!.offsets[i], `${item.name} 帧 ${k} 偏移 ${i}`).toBe(want.offsets![i]);
          want.weights!.forEach((value, i) => {
            if (!same(morph!.weights[i], value))
              expect.fail(`${item.name} 帧 ${k} 权重 ${i}：${morph!.weights[i]} ≠ ${value}`);
          });
          if (item.name === "morph" && count === 2 && want.offsets![1] === 0) reordered++;
        }
        checked++;
      }
    }
    expect(checked).toBe(am.frames.length * am.puppets.length);
    // 权重超过 0.5 后（帧 177–187）目标 0 排到前面：测试要真碰到换序
    expect(reordered).toBeGreaterThan(5);
  });

  it("变形纹理：morph 的 3×3 等于 case-p12-am-morphtex.txt；没有 bit12 的只有纹素 0（rea-mdl 6.3）", () => {
    const morph = amPuppets.find((item) => item.name === "morph")!.puppet.morph!;
    expect([morph.side, morph.vertices, morph.targets, morph.scale]).toEqual([3, 2, 3, 40]);
    expect(Array.from(morph.texels)).toEqual(am.morphTexture.texels.flat());
    const nobit = amPuppets.find((item) => item.name === "morph_nobit12")!.puppet.morph!;
    expect([nobit.side, nobit.vertices, nobit.targets]).toEqual([3, 2, 3]);
    expect(Array.from(nobit.texels)).toEqual([0, 0, 0, 32767, ...new Array(8 * 4).fill(0)]);
  });

  it("组合键：bit2 → SKINNING_ALPHA、格式含 a_PositionVec4 → MORPHING；没有的 puppet 对应访问器为 null", () => {
    const byName = (name: string) => amPuppets.find((item) => item.name === name)!.puppet;
    expect(byName("alpha").combos).toEqual({ SKINNING: 1, BONECOUNT: 2, SKINNING_ALPHA: 1 });
    expect(byName("morph").combos).toEqual({ SKINNING: 1, BONECOUNT: expect.any(Number), MORPHING: 1 });
    expect(byName("alpha").boneAlpha).toBe(true);
    expect(byName("morph").boneAlpha).toBe(false);
    const puppets = new ScenePuppets([{ object: 0, puppet: byName("alpha") }]);
    expect(puppets.morph(0)).toBeNull();
    expect(puppets.boneAlpha(1)).toBeNull();
    expect(puppets.boneAlpha(0)).not.toBeNull();
  });

  it("没有可见层：透明度全 1、变形生效数 0；再隐藏一帧走「已静止不重算」的捷径、结果不变；重新可见时回到动画值", () => {
    const item = amPuppets.find((entry) => entry.name === "alpha")!;
    const morphItem = amPuppets.find((entry) => entry.name === "morph")!;
    const puppets = new ScenePuppets([
      { object: 1, puppet: item.puppet },
      { object: 2, puppet: morphItem.puppet },
    ]);
    puppets.frame(0.25);
    expect(puppets.boneAlpha(1)![0]).toBeLessThan(1);
    expect(puppets.morph(2)!.offsets[0]).toBeGreaterThan(0);
    const hidden = sink({ "1:0": { rate: 1, blend: 1, visible: false }, "2:0": { rate: 1, blend: 1, visible: false } });
    puppets.frame(0.25, hidden);
    expect(Array.from(puppets.boneAlpha(1)!)).toEqual([1, 1]);
    expect(puppets.morph(2)!.offsets[0]).toBe(0);
    expect(puppets.morph(2)!.weights[0]).toBe(40);
    expect(Array.from(puppets.morph(2)!.weights.subarray(1))).toEqual(new Array(11).fill(0));
    puppets.frame(0.25, hidden);
    expect(Array.from(puppets.boneAlpha(1)!)).toEqual([1, 1]);
    expect(puppets.morph(2)!.offsets[0]).toBe(0);
    puppets.frame(0.25, sink({}));
    expect(puppets.boneAlpha(1)![0]).toBeLessThan(1);
    expect(puppets.morph(2)!.offsets[0]).toBeGreaterThan(0);
  });
});

describe("pose.ts：标量轨道的叠法（clip-morph-attach 5、rea-RT 6.4）", () => {
  const f = Math.fround;

  it("骨骼透明度：覆盖取 lerp(lo, hi, frac)，混合 lerp(cur, v, w)，加法夹在 cur 与 v 之间；mask 为 0 的骨骼不动", () => {
    // 2 帧 × 2 骨骼：骨骼 0 从 0.2 到 0.8，骨骼 1 从 1 到 0
    const values = Float32Array.from([0.2, 1, 0.8, 0]);
    const run = (w: number, additive: boolean, mask = [1, 1]) => {
      const alpha = Float32Array.from([1, 1]);
      blendScalarAlpha(alpha, values, Uint8Array.from(mask), 2, 0, 1, 0.5, w, additive);
      return Array.from(alpha);
    };
    expect(run(1, false)).toEqual([f(0.5), 0.5]);
    expect(run(0.5, false)).toEqual([f(f(0.5 * 1) + f(0.5 * f(0.5))), 0.75]);
    // 加法：骨骼 1：cur 1、v 0.5、w 0.5 → 1 + (0.5 − 1)·0.5 = 0.75，夹在 [0.5, 1]
    expect(run(0.5, true)[1]).toBe(0.75);
    // w = 1 的加法层不走覆盖：cur + (v − 1)·1 = v，夹在 [v, 1]
    expect(run(1, true)[1]).toBe(0.5);
    expect(run(1, false, [0, 1])).toEqual([1, 0.5]);
  });

  /** 一个目标一条两帧轨道（值 a → b）。 */
  const track = (a: number, b: number) => Float32Array.from([a, b]);
  const weightsOf = (n: number) => ({ weights: new Float32Array(n), active: new Uint8Array(n) });

  it("变形生效 = |v| ≥ FLT_EPSILON：负权重生效、NaN 生效、刚好等于 FLT_EPSILON 生效、更小的不生效", () => {
    const eps = 2 ** -23;
    const { weights, active } = weightsOf(5);
    blendMorphWeights(
      weights,
      active,
      [track(-0.5, -0.5), track(NaN, NaN), track(eps, eps), track(eps / 2, eps / 2), track(0, 0)],
      0,
      0,
      0,
      1,
      false,
    );
    expect(Array.from(active)).toEqual([1, 1, 1, 0, 0]);
    expect(weights[0]).toBe(-0.5);
  });

  it("覆盖：不生效清位、权重不动；混合：从不清位、权重总是 lerp(cur, v, w)；加法：不生效整条跳过", () => {
    const base = () => {
      const state = weightsOf(1);
      state.weights[0] = 0.5;
      state.active[0] = 1;
      return state;
    };
    const zero = [track(0, 0)];
    const override = base();
    blendMorphWeights(override.weights, override.active, zero, 0, 0, 0, 1, false);
    expect([override.weights[0], override.active[0]]).toEqual([0.5, 0]);
    const blend = base();
    blendMorphWeights(blend.weights, blend.active, zero, 0, 0, 0, 0.5, false);
    expect([blend.weights[0], blend.active[0]]).toEqual([0.25, 1]);
    const add = base();
    blendMorphWeights(add.weights, add.active, zero, 0, 0, 0, 0.5, true);
    expect([add.weights[0], add.active[0]]).toEqual([0.5, 1]);
    const skipped = weightsOf(1);
    blendMorphWeights(skipped.weights, skipped.active, zero, 0, 0, 0, 0.5, true);
    expect([skipped.weights[0], skipped.active[0]]).toEqual([0, 0]);
  });

  it("加法：同号取绝对值大的、异号才相加；从 0 开始的第一层就是 v·w", () => {
    const run = (cur: number, v: number, w: number) => {
      const state = weightsOf(1);
      state.weights[0] = cur;
      blendMorphWeights(state.weights, state.active, [track(v, v)], 0, 0, 0, w, true);
      return state.weights[0];
    };
    expect(run(0, 0.8, 0.5)).toBe(f(0.4));
    expect(run(0.6, 0.8, 0.5)).toBe(f(0.6)); // a = 0.4：同号取绝对值大的（cur）
    expect(run(0.3, 0.8, 0.5)).toBe(f(0.4)); // a = 0.4 > cur
    expect(run(0.5, -0.8, 0.5)).toBe(f(f(0.5) + f(-0.4))); // 异号相加
    expect(run(-0.6, -0.8, 0.5)).toBe(f(-0.6));
  });

  it("morphUniforms：前 11 个生效目标（按目标号）→ 带符号权重降序稳定排序 → 偏移 t·nv；缩放在 weights[0]", () => {
    const out: MorphUniforms = { offsets: new Uint32Array(12), weights: new Float32Array(12) };
    // 目标 0..2：0.5、−0.2、0.5（并列保持目标号升序）；目标 3 不生效；目标 4：0.9
    const weights = Float32Array.from([0.5, -0.2, 0.5, 0.7, 0.9]);
    const active = Uint8Array.from([1, 1, 1, 0, 1]);
    morphUniforms(weights, active, 10, 5.5, out);
    expect(Array.from(out.offsets)).toEqual([4, 40, 0, 20, 10, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(out.weights)).toEqual([5.5, f(0.9), 0.5, 0.5, f(-0.2), 0, 0, 0, 0, 0, 0, 0]);
    morphUniforms(new Float32Array(3), new Uint8Array(3), 10, 7, out);
    expect(Array.from(out.offsets)).toEqual(new Array(12).fill(0));
    expect(Array.from(out.weights)).toEqual([7, ...new Array(11).fill(0)]);
  });

  it("morphUniforms：超过 11 个生效目标时取目标号最小的 11 个，不是权重最大的", () => {
    const out: MorphUniforms = { offsets: new Uint32Array(12), weights: new Float32Array(12) };
    const n = 14;
    const weights = Float32Array.from({ length: n }, (_, t) => (t === 13 ? 100 : 0.1 + t * 0.01));
    morphUniforms(weights, new Uint8Array(n).fill(1), 3, 1, out);
    expect(out.offsets[0]).toBe(11);
    // 目标 13（权重最大）没进来；进来的 0..10 按权重降序 = 10..0
    expect(Array.from(out.offsets.subarray(1))).toEqual(
      Array.from({ length: 11 }, (_, k) => (10 - k) * 3 * (k < 11 ? 1 : 0)),
    );
    expect(out.weights[1]).toBe(f(0.1 + 10 * 0.01));
  });
});
