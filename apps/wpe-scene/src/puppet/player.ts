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
 * - P12d-1：骨骼物理（只图像层 puppet，参数在 `skeleton.physics`，求解在 `physics.ts`）。`frame` 推进时在 `skinMatrices` 的每根骨骼回调里解：算完 `Pose[i]` 就
 *   `Mw = W·Pose[i]`、解物理、`Pose[i] ← Pose[i]·D`，后面的子骨骼与蒙皮都用改过的值；`W` 由宿主经 `PuppetSink.world` 交进来（上一帧脚本写下的图层世界矩阵含对齐偏移，
 *   正是 WPE 的时序，p12-REPORT 第二部分 1.5）。世界骨骼矩阵两份缓冲 `prev` / `cur` 在推进开头交换，`cur` 对**全部**骨骼各写一次（物理骨骼在物理之后写，不再拷贝，脚本 `setBoneTransform` 直接改它，同 WPE `P+0x340` / `P+0x348`），
 *   首帧 `prev` 为空不解；`refresh` 不是 WPE 的更新，不解也不动状态；隐藏照算（图像层不看可见性）；有物理骨骼的运行时不走「静止捷径」（状态每帧在变）。
 * - P12e-1：层有稳定 id（编译期的层 = `PuppetLayerDef.entry`，运行时建的层 = 负数、每个 puppet 从 −1 起递减不复用），层表（顺序）另存、可 `createLayer` / `destroyLayers`；
 *   「下标」只在插入位置与 `destroyLayers` 的下标选择器里出现。派发改成 WPE 的形状：本帧确有层播完（`anyEnded`）才进回调循环，回调后复位下标（漏扫），
 *   单次层（`SINGLE_SHOT`）先置 `DOOMED` 再调回调、循环之后当场删除；`destroyLayers` 把层摘到 `detached`，`settle` 在本帧全部脚本之后释放。
 *   `carryOver` 按 id 接回层表顺序、运行时层、删过的编译期层。依据 rea-p12e-createlayer 与 phase-12e-createlayer 点 2。
 * - P12f：绘制顺序（只图像层 puppet 且网格 0 有 bit3，`drawOrder` 字段，纯函数在 `drawOrder.ts`）。推进时在逐层循环之前把每骨骼当前值 `cur` 复位成骨骼基数，每个可见层
 *   （不看权重、不可见的跳过）用这层的绘制顺序轨道 lo 帧改写它（覆盖 / 混合 / 加法，叠法判断同 TRS 混合），蒙皮之后只有本帧有层写过才重算键、当前顺序非降序时什么都不做、
 *   否则稳定排序并重拼索引与裁切命令表；顺序跨帧保留（没有写入的帧、层隐藏 / 删掉之后都保持），`refresh` 不写不排。依据 rea-p12f-draworder 第 2、3、6 节。
 * - P12b2-2：图像层 puppet 多一份 `g_BlendMap`（16 个 float，初值 0，**帧首不复位**），每个可见层按纹理通道轨道写（`blendChannels`）；只在推进时写
 *   （`refresh` 不是 WPE 的更新，加法层会被重复累加）；模型不处理通道轨道。
 */
import { AnimationClock, BACK, DONE, MIRROR, PAUSED, SINGLE } from "../animation/clock";
import type { AnimationEventDef, AnimationMode } from "../animation/types";
import type { SceneLayer } from "../compile/bundle";
import type { ModelSkeleton, PuppetAnimation, PuppetLayerDef, ScenePuppet } from "../compile/puppet";
import type { BonePhysics } from "../compile/puppet";
import {
  blendDrawOrder,
  clippingTable,
  fileIndices,
  orderedIndices,
  reorder,
  type DrawNode,
  type DrawRecord,
} from "./drawOrder";
import { drawMatrixOf, effectiveVisible, type LayerTransform } from "../render/layout";
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
import { inverse4, mulAffine, mulFull } from "./math";
import { applyBoneImpulse, createBoneState, resetBoneState, solveBone, type BoneState } from "./physics";

const f = Math.fround;
const EMPTY_MASK = new Uint8Array(0);

/** 时钟运行时位（P12c，WPE 同位）：`setFrame` 那一帧不判播完；本帧播完（loop 回绕、mirror 换向、single 结束）。 */
export const SETFRAME = 0x02000000;
export const ENDED = 0x04000000;
/** playSingleAnimation 的层（P12e，WPE `K.flags` 同位，`0x14020ef67`）：第一次播完时先置 DOOMED 再调回调。 */
export const SINGLE_SHOT = 0x08000000;
/** 本帧回调循环之后当场删除（WPE `0x10000000`，`0x140200371`）。play / setFrame / stop 都不清它（stop 的掩码 0x3fffffff 保留它）。 */
export const DOOMED = 0x10000000;

/** 动画层的三个可变字段（WPE `AL+0xc8` / `+0xcc` / `+0xd0` bit0，rea-RT 1.5）。 */
export interface PuppetLayerFields {
  rate: number;
  blend: number;
  visible: boolean;
}

/** 运行时建层的规整结果（P12e，`script/animationLayerConfig.ts` 产出）：字段已按 WPE 的 JSON setter 取值。 */
export interface AnimationLayerItem {
  /** `ScenePuppet.animations` 的下标（= MDLA 下标）。 */
  animation: number;
  name: string;
  rate: number;
  blend: number;
  visible: boolean;
  additive: boolean;
  blendin: boolean;
  blendout: boolean;
  blendtime: number;
  /** `config.autosort` 是 JSON `true`（`1`、`"true"` 都不算，rea-p12c 第 7 节）。 */
  autosort: boolean;
  /** `config.index` 是 JSON 数时的 `asInt`（向零取整）；不是数为 null。 */
  index: number | null;
}

