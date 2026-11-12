// P10a 步骤 1：关键帧动画的时钟（rea-p10-keyframes.md 第 3、4、8、11 节，第 14 节参考实现）。
// 期望值：曲线取读码模型 ignore/p10/rea/kfmodel.py；时钟序列照读码第 3 节用 numpy float32 另算一份，逐位比较。
import { describe, expect, it } from "vitest";
import { AnimationClock, BACK, DONE, LOOP, MIRROR, PAUSED, SINGLE } from "./clock";
import { Channel, frameValues, parseChannel } from "./curve";
import type { AnimationEventDef, AnimationMode } from "./types";

const f = Math.fround;
const DT = f(0.05);

function lin(frame: number, value: number) {
  return { frame, value, back: { enabled: false, x: -1, y: 0 }, front: { enabled: false, x: 1, y: 0 } };
}

function clock(
  fps: number,
  length: number,
  mode: AnimationMode = LOOP,
  startpaused = false,
  events: [string, number][] = [],
) {
  const spf = f(1 / f(fps));
  // 事件时间照编译期：f(f(frame) × spf)；json 这里只放名字
  const defs: AnimationEventDef[] = events.map(([name, frame]) => ({ time: f(f(frame) * spf), json: name }));
  return new AnimationClock({ fps, length, mode, startpaused }, defs);
}

/** 时钟当前位置上一条通道的值。 */
function valueAt(c: AnimationClock, ch: Channel): number {
  const out = [0];
  frameValues(c, [ch], out);
  return out[0];
}

/** 推进一次，返回收到的事件名。 */
function step(c: AnimationClock, d: number): string[] {
  const out: AnimationEventDef[] = [];
  c.advance(d, out);
  return out.map((event) => event.json);
}

const linear = () => new Channel(parseChannel([lin(0, 100), lin(60, 700)]));

describe("构造（FUN_1401a8c10，读码第 3、5 节）", () => {
  it("spf = 1/fps、D = int(length)/fps，都是 float32；length 截断", () => {
    const cases: [number, number, number, number][] = [
      [30, 60, 0.03333333507180214, 2],
      [14.5, 29, 0.06896551698446274, 2],
      [1.2, 12, 0.8333333134651184, 10],
      [0.9, 9, 1.1111111640930176, 10],
      [30, 29, 0.03333333507180214, 0.9666666388511658],
      [20, 40.9, 0.05000000074505806, 2],
    ];
    for (const [fps, length, spf, D] of cases) {
      const c = clock(fps, length);
      expect([c.spf, c.D, c.length, c.t]).toEqual([spf, D, Math.trunc(length), 0]);
    }
  });

  it("flags：低两位是模式，startpaused 置暂停位", () => {
    expect(clock(30, 60, MIRROR).flags).toBe(MIRROR);
    expect(clock(30, 60, SINGLE, true).flags).toBe(SINGLE | PAUSED);
    expect(clock(30, 60, LOOP, true).isPlaying()).toBe(false);
  });
});

describe("advance：loop", () => {
  it("float32 累加；越过 D 取余数，第 length 帧不画（回绕处从 ≈ 700 直接跳回 ≈ 100）", () => {
    const c = clock(30, 60);
    const ch = linear();
    const ts: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < 42; i++) {
      c.advance(DT, []);
      ts.push(c.t);
      values.push(valueAt(c, ch));
    }
    expect(ts.slice(37, 42)).toEqual([
      1.8999992609024048, 1.949999213218689, 1.9999991655349731, 0.049999237060546875, 0.09999923408031464,
    ]);
    expect(values.slice(38, 42)).toEqual([685.0828857421875, 699.9996948242188, 114.97117614746094, 129.9022216796875]);
    expect(c.flags).toBe(LOOP);
  });

  it("一帧跨过多轮也只留余数", () => {
    const a = clock(30, 60);
    a.advance(2.5, []);
    expect(a.t).toBe(0.5);
    const b = clock(30, 60);
    b.advance(5.3, []);
    expect(b.t).toBe(1.3000001907348633);
  });

  it("t 在 D 前一个 ulp：帧 59 与 60 之间，值几乎是第 60 帧的", () => {
    const c = clock(30, 60);
    c.t = f(2 - 2 ** -23);
    expect(valueAt(c, linear())).toBe(699.9998779296875);
  });
});

