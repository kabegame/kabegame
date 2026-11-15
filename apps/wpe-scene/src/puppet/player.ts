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
 * - P12c：事件与「播完」回调。每个 puppet 推进完全部层（采样、混合都做完）之后才派发：先把本帧越过的 MDLA 事件按收集顺序（层序 × 事件表顺序）
 *   交给 `PuppetHooks.event`，再按层序调带 `ENDED` 位的层的播完回调表；所以回调里的写入都是下一帧生效。播完检测照 rea-p12-runtime 3.1：
 *   在推进那一步里、权重判断之前做（模型里权重为 0 的层照样检测）。控制口 `PuppetLayerControl` 是脚本 `IAnimationLayer` 的落点。
 * - P12b1：同一个层循环里再叠骨骼透明度（`g_BonesAlpha`）与变形权重（`g_MorphOffsets` / `g_MorphWeights`），规则在 `pose.ts`；`pose` 交出模型空间骨骼矩阵（挂点用）。
 * - P12b2-1：同一套运行时再服务带骨骼的模型对象（`kind: "model"`，rea-texchan-model 4–7，实测 `ignore/p12/b2/meas/report.txt`）。模式只改这几处：
 *   对象或父链不可见时整段跳过（时钟、权重、姿势都冻结）；权重 0 的层整层跳过（全部跳过就是没有层，局部矩阵取 `MDLS` 局部矩阵）；没有透明度轨道；
 *   变形按网格（`morphs[m]`，每网格自己的顶点数与缩放，权重混合钳 [0, 1]）；剔除盒取可见层动画包围盒的并。图像层的行为与字节不变。
 * - P12b2-2：图像层 puppet 多一份 `g_BlendMap`（16 个 float，初值 0，**帧首不复位**），每个可见层按纹理通道轨道写（`blendChannels`）；只在推进时写
 *   （`refresh` 不是 WPE 的更新，加法层会被重复累加）；模型不处理通道轨道。
 */
import { AnimationClock, BACK, DONE, MIRROR, PAUSED, SINGLE } from "../animation/clock";
import type { AnimationEventDef, AnimationMode } from "../animation/types";
import type { SceneLayer } from "../compile/bundle";
import type { ModelSkeleton, PuppetAnimation, PuppetLayerDef, ScenePuppet } from "../compile/puppet";
import { effectiveVisible, type LayerTransform } from "../render/layout";
import {
  BLEND_MAP_FLOATS,
  blendChannels,
  blendInto,
  blendModelMorphWeights,
  blendMorphWeights,
  blendScalarAlpha,
  frameIndex,
  LAYER_ADDITIVE,
  LAYER_BLENDIN,
  LAYER_BLENDOUT,
  layerWeight,
  MORPH_SLOTS,
  morphUniforms,
  POSE_STRIDE,
  resetBoneAlpha,
  resetMorph,
  sampleLayer,
  SKIN_STRIDE,
  skinMatrices,
  type FrameIndex,
  type MorphUniforms,
} from "./pose";

const f = Math.fround;

/** 时钟运行时位（P12c，WPE 同位）：`setFrame` 那一帧不判播完；本帧播完（loop 回绕、mirror 换向、single 结束）。 */
export const SETFRAME = 0x02000000;
export const ENDED = 0x04000000;

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
  /**
   * 对象自身与父链都可见吗（模型的更新门，P12b2-1）。看的是调用那一刻状态里的可见性：每帧更新在脚本之前，所以是上一帧脚本写下的（p12b2-vis 实测）。
   * 没有这个方法或对象不在状态里时当作可见；图像层 puppet 不看（隐藏也推进）。
   */
  visible?(object: number): boolean;
}

/** 把 `SceneState` 接成 `PuppetSink`（用户属性写进 `animationLayers`，puppet 当帧就读到；`layers` 给模型的可见性门）。 */
export function stateSink(state: {
  readonly animationLayers: ReadonlyMap<string, PuppetLayerFields>;
  readonly layers?: ReadonlyMap<number, Pick<LayerTransform, "parent" | "visible">>;
}): PuppetSink {
  const layers = state.layers;
  return {
    animationLayer: (object, layer) => state.animationLayers.get(animationLayerKey(object, layer)),
    ...(layers ? { visible: (object: number) => !layers.has(object) || effectiveVisible(object, layers) } : {}),
  };
}

