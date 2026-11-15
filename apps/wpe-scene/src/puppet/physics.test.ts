/**
 * P12d-1 点 4：骨骼物理（`puppet/physics.ts` + `ScenePuppets` 的物理步骤，`.claude/plans/wpe-import/3-scene/phase12/phase-12d-physics.md`）。
 *
 * 样本 `fixtures/phys-*.json`（生成脚本 `ignore/p12/d/impl1/mkfix_phys.py`）：
 * - `phys-p12-phys` / `phys-p12-phys2`：用例 10 的生成工程（根骨骼动画驱动，子骨骼 tail 开物理：re / se / ronly / tse / re_ge、re_y / se_y / ronly_y /
 *   re_rot / se_rot），从第 1 帧起按日志 dt 推进，和 WPE 的 `g_Bones` 比；
 * - `phys-2345214324`：语料（r + re，4 根物理骨骼，帧 216–220，含 dt 钳到 0.25 的长帧）；
 * - `phys-3426865175`：语料（r + re + ge + la，图层带 angles / scale、origin 来自光标，W 晚一帧，帧 190–192）。
 * 逐位一致做不到（`rotTo` 阈值附近差 1 ulp 就翻转判定，`re` 又不回弹；动画里有 `rsqrtps`），验收按 p12-REPORT 的误差包络：
 * 用例 10 的 python 组合模型残差 re / se / ronly / tse / se_y / ronly_y 逐位相同、re_ge 1.5e-5、re_y 4.6e-5、re_rot 1.1e-4、se_rot 3.6e-4 px；
 * 2345214324 每骨骼 ≤ 6.8e-3 px；3426865175 ≤ 3.1e-5 px。
 *
 * 反例（防回归）：积分比例不钳到 1、惯性用物理**之前**的世界骨骼矩阵这两种要改实现，做过变异检查（改回去后 4 组全部差到几十到上千 px，见实施记录），
 * 不在这里参数化；去掉惯性、`re` 加弹簧、物理用同一帧脚本写的 origin 三种用参数 / 时机参数化，在下面断言差到像素级。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, parseBonePhysics, type BonePhysics, type ScenePuppet } from "../compile/puppet";
import corpus2345 from "./fixtures/phys-2345214324.json";
import corpus3426 from "./fixtures/phys-3426865175.json";
import phys from "./fixtures/phys-p12-phys.json";
import phys2 from "./fixtures/phys-p12-phys2.json";
import { createBoneState, solveBone } from "./physics";
import { ScenePuppets, type PuppetLayerFields, type PuppetSink } from "./player";

interface FixturePuppet {
  name: string;
  object: number;
  path: string;
  mdlGzip: string;
  layers: unknown[];
  wpe: Record<string, number[]>;
  world?: number[];
  worlds?: number[][];
}
interface Fixture {
  dt: number[];
  frames: number[];
  puppets: FixturePuppet[];
}

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function load(item: FixturePuppet): ScenePuppet {
  const { puppet, issues } = buildPuppet(parseMdl(mdlBytes(item.mdlGzip)), item.layers, item.path);
  expect([...issues], item.name).toEqual([]);
  return puppet!;
}

/** 反例的开关：改写每根骨骼的物理参数；物理第 k 帧用第 k + shift 帧的 W（`worlds` 才有意义）。 */
interface Options {
  tweak?: (params: BonePhysics) => BonePhysics;
  shift?: number;
}

/** 这个 puppet 第 k 帧（从 1 起）物理用的 W。 */
function worldAt(item: FixturePuppet, k: number, shift = 0): Float32Array {
  const list = item.worlds;
  return Float32Array.from(list ? list[Math.min(Math.max(k - 1 + shift, 0), list.length - 1)] : item.world!);
}

