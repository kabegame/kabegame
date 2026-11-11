/**
 * P4e 步骤 1：系统树与 static 子系统（rea-p4e-children 第 1、3、5、6 节，rea-p4c-sim.md 1.8；实测见 p4-particles-REPORT.md
 * 「P4e 语义的实测核对」）。纯 TS，不碰 GPU：条目解析与局部矩阵、控制点父分支、父粒子写控制点、预热顺序、每帧步进、周期复位、
 * 不可见的递归复位、深度上限、实例覆盖的传递、绘制模型矩阵与绘制计划的先序。
 */
import { describe, expect, it } from "vitest";
import {
  childLocalMatrix,
  MAX_CHILD_DEPTH,
  parseParticle,
  parseParticleChildEntry,
  type ParticleChildType,
  type SceneParticle,
  type SceneParticleChild,
} from "../compile/particles";
import type { JsonObject } from "../compile/model";
import type { ScenePass } from "../compile/bundle";
import { planParticleLayer } from "../render/graph";
import { identity, multiply, translation, type Mat4 } from "../render/math";
import { ControlPointSet } from "./controlpoints";
import { f32 } from "./f32";
import { SeededRandom } from "./random";
import { particleDrawModel, ParticleSystem, writeParentPoints } from "./system";
import { particleTrack } from "./track";

/** 不散开、不动、寿命 100 秒的发射器（每秒 `rate` 个，从控制点 `cp` 发射）。 */
function systemJson(extra: JsonObject = {}, rate = 10, cp = 0): JsonObject {
  return {
    maxcount: 64,
    emitter: [{ name: "sphererandom", distancemax: 0, rate, controlpoint: cp }],
    initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    ...extra,
  };
}

const parse = (json: JsonObject, instanceoverride?: unknown): SceneParticle =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });

/** 给 `parent` 挂一个子系统条目（局部矩阵按 `origin` / `angles` / `scale` 现算）。 */
function attach(
  parent: SceneParticle,
  system: SceneParticle,
  entry: Partial<Omit<SceneParticleChild, "system">> & { origin?: number[]; angles?: number[]; scale?: number[] } = {},
): SceneParticle {
  const { origin = [0, 0, 0], angles = [0, 0, 0], scale = [1, 1, 1], ...rest } = entry;
  parent.children.push({
    index: parent.children.length,
    type: "static" as ParticleChildType,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix(origin, angles, scale),
    ...rest,
    system,
  });
  return system;
}

const make = (def: SceneParticle) => new ParticleSystem(def, new SeededRandom(1), 1);
const alivePositions = (system: ParticleSystem): number[][] => {
  const out: number[][] = [];
  const c = system.columns;
  for (let i = 0; i < system.highWater; i++)
    if (c.life[i] !== 0) out.push(z([c.position[0][i], c.position[1][i], c.position[2][i]]));
  return out;
};
const inputsAt = (world: Mat4) => ({ world, pointer: [0, 0] as const });
/** −0 换成 +0（`R` 的 `−sy` 等项在角度为 0 时是 −0，WPE 同样；只比数值）。 */
const z = (values: readonly number[]) => values.map((value) => value + 0);

