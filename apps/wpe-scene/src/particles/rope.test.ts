/**
 * P4d 步骤 1：`rope` 的 rope 表（`RopeOrder`，模拟器维护）与段顶点（`writeRopeSegments`）。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md` 1.2–1.4、第 2 节（读码【确】），实测见 `p4-particles-REPORT.md`
 * 「P4d 语义的实测核对」的 rope 表（表序就是出生序、保序删除；缺省 `subdivision 4`、`uvsmoothing true`；`uvscrolling` 的 `TP0` 是
 * 累计死亡数；存活数 2 的特例；`uvscale` 存倒数）。和 WPE 抓帧逐段比的回放在 `ignore/p4/d1/`。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, type RopeRenderer, type SceneParticle } from "../compile/particles";
import { vertexPacking } from "../render/programs";
import { ParticleColumns } from "./columns";
import { COLUMN_FLAGS, readParticleModule } from "./modules";
import { SeededRandom } from "./random";
import { RopeOrder, ropeTexCoords, ropeVertexLayout, writeRopeSegments, type RopeSource } from "./rope";
import { ParticleSystem } from "./system";

const f32 = Math.fround;

describe("RopeOrder（rope 表，rea-p4d-rope.md 第 2 节）", () => {
  const table = (order: RopeOrder) => Array.from(order.slots.subarray(0, order.length));

  it("出生时追加到表尾；表满了照样追加（WPE 是 std::vector）", () => {
    const order = new RopeOrder(2);
    for (const slot of [3, 0, 2]) order.push(slot);
    expect(table(order)).toEqual([3, 0, 2]);
    expect(order.length).toBe(3);
  });

  it("中间删除保序（不是交换删除）；一帧死多个一起删", () => {
    const order = new RopeOrder(8);
    for (const slot of [5, 0, 6, 1, 7, 2]) order.push(slot);
    order.removeDead([0]);
    expect(table(order)).toEqual([5, 6, 1, 7, 2]);
    order.removeDead([1, 5]);
    expect(table(order)).toEqual([6, 7, 2]);
    // 不在表里的槽号不影响
    order.removeDead([4]);
    expect(table(order)).toEqual([6, 7, 2]);
  });

  it("同一槽出现多次也删光（WPE 删除后不跳出、继续查同一位置）", () => {
    const order = new RopeOrder(8);
    for (const slot of [1, 3, 1, 1, 4, 3]) order.push(slot);
    order.removeDead([1]);
    expect(table(order)).toEqual([3, 4, 3]);
    order.removeDead([3]);
    expect(table(order)).toEqual([4]);
  });

  it("clear 清空", () => {
    const order = new RopeOrder(4);
    order.push(1);
    order.push(2);
    order.clear();
    expect(order.length).toBe(0);
    order.push(9);
    expect(table(order)).toEqual([9]);
  });
});

/** 翻译后 `genericropeparticle`（`THICKFORMAT`、`GS_ENABLED`）的 6 个输入，故意打乱 location：偏移按反射排，不写死。 */
const ROPE_ATTRIBUTES = [
  { name: "a_Color", location: 0, type: "vec4" },
  { name: "a_PositionVec4", location: 1, type: "vec4" },
  { name: "a_TexCoordVec4", location: 2, type: "vec4" },
  { name: "a_TexCoordVec4C1", location: 3, type: "vec4" },
  { name: "a_TexCoordVec4C2", location: 4, type: "vec4" },
  { name: "a_TexCoordVec4C3", location: 5, type: "vec4" },
];
const { layout: LAYOUT, problems: LAYOUT_PROBLEMS } = ropeVertexLayout(vertexPacking(ROPE_ATTRIBUTES, "instance"));

describe("ropeVertexLayout", () => {
  it("6 个 vec4 输入按反射偏移；步长 24 个 float（WPE 96 字节）", () => {
    expect(LAYOUT_PROBLEMS).toEqual([]);
    expect(LAYOUT).toEqual({ stride: 24, color: 0, start: 4, end: 8, cp0: 12, cp1: 16, endColor: 20 });
  });

  it("认不得的输入、分量数不对的照报 render:particle-attribute", () => {
    const { problems } = ropeVertexLayout(
      vertexPacking([
        { name: "a_PositionVec4", location: 0, type: "vec4" },
        { name: "a_TexCoordVec4C2", location: 1, type: "vec3" },
        { name: "a_Position", location: 2, type: "vec3" },
      ]),
    );
    expect(problems).toEqual([
      "render:particle-attribute:a_TexCoordVec4C2:3f32",
      "render:particle-attribute:a_Position",
    ]);
  });
});

