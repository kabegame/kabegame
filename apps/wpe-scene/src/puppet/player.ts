/**
 * puppet 运行时（P12a 步骤 2 点 2）：`ScenePuppets` 持有每个 skinned puppet 图层的动画层时钟，每帧推进、求姿势、算蒙皮矩阵。纯 TS，
 * Node 单测、dev 探针、宿主共用这一份。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/rea-p12-runtime.md` 第 2–6 节与「对实现的含义」，`p12-REPORT.md` 用例 1–4。
 * - 时钟就是 P10 的 `AnimationClock`（同一个推进函数 `FUN_1401a9f60`，rea-RT 3.1）：构造参数取 `MDLA` 动画记录的 fps、长度、模式，
 *   没有 `startpaused`；每帧推进 `dt × rate`（float32 `mulss`）。fps ≤ 0 或一轮时长 ≤ 0 时照 `FUN_1401a8c10` 的早退：`spf` 1、`D` 0、
 *   模式位 0（时钟不走，停在第 0 帧）。
 * - `visible` 为假的层整层跳过：时钟不走、不采样、不算淡入淡出（rea-RT 3.2）；第一个可见层的来源是静止姿势，之后是上一层的结果
 *   （5.2）；一个可见层都没有时局部矩阵直接取静止来源矩阵（6.1）。
 * - 图层隐藏也推进（这里不看图层可见性，rea-RT 2）；暂停冻结、补画帧不推进由调用方决定是否调 `frame`。
 * - P12a 不派发事件与播完回调（P12c）：时钟收集的事件丢掉。
 */
import { AnimationClock, BACK, DONE, MIRROR, PAUSED, SINGLE } from "../animation/clock";
import type { AnimationMode } from "../animation/types";
import type { PuppetLayerDef, ScenePuppet } from "../compile/puppet";
import {
  blendInto,
  frameIndex,
  LAYER_ADDITIVE,
  LAYER_BLENDIN,
  LAYER_BLENDOUT,
  layerWeight,
  POSE_STRIDE,
  sampleLayer,
  SKIN_STRIDE,
  skinMatrices,
  type FrameIndex,
} from "./pose";

const f = Math.fround;

/** 动画层的三个可变字段（WPE `AL+0xc8` / `+0xcc` / `+0xd0` bit0，rea-RT 1.5）。 */
export interface PuppetLayerFields {
  rate: number;
  blend: number;
  visible: boolean;
}

/**
 * 读动画层字段的状态（步骤 3 接到 `SceneState`：用户属性在两帧之间写进去，puppet 当帧就读到，p12-REPORT 用例 4）。取不到时用
 * `PuppetLayerDef` 里的值。`object` 是 `objects` 下标，`layer` 是 `animationlayers` 里保留下来的层的下标（`ScenePuppet.layers`）。
 */
export interface PuppetSink {
  animationLayer(object: number, layer: number): PuppetLayerFields | undefined;
}

/** 一个动画层的运行时。 */
interface LayerRuntime {
  readonly def: PuppetLayerDef;
  readonly frames: Float32Array;
  readonly mask: Uint8Array;
  readonly clock: AnimationClock;
  /** 动画的 `length`（帧号上限，`frameIndex` 用）。 */
  readonly length: number;
  /** additive / blendin / blendout 位（visible 每帧从状态读）；blendin 第一次淡入完成后清掉（非 single）。 */
  flags: number;
  readonly blendtime: number;
}

/** 一个 skinned puppet 的运行时。 */
interface PuppetRuntime {
  readonly object: number;
  readonly puppet: ScenePuppet;
  readonly skeleton: NonNullable<ScenePuppet["skeleton"]>;
  readonly bones: number;
  readonly layers: LayerRuntime[];
  /** 当前姿势（每骨骼 10 个 f32）。 */
  readonly pose: Float32Array;
  /** 一层的样本（每骨骼 10 个 f32）。 */
  readonly sample: Float32Array;
  /** 模型空间骨骼矩阵（每骨骼 16 个 f32，跨帧保留，同 WPE 的 `P+0x2c8`）。 */
  readonly world: Float32Array;
  /** 蒙皮矩阵（每骨骼 12 个 f32）。 */
  readonly skin: Float32Array;
  /** 上一次的蒙皮来自静止来源矩阵（没有可见层）：再没有可见层时结果不变，不必重算。 */
  restSkin: boolean;
}

