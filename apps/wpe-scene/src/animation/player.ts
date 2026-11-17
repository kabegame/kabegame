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
 *
 * P10b（`phase-10b-script.md` 步骤 1）：
 * - 每条都有自己的时钟：子的从不推进（推进、求值仍只用主人的），但脚本控制（`control(id)`）作用在它自己的时钟上，不影响画面（读码第 7、11 节）；
 *   丢弃的动画（`inert`）用惰性时钟（`AnimationClock.inert`，步骤 0 Q7）；
 * - 事件在越过它的那一条写完（或不写）之后、下一条之前同步交给 `hooks.event`（读码第 8 节）；回调里可能对任意一条调 `control(...)` 的方法，
 *   所以派发前先把本条的事件拷出来，不持有会被改掉的中间状态。
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
  /** `options.name`（P10b）。 */
  name: string;
  /** 这一条的 `IAnimation.rate`（P10b，存在每条自己身上）。 */
  rate: number;
}

/** 探针记下的一个事件：`frame()` 的序号（从 1 起）加派发的内容。 */
export interface AnimationProbeEvent extends AnimationEventRecord {
  frame: number;
}

export interface AnimationsProbe {
  /** 最近 600 次 `frame()` 的耗时（毫秒，均值与 p95，保留 4 位小数）与次数。 */
  frameMs: { mean: number; p95: number; count: number };
  list: AnimationProbeEntry[];
  /** 最近 100 个派发过的事件（P10b，旧的在前）。 */
  events: AnimationProbeEvent[];
}

/** 没有播放器（还没加载、退回预览图、销毁后）时探针给的空结果。 */
export const EMPTY_ANIMATIONS_PROBE: AnimationsProbe = Object.freeze({
  frameMs: Object.freeze({ mean: 0, p95: 0, count: 0 }),
  list: Object.freeze([]) as unknown as AnimationProbeEntry[],
  events: Object.freeze([]) as unknown as AnimationProbeEvent[],
}) as AnimationsProbe;

/** 探针保留最近这么多个事件。 */
const EVENT_SAMPLES = 100;

/** `frame()` 的钩子（P10b）。 */
export interface AnimationHooks {
  /** 写过声音对象 `volume` 之后（P10a，见 `AnimationSoundHook`）。 */
  sound?: AnimationSoundHook;
  /** 主人的时钟本帧越过的一个事件：在越过它的那一条处理完之后、下一条之前同步调用（读码第 1 节第 3 条、第 8 节）。 */
  event?: (event: AnimationEventRecord) => void;
}

/**
 * `IAnimation` 的落点（P10b，读码第 11 节）：读写的都是这一条自己的时钟（子动画的脚本控制不影响画面，读码第 7 节）。
 * 包装对象（脚本侧，步骤 2）按 `id` 经 `SceneAnimations.control` 现取，不持有它。
 */
export interface AnimationControl {
  /** `IAnimation.rate`：存在这一条上（WPE `W+0xd0`，缺省 1，不钳制），写时转 float32；推进用的是主人的 rate。 */
  rate: number;
  /** `f(1 / spf)`。 */
  readonly fps: number;
  /** `length`（`asInt`）。 */
  readonly frameCount: number;
  /** `D`：一轮的时长（秒）。 */
  readonly duration: number;
  /** `options.name`。 */
  readonly name: string;
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  getFrame(): number;
  setFrame(frame: number): void;
}

