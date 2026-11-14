/**
 * P6c 步骤 1：光标命中与派发（`render/cursor.ts`）。用例照 0c 实测的 `p6c-hit` 段落（`ignore/p6/c0/make_hit.py`、`out/wpe-hit.log`）写成纯数据：
 * 场景 1920×1080 正交，对象的几何与 `scene.json` 相同，光标取日志里 WPE 打出的世界坐标（带 float32 的痕迹，`799.5001220703125`），
 * 期望的回调序列与 `localPosition` 的数值都取 WPE 日志，所以 float32 的运算顺序一并核对。
 */
import { describe, expect, it } from "vitest";
import { alignmentIndex } from "../compile/alignment";
import { sceneCursor, scenePlacement, sceneViewProjection, alignmentOffset } from "./layout";
import { pointerScenePoint } from "../particles/controlpoints";
import { invertF32 } from "./inverseF32";
import { translation } from "./math";
import {
  CursorSession,
  CursorTracker,
  hitQuad,
  intersectParallelogram,
  perspectiveLayerRay,
  pickablesOf,
  sceneRay,
  unprojectCursor,
  type CursorCallback,
  type CursorFrame,
  type PickLayer,
  type PickState,
  type Pickable,
  type Vec3Tuple,
} from "./cursor";
import type { LayerState } from "./state";

const ORTHO = sceneViewProjection({ width: 1920, height: 1080 });

interface Spec {
  name: string;
  origin: number[];
  size: number[];
  scale?: number[];
  angles?: number[];
  parentName?: string;
  visible?: boolean;
  solid?: boolean;
  stop?: boolean;
  alignment?: string;
  fullscreen?: boolean;
  perspective?: boolean;
  parallaxDepth?: number[];
  pick?: "image" | "text";
}

/** 按 `objects` 顺序（先写的在下面）建图层与状态；`names` 给事件序列里换回名字。 */
function scene(specs: Spec[]) {
  const names = specs.map((spec) => spec.name);
  const layers: PickLayer[] = specs.map((spec, object) => ({
    object,
    pick: spec.pick ?? "image",
    perspective: !!spec.perspective,
    fullscreen: !!spec.fullscreen,
    size: spec.size,
    ...(spec.stop ? { disablePropagation: true } : {}),
  }));
  const states = new Map<number, LayerState>(
    specs.map((spec, object) => {
      const parent = spec.parentName === undefined ? null : names.indexOf(spec.parentName);
      const size = spec.size;
      const alignment = spec.alignment === undefined ? undefined : alignmentIndex(spec.alignment);
      const offset = alignment === undefined ? [0, 0] : alignmentOffset(alignment, size);
      return [
        object,
        {
          origin: spec.origin,
          scale: spec.scale ?? [1, 1, 1],
          angles: spec.angles ?? [0, 0, 0],
          alpha: 1,
          color: [1, 1, 1],
          brightness: 1,
          visible: spec.visible !== false,
          parallaxDepth: spec.parallaxDepth ?? [0, 0],
          ...(offset[0] !== 0 || offset[1] !== 0 ? { offset: offset as [number, number] } : {}),
          ...(spec.solid === false ? { solid: false } : {}),
          parent,
        },
      ];
    }),
  );
  const state: PickState = { layers: states, texts: new Map() };
  const tracker = new CursorTracker();
  /** 一帧：光标世界坐标（WPE 日志里的值）与左键；返回 `名字.回调` 序列与每条的 local。 */
  const step = (world: [number, number], down = false, extra: Partial<CursorFrame> = {}) => {
    const frame: CursorFrame = {
      world: [world[0], world[1], 0],
      ray: sceneRay([world[0], world[1], 0], [960, 540, 2000], false),
      perspectiveRay: null,
      down,
      parallax: null,
      windowPixel: [0, 0],
      ...extra,
    };
    const out = tracker.step(frame, pickablesOf(layers, state, false));
    return {
      list: out.map((item) => `${names[item.object]}.${item.callback.replace("cursor", "").toLowerCase()}`),
      out,
    };
  };
  const mutate = (name: string, patch: Partial<LayerState>) => Object.assign(states.get(names.indexOf(name))!, patch);
  return { step, names, layers, state, mutate, tracker };
}