/** `SceneState.animationLayers` 的键：对象下标与层下标。 */
export function animationLayerKey(object: number, layer: number): string {
  return `${object}:${layer}`;
}

/**
 * IAnimationLayer 的落点（P12c）：一个动画层的运行时，读写都直接作用在层上。`rate` / `blend` / `visible` 不在这里（在 `SceneState.animationLayers`，
 * 用户属性、字段脚本、API 三方共写）。方法照 `AnimationClock`；`stop` 的掩码 `0x3fffffff` 不清 `SETFRAME`，同 WPE。
 */
export interface PuppetLayerControl {
  /** `f32(1 / spf)`。 */
  readonly fps: number;
  /** 动画的 `length`（帧号上限）。 */
  readonly frameCount: number;
  /** 一轮的时长 `D`。 */
  readonly duration: number;
  name: string;
  additive: boolean;
  blendin: boolean;
  blendout: boolean;
  blendtime: number;
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  /** `t = f32(spf × f32(frame))`，另置 `SETFRAME`（本帧不判播完）。 */
  setFrame(frame: number): void;
  getFrame(): number;
  /** 播完回调（调用由登记方包好，这里只存、只调）。 */
  addEndedCallback(callback: () => void): void;
}

/** `frame` 的派发钩子（P12c）。 */
export interface PuppetHooks {
  /** 本帧越过的 MDLA 事件：每个 puppet 推进完全部层之后，按收集顺序（层序 × 事件表顺序）调。 */
  event?(object: number, json: string): void;
}

/** 一个动画层的运行时。 */
interface LayerRuntime {
  readonly def: PuppetLayerDef;
  readonly frames: Float32Array;
  readonly mask: Uint8Array;
  /** 这条动画的骨骼透明度与变形权重轨道（`ScenePuppet.animations`）。 */
  readonly animation: PuppetAnimation;
  readonly clock: AnimationClock;
  /** 动画的 `length`（帧号上限，`frameIndex` 用）。 */
  readonly length: number;
  /** additive / blendin / blendout 位（visible 每帧从状态读）；blendin 第一次淡入完成后清掉（非 single）。 */
  flags: number;
  /** 可写（`IAnimationLayer.blendtime`，P12c）。 */
  blendtime: number;
  /** 当前名字（可写，`IAnimationLayer.name`，P12c；`findLayer` 按它找）。 */
  name: string;
  /** 播完回调表（P12c）；重编译时同一个数组接回。 */
  callbacks: (() => void)[];
  /** 控制口（懒建）。 */
  control: PuppetLayerControl | null;
}

/**
 * 运行时要的数据：`ScenePuppet`（图像层）与 `ModelSkeleton`（模型对象）都满足。`morph` 是图像层网格 0 的变形、`morphs` 是模型每网格的变形，
 * `boneAlpha` 只有图像层有。
 */
export interface PuppetRig {
  skeleton: ScenePuppet["skeleton"];
  animations: PuppetAnimation[];
  layers: PuppetLayerDef[];
  boneAlpha?: boolean;
  morph?: ScenePuppet["morph"];
  morphs?: ModelSkeleton["morphs"];
}

/**
 * 场景里要进运行时的对象（图像层 puppet 与带骨骼的模型，按图层顺序）：宿主与探针的 `new ScenePuppets(...)` 共用这一处，模型不会漏掉（P12b2-1）。
 * 一个图层只会是其中一种。
 */
export function puppetEntries(
  layers: readonly Pick<SceneLayer, "object" | "puppet" | "model">[],
): { object: number; puppet: PuppetRig; kind: "image" | "model" }[] {
  return layers.flatMap((layer): { object: number; puppet: PuppetRig; kind: "image" | "model" }[] =>
    layer.puppet
      ? [{ object: layer.object, puppet: layer.puppet, kind: "image" }]
      : layer.model?.skeleton
        ? [{ object: layer.object, puppet: layer.model.skeleton, kind: "model" }]
        : [],
  );
}