/** 一条动画的运行期数据。 */
interface Track {
  readonly def: SceneAnimation;
  /** 每个 `cN` 一条；`carryOver` 时关键帧相同的换成旧的（保留整数帧缓存）。 */
  channels: Channel[];
  /**
   * 时钟主人的条目：`def.parent` 是有效的父（在同一批里、自己没有父）时取它，否则自己（L3b：记条目不记下标，增删之后不用重排）。
   * 建出来的那一刻先指向自己，`add` 在同批的条目都建好之后才换成父。
   */
  owner: Track;
  /** 条目已被 `removeObjects` 摘掉（L3b）：之前给出的控制对象据此作废，方法空操作、读值留在摘掉那一刻。 */
  dead: boolean;
  /**
   * 自己的时钟（P10b：每条都有）。自己是主人时由它推进、求值；有父的从不推进，求值用主人的，脚本控制（`control`）改的是这个。
   * 丢弃的（`def.inert`）是惰性时钟。
   */
  readonly clock: AnimationClock;
  /**
   * 速率（`IAnimation.rate`，WPE 在包装对象 W 的 `+0xd0`，缺省 1，不钳制）：推进量是主人的 `rate × dt`，所以只有主人上的有效果；
   * 子上的存着、读得回（`control`），不影响画面。
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

/** 时钟主人的下标（在这一批 `list` 里）：父必须在列表里、不是自己、自己没有父（只有一层，读码第 7 节）；否则用自己的时钟。 */
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

/**
 * 一条新条目接上同 `id` 的旧条目（`carryOver` 与 `replaceObjects` 共用）：关键帧逐项相同的通道复用旧的 `Channel`（整数帧缓存跟着来）；时钟参数相同时
 * 拷 `t`、整个 `flags` 与 `rate`。
 */
function carryTrack(track: Track, before: Track): void {
  track.channels = track.channels.map((channel, c) => {
    const prior = before.channels[c];
    return prior && sameKeys(prior.keys, channel.keys) ? prior : channel;
  });
  if (sameClock(track.def.clock, before.def.clock)) {
    track.clock.t = before.clock.t;
    track.clock.flags = before.clock.flags >>> 0;
    track.rate = before.rate;
  }
}

export class SceneAnimations {
  /** 条目按登记顺序：整场构造时是 `list` 的顺序，`add` 追加在尾（同整场重编译时新对象排在最后）。原地增删，不换引用。 */
  private readonly tracks: Track[] = [];
  /** `frame()` 的序号，从 1 起（`Track.advancedAt` 初值 0）。 */
  private serial = 0;
  /** `advance` 的临时输出，复用。 */
  private readonly scratch: AnimationEventDef[] = [];
  /** 最近派发的事件（探针读），环形。 */
  private readonly recent: AnimationProbeEvent[] = [];
  private recentNext = 0;
  /** `id` → 条目，`control` 用（同 `id` 取登记在前的）。 */
  private readonly byId = new Map<string, Track>();
  /** 已经给出的控制对象（同一条每次返回同一个），按 `id` 缓存；条目被摘掉时一并删。 */
  private readonly controls = new Map<string, AnimationControl>();
  private readonly costs = new Float64Array(FRAME_SAMPLES);
  private costCount = 0;
  private costNext = 0;

  /** 整场构造 = 从空开始 `add(整场列表)`（L3b）。 */
  constructor(list: readonly SceneAnimation[]) {
    this.add(list);
  }

  /**
   * 追加一批条目（L3b：一个对象的关键帧，也是整场构造的做法）：`list` 里联动的 `parent` 是 `list` 内下标（片段的形状，整场时就是表内下标）。
   * 新条目排在已有的后面，时钟从 0 起，建出的这一帧不求值（`frame` 下一次调时先推进再求值，L0 实测：f=90 读 0.5，f=91 读 dt/2）。
   * 同一对象已有条目时由调用方先 `removeObjects`（替换；要按 `id` 接回时钟用 `replaceObjects`，L6）。
   */
  add(list: readonly SceneAnimation[]): void {
    const created = list.map((def, index): Track => {
      const owner = ownerOf(list, index);
      // 子的帧号上限是主人的 length（`hi ≤ len`），缓存按它预分配
      const frames = Math.min(Math.max(0, Math.trunc(list[owner].clock.length)) + 1, PREALLOCATED_FRAMES);
      const track: Track = {
        def,
        channels: def.channels.map((keys) => new Channel(keys, frames)),
        owner: null as unknown as Track,
        dead: false,
        // 子的时钟从不推进（P10b），事件也就永远不触发；丢弃的用惰性时钟
        clock: def.inert ? AnimationClock.inert(def.clock.length) : new AnimationClock(def.clock, def.events),
        rate: 1,
        advancedAt: 0,
        values: new Float32Array(def.channels.length),
        written: false,
        active: def.writes && writable(def.target),
      };
      return track;
    });
    created.forEach((track, index) => {
      track.owner = created[ownerOf(list, index)];
    });
    for (const track of created) {
      this.tracks.push(track);
      if (!this.byId.has(track.def.id)) this.byId.set(track.def.id, track);
    }
  }