/**
 * 按 `FUN_1401a8c10` 建时钟（rea-RT 3.1）：fps 或一轮时长不是正数时早退，`spf` 1、`D` 0、模式位 0（python 模型的 `Clock` 同样）。
 * 只用 `AnimationClock` 的构造与 `D` 字段（P10b 在改它，接口以那边为准）。
 */
function layerClock(fps: number, length: number, mode: AnimationMode): AnimationClock {
  const fps32 = f(fps);
  const D = f(f(Math.trunc(length)) / fps32);
  if (!(fps32 > 0) || !(D > 0)) {
    const clock = new AnimationClock({ fps: 1, length, mode: 0, startpaused: false });
    clock.D = 0;
    return clock;
  }
  return new AnimationClock({ fps, length, mode, startpaused: false });
}

export class ScenePuppets {
  /** skinned puppet，按 `list` 的顺序。 */
  private readonly runtimes: PuppetRuntime[] = [];
  private readonly byObject = new Map<number, PuppetRuntime>();
  /** 时钟收集的事件（P12a 丢掉）。 */
  private readonly events: { time: number; json: string }[] = [];
  private readonly at: FrameIndex = { lo: 0, hi: 0, frac: 0 };

  /** 只收 skinned 的（`skeleton` 不为 null）；静态 puppet 不进运行时，`skin` 给 null。建好后按 t = 0 算一次姿势（不推进）。 */
  constructor(list: readonly { object: number; puppet: ScenePuppet }[]) {
    for (const { object, puppet } of list) {
      const skeleton = puppet.skeleton;
      if (!skeleton) continue;
      const bones = skeleton.parents.length;
      const layers = puppet.layers.map((def): LayerRuntime => {
        const animation = puppet.animations[def.animation];
        const clock = layerClock(animation.fps, animation.length, animation.mode);
        let flags = (def.additive ? LAYER_ADDITIVE : 0) | (def.blendin ? LAYER_BLENDIN : 0);
        // blendout 只在 single 有效：加载时非 single 直接清掉（`0x1401fd068`，rea-RT 1.4）
        if (def.blendout && clock.flags & SINGLE) flags |= LAYER_BLENDOUT;
        return {
          def,
          frames: animation.frames,
          mask: animation.mask,
          clock,
          length: Math.trunc(animation.length),
          flags,
          blendtime: def.blendtime,
        };
      });
      const runtime: PuppetRuntime = {
        object,
        puppet,
        skeleton,
        bones,
        layers,
        pose: new Float32Array(bones * POSE_STRIDE),
        sample: new Float32Array(bones * POSE_STRIDE),
        world: new Float32Array(bones * 16),
        skin: new Float32Array(bones * SKIN_STRIDE),
        restSkin: false,
      };
      this.runtimes.push(runtime);
      this.byObject.set(object, runtime);
      this.evaluate(runtime, null, null);
    }
  }

  /**
   * 一帧（对象更新那一步，和粒子同一循环、相机与脚本之前，rea-RT 2）：逐层推进时钟、求姿势、算蒙皮矩阵。`dt` 是已钳到
   * [0.0001, 0.25] 的帧时间（`g_Frametime`）；图层隐藏也推进。
   */
  frame(dt: number, state?: PuppetSink | null): void {
    const d = f(dt);
    for (const runtime of this.runtimes) this.evaluate(runtime, d, state ?? null);
  }

  /**
   * 不推进，按当前时钟重算一次姿势与蒙皮矩阵。宿主建 GPU 资源之前调（同 P10 的 `write`），探针 `seek` 之后自己会调。淡入完成时清 blendin
   * 位的副作用和这一帧已经算过的权重相同（同一个 `t`），重复调不改变结果。
   */
  refresh(state?: PuppetSink | null): void {
    for (const runtime of this.runtimes) this.evaluate(runtime, null, state ?? null);
  }

  /** 当前蒙皮矩阵（每骨骼 12 个 f32，见 `pose.ts` 的 `skinMatrices`）；静态 puppet、不是 puppet 的对象为 null。返回的数组每帧原地改写。 */
  skin(object: number): Float32Array | null {
    return this.byObject.get(object)?.skin ?? null;
  }