/** `p6c-hit` 的 12 个对象（B 在最下面、C 在最上面）。 */
const HIT: Spec[] = [
  { name: "B", origin: [400, 800, 0], size: [300, 200] },
  { name: "A", origin: [500, 800, 0], size: [300, 200] },
  { name: "H", origin: [900, 800, 0], size: [200, 150], visible: false },
  { name: "NS", origin: [1250, 800, 0], size: [200, 150], solid: false },
  { name: "D0", origin: [1600, 850, 0], size: [250, 150] },
  { name: "D1", origin: [1650, 850, 0], size: [250, 150], stop: true },
  { name: "D3", origin: [1600, 550, 0], size: [250, 150] },
  { name: "D2", origin: [1650, 550, 0], size: [250, 150], visible: false, stop: true },
  { name: "R", origin: [400, 400, 0], size: [200, 100], scale: [1.5, 1, 1], angles: [0, 0, 0.5235988] },
  { name: "AL", origin: [900, 400, 0], size: [200, 100], alignment: "topleft" },
  { name: "P", origin: [1300, 400, 0], size: [100, 100], scale: [2, 2, 1] },
  { name: "C", origin: [100, 0, 0], size: [50, 50], parentName: "P" },
];
const OUT: [number, number] = [-100.5, 1180.500244140625];

describe("射线对平行四边形（FUN_14019d5a0）", () => {
  const ray = (x: number, y: number): { origin: Vec3Tuple; direction: Vec3Tuple } => ({
    origin: [x, y, 2000],
    direction: [0, 0, -1],
  });
  const p0: Vec3Tuple = [0, 0, 0];
  const p1: Vec3Tuple = [10, 0, 0];
  const p2: Vec3Tuple = [0, 5, 0];

  it("正面与背面都命中（双面）：交换两条边就是翻转行列式", () => {
    const front = intersectParallelogram(ray(5, 2.5), p0, p1, p2);
    expect(front).toMatchObject({ inside: true, u: 0.5, v: 0.5 });
    const back = intersectParallelogram(ray(5, 2.5), p0, p2, p1);
    expect(back).toMatchObject({ inside: true, u: 0.5, v: 0.5 });
    expect(front.t).toBe(2000);
    expect(back.t).toBe(2000);
  });

  it("平行四边形：不要求 u + v ≤ 1（右上角也在里面）；边界上的点算里面", () => {
    expect(intersectParallelogram(ray(9, 4), p0, p1, p2).inside).toBe(true);
    expect(intersectParallelogram(ray(10, 5), p0, p1, p2).inside).toBe(true);
    expect(intersectParallelogram(ray(10.001, 2), p0, p1, p2).inside).toBe(false);
    expect(intersectParallelogram(ray(-0.001, 2), p0, p1, p2).inside).toBe(false);
  });

  it("射线与平面平行：uv 为 0、t 为 −1、不在里面", () => {
    const result = intersectParallelogram({ origin: [0, 0, 5], direction: [1, 0, 0] }, p0, p1, p2);
    expect(result).toEqual({ inside: false, u: 0, v: 0, t: -1 });
  });

  it("在射线后方的四边形：t < 0（hitQuad 据此不命中、不写 local）", () => {
    const behind = intersectParallelogram({ origin: [5, 2, -3], direction: [0, 0, -1] }, p0, p1, p2);
    expect(behind.t).toBeLessThan(0);
  });
});

