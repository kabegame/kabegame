/**
 * `ropetrail`（P4d 步骤 2）：给每个粒子拖一条带子，由它的历史位置连成。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md`
 * 第 3.1、3.4、4、5 节（读码【确】），实测见 `p4-particles-REPORT.md`「P4d 语义的实测核对」的 ropetrail 表。
 *
 * 绘制和 `rope` 同一条路（`rope.ts` 文件头）：WPE 每段一个点、几何着色器展开成 `4 + 2·subdivision` 个顶点的三角形带，我们由翻译器
 * 把几何着色器展开进顶点着色器，每段一个实例。新的是模拟侧的三样，都在这里：
 * - **历史**（`TrailHistory`，WPE 的 `sys+0x230` / `0x238` / `0x240` / `0x24c`）：每粒子 n 个位置（新的在前）、已存段数 `C`、
 *   `uvscrolling` 计数 `U`，每系统一个计时器。出生时写满出生位置，每帧模拟之后按计时器整体采样（第 5 节）。模拟器（`system.ts`）
 *   调它的三个挂钩。
 * - **段顶点**（`writeTrailSegments`，WPE `FUN_1402308a0` 的 ropetrail 路径，`0x140232e13`–`0x1402339a7`）：每个存活粒子按槽序恒写
 *   n 段，每段 76 字节（4 个 vec4 + 1 个 vec3），偏移按翻译器反射的属性排（`trailVertexLayout`），不写死。
 * - **`g_RenderVar0`**（`trailRenderVar0`，`FUN_1402366f0` `0x14023694f`）：每次绘制按当时的计时器写，渲染器每帧更新。
 */
import type { ParticleRenderer, RopeTrailRenderer } from "../compile/particles";
import type { PackedVertexAttribute } from "../render/programs";
import type { ParticleColumns } from "./columns";
import { f32 } from "./f32";

/**
 * ropetrail 的历史（rea-p4d-rope.md 第 5 节）：每粒子 n 个位置（新的在前）、已存段数 `C`、`uvscrolling` 计数 `U`，每系统一个计时器。
 * 位置存 float32（WPE 每项 12 字节）；`C`、`U` 是 u16（`sys+0x238` / `0x240`，`U` 回绕不封顶）。
 */
export class TrailHistory {
  /** n（`segments`，已钳到 `[2, 32]`）。 */
  readonly segments: number;
  /** `uvscrolling`（系统 flags `0x80000`）：有 `U` 计数（WPE 只在这时分配 `sys+0x240`）。 */
  readonly scrolling: boolean;
  /**
   * 计时器（`sys+0x24c`）：构造时为 0（`0x1402295c5`），之后只有采样写它；`clear`（系统复位）、预热都不重置（5.1）。所以第一个粒子
   * 出生的那一帧（或预热后的第一帧）就采样。
   */
  timer = 0;
  /** 历史位置：槽 i 的第 j 个（j = 0 最新）在 `(i·n + j)·3` 起的三项。 */
  readonly positions: Float32Array;
  /** 已存段数 `C`（`sys+0x238`）：出生时 1，每次采样加 1、封顶 n。 */
  readonly counts: Uint16Array;
  /** `uvscrolling` 计数 `U`（`sys+0x240`）：出生时 0，每次采样加 1（u16 回绕）；不滚动时为 null。 */
  readonly scrolls: Uint16Array | null;

  constructor(capacity: number, segments: number, scrolling: boolean) {
    const slots = Math.max(1, capacity);
    this.segments = segments;
    this.scrolling = scrolling;
    this.positions = new Float32Array(slots * segments * 3);
    this.counts = new Uint16Array(slots);
    this.scrolls = scrolling ? new Uint16Array(slots) : null;
  }

  /**
   * 出生（initializer 解释器尾部，`0x14023f953`–`0x14023f9fd`，全部 initializer 之后）：`h[slot][*]` 全写出生位置（已含
   * `positionoffsetrandom` 等），`C = 1`，`U = 0`。
   */
  born(slot: number, columns: Pick<ParticleColumns, "position">): void {
    const [px, py, pz] = columns.position;
    const h = this.positions;
    const base = slot * this.segments * 3;
    for (let j = 0; j < this.segments; j++) {
      h[base + j * 3] = px[slot];
      h[base + j * 3 + 1] = py[slot];
      h[base + j * 3 + 2] = pz[slot];
    }
    this.counts[slot] = 1;
    if (this.scrolls) this.scrolls[slot] = 0;
  }

