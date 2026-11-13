/**
 * 场景属性关键帧动画的播放器（P10a 步骤 3）：持有一份 bundle 的全部动画时钟，宿主在渲染器每个实时帧的 `beforeFrame` 里、脚本之前调
 * `frame(dt, state)`：推进时钟、求值、经 `SceneState.write` 写进状态（同脚本写回），收下本帧越过的事件。纯 TS，不依赖 GPU。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md` 步骤 3；语义见 `rea-p10-keyframes.md`：
 * - 第 1 节第 3 条（动画循环，`FUN_140171440` 的 `0x140172370` 起）：按登记顺序逐条走；时钟主人 C = 父 ?? 自己，C 本帧没推进过就推进一次
 *   （`C+0x88` 记帧号），推进量 `rate × dt`（float32 `mulss`）；求值用 C 的 `t` / `spf` / `length`、自己的通道；只有有效位为真的写字段，
 *   时钟照走、事件照收；
 * - 第 4 节：暂停（`startpaused`、`pause()`）的时钟不走，但每帧照常求值、写值，显示的是当前时刻的值，不是 `value`；
 * - 第 7 节：子动画完全借父的时钟（时间、帧长、`spf`、模式、暂停位、父的 `rate`），子的关键帧按父的帧号解读；
 * - 第 9 节：一帧里动画先写、脚本后写，下一帧动画再覆盖；
 * - 第 12 节：对象不可见照常推进、写值；属性改动不重载，动画时间不变（重编译由 `carryOver` 接回）。
 */
import { scriptWriteValue, type SceneState } from "../render/state";
import { BACK, DONE, MIRROR, PAUSED, SINGLE, AnimationClock } from "./clock";
import { Channel, frameValues, type ParsedKey } from "./curve";
import type { AnimationClockParams, AnimationEventDef, AnimationEventRecord, SceneAnimation } from "./types";

const f = Math.fround;

/** 保留最近这么多次 `frame()` 的耗时（探针读）。 */
const FRAME_SAMPLES = 600;
/** 整数帧缓存预分配的上限（帧）：更长的按需扩（`Channel.sample`），免得 `length` 很大时一上来就分配一大块。 */
const PREALLOCATED_FRAMES = 1 << 16;

/** 写入落点：`SceneState` 的 `write`（测试可以换成记录调用的替身）。 */
export type AnimationSink = Pick<SceneState, "write">;

/**
 * 写过声音对象 `volume` 之后当场回调（参数是 `objects` 下标）。WPE 的 setter 写值时当场调改值回调改音量（rea-p6a-sound.md 5.2）；
 * 宿主在这里把状态里的新值推给排期器（同 `writeScript`），否则要等下一帧的对象步进（它在 `beforeFrame` 之前）才读到，晚一帧。
 */
export type AnimationSoundHook = (object: number) => void;

/** 探针读到的一条动画（`host.animations()`、`renderFrame` 的 `animations`）。 */
export interface AnimationProbeEntry {
  /** `scene.json` 路径（`SceneAnimation.id`）。 */
  id: string;
  /** 时钟主人的下标（有效的父，否则自己）。下面四项都取主人的时钟。 */
  owner: number;
  /** 时钟的时间（秒，float32）。 */
  t: number;
  /** `getFrame()`：`t / spf`，带小数。 */
  frame: number;
  /** `isPlaying()`：暂停位与结束位都没置。 */
  playing: boolean;
  /** 时钟的标志（无符号 32 位：模式、`PAUSED` / `DONE` / `BACK`）。 */
  flags: number;
  /** 编译期的 `writes`（通道数与类型合法）。 */
  writes: boolean;
  /** 目标的种类（`BindingTarget.kind`）。 */
  target: string;
  /** 最后一次写进状态的值（每通道一个），从没写过（`writes` 为假、目标不能就地写、还没到第一帧）时为 null。 */
  value: number[] | null;
}

