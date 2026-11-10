/**
 * 声音的播放后端（P6a 步骤 1）：场景一个 `ScenePlayer`，管宿主唯一的 `AudioContext`、每个声音对象的增益节点、按文件的 `<audio>` 元素
 * 与 Blob。排期（什么时候放哪个文件）全在 `scheduler.ts`，这里只照命令做。
 *
 * - **不整段解码。** 语料的声音文件合计 1.5 GB、最大一段 114 MB（FLAC），整段 `decodeAudioData` 解成 PCM 要上 GB。每个文件一个
 *   媒体元素，Chromium 负责流式解码：散文件直接用 `file:` 地址，`scene.pkg` 里的条目按区间读成 Blob（`FetchSceneReader.readRange`）。
 *   一个声音对象的一个文件同一时刻最多一个元素；同一份 Blob 在场景里只读一次。
 * - **连线**：元素 → `MediaElementAudioSourceNode` → 本声音的增益（`min(1, volume²·h) / h`）→ 场景的淡变增益 → `destination`。
 *   垫片把实时 context 的 `destination` 接到它的主增益、乘宿主音量 h，接进 Web Audio 的元素上不再乘第二次（`wpe_shim.js` 的 `routed`）。
 * - **懒建**：第一次 `start` 才建 `AudioContext`（排期器只在 `volume²·h > 0` 时开始），宿主音量为 0 时不建 context、不建元素、不读文件。
 * - **开始是异步的**：元素拿到元数据（`loadedmetadata`）才从头 `play()`，并经 `started(file, duration)` 回报，排期器从这时起计时。
 * - **失败**：读文件失败、元素报 `error`：经 `failed` 回报，排期器照 WPE 把文件从列表里删掉（宿主记一条 warn），不退回。
 * - **暂停的淡变**：WPE 暂停时全局音量按 `k = min(1, 6·dt)` 指数淡到 0 再暂停、恢复时同样淡回（rea-p6a-sound.md 4.1）。这里用场景的
 *   淡变增益 `setTargetAtTime(·, 时间常数 1/6 s)`；暂停时垫片的主增益已立即变 0、排期器也立即暂停元素，所以只有淡入听得见。
 */
import type { SceneReader } from "../compile/fs";
import { SOUND_TYPES, soundExtension, type SceneSoundFile } from "../compile/sounds";
import { fileToUrl } from "../fileUrl";
import type { SoundBackend } from "./scheduler";
import type { SoundPlayer, SoundVoiceEvents } from "./sceneSounds";

/** WPE 淡变 `cur += (target − cur) · min(1, 6·dt)` 的连续形式：时间常数 1/6 s。 */
export const FADE_TIME_CONSTANT = 1 / 6;

/** `HTMLMediaElement.HAVE_METADATA`（Node 里没有这个全局，单测用替身时也不依赖它）。 */
const HAVE_METADATA = 1;

export interface ScenePlayerOptions {
  reader: Pick<SceneReader, "readRange">;
  /** 测试替身注入；缺省用浏览器的 `AudioContext` 与 `<audio>`。 */
  createContext?: () => AudioContext;
  createElement?: () => HTMLAudioElement;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

/** 一个文件的元素与它的意图：`pendingStart` 期间等元数据，到了才从头放并回报。 */
interface Track {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode | null;
  loop: boolean;
  pendingStart: boolean;
  /** 等元数据期间收到的 pause / stop 记在这里：到了照样回报开始，只是不放。 */
  wanted: "play" | "pause" | "stop";
  failed: boolean;
}

/** dev 探针：一个元素的状态。 */
export interface SoundTrackProbe {
  file: number;
  source: "file" | "blob" | "pending";
  paused: boolean;
  ended: boolean;
  loop: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
}

class SoundVoice implements SoundBackend {
  private gain = 0;
  private node: GainNode | null = null;
  readonly tracks = new Map<number, Track>();
  private released = false;

  constructor(
    private readonly player: ScenePlayer,
    readonly object: number,
    private readonly files: readonly SceneSoundFile[],
    private readonly events: SoundVoiceEvents,
  ) {}