/** 从第 1 帧起按日志 dt 推进，返回每个 puppet 在抓帧上的 `g_Bones` 最大绝对差（px）。 */
function run(fixture: Fixture, options: Options = {}): Map<string, number> {
  const list = fixture.puppets.map((item) => {
    const puppet = load(item);
    if (options.tweak) {
      const skeleton = puppet.skeleton!;
      skeleton.physics = skeleton.physics!.map((p) => (p ? options.tweak!(p) : p));
    }
    return { object: item.object, puppet };
  });
  const puppets = new ScenePuppets(list);
  const world = new Map<number, Float32Array>();
  const sink: PuppetSink = { animationLayer: () => undefined, world: (object) => world.get(object) ?? null };
  const wanted = new Set(fixture.frames);
  const last = fixture.frames[fixture.frames.length - 1];
  const worst = new Map<string, number>();
  for (let k = 1; k <= last; k++) {
    for (const item of fixture.puppets) world.set(item.object, worldAt(item, k, options.shift));
    puppets.frame(fixture.dt[k - 1], sink);
    if (!wanted.has(k)) continue;
    for (const item of fixture.puppets) {
      const skin = puppets.skin(item.object)!;
      const ref = item.wpe[String(k)];
      expect(skin.length).toBe(ref.length);
      let max = worst.get(item.name) ?? 0;
      for (let i = 0; i < ref.length; i++) max = Math.max(max, Math.abs(skin[i] - Math.fround(ref[i])));
      worst.set(item.name, max);
    }
  }
  return worst;
}

const max = (map: Map<string, number>) => Math.max(...map.values());

describe("骨骼物理和 WPE 的 g_Bones 逐帧比", () => {
  it("用例 10 p12-phys：re / se / ronly / tse 逐位相同，re_ge（重力）≤ 2e-5 px", () => {
    const worst = run(phys);
    for (const name of ["re", "se", "ronly", "tse"]) expect(worst.get(name), name).toBe(0);
    // p12-REPORT 的 python 组合模型 1.5e-5；这里同一量级（重力的 float32 舍入级）
    expect(worst.get("re_ge")!).toBeLessThan(2e-5);
  });

  it("用例 10 p12-phys2：沿 y 移动 / 根骨骼转 0.6 rad（re_y、re_rot 在 rotTo 阈值上有翻转，量级同 python 模型）", () => {
    const worst = run(phys2);
    expect(worst.get("ronly_y")).toBe(0);
    expect(worst.get("se_y")).toBe(0);
    expect(worst.get("re_y")!).toBeLessThan(1e-4); // python 4.6e-5
    expect(worst.get("re_rot")!).toBeLessThan(2e-4); // python 1.1e-4
    expect(worst.get("se_rot")!).toBeLessThan(5e-4); // python 3.6e-4
  });

  it("语料 2345214324：帧 216–220 每骨骼 ≤ 6.8e-3 px（p12-REPORT 1.2，3 号骨骼最短、阈值翻转最敏感）", () => {
    expect(max(run(corpus2345))).toBeLessThan(6.8e-3);
  });

  it("语料 3426865175：重力、图层 angles 1.279 / scale 0.3、W 晚一帧，帧 190–192 ≤ 3.1e-5 px（p12-REPORT 1.5）", () => {
    expect(max(run(corpus3426))).toBeLessThan(3.1e-5);
  });
});

describe("反例：写法不对要被夹具抓住（差到像素级）", () => {
  it("去掉惯性（ri = 0）：2345214324 差 ≥ 1 px（python 反例 5.4–23 px）", () => {
    expect(max(run(corpus2345, { tweak: (p) => ({ ...p, ri: 0 }) }))).toBeGreaterThan(1);
  });

  it("re 也加弹簧（rs 200）：2345214324 差 ≥ 1 px（python 反例 4.9–23 px）", () => {
    expect(max(run(corpus2345, { tweak: (p) => ({ ...p, spring: true, rs: 200 }) }))).toBeGreaterThan(1);
  });

  it("物理用同一帧脚本写的 origin（W 不晚一帧）：3426865175 差 ≥ 1 px（python 反例第 192 帧 126 px）", () => {
    expect(max(run(corpus3426, { shift: 1 }))).toBeGreaterThan(1);
  });

  it("没有物理（参数全清）：2345214324 差 ≥ 10 px（python 不算物理 23 px）", () => {
    expect(max(run(corpus2345, { tweak: (p) => ({ ...p, rotate: false, translate: false }) }))).toBeGreaterThan(10);
  });
});