/**
 * 读动画层字段的状态（步骤 3 接到 `SceneState`：用户属性在两帧之间写进去，puppet 当帧就读到，p12-REPORT 用例 4）。取不到时用
 * `PuppetLayerDef` 里的值。`object` 是 `objects` 下标，`layer` 是层 id（P12e：编译期的层 = `animationlayers` 的 JSON 下标，运行时建的层是负数）。
 */
export interface PuppetSink {
  animationLayer(object: number, layer: number): PuppetLayerFields | undefined;
  /**
   * 对象自身与父链都可见吗（模型的更新门，P12b2-1）。看的是调用那一刻状态里的可见性：每帧更新在脚本之前，所以是上一帧脚本写下的（p12b2-vis 实测）。
   * 没有这个方法或对象不在状态里时当作可见；图像层 puppet 不看（隐藏也推进）。
   */
  visible?(object: number): boolean;
  /**
   * 图层本帧的世界矩阵（16 个 f32，列主序）含对齐偏移（WPE 图层的世界矩阵虚函数 `+0x80`，骨骼物理的 `W`，P12d-1）；对象不在状态里、不给这个方法时为 null，
   * 物理不跑（单测、`refresh`）。读的是调用那一刻的状态：每帧更新在脚本之前，所以是上一帧脚本写下的。
   */
  world?(object: number): Float32Array | null;
}

/** 把 `SceneState` 接成 `PuppetSink`（用户属性写进 `animationLayers`，puppet 当帧就读到；`layers` 给模型的可见性门）。 */
export function stateSink(state: {
  readonly animationLayers: ReadonlyMap<string, PuppetLayerFields>;
  readonly layers?: ReadonlyMap<number, Pick<LayerTransform, "parent" | "visible"> & Partial<LayerTransform>>;
}): PuppetSink {
  const layers = state.layers;
  return {
    animationLayer: (object, layer) => state.animationLayers.get(animationLayerKey(object, layer)),
    ...(layers
      ? {
          visible: (object: number) => !layers.has(object) || effectiveVisible(object, layers),
          // 物理的 `W`：`drawMatrixOf`（世界矩阵 · 自身偏移，不走挂点：语料没有挂在物理骨骼上的 puppet，挂在别的骨骼上的 puppet 的 `W` 退成普通父子，
          // 与 WPE 差一个挂点矩阵；要做时在这里接渲染器的 `attachHook`）。条目没有变换字段（单测的最小状态）时为 null
          world: (object: number) => {
            const layer = layers.get(object);
            if (!layer?.origin || !layer.angles || !layer.scale) return null;
            return drawMatrixOf(object, layers as ReadonlyMap<number, LayerTransform>, new Map());
          },
        }
      : {}),
  };
}

/** `SceneState.animationLayers` 的键：对象下标与层 id（P12e：不是层表里的位置）。 */
export function animationLayerKey(object: number, id: number): string {
  return `${object}:${id}`;
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
  /**
   * 一层被释放（P12e）：单次层在派发里被删、或 `settle` 释放 destroyAnimationLayer 摘出的层。宿主删 SceneState 的三方共写字段、
   * 给它的动画层字段脚本发 destroy、去掉重放表里它的项。之后包装作废（`alive` 为假）。
   */
  released?(object: number, id: number): void;
}

/** 一个动画层的运行时。 */
interface LayerRuntime {
  /** 层 id（P12e）：编译期的层 = `def.entry`，运行时建的层是负数。 */
  readonly id: number;
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
  /** 绘制顺序（P12f，图像层 puppet）：`dynamic` 时运行时才建；`mesh.indices` 是文件索引字节。手写的假 rig 可以不给。 */
  order?: ScenePuppet["order"];
  mesh?: Pick<ScenePuppet["mesh"], "indices">;
  clipping?: ScenePuppet["clipping"];
}

/** 一个 puppet 的绘制顺序运行时（P12f）：`cur` 是 WPE 的 `P+0x280`；`order` 原地改写（节点下标，当前顺序）；`indices` / `clipping` 是按当前顺序拼好的输出。 */
interface DrawOrderRuntime {
  readonly nodes: readonly DrawNode[];
  readonly records: readonly DrawRecord[];
  readonly base: Int32Array;
  /** 文件里的原始 u16 索引（重排时从它拼）。 */
  readonly file: Uint16Array;
  readonly cur: Float32Array;
  readonly order: Int32Array;
  readonly keys: Int32Array;
  version: number;
  indices: Uint16Array;
  clipping: Pick<NonNullable<ScenePuppet["clipping"]>, "commands" | "segments"> | null;
}

/** 按当前顺序重拼输出（索引整张网格；有记录时重建命令表）。 */
function rebuildDrawOutput(d: DrawOrderRuntime): void {
  d.indices = orderedIndices(d.order, d.nodes, d.file);
  d.clipping = d.records.length ? clippingTable(d.order, d.nodes, d.records, d.file) : null;
}

/** 两份节点表是否相同（`carryOver` 接回顺序的条件）：数量、每个节点的 base / bone / start / count，与记录。 */
function sameDrawNodes(a: DrawOrderRuntime, b: DrawOrderRuntime): boolean {
  if (a.nodes.length !== b.nodes.length || a.records.length !== b.records.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (x.base !== y.base || x.bone !== y.bone || x.start !== y.start || x.count !== y.count) return false;
  }
  for (let i = 0; i < a.records.length; i++) {
    const x = a.records[i];
    const y = b.records[i];
    if (
      x.name !== y.name ||
      x.flags !== y.flags ||
      x.parent !== y.parent ||
      x.list1.join() !== y.list1.join() ||
      x.list2.join() !== y.list2.join()
    )
      return false;
  }
  return true;
}

