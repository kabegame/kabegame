/**
 * `rope`（P4d 步骤 1）：把系统里全部存活粒子按出生顺序连成一条带子。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md`
 * 第 1、2 节（读码【确】），实测见 `p4-particles-REPORT.md`「P4d 语义的实测核对」的 rope 表。
 *
 * WPE 画绳走几何着色器（`POINTLIST` + `genericropeparticle.geom`，第 6 节）：每段一个点，几何着色器展开成 `4 + 2·subdivision`
 * 个顶点的三角形带。我们由翻译器把几何着色器展开进顶点着色器（`src-tauri/wpesl2wgsl/README.md`「几何着色器展开」）：每段是一个
 * 实例、顶点输入按实例步进，`vertex_index` 是第几个输出顶点。CPU 侧只做两件事，都在这里：
 * - **rope 表**（`RopeOrder`，WPE 的 `sys+0x218`）：存槽号的 `std::vector<u32>`，出生时追加、判死后保序删除，表序就是出生序；
 *   我们的槽位复用第一个空槽，槽序不是绳上的顺序（第 2 节）。模拟器（`system.ts`）维护它和累计死亡数（`sys+0x350`）。
 * - **段顶点**（`writeRopeSegments`，WPE `FUN_1402308a0` 的 rope 路径）：每段 6 个 vec4（WPE 96 字节），偏移按翻译器反射的
 *   属性排（`ropeVertexLayout`），不写死。
 */
import type { PackedVertexAttribute } from "../render/programs";
import type { ParticleRenderer } from "../compile/particles";
import type { ParticleColumns } from "./columns";
import { clamp01, f32 } from "./f32";

/**
 * rope 表（`sys+0x218`）：存槽号，出生时追加（`push_back`，2.2），判死后保序删除（同一槽出现多次也删光，2.3），表序就是出生序。
 * 容量按 `maxcount` 预留；WPE 是 `std::vector`，满了照样追加，这里同样按需扩容（正常运行时表长等于存活数，不会超过容量）。
 */
export class RopeOrder {
  private storage: Uint32Array;
  /** 当前表长。 */
  length = 0;
  /** `removeDead` 用的标记（按槽号），按需扩容。 */
  private marks: Uint8Array;

  constructor(capacity: number) {
    this.storage = new Uint32Array(Math.max(1, capacity));
    this.marks = new Uint8Array(Math.max(1, capacity));
  }

  /** 表内容（前 `length` 项有效）。 */
  get slots(): Uint32Array {
    return this.storage;
  }

  /** 新粒子出生：追加到表尾（2.2，三个发射分支在「存活数 + 1、高水位更新」之后 `push_back`）。 */
  push(slot: number): void {
    if (this.length === this.storage.length) {
      const grown = new Uint32Array(this.storage.length * 2);
      grown.set(this.storage);
      this.storage = grown;
    }
    this.storage[this.length++] = slot;
  }

  /**
   * 一帧的判死结果（槽号升序）：把这些槽从表里全部删掉，其余保持原顺序（2.3）。WPE 对每个死亡槽号从头线性查找、`memmove`
   * 保序删除，删除后不跳出、继续查同一位置，所以重复项也删光；结果等于「删掉所有等于任一死亡槽号的项、其余按原序紧排」，这里
   * 先按槽号标记再一遍紧排，结果相同。
   */
  removeDead(slots: readonly number[]): void {
    if (!slots.length) return;
    const max = slots.reduce((a, b) => Math.max(a, b), 0);
    if (max >= this.marks.length) this.marks = new Uint8Array(max + 1);
    const marks = this.marks;
    for (const slot of slots) marks[slot] = 1;
    const table = this.storage;
    let kept = 0;
    for (let j = 0; j < this.length; j++) {
      const slot = table[j];
      if (slot < marks.length && marks[slot]) continue;
      table[kept++] = slot;
    }
    this.length = kept;
    for (const slot of slots) marks[slot] = 0;
  }

  /** 清空（系统复位：不可见时清空粒子，`FUN_14022fd90` / `FUN_14022f990`，2.4）。 */
  clear(): void {
    this.length = 0;
  }
}

/**
 * rope 段顶点里各输入的 float 偏移（`genericropeparticle.vert` 的 `GS_ENABLED` + `THICKFORMAT` 分支，rea-p4d-rope.md 1.3）；
 * 着色器没声明的为 −1（不写）。
 */
