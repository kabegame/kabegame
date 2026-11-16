/**
 * P12c-1 的 puppet 运行时单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12c-script.md` 点 2、点 5）：
 * 播完检测（rea-p12-runtime 3.1）、MDLA 事件的收集与派发顺序、控制口、`findLayer`、`carryOver` 接回可写字段与回调表。
 *
 * 用手搭的最小 puppet（一根骨骼、fps 10、length 10 → 一轮 1 s），不依赖 WPE 夹具；WPE 日志逐帧夹具要等 P12c-2 的脚本 API。
 */
import { describe, expect, it } from "vitest";
import type { PuppetAnimation, PuppetLayerDef } from "../compile/puppet";
import { ENDED, ScenePuppets, SETFRAME, type PuppetRig, type PuppetSink } from "./player";

const f = Math.fround;

function animation(
  mode: 0 | 1 | 2,
  events: { time: number; json: string }[] = [],
  extra: Partial<PuppetAnimation> = {},
): PuppetAnimation {
  const length = 10;
  const frames = new Float32Array((length + 1) * 10);
  for (let k = 0; k <= length; k++) {
    const o = k * 10;
    frames.set([0, 0, 0, 1, 0, 0, 0, 1, 1, 1], o);
  }
  return {
    id: 1,
    name: "a",
    mode,
    fps: 10,
    length,
    mask: new Uint8Array([1]),
    frames,
    alpha: null,
    alphaMask: new Uint8Array(0),
    morph: null,
    events,
    ...extra,
  };
}

function def(index: number, animationIndex: number, extra: Partial<PuppetLayerDef> = {}): PuppetLayerDef {
  return {
    animation: animationIndex,
    entry: index,
    name: `L${index}`,
    rate: 1,
    blend: 1,
    visible: true,
    additive: false,
    blendin: false,
    blendout: false,
    blendtime: 0.5,
    bindings: [],
    ...extra,
  };
}

function rig(animations: PuppetAnimation[], layers: PuppetLayerDef[]): PuppetRig {
  return {
    skeleton: {
      parents: new Int32Array([-1]),
      inverseBind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      rest: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1, 1]),
      restMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    },
    animations,
    layers,
    boneAlpha: false,
  };
}

/** 一个单层 puppet，返回运行时、控制口与「播完」计数。 */
function single(mode: 0 | 1 | 2, extra: Partial<PuppetLayerDef> = {}) {
  const puppets = new ScenePuppets([{ object: 3, puppet: rig([animation(mode)], [def(0, 0, extra)]) }]);
  const control = puppets.control(3, 0)!;
  let ended = 0;
  control.addEndedCallback(() => ended++);
  return { puppets, control, count: () => ended };
}

/** 每帧一个 dt，返回每帧是否触发了播完回调。 */
function run(puppets: ScenePuppets, count: () => number, dts: number[], sink?: PuppetSink): boolean[] {
  return dts.map((dt) => {
    const before = count();
    puppets.frame(dt, sink);
    return count() > before;
  });
}