export interface AnimationsProbe {
  /** 最近 600 次 `frame()` 的耗时（毫秒，均值与 p95，保留 4 位小数）与次数。 */
  frameMs: { mean: number; p95: number; count: number };
  list: AnimationProbeEntry[];
}

/** 没有播放器（还没加载、退回预览图、销毁后）时探针给的空结果。 */
export const EMPTY_ANIMATIONS_PROBE: AnimationsProbe = Object.freeze({
  frameMs: Object.freeze({ mean: 0, p95: 0, count: 0 }),
  list: Object.freeze([]) as unknown as AnimationProbeEntry[],
}) as AnimationsProbe;

/** 一条动画的运行期数据。 */
interface Track {
  readonly def: SceneAnimation;
  /** 每个 `cN` 一条；`carryOver` 时关键帧相同的换成旧的（保留整数帧缓存）。 */
  channels: Channel[];
  /** 时钟主人的下标：`def.parent` 是有效的父（在列表里、自己没有父）时取它，否则自己。 */
  readonly owner: number;
  /** 自己是主人时的时钟；有父的为 null（借父的）。 */
  readonly clock: AnimationClock | null;
  /**
   * 速率（`IAnimation.rate`，WPE 在包装对象 W 的 `+0xd0`，缺省 1，不钳制）：只在主人上有意义，推进量是主人的 `rate × dt`。
   * P10a 恒为 1，P10b 的 `IAnimation` 包装对象改它。
   */
  rate: number;
  /** 上一次推进时 `frame()` 的序号（WPE `C+0x88`）：每个时钟每帧只推进一次。 */
  advancedAt: number;
  /** 求值缓冲（每通道一格），预分配；写入后就是最后写入的值。 */
  readonly values: Float32Array;
  /** `values` 是写进状态的值（探针读）。 */
  written: boolean;
  /** 会不会写：`def.writes`，且目标能就地写（见 `writable`）。 */
  readonly active: boolean;
}

/**
 * 目标能不能就地写。`recompile` / `unsupported` / `script-property` 一律不写：编译期已对前两种报细分键、不进列表，只有 dev 强制渲染或
 * 手写的 bundle 会走到这里；动画从不触发重编译（WPE 改属性不重载）。
 */
function writable(target: SceneAnimation["target"]): boolean {
  const kind: string = target.kind;
  return kind !== "recompile" && kind !== "unsupported" && kind !== "script-property";
}

/** 时钟主人的下标：父必须在列表里、不是自己、自己没有父（只有一层，读码第 7 节）；否则用自己的时钟。 */
function ownerOf(list: readonly SceneAnimation[], index: number): number {
  const parent = list[index].parent;
  if (parent === null || !Number.isInteger(parent) || parent === index) return index;
  const item = list[parent];
  return item && item.parent === null ? parent : index;
}

function sameKeys(a: readonly ParsedKey[], b: readonly ParsedKey[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.frame !== y.frame ||
      x.value !== y.value ||
      x.flags !== y.flags ||
      x.bx !== y.bx ||
      x.by !== y.by ||
      x.fx !== y.fx ||
      x.fy !== y.fy
    )
      return false;
  }
  return true;
}

/** 两份时钟参数能不能接：`fps`、`length`、`mode` 都相同（`startpaused` 不看，flags 整个拷）。 */
function sameClock(a: AnimationClockParams, b: AnimationClockParams): boolean {
  return a.fps === b.fps && a.length === b.length && a.mode === b.mode;
}

export class SceneAnimations {
  private readonly tracks: Track[];
  /** `frame()` 的序号，从 1 起（`Track.advancedAt` 初值 0）。 */
  private serial = 0;
  /** `advance` 的临时输出，复用。 */
  private readonly scratch: AnimationEventDef[] = [];
  /**
   * 本帧推进时收到的事件，按收集顺序（就是 WPE 的派发顺序）；每次 `frame()` 开头清空。P10a 只收不派发，P10b 派发
   * （WPE 在越过它的那条动画写完之后、下一条之前派发，读码第 8 节）。
   */
  readonly events: AnimationEventRecord[] = [];
  private readonly costs = new Float64Array(FRAME_SAMPLES);
  private costCount = 0;
  private costNext = 0;