  start(file: number, loop: boolean): void {
    const track = this.track(file);
    if (!track) return;
    track.loop = loop;
    track.pendingStart = true;
    track.wanted = "play";
    // 已有元数据（换回同一个文件、loop 多文件连选同一个）也走异步回报，排期器在 `start` 返回之后才收到
    if (track.element.readyState >= HAVE_METADATA) queueMicrotask(() => this.begin(file, track));
  }

  resume(file: number, loop: boolean): void {
    const track = this.tracks.get(file);
    if (!track || track.failed) return;
    track.loop = loop;
    track.wanted = "play";
    if (track.pendingStart) return;
    track.element.loop = loop;
    this.play(file, track);
  }

  pause(file: number): void {
    const track = this.tracks.get(file);
    if (!track) return;
    track.wanted = "pause";
    if (!track.pendingStart) track.element.pause();
  }

  stop(file: number): void {
    const track = this.tracks.get(file);
    if (!track) return;
    track.pendingStart = false;
    track.wanted = "stop";
    track.element.pause();
    if (track.element.readyState >= HAVE_METADATA) track.element.currentTime = 0;
  }

  setGain(gain: number): void {
    this.gain = gain;
    if (this.node) this.node.gain.value = gain;
  }

  /** 第一次开始时建：context、本声音的增益、文件的元素（散文件直接给地址，pkg 条目读成 Blob 之后再给）。 */
  private track(file: number): Track | null {
    const existing = this.tracks.get(file);
    if (existing) return existing.failed ? null : existing;
    const info = this.files[file];
    if (!info || this.released) return null;
    const context = this.player.ensureContext();
    if (!this.node) {
      this.node = context.createGain();
      this.node.gain.value = this.gain;
      this.node.connect(this.player.output!);
    }
    const element = this.player.createElement();
    element.preload = "auto";
    const track: Track = { element, source: null, loop: false, pendingStart: false, wanted: "stop", failed: false };
    this.tracks.set(file, track);
    element.addEventListener("loadedmetadata", () => this.begin(file, track));
    element.addEventListener("error", () => this.fail(file, track, element.error ?? new Error("媒体元素出错")));
    try {
      track.source = context.createMediaElementSource(element);
      track.source.connect(this.node);
    } catch (error) {
      this.fail(file, track, error);
      return null;
    }
    this.player.sourceOf(info).then(
      (url) => {
        if (!this.released && !track.failed) element.src = url;
      },
      (error: unknown) => this.fail(file, track, error),
    );
    return track;
  }

  private begin(file: number, track: Track): void {
    if (!track.pendingStart || this.released || track.failed) return;
    track.pendingStart = false;
    const element = track.element;
    element.loop = track.loop;
    element.currentTime = 0;
    this.events.started(file, element.duration);
    if (track.wanted === "play") this.play(file, track);
  }

  private play(file: number, track: Track): void {
    const played = track.element.play();
    // 暂停打断 play 是正常的（AbortError）；自动播放被拦这类不是文件的问题，只记下，不删文件
    played?.catch?.((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.player.warn(`场景声音 ${this.object} 第 ${file} 个文件播放失败：`, error);
    });
  }

  private fail(file: number, track: Track, error: unknown): void {
    if (track.failed || this.released) return;
    track.failed = true;
    track.pendingStart = false;
    this.releaseTrack(track);
    // 异步回报：排期器可能当场换一个文件重新开始，不在它的 `start` 调用里重入
    queueMicrotask(() => {
      if (!this.released) this.events.failed(file, error);
    });
  }

  private releaseTrack(track: Track): void {
    const element = track.element;
    element.pause();
    element.removeAttribute("src");
    element.load();
    track.source?.disconnect();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const track of this.tracks.values()) this.releaseTrack(track);
    this.tracks.clear();
    this.node?.disconnect();
    this.node = null;
  }