describe("播完检测（rea-p12-runtime 3.1）", () => {
  it("loop：回绕那一帧触发，别的帧不触发", () => {
    const { puppets, count } = single(0);
    expect(run(puppets, count, [0.4, 0.4, 0.4, 0.4, 0.4])).toEqual([false, false, true, false, true]);
  });

  it("mirror：每次换向各触发一次（正向越过 D、反向越过 0）", () => {
    const { puppets, count } = single(1);
    // t：0.6 → 1.2 反射成 0.8（换向）→ 0.2 → −0.4 反射成 0.4（再换向）→ 1.0 ...
    expect(run(puppets, count, [0.6, 0.6, 0.6, 0.6])).toEqual([false, true, false, true]);
  });

  it("single：只在刚结束的那一帧触发一次，之后不再触发", () => {
    const { puppets, count } = single(2);
    expect(run(puppets, count, [0.6, 0.6, 0.6, 0.6])).toEqual([false, true, false, false]);
  });

  it("loop 负 rate：第一帧从 0 绕到 0.9 不触发，之后每帧 t0 > t 都触发（照抄 WPE）", () => {
    const { puppets, count } = single(0, { rate: -1 });
    expect(run(puppets, count, [0.1, 0.1, 0.1])).toEqual([false, true, true]);
  });

  it("loop rate 0：t 不动，判据是严格的 t0 > t，一帧都不触发", () => {
    const { puppets, count } = single(0, { rate: 0 });
    expect(run(puppets, count, [0.1, 0.1, 0.1])).toEqual([false, false, false]);
  });

  it("setFrame 那一帧不判，且 SETFRAME 在推进后清掉：下一次回绕照常触发", () => {
    const { puppets, control, count } = single(0);
    puppets.frame(0.1);
    control.setFrame(9.9); // t = 0.99
    // 这一帧推进越过 D 回绕，但 old 带 SETFRAME，不判
    expect(run(puppets, count, [0.1])).toEqual([false]);
    // 回绕后 t = 0.09，再推进 0.95 越过 D
    expect(run(puppets, count, [0.95])).toEqual([true]);
  });

  it("暂停、已结束的层不判；暂停后 play 的下一次回绕才触发", () => {
    const { puppets, control, count } = single(0);
    control.pause();
    expect(run(puppets, count, [2, 2])).toEqual([false, false]);
    control.play();
    expect(run(puppets, count, [0.6, 0.6])).toEqual([false, true]);
  });

  it("隐藏的层不推进、不判，SETFRAME 保留到下次推进才清", () => {
    const { puppets, control, count } = single(0);
    let visible = false;
    const sink: PuppetSink = {
      animationLayer: () => ({ rate: 1, blend: 1, visible }),
    };
    control.setFrame(9.9);
    expect(run(puppets, count, [0.5, 0.5], sink)).toEqual([false, false]);
    expect(control.getFrame()).toBeCloseTo(9.9, 4); // 没推进
    visible = true;
    // 可见后第一次推进越过 D：带着 SETFRAME，不判
    expect(run(puppets, count, [0.5], sink)).toEqual([false]);
    // SETFRAME 已在上一次推进后清掉：t 现在 0.49，再推进 0.6 越过 D，照常判
    expect(run(puppets, count, [0.6], sink)).toEqual([true]);
  });
});

describe("事件的收集与派发顺序", () => {
  it("事件先于播完回调；按层序 × 事件表顺序；每个 puppet 推进完全部层才派发", () => {
    const events0 = [
      { time: 0.1, json: '{"e":"a0"}' },
      { time: 0.5, json: '{"e":"b0"}' },
    ];
    const events1 = [{ time: 0.1, json: '{"e":"a1"}' }];
    const puppets = new ScenePuppets([
      { object: 7, puppet: rig([animation(0, events0), animation(0, events1)], [def(0, 0), def(1, 1)]) },
    ]);
    const log: string[] = [];
    puppets.control(7, 0)!.addEndedCallback(() => log.push("end0"));
    puppets.control(7, 1)!.addEndedCallback(() => log.push("end1"));
    const hooks = {
      event: (object: number, json: string) => {
        // 派发时两层都已推进：第 1 层的帧号反映本帧结果
        log.push(`${object}:${(JSON.parse(json) as { e: string }).e}@${puppets.control(7, 1)!.getFrame().toFixed(1)}`);
      },
    };
    puppets.frame(0.6, null, hooks); // [0, 0.6)：层 0 的 a0、b0，层 1 的 a1
    puppets.frame(0.6, null, hooks); // 1.2 回绕：[0.6, 1.2) 无，再 [0, 0.2)：a0、a1；两层播完
    expect(log).toEqual([
      "7:a0@6.0",
      "7:b0@6.0",
      "7:a1@6.0",
      // 第二帧：层 0 的 [0.6,1.2) 无事件，回绕后 [0,0.2) 收 a0；层 1 同理收 a1；
      "7:a0@2.0",
      "7:a1@2.0",
      "end0",
      "end1",
    ]);
  });

  it("没有 hooks 时事件照样清空（不累积到下一帧）", () => {
    const puppets = new ScenePuppets([
      { object: 1, puppet: rig([animation(0, [{ time: 0.1, json: "{}" }])], [def(0, 0)]) },
    ]);
    const seen: string[] = [];
    puppets.frame(0.5);
    puppets.frame(0.1, null, { event: (_object, json) => seen.push(json) });
    expect(seen).toEqual([]);
  });

  it("refresh（d === null）不推进、不派发、不判播完", () => {
    const { puppets, count } = single(0);
    puppets.refresh();
    puppets.refresh();
    expect(count()).toBe(0);
  });
});