  /**
   * 预热之后（`FUN_14022ebe0` 尾部，`0x14022f2fc`–`0x14022f3e9`）：预热的步进不调顶点函数、不采样（5.1），结束后对 `0..高水位−1`
   * 的每个槽（死槽也写，出生时会覆盖）`C = 1`、`h[i][*] = 当前位置`，`U` 整段清零。计时器不动。
   */
  afterPrewarm(columns: Pick<ParticleColumns, "position">, highWater: number): void {
    for (let i = 0; i < highWater; i++) this.born(i, columns);
    this.scrolls?.fill(0);
  }

  /**
   * 每帧模拟之后采样（`0x140232c9f`–`0x140232db8`，5.2），逐步 float32：
   * ```
   * if 存活数 == 0: 返回（整个顶点函数跳过，0x140230911），计时器停走
   * timer = timer − dt'                      // dt' 已乘 instanceoverride.rate，和模拟同一个值
   * if !(0 < timer):                         // comiss 0, timer; jb：比较常量就是 0，≤ 0 采样
   *     timer = interval                     // 重置为间隔，余量丢掉
   *     for i in 0..高水位−1, life[i] != 0:
   *         h[i][1..n−1] = h[i][0..n−2]      // memmove，后移一格、新的在前
   *         h[i][0] = pos[i]                 // 本帧模拟后的位置
   *         C[i] = min(C[i] + 1, n);  U[i]++ // U 是 u16，不封顶
   * ```
   * 每帧最多采一次，`dt' > interval` 时也只采一次。两遍模式不影响（采样在模拟之外）。
   */
  sample(
    dt: number,
    interval: number,
    columns: Pick<ParticleColumns, "position" | "life">,
    highWater: number,
    alive: number,
  ): void {
    if (alive === 0) return;
    let timer = f32(this.timer - dt);
    if (!(0 < timer)) {
      timer = interval;
      const n = this.segments;
      const h = this.positions;
      const [px, py, pz] = columns.position;
      const { life } = columns;
      for (let i = 0; i < highWater; i++) {
        if (life[i] === 0) continue;
        const base = i * n * 3;
        h.copyWithin(base + 3, base, base + (n - 1) * 3);
        h[base] = px[i];
        h[base + 1] = py[i];
        h[base + 2] = pz[i];
        this.counts[i] = Math.min(this.counts[i] + 1, n);
        if (this.scrolls) this.scrolls[i] = (this.scrolls[i] + 1) & 0xffff;
      }
    }
    this.timer = timer;
  }
}

/**
 * ropetrail 段顶点里各输入的 float 偏移（`genericropeparticle.vert` 的 `GS_ENABLED`、非 `THICKFORMAT` 分支，rea-p4d-rope.md 1.3）；
 * 着色器没声明的为 −1（不写）。
 */
export interface TrailVertexLayout {
  /** 每段的 float 数（步长 / 4；WPE 76 字节，19 个）。 */
  stride: number;
  /** `a_PositionVec4`：段起点、尺寸（`in_ParticleSize`）。 */
  start: number;
  /** `a_TexCoordVec4`：段终点、`C·K`（`in_ParticleTrailLength`）或段号 k（滚动时 `in_TrailVertexIndex`）。 */
  end: number;
  /** `a_TexCoordVec4C1`：样条控制点 `in_SplineCP0`、段号 k（`in_ParticleTrailPosition`）或 `k − U`（滚动时）。 */
  cp0: number;
  /** `a_TexCoordVec3C2`（vec3）：样条控制点 `in_SplineCP1`。 */
  cp1: number;
  /** `a_Color`：当前颜色与 alpha（非厚格式只有一份）。 */
  color: number;
}

type TrailField = Exclude<keyof TrailVertexLayout, "stride">;