  /**
   * 删掉属于这些对象的全部条目（`def.object`，L3b）：之后 `control(id)` 返回 null，已给出的控制对象作废（方法空操作，读值留在摘掉那一刻）。
   * 联动的主人与子同属一个对象，所以一起走；主人走了而子留下（理论上不会）时子改用自己的时钟。
   */
  removeObjects(objects: ReadonlySet<number>): void {
    if (objects.size === 0) return;
    const gone = new Set<Track>();
    for (const track of this.tracks) if (track.def.object !== null && objects.has(track.def.object)) gone.add(track);
    if (gone.size === 0) return;
    let write = 0;
    for (const track of this.tracks) {
      if (gone.has(track)) {
        track.dead = true;
        continue;
      }
      if (gone.has(track.owner)) track.owner = track;
      this.tracks[write++] = track;
    }
    this.tracks.length = write;
    for (const [id, track] of [...this.byId]) {
      if (!gone.has(track)) continue;
      this.byId.delete(id);
      this.controls.delete(id);
      // 同 id 还有没走的条目：顶上去
      const other = this.tracks.find((item) => item.def.id === id);
      if (other) this.byId.set(id, other);
    }
  }

  /** 动画条数。 */
  get size(): number {
    return this.tracks.length;
  }

  /**
   * 一个实时帧（读码第 1 节第 3 条）：按列表顺序逐条，时钟主人本帧没推进过就推进 `f(f(rate) × f(dt))`（子排在父前面时第一次用到就推进
   * 父的，不晚一帧）；会写的按主人的时钟求值、写进 `state`。暂停、对象隐藏的照写。写声音的 `volume` 后调 `hooks.sound`。
   *
   * 事件（P10b，读码第 8 节）：这一条触发了主人的推进时，推进收到的事件在它写完（或不写）之后、下一条之前逐个同步调 `hooks.event`。
   * 回调里可以对任意一条调 `control(...)`（比如对排在后面的那条 `stop()`，它本帧就写第 0 帧的值），所以先把事件拷出来再派发。
   */
  frame(dt: number, state: AnimationSink, hooks: AnimationHooks = {}): void {
    const started = performance.now();
    const serial = ++this.serial;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const owner = track.owner;
      const clock = owner.clock;
      let emitted: AnimationEventDef[] | null = null;
      if (owner.advancedAt !== serial) {
        owner.advancedAt = serial;
        const scratch = this.scratch;
        scratch.length = 0;
        clock.advance(f(f(owner.rate) * f(dt)), scratch);
        if (scratch.length) emitted = scratch.slice();
      }
      if (track.active) this.writeTrack(track, clock, state, hooks.sound);
      if (emitted)
        for (const event of emitted) {
          const record: AnimationEventRecord = {
            animation: tracks.indexOf(owner),
            object: owner.def.object,
            json: event.json,
          };
          this.remember(serial, record);
          hooks.event?.(record);
        }
    }
    this.costs[this.costNext] = performance.now() - started;
    this.costNext = (this.costNext + 1) % FRAME_SAMPLES;
    if (this.costCount < FRAME_SAMPLES) this.costCount++;
  }

  private remember(frame: number, record: AnimationEventRecord): void {
    this.recent[this.recentNext] = { frame, ...record };
    this.recentNext = (this.recentNext + 1) % EVENT_SAMPLES;
  }