describe("hitQuad：localPosition 以四边形左上角为原点、y 向下、单位是 size（实测 p6c-hit，数值取 WPE 日志）", () => {
  const pickable = (spec: Spec): Pickable => {
    const s = scene([spec]);
    return pickablesOf(s.layers, s.state, false)[0];
  };
  const quad = (spec: Spec, x: number, y: number) =>
    hitQuad(sceneRay([x, y, 0], [960, 540, 2000], false), pickable(spec), [0, 0, 0], [0, 0]);

  it("B（300×200，origin 400,800）：光标 (300, 799.5001220703125) → local (50, 100.49987030029297)", () => {
    const result = quad(HIT[0], 300, 799.5001220703125);
    expect(result.hit).toBe(true);
    expect(result.local).toEqual([50, 100.49987030029297, 0]);
  });

  it("外推：命中区外照写 local（拖出图层后的 move / leave 带的值），射线在前方就写", () => {
    const result = quad(HIT[0], -100.5, 1180.500244140625);
    expect(result.hit).toBe(false);
    expect(result.local[0]).toBe(-350.5);
    expect(result.local[1]).toBe(-280.5002746582031);
  });

  it("射线在四边形后方（t < 0）：不命中、local 保持 0（不写外推值），即使光标正对着它", () => {
    // 射线起点 z = −10、沿 −z 射出，B 在 z = 0：交点在起点后方
    const result = hitQuad({ origin: [400, 800, -10], direction: [0, 0, -1] }, pickable(HIT[0]), [0, 0, 0], [0, 0]);
    expect(result).toEqual({ hit: false, local: [0, 0, 0] });
  });

  it("旋转 30°、x 缩放 1.5 的 R：命中区跟着变换走，local 以变换后四边形的左上角为原点、单位不乘缩放", () => {
    const hit = quad(HIT[8], 400.5, 400.50006103515625);
    expect(hit.hit).toBe(true);
    expect(hit.local).toEqual([100.45535278320312, 49.81693649291992, 0]);
    // 对照点：没旋转（原 x 轴上更远处）与不乘缩放的位置都不中
    expect(quad(HIT[8], 520.5, 340.5).hit).toBe(false);
    expect(quad(HIT[8], 520.5, 340.5).local).toEqual([149.73736572265625, 161.77850341796875, 0]);
    const moved = quad(HIT[8], 520.5, 469.50006103515625);
    expect(moved.hit).toBe(true);
    expect(moved.local).toEqual([192.73739624023438, 50.06118392944336, 0]);
  });

  it("alignment: topleft 的 AL：命中区在对齐偏移之后", () => {
    const result = quad(HIT[9], 1050, 330.00006103515625);
    expect(result.hit).toBe(true);
    expect(result.local).toEqual([150, 69.99993896484375, 0]);
    expect(quad(HIT[9], 850.5, 420.00006103515625).local).toEqual([-49.499996185302734, -20.00005340576172, 0]);
  });

  it("父层 scale 2 的子层 C：命中区乘父缩放（C 的本地 origin 也被放大），local 不乘缩放", () => {
    const s = scene(HIT);
    const c = pickablesOf(s.layers, s.state, false).find((p) => p.object === 11)!;
    const result = hitQuad(sceneRay([1540.5, 400.50006103515625, 0], [960, 540, 2000], false), c, [0, 0, 0], [0, 0]);
    expect(result.hit).toBe(true);
    expect(result.local).toEqual([45.25, 24.749969482421875, 0]);
  });

  it("fullscreen 恒命中：local 是窗口像素（不看射线）", () => {
    const full = { ...pickable(HIT[0]), fullscreen: true };
    const result = hitQuad(sceneRay([-9999, -9999, 0], [960, 540, 2000], false), full, [0, 0, 0], [321.5, 123.25]);
    expect(result).toEqual({ hit: true, local: [321.5, 123.25, 0] });
  });
});