/** ropetrail 着色器认得的 5 个输入 → 布局字段与分量数（`a_TexCoordVec3C2` 是 vec3，其余 vec4）。 */
export const TRAIL_ATTRIBUTES: Readonly<Record<string, { field: TrailField; components: number }>> = {
  a_PositionVec4: { field: "start", components: 4 },
  a_TexCoordVec4: { field: "end", components: 4 },
  a_TexCoordVec4C1: { field: "cp0", components: 4 },
  a_TexCoordVec3C2: { field: "cp1", components: 3 },
  a_Color: { field: "color", components: 4 },
};

/**
 * 由顶点打包结果（`vertexPacking(result.attributes, "instance")`）定布局，同 `ropeVertexLayout`：认不得的输入、分量数或类型不对的
 * 报 `render:particle-attribute:<名字>[:<分量数><类型>]`。
 */
export function trailVertexLayout(packing: {
  layout: Pick<GPUVertexBufferLayout, "arrayStride">;
  attributes: readonly PackedVertexAttribute[];
}): { layout: TrailVertexLayout; problems: string[] } {
  const layout: TrailVertexLayout = {
    stride: Number(packing.layout.arrayStride) / 4,
    start: -1,
    end: -1,
    cp0: -1,
    cp1: -1,
    color: -1,
  };
  const problems: string[] = [];
  for (const attribute of packing.attributes) {
    const known = TRAIL_ATTRIBUTES[attribute.name];
    if (!known) {
      problems.push(`render:particle-attribute:${attribute.name}`);
      continue;
    }
    if (attribute.components !== known.components || attribute.kind !== "f32" || attribute.column !== 0) {
      problems.push(`render:particle-attribute:${attribute.name}:${attribute.components}${attribute.kind}`);
      continue;
    }
    layout[known.field] = attribute.offset / 4;
  }
  return { layout, problems };
}

/** `writeTrailSegments` 读的系统状态（`ParticleSystem` 满足它；单测可以手写）。 */
export interface TrailSource {
  columns: Pick<ParticleColumns, "position" | "size" | "color" | "alpha" | "life">;
  /** 槽号上界：按槽序 `0..高水位−1` 写。 */
  highWater: number;
  /** ropetrail 的历史；不是 ropetrail 系统时为 null。 */
  trail: TrailHistory | null;
  def: { renderer: Pick<ParticleRenderer, "ropetrail"> };
}

/**
 * 每个存活粒子按槽序（`0..高水位−1`，跳过 `life == 0`）恒写 n 段（rea-p4d-rope.md 5.3，不看 `C`），返回段数（存活数 · n）；`out`
 * 放不下一整个粒子的 n 段时停。WPE 先 map `存活数 · max(n, 1)` 个点（`0x140232dbe`）。粒子 i 的第 k 段：
 * ```
 * p = pos[i]，s = size[i]，c = rgba[i]（当前值），h = 历史（新的在前）
 * 段 0:        start p       end h[0]      CP0 p        CP1 h[1]
 * 段 1:        start h[0]    end h[1]      CP0 p        CP1 h[2]
 * 段 k(2…n−2): start h[k−1]  end h[k]      CP0 h[k−2]   CP1 h[k+1]
 * 末段 n−1:    start h[n−2]  end h[n−1]    CP0 h[n−3]   CP1 h[n−1]（终点自身）
 * n == 2 时段 1 的 CP0 是 p、CP1 是 h[1]（0x140233215、0x1402337b7），即同一条规则：CP0 = k ≤ 1 ? p : h[k−2]
 * a_PositionVec4 = (start, s)   a_TexCoordVec4 = (end, w₁)   a_TexCoordVec4C1 = (CP0, w₂)   a_TexCoordVec3C2 = CP1   a_Color = c
 * 不滚动（TRAILRENDERER）: w₁ = C·K（in_ParticleTrailLength），w₂ = k
 * 滚动（TRAILSCROLLALPHA）: w₁ = k（in_TrailVertexIndex），     w₂ = k − U
 * ```
 * 采样当帧 `h[0] = p`，段 0 零长；未填满时 `h[C−1]` 之后全是出生位置，段 `≥ C` 零长。零长段由几何着色器展开的退化规则整段不画
 * （WPE 是 `normalize(0)` 得 NaN，实测 `gs_out` 里是 NaN），这里不另外处理。只写布局里有的输入，其余位置保持原值。
 */
