/**
 * 场景渲染器的 dev 探针（只在 dev 构建安装，见 `install.ts`）。
 *
 * 挂在场景宿主 frame 的 `window.__kabegameSceneProbe`，经 CDP 在真 app 里调用：
 * - `renderFrame`：按指定 `g_Time` 渲染一帧场景、同步读回离屏场景目标，给出 SHA-256 与 PNG，用来做逐像素回归
 *   （例如关闭档前后两版渲染器的输出是否逐字节相同）；
 * - `bloom`：泛光链的链路隔离验证（`bloomProbe.ts`）；
 * - `chunk`：把存下的结果（PNG、原始数据）按 base64 分块交给 CDP 那一侧落盘；
 * - `particleTrack`：编译后按给定 dt 序列步进粒子模拟器，输出和 WPE RenderDoc 轨迹同格式的数据（P4a 步骤 3）；
 * - `particleCorners`：把粒子顶点着色器改写成计算着色器，读回每个粒子四角的裁剪坐标（P4a 步骤 4，`particleCorners.ts`）；
 * - `renderFrame` 带 `profile` 时给出每个粒子层的模拟 / 写顶点 / 上传开销（`particleMs`），`host.particles` 对当前场景做同样的
 *   记录，并给出粒子数与分布（P4a 步骤 5）。
 *
 * 读回一律在提交本帧的同一任务里排 `copyTextureToBuffer`，不经过画布（画布要在同一任务内同步取，否则是全透明空图）。
 */