interface Particle {
  pos: [number, number, number];
  size?: number;
  rgba?: [number, number, number, number];
  age?: number;
}

/**
 * 手写的系统状态：`particles[i]` 放在槽 `slots[i]`（缺省槽号 = 下标），rope 表按 `order`（槽号）排；`rope` 覆盖绘制参数（缺省
 * `K = 1`、不滚动、不平滑、`R = L = 0`）。
 */
function source(
  particles: Particle[],
  options: {
    order?: number[];
    slots?: number[];
    rope?: Partial<RopeRenderer>;
    deaths?: number;
    count?: number;
    lifetime?: number;
    alive?: number;
  } = {},
): RopeSource {
  const slots = options.slots ?? particles.map((_, i) => i);
  const columns = new ParticleColumns(Math.max(...slots) + 1, COLUMN_FLAGS.color | COLUMN_FLAGS.alpha);
  particles.forEach((p, i) => {
    const slot = slots[i];
    for (let k = 0; k < 3; k++) {
      columns.position[k][slot] = p.pos[k];
      columns.color[k][slot] = p.rgba?.[k] ?? 1;
    }
    columns.alpha[slot] = p.rgba?.[3] ?? 1;
    columns.size[slot] = p.size ?? 20;
    columns.age[slot] = p.age ?? 0;
    columns.life[slot] = 1;
  });
  const order = new RopeOrder(columns.capacity);
  for (const slot of options.order ?? slots) order.push(slot);
  return {
    columns,
    alive: options.alive ?? particles.length,
    ropeOrder: order,
    deaths: options.deaths ?? 0,
    def: {
      renderer: {
        rope: {
          subdivision: 0,
          inverseScale: 1,
          scrolling: false,
          smoothing: false,
          lifetime: 0,
          rate: 0,
          ...options.rope,
        },
      },
    },
    instanceScalar: (field) => (field === "count" ? (options.count ?? 1) : (options.lifetime ?? 1)),
  };
}

/** 第 k 段的各项（按 `LAYOUT`）。 */
function segment(out: Float32Array, k: number) {
  const at = (offset: number) => Array.from(out.subarray(k * LAYOUT.stride + offset, k * LAYOUT.stride + offset + 4));
  return {
    start: at(LAYOUT.start),
    end: at(LAYOUT.end),
    cp0: at(LAYOUT.cp0),
    cp1: at(LAYOUT.cp1),
    endColor: at(LAYOUT.endColor),
    color: at(LAYOUT.color),
  };
}

const write = (src: RopeSource, fps = 60, segments = 16) => {
  const out = new Float32Array(segments * LAYOUT.stride);
  const count = writeRopeSegments(src, LAYOUT, out, fps);
  return { out, count };
};

