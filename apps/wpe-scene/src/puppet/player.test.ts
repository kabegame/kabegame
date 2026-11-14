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
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import corpus3203 from "./fixtures/3203778110.json";
import fade from "./fixtures/p12-fade.json";
import mix from "./fixtures/p12-mix.json";
import modes from "./fixtures/p12-modes.json";
import { ScenePuppets, type PuppetLayerFields, type PuppetSink } from "./player";

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
