/**
 * P12e-1 的运行时单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12e-createlayer.md` 点 2、行为对照表）：
 * 层 id（编译期 = `entry`、运行时负数）、`createLayer` 的插入 / 初值 / blendout、单次层（`SINGLE_SHOT` → `DOOMED`）与回调循环
 * （`anyEnded` 门、复位下标的漏扫）、`destroyLayers` 的摘表 / `settle` 的释放、`carryOver` 按 id 接回。
 * 对照表行：7、8、10–18、20–24、26、27、30（运行时部分）；脚本入口、作废与规整在 P12e-2。
 */
import { describe, expect, it, vi } from "vitest";
import type { PuppetAnimation, PuppetLayerDef } from "../compile/puppet";
import {
  DOOMED,
  ENDED,
  ScenePuppets,
  SETFRAME,
  SINGLE_SHOT,
  stateSink,
  type AnimationLayerItem,
  type PuppetHooks,
  type PuppetRig,
  type PuppetSink,
} from "./player";

/** 单骨骼；第 k 帧平移 x = 10k（皮肤矩阵的平移在 `skin[9]`），所以层的贡献看得见。 */
function animation(id: number, mode: 0 | 1 | 2, length = 2, extra: Partial<PuppetAnimation> = {}): PuppetAnimation {
  const frames = new Float32Array((length + 1) * 10);
  for (let k = 0; k <= length; k++) frames.set([10 * k, 0, 0, 1, 0, 0, 0, 1, 1, 1], k * 10);
  return {
    id,
    name: `a${id}`,
    mode,
    fps: 10,
    length,
    mask: new Uint8Array([1]),
    frames,
    alpha: null,
    alphaMask: new Uint8Array(0),
    morph: null,
    events: [],
    ...extra,
  };
}

function def(entry: number, animationIndex: number, extra: Partial<PuppetLayerDef> = {}): PuppetLayerDef {
  return {
    animation: animationIndex,
    entry,
    name: `L${entry}`,
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

function rig(animations: PuppetAnimation[], layers: PuppetLayerDef[], extra: Partial<PuppetRig> = {}): PuppetRig {
  return {
    skeleton: {
      parents: new Int32Array([-1]),
      inverseBind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      rest: new Float32Array([0, 0, 0, 0.99936533, 0, 0, 0, 1, 1, 1]),
      restMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    },
    animations,
    layers,
    boneAlpha: false,
    ...extra,
  };
}

function item(animationIndex: number, extra: Partial<AnimationLayerItem> = {}): AnimationLayerItem {
  return {
    animation: animationIndex,
    name: "",
    rate: 1,
    blend: 1,
    visible: true,
    additive: false,
    blendin: false,
    blendout: false,
    blendtime: 0.5,
    autosort: false,
    index: null,
    ...extra,
  };
}

/** 层表里每层的名字（顺序）。 */
const names = (puppets: ScenePuppets, object: number) =>
  puppets.ids(object).map((id) => puppets.control(object, id)!.name);

/** 皮肤矩阵里骨骼 0 的 x 平移。 */
const skinX = (puppets: ScenePuppets, object: number) => puppets.skin(object)![9];

/** 摘出一层的运行时位（测试读内部：回调里 DOOMED 是否已置位）。 */
function clockFlags(puppets: ScenePuppets, object: number, id: number): number {
  const runtime = (
    puppets as unknown as { byObject: Map<number, { byId: Map<number, { clock: { flags: number } }> }> }
  ).byObject.get(object)!;
  return runtime.byId.get(id)!.clock.flags;
}

/** D = 0.2 的 loop，步长 0.15：从第二帧起每帧都回绕（loop 按 `t0 > t` 判回绕，第一帧不算）。 */
const WRAP = 0.15;

const LOOP = 0 as const;
const MIRROR = 1 as const;
const SINGLE = 2 as const;

describe("层 id（P12e）：编译期 = entry，层表位置另算", () => {
  it("ids / control / findLayer 都是 id；entry 与层表位置错开时（前面的项被丢）按 entry", () => {
    const puppets = new ScenePuppets([
      { object: 1, puppet: rig([animation(1, LOOP)], [def(3, 0, { name: "x" }), def(5, 0, { name: "y" })]) },
    ]);
    expect(puppets.ids(1)).toEqual([3, 5]);
    expect(puppets.control(1, 5)!.name).toBe("y");
    expect(puppets.control(1, 0)).toBeNull();
    expect(puppets.findLayer(1, "y")).toBe(5);
    expect(puppets.findLayer(1, "nope")).toBeNull();
    expect(puppets.alive(1, 3)).toBe(true);
    expect(puppets.alive(1, 4)).toBe(false);
    expect(puppets.layerCount(1)).toBe(2);
  });

  it("PuppetSink 按 id 读字段：状态里的值（rate 0）让这一层不推进", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP, 20)], [def(7, 0)]) }]);
    const sink: PuppetSink = {
      animationLayer: (object, id) => (object === 1 && id === 7 ? { rate: 0, blend: 1, visible: true } : undefined),
    };
    puppets.frame(0.1, sink);
    expect(puppets.control(1, 7)!.getFrame()).toBe(0);
    puppets.frame(0.1);
    expect(puppets.control(1, 7)!.getFrame()).toBeCloseTo(1);
  });
});

