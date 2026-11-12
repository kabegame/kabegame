// P10a 步骤 1：关键帧解析、wraploop、整数帧采样与帧间插值（rea-p10-keyframes.md 第 2、3、5 节，第 14 节参考实现）。
// 期望值是读码模型 ignore/p10/rea/kfmodel.py（numpy float32，对 WPE 抓帧逐帧吻合）算出的数，逐位比较。
import { describe, expect, it } from "vitest";
import {
  Channel,
  KEY_BACK,
  KEY_FRONT,
  KEY_STEP,
  applyWraploop,
  frameValues,
  parseChannel,
  type ParsedKey,
} from "./curve";

const f = Math.fround;

type Tangent = [number, number] | null;

/** 照测试工程 `ignore/p10/defs/p10.py` 的写法：关着的切线仍带 ±1、0 与编辑器字段。 */
function tangent(t: Tangent) {
  return { enabled: t !== null, x: t ? t[0] : -1, y: t ? t[1] : 0, magic: false };
}

function key(frame: number, value: number, back: Tangent = null, front: Tangent = null) {
  return { frame, value, back: tangent(back), front: tangent(front), lockangle: true, locklength: true };
}

/** 两侧切线都关。 */
const lin = (frame: number, value: number) => key(frame, value);
/** 平切线 ±1（语料最常见的缓入缓出）。 */
const flat = (frame: number, value: number) => key(frame, value, [-1, 0], [1, 0]);

function channel(keys: unknown[], wraploopLength?: number): Channel {
  const parsed = parseChannel(keys);
  return new Channel(wraploopLength === undefined ? parsed : applyWraploop(parsed, wraploopLength));
}

function samples(ch: Channel, frames: number[]): number[] {
  return frames.map((frame) => ch.sample(frame));
}

const k = (frame: number, value: number, flags = 0, bx = 0, by = 0, fx = 0, fy = 0): ParsedKey => ({
  frame,
  value,
  flags,
  bx,
  by,
  fx,
  fy,
});

describe("parseChannel（FUN_1401a8ce0，读码第 2 节「加载」）", () => {
  it("frame 截断，截断后不递增的丢掉；back 没写 enabled 按开", () => {
    const keys = [
      lin(0, 100),
      lin(10.7, 400),
      lin(10.2, 900),
      { frame: 60, value: 700, back: { x: -1, y: 50 }, front: { x: 1, y: 0 } },
    ];
    expect(parseChannel(keys)).toEqual([k(0, 100), k(10, 400), k(60, 700, KEY_BACK | KEY_FRONT, -1, 50, 1, 0)]);
    // 实测 p10-edge `parse`：y = 50 的后切线生效
    expect(samples(channel(keys), [5, 10, 20, 35, 59, 60])).toEqual([
      249.77499389648438, 400, 516.0256958007812, 638.7583618164062, 701.8009033203125, 700,
    ]);
  });

  it("value / frame 必须是数；负帧号与重复帧号跳过；不是对象的元素跳过", () => {
    const keys = [
      { frame: -1, value: 5 },
      { frame: "3", value: 1 },
      { frame: 3 },
      { frame: 4, value: "2" },
      null,
      7,
      [5, 6],
      { frame: 5, value: 0.1 },
      { frame: 5, value: 9 },
      { frame: 4, value: 9 },
    ];
    expect(parseChannel(keys)).toEqual([k(5, f(0.1))]);
  });

  it("enabled 只有 false 才算关：缺省、非布尔都算开；切线不是对象（含数组）算关；x / y 不是数取 0", () => {
    expect(
      parseChannel([
        { frame: 0, value: 1, back: { enabled: "no", x: -2, y: 3 }, front: { enabled: false, x: 4, y: 5 } },
        { frame: 1, value: 2, back: [-1, 0], front: { x: "1", y: 0.3 } },
      ]),
    ).toEqual([k(0, 1, KEY_BACK, -2, 3, 0, 0), k(1, 2, KEY_FRONT, 0, 0, 0, f(0.3))]);
  });

  it("step: true 时 flags 为 4，不读切线；step 不是 true 照常读", () => {
    expect(
      parseChannel([
        { frame: 0, value: 1, step: true, back: { x: -1, y: 9 }, front: { x: 1, y: 9 } },
        { frame: 1, value: 2, step: 1, front: { x: 1, y: 9 } },
      ]),
    ).toEqual([k(0, 1, KEY_STEP), k(1, 2, KEY_FRONT, 0, 0, 1, 9)]);
  });

  it("不是数组返回空数组（是否算一个通道由调用方决定）", () => {
    expect(parseChannel(lin(0, 1))).toEqual([]);
    expect(parseChannel(undefined)).toEqual([]);
    expect(parseChannel([])).toEqual([]);
  });
});