describe("解析：子系统条目（rea-p4e-children 1.1–1.4）", () => {
  it("缺省值：type static、flags 0、startindex 0、probability 1、maxcount 10；static 不读 probability / maxcount", () => {
    const entry = parseParticleChildEntry({ name: "c.json" })!;
    expect({ ...entry, local: z(entry.local) }).toEqual({
      name: "c.json",
      type: "static",
      flags: 0,
      controlPointStartIndex: 0,
      probability: 1,
      maxcount: 10,
      local: Array.from(identity()),
    });
    expect(parseParticleChildEntry({ name: "c.json", probability: 0, maxcount: 3 })).toMatchObject({
      probability: 1,
      maxcount: 10,
    });
    expect(
      parseParticleChildEntry({ name: "c.json", type: "eventfollow", probability: 0.5, maxcount: 3, flags: 3 }),
    ).toMatchObject({ type: "eventfollow", probability: 0.5, maxcount: 3, flags: 3 });
  });

  it("type 只认小写四种：大小写不同、非字符串都是 null（整条忽略）；缺 type 与 null 当 static；name 不对返回 null", () => {
    expect(parseParticleChildEntry({ name: "c.json", type: "Static" })!.type).toBeNull();
    expect(parseParticleChildEntry({ name: "c.json", type: "EVENTDEATH" })!.type).toBeNull();
    expect(parseParticleChildEntry({ name: "c.json", type: 1 })!.type).toBeNull();
    expect(parseParticleChildEntry({ name: "c.json", type: null })!.type).toBe("static");
    for (const type of ["static", "eventfollow", "eventspawn", "eventdeath"])
      expect(parseParticleChildEntry({ name: "c.json", type })!.type).toBe(type);
    expect(parseParticleChildEntry({ type: "static" })).toBeNull();
    expect(parseParticleChildEntry({ name: "" })).toBeNull();
    expect(parseParticleChildEntry("c.json")).toBeNull();
  });

  it("局部矩阵 L = T·Rz·Ry·Rx·S：角度是弧度（实测 s-xf：30 rad 转 −81.13°），缩放乘在列上，平移在第 4 列", () => {
    const { local } = parseParticleChildEntry({
      name: "c.json",
      origin: "200 0 0",
      angles: "0 0 30",
      scale: "2 2 1",
    })!;
    const [c, s] = [f32(Math.cos(f32(30))), f32(Math.sin(f32(30)))];
    expect(z(local.slice(0, 3))).toEqual([f32(c * 2), f32(s * 2), 0]);
    expect(z(local.slice(4, 7))).toEqual([f32(-s * 2), f32(c * 2), 0]);
    expect(z(local.slice(8, 11))).toEqual([0, 0, 1]);
    expect(z(local.slice(12))).toEqual([200, 0, 0, 1]);
    // x 轴转到 −81.13°（30 rad = 278.87°）
    expect((Math.atan2(local[1], local[0]) * 180) / Math.PI).toBeCloseTo(-81.13, 1);
  });

  it('向量缺分量补 0（实测 st-scale1：scale "2" 的 y、z 列全 0）；origin "100" 得 (100, 0, 0)', () => {
    const { local } = parseParticleChildEntry({ name: "c.json", scale: "2", origin: "100" })!;
    expect(z(local.slice(0, 3))).toEqual([2, 0, 0]);
    expect(z(local.slice(4, 7))).toEqual([0, 0, 0]);
    expect(z(local.slice(8, 11))).toEqual([0, 0, 0]);
    expect(z(local.slice(12, 15))).toEqual([100, 0, 0]);
  });
});