describe("createLayer：初值、blendout、id（对照表 6 的运行时部分、7、10、12）", () => {
  it("追加到层表末尾，id 从 −1 起递减不复用；初值：在播放、第 0 帧、没有 SETFRAME", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP, 20)], [def(0, 0)]) }]);
    puppets.frame(0.1);
    const a = puppets.createLayer(1, item(0, { name: "n" }), false);
    const b = puppets.createLayer(1, item(0), false);
    expect([a, b]).toEqual([-1, -2]);
    expect(puppets.ids(1)).toEqual([0, -1, -2]);
    const control = puppets.control(1, -1)!;
    expect(control.name).toBe("n");
    expect(control.isPlaying()).toBe(true);
    // 建层本身不推进：第 0 帧；下一帧才第一次推进（t = dt × rate）
    expect(control.getFrame()).toBe(0);
    puppets.frame(0.1);
    expect(control.getFrame()).toBeCloseTo(1);
    // 删掉再建：id 不复用
    puppets.destroyLayers(1, { id: -1 });
    puppets.settle();
    expect(puppets.createLayer(1, item(0), false)).toBe(-3);
  });

  it("不是带骨骼的运行时、动画下标越界、动画带 unsupported 返回 null", () => {
    const puppets = new ScenePuppets([
      {
        object: 1,
        puppet: rig([animation(1, LOOP), animation(2, LOOP, 2, { unsupported: ["puppet:animation-ref"] })], []),
      },
    ]);
    expect(puppets.createLayer(9, item(0), false)).toBeNull();
    expect(puppets.createLayer(1, item(5), false)).toBeNull();
    expect(puppets.createLayer(1, item(-1), false)).toBeNull();
    expect(puppets.createLayer(1, item(1), false)).toBeNull();
    expect(puppets.ids(1)).toEqual([]);
    expect(puppets.createLayer(1, item(0), false)).toBe(-1);
  });

  it("blendout 只在 single 模式的动画上保留；loop / mirror 清掉（config 想开也不行）", () => {
    const puppets = new ScenePuppets([
      { object: 1, puppet: rig([animation(1, LOOP), animation(2, MIRROR), animation(3, SINGLE)], []) },
    ]);
    const ids = [0, 1, 2].map((index) => puppets.createLayer(1, item(index, { blendout: true }), false)!);
    expect(ids.map((id) => puppets.control(1, id)!.blendout)).toEqual([false, false, true]);
    // single 模式但 config 关掉 blendout：保持关
    const off = puppets.createLayer(1, item(2, { blendout: false }), false)!;
    expect(puppets.control(1, off)!.blendout).toBe(false);
  });

  it("additive / blendin 位与 blendtime、name 取自 item", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP)], []) }]);
    const id = puppets.createLayer(1, item(0, { additive: true, blendin: true, blendtime: 2, name: "q" }), false)!;
    expect(puppets.control(1, id)).toMatchObject({ additive: true, blendin: true, blendtime: 2, name: "q" });
  });

  it("新层第一次推进就做播完检测（没有 SETFRAME）：大 rate 的 single / mirror 首帧就到头 / 换向，调回调", () => {
    for (const mode of [SINGLE, MIRROR]) {
      const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, mode)], []) }]);
      const id = puppets.createLayer(1, item(0, { rate: 5 }), false)!;
      const ended = vi.fn();
      puppets.control(1, id)!.addEndedCallback(ended);
      expect(clockFlags(puppets, 1, id) & SETFRAME).toBe(0);
      puppets.frame(0.1);
      expect(ended, `mode ${mode}`).toHaveBeenCalledTimes(1);
    }
  });
});

