/**
 * 粒子轨迹（P4a 步骤 3）：按给定的 dt 序列逐帧步进全部粒子层，在指定帧输出和 WPE RenderDoc 轨迹（`ignore/p4/rdc_track.py`）
 * 同格式的数据，交给 `cmp_track.py` 逐帧比。纯函数，不碰 GPU。
 *
 * 字段语义与 RenderDoc 轨迹一致（写进顶点的值）：`pos` 位置，`size` 当前尺寸（`sizerandom 40` → 20），`color` 当前颜色 rgb，
 * `alpha` 当前 alpha，`rot` 旋转 xyz；帧表系统与拖尾另有 `thick`（`a_TexCoordVec4C1`，同 `rdc_track_b.py` 读出的 `TEXCOORD1`）。
 * 粒子按槽序、跳过空槽；没有存活粒子的系统不出现（RenderDoc 那边没有这次绘制）。
 *
 * 帧号与 WPE 脚本帧号对齐：`dts[0]` 是第 1 帧。每个系统加载时先预热（场景时间 0），再从第 1 帧步进；第 n 帧的场景时间是
 * `times[n − 1]`，没给时是 `dts` 前 n 项之和（P4b 步骤 4）。可见性（步骤 5）不处理。
 * 控制点的输入（P4c 步骤 1）是对象的世界矩阵：按全部图层的编译期变换沿父链算（`worldMatrixOf`），静态、不跑脚本；指针的跟随点
 * （P4c 步骤 2）按每帧的 `cursors` 与场景的正交投影反投影（`pointerScenePoint`），预热用第 1 项。
 */
import type { SceneLayer } from "../compile/bundle";
import { sceneViewProjection, worldMatrixOf } from "../render/layout";
import type { Mat4 } from "../render/math";
import { pointerScenePoint } from "./controlpoints";
import { TIME_WRAP_SECONDS } from "../sceneTime";
import { injectedR, SeededRandom } from "./random";
import { ParticleSystem } from "./system";

