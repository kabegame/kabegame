/**
 * 场景渲染器的 dev 探针（只在 dev 构建安装，见 `install.ts`）。
 *
 * 挂在场景宿主 frame 的 `window.__kabegameSceneProbe`，经 CDP 在真 app 里调用：
 * - `renderFrame`：按指定 `g_Time` 渲染一帧场景、同步读回离屏场景目标，给出 SHA-256 与 PNG，用来做逐像素回归
 *   （例如关闭档前后两版渲染器的输出是否逐字节相同）；
 * - `bloom`：泛光链的链路隔离验证（`bloomProbe.ts`）；
 * - `chunk`：把存下的结果（PNG、原始数据）按 base64 分块交给 CDP 那一侧落盘。
 *
 * 读回一律在提交本帧的同一任务里排 `copyTextureToBuffer`，不经过画布（画布要在同一任务内同步取，否则是全透明空图）。
 */
import type { SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { acquireGpu } from "../render/device";
import { GpuScene } from "../render/scene";

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
  /** `g_Time`（秒）；`g_Daytime` 固定 0.5、指针在中心，保证可复现。 */
  time?: number;
  /** 结果的存放键；PNG 存 `<key>.png`。 */
  key?: string;
  /** 有不支持项也渲染（同 dev 强制渲染）。默认 true。 */
  force?: boolean;
  /** 先连续渲染这么多帧计时（每帧提交后等 GPU 完成，串行、不流水），再渲染读回的那一帧。 */
  profile?: number;
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
    const scene = await GpuScene.build(gpu.device, bundle, gpu.features, [], { ignoreUnsupported: force });
    try {
      const time = options.time ?? 0;
      let frameMs: RenderFrameResult["frameMs"];
      if (options.profile) {
        const samples: number[] = [];
        for (let i = 0; i < options.profile; i++) {
          const t0 = performance.now();
          scene.update({
            time: time + i / 60,
            frametime: 1 / 60,
            daytime: 0.5,
            pointer: [0.5, 0.5],
            pointerLast: [0.5, 0.5],
          });
          const encoder = gpu.device.createCommandEncoder({ label: "probe profile" });
          scene.encode(encoder);
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
      }
      scene.update({ time, frametime: 0, daytime: 0.5, pointer: [0.5, 0.5], pointerLast: [0.5, 0.5] });
      const encoder = gpu.device.createCommandEncoder({ label: "probe frame" });
      scene.encode(encoder);
      const format = scene.targetTexture!.format as ReadbackFormat;
      const read = scheduleReadback(gpu.device, encoder, scene.targetTexture!, scene.width, scene.height, format);
      gpu.device.queue.submit([encoder.finish()]);
      const raw = await read();
      const rgba = raw instanceof Uint8Array ? raw : quantize8(raw);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const key = options.key ?? `frame-${Date.now()}`;
      storeProbeBytes(`${key}.png`, await encodePng(rgba, scene.width, scene.height));
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
