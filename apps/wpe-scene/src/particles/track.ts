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
 * 给了 `shake`（P5a 步骤 3）时反投影的视图带上一帧的抖动 `T(−s)`，同渲染器（WPE 先模拟粒子、后更新相机，`render/renderer.ts`）；
 * 给了 `zoom`（步骤 4）时投影绕场景中心缩放（`sceneViewProjection(size, zoom)`，静态、预热也用它）。
 */
import type { SceneLayer } from "../compile/bundle";
import { sceneViewProjection, worldMatrixOf } from "../render/layout";
import { multiply, translation, type Mat4 } from "../render/math";
import { shakeOffset, type ShakeFields } from "../render/shake";
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
  /**
   * 场景的抖动字段（P5a 步骤 3，`general.fields`）。给了且开着时，第 i 帧（从 1 起）的跟随点按上一帧的 s 反投影：
   * `pointerScenePoint(sceneViewProjection · T(−s_{i−1}), cursor_i)`，`s_{i−1}` 由第 i − 1 帧的场景时间（同下面的 `times` /
   * 累加值）与 `size[1]` 代入 `shakeOffset`；第 1 帧与预热用 s = 0（加载后第一帧的模拟用加载时的相机，同渲染器）。不给或关着时
   * 和以前逐字节相同。
   */
  shake?: ShakeFields;
  /**
   * 场景的正交缩放（P5a 步骤 4，`general.fields.zoom`）：跟随点按 `sceneViewProjection(size, zoom)` 反投影（`p5a-zoomx*` 实测：不带缩放
   * 差几百像素）。不跑脚本，整段回放是同一个值，预热也用它（同渲染器建场景时取编译期的值）。不给时 1，和以前逐字节相同。
   */
  zoom?: number;
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
  const viewProjection = size ? sceneViewProjection({ width: size[0], height: size[1] }, options.zoom) : null;
  /** 第 i 帧（从 0 起）的跟随点：每帧反投影一次，全部系统共用。`shake` 是模拟时相机的抖动（上一帧的 s），为 0 时用原矩阵。 */
  const pointerAt = (i: number, shake: readonly [number, number] = [0, 0]): readonly [number, number] => {
    if (!viewProjection) return [0, 0];
    const view =
      shake[0] === 0 && shake[1] === 0
        ? viewProjection
        : multiply(viewProjection, translation(-shake[0], -shake[1], 0));
    return pointerScenePoint(view, cursors?.[i] ?? [0.5, 0.5]);
  };
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
    // 加载时只有 static 子系统；事件实例的模板在输出时第一次出现再记（`drawnSystems`）
    system.forEachDrawn((node, template) => {
      if (node.skipped.length) skipped[systemKey(name, template)] = node.skipped;
    });
    systems.push({ name, system, world });
  }
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  if (last > options.dts.length) throw new Error(`dt 序列只有 ${options.dts.length} 帧，要输出第 ${last} 帧`);
  if (options.times && options.times.length !== options.dts.length)
    throw new Error(`times 有 ${options.times.length} 项，dts 有 ${options.dts.length} 项，应等长`);
  const frames: ParticleTrackFrame[] = [];
  let elapsed = 0;
  /** 上一帧的抖动 s（P5a 步骤 3）：这一帧模拟时的相机；第 1 帧是加载时的 0。 */
  let previousShake: readonly [number, number] = [0, 0];
  for (let frame = 1; frame <= last; frame++) {
    const dt = options.dts[frame - 1];
    elapsed = (elapsed + dt) % TIME_WRAP_SECONDS;
    const time = options.times ? options.times[frame - 1] : elapsed;
    const pointer = pointerAt(frame - 1, previousShake);
    for (const { system, world } of systems) system.step(dt, time, { world, pointer });
    // 步进之后才换上这一帧的 s：下一帧的模拟用它
    if (options.shake && size) previousShake = shakeOffset(options.shake, time, size[1]);
    if (!wanted.has(frame)) continue;
    const out: Record<string, ParticleTrackParticle[]> = {};
    // 子系统（P4e 步骤 1、2）按绘制先序接在父后面（`ParticleSystem.forEachDrawn`），键见 `drawnSystems`；位置是子系统自己坐标里的
    // （同 WPE 的 `vs_in`，模型矩阵另算）。没有子系统时和以前逐字节相同
    for (const { name, system } of systems)
      for (const { key, template, system: node, particles } of drawnSystems(name, system)) {
        out[key] = particles;
        if (node.skipped.length && !skipped[template]) skipped[template] = node.skipped;
      }
    frames.push({ frame, dt, systems: out });
  }
  return { source: "sim", project: options.project ?? "", tag: options.tag ?? "", frames, skipped };
}

/** 一个系统在轨迹里的键：顶层是对象名，子系统 `<名字>/<模板路径>`（每层 `def.children` 下标，P4e 步骤 1）。 */
function systemKey(name: string, template: readonly number[]): string {
  return template.length ? `${name}/${template.join("/")}` : name;
}

/**
 * 一棵系统树里有存活粒子的系统，按绘制先序（`ParticleSystem.forEachDrawn`）。键是 `systemKey`；同一模板出现多次（事件实例，P4e 步骤 2）
 * 时第 k 次（k ≥ 2）加 `#k`。只数有存活粒子的：WPE 存活数为 0 的系统不画（rea-p4e-children 第 6 节），RenderDoc 的轨迹里看不到它，
 * 这样第 k 次和抓帧里同一模板的第 k 次绘制对得上。
 */
export function drawnSystems(name: string, root: ParticleSystem): DrawnSystem[] {
  const out: DrawnSystem[] = [];
  const seen = new Map<string, number>();
  root.forEachDrawn((system, path) => {
    const particles = particleSnapshot(system);
    if (!particles.length) return;
    const template = systemKey(name, path);
    const k = (seen.get(template) ?? 0) + 1;
    seen.set(template, k);
    out.push({ key: k > 1 ? `${template}#${k}` : template, template, system, particles });
  });
  return out;
}

/** `drawnSystems` 的一项：`key` 是轨迹里的键（带 `#k`），`template` 是不带序号的模板键。 */
export interface DrawnSystem {
  key: string;
  template: string;
  system: ParticleSystem;
  particles: ParticleTrackParticle[];
}