import type { SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { particleTrack, type ParticleTrack } from "../particles/track";
import { acquireGpu } from "../render/device";
import { GpuScene, type ParticleProfile } from "../render/scene";
import { SceneState } from "../render/state";
import type { SceneHost } from "../host";
import { replayParticles, type ParticleReplay } from "./particleCorners";

/** 探针结果的存放处：键 → 字节（PNG、原始像素），由 `chunk` 分块取走。 */
const stored = new Map<string, Uint8Array>();

export function storeProbeBytes(key: string, bytes: Uint8Array): void {
  stored.set(key, bytes);
}

/** base64 分块（CDP 单次求值返回的字符串不宜过大）；越界返回 null。 */
export function probeChunk(key: string, index: number, size = 4 * 1024 * 1024): string | null {
  const bytes = stored.get(key);
  if (!bytes) return null;
  const start = index * size;
  if (start >= bytes.length) return null;
  const part = bytes.subarray(start, Math.min(bytes.length, start + size));
  let binary = "";
  for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** IEEE 754 半精度 → 单精度。 */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export type ReadbackFormat = "rgba8unorm" | "rgba16float";

/**
 * 读回一张 2D 纹理（mip 0）：先在调用方的编码器里排拷贝（`encode`），提交后再 `map`。`rgba8unorm` 返回 RGBA 字节，
 * `rgba16float` 返回 RGBA 单精度。
 */
export function scheduleReadback(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  width: number,
  height: number,
  format: ReadbackFormat,
): () => Promise<Uint8Array | Float32Array> {
  const texel = format === "rgba8unorm" ? 4 : 8;
  const bytesPerRow = Math.ceil((width * texel) / 256) * 256;
  const buffer = device.createBuffer({
    label: "probe readback",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
  return async () => {
    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(buffer.getMappedRange());
    let result: Uint8Array | Float32Array;
    if (format === "rgba8unorm") {
      result = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        result.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    } else {
      result = new Float32Array(width * height * 4);
      const halves = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      const table = halfTable();
      for (let y = 0; y < height; y++) {
        const row = (y * bytesPerRow) / 2;
        for (let i = 0; i < width * 4; i++) result[y * width * 4 + i] = table[halves[row + i]];
      }
    }
    buffer.unmap();
    buffer.destroy();
    return result;
  };
}

let halves: Float32Array | null = null;
/** 全部 65536 个半精度值的查表。 */
export function halfTable(): Float32Array {
  if (!halves) {
    halves = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) halves[i] = halfToFloat(i);
  }
  return halves;
}

/** 浮点 RGBA（编码空间）按 8 位画布的写法量化：截到 [0, 1] 再四舍五入。 */
export function quantize8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = Number.isNaN(v) ? 0 : Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return out;
}

export async function encodePng(rgba: Uint8Array, width: number, height: number, opaque = true): Promise<Uint8Array> {
  const pixels = new Uint8ClampedArray(rgba);
  if (opaque) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RenderFrameOptions {
  projectDir: string;
  sceneAssets: string[];
  postprocess?: ScenePostprocessSetting;
  userProperties?: Record<string, unknown>;
  /** `g_Time`（秒）；`g_Daytime` 固定 0.5、指针在中心，保证可复现。传了 `particles` 时改用 dt 的累计值。 */
  time?: number;
  /** 结果的存放键；PNG 存 `<key>.png`，原始 RGBA（场景目标尺寸，alpha 置 255）存 `<key>.rgba`。 */
  key?: string;
  /** 有不支持项也渲染（同 dev 强制渲染）。默认 true。 */
  force?: boolean;
  /**
   * 先连续渲染这么多帧计时（每帧提交后等 GPU 完成，串行、不流水），再渲染读回的那一帧。这些帧同样按 1/60 步进粒子，
   * 要确定性回放粒子时不要同时传。
   */
  profile?: number;
  /**
   * 确定性粒子回放（P4a 步骤 4）：种子固定（缺省 1，第 i 个粒子层用 `seed + i`，同 `particleTrack`）、遍数固定（缺省 1）；
   * 建场景（含预热）后按 `dts` 步进，`dts[0]` 是第 1 帧，最后一帧就是读回的那一帧，`g_Time` 用 dt 的累计值。
   * 不传时种子同样固定为 1、不步进，画的是预热后的状态。
   */
  particles?: ParticleReplay;
}

export interface RenderFrameResult {
  width: number;
  height: number;
  format: string;
  unsupported: string[];
  postprocess: SceneBundle["general"]["postprocess"];
  /** 8 位 RGB（alpha 置 255）的 SHA-256：关闭档前后两版逐字节比较用。 */
  sha256: string;
  /** 三通道平均值（0–255），确认不是空图。 */
  mean: [number, number, number];
  compileMs: number;
  /** 渲染目标类资源的显存估算（字节）。 */
  targetBytes: number;
  /** 泛光链：HDR 级数（LDR 为 0）；没有泛光为 null。 */
  bloomLevels: number | null;
  /** `profile` 帧的耗时（编码 + 提交 + 等 GPU 完成），毫秒。 */
  frameMs?: { mean: number; p95: number; min: number; max: number };
  /**
   * `profile` 帧里每个粒子层的开销（P4a 步骤 5）：模拟（`ParticleSystem.step`）、写顶点（`writeVertices`）、排队上传
   * （`writeBuffer`）各自的均值 / p95 / 最大值（毫秒），以及步进后的存活数。不传 `profile` 时没有。
   */
  particleMs?: ParticleProfile[];
  /** 读回那一帧的 `g_Time` 与 `g_Frametime`。 */
  time: number;
  frametime: number;
  /** 各粒子层读回时的数量：存活数（即画了几个）、高水位、容量，以及分布（位置范围、尺寸、alpha，`summarizeParticles`）。 */
  particles: ReturnType<GpuScene["particleStats"]>;
  /** PNG 的存放键是 `<key>.png`，原始 RGBA 是 `<key>.rgba`，都用 `chunk` 取（base64 分块）。 */
  key: string;
}

/** 编译并按固定时刻渲染一帧，读回离屏场景目标（不经过画布、不做 cover）。 */
export async function renderFrame(options: RenderFrameOptions): Promise<RenderFrameResult> {
  const started = performance.now();
  const reader = new FetchSceneReader();
  const cache = new TextureDecodeCache(reader);
  const force = options.force ?? true;
  const bundle = await compileSceneInWorker({
    projectDir: options.projectDir,
    sceneAssets: options.sceneAssets,
    userProperties: options.userProperties,
    postprocess: options.postprocess ?? "disabled",
    force,
    textureCache: cache,
    reader,
  });
  const compileMs = performance.now() - started;
  const gpu = await acquireGpu();
  try {
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, gpu.features, [], {
      ignoreUnsupported: force,
      particles: { seed: options.particles?.seed ?? 1, passes: options.particles?.passes ?? 1 },
    });
    try {
      const startTime = options.time ?? 0;
      let frameMs: RenderFrameResult["frameMs"];
      let particleMs: RenderFrameResult["particleMs"];
      if (options.profile) {
        // 只记 profile 帧：读回那一帧之前取走并关掉
        scene.profileParticles(true);
        const samples: number[] = [];
        for (let i = 0; i < options.profile; i++) {
          const t0 = performance.now();
          scene.sync(state);
          scene.update(
            {
              time: startTime + i / 60,
              frametime: 1 / 60,
              daytime: 0.5,
              pointer: [0.5, 0.5],
              pointerLast: [0.5, 0.5],
            },
            state,
          );
          const encoder = gpu.device.createCommandEncoder({ label: "probe profile" });
          scene.encode(encoder, state);
          gpu.device.queue.submit([encoder.finish()]);
          await gpu.device.queue.onSubmittedWorkDone();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        const round = (v: number) => Math.round(v * 100) / 100;
        frameMs = {
          mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
          p95: round(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]),
          min: round(samples[0]),
          max: round(samples.at(-1)!),
        };
        particleMs = scene.particleProfile();
        scene.profileParticles(false);
      }
      // 粒子回放：前 n−1 帧只步进，最后一帧随 update 步进
      const { time, frametime } = replayParticles(scene, state, options.particles, startTime);
      scene.sync(state);
      scene.update({ time, frametime, daytime: 0.5, pointer: [0.5, 0.5], pointerLast: [0.5, 0.5] }, state);
      const encoder = gpu.device.createCommandEncoder({ label: "probe frame" });
      scene.encode(encoder, state);
      const format = scene.targetTexture!.format as ReadbackFormat;
      const read = scheduleReadback(gpu.device, encoder, scene.targetTexture!, scene.width, scene.height, format);
      gpu.device.queue.submit([encoder.finish()]);
      const raw = await read();
      const rgba = raw instanceof Uint8Array ? raw : quantize8(raw);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const key = options.key ?? `frame-${Date.now()}`;
      storeProbeBytes(`${key}.png`, await encodePng(rgba, scene.width, scene.height));
      storeProbeBytes(`${key}.rgba`, rgba);
      const sums = [0, 0, 0];
      for (let i = 0; i < rgba.length; i += 4) {
        sums[0] += rgba[i];
        sums[1] += rgba[i + 1];
        sums[2] += rgba[i + 2];
      }
      const count = rgba.length / 4;
      return {
        width: scene.width,
        height: scene.height,
        format,
        unsupported: bundle.unsupported,
        postprocess: bundle.general.postprocess,
        sha256: await sha256(rgba),
        mean: [sums[0] / count, sums[1] / count, sums[2] / count],
        compileMs,
        targetBytes: scene.targetBytes,
        bloomLevels: scene.bloomChain ? scene.bloomChain.plan.levels : null,
        frameMs,
        particleMs,
        time,
        frametime,
        particles: scene.particleStats(true),
        key,
      };
    } finally {
      scene.destroy();
    }
  } finally {
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
    cache.clear();
    gpu.device.destroy();
  }
}

export function probeKeys(): string[] {
  return [...stored.keys()];
}

/** 宿主帧计时的统计（均值 / p95，最近 600 帧）。 */
function frameStats(costs: readonly number[]): { mean: number; p95: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!costs.length) return { mean: 0, p95: 0 };
  const sorted = [...costs].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { mean: round(mean), p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]) };
}