/** 模型一个网格的变形运行时：权重与生效位按该网格的目标数，uniform 用该网格自己的顶点数与缩放（决定 1，WPE 两处缺陷不照抄）。 */
interface MeshMorphRuntime {
  readonly weights: Float32Array;
  readonly active: Uint8Array;
  readonly uniforms: MorphUniforms;
  readonly vertices: number;
  readonly scale: number;
}

/** 剔除盒累加的起点（`FLT_MAX`，rea-texchan-model 7.6）。 */
const FLT_MAX = 3.4028234663852886e38;
/** 没有动画包围盒（MDLA v < 5）时并进剔除盒的全 0 盒子。 */
const ZERO_BOX: readonly number[] = [0, 0, 0, 0, 0, 0];

/** 一个 skinned puppet（或带骨骼的模型）的运行时。 */
interface PuppetRuntime {
  readonly object: number;
  readonly kind: "image" | "model";
  readonly puppet: PuppetRig;
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
  /** 上一次的蒙皮来自静止来源矩阵（没有可见层）：再没有可见层时结果不变，不必重算（骨骼透明度与变形 uniform 同样是复位后的值）。 */
  restSkin: boolean;
  /** `g_BonesAlpha`（每骨骼 1 个 f32）；没有 `boneAlpha` 为 null。 */
  readonly alpha: Float32Array | null;
  /** 变形：每目标权重、生效位与交给渲染的 uniform；没有 `morph` 为 null。 */
  readonly morph: { weights: Float32Array; active: Uint8Array; uniforms: MorphUniforms } | null;
  /** 模型每网格的变形（下标 = mdl 网格下标，没有目标的网格为 null）；图像层为 null。 */
  readonly meshMorphs: (MeshMorphRuntime | null)[] | null;
  /** 模型的剔除盒（min xyz、max xyz，模型空间）：可见层动画包围盒的并；还没有有效的就是 null（用 mdl 包围盒）。 */
  bounds: number[] | null;
  /** 时钟收集的 MDLA 事件（P12c）：每个 puppet 一份，推进完全部层之后派发并清空。 */
  readonly events: AnimationEventDef[];
  /** `g_BlendMap`（P12b2-2，WPE `P+0x350` 起 16 个 float，构造时清 0、跨帧保留）；模型为 null。 */
  readonly blendMap: Float32Array | null;
}

/**
 * 按 `FUN_1401a8c10` 建时钟（rea-RT 3.1）：fps 或一轮时长不是正数时早退，`spf` 1、`D` 0、模式位 0（python 模型的 `Clock` 同样）。
 * 只用 `AnimationClock` 的构造与 `D` 字段（P10b 在改它，接口以那边为准）。
 */
function layerClock(
  fps: number,
  length: number,
  mode: AnimationMode,
  events: readonly AnimationEventDef[],
): AnimationClock {
  const fps32 = f(fps);
  const D = f(f(Math.trunc(length)) / fps32);
  if (!(fps32 > 0) || !(D > 0)) {
    const clock = new AnimationClock({ fps: 1, length, mode: 0, startpaused: false }, events);
    clock.D = 0;
    return clock;
  }
  return new AnimationClock({ fps, length, mode, startpaused: false }, events);
}

/** 一层的控制口（P12c）：读写直接作用在层的运行时上。 */
function layerControl(layer: LayerRuntime): PuppetLayerControl {
  const clock = layer.clock;
  const bit = (mask: number) => ({
    get: () => (layer.flags & mask) !== 0,
    set: (value: boolean) => {
      layer.flags = value ? layer.flags | mask : layer.flags & ~mask;
    },
  });
  const additive = bit(LAYER_ADDITIVE);
  const blendin = bit(LAYER_BLENDIN);
  const blendout = bit(LAYER_BLENDOUT);
  return {
    get fps() {
      return f(1 / clock.spf);
    },
    get frameCount() {
      return layer.length;
    },
    get duration() {
      return clock.D;
    },
    get name() {
      return layer.name;
    },
    set name(value: string) {
      layer.name = value;
    },
    get additive() {
      return additive.get();
    },
    set additive(value: boolean) {
      additive.set(value);
    },
    get blendin() {
      return blendin.get();
    },
    set blendin(value: boolean) {
      blendin.set(value);
    },
    get blendout() {
      return blendout.get();
    },
    set blendout(value: boolean) {
      blendout.set(value);
    },
    get blendtime() {
      return layer.blendtime;
    },
    set blendtime(value: number) {
      layer.blendtime = value;
    },
    play: () => clock.play(),
    pause: () => clock.pause(),
    stop: () => clock.stop(),
    isPlaying: () => clock.isPlaying(),
    setFrame: (frame: number) => {
      clock.setFrame(frame);
      clock.flags = (clock.flags | SETFRAME) >>> 0;
    },
    getFrame: () => clock.getFrame(),
    addEndedCallback: (callback: () => void) => {
      layer.callbacks.push(callback);
    },
  };
}