describe("模型对象", () => {
  const modelSink = (visible: () => boolean, blend: () => number): PuppetSink => ({
    animationLayer: () => ({ rate: 1, blend: blend(), visible: true }),
    visible,
  });

  it("权重 0 的层照样推进、收事件、判播完", () => {
    const puppets = new ScenePuppets([
      {
        object: 2,
        kind: "model",
        puppet: rig([animation(0, [{ time: 0.1, json: "{}" }])], [def(0, 0)]),
      },
    ]);
    let ended = 0;
    puppets.control(2, 0)!.addEndedCallback(() => ended++);
    const events: string[] = [];
    const sink = modelSink(
      () => true,
      () => 0,
    );
    puppets.frame(0.6, sink, { event: (_o, json) => events.push(json) });
    puppets.frame(0.6, sink, { event: (_o, json) => events.push(json) });
    expect(ended).toBe(1);
    expect(events).toEqual(["{}", "{}"]); // 第一帧 [0,0.6) 一个，第二帧回绕后 [0,0.2) 一个
  });

  it("对象不可见（更新门）：时钟冻结、不收事件、不判播完", () => {
    const puppets = new ScenePuppets([
      {
        object: 2,
        kind: "model",
        puppet: rig([animation(0, [{ time: 0.1, json: "{}" }])], [def(0, 0)]),
      },
    ]);
    let ended = 0;
    puppets.control(2, 0)!.addEndedCallback(() => ended++);
    const events: string[] = [];
    const sink = modelSink(
      () => false,
      () => 1,
    );
    for (let i = 0; i < 3; i++) puppets.frame(0.6, sink, { event: (_o, json) => events.push(json) });
    expect(ended).toBe(0);
    expect(events).toEqual([]);
    expect(puppets.control(2, 0)!.getFrame()).toBe(0);
  });
});

describe("控制口", () => {
  it("只读三项：fps = f32(1 / spf)，frameCount = length，duration = D", () => {
    const { control } = single(0);
    expect(control.fps).toBe(f(1 / f(1 / 10)));
    expect(control.frameCount).toBe(10);
    expect(control.duration).toBe(f(10 / 10));
  });

  it("setFrame：t = f32(spf × f32(frame))，置 SETFRAME；getFrame 取 t / spf；stop 不清 SETFRAME", () => {
    const { puppets, control } = single(0);
    control.setFrame(3.3);
    expect(control.getFrame()).toBe(f(f(f(1 / 10) * f(3.3)) / f(1 / 10)));
    control.stop();
    expect(control.getFrame()).toBe(0);
    expect(control.isPlaying()).toBe(false);
    // SETFRAME 仍在：play 后第一帧即使回绕也不判
    let ended = 0;
    control.addEndedCallback(() => ended++);
    control.play();
    puppets.frame(1.5);
    expect(ended).toBe(0);
  });

  it("additive / blendin / blendout / blendtime / name 可写，别的类型由调用方过滤", () => {
    const { control } = single(0, { additive: true });
    expect(control.additive).toBe(true);
    control.additive = false;
    control.blendin = true;
    control.blendout = true; // 循环层也收（rea-p12c-script 1.7）
    control.blendtime = 0.25;
    control.name = "run";
    expect(control).toMatchObject({
      additive: false,
      blendin: true,
      blendout: true,
      blendtime: 0.25,
      name: "run",
    });
  });

  it("layerCount / layer：不是 puppet 的对象为 0 / null，越界为 null；控制口是同一个对象", () => {
    const { puppets, control } = single(0);
    expect(puppets.layerCount(3)).toBe(1);
    expect(puppets.layerCount(99)).toBe(0);
    expect(puppets.control(99, 0)).toBeNull();
    expect(puppets.control(3, 1)).toBeNull();
    expect(puppets.control(3, -1)).toBeNull();
    expect(puppets.control(3, 0)).toBe(control);
  });

  it("静态 puppet（skeleton 为 null）不进运行时：层数 0", () => {
    const puppets = new ScenePuppets([{ object: 4, puppet: { ...rig([], []), skeleton: null } }]);
    expect(puppets.layerCount(4)).toBe(0);
  });
});

