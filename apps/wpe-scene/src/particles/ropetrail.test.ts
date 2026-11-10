/**
 * P4d 步骤 2：`ropetrail` 的历史（`TrailHistory`，模拟器调它的三个挂钩）、段顶点（`writeTrailSegments`）、`g_RenderVar0`
 * （`trailRenderVar0`），以及模块表与解析出的绘制参数。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md` 3.1、3.4、第 4、5 节（读码【确】），实测见 `p4-particles-REPORT.md`
 * 「P4d 语义的实测核对」的 ropetrail 表（计时器 ≤ 0 采样、余量丢掉、每帧最多一次；段 0 是「当前位置 → h[0]」；`C·K` 封顶 n；钳制；
 * `RV0`）。和 WPE 抓帧逐段比的回放在 `ignore/p4/d2/`。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, type RopeTrailRenderer, type SceneParticle } from "../compile/particles";
import { vertexPacking } from "../render/programs";
import { ParticleColumns } from "./columns";
import { COLUMN_FLAGS, readParticleModule } from "./modules";
import { SeededRandom } from "./random";
import { trailRenderVar0, TrailHistory, trailVertexLayout, writeTrailSegments, type TrailSource } from "./ropetrail";
import { ParticleSystem } from "./system";

const f32 = Math.fround;
type Vec3 = [number, number, number];

/** 槽 i 放在 `positions[i]`；`dead` 里的槽 `life = 0`。 */
function columnsOf(positions: Vec3[], dead: number[] = []): ParticleColumns {
  const columns = new ParticleColumns(positions.length, COLUMN_FLAGS.color | COLUMN_FLAGS.alpha);
  positions.forEach((p, i) => {
    for (let k = 0; k < 3; k++) columns.position[k][i] = p[k];
    columns.life[i] = dead.includes(i) ? 0 : 1;
  });
  return columns;
}

/** 槽 `slot` 的第 j 个历史位置。 */
const historyAt = (history: TrailHistory, slot: number, j: number): Vec3 => {
  const at = (slot * history.segments + j) * 3;
  return [history.positions[at], history.positions[at + 1], history.positions[at + 2]];
};
const historyOf = (history: TrailHistory, slot: number) =>
  Array.from({ length: history.segments }, (_, j) => historyAt(history, slot, j));

/** 把槽 `slot` 的历史设成 `points`（新的在前）。 */
function setHistory(history: TrailHistory, slot: number, points: Vec3[]): void {
  points.forEach((p, j) => history.positions.set(p, (slot * history.segments + j) * 3));
}

const move = (columns: ParticleColumns, slot: number, p: Vec3) => {
  for (let k = 0; k < 3; k++) columns.position[k][slot] = p[k];
};

const INTERVAL = f32(0.25);