describe("CursorTracker：p6c-hit 的段落（回调名、对象、顺序）", () => {
  it("重叠的 A（上）、B（下）：两个都收到，先 A 后 B；同一帧里按对象依次，A 的 enter、move 都发完才轮到 B", () => {
    const s = scene(HIT);
    expect(s.step(OUT).list).toEqual([]);
    expect(s.step([300, 799.5001220703125]).list).toEqual(["B.enter", "B.move"]);
    expect(s.step([450, 799.5001220703125]).list).toEqual(["A.enter", "A.move", "B.move"]);
    expect(s.step([450, 799.5001220703125], true).list).toEqual(["A.down", "B.down"]);
    expect(s.step([450, 799.5001220703125], false).list).toEqual(["A.up", "A.click", "B.up", "B.click"]);
    // 世界坐标没变：不发 move
    expect(s.step([450, 799.5001220703125]).list).toEqual([]);
    expect(s.step([600, 799.5001220703125]).list).toEqual(["A.move", "B.leave"]);
    expect(s.step(OUT).list).toEqual(["A.leave"]);
  });

  it("A 与 B 的局部坐标各自按自己的四边形算（A 的 click 是 (100, 100.49987…)，B 的是 (200, …)）", () => {
    const s = scene(HIT);
    s.step(OUT);
    s.step([450, 799.5001220703125], true);
    const up = s.step([450, 799.5001220703125], false).out;
    expect(up.map((item) => item.local[0])).toEqual([100, 100, 200, 200]);
  });

  it("隐藏的 H（visible: false）照样收 enter / move / down / up / click；solid: false 的 NS 什么都没有", () => {
    const s = scene(HIT);
    s.step(OUT);
    expect(s.step([900, 799.5001220703125]).list).toEqual(["H.enter", "H.move"]);
    expect(s.step([900, 799.5001220703125], true).list).toEqual(["H.down"]);
    expect(s.step([900, 799.5001220703125], false).list).toEqual(["H.up", "H.click"]);
    expect(s.step([1249.5, 799.5001220703125]).list).toEqual(["H.leave"]);
    // NS 在 (1250, 800) 附近：solid 为假，不命中任何事件
    expect(s.step([1250, 800]).list).toEqual([]);
    expect(s.step([1250, 800.5], true).list).toEqual([]);
  });

  it("运行中把 solid 改成假 / 真：命中每帧现读（回调或 update 里写的下一帧的命中才生效）", () => {
    const s = scene(HIT);
    s.step(OUT);
    expect(s.step([300, 799.5001220703125]).list).toEqual(["B.enter", "B.move"]);
    s.mutate("B", { solid: false });
    // solid 变假之后这个对象整个被跳过：不再 move，也没有 leave（悬停集合里仍留着它）
    expect(s.step([310, 799.5001220703125]).list).toEqual([]);
    s.mutate("B", { solid: true });
    expect(s.step([320, 799.5001220703125]).list).toEqual(["B.move"]);
  });

  it("可见且 disablepropagation 的 D1 挡住 D0；被挡住的这一帧不处理，D0 不收 leave（0c 怪处）", () => {
    const s = scene(HIT);
    s.step(OUT);
    expect(s.step([1624.5, 850.5001220703125]).list).toEqual(["D1.enter", "D1.move"]);
    // 只在 D0 上：D1 leave、D0 enter + move
    expect(s.step([1500, 850.5001220703125]).list).toEqual(["D1.leave", "D0.enter", "D0.move"]);
    // 回到重叠处：D1 enter，D0 这一帧被挡住，不收 leave
    expect(s.step([1624.5, 850.5001220703125]).list).toEqual(["D1.enter", "D1.move"]);
    // 移出去：两个都 leave（自上而下）
    expect(s.step(OUT).list).toEqual(["D1.leave", "D0.leave"]);
  });

  it("隐藏的 D2 开了 disablepropagation 也不挡：D2、D3 都 enter", () => {
    const s = scene(HIT);
    s.step(OUT);
    expect(s.step([1624.5, 550.5000610351562]).list).toEqual(["D2.enter", "D2.move", "D3.enter", "D3.move"]);
    expect(s.step(OUT).list).toEqual(["D2.leave", "D3.leave"]);
  });

  it("第一帧上一次的位置是 (0, 0)：世界坐标不是 (0, 0) 时命中的对象当帧收 enter + move；左键已按着当作按下沿", () => {
    const s = scene(HIT);
    expect(s.step([300, 799.5001220703125], true).list).toEqual(["B.enter", "B.move", "B.down"]);
  });
});