describe("createLayer 的插入位置（对照表 8，rea-p12c 第 7 节、实测 4）", () => {
  /** 四层：L0 L1 普通，L2 L3 加法层。 */
  const base = () =>
    new ScenePuppets([
      {
        object: 1,
        puppet: rig(
          [animation(1, LOOP)],
          [def(0, 0), def(1, 0), def(2, 0, { additive: true }), def(3, 0, { additive: true })],
        ),
      },
    ]);
  const order = (extra: Partial<AnimationLayerItem>) => {
    const puppets = base();
    puppets.createLayer(1, item(0, { name: "N", ...extra }), false);
    return names(puppets, 1).join(",");
  };

  it("没有 index / autosort：追加", () => {
    expect(order({})).toBe("L0,L1,L2,L3,N");
  });

  it("index 0 / 2 插到该位置之前", () => {
    expect(order({ index: 0 })).toBe("N,L0,L1,L2,L3");
    expect(order({ index: 2 })).toBe("L0,L1,N,L2,L3");
    expect(order({ index: 1 })).toBe("L0,N,L1,L2,L3");
  });

  it("index 负数、≥ 层数 − 1、超大都插在最后一层之前（永远插不到末尾）", () => {
    for (const index of [-3, -1, 3, 4, 5, 999, 2 ** 31 - 1])
      expect(order({ index }), String(index)).toBe("L0,L1,L2,N,L3");
  });

  it("autosort：插在末尾的连续加法层之前（第一个非加法层之后）", () => {
    expect(order({ autosort: true })).toBe("L0,L1,N,L2,L3");
    // autosort 优先于 index
    expect(order({ autosort: true, index: 0 })).toBe("L0,L1,N,L2,L3");
  });

  it("autosort 看的是层当前的加法位（脚本能改）", () => {
    const puppets = base();
    puppets.control(1, 3)!.additive = false;
    puppets.createLayer(1, item(0, { name: "N", autosort: true }), false);
    expect(names(puppets, 1).join(",")).toBe("L0,L1,L2,L3,N");
  });

  it("一个非加法层都没有（全是加法层、空表）：插到 0（WPE 越界写，有意不同）；空表上 index ≠ 0 同样插到 0", () => {
    const additive = new ScenePuppets([
      { object: 1, puppet: rig([animation(1, LOOP)], [def(0, 0, { additive: true }), def(1, 0, { additive: true })]) },
    ]);
    additive.createLayer(1, item(0, { name: "N", autosort: true }), false);
    expect(names(additive, 1).join(",")).toBe("N,L0,L1");
    for (const extra of [{ autosort: true }, { index: 0 }, { index: 3 }, { index: -2 }]) {
      const empty = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP)], []) }]);
      empty.createLayer(1, item(0, { name: "N", ...extra }), false);
      expect(names(empty, 1), JSON.stringify(extra)).toEqual(["N"]);
    }
  });

  it("单层表：index 1 与更大的落到 n − 1 = 0（插到唯一一层之前）", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP)], [def(0, 0)]) }]);
    puppets.createLayer(1, item(0, { name: "N", index: 5 }), false);
    expect(names(puppets, 1)).toEqual(["N", "L0"]);
  });

  it("插入的层参与顺序相关的混合：普通层在前、新层覆盖（后写的层盖在前面的上面）", () => {
    // L0 在第 2 帧（x = 20），新层 blend 1 在第 0 帧（x = 0）：新层排在 L0 之后时结果是 0，排在前面时是 20
    const make = (index: number | null) => {
      const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, LOOP, 20)], [def(0, 0)]) }]);
      puppets.control(1, 0)!.setFrame(2);
      const id = puppets.createLayer(1, item(0, { index }), false)!;
      puppets.control(1, id)!.setFrame(0);
      puppets.frame(0.0001);
      return skinX(puppets, 1);
    };
    expect(make(null)).toBeCloseTo(0, 1);
    expect(make(0)).toBeCloseTo(20, 1);
  });
});

