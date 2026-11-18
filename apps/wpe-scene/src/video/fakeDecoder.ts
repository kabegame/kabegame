/**
 * 单测用的 WebCodecs 替身（P9d 步骤 2b，从 `codecPlayer.test.ts` 抽出）：解码器替身按喂入顺序在微任务里吐出带时间戳的假帧
 * （可按显示顺序重排、可停止输出），假帧记账（`env.opened` 为还没 `close()` 的个数，用例结束时应为 0）。
 * 只给 src 下的单测用，产品代码不引用。
 */
import type { CodecDecoder, CodecDecoderInit, CodecFactories } from "./codecPlayer";

/** 等一轮宏任务：让解码器替身的微任务与播放器的 Promise 链走完。 */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 替身的共享状态：墙钟（毫秒）、假帧的显示尺寸、打开的帧数、warn、建过的解码器、读过的区间。 */
export interface FakeEnv {
  now: number;
  /** 之后解出的假帧的显示尺寸，缺省 1920×1080。 */
  frameSize: [number, number];
  opened: number;
  warnings: [string, unknown][];
  decoders: FakeDecoder[];
  reads: [number, number][];
}

export function newFakeEnv(): FakeEnv {
  return { now: 0, frameSize: [1920, 1080], opened: 0, warnings: [], decoders: [], reads: [] };
}

/** 假帧：只有播放器与 GpuScene 用到的字段；`close` 记账，`clone` 开一个同时间戳的新帧。 */
export class FakeFrame {
  closed = false;
  readonly duration = 125_000;
  readonly displayWidth: number;
  readonly displayHeight: number;
  constructor(
    private readonly env: FakeEnv,
    readonly timestamp: number,
  ) {
    env.opened++;
    [this.displayWidth, this.displayHeight] = env.frameSize;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.env.opened--;
  }
  clone(): FakeFrame {
    return new FakeFrame(this.env, this.timestamp);
  }
}

/**
 * 解码器替身：`decode` 进队列，微任务里按喂入顺序吐出（`depth > 0` 时先攒 `depth` 个、按时间戳最小的先出，模拟 B 帧重排）。
 * `halted` 时不吐。configure / flush 之后第一个必须是关键帧（同 WebCodecs 的 key chunk required）。
 */
export class FakeDecoder implements CodecDecoder {
  queue: EncodedVideoChunkInit[] = [];
  held: EncodedVideoChunkInit[] = [];
  /** 喂入的时间戳，reset 记作 "reset"。 */
  fed: (number | "reset")[] = [];
  configures = 0;
  resets = 0;
  flushes = 0;
  closed = false;
  halted = false;
  private needKey = true;
  private scheduled = false;

  constructor(
    private readonly env: FakeEnv,
    readonly init: CodecDecoderInit,
    private readonly depth: number,
  ) {}

  /** 同真解码器：只算还没消化的输入，收进重排缓冲（`held`）的不算。 */
  get decodeQueueSize() {
    return this.queue.length;
  }
  configure() {
    this.configures++;
    this.needKey = true;
  }
  decode(chunk: EncodedVideoChunkInit) {
    if (this.needKey && chunk.type !== "key") throw new DOMException("需要关键帧", "DataError");
    this.needKey = false;
    this.fed.push(chunk.timestamp);
    this.queue.push(chunk);
    this.schedule();
  }
  flush() {
    this.flushes++;
    this.needKey = true;
    return Promise.resolve().then(() => {
      this.drain();
      this.held.sort((a, b) => a.timestamp - b.timestamp);
      for (const chunk of this.held.splice(0)) this.emit(chunk);
    });
  }
  reset() {
    this.resets++;
    this.fed.push("reset");
    this.queue = [];
    this.held = [];
  }
  close() {
    this.closed = true;
  }
  /** 恢复输出。 */
  resume() {
    this.halted = false;
    this.schedule();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private drain() {
    const before = this.queue.length;
    this.drainQueue();
    // 同真解码器的 dequeue 事件：队列变短后异步通知
    if (this.queue.length < before) queueMicrotask(() => !this.closed && this.init.dequeue());
  }
  private drainQueue() {
    while (!this.halted && !this.closed && this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      if (this.depth === 0) {
        this.emit(chunk);
        continue;
      }
      this.held.push(chunk);
      if (this.held.length > this.depth) {
        this.held.sort((a, b) => a.timestamp - b.timestamp);
        this.emit(this.held.shift()!);
      }
    }
  }
  private emit(chunk: EncodedVideoChunkInit) {
    this.init.output(new FakeFrame(this.env, chunk.timestamp) as unknown as VideoFrame);
  }
}

export interface FakeDecoderOptions {
  /** 重排缓冲（DPB）深度：攒够这么多帧才按时间戳吐最早的一帧，缺省 0（按喂入顺序出）。收进缓冲的帧不算在 `decodeQueueSize` 里。 */
  depth?: number;
  /** `isConfigSupported` 的结果，缺省支持。 */
  supported?: boolean;
  /** 解码器一建好就不出帧。 */
  halted?: boolean;
}

/** 注入播放器的部件：解码器、配置检查、墙钟（读取函数由调用方自己给）。建出的解码器记在 `env.decoders`。 */
export function fakeFactories(env: FakeEnv, options: FakeDecoderOptions = {}): CodecFactories {
  return {
    createDecoder: (init) => {
      const decoder = new FakeDecoder(env, init, options.depth ?? 0);
      decoder.halted = options.halted ?? false;
      env.decoders.push(decoder);
      return decoder;
    },
    isConfigSupported: async () => ({ supported: options.supported ?? true }),
    now: () => env.now,
  };
}
