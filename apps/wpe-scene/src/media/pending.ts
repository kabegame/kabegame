/**
 * 媒体消息的合并（P11c，rea-p11-media 1.5：WPE 主进程的 `A.pending` 与 `FlushMedia`）。
 *
 * 两次刷新之间同类消息只留最后一条，各类的 flags 按位或（1 属性、2 封面、4 播放、8 时间轴、0x10 状态）；刷新（`flush`）把待发切成事件：
 * 先把 `flags & 0x1d` 合成一个（带全部当前值），再把封面单独切一个（`flags === 2`），只清 flags、值留着（它同时是「最近一次已知状态」的缓存）。
 *
 * 封面在收到时就解码（base64 → PNG → 位图，依赖可注入），解完才并入待发：派发那一刻图已在手，换纹理和 WPE 一样同帧完成。
 * 同时在途的几张按收到的序号定输赢：后收到的封面胜出，晚到的旧结果直接关掉位图；并入时取代的未发出的旧封面也关掉位图。
 */
import { pngGammaTable } from "../usertex/png";
import type { UserTextureImage } from "../usertex/sources";
import {
  EMPTY_PROPS,
  FLAG_PLAYBACK,
  FLAG_PROPERTIES,
  FLAG_STATUS,
  FLAG_THUMBNAIL,
  FLAG_TIMELINE,
  FLAGS_MAIN,
  NO_COLORS,
  closeCover,
  type CoverData,
  type MediaColors,
  type MediaEvent,
  type MediaProps,
  type Rgb,
} from "./types";

export interface MediaPendingDeps {
  /** 把封面的 base64 PNG 解成位图（含 `gAMA` 表）；失败抛错（那张封面记成没有）。 */
  decode(png: string): Promise<UserTextureImage>;
  /** 一条 debug 日志。 */
  log(message: string): void;
}

/** 缺省的解码：base64 → 字节 → `createImageBitmap`（选项同来源表的属性图片，直通 alpha、不做色彩空间转换）。 */
export function defaultDecodeCover(png: string): Promise<UserTextureImage> {
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const gamma = pngGammaTable(bytes);
  return createImageBitmap(new Blob([bytes]), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
    imageOrientation: "from-image",
  }).then((source) => ({ width: source.width, height: source.height, source, gamma }));
}

const toText = (value: unknown): string => (typeof value === "string" ? value : "");
const toInt = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);

function toColor(value: unknown): Rgb {
  const parts = Array.isArray(value) ? value : [];
  const channel = (index: number) => Math.min(255, Math.max(0, toInt(parts[index])));
  return [channel(0), channel(1), channel(2)];
}

/** 消息的 `colors`（五个颜色）→ 固定形状；缺的补 0。 */
export function toColors(value: unknown): MediaColors {
  if (!Array.isArray(value)) return NO_COLORS;
  return [0, 1, 2, 3, 4].map((index) => toColor(value[index])) as unknown as MediaColors;
}

export class MediaPending {
  private flags = 0;
  private enabled = true;
  private state = 0;
  private props: MediaProps = { ...EMPTY_PROPS };
  private position = 0;
  private duration = 0;
  /** 最近一次并入的封面；位图只在还没随事件发出时留着（`coverOwned`）。 */
  private cover: CoverData | null = null;
  private coverOwned = false;
  /** 封面消息的收到序号与已并入的最大序号。 */
  private seq = 0;
  private applied = 0;
  private readonly inflight = new Set<Promise<void>>();
  private disposed = false;
  private readonly deps: MediaPendingDeps;

  constructor(deps: Partial<MediaPendingDeps> = {}) {
    this.deps = { decode: defaultDecodeCover, log: () => {}, ...deps };
  }

  /** 待发的 flags（dev 探针读）。 */
  get pendingFlags(): number {
    return this.flags;
  }

  /** 收一条场景消息。封面先异步解码，解完才并入；别的类型当场并入。不认识的 `type` 忽略。 */
  push(message: { type: string } & Record<string, unknown>): void {
    if (this.disposed) return;
    switch (message.type) {
      case "status":
        this.enabled = message.enabled !== false;
        this.flags |= FLAG_STATUS;
        break;
      case "properties":
        this.props = {
          title: toText(message.title),
          artist: toText(message.artist),
          albumArtist: toText(message.albumArtist),
          albumTitle: toText(message.albumTitle),
          subTitle: toText(message.subTitle),
          genres: toText(message.genres),
          contentType: toText(message.contentType),
        };
        this.flags |= FLAG_PROPERTIES;
        break;
      case "playback":
        this.state = toInt(message.state);
        this.flags |= FLAG_PLAYBACK;
        break;
      case "timeline":
        this.position = toInt(message.position);
        this.duration = toInt(message.duration);
        this.flags |= FLAG_TIMELINE;
        break;
      case "sceneThumbnail":
        this.pushCover(toText(message.png), toColors(message.colors));
        break;
      default:
        break;
    }
  }

  private pushCover(png: string, colors: MediaColors): void {
    const seq = ++this.seq;
    // 没有封面：不用解码，当场并入（序号照排，在途的旧封面因此作废）
    if (png === "") {
      this.incorporate(seq, null, NO_COLORS);
      return;
    }
    const task: Promise<void> = this.deps
      .decode(png)
      .then(
        (image) => this.incorporate(seq, image, colors),
        (error: unknown) => {
          this.deps.log(`封面解码失败（${error instanceof Error ? error.message : String(error)}），当作没有封面`);
          this.incorporate(seq, null, colors);
        },
      )
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  /** 并入一张解完的封面：被后收到的取代的关掉位图；取代自己手里还没发出的旧封面时，旧位图关掉。 */
  private incorporate(seq: number, image: UserTextureImage | null, colors: MediaColors): void {
    const next: CoverData = { image, colors };
    if (this.disposed || seq < this.applied) {
      closeCover(next);
      return;
    }
    this.applied = seq;
    if (this.coverOwned) closeCover(this.cover);
    this.cover = next;
    this.coverOwned = true;
    this.flags |= FLAG_THUMBNAIL;
  }

  /** 全部在途的封面解码都结束。dev 确定性回放用：要等封面解码完再画这一帧。 */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /**
   * 刷新：先切出 `flags & 0x1d` 的一条（带全部当前值），再切出封面一条（`flags === 2`，位图的所有权随事件走）；只清 flags，值留着。
   * 没有待发的返回空数组。
   */
  flush(): MediaEvent[] {
    if (this.disposed) return [];
    const events: MediaEvent[] = [];
    const main = this.flags & FLAGS_MAIN;
    if (main) {
      events.push(this.snapshot(main, null));
      this.flags &= ~FLAGS_MAIN;
    }
    if (this.flags & FLAG_THUMBNAIL) {
      const cover = this.cover!;
      events.push(this.snapshot(FLAG_THUMBNAIL, cover));
      // 位图交给事件之后这里不再持有（只留颜色作缓存）；下一张取代时没有位图可关
      this.cover = { image: null, colors: cover.colors };
      this.coverOwned = false;
      this.flags &= ~FLAG_THUMBNAIL;
    }
    return events;
  }

  private snapshot(flags: number, cover: CoverData | null): MediaEvent {
    return {
      flags,
      enabled: this.enabled,
      state: this.state,
      props: { ...this.props },
      position: this.position,
      duration: this.duration,
      cover,
    };
  }

  /** 释放：关掉还没发出的封面位图，之后的消息不再收。 */
  dispose(): void {
    this.disposed = true;
    if (this.coverOwned) closeCover(this.cover);
    this.cover = null;
    this.coverOwned = false;
  }
}