describe("CursorTracker：按下、拖动与松开（p6c-hit 的拖动段）", () => {
  it("只在 A 上按下：同一帧 enter → move → down；按住拖出去只有 A 的 move（外推坐标）、没有 leave；拖回来松开 up + click", () => {
    const s = scene(HIT);
    s.step(OUT);
    expect(s.step([600, 799.5001220703125], true).list).toEqual(["A.enter", "A.move", "A.down"]);
    // 按住拖出去（按下集合非空且左键仍按着）：只给按下集合里的发 move，不发进出
    expect(s.step([640, 799.5001220703125], true).list).toEqual(["A.move"]);
    const drag = s.step(OUT, true);
    expect(drag.list).toEqual(["A.move"]);
    expect(drag.out[0].local[0]).toBeLessThan(0);
    expect(s.step([600, 799.5001220703125], true).list).toEqual(["A.move"]);
    // 松开：这一帧左键变了，走悬停分支：命中的 A up + click
    expect(s.step([600, 799.5001220703125], false).list).toEqual(["A.up", "A.click"]);
  });

  it("在 A 上按住拖到只在 B 上松开：同一帧 A up、A leave、B enter、B up；A 没有 click、B 没有 down；拖动期间 B 没有 enter", () => {
    const s = scene(HIT);
    s.step(OUT);
    // 按下在只有 A 的位置（x 600 在 A 里、B 范围外）
    expect(s.step([600, 799.5001220703125], true).list).toEqual(["A.enter", "A.move", "A.down"]);
    expect(s.step([330, 799.5001220703125], true).list).toEqual(["A.move"]);
    expect(s.step([300, 799.5001220703125], false).list).toEqual(["A.up", "A.leave", "B.enter", "B.move", "B.up"]);
  });

  it("松开在外面：按下集合里的 A 只收 up（没有 click），同一帧 leave；之后按下集合清空", () => {
    const s = scene(HIT);
    s.step(OUT);
    s.step([600, 799.5001220703125], true);
    s.step([610, 799.5001220703125], true);
    expect(s.step(OUT, false).list).toEqual(["A.up", "A.leave"]);
    // 按下集合已清：再按下 / 松开别的位置不再有 A 的事件
    expect(s.step(OUT, false).list).toEqual([]);
  });

  it("空白处按下、拖进 A 里松开：A 只有 up（没有 down、没有 click）；按住期间正常进出、移动", () => {
    const s = scene(HIT);
    s.step(OUT, true);
    expect(s.step([600, 799.5001220703125], true).list).toEqual(["A.enter", "A.move"]);
    expect(s.step([600, 799.5001220703125], false).list).toEqual(["A.up"]);
  });

  it("一帧里完整的按下抬起丢掉（只采样每帧的状态）：连着两帧都是松开就没有任何按键回调", () => {
    const s = scene(HIT);
    s.step([600, 799.5001220703125]);
    expect(s.step([600, 799.5001220703125], false).list).toEqual([]);
  });

  it("按住期间别的对象（不在按下集合）既不进出也不 move", () => {
    const s = scene(HIT);
    s.step(OUT);
    s.step([600, 799.5001220703125], true);
    // 拖到 H 上（不在按下集合里）：H 没有 enter
    expect(s.step([900, 799.5001220703125], true).list).toEqual(["A.move"]);
  });
});

describe("命中顺序与 moved：世界坐标 NaN、视差", () => {
  it("moved 比的是世界坐标：光标不动、相机在动（世界坐标变）时每帧都发 move", () => {
    const s = scene(HIT);
    s.step(OUT);
    s.step([300, 799.5001220703125]);
    expect(s.step([300.5, 799.5001220703125]).list).toEqual(["B.move"]);
    expect(s.step([301, 799.5001220703125]).list).toEqual(["B.move"]);
    expect(s.step([301, 799.5001220703125]).list).toEqual([]);
  });

  it("子层的视差命中用自己的本地 origin 与自己的 parallaxDepth（命中区和画出来的位置不一致，0c p6c-par）", () => {
    // L1：深度 1，origin (1000, 500)；子层 L3：本地 origin (0, 250)、自己的深度 (3, 3)；视差点 P、amount 1
    const specs: Spec[] = [
      { name: "L1", origin: [1000, 500, 0], size: [100, 100], parallaxDepth: [1, 1] },
      { name: "L3", origin: [0, 250, 0], size: [100, 100], parallaxDepth: [3, 3], parentName: "L1" },
    ];
    const s = scene(specs);
    const parallax = { amount: 1, point: [960, 540] as [number, number] };
    // L1 命中区平移 (1·(1000 − 960)·1, 1·(500 − 540)·1) = (40, −40)：中心 (1040, 460)
    expect(s.step([1040, 460], false, { parallax }).list).toEqual(["L1.enter", "L1.move"]);
    // L3 自己的偏移 = (1·(0 − 960)·3, 1·(250 − 540)·3) = (−2880, −870)：命中区被推出画面，画出来的位置（1000 + 0, 500 + 250 → 750）一次都没命中
    s.step(OUT);
    expect(s.step([1000, 750], false, { parallax }).list).toEqual([]);
  });

  it("没有视差时不加偏移", () => {
    const s = scene([{ name: "L1", origin: [1000, 500, 0], size: [100, 100], parallaxDepth: [1, 1] }]);
    expect(s.step([1000, 500]).list).toEqual(["L1.enter", "L1.move"]);
  });
});