/** 单图层重建的次数与用时：当前场景的累计，整场重新加载后从 0 开始。 */
function rebuildSummary(stats: GpuScene["rebuildStats"] | undefined): { count: number; meanMs: number; maxMs: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!stats?.count) return { count: 0, meanMs: 0, maxMs: 0 };
  return { count: stats.count, meanMs: round(stats.totalMs / stats.count), maxMs: round(stats.maxMs) };
}

/** 当前 `SceneState` 的快照（图层、材质常量、泛光参数与开关、general 字段）与绑定表（P3a 点 8）。 */
export function hostState(host: SceneHost): unknown {
  const { bundle, renderer } = host.devScene;
  const state = renderer?.sceneState ?? null;
  return {
    bindings: bundle?.bindings ?? [],
    layers: state ? Object.fromEntries(state.layers) : {},
    constants: state ? Object.fromEntries(state.constants) : {},
    bloom: state?.bloom ?? null,
    bloomEnabled: state?.bloomEnabled ?? null,
    general: state?.general ?? null,
  };
}

/** 计数：就地应用次数、重编译记录（含原因）、单图层重建，以及 `render()` 的 CPU 用时统计。 */
export function hostStats(host: SceneHost): {
  applied: number;
  recompiled: { reason: string; keys: string[] }[];
  rebuilds: { count: number; meanMs: number; maxMs: number };
  frameMs: { mean: number; p95: number };
} {
  const renderer = host.devScene.renderer;
  return {
    applied: host.stats.applied,
    recompiled: host.stats.recompiled.map((item) => ({ ...item, keys: [...item.keys] })),
    rebuilds: rebuildSummary(renderer?.currentScene?.rebuildStats),
    frameMs: frameStats(renderer?.frameCosts ?? []),
  };
}