describe("TrailHistory（rea-p4d-rope.md 第 5 节）", () => {
  it("出生：历史全写出生位置，C = 1，U = 0；计时器初值 0", () => {
    const history = new TrailHistory(3, 4, true);
    expect(history.timer).toBe(0);
    history.scrolls![1] = 9;
    history.counts[1] = 4;
    history.born(
      1,
      columnsOf([
        [0, 0, 0],
        [5, 6, 7],
        [0, 0, 0],
      ]),
    );
    expect(historyOf(history, 1)).toEqual([
      [5, 6, 7],
      [5, 6, 7],
      [5, 6, 7],
      [5, 6, 7],
    ]);
    expect([history.counts[1], history.scrolls![1]]).toEqual([1, 0]);
    // 不滚动时没有 U
    expect(new TrailHistory(3, 4, false).scrolls).toBeNull();
  });

  it("timer − dt' 恰好为 0 时采样（`!(0 < timer)`，比较常量就是 0）；还有正余量时不采", () => {
    const columns = columnsOf([[1, 2, 3]]);
    const history = new TrailHistory(1, 4, false);
    history.born(0, columns);
    history.timer = INTERVAL;
    history.sample(f32(0.24), INTERVAL, columns, 1, 1);
    expect(history.timer).toBe(f32(INTERVAL - f32(0.24)));
    expect(history.counts[0]).toBe(1);
    history.timer = INTERVAL;
    history.sample(INTERVAL, INTERVAL, columns, 1, 1);
    expect(history.counts[0]).toBe(2);
    expect(history.timer).toBe(INTERVAL);
  });

  it("余量丢掉：采样后计时器重置为间隔，不带上一周期的负余量", () => {
    const columns = columnsOf([[0, 0, 0]]);
    const history = new TrailHistory(1, 4, false);
    history.born(0, columns);
    history.timer = f32(0.1);
    history.sample(f32(0.15), INTERVAL, columns, 1, 1);
    expect(history.timer).toBe(INTERVAL);
    expect(history.counts[0]).toBe(2);
  });

  it("dt' 比间隔大好几倍也只采一次（后移一格、C 加 1）", () => {
    const columns = columnsOf([[0, 0, 0]]);
    const history = new TrailHistory(1, 4, false);
    setHistory(history, 0, [
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
    ]);
    history.counts[0] = 1;
    move(columns, 0, [9, 0, 0]);
    history.sample(1, INTERVAL, columns, 1, 1);
    expect(historyOf(history, 0)).toEqual([
      [9, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);
    expect(history.counts[0]).toBe(2);
    expect(history.timer).toBe(INTERVAL);
  });

  it("存活数为 0 时整段跳过：计时器停走、历史不动", () => {
    const columns = columnsOf([[7, 0, 0]], [0]);
    const history = new TrailHistory(1, 4, false);
    history.timer = f32(0.1);
    history.sample(1, INTERVAL, columns, 1, 0);
    expect(history.timer).toBe(f32(0.1));
    expect(history.counts[0]).toBe(0);
    expect(historyOf(history, 0)[0]).toEqual([0, 0, 0]);
  });

  it("新的在前：h[0] 写本次的位置，其余整体后移一格；最老的一个丢掉", () => {
    const columns = columnsOf([[0, 0, 0]]);
    const history = new TrailHistory(1, 3, false);
    history.born(0, columns);
    for (let x = 1; x <= 4; x++) {
      move(columns, 0, [x, -x, 0]);
      history.sample(1, INTERVAL, columns, 1, 1);
    }
    expect(historyOf(history, 0)).toEqual([
      [4, -4, 0],
      [3, -3, 0],
      [2, -2, 0],
    ]);
  });

  it("C 加 1 封顶 n；U 每次加 1、u16 回绕不封顶；死槽不采", () => {
    const columns = columnsOf(
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      [1],
    );
    const history = new TrailHistory(2, 4, true);
    history.born(0, columns);
    history.born(1, columns);
    for (let i = 0; i < 6; i++) history.sample(1, INTERVAL, columns, 2, 1);
    expect([history.counts[0], history.scrolls![0]]).toEqual([4, 6]);
    expect([history.counts[1], history.scrolls![1]]).toEqual([1, 0]);
    history.scrolls![0] = 0xffff;
    history.sample(1, INTERVAL, columns, 2, 1);
    expect(history.scrolls![0]).toBe(0);
  });

  it("afterPrewarm：0..高水位−1 每个槽 C = 1、历史塌缩到当前位置，U 整段清零；计时器不动", () => {
    const columns = columnsOf([
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);
    const history = new TrailHistory(3, 2, true);
    for (const slot of [0, 1, 2]) {
      setHistory(history, slot, [
        [9, 9, 9],
        [8, 8, 8],
      ]);
      history.counts[slot] = 2;
      history.scrolls![slot] = 5;
    }
    history.timer = f32(0.2);
    history.afterPrewarm(columns, 2);
    expect(historyOf(history, 0)).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
    expect(historyOf(history, 1)).toEqual([
      [2, 0, 0],
      [2, 0, 0],
    ]);
    expect(Array.from(history.counts)).toEqual([1, 1, 2]);
    expect(Array.from(history.scrolls!)).toEqual([0, 0, 0]);
    // 高水位之外的槽不动
    expect(historyAt(history, 2, 0)).toEqual([9, 9, 9]);
    expect(history.timer).toBe(f32(0.2));
  });
});

/** 翻译后 `genericropeparticle`（`GS_ENABLED`、非 `THICKFORMAT`）的 5 个输入，故意打乱 location：偏移按反射排，不写死。 */
const TRAIL_INPUTS = [
  { name: "a_Color", location: 0, type: "vec4" },
  { name: "a_TexCoordVec3C2", location: 1, type: "vec3" },
  { name: "a_PositionVec4", location: 2, type: "vec4" },
  { name: "a_TexCoordVec4", location: 3, type: "vec4" },
  { name: "a_TexCoordVec4C1", location: 4, type: "vec4" },
];
const { layout: LAYOUT, problems: LAYOUT_PROBLEMS } = trailVertexLayout(vertexPacking(TRAIL_INPUTS, "instance"));

describe("trailVertexLayout", () => {
  it("4 个 vec4 + 1 个 vec3 按反射偏移；步长 19 个 float（WPE 76 字节）", () => {
    expect(LAYOUT_PROBLEMS).toEqual([]);
    expect(LAYOUT).toEqual({ stride: 19, color: 0, cp1: 4, start: 7, end: 11, cp0: 15 });
  });

  it("认不得的输入（rope 的 a_TexCoordVec4C2 / C3）、分量数不对的照报 render:particle-attribute", () => {
    const { problems } = trailVertexLayout(
      vertexPacking([
        { name: "a_PositionVec4", location: 0, type: "vec4" },
        { name: "a_TexCoordVec3C2", location: 1, type: "vec4" },
        { name: "a_TexCoordVec4C2", location: 2, type: "vec4" },
        { name: "a_Color", location: 3, type: "vec3" },
      ]),
    );
    expect(problems).toEqual([
      "render:particle-attribute:a_TexCoordVec3C2:4f32",
      "render:particle-attribute:a_TexCoordVec4C2",
      "render:particle-attribute:a_Color:3f32",
    ]);
  });
});

interface Particle {
  pos: Vec3;
  /** 历史（新的在前），长度 n。 */
  history: Vec3[];
  size?: number;
  rgba?: [number, number, number, number];
  count?: number;
  scrolls?: number;
}

/** 手写的系统状态：`particles[i]` 放在槽 i，`dead` 里的槽 `life = 0`；`trail` 覆盖绘制参数（缺省 n 4、`K = 1`、不滚动）。 */
function source(
  particles: Particle[],
  options: { dead?: number[]; trail?: Partial<RopeTrailRenderer> } = {},
): TrailSource {
  const trail: RopeTrailRenderer = {
    segments: 4,
    interval: INTERVAL,
    subdivision: 1,
    inverseScale: 1,
    scrolling: false,
    fadeAlpha: false,
    fadeSize: false,
    ...options.trail,
  };
  const columns = columnsOf(
    particles.map((p) => p.pos),
    options.dead,
  );
  const history = new TrailHistory(particles.length, trail.segments, trail.scrolling);
  particles.forEach((p, i) => {
    setHistory(history, i, p.history);
    history.counts[i] = p.count ?? 1;
    if (history.scrolls) history.scrolls[i] = p.scrolls ?? 0;
    columns.size[i] = p.size ?? 20;
    for (let k = 0; k < 3; k++) columns.color[k][i] = p.rgba?.[k] ?? 1;
    columns.alpha[i] = p.rgba?.[3] ?? 1;
  });
  return { columns, highWater: particles.length, trail: history, def: { renderer: { ropetrail: trail } } };
}

/** 第 k 段的各项（按 `LAYOUT`；`cp1` 是 vec3）。 */
function segment(out: Float32Array, k: number) {
  const at = (offset: number, n = 4) =>
    Array.from(out.subarray(k * LAYOUT.stride + offset, k * LAYOUT.stride + offset + n));
  return {
    start: at(LAYOUT.start),
    end: at(LAYOUT.end),
    cp0: at(LAYOUT.cp0),
    cp1: at(LAYOUT.cp1, 3),
    color: at(LAYOUT.color),
  };
}

const write = (src: TrailSource, segments = 32) => {
  const out = new Float32Array(segments * LAYOUT.stride);
  const count = writeTrailSegments(src, LAYOUT, out);
  return { out, count };
};

describe("writeTrailSegments（rea-p4d-rope.md 5.3）", () => {
  const P: Vec3 = [100, 50, 0];
  const H: Vec3[] = [
    [90, 48, 0],
    [80, 44, 0],
    [70, 38, 0],
    [60, 30, 0],
  ];

  it("段 0：p → h[0]，CP0 p、CP1 h[1]；段 1：h[0] → h[1]，CP0 p、CP1 h[2]；段 k：h[k−1] → h[k]，CP0 h[k−2]、CP1 h[k+1]；末段 CP1 是终点自身", () => {
    const { out, count } = write(source([{ pos: P, history: H, size: 13 }], { trail: { segments: 4 } }));
    expect(count).toBe(4);
    expect(segment(out, 0)).toMatchObject({ start: [...P, 13], cp0: [...P, 0], cp1: H[1] });
    expect(segment(out, 0).end.slice(0, 3)).toEqual(H[0]);
    expect(segment(out, 1)).toMatchObject({ cp0: [...P, 1], cp1: H[2] });
    expect(segment(out, 1).start).toEqual([...H[0], 13]);
    expect(segment(out, 1).end.slice(0, 3)).toEqual(H[1]);
    expect(segment(out, 2)).toMatchObject({ start: [...H[1], 13], cp0: [...H[0], 2], cp1: H[3] });
    expect(segment(out, 2).end.slice(0, 3)).toEqual(H[2]);
    // 末段：h[n−2] → h[n−1]，CP0 h[n−3]，CP1 h[n−1]
    expect(segment(out, 3)).toMatchObject({ start: [...H[2], 13], cp0: [...H[1], 3], cp1: H[3] });
    expect(segment(out, 3).end.slice(0, 3)).toEqual(H[3]);
  });

  it("n = 2：段 1 的 CP0 是 p、CP1 是 h[1]（0x140233215、0x1402337b7）", () => {
    const { out, count } = write(source([{ pos: P, history: H.slice(0, 2) }], { trail: { segments: 2 } }));
    expect(count).toBe(2);
    expect(segment(out, 0)).toMatchObject({ start: [...P, 20], cp0: [...P, 0], cp1: H[1] });
    expect(segment(out, 1)).toMatchObject({ start: [...H[0], 20], cp0: [...P, 1], cp1: H[1] });
    expect(segment(out, 1).end.slice(0, 3)).toEqual(H[1]);
  });

  it("不滚动：a_TexCoordVec4.w = C·K（float32），a_TexCoordVec4C1.w = k", () => {
    const { out } = write(source([{ pos: P, history: H, count: 3 }], { trail: { inverseScale: f32(1 / 3) } }));
    for (let k = 0; k < 4; k++) {
      expect(segment(out, k).end[3]).toBe(f32(3 * f32(1 / 3)));
      expect(segment(out, k).cp0[3]).toBe(k);
    }
  });

  it("滚动：a_TexCoordVec4.w = k，a_TexCoordVec4C1.w = k − U（不乘 K）", () => {
    const { out } = write(
      source([{ pos: P, history: H, count: 4, scrolls: 7 }], { trail: { scrolling: true, inverseScale: 2 } }),
    );
    expect([0, 1, 2, 3].map((k) => segment(out, k).end[3])).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((k) => segment(out, k).cp0[3])).toEqual([-7, -6, -5, -4]);
  });

  it("每个存活粒子按槽序恒写 n 段（不看 C），跳过死槽；颜色是当前 rgb 与 alpha；放不下一整个粒子时停", () => {
    const particles: Particle[] = [
      { pos: [1, 0, 0], history: H, rgba: [0.1, 0.2, 0.3, 0.4] },
      { pos: [2, 0, 0], history: H },
      { pos: [3, 0, 0], history: H, rgba: [0.5, 0.6, 0.7, 0.8], count: 1 },
    ];
    const { out, count } = write(source(particles, { dead: [1] }));
    expect(count).toBe(8);
    expect(segment(out, 0).start.slice(0, 3)).toEqual([1, 0, 0]);
    expect(segment(out, 4).start.slice(0, 3)).toEqual([3, 0, 0]);
    expect(segment(out, 3).color).toEqual([0.1, 0.2, 0.3, 0.4].map(f32));
    expect(segment(out, 7).color).toEqual([0.5, 0.6, 0.7, 0.8].map(f32));
    expect(write(source(particles, { dead: [1] }), 6).count).toBe(4);
    expect(write(source(particles, { dead: [0, 1, 2] })).count).toBe(0);
  });

  it("不是 ropetrail 系统（没有历史）时返回 0", () => {
    const src = source([{ pos: P, history: H }]);
    expect(writeTrailSegments({ ...src, trail: null }, LAYOUT, new Float32Array(100))).toBe(0);
  });
});

describe("trailRenderVar0（rea-p4d-rope.md 第 4 节）", () => {
  const trail = (segments: number, extra: Partial<RopeTrailRenderer> = {}) => ({
    segments,
    interval: INTERVAL,
    inverseScale: 1,
    scrolling: false,
    ...extra,
  });

  it("z = 1 − max(timer, 0)/interval（float32）；w = n − 0.5；不滚动时 x 写 0", () => {
    expect(trailRenderVar0(trail(4), INTERVAL)).toEqual([0, 0, 0, 3.5]);
    expect(trailRenderVar0(trail(4), f32(0.1))).toEqual([0, 0, f32(1 - f32(f32(0.1) / INTERVAL)), 3.5]);
    // 计时器初值 0 与负值（不会出现，max 兜底）：z = 1
    expect(trailRenderVar0(trail(4), 0)[2]).toBe(1);
    expect(trailRenderVar0(trail(4), -0.3)[2]).toBe(1);
    expect(trailRenderVar0(trail(2), 0)[3]).toBe(1.5);
    expect(trailRenderVar0(trail(32), 0)[3]).toBe(31.5);
  });

  it("滚动：w = (n − 1)·K，x = n − 1（实测 T2：uvscale 0.5 时 w 6、x 3）", () => {
    expect(trailRenderVar0(trail(4, { scrolling: true, inverseScale: 2 }), INTERVAL)).toEqual([3, 0, 0, 6]);
    expect(trailRenderVar0(trail(16, { scrolling: true, inverseScale: f32(1 / 3) }), 0)).toEqual([
      15,
      0,
      1,
      f32(15 * f32(1 / 3)),
    ]);
  });
});

describe("compile：ropetrail 的字段与绘制参数（rea-p4d-rope.md 3.1、3.4）", () => {
  const read = (fields: JsonObject = {}) => readParticleModule("renderer", { name: "ropetrail", ...fields }, true);
  const renderer = (fields: JsonObject = {}) =>
    parseParticle({ renderer: [{ name: "ropetrail", ...fields }] }, { file: "p.json", orthographic: true }).renderer;

  it("缺省 length 1、segments 4、subdivision 1、uvscale 1、三个开关 false；正交透视一套", () => {
    for (const orthographic of [true, false])
      expect(readParticleModule("renderer", { name: "ropetrail" }, orthographic).fields).toEqual({
        length: 1,
        segments: 4,
        subdivision: 1,
        fadealpha: 0,
        fadesize: 0,
        uvscale: 1,
        uvscrolling: 0,
        orientation: "screen",
        axis: [0, 0, 0],
        flags: 0,
      });
  });

  it("钳制：segments 到 [2, 32]、取整；length 至少 0.001（float32）；subdivision 到 [0, 32]", () => {
    expect([0, 1, 2, 4, 16, 32, 40, -5, 7.9].map((value) => read({ segments: value }).fields.segments)).toEqual([
      2, 2, 2, 4, 16, 32, 32, 2, 7,
    ]);
    expect([0, 0.0005, -3, 0.2, 3].map((value) => read({ length: value }).fields.length)).toEqual([
      f32(0.001),
      f32(0.001),
      f32(0.001),
      f32(0.2),
      3,
    ]);
    expect([40, -1, 0, 2].map((value) => read({ subdivision: value }).fields.subdivision)).toEqual([32, 0, 0, 2]);
    expect(read({ fadealpha: true, fadesize: 2, uvscrolling: 1 }).fields).toMatchObject({
      fadealpha: 1,
      fadesize: 1,
      uvscrolling: 1,
    });
    expect(read({ fadealpha: "yes" }).issues).toEqual([{ field: "fadealpha", kind: "value" }]);
  });

  it("particleRenderer：kind ropetrail，间隔 f32(length / segments)，K = 1/uvscale（0 时保持 1），三个开关", () => {
    expect(renderer()).toMatchObject({
      kind: "ropetrail",
      trail: null,
      rope: null,
      ropetrail: {
        segments: 4,
        interval: 0.25,
        subdivision: 1,
        inverseScale: 1,
        scrolling: false,
        fadeAlpha: false,
        fadeSize: false,
      },
    });
    expect(renderer({ length: 3, segments: 16 }).ropetrail!.interval).toBe(f32(3 / 16));
    expect(renderer({ length: 0.2 }).ropetrail!.interval).toBe(f32(f32(0.2) / 4));
    // length 0 → 0.001：每帧都采样
    expect(renderer({ length: 0 }).ropetrail!.interval).toBe(f32(f32(0.001) / 4));
    expect(renderer({ segments: 40, subdivision: 40 }).ropetrail).toMatchObject({ segments: 32, subdivision: 32 });
    expect(renderer({ uvscale: 0.5 }).ropetrail!.inverseScale).toBe(2);
    expect(renderer({ uvscale: 0 }).ropetrail!.inverseScale).toBe(1);
    expect(renderer({ uvscrolling: true, fadealpha: true, fadesize: true }).ropetrail).toMatchObject({
      scrolling: true,
      fadeAlpha: true,
      fadeSize: true,
    });
    expect(renderer({ orientation: "upright" }).orientation.mode).toBe(1);
  });
});

/** ropetrail 系统：发射器在 `origin`、不散开，沿 +x 匀速走；`extra` 覆盖系统级键，`trail` 覆盖 renderer 字段。 */
function trailSystem(extra: JsonObject = {}, trail: JsonObject = {}, instanceoverride?: unknown): SceneParticle {
  return parseParticle(
    {
      maxcount: 4,
      emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 40, max: 40 },
        { name: "velocityrandom", min: "60 0 0", max: "60 0 0" },
      ],
      operator: [{ name: "movement" }],
      renderer: [{ name: "ropetrail", ...trail }],
      ...extra,
    },
    { file: "p.json", orthographic: true, instanceoverride },
  );
}