export interface ParticleTrackParticle {
  pos: number[];
  size: number;
  color: number[];
  alpha: number;
  rot: number[];
  /**
   * 帧表系统（`spriteSheet`）与拖尾（renderer 是 `spritetrail`，P4c 步骤 5）才有：`[vx, vy, vz, frame 原值]`，写进顶点的第二组属性，
   * frame 不取小数（P4b 步骤 2）。
   */
  thick?: number[];
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

/**
 * 轨迹用的图层：粒子层要 `particle`；变换（`origin`、`angles`、`scale`、`parent`）给控制点算世界矩阵，缺的按单位变换、根节点
 * （单测手写的图层只有前三项）。
 */
export type ParticleTrackLayer = Pick<SceneLayer, "object" | "name" | "particle"> &
  Partial<Pick<SceneLayer, "origin" | "angles" | "scale" | "parent">>;

export interface ParticleTrackOptions {
  /** 已编译的场景：全部图层（建变换表），只步进粒子层。 */
  layers: readonly ParticleTrackLayer[];
  /** 每帧的 `g_Frametime`，`dts[0]` 是第 1 帧。 */
  dts: readonly number[];
  /**
   * 每帧的 `g_Time`（场景时间 `T`，已加上本帧的帧时间，P4b 步骤 4），和 `dts` 等长、一一对应；回放 WPE 时填日志的
   * `runtime` 列。不给时按 `dts` 累加（double，按 432000 回绕），和渲染器的 `FrameClock` 一致。
   */
  times?: readonly number[];
  /** 要输出的帧号（从 1 起），不超过 `dts.length`。 */
  frames: readonly number[];
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍。 */
  passes: 1 | 2;
  /**
   * 每帧光标下的场景纹理坐标（`render/layout.ts` 的 `sceneCursor`，P4c 步骤 2），和 `dts` 等长、一一对应；第 1 项也用于加载时的
   * 控制点更新与预热。回放 WPE 时填轨迹里的 `g_PointerPosition`（抓帧窗口和场景同尺寸时两者相同；比例不同时按 `fill` 的铺放
   * 换算，见 `sceneCursor`）。不给时是场景中心 `(0.5, 0.5)`。
   */
  cursors?: readonly (readonly [number, number])[];
  /**
   * 场景的投影尺寸（`general.width/height`），算 `sceneViewProjection` 给跟随点反投影用。给了 `cursors` 时必填；都不给时跟随点
   * 按 (0, 0)（同 `ParticleSystem` 的缺省输入，只给单测）。
   */
  size?: readonly [number, number];
  /** 随机种子；第 i 个粒子层用 `seed + i`。缺省 1。 */
  seed?: number;
  /** 按 `objects` 下标、按出生顺序顶替 `R`（`injectedR`，用完退回种子随机数），同 dev 探针 `renderFrame` 的 `particles.random`。 */
  random?: Record<number, readonly number[]>;
  project?: string;
  tag?: string;
}

/**
 * 一个系统当前的存活粒子，按槽序。`keep` 再按槽挑一遍（dev 四角探针只要写了顶点的粒子：拖尾跳过退化的，P4c 步骤 5）。
 * 厚格式的列（速度、frame）在帧表系统与拖尾里有。
 */
export function particleSnapshot(system: ParticleSystem, keep?: (slot: number) => boolean): ParticleTrackParticle[] {
  const c = system.columns;
  const out: ParticleTrackParticle[] = [];
  const thick = system.def.spriteSheet || system.def.renderer?.kind === "spritetrail";
  for (let i = 0; i < system.highWater; i++) {
    if (c.life[i] === 0) continue;
    if (keep && !keep(i)) continue;
    const particle: ParticleTrackParticle = {
      pos: [c.position[0][i], c.position[1][i], c.position[2][i]],
      size: c.size[i],
      color: [c.color[0][i], c.color[1][i], c.color[2][i]],
      alpha: c.alpha[i],
      rot: [c.rotation[0][i], c.rotation[1][i], c.rotation[2][i]],
    };
    if (thick) particle.thick = [c.velocity[0][i], c.velocity[1][i], c.velocity[2][i], c.frame[i]];
    out.push(particle);
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
  const { cursors, size } = options;
  if (cursors && !size) throw new Error("给了 cursors 时要给 size（场景的投影尺寸）");
  if (cursors && cursors.length !== options.dts.length)
    throw new Error(`cursors 有 ${cursors.length} 项，dts 有 ${options.dts.length} 项，应等长`);
  const viewProjection = size ? sceneViewProjection({ width: size[0], height: size[1] }) : null;
  /** 第 i 帧（从 0 起）的跟随点：每帧反投影一次，全部系统共用。 */
  const pointerAt = (i: number): readonly [number, number] =>
    viewProjection ? pointerScenePoint(viewProjection, cursors?.[i] ?? [0.5, 0.5]) : [0, 0];
  const loadPointer = pointerAt(0);
  const names = new Set<string>();
  const systems: { name: string; system: ParticleSystem; world: Mat4 }[] = [];
  const skipped: Record<string, string[]> = {};
  const transforms = new Map(
    options.layers.map((layer) => [
      layer.object,
      {
        origin: layer.origin ?? [0, 0, 0],
        angles: layer.angles ?? [0, 0, 0],
        scale: layer.scale ?? [1, 1, 1],
        parent: layer.parent ?? null,
      },
    ]),
  );
  const worlds = new Map<number, Mat4>();
  for (const layer of options.layers) {
    if (!layer.particle) continue;
    // 同名对象加下标区分
    const name = names.has(layer.name) ? `${layer.name}#${layer.object}` : layer.name;
    names.add(name);
    const injected = options.random?.[layer.object];
    const system = new ParticleSystem(
      layer.particle,
      new SeededRandom(seed + systems.length),
      options.passes,
      injected ? injectedR(injected) : undefined,
    );
    const world = worldMatrixOf(layer.object, transforms, worlds);
    system.prewarm({ world, pointer: loadPointer });
    if (system.skipped.length) skipped[name] = system.skipped;
    systems.push({ name, system, world });
  }
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  if (last > options.dts.length) throw new Error(`dt 序列只有 ${options.dts.length} 帧，要输出第 ${last} 帧`);
  if (options.times && options.times.length !== options.dts.length)
    throw new Error(`times 有 ${options.times.length} 项，dts 有 ${options.dts.length} 项，应等长`);
  const frames: ParticleTrackFrame[] = [];
  let elapsed = 0;
  for (let frame = 1; frame <= last; frame++) {
    const dt = options.dts[frame - 1];
    elapsed = (elapsed + dt) % TIME_WRAP_SECONDS;
    const time = options.times ? options.times[frame - 1] : elapsed;
    const pointer = pointerAt(frame - 1);
    for (const { system, world } of systems) system.step(dt, time, { world, pointer });
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