describe("writeRopeSegments（rea-p4d-rope.md 1.3、1.4）", () => {
  // 4 个粒子放在槽 0–3，rope 表顺序（出生序）是槽 2、0、3、1
  const P: Particle[] = [
    { pos: [10, 0, 0], size: 11, rgba: [0.1, 0, 0, 1] },
    { pos: [30, 1, 0], size: 13, rgba: [0.3, 0, 0, 0.5] },
    { pos: [0, 2, 0], size: 10, rgba: [0, 0, 0, 1] },
    { pos: [20, 3, 0], size: 12, rgba: [0.2, 0, 0, 0.25] },
  ];
  const ORDER = [2, 0, 3, 1];

  it("段 k 连 idx[k] → idx[k+1]；首段 CP0 取起点自身、末段 CP1 取终点自身，中段取 idx[k−1] / idx[k+2]", () => {
    const { out, count } = write(source(P, { order: ORDER }));
    expect(count).toBe(3);
    const pos = (slot: number) => P[slot].pos;
    // 首段：a = 槽 2，b = 槽 0，c = 槽 2（自身），d = 槽 3
    expect(segment(out, 0).start).toEqual([...pos(2), 10]);
    expect(segment(out, 0).end).toEqual([...pos(0), 4]);
    expect(segment(out, 0).cp0).toEqual([...pos(2), 0]);
    expect(segment(out, 0).cp1).toEqual([...pos(3), 11]);
    // 中段：a = 槽 0，b = 槽 3，c = 槽 2，d = 槽 1
    expect(segment(out, 1).start).toEqual([...pos(0), 11]);
    expect(segment(out, 1).end).toEqual([...pos(3), 4]);
    expect(segment(out, 1).cp0).toEqual([...pos(2), 1]);
    expect(segment(out, 1).cp1).toEqual([...pos(1), 12]);
    // 末段：a = 槽 3，b = 槽 1，c = 槽 0，d = 槽 1（终点自身）
    expect(segment(out, 2).start).toEqual([...pos(3), 12]);
    expect(segment(out, 2).end).toEqual([...pos(1), 4]);
    expect(segment(out, 2).cp0).toEqual([...pos(0), 2]);
    expect(segment(out, 2).cp1).toEqual([...pos(1), 13]);
    // 颜色：a_TexCoordVec4C3 是终点、a_Color 是起点（rgba 当前值）
    expect(segment(out, 0).endColor).toEqual([0.1, 0, 0, 1].map(f32));
    expect(segment(out, 0).color).toEqual([0, 0, 0, 1].map(f32));
    expect(segment(out, 2).endColor).toEqual([0.3, 0, 0, 0.5].map(f32));
    expect(segment(out, 2).color).toEqual([0.2, 0, 0, 0.25].map(f32));
  });

  it("存活数 ≤ 1 返回 0、不写；存活数 2 的特例：TL = 2、TP = 0，不乘 K，不看滚动与平滑；CP 取两端自身", () => {
    const single = write(source([P[0]]));
    expect(single.count).toBe(0);
    expect(single.out.every((value) => value === 0)).toBe(true);
    expect(write(source([])).count).toBe(0);
    for (const rope of [
      { inverseScale: 2, scrolling: true, rate: 4, lifetime: 1.6 },
      { inverseScale: 2, smoothing: true, rate: 4, lifetime: 1.6 },
    ]) {
      const { out, count } = write(source([P[2], P[0]], { rope, deaths: 7 }));
      expect(count).toBe(1);
      expect(segment(out, 0).end[3]).toBe(2);
      expect(segment(out, 0).cp0).toEqual([...P[2].pos, 0]);
      expect(segment(out, 0).cp1).toEqual([...P[0].pos, 11]);
    }
  });

  it("缺省（不平滑、不滚动）：TL = 存活数·K，TP = k；K = 1/uvscale", () => {
    const { out } = write(source(P, { order: ORDER, rope: { inverseScale: 2 } }));
    expect([0, 1, 2].map((k) => segment(out, k).end[3])).toEqual([8, 8, 8]);
    expect([0, 1, 2].map((k) => segment(out, k).cp0[3])).toEqual([0, 1, 2]);
  });

  it("放不下的段不写", () => {
    const { count } = write(source(P, { order: ORDER }), 60, 2);
    expect(count).toBe(2);
  });
});