describe("单次层与回调循环（对照表 13、15–18、23、24）", () => {
  it("playSingleAnimation 的 single 动画：到头那一帧回调（层有效、层数未减、0 个参数），同一帧回调之后就删掉", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const released = vi.fn();
    const id = puppets.createLayer(1, item(0), true)!;
    const during: unknown[] = [];
    const callback = vi.fn(() => {
      during.push([puppets.alive(1, id), puppets.ids(1).length, clockFlags(puppets, 1, id) & DOOMED]);
    });
    puppets.control(1, id)!.addEndedCallback(callback);
    puppets.frame(0.1, null, { released });
    expect(callback).not.toHaveBeenCalled();
    expect(puppets.alive(1, id)).toBe(true);
    puppets.frame(0.15, null, { released });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith();
    // 回调里：有效、计数没减，而且 DOOMED 已经置位（先标删再调回调）
    expect(during).toEqual([[true, 1, DOOMED]]);
    // 同一帧派发结束时已释放：不在层表、包装作废、通知宿主
    expect(puppets.ids(1)).toEqual([]);
    expect(puppets.alive(1, id)).toBe(false);
    expect(puppets.control(1, id)).toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith(1, id);
  });

  it("单次层被删的那一帧仍参与姿势（采样发生在删除之前），下一帧没有它的贡献", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const id = puppets.createLayer(1, item(0), true)!;
    puppets.frame(0.1);
    expect(skinX(puppets, 1)).toBeCloseTo(10, 1);
    puppets.frame(0.15); // 到头：t 钳到 D；这一帧的姿势照样含这一层（x 非 0），层却已经释放
    expect(puppets.alive(1, id)).toBe(false);
    expect(skinX(puppets, 1)).toBeGreaterThan(5);
    puppets.frame(0.1);
    expect(skinX(puppets, 1)).toBe(0);
  });

  it("loop 动画的单次层：第一次回绕那一帧就删；mirror：第一次换向", () => {
    for (const mode of [LOOP, MIRROR]) {
      const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, mode)], []) }]);
      const id = puppets.createLayer(1, item(0), true)!;
      const callback = vi.fn();
      puppets.control(1, id)!.addEndedCallback(callback);
      puppets.frame(0.1);
      expect(puppets.alive(1, id), `mode ${mode}`).toBe(true);
      puppets.frame(0.15);
      expect(callback, `mode ${mode}`).toHaveBeenCalledTimes(1);
      expect(puppets.alive(1, id), `mode ${mode}`).toBe(false);
    }
  });

  it("不是 single 的层（createAnimationLayer）：播完照调回调，但不删", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const id = puppets.createLayer(1, item(0), false)!;
    const callback = vi.fn();
    puppets.control(1, id)!.addEndedCallback(callback);
    puppets.frame(0.5);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(puppets.alive(1, id)).toBe(true);
    expect(clockFlags(puppets, 1, id) & (SINGLE_SHOT | DOOMED)).toBe(0);
  });

  it("没有回调的单次层照删", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const id = puppets.createLayer(1, item(0), true)!;
    puppets.frame(0.5);
    expect(puppets.alive(1, id)).toBe(false);
  });

  it("回调里 play() + setFrame(0) 救不回：DOOMED 只有删除时看", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const id = puppets.createLayer(1, item(0), true)!;
    const control = puppets.control(1, id)!;
    control.addEndedCallback(() => {
      control.play();
      control.setFrame(0);
      control.stop();
      control.play();
    });
    puppets.frame(0.5);
    expect(puppets.alive(1, id)).toBe(false);
  });

  it("隐藏的单次层不推进、永不删；暂停的不删", () => {
    const hidden = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const id = hidden.createLayer(1, item(0, { visible: false }), true)!;
    const sink: PuppetSink = { animationLayer: () => ({ rate: 1, blend: 1, visible: false }) };
    for (let i = 0; i < 5; i++) hidden.frame(0.5, sink);
    expect(hidden.alive(1, id)).toBe(true);
    expect(hidden.control(1, id)!.getFrame()).toBe(0);

    const paused = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const pausedId = paused.createLayer(1, item(0), true)!;
    paused.control(1, pausedId)!.pause();
    for (let i = 0; i < 5; i++) paused.frame(0.5);
    expect(paused.alive(1, pausedId)).toBe(true);
  });

  it("回调里删自己（含单次层）只释放一次：层在 detached，由 settle 释放，派发末尾的删除循环看不到", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rig([animation(1, SINGLE)], []) }]);
    const released = vi.fn();
    const hooks: PuppetHooks = { released };
    const id = puppets.createLayer(1, item(0), true)!;
    puppets.control(1, id)!.addEndedCallback(() => {
      expect(puppets.destroyLayers(1, { id })).toBe(true);
    });
    puppets.frame(0.5, null, hooks);
    expect(released).not.toHaveBeenCalled();
    expect(puppets.ids(1)).toEqual([]);
    expect(puppets.alive(1, id)).toBe(true);
    puppets.settle(hooks);
    puppets.settle(hooks);
    expect(released).toHaveBeenCalledTimes(1);
    expect(puppets.alive(1, id)).toBe(false);
  });

  /** 三层 loop（A B C）预热后每帧都回绕；返回按调用顺序记下的日志。 */
  function three(callbacks: (puppets: ScenePuppets, log: string[]) => void) {
    const puppets = new ScenePuppets([
      {
        object: 1,
        puppet: rig(
          [animation(1, LOOP, 2)],
          [def(0, 0, { name: "A" }), def(1, 0, { name: "B" }), def(2, 0, { name: "C" })],
        ),
      },
    ]);
    const log: string[] = [];
    callbacks(puppets, log);
    // 预热一帧（t = 0.15）：loop 的回绕按 `t0 > t` 判，之后每个 `frame(WRAP)` 都回绕
    puppets.frame(WRAP);
    return { puppets, log };
  }

  it("不删时每个播完的层同帧都调（顺序 = 层表顺序）", () => {
    const { puppets, log } = three((puppets, log) => {
      for (const id of [0, 1, 2]) puppets.control(1, id)!.addEndedCallback(() => log.push(`cb${id}`));
    });
    puppets.frame(WRAP);
    expect(log).toEqual(["cb0", "cb1", "cb2"]);
  });

  it("A 的回调里删 A：B 本轮漏掉（复位下标后从 1 重扫），C 照调；B 的 ENDED 留着、之后没有层播完时也不调", () => {
    const { puppets, log } = three((puppets, log) => {
      puppets.control(1, 0)!.addEndedCallback(() => {
        log.push("cbA");
        puppets.destroyLayers(1, { id: 0 });
      });
      puppets.control(1, 1)!.addEndedCallback(() => log.push("cbB"));
      puppets.control(1, 2)!.addEndedCallback(() => log.push("cbC"));
    });
    puppets.frame(WRAP);
    expect(log).toEqual(["cbA", "cbC"]);
    expect(clockFlags(puppets, 1, 1) & ENDED).toBe(ENDED);
    // 本帧没有层播完（anyEnded 为假）：不进回调循环，B 的陈旧 ENDED 不会被处理
    log.length = 0;
    puppets.frame(0.01);
    expect(log).toEqual([]);
    expect(clockFlags(puppets, 1, 1) & ENDED).toBe(ENDED);
    // 下一次有层回绕才调（B、C 同帧回绕，B 先于 C）
    puppets.frame(WRAP);
    expect(log).toEqual(["cbB", "cbC"]);
  });

  it("B 的回调里删 A（下标 0）：复位后从 1 重扫，C 照调（不复位的话 C 会被漏掉）", () => {
    const { puppets, log } = three((puppets, log) => {
      puppets.control(1, 0)!.addEndedCallback(() => log.push("cbA"));
      puppets.control(1, 1)!.addEndedCallback(() => {
        log.push("cbB");
        puppets.destroyLayers(1, { id: 0 });
      });
      puppets.control(1, 2)!.addEndedCallback(() => log.push("cbC"));
    });
    puppets.frame(WRAP);
    expect(log).toEqual(["cbA", "cbB", "cbC"]);
  });

  it("单次层删除循环与回调循环分开：回调循环里被 DOOMED 的层在循环结束后一起删", () => {
    const puppets = new ScenePuppets([
      {
        object: 1,
        puppet: rig([animation(1, SINGLE, 1), animation(2, LOOP, 1)], [def(0, 1, { name: "keep" })]),
      },
    ]);
    const a = puppets.createLayer(1, item(0), true)!;
    const b = puppets.createLayer(1, item(0), true)!;
    puppets.frame(0.25);
    expect(puppets.ids(1)).toEqual([0]);
    expect(puppets.alive(1, a) || puppets.alive(1, b)).toBe(false);
  });
});