describe("advance：mirror", () => {
  it("正向越过 D 置方向位并反射；反向时 d 取负，越过 0 清位再反射", () => {
    const c = clock(30, 60, MIRROR);
    const seq: [number, number][] = [];
    for (let i = 0; i < 7; i++) {
      c.advance(0.75, []);
      seq.push([c.t, c.flags]);
    }
    const back = (MIRROR | BACK) >>> 0;
    expect(seq).toEqual([
      [0.75, MIRROR],
      [1.5, MIRROR],
      [1.75, back],
      [1, back],
      [0.25, back],
      [0.5, MIRROR],
      [1.25, MIRROR],
    ]);
  });

  it("dt 0.05 的反射点（float32）", () => {
    const c = clock(30, 60, MIRROR);
    const seq: [number, number][] = [];
    for (let i = 0; i < 82; i++) {
      c.advance(DT, []);
      seq.push([c.t, c.flags]);
    }
    const back = (MIRROR | BACK) >>> 0;
    expect(seq.slice(38, 42)).toEqual([
      [1.949999213218689, MIRROR],
      [1.9999991655349731, MIRROR],
      [1.9500007629394531, back],
      [1.900000810623169, back],
    ]);
    expect(seq.slice(78, 82)).toEqual([
      [0.05000149831175804, back],
      [1.4975666999816895e-6, back],
      [0.04999850317835808, MIRROR],
      [0.09999850392341614, MIRROR],
    ]);
  });
});

describe("advance：single", () => {
  // (0, 0) → (29, 1) 两侧切线都关；fps 14.5 / 1.2 停在第 length − 1 帧，fps 30 停在第 length 帧附近（实测 p10-edge end145 / end12 / end30）
  const cases: [number, number, number, number][] = [
    [14.5, 29, 41, 0.9656292796134949],
    [1.2, 12, 200, 0.37958359718322754],
    [30, 29, 20, 0.9999999403953552],
  ];
  for (const [fps, length, steps, end] of cases) {
    it(`fps ${fps} / length ${length}：越过 D 置结束位、t = D，末值 ${end}`, () => {
      const c = clock(fps, length, SINGLE);
      const ch = new Channel(parseChannel([lin(0, 0), lin(29, 1)]));
      let n = 0;
      while (c.isPlaying()) {
        c.advance(DT, []);
        n++;
      }
      expect(n).toBe(steps);
      expect(c.t).toBe(c.D);
      expect(c.flags).toBe((SINGLE | DONE) >>> 0);
      expect(valueAt(c, ch)).toBe(end);
      // 结束后不再走
      c.advance(DT, []);
      expect(c.t).toBe(c.D);
    });
  }

  it("fps 14.5 / 1.2 的末值等于第 length − 1 帧的采样，fps 30 / length 29 接近第 length 帧", () => {
    const ch = new Channel(parseChannel([lin(0, 0), lin(29, 1)]));
    expect(ch.sample(28)).toBe(0.9656292796134949);
    expect(ch.sample(11)).toBe(0.37958359718322754);
    expect(ch.sample(29)).toBe(1);
  });

  it("负 rate 越过 0 后照样变负、isPlaying 一直为真，值在第 0、1 帧的连线上锯齿", () => {
    const c = clock(30, 60, SINGLE);
    const ch = linear();
    c.advance(0.1, []);
    const ts: number[] = [];
    const values: number[] = [];
    for (const d of [-0.15, -0.05, -0.0166, -0.0166, -0.0166]) {
      c.advance(d, []);
      ts.push(c.t);
      values.push(valueAt(c, ch));
      expect(c.isPlaying()).toBe(true);
    }
    expect(ts).toEqual([
      -0.05000000447034836, -0.10000000894069672, -0.11660000681877136, -0.133200004696846, -0.14980000257492065,
    ]);
    expect(values).toEqual([94.990966796875, 100, 95.01100158691406, 90.02201080322266, 95.05107116699219]);
  });
});