describe("ScenePuppets 的物理步骤", () => {
  /** 一个物理骨骼的 puppet（re_ge：重力一直在转，第 2 帧起就有动作）。 */
  const regeItem = phys.puppets.find((item) => item.name === "re_ge")!;
  const layerFields = (visible: boolean): PuppetSink["animationLayer"] => {
    return (): PuppetLayerFields => ({ rate: 1, blend: 1, visible });
  };

  function drive(
    frames: number,
    sinkFor: (puppets: ScenePuppets) => PuppetSink,
    between?: (puppets: ScenePuppets, k: number) => void,
  ) {
    const puppets = new ScenePuppets([{ object: regeItem.object, puppet: load(regeItem) }]);
    const sink = sinkFor(puppets);
    for (let k = 1; k <= frames; k++) {
      puppets.frame(phys.dt[k - 1], sink);
      between?.(puppets, k);
    }
    return puppets;
  }
  const world = Float32Array.from(regeItem.world!);
  const plain = (): PuppetSink => ({ animationLayer: () => undefined, world: () => world });
  const angle = (puppets: ScenePuppets) => puppets.physicsStates(regeItem.object)![1]!.ang[2];

  it("只有开了物理的骨骼有状态：根骨骼没有、tail 有；只有 r / 只有 re 的 puppet 没有物理运行时", () => {
    const puppets = drive(1, plain);
    const states = puppets.physicsStates(regeItem.object)!;
    expect(states.map((state) => state !== null)).toEqual([false, true]);
    const ronly = phys.puppets.find((item) => item.name === "ronly")!;
    expect(new ScenePuppets([{ object: ronly.object, puppet: load(ronly) }]).physicsStates(ronly.object)).toBeNull();
  });

  it("首帧不算物理（没有上一帧矩阵），第 2 帧起才有动作", () => {
    const puppets = drive(1, plain);
    expect([...puppets.physicsStates(regeItem.object)![1]!.ang]).toEqual([0, 0, 0]);
    puppets.frame(phys.dt[1], plain());
    expect(angle(puppets)).not.toBe(0);
  });

  it("sink 不给 world（单测、没有图层状态）时不解物理、不动状态", () => {
    const puppets = drive(5, () => ({ animationLayer: () => undefined }));
    expect([...puppets.physicsStates(regeItem.object)![1]!.ang]).toEqual([0, 0, 0]);
  });

  it("refresh 不是 WPE 的更新：不解物理，也不动状态与上一帧矩阵", () => {
    const sinkOnly = (): PuppetSink => plain();
    const a = drive(40, sinkOnly);
    // 帧与帧之间调 refresh（最后一帧之后不调：refresh 重算的蒙皮不含物理增量）
    const b = drive(40, sinkOnly, (puppets, k) => (k < 40 ? puppets.refresh(sinkOnly()) : undefined));
    expect([...b.skin(regeItem.object)!]).toEqual([...a.skin(regeItem.object)!]);
    expect([...b.physicsStates(regeItem.object)![1]!.ang]).toEqual([...a.physicsStates(regeItem.object)![1]!.ang]);
  });

  it("隐藏照算：图层不可见、`visible` 为假时和可见逐位相同（图像层 puppet 不看可见性）", () => {
    const a = drive(30, plain);
    const b = drive(30, () => ({ ...plain(), visible: () => false }));
    expect([...b.skin(regeItem.object)!]).toEqual([...a.skin(regeItem.object)!]);
  });

  it("没有可见动画层时也算（不走静止捷径）：重力让蒙皮矩阵每帧都在变", () => {
    const hidden = (): PuppetSink => ({ animationLayer: layerFields(false), world: () => world });
    const puppets = drive(3, hidden);
    const before = [...puppets.skin(regeItem.object)!];
    puppets.frame(phys.dt[3], hidden());
    expect([...puppets.skin(regeItem.object)!]).not.toEqual(before);
    expect(angle(puppets)).not.toBe(0);
  });

  it("重编译接回：新建的 ScenePuppets `carryOver` 之后，物理状态与上一帧矩阵都在，和不间断的运行逐位相同", () => {
    const straight = drive(40, plain);
    const first = drive(25, plain);
    const second = new ScenePuppets([{ object: regeItem.object, puppet: load(regeItem) }]);
    second.carryOver(first);
    second.refresh(plain());
    for (let k = 26; k <= 40; k++) second.frame(phys.dt[k - 1], plain());
    expect([...second.skin(regeItem.object)!]).toEqual([...straight.skin(regeItem.object)!]);
    expect([...second.physicsStates(regeItem.object)![1]!.ang]).toEqual([
      ...straight.physicsStates(regeItem.object)![1]!.ang,
    ]);
    // 没接回的对照：状态从零起，结果不同
    const fresh = new ScenePuppets([{ object: regeItem.object, puppet: load(regeItem) }]);
    for (let k = 26; k <= 40; k++) fresh.frame(phys.dt[k - 1], plain());
    expect([...fresh.skin(regeItem.object)!]).not.toEqual([...straight.skin(regeItem.object)!]);
  });
});