describe("destroyLayers / settle（对照表 20–22）", () => {
  const make = () =>
    new ScenePuppets([
      {
        object: 1,
        puppet: rig(
          [animation(1, LOOP, 20)],
          [def(0, 0, { name: "a" }), def(1, 0, { name: "x" }), def(2, 0, { name: "x" }), def(3, 0, { name: "z" })],
        ),
      },
      { object: 2, puppet: rig([animation(1, LOOP, 20)], [def(0, 0, { name: "other" })]) },
    ]);

  it("当场摘表：计数、下标、名字查找立刻看不到；同一帧包装（控制口）照常可用，settle 才释放", () => {
    const puppets = make();
    const released = vi.fn();
    expect(puppets.destroyLayers(1, { name: "z" })).toBe(true);
    expect(puppets.ids(1)).toEqual([0, 1, 2]);
    expect(puppets.layerCount(1)).toBe(3);
    expect(puppets.findLayer(1, "z")).toBeNull();
    expect(puppets.detachedCount(1)).toBe(1);
    // 摘出但没释放：控制口还在、还能读写、调方法
    expect(puppets.alive(1, 3)).toBe(true);
    const control = puppets.control(1, 3)!;
    control.setFrame(4);
    expect(control.getFrame()).toBe(4);
    expect(released).not.toHaveBeenCalled();
    puppets.settle({ released });
    expect(released).toHaveBeenCalledWith(1, 3);
    expect(puppets.alive(1, 3)).toBe(false);
    expect(puppets.control(1, 3)).toBeNull();
    expect(puppets.detachedCount(1)).toBe(0);
    // 摘出的层不再参与推进：它的帧停在摘出时（frame 4）
    puppets.frame(0.1);
    expect(control.getFrame()).toBe(4);
  });

  it("按名字删所有同名（相邻两个都删，包括层表里最后一个匹配——WPE 在这里崩溃，我们照删）；区分大小写，空串不匹配", () => {
    const puppets = make();
    expect(puppets.destroyLayers(1, { name: "X" })).toBe(false);
    expect(puppets.destroyLayers(1, { name: "" })).toBe(false);
    expect(puppets.destroyLayers(1, { name: "nope" })).toBe(false);
    expect(puppets.destroyLayers(1, { name: "x" })).toBe(true);
    expect(names(puppets, 1)).toEqual(["a", "z"]);
    // 末尾同名：把 z 改名成 a 后，按名字删掉 a（含最后一个）
    puppets.control(1, 3)!.name = "a";
    expect(puppets.destroyLayers(1, { name: "a" })).toBe(true);
    expect(puppets.ids(1)).toEqual([]);
    expect(puppets.detachedCount(1)).toBe(4);
  });

  it("按下标：0 ≤ i < 层数；层数本身、负数、非整数都是 false", () => {
    const puppets = make();
    for (const index of [4, 5, -1, 1.5, Number.NaN, 2 ** 31])
      expect(puppets.destroyLayers(1, { index }), String(index)).toBe(false);
    expect(puppets.ids(1)).toEqual([0, 1, 2, 3]);
    expect(puppets.destroyLayers(1, { index: 3 })).toBe(true);
    expect(puppets.destroyLayers(1, { index: 0 })).toBe(true);
    expect(puppets.ids(1)).toEqual([1, 2]);
  });

  it("按 id：要在当前层表里（摘出未释放的、别的 puppet 的、不存在的都是 false）", () => {
    const puppets = make();
    expect(puppets.destroyLayers(1, { id: 99 })).toBe(false);
    expect(puppets.destroyLayers(1, { id: 0 })).toBe(true);
    expect(puppets.destroyLayers(1, { id: 0 })).toBe(false); // 同帧再删同一层
    puppets.settle();
    expect(puppets.destroyLayers(1, { id: 0 })).toBe(false);
    // 两个 puppet 都有 id 0：对象 2 删自己的，不影响对象 1
    expect(puppets.destroyLayers(2, { id: 0 })).toBe(true);
    expect(puppets.ids(1)).toEqual([1, 2, 3]);
    expect(puppets.destroyLayers(9, { id: 0 })).toBe(false);
  });

  it("运行时层删除不进 destroyedEntries（只有编译期层记）；删光后再建，id 继续递减", () => {
    const puppets = make();
    const id = puppets.createLayer(1, item(0), false)!;
    expect(puppets.destroyLayers(1, { id })).toBe(true);
    puppets.settle();
    for (const index of [0, 0, 0, 0]) puppets.destroyLayers(1, { index });
    puppets.settle();
    expect(puppets.ids(1)).toEqual([]);
    expect(puppets.createLayer(1, item(0), false)).toBe(id - 1);
  });
});