  probe(): SoundTrackProbe[] {
    return [...this.tracks].map(([file, track]) => {
      const element = track.element;
      const src = element.getAttribute("src") ?? "";
      return {
        file,
        source: !src ? "pending" : src.startsWith("blob:") ? "blob" : "file",
        paused: element.paused,
        ended: element.ended,
        loop: element.loop,
        currentTime: element.currentTime,
        duration: element.duration,
        readyState: element.readyState,
      };
    });
  }
}

export class ScenePlayer implements SoundPlayer {
  private context: AudioContext | null = null;
  /** 场景的淡变增益（暂停 / 恢复）。 */
  output: GainNode | null = null;
  private active = true;
  private readonly voices = new Map<number, SoundVoice>();
  /** pkg 条目（按 scene.pkg 路径 + 偏移 + 长度）→ Blob 地址；同一场景只读一次，`dispose` 时撤销。 */
  private readonly blobs = new Map<string, Promise<string>>();
  private disposed = false;

  constructor(
    private readonly options: ScenePlayerOptions,
    private readonly report: { warn(message: string, detail?: unknown): void } = { warn: () => {} },
  ) {}

  voice(object: number, files: readonly SceneSoundFile[], events: SoundVoiceEvents): SoundBackend {
    this.voices.get(object)?.release();
    const voice = new SoundVoice(this, object, files, events);
    this.voices.set(object, voice);
    return voice;
  }

  release(object: number): void {
    this.voices.get(object)?.release();
    this.voices.delete(object);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    const output = this.output;
    const context = this.context;
    if (!output || !context) return;
    const now = context.currentTime;
    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(output.gain.value, now);
    output.gain.setTargetAtTime(active ? 1 : 0, now, FADE_TIME_CONSTANT);
  }

  /** 第一次开始播放时建 context 与淡变增益（宿主音量为 0 时排期器不开始，也就不建）。 */
  ensureContext(): AudioContext {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
      return this.context;
    }
    const context = this.options.createContext ? this.options.createContext() : new AudioContext();
    const output = context.createGain();
    output.gain.value = this.active ? 1 : 0;
    // 垫片把这条连接改接到它的主增益（乘宿主音量）
    output.connect(context.destination);
    this.context = context;
    this.output = output;
    return context;
  }

  createElement(): HTMLAudioElement {
    return this.options.createElement ? this.options.createElement() : new Audio();
  }

  /** 元素的地址：散文件直接 `file:`；pkg 条目按区间读成 Blob（同一条目只读一次）。 */
  sourceOf(file: SceneSoundFile): Promise<string> {
    if (file.size === null) return Promise.resolve(fileToUrl(file.location.path));
    const key = `${file.location.path}\n${file.location.offset}\n${file.size}`;
    let task = this.blobs.get(key);
    if (!task) {
      const { path, offset } = file.location;
      const size = file.size;
      const type = SOUND_TYPES[soundExtension(file.path) ?? ""] ?? "";
      task = this.options.reader.readRange(path, offset, offset + size).then((bytes) => {
        if (bytes.length !== size) throw new Error(`声音文件被截断：${file.path}`);
        if (this.disposed) throw new DOMException("播放器已释放", "AbortError");
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
        return this.options.createObjectUrl ? this.options.createObjectUrl(blob) : URL.createObjectURL(blob);
      });
      task.catch(() => this.blobs.delete(key));
      this.blobs.set(key, task);
    }
    return task;
  }

  warn(message: string, detail?: unknown): void {
    this.report.warn(message, detail);
  }

  /** dev 探针：context 状态、淡变增益与各对象的元素。 */
  probe(): {
    context: string | null;
    fade: number | null;
    blobs: number;
    voices: { object: number; tracks: SoundTrackProbe[] }[];
  } {
    return {
      context: this.context?.state ?? null,
      fade: this.output?.gain.value ?? null,
      blobs: this.blobs.size,
      voices: [...this.voices.values()].map((voice) => ({ object: voice.object, tracks: voice.probe() })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices.values()) voice.release();
    this.voices.clear();
    const revoke = this.options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
    for (const task of this.blobs.values()) task.then(revoke, () => {});
    this.blobs.clear();
    this.output?.disconnect();
    this.output = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