const x = (system: ParticleSystem, slot: number) => system.columns.position[0][slot];

describe("模拟器的三个挂钩（rea-p4d-rope.md 5.1、5.2）", () => {
  it("只有 ropetrail 系统有历史；rope、sprite 为 null", () => {
    expect(new ParticleSystem(trailSystem(), new SeededRandom(1), 1).trail).not.toBeNull();
    const other = (name: string) =>
      new ParticleSystem(trailSystem({ renderer: [{ name }] }), new SeededRandom(1), 1).trail;
    expect(other("rope")).toBeNull();
    expect(other("sprite")).toBeNull();
  });

  it("出生在全部 initializer 之后：历史是 positionoffsetrandom 偏移过的出生位置", () => {
    const system = new ParticleSystem(
      trailSystem({
        emitter: [{ name: "sphererandom", origin: "123 45 0", distancemin: 0, distancemax: 0, rate: 10 }],
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "positionoffsetrandom", distance: 100, scale: 0.01 },
        ],
        operator: [],
      }),
      new SeededRandom(1),
      1,
    );
    system.step(0.1);
    expect(system.alive).toBe(1);
    const pos: Vec3 = [0, 1, 2].map((k) => system.columns.position[k][0]) as Vec3;
    // 偏移确实生效（否则这条测不出先后）
    expect(pos).not.toEqual([123, 45, 0]);
    // 没有 operator，出生位置就是当前位置；出生那帧照常采样，h[0] 也是它
    for (const point of historyOf(system.trail!, 0)) expect(point).toEqual(pos);
  });

  it("计时器初值 0：第一个粒子出生那一帧就采样（C = 2），之后按间隔、余量丢掉；没有粒子的帧计时器不走", () => {
    // 发射延迟 0.3 s：前 3 帧没有粒子
    const system = new ParticleSystem(
      trailSystem({ emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10, delay: 0.3 }] }),
      new SeededRandom(1),
      1,
    );
    const trail = system.trail!;
    let empty = 0;
    for (; empty < 10; empty++) {
      system.step(0.1);
      if (system.alive) break;
      expect(trail.timer).toBe(0);
    }
    expect(empty).toBeGreaterThanOrEqual(3);
    expect(system.alive).toBe(1);
    expect(trail.counts[0]).toBe(2);
    expect(trail.timer).toBe(INTERVAL);
    // h[0] 是本帧模拟后的位置（movement 已走一步），之后是出生位置
    expect(historyAt(trail, 0, 0)[0]).toBe(x(system, 0));
    expect(historyAt(trail, 0, 1)[0]).toBe(0);
    // 0.25 − 0.1 − 0.1 > 0，0.05 − 0.1 ≤ 0：每 3 帧采一次，余量不带
    system.step(0.1);
    system.step(0.1);
    expect(trail.counts[0]).toBe(2);
    system.step(0.1);
    expect(trail.counts[0]).toBe(3);
    expect(trail.timer).toBe(INTERVAL);
  });

  it("理想 60 fps、间隔 0.25：float32 累减 15 次仍是正数，16 帧采一次（rea 5.2）", () => {
    const system = new ParticleSystem(trailSystem({ maxcount: 1 }), new SeededRandom(1), 1);
    const dt = f32(1 / 60);
    const sampled: number[] = [];
    for (let frame = 1; frame <= 80; frame++) {
      system.step(dt);
      // 采样那帧计时器重置为间隔（其余帧 dt' > 0，一定比间隔小）
      if (system.trail!.timer === INTERVAL) sampled.push(frame);
    }
    // 出生帧（rate 10 的第一个在 acc 满 1 时发，第 6 帧）采一次，之后每 16 帧
    const gaps = sampled.slice(1).map((frame, i) => frame - sampled[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.every((gap) => gap === 16)).toBe(true);
  });

  it("采样用 dt'（乘 instanceoverride.rate）；两遍模式不影响", () => {
    const fast = new ParticleSystem(trailSystem({}, {}, { rate: 2 }), new SeededRandom(1), 1);
    const one = new ParticleSystem(trailSystem(), new SeededRandom(1), 1);
    const two = new ParticleSystem(trailSystem(), new SeededRandom(1), 2);
    for (let frame = 0; frame < 3; frame++) for (const system of [fast, one, two]) system.step(0.05);
    // fast：dt' = 0.1，出生帧采样后 0.25 − 0.1 − 0.1 = 0.05
    expect(fast.trail!.timer).toBe(f32(f32(INTERVAL - f32(0.1)) - f32(0.1)));
    expect(two.trail!.timer).toBe(one.trail!.timer);
    expect(Array.from(two.trail!.counts)).toEqual(Array.from(one.trail!.counts));
  });

  it("预热不采样，结束后历史塌缩到当前位置、C = 1；计时器仍是 0，预热后第一帧立即采样", () => {
    const system = new ParticleSystem(trailSystem({ starttime: 1 }), new SeededRandom(1), 1);
    system.prewarm();
    const trail = system.trail!;
    expect(system.alive).toBeGreaterThan(0);
    expect(trail.timer).toBe(0);
    for (let slot = 0; slot < system.highWater; slot++) {
      expect(trail.counts[slot]).toBe(1);
      for (const point of historyOf(trail, slot)) expect(point[0]).toBe(x(system, slot));
    }
    const before = x(system, 0);
    system.step(0.05);
    expect(trail.counts[0]).toBe(2);
    expect(historyAt(trail, 0, 0)[0]).toBe(x(system, 0));
    expect(historyAt(trail, 0, 1)[0]).toBe(before);
    expect(historyAt(trail, 0, 2)[0]).toBe(before);
  });

  it("clear / suspend 不重置计时器", () => {
    const system = new ParticleSystem(trailSystem(), new SeededRandom(1), 1);
    // 出生帧采样后 0.25，再两帧剩 0.05
    for (let frame = 0; frame < 3; frame++) system.step(0.1);
    const timer = system.trail!.timer;
    expect(timer).toBeGreaterThan(0);
    expect(timer).toBeLessThan(INTERVAL);
    expect(system.suspend()).toBe(true);
    expect(system.trail!.timer).toBe(timer);
    system.clear();
    expect(system.trail!.timer).toBe(timer);
  });

  it("writeTrailSegments 读真实系统：段数 = 存活数 · n，按槽序；段 0 起点是当前位置", () => {
    const system = new ParticleSystem(trailSystem({}, { segments: 3 }), new SeededRandom(1), 1);
    for (let frame = 0; frame < 3; frame++) system.step(0.1);
    const out = new Float32Array(system.columns.capacity * 3 * LAYOUT.stride);
    const count = writeTrailSegments(system, LAYOUT, out);
    expect(count).toBe(system.alive * 3);
    for (let i = 0; i < system.alive; i++) expect(segment(out, i * 3).start[0]).toBe(x(system, i));
  });
});