describe("控制（IAnimation，读码第 11 节）", () => {
  it("startpaused：时钟不走，值是第 0 帧的采样（首帧不在 0 时是首帧值）", () => {
    const c = clock(30, 60, LOOP, true);
    c.advance(DT, []);
    c.advance(1, []);
    expect(c.t).toBe(0);
    const inner = new Channel(
      parseChannel([
        { frame: 15, value: 100, back: { x: -1, y: 0 }, front: { x: 1, y: 0 } },
        { frame: 45, value: 700, back: { x: -1, y: 0 }, front: { x: 1, y: 0 } },
      ]),
    );
    expect(valueAt(c, inner)).toBe(100);
  });

  it("setFrame：t = spf × f，不钳制、不改位；getFrame = t / spf（float32）", () => {
    const c = clock(30, 60, SINGLE, true);
    const ch = linear();
    const cases: [number, number, number, number][] = [
      [70, 2.3333334922790527, 70, 690.099609375],
      [30, 1, 29.999998092651367, 399.9889831542969],
      [-5, -0.1666666716337204, -5, 89.98194122314453],
      [45.5, 1.5166667699813843, 45.5, 554.9625244140625],
    ];
    for (const [frame, t, got, value] of cases) {
      c.setFrame(frame);
      expect([c.t, c.getFrame(), valueAt(c, ch), c.flags]).toEqual([t, got, value, (SINGLE | PAUSED) >>> 0]);
    }
  });

  it("pause 冻住时间；play 从原处接着走", () => {
    const c = clock(30, 60);
    c.advance(0.5, []);
    c.pause();
    expect(c.isPlaying()).toBe(false);
    c.advance(0.5, []);
    expect(c.t).toBe(0.5);
    c.play();
    expect(c.isPlaying()).toBe(true);
    c.advance(0.25, []);
    expect(c.t).toBe(0.75);
  });

  it("play 在结束态时先把时间归零", () => {
    const c = clock(30, 60, SINGLE);
    c.advance(3, []);
    expect([c.t, c.isPlaying()]).toEqual([2, false]);
    c.play();
    expect([c.t, c.flags, c.isPlaying()]).toEqual([0, SINGLE, true]);
  });

  it("结束后 setFrame：时钟仍不走、isPlaying 仍为假", () => {
    const c = clock(30, 60, SINGLE);
    c.advance(3, []);
    c.setFrame(10);
    c.advance(DT, []);
    expect([c.getFrame(), c.isPlaying()]).toEqual([10, false]);
  });

  it("stop：置暂停位，清结束位和 mirror 方向位，时间归零", () => {
    const m = clock(30, 60, MIRROR);
    m.advance(2.25, []);
    expect(m.flags).toBe((MIRROR | BACK) >>> 0);
    m.stop();
    expect([m.t, m.flags, m.isPlaying()]).toEqual([0, (MIRROR | PAUSED) >>> 0, false]);
    m.play();
    m.advance(0.25, []);
    expect([m.t, m.flags]).toEqual([0.25, MIRROR]);

    const s = clock(30, 60, SINGLE);
    s.advance(3, []);
    s.stop();
    expect([s.t, s.flags]).toEqual([0, (SINGLE | PAUSED) >>> 0]);
  });
});