describe("pickablesOf：对象表与顺序", () => {
  const text = (name: string, origin: number[]): Spec => ({ name, origin, size: [10, 10], pick: "text" });

  it("正交场景：objects 顺序的倒序（最上面的在前）；没有 pick 的图层（粒子、声音等）跳过", () => {
    const s = scene([
      { name: "a", origin: [0, 0, 0], size: [10, 10] },
      { name: "b", origin: [0, 0, 0], size: [10, 10] },
      { name: "c", origin: [0, 0, 0], size: [10, 10] },
    ]);
    delete s.layers[1].pick;
    expect(pickablesOf(s.layers, s.state, false).map((p) => p.object)).toEqual([2, 0]);
  });

  it("文本层的 size 取排版后的文字框（状态里的 TextLayout），不是 bundle 里的占位", () => {
    const s = scene([text("t", [100, 100, 0])]);
    const state: PickState = { ...s.state, texts: new Map([[0, { size: [321, 45] }]]) };
    expect(pickablesOf(s.layers, state, false)[0].size).toEqual([321, 45]);
  });

  it("透视场景：按 origin · 视线从大到小稳定排序再倒序（近的先）；last 的键是 −∞（最先）", () => {
    const s = scene([
      { name: "far", origin: [0, 0, -50], size: [1, 1] },
      { name: "near", origin: [0, 0, 5], size: [1, 1] },
      { name: "mid", origin: [0, 0, -10], size: [1, 1] },
      { name: "tie", origin: [0, 0, -10], size: [1, 1] },
      { name: "full", origin: [0, 0, 0], size: [1, 1] },
    ]);
    s.layers[4] = { ...s.layers[4], sortClass: "last" };
    // forward = (0, 0, −1)：键 = −origin.z：far 50、mid 10、tie 10、full −∞（排最后）、near −5（正好在 full 之前）
    const order = pickablesOf(s.layers, s.state, true, [0, 0, -1]).map((p) => s.names[p.object]);
    // 降序稳定排序：far(50) mid(10) tie(10) near(−5) full(−∞)；倒序遍历：full 最先
    expect(order).toEqual(["full", "near", "tie", "mid", "far"]);
  });

  it("blocks：disablepropagation 且自身与父链都可见才为真", () => {
    const s = scene([
      { name: "p", origin: [0, 0, 0], size: [1, 1], visible: false },
      { name: "child", origin: [0, 0, 0], size: [1, 1], parentName: "p", stop: true },
      { name: "solo", origin: [0, 0, 0], size: [1, 1], stop: true },
      { name: "hidden", origin: [0, 0, 0], size: [1, 1], stop: true, visible: false },
    ]);
    const blocks = Object.fromEntries(pickablesOf(s.layers, s.state, false).map((p) => [s.names[p.object], p.blocks]));
    expect(blocks).toEqual({ p: false, child: false, solo: true, hidden: false });
  });

  it("视差用的 origin 与 parallaxDepth 取对象自己的本地值（子层不取根层的，0c p6c-par）", () => {
    const s = scene([
      { name: "root", origin: [600, 540, 0], size: [10, 10], parallaxDepth: [1, 1] },
      { name: "child", origin: [0, 250, 0], size: [10, 10], parentName: "root", parallaxDepth: [3, 3] },
      { name: "flat", origin: [1300, 540, 0], size: [10, 10], parallaxDepth: [0, 0] },
    ]);
    const byName = Object.fromEntries(
      pickablesOf(s.layers, s.state, false).map((p) => [s.names[p.object], [p.origin.slice(0, 2), p.parallaxDepth]]),
    );
    expect(byName).toEqual({
      root: [
        [600, 540],
        [1, 1],
      ],
      child: [
        [0, 250],
        [3, 3],
      ],
      flat: [
        [1300, 540],
        [0, 0],
      ],
    });
  });

  it("solid 缺省（状态里没有这一项）当真", () => {
    const s = scene([{ name: "a", origin: [0, 0, 0], size: [1, 1] }]);
    expect(pickablesOf(s.layers, s.state, false)[0].solid).toBe(true);
    s.mutate("a", { solid: false });
    expect(pickablesOf(s.layers, s.state, false)[0].solid).toBe(false);
  });
});