describe("ropeTexCoords：TL 与 TP0（rea-p4d-rope.md 1.2）", () => {
  /** `n` 个粒子沿 x 排，最老的（表头）年龄 `oldest`。 */
  const line = (n: number, oldest: number) =>
    Array.from({ length: n }, (_, i): Particle => ({ pos: [i * 10, 0, 0], age: i === 0 ? oldest : 0 }));
  const uv = (
    n: number,
    rope: Partial<RopeRenderer>,
    extra: Parameters<typeof source>[1] = {},
    fps = 60,
    oldest = 0.9,
  ) => ropeTexCoords(source(line(n, oldest), { rope, ...extra }), fps, n);

  it("平滑：存活数 = N − 1 时进平滑分支（相等不算小于）；TP0 = saturate((L − age最老)·Rf) − 1，先求倒数再除", () => {
    // R = 4、L = 1：R·L = 4 > 3，Rf = min(60, 4) = 4，N = 4，N − 1 = 3 = 存活数
    const boundary = uv(3, { smoothing: true, rate: 4, lifetime: 1 });
    expect(boundary.length).toBe(3);
    expect(boundary.position).toBe(f32(f32(f32(1 - f32(0.9)) / f32(1 / 4)) - 1));
    expect(boundary.position).toBeCloseTo(-0.6, 6);
    // 年龄超过 L：saturate 到 0，TP0 = −1
    const old = ropeTexCoords(source(line(3, 1.5), { rope: { smoothing: true, rate: 4, lifetime: 1 } }), 60, 3);
    expect(old).toEqual({ length: 3, position: -1 });
    // 存活数 < N − 1：不平滑（R = 4、L = 1.5：N − 1 = 5 > 4）
    expect(uv(4, { smoothing: true, rate: 4, lifetime: 1.5 })).toEqual({ length: 4, position: 0 });
    // 存活数 > N − 1：平滑，TL = (N − 1)·K
    const over = uv(8, { smoothing: true, rate: 4, lifetime: f32(1.6), inverseScale: 2 });
    expect(over.length).toBe(f32(f32(f32(4 * f32(1.6)) - 1) * 2));
  });

  it("平滑：L = 0（没有 lifetimerandom）时 N = 0，不平滑", () => {
    expect(uv(5, { smoothing: true, rate: 4, lifetime: 0 })).toEqual({ length: 5, position: 0 });
  });

  it("滚动：TL = (N − 1)·K，TP0 = 累计死亡数（不看 uvsmoothing）", () => {
    const scroll = uv(
      5,
      { scrolling: true, smoothing: false, rate: 4, lifetime: f32(1.6), inverseScale: 0.5 },
      {
        deaths: 55,
      },
    );
    expect(scroll).toEqual({ length: f32(f32(f32(4 * f32(1.6)) - 1) * 0.5), position: 55 });
    const { out } = write(source(line(5, 0), { rope: { scrolling: true, rate: 4, lifetime: f32(1.6) }, deaths: 55 }));
    expect([0, 1, 2, 3].map((k) => segment(out, k).cp0[3])).toEqual([55, 56, 57, 58]);
    expect(segment(out, 0).end[3]).toBe(f32(f32(4 * f32(1.6)) - 1));
  });

  it("读 fps：绳没满（R·L > 存活数）时 Rf = min(fps, R)；满了用 R，和 fps 无关", () => {
    // rea 的例子：rate 100、lifetime 0.5，存活 10。fps 60：N = 30，N − 1 = 29 > 10，不平滑；fps 10：N = 5，平滑，TL = 4
    const rope = { smoothing: true, rate: 100, lifetime: 0.5 };
    expect(uv(10, rope, {}, 60)).toEqual({ length: 10, position: 0 });
    const ten = uv(10, rope, {}, 10, 0.45);
    expect(ten.length).toBe(4);
    expect(ten.position).toBe(f32(f32(f32(f32(0.5) - f32(0.45)) / f32(1 / 10)) - 1));
    expect(ten.position).toBeCloseTo(-0.5, 5);
    // 满了（R·L = 4，不大于存活数 4）：Rf = R = 4，fps 1 不起作用（N − 1 = 3 ≤ 4，平滑）
    const full = uv(4, { smoothing: true, rate: 4, lifetime: 1 }, {}, 1);
    expect(full.length).toBe(3);
    expect(full.position).toBeCloseTo(-0.6, 6);
  });

  it("R、L 乘 instanceoverride 的 count、lifetime", () => {
    // count 2、lifetime 2：R = 8、L = 2，N = 16
    expect(uv(20, { scrolling: true, rate: 4, lifetime: 1 }, { count: 2, lifetime: 2 })).toEqual({
      length: 15,
      position: 0,
    });
  });
});