  constructor(list: readonly SceneAnimation[]) {
    this.tracks = list.map((def, index) => {
      const owner = ownerOf(list, index);
      // 子的帧号上限是主人的 length（`hi ≤ len`），缓存按它预分配
      const frames = Math.min(Math.max(0, Math.trunc(list[owner].clock.length)) + 1, PREALLOCATED_FRAMES);
      return {
        def,
        channels: def.channels.map((keys) => new Channel(keys, frames)),
        owner,
        clock: owner === index ? new AnimationClock(def.clock, def.events) : null,
        rate: 1,
        advancedAt: 0,
        values: new Float32Array(def.channels.length),
        written: false,
        active: def.writes && writable(def.target),
      };
    });
  }

  /** 动画条数。 */
  get size(): number {
    return this.tracks.length;
  }

  /**
   * 一个实时帧（读码第 1 节第 3 条）：按列表顺序逐条，时钟主人本帧没推进过就推进 `f(f(rate) × f(dt))`（子排在父前面时第一次用到就推进
   * 父的，不晚一帧），收下事件；会写的按主人的时钟求值、写进 `state`。暂停、对象隐藏的照写。写声音的 `volume` 后调 `onSound`。
   */
  frame(dt: number, state: AnimationSink, onSound?: AnimationSoundHook): void {
    const started = performance.now();
    this.events.length = 0;
    const serial = ++this.serial;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const owner = tracks[track.owner];
      const clock = owner.clock!;
      if (owner.advancedAt !== serial) {
        owner.advancedAt = serial;
        const scratch = this.scratch;
        scratch.length = 0;
        clock.advance(f(f(owner.rate) * f(dt)), scratch);
        for (let e = 0; e < scratch.length; e++) this.events.push({ animation: track.owner, json: scratch[e].json });
      }
      if (track.active) this.writeTrack(track, clock, state, onSound);
    }
    this.costs[this.costNext] = performance.now() - started;
    this.costNext = (this.costNext + 1) % FRAME_SAMPLES;
    if (this.costCount < FRAME_SAMPLES) this.costCount++;
  }

  /**
   * 不推进，按当前时钟把会写的每条写一次。宿主换场景时在首帧之前调（暂停中重编译时首帧不跑 `beforeFrame`，不写的话先闪一下 `value`），
   * 探针 `seek` 之后调。不清事件。
   */
  write(state: AnimationSink, onSound?: AnimationSoundHook): void {
    for (const track of this.tracks)
      if (track.active) this.writeTrack(track, this.tracks[track.owner].clock!, state, onSound);
  }

  private writeTrack(track: Track, clock: AnimationClock, state: AnimationSink, onSound?: AnimationSoundHook): void {
    frameValues(clock, track.channels, track.values);
    const target = track.def.target;
    // 同脚本写回（类型化 setter，`scriptWriteValue`）；返回值不看：能到这里的目标都就地写，动画从不触发重编译
    state.write({ property: "", target }, scriptWriteValue(Array.from(track.values)));
    track.written = true;
    if (target.kind === "sound") onSound?.(target.object);
  }

  /**
   * 重编译时按 `id` 接回上一份（WPE 改属性不重载场景，动画时间、暂停状态与缓存都在，读码第 12 节）：
   * - 时钟：两边都是主人、`fps` / `length` / `mode` 相同时拷 `t` 与整个 `flags`（`PAUSED` / `DONE` / `BACK`，P10b 的 `pause()` 也跨重编译
   *   保留；`startpaused` 不同也照拷）以及 `rate`；
   * - 通道：关键帧逐项相同的复用旧的 `Channel`（整数帧缓存跟着来），不同的用新的；
   * - 找不到的（新出现的、参数变了的）从 0 开始，同 WPE 重开壁纸。
   * 只在新建之后、第一次 `frame` / `write` 之前调一次。
   */
  carryOver(previous: SceneAnimations | null): void {
    if (!previous || previous === this) return;
    const old = new Map(previous.tracks.map((track) => [track.def.id, track]));
    for (const track of this.tracks) {
      const before = old.get(track.def.id);
      if (!before) continue;
      track.channels = track.channels.map((channel, c) => {
        const prior = before.channels[c];
        return prior && sameKeys(prior.keys, channel.keys) ? prior : channel;
      });
      if (track.clock && before.clock && sameClock(track.def.clock, before.def.clock)) {
        track.clock.t = before.clock.t;
        track.clock.flags = before.clock.flags >>> 0;
        track.rate = before.rate;
      }
    }
  }

  /**
   * dev 探针：把每个没暂停的主人时钟直接设到「从 0 起播了 `time` 秒」的位置（float32）：
   * - `loop`：`fmodf(time, D)`；
   * - `mirror`：三角波，第奇数轮置 `BACK`、`t = D − fmodf(time, D)`，偶数轮清 `BACK`、`t = fmodf(time, D)`；
   * - `single`：钳到 `D`，到头置 `DONE`，没到头清 `DONE`。
   * `D ≤ 0` 的不动；`time` 不是正的有限数时按 0。这是近似：真实时钟是逐帧 float32 累加（舍入随帧时间累积，`single` 的结束帧、`mirror`
   * 的反射点可能差一帧），要和 WPE 逐帧比时用回放的 `dts` 逐帧 `frame`。不写状态，之后调 `write`。
   */
  seek(time: number): void {
    const at = Number.isFinite(time) && time > 0 ? f(time) : 0;
    for (const track of this.tracks) {
      const clock = track.clock;
      if (!clock || clock.flags & PAUSED || !(clock.D > 0)) continue;
      const D = clock.D;
      if (clock.flags & SINGLE) {
        if (at >= D) {
          clock.t = D;
          clock.flags = (clock.flags | DONE) >>> 0;
        } else {
          clock.t = at;
          clock.flags = (clock.flags & ~DONE) >>> 0;
        }
        continue;
      }
      const rest = f(at % D);
      if (!(clock.flags & MIRROR)) {
        clock.t = rest;
        continue;
      }
      // `at − rest` 是 D 的整数倍（`fmodf` 精确），除出来取整就是走过的轮数
      const rounds = Math.round((at - rest) / D);
      if (rounds % 2 === 1) {
        clock.t = f(D - rest);
        clock.flags = (clock.flags | BACK) >>> 0;
      } else {
        clock.t = rest;
        clock.flags = (clock.flags & ~BACK) >>> 0;
      }
    }
  }

  /** dev 探针：每条的时钟（取主人的）、最后写入的值，以及最近 600 次 `frame()` 的耗时。 */
  probe(): AnimationsProbe {
    const count = this.costCount;
    const samples = Array.from(this.costs.subarray(0, count)).sort((a, b) => a - b);
    const round = (value: number) => Math.round(value * 1e4) / 1e4;
    const mean = count ? samples.reduce((sum, value) => sum + value, 0) / count : 0;
    const p95 = count ? samples[Math.min(count - 1, Math.floor(count * 0.95))] : 0;
    return {
      frameMs: { mean: round(mean), p95: round(p95), count },
      list: this.tracks.map((track) => {
        const clock = this.tracks[track.owner].clock!;
        return {
          id: track.def.id,
          owner: track.owner,
          t: clock.t,
          frame: clock.getFrame(),
          playing: clock.isPlaying(),
          flags: clock.flags >>> 0,
          writes: track.def.writes,
          target: track.def.target.kind,
          value: track.written ? Array.from(track.values) : null,
        };
      }),
    };
  }
}