export class ScenePuppets {
  /** skinned puppet，按 `list` 的顺序。 */
  private readonly runtimes: PuppetRuntime[] = [];
  private readonly byObject = new Map<number, PuppetRuntime>();
  private readonly at: FrameIndex = { lo: 0, hi: 0, frac: 0 };

  /**
   * 只收 skinned 的（`skeleton` 不为 null）；静态 puppet 不进运行时，`skin` 给 null。建好后按 t = 0 算一次姿势（不推进）。`kind` 缺省 `"image"`
   * （图像层 puppet）；带骨骼的模型对象交 `"model"` 和它的 `SceneModel.skeleton`（P12b2-1）。
   */
  constructor(list: readonly { object: number; puppet: PuppetRig; kind?: "image" | "model" }[]) {
    for (const { object, puppet, kind = "image" } of list) {
      const skeleton = puppet.skeleton;
      if (!skeleton) continue;
      const bones = skeleton.parents.length;
      const layers = puppet.layers.map((def): LayerRuntime => {
        const animation = puppet.animations[def.animation];
        const clock = layerClock(animation.fps, animation.length, animation.mode, animation.events);
        let flags = (def.additive ? LAYER_ADDITIVE : 0) | (def.blendin ? LAYER_BLENDIN : 0);
        // blendout 只在 single 有效：加载时非 single 直接清掉（`0x1401fd068`，rea-RT 1.4）
        if (def.blendout && clock.flags & SINGLE) flags |= LAYER_BLENDOUT;
        return {
          def,
          frames: animation.frames,
          mask: animation.mask,
          animation,
          clock,
          length: Math.trunc(animation.length),
          flags,
          blendtime: def.blendtime,
          name: def.name,
          callbacks: [],
          control: null,
        };
      });
      const runtime: PuppetRuntime = {
        object,
        kind,
        puppet,
        skeleton,
        bones,
        layers,
        pose: new Float32Array(bones * POSE_STRIDE),
        sample: new Float32Array(bones * POSE_STRIDE),
        world: new Float32Array(bones * 16),
        skin: new Float32Array(bones * SKIN_STRIDE),
        restSkin: false,
        alpha: puppet.boneAlpha ? new Float32Array(bones).fill(1) : null,
        morph: puppet.morph
          ? {
              weights: new Float32Array(puppet.morph.targets),
              active: new Uint8Array(puppet.morph.targets),
              uniforms: { offsets: new Uint32Array(MORPH_SLOTS), weights: new Float32Array(MORPH_SLOTS) },
            }
          : null,
        meshMorphs:
          kind === "model" && puppet.morphs
            ? puppet.morphs.map((morph) =>
                morph
                  ? {
                      weights: new Float32Array(morph.targets),
                      active: new Uint8Array(morph.targets),
                      uniforms: { offsets: new Uint32Array(MORPH_SLOTS), weights: new Float32Array(MORPH_SLOTS) },
                      vertices: morph.vertices,
                      scale: morph.scale,
                    }
                  : null,
              )
            : null,
        bounds: null,
        events: [],
        blendMap: kind === "image" ? new Float32Array(BLEND_MAP_FLOATS) : null,
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
  frame(dt: number, state?: PuppetSink | null, hooks?: PuppetHooks | null): void {
    const d = f(dt);
    for (const runtime of this.runtimes) {
      this.evaluate(runtime, d, state ?? null);
      this.dispatch(runtime, hooks ?? null);
    }
  }

  /**
   * 一个 puppet 推进完之后的派发（P12c，rea-p12c-script 3）：先把收集的事件逐个交给 `hooks.event`（交出去之前拷走并清空，回调里再推进也不会重复），
   * 再按层序处理带 `ENDED` 的层：清掉这一位，拷一份回调表逐个调。没有事件、没有 ENDED 层时什么都不做。
   */
  private dispatch(runtime: PuppetRuntime, hooks: PuppetHooks | null): void {
    if (runtime.events.length) {
      const events = runtime.events.splice(0);
      if (hooks?.event) for (const event of events) hooks.event(runtime.object, event.json);
    }
    for (const layer of runtime.layers) {
      if (!(layer.clock.flags & ENDED)) continue;
      layer.clock.flags = (layer.clock.flags & ~ENDED) >>> 0;
      for (const callback of [...layer.callbacks]) callback();
    }
  }

  /** skinned puppet / 带骨骼模型的动画层数；别的对象为 0（P12c）。 */
  layerCount(object: number): number {
    return this.byObject.get(object)?.layers.length ?? 0;
  }

  /** 第 `index` 层的控制口；不是 puppet 或 index 越界为 null（P12c）。 */
  layer(object: number, index: number): PuppetLayerControl | null {
    const layer = this.byObject.get(object)?.layers[index];
    if (!layer) return null;
    return (layer.control ??= layerControl(layer));
  }

  /** 按**当前**名字找层：最后一个匹配，空串不匹配，找不到 −1（P12c，`getAnimationLayer("名字")`）。 */
  findLayer(object: number, name: string): number {
    const layers = this.byObject.get(object)?.layers;
    if (!layers || name === "") return -1;
    for (let index = layers.length - 1; index >= 0; index--) if (layers[index].name === name) return index;
    return -1;
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

  /** 模型空间骨骼矩阵（每骨骼 16 个 f32，同 `Mat4` 的列主序布局，WPE 的 `P+0x2c8`，挂点用）；静态 puppet、不是 puppet 的对象为 null。每帧原地改写。 */
  pose(object: number): Float32Array | null {
    return this.byObject.get(object)?.world ?? null;
  }

  /**
   * `g_BonesAlpha`（每骨骼 1 个 f32）；没有 `boneAlpha`（网格 0 没有 bit2、静态 puppet）的为 null。每帧原地改写：先全置 1，再逐可见层叠；
   * 没有可见层时全 1。
   */
  boneAlpha(object: number): Float32Array | null {
    return this.byObject.get(object)?.alpha ?? null;
  }

  /**
   * `g_MorphOffsets`（12 个 u32：[0] 生效数，[1+k] 目标号 × nv）与 `g_MorphWeights`（12 个 f32：[0] 缩放，[1+k] 权重）；没有 `morph` 的为 null。
   * 每帧原地改写：权重与生效位先清 0，再逐可见层叠，最后取前 11 个生效目标按权重降序写 uniform（`pose.ts` 的 `morphUniforms`）；没有可见层时生效数 0。
   */
  morph(object: number, mesh?: number): { offsets: Uint32Array; weights: Float32Array } | null {
    const runtime = this.byObject.get(object);
    // 模型：每网格一份（`mesh` 是 mdl 网格下标），偏移用该网格自己的顶点数、`g_MorphWeights[0]` 是该网格的 `MDMP` 缩放（决定 1：WPE 用最后一个变形网格的
    // 顶点数、按排序后的绘制记录下标取缩放与权重，那是缺陷，不照抄）
    if (runtime?.meshMorphs) return mesh === undefined ? null : (runtime.meshMorphs[mesh]?.uniforms ?? null);
    return runtime?.morph?.uniforms ?? null;
  }

  /**
   * `g_BlendMap`（P12b2-2，16 个 float，纹理通道网格的混合权重，rea-texchan-model 3）：每个图像层 puppet 一份，初值 0、帧首不复位，推进时按可见层的通道轨道
   * 叠写（覆盖 / 混合 / 加法，不钳制）；模型与不是 puppet 的对象为 null。每帧原地改写；上传取前 `4 × BLENDROWCOUNT` 个。
   */
  blendMap(object: number): Float32Array | null {
    return this.byObject.get(object)?.blendMap ?? null;
  }

  /**
   * 模型的剔除盒（min xyz、max xyz，模型空间）：每次更新末尾取可见层（动画层的 `visible`，不看权重）动画包围盒的并，至少一个盒子有效（max.x > min.x）才用
   * （rea-texchan-model 7.6，p12b2-cull 实测）；没有有效的、不是模型、没有动画层时为 null，调用方用 mdl 的包围盒。图像层 puppet 不用。
   */
  bounds(object: number): readonly number[] | null {
    return this.byObject.get(object)?.bounds ?? null;
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
      // `g_BlendMap` 是跨帧的持久状态（WPE 改属性不重载，`P+0x350` 不变），重编译时保留这 16 个 float
      if (runtime.blendMap && before.blendMap) runtime.blendMap.set(before.blendMap);
      runtime.layers.forEach((layer, index) => {
        const old = before.layers[index];
        if (!old) return;
        const a = layer.clock;
        const b = old.clock;
        if (a.spf !== b.spf || a.D !== b.D || layer.length !== old.length || (a.flags & 3) !== (b.flags & 3)) return;
        a.t = b.t;
        a.flags =
          ((a.flags & ~(PAUSED | DONE | BACK | SETFRAME)) | (b.flags & (PAUSED | DONE | BACK | SETFRAME))) >>> 0;
        // 五个可写字段与回调表（P12c，WPE 改属性不重载，脚本写过的都还在）：additive / blendin / blendout 三位原样接回（blendin 是否已清也在里面）
        const writable = LAYER_ADDITIVE | LAYER_BLENDIN | LAYER_BLENDOUT;
        layer.flags = (layer.flags & ~writable) | (old.flags & writable);
        layer.name = old.name;
        layer.blendtime = old.blendtime;
        layer.callbacks = old.callbacks;
        layer.control = null;
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

  /**
   * 一个 puppet：`d` 为 null 时不推进（`refresh`）。模型（`kind === "model"`）：推进时对象或父链不可见就整段跳过；每帧开头清全部网格的变形权重；
   * 权重 0 的层整层跳过（时钟照推进，不算「已有层」）；末尾更新剔除盒。
   */
  private evaluate(runtime: PuppetRuntime, d: number | null, state: PuppetSink | null): void {
    const { bones, pose, sample, skeleton, alpha, morph, meshMorphs } = runtime;
    const model = runtime.kind === "model";
    // 更新门（rea-texchan-model 4：`FUN_14021c480` 开头；p12b2-vis 实测：模型自己或父链隐藏时时钟冻结，重新可见的第一帧照画但那一帧的更新已被跳过）。
    // 只在推进时判：`refresh` 是按当前时钟重算（建场景、探针 `seek`），不是 WPE 的更新
    if (model && d !== null && state?.visible && !state.visible(runtime.object)) return;
    let posed = false;
    /** 骨骼透明度与变形权重每帧复位一次：第一个可见层之前，或者没有可见层且上次不是静止时。模型是每帧开头无条件清（`0x14021c574`）。 */
    const reset = () => {
      if (alpha) resetBoneAlpha(alpha);
      if (morph) resetMorph(morph.weights, morph.active);
      if (meshMorphs) for (const item of meshMorphs) if (item) resetMorph(item.weights, item.active);
    };
    if (model) reset();
    for (let index = 0; index < runtime.layers.length; index++) {
      const layer = runtime.layers[index];
      const fields = state?.animationLayer(runtime.object, index) ?? layer.def;
      if (!fields.visible) continue;
      if (!model && !posed) reset();
      if (d !== null) {
        const clock = layer.clock;
        const old = clock.flags >>> 0;
        const t0 = clock.t;
        // 推进量 `dt × rate`（`0x1401fed7d`：`mulss`，float32）；越过的事件收进本 puppet 的列表，推进完全部层后派发
        clock.advance(f(d * f(fields.rate)), runtime.events);
        // 播完检测（rea-p12-runtime 3.1）：暂停 / 已结束 / setFrame 那一帧不判
        if (!(old & (PAUSED | DONE | SETFRAME))) {
          const ended =
            clock.flags & SINGLE
              ? (clock.flags & DONE) !== 0 // single：本帧刚结束
              : clock.flags & MIRROR
                ? ((old ^ clock.flags) & BACK) !== 0 // mirror：换向
                : t0 > clock.t; // loop：回绕（负 rate 每帧都成立，照抄）
          if (ended) clock.flags = (clock.flags | ENDED) >>> 0;
        }
        // 只在可见、推进的层上清（不可见的层保留到下次推进）
        clock.flags = (clock.flags & ~SETFRAME) >>> 0;
      }
      const at = frameIndex(layer.clock, layer.length, this.at);
      const w = layerWeight(layer, layer.clock, fields.blend);
      // 模型：权重 0 的层整层跳过，也不置「已有层」（p12b2-mdl 实测：与去掉这一层逐位相同；图像层不跳过）
      if (model && w === 0) continue;
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
      const additive = (layer.flags & LAYER_ADDITIVE) !== 0;
      const track = layer.animation;
      if (alpha && track.alpha)
        blendScalarAlpha(alpha, track.alpha, track.alphaMask, bones, at.lo, at.hi, at.frac, w, additive);
      if (morph && track.morph)
        blendMorphWeights(morph.weights, morph.active, track.morph, at.lo, at.hi, at.frac, w, additive);
      // 纹理通道（P12b2-2）：只在推进时写（`refresh` 不是 WPE 的更新，加法层会重复累加）；不复位，没有可见层时保持上一帧
      if (runtime.blendMap && d !== null && track.channels?.length)
        blendChannels(runtime.blendMap, track.channels, at.lo, at.hi, at.frac, w, additive);
      if (meshMorphs && track.meshMorph)
        meshMorphs.forEach((item, m) => {
          const tracks = track.meshMorph![m];
          if (item && tracks)
            blendModelMorphWeights(item.weights, item.active, tracks, at.lo, at.hi, at.frac, w, additive);
        });
      posed = true;
    }
    if (model) this.updateBounds(runtime, state);
    if (!posed) {
      if (runtime.restSkin) return;
      if (!model) reset();
    }
    if (morph)
      morphUniforms(
        morph.weights,
        morph.active,
        runtime.puppet.morph!.vertices,
        runtime.puppet.morph!.scale,
        morph.uniforms,
      );
    if (meshMorphs)
      for (const item of meshMorphs)
        if (item) morphUniforms(item.weights, item.active, item.vertices, item.scale, item.uniforms);
    skinMatrices(posed ? pose : null, skeleton, runtime.world, runtime.skin);
    runtime.restSkin = !posed;
  }

  /**
   * 模型的剔除盒（`FUN_140226a10`，rea-texchan-model 7.6；p12b2-cull 实测）：层表非空时，从 ±`FLT_MAX` 起把每个可见层（`visible`，不看权重）的动画包围盒逐分量
   * min / max 并起来；有一个可见层的盒子有效（max.x > min.x）才用这个并集（其余可见层全 0 的盒子也并进去，所以至少含原点），否则退回 mdl 的包围盒（null）。
   * 层表空时 WPE 不更新（保持原值）。
   */
  private updateBounds(runtime: PuppetRuntime, state: PuppetSink | null): void {
    if (!runtime.layers.length) return;
    const box = [FLT_MAX, FLT_MAX, FLT_MAX, -FLT_MAX, -FLT_MAX, -FLT_MAX];
    let valid = false;
    runtime.layers.forEach((layer, index) => {
      const fields = state?.animationLayer(runtime.object, index) ?? layer.def;
      if (!fields.visible) return;
      // MDLA v < 5 没有包围盒：WPE 动画记录里这 6 个 float 是构造时的 0（推断，语料的动画全是 v5），全 0 的盒子照样并进去（同上）
      const own = layer.animation.bounds ?? ZERO_BOX;
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], own[axis]);
        box[axis + 3] = Math.max(box[axis + 3], own[axis + 3]);
      }
      if (own[3] > own[0]) valid = true;
    });
    runtime.bounds = valid ? box : null;
  }
}