  /**
   * 脚本控制的落点（P10b）：按 `id`（`scene.json` 路径）找一条，同一条每次返回同一个对象；没有这一条时 null。成员都作用在这一条自己的
   * 时钟与 `rate` 上，子动画的不影响画面（读码第 7 节），惰性的（丢弃的）`play()` 也无效（`D = 0`）。
   */
  control(id: string): AnimationControl | null {
    const track = this.byId.get(id);
    if (!track) return null;
    let control = this.controls.get(id);
    if (!control) {
      const clock = track.clock;
      control = {
        get rate() {
          return track.rate;
        },
        set rate(value: number) {
          if (!track.dead) track.rate = f(value);
        },
        get fps() {
          return f(1 / clock.spf);
        },
        get frameCount() {
          return clock.length;
        },
        get duration() {
          return clock.D;
        },
        get name() {
          return track.def.name;
        },
        // 条目被 `removeObjects` 摘掉之后空操作（L3b）：时钟停在摘掉那一刻，读值给静态值
        play: () => {
          if (!track.dead) clock.play();
        },
        pause: () => {
          if (!track.dead) clock.pause();
        },
        stop: () => {
          if (!track.dead) clock.stop();
        },
        isPlaying: () => clock.isPlaying(),
        getFrame: () => clock.getFrame(),
        setFrame: (frame: number) => {
          if (!track.dead) clock.setFrame(frame);
        },
      };
      this.controls.set(id, control);
    }
    return control;
  }

  /**
   * 不推进，按当前时钟把会写的每条写一次。宿主换场景时在首帧之前调（暂停中重编译时首帧不跑 `beforeFrame`，不写的话先闪一下 `value`），
   * 探针 `seek` 之后调。不清事件。
   */
  write(state: AnimationSink, onSound?: AnimationSoundHook): void {
    for (const track of this.tracks) if (track.active) this.writeTrack(track, track.owner.clock, state, onSound);
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
   * - 时钟：`fps` / `length` / `mode` 相同时拷 `t` 与整个 `flags`（`PAUSED` / `DONE` / `BACK`，P10b 的 `pause()` 也跨重编译
   *   保留；`startpaused` 不同也照拷）以及 `rate`；P10b 起每条都有自己的时钟，子的（脚本可能改过）也接；
   * - 通道：关键帧逐项相同的复用旧的 `Channel`（整数帧缓存跟着来），不同的用新的；
   * - 找不到的（新出现的、参数变了的）从 0 开始，同 WPE 重开壁纸。
   * 只在新建之后、第一次 `frame` / `write` 之前调一次。
   */
  carryOver(previous: SceneAnimations | null): void {
    if (!previous || previous === this) return;
    const old = new Map(previous.tracks.map((track) => [track.def.id, track]));
    for (const track of this.tracks) {
      const before = old.get(track.def.id);
      if (before) carryTrack(track, before);
    }
  }

  /**
   * 单对象重编译（L6）换掉这些对象的条目，并按 `id` 接回时钟：先记下要摘的条目（同 `id` 取登记在后的，同 `carryOver`），`removeObjects` 后 `add(list)`，
   * 新条目里 `id` 相同的按 `carryOver` 的规则接（时钟参数相同才拷 `t` / `flags` / `rate`，关键帧相同的通道复用旧的），找不到的从 0 开始。新条目同
   * `add` 排在表尾；已给出的控制对象照 `removeObjects` 作废（脚本的包装按 `id` 现取，接得上新条目）。
   */
  replaceObjects(objects: ReadonlySet<number>, list: readonly SceneAnimation[]): void {
    const old = new Map<string, Track>();
    for (const track of this.tracks)
      if (track.def.object !== null && objects.has(track.def.object)) old.set(track.def.id, track);
    this.removeObjects(objects);
    const from = this.tracks.length;
    this.add(list);
    if (old.size === 0) return;
    for (const track of this.tracks.slice(from)) {
      const before = old.get(track.def.id);
      if (before) carryTrack(track, before);
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
      // 只动主人的时钟（子的从不推进）
      if (track.owner !== track) continue;
      const clock = track.clock;
      if (clock.flags & PAUSED || !(clock.D > 0)) continue;
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
        const clock = track.owner.clock;
        return {
          id: track.def.id,
          owner: this.tracks.indexOf(track.owner),
          t: clock.t,
          frame: clock.getFrame(),
          playing: clock.isPlaying(),
          flags: clock.flags >>> 0,
          writes: track.def.writes,
          target: track.def.target.kind,
          value: track.written ? Array.from(track.values) : null,
          name: track.def.name,
          rate: track.rate,
        };
      }),
      // 环形缓冲按写入顺序展开（旧的在前）
      events:
        this.recent.length < EVENT_SAMPLES
          ? this.recent.slice()
          : [...this.recent.slice(this.recentNext), ...this.recent.slice(0, this.recentNext)],
    };
  }
}