// ———— 语料 0 处、没实测，只照读码实现的分支（`lt`、平移轴锁、`t + re`），单测只核对读码公式的形状 ————

describe("solveBone：读码 2.4 里语料没用到的分支（未实测）", () => {
  const identity = (tx = 0, ty = 0) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1]);
  const base = (json: object): BonePhysics => {
    const parsed = parseBonePhysics(JSON.stringify(json));
    expect(parsed).not.toBeNull();
    return parsed!;
  };
  const out = new Float32Array(16);

  it("lt：每轴角速度限幅，限到 ltmax 度以内；不开 lt 时同一个输入的角速度更大", () => {
    // 尖端 (100, 0) 在上一帧被带到 y = 30，本帧骨骼回到原处：惯性把尖端转回去（约 4.4 度）
    const run = (extra: object) => {
      const params = base({ r: true, re: true, tp: "100 0 0", ...extra });
      const state = createBoneState();
      solveBone(params, state, identity(), identity(0, 30), 1, 1 / 60, out);
      return state;
    };
    const degrees = (q: Float32Array) => (2 * Math.atan(q[3] / q[0]) * 180) / Math.PI;
    const free = Math.abs(degrees(run({}).q));
    const limited = Math.abs(degrees(run({ lt: true, ltmax: 1 }).q));
    expect(free).toBeGreaterThan(4);
    expect(limited).toBeLessThanOrEqual(1 + 1e-3);
    expect(limited).toBeGreaterThan(0.9);
  });

  it("t + re：只有惯性滞后（没有弹簧），偏移取动画位移的反方向（骨骼本帧 +50 / +20，偏移 −50 / −20），速度恒为 0", () => {
    const params = base({ t: true, re: true, ti: 0 });
    const state = createBoneState();
    // 动画骨骼本帧从 (−50, −20) 移到原点（位移 +50 / +20）：偏移 = −位移 × (1 − ti/100)
    solveBone(params, state, identity(), identity(-50, -20), 1, 1 / 60, out);
    expect([...state.off]).toEqual([-50, -20, 0]);
    expect([...state.vel]).toEqual([0, 0, 0]);
    expect([out[12], out[13]]).toEqual([-50, -20]);
  });

  it("平移轴锁：tax = false 时去掉沿 Mw 第 0 列（本例是 x 轴）的分量", () => {
    const run = (extra: object) => {
      const state = createBoneState();
      solveBone(base({ t: true, re: true, ti: 0, ...extra }), state, identity(), identity(-50, -20), 1, 1 / 60, out);
      return [...state.off];
    };
    expect(run({})).toEqual([-50, -20, 0]);
    expect(run({ tax: false, tay: true, taz: true })).toEqual([0, -20, 0]);
    // 三个不齐就整组不读
    expect(run({ tax: false, tay: true })).toEqual([-50, -20, 0]);
  });

  it("tm：偏移钳到 s·tm", () => {
    const state = createBoneState();
    solveBone(base({ t: true, re: true, ti: 0, tm: 10 }), state, identity(), identity(-30, -40), 2, 1 / 60, out);
    // |off| 本来是 50，上限 s·tm = 20（位移 +30 / +40）
    expect(Math.hypot(state.off[0], state.off[1])).toBeCloseTo(20, 4);
  });
});