describe("控制点父分支（rea-p4c-sim.md 1.8）", () => {
  /** 父系统：一个点，base 平移 (10, 20, 0)；子系统：点 0 是 `flags`，`parentcontrolpoint` 0。 */
  function pair(selfWorld: boolean, parentWorld: boolean, flags: number) {
    const parentDef = parse(systemJson({ flags: parentWorld ? 1 : 0, controlpoint: [{ offset: "10 20 0" }] }));
    const parent = new ControlPointSet(parentDef);
    const childDef = parse(systemJson({ flags: selfWorld ? 1 : 0, controlpoint: [{ flags, parentcontrolpoint: 0 }] }));
    const child = new ControlPointSet(childDef, undefined, { parent: { points: parent, world: parentWorld } });
    return { parent, child };
  }
  const M = translation(100, 0, 0);
  const Mprev = translation(1000, 0, 0);
  const t = (set: ControlPointSet) => z(Array.from(set.current(0).translation));

  it("四种组合：本地 + 本地 inverse(M)·(Mprev·pcp)；本地 + 世界 inverse(M)·pcp；世界 + 本地 Mprev·pcp；世界 + 世界 pcp", () => {
    const cases: [boolean, boolean, number[]][] = [
      [false, false, [10 + 1000 - 100, 20, 0]],
      [false, true, [10 - 100, 20, 0]],
      [true, false, [10 + 1000, 20, 0]],
      [true, true, [10, 20, 0]],
    ];
    for (const [selfWorld, parentWorld, expected] of cases) {
      const { child } = pair(selfWorld, parentWorld, 4);
      child.update({ world: M, pointer: [0, 0], parent: Mprev });
      expect(t(child), `${selfWorld} ${parentWorld}`).toEqual(expected);
    }
  });

  it("bit3：不做换算，原样拷父的点（四种组合都一样）", () => {
    for (const selfWorld of [false, true])
      for (const parentWorld of [false, true]) {
        const { child } = pair(selfWorld, parentWorld, 4 | 8);
        child.update({ world: M, pointer: [0, 0], parent: Mprev });
        expect(t(child)).toEqual([10, 20, 0]);
      }
  });

  it("读父的 current（父更新之后跟着变）；parentcontrolpoint ≥ 父的个数（无符号）时走缺省更新；顶层没有父也走缺省", () => {
    const { parent, child } = pair(true, true, 4);
    parent.update({ world: translation(5, 0, 0), pointer: [0, 0] });
    child.update({ world: M, pointer: [0, 0], parent: Mprev });
    expect(t(child)).toEqual([15, 20, 0]);
    const outOfRange = new ControlPointSet(
      parse(systemJson({ flags: 1, controlpoint: [{ flags: 4, parentcontrolpoint: -1, offset: "1 0 0" }] })),
      undefined,
      { parent: { points: parent, world: true } },
    );
    outOfRange.update({ world: M, pointer: [0, 0], parent: Mprev });
    // 缺省更新（世界）：M·base
    expect(t(outOfRange)).toEqual([101, 0, 0]);
    const top = new ControlPointSet(parse(systemJson({ flags: 1, controlpoint: [{ flags: 4, offset: "1 0 0" }] })));
    top.update({ world: M, pointer: [0, 0] });
    expect(t(top)).toEqual([101, 0, 0]);
  });
});

describe("父粒子写子系统控制点（条目 flags bit0，第 5 节）", () => {
  /** 父：两个发射器在 (−50, 0) 与 (50, 0)（各自的控制点），每帧一个；子：缺省 8 个点。 */
  function tree(entry: Parameters<typeof attach>[2], childJson: JsonObject = {}, parentFlags = 0) {
    const root = parse({
      maxcount: 8,
      flags: parentFlags,
      emitter: [
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "-50 0 0" },
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "50 0 0" },
      ],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
    });
    attach(root, parse(systemJson(childJson, 0)), entry);
    const system = make(root);
    return { system, child: system.statics[0].system };
  }
  const point = (system: ParticleSystem, i: number) => z(Array.from(system.controlPoints.current(i).translation));

  it("存活粒子按槽号写 cp[startindex..]，只写平移；bit0 时子系统控制点强制 8 个；没有 bit0 什么都不写", () => {
    const { system, child } = tree({ flags: 1, controlPointStartIndex: 2 });
    expect(child.controlPoints.count).toBe(8);
    system.prewarm(inputsAt(translation(960, 540, 0)));
    system.step(0.1, 0.1, inputsAt(translation(960, 540, 0)));
    expect(point(child, 2)).toEqual([-50, 0, 0]);
    expect(point(child, 3)).toEqual([50, 0, 0]);
    expect(point(child, 4)).toEqual([0, 0, 0]);
    const plain = tree({ flags: 0, controlPointStartIndex: 2 });
    expect(plain.child.controlPoints.count).toBe(1);
    plain.system.step(0.1, 0.1, inputsAt(translation(960, 540, 0)));
    expect(point(plain.child, 0)).toEqual([0, 0, 0]);
  });

  it("空槽不占点；指针 / 父控制点的点跳过这个粒子、下标不变（之后的粒子也写不进）", () => {
    const { system, child } = tree({ flags: 1 });
    system.step(0.1, 0.1, inputsAt(identity()));
    // 槽 0 死掉：只剩槽 1 的粒子，写进 cp0
    system.columns.life[0] = 0;
    writeParentPoints(system, { flags: 1, controlPointStartIndex: 0 }, child, identity());
    expect(point(child, 0)).toEqual([50, 0, 0]);
    const blocked = tree({ flags: 1 }, { controlpoint: [{ flags: 1 }] });
    blocked.system.step(0.1, 0.1, inputsAt(identity()));
    // cp0 是指针点：两个粒子都被跳过，cp1 没被写
    expect(point(blocked.child, 1)).toEqual([0, 0, 0]);
  });

  it("坐标空间：父本地、子世界写 top·p；父世界、子本地写 inverse(top)·p；两边相同写 p。不补偿 L", () => {
    const W = translation(960, 540, 0);
    const local = tree({ flags: 1, origin: [0, 100, 0] }, { flags: 1 });
    local.system.step(0.1, 0.1, inputsAt(W));
    expect(point(local.child, 0)).toEqual([910, 540, 0]);
    const world = tree({ flags: 1 }, {}, 1);
    world.system.step(0.1, 0.1, inputsAt(W));
    // 父世界：粒子在世界坐标 (960 ± 50, 540)，换回父的本地
    expect(point(world.child, 0)).toEqual([-50, 0, 0]);
    const same = tree({ flags: 1, origin: [0, 100, 0] });
    same.system.step(0.1, 0.1, inputsAt(W));
    expect(point(same.child, 0)).toEqual([-50, 0, 0]);
  });

  it("子系统里 i ≥ startindex 的点不做缺省更新（世界子系统也保留写入值），i < startindex 照常 M·base", () => {
    const { system, child } = tree({ flags: 1, controlPointStartIndex: 1 }, { flags: 1 });
    system.step(0.1, 0.1, inputsAt(translation(960, 540, 0)));
    // cp0：缺省更新 M·base = W·L·0；cp1：父的槽 0 粒子（父本地 → 子世界：top·p）
    expect(point(child, 0)).toEqual([960, 540, 0]);
    expect(point(child, 1)).toEqual([910, 540, 0]);
  });
});