describe("compile：rope 的字段与绘制参数（rea-p4d-rope.md 3.1、3.2）", () => {
  const read = (fields: JsonObject = {}) => readParticleModule("renderer", { name: "rope", ...fields }, true);

  it("缺省 subdivision 4、uvscale 1、uvscrolling false、uvsmoothing true；正交透视一套", () => {
    for (const orthographic of [true, false])
      expect(readParticleModule("renderer", { name: "rope" }, orthographic).fields).toEqual({
        subdivision: 4,
        uvscale: 1,
        uvscrolling: 0,
        uvsmoothing: 1,
        orientation: "screen",
        axis: [0, 0, 0],
        flags: 0,
      });
  });

  it("subdivision 钳到 [0, 32]、取整；布尔按 asBool（数字非 0 为真）", () => {
    expect([-3, 0, 3, 16, 32, 40, 7.9].map((value) => read({ subdivision: value }).fields.subdivision)).toEqual([
      0, 0, 3, 16, 32, 32, 7,
    ]);
    expect(read({ uvscrolling: true, uvsmoothing: false }).fields).toMatchObject({ uvscrolling: 1, uvsmoothing: 0 });
    expect(read({ uvscrolling: 2, uvsmoothing: 0 }).fields).toMatchObject({ uvscrolling: 1, uvsmoothing: 0 });
    expect(read({ uvscrolling: "yes" }).issues).toEqual([{ field: "uvscrolling", kind: "value" }]);
  });

  const renderer = (rope: JsonObject, extra: JsonObject = {}) =>
    parseParticle({ renderer: [{ name: "rope", ...rope }], ...extra }, { file: "p.json", orthographic: true }).renderer;

  it("K = 1/uvscale（float32），uvscale 0 时保持 1；滚动时不平滑", () => {
    expect(renderer({}).rope).toMatchObject({ subdivision: 4, inverseScale: 1, scrolling: false, smoothing: true });
    expect(renderer({ uvscale: 0.5 }).rope!.inverseScale).toBe(2);
    expect(renderer({ uvscale: 3 }).rope!.inverseScale).toBe(f32(1 / 3));
    expect(renderer({ uvscale: 0 }).rope!.inverseScale).toBe(1);
    expect(renderer({ uvscrolling: true }).rope).toMatchObject({ scrolling: true, smoothing: false });
    expect(renderer({ uvsmoothing: false }).rope).toMatchObject({ scrolling: false, smoothing: false });
    expect(renderer({ orientation: "fixed" })).toMatchObject({ kind: "rope", trail: null, orientation: { mode: 2 } });
  });

  it("L：第一个中点非零的 lifetimerandom；R：第一个 rate 非零的 sphererandom / boxrandom；没有时为 0；不乘 instanceoverride", () => {
    const rope = renderer(
      {},
      {
        emitter: [
          { name: "sphererandom", rate: 0 },
          { name: "boxrandom", rate: 7.3 },
          { name: "sphererandom", rate: 2 },
        ],
        initializer: [
          { name: "lifetimerandom", min: 0, max: 0 },
          { name: "lifetimerandom", min: 0.3, max: 1.1 },
          { name: "lifetimerandom", min: 5, max: 5 },
        ],
      },
    ).rope!;
    expect(rope.rate).toBe(f32(7.3));
    expect(rope.lifetime).toBe(f32(f32(f32(f32(1.1) - f32(0.3)) * 0.5) + f32(0.3)));
    // 缺省值：sphererandom 的 rate 10，lifetimerandom 的 0–1（中点 0.5）
    expect(
      renderer({}, { emitter: [{ name: "sphererandom" }], initializer: [{ name: "lifetimerandom" }] }).rope,
    ).toMatchObject({ rate: 10, lifetime: 0.5 });
    expect(renderer({}).rope).toMatchObject({ rate: 0, lifetime: 0 });
    // instanceoverride 不进这里（写段顶点时才乘）
    expect(
      parseParticle(
        { renderer: [{ name: "rope" }], emitter: [{ name: "sphererandom", rate: 4 }] },
        { file: "p.json", orthographic: true, instanceoverride: { count: 3 } },
      ).renderer.rope!.rate,
    ).toBe(4);
  });
});

/** rope 系统：发射器在原点、不散开，沿 +x 走；`extra` 覆盖系统级键。 */
function ropeSystem(extra: JsonObject = {}, instanceoverride?: unknown): SceneParticle {
  return parseParticle(
    {
      maxcount: 8,
      emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 4 }],
      initializer: [
        { name: "lifetimerandom", min: 1.6, max: 1.6 },
        { name: "sizerandom", min: 40, max: 40 },
        { name: "velocityrandom", min: "200 0 0", max: "200 0 0" },
      ],
      operator: [{ name: "movement" }],
      renderer: [{ name: "rope", uvsmoothing: false }],
      ...extra,
    },
    { file: "p.json", orthographic: true, instanceoverride },
  );
}