  /**
   * 重编译时接回上一份（同 P10：WPE 改属性不重载场景，动画层时钟、播放状态与 blendin 的清位都在）：按 (对象下标, 层下标) 找，动画的
   * fps / 长度 / 模式相同时拷时钟的 `t` 与运行时位（`PAUSED` / `DONE` / `BACK`），以及 blendin 是否已清。找不到的从 0 开始。只在新建之后、
   * 第一次 `frame` 之前调一次；之后调 `refresh` 让蒙皮跟上。
   */
  carryOver(previous: ScenePuppets | null): void {
    if (!previous || previous === this) return;
    for (const runtime of this.runtimes) {
      const before = previous.byObject.get(runtime.object);
      if (!before) continue;
      runtime.layers.forEach((layer, index) => {
        const old = before.layers[index];
        if (!old) return;
        const a = layer.clock;
        const b = old.clock;
        if (a.spf !== b.spf || a.D !== b.D || layer.length !== old.length || (a.flags & 3) !== (b.flags & 3)) return;
        a.t = b.t;
        a.flags = ((a.flags & ~(PAUSED | DONE | BACK)) | (b.flags & (PAUSED | DONE | BACK))) >>> 0;
        if (!(old.flags & LAYER_BLENDIN)) layer.flags &= ~LAYER_BLENDIN;
      });
      runtime.restSkin = false;
    }
  }

  /**
   * dev 探针在没有回放时按时间定位（近似，回放时不用）：每个可见层（按 `PuppetLayerDef`）的时钟设到「从 0 起以 `rate` 播了 `time` 秒」
   * 的位置：
   * - loop：`fmodf(time × rate, D)`，负的绕回 [0, D)；
   * - mirror：三角波，第奇数轮置反向位（`t = D − 余数`）；负的照逐帧推进的结果停在负数（正向段只在越过 D 时反射）；
   * - single：钳到 D，到头置结束位；负的照样停在负数。
   * 非 single 的层到过 `min(D/2, blendtime)` 时清 blendin。真实时钟是逐帧 float32 累加，舍入随帧时间累积，和逐帧回放可能差一帧。之后重算
   * 姿势（不读状态）。
   */
  seek(time: number): void {
    const elapsed = Number.isFinite(time) && time > 0 ? time : 0;
    for (const runtime of this.runtimes) {
      for (const layer of runtime.layers) {
        const clock = layer.clock;
        clock.t = 0;
        clock.flags = (clock.flags & 3) >>> 0;
        if (!layer.def.visible || !(clock.D > 0)) continue;
        const D = clock.D;
        const at = f(elapsed * layer.def.rate);
        if (clock.flags & SINGLE) {
          if (at >= D) {
            clock.t = D;
            clock.flags = (clock.flags | DONE) >>> 0;
          } else clock.t = at;
        } else if (clock.flags & MIRROR) {
          if (at < 0) clock.t = at;
          else {
            const rest = f(at % D);
            const rounds = Math.round((at - rest) / D);
            if (rounds % 2 === 1) {
              clock.t = f(D - rest);
              clock.flags = (clock.flags | BACK) >>> 0;
            } else clock.t = rest;
          }
        } else {
          const rest = f(at % D);
          clock.t = rest < 0 ? f(f(rest + D) % D) : rest;
        }
        if (!(clock.flags & SINGLE) && Math.abs(at) >= Math.min(f(D * 0.5), f(layer.blendtime)))
          layer.flags &= ~LAYER_BLENDIN;
      }
      runtime.restSkin = false;
    }
    this.refresh();
  }

  /** 一个 puppet：`d` 为 null 时不推进（`refresh`）。 */
  private evaluate(runtime: PuppetRuntime, d: number | null, state: PuppetSink | null): void {
    const { bones, pose, sample, skeleton } = runtime;
    let posed = false;
    for (let index = 0; index < runtime.layers.length; index++) {
      const layer = runtime.layers[index];
      const fields = state?.animationLayer(runtime.object, index) ?? layer.def;
      if (!fields.visible) continue;
      if (d !== null) {
        // 推进量 `dt × rate`（`0x1401fed7d`：`mulss`，float32）
        layer.clock.advance(f(d * f(fields.rate)), this.events);
        this.events.length = 0;
      }
      const at = frameIndex(layer.clock, layer.length, this.at);
      const w = layerWeight(layer, layer.clock, fields.blend);
      sampleLayer(layer.frames, layer.mask, bones, at.lo, at.hi, at.frac, sample);
      blendInto(
        pose,
        posed ? pose : skeleton.rest,
        sample,
        layer.mask,
        w,
        (layer.flags & LAYER_ADDITIVE) !== 0,
        skeleton.rest,
        bones,
      );
      posed = true;
    }
    if (!posed && runtime.restSkin) return;
    skinMatrices(posed ? pose : null, skeleton, runtime.world, runtime.skin);
    runtime.restSkin = !posed;
  }
}