describe("applyWraploop（FUN_1401a98b0，读码第 3 节）", () => {
  it("首帧前切线开：末帧后切线取它的反，值改成首帧值；不改入参", () => {
    // p10-script `wrapt`：末帧 40，在 60 处补一个
    const parsed = parseChannel([key(0, 100, [-1, 300], [1, 0]), key(40, 700, [-1, 0], [1, 300])]);
    const before = parsed.map((item) => ({ ...item }));
    const wrapped = applyWraploop(parsed, 60);
    expect(parsed).toEqual(before);
    expect(wrapped).toEqual([
      k(0, 100, 3, -1, 300, 1, 0),
      k(40, 700, 3, -1, 0, 1, 300),
      k(60, 100, KEY_BACK, -1, -0, 0, 0),
    ]);
    expect(samples(new Channel(wrapped), [41, 50, 59, 60])).toEqual([
      726.6171875, 513.0623168945312, 103.06869506835938, 100,
    ]);
  });

  it("首帧前切线关：只清末帧的 back 位，残留的 bx / by 照样生效（实测 wrapres）", () => {
    const wrapped = applyWraploop(parseChannel([lin(0, 100), key(60, 700, [-1, 300], null)]), 60);
    expect(wrapped[1]).toEqual(k(60, 100, 0, -1, 300, 0, 0));
    expect(samples(new Channel(wrapped), [30, 45, 55, 59, 60])).toEqual([
      233.15939331054688, 204.78036499023438, 144.65350341796875, 109.78811645507812, 100,
    ]);
    // 对照：后切线 y = 0 时这一段几乎是平的
    const flatBack = channel([lin(0, 100), key(60, 700, [-1, 0], null)], 60);
    expect(samples(flatBack, [55, 59])).toEqual([100.00000762939453, 100]);
  });

  it("末帧在 length 前：补一个 {frame: length, 首帧值}（tailwrap）", () => {
    const wrapped = applyWraploop(parseChannel([lin(0, 100), lin(40, 700)]), 60);
    expect(wrapped).toEqual([k(0, 100), k(40, 700), k(60, 100)]);
    expect(samples(new Channel(wrapped), [40, 41, 50, 59, 60])).toEqual([
      700, 669.89208984375, 400.0110168457031, 130.11825561523438, 100,
    ]);
  });

  it("删掉 frame > length 的，至少留 1 个；剩下少于 2 个就不补", () => {
    const cut = applyWraploop(parseChannel([lin(0, 100), lin(30, 400), lin(90, 700)]), 60);
    expect(cut).toEqual([k(0, 100), k(30, 400), k(60, 100)]);
    expect(samples(new Channel(cut), [30, 45, 59, 60])).toEqual([400, 250.00550842285156, 109.96664428710938, 100]);
    expect(applyWraploop(parseChannel([lin(0, 100), lin(70, 400), lin(80, 700)]), 60)).toEqual([k(0, 100)]);
    expect(applyWraploop(parseChannel([lin(5, 100)]), 60)).toEqual([k(5, 100)]);
  });
});