describe("两个 puppet 的帧内顺序（对照表 11）", () => {
  /** 两个 puppet：对象 1 在前、对象 2 在后；各一个每帧回绕的 loop 层 `w`，另有慢 loop 动画给建出来的层用。 */
  function pair() {
    const animations = () => [animation(1, LOOP, 2), animation(2, LOOP, 20)];
    const puppets = new ScenePuppets([
      { object: 1, puppet: rig(animations(), [def(0, 0, { name: "w" })]) },
      { object: 2, puppet: rig(animations(), [def(0, 0, { name: "w" })]) },
    ]);
    puppets.frame(WRAP); // 预热：之后每帧都回绕
    return puppets;
  }

  it("前面的 puppet 的回调给后面的 puppet 建层：同一帧就被推进", () => {
    const puppets = pair();
    let created = 0;
    puppets.control(1, 0)!.addEndedCallback(() => {
      created = puppets.createLayer(2, item(1), false)!;
    });
    puppets.frame(WRAP);
    expect(puppets.control(2, created)!.getFrame()).toBeCloseTo(1.5, 4);
  });

  it("后面的 puppet 的回调给前面的 puppet 建层：这一帧已经推进完了，下一帧才第一次推进", () => {
    const puppets = pair();
    let created = 0;
    puppets.control(2, 0)!.addEndedCallback(() => {
      created = puppets.createLayer(1, item(1), false)!;
    });
    puppets.frame(WRAP);
    expect(puppets.control(1, created)!.getFrame()).toBe(0);
    puppets.frame(0.01); // 不再回绕：新层第一次推进 0.01 s = 0.1 帧
    expect(puppets.control(1, created)!.getFrame()).toBeCloseTo(0.1, 4);
  });

  it("给自己建层：本帧的推进已经做完，下一帧才第一次推进", () => {
    const puppets = pair();
    let created = 0;
    puppets.control(1, 0)!.addEndedCallback(() => {
      created = puppets.createLayer(1, item(1), false)!;
    });
    puppets.frame(WRAP);
    expect(puppets.control(1, created)!.getFrame()).toBe(0);
  });
});