export interface RopeVertexLayout {
  /** 每段的 float 数（步长 / 4）。 */
  stride: number;
  /** `a_PositionVec4`：起点、起点尺寸（`in_ParticleSize`）。 */
  start: number;
  /** `a_TexCoordVec4`：终点、`TL`（`in_ParticleTrailLength`）。 */
  end: number;
  /** `a_TexCoordVec4C1`：样条控制点 `in_SplineCP0`、`k + TP0`（`in_ParticleTrailPosition`）。 */
  cp0: number;
  /** `a_TexCoordVec4C2`：样条控制点 `in_SplineCP1`、终点尺寸。 */
  cp1: number;
  /** `a_TexCoordVec4C3`：终点颜色（`v_Color2`）。 */
  endColor: number;
  /** `a_Color`：起点颜色。 */
  color: number;
}

type RopeField = Exclude<keyof RopeVertexLayout, "stride">;

/** rope 着色器认得的 6 个输入（全是 vec4）→ 布局字段。 */
export const ROPE_ATTRIBUTES: Readonly<Record<string, RopeField>> = {
  a_PositionVec4: "start",
  a_TexCoordVec4: "end",
  a_TexCoordVec4C1: "cp0",
  a_TexCoordVec4C2: "cp1",
  a_TexCoordVec4C3: "endColor",
  a_Color: "color",
};

/**
 * 由顶点打包结果（`vertexPacking(result.attributes, "instance")`）定布局，同 `particleVertexLayout`：认不得的输入、分量数或类型不对的
 * 报 `render:particle-attribute:<名字>[:<分量数><类型>]`。
 */
export function ropeVertexLayout(packing: {
  layout: Pick<GPUVertexBufferLayout, "arrayStride">;
  attributes: readonly PackedVertexAttribute[];
}): { layout: RopeVertexLayout; problems: string[] } {
  const layout: RopeVertexLayout = {
    stride: Number(packing.layout.arrayStride) / 4,
    start: -1,
    end: -1,
    cp0: -1,
    cp1: -1,
    endColor: -1,
    color: -1,
  };
  const problems: string[] = [];
  for (const attribute of packing.attributes) {
    const field = ROPE_ATTRIBUTES[attribute.name];
    if (!field) {
      problems.push(`render:particle-attribute:${attribute.name}`);
      continue;
    }
    if (attribute.components !== 4 || attribute.kind !== "f32" || attribute.column !== 0) {
      problems.push(`render:particle-attribute:${attribute.name}:${attribute.components}${attribute.kind}`);
      continue;
    }
    layout[field] = attribute.offset / 4;
  }
  return { layout, problems };
}

/** 能写进 `into` 的段数。 */
export function ropeSegmentCapacity(layout: Pick<RopeVertexLayout, "stride">, into: Float32Array): number {
  return layout.stride > 0 ? Math.floor(into.length / layout.stride) : 0;
}

/** `writeRopeSegments` 读的系统状态（`ParticleSystem` 满足它；单测可以手写）。 */
export interface RopeSource {
  columns: Pick<ParticleColumns, "position" | "size" | "color" | "alpha" | "age">;
  /** 存活数。 */
  alive: number;
  /** rope 表；不是 rope 系统时为 null。 */
  ropeOrder: RopeOrder | null;
  /** 累计死亡数（`sys+0x350`）。 */
  deaths: number;
  def: { renderer: Pick<ParticleRenderer, "rope"> };
  /** 当前的 `instanceoverride` 标量（原值，不看系统 flags 的禁用位）。 */
  instanceScalar(field: "count" | "lifetime"): number;
}

/**
 * 整条绳共用的 `TL`（`in_ParticleTrailLength`）与 `TP0`（第 0 段的 `in_ParticleTrailPosition`），照 rea-p4d-rope.md 1.2
 * （`0x1402309b0`–`0x140230a84`）逐步 float32：
 * ```
 * R  = sys+0x1c0 · io.count;  L = sys+0x1bc · io.lifetime            // 不看系统 flags 的禁用位
 * Rf = (R·L > 存活数) ? min((float)fps, R) : R                          // 0x1402309f8，读 fps 的就是这里
 * N  = Rf · L
 * if uvscrolling (0x20000):  TL = N − 1;  TP0 = (float)累计死亡数
 * else:                      TL = 存活数; TP0 = 0
 *     if N > 0 && !(存活数 < N − 1) && uvsmoothing (0x40000):          // comiss + jb：相等时进平滑分支
 *         TL = N − 1;  TP0 = saturate((L − age[idx[0]]) / (1/Rf)) − 1   // 先求倒数再除
 * TL *= K                                                              // K = 1/uvscale
 * ```
 * 存活数是 2 时由 `writeRopeSegments` 另按特例写（`TL = 2`、`TP = 0`，不乘 `K`）。`fps` 是宿主的帧上限（`int` 转 float），和
 * `particlePasses` 用的是同一个值。
 */