export function writeTrailSegments(system: TrailSource, layout: TrailVertexLayout, out: Float32Array): number {
  const history = system.trail;
  const trail = system.def.renderer.ropetrail;
  if (!history || !trail || !(layout.stride > 0)) return 0;
  const n = history.segments;
  const capacity = Math.floor(out.length / layout.stride);
  const c = system.columns;
  const [px, py, pz] = c.position;
  const [cr, cg, cb] = c.color;
  const { life, size, alpha } = c;
  const h = history.positions;
  const { stride, start, end, cp0, cp1, color } = layout;
  const scale = trail.inverseScale;
  /** 写一个位置：`slot` 为 −1 时是当前位置 p，否则是历史 `h[i][slot]`；`w` 为 null 时只写 xyz（vec3）。 */
  const writePoint = (at: number, i: number, slot: number, w: number | null) => {
    if (at < 0) return;
    if (slot < 0) {
      out[at] = px[i];
      out[at + 1] = py[i];
      out[at + 2] = pz[i];
    } else {
      const from = (i * n + slot) * 3;
      out[at] = h[from];
      out[at + 1] = h[from + 1];
      out[at + 2] = h[from + 2];
    }
    if (w !== null) out[at + 3] = w;
  };
  let written = 0;
  for (let i = 0; i < system.highWater; i++) {
    if (life[i] === 0) continue;
    if (written + n > capacity) break;
    const count = history.counts[i];
    const scrolls = history.scrolls ? history.scrolls[i] : 0;
    const length = f32(count * scale);
    for (let k = 0; k < n; k++) {
      const o = (written + k) * stride;
      const w1 = history.scrolling ? k : length;
      const w2 = history.scrolling ? f32(k - scrolls) : k;
      writePoint(start < 0 ? -1 : o + start, i, k === 0 ? -1 : k - 1, size[i]);
      writePoint(end < 0 ? -1 : o + end, i, k, w1);
      writePoint(cp0 < 0 ? -1 : o + cp0, i, k <= 1 ? -1 : k - 2, w2);
      writePoint(cp1 < 0 ? -1 : o + cp1, i, k === n - 1 ? n - 1 : k + 1, null);
      if (color >= 0) {
        out[o + color] = cr[i];
        out[o + color + 1] = cg[i];
        out[o + color + 2] = cb[i];
        out[o + color + 3] = alpha[i];
      }
    }
    written += n;
  }
  return written;
}

/**
 * ropetrail 的 `g_RenderVar0`（`FUN_1402366f0` 的类型 4 分支，`0x14023694f`，rea-p4d-rope.md 第 4 节），每次绘制按当时的计时器写：
 * ```
 * RV0.z = 1 − max(timer, 0) / interval
 * 不滚动: RV0.w = (float)n − 0.5
 * 滚动（0x80000）: RV0.w = ((float)n − 1)·K;  RV0.x = (float)n − 1
 * ```
 * `RV0.y` 不写，不滚动时 `RV0.x` 也不写（WPE 留上一次绘制的值），着色器只在 `TRAILSCROLLALPHA` 分支读 `x`，这里写 0。实测：T1
 * `w 3.5`、T4seg0 `1.5`、T4seg40 `31.5`，T2（滚动、`uvscale 0.5`）`w 6`、`x 3`，`z` 每帧涨 `dt/间隔`、采样帧为 0。
 */
export function trailRenderVar0(
  trail: Pick<RopeTrailRenderer, "segments" | "interval" | "inverseScale" | "scrolling">,
  timer: number,
): [number, number, number, number] {
  const z = f32(1 - f32(Math.max(timer, 0) / trail.interval));
  if (!trail.scrolling) return [0, 0, z, f32(trail.segments - 0.5)];
  const unscaled = f32(trail.segments - 1);
  return [unscaled, 0, z, f32(unscaled * trail.inverseScale)];
}