describe("删光 / 全隐藏回到静止；骨骼透明度与变形复位、g_BlendMap 不复位（对照表 26）", () => {
  function rigWithChannels() {
    const length = 20;
    const base = animation(1, LOOP, length);
    const frameCount = length + 1;
    return rig(
      [
        {
          ...base,
          alpha: new Float32Array(frameCount).fill(0.5),
          alphaMask: new Uint8Array([1]),
          channels: [new Float32Array(frameCount).fill(0.25)],
        },
      ],
      [],
      { boneAlpha: true },
    );
  }

  it("层在时：皮肤平移、透明度、混合图都有贡献；删光之后下一帧回到静止，透明度复位成 1，混合图保持最后的值", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rigWithChannels() }]);
    const id = puppets.createLayer(1, item(0, { rate: 1 }), false)!;
    puppets.frame(0.95); // 帧 9.5
    expect(skinX(puppets, 1)).toBeGreaterThan(50);
    expect(puppets.boneAlpha(1)![0]).toBeCloseTo(0.5, 5);
    const blend = puppets.blendMap(1)![0];
    expect(blend).toBeCloseTo(0.25, 5);
    puppets.destroyLayers(1, { id });
    puppets.settle();
    puppets.frame(0.1);
    expect(skinX(puppets, 1)).toBe(0);
    expect(puppets.boneAlpha(1)![0]).toBe(1);
    // `g_BlendMap` 帧首不复位：没有层写它时保持删层前最后的值
    expect(puppets.blendMap(1)![0]).toBe(blend);
  });

  it("剩下的层都隐藏：同样回到静止", () => {
    const puppets = new ScenePuppets([{ object: 1, puppet: rigWithChannels() }]);
    const id = puppets.createLayer(1, item(0), false)!;
    puppets.frame(0.95);
    expect(skinX(puppets, 1)).toBeGreaterThan(0);
    const sink: PuppetSink = {
      animationLayer: (object, layer) => (layer === id ? { rate: 1, blend: 1, visible: false } : undefined),
    };
    puppets.frame(0.1, sink);
    expect(skinX(puppets, 1)).toBe(0);
    expect(puppets.boneAlpha(1)![0]).toBe(1);
  });
});