/**
 * 场景里要进运行时的对象（图像层 puppet 与带骨骼的模型，按图层顺序）：宿主与探针的 `new ScenePuppets(...)` 共用这一处，模型不会漏掉（P12b2-1）。
 * 一个图层只会是其中一种。
 */
export function puppetEntries(
  layers: readonly Pick<SceneLayer, "object" | "puppet" | "model">[],
): { object: number; puppet: PuppetRig; kind: "image" | "model" }[] {
  return layers.flatMap((layer) => puppetEntry(layer));
}

/** 单个图层要进运行时的条目（L3b：`puppetEntries` 的逐个版本，同一规则）；不是 skinned puppet / 带骨骼模型时为空数组。 */
export function puppetEntry(
  layer: Pick<SceneLayer, "object" | "puppet" | "model">,
): { object: number; puppet: PuppetRig; kind: "image" | "model" }[] {
  return layer.puppet
    ? [{ object: layer.object, puppet: layer.puppet, kind: "image" }]
    : layer.model?.skeleton
      ? [{ object: layer.object, puppet: layer.model.skeleton, kind: "model" }]
      : [];
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
  /** 层表（顺序 = 采样混合顺序 = getAnimationLayer 的下标）。建删层原地改这个数组（splice），不换引用：回调循环在遍历它。 */
  readonly layers: LayerRuntime[];
  /** 全部活着的层，按 id（含已从层表摘出、还没 settle 的：同一帧包装照常可用）。 */
  readonly byId: Map<number, LayerRuntime>;
  /** destroyAnimationLayer 摘出的层，`settle` 在脚本之后释放（WPE 的 `ctx+0x1478`）。 */
  readonly detached: LayerRuntime[];
  /** 删过的编译期层的 id（接回时不再建它们，跨重编译保留）。 */
  readonly destroyedEntries: Set<number>;
  /** 下一个运行时层 id（−1 起递减，接回时保留，不复用）。 */
  nextId: number;
  /** 本帧推进时有层播完（WPE 的 anyEnded）：只有它为真时才进回调与删层循环。 */
  anyEnded: boolean;
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
  /** 骨骼物理（P12d-1）；没有物理骨骼（含模型对象）为 null。 */
  readonly physics: PhysicsRuntime | null;
  /** 绘制顺序（P12f）：只图像层 puppet 且 `order.dynamic` 时有。 */
  readonly drawOrder: DrawOrderRuntime | null;
}

