/**
 * 场景的媒体状态与每帧派发（P11c，rea-p11-media 第 2 节：WPE 的 `M`、每帧脚本函数的媒体段 `FUN_140171440`、init 之后的补发 `FUN_140172830`）。
 *
 * - 队列里的事件原样排队、不合并；每帧（脚本阶段最开头）取空，逐条按固定顺序处理：
 *   1. 有封面先换名（`mediaThumbnail_<N>.system`，计数从 1 起、每次加 1，相同图片也换名；没有封面时同样换名），当一次属性增量：
 *      `$mediaThumbnail` = 新名字，有旧名字时 `$mediaPreviousThumbnail` = 旧名字（增量没有 `type`，导出了 `applyUserProperties` 的脚本收到 `{}`）；
 *   2. 依次 状态 → 播放 → 属性 → 封面 → 时间轴 调五个回调，每次回调看到的是这一条事件自己的值。
 * - 暂停时宿主不调 `drain`，队列积压（无上限、不丢、不合并），恢复后第一帧按先后全部派发。
 * - 脚本 `init` 之后（首次 `applyUserProperties` 之前）按这里存的当前值补发一轮，只发给刚 `init` 的脚本（`replayAfterInit`）。
 *
 * 位图不存在这里：封面的位图随事件交给来源表（`UserTextureSources.provide`），由它只留当前与上一张、更旧的释放。
 */
import {
  closeCover,
  EMPTY_PROPS,
  FLAG_PLAYBACK,
  FLAG_PROPERTIES,
  FLAG_STATUS,
  FLAG_THUMBNAIL,
  FLAG_TIMELINE,
  NO_COLORS,
} from "./types";
import type { CoverData, MediaColors, MediaEvent, MediaProps } from "./types";
import type { UserTextureImage } from "../usertex/sources";

/** 一次封面回调的内容：`hasThumbnail` 为假时颜色是事件带来的值（正常全 0）。 */
export interface ThumbnailInfo {
  hasThumbnail: boolean;
  colors: MediaColors;
}

/** 派发给脚本的五个回调（宿主 / 探针按自己的脚本运行时实现，见 `events.ts` 的 `scriptMediaCallbacks`）。 */
export interface MediaCallbacks {
  status(enabled: boolean): void;
  playback(state: number): void;
  properties(props: MediaProps): void;
  thumbnail(info: ThumbnailInfo): void;
  timeline(position: number, duration: number): void;
}

/** 封面增量里一个伪属性（只有 `value`，没有 `type`）。 */
export type MediaDelta = Record<string, { value: string }>;

/** `drain` 的处理者：五个回调，加封面换名这一步（图交来源表、增量走属性路径）。 */
export interface MediaHandlers extends MediaCallbacks {
  /** 封面换名：`image` 交给来源表（所有权转移；`null` = 没有封面）、`delta` 当一次属性增量应用；先于这一条事件的五个回调。 */
  cover(name: string, image: UserTextureImage | null, delta: MediaDelta): void;
}

/** 场景媒体状态的快照（dev 探针）。 */
export interface SceneMediaSnapshot {
  enabled: boolean;
  /** 下一张封面的计数（从 1 起）。 */
  counter: number;
  /** 当前与上一张封面的名字（没有为空串）。 */
  name: string;
  previousName: string;
  props: MediaProps;
  state: number;
  position: number;
  duration: number;
  /** 当前封面：有无与五色；没收到过封面为 null。 */
  cover: { has: boolean; colors: MediaColors } | null;
  queued: number;
}

export class SceneMedia {
  /** WPE `M+0x1c4`：新建时为真（所以 init 补发通常是一次 `{enabled: true}`）。 */
  enabled = true;
  private counter = 1;
  private name = "";
  private previousName = "";
  private cover: { has: boolean; colors: MediaColors } | null = null;
  private props: MediaProps = { ...EMPTY_PROPS };
  private state = 0;
  private position = 0;
  private duration = 0;
  private queue: MediaEvent[] = [];

  get queued(): number {
    return this.queue.length;
  }

  /** 事件入队（不合并）。 */
  push(event: MediaEvent): void {
    this.queue.push(event);
  }

  /** 丢掉队列里的全部事件并关掉带的位图（退回预览图期间不派发时用）。 */
  discard(): void {
    for (const event of this.queue.splice(0)) closeCover(event.cover);
  }

  /** 每帧取空队列，逐条处理（见文件头）。 */
  drain(handlers: MediaHandlers): void {
    while (this.queue.length) {
      const event = this.queue.shift()!;
      if (event.flags & FLAG_THUMBNAIL) {
        const old = this.name;
        this.name = `mediaThumbnail_${this.counter}.system`;
        this.previousName = old;
        const data: CoverData = event.cover ?? { image: null, colors: NO_COLORS };
        this.cover = { has: data.image !== null, colors: data.colors };
        const delta: MediaDelta = { $mediaThumbnail: { value: this.name } };
        if (old) delta.$mediaPreviousThumbnail = { value: old };
        this.counter++;
        handlers.cover(this.name, data.image, delta);
      }
      if (event.flags & FLAG_STATUS) {
        this.enabled = event.enabled;
        handlers.status(this.enabled);
      }
      if (event.flags & FLAG_PLAYBACK) {
        this.state = event.state;
        handlers.playback(this.state);
      }
      if (event.flags & FLAG_PROPERTIES) {
        this.props = { ...event.props };
        handlers.properties({ ...this.props });
      }
      if (event.flags & FLAG_THUMBNAIL) {
        const cover = this.cover!;
        handlers.thumbnail({ hasThumbnail: cover.has, colors: cover.colors });
      }
      if (event.flags & FLAG_TIMELINE) {
        this.position = event.position;
        this.duration = event.duration;
        handlers.timeline(this.position, this.duration);
      }
    }
  }

  /**
   * 脚本 `init` 之后的补发（rea-p11-media 2.5）：状态 → 播放 → 属性 → 封面 → 时间轴，各自的条件：`enabled` 为真发状态、状态非 0 发播放、
   * `title` 非空发属性、有封面发封面（`hasThumbnail` 恒为真）、`duration` 非 0 发时间轴。回调由调用方限定只发给刚 `init` 的脚本。
   */
  replayAfterInit(callbacks: MediaCallbacks): void {
    if (this.enabled) callbacks.status(this.enabled);
    if (this.state !== 0) callbacks.playback(this.state);
    if (this.props.title !== "") callbacks.properties({ ...this.props });
    if (this.cover?.has) callbacks.thumbnail({ hasThumbnail: true, colors: this.cover.colors });
    if (this.duration !== 0) callbacks.timeline(this.position, this.duration);
  }

  snapshot(): SceneMediaSnapshot {
    return {
      enabled: this.enabled,
      counter: this.counter,
      name: this.name,
      previousName: this.previousName,
      props: { ...this.props },
      state: this.state,
      position: this.position,
      duration: this.duration,
      cover: this.cover ? { has: this.cover.has, colors: this.cover.colors } : null,
      queued: this.queue.length,
    };
  }
}