describe("模拟器维护 rope 表与累计死亡数（rea-p4d-rope.md 2.2–2.4）", () => {
  const tableOf = (system: ParticleSystem) => Array.from(system.ropeOrder!.slots.subarray(0, system.ropeOrder!.length));
  const aliveSlots = (system: ParticleSystem) => {
    const out: number[] = [];
    for (let i = 0; i < system.highWater; i++) if (system.columns.life[i] !== 0) out.push(i);
    return out;
  };

  it("只有 rope 系统有表；sprite 系统为 null、不累计死亡数", () => {
    expect(new ParticleSystem(ropeSystem(), new SeededRandom(1), 1).ropeOrder).not.toBeNull();
    const sprite = new ParticleSystem(ropeSystem({ renderer: [{ name: "sprite" }] }), new SeededRandom(1), 1);
    expect(sprite.ropeOrder).toBeNull();
    for (let i = 0; i < 20; i++) sprite.step(0.25);
    expect(sprite.deaths).toBe(0);
  });

  it("稳态下槽位复用：表序仍是出生序（位置严格单调、不回跳），表就是全部存活槽；死亡数按帧累计", () => {
    const system = new ParticleSystem(ropeSystem(), new SeededRandom(1), 1);
    let reordered = 0;
    let births = 0;
    for (let frame = 0; frame < 40; frame++) {
      const before = system.alive;
      const deathsBefore = system.deaths;
      system.step(0.1);
      // 每帧最多发 1 个（rate 4、dt 0.1）
      births += system.alive - before + (system.deaths - deathsBefore);
      const table = tableOf(system);
      expect([...table].sort((a, b) => a - b)).toEqual(aliveSlots(system));
      if (table.join() !== aliveSlots(system).join()) reordered++;
      const xs = table.map((slot) => system.columns.position[0][slot]);
      for (let i = 1; i < xs.length; i++) expect(xs[i], `帧 ${frame}`).toBeLessThan(xs[i - 1]);
    }
    expect(system.deaths).toBeGreaterThan(5);
    expect(births).toBe(system.deaths + system.alive);
    // 槽序和表序不同的帧确实出现过（槽位复用第一个空槽）
    expect(reordered).toBeGreaterThan(0);
  });

  it("中间的粒子先死：保序删除，占用它的槽的新粒子出现在表尾", () => {
    const system = new ParticleSystem(ropeSystem({ maxcount: 16 }), new SeededRandom(1), 1);
    for (let frame = 0; frame < 4; frame++) system.step(0.25);
    const before = tableOf(system);
    expect(before.length).toBe(4);
    const victim = before[1];
    // 让表里第 2 个粒子下一帧判死（life 比年龄小）
    system.columns.life[victim] = f32(1e-6);
    system.step(0.25);
    const after = tableOf(system);
    expect(after.slice(0, 3)).toEqual([before[0], before[2], before[3]]);
    // 判死在发射之前：新粒子复用了刚空出的槽，排在表尾
    expect(after.at(-1)).toBe(victim);
    expect(system.deaths).toBe(1);
  });

  it("clear（不可见时 suspend）清空表与死亡数；预热照常维护（starttime 2 预热后死亡数非零、表等于存活槽）", () => {
    const system = new ParticleSystem(ropeSystem(), new SeededRandom(1), 1);
    for (let frame = 0; frame < 30; frame++) system.step(0.1);
    expect(system.deaths).toBeGreaterThan(0);
    expect(system.suspend()).toBe(true);
    expect(system.ropeOrder!.length).toBe(0);
    expect(system.deaths).toBe(0);
    const warmed = new ParticleSystem(ropeSystem({ starttime: 2 }), new SeededRandom(1), 1);
    warmed.prewarm();
    expect(warmed.deaths).toBeGreaterThan(0);
    expect(tableOf(warmed).sort((a, b) => a - b)).toEqual(aliveSlots(warmed));
  });

  it("两遍模式不影响表（发射、判死每帧各一次）", () => {
    const one = new ParticleSystem(ropeSystem(), new SeededRandom(1), 1);
    const two = new ParticleSystem(ropeSystem(), new SeededRandom(1), 2);
    for (let frame = 0; frame < 30; frame++) {
      one.step(0.1);
      two.step(0.1);
    }
    expect(tableOf(two)).toEqual(tableOf(one));
    expect(two.deaths).toBe(one.deaths);
  });

  it("writeRopeSegments 读真实系统：段数 = 存活数 − 1，按表序；instanceoverride 的 count、lifetime 进 R、L", () => {
    const system = new ParticleSystem(
      ropeSystem({ renderer: [{ name: "rope", uvscrolling: true }] }, { count: 2, lifetime: 0.5 }),
      new SeededRandom(1),
      1,
    );
    for (let frame = 0; frame < 30; frame++) system.step(0.1);
    const out = new Float32Array(8 * LAYOUT.stride);
    const count = writeRopeSegments(system, LAYOUT, out, 60);
    expect(count).toBe(system.alive - 1);
    const table = tableOf(system);
    for (let k = 0; k < count; k++)
      expect(segment(out, k).start.slice(0, 3)).toEqual(
        [0, 1, 2].map((axis) => system.columns.position[axis][table[k]]),
      );
    // R = 4·2 = 8、L = 1.6·0.5 = 0.8：N = 6.4，TL = N − 1
    expect(segment(out, 0).end[3]).toBe(f32(f32(8 * f32(f32(1.6) * 0.5)) - 1));
    expect(segment(out, 0).cp0[3]).toBe(system.deaths);
  });
});