describe("static 子系统的模拟（3.1–3.7）", () => {
  it("每帧：子系统在父之后步进，用父的 dt′（不再乘自己的 rate）；系统时间与父相同", () => {
    const root = parse(systemJson(), { rate: 2 });
    attach(root, parse(systemJson()));
    const system = make(root);
    system.prewarm();
    for (let i = 0; i < 5; i++) system.step(0.1, 0.1 * (i + 1));
    const child = system.statics[0].system;
    expect(system.systemTime).toBeCloseTo(1, 5);
    expect(child.systemTime).toBe(system.systemTime);
    // 每秒 10 个、按 2 倍时间走：1 秒 10 个
    expect(child.alive).toBe(system.alive);
    expect(child.alive).toBe(10);
  });

  it("模拟矩阵 M = 父 M · L：本地子系统的粒子存子系统坐标，世界子系统的粒子存世界坐标 W·L·cp", () => {
    const W = translation(960, 540, 0);
    const root = parse(systemJson());
    attach(root, parse(systemJson()), { origin: [200, 0, 0] });
    attach(root, parse(systemJson({ flags: 1 })), { origin: [200, 0, 0] });
    const system = make(root);
    system.prewarm(inputsAt(W));
    system.step(0.1, 0.1, inputsAt(W));
    const [local, world] = system.statics.map((item) => item.system);
    expect(alivePositions(local)).toEqual([[0, 0, 0]]);
    expect(alivePositions(world)).toEqual([[1160, 540, 0]]);
  });

  it("预热：子系统按自己的 starttime、早于父的控制点初始化与预热；父的预热不步进子系统", () => {
    const parentWarm = parse(systemJson({ starttime: 1 }));
    attach(parentWarm, parse(systemJson()));
    const a = make(parentWarm);
    a.prewarm();
    expect(a.alive).toBe(10);
    expect(a.statics[0].system.alive).toBe(0);

    const childWarm = parse(systemJson());
    attach(childWarm, parse(systemJson({ starttime: 1 })));
    const b = make(childWarm);
    b.prewarm();
    expect(b.alive).toBe(0);
    expect(b.statics[0].system.alive).toBe(10);
  });

  it("预热的模型矩阵：世界子系统用 L（不含父 W，实测 st-wwarm）；本地子系统 父 M · L", () => {
    const W = translation(960, 540, 0);
    const root = parse(systemJson());
    attach(root, parse(systemJson({ flags: 1, starttime: 0.1 })), { origin: [200, 0, 0] });
    const system = make(root);
    system.prewarm(inputsAt(W));
    const child = system.statics[0].system;
    expect(alivePositions(child)).toEqual([[200, 0, 0]]);
    system.step(0.1, 0.1, inputsAt(W));
    expect(alivePositions(child)).toContainEqual([1160, 540, 0]);
  });

  it("预热时父分支读到父的初值（父还没更新），之后读父本帧更新过的点", () => {
    const W = translation(100, 0, 0);
    const root = parse(systemJson({ flags: 1, controlpoint: [{ offset: "10 0 0" }] }));
    attach(root, parse(systemJson({ starttime: 0.1, controlpoint: [{ flags: 4 | 8 }] })));
    const system = make(root);
    system.prewarm(inputsAt(W));
    const child = system.statics[0].system;
    // 预热：父 cp0 还是 base = (10, 0, 0)
    expect(alivePositions(child)).toEqual([[10, 0, 0]]);
    system.step(0.1, 0.1, inputsAt(W));
    // 父 cp0 更新成 W·base = (110, 0, 0)，子系统原样拷（bit3）
    expect(alivePositions(child)).toContainEqual([110, 0, 0]);
  });

  it("父存活数为 0 照样更新子系统", () => {
    const root = parse(systemJson({}, 0));
    attach(root, parse(systemJson()));
    const system = make(root);
    system.step(0.5, 0.5);
    expect(system.alive).toBe(0);
    expect(system.statics[0].system.alive).toBe(5);
  });

  it("周期复位（条目 flags bit1，实测 st-per2）：父的新周期复位并重开子系统；flags 0 只在开头发", () => {
    const parent = () =>
      parse({
        maxcount: 64,
        emitter: [
          {
            name: "sphererandom",
            distancemax: 0,
            rate: 10,
            flags: 4,
            minperiodicduration: 1,
            maxperiodicduration: 1,
            minperiodicdelay: 1,
            maxperiodicdelay: 1,
          },
        ],
        initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      });
    const child = () =>
      parse(systemJson({ emitter: [{ name: "sphererandom", distancemax: 0, rate: 10, duration: 0.3 }] }));
    const run = (flags: number) => {
      const root = parent();
      attach(root, child(), { flags });
      const system = make(root);
      for (let i = 0; i < 60; i++) system.step(0.1, 0.1 * (i + 1));
      return system.statics[0].system.alive;
    };
    // 6 秒、约每 2 秒一个新周期（共 3 个）：flags 0 只有开头那一批，flags 2 每周期重发一批、粒子不清
    const once = run(0);
    expect(once).toBeGreaterThanOrEqual(3);
    expect(once).toBeLessThanOrEqual(4);
    expect(run(2)).toBe(3 * once);
  });

  it("不可见（3.6）：顶层有存活粒子时子孙清空、计时复位，之后以 emit = false 步进（不发射）；顶层没有存活时子系统粒子照常活", () => {
    const root = parse(systemJson());
    const child = attach(root, parse(systemJson()));
    attach(child, parse(systemJson()));
    const system = make(root);
    system.step(0.5, 0.5);
    const [c] = system.statics.map((item) => item.system);
    const g = c.statics[0].system;
    expect([system.alive, c.alive, g.alive]).toEqual([5, 5, 5]);
    expect(system.suspend(inputsAt(identity()), 0.5, 1)).toBe(true);
    expect([system.alive, c.alive, g.alive]).toEqual([0, 0, 0]);
    // 复位后照常累加本帧：子孙的系统时间从 0 起
    expect(c.systemTime).toBeCloseTo(0.5, 5);
    expect(g.systemTime).toBeCloseTo(0.5, 5);
    system.suspend(inputsAt(identity()), 0.5, 1.5);
    expect([c.alive, g.alive]).toEqual([0, 0]);

    // 顶层没有存活：子系统不复位，粒子照常模拟（年龄增长），不发射
    const quiet = parse(systemJson({}, 0));
    attach(quiet, parse(systemJson()));
    const q = make(quiet);
    q.step(0.5, 0.5);
    const qc = q.statics[0].system;
    expect(qc.alive).toBe(5);
    expect(q.suspend(inputsAt(identity()), 0.5, 1)).toBe(false);
    expect(qc.alive).toBe(5);
    expect(qc.columns.age[0]).toBeCloseTo(0.5, 5);
  });

  it("深度上限 10：自引用的系统到第 10 层停，共 11 个系统（实测 st-depth 11 次绘制）", () => {
    const self = parse(systemJson());
    self.children.push({
      index: 0,
      type: "static",
      flags: 0,
      controlPointStartIndex: 0,
      probability: 1,
      maxcount: 10,
      local: childLocalMatrix([10, 0, 0], [0, 0, 0], [1, 1, 1]),
      system: self,
    });
    const system = make(self);
    const nodes: number[][] = [];
    system.forEachDrawn((node, path) => {
      nodes.push([...path]);
      expect(node.depth).toBe(path.length);
    });
    expect(MAX_CHILD_DEPTH).toBe(10);
    expect(nodes).toHaveLength(11);
    expect(nodes.at(-1)).toEqual(Array(10).fill(0));
    expect(system.node(Array(10).fill(0))?.statics).toEqual([]);
    expect(system.node(Array(11).fill(0))).toBeNull();
  });

  it("实例覆盖：子系统取对象的值，受子系统自己 flags bit3–7 约束（实测 s-io、st-io248）；运行时改值递归", () => {
    const run = (childFlags: number, instance: JsonObject) => {
      const root = parse(systemJson(), instance);
      attach(root, parse(systemJson({ flags: childFlags })));
      const system = make(root);
      system.step(0.5, 0.5);
      return system;
    };
    expect(run(0, { count: 2 }).statics[0].system.alive).toBe(10);
    expect(run(0x20, { count: 2 }).statics[0].system.alive).toBe(5);
    const system = run(0, {});
    system.setInstance({ count: 3 });
    system.step(0.5, 1);
    expect(system.statics[0].system.alive).toBe(5 + 15);
  });

  it("类型不是 static 的条目本步不建（事件类由能力表报）", () => {
    const root = parse(systemJson());
    attach(root, parse(systemJson()), { type: "eventfollow" });
    attach(root, parse(systemJson()));
    const system = make(root);
    expect(system.statics.map((item) => item.index)).toEqual([1]);
  });
});