describe("Channel.sample（FUN_1401a9bc0，读码第 2 节）", () => {
  it("没有关键帧时取 0", () => {
    expect(samples(channel([]), [0, 1, 30])).toEqual([0, 0, 0]);
  });

  it("两侧切线都关：线性，误差在「斜率 × 0.01 帧」以内（反解容差）", () => {
    expect(samples(channel([lin(0, 100), lin(60, 700)]), [0, 1, 15, 30, 59, 60])).toEqual([
      100, 110.01805877685547, 249.9854736328125, 399.9889831542969, 690.099609375, 700,
    ]);
  });

  it("平切线 ±1：缓入缓出", () => {
    expect(samples(channel([flat(0, 100), flat(60, 700)]), [0, 6, 15, 30, 45, 54, 59, 60])).toEqual([
      100, 108.75425720214844, 163.52516174316406, 399.9889831542969, 636.4607543945312, 691.2399291992188,
      699.774169921875, 700,
    ]);
  });

  it("平切线 ±20：x(t) 不单调，结果由搜索路线决定，段中点跳变", () => {
    const ch = channel([key(0, 100, [-20, 0], [20, 0]), key(60, 700, [-20, 0], [20, 0])]);
    expect(samples(ch, [1, 15, 28, 29, 30, 31, 32, 45, 59])).toEqual([
      100.00054931640625, 100.13064575195312, 100.47409057617188, 100.51042938232422, 100.54763793945312,
      699.4899291992188, 699.5258178710938, 699.8693237304688, 699.9982299804688,
    ]);
  });

  it("斜切线：x 以半段长为单位，y 是值的绝对偏移（不缩放）", () => {
    const slope = channel([key(0, 100, [-10, -200], [10, 200]), key(60, 700, [-10, 0], [10, 0])]);
    expect(samples(slope, [1, 10, 30, 50, 59])).toEqual([
      100.66841888427734, 106.96517944335938, 123.05697631835938, 699.842529296875, 699.9984741210938,
    ]);
    const noY = channel([key(0, 100, [-10, 0], [10, 0]), key(60, 700, [-10, 0], [10, 0])]);
    expect(samples(noY, [10, 30])).toEqual([100.23534393310547, 102.41661834716797]);
  });

  it("只开首帧前切线 (20, 0)：整段贴着首帧值，最后一帧跳到末帧值", () => {
    expect(samples(channel([key(0, 100, null, [20, 0]), lin(60, 700)]), [1, 30, 58, 59, 60])).toEqual([
      100.00054931640625, 100.5279312133789, 102.08539581298828, 102.1627197265625, 700,
    ]);
  });

  it("三点混合切线", () => {
    const ch = channel([key(0, 100, null, [5, 0]), key(20, 600, [-5, 0], [10, 100]), key(60, 200, [-20, 0], null)]);
    expect(samples(ch, [5, 10, 19, 20, 21, 40, 59])).toEqual([
      101.98453521728516, 109.96831512451172, 599.9298706054688, 600, 201.8361053466797, 200.44766235351562,
      200.00149536132812,
    ]);
  });

  it("首帧不在 0：之前取首帧值；末帧之后取末帧值", () => {
    expect(samples(channel([flat(15, 100), flat(45, 700)]), [0, 14, 15, 16, 30, 44, 45, 60])).toEqual([
      100, 100, 100, 100.931640625, 399.9889831542969, 699.0663452148438, 700, 700,
    ]);
    expect(samples(channel([lin(0, 100), lin(40, 700)]), [20, 39, 40, 50, 60])).toEqual([
      399.9889831542969, 684.89013671875, 700, 700, 700,
    ]);
  });

  it("step 看段的右端：整段保持左端值；写在首帧不影响任何段", () => {
    const step = channel([lin(0, 100), { ...lin(30, 400), step: true }, lin(60, 700)]);
    expect(samples(step, [0, 29, 30, 31, 45, 59, 60])).toEqual([
      100, 100, 400, 409.96240234375, 549.9945068359375, 690.0333251953125, 700,
    ]);
    const step0 = channel([{ ...lin(0, 100), step: true }, lin(60, 700)]);
    expect(samples(step0, [1, 30, 59])).toEqual([110.01805877685547, 399.9889831542969, 690.099609375]);
  });

  it("缓存：先要后面的帧再要前面的、预分配不够时扩容，结果相同", () => {
    const keys = [flat(0, 100), flat(60, 700)];
    const lazy = new Channel(parseChannel(keys));
    const sized = new Channel(parseChannel(keys), 61);
    const backwards = [60, 45, 6, 0].map((frame) => lazy.sample(frame));
    expect(backwards).toEqual([700, 636.4607543945312, 108.75425720214844, 100]);
    expect(samples(sized, [0, 6, 45, 60])).toEqual([100, 108.75425720214844, 636.4607543945312, 700]);
    expect(lazy.sample(-3)).toBe(100);
  });
});

describe("frameValues（帧间插值，读码第 2 节）", () => {
  const spf = f(1 / 30);

  it("相邻整数帧之间线性插值：只开一侧长切线时第 59–60 帧之间从 102 线性升到 700", () => {
    const ch = channel([key(0, 100, null, [20, 0]), lin(60, 700)]);
    const out = new Float32Array(1);
    const values = [59.25, 59.5, 59.75].map((frame) => {
      frameValues({ t: f(f(frame) * spf), spf, length: 60 }, [ch], out);
      return out[0];
    });
    expect(values).toEqual([251.6227569580078, 401.0819396972656, 550.5410766601562]);
  });

  it("每个通道写进 out 的对应下标（color）", () => {
    const channels = [
      channel([lin(0, 0), lin(60, 1)]),
      channel([lin(0, 0.5), lin(1, 0.5)]),
      channel([lin(0, 1), lin(60, 0)]),
    ];
    const out = [9, 9, 9, 9];
    frameValues({ t: f(0.7), spf, length: 60 }, channels, out);
    expect(out).toEqual([0.3498799502849579, 0.5, 0.6501199007034302, 9]);
    // 空通道（"c0": []）照写 0（实测 p10-edge `empty`）
    frameValues({ t: f(0.7), spf, length: 60 }, [channel([])], out);
    expect(out[0]).toBe(0);
  });

  it("t 超过 D：lo 钳在 length − 1，取不到 length 之后的关键帧", () => {
    const ch = channel([lin(0, 100), lin(60, 700)]);
    const out = [0];
    // setFrame(70)：t / spf = 70，fmodf 余数约 0，停在第 59 帧
    frameValues({ t: f(spf * 70), spf, length: 60 }, [ch], out);
    expect(out[0]).toBe(690.099609375);
  });

  it("t < 0：在第 0、1 帧的连线上外延不到一帧，按 spf 周期重复（锯齿）", () => {
    const ch = channel([lin(0, 100), lin(60, 700)]);
    const out = [0];
    const at = (t: number) => {
      frameValues({ t, spf, length: 60 }, [ch], out);
      return out[0];
    };
    expect(at(f(-0.5 * spf))).toBe(94.990966796875);
    expect(at(f(-1.5 * spf))).toBe(94.990966796875);
    expect(at(f(-0.25 * spf))).toBe(97.4954833984375);
  });
});