describe("事件（读码第 8 节）", () => {
  // 测试工程 p10-edge `evb`：数组顺序 b0、b60、b595、x
  const EVB: [string, number][] = [
    ["b0", 0],
    ["b60", 60],
    ["b595", 59.5],
    ["x", 30],
  ];

  it("事件时间 f(f(frame) × spf)：第 60 帧正好是 D", () => {
    expect(clock(30, 60, LOOP, false, EVB).events.map((event) => event.time)).toEqual([0, 2, 1.9833334684371948, 1]);
  });

  it("loop：第 0 帧在第一次推进与每次回绕触发；第 length 帧在回绕帧、先于第 0 帧；带小数帧照常", () => {
    const c = clock(30, 60, LOOP, false, EVB);
    const log: [number, string[]][] = [];
    for (let i = 1; i <= 90; i++) {
      const got = step(c, DT);
      if (got.length) log.push([i, got]);
    }
    expect(log).toEqual([
      [1, ["b0"]],
      [20, ["x"]],
      [40, ["b595"]],
      [41, ["b60", "b0"]],
      [61, ["x"]],
      [80, ["b595"]],
      [81, ["b60", "b0"]],
    ]);
  });

  it("一帧跨过多个：先按数组顺序收回绕前的，再收回绕后的（实测回绕帧 b60、b595、b0）", () => {
    const c = clock(30, 60, LOOP, false, EVB);
    const log: [number, string[]][] = [];
    for (let i = 1; i <= 120; i++) {
      const got = step(c, f(0.034));
      if (got.length) log.push([i, got]);
    }
    expect(log).toEqual([
      [1, ["b0"]],
      [30, ["x"]],
      [59, ["b60", "b595", "b0"]],
      [89, ["x"]],
      [118, ["b60", "b595", "b0"]],
    ]);
  });

  it("同一帧收到的按数组顺序，不按时间排序", () => {
    const c = clock(30, 60, LOOP, false, [
      ["e10", 10],
      ["e5", 5],
    ]);
    expect(step(c, 0.5)).toEqual(["e10", "e5"]);
  });

  it("loop 一帧跨多轮：回绕前的一段加回绕后余数里的，中间整轮不重复收", () => {
    const c = clock(30, 60, LOOP, false, EVB);
    expect(step(c, 4.1)).toEqual(["b0", "b60", "b595", "x", "b0"]);
    expect(c.t).toBe(0.09999990463256836);
  });

  it("loop 负向越过 0：先收 (t1, t0]，回绕后再收 (t, D]", () => {
    const c = clock(30, 60, LOOP, false, EVB);
    c.advance(0.1, []);
    expect(step(c, -0.2)).toEqual(["b0", "b60", "b595"]);
    expect(c.t).toBe(1.899999976158142);
  });

  it("mirror：正向、反向各触发一次（每 2D 两次）", () => {
    const c = clock(30, 60, MIRROR, false, [["m15", 15]]);
    const log: [number, string[]][] = [];
    for (let i = 1; i <= 40; i++) {
      const got = step(c, f(0.25));
      if (got.length) log.push([i, got]);
    }
    expect(log).toEqual([
      [3, ["m15"]],
      [15, ["m15"]],
      [19, ["m15"]],
      [31, ["m15"]],
      [35, ["m15"]],
    ]);
  });

  it("single：第 length 帧的事件在越过 D 那一帧触发（用未钳的 t1 比较；t1 正好等于 D 时不触发）", () => {
    const over = clock(30, 60, SINGLE, false, [["p60", 60]]);
    expect([step(over, 0.9), step(over, 0.9), step(over, 0.9)]).toEqual([[], [], ["p60"]]);
    const exact = clock(30, 60, SINGLE, false, [["p60", 60]]);
    expect([step(exact, 1), step(exact, 1), step(exact, 1)]).toEqual([[], [], []]);
    expect(exact.flags).toBe((SINGLE | DONE) >>> 0);
  });

  it("startpaused 期间不推进、不触发", () => {
    const c = clock(30, 60, LOOP, true, EVB);
    expect(step(c, DT)).toEqual([]);
    c.play();
    expect(step(c, DT)).toEqual(["b0"]);
  });
});