describe("反投影与射线（FUN_14018e070 / 14018e1a0 / 14018fc40）", () => {
  it("正交：unprojectCursor 的 x、y 与粒子指针点的 pointerScenePoint 只差求逆的 1 ulp（WPE 的 float32 求逆，`inverseF32.ts`）", () => {
    for (const cursor of [
      [0.25, 0.25],
      [0.4, 0.7],
      [1.1, -0.2],
    ] as const) {
      const [x, y] = pointerScenePoint(ORTHO, cursor);
      const world = unprojectCursor(ORTHO, cursor);
      expect(Math.abs(world[0] - x)).toBeLessThan(1e-3);
      expect(Math.abs(world[1] - y)).toBeLessThan(1e-3);
    }
    // float32 求逆正好把 0.25 落在 480（double 余子式求逆差 1 ulp，479.99997）
    expect(unprojectCursor(ORTHO, [0.25, 0.25])[0]).toBe(480);
  });

  it("窗口坐标 → 场景坐标：1280×720 窗口里 (0.234375, 0.259259) 落在 (450, 799.5…)", () => {
    // 抓帧窗口 1280×720、场景 1920×1080：fill 的铺放就是恒等
    const placement = scenePlacement("fill", 1920, 1080, 1280, 720);
    const px = Math.fround(Math.round(0.234375 * 1280) / 1280);
    const py = Math.fround(Math.round(0.259259 * 720) / 720);
    const cursor = sceneCursor("fill", placement, 1280, 720, px, py);
    const world = unprojectCursor(ORTHO, cursor);
    expect(world[0]).toBe(450);
    expect(world[1]).toBe(799.5001220703125);
  });

  it("透视场景的射线：起点 eye、方向 normalize(p − eye)；正交场景起点 (p.x, p.y, eye.z)、方向 (0, 0, −1)", () => {
    expect(sceneRay([10, 20, 0], [960, 540, 2000], false)).toEqual({ origin: [10, 20, 2000], direction: [0, 0, -1] });
    const ray = sceneRay([0, 0, -9990], [0, 0, 10], true);
    expect(ray.origin).toEqual([0, 0, 10]);
    expect(ray.direction).toEqual([0, 0, -1]);
    const slanted = sceneRay([100, 0, -100], [0, 0, 0], true);
    expect(slanted.direction[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(slanted.direction[2]).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it("perspective: true 图层的射线（正交场景）：光标在窗口中心时射线从 (W/2, H/2, d) 沿 −z 射出，d = (H/2) / tan(fov/2)", () => {
    const view = new Float32Array(translation(0, 0, 0));
    const fov = (95 * Math.PI) / 180;
    const ray = perspectiveLayerRay(
      { view, projection: ORTHO, fov, width: 1920, height: 1080, window: [1280, 720] },
      [0.5, 0.5],
    )!;
    const d = 540 / Math.tan(fov / 2);
    expect(ray.origin[0]).toBeCloseTo(960, 2);
    expect(ray.origin[1]).toBeCloseTo(540, 2);
    expect(ray.origin[2]).toBeCloseTo(d, 1);
    expect(ray.direction[0]).toBeCloseTo(0, 5);
    expect(ray.direction[1]).toBeCloseTo(0, 5);
    expect(ray.direction[2]).toBeCloseTo(-1, 5);
    // 光标偏到右边：射线向右偏；抖动 s = (−10, 0) 的视图 T(−s) 让相机跟着挪
    const right = perspectiveLayerRay(
      { view, projection: ORTHO, fov, width: 1920, height: 1080, window: [1280, 720] },
      [0.75, 0.5],
    )!;
    expect(right.direction[0]).toBeGreaterThan(0.1);
    const shaken = perspectiveLayerRay(
      { view: translation(10, 0, 0), projection: ORTHO, fov, width: 1920, height: 1080, window: [1280, 720] },
      [0.5, 0.5],
    )!;
    expect(shaken.origin[0]).toBeCloseTo(950, 2);
  });
});

describe("CursorSession：每帧的 input 快照与（有回调时）命中", () => {
  const layers: PickLayer[] = [{ object: 0, pick: "image", perspective: false, fullscreen: false, size: [300, 200] }];
  const layerState = (): PickState => ({
    layers: new Map<number, LayerState>([
      [
        0,
        {
          origin: [400, 800, 0],
          scale: [1, 1, 1],
          angles: [0, 0, 0],
          alpha: 1,
          color: [1, 1, 1],
          brightness: 1,
          visible: true,
          parallaxDepth: [1, 1],
          parent: null,
        },
      ],
    ]),
    texts: new Map(),
  });
  const camera = {
    viewProjection: ORTHO,
    eye: [960, 540, 2000],
    perspective: false,
    forward: [0, 0, -1],
    override: null,
  };
  const input = (down: boolean) => ({
    camera,
    cursor: [0.234375, 0.259259] as [number, number],
    pointer: [0.234375, 0.259259] as [number, number],
    window: [1280, 720] as [number, number],
    down,
    parallax: null,
  });

  it("input.cursorScreenPosition 是 ptr × 窗口像素（左上原点、y 向下、不钳制），cursorLeftDown 是登记的左键", () => {
    const session = new CursorSession();
    const { snapshot } = session.frame(
      { ...input(true), pointer: [1.5, -0.25] },
      { layers, state: layerState() },
      false,
    );
    expect(snapshot.screen).toEqual([1920, -180]);
    expect(snapshot.leftDown).toBe(true);
    expect(snapshot.world[2]).toBe(0);
  });

  it("没有脚本导出光标回调时只算快照、不命中；有时命中并返回派发序列", () => {
    const session = new CursorSession();
    const scene = { layers, state: layerState() };
    expect(session.frame(input(false), scene, false).dispatches).toEqual([]);
    const active = session.frame({ ...input(false), cursor: [0.9, 0.9], pointer: [0.9, 0.9] }, scene, true);
    expect(active.dispatches.map((item) => item.callback)).toEqual([]);
    const enter = session.frame(
      // 把光标放到 B（400, 800）中心附近的场景坐标：窗口 1280×720、场景 1920×1080 → (x / 1920, 1 − y / 1080)
      { ...input(false), cursor: [400 / 1920, 1 - 800 / 1080], pointer: [400 / 1920, 1 - 800 / 1080] },
      scene,
      true,
    );
    expect(enter.dispatches.map((item) => item.callback)).toEqual(["cursorEnter", "cursorMove"]);
    expect(enter.dispatches[0].world[2]).toBe(0);
  });
});

describe("回调名", () => {
  it("光标回调只有六个（cursorHitTest 不派发）", () => {
    const names: CursorCallback[] = [
      "cursorEnter",
      "cursorLeave",
      "cursorMove",
      "cursorDown",
      "cursorUp",
      "cursorClick",
    ];
    expect(new Set(names).size).toBe(6);
    // 反投影的可逆性：正交矩阵求逆不失败
    expect(invertF32(ORTHO)[0]).toBeGreaterThan(900);
  });
});