describe("模型对象同一套（对照表 27）", () => {
  const model = (extra: Partial<PuppetRig> = {}) =>
    new ScenePuppets([{ object: 1, kind: "model", puppet: rig([animation(1, SINGLE)], [], { morphs: [], ...extra }) }]);

  it("建层 / 单次层 / 删层与图像层一样", () => {
    const puppets = model();
    const released = vi.fn();
    const id = puppets.createLayer(1, item(0, { name: "m" }), true)!;
    expect(id).toBe(-1);
    expect(names(puppets, 1)).toEqual(["m"]);
    puppets.frame(0.5, null, { released });
    expect(puppets.alive(1, id)).toBe(false);
    expect(released).toHaveBeenCalledWith(1, id);
    const second = puppets.createLayer(1, item(0), false)!;
    expect(puppets.destroyLayers(1, { id: second })).toBe(true);
    puppets.settle({ released });
    expect(released).toHaveBeenCalledWith(1, second);
  });

  it("对象或父链不可见时冻结：不推进、不删、不发回调", () => {
    const puppets = model();
    const id = puppets.createLayer(1, item(0), true)!;
    const callback = vi.fn();
    puppets.control(1, id)!.addEndedCallback(callback);
    const hidden: PuppetSink = { animationLayer: () => undefined, visible: () => false };
    for (let i = 0; i < 4; i++) puppets.frame(0.5, hidden);
    expect(callback).not.toHaveBeenCalled();
    expect(puppets.alive(1, id)).toBe(true);
    expect(puppets.control(1, id)!.getFrame()).toBe(0);
    puppets.frame(0.5, { animationLayer: () => undefined, visible: () => true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(puppets.alive(1, id)).toBe(false);
  });
});

describe("carryOver 按 id 接回（对照表 30 的运行时部分）", () => {
  const base = () =>
    rig([animation(1, LOOP, 20), animation(2, SINGLE, 20)], [def(0, 0, { name: "a" }), def(1, 0, { name: "b" })]);
  const fresh = (puppet: PuppetRig = base()) => new ScenePuppets([{ object: 1, puppet }]);

  it("运行时建的层按新 rig 里同一条动画重建，位置、时钟、名字、回调表、SINGLE_SHOT 都接回；id 计数继续", () => {
    const old = fresh();
    const id = old.createLayer(1, item(1, { name: "rt", index: 1 }), true)!;
    old.frame(0.5);
    old.control(1, id)!.name = "renamed";
    const callback = vi.fn();
    old.control(1, id)!.addEndedCallback(callback);
    const before = old.ids(1);
    expect(before).toEqual([0, id, 1]);

    const next = fresh();
    next.carryOver(old);
    expect(next.ids(1)).toEqual(before);
    expect(next.control(1, id)!.name).toBe("renamed");
    expect(next.control(1, id)!.getFrame()).toBeCloseTo(5, 4);
    expect(next.createLayer(1, item(0), false)).toBe(id - 1);
    // 回调表是同一个数组，SINGLE_SHOT 保留：继续推进到头就调回调并被删
    next.frame(1.6);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(next.alive(1, id)).toBe(false);
  });

  it("删过的编译期层不回来（destroyedEntries 跨重编译保留，连续两次接回）", () => {
    const old = fresh();
    old.destroyLayers(1, { id: 0 });
    old.settle();
    const next = fresh();
    next.carryOver(old);
    expect(next.ids(1)).toEqual([1]);
    expect(next.alive(1, 0)).toBe(false);
    const third = fresh();
    third.carryOver(next);
    expect(third.ids(1)).toEqual([1]);
  });

  it("层表顺序照上一份；上一份没有的编译期层（新 bundle 才有）按 bundle 顺序追加", () => {
    const old = fresh();
    old.createLayer(1, item(0, { index: 0, name: "first" }), false);
    const bigger = rig(
      [animation(1, LOOP, 20), animation(2, SINGLE, 20)],
      [def(0, 0, { name: "a" }), def(1, 0, { name: "b" }), def(2, 0, { name: "c" })],
    );
    const next = fresh(bigger);
    next.carryOver(old);
    expect(next.ids(1)).toEqual([-1, 0, 1, 2]);
    expect(names(next, 1)).toEqual(["first", "a", "b", "c"]);
  });

  it("新 bundle 里编译期层被删掉了：不再出现；运行时层的动画 fps / 长度 / 模式变了：丢掉", () => {
    const old = fresh();
    const id = old.createLayer(1, item(1), false)!;
    const changed = rig([animation(1, LOOP, 20), { ...animation(2, SINGLE, 20), fps: 20 }], [def(1, 0, { name: "b" })]);
    const next = fresh(changed);
    next.carryOver(old);
    expect(next.ids(1)).toEqual([1]);
    expect(next.alive(1, id)).toBe(false);
    // 新 bundle 里找不到同一条动画（id 变了）：同样丢掉
    const missing = fresh(rig([animation(1, LOOP, 20)], [def(0, 0), def(1, 0)]));
    missing.carryOver(old);
    expect(missing.ids(1)).toEqual([0, 1]);
  });

  it("摘出还没释放的层照接（带进新 detached，换场景发生在 settle 之后时为空）", () => {
    const old = fresh();
    old.destroyLayers(1, { id: 1 });
    const next = fresh();
    next.carryOver(old);
    expect(next.detachedCount(1)).toBe(1);
    expect(next.ids(1)).toEqual([0]);
    const released = vi.fn();
    next.settle({ released });
    expect(released).toHaveBeenCalledWith(1, 1);
  });

  it("编译期层：时钟与整份运行时位（含漏扫留下的 ENDED、SINGLE_SHOT）、可写位、回调表接回", () => {
    const old = fresh();
    old.control(1, 0)!.setFrame(7);
    old.control(1, 0)!.blendtime = 3;
    const callback = vi.fn();
    old.control(1, 0)!.addEndedCallback(callback);
    const next = fresh();
    next.carryOver(old);
    expect(next.control(1, 0)!.getFrame()).toBeCloseTo(7, 4);
    expect(next.control(1, 0)!.blendtime).toBe(3);
    expect(clockFlags(next, 1, 0)).toBe(clockFlags(old, 1, 0));
  });

  it("liveLayers 给出全部活着的层（含摘出未释放的），供状态对齐", () => {
    const puppets = fresh();
    const id = puppets.createLayer(1, item(0, { rate: 2, blend: 0.5, visible: false }), false)!;
    puppets.destroyLayers(1, { id: 1 });
    const live = [...puppets.liveLayers()].map((layer) => [
      layer.object,
      layer.id,
      layer.def.rate,
      layer.def.blend,
      layer.def.visible,
    ]);
    expect(live).toEqual(
      expect.arrayContaining([
        [1, 0, 1, 1, true],
        [1, 1, 1, 1, true],
        [1, id, 2, 0.5, false],
      ]),
    );
    expect([...puppets.objects()]).toEqual([1]);
  });
});

describe("stateSink 按 id 读", () => {
  it("键是 对象:id；运行时层的状态项缺失时回落到层定义", () => {
    const animationLayers = new Map([["1:7", { rate: 0, blend: 1, visible: true }]]);
    const sink = stateSink({ animationLayers });
    expect(sink.animationLayer(1, 7)).toEqual({ rate: 0, blend: 1, visible: true });
    expect(sink.animationLayer(1, -1)).toBeUndefined();
  });
});
