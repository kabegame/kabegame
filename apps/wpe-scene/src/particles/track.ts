/**
 * 粒子轨迹（P4a 步骤 3）：按给定的 dt 序列逐帧步进全部粒子层，在指定帧输出和 WPE RenderDoc 轨迹（`ignore/p4/rdc_track.py`）
 * 同格式的数据，交给 `cmp_track.py` 逐帧比。纯函数，不碰 GPU。
 *
 * 字段语义与 RenderDoc 轨迹一致（写进顶点的值）：`pos` 位置，`size` 当前尺寸（`sizerandom 40` → 20），`color` 当前颜色 rgb，
 * `alpha` 当前 alpha，`rot` 旋转 xyz。粒子按槽序、跳过空槽；没有存活粒子的系统不出现（RenderDoc 那边没有这次绘制）。
 *
 * 帧号与 WPE 脚本帧号对齐：`dts[0]` 是第 1 帧。每个系统加载时先预热，再从第 1 帧步进。可见性（步骤 5）不处理。
 */
import type { SceneLayer } from "../compile/bundle";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

export interface ParticleTrackParticle {
  pos: number[];
  size: number;
  color: number[];
  alpha: number;
  rot: number[];
}

export interface ParticleTrackFrame {
  frame: number;
  dt: number;
  systems: Record<string, ParticleTrackParticle[]>;
}

export interface ParticleTrack {
  source: "sim";
  project: string;
  tag: string;
  frames: ParticleTrackFrame[];
  /** 每个系统里模拟器跳过的模块（表外模块），没有时为空对象。 */
  skipped: Record<string, string[]>;
}

export interface ParticleTrackOptions {
  /** 已编译的场景（只用粒子层）。 */
  layers: readonly Pick<SceneLayer, "object" | "name" | "particle">[];
  /** 每帧的 `g_Frametime`，`dts[0]` 是第 1 帧。 */
  dts: readonly number[];
  /** 要输出的帧号（从 1 起），不超过 `dts.length`。 */
  frames: readonly number[];
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍。 */
  passes: 1 | 2;
  /** 随机种子；第 i 个粒子层用 `seed + i`。缺省 1。 */
  seed?: number;
  project?: string;
  tag?: string;
}

/** 一个系统当前的存活粒子，按槽序。 */
export function particleSnapshot(system: ParticleSystem): ParticleTrackParticle[] {
  const c = system.columns;
  const out: ParticleTrackParticle[] = [];
  for (let i = 0; i < system.highWater; i++) {
    if (c.life[i] === 0) continue;
    out.push({
      pos: [c.position[0][i], c.position[1][i], c.position[2][i]],
      size: c.size[i],
      color: [c.color[0][i], c.color[1][i], c.color[2][i]],
      alpha: c.alpha[i],
      rot: [c.rotation[0][i], c.rotation[1][i], c.rotation[2][i]],
    });
  }
  return out;
}

/**
 * 一个系统存活粒子的分布（P4a 步骤 5 的验收：和 WPE 比粒子数、位置范围、尺寸分布）。字段同 `particleSnapshot`：
 * 位置、当前尺寸（`size`，已是写进顶点的值）、当前 alpha。没有存活粒子时三项为 null。
 */
export interface ParticleSummary {
  alive: number;
  position: { min: number[]; max: number[] } | null;
  size: { min: number; max: number; mean: number; p05: number; p50: number; p95: number } | null;
  alpha: { min: number; max: number; mean: number } | null;
}

export function summarizeParticles(system: ParticleSystem): ParticleSummary {
  const c = system.columns;
  const sizes: number[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // 粒子可达数十万个：逐个累加，不展开成函数参数
  let alphaMin = Infinity;
  let alphaMax = -Infinity;
  let alphaSum = 0;
  for (let i = 0; i < system.highWater; i++) {
    if (c.life[i] === 0) continue;
    for (let axis = 0; axis < 3; axis++) {
      const value = c.position[axis][i];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
    sizes.push(c.size[i]);
    const alpha = c.alpha[i];
    if (alpha < alphaMin) alphaMin = alpha;
    if (alpha > alphaMax) alphaMax = alpha;
    alphaSum += alpha;
  }
  if (!sizes.length) return { alive: 0, position: null, size: null, alpha: null };
  sizes.sort((a, b) => a - b);
  const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))];
  const sizeSum = sizes.reduce((sum, value) => sum + value, 0);
  return {
    alive: sizes.length,
    position: { min, max },
    size: {
      min: sizes[0],
      max: sizes[sizes.length - 1],
      mean: sizeSum / sizes.length,
      p05: at(0.05),
      p50: at(0.5),
      p95: at(0.95),
    },
    alpha: { min: alphaMin, max: alphaMax, mean: alphaSum / sizes.length },
  };
}

export function particleTrack(options: ParticleTrackOptions): ParticleTrack {
  const seed = options.seed ?? 1;
  const names = new Set<string>();
  const systems: { name: string; system: ParticleSystem }[] = [];
  const skipped: Record<string, string[]> = {};
  for (const layer of options.layers) {
    if (!layer.particle) continue;
    // 同名对象加下标区分
    const name = names.has(layer.name) ? `${layer.name}#${layer.object}` : layer.name;
    names.add(name);
    const system = new ParticleSystem(layer.particle, new SeededRandom(seed + systems.length), options.passes);
    system.prewarm();
    if (system.skipped.length) skipped[name] = system.skipped;
    systems.push({ name, system });
  }
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  if (last > options.dts.length) throw new Error(`dt 序列只有 ${options.dts.length} 帧，要输出第 ${last} 帧`);
  const frames: ParticleTrackFrame[] = [];
  for (let frame = 1; frame <= last; frame++) {
    const dt = options.dts[frame - 1];
    for (const { system } of systems) system.step(dt);
    if (!wanted.has(frame)) continue;
    const out: Record<string, ParticleTrackParticle[]> = {};
    for (const { name, system } of systems) {
      const particles = particleSnapshot(system);
      if (particles.length) out[name] = particles;
    }
    frames.push({ frame, dt, systems: out });
  }
  return { source: "sim", project: options.project ?? "", tag: options.tag ?? "", frames, skipped };
}