describe("绘制：模型矩阵与计划（第 6 节）", () => {
  it("模型矩阵：本地子系统 父绘制栈顶 · L，世界子系统单位阵，世界子系统下的本地孙辈 L·L₂（3.3 照复刻）", () => {
    const W = translation(960, 540, 0);
    const root = parse(systemJson());
    const local = attach(root, parse(systemJson()), { origin: [200, 0, 0] });
    attach(local, parse(systemJson()), { origin: [0, 50, 0] });
    const world = attach(root, parse(systemJson({ flags: 1 })), { origin: [300, 0, 0] });
    attach(world, parse(systemJson()), { origin: [0, 70, 0] });
    expect(particleDrawModel(W, root, [])).toBe(W);
    expect(Array.from(particleDrawModel(W, root, [0]))).toEqual(Array.from(multiply(W, translation(200, 0, 0))));
    expect(Array.from(particleDrawModel(W, root, [0, 0]))).toEqual(Array.from(translation(1160, 590, 0)));
    expect(Array.from(particleDrawModel(W, root, [1]))).toEqual(Array.from(identity()));
    expect(Array.from(particleDrawModel(W, root, [1, 0]))).toEqual(Array.from(translation(300, 70, 0)));
    // 世界顶层：绘制单位阵，子系统仍乘 W（画完把栈顶恢复成 W）
    const worldRoot = parse(systemJson({ flags: 1 }));
    attach(worldRoot, parse(systemJson()), { origin: [200, 0, 0] });
    expect(Array.from(particleDrawModel(W, worldRoot, []))).toEqual(Array.from(identity()));
    expect(Array.from(particleDrawModel(W, worldRoot, [0]))).toEqual(Array.from(translation(1160, 540, 0)));
  });

  const pass = (key: string, extra: Partial<ScenePass> = {}): ScenePass => ({
    key,
    program: 0,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  });
  const withPass = (def: SceneParticle, key: string, extra: Partial<ScenePass> = {}) => {
    def.passes = [pass(key, extra)];
    return def;
  };

  it("先序展开：父 → static 子系统（条目顺序、深度优先）；事件类不画；每次绘制各自的透视位、世界位与混合", () => {
    const root = withPass(parse(systemJson()), "r");
    attach(root, withPass(parse(systemJson()), "e"), { type: "eventfollow" });
    const a = attach(root, withPass(parse(systemJson({ flags: 4 })), "a", { blending: "additive" }));
    attach(a, withPass(parse(systemJson({ flags: 1 })), "a0"));
    attach(root, withPass(parse(systemJson()), "b"));
    const plan = planParticleLayer({ particle: root });
    expect(plan.steps.map((step) => (step.kind === "particles" ? [step.pass.key, step.node] : step.kind))).toEqual([
      ["r", []],
      ["a", [1]],
      ["a0", [1, 0]],
      ["b", [2]],
    ]);
    expect(plan.steps[1]).toMatchObject({ perspective: true, world: false, blending: "additive" });
    expect(plan.steps[2]).toMatchObject({ perspective: false, world: true });
  });

  it("快照：先序里第一个需要帧缓冲的系统之前拷一次，同一对象只拷一次（实测 dr-refract 的父子共用位）", () => {
    const refract = { framebuffer: true, runtime: { 3: "_rt_FullFrameBuffer" } };
    const childOnly = withPass(parse(systemJson()), "r");
    attach(childOnly, withPass(parse(systemJson()), "c", refract));
    attach(childOnly, withPass(parse(systemJson()), "d", refract));
    expect(planParticleLayer({ particle: childOnly }).steps.map((step) => step.kind)).toEqual([
      "particles",
      "snapshot",
      "particles",
      "particles",
    ]);
    const both = withPass(parse(systemJson()), "r", refract);
    attach(both, withPass(parse(systemJson()), "c", refract));
    expect(planParticleLayer({ particle: both }).steps.map((step) => step.kind)).toEqual([
      "snapshot",
      "particles",
      "particles",
    ]);
  });

  it("没有 pass 的系统整棵子树不画；renderer: [] 的系统自己不画、照常画子系统", () => {
    const noPass = withPass(parse(systemJson()), "r");
    const hole = attach(noPass, parse(systemJson()));
    attach(hole, withPass(parse(systemJson()), "under"));
    expect(planParticleLayer({ particle: noPass }).steps).toHaveLength(1);
    const emitterOnly = withPass(parse(systemJson({ renderer: [] })), "r");
    attach(emitterOnly, withPass(parse(systemJson()), "c"));
    expect(
      planParticleLayer({ particle: emitterOnly }).steps.map((step) =>
        step.kind === "particles" ? step.pass.key : "",
      ),
    ).toEqual(["c"]);
  });

  it("particleTrack：子系统按先序接在父后面，键 <名字>/<路径>；没有子系统时键不变", () => {
    const root = parse(systemJson());
    attach(root, parse(systemJson()), { origin: [200, 0, 0] });
    const track = particleTrack({
      layers: [{ object: 0, name: "p", particle: root }],
      dts: [0.1, 0.1],
      frames: [2],
      passes: 1,
    });
    expect(Object.keys(track.frames[0].systems)).toEqual(["p", "p/0"]);
    expect(track.frames[0].systems["p/0"]).toHaveLength(2);
  });
});