export function ropeTexCoords(system: RopeSource, fps: number, alive: number): { length: number; position: number } {
  const rope = system.def.renderer.rope;
  if (!rope) return { length: 0, position: 0 };
  const rate = f32(rope.rate * f32(system.instanceScalar("count")));
  const lifetime = f32(rope.lifetime * f32(system.instanceScalar("lifetime")));
  const count = f32(alive);
  const filled = f32(rate * lifetime) > count;
  const rf = filled ? Math.min(f32(fps), rate) : rate;
  const expected = f32(rf * lifetime);
  let length: number;
  let position: number;
  if (rope.scrolling) {
    length = f32(expected - 1);
    position = f32(system.deaths);
  } else {
    length = count;
    position = 0;
    if (expected > 0 && !(count < f32(expected - 1)) && rope.smoothing) {
      length = f32(expected - 1);
      const order = system.ropeOrder!;
      const oldest = system.columns.age[order.slots[0]];
      position = f32(clamp01(f32(f32(lifetime - oldest) / f32(1 / rf))) - 1);
    }
  }
  return { length: f32(length * rope.inverseScale), position };
}

/**
 * 每段一个实例，写进 `out`（按 `layout` 的偏移），返回段数（存活数 ≤ 1 时为 0，WPE 不写也不画，1.1）。段 k 连接 rope 表的第
 * k、k + 1 项（`k = 0 … 存活数 − 2`），内容照 1.3–1.4：
 * ```
 * a = idx[k]  b = idx[k+1]  c = idx[k−1]（首段取 idx[0]）  d = idx[k+2]（末段取 idx[k+1]）
 * a_PositionVec4 = (pos[a], size[a])     a_TexCoordVec4   = (pos[b], TL)
 * a_TexCoordVec4C1 = (pos[c], k + TP0)   a_TexCoordVec4C2 = (pos[d], size[b])
 * a_TexCoordVec4C3 = rgba[b]             a_Color          = rgba[a]
 * ```
 * 尺寸、颜色、alpha 是当前值（同 sprite 写顶点，`vertices.ts`）。存活数正好是 2 时（`0x140230f8e`）：`c = a`、`d = b`、`TL = 2`、
 * `TP = 0`，不乘 `K`，也不看 `0x20000`、`0x40000`。`out` 放不下的段不写。只写布局里有的输入，其余位置保持原值。
 */
export function writeRopeSegments(
  system: RopeSource,
  layout: RopeVertexLayout,
  out: Float32Array,
  fps: number,
): number {
  const order = system.ropeOrder;
  if (!order || !system.def.renderer.rope) return 0;
  const n = Math.min(system.alive, order.length);
  if (n <= 1) return 0;
  const segments = Math.min(n - 1, ropeSegmentCapacity(layout, out));
  const { length, position } = n === 2 ? { length: 2, position: 0 } : ropeTexCoords(system, fps, n);
  const c = system.columns;
  const [px, py, pz] = c.position;
  const [cr, cg, cb] = c.color;
  const { size, alpha } = c;
  const idx = order.slots;
  const { stride, start, end, cp0, cp1, endColor, color } = layout;
  const writePosition = (at: number, slot: number, w: number) => {
    if (at < 0) return;
    out[at] = px[slot];
    out[at + 1] = py[slot];
    out[at + 2] = pz[slot];
    out[at + 3] = w;
  };
  const writeColor = (at: number, slot: number) => {
    if (at < 0) return;
    out[at] = cr[slot];
    out[at + 1] = cg[slot];
    out[at + 2] = cb[slot];
    out[at + 3] = alpha[slot];
  };
  for (let k = 0; k < segments; k++) {
    const a = idx[k];
    const b = idx[k + 1];
    const before = k === 0 ? a : idx[k - 1];
    const after = k + 2 < n ? idx[k + 2] : b;
    const o = k * stride;
    writePosition(start < 0 ? -1 : o + start, a, size[a]);
    writePosition(end < 0 ? -1 : o + end, b, length);
    writePosition(cp0 < 0 ? -1 : o + cp0, before, f32(k + position));
    writePosition(cp1 < 0 ? -1 : o + cp1, after, size[b]);
    writeColor(endColor < 0 ? -1 : o + endColor, b);
    writeColor(color < 0 ? -1 : o + color, a);
  }
  return segments;
}