/**
 * 按固定 `g_Time` 渲染**当前**场景（含就地改过的状态）并读回、给 SHA-256：与 `renderFrame` 的整场重编译结果逐字节比较，
 * 是「就地 = 重编译」的真机判据（P3a 验收 4）。
 */
export async function hostRenderFrame(
  host: SceneHost,
  time: number,
): Promise<{ sha256: string; width: number; height: number }> {
  const renderer = host.devScene.renderer;
  const scene = renderer?.currentScene;
  const state = renderer?.sceneState;
  if (!renderer || !scene || !state) throw new Error("当前没有可渲染的场景");
  const device = renderer.device;
  const encoder = device.createCommandEncoder({ label: "probe host frame" });
  scene.sync(state);
  // 帧时间 0：粒子不步进，读回的是当前状态
  scene.update({ time, frametime: 0, daytime: 0.5, pointer: [0.5, 0.5], pointerLast: [0.5, 0.5] }, state);
  scene.encode(encoder, state);
  // 有两张目标时 `encode` 开头才换，这一帧画的那张要在它之后取
  const texture = scene.targetTexture!;
  const format = texture.format as ReadbackFormat;
  const read = scheduleReadback(device, encoder, texture, scene.width, scene.height, format);
  device.queue.submit([encoder.finish()]);
  const raw = await read();
  const rgba = raw instanceof Uint8Array ? raw : quantize8(raw);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { sha256: await sha256(rgba), width: scene.width, height: scene.height };
}

/**
 * 当前场景的粒子（P4a 步骤 5，真机量帧时间与统计量用）：`profile: true` 开始记录、`false` 停止并清空，不传时不改；
 * 返回各粒子层的数量与分布（`particleStats(true)`）、开销统计（`particleProfile`，打开记录之后的实时帧），以及当前的
 * `instanceoverride` 值。整场重新加载后记录随旧场景一起丢掉，要重新打开。
 */
export function hostParticles(
  host: SceneHost,
  options: { profile?: boolean } = {},
): {
  stats: ReturnType<GpuScene["particleStats"]>;
  profile: ParticleProfile[];
  instances: Record<number, unknown>;
} {
  const renderer = host.devScene.renderer;
  const scene = renderer?.currentScene;
  if (!scene) return { stats: [], profile: [], instances: {} };
  if (options.profile !== undefined) scene.profileParticles(options.profile);
  return {
    stats: scene.particleStats(true),
    profile: scene.particleProfile(),
    instances: Object.fromEntries(renderer?.sceneState?.particleInstances ?? []),
  };
}

export interface ParticleTrackProbeOptions {
  projectDir: string;
  sceneAssets: string[];
  /** 每帧的 `g_Frametime`，`dts[0]` 是第 1 帧（对齐 WPE 脚本帧号）。 */
  dts: number[];
  /** 要输出的帧号。 */
  frames: number[];
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍。 */
  passes: 1 | 2;
  seed?: number;
  tag?: string;
}

/**
 * 粒子轨迹（P4a 步骤 3）：按 `projectDir` 编译（不解码纹理，只要粒子层），再交给 `particles/track.ts` 逐帧步进。
 * 输出可直接存成 `ignore/p4/tracks/sim-<tag>.json` 给 `cmp_track.py` 比。
 */
export async function particleTrackProbe(options: ParticleTrackProbeOptions): Promise<ParticleTrack> {
  const bundle = await compileSceneInWorker({
    projectDir: options.projectDir,
    sceneAssets: options.sceneAssets,
    postprocess: "disabled",
    force: true,
  });
  try {
    return particleTrack({
      layers: bundle.layers,
      dts: options.dts,
      frames: options.frames,
      passes: options.passes,
      seed: options.seed,
      project: options.projectDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "",
      tag: options.tag,
    });
  } finally {
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
  }
}