/** 一个 puppet 的物理运行时。 */
interface PhysicsRuntime {
  /** 每骨骼的参数（`skeleton.physics`），null = 这根骨骼没开物理。 */
  readonly params: readonly (BonePhysics | null)[];
  /** 有骨骼开了物理（没有时只写 `cur`，不走物理、静止捷径照旧）。 */
  readonly active: boolean;
  /** 每骨骼的状态（没开物理的为 null）。 */
  readonly states: (BoneState | null)[];
  /** 上一帧物理之后的世界骨骼矩阵（`P+0x348`，每骨骼 16 个 f32）；`hasPrev` 为假时还没有。 */
  prev: Float32Array;
  /** 本帧的世界骨骼矩阵（`P+0x340`）；帧末与 `prev` 交换。 */
  cur: Float32Array;
  hasPrev: boolean;
  /** 这一帧推进时用的图层世界矩阵 `W`（16 个 f32；脚本 `setBoneTransform` 求 `W⁻¹·M` 用，P12d-2）。 */
  readonly layerWorld: Float32Array;
  /** 工作格：物理之前的 `W·Pose[i]`、物理增量 `D`、`Pose[i]·D` 的结果。 */
  readonly mw: Float32Array;
  readonly delta: Float32Array;
  readonly temp: Float32Array;
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

/** 物理运行时（P12d-1）：每根开物理的骨骼一份状态，`prev` 首帧为空。 */
function physicsRuntime(params: readonly (BonePhysics | null)[], bones: number): PhysicsRuntime {
  return {
    params,
    active: params.some((item) => item),
    states: params.map((item) => (item ? createBoneState() : null)),
    prev: new Float32Array(bones * 16),
    cur: new Float32Array(bones * 16),
    hasPrev: false,
    layerWorld: new Float32Array(16),
    mw: new Float32Array(16),
    delta: new Float32Array(16),
    temp: new Float32Array(16),
  };
}

/**
 * 建一层（加载 `animationlayers` 与运行时建层共用，WPE 同一个函数 `FUN_1401fcc20`）：时钟按动画自己的模式，t = 0、在播放、没有 SETFRAME；
 * blendout 只在 single 有效：非 single 的动画直接清掉（`0x1401fd068`，rea-RT 1.4，运行时建层同样发生，rea-p12e 2）。
 */
function buildLayer(id: number, def: PuppetLayerDef, animation: PuppetAnimation): LayerRuntime {
  const clock = layerClock(animation.fps, animation.length, animation.mode, animation.events);
  let flags = (def.additive ? LAYER_ADDITIVE : 0) | (def.blendin ? LAYER_BLENDIN : 0);
  if (def.blendout && clock.flags & SINGLE) flags |= LAYER_BLENDOUT;
  return {
    id,
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
    this.add(list);
  }

  /**
   * 追加运行时（L3b，构造也走这里）：同构造的规则——只收 skinned 的，建好按 t = 0 算一次姿势（不推进）。排在已有的后面（`frame` 的遍历顺序）。
   * 同一对象已有运行时时由调用方先 `remove`（替换）；不先摘会留下两份、`byObject` 指向新的。
   */
  add(list: readonly { object: number; puppet: PuppetRig; kind?: "image" | "model" }[]): void {
    for (const { object, puppet, kind = "image" } of list) {
      const skeleton = puppet.skeleton;
      if (!skeleton) continue;
      const bones = skeleton.parents.length;
      const layers = puppet.layers.map((def) => buildLayer(def.entry, def, puppet.animations[def.animation]));
      const orderInfo = kind === "image" && puppet.order?.dynamic ? puppet.order : null;
      let drawOrder: DrawOrderRuntime | null = null;
      if (orderInfo) {
        const file = fileIndices(puppet.mesh?.indices ?? new Uint8Array(0));
        drawOrder = {
          nodes: orderInfo.nodes,
          records: orderInfo.records,
          base: orderInfo.base,
          file,
          cur: new Float32Array(orderInfo.base.length),
          // 初值 = 组表顺序（加载时不排序）；索引 = 文件原样（不是按 order 拼接），命令表 = 编译期那份
          order: Int32Array.from(orderInfo.nodes, (_, index) => index),
          keys: new Int32Array(orderInfo.nodes.length),
          version: 0,
          indices: file,
          clipping: puppet.clipping ?? null,
        };
      }
      const runtime: PuppetRuntime = {
        object,
        kind,
        puppet,
        skeleton,
        bones,
        layers,
        byId: new Map(layers.map((layer) => [layer.id, layer])),
        detached: [],
        destroyedEntries: new Set(),
        nextId: -1,
        anyEnded: false,
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
        // 图像层 puppet 都有两份世界骨骼缓冲（脚本读写的 `P+0x340`，P12d-2）；有没有物理骨骼看 `active`
        physics: kind === "image" ? physicsRuntime(skeleton.physics ?? [], bones) : null,
        drawOrder,
      };
      this.runtimes.push(runtime);
      this.byObject.set(object, runtime);
      this.evaluate(runtime, null, null);
    }
  }

  /** 摘掉这些对象的运行时（L3b）：之后 `skin` / `pose` 等读它们的都是 null，摘出还没释放的层随运行时一起丢（字段脚本已由宿主清）。 */
  remove(objects: ReadonlySet<number>): void {
    if (objects.size === 0) return;
    let write = 0;
    for (const runtime of this.runtimes) {
      if (objects.has(runtime.object)) {
        if (this.byObject.get(runtime.object) === runtime) this.byObject.delete(runtime.object);
        continue;
      }
      this.runtimes[write++] = runtime;
    }
    this.runtimes.length = write;
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
   * 静止捷径（没有可见层、上次也是静止、没有物理骨骼）下的世界骨骼矩阵：蒙皮不重算，但有 `W` 的推进帧照样交换缓冲、对全部骨骼写 `W·world[i]`。
   * `refresh`（`d` 为 null）与没有 `W` 的帧什么都不做。
   */
  private restWorldBones(runtime: PuppetRuntime, d: number | null, state: PuppetSink | null): void {
    const physics = runtime.physics;
    const layerWorld = physics && d !== null ? (state?.world?.(runtime.object) ?? null) : null;
    if (!physics || !layerWorld) return;
    physics.layerWorld.set(layerWorld);
    [physics.prev, physics.cur] = [physics.cur, physics.prev];
    for (let bone = 0; bone < runtime.bones; bone++)
      mulFull(layerWorld, 0, runtime.world, bone * 16, physics.cur, bone * 16);
    physics.hasPrev = true;
  }

  /**
   * 脚本选骨（rea-p12d-bones 3、5）：数字按下标（整数、`0 ≤ i < 骨骼数`），字符串按名字取第一个全名匹配；第一次更新之前（还没有世界骨骼矩阵）一律失败。
   * 空串：`emptyIsFirst` 为真（冲量与复位）落到骨骼 0，否则（读写矩阵）失败。失败返回 −1。
   */
  private selectBone(runtime: PuppetRuntime, bone: number | string, emptyIsFirst: boolean): number {
    if (!runtime.physics?.hasPrev) return -1;
    if (typeof bone === "number") return Number.isInteger(bone) && bone >= 0 && bone < runtime.bones ? bone : -1;
    if (bone === "") return emptyIsFirst && runtime.bones > 0 ? 0 : -1;
    // 骨骼名只图像层 puppet（`ScenePuppet.names`）有；模型对象没有这些脚本方法，`physics` 为 null 时到不了这里
    const names = (runtime.puppet as Partial<Pick<ScenePuppet, "names">>).names ?? [];
    for (let i = 0; i < runtime.bones && i < names.length; i++) if (names[i] === bone) return i;
    return -1;
  }

  /**
   * 脚本 `getBoneTransform`（WPE `P+0x340[i]`，`W·Pose`，物理之后）：16 个 f32 的拷贝；不是图像层 puppet、没推进过、选骨失败时为 null（API 换成单位阵）。
   */
  boneTransform(object: number, bone: number | string): Float32Array | null {
    const runtime = this.byObject.get(object);
    if (!runtime?.physics) return null;
    const i = this.selectBone(runtime, bone, false);
    return i < 0 ? null : runtime.physics.cur.slice(i * 16, i * 16 + 16);
  }

  /**
   * 脚本 `setBoneTransform`（rea-p12d-bones 4）：写三处，`cur[i] = M`、模型空间 `world[i] = W⁻¹·M`（`W` 取这一帧推进时用的）、蒙皮 `skin[i] = world[i]·绑定逆`
   * （WPE 这里两次都是完整 4×4 乘法）。子骨骼与物理状态不动，所以当帧只有这根骨骼的画面变，下一帧全部重算、`M` 只作为物理的 `prev` 留下。
   * 选骨失败、`m` 不足 16 个数时什么都不做。
   */
  setBoneTransform(object: number, bone: number | string, m: ArrayLike<number>): void {
    const runtime = this.byObject.get(object);
    const physics = runtime?.physics;
    if (!runtime || !physics || m.length < 16) return;
    const i = this.selectBone(runtime, bone, false);
    if (i < 0) return;
    const matrix = Float32Array.from(m as ArrayLike<number>).subarray(0, 16);
    physics.cur.set(matrix, i * 16);
    const inverse = new Float32Array(16);
    inverse4(physics.layerWorld, 0, inverse, 0);
    mulFull(inverse, 0, matrix, 0, physics.temp, 0);
    runtime.world.set(physics.temp, i * 16);
    mulFull(runtime.world, i * 16, runtime.skeleton.inverseBind, i * 16, physics.temp, 0);
    const t = physics.temp;
    runtime.skin.set([t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10], t[12], t[13], t[14]], i * SKIN_STRIDE);
    // 蒙皮被改过：静止捷径不能再跳过下一帧的重算（WPE 下一帧交换后全部重算）
    runtime.restSkin = false;
  }

  /**
   * 脚本 `applyBonePhysicsImpulse`（rea-p12d-bones 5）：`vel += dir`、`q ⊗= eulerQuat(ang·DEG·0.5)`；不看物理开关，但没开物理的骨骼没有状态，空操作
   * （WPE 写了也不起作用）。空串落到骨骼 0；第一次更新之前、越界什么都不做。
   */
  applyBonePhysicsImpulse(object: number, bone: number | string, dir: ArrayLike<number>, ang: ArrayLike<number>): void {
    const runtime = this.byObject.get(object);
    if (!runtime?.physics) return;
    const i = this.selectBone(runtime, bone, true);
    const state = i < 0 ? null : runtime.physics.states[i];
    if (state) applyBoneImpulse(state, dir, ang);
  }

  /** 脚本 `resetBonePhysicsSimulation`：选骨同冲量（空串 = 骨骼 0，不是全部），状态置初值，不清 `prev`。 */
  resetBonePhysicsSimulation(object: number, bone: number | string): void {
    const runtime = this.byObject.get(object);
    if (!runtime?.physics) return;
    const i = this.selectBone(runtime, bone, true);
    const state = i < 0 ? null : runtime.physics.states[i];
    if (state) resetBoneState(state);
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
    // 本帧没有层播完不进循环（WPE 的 anyEnded；漏扫的层带着 ENDED 位等以后某一帧，rea-p12e 实测 9）
    if (!runtime.anyEnded) return;
    runtime.anyEnded = false;
    const layers = runtime.layers;
    for (let i = 0; i < layers.length; i++) {
      // 下标循环、每轮重读层数：回调里会建删层
      const layer = layers[i];
      const clock = layer.clock;
      if (!(clock.flags & ENDED)) continue;
      clock.flags = (clock.flags & ~ENDED) >>> 0;
      // 单次层先标删再调回调（回调里 play / setFrame 救不回，`0x140200371`）
      if (clock.flags & SINGLE_SHOT) clock.flags = (clock.flags | DOOMED) >>> 0;
      if (layer.callbacks.length) {
        for (const callback of [...layer.callbacks]) callback();
        // 调过回调的层把循环下标复位成 0（`0x1402002f6` / 模型 `0x14021ce69`），`++` 后从 1 重扫：前面被漏掉的层这一轮不再处理
        i = 0;
      }
    }
    // 删 DOOMED 的层并当场释放（同一帧之后的脚本看到作废）；回调里已 destroyAnimationLayer 的层在 detached，由 settle 释放，不会重复
    for (let i = 0; i < layers.length; i++)
      if (layers[i].clock.flags & DOOMED) this.release(runtime, layers.splice(i--, 1)[0], hooks);
  }

  /** 释放一层：从 id 表摘掉（包装从此作废）、丢控制口、通知宿主。 */
  private release(runtime: PuppetRuntime, layer: LayerRuntime, hooks: PuppetHooks | null): void {
    runtime.byId.delete(layer.id);
    layer.control = null;
    runtime.restSkin = false;
    hooks?.released?.(runtime.object, layer.id);
  }

  /** skinned puppet / 带骨骼模型的动画层数；别的对象为 0（P12c）。 */
  layerCount(object: number): number {
    return this.byObject.get(object)?.layers.length ?? 0;
  }

  /** 层表的 id（顺序）；不是带骨骼的运行时为空数组（P12e）。 */
  ids(object: number): readonly number[] {
    return this.byObject.get(object)?.layers.map((layer) => layer.id) ?? [];
  }

  /** 控制口（按 id，含摘出未释放的）；没有这个 id 为 null（P12e，取代按下标的 `layer`）。 */
  control(object: number, id: number): PuppetLayerControl | null {
    const layer = this.byObject.get(object)?.byId.get(id);
    if (!layer) return null;
    return (layer.control ??= layerControl(layer));
  }

  /** 这个 id 的层还没被释放（包装是否有效，P12e）。 */
  alive(object: number, id: number): boolean {
    return this.byObject.get(object)?.byId.has(id) ?? false;
  }

  /** 按**当前**名字找层：最后一个匹配，空串不匹配，返回 id，找不到 null（P12c 的规则，P12e 起返回 id；`getAnimationLayer("名字")`）。 */
  findLayer(object: number, name: string): number | null {
    const layers = this.byObject.get(object)?.layers;
    if (!layers || name === "") return null;
    for (let index = layers.length - 1; index >= 0; index--) if (layers[index].name === name) return layers[index].id;
    return null;
  }

  /** 运行时的 rig（API 按名字找动画、查 unsupported 用；同一份 bundle）；不是带骨骼的运行时为 null（P12e）。 */
  rig(object: number): PuppetRig | null {
    return this.byObject.get(object)?.puppet ?? null;
  }

  /** 全部活着的层（含摘出还没释放的）的字段初值，供 `SceneState.syncAnimationLayers` 对齐（P12e）。 */
  *liveLayers(): Generator<{ object: number; id: number; def: PuppetLayerFields }> {
    for (const runtime of this.runtimes)
      for (const layer of runtime.byId.values()) yield { object: runtime.object, id: layer.id, def: layer.def };
  }

  /** 有运行时的对象下标（`SceneState.syncAnimationLayers` 只对齐这些对象；静态 puppet 没有运行时，P12e）。 */
  objects(): ReadonlySet<number> {
    return new Set(this.byObject.keys());
  }

  /** 摘出还没释放的层数（P12e，探针 / 测试看「摘了还没释放」）。 */
  detachedCount(object: number): number {
    return this.byObject.get(object)?.detached.length ?? 0;
  }

  /**
   * 运行时建层（WPE `FUN_1401fcc20` / 模型 `FUN_1402230c0` 的后半，rea-p12e 2）。不是带骨骼的运行时、动画下标越界或这条动画带 `unsupported` 返回 null。
   * - 时钟按动画自己的模式（`buildLayer`，带事件表），t = 0、在播放，没有 SETFRAME；`single` 为真（playSingleAnimation）时置 SINGLE_SHOT；
   * - 非 single 模式的动画清 blendout（`0x1401fd068`）；
   * - 插入（rea-p12c 第 7 节，实测 4）：autosort → 从尾往前跳过加法层，插在第一个非加法层之后；一个非加法层都没有（含空表）WPE 越界写，我们插到 0（有意不同）。
   *   否则 index 是数：0 插 0；`1 ≤ index ≤ n − 1` 插 index；其余（负数、≥ n − 1、超出 int）插 n − 1（最后一层之前）；空表一律插 0（WPE 对非 0 越界，有意不同）。
   *   都没有 → 追加；
   * - 分配 id = nextId--。
   */
  createLayer(object: number, item: AnimationLayerItem, single: boolean): number | null {
    const runtime = this.byObject.get(object);
    const animation = runtime?.puppet.animations[item.animation];
    if (!runtime || !animation || animation.unsupported) return null;
    const id = runtime.nextId--;
    const def: PuppetLayerDef = {
      animation: item.animation,
      entry: id,
      name: item.name,
      rate: item.rate,
      blend: item.blend,
      visible: item.visible,
      additive: item.additive,
      blendin: item.blendin,
      blendout: item.blendout,
      blendtime: item.blendtime,
      bindings: [],
    };
    const layer = buildLayer(id, def, animation);
    if (single) layer.clock.flags = (layer.clock.flags | SINGLE_SHOT) >>> 0;
    const layers = runtime.layers;
    const n = layers.length;
    let position = n;
    if (item.autosort) {
      position = n;
      while (position > 0 && layers[position - 1].flags & LAYER_ADDITIVE) position--;
    } else if (item.index !== null) {
      const index = item.index;
      position = index === 0 ? 0 : index >= 1 && index <= n - 1 ? index : Math.max(n - 1, 0);
    }
    layers.splice(position, 0, layer);
    runtime.byId.set(id, layer);
    runtime.restSkin = false;
    return id;
  }

  /**
   * destroyAnimationLayer（rea-p12e 第 5 节）：`selector` 已由 API 规整。命中的层当场从层表摘掉（计数、下标、名字查找立刻看不到），进 `detached`、
   * 仍在 `byId`；编译期层的 id 记进 `destroyedEntries`。名字删全部同名（区分大小写，空串不匹配；图像层 WPE 在最后一层匹配时崩溃，我们照删，有意不同）；
   * 下标要 `0 ≤ i < 层数`；id 要在当前层表里（摘出未释放的、别的 puppet 的都不算）。返回是否删了至少一个。
   */
  destroyLayers(object: number, selector: { name: string } | { index: number } | { id: number }): boolean {
    const runtime = this.byObject.get(object);
    if (!runtime) return false;
    const layers = runtime.layers;
    const hit: LayerRuntime[] = [];
    if ("name" in selector) {
      if (selector.name === "") return false;
      for (const layer of layers) if (layer.name === selector.name) hit.push(layer);
    } else if ("index" in selector) {
      const index = selector.index;
      if (Number.isInteger(index) && index >= 0 && index < layers.length) hit.push(layers[index]);
    } else {
      const layer = layers.find((item) => item.id === selector.id);
      if (layer) hit.push(layer);
    }
    for (const layer of hit) {
      layers.splice(layers.indexOf(layer), 1);
      runtime.detached.push(layer);
      if (layer.id >= 0) runtime.destroyedEntries.add(layer.id);
    }
    if (hit.length) runtime.restSkin = false;
    return hit.length > 0;
  }

  /** 释放全部 `detached`（WPE `FUN_14018b390` 尾调排空 `ctx+0x1478`）：全部脚本之后、渲染之前每帧调；逐个 `release`。 */
  settle(hooks?: PuppetHooks | null): void {
    for (const runtime of this.runtimes)
      if (runtime.detached.length)
        for (const layer of runtime.detached.splice(0)) this.release(runtime, layer, hooks ?? null);
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
   * 当前绘制顺序（P12f）：`version` 每次真的重排时 +1（没重排过为 0）、`indices` 是按当前顺序拼的整张网格 u16 索引（没重排过是文件顺序）、`clipping` 是按当前顺序建的
   * 命令表（没有 v23 记录为 null，没重排过是编译期那份）。不是图像层 puppet、网格 0 没有 bit3（不会重排）的对象为 null。返回的对象跨帧是同一个，字段原地换新。
   */
  drawOrder(object: number): {
    readonly version: number;
    readonly indices: Uint16Array;
    readonly clipping: Pick<NonNullable<ScenePuppet["clipping"]>, "commands" | "segments"> | null;
  } | null {
    return this.byObject.get(object)?.drawOrder ?? null;
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
   * 本帧的世界骨骼矩阵 `W·Pose[i]`（物理之后，每骨骼 16 个 f32，WPE 的 `P+0x340`；脚本 `getBoneTransform` 读它、`setBoneTransform` 写它，写进去的在下一帧
   * 交换后成为物理的 `prev`，P12d-2）。每帧推进时对**全部**骨骼写；不是图像层 puppet 的对象为 null；宿主没给 `W` 的帧保持上一帧的值。返回的数组每帧原地改写（交换时换底层缓冲，
   * 不要长期持有）。
   */
  worldBones(object: number): Float32Array | null {
    return this.byObject.get(object)?.physics?.cur ?? null;
  }

  /** 骨骼物理状态（每骨骼一份，没开物理的为 null）；没有物理骨骼的对象为 null（P12d-1，测试与探针读）。 */
  physicsStates(object: number): readonly (BoneState | null)[] | null {
    const physics = this.byObject.get(object)?.physics;
    return physics?.active ? physics.states : null;
  }

  /**
   * 重编译时接回上一份（同 P10：WPE 改属性不重载场景，动画层时钟、播放状态与 blendin 的清位都在）：按 (对象下标, 层 id) 找，动画的
   * fps / 长度 / 模式相同时拷时钟的 `t` 与整份运行时位（含 `SINGLE_SHOT` / `DOOMED` / 漏扫留下的 `ENDED`），以及 blendin 是否已清。找不到的从 0 开始。
   * P12e：新层表的顺序 = 上一份层表的顺序；运行时建的层（负 id）按新 rig 里同一条动画（MDLA id 相同）重建、动画的 fps / 长度 / 模式变了就丢掉；删过的编译期层
   * （`destroyedEntries`）不回来；上一份没有的编译期层（新 bundle 才有）按 bundle 顺序追加；`nextId` 保留。只在新建之后、
   * 第一次 `frame` 之前调一次；之后调 `refresh` 让蒙皮跟上。
   */
  carryOver(previous: ScenePuppets | null): void {
    if (!previous || previous === this) return;
    for (const runtime of this.runtimes) {
      const before = previous.byObject.get(runtime.object);
      if (!before) continue;
      // `g_BlendMap` 是跨帧的持久状态（WPE 改属性不重载，`P+0x350` 不变），重编译时保留这 16 个 float
      if (runtime.blendMap && before.blendMap) runtime.blendMap.set(before.blendMap);
      // 绘制顺序（P12f）：WPE 运行中改属性不重置节点顺序（`p12f-rebuild` 实测），所以节点表相同（mdl 没换）时接回当前顺序、按它重拼输出，version 接着旧的 +1；
      // 不同（换了 mdl，WPE 运行中不会发生）从组表顺序重来。`cur` 不接（每帧复位）。「清空脚本存储」时调用方不 carryOver，顺序随之回到组表顺序
      const newOrder = runtime.drawOrder;
      const oldOrder = before.drawOrder;
      if (newOrder && oldOrder && sameDrawNodes(newOrder, oldOrder)) {
        newOrder.order.set(oldOrder.order);
        newOrder.version = oldOrder.version + 1;
        rebuildDrawOutput(newOrder);
      }
      // 物理状态与 `prev`（P12d-1，同样是跨帧的持久状态）：骨骼数相同时按下标接回
      const physics = runtime.physics;
      const old = before.physics;
      if (physics && old && physics.states.length === old.states.length) {
        physics.states.forEach((state, bone) => {
          const was = old.states[bone];
          if (!state || !was) return;
          state.q.set(was.q);
          state.ang.set(was.ang);
          state.off.set(was.off);
          state.vel.set(was.vel);
        });
        physics.prev.set(old.prev);
        physics.cur.set(old.cur);
        physics.hasPrev = old.hasPrev;
        physics.layerWorld.set(old.layerWorld);
      }
      // 一层接回上一份的状态；动画的 fps / 长度 / 模式变了（spec 不同）时不接，返回 false
      const adopt = (layer: LayerRuntime, old: LayerRuntime): boolean => {
        const a = layer.clock;
        const b = old.clock;
        if (a.spf !== b.spf || a.D !== b.D || layer.length !== old.length || (a.flags & 3) !== (b.flags & 3))
          return false;
        a.t = b.t;
        // 整份运行时位（模式位已比过相等）：`SINGLE_SHOT` / `DOOMED` / 漏扫留下的 `ENDED` 也接得上，原来的掩码是它的子集
        a.flags = b.flags >>> 0;
        // 五个可写字段与回调表（P12c，WPE 改属性不重载，脚本写过的都还在）：additive / blendin / blendout 三位原样接回（blendin 是否已清也在里面）
        const writable = LAYER_ADDITIVE | LAYER_BLENDIN | LAYER_BLENDOUT;
        layer.flags = (layer.flags & ~writable) | (old.flags & writable);
        layer.name = old.name;
        layer.blendtime = old.blendtime;
        layer.callbacks = old.callbacks;
        layer.control = null;
        return true;
      };
      const fresh = new Map(runtime.layers.map((layer) => [layer.id, layer]));
      const table: LayerRuntime[] = [];
      for (const old of before.layers) {
        let layer: LayerRuntime | undefined;
        if (old.id >= 0) {
          layer = fresh.get(old.id);
          if (layer) adopt(layer, old);
        } else {
          // 运行时建的层：按新 rig 里同一条动画（MDLA id 相同、没有 unsupported）重建
          const index = runtime.puppet.animations.findIndex((item) => item.id === old.animation.id);
          const animation = runtime.puppet.animations[index];
          if (animation && !animation.unsupported) {
            const rebuilt = buildLayer(old.id, { ...old.def, animation: index }, animation);
            if (adopt(rebuilt, old)) layer = rebuilt;
          }
        }
        fresh.delete(old.id);
        if (layer) table.push(layer);
      }
      for (const id of before.destroyedEntries) {
        // 删过的编译期层不回来
        fresh.delete(id);
        runtime.destroyedEntries.add(id);
      }
      for (const layer of fresh.values()) table.push(layer);
      runtime.layers.splice(0, runtime.layers.length, ...table);
      runtime.byId.clear();
      for (const layer of table) runtime.byId.set(layer.id, layer);
      // 摘出还没释放的层：换场景发生在帧与帧之间，上一帧的 settle 已跑过，按理为空；不空就照接
      for (const layer of before.detached) {
        runtime.detached.push(layer);
        runtime.byId.set(layer.id, layer);
      }
      runtime.nextId = before.nextId;
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
    // 绘制顺序（P12f）：只在真的推进时复位 / 写 / 排（`refresh` 不是 WPE 的更新）；`cur` 每帧先复位成骨骼基数（`0x1401fec12`，循环到基数数组的长度）
    const order = d !== null ? runtime.drawOrder : null;
    let wrote = false;
    if (order) for (let i = 0; i < order.base.length; i++) order.cur[i] = order.base[i];
    for (const layer of runtime.layers) {
      const fields = state?.animationLayer(runtime.object, layer.id) ?? layer.def;
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
          if (ended) {
            clock.flags = (clock.flags | ENDED) >>> 0;
            runtime.anyEnded = true;
          }
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
      // 绘制顺序轨道：可见层都写（不看权重、暂停与停在末帧照写），只取 lo 帧；叠法判断同 TRS（`blendInto` 的 `!additive && w === 1` 为覆盖）
      if (order && track.drawOrder)
        wrote =
          blendDrawOrder(
            order.cur,
            order.base,
            track.drawOrder,
            track.drawOrderMask ?? EMPTY_MASK,
            bones,
            at.lo,
            w,
            additive ? "add" : w === 1 ? "override" : "mix",
          ) || wrote;
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
    // 有物理骨骼的运行时不走静止捷径：状态每帧在变（P12d-1）
    if (!posed) {
      if (runtime.restSkin && !runtime.physics?.active) {
        // 静止捷径只省掉蒙皮重算：世界骨骼矩阵每帧照写（脚本 `getBoneTransform` 要跟着图层移动，P12d-2）
        this.restWorldBones(runtime, d, state);
        return;
      }
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
    // 骨骼物理（P12d-1）：只在推进时（`refresh` 不是 WPE 的更新），且宿主给了图层的世界矩阵
    const physics = runtime.physics;
    const layerWorld = physics && d !== null ? (state?.world?.(runtime.object) ?? null) : null;
    if (physics && layerWorld) {
      const scale = layerScale(layerWorld);
      physics.layerWorld.set(layerWorld);
      // 推进开头交换 `P+0x340` / `P+0x348`：上一帧的 `cur`（含脚本 `setBoneTransform` 之后的写入）成了这一帧的 `prev`；`cur` 之后每根骨骼各写一次，
      // 不再拷贝。`W` 为 null（sink 没给、`refresh`）时整段不做：不交换、不写 `cur`、物理不跑
      [physics.prev, physics.cur] = [physics.cur, physics.prev];
      skinMatrices(posed ? pose : null, skeleton, runtime.world, runtime.skin, (bone) =>
        this.physicsBone(runtime, physics, layerWorld, scale, d!, bone),
      );
      physics.hasPrev = true;
    } else skinMatrices(posed ? pose : null, skeleton, runtime.world, runtime.skin);
    // 重排在蒙皮之后（`0x140205507`）：本帧有层写过才重算键；当前顺序已非降序什么都不做，否则稳定排序并重拼索引与命令表
    if (order && wrote && reorder(order.order, order.nodes, order.cur, order.keys)) {
      order.version += 1;
      rebuildDrawOutput(order);
    }
    runtime.restSkin = !posed;
  }

  /**
   * 一根骨骼的物理（`skinMatrices` 的回调，`world[bone]` 刚算完、还是动画姿势，rea-AP 2.2 第 5 步）：`cur[bone] = W·Pose[bone]`；开了物理且有 `prev`
   * 时解一次，`Pose[bone] ← Pose[bone]·D`，`cur[bone]` 取改过之后的。
   */
  private physicsBone(
    runtime: PuppetRuntime,
    physics: PhysicsRuntime,
    layerWorld: Float32Array,
    scale: number,
    dt: number,
    bone: number,
  ): void {
    const { world } = runtime;
    const { mw, delta, temp, cur, prev } = physics;
    mulFull(layerWorld, 0, world, bone * 16, mw, 0);
    const params = physics.params[bone];
    const state = physics.states[bone];
    if (
      params &&
      state &&
      physics.hasPrev &&
      solveBone(params, state, mw, prev.subarray(bone * 16, bone * 16 + 16), scale, dt, delta)
    ) {
      mulAffine(world, bone * 16, delta, 0, temp, 0);
      world.set(temp, bone * 16);
      mulFull(layerWorld, 0, world, bone * 16, mw, 0);
    }
    cur.set(mw, bone * 16);
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
    runtime.layers.forEach((layer) => {
      const fields = state?.animationLayer(runtime.object, layer.id) ?? layer.def;
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

/** 图层世界矩阵三列长度的平均（`((|c1| + |c0|) + |c2|) / 3`，z 列也算，`0x1402004d2`，p12-REPORT 1.4 实测）。 */
function layerScale(world: Float32Array): number {
  const column = (c: number) =>
    f(
      Math.sqrt(
        f(
          f(f(world[4 * c] * world[4 * c]) + f(world[4 * c + 1] * world[4 * c + 1])) +
            f(world[4 * c + 2] * world[4 * c + 2]),
        ),
      ),
    );
  return f(f(f(column(1) + column(0)) + column(2)) / 3);
}