describe("findLayer", () => {
  it("取最后一个匹配；空串不匹配；找不到 null；改名后按新名字找（返回层 id）", () => {
    const puppets = new ScenePuppets([
      {
        object: 5,
        puppet: rig(
          [animation(0), animation(0)],
          [def(0, 0, { name: "walk" }), def(1, 1, { name: "walk" }), def(2, 0, { name: "" })],
        ),
      },
    ]);
    expect(puppets.findLayer(5, "walk")).toBe(1);
    expect(puppets.findLayer(5, "")).toBeNull();
    expect(puppets.findLayer(5, "run")).toBeNull();
    expect(puppets.findLayer(6, "walk")).toBeNull();
    puppets.control(5, 0)!.name = "run";
    expect(puppets.findLayer(5, "run")).toBe(0);
    puppets.control(5, 1)!.name = "run";
    expect(puppets.findLayer(5, "run")).toBe(1);
    expect(puppets.findLayer(5, "walk")).toBeNull();
  });
});

describe("carryOver 接回可写字段与回调表", () => {
  const build = () => new ScenePuppets([{ object: 3, puppet: rig([animation(0)], [def(0, 0)]) }]);

  it("名字、additive / blendin / blendout 三位、blendtime、回调表（同一个数组）、SETFRAME、时钟位都接回", () => {
    const old = build();
    const control = old.control(3, 0)!;
    control.name = "x";
    control.additive = true;
    control.blendin = false;
    control.blendout = true;
    control.blendtime = 0.125;
    let ended = 0;
    control.addEndedCallback(() => ended++);
    control.setFrame(9.9);
    old.frame(0.0001); // 推进一小步会清 SETFRAME，所以不推进：直接接回
    control.setFrame(9.9);
    const next = build();
    next.carryOver(old);
    const carried = next.control(3, 0)!;
    expect(carried).toMatchObject({ name: "x", additive: true, blendin: false, blendout: true, blendtime: 0.125 });
    expect(carried.getFrame()).toBeCloseTo(9.9, 4);
    // SETFRAME 接回：新运行时第一帧越过 D 也不判；回调表是接回的那一个
    next.frame(0.2);
    expect(ended).toBe(0);
    next.frame(0.9); // t 0.19 → 1.09 回绕到 0.09（一帧跨多轮时 t0 > t 不成立，照 WPE 不判，所以不用 1.5）
    expect(ended).toBe(1);
  });

  it("动画变了（fps 不同）不接：从定义重来，回调表为空", () => {
    const old = build();
    old.control(3, 0)!.name = "x";
    old.control(3, 0)!.addEndedCallback(() => {
      throw new Error("不该被调");
    });
    const next = new ScenePuppets([{ object: 3, puppet: rig([animation(0, [], { fps: 20 })], [def(0, 0)]) }]);
    next.carryOver(old);
    expect(next.control(3, 0)!.name).toBe("L0");
    next.frame(2);
  });

  it("位常量与 WPE 相同", () => {
    expect(SETFRAME).toBe(0x02000000);
    expect(ENDED).toBe(0x04000000);
  });
});
